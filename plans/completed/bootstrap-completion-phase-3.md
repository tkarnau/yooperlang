# Bootstrap completion - phase 3, the semantic features

Landed. Extracted from [../bootstrap-completion.md](../bootstrap-completion.md).
Items 3.1 through 3.7 - the derive expansion, generic trait instantiation,
async/await and coroutines, the vtable erasure, the task half, the Task
intrinsics, and the other two `?` surfaces.

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

