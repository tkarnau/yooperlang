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
  ArrayType,
  ErrorType,
  RefType,
  StructType,
  primAnnotations,
  resolveTypeFromName,
  resolveTypeAnnotation,
  formatAnnotation,
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
import { isFallible, } from "./fallible.js";
import { isAssignable } from "./coerce.js";

export function validateMethod(methodDecl, structType, typeContext, errors) {
  const scope = pushScope(null);

  // params[0] is self (ref structType); remaining params use types from C.3
  const resolvedParams = methodDecl.resolvedFuncType?.params ?? [];
  for (let i = 0; i < resolvedParams.length; i++) {
    const p = resolvedParams[i];
    declareInScope(scope, i === 0 ? "self" : p.name, p.type, typeKinds.param, methodDecl.params?.[i] ?? methodDecl, errors);
  }

  const funcReturnType = methodDecl.resolvedFuncType?.returnType ?? ErrorType();
  const ctx = {
    funcReturnType,
    funcName: methodDecl.name,
    typeContext,
    errors,
    inLoop: false,
    inMethodBody: true,
    enclosingType: structType,
  };
  validateStatement(methodDecl.body, scope, ctx);
  popScope(scope, errors);
}

export function validateFunction(funcNode, typeContext, errors) {
  const scope = pushScope(null);

  for (const param of funcNode.params ?? []) {
    const baseType = resolveTypeAnnotation(param.typeAnnotation, typeContext.structTable) ?? ErrorType();
    if (baseType.kind === typeKinds.error) {
      pushError(errors, param, `unknown type "${formatAnnotation(param.typeAnnotation)}"`);
    }
    // ref params: binding type in scope is RefType(baseType)
    const t = param.isRef ? RefType(baseType) : baseType;
    declareInScope(scope, param.name, t, typeKinds.param, param, errors);
    param.resolvedType = t;
  }

  const funcReturnType =
    resolveTypeAnnotation(funcNode.returnTypeAnnotation, typeContext.structTable) ??
    ErrorType();
  if (funcReturnType.kind === typeKinds.error) {
    pushError(errors, funcNode, `unknown return type "${formatAnnotation(funcNode.returnTypeAnnotation)}"`);
  }
  // Reject ref return types
  if (funcReturnType.kind === typeKinds.ref) {
    pushError(errors, funcNode,
      `functions may not return 'ref T' — returning a reference to a local binding is unsafe`);
  }
  funcNode.resolvedType = funcReturnType;

  const ctx = {
    funcReturnType,
    funcName: funcNode.name,
    typeContext,
    errors,
    inLoop: false,
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
    case ASTNodeKind.FOR_LOOP:
      return checkForLoop(node, scope, ctx);
    case ASTNodeKind.BREAK_STATEMENT:
      return checkBreak(node, ctx);
    case ASTNodeKind.CONTINUE_STATEMENT:
      return checkContinue(node, ctx);
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
    resolveTypeAnnotation(node.typeAnnotation, ctx.typeContext.structTable) ?? ErrorType();
  if (declaredType.kind === typeKinds.error) {
    pushError(ctx.errors, node, `unknown type "${formatAnnotation(node.typeAnnotation)}"`);
  }
  node.resolvedType = declaredType;

  if (node.assignment) {
    // For array literals with a known declared array type, pass element type context
    if (
      declaredType.kind === typeKinds.array &&
      node.assignment.kind === ASTNodeKind.ARRAY_LITERAL
    ) {
      checkArrayLiteralWithElemType(node.assignment, declaredType.elem, scope, ctx);
    } else {
      checkInitializer(
        node.assignment,
        declaredType,
        scope,
        ctx,
        (rhsType) =>
          `cannot assign ${formatType(rhsType)} to ${formatType(declaredType)} in initializer of "${node.name}"`,
      );
    }
  }

  const declKind = node.kind === ASTNodeKind.CONST_DECL ? "const" : "let";
  declareInScope(scope, node.name, declaredType, declKind, node, ctx.errors);
}

// Check an array literal against a known element type (used when the declared
// type provides the target element type).
function checkArrayLiteralWithElemType(litNode, elemType, scope, ctx) {
  if (litNode.elements.length === 0) {
    // Empty literal is OK when element type is known from declaration
    litNode.resolvedType = { kind: typeKinds.array, elem: elemType };
    litNode.knownElemType = elemType;
    return;
  }
  for (let i = 0; i < litNode.elements.length; i++) {
    checkInitializer(
      litNode.elements[i],
      elemType,
      scope,
      ctx,
      (actualType) =>
        `array literal element ${i} has type ${formatType(actualType)}, expected ${formatType(elemType)}`,
    );
  }
  litNode.resolvedType = ArrayType(elemType);
  litNode.knownElemType = elemType;
}

// `const { a, err } = expr;` / `let { a, err } = expr;`
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

  if (!isTryRhs && isFallible(rhsType) && !seenNames.has("err")) {
    pushError(
      ctx.errors,
      node,
      `destructuring a fallible type ${formatType(rhsType)} must include "err" or use '?' to propagate`,
    );
  }
}

function checkDiscardStatement(node, scope, ctx) {
  resolveExprType(node.value, scope, ctx);
  markErrObservedThroughRoot(node.value, scope);
}

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

function checkIf(node, scope, ctx) {
  requireBoolCondition(node, "if-statement", scope, ctx);
  validateStatement(node.body, scope, ctx);
  if (node.elseBody) {
    validateStatement(node.elseBody, scope, ctx);
  }
}

function checkWhile(node, scope, ctx) {
  requireBoolCondition(node, "while-statement", scope, ctx);
  const loopCtx = { ...ctx, inLoop: true };
  validateStatement(node.body, scope, loopCtx);
}

function checkForLoop(node, scope, ctx) {
  // init: initIdent must be in scope, initExpr must match its type
  const initBinding = lookupInScope(scope, node.initIdent);
  if (!initBinding) {
    pushError(ctx.errors, node,
      `for-loop variable "${node.initIdent}" is not declared — declare it before the loop`);
  } else {
    const initExprType = resolveExprType(node.initExpr, scope, ctx);
    checkAssignable(initBinding.type, initExprType, node, ctx);
  }

  // cond: must be bool
  const condType = resolveExprType(node.cond, scope, ctx);
  if (condType.kind !== typeKinds.prim || condType.name !== "bool") {
    if (condType.kind !== typeKinds.error) {
      pushError(ctx.errors, node.cond,
        `for-loop condition must be bool, found ${formatType(condType)}`);
    }
  }

  // step: stepIdent must be in scope, stepExpr must match its type
  const stepBinding = lookupInScope(scope, node.stepIdent);
  if (!stepBinding) {
    pushError(ctx.errors, node,
      `for-loop step variable "${node.stepIdent}" is not declared`);
  } else {
    const stepExprType = resolveExprType(node.stepExpr, scope, ctx);
    checkAssignable(stepBinding.type, stepExprType, node, ctx);
  }

  // body with inLoop: true
  const loopCtx = { ...ctx, inLoop: true };
  validateStatement(node.body, scope, loopCtx);
}

function checkBreak(node, ctx) {
  if (!ctx.inLoop) {
    pushError(ctx.errors, node, `'break' is not inside a loop`);
  }
}

function checkContinue(node, ctx) {
  if (!ctx.inLoop) {
    pushError(ctx.errors, node, `'continue' is not inside a loop`);
  }
}

// Check that a value expression is assignable to a binding type (used by for-loop init/step).
function checkAssignable(bindingType, exprType, node, ctx) {
  if (exprType.kind === typeKinds.error) return; // suppress cascade
  if (!isAssignable(bindingType, exprType)) {
    pushError(ctx.errors, node,
      `for-loop assignment: cannot assign ${formatType(exprType)} to ${formatType(bindingType)}`);
  }
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
