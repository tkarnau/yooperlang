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
    now 495 done, ZERO refused, zero sites, zero bad-ir. The whole corpus -
    `std/`, `examples/pass/` and `bootstrap/src/` - compiles.

  programs (does the program WORK, both compilers run and diffed):
    pass         244   204 ok   20 differ   19 bootgap
                       now 220 ok, 23 differ, ZERO bootgap - see below
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

### A2. Task handle copy needs a refcount retain (1 file) - DONE

`examples/pass/propagates_full/main.yoop:36` - `"h3" binds a Task<T> handle
that is not a fresh spawn`. A `pooled` handle is heap-allocated and REFCOUNTED,
so a second binding onto it is meaningful: it takes its own count, and each
binding releases once at its own scope end. Codegen emits the retain
(`emitPooledHandleCopy`), and `yoop_task_retain` was already in the runtime.

`joined` still refuses the copy, and the reason is STORAGE rather than policy:
a joined handle lives in the caller's frame with no count to take, so two
bindings would both join it and the second would wait on a freed sync pair.
The message says so.

Covered by `typecheck.test.yoop` (both halves) and
`bootstrap/tests/slice/pooled_handle_copy.yoop`, which the reference agrees
with.

### A8. THE BOOTSTRAP ACCEPTS 4 PROGRAMS THE REFERENCE REFUSES

The largest finding in this document, and nothing in the probes could have seen
it.

The surface probe measures ONE DIRECTION: does the bootstrap compile what it
should. It is at zero refused and zero bad-ir, which is worth having and says
nothing at all about the other direction - does the bootstrap REFUSE what it
should. Measured directly, over the 138 negative fixtures in `examples/fail/`:

    38 of 138 compiled cleanly under the bootstrap when this was written
     4 of 138 still do

By family, with what closed each one:

     1  binding_*     OPEN (`binding_trailing_block_no_ownsblock`). The RULE
                      landed; the fixture is blocked by the kind-registry
                      collision below.
     1  dir_module_*  OPEN. Per-FILE import visibility inside a directory
                      module; see below.
     2  traits_*      STALE. Not ports - see below.
     9  clearance_*, owned_*, scoped_escape_pass_unscoped
                      CLOSED, by the expression-marker pass in
                      `typecheck/markers.yoop`.
    15  kind_*, propagates_*, layout_*, scoped_*, and the one-offs
                      CLOSED, in `typecheck/kinds.yoop`, `typecheck/traits.yoop`,
                      `typecheck/clearance.yoop` and `typecheck/kind_use.yoop`.

`typecheck/kinds.yoop` is where the DECLARATION rules live: the application
sites a kind declares and how a composition intersects them, the effect
categories `forbids` accepts, what bounds a `mustNotEscape`, what a kind
parameter may be typed, the two clauses that name a trait, the clearance clauses
(the two marker polarities and the two transition clauses), the clause
VOCABULARY (a word outside it, `restricts` among them, is a promise no pass
could keep), and the `layout` body - `abi` accepting only `"C"`, and a
sub-clause the compiler does not implement. A layout body is now PARSED as
sub-clauses rather than skipped (`parseKindSubClause`), which is what made the
last two possible and what `kind_compose_contradiction` reads: two composition
operands demanding different alignments cannot both be honored, and alignment is
the one clause a composition cannot union.

`typecheck/kind_use.yoop` is new and is the other half - where a kind may be
WRITTEN, and what writing one there costs. Four rules, each reading a fact
already in hand at the site: the `appliesTo` SITE test at a binding, a parameter
and a type prefix; the trailing-block form needing a kind that declares
`ownsBlock`; a field carrying a kind its enclosing type does not
`propagates<>`; and `mustNotEscape scope`, which refuses a `return` of a bounded
binding and an alias of one under a name carrying no bound. `Binding.noEscape`
on the scope entry is where the bound rides, because the bound is about the
BINDING and the same type under a plain `let` is unbounded.

Four more landed where the fact was already known: a `ref T` RETURN (refused for
a yoop function, still allowed for an `extern`, whose `ref FILE` is a pointer
the C library owns); a field write through a `const` binding, walked to the root
of the field path and stopping at an INDEX, since `const xs: T[]` freezes the
name and not the buffer; a `refcounted` kind on a binding whose initializer is
not a `Task<T>` and whose type does not propagate the kind; and a write to a
module-level `let` reached through an import, which the import makes visible
rather than writable. A parenthesized kind composition (`(b & c) & d`) is a
parse refusal - a composition is a flat intersection, and the parser had been
consuming the parentheses silently.

`typecheck/traits.yoop` holds the four trait rules: a method name declared twice
in one type body, a receiver written `self` rather than `ref self`, and full
signature equality between an impl method and the trait method it satisfies.

`typecheck/clearance.yoop` holds the DECLARATION half of clearance: the
unauthorized TRANSITION, read straight off a signature. The authority is the
kind declaration's `requires <Trait>` paired with `appliedBy` / `clearedBy`, so
only a method of that name on a type implementing that trait may confer or
strip.

`typecheck/markers.yoop` is the USE-SITE half, and it is what closed the nine
fixtures above. What was missing was a marker set for an EXPRESSION; it is
three pieces:

  * A SymbolId-keyed table of each function's parameter and return markers,
    filled by pass C where the declaration's AST is in hand
    (`recordSignatureMarkers`). Keying it by SymbolId is what makes it work
    across module boundaries with no translation: an import binds the DEFINING
    module's SymbolId, so a same-module call, a by-name imported call and a
    `ns.f(...)` call all read the same entry. That is what
    `clearance_namespaced_sink` and `clearance_sibling_file_sink` were about,
    and neither needed a per-module callee index.
  * Per-binding markers, on `Binding` beside `noEscape`, stamped by `bindParams`
    and `bindLocal`. A binding WITH an annotation takes the annotation's markers
    (which is what makes `const borrowed: string = owned` a deliberate drop);
    one WITHOUT inherits its initializer's, which the reference does not do and
    which is right in both directions.
  * A marker DECORATION on each call node, stamped when the call is checked, so
    a later reader gets the callee's return markers without resolving the callee
    a second time.

A marker set is a BITMASK, not a set of names. Every conferred or restrictive
kind gets one bit at `registerKind`, so a set rides in a `Binding` and in the
signature table with nothing to dispose, and a comparison is two ands. A graph
declaring more than 64 marker kinds leaves the rest UNTRACKED rather than
aliasing them onto someone else's bit; std declares exactly one.

Three checks read it, and the last one is not about clearance at all:

  * a BINDING INITIALIZER against the binding's declared markers
  * a CALL ARGUMENT against the callee's parameter markers
  * `mustNotEscape scope` at a call argument - the third escape route, which
    kind_use.yoop's header named as blocked on exactly this table. Passing a
    scope-bounded binding into a parameter carrying no such bound is refused.

Plus a fourth that needs the BODY rather than a slot: the conferred
PASSTHROUGH. `owned` names no `appliedBy` on purpose - no trait impl can be the
authority, because the only thing that mints owned storage is a bodyless
allocating intrinsic - so clearance.yoop skipped that whole family rather than
refuse every legitimate `owned`-returning function in std. With the return
values' markers in hand the question is answerable: a kind naming no authority
is legal on a return only when EVERY `return` in the body hands back a value
that already carries it. That is what `owned_forge` asserts, in both its
shapes (a literal, and a body that launders on one path and forges on the
other).

WHERE THE PASS IS DELIBERATELY PERMISSIVE, and why each is safe. An expression
whose markers nothing established reads as UNKNOWN and satisfies every bound:

  * a payload destructured out of a `switch` arm. The reference keeps a marker
    TREE mirroring type arguments, so `case Result.Ok { value: v }` over a
    `Result<owned string, string>` gives `v` the `owned`. The bootstrap keeps
    only an annotation's ROOT markers, so it cannot, and treating those bindings
    as unknown is what keeps `examples/pass/owned_payload.yoop` compiling.
  * a TRAIT-METHOD call, which is the launder boundary
    (`Cleansable.cleanse(ref dirty)`). The reference confers every kind whose
    `appliedBy` names that method on that trait; the bootstrap does not model
    it, and unknown is what keeps `examples/pass/clearance_marker.yoop` and the
    passing `clearance_namespaced_sink` compiling.
  * a call through a function value or a vtable slot, a method call, and a
    generic function - none of which has an entry in the signature table.

The cost is a forge through one of those routes that is accepted. The
alternative cost is refusing correct programs, which is the one thing this pass
is not allowed to do.

#### The two STALE fixtures

`examples/fail/` had been assumed uniformly correct and is not. `traits_collision_two_traits`
and `traits_collision_with_function` assert that a type may not implement two
traits declaring the same method name, and that a method may not share a name
with a module-level function. SPEC.md section 17 item 2 says the opposite in as
many words ("Trait method names live in the trait's namespace and may freely
coincide with module-level free-function names or with method names from other
traits implemented by the same type, because every call site is unambiguously
qualified"), and the reference ACCEPTS both. They should be retired or
rewritten, not ported.

Those two are still the only stale ones found. Every other fixture in the batch
was checked against the reference first, and the reference refuses all of them.

#### What is left, and what each one needs

`owned_payload_forge` IS REFUSED BUT ONLY PARTLY CHECKED. It asserts four
forgeries and the bootstrap catches one - freeing a string literal inside a
switch ARM, which is the walk-coverage half. The other three all live in a
PAYLOAD position and all need markers to travel somewhere they currently do
not:

  * `return Result.Ok { value: "a literal" }` against a declared
    `Result<owned string, string>` - needs a marker TREE that mirrors type
    ARGUMENTS, and a check of a returned CONSTRUCTOR's fields against the
    matching argument of the return annotation.
  * `return Slot.Held { text: "a literal" }` where the marker is on the variant
    case's own FIELD annotation - needs the variant DECL's field annotations
    reachable from pass D, which means recording them the way the signature
    table records a function's.
  * `str.strFree(e)` on an `Err` payload destructured out of a
    `Result<owned string, string>` - needs the two above plus payload BINDINGS
    taking the markers of the position they came out of.

All three are the same feature (`emptyMarkers().args` in
`src/jsyooptypecheck/kindFlow.js`), and none of them can be added
half-way: without the destructuring half, the constructor half would refuse
`examples/pass/owned_payload.yoop`.

`binding_trailing_block_no_ownsblock` IS BLOCKED BY A REGISTRY COLLISION rather
than by a missing rule. `Program.kinds` is keyed by BARE NAME for the whole
graph and the first registration wins, so a file declaring its own `disposable`
beside std's reads back STD's KindInfo - and std's declares `ownsBlock`, so the
fixture's kind looks like it owns a block. The rule itself is implemented and
covered by unit tests, which build a single module with no std in the graph.
The same collision is why there is no `appliesTo field` SITE test: applying one
refused `examples/pass/propagates_full/`, whose `io.yoop` declares a `disposable`
with `appliesTo binding field` that reads back as std's `appliesTo binding`. The
field rule that DID land compares two syntactic WORDS - the field's prefix and
the type's `propagates<>` clause - which the collision cannot affect. The real
fix is a per-module kind resolution (`Symbol.Kind` already exists and carries a
`kindId` that is always 0), and it is a change to every `lookupKind` caller.

`dir_module_import_leak` NEEDS PER-FILE IMPORT VISIBILITY. A module's source
files share its declarations but not its imports, and pass B wires every file's
imports into one `tm.names` map for the whole module. Enforcing the rule means a
per-file name set beside the module-wide one, which is state threaded through
pass B and every lookup in passes C and D.

This is the UNSAFE direction. Every other divergence recorded here is the
bootstrap being stricter than the reference; this is the bootstrap being
permissive, which means a program that is wrong compiles and runs.

It also reframes what "ready to delete `src/`" means. The language surface is
done in the sense that everything legal compiles. What is not done is the
refusals, and there is no probe for them - which is precisely why this went
unmeasured until a fixture harness was pointed at it.

`src/fail.test.js` (`npm run test:fail`) is that harness: a fixture plus a
hand-written `<name>.expected-errors` beside it, asserted against the BOOTSTRAP,
in the shape `bootstrap/tests/slice/` already established. 68 of the 139 are
ported. The rest split into roughly half that are a straight transcribe and half
that need a decision first, because the check they assert does not exist.

One more finding came with this batch, and it is about the bootstrap's own
tests: `typecheck.test.yoop` asserted "a field of a const binding is still
assignable", with a comment claiming the reference allows it. The reference
refuses it, and refuses the for-in and pattern-binding forms of it too. The test
now asserts the refusal.

Three smaller findings, all worth fixing on their own:

  * PARSE-ERROR COLUMNS ARE OFF BY ONE. They point one column PAST the offending
    token; typecheck columns are exact. Same class as the DWARF line bug: it
    reads as plausible in every message.
  * SIX DIAGNOSTICS CARRY NO LOCATION at all - four module-graph ones and two
    codegen ones. `<line>:<column>` has no spelling for those, so the expectation
    format needs a decision before they can be ported.
  * INTERNAL MODULE IDS LEAK into user-facing messages: `module m_3 has no
    export "nope"`. The `_3` is a graph id, not anything the user wrote.

### A9. Three programs the bootstrap accepted and the reference refuses - DONE

A second audit in the same UNSAFE direction A8 opened, and this one was found by
asking a different question: not "which negative FIXTURE compiles" but "which
shapes does the reference's typechecker rule on that the bootstrap's has no rule
for at all". Three came out, all three reproduced by hand, and all three produce
IR that CLANG refuses - so the failure had the compiler's name nowhere on it.

  1. AN INT LITERAL WIDER THAN THE SLOT IT PINS TO. `let a: uint8 = 256`.
     Worse than the other two, because there is no clang refusal behind it: the
     value is TRUNCATED into codegen and the program prints 0. Closed by
     `typecheck/int_range.yoop`, asserted by
     `typecheck.test.yoop:intLiteralsHaveToFitTheTypeTheyPinTo` and
     `examples/fail/int_literal_out_of_range`.
  2. NO OPERAND-CLASS CHECK ON A BINARY OPERATOR. Closed - below.
  3. NO RECURSIVE-STRUCT DETECTION. Closed - below.

#### A9.1 The operand-class table (`typecheck/operands.yoop`)

Two operands sharing a TypeId was the whole test, so `a + b` on two strings
emitted `add ptr %t1, %t2` and typecheck said ok. The same held for two structs,
two arrays, two `ref`s, `true + false`, `true < false`, and `<` on two variants.
Only floats (`checkFloatOperator`) and value enums (`checkEnumOperator`) had a
row.

The table now lives in one module and those two are dispatched to from it rather
than being special cases in `check_expr.yoop`. It was established by PROBING the
reference - 186 programs, one per (operand class, operator) pair, built with
both compilers and diffed - rather than by reading `unifyArith`'s wording. Rows,
where arith is `+ - * / %`, eq is `== !=`, ord is `< > <= >=`, bit is
`& | ^ << >>` and logical is `&& ||`:

    int (any width)            arith  eq  ord  bit  .
    float32 / float64          arith  eq  ord  .    .
    bool                       .      eq  .    .    logical
    value enum, int-backed     .      eq  ord  bit  .
    value enum, string-backed  .      eq  .    .    .
    unsafe_ptr                 .      eq  .    .    .      (arith is its own path)
    variant                    .      eq  .    .    .
    string                     .      .   .    .    .
    struct, array, ref, func,
    vtable, task, void, ...    .      .   .    .    .

The three rows worth naming, because each is a real answer rather than a gap:

  * `==` ON TWO STRINGS IS NOT LEGAL. A `string` is a borrowed view, so it would
    compare ADDRESSES and answer false for two equal spellings.
    `examples/tour/strings.yoop` already says so in a comment and points at
    `text.equals`; nothing was enforcing it.
  * `<` on two BOOLS is not legal while `==` is. No useful ordering on a truth
    value.
  * `==` on two VARIANTS compares TAGS, which is why it is legal at all.

ONE ROW IS LEFT UNGUARDED ON PURPOSE, and it is a decision rather than an
oversight: a TYPE PARAMETER. `function addT<T>(a: T, b: T): T { return a + b; }`
is legal here and is refused by the reference, and it is legal here on purpose -
`comptime.test.yoop:aFoldInsideAGenericRunsAtTheConcreteWidth` asserts that
exact function folds at the operand's concrete width (uint8 200 + 100 wrapping
to 44). But monomorphization happens in CODEGEN, not in pass D: a generic body
is checked ONCE with `T` standing, and no instantiation is ever re-checked. So
`addT` instantiated at `string` still reaches codegen and still emits `add ptr`.
Closing it means a pass D that runs per INSTANCE rather than per body, which is
a different change; refusing `T` outright would refuse a program this compiler
is tested on, which is the one direction that is not allowed. See the header of
`typecheck/operands.yoop`.

Tests: `typecheck.test.yoop:binaryOperatorsCheckTheirOperandCLASSNotJustAgreement`
(19 assertions, and the LEGAL rows are asserted as hard as the refusals -
integers keeping the whole set, floats keeping arithmetic and comparison, bools
keeping `==` and `&&`, variants and pointers keeping `==`, pointer arithmetic
untouched, and an already-failed operand not collecting a second diagnostic) plus
`examples/fail/binary_operand_class`.

One message changed: "logical operands must be bool" is gone, because `&&` on
two non-bools is now the ordinary operand-class refusal and there is one
sentence shape for all of them.

#### A9.2 Recursive types (`typecheck/recursion.yoop`)

`type Node { next: Node }` has no finite size, and LLVM is what said so:
`identified structure type "%struct.m__Node" is recursive`. The mutual form and
any longer cycle were the same, and so was a variant case carrying its own
variant by value.

The check runs at the END of `passCFillShells`, after `materializeInstances`,
which is the earliest point where the fact is in hand: pass A stamps a shell
with no fields, pass C fills them, and a field naming a generic
(`b: Box<Node>`) needs its INSTANCE materialized before the cycle exists to be
seen. The walk descends only through storage that is INLINE - a struct's fields,
a variant case's payload, a union's fields - and stops at everything else, which
is what keeps the four legal shapes legal:

    next: ref Node          a borrow, one address
    kids: Node[]            a { ptr, len } descriptor
    kids: Vec<Node>         the same, one level down
    next: unsafe_ptr<Node>

Those four are the whole reason a self-referential type gets written at all, so
each is asserted, and `codegen.test.yoop:dwarfTerminatesOnASelfReferentialType`
(which uses the `ref` form) still passes untouched.

A mutual cycle reports at BOTH ends rather than one. The reference reports one,
but either field can be the one turned into a `ref` and the reader should see
both.

Tests: `typecheck.test.yoop:aTypeCannotContainItselfByValue` (13 assertions -
direct, mutual, three-hop, variant, and through a generic instance, each beside
its legal neighbour, plus plain composition and a forward reference, which is
the shape that makes a naive walk crash on an unfilled shell) plus
`examples/fail/recursive_type`.

One existing test moved: `typeEqualityIsStructuralAndStopsAtNominals` used
`type Node { next: Node }` to prove type EQUALITY terminates on a
self-referential type. It now uses `next: ref Node`, which is the same nominal
cycle in a spelling that is still a program.

### A10. The `unreachable-code` warning - DONE

The last capability the reference had and the bootstrap did not. 16 JS tests
covered it (`jsyooptypecheck/diverge.test.js`), and

    function main(): int32 { return 0; let x: int32 = 1; }

compiled with nothing said.

Almost all of it was already here. `typecheck/diverge.yoop` answered "does
control always LEAVE this statement" for the handler form of `?`, and the
diagnostic layer already carried a `code` and a `Severity.WARNING` for
`unhandled-disposable`. What was missing was `firstUnreachableIndex` - the same
question asked of a whole RUN of statements, since everything after the first one
that diverges is dead - and one call site.

That call site is `checkBlock` in `check_stmt.yoop`, which every block in the
language funnels through: function and method bodies, both halves of an `if`,
loop bodies, switch arms, the handler block of `?`, and the trailing block of a
block-owning kind binding. Twelve callers, one check, and a block form added
later gets it for free.

A WARNING, never an error, matching the reference and every language that has
this: dead code is a smell rather than a soundness problem, and hard-erroring is
hostile in the middle of editing - comment out a branch, or add a temporary
early return to bisect something, and the build would stop. It is ON by default,
unlike `unhandled-disposable`, and the reason is the conservatism it inherits:
`alwaysDiverges` answers true only when divergence is CERTAIN, so this can never
flag live code and can only miss some dead code. A warning with no false
positives does not need an opt-in.

The statements in a dead tail are still CHECKED, and only the FIRST one is
reported. Unreachable code that also does not compile should say so; and the
tail is dead as a run, so naming every statement in it would bury the one line
the reader has to act on.

MEASURED over the tree, and it agrees with the reference program for program:
15 sites in `std/` and 16 in `examples/pass/`, every one a `return` after a
switch whose arms all return. They are genuinely removable - both compilers
accept those functions with the trailing return deleted - so the warning is
actionable rather than a trap, and it is not new noise: the reference has been
reporting the same 31 all along. Left alone here; cleaning them is a tidy, not a
fix.

ONE DIVERGENCE, and the bootstrap is worse: the reference points at the dead
statement's first token, the bootstrap one token in (`return -1` is reported at
the `-1`). It is not this check - `buildSourcedNode` stamps the CURRENT token
after the keyword has been consumed, so every statement node in the tree is
stamped this way. Same family as the parse-error column item, and worth fixing
in one place rather than here.

Tests: `typecheck.test.yoop:deadCodeAfterADivergingStatementIsWarnedAbout`
(9 assertions - after a return, after a break, after an if whose both arms
return, after an exhaustive switch, each beside the shape that must stay
SILENT, plus "it is a warning and not an error", "a dead run is one
diagnostic", and "a dead statement is still typechecked").

### A7. A kind-propagation check the bootstrap does not make - DONE

The reference refuses

    type Job { work: Task<int32> }

with `field 'work' carries kind 'pooled' but enclosing struct 'Job' does not
propagate it`. The bootstrap ACCEPTED it, and emitted no retain for the field
store - so the handle in the struct had no count of its own and the spawning
scope's release was the last one. This was the bootstrap accepting MORE than the
reference, the unsafe direction and the opposite of every other divergence in
this document.

Measured while fixing it, the gap was WIDER than the one line above. The rule is
not about `Task<T>`; it is about any field whose TYPE carries a kind, and the
bootstrap made none of it:

    type Outer { j: Job }        // Job propagates<pooled>
    type Outer { r: Res }        // Res propagates<disposable>
    type Holder { xs: Vec<int32> }   // Vec propagates<disposable>

All three are refused by the reference and were accepted by the bootstrap. The
third is the shape that actually occurs: nobody writes `disposable` in front of
a `Vec` field, and the vector still has to be freed by somebody. The compiler's
own `Program` propagates `disposable` for exactly this reason.

The check is `checkFieldTypeKindUse` in `typecheck/kind_use.yoop`, called from
pass C's field walk where the field's resolved TypeId is already in hand. It is
the type-side twin of `checkFieldKindUse`, which reads a kind the field WRITES,
and the two are kept from reporting the same field twice.

TRANSITIVITY IS BY CONSTRUCTION, not by a walk. The carried kind is read off the
field type's own `propagates<>` clause, so a `Vec` field makes its holder
propagate `disposable`, and a field of THAT holder has to propagate it too -
each link is one comparison, established one declaration at a time. A forward
reference is answered correctly because pass A stamps the `propagates<>` word on
the shell.

`Task<T>` is the base case and the reason `Program.refcountedKind` now exists:
it is a compiler type with no declaration to hang a clause on, so it carries its
kind by BEING the storage discipline the kind asked for. The name is recorded at
`registerKind`, first registration wins, the same rule the kind registry itself
follows. A graph declaring no refcounted kind has no name to report, so the
check stands down rather than inventing one - which is what keeps the std-less
unit-test graph honest.

TWO DELIBERATE LIMITS, both matching the reference. A variant CASE payload
holding a kind-carrying type is accepted; the hazard is the same one and the
carve-out is not principled, but it is what the corpus is written against and
widening a refusal from inference is not a thing to do. And the field's type has
to be populated, which pass A guarantees for anything in the graph.

ONE DIVERGENCE, and the bootstrap is right: the reference points the diagnostic
at the TYPE declaration, the bootstrap at the FIELD. A type may have several
offending fields and the field is the token to fix.

Covered by 9 unit tests in `typecheck/typecheck.test.yoop` and by
`examples/fail/field_task_not_propagated`.

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

  * `n += 1` ON A `ref` SCALAR PARAMETER - the reference emits `add ptr %n, 1`
    and clang refuses the module, while `n = n + 1` on the same parameter is
    fine. Found writing `ast/dump_json.yoop`, which works around it with a note
    that goes when the reference does.
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

  * DWARF DEBUG INFO. PART DONE - see `codegen/debug_info.yoop`.
    What works: a DIFile and DICompileUnit per source file, a DISubprogram per
    function carrying its MANGLED symbol as the linkage name, a DILocation per
    STATEMENT, and the two named nodes without which clang silently strips
    every bit of it. clang links with `-g`. Verified against a real debugger
    rather than only as IR text: gdb resolves `main` to `hello.yoop:16`, a
    `break hello.yoop:9` stops on the right statement, and a backtrace names
    both frames with their own lines. 7 unit tests.
    THE TYPE SIDE IS DONE TOO - `codegen/debug_types.yoop`. What it describes is
    the layout CODEGEN EMITS rather than the type as the source writes it: an
    `int32[]` is not an array in DWARF's sense, it is the two-word fat pointer,
    and describing it as anything else makes a debugger read the wrong bytes.
    Covered: the primitives, `string` as a typedef over char* (which is what
    makes a debugger print the text), `ref` and `unsafe_ptr` as pointers, the
    fat pointer, structs laid out field by field, a variant as a tag ENUMERATION
    plus a payload, unions, value enums as a named typedef over the underlying,
    vtables, and a `DILocalVariable` plus `llvm.dbg.declare` per local and
    by-value parameter. Subprograms carry a real signature, so a backtrace shows
    `inner (n=5)`.
    The cache is keyed by TypeId, which is the one place the bootstrap is
    simpler than the reference: types are INTERNED here, so the id already IS
    the structural key, and caching it before a composite's members are built is
    what makes a self-referential type terminate.
    NOT described: a `ref` PARAMETER, whose slot is the incoming pointer rather
    than an alloca - there is no address of its own for `llvm.dbg.declare` to
    name. A debugger omits it, which is the right failure; describing storage
    that is not there is not.
    A debugger-driven TEST exists: `src/debug.test.js` (`npm run test:debug`),
    two assertions over `bootstrap/tests/debug/frames.yoop`. It drives gdb or
    lldb, whichever is on PATH, and skips when neither is. It asserts what the
    shape tests cannot - that the debugger resolves `main` to the line the
    fixture declares it on, and that a source-line breakpoint stops on the
    intended statement and unwinds to the intended caller.
    The expected line numbers are LOOKED UP in the fixture by marker comment
    rather than written into the test, because an off-by-one still prints a
    real line of a real file: a test that hard-codes the number agrees with the
    bug as soon as someone edits the fixture. Both assertions were confirmed to
    FAIL with the off-by-one reintroduced.
    It is deliberately a smoke check rather than a port of the reference's five
    `dwarf:` tests; the locals half is what it grows into once the type side
    exists.
  * `--track-heap`. DONE. A counter call beside every `heapAlloc` / `ctxAlloc`
    and every `heapFree` / `ctxFree`, plus the dump installed through `atexit`
    in `main` so an `exit()` or an abort prints the totals too. A free has to
    recover its byte count from the descriptor's length times the element size,
    because a pointer does not know how big it is.
    `examples/pass/track_heap_basic.yoop` prints the same line as the reference,
    byte for byte. A tracked build LINKS the runtime even when the program
    otherwise would not - the counters live there, and without that a
    hello-world compiles to valid IR and fails at the link.
  * `--warn-disposable` and `--warn-std`. DONE, and the analysis with them -
    `typecheck/unhandled.yoop`. A `Diagnostic` now carries a CODE, which is what
    both filters key on and what the next opt-in warning will need.
    The bootstrap already had the hard halves: `propagatedKindOf` says which
    types owe a cleanup, and `discharge.yoop` decides path-sensitively whether a
    manual call answered one. What was missing was the TRANSFER walk, and it is
    stated as an EXCLUSION - anything that is not a borrow, a field read, an
    index read, an assignment target or an interpolation counts as a handoff -
    so a form nobody thought of goes quiet rather than warning about correct
    code. That is the reference's own erring-toward-silence rule.
    An INTERPOLATION is NOT a handoff, and getting that wrong is what the
    differential caught: `${x}` renders through a borrow and hands nothing on,
    and reading it as a transfer silenced every leak that happened to get
    printed - which is most of them.
    The two known false-positive classes are inherited rather than fixed (a
    value in an arena scope, and a copy read out of a container). They are why
    the warning is opt-in, and they are documented in
    docs/writing_yoop.md section 4.
    MEASURED against the reference over 60 corpus files: they agree on
    `arena_request_loop` and on the two in `derive_display_array_vec`, where the
    reference reports each one TWICE. The bootstrap additionally finds five
    genuine unhandled obligations in `derive_display_variant.yoop` that the
    reference misses entirely - `Shape` and `Envelope` both propagate
    `disposable`, and all five bindings are declared without the keyword and
    never disposed.
  * `--dump-ast` and `--dump-ast-json`, plus `src/astViewerTemplate.html`.
    `npm run gen:web` calls `--dump-ast-json` directly.
  * `--list-attributes`. DONE. The list is the parser's - `parse/attributes.yoop`
    is the one place that decides what may follow an `@` - so there is no
    registry to keep in step with it.
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
  3. A2, the task handle refcount retain. DONE.
  4. THE COMPTIME INTERPRETER (A1). DONE - all thirteen `@precompile` files
     compile and run and match the reference. See
     [comptime_interpreter.md](comptime_interpreter.md).
  5. DWARF DEBUG INFO (C). The frame-and-line half is DONE; the type-and-locals
     half is not. See C.
  6. THE REMAINING DRIVER FLAGS (C): `--track-heap`, `--warn-disposable`,
     `--warn-std`, `--dump-ast-json`, `--list-attributes`.
  7. THE `.expected` CORPUS (E, decision 4), and the diagnostic fixture harness
     for `examples/fail/`. THE CORPUS IS DONE - `src/pass.test.js`
     (`npm run test:pass`), 242 hand-written expectations over the 248 programs
     in `examples/pass/` and `examples/tour/`, 6 excluded with a stated reason.
     See the section below. The `examples/fail/` harness exists
     (`src/fail.test.js`) and is at 69 of 140.
  8. PORT THE REMAINING JS UNIT-TEST COVERAGE to Yoop unit tests, subsystem by
     subsystem, deleting each JS file only once its counterpart exists.
  9. REPOINT THE TOOLING (F): `gen_web.mjs`, `gen_std_index.mjs`, the CI job.
 10. DELETE `src/`, `examples/fail`'s JS-side assertions, `build_sea.mjs`,
     `package_release.mjs`, `probe_programs.sh`, and the `npm test` gate.
 11. REBUILD THE LSP as `yoopiler_boot --lsp`, and repoint the VSCode extension.

Steps 5 and 6 do not depend on step 4 and can move if it is convenient. Step 11
is deliberately after the deletion, per decision 3.

## The `.expected` corpus (step 7)

DONE. `src/pass.test.js`, run by `npm run test:pass`, compiles every program
under `examples/pass/` and `examples/tour/` with the BOOTSTRAP, runs it, and
asserts its stdout and exit code against a hand-written `.expected` beside it.
242 of 248 ported, 6 excluded, 0 left.

This is what replaces `scripts/probe_programs.sh`, and the difference is the
point: the probe builds each program with BOTH compilers and diffs the two runs
against each other, which passes happily when both are wrong the same way. The
expectations here were derived by READING each program, so they say what the
program should do rather than what some compiler did.

WHAT IT FOUND. No miscompiles - 242 independently derived expectations and the
bootstrap matched every one. That is a real result and it is only a result
because the expectations were not captured; a captured corpus reports zero
miscompiles by construction.

What it did find is that `examples/pass/` was partly documenting the WRONG
compiler. Several programs carry a trailing `// expected output:` comment and a
number of those record the JS reference's behaviour: `float_literal.yoop` claims
`x=3.140000`, but `${float}` renders through `%g` (`runtime/yoop_format.c`,
deliberately - see `bootstrap/src/codegen/template.yoop`), so the answer is
`x=3.14`. Same class in `casts`, `heap_alloc_struct`, `module_init_folded`,
`at_precompile_externs`, `traits_multi_impl`, `runtime_introspect`. Those
comments are a hint to check, never a source to copy.

THE SIX EXCLUSIONS each carry a `<name>.nondeterministic` marker whose contents
state why; the suite asserts that a marker is never empty and that nothing has
both a marker and an expectation.

  `env_vars`              the output is the environment's, not the program's
  `async_yield_smoke`     two tasks woken on two fds; the order is the
                          scheduler's, and the program's own comment says so
  `hello_server`,         neither terminates - each binds a port and blocks in
  `http_router`           accept for a client the suite never supplies
  `http_client_loopback`  the server task's `server done served=2` and the
                          client task's second `status=` line are not ordered
                          against each other
  `http_concurrent`       whether an over-cap connection gets a 503 or a TCP
                          reset is the kernel's choice

The last two were NOT identified by reading; they were written as expectations,
passed, and were caught by stress-testing. `http_client_loopback` held one order
in 60 unloaded runs and flipped in 5 of 60 with eight busy cores alongside;
`http_concurrent` flipped in 2 of 25 the same way, and was failing `npm test`
intermittently because that suite runs in parallel with `src/e2e.test.js`, which
is load enough. A "verified stable over repeated runs" expectation is an
empirical claim about a machine, not a property of the program, and the corpus
is where that distinction has to be made.

TWO HARNESS RULES the corpus needed:

  stderr is NOT compared. These programs write results to stdout; stderr carries
  the runtime's own diagnostics, which is not what the program asserts.

  every program runs in its OWN directory, with any non-source file beside it
  staged in. Without it a program writing a relative path writes into the REPO
  (`fs_metadata` left a `yoop_fs_meta_test.bin` in the working tree), and worse,
  `src/e2e.test.js` runs some of the same programs from the same cwd in a test
  file node runs in PARALLEL - two runs of `fs_metadata` then create, stat and
  delete one file and whichever loses reports a size for a file the other
  removed. Staging is also what `language_showcase` needs to be portable at all.

`npm test` picks the suite up through its `src/**/*.test.js` glob. `test:unit`
excludes it by name, because that target is documented as fast and clang-free.

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
