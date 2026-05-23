# Phase 10.F.2.a — External cancellation (`cancel(h)` + `WaitResult.Cancelled`) ✓ landed

> Phase 10.F's cancellation bullet has two natural halves:
> **external** — a caller fires `cancel(h)` and the corresponding
> `wait_until` returns `Cancelled` — and **cooperative** — the task
> body itself polls a `cancellation: ref Cancel` parameter and exits
> early. The cooperative half needs a language change (an implicit
> parameter injected into every task body) and a synthetic identifier
> in the typechecker. This sub-phase ships the external half, which is
> useful standalone: the caller can abandon a slow request, treat the
> handle as done-from-its-side, and move on. The task body still runs
> to natural completion in the background — its result is unobserved.
>
> The cooperative half ships as 10.F.2.b once a real consumer wants it.

## What landed

### Runtime

[runtime/yoop_runtime.c](../../runtime/yoop_runtime.c) +
[runtime/yoop_runtime.h](../../runtime/yoop_runtime.h):

- **`yoop_task_cancel(handle)`** — atomic store `1` at the handle's
  offset-9 cancel byte, then broadcast `queue_cv` so any caller parked
  in `yoop_task_wait_until_ns` wakes immediately and observes the
  flag. Idempotent — a second cancel re-broadcasts but the byte is
  already set. Deliberately does **not** wake bare `yoop_task_wait`
  callers: bare `wait` is the "I need the result" contract;
  cancellation only changes whether callers *willing to abandon* (via
  `wait_until`) see Cancelled vs. Done.
- **`handle_cancel_ptr(h)`** — new static accessor returning
  `(char*)h + 9`. Reuses one of the existing three padding bytes
  between `state` (offset 8) and `refcount` (offset 12) — no ABI
  change vs. pre-10.F.2, the byte just stops being padding.
- **`yoop_task_wait_until_ns` extended** — checks the cancel byte in
  three spots: the loop top, after taking the queue lock, and the
  post-`ETIMEDOUT` last-look. Returns the runtime outcome `2`
  whenever it's set + state is not done. Tie-breaking when multiple
  things happened: **Done > Cancelled > Timeout** — the result wins
  if it raced in, and the user's explicit "abandon" intent wins over
  passive timer expiry.

### Codegen

[src/jsyoopcodegen/codegen.js](../../src/jsyoopcodegen/codegen.js):

- New runtime declare for `@yoop_task_cancel(ptr) -> void`.
- **`emitTaskHandleInit`** now zeros the cancel byte at handle byte
  offset 9 alongside the other prefix-init stores. Pooled handles via
  `yoop_task_alloc` already came from `calloc` and were zero, but
  joined/stack-allocated handles via alloca weren't — without the
  explicit store the cancel byte would inherit stack garbage and a
  `wait_until` on a freshly-allocated handle could spuriously return
  Cancelled. The fix is a single byte-offset GEP + `store i8 0` in
  the shared init helper, so joined + pooled + emit-from-call all
  pick it up at once.
- New `emitCancelCall(node, fnLines)` — trivial: emit the handle ptr,
  call `@yoop_task_cancel`, return void.
- **`emitWaitUntilCall` extended** to a three-way LLVM `switch i32`
  branch (was a binary `icmp eq` + `br i1`): outcome 0 → Done arm
  (loads result, builds variant), 1 → Timeout arm, 2 → Cancelled arm,
  default → Cancelled (defensive — future runtime extensions fall
  through to the safest interpretation rather than u.b.).

### Typechecker

[src/jsyooptypecheck/checkExpr.js](../../src/jsyooptypecheck/checkExpr.js):

- `resolveCall` intercepts callee name `cancel` next to the existing
  `wait_until` interception. The new helper `resolveCancelCall`:
  - Verifies arity (exactly 1 arg).
  - Verifies arg 0 is a `Task<T>` (any T).
  - Stamps `node.builtinCancel = true` for codegen.
  - Returns `void`.

User-defined `cancel` functions are shadowed by the builtin, same
shape as `wait_until` and `printf`.

### Stdlib

[std/core/concurrency.yoop](../../std/core/concurrency.yoop):

- `WaitResult<T>` gains a third `Cancelled` variant. Existing consumers
  of `WaitResult` (the `wait_until_smoke.yoop` fixture) had to add
  explicit `case WaitResult.Cancelled:` arms — `switch`
  exhaustiveness caught every site at typecheck time, no silent
  drift. This is the additive-variant story 10.F.1 anticipated.

### Verification

- [examples/pass/cancel_smoke.yoop](../../examples/pass/cancel_smoke.yoop)
  — two-task setup: a `slow()` task sleeps 200ms then returns 99; a
  `canceller(target)` task sleeps 30ms then fires `cancel(target)`.
  Main runs `wait_until(slow, now + 1s)` with a generous 1-second
  deadline so the only path to Cancelled is via the in-flight
  `cancel(target)`. The final `wait slow` + `wait killer` drain both
  pooled handles cleanly (the slow task is still running its 200ms
  sleep at the point we cancel — cancellation is caller-side, not
  body-side).
- All 560 tests green (was 559, +1 for `cancel_smoke`).
  `wait_until_smoke` still passes with the new third variant added to
  its switch arms.

## Deferred

- **Cooperative cancellation in task bodies (10.F.2.b).** The other
  half of the original plan: the implicit `cancellation: ref Cancel`
  parameter the user can poll. Three concrete pieces:
  - A `Cancel` opaque type in `std/core/concurrency.yoop` plus an
    `is_cancelled(ref c: Cancel): bool` extern wrapper.
  - Typechecker: bind `cancellation` as a synthetic `ref Cancel` in
    every task fn body scope. Codegen threads the cancel-byte ptr
    through as a synthetic first argument to the body, populated by
    the thunk from `%ts + 9`.
  - Body emission: `emitFn` adds the synthetic `cancellation` slot
    before user-declared params when the function `isTask`.
  None of this is exposed to the user yet — for now, a task body
  cannot detect that it's been cancelled. The result keeps being
  computed and discarded. Real consumers (HTTP serve loops, long
  polling clients) need the polling form to actually save work; this
  sub-phase doesn't address that, just the "I gave up; ignore the
  result" caller-side semantics.
- **`h.cancel()` method-style form.** The original plan sketched
  `let pooled h = fetch(url); h.cancel();`. Today's surface is
  `cancel(h)` — a free function. Method dispatch on `Task<T>` would
  need either trait machinery on Task (which is currently
  compiler-builtin, not a struct), or a parser-level rewrite. Both
  are more invasive than the free-function form and the latter reads
  fine.
- **Cancellation reasons / cancel-by-source.** Today the cancel byte
  is a single bit. A future `yoop_task_cancel_with_reason(h, code)`
  could store a small reason code in the same prefix; the
  `WaitResult.Cancelled` variant would grow a `{ reason: int32 }`
  payload. Speculative — no consumer asking for it.
- **Cancellation propagation (cancel parent → cancel child).** A
  parent task spawning a child today does not transitively cancel the
  child when the parent is cancelled. Doable once the cooperative
  half exists — the parent's body checks `is_cancelled(ref cancellation)`
  and explicitly fires `cancel(child)`. A first-class auto-propagate
  flag would need a "children list" on the handle, which is a bigger
  layout change.
- **Cancellation of joined handles.** Today `cancel(h)` is only
  meaningful for `pooled` h — a joined handle's autoJoin synthesizes
  a bare `wait` at scope exit, which doesn't observe cancellation.
  Joined + cancel could co-exist if the autoJoin point used
  `wait_until` with an infinite deadline, but the semantic question
  ("what does cancellation mean for a joined task that's required to
  finish before scope exit?") wants its own thinking.

## Critical files touched

- [runtime/yoop_runtime.h](../../runtime/yoop_runtime.h),
  [runtime/yoop_runtime.c](../../runtime/yoop_runtime.c) —
  `yoop_task_cancel`, `handle_cancel_ptr`, three-spot cancel check in
  `yoop_task_wait_until_ns`.
- [std/core/concurrency.yoop](../../std/core/concurrency.yoop) — added
  `Cancelled` variant.
- [src/jsyooptypecheck/checkExpr.js](../../src/jsyooptypecheck/checkExpr.js)
  — `resolveCancelCall` + the call-site interception.
- [src/jsyoopcodegen/codegen.js](../../src/jsyoopcodegen/codegen.js) —
  `emitCancelCall`, three-way switch in `emitWaitUntilCall`, cancel-byte
  zero in `emitTaskHandleInit`, `@yoop_task_cancel` declare.
- [examples/pass/cancel_smoke.yoop](../../examples/pass/cancel_smoke.yoop),
  [examples/pass/wait_until_smoke.yoop](../../examples/pass/wait_until_smoke.yoop)
  (Cancelled arms added), [src/e2e.test.js](../../src/e2e.test.js).
- [SPEC.md §8](../../SPEC.md) — handle-operations table + cancel paragraph.
