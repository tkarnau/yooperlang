// Submit N tasks; wait each; exercise queue contention.
#include "../yoop_runtime.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define N 1000

struct fake_handle {
    void (*thunk)(void*);
    uint8_t state;
    char _pad[3];
    int32_t refcount;
    void* mutex;
    void* cond;
    int32_t id;
    int32_t result;
};

static void thunk(void* h) {
    struct fake_handle* fh = (struct fake_handle*)h;
    fh->result = fh->id * 2;
    yoop_handle_signal_done(h);
}

int main(void) {
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
