// Navigation helpers shared by hover / definition / documentSymbol /
// semanticTokens. Consumes the output of analyze() (a list of typechecked
// modules) and answers position-based queries against the AST.
//
// Single source-of-truth conventions used throughout this file:
// - "offset" is a flat 0-indexed character offset into the module's `src`.
// - LSP "position" is { line, character } 0-indexed.
// - Yooperlang sourceLoc.line / column are 1-indexed.

import { ASTNodeKind } from "../contracts.js";
import { formatType } from "../jsyooptypecheck/errors.js";
import { typeKinds } from "../jsyooptypecheck/types.js";

// Back-pointer / non-tree fields that the AST walker must NOT recurse into.
// Several of these (genericDecl, genericInstantiation, implementingType)
// turn the AST into a cyclic graph because the typechecker stores back-refs
// to AST decls; following them causes RangeError: Maximum call stack
// exceeded. Kept in sync with codegen.js's CLONE_SKIP_FIELDS.
const NAV_SKIP_FIELDS = new Set([
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

// Convert an LSP { line, character } (both 0-indexed) into a flat offset
// into `src`. Newlines after the end of file or characters past the end of
// a line are clamped to the closest valid offset.
export function posToOffset(src, line, character) {
  let off = 0;
  let curLine = 0;
  for (let i = 0; i < src.length && curLine < line; i++) {
    if (src.charCodeAt(i) === 0x0a) {
      curLine++;
      off = i + 1;
    }
  }
  // Walk `character` UTF-16 code units forward, stopping at next newline.
  let result = off;
  for (let i = 0; i < character && result < src.length; i++) {
    if (src.charCodeAt(result) === 0x0a) break;
    result++;
  }
  return result;
}

// Convert a flat offset back to an LSP range covering `length` chars.
// Mirrors server.js posToRange but lives here so nav.js consumers don't
// reach back into the server.
export function offsetToRange(src, offset, length = 1) {
  const start = offsetToPos(src, offset);
  const end = offsetToPos(src, Math.min(src.length, offset + Math.max(1, length)));
  return { start, end };
}

export function offsetToPos(src, offset) {
  let line = 0;
  let lineStart = 0;
  const cap = Math.min(offset, src.length);
  for (let i = 0; i < cap; i++) {
    if (src.charCodeAt(i) === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: cap - lineStart };
}

// Find the AST node at `offset` in source `src`.
//
// Background: the parser's `sourceLoc.pos` doesn't reliably point at the
// start of the underlying token — it captures the parser's position state
// at node-construction time, which often lands one or two tokens past the
// identifier the node represents. The `line` is reliably the line where
// the construction happened (close enough to the identifier).
//
// Strategy: at the cursor, identify the identifier token in `src` itself.
// Then walk the AST looking for nodes that (a) carry that same name, (b)
// are on the same source line, and (c) have a sourceLoc as close to the
// cursor as possible. For non-identifier cursors (operators, punctuation)
// we fall back to a sourceLoc proximity search by line.
//
// `ancestry` (optional, mutated): receives the path of ancestor nodes
// from outermost-in. Useful when handlers need enclosing-decl context.
export function findNodeAt(ast, offset, src, ancestry = null) {
  if (!src) return null;
  // Reject cursors past EOF entirely — no node lives there.
  if (offset < 0 || offset > src.length) return null;
  const cursorPos = offsetToPos(src, offset);
  const cursorLine1 = cursorPos.line + 1; // sourceLoc.line is 1-indexed
  const tok = identTokenAt(src, offset);
  // No identifier under the cursor → no useful answer for hover / def. The
  // caller falls back to whatever sensible default it wants.
  if (!tok) return null;

  let best = null;
  let bestScore = Infinity;
  let bestPath = null;

  function score(node) {
    const loc = node.sourceLoc;
    if (!loc) return Infinity;
    // Strongly prefer matches on the same line. Allow ±1 line of slack to
    // tolerate the parser's "sourceLoc points one token past the name"
    // quirk (which occasionally crosses a newline).
    const lineDelta = Math.abs((loc.line ?? 0) - cursorLine1);
    if (lineDelta > 1) return Infinity;
    const posDelta = Math.abs((loc.pos ?? 0) - offset);
    return lineDelta * 10000 + posDelta;
  }

  function consider(node, path) {
    const s = score(node);
    if (s < bestScore) {
      best = node;
      bestScore = s;
      bestPath = path.slice();
    }
  }

  // `visited` (WeakSet) defensively breaks any cycle. The typechecker
  // stamps several back-pointers (genericDecl, genericInstantiation,
  // implementingType, …) that turn the AST into a graph. SKIP_FIELDS
  // covers the named cases; the WeakSet catches anything we missed.
  const visited = new WeakSet();
  function visit(node, path) {
    if (!node || typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (const c of node) visit(c, path);
      return;
    }
    if (node instanceof Map || node instanceof Set) return;
    if (!node.kind) {
      // Container without a kind — descend so we still reach AST nodes
      // inside (programs, blocks may not be reached via this branch but
      // we keep it general).
      for (const key of Object.keys(node)) {
        if (NAV_SKIP_FIELDS.has(key)) continue;
        const v = node[key];
        if (v && typeof v === "object") visit(v, path);
      }
      return;
    }
    // Match by identifier name — direct (PARAM/IDENT/LET/...) or via the
    // string-valued callee field on CALL_EXPRESSION.
    if (node.sourceLoc) {
      if (node.name === tok.text) consider(node, path);
      else if (node.kind === "CALL_EXPRESSION" && node.callee === tok.text) consider(node, path);
      else if (node.kind === "FIELD_ACCESS" && node.field === tok.text) consider(node, path);
    }
    const childPath = path.concat([node]);
    for (const key of Object.keys(node)) {
      if (NAV_SKIP_FIELDS.has(key)) continue;
      const v = node[key];
      if (v && typeof v === "object") visit(v, childPath);
    }
  }

  visit(ast, []);
  if (ancestry && bestPath) for (const a of bestPath) ancestry.push(a);
  return best;
}

// Scan `src` around `offset` for an identifier-shaped token (matches
// /[A-Za-z_][A-Za-z0-9_]*/). Returns { start, end, text } or null if the
// cursor isn't inside / adjacent to one. The cursor-at-end-of-identifier
// case (common when typing) is accepted: we walk back if `src[offset]`
// is not an identifier char but `src[offset-1]` is.
export function identTokenAt(src, offset) {
  if (offset < 0 || offset > src.length) return null;
  let start = offset;
  let end = offset;
  if (offset < src.length && isIdentChar(src.charCodeAt(offset))) {
    while (end < src.length && isIdentChar(src.charCodeAt(end))) end++;
  } else if (offset > 0 && isIdentChar(src.charCodeAt(offset - 1))) {
    // Cursor sits just after the identifier (typical for caret-after-typing).
    end = offset;
  } else {
    return null;
  }
  while (start > 0 && isIdentChar(src.charCodeAt(start - 1))) start--;
  if (start === end) return null;
  const text = src.slice(start, end);
  // First char must be a letter or underscore (not a digit).
  if (!isIdentStart(text.charCodeAt(0))) return null;
  return { start, end, text };
}

function isIdentChar(code) {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}
function isIdentStart(code) {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}

// Human-readable hover text for a node. Returns null when there's nothing
// useful to show (e.g. punctuation token, keyword, decl with no resolved
// type). The result is plain text — the server wraps it in a markdown
// fence for display.
export function getHoverInfo(node, module) {
  if (!node) return null;
  switch (node.kind) {
    case ASTNodeKind.IDENT:
    case ASTNodeKind.NAMESPACE_IDENT: {
      const t = node.resolvedType;
      if (!t) return null;
      const decl = node.resolvedDeclNode;
      const declKind = declKindLabel(decl);
      const name = node.name;
      return declKind
        ? `(${declKind}) ${name}: ${formatType(t)}`
        : `${name}: ${formatType(t)}`;
    }
    case ASTNodeKind.FIELD_ACCESS: {
      const t = node.resolvedType;
      if (!t) return null;
      return `.${node.field}: ${formatType(t)}`;
    }
    case ASTNodeKind.CALL_EXPRESSION: {
      const t = node.resolvedType;
      const callee = typeof node.callee === "string" ? node.callee : "<call>";
      if (t) return `${callee}(...): ${formatType(t)}`;
      return null;
    }
    case ASTNodeKind.LET_DECL:
    case ASTNodeKind.CONST_DECL: {
      const kw = node.kind === ASTNodeKind.LET_DECL ? "let" : "const";
      if (!node.resolvedType) return null;
      return `${kw} ${node.name}: ${formatType(node.resolvedType)}`;
    }
    case ASTNodeKind.PARAM: {
      if (!node.resolvedType) return null;
      const ref = node.isRef ? "ref " : "";
      return `(parameter) ${ref}${node.name}: ${formatType(node.resolvedType)}`;
    }
    case ASTNodeKind.FUNCTION_DECL: {
      if (!node.resolvedType) return null;
      const params = (node.params ?? [])
        .map((p) => `${p.isRef ? "ref " : ""}${p.name}: ${formatType(p.resolvedType)}`)
        .join(", ");
      return `function ${node.name}(${params}): ${formatType(node.resolvedType)}`;
    }
    case ASTNodeKind.TYPE_DECL: {
      return `type ${node.name}`;
    }
    case ASTNodeKind.ENUM_DECL: {
      return `enum ${node.name}`;
    }
    case ASTNodeKind.UNION_DECL: {
      return `union ${node.name}`;
    }
    case ASTNodeKind.TRAIT_DECL: {
      return `trait ${node.name}`;
    }
    case ASTNodeKind.FIELD_DECL: {
      if (!node.resolvedType) return null;
      return `${node.name}: ${formatType(node.resolvedType)}`;
    }
    default:
      return null;
  }
}

// Resolve the node at `offset` to a definition site. Returns
// { absPath, pos, length } or null when the resolver doesn't know where
// the symbol is defined. Handles:
//   - IDENT  -> declaring LET/CONST/PARAM/FUNCTION_DECL via the
//     resolvedDeclNode back-pointer the typechecker stamps.
//   - CALL_EXPRESSION(string callee) -> top-level function decl in the
//     same module (cross-module calls follow calleeModuleId).
//   - FIELD_ACCESS on a struct -> the struct's FIELD_DECL.
//   - Trait-qualified method call -> the method decl on the impl.
//   - Type / kind identifier under the cursor with no AST hit -> the
//     struct/enum/union/trait/kind decl looked up by name in the
//     module's tables (or via importedNames for cross-module refs).
//
// `ctx`:
//   module, modById  — required, supply the analysis context
//   tokenText        — optional; the identifier under the cursor. Used
//                      as a fallback when the AST node hit doesn't
//                      yield a definition (e.g. type annotations are
//                      parser objects, not AST nodes, so the cursor
//                      may land on a TEMPLATE_LITERAL parent or null).
//   moduleEnv        — optional; Map<moduleId, env> from analyze().
//                      Enables type / kind table lookups.
export function findDefinition(node, ctx) {
  const { module, modById, tokenText, moduleEnv } = ctx;
  if (!node) {
    return tokenText ? findByName(tokenText, module, modById, moduleEnv) : null;
  }

  // IDENT: typechecker stamped a direct back-pointer for local bindings.
  if (
    (node.kind === ASTNodeKind.IDENT || node.kind === ASTNodeKind.NAMESPACE_IDENT) &&
    node.resolvedDeclNode
  ) {
    return locOfDecl(node.resolvedDeclNode, module);
  }

  // IDENT referring to a top-level symbol that didn't get a resolvedDeclNode
  // (e.g. a namespace import or a function name appearing as a value).
  // Fall back to a top-level decl lookup by name.
  if (node.kind === ASTNodeKind.IDENT || node.kind === ASTNodeKind.NAMESPACE_IDENT) {
    const decl = findTopLevelByName(module.ast, node.name);
    if (decl) return locOfDecl(decl, module);
  }

  // CALL_EXPRESSION with a string callee: cross-module via calleeModuleId,
  // otherwise look up in this module's top-level decls.
  if (node.kind === ASTNodeKind.CALL_EXPRESSION && typeof node.callee === "string") {
    if (node.calleeModuleId) {
      const targetMod = modById.get(node.calleeModuleId);
      if (targetMod) {
        const exported = node.calleeExportName ?? node.callee;
        const decl = findTopLevelByName(targetMod.ast, exported);
        if (decl) return locOfDecl(decl, targetMod);
      }
    }
    const decl = findTopLevelByName(module.ast, node.callee);
    if (decl) return locOfDecl(decl, module);
  }

  // CALL_EXPRESSION on a trait method: jump to the method decl on the
  // implementing struct.
  if (
    node.kind === ASTNodeKind.CALL_EXPRESSION &&
    node.calleeMethodOf &&
    node.calleeMethodName
  ) {
    const recv = node.calleeMethodOf;
    if (recv.kind === typeKinds.struct) {
      const targetMod = modById.get(recv.moduleId) ?? module;
      const typeDecl = findTopLevelByName(targetMod.ast, recv.name);
      if (typeDecl?.methods?.length) {
        const m = typeDecl.methods.find((mm) => mm.name === node.calleeMethodName);
        if (m) return locOfDecl(m, targetMod);
      }
    }
  }

  // FIELD_ACCESS on a struct receiver: jump to the field declaration.
  if (node.kind === ASTNodeKind.FIELD_ACCESS) {
    const recvType = node.object?.resolvedType;
    if (recvType?.kind === typeKinds.struct) {
      const lookup = resolveStructDecl(recvType, module, modById, ctx.programState);
      if (lookup) {
        const { typeDecl, targetMod } = lookup;
        const field = (typeDecl.fields ?? []).find((f) => f.name === node.field);
        if (field) return locOfDecl(field, targetMod);
        return locOfDecl(typeDecl, targetMod);
      }
    }
  }

  // Cursor on a decl's own name (LET_DECL, CONST_DECL, PARAM, FUNCTION_DECL,
  // TYPE_DECL, etc.). The decl is its own definition site — return its
  // location so jump-to-def is a no-op rather than dead.
  if (node.name && node.sourceLoc) {
    const declSelf = locOfDecl(node, module);
    if (declSelf) return declSelf;
  }

  // Final fallback: the cursor identifier may be a type or kind name in
  // a type annotation (annotations aren't AST nodes — they're parser
  // objects without sourceLoc, so the AST hit landed on the enclosing
  // decl rather than the annotation itself). Look it up by name in the
  // module's type/kind tables.
  if (tokenText) {
    const byName = findByName(tokenText, module, modById, moduleEnv);
    if (byName) return byName;
  }

  return null;
}

// Hover fallback: render a one-line description for a name that has no
// AST node hit (type annotations, kind refs). Looks the name up in the
// current module's AST first, then follows imports via moduleEnv.
export function hoverFromName(name, module, analysis) {
  if (!name || !module) return null;
  const localDecl = findTopLevelByName(module.ast, name);
  if (localDecl) return summarizeDecl(localDecl);
  const env = analysis?.moduleEnv?.get(module.id);
  const imp = env?.importedNames?.get(name);
  if (imp?.fromModuleId) {
    const targetMod = analysis.modById.get(imp.fromModuleId);
    if (targetMod) {
      const exported = imp.exportName ?? name;
      const decl = findTopLevelByName(targetMod.ast, exported);
      if (decl) return summarizeDecl(decl);
    }
  }
  return null;
}

function summarizeDecl(decl) {
  switch (decl.kind) {
    case ASTNodeKind.TYPE_DECL: {
      const tps = (decl.typeParams ?? []).map((p) => p.name).join(", ");
      const head = tps ? `type ${decl.name}<${tps}>` : `type ${decl.name}`;
      const traits = decl.implementsTraits?.length
        ? ` implements ${decl.implementsTraits.join(", ")}`
        : "";
      return head + traits;
    }
    case ASTNodeKind.ENUM_DECL:
      return `enum ${decl.name}`;
    case ASTNodeKind.UNION_DECL:
      return `union ${decl.name}`;
    case ASTNodeKind.TRAIT_DECL:
      return `trait ${decl.name}`;
    case ASTNodeKind.KIND_DECL:
      return `kind ${decl.name}`;
    case ASTNodeKind.FUNCTION_DECL: {
      const tps = (decl.typeParams ?? []).map((p) => p.name).join(", ");
      const head = tps ? `function ${decl.name}<${tps}>` : `function ${decl.name}`;
      const params = (decl.params ?? [])
        .map((p) => `${p.isRef ? "ref " : ""}${p.name}`)
        .join(", ");
      return `${head}(${params})`;
    }
    default:
      return decl.name ? `${declKindLabel(decl) ?? decl.kind} ${decl.name}` : null;
  }
}

// Look up a type or kind name in the module's tables and follow imports
// across modules. Returns a definition location or null. Used as a
// fallback when there's no AST node carrying the name (type annotations,
// kind references inside KIND_REQUIRES_CLAUSE, etc.).
function findByName(name, module, modById, moduleEnv) {
  if (!name || !module) return null;
  // First, prefer the same-module AST since walking AST decls is cheap
  // and always available even when moduleEnv is null.
  const local = findTopLevelByName(module.ast, name);
  if (local) return locOfDecl(local, module);
  // Cross-module: check importedNames for this module via moduleEnv.
  if (moduleEnv) {
    const env = moduleEnv.get(module.id);
    const imp = env?.importedNames?.get(name);
    if (imp?.fromModuleId) {
      const targetMod = modById.get(imp.fromModuleId);
      if (targetMod) {
        const exported = imp.exportName ?? name;
        const decl = findTopLevelByName(targetMod.ast, exported);
        if (decl) return locOfDecl(decl, targetMod);
      }
    }
  }
  return null;
}

// Document symbol tree for the outline view. Returns an array of
// DocumentSymbol objects (LSP shape: { name, kind, range, selectionRange,
// children? }). Ranges are computed against `src` via offsetToRange.
export function collectDocumentSymbols(ast, src) {
  const out = [];
  for (const decl of ast.body) {
    const sym = symbolFor(decl, src);
    if (sym) out.push(sym);
  }
  return out;
}

// LSP SymbolKind constants we actually use. The full enum is in the LSP
// spec — we only emit the kinds Yooperlang has.
const SymbolKind = {
  Function: 12,
  Method: 6,
  Struct: 23,
  Enum: 10,
  EnumMember: 22,
  Interface: 11, // used for trait
  Field: 8,
  Variable: 13,
  Constant: 14,
  Constructor: 9,
  Namespace: 3,
};

function symbolFor(decl, src) {
  const inner = decl.kind === ASTNodeKind.EXPORT_DECL
    ? decl.decl
    : decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL
    ? decl.fn
    : decl;
  if (!inner || !inner.sourceLoc) return null;
  const range = offsetToRange(src, inner.sourceLoc.pos, inner.sourceLoc.length);
  const selRange = range;
  switch (inner.kind) {
    case ASTNodeKind.FUNCTION_DECL: {
      return {
        name: inner.name,
        kind: SymbolKind.Function,
        range,
        selectionRange: selRange,
      };
    }
    case ASTNodeKind.TYPE_DECL: {
      const children = [];
      for (const f of inner.fields ?? []) {
        if (!f.sourceLoc) continue;
        const r = offsetToRange(src, f.sourceLoc.pos, f.sourceLoc.length);
        children.push({ name: f.name, kind: SymbolKind.Field, range: r, selectionRange: r });
      }
      for (const m of inner.methods ?? []) {
        if (!m.sourceLoc) continue;
        const r = offsetToRange(src, m.sourceLoc.pos, m.sourceLoc.length);
        children.push({ name: m.name, kind: SymbolKind.Method, range: r, selectionRange: r });
      }
      return {
        name: inner.name,
        kind: SymbolKind.Struct,
        range,
        selectionRange: selRange,
        children,
      };
    }
    case ASTNodeKind.ENUM_DECL: {
      const children = [];
      for (const v of inner.variants ?? []) {
        if (!v.sourceLoc) continue;
        const r = offsetToRange(src, v.sourceLoc.pos, v.sourceLoc.length);
        children.push({ name: v.name, kind: SymbolKind.EnumMember, range: r, selectionRange: r });
      }
      return {
        name: inner.name,
        kind: SymbolKind.Enum,
        range,
        selectionRange: selRange,
        children,
      };
    }
    case ASTNodeKind.UNION_DECL: {
      return { name: inner.name, kind: SymbolKind.Struct, range, selectionRange: selRange };
    }
    case ASTNodeKind.TRAIT_DECL: {
      const children = [];
      for (const m of inner.methods ?? []) {
        if (!m.sourceLoc) continue;
        const r = offsetToRange(src, m.sourceLoc.pos, m.sourceLoc.length);
        children.push({ name: m.name, kind: SymbolKind.Method, range: r, selectionRange: r });
      }
      return {
        name: inner.name,
        kind: SymbolKind.Interface,
        range,
        selectionRange: selRange,
        children,
      };
    }
    case ASTNodeKind.LET_DECL: {
      return { name: inner.name, kind: SymbolKind.Variable, range, selectionRange: selRange };
    }
    case ASTNodeKind.CONST_DECL: {
      return { name: inner.name, kind: SymbolKind.Constant, range, selectionRange: selRange };
    }
    case ASTNodeKind.KIND_DECL: {
      return { name: inner.name, kind: SymbolKind.Interface, range, selectionRange: selRange };
    }
    default:
      return null;
  }
}

function findTopLevelByName(ast, name) {
  for (const decl of ast.body) {
    const inner = decl.kind === ASTNodeKind.EXPORT_DECL
      ? decl.decl
      : decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL
      ? decl.fn
      : decl;
    if (inner && inner.name === name) return inner;
  }
  return null;
}

function declKindLabel(decl) {
  if (!decl) return null;
  switch (decl.kind) {
    case ASTNodeKind.LET_DECL: return "let";
    case ASTNodeKind.CONST_DECL: return "const";
    case ASTNodeKind.PARAM: return "parameter";
    case ASTNodeKind.FUNCTION_DECL: return "function";
    case ASTNodeKind.TYPE_DECL: return "type";
    case ASTNodeKind.ENUM_DECL: return "enum";
    case ASTNodeKind.UNION_DECL: return "union";
    case ASTNodeKind.TRAIT_DECL: return "trait";
    case ASTNodeKind.FIELD_DECL: return "field";
    default: return null;
  }
}

// Given a (potentially monomorphized) struct type, find its declaring TYPE_DECL
// AST node in some module. Returns { typeDecl, targetMod } or null.
//
// For generic instantiations (`DynArray<int32>` -> struct.name === "DynArray__int32"),
// the original AST decl is named `DynArray` and lives in the module that
// declared the generic. We follow `genericInstance.declId` through the
// program-wide registry to find it; for non-generic structs, a plain name
// lookup in the receiver's module suffices.
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

function locOfDecl(decl, module) {
  if (!decl || !module) return null;
  const loc = decl.sourceLoc;
  if (!loc) return null;
  const length = loc.length ?? Math.max(1, (decl.name ?? "").length);
  // The parser's sourceLoc.pos sometimes lands one or two tokens past the
  // decl name (it captures parser state at construction time, not the name
  // token offset). For named decls, search the source near sourceLoc.pos
  // for the actual name span so the definition jump lands on the right
  // identifier rather than the surrounding punctuation.
  let pos = loc.pos ?? 0;
  if (decl.name && module.src) {
    const found = searchIdentNear(module.src, decl.name, pos);
    if (found != null) pos = found;
  }
  return { absPath: module.absPath, pos, length };
}

// Search `src` for an exact-word occurrence of `name` near `anchor`. We
// look in a window [anchor - 200, anchor + 200] and pick the closest
// match. Word-boundary is approximated by checking non-identifier chars
// on each side. Returns null when no match is found in the window.
function searchIdentNear(src, name, anchor) {
  const winStart = Math.max(0, anchor - 200);
  const winEnd = Math.min(src.length, anchor + 200);
  let best = -1;
  let bestDist = Infinity;
  let i = winStart;
  while (i <= winEnd - name.length) {
    const found = src.indexOf(name, i);
    if (found < 0 || found > winEnd - name.length) break;
    const before = found === 0 ? "" : src[found - 1];
    const after = src[found + name.length] ?? "";
    const beforeOk = !before || !isIdentCharStr(before);
    const afterOk = !after || !isIdentCharStr(after);
    if (beforeOk && afterOk) {
      const dist = Math.abs(found - anchor);
      if (dist < bestDist) { best = found; bestDist = dist; }
    }
    i = found + 1;
  }
  return best >= 0 ? best : null;
}

function isIdentCharStr(c) {
  const code = c.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}
