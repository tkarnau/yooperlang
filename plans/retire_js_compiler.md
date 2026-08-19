# Retiring the JS compiler

The objective: `src/` (the JS reference implementation) is deleted, and the
bootstrap in `bootstrap/` is the only Yooperlang compiler in the repo. After
this lands, an engineering contribution to the compiler means a contribution to
the bootstrap, and nothing in the tree requires a JS representation of the
compiler to build, test, or ship.

Programs outside this repository that were built with the JS compiler are NOT a
constraint. The project is pre-public alpha.

## Where things actually stand

Measured with a stage1 bootstrap built from the current tree, by
`scripts/probe_surface.sh` and `scripts/probe_programs.sh`.

  surface (does codegen HANDLE the file):
    479 files, 458 done, 0 bad-ir, 21 refused, 19 distinct sites
    now 494 done, ONE refused, one site - and it is A2 below rather than
    anything about comptime. Every `@precompile` file compiles and runs.

  programs (does the program WORK, both compilers run and diffed):
    pass         244   204 ok   20 differ   19 bootgap
                       now 218 ok, 24 differ, 1 bootgap - see below
    intro          4     4 ok
    tour           5     5 ok
    modules_demo   1     1 ok
    playground    19     6 ok    3 differ    4 bootgap

All of `std/` compiles. The bootstrap compiles itself and reaches a stage2 /
stage3 fixpoint. The remaining language surface is small and it is
CONCENTRATED: 16 of the 19 refused files are one missing feature.

## A. Language gaps in the bootstrap

Everything here is measured, not guessed. Each item names the probe evidence.

### A1. Comptime evaluation (13 files, and all of them `@precompile`)

STATUS: five of the original sixteen are CLOSED, and not by an interpreter.
Backing a non-inlinable module-level const with a real global - `const` meaning
immutable rather than inlined - closed `dir_module/` (3 files),
`comptime_enum_fold.yoop`, `module_init_folded.yoop` and
`examples/playground/shader_demo/`. All five compile, run, and match the
reference. What is left is `@precompile` alone. See
[comptime_interpreter.md](comptime_interpreter.md).

The original description follows.

#### As originally measured (16 files)

Three refusal messages, one missing subsystem: there is no comptime
interpreter. The JS side has one in `src/jsyoopinterp/` (3990 lines: a lowering
to bytecode, an evaluator, a value model, an extern whitelist, and a
`comptimePass` over module-init decls).

  * `@precompile` on a `let` or a block, 13 files under `examples/pass/`.
    Failures there are HARD errors on the JS side, by design.
  * module-level `const` initialized by a CALL, 1 site gating 3 files
    (`examples/pass/dir_module/`). The JS side folds it SILENTLY and falls back
    to a runtime `<modid>__module_init` when folding fails, so no ordinary
    program grows a build error from it.
  * module-level `const` whose initializer is not one of the four inlinable
    literal shapes: `comptime_enum_fold.yoop` (a variant), `module_init_folded.yoop`
    (an int expression), `examples/playground/shader_demo/` (a uint32 expression).

  DECISION NEEDED. `@precompile` and comptime folding are NOT in SPEC.md. This
  is either a subsystem the bootstrap has to grow, or a feature the language
  drops. See "Open decisions".

### A2. Task handle copy needs a refcount retain (1 file)

`examples/pass/propagates_full/main.yoop:36` - `"h3" binds a Task<T> handle
that is not a fresh spawn`. Only a direct call to a `task` function may bind a
handle today; copying one needs the refcount retain the bootstrap does not
emit. `refcounted` and `mustCall` already exist as binding kinds, so the
machinery is half there.

### A3. Keyword member names (1 file) - DONE

`examples/pass/keyword_field_names.yoop:28:14: expected IDENT, got COMMA`. The
variant, struct and union body parsers each assumed `function` could only ever
head a METHOD, so a member NAMED with the keyword was unreachable. The reference
disambiguates on the token after it, and now so does the bootstrap: `{` / `,` /
`}` for a variant case, and `:` for a struct or union field. An enum case named
`function` is refused by BOTH, so that stays as it is.

Covered by `parse.test.yoop` (7 assertions) and
`bootstrap/tests/slice/keyword_member_names.yoop`, which the reference agrees
with.

### A4. A codegen internal error (1 file) - DONE

`examples/pass/http_concurrent/main.yoop`: `codegen: internal error: no stack
slot to borrow "liveHandlers"`. Nothing to do with async or atomics - `ref` on
ANY module-level `let` failed, because `emitRefBase` knew three things with an
address (a field, an element, a local) and a global is a fourth. Reading and
writing a global already took that fall-through; the borrow did not.

Fixed with an `Operand.GlobalAddr` - a global already IS storage, so a borrow of
one is its symbol and costs no instruction, which is the global's answer to
`SlotAddr`. Writing the fixture turned up a sibling hole the probe could not
reach, `ref g.field`, where the gep had to start from the symbol rather than
from a slot; the reference handles both, so both are fixed.

Covered by `codegen.test.yoop` (3 IR assertions) and
`bootstrap/tests/slice/ref_module_global.yoop`, which the reference agrees
with.

### A5. Enum-to-primitive coercion at an argument position (1 playground file)

Documented in bootstrap/README.md as the "FOURTH DIVERGENCE". The reference
coerces a value enum to its underlying primitive when passing it to a C
signature; the bootstrap refuses by name. `examples/playground/nebula_arena/`
wants it. Playground is not a test surface, so this is optional - but once the
reference is gone, "refused here, accepted there" stops being a safe direction
and becomes just a refusal.

### A6. Two playground parse/resolve gaps

`examples/playground/servertest2/` (`expected RPAREN, got IDENT`) and
`examples/playground/diskscope/` (`unknown name "sdl"`). Playground, so
optional, but each is one unexamined site.

## B. Behavioral divergences, and which side is right

23 DIFFER lines across pass and playground. All but one are the SAME two
divergences, and the bootstrap is the correct side of both. They are worth
recording before the reference goes away, because after that there is nothing
left to notice them against.

  After A3 and A4 the count is 22 in `pass`, because two programs that could not
  be built before now build and land on the bool divergence
  (`http_concurrent`) or on a nondeterministic one. That last is a finding about
  the PROGRAM and it matters for decision 4: `examples/pass/async_yield_smoke.yoop`
  emits its lines in whichever order two coroutines wake, so its DIFFER is an
  interleaving rather than a disagreement, and it cannot be given a fixed
  `.expected` without being made deterministic first. Expect others like it when
  the corpus is built.

  * BOOL interpolation. `${flag}` prints `true` / `false` under the bootstrap
    and `1` / `0` under the reference. 13 programs.
  * FLOAT interpolation. `${x}` prints `3.5` under the bootstrap and `3.500000`
    under the reference. 9 programs.

  The 23rd looked like it might be a bootstrap miscompile. It is not, and it is
  RESOLVED - step 1 of the order of work below.

  * `examples/pass/derive_display_array_vec.yoop` - MAP ITERATION ORDER differs.
    Root cause: the JS reference carries integer literals as JS numbers, so any
    literal past 2^53 is rounded in the lexer and cannot be recovered
    downstream. The FNV-1a offset basis in `std/core/strings.yoop` is
    14695981039346656037, so under the reference EVERY STRING IN EVERY PROGRAM
    hashes to the wrong value, and a `Map` iterates in an order that follows.
    The bootstrap's values agree with the arithmetic done by hand. It is the
    same limitation `src/dumpTokens.js` already documents as a parity carve-out;
    what was not known is that it reaches all the way into program behaviour.
    Pinned by `bootstrap/tests/slice/wide_int_literals.yoop`, which also covers
    `uint64` interpolating unsigned - the reference renders it signed.

## C. Compiler capabilities that exist only in JS

These are compiler FEATURES rather than language features, and each one is a
capability the toolchain loses on the day `src/` is deleted.

  * DWARF DEBUG INFO. `src/jsyoopcodegen/debugInfo.js` (625 lines), emitted
    unconditionally, and the driver links with `-g -O0`. The bootstrap emits no
    `!dbg`, no `DISubprogram`, nothing. Covered by 24 unit tests and 5 `dwarf:`
    e2e tests today. Deleting the reference means Yoop programs stop being
    debuggable until the bootstrap grows this.
  * `--track-heap`. Codegen emits `yoop_diag_record_alloc` /
    `yoop_diag_record_free` calls. No bootstrap equivalent. Note
    `examples/pass/track_heap_basic.yoop` COMPILES under the bootstrap - the
    flag is what is missing, not the program.
  * `--warn-disposable` and `--warn-std`. Warning opt-ins. The bootstrap
    reports diagnostics but has neither flag.
  * `--dump-ast` and `--dump-ast-json`, plus `src/astViewerTemplate.html`.
    `npm run gen:web` calls `--dump-ast-json` directly.
  * `--list-attributes`, backed by the attribute registry in
    `src/jsyoopattributes/`. The bootstrap parses attributes but has no
    registry to enumerate.
  * `--keep-ir`, `-a` / `--output-modules`, `--dump-bc`. Minor, and `--emit-ir`
    already covers most of what `--keep-ir` was for.
  * `--lsp`. See section D.

  Already covered by the bootstrap and needing nothing: `--test` (the whole Yoop
  test harness, `bootstrap/src/test_mode/`), `--dump-tokens`
  (`bootstrap/tools/dump_tokens.yoop`), `@derive(display)`
  (`bootstrap/src/parse/derive*.yoop`), the module graph including `modules/`
  package resolution, std autoload, and clang invocation plus runtime linking.

## D. Things that ARE a JS representation of the compiler

Per the objective, these are flagged as needing a rewrite rather than a port.

  * THE LANGUAGE SERVER, `src/lsp/` (3356 lines plus 5019 with tests). It
    imports the JS lexer, the JS module graph and the JS typechecker's error
    formatter directly. It cannot be repointed at the bootstrap; it has to be
    rebuilt as a Yoop program, most naturally as `yoopiler_boot --lsp` reusing
    the bootstrap's own passes. This is the single largest rewrite in the
    objective and it is the reason the VSCode extension exists in its current
    shape (`editors/vscode/extension.js` launches `src/lsp/server.js` as a Node
    child process, falling back to a packaged binary).
  * THE COMPTIME INTERPRETER, `src/jsyoopinterp/` - same thing from the other
    direction, and it is A1 above.

## E. The test estate

This is the part that is easy to under-count. `npm test` is 1267 tests and
almost all of them are assertions ABOUT the JS compiler. Deleting `src/` deletes
them. The bootstrap's own estate today is 965 Yoop unit tests, 88 slice
fixtures, and the layer-1 parity corpus.

  * `src/e2e.test.js` - 403 tests, 4838 lines. 112 of them call
    `typecheckFixtureEntry` / `typecheckFixture` / `typecheckFixtureProgram`,
    which drive the JS typechecker AS A LIBRARY over fixtures in
    `examples/fail/` and `examples/pass/`. These are DIAGNOSTIC assertions and
    they have no bootstrap equivalent. The rest mostly compile and run a program
    and can be repointed at the bootstrap binary.
  * `examples/fail/` - 127 `.yoop` fixtures plus 12 directory fixtures, all of
    them negative tests whose expected diagnostics live inside the JS test file
    rather than beside the fixture. Nothing runs them against the bootstrap.
    This wants a DIAGNOSTIC FIXTURE HARNESS on the bootstrap side, in the shape
    the slice suite already established: a hand-written `.expected` beside the
    fixture, asserted against the bootstrap.
  * Per-subsystem JS unit tests - parser 213, typechecker 65 + 138 across the
    smaller files, lexer 57, codegen 18, debug info 24, derive 17, interp 6.
    Each needs its bootstrap counterpart to exist before the JS one is deleted,
    or the coverage is simply gone.
  * `src/parity.test.js` - retires WITH the reference, by design.
  * `src/slice.test.js` and `src/selfhost.test.js` - these DRIVE the bootstrap
    from Node. They survive the deletion of the compiler, but the slice suite's
    JS-side parity assertion retires with it.
  * `src/runtimeC.test.js` (11 tests) and `src/std_index.test.js` (4) are about
    the C runtime and the generated index, not about the compiler. They stay.

## F. Tooling that is Node but is not a compiler

Keep for now; these orchestrate rather than reimplement. Each one has to be
repointed from `src/yoopiler.js` to `yoopiler_boot`.

  * `scripts/gen_web.mjs` - calls the JS driver for `--dump-tokens`,
    `--dump-ast-json`, and every tour program's build. The `--dump-ast-json`
    call is the one with no bootstrap equivalent (see C).
  * `scripts/gen_std_index.mjs` - a Yoop rewrite already exists at
    `tools/stdindex/main.yoop`. Switching to it is nearly free.
  * `scripts/package_bootstrap.mjs` - already bootstrap-only.
  * `scripts/build_sea.mjs` and `scripts/package_release.mjs` - these package
    the JS compiler. They retire with it.
  * `scripts/probe_surface.sh` - already bootstrap-only.
    `scripts/probe_programs.sh` compares the two compilers and so retires with
    the reference, which costs us the only thing that can catch a miscompile.
    Worth deciding what replaces it.
  * `tools/yoopkg/yoopkg.mjs` - the package manager, Node. Not a compiler.
  * `.github/workflows/ci.yml` - the `JS suite` step goes; the bootstrap Yoop
    test step becomes the whole gate, plus slice and selfhost.

## Decisions taken

  1. COMPTIME: BUILD it in the bootstrap. `@precompile` and module-init folding
     stay in the language, and the bootstrap grows a comptime interpreter.
  2. DWARF: port debug info to the bootstrap BEFORE `src/` is deleted. Yoop
     programs stay debuggable through the whole transition.
  3. LSP: let it LAPSE. `src/lsp/` goes with the rest, and
     `yoopiler_boot --lsp` gets rebuilt on the bootstrap's own passes
     afterward. The editor experience regresses to syntax highlighting in the
     meantime, and the VSCode extension's LSP client is dormant until then.
  4. MISCOMPILE COVERAGE: grow the `.expected` corpus. Every program under
     `examples/pass/` and `examples/tour/` gets a hand-written expected output
     asserted against the bootstrap, in the shape `bootstrap/tests/slice/`
     already uses. 244 differential comparisons become 244 absolute ones.

## Order of work

Sequenced so that each step is independently landable and the risky, hard to
undo step - deleting `src/` - comes last and comes with everything it needs.

  1. THE MAP ORDER DIVERGENCE (B). DONE. Root-caused to the reference's 2^53
     literal rounding, and pinned by a slice fixture.
  2. THE TWO SMALL BUGS. Both DONE - A3 (keyword member names) and A4 (`ref` on
     a module-level `let`, plus `ref g.field`).
  3. A2, the task handle refcount retain. NOW THE ONLY REFUSAL LEFT in the
     whole corpus.
  4. THE COMPTIME INTERPRETER (A1). DONE - all thirteen `@precompile` files
     compile and run and match the reference. See
     [comptime_interpreter.md](comptime_interpreter.md).
  5. DWARF DEBUG INFO (C).
  6. THE REMAINING DRIVER FLAGS (C): `--track-heap`, `--warn-disposable`,
     `--warn-std`, `--dump-ast-json`, `--list-attributes`.
  7. THE `.expected` CORPUS (E, decision 4), and the diagnostic fixture harness
     for `examples/fail/`.
  8. PORT THE REMAINING JS UNIT-TEST COVERAGE to Yoop unit tests, subsystem by
     subsystem, deleting each JS file only once its counterpart exists.
  9. REPOINT THE TOOLING (F): `gen_web.mjs`, `gen_std_index.mjs`, the CI job.
 10. DELETE `src/`, `examples/fail`'s JS-side assertions, `build_sea.mjs`,
     `package_release.mjs`, `probe_programs.sh`, and the `npm test` gate.
 11. REBUILD THE LSP as `yoopiler_boot --lsp`, and repoint the VSCode extension.

Steps 5 and 6 do not depend on step 4 and can move if it is convenient. Step 11
is deliberately after the deletion, per decision 3.

## Verification

The objective is complete when, with `src/` deleted:

  * `scripts/probe_surface.sh` reports 0 refused and 0 bad-ir over `std/`,
    `examples/pass/` and `bootstrap/src/`.
  * every `examples/pass/` and `examples/tour/` program builds and runs with
    `yoopiler_boot` and matches a hand-written expected output.
  * the diagnostics of `examples/fail/` are asserted against the bootstrap.
  * `npm run test:selfhost` still reaches a stage2 / stage3 fixpoint.
  * `npm run gen:web` regenerates the site with no JS driver on the path.
  * CI is green with no `npm test` step.
