// Statement typechecking. validateFunction sets up the function's scope +
// param/return-type resolution, then walks the body via validateStatement.
// validateStatement dispatches on AST node kind and pushes errors as it
// goes; expressions inside statements delegate to resolveExprType.

import { ASTNodeKind } from "../contracts.js";
import {
  ErrorType,
  isFloatPrim,
  isIntPrim,
  primAnnotations,
  resolveTypeFromName,
  typeKinds,
  typesEqual,
} from "./types.js";
import { pushError, formatType } from "./errors.js";
import { pushScope, declareInScope } from "./scope.js";
import { coerceLiteralToType, isAssignable } from "./coerce.js";
import { resolveExprType } from "./checkExpr.js";

export function validateFunction(funcNode, typeContext, errors) {
  // start with null parent
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
    case ASTNodeKind.BLOCK: {
      const inner = pushScope(scope);
      for (const s of node.body) {
        validateStatement(s, inner, ctx);
      }
      return;
    }

    case ASTNodeKind.LET_DECL:
    case ASTNodeKind.CONST_DECL: {
      const declaredType =
        resolveTypeFromName(node.type, ctx.typeContext.structTable) ?? ErrorType();
      if (declaredType.kind === typeKinds.error) {
        pushError(ctx.errors, node, `unknown type "${node.type}"`);
      }
      node.resolvedType = declaredType;

      if (node.assignment) {
        const rhsType = resolveExprType(node.assignment, scope, ctx);
        if (!isAssignable(declaredType, rhsType)) {
          pushError(
            ctx.errors,
            node,
            `cannot assign ${formatType(rhsType)} to ${formatType(declaredType)} in initializer of "${node.name}"`,
          );
        }

        if (
          (rhsType.kind === typeKinds.untypedInt &&
            isIntPrim(declaredType.name)) ||
          (rhsType.kind === typeKinds.untypedFloat &&
            isFloatPrim(declaredType.name))
        ) {
          // only call coerceLiteralToType for actual literals (range check);
          // for compound expressions (binary, call, etc.) just pin the resolved type
          if (
            node.assignment.kind === ASTNodeKind.INT_LITERAL ||
            node.assignment.kind === ASTNodeKind.FLOAT_LITERAL
          ) {
            coerceLiteralToType(node.assignment, declaredType, ctx.errors);
          } else {
            node.assignment.resolvedType = declaredType;
          }
        }
      }

      const declKind = node.kind === ASTNodeKind.CONST_DECL ? "const" : "let";
      declareInScope(
        scope,
        node.name,
        declaredType,
        declKind,
        node,
        ctx.errors,
      );

      return;
    }
    case ASTNodeKind.RETURN_STATEMENT: {
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
      const returnExprType = resolveExprType(node.value, scope, ctx);
      if (!isAssignable(ctx.funcReturnType, returnExprType)) {
        pushError(
          ctx.errors,
          node,
          `cannot return ${formatType(returnExprType)} from "${ctx.funcName}" returning ${formatType(ctx.funcReturnType)}`,
        );
      }
      return;
    }
    case ASTNodeKind.EXPRESSION_STATEMENT: {
      resolveExprType(node.value, scope, ctx);
      return;
    }
    case ASTNodeKind.IF_STATEMENT: {
      const boolPrimType = resolveTypeFromName(
        primAnnotations.bool,
        ctx.typeContext.structTable,
      );
      const exprType = resolveExprType(node.expression, scope, ctx);
      if (!typesEqual(exprType, boolPrimType)) {
        pushError(
          ctx.errors,
          node,
          `if-statement must be a bool type expression, found ${formatType(exprType)}`,
        );
      }
      validateStatement(node.body, scope, ctx);
      if (node.elseBody) {
        validateStatement(node.elseBody, scope, ctx);
      }
      return;
    }
    case ASTNodeKind.WHILE_STATEMENT: {
      const boolPrimType = resolveTypeFromName(
        primAnnotations.bool,
        ctx.typeContext.structTable,
      );
      const exprType = resolveExprType(node.expression, scope, ctx);
      if (!typesEqual(exprType, boolPrimType)) {
        pushError(
          ctx.errors,
          node,
          `while-statement must be a bool type expression, found ${formatType(exprType)}`,
        );
      }
      // body block creates its own scope via the BLOCK case.
      validateStatement(node.body, scope, ctx);
      return;
    }
    // todo call expression as a statement ? do I need this if I have expression statements?
    default: {
      pushError(
        ctx.errors,
        node,
        `typecheck: unhandled statement kind "${node.kind}"`,
      );
    }
  }
}
