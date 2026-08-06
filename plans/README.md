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

- **VERIFY ON MACOS/LINUX: the Windows uplift and the IOCP conversion.** Both
  landed green on Windows (`npm test` = 923 pass / 0 fail / 5 skipped) but
  NEITHER has been compiled on a POSIX host. They touched shared code, so this
  is a real gate, not a formality. Run `npm test` on the Mac first; if it is
  red, the list below is where to look.
  - **The poller was split per platform** (Go netpoll style). `runtime/yoop_io.c`
    is now a platform-neutral core and the engines live in
    `runtime/yoop_io_kqueue.c` / `yoop_io_epoll.c` / `yoop_io_windows.c` behind
    `runtime/yoop_io_internal.h`. The kqueue and epoll bodies are the SAME code
    that was in yoop_io.c, moved - but each engine now owns its own self-pipe
    and the registration table stayed behind, so the seam is new even though the
    logic is not. Only one engine compiles per host (each is wrapped in its own
    `#ifdef`), which is why all three sit unconditionally in `RUNTIME_SOURCES`.
  - **Readiness is no longer the portable contract; the OPERATION is.** std/net
    now calls `yoop_iop_recv_begin` / `send_begin` / `accept_begin` +
    `yoop_iop_end` (task-suspending) and `yoop_iop_wait` / `yoop_iop_accept_wait`
    (thread-parking, cancel + deadline aware). On POSIX these are still
    "nonblocking syscall, and on EAGAIN arm a readiness interest and retry on
    resume" - the retry just moved inside the runtime. The forcing reason is
    that a completion port cannot answer "is this socket writable" or "is this
    LISTENING socket readable" at all. `std/net/socket_ffi.yoop` was rewritten
    against this and no longer imports the readiness API.
  - **`runtime/yoop_fs.c` is new** - the filesystem/dirent helpers extracted out
    of yoop_io.c. Both `RUNTIME_SOURCES` in `../src/runtimeBuild.js` and the
    mirror list in `../runtime/tests/run_tests.sh` were updated; check
    `sh runtime/tests/run_tests.sh` still passes on POSIX, since that script is
    never exercised on Windows.
  - **The runtime C tests were rewritten** to use portable shims
    (`runtime/tests/test_support.h`): `yoop_thread_spawn`/`join` instead of
    pthread directly, and `yoop_socketpair` instead of `pipe()`. On POSIX
    `yoop_socketpair` IS `pipe()`, so coverage there is unchanged.
  - **Two fixes are cross-platform and matter on the Mac too**, independent of
    Windows. (1) `llvm.coro.end`'s result must be DISCARDED, not bound to a
    temp: its signature changed in LLVM 19/20 and newer LLVM auto-upgrades the
    old spelling, leaving `%tN =` in front of a now-void call and failing
    verification with "Broken module found". This will bite the Mac on its next
    LLVM upgrade. (2) Identical string literals are now interned into one
    global, because `enum<string>` equality lowers to `icmp eq ptr` and was
    silently relying on the linker's constant merger.
  - **One Windows-only fix lives in a SHARED header.** `yoop_cv_wait_until_locked`
    in `runtime/yoop_platform.h` now loops until the monotonic clock actually
    passes the deadline, because `SleepConditionVariableCS` can report a timeout
    up to one system tick (15.6ms) early. The kqueue/epoll branches of that
    function are untouched, but it is the one timed-wait primitive the whole
    runtime goes through, so it is worth a look during review.
  - **The test suites now prebuild the C runtime once per process**
    (`prebuiltRuntimeObjects` in `../src/toolchain.js`) instead of recompiling
    all 12 translation units per fixture. Measured 4.9x on a fixed 109-test e2e
    slice. It also moved `-Wall -Wextra -Werror` onto the runtime prebuild,
    which is where `runtimeC.test.js` used to get it - if a POSIX-only warning
    exists in the runtime, this is now what will surface it, as a hard error.
- ~~Bootstrap: create a `Vec` iterator concept (needed to write the layers
  idiomatically without index plumbing).~~ DONE: `vecIter` +
  `VecIter<T> implements Iterable<T>` in `std/core/vec.yoop`, landed alongside
  two other loop-ergonomics fixes the layers wanted - a loop-scoped counter
  (`for (let i = 0; i < n; i += 1)`, with the counter's type taken from the
  condition so it lands on `usize`) and `a..b` ranges (`for i in 0..n`, sugar
  for a `Range` value in `std/core/range.yoop`). See SPEC.md section 9.
- ~~Typecheck: a struct used as a variant payload has to be declared before the
  variant or its fields resolve against an unpopulated shell, and the resulting
  diagnostic misleads (`type "T" has no field "f"` on a field that IS declared).~~
  DONE, fixed while merging std/db/sqlite into a directory module. Pass C built a
  fresh `StructType` and REPLACED the table entry, so any field that had already
  resolved to that struct kept pointing at the empty pass-A shell. `StructShell`
  is now unfrozen and pass C fills it IN PLACE (`fillStructShell` in
  [../src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js)) - the same
  fix variant shells got in 13.A and vtable shells in 9.G. Declaration order no
  longer matters for struct fields OR variant payloads. A related crash in
  `detectRecursiveField` (it walked a shell's null `fields`) is fixed too; a plain
  forward reference used to abort the compiler with a TypeError. Across the source
  files of a directory module the same bug SILENTLY MISCOMPILED rather than
  erroring, which is how it was found: a sqlite handle came back as a shifted
  pointer and segfaulted inside libsqlite3. See
  [sqlite-binding-papercuts.md](sqlite-binding-papercuts.md) for the original
  report.
- Two playground examples are stale since the async conversion and no longer
  compile: `examples/playground/todo_api` and `examples/playground/yoopstore`
  both hit `async function must be awaited` on `serve` / `serveDefault`. Nothing
  under playground/ is covered by e2e, which is why this sat unnoticed. Fixing
  them is a call-site `await` plus whatever coloring that cascades into.
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

## Recently landed

- [modules-as-directories.md](modules-as-directories.md) - make a module a
  DIRECTORY of source files rather than a single file. Motivated by the
  bootstrap: acyclicity at file granularity is what forces a shared-vocabulary
  dumping ground (`bootstrap/src/contracts.yoop`, 1199 lines), and that is
  costing more reading context than the file split saves. Sequenced so there is
  no flip day: a directory becomes a module only when its files declare
  `module <name>;`, so the compiler change lands green with zero std changes and
  each directory opts in as its own revertable commit. Distinct from the archived
  package MANAGER plan - different axis, and the doc pins the terminology so they
  stay apart. **Phases 1 and 2 have landed** and the doc records where the plan
  itself turned out to be wrong. Phase 1: the five cross-file name collisions in
  std are gone, no compiler change. Phase 2: directory modules work end to end
  behind the opt-in `module <name>;` header, so nothing in the tree behaves
  differently until a directory opts in. A pass C ordering bug found right after
  phase 2 (a module's semantics depended on the alphabetical spelling of its
  filenames) is also fixed - pass C is now group-major / stage-minor. Import
  locality is enforced too: a module's files share its declarations but not its
  imports, so using a name only a sibling imported is an error. That is a
  checking pass rather than true lexical per-file scope, deliberately - the doc
  records why (deferred resolution would have to carry file identity) and what
  the two conservative-rejection differences are. **Phase 3 has landed** for four
  directories - `std/core/cancel`, `std/db/sqlite`, `std/net`, `std/http` - and
  std/collections is deliberately skipped (merging it privatizes nothing, and
  phase 1 already removed the duplicated helper that was the reason to). The
  merges paid for themselves: `std/http/wire.yoop` now exports NOTHING where its
  header used to say "internal by convention" while exporting everything, and the
  whole sqlite and socket FFI surfaces went private. They also flushed out three
  compiler bugs, all recorded in the doc: the struct-shell replacement (a silent
  MISCOMPILE, plus a pre-existing crash on any forward struct reference), the
  string/array literal global counter, and a per-invocation `fromFn` shim set.
  Remaining, optional: true lexical per-file import scope.

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
  cancellation tokens (`std/core/cancel/`), deadline- and cancel-aware
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
