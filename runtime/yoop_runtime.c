// Yooperlang runtime — worker pool, task submit/wait, and pooled refcount
// lifecycle. See plans/runtime-design.md and plans/phase-6-3-prelude.md.
//
// The Task<T> handle layout (set in stone by the compiler / runtime contract):
//   offset 0:  void(*)(void*)  thunk
//   offset 8:  uint8_t         state (0=unstarted, 1=done)
//   offset 12: int32_t         refcount (0 = stack, >=1 = pooled)
//   offset 16: yoop_mutex_t*   per-handle mutex (heap-allocated)
//   offset 24: yoop_cond_t*    per-handle cond  (heap-allocated)
//   offset 32+: compiler-owned (result slot + args blob)

#include "yoop_runtime.h"

#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

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
  static inline void yoop_cond_destroy(yoop_cond_t* c)   { (void)c; }
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

  static int yoop_cpu_count(void) {
      long n = sysconf(_SC_NPROCESSORS_ONLN);
      return (n > 0) ? (int)n : 1;
  }
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
static inline void*          handle_rc_ptr    (void* h) { return (char*)h + 12; }

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

void yoop_runtime_init(void) {
    init_lock();
    if (g_rt.initialized) { init_unlock(); return; }

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

    // Phase 8.F.2: stop the I/O multiplexer if it was lazily started. The
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

// ---- submit / wait --------------------------------------------------------

void yoop_task_submit(void* handle, void (*thunk)(void*)) {
    yoop_mutex_t* m = (yoop_mutex_t*)malloc(sizeof(yoop_mutex_t));
    yoop_cond_t*  c = (yoop_cond_t*) malloc(sizeof(yoop_cond_t));
    yoop_mutex_init(m);
    yoop_cond_init(c);
    *handle_mutex_slot(handle) = m;
    *handle_cond_slot(handle)  = c;
    A_STORE_U8(handle_state_ptr(handle), 0);

    task_node* node = (task_node*)malloc(sizeof(task_node));
    node->handle = handle;
    node->thunk  = thunk;
    node->next   = NULL;

    yoop_mutex_lock(&g_rt.queue_mu);
    ensure_workers_spawned_locked();
    if (g_rt.queue_tail) g_rt.queue_tail->next = node;
    else                 g_rt.queue_head = node;
    g_rt.queue_tail = node;
    yoop_cond_signal(&g_rt.queue_cv);
    yoop_mutex_unlock(&g_rt.queue_mu);
}

void yoop_task_wait(void* handle) {
    yoop_mutex_t* m = *handle_mutex_slot(handle);
    yoop_cond_t*  c = *handle_cond_slot(handle);
    yoop_mutex_lock(m);
    while (A_LOAD_U8(handle_state_ptr(handle)) == 0) {
        yoop_cond_wait(c, m);
    }
    yoop_mutex_unlock(m);
}

void yoop_handle_signal_done(void* handle) {
    yoop_mutex_t* m = *handle_mutex_slot(handle);
    yoop_cond_t*  c = *handle_cond_slot(handle);
    yoop_mutex_lock(m);
    A_STORE_U8(handle_state_ptr(handle), 1);
    yoop_cond_broadcast(c);
    yoop_mutex_unlock(m);

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
        free(handle);
    }
}

void yoop_task_free_sync_pair(void* handle) {
    yoop_mutex_t** mp = handle_mutex_slot(handle);
    yoop_cond_t**  cp = handle_cond_slot(handle);
    if (*mp) { yoop_mutex_destroy(*mp); free(*mp); *mp = NULL; }
    if (*cp) { yoop_cond_destroy(*cp);  free(*cp); *cp = NULL; }
}

// ---- Phase 8.D: errno bridge ----------------------------------------------
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

// ---- Phase 8.F.1: park tokens --------------------------------------------
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

void yoop_unpark(yoop_park_token_t* t) {
    yoop_mutex_lock(t->mu);
    if (t->state == 2) {
        // Parked: wake the parker. The parker's loop sees state==0
        // and returns.
        t->state = 0;
        yoop_cond_signal(t->cv);
    } else if (t->state == 0) {
        // Pre-arm: idempotent — a second pre-arm before park is fine.
        t->state = 1;
    }
    // state == 1 already → already pre-armed, nothing to do.
    yoop_mutex_unlock(t->mu);
}

// ---- Phase 8.F.3: timers --------------------------------------------------
#include <time.h>
#include <errno.h>

// Compute deadline.tv_sec / tv_nsec = now + ns. `clock_id` is the clock
// that pthread_cond_timedwait will use; on Linux this is set via
// pthread_condattr_setclock(CLOCK_MONOTONIC), on macOS it's always
// CLOCK_REALTIME.
static void deadline_from_now(struct timespec* deadline, uint64_t ns,
                              clockid_t clock_id) {
    clock_gettime(clock_id, deadline);
    deadline->tv_sec  += (time_t)(ns / 1000000000ULL);
    long add_ns        = (long)(ns % 1000000000ULL);
    deadline->tv_nsec += add_ns;
    if (deadline->tv_nsec >= 1000000000L) {
        deadline->tv_sec  += 1;
        deadline->tv_nsec -= 1000000000L;
    }
}

int yoop_sleep_ns(uint64_t ns) {
#ifdef _WIN32
    // Windows uses sleep/SleepEx for ms granularity; ns gets rounded.
    DWORD ms = (DWORD)((ns + 999999ULL) / 1000000ULL);
    Sleep(ms);
    return 0;
#else
    pthread_mutex_t mu;
    pthread_cond_t  cv;
    pthread_mutex_init(&mu, NULL);

  #if defined(__linux__)
    // Linux supports overriding the cond's clock. Use CLOCK_MONOTONIC so
    // wall-clock jumps (NTP) don't move the deadline.
    pthread_condattr_t attrs;
    pthread_condattr_init(&attrs);
    pthread_condattr_setclock(&attrs, CLOCK_MONOTONIC);
    pthread_cond_init(&cv, &attrs);
    pthread_condattr_destroy(&attrs);
    clockid_t clock_id = CLOCK_MONOTONIC;
  #else
    // macOS / BSD: pthread_cond_timedwait always uses CLOCK_REALTIME.
    pthread_cond_init(&cv, NULL);
    clockid_t clock_id = CLOCK_REALTIME;
  #endif

    struct timespec deadline;
    deadline_from_now(&deadline, ns, clock_id);

    pthread_mutex_lock(&mu);
    int rc;
    do {
        rc = pthread_cond_timedwait(&cv, &mu, &deadline);
        // rc == 0 means "signaled," which can't happen since no one
        // holds cv. Treat as a spurious wake and re-wait.
    } while (rc == 0);
    pthread_mutex_unlock(&mu);

    pthread_cond_destroy(&cv);
    pthread_mutex_destroy(&mu);

    return rc == ETIMEDOUT ? 0 : -1;
#endif
}

int yoop_sleep_ms(uint64_t ms) {
    return yoop_sleep_ns(ms * 1000000ULL);
}
