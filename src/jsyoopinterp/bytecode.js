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

  // Bitwise integer ops. The typechecker already validates the
  // operand type is an integer prim; the interpreter dispatches on
  // BigInt vs Number based on operand width the same way iadd etc. do.
  BIT_AND: "bit_and",
  BIT_OR:  "bit_or",
  BIT_XOR: "bit_xor",
  BIT_NOT: "bit_not",
  SHL:     "shl",
  SHR:     "shr",

  // Integer + float comparison ops. All produce bool. The signed-ness
  // is implicit in the operand type (icmp_lt is signed when operands
  // are signed; the interpreter handles that via JS native compare,
  // which is signed for numbers and signed for BigInt).
  ICMP_EQ: "icmp_eq",
  ICMP_NE: "icmp_ne",
  ICMP_LT: "icmp_lt",
  ICMP_LE: "icmp_le",
  ICMP_GT: "icmp_gt",
  ICMP_GE: "icmp_ge",
  FCMP_EQ: "fcmp_eq",
  FCMP_NE: "fcmp_ne",
  FCMP_LT: "fcmp_lt",
  FCMP_LE: "fcmp_le",
  FCMP_GT: "fcmp_gt",
  FCMP_GE: "fcmp_ge",

  // Bool ops. `LNOT` is unary; `LAND`/`LOR` are both binary AND
  // short-circuiting at lowering time (the lowerer emits a brcond
  // chain rather than calling these once control flow lands in a
  // later sub-phase). For 11.B.4 lowering emits direct LAND/LOR
  // since we don't yet have br/label and operands are simple enough
  // that always-evaluating both sides is observable only on
  // diagnostics, not behavior.
  LAND: "land",
  LOR:  "lor",
  LNOT: "lnot",

  // Returns from the current function. If `dst` is non-null, the
  // result is the value in `args[0]`; otherwise it's a void return.
  RET: "ret",

  // Build a struct value from per-field registers. `type` is the
  // StructType; `args` lists the source registers in *declared*
  // field order (lowering normalizes from source-order, since
  // `Foo { y: 1, x: 2 }` is legal yoop). `immediate` carries the
  // ordered field-name list so the interpreter can build the
  // wrapped-value's `v: { fieldName → wrapped }` map without
  // re-deriving the order at eval time.
  STRUCT_CONSTRUCT: "struct_construct",

  // Build an array (yoop fat-pointer) value from per-element
  // registers. `type` is the ArrayType; `args` lists the source
  // registers in source order. Length is `args.length`.
  ARRAY_CONSTRUCT: "array_construct",

  // Read a struct field by name. `args[0]` is the struct-value
  // register; `immediate` is the string field name; `type` is the
  // field's type (== `inst.dst`'s register type).
  FIELD_LOAD: "field_load",

  // Read an array element by index. `args[0]` is the array-value
  // register; `args[1]` is the index-value register; `type` is the
  // element type. Out-of-bounds is a comptime error.
  INDEX_LOAD: "index_load",

  // Read the `len` field of a yoop array (the i64 half of the fat
  // pointer). `args[0]` is the array-value register; `type` is the
  // dst register's type (typically `usize` / `int64`).
  ARRAY_LEN: "array_len",

  // Direct function call. `immediate` is the callee `BytecodeFunction`
  // (resolved at lower time via the fnResolver callback); `args` is
  // the source register list for the call's arguments, in declared
  // parameter order. `dst` receives the callee's return value.
  // The interpreter pushes a new frame, binds args to the callee's
  // first N registers, runs until RET, and writes the result back
  // into the caller's `dst`.
  CALL_DIRECT: "call_direct",

  // Copy a value between registers. Used by LET_DECL / CONST_DECL to
  // park the init expression's result into a stable "slot reg" the
  // binding's IDENT references resolve to, and by ASSIGNMENT to
  // overwrite that slot. The slot reg's value is mutable in the
  // interpreter (we're not SSA-strict — see lower.js LowerCtx for
  // discussion). `args[0]` is the source reg; `dst` is the slot.
  MOVE: "move",

  // Unconditional branch to the labeled instruction. `immediate` is
  // the label name (string). The interpreter precomputes a
  // labelName → instructionIndex map per frame at push time.
  BR: "br",

  // Conditional branch. `args[0]` is the bool-valued condition
  // register; `immediate` is `{ then: labelName, else: labelName }`.
  BRCOND: "brcond",

  // No-op marker; carries `immediate = labelName` so the interpreter
  // can build a labelName → ip map for use by BR / BRCOND.
  LABEL: "label",

  // Numeric cast — `int32(x)`, `float32(y)`, etc. The destination
  // register is typed via `inst.type`, which is also stamped as the
  // `castTargetType` from the AST. The interpreter routes the source
  // value through `coerceNumeric`, which handles every legal pairing:
  // int↔int (truncate / sign-extend), int↔float (round / floor),
  // float↔float (precision conversion).
  CAST: "cast",

  // Write a struct field by name. `args[0]` is the struct-value
  // register; `args[1]` is the new field value; `immediate` is the
  // field name string. Mutates the struct's wrapped `v` object in
  // place — yoop struct semantics are value-typed, so the
  // interpreter's MOVE handler deep-copies struct values to keep
  // aliases from sharing state.
  FIELD_STORE: "field_store",

  // Write an array element by index. `args[0]` is the array-value
  // register; `args[1]` is the index register; `args[2]` is the new
  // element value. Arrays in yoop are fat-pointers (the buf is
  // shared), so aliases legitimately see each other's writes — no
  // deep-copy on assignment.
  INDEX_STORE: "index_store",

  // Construct a reference to a local-register slot. `args[0]` is the
  // slot reg index (passed as a JS Number in immediate, since the
  // interpreter stores it as the JS array key). The resulting ref
  // value is `{ ty: RefType(inner), v: { container, key } }` where
  // container is the frame's `registers` array. Lifetime is bounded
  // by the enclosing frame — yoop's kind checks enforce that refs
  // don't escape, and the interpreter doesn't need a separate check.
  REF_LOCAL: "ref_local",

  // Construct a reference to a struct field. `args[0]` is the
  // struct-value register; `immediate` is the field name string.
  REF_FIELD: "ref_field",

  // Construct a reference to an array element. `args[0]` is the
  // array-value register; `args[1]` is the index register.
  REF_INDEX: "ref_index",

  // Build an enum variant value from per-payload-field registers.
  // `immediate` carries `{ variantName, ordinal, fieldNames }`; `args`
  // are the payload field regs in declared order (lowering normalizes
  // source order to declared order, same as STRUCT_CONSTRUCT).
  // `type` is the EnumType.
  VARIANT_CONSTRUCT: "variant_construct",

  // Read the variant tag (i32 ordinal) from an enum value. `args[0]`
  // is the enum register; `dst` receives an int32 wrapped value.
  VARIANT_TAG: "variant_tag",

  // Read a named payload field from an enum value's variant. `args[0]`
  // is the enum register; `immediate` is the field name string; `type`
  // is the field's type. The interpreter assumes the variant is the
  // expected one — lowering only emits this inside arm bodies after a
  // tag-match branch.
  VARIANT_PAYLOAD_FIELD: "variant_payload_field",

  // Read through a reference (auto-deref). `args[0]` is the ref
  // register. Yoop is value-typed for structs, so struct reads
  // through a ref copy out — matches the deep-copy semantics MOVE /
  // CALL_DIRECT use elsewhere.
  REF_LOAD: "ref_load",

  // Write through a reference. `args[0]` is the ref register;
  // `args[1]` is the new value. Struct writes also copy in (so
  // mutating the value at the source after a ref-store doesn't
  // mutate the referent).
  REF_STORE: "ref_store",
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
