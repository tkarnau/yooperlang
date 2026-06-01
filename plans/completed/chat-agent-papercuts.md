# Plan - Language papercuts surfaced while writing the HTTP chat agent

## Context

Writing [examples/playground/chat_agent/main.yoop](../examples/playground/chat_agent/main.yoop) -
a self-contained chat agent that talks over real HTTP sockets - was a
small but representative exercise of the std/net + std/http stack from
the *application* side rather than the library side. One process plays
both roles: a background `task` runs an HTTP server whose Handler routes
the POST body through a pluggable "brain" (a `ChatBrain` trait), and the
main thread is the HTTP client that sends a scripted series of user turns
and prints the transcript.

The program compiles and runs today. It exercises:

- real loopback TCP (std/net) + HTTP framing (std/http), client and
  server, in one binary
- per-request state surviving across separate connections (the turn
  counter in the handler, observable as "turn 3" / "turn 4" in the
  output)
- the `disposable` kind on Vec / Bytes / Request / Response
- reading a POST body and reflecting (a laundered copy of) it back

This doc records the friction. The headline item (Issue 1) is the one
the exercise was partly aimed at: where the **kind system wants a rule
it does not yet have**. The rest are smaller and in the same flavour as
[yoopbinder-papercuts.md](yoopbinder-papercuts.md) and
[completed/yoopstore-papercuts.md](completed/yoopstore-papercuts.md).

## Design notes (what the trait/kind audit produced)

Per the user ask and [kinds-design.md](kinds-design.md), two things came
out of asking "what trait or kind would help here":

- **A `ChatBrain` trait was worth adding.** The HTTP plumbing (read body,
  set status, write reply) is policy-free; the reply policy is the part
  that varies. Splitting `reply(heard, turn, ref out)` behind a trait
  means a smarter brain drops in as a one-line field change on
  `ChatHandler` without touching the server loop. This is the same
  "Handler is the extension point" shape the std server already uses,
  one level deeper. Kept lean: one trait, one impl, no generics on the
  handler (the brain is a concrete field).
- **A `tainted` kind would help but cannot be expressed today.** The
  chat message off the socket is untrusted and gets reflected back. That
  is textbook `tainted` (kinds-design.md lists it explicitly). But the
  kind grammar has no rule for the obligation taint actually carries -
  see Issue 1. So the example uses a plain `sanitize()` function and a
  comment, which is exactly the "validator without a kind" anti-pattern
  kinds-design.md warns about. That is not a failure of the example; it
  is the language gap the example is meant to surface.

## Issues, by impact

### Issue 1 - No kind rule for "must be laundered before use" (taint / clearance) [LANDED]

**Severity: HIGH (expressivity gap; blocks a whole family of kinds the
codebase already wants). Full implementation plan:
[clearance-kinds.md](clearance-kinds.md). v0 has landed - see the
Implementation Status section of that plan.**

#### Symptom

Every kind in the tree encodes "an obligation that is discharged at
scope end or transferred up": `disposable` is `mustCall dispose
beforeScopeEnd`, `joined`/`pooled` are task-wait obligations,
`mustNotShare` / `mustNotEscape` / `forbids` are prohibitions. The
kind-clause grammar (parsed in
[src/jsyooparser/parser.js:1027-1371](../src/jsyooparser/parser.js#L1027-L1371))
offers: `appliesTo`, `requires`, `mustCall <m> beforeScopeEnd`,
`ownsBlock`, `mustNotEscape scope`, `mustNotShare acrossScopes |
acrossThreads`, `forbids io | globalState`, `layout`.

There is no way to say the obligation that `tainted` (and `validated`,
`authenticated`, `parsed_uri` - all named in
[kinds-design.md](kinds-design.md)) actually carries:

> A value of this kind may not flow into certain *sinks* until it has
> passed through a designated *laundering* function, which consumes the
> tainted value and yields a clean one.

This is the dual of `mustCall ... beforeScopeEnd`. `disposable` is
*discharge before you leave*; taint is *discharge before you use*. The
discharge is not a method called for its side effect (`dispose`) - it is
a function whose *return value* is the laundered form, and the taint
must be gone at the sink, not at scope end.

The grammar even half-anticipates richer timing: `mustCall <m>
beforeAny` / `afterAny` lex fine but the parser rejects them with "not
yet supported in phase 6.1; use 'beforeScopeEnd'"
([parser.js:1335-1341](../src/jsyooparser/parser.js#L1335-L1341)). So
the timing axis is reserved; the *clears-by-a-function* semantic is the
genuinely missing piece.

In the chat agent this shows up as `sanitize(msg, ref out)` - a plain
function with a comment explaining the contract. Nothing stops a future
edit from passing the raw `req.body` string into a header value or a log
sink without sanitizing; the compiler would not notice. That is the
exact "did I forget to validate" bug class kinds exist to kill.

#### Sketch of the missing rule

Two new clauses (names illustrative):

```yoop
kind tainted {
    appliesTo binding parameter field;
    clearedBy launder;       // a fn (tainted T) -> T that strips the kind
    mustClear beforeSink;    // a still-tainted value cannot reach a sink
}
```

Plus a way to mark sinks - the parameters that refuse a tainted argument.
Either a parameter annotation (`headers_add(ref h, name: string, value:
clean string)`, where `clean` is "this kind must be absent") or a
function-level `requiresCleared` clause. The enforcement mirrors the
existing obligation tracker in
[kindCheck.js](../src/jsyooptypecheck/kindCheck.js): taint propagates
with the value the way `disposable` does, the only discharge is flowing
through `launder` (whose result is un-tainted), and reaching a sink with
the kind still attached is the error - the mirror image of an
unsatisfied `beforeScopeEnd` obligation at `popScope`.

#### Why it is worth it

This single rule unlocks every "must have been X'd" kind in
kinds-design.md's in-tree list (`validated`/`safe_path`,
`authenticated`, `parsed_uri`, `bounded`, `nul_terminated`) - they are
all the same shape: a launder/clear step plus a set of sinks. Today none
of them are expressible, so they all live as comments and `*_unchecked`
parameter names.

#### Acceptance

- A `kind tainted { ... clearedBy ...; mustClear ...; }` parses and
  type-checks.
- A value of a tainted-kinded binding cannot be passed to a sink
  parameter; the diagnostic points at the launder function as the fix.
- Passing the *result* of the launder function to the sink is accepted.
- A passing fixture (the chat agent's sanitize path, rewritten to use
  the kind) and a failing fixture (raw `req.body` straight into a sink)
  under `examples/`.
- kinds-design.md's "In-tree opportunities" list gets a note that the
  rule now exists.

---

### Issue 2 - Header values are borrowing string views, so handler-local strings dangle [RETRACTED]

**Severity: NOT A BUG. On investigation, `string_from_bytes_unchecked` already
copies its input into a fresh `malloc(len + 1)` buffer and writes the nul
terminator
([codegen.js:4655-4658](../src/jsyoopcodegen/codegen.js#L4655-L4658)). The
returned string fat-pointer points at that owned buffer, which lives forever
(strings are leaked-but-stable - the comment in respond_static already says
"string storage is never freed by yoop"). So a handler that stores
`intr.string_from_bytes_unchecked(view)` in a header value is SAFE: the
underlying `view` can be freed without invalidating the string. Verified with
a fixture that built a string from a `Vec<uint8>`, disposed the Vec, and read
the string back successfully. The chat-agent code avoiding this pattern was
unnecessary defensiveness; the original analysis was wrong.**

#### Symptom

`headers_add(ref h, name, value)` stores `value` as a `HeaderEntry {
value: string }`, and `string` is a borrowing fat-pointer view
([std/http/types.yoop:190-208](../std/http/types.yoop#L190-L208)). But
the server serializes the response *after* the handler returns
([server.js write_response runs after Handler.handle in serve_n,
std/http/server.yoop:278-289](../std/http/server.yoop#L278-L289)). So a
handler that does:

```yoop
let disposable buf: Vec<uint8> = vec_new(64);
// ... fill buf ...
let v: string = intr.string_from_bytes_unchecked(vec_as_array(ref buf));
headers_add(ref resp.headers, "X-Echo", v);   // v dangles after handle()
```

stores a header value backed by `buf`, which is disposed at the end of
`handle`. `write_response` then reads freed memory. Nothing in the type
system flags it.

I hit this while designing the echo path and *avoided* it by keeping the
dynamic content in the response **body** instead, handed over as owned
`Bytes` via `respond_bytes(ref resp, bytes_from_vec(ref reply))` - the
Bytes outlive `handle` and are disposed with the Response, so they are
still valid at serialization time. The body has an owned-storage story
(`ResponseBody.Owned`, yoopstore-papercut #6); headers do not.

#### Cause

Headers were designed for the literal case (`headers_add(ref
resp.headers, "Content-Type", "text/plain")`) where the value is a
string literal that lives forever. Dynamic header values - the common
case the moment a handler computes anything (an ETag, a Content-Length
it sets itself, a redirect Location built from input) - have no safe
home.

#### Fix

Options, roughly in order of cost:

1. Make `Headers` own its values: `headers_add` copies the name/value
   bytes into owned storage the Headers disposes. One copy per header;
   headers are small and few. Removes the footgun entirely and matches
   what `ResponseBody.Owned` already does for bodies.
2. A `validated` / lifetime-style kind that refuses a view-backed string
   in a header value (depends on Issue 1's machinery, plus a borrow
   story the language does not have yet).

Option 1 is the v0. It is a localized change to std/http/types.yoop and
turns a silent UAF into "just works".

#### Acceptance

- A handler can build a header value from request input and have it
  survive serialization.
- The hello_server / chat_agent demos still pass.
- A fixture that adds a computed (non-literal) header value and asserts
  the served response contains it intact.

---

### Issue 3 - `contains` (a kind-clause keyword) is reserved against ordinary function names [LANDED]

**Severity: LOW-MEDIUM (hit immediately; the colliding word is a very
natural identifier). FIXED:
[lexer.js:268](../src/jsyooplexer/lexer.js#L268) removes `contains` from
`keywordTagList` (it now lexes as `IDENT`); the parser recognizes it
contextually inside kind decls and propagation clauses via
`isContainsKeywordIdent` ([parser.js:309](../src/jsyooparser/parser.js#L309)
and the two call sites). Regression fixture at
[examples/pass/contains_as_function_name.yoop](../examples/pass/contains_as_function_name.yoop)
wired into [src/e2e.test.js](../src/e2e.test.js).**

#### Symptom

```yoop
function contains(haystack: string, needle: string): bool { ... }
```

fails to parse: `expected ident, got contains`. `contains` is a reserved
token because of the `contains<K>` kind clause (the sibling of
`propagates<K>`,
[parser.js:295-361](../src/jsyooparser/parser.js#L295-L361)). The chat
agent wanted a `contains(haystack, needle)` substring helper; it had to
be renamed to `has_substr`.

This is the same family as yoopbinder-papercut #10 (reserved keywords as
extern parameter names), but worse in one way: `contains` is not an
obviously-reserved word like `type` or `while`. It is an everyday
function name (every collection library has one), and it is reserved for
a feature that only ever appears in `kind` declaration bodies, never in
expression or top-level-decl position.

#### Cause

`contains` / `propagates` are full keywords in the lexer's keyword map
rather than contextual keywords recognized only inside a kind clause.
The parser's decl-name path (`parseIdentAsName`) then refuses them
everywhere.

#### Fix

Make `contains` (and, ideally, the other kind-clause-only words:
`provides`, `restricts`, `appliesTo`, `mustCall`, `ownsBlock`, etc.)
*contextual* keywords - reserved only in the positions where the kind
grammar expects them, and legal as identifiers elsewhere. The
deferred-feature pattern already does the inverse for not-yet-supported
clause keywords (lex as ident, error contextually); this is the same
idea applied so common words stay usable as names. If full
contextualization is too invasive, at minimum document the reserved set
somewhere a user writing application code will find it (today it is only
discoverable by hitting the parse error).

#### Acceptance

- `function contains(...) { ... }` and `let contains = ...` parse in
  ordinary code.
- `kind K { contains<J>; }` still parses (contextual recognition inside
  the kind body).
- A parser test covering both.

---

### Issue 4 - Tasks take no arguments, so server config cannot be threaded in [RETRACTED]

**Severity: NOT A BUG. Tasks already accept by-value parameters at every
layer: the parser routes `task f(...)` through `parseFunctionDeclBody`
([parser.js:2792](../src/jsyooparser/parser.js#L2792)) with the standard
param list, the typechecker walks `funcDecl.params` for tasks too
([typecheck.js:2691](../src/jsyooptypecheck/typecheck.js#L2691)), and codegen
stores args in the task handle struct at fields 7+i, then reloads them in
the thunk
([codegen.js:3645-3686](../src/jsyoopcodegen/codegen.js#L3645-L3686)). Spot
checks in existing pass fixtures confirm it: `task compute(x: int32): int32`
in [at_precompile_tasks.yoop](../examples/pass/at_precompile_tasks.yoop),
`task sum_two(a: int32, b: int32)` in the same file, `task reader(rfd:
c_int)` in [concurrent_pipe.yoop](../examples/pass/concurrent_pipe.yoop),
and `task canceller(target: Task<int32>)` in
[cancel_smoke.yoop](../examples/pass/cancel_smoke.yoop). The chat agent
could have done `task chat_server(port: int32, turns: int32): int32` from
the start; the module-const workaround was unnecessary.**

#### Symptom

The server runs in `task chat_server(): int32 { ... }`, which takes no
parameters. The number of requests to serve (so the task can finish and
`wait` can return) and the port both had to be hoisted into module-level
`const`s (`TURNS`, `PORT`) shared by the client and server halves. That
works *only* because both halves live in the same module. A server task
that wanted its config passed in - port, request cap, the handler itself
built by the caller - has nowhere to put it.

[std/http/server.yoop:5-8](../std/http/server.yoop#L5-L8) already flags
the related limitation ("becomes straightforward once `task` accepts
`ref` parameters more broadly") for the spawn-per-connection case; this
is the same root cause seen from the application side.

#### Cause

`task` declarations do not accept parameters (all current examples -
hello_server, http_client_loopback - are zero-arg tasks).

#### Fix

Allow `task` to take by-value parameters at minimum (`task
chat_server(port: int32, max_requests: int32): int32`), spawned as
`joined sh = chat_server(18085, 5);`. `ref` parameters are the harder,
already-noted follow-up; by-value config (ints, small structs) would
cover most server-setup needs and remove the module-const coupling.

#### Acceptance

- `task f(x: int32): int32 { ... }` spawned with an argument works and
  the argument is observable inside the task.
- The chat agent can pass `PORT` / `TURNS` into `chat_server` instead of
  reading module consts.

---

## Status summary

- **Issue 1**: landed (clearance kinds v0; see
  [clearance-kinds.md](clearance-kinds.md)).
- **Issue 2**: retracted - not a bug; strings are stable.
- **Issue 3**: landed (`contains` is contextual).
- **Issue 4**: retracted - tasks already accept by-value parameters.

Three of the four turned out to be working-as-intended; the original
analysis was too pessimistic about what the language already does. The
single substantive issue (clearance kinds) drove the bigger kind-system
discussion and landed v0.

## Suggested order (now historical)

ROI per implementation hour, not pure severity.

1. **Issue 3 (contextual `contains`)** - smallest change, immediate
   day-one friction for anyone writing a collection-ish helper. A
   lexer/parser tweak plus a test.
2. **Issue 2 (owned header values)** - turns a silent use-after-free
   into correct behaviour; localized to std/http/types.yoop. High safety
   ROI.
3. **Issue 4 (task value params)** - modest codegen/parser work,
   unblocks realistic server shapes and pairs with the existing
   spawn-per-connection follow-up.
4. **Issue 1 (taint / clearance kind rule)** - the biggest and most
   valuable, but also the most design-heavy: a new clause pair, a sink
   marker, and obligation-tracker work. Worth scoping as its own
   sub-phase because it unlocks the entire "must have been X'd" kind
   family kinds-design.md already wants.

## What this does NOT cover

- The toy bot's substring matching is intentionally dumb (e.g. "this"
  contains "hi", so an unlucky message hits the greeting branch). That
  is example logic, not a language issue.
- Building a URL string from the integer `PORT` at runtime is awkward
  (no clean int-to-owned-string), so the client URL bakes the port in as
  a literal. Minor, and tangled with the general string-ownership story
  rather than specific to this example.
- General `vec_as_array` / view-lifetime dangling is already noted in
  yoopbinder-papercuts.md's closing section; Issue 2 is the specific
  header-value instance of it that bites HTTP handlers.
