# Bootstrap completion - the probe history

The measured chain from [../bootstrap-completion.md](../bootstrap-completion.md),
kept because it is the clearest record this project has of how a one-line gate
moves a whole import closure. Each block is one re-probe of every non-test
`.yoop` under `std/`, `examples/pass/` and `bootstrap/src/`, in the order the
items landed. The CURRENT numbers live in the plan doc; everything here is
superseded.

## Where this starts, measured

Probed on 2026-08-13: every non-test `.yoop` under `std/`, `examples/pass/` and
`bootstrap/src/` - 401 files - compiled with the bootstrap.

    36    compile all the way to an executable
    30    reach clang and fail ONLY for having no `main` (a library compiled
          standalone). Their code is fully handled, so 66 files really are done.
    11    reach clang and produce INVALID IR - real codegen bugs
    324   stop earlier, at a named parse or typecheck refusal

Re-probed after 1.1 landed, same 401 files:

    80    compile all the way to an executable
    23    reach clang and fail ONLY for having no `main`, so 103 are done
    12    reach clang and fail to LINK a `yoop_runtime` symbol - see 2.3
    26    reach clang and produce INVALID IR, every one of them 2.1's `malloc`
    260   stop earlier, at a named parse or typecheck refusal

Re-probed after 1.3 landed. Same corpus, now 403 files - `?` added
`typecheck/fallible.yoop` and `codegen/try_op.yoop` to `bootstrap/src/`:

    85    compile all the way to an executable
    33    reach clang and fail ONLY for having no `main`, so 118 are done
    28    reach clang and produce INVALID IR, still all 2.1's `malloc`
    4     reach clang and fail to LINK a `yoop_runtime` symbol - see 2.3
    253   stop earlier, at a named parse or typecheck refusal

Re-probed after 1.2 landed. The corpus is now 408 files - value `enum` added
five files to `bootstrap/src/` (one parse, four typecheck):

    89    compile all the way to an executable
    33    reach clang and fail ONLY for having no `main`, so 122 are done
    29    reach clang and produce INVALID IR, still all 2.1's `malloc`
    5     reach clang and fail to LINK a `yoop_runtime` symbol - see 2.3
    252   stop earlier, at a named parse or typecheck refusal

Re-probed after 1.5 landed. The corpus is now 411 files - floats added three to
`bootstrap/src/` (`lex/float_literal.yoop`, `typecheck/floats.yoop`,
`utils/float_bits.yoop`):

    95    compile all the way to an executable
    23    reach clang and fail ONLY for having no `main`, so 118 are done
    29    reach clang and produce INVALID IR, still all 2.1's `malloc`
    17    reach clang and fail to LINK a `yoop_runtime` symbol - see 2.3
    247   stop earlier, at a named parse or typecheck refusal

Re-probed after 1.6 landed. The corpus is now 415 files - bounds added four to
`bootstrap/src/` (`typecheck/bounds.yoop`, `typecheck/bounds_use.yoop`,
`typecheck/trait_apply.yoop`, `typecheck/monomorph.yoop`):

    100   compile all the way to an executable
    34    reach clang and fail ONLY for having no `main`, so 134 are done
    31    reach clang and produce INVALID IR, still all 2.1's `malloc`
    7     reach clang and fail to LINK a `yoop_runtime` symbol - see 2.3
    243   stop earlier, at a named parse or typecheck refusal

Re-probed after the phase-1 TAIL (1.4, 1.7's `library` half, and all three of
1.8's non-async items) landed. The corpus is now 420 files - five more in
`bootstrap/src/` (`codegen/borrow.yoop`, `codegen/const_data.yoop`,
`codegen/link_flags.yoop`, `codegen/region.yoop`, `typecheck/const_init.yoop`):

    111   compile all the way to an executable
    44    reach clang and produce INVALID IR, still all 2.1's `malloc`
    41    reach clang and fail to LINK a `yoop_runtime` symbol - see 2.3
    1     reach clang and produce invalid IR for another reason - `enum_eq.yoop`,
          `icmp requires integer operands`, which is 2.2 and predates this pass
    223   stop earlier, at a named parse or typecheck refusal

Nothing regressed across the whole pass: every file that moved, moved forward,
and 25 moved. The malloc bucket grew from 30 to 44, which is the good kind of
growth - those are files that were being refused earlier and now get far enough
for 2.1 to be their problem.

Re-probed after PHASE 2 (task A below, plus 2.1 and 2.3). The corpus is now 421
files - `codegen/extern_table.yoop` is the one addition:

    143   compile all the way to an executable
    53    reach clang and fail ONLY for having no `main` (a library compiled
          standalone), so 196 files really are done
    1     reaches clang and produces invalid IR - `enum_eq.yoop`,
          `icmp requires integer operands`, which is 2.2 and is now the ENTIRE
          bad-IR bucket
    0     fail to LINK a runtime symbol
    224   stop earlier, at a named parse or typecheck refusal

Two buckets emptied rather than shrank. 2.1 took the malloc pile from 44 to 0
and 2.3 took the runtime-link pile from 18 to 0; 30 of those files went all the
way to an executable and the rest are libraries that only want a `main`. The
refusal count moved by one, which is the new file itself - it imports `lex` like
everything else does.

Note the earlier tables merged "no `main`" into the runtime-link row. Split
apart, the pre-phase-2 numbers are 111 OK / 23 no-main / 18 runtime-link /
44 malloc / 1 icmp / 223 refused, and the two rows above line up against that.

Re-probed after 2.2 and the `~` half of 1.7. The corpus is now 422 files -
`typecheck/type_eq.yoop` is the one addition:

    146   compile all the way to an executable
    54    reach clang and fail ONLY for having no `main`, so 200 files are done
    1     reaches clang and produces invalid IR - still `enum_eq.yoop`
    0     fail to LINK a runtime symbol
    221   stop earlier, at a named parse or typecheck refusal

Re-probed after 2.4 through 2.8. Same 422 files - none of the five added a
source file:

    149   compile all the way to an executable
    66    reach clang and fail ONLY for having no `main`, so 215 files are done
    1     reaches clang and produces invalid IR - still `enum_eq.yoop`
    0     fail to LINK a runtime symbol
    206   stop earlier, at a named parse or typecheck refusal

**Re-probed after the whole of PHASE 5 - the long tail, twelve items in one
pass. The corpus is now 453 files, five additions, all of them these items'
(`parse/range.yoop`, `parse/unsafe_ptr.yoop`, `typecheck/unsafe_ptr_ops.yoop`,
`codegen/unsafe_ptr_ops.yoop`, `codegen/instr_ptr.yoop`):**

    222   compile all the way to an executable
    205   reach clang and fail ONLY for having no `main`, so 427 files are done
    0     reaches clang and produces invalid IR - the bad-ir bucket is EMPTY
    0     fail to LINK a runtime symbol
    26    stop earlier, at a named parse or typecheck refusal

22 distinct refusal sites, down from 42, and 27 more files are done. Seventeen
of the 22 are DELIBERATE - `@precompile`, comptime consts, `pooled` fields - so
what is actually open is `union` (2 sites, 4 files), a module-level `let` with a
non-literal initializer (2 sites, 2 files) and reserved words as names (1 site,
1 file). Full write-up in phase 5 below.

**The same probe run with STAGE 3 produces a byte-identical report.** stage2 and
stage3 are byte-identical as binaries and as emitted `.ll`, and the whole slice
suite runs through stage3.

Re-probed after 4.3, which is the one entry in this section where the numbers
holding still IS the result. The corpus is now 456 files - three additions, all
of them 4.3's own (`parse/kind_prefix.yoop`, `link/search_paths.yoop`,
`codegen/printf_format.yoop`):

    222   compile all the way to an executable      (unchanged)
    208   reach clang and fail ONLY for having no `main`, so 430 are done
    0     reaches clang and produces invalid IR
    26    stop earlier, at a named refusal          (unchanged)
    22    distinct refusal sites                    (unchanged)

Same 222, same 26, same 22 sites; the whole of the movement is the three new
files landing in `no-main`, which is what a library with no `main` should
report. 4.3 was measured by a SECOND probe over a different set - the example
PROGRAMS, run rather than compiled - and a change to these numbers would have
meant the new probe had broken the old one. See item 4.3 for what that second
probe found: 218 of 279 example programs build under both compilers, run, and
agree exactly.

**The previous probe, kept for the chain. Re-probed after 3.1 and 3.4 - the
derive expansion and the vtable erasure.
The corpus is now 448 files, eight additions, all of them these two items'
(`parse/derive.yoop`, `parse/derive_text.yoop`, `parse/derive_body.yoop`,
`typecheck/vtable.yoop`, `typecheck/vtable_use.yoop`, `codegen/vtable.yoop`,
`codegen/vtable_call.yoop`, `codegen/instr_vtable.yoop`):**

    202   compile all the way to an executable
    198   reach clang and fail ONLY for having no `main`, so 400 files are done
    1     reaches clang and produces invalid IR - still `enum_eq.yoop`
    0     fail to LINK a runtime symbol
    47    stop earlier, at a named parse or typecheck refusal

42 distinct refusal sites, down from 61, and 36 more files are done. **The
largest single move the plan has recorded**, and unlike most of them the two
counts moved TOGETHER again: the whole `std/http` and `std/https` stack sat
behind one feature, and finishing it finished all of it at once.

The vtable erasure is gone from the list ENTIRELY - 14 sites and 23 files - and
so is `@derive(display)`, at 5 and 5. What is left at the top is `@precompile`,
which is out of this plan's scope by design.

Measured before and after:

    sites  files   before                          after
       14     23   `X.from(ref v)` (3.4)           0 sites, 0 files
        5      5   `@derive(display)` (3.1)        0 sites, 0 files
        2      2   `ref xs[i].y` (a named refusal) 0 sites, 0 files

That third row was not a plan item. It became the critical path the moment the
erasure landed - `std/http/router.yoop:121` is
`await Dispatcher.handle(ref entries[i].dispatcher, ...)` - and it turned out to
be fifteen lines: an element HAS an address, so the field walk needed one
different first step and nothing else. Fixed rather than deferred because it
blocked the item in front of it, which is the rule.

The remaining refusal distribution, as DISTINCT SITES - 42 of them:

    12     `@precompile` (out of scope, refused by name). 13 files
    4      `union` decls (refused by name, sized, deferred)
    4      `export "C" function` (refused by name)
    3      module const/let needing comptime
    2      a compound assignment on an INDEX (refused by name)
    2      `case true:` - a switch over a BOOL (see the follow-ups)
    2      `..` in a pattern
    2      module-level `let` with a non-integer initializer
    11     a long tail of one-file parse and typecheck refusals

**The same probe run with STAGE 3 produces a byte-identical report.** stage2 and
stage3 are byte-identical as binaries.

**The previous probe, kept for the chain. Re-probed after 2.13, 3.6 and 3.7. The
corpus was 440 files - five additions (`source_graph/autoload.yoop`,
`typecheck/diverge.yoop`, `typecheck/try_forms.yoop`, `codegen/task_intr.yoop`,
`codegen/try_forms.yoop`):**

    182   compile all the way to an executable
    182   reach clang and fail ONLY for having no `main`, so 364 files are done
    1     reaches clang and produces invalid IR - still `enum_eq.yoop`
    0     fail to LINK a runtime symbol
    75    stop earlier, at a named parse or typecheck refusal

61 distinct refusal sites, down from 68, and 32 more files are done - the second
largest single move the plan has recorded, behind only 3.2. Unlike most of the
passes before it, the two counts moved TOGETHER: three separate one-line gates
came off at once and what was behind each of them was already built.

The three, measured before and after:

    sites  files   before                        after
        1     21   `unknown intrinsic "X"`       0 sites, 0 files
        4     13   `expr? "context"`             0 sites, 0 files
        1      1   `expr? e { ... }`             0 sites, 0 files
        5      5   `unknown kind "task"/"async"` 0 sites, 0 files

Every one of the 21 files behind `std/core/concurrency.yoop:32` produces IR now,
and five of them run: `wait_until_smoke`, `cancel_smoke`, `task_await_join`,
`io_timeout_smoke` and `io_cancel_smoke` each print exactly what their own
"expected output" comment has always claimed.

Where the rest went, and this is the usual shape: 10 of the 13 `? "context"`
files landed on `std/http/client.yoop:229`, which is 3.4's vtable erasure, and
that item's file count went 13 -> 23. The whole http stack is now one item deep.

The remaining refusal distribution, as DISTINCT SITES - 61 of them:

    14     `X.from(ref v)` - building a vtable VALUE (3.4). 23 files
    12     `@precompile` (out of scope, refused by name). 12 files
    5      `@derive(display)` expansion (3.1). 5 files
    2      `union` decls (refused by name, sized, deferred)
    2      `export "C" function` (refused by name)
    2      a compound assignment on an INDEX (refused by name)
    2      `case true:` - a switch over a BOOL (see the follow-ups)
    2      `..` in a pattern
    3      module const/let needing comptime
    17     a long tail of one-file parse and typecheck refusals

**The same probe run with STAGE 3 produces a byte-identical report**: same 182,
same 182, same 61 sites, same messages in the same order. The whole slice suite
runs through stage3 too, and stage2 and stage3 are byte-identical as binaries
and as emitted `.ll`.

**Re-probed after 3.5, the TASK HALF. The corpus is now 435 files - six
additions, all of them this item's (`typecheck/task.yoop`, `codegen/task.yoop`,
`codegen/task_spawn.yoop`, `codegen/task_thunk.yoop`, `codegen/task_wait.yoop`,
`codegen/instr_task.yoop`):**

    163   compile all the way to an executable
    169   reach clang and fail ONLY for having no `main`, so 332 files are done
    1     reaches clang and produces invalid IR - still `enum_eq.yoop`
    0     fail to LINK a runtime symbol
    102   stop earlier, at a named parse or typecheck refusal

68 distinct refusal sites, down from 81 - the largest single drop the plan has
recorded, and all of it is one refusal disappearing: the 19 `wait` sites are
gone and none of the 435 files stops at a `wait` any more.

TWO corpus files moved all the way to an executable, and both of them RUN a
task: `ref_forwarding.yoop` prints the `viaTask=14` its own comment has always
claimed, and `runtime_introspect.yoop` gets `counter=5000` out of a task
bumping a borrowed counter on a worker thread. The other six new "done" files
are this item's own source.

The remaining refusal distribution. Two columns, because after this item they
disagree sharply and each answers a different question - DISTINCT SITES is how
many separate unanswered questions are left, FILES is how much of the corpus
each one holds up:

    sites  files
       13     13  building a vtable VALUE (3.4)
       11     11  `@precompile` (out of scope, refused by name)
        7      7  `@derive(display)` expansion (3.1)
        5      5  `unknown kind` - std AUTOLOADS, not a feature gap
        4     13  `expr? "context"` (refused by name, 1.3)
        4      6  module const/let needing comptime
        2      4  `union` decls (refused by name, sized, deferred)
        2      4  `export "C" function` (refused by name)
        1     21  the `waitUntil` / `cancel` / `armComplete` / `isDone`
                  intrinsics - ONE line in std/core/concurrency.yoop, and the
                  critical path by a wide margin
       18     18  a long tail of one-file parse and typecheck refusals

That last row is why the site count fell so far: 3.3's 19 `wait` sites were 19
DIFFERENT lines pointing at one unbuilt mechanism, and what replaced them is a
single line pointing at four named intrinsics.

**Re-probed after 3.3, the ASYNC HALF. The corpus was 429 files - four
additions, all of them this item's (`typecheck/async.yoop`, `codegen/coro.yoop`,
`codegen/instr_coro.yoop`, `codegen/await_op.yoop`):**

    161   compile all the way to an executable
    163   reach clang and fail ONLY for having no `main`, so 324 files are done
    1     reaches clang and produces invalid IR - still `enum_eq.yoop`
    0     fail to LINK a runtime symbol
    104   stop earlier, at a named parse or typecheck refusal

81 distinct refusal sites, down from 83.

**Zero corpus files moved, and that is the honest headline.** The four new
"done" files are this item's own source. Every one of the 13 `await` refusal
sites is gone - none of the 429 stops at an `await` now - and every file that
was stopping on one landed on `wait`, on the vtable gap, or on
`expr? "context"` instead. The distribution says it exactly:

    before          after
    13 `await`       0
    11 `wait`       19   (all of them the new NAMED refusal)
    10 vtable       13   (files now get past their awaits and hit 3.4)
     3 `expr? "..."` 4

That is the shape this plan has recorded six times and stated as a rule:
**the bootstrap's corpus is one deep import closure, so unblocking a layer moves
the pile to whatever the next layer had never been asked about, and files leave
the pile only when a LEAF finally compiles.** The reason it bit harder here than
usual is specific and worth knowing: `std/core/concurrency.yoop` is imported by
the whole net / tls / http stack, and its `awaitTask` ends in `return wait h;` -
so one line in one file gates every async consumer in the tree on the task half.
That line is the new critical path, at 11 files.

The distinct-site count is the honest measure of this item, and by it the async
half did what it set out to: 13 sites removed, and the 19 that replaced them are
a single named refusal pointing at one written-up plan item (3.5) rather than at
13 different unanswered questions.

**Re-probed after 3.2, 2.12 and the SELF-COMPILE. The corpus is now 425 files -
three additions (`typecheck/iterable.yoop`, `typecheck/propagate.yoop`,
`codegen/loop_iter.yoop`):**

    161   compile all the way to an executable
    159   reach clang and fail ONLY for having no `main`, so 320 files are done
    1     reaches clang and produces invalid IR - still `enum_eq.yoop`
    0     fail to LINK a runtime symbol
    104   stop earlier, at a named parse or typecheck refusal

82 distinct refusal sites, down from 88. 78 more files are done, which is the
largest single move the plan has recorded and is one item's doing: `Iterable` in
a `for ... in` gated the compiler's own import closure, so finishing it finished
the whole of `source_graph`, `typecheck` and `codegen` at once.

**The same probe run with STAGE 3 - the compiler the bootstrap built, twice
removed from the JS reference - produces a byte-identical report.** Same 161,
same 159, same 82 sites, same messages in the same order. That is the strongest
statement available about the two compilers being one compiler.

The remaining refusal distribution, as DISTINCT SITES - 82 of them, and the top
is now entirely phase 3:

    13   `await` (3.3)
    11   `wait` (1.8)
    11   `X.from(ref v)` / `X.fromFn(...)` - building a vtable value (3.4)
    10   `@precompile` (out of scope, refused by name)
    7    `@derive(display)` expansion (3.1)
    4    module const/let needing comptime
    3    `union` decls (refused by name, sized, deferred)
    3    `export "C" function` (refused by name)
    1    `expr? "context"` (refused by name, 1.3)

`Iterable` in a `for ... in` is gone from that list entirely, and so is the
propagated-disposal shape - which never appeared in it, because it is a
typecheck refusal on a BINDING rather than on a declaration.

Re-probed after 2.9 through 2.11 and the rest of 1.7. Same 422 files - none of
the four added a source file:

    155   compile all the way to an executable
    87    reach clang and fail ONLY for having no `main`, so 242 files are done
    1     reaches clang and produces invalid IR - still `enum_eq.yoop`
    0     fail to LINK a runtime symbol
    179   stop earlier, at a named parse or typecheck refusal

88 distinct refusal sites, down from 95. 27 more files are done and the refusal
pile shrank by 27, which is the first pass where the two moved together rather
than the second feeding the first - the critical path finally reached a layer
where FINISHING it finishes files.

**The critical path moved twice in this pass, and it is now somewhere the plan
already knows about.** 90 files stopped at `parse/header.yoop:69` (2.9) before;
2.9 moved them to `parse/state.yoop:108`, which is `?` propagating a LexedError
into a ParsingError - the `Into` half of 1.3, written up as 2.10 below. Building
that moved them again, to `source_graph/load.yoop:211`:

    70   `for f in fs.readDir(...)` over a `DirIter`

which is `Iterable<T>` in a `for ... in` and is item 3.2. So for the first time
the critical path is a PHASE 3 item rather than a gap nobody had looked at.

**The bootstrap's own self-compile is 10 diagnostics across 2 shapes**, down
from 20 across 7. `/tmp/yoopiler_boot bootstrap/src/main.yoop` reports, in full:

    4   `Iterable` in a `for ... in` (3.2) - DirIter and MapIter
    6   a `propagates<disposable>` type with no `dispose` METHOD of its own
        (Program, Emitter, FnLocals, LoopStack, DisposeStack, LocalScope)

That is the whole list. Both are written up in the follow-ups, and the second is
now SIZED rather than unexamined - see there. **Both landed on 2026-08-13 as
items 3.2 and 2.12, and the self-compile is now zero diagnostics** - see 4.2.

The refusal distribution, as DISTINCT SITES - 88 of them:

    13   `await` (3.3)
    11   `wait` (1.8)
    11   `X.from(ref v)` / `X.fromFn(...)` - building a vtable value (3.4)
    10   `@precompile` (out of scope, refused by name)
    7    `@derive(display)` expansion (3.1)
    5    `Iterable` in a `for ... in` (3.2). FIVE sites, and 74 of the 422 files
         stop on them - the whole compiler's import closure, again
    4    `expr? e { ... }` / `expr? "context"` (refused by name, 1.3)
    4    module const/let needing comptime
    2    `union` decls (refused by name, sized, deferred)
    2    `export "C" function` (refused by name, NEW - see 1.7)
    2    a compound assignment on an INDEX (refused by name)
    2    `unsafe_ptr` reached without `import.unsafe;`

`discard`, `trait X extends Y` and side-effect imports are gone from that list
entirely, and so is the `?` Into mismatch.

The PREVIOUS pass's write-up, kept because its chain is the clearest record of
how a one-line gate moves: 95 distinct refusal sites, down from 98. The totals
moved by 15 done files and
the site count by three, which is the ordinary shape; what actually happened is
that **the critical path moved FOUR times in one pass and the whole `lex` and
`ast` modules now compile.** The chain, each one measured rather than guessed:

    lex/literals.yoop:41      101 files   `break` in a switch arm        (2.4)
    lex/scan_tables.yoop:95   101 files   struct literal at a generic call (2.5)
    ast/arena.yoop:32          94 files   `type NodeId = usize;`         (2.6)
    parse/attributes.yoop:69   85 files   `ref ps.ast.childIds`          (2.7)
    parse/header.yoop:69       90 files   forwarding a `ref` parameter   (2.9, open)

The count going 101, 101, 94, 85, 90 is not noise: each fix moves the pile to
whatever the next layer had never been asked about, and files leave the pile
only when a LEAF finally compiles. 15 did.

**The bootstrap's own self-compile is now 20 diagnostics across 7 shapes**, which
is close enough to enumerate rather than estimate. `/tmp/yoopiler_boot
bootstrap/src/main.yoop` reports, in full:

    4   `Iterable` in a `for ... in` (3.2) - DirIter and MapIter
    6   a `propagates<disposable>` type with no `dispose` METHOD of its own
        (Program, Emitter, FnLocals, LoopStack, DisposeStack, LocalScope)
    4   forwarding a `ref` PARAMETER into a `ref` slot without re-writing `ref`
        (2.9 below) - one call argument, three struct-literal fields
    2   `?` propagating a LexedError into a ParsingError - the `Into` half (1.3)
    4   `switch` over an imported `Result` in typecheck/generics.yoop:809 -
        `"Result" is not a variant`, which is a NEW shape nothing has looked at

That is the whole list. It is the first time it has been short enough to print.

**And the critical path moved rather than ended, for the fifth time.** 100 files
stopped at `bootstrap/src/lex/chars.yoop:212` before and none do now; 101 stop at
`bootstrap/src/lex/literals.yoop:41` instead, which is a `break` inside a SWITCH
arm and is written up as 2.4 below. The extra one is `type_eq.yoop` itself,
which imports `lex` like every other file in the tree. Three files went all the
way and one more reached clang - the shape every one-line gate has had, and the
reason the distinct-site count is the honest measure: the totals only move when
a LEAF finally compiles.

The refusal distribution after that, as DISTINCT SITES - 98 of them, down from
101:

    13   `await` (3.3)
    11   `wait` (1.8)
    10   `X.from(ref v)` / `X.fromFn(...)` - building a vtable value (3.4)
    10   `@precompile` (out of scope, refused by name)
    5    `@derive(display)` expansion (3.1)
    4    `Iterable` in a `for ... in` (3.2)
    3    `expr? "context"` (refused by name, 1.3)
    2    `discard` (1.7)
    2    `trait X extends Y` (1.7)
    2    `..` in a pattern (1.7)
    2    `unsafe_ptr` reached without `import.unsafe;`
    2    a compound assignment on an INDEX (refused by name)
    1    `break` inside a switch arm (2.4). ONE site, and 101 of the 422 files
         stop on it - the whole compiler's import closure, again.

`~` is gone from that list entirely, and so is the Func-comparison site. The
`union` sites are 3 across two shapes (`export union` and a bare one).

The refusal distribution BEFORE those two, as DISTINCT SITES - 101 of them, and
the top of the list barely moved because phase 2 was about the files that already
got past the parser:

    13   `await` (3.3)
    11   `wait` (1.8)
    10   `Reader.from(ref s)` - building a vtable value, the erasure machinery
    10   `@precompile` (out of scope, refused by name)
    5    `@derive(display)` expansion (3.1)
    4    `~` bitwise not (1.7)
    4    `Iterable` in a `for ... in` (3.2)
    3    `expr? "context"` (refused by name, 1.3)
    2    a Func inside a `ref` and an array compares unequal to itself (2.2;
         NEW critical path, 100 files stop at bootstrap/src/lex/chars.yoop:212)
    2    module const folded through a CALL (needs comptime)
    2    `union` decls (1.7)
    2    `trait X extends Y` (1.7)
    2    `discard` (1.7)
    2    `..` in a pattern (1.7)
    2    `unsafe_ptr` reached without `import.unsafe;`

The two remaining module-const sites are both in
`examples/pass/dir_module/shapes/area.yoop`, and nothing in `bootstrap/src/` has
one any more.

**And the critical path is finally somewhere else.** The 96-file pile that had
moved four times - float literal, then bound, then `.len` on a `ref uint8[]`,
then the array const in `lex/chars.yoop` - now stops at
`bootstrap/src/lex/scan_tables.yoop:33`, which is
`export const TOKEN_SCAN_LIST: SortedTokenDefinition[] = sortedDefs([...])`. That
is a const initialized by a CALL, which the reference FOLDS at compile time and
which needs a comptime interpreter. The interpreter is explicitly out of this
plan's scope (see the scope note at the top), so this is the first time the
critical path has landed on something that is not a phase-1 item - and it means
`bootstrap/src/` cannot self-compile until comptime comes back, or until that one
declaration stops needing to be folded. Task A below is that second option, and
it moved the pile again rather than removing it: 100 of the 421 now stop at
`bootstrap/src/lex/chars.yoop:212`, `argument 3 of "scanCharPredicates" is
ref () => Result_bool_string[], not ref () => Result_bool_string[]` - a message
that says X is not X, which is a real bug in the bootstrap's own typechecker and
is written up under 2.2.

The refusal names the reason rather than the spelling: "is initialized by a CALL
- the reference folds one at compile time and the bootstrap has no comptime
interpreter, so there is nothing to inline". A "needs a literal" message would
have sent a reader after punctuation on a program that is perfectly well formed.

Earlier: every file that moved, moved forward. `utils/sort.yoop`,
`utils/iter.yoop` and `utils/float_bits.yoop` went from a parse refusal all the
way to clang, where they stop at 2.1.

Note the earlier rows in this section undercounted the "reached clang" buckets.
The probe classifier keyed on the presence of an `[error]` line, and a clang
failure appends one of its OWN at the end of the log - so everything that got
past typecheck and then failed to link was being read as an early refusal. The
89 / 33 / 29 / 5 / 252 row for 1.2 is really 89 / 23 / 29 / 15 / 252 when the
same 408 files are re-classified on "did `llvm IR: ok` appear". Only the OK
column and the refusal-site counts were ever right, and those are what the plan
has been steering by, so no conclusion moves.

That is the shape phase 2 was expected to take: unblocking a parse gap does not
finish files, it moves them to whatever the next layer had never been asked
about. 44 of the 169 files 1.1 unblocked went all the way; the rest advanced to
`?` propagation, value enums, `await`, floats and the rest of phase 1. 1.3 did
the same again, and more sharply - only 5 of its 41 finished, and 26 landed
directly on value `enum`. 1.2 is the sharpest yet: of the 90 files it unblocked
only 4 finished, and 87 of them landed on ONE line - `bootstrap/src/lex/lexer.yoop:67`,
which reads a float literal.

Which is the thing to read off this table rather than the totals: **the critical
path is one file deep, and 1.5 moved it rather than removing it.** Before
floats, 97 of the 408 probes stopped at a float literal and 88 of those at ONE
line - `bootstrap/src/lex/lexer.yoop:67`. Afterwards, zero stop at a float, and
the same 88 stop at `bootstrap/src/utils/sort.yoop:20`, which is
`<T implements Comparable<T>>` and is item 1.6. `lex/scan_tables.yoop` imports
`quickSort` from `utils`, `utils` is a directory module so all of its files load
together, and everything above lex inherits the whole closure. The float error
was simply the one the walk reached first.

1.6 moved it a THIRD time, to the same depth. `utils` now compiles, and the same
pile - 96 of the 415 - stops at `bootstrap/src/diagnostics/parse_error.yoop:35`,
`.len` on a value read out of a `ref uint8[]` field. Three items in a row have
found the same thing, so it is worth stating as a rule rather than a
coincidence: **the bootstrap's own source is one deep import closure, so the
whole-corpus number moves in a block and always reports the FIRST error the walk
reaches.** The distinct-site count is the honest measure; the totals only move
when a leaf finally compiles.

The top of the refusal distribution after 1.6, counted as DISTINCT SITES:

    13   expected COLON, got IDENT
    10   `await` (3.3)
    9    `wait` (1.8)
    9    `@precompile` (out of scope, refused by name)
    6    module const with a non-literal initializer (1.4)
    6    expected SEMICOLON, got LCURLY
    5    `@derive(display)` expansion (3.1)
    4    `~` bitwise not (1.7)
    4    `Iterable` in a `for ... in` (3.2)
    4    `extern ... from library "m"` (1.7)
    1    field access through a `ref` to an array (NEW critical path: 96 files
         stop at bootstrap/src/diagnostics/parse_error.yoop:35, `srcRef.len`
         where `srcRef` came out of a `ref uint8[]` field)

Value `enum`, floats and bounds are all gone from that list entirely. 1.4 shrank on its
own: the "unknown name" cloud the earlier tables led with was mostly module
consts read at their USE sites, and the mutable-globals work that landed
alongside 1.2 took most of it, leaving 6 real sites and 2 unknown names.

And after the phase-1 tail, again as DISTINCT SITES:

    13   `await` (3.3)
    10   `wait` (1.8)
    10   `@precompile` (out of scope, refused by name)
    10   `Reader.from(ref s)` - building a vtable value, the erasure machinery
    4    `~` bitwise not (1.7)
    4    `union` decls (1.7)
    3    `expr? "context"` (refused by name, 1.3)
    2    module const folded through a CALL (needs comptime; NEW critical path,
         98 files stop at bootstrap/src/lex/scan_tables.yoop:33)
    2    `trait X extends Y` (1.7)
    2    `discard` (1.7)
    2    `unsafe_ptr` reached without `import.unsafe;`
    2    `..` in a pattern (1.7)

`expected COLON, got IDENT`, `expected SEMICOLON, got LCURLY` and
`expected STRLITERAL, got IDENT` are gone entirely, and the module-const bucket
is down from 6 sites to 3 - one struct-literal initializer and two calls.

Subsystem sizes, as a rough completeness gauge (non-comment lines):

    lexer       1097 JS ->  1278 boot    done, and at parity
    parser      5542 JS ->  3936 boot      plus derive*.yoop, below
    typecheck  13226 JS ->  7690 boot
    codegen     6801 JS ->  4227 boot
    driver       825 JS ->   148 boot (link/) plus main.yoop
    derive       571 JS ->   380 boot (parse/derive*.yoop; expanded)
    interp      3147 JS ->     - out of scope, see above

The blocker counts below are DISTINCT SITES, deduped by file and line. That
matters: a probe result counts a whole import closure, so one broken leaf file
looks like hundreds of failures. Attribute a blocker to the file it is IN.

---
