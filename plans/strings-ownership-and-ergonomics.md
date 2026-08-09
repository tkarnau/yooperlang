# Strings: ownership, ergonomics, and the allocator context

Written 2026-08-08.

Covers three concerns that turn out to be one concern:

1. An `owned` kind so a `string` carries its provenance.
2. String ergonomics closer to what a high level language offers.
3. Routing string allocation through `ctx_alloc` (the ambient allocator)
   instead of raw `malloc`.

They are sequenced deliberately. Doing (3) first converts a class of silent
leaks into a class of silent use-after-free, so it lands last.

## Status

- **S3 (`Text`): LANDED.** [std/core/text.yoop](../std/core/text.yoop), plus
  the one intrinsic it needed. Fixtures
  [text_basics.yoop](../examples/pass/text_basics.yoop) and
  [text_arena.yoop](../examples/pass/text_arena.yoop). As-built notes are in
  the S3 section below.
- **S1 (conferred passthrough): LANDED.**
  [kindFlow.js](../src/jsyooptypecheck/kindFlow.js). Fixes an asymmetry that
  bit `cleared` too, not just `owned`.
- **S2 (`owned` marker kind) + S2.1 (markers through type arguments and
  payload bindings): LANDED.** Kind in
  [kinds.yoop](../std/core/kinds.yoop), mint site in
  [intrinsics.yoop](../std/core/intrinsics.yoop), `strFree` plus annotated
  returns in [strings.yoop](../std/core/strings.yoop). Fixtures
  [owned_string.yoop](../examples/pass/owned_string.yoop),
  [owned_free_literal.yoop](../examples/fail/owned_free_literal.yoop),
  [owned_forge.yoop](../examples/fail/owned_forge.yoop),
  [owned_payload.yoop](../examples/pass/owned_payload.yoop),
  [owned_payload_forge.yoop](../examples/fail/owned_payload_forge.yoop).
- **S4 (`ctx_alloc` routing): not started.** `Text` already allocates through
  the context, so the arena and temp-reset payoff is available today for
  anything built on `Text`. What S4 adds is the same for bare `string`.
- **S5 (`string ==`): not started.**
- **The async allocator context hazard (S4 risk 2) is explicitly deferred**
  and is not a blocker for anything above. It needs its own plan.

The type is named `Text`, not `Str`. `Str` is one capital letter from
`string` and would be misread on every line that uses both.

## Why now

Nothing in the repo frees a string. That is survivable for the programs that
exist today, which are all short lived, and it is not survivable for the
long running server programs that are the actual target. There are no such
programs in tree yet because they are impractical to test, so the leak has
never had to justify itself.

## What is true today

Verified against the tree, not recalled:

- `string` is a nul terminated `char *`. It is not indexable
  (`resolveIndexExpression` in [checkExpr.js](../src/jsyooptypecheck/checkExpr.js)
  rejects a non-array object) and it is not mutable.
- `s.len` lowers to a `strlen` call ([codegen.js:1303](../src/jsyoopcodegen/codegen.js#L1303)).
  Every length read is O(n).
- `string_as_bytes` is a zero copy view over the string's own storage
  ([codegen.js:5324](../src/jsyoopcodegen/codegen.js#L5324)). Writing through
  it on a literal is a SIGBUS.
- `string_from_bytes_unchecked` emits a direct `call ptr @malloc`
  ([codegen.js:5368](../src/jsyoopcodegen/codegen.js#L5368)), NOT
  `@yoop_ctx_alloc`. Consequence: strings ignore the allocator context
  entirely, so `ephemeral arenaScope(...)` reclaims none of them, unlike
  `Vec<T>`.
- `--track-heap` cannot see string allocations either. A thousand concats
  under it report only the temp buffers inside `string_concat`.
- Nothing in `std/`, `examples/`, or `bootstrap/` frees a string.
- `intr.heap_free(intr.string_as_bytes(s))` does correctly free a heap
  string (`free` does not need the size). On a literal it is a SIGABRT.
- `string == string` and `string + string` are both typecheck errors.
- Provenance is already mixed in std today. [strings.yoop:202](../std/core/strings.yoop#L202)
  `sliceFrom` returns a malloc'd string on the Ok path and the literal `""`
  on the Err path. A caller that freed the result would abort roughly half
  the time. Nothing catches this.

## The central constraint

A bare `string` is one pointer. There is nowhere in it to record which
allocator produced it or how long it is. Every ownership question we want to
answer ("who frees this, and with what?") needs somewhere to put the answer.

That single fact splits the work in two, and it is why this plan does not
try to make `string` itself an owning type:

- A **marker kind** can say "this pointer came from an allocation." It
  cannot say "and here is the allocator to give it back to." It is honest
  labelling of the world we already have.
- A **struct** can carry the allocator, the length, and a `dispose`. That is
  the vehicle for real ownership, and `Vec<T>` already proves the pattern in
  this codebase (container owned allocator, captured at construction,
  re-pushed around every grow and free).

So: `owned string` is the cheap incremental win over the existing API, and a
new `Text` type is the deep fix. They are complementary, not competing, and
the plan does both.

## Phase S1: give conferred kinds a passthrough rule (LANDED)

A prerequisite, and a fix to an existing asymmetry rather than new surface.

The restrictive direction in [kindFlow.js:310](../src/jsyooptypecheck/kindFlow.js#L310)
already exempts passthrough: if a parameter carries K and the return carries
K, nothing is being stripped, so no authority is required. The conferred
direction has no such exemption. Every conferred kind on a return goes
straight to `authorizedAs("appliedBy", k)`.

Verified consequence: a pure forwarding function is rejected.

```yoop
function forward(s: owned string): owned string { return s; }
// function 'forward' would confer conferred kind 'owned', but kind 'owned'
// declares no 'appliedBy' clause; no impl is authorized to confer it
```

Nothing is conferred there. The value arrived carrying the kind and left
carrying the same kind. This bites `cleared` today, not just a hypothetical
`owned`, so it is worth fixing on its own merits.

**Change**: in the conferred loop of the decl authority check, skip the
authority requirement for a kind K when every `return` statement in the body
yields a value that already carries K per `exprMarkers`. Fall through to the
existing `authorizedAs` check otherwise. That keeps the anti-forgery property
intact (you still cannot mint K from a literal or a fresh struct) while
letting a wrapper forward one.

### As built: where the check runs

`isConferredPassthrough(k)` in
[kindFlow.js](../src/jsyooptypecheck/kindFlow.js), with two details that were
not obvious from the sketch:

- **The conferred half of the authority check had to move AFTER the body
  walk.** `bindingMarkers` holds only the parameters until `walkStmt`
  populates the locals, so a check running up front sees `return out;` as
  unmarked whenever `out` is a local. Return values are collected into
  `returnValueNodes` during the walk and inspected afterwards. The
  restrictive half stayed where it was, since it reads only the signature and
  moving it would have reshuffled diagnostic ordering for no gain.
- **An empty return list is not vacuous passthrough.** With no returns to
  inspect there is nothing establishing that the kind came from anywhere, so
  `returnValueNodes.length === 0` answers false rather than true.

"Every return", not "any return", is what stops the mixed-path forgery in
[owned_forge.yoop](../examples/fail/owned_forge.yoop): laundered on one
branch and forged on the other is still forging.

Verified: `forward` compiles; forging from a literal still errors; the
mixed-path case still errors; all ten pre-existing clearance fixtures pass
unchanged, including `clearance_fake_confer` (the free-function conferrer),
which is the anti-forgery property this rule had to preserve.

## Phase S2: the `owned` marker kind (LANDED)

With S1 in place this is almost entirely declaration work. The sink half
already worked with no compiler change at all. Verified:

```text
parameter 's' of 'strFree' requires kind 'owned' but the value does not
carry it; obtain it from a function whose return type declares 'owned'
```

That is the compiler already refusing to let you free a literal.

**The kind**, in [std/core/kinds.yoop](../std/core/kinds.yoop):

```yoop
export kind owned {
    appliesTo binding parameter field return;
    conferred;
}
```

No `requires` / `appliedBy`. The absence is meaningful: no trait impl is
authorized to mint `owned`, so the only sources are the bodyless extern
intrinsics that literally call the allocator, plus passthrough from S1. A
function that tries to fabricate it gets the "declares no 'appliedBy'
clause" error, which is the correct answer.

**The mint site**: `string_from_bytes_unchecked` in
[std/core/intrinsics.yoop](../std/core/intrinsics.yoop) is annotated
`owned string`. Extern blocks have no body, so `runKindFlow` returns early
and the authority check never runs on them.

**The one real code change**, which the plan flagged as a maybe and which
turned out to be needed: `funcDeclsByModule` in
[typecheck.js](../src/jsyooptypecheck/typecheck.js) only collected
`FUNCTION_DECL`, so `calleeInfo` resolved a namespaced intrinsic call to
null and the marker was silently dropped at every call site. It now collects
`EXTERN_FUNCTION_DECL` from extern blocks first, letting an ordinary
function of the same name win.

**The free site**: `strFree(s: owned string): void` in
[strings.yoop](../std/core/strings.yoop), the first sanctioned way to
release a string.

### What annotating std actually surfaced

- **`padStart` / `padEnd` were both mixed-provenance AND leaky**, exactly as
  predicted. They returned the input itself when it was already wide enough,
  and concatenated in a loop, abandoning one heap string per repetition.
  Both are rewritten to size the result up front and allocate once, and to
  return fresh storage on every path. Whole-`fill` repetition (so a
  multi-byte fill can overshoot `width`) is preserved.
- **`sliceFrom` returned a malloc'd string on the Ok path and the literal
  `""` on the Err path.** The Err path now allocates too, so freeing the
  result is no longer a coin flip. It could NOT be annotated `owned` though,
  for the reason in the next section.
- **A plain `string` binding drops the marker, and that is correct but
  needs saying.** Inside `string_concat` the local had to become
  `let result: owned string = ...` or the return read as forgery. Callers
  hit the same thing: `const a: string = str.padStart(...)` then
  `str.strFree(a)` is rejected. The binding's declared type is the
  authority, and plain `string` is the borrowed form.

### Known gaps

- **Writing `owned string` costs an import.** The kind has to be in scope,
  so user code needs `import { owned } from "std/core/kinds.yoop";`. Not
  wrong, but it is friction on the annotation we most want people to write.

The generic-type-argument and payload-binding gaps that were listed here are
closed; see S2.1 below.

## Phase S2.1: markers through type arguments and payload bindings (LANDED)

The gap S2 left: a marker could not survive a fallible constructor. The owned
value goes out inside a `Result` and only becomes reachable again after a
`switch` destructures it, and neither half of that round trip carried
markers. `string_slice` and `sliceFrom` were the two functions it blocked.

### A marker set became a tree

`emptyMarkers()` now carries `args`, mirroring the annotation's `typeArgs`.
`Result<owned string, string>` holds nothing at the top level and `owned` at
`args[0]`, and `checkBound` recurses positionally, so
`Result<tainted X, E>` flowing into a plain `Result<X, E>` slot is caught the
same way the bare case always was.

### Destructuring resolves from either direction

`payloadFieldMarkers` handles both, because the two payload shapes keep their
markers in different places:

- **Generic payload** (`Ok { value: T }`): map field -> type param -> type
  argument index through `registry.genericDeclById`. It has to be the GENERIC
  decl - instantiation has already substituted `T` away, so the concrete
  variant type only knows the field is a `string`, not which parameter it
  came from.
- **Concrete payload** (`Case { f: owned string }`): read the field's
  annotation off the VARIANT_DECL AST, reached through a `resolveVariantDecl`
  lookup built in pass D alongside `funcDeclsByModule`. A variant TYPE keeps
  only resolved field types, with no annotations to read.

(A VARIANT_DECL's case list is `variants`. `cases` belongs to ENUM_DECL, and
getting that wrong silently returns no markers rather than failing.)

### The forgeable hole this opened, and the fix

The decl-authority check is deliberately TOP-LEVEL: it asks what the function
hands back, and a `Result` is not itself owned. So annotating a return
`Result<owned string, string>` triggers no authority check at all, and
nothing would have stopped a body from building `Ok { value: "a literal" }`
and handing it out as owned - the caller destructures it and frees read-only
memory.

`checkReturnedConstructor` closes that: at a `return Variant.Case { f: X }`
the constructor field is a slot, and the return annotation's matching type
argument (or the field's own annotation, for a concrete payload) is what it
must satisfy. Still open: the same check at slots other than a `return` - a
binding initializer or call argument taking a variant literal.

### Companion bug: switch statements were never walked

`runKindFlow` read `stmt.value` and `stmt.cases`. A `SWITCH_STATEMENT`
carries `scrutinee`, `arms` and `defaultArm` (arms hold `patterns` + `body`).
The keys never matched, so **no marker check has ever run inside a switch
arm**. Verified before the fix: `strFree("a literal")` inside an arm compiled
clean while the identical call one line outside was rejected. Found by
probing the real AST shapes rather than by reading the walk, which looks
correct until you check the node it is walking.

Fixing it surfaced no violations anywhere in the tree, which is expected
rather than reassuring: nothing outside these new annotations uses markers
yet.

### Verified: S2.1

- `Result<owned string, string>`'s Ok payload arrives owned and is freeable;
  the Err payload is a plain string and is not.
- `sliceFrom` now declares `owned string`, reaching it by passthrough on both
  arms - one from the payload, one by allocating.
- A concrete `variant Slot { Held { text: owned string } }` payload binding
  is freeable, and forging a literal into it is rejected.
- All four forgery routes rejected in
  [owned_payload_forge.yoop](../examples/fail/owned_payload_forge.yoop).
- Full suite green (999 tests).

**What `owned` does NOT do.** Worth writing down so nobody expects it later:
it is provenance only. It does not force you to free, does not prevent a
double free, does not prevent use after free, and does not know which
allocator produced the value (`strFree` releases through raw `free`
regardless). It makes `strFree` safe to call on the right things. That is
all, and it is still worth having.

## Phase S3: `Text`, and the ergonomics (LANDED)

This is where the high level feel lives, and where ownership is real.

**The division of labour**, stated at the top of the module because
everything else follows from it:

- `string` is the borrowed view. Literals, `view(ref t)`, a slice into a
  buffer someone else owns. Never freed, never owned, cheap to pass.
- `Text` is the owned buffer. It allocates, it carries its allocator, it is
  `disposable`, and the compiler injects its cleanup at scope end.

That is `&str` and `String`, and it is the only split where the allocator
travels with the value.

### As built: the type

```yoop
export type Text implements Disposable propagates<disposable> {
    data: uint8[],
    len: usize,          // bytes of content, NOT counting the nul
    cap: usize,          // >= len + 1 whenever cap > 0
    alloc: Allocator,    // captured at construction, like Vec
    function dispose(ref self): void { ... }
}
```

**Deviation from the sketch: `Text` owns a raw buffer rather than wrapping
`Vec<uint8>`.** The plan originally proposed the wrapper on the grounds that
`Vec` already solved container-owned allocation. It does, but `Vec` has no
concept of the reserved nul byte, and the nul is not optional: a `string`
recovers its length with strlen, so `view` cannot exist without one.
Wrapping would have meant either a `vec_reserve` addition plus writing at
index `len` through a view whose length is `len` (out of its own bounds), or
carrying the nul as a real element and subtracting one everywhere. Owning
the buffer directly costs about forty lines duplicated from `Vec` and buys a
single place where both invariants are enforced. The allocator discipline is
copied verbatim from `Vec`: capture at construction, `pushAllocator` around
every grow and the free.

**The invariants**, which are what make `view` free:

1. `cap >= len + 1` whenever `cap > 0`.
2. `data[len] == 0`.

`make(0)` still allocates one byte so no other function needs a "has this
been allocated yet" branch.

**One compiler change was required**, and only one:
`bytes_as_string_unchecked(buf: uint8[]): string`, the borrowing inverse of
`string_as_bytes`. Codegen projects field 0 out of the fat pointer and calls
it a string: no malloc, no memcpy, no strlen. Without it `view` would have
to go through `string_from_bytes_unchecked`, which copies, and a `view` that
allocates defeats the entire point of the borrowed/owned split. The `_as_`
prefix follows the existing naming convention (view, no allocation) and
`_unchecked` covers its two caller obligations: valid UTF-8, and a nul at
`buf.data[buf.len]`. `Text` satisfies both by construction, which is why the
doc comment points callers at `view` rather than at the intrinsic.

Touched: `INTRINSIC_DECL_IDS` and `makeBuiltinGenericFuncs` in
[typecheck.js](../src/jsyooptypecheck/typecheck.js), one handler in
[codegen.js](../src/jsyoopcodegen/codegen.js), one line in
[intrinsics.yoop](../std/core/intrinsics.yoop).

### API

New code is camelCase per the naming convention, so this also avoids adding
more of the `snake_case` spelling that std is migrating away from. Because
std value imports must be namespaced, the module name carries the prefix and
the functions do not: `text.fromString(...)`, `text.push(ref t, ...)`.

- Construction: `make(capHint)`, `fromString(s)`, `fromBytes(buf)`.
- Mutation: `reserve`, `push`, `pushBytes`, `pushByte`, `pushChar`,
  `pushText`, `clear`, `truncateBytes`.
- Views, no allocation: `view` (to `string`), `bytes`, `isEmpty`.
- Codepoints: `seqLen`, `charCount`, `byteOffsetOfChar`, `charAtByte`,
  `charAt`, and a `Chars` iterator implementing `Iterable<uint32>` so
  `for c in text.chars(s)` works.
- Queries, taking borrowed `string` so they work on views too:
  `startsWith`, `endsWith`, `indexOf`, `indexOfFrom`, `contains`, `equals`.
- Transforms, each returning a fresh owned `Text`: `concat`, `join`,
  `repeat`, `toLowerAscii`, `toUpperAscii`, `trim`, `trimStart`, `trimEnd`,
  `replaceAll`, `subBytes` (Result), `subChars`, `replaceChar`, `padStart`,
  `padEnd`.
- Parsing: `parseInt` returning `Result<int64, string>`.

**Byte offsets versus characters is settled by naming and held to.** Anything
working in bytes says so (`pushBytes`, `truncateBytes`, `subBytes`,
`charAtByte`); anything working in codepoints says char (`charAt`,
`subChars`, `charCount`, `byteOffsetOfChar`). The older
[strings.yoop](../std/core/strings.yoop) API is all byte offsets and none of
them say it, which is the papercut that started this.

`toLowerAscii` / `toUpperAscii` are named for their limit rather than
pretending to be Unicode case folding, which is locale dependent and can
change a string's length.

### Verified: S3

- All four UTF-8 widths encode and decode: `pushChar` of U+0041, U+00E9,
  U+20AC, U+1F600 gives 10 bytes / 4 chars, and `Chars` yields exactly
  65, 233, 8364, 128512 back.
- Growth across several reallocations: 500 appends give len 1000, cap 1024,
  and `view` still reads 1000 bytes, so the nul invariant survives every
  grow.
- Under `--track-heap`, a 200-iteration loop building two Texts per
  iteration reports net 0 bytes. Worth contrasting: a raw `string` built by
  `string_concat` is both leaked and INVISIBLE to that counter, because it
  mallocs directly rather than through `ctx_alloc`.
- A `Text` built inside `ephemeral mem.allocatorScope(ar)` draws from the
  arena and needs no dispose.
- Full suite green (994 tests).

### Not built

- `parseFloat`. Needs a correctly-rounded decimal-to-binary conversion to be
  worth shipping, and eyeballing one is how you get a subtly wrong parser.
- `split` returning `Vec<Text>`. [strings.yoop](../std/core/strings.yoop)
  has a `split` that pushes owned `string`s into a `Vec<string>` and leaks
  every one of them; the `Text` replacement should land together with
  deciding what happens to that function.
- Migrating `std/core/strings.yoop` callers. `Text` is additive so far, and
  nothing in std uses it yet.
- `Display` for `Text`, so it interpolates in a template literal.

## Phase S4: route allocation through the context

Only safe once S2 or S3 gives us a way to talk about ownership.

**Change**: `string_from_bytes_unchecked` emits `@yoop_ctx_alloc(size, 8)`
instead of `@malloc`, matching what `ctx_alloc` already does at
[codegen.js:5253](../src/jsyoopcodegen/codegen.js#L5253). Same treatment for
the array literal buffer at [codegen.js:4685](../src/jsyoopcodegen/codegen.js#L4685),
which is malloc'd and deliberately leaked today, and for the float formatting
buffer in [runtime/yoop_format.c](../runtime/yoop_format.c).

`heap_alloc` / `heap_free` stay on raw malloc. They are the explicit escape
hatch and should keep meaning exactly one thing. Coroutine frames stay on
malloc too, since their lifetime is not scoped to anything the context knows
about.

**Default behaviour is unchanged.** The context defaults to the malloc
allocator, so a program that never opts in allocates and leaks exactly as it
does today. What changes is that opting in starts working.

**The payoff, stated concretely.** The long running server case is a temp
allocator reset at the request boundary. `std/core/alloc.yoop` already has
`tempAllocator()` and `resetTemp()`, and they are currently unused by
anything. With strings routed through the context, wrapping the per-request
body in a temp allocator scope and calling `resetTemp()` after the response
is written reclaims every string the handler built, with no per string free
and no `Text` migration required. That is the shape that makes "most
allocations never need a free" true, which is what the allocator module's own
comments were already aiming at.

**Four risks, all real:**

1. **Escape becomes a crash.** A string built inside an `arenaScope` and
   returned out of it currently leaks; afterwards it dangles. This trades a
   benign failure for a hostile one. It is what arena semantics mean and it
   is what Odin and Jai do, but it must land documented and with a fixture,
   not silently.
2. **Async task migration.** `yoop_cur_alloc` is `_Thread_local`
   ([runtime/yoop_alloc.c:35](../runtime/yoop_alloc.c#L35)) and a suspended
   task can resume on a different worker. An allocator scope opened before an
   `await` is therefore NOT in effect after it. Since the server path is
   async top to bottom, this hits the exact use case that motivated the work.
   Either the allocator context has to become part of the coroutine frame and
   be restored on resume, or scopes have to be documented as suspend-unsafe
   and kept inside a single step. This needs deciding before S4 ships, and it
   may be the largest piece of work in the whole plan.
3. **Cross allocator free.** A `Text` frees through its captured allocator, so
   it is fine. A bare `owned string` has no captured allocator and would be
   freed through whatever is ambient at the free site. That is unsound in
   general, and is the strongest argument for pushing users toward `Text`
   whenever they intend to free at all.
4. **`--track-heap` is blind to strings.** It should count context
   allocations so the tool built to find leaks can see the largest source of
   them. Small change, do it in this phase.

## Phase S5, optional: `string == string`

`==` on strings is a typecheck error today, which is a sharp edge for the
high level feel and pushes people to `string_eq` for something that reads
naturally as an operator.

[CLAUDE.md](../CLAUDE.md) already anticipates the fix and its constraint:
`==` lowers to `icmp eq ptr` for every type, and `enum<string>` equality
depends on identical literals interning to one global. So a real byte compare
is required, not a relaxation of the pointer compare, and the enum backed
path has to keep working.

`+` for concatenation is deliberately NOT proposed. It hides an allocation
behind an operator, which is the opposite of what the allocator work is for.
Template literals already cover the common case and are visibly a call.

## What this plan does not do

- Refcounted or garbage collected strings. Wrong shape for this language.
- Making `string` itself owning. There is nowhere to put the allocator.
- Making `Text` the type in every std signature. `string` stays the currency
  for borrowed text; migrating std wholesale is not justified.
- Small string optimisation, ropes, interning beyond what codegen already
  does for literals.

## Open questions

- **Sequencing.** S3 (`Text`) is the larger and more useful piece, S2
  (`owned`) is the cheaper one and improves the API that exists right now.
  Either can go first; S1 is a prerequisite only for S2.
- **Is S2 worth it if S3 lands?** Once `Text` exists, `owned string` covers a
  narrower band: the raw intrinsic layer and the mixed provenance returns
  already in std. The argument for doing it anyway is that it costs almost
  nothing and catches the `sliceFrom` class of bug in code we are not going
  to rewrite.
- **The async allocator context** (risk 2 above) may deserve its own plan.
  It is not really a string problem; it is a hole in the allocator context
  that strings would be the first to fall into.
