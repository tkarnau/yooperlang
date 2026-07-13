# Testing in Yooperlang - design exploration

Status: DRAFT / not committed. This is a pros-and-cons document to read over,
not a build order. Nothing here is scheduled against the current focus
(self-hosting bootstrap); it lands when testing earns its place. If/when a
direction is chosen, the rest moves to archive/ and a build plan replaces this.

Style: ASCII only. No em-dashes, no curly quotes, no fancy tables.

---

## The question

How does a Yoop program define tests in a language-preferred, low-noise way,
and how do we run them? Two run modes the user wants:

1. Build/run a program normally from its entry file (today's behavior).
2. Run with a test mode that discovers and runs every test in the program,
   with filtering to run an explicit subset.

The constraint that drives most decisions: tests should NOT be obtrusive in the
code itself.

---

## What we already have to build on

This is most of the reason testing is cheap to add.

- An `@`-attribute system. Parser builds ATTRIBUTE nodes in `parseAttribute`
  ([../src/jsyooparser/parser.js](../src/jsyooparser/parser.js) around line 839).
  An attribute is `@name(args?) target` where target is one of: a `{ ... }`
  block, a `let`/`const` decl, or a bare `;`. Args are a parsed expression list.
- A registry keyed by attribute name with per-phase handlers (parse / typecheck
  / comptime / codegen): [../src/jsyoopattributes/registry.js](../src/jsyoopattributes/registry.js).
  Only `@precompile` is registered today. The registry doc comments explicitly
  name `@test` / `@expect` / `@verify` / `@assert` as the intended next
  consumers, and the `codegenPhase` hook exists precisely for attributes that
  "lower to runtime code."
- An attribute pass that walks every module's AST (recursively, into bodies)
  collecting ATTRIBUTE nodes and dispatching their handlers:
  [../src/jsyoopattributes/pass.js](../src/jsyoopattributes/pass.js).
- A comptime bytecode interpreter that can evaluate pure code at build time:
  [../src/jsyoopinterp/](../src/jsyoopinterp/).
- A driver entry using `parseArgs`, already carrying mode-ish flags like
  `--list-attributes`, `--dump-ast`: [../src/yoopiler.js](../src/yoopiler.js).
- A module-graph loader that walks imports from an entry file:
  [../src/jsyoopdriver/moduleGraph.js](../src/jsyoopdriver/moduleGraph.js).
- Prior intent is written down: [archive/phase-11-comptime.md](archive/phase-11-comptime.md)
  lines 105-119 reserve `@test` / `@expect` / `@verify` as registry entries,
  and the old roadmap (archive/roadmap.md) sketches a pass/fail example-walker
  as the original regression idea.

Net: the surface and the dispatch points exist. The genuinely new code is a
test-runner entry point and an assertion lowering.

---

## Prior art and what is (and is not) reserved

What I found in the tree as of this draft, so the options below can either lean
on it or deliberately ignore it:

- NO keywords are reserved for testing. `test`, `expect`, `assert`, `verify`,
  `bench` are all ordinary identifiers - none appear in the lexer keyword table
  (`keywordTagList` in [../src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js)).
  This matters: attribute names live in the `@` registry namespace, separate
  from the identifier namespace, so adding `@test` does NOT reserve `test` as a
  word - user code can still have a variable or function named `test`. This is a
  real point in favor of the attribute approach (Decision 1, Options A/B) and
  against the naming-convention approach (Option C), which DOES squat on the
  identifier namespace.
- Only `@precompile` is actually registered
  ([../src/jsyoopattributes/registry.js](../src/jsyoopattributes/registry.js)
  line 58). Nothing else is implemented.
- `@test` / `@expect` / `@verify` / `@assert` / `@bench` / `@deprecated` are
  carved out only as DOCUMENTATION reservations, not code and not grammar:
  - registry.js doc comments name `@test`/`@expect`/`@verify`/`@assert` as the
    intended next consumers and shape the handler contract around them.
  - a lexer.js comment lists `@test`/`@verify` as example attribute names.
  - [archive/phase-11-comptime.md](archive/phase-11-comptime.md) lines 105-119
    reserve `@test`/`@expect`/`@verify`/`@deprecated` as "registry shape only,"
    explicitly deferring semantics.
  - one mention in [completed/phase-10-d-debug-log.md](completed/phase-10-d-debug-log.md).
  None of these pin behavior. They reserve the names and the integration points;
  every semantic decision in this doc is still open.
- No `std/test.yoop` (or any std testing module) exists yet.

So the only thing genuinely "carved out" is: the attribute mechanism, and the
intent to use `@test`/`@expect` as its testing consumers. Everything else
(execution model, file layout, assertion semantics, CLI, filtering) is
greenfield. Where an option below contradicts even that much (the
naming-convention and kind options in Decision 1), it is included per the
request to also weigh designs that ignore the prior carve-out - each is flagged
"(ignores prior intent)".

---

## Goals and non-goals

Goals:

- Marking a test is one token of noise, co-located with the code or in a sibling
  test file. No boilerplate per test.
- Test code is absent from normal (non-test) builds.
- A single command runs all tests in a program; flags narrow to a subset.
- Failure output names the test, the file/line, and the asserted expression.
- Fits Yoop semantics: no exceptions, errors-as-values, traits/kinds.
- Reuses the existing pipeline (module graph, typecheck, codegen) rather than a
  parallel one.

Non-goals (at least for a first cut):

- Mocking/stubbing frameworks, fixtures with setup/teardown lifecycles,
  parameterized-test matrices. Can layer later.
- Benchmark harness (separate concern; `@bench` could mirror `@test` later).
- A coverage tool.

---

## Decision 1: how a test is marked

### Option A - `@test` block (parses today, zero grammar change)

```js
@test("read_all rejects empty path") {
    const r = read_all("");
    @expect(isErr(r));
}
```

`@test(string) { ... }` already parses: args plus a block target are both
supported. `@expect(cond);` is a bare-semicolon-target attribute, also already
parseable. So the entire surface above is grammatically legal right now; only
the handlers and runner are missing.

- Pros: no parser work to start. Name is an arbitrary string, so it can be a
  full sentence. Easy to nest assertions.
- Cons: a block is not a callable symbol (cannot run/import one test directly).
  The name lives in a string, not an identifier, so no tooling jump-to-symbol.
  Slightly un-function-like.

### Option B - `@test` on a function decl (small parser addition)

```js
@test
function readAllRejectsEmptyPath(): void {
    const r = read_all("");
    @expect(isErr(r));
}
```

Needs the attribute target to accept a FUNCTION_DECL. The parser comment at the
target switch already anticipates this ("future attribute consumers can extend
the dispatch (e.g. decorate a function decl)").

- Pros: the function name IS the test name (no string). The test is a real,
  individually callable symbol. Natural home for `<T>` generic tests later.
  Reads like every other declaration.
- Cons: a small grammar extension. Test names are identifiers, so they are
  camelCase rather than free-form prose (mitigated by an optional
  `@test("prose name")` arg).

### Option C - naming convention (no syntax at all)

Any function named with a `test` prefix is a test.

- Pros: zero new syntax.
- Cons: pollutes the normal symbol namespace; the compiler special-cases names,
  which is muddier than an explicit marker; no place to hang metadata (tags,
  skip, expected-fail); collides with the camelCase-only identifier convention.

### Option D - a `test` kind (`test function foo()`)

- Pros: reuses the kind grammar (`appliesTo function`).
- Cons: semantic mismatch. Kinds are usage/lifecycle/sharing contracts; "this is
  a test" is not one. Would force `test` to become reserved. Wrong tool.

Leaning: ship Option A first (free), add Option B shortly after as the
preferred long-term form. A/B can coexist - both feed the same discovery pass.
Reject C and D.

---

## Decision 2: where tests live

### Option A - colocated sibling files: `foo.test.yoop`

Mirrors the host JS compiler's own convention (`<file>.test.js`). Normal builds
ignore `*.test.yoop`; test mode pulls them into the module graph.

- Pros: production source untouched ("not obtrusive" in the strongest sense).
  Tests sit next to what they cover. Naturally excluded from shipping binaries.
- Cons: a file naming rule the driver must special-case. Cross-file-private
  testing needs the test file to import what it checks (fine for Yoop's
  module-as-file model, but internal-only helpers must be exported or re-tested
  through the public surface).

### Option B - inline `@test` in regular files

- Pros: closest to the code; good for tiny unit checks.
- Cons: test code ships in normal builds unless we strip `@test` nodes pre-codegen
  in non-test mode (doable, since the attribute pass already finds them). Adds
  noise to the file.

### Option C - a dedicated tests/ directory

- Pros: clean separation.
- Cons: distance from the code under test; least "co-located." Yoop's
  relative-path imports make a parallel tree slightly awkward.

Leaning: support both A and B; make A (sibling `*.test.yoop`) the documented
default and B available for quick cases. In non-test builds, `@test`/`@expect`
nodes are dropped before codegen so inline tests cost nothing at runtime.

---

## Decision 3: assertions

Yoop has no exceptions, which makes this clean rather than hard.

### Option A - `@expect(cond)` lowering to early-return-and-record

Inside a `@test`, `@expect(cond);` lowers (in the registry `codegenPhase`) to:

```js
if (!(cond)) {
    __yoopTestFail(/*test name*/, /*file*/, /*line*/, /*"cond" source text*/);
    return;   // ends THIS test; the runner proceeds to the next
}
```

A process-global (or thread-local) pass/fail counter accumulates. Returning
early just ends the current test function; the runner moves on. The parser
already has source locations and can capture the condition's source substring,
so a failure can print `expected: isErr(r)  at foo.test.yoop:12` with no extra
user input.

- Pros: exception-free, exactly matching the language. Cheap. Good messages for
  free. Same lowering pattern reusable by `@verify`/`@assert`.
- Cons: needs a tiny runtime support symbol (`__yoopTestFail` + counter). The
  early-return semantics mean later assertions in a failed test do not run
  (standard "fail fast per test"; a `@expectSoft` variant could continue).

### Option B - a std assertion function

```js
import * as t from "std/test.yoop";
t.expect(isErr(r));
```

- Pros: no attribute machinery for assertions; just a function.
- Cons: a plain function call cannot capture the source text of its argument or
  the call-site line as nicely (it sees a bool, not `isErr(r)`), so messages are
  worse unless we pass strings by hand. More obtrusive at the call site.

### Option C - tests return `Result<void, string>` and use `?`

```js
@test
function foo(): Result<void, string> {
    expectTrue(isErr(read_all("")))?;
    return Result.Ok { value: {} };
}
```

- Pros: pure Yoop, no new lowering; reuses errors-as-values and `?`.
- Cons: verbose, boilerplate-y, and the user must thread `Result` through every
  test. Defeats the low-noise goal.

Leaning: Option A as the primary surface, with the assertion family kept small:
`@expect(cond)` (fail-fast), and optionally `@expectSoft(cond)` (record but
continue). Option B's `std/test.yoop` can also exist for programmatic use, but
the attribute is the ergonomic default.

---

## Decision 4: execution model

### Option A - runtime test binary

Test mode swaps the user's `main` for a synthesized runner `main` that calls
every discovered test, accumulates pass/fail, prints a summary, and sets the
exit code. Built and run through the normal pipeline.

- Pros: tests can do anything real code can (I/O, allocation, tasks). One code
  path. Straightforward.
- Cons: a compile+link+run per test session. Slower feedback than pure
  build-time checks.

### Option B - comptime tests (build-time, no binary)

For tests whose bodies are comptime-evaluable (pure functions, no I/O/alloc),
run them in the existing interpreter ([../src/jsyoopinterp/interp.js](../src/jsyoopinterp/interp.js))
and fail the BUILD directly. No test binary at all.

- Pros: instant feedback, folded into compilation. Leverages a system that
  already exists. Great for pure logic (lexer tables, parser helpers, math).
- Cons: only works for the comptime-evaluable subset. Anything touching the
  runtime, the OS, or allocation cannot run here.

### Option C - hybrid (auto-route)

Try to evaluate each `@test` at comptime; if its body is not comptime-evaluable,
compile it into the runtime test binary instead.

- Pros: best of both. Pure tests are build-time and instant; the rest run
  normally. Matches how `@precompile` already degrades.
- Cons: two execution paths to maintain and to explain. Need a clear rule (or a
  per-test opt-in like `@test(comptime: true)`) so users know where a given test
  runs and why a failure surfaced at build vs run.

Leaning: start with Option A (simplest, covers everything), then add Option B
as an opt-in (`@test` bodies the user marks, or that the router proves pure) so
the comptime interpreter starts paying for itself. Full auto-routing (C) is a
later refinement once the boundaries are understood.

---

## Decision 5: CLI surface

The driver already parses flags with `parseArgs` in
[../src/yoopiler.js](../src/yoopiler.js).

### Option A - subcommand: `yoopiler test <entry-or-path>`

- Pros: clearly a distinct mode; room for test-only flags without crowding the
  build flags; familiar (cargo test, go test).
- Cons: `parseArgs` is currently flat flags + positionals; a subcommand is a
  small dispatch addition.

### Option B - flag: `yoopiler --test <entry>`

- Pros: trivial to add next to the existing `--list-attributes` / `--dump-ast`
  mode flags.
- Cons: test-specific options (`--test-filter`, `--test-tag`) sit in the same
  flat namespace as build options.

Leaning: either is fine; `--test` is the lower-friction first step and matches
the existing mode-flag style. Can promote to a `test` subcommand later if the
flag set grows.

The mode itself:

1. Load the module graph from the entry/path, INCLUDING `*.test.yoop`.
2. Run the attribute pass to gather every `@test` node (it already recurses
   into bodies).
3. Synthesize a runner `main` that invokes each test with the counter
   bookkeeping (this is the one genuinely new codegen piece).
4. Compile + run; print results; exit nonzero on any failure.

---

## Decision 6: filtering

Match against the test name (and optional tags carried as attribute args, since
args are already a parsed expression list).

```text
yoopiler --test ./src                  # every test reachable under src
yoopiler --test -k "empty path"        # substring/glob on the test name (pytest -k)
yoopiler --test src/lexer.test.yoop    # a single file
yoopiler --test --tag net --skip slow  # if @test("name", ["net","slow"]) is allowed
```

- Name filter (`-k` / `--test-filter`): cheapest, covers most needs.
- Tag filter: tags ride as a second attribute arg array. `--tag` includes,
  `--skip` excludes.
- A `--list-tests` flag (parallel to the existing `--list-attributes`) is cheap
  and helps tooling and CI sharding.

Pros/cons: name-only filtering is trivial and probably enough for v1; tags add
real value for "run only fast tests in the inner loop" but cost a small bit of
arg parsing and a convention. Recommend name filter first, tags second.

---

## Decision 7: reporting and exit codes

TAP-ish, line per test, machine- and human-readable:

```text
ok 1 - lexer scans integer literals
ok 2 - lexer scans hex literals
not ok 3 - read_all rejects empty path
    expected: isErr(r)
    at src/io.test.yoop:12
1..3
2 passed, 1 failed
```

Process exit code = number of failures (0 = all passed), so CI gates on it
directly. A `--quiet` flag could drop the per-test lines and keep only the
summary. JSON output (`--test-json`) is an easy later add for tooling.

---

## Recommended first slice (smallest thing that is useful)

In rough order, each independently shippable:

1. Register `@test` (block form, Option 1A) and `@expect` in the registry, with
   a `parsePhase` that validates shape (`@expect` only inside a `@test`) and a
   `codegenPhase` that lowers `@expect` to the early-return-and-record pattern
   (Option 3A).
2. Add `__yoopTestFail` + a pass/fail counter to the runtime
   ([../runtime/](../runtime/)).
3. Add `--test` to the driver: load graph incl. `*.test.yoop`, collect `@test`
   nodes, synthesize a runner `main`, compile + run, TAP output, exit code
   (Options 4A, 5B, 7).
4. Add `-k` / `--test-filter` name filtering (Option 6).

Everything after layers on without redesign, which is what the registry was
built for:

- `@test` on a function decl (Option 1B).
- `*.test.yoop` auto-discovery polish and non-test-build stripping (Option 2).
- Tags + `--tag`/`--skip` + `--list-tests` (Option 6).
- Comptime routing for pure tests (Options 4B/4C).
- `@expectSoft`, `@verify`, `@bench` siblings.

---

## Open questions

1. Test name source: identifier (Option 1B) vs free-form string (Option 1A) vs
   both (string arg overrides the function name)? Both is probably right.
2. Per-test isolation: each test is its own function call in one process. Do we
   ever need process-per-test isolation (a test that corrupts global state or
   crashes)? A crash in-process takes the whole run down. Process-per-test is
   heavier but robust; defer unless it bites.
3. Setup/teardown: none in v1. Likely later via `@test.before` / `@test.after`
   or a fixture convention. Attribute names are single idents today, so dotted
   forms would need a grammar note.
4. Assertion richness: do we want value-printing (`expected 3, got 5`) by
   evaluating sub-expressions, or just the source text + location? Source text
   is free now; value capture needs the lowering to spill operands.
5. Where do tests for `std/` and for the bootstrap compiler live, and do they
   run in the same harness as user tests? Probably yes, which is a nice
   dogfooding forcing function.
6. Interaction with kinds: a `@test` body that opens a `disposable` should still
   get auto-cleanup at end of the test function (it is just a function body, so
   this should fall out for free - worth a fixture to confirm).
