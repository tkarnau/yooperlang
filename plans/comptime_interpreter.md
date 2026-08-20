# A comptime interpreter for the bootstrap

Step 4 of [retire_js_compiler.md](retire_js_compiler.md).

WHAT IS LEFT HAS SHRUNK, and by more than stage 0 was expected to. Backing a
non-inlinable module-level const with a real global closed FIVE of the sixteen
files rather than the three predicted, because `comptime_enum_fold.yoop`,
`module_init_folded.yoop` and `examples/playground/shader_demo/` were also
refused for the shape of a const initializer rather than for anything about
evaluation. All five now compile, run, and agree with the reference.

So the interpreter is now needed for `@precompile` AND NOTHING ELSE - the
thirteen `examples/pass/at_precompile_*.yoop` files. Opportunistic module-init
folding has stopped being a correctness requirement and become what it always
was underneath: an OPTIMIZATION, baking a value into a global instead of
computing it at startup. Worth having eventually, and no longer blocking
anything.

That also simplifies the build. `@precompile` is the HARD-ERROR policy, so the
silent-fallback tier does not have to be written to make ordinary programs
safe - there is no ordinary program in the corpus that depends on a fold.

The JS reference is `src/jsyoopinterp/` - 3990 lines across a bytecode IR, a
lowering pass, an interpreter, a value model, an extern whitelist and a
comptime pass. It is a REFERENCE, not something to transcribe.

## Two policies, and only one of them is now on the critical path

  * `@precompile`. A HARD error on failure, with a traceback. The user asked
    for compile-time evaluation; falling back would be a silent semantics
    change, and the fold is often the point (a table nobody wants built at
    startup). THIS IS THE ONE THE REMAINING THIRTEEN FILES NEED.
  * OPPORTUNISTIC module-init folding. Tried on every module-level initializer,
    and SILENT on failure - an ordinary program must never grow a build error
    out of the presence of a comptime engine, or every gap in the interpreter
    becomes a gap in the language. Now an optimization rather than a
    requirement, because the run-time path it falls back to is one every such
    decl already takes.

## Shape: a tree-walking evaluator, not a bytecode IR

The reference lowers the AST to a register bytecode and interprets that. The
bootstrap walks the typechecked AST directly. Three reasons, and the third is
the one that decides it:

  1. The bytecode is a RE-ENCODING of what pass D already decided. The
     bootstrap's arena carries resolved types, deref uses and monomorphized
     bodies on the nodes themselves; lowering would copy all of it into a
     second representation so the evaluator could read it back.
  2. It is most of the code. `bytecode.js` plus `lower.js` is 2370 of the
     reference's 3990 lines. A walk over the arena deletes both.
  3. The one thing the bytecode buys - an explicit frame stack, so a deep
     comptime call does not overflow the host - is not free either way. A
     runaway `@precompile` recursion has to be STOPPED rather than survived, so
     a depth cap is needed in both designs, and the cap is what actually
     protects the compiler.

`bootstrap/src/comptime/` is its own module, not layer 4. The README's layer 4
is a bytecode BACKEND standing where LLVM stands; naming a comptime evaluator
after it would be a lie about what the layer is for.

## Values live in an ARENA

The same shape `ast/arena.yoop` uses, and for the same reasons.

    ValueId = usize                 // 0 is "no value"

    type ValueSlot {
      kind: ValueKind,              // INT FLOAT BOOL STR STRUCT ARRAY VARIANT REF VOID
      typeId: TypeId,               // what pass D resolved it to
      bits: uint64,                 // int payload, float BITS, bool, variant TAG
      text: string,                 // string payload
      childStart: usize,            // run into one shared child table:
      childCount: usize,            //   struct fields, array elements, variant payload
      target: ValueId,              // REF only: the slot it points at
    }

Three things fall out of the arena that a tree of nested values would have to
build by hand, and all three are load-bearing:

  * A `ref` is a ValueId. `ref x` is the id of x's slot, `ref p.field` is the id
    of that field's child slot. Writing through one is writing that slot. This
    is exactly the mutation `module_init_folded.yoop` exercises with
    `offset_point(ref p, 3, 4)`, and the reference had to be careful NOT to
    deep-copy on a ref load to keep it working.
  * A local is a slot, so assignment is a write into it and needs no separate
    cell type.
  * Yoop's value semantics need a DEEP COPY on assignment of an aggregate,
    which over an arena is a clone walk rather than anything structural.

## Where it plugs in

The fold has to happen inside typecheck, because typecheck is what currently
REFUSES a non-literal const initializer (`typecheck/const_init.yoop`, reached
from `pass_c.yoop:529`), and it needs pass D's resolved types to run at all.

The value then reaches codegen through the two slots a literal const already
uses, so nothing downstream learns a new way to be a constant:

  * a scalar rides in `Symbol.Value.intVal`, inlined as an immediate
  * a string, float or aggregate is materialized by
    `codegen/const_data.yoop` and inlined through `Emitter.constOps`

`const_init.yoop` stops asking what SHAPE the initializer has and starts asking
whether a value was folded for it. That is the one real change to an existing
boundary: today the const's value is re-derived from the AST at each use, and
after this the folded value is the single source of truth.

### A prerequisite, and it is not an interpreter problem

Three of the files this step was supposed to close are not foldable at all.
`examples/pass/dir_module/shapes/area.yoop` declares

    export const SCRATCH_B: Vec<int32> = vec.vecNew(8);

which is a HEAP ALLOCATION. No comptime interpreter folds that one, and the
reference does not either: its fold fails, falls back silently, and the const
becomes a global that runtime module-init fills. The same is true of
`comptime_enum_fold.yoop`'s `const C: Shape = Shape.Circle { radius: 4 }`, where
the fold SUCCEEDS and the value still has no LLVM constant spelling.

So the bootstrap's rule that a module-level const is always INLINED has to go
first, and it closes those three files on its own:

  A MODULE-LEVEL CONST MAY BE BACKED BY A REAL GLOBAL, initialized by the same
  module-init path a `let` already uses, whenever its value is not something
  there is to inline. `const` goes back to meaning IMMUTABLE rather than
  meaning inlined, which is what it should have meant; the inlining stays as
  the fast path it always was, for the literal shapes that qualify.

The alternative - refuse a const whose value is not inlinable and fold only its
consumers - was rejected because it leaves `dir_module` refused forever, and
the bootstrap accepting strictly less than the reference is the thing this
whole objective is trying to end.

## Stages

Each stage lands on its own, ships tests, and is measured by the probe.

  0. CONST STORAGE. DONE. A module-level const falls back to a real global with
     a run-time initializer when its value is not inlinable. No interpreter
     involved.
     CLOSED: `examples/pass/dir_module/` (3 files), `comptime_enum_fold.yoop`,
     `module_init_folded.yoop`, `examples/playground/shader_demo/`. The surface
     probe went from 19 refused / 17 sites to 14 / 14, and the program probe's
     bootgap count in `pass` from 17 to 14.
  A. THE EVALUATOR CORE. DONE, in `bootstrap/src/comptime/` - the value arena,
     the width-and-signedness arithmetic, the scope and frame stack, and the
     expression, place, statement and call walks. 46 unit tests.
     Handled: literals, unary / binary / bitwise / comparison / logical with
     short-circuiting, casts, locals and assignment, `if` / `while` /
     `for (;;)` / `for x in arr` with `break` and `continue`, blocks, `return`,
     direct calls including recursion and nesting, struct literals with field
     read and write, array literals with index read and write and `.len`, `ref`
     to a local / field / element with mutation through it, and reads of a
     const folded earlier in the same walk.
     Refused by name, and bounded: an out-of-range index, a division by zero, a
     shift past the width, a call more than MAX_CALL_DEPTH frames deep, and a
     loop past MAX_LOOP_ITERATIONS. The last two are runaway guards - what they
     stop is a build that HANGS, which reads as a slow machine rather than as a
     bug.
     CLOSES: nothing on its own - it is the machinery C needs.

     ONE CHANGE OUTSIDE THE MODULE, and it was a real bug waiting to happen.
     Pass D only decorated a module-level initializer it believed codegen would
     EMIT, so an inlinable const's initializer had no resolved types at all.
     The evaluator reads those types to know an integer's width, and a width of
     zero masks a value to ZERO - so `const A: int32[] = [10, 20, 30]` folded to
     three zeros, silently, and every operation downstream agreed. Pass D now
     decorates every module-level initializer, and `maskToWidth` treats a width
     of zero as nothing to mask rather than as everything to discard.
  B. VARIANTS AND SWITCH. DONE, in `comptime/eval_variant.yoop`. 10 more unit
     tests.
     A variant value is a TAG plus that case's payload fields - `bits` holds the
     ordinal and the child run holds the fields - so a payload-less case is an
     empty run rather than a different shape. Construction fills fields by
     POSITION, so a constructor may list them in any order; a pattern binds them
     back by name, and a binding names the payload's own SLOT rather than a copy.
     `==` on two variants compares TAGS and nothing else, matching the emitted
     code.
     `switch` is a walk rather than a jump table - the arms are tested in order
     and the first match runs, which is the same answer a table gives because
     pass D already refused a duplicate pattern. It covers literal patterns
     (including several sharing an arm, and a negated one), variant patterns,
     value-enum patterns, and a `default` that runs only when nothing else
     matched wherever it is written. A `break` in an arm leaves the SWITCH and
     not an enclosing loop.
     A VALUE ENUM is not a variant: it is a nominal alias over a primitive, so
     `Color.Red` evaluates to the constant its case carries and nothing
     enum-shaped is ever built. Same split codegen makes.
     ONE ORDERING MIRRORED ON PURPOSE: `FIELD_ACCESS` tests the struct case
     BEFORE the variant one. A field whose own type is a variant makes `a.value`
     look exactly like a payload-less constructor, and reading it as one folds
     to case 0 with an empty payload - silently. That mistake cost the reference
     its third self-compile stage.
     CLOSES: nothing on its own; needed by the `@precompile` files that switch.

     NOT YET WIRED. Nothing outside the tests calls `foldExpression` - the
     evaluator is complete through stage B and the compiler does not run it.
     Stage C is what connects them.
  C. `@precompile`, INITIALIZER FORM. DONE, in `comptime/precompile.yoop`. 7
     more unit tests plus `tests/slice/precompile_const.yoop`.
     The fold puts a LITERAL back in the AST in place of the initializer, which
     is the whole design: const inlinability, const materialization and codegen
     all read the answer the ordinary way and none of them learns that a
     comptime evaluator exists. The alternative was a side table of folded
     values threaded through three layers, and a literal is what the fold
     produced anyway.
     It runs BETWEEN typecheck and codegen, from the driver. It needs pass D's
     resolved types so it cannot run inside typecheck, and its failures are
     diagnostics with source locations, which codegen has no channel for.
     The policy is the opposite of an opportunistic fold: a failure is a build
     ERROR, and it points INSIDE the folded code - a divide by zero three frames
     down names the division rather than the decl.
     CLOSED: `at_precompile_basic.yoop`, `at_precompile_dispose.yoop`,
     `at_precompile_generics.yoop`. Surface probe 14 refused / 14 sites -> 11 /
     11; program probe 207 ok -> 210 ok in `pass`.

     TWO BUGS FOUND WHILE BUILDING IT, both worth recording.

     `disposable ids = ...; return ids;` in two helpers FREED the vector and
     handed back the pointer. Every unit test passed - std/test.yoop gives each
     suite an arena that never reclaims, so a use-after-free is invisible there
     - and the real compiler segfaulted on the first call it tried to fold. The
     obligation TRANSFERS through `propagates<disposable>` on the return type;
     declaring the local disposable as well is what discharged it early.

     A fold inside a GENERIC body ran at the wrong width. A generic is checked
     once with its parameters standing, so the decoration says `T`, and a type
     parameter has no width - `200 + 100` at uint8 folded to 300, and the answer
     was only corrected by a downstream truncation. Right by accident, and wrong
     the moment the value is read back. Arithmetic now prefers the operand
     VALUE's own type, which carries concreteness inward from the arguments the
     way monomorphization does, and the literal is normalized to the const's
     declared type at the boundary as well.
  D. THE EXTERN WHITELIST. DONE, in `comptime/externs.yoop`. 3 more unit tests
     plus `tests/slice/precompile_externs.yoop`.
     The math half is NOT reimplemented: the compiler is a native binary, so it
     calls the same libm the compiled program would. That is the only way to be
     sure a folded `sqrt(2.0)` is bit-identical to the one the program would
     have computed - a reimplementation is a second answer to the same question,
     and the two drift. `strlen` and `strcmp` are pure string work and are done
     here; `strcmp` normalizes to -1 / 0 / 1, because real `strcmp` promises
     only the SIGN and normalizing is the answer that cannot disagree with a
     libc.
     TWO DELIBERATE OMISSIONS from the reference's list, both refused by name.
     `yoop_now_ns` folds the BUILD's clock into the binary, which makes the
     output depend on when it was built; `yoop_errno_get` reads a thread's
     errno, which at compile time is the compiler's own. Neither is pure, and
     no program in the corpus folds either.
     CLOSED: `at_precompile_externs.yoop`. Surface probe 11 -> 10.
  E. TRAITS AND VTABLES. DONE, in `comptime/eval_method.yoop`. 2 more unit
     tests. (Generics closed back in stage C - a body walked with concrete
     argument VALUES needs no monomorphization.)
     `Name.member(...)` is four different things and none of them is a plain
     call: a static TRAIT dispatch, BUILDING a vtable, dispatching THROUGH one,
     and a function in another module. The first three are told apart by what
     the arguments turn out to BE, which is the natural question for an
     evaluator - a receiver that evaluates to a vtable dispatches through it,
     and one that evaluates to a struct dispatches on its own type. Codegen has
     to ask pass D instead, because it has no values.
     A vtable VALUE remembers two things: which concrete type is behind it and
     where that value lives. That is what the emitted vtable holds too, with the
     method lookup deferred to the dispatch rather than stored.
     The base is resolved by NAME rather than by its resolved type - a trait or
     vtable in that position is a TYPE NAME and pass D never checked it as a
     value, so it carries no resolved type at all, exactly as `Shape.Empty`'s
     base does.
     CROSS-MODULE calls came with it: a method's body lives wherever its type
     was declared, so the frame already had to swap modules, and `ns.fn(...)`
     is the same swap. Verified end to end on a two-file program.
     CLOSED: `at_precompile_traits.yoop`, `at_precompile_vtable.yoop`. Surface
     probe 10 -> 8; program probe 210 ok -> 212 ok in `pass`.
  F. THE REST. DONE. `?` and its context and `Into` forms, template literals,
     the `@precompile { ... }` BLOCK form, comptime `printf` and `log`, and task
     `wait`. 7 more unit tests plus `tests/slice/precompile_block.yoop` and
     `tests/slice/precompile_task.yoop`.

     `?` PROPAGATION travels as a MARKED ERROR rather than as a third Result
     case, so the evaluator's own `?` unwinds it through every enclosing
     expression for free and `runFrame` catches it - which is exactly `?`'s
     scope, one function. The context form concatenates when both payloads are
     `string` and calls `withContext` otherwise; a cross-shape `?` calls `into`.
     Both run in the FAILURE branch, so the success path costs nothing.

     TEMPLATE LITERALS render the way the RUNTIME would, or a folded string
     would say something the same program does not. An integer renders in
     decimal at its own signedness, a bool as `true` / `false`, a string as
     itself. A FLOAT is refused by name: reproducing a libc's `%g` exactly - its
     precision, its exponent threshold, its trailing-zero trimming - is a second
     answer to the same question, and a wrong string is worse than a refusal.

     THE BLOCK FORM binds every module-level `let` that folds, runs the
     statements, and writes each binding's final value back as the decl's
     initializer. An integer global's value also rides in its SYMBOL, which is
     what codegen bakes into the LLVM global; without that the literal sits in
     the tree and the global still starts at zero.

     COMPTIME OUTPUT is the one exception to the purity rule, deliberately: a
     block that logs was written to say something DURING THE BUILD, and refusing
     it would refuse the point. `printf` and the `yoop_log_*` trio write to the
     build's log marked `[comptime]`, never to the program's output.

     TASK `wait` is the identity. There is no scheduler at compile time, so a
     task call already ran synchronously and its handle IS its result; `joined`
     and `pooled` differ in handle lifetime at run time, which has nothing to
     say about a fold.

     CLOSED: `at_precompile_qmark.yoop`, `_qmark_context.yoop`, `_qmark_into.yoop`,
     `_block.yoop`, `_printf.yoop`, `_log.yoop`, `_tasks.yoop`.

## Done

All thirteen `@precompile` files compile and run, and every one matches the
reference. The surface probe went from 16 refused when this document was written
to ONE - and that one is not a comptime problem at all, it is the task-handle
refcount (A2 in retire_js_compiler.md). The program probe's `pass` group is 218
ok with a single bootgap, the same file.

Two bugs found while building it are worth keeping, because both were invisible
to a green test suite:

  * `disposable ids = ...; return ids;` FREED the vector and handed back the
    pointer. Every unit test passed - std/test.yoop gives each suite an arena
    that never reclaims, so a use-after-free is invisible there - and the real
    compiler segfaulted on the first call it tried to fold. A green suite is not
    evidence of correct ownership.
  * A blanket decoration gave a synthesized struct literal's FIELD nodes the
    STRUCT's type, and codegen stores a field at `typeOf(fieldNode)` - so it
    emitted `store %struct.Point 140` into an i32 slot. Every synthesized node
    now records its own type. A negative value had the same shape of bug: the
    literal's `flagA` is read by the const-data path and IGNORED by `emitExpr`,
    so `-140` came out `140` wherever a global's initializer is emitted as
    instructions. It is a unary minus over the magnitude now, which both paths
    agree on.

## Verification

Per stage: Yoop unit tests beside the module for anything checkable without a
binary (a folded value, a refusal, a traceback), and a slice fixture with a
hand-written `.expected` for anything that has to reach one. The surface probe
is the measure of a stage being done, and no stage may move the program probe's
DIFFER count.
