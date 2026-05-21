// Pure type-relation helpers: assignability, arithmetic-op unification,
// and untyped-literal coercion (with range checking). No AST walk; these
// are the leaves the rest of the typechecker calls into.

import { ASTNodeKind } from "../contracts.js";
import {
  ErrorType,
  PrimType,
  UntypedFloatType,
  UntypedIntType,
  getBitWidthOfIntPrim,
  isFloatPrim,
  isIntPrim,
  isUnsignedIntPrim,
  primAnnotations,
  typeKinds,
  typesEqual,
} from "./types.js";
import { pushError, formatType } from "./errors.js";

export function isBool(t) {
  return t.kind === typeKinds.prim && t.name === primAnnotations.bool;
}

// True if t is any int-like or float-like type — typed int prims, typed float
// prims, or the "untyped" literal kinds. Used wherever the language accepts
// "any number" (unary minus, template-literal interpolation, etc).
export function isNumeric(t) {
  if (!t) return false;
  if (t.kind === typeKinds.untypedInt) return true;
  if (t.kind === typeKinds.untypedFloat) return true;
  if (t.kind === typeKinds.prim && isIntPrim(t.name)) return true;
  if (t.kind === typeKinds.prim && isFloatPrim(t.name)) return true;
  return false;
}

// When an expression's resolved type is "untyped int/float" but it's being
// used in a position that wants a concrete int/float prim (e.g. `let x: int8 = 1`),
// we either:
//   - range-check + retype the literal node itself (for bare INT/FLOAT_LITERAL), or
//   - just stamp the resolved type onto a compound expression like `1 + 2`
// This is a no-op when no coercion is needed.
export function coerceUntypedLiteralToTyped(
  valueNode,
  valueType,
  targetType,
  errors,
) {
  if (!valueType || !targetType) return;
  if (targetType.kind !== typeKinds.prim) return;

  const wantsInt =
    valueType.kind === typeKinds.untypedInt && isIntPrim(targetType.name);
  const wantsFloat =
    valueType.kind === typeKinds.untypedFloat && isFloatPrim(targetType.name);
  if (!wantsInt && !wantsFloat) return;

  if (
    valueNode.kind === ASTNodeKind.INT_LITERAL ||
    valueNode.kind === ASTNodeKind.FLOAT_LITERAL
  ) {
    coerceLiteralToType(valueNode, targetType, errors);
  } else {
    valueNode.resolvedType = targetType;
  }
}

// is source type assignable to destination type?
export function isAssignable(dest, src) {
  if (!dest || !src) {
    return false;
  }
  if (typesEqual(dest, src)) {
    return true;
  }
  // if either is an error type, suppress cascading errors — the real error
  // was reported at the source of the error type, and propagating beyond
  // that obscures which spot the user needs to fix.
  if (dest.kind === typeKinds.error || src.kind === typeKinds.error) {
    return true;
  }

  if (
    src.kind === typeKinds.untypedInt &&
    dest.kind === typeKinds.prim &&
    isIntPrim(dest.name)
  ) {
    return true;
  }

  if (
    src.kind === typeKinds.untypedFloat &&
    dest.kind === typeKinds.prim &&
    isFloatPrim(dest.name)
  ) {
    return true;
  }

  return false;
}

// todo clear up and simplify this logic...
export function unifyArith(left, right, op) {
  if (!left || !right) return null;
  if (left.kind === typeKinds.error || right.kind === typeKinds.error)
    return ErrorType();

  const isCmp = ["eqeq", "neq", "lt", "gt", "lte", "gte"].includes(op);
  const isLogical = op === "andand" || op === "oror";
  const isBitwise = op === "pipe";

  if (isLogical) {
    if (isBool(left) && isBool(right)) return PrimType("bool");
    return null;
  }

  if (isBitwise) {
    // Both operands must be integer (typed or untyped). No floats, no bools.
    const isIntish = (t) =>
      t.kind === typeKinds.untypedInt ||
      (t.kind === typeKinds.prim && isIntPrim(t.name));
    if (!isIntish(left) || !isIntish(right)) return null;
    if (left.kind === typeKinds.untypedInt && right.kind === typeKinds.untypedInt) {
      return UntypedIntType();
    }
    if (left.kind === typeKinds.untypedInt) return right;
    if (right.kind === typeKinds.untypedInt) return left;
    if (typesEqual(left, right)) return left;
    return null;
  }

  // both untyped -> stay untyped (pinned later at a typed context)
  if (
    left.kind === typeKinds.untypedInt &&
    right.kind === typeKinds.untypedInt
  ) {
    return isCmp ? PrimType(primAnnotations.bool) : UntypedIntType();
  }
  if (
    left.kind === typeKinds.untypedFloat &&
    right.kind === typeKinds.untypedFloat
  ) {
    return isCmp ? PrimType(primAnnotations.bool) : UntypedFloatType();
  }

  // one untyped, one typed -> typed wins (caller coerces the literal)
  const typed =
    left.kind === typeKinds.prim
      ? left
      : right.kind === typeKinds.prim
        ? right
        : null;
  const untyped = left.kind.startsWith("untyped")
    ? left
    : right.kind.startsWith("untyped")
      ? right
      : null;
  if (typed && untyped) {
    if (untyped.kind === typeKinds.untypedInt && isIntPrim(typed.name))
      return isCmp ? PrimType(primAnnotations.bool) : typed;
    if (untyped.kind === typeKinds.untypedFloat && isFloatPrim(typed.name))
      return isCmp ? PrimType(primAnnotations.bool) : typed;
    return null;
  }

  // both typed -> must match exactly (no widening yet)
  if (typesEqual(left, right)) {
    if (left.kind !== typeKinds.prim) return null;
    if (!(isIntPrim(left.name) || isFloatPrim(left.name))) return null;
    return isCmp ? PrimType(primAnnotations.bool) : left;
  }

  return null;
}

export function coerceLiteralToType(literalNode, targetType, errors) {
  if (literalNode.kind === ASTNodeKind.INT_LITERAL) {
    if (!isIntPrim(targetType.name)) {
      pushError(
        errors,
        literalNode,
        `cannot coerce untyped int to non-int type ${formatType(targetType)}`,
      );
      return;
    }
    const value = literalNode.value;
    const bitSize = getBitWidthOfIntPrim(targetType.name);
    const isUnsigned = isUnsignedIntPrim(targetType.name);
    const min = isUnsigned ? 0 : -(2 ** (bitSize - 1));
    const max = isUnsigned ? 2 ** bitSize - 1 : 2 ** (bitSize - 1) - 1;
    if (value < min || value > max) {
      pushError(
        errors,
        literalNode,
        `integer literal ${value} out of range for type ${formatType(targetType)} (must be between ${min} and ${max})`,
      );
      return;
    }
    literalNode.resolvedType = targetType;
  } else if (literalNode.kind === ASTNodeKind.FLOAT_LITERAL) {
    if (!isFloatPrim(targetType.name)) {
      pushError(
        errors,
        literalNode,
        `cannot coerce untyped float to non-float type ${formatType(targetType)}`,
      );
      return;
    }
    // accepts anything finite that JS can represent (64-bit IEEE 754).
    const value = literalNode.value;
    if (typeof value !== "number" || !isFinite(value)) {
      pushError(errors, literalNode, `invalid float literal ${value}`);
      return;
    }
    literalNode.resolvedType = targetType;
  } else {
    pushError(
      errors,
      literalNode,
      `can only coerce untyped literals, found ${literalNode.kind}`,
    );
  }
}
