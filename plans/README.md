# Plans

**This directory is history and forward work, not guidance.** Plan docs record
how a system was designed and BUILT, at the time it was built. Several describe a
language that has since changed shape.

If you want to know how to write Yoop today, read
[../docs/writing_yoop.md](../docs/writing_yoop.md); it wins over anything here.
For compiler internals, read
[../docs/compiler_internals.md](../docs/compiler_internals.md).

Style for anything written here: ASCII only. No em-dashes, no curly quotes, no
fancy markdown tables.

Layout:

- **This file** - what is being worked on now, plus the index below.
- **Top level** - the small set of docs that are still ACTIVE: open work, or a
  contract the current work is written against.
- [archive/](archive/) - dormant, future, historical, and everything that has
  fully LANDED. Viewable and still useful when you want the reasoning behind a
  shipped system; just not part of the working set.
- [completed/](completed/) - per-phase write-ups for everything that shipped
  (phases 1 through 9, library phases A through D, the 10.x sub-phases).

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
starting standard library) already shipped. The language is usable; now it has to
compile itself.

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

## Active docs (top level)

- [bootstrap-pipeline-contracts.md](bootstrap-pipeline-contracts.md) -
  **north star.** Pins the data shape that crosses each layer boundary in the
  self-hosting compiler (arena + NodeId AST, side-table decoration,
  Result + Diagnostic error channel) so the Yoop and JS implementations can
  diverge internally without losing a shared, diffable target.
- [ownership-and-typestate-redesign.md](ownership-and-typestate-redesign.md) -
  **north star.** The advisory ownership model the bootstrap follows: ownership
  is opt-in and silent by default, and the marker/typestate kinds are the part
  with teeth. Summarized for daily use in
  [../docs/writing_yoop.md](../docs/writing_yoop.md).
- [strings-ownership-and-ergonomics.md](strings-ownership-and-ergonomics.md) -
  S1, S2, S2.1 and S3 (`Text`) have LANDED. **S4 (routing bare `string`
  allocation through `ctxAlloc`) and S5 (`string ==`) are open**, which is why
  this is still here: today a bare `string` ignores the allocator context
  entirely while `Text` respects it.
- [tls.md](tls.md) - PLANNED / in progress. `std/tls/` and `std/https/` exist.
- [yooperdoom-takeaways.md](yooperdoom-takeaways.md) - the action list from a
  15,000 line DOOM port. **Partly stale**: re-verified on 2026-08-11, `bool ==`
  (2.1) and `printf` with a template-literal format (2.3) are FIXED, and the
  bare-block (2.4b) and nested-function (2.5) items are deliberate errors with
  good diagnostics now. The live items are 1.1 (untyped-literal arithmetic
  reaching codegen) and 1.2 (allocation failure is a null dereference); both are
  in the sharp-edges list in [../docs/writing_yoop.md](../docs/writing_yoop.md).

Reference for shipped systems whose invariants are subtle enough to be worth
keeping close (all cited by
[../docs/compiler_internals.md](../docs/compiler_internals.md)):

- [runtime-design.md](runtime-design.md) - the concurrency runtime contract
  (worker pool, task struct layout, refcounted pooled handles). Written against
  the 6.3 MVP, so read its scope lists with the "since landed" note at the top.
- [async-coroutines.md](async-coroutines.md) - `async`/`await` and the LLVM
  coroutine lowering that lets a task blocked on I/O give its worker thread back.
- [cancellation-and-io-deadlines.md](cancellation-and-io-deadlines.md) -
  cancellation tokens, deadline- and cancel-aware I/O, and the multiplexer fixes
  that went with them. Supersedes runtime-design.md on cancellation.
- [clearance-kinds.md](clearance-kinds.md) - the marker/clearance kind design and
  implementation (conferred/restrictive transitions, decl-authority).
- [kinds-design.md](kinds-design.md) - heuristics for when a kind earns its cost.

---

## Recently landed (moved to archive/)

These all shipped; the docs moved to [archive/](archive/) on 2026-08-11 so the
working set stays small.

- [archive/modules-as-directories.md](archive/modules-as-directories.md) - a
  module as a DIRECTORY of files that each declare `module <name>;`. Phases 1
  through 3 landed; `std/core/cancel`, `std/db/sqlite`, `std/net`, `std/http` and
  `std/tls` are directory modules. Records where the plan itself turned out to be
  wrong, plus the pass C ordering bug it surfaced (a module's semantics depended
  on the alphabetical spelling of its filenames).
- [archive/modules-folder.md](archive/modules-folder.md) - the program-owned
  `modules/` import root. Flat by policy; nesting is a hard error, because two
  copies of a type would link fine and then mismatch as `Value` versus `Value`.
- [archive/arena-and-context-allocators.md](archive/arena-and-context-allocators.md)
  and [archive/async-allocator-context.md](archive/async-allocator-context.md) -
  the ambient allocator, arenas, the temp allocator, and the per-task context
  swap.
- [archive/kinds-in-std.md](archive/kinds-in-std.md) - moving `task`, `async`,
  `joined`, `pooled` and `Task` out of the compiler into `std/core/kinds.yoop`.
- [archive/task-combinators.md](archive/task-combinators.md) - `awaitTask`, and
  why `TaskGroup`/`awaitAll`/`awaitRace` are deferred.
- [archive/testing-via-kinds.md](archive/testing-via-kinds.md) - the `--test`
  harness built out of userland kinds. Usage is in
  [../docs/writing_yoop.md](../docs/writing_yoop.md); the driver flow is in
  [../docs/compiler_internals.md](../docs/compiler_internals.md).
- [archive/library-design.md](archive/library-design.md) - the original standard
  library design contract.
- [archive/sqlite-binding-papercuts.md](archive/sqlite-binding-papercuts.md) -
  what binding libsqlite3 proved the FFI surface can already do without a compiler
  change. The `transaction` kind it asked for is built.

---

## Open TODOs

- **Naming migration, remaining tail.** std went fully `camelCase` on 2026-08-11
  (`vecNew`, `mapGet`, `Display.toString`). Still `snake_case`: tool-internal
  helpers in [../tools/](../tools/) (~30 names), example-local helpers under
  [../examples/](../examples/), and some module-level consts that should be
  `SCREAMING_SNAKE` (`tokenScanList` in `bootstrap/src/contracts.yoop`).
- **Two playground examples are stale** since the async conversion and no longer
  compile: `examples/playground/todo_api` and `examples/playground/yoopstore`
  both hit `async function must be awaited` on `serve` / `serveDefault`. Nothing
  under playground/ is covered by e2e, which is why this sat unnoticed. Fixing
  them is a call-site `await` plus whatever coloring that cascades into.
- **Figure out the idempotent cleanup/dispose pattern** (free-then-null, guard on
  null) so `dispose` is safe to call more than once. This is the discipline the
  advisory ownership model leans on instead of compiler-enforced affine moves.
- **Generic call-site inference cannot see through a generic enum's type
  arguments**: `function bridge<T>(r: Result<T, string>)` will not infer `T` from
  a `Result<int32, string>` argument, and there is no turbofish to say it out
  loud. The workaround is one bridging helper per payload type.
- **Consumer-side `yoopiler modules`** - the recorded-versus-installed view for
  the `modules/` root.

---

## What is deliberately NOT being worked on

The reasoning lives in [archive/phase-10.md](archive/phase-10.md) ("Out of
scope") and the individual archived plans:

- Classes/inheritance, garbage collection, capturing closures, `match` as an
  expression - permanently no, or covered by an existing workaround.
- A package MANAGER ([archive/package-system.md](archive/package-system.md)) -
  manifest, fetch command, URLs, hashes, versions. Only worth building when there
  is somewhere to fetch from, and narrower than it was: the `modules/` root
  covers USING third-party code, and a manifest would only decide what populates
  the folder.
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
