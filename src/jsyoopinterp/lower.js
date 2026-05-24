// Phase 11.B.0: typed bytecode lowering for the minimum slice —
// integer/float literals and arithmetic binary operators, wrapped in a
// synthesized `return <expr>` function so the interpreter has a real
// function to evaluate.
//
// Later sub-phases extend the per-node dispatcher with control flow,
// memory ops, calls, structs/arrays/refs, enums, tasks, and kind-flow
// cleanups. The dispatcher's shape is intentionally similar to
// `emitExpr` in codegen.js so future maintenance can read both in
// parallel.

import { ASTNodeKind } from "../contracts.js";
import { typeKinds, isFloatPrim } from "../jsyooptypecheck/types.js";
import { OP, instruction, bytecodeFunction } from "./bytecode.js";
import { ComptimeError } from "./diagnostics.js";
import { coerceNumeric } from "./values.js";

// Map parser BINARY_EXPRESSION `.op` strings (the inverse-token-tag
// names) onto opcode pairs (int variant, float variant). The variant
// chosen depends on the operand types resolved by the typechecker.
const BIN_OP_MAP = {
  plus:    { int: OP.IADD, float: OP.FADD },
  minus:   { int: OP.ISUB, float: OP.FSUB },
  mult:    { int: OP.IMUL, float: OP.FMUL },
  divide:  { int: OP.IDIV, float: OP.FDIV },
  modulus: { int: OP.IREM, float: null },
};

// Container we build up while lowering one logical "function" (in
// 11.B.0 always a synthesized wrapper around a single expression).
class LowerCtx {
  constructor(fnName, sourceLoc) {
    this.fnName = fnName;
    this.sourceLoc = sourceLoc;
    this.instructions = [];
    this.registerTypes = [];
  }
  allocReg(ty) {
    this.registerTypes.push(ty);
    return this.registerTypes.length - 1;
  }
  emit(inst) {
    this.instructions.push(inst);
  }
}

// Lower a single typecheck-validated expression into a BytecodeFunction
// whose body is `return <expr>`. Returns the function, or throws
// ComptimeError if the expression contains an unsupported node kind
// for this sub-phase.
export function lowerExpressionAsFunction(exprAst, returnType, opts = {}) {
  const ctx = new LowerCtx(
    opts.fnName ?? "<comptime-fold>",
    exprAst.sourceLoc ?? null,
  );
  const resultReg = lowerExpr(exprAst, ctx);
  ctx.emit(
    instruction(OP.RET, {
      args: [resultReg],
      type: ctx.registerTypes[resultReg],
      sourceLoc: exprAst.sourceLoc,
    }),
  );
  return bytecodeFunction({
    name: ctx.fnName,
    params: [],
    returnType,
    registerTypes: ctx.registerTypes,
    instructions: ctx.instructions,
    sourceLoc: ctx.sourceLoc,
  });
}

// Walk one expression node, append the instructions needed to produce
// its result, and return the register holding that result.
function lowerExpr(node, ctx) {
  switch (node.kind) {
    case ASTNodeKind.INT_LITERAL: {
      const ty = node.resolvedType;
      // Coerce via the same width-aware path the interpreter uses so
      // narrower-than-32-bit literals stay correctly truncated.
      const v = coerceNumeric(ty, node.value);
      const dst = ctx.allocReg(ty);
      ctx.emit(
        instruction(OP.LITERAL, {
          dst,
          type: ty,
          immediate: { ty, v },
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.FLOAT_LITERAL: {
      const ty = node.resolvedType;
      const dst = ctx.allocReg(ty);
      ctx.emit(
        instruction(OP.LITERAL, {
          dst,
          type: ty,
          immediate: { ty, v: Number(node.value) },
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.BINARY_EXPRESSION: {
      const opName = node.op;
      const opPair = BIN_OP_MAP[opName];
      if (!opPair) {
        throw new ComptimeError(
          `comptime: binary operator '${opName}' is not supported yet (lands in a later 11.B sub-phase)`,
          node.sourceLoc,
        );
      }
      const lhsReg = lowerExpr(node.left, ctx);
      const rhsReg = lowerExpr(node.right, ctx);
      const lhsTy = ctx.registerTypes[lhsReg];
      const useFloat =
        lhsTy.kind === typeKinds.prim && isFloatPrim(lhsTy.name);
      const op = useFloat ? opPair.float : opPair.int;
      if (op == null) {
        throw new ComptimeError(
          `comptime: operator '${opName}' is not defined for ${lhsTy.kind === typeKinds.prim ? lhsTy.name : "non-primitive"} types`,
          node.sourceLoc,
        );
      }
      const dst = ctx.allocReg(node.resolvedType);
      ctx.emit(
        instruction(op, {
          dst,
          args: [lhsReg, rhsReg],
          type: node.resolvedType,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.UNARY_EXPRESSION: {
      if (node.op !== "minus") {
        throw new ComptimeError(
          `comptime: unary operator '${node.op}' is not supported yet`,
          node.sourceLoc,
        );
      }
      const reg = lowerExpr(node.operand, ctx);
      const ty = ctx.registerTypes[reg];
      const useFloat = ty.kind === typeKinds.prim && isFloatPrim(ty.name);
      const dst = ctx.allocReg(node.resolvedType);
      ctx.emit(
        instruction(useFloat ? OP.FNEG : OP.INEG, {
          dst,
          args: [reg],
          type: node.resolvedType,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    default:
      throw new ComptimeError(
        `comptime: AST node kind '${node.kind}' is not supported yet`,
        node.sourceLoc,
      );
  }
}
