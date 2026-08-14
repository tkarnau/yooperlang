# Finishing the bootstrap

The ordered plan for getting the self-hosted compiler from "compiles a large
subset" to "compiles the language", including async and coroutines.

**Scope note.** The JS reference's INTERPRETER (`src/jsyoopinterp/`, ~3150 lines)
and `@precompile` are deliberately out of this plan. Comptime comes back later,
and it comes back differently: a self-hosted interpreter can introspect the
source while compiling and can back a REPL, which a JS process running the
compiler alongside it cannot do well. Building the JS version's comptime here
first would be building the thing we intend to replace.

Style, as everywhere in plans/: ASCII only, no em-dashes, no fancy tables.

---

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

## Phase 1 - the cheap parser gaps

Small, independent, and between them they unblock most of the tree. Each is a
parse-level gap with a named refusal today, so each is "make it parse, then make
it mean something".

**1.0 A borrow held as a VALUE - DONE 2026-08-13, 97 files, 1 site.** Not in the
original plan; it was the critical path 1.6 left behind, at
`bootstrap/src/diagnostics/parse_error.yoop:35` - `.len` on a local bound from a
`ref uint8[]` FIELD, refused with "field access on ref uint8[] is not supported
by the bootstrap typechecker yet".

The brief guessed it was a missing deref rather than a feature, and that was
half right. The rule is the one bootstrap/README.md already states for a
PARAMETER - "a `ref T` is `ref T` in the signature and `T` in the body" - moved
one layer out, and the reason it needed saying twice is that a parameter is
unwrapped ONCE at its declaration while a FIELD keeps its `ref T` type for as
long as anything holds it. `Cx` in `codegen/context.yoop` is seven `ref` fields
and nothing else, so this is not an edge case in the bootstrap's own source; it
is most of how codegen is written.

What the reference actually does, established by compiling probe programs rather
than by reading its source:

  - a `ref T` LOCAL bound from a `ref T` field reaches `.len`, indexing and
    fields exactly as a plain `T` does, and passing it to a BY-VALUE parameter
    inserts a real load (`%t14 = load %yoop_array.uint8, ptr %t13`).
  - it is a real reference, not a copy: `let pr = hp.p; pr.x = 42;` where
    `p: ref Point` changes the ORIGINAL. So stripping the `ref` at the binding
    would have been a silent miscompile, which is what makes the deref belong
    at the USE.
  - `ref x` WRITTEN OUT never opens itself. `takes(ref n)` against
    `takes(n: int32)` is "cannot pass ref int32 to int32" there, even though a
    borrow that ARRIVED as a value in the same slot is accepted. That
    asymmetry is the reason the conversion is keyed on the expression's KIND as
    well as its type: the whole point of writing `ref` is that the call site
    shows what may be written through.
  - a plain `T` in a `ref T` field slot is refused ("cannot assign struct P to
    field p of type ref struct P").

Two DIVERGENCES, both where the reference is wrong rather than stricter:

  - `h.src.len` DIRECTLY - a field access whose base is a `ref T` field read
    rather than a local bound from one - makes the reference emit invalid IR
    ("invalid getelementptr indices"), and `byVal(h.src)` is a typecheck error
    there while `byVal(srcRef)` is fine. The bootstrap accepts both, because
    the rule is about the TYPE and not about how the value was spelled. That is
    a superset, so a program written for the reference still compiles; a
    fixture asserted against both has to stay inside the intersection, which is
    why `ref_fields.yoop` binds a local first.

Where the machinery went, and it is two mechanisms on purpose because there are
two questions:

  - a field or index BASE derefs STRUCTURALLY, in codegen, because a READ wants
    the value and a WRITE wants the address and only codegen knows which. A
    borrowed base is CHEAPER than a slot base for a write - the operand already
    IS the address, so there is no gep on a slot at all.
  - everything else derefs because the CONTEXT wanted a `T`, which only pass D
    can answer. `openBorrowIfWanted` runs at the one place `checkExpr` records
    a node's type, so it covers arguments, initializers, assignments, returned
    values, array elements and struct-literal fields together, and it records
    the node in `tm.derefUses` so codegen emits exactly one load in exactly one
    place (the `emitExpr` wrapper).

**1.1 `...` variadic in an extern signature - DONE 2026-08-13, 169 files.**
`function printf(fmt: string, ...): int32;`. The single highest-leverage item in
the whole plan: nearly every example declares its own `printf` extern, so this
one token blocked 169 of 401 files (the plan said 168; the extra one appeared
between measurements). 44 of them now compile to an executable and the other 125
advanced to a later blocker. `Type.Func` already had the `variadic` field and
codegen already promoted varargs at a printf CALL.

What the reference actually does, established by compiling probe programs rather
than by reading its source:

  - `...` parses ONLY inside an `extern` block. An ordinary function, a trait
    method and a function TYPE annotation all report "expected ident, got
    dotdotdot".
  - It must be immediately before the `)`. A following parameter, a trailing
    comma and a second `...` are all "expected rparen, got comma".
  - It may be the ONLY parameter. `function weird(...): int32;` typechecks and
    emits `declare i32 @weird(...)`.
  - Zero variadic arguments at a call is fine, and is the common case.
  - The FIXED parameters are checked. `printf(7, 8)` against a declared
    `printf(fmt: string, ...)` is "cannot pass untyped int to string".
  - `printf` is a compiler BUILTIN with no checking at all when nothing declares
    it, and a declaration WINS: declaring a non-variadic `printf` there makes
    `printf("a %d\n", 3)` an arity error.

Three places the bootstrap deliberately does better, each because the reference
mis-compiles rather than refuses:

  - Too FEW arguments to a variadic callee is refused by name (`"myvar" takes at
    least 2 argument(s), got 1`). The reference passes it through typecheck and
    emits a call clang rejects as "not enough parameters specified for call".
  - Two modules each declaring `extern printf` collapse to one `declare`. The
    reference emits both, and clang rejects the second as an invalid
    redefinition. This is 2.1's collision from the other direction, and the same
    dedupe is what 2.1 needs.
  - Promotion applies to EVERY variadic callee, not just printf. The reference
    promotes only at a printf call, so an `int8` handed to a declared `snprintf`
    there is passed as `i8` and the callee reads the rest of the slot.

Not implemented, and refused by name: `...` on an `extern "intrinsic"`
signature, and `...` on a generic one. Both would record a calling convention
with no call site to apply it to, and a variadic intrinsic would compile and
then silently drop everything past the fixed parameters.

One trap found while writing the slice fixture, worth knowing before writing
another: a string LITERAL handed straight to `printf` as a vararg
(`printf("%s\n", "seven")`) makes the JS reference print it a SECOND time, out
of order. A string held in a binding is fine, which is why the existing fixtures
that use `%s` pass parity. The bug is in the reference's printf special case
(`emitPrintfCallInner`); the bootstrap has no such case and is correct. Keep
literals out of a fixture's varargs until it is fixed.

**1.2 Value `enum` - DONE 2026-08-13, 90 files.** `export enum Severity { ERROR,
WARNING }`, `enum ASTNodeKind implements Display { ... }`. It was the largest
single item left - 83 files stopped at the exported form and 7 more at the bare
one - and it gated `diagnostics`, `lex`, `ast` and `typecheck` in the
bootstrap's own source. None of the 408 files stops at an ENUM token now. Only 4
of the 90 went all the way, though: 87 landed on the float literal in
`bootstrap/src/lex/lexer.yoop`, which is 1.5 and is now the critical path.

The REPRESENTATION, and it is the whole design: **a value enum is a nominal
alias over a primitive.** `Type.ValueEnum` carries an `underlying` TypeId and a
case list of compile-time constants; at the LLVM layer the enum IS that
primitive - `i32` by default, `i8` for `enum<uint8>`, `ptr` for
`enum<string>` - and a case is an immediate or an interned string constant with
no storage anywhere. That is why there is no `codegen/enum.yoop`: unwrapping the
alias once in `llvmType`, `primBitWidth`, `primIsSigned` and `sizeOfType` covers
layout, casts, varargs, array elements, struct fields and `ref` parameters
together. What is NOT inherited is assignability and the operator set, and those
two refusals are the entire semantic content of the feature.

What the reference actually does, established by compiling probe programs rather
than by reading its source:

  - the default backing is `int32`. `<T>` after the name takes any signed or
    unsigned int width or `string`; `bool`, a float and a nominal type are all
    refused by name. `enum K<K2>` is a BACKING type, not a type parameter - an
    enum is never generic.
  - a case value is written by JUXTAPOSITION (`Sweet 1`), never with `=`. `=`
    is refused as an ordinary expression error.
  - values may be sparse, negative, and DUPLICATED. An implicit case is the
    previous case's value plus one, so `{ Zero 0, Eighteen 18, Auto }` gives
    Auto 19 - it counts off the VALUE, not the ordinal.
  - a value expression may name a PRIOR case by BARE name and combine those
    with `| & ^ << >>` only. Arithmetic is refused, a forward reference is
    refused, and a module `const` is not in scope there. A case that was DERIVED
    makes the enum "open", and a switch over an open enum requires a `default`
    even when every case is covered.
  - a case is reached as `Color.Red` and never as a bare `Red`. The reference
    also accepts `ns.Color.Red`; the bootstrap does not - see below.
  - a switch over an INT-backed enum is exhaustive-checked, and a `default`
    alongside every case is ALLOWED. That is the opposite of the variant rule
    ("exhaustive or defaulted, never both"), and it is right: an enum's values
    are integers, so one naming no case is representable and the default is
    never provably dead. A switch over a STRING-backed enum is refused by name.
  - there is no implicit conversion in either direction, and no `Color(i)` at
    all. `int32(c)` casts OUT; `string(dir)` on an `enum<string>` is refused
    with the ordinary numeric-casts message.
  - `==` and `!=` work on both backings. Ordering and the bitwise family work on
    an int-backed one only. Arithmetic works on neither.
  - an INT-backed enum is a valid array INDEX, which is what makes
    `AST_NODE_KIND_NAMES[kind]` read the way it wants to.
  - a case may not carry a payload - that is what a `variant` is - and the
    refusal comes from the value fold rather than the parser, because
    `Red { r: int32 }` is a struct literal to a parser.
  - an enum takes `implements` and METHODS exactly as a struct does, anywhere in
    the member run and with no comma before a method. A method body may `switch`
    on `self`. There are no inherent methods here either.
  - an interpolated enum renders through its `toString` when it has one, and as
    its underlying value otherwise - the string for `enum<string>`, the number
    for an int-backed one.

Three DIVERGENCES, all recorded in bootstrap/README.md:

  - matching two cases that share a VALUE in one switch is refused BY NAME. The
    reference emits a jump table naming the value twice and lets clang refuse
    it ("duplicate case value in switch"), which names neither case and no
    source line. Declaring two cases with one value stays legal on both sides.
  - `Display.toString(ref c)` on an enum receiver WORKS here and is refused by
    the reference ("requires a struct receiver"). It falls out of the method
    table rather than being added: blocking it would have taken extra code to
    make an enum less of a type than it is.
  - `ns.Color.Red` is not supported. It is the same gap `ns.CONSTANT` and
    `ns.Variant.Case` already have - a namespace reaches types and calls and
    nothing else - and no file in the 408 uses it, so it is recorded rather than
    built.

At SCALE it is linear, which was the thing to check: a synthetic enum with a
`toString` that switches over every case emits 243 / 643 / 1843 lines of IR for
50 / 150 / 450 cases (about 4 lines per case, one jump table) and compiles in
0.05 / 0.05 / 0.09 seconds end to end. The real `ASTNodeKind` is 150 cases and
sits in the middle of that.

**1.3 `?` propagation - DONE 2026-08-13, 41 files.** `SelfLexing.advance(ref
ps)?` - yield the `Ok` payload, or return the `Err` from the enclosing function.
41 files stopped at `expected SEMICOLON, got QUESTION` before; none do now. 5 of
them went all the way to an executable and the other 36 advanced to a later
blocker, 26 of those to value `enum` (1.2), which is now by far the largest
single item left.

What the reference actually does, established by compiling probe programs
rather than by reading its source:

  - A FALLIBLE type is a `variant` with EXACTLY two cases, named `Ok` and
    `Err`, each carrying zero or one field. Every clause bites: a third case, or
    a two-field payload on either case, makes it non-fallible.
  - So `Option<T>` is NOT fallible - `?` on one is refused. This is the single
    most surprising finding, because "the Rust-shaped feature works on the
    Rust-shaped optional" is the natural assumption.
  - The payload FIELD names do not matter. `Err { error: E }` and `Err { e: E }`
    are both fallible; one field is one field.
  - The operand's variant type need NOT equal the enclosing function's. Only the
    two `Err` PAYLOAD types have to agree - `?` rebuilds the enclosing Err
    around the operand's error rather than forwarding the operand's value.
  - When the payloads differ, the reference converts through an
    `Into<TargetErr>` impl on the operand's error type, and the conversion runs
    in the failure branch (the `into` really is called - a tag field proves it).
  - `?` is usable as an ordinary expression EVERYWHERE: nested in a call
    argument, as a binary operand, chained as `f()?.field`, doubled as `f()??`,
    at statement position with the value discarded, and inside a method body.
    `ref f()?` is the one refusal - a `?` result is not an lvalue.
  - Disposals fire on the early-return path, in reverse declaration order,
    exactly as on a `return` - which they are.
  - There is no ternary in the language, so a postfix `?` is never ambiguous.

Two DIVERGENCES, both refusals rather than silent differences:

  - The `Into` conversion is not built. **Built later the same day - see 2.11,
    and note this entry's reasoning was WRONG:** it does not need generic trait
    instantiation at all, only the applied-trait machinery 1.6 shipped, and the
    conversion is an ordinary static dispatch on a concrete receiver.
  - Neither is the handler form `expr? e { ... }`, nor the context form
    `expr? "loading config"` that prefixes a note onto a string `Err`. Both were
    found by the re-probe rather than known up front, and both are refused BY
    NAME: each reads as plain propagation once its extra tokens are dropped, so
    a generic "expected semicolon" would send a reader after punctuation.

Where the desugar went, and why: a TRY_OP EXPRESSION node that pass D types and
codegen lowers to a branch, NOT a statement rewrite in the parser. `f(g()?)` is
the shape that decides it - a statement-level rewrite only ever reaches the `?`
that happens to sit at the top of a `let`. Putting it in the parser's postfix
loop is also what makes `f()?.field` and `f()??` cost nothing extra: the loop
just runs again. Codegen already had every piece (tag tests, payload extraction,
early return with scope unwinding), so `try_op.yoop` is assembly rather than new
machinery.

One thing worth knowing before building anything else that returns
mid-expression: the lowering is a diamond whose error half ends in `ret`, so the
Ok block has exactly ONE predecessor. That is what makes a temp computed before
the `?` still dominate everything after it, and why `a + f()?` needs no phi.

**1.4 Module `const` with a non-literal initializer - DONE 2026-08-13, 8 sites.**
`const RUNTIME_ROOT_VAR: string = "YOOP_RUNTIME_ROOT";`. Consts are INLINED, so
the bootstrap accepted only integer literals; now it accepts anything there IS
something to inline.

**The measurement was out of date the moment 1.1's field access landed, and the
brief's example was not the important one.** Re-measured, the 6 sites were four
different shapes:

  - a STRING (`RUNTIME_ROOT_VAR`, `GREETING`, `STD_ALPHABET`) - 3 sites, the one
    the brief named
  - an ARRAY (`const WHITESPACE_CHAR_CODES: uint8[] = [32, 9, 13, 10]` in
    `lex/chars.yoop`, `const DAY_NAMES: string[] = [...]` in std/time) - and this
    was the CRITICAL PATH, 95 files, not the strings
  - a variant constructor folded at compile time (`comptime_enum_fold.yoop`)
  - a CALL (`vec.vecNew(8)`, and `sortedDefs([...])` in `lex/scan_tables.yoop`)

Four shapes are inlinable now, and the test is "is there an LLVM spelling that
needs no storage of its own":

    const N: int32   = 42;               an immediate
    const F: float64 = 1.5;              an immediate, as 64 bits of hex
    const B: bool    = true;             an immediate
    const S: string  = "YOOP_ROOT";      a module-level string constant
    const A: uint8[] = [32, 9, 13, 10];  a descriptor over a module-level array

FLOATS were included, which the 1.5 note had left open. `Symbol.Value` still has
only an `intVal` and no float slot, and that turned out not to matter: the value
does not have to ride in the symbol at all. Codegen materializes every
non-integer const's operand from the AST in one program-level pass keyed by
SymbolId - which is also what makes an IMPORTED one work, since an import binds
the source module's SymbolId rather than a copy. So the "no float slot" gap was
an artifact of assuming the symbol had to carry the value.

**An array const inlines as a CONSTANT AGGREGATE, `{ ptr @.arr.0, i64 4 }`.**
LLVM takes one as an operand, so an array const costs no instructions at a use
either - `.len` is an `extractvalue` on a constant, and `for c in CODES` walks
the payload directly. That is better than the reference, which emits
`@m__CODES = internal global %yoop_array.uint8 { ... }` and LOADS it at every
use. The payload itself is `internal global` rather than `private constant`,
deliberately: constness is about the BINDING, so `A[0] = 9` through a const is
allowed the same way it is for a local, and read-only storage turns that into a
crash. The reference DOES crash there - `A[0] = 9` on a module const array is a
SIGBUS - which is a divergence where the bootstrap is right.

What the reference actually does, established by compiling probe programs rather
than by reading its source:

  - a module const is NOT inlined there at all: every one becomes an
    `internal global` with a constant initializer and is loaded at each use.
    The bootstrap keeps inlining, which is observably identical for a string
    (both end up naming the same `@.str.N`) and cheaper for everything else.
  - the initializer is checked against the ANNOTATION. `const S: string = 5;`
    is "cannot assign untyped int to string in initializer of module-level S",
    and `const N: int32 = "x";` is the mirror. So a const cannot quietly become
    a zero of the wrong kind, and the bootstrap checks the same thing.
  - a float const works at both widths and a bool const works.
  - `const A: int32[] = [1,2,3]` compiles, and `A[0] = 9` then crashes at run
    time. See above.

Two DIVERGENCES, both refusals rather than silent differences:

  - a const initialized by a CALL stays refused, and now says WHY: "is
    initialized by a CALL - the reference folds one at compile time and the
    bootstrap has no comptime interpreter, so there is nothing to inline". That
    message exists because the generic "needs a literal" one sends a reader
    after punctuation on a program that is perfectly well formed. It is also
    the new critical path - see the probe section above.
  - a struct or variant LITERAL initializer stays refused for the same reason
    (the reference folds `Shape.Circle { radius: 4 }` at compile time).

Not built, and named so nobody looks for it: a module-level `let` holding an
ARRAY. `let counters: int32[] = [0, 0, 0, 0];` is a MUTABLE global, so its
payload has to be writable storage that two globals with the same initial bytes
do not share - a different question from a const's, and the one file that wants
it (`module_level_mutable_array.yoop`) also initializes a second global with
`intr.heapAlloc(4)`, which is a call and refused anyway.

**1.5 Floats - DONE 2026-08-13, 97 files.** `float32` / `float64`, literals,
arithmetic, casts in every direction, printf promotion and interpolation. The
one whole missing PRIMITIVE type; everything else in phase 1 was syntax. 97 of
the 408 files stopped at a float before, 88 of them at ONE line -
`bootstrap/src/lex/lexer.yoop:67`, a `floatVal: 0.0` in a struct literal - and
none do now.

6 of the 97 went all the way to an executable; 2 more now reach clang and fail
only to LINK the runtime's `yoop_float_to_string`, which is 2.3. The other 88
moved as a block to `bootstrap/src/utils/sort.yoop:20`, which is 1.6. That is
the import closure again and it is worth being explicit about, because it will
happen once more: `lex/scan_tables.yoop` imports `quickSort` from `utils`,
`utils` is a directory module so `sort.yoop` loads with it, and the float error
was only the one the walk reached first. **1.6 is now the critical path, at the
same 88-file depth 1.5 had.**

What the reference actually does, established by compiling probe programs rather
than by reading its source:

  - an unsuffixed literal is UNTYPED and pins to whatever float the context
    wants. Unconstrained it infers float64, and `float` is an alias for
    float32 (so `const b: float = 2.5` pins to 32 bits, not 64).
  - nothing MIXES, in any direction: not float32 with float64, not a float with
    an int, and not an untyped INT literal with a float slot -
    `const a: float64 = 2;` is "cannot assign untyped int to float64". `2.0` is
    the literal that fits. There is no implicit widening either, so
    `const b: float64 = someFloat32;` is an error and the cast is the only
    route.
  - `.5` and `1.` are NOT float literals - a leading dot lexes as DOT then an
    int, and a trailing one wants an identifier after it. `1e5`, `1E5`,
    `1.5e-3`, `1.5E+3` and `1_000.5` all are.
  - a literal that overflows float64 is refused ("invalid float literal
    Infinity"). One that overflows float32 is NOT - `const d: float32 = 1.0e40;`
    compiles and the constant is an infinity.
  - `+ - * / %` all work, `%` included: `frem` is a real instruction and the
    reference emits it. So do `== != < > <= >=`, as ORDERED comparisons, which
    is what makes `x != x` FALSE for a NaN.
  - `& | ^ << >>` do not - but the reference is inconsistent about it, and that
    is the one place worth knowing. `a | b` is a typecheck error there; `a & b`
    passes typecheck and crashes its codegen with "unknown binary op amp for
    type prim/float64".
  - casts go every direction between the numeric primitives, as plain `sitofp` /
    `uitofp` / `fptosi` / `fptoui` / `fpext` / `fptrunc`. Truncation is toward
    zero in both signs. Out of range is UNDEFINED in LLVM terms and the
    reference does nothing about it - `int32(1e20)` printing 2147483647 is arm64
    saturating, not a language rule, so no fixture may depend on it.
  - a bool is not a number: `bool(f)` and `float64(b)` are both refused with the
    ordinary numeric-casts message. Nor is a float an array INDEX, an `if`
    condition, a `!` operand, a switch SCRUTINEE pattern ("float literals are
    not allowed in switch patterns"), or an enum BACKING type.
  - `printf("%f", x)` on a float32 emits an `fpext` to double first - C default
    argument promotion, the float twin of what 1.1 built for narrow integers.
  - an interpolated float renders through `%g`: `${1.5}` is "1.5", `${1.0}` is
    "1" with no point at all, `${1.0e20}` is "1e+20", `${-0.0}` is "-0". That is
    the reference's `yoop_float_to_string`, which is one `snprintf(..., "%g", x)`
    and nothing else - so the bootstrap calls libc directly and gets the same
    string without linking the runtime.

**The lexer's existing float decoding was WRONG, and that is the finding worth
carrying forward.** It accumulated the mantissa in a float64 and then multiplied
or divided by ten once per decimal place. Both halves round:
`mantissa * 10.0 + digit` loses bits past 2^53, and each scaling step rounds
again. Measured against strtod over 22 realistic literals it was off by an ulp
or two on 6 of them - 2.718281828459045 came out as 2.7182818284590446, 1e308 as
9.999999999999998e307, 6.02214076e23 one ulp high.

Nobody had noticed because **the parity token dump was deliberately skipping
float values**, on the stated theory that "this side parses with parseFloat and
renders with JS number formatting; the bootstrap renders through the C runtime's
float-to-string" made them incomparable. The FORMATTING is incomparable; the
VALUE is not. The dump now prints `float=<16 hex digits>`, the IEEE-754 bit
pattern, which has no formatting question in it at all - and the whole corpus
passes, over 557 files. That is the answer to "should the harness start
comparing float values": yes, and it should have from the start.

The decoder now accumulates an exact uint64 mantissa and applies the decimal
scale in ONE multiply or divide, which is correctly rounded while the mantissa
is under 2^53 and the scale within 10^22. Outside that it REFUSES BY NAME rather
than approximating: getting `1e308` right needs the big-integer path a real
strtod has (Clinger / Eisel-Lemire), and an off-by-an-ulp constant is a wrong
answer that looks like a right one. Nothing in std, examples or bootstrap is
outside the range - the widest literal in the whole corpus is
3.141592653589793, whose 16-digit mantissa is still under 2^53 - so the refusal
costs zero files today. If a real program ever needs one, that is a plan item
and not a silent difference.

A second lexer bug fell out of the same read: the exponent SCAN accepted only a
lowercase `e` while the value decoder handled both cases, so `1E5` lexed as an
int `1` followed by an identifier `E5`. Silent, because both sides produced
tokens. No corpus file uses the uppercase form, which is exactly why a
whole-corpus parity run never caught it; `tests/parity/literals.yoop` carries
one now.

Two DIVERGENCES, both refusals rather than silent differences:

  - the bitwise family on two floats is refused BY NAME, covering
    `& | ^ << >>` in one rule. The reference refuses four of them at typecheck
    and crashes its codegen on `&`.
  - a float literal outside the exactly-decodable range is refused, as above.

And one PRE-EXISTING divergence that floats made visible rather than caused: a
template literal handed DIRECTLY to `printf` as its FORMAT renders differently
in the two compilers. The reference has a printf special case that rewrites it
into C conversions, so a float prints "3.140000" there and "3.14" here; the same
split already applied to a bool ("1" versus "true") and long predates floats.
Six programs in `examples/pass/` do it and had not been compiling at all, so
the difference appeared the moment they did. Routing through `printf("%s\n",
<template>)` makes both agree, which is what every slice fixture already does.
Recorded in bootstrap/README.md; the bootstrap's version is additionally unsafe
in a way the reference's is not, since a built string containing a `%` becomes a
conversion specifier.

Where the machinery went. A float CONSTANT is spelled as 64 bits of hex at both
widths, because LLVM takes an arbitrary decimal for a `double` but not for a
`float` - `float 1.3` is "floating point constant invalid for type" - and hex is
what the reference emits for both. Reaching those bits needs a bitcast the
language does not have, so `utils/float_bits.yoop` goes through `memcpy` and is
the one `import.unsafe` file below lex. It lives in `utils` because BOTH the
parity dump (in lex) and codegen need it, and utils is the one module under
both. The float32 form measures the value AFTER rounding to float precision,
which is also what makes an out-of-range float32 literal come out as an infinity
rather than an error - matching the reference exactly, constant for constant.

NOT built, and named here so 1.4 picks it up: a module-level `const` or `let`
holding a float. `Symbol.Value` and `Symbol.Global` carry an `intVal` and there
is no float slot beside it, so it is the same shape of gap 1.4's string consts
are. No file in the corpus has one - the single candidate,
`examples/pass/module_init_folded.yoop`, initializes with `float32(42)` and
needs the const FOLDER rather than a float slot.

**1.6 Type-parameter bounds - DONE 2026-08-13, 100 files.**
`<T implements Comparable<T>>`. 100 of the 411 files stopped at
`expected '>', got IMPLEMENTS`, from 8 distinct sites, 93 of them funnelling
through `bootstrap/src/utils/sort.yoop:20` - `lex/scan_tables` imports
`quickSort`, `utils` is a directory module, and everything above lex inherits
the closure. None of the 415 stops at a bound now. 5 went all the way to an
executable and the rest advanced, including the whole 93-file pile.

**The design decision, and it went the reference's way: CHECK THE BODY ONCE,
with the bound's methods callable on the opaque parameter.** The alternative -
re-checking per instantiation - was rejected for three reasons, in order of
weight:

  - It moves every diagnostic from the DECLARATION to the call sites. A body
    that calls a method no bound promises is a bug in the declaration, and the
    author fixing it wants to be told there. That is the C++ template failure
    mode, and avoiding it is most of why a bound exists at all rather than
    being a comment.
  - It costs a decoration vector per instance. `tm.resolvedTypes`,
    `calleeReceiver` and `calleeInstance` are all keyed by NodeId with one
    entry per node, and `resolvedTypeAt` being the ONE place substitution
    happens is an invariant four codegen files lean on.
  - The reference does it this way, and a probe proves it rather than its
    source suggesting it: a bounded body calling a method outside its bound is
    refused AT THE DECL even when nothing ever instantiates the function.

What the reference actually does, established by compiling probe programs
rather than by reading its source:

  - a bound parses on a generic `function`, `type`, `variant` and `trait`. NOT
    on a method - a method cannot be generic there at all ("expected lparen,
    got lt").
  - multiple bounds are PARENTHESIZED: `<T implements (A, B)>`. A bare comma
    separates type PARAMETERS, so `<X implements A, B>` declares a bounded X
    beside an unbounded B, and `A + B` is refused. Multiple bounded parameters
    work and mix freely with unbounded ones.
  - the bound IS checked at the call site (`call to "f": type argument "T" =
    struct Plain does not satisfy bound`) and at a generic type application
    (`type argument for parameter "T" of generic "Box" does not satisfy
    bound`). The second points at the DECL's source location, not the use.
  - the body CAN call the bound's methods on the parameter - that is the whole
    point - and calling one outside the bound is refused with `type parameter
    "T" is not bound to trait "Other" - add 'implements Other' to T's
    declaration`. An unbounded parameter gets the same message.
  - a bound naming a GENERIC trait applied to the parameter (`Cmp<T>`) really
    does SUBSTITUTE the trait's own parameter. Renaming the trait's parameter
    to `U` changes nothing: the body still checks its second argument against
    the function's `T`. A concrete argument works too (`T implements
    Cmp<int32>`).
  - a type parameter can SATISFY a bound, which a bounded generic calling
    another bounded generic needs.
  - an unknown name is `unknown trait "Nope" in bound on type parameter "T"`;
    a non-trait is `bound on type parameter "T" must be a trait, got "Plain"`.
    A duplicate bound (`(A, A)`) is accepted silently.

Two DIVERGENCES, both refusals rather than silent differences:

  - **WHICH application of a generic trait a type implements is part of
    satisfying a bound.** The reference compares trait NAMES only, so a `type N
    implements Cmp<int32>` satisfies a `T implements Cmp<T>` bound with
    `T = N` - and then emits IR clang rejects with `'%t1' defined with type
    '%struct...N' but expected 'i32'`. The bootstrap records the arguments on
    the `implements` clause and compares applications, refusing by name.
  - **A generic trait bound with the wrong number of type arguments, including
    NONE, is an arity error.** The reference registers a generic trait under
    its spelled-out name, so it answers `unknown trait "Cmp"` for a missing
    argument and `unknown trait "Cmp<T, T>"` for a wrong count - both of which
    send the reader looking for a declaration that is right in front of them.

**How much of 3.2 this needed, and it is a real slice.** A bound is where a
generic trait first has to be APPLIED rather than just declared, so
`applyTraitArgs` substitutes a trait's own parameters through its method
signatures and interns the result as a distinct `Type.Trait` whose `typeParams`
slot holds the arguments. `collectImplementedTraits` does the same for an
`implements` clause, and `substitute` reaches trait lists through
`substituteTrait` so `Vec<string>` claims `Iterable<string>` rather than
`Iterable<T>`. What is NOT built, and is still 3.2: dispatching THROUGH an
applied trait as a value - `Iterable<T>` in a `for ... in`, and the `Into<E>`
conversion `?` wants. Those need a trait to be a receiver, not a promise.

**Two things this uncovered, both pre-existing and both load bearing.**

  - **The monomorphization set was never CLOSED.** A generic calling a generic
    passes its own opaque parameters along, so pass D records
    `partitionYoop_T`, not `partitionYoop_Token`. Codegen was emitting that as
    a real function - `define ptr @inner_T(ptr %x.arg)` - and calling it with
    an `i32`. clang accepted the mismatch and it happened to work, because an
    unbounded generic body only ever moves values around. A BOUNDED body
    dispatches a method on `T`, the receiver never resolves to a nominal type,
    and the symbol comes out as `@mod____a` - which is finally an error.
    `typecheck/monomorph.yoop` is the fix: after every body is checked, each
    open instance is closed against every concrete instance of the decl whose
    parameters it mentions, iterated to a fixpoint. Codegen skips the open ones
    and each call site resolves onto the concrete one. `sort.yoop` is exactly
    this shape - `quickSort` calls `partitionYoop` and itself, all with `T`
    open - so nothing on the critical path would have worked without it.
  - **`ref xs[i]` was refused**, and any comparison sort needs it:
    `Comparable.compare(ref arr[j], pivot)` is line 25 of `sort.yoop`. An array
    element has an address - codegen already computes it for `xs[i] = v` - so
    this is pass D widening the `ref` target rule and codegen reusing
    `emitElementAddress`. A temporary still has no address, which is the rule
    that had to survive.

One ORDERING change fell out too, and it belongs in the same list. Pass C used
to fill generic decls first and everything else second, with traits in the
second group. A generic decl's bounds and its `implements` clause both have to
read a trait's type parameters back to know which application they mean, and an
unfilled shell answers "takes 0 type arguments" - so traits now fill in a sweep
of their OWN, ahead of both. `FillPhase` is that three-way split. The
satisfaction sweep afterwards re-reads the implements clause and needed the
type-parameter scope re-established for the same reason.

And one bug fixed on the way, a new face of a trap bootstrap/README.md already
warns about twice: **a container MOVED into an interned type must not be
`disposable`.** `fillTraitMethods` marked a trait's `typeParams` disposable and
got away with it only because nothing ever read a trait's type parameters back;
bounds do, and the freed storage read back as whatever landed there next - which
surfaced as a bound being unsatisfied by the type that plainly implemented it,
three layers away from the annotation that caused it. `fillInstance`'s
substituted trait list had the same shape. Both are `let` now, matching the
`methods` and `fields` beside them.

Also worth knowing before writing another diagnostic: **`text.view` hands back a
BORROW of the Text's buffer**, so `disposable out: Text` plus
`return text.view(ref out)` returns a dangling string. `formatTypeList` in
resolve.yoop does exactly that and has been quietly producing an empty list for
Func-type diagnostics; the bound description was written to build with template
literals instead, matching every other diagnostic in the layer.

**The critical path moved rather than ended, for the third time.** The same 93
files now stop at `bootstrap/src/diagnostics/parse_error.yoop:35` - `.len` on a
`ref uint8[]`, which is field access through a borrow of an array. That is the
next one-line gate.

**1.7 The long tail - DONE 2026-08-13 except for two named refusals.**
`trait X extends Y`, `discard`, side-effect imports (`import "./init.yoop";`),
`union` decls, and - found by measuring rather than from the brief -
`export let` and `export "C" function`. Each is small and independent; they went
in one pass.

Measured first, and the brief's list was two items short and one item wrong.
`wait` is not here (it goes with `await` in 3.3), `union` is sized and skipped
(below), and the probe turned up two shapes nobody had listed: `export let`
(1 site, 2 files) and `export "C" function` (2 sites, 3 files).

**`discard` - DONE, 2 files, 2 sites.** `_ = expr;`. It is `_` then `=` then an
expression, and its own node kind - so the spelling survives into the AST - but
checked and emitted exactly as a bare `expr;` is. Both go through one case arm
in pass D and one in codegen, which is the whole point: the difference is that
the discard was written down on purpose, and nothing below the parser cares.
`_;` on its own is still refused, because `_` is a PATTERN spelling elsewhere
and swallowing one silently would be worse than a syntax error.

**Side-effect imports - DONE, 1 file, 1 site.** `import "./init.yoop";`. It is
the one import form with no `from`, since it has no clause for the keyword to
separate from the path. It still builds an ordinary IMPORT_DECL with zero
specifiers and no namespace name: the node's job is to name a module the graph
has to load, and every layer above reads the path off `strId`. So the only
thing it could get wrong is the GRAPH - binding a bogus name, or loading the
module a second time and defining its functions twice - and the slice fixture
imports the same file twice, once by name and once for effect, to say so.

**`export let` - DONE, 2 files, 1 site.** A module-level `let` is a mutable
global and exporting one is the same parse as `export const`. The load-bearing
half was in CODEGEN and had nothing to do with the parser: a global has exactly
ONE definition, in the module that declared it, so an importing module's read
has to name that module's symbol. `emitLoadGlobal` already took a `home`
parameter and was being handed `cx.tm.moduleId` at both call sites, which is the
READING module - so a cross-module read emitted `@main_0__counter` against a
definition called `@counter_1__counter`. `globalSymbol` is the fix, and it is
the same `importedFrom` lookup an imported CALL already goes through.

**`trait X extends Y` - DONE, 2 files, 2 sites.** `trait Loud extends Greeter`,
or `extends A, B`. Two merges, both at fill time, and nothing else moves:

  - the parents go in the SAME node slot an `implements` clause uses on a type,
    so `collectImplementedTraits` reads either without knowing which it has.
  - an `implements Child` clause claims the PARENTS too, transitively. That is
    what makes a bound on the grandparent satisfied by a type that only ever
    wrote `implements Child`, and it also makes `checkTraitsSatisfied` and
    `checkMethodsRequired` demand the parents' methods with no chain walk.
  - `lookupMethod` on a TRAIT falls through to its parents, which is what makes
    `Child.parentMethod(ref x)` resolve.

The list is FLAT by construction - a trait's own extends clause went through
`collectImplementedTraits` too - so the fall-through is one level deep and needs
no cycle guard. A parent declared BELOW its child is refused by name: its method
table is an empty shell at that moment, and merging one is invisible rather than
wrong, so every use downstream would report the child as missing a method that
is one line up.

The first attempt merged the parents' method tables into the child's instead,
which is tidier and cost two NEW self-compile blockers: the merge iterates a
`Map`, and `for entry in mapIter(...)` is `Iterable<T>` in a `for ... in`, which
is exactly what the bootstrap cannot compile yet. Worth remembering as a general
rule while the bootstrap is still growing - **a change to the compiler that adds
a `map.mapIter` loop adds a self-compile blocker**, and the lookup-side answer
avoided it entirely.

**`union` decls - SIZED and SKIPPED, 4 files, 2 sites.** Left as the named
refusal it already had. It is a C union: every field at offset 0, sized by the
largest, which is its own layout rule, its own `llvmType`, and its own field
read and write - the variant-payload shape rather than the struct one, since
reinterpreting bytes as another type needs an ADDRESS. See the follow-ups.

**`export "C" function` - REFUSED BY NAME, 3 files, 2 sites, NEW.** The message
was `only export function, export type ... are supported, got STRLITERAL`, which
reads as a typo on a declaration that is perfectly well formed. It now names the
feature and the reason: the definition is emitted under its bare C name, every
caller has to agree on that spelling, and `Symbol.Func` carries a TypeId and
nothing else - so an importing module has no way to learn not to mangle it.
Recording it on the symbol is the work, and the corpus's three files all call
theirs from the SAME module, so a `tm.externNames` shortcut would have passed
the probe and broken the first cross-module use.

Tests: 11 parse assertions (the discard node and its child, `_;` still refused,
a side-effect import binding nothing, `export let` and `export const` parsing,
the `export "C"` refusal, one and two parents, the parents' slot, and a generic
trait extending), 6 typecheck assertions (dispatch through the child and through
the parent, a bound on the parent satisfied through extends, a missing parent
method refused, and the declaration-order refusal), and
`bootstrap/tests/slice/long_tail.yoop` with `lib/tally.yoop` and
`lib/side_effect.yoop`, which runs identically under both compilers.

The `wait` half stays with `await` in 3.3 - it is a coroutine feature, not a
parse gap, and grouping it here was the brief's mistake rather than a decision.

Its `~` (bitwise NOT) half is **DONE 2026-08-13, 5 files, 4 sites**, and it is
the one item in this plan that was exactly the size it looked. Three edits:
`TILDE` joins `MINUS` and `BANG` in the prefix switch, `checkUnary` grows a
branch, `emitUnary` emits `xor <ty> %x, -1`. It needs none of the position rule
`&` and `*` need, because there is no binary `~` for a position to tell it apart
from.

What the reference actually does, established by compiling probe programs
rather than by reading its source:

  - `~` keeps the OPERAND's type, at every integer width, signed and unsigned
    alike. `~a` on a uint8 15 is 240; on an int32 5 it is -6; on a uint64 1 it
    is 18446744073709551614.
  - the expectation flows down into an untyped literal exactly as unary minus's
    does. `let w: uint8 = ~0` is 255, not an int32 -1 that then refuses to fit,
    and `let n: int64 = ~5` is an int64 -6.
  - an INT-backed value ENUM is an integer operand and keeps its OWN type, so
    `~Flags.A` is a Flags. That is the same rule the binary bitwise family
    already follows.
  - a bool, a float, a string, a struct and a STRING-backed enum are each
    refused with `bitwise NOT operator requires an integer operand, found X`.
    The bootstrap copies that message word for word.
  - it binds at the same precedence as unary `-` and `!`, so `~2 & 7` is
    `(~2) & 7` and prints 5, not -3.
  - the IR is `xor <ty> %x, -1`. -1 is all ones in two's complement at every
    width, so one spelling covers both signednesses and there is no separate
    complement instruction.

One thing worth noting because it looks like a divergence and is not: an
unconstrained `~-1` handed straight to `printf` is an error in the REFERENCE
("this expression still has an unpinned literal type"), which is the same live
sharp edge every other unconstrained untyped literal hits there. The bootstrap
defaults it to int32 and prints 0. Nothing new - it is 1.1 in plans/README.md,
and the slice fixture binds the value to an annotated local so both sides agree.

Tests: 4 parse assertions (the node kind and operator, the `(~a) & b` grouping,
stacked prefixes, and that there is no INFIX `~`), 8 typecheck assertions
covering the widths, the pinning, the enum and all five refusals, and
`bootstrap/tests/slice/bitwise_not.yoop`, which runs identically under both
compilers.

Its `extern ... from library "m"` half is **DONE 2026-08-13, 6 files, 4 sites**,
and it was not the syntax item it looked like. The two spellings of the `from`
clause MEAN different things:

    extern "C" from "stdio.h"   { ... }   a HEADER name - documentation
    extern "C" from library "m" { ... }   a LIBRARY name - `-lm` at link time

So parsing it was the small half; the load-bearing half is that the names are
collected GRAPH-WIDE and land on the one clang invocation, the way the runtime's
C sources already do. `CodegenOutput` carries them out beside `needsRuntime`,
because both are properties of the emitted program rather than of any module.

What the reference actually does, established by compiling probe programs rather
than by reading its source:

  - `library` is CONTEXTUAL. It lexes as an ordinary IDENT on both sides - the
    token dump proves it - so it is recognized by TEXT, and a variable called
    `library` stays legal. A STRING is required after it: `from library m` is
    "expected strLiteral, got ident".
  - the ABI is NOT consulted. `extern "intrinsic" from library "compiler"`
    contributes `-lcompiler` there and fails to link, which is the one place a
    carve-out was tempting and was skipped for matching behaviour.
  - `ssl` and `crypto` each lower to BOTH `-lssl -lcrypto`, and
    `framework:NAME` lowers to `-framework NAME` on macOS. Both are copied.
  - a library that does not exist fails at the LINK step, not earlier.

Not copied, and it is toolchain policy rather than compilation: the reference
also probes conventional install prefixes for `-L` / `-I` (Homebrew, vcpkg,
`YOOP_LIB_PATH`). Nothing in the corpus needs it to link - `m` is in libSystem
on macOS, and `sqlite3` / `ssl` are named by library files with no `main`, which
never reach a link at all.

**1.8 What item 1.1 uncovered.** Re-probed after 1.1 landed (80 of 401 files
now compile fully, up from 36). These were all hidden behind the variadic
blocker and are new to the plan, with distinct-site counts. Three of the four
are DONE 2026-08-13; `wait` stays with `await` in 3.3.

  - **Kind prefixes where a function is not - DONE, 13 files, 13 sites.** The
    brief called this "a kind prefix on a METHOD", and the 13 sites turned out
    to be TWO shapes: 9 methods (`async handle(ref self, ...)` in a type body)
    and 4 PARAMETERS (`function use(scoped h: ref FileHandle)`,
    `function take_pooled(pooled h: Task<int32>)`). Both are built.

    What the reference actually does, established by probing:

      * a method takes prefixes exactly as a function does, and the prefix
        REPLACES the `function` keyword - but `traced function area(...)`, with
        both, is also accepted. Multiple prefixes work.
      * a PARAMETER takes at most ONE (`marker other h: T` is "a parameter may
        carry at most one kind prefix in phase 6.5"), and it comes before `ref`
        (`marker ref h: H` parses; `h: marker ref H` does not).
      * an unknown kind on a PARAMETER is refused there; an unknown kind on a
        METHOD is NOT - a typo'd prefix silently produces an ordinary method.
      * a parameter's kind is checked against its `appliesTo`, and a
        `conferred` one is refused on a non-struct value.

    Two DIVERGENCES, both the stricter half:

      * a method's kind prefixes ARE resolved here - an unknown one is refused
        by name, and a PAUSABLE one (`async`, `task`) marks the method a
        coroutine so codegen refuses to emit it. Waving it through would emit a
        method that compiles, links and never suspends, which is the silent
        miscompile the whole pausable refusal exists to prevent.
      * `appliesTo` is not checked on a parameter, because the bootstrap's
        `KindInfo` records only `pausable` and `mustCall`. That is the ordinary
        "kinds are not enforced" gap rather than anything about this feature.

    One thing this uncovered that is worth knowing before touching a member
    run: **`Green function toString(...)` and `async function handle(...)` are
    the same two tokens, and only the BODY decides which.** An enum or variant
    case may be a bare identifier with the method right after it and no comma;
    a struct field is always `name: T`, so there the shape can only be a
    prefix. `atKindPrefixedMethod` takes that as a parameter. The two-token
    rule every other kind position uses is not enough here, and neither is
    "ends at `(`" on its own - an enum case may be `AB A | B`.

  - **`wait <expr>` - 10 sites.** `const v: int32 = wait h;`. A DIFFERENT thing
    from `await`: it joins a task handle. Cheap next to `await` and worth doing
    with it rather than separately. NOT done here.

  - **A named kind-region binding - DONE, 6 files, 6 sites.**
    `disposable reg: mem.ArenaScope = mem.arenaScope(4096) { ... }` - the block
    form attached to a BINDING.

    **The block IS the binding's scope**, and that is the whole semantic
    content. Established by probing: the name is visible inside the block, the
    scope-end call fires at the closing brace BEFORE anything after it, and
    reading the name afterwards is `undefined variable`. So it is not "a
    binding, then a block that happens to follow" - `childD` on the decl holds
    the block, pass D pushes a scope around the declaration AND the block, and
    codegen pushes one dispose scope and one locals scope around the same pair.
    That is `emitScopedBinding`, the named twin of `emitKindRegion`, and the
    two differ in exactly one thing: the subject has a name here, so it goes in
    an ordinary local slot instead of an anonymous one.

    The form is GATED on there being a kind prefix, which is what keeps it
    decidable: without the gate an ordinary `const p: Point = { x: 1 }`
    followed by a bare block statement would swallow the block.

    One DIVERGENCE, and it is one the bootstrap already had: `continue` out of
    a region disposes here and LEAKS in the reference, the same way `break`
    does. `dispose_break.yoop` already carries that reason.

    A neighbouring gap fell out of the same probe and is fixed with it: the
    ANONYMOUS form refused a QUALIFIED subject (`ephemeral mem.arenaScope(1024)
    { ... }`, 3 sites), because the statement-position lookahead stopped at
    `(`. Values from std must come through a namespace, so that was refusing
    the spelling every std user writes.

  - **`extern "C" from library "m"` - DONE, 6 files, 4 sites.** Written up
    under 1.7 above, where the rest of the long tail lives.

---

## Phase 2 - the codegen bugs

**2.0 The comptime-folded const on the critical path - DONE 2026-08-13, 99
files, 2 sites.** Not a plan item; it is what phase 1 left sitting in front of
everything else, and it is a change to the BOOTSTRAP'S OWN SOURCE rather than to
the compiler. `lex/scan_tables.yoop` declared its two scan tables as module-level
`const` arrays, and neither one could be inlined.

**The brief named one line and there were two, refused for two different
reasons - which is the finding.** `TOKEN_SCAN_LIST` went through a CALL
(`sortedDefs([...])`) that the reference folds at compile time. `KEYWORD_LIST`
is a plain array literal and was refused as well, because it is an array of
STRUCTS. So the gap underneath both is "a module-level array of structs", and
fixing only the fold would have moved the error down eleven lines.

What the bootstrap actually has for module-level storage, measured rather than
assumed - and the brief's suggestion (a lazily-initialised module `let`) is not
among it:

  - a module `const` of a number, bool, string, or an ARRAY of those: inlined.
    An array of structs is refused; so is an array of enum CASES, which the
    reference folds.
  - a module `let`: an INTEGER literal and nothing else. Not an array, not a
    string.
  - a module const ARRAY is writable storage here - `A[0] = 9` works - and
    read-only in the reference, where the same line is a SIGBUS at run time
    (probed, and bootstrap/README.md already recorded it). So sorting one in
    place at startup was the obvious shape and it is not available: the
    bootstrap's source has to compile with BOTH compilers.

So the tables are built at RUNTIME into a `LexTables` the caller owns, and
`lexNext` takes one by `ref`. `tokenize`, `dumpTokens`, `moduleHeaderName` and
`parseInto` each own one for the length of their walk, and ParserState borrows
the one `parseInto` made - which is what keeps it out of the per-token path.
`tagSpelling` builds its own, because every caller is a typecheck DIAGNOSTIC
three layers above the lexer and threading a lexer table through them to format
an error message would be worse than two vectors on a compile that is already
failing.

The ordering stays enforced BY CODE: `lexTablesNew` runs the same `quickSort`
over the same `Comparable<SortedTokenDefinition>` the fold used to run. Hand
sorting the literal would have been smaller and it trades a check for a comment,
and the comment already says what breaks (`...` scans as three DOTs).

Startup cost: two table builds per source FILE - the header peek and the parse -
each 85 vector pushes and one 41-element quicksort. Not measurable. The same
compiles take 0.33s and 3.54s before and after, three runs each.

REVERSIBLE. A self-hosted comptime interpreter would let `lexTablesNew` go back
to being a module `const` with no change to anything that reads it; the shape
that would move is one function, not the seven call sites.

Watched by `npm run test:parity`, which diffs the bootstrap's token stream
against the reference over 557 files and is exactly the thing that would catch a
table built wrong. 7/7 throughout. `lex.test.yoop` gained four assertions,
including the one that survives a rewrite of the table's representation: ask the
LEXER what it does with `...`.

**2.1 A user extern colliding with a lowering's own libc declaration - DONE
2026-08-13, 44 files.** `invalid redefinition of function 'malloc'`: std declares
`extern malloc` and the template-literal lowering declares it too, so one LLVM
module got two. Every one of the 44 was `malloc`, and it was the largest single
bucket in the whole probe. It is now zero.

Half the machinery landed with 1.1 and was reused rather than rebuilt.
`emitExternDeclares` was already a PROGRAM-level pass with a `seen` map, so two
user externs of one name already collapsed to one `declare`. The change is that
the map moved to the EMITTER (`codegen/extern_table.yoop`) and all FOUR sources
now go through one `externDeclare`: the user's extern blocks, the string-builder
lowering, the runtime bridge, and the printf builtin. The builtin used to be
special-cased with a `declaredPrintf` boolean returned out of the extern pass;
that is gone, and it is one fewer thing that can disagree.

**COMPATIBLE means "spells the same LLVM declaration"** - same return type, same
fixed parameter types in order, same `...`. That is the whole definition and it
is the right one: a `declare` says nothing else, so two yoop signatures that
agree on it are interchangeable at the ABI (`usize` and `uint64` are both `i64`;
`string` and `unsafe_ptr<void>` are both `ptr`) and two that disagree really do
disagree. It also sidesteps the `typeAccepts` problem the plan flagged - two
identical Func signatures intern to different TypeIds, so comparing TypeIds was
never going to work - by comparing the emitted spelling instead, which is
already computed. The signatures are stored as a SPAN in one flat
`Vec<string>` rather than as a `Vec<string>` per symbol, because a container
nested in a map value is the shallow-copy trap bootstrap/README.md warns about
twice.

A genuine mismatch is REFUSED BY NAME, quoting both LLVM spellings. That is a
deliberate divergence: the reference emits both lines and lets clang say
"invalid redefinition of function 'malloc'", which names neither declaration and
no source file.

Tests: `bootstrap/tests/slice/extern_dedupe.yoop` declares std/core/alloc's exact
libc block plus `strlen`/`memcpy` beside three template literals and runs
identically under both compilers; `bootstrap/src/codegen/codegen.test.yoop`
covers the refusals, which never reach an executable, and
`bootstrap/tests/codegen/` holds the two-MODULE programs it needs (a second
declaration of one name inside ONE module is a redeclaration pass A already
refuses, so the cross-module case cannot be posed with a source literal).

**2.2 Whatever the next probe finds.** Re-run the surface probe after phase 1;
the files that stop at a parse refusal have not had their codegen exercised at
all, so this bucket grows before it shrinks. That is expected and is the reason
phase 2 sits after phase 1 rather than beside it.

Two entries.

`examples/pass/enum_eq.yoop` emits `icmp requires integer operands`, and has
since before the phase-1 tail. A string-backed enum compared with `==` lowers to
an integer compare on two pointers. It is now the ENTIRE invalid-IR bucket.

**Structural Func comparison does not recurse - DONE 2026-08-13, 100 files, 1
site.** A typecheck bug rather than a missing feature, and the critical path.
100 of the 421 files stopped at `bootstrap/src/lex/chars.yoop:212` with

    argument 3 of "scanCharPredicates" is ref () => Result_bool_string[],
    not ref () => Result_bool_string[]

a message that says X is not X.

**The premise was right and the diagnostic was lying about how.** The types
really are an array of function values behind a `ref`, and the compare really
did stop at the top. But the rendering was wrong TOO, in a way that hid the
shape of the bug: the Func in that message has three parameters and printed as
`()`, because `formatTypeList` built into a `disposable` Text and returned
`text.view` of it - a BORROW of storage freed one line earlier. That is the trap
1.6 already recorded about `text.view`, still live at the one call site nobody
had read the output of. Both halves are fixed; the second one is why a
`<type>`-shaped or `()`-shaped rendering is worth treating as a bug rather than
as terseness.

**The fix is two functions, not one, and the split is the whole design.**
`typecheck/type_eq.yoop`:

  - `sameTypeStructurally` is an EQUIVALENCE - reflexive, symmetric,
    transitive. `id == id` fast path, then a recursive walk through the
    STRUCTURAL wrappers to reach a Func: `Ref`, `Array`, `Task`, `UnsafePtr`, a
    Func's own PARAMETERS and its RETURN, and `FuncPtr`.
  - `typeAccepts` is ASSIGNABILITY - that equivalence, plus the two widenings
    the language has, and those apply at the TOP LEVEL only.

Merging them was the tempting shortcut and it is wrong. `unsafe_ptr<uint8>` may
be passed where a bare `unsafe_ptr` is wanted; a `ref unsafe_ptr<uint8>` may NOT
be passed where a `ref unsafe_ptr` is, because the callee could store an opaque
pointer through it and break the promise the caller still holds. The reference
draws exactly that line - established by probing it, in both directions and for
an ARRAY as well as a `ref` - so recursing with `typeAccepts` would have made
the bootstrap accept three things the reference refuses.

The full set of shapes that can CONTAIN a Func was worked out rather than
guessed, and the answer splits cleanly:

  - STRUCTURAL, so walked: `Ref`, `Array`, `Task`, `UnsafePtr`, `Func` params,
    `Func` return, `FuncPtr`. Each is built by COMPOSITION out of other
    TypeIds, so its identity is its components' identity.
  - NOMINAL, so not walked: `Struct`, `Variant`, `Union`, `ValueEnum`, `Trait`,
    `VTable`, `TypeParam`. Identity is the DECL. Two structs with identical
    fields are two types, and calling them one would hand codegen a value of
    one LLVM struct where another is expected.

**Infinite recursion is handled by that second bullet rather than by a depth
cap,** and the argument is the same one `typeMentionsTypeParam` in
generics.yoop already makes. A nominal type is the ONLY way to build a type
containing itself - `type Node { next: Node }` is a Struct whose field is that
same Struct id - and the walk never enters one, so it cannot loop. Nothing else
can cycle: a structural type is interned AFTER the types it composes, so a
`Ref(x)` can never have itself as `x`, and there is no spelling that would let a
Func's parameter be its own signature (no type aliases, no `typeof`). A depth
cap was considered and rejected: returning false at the cap would refuse a
legitimately deep type silently, which is exactly the failure mode rule 4
exists to prevent. `typecheck.test.yoop` asserts the `type Node { next: Node }`
case, and a regression there shows up as a test that HANGS.

One shape stays refused that a fuller rule would accept, and it is named rather
than left as a surprise: a generic nominal applied to a Func, so two separate
`Box<(a: int32) => int32>` annotations. Nothing in std, examples or
bootstrap/src applies a generic to a function type, and accepting it is not a
one-line extension - the two are separate registry entries with separate mangled
names, so it needs the INSTANCE registry to dedupe on structural argument
equality rather than this compare to look further.

`formatType` gained the whole pointer family, `Task`, `null`, the untyped
literals, `Union`, `VTable` and `FuncPtr` at the same time. Every one of them
used to render as `<type>`, which turns any mismatch between two of them into
"X is not X" - the same unactionable message, one layer down.

Tests: 27 new assertions in `typecheck.test.yoop` across four suites - the
accepting cases (each one a pair of SEPARATE annotations, since one annotation
used twice would compare equal by id and prove nothing), the refusals at the
same depth (parameter type, return type, arity, and wrapper mismatch), the
pointer widening staying top-level, and the rendering. Plus
`bootstrap/tests/slice/func_wrappers.yoop`, which reaches an executable and runs
identically under both compilers. The three assertions that fail without the
recursion were verified to fail, by reverting it.

**2.3 An extern `from "yoop_runtime"` does not LINK the runtime - DONE
2026-08-13, 18 files.** `Emitter.usesRuntime` was set only by codegen's own
lowerings (the allocator context, the errno bridge), so a program whose only
runtime use was a user-written `extern "C" from "yoop_runtime" { ... }` linked
libc alone and failed with `"_yoop_panic", referenced from`. std/debug, std/env,
std/runtime, std/core/alloc, std/core/atomic, std/core/format and std/core/vec
were all in that shape.

It was mostly wiring, as the plan guessed: 1.7's `library` half already walked
every EXTERN_BLOCK in the graph and carried the answer out on `CodegenOutput`.
That walk now answers both questions and returns a `LinkRequests`.

Three things worth knowing, and the first two were established by probing rather
than by reading:

  - **the reference does not consult the `from` name at all.** It links the
    whole runtime into EVERY program - a hello-world that mentions nothing comes
    out with 197 `yoop_` symbols in it - and
    `extern "C" from "not_the_runtime" { function yoop_panic(...) }` links fine
    there. So there was no reference behaviour to copy, and the bootstrap links
    a strict SUBSET: a program that works there works here as long as it names
    the runtime, which every file in the corpus that uses it does.
  - **the LIBRARY spelling stays a library.** `from library "yoop_runtime"`
    lowers to `-lyoop_runtime` and fails to find an archive, which is exactly
    what the reference does with it. The two `from` spellings mean different
    things and this is a place that would have been tempting to blur.
  - **the name test is a basename PREFIX, not an equality.** Matching
    `"yoop_runtime"` alone left five files still failing on
    `_yoop_arena_alloc`, because std/core/alloc.yoop spells its block
    `from "runtime/yoop_alloc.h"` - a PATH to a different runtime header. A
    header whose basename starts with `yoop_` is the runtime, which covers both
    spellings with one rule and nothing to keep up to date; `yoop_` is the
    runtime's file prefix as well as its symbol prefix. Nothing else in std,
    examples or bootstrap names a header that way.

`usesRuntime` and `namesRuntime` stay SEPARATE, because they answer different
questions: the first additionally decides whether the runtime's own `declare`
lines are emitted, and a user's extern brings its own. Merging them would put
`declare ptr @yoop_ctx_alloc(i64, i64)` into a program that never calls it.

Both README properties are kept: discovery is still lazy (a program that names
nothing links one input), and the WHOLE runtime set is still linked rather than
what is used.

Tests: `bootstrap/tests/slice/runtime_extern.yoop` reaches the runtime through
nothing but declared symbols - no intrinsic anywhere in it - so the `from`
clause is the only thing that can put the sources on the clang line.
`codegen.test.yoop` covers the three name rules including the near-miss
(`vendor/not_yoop_runtime.h` is somebody else's header).

**2.4 `break` inside a SWITCH arm - DONE 2026-08-13, 101 files, 1 site.** What
2.2 left sitting in front of everything else. 101 of the 422 files stopped at
`bootstrap/src/lex/literals.yoop:41`, which is a `break` at the end of a
`case 'n':` arm in the char-literal escape decoder. A switch arm does not fall
through in this language, so the `break` is decorative there - which is exactly
why it went unnoticed, and exactly why it must not be deleted from the
bootstrap's own source as the fix. It is legal Yoop.

What the reference actually does, established by compiling probe programs
rather than by reading its source, and the two halves are NOT symmetric:

  - `break` inside a switch arm leaves the SWITCH. Statements after it in the
    arm are unreachable and it says so (`warning: unreachable code`), and a
    `break` in a switch nested INSIDE a loop leaves the switch and lands on the
    statement after it - the loop body continues. Measured: 5 iterations each
    reaching a `total = total + 1000` after the switch.
  - `continue` inside a switch arm targets the enclosing LOOP, not the switch,
    and `continue` in a switch with no loop around it is refused
    (`'continue' is not inside a loop`). So the switch is a BREAK target only.

The sizing pass called out three places and named the third as the risk. It was
right about the risk and wrong about the fix, and that is the finding.

**The depth belongs on the FRAME, not in a parallel stack.**
`dispose_stack.yoop` carried a `loopScopeDepths` Vec pushed alongside every
loop, and the suggestion was to teach it to answer two questions. It cannot:
a `break` out of a switch inside a loop unwinds to the SWITCH's depth while a
`continue` in the same arm unwinds to the LOOP's, and those are two different
numbers alive at the same moment. Moving `scopeDepth` onto `LoopLabels` made
each jump read the depth of the thing it is actually leaving, and
`loopScopeDepths`, `disposeEnterLoop`, `disposeExitLoop` and `disposeLoopDepth`
all DELETED rather than growing a case. `dispose_stack.yoop` is now a stack of
scopes and nothing else.

The rest fell out of that:

  - `LoopLabels` grew `scopeDepth`, `isLoop` and `sawBreak`. `switchPush` is the
    switch's frame; `loopPush` reads the dispose depth itself rather than taking
    it, so a caller cannot open the body's scope first and record a depth the
    jump would skip.
  - `break` reads the TOP frame (`innermostBreakable`); `continue` scans DOWN
    for the innermost `isLoop` frame. A switch frame carries a zeroed continue
    target rather than the enclosing loop's, so a wrong lookup is an obvious
    zero instead of a plausible label from another construct.
  - pass D: `break` is legal when EITHER `loopDepth` or `switchDepth` is
    non-zero; `continue` still reads `loopDepth` alone. The two counters stay
    separate for exactly that asymmetry.

**One thing the sizing did not see, and it is the half that produces invalid IR
rather than a wrong answer.** A `break` makes an arm report itself TERMINATED,
so a switch whose every arm ends in one looked like "nothing reaches the join"
and emitted no join label - while every one of those breaks branched to it.
`sawBreak` on the frame is the test; `allBreak` in the fixture is the case, and
it fails as `use of undefined value` rather than as a wrong number.

The reference has the mirror of that bug and it is harmless there: it warns
`unreachable code` on the `return` after such a switch and then emits correct
code anyway. Noted rather than copied.

Tests: `bootstrap/tests/slice/switch_break.yoop` (decorative break, early break
mid-arm, every-arm-breaks, a switch in a loop, `continue` in a switch arm, a
`break` in a loop inside an arm, and a `for` loop's step surviving a `continue`
beside a `break`) runs identically under both compilers. The DISPOSAL depth is
in `dispose_break.yoop`, which is bootstrap-only because the reference disposes
on neither `break` nor `continue`: a switch in a loop with a `disposable` in the
arm AND one in the loop body, where `break` must unwind the first and not the
second and `continue` must unwind both. Plus 6 typecheck assertions.

**2.5 A STRUCT LITERAL at a generic call - DONE 2026-08-13, 3 sites.** What 2.4
left in front of everything: 101 files moved from `lex/literals.yoop` to
`lex/scan_tables.yoop:95`, `vec.vecPush(ref out, { str: "(", tag: ... })`,
refused as "cannot tell which struct this literal is".

`instantiateCallee` checks every argument with NO expectation, because the
parameter types are exactly what is not known yet. A struct literal has no type
of its own - which struct it is comes from context - so checking it there can
only report that message about a call that is perfectly well formed, and it
contributes nothing to the inference it was being checked for. It is now
SKIPPED in that loop, and `checkArgsAgainstFunc` pins it on the re-check against
the substituted signature, which is the same place an untyped int literal pins.

The fallback is unchanged and is the point: if nothing ELSE pins the parameter,
the message is `cannot infer "T" for "record"` - about the call site, which is
what is short of information - rather than about the literal, which is fine.

Tests: 4 typecheck assertions (inferred from the expected type, inferred from a
sibling argument, the unpinnable case, and a bad field inside a pinned literal
still reported) plus two lines in `bootstrap/tests/slice/generics.yoop`.

**2.6 TRANSPARENT type aliases - DONE 2026-08-13, 94 files, 1 site.** 2.5 moved
the pile to `bootstrap/src/ast/arena.yoop:32`, `cannot assign untyped int to
NodeId` on `childA: 0` in `createASTNode`. `ast/node.yoop` declares
`export type NodeId = usize;` and pass A was registering it as a STRUCT with
zero fields, so `NodeId` was a nominal type that no integer literal could pin to
and no `usize` could be passed to. The parser had always parsed the form
(`childC` holds the RHS annotation); nothing below it did anything with it.
`Symbol.Alias` had been declared for it and was never constructed.

What the reference does, probed: `NodeId` and `usize` are interchangeable in
BOTH directions - `takesUsize(aNodeId)` and `takesNodeId(aUsize)` both compile
and run. So it is fully transparent, and that is what makes the fix cheap: the
NAME resolves to the RHS's own TypeId and no type is interned for the alias at
all. Type equality stays `id == id` and nothing downstream unwraps anything.

Three decisions worth keeping:

  - **Resolution is LAZY, forced eagerly once per module.** `typeIdOfSymbol`
    resolves an alias the first time something asks for it, so an alias may name
    one declared further down the file - forcing them in source order would
    refuse `type Coord = Pt;` for naming a `Pt` that is three lines below. Pass
    C then FORCES every alias in the module it is filling (a new `ALIASES` phase
    between GENERICS and CONCRETE), which is what keeps the lazy path safe: the
    annotation NodeId belongs to the declaring module's arena, and forcing it
    while that module is the one in hand means a later module reading the alias
    through an import finds the answer already there rather than resolving a
    node id against the wrong arena.
  - **A cycle is named, not capped.** `type A = B; type B = A;` would recurse
    forever, and lazy resolution has no order to detect one from, so the symbol
    carries a `resolving` flag and re-entry reports "is defined in terms of
    itself". A compiler that hangs says less than one that names the cycle.
  - **A GENERIC alias (`type Pair<T> = Box<T>;`) is refused BY NAME.** It needs
    the parameters in scope while the RHS resolves and a template to instantiate
    on use. Nothing in std, examples or bootstrap/src writes one.

Tests: 7 typecheck assertions (both directions, an untyped literal pinning
through, a chain declared out of order, an alias to a struct, an alias to an
array of an alias, the cycle, the generic refusal) plus
`bootstrap/tests/slice/type_alias.yoop`, which runs identically under both
compilers.

**2.7 `ref a.b.c` - a borrow of a NESTED field path. DONE 2026-08-13, 85 files,
1 site.** 2.6 moved the pile to `bootstrap/src/parse/attributes.yoop:69`,
`vec.vecExtendFrom(ref ps.ast.childIds, ...)`.

**The refusal was older than the machinery that had already removed the
reason.** `emitFieldAddress` in `codegen/struct.yoop` recurses through a nested
base - it has to, because `a.b.c = v` writes at any depth - so the address of
`o.mid.inner` was already a gep on a gep. Pass D was still refusing anything
whose base was not a bare IDENT. Deleting the guard was not right either: the
path has to BOTTOM OUT in a name, because `ref f().x` has no storage at all and
`ref xs[i].y` needs an element gep the field walk does not build. So the check
became a walk down the base chain, and the message names those two shapes rather
than the depth.

Tests: 3 typecheck assertions (deep path accepted, off a call refused, off an
element refused) plus four lines in `bootstrap/tests/slice/ref_fields.yoop` that
prove the callee writes into the ORIGINAL rather than into a copy materialized
on the way down.

**2.8 `while (true)` whose every exit is a `return` - DONE 2026-08-13, 4 files.**
Not a plan item; it appeared in the probe as
`codegen: internal error: no return on some path out of "declOf"` once 2.6 let
the `ast` module reach codegen. `declOf` is `while (true) { ... return at; }`,
and a loop never counted as terminating - which is right in general, since the
condition may be false on the first test, and wrong for the one condition that
cannot be.

`emitWhile` now reports `terminated` when the condition is the LITERAL `true`
and no `break` targeted the frame - `sawBreak` from 2.4 is what answers the
second half. It also branches UNCONDITIONALLY into the body in that case:
`br i1 true, label %Lbody, label %Lend` is correct but it NAMES the exit block,
and LLVM rejects a reference to a label nothing defines, so the exit could not
then be left out.

Only the literal is folded. `while (1 == 1)` and a `while (SOME_CONST)` keep the
ordinary answer, which is the safe direction - a loop treated as non-terminating
only ever emits an extra reachable block. Folding either needs a comptime
interpreter, which is out of scope.

Tests: two functions in `bootstrap/tests/slice/control_flow.yoop` - one whose
every exit is a `return` (so there is no `return` at the end of the function at
all) and one with a `break` (so the exit block has to exist and the statement
after the loop has to run). Both run identically under both compilers.

**2.9 Forwarding a `ref` PARAMETER - DONE 2026-08-13, 90 files, 4 sites in
bootstrap/src.** Where 2.7 left the pile. 90 of the 422 stopped at
`bootstrap/src/parse/header.yoop:69`:

    function lexAt(ref tables: LexTables, ref src: uint8[], pos: usize) ... {
      switch (lexNext(ref tables, src, pos)) {   // `tables` with ref, `src` without

`argument 2 of "lexNext" is ref uint8[], not uint8[]`. The other three sites are
struct-literal FIELDS rather than call arguments, in `codegen/codegen.yoop:350`:
`{ e: e, prog: prog, tm: tm, ... }`, where all three are `ref` parameters of the
enclosing function going into `ref` fields of `Cx`. The source even carries the
comment - "`e`, `prog` and `tm` are already refs, so they go in as-is; `ref ref
T` is not a thing" - so the bootstrap's own source is written against the
reference's rule and the bootstrap does not have it.

What the reference actually does, probed with
`function fwd(ref v: int32): int32 { return inner(v); }`. All THREE spellings
compile and run: `inner(v)` into a `ref int32` parameter, `inner(ref v)` into
the same, and `byVal(v)` into a plain `int32`. So a `ref T` parameter is usable
in the body as BOTH `T` and `ref T`, and re-borrowing needs no `ref` written.

That is a real design fork and the probe settles it, so it should not be
re-litigated: the reference allows a call site to hide a re-borrow, even though
the whole stated reason `ref` is required at a call site is that the reader can
see what may be written through. Copy it - the bootstrap's own source depends on
it in four places, and diverging means editing source that the reference
compiles.

Two ways in, and they are very different sizes:

  - **The narrow one.** Record on the `Binding` that the name arrived as a `ref`
    parameter, accept it where a `ref T` is wanted, mark the node, and have
    codegen emit `Operand.SlotAddr{name, ARG_PTR_SLOT}` - the incoming pointer
    IS the slot for a `ref` parameter, so the operand is the same one `ref v`
    already produces. Mirrors `tm.derefUses`, which is the same trick in the
    opposite direction.
  - **The one-line one, and it is a trap worth naming.** `bindParams` is what
    unwraps a `ref T` parameter to `T` in the body; binding it as `ref T`
    instead would route everything through the machinery item 1.0 already built
    for a `ref T` FIELD, which opens at the USE. That is one line and an unknown
    amount of fallout - every read, write, field access and index in every body
    with a `ref` parameter changes which path it takes. bootstrap/README.md
    records `bindParams` as the deliberate place the two part company. Measure
    before believing it.

**The NARROW route was taken, and the one-line one was measured rather than
believed.** Binding a `ref T` parameter as `ref T` in the body would have needed
at least five special cases, each of which is a place the change could go wrong
quietly:

  - `emitLocalRead` would have to yield the incoming POINTER for a `ref`
    parameter instead of a load, or every use would load twice.
  - `checkRefExpr` would have to stop double-wrapping: `ref v` on a `ref T`
    parameter would ask for `ref ref T`, and the reference accepts that
    spelling.
  - assigning to a `ref` parameter by name (`v = 5`) would compare `ref int32`
    against `int32`.
  - a method's `self` is a `ref` parameter, so EVERY method body in the corpus
    changes which path its field reads and writes take.
  - a `switch` over one, an index of one and a `.len` on one each go through a
    different opener.

Against that, the narrow route is one `bool` on `Binding`, one map on
TypedModule, ~15 lines in pass D and ~12 in codegen - and it leaves the
invariant bootstrap/README.md states intact rather than replacing it with
something subtler. The README's line now says where the two rejoin instead of
being deleted.

**The rule is keyed on how the name ARRIVED, not on its type**, and that is what
keeps it honest. A `ref` parameter is ALREADY a borrow, so forwarding it creates
no aliasing the caller's own signature did not already declare - which is why
the reference lets the `ref` go unwritten there and refuses it for a plain
local. Probed both ways: `inner(x)` on a plain `int32` local is
`parameter "v" expects a ref argument - pass with 'ref x'` there, and
`{ c: c }` filling a `ref Counter` field from a `ref` parameter compiles and is
a real borrow (the probe's original counter ends at 12, not 1).

Where it went, and it is the MIRROR of the machinery 1.0 built:

  - `Binding.refParam` remembers what `bindParams` unwrapped. That is the only
    record left, since `typeId` is the plain `T` from then on.
  - `reborrowIfWanted` sits beside `openBorrowIfWanted` in pass D and answers
    the same question in the other direction: the position wanted a `ref T` and
    the name is already one, so hand it on.
  - `tm.reborrowUses` records the node, and `emitForwardBorrow` in
    codegen/borrow.yoop turns it into `%v.arg` - the ARG_PTR_SLOT operand `ref v`
    already produces. It is reached BEFORE the ordinary expression walk, because
    the load that walk would emit is the thing being skipped rather than
    something to undo.

Tests: 7 typecheck assertions (all three spellings on a `ref` parameter, the
struct-literal field position, a plain local still needing `ref` at a call and
in a literal, and a by-value parameter not being forwardable) and
`bootstrap/tests/slice/ref_forward.yoop`, which covers a call argument, a
`ref T` struct field, a two-hop forward, a `ref uint8[]` (the shape the compiler's
own `lexNext(ref tables, src, pos)` has) and `self` in a method - and runs
identically under both compilers.

**It moved the critical path rather than finishing files.** The same 90 landed
on `parse/state.yoop:108`, which is 2.10.

**2.10 The `Into` half of `?` - DONE 2026-08-13, 90 files, 2 sites in
bootstrap/src.** Where 2.9 left the pile, and the deferred half of 1.3. `?`
propagating a `LexedError` out of a function returning `Err of ParsingError`,
which the reference converts through an `Into<ParsingError>` impl on the
operand's error type.

It was written up as needing generic trait INSTANTIATION and therefore blocked
behind 3.2. Re-measured, it needed none: 1.6 already built the applied-trait
machinery, so `LexedError implements (Display, Into<ParsingError>)` records a
`Type.Trait` whose one argument is ParsingError, and the conversion is an
ordinary STATIC trait dispatch on a concrete receiver - the same one
`Display.toString(ref p)` has been doing since before floats. Nothing here is a
vtable, and nothing here instantiates anything.

Two decisions worth keeping:

  - **The trait is matched by NAME plus its single argument, not by resolving
    `Into` as a symbol.** It lives in std/core/traits.yoop, which the reference
    AUTOLOADS into every graph and the bootstrap does not - so the module
    writing the `?` may never have heard of `Into`, while the module that
    declared the error type certainly has. Going through the name puts the check
    where the evidence is. The `into` METHOD is checked too, because codegen is
    about to name that symbol.
  - **The conversion is RECORDED, in `tm.tryIntoUses`, rather than re-derived.**
    Codegen has both payload types in hand and could compare them, but "these
    differ" and "these differ AND a conversion was found" are different facts,
    and only pass D established the second.

The lowering is three instructions in the FAILURE branch and nothing at all on
the success path, which is what makes `?` able to convert without costing the
common case: `emitCasePayloadAddr` (the payload gep without the load that was
always its last step), one `call` to `@<module>__<ErrType>__into(ptr %addr)`,
and the existing store into the enclosing Err. The receiver is `ref self`, so
what it needs is the payload's ADDRESS - which the try lowering already had,
since reinterpreting the payload bytes as a case struct needs one anyway.

The refusal for a genuine mismatch now names the ROUTE OUT rather than the
missing feature: "the two error types have to match, or the first has to
implement `Into<X>`".

Tests: 3 typecheck assertions (the impl makes the propagation legal, an impl for
a DIFFERENT target does not count, and the refusal names the Into route), on top
of the two that were already there. `examples/pass/qmark_cross_shape_into.yoop`
runs and prints its documented output - it proves the conversion RAN rather than
a bit-copy sneaking through, because the impl stamps a tag of 7 on the way.

Still refused by name, and still 1.3's: the handler form `expr? e { ... }` and
the context form `expr? "loading config"`. Neither is an Into question.

**It moved the critical path again**, to `source_graph/load.yoop:211` - 70 files
on `Iterable<T>` in a `for ... in`, which is 3.2 and was already in the plan.

**2.11 An UNSIGNED comparison used a SIGNED predicate - DONE 2026-08-13.** A
SILENT MISCOMPILE, found by running a probe rather than by any file failing to
compile, and the most serious thing this pass turned up.

`llvmIntPredicate` returned `slt` / `sgt` / `sle` / `sge` for every integer
comparison, whatever the operand's signedness. `icmp slt` and `icmp ult` are
different instructions: an i8 holding 128 is -128 to the signed one, so
`first < 128` on a uint8 byte of 104 came out FALSE. The comment on the function
said "unsigned variants arrive with unsigned types", so it was a known to-do
that nothing had come back to.

**What it was breaking, and why nothing noticed.** Every `usize` comparison in
the compiler is fine, because a length never reaches 2^63 - which is most of the
comparisons in the corpus. The one that is not fine is `std/core/strings.yoop`,
whose UTF-8 validator is a loop of `first < 128` / `first < 224` on BYTES. Every
one of those took the wrong branch, so `stringFromBytes` returned Err on valid
ASCII, and the only visible symptom was three layers away:
`instanceNameOf` in typecheck/generics.yoop falling back to the un-suffixed base
name for every generic instance it built. The bootstrap compiled, ran, and
produced wrong answers.

The fix is the shape `llvmIntOp` already had for `sdiv`/`udiv` and `ashr`/`lshr`:
take the OPERAND's signedness, which `primIsSigned` already answers and already
unwraps a value enum's backing for. `eq` and `ne` take no sign - two identical
bit patterns are equal under either reading - which is why the table grew four
entries and not six.

**A REFERENCE BUG fell out of writing the test.** The reference compares an
`enum<uint8>` SIGNED: `Flags.HIGH > Flags.LOW` for cases 200 and 10 is false
there. Its `binaryInstruction` asks `isUnsignedIntPrim(opType.name)`, and a
value enum's type is not a prim, so the override never fires. The bootstrap
unwraps the alias and is right. A slice fixture is asserted against BOTH
compilers, so that one case lives in a codegen IR assertion instead.

Tests: `bootstrap/tests/slice/unsigned_compare.yoop` covers uint8 / uint16 /
uint32 / uint64 against each other and against literals above the signed
boundary, plus int8 and int32 to prove signed stays signed - every assertion
chosen to FLIP under the wrong predicate, since the two agree on everything that
fits in the signed half. Three codegen assertions read the IR directly for
`ugt` on an `enum<uint8>`, `slt` on an int32 and `ult` on a uint8.

**2.12 PROPAGATED disposal - DONE 2026-08-13, 6 of the 10 self-compile
diagnostics.** `propagates<disposable>` on a type with no `dispose` method of
its own. Program, Emitter, FnLocals, LoopStack, DisposeStack and LocalScope were
each refused with `"x" is disposable, which requires a "dispose" method, but X
has none`.

The sizing in the follow-ups was right: the clause means the obligation is
PROPAGATED to the FIELDS, so the scope-end call is one call per field that
supplies the kind, made on that field's own type, with a gep in front of it. A
field supplies the kind when its own type propagates it, which is how `Text`,
`Vec<T>`, `Map<K, V>` and `ExternTable` each reach an `Emitter` field. Order is
reverse DECLARATION, matching every other disposal - probed against the
reference rather than assumed, and the two agree.

**The one design decision, and it is about WHERE the clause lives.** Both
readers - pass D checking a binding, codegen emitting its scope-end call - stand
in a DIFFERENT module from the declaration, so neither has that arena in hand to
read `childF` from. So the kind rides on `NominalDecl`, stamped in pass A and
pass C while the declaring module's AST is the one being walked. That is the
same rule type aliases already follow. ONE kind rather than a list:
`propagates<disposable, tainted>` records only `disposable`, mirroring
`disposeMethodOf`'s "the first prefix that asks wins", and it costs nothing -
no file in std, examples or bootstrap/src writes a second kind on a TYPE.

Two refusals, both by name, both where the reference emits a call to a symbol
that does not exist:

  - a field whose type propagates the kind but has no such METHOD. Chaining
    through a second level is a real feature - the gep is one deeper per level -
    and nothing in the corpus needs it.
  - a propagating type with NO qualifying field. The clause promised a cleanup
    and nothing would be emitted, which is a leak that compiles.

**A max-value sentinel bit again, and it is the SAME trap the README already
records.** `PendingDispose` first told a field entry from a binding entry with
`fieldIndex == FIELD_NONE`, `FIELD_NONE` being 2^64-1, because field 0 is an
ordinary answer and the sentinel has to be a maximum. The JS reference silently
WRAPS an integer literal above int64 to zero - `const N: usize =
18446744073709551615;` prints 0 there and prints itself here - so every FIELD-0
disposal skipped its gep in the JS-built stage and disposed the binding instead.
It is a bool now. Probed and confirmed as a reference bug; a codegen assertion
covers the bootstrap's own answer.

Tests: `bootstrap/tests/slice/dispose_propagated.yoop` (reverse field order, a
plain field skipped, a propagated binding interleaved with two direct ones, and
an early `return` unwinding it), four typecheck assertions and three codegen IR
assertions.

**2.13 std AUTOLOADS - DONE 2026-08-13, 5 sites, 4 files.** Two std modules
join every module graph whether or not anything imported them. The reference has
done this since `task` / `async` / `joined` / `pooled` stopped being reserved
WORDS and became ordinary `kind` decls in std source: they used to be always in
scope, and the autoload is what keeps that true.

WHAT IS AUTOLOADED, and it is a list because the ORDER matters:

    std/core/kinds.yoop    `async`, `task`, `joined`, `pooled`, `disposable`,
                           `ephemeral`, `owned`
    std/core/traits.yoop   `Display`, `Into`, `WithContext`, `Iterable`,
                           `Readable`, `Writable`

kinds first, because traits.yoop writes `async read(ref self, ...)` and `async`
is a kind kinds.yoop declares. Both walk BEFORE the entry, so they sit early in
the topological order and every user module reads declarations that are already
filled - which is the reference's reason too, and is what item 3.1 will need
when it checks a generated `toString` against `Display`'s method table.

A kind needs no import at all once its declaration is in the graph: kinds are
reached by NAME from a graph-wide registry (`Program.kinds`, filled in pass A),
so merely BEING there is the whole requirement. That is why four files that
never mention `std/core/kinds.yoop` now compile.

ONE DIVERGENCE, deliberate: the reference autoloads two MORE modules,
`std/core/format.yoop` and `std/core/strings.yoop`, because its codegen lowers
an interpolated template literal into a call to `stringConcatAll`. The bootstrap
emits its own string builder inline and calls libc, so it would be paying for
two modules nothing reads. Invisible either way - no program can tell whether a
module it never named was loaded.

A missing file is SKIPPED rather than reported. Every source_graph and codegen
test passes `""` as the std root and has no std to autoload; turning that into
an error would have made the autoload a new way for a compile to fail.

What this UNBLOCKS, said plainly for whoever picks up 3.1: `Display` is now
guaranteed to be somewhere in the graph, which was prerequisite 2 of the two
`typecheck/derive.yoop` records. It does NOT change how `Into` and `WithContext`
are matched - both are still matched by NAME plus their one argument, because
the module WRITING a `?` need never have imported either, while the module that
declared the error type certainly did.

Tests: five source_graph assertions over `bootstrap/tests/graph/autoload.std`
(three modules where the entry imports none, kinds before traits before the
entry, both recorded by base name, and an empty root autoloading nothing), plus
`bootstrap/tests/slice/task_intrinsics.yoop`, which declares a `task` and
imports no kinds at all.

---

---

## Phase 3 - the semantic features

**3.1 `@derive(display)` expansion - DONE 2026-08-13, 5 sites, 7 corpus files.**
Built exactly to the sizing above: generate the method as Yoop SOURCE TEXT,
reparse it with `parseInto`, splice it into the decl's member run, merge the
implements clause, restamp the locations. The rendering follows
src/jsyoopderive/expand.js field for field, and a slice fixture is asserted
against both compilers to keep it that way.

**The one design decision that is NOT the reference's is WHERE it runs.** There,
expansion is the first step of typechecking. Here it runs at LOAD time, right
after a file is parsed, and the reason is mechanical rather than aesthetic:
`typecheckProgram` BORROWS the graph and reads a `Module` by value, so a method
grafted there lands in a copy of the arena header and codegen never sees it. In
`addFile` the module is a `ref` and the arena is a thing to write to. Nothing
depends on the ordering - the expansion is syntactic, so there is nothing for it
to learn from a later pass - and the cost is that the four guard-rail refusals
are LOAD errors rather than accumulated diagnostics. Same wording, different
channel.

Reaching `Display` also diverges, for the same kind of reason. The reference
unshifts a synthesized `import { Display } from "std/core/traits.yoop"` onto the
module body; the bootstrap wires imports from EDGES the module graph recorded
rather than from the AST, so a synthesized import node would bind nothing. Pass
B binds the SYMBOL directly instead, at the end of the pass and only for a
module that actually derives - making `Display` resolve everywhere would be a
name appearing out of nowhere. A graph with no `Display` in it at all is refused
by name, which is the reference's own guard rail.

**One deliberate DIVERGENCE in the rendering, and it is a reference BUG.** Its
`classify` for a `Map<K, V>` field reads

    classify(annot.typeArgs[0]) === "inline" && classify(annot.typeArgs[1] === "inline")

- the second call classifies a BOOLEAN, whose answer is the truthy string
`"<unknown>"`, so the VALUE type never gates the expansion. A map whose values
are not printable therefore generates `${value}` on a type with no `toString`,
which is a diagnostic pointing into source the user never wrote. The bootstrap
checks both arguments and prints `<map>` when either fails. Strictly safer, and
a slice fixture cannot cover a map anyway - see the next paragraph.

**A finding worth carrying: the two compilers disagree about MAP ITERATION
ORDER, and the bootstrap is right.** `std/core/strings.yoop`'s `stringHash` is
FNV-1a, whose offset basis is 14695981039346656037 - above int64 max, and the JS
reference loses precision on it, so every hash it computes is wrong. Measured:
FNV-1a of "t" is 12638201494206808739, which is what the bootstrap produces; the
reference says 12637105281113482372. This is the "an integer literal above
int64 WRAPS silently" reference bug already in the follow-ups, showing up
somewhere observable for the first time. No fixture may depend on map order.

Tests: `bootstrap/tests/slice/derive_display.yoop` (both compilers - struct,
empty struct, nested derived, a hand-written Display field, an array loop, two
placeholder shapes, and a variant with payload and payload-less cases) plus
`derive_display_autoload.yoop` (bootstrap only, with a stub std, for the
Display BINDING - the reference cannot compile an interpolated template without
its own std/core/format.yoop autoloaded, and a stub cannot supply that without
dragging most of std into the test tree). Ten parse assertions on the GRAFT -
the member run, the location restamp, the implements merge in all three of its
states, a variant's cases surviving the splice, and the three refusals - and
nine typecheck assertions on what the later passes then see.

**3.2 Generic TRAIT instantiation - DONE 2026-08-13, 78 files, 5 sites.**
`Iterable<T>` in a `for ... in`. It was the critical path and the last thing
standing between the bootstrap and its own source: 74 of the 422 files stopped
on it, and 4 of the 10 self-compile diagnostics were it.

**Measured first, and it followed 2.10's precedent exactly: it needed no
instantiation.** All five sites walk a CONCRETE receiver - `fs.DirIter` and
`MapIter<string, TypeId>` - so `next` is an ordinary static trait dispatch, the
same one `Display.toString(ref p)` has been doing since before floats. The probe
that settled it was three lines: `Iterable.next(ref it)` written out by hand
already compiled and ran. So the work was the `for ... in` LOWERING and nothing
about traits at all.

What the reference actually does, read off `emitForInLoopIterableStmt` in
src/jsyoopcodegen/codegen.js and `checkForInLoop` in
src/jsyooptypecheck/checkStatement.js rather than guessed:

  - a type is walkable when it claims `Iterable` and its `next` returns a
    variant with exactly the cases `Yield` and `Done`, `Yield` carrying one
    field named `value`. The ELEMENT type is that field's - read off `next`
    rather than off the `Iterable<T>` application, which is what keeps the
    element type and the payload gep in step by construction.
  - the iterator is SPILLED to a stack slot and `next` is called on the slot
    address, because `next` takes `ref self` and there is nothing to borrow
    from a loaded value. So the walk advances a COPY of whatever the source
    named. That is immaterial for a `DirIter` (its state is behind a handle)
    and visible for a `MapIter` (its cursor is inline, so the local the loop
    was given is left at index 0). Nothing in the corpus reads one after its
    loop.
  - the loop is driven by the TAG rather than by a length: call, test against
    the `Yield` ordinal, read the payload, run the body. The step block is
    empty and still exists, because `continue` has to land somewhere that
    re-enters rather than re-running the body.

The array form is untouched - it is a counter over a descriptor and a different
lowering, which is why `codegen/loop_iter.yoop` is a separate file rather than a
branch inside `emitForIn`.

Where the machinery went: `typecheck/iterable.yoop` answers "what does one step
of this type yield, and where in the step value does it sit", and BOTH pass D
and codegen ask it. Same boundary `fallibleShapeOf` sits on for `?` - the answer
is a property of the TYPE, so codegen asking again is a lookup rather than a
second typecheck, and there is no new side table.

Tests: `bootstrap/tests/slice/for_in_iterable.yoop` (two iterators over
different element types, an already-exhausted one, `break`, `continue`, and a
nested loop whose inner iterator is rebuilt each time), with a stub
`for_in_iterable.std/core/traits.yoop` carrying the two declarations copied
shape for shape from the real one. Four typecheck assertions and three codegen
IR assertions on top.

**The earlier write-up of this item, kept because the estimate was wrong in the
same direction 2.10's was.** Applying a generic
trait now works: `applyTraitArgs` substitutes a trait's own parameters through
its method signatures and interns the result, and both a type-parameter BOUND
(`T implements Comparable<T>`) and an `implements` clause
(`type Token implements Comparable<Token>`) go through it. `substitute` reaches
trait lists through `substituteTrait`, so `Vec<string>` claims
`Iterable<string>` rather than `Iterable<T>`.

The `Into<TargetErr>` half LANDED 2026-08-13 as item 2.10, and it turned out not
to belong here: the conversion is a STATIC dispatch on a concrete receiver, so
all it needed was the applied-trait recording this item already built. Matching
the trait by NAME plus its argument is what let it skip the missing autoload.

What is left is dispatching THROUGH an applied trait as a RECEIVER rather than
as a promise: `Iterable<T>` in a `for x in` over a non-array (six std types
implement it). That needs the trait's method to be CALLED on a value whose
concrete type is not known at the call, which is a different question from
checking that a type supplies one - and it is unlike `Into`, where the receiver
IS concrete. **It is now the critical path**: 5 sites, 74 of the 422 files, and
4 of the 10 diagnostics left in the self-compile.

That last paragraph is the part that was WRONG, and it is worth leaving as
written. The receiver at every one of those five sites IS concrete; nothing
about `for ... in` needs a trait as a value. The lesson is the one 2.10 already
taught and this item ignored: **re-measure a blocked item before believing what
blocked it.** Both times the answer was "it was never blocked".

**3.3 `async`, `await`, and coroutines - DONE 2026-08-13 for the ASYNC HALF.**
The last big feature, and the only item so far that was split in two rather than
finished: `async` + `await` + the coroutine lowering landed; `task` + `wait` did
not, and is now item 3.5 below.

**MEASURED FIRST, and the measurement is what split it.** Across `std/`,
`examples/pass/` and `bootstrap/src/`: 176 `await` sites in 30 files, 39 real
`wait` EXPRESSION sites, 22 files declaring an `async` function, 29 declaring a
`task`. Then the question that decided the shape - which files need which half:

    8    files WRITE `await` and no task syntax at all: std/net/tcp,
         std/net/socket_ffi, std/http/client, std/http/router,
         std/https/client, std/tls/stream, std/core/traits,
         std/core/concurrency.
    29   files declare a `task`. All but one (std/http/server) are
         `examples/pass/` mains.

**And that first number is the trap this plan has fallen into six times, so it
is worth writing down again: it is a count of what each file SPELLS, not of what
it NEEDS.** Seven of those eight import `std/core/concurrency.yoop`, whose
`awaitTask` ends in `return wait h;` - so at CLOSURE level the whole net / tls /
http stack is gated on the task half regardless. Only `std/core/traits.yoop`
comes free. The async half moved the critical path rather than finishing files,
which is the shape every earlier item had, and the two lines it moved to are
`std/core/concurrency.yoop:174` (`wait`, item 3.5) and `std/http/client.yoop:195`
(`expr? "context"`, a 1.3 leftover).

The two halves still serve two different populations - that part held - and
`await` is the one the bootstrap's own dependency direction runs through.

**They are DIFFERENT MECHANISMS, and that is the finding worth carrying.**
`await` drives a coroutine INLINE from inside another coroutine, propagating its
suspension into the current frame - pure codegen, no runtime at all. `wait`
JOINS a handle from ORDINARY code: a task call site is a SPAWN, which needs the
task handle struct whose byte offsets the C runtime hard-codes (thunk at 0,
state at 8, refcount at 12, mutex at 16, cond at 24, coroutine handle at 32,
allocator context at 40, result at 48), a per-task thunk, and
`yoop_task_submit` / `yoop_task_wait`. They SHARE exactly one thing - a task
body is pausable, so it is a coroutine and this item's lowering emits it
correctly - and nothing else.

**The consequence, stated plainly because it is the one real cost of the split:
there is no runnable async program yet.** `main` cannot be async (the
reference's rule 4), and the coloring rules mean an async function can only be
reached from another async function - so `task` + `wait` is the ONLY bridge from
ordinary code into async, and it is refused. That is the coloring rule working
as designed, not a gap in it. (Item 3.5 built the bridge, and it is what made
this half testable end to end.)

WHAT THE REFERENCE DOES, followed rather than re-litigated - this item was
explicitly "follow the spirit of the JS reference's design". Read off
plans/async-coroutines.md and `src/jsyoopcodegen/codegen.js`, and confirmed by
compiling probe programs:

  - an `async f(a: A): T` lowers to
    `define ptr @f(A %a, ptr %__ret) presplitcoroutine`. It returns the HANDLE;
    the result goes through a slot the CALLER owns, which is what keeps it alive
    across the caller's own suspends. A `void` async function takes the slot too
    and never writes it, so there is ONE ABI rather than two.
  - NO INITIAL SUSPEND. Calling one runs it eagerly to its first real suspend
    point, so a call that never blocks costs one frame allocation and no resume.
  - `await g(args)`: allocate the result slot in OUR frame, call, then loop -
    test `coro.done`, and if the callee is not finished suspend OURSELVES,
    resuming the callee on each resume. That loop is the whole feature: it is
    what carries a suspend four frames down back up to the task body, and it is
    why the runtime holds one handle per task instead of tracking the interior
    of a call chain.
  - three COLORING rules: `await` only inside a pausable function; the operand
    must be a CALL to one; such a function must be called through `await`. Rules
    2 and 3 together are what make coloring checkable one call at a time.
  - a `task` CALL is carved OUT of rule 3 - it is a spawn, not an await. The
    reference keys that on the callee's declared return being `Task<T>`; the
    bootstrap keys it on the `provides Task` kind clause that produces that
    return, which is the same fact one step earlier.
  - `await f(x)?` needs a SWAP. The postfix `?` binds inside the operand parse,
    so what comes back is `await (f(x)?)` - propagate first, then await what is
    left - which is backwards. The reference swaps the two nodes; so does the
    bootstrap, because 15 sites in std spell it this way and it is most of
    std/http rather than an edge case.

**Where the machinery went, and the one design decision that was not the
reference's spelling.** `isAsync` rides on `Type.Func` and is part of INTERNING.
That was the fork: a per-module `pausableNames` table already existed and would
have been a smaller change. It cannot work, for two reasons found by measuring
rather than by reasoning. A call site in another module resolves a SYMBOL and
reads its Func - `std/net/tcp` awaits `ffiRecvAsync` from `std/net/socket_ffi` -
and a per-module name table cannot follow it there. And a METHOD's signature
travels inside `Type.Struct.methods`, which is a `Map<string, TypeId>` and has
nowhere for a side flag to ride; `await Readable.read(...)` is 7 sites in std.
Putting it on the type costs 33 mechanical edits and buys both, plus one thing
for free: asyncness being part of interning makes a SYNC impl of an ASYNC trait
method a different type, which is the reference's "asyncness is part of
signature equality" with no rule written anywhere.

Files, following the codegen readability rules: `typecheck/async.yoop` (the
coloring), `codegen/coro.yoop` (the frame - prologue, trailer, the return
through the slot, the declares), `codegen/instr_coro.yoop` (one function per
`llvm.coro.*` instruction, each with a sample of its output),
`codegen/await_op.yoop` (the drive loop and the suspend primitive).

**The suspend PRIMITIVE is built too, and it is what makes "actually suspends"
true rather than "would suspend if anything drove it".** `await
intr.suspendNow()` lowers to a lone non-final `coro.suspend` - no callee, no
drive loop - and everything in std that parks a task (`awaitReadable`,
`awaitWritable`, `armComplete`) is ordinary yoop written on top of that one
line. Getting there needed one parser change: an `extern "intrinsic"` signature
now takes a kind prefix, because `async function suspendNow(): void;` is how std
declares it and the extern parser demanded `function` first.

**VERIFIED END TO END, against a hand-written C driver.** The emitted IR was
linked with a 15-line C `main` that drives the top handle and nothing else:

    outer enter
    inner enter n=21
    [driver] resume 1
    inner resumed
    [driver] resume 2
    inner resumed twice
    outer got 42
    [driver] done after 2 resumes, result=43

That is the whole design working: `outer` and `inner` both run eagerly to
`inner`'s first suspend; `inner` parks; `outer` sees `!done` and parks too, so
the suspend PROPAGATES; the driver resumes only `outer`, whose drive loop
resumes `inner`; and the chain walks itself back both times. The driver pokes
the frame's resume pointer directly, which the real runtime never does - it
receives codegen-emitted trampolines instead, and those belong with 3.5.

Tests, at three levels. Ten parse assertions (`await` as a prefix at 70, the
precedence, the `?` swap in both directions, the `wait` refusal, kind prefixes
on an extern signature). Nine typecheck assertions (all three coloring rules,
the nested-argument case that proves the `await` handoff is one step rather than
a mode, the task-spawn carve-out, and trait/impl asyncness in both directions).
Fourteen codegen IR assertions (the ABI line, the frame, allocas landing after
`coro.begin`, the return through `%__ret`, the trailer, one set of declares for
two coroutines, an ordinary function beside one staying ordinary, the call
shape, the drive loop, the propagating non-final suspend, load-before-destroy,
the bare suspend, and the task refusal). Plus a slice fixture,
`async_coroutine.yoop`, which asserts what a slice fixture CAN assert here:
that a module full of coroutines links, runs, and leaves the ordinary code
beside them alone. Its header says plainly that it does not assert suspension
and why.

Two DIVERGENCES, both supersets:

  - an `extern "intrinsic"` signature takes ANY pausable kind prefix here; the
    reference accepts only the literal word `async` there. That is why the slice
    fixture declares its own `resumable` kind and leaves the suspend primitive
    to the unit tests - a fixture asserted against both compilers has to stay
    inside the intersection.
  - a sync impl of an async trait method is refused, and the bootstrap checks
    ONLY that clause of signature equality rather than the whole signature
    (comparing the rest is a gap it already had). It cannot be left out: the two
    spellings lower to different calling conventions, so getting it wrong is a
    call through a mismatched signature - a crash, not a diagnostic.

Refused BY NAME, each because emitting it would compile and then be wrong:
`task` decls and methods (codegen, naming the spawn machinery), `wait h` (the
parser, naming the same), and an INDIRECT async call through a function value or
a vtable slot. The first two of those were replaced by item 3.5 below; a `task`
METHOD and the indirect call are still refused.

**3.4 Building a vtable VALUE - the erasure machinery. DONE 2026-08-13, 14
sites, 23 files.** `Reader.from(ref s)`, `PredVT.fromFn(f0, f1)`, and
`Reader.read(ref r, buf)`. The largest item the plan had left, and the critical
path: the whole of `std/http` and `std/https` sat behind one line of
`std/http/client.yoop`.

**Built to the sizing, and the sizing was right.** The three things it named all
had to move, and nothing else did:

  - **the LAYOUT gained a ctx slot.** A vtable value is `{ ptr ctx, ptr m0,
    ... }` - the erased receiver, then one function pointer per slot. That
    leading pointer is the whole trick: a method already takes `ptr self` first,
    so the CONCRETE method symbol is directly usable as the erased one and
    `from` emits no thunk at all. Dispatch loads ctx out of slot 0 and passes it
    where `self` goes.
  - **`Type.VTable` is used.** It was declared and never constructed; a vtable
    registered as an ordinary `Type.Struct`, so nothing recorded which trait it
    erased or in what order. Pass A registers the VTable shell now and pass C
    fills it with the trait, the slot types and the slot ORDER.
  - **the INDIRECT path exists**, beside the static one. Every corpus site
    spells it `VTableName.method(ref vt, ...)` rather than
    `Trait.method(ref vt, ...)`, so the dispatch forks in `checkQualifiedCall`
    alongside the trait and namespace cases rather than inside `checkTraitCall`.

What the sizing did NOT have, and it is the half that mattered most: **the
ASYNC dispatch.** `Readable.read` and `Handler.handle` are both `async`, so
every real use in std is `await Reader.read(ref r, ref buf)` - an indirect call
to a coroutine. Building only the sync half would have finished zero files.
It cost less than it looks: the drive loop is unchanged, and `emitAsyncCall`
takes the same two slot loads and swaps `emitCall` for `emitCallIndirect`.

Asyncness rides on the SLOT, stamped from the trait in pass C. A `=>`
annotation is never written `async` - the reference has the same rule and states
it for vtables - so the trait has to be the authority or the two sides drift
into a call through a mismatched calling convention.

**One DIVERGENCE, and it is unobservable.** The slot ORDER is the vtable's own
declaration order; the reference uses the TRAIT's, which it can do because a JS
Map iterates in insertion order. The bootstrap's `Map` is a hash table with no
order to read, and the vtable's AST is the one place an order is written down
that both the builder and the dispatch can agree on. A vtable value never leaves
the program that built it, so two compilers laying one out differently is not
something a program can tell - and every corpus vtable declares its slots in
trait order anyway.

Refused BY NAME, and each at the DECLARATION rather than at a use, because a
wrong slot is a call through a mismatched signature rather than anything a
verifier catches: a missing slot, a slot the trait does not declare, a wrong
parameter count (the trait's minus `ref self`, so it is off by one on purpose),
and a wrong return type. At the USE: a by-value receiver (`VT.from(x)` - the
vtable stores an ADDRESS, so the receiver has to outlive it), a receiver whose
type does not implement the trait, a receiver missing a method some slot needs
a pointer to, a member that is not a slot, the wrong dispatch arity, and a
`fromFn` argument that is not a named function.

Where the machinery went, following the codegen readability rules:
`typecheck/vtable.yoop` (the queries every shape asks - which trait, which slot,
how many), `typecheck/vtable_use.yoop` (the three checks),
`codegen/vtable.yoop` (`from` and `fromFn`), `codegen/vtable_call.yoop` (the two
slot loads and the sync call), `codegen/instr_vtable.yoop` (the `fromFn` shim
and its dedupe). The async call is in `await_op.yoop`, beside the drive loop it
feeds; separating the slot load from the call shape would have put half a call
in each file.

**The critical path moved rather than ended, for the eighth time**, and the
distance was fifteen lines. With the erasure built, all 23 files landed on
`std/http/router.yoop:121` -
`await Dispatcher.handle(ref entries[i].dispatcher, ...)` - which is
`ref xs[i].y`, a field path bottoming out in an array ELEMENT. That had been
refused by name since 1.0 on the reading that "an element address is a different
gep and the field walk does not build one". True, and the different gep already
existed: `emitElementAddress` has been there since arrays landed. One extra
branch in `emitFieldAddress`, one extra kind in each of the two pass-D
predicates, and reading and writing both work. Fixed rather than deferred
because it blocked the item in front of it.

Tests: `bootstrap/tests/slice/vtable.yoop` (both compilers - three concrete
types behind one `Dispatcher[]`, a dispatch through the array and through a
local, a WRITE through the original observed via the erased view, `fromFn` over
two slots, and a second `fromFn` on the same functions to pin the shim dedupe).
Six codegen IR assertions on the layout, the two stores, the absence of a thunk,
the indirect call, the null ctx and the one-shim rule. Twelve typecheck
assertions on the three uses and the four declaration checks. Plus the element
path in `ref_fields.yoop` and its two typecheck assertions.

**3.5 The TASK half - `task`, `wait`, and the spawn. DONE 2026-08-13.** Split
out of 3.3, sized there, and built exactly to that sizing - all six pieces, in
the order they were written down, with no step turning out to be bigger or
smaller than it looked. That is the first time in this plan that has happened,
and the reason is worth naming: 3.3 measured the two mechanisms apart before
either was built, so this item started from a design rather than from a guess.

**What it makes true, and it is the headline: there is a runnable async program
now.** Before this, `main` could not be async and a coroutine was reachable only
through `await`, so nothing in the corpus could get one to run at all - the
async half moved the critical path without finishing a single file. `wait` is
the bridge, and with it a coroutine parks, the scheduler resumes it, and the
answer comes back correct end to end.

The six pieces, as built:

  1. **`Task<T>` at the call site.** Wrapped in `checkCall`, right where 3.3's
     spawn carve-out already looks the callee up in `prog.taskSymbols`. The
     reference stores an EXTERNAL return type on the signature beside the
     declared one; the bootstrap wraps one step later instead, because pass D
     checks a body against that same signature and codegen reads its `ret` for
     the `%__ret` slot - so storing `Task<T>` there would mean unwrapping it in
     both. `Task<T>` is also spellable in an annotation now, as a BUILTIN
     generic name like `unsafe_ptr<T>`.
  2. **The handle STRUCT, per task FUNCTION** (not per result type - the args
     ride in the handle, so two tasks returning `int32` with different
     parameters are two layouts). `%Task_<mod>__<fn> = type { ptr, i8,
     [3 x i8], i32, ptr, ptr, ptr, ptr, T, args... }`, emitted by a pre-pass
     over the graph so it is above every body and so `main` can be told whether
     the program has anything to schedule. The byte offsets are pinned in
     `codegen.test.yoop`, which is the only check available: the C side reads
     them through `(char*)h + 16` and would happily read the wrong one.
  3. **The per-task THUNK**, emitted straight after the body it adapts. Loads
     the args out of the handle, hands the body the handle's OWN result slot as
     its `__ret`, stashes the returned coroutine handle at field 6, calls
     `yoop_task_settle`. It STARTS the coroutine and returns rather than
     driving it, which is what lets a parked task give its worker back.
  4. **The coroutine TRAMPOLINES**, emitted once per program with external
     linkage, and `yoop_runtime_set_coro_ops` in `main` right after
     `yoop_runtime_init`.
  5. **The BINDING kinds**, decided by CLAUSES rather than names: `refcounted`
     means pooled (heap, `yoop_task_alloc`, released at scope end), `mustCall`
     means joined (alloca, joined at scope end), and an annotated binding with
     no prefix is the IMMEDIATE form (spawn and join in one statement, binding
     the result). Keying on clauses is not a stylistic choice - a `Task<T>` has
     no methods for `mustCall join` to name, so the compiler is the only thing
     that can honor either clause, which is exactly what makes the mapping
     unambiguous. The scope-end obligation rides on the same DisposeStack an
     ordinary `disposable` uses, so `return`, `break` and `continue` unwind it
     with no new machinery.
  6. **`wait h`** - `yoop_task_wait` then a load from BYTE 48, always, never
     through the typed gep. The reference has both paths and falls back to this
     one; the bootstrap has only it, because the prefix layout is universal and
     a `wait` may be handed a handle whose originating task function the site
     cannot name.

**Two DIVERGENCES, both deliberate.** The scheduler prologue in `main` is
emitted only for a program that HAS a task, where the reference emits it
unconditionally - the bootstrap already links the runtime's C sources on demand,
and making every hello-world compile fourteen C files to install an unused
worker pool is a real cost for no observable difference. And a `wait` folds into
a binary expression here (`wait a + wait b`) where the reference returns from
the prefix immediately; the bootstrap's `ref x` has had that shape all along, it
is a superset either way, and the one place it bites is a slice fixture, which
has to stay inside the intersection.

Refused BY NAME, each because emitting it would compile and then be wrong: a
CROSS-MODULE spawn (the handle layout and thunk belong to the declaring module -
the reference refuses it in the same place), a task call outside a handle
binding (`worker(1);` on its own would run the body on this thread), copying a
handle into a second binding (`pooled b = a;` needs a refcount retain, and one
without it is a use-after-free rather than a leak), `wait` inside a task body
(it would block a worker, which is the thing coroutines exist to avoid - the
reference's rule, and `async` alone is not enough to refuse on, since std's
`awaitTask` is async and ends in one), a `task` METHOD, `task main`, and a task
returning void (the result slot would have no LLVM spelling).

Not in this item, and each still refused by name: `waitUntil`, `cancel`,
`armComplete`, `isDone`, `pooled` as a PARAMETER or FIELD, and
`propagates<pooled>`.

**One BUG found and deliberately not fixed**, per the rule about not fixing
every bug you find: a runtime race between releasing a waiter and the worker
finishing its bookkeeping on the same handle. It is in `yoop_runtime.c`, it
predates this item, and the JS reference reproduces it at the same rate on the
same program - so it is not something the lowering does differently. Written up
in the follow-ups list below with its backtrace and how to reproduce it.

Tests at three levels. Six parse assertions (the node kind, the precedence, and
that there is NO `?` swap, unlike `await`). Fifteen typecheck assertions (the
call is a handle and the body is not, all three binding forms, the copy
refusal, `wait` on a non-handle, `wait` in a task body versus in a plain async
function, `task main`, a void task, and `Task<T>` as an annotation). Eleven
codegen IR assertions, of which the handle layout is the one nothing else in the
tree could catch. Plus the slice fixture below.

**`bootstrap/tests/slice/task_spawn.yoop` is the fixture 3.3 could not write.**
Six tasks in flight at once across the machine's worker threads, and every
number in its `.expected` would be WRONG rather than merely late if a piece were
missing: a task that never ran leaves its result slot zero, a `wait` that
returned early reads it before the worker wrote it, and `twoSteps` comes back 40
instead of 42 if the scheduler cannot resume a suspended coroutine, because both
`+ 1`s happen after the parks. The assertion is order-INDEPENDENT by
construction - nothing prints from inside a task body, `main` prints joined
results and a sum - so it says the same thing on one core and on thirty-two.

**And `async_coroutine.yoop` was strengthened, which was the other half of the
brief.** Its header used to say it could not assert that a coroutine suspends
and resumes because there was no way to reach one from `main`. It now spawns two
tasks that await the coroutines it declares, so composition, a loop around an
await, an early return and the void ABI are each checked by their RESULT rather
than by the IR alone. Genuine parking stays in `task_spawn.yoop`, because the
suspend primitive needs an `extern "intrinsic"` signature and a wakeup arranged
through the runtime.

**The new CRITICAL PATH is `std/core/concurrency.yoop:32`, and it is this item's
own out-of-scope list.** All 19 `wait` sites are gone and all 29 files that were
gated on one moved; where they moved to is the honest measure:

    21   `std/core/concurrency.yoop:32` - the `waitUntil` intrinsic, and with it
         `cancel`, `armComplete` and `isDone`. Named in the sizing as not in
         this item, and now the single line the whole net / tls / http stack
         stops at.
    10   `std/http/client.yoop:195` - `expr? "context"`, a 1.3 leftover
     5   `unknown kind "task"` / `"async"` - std AUTOLOADS. Those files never
         import `std/core/kinds.yoop` because the reference gives it to every
         module for free, so a kind PREFIX resolves to nothing here. Not a
         concurrency gap at all.
     2   compile all the way to an executable now:
         `examples/pass/ref_forwarding.yoop` and
         `examples/pass/runtime_introspect.yoop`

The first of those two is worth naming, because it is an independent check of
this whole item: it spawns a task taking a `ref Counter`, bumps it ten times on
a worker, joins, and prints `viaTask=14`. That number is in a comment at the
bottom of the file, written years before any of this, and the bootstrap now
produces it.

**3.6 The four `Task<T>` intrinsics - DONE 2026-08-13, 1 site, 21 files.**
`waitUntil`, `cancel`, `armComplete` and `isDone`, declared in
`std/core/concurrency.yoop` and refused there by pass A as unknown intrinsics.
ONE line, and the whole net / tls / http stack imports the file it is in - the
critical path by a wide margin after 3.5.

The refusal was right and the fix was never to widen it: the intrinsic list and
codegen's dispatch are two halves of one table, and a name in the first with no
lowering in the second typechecks and then fails much later with nothing to say.
So this item is four lowerings.

**TYPECHECK NEEDED NO SPECIAL CASE AT ALL, and that is the finding worth
carrying forward.** The reference has a hand-written resolver per intrinsic -
`resolveWaitUntilCall`, `resolveCancelCall`, `resolveArmCompleteCall`,
`resolveIsDoneCall`, about 150 lines between them, each re-deriving the arity,
the `Task<T>` test and the result type. The bootstrap needed none of it: the
declared signatures

    function waitUntil<T>(h: Task<T>, deadline_ns: uint64): WaitResult<T>;
    function cancel<T>(h: Task<T>): void;
    function armComplete<T>(h: Task<T>): c_int;
    function isDone<T>(h: Task<T>): c_int;

go through the same generic-intrinsic path `heapAlloc<T>` uses, so `T` is
inferred from the handle, arity and argument types are checked by the ordinary
call checker, and `WaitResult<T>` instantiates like any other generic variant.

ONE thing was missing and it is general rather than about these four:
`inferTypeArgs` had a case for `T[]` and for `ref T` and none for `Task<T>`.
`Task` is a builtin generic NAME rather than a declared one, so it has no origin
for the applied-instance case to match on and needs its own line, exactly as the
other two do. Six lines, and it is the whole typecheck half of this item.

Three of the four lowerings are a call and nothing else. `waitUntil` is the one
with shape: the runtime answers with an i32 - 0 done, 1 timed out, 2 cancelled -
and the language hands back a three-case variant, so the lowering is a jump table
over the outcome with one arm per case and only the `Done` arm reading the task's
result. Out of BYTE 48 of the handle, always, exactly as `wait` reads it: the
prefix layout is universal and this site can no more name the task function the
handle came from than a `wait` can.

The DEFAULT arm lands on `Cancelled` rather than on an unreachable block, which
is the reference's choice and its reason: the runtime's outcome is an int it may
one day widen, and reading an unknown one as "this task is not going to produce a
value" is the safe reading of any extension.

The four `declare` lines ride on their OWN emitter flag rather than on
`hasTasks`. The two are different questions: a module that only ever holds a
handle somebody else spawned still polls and cancels it, and
`std/core/concurrency.yoop`'s `awaitTask` is exactly that module.

ONE LATENT BUG had to be fixed because the fix EXPOSED it, and it is a
miscompile class rather than a missing feature. `Program.intrinsics` is keyed by
NAME and graph-wide, so `isIntrinsicCall` answered yes for any call spelling one
- and `std/tls/ffi.yoop` exports an ordinary `ctxFree(ref c: TlsCtx)` beside the
allocator's `ctxFree<T>(a: T[])`. Its own calls were lowered as the intrinsic,
emitting an `extractvalue` on a struct pointer. Invalid IR here, which is loud;
a silent wrong answer wherever the two shapes happened to line up, which is not.
Those two files were refused at the `waitUntil` line before this item, so
nothing had ever reached it. The rule now matches the reference's - an intrinsic
is in scope where it was DECLARED or reached through a NAMESPACE, judged per
module - and a module reaching one any other way and calling it unqualified gets
a link error rather than a wrong answer.

Tests: `bootstrap/tests/slice/task_intrinsics.yoop` with a hand-written
`.expected` (a bounded wait that completes, one that times out, `isDone` after a
join, `armComplete` off a worker, and a cancel observed by a later `waitUntil`),
five codegen assertions pinning the four runtime SYMBOL names and their argument
types (a contract with C that nothing else in the tree would notice being
wrong), a codegen assertion that a task program calling none of them declares
none of them, and two more over `bootstrap/tests/codegen/intrinsic_shadow.yoop`
for the shadowing fix.

**3.7 The other two `?` surfaces - DONE 2026-08-13, 5 sites, 14 files.**
`expr? "context"` and `expr? e { ... }`, both refused BY NAME by the parser
since 1.3. Neither needed new machinery: `?` itself is 1.3 and the `Into`
conversion is 2.10, and both of these extend the failure branch those built.

WHAT THE REFERENCE DOES with the context form, established by compiling probe
programs rather than by reading its source. The note is PREFIXED, not appended
and not wrapping, and the separator is `": "`:

  - both Err payloads `string`: the compiler concatenates `"<context>: <err>"`
    itself. Every `Result<T, string>` in std is this one.
  - anything else: the operand's Err type must promise
    `WithContext<TargetErr>`, and the failure branch calls
    `withContext(ref err, context)`. That ONE call also does the CONVERSION, so
    a `?` between two different Err types needs no separate `Into` when a
    context is written - which is why the context clause SUBSUMES `tryConvert`
    rather than composing with it.
  - contexts STACK outward: an outer `?` prefixes an already-prefixed string.
  - the context expression is evaluated in the FAILURE BRANCH and nowhere else,
    so an interpolated one (`f()? \`field ${expensive()}\``) costs the success
    path nothing at all. The slice fixture asserts that as an output LINE rather
    than as a claim: its context calls a function that prints.
  - only the two LITERAL token forms may follow the `?`, which is deliberate on
    the reference's side and copied here: a general expression would make
    `f()? -x` ambiguous with a subtraction, while a string can never continue an
    expression, so this stays a zero-lookahead decision.

And the handler form:

  - `e` names the Err payload for the block's extent, as a const.
  - the enclosing function need NOT return a fallible variant. That is the whole
    point of the form: it works in `main`, or in anything returning a plain
    value, where bare `?` is refused outright.
  - the block must LEAVE on every path. It runs INSTEAD of producing a value, so
    falling out of the bottom would leave the binding it feeds holding nothing
    and the Ok payload read after it would read an Err.
  - `break` and `continue` count as leaving, which is what makes a handler
    usable to skip a loop iteration.
  - the binding is REQUIRED. A bare `? { ... }` would be indistinguishable from
    a `for x in items()? { ... }` body.
  - pending disposals are deliberately NOT fired around the block: whichever
    terminator it uses fires the ones appropriate to ITS exit, and firing them
    here as well would be a double free.

`typecheck/diverge.yoop` is the "does control flow always leave this statement"
answer, written for the handler form and deliberately CONSERVATIVE: return,
break, continue, a block where any statement diverges, an if/else where both
halves do, and a switch where every arm does. Anything else answers false. The
asymmetry is the point - a false negative costs the user an explicit `return`
and a diagnostic that says so, while a false positive would let codegen fall
through into the Ok path with no value in hand. It is asked AFTER the block is
checked, which is what lets the switch case be one line: pass D has already
refused a switch that is neither exhaustive nor defaulted.

Both forms hang off the same TRY_OP node - the context in `childB`, the handler
block in `childC` with its binding in `name` - so a reader of the arena can see
which form was written without consulting a side table.

ONE file did NOT finish, and its blocker is unrelated:
`examples/pass/qmark_handler_block.yoop` proves divergence through
`switch (e.len > 0) { case true: ... }`, and a switch over a BOOL does not parse
here ("expected INTLITERAL, got TRUE"). Written up in the follow-ups; the slice
fixture uses an if/else for the same property.

Tests: `bootstrap/tests/slice/qmark_context.yoop` and
`bootstrap/tests/slice/qmark_handler.yoop`, both with hand-written `.expected`
files asserting the resulting TEXT (`"loading config: reading count: negative
input"` is the stacked case), four parse assertions over the two node slots, six
typecheck assertions on the context form and seven on the handler.

---

---

## Phase 4 - parity and the self-compile milestone

**4.1 The layer-2 AST parity dump.** Still open, and still the right shape: the
two ASTs differ (NODE_LIST wrappers and annotation nodes here, plain arrays and
annotation objects in JS), so a normalized tree format has to come before the
two parsers can be diffed. Worth doing once the parser stops changing shape
every week, which is roughly after phase 1.

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

**4.5 `yoopiler --test` in the bootstrap driver - OPEN, sized.** Found by 4.3,
which is what makes it an item rather than a guess: the flag is refused by name
(`unknown option --test`) and the bootstrap has no test mode at all.

**Everything BELOW the driver already works**, and that was measured rather than
assumed. Writing out by hand the entry module the reference GENERATES, and
compiling it with each compiler, produces byte-identical TAP output and the same
exit code on both `examples/testing/pass` (`3 passed, 0 failed`, exit 0) and
`examples/testing/fail` (`1 passed, 2 failed`, exit 2 - the exit code IS the
failure count). So the `suite` kind, the `test` binding that owns a block,
`mustCall recordOutcome beforeScopeEnd`, the `(() => void)[]` table and
`std/test.yoop` itself are all complete here.

What is missing is five pieces of DRIVER, all of them in
`src/jsyoopdriver/test_mode.js` (205 lines) and its wiring in `src/yoopiler.js`:

  - **discovery** - glob `**/*.test.yoop` under a path, sorted so a run is
    reproducible, skipping dot-directories and `node_modules`. Also the
    single-file shorthand, where `yoopiler foo.test.yoop` with no flag enters
    test mode because the file declares `import.test;`
  - **syntactic collection** - parse each file and take every kind-prefixed
    top-level function. It has to be syntactic: resolving `enumerable as`
    needs typecheck, typecheck needs the entry module, and the entry module
    needs the collected names, so the cycle is broken here and the wrong kind
    is rejected after typecheck instead
  - **entry synthesis** - generate a module SOURCE holding
    `const fns: (() => void)[] = [...]`, a parallel `string[]` of labels, and
    `return harness.runAll(fns, names)`
  - **a `readFile` OVERLAY on the module graph**, so that generated source can
    be a module without ever being written to disk. This is the piece with no
    equivalent in the bootstrap today: `source_graph/load.yoop` reads every
    file from the filesystem, and it needs a "this path answers from memory"
    hook. The reference already has one, for the LSP's unsaved buffers
  - **the `export` wrapper** - a suite is written `suite function foo()` with
    no `export`, and the generated entry imports it by name, so the driver adds
    the wrapper to the AST between the graph load and typecheck. That is an AST
    MUTATION after parse, which the bootstrap does elsewhere (the derive
    expansion) but not at this point in the pipeline

Roughly 250 to 350 lines of Yoop across two or three files under a new
`src/test_mode/`, plus the overlay hook in `source_graph`. It is the last thing
the reference driver does that the bootstrap cannot, so it is on the critical
path to retiring `src/`.

---

## Phase 5 - the long tail

By the time phase 4 closed there was no critical path left worth the name: the
biggest remaining group was four files and most were one or two. What follows is
that tail, cleared cheapest-first over one pass on 2026-08-13. Every one of them
is small; what they have in common is that each was the LAST thing between some
corpus file and an executable, so the "done" count and the site count moved
together for the first time since 3.1.

**5.1 Shadowing in a nested block - DONE, 2 files.** `let v = 7; if (c) { let v
= 99; } total += v;` was "v is already declared in this function". The scope
stack refused any name it could SEE, which conflated two questions: a nested
block declaring a name is an ordinary new binding, and the SAME block declaring
one twice is a scope contradicting itself. The declare test now reads the TOP
block only; the lookup still walks the whole stack, and the reference agrees on
both halves (a redeclaration beside itself is still "redeclaration of v").

Codegen owed the other half, and it was the part that could have been a silent
wrong answer rather than a diagnostic: the inner binding gets its own alloca
either way, so a compiler that forgets to put the OUTER name back still emits
valid IR and simply reads the inner slot forever after. `localsPopBlock` now
restores what each name meant on the way in instead of removing it. The two
`for` heads also open a locals block of their own, because a counter is scoped
to its loop and there is no block around the head to do it.

One DIVERGENCE, and it is a reference bug: shadowing with a DIFFERENT TYPE
(`let x: int32 = 5; if (c) { let x: string = "s"; } return x;`) makes the
reference emit `ret i32 %t4` on a `ptr` - it restores the name and not the type.
The bootstrap gets it right, and `shadowing.yoop` says so in a comment rather
than asserting it, since a slice fixture has to stay inside the intersection.

**5.2 Shorthand pattern fields - DONE, 2 files.** `case Shape.Circle { radius }:`
is `{ radius: radius }`. A pattern is the one place the second half can be read
off the punctuation with no ambiguity - what follows a field name is a `:` or it
is the end of that field - and the two spellings land in the arena identically,
so nothing downstream knows which was written. Ten lines.

**5.3 `switch` over a BOOL - DONE, 2 files.** `case true:` / `case false:`.
Exhaustiveness is the whole reason a bool is its own scrutinee kind rather than
a one-bit integer: two values means `true` beside `false` covers everything, so
the default arm becomes optional and the jump table's default block becomes
`unreachable`. That is the variant rule rather than the integer one, and it is
the only non-variant switch that has it.

What the reference does, established by probing: not exhaustive is refused by
name ("switch over bool is not exhaustive - add 'default' or list both true and
false"); a default BESIDE both cases is allowed, unlike a variant switch; a
duplicate `case true` is refused; and the two spellings do not mix in either
direction - `case 1:` against a bool and `case true:` against an int32 are both
refused, even though `true` and `1` land on the same table value. All five are
matched word for word.

The pattern node records which TOKEN it was written as in its `operator` slot,
which nothing else on a LITERAL_PATTERN uses. The value alone cannot tell `1`
from `true`, and that is exactly what the two refusals need to know.

**5.4 `type FILE;` in an extern block, and the RE-BORROW behind it - DONE, 2
files.** An OPAQUE type: a struct with an EMPTY field list, which is what the
reference makes of it and is not a placeholder - a type with no fields is
precisely a type nothing can read a field out of.

The item behind it was the interesting one. `fopen` returns `ref FILE`, so the
local holding it is ALREADY a borrow, and `fclose(ref fp)` is `ref` on something
that is one. That used to be `ref ref FILE`, which is not a type. It is a
RE-borrow: pass D hands back the operand's own type unchanged, and codegen loads
the slot (which holds the borrowed address) instead of taking the slot's
address. Confirmed against the reference, which accepts `ref r` and a bare `r`
into the same `ref P` parameter and writes through to the same object either
way. A `ref` PARAMETER does not come here, because the body already sees its
type unwrapped to `T`.

**5.5 Compound assignment on an ELEMENT - DONE, 2 files.** `xs[1] += 100` and
`w.sectors[i].ceiling += 2`. The compound forms desugar to `target = target <op>
value`, which names the target TWICE, so the rule is about what is free to read
twice rather than about what is assignable: a name, a path of fields reaching
one, and now an element whose SUBSCRIPT is itself a name or an integer literal.

A NARROWER rule than the reference's, deliberately: it keeps a dedicated
COMPOUND_ASSIGNMENT node and addresses the lvalue once, so it admits any
subscript. `xs[g()] += 1` therefore stays refused BY NAME here, which is the
safe direction - a program the bootstrap accepts means the same thing on both
sides. Every subscript in the corpus is a literal or a name.

**5.6 `export "C" function` - DONE, 4 files.** A definition emitted under its
bare C name. It asks the mangler the same question an `extern "C"` does, from
the opposite direction - "this symbol is defined HERE under exactly this
spelling" - so it gets the same answer: the name goes in the module's
`externNames`, and both the definition and every call from that module land
unmangled. `externNames` is per MODULE, so a SIBLING file of a directory module
reaches it, which is what `extern_sibling_call` is about.

The wrapper gets its own node kind (`EXPORT_C_FUNCTION_DECL`, already in the
lockstep list) rather than a flag, because that is what tells pass A to record
the name. `export "intrinsic" function` is refused by name - an intrinsic has no
body for `export` to do anything with.

NOT built, and it is not a bootstrap gap: a cross-module call to a C-exported
function. The reference emits the MANGLED name there and fails to link
(`use of undefined value '@lib_64c31bc6__add_one'`), established by probing, so
there is nothing to be compatible with. Written up in the follow-ups.

**5.7 The four `unsafe_ptr` operations, and pointer ARITHMETIC - DONE, 3
files.** `cast<T>(p)`, `toInt(p)`, `fromInt<T>(n)`, `toArray<T>(p, n)`.
`unsafe_ptr` is a TYPE NAME rather than a namespace, so the whole form is
recognized by TEXT - there is nothing to resolve the left side against - and an
`unsafe_ptr` followed by any other member falls back to an ordinary identifier.
Same place and same reason as the reference.

Three of the four cost between zero and one instruction, because LLVM's pointers
are OPAQUE: `cast` is a change of TYPE and pass D already made it. `toArray` is
the one with substance, and it builds the same `{ ptr, i64 }` descriptor a slice
does - so what comes out is an ordinary `T[]` and indexing, `.len` and `.ptr`
all work with nothing new behind them. `uintptr` joins the LP64 alias list
beside `c_size_t`.

Pointer arithmetic came with them, because `unsafe_ptr_arithmetic.yoop` needs
both. C's rules, which are the reference's: `p + n` steps by ELEMENTS (which is
what `getelementptr` already means, so there is no size to compute), `p - q` is
the element COUNT (which does need the size, so it is a ptrtoint pair, a sub and
an sdiv), and the OPAQUE pointer is refused throughout - it has no element width
and "advance by 2" has no answer. The right operand of a `p + n` gets NO
expectation, which is the one thing that needed care: handing it the pointer
type pins the literal to a pointer and reports a mismatch about a line that is
perfectly well formed.

**5.8 `a..b` ranges - DONE, 2 files.** SUGAR, not a loop form: `a..b` lowers to
`$range.exclusive(a, b)` from std/core/range.yoop, so `Range` stays an ordinary
userland type implementing `Iterable<usize>` and neither the typechecker nor
codegen learns a rule. Same design as the reference's
`src/jsyoopdriver/lower_range.js`, moved INTO the parser here because the
bootstrap's arena is built as it parses - there is no second walk that could
rewrite a node in place afterwards.

Three pieces, and each was needed:

  - the CALL, built directly, so no range node ever reaches the arena
  - a synthesized `import * as $range from "std/core/range.yoop";`, PREPENDED to
    the file's decl run. Every consumer reads the leading run of IMPORT_DECLs and
    stops at the first other declaration, so an appended one would be silently
    ignored. Only a file that wrote a range gets it
  - `..` at precedence 15, looser than every arithmetic operator, AND a slice's
    bounds parsed AT that precedence. That second half is what keeps `xs[a..b]`
    a slice rather than an index by a Range

Plus the hazard the reference names `inForInIterExpr`: the iterable of a
`for x in ... {` runs right up to the body's brace, so a trailing `a.b` path
would swallow it as a variant PAYLOAD - `for i in 0..xs.len {` reads
`xs.len { ... }` as `Enum.Case { ... }`. Inside the RHS a `{` only opens a
payload when it LOOKS like one (`{ <name> :`), which no block can be.

**5.9 The IMPLICIT region form - DONE, 1 file.** `ephemeral makeGuard(1);` with
no braces. What it owns is the rest of the ENCLOSING scope rather than a block of
its own, so it opens no dispose scope and records into the one already open -
which is what makes two of them in a row unwind in reverse, exactly like two
`disposable` bindings. Fifteen lines across parse, pass D and codegen.

**5.10 `Trait.method(ref vt, ...)` with a vtable receiver - DONE, 1 file.** The
second spelling of a slot dispatch, and the one a caller writes when it never
learns which vtable it was handed - `await Readable.read(ref r, ref buf)` where
`r: Reader`. It used to be refused as a non-struct receiver. Now the static
trait path checks whether the receiver is a vtable erasing THIS trait and routes
to the same checker `Reader.read(...)` goes to, so codegen needs nothing new -
the slot index lands in the same side table either way.

**5.11 Composed kinds actually COMPOSE - DONE, 1 file, and one silent
miscompile.** `kind scoped_alt = disposable_base & { mustNotEscape scope; };`
did not parse, because the composition scan stopped at the first `;` and the
inline body has one inside it. That was the reported blocker.

The real finding was underneath: a composition's operands were consumed and
recorded NOTHING, so `scoped_alt h: Vec3 = ...` compiled to no scope-end call at
all. `examples/pass/layout_compose/main.yoop` was reporting `ok` in the probe
and silently dropping its `bye vec4` - a promise deleted rather than refused,
which is the exact failure the "refuse by name" rule exists to prevent, and
which no probe category can see.

Both operand shapes now land in the same childIds run a braced kind uses: a NAME
becomes a `compose` clause carrying it, and an inline `{ ... }` body's clauses
are pushed straight in (an anonymous bag of clauses IS a clause list, so there
is nothing to name and nothing to look up). Pass A merges each named operand's
already-registered KindInfo - booleans OR in, `disposeMethod` takes the first
that names one - and an operand nothing declares is refused BY NAME.

**5.12 `==` on two VARIANTS - DONE, 1 file, and the last bad-ir in the corpus.**
`enum_eq.yoop` had been the entire `bad-ir` bucket since phase 2: the compare
was emitted as an `icmp` on the aggregate, which is INVALID IR rather than a
wrong answer, so the compile succeeded and clang refused what it produced. A
variant comparison is a TAG comparison - two `Circle`s with different radii are
equal, and a structural comparison is what `switch` is for - which is the
documented semantics and the reference's. Twelve lines, and the probe's bad-ir
count is now zero.

### Re-probed after the whole of phase 5

The corpus is now 453 files - five additions, all of them these items'
(`parse/range.yoop`, `parse/unsafe_ptr.yoop`, `typecheck/unsafe_ptr_ops.yoop`,
`codegen/unsafe_ptr_ops.yoop`, `codegen/instr_ptr.yoop`):

    222   compile all the way to an executable
    205   reach clang and fail ONLY for having no `main`, so 427 files are done
    0     reach clang and produce invalid IR - the bad-ir bucket is EMPTY for
          the first time in the plan's history
    26    stop earlier, at a named parse or typecheck refusal

22 distinct refusal sites, down from 42, and 27 more files are done. Unlike most
passes the two counts moved TOGETHER throughout, which is what a tail looks like
from the inside: nothing here gated anything else, so every item that closed
finished the files behind it immediately.

**The same probe run with STAGE 3 produces a byte-identical report**, and stage2
and stage3 are byte-identical as binaries and as emitted `.ll`. The whole slice
suite runs through stage3 too.

The remaining refusal distribution, as DISTINCT SITES - 22 of them, and
SEVENTEEN are deliberate:

    13     `@precompile` (out of scope by design). 13 files
    3      module const/let needing comptime (out of scope). 5 files
    2      `union` decls (refused by name, sized below). 4 files
    1      `pooled` FIELDS and `propagates<pooled>` (refused by name). 1 file
    2      module-level `let` with a non-literal initializer. 2 files
    1      reserved words as NAMES in name-only positions. 1 file

The last two rows are the only OPEN work left in the corpus, plus `union`. Both
of the remaining `union` files also want something else - `union_rgba.yoop` wants
nothing more, and `keyword_field_names.yoop` wants reserved-word names as well.

### 5.13 `union` - OPEN, sized, 4 files, 2 sites

Left refused BY NAME rather than half-built, which is the rule this plan states
for exactly this shape. It is the one remaining item that is real machinery
rather than a tail item, and the sizing is now concrete rather than a guess.

What it needs, established by reading the reference's implementation:

  - a LAYOUT of its own: every field at offset 0, size the largest field's,
    alignment the largest field's. `sizeOfType` grows a case; nothing else in
    typecheck/layout.yoop does
  - an LLVM type of its own: `%union.mod__Name = type { [N x i8] }`, a byte
    buffer rather than a field list, because the fields overlap
  - ADDRESS-BASED field access, and this is the part that is not an extension of
    anything. The bootstrap's structs are SSA aggregates - a read is a load plus
    `extractvalue`, and there is nothing to reinterpret an aggregate as. A union
    field read has to be "the union's own address, loaded at the field's type",
    which is the variant-PAYLOAD shape rather than the struct one. The write
    side already has an address walk (`emitFieldAddress`); the read side does
    not
  - a LITERAL that stores exactly one field at the union's address, again as
    that field's own LLVM type

`Type.Union` and `Symbol.Union` exist and nothing constructs either, so pass A
and pass C are the small half. The estimate is 250 to 400 lines plus fixtures,
and the risk that makes it worth deferring rather than rushing is that the read
path touches the same code every struct read goes through, in a compiler that
currently self-hosts to a byte-identical fixpoint.

### 5.14 A module-level `let` with a non-literal initializer - OPEN, 2 files

`let state: ServeState = http.serveStateNew(MAX_CONCURRENT);` and
`let counters: int32[] = [0, 0, 0, 0];`. Refused by name today ("a global's
initializer is fixed at compile time").

The reference's answer, and it is the one to copy: the global gets a ZERO
initializer, and each file with any such decl emits
`define internal void @<mod>__module_init<file>()` that stores the real values.
`main` calls every one of them in the module graph's topological order before
anything else. So this is not comptime - it is a run-time initializer with a
defined order, and it is what a mutable global needs anyway (its payload has to
be writable storage that two globals with the same initial bytes do not share).

Deferred because it changes what `main` EMITS, which is the one function the
self-host fixpoint is most sensitive to, and 2 files is not worth spending that
risk on at the end of a pass. Roughly 150 lines: a global emitted as
zeroinitializer, a per-file init function, a call list threaded to `main`.

### 5.15 Reserved words as NAMES - OPEN, 1 file

`function fputs(type: string, kind: ref FILE): int32;`. C headers use `type`,
`kind` and `enum` as parameter names, so generated bindings fail to parse on the
first collision. The reference accepts a reserved word in NAME-ONLY positions -
struct, union, variant and enum field and case names, extern parameter names,
the right of a field access, and struct-literal field names - and refuses it
everywhere else (`function f(type: int32)` on an ORDINARY function is "type is a
reserved word and cannot be used as a name", established by probing).

Small - it is `parseIdentAsName` plus a variant that accepts a keyword token,
wired to the positions above - but the one file that wants it also wants
`union`, so it finishes nothing on its own.

### 5.16 A DOUBLE DISPOSE after a manual discharge - OPEN, 1 file

Found by 4.3's program probe, in `examples/tour/ep08_kinds.yoop`, whose own
`// expected output:` block says what should happen and whose prose says why:

    manualDispose:
      use 3
      close 3
      after manual dispose
      close 3          <- the bootstrap emits this second one

`manualDispose()` calls `Disposable.dispose(ref c)` BY HAND on a
`disposable`-kinded binding, and the extra line lands after
`after manual dispose` - so it is the scope-end call at the closing brace, not a
missing one on the reference's side. The reference tracks that the obligation
was DISCHARGED on this path (`snapshotSat` / `mergeSatIntersect` in
`src/jsyooptypecheck/kindCheck.js`) and emits nothing at scope end.

This is a real correctness bug rather than a rendering difference: a `dispose`
that frees is being called twice on the same value. It has not bitten anything
else because nothing in `std/`, `examples/pass/` or `bootstrap/src/` disposes a
kinded binding by hand.

Not small, and the reason is the shape rather than the size.
`codegen/dispose_stack.yoop` is a purely SYNTACTIC scope stack - it knows which
bindings are open and how far to unwind, and nothing about what has happened to
them. Discharge is PATH-SENSITIVE: a `dispose` inside an `if` discharges on one
branch and not the other, so the answer at the closing brace is an INTERSECTION
over the paths that reach it, which is the same merge shape `diverge.yoop`
already does for "does control flow always leave this statement". So the work is
a satisfied-set on the dispose stack, set by a manual call, snapshotted at a
branch and intersected at the join - and it belongs in typecheck beside
`diverge.yoop` rather than in codegen, because only pass D sees the branches as
branches.

### 5.17 `function main(): void` has no defined exit status - OPEN, 1 file

`examples/playground/sqlite_demo/main.yoop` prints byte-identical output under
both compilers and exits 6 under the bootstrap against 0 under the reference. 6
is the length of the last thing it printed: the last statement is
`printf("\ndone\n")` and `w0` is never written after it.

**BOTH compilers emit `define void @main()`**, which is ABI-illegal for C's
entry point, so neither writes the return register. The reference's 0 is
INCIDENTAL - `yoop_runtime_shutdown()` happens to be its last call and happens to
leave 0 there. Change the printed text to 21 characters and the bootstrap exits
21; the reference would move too if its last call ever returned something else.

The fix is to emit `define i32 @main()` and `ret i32 0` for a `void` main, which
is what C says a missing `return` in `main` means. Deferred rather than done in
4.3 for the same reason 5.14 was: it changes what `main` EMITS, which is the one
function the self-host fixpoint is most sensitive to, and one playground file is
not worth spending that risk on at the end of a pass. It is also worth fixing on
BOTH sides in one change, since the defect is shared.

### 5.18 A field carrying a kind by PREFIX - OPEN, 1 file

`examples/pass/propagates_full/main.yoop`:

    type Session propagates<disposable> {
      handle: disposable FileHandle,
    }

The clause says the obligation belongs to the fields, and `propagatedFieldsOf`
in `typecheck/propagate.yoop` counts a field as supplying the kind only when its
own TYPE propagates it. `FileHandle` does not - it implements `Disposable`
outright - and the field says so with an explicit PREFIX in its annotation
instead. So the type propagates a kind no field appears to carry and the binding
is refused by name. The reference counts both spellings.

Already in the follow-ups as unbuilt; what 4.3 added is a corpus file that wants
it, and the sizing. It is not a one-liner: `Type.Field` is `{ name, typeId }`
and has nowhere to put a carried kind, so the work is a `carriedKind` slot on
`Field`, filled in pass C where the struct's fields are built (the one place the
annotation node and its `KIND_PREFIX` list are both in hand), and one extra test
in `propagatedFieldsOf`. Every construction site of `Field` moves with it.

### 5.19 The `modules/` import root - OPEN, 1 file

`import { ... } from "modules/math"` - the program-owned package directory,
refused by name in `source_graph/walk.yoop`. `examples/modules_demo/` is built
entirely around it, so it is the one example DIRECTORY the bootstrap cannot
build at all.

The reference's rule (`src/jsyoopdriver/moduleGraph.js`): `modules/<name>`
resolves against a `modules/` directory found by walking UP from the importing
file, stopping at the first one that exists. The point is relocatability - a
library at `json-repo/json/` with its dependencies at `json-repo/modules/`
writes `import ... from "modules/http"`, and the same file copied into a
consumer at `app/modules/json/` resolves the same line against `app/modules/`.
The walk is bounded so a stray `modules/` in a home directory cannot answer for
an unrelated program.

Small, and self-contained: one upward walk in `source_graph/resolve.yoop` and
the refusal in `walk.yoop` comes out. It needs a fixture tree under
`bootstrap/tests/graph/` with two nesting depths, because the whole feature is
which `modules/` answers.

---

## How each step is done

**The goal is a WORKING bootstrap, not a perfect one.** That changed on
2026-08-13, part way through, and it changes the balance of what follows. The JS
reference already produces working programs, so the bootstrap does not have to
be the place every question gets settled. Get it compiling, write down what is
unresolved, and come back once it self-hosts - a great many of these are far
easier to fix from a compiler that works than from one that does not.

0. **Run the probe with `scripts/probe_surface.sh`**, not a hand-rolled loop.
   It compiles every non-test file under `std/`, `examples/pass/` and
   `bootstrap/src/` and prints one line per file plus a summary. Usage:

       node src/yoopiler.js bootstrap/src/main.yoop -o /tmp/yoopiler_boot
       scripts/probe_surface.sh                    # defaults to that compiler
       scripts/probe_surface.sh /tmp/stage3 8      # a built stage, 8 workers

   It is PARALLEL because the probe is subprocess-bound rather than
   compute-bound - the compiler is fast and most of the wall clock is spent
   waiting on clang, so a serial loop used about 15% of one core. That took it
   from roughly 7 minutes to about 85 seconds. It also does NOT LINK, as of
   4.4 below: `--emit-ir` stops the compiler short of clang, `clang -S
   -emit-llvm` answers the validity question the link used to answer by
   failing, and a `define ... @main(` line in the IR answers the other one. 63
   seconds. Two things the hand-rolled loops kept getting wrong and this does
   not: every worker needs its OWN `-o` path (they all wrote `/tmp/sp`, which
   is a race the moment it goes parallel), and the stale `.ll` has to be
   removed BEFORE the compile as well as after, because a reused PID would
   otherwise read the previous holder's output as this file's.

   Categories: `ok` produced valid IR defining a `main`; `no-main` produced
   valid IR with none, so its code is fully handled and `done` counts it;
   `bad-ir` is a real codegen bug; `refused` stopped at a named refusal.
   `sites` counts distinct `file:line:message` among the last two.

0b. **And `scripts/probe_programs.sh` when the change could affect what a
   program DOES**, which the surface probe cannot see: it stops at `--emit-ir`
   and never links or runs anything. This one takes every entry point under
   `examples/` that declares a `main`, builds it with BOTH compilers, runs
   both, and compares stdout and exit code.

       scripts/probe_programs.sh                    # defaults to /tmp/yoopiler_boot
       scripts/probe_programs.sh /tmp/s3/yoopiler 8 # a built stage, 8 workers
       scripts/probe_programs.sh /tmp/yoopiler_boot 10 'playground'  # a filter

   Categories: `OK` both built it, ran it, and agree; `DIFFER` both ran it and
   the two disagree, which is the most interesting result there is; `BOOTGAP`
   the reference built it and the bootstrap did not, so a bootstrap bug;
   `REFGAP` the reverse; `STALE` neither built it, which is a finding about the
   PROGRAM. Added by item 4.3, and it found two bugs - undefined behaviour in
   printf and a double dispose - that no amount of probing IR could have.

   Run BOTH after a change, and run each with stage1 and stage3. The two probes
   are separate on purpose: the surface numbers steer this plan and a change
   that moved them would be a broken probe, not progress.

1. **Measure first.** Probe the sites; do not infer the shape from one example.
   Attribute a blocker to the file it is IN, not to the probe that hit it. The
   bootstrap's own source is one deep import closure, so a single line can gate
   most of the tree and the DISTINCT-SITE count is the honest measure. This rule
   is not relaxed; every hand-off so far that skipped it was wrong about scope.
2. **Probe the reference when it is CHEAP and the answer changes the design.**
   Loosened deliberately. A quick probe that settles a real fork is worth it -
   several this session found the reference behaving the opposite of what its
   source suggested. An exhaustive sweep of edge semantics is not: pick the
   reasonable behaviour, make it work for the corpus in front of you, and put
   the open question in the follow-ups list below. Do NOT go hunting for
   bug-compatibility with the reference.
3. **Do not fix every bug you find.** Latent bugs will keep surfacing - several
   already have. Fix one when it BLOCKS the item you are on; otherwise record it
   in the follow-ups list and move past it. Finishing the bootstrap is what
   makes the rest of them cheap to fix.
4. **Ship tests at whichever level fits** - Yoop unit tests beside the module,
   a slice fixture with a HAND-WRITTEN `.expected`, or the parity corpus. Never
   capture an expected file from compiler output. This rule is not relaxed
   either: when the JS compiler retires these are the only thing standing
   between a change and a silent regression. But a fixture covers the shapes the
   corpus actually uses; it does not have to enumerate every edge case.
5. **Refuse by name rather than diverge silently.** Still the most important
   rule, and MORE important now rather than less: deferring work only works if
   the deferred thing is findable later. A named refusal is a to-do item with an
   address. Something that quietly compiles to the wrong thing is not.
6. **Record deliberate divergences** in bootstrap/README.md, with the reason, and
   anything deferred in the follow-ups list below.
7. **Keep Yoop files around 200 lines**, split where it makes sense, and follow
   the codegen readability rules inside `codegen/`.

---

## Follow-ups, deferred until the bootstrap self-hosts

Not bugs to fix now. Each is written down so it is findable later; the ones that
are already named refusals in the compiler will announce themselves.

- **`@precompile` and comptime generally.** Out of scope by design; comptime
  returns self-hosted. `lexTablesNew` moves back to a module `const` with no
  change to its call sites once it exists (item 2.0).
- **`Iterable<T>` in `for ... in`** - DONE 2026-08-13 as item 3.2. Left here
  with the two things it deliberately did NOT do: the loop walks a COPY of the
  iterator (it is spilled to a slot, because `next` takes `ref self`), so a
  `MapIter` the loop was handed is left at index 0 afterwards; and a `ref`-typed
  iterable takes the same path with an extra load rather than borrowing in
  place. Both match the reference and neither is reachable from the corpus.
- **`ns.Variant.Case` and `ns.Color.Red` in a PATTERN.** A namespace reaches
  types and calls but not pattern constructors. Nothing in the corpus needs it.
- **A template literal handed DIRECTLY to printf as its format string** renders
  differently between the two compilers (`3.140000` vs `3.14`, `1` vs `true`).
  Pre-existing. Item 4.3's program probe measured how far it reaches: **23 of
  the 279 example programs**, across `examples/pass/`, `examples/tour/` and
  `examples/playground/`, and it is 23 of the 26 places the two compilers
  disagree at all. The bootstrap is the one that is right - it builds the string
  with the language's own interpolation rules, where the reference turns the
  template into a C format string at compile time and lets printf re-render.
  Fixtures route through `printf("%s\n", ...)` instead.
  The SAFETY half of the same difference is fixed as of 4.3 - see
  `codegen/printf_format.yoop`. Several of those 23 files carry an in-file
  `// expected output:` comment spelling the REFERENCE's rendering
  (`casts.yoop:15`, `float_literal.yoop:10`, `heap_alloc_struct.yoop:19`,
  `runtime_introspect.yoop:67`, `traits_multi_impl/main.yoop:38`,
  `ep02_values_and_loops.yoop:63`, `time_calendar.yoop`); under "the bootstrap
  is right" those comments are stale and want a pass of their own.
- **A RUNTIME format string WITH varargs is broken in the reference.**
  `printf(runtimeFmt, 5)` renders the format through `%s` and then appends `5`
  after it, so `"with varargs %d%%\n"` prints as `with varargs %d%%` followed by
  a bare `5`. The bootstrap prints `with varargs 5%`. Found while writing the
  `printf_runtime_format` slice fixture for 4.3, which is why that fixture
  covers the shape in a comment rather than an assertion - a fixture is checked
  against both compilers and has to stay inside their intersection.
- **A value `enum` passed where its UNDERLYING primitive is declared.** The
  reference COERCES (`SDL_Init(flags)` against
  `function SDL_Init(flags: uint32);` with `flags: InitFlags`); the bootstrap
  refuses by name, `argument 1 of "SDL_Init" is uint32, not enum InitFlags`.
  Measured by 4.3 against a probe program, and it corrects item 1.2's write-up
  and bootstrap/README.md, which both claimed "no implicit conversion in either
  direction" of BOTH compilers. Left refused because refusing is the safe
  direction - a program the bootstrap accepts means the same thing on both
  sides - and one playground file wants it
  (`examples/playground/nebula_arena/`).
- **`ns.CONSTANT` reports `unknown name "<ns>"`.** A module `const` reached
  through a namespace (`sdl.EVT_QUIT`) is the same gap `ns.Variant.Case` has,
  and it is the last thing between the bootstrap and
  `examples/playground/diskscope/`. What is worth fixing even before the
  feature is the MESSAGE: it names neither the feature nor the fix, on a line
  where the namespace certainly IS known.
- **A missing comma in an `implements (...)` list is accepted by the reference.**
  `type E implements (Into<HttpError> WithContext<HttpError>)` in
  `examples/playground/servertest2/`. SPEC.md says the list is comma-separated
  (`implements (Disposable, Iterable<Message>)`), so the PROGRAM is malformed
  and this is reference leniency rather than a bootstrap gap. The papercut is
  the bootstrap's message, `expected RPAREN, got IDENT`, which does not say
  "you are missing a comma".
- **The JS reference's `stringHash` is WRONG, so the two compilers disagree
  about MAP ITERATION ORDER.** Found by 3.1, and the first place the "integer
  literal above int64 wraps silently" reference bug below is observable.
  `std/core/strings.yoop`'s FNV-1a offset basis is 14695981039346656037, which
  is above int64 max; the reference loses precision reading it, so every hash it
  computes is off. FNV-1a of "t" is 12638201494206808739 and the bootstrap says
  so; the reference says 12637105281113482372. The bootstrap is right, nothing
  in the tree depends on hash order, and no fixture may start to - a `Map` walk
  cannot be asserted against both compilers.
- **`--warn-disposable` fires inside DERIVE-GENERATED code.** The `Vec` and
  `Map` walkers bind `_deriveVecN` / `_deriveMapN` locals, which the advisory
  warning reads as unhandled disposables pointing at a `@derive`d declaration
  with no actionable fix. The reference marks the generated method
  `isDeriveGenerated` and skips advisory diagnostics on it; the bootstrap has no
  such flag. The warning is opt-in, so nothing in the ordinary build sees it.
- **`@derive(display)` guard rails are LOAD errors here, not diagnostics.** The
  expansion runs at load time because that is the only place the module's arena
  is writable (see 3.1), so a generic derived type, an alias, a duplicate
  `toString` and a missing `Display` stop the compile rather than accumulating.
  Same wording, different channel. Moving it back to typecheck needs a `ref` to
  a Module inside the graph's Vec, which the bootstrap has no spelling for.
- **A vtable's slot ORDER is its own declaration order, not the trait's.** See
  3.4. Unobservable across compilers - a vtable value never leaves the program
  that built it - and every corpus vtable declares its slots in trait order. The
  fix, if one is ever wanted, is a declaration-ordered method list on
  `Type.Trait` rather than only the `Map`.
- **`Trait.method(ref vt, ...)` with a vtable receiver** - DONE 2026-08-13 as
  item 5.10. It used to be refused, on the grounds that every corpus site wrote
  the vtable's own name; `examples/pass/reader_vtable_smoke/main.yoop` does not,
  and it cannot - a function handed a `Reader` and nothing else has only the
  trait to name. Both spellings now reach the same slot dispatch, and the
  vtable's name in a diagnostic is read off the TYPE so the two read alike.
- **A CROSS-MODULE call to an `export "C"` function** emits the mangled name and
  fails to link. That is not a bootstrap gap: the reference does exactly the
  same thing (`use of undefined value '@lib_<hash>__add_one'`), established by
  probing while item 5.6 landed. The per-module `externNames` table is what
  answers "bare C name or mangled one", and an importing module has no entry in
  its own. Nothing in the corpus writes one.
- **A NARROWER compound-assignment rule than the reference's.** After 5.5 an
  element target works when its SUBSCRIPT is a name or an integer literal.
  `xs[g()] += 1` stays refused by name, because the bootstrap DESUGARS the
  compound forms (naming the target twice) where the reference keeps a
  COMPOUND_ASSIGNMENT node and addresses the lvalue once. Refusing is the safe
  direction - a program the bootstrap accepts means the same thing on both
  sides - and every subscript in the corpus is a literal or a name.
- **Shadowing with a DIFFERENT TYPE is a reference bug.**
  `let x: int32 = 5; if (c) { let x: string = "s"; } return x;` makes the
  reference emit `ret i32 %t4` on a `ptr`: it restores the NAME and not the
  type. The bootstrap gets it right, so `shadowing.yoop` documents the case in a
  comment rather than asserting it - a slice fixture is checked against both.
- **Reference bugs found along the way**, none of which the bootstrap should
  copy: a string literal passed as a printf vararg prints twice out of order;
  `&` on a float crashes its codegen; a const array write SIGBUSes; a duplicate
  enum case value emits IR clang rejects with no source line; generic trait
  bounds compare by trait NAME only and then emit invalid IR; an `enum<uint8>`
  is ORDERED SIGNED, so `Flags.HIGH > Flags.LOW` is false for cases 200 and 10
  (its `binaryInstruction` asks `isUnsignedIntPrim(opType.name)` and a value
  enum is not a prim, so the unsigned override never fires - see 2.11); an
  integer literal above int64 WRAPS silently rather than being refused, so
  `const N: usize = 18446744073709551615;` is 0 there and is itself here (found
  by 2.12, which had to stop using a max-value sentinel because of it). And two
  found by 4.3's program probe, both in `examples/playground/`, both of which
  make the reference the reason the program does not build:
  `algoscope/main.yoop` makes it CRASH with `RangeError: Maximum call stack size
  exceeded` in `findScopedIdentInExpr`, and `sdl_demo/main.yoop` makes it emit
  invalid IR (`floating point constant invalid for type`, which the bootstrap
  avoids by emitting every float constant as a 64-bit hex pattern - see
  `utils/float_bits.yoop`).
- **A `switch` over a BOOL** - DONE 2026-08-13 as item 5.3, and the
  exhaustiveness question the entry raised is what made it its own scrutinee
  kind rather than a one-bit integer. See the item.
- **An intrinsic reached by a NAMED import and then called unqualified.** After
  item 3.6, an unqualified call means the intrinsic only when THIS module wrote
  the `extern "intrinsic"` block; a module that imported the name and called it
  bare gets a call to a symbol nothing defines, which is a link error rather
  than a wrong answer. No file in std, examples or bootstrap does it, because a
  std value import has to come through a namespace. The complete fix is a set of
  intrinsic SymbolIds rather than a per-module set of names, and it is the same
  shape the reference's `$builtin__` decl ids have.
- **The layer-2 AST parity dump** (item 4.1) - worth doing once the parser stops
  changing shape.
- **A generic nominal applied to a Func**, spelled twice: two separate
  `Box<(a: int32) => int32>` annotations intern two Func ids, so they register
  two instances with two mangled names, and `sameTypeStructurally` deliberately
  does not look through a nominal to call them one. Nothing in std, examples or
  bootstrap/src applies a generic to a function type, so it is unreachable
  today. The fix is in the INSTANCE registry (dedupe on structural argument
  equality), not in the compare. Refused, with both spellings now rendering
  correctly in the diagnostic - see item 2.2.
- **`from` as an ordinary identifier.** `type Line { from: Point }` and
  `l.from.x` are legal in the reference and neither parses here - `from` is a
  keyword token, and the bootstrap has no contextual reading of it the way it
  does for `library` and `propagates`. The FIELD DECLARATION is what fails
  first, so supporting it means the type-decl parser, the struct-literal field
  parser and the postfix member read together. One file wants it
  (`examples/tour/ep03_structs.yoop`), and the tour is outside the probe corpus.
  The `X.from(...)` vtable refusal is gated on a following `(` so it does not
  claim this one is about vtables.
- **`formatType` still answers `<type>` for `Type.SelfPlaceholder`.** Everything
  else renders now. A trait-method `ref self` placeholder should not reach a
  user-facing diagnostic at all, so it is left as the sentinel it is.
- **`export "C" function` - 3 files, 2 sites, REFUSED BY NAME as of
  2026-08-13.** The definition is emitted under its bare C name, so every caller
  has to agree on that spelling - and `Symbol.Func` carries a TypeId and nothing
  else, so an importing module has no way to learn not to mangle it. Recording
  C-ABI-ness on the symbol is the work. All three corpus files call theirs from
  the SAME module, so a `tm.externNames` shortcut would pass the probe and break
  the first cross-module use; that is why it is refused rather than half-built.
- **`union` declarations - 4 files, 2 sites, REFUSED BY NAME as of 2026-08-13.**
  Sized and skipped: it is a C union, so every field sits at offset 0 and the
  size is the largest member's. That is its own layout rule, its own `llvmType`,
  and its own field read and write - the variant-payload shape rather than the
  struct one, since reinterpreting bytes as another type needs an ADDRESS.
  `Type.Union` and `Symbol.Union` already exist and nothing constructs either.
  What the corpus wants: `union_rgba.yoop` writes one field and reads a
  DIFFERENT one back through a nested path (`c.channels.r`), which is the whole
  point of a union and the whole cost of it; `dir_module_shell_order` only needs
  the decl to parse and one field read; `keyword_field_names.yoop` has three
  other blockers in front of it. The refusal used to be "unexpected token at top
  level: UNION" and "got UNION" on the exported form, which read as a typo on a
  declaration that is perfectly well formed; both now name the feature and the
  reason.
- **PROPAGATED disposal** - DONE 2026-08-13 as item 2.12. What is left of it:
  chaining through a SECOND level (a field whose type propagates the kind and
  has no method of its own) is refused by name, and so is a propagating type
  with no qualifying field. Also unbuilt, because nothing in the corpus writes
  it: a field carrying the kind through an explicit PREFIX in its annotation
  (`disposable buf: Foo`) rather than through its type's own clause. The
  reference counts both.
- **`switch` over an IMPORTED `Result` reported `"Result" is not a variant`** -
  FIXED 2026-08-13, and it was not a compiler bug at all. `typecheck/generics.yoop`
  named `Result` in a pattern and never imported it; the JS reference AUTOLOADS
  std/core/types.yoop into every module and the bootstrap does not, so the file
  was relying on the autoload without saying so. Adding `Result` to the import
  beside `Option` keeps it compiling under BOTH compilers and took four
  diagnostics off the self-compile. Worth knowing as a shape: **a self-compile
  diagnostic naming a std type may be a missing import in the bootstrap's own
  source rather than anything about the compiler.**
- **std AUTOLOADS.** The reference pulls std/core/types.yoop,
  std/core/traits.yoop and std/core/kinds.yoop into every module; the bootstrap
  has none of them. Three places work around it today - the `Result` import
  above, `Into` being matched by NAME in typecheck/fallible.yoop rather than
  resolved as a symbol, and every corpus file that has to import
  `std/core/kinds.yoop` to name a kind the reference gives it for free. That
  last one surfaced with 3.5: five files now stop at `unknown kind "task"` or
  `unknown kind "async"`, which is a missing autoload rather than a missing
  feature. It is also prerequisite 1 of item 3.1, so one piece of work unblocks
  both.
- **A full SIGNATURE check on a trait impl.** The bootstrap checks that a
  claimed trait's methods EXIST by name, and (as of 3.3) that their asyncness
  matches - and nothing else. Two methods with the same name and different
  parameter types still satisfy each other. Asyncness had to be added because the
  two spellings lower to different calling conventions; the rest is a
  pre-existing gap and comparing the whole Func TypeId is the fix, once someone
  has checked it does not break an impl in std that differs by a `ref`.
- **The `await` handoff is a Program-level BOOL pair rather than a node id.**
  `awaitPending` is set by `await` and taken by the very next CALL_EXPRESSION
  `checkExpr` reaches, which is that operand; `callWasAwaited` then lives for
  the span of one call and is saved and restored around nested ones. It is right
  for every shape in the corpus and the nested-argument test pins it, but a node
  id would be right by construction rather than by argument. Worth swapping if
  `await` ever stops directly wrapping its call.
- **A RUNTIME RACE between releasing a waiter and finishing the worker's
  bookkeeping on the same handle. Found by 3.5, present in BOTH compilers, and
  not this item's to fix.** `yoop_task_settle` flips the state byte and
  broadcasts, so a `wait` returns immediately - but `run_task_step` has not
  finished with the handle yet: it still reads the allocator-context slot at
  byte 40 afterwards. If the waiter reuses that handle in the meantime (a
  `joined` binding is one alloca, hoisted, so every iteration of a loop reuses
  it) or drops its last reference, the worker reads a slot that is no longer
  the task's. The backtrace is
  `run_task_step -> yoop_ctx_discard_task -> yoop_arena_destroy -> free` on a
  pointer libmalloc says was never allocated.

  Reproduced with a loop whose body holds a `joined` handle and whose `if`
  returns early through a `pooled` one: about 4 crashes in 50 runs, and the JS
  reference crashes at the same rate on the same program, which is what says
  the lowering is not the problem. It needs more than about 8 workers -
  `YOOP_NUM_WORKERS` at 1, 2 or 4 never reproduced it in 180 runs. Both slice
  fixtures are clean over 450 runs each at 1, 2, 10, 14 and 32 workers, so it
  does not make the suite flaky; the shapes that trigger it are not in it.

  The fix belongs in `runtime/yoop_runtime.c`: the handle's post-step
  bookkeeping has to happen BEFORE `signal_done` releases anyone, or the
  allocator context has to be lifted off the handle for the duration.
- **A COROUTINE that returns a large struct or an array by value** is untested.
  The ABI writes the result through `%__ret`, so it should be the shape that
  needs no special case at all - but nothing in the corpus does it and no
  fixture covers it. `Result<uint8[], string>` in std/net is the first thing
  that will.
- **A `while` whose condition is CONSTANTLY true by any route but the literal**
  (`while (1 == 1)`, `while (SOME_CONST)`) is treated as an ordinary loop, so a
  function whose every exit is a `return` from inside one is refused for having
  no return on some path. Folding either needs a comptime interpreter. Item 2.8
  handles the literal, which is the spelling that needs none.

---

## Tasks before being done here: 10 / 51

**Ten in-scope items left, of fifty-one tracked.** This is the work IN FLIGHT,
not the follow-ups above - those are deliberately deferred past self-hosting and
are not counted here.

Open:

    2.2   whatever the next probe finds (a rolling bucket)
    4.1   the layer-2 AST parity dump
    4.5   `yoopiler --test` in the bootstrap driver - sized, ~300 lines
    5.13  `union` - sized, refused by name, 4 files
    5.14  a module-level `let` with a non-literal initializer, 2 files
    5.15  reserved words as NAMES in name-only positions, 1 file
    5.16  a DOUBLE DISPOSE after a manual discharge, 1 file
    5.17  `function main(): void` has no defined exit status, 1 file
    5.18  a field carrying a kind by PREFIX rather than by its type, 1 file
    5.19  the `modules/` import root, 1 example directory

Closed since the last count: **4.3, the complex tests and the playground
programs.** It is the first item measured over code the surface probe had never
touched, and it did what a first look at real programs does: 218 of 279 example
programs build under both compilers, run, and agree exactly, and everything that
does not is now enumerated rather than suspected.

**The denominator grew by five and the numerator by four, which is this plan's
usual shape and is the process working.** Four of the five new items were found
by pointing the new probe at programs nothing had run in a while - 4.5, 5.16,
5.17 and 5.18 - and the fifth, 5.19, was a named refusal nobody had costed. Two
of the five (5.16 and 5.17) are things no amount of `--emit-ir` could have
found, because both are about what a program DOES rather than whether it
compiles.

**What is left is one feature, one dump format, and seven sized one-file
items.** 4.5 is the last thing the reference DRIVER does that the bootstrap
cannot, so it is the one on the critical path to retiring `src/`. 5.16 is the
only correctness bug among them. Nothing the corpus depends on to COMPILE is
open: seventeen of the twenty-two remaining surface refusal sites are
deliberate, and twenty-four of the twenty-nine program-probe gaps are refusals
this plan already names.

**Keep this counter current.** Update BOTH numbers whenever an item closes or a
new one is added, in the same edit that marks the item itself - a stale counter
is worse than none. Expect the denominator to GROW: twenty-five of the forty-six
were not visible when this plan was written, because each landed feature exposes
the next blocker behind it. That is the process working, not scope creep. An
item that turns out to be deferred rather than done moves to the follow-ups list
and comes OFF both numbers.
