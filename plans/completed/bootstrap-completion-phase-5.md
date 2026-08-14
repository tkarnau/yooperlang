# Bootstrap completion - phase 5, the long tail

Extracted from [../bootstrap-completion.md](../bootstrap-completion.md). Items
5.1 through 5.12, plus the re-probe that closed them out. Items 5.13 through
5.19 are still open and stay in the live plan.

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


---

### 5.18 A field carrying a kind by PREFIX - DONE 2026-08-14, 1 site

    type Session propagates<disposable> {
      handle: disposable FileHandle,
    }

The clause says the obligation belongs to the fields, and `propagatedFieldsOf`
counted a field as supplying the kind only when its own TYPE propagates it.
`FileHandle` implements `Disposable` OUTRIGHT and propagates nothing, so its
type answered no and the field's own annotation was never read - the type
propagated a kind no field appeared to carry, and the binding was refused with
`"s" is disposable and Session propagates it, but no field of Session carries
it`.

The sizing in the brief held. `Type.Field` gained a `carriedKind: string`, pass
C fills it from the annotation's KIND_PREFIX list, and `propagatedFieldsOf`
takes either answer. Five `Field` construction sites moved with it: struct
fields, variant case fields and vtable slots in pass_c.yoop, and the two
substitution sites in generics.yoop. `carriedKind` survives substitution
unchanged, because it is a property of how the field was WRITTEN rather than of
the type a parameter resolved to.

**Codegen needed no change at all,** which is the part worth keeping. A
propagated disposal already records `ownerType: field.fieldType` and calls
`methodSymbolName` against it, so a carried-kind field emits
`call void @Handle__close(ptr %t1)` through exactly the path a type-propagating
one does. The two spellings differ only in how the field QUALIFIES.

One message split, because two ways to reach one refusal are two different
mistakes. A field that qualified by PROPAGATING but has no such method wants a
second level of chaining, which is unbuilt. A field that qualified by CARRYING
the kind is claiming something its type cannot do, which is a bad annotation
rather than a missing feature, and now says so.

**A reference BUG found while writing the fixture, and it is why
`examples/pass/propagates_full` has its own `io.yoop`.** The reference only
populates a kind's `appliesTo` site set for an IMPORTED kind: a kind declared in
the same module as the field that carries it reads back as `appliesTo: (none)`,
and the field prefix is refused with `kind 'tracked' does not apply to fields`.
Reduced to five lines and confirmed in both directions - the identical program
with the kind moved to a second file compiles clean. The bootstrap does not
enforce `appliesTo` at all, so it accepts both; the slice fixture imports its
kind to stay inside the intersection.

Tests: four assertions in `typecheck.test.yoop` (the carried spelling supplies
the kind, the same field with no prefix is still refused, a carried kind whose
type has no such method gets the new message, a prefix naming a DIFFERENT kind
supplies nothing), plus `bootstrap/tests/slice/dispose_carried_kind.yoop` with a
hand-written `.expected` that runs identically under both compilers. The mixed
case is the one that earns its keep: `Both` has one field of each spelling, and
the reverse-field-order rule has to hold ACROSS the two rather than appending
the carried ones after.

`examples/pass/propagates_full/main.yoop` still does not build, and that is
expected rather than a miss: its remaining blocker is `pooled`, which this plan
lists among the deliberate refusals. This item closed the site, not the file.

### 5.19 The `modules/` import root - DONE 2026-08-14, 1 example directory

`import { ... } from "modules/math"`, refused by name in
`source_graph/walk.yoop`. `examples/modules_demo/` is built entirely around it,
so it was the one example DIRECTORY the bootstrap could not build at all. It
builds and runs byte-identically under both compilers now.

The rule, read off `src/jsyoopdriver/moduleGraph.js`: `modules/<name>` resolves
against the nearest `modules` directory at or above the IMPORTING file. The
walk starts at that file's own directory, so a program with `modules/` beside
its entry works, and **the FIRST hit wins whether or not it holds the requested
name.** That last clause is the safety property rather than an optimization -
continuing past the first root would let a stray `modules/` in a home directory
answer for a program's own, turning a typo into a resolution from somewhere the
reader never looks.

Two roots with two owners, and that is the whole reason this is not shaped like
std-root discovery: `std/` belongs to the COMPILER and is found once beside the
executable, while `modules/` belongs to whoever is being compiled and is
answered per IMPORT from their own source. It lives in its own
`source_graph/modules_root.yoop` rather than growing `resolve.yoop`.

**The nested-root check came along, and the brief had not sized it.** A module
under a modules root may not carry a root of its own. This is enforced rather
than left to convention because the failure mode is otherwise invisible until it
is baffling: a module id is derived from the resolved PATH, so two copies of one
module at two paths get distinct mangled symbols and LINK FINE, then fail on the
first value passed between them as "Value is not assignable to Value". Leaving
it out would have been the silent-wrong-thing this plan's rule 5 exists to
prevent.

The bootstrap walks UP from the target to the root where the reference walks
DOWN from the root to the target. Same set of intermediate directories and it
needs no path split, but it has one trap the down-walk does not: the target
directory ITSELF has to be the first thing checked, since `modules/math`
resolving to `<root>/math` makes `<root>/math/modules` the exact case the check
exists for. Starting one level up walks from the root and checks nothing.

A DIVERGENCE, and the bootstrap is better: the reference throws an uncaught
`Error` for a nested root, so the user gets a JavaScript stack trace. The
bootstrap reports it as an ordinary diagnostic with the same text.

One case deliberately not built: a `modules` directory at the FILESYSTEM ROOT is
not consulted, because the walk ends when `dirName` runs out of path. The
reference does consult one. Nothing can be there in practice.

Tests: five assertions in `source_graph.test.yoop` over a fixture tree with two
nesting depths under `bootstrap/tests/graph/` - an entry beside a root resolves
against it, an entry two levels below the nearer root gets the NEARER one, a
nested root is refused by name, and a miss names the root that was searched. The
two roots hold the same module under the same import path and differ only in
what `whichRoot` returns, so which root answered is observable as an exit code
rather than as a path the test has to spell out. Both compilers agree on all of
it.

### 5.15 Reserved words as NAMES - DONE 2026-08-14, 1 site

`function fputs(type: string, kind: ref FILE): int32;` parses now. C headers
spell arguments `type`, `enum` and `in`, and an extern signature mirrors a C ABI
it does not get to rename, so a generated binding used to need a hand edit on the
first collision.

**The reference has TWO name parsers, and copying that split is the whole
design.** `parseIdentAsName` refuses a reserved word by name, with a hint on the
three words that carry real grammar where an identifier is also legal - `in`,
`from`, `as` - saying what each is needed for. `parseIdentOrKeywordAsName`
accepts any identifier-shaped token and is wired to the positions where a name is
METADATA rather than a binding. A third piece, `atReservedUsedAsName`, is a
two-token test that lets the ordinary parameter loop ENTER on a reserved word, so
the refusal reads as the reserved-word message rather than as "expected rparen".
All three are in the bootstrap's `parse/names.yoop` now.

One structural difference the bootstrap had to work around: it shares ONE
`parseFunctionParam` between externs, ordinary functions, function-type
annotations and kind operations, where the reference does not. It split into
`parseParamWithName(ref ps, keywordNameOk)` behind the old name plus a new
`parseExternFunctionParam`, and only the extern block calls the second.

Accepting: struct FIELD names and variant payload FIELD names (they share
`parseFieldDecl`), variant CASE names, enum CASE names, extern PARAMETER names,
the right of a field access, struct-literal field names, and both halves of a
variant PATTERN. Still refused, each BY NAME: an ordinary function parameter, a
local `let` or `const`, a `type`/`variant`/`enum`/`trait`/`kind` declaration's
own name, a function's own name, a type parameter, an import specifier, and a
pattern's RENAME target - that last is a new local in the arm's scope, where a
keyword would shadow a grammar role.

**A special case DELETED, which is the nicest thing to come out of it.**
`Reader.from(ref s)` was handled in the postfix loop behind a
`VTABLE_FROM_MEMBER` const and a `peekAheadIsLParen` helper, gated on a following
`(`, because `from` is a keyword token. The right of a `.` now accepts any
keyword, so the const, the helper and the special case are all gone, and
`l.from.x` - which used to be refused - parses as an ordinary field access,
matching the reference.

`isKeywordTag` is written out as a switch over the 44 keyword spellings rather
than read off `fillKeywordList`. Every caller is a one-token test and that table
is two heap vectors built per file.

Tests: fourteen assertions in `parse.test.yoop` across two suites, one per
accepted position and one per refusal. The refusals check the MESSAGE - including
that the parameter case is not reported as a missing `)`, which is the whole of
what `atReservedUsedAsName` buys, and that `in`, `from` and `as` each carry their
hint. One existing assertion was rewritten: `l.from.x` was asserted to be refused
and is now asserted to be a FIELD_ACCESS chain. `tests/slice/reserved_words`
takes it to an executable, because the name TRAVELS - it is what pass C looks a
field up by, what the switch lowering matches a case on, and what codegen geps
against.

The one corpus file that wants this also wants `union` (5.13), so it finishes no
corpus file on its own, as expected.

### 5.13 `union` - DONE 2026-08-14, 2 sites, 4 files

The last real machinery in the plan. `%union.<mod>__<Name> = type { [N x i8] }`, a
byte buffer sized by the largest field with no field list at all, because the
fields overlap. Four new files - `parse/unions.yoop`, `typecheck/unions.yoop`,
`codegen/union.yoop`, `codegen/instr_union.yoop` - plus small dispatch edits,
about 500 lines.

**The read path was the risk and the way it was contained is the lesson.** The
bootstrap's structs are SSA aggregates: a read is a load plus `extractvalue`, and
there is nothing to reinterpret an aggregate as. A union field read is instead
"the union's own address, loaded at the field's type" - the variant-PAYLOAD
shape. The entire change to the SHARED path is two early returns guarded on
`isUnionAt`, which answers false for every type that existed before this item, so
the IR for every non-union program is unchanged BY CONSTRUCTION rather than by
testing. `emitStructFieldRead` was not touched at all. `emitFieldAddress` grew one
branch at the TOP, ahead of the ref, index and nested-field cases, because each of
those adds a field index to a base address and a union has none to add.

**Deliberately NOT a `Type.Union` case on `lookupField`.** That function hands
back a field POSITION, and a position is the one thing a union does not have. A
separate `lookupUnionField` means a caller reaching a union through the struct
path gets `found: false` rather than a plausible-looking index 0.

`c.channels.r` is the shape worth knowing: a struct read layered on a union read.
The union read loads the whole `%struct.Channels` out of the union's address and
the ordinary extractvalue picks `.r` out of that, so the two paths compose without
either knowing about the other.

Nothing tracks which field is live. Deliberate, and the same bargain C makes.

A DIVERGENCE where the bootstrap is better: an ARRAY of unions works here and is
an internal error in the reference (`arrayElemLlvmName: unsupported elem type
"union"`). Representational - the reference names one `%yoop_array.T` per element
type and has no spelling for a union, while the bootstrap uses one anonymous
`{ ptr, i64 }` descriptor for every element type. The slice fixture avoids the
shape so its `.expected` stays assertable against both.

Tests: 16 typecheck assertions (shell and fill, layout, the refusals), 4 codegen
IR-shape assertions, and `tests/slice/unions.yoop`. `examples/pass/union_rgba.yoop`
builds and runs identically under both compilers. The fixpoint held, which is the
direct evidence the read-path edit moved no struct read in the compiler's own
40,000 lines.

### 5.16 A DOUBLE DISPOSE after a manual discharge - DONE 2026-08-14, 1 file

The only correctness bug among the remaining items, and it is closed:
`examples/tour/ep08_kinds.yoop` prints `close 3` exactly ONCE now, and the whole
file is byte-identical between the two compilers.

The satisfied-set lives in typecheck, in two new files beside `diverge.yoop` -
`discharge.yoop` for what an obligation is and what counts as discharging one,
`discharge_walk.yoop` for the traversal and the merge at each join. Codegen
consumes the answer by SKIPPING a pending entry rather than computing anything.

**The EXIT SITE is the key, not the binding, and that is the whole shape.** The
same binding in the same function gets two different answers depending on where
you stand: a `return` placed before the manual call still owes it, the closing
brace past the manual call does not. So every unwind site now carries the node it
is standing on.

The satisfied set is a `uint64` BITMASK rather than a parallel `Vec<bool>`, so
snapshot, restore and intersect are a copy and an `&` with nothing to allocate -
which matters because an `if` inside an `if` inside a loop wants one of each per
level. Ceiling of 64 live obligations per function, past which nothing is marked,
which reads as "not discharged" and disposes.

Conservative in every direction it is unsure, and that is deliberate: emitting a
call twice is the bug being fixed, but skipping one that was never made is a leak,
which is worse. A loop body may run zero times so it discards what it satisfied;
an `if` with no `else` can never discharge; a diverging arm is left out of the
intersection rather than counted in.

**A SECOND DIVERGENCE, and it turned up by probing rather than from the sizing:
an ASSIGNMENT REARMS the obligation.** `Disposable.dispose(ref s); s = next;` is
the pattern `std/core/kinds.yoop` documents as the informed opt-in for a mutable
kinded binding, and the reference never clears its satisfied flag - so it emits no
scope-end call at all there and leaks the new value. Matching that would have
turned this fix into a regression, so the bootstrap clears the bit on a bare NAME
assignment. Covered by a `.bootonly` fixture.

The fixpoint mattered more than usual here, since `propagates<disposable>` appears
48 times across 25 of the compiler's own files. It held, and the reason is worth
recording: nothing in std, examples or `bootstrap/src` disposes a KINDED binding
by hand, so the compiler's own emitted code is unchanged.

Tests: 19 assertions in `discharge.test.yoop` over both branches, one branch only,
no `else`, a diverging arm, a `while` body, a `for` body, early returns on both
sides of the manual call, a different binding, a by-value hand-off, the rebind and
a field write. Two slice fixtures, one asserted against both compilers and one
`.bootonly` for the rebind.

### 5.17 `function main(): void` has no defined exit status - DONE 2026-08-14

Both compilers emitted `define void @main()`, ABI-illegal for C's entry point: with
no `ret` value nothing writes the return register, so the exit status was whatever
the last call left in it. A `void` main is now `define i32 @main()` and every way
out hands back 0.

**Two `ret` sites, and they had to move together**, because `ret void` inside a
function returning `i32` does not verify - a compiler that fixed only one would
fail to BUILD such a program rather than fail to run it. The emitted return type
is switched at `emitFunctionOpen` while `retTy` keeps saying `void`, because that
is still what the BODY returns and what `?` and the coroutine trailer read. Fixed
on the JS side in the same change, since the defect was shared and a slice
`.expected` is asserted against both.

No existing expected exit code moved: nothing in the tree had a void `main` except
the one playground file.

### 5.14 A module-level `let` with a non-literal initializer - DONE 2026-08-14, 2 files

An INTEGER literal is still baked into the LLVM global; everything else - a call,
an array literal, a struct literal, a string, a float, a template - gets
`zeroinitializer` plus a store at run time out of
`define internal void @<mod>__module_init<N>()`, one per SOURCE FILE that owes
one. `main` calls every one before a line of user code, in the module graph's
TOPOLOGICAL order, which falls out of the globals pre-pass that already walks the
graph leaves-first.

The split is decided in exactly ONE place, `moduleGlobalIsBaked` in pass C,
because three passes have to agree on it: pass C fills the symbol from it, pass D
decorates an initializer only when it will be emitted, and codegen picks the
global's LLVM initializer and decides whether an init function is owed.

**One shape needed its own lowering.** An array literal's payload is ordinarily an
`alloca`, and the init function's frame is gone the instant it returns, so the
global would be left pointing into dead stack. The payload goes in a module DATUM
instead - the same `@.arr.N` a module-level array CONST already gets, mutable and
one per declaration so two same-valued arrays do not share writable storage - and
what is stored is the constant descriptor. A non-literal ELEMENT is refused BY
NAME rather than lowered into a dangling pointer.

Not comptime: the reference constant-FOLDS where it can and drops the runtime
store, so a `bool`, a float and a string literal each cost an init store here and
none there. Same values, more instructions.

`examples/pass/module_level_mutable_array.yoop` builds and runs with exactly the
output its own comment states. The other of the item's two files,
`examples/pass/http_concurrent/main.yoop`, now typechecks and reaches codegen and
stops at a NEW named gap - `ref` on a module-level global is not lowered
(`no stack slot to borrow`), since `borrow.yoop` looks up a local slot and a global
has none. Pre-existing, previously masked by this item's own refusal, and now in
bucket 2.2.
