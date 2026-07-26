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
//   2. A bump-pointer arena (new/alloc/reset/destroy). free of an individual
//      block is a no-op by design - the whole region reclaims on reset/destroy.

#include <stdlib.h>
#include <stddef.h>
#include <string.h>

// ---- per-thread current-allocator slot -----------------------------------

// Mirrors the yoop `Allocator` struct field-for-field (the ABI). get/set treat
// it opaquely (copy the bytes); yoop_ctx_alloc / yoop_ctx_free interpret the
// fn-pointer + data fields to dispatch a typed allocation through whatever is
// current. The fn pointers stored here are yoop functions (cAlloc / cFree /
// arenaAllocFn / ...), which have a C-compatible ABI, so C can call them.
typedef struct {
  void* alloc;    // void* (*)(void* data, size_t size, size_t align)
  void* realloc;  // unused by the dispatchers below
  void* free;     // void  (*)(void* data, void* ptr)
  void* data;
} YoopAllocator;

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

// ---- per-thread temporary-storage arena -----------------------------------
// A scratch arena per thread for short-lived allocations you never free
// individually. Created on first use; reset (not destroyed) at the boundary
// (frame end, request end) via yoop_temp_reset.

#define YOOP_TEMP_CAP (1024 * 64)

static _Thread_local void* yoop_temp = NULL;

void* yoop_temp_handle(void) {
  if (!yoop_temp) yoop_temp = yoop_arena_new(YOOP_TEMP_CAP);
  return yoop_temp;
}

void yoop_temp_reset(void) {
  if (yoop_temp) yoop_arena_reset(yoop_temp);
}
