# Phase 10 — Library completion, foundation generics, runtime polish

> Phase 9 closed the *syntax* workarounds that real yoop code kept hitting:
> parens, `bool[]`, `for ... in`, slice syntax, vtables, `?` over enums,
> suspendable wait. Phase 10 closes the *library* workarounds. The single
> biggest unlock is **generic enums** — once that lands, `Option<T>`,
> `Result<T, E>`, and `Iterable<T>` become expressible and the
> `std/collections/` module can grow `Map<K, V>`, `Set<K>`, `Deque<T>`
> with one consistent iteration story.
>
> Phase 10 is also where the long tail of small "deferred" items from
> Phases 5–9 finally land: `extends` on traits, multiple trait bounds,
> `mustNotShare acrossThreads`, codegen-side pattern-binding renaming,
> cross-shape `?`, cancellation tokens, `std/log` + `std/debug`. Optimization
> passes and self-hosting (originally the only stated scope for Phase 10
> in [plans/roadmap.md](roadmap.md)) move to the *end* of this phase: the
> JS bootstrap isn't worth porting until the surface it implements is
> something a self-hosted compiler would also want to expose.

## Context — what got deferred and where

Every completed phase doc has a "Deferred" / "Out of scope" section.
Grouping those across the 30+ docs in [plans/completed/](completed/),
plus [SPEC.md §16-17](../SPEC.md) and
[library-design.md §8-9](library-design.md), the deferrals cluster around
a small number of root causes:

- **Generic enums.** Surfaces in at least three phase docs:
  - [phase-7-5-sum-types-and-unions.md](completed/phase-7-5-sum-types-and-unions.md)
    deferred them at the decl site (parser accepts `enum Foo<T>`, typechecker
    rejects).
  - [phase-9-d-for-in.md](completed/phase-9-d-for-in.md) deferred the
    `Iterable<T>` trait + `IterStep<T>` enum because the enum side wasn't
    expressible.
  - [library-design.md §9](library-design.md) lists `std/collections/`
    as waiting on generic enums for `Result<T,E>`-shaped errors.
  This is the **highest-leverage gap** in the whole codebase right now.
- **Iteration trait + user-type `for ... in`.** Blocks any `Map<K,V>` /
  `Deque<T>` from participating in the existing `for ... in` loop slot.
- **Cross-shape `?` propagation.** Every `std/http` + `std/net` function
  uses `err: string` struct-fallibles; new enum-fallibles can't `?` into
  them without explicit unwrapping.
- **Real collections.** `Headers` is a linear-scan vec today; everywhere
  else that wants a hash table either rolls its own or stays O(n).
- **Concurrency tail.** Cancellation, deadlines, the
  multiplexer-integrated-timers backend, true coroutine-based wait — all
  named in the Phase 8.F sub-phase docs.
- **Reserved syntax.** `extends` on traits, multiple trait bounds
  `<T implements (A, B)>`, `mustNotShare acrossThreads` — Phase 9.J on
  the menu, still pending.
- **Codegen quality.** Pattern-binding name collisions across switch arms
  and re-entrant loops surface as cryptic LLVM `multiple definition`
  errors; tightening alloca naming would retire a whole class of
  user-visible breakage.
- **Diagnostics.** Several `// todo better error messages` markers in
  the parser tests; nothing systemic yet.
- **Self-hosting prep** (the original Phase 10 scope from
  [plans/roadmap.md](roadmap.md)). Const folding, a pre-built runtime
  `.o`, and the actual port live at the *end* of Phase 10.

What already exists and is reusable (do not redesign):

- The Phase 7.1 instantiation registry (`src/jsyooptypecheck/instantiate.js`)
  already lazily monomorphizes generic structs and functions and could
  absorb generic enums with little surgery — the `EnumType` shell stored
  in `enumTable` doesn't yet hold `paramNames`/`paramScope`, but the
  scaffolding is right there.
- Phase 9.G vtables give `Iterable<T>` an immediate type-erased home —
  a `Reader`-style `vtable Iter<T> for Iterable<T>` would let
  heterogeneous iterator pipelines work the same way handler lists do
  today.
- Phase 8.F's park/unpark primitives in the runtime already cover the
  shape every cancellation/deadline addition needs.
- Phase 9.H's fallible-enum support is the structural recognizer that
  cross-shape `?` extends from.

## Recommended approach

Same shape as Phase 9: each sub-phase is intended to become its own
self-contained plan doc (e.g. `plans/phase-10-a-generic-enums.md`) when
it's picked up. Order matters — the early items unblock the heavier
ones. **Sub-phase 10.A is the longest pole**; once it ships, 10.B and
10.C become routine library work.

### Phase 10.A — Generic enums

The single biggest unlock. Without this nothing in the `std/collections/`
story works.

- Lift the typechecker rejection at
  [src/jsyooptypecheck/typecheck.js:1264-1268](../src/jsyooptypecheck/typecheck.js#L1264-L1268)
  (`"generic enums are not yet supported (deferred)"`). Path: register
  `enum Foo<T> { ... }` in a `genericEnumTable` sibling to
  `genericStructTable`/`genericFuncTable`/`genericTraitTable` (Phase 7.1
  pattern); resolve variant payload field types with a type-param scope;
  store an "open" `EnumType` whose variant payloads carry `TypeParamType`
  placeholders.
- Extend [instantiate.js](../src/jsyooptypecheck/instantiate.js) with
  `instantiateEnum(registry, genericEnum, argTypes)` that mirrors
  `instantiateStruct` — same caching shape keyed on `(declId, argTypes)`,
  same `substituteTypeParams` walk, same registry registration.
- Variant-constructor resolution (`Result<int32, string>.Ok { value: 5 }`):
  treat `Result<int32, string>` as a `typeApplication` annotation that
  resolves to the instantiated enum type, then the existing
  `VARIANT_CONSTRUCTOR` path runs unchanged.
- Codegen: the existing `ENUM_DECL` emission walks `d.resolvedType` to
  pick a payload-byte size. Generic enums need that to run from the
  *registry* (one LLVM type per instantiation, mangled
  `%enum.<mod>__<E>__<arg1>__<arg2>`) — same pattern as the Phase 7.1
  generic-struct codegen.
- E2E: `enum Result<T, E> { Ok { value: T }, Err { error: E } }` in
  `std/core/`, with a fixture round-tripping `IntResult = Result<int32, int32>`
  and proving that Phase 9.H's `?` still works against the new shape.

Once this lands, every later item gets cheaper.

### Phase 10.B — `Iterable<T>` trait + `for ... in` over user types ✓ landed

See [phase-10-b-iterable.md](completed/phase-10-b-iterable.md). Generic
`Iterable<T>` + `IterStep<T>` live in
[std/core/traits.yoop](../std/core/traits.yoop); the typechecker accepts
any struct with an `Iterable<U>` impl as the RHS of `for ... in` and
codegen lowers to a `call next → tag-branch` loop. Below is the original
spec for reference.

Phase 9.D shipped `for x in xs` for arrays only because `Iterable<T>`
needed generic enums for its return shape (`enum IterStep<T> { Yield { value: T },
Done }`). 10.A unblocks the trait; 10.B wires it in.

- Add `Iterable<T>` (or `Iterator<T>` — pick one name) in
  [std/core/traits.yoop](../std/core/traits.yoop):
  ```yoop
  enum IterStep<T> { Yield { value: T }, Done }
  trait Iterable<T> {
      function next(ref self): IterStep<T>;
  }
  ```
- Typechecker `for x in EXPR`: when EXPR's resolved type isn't `T[]`,
  look for an `Iterable<U>` impl on the type and bind `x: U`. The body
  desugars to `while (true) { switch (Iterable.next(ref iter)) { case Yield { value: x }: ...; case Done: break; } }` —
  the lowering shape is exactly Phase 7.5 + Phase 9.D composed.
- The array iterator stays compiler-provided: a builtin `Iter_array<T>`
  struct holding `{xs: T[], i: usize}` whose `next` advances `i`. Users
  never see it; the existing array path stays the fast path.
- The `vtable Iter<T> for Iterable<T>` form lets generic functions take
  `ref it: Iter<T>` instead of `<I implements Iterable<T>>`, which is the
  natural shape for heterogeneous pipelines (`from_db().map(...).filter(...).collect()`).
  Note: this depends on **generic-trait vtables**, which Phase 9.G
  rejected — so either 10.B blocks on lifting that restriction
  (small surgery, see [phase-9-g-vtables.md:154](completed/phase-9-g-vtables.md))
  or 10.B ships with concrete iterators only and the vtable form follows.

### Phase 10.C — `std/collections/`: Map, Set, Deque ✓ landed

See [phase-10-c-collections.md](completed/phase-10-c-collections.md).
The first sub-cut shipped `Option<T>`, a string-keyed
`StringMap<V>` (open-addressing hash table) with `Option<V>`-returning
lookups, and two codegen fixes that any generics-heavy module needed
(`cloneAstWithSubstitution` variant re-fetch, fixed-point generic
emission).

Phase 10.X.2 ([phase-10-x2-fn-ptr-fields.md](completed/phase-10-x2-fn-ptr-fields.md))
then landed the two function-pointer-field lifts the original 10.C
plan called out as the precondition for a fully generic `Map<K, V>`:
function-decl → FPT coercion at assignment, and indirect call
lowering for FPT-typed struct fields. Phase 10.C.2
([phase-10-c-2-generic-map.md](completed/phase-10-c-2-generic-map.md))
shipped generic `Map<K, V>` itself — keyed off a `KeyOps<K>` ops
struct, with pre-built `string_key_ops()` and `int32_key_ops()`
helpers. Phase 10.C.3
([phase-10-c-3-collections-rest.md](completed/phase-10-c-3-collections-rest.md))
wrapped up the rest: `Set<K>`, `Deque<T>`, `for entry in
map_iter(ref m)` (via a new `MapEntry<K, V>` + `MapIter<K, V>`
implementing `Iterable<MapEntry<K, V>>`), and the int64/uint64/bytes
KeyOps helpers — plus four compiler-side fixes container code
surfaced (cross-module per-instance fixed-point, struct
instantiation substituting methods + traits, trait-method re-mangle
after substitution, nested generic type-args in `implements`
clauses, and reserving `entry` as a slot-name to avoid LLVM
basic-block collisions).

Headers migration to `Map<string, string>` remains deferred — the
linear-scan vec is fine for small N, and the case-insensitive +
multi-value semantics warrant their own sub-phase.

Once `Iterable<T>` exists, write the collections.

- **`Vec<T>`** — already partially there in
  [std/core/vec.yoop](../std/core/vec.yoop). Audit for `Iterable<T>`
  impl, `Display` impl where reasonable, and any rough edges that show
  up once it has real downstream users.
- **`Map<K, V>`** — open-addressing hash table is the right starting
  point (one allocation, cache-friendly). New trait:
  ```yoop
  trait Hashable {
      function hash(ref self): uint64;
      function eq(ref self, ref other: Self): bool;
  }
  ```
  Provide `Hashable` impls for `int32`, `int64`, `uint64`, `string`, and
  `bytes`. The `Self` type appearing in the `eq` signature needs
  [phase-5 deferred work](completed/phase-5-traits.md) — if `Self` isn't
  in by then, write `eq(ref self, ref other: Map<K,V>)` per concrete
  use site as a stopgap.
- **`Set<K>`** — falls out of `Map<K, void>`-style implementation; ship
  as a thin wrapper.
- **`Deque<T>`** — ring buffer over a `Vec<T>`. Useful enough for an
  HTTP server's accept queue or any work-stealing pattern to justify the
  ~150 lines.
- Migrate `std/http/Headers` from its linear-scan vec
  ([library-design.md §8.4](library-design.md)) to `Map<string, string>`
  with a benchmarked switchover (the small-N hot-path probably stays
  linear; only the case-insensitive form benefits from real hashing).

### Phase 10.D — `std/log` + `std/debug` ✓ landed

See [phase-10-d-debug-log.md](completed/phase-10-d-debug-log.md).
`std/debug` exposes `panic`/`unreachable`/`assert`; `std/log` exposes
`info`/`warn`/`error`. Each delegates to a C helper in
`runtime/yoop_debug.c`. Release-mode `assert` gating + structured/
alternate-sink logging remain deferred to follow-ups.

Tiny modules; explicitly named as Phase-10-ish in
[library-design.md §9](library-design.md).

- **`std/debug`**: `assert(cond, msg)`, `unreachable(msg)`, `panic(msg)`.
  Each terminates the process after writing to stderr. `assert` becomes
  a no-op when `YOOP_RELEASE=1` (env-gated at codegen time). Compose
  with the existing `_ = f();` discard so panics on the failure branch
  of `?` aren't second-class.
- **`std/log`**: `info` / `warn` / `error` free functions plus a
  `Logger` trait. Default sink is stderr; an env var (`YOOP_LOG_SINK=file:/var/log/app.log`
  or `tcp:host:port`) selects an alternate. JSON output gated on a
  `--structured` runtime flag. Implementations of `Display` (which
  9.F lifted into template literals — *if 9.F has shipped by then*; if
  not, ship it here as a prerequisite) drive value formatting.

### Phase 10.E — Cross-shape `?` propagation via `Into<T>` ✓ landed

See [phase-10-e-cross-shape-qmark.md](completed/phase-10-e-cross-shape-qmark.md).
A new `Into<T>` trait in [std/core/traits.yoop](../std/core/traits.yoop)
is implemented on the operand-Err type (`IoError implements
Into<AppError>`); `resolveTryOp` looks for it whenever the operand and
return Err payload types disagree, and codegen calls the impl's `into`
method on the failure branch before building the outer `Err` variant.
The earlier 9.H same-type fast path is unchanged. Reserved context-string
suffix and bidirectional `From<S>` form remain deferred.

### Phase 10.F — Cancellation tokens, deadlines, multiplexer timers

The Phase 8.F sub-phase docs explicitly defer these to a follow-up.
With the multiplexer + park/unpark already in, each one is a small
typed wrapper.

- **Cancellation.** External half ✓ landed
  ([phase-10-f-2-a-external-cancel.md](completed/phase-10-f-2-a-external-cancel.md))
  — `cancel(h)` is a builtin call form that sets the handle's cancel
  byte (reuses one of the pre-existing prefix padding bytes — no ABI
  change) and broadcasts so any `wait_until` parked on the handle wakes
  immediately and observes a new `WaitResult.Cancelled` variant. The
  task body keeps running to natural completion; cancellation is
  caller-side "abandon the wait" semantics. Cooperative in-body polling
  (the implicit `cancellation: ref Cancel` parameter) and the
  `h.cancel()` method-style sugar from the original sketch are deferred
  to 10.F.2.b — they need a synthesized task-body parameter + an
  identifier-resolution special case that this sub-phase didn't tackle.
- **Deadlines ✓ landed.** See
  [phase-10-f-1-deadlines.md](completed/phase-10-f-1-deadlines.md).
  `wait_until(h, deadline_ns): WaitResult<T>` from
  [std/core/concurrency.yoop](../std/core/concurrency.yoop) is a
  builtin call form parallel to the `wait` keyword; returns
  `Done { value: T }` on completion or `Timeout` on deadline expiry.
  The `Cancelled` variant from the original sketch waits for the
  cancellation sub-phase — when it lands, `WaitResult` grows the third
  variant additively. The 25ms safety poll inside `yoop_task_wait` also
  came out as part of this sub-phase: handle-done broadcasts cover
  bare-wait wakeups deterministically.
- **Multiplexer-integrated timers.** The original bullet asked for a
  `timerfd` / `EVFILT_TIMER` integration to drop the 25ms poll. What
  the deadlines sub-phase actually did was eliminate the poll by
  trusting the broadcast path; the timer-event-source integration is
  still open and useful for sharing one I/O thread across `sleep_ms`
  and any future deadline-driven primitive, but no longer urgent for
  bench correctness.

### Phase 10.G — Reserved-syntax cleanup (Phase 9.J carryover)

A grab bag of small items still rejected at the parser. None individually
is big enough to deserve its own sub-phase; bundling clears the
backlog.

- **`extends` on traits** ([SPEC §5](../SPEC.md), parser rejects at
  `src/jsyooparser/parser.js`). When `T implements BatchIterable`, the
  typechecker also requires `T implements Iterable`. Method resolution
  walks the chain.
- **Multiple trait bounds `<T implements (A, B)>`**. Resolution checks
  *every* bound's methods; instantiation rejects when any bound is
  unsatisfied. Mostly extending the existing single-bound machinery
  from [phase-7-2-trait-bounds.md](completed/phase-7-2-trait-bounds.md).
- **`mustNotShare acrossThreads`**. Partner of `mustNotShare acrossScopes`
  (already in). With Phase 9.I's suspendable wait, "another thread" is
  now a meaningfully different scope: a value carrying this kind cannot
  flow into a `task` body. One flag on the kind + a check in the task-call
  lowering path.

### Phase 10.H — Codegen quality + diagnostics

Items that are user-visible but never had a forcing function.

- **Per-binding alloca uniqueness** ✓ landed — see
  [phase-10-h-alloca-uniqueness.md](completed/phase-10-h-alloca-uniqueness.md).
  Original problem statement, kept for reference: `let x` in two
  disjoint blocks, or two `case ... { ... v: int32 ... }` arms in the
  same `switch`, produced duplicate `%x = alloca` lines and LLVM
  rejected the module with `multiple definition of local value 'x'`.
  Fixed via `createLocalSymbols` + a scope-aware slot map; references
  resolve via `symbols.slotFor(name)` and shadowing snaps back when an
  inner scope exits.
- **Pattern-binding diagnostics.** When the collision above happens,
  emit a yoop-level error pointing at both sites, not the LLVM message.
- **Better parse-error messages.** Several `// todo better error messages`
  markers in [src/jsyooparser/parser.test.js](../src/jsyooparser/parser.test.js).
  Most are one-line fix-it strings.
- **`SWITCH_STATEMENT` + `break`/`continue` integrated into the Phase
  6.4 propagates-path-coverage merge** (named as a known gap in
  [CLAUDE.md](../CLAUDE.md) cross-cutting invariants).
- **Array bounds checking** as a `YOOP_BOUNDS_CHECK=1` codegen opt-in
  ([phase-4-refs-arrays-control-flow.md](completed/phase-4-refs-arrays-control-flow.md)
  defers it; useful for the self-hosted phase to catch its own bugs).

### Phase 10.I — Networking polish (depends on 10.A + 10.E)

The library-design doc's Phase E. Each item here was named as
"deferred" in [library-design.md §8](library-design.md) or in the
per-library-phase docs.

- **Streaming bodies.** `Request.body: Reader` (the Phase 9.G vtable)
  + `content_length: ?usize` (an `Option<usize>` — needs 10.A). The
  HTTP parser switches to taking one `Reader` instead of monomorphizing
  per stream type.
- **`Router`.** Trie-style path matching over a heterogeneous
  `Dispatcher[]` (the exact shape Phase 9.G demoed). Method + path
  pattern → handler.
- **`Client`.** Generic `Client.send(req): Response` over a connection
  pool. Pool size + idle timeout from env.
- **Connection pool + keep-alive + pipelining.** Per-host pool keyed
  on `(scheme, host, port)`; `Deque<TcpStream>` for the pool itself
  (depends on 10.C). Pipelining gated behind a config flag.
- **TLS.** Pick an OpenSSL or BoringSSL binding; expose a
  `TlsStream implements Readable + Writable + Disposable` that drops
  into every existing place a `TcpStream` does. Out of scope for
  Phase 10 if a real consumer hasn't emerged.
- **HTTP/2 + HTTP/3.** Off the menu for Phase 10. Note in the plan
  doc as Phase 11 if/when it lands.
- **IPv6 + URI authority parsing**
  ([library-phase-b-net.md](completed/library-phase-b-net.md)).
  IPv4-only parsing is the current limitation; lift it as a small
  patch alongside 10.I.

### Phase 10.J — Compiler optimization passes

The first half of the original Phase 10 charter. Now that there's a
real surface to optimize, these become worthwhile.

- **Const folding.** A single mid-typecheck pass that replaces
  literal-arithmetic subtrees with their values; everything else
  benefits. Easy win, ~200 lines.
- **Dead-store elimination + load forwarding** at the basic-block
  level. Without these the trivial `let x = y; use(x);` shape emits
  an alloca + store + load triplet.
- **Inlining of small trait method calls.** Generics already
  monomorphize; the resulting LLVM IR has redundant function-call
  boundaries that `clang -O1` already handles — verify before adding
  yoop-side inlining.
- **`@yoop_runtime_*` link-time inlining.** Today every translation
  unit re-compiles `runtime/yoop_runtime.c`. Build it once as
  `libyoop_runtime.a`, link against that, skip the per-program clang
  recompile. Surfaces in [phase-6-3-prelude.md](completed/phase-6-3-prelude.md).

### Phase 10.K — Self-hosting bootstrap

The second half of the original Phase 10 charter, and the entire point
of having shipped the JS bootstrap at all.

- **Strategy**: rewrite the JS bootstrap, file-by-file, in yoop. Pick
  the lexer first (smallest surface, no recursive types). Then parser,
  then typechecker, then codegen. The JS bootstrap compiles the yoop
  version; the yoop version then compiles itself (`stage1.yp →
  stage2.bin`); `stage2.bin` re-compiles itself (`stage2 → stage3`);
  `stage2` and `stage3` must be byte-identical (the classic bootstrap
  fixed-point check).
- **Pre-requirements**: 10.A (generic enums — the AST is full of them),
  10.C (collections — the symbol tables want `Map`), 10.D (debug — the
  bootstrap needs `assert`/`panic`), 10.H (alloca uniqueness — the
  bootstrap will hit the limit fast).
- **Optional but desirable**: 10.J for compile speed (the self-hosted
  compiler is the worst-case workload for the codegen path).
- The bootstrap's first acid test: compile the existing
  [examples/pass/](../examples/pass/) fixtures bit-for-bit identically
  to the JS bootstrap. Discrepancies are bugs in the yoop version.

## Out of scope here (and why)

These come up in adjacent discussions but **do not** land in Phase 10:

- **Classes, inheritance, methods attached to bare types.** SPEC §16.
  Permanently no — traits + free functions cover the design space.
- **Garbage collection.** SPEC §16. The kind system (`mustCall`,
  `mustNotEscape`, `dispose`) is the lifetime story; GC is a different
  language.
- **Closures with captures.** Library-design §8 q3 explicitly defers
  indefinitely; the vtable + hand-rolled-capture-struct workaround
  remains official.
- **`match` as an expression.** Phase 7.5 deferred. Wait for a real
  forcing program — most uses today are statement-shaped already.
- **Range patterns / `|` patterns / guards in `switch` arms.** Phase
  7.5 deferred. Same rationale — speculative complexity without a
  motivating program.
- **HTTP/2, HTTP/3, QUIC.** Phase 11+.
- **Windows IOCP backend.** CI matrix is Linux + macOS. Cross-compile
  to Windows works today; full multiplexer support waits for a Windows
  user.
- **Header parsing (`extern "C" from "stdio.h"`).** Phase 3 deferred.
  Manual `extern` blocks are tractable; auto-parsing the C standard
  library is a meaningful binding-generator project.
- **Bit-fields, anonymous inline unions in structs.** Phase 8.B
  deferred. FFI niche; revisit when a real binding needs them.
- **`mustCall fn beforeAny`/`afterAny`, `mustCall { a; b; }`
  disjunction.** Phase 6.1 deferred. No motivating use.
- **`abandon` operator.** Phase 6 deferred. Same.
- **A package manager.** SPEC §16. Relative-path imports + the Phase
  9.C `std/` root cover the design space until somebody needs a
  shared registry.

## Critical files (existing)

- [SPEC.md](../SPEC.md) — section 5 (traits + `extends`), section 6
  (kinds + `forbids`), section 8 (cancellation, deadlines), section 11
  (`?` cross-shape) all get edits as Phase 10 sub-phases land. SPEC §16
  needs the "generic user types" line retired and a paragraph added
  for `Map`/`Set`/`Deque`.
- [library-design.md §8](library-design.md) — Phase 10 retires open
  questions 1 (closures: deferred indefinitely → mark explicit),
  3 (function values: settled by 9.G), 4 (Map / hash collections: 10.C),
  5 (Display in templates: 9.F or 10.D), 7 (`?` over enums: 9.H + 10.E).
- [plans/roadmap.md](roadmap.md) — the existing two-line "Phase 10:
  optimization passes + self-hosting" entry expands to point at this
  doc and the per-sub-phase docs once they're written.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js),
  [instantiate.js](../src/jsyooptypecheck/instantiate.js),
  [checkExpr.js](../src/jsyooptypecheck/checkExpr.js) — touched by
  10.A, 10.B, 10.E, 10.G.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) —
  touched by 10.A (generic-enum monomorphization), 10.H (alloca
  uniqueness, bounds checks), 10.J (const folding, dead-store removal).
- [runtime/yoop_runtime.c](../runtime/yoop_runtime.c) — touched by
  10.F (cancellation, deadlines, multiplexer-integrated timers) and
  10.J (libyoop_runtime.a pre-build).
- [std/core/](../std/core/), [std/net/](../std/net/),
  [std/http/](../std/http/) — receive the migrations from manual
  collections to `Map`/`Set`/`Deque` (10.C → 10.I).

## Verification

Per-sub-phase contract is the same as Phase 9: each sub-phase ships
with (1) a negative test for the shape that used to fail, (2) a
positive end-to-end test in [src/e2e.test.js](../src/e2e.test.js)
demonstrating the new form, (3) a doc migration that visibly removes a
"deferred" diagnostic or workaround. The full-phase acid test is the
self-hosting check at 10.K — `stage2` and `stage3` byte-identical means
every prior sub-phase's behavioral contract holds under the
self-compiled compiler.

## What lands first

Generic enums (10.A) unblocks the most downstream work and is the
right starting point. After that the order is roughly priority-by-DX:

- **10.A (generic enums)** — week of focused work, ~600 LOC across
  typechecker + codegen. Unblocks 10.B, 10.C, 10.E, 10.I, 10.K.
- **10.B (Iterator)** — couple of days; pure typechecker desugar +
  std/core stub.
- **10.C (collections)** — ~1-2 weeks; ~1500 LOC of yoop in
  `std/collections/` + `Hashable` impls + tests. Big but mechanical.
- **10.H (alloca uniqueness + diagnostics)** — independent of 10.A;
  can land in parallel as a defensive measure.
- **10.D (log + debug)** — small; ships when needed.
- **10.G (Phase 9.J cleanup)** — independent; can interleave.
- **10.E (cross-shape `?`)** — small; lands once 10.C consumers want
  it.
- **10.F (cancellation + deadlines + real timers)** — runtime-shaped;
  can land in parallel with library work.
- **10.I (networking polish)** — depends on 10.A + 10.E.
- **10.J (optimization)** — once there's a self-hosted compiler
  generating workload.
- **10.K (self-host)** — last. The point of every prior phase.
