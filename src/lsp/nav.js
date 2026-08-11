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
// start of the underlying token - it captures the parser's position state
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
  // Reject cursors past EOF entirely - no node lives there.
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
      // Container without a kind - descend so we still reach AST nodes
      // inside (programs, blocks may not be reached via this branch but
      // we keep it general).
      for (const key of Object.keys(node)) {
        if (NAV_SKIP_FIELDS.has(key)) continue;
        const v = node[key];
        if (v && typeof v === "object") visit(v, path);
      }
      return;
    }
    // Match by identifier name - direct (PARAM/IDENT/LET/...) or via the
    // string-valued callee field on CALL_EXPRESSION / variant promotions.
    if (node.sourceLoc) {
      if (node.name === tok.text) consider(node, path);
      else if (node.kind === "CALL_EXPRESSION" && node.callee === tok.text) consider(node, path);
      else if (node.kind === "FIELD_ACCESS" && node.field === tok.text) consider(node, path);
      // Phase 7.5 / 12: VARIANT_CONSTRUCTOR / VARIANT_PATTERN carry the
      // qualifying type name on `enumName` and the case name on
      // `variantName`. The promotion path drops `node.object` / `node.field`
      // so the cursor only finds the node when we look at these slots.
      else if (
        (node.kind === "VARIANT_CONSTRUCTOR" || node.kind === "VARIANT_PATTERN") &&
        (node.enumName === tok.text || node.variantName === tok.text)
      ) {
        consider(node, path);
      }
      // `import * as ns from "..."` - the namespace name is on the import
      // decl as `namespaceName`. Cursor on `ns` lands here so goto-def can
      // jump to the imported file.
      else if (node.kind === "IMPORT_DECL" && node.namespaceName === tok.text) {
        consider(node, path);
      }
      // `import { foo } from "..."` - each specifier in `specifiers` has a
      // localName. Cursor on `foo` should jump to the export's decl.
      else if (node.kind === "IMPORT_DECL" && Array.isArray(node.specifiers)) {
        for (const spec of node.specifiers) {
          if (spec.localName === tok.text || spec.exportName === tok.text) {
            consider(node, path);
            break;
          }
        }
      }
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

// The comment block immediately above a declaration, as documentation.
//
// yooperdoom-takeaways 4.1 is the reason this exists. A 15,000 line project
// imported std/core/format.yoop in three files and hand-rolled a digit loop in
// four others; `history.yoop` zero-padded a number by hand, which is exactly
// `padStart(int_to_string(n), 4, "0")`. Nothing was missing from the library -
// the project just never found the parts of it that existed. An index helps
// once; showing a function's own header at the call site helps every time, and
// it needs no new convention, because std already writes these comments.
//
// `offset` should point at the declaration's NAME (which is what locOfDecl
// computes, and what goto-definition already jumps to). The scan walks UP from
// the start of that line and takes the contiguous run of comment lines,
// stopping at the first line that is not one. A blank line stops it too, which
// is what keeps a file's module header from attaching itself to whatever
// declaration happens to come first.
//
// Comments never reach the token stream (charEaters.js eats them), so this
// works on raw source rather than on tokens.
const MAX_DOC_LINES = 30;

export function docCommentAt(src, offset) {
  if (typeof src !== "string" || typeof offset !== "number") return null;
  if (offset < 0 || offset > src.length) return null;

  // Start of the line the declaration is on.
  let lineStart = src.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;

  const lines = [];
  while (lineStart > 0 && lines.length < MAX_DOC_LINES) {
    const prevEnd = lineStart - 1;                       // the \n above us
    const prevStart = src.lastIndexOf("\n", prevEnd - 1) + 1;
    const raw = src.slice(prevStart, prevEnd);
    const trimmed = raw.trim();

    if (trimmed.startsWith("//")) {
      // Strip the marker and ONE following space, so `// text` gives `text`
      // while `//   indented` keeps its relative indent. A `///` or a divider
      // line of slashes collapses to empty, which is fine - it renders as a
      // blank line rather than as noise.
      lines.unshift(trimmed.replace(/^\/+ ?/, ""));
      lineStart = prevStart;
      continue;
    }

    // A one-line block comment. Multi-line `/* ... */` blocks are not walked:
    // they would need the scan to run character-wise rather than line-wise,
    // and nothing in this tree documents a declaration that way.
    if (trimmed.startsWith("/*") && trimmed.endsWith("*/")) {
      lines.unshift(trimmed.slice(2, -2).trim());
      lineStart = prevStart;
      continue;
    }

    break;
  }

  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return null;
  return lines.join("\n");
}

// Human-readable hover text for a node. Returns null when there's nothing
// useful to show (e.g. punctuation token, keyword, decl with no resolved
// type). The result is plain text - the server wraps it in a markdown
// fence for display.
export function getHoverInfo(node, module) {
  if (!node) return null;
  switch (node.kind) {
    case ASTNodeKind.IDENT: {
      const t = node.resolvedType;
      if (!t) return null;
      const decl = node.resolvedDeclNode;
      const declKind = declKindLabel(decl);
      const name = node.name;
      return declKind
        ? `(${declKind}) ${name}: ${formatType(t)}`
        : `${name}: ${formatType(t)}`;
    }
    case ASTNodeKind.NAMESPACE_IDENT: {
      // A namespace import. The resolved type is the NamespaceType - render
      // as `(namespace) name` so the hover doesn't fall back to the
      // "unknown kind namespace" fallback in formatType.
      return `(namespace) ${node.name}`;
    }
    case ASTNodeKind.FIELD_ACCESS: {
      const t = node.resolvedType;
      if (!t) return null;
      // Phase 12: `ns.exportName` (non-call) - render in dotted form rather
      // than as a leading `.` field-access (there's no struct receiver to
      // hide the dot, so `palette.fire_color` reads more naturally).
      if (node.namespaceLookup) {
        return `${node.object?.name ?? "?"}.${node.field}: ${formatType(t)}`;
      }
      return `.${node.field}: ${formatType(t)}`;
    }
    case ASTNodeKind.CALL_EXPRESSION: {
      const t = node.resolvedType;
      const callee = typeof node.callee === "string" ? node.callee : "<call>";
      if (t) return `${callee}(...): ${formatType(t)}`;
      return null;
    }
    // Phase 7.5 / 12: a tagged-variant or value-enum constructor expression.
    // The constructor is hover-helpful: the case name + the resolved
    // (post-promotion) carrier type tells the reader which variant / value
    // they're looking at.
    case ASTNodeKind.VARIANT_CONSTRUCTOR: {
      const t = node.resolvedType ?? node.resolvedValueEnumType ?? node.resolvedVariantType;
      if (!t) return null;
      return `${node.enumName}.${node.variantName}: ${formatType(t)}`;
    }
    case ASTNodeKind.VARIANT_PATTERN: {
      const t = node.resolvedValueEnumType ?? node.resolvedVariantType;
      if (!t) return null;
      return `case ${node.enumName}.${node.variantName} of ${formatType(t)}`;
    }
    case ASTNodeKind.LET_DECL:
    case ASTNodeKind.CONST_DECL: {
      // Phase 6: kind-prefixed bindings (`disposable arr: T = ...`) replace
      // the `let`/`const` keyword with the kind name in the source. Hover
      // mirrors that so the kind is visible at a glance.
      const kw = node.resolvedKindType?.name
        ?? (node.kind === ASTNodeKind.LET_DECL ? "let" : "const");
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
      const tps = (node.typeParams ?? []).map((p) => p.name).join(", ");
      return tps ? `type ${node.name}<${tps}>` : `type ${node.name}`;
    }
    case ASTNodeKind.VARIANT_DECL: {
      // Phase 12: source-level keyword is `variant`, not `enum`.
      const tps = (node.typeParams ?? []).map((p) => p.name).join(", ");
      return tps ? `variant ${node.name}<${tps}>` : `variant ${node.name}`;
    }
    case ASTNodeKind.ENUM_DECL: {
      // Phase 12: value enum.
      const ut = node.underlying?.name ?? "int32";
      return ut === "int32" ? `enum ${node.name}` : `enum ${node.name}<${ut}>`;
    }
    case ASTNodeKind.UNION_DECL: {
      return `union ${node.name}`;
    }
    case ASTNodeKind.TRAIT_DECL: {
      const tps = (node.typeParams ?? []).map((p) => p.name).join(", ");
      return tps ? `trait ${node.name}<${tps}>` : `trait ${node.name}`;
    }
    case ASTNodeKind.KIND_DECL: {
      return `kind ${node.name}`;
    }
    case ASTNodeKind.FIELD_DECL: {
      if (!node.resolvedType) return null;
      return `${node.name}: ${formatType(node.resolvedType)}`;
    }
    // Phase 7.5: one case inside a variant decl.
    case ASTNodeKind.VARIANT_CASE: {
      return `case ${node.name}`;
    }
    // Phase 12: one case inside a value enum decl.
    case ASTNodeKind.ENUM_CASE: {
      return `case ${node.name}`;
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
//   module, modById  - required, supply the analysis context
//   tokenText        - optional; the identifier under the cursor. Used
//                      as a fallback when the AST node hit doesn't
//                      yield a definition (e.g. type annotations are
//                      parser objects, not AST nodes, so the cursor
//                      may land on a TEMPLATE_LITERAL parent or null).
//   tokenStart       - optional; the source offset of `tokenText`. Used
//                      to detect a leading `ns.` prefix at the cursor
//                      and route the lookup through that namespace.
//   cursorOffset     - optional; the raw cursor offset. Used as a final
//                      fallback to detect cursors that land inside a
//                      string literal (e.g. import path strings) where
//                      identTokenAt returned nothing.
//   moduleEnv        - optional; Map<moduleId, env> from analyze().
//                      Enables type / kind table lookups.
export function findDefinition(node, ctx) {
  const { module, modById, tokenText, tokenStart, cursorOffset, moduleEnv } = ctx;
  // Phase 12: cursor on (or inside) an import decl - prefer file/file-
  // export navigation over the more general dotted-name sniff below.
  // This handles the path-string case (`"./lib.yoop"`) and also keeps
  // the dotted sniff from misinterpreting an identifier-shaped substring
  // inside the import line.
  if (typeof cursorOffset === "number" && module?.src) {
    const importDecl = findImportDeclCovering(module.ast, module.src, cursorOffset);
    if (importDecl) {
      const ns = importDecl.namespaceName;
      // If the cursor is exactly the namespace name, that's the AST-node
      // case which is handled below; but it's safe to early-return here
      // too. Same for matching specifiers.
      const targetMod = importDecl.resolvedModuleId
        ? modById.get(importDecl.resolvedModuleId)
        : null;
      if (targetMod) {
        if (tokenText && Array.isArray(importDecl.specifiers)) {
          const spec = importDecl.specifiers.find(
            (s) => s.localName === tokenText || s.exportName === tokenText,
          );
          if (spec) {
            const hit = findInModule(targetMod, spec.exportName);
            if (hit) return locOfDecl(hit.decl, hit.mod);
          }
        }
        // Namespace ident or path-string cursor - jump into the file.
        if (!tokenText || tokenText === ns) {
          return { absPath: targetMod.absPath, pos: 0, length: 1 };
        }
        // Fall through to other resolution paths for tokens that aren't
        // recognized parts of the import (which shouldn't normally appear
        // on an import line, but be defensive).
      }
    }
  }
  // Phase 12: dotted form sniff. When the cursor is on either side of a
  // `<ns>.<name>` in a type annotation (which isn't an AST node) we still
  // want goto-def to jump to the right place.
  if (tokenText && module?.src && typeof tokenStart === "number") {
    const dotted = readDottedAtCursor(module.src, tokenStart, tokenText);
    if (dotted) {
      const target = resolveDottedName(dotted, module, modById, moduleEnv);
      if (target) return target;
    }
  }
  if (!node) {
    return tokenText ? findByName(tokenText, module, modById, moduleEnv) : null;
  }

  // Phase 12: cursor on `import * as ns from "./m.yoop"` - jump into the
  // imported file. For `import { foo } from "./m.yoop"` cursor on `foo`,
  // jump to the export's decl in the source module.
  if (node.kind === ASTNodeKind.IMPORT_DECL) {
    const targetMod = node.resolvedModuleId
      ? modById.get(node.resolvedModuleId)
      : null;
    if (targetMod) {
      // Bare-import (path-only): if cursor token matches a specifier's
      // localName, jump to that export's decl.
      if (tokenText && Array.isArray(node.specifiers)) {
        const spec = node.specifiers.find(
          (s) => s.localName === tokenText || s.exportName === tokenText,
        );
        if (spec) {
          const hit = findInModule(targetMod, spec.exportName);
          if (hit) return locOfDecl(hit.decl, hit.mod);
        }
      }
      // Namespace import or unmatched-specifier cursor: jump to the file's
      // first source location (the top of the module).
      return { absPath: targetMod.absPath, pos: 0, length: 1 };
    }
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
    const hit = findInModule(module, node.name);
    if (hit) return locOfDecl(hit.decl, hit.mod);
  }

  // CALL_EXPRESSION with a string callee: cross-module via calleeModuleId,
  // otherwise look up in this module's top-level decls.
  if (node.kind === ASTNodeKind.CALL_EXPRESSION && typeof node.callee === "string") {
    if (node.calleeModuleId) {
      const targetMod = modById.get(node.calleeModuleId);
      if (targetMod) {
        const exported = node.calleeExportName ?? node.callee;
        const hit = findInModule(targetMod, exported);
        if (hit) return locOfDecl(hit.decl, hit.mod);
      }
    }
    const hit = findInModule(module, node.callee);
    if (hit) return locOfDecl(hit.decl, hit.mod);
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
      const typeHit = findInModule(targetMod, recv.name);
      if (typeHit?.decl?.methods?.length) {
        const m = typeHit.decl.methods.find((mm) => mm.name === node.calleeMethodName);
        if (m) return locOfDecl(m, typeHit.mod);
      }
    }
  }

  // Phase 12: `ns.exportedName` (non-call) - the typechecker stamped a
  // `namespaceLookup` slot pointing at the source module + the original
  // export. Jump straight to the decl by name in that module.
  if (node.kind === ASTNodeKind.FIELD_ACCESS && node.namespaceLookup) {
    const targetMod = modById.get(node.namespaceLookup.moduleId);
    if (targetMod) {
      const hit = findInModule(targetMod, node.namespaceLookup.exportName);
      if (hit) return locOfDecl(hit.decl, hit.mod);
    }
  }

  // Phase 7.5 / 12: a promoted variant / value-enum constructor / pattern.
  // Cursor on the case name jumps to the case's decl inside the enum body;
  // cursor on the qualifying type name jumps to the decl itself.
  if (
    (node.kind === ASTNodeKind.VARIANT_CONSTRUCTOR ||
      node.kind === ASTNodeKind.VARIANT_PATTERN) &&
    node.enumName
  ) {
    const carrier =
      node.resolvedValueEnumType ?? node.resolvedVariantType ?? null;
    const targetMod = carrier?.moduleId
      ? modById.get(carrier.moduleId) ?? module
      : module;
    const enumHit = findInModule(targetMod, node.enumName);
    if (enumHit) {
      const decl = enumHit.decl;
      // Cursor on case name -> the case AST node; cursor on type name (or
      // anywhere else inside the constructor) -> the decl itself.
      const wantCase = tokenText && tokenText === node.variantName;
      if (wantCase) {
        const cases =
          decl.kind === ASTNodeKind.ENUM_DECL ? decl.cases : decl.variants;
        const found = (cases ?? []).find((c) => c.name === node.variantName);
        if (found) return locOfDecl(found, enumHit.mod);
      }
      return locOfDecl(decl, enumHit.mod);
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
  // TYPE_DECL, etc.). The decl is its own definition site - return its
  // location so jump-to-def is a no-op rather than dead.
  if (node.name && node.sourceLoc) {
    const declSelf = locOfDecl(node, module);
    if (declSelf) return declSelf;
  }

  // Final fallback: the cursor identifier may be a type or kind name in
  // a type annotation (annotations aren't AST nodes - they're parser
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
// `cursor` (optional): { src, tokenStart } - lets the fallback also
// resolve `<ns>.<name>` forms by sniffing the source around the cursor.
export function hoverFromName(name, module, analysis, cursor) {
  if (!name || !module) return null;
  // Phase 12: cursor on either half of `<ns>.<name>` - jump to the right
  // module before doing the by-name lookup.
  if (cursor?.src && typeof cursor.tokenStart === "number") {
    const dotted = readDottedAtCursor(cursor.src, cursor.tokenStart, name);
    if (dotted && analysis?.moduleEnv) {
      const env = analysis.moduleEnv.get(module.id);
      const imp = env?.importedNames?.get(dotted.ns);
      if (imp?.kind === "namespace") {
        if (dotted.onNs) return `(namespace) ${dotted.ns}`;
        const target = analysis.modById.get(imp.fromModuleId);
        if (target) {
          const hit = findInModule(target, dotted.name);
          if (hit) return summarizeDecl(hit.decl);
        }
      }
    }
  }
  const localHit = findInModule(module, name);
  if (localHit) return summarizeDecl(localHit.decl);
  const env = analysis?.moduleEnv?.get(module.id);
  const imp = env?.importedNames?.get(name);
  if (imp?.fromModuleId) {
    const targetMod = analysis.modById.get(imp.fromModuleId);
    if (targetMod) {
      const exported = imp.exportName ?? name;
      const hit = findInModule(targetMod, exported);
      if (hit) return summarizeDecl(hit.decl);
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
    case ASTNodeKind.VARIANT_DECL: {
      const tps = (decl.typeParams ?? []).map((p) => p.name).join(", ");
      return tps ? `variant ${decl.name}<${tps}>` : `variant ${decl.name}`;
    }
    case ASTNodeKind.ENUM_DECL: {
      const ut = decl.underlying?.name ?? "int32";
      return ut === "int32" ? `enum ${decl.name}` : `enum ${decl.name}<${ut}>`;
    }
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

// Phase 12: read a possible `<ns>.<name>` form around the cursor. Given the
// cursor's token + its source offset, walk backwards over ident chars to
// catch the case where the user is hovering on the second half of a dotted
// name; walk forwards to catch the first-half case. Returns `{ ns, name,
// onNs }` where `onNs` is true iff the cursor token IS the namespace half.
// Returns null when there's no leading `<ident>.` or trailing `.<ident>`.
function readDottedAtCursor(src, tokStart, tokText) {
  const tokEnd = tokStart + tokText.length;
  // Case 1: cursor is the second half. `ns.tokText` -> look back from tokStart.
  if (tokStart >= 2 && src[tokStart - 1] === ".") {
    let i = tokStart - 2;
    while (i >= 0 && isIdentCharStr(src[i])) i--;
    const ns = src.slice(i + 1, tokStart - 1);
    if (ns && isIdentStart(ns.charCodeAt(0))) {
      return { ns, name: tokText, onNs: false };
    }
  }
  // Case 2: cursor is the first half. `tokText.<name>` -> look forward.
  if (tokEnd < src.length && src[tokEnd] === ".") {
    let j = tokEnd + 1;
    while (j < src.length && isIdentCharStr(src[j])) j++;
    const name = src.slice(tokEnd + 1, j);
    if (name && isIdentStart(name.charCodeAt(0))) {
      return { ns: tokText, name, onNs: true };
    }
  }
  return null;
}

// Resolve a `ns.name` pair through the imported namespaces of `module`.
// If the cursor is on the namespace half, jump to the import decl; if on
// the export name, jump to the export decl in the source module.
function resolveDottedName(dotted, module, modById, moduleEnv) {
  if (!moduleEnv) return null;
  const env = moduleEnv.get(module.id);
  const imp = env?.importedNames?.get(dotted.ns);
  if (!imp || imp.kind !== "namespace") return null;
  if (dotted.onNs) {
    // Cursor on the namespace itself - find the import decl that introduced
    // this name and jump to it.
    const decl = findImportDecl(module.ast, dotted.ns);
    if (decl) return locOfDecl(decl, module);
    return null;
  }
  const targetMod = modById.get(imp.fromModuleId);
  if (!targetMod) return null;
  const hit = findInModule(targetMod, dotted.name);
  if (hit) return locOfDecl(hit.decl, hit.mod);
  return null;
}

// Find the `import * as <name> from "..."` decl that introduced `nsName`.
function findImportDecl(ast, nsName) {
  for (const decl of ast.body) {
    if (decl.kind === ASTNodeKind.IMPORT_DECL && decl.namespaceName === nsName) {
      return decl;
    }
  }
  return null;
}

// Find an IMPORT_DECL whose source line(s) cover `offset`. Used when the
// cursor lands inside the path string literal (identTokenAt returns null
// there). The decl's `sourceLoc.pos` is the start; the line containing
// the trailing `;` is the natural end. Imports always sit at the top of
// the module so the loop is bounded.
function findImportDeclCovering(ast, src, offset) {
  for (const decl of ast.body) {
    if (decl.kind !== ASTNodeKind.IMPORT_DECL) break;
    if (!decl.sourceLoc) continue;
    const start = decl.sourceLoc.pos ?? 0;
    const lineStart = src.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const semi = src.indexOf(";", start);
    const end = semi >= 0 ? semi + 1 : start + (decl.sourceLoc.length ?? 1);
    if (offset >= lineStart && offset <= end) return decl;
  }
  return null;
}

// Look up a type or kind name in the module's tables and follow imports
// across modules. Returns a definition location or null. Used as a
// fallback when there's no AST node carrying the name (type annotations,
// kind references inside KIND_REQUIRES_CLAUSE, etc.).
function findByName(name, module, modById, moduleEnv) {
  if (!name || !module) return null;
  // First, prefer the same-module AST since walking AST decls is cheap
  // and always available even when moduleEnv is null.
  const local = findInModule(module, name);
  if (local) return locOfDecl(local.decl, local.mod);
  // Cross-module: check importedNames for this module via moduleEnv.
  if (moduleEnv) {
    const env = moduleEnv.get(module.id);
    const imp = env?.importedNames?.get(name);
    if (imp?.fromModuleId) {
      const targetMod = modById.get(imp.fromModuleId);
      if (targetMod) {
        const exported = imp.exportName ?? name;
        const hit = findInModule(targetMod, exported);
        if (hit) return locOfDecl(hit.decl, hit.mod);
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
// spec - we only emit the kinds Yooperlang has.
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
    case ASTNodeKind.VARIANT_DECL: {
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
    // Phase 12: value enum decl. Each case becomes an EnumMember child so
    // the outline view collapses cases under the parent enum.
    case ASTNodeKind.ENUM_DECL: {
      const children = [];
      for (const c of inner.cases ?? []) {
        if (!c.sourceLoc) continue;
        const r = offsetToRange(src, c.sourceLoc.pos, c.sourceLoc.length);
        children.push({ name: c.name, kind: SymbolKind.EnumMember, range: r, selectionRange: r });
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

// Find a top-level decl by name anywhere in the MODULE that owns `mod`, and
// report WHICH SOURCE FILE it came from.
//
// modules-as-directories: a module's declarations are spread across its source
// files, so `findTopLevelByName(mod.ast, name)` only ever sees the file it was
// handed. That made the LSP miss anything a sibling declared - goto-definition
// and hover both came back empty for a name that resolves fine at compile time.
// `modById` cannot substitute, because it maps one entry per moduleId and so
// holds just ONE of a directory module's files.
//
// Cheap for the common case: a single-file module has `siblings.length === 1`
// and the loop below exits after the file we already checked.
export function findInModule(mod, name) {
  if (!mod || !name) return null;
  const own = findTopLevelByName(mod.ast, name);
  if (own) return { decl: own, mod };
  for (const sib of mod.siblings ?? []) {
    if (sib === mod) continue;
    const decl = findTopLevelByName(sib.ast, name);
    if (decl) return { decl, mod: sib };
  }
  return null;
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
    case ASTNodeKind.VARIANT_DECL: return "variant";
    case ASTNodeKind.ENUM_DECL: return "enum";
    case ASTNodeKind.UNION_DECL: return "union";
    case ASTNodeKind.TRAIT_DECL: return "trait";
    case ASTNodeKind.KIND_DECL: return "kind";
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
  const hit = findInModule(targetMod, structType.name);
  if (hit) return { typeDecl: hit.decl, targetMod: hit.mod };
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
