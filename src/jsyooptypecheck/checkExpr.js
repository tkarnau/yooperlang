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
  resolveTypeFromName,
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
        const boolPrimType = resolveTypeFromName(
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
                  exprType.name === primAnnotations.bool ||
                  isIntPrim(exprType.name) ||
                  isFloatPrim(exprType.name))) ||
              exprType.kind === typeKinds.untypedInt ||
              exprType.kind === typeKinds.untypedFloat
            )
          ) {
            pushError(
              ctx.errors,
              part.expr,
              `template literal interpolation must be a string, bool, int, or float type, found ${formatType(exprType)}`,
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
        const targetType = resolveExprType(node.target, scope, ctx);
        if (targetType.kind === typeKinds.error) {
          node.resolvedType = ErrorType();
          return node.resolvedType;
        }
        const rootIdent = rootIdentOf(node.target);
        if (!rootIdent) {
          pushError(
            ctx.errors,
            node,
            `invalid assignment target — root of field chain is not an identifier`,
          );
          node.resolvedType = ErrorType();
          return node.resolvedType;
        }
        const rootBinding = lookupInScope(scope, rootIdent.name);
        if (rootBinding && rootBinding.kind === "const") {
          pushError(
            ctx.errors,
            node,
            `cannot assign to field of const "${rootIdent.name}"`,
          );
          node.resolvedType = ErrorType();
          return node.resolvedType;
        }

        if (node.value.kind === ASTNodeKind.STRUCT_LITERAL) {
          pinStructLiteral(node.value, targetType, scope, ctx);
        } else {
          const valueType = resolveExprType(node.value, scope, ctx);
          if (!isAssignable(targetType, valueType)) {
            pushError(
              ctx.errors,
              node,
              `cannot assign ${formatType(valueType)} to ${formatType(targetType)} in field assignment`,
            );
          }
          if (
            (valueType.kind === typeKinds.untypedInt &&
              isIntPrim(targetType.name)) ||
            (valueType.kind === typeKinds.untypedFloat &&
              isFloatPrim(targetType.name))
          ) {
            if (
              node.value.kind === ASTNodeKind.INT_LITERAL ||
              node.value.kind === ASTNodeKind.FLOAT_LITERAL
            ) {
              coerceLiteralToType(node.value, targetType, ctx.errors);
            } else {
              node.value.resolvedType = targetType;
            }
          }
        }
        node.resolvedType = targetType;
        return node.resolvedType;
      }
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
    case ASTNodeKind.STRUCT_LITERAL: {
      // recurse through each field's value and set to error, since no caller has pinned it
      for (const field of node.fields) {
        resolveExprType(field.value, scope, ctx);
        field.value.resolvedType = ErrorType();
        pushError(
          ctx.errors,
          field.value,
          `struct literal has no target type`,
        );
      }
      node.resolvedType = ErrorType();
      return node.resolvedType;
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

function rootIdentOf(node) {
  while (node.kind === ASTNodeKind.FIELD_ACCESS) {
    node = node.object;
  }
  if (node.kind === ASTNodeKind.IDENT) {
    return node;
  }
  return null;
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
    if (sig.params[i].type.kind === typeKinds.struct && node.args[i].kind === ASTNodeKind.STRUCT_LITERAL) {
      pinStructLiteral(node.args[i], sig.params[i].type, ctx.typeContext.structTable, ctx);
    } else {
      const argType = resolveExprType(node.args[i], scope, ctx);
      const paramType = sig.params[i].type;
      if (!isAssignable(paramType, argType)) {
        pushError(
          ctx.errors,
          node.args[i],
          `arg ${i + 1}(${sig.params[i].name}) of "${node.callee}": cannot pass ${formatType(argType)} to ${formatType(paramType)}`,
        );
      }
    }
    // TODO: coerce untyped literals to param type
  }

  node.resolvedType = sig.returnType;
  return node.resolvedType;
}

export function pinStructLiteral(litNode, targetType, scope, ctx) {
  // reject if targetType is not a struct, otherwise resolveExprType will have
  // nothing to unify against and will just set the literal's field types to error
  if (targetType.kind !== typeKinds.struct) {
    pushError(
      ctx.errors,
      litNode,
      `cannot pin struct literal to non-struct type ${formatType(targetType)}`,
    );
    return;
  }
  // now walk the literal's fields once into a map of name -> declared field type
  const targetFieldMap = new Map();
  for (const targetField of targetType.fields ?? []) {
    targetFieldMap.set(targetField.name, targetField.type);
  }
  const seen = new Set();
  for (const field of litNode.fields) {
    if (seen.has(field.name)) {
      pushError(
        ctx.errors,
        field,
        `duplicate field "${field.name}" in struct literal for "${targetType.name}"`,
      );
      continue;
    }
    seen.add(field.name);
    const expectedType = targetFieldMap.get(field.name);
    if (!expectedType) {
      pushError(
        ctx.errors,
        field,
        `type "${targetType.name}" has no field "${field.name}"`,
      );
      // still walk the value so nested errors surface
      if (field.value.kind !== ASTNodeKind.STRUCT_LITERAL) {
        resolveExprType(field.value, scope, ctx);
      }
      continue;
    }
    // nested struct literal: pin it directly. resolveExprType on a STRUCT_LITERAL
    // would treat it as unpinned and emit a spurious "no target type" error.
    if (field.value.kind === ASTNodeKind.STRUCT_LITERAL) {
      pinStructLiteral(field.value, expectedType, scope, ctx);
      continue;
    }
    const actualType = resolveExprType(field.value, scope, ctx);
    if (!isAssignable(expectedType, actualType)) {
      pushError(
        ctx.errors,
        field.value,
        `cannot assign ${formatType(actualType)} to field "${field.name}" of type ${formatType(expectedType)} in struct literal for "${targetType.name}"`,
      );
    }
    if (
      (expectedType.kind === typeKinds.prim &&
        isIntPrim(expectedType.name) &&
        actualType.kind === typeKinds.untypedInt) ||
      (expectedType.kind === typeKinds.prim &&
        isFloatPrim(expectedType.name) &&
        actualType.kind === typeKinds.untypedFloat)
    ) {
      if (
        field.value.kind === ASTNodeKind.INT_LITERAL ||
        field.value.kind === ASTNodeKind.FLOAT_LITERAL
      ) {
        coerceLiteralToType(field.value, expectedType, ctx.errors);
      } else {
        field.value.resolvedType = expectedType;
      }
    }
  }
  // if any expected fields are missing from the literal, complain and set the literal's type to error so downstream field accesses don't cascade
  for (const targetField of targetType.fields ?? []) {
    if (!litNode.fields.some((f) => f.name === targetField.name)) {
      pushError(
        ctx.errors,
        litNode,
        `missing field "${targetField.name}" in struct literal for "${targetType.name}"`,
      );
    }
  }
  // if all fields are present and accounted for, set the literal's resolved type to the target struct type
  litNode.resolvedType = targetType;
}