# Task combinators: awaitTask, and what blocks all/race

> `wait h` blocks a thread. Inside a task that is a bug, not a slowdown - the
> joiner holds a worker while the tasks it waits for sit in the queue. This
> adds the suspending join, and the runtime primitive underneath it. The
> collection combinators are designed but blocked; the diagnosis is here.

## What `wait` actually did

`wait h` lowers to `yoop_task_wait`, which parks the calling THREAD. Phase
9.I's "suspendable wait" is re-entrant queue draining - the blocked thread
opportunistically runs other queued tasks so a nested wait chain cannot
deadlock the pool - not coroutine suspension. The typechecker rejects `wait`
inside a task body outright for exactly this reason, so before this work there
was **no way for one task to join another at all**.

## Stage 1: the park byte (a pre-existing race)

Found while building the waiter registry, and it applies to the I/O path that
already shipped.

`yoop_io_arm_readable` registers an interest and RETURNS; the caller suspends
several frames later. If the fd is ready at registration time - which is the
common case on loopback - the multiplexer can call `yoop_task_make_runnable`
while the task is still executing on its worker. That queued the handle, and a
second worker could pop it and call `coro.resume` on a coroutine mid-execution
on the first. A data race on the coroutine frame, not a lost wakeup.

The fix is a park byte at handle **offset 10** - the second of the three pad
bytes the cancel flag started eating into, so no layout change:

- `YOOP_PARK_RUNNING` (0): executing a step, or sitting on the queue.
- `YOOP_PARK_WAKE` (1): a wake arrived mid-step; re-queue when the step ends.
- `YOOP_PARK_PARKED` (2): suspended and off the queue; a wake may queue it.

`run_task_step` sets RUNNING before the step and calls `park_or_requeue_locked`
after one that suspended; `yoop_task_make_runnable` queues only from PARKED and
otherwise records the wake. Same three-state shape as the thread park token
(`yoop_park` / `yoop_unpark`) further down the same file, for the same reason.
All transitions are under `queue_mu` - every one of them already happens at a
point that takes it, so an atomic would be a second layer over the same
critical sections.

Clearing a recorded wake at the start of a step is correct: it asked for this
task to run, and it is running.

## Stage 2: completion waiters

A flat list of `{ target, waiter }` under `queue_mu`. `yoop_handle_signal_done`
already takes that lock to broadcast, so firing the waiters is free there and
provably ordered against arming: a joiner arming while its target completes
either sees `state != 0` and skips suspending, or is registered in time to be
woken. It cannot slip between the two.

- `yoop_task_arm_complete(target)` - 0 armed, 1 no current task (off a worker;
  the caller must block instead of suspending into a hole), 2 already done,
  -1 allocation failure. Deliberately the same contract as
  `yoop_io_arm_readable`.
- `yoop_task_disarm_complete()` - drops all of the calling task's
  registrations.
- `yoop_task_is_done(handle)` - one atomic load.

**A fired waiter is disarmed completely, not just for the target that fired.**
One wake is all a task needs, so a task armed on N targets is fully disarmed by
the first to complete. Without that, the losers would keep queueing a task that
has already moved on. This is what makes first-of-N work, and it is the reason
the registry is a list keyed by waiter rather than a slot on each handle.

A flat list because the count is "tasks blocked on other tasks right now",
which is small, and every operation needs `queue_mu` anyway. A per-handle
waiter list would save the scan and cost another prefix field.

## Stage 3: the yoop surface

Two new compiler intrinsics, mirroring `cancel` exactly (both take a `Task<T>`,
which an `extern "C"` signature cannot name):

- `armComplete<T>(h: Task<T>): c_int`
- `isDone<T>(h: Task<T>): c_int`

`isDone` looks redundant - `wait_until(h, now_ns())` polls without parking,
since the runtime checks state before it consults the clock. It is not: that
expression does not survive monomorphization inside a generic function, because
`wait_until`'s stamped `WaitResult<T>` result reaches codegen with an
unsubstituted type parameter and trips `llvmType`. That is bug 2 below.

Then `conc.awaitTask`:

```yoop
export async awaitTask<T>(h: Task<T>): T {
    while (isDone(h) == 0) {
        let rc: c_int = armComplete(h);
        if (rc != 0) { break; }
        await suspendNow();
    }
    return wait h;
}
```

Three things about that shape:

- **A loop, not one suspend.** A wake only proves something made this task
  runnable, so re-checking is what makes a spurious wake harmless.
- **`h` is BORROWED, not `pooled`.** The caller owns the handle and outlives
  the join. A `pooled` parameter would also trip bug 1 below.
- **The tail `wait h` is not a block in practice** - the loop only exits when
  the handle is done, or when arming reported "off a worker", which is exactly
  the case where blocking is the correct fallback.

**"All of them" is a loop over `awaitTask`** and needs no combinator: each
iteration suspends, so the joiner holds no worker across any of them, and
awaiting in sequence gives the same answer as anything cleverer because
completion order does not change a sum.

## What is NOT built: TaskGroup, awaitAll, awaitRace

`race` is the one that genuinely needs a collection - it has to arm on several
handles and report which won. The runtime side is done and correct (the
disarm-all-on-fire rule above exists for it). The library side is blocked.

`TaskGroup<T>` is a generic struct holding `Task<T>[]`. Emitting one reaches
`arrayElemLlvmName` with an unsubstituted `typeParam`, even though
`substituteTypeParams` does handle `TaskType` and `structContainsTypeParam` now
sees through it (fixed here - see below). An async generic function with a
plain `T[]` local is fine; a generic struct with a `Task<T>` field is not. The
remaining gap is somewhere between instantiation and struct emission and was
not chased to the bottom.

Whoever picks this up: `examples/pass/task_await_join.yoop` is the working
baseline, and the deleted group code is in this file's git history. The API
that was written and tested against a stale binary was:

```yoop
disposable g: TaskGroup<int32> = conc.groupNew(2);
conc.groupAdd(ref g, a);
conc.groupAdd(ref g, b);
let results: int32[] = await conc.awaitAll(ref g);
let r: RaceResult<int32> = await conc.awaitRace(ref g);   // { index, value }
```

Two semantic decisions worth keeping when it is revived:

- **A group BORROWS its handles.** Making it own them needs `retain`/`release`
  on a `Task<T>`, and neither is callable from yoop: `Task<T>` satisfies
  `Shared` for the `pooled` keyword's benefit, but a trait-qualified call
  rejects it as a receiver (`trait method "Shared.retain" requires a struct
  ... receiver, got Task<int32>`). So every handle in a group must outlive the
  join, which is the natural shape anyway.
- **A race does not cancel the losers.** `cancel` abandons a WAIT rather than
  stopping a body, so cancelling them would be a promise the language cannot
  currently keep.

`allSettled` and `any` were dropped deliberately: yoop tasks do not reject, so
`all` already IS `allSettled` unless deadlines are involved, and `any` only
means anything over `Result`.

## Pre-existing bugs found

All four were latent before this work; none were introduced by it.

1. **A `pooled` parameter double-frees.** `f(pooled h: Task<T>)` releases at
   scope exit but the call site never retains, so passing a `pooled` binding
   into it corrupts the heap (`tiny_free_list_remove_ptr`). Verified against
   an unmodified checkout. This is why `awaitTask` borrows.
2. **`wait_until` inside a generic function crashes codegen.** Its stamped
   `WaitResult<T>` result survives monomorphization as a `TypeParamType` and
   reaches `llvmType`. Worked around by making `isDone` an intrinsic.
3. **`>>`-closing nested type applications do not parse in FIELD position.**
   `type G { h: Vec<Vec<int32>> }` fails with "trailing comma in type argument
   list"; the identical annotation on a binding parses. Not Task-specific.
4. **The I/O arm race** described under stage 1, fixed here.

## Fixed here, beyond the feature

- `arrayElemLlvmName` had no `task` case, so `Task<int32>[]` typechecked and
  then crashed codegen - which blocked any collection of tasks. Keyed by result
  type (`task_int32`) so two task arrays cannot collide on one array type def.
- `structContainsTypeParam` could not see a type parameter inside a `Task<T>`
  field. Every handle is a bare `ptr`, so nothing about the emitted layout
  gives the parameter away, and an open struct got emitted referencing an array
  type that was never defined.

## Files

- [runtime/yoop_runtime.c](../runtime/yoop_runtime.c) - park byte, the two
  transition helpers, the waiter registry, `fire_waiters_locked` in
  `yoop_handle_signal_done`, `queue_push_locked`.
- [runtime/yoop_runtime.h](../runtime/yoop_runtime.h) - the three new entry
  points.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js),
  [checkExpr.js](../src/jsyooptypecheck/checkExpr.js) - `armComplete` / `isDone`
  intrinsic registration and resolution (bare + namespaced).
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) - their
  lowering, plus the two array/type-param fixes above.
- [std/core/concurrency.yoop](../std/core/concurrency.yoop) - `awaitTask`.
- [examples/pass/task_await_join.yoop](../examples/pass/task_await_join.yoop) -
  the fixture, pinned to one worker in e2e so a regression deadlocks rather
  than returning a wrong answer.
