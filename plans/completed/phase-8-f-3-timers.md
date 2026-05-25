# Phase 8.F.3 - Timers

## Context

Phase 8.F.1 added park/unpark. F2 added the I/O multiplexer. F3 adds the
last primitive yoop programs need before a real server can be written:
*sleep for N nanoseconds, then resume*. Servers use this for
back-pressure, retry backoff, periodic housekeeping, heartbeat
intervals - everything.

The MVP implementation is intentionally **independent of the F2
multiplexer**: `pthread_cond_timedwait` against `CLOCK_MONOTONIC` on a
fresh condvar is the entirety of the body. This keeps F3 self-contained
and useful even before F2 lands.

A later refinement could integrate timers with the multiplexer (kqueue's
`EVFILT_TIMER` / Linux `timerfd_create`) so a single thread waits for
*both* I/O readiness and timer expiry. That's a scheduling optimization;
the MVP API doesn't change.

## Design

### Public API

```yoop
extern "C" from "yoop_runtime" {
    function yoop_sleep_ns(ns: c_size_t): c_int;
    function yoop_sleep_ms(ms: c_size_t): c_int;
}
```

- `yoop_sleep_ns(ns)`: blocks the calling thread for at least `ns`
  nanoseconds (monotonic clock). Returns 0 on normal completion, -1 on
  error (errno set).
- `yoop_sleep_ms(ms)`: convenience wrapper computing
  `yoop_sleep_ns(ms * 1_000_000ULL)`.

Both are safe to call from any thread - including a worker thread
running a yoop task. The pthread blocks; other workers continue picking
up other tasks. With the F2 multiplexer in flight, a thread sleeping is
just "not consuming the multiplexer" - the multiplexer keeps polling.

### Implementation

```c
int yoop_sleep_ns(uint64_t ns) {
    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    // Carry-add ns to deadline.tv_nsec / tv_sec.
    deadline.tv_sec  += (time_t)(ns / 1000000000ULL);
    uint64_t rem      = ns % 1000000000ULL;
    deadline.tv_nsec += (long)rem;
    if (deadline.tv_nsec >= 1000000000L) {
        deadline.tv_sec += 1;
        deadline.tv_nsec -= 1000000000L;
    }
    pthread_mutex_t mu;
    pthread_cond_t  cv;
    pthread_mutex_init(&mu, NULL);
    pthread_condattr_t attrs;
    pthread_condattr_init(&attrs);
    pthread_condattr_setclock(&attrs, CLOCK_MONOTONIC);   // Linux
    pthread_cond_init(&cv, &attrs);
    pthread_condattr_destroy(&attrs);

    pthread_mutex_lock(&mu);
    int rc;
    do {
        rc = pthread_cond_timedwait(&cv, &mu, &deadline);
    } while (rc == 0);   // 0 = "signaled," shouldn't happen since no one signals
    pthread_mutex_unlock(&mu);

    pthread_cond_destroy(&cv);
    pthread_mutex_destroy(&mu);

    return rc == ETIMEDOUT ? 0 : -1;
}
```

On macOS, `pthread_condattr_setclock` doesn't exist - `pthread_cond_timedwait`
already uses absolute `CLOCK_REALTIME` time. Workaround: compute the
deadline using `CLOCK_REALTIME` on macOS, `CLOCK_MONOTONIC` on Linux. Both
are monotonic-enough for sleep duration (CLOCK_REALTIME can step backward
under NTP adjustment but not enough to break a sleep-for-N-ms call in
practice). The runtime header carries the platform branch.

### `clock_gettime` portability

macOS, glibc, and musl all expose `clock_gettime` at link time without
extra flags. No additional libc dependency.

### Cancellation

Out of scope for F3 MVP. A future `yoop_sleep_ns_cancellable` would take
a park token, allowing a "cancel" wake from outside. Even today, the
calling task is free to ignore the result of `yoop_sleep_ns` and return
early - the sleep just keeps running on its worker until completion.
Wasteful but correct.

## Sub-phase steps

### F3.0 - Declarations

Add `yoop_sleep_ns` and `yoop_sleep_ms` to
[runtime/yoop_runtime.h](../runtime/yoop_runtime.h).

### F3.1 - Implementation

Add the bodies to [runtime/yoop_runtime.c](../runtime/yoop_runtime.c).
Platform-branch on Linux vs everyone-else for the clock id.

### F3.2 - Runtime test

C-level test in `runtime/tests/`:

- Records `clock_gettime` before, calls `yoop_sleep_ms(50)`, records
  after.
- Asserts elapsed is between 45 and 200 ms (loose upper bound for CI
  noise).

## Files touched

- [runtime/yoop_runtime.h](../runtime/yoop_runtime.h) - two new
  declarations.
- [runtime/yoop_runtime.c](../runtime/yoop_runtime.c) - implementations.
- `runtime/tests/test_runtime.c` - sleep timing test.

## Out of scope

- Multiplexer-integrated timers (`timerfd` / `EVFILT_TIMER`). Useful when
  many sleeps fight a single multiplexer thread; not needed for the
  hundreds-of-connections scale.
- Cancellable sleep. Needs the park-token-with-reason work also called
  out in F1's "Out of scope."
- Deadline-aware scheduling. The current model is "first-come,
  first-served" via the worker pool - a high-priority sleep doesn't
  preempt a lower-priority compute task.
