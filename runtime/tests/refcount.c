// alloc / retain / release lifecycle, plus a pooled submit-wait-release.
#include "../yoop_runtime.h"
#include <assert.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>

struct fake_handle {
    void (*thunk)(void*);
    uint8_t state;
    char _pad[3];
    int32_t refcount;
    void* mutex;
    void* cond;
    int32_t result;
};

static void thunk(void* h) {
    struct fake_handle* fh = (struct fake_handle*)h;
    fh->result = 7;
    yoop_handle_signal_done(h);
}

int main(void) {
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
