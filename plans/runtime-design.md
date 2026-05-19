# Runtime design — concurrency

> Implementation contract for Yooper's concurrency runtime. The language surface (kinds, `task`, `wait`, binding forms) is described in [SPEC.md §6](../SPEC.md#L356) and [§8](../SPEC.md#L532); this document describes what the compiler emits, what gets linked, and how the pieces interact at runtime.

## 1. Purpose and scope

Phase 6.3 of the [roadmap](./roadmap.md) introduces tasks — values whose work may be performed on another thread. This is the first language feature with execution-time semantics that aren't trivially lowered to a single C call. To keep the design tractable and the language stable, the runtime contract is captured here as a separate document from the language spec.

In scope:

- The `Task<T>` struct layout the compiler emits per result type.
- The pthread-based worker pool (`runtime/yoop_runtime.c`).
- The runtime ABI yoopiler emits `declare`s for.
- The LLVM coroutine intrinsic shape every `task` function uses.
- Refcount semantics for `pooled` handles.
- Init/shutdown injection in `main`.
- Cross-platform threading (POSIX + Windows).

Out of scope (future runtime work):

- I/O multiplexing (epoll/kqueue/io_uring/IOCP).
- Suspendable task bodies (a task hitting `wait` mid-body and yielding the worker).
- Work-stealing scheduling.
- Cancellation / cancellation tokens.
- ABI versioning across compiler revisions.

## 2. Concurrency model

- **Long-term target**: full async — worker thread pool plus I/O multiplexing.
- **MVP** (what 6.3 ships): run-to-completion tasks on pthreads. Once a task body starts on a worker, it runs straight through. No suspension.
- **Forward compatibility**: every `task` function compiles through LLVM's coroutine intrinsics from day one. MVP tasks never actually suspend — they execute their single body and end — but the IR shape is the same one suspendable tasks will use. When suspension lands later, user `wait` inside a task body becomes a `coro.suspend`; no IR re-shape required.

## 3. Worker pool

- **Structure**: central FIFO queue plus N worker threads. Workers pop from the queue and execute. Simple, suited to run-to-completion workloads. Forward-compatible with work-stealing later if profiling justifies it.
- **Pool size**: at `yoop_runtime_init()`, the runtime queries the OS for online CPUs (`sysconf(_SC_NPROCESSORS_ONLN)` on POSIX; `GetSystemInfo` on Windows). The `YOOP_NUM_WORKERS` env var overrides at runtime — set to `1` to serialize for debugging.
- **Queue**: a single shared FIFO protected by one mutex + one condvar. Workers `cond_wait` while empty; submitters `cond_signal` on push. Stays simple for the MVP; can swap to a lock-free MPMC queue later without changing the ABI.

## 4. Handle allocation

The binding kind chosen at the call site decides where the `Task<T>` struct lives.

| Binding form | Storage | Refcount? | Why |
|---|---|---|---|
| `let x = f()` (immediate) | stack alloca | no | spawn + inline wait happen in the same statement; no escape, single owner. |
| `let joined d = f()` | stack alloca | no | autoJoin guarantees wait fires before scope exit; the binding and worker release at the same point. |
| `let pooled h = f()` | `yoop_task_alloc` (heap) | yes | the handle is a value-typed citizen — returnable, storable, copyable. Lifetime can exceed the declaring scope. |

For `pooled`, codegen special-cases `Task<T>` in every assignment, return, parameter pass, and scope-exit to emit retain/release pairs. This is a small ARC-like mechanism scoped to `Task<T>` only; no other type in the language is refcounted in 6.3.

## 5. `Task<T>` struct layout

The compiler emits **one** `%Task_<TMangled>` struct type per unique result type `T` reached by a `task` function in the program. Layout (LLVM types; field order is normative):

```llvm
%Task_<TMangled> = type {
  ptr,            ; 0: thunk function pointer — void (*)(ptr task_struct)
  i8,             ; 1: state — 0 = unstarted, 1 = done. Atomic.
  i32,            ; 2: refcount — atomic. Used by pooled handles; unused for joined/immediate.
  ptr,            ; 3: opaque pointer to platform mutex (from yoop_runtime.h)
  ptr,            ; 4: opaque pointer to platform condvar (from yoop_runtime.h)
  <T>,            ; 5: result slot — sized and aligned to T
  [N x i8]        ; 6: args blob — N is the max args-blob size for any task function returning T, padded to 8-byte alignment
}
```

Notes:

- **Mutex/condvar are heap pointers, not embedded**: pthread_mutex_t and CRITICAL_SECTION have different sizes; embedding them would force codegen to know platform sizes. yoop_task_alloc / yoop_task_submit allocate them via the C runtime. For stack-allocated handles (`joined`/immediate), `yoop_task_submit` allocates the mutex+condvar pair separately and stores the pointers in the struct. `yoop_task_wait` (or the autoJoin call) frees them on scope exit.
- **Args blob N**: computed per result type by walking the program once at codegen time. All task functions returning `T` share a max. Programs whose largest task signature returning `T` has args totaling 12 bytes get `N = 16` (padded). Hard cap: 32 bytes per signature. Larger task signatures are rejected at typecheck with "task argument blob exceeds inline limit (phase 6.3)"; phase 7 lifts via heap-pointer args.
- **Result slot offset**: known to codegen because the struct layout is fixed. The thunk writes the result via GEP into field 5.
- **State transitions**: `0 → 1` exactly once, by the thunk, just before the worker signals the condvar. Read under the handle's mutex by `yoop_task_wait`.

## 6. Runtime ABI

The complete set of C symbols yoopiler emits `declare` lines for. Defined in `runtime/yoop_runtime.h`, implemented in `runtime/yoop_runtime.c`.

```c
// ----- init / shutdown -----
// yoopiler injects calls to these in user's main.
// init: spawns N worker threads, initializes the queue.
// shutdown: signals workers to exit, joins them, frees queue.
void yoop_runtime_init(void);
void yoop_runtime_shutdown(void);

// ----- scheduling -----
// Submit a task for execution.
//   handle: pointer to a Task<T> struct (caller-allocated; alloca for joined/immediate,
//           yoop_task_alloc for pooled). Caller has populated thunk pointer, state=0,
//           and args blob before submit.
//   thunk:  the per-task-function thunk that runs the body. Also stored on the handle;
//           passed explicitly here so the queue doesn't need to GEP.
// On submit, the worker takes a logical reference (the second of the initial
// refcount=2 for pooled handles). The runtime allocates the handle's mutex and
// condvar before pushing onto the queue.
void yoop_task_submit(void* handle, void (*thunk)(void*));

// ----- blocking await -----
// Called from user code (compiled `wait h`) or compiler-inserted (joined autoJoin,
// immediate spawn+wait). Reads state under the handle's mutex; if state == 0,
// blocks on the condvar until state == 1. Returns after the worker has stored
// the result.
void yoop_task_wait(void* handle);

// ----- pooled lifecycle -----
// yoop_task_alloc: malloc + zero. Initializes refcount to 2 (caller + worker).
// yoop_task_retain: atomic refcount increment.
// yoop_task_release: atomic refcount decrement; if it hits 0, frees the mutex,
//                    condvar, and the handle itself. The worker calls release after
//                    storing its result and signaling.
void* yoop_task_alloc(size_t size);
void  yoop_task_retain(void* handle);
void  yoop_task_release(void* handle);
```

### 6.a Refcount lifecycle for pooled handles

```
yoop_task_alloc       -> refcount = 2 (caller + worker)
yoop_task_submit      -> no refcount change; worker reference is the +1 from alloc
each copy/assignment  -> yoop_task_retain (atomic inc)
each scope-exit       -> yoop_task_release (atomic dec)
worker thunk finishes -> yoop_task_release (atomic dec, after storing result + signaling)
refcount == 0         -> free mutex, condvar, handle
```

`yoop_task_wait` does *not* release the caller's ref — the caller's binding still owns it; the binding's scope-exit handles the release. This means waiting and then dropping costs two ref ops, intentional for compositional correctness (the user can wait, inspect the result, then keep the handle alive if they want to copy it elsewhere).

### 6.b Why not heap-allocate everything

Heap-allocating `joined` and immediate would be uniform but wasteful: their lifetimes are statically known and bounded by the function frame. Stack alloca is one instruction; heap alloc is a malloc + later free, plus contention on the allocator. The kind system already proves these handles can't escape — leverage that proof.

## 7. LLVM coroutine intrinsics

Every `task` function compiles to an LLVM coroutine. Even in the MVP where bodies never suspend, the coroutine shape is what the IR uses. This is the single biggest forward-compatibility investment: when suspension lands, user-reachable `wait` inside a task body becomes a `coro.suspend` and the rest of the IR stays unchanged.

### 7.a The intrinsics yoopiler emits

For a task function `task f(args): T { body }`, codegen emits an LLVM coroutine with the standard intrinsics:

- `@llvm.coro.id` — declare a coroutine; returns a token used by other intrinsics.
- `@llvm.coro.size.i64` / `@llvm.coro.alloc` — coroutine frame allocation (the size is computed by LLVM after the splitter runs; for MVP the size is small because nothing crosses suspend points).
- `@llvm.coro.begin` — enters the coroutine, returns the handle.
- `@llvm.coro.suspend` — at every yield point. **MVP has zero of these inside the body**; the only suspend is the implicit "final suspend" (`@llvm.coro.suspend` with `final = true`) at the end so the runtime can read the result before the coroutine destroys itself.
- `@llvm.coro.end` — terminates the coroutine.
- `@llvm.coro.resume` — invoked by `yoop_task_wait` (via the thunk) to drive the coroutine forward. MVP resume runs the whole body and reaches the final suspend.
- `@llvm.coro.destroy` — called by `yoop_task_release` to tear down the coroutine frame.

### 7.b Sample IR sketch for `task compute(x: int32): int32 { return x * x }`

```llvm
; The body, compiled as a coroutine.
define i32 @<modId>__compute(i32 %x) presplitcoroutine {
entry:
  %id    = call token @llvm.coro.id(i32 0, ptr null, ptr null, ptr null)
  %size  = call i64 @llvm.coro.size.i64()
  %mem   = call ptr @malloc(i64 %size)
  %hdl   = call ptr @llvm.coro.begin(token %id, ptr %mem)

  %r     = mul i32 %x, %x
  ; Store result via the task handle pointer (passed-in side channel — see 7.c).

  ; Final suspend so the resumer can observe completion before destroy.
  %final = call i8 @llvm.coro.suspend(token none, i1 true)
  switch i8 %final, label %suspend [ i8 0, label %resume i8 1, label %cleanup ]

resume:
  br label %cleanup
cleanup:
  %unused = call ptr @llvm.coro.free(token %id, ptr %hdl)
  call void @free(ptr %unused)
  br label %suspend
suspend:
  %ret = call i1 @llvm.coro.end(ptr %hdl, i1 false)
  ret i32 %r
}
```

### 7.c The per-task thunk

The body itself is *not* what the worker calls. The worker calls a small **thunk** generated alongside each task function that:

1. Unpacks args from the handle's args blob (at codegen-known offsets).
2. Invokes the body's `coro.resume` until the coroutine reaches its final suspend.
3. Reads the result and stores it into the handle's result slot.
4. Sets state = 1 under the mutex; signals the condvar.
5. For pooled handles: calls `yoop_task_release`.

```llvm
define void @<modId>__compute__thunk(ptr %ts) {
  ; load args
  %args_ptr = getelementptr %Task_int32, ptr %ts, i32 0, i32 6
  %x_slot   = bitcast ptr %args_ptr to ptr
  %x        = load i32, ptr %x_slot

  ; allocate + start the coroutine for the body
  %hdl = call ptr @<modId>__compute__start(i32 %x)
  call void @llvm.coro.resume(ptr %hdl)   ; runs body to final suspend

  ; read result from the coroutine's frame (helper getter generated by yoopiler)
  %r = call i32 @<modId>__compute__result(ptr %hdl)
  call void @llvm.coro.destroy(ptr %hdl)

  ; store result, set state, signal
  %result_ptr = getelementptr %Task_int32, ptr %ts, i32 0, i32 5
  store i32 %r, ptr %result_ptr
  call void @yoop_handle_signal_done(ptr %ts)
  ret void
}
```

`yoop_handle_signal_done` is a small helper in the C runtime that takes the mutex, sets state = 1, signals the condvar, and (for pooled handles, detected via refcount field nonzero) calls release.

### 7.d Lowering pipeline

yoopiler invokes clang with the coroutine passes enabled:

```sh
clang program.ll runtime/yoop_runtime.c \
      -lpthread -O2 \
      -mllvm -enable-coroutines \
      -o program
```

(LLVM ≥ 16 enables coroutines by default at `-O1`+; the explicit flag is defensive across versions.)

### 7.e Why coroutines for run-to-completion

Strictly, the MVP could emit plain functions (no coroutine intrinsics) and call the body directly from the thunk. The coroutine wrapper is overhead for the run-to-completion case. We accept this overhead because:

1. **The optimizer eliminates most of it.** A coroutine with no real suspend points and a `final = true` suspend is heavily simplified by LLVM's coro passes — much of the frame allocation collapses.
2. **Future-compat.** When suspension lands, every existing `task` function works without re-codegen. User code that adds a mid-body `wait` becomes a real `coro.suspend`, the runtime drives `coro.resume` from the worker pool, and nothing else changes.
3. **One IR shape to test.** Two paths (plain functions for MVP, coroutines for the suspend-aware future) doubles the testing surface and risks the future migration breaking subtle invariants.

## 8. Init and shutdown

yoopiler injects two calls into the user's `main`:

- `call void @yoop_runtime_init()` at the top of `main`'s entry block, before any user code.
- `call void @yoop_runtime_shutdown()` immediately before every `ret` in `main` (including those reached via `?` early-return).

`yoop_runtime_init` is idempotent (a static initialized flag guards re-entry); calling it twice is a no-op. `yoop_runtime_shutdown` joins all worker threads and drains the queue. Programs that exit via `exit(...)` from FFI never reach `yoop_runtime_shutdown` — the OS reaps the worker threads. This is acceptable for the MVP; the worker threads have no resources outside their own stacks.

Programs without a `main` function are rejected at typecheck (Yooper requires a `main` returning `int32`). No standalone-library builds in 6.3.

## 9. Cross-platform shim

Single source file `runtime/yoop_runtime.c` with `#ifdef _WIN32` paths. The platform-specific surface is small:

| Concept | POSIX | Windows |
|---|---|---|
| Mutex type | `pthread_mutex_t` | `CRITICAL_SECTION` |
| Condvar type | `pthread_cond_t` | `CONDITION_VARIABLE` |
| Thread type | `pthread_t` | `HANDLE` |
| Thread create | `pthread_create` | `CreateThread` |
| Thread join | `pthread_join` | `WaitForSingleObject` + `CloseHandle` |
| Atomic ops | `<stdatomic.h>` | `<stdatomic.h>` (MSVC ≥ recent) or `_Interlocked*` intrinsics |
| CPU count | `sysconf(_SC_NPROCESSORS_ONLN)` | `GetSystemInfo` → `dwNumberOfProcessors` |
| Env read | `getenv` | `getenv` (works on both) |

A small set of typedefs and inline wrappers in `runtime/yoop_runtime.h` (`yoop_mutex_t`, `yoop_cond_t`, `yoop_thread_t`, plus `yoop_mutex_lock`, `yoop_cond_wait`, etc.) hides this from the rest of the runtime. Total platform-specific code: ~50–100 lines.

Build invocation stays the same on both platforms; `-lpthread` is omitted on Windows.

## 10. Wait semantics and the deadlock surface

`yoop_task_wait`:

1. Takes the handle's mutex.
2. If `state == 1`, releases mutex and returns.
3. Otherwise, `cond_wait` on the condvar (which atomically releases the mutex and blocks).
4. On wakeup, re-checks state, repeats until done.
5. Releases mutex and returns.

This is a textbook condvar pattern. It works correctly across the worker pool boundary: the worker takes the mutex, sets state = 1, signals, releases mutex.

### 10.a Nested-wait deadlock

If a `task` function body itself calls `wait` on another task handle, the worker thread blocks. With a pool of N workers, you can deadlock by submitting tasks A₁..Aₙ that all wait for task B, while B is queued behind A_n. All workers are blocked; B never starts.

The MVP **accepts this risk**. Mitigations:

- Oversize the pool. `YOOP_NUM_WORKERS=64` on a 4-core machine costs little and absorbs deep wait chains.
- Prefer composing tasks at non-task call sites (in `main` or in regular functions). The deadlock only bites when waits stack inside task bodies.
- Document the risk in SPEC.md §8.

The clean fix is suspendable wait inside task bodies — which is what the coroutine IR shape enables. When that lands, a `wait` inside a task body becomes a `coro.suspend` that returns the worker to the pool until the awaited handle is ready. No code in 6.3 paints us into a corner here.

## 11. What this design does NOT do

- **No I/O multiplexing.** Tasks are CPU work units. I/O calls inside a task body block the worker thread. Future phase: integrate epoll/kqueue/io_uring/IOCP so I/O calls cooperatively yield.
- **No abandon or cancellation.** Tasks always run to completion. `_ = task_call()` lowers to spawn-then-drop-ref; the worker still runs the body and discards the result. If the language needs cancellation later, it'll be its own sub-phase (likely cancellation tokens passed as parameters).
- **No work-stealing.** Central FIFO queue. Workers contend on one mutex. Acceptable until profiling shows contention; then we'd swap the queue for a lock-free MPMC or per-worker queues + stealing.
- **No suspendable bodies.** Run-to-completion only. The coroutine IR shape is the forward-compat investment for this.
- **No structured exception handling.** A task body that crashes (segfault, abort, unhandled FFI error) leaves its handle's state at 0 forever. Anyone calling `wait` on it blocks forever. Phase 7 runtime work addresses this — likely by reserving a `state = 2 (crashed)` value and propagating to the waiter.
- **No introspection.** No `yoop_runtime_stats()`, no per-task tracing hooks. Add when there's a user need.

## 12. Glossary

- **task function** — a function declared with the `task` kind prefix (e.g., `task fetch(url: string): Bytes { ... }`). Its return type at call sites is `Task<T>`.
- **Task<T>** — the compiler-builtin handle type produced by a task call. Carries a thunk pointer, state, optional refcount, mutex/condvar pointers, result slot, and args blob.
- **handle** — a `Task<T>` value. Storage is stack or heap depending on the binding kind.
- **immediate** — `let x = f()` with no kind prefix; compiler inserts wait inline, user-facing type is `T`.
- **pooled** — `let pooled h = f()`; user gets a `Task<T>` value (refcounted, copyable, returnable).
- **joined** — `let joined d = f()`; compiler inserts wait at scope end (autoJoin); user-facing type is `T` (materialized on first read or scope-end, whichever comes first).
- **autoJoin** — kind clause that registers a compiler-inserted `wait` at scope exit.
- **worker** — one of N pthread (or CreateThread) threads running the central queue loop.
- **thunk** — per-task-function helper that unpacks args, drives the coroutine, stores the result, signals completion.
- **submit** — push a handle + thunk onto the queue; a worker eventually pops and runs the thunk.

## 13. Critical files (for implementation)

- **New**: `runtime/yoop_runtime.h` — type declarations, function prototypes.
- **New**: `runtime/yoop_runtime.c` — worker pool, queue, mutex/condvar shims, refcount lifecycle.
- **Edit**: `src/yoopiler.js` (driver) — add `runtime/yoop_runtime.c` to the clang invocation; pass coroutine-enabling flags.
- **Edit**: `src/jsyoopcodegen/codegen.js` — per-task-function thunk + coroutine emission; per-result-type `Task_<T>` struct emission; call-site lowering; retain/release insertion for pooled; main-entry init/shutdown injection.
- **Edit**: `src/jsyooptypecheck/types.js` — `TaskType { resultType }` as a compiler builtin.
- **Edit**: `src/jsyooptypecheck/checkExpr.js` — task-call return-type rewrite to `Task<T>`; `wait` expression check.
- **Edit**: `src/jsyooptypecheck/checkStatement.js` — kind-prefixed function decl handling; pooled / joined / immediate binding shapes.
- **Edit**: `src/jsyooptypecheck/kindCheck.js` — autoJoin obligation insertion; refcount-pair planning for pooled bindings (the flow walker tracks which Task<T>-typed identifiers need retain on copy / release on scope exit).

The language-sugar work above is detailed separately in the revised `phase-6-3-task.md` plan (to be written after this doc, SPEC.md, and roadmap.md are updated).
