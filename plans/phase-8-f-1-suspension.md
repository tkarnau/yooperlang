# Phase 8.F.1 — Task suspension via park/unpark

## Context

Phase 8.F's MVP is pthread-per-task: every task that may block runs on its
own pthread, and "suspend" means "block the pthread on a condvar." This
sub-phase adds the lowest-level synchronization primitive — a **park
token** — that the multiplexer (F2) and timer (F3) build on.

The existing runtime ([runtime/yoop_runtime.c](../runtime/yoop_runtime.c))
already uses per-handle mutex+condvar pairs for `yoop_task_wait`. F1 is a
small extension: a standalone park-token type that any caller can allocate
on its own stack and have someone else signal.

## Design

### `yoop_park_token_t`

```c
typedef struct yoop_park_token {
    yoop_mutex_t mu;
    yoop_cond_t  cv;
    int          state;   // 0 = idle, 1 = pending wake, 2 = parking
} yoop_park_token_t;
```

Three states:

- **0 = idle**: no pending wake. `yoop_park` will block until `yoop_unpark`
  fires.
- **1 = pending wake**: an `yoop_unpark` ran before the matching
  `yoop_park`. The next `yoop_park` returns immediately and resets state
  to 0. This eliminates the classic "lost wakeup" race.
- **2 = parking**: a `yoop_park` is currently blocked in
  `yoop_cond_wait`. `yoop_unpark` signals the cv to wake it.

### API

```c
void yoop_park_token_init(yoop_park_token_t* t);
void yoop_park_token_destroy(yoop_park_token_t* t);

// Block the calling thread until yoop_unpark is called on this token.
// Returns when woken. If an unpark already happened before this park
// (state == 1), returns immediately. Resets state to 0 on return.
void yoop_park(yoop_park_token_t* t);

// Signal a parked thread (or pre-arm the token if no one's parked yet).
// Idempotent: a second yoop_unpark before the matching yoop_park has
// no extra effect.
void yoop_unpark(yoop_park_token_t* t);
```

### Correctness invariants

- A park token is owned by exactly one thread (the "parker"). `yoop_park`
  is only called by that thread. `yoop_unpark` may be called from any
  thread.
- Once destroyed, the token must not be parked or unparked again. The
  caller is responsible for ensuring no `yoop_unpark` is in flight at
  destroy time. F2/F3 handle this by ensuring the multiplexer / timer
  thread has dropped its reference to the token before the parker returns
  from `yoop_park`.
- "Pending wake" semantics: an `yoop_unpark` before the matching
  `yoop_park` is **remembered** until the park consumes it. This is the
  same shape as Java's `LockSupport.park`/`unpark` — designed to be
  race-free at the API level so callers don't have to wrap it in their
  own mutex.

### What F1 does *not* add

- **No yoop-language surface.** The park/unpark functions are runtime
  primitives. Yoop user code reaches them only indirectly via the F2/F3
  intrinsics.
- **No cancellation token.** A future extension can add
  `yoop_park_with_reason()` returning an enum of wake reasons. The MVP
  treats every wake the same — F2's multiplexer uses fd-readiness as the
  one wake reason; F3's timer uses elapsed-deadline.
- **No timed park.** `yoop_park_timed(t, ns)` is the obvious extension F3
  needs. F3 actually uses `pthread_cond_timedwait` directly inside its
  own logic rather than re-architecting the token API; the timed-park
  API can be lifted up when a second consumer appears.
- **No M:N scheduling.** The whole sub-phase assumes one pthread per
  task. M:N scheduling needs stackful coroutines and a work-stealing
  scheduler — out of scope.

## Sub-phase steps

### F1.0 — Header and impl

Add `yoop_park_token_t`, `yoop_park_token_init`, `yoop_park_token_destroy`,
`yoop_park`, `yoop_unpark` to
[runtime/yoop_runtime.h](../runtime/yoop_runtime.h) +
[runtime/yoop_runtime.c](../runtime/yoop_runtime.c).

Implementation uses the existing `yoop_mutex_t` / `yoop_cond_t` wrappers
so the same code paths work across pthread / Win32 sync backends.

### F1.1 — Runtime tests

[runtime/tests/](../runtime/tests/) — add a focused C test:

- park + unpark round-trip (single-thread).
- unpark-then-park (pending-wake path).
- park-then-unpark from another pthread.
- Stress: 100 park/unpark pairs from concurrent threads, every park
  matches some unpark, every unpark is paired with some park.

### F1.2 — Documentation

Add a small "Concurrency primitives" comment block in
[runtime/yoop_runtime.h](../runtime/yoop_runtime.h) explaining the
ownership rules and the state machine. The header is the spec.

## Files touched

- [runtime/yoop_runtime.h](../runtime/yoop_runtime.h) — typedef + four
  public functions.
- [runtime/yoop_runtime.c](../runtime/yoop_runtime.c) — implementations.
- `runtime/tests/test_runtime.c` (or wherever the smoke tests live) —
  park/unpark cases.

## Out of scope

- Cancellation. Add `yoop_park_with_reason` / unpark-with-reason when a
  second wake-reason appears.
- Timed park. Lift up if a second consumer beyond F3 needs it.
- M:N scheduler. Documented in the umbrella plan.
