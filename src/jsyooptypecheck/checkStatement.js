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
  primAnnotations,
  resolveTypeFromName,
  typeKinds,
  typesEqual,
} from "./types.js";
import { pushError, formatType } from "./errors.js";
import { pushScope, declareInScope } from "./scope.js";
import { checkInitializer, resolveExprType } from "./checkExpr.js";

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
}

export function validateStatement(node, scope, ctx) {
  switch (node.kind) {
    case ASTNodeKind.BLOCK:
      return checkBlock(node, scope, ctx);
    case ASTNodeKind.LET_DECL:
    case ASTNodeKind.CONST_DECL:
      return checkLetOrConst(node, scope, ctx);
    case ASTNodeKind.RETURN_STATEMENT:
      return checkReturn(node, scope, ctx);
    case ASTNodeKind.EXPRESSION_STATEMENT:
      return resolveExprType(node.value, scope, ctx);
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

// `{ ... }` — opens a fresh child scope, walks each inner statement.
function checkBlock(node, scope, ctx) {
  const inner = pushScope(scope);
  for (const s of node.body) {
    validateStatement(s, inner, ctx);
  }
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
