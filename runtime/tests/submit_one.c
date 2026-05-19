// Submit one stack-allocated task; wait for it; verify state flipped to 1.
#include "../yoop_runtime.h"
#include <assert.h>
#include <stdint.h>
#include <string.h>

// Manually mirrors the handle prefix laid out by codegen.
struct fake_handle {
    void (*thunk)(void*);   // offset 0
    uint8_t state;          // offset 8
    char _pad[3];
    int32_t refcount;       // offset 12 (0 = stack-allocated)
    void* mutex;            // offset 16
    void* cond;             // offset 24
    int32_t result;         // offset 32 (compiler-owned slot)
};

static void thunk(void* h) {
    struct fake_handle* fh = (struct fake_handle*)h;
    fh->result = 42;
    yoop_handle_signal_done(h);
}

int main(void) {
    _Static_assert(offsetof(struct fake_handle, thunk)    == 0,  "thunk@0");
    _Static_assert(offsetof(struct fake_handle, state)    == 8,  "state@8");
    _Static_assert(offsetof(struct fake_handle, refcount) == 12, "refcount@12");
    _Static_assert(offsetof(struct fake_handle, mutex)    == 16, "mutex@16");
    _Static_assert(offsetof(struct fake_handle, cond)     == 24, "cond@24");
    _Static_assert(offsetof(struct fake_handle, result)   == 32, "result@32");

    yoop_runtime_init();

    struct fake_handle h;
    memset(&h, 0, sizeof(h));
    h.thunk = thunk;

    yoop_task_submit(&h, thunk);
    yoop_task_wait(&h);
    assert(h.state == 1);
    assert(h.result == 42);
    yoop_task_free_sync_pair(&h);

    yoop_runtime_shutdown();
    return 0;
}
