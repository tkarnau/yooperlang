// Yooperlang runtime - C ABI exposed to LLVM IR emitted by jsyoopcodegen.
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

// init / shutdown - both idempotent.
void yoop_runtime_init(void);
void yoop_runtime_shutdown(void);

// scheduling
void yoop_task_submit(void* handle, void (*thunk)(void*));
void yoop_task_wait(void* handle);

// Phase 10.F: bounded wait. Returns 0 when the handle's state flipped to
// "done" before `deadline_ns` (a monotonic-clock nanosecond reading from
// yoop_now_ns), 1 when the deadline elapsed first, 2 when an external
// `yoop_task_cancel` was observed before either. Does not dispatch
// queued tasks on the calling thread - see runtime/yoop_runtime.c for
// the rationale.
int yoop_task_wait_until_ns(void* handle, uint64_t deadline_ns);

// Phase 10.F.2: external cancellation. Atomically sets the cancel byte
// in the handle's prefix (offset 9 - reuses one of the existing pad
// bytes between `state` and `refcount`, so no ABI/layout change) and
// broadcasts queue_cv so any wait_until parked on the handle wakes
// immediately and observes the cancellation.
//
// Cancellation is cooperative on the task-body side: the worker thread
// still runs the body to natural completion. The semantics this
// primitive provides is "abandon-the-wait": the caller can stop
// waiting for the result and treat the handle as done-from-its-side.
// In-body polling (Phase 10.F.2.b) will give task bodies a way to
// observe the same flag and exit early.
void yoop_task_cancel(void* handle);

// Phase 10.F: monotonic clock reading in nanoseconds, suitable for
// computing wait_until deadlines (`now_ns() + duration_ns`). The clock
// source matches the one the cv timeouts use (CLOCK_MONOTONIC on Linux,
// CLOCK_REALTIME on macOS) so deltas stay consistent across both.
uint64_t yoop_now_ns(void);

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

// Phase 8.D - errno bridge. Thread-local read/write of the platform's errno
// lvalue (macOS __error(), glibc/musl __errno_location(), Windows _errno),
// plus a thin strerror wrapper. Kept in the runtime so yoop codegen does
// not have to know the platform-specific symbol for errno's TLS slot.
int yoop_errno_get(void);
void yoop_errno_set(int v);
const char* yoop_errno_message(int c);

// ----- Phase 8.F.1 - Concurrency primitives -------------------------------
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

// ----- Phase 8.F.3 - Timers ------------------------------------------------
//
// Block the calling thread for `ns` nanoseconds (or `ms` milliseconds).
// Returns 0 on the timer firing, -1 on error with errno set. The clock
// is monotonic on Linux (CLOCK_MONOTONIC via pthread_condattr_setclock),
// and CLOCK_REALTIME on macOS (where pthread_condattr_setclock isn't
// available). Both are monotonic-enough for sleep-for-duration uses.
int yoop_sleep_ns(uint64_t ns);
int yoop_sleep_ms(uint64_t ms);

// ----- --track-heap diagnostics --------------------------------------------
//
// Counter ABI used by `--track-heap` builds. yoop_diag_record_alloc and
// yoop_diag_record_free are emitted by codegen alongside each heap_alloc /
// heap_free intrinsic; yoop_diag_dump is called from main immediately
// before yoop_runtime_shutdown. The bytes argument is the malloc/free
// byte size (count * sizeof(elem)), not the element count.
void yoop_diag_record_alloc(uint64_t bytes);
void yoop_diag_record_free(uint64_t bytes);
void yoop_diag_dump(void);

// ----- Phase 8.F.2 - I/O multiplexer (forward declarations) ----------------
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
