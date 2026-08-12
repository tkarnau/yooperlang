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

**`contracts.yoop` is gone as of 2026-08-12.** Its 1199 lines were an artifact
of a module being one FILE; directory modules removed the reason, and each
layer's vocabulary now lives with the layer that owns it. The tree is one module
per directory - `diagnostics`, `lex`, `ast`, `parse`, `source_graph`,
`typecheck`, `utils` - and the map is in
[../bootstrap/README.md](../bootstrap/README.md). Do not reintroduce a shared
types file.

- **Layer 0 - module graph**: WORKING. `source_graph/` walks imports depth-first,
  dedupes by absolute path (so a diamond loads its shared leaf once), refuses
  import cycles, and hands back a topologically ordered `Vec<Module>` with the
  entry LAST. Each module gets a readable, LLVM-safe id (`mathx_1`) that every
  symbol it defines is mangled against. A module is one file, or a DIRECTORY of
  files that each declare `module <name>;` and share one namespace, one id and
  one AST arena. Not yet: the `std/` and `modules/` roots, autoloads,
  side-effect imports - all refused by name.
- **Layer 1 - lex**: WORKING AND AT PARITY. `npm run test:parity` diffs the
  bootstrap token stream against the JS lexer's over 557 real source files.
  Getting there found three bugs: `0o755` lexed base-2, 14 words were promoted
  to keywords that the JS lexer leaves as contextual identifiers, and `await`
  was missing. `lex/` covers the full token set; the old
  `tests/lexer_tests` harness checks every keyword, structural token, and atom,
  and `lex/lex.test.yoop` covers sorting, precedence, keyword-vs-ident,
  literal values, and nested block comments.
- **Layer 2 - parse**: IN PROGRESS. The arena and recursive descent are built.
  Handles top-level `type` (struct body, transparent alias, type params, kind
  prefix) and `function` decls, blocks, `let`/`const`, `return`, assignment,
  `if`/`else if`/`else`, `while`, `for`, `break`/`continue`, calls, arrays
  (`T[]`, literals, indexing, `.len`), structs as values (literals, field read
  and write), `switch` with multi-pattern arms, integer casts, unary and
  compound-assignment forms, expressions by precedence climbing, `module`
  headers, `export`, every `import` form but the side-effect one (named,
  namespace, combined, and directory-module paths), and `variant` decls with
  their constructors and patterns. Not yet: traits,
  enums, unions,
  methods in a type body, `implements`/`propagates`/`contains` clauses - each a
  named "not supported yet" refusal rather than a mis-parse.
- **Layer 3 - typecheck**: IN PROGRESS. The interned Type/Symbol/Program model
  is built, with pass A (shells + redeclaration + exports), pass B (imports and
  namespaces), pass C (function signatures, struct fields) and a thin pass D
  (bodies + resolvedTypes decoration, including `ns.fn()` resolution). An import
  binds the SOURCE module's SymbolId - the same integer - which is what makes an
  imported type compare equal to the declared one, since type equality is
  `id == id`. Diagnostics name the file they came from. The largest layer.
- **Layer 4 - bytecode IR**: the one planned deviation from the JS pipeline
  (JS has no IR; the bootstrap may add one). Hold the codegen input contract
  stable so this stays an absorbable, contained change. Deferred until a pass or
  optimization actually wants it.
- **Layer 5 - codegen**: IN PROGRESS. `codegen/` emits LLVM IR text for the
  slice subset (functions with parameters, return, int/string literals,
  arithmetic, comparisons as `icmp`, calls, printf, locals/params as hoisted
  alloca + store/load, and `if`/`while`/`for`/`break`/`continue` as labels and
  branches over a loop-label stack, and short-circuiting `&&`/`||` through a
  stack slot rather than a phi, arrays as a `{ ptr, i64 }` descriptor, `switch`
  as an LLVM jump table, named struct types passed by value, C varargs
  promotion, `<moduleId>__<name>` symbol mangling so one LLVM module can
  hold the whole graph, and variants as a tag plus a payload blob). Split
  into deciding (`expr`/`stmt`), emitting (`instr`, one function per LLVM
  instruction with a sample of its output) and appending (`context`); the rules
  are in bootstrap/README.md and are bootstrap-specific.
- **Layer 6 - link**: WORKING. `link/` shells out to clang via libc `system`.

**A vertical slice runs end to end as of 2026-08-12.** The bootstrap compiles
`bootstrap/tests/slice/*.yoop` to real executables, and `npm run test:slice`
asserts the JS compiler and the bootstrap produce identical stdout and exit
codes. Seeding every layer first was the right call: it is what turned codegen
and link from "someday" into concrete, small modules.

**The module system landed on 2026-08-12.** Three slice fixtures cover it:
`imports.yoop` (named imports, aliases, a diamond), `namespaces.yoop` (`* as ns`
and `ns.fn()`), and `dir_modules.yoop` (a directory of files sharing one
namespace). Every layer carries its share - the graph walk and the directory
unit (layer 0), headers and all three import clauses (layer 2), pass B and the
export table (layer 3), symbol mangling (layer 5).

The one refactor it forced is worth knowing: a Module now owns several
SourceFiles that share ONE arena, so NodeIds stay unique per module and
typecheck's decoration stays a single dense vector. Diagnostics gained a file
path in the same change, because `12:5` stopped identifying anything.

**Variants landed on 2026-08-12.** `tests/slice/variants.yoop` covers tagged
unions end to end: constructors, exhaustive and defaulted switches, payload
bindings, a struct inside a payload, and value-copy semantics. The layout is
`{ i32 tag, [N x i8] payload }` with one payload struct per case, sized by
`typecheck/layout.yoop` to match the JS reference. Errors-as-values is the point
of it - `Result` and `Option` are in essentially every bootstrap signature.

**The `std/` import root landed on 2026-08-12.** `std/...` resolves against a
root discovered from `YOOP_STD_ROOT` or probed beside the executable - the same
variable the JS reference honours, which is what lets one setting point both
compilers at a stub. `tests/slice/std_imports.yoop` does exactly that, with its
own `std_imports.std/` beside it, so the resolution path is tested end to end
long before the language can compile the real std. Values from std must come
through a namespace; types may not need to. Same rule, same message, as
src/jsyooptypecheck/imports.js.

Pointing it at the REAL std now gives a precise, ordered blocker list instead of
a blanket refusal - which is the whole reason to do this before the features it
is waiting on:

    std/core/types.yoop    generic variant "Result" is not supported yet
    std/core/strings.yoop  a generic type application in an annotation
    std/core/vec.yoop      "implements" clauses on a type decl
    std/log.yoop           `extern` blocks

So what remains before the bootstrap can read its own source is: **generics**
(31 of its files, and the gate in front of `Result<T, E>` and therefore in front
of all of std), **traits and `implements`**, **`extern`**, and **template
literals** (65 files, and the first feature to need the yoop RUNTIME linked
rather than just libc).

Immediate build sequence:

1. DONE - token dump + parity harness (src/dumpTokens.js,
   bootstrap/src/lex/dump.yoop, src/parity.test.js).
2. Design the layer-2 AST dump. The two ASTs are different shapes (NODE_LIST
   wrappers and annotation nodes here, plain arrays and annotation objects in
   JS), so a normalized tree format has to come BEFORE the parser grows much
   further. Then grow the parser toward what the bootstrap itself uses.
3. Typecheck pass C (fill the shells: struct fields, function signatures), then
   pass D (bodies + decoration); diff resolved types + diagnostics.
4. Build codegen straight from the typed AST (skip the IR layer initially, as
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
  helpers in [../tools/](../tools/) (~30 names) and example-local helpers under
  [../examples/](../examples/). The bootstrap's module-level consts were fixed
  on 2026-08-12 (`TOKEN_SCAN_LIST`, `KEYWORD_LIST`, `WHITESPACE_CHAR_CODES`).
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
