// Phase 8.F.2 - I/O multiplexer for the Yooperlang runtime.
//
// One dedicated pthread (the "I/O thread") runs a kqueue (macOS) or
// epoll (Linux) loop. yoop_io_wait_readable / wait_writable register a
// one-shot interest for the given fd, park the calling thread on a
// park token (Phase 8.F.1 primitive), and the I/O thread unparks them
// when the fd becomes ready. See plans/phase-8-f-2-multiplexer.md.
//
// IOCP / Windows backend is not implemented; the public API would still
// work, but the body returns ENOSYS for now.

#include "yoop_runtime.h"
#include "yoop_platform.h"

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#ifndef _WIN32
#include <sys/socket.h>
#endif

#ifndef _WIN32
#include <grp.h>
#include <pwd.h>
#endif

// Create a single directory with standard 0755 permissions. The mode bits
// are computed from the POSIX S_* symbols (the headers resolve them to the
// right per-platform mode_t value), so yoop callers never hand-mirror a
// numeric mode - the same philosophy as the yoop_net.c constant helpers.
// Returns mkdir()'s rc: 0 on success, -1 with errno set. EEXIST is left for
// the caller to interpret (std/fs.mkdir_p treats it as benign).
int yoop_io_mkdir(const char* path) {
#ifdef _WIN32
    // Windows mkdir takes no mode argument.
    return _mkdir(path);
#else
    return mkdir(path, S_IRWXU | S_IRGRP | S_IXGRP | S_IROTH | S_IXOTH);
#endif
}

// 1 if `path` names an existing filesystem entry (of any type), 0 otherwise.
// A 0 result also covers "stat failed" (e.g. a missing parent component).
int yoop_io_exists(const char* path) {
    struct stat st;
    return stat(path, &st) == 0 ? 1 : 0;
}

// Canonicalize `path` to an absolute, symlink-resolved path. On success
// writes a freshly malloc'd nul-terminated string into *out (caller owns it)
// and returns 0; on failure returns -1 with errno set and leaves *out alone.
// Passing NULL as realpath's resolved_path makes libc allocate a PATH_MAX-safe
// buffer for us - NEVER hand realpath a fixed/foreign buffer, it overruns it.
// Note: realpath requires `path` to exist and always yields an ABSOLUTE path.
int yoop_io_normalize_real_path(const char* path, char** out) {
    char* resolved = realpath(path, NULL);
    if (!resolved) return -1;
    *out = resolved;
    return 0;
}

// Size in bytes of the regular file at `path`, or -1 if it doesn't exist,
// isn't a regular file, or stat() otherwise fails. Returning -1 (rather than
// a fallible struct) keeps the yoop side a single int64 read; callers test
// `< 0`.
int64_t yoop_io_file_size(const char* path) {
    struct stat st;
    if (stat(path, &st) != 0) return -1;
    if (!S_ISREG(st.st_mode)) return -1;
    return (int64_t)st.st_size;
}

// ----- directory listing -------------------------------------------------
//
// A thin opendir/readdir/closedir wrapper plus a combined stat helper, so a
// yoop caller can walk a tree without hand-mirroring the platform-specific
// `struct dirent` layout (it differs across macOS/Linux and is a footgun to
// decode in yoop). Modeled after the yoop_io_mkdir / yoop_io_file_size
// pattern: a few POSIX-y helpers the std/example layer wraps in safe exports.
//
// dirent is POSIX; on Windows these would need FindFirstFile. That backend is
// not implemented (matching the multiplexer's Windows stub), so the directory
// helpers return "empty" there rather than failing to link.

#ifndef _WIN32
#include <dirent.h>

// Open `path` for iteration. Returns an opaque DIR* (as void*) or NULL on
// failure (errno set). The yoop side treats it as `unsafe_ptr`.
void* yoop_io_opendir(const char* path) {
    return (void*)opendir(path);
}

// Return the next entry name in the directory stream, skipping "." and "..",
// or the empty string "" once the stream is exhausted (so the yoop caller can
// test `name.len == 0` rather than reach for a null string). The returned
// pointer is BORROWED - it lives inside the DIR stream and is invalidated by
// the next readdir / closedir, so the yoop caller must copy it (e.g.
// string_concat) before the next call.
const char* yoop_io_readdir(void* d) {
    if (!d) return "";
    struct dirent* e;
    while ((e = readdir((DIR*)d)) != NULL) {
        const char* n = e->d_name;
        if (n[0] == '.' && (n[1] == '\0' || (n[1] == '.' && n[2] == '\0'))) {
            continue;  // skip "." and ".."
        }
        return n;
    }
    return "";
}

void yoop_io_closedir(void* d) {
    if (d) closedir((DIR*)d);
}

// Combined "what is this and how big" probe in a single lstat (one syscall
// per entry instead of two). Writes 1 into *is_dir for a directory, else 0,
// and returns:
//   * a regular file's byte size,
//   * 0 for a directory (its aggregate is summed by the walker),
//   * 0 for anything else (symlink/socket/fifo - counted as a 0-size leaf),
//   * -1 if the lstat itself failed (then *is_dir is 0).
// lstat (not stat) so symlinks are NOT followed: that avoids both infinite
// recursion through symlink cycles and double-counting linked trees - a
// symlinked directory reads as a non-dir leaf and is never descended into.
int64_t yoop_io_stat2(const char* path, int32_t* is_dir) {
    struct stat st;
    if (lstat(path, &st) != 0) {
        if (is_dir) *is_dir = 0;
        return -1;
    }
    if (S_ISDIR(st.st_mode)) {
        if (is_dir) *is_dir = 1;
        return 0;
    }
    if (is_dir) *is_dir = 0;
    if (S_ISREG(st.st_mode)) return (int64_t)st.st_size;
    return 0;
}

// Copy a C string into a fresh malloc'd one. The yoop side treats every
// string as owned-and-leaked, so the helpers below hand back allocations
// rather than pointers into a static or libc-owned buffer.
static char* yoop_io_dup(const char* s) {
    size_t n = strlen(s);
    char* out = (char*)malloc(n + 1);
    if (!out) return NULL;
    memcpy(out, s, n + 1);
    return out;
}

// The long-listing sibling of yoop_io_stat2: everything an `ls -l` row needs
// from one lstat. Writes the entry kind into *kind (0 file, 1 dir, 2 symlink,
// 3 other - derived from the S_IS* macros so yoop never mirrors platform type
// bits), the portable 0777 permission mask into *perm, hard-link count into
// *nlink, owner/group ids into *uid/*gid, and mtime seconds into *mtime.
// Returns the byte size, or -1 if the lstat failed (out params are zeroed
// first, so a failed probe reads as an empty "other"). All out params are
// required.
int64_t yoop_io_stat_meta(const char* path, int32_t* kind, int32_t* perm,
                          int32_t* nlink, int32_t* uid, int32_t* gid,
                          int64_t* mtime) {
    struct stat st;
    *kind = 3; *perm = 0; *nlink = 0; *uid = 0; *gid = 0; *mtime = 0;
    if (lstat(path, &st) != 0) return -1;
    if (S_ISREG(st.st_mode))      *kind = 0;
    else if (S_ISDIR(st.st_mode)) *kind = 1;
    else if (S_ISLNK(st.st_mode)) *kind = 2;
    *perm  = (int32_t)(st.st_mode & 0777);
    *nlink = (int32_t)st.st_nlink;
    *uid   = (int32_t)st.st_uid;
    *gid   = (int32_t)st.st_gid;
    *mtime = (int64_t)st.st_mtime;
    return (int64_t)st.st_size;
}

// Owner / group name for an id, falling back to the id in decimal when the
// passwd / group database has no entry for it (the same thing ls does).
// Caller owns the returned string.
char* yoop_io_user_name(int32_t uid) {
    struct passwd* pw = getpwuid((uid_t)uid);
    if (pw && pw->pw_name) return yoop_io_dup(pw->pw_name);
    char buf[32];
    snprintf(buf, sizeof(buf), "%d", (int)uid);
    return yoop_io_dup(buf);
}

char* yoop_io_group_name(int32_t gid) {
    struct group* gr = getgrgid((gid_t)gid);
    if (gr && gr->gr_name) return yoop_io_dup(gr->gr_name);
    char buf[32];
    snprintf(buf, sizeof(buf), "%d", (int)gid);
    return yoop_io_dup(buf);
}

// Local-time rendering of a unix timestamp in ls's two shapes: "Mon DD HH:MM"
// for anything inside the last six months, "Mon DD  YYYY" for older entries
// (and for anything implausibly far in the future). Caller owns the result.
char* yoop_io_time_string(int64_t epoch) {
    time_t t = (time_t)epoch;
    struct tm* lt = localtime(&t);
    if (!lt) return yoop_io_dup("");
    double age = difftime(time(NULL), t);
    const char* form = (age > 15552000.0 || age < -3600.0) ? "%b %e  %Y" : "%b %e %H:%M";
    char buf[64];
    if (strftime(buf, sizeof(buf), form, lt) == 0) buf[0] = '\0';
    return yoop_io_dup(buf);
}

#else  // _WIN32: no dirent backend yet (see header comment).

void*       yoop_io_opendir(const char* path) { (void)path; return NULL; }
const char* yoop_io_readdir(void* d)          { (void)d; return NULL; }
void        yoop_io_closedir(void* d)         { (void)d; }
int64_t     yoop_io_stat2(const char* path, int32_t* is_dir) {
    (void)path; if (is_dir) *is_dir = 0; return -1;
}
int64_t     yoop_io_stat_meta(const char* path, int32_t* kind, int32_t* perm,
                              int32_t* nlink, int32_t* uid, int32_t* gid,
                              int64_t* mtime) {
    (void)path;
    *kind = 3; *perm = 0; *nlink = 0; *uid = 0; *gid = 0; *mtime = 0;
    return -1;
}
char*       yoop_io_user_name(int32_t uid)  { (void)uid; return _strdup(""); }
char*       yoop_io_group_name(int32_t gid) { (void)gid; return _strdup(""); }
char*       yoop_io_time_string(int64_t epoch) { (void)epoch; return _strdup(""); }

#endif

#ifdef _WIN32
  // Stub for now - no IOCP backend. Public API returns ENOSYS.
  int yoop_io_wait_readable(int fd) { (void)fd; errno = ENOSYS; return -1; }
  int yoop_io_wait_writable(int fd) { (void)fd; errno = ENOSYS; return -1; }
  int yoop_io_wait_readable_ex(int fd, yoop_cancel_t* ct, uint64_t deadline_ns) {
      (void)fd; (void)ct; (void)deadline_ns; errno = ENOSYS; return -1;
  }
  int yoop_io_wait_writable_ex(int fd, yoop_cancel_t* ct, uint64_t deadline_ns) {
      (void)fd; (void)ct; (void)deadline_ns; errno = ENOSYS; return -1;
  }
  void yoop_io_shutdown(void) {}
#else

#include <pthread.h>

#if defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
  #define YOOP_IO_KQUEUE 1
  #include <sys/event.h>
  #include <sys/time.h>
#elif defined(__linux__)
  #define YOOP_IO_EPOLL 1
  #include <sys/epoll.h>
#else
  #error "Unsupported platform - add a yoop_io.c backend"
#endif

// Per-wait state. Lives on the caller's stack. The multiplexer only
// ever reaches it through the registration table below, and only while
// holding io_mu - which is what lets a waiter abandon (on a timeout or
// a cancellation) and reclaim its frame without racing the I/O thread.
typedef struct yoop_io_wait {
    yoop_park_token_t token;
    int               result_errno; // 0 on ready, else errno
    int               fired;        // multiplexer delivered a wake (io_mu)
} yoop_io_wait_t;

// One live registration. Registrations are identified by a monotonically
// increasing sequence number rather than by the address of the wait
// struct: a stack frame can be reused by the next waiter at the very
// same address, and a stale event carrying that address would then be
// misdelivered to an unrelated wait. Sequence numbers are never reused,
// so a stale event simply fails to find its entry and is dropped.
typedef struct yoop_io_reg {
    uint64_t            seq;
    int                 fd;
    int                 want_write;
    yoop_io_wait_t*     w;
    struct yoop_io_reg* next;
} yoop_io_reg;

// Multiplexer state.
//
// io_init_mu guards startup/shutdown; io_mu guards the registration
// table and the fired/unpark handshake. The pair used to be a
// pthread_once_t, which could not be reset - so an init after a
// shutdown left the multiplexer permanently dead (the TODO at the
// bottom of yoop_io_shutdown). A plain flag under a mutex restarts
// cleanly.
static pthread_mutex_t io_init_mu   = PTHREAD_MUTEX_INITIALIZER;
static int             io_started   = 0;
static pthread_t       io_thread;
static int             io_shutdown_w = -1; // write end of self-pipe
static int             io_shutdown_r = -1; // read  end

static yoop_mutex_t io_mu;
static int          io_mu_ready = 0;   // io_mu is never destroyed (see below)
static yoop_io_reg* io_regs     = NULL;
static uint64_t     io_seq_next = 1;   // 0 is the self-pipe sentinel

#ifdef YOOP_IO_KQUEUE
static int io_kq = -1;
#endif
#ifdef YOOP_IO_EPOLL
static int io_ep = -1;
#endif

// ---- registration table (all callers hold io_mu) --------------------------

static yoop_io_reg* reg_find_seq_locked(uint64_t seq) {
    for (yoop_io_reg* r = io_regs; r; r = r->next) {
        if (r->seq == seq) return r;
    }
    return NULL;
}

static int reg_fd_taken_locked(int fd, int want_write) {
    for (yoop_io_reg* r = io_regs; r; r = r->next) {
        if (r->fd == fd && r->want_write == want_write) return 1;
    }
    return 0;
}

static void reg_remove_locked(yoop_io_reg* target) {
    yoop_io_reg** link = &io_regs;
    while (*link) {
        if (*link == target) { *link = target->next; free(target); return; }
        link = &(*link)->next;
    }
}

// Drop a still-armed interest from the kernel's set. Failures are
// ignored on purpose: the fd may already have been closed by the
// caller, or the event may have been consumed one-shot before we got
// here. Either way there is nothing left to disarm.
static void io_deregister(int fd, int want_write) {
#ifdef YOOP_IO_KQUEUE
    struct kevent ev;
    EV_SET(&ev, fd, want_write ? EVFILT_WRITE : EVFILT_READ, EV_DELETE, 0, 0, NULL);
    (void)kevent(io_kq, &ev, 1, NULL, 0, NULL);
#endif
#ifdef YOOP_IO_EPOLL
    (void)want_write;
    (void)epoll_ctl(io_ep, EPOLL_CTL_DEL, fd, NULL);
#endif
}

// Drain the self-pipe so the next read sees fresh shutdown bytes.
static void drain_self_pipe(int fd) {
    char buf[64];
    while (read(fd, buf, sizeof(buf)) > 0) { /* keep going */ }
}

// Deliver one readiness (or error) event to whichever wait registered
// `seq`. Returns with the waiter unparked, or does nothing at all if
// the registration is gone - which is exactly what happens when the
// waiter abandoned on a timeout or a cancellation.
//
// The whole body runs under io_mu, and `fired` is set before the
// unpark. That is the contract the abandon path relies on: a waiter
// that takes io_mu and sees fired == 0 knows the multiplexer can never
// reach its stack frame again once it removes the entry.
static void io_deliver(uint64_t seq, int err) {
    yoop_mutex_lock(&io_mu);
    yoop_io_reg* r = reg_find_seq_locked(seq);
    if (r) {
        r->w->result_errno = err;
        r->w->fired        = 1;
        yoop_unpark(&r->w->token);
        reg_remove_locked(r);
    }
    yoop_mutex_unlock(&io_mu);
}

#ifdef YOOP_IO_EPOLL
// Pull the real error off a socket that reported EPOLLERR/EPOLLHUP.
// epoll only tells you "something went wrong"; SO_ERROR is where the
// actual code lives. Reporting a blanket EIO (which is what this used
// to do) turns every connection refused / reset into the same
// uninformative message. kqueue needs no equivalent - EV_ERROR already
// carries the errno in ev->data.
static int io_socket_error(int fd, int fallback) {
    int err = 0;
    socklen_t len = sizeof(err);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) == 0 && err != 0) {
        return err;
    }
    return fallback;
}
#endif

static void* io_thread_main(void* arg) {
    (void)arg;
#ifdef YOOP_IO_KQUEUE
    struct kevent events[64];
    for (;;) {
        int n = kevent(io_kq, NULL, 0, events, 64, NULL);
        if (n < 0) {
            if (errno == EINTR) continue;
            // Fatal - exit the loop. The runtime is shutting down.
            break;
        }
        int should_exit = 0;
        for (int i = 0; i < n; i++) {
            struct kevent* ev = &events[i];
            uint64_t seq = (uint64_t)(uintptr_t)ev->udata;
            // Self-pipe shutdown wake: seq 0 is the reserved sentinel.
            if (seq == 0 && (int)ev->ident == io_shutdown_r) {
                drain_self_pipe(io_shutdown_r);
                should_exit = 1;
                continue;
            }
            if (seq == 0) continue;
            io_deliver(seq, (ev->flags & EV_ERROR) ? (int)ev->data : 0);
        }
        if (should_exit) break;
    }
#endif
#ifdef YOOP_IO_EPOLL
    struct epoll_event events[64];
    for (;;) {
        int n = epoll_wait(io_ep, events, 64, -1);
        if (n < 0) {
            if (errno == EINTR) continue;
            break;
        }
        int should_exit = 0;
        for (int i = 0; i < n; i++) {
            struct epoll_event* ev = &events[i];
            uint64_t seq = ev->data.u64;
            if (seq == 0) {
                // Self-pipe wake.
                drain_self_pipe(io_shutdown_r);
                should_exit = 1;
                continue;
            }
            int err = 0;
            if (ev->events & (EPOLLERR | EPOLLHUP)) {
                // Look up the fd through the table so SO_ERROR can be
                // read - epoll's payload carries the seq, not the fd.
                int fd = -1;
                yoop_mutex_lock(&io_mu);
                yoop_io_reg* r = reg_find_seq_locked(seq);
                if (r) fd = r->fd;
                yoop_mutex_unlock(&io_mu);
                err = (fd >= 0) ? io_socket_error(fd, EIO) : EIO;
            }
            io_deliver(seq, err);
        }
        if (should_exit) break;
    }
#endif
    return NULL;
}

// Start the I/O thread. Caller holds io_init_mu; no-op if already up.
static void io_start_locked(void) {
    if (io_started) return;

    // io_mu guards the registration table and outlives every
    // start/shutdown cycle. It is deliberately never destroyed: a
    // waiter woken by shutdown still has to take it on its way out, and
    // destroying a mutex someone is about to lock is UB. One
    // process-lifetime mutex is a fair price.
    if (!io_mu_ready) { yoop_mutex_init(&io_mu); io_mu_ready = 1; }

#ifdef YOOP_IO_KQUEUE
    io_kq = kqueue();
    if (io_kq < 0) return;
#endif
#ifdef YOOP_IO_EPOLL
    io_ep = epoll_create1(EPOLL_CLOEXEC);
    if (io_ep < 0) return;
#endif

    // Self-pipe for shutdown wake.
    int fds[2];
    if (pipe(fds) != 0) {
#ifdef YOOP_IO_KQUEUE
        close(io_kq); io_kq = -1;
#endif
#ifdef YOOP_IO_EPOLL
        close(io_ep); io_ep = -1;
#endif
        return;
    }
    io_shutdown_r = fds[0];
    io_shutdown_w = fds[1];
    // Non-blocking so drain_self_pipe doesn't hang.
    int fl = fcntl(io_shutdown_r, F_GETFL, 0);
    fcntl(io_shutdown_r, F_SETFL, fl | O_NONBLOCK);

#ifdef YOOP_IO_KQUEUE
    struct kevent ev;
    // seq 0 is the reserved shutdown sentinel.
    EV_SET(&ev, io_shutdown_r, EVFILT_READ, EV_ADD, 0, 0, NULL);
    kevent(io_kq, &ev, 1, NULL, 0, NULL);
#endif
#ifdef YOOP_IO_EPOLL
    struct epoll_event ev;
    ev.events = EPOLLIN;
    ev.data.u64 = 0; // shutdown sentinel
    epoll_ctl(io_ep, EPOLL_CTL_ADD, io_shutdown_r, &ev);
#endif

    if (pthread_create(&io_thread, NULL, io_thread_main, NULL) != 0) {
        close(io_shutdown_r); io_shutdown_r = -1;
        close(io_shutdown_w); io_shutdown_w = -1;
#ifdef YOOP_IO_KQUEUE
        close(io_kq); io_kq = -1;
#endif
#ifdef YOOP_IO_EPOLL
        close(io_ep); io_ep = -1;
#endif
        return;
    }
    io_started = 1;
}

void yoop_io_shutdown(void) {
    pthread_mutex_lock(&io_init_mu);
    if (!io_started) { pthread_mutex_unlock(&io_init_mu); return; }

    // Wake the I/O thread by writing one byte to the self-pipe.
    char b = 'x';
    (void)write(io_shutdown_w, &b, 1);
    pthread_join(io_thread, NULL);

    // Release anyone still parked. Without this a thread waiting on an
    // fd that never becomes ready would block past runtime shutdown
    // with nothing left running to wake it. ESHUTDOWN surfaces as an
    // ordinary I/O error to the caller.
    yoop_mutex_lock(&io_mu);
    while (io_regs) {
        yoop_io_reg* r = io_regs;
        r->w->result_errno = ESHUTDOWN;
        r->w->fired        = 1;
        yoop_unpark(&r->w->token);
        io_regs = r->next;
        free(r);
    }
    yoop_mutex_unlock(&io_mu);

#ifdef YOOP_IO_KQUEUE
    if (io_kq >= 0) { close(io_kq); io_kq = -1; }
#endif
#ifdef YOOP_IO_EPOLL
    if (io_ep >= 0) { close(io_ep); io_ep = -1; }
#endif
    if (io_shutdown_r >= 0) { close(io_shutdown_r); io_shutdown_r = -1; }
    if (io_shutdown_w >= 0) { close(io_shutdown_w); io_shutdown_w = -1; }
    io_started = 0;
    pthread_mutex_unlock(&io_init_mu);
    // Restartable: io_started is a plain flag under io_init_mu, so a
    // later yoop_runtime_init spins the multiplexer back up. (The old
    // pthread_once guard made the second init a silent no-op.)
}

static int io_ensure_started(void) {
    pthread_mutex_lock(&io_init_mu);
    if (!io_started) io_start_locked();
    int ok = io_started;
    pthread_mutex_unlock(&io_init_mu);
    return ok;
}

// Arm a one-shot interest in `fd` carrying `seq`. Returns 0 on success,
// -1 with errno set.
static int io_register(int fd, int want_write, uint64_t seq) {
#ifdef YOOP_IO_KQUEUE
    struct kevent ev;
    int filter = want_write ? EVFILT_WRITE : EVFILT_READ;
    EV_SET(&ev, fd, filter, EV_ADD | EV_ONESHOT, 0, 0, (void*)(uintptr_t)seq);
    return kevent(io_kq, &ev, 1, NULL, 0, NULL) < 0 ? -1 : 0;
#endif
#ifdef YOOP_IO_EPOLL
    struct epoll_event ev;
    ev.events   = (unsigned)(want_write ? EPOLLOUT : EPOLLIN) | EPOLLONESHOT;
    ev.data.u64 = seq;
    if (epoll_ctl(io_ep, EPOLL_CTL_ADD, fd, &ev) == 0) return 0;
    // A stale disarmed registration from an earlier wait on this fd can
    // linger; MOD re-arms it. This is safe here in a way it was NOT
    // before, because the table above already proved no OTHER waiter
    // currently owns this (fd, direction) - which is precisely the case
    // where MOD used to silently steal the first waiter's wakeup.
    if (errno == EEXIST) {
        return epoll_ctl(io_ep, EPOLL_CTL_MOD, fd, &ev) < 0 ? -1 : 0;
    }
    return -1;
#endif
}

// The one wait implementation. Returns YOOP_WAIT_READY / TIMEDOUT /
// CANCELLED, or -1 with errno set.
static int io_wait_common(int fd, int want_write,
                          yoop_cancel_t* ct, uint64_t deadline_ns) {
    if (!io_ensure_started()) { errno = ENOSYS; return -1; }

    // The token's own deadline and the caller's both apply; whichever
    // lands first wins. This is what makes "this request gets 5
    // seconds total" work without threading a deadline through every
    // intermediate call.
    uint64_t deadline = yoop_cancel_effective_deadline(ct, deadline_ns);

    // Cheap pre-checks so an already-cancelled token or an already-past
    // deadline never touches the kernel. An elapsed token deadline is a
    // TIMEDOUT, not a CANCELLED - only an explicit request is a
    // cancellation (see yoop_cancel_flagged).
    if (yoop_cancel_flagged(ct))                       return YOOP_WAIT_CANCELLED;
    if (deadline != 0 && yoop_now_ns() >= deadline)    return YOOP_WAIT_TIMEDOUT;

    yoop_io_wait_t w;
    yoop_park_token_init(&w.token);
    w.result_errno = 0;
    w.fired        = 0;

    // Claim the (fd, direction) slot before touching the kernel. Only
    // one waiter per pair: epoll's MOD and kqueue's EV_SET both
    // overwrite the stored payload, so a second concurrent registration
    // used to strand the first waiter forever with no wakeup coming.
    yoop_mutex_lock(&io_mu);
    if (reg_fd_taken_locked(fd, want_write)) {
        yoop_mutex_unlock(&io_mu);
        yoop_park_token_destroy(&w.token);
        errno = EAGAIN;
        return -1;
    }
    yoop_io_reg* reg = (yoop_io_reg*)malloc(sizeof(yoop_io_reg));
    if (!reg) {
        yoop_mutex_unlock(&io_mu);
        yoop_park_token_destroy(&w.token);
        errno = ENOMEM;
        return -1;
    }
    uint64_t seq = io_seq_next++;
    reg->seq        = seq;
    reg->fd         = fd;
    reg->want_write = want_write;
    reg->w          = &w;
    reg->next       = io_regs;
    io_regs         = reg;

    if (io_register(fd, want_write, seq) < 0) {
        int saved = errno;
        reg_remove_locked(reg);
        yoop_mutex_unlock(&io_mu);
        yoop_park_token_destroy(&w.token);
        errno = saved;
        return -1;
    }
    yoop_mutex_unlock(&io_mu);

    // Ask the token to unpark us on cancellation. A token cancelled
    // between the pre-check above and here reports it here instead.
    yoop_cancel_waiter_t cw;
    int registered_with_token = 0;
    if (yoop_cancel_add_waiter(ct, &cw, &w.token) == 0) {
        registered_with_token = (ct != NULL);
    }

    int outcome;
    for (;;) {
        int timed_out = yoop_park_until(&w.token, deadline);

        yoop_mutex_lock(&io_mu);
        if (w.fired) {
            // The multiplexer already delivered (and removed the entry)
            // while holding io_mu, so it is provably done with `w`.
            yoop_mutex_unlock(&io_mu);
            outcome = (w.result_errno != 0) ? -1 : YOOP_WAIT_READY;
            break;
        }
        // Not fired: we still own the registration, so tearing it down
        // under io_mu guarantees the multiplexer can never reach this
        // stack frame again.
        if (yoop_cancel_flagged(ct)) {
            io_deregister(fd, want_write);
            reg_remove_locked(reg);
            yoop_mutex_unlock(&io_mu);
            outcome = YOOP_WAIT_CANCELLED;
            break;
        }
        if (timed_out || (deadline != 0 && yoop_now_ns() >= deadline)) {
            io_deregister(fd, want_write);
            reg_remove_locked(reg);
            yoop_mutex_unlock(&io_mu);
            outcome = YOOP_WAIT_TIMEDOUT;
            break;
        }
        // Spurious wake (e.g. a deadline change nudged the token).
        // Nothing decided yet - go back to parking.
        yoop_mutex_unlock(&io_mu);
    }

    // Deregister from the token BEFORE the park token dies: once this
    // returns, yoop_cancel_request can no longer unpark `w.token`.
    if (registered_with_token) yoop_cancel_remove_waiter(ct, &cw);

    int saved_errno = w.result_errno;
    yoop_park_token_destroy(&w.token);
    if (outcome == -1) errno = saved_errno;
    return outcome;
}

int yoop_io_wait_readable(int fd) {
    int rc = io_wait_common(fd, 0, NULL, 0);
    // The legacy two-arg form has no deadline and no token, so READY
    // and error are the only reachable outcomes.
    return rc == YOOP_WAIT_READY ? 0 : -1;
}

int yoop_io_wait_writable(int fd) {
    int rc = io_wait_common(fd, 1, NULL, 0);
    return rc == YOOP_WAIT_READY ? 0 : -1;
}

int yoop_io_wait_readable_ex(int fd, yoop_cancel_t* ct, uint64_t deadline_ns) {
    return io_wait_common(fd, 0, ct, deadline_ns);
}

int yoop_io_wait_writable_ex(int fd, yoop_cancel_t* ct, uint64_t deadline_ns) {
    return io_wait_common(fd, 1, ct, deadline_ns);
}

#endif // !_WIN32
