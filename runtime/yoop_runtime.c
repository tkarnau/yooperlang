// Yooperlang runtime - worker pool, task submit/wait, and pooled refcount
// lifecycle.
//
// The Task<T> handle layout (set in stone by the compiler / runtime contract):
//   offset 0:  void(*)(void*)  thunk
//   offset 8:  uint8_t         state (0=unstarted, 1=done)
//   offset 12: int32_t         refcount (0 = stack, >=1 = pooled)
//   offset 16: yoop_mutex_t*   per-handle mutex (heap-allocated)
//   offset 24: yoop_cond_t*    per-handle cond  (heap-allocated)
//   offset 32: void*           coroutine handle (async task body)
//   offset 40: void*           allocator context (runtime-owned, may be NULL)
//   offset 48+: compiler-owned (result slot + args blob)

#include "yoop_runtime.h"
#include "yoop_platform.h"
#include "yoop_alloc.h"

#include <errno.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
  // _setmode / _fileno / _O_BINARY, for taking the standard streams out of
  // the CRT's newline-translating text mode (see set_stdio_binary below).
  #include <fcntl.h>
  #include <io.h>
#elif defined(__APPLE__)
  // task_info / mach_task_self, for yoop_runtime_rss_bytes.
  #include <mach/mach.h>
  #include <unistd.h>
#else
  // sysconf(_SC_PAGESIZE), for turning /proc/self/statm pages into bytes.
  #include <unistd.h>
#endif

#define A_LOAD_U8(p)      atomic_load_explicit((_Atomic uint8_t*)(p),  memory_order_acquire)
#define A_STORE_U8(p, v)  atomic_store_explicit((_Atomic uint8_t*)(p), (v), memory_order_release)
#define A_LOAD_I32(p)     atomic_load_explicit((_Atomic int32_t*)(p), memory_order_acquire)
#define A_STORE_I32(p, v) atomic_store_explicit((_Atomic int32_t*)(p), (v), memory_order_release)
#define A_INC_I32(p)      atomic_fetch_add_explicit((_Atomic int32_t*)(p), 1, memory_order_acq_rel)
#define A_DEC_I32(p)      atomic_fetch_sub_explicit((_Atomic int32_t*)(p), 1, memory_order_acq_rel)

// ---- handle prefix accessors ---------------------------------------------

static inline yoop_mutex_t** handle_mutex_slot(void* h) { return (yoop_mutex_t**)((char*)h + 16); }
static inline yoop_cond_t**  handle_cond_slot (void* h) { return (yoop_cond_t**) ((char*)h + 24); }
static inline void*          handle_state_ptr (void* h) { return (char*)h + 8;  }
// The cancel flag lives in a pad byte at offset 9 (the codegen
// task-struct layout reserves `[3 x i8]` at field index 2 between
// `state` and `refcount`), so it costs no ABI change - the byte is
// simply not padding.
static inline void*          handle_cancel_ptr(void* h) { return (char*)h + 9;  }
// The park byte, offset 10 - the SECOND of the three pad bytes, after the
// cancel flag's. Byte 11 is still spare. Guarded by queue_mu
// rather than atomics: every transition already happens at a point that
// takes that lock (a queue push, or the end of a step), so an atomic would
// be a second synchronisation layer over the same critical sections.
//
//   YOOP_PARK_RUNNING - executing a step, or sitting on the run queue
//   YOOP_PARK_WAKE    - a wake arrived mid-step; re-queue when the step ends
//   YOOP_PARK_PARKED  - suspended and off the queue; a wake may queue it
static inline void*          handle_park_ptr  (void* h) { return (char*)h + 10; }
#define YOOP_PARK_RUNNING 0
#define YOOP_PARK_WAKE    1
#define YOOP_PARK_PARKED  2
static inline void*          handle_rc_ptr    (void* h) { return (char*)h + 12; }
// Async: the task body's coroutine handle, stored by the thunk. Sits at
// offset 32, immediately after the cond pointer, so every offset the
// prefix accessors above hard-code is unchanged.
static inline void**         handle_coro_slot (void* h) { return (void**)((char*)h + 32); }
// The task's allocator context, swapped in and out by run_task_step. Owned by
// yoop_alloc.c, which is why this is the only place the runtime touches it as
// anything other than an opaque slot pointer.
static inline void**         handle_ctx_slot  (void* h) { return (void**)((char*)h + 40); }

// ---- queue ----------------------------------------------------------------

typedef struct task_node {
    void* handle;
    void  (*thunk)(void*);
    struct task_node* next;
} task_node;

static struct {
    int            initialized;
    int            shutdown;
    int            n_workers;
    yoop_thread_t* workers;

    yoop_mutex_t   queue_mu;
    yoop_cond_t    queue_cv;
    task_node*     queue_head;
    task_node*     queue_tail;
} g_rt;

// Static init guard. POSIX uses a statically-initialized pthread mutex; on
// Windows we use a CRITICAL_SECTION with one-time init via InitOnceExecuteOnce.
#ifdef _WIN32
  static INIT_ONCE g_init_once = INIT_ONCE_STATIC_INIT;
  static CRITICAL_SECTION g_init_cs;
  static BOOL CALLBACK init_once_cb(PINIT_ONCE o, PVOID p, PVOID* c) {
      (void)o; (void)p; (void)c;
      InitializeCriticalSection(&g_init_cs);
      return TRUE;
  }
  static void init_lock(void)   { InitOnceExecuteOnce(&g_init_once, init_once_cb, NULL, NULL);
                                  EnterCriticalSection(&g_init_cs); }
  static void init_unlock(void) { LeaveCriticalSection(&g_init_cs); }
#else
  static pthread_mutex_t g_init_mu = PTHREAD_MUTEX_INITIALIZER;
  static void init_lock(void)   { pthread_mutex_lock(&g_init_mu); }
  static void init_unlock(void) { pthread_mutex_unlock(&g_init_mu); }
#endif

// ---- worker loop ----------------------------------------------------------

// Defined below, next to the other queue operations; declared here
// because yoop_task_submit (further up) is its first caller.
static void queue_push(void* handle, void (*thunk)(void*));
static void queue_push_locked(void* handle, void (*thunk)(void*));
// The park-byte transitions, both of which run under queue_mu. run_task_step
// (just below) is the first caller of each.
static void make_runnable_locked(void* handle);
static void park_or_requeue_locked(void* handle);

// Pop one task from the front of the queue and return it. Caller
// must hold queue_mu and is responsible for free()-ing the returned node.
// Returns NULL when the queue is empty.
static task_node* try_pop_task_locked(void) {
    if (!g_rt.queue_head) return NULL;
    task_node* node = g_rt.queue_head;
    g_rt.queue_head = node->next;
    if (!g_rt.queue_head) g_rt.queue_tail = NULL;
    return node;
}

// The task this thread is currently stepping. A suspend primitive deep
// in a call chain reads it to register a wakeup against the right task,
// so no intermediate signature has to carry a task handle.
//
// Thread-local because a step runs to its next suspend point on exactly
// one thread; the value is set around each step and cleared after.
#ifdef _WIN32
  static __declspec(thread) void* tls_current_task = NULL;
#else
  static __thread void* tls_current_task = NULL;
#endif

void* yoop_current_task(void) { return tls_current_task; }

// Coroutine trampolines, installed by main (see the note in the header
// on why these are pointers rather than direct calls). NULL until then.
static yoop_coro_fn   g_coro_resume  = NULL;
static yoop_coro_fn   g_coro_destroy = NULL;
static yoop_coro_pred g_coro_done    = NULL;

void yoop_runtime_set_coro_ops(yoop_coro_fn resume,
                               yoop_coro_fn destroy,
                               yoop_coro_pred done) {
    g_coro_resume  = resume;
    g_coro_destroy = destroy;
    g_coro_done    = done;
}

// Run one step of a task: the initial start (thunk != NULL) or a resume
// of an already-started coroutine. The step ends at the task's next
// suspend point or at its completion; either way the worker is free
// afterwards, which is the entire point of the async runtime.
//
// This is also where the ALLOCATOR context is swapped, for the same reason
// tls_current_task is set here: it is the one place a task starts, resumes,
// or hands its thread back. The ambient allocator is per-thread, but it
// belongs to the task, and the three ways that went wrong before the swap
// existed were (1) a parked task leaving its arena installed for whatever
// the worker picked up next, (2) a resumed task finding a different worker's
// allocator and silently allocating outside its own region, and (3) its
// eventual popAllocator writing one worker's context onto another's.
//
// Note this covers the synchronous case too: yoop_task_wait drains the queue
// re-entrantly on the calling thread, so a plain function holding an arena
// would otherwise run an unrelated task inside it.
static void run_task_step(void* handle, void (*thunk)(void*)) {
    void* prev = tls_current_task;
    tls_current_task = handle;

    // Running: a wake arriving from here on has to be recorded rather than
    // queued, or a second worker would resume this coroutine underneath us.
    // Clearing a wake recorded before the step is correct - it asked for this
    // task to run, and it is running.
    yoop_mutex_lock(&g_rt.queue_mu);
    *(unsigned char*)handle_park_ptr(handle) = YOOP_PARK_RUNNING;
    yoop_mutex_unlock(&g_rt.queue_mu);

    YoopCtxSave outer;
    yoop_ctx_save(&outer);
    yoop_ctx_load_task(handle_ctx_slot(handle));

    if (thunk) {
        // Start: the thunk calls the body, stashes the coroutine handle,
        // and calls yoop_task_settle itself.
        thunk(handle);
    } else {
        void* coro = *handle_coro_slot(handle);
        if (coro && g_coro_resume) {
            g_coro_resume(coro);
            yoop_task_settle(handle);
        }
    }

    // Whatever is installed now belongs to the TASK, not to this worker.
    // Reading `state` rather than hooking yoop_task_settle covers both paths
    // uniformly: the thunk settles itself on the start path, and the resume
    // path settles just above.
    //
    // KNOWN RACE: settling already released the waiters, and this read of the
    // context slot happens after that. A waiter that reuses the handle (a
    // `joined` binding is one hoisted alloca, so every iteration of a loop
    // reuses it) or drops its last reference in the window makes this read
    // see a slot that is no longer the task's, and the backtrace is
    // run_task_step -> yoop_ctx_discard_task -> yoop_arena_destroy -> free on
    // a pointer that was never allocated. It needs more than about 8 workers
    // to reproduce: a loop holding a `joined` handle whose `if` returns early
    // through a `pooled` one crashes roughly 4 runs in 50. The fix is to do
    // this bookkeeping BEFORE signal_done releases anyone, or to lift the
    // allocator context off the handle for the duration of the step.
    if (A_LOAD_U8(handle_state_ptr(handle)) != 0) {
        yoop_ctx_discard_task(handle_ctx_slot(handle));
    } else {
        yoop_ctx_store_task(handle_ctx_slot(handle));
        // Suspended. Park it, unless a wake landed mid-step - in which case
        // it goes straight back on the queue and never parks at all.
        yoop_mutex_lock(&g_rt.queue_mu);
        park_or_requeue_locked(handle);
        yoop_mutex_unlock(&g_rt.queue_mu);
    }
    yoop_ctx_restore(&outer);

    tls_current_task = prev;
}

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
        task_node* node = try_pop_task_locked();
        yoop_mutex_unlock(&g_rt.queue_mu);

        run_task_step(node->handle, node->thunk);
        free(node);
    }
}

#ifdef _WIN32
static DWORD WINAPI worker_thunk(LPVOID arg) { (void)arg; worker_loop(); return 0; }
static void spawn_worker(yoop_thread_t* t) {
    t->h = CreateThread(NULL, 0, worker_thunk, NULL, 0, NULL);
}
static void join_worker(yoop_thread_t* t) {
    WaitForSingleObject(t->h, INFINITE);
    CloseHandle(t->h);
}
#else
static void* worker_thunk(void* arg) { (void)arg; worker_loop(); return NULL; }
static void spawn_worker(yoop_thread_t* t) {
    pthread_create(&t->t, NULL, worker_thunk, NULL);
}
static void join_worker(yoop_thread_t* t) {
    pthread_join(t->t, NULL);
}
#endif

// ---- init / shutdown ------------------------------------------------------

// n_workers_target is the worker count we'll spawn on first task submit.
// Stored separately from n_workers (which counts actually-spawned workers)
// so programs that never submit a task pay no pthread cost. Crucial on
// macOS where pthread_create before SDL_Init confuses the Cocoa app
// lifecycle and prevents windows from appearing.
static int n_workers_target = 0;

// Windows only: take stdout/stderr out of the CRT's text mode.
//
// By default the MSVC CRT opens the standard streams in text mode, which
// rewrites every '\n' the program emits into "\r\n" on its way out. That is
// wrong for Yooperlang twice over. Semantically, `printf("a\nb")` is defined
// to write the bytes the program named - a language that can write bytes to
// stdout cannot have the CRT silently inserting extra ones, which would
// corrupt any binary payload. Practically, it made a compiled program's
// output differ from the identical program on macOS/Linux for no reason a
// user could see, which is exactly the portability seam the language exists
// to hide. Go and Rust both write their standard streams in binary mode for
// the same reasons.
//
// This does not stop Windows consoles from rendering the output correctly -
// they treat a bare LF as a newline. It only stops the translation layer.
static void set_stdio_binary(void) {
#ifdef _WIN32
    _setmode(_fileno(stdout), _O_BINARY);
    _setmode(_fileno(stderr), _O_BINARY);
#endif
}

void yoop_runtime_init(void) {
    init_lock();
    if (g_rt.initialized) { init_unlock(); return; }

    // Before anything can print. Cheap and idempotent, and this is the one
    // function codegen guarantees runs at the top of every program's main.
    set_stdio_binary();

    // Same reasoning for Winsock: it must be started before the first socket
    // call in the process, and std/net reaches sockets through paths that do
    // not otherwise pass through the runtime. Doing it here means a yoop
    // program never has to think about it. No-op on POSIX.
    yoop_net_startup();

    int n = yoop_cpu_count();
    const char* env = getenv("YOOP_NUM_WORKERS");
    if (env && *env) {
        int v = atoi(env);
        if (v > 0) n = v;
    }
    if (n < 1) n = 1;

    n_workers_target = n;
    g_rt.n_workers  = 0;
    g_rt.shutdown   = 0;
    g_rt.queue_head = NULL;
    g_rt.queue_tail = NULL;
    g_rt.workers    = NULL;
    yoop_mutex_init(&g_rt.queue_mu);
    yoop_cond_init(&g_rt.queue_cv);

    g_rt.initialized = 1;
    init_unlock();
}

// Spawn the worker pool on demand. Caller must hold queue_mu. No-op if
// workers are already spawned.
static void ensure_workers_spawned_locked(void) {
    if (g_rt.workers) return;
    int n = n_workers_target;
    if (n < 1) n = 1;
    g_rt.workers = (yoop_thread_t*)malloc(sizeof(yoop_thread_t) * (size_t)n);
    for (int i = 0; i < n; i++) spawn_worker(&g_rt.workers[i]);
    g_rt.n_workers = n;
}

void yoop_runtime_shutdown(void) {
    init_lock();
    if (!g_rt.initialized) { init_unlock(); return; }

    // Stop the I/O multiplexer if it was lazily started. The
    // shutdown is a no-op when nothing ever called wait_readable/writable.
    yoop_io_shutdown();

    yoop_mutex_lock(&g_rt.queue_mu);
    g_rt.shutdown = 1;
    yoop_cond_broadcast(&g_rt.queue_cv);
    yoop_mutex_unlock(&g_rt.queue_mu);

    if (g_rt.workers) {
        for (int i = 0; i < g_rt.n_workers; i++) join_worker(&g_rt.workers[i]);
        free(g_rt.workers);
        g_rt.workers = NULL;
    }
    g_rt.n_workers = 0;

    // Drain anything left in the queue. Shouldn't happen if every submit was
    // paired with a wait, but don't strand allocations.
    while (g_rt.queue_head) {
        task_node* n = g_rt.queue_head;
        g_rt.queue_head = n->next;
        free(n);
    }
    g_rt.queue_tail = NULL;

    yoop_mutex_destroy(&g_rt.queue_mu);
    yoop_cond_destroy(&g_rt.queue_cv);

    g_rt.initialized = 0;
    init_unlock();
}

// ---- --track-heap diagnostics --------------------------------------------
//
// Compiler-injected counters for the heap_alloc / heap_free intrinsics. The
// symbols are always exported, but main only references them when the
// program was compiled with --track-heap. Atomics keep the counters honest
// when allocations happen from concurrent task bodies.

static _Atomic uint64_t g_diag_bytes_allocated = 0;
static _Atomic uint64_t g_diag_bytes_freed     = 0;
static _Atomic uint64_t g_diag_alloc_count     = 0;
static _Atomic uint64_t g_diag_free_count      = 0;

void yoop_diag_record_alloc(uint64_t bytes) {
    atomic_fetch_add_explicit(&g_diag_bytes_allocated, bytes, memory_order_relaxed);
    atomic_fetch_add_explicit(&g_diag_alloc_count, 1, memory_order_relaxed);
}

void yoop_diag_record_free(uint64_t bytes) {
    atomic_fetch_add_explicit(&g_diag_bytes_freed, bytes, memory_order_relaxed);
    atomic_fetch_add_explicit(&g_diag_free_count, 1, memory_order_relaxed);
}

void yoop_diag_dump(void) {
    uint64_t a  = atomic_load_explicit(&g_diag_bytes_allocated, memory_order_relaxed);
    uint64_t f  = atomic_load_explicit(&g_diag_bytes_freed, memory_order_relaxed);
    uint64_t ac = atomic_load_explicit(&g_diag_alloc_count, memory_order_relaxed);
    uint64_t fc = atomic_load_explicit(&g_diag_free_count, memory_order_relaxed);
    int64_t leaked = (int64_t)a - (int64_t)f;
    fprintf(stderr,
        "[yoop-diag] heap: %llu bytes allocated in %llu calls; %llu bytes freed in %llu calls; net %lld bytes\n",
        (unsigned long long)a, (unsigned long long)ac,
        (unsigned long long)f, (unsigned long long)fc,
        (long long)leaked);
}

// ---- submit / wait --------------------------------------------------------

void yoop_task_submit(void* handle, void (*thunk)(void*)) {
    yoop_mutex_t* m = (yoop_mutex_t*)malloc(sizeof(yoop_mutex_t));
    yoop_cond_t*  c = (yoop_cond_t*) malloc(sizeof(yoop_cond_t));
    yoop_mutex_init(m);
    yoop_cond_init(c);
    *handle_mutex_slot(handle) = m;
    *handle_cond_slot(handle)  = c;
    A_STORE_U8(handle_state_ptr(handle), 0);

    queue_push(handle, thunk);
}

// wait_until passes its absolute monotonic deadline through to the inner
// cv timedwait. There is no safety poll for bare yoop_task_wait -
// yoop_handle_signal_done broadcasts queue_cv after every state flip, so a
// parked waiter wakes the moment the handle completes without polling.
// INFINITE means "no deadline; sleep until a broadcast wakes us."
#define YOOP_WAIT_NO_DEADLINE ((uint64_t)0)

// Block on queue_cv until a broadcast wakes us or the absolute
// monotonic `deadline_ns` elapses (0 = no deadline). Returns 0 on a
// wake, 1 on deadline expiry.
//
// Both platforms share yoop_cv_wait_until_locked rather than each
// hand-rolling an #ifdef body: two bodies disagreeing on the return value
// (ETIMEDOUT on POSIX, 1 on Windows) is how a timeout gets silently read
// as a wake. The shared helper also pins the wait to the same monotonic
// clock yoop_now_ns reads.
static int queue_cv_wait_until_locked(uint64_t deadline_ns) {
    return yoop_cv_wait_until_locked(&g_rt.queue_cv, &g_rt.queue_mu, deadline_ns);
}

// Suspendable wait.
//
// A re-entrant loop that opportunistically drains queued work on the
// calling thread while waiting, so a worker with nothing useful to do can
// run the very task it's blocked on (or one that unblocks it
// transitively). Parking unconditionally on the handle's condvar instead
// would deadlock the pool whenever N workers meet an N+1-deep nested wait
// chain (SPEC section 8).
//
// Re-entrant dispatch is safe: each thunk runs to completion on the calling
// thread's stack, so recursion depth is bounded by the nested-wait chain.
// Non-task callers (e.g. main) participate in the same dispatch path.
void yoop_task_wait(void* handle) {
    for (;;) {
        if (A_LOAD_U8(handle_state_ptr(handle)) != 0) return;

        yoop_mutex_lock(&g_rt.queue_mu);
        task_node* n = try_pop_task_locked();
        if (n) {
            yoop_mutex_unlock(&g_rt.queue_mu);
            run_task_step(n->handle, n->thunk);
            free(n);
            continue;
        }

        // Re-check the target's state after taking the queue lock so a
        // handle-done broadcast that arrived while we were mid-loop is
        // observed before we park.
        if (A_LOAD_U8(handle_state_ptr(handle)) != 0) {
            yoop_mutex_unlock(&g_rt.queue_mu);
            return;
        }

        // Queue empty AND target unfinished. Park on queue_cv until
        // yoop_handle_signal_done broadcasts (handle completed, or a new
        // task arrived). The outer loop re-checks state + the queue
        // regardless of why we woke. There is no safety poll -
        // signal_done's broadcast covers wakeups deterministically.
        queue_cv_wait_until_locked(YOOP_WAIT_NO_DEADLINE);
        yoop_mutex_unlock(&g_rt.queue_mu);
    }
}

// Bounded wait. Returns 0 on completion, 1 on deadline expiry,
// 2 on external cancellation.
//
// Critically, this path does NOT dispatch queued tasks on the calling
// thread the way yoop_task_wait does - a queued task that runs past the
// deadline would invalidate the user's "give up at time T" contract.
// Worker threads continue to drain the queue normally; we only block the
// caller on a cv with the user's deadline as the timeout.
//
// The tradeoff: a wait_until from a worker thread with nested-task
// dependencies can deadlock if every worker is similarly blocked. That's
// preferable to silently overshooting - and the deadline itself caps the
// "stall" at exactly the value the user asked for.
//
// Done always wins ties: if the task completed before we noticed the
// deadline or cancel flag, return 0. Cancel beats Timeout when both
// happen - the user's explicit "abandon" intent is more informative
// than a passive timer expiry.
int yoop_task_wait_until_ns(void* handle, uint64_t deadline_ns) {
    if (deadline_ns == YOOP_WAIT_NO_DEADLINE) {
        // 0 is the "no deadline" sentinel inside the cv wait. Bump to 1ns
        // so a caller passing 0 (which is well in the past) still gets
        // immediate-timeout semantics.
        deadline_ns = 1;
    }
    for (;;) {
        if (A_LOAD_U8(handle_state_ptr(handle)) != 0) return 0;
        if (A_LOAD_U8(handle_cancel_ptr(handle)) != 0) return 2;
        if (yoop_now_ns() >= deadline_ns) return 1;

        yoop_mutex_lock(&g_rt.queue_mu);
        if (A_LOAD_U8(handle_state_ptr(handle)) != 0) {
            yoop_mutex_unlock(&g_rt.queue_mu);
            return 0;
        }
        if (A_LOAD_U8(handle_cancel_ptr(handle)) != 0) {
            yoop_mutex_unlock(&g_rt.queue_mu);
            return 2;
        }
        int rc = queue_cv_wait_until_locked(deadline_ns);
        yoop_mutex_unlock(&g_rt.queue_mu);
        if (rc == 1) {
            // Last-look at state + cancel - a broadcast may have raced
            // with the timeout; prefer Done, then Cancelled, over Timeout.
            if (A_LOAD_U8(handle_state_ptr(handle)) != 0) return 0;
            if (A_LOAD_U8(handle_cancel_ptr(handle)) != 0) return 2;
            return 1;
        }
    }
}

// External cancellation. Set the cancel byte atomically
// and broadcast queue_cv so any waiter parked in
// `yoop_task_wait_until_ns` wakes immediately and observes the flag.
//
// Idempotent: a second cancel on an already-cancelled handle is a no-op
// (the byte's already 1) but still re-broadcasts, which is harmless.
//
// Note that this does NOT wake `yoop_task_wait` callers. Bare `wait` is
// the "I need the result" contract - cancellation only changes whether
// callers willing to abandon (via wait_until) see Cancelled vs. Done.
// The task body keeps running until its natural end; there is no in-body
// polling that would let it short-circuit.
void yoop_task_cancel(void* handle) {
    A_STORE_U8(handle_cancel_ptr(handle), 1);
    yoop_mutex_lock(&g_rt.queue_mu);
    yoop_cond_broadcast(&g_rt.queue_cv);
    yoop_mutex_unlock(&g_rt.queue_mu);
}

// Push a node onto the run queue. Caller MUST hold queue_mu.
static void queue_push_locked(void* handle, void (*thunk)(void*)) {
    task_node* node = (task_node*)malloc(sizeof(task_node));
    if (!node) return;
    node->handle = handle;
    node->thunk  = thunk;
    node->next   = NULL;

    ensure_workers_spawned_locked();
    if (g_rt.queue_tail) g_rt.queue_tail->next = node;
    else                 g_rt.queue_head = node;
    g_rt.queue_tail = node;
    yoop_cond_signal(&g_rt.queue_cv);
}

// Push a node onto the run queue. Caller must NOT hold queue_mu.
static void queue_push(void* handle, void (*thunk)(void*)) {
    yoop_mutex_lock(&g_rt.queue_mu);
    queue_push_locked(handle, thunk);
    yoop_mutex_unlock(&g_rt.queue_mu);
}

// A suspended task became runnable again. thunk == NULL marks a resume
// rather than a start, so run_task_step drives the stored coroutine
// handle instead of re-running the body from the top.
//
// This CANNOT simply queue the handle, and the reason is the whole point of
// the park byte. A wake is armed from INSIDE a running task - `awaitReadable`
// registers its interest and only suspends several frames later, and
// `awaitTask` likewise - so the event can fire while the task is still
// executing on its worker. Queuing it there lets a second worker pop it and
// call coro.resume on a coroutine that is mid-execution on the first, which
// is a data race on the coroutine frame rather than a lost wakeup.
//
// So the wake is recorded instead: PARKED means the task really is suspended
// and can be queued, RUNNING means "remember this and let run_task_step
// re-queue it the moment the step ends". Same three-state shape as the thread
// park token further down (yoop_park / yoop_unpark), for the same reason.
static void make_runnable_locked(void* handle) {
    unsigned char* park = (unsigned char*)handle_park_ptr(handle);
    if (*park == YOOP_PARK_PARKED) {
        *park = YOOP_PARK_RUNNING;
        queue_push_locked(handle, NULL);
    } else {
        // RUNNING (mid-step, or already queued): record the wake. The step's
        // tail re-queues it; an already-queued task is about to run anyway,
        // and run_task_step resets the byte before the step, so the recorded
        // wake is dropped exactly when it has already been satisfied.
        *park = YOOP_PARK_WAKE;
    }
}

// End of a step that left the task suspended. A wake that arrived mid-step is
// consumed here rather than lost, which is the half of the protocol that
// makes arming-then-suspending safe.
static void park_or_requeue_locked(void* handle) {
    unsigned char* park = (unsigned char*)handle_park_ptr(handle);
    if (*park == YOOP_PARK_WAKE) {
        *park = YOOP_PARK_RUNNING;
        queue_push_locked(handle, NULL);
    } else {
        *park = YOOP_PARK_PARKED;
    }
}

void yoop_task_make_runnable(void* handle) {
    if (!handle) return;
    yoop_mutex_lock(&g_rt.queue_mu);
    make_runnable_locked(handle);
    yoop_mutex_unlock(&g_rt.queue_mu);
}

// ---- completion waiters ---------------------------------------------------
//
// "Make the CURRENT task runnable when `target` completes." This is what lets
// one task join another without blocking a worker - the joiner suspends, and
// the target's own completion path hands it back to the queue.
//
// A flat list under queue_mu: the counts here are the number of tasks blocked
// on other tasks at one instant, which is small, and every operation already
// needs that lock. A per-handle waiter list would save the scan at the cost of
// another field in the handle prefix and another thing to keep in sync.
typedef struct task_waiter {
    void* target;               // the handle being awaited
    void* waiter;               // the task to wake when it completes
    struct task_waiter* next;
} task_waiter;

static task_waiter* g_waiters = NULL;   // guarded by queue_mu

// Drop every registration belonging to `waiter`. Caller holds queue_mu.
// One wake is all a task needs, so a task armed on N targets (race) is fully
// disarmed by the first of them to fire - otherwise the survivors would keep
// queuing a task that has already moved on.
static void disarm_waiter_locked(void* waiter) {
    task_waiter** pp = &g_waiters;
    while (*pp) {
        task_waiter* w = *pp;
        if (w->waiter == waiter) { *pp = w->next; free(w); }
        else                     { pp = &w->next; }
    }
}

int yoop_task_is_done(void* handle) {
    if (!handle) return 1;
    return A_LOAD_U8(handle_state_ptr(handle)) != 0 ? 1 : 0;
}

int yoop_task_arm_complete(void* target) {
    void* cur = tls_current_task;
    // Not running on a worker (main, say). There would be nothing to make
    // runnable, so refuse and let the caller fall back to a blocking wait -
    // same contract, and same return value, as yoop_io_arm_readable.
    if (!cur) return 1;
    if (!target) return 2;

    yoop_mutex_lock(&g_rt.queue_mu);
    // Checked under the lock that signal_done's wake also takes, so a target
    // completing right now either is visible here or will find our
    // registration. It cannot slip between the two.
    if (A_LOAD_U8(handle_state_ptr(target)) != 0) {
        yoop_mutex_unlock(&g_rt.queue_mu);
        return 2;   // already done - nothing to wait for
    }
    task_waiter* w = (task_waiter*)malloc(sizeof(task_waiter));
    if (!w) {
        yoop_mutex_unlock(&g_rt.queue_mu);
        return -1;
    }
    w->target = target;
    w->waiter = cur;
    w->next   = g_waiters;
    g_waiters = w;
    yoop_mutex_unlock(&g_rt.queue_mu);
    return 0;
}

void yoop_task_disarm_complete(void) {
    void* cur = tls_current_task;
    if (!cur) return;
    yoop_mutex_lock(&g_rt.queue_mu);
    disarm_waiter_locked(cur);
    yoop_mutex_unlock(&g_rt.queue_mu);
}

// Wake everything registered against `handle`. Caller holds queue_mu.
static void fire_waiters_locked(void* handle) {
    task_waiter* w = g_waiters;
    while (w) {
        task_waiter* next = w->next;
        if (w->target == handle) {
            void* waiter = w->waiter;
            disarm_waiter_locked(waiter);   // frees w, and any siblings
            make_runnable_locked(waiter);
            next = g_waiters;               // list was rewritten; restart
        }
        w = next;
    }
}

// End of one task step. Either the coroutine reached its final suspend -
// its result is already sitting in the task's own slot, because the
// thunk handed the body that slot as its return destination - or it
// merely suspended and something else will make it runnable later.
void yoop_task_settle(void* handle) {
    void* coro = *handle_coro_slot(handle);
    if (!coro || !g_coro_done) {
        // No coroutine (or no ops installed): the step ran to completion
        // synchronously. Anything else would leave the task unfinished
        // forever and hang every waiter.
        yoop_handle_signal_done(handle);
        return;
    }
    if (!g_coro_done(coro)) {
        return;   // suspended - the worker is free, the task stays parked
    }
    // Finished. Destroy the frame BEFORE signalling: once state flips, a
    // waiter can return and drop the last reference to the handle.
    *handle_coro_slot(handle) = NULL;
    if (g_coro_destroy) g_coro_destroy(coro);
    yoop_handle_signal_done(handle);
}

void yoop_handle_signal_done(void* handle) {
    yoop_mutex_t* m = *handle_mutex_slot(handle);
    yoop_cond_t*  c = *handle_cond_slot(handle);
    yoop_mutex_lock(m);
    A_STORE_U8(handle_state_ptr(handle), 1);
    yoop_cond_broadcast(c);
    yoop_mutex_unlock(m);

    // Also broadcast queue_cv so suspendable yoop_task_wait callers
    // parked on queue_cv (waiting either for new work or for state to flip)
    // wake up immediately. Without this they'd only see the state change on
    // the next YOOP_WAIT_POLL_MS timer tick.
    yoop_mutex_lock(&g_rt.queue_mu);
    yoop_cond_broadcast(&g_rt.queue_cv);
    // And hand any task that suspended waiting on THIS one back to the queue.
    // Under the same lock arm_complete takes, so a joiner arming right now
    // either sees state != 0 and skips suspending, or is registered here.
    fire_waiters_locked(handle);
    yoop_mutex_unlock(&g_rt.queue_mu);

    int32_t rc = A_LOAD_I32(handle_rc_ptr(handle));
    if (rc > 0) yoop_task_release(handle);
}

// ---- pooled lifecycle -----------------------------------------------------

void* yoop_task_alloc(size_t size) {
    void* p = calloc(1, size);
    // Initial refcount = 2 (caller + worker thunk).
    A_STORE_I32(handle_rc_ptr(p), 2);
    return p;
}

void yoop_task_retain(void* handle) {
    A_INC_I32(handle_rc_ptr(handle));
}

void yoop_task_release(void* handle) {
    int32_t prev = A_DEC_I32(handle_rc_ptr(handle));
    if (prev == 1) {
        yoop_task_free_sync_pair(handle);
        // Normally already gone - run_task_step discards it the moment the
        // task finishes. This catches a task that suspended with a context
        // installed and was then abandoned rather than resumed.
        yoop_ctx_discard_task(handle_ctx_slot(handle));
        free(handle);
    }
}

void yoop_task_free_sync_pair(void* handle) {
    yoop_mutex_t** mp = handle_mutex_slot(handle);
    yoop_cond_t**  cp = handle_cond_slot(handle);
    if (*mp) { yoop_mutex_destroy(*mp); free(*mp); *mp = NULL; }
    if (*cp) { yoop_cond_destroy(*cp);  free(*cp); *cp = NULL; }
}

// ---- errno bridge ---------------------------------------------------------
// Thin wrappers so the codegen never has to name the platform-specific
// thread-local errno symbol directly. The C compiler picks the right
// lvalue for the host (macOS __error, glibc/musl __errno_location, Windows
// _errno).
#include <errno.h>

int yoop_errno_get(void) {
    return errno;
}

void yoop_errno_set(int v) {
    errno = v;
}

const char* yoop_errno_message(int c) {
    // strerror returns a pointer into static storage. Not strictly
    // thread-safe (POSIX vs glibc strerror_r divergence is the reason we
    // skip strerror_r here), but the typical call shape is "format right
    // before logging" where the race is benign.
    return strerror(c);
}

// ---- park tokens ----------------------------------------------------------
// State machine (see header for the contract):
//   0 = idle, 1 = pending wake, 2 = parking.

void yoop_park_token_init(yoop_park_token_t* t) {
    t->mu = (yoop_mutex_t*)malloc(sizeof(yoop_mutex_t));
    t->cv = (yoop_cond_t*) malloc(sizeof(yoop_cond_t));
    yoop_mutex_init(t->mu);
    yoop_cond_init(t->cv);
    t->state = 0;
}

void yoop_park_token_destroy(yoop_park_token_t* t) {
    if (t->mu) { yoop_mutex_destroy(t->mu); free(t->mu); t->mu = NULL; }
    if (t->cv) { yoop_cond_destroy(t->cv);  free(t->cv); t->cv = NULL; }
    t->state = 0;
}

void yoop_park(yoop_park_token_t* t) {
    yoop_mutex_lock(t->mu);
    if (t->state == 1) {
        // Pre-armed: consume the wake and return without blocking.
        t->state = 0;
        yoop_mutex_unlock(t->mu);
        return;
    }
    t->state = 2; // parking
    while (t->state == 2) {
        yoop_cond_wait(t->cv, t->mu);
    }
    // Woken by unpark: state has been flipped to 0 by the unparker.
    yoop_mutex_unlock(t->mu);
}

// Timed park. Returns 0 when an unpark was consumed, 1 when
// `deadline_ns` elapsed first (0 = no deadline, identical to yoop_park).
//
// On the timeout path the token is restored to idle rather than left in
// the "parking" state, so an unpark that lands a moment later is
// remembered as a pending wake instead of being dropped on the floor.
// That keeps the token reusable, but it does NOT by itself make
// abandoning safe: whoever owns the token still has to prove no unpark
// is in flight before freeing the storage. yoop_io.c does that with the
// fired-under-io_mu handshake.
int yoop_park_until(yoop_park_token_t* t, uint64_t deadline_ns) {
    yoop_mutex_lock(t->mu);
    if (t->state == 1) {
        t->state = 0;
        yoop_mutex_unlock(t->mu);
        return 0;
    }
    if (deadline_ns == 0) {
        t->state = 2;
        while (t->state == 2) {
            yoop_cond_wait(t->cv, t->mu);
        }
        yoop_mutex_unlock(t->mu);
        return 0;
    }

    t->state = 2; // parking
    int timed_out = 0;
    while (t->state == 2) {
        if (yoop_cv_wait_until_locked(t->cv, t->mu, deadline_ns) == 1) {
            // Deadline hit. Re-check state under the lock: an unpark may
            // have raced in, in which case it wins (state is already 0).
            if (t->state == 2) {
                t->state = 0;
                timed_out = 1;
            }
            break;
        }
    }
    yoop_mutex_unlock(t->mu);
    return timed_out;
}

void yoop_unpark(yoop_park_token_t* t) {
    yoop_mutex_lock(t->mu);
    if (t->state == 2) {
        // Parked: wake the parker. The parker's loop sees state==0
        // and returns.
        t->state = 0;
        yoop_cond_signal(t->cv);
    } else if (t->state == 0) {
        // Pre-arm: idempotent - a second pre-arm before park is fine.
        t->state = 1;
    }
    // state == 1 already → already pre-armed, nothing to do.
    yoop_mutex_unlock(t->mu);
}

// ---- timers ---------------------------------------------------------------
#include <time.h>
#include <errno.h>

// Sleep for `ns`. Built on the same mutex/cond pair + shared timed wait
// every other blocking path uses, so it agrees with yoop_now_ns by
// construction. Hand-rolling its own condattr dance inline is how the
// clock choice would drift from the deadline clock the task waits use.
int yoop_sleep_ns(uint64_t ns) {
    if (ns == 0) return 0;

    yoop_mutex_t mu;
    yoop_cond_t  cv;
    yoop_mutex_init(&mu);
    yoop_cond_init(&cv);

    uint64_t deadline = yoop_now_ns() + ns;

    yoop_mutex_lock(&mu);
    // Nobody holds cv, so every wake is spurious - loop until the
    // deadline actually elapses.
    while (yoop_cv_wait_until_locked(&cv, &mu, deadline) == 0) {
        if (yoop_now_ns() >= deadline) break;
    }
    yoop_mutex_unlock(&mu);

    yoop_cond_destroy(&cv);
    yoop_mutex_destroy(&mu);
    return 0;
}

int yoop_sleep_ms(uint64_t ms) {
    return yoop_sleep_ns(ms * 1000000ULL);
}

// The deadline clock. Monotonic on every platform, so an NTP step (or any
// manual clock change) cannot move an in-flight deadline. Every timed wait
// in the runtime goes through yoop_cv_wait_until_locked, which is pinned to
// this same clock, so `yoop_now_ns() + duration` is always a valid
// deadline.
//
// Callers who want an actual timestamp want yoop_wall_ns instead.
uint64_t yoop_now_ns(void) {
#ifdef _WIN32
    static LARGE_INTEGER freq;
    static int freq_ready = 0;
    if (!freq_ready) { QueryPerformanceFrequency(&freq); freq_ready = 1; }
    LARGE_INTEGER c;
    QueryPerformanceCounter(&c);
    // Split to avoid overflowing the multiply on long-running processes.
    uint64_t q = (uint64_t)freq.QuadPart;
    uint64_t whole = (uint64_t)c.QuadPart / q;
    uint64_t rem   = (uint64_t)c.QuadPart % q;
    return whole * 1000000000ULL + (rem * 1000000000ULL) / q;
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
#endif
}

// Wall-clock nanoseconds since the Unix epoch. Can step backwards -
// never use it as a deadline base.
uint64_t yoop_wall_ns(void) {
#ifdef _WIN32
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    uint64_t hundred_ns = ((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    // FILETIME epoch is 1601-01-01; rebase to Unix epoch (1970-01-01).
    // Difference is 11644473600 seconds = 116444736000000000 100ns ticks.
    hundred_ns -= 116444736000000000ULL;
    return hundred_ns * 100ULL;
#else
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
#endif
}

// ---- process + pool introspection ----------------------------------------
//
// The surface behind std/runtime.yoop. Two jobs: let a program size the
// worker pool from source instead of only from YOOP_NUM_WORKERS, and give
// it the handful of numbers a service is expected to be able to report
// about itself.

// `yoop_cpu_count` is a `static inline` in yoop_platform.h, so it is not a
// linkable symbol. This is the exported view of it.
int yoop_runtime_cpu_count(void) {
    return yoop_cpu_count();
}

// Which platform this runtime was COMPILED for. See YOOP_PLATFORM_* in
// yoop_runtime.h for the values.
//
// This exists so the bootstrap compiler can build a link line the way
// src/toolchain.js does. The reference reads `process.platform`; the bootstrap
// is a native binary with no equivalent, and the link module says so in a
// comment ("the bootstrap cannot do that yet because it has no platform
// check") next to two rules it was getting wrong as a result - emitting
// `-framework` off Apple, and having no way to add Linux's `-lm`.
//
// An int rather than a string keeps the yoop-side binding to a plain `c_int`
// and sidesteps the question of who owns a returned `const char*`.
//
// Host and target are the same thing here: nothing in the tree
// cross-compiles, and the runtime is built by the same clang that links the
// program. If cross-compilation ever lands this becomes a property of the
// target rather than a fact about the runtime binary, and moves accordingly.
int yoop_runtime_platform(void) {
#if defined(_WIN32)
    return YOOP_PLATFORM_WINDOWS;
#elif defined(__APPLE__)
    return YOOP_PLATFORM_MACOS;
#elif defined(__linux__)
    return YOOP_PLATFORM_LINUX;
#else
    return YOOP_PLATFORM_UNKNOWN;
#endif
}

// Once the pool is spawned `n_workers` is the truth; before that, the
// target is what the pool WILL be.
int yoop_runtime_worker_count(void) {
    int n = g_rt.n_workers;
    return n > 0 ? n : n_workers_target;
}

// Resize the pool target. Workers are spawned lazily on the first task
// submit, so this only takes effect while none exist yet - which is the
// honest contract, since shrinking a live pool would mean stopping threads
// that may be mid-task. Returns 1 if the new target was accepted, 0 if the
// pool is already running (or `n` is nonsense).
int yoop_runtime_set_worker_count(int n) {
    if (n < 1) return 0;
    int ok = 0;
    yoop_mutex_lock(&g_rt.queue_mu);
    if (!g_rt.workers) {
        n_workers_target = n;
        ok = 1;
    }
    yoop_mutex_unlock(&g_rt.queue_mu);
    return ok;
}

// ---- shared 64-bit counters ----------------------------------------------
//
// Worker threads share one address space, so a counter touched from more
// than one of them needs a read-modify-write that cannot lose an update.
// These take an ordinary `ref uint64` from yoop (which lowers to a plain
// pointer) rather than introducing an opaque handle type, so the storage
// stays an ordinary field the owner can lay out as it likes.
//
// acq_rel on the RMWs: a counter is frequently published alongside other
// state ("bump the total, then read the slot"), and relaxed would let
// those reorder across it.

uint64_t yoop_atomic_add_u64(uint64_t* p, uint64_t delta) {
    return atomic_fetch_add_explicit((_Atomic uint64_t*)p, delta, memory_order_acq_rel) + delta;
}

uint64_t yoop_atomic_sub_u64(uint64_t* p, uint64_t delta) {
    return atomic_fetch_sub_explicit((_Atomic uint64_t*)p, delta, memory_order_acq_rel) - delta;
}

uint64_t yoop_atomic_load_u64(uint64_t* p) {
    return atomic_load_explicit((_Atomic uint64_t*)p, memory_order_acquire);
}

void yoop_atomic_store_u64(uint64_t* p, uint64_t v) {
    atomic_store_explicit((_Atomic uint64_t*)p, v, memory_order_release);
}

// Compare-and-swap. Returns 1 on success; on failure writes the observed
// value back through `expected` so a retry loop needs no second load.
int yoop_atomic_cas_u64(uint64_t* p, uint64_t* expected, uint64_t desired) {
    return atomic_compare_exchange_strong_explicit(
        (_Atomic uint64_t*)p, expected, desired,
        memory_order_acq_rel, memory_order_acquire) ? 1 : 0;
}

// ---- resident set size ---------------------------------------------------
//
// Bytes of physical memory the process currently occupies - the number a
// container's memory limit is enforced against, and the one worth graphing
// during a load test. Returns 0 where it cannot be determined rather than
// guessing.
uint64_t yoop_runtime_rss_bytes(void) {
#if defined(_WIN32)
    // Would need PSAPI (GetProcessMemoryInfo) and the psapi link flag.
    // Not wired up; callers get 0 and should treat it as "unavailable".
    return 0;
#elif defined(__APPLE__)
    // mach_task_basic_info reports resident_size directly.
    mach_task_basic_info_data_t info;
    mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
    if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO,
                  (task_info_t)&info, &count) != KERN_SUCCESS) {
        return 0;
    }
    return (uint64_t)info.resident_size;
#else
    // /proc/self/statm field 2 is the resident set in PAGES.
    FILE* f = fopen("/proc/self/statm", "r");
    if (!f) return 0;
    unsigned long total_pages = 0, rss_pages = 0;
    int got = fscanf(f, "%lu %lu", &total_pages, &rss_pages);
    fclose(f);
    if (got != 2) return 0;
    long page = sysconf(_SC_PAGESIZE);
    if (page <= 0) return 0;
    return (uint64_t)rss_pages * (uint64_t)page;
#endif
}
