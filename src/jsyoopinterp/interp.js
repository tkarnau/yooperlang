// Phase 11.B.0: minimal bytecode interpreter.
//
// Drives a single `BytecodeFunction` end-to-end and returns its wrapped
// result. The instruction set covered today is the arithmetic-only
// slice from `bytecode.js` (literal, integer + float arithmetic, ret).
// Each later sub-phase extends the dispatch table.
//
// Frame stack: the evaluator owns an explicit JS-array of frames
// rather than recursing into JS, so deep comptime call chains don't
// overflow the host stack. The 11.B.0 slice has no calls, but the
// machinery is in place so adding `call_direct` in a later sub-phase
// is a one-spot change.

import { OP } from "./bytecode.js";
import { ComptimeError } from "./diagnostics.js";
import { coerceNumeric, usesBigInt } from "./values.js";
import { typeKinds } from "../jsyooptypecheck/types.js";

const MAX_FRAMES = 1024;

// Frame holds one in-flight function's state.
function makeFrame(fn) {
  return {
    fn,
    ip: 0,
    registers: new Array(fn.registerTypes.length).fill(null),
  };
}

// `evaluate(fn) → wrappedValue`. Throws ComptimeError on failure.
// Currently the function takes no arguments; later sub-phases will
// accept positional args via `evaluate(fn, args)`.
export function evaluate(fn) {
  const stack = [makeFrame(fn)];
  // Result of the innermost ret. Used to bubble back to the top frame
  // when call_direct lands.
  let pendingResult = null;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.ip >= frame.fn.instructions.length) {
      throw new ComptimeError(
        `comptime: function '${frame.fn.name}' fell off the end without a ret`,
        frame.fn.sourceLoc,
      );
    }
    const inst = frame.fn.instructions[frame.ip++];

    switch (inst.op) {
      case OP.LITERAL: {
        frame.registers[inst.dst] = inst.immediate;
        break;
      }

      case OP.IADD:
      case OP.ISUB:
      case OP.IMUL:
      case OP.IDIV:
      case OP.IREM: {
        const lhs = frame.registers[inst.args[0]];
        const rhs = frame.registers[inst.args[1]];
        const result = intArith(inst.op, lhs, rhs, inst);
        frame.registers[inst.dst] = { ty: inst.type, v: coerceNumeric(inst.type, result) };
        break;
      }

      case OP.INEG: {
        const v = frame.registers[inst.args[0]].v;
        const neg = typeof v === "bigint" ? -v : -v;
        frame.registers[inst.dst] = { ty: inst.type, v: coerceNumeric(inst.type, neg) };
        break;
      }

      case OP.FADD:
      case OP.FSUB:
      case OP.FMUL:
      case OP.FDIV: {
        const lhs = frame.registers[inst.args[0]].v;
        const rhs = frame.registers[inst.args[1]].v;
        let result;
        switch (inst.op) {
          case OP.FADD: result = lhs + rhs; break;
          case OP.FSUB: result = lhs - rhs; break;
          case OP.FMUL: result = lhs * rhs; break;
          case OP.FDIV: result = lhs / rhs; break;
        }
        frame.registers[inst.dst] = { ty: inst.type, v: result };
        break;
      }

      case OP.FNEG: {
        const v = frame.registers[inst.args[0]].v;
        frame.registers[inst.dst] = { ty: inst.type, v: -v };
        break;
      }

      case OP.RET: {
        pendingResult = inst.args.length > 0 ? frame.registers[inst.args[0]] : null;
        stack.pop();
        if (stack.length === 0) return pendingResult;
        // Caller will pick this up once call_direct lands.
        break;
      }

      default:
        throw new ComptimeError(
          `comptime: unsupported opcode '${inst.op}'`,
          inst.sourceLoc,
        );
    }

    if (stack.length > MAX_FRAMES) {
      throw new ComptimeError(
        `comptime: frame stack depth exceeded ${MAX_FRAMES} — likely runaway recursion`,
        inst.sourceLoc,
      );
    }
  }

  return pendingResult;
}

// Integer arithmetic shared between IADD/ISUB/IMUL/IDIV/IREM.
// Handles both JS-number-backed primitives (≤32-bit) and BigInt-backed
// primitives (64-bit and wider). The result is returned as a raw JS
// value; the caller calls coerceNumeric to truncate / sign-extend
// according to the destination type.
function intArith(op, lhs, rhs, inst) {
  const lty = lhs.ty;
  const lv = lhs.v;
  const rv = rhs.v;
  // Determine which arithmetic path: BigInt if either operand is one
  // OR if the destination is 64-bit+.
  const wantBig =
    typeof lv === "bigint" ||
    typeof rv === "bigint" ||
    (lty.kind === typeKinds.prim && usesBigInt(lty.name)) ||
    (inst.type?.kind === typeKinds.prim && usesBigInt(inst.type.name));
  if (wantBig) {
    const a = typeof lv === "bigint" ? lv : BigInt(lv);
    const b = typeof rv === "bigint" ? rv : BigInt(rv);
    switch (op) {
      case OP.IADD: return a + b;
      case OP.ISUB: return a - b;
      case OP.IMUL: return a * b;
      case OP.IDIV:
        if (b === 0n) {
          throw new ComptimeError(`comptime: integer divide by zero`, inst.sourceLoc);
        }
        return a / b;
      case OP.IREM:
        if (b === 0n) {
          throw new ComptimeError(`comptime: integer modulo by zero`, inst.sourceLoc);
        }
        return a % b;
    }
  } else {
    const a = lv | 0;
    const b = rv | 0;
    switch (op) {
      case OP.IADD: return a + b;
      case OP.ISUB: return a - b;
      case OP.IMUL: return Math.imul(a, b);
      case OP.IDIV:
        if (b === 0) {
          throw new ComptimeError(`comptime: integer divide by zero`, inst.sourceLoc);
        }
        return (a / b) | 0;
      case OP.IREM:
        if (b === 0) {
          throw new ComptimeError(`comptime: integer modulo by zero`, inst.sourceLoc);
        }
        return a % b;
    }
  }
  throw new ComptimeError(`comptime: internal — unexpected int op ${op}`, inst.sourceLoc);
}
