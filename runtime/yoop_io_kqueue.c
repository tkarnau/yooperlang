// kqueue event engine (macOS, FreeBSD, OpenBSD, NetBSD).
//
// One of three interchangeable implementations of the yoop_iob_* contract in
// yoop_io_internal.h; see that header for why the platforms are split rather
// than abstracted together. This file owns exactly two things: the kqueue
// descriptor and the self-pipe used to break the loop. Everything else - the
// registration table, the seq identity scheme, the fired-under-io_mu abandon
// handshake - belongs to the core in yoop_io.c.
//
// kqueue holds the interest set inside the kernel, so registering while the
// I/O thread is blocked in kevent() takes effect against that call. That is
// why nothing here has to nudge the loop on a register - only on shutdown.

#include "yoop_io_internal.h"

#ifdef YOOP_IO_KQUEUE

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/time.h>
#include <unistd.h>

static int kq_fd        = -1;
static int kq_wake_r    = -1;  // read end of the self-pipe
static int kq_wake_w    = -1;  // write end

int yoop_iob_init(void) {
    kq_fd = kqueue();
    if (kq_fd < 0) return -1;

    int fds[2];
    if (yoop_socketpair(fds) != 0) {
        close(kq_fd);
        kq_fd = -1;
        return -1;
    }
    kq_wake_r = fds[0];
    kq_wake_w = fds[1];
    // Non-blocking so draining never stalls the loop.
    yoop_io_set_nonblocking(kq_wake_r);

    // seq 0 is the reserved wakeup sentinel; a NULL udata reads back as 0.
    struct kevent ev;
    EV_SET(&ev, kq_wake_r, EVFILT_READ, EV_ADD, 0, 0, NULL);
    kevent(kq_fd, &ev, 1, NULL, 0, NULL);
    return 0;
}

void yoop_iob_teardown(void) {
    if (kq_fd >= 0)     { close(kq_fd);     kq_fd = -1; }
    if (kq_wake_r >= 0) { close(kq_wake_r); kq_wake_r = -1; }
    if (kq_wake_w >= 0) { close(kq_wake_w); kq_wake_w = -1; }
}

void yoop_iob_wake(void) {
    if (kq_wake_w < 0) return;
    char b = 'x';
    (void)write(kq_wake_w, &b, 1);
}

int yoop_iob_register(yoop_io_reg* reg) {
    struct kevent ev;
    int filter = reg->want_write ? EVFILT_WRITE : EVFILT_READ;
    EV_SET(&ev, reg->fd, filter, EV_ADD | EV_ONESHOT, 0, 0,
           (void*)(uintptr_t)reg->seq);
    return kevent(kq_fd, &ev, 1, NULL, 0, NULL) < 0 ? -1 : 0;
}

void yoop_iob_deregister(yoop_io_reg* reg) {
    struct kevent ev;
    EV_SET(&ev, reg->fd, reg->want_write ? EVFILT_WRITE : EVFILT_READ,
           EV_DELETE, 0, 0, NULL);
    (void)kevent(kq_fd, &ev, 1, NULL, 0, NULL);
}

static void drain_wake(void) {
    char buf[64];
    while (read(kq_wake_r, buf, sizeof(buf)) > 0) { /* keep going */ }
}

void yoop_iob_loop(void) {
    struct kevent events[64];
    for (;;) {
        int n = kevent(kq_fd, NULL, 0, events, 64, NULL);
        if (n < 0) {
            if (errno == EINTR) continue;
            break;  // fatal; the runtime is going down
        }
        int should_exit = 0;
        for (int i = 0; i < n; i++) {
            struct kevent* ev = &events[i];
            uint64_t seq = (uint64_t)(uintptr_t)ev->udata;
            if (seq == 0 && (int)ev->ident == kq_wake_r) {
                drain_wake();
                should_exit = yoop_iob_stopping();
                continue;
            }
            if (seq == 0) continue;
            // EV_ERROR carries the errno directly in ev->data, so unlike
            // epoll there is no SO_ERROR round trip to make here.
            yoop_iob_deliver(seq, (ev->flags & EV_ERROR) ? (int)ev->data : 0,
                             0, 0);
        }
        if (should_exit) break;
    }
}

// Readiness engines hold no per-socket state, so there is nothing to drop.
void yoop_iob_forget(int fd) { (void)fd; }

#endif // YOOP_IO_KQUEUE
