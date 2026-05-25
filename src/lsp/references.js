// Find-references and target-identification logic shared by
// textDocument/references and textDocument/rename.
//
// Two phases:
//   1. identifyTarget(node, ctx)  -> { kind, decl, module, ...detail }
//        Decides what symbol the cursor is pointing to. Handles locals,
//        top-level decls (functions / types / enums / unions / traits /
//        kinds), fields, methods, and enum variants. Mirrors the
//        resolution paths in findDefinition.
//
//   2. findReferences(target, ctx) -> [{ absPath, pos, length }]
//        Walks every typechecked module's AST looking for occurrences
//        that bind to `target`. Three matching strategies in increasing
//        cost order:
//          (a) `node.resolvedDeclNode === target.decl` - direct back-
//              pointer match. Locals, params, and any IDENT the
//              typechecker resolved.
//          (b) CALL_EXPRESSION callee fields (calleeModuleId +
//              callee/calleeExportName) - top-level function refs.
//          (c) String-name scan over parser-internal type annotations.
//              Type annotations aren't AST nodes, so for type / kind
//              targets we walk every decl's annotation tree and emit a
//              synthetic ref whose location is found by scanning the
//              source near the enclosing decl.
//
// References include the declaration itself, matching the VSCode "find
// all references" UX where you can navigate from any occurrence to the
// canonical decl.

import { ASTNodeKind } from "../contracts.js";
import { typeKinds } from "../jsyooptypecheck/types.js";
import { findNodeAt } from "./nav.js";

const SKIP_FIELDS = new Set([
  "sourceLoc",
  "resolvedType",
  "resolvedDeclNode",
  "genericDecl",
  "genericInstantiation",
  "implementingType",
  "calleeMethodOf",
  "calleeTrait",
  "kindApplication",
  "resolvedKindApplication",
]);

// TargetKinds: identification labels. Use string constants so they're
// easy to log / debug.
export const TargetKind = Object.freeze({
  local: "local",        // LET / CONST / PARAM / DESTRUCTURE_DECL binding
  topLevel: "topLevel",  // FUNCTION_DECL / TYPE_DECL / ENUM_DECL / UNION_DECL / TRAIT_DECL / KIND_DECL
  field: "field",        // FIELD_DECL on a struct
  method: "method",      // METHOD_DECL on a trait impl
  variant: "variant",    // ENUM_VARIANT
});

// Identify the target symbol under the cursor based on the AST node hit
// + the cursor's identifier text. Returns null if the cursor isn't on
// anything we can resolve.
//
// `ctx`:
//   module, modById, moduleEnv, programState, tokenText
// (Same shape as findDefinition's ctx.)
export function identifyTarget(node, ctx) {
  const { module, modById, moduleEnv, programState, tokenText } = ctx;

  // Local IDENT with a typechecker-stamped back-pointer.
  if (
    node &&
    (node.kind === ASTNodeKind.IDENT || node.kind === ASTNodeKind.NAMESPACE_IDENT) &&
    node.resolvedDeclNode
  ) {
    return targetFromDecl(node.resolvedDeclNode, module, modById);
  }

  // Cursor on the decl itself.
  if (node && isDecl(node.kind)) {
    return targetFromDecl(node, module, modById);
  }

  // CALL_EXPRESSION whose callee is a string (top-level or imported function).
  if (node && node.kind === ASTNodeKind.CALL_EXPRESSION && typeof node.callee === "string") {
    if (node.calleeModuleId) {
      const targetMod = modById.get(node.calleeModuleId);
      if (targetMod) {
        const exported = node.calleeExportName ?? node.callee;
        const decl = findTopLevelByName(targetMod.ast, exported);
        if (decl) return targetFromDecl(decl, targetMod, modById);
      }
    }
    const localDecl = findTopLevelByName(module.ast, node.callee);
    if (localDecl) return targetFromDecl(localDecl, module, modById);
  }

  // Trait-qualified method call.
  if (
    node && node.kind === ASTNodeKind.CALL_EXPRESSION &&
    node.calleeMethodOf && node.calleeMethodName
  ) {
    const recv = node.calleeMethodOf;
    if (recv.kind === typeKinds.struct) {
      const declHit = resolveStructDecl(recv, module, modById, programState);
      if (declHit) {
        const m = (declHit.typeDecl.methods ?? []).find((mm) => mm.name === node.calleeMethodName);
        if (m) {
          return {
            kind: TargetKind.method,
            decl: m,
            module: declHit.targetMod,
            structName: recv.name,
            methodName: node.calleeMethodName,
          };
        }
      }
    }
  }

  // FIELD_ACCESS on a struct → field decl.
  if (node && node.kind === ASTNodeKind.FIELD_ACCESS) {
    const recvType = node.object?.resolvedType;
    if (recvType?.kind === typeKinds.struct) {
      const declHit = resolveStructDecl(recvType, module, modById, programState);
      if (declHit) {
        const field = (declHit.typeDecl.fields ?? []).find((f) => f.name === node.field);
        if (field) {
          return {
            kind: TargetKind.field,
            decl: field,
            module: declHit.targetMod,
            structDecl: declHit.typeDecl,
            fieldName: field.name,
          };
        }
      }
    }
  }

  // VARIANT_CONSTRUCTOR - jump to the enum variant decl.
  if (node && node.kind === ASTNodeKind.VARIANT_CONSTRUCTOR && node.variantName) {
    const enumType = node.resolvedEnumType;
    if (enumType?.kind === typeKinds.enum) {
      const targetMod = modById.get(enumType.moduleId) ?? module;
      const enumDecl = findTopLevelByName(targetMod.ast, enumType.name);
      const variant = (enumDecl?.variants ?? []).find((v) => v.name === node.variantName);
      if (variant) {
        return {
          kind: TargetKind.variant,
          decl: variant,
          module: targetMod,
          enumDecl,
          variantName: variant.name,
        };
      }
    }
  }

  // Final fallback: name-based lookup for type / kind names in annotations.
  if (tokenText) {
    const local = findTopLevelByName(module.ast, tokenText);
    if (local) return targetFromDecl(local, module, modById);
    if (moduleEnv) {
      const env = moduleEnv.get(module.id);
      const imp = env?.importedNames?.get(tokenText);
      if (imp?.fromModuleId) {
        const targetMod = modById.get(imp.fromModuleId);
        if (targetMod) {
          const exported = imp.exportName ?? tokenText;
          const decl = findTopLevelByName(targetMod.ast, exported);
          if (decl) return targetFromDecl(decl, targetMod, modById);
        }
      }
    }
  }

  return null;
}

// Build a Target descriptor from a decl AST node + its containing module.
function targetFromDecl(decl, module, _modById) {
  if (!decl) return null;
  switch (decl.kind) {
    case ASTNodeKind.LET_DECL:
    case ASTNodeKind.CONST_DECL:
    case ASTNodeKind.PARAM:
    case ASTNodeKind.DESTRUCTURE_DECL:
      return { kind: TargetKind.local, decl, module };
    case ASTNodeKind.FIELD_DECL: {
      // The field-match path needs to know which struct (or enum-variant
      // payload) the field belongs to. Walk every type/enum decl in the
      // module to find the parent.
      const parent = findFieldParent(module.ast, decl);
      return {
        kind: TargetKind.field,
        decl,
        module,
        fieldName: decl.name,
        structDecl: parent,
      };
    }
    case ASTNodeKind.METHOD_DECL: {
      const parent = findMethodParent(module.ast, decl);
      return {
        kind: TargetKind.method,
        decl,
        module,
        methodName: decl.name,
        structName: parent?.name,
        structDecl: parent,
      };
    }
    case ASTNodeKind.ENUM_VARIANT: {
      const enumDecl = findVariantParent(module.ast, decl);
      return {
        kind: TargetKind.variant,
        decl,
        module,
        variantName: decl.name,
        enumDecl,
      };
    }
    case ASTNodeKind.FUNCTION_DECL:
    case ASTNodeKind.TYPE_DECL:
    case ASTNodeKind.ENUM_DECL:
    case ASTNodeKind.UNION_DECL:
    case ASTNodeKind.TRAIT_DECL:
    case ASTNodeKind.KIND_DECL:
      return { kind: TargetKind.topLevel, decl, module };
    default:
      return null;
  }
}

// Walk top-level decls to find the TYPE_DECL (or enum variant) that
// owns this FIELD_DECL by reference equality.
function findFieldParent(ast, fieldDecl) {
  for (const decl of ast.body) {
    const inner = innerDecl(decl);
    if (!inner) continue;
    if ((inner.fields ?? []).includes(fieldDecl)) return inner;
    for (const variant of inner.variants ?? []) {
      if ((variant.fields ?? []).includes(fieldDecl)) return inner;
    }
  }
  return null;
}

function findMethodParent(ast, methodDecl) {
  for (const decl of ast.body) {
    const inner = innerDecl(decl);
    if (!inner) continue;
    if ((inner.methods ?? []).includes(methodDecl)) return inner;
  }
  return null;
}

function findVariantParent(ast, variantDecl) {
  for (const decl of ast.body) {
    const inner = innerDecl(decl);
    if (inner?.kind === ASTNodeKind.ENUM_DECL && (inner.variants ?? []).includes(variantDecl)) {
      return inner;
    }
  }
  return null;
}

// Walk every module's AST looking for references to `target`. Returns a
// flat list of { absPath, pos, length } locations including the decl
// itself.
//
// Strategy: for each module, scan the source text for word-boundary
// occurrences of the target's name, then validate each occurrence by
// finding the AST node at that offset and checking that it resolves to
// our target. This sidesteps the parser's flaky `sourceLoc.pos` (which
// often lands one or two tokens past the identifier and collapses
// distinct refs onto the same anchor under a closest-match heuristic).
//
// Validation per occurrence:
//   (a) IDENT.resolvedDeclNode === target.decl  → local/param/IDENT ref
//   (b) CALL_EXPRESSION whose callee/calleeModuleId routes to target
//   (c) FIELD_ACCESS on a struct matching target.structDecl + field name
//   (d) METHOD_DECL call matching target's struct + method
//   (e) VARIANT_CONSTRUCTOR matching target's enum + variant
//   (f) For type/kind targets: any occurrence whose textual context is a
//       type-annotation parser tree referencing the same name - we
//       conservatively count the occurrence if no AST node refutes it.
export function findReferences(target, ctx) {
  if (!target) return [];
  const name = nameOfTarget(target);
  if (!name) return [];

  const out = [];
  const seen = new Set();
  const push = (absPath, pos, length) => {
    if (pos == null || pos < 0) return;
    const key = `${absPath}:${pos}:${length}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ absPath, pos, length });
  };

  for (const mod of ctx.modules) {
    scanModuleForRefs(mod, target, name, push);
  }

  // Always include the decl's own span in case the source scan missed
  // it (e.g. when target is a method whose name is a substring of a
  // shadowed identifier). De-duped by `seen` so it's free if already
  // present.
  const declRef = locOfDeclName(target.decl, target.module);
  if (declRef) push(declRef.absPath, declRef.pos, declRef.length);

  return out;
}

function nameOfTarget(target) {
  switch (target.kind) {
    case TargetKind.field: return target.fieldName ?? target.decl?.name;
    case TargetKind.method: return target.methodName ?? target.decl?.name;
    case TargetKind.variant: return target.variantName ?? target.decl?.name;
    default: return target.decl?.name;
  }
}

// Walk every word-boundary occurrence of `name` in `mod.src`, validate
// each via the AST, and push matching ones. Skips occurrences inside
// `//` line comments and `/* */` block comments - these are textual
// mentions, not references.
function scanModuleForRefs(mod, target, name, push) {
  if (!mod.src) return;
  const src = mod.src;
  const isInComment = buildCommentChecker(src);
  let i = 0;
  while (i <= src.length - name.length) {
    const found = src.indexOf(name, i);
    if (found < 0) break;
    i = found + 1;
    if (!isWordBoundaryMatch(src, found, name.length)) continue;
    if (isInComment(found)) continue;
    if (occurrenceMatches(mod, target, name, found)) {
      push(mod.absPath, found, name.length);
    }
  }
}

// Pre-scan `src` for "not code" ranges and return a fast
// `(offset) => bool` predicate. Skipped ranges:
//   - `//` line comments and `/* */` block comments (nestable per lexer)
//   - `"..."` and `'...'` string literals (whole content + delimiters)
//   - template-literal *string portions* (text inside backticks, but
//     NOT the code inside `${...}` interpolations - those are real
//     expressions and references inside them must be honored)
//
// Mirrors the lexer's tokenizer in jsyooplexer/. Keeping this in sync
// with the language's lex rules is what saves us from false-positive
// references like the literal text "len=" inside `\`len=${arr.len}\``.
function buildCommentChecker(src) {
  const ranges = []; // [start, end) pairs in source order
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 0x2f && i + 1 < n) { // '/'
      const next = src.charCodeAt(i + 1);
      if (next === 0x2f) { // '//' line comment
        const eol = src.indexOf("\n", i);
        const end = eol < 0 ? n : eol;
        ranges.push([i, end]);
        i = end;
        continue;
      }
      if (next === 0x2a) { // '/*' nestable block comment
        let depth = 1;
        let j = i + 2;
        while (j < n - 1 && depth > 0) {
          if (src.charCodeAt(j) === 0x2f && src.charCodeAt(j + 1) === 0x2a) {
            depth++; j += 2;
          } else if (src.charCodeAt(j) === 0x2a && src.charCodeAt(j + 1) === 0x2f) {
            depth--; j += 2;
          } else {
            j++;
          }
        }
        ranges.push([i, j]);
        i = j;
        continue;
      }
    }
    if (c === 0x22 || c === 0x27) { // '"' or '\''
      const quote = c;
      let j = i + 1;
      while (j < n) {
        const cc = src.charCodeAt(j);
        if (cc === 0x5c) { j += 2; continue; } // '\' - skip next
        if (cc === quote) { j++; break; }
        if (cc === 0x0a) break; // unterminated, bail out
        j++;
      }
      ranges.push([i, j]);
      i = j;
      continue;
    }
    if (c === 0x60) { // '`' template literal
      let j = i + 1;
      let textStart = j;
      while (j < n) {
        const cc = src.charCodeAt(j);
        if (cc === 0x5c && j + 1 < n) { j += 2; continue; }
        if (cc === 0x60) {
          // Close backtick. Mark text from textStart to j+1 (include
          // closing backtick) as "not code".
          if (textStart < j + 1) ranges.push([textStart, j + 1]);
          j++;
          break;
        }
        if (cc === 0x24 && j + 1 < n && src.charCodeAt(j + 1) === 0x7b) {
          // `${` opens an interpolation - the preceding text portion is
          // not code; mark it. Then walk to matching `}` and resume
          // text-mode after it.
          if (textStart < j) ranges.push([textStart, j]);
          // Also mark the literal `${` and `}` delimiters as not code.
          ranges.push([j, j + 2]);
          let depth = 1;
          let k = j + 2;
          while (k < n && depth > 0) {
            const kk = src.charCodeAt(k);
            if (kk === 0x7b) depth++;
            else if (kk === 0x7d) depth--;
            if (depth === 0) break;
            k++;
          }
          // k now points at the closing '}' (or EOF). Mark it.
          if (k < n) ranges.push([k, k + 1]);
          // Mark the opening backtick + any leading text we haven't
          // already covered.
          if (textStart === i + 1 && textStart < j) {
            // already pushed above
          }
          j = k + 1;
          textStart = j;
          continue;
        }
        j++;
      }
      // Mark the opening backtick itself for completeness.
      ranges.push([i, i + 1]);
      i = j;
      continue;
    }
    i++;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return (offset) => {
    let lo = 0, hi = ranges.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const [s, e] = ranges[mid];
      if (offset < s) hi = mid;
      else if (offset >= e) lo = mid + 1;
      else return true;
    }
    return false;
  };
}

// Decide whether the occurrence at `offset` refers to `target`.
function occurrenceMatches(mod, target, name, offset) {
  const node = findNodeAt(mod.ast, offset, mod.src);

  // Decl itself: cursor on target.decl.name in target.module.
  if (mod === target.module && node === target.decl) return true;

  // (a) IDENT back-pointer.
  if (
    node &&
    (node.kind === ASTNodeKind.IDENT || node.kind === ASTNodeKind.NAMESPACE_IDENT) &&
    node.resolvedDeclNode === target.decl
  ) {
    return true;
  }

  // (b) CALL_EXPRESSION → top-level function decl.
  if (
    target.kind === TargetKind.topLevel &&
    target.decl.kind === ASTNodeKind.FUNCTION_DECL &&
    node?.kind === ASTNodeKind.CALL_EXPRESSION &&
    typeof node.callee === "string" &&
    (node.callee === name || node.calleeExportName === name) &&
    routesToTopLevelFn(node, target)
  ) {
    return true;
  }

  // (c) FIELD_ACCESS on the right struct.
  if (
    target.kind === TargetKind.field &&
    node?.kind === ASTNodeKind.FIELD_ACCESS &&
    node.field === name
  ) {
    const recvType = node.object?.resolvedType;
    return fieldRecvMatches(recvType, target);
  }

  // (d) Method call on the right struct.
  if (
    target.kind === TargetKind.method &&
    node?.kind === ASTNodeKind.CALL_EXPRESSION &&
    node.calleeMethodName === name &&
    node.calleeMethodOf?.kind === typeKinds.struct
  ) {
    return (
      node.calleeMethodOf.name === target.structName ||
      node.calleeMethodOf.name?.startsWith(target.structName + "__")
    );
  }

  // (e) Variant constructor.
  if (
    target.kind === TargetKind.variant &&
    node?.kind === ASTNodeKind.VARIANT_CONSTRUCTOR &&
    node.variantName === name &&
    node.resolvedEnumType?.name === target.enumDecl?.name
  ) {
    return true;
  }

  // (f) Type / kind reference inside an annotation. Type annotations
  // aren't AST nodes, so findNodeAt returns either null or the enclosing
  // decl. Conservatively accept the occurrence as a reference when:
  //   - the target is a type/kind decl with this name
  //   - there's no closer AST node binding (no IDENT with a different
  //     resolvedDeclNode, no LET/PARAM with this name as its own decl)
  if (
    target.kind === TargetKind.topLevel &&
    isTypeOrKindDecl(target.decl.kind)
  ) {
    if (node?.kind === ASTNodeKind.IDENT && node.name === name) {
      // An IDENT with this name that resolves elsewhere is a *value*
      // reference, not a type reference. Skip.
      return node.resolvedDeclNode === target.decl;
    }
    if (
      node && isDecl(node.kind) && node.name === name &&
      node !== target.decl
    ) {
      // Some other decl with the same name shadows here. Skip.
      return false;
    }
    return true;
  }

  return false;
}

function fieldRecvMatches(recvType, target) {
  if (!recvType || recvType.kind !== typeKinds.struct) return false;
  const targetStructName = target.structDecl?.name;
  if (!targetStructName) return false;
  // Concrete struct match.
  if (recvType.name === targetStructName) return true;
  // Monomorphized generic - recvType.name carries the mangled name
  // like `DynArray__int32` while target.structDecl.name is `DynArray`.
  if (recvType.genericInstance) {
    return recvType.name === targetStructName ||
      recvType.name?.startsWith(targetStructName + "__");
  }
  return false;
}

// For top-level FUNCTION_DECL references, check that the call expression
// resolves to the same target across modules.
function routesToTopLevelFn(callNode, target) {
  if (callNode.calleeModuleId) {
    return callNode.calleeModuleId === target.module.id;
  }
  // Same-module call (no module routing): target.decl must be a top-
  // level decl in this caller's module.
  return target.module.ast.body.some((d) => isOrWrapsDecl(d, target.decl));
}

function isOrWrapsDecl(top, decl) {
  if (top === decl) return true;
  if (top.kind === ASTNodeKind.EXPORT_DECL && top.decl === decl) return true;
  if (top.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL && top.fn === decl) return true;
  return false;
}

function innerDecl(decl) {
  return decl.kind === ASTNodeKind.EXPORT_DECL
    ? decl.decl
    : decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL
    ? decl.fn
    : decl;
}

// Resolve a (possibly monomorphized) struct type to its declaring AST
// node. Same logic as the helper inside nav.js - duplicated here to keep
// these modules independent.
function resolveStructDecl(structType, module, modById, programState) {
  if (!structType) return null;
  const inst = structType.genericInstance;
  if (inst && programState?.registry?.genericDeclById) {
    const genericDecl = programState.registry.genericDeclById.get(inst.declId);
    if (genericDecl?.ast) {
      const targetMod = modById.get(genericDecl.moduleId) ?? module;
      return { typeDecl: genericDecl.ast, targetMod };
    }
  }
  const targetMod = modById.get(structType.moduleId) ?? module;
  const typeDecl = findTopLevelByName(targetMod.ast, structType.name);
  if (typeDecl) return { typeDecl, targetMod };
  return null;
}

function findTopLevelByName(ast, name) {
  for (const decl of ast.body) {
    const inner = innerDecl(decl);
    if (inner && inner.name === name) return inner;
  }
  return null;
}

function isDecl(kind) {
  return (
    kind === ASTNodeKind.LET_DECL ||
    kind === ASTNodeKind.CONST_DECL ||
    kind === ASTNodeKind.PARAM ||
    kind === ASTNodeKind.FUNCTION_DECL ||
    kind === ASTNodeKind.TYPE_DECL ||
    kind === ASTNodeKind.ENUM_DECL ||
    kind === ASTNodeKind.UNION_DECL ||
    kind === ASTNodeKind.TRAIT_DECL ||
    kind === ASTNodeKind.KIND_DECL ||
    kind === ASTNodeKind.FIELD_DECL ||
    kind === ASTNodeKind.METHOD_DECL ||
    kind === ASTNodeKind.ENUM_VARIANT
  );
}

function isTypeOrKindDecl(kind) {
  return (
    kind === ASTNodeKind.TYPE_DECL ||
    kind === ASTNodeKind.ENUM_DECL ||
    kind === ASTNodeKind.UNION_DECL ||
    kind === ASTNodeKind.TRAIT_DECL ||
    kind === ASTNodeKind.KIND_DECL
  );
}

// Return { absPath, pos, length } for the *name span* of a decl. Same
// shape as nav.locOfDecl but inlined here to avoid coupling the two
// modules.
function locOfDeclName(decl, module) {
  if (!decl || !module) return null;
  const loc = decl.sourceLoc;
  if (!loc) return null;
  const name = decl.name;
  if (name && module.src) {
    const span = findNameInSource(module.src, loc.pos ?? 0, name);
    if (span) return { absPath: module.absPath, pos: span.pos, length: name.length };
  }
  return { absPath: module.absPath, pos: loc.pos ?? 0, length: name?.length ?? 1 };
}

// Locate the closest word-boundary occurrence of `name` to `anchor`.
// Returns { pos } or null.
function findNameInSource(src, anchor, name) {
  if (!src || !name) return null;
  const WIN = 200;
  const winStart = Math.max(0, anchor - WIN);
  const winEnd = Math.min(src.length, anchor + WIN);
  let best = -1;
  let bestDist = Infinity;
  let i = winStart;
  while (i <= winEnd - name.length) {
    const found = src.indexOf(name, i);
    if (found < 0 || found > winEnd - name.length) break;
    if (isWordBoundaryMatch(src, found, name.length)) {
      const d = Math.abs(found - anchor);
      if (d < bestDist) { best = found; bestDist = d; }
    }
    i = found + 1;
  }
  return best >= 0 ? { pos: best } : null;
}

function isWordBoundaryMatch(src, start, len) {
  const before = start === 0 ? 0 : src.charCodeAt(start - 1);
  const after = start + len < src.length ? src.charCodeAt(start + len) : 0;
  return !isIdentCode(before) && !isIdentCode(after);
}

function isIdentCode(code) {
  if (!code) return false;
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}
