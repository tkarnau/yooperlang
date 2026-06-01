# Phase 8.F - Real Task suspension, I/O multiplexer, and timers

## Context

The parent plan calls this the biggest of the prerequisite phases. It splits
into three sub-phases that each get their own document:

- **F1 - Task suspension** ([phase-8-f-1-suspension.md](phase-8-f-1-suspension.md))
- **F2 - I/O multiplexer** ([phase-8-f-2-multiplexer.md](phase-8-f-2-multiplexer.md))
- **F3 - Timers** ([phase-8-f-3-timers.md](phase-8-f-3-timers.md))

Phase 8.A–E gave yoop the FFI surface and module-state primitives needed to
talk to libc. Phase 8.F gives the *runtime* the concurrency primitives so a
yoop program can have many in-flight I/O operations without blocking the
process. With F1/F2/F3 landed, the eventual networking library can be a
pure-yoop layer on top of `read`/`recv`/`send`/`accept` + the wait
intrinsics.

## What "task suspension" means here

Yoop has had `task fn(...)` + `Task<T>` + `wait h` since Phase 6.3 ([plans/phase-6-3-prelude.md](phase-6-3-prelude.md)), but the existing runtime is **run-to-completion** per task: a worker thread picks up a task, runs the whole function, and only then signals done. If the task blocks on a syscall (e.g. `read`), the worker pthread blocks too. With *N* workers, you can have at most *N* concurrent blocking I/O operations.

The parent plan describes two possible end-states:

1. **M:N scheduling with LLVM coroutines.** Tasks are stackful coroutines;
   when one blocks, its state is saved and the worker picks up another. A
   million in-flight tasks is feasible.
2. **1:1 with pthread-per-task + a multiplexer.** Tasks are pthreads; when
   one blocks on an fd, a multiplexer thread takes responsibility for
   waking it. A few thousand in-flight tasks is feasible.

**Phase 8.F MVP picks (2).** The pthread-per-task model is correct, simple,
and uses primitives we already have (pthreads, condvars). The M:N story is
real future work - see "Out of scope" below.

The yoop language surface does **not** change in this phase. Everything new
is reachable via `extern "C"` declarations against the runtime's exported
symbols. Phase 8.F is a pure runtime + library phase.

## Sub-phase summaries

### F1 - park/unpark primitives ([phase-8-f-1-suspension.md](phase-8-f-1-suspension.md))

Adds two runtime functions: `yoop_park()` and `yoop_unpark(token)`. These
are the lower-level primitives that the multiplexer and timer build on. F1
does not surface anything to user code - it's the infrastructure F2 and
F3 use. A small unit test exercises park/unpark from C.

### F2 - I/O multiplexer ([phase-8-f-2-multiplexer.md](phase-8-f-2-multiplexer.md))

New runtime subsystem: `runtime/yoop_io.c`. Wraps `kqueue` (macOS / BSD)
and `epoll` (Linux) behind a stable platform-agnostic API:

```c
int yoop_io_wait_readable(int fd);   // park current thread until fd readable
int yoop_io_wait_writable(int fd);
```

One dedicated multiplexer thread runs the poll loop and `yoop_unpark`s
threads whose fds have become ready. Yoop user code reaches these by
`extern "C"`-declaring them.

### F3 - Timers ([phase-8-f-3-timers.md](phase-8-f-3-timers.md))

```c
int yoop_sleep_ns(uint64_t ns);   // park current thread for ns nanoseconds
int yoop_sleep_ms(uint64_t ms);   // convenience wrapper
```

Implementation: `clock_gettime(CLOCK_MONOTONIC) + pthread_cond_timedwait`
on a fresh park token. Self-contained - doesn't depend on the multiplexer.

## Whole-phase demo

`examples/pass/concurrent_pipe.yoop`:

- Creates a libc pipe (`pipe(int[2])`).
- Spawns a `task reader()` that calls `yoop_io_wait_readable(rfd)` then
  `read(rfd, buf, 1)` and stashes the byte.
- Main calls `yoop_sleep_ms(50)`, then `write(wfd, "X", 1)`.
- Main does `wait r` for the reader.
- Asserts the byte was received and the timing was within tolerance.

Exercises all three sub-phases together: a task suspends on the
multiplexer (F1+F2), wakes when bytes arrive (F2), and the producer
deliberately delays via the timer (F3).

## Out of scope (real follow-ups)

- **M:N scheduling with LLVM coroutines.** Phase 8.F MVP is pthread-per-task.
  Scaling to millions of tasks needs stackful coroutines and a real work-
  stealing scheduler. Out of scope; documented in F1.
- **Cancellation propagation.** Even an MVP server eventually needs "I
  closed the listening socket, cancel all the accept-waiting tasks." The
  primitive needs a `yoop_unpark_with_reason(token, REASON_CANCEL)` so the
  woken task can distinguish ready-from-IO from cancellation. Designed in
  F1 but the language-level cancellation hook is deferred - see F1
  "Out of scope."
- **IOCP (Windows).** F2 implements kqueue + epoll only. The
  `runtime/yoop_io.c` is structured so a Windows backend can be added
  later without changing the public API.
- **Deadlines and scheduling priorities.** F3 ships `sleep_ns` only. A
  `wait_until(deadline)` and priority hints are future work.
- **Cross-task cancellation tokens.** Parent's "cancel" wake reason hooks
  into the park infrastructure but the user-visible API (a `CancelToken`
  type, propagation through child tasks) is its own design.
