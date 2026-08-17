// epoll event engine (Linux).
//
// One of three interchangeable implementations of the yoop_iob_* contract in
// yoop_io_internal.h; see that header for why the platforms are split rather
// than abstracted together. This file owns three things: the epoll descriptor,
// the self-pipe used to break the loop, and a small fd -> live-interests table.
//
// Like kqueue and unlike WSAPoll, epoll holds the interest set inside the
// kernel, so registering while the I/O thread is blocked in epoll_wait() takes
// effect against that call - nothing here nudges the loop except on shutdown.
//
// ---------------------------------------------------------------------------
// Why this backend keeps a table and kqueue does not
// ---------------------------------------------------------------------------
//
// The core allows two SIMULTANEOUS registrations on one descriptor - a reader
// and a writer - and only refuses a second waiter in the SAME direction
// (`reg_fd_taken_locked` in yoop_io.c keys on (fd, want_write)). kqueue models
// that natively: an EV_SET is keyed on (ident, filter), so EVFILT_READ and
// EVFILT_WRITE on one fd are two independent knotes, each with its own udata.
//
// epoll cannot express it. Its interest set is keyed on the DESCRIPTOR alone:
// one events mask and one 8-byte `data` per fd. So the two directions have to
// be folded into a single entry here, and `data` cannot be the registration's
// seq - there may be two live seqs and only one slot to put them in.
//
// Hence the table: `data.u64` carries the FD, and the seq for each direction is
// looked up in `ep_slots` on the way out. The seq scheme's guarantee is
// preserved, because a seq is cleared from its slot the moment it fires - a
// stale event finds nothing and is dropped, exactly as an unknown seq was.
//
// What this replaced was a straight `EPOLL_CTL_ADD`, falling back to
// `EPOLL_CTL_MOD` on EEXIST, with `data.u64 = reg->seq`. On one fd that is
// correct; on two directions it is not, and in two ways. The MOD overwrote the
// first direction's mask and seq outright, so the first waiter was disarmed and
// its wakeup was redirected to the second. Then the second's `EPOLL_CTL_DEL` on
// timeout removed the fd from the set entirely, so the first was left parked
// with nothing in the kernel that could ever wake it. runtime/tests/
// io_fd_conflict.c's `test_opposite_directions_coexist` is that bug.
//
// EPOLLONESHOT disarms the WHOLE entry - both directions - on any fire, which
// is why the loop re-applies the mask for whatever direction did NOT fire
// rather than assuming it is still armed.

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

// ----- fd -> live interests ------------------------------------------------
//
// One node per descriptor with at least one armed direction; a node exists
// exactly as long as the fd is in the epoll set, which is what lets
// ep_apply_locked tell ADD from MOD without asking the kernel.
//
// Guarded by yoop_io_mu, the core's table lock, rather than a private one. The
// IOCP backend's socket-association list does the same, and for the same
// reason: register/deregister are already called with it held (see the contract
// in yoop_io_internal.h), so a second lock would buy nothing and would have to
// be ordered against this one anyway.
//
// A seq of 0 means "no waiter in this direction" and can never collide with a
// real registration - yoop_io.c hands out seqs from 1.
typedef struct ep_slot {
    int             fd;
    uint64_t        read_seq;
    uint64_t        write_seq;
    struct ep_slot* next;
} ep_slot;

static ep_slot* ep_slots;

// All four helpers below require yoop_io_mu.

static ep_slot* slot_find_locked(int fd) {
    for (ep_slot* s = ep_slots; s; s = s->next) {
        if (s->fd == fd) return s;
    }
    return NULL;
}

static void slot_drop_locked(ep_slot* target) {
    ep_slot** link = &ep_slots;
    while (*link) {
        if (*link == target) { *link = target->next; free(target); return; }
        link = &(*link)->next;
    }
}

// Push the slot's current interests at the kernel, or remove the fd when it has
// none left. `is_new` distinguishes the first arm (ADD) from a re-arm (MOD).
//
// On the empty path the slot is FREED, so the caller must not touch it again.
// Returns 0, or -1 with errno set from epoll_ctl.
static int ep_apply_locked(ep_slot* s, int is_new) {
    if (s->read_seq == 0 && s->write_seq == 0) {
        // Failures are ignored deliberately: the fd may already be closed, in
        // which case the kernel dropped the entry for us.
        (void)epoll_ctl(ep_fd, EPOLL_CTL_DEL, s->fd, NULL);
        slot_drop_locked(s);
        return 0;
    }

    struct epoll_event ev;
    ev.events = EPOLLONESHOT;
    if (s->read_seq  != 0) ev.events |= EPOLLIN;
    if (s->write_seq != 0) ev.events |= EPOLLOUT;
    ev.data.u64 = (uint64_t)(unsigned)s->fd;

    // The ADD/MOD fallbacks are belt and braces. The slot's existence should
    // already answer which one applies, but a descriptor closed without going
    // through yoop_io_closing would leave the two views disagreeing, and
    // recovering costs one failed syscall against a hang.
    if (is_new) {
        if (epoll_ctl(ep_fd, EPOLL_CTL_ADD, s->fd, &ev) == 0) return 0;
        if (errno != EEXIST) return -1;
        return epoll_ctl(ep_fd, EPOLL_CTL_MOD, s->fd, &ev);
    }
    if (epoll_ctl(ep_fd, EPOLL_CTL_MOD, s->fd, &ev) == 0) return 0;
    if (errno != ENOENT) return -1;
    return epoll_ctl(ep_fd, EPOLL_CTL_ADD, s->fd, &ev);
}

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

    // Level-triggered and NOT one-shot: the wake pipe must stay armed for the
    // life of the loop. It is identified in the loop by its fd, like every
    // other entry, so it needs no sentinel value of its own.
    struct epoll_event ev;
    ev.events   = EPOLLIN;
    ev.data.u64 = (uint64_t)(unsigned)ep_wake_r;
    epoll_ctl(ep_fd, EPOLL_CTL_ADD, ep_wake_r, &ev);
    return 0;
}

void yoop_iob_teardown(void) {
    if (ep_fd >= 0)     { close(ep_fd);     ep_fd = -1; }
    if (ep_wake_r >= 0) { close(ep_wake_r); ep_wake_r = -1; }
    if (ep_wake_w >= 0) { close(ep_wake_w); ep_wake_w = -1; }

    // The I/O thread has already been joined (see the contract), so this runs
    // uncontended - but the runtime can be re-initialized after a shutdown, and
    // a slot surviving into the next cycle would name an fd from the last one.
    ep_slot* s = ep_slots;
    ep_slots = NULL;
    while (s) {
        ep_slot* next = s->next;
        free(s);
        s = next;
    }
}

void yoop_iob_wake(void) {
    if (ep_wake_w < 0) return;
    char b = 'x';
    (void)write(ep_wake_w, &b, 1);
}

// Arm one direction, joining whatever the other direction already has.
//
// The core has proved no other waiter owns this (fd, direction), so the only
// seq that can be displaced here is a stale one.
int yoop_iob_register(yoop_io_reg* reg) {
    ep_slot* s = slot_find_locked(reg->fd);
    const int is_new = (s == NULL);
    if (is_new) {
        s = (ep_slot*)calloc(1, sizeof(*s));
        if (!s) { errno = ENOMEM; return -1; }
        s->fd    = reg->fd;
        s->next  = ep_slots;
        ep_slots = s;
    }

    const uint64_t prev_read  = s->read_seq;
    const uint64_t prev_write = s->write_seq;
    if (reg->want_write) s->write_seq = reg->seq;
    else                 s->read_seq  = reg->seq;

    if (ep_apply_locked(s, is_new) < 0) {
        const int saved = errno;
        // Put the slot back the way it was so a failed arm leaves no trace. On
        // the is_new path that means dropping it, which also DELs the fd - the
        // ADD may have half-succeeded before a later MOD failed.
        s->read_seq  = prev_read;
        s->write_seq = prev_write;
        if (is_new) slot_drop_locked(s);
        else        (void)ep_apply_locked(s, 0);
        errno = saved;
        return -1;
    }
    return 0;
}

// Drop one direction's interest, leaving the other armed if it has one.
//
// Guarded on the seq matching: the registration being abandoned may already
// have fired and been cleared by the loop, and the slot may since have been
// re-armed by a DIFFERENT waiter whose interest must not be cancelled here.
void yoop_iob_deregister(yoop_io_reg* reg) {
    ep_slot* s = slot_find_locked(reg->fd);
    if (!s) return;
    if (reg->want_write) {
        if (s->write_seq != reg->seq) return;
        s->write_seq = 0;
    } else {
        if (s->read_seq != reg->seq) return;
        s->read_seq = 0;
    }
    (void)ep_apply_locked(s, 0);
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
            const int fd = (int)ev->data.u64;
            if (fd == ep_wake_r) {
                drain_wake();
                should_exit = yoop_iob_stopping();
                continue;
            }

            // EPOLLERR and EPOLLHUP arrive whether or not they were asked for,
            // and they are not specific to a direction - so they retire BOTH
            // waiters rather than only the one whose readiness bit is set.
            const int fatal = (ev->events & (EPOLLERR | EPOLLHUP)) != 0;

            // Claim the seqs under the table lock and re-arm whatever did not
            // fire, since EPOLLONESHOT disarmed the entry as a whole. Clearing
            // a seq here is what makes a duplicate or stale event a no-op.
            uint64_t read_seq = 0, write_seq = 0;
            yoop_mutex_lock(&yoop_io_mu);
            ep_slot* s = slot_find_locked(fd);
            if (s) {
                if (fatal || (ev->events & EPOLLIN)) {
                    read_seq = s->read_seq;
                    s->read_seq = 0;
                }
                if (fatal || (ev->events & EPOLLOUT)) {
                    write_seq = s->write_seq;
                    s->write_seq = 0;
                }
                ep_apply_locked(s, 0);  // frees the slot when nothing is left
            }
            yoop_mutex_unlock(&yoop_io_mu);

            // Outside the lock: getsockopt is a syscall, and yoop_iob_deliver
            // takes io_mu itself.
            const int err = fatal ? socket_error(fd, EIO) : 0;
            if (read_seq)  yoop_iob_deliver(read_seq,  err, 0, 0);
            if (write_seq) yoop_iob_deliver(write_seq, err, 0, 0);
        }
        if (should_exit) break;
    }
}

// Drop the fd's slot before the descriptor is closed.
//
// The other readiness engine (kqueue) genuinely holds nothing and leaves this
// empty; this one holds the two-direction table, so it has something to do.
// Closing the fd would make the kernel forget the epoll entry on its own, but
// not the slot - and a recycled fd number landing on a stale slot would be read
// as "already in the epoll set", so the next ADD would be skipped.
//
// Takes io_mu: unlike register/deregister this is called from the closing path
// (yoop_io_closing), which holds no lock.
void yoop_iob_forget(int fd) {
    yoop_mutex_lock(&yoop_io_mu);
    ep_slot* s = slot_find_locked(fd);
    if (s) {
        (void)epoll_ctl(ep_fd, EPOLL_CTL_DEL, fd, NULL);
        slot_drop_locked(s);
    }
    yoop_mutex_unlock(&yoop_io_mu);
}

#endif // YOOP_IO_EPOLL
