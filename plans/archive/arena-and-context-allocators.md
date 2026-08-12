# Design doc: Arena and context allocators

Status: SUBSTANTIALLY IMPLEMENTED. Stages 1, 2, 3, 4, 5, and 7 have landed
(`runtime/yoop_alloc.c`, `std/core/alloc.yoop`, the `ctxAlloc`/`ctxFree`
intrinsics, `Vec<T>` and `Deque<T>` rerouted container-owned, fixtures
`arena_context.yoop`, `arena_scope.yoop`, `arena_vec.yoop`, and the per-request
showcase `arena_request_loop.yoop`). Stage 6 (escape safety) is DELIBERATELY
DEFERRED - see Part 4.7 for why v1 is low-value given `ownsBlock` already
lexically scopes the handle, and v2 (the part that matters) needs allocator-
provenance tracking that does not exist yet. Remaining mechanical follow-up:
reroute the provenance-sensitive containers (`Bytes`, `Map` buckets) that take
ownership of buffers from mixed sources. This is the "real ergonomic win"
deferred in Part 5 of [ownership-and-typestate-redesign.md](../ownership-and-typestate-redesign.md)
(the relaxation it was gated behind has landed). It is the single foundational
piece that makes no-GC ergonomics survivable for the two target audiences:
a per-REQUEST arena for web code, a per-FRAME arena for game code.

Implementation note (deviation from this doc, for the better): Stage 3's scoped
block did NOT need a new builtin `arena` kind or any new codegen injection
point. The "install on entry" is a side effect of the constructor (`arenaScope`
calls `pushAllocator` and returns a handle carrying the previous allocator), and
the "reset on exit" rides the EXISTING `disposable` + `ownsBlock` teardown:
`ArenaScope implements Disposable`, and its `dispose` does `popAllocator` +
`arenaDestroy`. So the user writes `disposable reg: ArenaScope = arenaScope(cap)
{ ... }` and gets push-on-entry / pop+destroy-on-exit with zero compiler change.
Section 4.4 below describes the originally-planned new-kind approach; the shipped
realization is this lighter library-only one. A thinner bare `arena reg = ... {}`
keyword could still be added later as pure sugar over `ArenaScope`.

Style note: ASCII only, no em-dashes, no fancy tables, per repo convention.

---

## Context

Yoop has no garbage collector and (by deliberate choice) advisory, opt-in
ownership. The only allocation path today is `intr.heapAlloc<T>` /
`intr.heapFree<T>`, which lower straight to libc `malloc` / `free`
(`codegen.js` ~4598). Every std container (`Vec`, `Map`, heap strings) calls
`heapAlloc` directly and frees one object at a time, usually via a
`disposable` binding that injects a `dispose` at scope end.

That is the "honest no-tracking" baseline (Jai/Odin without the convenience
layer). It works, but it is per-object malloc/free for everything, which is:

- Tedious: every owning binding needs a `disposable` keyword or a manual
  `Disposable.dispose(ref x)`, and every container threads an obligation.
- Slow in the hot shapes: a web request or a game frame allocates hundreds of
  small, same-lifetime objects, then drops them all at once. Per-object free is
  the wrong tool; the right tool is "reset the whole region."

The chosen direction (ownership doc Part 4.1, Alternative E) is Jai/Odin:
keep ownership advisory, and make most cleanup VANISH by allocating
request/frame-shaped data from an arena and freeing the whole region at the
boundary. This doc is that allocator + context system.

What this is NOT: it is not a GC, not a borrow checker, and not a change to the
advisory ownership model. It is a set of allocators, an ambient "current
allocator" the standard library honors, and a scoped block that swaps it. The
one place it reaches for the typestate system is to make arena-escape a compile
error (Part 4.7) - which is exactly where Yoop's ambition is supposed to live.

---

## What we have today (the surfaces this builds on)

1. **Allocation lowering.** `heapAlloc<T>(n)` -> `@malloc(n * sizeof T)`,
   `heapFree<T>(a)` -> `@free`. Inline-emitted by `declId` in `codegen.js`
   (~4598-4663). No allocator abstraction; the call site IS libc.

2. **Scope-end injection.** The `disposable` kind
   (`std/core/kinds.yoop`: `mustCall dispose beforeScopeEnd; ownsBlock;`) makes
   codegen inject a cleanup call at the end of the binding's block. The
   machinery is `block.implicitCleanups` (stamped by `kindCheck.js`) emitted by
   `emitImplicitCleanups` / `emitCleanupCall` (`codegen.js` ~5417, ~5558), and
   the `ownsBlock` trailing-block form scopes a binding + its cleanup to an
   inner block (`codegen.js` ~5649). An arena scope reuses this exact path for
   "reset at block end."

3. **Fn-pointer-struct precedent.** `KeyOps<K> { hash: (k: K) => uint64,
   eq: (a: K, b: K) => bool }` (`std/collections/map.yoop`) with a constructor
   that names free functions (`stringKeyOps()` returns
   `{ hash: stringHash, eq: stringEq }`). An `Allocator` value is the same
   shape: a record of function pointers plus an opaque data pointer. This is
   also exactly how Jai/Odin represent an allocator (a procedure + a data
   pointer), so the idiom and the prior art agree.

4. **Escape analysis.** `mustNotEscape` / `scoped` (checked in
   `checkStatement.js` ~497-600) already rejects letting a scoped binding leave
   its block, and `mustNotShare acrossThreads` (Phase 9.J, `checkExpr.js`
   ~2307) rejects sharing across a task boundary. These are the levers that make
   an arena safe (Part 4.7).

5. **Per-thread runtime.** The concurrency runtime already runs N worker
   threads (`runtime/yoop_runtime.c`). A per-thread "current context" fits the
   existing model; cross-thread allocator sharing is exactly what
   `mustNotShare acrossThreads` is for.

6. **Raw pointers.** `unsafe_ptr<T>` (gated behind `import.unsafe`, SPEC s12)
   is the type for an allocator's opaque `data` field and for the bump pointer
   inside an arena.

---

## The design

### 4.1 The Allocator value

An allocator is a plain value: a small record of function pointers plus an
opaque data pointer. Following the `KeyOps` idiom and the Jai/Odin shape:

```yoop
// std/core/alloc.yoop
import.unsafe;

export type Allocator {
    // allocate `size` bytes aligned to `align`; returns null on failure.
    alloc:   (data: unsafe_ptr<void>, size: usize, align: usize) => unsafe_ptr<void>,
    // grow/shrink an existing block (Vec growth needs this); may move.
    realloc: (data: unsafe_ptr<void>, ptr: unsafe_ptr<void>, oldSize: usize, newSize: usize, align: usize) => unsafe_ptr<void>,
    // free one block. For arenas this is a NO-OP (the region frees in bulk).
    free:    (data: unsafe_ptr<void>, ptr: unsafe_ptr<void>) => void,
    // the allocator's own state (arena struct, pool, etc.); opaque to callers.
    data:    unsafe_ptr<void>,
}
```

The libc allocator is one instance of this:

```yoop
export function mallocAllocator(): Allocator {
    return { alloc: cMalloc, realloc: cRealloc, free: cFree, data: null };
}
```

Rationale for a record-of-fn-pointers over a `trait Allocator`: trait dispatch
in Yoop is the verbose `Trait.method(ref self, ...)` form and would require a
heap vtable; the allocator is fundamentally "a procedure plus its data," which
is precisely the record shape, and it matches the existing `KeyOps` precedent
and the Jai/Odin design. A trait can wrap it later if a use case wants dynamic
trait dispatch, but the record is the primitive.

### 4.2 The context (ambient current allocator)

The "current allocator" is ambient, stored in a per-thread context in the
runtime. This is the Odin model (effectively), chosen over Jai's implicit
context PARAMETER because it needs no ABI change and does not fight the FFI
boundary (Part 6, Alternative A).

```c
// runtime/yoop_alloc.c
typedef struct { /* alloc/realloc/free fn ptrs + data ptr */ } YoopAllocator;
typedef struct {
    YoopAllocator allocator;       // current general allocator
    YoopAllocator temp_allocator;  // per-thread scratch (Part 4.6)
} YoopContext;

// thread-local; initialized to { malloc, per-thread temp arena } on first use.
_Thread_local YoopContext yoop_ctx;
```

Surface in Yoop:

```yoop
export function currentAllocator(): Allocator;     // reads yoop_ctx.allocator
export function pushAllocator(a: Allocator): Allocator;  // set + return previous
export function popAllocator(prev: Allocator): void;     // restore
```

`pushAllocator` / `popAllocator` are the manual, un-sugared primitive. The
`arena` scope (Part 4.4) is the sugar over them.

### 4.3 The arena allocator

A bump-pointer allocator over a growable backing region. `alloc` bumps a
cursor; `free` is a no-op; `reset` rewinds the cursor (keeping the buffer for
reuse); `destroy` returns the buffer to its backing allocator.

```yoop
export type Arena {
    base:   unsafe_ptr<uint8>,
    cap:    usize,
    offset: usize,
    backing: Allocator,   // where the region itself came from (usually malloc)
}

export function arenaNew(backing: Allocator, cap: usize): Arena;
export function arenaAllocator(ref self): Allocator;  // an Allocator view over this Arena
export function arenaReset(ref self): void;           // offset = 0; memory reused
export function arenaDestroy(ref self): void;          // backing.free(base)
```

Growth policy when an alloc exceeds `cap`: grow the backing region (or chain a
new block). v1 can keep it simple (single block, abort or fall back to backing
malloc on overflow); chained-block growth is a later refinement. Alignment is
handled in `alloc` by rounding the offset up to `align`.

### 4.4 The scoped arena block (the ergonomic surface)

The common case wants "make an arena, use it for everything in this block, free
it at the end" with no manual push/pop. Reuse the `ownsBlock` machinery: a new
builtin kind `arena` (sibling of `disposable`) that injects code at BOTH ends
of the binding's block.

```yoop
function handleRequest(req: Request): Response {
    arena scratch = arenaNew(mallocAllocator(), 64 * 1024) {
        // inside this block, the context allocator IS `scratch`.
        let headers: Vec<Header> = vecNew(16);   // allocated from scratch
        let body = parseBody(req);                // its allocations: scratch too
        return buildResponse(headers, body);      // see Part 4.7 re: escape
    }
    // at block end: arenaReset/arenaDestroy fires, popAllocator restores prior.
}
```

Two injection points (this is the one new bit of codegen vs `disposable`,
which only injects at scope END):

- **On entry to the trailing block**: `pushAllocator(arenaAllocator(ref scratch))`.
- **On exit (every path, via the existing `implicitCleanups` path)**:
  `arenaDestroy(ref scratch)` then `popAllocator(prev)`.

The `ownsBlock` trailing-block form already scopes the binding and its cleanup
to the inner block and already covers all exit paths (if/switch/return); the
arena kind adds the entry push and swaps the cleanup action from `dispose` to
`arenaDestroy + popAllocator`. A lower-friction alias `with arena(cap) { ... }`
that doesn't even name the binding can be sugar over the same lowering later.

### 4.5 Routing the standard library through the context

The win only materializes if std containers allocate from the AMBIENT
allocator instead of calling `heapAlloc` directly. Two coupled changes:

1. **Allocate via the context.** A new intrinsic pair routes through
   `currentAllocator()`:

   ```yoop
   export function alloc<T>(n: usize): T[];   // currentAllocator().alloc(...)
   export function new<T>(): ref T;           // single-object convenience
   ```

   `Vec`, `Map`, and heap-string construction switch from `intr.heapAlloc`
   to `alloc`. `heapAlloc` stays as the explicit "malloc, ignore the context"
   escape hatch.

2. **Containers remember their allocator.** A `Vec` allocated from an arena
   must be freed by that arena (or, for an arena, NOT freed individually). So a
   resource container stores the allocator it was built with:

   ```yoop
   export type Vec<T> implements Disposable propagates<disposable> {
       data: T[],
       len:  usize,
       cap:  usize,
       alloc: Allocator,   // <- new: who owns my storage
       function dispose(ref self): void {
           self.alloc.free(self.alloc.data, /* self.data */);  // arena free = no-op
       }
   }
   ```

   This is the Jai/Odin "owned allocator" pattern. It keeps `dispose` correct
   regardless of which allocator built the value, and it makes the
   arena-vs-malloc distinction invisible to user code: a `disposable` Vec in an
   arena block still gets its injected `dispose`, but the arena's `free` is a
   no-op, so the region reset is the real reclamation. Idempotent dispose
   (free-then-null) keeps double-dispose harmless, exactly the discipline the
   advisory model already leans on (see the Active TODO in plans/README.md).

### 4.6 Temporary storage

A per-thread scratch arena (`yoop_ctx.temp_allocator`) for short-lived
allocations you never individually free:

```yoop
export function tempAllocator(): Allocator;   // yoop_ctx.temp_allocator
export function resetTemp(): void;            // arenaReset on the temp arena
```

Allocate scratch from temp inside a frame/request; call `resetTemp()` once at
the boundary. This is the Odin `temp_allocator` pattern and the reason "most
allocations never need a matching free." It composes with 4.4: the frame/request
arena handles owned data; temp handles disposable scratch.

### 4.7 The arena-escape safety story (where typestate earns its keep)

An arena allocation is valid only until reset/destroy. Returning or storing one
past the arena block is a use-after-free - the classic arena footgun. Yoop is
the rare language that can make this a COMPILE error, via the existing
`scoped` / `mustNotEscape` analysis. This is the in-spirit differentiator:
arenas elsewhere are "be careful"; here they can be checked.

- **v1 (planned, NOT shipped - see below):** mark the arena binding `scoped`
  (carries `mustNotEscape`) so `return scratch;` or aliasing it out is rejected.
- **v2 (the real prize, later):** allocation provenance - a value allocated
  from a scoped arena is itself treated as scoped, so `return buildResponse(...)`
  where the response points into `scratch` is rejected at the return site. This
  needs the escape analysis to track "derived from a scoped allocator," which it
  does not do today (it tracks named bindings). It is the natural next step and
  the place to invest the typestate budget.

IMPLEMENTATION DECISION (Stage 6 deferred): v1 turned out to be low-value once
the scoped block shipped as `disposable reg = arenaScope(...) { ... }`. The
`ownsBlock` trailing-block form ALREADY scopes the `reg` binding to the inner
block lexically - you cannot name it outside, so `return reg;` from the
enclosing function is impossible to write. A `scoped`-style kind would add only
the narrow extra of rejecting `let other = reg;` (aliasing the handle) and
passing `ref reg` to a non-scoped parameter. Meanwhile the hazard that actually
bites - a `Vec` or pointer whose storage is in the arena escaping the scope - is
exactly the v2 provenance case, which v1 does NOT cover. Shipping v1 would
advertise "the arena can't escape" while the data still can, which is worse than
being explicit about the gap. So v1 is intentionally NOT implemented; the honest
contract for now (same as Jai/Odin) is: do not let arena-allocated data outlive
the scope. v2 provenance is where escape safety should actually land.

### 4.8 Interaction with `disposable` and the ownership model

Nothing here changes the advisory model. Concretely:

- A `disposable` binding inside an arena block still gets its injected
  `dispose`; the arena allocator's `free` is a no-op, so the injection is
  harmless and the region reset is the actual reclamation.
- A value you want to keep past the block must be allocated from a longer-lived
  allocator (pass an explicit `Allocator`, or `pushAllocator` a non-arena one
  for that allocation). Containers carrying their own allocator (4.5) make this
  unambiguous.
- `propagates<disposable>` stays advisory. No new errors on the ownership side.

### 4.9 Concurrency

Each worker thread has its own `yoop_ctx` (thread-local), initialized to
`{ malloc, fresh temp arena }`. An arena is single-threaded by construction;
sharing one across a task boundary is the exact hazard `mustNotShare
acrossThreads` exists for, so an `Arena` (and the `Allocator` view over it)
should carry that marker. A spawned task gets the worker's default context, not
the spawner's arena - explicit allocator passing is required to share, and the
marker makes accidental sharing a compile error.

---

## Web and game payoffs (why this is the foundational unlock)

Web (the native audience): the `std/http` server installs a per-request arena
around each handler. Parsed headers, the body view, response buffers, and any
per-request `Vec`/`Map` allocate from it; the arena resets after the response is
written. Handlers stop threading `disposable` through everything; a request's
entire allocation graph drops in one reset. This is how high-throughput servers
in Zig/Jai/C++ are actually written.

Game (the ambitious second audience): a per-frame arena reset at end of frame,
plus the temp allocator for within-system scratch. No GC pauses (the #1 reason
games avoid managed languages), deterministic memory, and the frame boundary as
the natural reclamation point. Pairs later with the compile-time-ECS idea, which
wants exactly this frame-scoped allocation discipline.

Both audiences get the same primitive; only the boundary differs
(response-end vs frame-end). That is why this is one foundational feature, not
two.

---

## Alternatives considered

### Alternative A: Jai-style implicit context PARAMETER

Add an implicit `context` argument to every function's ABI; `push_context`
swaps it for a scope. Most powerful (the allocator travels with the call graph
automatically, visible and overridable everywhere). REJECTED as the mechanism:
it is a pervasive ABI change, it complicates every FFI boundary (C functions
take no context), and it is a large amount of codegen work for a property
(ambient allocator) that a thread-local delivers at a fraction of the cost. The
thread-local IS the context; we just don't thread it as a parameter.

### Alternative B: Explicit allocator parameter on every allocating function

`vecNew(alloc, cap)`, `mapNew(alloc, ...)`. Maximally explicit, no global
state, trivially correct. REJECTED as the DEFAULT because it is viral and
verbose - every call site and every intermediate function grows an `Allocator`
parameter, which is exactly the ceremony we are trying to remove. KEPT as an
escape hatch: allocating functions can offer an explicit-allocator overload for
code that wants to be unambiguous (this is the Odin hybrid: ambient by default,
explicit when you ask).

### Alternative C: Status quo (libc malloc only)

What we have. REJECTED: it is the gap. Per-object malloc/free is the wrong tool
for request/frame-shaped lifetimes and is the main reason no-GC feels heavy for
the target audiences.

### Alternative D: A garbage collector

Against the spirit and explicitly out of scope (plans/README.md). Not
considered further.

---

## How it could land (staged)

1. **Allocator value + runtime + manual context.** `Allocator` type,
   `mallocAllocator`, the C `yoop_alloc.c` with thread-local `yoop_ctx`,
   `currentAllocator` / `pushAllocator` / `popAllocator`. No std rerouting yet.
   Provable in isolation with a manual push/pop test.
2. **Arena allocator.** `Arena`, `arenaNew`/`arenaAllocator`/`arenaReset`/
   `arenaDestroy`. Unit-test bump/reset directly.
3. **The `arena` scope kind.** New builtin kind reusing `ownsBlock`, with the
   added entry-push injection. Lower `arena x = ... { ... }` to
   push-on-entry / destroy+pop-on-exit. This is the one real codegen addition.
4. **Route std through the context.** `alloc<T>` / `new<T>` intrinsics;
   switch `Vec`/`Map`/heap-string to `alloc`; add the `alloc: Allocator` field
   to resource containers; make arena `free` a no-op. The big-but-mechanical
   change.
5. **Temp storage.** `tempAllocator` / `resetTemp` over a per-thread temp arena.
6. **Escape safety v1.** Mark the arena handle `scoped`; confirm handle-escape
   is rejected. Document the v1 gap (values pointing into the arena).
7. **Showcase.** Per-request arena in the `std/http` server path; a frame-arena
   example program. These are the proofs the foundational claim is real.

Later / parallel: escape-safety v2 (allocation provenance), chained-block arena
growth, a debug tracking allocator (deferred per the ownership doc), and a
`trait Allocator` wrapper if dynamic dispatch is ever wanted.

---

## Open questions

Decisions already made (ownership doc Part 6, carried forward):
- Context system lands AFTER the relaxation. (Relaxation has landed; this is
  now in scope.)
- Keep `ownsBlock`-style early scoping for the keyword case.
- No runtime tracking allocator for now (it is on the "later" list above).

New questions for this doc:

- **Ambient mechanism: thread-local context (recommended) vs implicit param.**
  This doc recommends thread-local. Confirm, or decide the implicit-param power
  is worth its cost.
- **Container-owned allocator (recommended) vs free-against-ambient-context.**
  Storing `alloc: Allocator` on resource containers is correct but grows every
  container struct by one field and threads through every constructor. The
  alternative (free against whatever the context is at dispose time) is smaller
  but fragile (wrong if the context changed). Recommend container-owned;
  confirm the per-struct cost is acceptable.
- **Scope syntax.** `arena x = arenaNew(...) { ... }` (kind + ownsBlock, reuses
  everything) vs a dedicated `with arena(cap) { ... }` keyword. Recommend the
  kind form first (least new surface), sugar later.
- **Escape safety timing.** Ship v1 (handle scoped) with the block and defer v2
  (provenance), or hold the scope feature until v2 so we never advertise a
  partial guarantee? Recommend ship v1, document the gap.
- **OOM policy.** `alloc` returns null on failure (caller checks) vs abort.
  Recommend null-returning at the allocator boundary, with a checked `alloc`
  wrapper that the `?`-style flow can consume; confirm.
- **Realloc in the interface.** Included above because `Vec` growth needs it.
  Confirm it belongs in the core `Allocator` record vs a separate capability.

---

## Critical files (for implementation)

- **New**: `std/core/alloc.yoop` - `Allocator`, `Arena`, `mallocAllocator`,
  `arenaNew`/`arenaAllocator`/`arenaReset`/`arenaDestroy`, `currentAllocator`/
  `pushAllocator`/`popAllocator`, `tempAllocator`/`resetTemp`, `alloc<T>`/
  `new<T>`.
- **New**: `runtime/yoop_alloc.c` (+ `.h`) - thread-local `yoop_ctx`, the C
  bump-arena, the malloc allocator fn-pointer targets, temp-arena init.
- **Edit**: `src/jsyooptypecheck/builtinKinds.js` - the `arena` builtin kind
  (entry-push + exit-reset, `ownsBlock`, `mustNotShare acrossThreads`, scoped).
- **Edit**: `src/jsyooptypecheck/kindCheck.js` - stamp the arena binding's
  entry-push and exit-cleanup the way `disposable` stamps `implicitCleanups`.
- **Edit**: `src/jsyoopcodegen/codegen.js` - emit the entry `pushAllocator`
  for an `arena` binding (the one genuinely new injection point); reuse
  `emitImplicitCleanups` for the exit `arenaDestroy + popAllocator`; lower
  `alloc<T>`/`new<T>` through `currentAllocator`.
- **Edit**: `std/core/vec.yoop`, `std/collections/map.yoop`, heap-string
  construction - allocate via `alloc`, carry `alloc: Allocator`, free through it.
- **Edit**: `src/yoopiler.js` / `src/runtimeBuild.js` - add `yoop_alloc.c` to
  the clang invocation and link flags.
- **Edit**: `std/http/server.yoop` (showcase) - install a per-request arena.
