# Acting on the yooperdoom takeaways

Source: `/Users/tom/dev/personal/yooperdoom/TAKEAWAYS.md`, backed by
`spikes/RESULTS.md` in the same repo. Both came out of a 15,000 line DOOM port
plus an LLM agent loop and its sidecar, so every item below is grounded in
something that actually happened rather than a feature survey.

Everything in section 0 was re-verified against `18843a0` (2026-08-10) on
macOS arm64 before this plan was written. Where a claim turned out to be stale,
it says so, and where a claim reproduces, the probe that reproduces it is
recorded.

Style note for anything that lands from this doc: it belongs in the "write
larger Yoop programs and feed the friction back into small targeted language
fixes" bucket that `plans/README.md` names as priority 2. None of it is on the
self-hosting critical path, and two whole sections (HTTP, reflection) are a
long way off it. Sequencing at the bottom accounts for that.

---

## 0. Ground truth: what is already done

Re-ran `spikes/repros/run.sh` against `18843a0`. **All eight recorded compiler
bugs are fixed, including bug 9.**

```text
  bug 1 untyped template     FIXED
  bug 2 t<digits> local      FIXED
  bug 3 fn-ptr ref param     FIXED
  bug 4 arr[i].field = v     FIXED
  bug 5 ref T in a field     FIXED
  bug 6 extern sibling call  FIXED
  bug 7 array of enum        FIXED
  bug 9 conferred not held   FIXED

bug 9, second front - the gate in the real codebase:
  demos/gate_bypass.yoop is REJECTED - the gate binds. Update PLAN.md.
```

### 0.1 The conferred kind no longer fails open

TAKEAWAYS section 1.1 and pick-three item 1 are **stale**. The uncharacterised
second trigger is gone too: `demos/gate_bypass.yoop`, the real-codebase forgery
that used to compile clean, is now rejected with the right diagnostic at the
right span:

```text
demos/gate_bypass.yoop:74:57: parameter 'proof' of 'mapEmit' requires kind
'cleared' but the value does not carry it; obtain it from a function whose
return type declares 'cleared'
```

That is the single most important line in this document, because a
fails-open safety feature was the only correctness bug on the list.

**Action: none in the compiler.** Two documentation actions instead:

- Tell yooperdoom to update `TAKEAWAYS.md` 1.1 and `PLAN.md`, and to keep
  `demos/gate_bypass.yoop` and `spikes/repros/run.sh` exactly as they are. The
  standing forgery check is the correct habit and it is what proved this.
- Nothing to add to this repo's test suite. An earlier draft of this plan
  said it had no standing "this program must NOT compile" check for a
  conferred kind. That was wrong - the coverage is thorough and predates this
  review:

  - `examples/fail/clearance_sibling_file_sink/` is the bug 9 repro exactly,
    directory module and all, and its `impl.yoop` comment records the root
    cause: kindFlow's cross-module function index was rebuilt per SOURCE FILE
    but keyed by MODULE id, so the last file emitted for a directory module
    overwrote its siblings' entries, `sink` vanished from the index,
    `crossModuleCallee` returned null, and the argument check bailed silently.
    That is the same per-file/per-module merge hazard CLAUDE.md already lists
    as having caused three separate bugs; this was a fourth.
  - Also present: `clearance_forge`, `clearance_fake_confer`,
    `clearance_fake_launder`, `clearance_unlaundered_sink`,
    `clearance_restrictive_leak`, `clearance_namespaced_sink`, `owned_forge`,
    `owned_payload_forge`.
  - And the positive direction, which matters just as much given that a
    conferred kind with no `appliedBy` is uninhabitable rather than merely
    hard to obtain: `examples/pass/clearance_marker.yoop` and
    `examples/pass/clearance_namespaced_sink/`.

### 0.2 Papercuts already fixed

These appear in the TAKEAWAYS 1.3 table as historical cost and need no work.
The table is a record of what the project paid, not a to-do list:

- `arr[i].field = v` rejected everywhere (bug 4)
- `ref T` cannot be stored in a `ref T` struct field (bug 5)
- extern C symbol mangled when called from a sibling file (bug 6)
- array of an enum type does not compile (bug 7)
- a local named `t0` collides with codegen temporaries (bug 2)
- function-value materialization doubles the `ref` (bug 3)

### 0.3 Two doc drifts, and the second one is dangerous

**In this repo.** `std/http/server.yoop:32` said "Yoop has no string free".
`std/core/strings.yoop:272` exports `strFree(s: owned string)`. Corrected, and
the surrounding claim re-read while there: the parsed strings really are
unfreed, but not for the stated reason. `string_from_bytes_unchecked` mallocs
and copies and returns `owned string`, so `strFree` accepts them; what is
missing is the bookkeeping, because `Request` and `Headers` do not track which
of their strings they own. The header now says that instead.

**In yooperdoom.** `spikes/RESULTS.md:606`, in the house rules:

> `string_from_bytes_unchecked` is the exception: it returns a VIEW, valid only
> while the buffer behind it is.

That is backwards, and it is the drift worth reporting first, because it is
advice a reader will act on. `string_from_bytes_unchecked` **allocates and
copies** - `malloc(buf.len + 1)` then `memcpy`, at
[codegen.js:5477](../src/jsyoopcodegen/codegen.js#L5477) - and returns
`owned string`. The intrinsic that returns a borrowing view is the other one,
`bytes_as_string_unchecked` ([codegen.js:5510](../src/jsyoopcodegen/codegen.js#L5510):
"no malloc, no memcpy, no strlen"). The naming convention in
`std/core/strings.yoop` states the rule the two follow: `_as_*` is a view,
`_from_*` / `_slice` / `_concat` allocate.

Believing the rule as written costs twice: a `_from_` result gets treated as
borrowed and never freed (a leak, in a program that already has `strFree` in
scope), and its lifetime gets tied to a buffer it does not actually depend on.
The rest of that house rule - build a report by pushing into one `Vec<uint8>`
rather than by repeated concatenation - is good advice and unaffected.

---

## 0.4 Found while doing this work: `&&` and `||` did not short-circuit

Not in the takeaways, and worse than anything that is. FIXED.

Both operands of `&&` and `||` were always evaluated: `INT_OP_MAP` in codegen
mapped `andand` onto the bitwise `and` and `oror` onto `or`, so the lowering
had no branch in it at all. Every guard idiom in every language is written on
the assumption that this is not so:

```js
if (p != null && (*p).v > 0)          // dereferenced null
if (i < xs.len && xs[i] == want)      // read past the end
if (j > 0 && xs[j - 1] > xs[j])       // usize underflow at j == 0
if (ok && expensive())                // paid for silently
```

It is invisible until the right-hand side is unsafe, and then it is a SIGSEGV
several frames from the source with nothing pointing at the operator. Confirmed
present at `18843a0`.

**How it surfaced is the part worth keeping.** It was not found by reading the
compiler. It was found by writing an ordinary program in Yoop -
`tools/stdindex`, the std index generator below - whose insertion sort is the
textbook shape `while (j > 0 && less(cur, xs[j - 1]))`. That crashed on a
three-entry directory and not on a five-entry one, because the inner loop only
reaches `j == 0` when the input is actually out of order. This is exactly what
`plans/README.md` priority 2 is for, and it is an argument for writing more of
the tooling in Yoop rather than in JS.

Fix: `emitShortCircuitLogical` in codegen lowers both operators to a branch
plus a stack slot (not a phi - the right side may contain its own branches, so
the phi's recorded predecessor would go stale). Shared by the single-module and
multi-module emitters deliberately, since CLAUDE.md already records two bugs
that came from editing one of that pair and not the other. Fixture:
`examples/pass/short_circuit.yoop`, which asserts on the NUMBER OF SIDES
EVALUATED rather than on the resulting values - a bitwise lowering produces the
same values and would pass a value-only test.

---

## 1. Tier 1: the compiler must never fail without a span or a sentence

This is the rule TAKEAWAYS 1.2 proposes, and it is the right one. Two live
violations, both re-confirmed.

### 1.1 Untyped-literal arithmetic reaches codegen (LIVE)

Repro, current compiler:

```js
function main(): int32 {
    let x: int32 = 152;
    if (x == -24 + 176) { printf(`eq\n`); }   // Error: llvmType: unhandled
    return 0;                                  // yooper type kind "untypedInt"
}
```

The template-literal form of this (bug 1) was fixed in
`resolveTemplateLiteral` ([checkExpr.js:884](../src/jsyooptypecheck/checkExpr.js#L884)).
The comparison form was not, and the reason is visible in the code.

`resolveBinary` ([checkExpr.js:250](../src/jsyooptypecheck/checkExpr.js#L250))
pins untyped operands in two cases: when the unified result is a numeric prim,
and when BOTH sides are untyped and the result is bool. The mixed case - one
typed side, one untyped compound expression, comparison operator - falls
through both. The comment at line 283 says a comparison with one typed side is
"unaffected, codegen takes the type from that side", and that is true of the
comparison instruction itself
([codegen.js:4542](../src/jsyoopcodegen/codegen.js#L4542), `opType = isCmp ? l.yoopType : resultType`)
but not of the recursive `emitExpr` into the untyped operand, which is where it
actually throws.

**Fix, two parts, both small.**

1. **Root cause.** In `resolveBinary`, when the op is a comparison and exactly
   one side is untyped numeric while the other is a concrete numeric prim, pin
   the untyped side to the TYPED SIDE'S type (not to the bool result).
   `coerceUntypedLiteralToTyped` already recurses through nested
   BINARY_EXPRESSION and UNARY_EXPRESSION, so the whole subtree gets pinned in
   one call. This also gets the range check for free: `x == 300` where x is
   `uint8` should be a diagnostic, and today it is not.
2. **Backstop.** `llvmType` throwing a bare `Error` with no span is the actual
   reported cost, and there will be a third path. Make an untyped type reaching
   `llvmType` produce a compiler-internal diagnostic that names the node's
   `sourceLoc` and says what it is: "internal: expression still has an
   unpinned literal type at codegen (this is a compiler bug, please report)".
   Preferably assert it earlier - a cheap post-typecheck walk that rejects any
   `resolvedType` of kind `untypedInt` / `untypedFloat` / `untypedNull` before
   codegen runs, with the span, is a better place for it than `llvmType`.

Part 2 is worth more than part 1 over the long run and should not be skipped
once part 1 makes the reported symptom go away.

### 1.2 Allocation failure is a null dereference (LIVE)

`yoop_ctx_alloc` ([runtime/yoop_alloc.c:57](../runtime/yoop_alloc.c#L57)) returns
whatever the installed allocator returns. The bump arena returns null when
exhausted. Nothing between there and the first store checks it, so the symptom
is `signal: 'SIGSEGV'` with the crashed process's buffered stdout lost.

Confirmed unchecked call sites in `std/core/vec.yoop`: `vec_new` (line 50),
the grow path (62), `vec_extend_from` (113), and the copy path (141). Same for
`std/test.yoop`'s 1 MiB `SUITE_ARENA_BYTES` (line 46), which is where
yooperdoom hit it.

**Fix, in the order it should be done.**

1. **The runtime aborts with a sentence.** Add a fail-fast path to
   `yoop_ctx_alloc`: on a null return from the installed allocator, write
   `yoop: allocator exhausted: wanted N bytes, align M, arena has K free` to
   stderr and `abort()`. Stderr specifically, and unbuffered, because the whole
   reported pain was that the test harness swallowed the buffered stdout.
   Getting "have K" right means the arena allocator has to report its own
   remaining capacity, which `yoop_arena_used` almost gets there already.
2. **Give it an escape hatch.** Some programs legitimately want to handle
   exhaustion. A `tryAlloc`-shaped path (returns null, does not abort) that
   `ctx_alloc` is the aborting wrapper over. Do not make the default the
   quiet one; abort-by-default is the behaviour that turns a ten minute bisect
   into a line of output.
3. **std/test says which suite.** `runAll` knows the suite name; a suite that
   blows its arena should say `suite "readsAFile" exhausted its 1 MiB arena`
   rather than the generic runtime message. Optionally let a suite ask for a
   bigger one, since "a test that wants to read 28 MB is usually a test that
   should not" is right but not always.

Size: small for part 1, small for part 3, medium for part 2 if the null-
returning path has to be threaded through `Vec` as a `Result`.

---

## 2. Tier 2: papercuts, cheapest first

Each of these was re-probed. All five reproduce.

### 2.1 `bool` has no `==` or `!=` (LIVE, cheapest fix on this page)

```text
operator "!=" cannot be applied to bool and bool
```

`unifyArith` ([coerce.js:225](../src/jsyooptypecheck/coerce.js#L225)) handles
`eqeq`/`neq` for variants, value enums, and pointers, and handles bool only for
`andand`/`oror`. Booleans fall through to the "both typed -> must match
exactly" branch at the bottom, which requires `isIntPrim || isFloatPrim` and so
rejects them.

**Fix:** add an `eqeq`/`neq` case for two bools returning bool, next to the
variant case. Codegen already emits `icmp eq i1` correctly for everything else
that lowers to `i1`, so this is very likely typecheck-only. Confirm with the
existing `INT_OP_MAP` path.

The reported workaround was `(a && !b) || (!a && b)`, which needed a named
helper to stay readable. That is a lot of cost for a one-branch fix.

### 2.2 Keywords that cannot be parameter names (LIVE)

Probed one at a time. Failing: `in`, `from`, `kind`, `as`. Not failing: `to`,
`of` (never were keywords). All fail identically and unhelpfully:

```text
r_kind.yoop:1:12: expected rparen, got kind
```

`kind` is the one the takeaways single out, and correctly: it is legal as a
struct FIELD and illegal as a local or parameter, so `Room.kind` compiles and
`specialFor(kind: uint8)` does not, and the collision surfaces nowhere near
where the name was chosen.

**Fix, two independent halves, do the first one.**

1. **Demote the kind-clause vocabulary to contextual keywords.** The precedent
   is already in the tree: `contains` is deliberately absent from
   `keywordTagList` ([lexer.js:231](../src/jsyooplexer/lexer.js#L231)) and
   recognized contextually by the parser inside kind decls, with a comment
   saying why. The same argument applies verbatim to `kind`, `binding`,
   `parameter`, `field`, `scope`, `io`, `globalState`, `requires`, `appliesTo`,
   `mustCall`, `ownsBlock`, `beforeScopeEnd`, `mustNotEscape`, `mustNotShare`,
   `forbids`, `acrossScopes`, `propagates`, `align`, and `layout`. Every one of
   them is only meaningful in a position the parser already knows it is in, and
   several (`field`, `scope`, `io`, `parameter`, `binding`) are extremely
   natural identifier names. This is mechanical: move the entry out of
   `keywordTagList`, add the contextual recognizer where the clause is parsed.
   Do it as one change with a test per demoted word, not one at a time.
2. **Accept a keyword in identifier position where it is unambiguous** -
   specifically a parameter name, a `let`/`const` name, and a struct field
   name, which are the three positions where the next token settles it (`:` or
   `,` or `)` or `=`). This covers `in`, `from`, and `as`, which cannot be
   demoted because they carry real grammar (`for x in`, `import ... from`,
   `import * as`). Lower value than part 1 and slightly riskier; treat it as
   optional.

Whichever half lands, the diagnostic is worth fixing on its own: "expected
rparen, got kind" should be "`kind` is a reserved word and cannot be used as a
parameter name".

### 2.3 `printf` with a template-literal format silently prints the wrong thing (LIVE, not in the takeaways as a bug)

The takeaways record this as a house rule ("printf's own varargs do not
substitute"), but it is a silent-wrong-output bug, which puts it above the
other papercuts. Probed:

```js
printf("%s", name);    // A[bob]      correct
printf(`%s`, name);    // B[%sbob]    wrong, and silent
printf("n=%d", n);     // C[n=7]      correct
printf(`n=%d`, n);     // D[n=%d7]    wrong, and silent
printf(`n=${n}`);      // E[n=7]      correct
```

The behaviour is internally consistent - a template literal is a
literal-percent context, so its `%` is escaped to `%%` on the way out, and the
trailing value arg then gets an auto-appended specifier - but the result is a
program that prints something no one asked for and never errors.

**Fix:** reject it. A call to `printf` whose format argument is a
TEMPLATE_LITERAL and which also has trailing value arguments is a mistake in
every case; there is no way to spell a directive in a template. Diagnose it:
"a template literal is not a printf format string - interpolate the value
(`${name}`) or use a double-quoted format literal". Both emitters need it
(`emitPrintfCall` and `emitPrintfCallInner`), or better, put the check in the
typechecker where there is only one of it. Small.

### 2.4 A `disposable` binding is const (NOT A BUG - working as designed)

The takeaways list this as a papercut. It is deliberate, and the escape hatch
already exists. `let disposable b: Buf = ...` compiles and is mutable:

```js
let disposable b: Buf = { len: 4 };
b.len = 9;                            // fine
```

A bare `disposable b: Buf = ...` is const on purpose. Reassigning the binding
would drop the original value on the floor **without disposing it**, which is a
leak the compiler cannot see: the auto-cleanup fires once, at scope end, for
whatever the binding holds then. Anyone who genuinely wants to rebind has to
say `let` and take responsibility for disposing the outgoing value first, which
is exactly the shape a string-manipulation loop needs (dispose the old buffer,
then reassign the result of the next `replace`).

So const-by-default is the safe default and `let disposable` is the informed
opt-in. Keep it.

**Action: documentation only.** The rule is not written down anywhere a reader
will find it, which is why it read as a papercut. Two places to say it:

- `std/core/kinds.yoop`, on the `disposable` decl: one sentence on why the bare
  form is const and what `let disposable` means.
- SPEC section on kind-prefixed bindings, same sentence.

Worth a fixture in `examples/pass/` too, showing the dispose-then-reassign loop,
since that is the shape that motivated it.

### 2.4b A bare `{ ... }` block is not a statement (LIVE, found while writing the 2.4 fixture)

Not in the takeaways - found here, and unrelated to `disposable` despite how it
surfaced. A brace-delimited block is only a statement in Yoop when something
else introduces it (a function body, an `if`, a loop, a `switch` arm, a
block-owning kind). On its own it is not:

```js
function main(): int32 {
    { let x: int32 = 1; }   // expected colon, got ident
    return 0;
}
```

`parseStatement` has no `lbrace` case, so the block falls through to
`parseExpressionStatement` and gets parsed as a STRUCT LITERAL - which is why
the error talks about a missing colon and points at the first binding's name.
Confirmed pre-existing at `18843a0`.

Two things were separable here, and both are now settled.

- **The diagnostic was actively misleading**, and that is fixed. A `{` at
  statement start now says a bare block is not a statement and lists what a
  block can belong to, rather than describing a struct literal the user was not
  writing.
- **Supporting it: DECIDED, no.** The argument for was that a bare block is the
  only way to bound a `disposable`'s lifetime without inventing a function or
  reaching for a region kind that owns an allocator. The argument against won:
  `ephemeral EXPR { ... }` already covers a scoped region, a named function
  covers the rest, and a second block form is one more thing to specify and
  test for a want that has come up once. The diagnostic naming both existing
  options is the answer.

  Revisit only if the "bound this one disposable" shape shows up repeatedly in
  real programs and neither existing form fits - and if it ever does, note that
  `ephemeral` with a no-op guard is close enough that a std helper might be the
  cheaper fix than new grammar.

Fixture note: `examples/pass/disposable_rebind.yoop` uses functions rather than
bare blocks for its two scopes, and says so, so it does not silently depend on
the outcome.

### 2.5 No nested functions (LIVE)

```text
p4.yoop:3:5: unexpected token in expression: function
```

Reported cost was "a test helper inside a `suite` body is a parse error". That
is a real shape: `suite function addsNumbers()` wants its assert helpers next
to the cases, and today they have to go to module scope.

**Recommendation: do not implement nested functions.** Closures are a large
feature (capture analysis, escape rules, and a representation decision that
interacts with the kind system) and this is the only report of wanting them.
Instead, make the diagnostic say what to do: "functions cannot be declared
inside a function body - declare it at module scope". Small, and it converts a
baffling parse error into a two second redirect. Revisit the real feature if a
second independent program asks for it.

---

## 3. Tier 3: std/http

The takeaways are right that the server is real and the client and proxy story
is not. Ordered by value per unit of work, which is not the order they are
listed in over there.

### 3.1 Chunked transfer decoding - DONE (2026-08-11)

Go's HTTP server chunks anything it cannot size up front, which means ollama
and most local model runners, which meant the first full-size reply from a
local model never arrived. `readHeaderLines` returned an honest 501 and that
was that. The HTTP/1.0 stopgap that yooperdoom shipped (1.0 has no chunked
encoding at all, so the server answers 1.0, sets `Connection: close`, and the
body is delimited by the socket closing) is no longer needed.

**Both directions.** The client decodes a chunked response; the server decodes
a chunked request body.

The decoder is INCREMENTAL, and that is the design decision worth recording. A
body arrives across many reads, and re-decoding the whole buffer after each one
is quadratic. `ChunkedReader` in `wire.yoop` holds a cursor that only ever
advances past a COMPLETE chunk, so every byte is examined once and every data
byte is copied once; a short read costs one re-examination of a size line and
nothing else. It lives in `wire.yoop` because that file is socket-free, which
is what lets the decoder be exercised against a byte literal.

What it handles, all covered by fixtures: chunk extensions (`1a;name=value`),
uppercase hex sizes, trailer fields, and bodies split arbitrarily across reads.
What it rejects: a non-hex size, data not followed by CRLF, an over-long size
line, an over-large trailer section, and a body over the caller's limit. Both
size ceilings are on the DECODED total rather than the raw bytes, because a
sender can inflate the raw count with tiny chunks and extensions.

Trailers are consumed and DISCARDED. RFC 9112 permits it, and merging them into
the header map after the handler already has its headers is how a trailer
becomes a way to smuggle a header past whatever inspected the head.

**Found while doing it:** a message carrying BOTH `Transfer-Encoding` and
`Content-Length` was previously accepted (the 501 fired first, so it never
mattered). That is the exact ambiguity request smuggling is built on - one
intermediary frames by the length, the next by the chunks - and RFC 9112
section 6.1 says reject. Now rejected in both directions.

Fixture: `examples/pass/http_chunked/`. Its peer is a RAW socket writing canned
bytes, because a real HTTP server cannot produce a bad hex size or a missing
CRLF; the client and server halves under test are the real ones.

### 3.2 An awaitable `Handler.handle`, and task-per-connection - DONE (2026-08-11)

Both halves landed. `Handler.handle` is `async`, and `serveConcurrent` runs a
task per connection with a hard cap and a 503 over it.

**The proxy is the proof.** `examples/pass/http_proxy/` runs an origin, a proxy
whose handler forwards through the std HTTP client, and a client that only ever
talks to the proxy - and the client sees the origin's body AND a header the
origin set. That program was unwritable before: `handle` was synchronous,
`client.send` is async, and `await` is only legal inside an async function.

A handler that does no I/O just declares `async` and never awaits, which costs
one frame allocation and no suspend. The hello_server e2e assertion that its
handler carries NO `presplitcoroutine` is now inverted.

**Three constraints shaped the concurrent loop, and each killed a more obvious
design. They are worth keeping because they are properties of the runtime, not
of HTTP:**

1. **One accept loop, not N acceptor tasks.** The multiplexer allows one waiter
   per (fd, direction); a second task awaiting accept on the same listener gets
   `EAGAIN` back, not a queued turn. Verified directly - the "K workers all
   calling accept" model does not work today.
2. **No collection of in-flight task handles.** `Task<T>` cannot go in an array
   or a Vec: the typechecker requires a kind-prefixed binding (`pooled h =
   f()`) because that is what manages the handle's refcount. So connections are
   FIRE AND FORGET - the handle is released at the end of the accept arm and
   the task runs on, which works and is tested.
3. **The counter must be caller-owned.** Because connections outlive the accept
   loop, a counter in `serveConcurrent`'s own frame would dangle the moment it
   returned. That constraint is a gift: since the state has to be caller-owned
   anyway, it may as well be readable, so `ServeState` carries `inFlight`,
   `peak`, `accepted`, `rejected`, and `served`.

At capacity the connection is accepted and answered with a 503 + `Retry-After`
rather than left to hang - one small write, no task spawned. A refused client
knows it was refused instead of timing out against a silent peer.

**Two things this needed that did not exist:**

- `std/core/atomic.yoop` (over a new `runtime/yoop_atomic.c`). Yoop could
  already SHARE mutable storage across tasks - a module-level `let` is visible
  from every task - but had no way to update it safely, and `n = n + 1` from
  two workers loses counts. Deliberately tiny: add, load, store, and a
  high-water max, all sequentially consistent. The surface takes `ref int32`
  rather than `unsafe_ptr<int32>` so a caller does not need `import.unsafe;` to
  count something.
- A codegen fix. `f(ref someModuleLevelGlobal)` emitted `%name` - a local slot
  that does not exist - instead of `@<modid>__<name>`. It passed typecheck AND
  IR generation and was rejected by clang, the same failure shape as the
  extern-sibling mangling bug. `emitLval` already had the `isModuleGlobal`
  check; the REF_EXPRESSION path did not, in BOTH emitters.

Fixture: `examples/pass/http_concurrent/`. `peak=2` is the assertion that
matters - two connections handled at the same instant, where `serve` gives 1 by
construction. The refusals are made deterministic by staggering (two holders
take both slots and sleep past the point where the late clients connect), so
`rejected=2` is not a timing coincidence.

**Still serial:** `serve` itself is unchanged, so existing callers keep their
behaviour. Playground programs were updated to the async handler where one line
did it; `todo_api`, `yoopstore`, and `chat_agent` still have PRE-EXISTING
breakage from when `serve` became async (they call it without `await` from a
sync `main`), which is stale-playground territory rather than fallout here.

### 3.2b The original write-up, for the reasoning

These two are one piece of work and they are the difference between a server
and a proxy.

Today `Handler.handle` is deliberately synchronous - CLAUDE.md records that as
a deliberate stopping point, and the hello_server e2e asserts its `define`
carries no `presplitcoroutine`. That was the right call when it was made,
because it bounded the async blast radius. But `client.send` is async, so a
handler cannot call the client, so a proxy cannot be written straightforwardly.
Every sidecar, gateway, and load balancer is a proxy.

And `serve` handles one connection at a time
([server.yoop:29](../std/http/server.yoop#L29) states it plainly). The good news
is that `serveConnection` is already exported
([server.yoop:313](../std/http/server.yoop#L313)), so the workaround -
`examples/playground/counter_server`, and the pattern in this repo's own memory
notes - is to write your own accept loop that spawns a task per connection.
When the workaround is "reimplement the library's main loop", the workaround
belongs in the library.

**Plan:**

1. Make `Handler.handle` async. Mechanically this is the same change that made
   `Readable.read` async: the trait signature gains `async`, `isAsync` flows
   through `sigsEqual`, and every implementer declares `async` even if it never
   suspends (an async function that never awaits runs straight through on its
   first step). Update the hello_server e2e assertion, which will now be
   asserting the opposite of what it asserts today.
2. Add a task-spawning accept loop next to `serve` - `serveConcurrent`, or a
   `ServerConfig` field, decide which. Per-connection concurrency needs a
   bound (a max in-flight count) or a slow-loris client becomes a task leak.
   Note the per-task allocator context rule: a spawned task inherits nothing
   from its spawner, so per-connection arenas become natural here, which may
   also address the "strings built while parsing are never freed" note in the
   same file header.
3. Write the proxy. A tiny reverse proxy in `examples/pass/` is the proof that
   both halves landed, and it is the thing that could not be written before.

Medium to large, and it touches the async invariants, so read
`plans/async-coroutines.md` first.

### 3.3 TLS - PLANNED, see [tls.md](tls.md)

Correctly identified as "one stdlib module between a demo and a program you
could ship". Every commercial model API is HTTPS-only, and that single fact is
the entire reason the yooperdoom sidecar is a Node process.

The plan is written. Two of its findings are worth knowing even if the work
never starts:

- **The obvious TLS design is unimplementable here.** Handing OpenSSL the fd
  and reacting to `SSL_ERROR_WANT_WRITE` means "wait until writable", which
  `runtime/yoop_io_internal.h` states cannot be expressed on IOCP at all. So
  memory BIOs are forced, not preferred - Yoop moves the ciphertext through the
  operation-based path that already works on all three platforms.
- **Phase 0 is worth doing on its own.** `std/http` naming `TcpStream`
  concretely is what blocks a `TlsStream` from slotting in, and
  `std/core/traits.yoop` already declares the `Reader`/`Writer` vtables for
  exactly this case - naming `TlsStream` in its comment. That refactor needs no
  external dependency, is verifiable with the existing suite, and leaves
  `std/http` testable with no socket at all.

This is the largest item in this document and it needs its own plan doc, not a
bullet. The decision to make first is not code, it is scope:

- **Bind an existing library** (OpenSSL / LibreSSL / BoringSSL, or platform
  native: Secure Transport is deprecated on macOS, so it would be Network.framework
  there and SChannel on Windows). Realistic, gets a shippable client quickly,
  and pays in build/link complexity plus a per-platform story that has to work
  on all three targets this repo supports.
- **Write one.** No.

Recommend: bind OpenSSL via a `yoop_tls_*` shim in `runtime/`, following the
exact precedent `yoop_net.c` set for sockets - present one POSIX-shaped API to
yoop and hide the platform underneath. Ship client-side first (verify, SNI, ALPN
off); server-side TLS can wait. Make it opt-in at link time the way
`framework:OpenGL` is, via `glueSourcesForLinkFlags`, so a program that does not
want TLS does not grow a dependency on it.

### 3.4 Streaming bodies, gzip, client keep-alive, redirects

Real, and all downstream of the three above. Streaming in particular is how
model APIs deliver tokens (SSE), and it cannot be expressed while bodies are
fully buffered `Vec<uint8>`. It also wants an async `Handler.handle` to be
useful, so it lands after 3.2 or not at all. `Content-Encoding: gzip` needs the
inflate module from section 4. Defer all four; revisit after 3.1 to 3.3.

---

## 4. Tier 4: the modules every program writes for itself

### 4.1 Discoverability first, modules second

TAKEAWAYS 3.4 calls this "the uncomfortable finding" and it is the most
actionable item in section 3. A 15,000 line project imported `std/core/format.yoop`
in three files and hand-rolled a `48 + n % 10` digit loop in four others.
`history.yoop` zero-pads a slot number by hand, which is exactly
`padStart(int_to_string(n), 4, "0")`.

That is not a missing feature and adding modules will not help it. **Do this
before adding any module in 4.2**, or the new ones will be undiscovered too.

Four candidate fixes, and they compose:

1. **A one-line "what this module is for" header on every std module, in a
   consistent place and format**, so a directory listing plus `head -3` is a
   usable index. Several std modules already have excellent headers
   (`std/core/alloc.yoop`, `std/http/server.yoop`); the rule is to make it
   universal and uniform, and to lead with the sentence rather than bury it.
2. **A generated `std/INDEX.md`** - module, one-line purpose, the five most
   used exports. Generated from those headers plus the export lists so it
   cannot drift. This is a small script, and `tools/yoopdist` is a precedent
   for writing that kind of tool in Yoop.
3. **A `std/prelude`.** Tempting and I would hold off. It fights the
   namespace-import rule that std value imports already enforce, and the real
   problem reported was not import friction, it was not knowing the function
   existed. An index solves that; a prelude only helps for whatever it happens
   to include.
4. **Doc comments in the LSP.** The comment block immediately above a
   declaration is documentation, and the editor should show it. Read the
   contiguous run of comment lines directly above a decl's first token, stopping
   at the first non-comment line, and feed it into hover and completion detail.

   This is the fix that makes 1 and 2 pay off continuously rather than once,
   because it turns every header comment already in std into tooling output with
   no new convention to maintain, and it rewards writing them on user code too.
   It also removes the reason a reader would go looking for an index at all in
   the common case: `padStart` explains itself on hover at the call site.

   Mechanics: the parser stamps `startLoc` on statements already (added for the
   unreachable-code span), which is the anchor to scan back from. The scan is
   over source text, not tokens, since comments are eaten by `charEaters.js` and
   never reach the token stream - so this is "walk back from `startLoc.pos`,
   collect lines, stop at a blank or non-comment line". Both `//` runs and a
   single `/* */` block should count. Attach the result to the decl node so
   `hover.js` and `completion.js` in `src/lsp/` read one field rather than each
   reimplementing the scan (the `findInModule` lesson from `nav.js`).

Recommend 1, 2, and 4. They are the highest ratio of value to effort in this
entire document, and item 4 is the one with ongoing value: 1 and 2 are a
one-time sweep that decays, 4 pays out on every hover forever.

### 4.2 The missing modules, ranked

Verified absent from `std/` as of `18843a0`:

- **`getenv`** - `std/env.yoop` has `argCount` and `argAt` and nothing else. It
  is one extern declaration plus a doc comment about the returned string's
  lifetime (borrowed, same as `argAt`). Do this one this week; it is fifteen
  minutes and it is why the yoop sidecar took flags where the Node one read an
  environment variable.
- **Wall clock / calendar time** - `nowNs` (monotonic) is exposed in three
  places (`std/core/concurrency.yoop`, `std/runtime.yoop`,
  `std/core/cancel/token.yoop`) but there is no wall clock in yoop at all.
  `yoop_wall_ns` exists in the runtime and is deliberately kept distinct from
  the deadline clock, so exposing it is small; a `struct tm`-shaped breakdown
  and an ISO-8601 formatter is the actual work. yooperdoom numbers its history
  files `run-0007-*` explicitly because it had no clock.
- **base64** - pure yoop, no FFI, maybe 80 lines with the decode table. No API
  auth or binary payload works without it.
- **sha256 / hmac** - pure yoop, well-specified, testable against known
  vectors. Request signing is table stakes for cloud APIs. Together with base64
  this is one focused module pair and a good candidate for a
  `--test`-harness showcase.
- **inflate / gzip** - larger, and it is a prerequisite for HTTP
  `Content-Encoding`. Sequence it with 3.4.
- **process spawn** - needed to shell out at all. Wants a design decision
  (`posix_spawn` versus `fork`/`exec`, and what the Windows story is) before
  code, and it interacts with the runtime's signal and worker-thread handling,
  so it is the largest of the six despite sounding the smallest.

Suggested order: getenv, base64, sha256/hmac, wall clock, then the other two
when something concrete needs them.

---

## 5. Tier 5: compile-time field reflection

TAKEAWAYS section 3 is the strongest argument in the document and I agree with
its conclusion: do not put JSON in the language. The reason people ask for it
is not the syntax, it is that they do not want to hand-write encoders, and that
want is format-neutral. One reflection feature serves JSON, CBOR, MessagePack,
protobuf, and whatever is next, and none of them gets to be privileged.

**This repo already has a field-reflection mechanism.** `src/jsyoopderive/`
walks a struct's fields by name and type, generates a `Display.to_string`
method as source text, reparses it with the ordinary parser, and grafts it onto
the decl. That is exactly the machine the JSON question needs; it is just
hard-wired to one trait and one output shape. That is the good news and it is
also the trap: generalizing it the obvious way (add `@derive(encode)` next to
`@derive(display)`) buys JSON quickly and buys nothing for CBOR, because every
new codec would need a compiler change. That is the bet the takeaways
explicitly warn against.

Two designs are worth writing up properly. This section is a spike brief, not a
plan.

**Design A: a `TypeInfo` intrinsic (runtime reflection over static data).**
`intr.typeInfoOf<T>()` returns a compiler-emitted static
`TypeInfo { name: string, fields: FieldInfo[] }` where each `FieldInfo` carries
name, byte offset, a type-kind tag, and a type name. Codegen already computes
every one of those - `debugInfo.js`'s `typeRef` builds per-field offsets from
`sizeOfType`/`sizeOfAlign` for DWARF, which is the same walk. A userland
encoder then walks the field list and reads each field through `unsafe_ptr` plus
offset.

- Wins: genuinely format-neutral, codecs are ordinary third-party modules,
  small compiler change, no comptime interpreter needed.
- Costs: it is runtime reflection, so there is a per-field dispatch; the codec
  needs `import.unsafe`; and nested/generic/variant field types need a
  recursive story that gets fiddly fast.

**Design B: trait-driven generation (compile-time, zero cost).** `@derive(encode)`
expands against a user-nameable `Encode` trait, with the per-field work
delegated to `Encode` on the field's own type, so the generator emits calls
rather than knowing formats. This is what the Display generator already does
for Display-implementing fields.

- Wins: no runtime cost, no unsafe in user code, reuses the existing machine.
- Costs: the derive doc names the blocker directly - the generator would need
  to resolve type NAMES to decls pre-typecheck to expand a non-deriving field
  type, and today that is a clear error instead. Generic decls are also
  explicitly deferred in the deriving path, and `Vec<T>` fields are exactly
  what a codec meets. And the neutrality is only as good as the trait surface:
  an `Encode` trait shaped around JSON's value model will not fit CBOR's.

**Recommendation.** Spike A, because it is the one that actually delivers
neutrality and it is small enough to prototype in a week, and because it can be
retired later if B matures - a codec written against `typeInfoOf` and a codec
generated by a derive can coexist and be diffed against each other. Write it up
as `plans/compile-time-reflection.md` with a worked `Encode`/`Decode` pair and a
JSON reference implementation before writing any compiler code, because the
trait shape is the part that is hard to change afterwards.

Sequence this **after** the self-hosting work is further along, not now. It is a
large language feature, it is not on the bootstrap path, and the bootstrap
compiler is itself going to teach a lot about what walking a typed structure
wants to look like.

### 5.1 What `modules/json` learned, worth writing down

Independent of reflection, the yooperdoom JSON arena design is a pattern this
repo should record, because it generalizes past JSON to every document-shaped
type: every node is a slot in parallel vectors, a node reference is an index,
and disposing is dropping the vectors. No recursive walk, no per-node
allocation, no leak. The obvious recursive-variant design compiles and cannot
be freed without a hand-written traversal.

That is the same conclusion `plans/bootstrap-pipeline-contracts.md` reached
independently for the AST arena, which is a strong signal. Worth a short
section in `plans/library-design.md` naming it as the house pattern for
documents and trees.

---

## 6. Sequencing

Grouped by what they cost and what they unblock, not by section order.

**DONE (2026-08-11).** Everything in the first two groups plus the LSP half of
the discoverability work landed together. Full suite green at 1070 tests, up
from 1020.

- `bool` `==` / `!=` (2.1) - one branch in `unifyArith`; codegen already
  lowered `i1` correctly. Ordered comparison stays rejected.
  `examples/pass/bool_eq.yoop`.
- `getenv` (4.2) - `env.get` / `env.has` / `env.getOr` over a `yoop_getenv`
  shim, with unset and explicitly-empty kept distinct.
  `examples/pass/env_vars.yoop`.
- The `printf` template-literal diagnostic (2.3) - a template format plus
  trailing value args is now an error naming both correct spellings. One
  playground caller was silently printing `%s`; fixed.
- The `strFree` doc drift, and the more dangerous one in yooperdoom (0.3).
- Why a bare `disposable` is const (2.4) - `std/core/kinds.yoop`, SPEC, plus
  `examples/pass/disposable_rebind.yoop` (proves nothing leaks across a
  rebinding loop) and `examples/fail/disposable_const_assign.yoop`.
- Untyped literals (1.1) - the root fix pins to the TYPED side of a
  comparison. The backstop (`untypedGuard.js`) then found **two more latent
  codegen crashes nobody had reported**: `_ = 1 + 2;` and a bare `1 + 2;`
  statement, both confirmed to throw `llvmType: unhandled` at `18843a0` and
  both fixed. `examples/pass/untyped_literal_pinning.yoop`.
- Allocator exhaustion (1.2) - prints what it wanted and what the region had,
  flushes stdout, exits 1. `yoop_ctx_alloc_try` is the non-fatal escape hatch.
  The suite-naming half of the plan turned out to be free: flushing stdout
  means the TAP `# <suite>` line survives, so no label plumbing was needed.
  `examples/pass/arena_exhausted.yoop`.
- Contextual keywords (2.2) - twelve words demoted (`kind`, `requires`,
  `propagates`, `binding`, `parameter`, `field`, `scope`, `io`, `layout`,
  `align`, `library`, `contains`), plus a reserved-word diagnostic that names
  the word and, for `in` / `from` / `as`, why it has to stay reserved. The
  VS Code grammar moved with it (a bare `\b(kind)\b` rule would have coloured
  every `kind:` field as a keyword) and is guarded by `grammar.test.js` the
  same way the `module` rule is. `examples/pass/contextual_keywords.yoop`.
- Nested-function and bare-block diagnostics (2.5, 2.4b).
- Doc comments in the LSP (4.1) - `docCommentAt` in `nav.js`, wired into hover
  through `findDefinition` so it works at a call site and across files.

**ALSO DONE (2026-08-11), second pass.** The discoverability work and the
first three std modules. Suite at 1079 tests.

- Doc comments in COMPLETION as well as hover (4.1). A namespace import
  documents itself with the imported file's HEADER, which is the module index
  delivered at the point of use.
- Module headers (4.1) - the survey found this much smaller than assumed: one
  file had no header (`std/core/numbers.yoop`) and two carried stale paths from
  the directory-module move. What was actually missing was a way to document a
  MODULE as opposed to a FILE, since every file of `std/http` describes itself
  and taking one at random made the module read as "a minimal HTTP/1.1 client".
  New convention, needing no new syntax: **a comment ABOVE `module <name>;`
  documents the module, one below it documents the file.** Both the index
  generator and the LSP follow it.
- `std/INDEX.md` (4.1) - generated by `tools/stdindex`, WRITTEN IN YOOP per the
  `tools/yoopdist` precedent, wired to `npm run gen:index`. A generated file
  that is checked in rots, so `src/std_index.test.js` guards coverage in both
  directions (nothing on disk missing from the index, nothing in the index
  missing from disk) without needing clang.
- `std/encoding/base64.yoop` (4.2) - both alphabets, permissive decode
  (padding optional, whitespace skipped, both alphabets accepted) and strict
  errors. RFC 4648 vectors plus a 256-byte binary round-trip.
- `std/crypto` (4.2) - SHA-256 + HMAC-SHA-256, pure yoop, incremental and
  one-shot, with `equalConstantTime` because comparing MACs with a normal loop
  leaks the answer a byte at a time. Every fixture value cross-checked against
  Node's crypto: FIPS 180-4, RFC 4231, and the 131-byte key that forces the
  hash-the-key-first branch.
- `std/time.yoop` (4.2) - the wall clock and the calendar, over a new
  `runtime/yoop_time.c`. Kept deliberately distinct from the monotonic clock,
  which is what the header says first. `DateTime` implements `Display` and
  renders ISO-8601. Its `pad2` helper is `padStart(int_to_string(n), 2, "0")`,
  which is the exact pairing 4.1 found four hand-rolled copies of.

Nothing left open in this group; what remains of 4.2 (process spawn,
inflate/gzip) is in the deferred list below, where it always belonged.

Closed without code: whether a bare `{ ... }` block should be a statement
(2.4b) - decided no, see that section.

**Then - HTTP, in this order and not in parallel:**

1. ~~Chunked decoding, alone (3.1)~~ **DONE (2026-08-11)**, both directions.
2. ~~Async `Handler.handle` plus a bounded task-per-connection loop, with a
   reverse proxy as the proof (3.2)~~ **DONE (2026-08-11)**.
3. ~~TLS (3.3)~~ **client-side DONE (2026-08-11)**: phases 0 through 2 of
   [tls.md](tls.md). Real verified TLS 1.3, and `https://` through the
   ordinary client. Phase 3 (Windows root store) and phase 4 (server-side
   TLS) remain.

**Deferred, deliberately:**

1. Streaming bodies, gzip, client keep-alive, redirects (3.4)
2. Compile-time field reflection (5) - spike doc now if you want, code after
   the bootstrap is further along
3. Process spawn and inflate/gzip (4.2) - both want a design decision before
   code, and nothing concrete is blocked on them yet

The first three groups are the ones that pay off directly against
`plans/README.md` priority 2, because they are all friction the bootstrap
compiler will hit while being written in Yoop. The HTTP group is a different
program: it is about what Yoop can talk to, not about what it is like to write,
and it should not be allowed to displace the self-hosting work.
