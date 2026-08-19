export const ASTNodeKind = Object.freeze({
  // declarations
  FUNCTION_DECL: "FUNCTION_DECL",
  LET_DECL: "LET_DECL",
  CONST_DECL: "CONST_DECL",
  TYPE_DECL: "TYPE_DECL",
  FIELD_DECL: "FIELD_DECL",
  DESTRUCTURE_DECL: "DESTRUCTURE_DECL",
  IMPORT_DECL: "IMPORT_DECL",
  // One `{ a, b as c }` entry of an import. This parser keeps specifiers as a
  // plain array on the IMPORT_DECL and never emits this kind; the bootstrap's
  // arena has to give the pair a node of its own, and the kind lists are in
  // lockstep by contract. See bootstrap/src/ast/node_kind.yoop.
  IMPORT_SPECIFIER: "IMPORT_SPECIFIER",
  EXPORT_DECL: "EXPORT_DECL",
  EXTERN_FUNCTION_DECL: "EXTERN_FUNCTION_DECL",
  EXTERN_TYPE_DECL: "EXTERN_TYPE_DECL",
  EXPORT_C_FUNCTION_DECL: "EXPORT_C_FUNCTION_DECL",

  // literals
  TEMPLATE_LITERAL: "TEMPLATE_LITERAL",
  STRING_PART: "STRING_PART",
  INT_LITERAL: "INT_LITERAL",
  FLOAT_LITERAL: "FLOAT_LITERAL",
  STRING_LITERAL: "STRING_LITERAL",
  BOOL_LITERAL: "BOOL_LITERAL",

  // expressions
  CALL_EXPRESSION: "CALL_EXPRESSION",
  EXPRESSION_STATEMENT: "EXPRESSION_STATEMENT",
  EXPR_PART: "EXPR_PART",
  UNARY_EXPRESSION: "UNARY_EXPRESSION",
  BINARY_EXPRESSION: "BINARY_EXPRESSION",
  FIELD_ACCESS: "FIELD_ACCESS",
  STRUCT_LITERAL: "STRUCT_LITERAL",
  STRUCT_LITERAL_FIELD: "STRUCT_LITERAL_FIELD",

  // other
  EXTERN_BLOCK: "EXTERN_BLOCK",
  BLOCK: "BLOCK",
  PARAM: "PARAM",
  IDENT: "IDENT",
  NAMESPACE_IDENT: "NAMESPACE_IDENT",
  ASSIGNMENT: "ASSIGNMENT",
  PROGRAM: "PROGRAM",
  RETURN_STATEMENT: "RETURN_STATEMENT",
  IF_STATEMENT: "IF_STATEMENT",
  WHILE_STATEMENT: "WHILE_STATEMENT",
  DISCARD_STATEMENT: "DISCARD_STATEMENT",
  TRY_OP: "TRY_OP",

  // refs, arrays, control flow
  FOR_LOOP: "FOR_LOOP",
  // `for item in xs { ... }` - element-walking loop over an array
  // (sequential iteration; trait-driven iteration is not supported).
  FOR_IN_LOOP: "FOR_IN_LOOP",
  // `a..b` - a half-open integer range. Sugar only: the driver rewrites every
  // RANGE_EXPR into a call to `exclusive` in std/core/range.yoop before
  // typecheck runs (see jsyoopdriver/lower_range.js), so no later stage
  // handles this kind.
  RANGE_EXPR: "RANGE_EXPR",
  BREAK_STATEMENT: "BREAK_STATEMENT",
  CONTINUE_STATEMENT: "CONTINUE_STATEMENT",
  ARRAY_LITERAL: "ARRAY_LITERAL",
  INDEX_EXPRESSION: "INDEX_EXPRESSION",
  REF_EXPRESSION: "REF_EXPRESSION",

  // traits
  TRAIT_DECL: "TRAIT_DECL",
  METHOD_SIG: "METHOD_SIG",
  METHOD_DECL: "METHOD_DECL",
  // `vtable Name for TraitName { field: (params) => ret, ... }`.
  // A vtable decl is a type-erased shape backing a trait - codegen emits it
  // as a LLVM struct of `{ ctx, methodPtr1, methodPtr2, ... }`.
  VTABLE_DECL: "VTABLE_DECL",

  // kinds
  KIND_DECL: "KIND_DECL",
  KIND_APPLIES_TO_CLAUSE: "KIND_APPLIES_TO_CLAUSE",
  KIND_REQUIRES_CLAUSE: "KIND_REQUIRES_CLAUSE",
  KIND_MUSTCALL_CLAUSE: "KIND_MUSTCALL_CLAUSE",
  KIND_OWNSBLOCK_CLAUSE: "KIND_OWNSBLOCK_CLAUSE",
  CLEANUP_CALL: "CLEANUP_CALL",
  // escape and sharing
  KIND_MUST_NOT_ESCAPE_CLAUSE: "KIND_MUST_NOT_ESCAPE_CLAUSE",
  KIND_MUST_NOT_SHARE_CLAUSE: "KIND_MUST_NOT_SHARE_CLAUSE",
  KIND_FORBIDS_CLAUSE: "KIND_FORBIDS_CLAUSE",
  // layout / composition / parameterized kinds
  KIND_LAYOUT_CLAUSE: "KIND_LAYOUT_CLAUSE",
  // clearance kinds: marker polarity (conferred | restrictive)
  KIND_MARKER_CLAUSE: "KIND_MARKER_CLAUSE",
  // clearance kinds: kind-decl-named transition authority
  // (clearedBy <fn> on a restrictive kind / appliedBy <fn> on a conferred kind)
  KIND_TRANSITION_CLAUSE: "KIND_TRANSITION_CLAUSE",
  // testing-via-kinds: `appliesTo function` support. `signature (p: T) => R;`
  // constrains the shape of a function carrying the kind; `enumerable as "x";`
  // authorizes the compiler to collect every such function into a named table.
  KIND_SIGNATURE_CLAUSE: "KIND_SIGNATURE_CLAUSE",
  KIND_ENUMERABLE_CLAUSE: "KIND_ENUMERABLE_CLAUSE",
  // `refcounted <retain> <release>;` - the kind's value is reference
  // counted, and these two methods of its `requires` trait are what the
  // compiler calls.
  KIND_REFCOUNTED_CLAUSE: "KIND_REFCOUNTED_CLAUSE",
  // `provides <Kind>;` - a function-position kind that rewrites the
  // call-site result type. `task` uses it: the body returns T, the call
  // site yields Task<T>.
  KIND_PROVIDES_CLAUSE: "KIND_PROVIDES_CLAUSE",
  // `pausable;` - a function carrying this kind is a coroutine: it may stop
  // partway through and continue later, and while stopped it holds no
  // worker thread. This is what forces the `await` calling convention.
  KIND_PAUSABLE_CLAUSE: "KIND_PAUSABLE_CLAUSE",

  // task / concurrency sugar
  WAIT_EXPRESSION: "WAIT_EXPRESSION",
  // `await g(...)` - drive an async callee inline, propagating its
  // suspension into the enclosing coroutine frame. Distinct from
  // WAIT_EXPRESSION, which joins an already-spawned Task<T> handle.
  AWAIT_EXPRESSION: "AWAIT_EXPRESSION",
  TASK_AUTO_WAIT: "TASK_AUTO_WAIT",
  TASK_RELEASE: "TASK_RELEASE",
  TASK_RETAIN: "TASK_RETAIN",

  // generics
  TYPE_PARAM: "TYPE_PARAM",

  // switch / patterns / sum types / unions
  // VARIANT_DECL is a sum type; VARIANT_CASE is one case inside a variant
  // decl. The `enum` keyword is reserved for the value-enum construct below.
  SWITCH_STATEMENT: "SWITCH_STATEMENT",
  SWITCH_ARM: "SWITCH_ARM",
  LITERAL_PATTERN: "LITERAL_PATTERN",
  VARIANT_PATTERN: "VARIANT_PATTERN",
  VARIANT_DECL: "VARIANT_DECL",
  VARIANT_CASE: "VARIANT_CASE",
  UNION_DECL: "UNION_DECL",
  VARIANT_CONSTRUCTOR: "VARIANT_CONSTRUCTOR",

  // value enums - C-style named constants of a primitive
  // underlying type (default int32). `enum<T> Name { Case (value)? , ... }`.
  // ENUM_CASE is one case inside an ENUM_DECL; its valueExpr is parsed as a
  // normal expression and const-evaluated at typecheck. The constructor and
  // pattern AST kinds reuse VARIANT_CONSTRUCTOR / VARIANT_PATTERN - the
  // typechecker stamps the right resolved type onto them.
  ENUM_DECL: "ENUM_DECL",
  ENUM_CASE: "ENUM_CASE",

  // unsafe pointers
  ADDRESS_OF_EXPRESSION: "ADDRESS_OF_EXPRESSION",
  DEREF_EXPRESSION: "DEREF_EXPRESSION",
  NULL_LITERAL: "NULL_LITERAL",
  UNSAFE_PTR_CAST: "UNSAFE_PTR_CAST",

  // errno intrinsics
  ERRNO_INTRINSIC: "ERRNO_INTRINSIC",

  // array slice syntax `xs[i..j]`
  SLICE_EXPRESSION: "SLICE_EXPRESSION",

  // compound assignments `x += y`, `x -= y`, etc. Stored as a
  // dedicated node so codegen can address the lvalue once (no double-eval
  // of expressions inside `xs[f()] += 1`).
  COMPOUND_ASSIGNMENT: "COMPOUND_ASSIGNMENT",

  // test undefined kind handling for iteration tests
  FAIL_TEST_KIND: "FAIL_TEST_KIND",

  // `@<name>(args?) target` compile-time / static-analysis attribute. The
  // `target` field carries the AST node the attribute decorates (a decl,
  // statement, block, or null for bare attribute statements). Per-attribute
  // behavior lives in src/jsyoopattributes/registry.js - the AST node itself
  // is just the carrier. Codegen must consume every ATTRIBUTE node before
  // emission; any that survive are an internal-error. @derive attributes are
  // consumed earlier still - the pre-typecheck expansion in
  // src/jsyoopderive/expand.js unwraps them; one surviving past it is an
  // internal error.
  ATTRIBUTE: "ATTRIBUTE",
});

export function SourceLocation(pos, line, column, length) {
  this.pos = pos;
  this.line = line;
  this.column = column;
  if (length !== undefined) this.length = length;
}

export function ASTNode(kind, sourceLoc) {
  this.kind = ASTNodeKind[kind];
  if (!this.kind) {
    throw new Error(`Invalid AST node kind: ${kind}`);
  }
  if (sourceLoc) {
    this.sourceLoc = new SourceLocation(
      sourceLoc.pos,
      sourceLoc.line,
      sourceLoc.column,
      sourceLoc.length,
    );
  }
}
