# Phase 6.3-prelude - Concurrency runtime

Part of [phase 6 - kinds](./phase-6-kinds.md). Phase 6.1 landed `disposable` (kind decls, `binding`-site flow analysis, LIFO cleanup emission). Phase 6.2 landed `scoped` (multi-site `appliesTo`, parameter kinds, `mustNotEscape`). Both are pure compile-time analyses - the runtime side of the language is still the same single-threaded C ABI the compiler has emitted since phase 1. Phase 6.3 (the big one) adds `task` functions, `Task<T>` handles, and `wait`. Those land in two halves: this prelude builds the C runtime and the build pipeline; phase 6.3 (language sugar) builds the syntax and the codegen that drives the runtime.

The full implementation contract for the runtime is in [runtime-design.md](runtime-design.md); this plan is the step-by-step landing of that contract.

## Goal

Land the entire C runtime described in [runtime-design.md §3-§10](runtime-design.md#L34), wire it into the build pipeline, and inject `yoop_runtime_init` / `yoop_runtime_shutdown` around `main`. Ship **no** surface-language changes - there is no `task` keyword yet, no `Task<T>` type, no `wait` operator. Verification is: an existing phase-1 program still compiles, still runs, and now links against the runtime; codegen-injected init/shutdown calls execute cleanly with zero tasks submitted.

Goal program - the existing [examples/test.yoop](../examples/test.yoop) (or any pass fixture from phases 1-6.2), unchanged:

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

function main(): int32 {
    printf(`hello\n`);
    return 0;
}
```

`yoopiler hello.yoop` must:

1. Emit LLVM IR that starts `main` with `call void @yoop_runtime_init()` before any user code, and that emits `call void @yoop_runtime_shutdown()` immediately before every `ret` reachable from `main`.
2. Invoke clang with `runtime/yoop_runtime.c` added to the compilation unit list, with `-lpthread` on POSIX (omitted on Windows), and with whatever flags are needed to keep the LLVM coroutine passes available for phase 6.3 (`-mllvm -enable-coroutines` defensively).
3. Produce an executable that prints `hello`, exits cleanly with status 0, and (verified under `valgrind --leak-check=full`) leaks no memory and joins all worker threads.

Companion runtime-only smoke test, written in C and run via the test harness (§9):

```c
// runtime/tests/smoke.c
#include "yoop_runtime.h"
int main(void) {
    yoop_runtime_init();
    yoop_runtime_shutdown();
    return 0;
}
```

Compiled with `clang runtime/yoop_runtime.c runtime/tests/smoke.c -lpthread -o smoke && ./smoke` exits 0 and (under TSan and valgrind) reports no races, no leaks, no fd leaks.

These two checks together prove: (1) the worker pool initializes and tears down cleanly with zero work submitted; (2) the codegen-injected init/shutdown calls reach a real symbol at link time; (3) the cross-platform shim builds; (4) the build pipeline knows to compile and link the runtime alongside `.ll` output.

## Why this is the prelude

Two reasons.

1. **The C runtime is independently testable.** A worker pool with submit / wait / refcount lifecycle has zero dependence on the compiler. It can be written, exercised under sanitizers, and validated against the contract in [runtime-design.md](runtime-design.md) without a single `.yoop` file. Splitting it out of phase 6.3 means the language-sugar work in 6.3 begins with a known-good runtime - the only thing 6.3 has to debug is the LLVM IR it emits, not the C it links against.

2. **It de-risks 6.3's IR work.** Phase 6.3 emits coroutine intrinsics, a per-result-type `Task_<T>` struct, per-task-function thunks, and call-site refcount pairs. Each of those is a non-trivial new pattern in `codegen.js`. Doing them in the same phase as building the runtime and the build pipeline would interleave three concerns - IR shape, C ABI, linker invocation - and any failure would touch all three. With the prelude in place, 6.3 turns into "make codegen emit IR that calls these symbols correctly," which is one concern.

The prelude also lets us land the build-pipeline change (yoopiler invokes clang with an additional C file) in isolation. Today the driver compiles a single `.ll` file; after the prelude it compiles the `.ll` plus `runtime/yoop_runtime.c` in one clang invocation. That's a small but non-trivial driver change; doing it without the IR-emission noise of 6.3 makes the diff readable.

## Scope (what 6.3-prelude does NOT do)

- **No `task` keyword.** The lexer, parser, typechecker, and codegen do not recognize `task` as a kind-prefix or as a function modifier in this phase. Phase 6.3 (sugar) introduces it.
- **No `Task<T>` type.** Codegen never emits `%Task_int32`-style struct declarations. The compiler-builtin `TaskType` ([types.js](../src/jsyooptypecheck/types.js)) is not introduced here.
- **No per-task-function thunk emission.** Codegen never emits `@<modId>__<fn>__thunk` symbols. The runtime declares `yoop_task_submit(void*, void(*)(void*))` and is ready to receive thunk pointers, but no thunks exist yet.
- **No LLVM coroutine intrinsic emission.** The build pipeline is configured so coroutine passes are available (clang flag wired up, LLVM ≥ 16 assumed), but codegen does not emit `@llvm.coro.*` calls. Phase 6.3 turns those on per-`task`-function.
- **No `joined` / `pooled` / `wait` binding/operator codegen.** Those depend on `Task<T>`; deferred to 6.3.
- **No call-site refcount-pair insertion.** `yoop_task_retain` / `yoop_task_release` exist in the runtime, are declared in the IR, and have unit tests via the C smoke test. Codegen never inserts calls to them - there are no pooled handles yet.
- **No I/O multiplexing, no work stealing, no cancellation, no suspendable bodies, no introspection** - all permanently out of 6.3's scope per [runtime-design.md §11](runtime-design.md#L289), and certainly out of the prelude.
- **No ABI versioning.** The runtime exposes a flat set of C symbols. If a future phase needs to change them, callers re-link against the matching runtime. There is no compatibility surface to maintain in 6.3-prelude.
- **No init injection outside `main`.** Programs without a `main` are already rejected at typecheck ([roadmap.md](roadmap.md#L243), [SPEC.md](../SPEC.md)); the prelude doesn't relax this. Standalone libraries are a phase 7 concern.
- **No env-var documentation in SPEC.md.** `YOOP_NUM_WORKERS` is a runtime knob, not a language feature; it lives in `runtime-design.md` only.

## Status snapshot

After phases 1-6.2, the compiler has the hooks the prelude needs:

- **Single clang invocation.** [yoopiler.js:51-60](../src/yoopiler.js#L51-L60) calls `clang` with the temp `.ll` and the `linkFlags` collected from `extern "C" from library "..."` directives. Adding the runtime is one extra file in the argv array and one extra link flag (`-lpthread` on POSIX).
- **`main` is special-cased in codegen.** [codegen.js:1594](../src/jsyoopcodegen/codegen.js#L1594) and [codegen.js:1598](../src/jsyoopcodegen/codegen.js#L1598) detect `main` and emit it with an unmangled symbol. The same detection is the hook for "if this function is `main`, inject init at entry and shutdown before every ret."
- **`declare` line emission.** [codegen.js:1226-1238](../src/jsyoopcodegen/codegen.js#L1226-L1238) emits `declare` lines for every extern. The runtime ABI is six symbols ([runtime-design.md §6](runtime-design.md#L74)) - they get emitted from the same path, hardcoded into codegen as "always declare these six, regardless of user code."
- **Return-statement codegen has one site.** Every `ret` in `main` flows through one helper that emits the `ret <ty> <val>` instruction. Inserting the `call void @yoop_runtime_shutdown()` immediately before that instruction, only when the enclosing function is `main`, is one conditional.
- **Test harness.** [roadmap.md:228](roadmap.md#L228) plans an `examples/{pass,fail}/` regression runner. Phase 6.3-prelude extends it with a `runtime/tests/` directory for C-level smoke tests run via `make` or a small node script.

## Files touched

- **New** `runtime/yoop_runtime.h` - type declarations (`yoop_mutex_t`, `yoop_cond_t`, `yoop_thread_t`), function prototypes for the ABI. ~80 lines.
- **New** `runtime/yoop_runtime.c` - worker pool, FIFO queue, mutex/condvar shim (POSIX + Windows `#ifdef`s), refcount lifecycle, init/shutdown. ~300-400 lines.
- **New** `runtime/tests/smoke.c` - C-level no-op test (init / shutdown round-trip).
- **New** `runtime/tests/submit_one.c` - C-level test that submits one no-op task, waits, releases. Verifies the full happy path without compiler involvement.
- **New** `runtime/tests/submit_many.c` - C-level test that submits N (~1000) no-op tasks, waits each. Exercises queue contention.
- **New** `runtime/tests/refcount.c` - C-level test that exercises retain / release pairs, including the release-from-worker-thread path.
- **New** `runtime/tests/run_tests.sh` (or a node script) - drives the C tests; runs each under valgrind on Linux and under TSan when available.
- **Edit** [src/yoopiler.js](../src/yoopiler.js) - extend the clang invocation to include `runtime/yoop_runtime.c`; add `-lpthread` to the link flags on POSIX; add `-mllvm -enable-coroutines` defensively.
- **Edit** [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) - emit runtime-ABI `declare` lines unconditionally at module top; inject `call void @yoop_runtime_init()` at `main`'s entry block; inject `call void @yoop_runtime_shutdown()` before every `ret` in `main`.
- **New** `examples/pass/runtime_linked/` - minimal yoop fixture that proves a no-task program still works with the runtime linked in.
- **Edit** [plans/roadmap.md](roadmap.md) - clarify that 6.3-prelude lands C runtime + build pipeline + init/shutdown injection only; Task<T>/thunk/coroutine emission moves to 6.3 (sugar). (Already noted in [phase-6-kinds.md](phase-6-kinds.md#L52); a one-line edit in roadmap.md to mirror the split.)

## 1. The runtime header - `runtime/yoop_runtime.h`

The header is the single source of truth for both the C runtime's internal compilation unit and the LLVM `declare` lines codegen emits. Keep it minimal - type aliases plus function prototypes - so the LLVM-side and C-side stay in lockstep.

```c
// runtime/yoop_runtime.h
#ifndef YOOP_RUNTIME_H
#define YOOP_RUNTIME_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// --- platform-typedef block (opaque to ABI callers) ---
// Concrete types live in yoop_runtime.c. Pointers only cross the ABI boundary.
typedef struct yoop_mutex yoop_mutex_t;
typedef struct yoop_cond  yoop_cond_t;
typedef struct yoop_thread yoop_thread_t;

// --- init / shutdown ---
void yoop_runtime_init(void);
void yoop_runtime_shutdown(void);

// --- scheduling ---
void yoop_task_submit(void* handle, void (*thunk)(void*));
void yoop_task_wait(void* handle);

// --- pooled lifecycle ---
void* yoop_task_alloc(size_t size);
void  yoop_task_retain(void* handle);
void  yoop_task_release(void* handle);

// --- thunk-callable helper (called from per-task thunks emitted by 6.3) ---
// Sets state=1 under the handle's mutex, signals the condvar, and (if the
// handle's refcount field is nonzero - i.e. pooled) calls yoop_task_release.
void yoop_handle_signal_done(void* handle);

#ifdef __cplusplus
}
#endif

#endif
```

Notes:

- **No `Task_<T>` struct in the header.** That layout is the compiler's responsibility ([runtime-design.md §5](runtime-design.md#L51)); the runtime touches only field offsets it can compute from a `void*` plus codegen-known offsets, *or* via small accessor helpers the C runtime exposes. To keep the runtime layout-agnostic, the contract is: the first three fields of any `Task_<T>` struct are always `(thunk ptr, state i8, refcount i32)` in that order, at offsets 0, 8, 12 with natural alignment. The runtime reads those offsets directly; everything past field 2 is the compiler's problem.
- **`yoop_handle_signal_done` is the only ABI symbol that didn't appear in the prose of [runtime-design.md §6](runtime-design.md#L74).** It's referenced in [§7.c](runtime-design.md#L180) as the thunk's "signal done" helper. Promoting it to a named ABI symbol means the thunks emitted by 6.3 don't have to inline mutex/condvar bookkeeping - they just `call void @yoop_handle_signal_done(ptr %ts)` after storing the result. This is a small but real simplification of phase 6.3's IR emission.
- **All handles are `void*` across the ABI.** The struct layout differs per result type, but the runtime never dereferences past the layout-stable prefix. This keeps the runtime free of `Task_<T>` knowledge.

### 1.a Handle prefix layout (load-bearing for the runtime)

The runtime relies on this fixed prefix; codegen in 6.3 must lay every `Task_<T>` struct out compatibly. Field byte offsets are normative - the runtime hardcodes them.

| Offset | Size | Field | Atomicity |
|---|---|---|---|
| 0 | 8 | `thunk` (`void (*)(void*)`) | unsynchronized - written once before submit |
| 8 | 1 | `state` (`uint8_t`, 0=unstarted, 1=done) | atomic; written under mutex by worker, read under mutex by waiter |
| 9 | 3 | padding | - |
| 12 | 4 | `refcount` (`int32_t`) | atomic; 0 in stack-allocated handles, ≥1 in pooled |
| 16 | 8 | `mutex_ptr` (`yoop_mutex_t*`) | unsynchronized - written once by `yoop_task_submit`, freed once on last release |
| 24 | 8 | `cond_ptr` (`yoop_cond_t*`) | unsynchronized - same lifecycle as `mutex_ptr` |
| 32 | … | result slot + args blob (compiler-owned) | - |

Phase 6.3's codegen must emit `Task_<T>` types whose `result_slot` starts at offset 32 and whose args blob follows. Mismatch is a runtime UB. Stretch: have the runtime expose `yoop_task_prefix_size()` returning `32` and assert at startup; cheaper than adding ABI versioning.

## 2. The runtime body - `runtime/yoop_runtime.c`

Single compilation unit; `#ifdef _WIN32` carves out the platform code. Targeted size ~300-400 lines.

### 2.a Platform shim - types and primitives

```c
#ifdef _WIN32
  #include <windows.h>
  struct yoop_mutex  { CRITICAL_SECTION cs; };
  struct yoop_cond   { CONDITION_VARIABLE cv; };
  struct yoop_thread { HANDLE h; };

  static inline void yoop_mutex_init(yoop_mutex_t* m)    { InitializeCriticalSection(&m->cs); }
  static inline void yoop_mutex_destroy(yoop_mutex_t* m) { DeleteCriticalSection(&m->cs); }
  static inline void yoop_mutex_lock(yoop_mutex_t* m)    { EnterCriticalSection(&m->cs); }
  static inline void yoop_mutex_unlock(yoop_mutex_t* m)  { LeaveCriticalSection(&m->cs); }

  static inline void yoop_cond_init(yoop_cond_t* c)      { InitializeConditionVariable(&c->cv); }
  static inline void yoop_cond_destroy(yoop_cond_t* c)   { /* no-op on Windows */ }
  static inline void yoop_cond_wait(yoop_cond_t* c, yoop_mutex_t* m) {
      SleepConditionVariableCS(&c->cv, &m->cs, INFINITE);
  }
  static inline void yoop_cond_signal(yoop_cond_t* c)    { WakeConditionVariable(&c->cv); }
  static inline void yoop_cond_broadcast(yoop_cond_t* c) { WakeAllConditionVariable(&c->cv); }

  static int yoop_cpu_count(void) {
      SYSTEM_INFO si; GetSystemInfo(&si);
      return (int)si.dwNumberOfProcessors;
  }
#else
  #include <pthread.h>
  #include <unistd.h>
  struct yoop_mutex  { pthread_mutex_t m; };
  struct yoop_cond   { pthread_cond_t  c; };
  struct yoop_thread { pthread_t       t; };

  static inline void yoop_mutex_init(yoop_mutex_t* m)    { pthread_mutex_init(&m->m, NULL); }
  static inline void yoop_mutex_destroy(yoop_mutex_t* m) { pthread_mutex_destroy(&m->m); }
  static inline void yoop_mutex_lock(yoop_mutex_t* m)    { pthread_mutex_lock(&m->m); }
  static inline void yoop_mutex_unlock(yoop_mutex_t* m)  { pthread_mutex_unlock(&m->m); }

  static inline void yoop_cond_init(yoop_cond_t* c)      { pthread_cond_init(&c->c, NULL); }
  static inline void yoop_cond_destroy(yoop_cond_t* c)   { pthread_cond_destroy(&c->c); }
  static inline void yoop_cond_wait(yoop_cond_t* c, yoop_mutex_t* m) {
      pthread_cond_wait(&c->c, &m->m);
  }
  static inline void yoop_cond_signal(yoop_cond_t* c)    { pthread_cond_signal(&c->c); }
  static inline void yoop_cond_broadcast(yoop_cond_t* c) { pthread_cond_broadcast(&c->c); }

  static int yoop_cpu_count(void) { return (int)sysconf(_SC_NPROCESSORS_ONLN); }
#endif

#include <stdatomic.h>
// Atomic 8-bit and 32-bit loads/stores used on the handle prefix:
#define A_LOAD_U8(p)      atomic_load_explicit((_Atomic uint8_t*)(p),  memory_order_acquire)
#define A_STORE_U8(p, v)  atomic_store_explicit((_Atomic uint8_t*)(p), (v), memory_order_release)
#define A_INC_I32(p)      atomic_fetch_add_explicit((_Atomic int32_t*)(p), 1, memory_order_acq_rel)
#define A_DEC_I32(p)      atomic_fetch_sub_explicit((_Atomic int32_t*)(p), 1, memory_order_acq_rel)
```

Notes:

- **The mutex/cond structs are heap-allocated.** `yoop_task_submit` allocates them via `malloc` and stores the pointers in the handle prefix at offsets 16 and 24. Embedding `pthread_mutex_t` directly in the `Task_<T>` struct is rejected (different sizes per platform) - [runtime-design.md §5](runtime-design.md#L67) is explicit. The heap-allocated pair adds two `malloc`s per submit; acceptable for the MVP, and revisitable if profiling shows it hurts.
- **`stdatomic.h` is required.** MSVC supports `<stdatomic.h>` in recent versions; if support is missing on a target Windows toolchain, fall back to `_Interlocked*` intrinsics (file-local `#ifdef`, not exposed to the ABI). For 6.3-prelude we require a `<stdatomic.h>`-capable compiler and document it in [runtime-design.md §9](runtime-design.md#L246).

### 2.b Worker pool - globals, init, shutdown

```c
typedef struct task_node {
    void* handle;
    void  (*thunk)(void*);
    struct task_node* next;
} task_node;

static struct {
    int            initialized;        // 0/1; guarded by init_mutex.
    int            shutdown;           // 0/1; tells workers to exit.
    int            n_workers;
    yoop_thread_t* workers;            // length n_workers.

    yoop_mutex_t   queue_mu;
    yoop_cond_t    queue_cv;           // signaled on push and on shutdown.
    task_node*     queue_head;
    task_node*     queue_tail;
} g_rt;

static yoop_mutex_t init_mutex;        // statically initialized (PTHREAD_MUTEX_INITIALIZER on POSIX;
                                       // InitOnceExecuteOnce on Windows).
```

#### `yoop_runtime_init`

Idempotent. Returns immediately if `g_rt.initialized == 1`.

```c
void yoop_runtime_init(void) {
    yoop_mutex_lock(&init_mutex);
    if (g_rt.initialized) {
        yoop_mutex_unlock(&init_mutex);
        return;
    }

    int n = yoop_cpu_count();
    const char* env = getenv("YOOP_NUM_WORKERS");
    if (env && *env) {
        int v = atoi(env);
        if (v > 0) n = v;
    }
    if (n < 1) n = 1;

    g_rt.n_workers  = n;
    g_rt.shutdown   = 0;
    g_rt.queue_head = NULL;
    g_rt.queue_tail = NULL;
    yoop_mutex_init(&g_rt.queue_mu);
    yoop_cond_init(&g_rt.queue_cv);

    g_rt.workers = (yoop_thread_t*)malloc(sizeof(yoop_thread_t) * n);
    for (int i = 0; i < n; i++) {
        spawn_worker(&g_rt.workers[i]);
    }

    g_rt.initialized = 1;
    yoop_mutex_unlock(&init_mutex);
}
```

`spawn_worker` is the platform-specific thread spawn (`pthread_create` / `CreateThread`) wrapping `worker_loop` (§2.c).

#### `yoop_runtime_shutdown`

Signals workers, joins them, frees queue, marks uninitialized.

```c
void yoop_runtime_shutdown(void) {
    yoop_mutex_lock(&init_mutex);
    if (!g_rt.initialized) {
        yoop_mutex_unlock(&init_mutex);
        return;
    }

    yoop_mutex_lock(&g_rt.queue_mu);
    g_rt.shutdown = 1;
    yoop_cond_broadcast(&g_rt.queue_cv);
    yoop_mutex_unlock(&g_rt.queue_mu);

    for (int i = 0; i < g_rt.n_workers; i++) {
        join_worker(&g_rt.workers[i]);
    }
    free(g_rt.workers);
    g_rt.workers = NULL;

    // Drain any nodes left in the queue. This shouldn't happen in well-formed
    // programs (every submit pairs with a wait or a release) but we don't
    // strand allocations.
    while (g_rt.queue_head) {
        task_node* n = g_rt.queue_head;
        g_rt.queue_head = n->next;
        free(n);
    }
    g_rt.queue_tail = NULL;

    yoop_mutex_destroy(&g_rt.queue_mu);
    yoop_cond_destroy(&g_rt.queue_cv);

    g_rt.initialized = 0;
    yoop_mutex_unlock(&init_mutex);
}
```

#### Race-on-shutdown note

If user code calls `yoop_task_submit` *after* `yoop_runtime_shutdown` has been called (e.g. via FFI in a destructor-like context), the submit silently no-ops - but for 6.3-prelude this can't actually happen, because shutdown injection is at every `ret` in `main`, which is the last user-reachable code. Don't add a guard for this in 6.3-prelude; document it as a future-work consideration in [runtime-design.md §11](runtime-design.md#L289) if it ever matters.

### 2.c Worker loop

```c
static void worker_loop(void) {
    for (;;) {
        yoop_mutex_lock(&g_rt.queue_mu);
        while (!g_rt.queue_head && !g_rt.shutdown) {
            yoop_cond_wait(&g_rt.queue_cv, &g_rt.queue_mu);
        }
        if (!g_rt.queue_head && g_rt.shutdown) {
            yoop_mutex_unlock(&g_rt.queue_mu);
            return;
        }
        task_node* node = g_rt.queue_head;
        g_rt.queue_head = node->next;
        if (!g_rt.queue_head) g_rt.queue_tail = NULL;
        yoop_mutex_unlock(&g_rt.queue_mu);

        node->thunk(node->handle);
        free(node);
    }
}
```

Notes:

- The worker pops, releases the queue mutex, **then** invokes the thunk. The thunk is allowed to take the handle's per-handle mutex (in `yoop_handle_signal_done`); doing it without the queue mutex held prevents priority inversion between unrelated tasks.
- The thunk is responsible for storing the result, signaling done, and (for pooled) releasing. The worker doesn't touch the handle once it's invoked the thunk - the thunk owns it.
- Spurious wakeups: the `while` predicate handles them. Textbook condvar pattern.
- Per-platform wrappers: on POSIX `spawn_worker` and `join_worker` use `pthread_create` / `pthread_join`; on Windows they use `CreateThread` / `WaitForSingleObject` + `CloseHandle`. `worker_loop` is the same on both; on Windows it's wrapped in a `DWORD WINAPI worker_thunk(LPVOID)` that just calls `worker_loop()` and returns 0.

### 2.d `yoop_task_submit` / `yoop_task_wait`

```c
void yoop_task_submit(void* handle, void (*thunk)(void*)) {
    // Allocate the per-handle mutex/condvar pair and store them at offsets 16/24.
    yoop_mutex_t* m = (yoop_mutex_t*)malloc(sizeof(yoop_mutex_t));
    yoop_cond_t*  c = (yoop_cond_t*) malloc(sizeof(yoop_cond_t));
    yoop_mutex_init(m);
    yoop_cond_init(c);
    *(yoop_mutex_t**)((char*)handle + 16) = m;
    *(yoop_cond_t**) ((char*)handle + 24) = c;
    // The thunk pointer at offset 0 was already written by codegen before submit,
    // but the explicit `thunk` arg lets the queue avoid GEPing into the handle.
    // We don't re-store it.

    task_node* node = (task_node*)malloc(sizeof(task_node));
    node->handle = handle;
    node->thunk  = thunk;
    node->next   = NULL;

    yoop_mutex_lock(&g_rt.queue_mu);
    if (g_rt.queue_tail) {
        g_rt.queue_tail->next = node;
    } else {
        g_rt.queue_head = node;
    }
    g_rt.queue_tail = node;
    yoop_cond_signal(&g_rt.queue_cv);
    yoop_mutex_unlock(&g_rt.queue_mu);
}

void yoop_task_wait(void* handle) {
    yoop_mutex_t* m = *(yoop_mutex_t**)((char*)handle + 16);
    yoop_cond_t*  c = *(yoop_cond_t**) ((char*)handle + 24);
    yoop_mutex_lock(m);
    while (A_LOAD_U8((char*)handle + 8) == 0) {
        yoop_cond_wait(c, m);
    }
    yoop_mutex_unlock(m);
}
```

`yoop_task_wait` does **not** release the caller's refcount ([runtime-design.md §6.a](runtime-design.md#L116)) - that's the caller's binding's scope-exit responsibility. The wait is purely "block until state==1."

### 2.e `yoop_handle_signal_done`

Called from each per-task thunk after the thunk has stored its result in the handle's result slot.

```c
void yoop_handle_signal_done(void* handle) {
    yoop_mutex_t* m = *(yoop_mutex_t**)((char*)handle + 16);
    yoop_cond_t*  c = *(yoop_cond_t**) ((char*)handle + 24);
    yoop_mutex_lock(m);
    A_STORE_U8((char*)handle + 8, 1);
    yoop_cond_broadcast(c);  // broadcast, not signal - multiple waiters legal for pooled
    yoop_mutex_unlock(m);

    // If this is a pooled handle (refcount > 0), the worker releases its ref.
    int32_t rc = atomic_load_explicit((_Atomic int32_t*)((char*)handle + 12),
                                      memory_order_acquire);
    if (rc > 0) {
        yoop_task_release(handle);
    }
}
```

Broadcast over signal: in 6.3-prelude only one waiter ever exists per handle (the language doesn't yet let you wait twice), so `signal` would suffice - but broadcast costs nothing for one waiter and matches the long-term semantics ([runtime-design.md §11](runtime-design.md#L289) leaves multi-waiter open). Don't optimize prematurely.

### 2.f Pooled lifecycle - alloc / retain / release

```c
void* yoop_task_alloc(size_t size) {
    void* p = calloc(1, size);  // zero-init so state=0, refcount untouched-but-zeroed.
    // Initial refcount = 2 (caller + worker). The "worker" half is logical -
    // the worker thunk will call yoop_task_release after signaling.
    atomic_store_explicit((_Atomic int32_t*)((char*)p + 12), 2,
                          memory_order_release);
    return p;
}

void yoop_task_retain(void* handle) {
    A_INC_I32((char*)handle + 12);
}

void yoop_task_release(void* handle) {
    int32_t prev = A_DEC_I32((char*)handle + 12);
    if (prev == 1) {
        // We held the last reference.
        yoop_mutex_t* m = *(yoop_mutex_t**)((char*)handle + 16);
        yoop_cond_t*  c = *(yoop_cond_t**) ((char*)handle + 24);
        if (m) { yoop_mutex_destroy(m); free(m); }
        if (c) { yoop_cond_destroy(c);  free(c); }
        free(handle);
    }
}
```

For stack-allocated handles (`joined` / immediate in 6.3 sugar), `refcount` stays at 0 and `yoop_task_release` is never called. The mutex/cond pair allocated by `yoop_task_submit` is freed by codegen-inserted cleanup at scope exit (6.3 sugar handles this via a dedicated `yoop_task_cleanup_stack(void*)` helper - added in 6.3, not in the prelude). For now, the C runtime only handles pooled cleanup; stack-handle cleanup symbols are not part of the 6.3-prelude ABI surface.

### 2.g Deadlock surface

[runtime-design.md §10.a](runtime-design.md#L278) acknowledges the nested-wait deadlock and accepts it for the MVP. 6.3-prelude does nothing to mitigate it - the prelude has no concept of "task body" yet (no thunks emitted, no user-reachable `wait`). Mitigations land in 6.3 sugar (oversize pool via `YOOP_NUM_WORKERS`, docs in SPEC.md §8).

## 3. Build pipeline - driver changes ([yoopiler.js](../src/yoopiler.js))

Single edit to the clang invocation at [yoopiler.js:51-60](../src/yoopiler.js#L51-L60). Resolve the runtime source path relative to the yoopiler script (so the driver works regardless of the user's cwd):

```js
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const RUNTIME_C = path.resolve(path.dirname(__filename), "..", "runtime", "yoop_runtime.c");
```

Then:

```js
const platformLinkFlags = process.platform === "win32" ? [] : ["pthread"];
const allLinkFlags = [...linkFlags, ...platformLinkFlags];

if (process.platform === "win32") {
  const clang = "C:\\Program Files\\LLVM\\bin\\clang.exe";
  const clangArgs = [
    tmpIR, RUNTIME_C,
    "-o", `${outputFileName}.exe`,
    ...allLinkFlags.map((f) => `-l${f}`),
    "-mllvm", "-enable-coroutines",   // defensive; no-op on LLVM ≥ 16
    "-fuse-ld=link",
  ];
  execFileSync(clang, clangArgs, { stdio: "inherit" });
} else {
  const clangArgs = [
    tmpIR, RUNTIME_C,
    "-o", outputFileName,
    ...allLinkFlags.map((f) => `-l${f}`),
    "-mllvm", "-enable-coroutines",
  ];
  execFileSync("clang", clangArgs, { stdio: "inherit" });
}
```

Notes:

- `-lpthread` is appended on POSIX. The `linkFlags` array already supports user `extern "C" from library "..."` declarations; we route the platform-required `pthread` through the same flag pipeline so the diff is small.
- `-mllvm -enable-coroutines` is defensive: LLVM ≥ 16 enables coroutines by default at `-O1`+, but explicit is safer across compiler versions. Phase 6.3 will rely on coroutine passes being available; turning the flag on in the prelude means 6.3 inherits a known-good clang invocation.
- We do **not** add `-O2` in the prelude. Phase 6.3 may want optimization (the coroutine simplifier collapses the no-suspend coroutine frame [runtime-design.md §7.e](runtime-design.md#L227)), but the prelude has no coroutines to optimize; staying at the current default (no `-O` flag) keeps the diff focused.
- The runtime is compiled fresh on every yoopiler invocation. Caching is a phase 7 concern; for now, ~400 lines of C compiles in well under a second and the build pipeline stays single-step.

### 3.a A small wart: precompiled object option

If clang-compile-from-source on every run becomes painful for development cycles, an optional optimization is to ship `runtime/yoop_runtime.o` (built once via a `Makefile` or build script) and link the `.o` instead of recompiling the `.c`. The driver can probe for the `.o` first and fall back to the `.c` if absent. This is **deferred** for the prelude - measure first, only add if it bites.

## 4. Codegen changes ([codegen.js](../src/jsyoopcodegen/codegen.js))

Three discrete edits.

### 4.a Emit ABI declares unconditionally

In `emitProgram`, after struct type emission and before user-function emission, push the runtime ABI declares as fixed text:

```js
const RUNTIME_DECLARES = [
  "declare void @yoop_runtime_init()",
  "declare void @yoop_runtime_shutdown()",
  "declare void @yoop_task_submit(ptr, ptr)",
  "declare void @yoop_task_wait(ptr)",
  "declare ptr  @yoop_task_alloc(i64)",
  "declare void @yoop_task_retain(ptr)",
  "declare void @yoop_task_release(ptr)",
  "declare void @yoop_handle_signal_done(ptr)",
];
lines.push(...RUNTIME_DECLARES);
```

Reasoning: emit unconditionally. The cost is six unused declare lines in programs that never spawn a task; the benefit is that any future codegen path that wants to call into the runtime doesn't need to register its symbols on demand. The LLVM verifier is fine with unused declares.

### 4.b Inject `yoop_runtime_init` at `main`'s entry

In `emitFunction` ([codegen.js:1142](../src/jsyoopcodegen/codegen.js#L1142)), after pushing `entry:` and before the param-alloca loop, conditionally emit the init call:

```js
fnLines.push("entry:");

if (node.name === "main" && !forceName /* forceName means export "C", not the entry main */) {
  fnLines.push("  call void @yoop_runtime_init()");
}

for (const p of params) { /* ...existing alloca loop... */ }
```

The `!forceName` guard matters because [codegen.js:1597](../src/jsyoopcodegen/codegen.js#L1597) also calls `emitFunction` for `export "C" function main`. The C-entry `main` (the program's real entry point) is the one we want; an `export "C" function main` is a user-named symbol that happens to collide. Distinguish via `forceName`: when `forceName` is set, we're emitting an `export "C"` symbol and should not inject init.

### 4.c Inject `yoop_runtime_shutdown` before every `ret` in `main`

Track "are we currently emitting `main`?" via a flag, set in `emitFunction` and consumed wherever a `ret` is emitted.

```js
let inMainFn = false;          // module-scope; set in emitFunction, restored after.

function emitFunction(node, forceName = null) {
  const wasInMain = inMainFn;
  inMainFn = (node.name === "main" && !forceName);
  // ... existing body ...
  inMainFn = wasInMain;
}
```

At every `ret` emission site, before pushing the `ret` line, push the shutdown call when `inMainFn` is true. The existing `ret` emission sites:

- **Explicit `RETURN_STATEMENT` codegen**: the helper that emits `ret <ty> <val>`. Wrap it:
  ```js
  if (inMainFn) fnLines.push("  call void @yoop_runtime_shutdown()");
  fnLines.push(`  ret ${llvmRet} ${val}`);
  ```
- **Implicit void return at function fall-through** ([codegen.js:1176-1178](../src/jsyoopcodegen/codegen.js#L1176-L1178)): `main` returns `int32`, not void, so this branch is never taken for `main` - but defensively, gate it the same way.
- **`?` early-return** via `emitFailVariantReturn`: in 6.3-prelude, `main` returning fallible is legal (it's `int32`, not a fallible-shaped struct), so `?` doesn't apply in `main`'s body directly. **But**: a `?` *can* appear inside `main`. Phase 2's `?` operator at [codegen.js:381](../src/jsyoopcodegen/codegen.js#L381) emits a `ret` for the early-return path. Audit: when `inMainFn` is true, the failVariantReturn's `ret` must be preceded by `call void @yoop_runtime_shutdown()`. Edit `emitFailVariantReturn` to consult `inMainFn` and emit the shutdown call before its own `ret`. This is exactly analogous to phase 6.1's cleanup-before-`?`-ret edit ([phase-6-1-disposable.md §7.d](phase-6-1-disposable.md#L676)) and uses the same insertion site.

### 4.d Interaction with phase 6.1 / 6.2 cleanup emission

Phase 6.1 inserts `CLEANUP_CALL` nodes before every exit in `main` (if `main` declares `disposable` bindings). Phase 6.3-prelude inserts `call void @yoop_runtime_shutdown()` before every `ret` in `main`. **Order matters**: shutdown must come *after* all cleanups (the cleanups may freely call user functions, FFI, or printf - all of which work because the runtime is still up). Concretely, the emission order at every `ret` in `main`:

1. Phase 6.1 / 6.2 cleanups (in their LIFO order).
2. `call void @yoop_runtime_shutdown()`.
3. `ret <ty> <val>`.

Implementation: in the helper that emits the `ret`, fire any `node.pendingCleanups` first, then (if `inMainFn`) the shutdown, then the `ret`. This is one extra conditional sandwiched between two existing emissions - no new helper needed.

A fail-fixture exists in 6.1 (`disposable_qmark.yoop`); add a 6.3-prelude pass fixture that combines `disposable` *in main* with a `?` to prove the order works end-to-end (§7).

## 5. Lexer / parser / typechecker - no changes

There are no new keywords, no new AST node kinds, no new types, no new flow-pass extensions. The lexer, parser, and typechecker pass through unchanged. This is the cleanest signal that the prelude is purely runtime + codegen-injection + build-pipeline - anything that *would* require lexer / parser changes belongs to 6.3 (sugar).

## 6. Driver wiring summary

Files modified end-to-end:

- [src/yoopiler.js](../src/yoopiler.js) - runtime path resolution; clang argv update; platform-specific `-lpthread`; defensive coroutine flag.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) - runtime ABI declare block; init injection at `main` entry; shutdown injection at every `ret` in `main` (including `?`-induced); `inMainFn` flag plumbing.

Files created end-to-end:

- `runtime/yoop_runtime.h`
- `runtime/yoop_runtime.c`
- `runtime/tests/smoke.c`
- `runtime/tests/submit_one.c`
- `runtime/tests/submit_many.c`
- `runtime/tests/refcount.c`
- `runtime/tests/run_tests.sh`
- `examples/pass/runtime_linked/main.yoop`

## 7. Tests

### 7.1 C-level smoke tests - `runtime/tests/`

These tests run the runtime *without involving the compiler*. They prove the runtime contract independently. Each is a tiny standalone C program built as `clang runtime/yoop_runtime.c runtime/tests/<name>.c -lpthread -o /tmp/<name> && /tmp/<name>`.

#### `smoke.c` - init + shutdown round-trip

```c
#include "yoop_runtime.h"
int main(void) {
    yoop_runtime_init();
    yoop_runtime_shutdown();
    return 0;
}
```

Verifies: pool spawns N workers, every worker exits cleanly on `shutdown=1` broadcast, `pthread_join` succeeds on every worker, all queue resources freed.

#### `submit_one.c` - one task end-to-end

Fake handle: a 32-byte buffer with the correct prefix layout (thunk ptr at 0, state at 8, refcount=0 at 12, mutex/cond at 16/24 - left null, filled by submit). A trivial thunk that just calls `yoop_handle_signal_done`.

```c
#include "yoop_runtime.h"
#include <assert.h>
#include <string.h>

struct fake_handle {
    void (*thunk)(void*);     // offset 0
    unsigned char state;      // offset 8
    char _pad[3];
    int  refcount;            // offset 12
    void* mutex;              // offset 16
    void* cond;               // offset 24
};

static void noop_thunk(void* h) {
    yoop_handle_signal_done(h);
}

int main(void) {
    yoop_runtime_init();

    struct fake_handle h;
    memset(&h, 0, sizeof(h));
    h.thunk = noop_thunk;

    yoop_task_submit(&h, noop_thunk);
    yoop_task_wait(&h);
    assert(h.state == 1);

    yoop_runtime_shutdown();
    return 0;
}
```

Verifies: submit pushes onto the queue, a worker pops and invokes the thunk, the thunk's `signal_done` flips state to 1 and signals the condvar, and the main thread's wait returns. Run under TSan to verify the mutex/condvar dance is race-free.

#### `submit_many.c` - queue contention, no leaks

Submit N=1000 fake handles; wait each in order. Verifies queue FIFO behavior and that the per-handle mutex/cond pairs are freed on every wait → release path. (For stack-allocated handles like these, mutex/cond are leaked in the current ABI - see §2.f. For 6.3-prelude we accept this and document; or add a small `yoop_task_free_sync_pair(handle)` helper to the ABI and call it from the test after each wait. Decision: add the helper. It's one cheap addition that makes the smoke tests leak-clean and gives 6.3 sugar a clean primitive for stack-handle cleanup.)

```c
// Add to yoop_runtime.h:
void yoop_task_free_sync_pair(void* handle);

// runtime/yoop_runtime.c:
void yoop_task_free_sync_pair(void* handle) {
    yoop_mutex_t** mp = (yoop_mutex_t**)((char*)handle + 16);
    yoop_cond_t**  cp = (yoop_cond_t**) ((char*)handle + 24);
    if (*mp) { yoop_mutex_destroy(*mp); free(*mp); *mp = NULL; }
    if (*cp) { yoop_cond_destroy(*cp);  free(*cp); *cp = NULL; }
}
```

This brings the runtime ABI to 9 symbols. Codegen adds the `declare void @yoop_task_free_sync_pair(ptr)` line to the block in §4.a.

#### `refcount.c` - alloc / retain / release lifecycle

```c
void* h = yoop_task_alloc(32);  // refcount = 2
yoop_task_retain(h);            // refcount = 3
yoop_task_release(h);           // refcount = 2
yoop_task_release(h);           // refcount = 1
yoop_task_release(h);           // refcount = 0 -- frees
```

Run under valgrind; should report zero leaks.

#### `run_tests.sh`

```sh
#!/bin/sh
set -e
CC=${CC:-clang}
for t in smoke submit_one submit_many refcount; do
    $CC -std=c11 -O0 -g -Wall -Wextra -Werror \
        runtime/yoop_runtime.c runtime/tests/$t.c \
        -lpthread -o /tmp/yoop_test_$t
    /tmp/yoop_test_$t
    if command -v valgrind >/dev/null; then
        valgrind --error-exitcode=1 --leak-check=full \
                 --errors-for-leak-kinds=definite /tmp/yoop_test_$t
    fi
done
echo "all runtime tests passed"
```

Hook this into the existing test runner that walks `examples/pass/` and `examples/fail/`. The C tests run before the yoop fixtures; if the runtime is broken, every yoop fixture would fail downstream - fail fast at the C layer.

### 7.2 End-to-end pass fixtures - `examples/pass/`

#### `runtime_linked/main.yoop` - the goal program

The trivial program from §Goal:

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

function main(): int32 {
    printf(`hello\n`);
    return 0;
}
```

Expected output: `hello`. IR-level checks (spot via `--keep-ir` flag or by reading `/tmp/yooper_out.ll` after a build):

1. Module top contains `declare void @yoop_runtime_init()` and the eight other ABI declares.
2. `main`'s `entry:` block's first instruction (after any param alloca, but there are none for `main`) is `call void @yoop_runtime_init()`.
3. Immediately before `ret i32 0`, the IR shows `call void @yoop_runtime_shutdown()`.

#### `runtime_qmark_in_main/main.yoop` - `?` from inside `main` exits cleanly through shutdown

Build on phase 2's `?` machinery: `main` calls a fallible function and propagates with `?`, requiring `main`'s return type to be fallible. Verify that the shutdown call is emitted before the `?`-induced early `ret`.

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

type Result { value: int32, err: string }

function maybe(fail: bool): Result {
    if (fail) { return { value: 0, err: "boom" }; }
    return { value: 42, err: "" };
}

function main(): Result {
    const r = maybe(true)?;     // early-returns from main
    printf(`got ${r.value}\n`);
    return { value: r.value, err: "" };
}
```

IR-level check: the `?` failure block in `main` contains `call void @yoop_runtime_shutdown()` immediately before its `ret`.

#### `runtime_disposable_in_main/main.yoop` - 6.1 cleanups + shutdown ordering

Bring phase 6.1 back: a `disposable` binding in `main`, exiting via `return`. Verify the emission order is `dispose(...)` → `shutdown` → `ret`.

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }
trait Disposable { function dispose(ref self): void; }
type H implements Disposable {
    fd: int32,
    function dispose(ref self): void { printf(`disposing ${self.fd}\n`); }
}
kind disposable {
    appliesTo binding;
    requires Disposable;
    ownsBlock;
    mustCall dispose beforeScopeEnd;
}
function main(): int32 {
    disposable a: H = { fd: 7 };
    printf(`work\n`);
    return 0;
}
```

Expected stdout:

```
work
disposing 7
```

IR-level check: `main`'s `ret i32 0` is preceded by `call void @<modId>__H__dispose(ptr %a)` *then* `call void @yoop_runtime_shutdown()`, in that order. Regression-locks the §4.d ordering rule.

### 7.3 Fail fixtures

None new. The prelude introduces no surface-language changes, so there are no new parse / typecheck rejections to fixture. The existing fail fixtures from 6.1 / 6.2 must all continue to fail (compiled with the runtime now linked, but failing at typecheck before any runtime concern).

### 7.4 Regression

Every existing `examples/pass/*` fixture must continue to pass. This is the broadest check: every fixture's `main` now goes through init + shutdown, and every fixture must still produce its expected stdout.

## 8. Verification

Run order:

1. **C runtime tests** - `sh runtime/tests/run_tests.sh`. Must all pass, including under valgrind. On Linux with TSan available, also run `CC="clang -fsanitize=thread"` once and confirm zero data races.
2. **Phase-1-through-6.2 regression** - every existing `examples/pass/` fixture compiles, runs, and prints its expected output. Every `examples/fail/` fixture rejects with its expected error.
3. **6.3-prelude pass fixtures** - `runtime_linked`, `runtime_qmark_in_main`, `runtime_disposable_in_main` all build, run, produce expected output, and pass the spot-check IR assertions in §7.2.
4. **Cross-platform** - repeat on Windows if available (no current Windows CI in the repo; document the manual step in [runtime-design.md §9](runtime-design.md#L246)).
5. **Smoke under load** - manual: build `examples/pass/runtime_linked` and run it 10,000 times in a loop (`for i in $(seq 1 10000); do ./output || break; done`). Any crash, hang, or non-zero exit indicates a runtime race or refcount bug.

Phase 6.3-prelude is considered landed when all five checks pass and the runtime-design.md contract is implemented end-to-end (every symbol in [§6](runtime-design.md#L74) plus `yoop_handle_signal_done` and `yoop_task_free_sync_pair`).

## 9. Out of scope (for reference, addressed in 6.3 sugar)

- The `task` keyword and its lexer / parser / kind-shell entry.
- The compiler-builtin `TaskType` and its rewrite of `task f(...): T` return types to `Task<T>`.
- Per-result-type `%Task_<T>` struct emission. The layout is locked by [runtime-design.md §5](runtime-design.md#L51) and the prefix in §1.a; codegen needs to produce structs matching that layout.
- Per-task-function thunk emission and the helper accessors (`__start`, `__result`) it depends on.
- LLVM coroutine intrinsic emission around each `task` function body.
- Call-site refcount-pair insertion for `pooled` bindings (retain on copy, release on scope exit).
- Compiler-inserted `wait` for immediate and `joined` bindings.
- `joined` `mustCall wait beforeScopeEnd` clause, `autoJoin beforeScopeEnd` semantics ([SPEC.md §8](../SPEC.md#L532)).
- Stack-handle cleanup at scope exit (calls `yoop_task_free_sync_pair`).
- The deadlock-mitigation `YOOP_NUM_WORKERS` documentation in SPEC.md §8.
- Suspendable task bodies, I/O multiplexing, cancellation, work-stealing, crash propagation, introspection - all out of 6.3 entirely.

The split between this prelude and 6.3 sugar is sharp: anything that requires *a source-language change* (lexer keyword, parser rule, AST kind, type-system entry) belongs to 6.3 sugar. Anything that requires *a runtime contract* (C ABI, build-pipeline change, init/shutdown injection) belongs to this prelude. When in doubt, lean toward keeping it in 6.3 sugar - the prelude should stay narrow.
