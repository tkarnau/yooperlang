// epoll event engine (Linux).
//
// One of three interchangeable implementations of the yoop_iob_* contract in
// yoop_io_internal.h; see that header for why the platforms are split rather
// than abstracted together. This file owns exactly two things: the epoll
// descriptor and the self-pipe used to break the loop.
//
// Like kqueue and unlike WSAPoll, epoll holds the interest set inside the
// kernel, so registering while the I/O thread is blocked in epoll_wait() takes
// effect against that call - nothing here nudges the loop except on shutdown.

#include "yoop_io_internal.h"

#ifdef YOOP_IO_EPOLL

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <unistd.h>

static int ep_fd     = -1;
static int ep_wake_r = -1;  // read end of the self-pipe
static int ep_wake_w = -1;  // write end

int yoop_iob_init(void) {
    ep_fd = epoll_create1(EPOLL_CLOEXEC);
    if (ep_fd < 0) return -1;

    int fds[2];
    if (yoop_socketpair(fds) != 0) {
        close(ep_fd);
        ep_fd = -1;
        return -1;
    }
    ep_wake_r = fds[0];
    ep_wake_w = fds[1];
    yoop_io_set_nonblocking(ep_wake_r);

    struct epoll_event ev;
    ev.events   = EPOLLIN;
    ev.data.u64 = 0;  // reserved wakeup sentinel
    epoll_ctl(ep_fd, EPOLL_CTL_ADD, ep_wake_r, &ev);
    return 0;
}

void yoop_iob_teardown(void) {
    if (ep_fd >= 0)     { close(ep_fd);     ep_fd = -1; }
    if (ep_wake_r >= 0) { close(ep_wake_r); ep_wake_r = -1; }
    if (ep_wake_w >= 0) { close(ep_wake_w); ep_wake_w = -1; }
}

void yoop_iob_wake(void) {
    if (ep_wake_w < 0) return;
    char b = 'x';
    (void)write(ep_wake_w, &b, 1);
}

int yoop_iob_register(yoop_io_reg* reg) {
    struct epoll_event ev;
    ev.events   = (unsigned)(reg->want_write ? EPOLLOUT : EPOLLIN) | EPOLLONESHOT;
    ev.data.u64 = reg->seq;
    if (epoll_ctl(ep_fd, EPOLL_CTL_ADD, reg->fd, &ev) == 0) return 0;
    // A stale disarmed registration from an earlier wait on this fd can
    // linger; MOD re-arms it. This is safe here in a way it was NOT before,
    // because the core already proved no OTHER waiter currently owns this
    // (fd, direction) - which is precisely the case where MOD used to silently
    // steal the first waiter's wakeup.
    if (errno == EEXIST) {
        return epoll_ctl(ep_fd, EPOLL_CTL_MOD, reg->fd, &ev) < 0 ? -1 : 0;
    }
    return -1;
}

void yoop_iob_deregister(yoop_io_reg* reg) {
    (void)epoll_ctl(ep_fd, EPOLL_CTL_DEL, reg->fd, NULL);
}

static void drain_wake(void) {
    char buf[64];
    while (read(ep_wake_r, buf, sizeof(buf)) > 0) { /* keep going */ }
}

// Pull the real error off a socket that reported EPOLLERR/EPOLLHUP. epoll only
// says "something went wrong"; SO_ERROR is where the actual code lives.
// Reporting a blanket EIO turns every connection refused / reset into the same
// uninformative message.
static int socket_error(int fd, int fallback) {
    int err = 0;
    socklen_t len = sizeof(err);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) == 0 && err != 0) {
        return err;
    }
    return fallback;
}

void yoop_iob_loop(void) {
    struct epoll_event events[64];
    for (;;) {
        int n = epoll_wait(ep_fd, events, 64, -1);
        if (n < 0) {
            if (errno == EINTR) continue;
            break;
        }
        int should_exit = 0;
        for (int i = 0; i < n; i++) {
            struct epoll_event* ev = &events[i];
            uint64_t seq = ev->data.u64;
            if (seq == 0) {
                drain_wake();
                should_exit = yoop_iob_stopping();
                continue;
            }
            int err = 0;
            if (ev->events & (EPOLLERR | EPOLLHUP)) {
                // epoll's payload carries the seq, not the fd, so the fd has
                // to come back out of the table before SO_ERROR can be read.
                int fd = yoop_iob_fd_for_seq(seq);
                err = (fd >= 0) ? socket_error(fd, EIO) : EIO;
            }
            yoop_iob_deliver(seq, err, 0, 0);
        }
        if (should_exit) break;
    }
}

// Readiness engines hold no per-socket state, so there is nothing to drop.
void yoop_iob_forget(int fd) { (void)fd; }

#endif // YOOP_IO_EPOLL
