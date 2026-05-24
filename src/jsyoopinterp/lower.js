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
// `bool` always picks the `int` slot (logical/bool ops have a
// single opcode form that doesn't differ between int and float
// because the result is a bool either way).
const BIN_OP_MAP = {
  plus:    { int: OP.IADD,    float: OP.FADD },
  minus:   { int: OP.ISUB,    float: OP.FSUB },
  mult:    { int: OP.IMUL,    float: OP.FMUL },
  divide:  { int: OP.IDIV,    float: OP.FDIV },
  modulus: { int: OP.IREM,    float: null    },
  eqeq:    { int: OP.ICMP_EQ, float: OP.FCMP_EQ },
  neq:     { int: OP.ICMP_NE, float: OP.FCMP_NE },
  lt:      { int: OP.ICMP_LT, float: OP.FCMP_LT },
  lte:     { int: OP.ICMP_LE, float: OP.FCMP_LE },
  gt:      { int: OP.ICMP_GT, float: OP.FCMP_GT },
  gte:     { int: OP.ICMP_GE, float: OP.FCMP_GE },
  andand:  { int: OP.LAND,    float: null    }, // bool-typed both sides
  oror:    { int: OP.LOR,     float: null    },
  amp:     { int: OP.BIT_AND, float: null    },
  pipe:    { int: OP.BIT_OR,  float: null    },
  caret:   { int: OP.BIT_XOR, float: null    },
  lshift:  { int: OP.SHL,     float: null    },
  rshift:  { int: OP.SHR,     float: null    },
};

// Container we build up while lowering one logical "function" (in
// 11.B.0 always a synthesized wrapper around a single expression).
//
// `moduleConsts` is an optional Map<name, wrappedValue> the comptime
// pass threads through when lowering one module-init expression that
// might reference an earlier (already-folded) module-level const. An
// IDENT whose name is in the map lowers to a LITERAL of the referenced
// value; an IDENT not in the map (function reference, unfolded
// binding, anything cross-module) is an unsupported-comptime fallback.
class LowerCtx {
  constructor(fnName, sourceLoc, moduleConsts) {
    this.fnName = fnName;
    this.sourceLoc = sourceLoc;
    this.instructions = [];
    this.registerTypes = [];
    this.moduleConsts = moduleConsts ?? new Map();
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
    opts.moduleConsts,
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

    case ASTNodeKind.BOOL_LITERAL: {
      const ty = node.resolvedType;
      const dst = ctx.allocReg(ty);
      ctx.emit(
        instruction(OP.LITERAL, {
          dst,
          type: ty,
          immediate: { ty, v: !!node.value },
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.STRING_LITERAL: {
      // The parser stores STRING_LITERAL.value INCLUDING the surrounding
      // double-quotes; strip them here. Escape-sequence decoding happens
      // later when the interpreter formats the value or codegen emits the
      // bytes — at the comptime layer we keep the raw inner content.
      const ty = node.resolvedType;
      const raw = String(node.value);
      const inner =
        raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"'
          ? raw.slice(1, -1)
          : raw;
      const dst = ctx.allocReg(ty);
      ctx.emit(
        instruction(OP.LITERAL, {
          dst,
          type: ty,
          immediate: { ty, v: inner },
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

    case ASTNodeKind.FIELD_ACCESS: {
      // `arr.len` desugars at typecheck time but reaches lowering as
      // FIELD_ACCESS over an array-typed receiver. Detect that and
      // emit ARRAY_LEN; everything else is a real struct field read.
      const receiverReg = lowerExpr(node.object, ctx);
      const receiverTy = ctx.registerTypes[receiverReg];
      if (receiverTy.kind === typeKinds.array && node.field === "len") {
        const dst = ctx.allocReg(node.resolvedType);
        ctx.emit(
          instruction(OP.ARRAY_LEN, {
            dst,
            args: [receiverReg],
            type: node.resolvedType,
            sourceLoc: node.sourceLoc,
          }),
        );
        return dst;
      }
      const dst = ctx.allocReg(node.resolvedType);
      ctx.emit(
        instruction(OP.FIELD_LOAD, {
          dst,
          args: [receiverReg],
          type: node.resolvedType,
          immediate: node.field,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.INDEX_EXPRESSION: {
      const arrReg = lowerExpr(node.object, ctx);
      const idxReg = lowerExpr(node.index, ctx);
      const dst = ctx.allocReg(node.resolvedType);
      ctx.emit(
        instruction(OP.INDEX_LOAD, {
          dst,
          args: [arrReg, idxReg],
          type: node.resolvedType,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.IDENT: {
      // Resolve against the module-const table threaded in via
      // LowerCtx. Hit → emit a LITERAL with the previously-folded
      // value. Miss → unsupported (function reference, unfolded
      // binding, cross-module reference); fall back through the
      // silent module-init fallback path.
      const folded = ctx.moduleConsts.get(node.name);
      if (folded == null) {
        throw new ComptimeError(
          `comptime: identifier '${node.name}' is not a comptime-known constant in this scope`,
          node.sourceLoc,
        );
      }
      const dst = ctx.allocReg(folded.ty);
      ctx.emit(
        instruction(OP.LITERAL, {
          dst,
          type: folded.ty,
          immediate: folded,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.ARRAY_LITERAL: {
      const arrType = node.resolvedType;
      if (arrType?.kind !== typeKinds.array) {
        throw new ComptimeError(
          `comptime: array literal without a resolved ArrayType — typechecker bug?`,
          node.sourceLoc,
        );
      }
      const elemRegs = (node.elements ?? []).map((e) => lowerExpr(e, ctx));
      const dst = ctx.allocReg(arrType);
      ctx.emit(
        instruction(OP.ARRAY_CONSTRUCT, {
          dst,
          args: elemRegs,
          type: arrType,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.STRUCT_LITERAL: {
      const structType = node.resolvedType;
      if (structType?.kind !== typeKinds.struct) {
        throw new ComptimeError(
          `comptime: struct literal without a resolved StructType — typechecker bug?`,
          node.sourceLoc,
        );
      }
      // Normalize source-order fields to declared-order. The
      // typechecker has already validated the literal matches the
      // type's field set; here we just look each up by name.
      const fieldByName = new Map();
      for (const f of node.fields) fieldByName.set(f.name, f);
      const orderedRegs = [];
      const orderedNames = [];
      for (const declared of structType.fields ?? []) {
        const litField = fieldByName.get(declared.name);
        if (!litField) {
          // Should not happen for a typechecked literal, but guard so
          // we surface the inconsistency as a comptime fallback rather
          // than a JS crash.
          throw new ComptimeError(
            `comptime: struct literal missing field "${declared.name}" (typechecker should have caught this)`,
            node.sourceLoc,
          );
        }
        orderedRegs.push(lowerExpr(litField.value, ctx));
        orderedNames.push(declared.name);
      }
      const dst = ctx.allocReg(structType);
      ctx.emit(
        instruction(OP.STRUCT_CONSTRUCT, {
          dst,
          args: orderedRegs,
          type: structType,
          immediate: orderedNames,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.UNARY_EXPRESSION: {
      const reg = lowerExpr(node.operand, ctx);
      const ty = ctx.registerTypes[reg];
      const useFloat = ty.kind === typeKinds.prim && isFloatPrim(ty.name);
      let op;
      switch (node.op) {
        case "minus":
          op = useFloat ? OP.FNEG : OP.INEG;
          break;
        case "not":
          op = OP.LNOT;
          break;
        case "bitnot":
          op = OP.BIT_NOT;
          break;
        default:
          throw new ComptimeError(
            `comptime: unary operator '${node.op}' is not supported yet`,
            node.sourceLoc,
          );
      }
      const dst = ctx.allocReg(node.resolvedType);
      ctx.emit(
        instruction(op, {
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
