// Phase 11.B: typed register-based bytecode IR.
//
// Each `BytecodeFunction` carries an ordered list of `Instruction`s
// plus a parallel `registerTypes` array mapping register index → yoop
// Type. Registers are pure SSA — assigned once at construction time,
// never reassigned. Control-flow joins read whichever register the
// branch terminator wrote (phi is implicit through reg indices).
//
// `Instruction { op, dst, args, type, sourceLoc, immediate }`:
//   - op:        opcode string (see `OP` constants below)
//   - dst:       destination register index (null if the op produces
//                no value, e.g. `ret`, `br`)
//   - args:      array of source register indices (interpretation is
//                op-specific)
//   - type:      yoop Type of the produced value, for sanity checks
//                and for picking the right native arithmetic path
//   - sourceLoc: SourceLocation copied from the AST node that produced
//                this instruction; used for diagnostics tracebacks
//   - immediate: optional embedded payload — currently used for
//                literal constants and label targets; this is a JS
//                value the interpreter consumes directly without
//                materializing it as a register
//
// The opcode set deliberately starts small. Phase 11.B.0 covers
// primitive arithmetic + return; later sub-phases extend coverage to
// memory ops, control flow, calls, structs/arrays/refs, enum match,
// tasks, and kind-flow cleanups.

export const OP = Object.freeze({
  // Materializes an immediate into a register. `immediate` is the
  // wrapped value to load; `dst` is the receiving register.
  LITERAL: "literal",

  // Integer arithmetic, signed + unsigned (the typechecker has
  // already validated operands match the dst type's signedness).
  // `args = [lhs, rhs]`.
  IADD: "iadd",
  ISUB: "isub",
  IMUL: "imul",
  IDIV: "idiv",
  IREM: "irem",
  INEG: "ineg",

  // Float arithmetic, single+double sharing the same opcode because
  // JS number does both.
  FADD: "fadd",
  FSUB: "fsub",
  FMUL: "fmul",
  FDIV: "fdiv",
  FNEG: "fneg",

  // Returns from the current function. If `dst` is non-null, the
  // result is the value in `args[0]`; otherwise it's a void return.
  RET: "ret",
});

export function instruction(op, opts = {}) {
  return {
    op,
    dst: opts.dst ?? null,
    args: opts.args ?? [],
    type: opts.type ?? null,
    sourceLoc: opts.sourceLoc ?? null,
    immediate: opts.immediate ?? null,
  };
}

// Container for one function's worth of bytecode. Created by `lower.js`
// and consumed by `interp.js`. The `params` field is empty for the
// synthesized wrapper used to fold a single module-init expression;
// future user-defined `@precompile` callsites will populate it.
export function bytecodeFunction({
  name,
  params = [],
  returnType,
  registerTypes,
  instructions,
  sourceLoc = null,
}) {
  return { name, params, returnType, registerTypes, instructions, sourceLoc };
}
