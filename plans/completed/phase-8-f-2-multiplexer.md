# Phase 8.F.2 — I/O multiplexer (kqueue / epoll)

## Context

F1 added park/unpark. F2 builds the I/O multiplexer that uses them: one
dedicated thread watches every yoop task's fds via kqueue / epoll and
unparks tasks when their fds become ready. Yoop tasks reach this via two
runtime functions exposed through `extern "C"`.

This is the piece that lets a yoop server accept connections + read/write
on each one without burning a pthread per blocked operation. With one
multiplexer thread + a small worker pool, hundreds of fds can be in flight
concurrently.

## Design

### Public API

Yoop user code reaches the multiplexer by `extern "C"`-declaring two
functions:

```yoop
extern "C" from "yoop_runtime" {
    function yoop_io_wait_readable(fd: c_int): c_int;
    function yoop_io_wait_writable(fd: c_int): c_int;
}
```

Semantics:

- Both functions **block the calling thread** until the fd becomes ready
  for the requested I/O direction (or an error occurs).
- Return value: `0` on ready, `-1` on error with `errno` set. (Mirrors
  the libc convention so the existing `errno.get()` / `errno.message()`
  intrinsics from Phase 8.D compose directly.)
- After return, the caller should attempt the actual `read` / `write`
  syscall — and may have to call `wait_readable` again if a partial /
  EAGAIN result happens. (Standard reactor pattern; documented in the
  runtime header.)
- **One-shot.** Each `wait_readable` registers a one-shot interest. The
  fd is removed from the kqueue/epoll set after firing once. Callers
  re-call to wait again. Matches POSIX `poll`'s semantics and avoids
  per-fd state in the multiplexer.

### Multiplexer architecture

One dedicated pthread, `yoop_io_thread`, runs the poll loop:

```
loop:
    wait on kqueue/epoll for any registered fd
    for each ready (fd, token):
        yoop_unpark(token)
        remove fd from set
    if shutdown_signaled:
        exit
```

A self-pipe trick provides the shutdown wake (the multiplexer adds the
read end of a pipe to its kqueue/epoll set; `yoop_io_shutdown` writes one
byte to the write end and joins the thread).

### Registration data structure

A small in-memory map from `fd` → `yoop_park_token_t*`, protected by a
mutex. The map can be flat — yoop apps in the foreseeable future will
have < 10K fds.

```c
typedef struct yoop_io_registration {
    int                       fd;
    int                       interest;  // READ | WRITE
    yoop_park_token_t*        token;
    struct yoop_io_registration* next;   // singly-linked list bucket
} yoop_io_registration_t;
```

Hashed by `fd & (BUCKETS-1)`. 64 buckets is plenty.

### Per-platform impl

#### macOS / BSD: `kqueue`

```c
struct kevent ev;
EV_SET(&ev, fd, EVFILT_READ, EV_ADD | EV_ONESHOT, 0, 0, token);
kevent(kq, &ev, 1, NULL, 0, NULL);
```

The `udata` pointer carries the token directly — no map lookup needed
on the multiplexer side. (We still keep the map for cleanup symmetry
and so the registration mutex doesn't race with destroy.)

`EV_ONESHOT` does the one-shot removal automatically.

#### Linux: `epoll`

```c
struct epoll_event ev;
ev.events = EPOLLIN | EPOLLONESHOT;
ev.data.ptr = token;
epoll_ctl(ep, EPOLL_CTL_ADD, fd, &ev);
```

After firing, the multiplexer calls `epoll_ctl(EPOLL_CTL_DEL)` to fully
remove the fd. (`EPOLLONESHOT` *disables* the fd's events until the next
`MOD`, which isn't quite the same as "remove" — we want remove so the
fd can be re-added on a fresh wait_readable.)

#### Windows: not implemented in F2. The `runtime/yoop_io.c` is
structured so an IOCP backend can be added later under
`#ifdef _WIN32`.

### Lazy init

The multiplexer thread is spawned on the first call to
`yoop_io_wait_readable` / `wait_writable`. Programs that don't use I/O
don't pay the cost. Init is protected by a `pthread_once_t`.

Shutdown: hooked into `yoop_runtime_shutdown` if the multiplexer was
initialized. The runtime shutdown path writes one byte to the self-pipe
and joins the I/O thread before tearing down the worker pool.

### Failure modes

- **fd already in the set when a second wait_readable runs.** Possible if
  two tasks (different threads) want the same fd. The MVP rejects this
  with `errno = EAGAIN` and returns `-1` — first-come-first-served. A
  realistic networking library wouldn't share fds across tasks anyway.
- **fd closed under our feet.** kqueue/epoll fire EV_ERROR / EPOLLERR;
  the multiplexer wakes the parked task with `errno = EBADF`.
- **Spurious wake.** The token's pending-wake state machine handles it:
  if `yoop_unpark` fires before the `yoop_park`, the park returns
  immediately. The caller then attempts the syscall and either succeeds
  or hits EAGAIN, in which case it re-calls wait_readable.

## Sub-phase steps

### F2.0 — `runtime/yoop_io.h` + `runtime/yoop_io.c`

New compilation unit. Build added to the runtime build (a follow-on
change in [src/runtimeBuild.js](../src/runtimeBuild.js) so e2e tests
link it in). Self-contained — depends only on `yoop_runtime.h`
(for the park token primitives).

### F2.1 — Lazy multiplexer init + shutdown wiring

`pthread_once_t` initializer spawns the multiplexer thread on first call.
A new `yoop_io_shutdown()` is called from `yoop_runtime_shutdown` if the
thread was started.

### F2.2 — Registration + dispatch

Implement `yoop_io_wait_readable` / `yoop_io_wait_writable` as:

1. Allocate a park token on the caller's stack.
2. Register `(fd, interest, &token)` with kqueue/epoll.
3. `yoop_park(&token)`.
4. Read out the wake result (success or errno).
5. Drop the registration (multiplexer side already did for one-shot).
6. Return.

### F2.3 — Demo

Standalone demo deferred to the umbrella plan; F2 alone tests via a
runtime-level C test that uses a libc pipe and exercises the
wait_readable path.

### F2.4 — Runtime test

`runtime/tests/test_runtime.c` (or a new file) — a C test that:

- Creates a pipe.
- Spawns a pthread that writes one byte after ~10ms.
- Main thread calls `yoop_io_wait_readable(rfd)`.
- Asserts the call returned 0 and ~10ms elapsed.

This is a focused C-level test that doesn't depend on the full yoop
pipeline; lives next to the existing runtime smoke tests.

## Files touched

- new: `runtime/yoop_io.h` + `runtime/yoop_io.c`.
- [src/runtimeBuild.js](../src/runtimeBuild.js) — add `yoop_io.c` to the
  list of runtime sources clang compiles in.
- [runtime/yoop_runtime.c](../runtime/yoop_runtime.c) — call
  `yoop_io_shutdown()` from `yoop_runtime_shutdown` (guarded so programs
  that didn't use I/O skip it).
- `runtime/tests/test_yoop_io.c` (new).

## Out of scope

- IOCP / Windows backend.
- Edge-triggered mode. F2 uses one-shot level-triggered semantics.
- Fairness / starvation guarantees beyond what kqueue/epoll provide.
- A user-space `Poller` type. Yoop users call the two functions directly.
