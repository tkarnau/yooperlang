// alloc / retain / release lifecycle, plus a pooled submit-wait-release.
#include "../yoop_runtime.h"
#include <assert.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

// Mirrors the handle prefix laid out by codegen - including the two
// runtime-owned slots this test never reads (see submit_one.c: the scheduler
// writes through both on every step, so leaving them out corrupts the heap).
struct fake_handle {
    void (*thunk)(void*);   // offset 0
    uint8_t state;          // offset 8
    char _pad[3];
    int32_t refcount;       // offset 12
    void* mutex;            // offset 16
    void* cond;             // offset 24
    void* coro;             // offset 32
    void* alloc_ctx;        // offset 40
    int32_t result;         // offset 48 (compiler-owned slot)
};

static void thunk(void* h) {
    struct fake_handle* fh = (struct fake_handle*)h;
    fh->result = 7;
    yoop_handle_signal_done(h);
}

int main(void) {
    _Static_assert(offsetof(struct fake_handle, coro)      == 32, "coro@32");
    _Static_assert(offsetof(struct fake_handle, alloc_ctx) == 40, "alloc_ctx@40");
    _Static_assert(offsetof(struct fake_handle, result)    == 48, "result@48");

    yoop_runtime_init();

    // Pure refcount mechanics without a submit. yoop_task_alloc seeds rc=2.
    void* h = yoop_task_alloc(sizeof(struct fake_handle));
    assert(((struct fake_handle*)h)->refcount == 2);
    yoop_task_retain(h);       // rc=3
    assert(((struct fake_handle*)h)->refcount == 3);
    yoop_task_release(h);      // rc=2
    yoop_task_release(h);      // rc=1
    yoop_task_release(h);      // rc=0 -> free

    // Pooled submit: alloc seeds rc=2; signal_done drops 1; caller drops 1.
    struct fake_handle* fh = (struct fake_handle*)yoop_task_alloc(sizeof(*fh));
    fh->thunk = thunk;
    yoop_task_submit(fh, thunk);
    yoop_task_wait(fh);
    assert(fh->result == 7);
    yoop_task_release(fh);     // last release -> frees sync pair + handle

    yoop_runtime_shutdown();
    printf("refcount: ok\n");
    return 0;
}
