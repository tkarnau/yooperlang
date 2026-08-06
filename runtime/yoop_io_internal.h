// Internal seam between the I/O core and its per-platform backends.
//
// NOT a public header - nothing outside runtime/yoop_io*.c includes this. The
// public surface stays in yoop_runtime.h.
//
// ---------------------------------------------------------------------------
// Why the platforms are split rather than abstracted together
// ---------------------------------------------------------------------------
//
// This mirrors Go's netpoll layout (netpoll_kqueue.go / netpoll_epoll.go /
// netpoll_windows.go, plus internal/poll's fd_unix.go / fd_windows.go), and
// for the same reason: kqueue and epoll are READINESS engines ("this
// descriptor is now readable, go call recv") while IOCP is a COMPLETION port
// ("the recv you started has finished, here are the bytes"). Those are not two
// spellings of one idea, and the previous attempt to make them one - a WSAPoll
// backend pretending to be epoll - bought uniformity at the cost of never
// using the platform's actual I/O engine.
//
// The load-bearing discovery that forced this split: **write-readiness cannot
// be expressed on IOCP.** A zero-byte WSASend completes immediately even when
// the socket's send buffer is full, so there is no way to ask "is this
// writable yet". Completion-based I/O has no writability question - you issue
// the send and it completes when there is room. Any design that puts
// "wait until writable" in the shared contract is therefore unimplementable on
// Windows, no matter how the code is arranged.
//
// So the shared contract sits one level up, at the OPERATION:
//
//     yoop_io_recv_begin / _end        "read some bytes"
//     yoop_io_send_begin / _end        "write some bytes"
//     yoop_io_accept_begin / _end      "take the next connection"
//
// POSIX implements those as "try the nonblocking syscall; on EAGAIN arm a
// readiness interest and report PENDING; retry on resume". Windows implements
// them as "issue the overlapped operation and report PENDING; the completion
// carries the byte count". Both present the same three outcomes to the caller,
// and neither has to pretend to be the other.
//
// ---------------------------------------------------------------------------
// Two contracts live here
// ---------------------------------------------------------------------------
//
//   1. The EVENT ENGINE (yoop_iob_*): start/stop the platform's poller, arm an
//      interest, and call back into the core when something completes. One
//      implementation per platform.
//
//   2. The OPERATION LAYER (yoop_iop_*): the begin/end pairs above. One
//      implementation for POSIX (shared by kqueue and epoll, since it is only
//      syscalls plus the engine's arm primitive) and one for Windows.
//
// The core (yoop_io.c) owns everything neither of those needs to vary: the
// registration table, the seq-numbered identity scheme, the fired-under-io_mu
// abandon handshake, the park/suspend bookkeeping, and the public entry
// points.

#ifndef YOOP_IO_INTERNAL_H
#define YOOP_IO_INTERNAL_H

#include "yoop_runtime.h"
#include "yoop_platform.h"

#include <stdint.h>

// ----- backend selection ---------------------------------------------------

#ifdef _WIN32
  #define YOOP_IO_IOCP 1
#elif defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
  #define YOOP_IO_KQUEUE 1
#elif defined(__linux__)
  #define YOOP_IO_EPOLL 1
#else
  #error "Unsupported platform - add a yoop_io_<backend>.c"
#endif

// ----- outcome codes shared by the operation layer -------------------------
//
// Deliberately distinct from the YOOP_WAIT_* codes: those describe why a WAIT
// stopped, these describe what happened to an OPERATION. A begin() returns a
// byte count (>= 0) when it finished without blocking, YOOP_IO_PENDING when
// the caller must suspend and then call end(), or -1 with errno set.
#define YOOP_IO_PENDING (-2)

// ----- per-wait state ------------------------------------------------------
//
// Lives on the caller's stack for a blocking wait. The engine only ever
// reaches it through the registration table, and only while holding io_mu -
// which is what lets a waiter abandon (on a timeout or a cancellation) and
// reclaim its frame without racing the I/O thread.
typedef struct yoop_io_wait {
    yoop_park_token_t token;
    int               result_errno; // 0 on ready, else errno
    int               fired;        // engine delivered a wake (io_mu)
} yoop_io_wait_t;

// One live registration.
//
// Identified by a monotonically increasing sequence number rather than by the
// address of the wait struct: a stack frame can be reused by the next waiter
// at the very same address, and a stale event carrying that address would then
// be misdelivered to an unrelated wait. Sequence numbers are never reused, so
// a stale event simply fails to find its entry and is dropped.
typedef struct yoop_io_reg {
    uint64_t            seq;
    int                 fd;
    int                 want_write;
    // Exactly one of these is set. `w` means a thread is PARKED on this fd
    // (the blocking flavor): delivery unparks it. `task` means a coroutine
    // ARMED it and then suspended (the async flavor): delivery pushes the task
    // back onto the run queue instead, so no thread was tied up waiting.
    yoop_io_wait_t*     w;
    void*               task;
    // Completion result, written by the engine before delivery. Only the
    // completion-based backend fills these - a readiness backend leaves them
    // at zero and the operation layer retries the syscall on resume instead.
    int64_t             done_bytes;
    int                 done_errno;
    int                 completed;   // 1 once done_bytes/errno are meaningful
    void*               op;          // backend-owned per-op state (OVERLAPPED)

    // Operation-layer state. `kind` is YOOP_OP_NONE for a plain readiness
    // registration, in which case delivery drops the entry immediately. For an
    // operation the entry SURVIVES delivery so the resumed task can collect
    // its result in yoop_iop_end, which is what finally frees it. `obuf`/`olen`
    // are what a readiness backend retries with on resume; a completion
    // backend has already used them and reads done_bytes instead.
    int                 kind;        // yoop_op_kind
    void*               obuf;
    size_t              olen;

    struct yoop_io_reg* next;
} yoop_io_reg;

// ----- core services, callable from a backend ------------------------------

// The table lock. Backends take it only where noted below.
extern yoop_mutex_t yoop_io_mu;

// Deliver one event to whichever registration carries `seq`, then remove it.
// Takes io_mu itself; must NOT be called with it already held.
//
// `err` is 0 for success. `bytes` is meaningful only for a completion-based
// backend (pass 0 elsewhere); `completed` says whether it is.
void yoop_iob_deliver(uint64_t seq, int err, int64_t bytes, int completed);

// Look up the fd a seq belongs to, or -1. Takes io_mu. Used by backends that
// learn only the seq from an event but need the fd to query the error.
int yoop_iob_fd_for_seq(uint64_t seq);

// Non-zero once yoop_io_shutdown has asked the loop to exit. Takes io_mu.
int yoop_iob_stopping(void);

// Walk the live registrations under io_mu, calling `fn` for each. Exists for
// engines that must rebuild an interest set from scratch each pass; the
// kernel-set engines (kqueue/epoll/IOCP) never need it.
void yoop_iob_for_each(void (*fn)(const yoop_io_reg* r, void* ctx), void* ctx);

// Allocate and link an operation registration. CALLER MUST ALREADY HOLD io_mu.
// Returns NULL on allocation failure or if this (fd, direction) is taken.
// Exists so a completion backend can build the registration and issue the
// kernel call under one lock acquisition - it must know the seq before the
// call, because the OVERLAPPED it hands the kernel carries it.
yoop_io_reg* yoop_iob_alloc_reg(int fd, int want_write, void* task, int kind,
                                void* buf, size_t len, void* op);

// Unlink and free a registration the caller just allocated and could not use.
// CALLER MUST ALREADY HOLD io_mu.
void yoop_iob_free_reg(yoop_io_reg* reg);

// ----- the event-engine contract (one impl per platform) -------------------

// Bring the engine up. Called with the init lock held, exactly once per
// start/shutdown cycle. Returns 0, or -1 leaving nothing allocated.
int  yoop_iob_init(void);

// Tear it down. Called with the init lock held, after the I/O thread joined.
void yoop_iob_teardown(void);

// Make the I/O thread return from its blocking wait. Safe to call with io_mu
// held, and safe to call concurrently.
void yoop_iob_wake(void);

// The I/O thread body. Loops until yoop_iob_stopping() is observed after a
// wake, calling yoop_iob_deliver for each event.
void yoop_iob_loop(void);

// Arm a one-shot interest in `fd`. Called with io_mu held, after the caller
// has already linked `reg` into the table (so the engine may reach it).
// Returns 0, or -1 with errno set.
//
// A completion-based engine ignores `want_write` for the readiness sense and
// instead uses whatever `reg->op` was prepared by the operation layer.
int  yoop_iob_register(yoop_io_reg* reg);

// Drop a still-armed interest. Called with io_mu held. Failures are ignored on
// purpose: the fd may already be closed, or the event may have been consumed
// one-shot first. A completion engine cancels the pending operation here.
void yoop_iob_deregister(yoop_io_reg* reg);

// Tell the engine a descriptor is being closed, so it can drop any per-socket
// state it holds. A no-op on the readiness engines - they keep none - but
// REQUIRED on IOCP, which caches which sockets are bound to the completion
// port and would otherwise mistake a recycled handle value for one that is
// already bound. See the implementation for why that manifests as a hang.
void yoop_iob_forget(int fd);

// Note there is only ONE backend registration entry, not one per flavor. A
// registration carries either a parked thread (`w`) or a suspended task
// (`task`), and either a plain readiness interest (kind == YOOP_OP_NONE) or a
// real operation - but the engine does not care which: it arms or issues, and
// delivery finds the registration by seq either way. Keeping that single entry
// is what lets the blocking and async paths share one backend.

// ----- the operation contract ----------------------------------------------
//
// begin() either finishes inline (returns >= 0 bytes), starts something the
// engine will complete (returns YOOP_IO_PENDING, having registered against the
// CURRENT TASK), or fails (-1, errno set). After a PENDING begin the caller
// suspends its coroutine; on resume it calls yoop_iop_end() to collect the
// result. end() returns bytes (>= 0) or -1 with errno set, and consumes the
// registration.
//
// **The buffer must stay valid from begin() until end() returns.** On Windows
// the kernel writes into it directly while the task is suspended, so a caller
// whose buffer dies at the suspend point corrupts memory. This is the one rule
// the operation API adds over the readiness API, and it is why the yoop-side
// callers pass a buffer owned by the connection rather than a local temp.
//
// Accept is an operation too, and NOT by choice - this one is a trap worth
// recording. It is tempting to leave accept on the readiness path, since
// "readable listening socket" means "a connection is pending" on POSIX. But
// the IOCP backend expresses read-readiness with a zero-byte WSARecv, and
// WSARecv on a LISTENING socket fails outright with WSAENOTCONN: a listener is
// not a connection and has nothing to receive. There is no probe for it.
// AcceptEx is the only way to wait for an inbound connection on a completion
// port, so accept has to be an operation on Windows, and therefore in the
// shared contract.
//
// accept_begin returns the new descriptor (>= 0) rather than a byte count.
int64_t yoop_iop_recv_begin(int fd, void* buf, size_t n);
int64_t yoop_iop_send_begin(int fd, const void* buf, size_t n);
int64_t yoop_iop_accept_begin(int fd);
int64_t yoop_iop_end(void);

// Which syscall a pending operation represents. A readiness backend needs this
// to know what to retry on resume; a completion backend needs it to interpret
// the completion. YOOP_OP_NONE marks a plain readiness registration, which the
// operation layer never owns.
typedef enum {
    YOOP_OP_NONE = 0,
    YOOP_OP_RECV,
    YOOP_OP_SEND,
    YOOP_OP_ACCEPT,
} yoop_op_kind;

#endif // YOOP_IO_INTERNAL_H
