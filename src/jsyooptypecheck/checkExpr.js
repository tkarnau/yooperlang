// Expression typechecking. resolveExprType dispatches on AST node kind, sets
// node.resolvedType, and returns the same Type. resolveCallType backs
// the CALL_EXPRESSION case: arity + per-arg assignability against a
// function or extern signature.

import { ASTNodeKind } from "../contracts.js";
import {
  ErrorType,
  PrimType,
  UntypedFloatType,
  UntypedIntType,
  VoidType,
  isFloatPrim,
  isIntPrim,
  primAnnotations,
  resolveTypeName,
  typeKinds,
  typesEqual,
} from "./types.js";
import { pushError, formatType } from "./errors.js";
import { lookupInScope } from "./scope.js";
import { coerceLiteralToType, isAssignable, unifyArith } from "./coerce.js";

export function resolveExprType(node, scope, ctx) {
  switch (node.kind) {
    case ASTNodeKind.INT_LITERAL: {
      node.resolvedType = UntypedIntType();
      return node.resolvedType;
    }
    case ASTNodeKind.FLOAT_LITERAL: {
      node.resolvedType = UntypedFloatType();
      return node.resolvedType;
    }
    case ASTNodeKind.STRING_LITERAL: {
      node.resolvedType = PrimType(primAnnotations.string);
      return node.resolvedType;
    }
    case ASTNodeKind.IDENT: {
      const binding = lookupInScope(scope, node.name);
      if (!binding) {
        pushError(ctx.errors, node, `undefined variable "${node.name}"`);
        node.resolvedType = ErrorType();
        return node.resolvedType;
      }
      node.resolvedType = binding.type;
      return node.resolvedType;
    }
    case ASTNodeKind.BINARY_EXPRESSION: {
      const leftType = resolveExprType(node.left, scope, ctx);
      const rightType = resolveExprType(node.right, scope, ctx);
      const unified = unifyArith(leftType, rightType, node.op);
      node.resolvedType = unified;
      return unified;
    }
    case ASTNodeKind.CALL_EXPRESSION: {
      // printf is variadic — just recurse into args, no arity/type check
      if (node.callee === "printf") {
        for (const arg of node.args) {
          resolveExprType(arg, scope, ctx);
        }
        node.resolvedType = PrimType(primAnnotations.int32);
        return node.resolvedType;
      }

      const sig = ctx.typeContext.moduleSymbols.get(node.callee);

      if (!sig) {
        const knownExterns = {
          puts: {
            params: [PrimType(primAnnotations.string)],
            returnType: PrimType(primAnnotations.int32),
          },
          exit: {
            params: [PrimType(primAnnotations.int32)],
            returnType: VoidType(),
          },
        };
        const externSig = knownExterns[node.callee];
        if (!externSig) {
          pushError(ctx.errors, node, `unknown function "${node.callee}"`);
          node.resolvedType = ErrorType();
          return node.resolvedType;
        }
        return resolveCallType(node, externSig, scope, ctx);
      }

      return resolveCallType(node, sig, scope, ctx);
    }
    case ASTNodeKind.UNARY_EXPRESSION: {
      const operandType = resolveExprType(node.operand, scope, ctx);
      if (node.op === "minus") {
        if (
          operandType.kind === typeKinds.untypedInt ||
          (operandType.kind === typeKinds.prim &&
            isIntPrim(operandType.name)) ||
          operandType.kind === typeKinds.untypedFloat ||
          (operandType.kind === typeKinds.prim && isFloatPrim(operandType.name))
        ) {
          node.resolvedType = operandType;
          return node.resolvedType;
        } else {
          pushError(
            ctx.errors,
            node,
            `unary minus operator requires an int or float operand, found ${formatType(operandType)}`,
          );
          node.resolvedType = ErrorType();
          return node.resolvedType;
        }
      } else if (node.op === "not") {
        const boolPrimType = resolveTypeName(
          primAnnotations.bool,
          ctx.typeContext.structTable,
        );
        if (typesEqual(operandType, boolPrimType)) {
          node.resolvedType = boolPrimType;
          return node.resolvedType;
        } else {
          pushError(
            ctx.errors,
            node,
            `logical not operator requires a bool operand, found ${formatType(operandType)}`,
          );
          node.resolvedType = ErrorType();
          return node.resolvedType;
        }
      } else {
        pushError(ctx.errors, node, `unknown unary operator "${node.op}"`);
        node.resolvedType = ErrorType();
        return node.resolvedType;
      }
    }
    case ASTNodeKind.TEMPLATE_LITERAL: {
      for (const part of node.parts) {
        if (part.kind === "STRING_PART") {
          continue;
        }
        if (part.kind === "EXPR_PART") {
          const exprType = resolveExprType(part.expr, scope, ctx);
          if (
            !(
              (exprType.kind === typeKinds.prim &&
                (exprType.name === primAnnotations.string ||
                  isIntPrim(exprType.name) ||
                  isFloatPrim(exprType.name))) ||
              exprType.kind === typeKinds.untypedInt ||
              exprType.kind === typeKinds.untypedFloat
            )
          ) {
            pushError(
              ctx.errors,
              part.expr,
              `template literal interpolation must be a string, int, or float type, found ${formatType(exprType)}`,
            );
          }
          continue;
        }
        pushError(
          ctx.errors,
          node,
          `unknown template literal part kind "${part.kind}"`,
        );
      }
      node.resolvedType = PrimType(primAnnotations.string);
      return node.resolvedType;
    }
    case ASTNodeKind.ASSIGNMENT: {
      // assignment target is an lvalue node — IDENT today, FIELD_ACCESS once
      // §4(e) / §5(e) of the structs plan land. dispatch on its kind.
      if (node.target.kind === ASTNodeKind.IDENT) {
        const targetName = node.target.name;
        const binding = lookupInScope(scope, targetName);
        if (!binding) {
          pushError(ctx.errors, node, `undefined variable "${targetName}"`);
          node.resolvedType = ErrorType();
          return node.resolvedType;
        }
        if (binding.kind === "const") {
          pushError(ctx.errors, node, `cannot assign to const "${targetName}"`);
          node.resolvedType = ErrorType();
          return node.resolvedType;
        }
        node.target.resolvedType = binding.type;
        const valueType = resolveExprType(node.value, scope, ctx);
        if (!isAssignable(binding.type, valueType)) {
          pushError(
            ctx.errors,
            node,
            `cannot assign ${formatType(valueType)} to ${formatType(binding.type)} in assignment to "${targetName}"`,
          );
        }

        if (
          (valueType.kind === typeKinds.untypedInt &&
            isIntPrim(binding.type.name)) ||
          (valueType.kind === typeKinds.untypedFloat &&
            isFloatPrim(binding.type.name))
        ) {
          if (
            node.value.kind === ASTNodeKind.INT_LITERAL ||
            node.value.kind === ASTNodeKind.FLOAT_LITERAL
          ) {
            coerceLiteralToType(node.value, binding.type, ctx.errors);
          } else {
            node.value.resolvedType = binding.type;
          }
        }

        node.resolvedType = binding.type;
        return node.resolvedType;
      }

      if (node.target.kind === ASTNodeKind.FIELD_ACCESS) {
        // §4(e) — full field-write checking lands with struct registration.
        // for now: typecheck both sides so cascading errors stay quiet, then
        // bail with an explicit unimplemented marker.
        resolveExprType(node.target, scope, ctx);
        resolveExprType(node.value, scope, ctx);
        pushError(
          ctx.errors,
          node,
          `field assignment typecheck not yet implemented (struct support pending)`,
        );
        node.resolvedType = ErrorType();
        return node.resolvedType;
      }

      pushError(ctx.errors, node, `invalid assignment target`);
      node.resolvedType = ErrorType();
      return node.resolvedType;
    }
    case ASTNodeKind.FIELD_ACCESS: {
      const objType = resolveExprType(node.object, scope, ctx);
      if (objType.kind === typeKinds.error) {
        node.resolvedType = ErrorType();
        return node.resolvedType;
      }
      if (objType.kind !== typeKinds.struct) {
        pushError(
          ctx.errors,
          node,
          `field access on non-struct type ${formatType(objType)}`,
        );
        node.resolvedType = ErrorType();
        return node.resolvedType;
      }
      const field = objType.fields?.find((field) => field.name === node.field);
      if (!field) {
        pushError(
          ctx.errors,
          node,
          `type "${objType.name}" has no field "${node.field}"`,
        );
        node.resolvedType = ErrorType();
        return node.resolvedType;
      }
      node.resolvedType = field.type;
      return field.type;
    }
    default: {
      pushError(
        ctx.errors,
        node,
        `typecheck: unhandled expression kind "${node.kind}"`,
      );
      node.resolvedType = ErrorType();
      return node.resolvedType;
    }
  }
}

export function resolveCallType(node, sig, scope, ctx) {
  if (sig.params.length !== node.args.length) {
    pushError(
      ctx.errors,
      node,
      `wrong arg count to "${node.callee}" — expected ${sig.params.length}, got ${node.args.length}`,
    );
    node.resolvedType = sig.returnType;
    return node.resolvedType;
  }

  for (let i = 0; i < node.args.length; i++) {
    const argType = resolveExprType(node.args[i], scope, ctx);
    const paramType = sig.params[i].type;
    if (!isAssignable(paramType, argType)) {
      pushError(
        ctx.errors,
        node.args[i],
        `arg ${i + 1}(${sig.params[i].name}) of "${node.callee}": cannot pass ${formatType(argType)} to ${formatType(paramType)}`,
      );
    }
    // TODO: coerce untyped literals to param type
  }

  node.resolvedType = sig.returnType;
  return node.resolvedType;
}
