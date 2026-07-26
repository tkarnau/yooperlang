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

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

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

#else  // _WIN32: no dirent backend yet (see header comment).

void*       yoop_io_opendir(const char* path) { (void)path; return NULL; }
const char* yoop_io_readdir(void* d)          { (void)d; return NULL; }
void        yoop_io_closedir(void* d)         { (void)d; }
int64_t     yoop_io_stat2(const char* path, int32_t* is_dir) {
    (void)path; if (is_dir) *is_dir = 0; return -1;
}

#endif

#ifdef _WIN32
  // Stub for now - no IOCP backend. Public API returns ENOSYS.
  int yoop_io_wait_readable(int fd) { (void)fd; errno = ENOSYS; return -1; }
  int yoop_io_wait_writable(int fd) { (void)fd; errno = ENOSYS; return -1; }
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

// Per-wait state. Lives on the caller's stack; the multiplexer
// dereferences it only between register_interest() and unpark(). Once
// unpark fires, the parker returns and the stack is reclaimed; the
// multiplexer must not touch this struct after that point. The
// one-shot semantics from kqueue/epoll ensure exactly one unpark per
// registration.
typedef struct yoop_io_wait {
    yoop_park_token_t token;
    int               result_errno; // 0 on ready, else errno
} yoop_io_wait_t;

// Multiplexer state, all guarded by io_mu where needed.
static pthread_once_t io_once       = PTHREAD_ONCE_INIT;
static int            io_started    = 0;
static pthread_t      io_thread;
static int            io_shutdown_w = -1; // write end of self-pipe
static int            io_shutdown_r = -1; // read  end

#ifdef YOOP_IO_KQUEUE
static int io_kq = -1;
#endif
#ifdef YOOP_IO_EPOLL
static int io_ep = -1;
#endif

// Drain the self-pipe so the next read sees fresh shutdown bytes.
static void drain_self_pipe(int fd) {
    char buf[64];
    while (read(fd, buf, sizeof(buf)) > 0) { /* keep going */ }
}

static void* io_thread_main(void* arg) {
    (void)arg;
#ifdef YOOP_IO_KQUEUE
    struct kevent events[64];
    for (;;) {
        int n = kevent(io_kq, NULL, 0, events, 64, NULL);
        if (n < 0) {
            if (errno == EINTR) continue;
            // Fatal - log and exit the loop. The runtime is shutting down.
            break;
        }
        int should_exit = 0;
        for (int i = 0; i < n; i++) {
            struct kevent* ev = &events[i];
            // Self-pipe shutdown wake: ident == read end of the pipe.
            if (ev->udata == NULL && (int)ev->ident == io_shutdown_r) {
                drain_self_pipe(io_shutdown_r);
                should_exit = 1;
                continue;
            }
            yoop_io_wait_t* w = (yoop_io_wait_t*)ev->udata;
            if (!w) continue;
            if (ev->flags & EV_ERROR) {
                w->result_errno = (int)ev->data;
            } else {
                w->result_errno = 0;
            }
            yoop_unpark(&w->token);
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
            if (ev->data.ptr == NULL) {
                // Self-pipe wake.
                drain_self_pipe(io_shutdown_r);
                should_exit = 1;
                continue;
            }
            yoop_io_wait_t* w = (yoop_io_wait_t*)ev->data.ptr;
            // Remove the fd from the set (one-shot semantics). We don't
            // know the fd off the bat - but epoll's data.ptr is the
            // token, not the fd. The fd is recoverable only if we stash
            // it; for one-shot we just rely on EPOLLONESHOT having
            // disarmed the fd. The caller re-arms on next wait_*.
            if (ev->events & (EPOLLERR | EPOLLHUP)) {
                w->result_errno = EIO;
            } else {
                w->result_errno = 0;
            }
            yoop_unpark(&w->token);
        }
        if (should_exit) break;
    }
#endif
    return NULL;
}

static void io_init_once(void) {
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
    // udata = NULL is the shutdown sentinel.
    EV_SET(&ev, io_shutdown_r, EVFILT_READ, EV_ADD, 0, 0, NULL);
    kevent(io_kq, &ev, 1, NULL, 0, NULL);
#endif
#ifdef YOOP_IO_EPOLL
    struct epoll_event ev;
    ev.events = EPOLLIN;
    ev.data.ptr = NULL; // shutdown sentinel
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
    if (!io_started) return;
    // Wake the I/O thread by writing one byte to the self-pipe.
    char b = 'x';
    (void)write(io_shutdown_w, &b, 1);
    pthread_join(io_thread, NULL);
#ifdef YOOP_IO_KQUEUE
    if (io_kq >= 0) { close(io_kq); io_kq = -1; }
#endif
#ifdef YOOP_IO_EPOLL
    if (io_ep >= 0) { close(io_ep); io_ep = -1; }
#endif
    if (io_shutdown_r >= 0) { close(io_shutdown_r); io_shutdown_r = -1; }
    if (io_shutdown_w >= 0) { close(io_shutdown_w); io_shutdown_w = -1; }
    io_started = 0;
    // Note: pthread_once doesn't reset across shutdown/init cycles in this
    // process. If yoop_runtime_init runs a second time within the same
    // process, the io_once guard prevents re-initialization. For the
    // current test suite that's fine; lifting this is a TODO if needed.
}

static int io_wait_common(int fd, int want_write) {
    pthread_once(&io_once, io_init_once);
    if (!io_started) { errno = ENOSYS; return -1; }

    yoop_io_wait_t w;
    yoop_park_token_init(&w.token);
    w.result_errno = 0;

#ifdef YOOP_IO_KQUEUE
    struct kevent ev;
    int filter = want_write ? EVFILT_WRITE : EVFILT_READ;
    EV_SET(&ev, fd, filter, EV_ADD | EV_ONESHOT, 0, 0, &w);
    if (kevent(io_kq, &ev, 1, NULL, 0, NULL) < 0) {
        int saved = errno;
        yoop_park_token_destroy(&w.token);
        errno = saved;
        return -1;
    }
#endif
#ifdef YOOP_IO_EPOLL
    struct epoll_event ev;
    ev.events = (want_write ? EPOLLOUT : EPOLLIN) | EPOLLONESHOT;
    ev.data.ptr = &w;
    // Try ADD first; if the fd is already registered (e.g. from a prior
    // wait that was disarmed but not removed), MOD to re-arm.
    if (epoll_ctl(io_ep, EPOLL_CTL_ADD, fd, &ev) < 0) {
        if (errno == EEXIST) {
            if (epoll_ctl(io_ep, EPOLL_CTL_MOD, fd, &ev) < 0) {
                int saved = errno;
                yoop_park_token_destroy(&w.token);
                errno = saved;
                return -1;
            }
        } else {
            int saved = errno;
            yoop_park_token_destroy(&w.token);
            errno = saved;
            return -1;
        }
    }
#endif

    yoop_park(&w.token);

#ifdef YOOP_IO_EPOLL
    // One-shot: explicitly remove so a future wait can ADD freshly.
    // Ignore failures - the fd may already have been closed by the
    // caller.
    epoll_ctl(io_ep, EPOLL_CTL_DEL, fd, NULL);
#endif

    int rc;
    if (w.result_errno != 0) {
        errno = w.result_errno;
        rc = -1;
    } else {
        rc = 0;
    }
    yoop_park_token_destroy(&w.token);
    return rc;
}

int yoop_io_wait_readable(int fd) { return io_wait_common(fd, 0); }
int yoop_io_wait_writable(int fd) { return io_wait_common(fd, 1); }

#endif // !_WIN32
