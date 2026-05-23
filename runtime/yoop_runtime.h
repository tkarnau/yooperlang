// Yooperlang runtime — C ABI exposed to LLVM IR emitted by jsyoopcodegen.
// See plans/phase-6-3-prelude.md and plans/runtime-design.md.
#ifndef YOOP_RUNTIME_H
#define YOOP_RUNTIME_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Opaque platform types. Concrete layout in yoop_runtime.c.
typedef struct yoop_mutex  yoop_mutex_t;
typedef struct yoop_cond   yoop_cond_t;
typedef struct yoop_thread yoop_thread_t;

// init / shutdown — both idempotent.
void yoop_runtime_init(void);
void yoop_runtime_shutdown(void);

// scheduling
void yoop_task_submit(void* handle, void (*thunk)(void*));
void yoop_task_wait(void* handle);

// pooled lifecycle
void* yoop_task_alloc(size_t size);
void  yoop_task_retain(void* handle);
void  yoop_task_release(void* handle);

// Called from per-task thunks after the result has been stored: flips state to
// 1, broadcasts the condvar, and (for pooled handles) drops the worker's
// implicit reference.
void yoop_handle_signal_done(void* handle);

// Stack-handle cleanup helper. For stack-allocated handles, codegen calls this
// at scope exit to release the mutex/cond pair allocated by yoop_task_submit.
void yoop_task_free_sync_pair(void* handle);

// Phase 8.D — errno bridge. Thread-local read/write of the platform's errno
// lvalue (macOS __error(), glibc/musl __errno_location(), Windows _errno),
// plus a thin strerror wrapper. Kept in the runtime so yoop codegen does
// not have to know the platform-specific symbol for errno's TLS slot.
int yoop_errno_get(void);
void yoop_errno_set(int v);
const char* yoop_errno_message(int c);

// ----- Phase 8.F.1 — Concurrency primitives -------------------------------
//
// A park token is a single-thread synchronization primitive. The owning
// thread (the "parker") calls yoop_park() to block; another thread
// (typically the multiplexer or timer thread) calls yoop_unpark() to
// release it. Unpark-before-park is supported: the wake is remembered
// until the next park consumes it.
//
// Ownership rules:
//   - Exactly one thread calls yoop_park on a given token.
//   - Any number of threads may call yoop_unpark.
//   - Destroying a token while it might be parked or unparked is UB.
//     Callers must ensure all in-flight unpark() calls have completed
//     before destroy().
//
// State machine:
//   0 = idle           : park will block; unpark transitions to 1
//   1 = pending wake   : park returns immediately, transitions back to 0
//   2 = parking        : a yoop_park is blocked on cv; unpark signals it
//
// Internal layout (do not access fields directly):
typedef struct yoop_park_token {
    struct yoop_mutex* mu;   // allocated by init, freed by destroy
    struct yoop_cond*  cv;
    int                state;
} yoop_park_token_t;

void yoop_park_token_init(yoop_park_token_t* t);
void yoop_park_token_destroy(yoop_park_token_t* t);
void yoop_park(yoop_park_token_t* t);
void yoop_unpark(yoop_park_token_t* t);

// ----- Phase 8.F.3 — Timers ------------------------------------------------
//
// Block the calling thread for `ns` nanoseconds (or `ms` milliseconds).
// Returns 0 on the timer firing, -1 on error with errno set. The clock
// is monotonic on Linux (CLOCK_MONOTONIC via pthread_condattr_setclock),
// and CLOCK_REALTIME on macOS (where pthread_condattr_setclock isn't
// available). Both are monotonic-enough for sleep-for-duration uses.
int yoop_sleep_ns(uint64_t ns);
int yoop_sleep_ms(uint64_t ms);

// ----- Phase 8.F.2 — I/O multiplexer (forward declarations) ----------------
// Implemented in runtime/yoop_io.c. Declared here so callers don't need
// a second header. Lazy init on first call; shutdown is hooked into
// yoop_runtime_shutdown if init ran.
int yoop_io_wait_readable(int fd);
int yoop_io_wait_writable(int fd);
void yoop_io_shutdown(void);

#ifdef __cplusplus
}
#endif

#endif
