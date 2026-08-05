# Cancellation tokens, I/O deadlines, and multiplexer fixes

> Closes the seams between the pieces that landed separately: the 8.F.2
> multiplexer, the 8.F.3 timers, the 10.F.1 deadline wait, and the
> 10.F.2.A external cancel. Each works on its own; none of them compose.

## The gaps this closes

### 1. I/O waits are uninterruptible

`yoop_io_wait_readable(fd)` / `wait_writable(fd)` park forever. There is
no deadline, no cancel, no abandon. Every `std/net` operation goes
through them (`ffi_accept`, `ffi_recv`, `ffi_send_all`), so a server
parked on `accept` or a client reading from a peer that stopped talking
hangs that thread for the life of the process. There is no timeout
anywhere in `std/net` or `std/http`.

### 2. Two waiters on one fd orphan each other

The 8.F.2 plan says a second concurrent wait on an fd returns `EAGAIN`.
The code does not do that. On epoll the `EPOLL_CTL_ADD` fails `EEXIST`
and the fallback `EPOLL_CTL_MOD` overwrites the first waiter's
`data.ptr`; on kqueue `EV_SET` on the same `(ident, filter)` replaces
`udata` the same way. The first waiter is never woken and parks
forever.

### 3. Cancellation only cancels the wait, not the work

`cancel(h)` sets a byte in the task handle's prefix. The task body
cannot see it, a parked I/O wait cannot see it, and bare `wait` ignores
it. It is strictly "abandon the wait." There is also no way to cancel
anything that is not a `Task<T>`: a plain function doing I/O, a call
chain that wants a propagated deadline, or a request scope derived from
a server scope.

### 4. Deadlines ride a wall clock

`yoop_now_ns` reads `CLOCK_REALTIME` on both platforms (the header
claims `CLOCK_MONOTONIC` on Linux). An NTP step moves every in-flight
deadline. `queue_cv` uses default condattr, so it agrees with
`now_ns` - both are wrong together.

### 5. Smaller multiplexer bugs

- epoll reports `EPOLLERR`/`EPOLLHUP` as a hardcoded `EIO` instead of
  reading the real error out of `SO_ERROR`.
- `io_once` (a `pthread_once_t`) never resets, so an init after a
  shutdown leaves the multiplexer permanently dead.

## The shape

A **cancellation token** is an ordinary refcounted value, created and
passed explicitly. No compiler change, no synthesized parameter: it
works in plain functions as well as task bodies, and it composes down a
call chain the way any other argument does.

    let ct: CancelToken = cancel.withTimeoutMs(5000);
    let r: Result<usize, string> = readAll(ref ct, ref stream);
    cancel.request(ref ct);        // from any thread

A token carries three things: a cancelled flag, an optional deadline,
and a list of parked threads to wake. Anything that blocks takes an
optional token plus an optional deadline and returns a three-way
outcome (ready / timed out / cancelled) instead of a bool.

The **deadline is part of the token**, not a separate parameter
everywhere, so "this request gets 5 seconds total" is expressed once at
the top and every nested I/O op inherits it.

## Layers

### Runtime C

`runtime/yoop_cancel.c` (new TU) - the token itself:

    yoop_cancel_t* yoop_cancel_new(void);
    yoop_cancel_t* yoop_cancel_new_deadline(uint64_t deadline_ns);
    void     yoop_cancel_retain(yoop_cancel_t*);
    void     yoop_cancel_release(yoop_cancel_t*);
    void     yoop_cancel_request(yoop_cancel_t*);
    int      yoop_cancel_requested(yoop_cancel_t*);
    uint64_t yoop_cancel_deadline_ns(yoop_cancel_t*);
    void     yoop_cancel_set_deadline_ns(yoop_cancel_t*, uint64_t);
    int      yoop_cancel_link(yoop_cancel_t* child, yoop_cancel_t* parent);
    int      yoop_cancel_sleep_ns(yoop_cancel_t*, uint64_t ns);
    int      yoop_cancel_wait(yoop_cancel_t*, uint64_t deadline_ns);

Plus an internal waiter-registration pair used by the multiplexer:
`yoop_cancel_add_waiter` / `yoop_cancel_remove_waiter`, which splice a
park token onto the token's wake list.

`runtime/yoop_runtime.c`:

- `yoop_park_until(token, deadline_ns)` - the timed sibling of
  `yoop_park`. Returns 0 woken, 1 deadline elapsed.
- One shared `cv_wait_until` helper, used by every timed wait in the
  runtime. Linux gets `CLOCK_MONOTONIC` condattrs and an absolute
  timespec; macOS gets `pthread_cond_timedwait_relative_np` (which
  sidesteps the missing `pthread_condattr_setclock`); Windows keeps its
  relative-ms `SleepConditionVariableCS`.
- `yoop_now_ns` becomes monotonic on every platform. `yoop_wall_ns` is
  added for anyone who genuinely wants a timestamp.

### Runtime multiplexer

`runtime/yoop_io.c`:

    // 0 ready, 1 deadline elapsed, 2 cancelled, -1 error (errno set)
    int yoop_io_wait_readable_ex(int fd, yoop_cancel_t* ct, uint64_t deadline_ns);
    int yoop_io_wait_writable_ex(int fd, yoop_cancel_t* ct, uint64_t deadline_ns);

The existing two-arg entry points stay, delegating with a null token
and no deadline, so nothing that links against them changes.

**The abandon handshake is the load-bearing part.** The per-wait struct
lives on the caller's stack, so if a wait is abandoned (timeout or
cancel) the multiplexer must be proven done with it before the frame
goes away. A registration table guarded by `io_mu` arbitrates:

- The multiplexer sets `fired = 1` and calls `unpark` **while holding
  `io_mu`**.
- An abandoning parker takes `io_mu` and checks `fired`. If it is set,
  the multiplexer is already done touching the struct and the parker
  reports ready. If it is clear, the parker deregisters from
  kqueue/epoll and removes the table entry, so the multiplexer can
  never reach the struct again.

Lock order is `io_mu` -> park-token mutex, never the reverse.

The same table is what fixes gap 2: an fd already registered for a
direction gets `EAGAIN` instead of silently stomping the first waiter.

### std/core

`std/core/cancel/ffi.yoop` - the one `import.unsafe` module, holding the
`RawCancel` envelope (the same trick `std/db/sqlite/ffi.yoop` uses to
keep `unsafe_ptr` out of the safe surface).

`std/core/cancel/token.yoop` - the safe API:

    CancelToken implements Disposable

    // construction
    cancel.newToken()                       -> CancelToken
    cancel.none()                           -> CancelToken   // no-op token
    cancel.withTimeoutMs(ms)                -> CancelToken
    cancel.withDeadlineNs(ns)               -> CancelToken
    cancel.childOf(ref parent)              -> CancelToken
    cancel.childWithTimeoutMs(ref p, ms)    -> CancelToken
    cancel.share(ref t)                     -> CancelToken   // 2nd owning handle

    // state
    cancel.request(ref t)
    cancel.isCancelled(ref t)               -> bool   // flag OR deadline
    cancel.isFlagged(ref t)                 -> bool   // explicit cancel only
    cancel.isNone(ref t)                    -> bool   // structural
    cancel.deadlineNs(ref t)                -> uint64
    cancel.setDeadlineNs(ref t, ns)
    cancel.setTimeoutMs(ref t, ms)
    cancel.remainingMs(ref t)               -> uint64

    // blocking
    cancel.sleepMs(ref t, ms)               -> WaitOutcome
    cancel.awaitCancel(ref t, timeoutMs)    -> WaitOutcome

    // clock
    cancel.nowNs()                          -> uint64   // monotonic
    cancel.deadlineFromMs(ms)               -> uint64

`WaitOutcome` is the three-way variant (`Ready` / `TimedOut` /
`Cancelled`) every blocking op returns.

`none()` is worth calling out: it is a token with a null handle, so
every operation on it is a no-op and every predicate reads false. A call
chain that does not care about cancellation passes it and needs no
`Option<CancelToken>` plumbing.

### std/net

`socket_ffi.yoop` gains `ffiAcceptCt` / `ffiRecvCt` / `ffiSendAllCt`,
taking a `RawCancel` plus a deadline and returning a plain
`{ code, n, error }` struct. The existing entry points are untouched.

`tcp.yoop` exposes both flavors. Explicit, per call:

    tcpAcceptCt(ref listener, ref ct)          -> AcceptOutcome
    tcpAcceptTimeoutMs(ref listener, ms)       -> AcceptOutcome
    tcpReadCt(ref s, ref buf, ref ct)          -> IoOutcome
    tcpReadTimeoutMs(ref s, ref buf, ms)       -> IoOutcome
    tcpWriteAllCt(ref s, ref buf, ref ct)      -> IoOutcome
    tcpWriteAllTimeoutMs(ref s, ref buf, ms)   -> IoOutcome

And ambient, on the stream, rather than changing the
`Readable`/`Writable` trait signatures - the `SO_RCVTIMEO` shape, so
`read`/`write` honor a timeout with zero trait churn and all of
`std/http` inherits it:

    tcpSetTimeoutMs(ref stream, ms)
    tcpSetToken(ref stream, ref ct)

`IoOutcome.TimedOut` / `.Cancelled` carry the byte count that DID
transfer, because a half-written message is exactly what the caller
needs to know before deciding whether the connection is still usable.

The trait methods have to squeeze three outcomes into
`Result<c_ssize_t, string>`, so a timeout arrives as `Err "timed out"`.
That is lossy on purpose; callers who must distinguish use the explicit
forms above.

## Coverage

C-level, in `runtime/tests/` (run by `run_tests.sh` and by
`src/runtimeC.test.js`, so `npm test` covers them):

- `cancel_token.c` - flags vs. deadlines, the null token, effective
  deadline arithmetic, parent/child cascade, both link-release orders,
  the blocking helpers, and shortening a deadline while a thread is
  already parked.
- `io_deadline.c` - a wait on a silent fd gives up on time, and the slot
  is reusable afterwards.
- `io_cancel.c` - cancelling a thread parked in the multiplexer,
  pre-cancelled short circuit, token deadline reaching the I/O wait,
  parent cancel reaching a child's wait, readiness beating a late
  cancel, plus a **200-round storm** that races abandon teardown against
  delivery. That storm is the real test of the `fired`/`io_mu`
  handshake; a mistake there is a use-after-free on the parker's frame,
  not a wrong return code.
- `io_fd_conflict.c` - the regression guard for gap 2.

End to end, in `examples/pass/`: `cancel_token_smoke.yoop`,
`io_timeout_smoke.yoop`, `io_cancel_smoke.yoop`.

One bug worth recording, caught while reviewing rather than by a test:
`tcp.yoop`'s "does this stream have an ambient token" check was written
as "no deadline and not yet cancelled". That is true of a perfectly
live token, so `tcpSetToken` with a plain deadline-less token would
have been silently ignored and the read would have gone back down the
uninterruptible path. It has to be the structural `cancel.isNone`.
The `ambient:` line in `io_cancel_smoke` is the guard - under the bug
it hangs forever rather than failing.

## Deliberately not in this pass

- **Worker-pool I/O yielding.** A task parked on I/O still holds its
  worker thread. Releasing it needs real coroutine suspension across an
  I/O point, which the 6.3 IR shape was designed for but never
  implemented. Separate, much larger change.
- **std/http timeouts.** The server accept loop and the client keep
  their current blocking calls. The `std/net` primitives this pass adds
  are what a follow-up would wire in.
- **Windows IOCP.** Unchanged - the `_ex` entry points return `ENOSYS`
  there like the originals.
- **A compiler-synthesized task-body token** (the old 10.F.2.b design).
  The explicit token subsumes it; sugar can land later without a
  redesign.
