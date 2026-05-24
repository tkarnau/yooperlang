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
import { coerceNumeric, usesBigInt, valueCopy } from "./values.js";
import { typeKinds } from "../jsyooptypecheck/types.js";

const MAX_FRAMES = 1024;

// Frame holds one in-flight function's state.
//   fn        - the BytecodeFunction being executed
//   ip        - instruction pointer (next instruction to dispatch)
//   registers - per-register wrapped-value array, indexed by reg id
//   returnDst - when this frame is a sub-call, the parent frame's
//               destination register for the call's result. Null for
//               the top-level frame so RET signals overall completion.
function makeFrame(fn, returnDst = null) {
  // Build a label-to-ip index once at push time so BR / BRCOND are
  // O(1). Cached on the fn so a recursive call doesn't re-scan; the
  // cache is on the immutable fn so it's safe across all frames.
  if (!fn._labelMap) {
    const map = new Map();
    for (let i = 0; i < fn.instructions.length; i++) {
      const inst = fn.instructions[i];
      if (inst.op === OP.LABEL) map.set(inst.immediate, i);
    }
    fn._labelMap = map;
  }
  return {
    fn,
    ip: 0,
    registers: new Array(fn.registerTypes.length).fill(null),
    returnDst,
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

      case OP.BIT_AND:
      case OP.BIT_OR:
      case OP.BIT_XOR:
      case OP.SHL:
      case OP.SHR: {
        const lhs = frame.registers[inst.args[0]];
        const rhs = frame.registers[inst.args[1]];
        const result = intBitwise(inst.op, lhs, rhs, inst);
        frame.registers[inst.dst] = { ty: inst.type, v: coerceNumeric(inst.type, result) };
        break;
      }

      case OP.BIT_NOT: {
        const v = frame.registers[inst.args[0]].v;
        const result = typeof v === "bigint" ? ~v : ~Number(v);
        frame.registers[inst.dst] = { ty: inst.type, v: coerceNumeric(inst.type, result) };
        break;
      }

      case OP.ICMP_EQ:
      case OP.ICMP_NE:
      case OP.ICMP_LT:
      case OP.ICMP_LE:
      case OP.ICMP_GT:
      case OP.ICMP_GE: {
        // Both operands share a yoop type by the typechecker; compare
        // raw payloads with JS's `==`-family operators which Do The
        // Right Thing for matching-typeof Number and BigInt.
        const a = frame.registers[inst.args[0]].v;
        const b = frame.registers[inst.args[1]].v;
        let result;
        switch (inst.op) {
          case OP.ICMP_EQ: result = a === b; break;
          case OP.ICMP_NE: result = a !== b; break;
          case OP.ICMP_LT: result = a < b; break;
          case OP.ICMP_LE: result = a <= b; break;
          case OP.ICMP_GT: result = a > b; break;
          case OP.ICMP_GE: result = a >= b; break;
        }
        frame.registers[inst.dst] = { ty: inst.type, v: result };
        break;
      }

      case OP.FCMP_EQ:
      case OP.FCMP_NE:
      case OP.FCMP_LT:
      case OP.FCMP_LE:
      case OP.FCMP_GT:
      case OP.FCMP_GE: {
        const a = Number(frame.registers[inst.args[0]].v);
        const b = Number(frame.registers[inst.args[1]].v);
        let result;
        switch (inst.op) {
          case OP.FCMP_EQ: result = a === b; break;
          case OP.FCMP_NE: result = a !== b; break;
          case OP.FCMP_LT: result = a < b; break;
          case OP.FCMP_LE: result = a <= b; break;
          case OP.FCMP_GT: result = a > b; break;
          case OP.FCMP_GE: result = a >= b; break;
        }
        frame.registers[inst.dst] = { ty: inst.type, v: result };
        break;
      }

      case OP.LAND:
      case OP.LOR: {
        const a = !!frame.registers[inst.args[0]].v;
        const b = !!frame.registers[inst.args[1]].v;
        const result = inst.op === OP.LAND ? a && b : a || b;
        frame.registers[inst.dst] = { ty: inst.type, v: result };
        break;
      }

      case OP.LNOT: {
        const a = !!frame.registers[inst.args[0]].v;
        frame.registers[inst.dst] = { ty: inst.type, v: !a };
        break;
      }

      case OP.RET: {
        pendingResult = inst.args.length > 0 ? frame.registers[inst.args[0]] : null;
        const completed = stack.pop();
        if (stack.length === 0) return pendingResult;
        // Frame returned to caller — write the result into the
        // caller's pending-call dst register so the calling
        // instruction's `inst.dst` reads the right value.
        const caller = stack[stack.length - 1];
        if (completed.returnDst != null) {
          caller.registers[completed.returnDst] = pendingResult;
        }
        break;
      }

      case OP.MOVE: {
        // Yoop struct semantics are value-typed; valueCopy
        // deep-copies on struct values so `let a = b; a.x = ...` doesn't
        // mutate `b`. Primitives and arrays pass through unchanged.
        frame.registers[inst.dst] = valueCopy(frame.registers[inst.args[0]]);
        break;
      }

      case OP.CAST: {
        // Read source value, coerce to destination type. coerceNumeric
        // handles int↔int (mask/sign-extend), int↔float, float↔float.
        // bool casts are intentionally rejected (yoop today requires
        // explicit comparison; the typechecker already enforces this).
        const src = frame.registers[inst.args[0]];
        const dstTy = inst.type;
        const raw = src.v;
        const v = coerceNumeric(dstTy, typeof raw === "bigint" ? raw : Number(raw));
        frame.registers[inst.dst] = { ty: dstTy, v };
        break;
      }

      case OP.LABEL: {
        // No-op at execution time; only meaningful as a target.
        break;
      }

      case OP.BR: {
        const target = frame.fn._labelMap.get(inst.immediate);
        if (target == null) {
          throw new ComptimeError(
            `comptime: BR to unknown label '${inst.immediate}'`,
            inst.sourceLoc,
          );
        }
        frame.ip = target;
        break;
      }

      case OP.BRCOND: {
        const cond = frame.registers[inst.args[0]]?.v;
        const labelName = cond ? inst.immediate.then : inst.immediate.else;
        const target = frame.fn._labelMap.get(labelName);
        if (target == null) {
          throw new ComptimeError(
            `comptime: BRCOND to unknown label '${labelName}'`,
            inst.sourceLoc,
          );
        }
        frame.ip = target;
        break;
      }

      case OP.CALL_EXTERN: {
        // Pure-extern: resolved at lower time to a JS impl in the
        // whitelist. Pass the wrapped args + sourceLoc + return type
        // to the impl, which produces a wrapped result we store into
        // `inst.dst`. The impl may throw ComptimeError to abort
        // (the comptime pass catches that and either surfaces it as
        // a hard error under `@precompile` or silently falls back
        // for opportunistic folds).
        const { impl, name } = inst.immediate;
        const argWraps = inst.args.map((reg) => frame.registers[reg]);
        let result;
        try {
          result = impl(argWraps, inst.sourceLoc, inst.type);
        } catch (err) {
          if (err instanceof ComptimeError) throw err;
          throw new ComptimeError(
            `comptime: extern '${name}' threw during evaluation: ${err.message}`,
            inst.sourceLoc,
          );
        }
        if (inst.dst != null) {
          frame.registers[inst.dst] = result;
        }
        break;
      }

      case OP.CALL_DIRECT: {
        const calleeFn = inst.immediate; // BytecodeFunction
        const newFrame = makeFrame(calleeFn, inst.dst);
        if (inst.args.length !== calleeFn.params.length) {
          throw new ComptimeError(
            `comptime: arg count mismatch calling '${calleeFn.name}' — got ${inst.args.length}, expected ${calleeFn.params.length}`,
            inst.sourceLoc,
          );
        }
        for (let i = 0; i < inst.args.length; i++) {
          // valueCopy deep-copies struct args to honor yoop's
          // value-typed struct semantics — mutating a struct param
          // inside the callee must not flow back into the caller's
          // copy of that arg.
          newFrame.registers[i] = valueCopy(frame.registers[inst.args[i]]);
        }
        stack.push(newFrame);
        break;
      }

      case OP.STRUCT_CONSTRUCT: {
        const fieldNames = inst.immediate; // string[]
        const obj = Object.create(null);
        for (let i = 0; i < fieldNames.length; i++) {
          obj[fieldNames[i]] = frame.registers[inst.args[i]];
        }
        frame.registers[inst.dst] = { ty: inst.type, v: obj };
        break;
      }

      case OP.ARRAY_CONSTRUCT: {
        const buf = inst.args.map((reg) => frame.registers[reg]);
        frame.registers[inst.dst] = {
          ty: inst.type,
          v: { buf, len: BigInt(buf.length) },
        };
        break;
      }

      case OP.FIELD_LOAD: {
        const obj = frame.registers[inst.args[0]];
        const fieldName = inst.immediate;
        const field = obj?.v?.[fieldName];
        if (field == null) {
          throw new ComptimeError(
            `comptime: field '${fieldName}' missing on struct value`,
            inst.sourceLoc,
          );
        }
        frame.registers[inst.dst] = field;
        break;
      }

      case OP.INDEX_LOAD: {
        const arr = frame.registers[inst.args[0]];
        const idxVal = frame.registers[inst.args[1]];
        const idx = typeof idxVal.v === "bigint" ? Number(idxVal.v) : Number(idxVal.v);
        const buf = arr?.v?.buf;
        if (!Array.isArray(buf) || idx < 0 || idx >= buf.length) {
          throw new ComptimeError(
            `comptime: array index ${idx} out of bounds (len ${buf?.length ?? 0})`,
            inst.sourceLoc,
          );
        }
        frame.registers[inst.dst] = buf[idx];
        break;
      }

      case OP.VARIANT_CONSTRUCT: {
        const { variantName, ordinal, fieldNames } = inst.immediate;
        const payload = Object.create(null);
        for (let i = 0; i < fieldNames.length; i++) {
          payload[fieldNames[i]] = frame.registers[inst.args[i]];
        }
        frame.registers[inst.dst] = {
          ty: inst.type,
          v: { tag: ordinal, variantName, payload },
        };
        break;
      }

      case OP.VARIANT_TAG: {
        const enumVal = frame.registers[inst.args[0]];
        const tag = enumVal?.v?.tag ?? 0;
        frame.registers[inst.dst] = { ty: inst.type, v: tag | 0 };
        break;
      }

      case OP.VARIANT_PAYLOAD_FIELD: {
        const enumVal = frame.registers[inst.args[0]];
        const fieldName = inst.immediate;
        const v = enumVal?.v?.payload?.[fieldName];
        if (v == null) {
          throw new ComptimeError(
            `comptime: variant payload field '${fieldName}' not present on enum value`,
            inst.sourceLoc,
          );
        }
        frame.registers[inst.dst] = v;
        break;
      }

      case OP.REF_LOCAL: {
        // Store the frame.registers array + the slot index in the
        // ref's payload. The slot index was emitted as `immediate`
        // (a JS number) so we don't have to read it out of a register.
        frame.registers[inst.dst] = {
          ty: inst.type,
          v: { container: frame.registers, key: inst.immediate },
        };
        break;
      }

      case OP.REF_FIELD: {
        const obj = frame.registers[inst.args[0]];
        if (obj?.v == null) {
          throw new ComptimeError(
            `comptime: ref-field on null struct value`,
            inst.sourceLoc,
          );
        }
        frame.registers[inst.dst] = {
          ty: inst.type,
          v: { container: obj.v, key: inst.immediate },
        };
        break;
      }

      case OP.REF_INDEX: {
        const arr = frame.registers[inst.args[0]];
        const idxVal = frame.registers[inst.args[1]];
        const idx = typeof idxVal.v === "bigint" ? Number(idxVal.v) : Number(idxVal.v);
        const buf = arr?.v?.buf;
        if (!Array.isArray(buf) || idx < 0 || idx >= buf.length) {
          throw new ComptimeError(
            `comptime: ref-index ${idx} out of bounds (len ${buf?.length ?? 0})`,
            inst.sourceLoc,
          );
        }
        frame.registers[inst.dst] = {
          ty: inst.type,
          v: { container: buf, key: idx },
        };
        break;
      }

      case OP.REF_LOAD: {
        const ref = frame.registers[inst.args[0]];
        // Share JS identity with the referent — that's the whole
        // point of a ref. The downstream consumer is responsible for
        // copying when value semantics demand it:
        //   - MOVE into a let-slot will deep-copy a struct value.
        //   - CALL_DIRECT arg binding will deep-copy a struct value.
        //   - REF_STORE writing back will deep-copy on insert.
        // Mutating writes (FIELD_STORE / INDEX_STORE / REF_STORE on
        // *this* reg's payload) are how the ref's mutation semantics
        // propagate back to the caller.
        frame.registers[inst.dst] = ref.v.container[ref.v.key];
        break;
      }

      case OP.REF_STORE: {
        const ref = frame.registers[inst.args[0]];
        const newVal = frame.registers[inst.args[1]];
        ref.v.container[ref.v.key] = valueCopy(newVal);
        break;
      }

      case OP.FIELD_STORE: {
        const obj = frame.registers[inst.args[0]];
        const newVal = frame.registers[inst.args[1]];
        if (obj?.v == null) {
          throw new ComptimeError(
            `comptime: field store on missing struct value`,
            inst.sourceLoc,
          );
        }
        obj.v[inst.immediate] = newVal;
        break;
      }

      case OP.INDEX_STORE: {
        const arr = frame.registers[inst.args[0]];
        const idxVal = frame.registers[inst.args[1]];
        const newVal = frame.registers[inst.args[2]];
        const idx = typeof idxVal.v === "bigint" ? Number(idxVal.v) : Number(idxVal.v);
        const buf = arr?.v?.buf;
        if (!Array.isArray(buf) || idx < 0 || idx >= buf.length) {
          throw new ComptimeError(
            `comptime: array index ${idx} out of bounds (len ${buf?.length ?? 0})`,
            inst.sourceLoc,
          );
        }
        buf[idx] = newVal;
        break;
      }

      case OP.ARRAY_LEN: {
        const arr = frame.registers[inst.args[0]];
        const len = arr?.v?.len ?? BigInt(0);
        // Materialize as the dst register's type — coerce so a usize
        // dst gets a BigInt and an int32 dst gets a Number.
        frame.registers[inst.dst] = {
          ty: inst.type,
          v: coerceNumeric(inst.type, len),
        };
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

// Integer bitwise/shift ops. BigInt path for 64-bit-wide; Number path
// for narrower. JS shifts on Number are signed 32-bit only, so we
// route through BigInt whenever a shift could overflow the int32
// signed range (anything wider than int32 or a non-trivial unsigned).
function intBitwise(op, lhs, rhs, inst) {
  const lty = lhs.ty;
  const lv = lhs.v;
  const rv = rhs.v;
  const wantBig =
    typeof lv === "bigint" ||
    typeof rv === "bigint" ||
    (lty.kind === typeKinds.prim && usesBigInt(lty.name)) ||
    (inst.type?.kind === typeKinds.prim && usesBigInt(inst.type.name));
  if (wantBig) {
    const a = typeof lv === "bigint" ? lv : BigInt(lv);
    const b = typeof rv === "bigint" ? rv : BigInt(rv);
    switch (op) {
      case OP.BIT_AND: return a & b;
      case OP.BIT_OR:  return a | b;
      case OP.BIT_XOR: return a ^ b;
      case OP.SHL:     return a << b;
      case OP.SHR:     return a >> b;
    }
  } else {
    const a = lv | 0;
    const b = rv | 0;
    switch (op) {
      case OP.BIT_AND: return a & b;
      case OP.BIT_OR:  return a | b;
      case OP.BIT_XOR: return a ^ b;
      case OP.SHL:     return a << b;
      case OP.SHR:     return a >> b;
    }
  }
  throw new ComptimeError(`comptime: internal — unexpected bitwise op ${op}`, inst.sourceLoc);
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
