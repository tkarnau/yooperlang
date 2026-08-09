// yoop_alloc.c - backing runtime for std/core/alloc.yoop.
//
// Two pieces:
//   1. A per-thread "current allocator" slot. The Allocator VALUE is a yoop
//      struct (4 pointers: alloc, realloc, free, data). We hold a per-thread
//      copy of whichever one is current. Yoop installs it via
//      yoop_set_allocator (memcpy in) and reads it via yoop_get_allocator,
//      which returns a pointer to the per-thread buffer, or NULL before the
//      first install so the yoop side can lazily install the malloc allocator.
//      push/pop is handled yoop-side: pushAllocator reads the current value
//      (a copy), overwrites the slot, and returns the copy so popAllocator can
//      restore it. C only ever holds ONE current; the stack of previous
//      allocators lives in yoop locals.
//
//      That split is what makes the per-task context (part 3) cheap: a scope
//      opened inside a coroutine keeps its `prev` in the coroutine frame,
//      which migrates with the task for free, so only the single current-top
//      slot ever needs moving.
//   2. A bump-pointer arena (new/alloc/reset/destroy). free of an individual
//      block is a no-op by design - the whole region reclaims on reset/destroy.
//   3. The per-task context: the save/load/store the scheduler uses to make
//      the ambient allocator follow a coroutine across suspends instead of
//      staying behind on whichever worker happened to run the last step.
//      See plans/async-allocator-context.md.

#include "yoop_alloc.h"

#include <stdlib.h>
#include <stddef.h>
#include <string.h>

// ---- per-thread current-allocator slot -----------------------------------

// get/set treat the current allocator opaquely (copy the bytes);
// yoop_ctx_alloc / yoop_ctx_free interpret the fn-pointer + data fields to
// dispatch a typed allocation through whatever is current. YoopAllocator
// itself is declared in yoop_alloc.h - the scheduler needs the layout too,
// to hold a saved copy on its stack across a step.

static _Thread_local YoopAllocator yoop_cur_alloc;
static _Thread_local int yoop_cur_alloc_set = 0;

void* yoop_get_allocator(void) {
  return yoop_cur_alloc_set ? (void*)&yoop_cur_alloc : NULL;
}

void yoop_set_allocator(void* src) {
  memcpy(&yoop_cur_alloc, src, sizeof(YoopAllocator));
  yoop_cur_alloc_set = 1;
}

typedef void* (*yoop_alloc_fn)(void*, size_t, size_t);
typedef void  (*yoop_free_fn)(void*, void*);

// Dispatch a `size`-byte allocation through the current allocator (default
// malloc before anything is installed). Backs the `ctx_alloc<T>` intrinsic.
void* yoop_ctx_alloc(size_t size, size_t align) {
  if (!yoop_cur_alloc_set) return malloc(size);
  yoop_alloc_fn f = (yoop_alloc_fn)yoop_cur_alloc.alloc;
  return f(yoop_cur_alloc.data, size, align);
}

// Free through the current allocator (default malloc). Backs `ctx_free<T>`.
// For container-owned correctness, callers install the owning allocator (push)
// before freeing, so this frees with the allocator that allocated the block.
void yoop_ctx_free(void* ptr) {
  if (!yoop_cur_alloc_set) { free(ptr); return; }
  yoop_free_fn f = (yoop_free_fn)yoop_cur_alloc.free;
  f(yoop_cur_alloc.data, ptr);
}

// ---- per-task allocator context -------------------------------------------
//
// The record hangs off the task handle's context slot. It is allocated lazily -
// on the SUSPEND path (run_task_step discards rather than stores when the step
// finished the task) or on the first temp-arena use inside the task - so a task
// that neither suspends nor touches temp storage never allocates one, no matter
// how much it allocated through the context.
//
// `temp` is the task's scratch arena. It rides here rather than in a
// _Thread_local for the same reason the current allocator does: two tasks
// interleaving on one worker would otherwise share a scratch region, and either
// one's yoop_temp_reset would pull the rug from under the other.

typedef struct {
  YoopAllocator alloc;
  int           set;
  void*         temp;   // this task's scratch arena, or NULL until first use
} YoopTaskCtx;

// The context slot of the task currently being stepped on this thread, or NULL
// outside a task step. This is what lets yoop_temp_handle find the task's
// record without knowing the handle layout, which stays in yoop_runtime.c.
//
// It rides YoopCtxSave rather than being restored by hand because run_task_step
// NESTS: yoop_task_wait drains the queue re-entrantly on the calling thread, so
// a task step can happen inside another task's step.
static _Thread_local void** yoop_cur_task_slot = NULL;

void yoop_ctx_save(YoopCtxSave* out) {
  out->alloc     = yoop_cur_alloc;
  out->set       = yoop_cur_alloc_set;
  out->task_slot = yoop_cur_task_slot;
}

void yoop_ctx_restore(const YoopCtxSave* saved) {
  yoop_cur_alloc     = saved->alloc;
  yoop_cur_alloc_set = saved->set;
  yoop_cur_task_slot = saved->task_slot;
}

void yoop_ctx_load_task(void** slot) {
  yoop_cur_task_slot = slot;
  const YoopTaskCtx* ctx = (const YoopTaskCtx*)*slot;
  if (ctx) {
    yoop_cur_alloc     = ctx->alloc;
    yoop_cur_alloc_set = ctx->set;
    return;
  }
  // No saved context: start from the default rather than from whatever this
  // worker happened to be holding. That is the whole point - the worker may
  // be mid-way through some OTHER task's arena scope, and handing this task
  // that arena is how allocations end up in a region that is about to be
  // destroyed by an unrelated piece of code.
  memset(&yoop_cur_alloc, 0, sizeof(yoop_cur_alloc));
  yoop_cur_alloc_set = 0;
}

// Get (or create) the record for the task currently being stepped. Returns
// NULL outside a task step, or if the allocation fails - both of which mean
// "fall back to the per-thread behavior".
static YoopTaskCtx* task_ctx_ensure(void) {
  if (!yoop_cur_task_slot) return NULL;
  YoopTaskCtx* ctx = (YoopTaskCtx*)*yoop_cur_task_slot;
  if (!ctx) {
    ctx = (YoopTaskCtx*)calloc(1, sizeof(YoopTaskCtx));
    if (!ctx) return NULL;
    *yoop_cur_task_slot = ctx;
  }
  return ctx;
}

void yoop_ctx_store_task(void** slot) {
  YoopTaskCtx* ctx = (YoopTaskCtx*)*slot;
  if (!ctx) {
    // Nothing installed and nothing remembered: the resume can start from
    // the default again, so there is nothing worth allocating a record for.
    if (!yoop_cur_alloc_set) return;
    ctx = (YoopTaskCtx*)calloc(1, sizeof(YoopTaskCtx));
    // On OOM the task resumes with the default context. Worse than correct,
    // but strictly better than resuming with another task's arena, which is
    // what leaving the thread's slot alone would do.
    if (!ctx) return;
    *slot = ctx;
  }
  ctx->alloc = yoop_cur_alloc;
  ctx->set   = yoop_cur_alloc_set;
}

void yoop_ctx_discard_task(void** slot) {
  YoopTaskCtx* ctx = (YoopTaskCtx*)*slot;
  if (!ctx) return;
  *slot = NULL;
  // The task is done, so its scratch is dead with it. Destroyed rather than
  // pooled for reuse: nothing in std allocates from temp today, so a free list
  // would be speculative. If temp ever becomes hot on a per-connection task,
  // that is the change to make - a task that uses it currently costs one
  // YOOP_TEMP_CAP malloc/free per task.
  if (ctx->temp) yoop_arena_destroy(ctx->temp);
  free(ctx);
}

// ---- bump arena -----------------------------------------------------------

typedef struct {
  unsigned char* base;
  size_t cap;
  size_t offset;
} YoopArena;

void* yoop_arena_new(size_t cap) {
  YoopArena* ar = (YoopArena*)malloc(sizeof(YoopArena));
  if (!ar) return NULL;
  ar->base = (unsigned char*)malloc(cap ? cap : 1);
  if (!ar->base) { free(ar); return NULL; }
  ar->cap = cap;
  ar->offset = 0;
  return ar;
}

static size_t yoop_align_up(size_t n, size_t align) {
  if (align == 0) align = 1;
  return (n + (align - 1)) & ~(align - 1);
}

// Bump the cursor, honoring alignment. Returns NULL on overflow (v1 has no
// region growth; an out-of-space alloc fails rather than mallocing behind the
// caller's back).
void* yoop_arena_alloc(void* handle, size_t size, size_t align) {
  YoopArena* ar = (YoopArena*)handle;
  if (!ar) return NULL;
  size_t start = yoop_align_up(ar->offset, align);
  if (start + size > ar->cap) return NULL;
  void* p = ar->base + start;
  ar->offset = start + size;
  return p;
}

void yoop_arena_reset(void* handle) {
  YoopArena* ar = (YoopArena*)handle;
  if (ar) ar->offset = 0;
}

void yoop_arena_destroy(void* handle) {
  YoopArena* ar = (YoopArena*)handle;
  if (!ar) return;
  free(ar->base);
  free(ar);
}

// Bytes currently handed out (for tests / introspection).
size_t yoop_arena_used(void* handle) {
  YoopArena* ar = (YoopArena*)handle;
  return ar ? ar->offset : 0;
}

// ---- temporary-storage arena ----------------------------------------------
// A scratch arena for short-lived allocations you never free individually.
// Created on first use; reset (not destroyed) at the boundary (frame end,
// request end) via yoop_temp_reset.
//
// Scoped to the TASK while a task step is running, and to the thread
// otherwise. Per-thread alone was wrong in both directions once tasks could
// suspend: allocations made before an await could be reset by an unrelated
// task sharing the worker, and a reset after a resume would clear a different
// thread's arena than the one that served the allocations. Same rule, and the
// same reasoning, as the ambient allocator above.

#define YOOP_TEMP_CAP (1024 * 64)

static _Thread_local void* yoop_temp = NULL;

void* yoop_temp_handle(void) {
  YoopTaskCtx* ctx = task_ctx_ensure();
  if (ctx) {
    if (!ctx->temp) ctx->temp = yoop_arena_new(YOOP_TEMP_CAP);
    if (ctx->temp) return ctx->temp;
    // Arena allocation failed; fall through to the thread's, which is worse
    // than isolated but better than handing back NULL.
  }
  if (!yoop_temp) yoop_temp = yoop_arena_new(YOOP_TEMP_CAP);
  return yoop_temp;
}

void yoop_temp_reset(void) {
  if (yoop_cur_task_slot) {
    // Inside a task, only ever touch the task's OWN scratch, and no-op when it
    // has none. Falling back to the thread's arena here would reset storage
    // belonging to whoever is beneath us on this thread - the caller that
    // dispatched us re-entrantly, or an unrelated task that shared the worker -
    // which is precisely the contamination this change exists to remove.
    //
    // Deliberately does not create a record: nothing was allocated from a temp
    // arena that does not exist, so there is nothing to reset.
    YoopTaskCtx* ctx = (YoopTaskCtx*)*yoop_cur_task_slot;
    if (ctx && ctx->temp) yoop_arena_reset(ctx->temp);
    return;
  }
  if (yoop_temp) yoop_arena_reset(yoop_temp);
}
