// I/O waits with a deadline. The pre-existing wait_readable had no way
// to give up: a pipe that never gets written parked the thread forever.

#include "../yoop_runtime.h"
#include "test_support.h"

#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>

#define MS 1000000ULL

// A pipe nobody writes to. The wait must come back on its deadline.
static void test_timeout(void) {
    int fds[2];
    assert(test_pair(fds) == 0);

    uint64_t start = yoop_now_ns();
    int rc = yoop_io_wait_readable_ex(fds[0], NULL, yoop_now_ns() + 50 * MS);
    uint64_t elapsed = yoop_now_ns() - start;

    assert(rc == YOOP_WAIT_TIMEDOUT);
    assert(elapsed >= 45 * MS);
    assert(elapsed <  2000 * MS);

    test_pair_close(fds[0]);
    test_pair_close(fds[1]);
    printf("  timeout ok (%llums)\n", (unsigned long long)(elapsed / MS));
}

// After a timeout the registration must be fully torn down, so the very
// next wait on the same fd works. If the abandon path left a stale
// entry behind, this would fail with EAGAIN.
static void test_reuse_after_timeout(void) {
    int fds[2];
    assert(test_pair(fds) == 0);

    int rc = yoop_io_wait_readable_ex(fds[0], NULL, yoop_now_ns() + 30 * MS);
    assert(rc == YOOP_WAIT_TIMEDOUT);

    assert(test_pair_write(fds[1], "x", 1) == 1);
    rc = yoop_io_wait_readable_ex(fds[0], NULL, yoop_now_ns() + 1000 * MS);
    assert(rc == YOOP_WAIT_READY);

    test_pair_close(fds[0]);
    test_pair_close(fds[1]);
    printf("  reuse-after-timeout ok\n");
}

struct writer_args { int fd; uint64_t delay_ms; };

static void writer(void* p) {
    struct writer_args* a = (struct writer_args*)p;
    yoop_sleep_ms(a->delay_ms);
    int64_t n = test_pair_write(a->fd, "x", 1);
    (void)n;
}

// Data arrives comfortably inside the deadline: READY, not TIMEDOUT.
static void test_ready_before_deadline(void) {
    int fds[2];
    assert(test_pair(fds) == 0);

    struct writer_args a = { fds[1], 20 };
    test_thread_t th;
    test_thread_spawn(&th, writer, &a);

    int rc = yoop_io_wait_readable_ex(fds[0], NULL, yoop_now_ns() + 3000 * MS);
    test_thread_join(&th);
    assert(rc == YOOP_WAIT_READY);

    char buf[2];
    assert(test_pair_read(fds[0], buf, 1) == 1);

    test_pair_close(fds[0]);
    test_pair_close(fds[1]);
    printf("  ready-before-deadline ok\n");
}

// A deadline already in the past short-circuits without touching the
// kernel at all.
static void test_past_deadline(void) {
    int fds[2];
    assert(test_pair(fds) == 0);
    int rc = yoop_io_wait_readable_ex(fds[0], NULL, 1);
    assert(rc == YOOP_WAIT_TIMEDOUT);
    test_pair_close(fds[0]);
    test_pair_close(fds[1]);
    printf("  past-deadline ok\n");
}

// A pipe's write end is immediately writable, so this returns READY
// with no deadline pressure - the writable path is otherwise identical.
static void test_writable(void) {
    int fds[2];
    assert(test_pair(fds) == 0);
    int rc = yoop_io_wait_writable_ex(fds[1], NULL, yoop_now_ns() + 1000 * MS);
    assert(rc == YOOP_WAIT_READY);
    test_pair_close(fds[0]);
    test_pair_close(fds[1]);
    printf("  writable ok\n");
}

int main(void) {
    yoop_runtime_init();
    printf("[io_deadline]\n");
    test_timeout();
    test_reuse_after_timeout();
    test_ready_before_deadline();
    test_past_deadline();
    test_writable();
    yoop_runtime_shutdown();
    printf("io_deadline: ok\n");
    return 0;
}
