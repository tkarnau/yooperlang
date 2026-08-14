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

**This file was 4136 lines on 2026-08-14 and is now the LIVE plan only.**
Forty-three of the fifty-one tracked items have landed, and their write-ups
moved to [completed/](completed/) so that what is still open is readable in one sitting.
Nothing was deleted; the index below says where each phase went. The measured
probe chain - the clearest record this project has of how one gate moves a whole
import closure - is in
[completed/bootstrap-completion-probe-history.md](completed/bootstrap-completion-probe-history.md).

---

## The landed phases

- [completed/bootstrap-completion-phase-1.md](completed/bootstrap-completion-phase-1.md) -
  the cheap parser gaps. Items 1.0 through 1.8: a borrow held as a value, `...`
  variadics, value `enum`, `?` propagation, non-literal module consts, floats,
  type-parameter bounds, and the long tail.
- [completed/bootstrap-completion-phase-2.md](completed/bootstrap-completion-phase-2.md) -
  the codegen bugs. Items 2.0 through 2.13: the comptime-folded const on the
  critical path, extern collisions, structural Func comparison, runtime linking,
  `break` in a switch arm, transparent aliases, nested `ref` paths, forwarding a
  `ref` parameter, the `Into` half of `?`, propagated disposal, std autoloads.
- [completed/bootstrap-completion-phase-3.md](completed/bootstrap-completion-phase-3.md) -
  the semantic features. Items 3.1 through 3.7: the derive expansion, generic
  trait instantiation, async/await and coroutines, the vtable erasure, the task
  half, the four `Task<T>` intrinsics, and the other two `?` surfaces.
- [completed/bootstrap-completion-phase-4.md](completed/bootstrap-completion-phase-4.md) -
  parity and the self-compile. Item 4.2 is THE MILESTONE: the bootstrap compiles
  itself to a byte-identical stage2/stage3 fixpoint. Also 4.3 (the program
  probe) and 4.4 (the edit-verify loop, 271 seconds to 161).
- [completed/bootstrap-completion-phase-5.md](completed/bootstrap-completion-phase-5.md) -
  the long tail. Items 5.1 through 5.12, twelve items in one pass, which emptied
  the invalid-IR bucket.
- [completed/bootstrap-completion-probe-history.md](completed/bootstrap-completion-probe-history.md) -
  every re-probe, in the order the items landed.

---

## Where this stands, measured

**Re-probed after the whole of the 2026-08-14 pass - nine items in one batch.**
The surface probe over every non-test `.yoop` under `std/`, `examples/pass/` and
`bootstrap/src/`:

    225   compile all the way to an executable
    224   reach clang and fail ONLY for having no `main` (a library compiled
          standalone), so 449 files are done
    0     reach clang and produce invalid IR - the bad-ir bucket stays EMPTY
    0     fail to LINK a runtime symbol
    21    stop earlier, at a named parse or typecheck refusal
    19    distinct refusal sites

Against 222 / 208 / 430 / 0 / 26 / 22 before the pass: 19 more files done, five
fewer refusals, three fewer sites.

**Eighteen of the nineteen remaining sites are DELIBERATE**, and the distribution
is now almost entirely one thing:

    13 files  `@precompile` - out of this plan's scope by design
     5 files  a module-level `const` needing comptime (a CALL, a struct literal,
              a non-int literal) - the same scope note
     1 file   `expected IDENT, got COMMA`
     1 file   `no stack slot to borrow "X"` - `ref` on a module-level GLOBAL,
              found by 5.14 and now the honest content of bucket 2.2
     1 file   copying a `Task<T>` handle that is not a fresh spawn

So what the corpus is waiting on is comptime, which comes back self-hosted, plus
three one-file gaps. `union`, the module-level `let` and reserved-word names are
gone from this list entirely.

The program probe - every entry point under `examples/` that declares a `main`,
built with BOTH compilers, RUN, and compared on stdout and exit code:

    group        total    ok  differ  bootgap  stale
    pass           244   204      20       19      0
    intro            4     4       0        0      0
    tour            11    10       1        0      0
    playground      19     6       3        5      5

224 of 278 agree exactly, against 218 of 279 before the pass. Every DIFFER
sampled is the same reference bug in reverse - the bootstrap renders a `bool` as
`true` and a float in shortest form where the reference prints `1` and
`1.500000` - so the bootstrap is the correct side of all of them.

---

## Open items

### 2.2 Whatever the next probe finds - OPEN, a rolling bucket

Both entries it once held are closed: `enum_eq.yoop`'s `icmp requires integer
operands` went with item 5.12, and the non-recursive structural Func comparison
went with the phase-2 pass (both written up in
[completed/bootstrap-completion-phase-2.md](completed/bootstrap-completion-phase-2.md)).
What remains of the item is the standing obligation: after each pass, re-run BOTH
probes with stage1 and with stage3, and record what they find here. The bucket
grows before it shrinks, which is expected - a file that stopped at a parse
refusal has never had its codegen exercised at all.

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

- **The layer-2 AST parity dump (was item 4.1), DEFERRED 2026-08-14.** A
  normalized tree format, so the two parsers can be diffed. The two ASTs differ
  in shape - NODE_LIST wrappers and annotation nodes here, plain arrays and
  annotation objects in JS - so the normalizer has to come first. Deferred rather
  than built because it hardens a diff against the compiler being deleted: the
  parity corpus is the one test level designed to retire with the JS side, and
  what it would protect is already covered by the slice fixtures and the
  self-host fixpoint, neither of which needs the JS side to exist. Build it only
  if a parser bug appears that the fixtures cannot localize.
  One divergence is parked with it, found by 5.15: an extern `name: ref T`
  parameter is not CANONICALIZED. The reference rewrites `kind: ref FILE` into
  `ref kind: FILE`, setting `isRef` and unwrapping the annotation; the bootstrap
  leaves `flagA` false and keeps a `TYPE_ANNOTATION_REF_TYPE` in `childA`. Both
  compile and run the same, so it is benign until something diffs the trees.

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

## Tasks before being done here: 1 / 50

**One in-scope item left, of fifty tracked, and it is a standing obligation
rather than a piece of work.** This is the work IN FLIGHT,
not the follow-ups above - those are deliberately deferred past self-hosting and
are not counted here.

Open:

    2.2   whatever the next probe finds (a rolling bucket)

Closed since the last count, ALL OF THEM on 2026-08-14 and all written up in
[completed/](completed/):

- **4.5, `yoopiler --test` in the bootstrap driver.** The one that mattered most:
  it was the last thing the reference DRIVER did that the bootstrap could not.
  `--test bootstrap/src` reports 1020 passed, 0 failed, and the TAP is
  byte-identical to the reference's over all 1225 lines. The bootstrap can run
  its own test suite.
- **5.13, `union`.** The last real machinery in the plan.
- **5.14**, a module-level `let` with a non-literal initializer, and **5.17**, a
  `void` main's exit status - together, because both change what `main` emits.
- **5.15**, reserved words as names, which deleted a parser special case rather
  than adding one.
- **5.16**, the double dispose - the only correctness bug in the set.
- **5.18**, a field carrying a kind by prefix, and **5.19**, the `modules/`
  import root.

**Nine items in one pass, and the numerator went 10 to 2.** The whole batch holds
the self-host fixpoint: stage2 and stage3 are byte-identical with all of it
merged, 1062 bootstrap unit tests pass, and the slice suite is 187 pass / 0 fail.

**4.1, the layer-2 AST parity dump, is DEFERRED rather than done**, and so comes
off both numbers per this plan's own rule. It would build a normalized tree diff
against the JS parser, which is the thing being retired - the parity corpus is
the one test level designed to retire with it. The work it would protect is
already protected by the slice fixtures and the self-host fixpoint, neither of
which depends on the JS side existing. It moves to the follow-ups with the one
divergence that was waiting on it.

**So nothing is left but the measurement obligation.** Nothing in the corpus is
waiting on a feature.

Four REFERENCE bugs were found along the way, none of them previously known, and
all recorded rather than fixed because that side is being retired: `appliesTo`
sites populate only for an IMPORTED kind; a nested modules root is reported by
throwing an uncaught JavaScript `Error`; an ARRAY of unions is an internal error;
and an assignment after a manual dispose never rearms the obligation, so the
reference leaks on the language's own documented idiom for a mutable kinded
binding.

**Keep this counter current.** Update BOTH numbers whenever an item closes or a
new one is added, in the same edit that marks the item itself - a stale counter
is worse than none. Expect the denominator to GROW: twenty-five of the forty-six
were not visible when this plan was written, because each landed feature exposes
the next blocker behind it. That is the process working, not scope creep. An
item that turns out to be deferred rather than done moves to the follow-ups list
and comes OFF both numbers.
