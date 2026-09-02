# Simplification findings: what makes Yooperlang cumbersome

A rundown, not a plan. This document says where the language, as of the tree
at commit b87483e, carries more vocabulary and more spellings than the programs
written in it use, and where a design choice is hard to hold in your head
because the reference for it is wrong or because two mechanisms overlap. It
proposes no work items. Where a section ends with "the smaller shape", that is
a sketch of what the evidence points at, so the later conversation has
something concrete to argue with; it is not a decision.

Every count below was taken by grepping the maintained corpus: `std/`,
`bootstrap/src/` (excluding `*.test.yoop`), `modules/`, `tools/`, and
`examples/pass/` plus `examples/tour/`. The playground is excluded on purpose.
The counts are line matches, so they are approximate, but none of the
conclusions turns on a count being off by a few.

Section 1 is the short version. Sections 3 through 12 are one theme each.
Section 13 is the vocabulary budget: what could go, what could merge, what
earns its place.

---

## 1. The short version

The language has one big idea, kinds, and it is a good one. Around that idea
it has accumulated three kinds of weight:

- **Vocabulary that exists only in the spec.** `scoped`, `pure`, `batchable`,
  `throughput_capped`, `simd_aligned`, `restricts iteration`, `contains<K>`,
  `autoJoin`, `beforeAny`, `afterAny`, `forbids io`, and the `BatchIterable` /
  `SimdIterable` / `ParIterable` strategy traits. None of these compiles, or
  they parse and do nothing, and the spec still teaches them in its examples.
  Half of section 11 of the spec (errors) and all of section 9 (loops) use
  `scoped`, a kind that does not exist; the real one is `joined`. This is the
  single biggest reason the design is hard to remember: the reference
  describes a language that was never built.
- **Two or more spellings of one thing.** Four ways to slice an array
  (`xs[a..b]`, `intr.arraySlice`, `bytes.bytesSlice`, `unsafe_ptr.toArray`).
  Four byte-carrying types (`uint8[]`, `Bytes`, `string`, `Text`). Four
  aggregate keywords (`type`, `variant`, `enum`, `union`). Three spellings of
  a vtable dispatch, two builders for a vtable value, and a hand-rolled
  function-pointer struct in std beside the compiler-supported one. Five loop
  forms. Ten words for concurrency. Two error-conversion traits where the spec
  admits one subsumes the other.
- **Ceremony where the compiler already knows the answer.** A `vtable`
  declaration restates every method of its trait minus `ref self`, and the
  compiler then checks that the restatement matches. Std functions carry
  their module as a prefix and must also be called through a namespace, so
  every call says the noun twice (`vec.vecPush`, `map.mapGet`). Trait methods
  must be called trait-qualified, so the parser declared a trait named
  `SelfLexing` in order to have methods at all, and calls `SelfLexing.peek(ref
  ps)` 147 times.

The two areas you named, function values and arrays, are the two where the
overlap is worst, and section 5 and section 6 are the longest for that reason.

---

## 2. Method

Three sources were read end to end: [../SPEC.md](../SPEC.md),
[../docs/writing_yoop.md](../docs/writing_yoop.md), and the "What it can
compile today" section of [../bootstrap/README.md](../bootstrap/README.md).
The lexer's keyword table in
[../bootstrap/src/lex/scan_tables.yoop](../bootstrap/src/lex/scan_tables.yoop)
and the std kind declarations in
[../std/core/kinds.yoop](../std/core/kinds.yoop) were read as the ground
truth for what the language accepts. Every feature the spec names was then
counted in the corpus, and the size of the compiler machinery behind it was
measured in lines, as a rough proxy for what the feature costs to keep.

Where the spec, the writing guide and the compiler disagree, the compiler is
what was believed.

---

## 3. The vocabulary the language actually has

The lexer reserves 44 words
([scan_tables.yoop:140-184](../bootstrap/src/lex/scan_tables.yoop#L140-L184)).
Nineteen of them are the ordinary structural set any C-family language has
(`let const function return if else while for in type import export extern
from as ref break continue true false`). The rest are where the jargon lives:

- Declaration forms: `trait implements extends self vtable enum variant
  union switch case default`.
- Concurrency operators: `wait await`.
- Kind-clause words promoted to keywords: `appliesTo mustCall ownsBlock
  beforeScopeEnd mustNotEscape mustNotShare forbids acrossScopes globalState`.
- `null` and `_`.

On top of those, the parser recognizes about thirty contextual words inside
kind declarations and prefixes: `kind requires provides pausable refcounted
signature enumerable conferred restrictive clearedBy appliedBy layout abi
restricts propagates contains region binding parameter field function
return type scope acrossThreads library module`. And the std kinds add the
prefixes a program actually writes: `disposable ephemeral joined pooled task
async owned`, plus `suite` and `test` from `std/test.yoop`.

Three observations:

- **The spec's reserved-word list (section 14) is not the lexer's list.** It
  omits `switch`, `case`, `default`, `enum`, `variant`, `union`, `await`,
  `vtable`, `self`, `extends`, and lists `scoped`, `pure`, `Task`, `errno`,
  `abi`, `autoJoin`, `joined`, `pooled`, and the eight `c_*` aliases, none of
  which the lexer reserves. Someone learning the language from the spec
  cannot tell what a keyword is.
- **Nine kind-clause words are lexer keywords and about twenty are
  contextual**, with no rule for which is which. `mustCall` is reserved and
  `requires` is not; `forbids` and `globalState` are reserved and are used
  nowhere outside the parser's own tests and one fixture. The writing guide's
  section 10 already lists this as a sharp edge ("a keyword-ish identifier
  can still surprise you").
- **A reader meets the kind vocabulary before the language.** `disposable`
  appears about 1,500 times in the corpus; `propagates<disposable>` about 360.
  Those two words, plus `ref`, are the texture of every Yoop file. Everything
  else in the kind system is something a program declares once or never.

---

## 4. Kinds: one mechanism, forty words, four features

The kind system is the language's identity and the finding here is not that
it should go. It is that the mechanism is general enough to describe far more
than the compiler does, and the spec describes the general version.

### 4.1 What the compiler consults versus what it records

The typechecker reads exactly these clause words off a kind declaration
(counted in
[../bootstrap/src/typecheck/](../bootstrap/src/typecheck/)): `appliesTo`,
`requires`, `ownsBlock`, `mustCall`, `mustNotEscape`, `pausable`, `provides`,
`refcounted`, `signature`, `enumerable`, `conferred`, `restrictive`,
`clearedBy`, `appliedBy`. Five features come out of that: scope-end cleanup,
escape analysis for stack placement, coroutines and spawn, collected function
tables, and marker clearance.

Everything else in the spec's clause table
([SPEC.md:700-732](../SPEC.md#L700-L732)) is either parsed and ignored or
refused outright: `mustNotShare` (recorded, nothing reads it; the security
findings section 8 already covers that the spec claims it is enforced),
`forbids`, `layout` beyond `abi "C"`, `restricts iteration`, `contains<K>`,
`mustCall ... beforeAny` / `afterAny`, the `{ a; b; }` alternative form, and
`autoJoin` (which is an error with a fix-it). The spec's own examples of what
a kind can be, `batchable(n)`, `simd_aligned`, `throughput_capped(8)`, cannot
be declared: kinds do not take value parameters, and `restricts` is a
"not yet supported" error.

The cost of keeping the general grammar is not compiler lines; it is that a
reader cannot tell which clauses are real. The README says it plainly
("Nothing enforces kinds, so clauses are recorded by their leading word,
except four"), and that sentence is the correct spec.

### 4.2 `propagates<K>` means two different things

On a type, `propagates<disposable>` has teeth: it is what makes scope-end
cleanup recurse into fields, and it is used on 68 types and 2 variants. On a
function signature it is "parsed and recorded and nothing enforces it"
([README](../bootstrap/README.md), the `propagates` bullet), and it is
written 148 times. So the most common spelling of the clause is the one that
does nothing, and the writing guide's section 4.1b teaches it as the idiom
for handing ownership back.

The spec's section 6 still describes the three-way "must handle, or hand off"
contract (auto-cleanup, manual discharge, transfer) as compile errors when
violated. The writing guide's section 4.1 says the opposite: "Ownership is
advisory and silent by default." The guide is right. A reader holding both
documents cannot know what the compiler will say.

### 4.3 Marker kinds: 924 lines for one std use

`conferred`, `restrictive`, `clearedBy`, `appliedBy` and the clearance walk
live in [markers.yoop](../bootstrap/src/typecheck/markers.yoop) (590 lines)
and [clearance.yoop](../bootstrap/src/typecheck/clearance.yoop) (334 lines).
In the corpus they back exactly one std kind, `owned` on strings, and one
example (`clearance_marker.yoop`, the "yooperdoom gate"). `owned` itself is a
stopgap: [borrow_only_string.md](borrow_only_string.md) already argues that
routing builders through `Text` removes the values `owned` exists to mark,
and measured the class at 16 sites in the whole compiler graph, none a
binding.

This is not an argument that clearance markers are a bad idea. It is that
the language carries a general marker-kind subsystem with four clause words
in order to support a feature that the string plan proposes to retire.

### 4.4 The binding ceremony

A kind-prefixed binding has more rules than a plain one, and they interact:

- `disposable x = ...` is implicitly `const`; `let disposable x = ...` is the
  mutable opt-in with a "dispose the old value first" obligation the compiler
  does not check. The mutable form is written 4 times in std and the
  compiler together. The rule exists for a case that almost never occurs, and
  every reader has to learn it.
- A kind that declares `ownsBlock` may take a trailing `{ ... }`, or not, in
  which case the compiler synthesizes one to the end of the enclosing scope.
  So the same binding has two scoping behaviors selected by whether a brace
  follows the initializer.
- `ephemeral` exists as a separate kind from `disposable` only because the
  value has no name. `appliesTo region` exists as a separate site only for
  `ephemeral`. Two kinds and one site word for "run dispose at the brace".
- Kind prefixes on parameters are legal and used 9 times, on annotations
  (`owned string`) 25 times, all of them `owned`. The `appliesTo` site list
  has six words (`binding parameter field function type region`) and two of
  the ten distinct site combinations in the corpus account for 85 percent of
  declarations.

### 4.5 The composition operator

`kind a = b & { ... };` is used twice, both in `examples/pass/`. It has its
own parser path, merge semantics, and a rule about `appliesTo` on inline
operands. Nothing in std or the compiler composes a kind.

### 4.6 The smaller shape

The kinds that carry the language are `disposable`, `joined`, `pooled`,
`task`, `async`, and `owned` if the string plan does not retire it. The
clauses those six need are `appliesTo`, `requires`, `mustCall`, `ownsBlock`,
`mustNotEscape`, `pausable`, `provides`, `refcounted`, and `enumerable` plus
`signature` for `suite`. That is nine clause words instead of the spec's
twenty-two, and the spec's kind section could describe exactly what the
compiler does, which the README already does in one paragraph.

---

## 5. Function pointers and vtables

### 5.1 The story today has four layers

To get a heterogeneous list of handlers, a program writes:

1. A `trait Handler { function handle(ref self, req: int32): int32; }`.
2. One `type X implements Handler { ..., function handle(ref self, ...) }`
   per concrete handler.
3. A `vtable Dispatcher for Handler { handle: (req: int32) => int32, }`.
4. `Dispatcher.from(ref x)` to erase, and `Dispatcher.handle(ref d, req)`
   or `Handler.handle(ref d, req)` to dispatch.

Layer 3 is the one that does not need to exist as a declaration. Its body is
the trait's method list with `ref self` removed, and the typechecker's job on
it ([vtable_use.yoop](../bootstrap/src/typecheck/vtable_use.yoop),
[vtable.yoop](../bootstrap/src/typecheck/vtable.yoop)) is to verify that the
user copied it correctly: "a missing slot, an extra one, a wrong arity and a
wrong return type are each refused BY NAME at the DECLARATION". The compiler
has the trait; it could derive the shape. The declaration also introduces a
second nominal name (`Dispatcher`, `Reader`, `Writer`, `PredDispatcher`,
`TwoOpVT`) that a reader has to map back to its trait.

There are 3 vtable declarations in std and 6 in examples. The compiler
itself declares none and erases through none outside its own tests; the
real consumers are `std/http`, `std/https` and the example programs, about
25 `from(ref ...)` sites between them.

### 5.2 Two builders, three call spellings

- `VT.from(ref x)` erases a struct that implements the trait.
- `VT.fromFn(f, g)` erases named functions, one per slot in declaration
  order, and emits a ctx-dropping shim per function. It is used in two
  example programs and nowhere in std or the compiler. Its arguments must
  be named functions, not
  function values, so a value already held in a `=>` typed local cannot be
  passed to it.
- `VT.method(ref v, ...)` and `Trait.method(ref v, ...)` are documented as
  identical and both are used.

`fromFn` exists because a stateless implementation would otherwise need an
empty struct. It is a second way to construct the same value, with its own
rules (named functions only, positional order tied to the vtable's own
declaration order rather than the trait's, because the trait's method table
is a hash map with no order to read back).

### 5.3 Function values are second class in three ways

The `=>` type (`(p: T) => R`) is real and works as a field, parameter, local
and array element (69 uses in the compiler, 11 in std). But:

- **A function value cannot be async.** The README's NOT SUPPORTED list:
  "an INDIRECT async call through a function-typed FIELD or a local holding
  a function value. A vtable SLOT is the other indirect shape and works".
  So `Readable.read` had to become a vtable rather than a `=>` field, and
  the reason is that `=>` has no place to write `async`. This is the concrete
  reason two mechanisms exist where one would do.
- **An extern C function cannot be used as a value.**
  [alloc.yoop:59-62](../std/core/alloc.yoop#L59-L62): "an extern C function
  used as a fn-pointer VALUE is currently mis-mangled by codegen, so a yoop
  wrapper is the working shape". Std carries `cAlloc`, `cRealloc`, `cFree`
  wrappers around `malloc`, `realloc`, `free` for that reason.
- **An array of function values needs grouping parentheses**, `((ch: uint8)
  => bool)[]`, and the parser has a type-group form whose "only load-bearing
  use is lifting an array suffix out past a `=>`"
  ([SPEC.md:604-620](../SPEC.md#L604-L620)). The grouping form is used 19
  times, the compiler's own lexer needs it for its digit-predicate table.

### 5.4 Std hand-rolls vtables beside the real one

`Allocator` in [alloc.yoop:27-32](../std/core/alloc.yoop#L27-L32) is three
function pointers plus a `data: unsafe_ptr<void>` context, which is exactly
what a vtable value is, written by hand because the allocator has to match a
C-side layout. `KeyOps<K>` in [map.yoop:48-51](../std/collections/map.yoop#L48-L51)
is two function pointers with no context, and its comment says it would be a
trait if the language modeled `Self`. So std has three shapes for "a record
of function pointers": `vtable`, a struct of `=>` fields with a context, and
a struct of `=>` fields without one.

### 5.5 Trait-qualified calls, and `SelfLexing`

Every method call is `Trait.method(ref x)`; `x.method()` and bare
`method(ref x)` are both rejected, and there are no inherent methods (a
method a trait does not require is refused). The consequence is visible in
the parser: [state.yoop:27-38](../bootstrap/src/parse/state.yoop#L27-L38)
declares `trait SelfLexing` with nine methods so that `ParserState` can have
methods at all, and the compiler then writes `SelfLexing.peek(ref ps)`,
`SelfLexing.expect(ref ps, ...)`, `SelfLexing.advance(ref ps)` over 600
times. `Disposable.dispose(ref x)` is written 107 times. The trait name
carries no information at any of those sites; the receiver's type already
determines the method statically.

The rule exists so that method names cannot collide across traits (spec open
question 2). The cost is a word per call that the reader has to invent when
there is no natural trait, and `SelfLexing` is what that invention looks
like.

### 5.6 The smaller shape

The evidence points at one function-value type and one erased-trait type,
with the vtable derived rather than declared:

- `(p: T) => R` stays as the only function type. It gains `async` in the
  annotation, which removes the one reason a vtable slot can do what a field
  cannot. Extern C functions become usable as values.
- A trait name used as a type (`ref Handler`, or whatever spelling is chosen)
  IS the erased view: the compiler builds `{ ctx, slots... }` from the trait's
  method list in declaration order. `vtable Name for Trait { ... }` and its
  second nominal name go away. `Reader` becomes `ref Readable`.
- Erasing is a coercion at a `ref Trait` slot rather than a `from` call, and
  a bare function whose signature matches a single-method trait coerces the
  same way, which retires `fromFn` for the common case.
- Dispatch is `Trait.method(ref v, ...)`, the spelling that already works.
  Whether to also allow `v.method(...)` is a separate call; the `SelfLexing`
  evidence says the trait-qualified rule costs more than the collision it
  prevents.

That is one type, one coercion, one call form, and no restating of
signatures.

---

## 6. Arrays, slices, bytes, and the ways to walk them

### 6.1 Four byte-carrying types

A program that handles text or I/O meets all four:

- `uint8[]`: the fat pointer. What every parser and I/O call takes.
- `Bytes` ([bytes.yoop:35](../std/core/bytes.yoop#L35)): an owned,
  disposable wrapper over a `uint8[]`, with `bytesToArray`, `bytesFromArray`,
  `bytesFromRaw`, `bytesFromVec` to move between it and the others.
- `string`: the nul-terminated borrow. Not indexable, not iterable, `s.len`
  is a `strlen`.
- `Text`: the owned, growable, allocator-aware buffer, with `text.view` to get
  a `string` back and `Chars` to iterate codepoints.

`intr.stringAsBytes(s)` is written 181 times in std and the compiler, and
`text.view(ref t)` 162 times. Those two calls are the tax on the split: to
look at a string's bytes you convert to `uint8[]`, and to hand a `Text` to
anything you convert to `string`. The string plan
([borrow_only_string.md](borrow_only_string.md)) addresses the
owned-versus-borrowed half; it does not address `Bytes` versus `uint8[]`,
which is the same owned-versus-borrowed split for bytes, done with a struct
instead of a kind.

### 6.2 Four spellings of a slice

- `xs[a..b]`, `xs[a..]`, `xs[..b]`, `xs[..]`: the syntax (about 48 uses).
- `intr.arraySlice(xs, a, b)`: the intrinsic the syntax lowers to (65 uses,
  32 of them in std, 15 in modules).
- `bytes.bytesSlice(buf, a, b)`: a std function that is one line calling
  `arraySlice` ([bytes.yoop:192](../std/core/bytes.yoop#L192)).
- `unsafe_ptr.toArray<T>(p, n)`: the raw-pointer form, which "builds the same
  `{ ptr, i64 }` descriptor a slice does".

The intrinsic is used more than the syntax that replaced it, which means the
syntax landed and the corpus was never moved over. `str.stringSlice` and
`sliceFrom` are a fifth and sixth spelling for strings, and both allocate,
which `slice` in the name does not suggest.

### 6.3 Four ways to get an array

- An array literal `[1, 2, 3]` is a hoisted `alloca [N x T]`
  ([codegen/array.yoop:9](../bootstrap/src/codegen/array.yoop#L9)): stack
  storage, so returning one is a dangling pointer, and nothing warns.
- `intr.heapAlloc<T>(n)` / `intr.heapFree` is raw malloc, ignoring the
  allocator context (79 uses).
- `intr.ctxAlloc<T>(n)` / `intr.ctxFree` is the context-routed sibling.
- `Vec<T>` is the growable one, and the one the writing guide says to use.

The intrinsics were global in the spec (section 12 says "no import required")
and now require `import * as intr from "std/core/intrinsics.yoop"`. Two
allocation intrinsics with the same signature differing only in which
allocator they hit is the kind of choice a reader has to remember on every
call, and the guide's answer is "you probably want neither, use `Vec` or
`Text`".

### 6.4 `Vec<T>` is not iterable

`Vec<T>` implements `Disposable` only. To walk one you write
`for x in vec.vecIter(ref v)` or `for x in vec.vecAsArray(ref v)`, and the
corpus uses both (4 and 5 sites respectively, beside 13 loops over a plain
array). `Map` has the same shape with `map.mapIter`. So the collection the
guide tells you to use cannot go on the right of `in` without a helper, and
there are two helpers with different semantics (one snapshots a view that
dangles on the next push, one carries a cursor).

### 6.5 Five loop forms, and the loop variable is a copy

`while`, `for (let i = 0; ...)`, `for i in a..b`, `for x in xs` over an
array, and `for x in it` over an `Iterable`. The last two are "a SECOND
lowering rather than a variation" in the README. The C-style form is used
about 80 times, `for ... in` about 140, ranges about 30. Ranges are sugar
that lowers to `$range.exclusive(a, b)` and auto-imports a std module, so a
program that writes `0..n` has an import it did not write.

The loop variable is a copy of the element, always. The README documents
the consequence: a `MapIter` "does" care, because "its cursor is inline, so
the local the loop was given is left at 0". There is no `for ref x in xs` to
mutate elements in place; the idiom is `for i in 0..xs.len { xs[i] = ... }`.
The spec's `for scoped item in xs.parallel()` and `xs.batched(4)` and
`xs.simd(8)` forms do not exist.

### 6.6 Restrictions a reader trips on

- A module-level `const` array may hold only literals. An array of structs
  cannot be a module constant, which is why the lexer builds its keyword
  table at runtime with 85 `vecPush` calls
  ([scan_tables.yoop](../bootstrap/src/lex/scan_tables.yoop)).
- `xs[f()] += 1` is refused because compound assignment desugars to reading
  the target twice.
- `xs.len` on a string is O(n); on an array it is a field read. Same
  spelling, different cost, and the guide warns about it.
- `xs.ptr` is gated on `import.unsafe;` but indexing out of bounds is not
  (security findings section 7).

### 6.7 The smaller shape

- One slice spelling: the syntax. `arraySlice`, `bytesSlice` and
  `stringSlice` retire, and `unsafe_ptr.toArray` stays as the one raw form
  under the unsafe gate.
- `Vec<T>` and `Map<K, V>` implement `Iterable` directly, so `for x in v`
  works and `vecIter` / `mapIter` are not something a program writes.
- One allocation intrinsic under the unsafe gate; everything else goes
  through `Vec` and `Text`. Whether that one is `heapAlloc` or `ctxAlloc` is
  a decision, but there should be one.
- `Bytes` folds into the same story as `Text`: an owned byte buffer whose
  view is `uint8[]`. Either it is `Text` with a different name, or `Text`
  gains a bytes constructor and `Bytes` goes.
- A `ref` loop variable, or an explicit statement that element mutation is
  by index, so the copy rule stops being a surprise.

---

## 7. Four aggregate keywords: `type`, `variant`, `enum`, `union`

- `type` is a struct, and also a transparent alias (`type A = B;`), and also
  an opaque extern type (`type FILE;`).
- `variant` is a tagged union with payloads, what Rust and Swift call an
  enum. Used 54 times.
- `enum` is a named constant over an integer width or `string`, with case
  values written by juxtaposition (`A 1`, `Info "info"`), never `A = 1`.
  Used 30 times. The juxtaposition rule is one nobody guesses.
- `union` is C's overlapping aggregate. Used in 2 example files and nowhere
  in std or the compiler. It cannot be generic, cannot implement a trait,
  and cannot have methods.

The naming is the reverse of the languages a reader arrives from (an `enum`
with payloads is a `variant` here), and `union` is a full keyword, parser
file and typechecker file (284 lines) for something two fixtures use.

---

## 8. Concurrency: ten words for one feature

`task`, `async`, `await`, `wait`, `joined`, `pooled`, `awaitTask`,
`waitUntil`, `cancel`, and `_ = f()` for fire-and-forget. Plus the binding
rule that `let x = f()` on a task function is a spawn-then-join.

The distinctions a reader must hold:

- `wait h` blocks a thread and is illegal inside a task body; `await
  conc.awaitTask(h)` suspends and is the in-task form; `await g()` drives a
  coroutine and is only legal inside a pausable function. Three words, three
  legality rules, and the guide's section 6 exists to explain them.
- `joined` (stack handle, joined at scope end, cannot escape) versus `pooled`
  (heap handle, refcounted, `wait` it yourself). The corpus uses `pooled` 55
  times and `joined` 12. `pooled` cannot be a parameter, a field, or copied
  into a second binding (refused by name), so the "value handle you can pass
  around" is not yet one.
- The spec calls `joined` by the name `scoped` in sections 4, 9 and 11, and
  describes `autoJoin` as a clause, which is an error to write.

The mechanism underneath (coroutines, a worker pool, re-entrant wait) is
sound and documented. The surface is where the words pile up, and most of
them are two names for "block until done" that differ by where you are
standing.

---

## 9. Errors: three `?` forms and two conversion traits

`expr?`, `expr? "context"`, and `expr? e { ... }` are all used: the context
form 169 times in the compiler and the handler form 30 times across the
compiler and examples. The context form is used more than the
plain one in the compiler, which says it is the right default.

The two conversion traits are the redundant part. `Into<T>` converts an `Err`
payload across shapes; `WithContext<T>` converts and attaches a string. The
spec says "WithContext<T> subsumes Into<T>" and then keeps both, so a type
that wants cross-shape propagation with and without a context implements two
traits with overlapping bodies (11 `Into` impls and 9 `WithContext` impls in
the corpus). Std also
carries nine `*Outcome` variants (`FlushOutcome`, `IoOutcome`,
`HandleOutcome`, ...) that are `Result<void, E>` spelled by hand because an
`Ok` with no payload is a distinct shape from `Result<T, E>`.

Two things the corpus never uses: a fallible enum that is not `Result`
(the structural Ok/Err rule exists for that), and destructuring
(`const { value, err } = f()`, spec section 4), which has zero uses and
describes the old `err` field convention the language moved off.

---

## 10. Modules and naming: say the noun twice

Std functions carry their module as a name prefix (`vecPush`, `mapGet`,
`bytesEq`, `stringConcat`, `textFrom`), and the language requires std values
to be imported through a namespace, so every call is `vec.vecPush`,
`map.mapGet`, `str.stringConcat`. The prefix was the collision defense before
the namespace rule; now the rule is the defense and the prefix is left over.
`text.push` and `text.view` in `std/core/text.yoop` are the newer style and
read the way the rule intends.

There are five import forms (`{ a }`, `* as ns`, `{ a as b }`, the
side-effect form, and the combined `import * as vec, { Vec }` in either
order), plus three module-level flags that look like imports (`import.unsafe;`,
`import.test;`) or headers (`module name;`). The combined form exists
precisely because of the prefix-plus-namespace rule: a module with a type and
its functions needs both bindings on every import.

---

## 11. The spec is out of date, which is half of "hard to remember"

Examples of the spec teaching something that does not exist or is wrong,
each confirmed against the compiler:

- `scoped` (12 mentions) for what is `joined`; `autoJoin` as a clause.
- `pure` as a function kind (section 7); `forbids io`; `throughput_capped`,
  `batchable(n)`, `simd_aligned`, `restricts iteration`, `layout { align 32
  }`, `contains<K>`.
- The whole of section 9's strategy story (`xs.batched(4)`, `xs.simd(8)`,
  `xs.parallel()`, `for scoped item in`), marked "reserved" in a status note
  but then used in prose as if real.
- Section 4's destructuring and the `{ value, err }` struct convention, which
  section 11 then replaces with `Result`.
- Section 12: `heapAlloc` "available globally, no import required" (it needs
  the intrinsics import); a `Vec` API listed in `snake_case` that the naming
  rules forbid.
- Section 15's end-to-end example uses `snake_case` names, the `err` field
  convention, `file<string>`, and declares `main` twice.
- Section 14's keyword list (section 3 above).
- Section 6's `propagates<K>` contract as compile errors (section 4.2 above).
- The vtable section says `=>` is "the only place" it is legal, then the next
  section says it is legal in fields, parameters and returns.

The writing guide is accurate and the README's "What it can compile today"
is accurate. The spec is the document a newcomer reads first and it is the
one that is wrong. That gap, more than any single feature, is why the
language feels bigger than it is.

---

## 12. Attributes and the comptime interpreter

`@derive(display)` and `@precompile` are the only attributes; `eq`, `clone`,
`hash`, `debug`, `default` are reserved names that error. Behind
`@precompile` sits a 4,400-line interpreter in
[../bootstrap/src/comptime/](../bootstrap/src/comptime/) that also hosts
compiler plugins. `@precompile` is used in 11 files across std, the
compiler and modules. `@derive(display)` is used about 95 times in the
compiler and is the one attribute that pulls its weight in the corpus.

This is a cost finding rather than a vocabulary one: two attributes are not
hard to remember. It is listed because the interpreter is the largest single
subsystem after the typechecker and the language surface it serves is one
attribute and the plugin hook.

---

## 13. The vocabulary budget

What the evidence says could go, what could merge, and what earns its place.
This is the list to argue with.

Remove (spec only, or unused, or a duplicate spelling):

- Spec-only kinds and clauses: `scoped`, `pure`, `batchable`,
  `throughput_capped`, `simd_aligned`, `restricts`, `contains<K>`, `autoJoin`,
  `beforeAny`, `afterAny`, `forbids`, `globalState`, `mustNotShare` unless it
  is going to be enforced, `layout` beyond `abi "C"`.
- The strategy traits `BatchIterable`, `SimdIterable`, `ParIterable`, and
  `for scoped item in`.
- `vtable` as a declaration, `fromFn` (used in two fixtures), and the second
  nominal name per trait; the erased view derives from the trait.
- `arraySlice`, `bytesSlice`, `stringSlice`, `sliceFrom` as spellings; the
  slice syntax stays.
- One of `heapAlloc` / `ctxAlloc`.
- `union`, unless C interop has a case the corpus has not met.
- Destructuring and the `{ value, err }` convention from the spec.
- Kind composition (`&`), used twice, both fixtures.
- `Into<T>`, since `WithContext<T>` subsumes it; or the other way round with
  a default context.

Merge (two things that are one):

- `disposable` and `ephemeral`: one cleanup kind, the region form is
  "no name".
- `Bytes` into `Text`, or one owned byte buffer under whichever name.
- `Vec` / `Map` iteration into `Iterable` on the type, so `vecIter` /
  `mapIter` / `vecAsArray`-for-looping are not written.
- `wait` and `await conc.awaitTask(h)`: one word for "get the result", with
  the compiler choosing block or suspend from where it is written, or one
  word and a clear rule.
- `joined` and `pooled`, if a handle that is a real value (passable, storable,
  copyable) can be the only kind; today neither is that.
- Std function prefix and namespace: drop the prefix (`vec.push`), keep the
  namespace rule.
- `propagates<K>` on functions: either enforce it or stop writing it.

Keep (it is used, and it is the language):

- `disposable` with `mustCall` / `ownsBlock` / `requires`, and
  `propagates<K>` on types.
- `task` / `async` / `await`, coroutines and the spawn.
- `ref` at both ends, `?` with the context and handler forms, `Result`.
- `variant` and `enum` (with the juxtaposition rule reconsidered), `trait`
  and `implements`, generics with bounds.
- `(p: T) => R` as the one function type, with `async` allowed on it.
- The slice syntax, ranges, `for ... in` over arrays and iterables.
- `@derive(display)`.
- `owned`, until the string plan retires it.

---

## 14. Limits

Counts are grep matches over source lines and will include comments and a
few false positives; they are indicative, not exact. No program was compiled
to produce this document, and no claim here rests on running the compiler:
where the text says a form is refused, that is the README or the parser
source saying so. The playground and the web site's generated data were not
read. What a user who is not the author finds cumbersome was not measured;
this is what the tree and its documents say about themselves.
