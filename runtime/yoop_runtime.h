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

#ifdef __cplusplus
}
#endif

#endif
