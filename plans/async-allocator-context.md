# Async allocator context

> The ambient allocator is scoped to a THREAD. The thing that logically owns
> it is a TASK. Tasks migrate between threads and interleave on one thread, so
> the two disagree the moment a suspend happens inside an arena scope. This
> plan makes the context follow the coroutine, then builds the sharing and
> pinning stories on top of it.

Companion to [arena-and-context-allocators.md](arena-and-context-allocators.md)
(which designed the context but predates coroutines) and
[async-coroutines.md](async-coroutines.md) (which added the suspension the
context does not survive).

## The bug, demonstrated

Two tasks, one arena, a socketpair suspend in the shape of
[examples/pass/async_yield_smoke.yoop](../examples/pass/async_yield_smoke.yoop).
Task A pushes an arena as the ambient allocator and then awaits. Task B never
touches the arena and allocates 1024 bytes.

```text
--- YOOP_NUM_WORKERS=1 ---
A: pushed arena, used=0
A is parked
B: allocated 1024 bytes; A's arena used=1024   (want 0)
A: after resume, used=1088

--- YOOP_NUM_WORKERS=4 ---
A: pushed arena, used=0
A is parked
B: allocated 1024 bytes; A's arena used=0
A: after resume, used=0                        (want 64)
```

Three distinct failure vectors, all from one root cause:

1. **Leak into a neighbor.** A parks and hands its worker back with its arena
   still installed in that worker's TLS. B runs on that worker and allocates
   out of A's arena. When A's scope destroys the arena, B's memory goes with
   it. This is a use-after-free with no diagnostic anywhere.
2. **Loss on migration.** A resumes on a different worker, whose TLS holds a
   different allocator. Everything A allocates after the await escapes the
   region into malloc, and since arena-shaped code never frees, it leaks.
3. **Cross-thread corruption on pop.** A's `popAllocator(prev)` writes the
   allocator that worker X had into worker Y's TLS. Y is now permanently
   wrong, with no connection back to the code that broke it.

There is a fourth vector that needs no async code at all.
`yoop_task_wait` ([yoop_runtime.c:399](../runtime/yoop_runtime.c#L399))
re-entrantly drains the queue on the calling thread so a nested wait chain
cannot deadlock the pool. So a plain synchronous function that has an arena
installed - exactly the shape of
[examples/pass/arena_request_loop.yoop](../examples/pass/arena_request_loop.yoop) -
and then does `wait h` will run an arbitrary unrelated task on its own thread,
inside its own arena. Arenas and tasks are already incompatible today, in
straight-line code, without anybody writing `async`.

## Why it happens, and why we are well placed to fix it

`yoop_ctx_alloc` reads a `_Thread_local` slot
([yoop_alloc.c:35](../runtime/yoop_alloc.c#L35)). The push/pop STACK lives in
yoop locals - `ArenaScope.prev`, `Vec.alloc` - and only the current top is in
TLS. That split is what makes this cheap to fix:

- The stack half already works. A scope opened inside a coroutine stores its
  `prev` in the coroutine frame, which is heap-allocated and migrates with the
  task for free.
- Only the single current-top slot is misplaced, and there is exactly one
  place in the runtime where a task starts, resumes, or gives its thread back:
  `run_task_step` ([yoop_runtime.c:149](../runtime/yoop_runtime.c#L149)). It
  already performs precisely this save/install/restore dance for
  `tls_current_task`, for precisely the same reason.

So the fix is one slot, swapped at one funnel. No codegen changes to the
coroutine ABI, no new suspend machinery, and no cost on any path that does not
run a task.

## Stage 1: the context follows the task

**Status: landed.** Implemented as designed below; the three corrections
implementation turned up are folded into the text and called out again under
"What implementation changed". Stages 2 through 4 are still open.

### Where the saved context lives

One `ptr` on the task handle, pointing at a runtime-owned context record.
Inserted at field index 7 (offset 40), the same way the coroutine handle was
inserted at offset 32: every offset the C runtime hard-codes (0/8/9/12/16/24/32)
stays valid, and the result slot moves from 40 to 48.

```c
typedef struct {
  YoopAllocator alloc;      // the ambient allocator this task is inside
  int           alloc_set;  // 0 = never diverged from the default
  void*         temp;       // this task's scratch arena (stage 4, lazy)
} YoopTaskCtx;

static inline void** handle_ctx_slot(void* h) { return (void**)((char*)h + 40); }
```

A pointer rather than 32 inline bytes, because the record grows in stage 4 and
because a task that never touches an allocator should pay nothing. The slot
stays NULL until a step actually diverges from the default, so the common task
allocates no context record at all.

Alternative considered and rejected: a runtime-side side table keyed by handle.
It needs a lock on every step and buys nothing.

### The swap

```c
static void run_task_step(void* handle, void (*thunk)(void*)) {
    void* prev_task = tls_current_task;
    tls_current_task = handle;

    YoopTaskCtx outer;
    yoop_ctx_save(&outer);          // this thread's own context
    yoop_ctx_load_task(handle);     // the task's, or the default if unset

    if (thunk) {
        thunk(handle);
    } else {
        void* coro = *handle_coro_slot(handle);
        if (coro && g_coro_resume) { g_coro_resume(coro); yoop_task_settle(handle); }
    }

    // Whatever is current now belongs to the TASK, not to this worker.
    if (A_LOAD_U8(handle_state_ptr(handle)) != 0) {
        yoop_ctx_discard_task(handle);   // finished: drop the record
    } else {
        yoop_ctx_store_task(handle);     // suspended: it resumes with this
    }
    yoop_ctx_restore(&outer);
    tls_current_task = prev_task;
}
```

The done-vs-suspended branch reads `state` after the step rather than hooking
`yoop_task_settle`, because the thunk calls `settle` itself on the start path
and the resume path calls it here - reading state covers both without touching
either.

`yoop_ctx_store_task` allocates the record only when the step left the TLS
context different from what was loaded (or created a temp arena). A task that
never pushes an allocator keeps a NULL slot forever.

This one change closes all four vectors above, including the synchronous
`wait`-dispatch one: a task dispatched re-entrantly on main's thread gets its
own context installed around its step and main's arena restored afterward.

### What a spawned task inherits: nothing

A spawned task starts with the default context (malloc), not the spawner's.
This is what
[arena-and-context-allocators.md](arena-and-context-allocators.md) already
intended ("a spawned task gets the worker's default context, not the
spawner's"); it just was never implemented, so today a task gets whatever the
worker happened to be holding.

The reason is not conservatism, it is that inheritance is unsound here on two
counts. An arena is a single-threaded bump pointer, so two tasks bumping one
shared offset is a data race; and the spawner's scope can end while the child
is still running, so the child would be allocating into a destroyed region.
Stage 3 makes sharing possible by making it explicit and giving it an arena
that can take it.

**This is a behavior change to existing programs**, and it should be called out
in the phase notes: code that today happens to allocate from an ambient arena
inside a task will deterministically stop doing so. That code was relying on a
race, but it will still look like a regression to whoever wrote it.

### Non-task threads are unchanged

The rule is one sentence: the allocator context is per-thread, except while a
task step is running, in which case it is per-task. `main` and any thread
outside the pool keep exactly today's behavior.

## Stage 2: thread-pinned regions

Stage 1 makes an ALLOCATOR context safe to carry across a suspend. Not every
guard's state can travel: some is held by the OS thread itself, and for those,
resuming on a different worker is wrong no matter how carefully we move our own
slot. The honest answer there is to refuse to compile the await.

### The distinction this rests on, because it is easy to get wrong

Two different affinities look alike and want opposite things.

- **Thread affinity.** The state lives in thread-local storage, or the API
  binds it to the calling thread. A GL context is the clearest case:
  `SDL_GL_MakeCurrent` (and `wglMakeCurrent` underneath it) makes a context
  current *on the calling thread*, which is also why
  [yoop_gl_win32.c](../runtime/yoop_gl_win32.c) resolves entry points against
  "the current context". Resume on another worker and every GL call after the
  await goes to a thread with no context. Others in this family: a Windows COM
  STA apartment, a pushed locale, a thread-local tracing stack. **This is what
  `pinnedToThread` is for.**
- **Handle affinity.** The state lives on an object, and the constraint is
  that nobody else may touch that object meanwhile. The thread is irrelevant.
  **This wants exclusion, not pinning**, and `pinnedToThread` on it would
  forbid the very thing the code is trying to do.

A database transaction is the SECOND kind, and an earlier draft of this plan
used it as the example for the first. Correcting that, because the mistake is
instructive:

- A SQLite transaction belongs to the CONNECTION, not to a thread. SQLite has
  allowed a connection to move between threads since 3.5.0, and serialized
  mode is the default. Suspending mid-transaction and resuming elsewhere is
  fine; the connection did not move.
- For any networked driver, awaits inside a transaction are the NORMAL case -
  one round trip per statement. Pinning would rule out async transactions
  entirely.
- The repo's actual `transaction` kind
  ([std/db/sqlite/db.yoop](../std/db/sqlite/db.yoop)) is `appliesTo binding`,
  not `region`, and its doc comment says why: a region has no name, and with
  no name there is nothing to call `commit` on. The rollback is the disposer;
  the commit has to be said out loud.
- What an async transaction actually needs is exclusion on the connection.
  Two tasks interleaving on one `Db` is a real bug - `BEGIN` against a
  connection that already has an open transaction fails, and worse, one task's
  statements can land inside the other's transaction. The tools for that are a
  connection per task (a pool) or a lock held for the transaction's lifetime.
  Note `DbRef` makes the unsafe sharing easy today: it is a raw borrow storing
  a pointer, with nothing stopping two tasks from holding one.
- The `mustCall` half already survives suspension with no help: `Tx` lives in
  the coroutine frame, and the injected rollback runs on whichever thread
  resumes.

Where the bad example came from, so it does not come back: `ephemeral`'s doc
comment in [std/core/kinds.yoop](../std/core/kinds.yoop) lists "an allocator
scope, a pushed context, a transaction" as region-guard shapes. That list is
about guards whose EXIT means something, which is a different set that merely
overlaps on allocator scopes.

### The clause

The kind decl stays the authority, matching `conferred` / `clearedBy` /
`pausable`:

```yoop
export kind glContext {
    appliesTo region;
    requires Disposable;
    mustCall dispose beforeScopeEnd;
    ownsBlock;
    pinnedToThread;      // an await anywhere in this region is an error
}
```

Default `ephemeral` stays unpinned and becomes genuinely async-safe once stage
1 lands, so the common arena case needs no new keyword.

**Honest note on priority.** Narrowing the motivating set to genuine thread
affinity leaves stage 2 without an active in-tree consumer: the GL code lives
in [examples/playground/](../examples/playground/) (shader_demo, nebula_arena)
and is single-threaded, using no tasks at all. So this is a guard against a
hazard nobody in the tree is currently exposed to. Worth building when
something does mix GL (or another thread-current API) with tasks; not worth
building ahead of that.

Pieces:

- **Parser.** `pinnedToThread` as a contextual ident in the kind body, mirroring
  `pausable` ([parser.js:1267](../src/jsyooparser/parser.js#L1267)). It stays an
  ordinary identifier everywhere else.
- **Typecheck.** `populateKindFromClauses`
  ([typecheck.js](../src/jsyooptypecheck/typecheck.js)) sets
  `kt.pinnedToThread`. Legal alongside `appliesTo region` and
  `appliesTo binding`; rejected on `appliesTo function`, where the sensible
  meaning would be "this function may not be async" and that is a separate
  feature, not this one wearing a disguise.
- **A new `containsSuspend` walk**, in `src/jsyooptypecheck/suspend.js` as a
  sibling of [diverge.js](../src/jsyooptypecheck/diverge.js). Walk the region's
  statements looking for `AWAIT_EXPRESSION`.

  A purely syntactic walk is COMPLETE here, which is worth stating because it
  looks like it should not be. The suspend in async_yield_smoke happens two
  frames below the task body - but `await` is the only way to call an async
  function, and it is syntactically required at every one of those call sites.
  A block with no `await` token in it cannot suspend. That is the async
  coloring rule paying for itself.
- **Call site.** `validateKindBinding`
  ([checkStatement.js](../src/jsyooptypecheck/checkStatement.js)), which
  already gates named-vs-anonymous region bindings. Explicit-block form walks
  `stmt.trailingBlock`; implicit form (`ephemeral guard(x);`, disposed at
  enclosing scope end) walks the remaining statements of the enclosing block.
- **Diagnostic.** Name the kind, the mechanism, and both exits:
  `kind "glContext" is pinnedToThread, but this region contains an await -
  the code after it may resume on a different thread. Move the await out of
  the region, or remove the pin.`

Known limit, worth a comment rather than code: a blocking `wait h` inside a
pinned region does not migrate the thread, but it does re-entrantly dispatch
other tasks onto it, which will see the guard's TLS state. Stage 1 fixes that
for the allocator specifically; for a foreign guard it remains a hazard. Flag
it in the doc comment on `pinnedToThread` and revisit if it bites.

## Stage 3: shared arenas for task trees

Once a request scope wants to fan out and have its children allocate into the
request's region, it needs an arena that survives concurrent bumps.

### The allocator

A second flavor, not a mode flag on the existing one - a lock-free bump over an
atomic offset:

```c
typedef struct {
  unsigned char*  base;
  size_t          cap;
  _Atomic size_t  offset;
  _Atomic int32_t refs;
} YoopSharedArena;
```

`yoop_shared_arena_alloc` is a compare-exchange loop on `offset` (align up,
bound-check, CAS; monotonic so no ABA). Reset is only valid with `refs == 1`.

Sharding (per-thread chunks carved from one backing region, refilled under a
lock) is deliberately NOT in this stage. A single atomic on one cache line is
fine until measurement says otherwise, and the sharded version is a drop-in
replacement behind the same handle.

### The lifetime rule

The scope cannot destroy the region while a child can still allocate from it.
Two mechanisms, belt and braces:

- **Refcount (the belt).** `sharedArenaRetain` on the way into a spawn,
  release when the child's context is discarded. `dispose` with `refs > 1`
  aborts with a message naming the count. Deliberately an abort rather than a
  block: a hang is a worse debugging experience than a message that says
  exactly what is wrong.
- **Structured concurrency (the braces).** The `joined` bindings declared
  inside the region are joined at the region's block end, and cleanup is LIFO,
  so the joins should fire before the region's `dispose`. **Verify this
  ordering before relying on it** - see open questions.

### The yoop surface

```yoop
export type SharedArena { handle: unsafe_ptr<void> }
export function sharedArenaNew(cap: usize): SharedArena
export function sharedArenaAllocator(a: SharedArena): Allocator
export function sharedArenaScope(cap: usize): SharedArenaScope  // region guard
```

Handing one to a child is explicit (pass it as a spawn argument), which is the
point: the unshared `Arena` is rejected at that same position by the
enforcement below, so the two flavors are told apart at the one site where the
difference matters.

## Stage 4: the temp arena per task

**Status: landed.**

`yoop_temp` was `_Thread_local` and `resetTemp()` reset whichever thread called
it. Under async that is wrong in both directions: temp allocations made before
an await can be reset by an unrelated task sharing the worker, and a
`resetTemp()` after a resume resets a different thread's arena than the one that
served the allocations.

Folded into the per-task context from stage 1: `YoopTaskCtx.temp`, created
lazily, destroyed when the record is discarded at task completion.
`yoop_temp_handle()` returns the task's arena when a task is current and the
thread's otherwise. This is the `YoopContext` shape the original arena plan
sketched (`{ current allocator, temp arena }`), just anchored to the task
instead of the thread.

Three things worth recording, because none were obvious from the design:

1. **`yoop_temp_reset()` must NOT fall back to the thread's arena when a task
   has no scratch of its own.** The symmetric-looking rule ("use the task's if
   it has one, else the thread's") reintroduces the bug on the reset side: a
   task that never allocated from temp would clear the scratch of whoever
   dispatched it. Inside a task the function is task-local or a no-op, full
   stop. It also deliberately does not CREATE a record, since there is nothing
   to reset in an arena that does not exist.
2. **The "which task is current" pointer rides `YoopCtxSave`.** `yoop_alloc.c`
   needs it to find the record from `yoop_temp_handle`, but it must not learn
   the handle layout, so it holds a `void**` to the slot rather than the
   handle. It has to be saved and restored rather than just set, because task
   steps NEST - `yoop_task_wait` drains the queue re-entrantly, so a step can
   run inside another step. Putting it in the save struct makes that fall out
   of the existing save/restore in `run_task_step` with no new bookkeeping.
3. **The record is now allocated on two paths, not one.** Stage 1's "only on
   suspend" claim is no longer the whole story: first temp use inside a task
   also materializes it (`task_ctx_ensure`). A task that neither suspends nor
   touches scratch still allocates nothing.

**Cost note, deliberately not optimized:** a task that uses temp storage costs
one `YOOP_TEMP_CAP` (64 KiB) malloc/free per task, because the arena is
destroyed rather than returned to a free list. For a server spawning a task per
connection that would matter - but nothing in std allocates from temp today
(the only consumer in the tree is
[examples/pass/arena_scope.yoop](../examples/pass/arena_scope.yoop)), so a pool
would be speculative. If temp ever becomes hot on a per-connection task, a
free list of temp arenas is the change to make.

## Enforcement: keeping an unshared arena out of a spawn

`mustNotShare acrossThreads` already exists (Phase 9.J) and is checked at
task-spawn argument sites in `enforceMustNotShareAcrossThreads`
([checkExpr.js:2689](../src/jsyooptypecheck/checkExpr.js#L2689)). It reads
`binding.kindType`, so using it today would mean writing a kind keyword on
every arena binding:

```yoop
taskLocal ar = mem.arenaNew(65536);   // ceremony on every arena
```

Better: let the TYPE carry it, via the `propagates<K>` slot that already exists
on `StructType.propagatedKinds` ([types.js:140](../src/jsyooptypecheck/types.js#L140)).

```yoop
export kind taskLocal {
    appliesTo binding parameter field;
    mustNotShare acrossThreads;
}

export type Arena propagates<taskLocal> { handle: unsafe_ptr<void> }
```

Then extend `enforceMustNotShareAcrossThreads` to consult the argument's
resolved type's `propagatedKinds` in addition to the binding's `kindType`, and
every `Arena` is rejected at a spawn site with no per-binding ceremony, while
`SharedArena` (which carries no such marker) passes.

The hole to document rather than close: the check only sees direct `IDENT` and
`ref IDENT` arguments. An arena reached through a struct field that is passed
to a spawn is not caught. Full coverage is an escape-analysis job well beyond
this plan; the marker is a guardrail on the obvious mistake, not a proof.

## Files touched

Stage 1:

- [runtime/yoop_runtime.c](../runtime/yoop_runtime.c) - the handle-layout
  comment, `handle_ctx_slot`, the swap in `run_task_step`.
- [runtime/yoop_alloc.c](../runtime/yoop_alloc.c) - `YoopTaskCtx`, plus
  `yoop_ctx_save` / `restore` / `load_task` / `store_task` / `discard_task`.
- [runtime/yoop_alloc.h](../runtime/yoop_alloc.h) - NEW. `yoop_alloc.c` had no
  header at all, because nothing in the runtime called into it; the
  `from "runtime/yoop_alloc.h"` string in
  [std/core/alloc.yoop](../std/core/alloc.yoop) was a documentation label
  naming a file that did not exist. The scheduler calls these now, so the
  declarations have to be somewhere both translation units can see, and the
  label stopped being a fiction. No packaging change: `runtime/` is copied
  wholesale by both `files` in package.json and the build_sea staging step.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) - the task
  struct field list (near line 3406) gains a `ptr` at index 7; the result-slot
  index moves 7 to 8 and the arg indices `8 + i` to `9 + i`.
  **Five sites, not three, and two of them are byte offsets rather than struct
  indices**: 4119 and 4203 (args), 4150 / 5081 / 6435 (result by index), and
  5095 / 5160 (result by `getelementptr inbounds i8, ptr %h, i64 48` - the
  anonymous-`wait` and `wait_until` paths). Grepping for the struct index alone
  finds neither byte-offset site, and the symptom is every task result reading
  back as zero.
- [runtime/tests/](../runtime/tests/) - `submit_one.c`, `submit_many.c` and
  `refcount.c` hand-mirror the handle prefix, and all three had drifted: they
  still declared `result` at offset 32, where the coroutine handle has lived
  since the async work. The scheduler was writing through the coro and context
  slots past the end of a 40-byte struct, so they segfaulted rather than
  reporting a mismatch. All three now carry `_Static_assert`s on every offset.

Stage 2: [parser.js](../src/jsyooparser/parser.js),
[typecheck.js](../src/jsyooptypecheck/typecheck.js),
[checkStatement.js](../src/jsyooptypecheck/checkStatement.js), new
`src/jsyooptypecheck/suspend.js`,
[std/core/kinds.yoop](../std/core/kinds.yoop).

Stage 3: [runtime/yoop_alloc.c](../runtime/yoop_alloc.c) +
[std/core/alloc.yoop](../std/core/alloc.yoop).

Stage 4: [runtime/yoop_alloc.c](../runtime/yoop_alloc.c) +
[std/core/alloc.yoop](../std/core/alloc.yoop).

Enforcement: [checkExpr.js](../src/jsyooptypecheck/checkExpr.js),
[std/core/kinds.yoop](../std/core/kinds.yoop),
[std/core/alloc.yoop](../std/core/alloc.yoop).

## Tests

- [examples/pass/async_arena_context.yoop](../examples/pass/async_arena_context.yoop) -
  the probe above, promoted. Asserts the neighbor task sees `used=0` and the
  resumed task sees its own 64 bytes. Runs under both `YOOP_NUM_WORKERS=1` and
  `=4`. The original reasoning for two counts was that each exposes a different
  vector; measured, it is slightly different: the `resumed` line catches the
  loss-on-migration at ANY worker count, while the `neighbor` line only
  exercises the leak-into-a-neighbor path when a worker rather than main's
  re-entrant `wait` dispatch picks the neighbor up. Both counts are still worth
  running, for the scheduling coverage rather than the vector coverage.
- [examples/pass/arena_sync_wait.yoop](../examples/pass/arena_sync_wait.yoop) -
  vector 4, no async in user code: an arena installed in `main`, a `wait` that
  dispatches an unrelated task. Pinned to one worker with that worker parked in
  a blocking sleep, so main is guaranteed to be the dispatching thread. This is
  the deterministic one - it fails at every worker count without the fix
  (`task: arena used=640`, the task's 512 bytes landed in main's region).

- [examples/pass/task_temp_isolation.yoop](../examples/pass/task_temp_isolation.yoop) -
  stage 4. Same one-worker-plus-blocking-hog setup as `arena_sync_wait`, so
  main dispatches the task itself. Held per-thread the task reports
  `temp used=576` (main's 64 bytes already spent in the shared arena) and its
  `resetTemp()` leaves main reading 0; per-task it is 512 and 64.

All three fixtures were checked against a build with the fix disabled, so they
are known to fail without it rather than assumed to. **The blocking `hog` in
the two one-worker fixtures is load-bearing**: without a worker occupied, the
task under test lands on a worker whose thread-local state already differs from
main's, and the fixture passes against a broken build.

Still to build, with their stages:

- `examples/fail/pinned_region_await.yoop` - stage 2's diagnostic.
- A shared-arena fan-out fixture for stage 3, plus a cleanup-ordering fixture
  proving the `joined` bindings inside a region are joined before the region's
  own dispose.
- Runtime C tests for the shared arena's CAS bump under N threads, added to
  BOTH [runtime/tests/](../runtime/tests/) and the mirror list in
  [run_tests.sh](../runtime/tests/run_tests.sh).

## What implementation changed (stage 1)

Three things the design above did not anticipate, all found by building it:

1. **Two of the result-slot reads are byte offsets, not struct indices.** The
   anonymous-`wait` path (a `pooled h` parameter, where there is no known task
   fn to give a typed GEP) and the `wait_until` path both hard-code
   `i64 40`. Missing them compiled clean and produced task results of zero -
   `wait_until_smoke` and `propagates_full` caught it, which is a good argument
   for those two fixtures existing.
2. **The C runtime tests hand-mirror the handle layout and had already
   drifted.** All three still declared `result` at offset 32, which the
   coroutine handle took over during the async work. They survived only because
   nothing wrote through the coro slot on a path they exercise; adding a second
   runtime-owned slot turned that latent out-of-bounds write into a segfault.
   They carry `_Static_assert`s on every offset now, so the next layout change
   fails to compile with a named offset instead of crashing at run time.
3. **`yoop_alloc.c` needed a header after all.** Not for the yoop side - the
   extern block really is the declaration there - but because `run_task_step`
   is C calling into C. See the files list.

## Open questions

1. **Cleanup ordering.** Does the `joined` cleanup for a binding declared
   inside an `ephemeral` region fire before the region's `dispose`? Stage 3's
   lifetime story leans on LIFO ordering here. `projectCleanups`
   ([kindCheck.js](../src/jsyooptypecheck/kindCheck.js)) is where to check, and
   a fixture should pin it either way before stage 3 starts.
2. **`Vec` allocator capture.** `vec_new` captures whatever is ambient at
   construction ([vec.yoop:49](../std/core/vec.yoop#L49)). After stage 1 that
   capture is correct, and the push/pop around grow and free is balanced with
   no await between, so `Vec` needs no change. Confirm with a fixture that
   grows a Vec after a suspend rather than assuming it.
3. **Does anything in `std/http` want a per-request arena?** The request-scoped
   arena is the motivating use case for stage 3, but the server currently uses
   none, so stage 3 has no in-tree consumer yet. Worth building
   [examples/playground/todo_api](../examples/playground/todo_api) into one
   before committing to the shared flavor.

## Sub-phase ordering

Stages 1 and 4 have landed, in that order: stage 1 was the correctness fix and
stood alone (it closed a live use-after-free that needs no async code to
trigger), and stage 4 rode naturally on the context record it introduced.

What is left:

- **Stage 3 (shared arenas)** is the larger one and still waits for a real
  consumer - see open question 3. It is the only remaining piece with a design
  question attached (the cleanup-ordering guarantee in open question 1).
- **Stage 2 (`pinnedToThread`)** is independent of everything else and has NO
  active in-tree consumer once the motivating set is narrowed to genuine thread
  affinity - see the note at the end of that section. Lowest priority of the
  three; build it when something first mixes a thread-current API with tasks.
