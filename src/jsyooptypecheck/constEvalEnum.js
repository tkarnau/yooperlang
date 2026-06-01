// Phase 12: const-evaluator for value-enum variant body expressions.
//
// Accepts a restricted subset of yoop expressions:
//   - INT_LITERAL (any base; with unary minus for negative literals)
//   - STRING_LITERAL (only for `enum<string>`)
//   - IDENT - must reference a prior case in the same enum
//   - BINARY_EXPRESSION with op in `|`, `&`, `^`, `<<`, `>>` (integer only)
//   - UNARY_EXPRESSION with op `~` (integer only) or `-` on integer literal
//   - parenthesized expression (no special AST node - parser handles it)
//
// Returns `{ value: number | bigint | string, usedOperator: boolean }` or
// pushes an error and returns `{ value: 0, usedOperator: false }`.
//
// `usedOperator` flips true the moment any operator (binary or unary `~`)
// appears anywhere in the expression. The enum's `isOpen` flag is set when
// any case's expression had `usedOperator === true`. Open enums lose
// exhaustiveness in `switch`.

import { ASTNodeKind } from "../contracts.js";
import {
  isSignedIntPrim,
  isUnsignedIntPrim,
  isIntPrim,
  getBitWidthOfIntPrim,
} from "./types.js";
import { pushError } from "./errors.js";

// Returns true when bigint v fits in the underlying prim's range.
function fitsUnderlying(v, underlyingName) {
  const w = getBitWidthOfIntPrim(underlyingName);
  if (isUnsignedIntPrim(underlyingName)) {
    if (v < 0n) return false;
    const max = (1n << BigInt(w)) - 1n;
    return v <= max;
  }
  // signed
  const min = -(1n << BigInt(w - 1));
  const max = (1n << BigInt(w - 1)) - 1n;
  return v >= min && v <= max;
}

// Mask to the underlying width. For signed types, sign-extend after masking
// so `~A` and shift semantics behave like the underlying primitive.
function normalize(v, underlyingName) {
  const w = getBitWidthOfIntPrim(underlyingName);
  const mask = (1n << BigInt(w)) - 1n;
  const masked = v & mask;
  if (isUnsignedIntPrim(underlyingName)) return masked;
  // sign-extend
  const signBit = 1n << BigInt(w - 1);
  if (masked & signBit) return masked - (1n << BigInt(w));
  return masked;
}

// Evaluate a parsed value expression. `ctx` carries:
//   - underlying: PrimType — the enum's underlying type
//   - priorCases: Map<name, bigint|string> — prior cases in declaration order
//   - errors: error sink
//   - enumName, caseName — for error messages
//   - srcLoc — anchor for diagnostics on the case
export function evalEnumValueExpr(expr, ctx) {
  const isStringUnderlying = ctx.underlying.name === "string";

  if (isStringUnderlying) {
    if (expr.kind !== ASTNodeKind.STRING_LITERAL) {
      pushError(
        ctx.errors,
        expr,
        `string-backed enum '${ctx.enumName}' case '${ctx.caseName}' must use a string literal value`,
      );
      return { value: "", usedOperator: false };
    }
    // The parser stores STRING_LITERAL.value with the surrounding quotes;
    // strip them so downstream consumers can use the raw string directly.
    const raw = typeof expr.value === "string" && expr.value.length >= 2
      ? expr.value.slice(1, -1)
      : expr.value;
    return { value: raw, usedOperator: false };
  }

  // Integer underlying.
  if (!isIntPrim(ctx.underlying.name)) {
    pushError(
      ctx.errors,
      expr,
      `enum '${ctx.enumName}' has unsupported underlying type '${ctx.underlying.name}' (must be int8..int64, uint8..uint64, or string)`,
    );
    return { value: 0n, usedOperator: false };
  }

  const r = evalInt(expr, ctx);
  if (!fitsUnderlying(r.value, ctx.underlying.name)) {
    pushError(
      ctx.errors,
      expr,
      `value ${r.value} for case '${ctx.caseName}' does not fit in ${ctx.underlying.name}`,
    );
    return { value: 0n, usedOperator: r.usedOperator };
  }
  return { value: normalize(r.value, ctx.underlying.name), usedOperator: r.usedOperator };
}

function evalInt(expr, ctx) {
  switch (expr.kind) {
    case ASTNodeKind.INT_LITERAL:
      return { value: BigInt(expr.value), usedOperator: false };
    case ASTNodeKind.STRING_LITERAL:
      pushError(
        ctx.errors,
        expr,
        `string literal in integer-backed enum '${ctx.enumName}' case '${ctx.caseName}'`,
      );
      return { value: 0n, usedOperator: false };
    case ASTNodeKind.IDENT: {
      const prior = ctx.priorCases.get(expr.name);
      if (prior === undefined) {
        pushError(
          ctx.errors,
          expr,
          `identifier '${expr.name}' in case '${ctx.caseName}' does not name a prior case of enum '${ctx.enumName}'`,
        );
        return { value: 0n, usedOperator: false };
      }
      if (typeof prior !== "bigint") {
        pushError(ctx.errors, expr, `internal: prior case value is not a bigint`);
        return { value: 0n, usedOperator: false };
      }
      return { value: prior, usedOperator: false };
    }
    case ASTNodeKind.UNARY_EXPRESSION: {
      const inner = evalInt(expr.operand, ctx);
      switch (expr.op) {
        case "bitnot": {
          const w = getBitWidthOfIntPrim(ctx.underlying.name);
          const mask = (1n << BigInt(w)) - 1n;
          return { value: (~inner.value) & mask, usedOperator: true };
        }
        case "minus":
          return { value: -inner.value, usedOperator: inner.usedOperator };
        default:
          pushError(
            ctx.errors,
            expr,
            `unary operator '${expr.op}' not allowed in enum case value`,
          );
          return { value: 0n, usedOperator: inner.usedOperator };
      }
    }
    case ASTNodeKind.BINARY_EXPRESSION: {
      const l = evalInt(expr.left, ctx);
      const r = evalInt(expr.right, ctx);
      const used = true;
      const w = getBitWidthOfIntPrim(ctx.underlying.name);
      const mask = (1n << BigInt(w)) - 1n;
      switch (expr.op) {
        case "pipe":
          return { value: (l.value | r.value) & mask, usedOperator: used };
        case "amp":
          return { value: (l.value & r.value) & mask, usedOperator: used };
        case "caret":
          return { value: (l.value ^ r.value) & mask, usedOperator: used };
        case "lshift":
          if (r.value < 0n || r.value >= BigInt(w)) {
            pushError(
              ctx.errors,
              expr,
              `shift amount ${r.value} out of range for ${ctx.underlying.name} (must be 0..${w - 1})`,
            );
            return { value: 0n, usedOperator: used };
          }
          return { value: (l.value << r.value) & mask, usedOperator: used };
        case "rshift":
          if (r.value < 0n || r.value >= BigInt(w)) {
            pushError(
              ctx.errors,
              expr,
              `shift amount ${r.value} out of range for ${ctx.underlying.name} (must be 0..${w - 1})`,
            );
            return { value: 0n, usedOperator: used };
          }
          return { value: (l.value >> r.value) & mask, usedOperator: used };
        default:
          pushError(
            ctx.errors,
            expr,
            `binary operator '${expr.op}' not allowed in enum case value (only | & ^ << >>)`,
          );
          return { value: 0n, usedOperator: used };
      }
    }
    default:
      pushError(
        ctx.errors,
        expr,
        `unsupported expression form in enum case value (kind: ${expr.kind})`,
      );
      return { value: 0n, usedOperator: false };
  }
}

// Marker for "no value expression - auto-number from prior". Pass A walks
// cases in order: if `valueExpr` is null, the value is `prior + 1` (or 0 if
// first). For `enum<string>`, every case must have an explicit value.
export function autoIncrementValue(prior, underlying, errors, caseNode) {
  if (underlying.name === "string") {
    pushError(
      errors,
      caseNode,
      `string-backed enum case '${caseNode.name}' requires an explicit string value`,
    );
    return "";
  }
  if (prior === null) return 0n;
  if (typeof prior !== "bigint") {
    pushError(errors, caseNode, `internal: prior value is not a bigint`);
    return 0n;
  }
  return prior + 1n;
}
