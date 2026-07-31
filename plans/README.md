# Plans

This directory is intentionally small. THIS file is the single source of truth
for "what am I working on right now." Everything else is either a live reference
for an already-shipped system, or it is history/future kept out of the way:

- [archive/](archive/) - dormant, future, or historical plans. Viewable, but
  not in the immediate working set (the old `roadmap.md`, the `phase-10.md`
  tracker, the package system, comptime, variant ergonomics, dynamic vtables,
  and the app-building papercut logs).
- [completed/](completed/) - per-phase write-ups for everything that has already
  landed (phases 1 through 9, library phases A through D, and the 10.x
  sub-phases). Read these to understand how a shipped feature was built.

Style: ASCII only. No em-dashes, no curly quotes, no fancy markdown tables.

---

## The real goal right now

Two things, in priority order:

1. **Self-host.** Rewrite the JS compiler in Yoop, layer by layer, cross-checking
   each layer's output against the JS reference before building the next one on
   top of it. This is roadmap item 10.K and the point of every prior phase.
2. **Write larger Yoop programs.** Use the self-hosting work (and the example
   programs) to get a real feel for the language's ergonomics, and feed the
   friction back into small, targeted language fixes.

Everything not in service of those two is deferred. The full language surface
(structs, traits, kinds, generics, enums/unions, errors-as-values, tasks, and a
starting standard library) already shipped through phase 9 plus library phases
A through D. The language is usable; now it has to compile itself.

---

## The two documents that matter for this work

- [bootstrap-pipeline-contracts.md](bootstrap-pipeline-contracts.md) - the
  north-star. Pins the data shape that crosses each layer boundary in the
  self-hosting compiler (arena + NodeId AST, side-table decoration,
  Result + Diagnostic error channel) so the yoop and JS implementations can
  diverge internally without losing a shared, diffable target.
- [ownership-and-typestate-redesign.md](ownership-and-typestate-redesign.md) -
  the advisory ownership model the bootstrap follows (ownership is opt-in and
  silent by default; the marker/typestate kinds are the part with teeth).

---

## Where the bootstrap stands

Source lives under [../bootstrap/src/](../bootstrap/src/). Build order is
bottom-up, diffing each layer against the JS reference before moving up.

- **Layer 0 - module graph**: STARTED.
  `bootstrap/src/source_graph/module_graph.yoop` has `Module` + `loadModule`
  (Result-shaped).
- **Layer 1 - lex**: IN PROGRESS.
  `bootstrap/src/source_processing/lexer.yoop` + `char_utils.yoop`; `Token` and
  `TokenTags` are defined, and the scan/keyword tables in
  `bootstrap/src/contracts.yoop` mirror the JS tables.
- **Layer 2 - parse**: NOT STARTED. `ASTNodeKind` + `ASTNode`/`SourceLocation`
  shells exist in `contracts.yoop`; the arena (decision D1 in the contracts doc)
  and the parser are the next build.
- **Layer 3 - typecheck**: NOT STARTED. The largest layer.
- **Layer 4 - bytecode IR**: the one planned deviation from the JS pipeline
  (JS has no IR; the bootstrap may add one). Hold the codegen input contract
  stable so this stays an absorbable, contained change. Deferred until a pass or
  optimization actually wants it.
- **Layer 5 - codegen**: NOT STARTED.

Immediate build sequence (from the contracts doc):

1. Lock the arena + side-table decoration + Result/Diagnostic shapes into
   `contracts.yoop`.
2. Finish the lexer; diff its token stream against the JS lexer.
3. Build the parser onto the arena; diff AST dumps.
4. Build typecheck; diff resolved types + diagnostics.
5. Build codegen straight from the typed AST (skip the IR layer initially, as
   JS does); diff the `.ll` and run the binary.

---

## Active TODOs

Small, concrete next steps (the running scratch list; `scratch.md` is the
informal personal version):

- ~~Bootstrap: create a `Vec` iterator concept (needed to write the layers
  idiomatically without index plumbing).~~ DONE: `vecIter` +
  `VecIter<T> implements Iterable<T>` in `std/core/vec.yoop`, landed alongside
  two other loop-ergonomics fixes the layers wanted - a loop-scoped counter
  (`for (let i = 0; i < n; i += 1)`, with the counter's type taken from the
  condition so it lands on `usize`) and `a..b` ranges (`for i in 0..n`, sugar
  for a `Range` value in `std/core/range.yoop`). See SPEC.md section 9.
- Typecheck: a struct used as a variant payload has to be declared before the
  variant or its fields resolve against an unpopulated shell, and the resulting
  diagnostic misleads (`type "T" has no field "f"` on a field that IS declared).
  Surfaced by the sqlite binding; see
  [sqlite-binding-papercuts.md](sqlite-binding-papercuts.md).
- Figure out the idempotent cleanup/dispose pattern (free-then-null, guard on
  null) so `dispose` is safe to call more than once - this is the discipline the
  advisory ownership model leans on instead of compiler-enforced affine moves.
- Generic call-site inference cannot see through a generic enum's type
  arguments: `function bridge<T>(r: Result<T, string>): Result<T, E>` will not
  infer `T` from a `Result<int32, string>` argument, and there is no turbofish
  to say it out loud. The workaround is one bridging helper per payload type
  (`examples/playground/todo_api/store.yoop` has four). Surfaced by the
  std/http rework; see [completed/std-http-rework.md](completed/std-http-rework.md).
- The std/http rework (DONE, same doc) fixed four compiler bugs on its way
  through - two `sizeOfType` under-counts that corrupted memory, a module-level
  `const` string that kept its escapes undecoded, and a `switch` payload
  binding that could carry an unpopulated struct shell. Worth reading as a list
  of the shapes that go wrong when a layout or a pass-order assumption drifts.

---

## Reference docs (shipped systems, kept handy)

These describe systems that already work; they are not pending plans. Kept at
the top level because the day-to-day work and the CLAUDE.md notes cite them.

- [runtime-design.md](runtime-design.md) - the concurrency runtime contract
  (pthread worker pool, task struct layout, refcounted pooled handles). The
  implementation reference for the task/`wait` machinery. Written against the
  6.3 MVP, so read its scope lists with the "since landed" note at the top.
- [async-coroutines.md](async-coroutines.md) - `async`/`await` and the
  LLVM-coroutine lowering that lets a task blocked on I/O give its worker
  thread back. Explains why this needed a language change (a suspend has
  to propagate up a call chain, and `llvm.coro.suspend` only suspends one
  frame). `std/net` and `std/http` are converted; the doc records the
  coloring cascade that caused, and what is still blocking-only
  (ambient stream timeouts, `flush`).
- [cancellation-and-io-deadlines.md](cancellation-and-io-deadlines.md) -
  cancellation tokens (`std/core/cancel.yoop`), deadline- and cancel-aware
  I/O waits, and the multiplexer fixes that went with them (the same-fd
  waiter conflict, the monotonic deadline clock, restartable init). Read
  this alongside runtime-design.md, which it supersedes on cancellation.
- [kinds-design.md](kinds-design.md) - heuristics for when a kind earns its
  cost, and in-tree opportunities (`validated`, `authenticated`, `tainted`).
- [clearance-kinds.md](clearance-kinds.md) - the marker/clearance kind design
  and its v0 implementation (conferred/restrictive transitions, decl-authority).
- [library-design.md](library-design.md) - the standard-library design contract
  (library principles, foundational traits/kinds, the networking + HTTP layers).

- [sqlite-binding-papercuts.md](sqlite-binding-papercuts.md) - what binding
  libsqlite3 (`std/db/`) proved the FFI surface can already do without a compiler
  change (opaque handles, `void **` out-params, pointer-sized-int sentinels, and
  the envelope-struct trick that keeps `unsafe_ptr` out of a safe module), plus
  the one typecheck papercut it found. The `transaction` kind it asked for is
  now built (as a binding kind, not a region kind - a region has no name, and
  with no name there is nothing to call `commit` on).
- [completed/std-http-rework.md](completed/std-http-rework.md) - the as-built
  notes for `std/http`: one `Result<T, HttpError>` error channel, a non-generic
  serve loop over the `Dispatcher` vtable, keep-alive, router path captures, and
  the compiler bugs and ergonomic gaps the rewrite surfaced.

One design exploration, not a shipped system and not scheduled:

- [testing-via-kinds.md](testing-via-kinds.md) - a test harness written in
  userland kinds and traits rather than compiler-baked `@test` attributes. A
  working DSL already exists at
  [../examples/playground/yooptest/main.yoop](../examples/playground/yooptest/main.yoop).
  Tests live in `*.test.yoop`, flagged with `import.test;`, with suites marked by
  a function-position `suite` kind; the driver globs them, generates a synthetic
  entry module whose `main` hands the suite table to `std/test.yoop`, and builds
  one throwaway executable in the temp dir it already makes. All policy
  (ordering, arena isolation, filtering, reporting) is Yoop code in std. Doubles
  as a stress test of whether the kind system is carrying its weight.

---

## What is deliberately NOT being worked on

These come up in design discussions but are out of scope for the current focus.
The reasoning lives in [archive/phase-10.md](archive/phase-10.md) ("Out of
scope") and the individual archived plans:

- Classes/inheritance, garbage collection, capturing closures, `match` as an
  expression - permanently no, or covered by an existing workaround.
- A package manager ([archive/package-system.md](archive/package-system.md)) -
  relative-path imports plus the `std/` root cover the design space.
- Comptime/bytecode beyond the shipped `@precompile`
  ([archive/phase-11-comptime.md](archive/phase-11-comptime.md)), variant
  ergonomics ([archive/phase-13-variant-ergonomics.md](archive/phase-13-variant-ergonomics.md)),
  and cross-binary generic vtables
  ([archive/exploration-dynamic-vtables.md](archive/exploration-dynamic-vtables.md))
  - future explorations, not committed.
- Networking polish, in-body cancellation, optimization passes, and the other
  long-tail items tracked in [archive/phase-10.md](archive/phase-10.md) - land
  opportunistically when the self-hosting work or a real consumer surfaces the
  need.
