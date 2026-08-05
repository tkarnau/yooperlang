// Lowering for the `..` range operator.
//
// `a..b` parses to a RANGE_EXPR, and this is the only stage that knows the
// kind exists: every RANGE_EXPR is rewritten IN PLACE into a namespaced call
// to `exclusive` in std/core/range.yoop, and a namespace import for that
// module is unshifted onto the module body. Typecheck and codegen therefore
// see an ordinary call returning an ordinary struct - the operator adds no
// rules to either, and `Range` stays a plain userland type.
//
// This runs inside the module graph walk, BEFORE the import walk reads
// `ast.body`, so the synthesized import is resolved by the ordinary graph
// machinery (which also pulls range.yoop into the graph, but only for modules
// that actually use `..`).
//
// The namespace alias is unspellable in user source, so it can never collide
// with a user binding - same trick as the parser's `$region$N` names.

import { ASTNodeKind } from "../contracts.js";

const RANGE_STD_PATH = "std/core/range.yoop";
const RANGE_NAMESPACE = "$range";
const RANGE_CTOR = "exclusive";

// Rewrites every `a..b` in `ast` and returns true if the module needs the
// range import (i.e. it contained at least one range). Idempotent: the
// rewrite clears `ast.rangeExprs`, so a second call is a no-op.
export function lowerRangeExprs(ast) {
  const ranges = ast.rangeExprs ?? [];
  if (ranges.length === 0) return false;

  for (const node of ranges) {
    rewriteToCall(node);
  }
  ast.rangeExprs = [];

  ast.body.unshift({
    kind: ASTNodeKind.IMPORT_DECL,
    importKind: "namespace",
    namespaceName: RANGE_NAMESPACE,
    sourcePath: RANGE_STD_PATH,
    sourceLoc: ast.sourceLoc,
  });
  return true;
}

// RANGE_EXPR { start, end } -> CALL_EXPRESSION `$range.exclusive(start, end)`.
// Mutates in place because the node is already wired into its parent (the
// for-in RHS, a binding initializer, a call argument, ...) and the parent
// slots are not tracked. Every synthesized node inherits the range's own
// sourceLoc, which points at the start bound - so a diagnostic about a bad
// bound still lands on the user's `..` expression.
function rewriteToCall(node) {
  const { start, end, sourceLoc } = node;

  const nsIdent = { kind: ASTNodeKind.IDENT, name: RANGE_NAMESPACE, sourceLoc };
  const callee = {
    kind: ASTNodeKind.FIELD_ACCESS,
    object: nsIdent,
    field: RANGE_CTOR,
    fieldSourceLoc: sourceLoc,
    sourceLoc,
  };

  node.kind = ASTNodeKind.CALL_EXPRESSION;
  node.callee = callee;
  node.args = [start, end];
  // Marks the call as not-user-written, so an argument-type diagnostic can talk
  // about the range's bounds instead of `$range.exclusive`'s parameters. See
  // argMismatchMessage in jsyooptypecheck/checkExpr.js.
  node.rangeOperator = true;
  delete node.start;
  delete node.end;
}
