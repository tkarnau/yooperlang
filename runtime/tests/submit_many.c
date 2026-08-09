// Submit N tasks; wait each; exercise queue contention.
#include "../yoop_runtime.h"
#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define N 1000

// Mirrors the handle prefix laid out by codegen - including the two
// runtime-owned slots this test never reads (see submit_one.c: the scheduler
// writes through both on every step, so leaving them out corrupts the stack).
struct fake_handle {
    void (*thunk)(void*);   // offset 0
    uint8_t state;          // offset 8
    char _pad[3];
    int32_t refcount;       // offset 12
    void* mutex;            // offset 16
    void* cond;             // offset 24
    void* coro;             // offset 32
    void* alloc_ctx;        // offset 40
    int32_t result;         // offset 48 (compiler-owned: result, then args)
    int32_t id;             // offset 52
};

static void thunk(void* h) {
    struct fake_handle* fh = (struct fake_handle*)h;
    fh->result = fh->id * 2;
    yoop_handle_signal_done(h);
}

int main(void) {
    _Static_assert(offsetof(struct fake_handle, coro)      == 32, "coro@32");
    _Static_assert(offsetof(struct fake_handle, alloc_ctx) == 40, "alloc_ctx@40");
    _Static_assert(offsetof(struct fake_handle, result)    == 48, "result@48");

    yoop_runtime_init();

    struct fake_handle* handles = (struct fake_handle*)calloc(N, sizeof(*handles));
    for (int i = 0; i < N; i++) {
        handles[i].thunk = thunk;
        handles[i].id = i;
        yoop_task_submit(&handles[i], thunk);
    }
    for (int i = 0; i < N; i++) {
        yoop_task_wait(&handles[i]);
        assert(handles[i].state == 1);
        assert(handles[i].result == i * 2);
        yoop_task_free_sync_pair(&handles[i]);
    }
    free(handles);

    yoop_runtime_shutdown();
    printf("submit_many: %d tasks ok\n", N);
    return 0;
}
