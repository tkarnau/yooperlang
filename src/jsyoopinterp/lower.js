// Phase 11.B.0: typed bytecode lowering for the minimum slice -
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
// 11.B.0 always a synthesized wrapper around a single expression; in
// 11.B.7 also real user-defined functions invoked via CALL_DIRECT).
//
// `moduleConsts` is an optional Map<name, wrappedValue> the comptime
// pass threads through when lowering one module-init expression that
// might reference an earlier (already-folded) module-level const. An
// IDENT whose name is in the map lowers to a LITERAL of the referenced
// value.
//
// `fnResolver` is an optional callback `(calleeName, calleeModuleId,
// calleeExportName) → BytecodeFunction | null`. The lowerer invokes
// it at every CALL_EXPRESSION; null means "this call can't be folded"
// and surfaces as a ComptimeError (silent module-init fallback).
class LowerCtx {
  constructor(fnName, sourceLoc, moduleConsts, fnResolver, traitMethodResolver, genericInstanceResolver, moduleStateNames) {
    this.fnName = fnName;
    this.sourceLoc = sourceLoc;
    this.instructions = [];
    this.registerTypes = [];
    this.moduleConsts = moduleConsts ?? new Map();
    this.fnResolver = fnResolver ?? null;
    // Phase 11.D.18: set of module-level mangled syms (`<modid>__<name>`)
    // that the block lowerer treats as live module state. IDENT
    // reads against these names lower to MODULE_LOAD; ASSIGNMENT
    // targets lower to MODULE_STORE. Null/undefined disables the
    // module-state path (the default for module-init folds and
    // user-function lowering).
    this.moduleStateNames = moduleStateNames ?? null;
    // Phase 11.D.11: the enclosing function's return type. Used by
    // TRY_OP lowering to build the correct Err variant for early
    // returns. Set by lowerFunction / lowerExpressionAsFunction
    // before walking the body; consulted in the TRY_OP case.
    this.currentReturnType = null;
    // Phase 11.D.5: looks up a trait method's BytecodeFunction given
    // the receiver struct type + trait name + method name. Returns
    // null when the method can't be lowered at comptime (unsupported
    // body shape, generic-unresolved, etc.).
    this.traitMethodResolver = traitMethodResolver ?? null;
    // Phase 11.D.7: looks up a generic-fn instance's BytecodeFunction
    // given the Phase-7.1 registry instance object. Used when
    // CALL_EXPRESSION's `genericInstantiation` slot is populated.
    this.genericInstanceResolver = genericInstanceResolver ?? null;
    this.labelCounter = 0;
  }
  allocReg(ty) {
    this.registerTypes.push(ty);
    return this.registerTypes.length - 1;
  }
  emit(inst) {
    this.instructions.push(inst);
  }
  // Mint a unique label name within this function. Used by IF /
  // WHILE / future control-flow lowering. Per-function counter so
  // labels stay stable across cached function bytecode.
  freshLabel(hint) {
    return `${hint}_${this.labelCounter++}`;
  }
}

// Lexical scope chain for IDENT resolution inside function bodies.
// Bindings hold a register index that the IDENT case looks up. Param
// regs live in the function's outermost scope; locals (LET_DECL,
// CONST_DECL) extend a child scope opened per BLOCK in later
// sub-phases. Today the chain only has the param scope.
class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.bindings = new Map();
  }
  declare(name, regIdx) {
    this.bindings.set(name, regIdx);
  }
  lookup(name) {
    if (this.bindings.has(name)) return this.bindings.get(name);
    return this.parent ? this.parent.lookup(name) : null;
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
    opts.fnResolver,
    opts.traitMethodResolver,
    opts.genericInstanceResolver,
    opts.moduleStateNames,
  );
  ctx.currentReturnType = returnType;
  const scope = new Scope(null);
  const resultReg = lowerExpr(exprAst, ctx, scope);
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

// Lower a user-defined function decl into a BytecodeFunction. The
// param list seeds the function's first N registers and the outer
// scope binds param names to those registers. The body walks via the
// statement-level lowerer (today: just BLOCK + RETURN_STATEMENT;
// later sub-phases add LET_DECL, IF_STATEMENT, WHILE_STATEMENT, etc.).
export function lowerFunction(funcDecl, opts = {}) {
  const ctx = new LowerCtx(
    funcDecl.name,
    funcDecl.sourceLoc ?? null,
    opts.moduleConsts,
    opts.fnResolver,
    opts.traitMethodResolver,
    opts.genericInstanceResolver,
    opts.moduleStateNames,
  );
  const scope = new Scope(null);
  const paramTypes = [];
  for (const param of funcDecl.params ?? []) {
    const ty = param.resolvedType;
    paramTypes.push(ty);
    const reg = ctx.allocReg(ty);
    scope.declare(param.name, reg);
  }
  ctx.currentReturnType =
    funcDecl.resolvedType ?? funcDecl.declaredReturnType ?? null;
  lowerStatement(funcDecl.body, ctx, scope);
  // Synthesize a trailing `ret void` for void-returning functions
  // whose body doesn't explicitly end in RET. Matches codegen's
  // implicit-return behavior so void fns the user wrote without a
  // trailing `return;` still terminate cleanly under the interpreter.
  const returnType = ctx.currentReturnType;
  const last = ctx.instructions[ctx.instructions.length - 1];
  const isVoid = returnType?.kind === typeKinds.void;
  if (isVoid && (!last || last.op !== OP.RET)) {
    ctx.emit(instruction(OP.RET, { args: [], sourceLoc: funcDecl.sourceLoc }));
  }
  return bytecodeFunction({
    name: funcDecl.name,
    params: paramTypes,
    returnType,
    registerTypes: ctx.registerTypes,
    instructions: ctx.instructions,
    sourceLoc: funcDecl.sourceLoc ?? null,
  });
}

// Phase 11.D.18: lower an `@precompile { ... }` block as a void
// no-param function. The block's BLOCK statement is walked exactly
// like a normal function body, but `moduleStateNames` is non-null so
// any IDENT read or ASSIGNMENT target that the typechecker tagged
// `isModuleGlobal` lowers through MODULE_LOAD / MODULE_STORE rather
// than through a local scope slot. Locals declared inside the block
// (`let x: ... = ...`) still go through the regular scope path.
//
// Returns the synthesized BytecodeFunction. The comptime pass
// evaluates it once with the shared `moduleState` map, then reads
// back the final values to commit them to module-level decls.
export function lowerBlockAsFunction(blockAst, opts = {}) {
  const ctx = new LowerCtx(
    opts.fnName ?? "<precompile-block>",
    blockAst.sourceLoc ?? null,
    opts.moduleConsts,
    opts.fnResolver,
    opts.traitMethodResolver,
    opts.genericInstanceResolver,
    opts.moduleStateNames,
  );
  ctx.currentReturnType = { kind: typeKinds.void };
  const scope = new Scope(null);
  lowerStatement(blockAst, ctx, scope);
  const last = ctx.instructions[ctx.instructions.length - 1];
  if (!last || last.op !== OP.RET) {
    ctx.emit(instruction(OP.RET, { args: [], sourceLoc: blockAst.sourceLoc }));
  }
  return bytecodeFunction({
    name: ctx.fnName,
    params: [],
    returnType: { kind: typeKinds.void },
    registerTypes: ctx.registerTypes,
    instructions: ctx.instructions,
    sourceLoc: ctx.sourceLoc,
  });
}

// Lower one statement. Coverage today: BLOCK, RETURN_STATEMENT,
// LET_DECL, CONST_DECL, ASSIGNMENT, EXPRESSION_STATEMENT,
// IF_STATEMENT, WHILE_STATEMENT. Statement kinds not on this list
// throw ComptimeError and surface as the silent module-init fallback.
function lowerStatement(node, ctx, scope) {
  switch (node.kind) {
    case ASTNodeKind.BLOCK: {
      const inner = new Scope(scope);
      for (const stmt of node.body ?? []) {
        lowerStatement(stmt, ctx, inner);
      }
      return;
    }
    case ASTNodeKind.RETURN_STATEMENT: {
      if (node.value) {
        const reg = lowerExpr(node.value, ctx, scope);
        ctx.emit(
          instruction(OP.RET, {
            args: [reg],
            type: ctx.registerTypes[reg],
            sourceLoc: node.sourceLoc,
          }),
        );
      } else {
        ctx.emit(instruction(OP.RET, { args: [], sourceLoc: node.sourceLoc }));
      }
      return;
    }
    case ASTNodeKind.LET_DECL:
    case ASTNodeKind.CONST_DECL: {
      // Allocate a stable "slot reg" the binding's IDENT references
      // resolve to. The init expression's result is MOVE'd into it so
      // a future ASSIGNMENT (for LET_DECL) can overwrite the same slot
      // without re-binding the IDENT to a new register.
      if (!node.assignment) {
        throw new ComptimeError(
          `comptime: let / const without initializer is not supported (declare and assign on one line)`,
          node.sourceLoc,
        );
      }
      let valReg = lowerExpr(node.assignment, ctx, scope);
      // Phase 11.D.9: `immediateTaskCall` is the typechecker's flag
      // for `const x: T = compute(...);` where compute returns
      // Task<T>. The CALL_EXPRESSION produced a Task<T> register;
      // unwrap it to T before the MOVE so the slot holds the inner
      // value (matching the binding's declared type).
      if (node.immediateTaskCall) {
        const taskTy = ctx.registerTypes[valReg];
        const innerTy = taskTy.resultType ?? node.resolvedType;
        const unwrapped = ctx.allocReg(innerTy);
        ctx.emit(
          instruction(OP.TASK_WAIT, {
            dst: unwrapped,
            args: [valReg],
            type: innerTy,
            sourceLoc: node.sourceLoc,
          }),
        );
        valReg = unwrapped;
      }
      const ty = node.resolvedType ?? ctx.registerTypes[valReg];
      const slotReg = ctx.allocReg(ty);
      ctx.emit(
        instruction(OP.MOVE, {
          dst: slotReg,
          args: [valReg],
          type: ty,
          sourceLoc: node.sourceLoc,
        }),
      );
      scope.declare(node.name, slotReg);
      return;
    }

    case ASTNodeKind.TASK_AUTO_WAIT:
    case ASTNodeKind.TASK_RELEASE:
    case ASTNodeKind.TASK_RETAIN: {
      // Tasks at comptime run synchronously inline - no real
      // refcount to release, no real thread to join. These
      // synthesized cleanup statements are no-ops at the bytecode
      // level. (See lower.js's TASK_WRAP / TASK_WAIT for the
      // value-level model.)
      return;
    }

    case ASTNodeKind.CLEANUP_CALL: {
      // Phase 11.D.17: real cleanup_call dispatch. The kindCheck
      // pass synthesizes these statements at scope-exit for
      // disposable-kind bindings - e.g. `dispose(ref binding)` for
      // a `disposable foo: Foo = ...`. Resolve the trait method's
      // bytecode via traitMethodResolver and emit a CALL_DIRECT
      // with `ref binding` as `self`. If the dispose body hits a
      // non-whitelisted extern (e.g. SDL_DestroyWindow), the fold
      // fails with a clear traceback - matches the @precompile
      // contract that explicit comptime evaluation must execute
      // *all* observable effects.
      if (!ctx.traitMethodResolver) {
        throw new ComptimeError(
          `comptime: CLEANUP_CALL requires a traitMethodResolver`,
          node.sourceLoc,
        );
      }
      const slotReg = scope ? scope.lookup(node.bindingName) : null;
      if (slotReg == null) {
        // The binding's slot isn't in this lowering scope - likely a
        // kindCheck-emitted cleanup whose binding lives in a parent
        // frame we don't model. Skip the cleanup; the fold may
        // miss the observable effect, but failing here would be
        // overly strict for the common case.
        return;
      }
      // Build the ref to dispatch on. For the bare binding case it's
      // a REF_LOCAL on the slot; for propagated field-cleanups
      // (`node.fieldName` set), GEP through the binding to its
      // field via REF_FIELD on the loaded struct value. Today's
      // disposable-kind bindings are non-field - the field path is
      // ready for when propagates<disposable> structs land in fold
      // coverage.
      const refStructType = node.fieldStructType ?? node.structType;
      let recvRefReg;
      if (node.fieldName) {
        // Load the binding's struct value, then take a ref to its
        // named field.
        const bindingTy = ctx.registerTypes[slotReg];
        const structVal = ctx.allocReg(bindingTy);
        ctx.emit(
          instruction(OP.MOVE, {
            dst: structVal,
            args: [slotReg],
            type: bindingTy,
            sourceLoc: node.sourceLoc,
          }),
        );
        recvRefReg = ctx.allocReg({ kind: typeKinds.ref, inner: refStructType });
        ctx.emit(
          instruction(OP.REF_FIELD, {
            dst: recvRefReg,
            args: [structVal],
            type: { kind: typeKinds.ref, inner: refStructType },
            immediate: node.fieldName,
            sourceLoc: node.sourceLoc,
          }),
        );
      } else {
        // Bare binding: take ref to the local slot directly.
        recvRefReg = ctx.allocReg({ kind: typeKinds.ref, inner: refStructType });
        ctx.emit(
          instruction(OP.REF_LOCAL, {
            dst: recvRefReg,
            args: [slotReg],
            type: { kind: typeKinds.ref, inner: refStructType },
            immediate: slotReg,
            sourceLoc: node.sourceLoc,
          }),
        );
      }
      const methodBc = ctx.traitMethodResolver(
        refStructType,
        node.traitName,
        node.methodName,
      );
      if (!methodBc) {
        throw new ComptimeError(
          `comptime: CLEANUP_CALL couldn't resolve '${node.traitName}.${node.methodName}' on ${refStructType?.name ?? "<?>"}`,
          node.sourceLoc,
        );
      }
      // Discard the return value - dispose methods are void.
      const discardReg = ctx.allocReg({ kind: typeKinds.void });
      ctx.emit(
        instruction(OP.CALL_DIRECT, {
          dst: discardReg,
          args: [recvRefReg],
          type: { kind: typeKinds.void },
          immediate: methodBc,
          sourceLoc: node.sourceLoc,
        }),
      );
      return;
    }
    case ASTNodeKind.EXPRESSION_STATEMENT: {
      // The parser wraps a bare `x = y;` as EXPRESSION_STATEMENT
      // { value: ASSIGNMENT }. The result reg of the lowered
      // expression is discarded - the side effect lives in MOVE / other
      // mutation instructions emitted during lowering.
      lowerExpr(node.value, ctx, scope);
      return;
    }
    case ASTNodeKind.IF_STATEMENT: {
      const condReg = lowerExpr(node.expression, ctx, scope);
      const thenLabel = ctx.freshLabel("if_then");
      const elseLabel = ctx.freshLabel("if_else");
      const endLabel  = ctx.freshLabel("if_end");
      ctx.emit(
        instruction(OP.BRCOND, {
          args: [condReg],
          immediate: { then: thenLabel, else: elseLabel },
          sourceLoc: node.sourceLoc,
        }),
      );
      ctx.emit(instruction(OP.LABEL, { immediate: thenLabel }));
      lowerStatement(node.body, ctx, scope);
      ctx.emit(
        instruction(OP.BR, {
          immediate: endLabel,
          sourceLoc: node.sourceLoc,
        }),
      );
      ctx.emit(instruction(OP.LABEL, { immediate: elseLabel }));
      if (node.elseBody) {
        lowerStatement(node.elseBody, ctx, scope);
      }
      ctx.emit(instruction(OP.LABEL, { immediate: endLabel }));
      return;
    }
    case ASTNodeKind.FOR_IN_LOOP: {
      // Trait-driven iteration (Phase 10.B `Iterable<T>`) needs more
      // plumbing - defer to the silent-fallback path until 11.D.
      if (node.iterableImpl) {
        throw new ComptimeError(
          `comptime: for-in over user-defined Iterable<T> is not supported yet (Phase 11.D)`,
          node.sourceLoc,
        );
      }
      // Desugar `for x in arr { body }` to:
      //   let __iter = arr;
      //   let __len = __iter.len;
      //   let __idx: usize = 0;
      //   while (__idx < __len) {
      //       let x = __iter[__idx];
      //       <body>
      //       __idx = __idx + 1;
      //   }
      // The same bytecode primitives (MOVE, ARRAY_LEN, INDEX_LOAD,
      // LABEL/BR/BRCOND) handle this; nothing new at the opcode level.
      const inner = new Scope(scope);

      const iterReg = lowerExpr(node.iterExpr, ctx, scope);
      const iterTy = ctx.registerTypes[iterReg];
      if (iterTy.kind !== typeKinds.array) {
        throw new ComptimeError(
          `comptime: for-in over '${iterTy.kind}' is not supported`,
          node.sourceLoc,
        );
      }
      const elemTy = iterTy.elem;

      // __len = iter.len
      // Use a synthetic primitive type for the usize counter so the
      // ARRAY_LEN op and counter share the same dispatching path.
      const usizeTy = { kind: typeKinds.prim, name: "usize" };
      const lenReg = ctx.allocReg(usizeTy);
      ctx.emit(
        instruction(OP.ARRAY_LEN, {
          dst: lenReg,
          args: [iterReg],
          type: usizeTy,
          sourceLoc: node.sourceLoc,
        }),
      );

      // __idx: usize = 0
      const zeroReg = ctx.allocReg(usizeTy);
      ctx.emit(
        instruction(OP.LITERAL, {
          dst: zeroReg,
          type: usizeTy,
          immediate: { ty: usizeTy, v: 0n },
          sourceLoc: node.sourceLoc,
        }),
      );
      const idxSlotReg = ctx.allocReg(usizeTy);
      ctx.emit(
        instruction(OP.MOVE, {
          dst: idxSlotReg,
          args: [zeroReg],
          type: usizeTy,
          sourceLoc: node.sourceLoc,
        }),
      );

      // Loop variable slot - declared into the inner scope so the
      // body sees `x` as the current element.
      const loopVarSlot = ctx.allocReg(elemTy);
      inner.declare(node.loopVar, loopVarSlot);

      const headLabel = ctx.freshLabel("forin_head");
      const bodyLabel = ctx.freshLabel("forin_body");
      const exitLabel = ctx.freshLabel("forin_exit");

      ctx.emit(instruction(OP.LABEL, { immediate: headLabel }));

      // __idx < __len
      const condReg = ctx.allocReg({ kind: typeKinds.prim, name: "bool" });
      ctx.emit(
        instruction(OP.ICMP_LT, {
          dst: condReg,
          args: [idxSlotReg, lenReg],
          type: { kind: typeKinds.prim, name: "bool" },
          sourceLoc: node.sourceLoc,
        }),
      );
      ctx.emit(
        instruction(OP.BRCOND, {
          args: [condReg],
          immediate: { then: bodyLabel, else: exitLabel },
          sourceLoc: node.sourceLoc,
        }),
      );

      ctx.emit(instruction(OP.LABEL, { immediate: bodyLabel }));

      // x = __iter[__idx]
      const elemReg = ctx.allocReg(elemTy);
      ctx.emit(
        instruction(OP.INDEX_LOAD, {
          dst: elemReg,
          args: [iterReg, idxSlotReg],
          type: elemTy,
          sourceLoc: node.sourceLoc,
        }),
      );
      ctx.emit(
        instruction(OP.MOVE, {
          dst: loopVarSlot,
          args: [elemReg],
          type: elemTy,
          sourceLoc: node.sourceLoc,
        }),
      );

      // body
      lowerStatement(node.body, ctx, inner);

      // __idx = __idx + 1
      const oneReg = ctx.allocReg(usizeTy);
      ctx.emit(
        instruction(OP.LITERAL, {
          dst: oneReg,
          type: usizeTy,
          immediate: { ty: usizeTy, v: 1n },
          sourceLoc: node.sourceLoc,
        }),
      );
      const newIdxReg = ctx.allocReg(usizeTy);
      ctx.emit(
        instruction(OP.IADD, {
          dst: newIdxReg,
          args: [idxSlotReg, oneReg],
          type: usizeTy,
          sourceLoc: node.sourceLoc,
        }),
      );
      ctx.emit(
        instruction(OP.MOVE, {
          dst: idxSlotReg,
          args: [newIdxReg],
          type: usizeTy,
          sourceLoc: node.sourceLoc,
        }),
      );
      ctx.emit(
        instruction(OP.BR, {
          immediate: headLabel,
          sourceLoc: node.sourceLoc,
        }),
      );

      ctx.emit(instruction(OP.LABEL, { immediate: exitLabel }));
      return;
    }

    case ASTNodeKind.SWITCH_STATEMENT: {
      // Lower switch as a linear chain of arm-match-checks. Each
      // pattern compiles to a tag/literal comparison; on match we
      // jump to the arm body (binding payload fields as locals if
      // it's a variant pattern with fieldBindings) and on mismatch
      // fall through to the next pattern / arm / default. Multiple
      // patterns per arm produce an OR chain of compares all
      // targeting the same arm body.
      const scrutReg = lowerExpr(node.scrutinee, ctx, scope);
      const scrutTy = ctx.registerTypes[scrutReg];
      const isEnum = scrutTy.kind === typeKinds.variant;
      const exitLabel = ctx.freshLabel("switch_exit");

      // Pre-allocate per-arm labels so we can branch into them from
      // the pattern-check chain regardless of order.
      const armLabels = node.arms.map((_, i) => ctx.freshLabel(`switch_arm_${i}`));
      const defaultLabel = ctx.freshLabel("switch_default");

      // Materialize the scrutinee's tag once for variant patterns.
      let tagReg = null;
      if (isEnum) {
        tagReg = ctx.allocReg({ kind: typeKinds.prim, name: "int32" });
        ctx.emit(
          instruction(OP.VARIANT_TAG, {
            dst: tagReg,
            args: [scrutReg],
            type: { kind: typeKinds.prim, name: "int32" },
            sourceLoc: node.sourceLoc,
          }),
        );
      }

      // Emit the pattern-check chain. Each per-arm chain ends with a
      // BR to that arm's body label (on match) or falls through to
      // the next arm's checks.
      for (let i = 0; i < node.arms.length; i++) {
        const arm = node.arms[i];
        const armLabel = armLabels[i];
        for (const pat of arm.patterns) {
          if (pat.kind === ASTNodeKind.VARIANT_PATTERN && pat.isWildcard) {
            // `case _:` - unconditional match. Emit a direct BR.
            ctx.emit(instruction(OP.BR, { immediate: armLabel, sourceLoc: pat.sourceLoc }));
            continue;
          }
          if (pat.kind === ASTNodeKind.LITERAL_PATTERN) {
            // Compare scrutinee value against the literal.
            const litTy = scrutTy;
            const litReg = ctx.allocReg(litTy);
            const v =
              pat.literalKind === "int"
                ? (litTy.kind === typeKinds.prim && /int64|uint64|isize|usize|uintptr/.test(litTy.name)
                  ? BigInt(pat.value)
                  : Number(pat.value))
                : pat.literalKind === "bool"
                  ? !!pat.value
                  : pat.value;
            ctx.emit(
              instruction(OP.LITERAL, {
                dst: litReg,
                type: litTy,
                immediate: { ty: litTy, v },
                sourceLoc: pat.sourceLoc,
              }),
            );
            const cmpReg = ctx.allocReg({ kind: typeKinds.prim, name: "bool" });
            ctx.emit(
              instruction(OP.ICMP_EQ, {
                dst: cmpReg,
                args: [scrutReg, litReg],
                type: { kind: typeKinds.prim, name: "bool" },
                sourceLoc: pat.sourceLoc,
              }),
            );
            const nextLabel = ctx.freshLabel(`switch_pat_${i}_next`);
            ctx.emit(
              instruction(OP.BRCOND, {
                args: [cmpReg],
                immediate: { then: armLabel, else: nextLabel },
                sourceLoc: pat.sourceLoc,
              }),
            );
            ctx.emit(instruction(OP.LABEL, { immediate: nextLabel }));
            continue;
          }
          if (pat.kind === ASTNodeKind.VARIANT_PATTERN) {
            // Compare scrutinee.tag against the variant's ordinal.
            const ordReg = ctx.allocReg({ kind: typeKinds.prim, name: "int32" });
            ctx.emit(
              instruction(OP.LITERAL, {
                dst: ordReg,
                type: { kind: typeKinds.prim, name: "int32" },
                immediate: {
                  ty: { kind: typeKinds.prim, name: "int32" },
                  v: pat.resolvedVariant.ordinal | 0,
                },
                sourceLoc: pat.sourceLoc,
              }),
            );
            const cmpReg = ctx.allocReg({ kind: typeKinds.prim, name: "bool" });
            ctx.emit(
              instruction(OP.ICMP_EQ, {
                dst: cmpReg,
                args: [tagReg, ordReg],
                type: { kind: typeKinds.prim, name: "bool" },
                sourceLoc: pat.sourceLoc,
              }),
            );
            const nextLabel = ctx.freshLabel(`switch_pat_${i}_next`);
            ctx.emit(
              instruction(OP.BRCOND, {
                args: [cmpReg],
                immediate: { then: armLabel, else: nextLabel },
                sourceLoc: pat.sourceLoc,
              }),
            );
            ctx.emit(instruction(OP.LABEL, { immediate: nextLabel }));
            continue;
          }
          throw new ComptimeError(
            `comptime: switch pattern kind '${pat.kind}' is not supported yet`,
            pat.sourceLoc,
          );
        }
      }

      // Default arm (or fall-through to exit if no default).
      ctx.emit(instruction(OP.BR, { immediate: defaultLabel, sourceLoc: node.sourceLoc }));

      // Emit each arm body. Variant patterns with fieldBindings
      // extract their payload fields into per-binding slot regs in
      // the arm's local scope. Each arm BRs to exitLabel after the
      // body (the body may also early-return / break).
      for (let i = 0; i < node.arms.length; i++) {
        const arm = node.arms[i];
        ctx.emit(instruction(OP.LABEL, { immediate: armLabels[i] }));
        const armScope = new Scope(scope);
        // For variant patterns, find the (non-wildcard) one to bind from.
        const bindingPat = arm.patterns.find(
          (p) => p.kind === ASTNodeKind.VARIANT_PATTERN && !p.isWildcard && p.fieldBindings,
        );
        if (bindingPat) {
          // Each binding is `{ fieldName, bindingName, isWildcard,
          // resolvedType? }`. fieldName is the variant's payload
          // field; bindingName is the local-scope name to bind.
          // `_` bindings (isWildcard) skip the bind entirely.
          for (const binding of bindingPat.fieldBindings) {
            if (binding.isWildcard) continue;
            const fieldName = binding.fieldName;
            const localName = binding.bindingName;
            // Look up the payload field's declared type from the
            // variant; the binding itself doesn't carry a resolvedType.
            const variant = bindingPat.resolvedVariant;
            const variantField = (variant?.fields ?? []).find(
              (f) => f.name === fieldName,
            );
            const ty = binding.resolvedType ?? variantField?.type;
            if (!ty) {
              throw new ComptimeError(
                `comptime: variant pattern binding '${localName}' has no resolved type`,
                bindingPat.sourceLoc,
              );
            }
            const fieldReg = ctx.allocReg(ty);
            ctx.emit(
              instruction(OP.VARIANT_PAYLOAD_FIELD, {
                dst: fieldReg,
                args: [scrutReg],
                type: ty,
                immediate: fieldName,
                sourceLoc: bindingPat.sourceLoc,
              }),
            );
            // Bind to a stable slot (LET_DECL-shaped) so the body
            // can re-read freely.
            const slotReg = ctx.allocReg(ty);
            ctx.emit(
              instruction(OP.MOVE, {
                dst: slotReg,
                args: [fieldReg],
                type: ty,
                sourceLoc: bindingPat.sourceLoc,
              }),
            );
            armScope.declare(localName, slotReg);
          }
        }
        lowerStatement(arm.body, ctx, armScope);
        ctx.emit(instruction(OP.BR, { immediate: exitLabel, sourceLoc: arm.sourceLoc }));
      }

      // Default arm body. If absent, just jump straight to exit so
      // the switch falls through when no pattern matches.
      ctx.emit(instruction(OP.LABEL, { immediate: defaultLabel }));
      if (node.defaultArm) {
        lowerStatement(node.defaultArm, ctx, new Scope(scope));
      }
      ctx.emit(instruction(OP.BR, { immediate: exitLabel, sourceLoc: node.sourceLoc }));

      ctx.emit(instruction(OP.LABEL, { immediate: exitLabel }));
      return;
    }

    case ASTNodeKind.WHILE_STATEMENT: {
      const headLabel = ctx.freshLabel("while_head");
      const bodyLabel = ctx.freshLabel("while_body");
      const exitLabel = ctx.freshLabel("while_exit");
      ctx.emit(instruction(OP.LABEL, { immediate: headLabel }));
      const condReg = lowerExpr(node.expression, ctx, scope);
      ctx.emit(
        instruction(OP.BRCOND, {
          args: [condReg],
          immediate: { then: bodyLabel, else: exitLabel },
          sourceLoc: node.sourceLoc,
        }),
      );
      ctx.emit(instruction(OP.LABEL, { immediate: bodyLabel }));
      lowerStatement(node.body, ctx, scope);
      ctx.emit(
        instruction(OP.BR, {
          immediate: headLabel,
          sourceLoc: node.sourceLoc,
        }),
      );
      ctx.emit(instruction(OP.LABEL, { immediate: exitLabel }));
      return;
    }
    default:
      throw new ComptimeError(
        `comptime: statement kind '${node.kind}' is not supported yet`,
        node.sourceLoc,
      );
  }
}

// Walk one expression node, append the instructions needed to produce
// its result, and return the register holding that result.
function lowerExpr(node, ctx, scope) {
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

    case ASTNodeKind.TEMPLATE_LITERAL: {
      // Phase 11.E.3: lower each EXPR_PART into a register; build a
      // parts descriptor that interleaves the original STRING_PARTs
      // (literal text) with `{ kind: "expr" }` markers consuming the
      // EXPR_PART registers in source order. TEMPLATE_FORMAT walks
      // both at execution time and concatenates them into a string.
      const argRegs = [];
      const descriptors = [];
      for (const part of node.parts ?? []) {
        if (part.kind === ASTNodeKind.STRING_PART) {
          descriptors.push({ kind: "str", value: decodeStringEscapes(part.value) });
        } else if (part.kind === ASTNodeKind.EXPR_PART) {
          const reg = lowerExpr(part.expr, ctx, scope);
          argRegs.push(reg);
          descriptors.push({ kind: "expr" });
        }
      }
      const ty = node.resolvedType;
      const dst = ctx.allocReg(ty);
      ctx.emit(
        instruction(OP.TEMPLATE_FORMAT, {
          dst,
          args: argRegs,
          type: ty,
          immediate: descriptors,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.STRING_LITERAL: {
      // The parser stores STRING_LITERAL.value INCLUDING the surrounding
      // double-quotes; strip them here. Escape-sequence decoding happens
      // later when the interpreter formats the value or codegen emits the
      // bytes - at the comptime layer we keep the raw inner content.
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
      const lhsReg = lowerExpr(node.left, ctx, scope);
      const rhsReg = lowerExpr(node.right, ctx, scope);
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
      const receiverReg = lowerExpr(node.object, ctx, scope);
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
      const arrReg = lowerExpr(node.object, ctx, scope);
      const idxReg = lowerExpr(node.index, ctx, scope);
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
      // Resolution order: lexical scope (function params + locals)
      // first, then module-level mutable state (only inside an
      // `@precompile { ... }` block - see lowerBlockAsFunction),
      // then module-level folded consts. A miss in all three is
      // unsupported and surfaces as a ComptimeError (silent
      // module-init fallback path).
      const scopeReg = scope ? scope.lookup(node.name) : null;
      if (scopeReg != null) {
        // Auto-deref: when the typechecker has marked this read as
        // going through a ref-typed binding, emit REF_LOAD so the
        // returned register holds the deref'd value rather than the
        // ref itself.
        if (node.autoDeref) {
          const dst = ctx.allocReg(node.resolvedType);
          ctx.emit(
            instruction(OP.REF_LOAD, {
              dst,
              args: [scopeReg],
              type: node.resolvedType,
              sourceLoc: node.sourceLoc,
            }),
          );
          return dst;
        }
        return scopeReg;
      }
      // Phase 11.D.18: read a module-level binding via MODULE_LOAD
      // when the block lowerer has opted-in. The typechecker
      // already tagged the IDENT with `isModuleGlobal +
      // moduleGlobalSym` in checkExpr; we re-use those marks.
      if (ctx.moduleStateNames && node.isModuleGlobal && ctx.moduleStateNames.has(node.moduleGlobalSym)) {
        const dst = ctx.allocReg(node.resolvedType);
        ctx.emit(
          instruction(OP.MODULE_LOAD, {
            dst,
            type: node.resolvedType,
            immediate: { sym: node.moduleGlobalSym, name: node.name },
            sourceLoc: node.sourceLoc,
          }),
        );
        return dst;
      }
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

    case ASTNodeKind.REF_EXPRESSION: {
      // Three legal operand shapes today:
      //   ref ident         → ref a local register slot
      //   ref obj.field     → ref a struct field
      //   ref arr[i]        → ref an array element
      // `ref` of an already-ref-typed value forwards the existing ref.
      const operand = node.operand;
      if (operand.kind === ASTNodeKind.IDENT) {
        const slotReg = scope ? scope.lookup(operand.name) : null;
        if (slotReg == null) {
          throw new ComptimeError(
            `comptime: ref of unknown binding '${operand.name}'`,
            node.sourceLoc,
          );
        }
        // If the IDENT's resolved type is itself a ref, the binding
        // already holds a ref - forward it directly without rewrapping.
        const slotTy = ctx.registerTypes[slotReg];
        if (slotTy.kind === typeKinds.ref) return slotReg;
        const dst = ctx.allocReg(node.resolvedType);
        ctx.emit(
          instruction(OP.REF_LOCAL, {
            dst,
            args: [slotReg],
            type: node.resolvedType,
            immediate: slotReg,
            sourceLoc: node.sourceLoc,
          }),
        );
        return dst;
      }
      if (operand.kind === ASTNodeKind.FIELD_ACCESS) {
        const objReg = lowerExpr(operand.object, ctx, scope);
        const dst = ctx.allocReg(node.resolvedType);
        ctx.emit(
          instruction(OP.REF_FIELD, {
            dst,
            args: [objReg],
            type: node.resolvedType,
            immediate: operand.field,
            sourceLoc: node.sourceLoc,
          }),
        );
        return dst;
      }
      if (operand.kind === ASTNodeKind.INDEX_EXPRESSION) {
        const arrReg = lowerExpr(operand.object, ctx, scope);
        const idxReg = lowerExpr(operand.index, ctx, scope);
        const dst = ctx.allocReg(node.resolvedType);
        ctx.emit(
          instruction(OP.REF_INDEX, {
            dst,
            args: [arrReg, idxReg],
            type: node.resolvedType,
            sourceLoc: node.sourceLoc,
          }),
        );
        return dst;
      }
      throw new ComptimeError(
        `comptime: 'ref' operand shape '${operand.kind}' is not supported yet`,
        node.sourceLoc,
      );
    }

    case ASTNodeKind.ASSIGNMENT: {
      // Three target shapes today: bare identifier, struct field, and
      // array index. Function-param ref deref + nested chains land in
      // later sub-phases.
      const tgt = node.target;
      if (tgt?.kind === ASTNodeKind.IDENT) {
        // Phase 11.D.18: assignment to a module-level binding from
        // inside an `@precompile { ... }` block. The typechecker
        // already stamped `isModuleGlobal + moduleGlobalSym` on
        // the assignment target; emit MODULE_STORE rather than a
        // local-slot MOVE.
        if (
          ctx.moduleStateNames &&
          tgt.isModuleGlobal &&
          ctx.moduleStateNames.has(tgt.moduleGlobalSym)
        ) {
          const valReg = lowerExpr(node.value, ctx, scope);
          ctx.emit(
            instruction(OP.MODULE_STORE, {
              args: [valReg],
              type: ctx.registerTypes[valReg],
              immediate: { sym: tgt.moduleGlobalSym, name: tgt.name },
              sourceLoc: node.sourceLoc,
            }),
          );
          return valReg;
        }
        const slotReg = scope ? scope.lookup(tgt.name) : null;
        if (slotReg == null) {
          throw new ComptimeError(
            `comptime: assignment to unknown binding '${tgt.name}'`,
            node.sourceLoc,
          );
        }
        // Auto-deref-write: when the typechecker has marked the IDENT
        // as a write through a ref binding, lower as REF_STORE rather
        // than MOVE on the ref reg itself.
        if (tgt.autoDerefWrite) {
          const valReg = lowerExpr(node.value, ctx, scope);
          ctx.emit(
            instruction(OP.REF_STORE, {
              args: [slotReg, valReg],
              type: ctx.registerTypes[valReg],
              sourceLoc: node.sourceLoc,
            }),
          );
          return valReg;
        }
        const valReg = lowerExpr(node.value, ctx, scope);
        ctx.emit(
          instruction(OP.MOVE, {
            dst: slotReg,
            args: [valReg],
            type: ctx.registerTypes[slotReg],
            sourceLoc: node.sourceLoc,
          }),
        );
        return slotReg;
      }
      if (tgt?.kind === ASTNodeKind.FIELD_ACCESS) {
        const objReg = lowerExpr(tgt.object, ctx, scope);
        const valReg = lowerExpr(node.value, ctx, scope);
        ctx.emit(
          instruction(OP.FIELD_STORE, {
            args: [objReg, valReg],
            type: ctx.registerTypes[valReg],
            immediate: tgt.field,
            sourceLoc: node.sourceLoc,
          }),
        );
        return valReg;
      }
      if (tgt?.kind === ASTNodeKind.INDEX_EXPRESSION) {
        const arrReg = lowerExpr(tgt.object, ctx, scope);
        const idxReg = lowerExpr(tgt.index, ctx, scope);
        const valReg = lowerExpr(node.value, ctx, scope);
        ctx.emit(
          instruction(OP.INDEX_STORE, {
            args: [arrReg, idxReg, valReg],
            type: ctx.registerTypes[valReg],
            sourceLoc: node.sourceLoc,
          }),
        );
        return valReg;
      }
      throw new ComptimeError(
        `comptime: assignment target shape '${tgt?.kind}' is not supported yet`,
        node.sourceLoc,
      );
    }

    case ASTNodeKind.CALL_EXPRESSION: {
      // Numeric casts are parsed as CALL_EXPRESSION nodes; the
      // typechecker stamps `isCast = true` + `castTargetType`. Route
      // them through the dedicated CAST opcode rather than the
      // function-call infrastructure.
      if (node.isCast) {
        const srcReg = lowerExpr(node.args[0], ctx, scope);
        const dst = ctx.allocReg(node.castTargetType);
        ctx.emit(
          instruction(OP.CAST, {
            dst,
            args: [srcReg],
            type: node.castTargetType,
            sourceLoc: node.sourceLoc,
          }),
        );
        return dst;
      }
      // Phase 11.D.13: VTable.from(ref x) - typechecker stamped
      // `vtableBuilder = { vtableType, implType }`. Pre-resolve each
      // method's bytecode (via the trait method resolver against
      // implType) so the runtime VTABLE_CONSTRUCT just bakes the
      // array into the wrapped value.
      if (node.vtableBuilder) {
        if (!ctx.traitMethodResolver) {
          throw new ComptimeError(
            `comptime: VTable.from() requires a traitMethodResolver`,
            node.sourceLoc,
          );
        }
        const { vtableType, implType } = node.vtableBuilder;
        const methodFns = [];
        for (const methodName of vtableType.methodOrder) {
          const bc = ctx.traitMethodResolver(
            implType,
            vtableType.traitName,
            methodName,
          );
          if (!bc) {
            throw new ComptimeError(
              `comptime: vtable "${vtableType.name}" method "${methodName}" not comptime-evaluable on ${implType.name}`,
              node.sourceLoc,
            );
          }
          methodFns.push(bc);
        }
        const refArg = node.args[0]; // REF_EXPRESSION
        const refReg = lowerExpr(refArg, ctx, scope);
        const dst = ctx.allocReg(vtableType);
        ctx.emit(
          instruction(OP.VTABLE_CONSTRUCT, {
            dst,
            args: [refReg],
            type: vtableType,
            immediate: { methodFns },
            sourceLoc: node.sourceLoc,
          }),
        );
        return dst;
      }
      // Phase 11.D.13: trait method dispatch through a vtable. The
      // typechecker stamped `vtableCall = { vtableType, methodName,
      // fieldIndex }`. The first arg is the vtable receiver (`ref vt`);
      // the rest are user args. Use VTABLE_CALL to look up
      // methodFns[fieldIndex] at runtime and push a frame with ctx
      // as the method's `ref self` param.
      if (node.vtableCall) {
        const { fieldIndex } = node.vtableCall;
        // First arg is `ref vt`; we want the vtable value itself,
        // not the ref. Since REF_EXPRESSION on an IDENT to a
        // vt-typed binding returns the slot reg directly (see
        // lower.js REF_EXPRESSION case), this gives us the vtable
        // wrapped value.
        const vtRefExpr = node.args[0];
        const vtReg = lowerExpr(vtRefExpr.operand, ctx, scope);
        const userArgRegs = (node.args.slice(1)).map((a) => lowerExpr(a, ctx, scope));
        const dst = ctx.allocReg(node.resolvedType);
        ctx.emit(
          instruction(OP.VTABLE_CALL, {
            dst,
            args: [vtReg, ...userArgRegs],
            type: node.resolvedType,
            immediate: { fieldIndex },
            sourceLoc: node.sourceLoc,
          }),
        );
        return dst;
      }
      // Phase 11.D.5: trait method call. The typechecker stamps
      // `calleeMethodOf` (receiver struct type) + `calleeTrait`
      // (trait type) + `calleeMethodName` on these. We dispatch to a
      // dedicated trait-method resolver which finds the method's
      // AST decl in the receiver's TYPE_DECL and lowers its body.
      // Phase 11.D.7: generic function call. The typechecker stamps
      // `genericInstantiation` pointing at the Phase-7.1 registry
      // instance. We use that instance to look up (or build) the
      // monomorphized bytecode body for these args.
      // Falls through to the regular function resolver only for
      // plain CALL_EXPRESSION nodes.
      let resolved;
      if (node.genericInstantiation) {
        if (!ctx.genericInstanceResolver) {
          throw new ComptimeError(
            `comptime: generic function call requires a genericInstanceResolver`,
            node.sourceLoc,
          );
        }
        resolved = ctx.genericInstanceResolver(node.genericInstantiation);
        if (!resolved) {
          throw new ComptimeError(
            `comptime: generic function '${node.callee}' instance is not comptime-evaluable (open instance, unsupported body shape, or failed to lower)`,
            node.sourceLoc,
          );
        }
      } else if (node.calleeMethodOf) {
        if (!ctx.traitMethodResolver) {
          throw new ComptimeError(
            `comptime: trait method call requires a traitMethodResolver`,
            node.sourceLoc,
          );
        }
        resolved = ctx.traitMethodResolver(
          node.calleeMethodOf,
          node.calleeTrait?.name ?? null,
          node.calleeMethodName,
        );
        if (!resolved) {
          throw new ComptimeError(
            `comptime: trait method '${node.calleeTrait?.name ?? "?"}.${node.calleeMethodName}' is not comptime-evaluable`,
            node.sourceLoc,
          );
        }
      } else {
        if (!ctx.fnResolver) {
          throw new ComptimeError(
            `comptime: function call requires a function resolver`,
            node.sourceLoc,
          );
        }
        resolved = ctx.fnResolver(
          node.callee,
          node.calleeModuleId ?? null,
          node.calleeExportName ?? null,
        );
        if (!resolved) {
          throw new ComptimeError(
            `comptime: function '${node.callee}' is not comptime-evaluable (non-whitelisted extern, generic-unresolved, or in a not-yet-lowered module)`,
            node.sourceLoc,
          );
        }
      }
      // Lower arguments left-to-right, collect their result regs in
      // declared-param order. The typechecker has already validated
      // arity + types.
      const argRegs = (node.args ?? []).map((a) => lowerExpr(a, ctx, scope));
      const dst = ctx.allocReg(node.resolvedType);
      // Resolver returns either a BytecodeFunction (user fn) or an
      // extern marker `{ kind: "extern", impl, name }`. Dispatch
      // accordingly. The interpreter has dedicated opcodes for each
      // so the call-time path stays type-checked.
      if (resolved.kind === "extern") {
        ctx.emit(
          instruction(OP.CALL_EXTERN, {
            dst,
            args: argRegs,
            type: node.resolvedType,
            immediate: { name: resolved.name, impl: resolved.impl },
            sourceLoc: node.sourceLoc,
          }),
        );
        return dst;
      }
      // Phase 11.D.9: a call to a task fn has resolvedType Task<T>
      // but the function body returns the inner T. Run the body
      // synchronously inline (CALL_DIRECT) into a fresh T register,
      // then TASK_WRAP that into Task<T> so the dst slot's type
      // matches the AST's stamped resolvedType.
      if (node.resolvedType?.kind === typeKinds.task) {
        const innerTy = node.resolvedType.resultType;
        const innerReg = ctx.allocReg(innerTy);
        ctx.emit(
          instruction(OP.CALL_DIRECT, {
            dst: innerReg,
            args: argRegs,
            type: innerTy,
            immediate: resolved,
            sourceLoc: node.sourceLoc,
          }),
        );
        ctx.emit(
          instruction(OP.TASK_WRAP, {
            dst,
            args: [innerReg],
            type: node.resolvedType,
            sourceLoc: node.sourceLoc,
          }),
        );
        return dst;
      }
      ctx.emit(
        instruction(OP.CALL_DIRECT, {
          dst,
          args: argRegs,
          type: node.resolvedType,
          immediate: resolved,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.TRY_OP: {
      // Phase 11.D.11: enum-shaped `?` propagation. Same-shape only
      // for now - cross-shape needs `Into.into` trait dispatch which
      // lands later. Lower as:
      //   operandReg = <operand>
      //   tag = VARIANT_TAG operandReg
      //   match = tag == Err.ordinal
      //   brcond match → err_branch, else ok_branch
      //   err_branch:
      //     payload = VARIANT_PAYLOAD_FIELD operandReg "error"
      //     errEnum = VARIANT_CONSTRUCT(<return Err shape>, payload)
      //     ret errEnum
      //   ok_branch:
      //     okPayload = VARIANT_PAYLOAD_FIELD operandReg "value"
      //     dst = okPayload
      // Cross-shape `?` is handled below by calling Into.into on
      // the operand's Err payload in the err branch.
      const operandEnum = node.operand.resolvedType;
      if (operandEnum?.kind !== typeKinds.variant) {
        throw new ComptimeError(
          `comptime: '?' operand must be enum-shaped at the bytecode lowerer (got ${operandEnum?.kind})`,
          node.sourceLoc,
        );
      }
      const operandReg = lowerExpr(node.operand, ctx, scope);
      const operandErr = operandEnum.variants.get("Err");
      const operandOk = operandEnum.variants.get("Ok");
      if (!operandErr || !operandOk) {
        throw new ComptimeError(
          `comptime: '?' operand enum doesn't look Result-shaped (missing Ok or Err variant)`,
          node.sourceLoc,
        );
      }

      // Read the tag.
      const tagReg = ctx.allocReg({ kind: typeKinds.prim, name: "int32" });
      ctx.emit(
        instruction(OP.VARIANT_TAG, {
          dst: tagReg,
          args: [operandReg],
          type: { kind: typeKinds.prim, name: "int32" },
          sourceLoc: node.sourceLoc,
        }),
      );
      const ordReg = ctx.allocReg({ kind: typeKinds.prim, name: "int32" });
      ctx.emit(
        instruction(OP.LITERAL, {
          dst: ordReg,
          type: { kind: typeKinds.prim, name: "int32" },
          immediate: {
            ty: { kind: typeKinds.prim, name: "int32" },
            v: operandErr.ordinal | 0,
          },
          sourceLoc: node.sourceLoc,
        }),
      );
      const isErrReg = ctx.allocReg({ kind: typeKinds.prim, name: "bool" });
      ctx.emit(
        instruction(OP.ICMP_EQ, {
          dst: isErrReg,
          args: [tagReg, ordReg],
          type: { kind: typeKinds.prim, name: "bool" },
          sourceLoc: node.sourceLoc,
        }),
      );
      const errLabel = ctx.freshLabel("try_err");
      const okLabel = ctx.freshLabel("try_ok");
      ctx.emit(
        instruction(OP.BRCOND, {
          args: [isErrReg],
          immediate: { then: errLabel, else: okLabel },
          sourceLoc: node.sourceLoc,
        }),
      );

      // Err branch: extract operand's Err payload (if any), build
      // a new Err of the enclosing return type, and RET.
      ctx.emit(instruction(OP.LABEL, { immediate: errLabel }));
      const returnEnum = ctx.currentReturnType;
      if (returnEnum?.kind !== typeKinds.variant) {
        throw new ComptimeError(
          `comptime: '?' used in a function whose return type isn't an enum (current is ${returnEnum?.kind})`,
          node.sourceLoc,
        );
      }
      const returnErr = returnEnum.variants.get("Err");
      const errPayloadFields = operandErr.fields ?? [];
      const retPayloadFields = returnErr?.fields ?? [];
      const fieldRegs = [];
      const fieldNames = [];
      if (node.tryConvert) {
        // Phase 10.E cross-shape: operandErr.error → returnErr.error
        // through `Into<TargetType>.into(ref self)` on the operand
        // payload's struct type. Resolve the Into.into bytecode at
        // lower time via the trait method resolver, then emit a
        // call with `ref payload.error` as `ref self`.
        const opErrField = errPayloadFields[0];
        const retErrField = retPayloadFields[0];
        if (!opErrField || !retErrField) {
          throw new ComptimeError(
            `comptime: cross-shape '?' expects single-field Err on both sides`,
            node.sourceLoc,
          );
        }
        const opErrStruct = opErrField.type;
        if (opErrStruct.kind !== typeKinds.struct) {
          throw new ComptimeError(
            `comptime: cross-shape '?' source Err payload must be a struct (got ${opErrStruct.kind})`,
            node.sourceLoc,
          );
        }
        if (!ctx.traitMethodResolver) {
          throw new ComptimeError(
            `comptime: cross-shape '?' requires a traitMethodResolver to find Into.into`,
            node.sourceLoc,
          );
        }
        const intoBc = ctx.traitMethodResolver(opErrStruct, "Into", "into");
        if (!intoBc) {
          throw new ComptimeError(
            `comptime: cross-shape '?' couldn't resolve Into.into on ${opErrStruct.name}`,
            node.sourceLoc,
          );
        }
        // Build `ref payload.error` (a ref to the enum's payload
        // slot for the err field) and pass as self.
        const selfRefReg = ctx.allocReg({ kind: typeKinds.ref, inner: opErrStruct });
        ctx.emit(
          instruction(OP.VARIANT_PAYLOAD_REF, {
            dst: selfRefReg,
            args: [operandReg],
            type: { kind: typeKinds.ref, inner: opErrStruct },
            immediate: opErrField.name,
            sourceLoc: node.sourceLoc,
          }),
        );
        const convertedReg = ctx.allocReg(retErrField.type);
        ctx.emit(
          instruction(OP.CALL_DIRECT, {
            dst: convertedReg,
            args: [selfRefReg],
            type: retErrField.type,
            immediate: intoBc,
            sourceLoc: node.sourceLoc,
          }),
        );
        fieldRegs.push(convertedReg);
        fieldNames.push(retErrField.name);
      } else {
        // Same-shape: the operand's Err fields map 1:1 to the return
        // Err's fields. The typechecker has already enforced this in
        // the non-tryConvert path.
        for (let i = 0; i < retPayloadFields.length; i++) {
          const declared = retPayloadFields[i];
          const opField = errPayloadFields[i] ?? declared;
          const reg = ctx.allocReg(opField.type);
          ctx.emit(
            instruction(OP.VARIANT_PAYLOAD_FIELD, {
              dst: reg,
              args: [operandReg],
              type: opField.type,
              immediate: opField.name,
              sourceLoc: node.sourceLoc,
            }),
          );
          fieldRegs.push(reg);
          fieldNames.push(declared.name);
        }
      }
      const errReg = ctx.allocReg(returnEnum);
      ctx.emit(
        instruction(OP.VARIANT_CONSTRUCT, {
          dst: errReg,
          args: fieldRegs,
          type: returnEnum,
          immediate: {
            variantName: returnErr.name,
            ordinal: returnErr.ordinal,
            fieldNames,
          },
          sourceLoc: node.sourceLoc,
        }),
      );
      ctx.emit(
        instruction(OP.RET, {
          args: [errReg],
          type: returnEnum,
          sourceLoc: node.sourceLoc,
        }),
      );

      // Ok branch: extract the Ok payload (or no-op for void-Ok) and
      // return that as the TRY_OP's result register.
      ctx.emit(instruction(OP.LABEL, { immediate: okLabel }));
      const okFields = operandOk.fields ?? [];
      if (okFields.length === 0) {
        // void-Ok: the typechecker has typed this as void. Allocate
        // a placeholder register; nothing reads it.
        const dst = ctx.allocReg({ kind: typeKinds.void });
        return dst;
      }
      // Single-field Ok (the common Result-shaped case): unwrap to
      // the field's value. Multi-field Ok payloads would need a
      // wrapper struct here; punt to a later sub-phase.
      if (okFields.length > 1) {
        throw new ComptimeError(
          `comptime: multi-field Ok payload in '?' is not supported yet`,
          node.sourceLoc,
        );
      }
      const okField = okFields[0];
      const dst = ctx.allocReg(okField.type);
      ctx.emit(
        instruction(OP.VARIANT_PAYLOAD_FIELD, {
          dst,
          args: [operandReg],
          type: okField.type,
          immediate: okField.name,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.WAIT_EXPRESSION: {
      // `wait expr` unwraps a Task<T> to T. The operand reg holds
      // the Task<T> (already inline-evaluated at TASK_WRAP time).
      const taskReg = lowerExpr(node.operand, ctx, scope);
      const dst = ctx.allocReg(node.resolvedType);
      ctx.emit(
        instruction(OP.TASK_WAIT, {
          dst,
          args: [taskReg],
          type: node.resolvedType,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.ARRAY_LITERAL: {
      const arrType = node.resolvedType;
      if (arrType?.kind !== typeKinds.array) {
        throw new ComptimeError(
          `comptime: array literal without a resolved ArrayType - typechecker bug?`,
          node.sourceLoc,
        );
      }
      const elemRegs = (node.elements ?? []).map((e) => lowerExpr(e, ctx, scope));
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

    case ASTNodeKind.VARIANT_CONSTRUCTOR: {
      const enumType = node.resolvedVariantType;
      const variant = node.resolvedVariant;
      if (!enumType || !variant) {
        throw new ComptimeError(
          `comptime: variant constructor missing resolved enum/variant`,
          node.sourceLoc,
        );
      }
      // Normalize source-order field assignments to the variant's
      // declared field order - same shape as STRUCT_LITERAL.
      const litFieldByName = new Map();
      for (const f of node.fields ?? []) litFieldByName.set(f.name, f);
      const orderedRegs = [];
      const orderedNames = [];
      for (const declared of variant.fields ?? []) {
        const lf = litFieldByName.get(declared.name);
        if (!lf) {
          throw new ComptimeError(
            `comptime: variant '${variant.name}' missing payload field "${declared.name}"`,
            node.sourceLoc,
          );
        }
        orderedRegs.push(lowerExpr(lf.value, ctx, scope));
        orderedNames.push(declared.name);
      }
      const dst = ctx.allocReg(enumType);
      ctx.emit(
        instruction(OP.VARIANT_CONSTRUCT, {
          dst,
          args: orderedRegs,
          type: enumType,
          immediate: {
            variantName: variant.name,
            ordinal: variant.ordinal,
            fieldNames: orderedNames,
          },
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.STRUCT_LITERAL: {
      const structType = node.resolvedType;
      if (structType?.kind !== typeKinds.struct) {
        throw new ComptimeError(
          `comptime: struct literal without a resolved StructType - typechecker bug?`,
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
        orderedRegs.push(lowerExpr(litField.value, ctx, scope));
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
      const reg = lowerExpr(node.operand, ctx, scope);
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

// Phase 11.E.3: decode the C-style escape sequences the parser left
// untouched in STRING_PART payloads. Codegen relies on printf to do
// this at runtime; the comptime interpreter resolves them here so
// the formatted output matches what the runtime version would emit.
// Covers the escapes the lexer actually preserves: \n, \t, \r, \0,
// \\, \", \', \x{NN}, \u{NNNN}. Unknown escapes pass through with
// the backslash preserved - same as printf's permissive behavior.
function decodeStringEscapes(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== "\\" || i + 1 >= s.length) {
      out += ch;
      i++;
      continue;
    }
    const next = s[i + 1];
    switch (next) {
      case "n": out += "\n"; i += 2; break;
      case "t": out += "\t"; i += 2; break;
      case "r": out += "\r"; i += 2; break;
      case "0": out += "\0"; i += 2; break;
      case "\\": out += "\\"; i += 2; break;
      case '"': out += '"'; i += 2; break;
      case "'": out += "'"; i += 2; break;
      case "`": out += "`"; i += 2; break;
      default:
        out += ch + next;
        i += 2;
        break;
    }
  }
  return out;
}
