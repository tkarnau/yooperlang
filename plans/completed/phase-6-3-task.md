# Phase 6.3 - Task (language sugar)

Part of [phase 6 - kinds](./phase-6-kinds.md). The [6.3-prelude](./phase-6-3-prelude.md) landed the C runtime, the build pipeline, and the `main`-entry `yoop_runtime_init`/`yoop_runtime_shutdown` injection. The runtime ABI is live (9 symbols declared in every emitted module), but no user code can reach it - there's no `task` keyword, no `Task<T>` type, no `wait`. Phase 6.3 closes that gap.

The contract this phase implements lives in [runtime-design.md](./runtime-design.md); the prefix layout the runtime relies on is locked at [§1.a of the prelude plan](./phase-6-3-prelude.md#L144).

## Goal

Three forms of task spawning end to end:

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

task compute(x: int32): int32 {
    return x * x;
}

function main(): int32 {
    // (1) immediate: spawn + inline wait; user sees int32, never the Task<int32>.
    const a = compute(3);
    printf(`a=${a}\n`);

    // (2) joined: stack-allocated Task<int32>, autoJoin at scope end.
    joined d = compute(4);
    const d_val = wait d;
    printf(`d=${d_val}\n`);

    // (3) pooled: heap-allocated, refcounted, can be returned/stored.
    pooled h = compute(5);
    const h_val = wait h;
    printf(`h=${h_val}\n`);

    return 0;
}
```

Expected output:

```
a=9
d=16
h=25
```

The output proves: (1) `task compute(...)` parses as a function declaration whose return type at call sites is `Task<int32>`; (2) the immediate-binding form auto-inserts spawn+wait; (3) `joined d = ...` stack-allocates a `%Task_int32`, submits to the pool, and the explicit `wait d` blocks until the worker stores `25`; (4) `pooled h = ...` does the same against a heap-allocated handle with refcount lifecycle; (5) the runtime joins all workers at `main`'s exit cleanly.

## Scope (what 6.3 sugar does NOT do)

- **No LLVM coroutine intrinsics.** The prelude reserved `-mllvm -enable-coroutines` defensively, and [runtime-design.md §7](./runtime-design.md#L133) describes the coroutine IR shape as the forward-compat target. **MVP scope cut**: 6.3 sugar emits *plain* functions; each task body compiles like a regular function, and the per-task thunk simply calls it. When suspendable bodies land (future phase), the body becomes a coroutine and the thunk drives `coro.resume`. The handle prefix layout, thunk ABI, and runtime are all coroutine-ready; only the body-shape investment is deferred. Documented in [§Out of scope](#out-of-scope) and cross-referenced in `runtime-design.md`.
- **No user-declarable generics.** `Task<T>` is a compiler builtin; users cannot write `function f<T>(x: T): T` in 6.3. Phase 7.
- **No `joined` / `pooled` as user-declared kinds.** They're built-in kind keywords; the parser recognizes them at binding-prefix position. Users cannot redefine them. (Contrast with `disposable` / `scoped` from 6.1/6.2, which are user-declared via `kind { ... }`.)
- **No `wait` inside task bodies.** A `task` function body that contains `wait` is rejected at typecheck with "wait inside task body not supported (deadlock risk; future phase will land coroutine suspension)". Outside `main` and regular functions, `wait` is fine.
- **No `abandon` operator.** [SPEC.md §8](../SPEC.md#L532) sketches `abandon h`; we don't ship it. A `pooled h` that's never `wait`ed simply has its scope-exit release fire; the worker still runs the body and discards the result.
- **No task-args blob size validation past the 32-byte cap.** A `task f(...)` whose args total > 32 bytes is rejected at typecheck per [runtime-design.md §5](./runtime-design.md#L51).
- **No `mustCall { wait; abandon; }` disjunction.** Pooled has no `mustCall` in this revised design - the refcount handles lifecycle.
- **No `mustNotShare` enforcement for `pooled`.** The clause is stored on `KindType` from 6.2 but not enforced; sharing across task bodies is fine because pooled handles are refcounted.
- **No method-call sugar on `Task<T>` (e.g. `h.wait()`).** Only the prefix-operator form `wait h`.
- **No `task` on `main`.** `main` is the program entry; making it a task makes no sense. Rejected at typecheck.
- **No `task` returning `void`.** Every `task` function must return something; `task f(): void` is rejected. (Avoidable, but adds a layout edge case; deferred.)
- **No re-entry into the runtime after `main` exits.** Handles whose `pooled` refcount outlives `main` are a use-after-free; we accept this and document - 6.3-prelude's `yoop_runtime_shutdown` joins all workers before any post-shutdown code can run.

## Status snapshot

After 6.1, 6.2, and the 6.3-prelude:

- **Built-in kinds infrastructure absent.** Existing kinds (`disposable`, `scoped`) are user-declared via `kind k { ... }` and resolved in Pass C.2 against `mod.kindTable`. `joined`/`pooled` need a different shape: they live in a *global* built-in table, are never declared in source, and their clauses are hard-coded. The plan adds a `builtinKindTable` populated at compiler start and consulted *before* `mod.kindTable` in kind-prefix resolution.
- **Function decls flag-extensible.** [parser.js:1339](../src/jsyooparser/parser.js#L1339) `parseFunctionDecl` produces a `FUNCTION_DECL` AST node. Adding `node.isTask = true` (set in the parser when the function is preceded by `task`) flows through every existing pass - no new AST kind needed.
- **No generic types in the language yet.** [types.js](../src/jsyooptypecheck/types.js)'s `StructType` is monomorphic. `Task<T>` is *not* a struct type - it's its own `TaskType { resultType: Type }` node, displayed as `Task<int32>` and codegen'd as `%Task_<TMangled>*` (pointer to a per-result-type aggregate). Adding `TaskType` to `typeKinds` is a one-line change; `formatType` and `typesEqual` need TaskType branches.
- **Runtime-ABI declares already present.** [codegen.js:43-53](../src/jsyoopcodegen/codegen.js#L43) emits the 9 ABI symbols unconditionally. 6.3 sugar just calls them.
- **`main`-entry init/shutdown injection live.** Phase 6.3-prelude landed init at the entry block and shutdown before every `ret` in `main` (including `?`-induced rets). All the existing `cleanups → shutdown → ret` order from [phase-6-3-prelude.md §4.d](./phase-6-3-prelude.md#L583) carries over; we don't touch the ordering.
- **`CLEANUP_CALL` precedent.** kindCheck already injects synthetic nodes at exit points. The same machinery handles `pooled`'s scope-exit release (a synthetic `TASK_RELEASE` node) and `joined`'s scope-exit `wait` (a synthetic `TASK_AUTO_WAIT` node). The flow walker shape from 6.1/6.2 needs minor extension; the cleanup-emission codegen reuses the existing slot.

## Files touched

- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) - 4 new keyword tokens: `task`, `wait`, `joined`, `pooled`.
- [src/contracts.js](../src/contracts.js) - `WAIT_EXPRESSION`, `TASK_AUTO_WAIT`, `TASK_RELEASE`, `TASK_RETAIN`. `FUNCTION_DECL` gains an `isTask: boolean` flag; binding decls gain a richer `kindPrefix.builtin` field.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) - accept `task` modifier before `function`; parse `wait <expr>` as a prefix unary; recognize `joined`/`pooled` at binding-prefix position; reject `Task<T>` as a user-written type annotation (it's compiler-internal).
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) - `TaskType(resultType)`; extensions to `formatType`, `typesEqual`, `llvmType` planning data.
- [src/jsyooptypecheck/builtinKinds.js](../src/jsyooptypecheck/builtinKinds.js) (new) - defines and exports `JOINED_KIND` and `POOLED_KIND` as `KindType`-shaped objects, populated at module load time.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) - Pass A: when `decl.isTask` is set, rewrite the function shell's return type from `T` to `TaskType(T)`; validate `task` constraints (no `task` on `main`, non-void return). Resolve task-args-blob max sizes (per result type) in a new sub-pass C.4.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) - typecheck `WAIT_EXPRESSION`: operand must be `TaskType(T)`, expression's resolved type is `T`. Reject `wait` inside a task body.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js) - handle the immediate-binding rewrite (`const a = task_call();` → an immediate-flavored `Task` binding with auto-wait) and `joined` / `pooled` binding-kind resolution against the built-in table.
- [src/jsyooptypecheck/kindCheck.js](../src/jsyooptypecheck/kindCheck.js) - for `joined` bindings, register a `TASK_AUTO_WAIT` obligation that fires at every exit; for `pooled`, register a `TASK_RELEASE` obligation. Track copy/return sites for `pooled` to insert `TASK_RETAIN` pairs.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) - per-result-type `%Task_<T>` struct emission; per-task-function thunk emission; immediate / joined / pooled binding emission; `WAIT_EXPRESSION` lowering; `TASK_AUTO_WAIT` / `TASK_RELEASE` / `TASK_RETAIN` emission.
- **New** `examples/pass/task_immediate/main.yoop`, `task_joined/main.yoop`, `task_pooled/main.yoop`, `task_three_forms/main.yoop` (the goal program), `task_args_blob/main.yoop`.
- **New** `examples/fail/task_main.yoop`, `task_void.yoop`, `task_args_too_large.yoop`, `wait_non_task.yoop`, `wait_in_task_body.yoop`.

## 1. Lexer

Add to `TokenTags` and `keywordTagList`:

```js
task:    <next-tag>,
wait:    <next-tag>,
joined:  <next-tag>,
pooled:  <next-tag>,
```

All four are reserved keywords; users can't shadow them. No identifier in any pre-6.3 fixture uses these names.

## 2. AST contracts

In [contracts.js](../src/contracts.js)'s `ASTNodeKind`:

```js
WAIT_EXPRESSION:   "WAIT_EXPRESSION",
TASK_AUTO_WAIT:    "TASK_AUTO_WAIT",     // synthetic, from kindCheck
TASK_RELEASE:      "TASK_RELEASE",       // synthetic
TASK_RETAIN:       "TASK_RETAIN",        // synthetic
```

Existing-node extensions:

- `functionDecl.isTask: boolean` - set by parser when `task` modifier precedes the function.
- `letDecl` / `constDecl` `kindPrefix` - extended with an optional `builtin: "joined" | "pooled" | "immediate"` field. The parser sets `builtin` when it sees a built-in keyword; otherwise resolution falls back to the module's user-declared `kindTable`.
- `block.implicitCleanups` (from 6.1) - now also accepts `TASK_AUTO_WAIT` and `TASK_RELEASE` entries.
- `returnStatement.pendingCleanups`, `tryOp.pendingCleanups` - same.

## 3. Parser

### 3.a `task` modifier on functions

In `parseTopLevel` / `parseFunctionDecl`, accept a leading `task` keyword:

```
functionDecl :=
    ("task")? "function" IDENT "(" params ")" ":" type "{" body "}"
```

When `task` is seen, consume it and set `node.isTask = true`. Reject `task` before non-function tokens (`task type ...`, `task const ...`) with a parse error: "`task` modifier is only valid before `function`".

### 3.b `wait` prefix operator

`wait` is a prefix unary operator at expression position:

```
unary := "wait" unary | "ref" unary | ... | postfix
```

Precedence: same as `ref` (very tight). `wait wait h` parses (typecheck will reject if inner is not `Task<Task<T>>`, which is also disallowed). Parser produces:

```js
{ kind: "WAIT_EXPRESSION", operand: <expr>, sourceLoc }
```

### 3.c `joined` / `pooled` at binding-prefix position

In `parseVarDecl`, the existing kindPrefix-lookahead already detects `IDENT IDENT :`. We extend the lookahead to also fire on `joined IDENT =` and `pooled IDENT =` - the `: type` annotation is **omitted** for these forms, because the type is inferred from the task-call RHS (`Task<T>` is compiler-internal). Form:

```
joinedBinding := "joined" IDENT "=" expr ";"
pooledBinding := "pooled" IDENT "=" expr ";"
```

`kindPrefix.builtin` is set to `"joined"` or `"pooled"`. No trailing block is permitted (the kind doesn't declare `ownsBlock`).

A `joined` or `pooled` followed by `: type =` is parsed but rejected at typecheck with "joined/pooled bindings infer their type from the task call".

### 3.d Reject user-written `Task<T>`

The user cannot annotate a binding as `: Task<int32>` directly. Phase 6.3 has no generic-type-annotation parser; `Task` in type position is an unknown type. The error surfaces from the existing "unknown type" path - no parser change needed. (If a user writes `joined h: Task<int32> = ...;`, the annotation is the issue, not `Task` itself.)

## 4. Types

### 4.a `TaskType`

In [types.js](../src/jsyooptypecheck/types.js):

```js
export function TaskType(resultType) {
  this.kind = "task";
  this.resultType = resultType;
}
```

Add `"task"` to `typeKinds`. `formatType(t)` returns `Task<${formatType(t.resultType)}>`. `typesEqual(a, b)`: both `task` and `typesEqual(a.resultType, b.resultType)`.

`llvmType(TaskType)` returns `ptr` everywhere: the runtime ABI deals in `void*`, and at the LLVM level a stack-allocated handle's slot is a `%Task_<T>` aggregate but the SSA value carrying it across calls is a `ptr`. The struct layout is emitted separately by codegen (per result type).

### 4.b Built-in kinds - `joined` and `pooled`

New file [src/jsyooptypecheck/builtinKinds.js](../src/jsyooptypecheck/builtinKinds.js):

```js
import { KindType } from "./types.js";

export const JOINED_KIND = new KindType("joined", "<builtin>");
JOINED_KIND.appliesTo = new Set(["binding"]);
JOINED_KIND.builtin = true;
JOINED_KIND.autoJoin = true;          // synthetic clause; not parseable

export const POOLED_KIND = new KindType("pooled", "<builtin>");
POOLED_KIND.appliesTo = new Set(["binding"]);
POOLED_KIND.builtin = true;
POOLED_KIND.refcounted = true;        // synthetic clause; not parseable

export function lookupBuiltinKind(name) {
  if (name === "joined") return JOINED_KIND;
  if (name === "pooled") return POOLED_KIND;
  return null;
}
```

Kind-prefix resolution becomes: built-in lookup first, then `mod.kindTable`. A user `kind joined { ... }` decl is rejected at parse - `joined` is now a reserved keyword.

## 5. Typechecker

### 5.a Pass A - task function shells

In the function-shell loop, when `d.isTask`:

1. Validate name: reject `task function main(...)` with "task cannot be applied to main".
2. Validate return type is non-void.
3. Build the FuncType with `returnType = TaskType(declaredReturnType)`.
4. The body inside the function still types its `return` statements against `declaredReturnType` (the raw `T`). Only the *external signature* is `Task<T>`.

Implementation note: store both `node.declaredReturnType` (the user-written `T`) and `node.funcType.returnType` (`TaskType(T)`). Body typechecking uses the former; call-site resolution uses the latter.

### 5.b Pass C.4 - task-args-blob sizing

After Pass C.3 (impl validation) and before Pass D (body validation), walk all `task` function decls. For each unique result-type `T`, compute the max args-blob size across all task functions returning `T`. Store on the module's `taskMetaTable: Map<TypeKey, { argsBlobSize: number, resultType: Type }>`.

Per-task validation: a task whose args total > 32 bytes is rejected at typecheck.

Sizing rule (per [runtime-design.md §5](./runtime-design.md#L51)): walk the param list; size each LLVM type (primitives by width, structs by their resolved size, refs/arrays as 8 bytes - actually 16 for arrays since they're fat pointers); sum; round up to 8-byte alignment.

### 5.c Pass D - body validation, wait expression, immediate/joined/pooled bindings

**WAIT_EXPRESSION**:
- Typecheck operand. Operand must have type `TaskType(T)`. Resulting type is `T`.
- If the enclosing function is a `task` function (tracked via `typeContext.inTaskBody`), reject: "wait inside task body not supported".

**Immediate binding** (`const a = task_call();`):
- When the RHS is a call to a `task` function, the RHS's resolved type is `TaskType(T)`. Normally that would type-mismatch against a `T`-typed binding, but for the immediate case we rewrite:
  - The binding's type is the *unwrapped* `T`.
  - The AST node carries `node.immediateTaskCall = true` so codegen knows to spawn+wait inline.
- The trigger is: binding has no `kindPrefix`, no explicit type annotation, and RHS is `CALL_EXPRESSION` whose callee is a task function. Other shapes (assigning a `Task<T>` to a different variable) keep the `Task<T>` type and require a `pooled` prefix.

**Joined binding** (`joined d = task_call();`):
- `kindPrefix.builtin === "joined"`.
- RHS must resolve to `TaskType(T)` (i.e. a call to a task function). Other RHS shapes rejected.
- Binding's resolved type is `TaskType(T)` itself - `d` is a handle. The user writes `wait d` to materialize.
- Register an autoJoin obligation in kindCheck.

**Pooled binding** (`pooled h = task_call();`):
- `kindPrefix.builtin === "pooled"`.
- RHS must be `TaskType(T)`.
- Binding's resolved type is `TaskType(T)`. The handle is heap-allocated, refcounted.
- Register a release obligation in kindCheck (always fires at scope exit). Track copy sites (assignments, return-passes) and require retain insertion.

### 5.d No `wait` inside task body

In `validateFunction`, when entering a `task` function's body, push `inTaskBody = true` on `typeContext`. `WAIT_EXPRESSION` checks this flag and rejects.

## 6. kindCheck

Extend the flow walker with two new obligation kinds:

```js
// joined: autoJoin at scope end (synthesized TASK_AUTO_WAIT at every exit)
// pooled: release at scope end (synthesized TASK_RELEASE)
// pooled: retain on copy/return (synthesized TASK_RETAIN inserted at copy sites)
```

For `joined`:
- On binding declaration, push obligation `{ kind: "autoWait", bindingName, taskResultType }`.
- At every exit point (block fall-through, return, `?`-fail), emit `TASK_AUTO_WAIT` node referencing the binding. (The existing `pendingCleanups` / `implicitCleanups` arrays carry these alongside `CLEANUP_CALL`.)
- `wait d` inside the scope is a manual wait. The autoJoin still fires at scope exit - but on a handle whose `state == 1`, `yoop_task_wait` is a no-op (one mutex+condvar check). Acceptable.
- The autoJoin also calls `yoop_task_free_sync_pair` to release the stack handle's mutex/cond allocations.

For `pooled`:
- On binding declaration, push obligation `{ kind: "release", bindingName, taskResultType }`.
- At every exit point, emit `TASK_RELEASE`.
- Track copy/return sites: assignment of a pooled-tracked binding to another binding, return of a pooled binding, pass of a pooled binding as an argument. Each becomes a `TASK_RETAIN` insertion point. For 6.3 we minimize: support `return h` (one retain inserted before return), and reject assignment-to-another-binding outright in 6.3 ("pooled-to-pooled assignment deferred"). Pass-as-argument is also deferred. Goal: keep the lifecycle obvious; future phases widen.

The walker code:

```js
// in walkStatement, for LET_DECL/CONST_DECL with builtin kind:
const builtin = stmt.kindPrefix?.builtin;
if (builtin === "joined") {
  topFrame.obligations.push({
    kind: "autoWait",
    bindingName: stmt.name,
    taskResultType: stmt.resolvedType.resultType,
    sourceLoc: stmt.sourceLoc,
  });
} else if (builtin === "pooled") {
  topFrame.obligations.push({
    kind: "release",
    bindingName: stmt.name,
    sourceLoc: stmt.sourceLoc,
  });
}
```

`makeCleanupCall` / equivalent translator maps obligation kinds to AST nodes (CLEANUP_CALL, TASK_AUTO_WAIT, TASK_RELEASE).

## 7. Codegen

### 7.a `%Task_<T>` struct emission

After regular struct emission, walk `moduleEnv.taskMetaTable` and emit one `%Task_<TMangled>` per unique result type, with the locked prefix layout from [phase-6-3-prelude.md §1.a](./phase-6-3-prelude.md#L144):

```llvm
%Task_int32 = type {
  ptr,           ; 0: thunk
  i8,            ; 8: state (padded to 8)
  i32,           ; 12: refcount
  ptr,           ; 16: mutex_ptr
  ptr,           ; 24: cond_ptr
  i32,           ; 32: result slot (T-dependent)
  [N x i8]       ; args blob
}
```

Padding: state is `i8` at offset 8, then 3 bytes pad, then `i32` refcount at 12. LLVM auto-aligns; we add an explicit `i32` field after state for compact layout. Easier: declare as `{ ptr, i8, [3 x i8], i32, ptr, ptr, <T>, [N x i8] }`.

`TMangled` is a mangled string: `int32`, `i64`, `Point`, etc. Use the existing `mangleTypeName` shape or extend it.

### 7.b Per-task-function thunk emission

For each `task function foo(args): T`, codegen emits two things:

1. The body itself as a regular LLVM function `@<modId>__foo` returning `T`, taking `args` normally. (No coroutine; plain function call.)
2. A thunk `@<modId>__foo__thunk(ptr %ts)` that:
   - GEPs into the handle's args blob at offset 32.
   - Loads each arg from the blob.
   - Calls `@<modId>__foo(args)`.
   - GEPs into the handle's result slot.
   - Stores the result.
   - Calls `@yoop_handle_signal_done(ptr %ts)`.

```llvm
define void @<modId>__foo__thunk(ptr %ts) {
entry:
  %args_ptr = getelementptr i8, ptr %ts, i64 32
  %x_ptr = bitcast ptr %args_ptr to ptr  ; or just use ptr
  %x = load i32, ptr %x_ptr
  %r = call i32 @<modId>__foo(i32 %x)
  %result_ptr = getelementptr i8, ptr %ts, i64 <result_offset>
  store i32 %r, ptr %result_ptr
  call void @yoop_handle_signal_done(ptr %ts)
  ret void
}
```

`<result_offset>` is computed from the struct layout: prefix is 32 bytes, then T, then args blob - so result is always at offset 32. Wait - that conflicts with args at 32. Looking again at [§5 of runtime-design.md](./runtime-design.md#L51), the layout is `{prefix, result_slot, args_blob}` with result at offset 32, args at offset 32 + sizeof(T) (padded). Re-check the prelude prefix spec.

The prelude (§1.a) puts result slot + args blob "at offset 32"; the runtime never touches past offset 24+8 = 32. So result is at 32, args follow. The thunk's GEP for args is `32 + sizeof(T)` (padded to 8). For `T = int32`: result at 32, args at 40.

Codegen tracks `resultOffset = 32`, `argsOffset = 32 + paddedSize(T)`.

### 7.c Call-site lowering - three forms

A call to a task function appears in source as a `CALL_EXPRESSION`. The codegen for that call is overloaded by the **binding context**:

**Immediate** (binding has `immediateTaskCall = true`):
- Allocate `%Task_<T>` on the stack (`alloca`).
- Initialize prefix fields: thunk ptr at offset 0; state = 0; refcount = 0 (stack handle); mutex/cond left null (filled by submit).
- Store args into the args blob.
- Call `@yoop_task_submit(ptr %task_alloca, ptr @<modId>__foo__thunk)`.
- Call `@yoop_task_wait(ptr %task_alloca)`.
- Load result from offset 32. The result is the value bound to the user-facing `const a`.
- Call `@yoop_task_free_sync_pair(ptr %task_alloca)` to release the mutex/cond allocation.

**Joined binding** (`joined d = call`):
- Same alloca + init + submit as immediate.
- *Do not* wait inline. The binding's slot points to the alloca.
- `wait d` lowers to `@yoop_task_wait(ptr %slot)` plus a load of the result slot.
- At scope exit, kindCheck-inserted `TASK_AUTO_WAIT` lowers to `wait` (if not already waited) followed by `yoop_task_free_sync_pair`.
  - "If not already waited" is a runtime no-op: calling `wait` twice is fine (the second sees state=1 and returns immediately). Don't track manually.
- Note: the `wait d` expression evaluates the loaded result and returns it.

**Pooled binding** (`pooled h = call`):
- Call `@yoop_task_alloc(i64 <sizeof Task_T>)`. Returns `ptr`.
- Write thunk ptr; store args into args blob. State is already 0 from `calloc`; refcount is 2 from `yoop_task_alloc`.
- Call `@yoop_task_submit(ptr %h, ptr @thunk)`.
- The binding's slot is a `ptr` (an alloca holding the heap pointer).
- `wait h` lowers to `@yoop_task_wait(ptr %h)` + load result.
- At scope exit, kindCheck-inserted `TASK_RELEASE` lowers to `@yoop_task_release(ptr %h)`.
- `return h` (pooled-out-of-function): kindCheck inserts a retain before return so the caller has its own reference. The scope-exit release still fires (the retain rebalances).

### 7.d `WAIT_EXPRESSION`

For `wait <expr>`:

1. Emit `<expr>` to get a `ptr` to the handle.
2. `call void @yoop_task_wait(ptr %h)`.
3. GEP into handle's result slot at offset 32 and load. The load yields the `T` value.

### 7.e `TASK_AUTO_WAIT` / `TASK_RELEASE` / `TASK_RETAIN` emission

These are synthesized AST nodes; codegen treats them like `CLEANUP_CALL`:

- `TASK_AUTO_WAIT`: `call void @yoop_task_wait(ptr %slot)` + `call void @yoop_task_free_sync_pair(ptr %slot)`.
- `TASK_RELEASE`: `call void @yoop_task_release(ptr %h)`.
- `TASK_RETAIN`: `call void @yoop_task_retain(ptr %h)`.

They appear in `block.implicitCleanups`, `returnStatement.pendingCleanups`, etc. - same plumbing as 6.1's CLEANUP_CALL.

### 7.f Ordering at exit points

The existing 6.1/6.2/6.3-prelude ordering is `[disposable cleanups, ...] → shutdown → ret`. For 6.3, we extend:

At every `ret` in any function:
1. Pending cleanups in LIFO order: that includes `TASK_AUTO_WAIT` for joined, `TASK_RELEASE` for pooled, `CLEANUP_CALL` for disposable/scoped, and `TASK_RETAIN` for pooled-being-returned (the retain fires *before* its corresponding release).
2. If in `main`: `call void @yoop_runtime_shutdown()`.
3. `ret <ty> <val>`.

The single-list LIFO order from kindCheck already gives us this - we just need to ensure pooled-return's retain fires before its release (kindCheck inserts retain into `pendingCleanups` ahead of the release that's already there).

## 8. Tests

### 8.1 Pass fixtures - `examples/pass/`

#### `task_immediate/main.yoop`

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }
task compute(x: int32): int32 { return x * x; }
function main(): int32 {
    const a = compute(3);
    printf(`a=${a}\n`);
    return 0;
}
```

Expected: `a=9`.

#### `task_joined/main.yoop`

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }
task compute(x: int32): int32 { return x * x; }
function main(): int32 {
    joined d = compute(4);
    const v = wait d;
    printf(`d=${v}\n`);
    return 0;
}
```

Expected: `d=16`. Also verifies: `yoop_task_free_sync_pair` fires at scope end without leaks (verify under valgrind manually).

#### `task_pooled/main.yoop`

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }
task compute(x: int32): int32 { return x * x; }
function main(): int32 {
    pooled h = compute(5);
    const v = wait h;
    printf(`h=${v}\n`);
    return 0;
}
```

Expected: `h=25`. Verifies: heap alloc + release lifecycle.

#### `task_three_forms/main.yoop` - the goal program from §Goal.

#### `task_no_args/main.yoop` - task with zero args.

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }
task seven(): int32 { return 7; }
function main(): int32 {
    const v = seven();
    printf(`v=${v}\n`);
    return 0;
}
```

Expected: `v=7`. Verifies the args-blob = 0 byte path.

#### `task_multiple_calls/main.yoop` - many tasks of the same function, exercising the queue.

```yoop
task compute(x: int32): int32 { return x * x; }
function main(): int32 {
    const a = compute(1);
    const b = compute(2);
    const c = compute(3);
    return a + b + c; // 1 + 4 + 9 = 14
}
```

Expected exit code: 14.

### 8.2 Fail fixtures - `examples/fail/`

| Fixture | Trigger |
|---|---|
| `task_on_main.yoop` | `task function main(): int32 { ... }` |
| `task_void_return.yoop` | `task function f(): void { ... }` |
| `wait_non_task.yoop` | `const x: int32 = 1; wait x;` |
| `wait_in_task_body.yoop` | `task function f(): int32 { wait something; return 0; }` |
| `joined_no_task_rhs.yoop` | `joined d = 5;` |
| `pooled_no_task_rhs.yoop` | `pooled h = 5;` |
| `task_args_too_large.yoop` | `task f(a: bigStruct): int32 { ... }` where bigStruct > 32 bytes |
| `joined_with_type_annotation.yoop` | `joined d: int32 = compute(1);` |

### 8.3 Regression

Every existing `examples/pass/*` fixture must still pass. The 6.3-prelude fixtures (`runtime_linked`, `runtime_qmark_in_main`, `runtime_disposable_in_main`) in particular continue to work - they don't use `task` so they emit identical IR up to runtime init/shutdown.

## 9. Verification

1. `npm test` - full test suite passes.
2. Manual: `node ./src/yoopiler.js -i examples/pass/task_three_forms/main.yoop -o /tmp/out && /tmp/out` prints the expected three lines.
3. Loop run: `for i in $(seq 1 1000); do /tmp/out > /dev/null || break; done` - no hangs, no crashes.
4. (Optional, Linux) valgrind: zero leaks beyond the pre-existing `yoop_runtime_init` ones, which were already valgrind-clean in 6.3-prelude.

## 10. Out of scope <a id="out-of-scope"></a>

- **LLVM coroutine emission.** Task bodies compile as plain LLVM functions. When suspendable bodies land (future phase), each task body becomes a coroutine: the body shape changes, the thunk changes (drives `coro.resume`), but the handle prefix layout, runtime ABI, and call-site lowering stay identical. The current scheme is forward-compatible because the runtime contract doesn't depend on body shape.
- **`abandon`** - fire-and-forget. Easy follow-up; `pooled` already supports the lifecycle via release-on-scope-exit, so `const _ = task_call();` would work today as a "discard" form once `_` bindings reach this code path.
- **Pass `pooled` as argument; assign `pooled` to another `pooled`.** Both rejected in 6.3 with "deferred". Codegen retain/release works in principle; the kindCheck plumbing to track copy sites across the function body is the missing piece - substantive but non-blocking. Lift in 6.4 alongside `propagates<Task>` containers.
- **`task` returning structs.** The MVP supports primitive return types (int, bool, float). Struct returns require the result slot to accommodate the struct layout - straightforward in codegen but multiplies the test surface. Lift after primitive returns ship.
- **Nested `task`s** (a task function calling another task function and awaiting). The deadlock surface from [runtime-design.md §10.a](./runtime-design.md#L278). 6.3 rejects `wait` inside task body outright; future suspension lifts.
- **Cancellation, work-stealing, I/O multiplexing** - all per [runtime-design.md §11](./runtime-design.md#L289), permanently future-phase.
