# Bootstrap completion - phase 2, the codegen bugs

Landed. Extracted from [../bootstrap-completion.md](../bootstrap-completion.md).
Items 2.0 through 2.13. Item 2.2 stays OPEN in the live plan as a rolling
bucket - both entries written up here are closed, and what remains of it is
"re-run the probes and record what they find".

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

