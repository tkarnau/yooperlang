# Phase 9.I — Suspendable `wait` inside task bodies

## Context

Plan: [plans/phase-9.md §9.I](../phase-9.md#phase-9i--suspendable-wait-inside-task-bodies).
Spec section: [SPEC.md §8 "Safety and deadlock"](../../SPEC.md#safety-and-deadlock).

Pre-9.I, `yoop_task_wait` blocked the calling thread on the awaited handle's
per-handle condvar (`pthread_cond_wait`). With N workers and N tasks each
waiting on an N+1th task that was still in the queue, the pool deadlocked —
the only thread that could run task N+1 was already parked inside one of the
N waits. The spec already named the mitigation (suspendable wait) and Phase
8.F.1 had landed the park/unpark primitives the runtime would need.

## What landed

- Runtime ([runtime/yoop_runtime.c](../../runtime/yoop_runtime.c)) replaces
  the body of `yoop_task_wait` with an opportunistic dispatch loop. Each
  iteration:
  1. Load target state; return if done.
  2. Take `queue_mu`, try `try_pop_task_locked()` (extracted helper); if a
     task is available, drop the lock and run it on the calling thread.
  3. Otherwise re-check target state under the lock, then park briefly on
     `queue_cv` (`pthread_cond_timedwait`-equivalent — `YOOP_WAIT_POLL_MS =
     25`). New submissions wake instantly; the timer catches handle-done
     signals that aren't broadcast on `queue_cv`.
- `yoop_handle_signal_done` now also broadcasts `queue_cv`, so any waiter
  parked on the queue cv wakes immediately when its target (or any other
  task) finishes — no waiting for the 25 ms poll. The poll remains as a
  defensive fallback only.
- The worker loop was refactored to use the same `try_pop_task_locked`
  helper so the queue-popping invariant lives in one place.
- The per-handle mutex/condvar slots are kept (the handle ABI is unchanged
  — codegen knows the layout) even though no thread parks on them anymore.
  The atomic-release/atomic-acquire fence on `state` carries the memory
  ordering by itself.

The language surface is unchanged: `wait h` still has the same synchronous
appearance, the same return type, the same composability with `joined` /
`pooled` bindings. The only observable change is that the deadlock case
described in SPEC §8 no longer deadlocks.

## Verification

- Existing concurrent fixtures (`concurrent_pipe.yoop`, `hello_server`,
  `runtime: park_unpark`, `runtime: submit_many`) all pass — the existing
  paths' semantics are preserved.
- New E2E pass:
  [examples/pass/suspendable_wait.yoop](../../examples/pass/suspendable_wait.yoop)
  — chain of three nested task waits, exercised with
  `YOOP_NUM_WORKERS=1`. Pre-9.I, this deadlocked; now it completes and
  prints `chain=18`. The test sets the env var and a 10-second timeout via
  the new `runFixture` `{env, timeoutMs}` options.
- Full test suite green (557 tests).

## Caveats / deferred

- **Stack recursion.** Recursive task dispatch nests stack frames on the
  calling thread; very deep nested-wait chains can exhaust the OS stack the
  same way deep direct recursion would. The MVP runtime model doesn't use
  coroutines / fibers — that's the only "true" structural fix and would
  require per-task heap stacks. For real workloads, the depth budget is
  generous (default thread stack is 8 MB on Linux, 512 KB on macOS — still
  hundreds of nested waits before exhaustion).
- **Per-thread state during a help-dispatched task.** While a wait is
  drilling into the queue, the calling thread runs *other* tasks' bodies in
  the middle of its own task's frame. Per-thread state (errno, thread-locals
  like the `yoop_io` multiplexer's epoll handle if it ever grows one) can be
  observed in a different order than under the old always-park model.
  Treat thread-local state as task-local for portability. Today's runtime
  doesn't expose any user-visible thread-local state, so this is a forward
  warning, not a present bug.
- **Windows path.** The timed wait uses `pthread_cond_timedwait` on POSIX
  and `SleepConditionVariableCS` on Windows; both are implemented but the
  Windows path is untested in CI (the matrix is Linux + macOS only — see
  [CLAUDE.md](../../CLAUDE.md)).
