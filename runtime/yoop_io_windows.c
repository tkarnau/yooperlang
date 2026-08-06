// IOCP event engine (Windows).
//
// One of three interchangeable implementations of the yoop_iob_* contract in
// yoop_io_internal.h. Unlike its two siblings this file is NOT a readiness
// engine: an I/O completion port reports that an operation you already started
// has finished, not that a descriptor is now ready to be operated on. That
// difference is why the platforms are split rather than abstracted together -
// see the header for the full argument, including the fact that write
// readiness is not expressible on IOCP at all.
//
// Structure:
//
//   * One completion port, one I/O thread calling GetQueuedCompletionStatusEx.
//   * Every registration carries a per-operation `win_op` holding the
//     OVERLAPPED the kernel writes through. The OVERLAPPED address is the
//     completion's identity, and it is heap-owned by the op rather than living
//     on a parking thread's stack - a completion can arrive after that stack
//     frame is gone.
//   * The wakeup is PostQueuedCompletionStatus with a reserved key, so there
//     is no self-pipe here at all. The POSIX engines need a real descriptor in
//     their interest set; a completion port can simply be posted to.
//
// The seq-numbered identity scheme still governs delivery: the op carries the
// seq, and the core drops any completion whose registration is gone (the
// waiter abandoned on a deadline or a cancellation). What IOCP adds over the
// POSIX engines is that a cancelled operation must also be stopped in the
// kernel - CancelIoEx - because the kernel is holding a pointer to our buffer.

#include "yoop_io_internal.h"

#ifdef YOOP_IO_IOCP

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// AcceptEx, LPFN_ACCEPTEX and WSAID_ACCEPTEX live here rather than in
// <winsock2.h>; yoop_platform.h has already pulled winsock2 in ahead of us.
#include <mswsock.h>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "mswsock.lib")

// Reserved completion key for a wakeup post. Real registrations use their
// socket as the key, and no socket handle is all-ones (that value is
// INVALID_SOCKET), so this cannot collide. The key only distinguishes a wakeup
// from an I/O completion; the seq inside the op remains the authoritative
// identity for delivery.
#define WIN_WAKE_KEY ((ULONG_PTR)~(ULONG_PTR)0)

// What kind of operation an OVERLAPPED belongs to. The completion only reports
// a byte count, so the kind is what tells the operation layer how to interpret
// it (an accept's "bytes" is meaningless; its result is the new socket).
typedef enum {
    WIN_OP_READ_READY = 0,  // zero-byte WSARecv used to emulate read readiness
    WIN_OP_WRITE_READY,     // never issued; see yoop_iob_register
    WIN_OP_RECV,
    WIN_OP_SEND,
    WIN_OP_ACCEPT,
} win_op_kind;

typedef struct win_op {
    OVERLAPPED  ov;       // MUST be first: the completion hands back its address
    uint64_t    seq;
    win_op_kind kind;
    SOCKET      fd;
    WSABUF      buf;
    SOCKET      accepted; // WIN_OP_ACCEPT: the socket handed to AcceptEx
    char        addr_buf[(sizeof(struct sockaddr_in) + 16) * 2]; // AcceptEx needs this
} win_op;

static HANDLE iocp = NULL;

// AcceptEx is not exported from ws2_32 as an ordinary symbol - it has to be
// looked up per-provider through WSAIoctl. One lookup serves the process.
static LPFN_ACCEPTEX accept_ex = NULL;

static int load_accept_ex(SOCKET s) {
    if (accept_ex) return 0;
    GUID  guid  = WSAID_ACCEPTEX;
    DWORD nbytes = 0;
    if (WSAIoctl(s, SIO_GET_EXTENSION_FUNCTION_POINTER,
                 &guid, sizeof(guid),
                 &accept_ex, sizeof(accept_ex),
                 &nbytes, NULL, NULL) == SOCKET_ERROR) {
        accept_ex = NULL;
        errno = yoop_wsa_to_errno(WSAGetLastError());
        return -1;
    }
    return 0;
}

// Sockets already associated with the port. Associating one twice fails, and
// there is no API to ask "is this associated", so the association is tracked
// here. A small linear set is fine: it holds one entry per live socket, and
// the server workloads this runtime targets keep that in the tens.
typedef struct assoc_node {
    SOCKET             s;
    struct assoc_node* next;
} assoc_node;
static assoc_node* assoc_head = NULL;   // guarded by io_mu (callers hold it)

static int assoc_known(SOCKET s) {
    for (assoc_node* n = assoc_head; n; n = n->next) {
        if (n->s == s) return 1;
    }
    return 0;
}

static void assoc_add(SOCKET s) {
    assoc_node* n = (assoc_node*)malloc(sizeof(assoc_node));
    if (!n) return;  // worst case we try to associate again and it no-ops
    n->s = s;
    n->next = assoc_head;
    assoc_head = n;
}

static void assoc_clear(void) {
    while (assoc_head) {
        assoc_node* n = assoc_head;
        assoc_head = n->next;
        free(n);
    }
}

// Drop a socket from the association set as it is closed.
//
// This is NOT bookkeeping hygiene - it is required for correctness, and its
// absence is a hang rather than a leak. Windows recycles socket handle VALUES
// aggressively, so the descriptor a later accept() returns is frequently the
// same integer as one already closed. If the stale entry is still in this set,
// ensure_associated decides the new socket is already bound to the port and
// skips CreateIoCompletionPort - and operations on a socket that was never
// associated never deliver a completion, so the task waits forever.
//
// Symptom when this was missing: the first connections of a server worked and
// then it wedged, which reads like a race and is not one.
void yoop_iob_forget(int fd) {
    SOCKET s = (SOCKET)fd;
    yoop_mutex_lock(&yoop_io_mu);
    assoc_node** link = &assoc_head;
    while (*link) {
        if ((*link)->s == s) {
            assoc_node* dead = *link;
            *link = dead->next;
            free(dead);
            break;
        }
        link = &(*link)->next;
    }
    yoop_mutex_unlock(&yoop_io_mu);
}

// Bind a socket to the completion port, once. Callers hold io_mu.
static int ensure_associated(SOCKET s) {
    if (assoc_known(s)) return 0;
    if (CreateIoCompletionPort((HANDLE)s, iocp, (ULONG_PTR)s, 0) == NULL) {
        errno = yoop_wsa_to_errno(WSAGetLastError());
        return -1;
    }
    assoc_add(s);
    return 0;
}

int yoop_iob_init(void) {
    yoop_net_startup();
    iocp = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 0);
    if (iocp == NULL) {
        errno = EIO;
        return -1;
    }
    return 0;
}

void yoop_iob_teardown(void) {
    if (iocp) { CloseHandle(iocp); iocp = NULL; }
    assoc_clear();
}

void yoop_iob_wake(void) {
    if (!iocp) return;
    // No self-pipe needed: a completion port can be posted to directly. This
    // is the one place the Windows engine is simpler than its POSIX siblings.
    PostQueuedCompletionStatus(iocp, 0, WIN_WAKE_KEY, NULL);
}

// Issue the real overlapped operation a registration describes.
//
// Callers hold io_mu and have already linked `reg` into the table, so the seq
// the OVERLAPPED must carry is known. Returns 0 once the operation is in
// flight (or completed inline - its packet is queued either way), -1 with
// errno set otherwise.
static int start_operation(yoop_io_reg* reg) {
    SOCKET s = (SOCKET)reg->fd;

    win_op* op = (win_op*)calloc(1, sizeof(win_op));
    if (!op) { errno = ENOMEM; return -1; }
    op->seq     = reg->seq;
    op->fd      = s;
    op->buf.buf = (CHAR*)reg->obuf;
    // WSABUF lengths are ULONG. A short transfer is already part of the
    // contract, so clamping is safe - callers loop.
    op->buf.len = reg->olen > 0x7FFFFFFF ? 0x7FFFFFFF : (ULONG)reg->olen;
    op->kind = (reg->kind == YOOP_OP_SEND)   ? WIN_OP_SEND
             : (reg->kind == YOOP_OP_ACCEPT) ? WIN_OP_ACCEPT
                                             : WIN_OP_RECV;

    // An accept needs its result socket created UP FRONT: AcceptEx does not
    // return one the way accept() does, it fills one the caller supplies.
    if (reg->kind == YOOP_OP_ACCEPT) {
        if (load_accept_ex(s) != 0) { int e = errno; free(op); errno = e; return -1; }
        op->accepted = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (op->accepted == INVALID_SOCKET) {
            int w = WSAGetLastError();
            free(op);
            errno = yoop_wsa_to_errno(w);
            return -1;
        }
    }

    DWORD got = 0, flags = 0;
    int rc;
    if (reg->kind == YOOP_OP_ACCEPT) {
        // Zero receive length: take the connection only, do not wait for the
        // client's first bytes. The address buffer must hold both endpoints
        // with 16 bytes of slack each, which is what addr_buf is sized for.
        DWORD addr_len = (DWORD)(sizeof(struct sockaddr_in) + 16);
        rc = accept_ex(s, op->accepted, op->addr_buf, 0,
                       addr_len, addr_len, &got, &op->ov) ? 0 : SOCKET_ERROR;
    } else if (reg->kind == YOOP_OP_SEND) {
        rc = WSASend(s, &op->buf, 1, &got, 0, &op->ov, NULL);
    } else {
        rc = WSARecv(s, &op->buf, 1, &got, &flags, &op->ov, NULL);
    }

    if (rc == 0 || WSAGetLastError() == WSA_IO_PENDING) {
        // Even an inline completion still queues its packet (we do not set
        // FILE_SKIP_COMPLETION_PORT_ON_SUCCESS), so both cases look the same
        // to the caller and there is exactly one delivery path. Uniformity
        // here is worth more than saving one suspend.
        reg->op = op;
        return 0;
    }

    int w = WSAGetLastError();
    if (op->accepted != 0 && op->accepted != INVALID_SOCKET) closesocket(op->accepted);
    free(op);
    errno = yoop_wsa_to_errno(w);
    return -1;
}

int yoop_iob_register(yoop_io_reg* reg) {
    SOCKET s = (SOCKET)reg->fd;
    if (ensure_associated(s) != 0) return -1;

    // An operation registration issues the real thing. This is the single
    // backend entry for both flavors the core builds - a task that will
    // suspend, and a thread that will park - because from here the two are
    // indistinguishable: an OVERLAPPED is in flight and its completion will
    // find the registration by seq.
    if (reg->kind != YOOP_OP_NONE) return start_operation(reg);

    // Write readiness has no meaning on a completion port. A zero-byte
    // WSASend completes immediately whether or not the send buffer has room,
    // so there is nothing to wait for and no way to ask. Rather than pretend,
    // the registration is completed inline as "ready" and the caller proceeds
    // to its send - which is the correct Windows shape anyway, because a send
    // that cannot proceed pends as its own operation via the operation layer.
    //
    // This is the seam the operation API exists to close: std/net's send path
    // should issue yoop_iop_send_begin rather than ask about writability.
    if (reg->want_write) {
        // Delivered from the I/O thread rather than inline: the caller holds
        // io_mu and yoop_iob_deliver takes it, so completing here would
        // self-deadlock. Posting a synthetic completion routes it through the
        // one delivery path like everything else.
        win_op* op = (win_op*)calloc(1, sizeof(win_op));
        if (!op) { errno = ENOMEM; return -1; }
        op->seq  = reg->seq;
        op->kind = WIN_OP_WRITE_READY;
        op->fd   = s;
        reg->op  = op;
        if (!PostQueuedCompletionStatus(iocp, 0, (ULONG_PTR)s, &op->ov)) {
            free(op);
            reg->op = NULL;
            errno = yoop_wsa_to_errno(WSAGetLastError());
            return -1;
        }
        return 0;
    }

    // Read readiness DOES map cleanly: a zero-byte WSARecv completes when data
    // is available to be read, without consuming any of it.
    win_op* op = (win_op*)calloc(1, sizeof(win_op));
    if (!op) { errno = ENOMEM; return -1; }
    op->seq      = reg->seq;
    op->kind     = WIN_OP_READ_READY;
    op->fd       = s;
    op->buf.len  = 0;
    op->buf.buf  = NULL;
    reg->op      = op;

    DWORD flags = 0;
    DWORD got   = 0;
    int rc = WSARecv(s, &op->buf, 1, &got, &flags, &op->ov, NULL);
    if (rc == 0) {
        // Completed inline. The completion packet is still queued (we do not
        // set FILE_SKIP_COMPLETION_PORT_ON_SUCCESS), so let the loop deliver
        // it and keep exactly one delivery path.
        return 0;
    }
    if (WSAGetLastError() == WSA_IO_PENDING) return 0;

    free(op);
    reg->op = NULL;
    errno = yoop_wsa_to_errno(WSAGetLastError());
    return -1;
}


void yoop_iob_deregister(yoop_io_reg* reg) {
    win_op* op = (win_op*)reg->op;
    if (!op) return;
    // The kernel may still be holding this OVERLAPPED (and, for a real recv,
    // the caller's buffer). CancelIoEx stops it; the cancelled completion
    // still arrives, finds no registration, and frees the op there. This is
    // the step the POSIX engines do not need - they never handed the kernel a
    // pointer into our memory.
    CancelIoEx((HANDLE)op->fd, &op->ov);
    reg->op = NULL;
    // Ownership passes to the loop, which frees it when the cancelled
    // completion lands.
}

void yoop_iob_loop(void) {
    OVERLAPPED_ENTRY entries[64];
    for (;;) {
        ULONG n = 0;
        BOOL ok = GetQueuedCompletionStatusEx(iocp, entries, 64, &n, INFINITE, FALSE);
        if (!ok) {
            DWORD e = GetLastError();
            if (e == WAIT_TIMEOUT) continue;
            break;  // port closed, or something fatal
        }
        int should_exit = 0;
        for (ULONG i = 0; i < n; i++) {
            OVERLAPPED_ENTRY* en = &entries[i];
            if (en->lpCompletionKey == WIN_WAKE_KEY && en->lpOverlapped == NULL) {
                should_exit = yoop_iob_stopping();
                continue;
            }
            if (en->lpOverlapped == NULL) continue;

            win_op* op = (win_op*)en->lpOverlapped;  // ov is the first member
            int err = 0;
            int64_t bytes = (int64_t)en->dwNumberOfBytesTransferred;

            // An OVERLAPPED whose internal status is non-zero failed. The
            // status is an NTSTATUS; the socket's SO_ERROR is not meaningful
            // for a completed-with-error overlapped op, so translate from the
            // overlapped result instead.
            DWORD transferred = 0, flags = 0;
            if (!WSAGetOverlappedResult(op->fd, &op->ov, &transferred, FALSE, &flags)) {
                int w = WSAGetLastError();
                if (w == WSA_OPERATION_ABORTED) {
                    // Cancelled by yoop_iob_deregister. Its registration is
                    // already gone; nothing to deliver, just reclaim the op.
                    free(op);
                    continue;
                }
                err = yoop_wsa_to_errno(w);
            } else {
                bytes = (int64_t)transferred;
            }

            switch (op->kind) {
                case WIN_OP_READ_READY:
                case WIN_OP_WRITE_READY:
                    // Readiness flavors carry no byte count of interest.
                    yoop_iob_deliver(op->seq, err, 0, 0);
                    break;
                case WIN_OP_ACCEPT:
                    // The completion's byte count is address data, not payload;
                    // the result is the socket AcceptEx was handed.
                    if (err == 0) {
                        // Until SO_UPDATE_ACCEPT_CONTEXT is applied, the
                        // accepted socket inherits nothing from the listener
                        // and getpeername/shutdown on it fail. This is the
                        // step accept() does implicitly and AcceptEx does not.
                        SOCKET ls = op->fd;
                        setsockopt(op->accepted, SOL_SOCKET,
                                   SO_UPDATE_ACCEPT_CONTEXT,
                                   (const char*)&ls, (int)sizeof(ls));
                        // The rest of the runtime drives sockets non-blocking.
                        yoop_io_set_nonblocking((int)op->accepted);
                        yoop_iob_deliver(op->seq, 0, (int64_t)op->accepted, 1);
                    } else {
                        // Nobody will collect it, so it would leak otherwise.
                        if (op->accepted != INVALID_SOCKET) closesocket(op->accepted);
                        yoop_iob_deliver(op->seq, err, -1, 1);
                    }
                    break;
                case WIN_OP_RECV:
                case WIN_OP_SEND:
                default:
                    yoop_iob_deliver(op->seq, err, bytes, 1);
                    break;
            }
            free(op);
        }
        if (should_exit) break;
    }
}

#endif // YOOP_IO_IOCP
