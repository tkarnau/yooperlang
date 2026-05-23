# Phase 9 — Syntax and ergonomic completion

> The language has reached the point where everything the spec promises is *technically expressible*, but real programs (the SDL playground demo, the std/http server) are full of workarounds papering over small holes. Phase 9 is the cleanup pass: the next batch of language work picked specifically because each item either **unblocks a syntax form already in [SPEC.md](../SPEC.md)** or **eliminates a workaround that has shown up more than once in real yoop code**.
>
> This phase is *not* self-hosting and *not* optimization. Those are Phase 10. Phase 9 is the last batch of "the surface should already do this" work before the JS bootstrap is good enough to start porting itself.

## Context

Phases 1 through 8 (plus library phases A–D) have landed: typechecker, structs, errors-as-values, modules + FFI, refs / arrays / control flow, traits, kinds, generics + trait bounds, trait-qualified calls, sum types + unions, the full Phase 8 networking prerequisites (unsafe_ptr, c_int aliases, buffer interop, errno, module-level state, suspension + multiplexer + timers, string/bytes/Vec), and the four library phases (std/core, std/net, std/http types + parser, std/http server). See [plans/completed/](completed/) for the per-phase plan documents.

What's left in the friction-finding pass:

- **The SDL demo** ([examples/playground/sdl_demo/main.yoop](../examples/playground/sdl_demo/main.yoop)) has explicit comments calling out language gaps:
  - *"Velocity ranges are distributed because the parser does not yet accept parenthesized subexpressions"* — `(r - 20) * 0.02` had to become `r * 0.02 - 0.4`.
  - *"`bullet_active` is 0/1 instead of a bool array because the language doesn't have a bool[] yet"*.
  - Three identical 8-line draw blocks for the three balls because there's no `for ball in balls` form.
- **[library-design.md §8](library-design.md#8-open-language-questions-the-library-exposes)** enumerates the gaps the std library exposes: trait-object parameters, function value types, streaming bodies, Display in templates, the `std/` import root, `?` over enums.
- **[SPEC.md §16](../SPEC.md#16-whats-intentionally-not-here) deferrals** that are no longer load-bearing: `extends` on traits (parser still rejects), multiple trait bounds `<T implements (A, B)>` (parser rejects), `mustNotShare acrossThreads` (parser rejects).
- **The concurrency safety section** ([SPEC.md §8](../SPEC.md#safety-and-deadlock)) warns about worker-pool deadlock when `wait` nests inside task bodies; the planned mitigation is suspendable `wait`, still unimplemented.

What already exists and is reusable (do not redesign):

- Parser + typechecker + codegen pipeline that is comfortable absorbing new postfix / prefix expression forms (every Phase 8 sub-phase added one).
- Generic monomorphization + trait bounds (Phase 7.1, 7.2) — `vtable`-style runtime polymorphism layers on top, doesn't replace.
- Enum + variant patterns + `switch` exhaustiveness (Phase 7.5) — the foundation `?`-over-enum needs.
- Multiplexer + park/unpark in the runtime (Phase 8.F.1–8.F.3) — suspendable wait reuses the park primitive, doesn't need new threading infrastructure.
- `xs.ptr` and the fat-pointer array layout — slice syntax reduces to constructing a new `{ptr+i, j-i}` pair.

## Recommended approach

Land in roughly the order below — earlier items are smaller and unblock the bigger ones. Each subsection is intended to become its own self-contained phase document (e.g. `plans/phase-9-a-parens.md`) when its turn comes; this file is the index and rationale.

### Phase 9.A — Parenthesized subexpressions

**The smallest, highest-leverage item in the phase.** [src/jsyooparser/parser.js:1361](../src/jsyooparser/parser.js#L1361) `parseExpression` has no `(` branch in its primary-expression dispatch. A user writing `(r - 20) * 0.02` gets a parse error; the workaround is algebraic re-arrangement that obscures intent.

- Add `lparen` recognition in the primary-expression slot: consume `(`, recursively `parseExpression(0)`, expect `)`, attach `sourceLoc` to the inner node and return it.
- Disambiguate from cast call syntax (`int32(x)`): the cast form is already handled because cast names are idents followed by `(`, which is parsed as a CALL_EXPRESSION on a typename. Bare `(` with no leading identifier falls into the new path.
- Confirm interaction with the no-`<`-in-expression-position invariant from Phase 7.1: parens don't change that, but the test program from the SDL demo (mixed arithmetic + casts + struct field access) must round-trip.
- New tests in [src/jsyooparser/parser.test.js](../src/jsyooparser/parser.test.js): standalone grouping, grouping changes precedence (`(a + b) * c` vs `a + b * c`), nested parens, parens around a struct literal field value, parens around a call argument.

Files touched: [parser.js](../src/jsyooparser/parser.js), parser tests. No typecheck or codegen change — parens disappear at AST build time.

**Today's workaround**: hand-rewriting expressions to avoid grouping. Visible in [examples/playground/sdl_demo/main.yoop:159](../examples/playground/sdl_demo/main.yoop#L159).

### Phase 9.B — `bool[]` and complete array element-type coverage

Yoop's array implementation works on every primitive except `bool` ([SPEC.md §3](../SPEC.md#arrays)). The SDL demo had to substitute `int32[]` and treat 0/1 as bool, and every program that wants a packed flag array faces the same workaround.

- Audit codegen for the precise reason `bool[]` doesn't work: most likely the LLVM type lookup for the element treats `bool` (`i1`) specially and the array storage path expects a power-of-two byte width. Decide on representation: store bool elements as `i8` (one byte each — the common convention; matches C `_Bool`), not `i1`. Loads / stores zext/trunc at the boundary.
- Extend [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) array allocation, indexing, and `.len` paths to handle the new element type uniformly.
- Confirm `[true, false, true]` array literals typecheck and codegen.
- Confirm `bool[]` works through `heap_alloc`, `vec_push`, and generic `Vec<bool>` so [std/core/vec.yoop](../std/core/vec.yoop) instantiates cleanly.

Files touched: [codegen.js](../src/jsyoopcodegen/codegen.js), tests + a fixture in `examples/pass/`.

**Today's workaround**: `int32[]` with 0/1 sentinels. Visible in [examples/playground/sdl_demo/main.yoop:238](../examples/playground/sdl_demo/main.yoop#L238).

### Phase 9.C — `std/` import root

[library-design.md §8 open question 6](library-design.md#8-open-language-questions-the-library-exposes) — every user of the std library has to write `import { ... } from "../../../std/core/kinds.yoop";`. The number of `..`s depends on where in `examples/` the file lives. It's ugly and breaks the moment a file moves.

- Add a search-root mechanism in [src/jsyoopdriver/moduleGraph.js](../src/jsyoopdriver/moduleGraph.js): when an import path starts with `std/`, resolve it against the std directory at the repo root (or against a config-driven location — for now, hardcoded relative to the yoopiler binary).
- Update the parser to accept `import { ... } from "std/net/tcp";` (no `.yoop` extension required for the std form, or keep the extension — pick one and stay consistent with the relative-path rule from [SPEC.md §1](../SPEC.md#1-files-modules-imports-and-exports)).
- Migrate the existing demos (`examples/playground/servertest/`, `examples/pass/hello_server/`) to use the new form so the regression suite covers it.

Files touched: [moduleGraph.js](../src/jsyoopdriver/moduleGraph.js), driver, parser (maybe — depends on chosen syntax), spec note.

**Today's workaround**: deep relative paths. Visible in [examples/playground/servertest/main.yoop:10-15](../examples/playground/servertest/main.yoop#L10-L15).

### Phase 9.D — `for ... in ...` loop + `Iterable` trait

[SPEC.md §9](../SPEC.md#9-loops) defines two loop keywords, and the trait-driven iteration story is one of the more distinctive parts of the language design — yet every example in the codebase uses C-style `while (i < n) { ...; i = i + 1; }`. Landing this single item retires the most common boilerplate pattern in real yoop code.

- Add `Iterable<T>` to [std/core/traits.yoop](../std/core/traits.yoop):
  ```yoop
  trait Iterable<T> {
      function next(ref self): IterStep<T>;
  }
  enum IterStep<T> { Yield { value: T }, Done }
  ```
- Lower `for item in xs` to: get an iterator from `xs` (default impl on arrays returns an index-walker), loop while `next(ref it)` yields `Yield { value }`, bind `item` to `value` in the body. Variant pattern matching from Phase 7.5 is exactly the lowering shape — desugar `for` to a `while (true) { switch (Iterable.next(ref it)) { case Yield { value: item }: ...; case Done: break; } }`.
- Define the default array iterator: a small builtin struct holding `{ xs: T[], i: usize }` whose `next` advances `i` and returns `Yield` or `Done`. Provided by the compiler so user code never has to import it.
- Defer the strategy-trait variants (`xs.batched(n)`, `xs.parallel()`, `xs.simd(n)` — SPEC §9) to a later phase; Phase 9.D ships the **default sequential** form only. The `.batched()` / `.parallel()` slots are a syntactic extension over the same `for ... in EXPR` shape — whatever shape we ship, those overlay cleanly.
- Confirm `for item in xs { ... }` with `xs: T[]` works for every yoop primitive `T` (depends on 9.B for `bool[]`). The body can mutate elements via the iterator's `ref` semantics if the iterator yields `ref T` — punt that to the strategy-trait phase; 9.D yields by value.

Files touched: [parser.js](../src/jsyooparser/parser.js) (new `for ... in EXPR { ... }` form; the existing C-style `for` stays unchanged), typechecker (resolve `Iterable` impl on the RHS, type-check the body binding against the trait's element type), codegen (no new IR — pure desugar), [std/core/traits.yoop](../std/core/traits.yoop).

**Today's workaround**: hand-rolled C-style for loops everywhere. Visible at [examples/playground/sdl_demo/main.yoop:280-320](../examples/playground/sdl_demo/main.yoop#L280-L320) and across the std/http codebase.

### Phase 9.E — Array slice syntax `xs[i..j]`

Reserved in the Phase 8 networking prerequisites doc and called out in [SPEC.md §3](../SPEC.md#arrays) as future. It's a zero-copy fat-pointer subview — backing memory is unchanged, the view is `{xs.ptr + i, j - i}`. Required by every parser that wants to consume bytes incrementally (the HTTP parser uses it internally today via `array_slice`, but call-site syntax is verbose).

- Lex `..` as a new two-char token (`dotdot`); it's only legal inside `[ ... ]`, so there's no conflict with member access.
- Parser: extend the existing index-expression form so `xs[i..j]`, `xs[i..]`, `xs[..j]`, `xs[..]` all parse.
- Typecheck: result type is `T[]` if `xs: T[]`. Indices must be `usize`-assignable.
- Codegen: lower to a call to the existing `array_slice<T>` intrinsic ([SPEC.md §12](../SPEC.md#bytes-strings-and-the-conversion-bridges)) — no new LLVM emission needed.
- Confirm slice composition: `xs[a..b][c..d]` produces the inner slice.

Files touched: [lexer.js](../src/jsyooplexer/lexer.js), [parser.js](../src/jsyooparser/parser.js), typechecker, codegen.

**Today's workaround**: explicit `array_slice(xs, i, j)` calls. Used liberally in [std/http/parser.yoop](../std/http/parser.yoop).

### Phase 9.F — `Display` trait wired into template literals ✓ landed

> See [plans/completed/phase-9-f-display-in-templates.md](completed/phase-9-f-display-in-templates.md).
> `${expr}` falls through to `Display.to_string(ref expr)` when the type
> implements Display; cross-module impls resolve. `StatusCode` /
> `HttpMethod` impls are deferred until enum-trait-impls land and an
> int-to-string helper exists (`SocketAddr` did get the impl —
> `addr_to_string` is gone).

[library-design.md §3.4](library-design.md#34-display--to-string-conversion-new) defines the trait; [library-design.md §8 open question 5](library-design.md#8-open-language-questions-the-library-exposes) flags that template literals don't consult it. Today `${myStruct}` is a compile error unless the type is `int`/`float`/`bool`/`string`. The fix is a typechecker-only patch.

- When checking a `${expr}` interpolation in a template literal, after the existing primitive table check fails, look up `Display.to_string(ref expr)` on the expression's type. If the type implements `Display`, rewrite the interpolation to call `to_string` first and use the resulting `string`.
- The rewrite happens at typecheck time, before codegen; codegen still only sees `printf`-style format args.
- Confirm `Display` impls on `SocketAddr`, `StatusCode`, `HttpMethod` in std and demo them in a fixture.
- Cross-module: if a user type in module A implements `Display`, importing it into module B and using `${x}` in a template literal still resolves.

Files touched: typechecker template-literal path ([checkExpr.js](../src/jsyooptypecheck/checkExpr.js)), [std/core/traits.yoop](../std/core/traits.yoop), tests.

**Today's workaround**: explicit `to_string` calls and concatenation, or sprintf-style assembly. Visible across [std/net/addr.yoop](../std/net/addr.yoop) where `addr_to_string` is a free function instead of trait-driven.

### Phase 9.G — `vtable T for Trait` runtime polymorphism + function value types

> **Status: landed.** See
> [plans/completed/phase-9-g-vtables.md](completed/phase-9-g-vtables.md).
> `=>` parses as a function-pointer type in type position;
> `vtable Name for Trait { ... }` declares a type-erased shape for a
> trait; `VTableName.from(ref x)` constructs an instance from any
> `ref T` where `T implements Trait`; `Trait.method(ref vt, args)` (or
> equivalently `VTableName.method(ref vt, args)`) dispatches through
> the vtable's method slot. Demo: heterogeneous handler list in
> [examples/pass/vtable_handlers.yoop](../examples/pass/vtable_handlers.yoop).

The single biggest design-question item in [library-design.md §8](library-design.md#8-open-language-questions-the-library-exposes) (questions 1, 2, 3) — and the one that unblocks the most downstream work: streaming HTTP bodies, heterogeneous handler lists, routing tables, callbacks. The library-design doc has a concrete proposal; this phase implements it.

- **Function value types in type position use `=>`**: `(req: Request) => Response`. The `function` keyword stays only at *declaration* sites; at type positions (struct fields, parameter types, return types) the `=>` arrow signals "this is a function value." Disambiguation from the `=` token and from struct literal braces is just lexer + parser work.
- **`vtable T for Trait { fields }`** — declares the erased shape of a trait. The compiler:
  - Inserts an implicit `ctx: unsafe_ptr<void>` field.
  - Requires every other field to be a function type matching one of the trait's methods.
  - Threads `ctx` as the implicit first parameter of each function field's stored pointer type.
  - Stays a normal, frozen struct type at the codegen level — `Reader { ctx: ptr, read: ptr }` is two pointer-width fields.
- **`Reader.from(ref s)`** — built-in constructor that takes any `ref T where T implements Readable` and produces a `Reader` value by looking up the impl's method addresses (already monomorphized) and packaging them with `&s` as the `ctx`. Pure typechecker + codegen wiring; no new runtime.
- **Method calls through a vtable**: `Reader.read(ref r, ref buf)` — the typechecker recognizes that the receiver is a vtable for the trait, and the call lowers to an indirect call through the function pointer in the corresponding field, passing `r.ctx` as the first argument.
- **Trait-object parameters** — once vtables exist, `function parse(ref r: Reader): ParseResult` is the idiomatic "any Readable" parameter form. This retires the `<R implements Readable>` monomorphization-per-call-site pattern in cases where heterogeneity or compile-size matter.

Files touched: lexer (`=>` token), parser (function type annotations, `vtable` decl form), typechecker ([types.js](../src/jsyooptypecheck/types.js) for `VTableType` + `FunctionPointerType`; [checkExpr.js](../src/jsyooptypecheck/checkExpr.js) for `Trait.from` and call-through-vtable), codegen ([codegen.js](../src/jsyoopcodegen/codegen.js) for the indirect-call lowering and the `from` wiring).

**Today's workaround**: monomorphized generic functions (works, but no heterogeneous collections) and parallel hand-rolled fn-pointer fields with `ctx: unsafe_ptr<void>` (works, but verbose and unsafe at every call site).

### Phase 9.H — `?` over enum-shaped errors

> **Status: landed.** See
> [plans/completed/phase-9-h-fallible-enum-qmark.md](completed/phase-9-h-fallible-enum-qmark.md).
> Any enum with exactly two variants named `Ok` and `Err` is recognized as a
> fallible type; `?` propagates the `Err` payload through callers with a
> matching `Err` payload type. Cross-shape (struct ↔ enum, mismatched `Err`
> payload type) is rejected.

[library-design.md §8 open question 7](library-design.md#8-open-language-questions-the-library-exposes). Today `?` only understands `err: string`-bearing structs ([Phase 2](completed/phase-2-errors-as-values.md)). Now that enum + variant patterns + exhaustiveness exist (Phase 7.5), the standard `enum Result<T, E> { Ok { value: T }, Err { error: E } }` shape is expressible — but `expr?` on a `Result<T, E>` is a typecheck error.

- Introduce a "fallible-enum" convention: any enum with exactly two variants, one named `Ok` and one named `Err`, is recognized by the typechecker as fallible. (Spec text TBD: structural recognition vs. an explicit marker trait. Recommend structural for minimum ceremony — same approach as `err: string`.)
- `expr?` on a fallible enum: if `Ok`, yields the `Ok` payload (single-field shortened the same way as the struct rule); if `Err`, builds the enclosing function's return-type `Err` variant with the propagated payload and returns. Enclosing return type must also be a fallible enum or a fallible struct *with a compatible error type* (cross-shape propagation deferred — same enum shape only in 9.H).
- Confirm: the existing struct-fallible behavior is unchanged. The check is "result-of-`expr` is a fallible struct OR a fallible enum"; the two paths fork at the rewrite step.

Files touched: typechecker ([fallible.js](../src/jsyooptypecheck/fallible.js), [checkExpr.js](../src/jsyooptypecheck/checkExpr.js) for the `?` postfix), codegen (only if the enum variant builder for the early-return path needs a tweak; likely zero codegen change because the existing variant-constructor path covers it).

**Today's workaround**: convert enum errors to struct-fallibles at the API boundary, or hand-roll the early-return pattern.

### Phase 9.I — Suspendable `wait` inside task bodies

> **Status: landed.** See
> [plans/completed/phase-9-i-suspendable-wait.md](completed/phase-9-i-suspendable-wait.md).
> `yoop_task_wait` now drains the queue on the calling thread instead of
> parking on the handle's condvar; the canonical N-deep-nested-wait deadlock
> from SPEC §8 is gone, with no language surface change.

[SPEC.md §8 Safety and deadlock](../SPEC.md#safety-and-deadlock) describes the current `wait`-inside-task hazard: with N workers and N tasks each waiting on an N+1th task, the pool deadlocks. The mitigation listed in the spec is suspendable `wait` — yielding the worker rather than blocking it. Phase 8.F.1 already shipped park/unpark in the runtime; this phase wires it into the `wait` codegen path.

- Change `wait h` codegen inside `task` function bodies: instead of pthread-condvar-blocking, register the current task as a waiter on `h`'s completion (using the park primitive), then `park`. The waker is the task's worker on completion, which already runs the runtime's "I just finished" path.
- The non-task path (synchronous `wait` from non-task code, e.g. `main`) keeps the existing pthread-block semantics — no benefit to suspending the calling thread there.
- Verify the multiplexer (Phase 8.F.2) and timers (Phase 8.F.3) compose with the new wait: a task can `wait h` and have its worker pick up the I/O wait the multiplexer parked it on. Existing concurrent_pipe / hello_server e2e tests must still pass.
- Stress-test: a chain of N+1 tasks where each waits on the next, with N workers — must complete (no deadlock).

Files touched: [codegen.js](../src/jsyoopcodegen/codegen.js) wait emission, [runtime/yoop_runtime.c](../runtime/yoop_runtime.c) (only if the park path needs to grow a "completion waiter" registration; the multiplexer's park path is the same primitive).

**Today's workaround**: compose tasks at the top level (`main`), not inside other tasks. SPEC §8 documents the workaround explicitly.

### Phase 9.J — Reserved-syntax cleanups: `extends`, multi-bound, `mustNotShare acrossThreads`

A grab bag of small items that are in [SPEC.md](../SPEC.md) but currently get a "not yet supported" parse error. None of them are independently big; bundling clears the deferred-feature backlog.

- **`extends` on traits** ([SPEC.md §5](../SPEC.md#5-traits)) — `trait BatchIterable<T> extends Iterable<T>` parses today as a not-yet-supported error ([parser.js:1235](../src/jsyooparser/parser.js#L1235)). Wire it: when type T implements BatchIterable, the typechecker requires it to also implement Iterable; method resolution looks through the chain.
- **Multiple trait bounds `<T implements (A, B)>`** ([parser.js:465](../src/jsyooparser/parser.js#L465)) — Phase 7.2 shipped single-bound only. Extend the bound list to many; method resolution inside the generic body must consider the union of methods from all bounds; instantiation-time check requires impl of every bound.
- **`mustNotShare acrossThreads`** ([parser.js:878](../src/jsyooparser/parser.js#L878)) — the partner of `mustNotShare acrossScopes` (already implemented). With suspendable wait + the multiplexer in place, "thread" is now a thing tasks meaningfully cross; the kind annotation should enforce that values carrying it cannot flow into a `task` body. Implementation: a flag on the kind, checked in the task-call lowering path against every captured/argument binding.

Files touched: parser (drop the "not yet supported" branches), typechecker (resolution + checks), tests covering both the rejection-removed cases and new invariants.

**Today's workaround**: SPEC-aware users avoid these syntactic forms; library authors document the gap. Visible as warnings in [plans/completed/phase-5-traits.md](completed/phase-5-traits.md) and [plans/completed/phase-7-2-trait-bounds.md](completed/phase-7-2-trait-bounds.md).

## Out of scope here

- **Closures.** Capture mechanics, capture-by-ref-vs-by-value, allocation strategy — meaningful design tax. The vtable workaround (Phase 9.G) is the substitute. [library-design.md §8 question 3](library-design.md#8-open-language-questions-the-library-exposes) defers them indefinitely; Phase 9 honors that.
- **Iteration strategies (`.batched()`, `.parallel()`, `.simd()`).** The `for ... in` keyword slot is Phase 9.D; strategy traits are a follow-up once a real user wants one. SPEC §9 already defines them.
- **`Map<K, V>` / hash collections.** Phase 9 ships the language; collections are stdlib work for a Phase 10+ slot. [library-design.md §8 question 4](library-design.md#8-open-language-questions-the-library-exposes).
- **TLS / HTTP/2 / HTTP/3.** Library extension work; not on the language critical path.
- **LP64-vs-LLP64 portability** for the `c_long` family. The CI matrix is Linux + macOS; Windows alias correction is a deferred small change.
- **Self-hosting and optimization passes.** Phase 10.

## Critical files (existing)

- [SPEC.md](../SPEC.md) — sections 3 (arrays), 5 (traits + `extends`), 8 (concurrency / safety), 9 (loops), 11 (errors) all get edits as Phase 9 sub-phases land.
- [library-design.md §8](library-design.md#8-open-language-questions-the-library-exposes) — the open-questions list this phase retires.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — touched by 9.A, 9.D, 9.E, 9.G, 9.J.
- [src/jsyooptypecheck/](../src/jsyooptypecheck/) — touched by every sub-phase except 9.A and 9.C.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — touched by 9.B, 9.E, 9.G, 9.I.
- [runtime/yoop_runtime.c](../runtime/yoop_runtime.c) — touched only by 9.I (and only if completion-waiter registration grows beyond the existing park primitive).
- [examples/playground/sdl_demo/main.yoop](../examples/playground/sdl_demo/main.yoop) — the canonical "what does fixed code look like?" fixture. After 9.A + 9.B + 9.D land, the explicit "workaround" comments in this file should be removable.

## Verification (per sub-phase)

Each sub-phase ships with:

1. A negative test (the syntax / shape that used to fail still fails the same way *if* unrelated, and now succeeds for the new case).
2. A positive end-to-end test in [src/e2e.test.js](../src/e2e.test.js) that compiles + runs a fixture demonstrating the new form.
3. An SDL-demo or std/http migration that visibly removes a workaround comment. The PR diff should show comments going away.

The full-phase verification is the SDL demo: after Phase 9.A, 9.B, 9.D, and 9.E land, the SDL demo's three "workaround" comments must be deletable and the file must shorten by ~30+ lines (the three balls' draw blocks collapse into one `for ball in balls` loop with `bool[]` for `bullet_active` and parens wherever they're natural).

## What lands first

Pick the dependency-light items first so the heavier work has clean foundations:

- 9.A (parens) — half a day; unblocks readable arithmetic everywhere.
- 9.B (bool[]) — a day; unblocks the SDL bullet pool and any other flag array.
- 9.C (std/ import root) — half a day, driver-only.
- 9.D (for ... in) — a few days; biggest single DX win.
- 9.E (slice syntax) — a day or two; small typechecker + parser slice on top of `array_slice`.

These five clear ~80% of the "every program rewrites this awkwardly" workarounds and are doable in roughly a week of focused work. After that, 9.F (Display in templates) is a typechecker patch, and the bigger 9.G / 9.H / 9.I block can be tackled in either order.

9.J is the cleanup pass — it can interleave with the others as the matching deferred-feature errors come up during 9.D / 9.G work.
