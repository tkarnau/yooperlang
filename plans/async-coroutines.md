# Async functions, LLVM coroutines, and worker yielding

> Suspendable task bodies: a task that blocks on I/O gives its worker
> thread back to the pool instead of holding it. Built on LLVM's
> switched-resume coroutines, with an async/non-async distinction in the
> language so a suspend can propagate up a call chain.

## Why this needs a language change

`llvm.coro.suspend` suspends **the current function's frame only**. The
blocking call in a real program is several frames down:

    user task body -> Readable.read -> TcpStream.read -> ffi_recv -> wait_readable

For the task body to suspend at the bottom of that, every frame in the
chain has to be a coroutine that propagates the suspend upward. That is
function coloring, and there is no way to have it without saying so in
the language - the alternative (making every function a coroutine) costs
a heap frame per call and breaks FFI.

So: `async` is a property of a function's signature, `await` is the only
way to call one, and the compiler enforces that an `await` only appears
where a suspend can actually propagate.

Section 7 of [runtime-design.md](runtime-design.md) sketched coroutines
for `task` bodies but assumed a task only suspends at a `wait` written
directly in its own body. That case never needed the coroutine machinery
(9.I's re-entrant dispatch already covers it) and does not release a
worker on I/O. This document replaces that sketch.

## Validated first

The IR shape was proven before any compiler work, with hand-authored
`.ll` driven from C: a coroutine awaiting another coroutine, the inner
one suspending on a not-yet-ready flag, the suspend propagating up, and
the scheduler resuming **only the top handle** while the chain re-drives
itself. Correct and identical at `-O0` and `-O2`.

That last point is the load-bearing one: the runtime never has to track
the interior of a call chain. It holds one handle per task.

## Surface

`async` replaces `function`, exactly as `task` does (and `async function`
is rejected as redundant, matching the existing `task function` error):

    async fetchBody(ref s: TcpStream): Result<uint8[], string> {
        let n: usize = await readSome(ref s, ref buf);
        ...
    }

`await` is a prefix operator at the same tight precedence as `ref` and
`wait` (70).

**`task` bodies are implicitly async.** A task is the scheduler's unit of
work, so it is exactly the place a suspend can land; requiring
`async task` would be noise.

### Coloring rules

1. `await e` is legal only inside an `async` function or a `task` body.
2. `e` must be a call to an async function.
3. An async function must be called through `await` - a bare call is an
   error with a fix-it.
4. `main` is not async. The bridge from sync to async is what it already
   was: spawn a `task`, then `wait` the handle.
5. A trait method may be declared `async`; an impl must match its
   asyncness.

Rules 2 and 3 together are what make coloring checkable locally: there is
no way to reach an async function except from another async function.

## ABI

An async `f(a: A, b: B): T` lowers to

    define ptr @f(A %a, B %b, ptr %__ret) presplitcoroutine

It returns the coroutine handle. The result is stored through `%__ret`
before the final suspend, so the caller owns the slot and it lives in the
caller's own frame - which is what keeps it alive across the caller's
suspends. `void` returns still take `%__ret` (unused) so there is one ABI
rather than two.

**No initial suspend.** Calling an async function runs it eagerly until
it hits a real suspend point, so an async call that never blocks
completes with no resume at all and costs one frame allocation.

### await lowering

Inside coroutine C, `await g(args)`:

    %slot = alloca T                     ; in C's frame
    %h = call ptr @g(args, ptr %slot)
    br label %L.loop
    L.loop:
      %d = call i1 @llvm.coro.done(ptr %h)
      br i1 %d, label %L.done, label %L.block
    L.block:
      %s = call i8 @llvm.coro.suspend(token none, i1 false)
      switch i8 %s, label %fn.suspend [i8 0, label %L.res
                                       i8 1, label %fn.cleanup]
    L.res:
      call void @llvm.coro.resume(ptr %h)
      br label %L.loop
    L.done:
      %v = load T, ptr %slot
      call void @llvm.coro.destroy(ptr %h)

`fn.suspend` / `fn.cleanup` are the function's shared trailer blocks.

### Driving from C

`llvm.coro.resume` / `destroy` / `done` are intrinsics, so the C runtime
cannot call them and must not hard-code the frame layout either. Codegen
emits three non-coroutine trampolines once per program
(`yoop_coro_resume` / `yoop_coro_destroy` / `yoop_coro_done`) and the
runtime calls those.

## Runtime

The task handle gains a coroutine-handle slot and a runnable/suspended
state. A worker popping a task either starts it (call the body, get a
handle) or resumes the stored handle, then:

- `done` -> result is already in the slot; signal completion, destroy.
- not done -> the task is suspended and the worker **returns to the
  queue**. Whatever suspended it registered the wakeup.

`yoop_task_make_runnable(h)` pushes a suspended task back onto the queue.
The multiplexer calls it on readiness instead of unparking a thread.

A thread-local **current task** is set by the worker before it resumes,
so the innermost primitive can register interest against the right task
without threading a handle through every signature.

### The suspend primitive

One compiler-recognized intrinsic:

    extern "intrinsic" from "compiler" {
        async function suspendNow(): void;
    }

It lowers to a bare `coro.suspend`. Everything else is ordinary yoop:

    async function awaitReadable(fd: c_int): int32 {
        let rc: int32 = ioArmCurrent(fd, 0);   // register one-shot
        if (rc != 0) { return rc; }
        await intr.suspendNow();               // worker goes free here
        return 0;
    }

### Sockets go non-blocking

An async read has to be "try, and if it would block, arm and suspend", so
`std/net` sockets get `O_NONBLOCK` and the recv/send helpers loop on
`EAGAIN`. This is the part that turns the existing park-the-thread
multiplexer into a real reactor.

## Build order and status

- **A - parser. DONE.** `async` decls (free functions, methods, trait
  sigs, exports, extern-intrinsic decls), `await` expressions.
- **B - typecheck. DONE.** `isAsync` on FuncType, both coloring rules,
  asyncness as part of signature equality (so a sync impl of an async
  trait method is rejected), and the task-spawn carve-out.
- **C - codegen. DONE.** Coroutine emission, await lowering, the suspend
  primitive, trampolines.
- **D - runtime. DONE.** Coroutine-driving worker loop, `yoop_task_settle`,
  `yoop_task_make_runnable`, current-task TLS, async arming in the
  multiplexer, and `conc.awaitReadable` / `awaitWritable` in std.
- **E - std/net + std/http. DONE.** Non-blocking sockets, async
  accept/read/write, async `Readable`/`Writable`, and the whole HTTP
  server and client converted. Acceptance case:
  `examples/pass/async_server_smoke/` runs a server plus three concurrent
  clients on a SINGLE worker thread.
- **Async trait methods. DONE**, including through generics and vtables.
  See "Trait dispatch" below.

### As-built notes

Three things came out differently from the sketch above.

**The task struct grew a field rather than changing shape.** The
coroutine handle sits at offset 32, immediately after `cond_ptr`, so
every offset the C runtime hard-codes (0/8/9/12/16/24) is unchanged. The
result slot moved 32 -> 40. The thunk hands the body the task's OWN
result slot as its `__ret`, so a finished coroutine has already written
its result where `wait` looks - no copy.

**The runtime does not link against the coroutine trampolines.** It
receives them as function pointers via `yoop_runtime_set_coro_ops`,
installed by `main`. Two reasons: the trampolines are defined in
generated IR, and the C runtime has to keep building standalone for
`runtime/tests/`. With no ops installed a task is treated as finishing
in one step, which is exactly the pre-async behavior.

The trampolines are also emitted **once per program with external
linkage**, not per module with `linkonce_odr`. Every module is
concatenated into one `.ll`, so per-module copies are a redefinition; and
`linkonce_odr` gets them deleted by globaldce, because nothing inside the
IR ever calls them (only the C runtime does).

**A `task` call site is a spawn, not an await.** Task bodies are
implicitly async, so without a carve-out every `pooled h = worker(1)`
would report as an un-awaited async call. The check keys on the callee's
declared return being `Task<T>`.

## Verification

The IR shape was validated as hand-written `.ll` before any compiler work
- a coroutine awaiting a coroutine, the inner one suspending, the
suspend propagating up, and the scheduler resuming only the top handle.
Identical at `-O0` and `-O2`.

End to end:

- `examples/pass/async_await_smoke.yoop` - composition, mixing async and
  ordinary calls, and a loop whose locals cross an await.
- `examples/pass/async_yield_smoke.yoop` - **the payoff**. Pinned to ONE
  worker (`YOOP_NUM_WORKERS=1`), two tasks park on two different pipes
  at the same time and both resume. Under the old runtime the single
  worker would park inside the first read and the second task would
  never start, so this hangs rather than fails if suspension regresses.
  The suspend also happens two frames below the task body, which is the
  propagation the coloring rules exist to make safe.

Coloring rules are pinned individually in
`src/jsyooptypecheck/typecheck.test.js` (both directions, the task-spawn
carve-out, and trait/impl asyncness matching).

## Trait dispatch

Async is part of a method signature, so it has to survive every form of
dispatch:

- **Concrete receiver** - `Trait.method(ref x, ...)` mangles to the same
  symbol as before, now with the coroutine ABI.
- **Generics** - a generic body awaiting `T`'s bound method works because
  `cloneAstWithSubstitution` resolves `boundMethod` into a concrete
  `calleeMangledName` during monomorphization. By codegen time there is
  no abstract receiver left, so the generic and concrete cases are one
  path. The only fix needed was carrying `isAsync` through
  `substituteTypeParams` and calling `noteAsyncCallee` from
  `resolveGenericCall` (which bypasses the normal call-resolution path).
- **Vtables** - a slot's function-pointer type inherits the trait
  method's asyncness, stamped in `validateVTableDecl`. Users never write
  `async` on a `=>` annotation; the trait is the authority, exactly as it
  already was for the slot's params and return type. Dispatch is then an
  indirect call with the async shape.

This is the case Rust still boxes for. It falls out cheaply here only
because yoop monomorphizes eagerly and has no `dyn` beyond vtables whose
layout the compiler owns.

## The coloring bill, as actually paid

Converting the socket layer forced exactly the cascade the design
predicted:

    ffiRecvAsync -> TcpStream.read -> Readable.read -> std/http readSome
      -> readHead/readBody -> exchange -> serveConnection -> serve -> main

`main` cannot be async, so every entry point ends in the bridge that
already existed: spawn a `task`, `wait` the handle. Every example that
serves or fetches gained a three-line task wrapper.

Two things kept it from being worse:

- **Handlers stay synchronous.** `Handler.handle` takes a buffered
  request and fills a response - there is nothing to await, so user
  handler code is untouched. The `hello_server` e2e case asserts the
  handler's `define` has no `presplitcoroutine`, pinning that.
- **In-memory implementers just declare `async` and never suspend.** An
  async function that does no awaiting runs straight through on its first
  step, costing one frame allocation. `MemBuffer` / `MemReader` in the
  fixtures show the shape.

The one genuine wart: `await f(x)?` originally parsed as `await (f(x)?)`,
which is backwards. The postfix `?` binds inside the operand parse, so
the parser now swaps the two nodes - the same ambiguity Rust spells
around with `foo().await?`. `?` inside a coroutine also had to route its
early return through the final-suspend trailer rather than emitting a
bare `ret`.

## What is left

- **Ambient stream timeouts still block their thread.** `TcpStream` with
  a `timeoutMs` or a token routes to the cancel-aware BLOCKING helpers
  rather than the async ones. Combining the two abandon mechanisms in one
  call is real work and no consumer needs it yet, so a stream with a
  timeout parks a thread while a stream without one suspends.
- **`Writable.flush` stays synchronous.** Every implementation is a
  buffer swap; making it async would color a lot of code for no
  suspension.
- **No `select`/`join` combinators.** Waiting on the first of several
  operations needs a primitive that arms multiple interests, which the
  registration table (one waiter per fd+direction) does not model yet.

## Deliberately not in this pass

- **Cancellation of a suspended coroutine mid-frame.** A cancelled task
  still runs to its next suspend point and unwinds there.
- **Async destructors.** `dispose` stays synchronous.
- **A suspended task's frame is leaked if the program exits while it is
  parked.** The scheduler only destroys a coroutine frame on completion.

