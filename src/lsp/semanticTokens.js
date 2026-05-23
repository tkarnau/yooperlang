// Semantic tokens for the Yooperlang LSP. Replaces the PascalCase-as-type
// heuristic in the TextMate grammar with real type-aware coloring driven
// by the typechecker's `resolvedType` annotations.
//
// LSP encodes semantic tokens as a flat array of (deltaLine, deltaStart,
// length, tokenType, tokenModifiers) quintuples. Lines are absolute the
// first time and delta-encoded relative to the previous token thereafter.
// Token type / modifier indices reference the legend we hand back on
// initialize.

import { ASTNodeKind } from "../contracts.js";
import { typeKinds } from "../jsyooptypecheck/types.js";

// Token type names emitted by this server. Order matters — the index here
// is what we put in the flat token data array.
const TOKEN_TYPES = [
  "function",   // 0  function decl, function name in call
  "method",     // 1  method decl, .method() call
  "parameter",  // 2  function parameter
  "variable",   // 3  let/const, identifier reference
  "property",   // 4  struct/enum field
  "type",       // 5  user-defined type (struct/trait/enum/union)
  "enumMember", // 6  EnumName.Variant
  "namespace",  // 7  imported module alias
  "keyword",    // 8  reserved-for-later keywords (provides/restricts/etc.)
];

// Token modifier names. Bit positions in the modifier bitmask correspond
// to the index here.
const TOKEN_MODIFIERS = [
  "declaration", // bit 0 — applies to the *defining* position
  "readonly",    // bit 1 — `const` bindings, enum variants
];

export const SEMANTIC_TOKEN_LEGEND = {
  tokenTypes: TOKEN_TYPES,
  tokenModifiers: TOKEN_MODIFIERS,
};

const TT_FUNCTION = 0;
const TT_METHOD = 1;
const TT_PARAMETER = 2;
const TT_VARIABLE = 3;
const TT_PROPERTY = 4;
const TT_TYPE = 5;
const TT_ENUM_MEMBER = 6;
const TT_NAMESPACE = 7;
const TM_DECLARATION = 1 << 0;
const TM_READONLY = 1 << 1;

// Build the semantic-tokens response for an AST.
//
//   { data: [delta_line, delta_start, length, tokenType, tokenModifiers, ...] }
//
// We collect (line, char, length, type, mods) records, sort by position,
// then delta-encode in a second pass. The AST walk doesn't visit nodes in
// source order (e.g. method bodies come before later top-level decls), so
// the sort step is load-bearing.
export function buildSemanticTokens(ast, src) {
  const tokens = [];
  walk(ast, (node) => emitTokensForNode(node, src, tokens));
  tokens.sort(compareTokens);
  return { data: encode(tokens, src) };
}

// Fields that point *backwards* in the AST (or into the typechecker's
// records, which in turn point back at AST nodes). Skipping these breaks
// the cycles those back-pointers create — see also CLONE_SKIP_FIELDS in
// codegen.js for the same shape. The `resolvedDeclNode` field stamped by
// the LSP layer is also already non-enumerable, but listing it here
// keeps things explicit.
const SKIP_FIELDS = new Set([
  "resolvedType",
  "resolvedDeclNode",
  "sourceLoc",
  "genericDecl",
  "genericInstantiation",
  "implementingType",
  "calleeMethodOf",
  "calleeTrait",
  "kindApplication",
  "resolvedKindApplication",
]);

function compareTokens(a, b) {
  if (a.line !== b.line) return a.line - b.line;
  return a.char - b.char;
}

function encode(tokens, src) {
  const data = [];
  let prevLine = 0;
  let prevChar = 0;
  let prevKey = ""; // (line:char:length:type) of the last emitted token
  for (const t of tokens) {
    // Drop exact duplicates — emit helpers fire from multiple paths
    // (e.g. a PARAM is touched once via its enclosing FUNCTION_DECL and
    // once as a standalone walker hit). After sort, duplicates land
    // adjacent.
    const key = `${t.line}:${t.char}:${t.length}:${t.type}`;
    if (key === prevKey) continue;
    const deltaLine = t.line - prevLine;
    const deltaChar = deltaLine === 0 ? t.char - prevChar : t.char;
    if (deltaChar < 0) continue; // safety: drop out-of-order duplicates
    data.push(deltaLine, deltaChar, t.length, t.type, t.mods);
    prevLine = t.line;
    prevChar = t.char;
    prevKey = key;
  }
  return data;
}

// Walk the AST, calling `cb(node)` for every object that carries a `kind`
// field. `visited` (a WeakSet) breaks every cycle defensively — the
// typechecker stamps several back-pointers (genericDecl,
// genericInstantiation, implementingType, …) that turn an otherwise-tree
// AST into a graph. SKIP_FIELDS handles the named cases; the WeakSet
// catches anything we missed.
function walk(node, cb, visited = new WeakSet()) {
  if (!node || typeof node !== "object") return;
  if (visited.has(node)) return;
  visited.add(node);
  if (Array.isArray(node)) {
    for (const c of node) walk(c, cb, visited);
    return;
  }
  if (node instanceof Map || node instanceof Set) return;
  if (node.kind) cb(node);
  for (const key of Object.keys(node)) {
    if (SKIP_FIELDS.has(key)) continue;
    const v = node[key];
    if (v && typeof v === "object") walk(v, cb, visited);
  }
}

// Stamp tokens for a single AST node based on its kind.
//
// The parser's `sourceLoc.pos` doesn't reliably point at the start of the
// identifier a node represents — it captures parser state at node-
// construction time, which usually lands one or two tokens past the name.
// And `sourceLoc.length` is almost never set. So every emit helper here
// uses `findNameSpan(src, anchor, name)` which scans both directions
// from the sourceLoc anchor and picks the closest word-boundary match.
function emitTokensForNode(node, src, tokens) {
  switch (node.kind) {
    case ASTNodeKind.FUNCTION_DECL: {
      emitNamed(tokens, src, node, node.name, TT_FUNCTION, TM_DECLARATION);
      // Params: their sourceLoc anchors near the param name; scan to find it.
      for (const p of node.params ?? []) {
        emitNamed(tokens, src, p, p.name, TT_PARAMETER, TM_DECLARATION);
        emitTypeAnnotationTokens(tokens, src, p, p.typeAnnotation);
      }
      emitTypeAnnotationTokens(tokens, src, node, node.returnTypeAnnotation);
      break;
    }
    case ASTNodeKind.METHOD_DECL: {
      emitNamed(tokens, src, node, node.name, TT_METHOD, TM_DECLARATION);
      for (const p of node.params ?? []) {
        emitNamed(tokens, src, p, p.name, TT_PARAMETER, TM_DECLARATION);
        emitTypeAnnotationTokens(tokens, src, p, p.typeAnnotation);
      }
      emitTypeAnnotationTokens(tokens, src, node, node.returnTypeAnnotation);
      break;
    }
    case ASTNodeKind.METHOD_SIG: {
      emitNamed(tokens, src, node, node.name, TT_METHOD, TM_DECLARATION);
      for (const p of node.params ?? []) {
        emitNamed(tokens, src, p, p.name, TT_PARAMETER, TM_DECLARATION);
        emitTypeAnnotationTokens(tokens, src, p, p.typeAnnotation);
      }
      emitTypeAnnotationTokens(tokens, src, node, node.returnTypeAnnotation);
      break;
    }
    case ASTNodeKind.TYPE_DECL:
    case ASTNodeKind.ENUM_DECL:
    case ASTNodeKind.UNION_DECL:
    case ASTNodeKind.TRAIT_DECL: {
      emitNamed(tokens, src, node, node.name, TT_TYPE, TM_DECLARATION);
      break;
    }
    case ASTNodeKind.ENUM_VARIANT: {
      emitNamed(tokens, src, node, node.name, TT_ENUM_MEMBER, TM_DECLARATION | TM_READONLY);
      break;
    }
    case ASTNodeKind.FIELD_DECL: {
      emitNamed(tokens, src, node, node.name, TT_PROPERTY, TM_DECLARATION);
      emitTypeAnnotationTokens(tokens, src, node, node.typeAnnotation);
      break;
    }
    case ASTNodeKind.LET_DECL: {
      emitNamed(tokens, src, node, node.name, TT_VARIABLE, TM_DECLARATION);
      emitTypeAnnotationTokens(tokens, src, node, node.typeAnnotation);
      break;
    }
    case ASTNodeKind.CONST_DECL: {
      emitNamed(tokens, src, node, node.name, TT_VARIABLE, TM_DECLARATION | TM_READONLY);
      emitTypeAnnotationTokens(tokens, src, node, node.typeAnnotation);
      break;
    }
    case ASTNodeKind.IDENT: {
      // Color a reference based on what it resolved to. Decls handle
      // themselves above; this is the use-site path.
      const t = node.resolvedType;
      const decl = node.resolvedDeclNode;
      if (decl?.kind === ASTNodeKind.PARAM) {
        emitNamed(tokens, src, node, node.name, TT_PARAMETER, 0);
      } else if (decl?.kind === ASTNodeKind.CONST_DECL) {
        emitNamed(tokens, src, node, node.name, TT_VARIABLE, TM_READONLY);
      } else if (decl?.kind === ASTNodeKind.LET_DECL) {
        emitNamed(tokens, src, node, node.name, TT_VARIABLE, 0);
      } else if (t?.kind === typeKinds.namespace) {
        emitNamed(tokens, src, node, node.name, TT_NAMESPACE, 0);
      } else if (
        t?.kind === typeKinds.struct ||
        t?.kind === typeKinds.enum ||
        t?.kind === typeKinds.union ||
        t?.kind === typeKinds.trait
      ) {
        emitNamed(tokens, src, node, node.name, TT_TYPE, 0);
      } else {
        emitNamed(tokens, src, node, node.name, TT_VARIABLE, 0);
      }
      break;
    }
    case ASTNodeKind.NAMESPACE_IDENT: {
      emitNamed(tokens, src, node, node.name, TT_NAMESPACE, 0);
      break;
    }
    case ASTNodeKind.CALL_EXPRESSION: {
      if (typeof node.callee === "string") {
        const isMethod = !!node.calleeMethodOf;
        emitNamed(tokens, src, node, node.callee, isMethod ? TT_METHOD : TT_FUNCTION, 0);
      }
      break;
    }
    case ASTNodeKind.FIELD_ACCESS: {
      if (typeof node.field === "string") {
        emitNamed(tokens, src, node, node.field, TT_PROPERTY, 0);
      }
      break;
    }
    case ASTNodeKind.VARIANT_CONSTRUCTOR: {
      if (typeof node.variantName === "string") {
        emitNamed(tokens, src, node, node.variantName, TT_ENUM_MEMBER, TM_READONLY);
      }
      break;
    }
    case ASTNodeKind.PARAM: {
      // Top-level pass already handles params via their enclosing
      // FUNCTION_DECL / METHOD_DECL, but PARAM nodes are reached as
      // children of the generic walker too. Emit defensively so a stray
      // PARAM whose container isn't recognized still gets colored.
      emitNamed(tokens, src, node, node.name, TT_PARAMETER, TM_DECLARATION);
      emitTypeAnnotationTokens(tokens, src, node, node.typeAnnotation);
      break;
    }
    case ASTNodeKind.TYPE_PARAM: {
      emitNamed(tokens, src, node, node.name, TT_TYPE, TM_DECLARATION);
      break;
    }
    default:
      // No semantic token for this node kind. Children handled by the
      // outer walk.
      break;
  }
}

// Emit a token of length `name.length` at the location in `src` where
// `name` actually appears, closest to the node's sourceLoc.pos anchor.
// No-op if `name` isn't found in the search window or `node` has no
// sourceLoc to anchor against.
function emitNamed(tokens, src, node, name, type, mods) {
  if (!name || !node?.sourceLoc) return;
  const anchor = node.sourceLoc.pos ?? 0;
  const start = findNameSpan(src, anchor, name);
  if (start == null) return;
  const span = offsetToPosLocal(src, start);
  if (!span) return;
  tokens.push({ line: span.line, char: span.character, length: name.length, type, mods });
}

// Walk a parsed type annotation tree and emit TT_TYPE tokens for every
// referenced type name. Type annotations are NOT AST nodes — they're
// parser objects shaped `{ kind: "typeName" | "typeApplication" | "refType"
// | "arrayType" | "selfType", name?, inner?, elem?, typeArgs? }` with no
// sourceLoc of their own. We anchor the name search at the enclosing
// declaration's sourceLoc and let `findNameSpan` walk to the right spot.
function emitTypeAnnotationTokens(tokens, src, anchorNode, annot) {
  if (!annot || !anchorNode?.sourceLoc) return;
  const anchor = anchorNode.sourceLoc.pos ?? 0;
  visitAnnot(annot, anchor);

  function visitAnnot(a, fromAnchor) {
    if (!a || typeof a !== "object") return;
    switch (a.kind) {
      case "refType":
        visitAnnot(a.inner, fromAnchor);
        return;
      case "arrayType":
        visitAnnot(a.elem, fromAnchor);
        return;
      case "typeName":
      case "typeApplication": {
        if (a.name) {
          const off = findNameSpan(src, fromAnchor, a.name);
          if (off != null) {
            const span = offsetToPosLocal(src, off);
            if (span) {
              tokens.push({
                line: span.line,
                char: span.character,
                length: a.name.length,
                type: TT_TYPE,
                mods: 0,
              });
            }
            // Advance the anchor past this match so nested typeArgs find
            // their matches *after* the outer name, not at the same spot.
            const nextAnchor = off + a.name.length;
            for (const arg of a.typeArgs ?? []) visitAnnot(arg, nextAnchor);
            return;
          }
        }
        for (const arg of a.typeArgs ?? []) visitAnnot(arg, fromAnchor);
        return;
      }
      case "selfType":
        // No source span — `self` is implicit in the syntax.
        return;
      default:
        return;
    }
  }
}

// Find the source offset where an identifier `name` appears closest to
// `anchor`. Word-boundary matches only (so `T` doesn't match the `T` in
// `Thing`). Returns null if no match in the window.
function findNameSpan(src, anchor, name) {
  if (!name || !src) return null;
  const WIN = 200;
  const winStart = Math.max(0, anchor - WIN);
  const winEnd = Math.min(src.length, anchor + WIN);
  let best = -1;
  let bestDist = Infinity;
  let i = winStart;
  while (i <= winEnd - name.length) {
    const found = src.indexOf(name, i);
    if (found < 0 || found > winEnd - name.length) break;
    const before = found === 0 ? 0 : src.charCodeAt(found - 1);
    const after = found + name.length < src.length
      ? src.charCodeAt(found + name.length)
      : 0;
    if (!isIdentCode(before) && !isIdentCode(after)) {
      const dist = Math.abs(found - anchor);
      if (dist < bestDist) { best = found; bestDist = dist; }
    }
    i = found + 1;
  }
  return best >= 0 ? best : null;
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

// Convert either (src, offset) or (_, _, line1, col1) to LSP 0-indexed
// { line, character }. The 1-indexed-line/col path lets us reuse
// sourceLoc.line/column directly without a second scan of `src`.
function offsetToPosLocal(src, offset, line1, col1) {
  if (line1 != null && col1 != null) {
    return { line: Math.max(0, line1 - 1), character: Math.max(0, col1 - 1) };
  }
  if (src == null || offset == null || offset < 0) return null;
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
