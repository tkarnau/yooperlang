// Completion: when the user is typing in a `.yoop` file, suggest
// identifiers that are visible at the cursor position. VSCode's LSP
// client filters the returned items against the typed prefix
// client-side, so we don't do prefix matching here - we just return
// everything in scope.
//
// What we include:
//   - Local LET / CONST / PARAM bindings declared in the function body
//     enclosing the cursor (and outer scopes if nested blocks).
//   - Top-level decls of the current module: functions, types, enums,
//     unions, traits, kinds.
//   - Imported names visible at module scope (functions, types,
//     namespaces from `import { ... } from "..."`).
//   - Builtin primitive type names (int32, bool, etc.) so type
//     annotations get completion too.
//
// Each item carries an LSP CompletionItem kind so VSCode renders the
// appropriate icon, and a `detail` line with the formatted type when
// known.

import { ASTNodeKind } from "../contracts.js";
import { formatType } from "../jsyooptypecheck/errors.js";
import { posToOffset } from "./nav.js";

// LSP CompletionItemKind constants. Full enum is in the LSP spec; only
// the values we emit are listed.
const CompletionItemKind = {
  Variable: 6,
  Function: 3,
  Field: 5,
  Property: 10,
  Method: 2,
  Constructor: 4,
  Class: 7,   // used for struct
  Interface: 8, // used for trait
  Enum: 13,
  EnumMember: 20,
  Struct: 22,
  Module: 9,  // used for namespace imports
  Keyword: 14,
  Constant: 21,
  TypeParameter: 25,
};

// Yoop primitive type names - exposed for completion in type-annotation
// position. Kept in sync with the lexer/typechecker's primitive set.
const PRIM_TYPES = [
  "int8", "int16", "int32", "int64",
  "uint8", "uint16", "uint32", "uint64",
  "usize", "isize", "int",
  "float32", "float64", "float",
  "bool", "char", "string", "void",
];

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

// Build the completion list at (line, character) inside `module`.
export function collectCompletions(module, src, position, ctx = {}) {
  const offset = posToOffset(src, position.line, position.character);
  const items = [];
  const seen = new Set();

  const push = (label, kind, detail) => {
    if (!label || seen.has(label)) return;
    seen.add(label);
    const item = { label, kind };
    if (detail) item.detail = detail;
    items.push(item);
  };

  // 1. Local bindings reachable at this offset - walk the AST and
  //    collect every LET/CONST/PARAM whose enclosing function/method
  //    contains `offset`. We treat any binding declared *before* offset
  //    inside an ancestor function as visible.
  for (const binding of collectLocalsInScope(module.ast, offset)) {
    const t = binding.node.resolvedType;
    let kind;
    if (binding.node.kind === ASTNodeKind.CONST_DECL) kind = CompletionItemKind.Constant;
    else if (binding.node.kind === ASTNodeKind.PARAM) kind = CompletionItemKind.Variable;
    else kind = CompletionItemKind.Variable;
    push(binding.node.name, kind, t ? formatType(t) : null);
  }

  // 2. Top-level decls in the current module.
  for (const decl of module.ast.body) {
    const inner = decl.kind === ASTNodeKind.EXPORT_DECL ? decl.decl
      : decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL ? decl.fn
      : decl;
    if (!inner || !inner.name) continue;
    const { kind, detail } = completionForDecl(inner);
    if (kind) push(inner.name, kind, detail);
  }

  // 3. Imported names - look up the module env to find imported symbols.
  if (ctx.moduleEnv) {
    const env = ctx.moduleEnv.get(module.id);
    for (const [name, imp] of env?.importedNames ?? []) {
      // Look up the imported decl in the source module to render a
      // useful detail line.
      const targetMod = ctx.modById?.get(imp.fromModuleId);
      const sourceDecl = targetMod
        ? findTopLevelByName(targetMod.ast, imp.exportName ?? name)
        : null;
      const fallback = sourceDecl ? completionForDecl(sourceDecl) : { kind: CompletionItemKind.Variable };
      push(name, fallback.kind ?? CompletionItemKind.Variable, fallback.detail);
    }
  }

  // 4. Primitive types - always available in type-annotation position.
  for (const prim of PRIM_TYPES) {
    push(prim, CompletionItemKind.TypeParameter, "primitive");
  }

  return items;
}

function completionForDecl(decl) {
  switch (decl.kind) {
    case ASTNodeKind.FUNCTION_DECL: {
      const params = (decl.params ?? [])
        .map((p) => `${p.isRef ? "ref " : ""}${p.name}: ${p.resolvedType ? formatType(p.resolvedType) : "?"}`)
        .join(", ");
      const ret = decl.resolvedType ? formatType(decl.resolvedType) : "?";
      return { kind: CompletionItemKind.Function, detail: `(${params}): ${ret}` };
    }
    case ASTNodeKind.TYPE_DECL: {
      const tps = (decl.typeParams ?? []).map((p) => p.name).join(", ");
      const head = tps ? `${decl.name}<${tps}>` : decl.name;
      return { kind: CompletionItemKind.Struct, detail: `type ${head}` };
    }
    case ASTNodeKind.ENUM_DECL:
      return { kind: CompletionItemKind.Enum, detail: `enum ${decl.name}` };
    case ASTNodeKind.UNION_DECL:
      return { kind: CompletionItemKind.Struct, detail: `union ${decl.name}` };
    case ASTNodeKind.TRAIT_DECL:
      return { kind: CompletionItemKind.Interface, detail: `trait ${decl.name}` };
    case ASTNodeKind.KIND_DECL:
      return { kind: CompletionItemKind.Interface, detail: `kind ${decl.name}` };
    case ASTNodeKind.LET_DECL:
    case ASTNodeKind.CONST_DECL: {
      const detail = decl.resolvedType ? formatType(decl.resolvedType) : null;
      return {
        kind: decl.kind === ASTNodeKind.CONST_DECL
          ? CompletionItemKind.Constant
          : CompletionItemKind.Variable,
        detail,
      };
    }
    default:
      return { kind: CompletionItemKind.Variable };
  }
}

function findTopLevelByName(ast, name) {
  for (const decl of ast.body) {
    const inner = decl.kind === ASTNodeKind.EXPORT_DECL ? decl.decl
      : decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL ? decl.fn
      : decl;
    if (inner?.name === name) return inner;
  }
  return null;
}

// Walk the AST and collect every LET/CONST/PARAM binding whose
// enclosing function/method body contains `offset`. PARAM bindings on
// the *enclosing* function/method are always in scope; LET/CONST
// bindings are in scope iff they precede `offset` in source order.
//
// The visibility rule used here is conservative (binding's sourceLoc.pos
// must be < offset) and doesn't model block-level scoping perfectly - it
// works well enough for completion which favors recall over precision.
function collectLocalsInScope(ast, offset) {
  const out = [];
  const visited = new WeakSet();
  walk(ast, []);

  function walk(node, fnStack) {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) { for (const c of node) walk(c, fnStack); return; }
    if (node instanceof Map || node instanceof Set) return;
    if (!node.kind) {
      for (const key of Object.keys(node)) {
        if (SKIP_FIELDS.has(key)) continue;
        const v = node[key];
        if (v && typeof v === "object") walk(v, fnStack);
      }
      return;
    }

    // Push function-like nodes onto the stack while descending; we only
    // collect their PARAM/LET/CONST when `offset` is inside this body.
    const isFn =
      node.kind === ASTNodeKind.FUNCTION_DECL ||
      node.kind === ASTNodeKind.METHOD_DECL;
    if (isFn) {
      const body = node.body;
      const bodyLoc = body?.sourceLoc;
      const bodyStart = bodyLoc?.pos ?? -1;
      // The end-of-body offset isn't on the AST, so approximate as the
      // next top-level decl's start, or end of source. Caller scans
      // every fn anyway - we just guard against collecting from fns the
      // cursor isn't inside.
      const insideThisFn = offset >= bodyStart;
      if (insideThisFn) {
        for (const p of node.params ?? []) {
          out.push({ node: p });
        }
      }
    }

    if (
      (node.kind === ASTNodeKind.LET_DECL || node.kind === ASTNodeKind.CONST_DECL) &&
      node.sourceLoc?.pos != null &&
      node.sourceLoc.pos < offset
    ) {
      out.push({ node });
    }

    const childFnStack = isFn ? [...fnStack, node] : fnStack;
    for (const key of Object.keys(node)) {
      if (SKIP_FIELDS.has(key)) continue;
      const v = node[key];
      if (v && typeof v === "object") walk(v, childFnStack);
    }
  }

  return out;
}
