// yoop_alloc.h - the allocator context and arena entry points.
//
// std/core/alloc.yoop's extern block already names this header as the source
// of these symbols; until the per-task context landed there was nothing for
// C to include, because nothing in the runtime called into yoop_alloc.c. The
// scheduler does now (run_task_step swaps the allocator context around every
// task step), so the declarations have to exist somewhere both translation
// units can see.
#ifndef YOOP_ALLOC_H
#define YOOP_ALLOC_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// Mirrors the yoop `Allocator` struct field-for-field (the ABI). The fn
// pointers stored here are yoop functions (cAlloc / arenaAllocFn / ...),
// which have a C-compatible ABI, so C can both copy and call them.
typedef struct {
  void* alloc;    // void* (*)(void* data, size_t size, size_t align)
  void* realloc;  // unused by the dispatchers
  void* free;     // void  (*)(void* data, void* ptr)
  void* data;
} YoopAllocator;

// A saved allocator context, small enough to live on the stack of whoever
// is swapping (see run_task_step). `task_slot` carries the swapper's notion of
// "which task is current" so that nested steps restore correctly - task steps
// DO nest, because yoop_task_wait drains the queue on the calling thread.
typedef struct {
  YoopAllocator alloc;
  int           set;        // 0 = nothing installed; the dispatchers use malloc
  void**        task_slot;  // opaque: the context slot that was current
} YoopCtxSave;

// ---- the ambient (per-thread) current allocator ---------------------------

void* yoop_get_allocator(void);
void  yoop_set_allocator(void* src);

// Allocate through the current allocator. NEVER returns NULL: an exhausted
// allocator prints what it wanted and what was available, flushes stdout so
// the program's own output survives, and exits(1). A silent null here used to
// surface as a SIGSEGV several frames later with no output at all.
void* yoop_ctx_alloc(size_t size, size_t align);

// The non-fatal sibling: returns NULL instead of exiting, for callers that
// genuinely handle exhaustion.
void* yoop_ctx_alloc_try(size_t size, size_t align);

// Record why an allocation is about to fail, for the abort path to report.
// Called by an allocator immediately before it returns NULL; consumed by the
// next yoop_ctx_alloc failure. Pass NULL to clear.
void  yoop_alloc_note_failure(const char* note);

void  yoop_ctx_free(void* ptr);

// ---- the per-task allocator context ---------------------------------------
//
// The ambient allocator is thread-scoped, but the thing that owns it is a
// TASK: a task suspended inside an arena scope resumes on a different worker,
// and the worker it left behind must not hand the parked task's arena to
// whatever it picks up next. The scheduler therefore swaps the context around
// every task step, exactly as it already does for tls_current_task.
//
// `slot` is always a pointer to the task handle's context slot (offset 40).
// Passing the slot rather than the handle keeps the handle layout knowledge
// in yoop_runtime.c, where it belongs. The slot's contents are owned here and
// opaque there. See plans/async-allocator-context.md.

// Save / restore the CALLING THREAD's own context around a step.
void yoop_ctx_save(YoopCtxSave* out);
void yoop_ctx_restore(const YoopCtxSave* saved);

// Install the task's saved context, or the default if it has none, and mark
// this task as current for the duration of the step. A task deliberately does
// NOT inherit the context of whoever spawned it: an arena is a single-threaded
// bump pointer whose lifetime is its scope, so both sharing it and outliving
// it would be unsound.
void yoop_ctx_load_task(void** slot);

// Remember whatever the step left installed, so the resume picks it back up.
// Allocates the record on demand, and only when there is something to
// remember - a task that never installed an allocator keeps a NULL slot.
void yoop_ctx_store_task(void** slot);

// Drop the task's context. Called when the task finishes (nothing left to
// resume) and again when its handle is freed, so an abandoned task that
// suspended with a context installed does not leak the record.
void yoop_ctx_discard_task(void** slot);

// ---- arenas ----------------------------------------------------------------

void*  yoop_arena_new(size_t cap);
void*  yoop_arena_alloc(void* handle, size_t size, size_t align);
void   yoop_arena_reset(void* handle);
void   yoop_arena_destroy(void* handle);
size_t yoop_arena_used(void* handle);

// Scratch storage, scoped to the TASK while a task step is running and to the
// thread otherwise. A task's arena is created on first use and destroyed with
// the task; `reset` inside a task never touches the thread's, so a task cannot
// pull scratch out from under the caller that dispatched it.
void* yoop_temp_handle(void);
void  yoop_temp_reset(void);

#ifdef __cplusplus
}
#endif

#endif  // YOOP_ALLOC_H
