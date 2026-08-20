// yoop_io.c - I/O multiplexer core for the Yooperlang runtime.
//
// This file owns everything that does NOT vary by platform: the registration
// table, the sequence-numbered identity scheme, the fired-under-io_mu abandon
// handshake, the park/suspend bookkeeping, lifecycle, and the public entry
// points. The platform's actual event engine lives behind the yoop_iob_*
// contract in yoop_io_internal.h, implemented once per platform in
// yoop_io_kqueue.c / yoop_io_epoll.c / yoop_io_windows.c.
//
// The two shapes a wait can take, both routed through the same table:
//
//   BLOCKING - yoop_io_wait_readable[_ex] parks the CALLING THREAD on a park
//   token. Delivery unparks it. Used by code that is not inside a coroutine.
//
//   ASYNC - yoop_io_arm_readable registers against the CURRENT TASK and
//   returns immediately, so the caller can suspend its coroutine and hand the
//   worker thread back. Delivery pushes the task onto the run queue instead.
//
// See yoop_io_internal.h for why the backends are split rather than
// abstracted together.
//
// The filesystem and directory helpers live in yoop_fs.c - they have nothing
// to do with polling beyond the filename.

#include "yoop_io_internal.h"

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
  // yoop_platform.h already established the winsock2 -> ws2tcpip -> windows
  // include order (see the note there on why that cannot be left to each TU).
  #pragma comment(lib, "ws2_32.lib")
#else
  #include <unistd.h>
  #include <sys/socket.h>
#endif

// ----- descriptor operations that differ by platform -----------------------
//
// On POSIX a socket IS a file descriptor, so read/write/close apply. Winsock
// keeps sockets in a separate namespace from CRT file descriptors: they must
// be closed with closesocket and transferred with recv/send.
#ifdef _WIN32
  #define YOOP_CLOSE_SOCK(fd)        closesocket((SOCKET)(fd))
  #define YOOP_READ_SOCK(fd, b, n)   recv((SOCKET)(fd), (char*)(b), (int)(n), 0)
  #define YOOP_WRITE_SOCK(fd, b, n)  send((SOCKET)(fd), (const char*)(b), (int)(n), 0)
#else
  #define YOOP_CLOSE_SOCK(fd)        close(fd)
  #define YOOP_READ_SOCK(fd, b, n)   read((fd), (b), (n))
  #define YOOP_WRITE_SOCK(fd, b, n)  write((fd), (b), (n))
#endif

// A connected pair of descriptors, used by the POSIX engines for their self
// pipe and by the runtime's C tests and fixtures.
//
// POSIX has pipe(); Windows has _pipe() but its handles cannot be waited on by
// the multiplexer, so the pair is built from loopback TCP sockets there. The
// listener is bound to 127.0.0.1:0 (an ephemeral port), accepted once, and
// closed immediately, so nothing is reachable from off-machine.
//
// Returns 0 on success and fills fds[0] (read end) and fds[1] (write end), or
// -1 with errno set.
int yoop_socketpair(int fds[2]) {
#ifdef _WIN32
    yoop_net_startup();

    SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == INVALID_SOCKET) return yoop_sock_fail();

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port        = 0;

    int addrlen = (int)sizeof(addr);
    if (bind(listener, (struct sockaddr*)&addr, addrlen) == SOCKET_ERROR ||
        listen(listener, 1) == SOCKET_ERROR ||
        getsockname(listener, (struct sockaddr*)&addr, &addrlen) == SOCKET_ERROR) {
        int saved = WSAGetLastError();
        closesocket(listener);
        WSASetLastError(saved);
        return yoop_sock_fail();
    }

    SOCKET client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (client == INVALID_SOCKET) {
        int saved = WSAGetLastError();
        closesocket(listener);
        WSASetLastError(saved);
        return yoop_sock_fail();
    }
    // Blocking connect to our own listener: the backlog is already open, so
    // this completes without a round trip that could stall.
    if (connect(client, (struct sockaddr*)&addr, addrlen) == SOCKET_ERROR) {
        int saved = WSAGetLastError();
        closesocket(client);
        closesocket(listener);
        WSASetLastError(saved);
        return yoop_sock_fail();
    }
    SOCKET server = accept(listener, NULL, NULL);
    closesocket(listener);
    if (server == INVALID_SOCKET) {
        int saved = WSAGetLastError();
        closesocket(client);
        WSASetLastError(saved);
        return yoop_sock_fail();
    }
    fds[0] = (int)server;
    fds[1] = (int)client;
    return 0;
#else
    return pipe(fds);
#endif
}

// Every descriptor close in the runtime funnels through here so the engine can
// drop per-socket state first. Closing without telling the engine is a hang on
// IOCP once the handle value is recycled - see yoop_iob_forget.
void yoop_io_closing(int fd) {
    yoop_iob_forget(fd);
}

int yoop_socketpair_close(int fd) {
    yoop_io_closing(fd);
    return YOOP_CLOSE_SOCK(fd);
}

int64_t yoop_socketpair_read(int fd, void* buf, size_t n) {
    return (int64_t)YOOP_READ_SOCK(fd, buf, n);
}

int64_t yoop_socketpair_write(int fd, const void* buf, size_t n) {
    return (int64_t)YOOP_WRITE_SOCK(fd, buf, n);
}

// ----- lifecycle state -----------------------------------------------------
//
// io_init_mu guards startup/shutdown; io_mu guards the registration table and
// the fired/unpark handshake. A plain flag under a mutex rather than a
// pthread_once_t, which cannot be reset - an init after a shutdown would
// leave the multiplexer permanently dead. A flag restarts cleanly.
//
// io_init_mu has to exist before any thread can call in, and a Win32
// CRITICAL_SECTION cannot be initialized statically the way a pthread mutex
// can. InitOnceExecuteOnce closes that gap; it is the same shape
// yoop_runtime.c uses for its own init lock, for the same reason.
#ifdef _WIN32
  static INIT_ONCE        io_init_once = INIT_ONCE_STATIC_INIT;
  static CRITICAL_SECTION io_init_cs;
  static BOOL CALLBACK io_init_cb(PINIT_ONCE o, PVOID p, PVOID* c) {
      (void)o; (void)p; (void)c;
      InitializeCriticalSection(&io_init_cs);
      return TRUE;
  }
  static void io_init_lock(void) {
      InitOnceExecuteOnce(&io_init_once, io_init_cb, NULL, NULL);
      EnterCriticalSection(&io_init_cs);
  }
  static void io_init_unlock(void) { LeaveCriticalSection(&io_init_cs); }
#else
  static pthread_mutex_t io_init_mu = PTHREAD_MUTEX_INITIALIZER;
  static void io_init_lock(void)   { pthread_mutex_lock(&io_init_mu); }
  static void io_init_unlock(void) { pthread_mutex_unlock(&io_init_mu); }
#endif

static int           io_started = 0;
static yoop_thread_t io_thread;

// Set (under io_mu) by yoop_io_shutdown before it wakes the engine. A wake can
// mean "shut down" or, for an engine that must rebuild state, "look again", so
// the flag - not the wake itself - is what ends the loop.
static int io_stopping = 0;

// The table lock. Declared extern in yoop_io_internal.h so backends can note
// which of their entry points run under it; they never take it themselves.
yoop_mutex_t yoop_io_mu;
static int          io_mu_ready = 0;   // io_mu is never destroyed (see below)
static yoop_io_reg* io_regs     = NULL;
static uint64_t     io_seq_next = 1;   // 0 is the reserved wakeup sentinel

#define io_mu yoop_io_mu

// ----- registration table (all callers hold io_mu) -------------------------

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

static void reg_unlink_locked(yoop_io_reg* target) {
    yoop_io_reg** link = &io_regs;
    while (*link) {
        if (*link == target) { *link = target->next; return; }
        link = &(*link)->next;
    }
}

static void reg_remove_locked(yoop_io_reg* target) {
    reg_unlink_locked(target);
    free(target);
}

// ----- core services the backends call -------------------------------------

void yoop_iob_deliver(uint64_t seq, int err, int64_t bytes, int completed) {
    void* wake_task = NULL;
    yoop_mutex_lock(&io_mu);
    yoop_io_reg* r = reg_find_seq_locked(seq);
    if (r) {
        // The engine is done with this registration's per-op state; the core
        // must not hand it to yoop_iob_deregister afterwards.
        r->op         = NULL;
        r->done_bytes = bytes;
        r->done_errno = err;
        r->completed  = completed;
        if (r->task) {
            // Async flavor: hand the task back to the scheduler. Deferred
            // until after the unlock - make_runnable takes the queue lock and
            // there is no reason to hold both.
            wake_task = r->task;
            // A plain readiness registration has nothing for the resumed task
            // to collect, so it is dropped here exactly as it always was. An
            // OPERATION registration survives: yoop_iop_end has to find it to
            // report the byte count (or, on a readiness backend, to retry the
            // syscall), and that call is what frees it.
            if (r->kind == YOOP_OP_NONE) reg_remove_locked(r);
        } else {
            r->w->result_errno = err;
            r->w->fired        = 1;
            yoop_unpark(&r->w->token);
            // Same rule as the task flavor: a plain readiness wait has nothing
            // to collect and is dropped here, but an OPERATION's entry has to
            // outlive delivery so the parked thread can read done_bytes out of
            // it. yoop_iop_wait is what frees those.
            if (r->kind == YOOP_OP_NONE) reg_remove_locked(r);
        }
    }
    yoop_mutex_unlock(&io_mu);
    if (wake_task) yoop_task_make_runnable(wake_task);
}

int yoop_iob_fd_for_seq(uint64_t seq) {
    int fd = -1;
    yoop_mutex_lock(&io_mu);
    yoop_io_reg* r = reg_find_seq_locked(seq);
    if (r) fd = r->fd;
    yoop_mutex_unlock(&io_mu);
    return fd;
}

int yoop_iob_stopping(void) {
    yoop_mutex_lock(&io_mu);
    int s = io_stopping;
    yoop_mutex_unlock(&io_mu);
    return s;
}

void yoop_iob_for_each(void (*fn)(const yoop_io_reg* r, void* ctx), void* ctx) {
    yoop_mutex_lock(&io_mu);
    for (yoop_io_reg* r = io_regs; r; r = r->next) fn(r, ctx);
    yoop_mutex_unlock(&io_mu);
}

yoop_io_reg* yoop_iob_alloc_reg(int fd, int want_write, void* task, int kind,
                                void* buf, size_t len, void* op) {
    if (reg_fd_taken_locked(fd, want_write)) return NULL;
    yoop_io_reg* reg = (yoop_io_reg*)calloc(1, sizeof(yoop_io_reg));
    if (!reg) return NULL;
    reg->seq        = io_seq_next++;
    reg->fd         = fd;
    reg->want_write = want_write;
    reg->task       = task;
    reg->kind       = kind;
    reg->obuf       = buf;
    reg->olen       = len;
    reg->op         = op;
    reg->next       = io_regs;
    io_regs         = reg;
    return reg;
}

void yoop_iob_free_reg(yoop_io_reg* reg) {
    reg_remove_locked(reg);
}

// ----- lifecycle -----------------------------------------------------------

static void io_thread_main(void* arg) {
    (void)arg;
    yoop_iob_loop();
}

// Start the I/O thread. Caller holds io_init_mu; no-op if already up.
static void io_start_locked(void) {
    if (io_started) return;

    // io_mu guards the registration table and outlives every start/shutdown
    // cycle. It is deliberately never destroyed: a waiter woken by shutdown
    // still has to take it on its way out, and destroying a mutex someone is
    // about to lock is UB. One process-lifetime mutex is a fair price.
    if (!io_mu_ready) { yoop_mutex_init(&io_mu); io_mu_ready = 1; }

    io_stopping = 0;
    if (yoop_iob_init() != 0) return;

    if (yoop_thread_spawn(&io_thread, io_thread_main, NULL) != 0) {
        yoop_iob_teardown();
        return;
    }
    io_started = 1;
}

void yoop_io_shutdown(void) {
    io_init_lock();
    if (!io_started) { io_init_unlock(); return; }

    // Announce the stop BEFORE waking. A wake can also mean "look again" for
    // an engine that rebuilds state, so the flag - not the wake - is what ends
    // the loop. Published under io_mu so the I/O thread's read is ordered
    // against this write.
    yoop_mutex_lock(&io_mu);
    io_stopping = 1;
    yoop_mutex_unlock(&io_mu);

    yoop_iob_wake();
    yoop_thread_join(&io_thread);

    // Release anyone still parked. Without this a thread waiting on an fd that
    // never becomes ready would block past runtime shutdown with nothing left
    // running to wake it. ESHUTDOWN surfaces as an ordinary I/O error.
    yoop_mutex_lock(&io_mu);
    while (io_regs) {
        yoop_io_reg* r = io_regs;
        if (r->task) {
            // Let the task run again so it can observe the failure and unwind,
            // rather than stranding it forever.
            void* t = r->task;
            io_regs = r->next;
            free(r);
            yoop_mutex_unlock(&io_mu);
            yoop_task_make_runnable(t);
            yoop_mutex_lock(&io_mu);
            continue;
        }
        r->w->result_errno = ESHUTDOWN;
        r->w->fired        = 1;
        yoop_unpark(&r->w->token);
        io_regs = r->next;
        free(r);
    }
    yoop_mutex_unlock(&io_mu);

    yoop_iob_teardown();
    io_started  = 0;
    io_stopping = 0;
    io_init_unlock();
    // Restartable: io_started is a plain flag under io_init_mu, so a later
    // yoop_runtime_init spins the multiplexer back up.
}

static int io_ensure_started(void) {
    io_init_lock();
    if (!io_started) io_start_locked();
    int ok = io_started;
    io_init_unlock();
    return ok;
}

// ----- the blocking wait ---------------------------------------------------

// Returns YOOP_WAIT_READY / TIMEDOUT / CANCELLED, or -1 with errno set.
static int io_wait_common(int fd, int want_write,
                          yoop_cancel_t* ct, uint64_t deadline_ns) {
    if (!io_ensure_started()) { errno = ENOSYS; return -1; }

    // The token's own deadline and the caller's both apply; whichever lands
    // first wins. This is what makes "this request gets 5 seconds total" work
    // without threading a deadline through every intermediate call.
    uint64_t deadline = yoop_cancel_effective_deadline(ct, deadline_ns);

    // Cheap pre-checks so an already-cancelled token or an already-past
    // deadline never touches the kernel. An elapsed token deadline is a
    // TIMEDOUT, not a CANCELLED - only an explicit request is a cancellation
    // (see yoop_cancel_flagged).
    if (yoop_cancel_flagged(ct))                    return YOOP_WAIT_CANCELLED;
    if (deadline != 0 && yoop_now_ns() >= deadline) return YOOP_WAIT_TIMEDOUT;

    yoop_io_wait_t w;
    yoop_park_token_init(&w.token);
    w.result_errno = 0;
    w.fired        = 0;

    // Claim the (fd, direction) slot before touching the kernel. Only one
    // waiter per pair: epoll's MOD and kqueue's EV_SET both overwrite the
    // stored payload, so a second concurrent registration would strand the
    // first waiter forever with no wakeup coming.
    yoop_mutex_lock(&io_mu);
    if (reg_fd_taken_locked(fd, want_write)) {
        yoop_mutex_unlock(&io_mu);
        yoop_park_token_destroy(&w.token);
        errno = EAGAIN;
        return -1;
    }
    yoop_io_reg* reg = (yoop_io_reg*)calloc(1, sizeof(yoop_io_reg));
    if (!reg) {
        yoop_mutex_unlock(&io_mu);
        yoop_park_token_destroy(&w.token);
        errno = ENOMEM;
        return -1;
    }
    reg->seq        = io_seq_next++;
    reg->fd         = fd;
    reg->want_write = want_write;
    reg->w          = &w;
    reg->task       = NULL;
    reg->next       = io_regs;
    io_regs         = reg;

    if (yoop_iob_register(reg) < 0) {
        int saved = errno;
        reg_remove_locked(reg);
        yoop_mutex_unlock(&io_mu);
        yoop_park_token_destroy(&w.token);
        errno = saved;
        return -1;
    }
    yoop_mutex_unlock(&io_mu);

    // Ask the token to unpark us on cancellation. A token cancelled between
    // the pre-check above and here reports it here instead.
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
            // The engine already delivered (and removed the entry) while
            // holding io_mu, so it is provably done with `w`.
            yoop_mutex_unlock(&io_mu);
            outcome = (w.result_errno != 0) ? -1 : YOOP_WAIT_READY;
            break;
        }
        // Not fired: we still own the registration, so tearing it down under
        // io_mu guarantees the engine can never reach this stack frame again.
        if (yoop_cancel_flagged(ct)) {
            yoop_iob_deregister(reg);
            reg_remove_locked(reg);
            yoop_mutex_unlock(&io_mu);
            outcome = YOOP_WAIT_CANCELLED;
            break;
        }
        if (timed_out || (deadline != 0 && yoop_now_ns() >= deadline)) {
            yoop_iob_deregister(reg);
            reg_remove_locked(reg);
            yoop_mutex_unlock(&io_mu);
            outcome = YOOP_WAIT_TIMEDOUT;
            break;
        }
        // Spurious wake (e.g. a deadline change nudged the token). Nothing
        // decided yet - go back to parking.
        yoop_mutex_unlock(&io_mu);
    }

    // Deregister from the token BEFORE the park token dies: once this returns,
    // yoop_cancel_request can no longer unpark `w.token`.
    if (registered_with_token) yoop_cancel_remove_waiter(ct, &cw);

    int saved_errno = w.result_errno;
    yoop_park_token_destroy(&w.token);
    if (outcome == -1) errno = saved_errno;
    return outcome;
}

int yoop_io_wait_readable(int fd) {
    int rc = io_wait_common(fd, 0, NULL, 0);
    // The plain form has no deadline and no token, so READY and error
    // are the only reachable outcomes.
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

// ----- async arming --------------------------------------------------------
//
// The whole point of the async runtime: register interest and RETURN, rather
// than parking the thread. The caller suspends its coroutine immediately
// afterwards, which releases the worker; delivery pushes the task back onto
// the run queue.
static int io_arm_common(int fd, int want_write) {
    void* task = yoop_current_task();
    if (!task) {
        // Not running on a worker (e.g. called straight from main). There
        // would be nothing to make runnable, so refuse rather than let the
        // caller suspend into a hole it can never come back from - the yoop
        // side falls back to the blocking wait on a 1.
        return 1;
    }
    if (!io_ensure_started()) { errno = ENOSYS; return -1; }

    yoop_mutex_lock(&io_mu);
    if (reg_fd_taken_locked(fd, want_write)) {
        yoop_mutex_unlock(&io_mu);
        errno = EAGAIN;
        return -1;
    }
    yoop_io_reg* reg = (yoop_io_reg*)calloc(1, sizeof(yoop_io_reg));
    if (!reg) {
        yoop_mutex_unlock(&io_mu);
        errno = ENOMEM;
        return -1;
    }
    reg->seq        = io_seq_next++;
    reg->fd         = fd;
    reg->want_write = want_write;
    reg->w          = NULL;
    reg->task       = task;
    reg->next       = io_regs;
    io_regs         = reg;

    if (yoop_iob_register(reg) < 0) {
        int saved = errno;
        reg_remove_locked(reg);
        yoop_mutex_unlock(&io_mu);
        errno = saved;
        return -1;
    }
    yoop_mutex_unlock(&io_mu);
    return 0;
}

int yoop_io_arm_readable(int fd) { return io_arm_common(fd, 0); }
int yoop_io_arm_writable(int fd) { return io_arm_common(fd, 1); }

// ----- misc ----------------------------------------------------------------

// Is this errno the "try again later" code? EAGAIN and EWOULDBLOCK are the
// same value on Linux and macOS but are not required to be, and neither has a
// stable numeric value across platforms - so the test lives here rather than
// as a mirrored constant in yoop.
int yoop_io_would_block(int e) {
    if (e == EAGAIN || e == EWOULDBLOCK || e == EINPROGRESS) return 1;
#ifdef _WIN32
    // Winsock codes can still reach here from a call site that read
    // WSAGetLastError directly rather than going through yoop_sock_fail.
    if (e == WSAEWOULDBLOCK || e == WSAEINPROGRESS) return 1;
#endif
    return 0;
}

int yoop_io_set_nonblocking(int fd) {
#ifdef _WIN32
    // Winsock has no fcntl; FIONBIO is the one way to set the mode, and it is
    // write-only (there is no "get" to preserve other flags, which is fine -
    // blocking mode is the only flag this touches).
    u_long on = 1;
    if (ioctlsocket((SOCKET)fd, FIONBIO, &on) == SOCKET_ERROR) return yoop_sock_fail();
    return 0;
#else
    int fl = fcntl(fd, F_GETFL, 0);
    if (fl < 0) return -1;
    return fcntl(fd, F_SETFL, fl | O_NONBLOCK);
#endif
}

// ----- the operation layer -------------------------------------------------
//
// See yoop_io_internal.h for the contract and the buffer-lifetime rule. The
// only thing that varies by platform is what a registration MEANS to the
// engine: on a readiness engine it is an interest and the syscall happens on
// resume; on a completion engine the syscall is already in flight. Both go
// through yoop_iob_register, so the code below is shared.

// The syscall an operation stands for. Used by the readiness engines both to
// try it first and to retry it on resume; the completion engine never calls
// this, because the kernel already did the work.
#ifndef _WIN32
static int64_t iop_syscall(int fd, void* buf, size_t n, int kind) {
    switch (kind) {
        case YOOP_OP_SEND:   return (int64_t)send(fd, buf, n, 0);
        case YOOP_OP_ACCEPT: return (int64_t)accept(fd, NULL, NULL);
        default:             return (int64_t)recv(fd, buf, n, 0);
    }
}
#endif

// Find the pending operation belonging to the calling task. Callers hold
// io_mu. There is at most one: a coroutine awaits one thing at a time.
static yoop_io_reg* reg_find_task_op_locked(void* task) {
    for (yoop_io_reg* r = io_regs; r; r = r->next) {
        if (r->task == task && r->kind != YOOP_OP_NONE) return r;
    }
    return NULL;
}

// Build and arm an operation registration. Callers hold io_mu. Exactly one of
// `task` / `w` is non-NULL, selecting the async or blocking flavor.
// Returns the registration, or NULL with errno set.
static yoop_io_reg* iop_arm_locked(int fd, void* buf, size_t n, int kind,
                                   void* task, yoop_io_wait_t* w) {
    int want_write = (kind == YOOP_OP_SEND);
    if (reg_fd_taken_locked(fd, want_write)) { errno = EAGAIN; return NULL; }

    yoop_io_reg* reg = (yoop_io_reg*)calloc(1, sizeof(yoop_io_reg));
    if (!reg) { errno = ENOMEM; return NULL; }
    reg->seq        = io_seq_next++;
    reg->fd         = fd;
    reg->want_write = want_write;
    reg->task       = task;
    reg->w          = w;
    reg->kind       = kind;
    reg->obuf       = buf;
    reg->olen       = n;
    reg->next       = io_regs;
    io_regs         = reg;

    if (yoop_iob_register(reg) < 0) {
        int saved = errno;
        reg_remove_locked(reg);
        errno = saved;
        return NULL;
    }
    return reg;
}

// Every begin() goes through here so the engine is guaranteed up first.
//
// This must happen at THIS level, not inside the backend: io_mu itself is
// created by io_start_locked, so a completion backend that locks it before the
// first start would be locking an uninitialized mutex. (That is exactly what
// it did at first - the POSIX path called io_ensure_started and the Windows
// path did not, which segfaulted on the first socket operation rather than
// failing cleanly.)
static int64_t iop_begin(int fd, void* buf, size_t n, int kind) {
    if (!io_ensure_started()) { errno = ENOSYS; return -1; }

#ifndef _WIN32
    // Readiness engines try the syscall first; most calls never block and so
    // never touch the table at all.
    int64_t rc = iop_syscall(fd, buf, n, kind);
    if (rc >= 0) return rc;
    if (!yoop_io_would_block(errno)) return -1;
#endif

    void* task = yoop_current_task();
    if (!task) {
        // Off a worker there is nothing to make runnable. Report would-block
        // so the caller falls back to its blocking path, exactly as
        // io_arm_common does for the readiness API.
        errno = EAGAIN;
        return -1;
    }

    yoop_mutex_lock(&io_mu);
    yoop_io_reg* reg = iop_arm_locked(fd, buf, n, kind, task, NULL);
    int saved = errno;
    yoop_mutex_unlock(&io_mu);
    if (!reg) { errno = saved; return -1; }
    return YOOP_IO_PENDING;
}

int64_t yoop_iop_recv_begin(int fd, void* buf, size_t n) {
    return iop_begin(fd, buf, n, YOOP_OP_RECV);
}

int64_t yoop_iop_send_begin(int fd, const void* buf, size_t n) {
    return iop_begin(fd, (void*)buf, n, YOOP_OP_SEND);
}

// Returns the accepted descriptor rather than a byte count.
int64_t yoop_iop_accept_begin(int fd) {
    return iop_begin(fd, NULL, 0, YOOP_OP_ACCEPT);
}

// The blocking, cancel- and deadline-aware flavor: parks the CALLING THREAD
// rather than suspending a task.
//
// This exists for the same reason the async form does. Waiting for readiness
// and then calling the syscall cannot work for accept on a completion port -
// there is no way to ask whether a LISTENING socket is readable. Issuing the
// operation and waiting for it is the formulation both platforms can
// express.
//
// `*out_code` receives YOOP_WAIT_READY / TIMEDOUT / CANCELLED. The return is
// the byte count (or accepted descriptor) when READY, else -1; errno is set
// only when the return is -1 and *out_code is READY.
int64_t yoop_iop_wait(int fd, void* buf, size_t n, int kind,
                      yoop_cancel_t* ct, uint64_t deadline_ns,
                      int32_t* out_code) {
    int32_t ignored;
    if (!out_code) out_code = &ignored;
    *out_code = YOOP_WAIT_READY;

    if (!io_ensure_started()) { errno = ENOSYS; return -1; }

#ifndef _WIN32
    int64_t rc = iop_syscall(fd, buf, n, kind);
    if (rc >= 0) return rc;
    if (!yoop_io_would_block(errno)) return -1;
#endif

    uint64_t deadline = yoop_cancel_effective_deadline(ct, deadline_ns);
    if (yoop_cancel_flagged(ct))                    { *out_code = YOOP_WAIT_CANCELLED; return -1; }
    if (deadline != 0 && yoop_now_ns() >= deadline) { *out_code = YOOP_WAIT_TIMEDOUT;  return -1; }

    yoop_io_wait_t w;
    yoop_park_token_init(&w.token);
    w.result_errno = 0;
    w.fired        = 0;

    yoop_mutex_lock(&io_mu);
    yoop_io_reg* reg = iop_arm_locked(fd, buf, n, kind, NULL, &w);
    int saved = errno;
    yoop_mutex_unlock(&io_mu);
    if (!reg) {
        yoop_park_token_destroy(&w.token);
        errno = saved;
        return -1;
    }

    yoop_cancel_waiter_t cw;
    int registered_with_token = 0;
    if (yoop_cancel_add_waiter(ct, &cw, &w.token) == 0) {
        registered_with_token = (ct != NULL);
    }

    int64_t result = -1;
    for (;;) {
        int timed_out = yoop_park_until(&w.token, deadline);

        yoop_mutex_lock(&io_mu);
        if (w.fired) {
            // Delivery already ran under io_mu and is provably done with `w`.
            // For an operation it leaves the entry in place so the result can
            // be collected here.
            yoop_io_reg* done = reg_find_seq_locked(reg->seq);
            if (done) {
                int64_t bytes = done->done_bytes;
                int     err   = done->done_errno;
                int     cdone = done->completed;
                (void)cdone;  // only consulted on the readiness engines
                reg_remove_locked(done);
                yoop_mutex_unlock(&io_mu);
                if (err != 0) { errno = err; result = -1; }
#ifndef _WIN32
                // A readiness engine only reported that the descriptor is
                // ready, so the syscall still has to happen - here, on the
                // waiter's own thread, rather than on the I/O thread.
                else if (!cdone) result = iop_syscall(fd, buf, n, kind);
#endif
                else result = bytes;
            } else {
                yoop_mutex_unlock(&io_mu);
                errno = w.result_errno ? w.result_errno : EIO;
                result = -1;
            }
            break;
        }
        if (yoop_cancel_flagged(ct)) {
            yoop_iob_deregister(reg);
            reg_remove_locked(reg);
            yoop_mutex_unlock(&io_mu);
            *out_code = YOOP_WAIT_CANCELLED;
            result = -1;
            break;
        }
        if (timed_out || (deadline != 0 && yoop_now_ns() >= deadline)) {
            yoop_iob_deregister(reg);
            reg_remove_locked(reg);
            yoop_mutex_unlock(&io_mu);
            *out_code = YOOP_WAIT_TIMEDOUT;
            result = -1;
            break;
        }
        yoop_mutex_unlock(&io_mu);
    }

    if (registered_with_token) yoop_cancel_remove_waiter(ct, &cw);
    yoop_park_token_destroy(&w.token);
    return result;
}

// Accept has no buffer, so it gets its own entry rather than making every call
// site invent a null one.
int64_t yoop_iop_accept_wait(int fd, yoop_cancel_t* ct, uint64_t deadline_ns,
                             int32_t* out_code) {
    return yoop_iop_wait(fd, NULL, 0, YOOP_OP_ACCEPT, ct, deadline_ns, out_code);
}

int64_t yoop_iop_end(void) {
    void* task = yoop_current_task();
    if (!task) { errno = EINVAL; return -1; }

    yoop_mutex_lock(&io_mu);
    yoop_io_reg* reg = reg_find_task_op_locked(task);
    if (!reg) {
        yoop_mutex_unlock(&io_mu);
        errno = EINVAL;
        return -1;
    }
    // Copy out everything needed before the entry dies.
    int     kind  = reg->kind;
    int     fd    = reg->fd;
    void*   buf   = reg->obuf;
    size_t  len   = reg->olen;
    int64_t bytes = reg->done_bytes;
    int     err   = reg->done_errno;
    int     done  = reg->completed;
    reg_remove_locked(reg);
    yoop_mutex_unlock(&io_mu);

    if (err != 0) { errno = err; return -1; }
    // A completion backend already moved the bytes; a readiness backend only
    // told us the descriptor is ready, so the syscall still has to happen -
    // and it happens HERE, on the resumed task's own thread, rather than on
    // the I/O thread.
    if (done) return bytes;

#ifdef _WIN32
    (void)fd; (void)buf; (void)len; (void)kind;
    errno = EIO;   // unreachable: the IOCP backend always reports completed
    return -1;
#else
    return iop_syscall(fd, buf, len, kind);
#endif
}
