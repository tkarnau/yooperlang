// Cancelling a thread that is parked inside the I/O multiplexer.
//
// This is the case the runtime could not express at all before: a
// thread blocked in yoop_io_wait_readable on an fd that never becomes
// ready was unreachable. The token now unparks it.

#include "../yoop_runtime.h"
#include "test_support.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

#define MS 1000000ULL

struct waiter_args {
    int             fd;
    yoop_cancel_t*  ct;
    uint64_t        deadline_ns;
    int             rc;
};

static void waiter(void* p) {
    struct waiter_args* a = (struct waiter_args*)p;
    a->rc = yoop_io_wait_readable_ex(a->fd, a->ct, a->deadline_ns);
}

// Park on a silent pipe, cancel from another thread, expect CANCELLED
// promptly rather than a hang.
static void test_cancel_while_parked(void) {
    int fds[2];
    assert(test_pair(fds) == 0);
    yoop_cancel_t* ct = yoop_cancel_new();

    struct waiter_args a = { fds[0], ct, 0, -999 };
    test_thread_t th;
    test_thread_spawn(&th, waiter, &a);

    yoop_sleep_ms(40);
    uint64_t start = yoop_now_ns();
    yoop_cancel_request(ct);
    test_thread_join(&th);
    uint64_t wake = yoop_now_ns() - start;

    assert(a.rc == YOOP_WAIT_CANCELLED);
    assert(wake < 2000 * MS);

    yoop_cancel_release(ct);
    test_pair_close(fds[0]);
    test_pair_close(fds[1]);
    printf("  cancel-while-parked ok (woke in %llums)\n",
           (unsigned long long)(wake / MS));
}

// A token cancelled before the wait even starts short-circuits.
static void test_pre_cancelled(void) {
    int fds[2];
    assert(test_pair(fds) == 0);
    yoop_cancel_t* ct = yoop_cancel_new();
    yoop_cancel_request(ct);

    int rc = yoop_io_wait_readable_ex(fds[0], ct, 0);
    assert(rc == YOOP_WAIT_CANCELLED);

    yoop_cancel_release(ct);
    test_pair_close(fds[0]);
    test_pair_close(fds[1]);
    printf("  pre-cancelled ok\n");
}

// The token's own deadline reaches the I/O wait, so "this whole
// operation gets 50ms" needs no second deadline argument.
static void test_token_deadline_reaches_io(void) {
    int fds[2];
    assert(test_pair(fds) == 0);
    yoop_cancel_t* ct = yoop_cancel_new_deadline(yoop_now_ns() + 50 * MS);

    uint64_t start = yoop_now_ns();
    int rc = yoop_io_wait_readable_ex(fds[0], ct, 0);
    uint64_t elapsed = yoop_now_ns() - start;

    assert(rc == YOOP_WAIT_TIMEDOUT);
    assert(elapsed >= 45 * MS);
    assert(elapsed <  2000 * MS);

    yoop_cancel_release(ct);
    test_pair_close(fds[0]);
    test_pair_close(fds[1]);
    printf("  token-deadline-reaches-io ok\n");
}

// Cancelling a parent token releases a wait parked on its child.
static void test_parent_cancel_reaches_child_wait(void) {
    int fds[2];
    assert(test_pair(fds) == 0);
    yoop_cancel_t* parent = yoop_cancel_new();
    yoop_cancel_t* child  = yoop_cancel_new();
    assert(yoop_cancel_link(child, parent) == 0);

    struct waiter_args a = { fds[0], child, 0, -999 };
    test_thread_t th;
    test_thread_spawn(&th, waiter, &a);

    yoop_sleep_ms(40);
    yoop_cancel_request(parent);
    test_thread_join(&th);
    assert(a.rc == YOOP_WAIT_CANCELLED);

    yoop_cancel_release(child);
    yoop_cancel_release(parent);
    test_pair_close(fds[0]);
    test_pair_close(fds[1]);
    printf("  parent-cancel-reaches-child-wait ok\n");
}

// Readiness beats a cancellation that arrives afterwards: once the
// multiplexer has fired, the wait reports READY.
static void test_ready_wins_over_late_cancel(void) {
    int fds[2];
    assert(test_pair(fds) == 0);
    yoop_cancel_t* ct = yoop_cancel_new();

    assert(test_pair_write(fds[1], "x", 1) == 1);
    int rc = yoop_io_wait_readable_ex(fds[0], ct, yoop_now_ns() + 1000 * MS);
    assert(rc == YOOP_WAIT_READY);
    yoop_cancel_request(ct);

    yoop_cancel_release(ct);
    test_pair_close(fds[0]);
    test_pair_close(fds[1]);
    printf("  ready-wins-over-late-cancel ok\n");
}

// Hammer the abandon handshake: repeatedly park and cancel so the
// timeout/cancel teardown races the multiplexer's delivery. Any
// mistake in the fired-under-io_mu protocol shows up here as a crash
// or a hang rather than a wrong return code.
static void test_cancel_storm(void) {
    for (int i = 0; i < 200; i++) {
        int fds[2];
        assert(test_pair(fds) == 0);
        yoop_cancel_t* ct = yoop_cancel_new();

        struct waiter_args a = { fds[0], ct, yoop_now_ns() + 5 * MS, -999 };
        test_thread_t th;
        test_thread_spawn(&th, waiter, &a);

        // Race the deadline with a cancel and, every third round, with
        // actual data arriving too.
        if (i % 3 == 0) { int64_t n = test_pair_write(fds[1], "x", 1); (void)n; }
        yoop_cancel_request(ct);
        test_thread_join(&th);

        assert(a.rc == YOOP_WAIT_READY ||
               a.rc == YOOP_WAIT_TIMEDOUT ||
               a.rc == YOOP_WAIT_CANCELLED);

        yoop_cancel_release(ct);
        test_pair_close(fds[0]);
        test_pair_close(fds[1]);
    }
    printf("  cancel-storm ok (200 rounds)\n");
}

int main(void) {
    yoop_runtime_init();
    printf("[io_cancel]\n");
    test_cancel_while_parked();
    test_pre_cancelled();
    test_token_deadline_reaches_io();
    test_parent_cancel_reaches_child_wait();
    test_ready_wins_over_late_cancel();
    test_cancel_storm();
    yoop_runtime_shutdown();
    printf("io_cancel: ok\n");
    return 0;
}
