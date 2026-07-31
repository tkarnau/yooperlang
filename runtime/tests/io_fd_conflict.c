// Two waiters on the same (fd, direction).
//
// The 8.F.2 plan said a second concurrent registration should be
// rejected with EAGAIN. The implementation did not do that: epoll's
// EPOLL_CTL_MOD fallback and kqueue's EV_SET both overwrite the stored
// user pointer, so the SECOND waiter silently took ownership of the
// wakeup and the first parked forever with nothing left to wake it.
//
// This test pins the fixed behavior: the first waiter keeps the slot,
// the second is refused immediately, and the first still gets its data.

#include "../yoop_runtime.h"

#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define MS 1000000ULL

struct first_args {
    int fd;
    int rc;
};

static void* first_waiter(void* p) {
    struct first_args* a = (struct first_args*)p;
    // Generous deadline: this should be woken by real data, not by the
    // timer. If the second registration stole the wakeup, this times
    // out instead.
    a->rc = yoop_io_wait_readable_ex(a->fd, NULL, yoop_now_ns() + 4000 * MS);
    return NULL;
}

static void test_second_waiter_refused(void) {
    int fds[2];
    assert(pipe(fds) == 0);

    struct first_args a = { fds[0], -999 };
    pthread_t th;
    pthread_create(&th, NULL, first_waiter, &a);

    // Let the first waiter get parked and registered.
    yoop_sleep_ms(50);

    // Second registration on the same (fd, read) must be refused rather
    // than displacing the first.
    errno = 0;
    int rc2 = yoop_io_wait_readable_ex(fds[0], NULL, yoop_now_ns() + 100 * MS);
    assert(rc2 == -1);
    assert(errno == EAGAIN);

    // The first waiter is still armed and still gets its wakeup.
    assert(write(fds[1], "x", 1) == 1);
    pthread_join(th, NULL);
    assert(a.rc == YOOP_WAIT_READY);

    close(fds[0]);
    close(fds[1]);
    printf("  second-waiter-refused ok\n");
}

// Opposite directions on one fd are independent registrations and must
// both be allowed.
static void test_opposite_directions_coexist(void) {
    int fds[2];
    assert(pipe(fds) == 0);

    struct first_args a = { fds[0], -999 };
    pthread_t th;
    pthread_create(&th, NULL, first_waiter, &a);
    yoop_sleep_ms(50);

    // The read end is not writable, so this one just times out - the
    // point is that it registers at all instead of hitting EAGAIN.
    int rc = yoop_io_wait_writable_ex(fds[0], NULL, yoop_now_ns() + 60 * MS);
    assert(rc != -1);

    assert(write(fds[1], "x", 1) == 1);
    pthread_join(th, NULL);
    assert(a.rc == YOOP_WAIT_READY);

    close(fds[0]);
    close(fds[1]);
    printf("  opposite-directions-coexist ok\n");
}

// Once the first waiter finishes, the slot is free again.
static void test_slot_released(void) {
    int fds[2];
    assert(pipe(fds) == 0);

    assert(write(fds[1], "x", 1) == 1);
    assert(yoop_io_wait_readable_ex(fds[0], NULL, 0) == YOOP_WAIT_READY);

    char buf[2];
    assert(read(fds[0], buf, 1) == 1);

    // Slot must be reusable - this should time out, not EAGAIN.
    int rc = yoop_io_wait_readable_ex(fds[0], NULL, yoop_now_ns() + 30 * MS);
    assert(rc == YOOP_WAIT_TIMEDOUT);

    close(fds[0]);
    close(fds[1]);
    printf("  slot-released ok\n");
}

int main(void) {
    yoop_runtime_init();
    printf("[io_fd_conflict]\n");
    test_second_waiter_refused();
    test_opposite_directions_coexist();
    test_slot_released();
    yoop_runtime_shutdown();
    printf("io_fd_conflict: ok\n");
    return 0;
}
