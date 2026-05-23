# Phase 10.F.1 — Deadlines (`wait_until`) + dropping the wait poll ✓ landed

> Phase 10.F as scoped in [phase-10.md](../phase-10.md#phase-10f----cancellation-tokens-deadlines-multiplexer-timers)
> bundles three independent runtime-shaped features: cancellation tokens,
> deadlines, and a multiplexer-integrated timer subsystem. This sub-phase
> ships the **deadline** half plus the **poll removal** that the timer
> bullet was really about, deliberately deferring cancellation to its own
> follow-up because the implicit-`cancellation: ref Cancel` parameter on
> task bodies is a meaningfully larger language change.
>
> The two features ship together because they share a code path:
> `yoop_task_wait_until_ns` is the new bounded-wait entry point, and the
> 25ms safety poll inside `yoop_task_wait` was the thing the "real timer
> event source" bullet was originally trying to eliminate. With every
> `yoop_handle_signal_done` already broadcasting `queue_cv`, the poll is
> redundant — drop it and bare `wait` is poll-free.

## What landed

### Runtime

[runtime/yoop_runtime.c](../../runtime/yoop_runtime.c) + the matching
declarations in [runtime/yoop_runtime.h](../../runtime/yoop_runtime.h):

- **`yoop_now_ns()`** — wall-clock reading in nanoseconds from
  `CLOCK_REALTIME` (Linux + macOS use the default cv-clock here so the
  reading and the `pthread_cond_timedwait` deadline live in the same
  space). On Windows, rebases `GetSystemTimeAsFileTime` off the Unix
  epoch and returns the same nanosecond reading.
- **`yoop_task_wait_until_ns(handle, deadline_ns)`** — bounded sibling
  of `yoop_task_wait`. Returns `0` on completion, `1` on deadline
  expiry. The deadline is absolute, in the same clock space as
  `yoop_now_ns`. **Does not dispatch queued tasks on the calling
  thread** — that's the deliberate divergence from
  `yoop_task_wait`'s Phase 9.I behavior, because a queued task that
  runs past the deadline would invalidate the user's "give up at time
  T" contract. Worker threads continue to drain the queue normally;
  we only block the caller on the queue cv with the user's deadline as
  the timeout.
- **Poll-free `yoop_task_wait`.** The 25ms `pthread_cond_timedwait`
  bound is gone — the loop now uses an indefinite `pthread_cond_wait`
  and relies on the broadcast in `yoop_handle_signal_done` (added in
  Phase 9.I) to wake parked waiters. The hoisted `errno.h` + `time.h`
  includes at the top of the TU let the deadline arithmetic compile
  without the per-section duplicates that the timer code added in
  Phase 8.F.3.
- The shared helper `queue_cv_wait_until_locked(deadline_ns)` collapses
  the deadline + indefinite cases into one function — `deadline_ns ==
  0` (`YOOP_WAIT_NO_DEADLINE`) routes through `pthread_cond_wait`
  unchanged; any other value goes through `pthread_cond_timedwait` with
  the user's absolute deadline.

### Stdlib

[std/core/concurrency.yoop](../../std/core/concurrency.yoop) — new file:

- **`enum WaitResult<T> { Done { value: T }, Timeout }`** — the result
  shape `wait_until` returns. Two variants because cancellation is a
  separate follow-up; when it lands the `Cancelled` variant will join
  here (additive — `switch` exhaustiveness will catch every existing
  call site).
- **`now_ns(): uint64`** — thin wrapper over the runtime helper.
- **`sleep_ms(ms): int32`** — thin wrapper over `yoop_sleep_ms`. The
  in-test reason for adding it: a deterministic Timeout fixture needs
  a task that's slow enough to overshoot a 50ms deadline.

`wait_until(h, deadline_ns)` itself is intentionally *not* exported from
this file — it's a builtin call form recognized by the typechecker by
callee name, parallel to the `wait` keyword. Users import only
`WaitResult` (to destructure the outcome) and any helpers they need.

### Typechecker

[src/jsyooptypecheck/checkExpr.js](../../src/jsyooptypecheck/checkExpr.js)
`resolveCall` now intercepts callee name `wait_until` before the generic
function lookup. The new helper `resolveWaitUntilCall`:

1. Verifies the call has exactly two args.
2. Resolves arg 0 — must be `Task<T>`; extracts T.
3. Resolves arg 1 — must be `uint64` (untyped int literals coerce in).
4. Looks up the `WaitResult` generic enum decl via
   `lookupGenericEnumDecl` (which walks the user's local + imported
   tables). A miss yields a fix-it diagnostic pointing at the
   `std/core/concurrency.yoop` import.
5. Instantiates `WaitResult<T>` through the Phase 7.1 registry.
6. Stamps the node with `builtinWaitUntil`, `builtinTaskResultType`
   (the T), and `builtinWaitResultType` (the instantiated enum).
7. Returns the instantiated enum as the call's resolved type.

User-defined `wait_until` functions are shadowed by the builtin, same
shape as `printf`'s special-casing.

### Codegen

[src/jsyoopcodegen/codegen.js](../../src/jsyoopcodegen/codegen.js):

- New runtime declares for `@yoop_task_wait_until_ns` (i32 return,
  ptr+i64 args) and `@yoop_now_ns` (i64 return).
- New helper `emitWaitUntilCall(node, fnLines)` (multi-module section)
  lowers the call inline: emit the handle ptr + deadline value, call
  the runtime, branch on the i32 outcome, and build the appropriate
  `WaitResult<T>` variant. The Done arm reads the task's result from
  the universal handle byte-offset 32 and stores it into the variant's
  payload field; the Timeout arm stores only the variant tag.
- `emitCallExpr` intercepts `node.builtinWaitUntil` ahead of the
  generic builtin dispatch. The single-module `emitCall` doesn't need
  the dispatch — `wait_until` requires the `WaitResult` import which is
  multi-file by construction.

### Verification

- [examples/pass/wait_until_smoke.yoop](../../examples/pass/wait_until_smoke.yoop)
  — exercises both branches: a `compute(7)` task that finishes well
  inside its 1-second deadline (Done { value: 49 }), and a `slow()`
  task that sleeps 200ms past its 50ms deadline (Timeout). The
  switch arms print distinct lines so the test asserts on stdout
  without flakiness around exact timing.
- All 559 tests green (was 558, +1 for `wait_until_smoke`). The
  runtime smoke tests covering `yoop_task_wait`, `submit_many`, and
  the nested-wait suspendable case from Phase 9.I all still pass
  with the 25ms poll gone — confirming the broadcast-only wakeup
  path is reliable end-to-end.

## Deferred

- **Cancellation tokens.** The other large bullet under Phase 10.F.
  Adding `Cancel`, the implicit `cancellation: ref Cancel` parameter
  on task bodies, the pooled-handle `.cancel()` form, and the
  `WaitResult.Cancelled` variant is a separate sub-phase because the
  param-injection is a real language change (the existing task-fn
  thunk signature, the handle layout, and the user-visible call site
  all shift). When it lands, `WaitResult` grows the third variant
  additively, and `switch` exhaustiveness will catch every existing
  call site that doesn't yet handle it.
- **Multiplexer-integrated timer event source.** The plan called for a
  `timerfd` / `EVFILT_TIMER` integration with the existing kqueue/epoll
  loop in [runtime/yoop_io.c](../../runtime/yoop_io.c). What actually
  landed eliminates the poll a different way: drop the poll from bare
  `wait` entirely (broadcasts cover wakeups), and have `wait_until`
  block on the queue cv with the user's deadline as the timeout. The
  kqueue/epoll path stays unchanged. A real timer event source would
  let `sleep_ms` and any future deadline-driven primitive share a
  single I/O thread instead of each spawning its own ephemeral cv;
  worth doing when there's a real consumer that wants it.
- **Generic helpers like `wait_either` / `wait_first` / `wait_all`.**
  None of these are in the plan; they're the natural follow-up if a
  real consumer wants concurrency combinators. The `WaitResult<T>`
  shape is the right return for each of them so the surface composes
  cleanly when the time comes.

## Critical files touched

- [runtime/yoop_runtime.h](../../runtime/yoop_runtime.h),
  [runtime/yoop_runtime.c](../../runtime/yoop_runtime.c) — new runtime
  entry points, poll removal, hoisted includes.
- [std/core/concurrency.yoop](../../std/core/concurrency.yoop) — new
  module: `WaitResult<T>`, `now_ns`, `sleep_ms`.
- [src/jsyooptypecheck/checkExpr.js](../../src/jsyooptypecheck/checkExpr.js)
  — `wait_until` interception + `resolveWaitUntilCall` helper.
- [src/jsyoopcodegen/codegen.js](../../src/jsyoopcodegen/codegen.js) —
  `emitWaitUntilCall` + the two runtime declares + `emitCallExpr`
  intercept.
- [examples/pass/wait_until_smoke.yoop](../../examples/pass/wait_until_smoke.yoop),
  [src/e2e.test.js](../../src/e2e.test.js) — fixture + test entry.
- [SPEC.md §8](../../SPEC.md) — bounded-wait paragraph added.
