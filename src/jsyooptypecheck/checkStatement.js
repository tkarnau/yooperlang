// Statement typechecking.
//
// validateFunction sets up the function's scope (params + return type),
// then walks the body via validateStatement.
//
// validateStatement is a thin dispatcher: each AST node kind delegates to a
// small named helper (checkLetOrConst, checkReturn, checkIf, ...). Helpers
// push errors onto ctx.errors as they go; expressions inside statements
// delegate to resolveExprType in checkExpr.js.

import { ASTNodeKind } from "../contracts.js";
import {
  ErrorType,
  StructType,
  primAnnotations,
  resolveTypeFromName,
  typeKinds,
  typesEqual,
} from "./types.js";
import { pushError, formatType } from "./errors.js";
import { pushScope, popScope, declareInScope, lookupInScope } from "./scope.js";
import {
  checkInitializer,
  markErrObservedThroughRoot,
  resolveExprType,
} from "./checkExpr.js";
import { isFallible } from "./fallible.js";

export function validateFunction(funcNode, typeContext, errors) {
  const scope = pushScope(null);

  for (const param of funcNode.params ?? []) {
    const t =
      resolveTypeFromName(param.type, typeContext.structTable) ?? ErrorType();
    if (t.kind === typeKinds.error) {
      pushError(errors, param, `unknown type "${param.type}"`);
    }
    declareInScope(scope, param.name, t, typeKinds.param, param, errors);
    param.resolvedType = t;
  }

  const funcReturnType =
    resolveTypeFromName(funcNode.returnType, typeContext.structTable) ??
    ErrorType();
  if (funcReturnType.kind === typeKinds.error) {
    pushError(errors, funcNode, `unknown return type "${funcNode.returnType}"`);
  }
  funcNode.resolvedType = funcReturnType;

  const ctx = {
    funcReturnType,
    funcName: funcNode.name,
    typeContext,
    errors,
  };
  validateStatement(funcNode.body, scope, ctx);
  // params + the synthetic outer body share `scope`. Block-statement
  // bodies open their own inner scope and pop it themselves; this catches
  // the function-level scope (params and any locals declared at function
  // top — there usually are none, but it's the right shape).
  popScope(scope, errors);
}

export function validateStatement(node, scope, ctx) {
  switch (node.kind) {
    case ASTNodeKind.BLOCK:
      return checkBlock(node, scope, ctx);
    case ASTNodeKind.LET_DECL:
    case ASTNodeKind.CONST_DECL:
      return checkLetOrConst(node, scope, ctx);
    case ASTNodeKind.DESTRUCTURE_DECL:
      return checkDestructureDecl(node, scope, ctx);
    case ASTNodeKind.DISCARD_STATEMENT:
      return checkDiscardStatement(node, scope, ctx);
    case ASTNodeKind.RETURN_STATEMENT:
      return checkReturn(node, scope, ctx);
    case ASTNodeKind.EXPRESSION_STATEMENT:
      return checkExpressionStatement(node, scope, ctx);
    case ASTNodeKind.IF_STATEMENT:
      return checkIf(node, scope, ctx);
    case ASTNodeKind.WHILE_STATEMENT:
      return checkWhile(node, scope, ctx);
    default:
      pushError(
        ctx.errors,
        node,
        `typecheck: unhandled statement kind "${node.kind}"`,
      );
  }
}

// `{ ... }` — opens a fresh child scope, walks each inner statement, then
// enforces fallible-binding observation on every binding declared in this
// scope before letting them go out.
function checkBlock(node, scope, ctx) {
  const inner = pushScope(scope);
  for (const s of node.body) {
    validateStatement(s, inner, ctx);
  }
  popScope(inner, ctx.errors);
}

// `let x: T = expr;` / `const x: T = expr;`
//   - resolve the declared type
//   - if there's an initializer, type-check it against the declared type
//   - bind the name in the current scope
function checkLetOrConst(node, scope, ctx) {
  const declaredType =
    resolveTypeFromName(node.type, ctx.typeContext.structTable) ?? ErrorType();
  if (declaredType.kind === typeKinds.error) {
    pushError(ctx.errors, node, `unknown type "${node.type}"`);
  }
  node.resolvedType = declaredType;

  if (node.assignment) {
    checkInitializer(
      node.assignment,
      declaredType,
      scope,
      ctx,
      (rhsType) =>
        `cannot assign ${formatType(rhsType)} to ${formatType(declaredType)} in initializer of "${node.name}"`,
    );
  }

  const declKind = node.kind === ASTNodeKind.CONST_DECL ? "const" : "let";
  declareInScope(scope, node.name, declaredType, declKind, node, ctx.errors);
}

// `const { a, err } = expr;` / `let { a, err } = expr;`
//
// Two RHS shapes:
//   1. Plain expression — RHS resolves to a concrete struct type.
//      Each destructured name must be a field on that struct, and (if the
//      struct is fallible) `err` must be among the names.
//   2. `expr?` — the `?` already consumed err, so destructured names come
//      from the *stripped* fields. The `?` itself counts as observation
//      for the *operand's* binding, so we don't require `err` here.
//
// The multi-strip sentinel (TRY_OP whose operand has multiple non-err
// fields) shows up here as a non-Type from resolveExprType. We synthesize
// a transient "__stripped" StructType so the field-lookup loop can run
// uniformly. That synthetic type never escapes this function.
function checkDestructureDecl(node, scope, ctx) {
  const declKind = node.declKind === ASTNodeKind.CONST_DECL ? "const" : "let";
  let rhsType = resolveExprType(node.assignment, scope, ctx);
  const isTryRhs = node.assignment.kind === ASTNodeKind.TRY_OP;
  if (isTryRhs && node.assignment.strippedMulti) {
    rhsType = StructType("__stripped", node.assignment.strippedMulti.fields);
  }

  if (rhsType.kind === typeKinds.error) {
    for (const n of node.names) {
      declareInScope(scope, n, ErrorType(), declKind, node, ctx.errors);
    }
    return;
  }

  if (rhsType.kind !== typeKinds.struct) {
    pushError(
      ctx.errors,
      node,
      `cannot destructure non-struct type ${formatType(rhsType)}`,
    );
    for (const n of node.names) {
      declareInScope(scope, n, ErrorType(), declKind, node, ctx.errors);
    }
    return;
  }

  const fieldMap = new Map(
    (rhsType.fields ?? []).map((f) => [f.name, f.type]),
  );
  const seenNames = new Set();
  for (const name of node.names) {
    if (seenNames.has(name)) {
      pushError(ctx.errors, node, `duplicate name "${name}" in destructure`);
      continue;
    }
    seenNames.add(name);
    const fieldType = fieldMap.get(name);
    if (!fieldType) {
      pushError(
        ctx.errors,
        node,
        `type ${formatType(rhsType)} has no field "${name}"`,
      );
      declareInScope(scope, name, ErrorType(), declKind, node, ctx.errors);
      continue;
    }
    declareInScope(scope, name, fieldType, declKind, node, ctx.errors);
  }

  // Observation rule: when destructuring a fallible struct directly (no `?`),
  // `err` must be in the names. With `?` the operator already propagated err,
  // so the synthetic stripped type has no err and the rule doesn't apply.
  if (!isTryRhs && isFallible(rhsType) && !seenNames.has("err")) {
    pushError(
      ctx.errors,
      node,
      `destructuring a fallible type ${formatType(rhsType)} must include "err" or use '?' to propagate`,
    );
  }
}

// `_ = expr;` — type-resolve the RHS for its side effects; no binding is
// introduced. The discard counts as full observation: if the RHS root is a
// fallible binding, mark its err as observed so the scope-exit check is
// satisfied.
function checkDiscardStatement(node, scope, ctx) {
  resolveExprType(node.value, scope, ctx);
  markErrObservedThroughRoot(node.value, scope);
}

// `expr;` as a top-level statement. If the expression's resolved type is
// fallible (the user dropped a `f()` call result), that's a compile error —
// the language requires explicit handling.
//
// Special case: `f()?;` where `f` returns an err-only fallible (`{ err: string }`)
// strips to void, which is legal in statement position. Other strips that
// happen to land in statement position still produce a non-void value that
// gets dropped — but that's also "dropped fallible-call result" and is
// rejected by the same check.
function checkExpressionStatement(node, scope, ctx) {
  const t = resolveExprType(node.value, scope, ctx);
  if (isFallible(t)) {
    pushError(
      ctx.errors,
      node,
      `fallible result of type ${formatType(t)} dropped — bind it, destructure, propagate with '?', or discard with '_ = ...'`,
    );
  }
  return t;
}

// `return;` (in a void function) or `return expr;` — checks the value
// against the enclosing function's declared return type.
function checkReturn(node, scope, ctx) {
  if (!node.value) {
    if (ctx.funcReturnType.kind !== "void") {
      pushError(
        ctx.errors,
        node,
        `function "${ctx.funcName}" must return ${formatType(ctx.funcReturnType)}, go bare return`,
      );
    }
    return;
  }
  checkInitializer(
    node.value,
    ctx.funcReturnType,
    scope,
    ctx,
    (returnExprType) =>
      `cannot return ${formatType(returnExprType)} from "${ctx.funcName}" returning ${formatType(ctx.funcReturnType)}`,
  );
}

// `if (cond) { ... } else { ... }` — condition must be bool. Each branch
// is its own statement (the BLOCK case handles its own scope push).
function checkIf(node, scope, ctx) {
  requireBoolCondition(node, "if-statement", scope, ctx);
  validateStatement(node.body, scope, ctx);
  if (node.elseBody) {
    validateStatement(node.elseBody, scope, ctx);
  }
}

// `while (cond) { ... }` — condition must be bool.
function checkWhile(node, scope, ctx) {
  requireBoolCondition(node, "while-statement", scope, ctx);
  validateStatement(node.body, scope, ctx);
}

function requireBoolCondition(node, label, scope, ctx) {
  const boolType = resolveTypeFromName(
    primAnnotations.bool,
    ctx.typeContext.structTable,
  );
  const exprType = resolveExprType(node.expression, scope, ctx);
  if (!typesEqual(exprType, boolType)) {
    pushError(
      ctx.errors,
      node,
      `${label} must be a bool type expression, found ${formatType(exprType)}`,
    );
  }
}
