# Bootstrap completion - phase 4, parity and the self-compile milestone

Extracted from [../bootstrap-completion.md](../bootstrap-completion.md). Items
4.2 (THE MILESTONE - the bootstrap compiles itself to a byte-identical
fixpoint), 4.3 (the complex tests and the playground programs) and 4.4 (the
edit-verify loop). Items 4.1 and 4.5 are still open and stay in the live plan.

**4.2 The bootstrap compiles ITSELF - DONE 2026-08-13. THE MILESTONE.**

    node src/yoopiler.js bootstrap/src/main.yoop -o stage1     the JS reference
    stage1 bootstrap/src/main.yoop -o stage2                   itself
    stage2 bootstrap/src/main.yoop -o stage3                   itself again

    stage2.ll == stage3.ll     byte-identical
    stage2    == stage3        byte-identical

3.2 and 2.12 took the self-compile from 10 diagnostics to zero, and stage2 built
on the first try. **stage3 did not**, and that is the part worth recording: the
fixpoint check earned its keep within a minute of being possible.

**What the fixpoint found, and neither would have been found any other way.**

  - **A struct FIELD whose own type is a VARIANT compiled as a variant
    CONSTRUCTOR.** `a.value` where `value: Operand` is a FIELD_ACCESS whose
    expression type is a variant - exactly what `Shape.Empty` looks like from
    codegen - and the `isVariantAt(exprId)` test came first, so the read was
    emitted as `Operand.<case 0>` with a fresh tag and an UNWRITTEN payload.
    Silent: stage2 compiled, ran, and emitted `call void @yoop_log_info(ptr
    17179869185)` where stage1 emitted `ptr %t1`. The base is what tells the two
    apart - a payload-less constructor's base is a TYPE NAME and was never
    checked as a value - so the struct test moves in front. It is the compiler's
    own `CallArg { ty: string, value: Operand }` that has this shape, which is
    why nothing before the self-compile ever asked.
  - **The max-value `usize` sentinel of 2.12**, above.

Both are one-line fixes and both are now regression-tested at two levels.

**How the fixpoint is CHECKED matters.** The two stages go to different
directories with the SAME BASENAME, because clang embeds the output path in the
Mach-O and in the code signature that covers it - `-o stage2` versus `-o stage3`
differ in 49 bytes that have nothing to do with the compiler (16 of LC_UUID, the
rest the embedded name and its hash). The emitted `.ll` is compared too, and it
is the stronger of the two assertions: that IS the compiler's output, and clang
is downstream of it.

**Three independent confirmations that stage3 is a working compiler**, not just
a byte-stable one:

  - the whole slice suite, 131 fixtures, run THROUGH stage3 against the same
    hand-written `.expected` files. All pass. `YOOP_BOOT_COMPILER=<path> npm run
    test:slice` is the switch, and it exists for exactly this.
  - the surface probe over all files, run with stage1 and again with stage3.
    The two reports are byte-identical. Measured at 425 files when this landed
    (161 / 159 / 82 sites) and re-measured at 429 after 3.3 (161 / 163 / 81
    sites), which is the first time the fixpoint was re-confirmed across a
    feature that changes how a whole FUNCTION is emitted rather than how an
    expression is.
  - stage3 builds and runs `hello.yoop`.

**It is now a permanent test.** `src/selfhost.test.js`, six assertions, about 16
seconds, wired into `npm test` and `npm run test:e2e` (and `npm run
test:selfhost` on its own). The case for keeping it is the two bugs above: it is
a full-compiler differential test over 30k lines of real Yoop, and it catches
the one class of bug no unit test can reach - a miscompile that only shows up in
the compiler the compiler built. The case against was runtime, and 16 seconds on
a 71-second suite is not a case.

**4.3 The complex tests and the playground programs - DONE 2026-08-13.**

The first item in this plan measured over code the surface probe has never
touched. Everything before it was steered by `std/`, `examples/pass/` and the
bootstrap's own source, compiled with `--emit-ir` and never RUN - so the probe
could say "codegen produced valid IR" and nothing at all about whether the
program WORKS. This one takes the ENTRY POINTS, links them, runs them, and diffs
the two compilers against each other.

### The tool

`scripts/probe_programs.sh`, a SIBLING of `scripts/probe_surface.sh` rather than
a flag on it. The surface numbers are what this plan has been steered by for its
whole life, so a probe that moved them would be a broken probe; the two ask
different questions over different sets and their totals should never be added
together.

    scripts/probe_programs.sh [compiler] [jobs] [filter]

An ENTRY is a file that DECLARES a `main` - a top-level `.yoop` or a `main.yoop`
inside a program directory - under `examples/pass`, `examples/intro`,
`examples/tour`, `examples/modules_demo` and `examples/playground`. Each is built
with BOTH compilers to separate output directories, then both binaries are run
with the entry's own directory as cwd, stdin closed, stdout and stderr merged,
and a wall-clock limit. Five categories, and each is a finding about something
different:

    OK        both built it, both ran it, same stdout and same exit code
    DIFFER    both built and ran it and the two disagree - the most interesting
              result there is
    BOOTGAP   the reference built it and the bootstrap did not. A BOOTSTRAP bug
    REFGAP    the bootstrap built it and the reference did not
    STALE     neither built it. A finding about the PROGRAM, not about either
              compiler

`examples/fail/` is excluded: those are compile-error fixtures, so "does it
build" is the wrong question. `*.test.yoop` is excluded too - a test module has
no `main` by design, and its driver mode is item 4.5 below.

Two things worth knowing before adding to it. macOS ships no `timeout`, so the
limit is a small `perl` fork-and-alarm wrapper that reports 124 on the limit and
128+signal on a kill, which is what keeps a segfault reading as 139 on both
sides instead of collapsing into a generic failure. And the two compilers do not
agree on a diagnostic FORMAT - the bootstrap prefixes `[error]`, the reference
renders a caret block under a `path:line:col:` header - so the one-line summary
tries both spellings rather than grepping for one and reporting the other's
trailing caret.

### Where it lands, measured

279 programs, run through stage1 and again through stage3:

    218   OK        both compilers build it, run it, and agree exactly
     26   DIFFER    both run it and the two disagree
     29   BOOTGAP   the reference builds it and the bootstrap does not
      0   REFGAP
      6   STALE     neither builds it

Per group, because they answer different questions and `examples/playground/` is
explicitly not a test surface:

    group          total    ok differ bootgap refgap  stale
    pass             243   201     20      22      0      0
    intro              4     4      0       0      0      0
    tour              11     8      2       1      0      0
    modules_demo       1     0      0       1      0      0
    playground        20     5      4       5      0      6

**The same probe run with STAGE 3 produces a byte-identical report** - same 279
lines, same categories, same messages - and stage2 and stage3 remain
byte-identical as binaries and as emitted `.ll`.

### Group 1: `examples/testing/`

The answer is "no, and here is exactly how much is missing".

**`yoopiler --test` is a DRIVER mode and the bootstrap does not have it.** The
flag is refused by name (`unknown option --test`). That was checked rather than
assumed, and it is the honest headline for this group.

What the reference's mode does (`src/jsyoopdriver/test_mode.js`, 205 lines, plus
its wiring in `src/yoopiler.js`): glob `**/*.test.yoop` under a path, parse each
and require `import.test;`, collect every kind-prefixed top-level function,
generate an entry module SOURCE holding a `main` that hands the table to
`std/test.yoop`, register that entry in the graph through a `readFile` overlay,
wrap each collected suite in an `export` after the graph loads, and after
typecheck reject any whose kind does not enumerate into `"suites"`.

**Everything BELOW the driver works, and that was measured rather than assumed.**
One parse gap was in the way and is fixed (below); after it, both test modules in
`examples/testing/` compile under the bootstrap. Writing out by hand the entry
module the reference GENERATES, and compiling that with each compiler, produces
byte-identical TAP output and the same exit code on both the passing suite
(`3 passed, 0 failed`, exit 0) and the failing one (`1 passed, 2 failed`, exit 2
- the exit code IS the failure count). So the language side of the harness -
the `suite` kind, the `test` binding that owns a block, `mustCall recordOutcome
beforeScopeEnd`, the `(() => void)[]` table, `std/test.yoop` itself - is
complete in the bootstrap today. Sized and written up as item 4.5.

### Group 2: `examples/pass/`, `intro/`, `tour/`, `modules_demo/`

259 programs, 213 of them OK - built by both compilers, run, and producing
identical output and exit codes. Nothing in this group is STALE: every one of
the 259 builds under the reference.

The 22 DIFFERs and 24 BOOTGAPs are enumerated below; the short version is that
**24 of the 26 DIFFERs across the whole probe are two already-documented
reference bugs where the bootstrap is the one that is right**, and 24 of the 29
BOOTGAPs are refusals this plan already tracks by name.

### Group 3: `examples/playground/` - the point of the exercise

20 real user-shaped programs. 5 OK, 4 DIFFER, 5 BOOTGAP, and **6 STALE - which
is a finding about those six programs and not about either compiler.** All six
fail under the JS reference too, for four separate reasons:

    3   `async function must be awaited` on `serve` / `serveDefault` - the known
        async conversion, and it is THREE rather than the two plans/README.md
        records: todo_api, yoopstore, and sun_moon
    1   `imports of value "tcpListen" from "std/net" must use the namespace
        form` - chat_agent, which predates the std value-import rule
    1   the reference CRASHES with `RangeError: Maximum call stack size
        exceeded` in `findScopedIdentInExpr` - algoscope
    1   the reference emits INVALID IR, `floating point constant invalid for
        type` - sdl_demo

The last two are reference bugs found by pointing this probe at a corpus nothing
had pointed a compiler at in a while, and neither is the bootstrap's to fix.

### What was fixed, and why each one qualified

Three, each small and each clearly a bootstrap gap that a corpus program hit.

**1. A kind prefix BESIDE the `function` keyword at top level.**
`suite function addsNumbers(): void { }` was "unexpected token at top level:
IDENT" - on a declaration that is perfectly well formed, and the spelling every
`*.test.yoop` in the tree uses. The two spellings had drifted apart: a METHOD
went through a prefix run that consumes the keyword when it is there, and a
top-level declaration went through `parseKindPrefixes`, which STOPS on
IDENT-then-FUNCTION because in an ANNOTATION position (`owned string`) a
following `function` means the annotation ended. Both go through one function
now. The run parser moved out of `traits.yoop` into a new
`parse/kind_prefix.yoop`, which also took the "declarations that CARRY a kind"
half of `kind_decl.yoop` - that file was 370 lines and the two halves are two
ideas. Tests: seven parse assertions and the `kind_prefixes` slice fixture,
which now carries both spellings at top level as well as on a method.

**2. `-L` / `-I` search paths, and the TLS glue source.** The whole reason
`examples/pass/https_client/main.yoop` was a BOOTGAP: it compiled, emitted valid
IR, named `ssl`, and died at `ld: library 'ssl' not found`. Two separate things
were missing, and both are in `link/`:

  - `link/search_paths.yoop` (new): the `-L` and `-I` half of the line. OpenSSL
    is KEG-ONLY in Homebrew - macOS ships LibreSSL and Homebrew refuses to
    shadow it - so the directory holding libssl has to be probed BY NAME.
  - `glueSources` in `link/runtime_root.yoop`: `yoop_tls.c` is excluded from the
    set every program gets, because it includes `<openssl/ssl.h>` and putting it
    in would make OpenSSL a build requirement for hello world. It has to come
    BACK for a program that named OpenSSL, or the link finds libssl and then
    fails on `yoop_tls_connect`.

The reference branches on `process.platform` and `process.arch` here; the
bootstrap has neither, so every candidate from every platform is offered and
`fs.exists` decides. That lands in the same place on a real machine and needs no
platform check to extend. Tests: nine assertions in a new
`bootstrap/src/link/link.test.yoop`, asserting the ORDER of the candidate list
rather than a command line - which is the only way to pin it without a machine
that has every one of those directories.

**3. `printf(<a runtime string>)` was UNDEFINED BEHAVIOUR.** The sharpest finding
in the whole item, and the one the surface probe could never have reached. C
reads printf's first argument as a FORMAT, so a string the program BUILT has
every `%` in its DATA read as a conversion pulling a vararg nobody pushed.
Measured on `examples/pass/http_url_smoke`: `encode=a%20b%2Fc%3Fd%3De` printed as
`encode=a                   b0.000000c0.000000d8776975808e`, and that last
number is a stack address. `codegen/printf_format.yoop` (new) splices `"%s"` in
front of a printf that has NO varargs and whose format is not a compile-time
constant. The test is the lowered OPERAND rather than anything syntactic:
`Operand.StrRef` IS "a module-level string constant", which is what a string
literal and a template with no interpolation both lower to. A call WITH varargs
is never rewritten - that is the author using it as a format. Tests: the
`printf_runtime_format` slice fixture, four shapes.

The reference never needed this because it turns a template into a format string
at COMPILE time (`${x}` becomes a literal `%d` and `x` becomes a vararg), so
runtime halves always arrive through `%s`. That same design is why it renders an
interpolated float as `3.140000` and an interpolated bool as `1`, which is the
known divergence in the follow-ups. This file is what makes both compilers safe
in the same place without giving that up.

Together the three took the probe from 215 OK to 218 and removed one whole
DIFFER shape.

### The 26 DIFFERs, classified

**24 of 26 are a reference bug where the bootstrap is right**, and both were
already in the follow-ups. This item is the first thing to measure how far each
one reaches.

    23   a template literal handed DIRECTLY to printf as its format. The
         reference re-renders through C, so an interpolated float is
         `3.140000` and an interpolated bool is `1`; the bootstrap builds the
         string with the language's own rules and says `3.14` and `true`.
         base64_roundtrip, bool_array, bool_eq, casts,
         codegen_name_and_literal_papercuts, enum_array, extern_library,
         float_literal, generics_overview, heap_alloc_struct,
         http_parse_smoke, kind_compose_inline, layout_compose,
         runtime_introspect, sha256_hmac, short_circuit, time_calendar,
         traits_multi_impl, type_inference, larger_example, pkgdemo, yooparse,
         ep02_values_and_loops
     1   MAP ITERATION ORDER, from the reference's broken `stringHash`. Measured
         directly this time: FNV-1a of "t" is 12638201494206808739 and the
         bootstrap says so, the reference says 12637105281113482372.
         derive_display_array_vec

A side finding worth acting on later: several of those files carry an in-file
`// expected output:` comment spelling the REFERENCE's rendering
(`casts.yoop:15`, `float_literal.yoop:10`, `heap_alloc_struct.yoop:19`,
`runtime_introspect.yoop:67`, `traits_multi_impl/main.yoop:38`,
`ep02_values_and_loops.yoop:63`, `time_calendar.yoop`). Under "the bootstrap is
right" those comments are stale. Left alone here - editing example expectations
is its own change with its own reviewer.

**The other two are bootstrap bugs, both new, both written up as items:**

     1   `examples/playground/sqlite_demo/main.yoop` - stdout is byte-identical
         and the EXIT CODE differs, 6 against 0. Item 5.17.
     1   `examples/tour/ep08_kinds.yoop` - a DOUBLE DISPOSE. Item 5.16.

### The 29 BOOTGAPs, classified

24 are refusals this plan already names, and seventeen of those are deliberate:

    14   `@precompile` (out of scope by design). 13 in examples/pass, plus
         playground/twinstick
     4   a module const needing comptime (out of scope): comptime_enum_fold,
         dir_module, module_init_folded, playground/shader_demo
     2   module-level `let` with a non-literal initializer (5.14):
         http_concurrent, module_level_mutable_array
     2   `union` (5.13): union_rgba, dir_module_shell_order
     1   reserved words as NAMES (5.15): keyword_field_names
     1   `from` as an ordinary identifier (a follow-up): tour/ep03_structs

The other five are what this item found, and each is written up below or in the
follow-ups:

     1   `examples/pass/propagates_full/main.yoop` - a field carrying the kind
         through an explicit PREFIX in its annotation
         (`handle: disposable FileHandle`) rather than through its own type's
         `propagates` clause. Already in the follow-ups as unbuilt; this is the
         first corpus file that wants it. Sized as item 5.18.
     1   `examples/modules_demo/main.yoop` - the `modules/` import root, the
         program-owned package directory. Refused by name already. Item 5.19.
     1   `examples/playground/diskscope/main.yoop` - `sdl.EVT_QUIT`, a module
         `const` reached through a NAMESPACE. Same gap `ns.Variant.Case` has and
         already in the follow-ups; what is new is that the message is
         `unknown name "sdl"`, which names neither the feature nor the fix.
     1   `examples/playground/nebula_arena/main.yoop` - passing a value `enum`
         where its UNDERLYING primitive is declared (`SDL_Init(flags)` against
         `function SDL_Init(flags: uint32)`). The reference coerces; the
         bootstrap refuses by name. A measured DIVERGENCE - bootstrap/README.md
         claimed "no implicit conversion in either direction" on both sides and
         that claim was wrong about the reference. Corrected there, recorded in
         the follow-ups, and left refused because refusing is the safe
         direction.
     1   `examples/playground/servertest2/main.yoop` - `implements (Into<E>
         WithContext<E>)` with NO COMMA between the two traits. SPEC.md says
         the list is comma-separated (`implements (Disposable,
         Iterable<Message>)`), so the PROGRAM is malformed and the reference is
         being lenient. Not a bootstrap gap; the papercut is that the message,
         `expected RPAREN, got IDENT`, does not say "you are missing a comma".

**4.4 The edit-verify loop - DONE 2026-08-13. 271 seconds to 161.** Not a
language feature; it is the thing every other item pays for many times over, so
it earns a number. Measured end to end first, serially, on a 14-core M-series
machine, and the measurement is most of the finding:

    command                                before    after
    node src/yoopiler.js .../main.yoop      4.93s     4.72s
    --test bootstrap/src/parse              2.25s     2.20s
    --test bootstrap/src/typecheck          5.32s     5.28s
    --test bootstrap/src/source_graph       1.62s     1.62s
    --test bootstrap/src/lex                0.80s     0.82s
    --test bootstrap/src/codegen            4.92s     4.95s
    --test bootstrap/src  (ALL 857)             -     7.83s
    npm run test:slice                     61.58s    17.87s
    npm run test:parity                     2.89s     2.70s
    npm run test:selfhost                  18.17s    18.33s
    npm run test:unit                      61.99s    18.12s
    npm test                               77.01s    46.55s
    scripts/probe_surface.sh               91.62s    62.56s

Three changes, in the order they paid:

  - **`npm run test:slice` was SERIAL and was the longest pole in the whole
    suite.** node:test runs test FILES in parallel and every test WITHIN a file
    sequentially, so one file was serializing 134 compile-link-run cycles while
    the other 25 files finished in seconds. `execFileSync` was the only reason;
    the fixtures share nothing, each writes `<stem>_bs` / `<stem>_js` into one
    temp dir and none binds a port. Making the helper async and putting
    `concurrency` on the describe - the same shape `e2e.test.js` already had -
    took it from 60.1s to 17.9s, and `npm test` from 77s to 47s with it.
    It PLATEAUS at about seven workers (18.8s at 7, 18.0s at 12, 18.4s at 28),
    so the cap is not what limits it; the remaining floor is the ~5s
    `before()` build that nothing can overlap plus the JS reference's half of
    each fixture, which costs 675ms against the bootstrap's 139ms.
  - **`--emit-ir` on the bootstrap driver**, and the probe uses it. The two
    questions the link used to answer as a side effect are now asked directly:
    `clang -S -emit-llvm` says whether the IR is valid, and a `define ... @main(`
    line says whether there is a `main` to link. All 435 files classify
    IDENTICALLY to the linking probe, message for message, and the one `bad-ir`
    file now says "invalid IR: icmp requires integer operands" where it used to
    say "clang failed (exit 256)".
  - **`--test bootstrap/src` runs all 857 Yoop unit tests off ONE build of the
    graph**, in 7.8s against the 14.9s the five per-module commands take between
    them. No code change - the driver already accepted it and nothing said so.

**What did NOT pay, and the honest version of why.** The brief expected the
probe to fall well under 20 seconds once the link was gone. It fell to 63, and
the reason is that the probe was never clang-bound the way the write-up above it
assumed. Total CPU across the run went from 619 core-seconds to 454, and 442 of
those 454 are the bootstrap compiler itself: every corpus file compiles its
whole import closure, so a file in `bootstrap/src/` compiles the entire compiler
before it can be classified (`typecheck/pass_d.yoop` emits 3.2MB of IR and takes
3.2 seconds in the compiler against 1.1 in clang). The `clang -S -emit-llvm`
validation that replaced the link costs about 3% of what is left. Getting the
probe materially below a minute now means making the bootstrap faster, which is
a different item.

Two more things measured and left alone:

  - **The rebuild is irreducible in the places anyone would look.** Of its 4.8
    seconds, 2.1 is graph load through typecheck, 0.9 is codegen and 1.8 is
    clang linking a 6MB `.ll`. The clang half is the compiler being built and
    the other half is the JS reference, which is being retired.
  - **Caching the runtime's compiled C sources buys nothing here.** e2e prebuilds
    them (`prebuiltRuntimeObjects`) and it looked like the same trick would help
    every link, but all 14 of them compile in 0.30s - a rounding error against a
    1.8s link, and a cross-invocation object cache in a shipping compiler is a
    staleness bug waiting to happen.

Raising the probe's worker count past 12 does nothing either (63.4s at 12, 68.1s
at 14, 65.5s at 20), which fits: the machine is 10 performance cores plus 4
efficiency ones, and 12 workers already only reach about 7x throughput.

**Determinism was PROVEN, not assumed**, since a parallel harness that is
occasionally wrong is worse than a slow one. 24 full slice runs - 12 at the
default 12 workers, 6 at 4 and 6 at 28 - each reporting 140 pass / 0 fail /
1 skip, with the sorted set of test names byte-identical across every run.
Ordering varies, which is what concurrency means; membership and outcome do
not.


---

### 4.5 `yoopiler --test` in the bootstrap driver - DONE 2026-08-14

**The last thing the reference DRIVER did that the bootstrap could not.** With it,
nothing on the critical path to retiring `src/` is open.

`yoopiler_boot --test <dir-or-file> [filter...]` globs the test files below a
path, collects their suites, generates an entry module holding a `main` that
hands the table to `std/test.yoop`, compiles it through the ORDINARY pipeline and
runs the result. The single-file shorthand works too: `yoopiler_boot foo.test.yoop`
enters test mode because the file declares `import.test;`.

**`--test bootstrap/src` reports `1..1020` / `# 1020 passed, 0 failed`, exit 0,
in 14 seconds, and the TAP is byte-identical to the reference's over all 1225
lines.** Verified independently of the implementing agent by running both and
diffing. `examples/testing/pass` gives `3 passed, 0 failed` exit 0 and
`examples/testing/fail` gives `1 passed, 2 failed` exit 2 on both sides, and
filters select the same suites. The self-host fixpoint still holds.

Five pieces, in a new `bootstrap/src/test_mode/` directory module - 595 lines
across five files plus a 316-line test file:

  - `discover.yoop` - the recursive walk, sorted so suite order is stable,
    skipping dot-directories and `node_modules`/`dist`/`build`/`target`. Entries
    are read to completion before any recursion, so one directory handle is open
    at a time whatever the depth.
  - `collect.yoop` - parses each file into an arena of its own and takes every
    top-level FUNCTION_DECL whose `childE` (the KIND_PREFIX list) is non-zero.
    Syntactic for the reference's reason, and it never has to know that a suite
    is spelled `suite`. A `.test.yoop` that does not declare `import.test;` is
    refused by name.
  - `entry.yoop` - the generated source, built with `Text`. One
    `import { <suite> as suiteN } from "<abs>";` per suite, a `(() => void)[]`
    table, a parallel `string[]` of `<relpath>:<suite>` labels, and
    `return harness.runAll(fns, names);`.
  - `plan.yoop` - decides whether an invocation is a test run.
  - `run.yoop` - `system()` on the linked binary, the wait status decoded back
    into an exit code, artifacts removed on both the success and the failure
    path. The binary goes to a pid-named path in the temp directory, never into
    the tree.

**The OVERLAY the brief warned about turned out not to be needed, and that was
the sizing decision that made this item small.** The plan called for a `readFile`
overlay on the module graph, "the piece with no equivalent in the bootstrap
today". No general path-answers-from-memory map was added. The generated entry is
the ONLY synthetic file, nothing imports it, and everything it imports is real -
the test files by absolute path, `std/test.yoop` through the std root. So
`walk.yoop` grew a second entry point, `loadModuleGraphFromSource`, both entry
points funnel into one `loadGraphFrom`, and the fork happens only when `isEntry`
is true. Roughly 40 lines. `moduleFromSource` needed no change at all.

The `export` wrapper lives in `source_graph/test_exports.yoop` and fires from
`addFile`, one line after the derive expansion and for the reason that comment
already gives: typecheck reads a Module by value, so a node grafted later lands
in a copy.

**One thing outside the sized work: the parser was DISCARDING `import.test;`.**
The wrapper is keyed on the module actually declaring it rather than on the file
name, which made the flag something that had to survive the parse. It is recorded
in the PROGRAM node's `intVal`, documented as the module flag word beside `flagA`
(already spoken for by `import.unsafe;`), with `PROGRAM_FLAG_TEST` and
`isTestModuleProgram` in `ast/arena.yoop`.

Three things found and deliberately not fixed:

  - `linkExecutable` writes the `.ll` BEFORE checking that the runtime root
    exists, so a build that fails on a missing `YOOP_RUNTIME_ROOT` leaves an IR
    file behind. Test mode cleans up after itself on that path; an ordinary
    compile with `-o` still drops one. That is `link/`'s call about ordering.
  - Filters reach the test binary through `system()`, so they are shell-quoted
    rather than passed as argv. Suite-name substrings are safe; shell
    metacharacters would not be. The bootstrap has no exec API - `link/clang.yoop`
    has the identical constraint - so this is the same gap in a second place
    rather than a new one.
  - `dist/` is in `.gitignore`, so the on-disk skip-list proof is a `.hidden/`
    directory and the four build-directory names are pinned as a pure-function
    test instead.
