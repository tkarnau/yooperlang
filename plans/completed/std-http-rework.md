# std/http rework - as-built notes

The `std/http` layer was written across library phases C and D, before several
language features landed. This pass rewrote it against the language as it is
now, and in doing so turned up four compiler bugs and two ergonomic gaps.

Breaking change: the whole `std/http` surface is camelCase now
(`headers_add` -> `headersAdd`, `respond_static` -> `respondText`), per the
naming convention in CLAUDE.md. Every in-tree consumer was updated.

## What changed, and why

### One error type, `Result`-shaped everywhere

The old modules used the retired struct-with-`error`-field convention
(`ServeOutcome`, `ClientSendResult`, `ParsedRequest.error`) and returned an
empty shell plus a message on failure. The comments explaining that shape all
cited the old obligation tracker, which no longer enforces anything after the
ownership redesign - so returning `Result<T, E>` with a propagating payload
works now and the workaround was dead weight.

Everything is `Result<T, HttpError>`. `HttpError` carries the status the
client should see, because the code that detects a failure is the code that
knows whether it is a 400 or a 500. It implements:

- `Display`, so `${e}` renders it,
- `WithContext<HttpError>`, so `expr? "reading the body"` stacks context
  without flattening the status away (a plain-string payload would).

### The serve loop is not generic

`serve_n<H implements Handler>` became `serve(ref l, ref d: Dispatcher, cfg, n)`
over the Phase 9.G vtable. One copy of the loop in the binary regardless of how
many handler types a program has, and - the reason it mattered - the
per-connection work could finally be split into named functions. The old
comment in `serve_n` explained that everything was inlined into one function
because a generic calling a generic across module boundaries did not emit the
second instantiation; a non-generic loop simply does not have that problem.

There is no generic convenience wrapper: `Dispatcher.from(ref h)` requires a
concrete struct receiver and rejects a type parameter, so the erasure has to
happen at a call site that knows the handler's real type. That is one line in
`main`.

### A bad client no longer kills the server

Previously any parse failure returned from `serve_n` and ended the process. Now
a malformed request gets the status its error carries (400 / 413 / 431 / 501 /
505), the connection is dropped, and the accept loop continues. Only a listener
failure ends `serve`.

### Keep-alive, HEAD, and framing

- HTTP/1.1 connections are reused, capped by `maxRequestsPerConnection`;
  `Connection: close` and HTTP/1.0 end the connection.
- `Content-Length`, `Connection` and `Transfer-Encoding` are written by the
  server and skipped from the handler's header list, so a handler cannot
  desynchronize framing.
- A HEAD reply carries the headers the GET would have, body suppressed.
- Header values containing CR or LF are refused on the way out (response
  splitting) - and the whole response is replaced with a 500 rather than
  quietly truncated, because a handler that produced one is broken.
- `Transfer-Encoding: chunked` is an explicit 501 instead of being read as a
  body with chunk headers embedded in it.

### New modules

- `std/http/wire.yoop` - message building (`pushStr`, `pushHeaderLine`) and the
  shared header-field reader. The server and the client had near-identical
  copies of both; the near-duplicate-pair hazard that CLAUDE.md documents for
  the two printf emitters was live here too.
- `std/http/url.yoop` - request-target splitting, percent coding, and
  urlencoded name/value parsing (query strings and form bodies are the same
  grammar). `decodePath` rejects an encoded separator (`%2F`, `%5C`) rather
  than decoding it, which keeps one decoded `path` field safe for routing.

### Router

Path patterns now capture: `/todos/:id` binds `req.params`, `/static/*` binds
`rest`. A path that matches with the wrong method is a 405 with an `Allow`
header rather than a 404. A HEAD with no HEAD route falls through to the GET
route. The installed fallback renders both the 404 and the 405 (status and
`Allow` pre-set), so a JSON API does not emit two lone plain-text bodies.

### Language features now used

Char literals (`'\r'`, `':'`, `'%'`) instead of decimal byte tables; `for x in
xs` and `for (let i = 0; i < n; i += 1)`; `a..b` ranges; `?` with context
strings; `Option<T>` returns instead of `""` sentinels; template literals in
place of the hand-rolled `push_decimal` that both the server and the client
carried.

## Compiler bugs this turned up

All four were pre-existing and are fixed in this pass.

1. **`sizeOfType` under-counted a variant.** It returned `4 + maxPayload`,
   missing both the one-byte floor a payload-free variant occupies in the
   emitted `{ i32, [N x i8] }` and the trailing pad. A variant nested inside
   another variant's payload therefore got a payload buffer too small for it,
   and storing the value wrote past the end. Reproducer: a struct with a
   variant field, used as the `Err` payload of a `Result` - reading the field
   after the variant returned garbage or segfaulted.

2. **`sizeOfType` had no case for vtables at all**, so a `Dispatcher` (two
   pointers) was reported as eight bytes. `Vec<Route>` allocated half the bytes
   it then wrote and overran its buffer once enough routes were pushed to get
   past the slack. This one had been latent in the router since Phase 10.I -
   the old example only registered two routes.

3. **A module-level `const` string did not decode escapes.** The comptime layer
   stores a string literal's raw inner source text, but the global-initializer
   path re-escaped it as if it were an already-decoded JS string, doubling
   every backslash. `const S: string = "a\r\nb";` reached the binary as seven
   characters. Locals were unaffected, which is why it went unnoticed.

4. **A `switch` payload binding could carry an unpopulated struct shell.** A
   `case Result.Ok { value: x }` whose payload type came from another module
   mid-pass bound `x` to a shell with an empty `implementsTraits`, so
   `Disposable.dispose(ref x)` failed on a type that plainly implements it. The
   fix is the `canonicalizeStruct` call that inferred `let` bindings already
   do.

## Pre-existing library bug

**The last header field was dropped.** `findHeadEnd` returns the offset of the
CR that terminates the *last header line*, so a scan bounded by it sees that
line without a CRLF and stopped early. Every parse quietly lost the final
header. It never showed up because the one fixture that could have caught it
expected the default value of the field it lost. The shared reader now scans to
`headEnd + 2`.

## Ergonomic gaps found, not fixed

- **Call-site inference cannot see through a generic enum's type arguments.**
  `function bridge<T>(r: Result<T, string>): Result<T, MyError>` cannot infer
  `T` from a `Result<int32, string>` argument, and there is no turbofish, so a
  bridging helper has to be written once per payload type. `todo_api/store.yoop`
  has four near-identical ones.
- **A same-module struct field typed as a vtable resolves against the vtable's
  pre-pass shell** and loses its method slots ("vtable X has no slot for trait
  method Y"). It works across modules, which is why `Dispatcher` lives in
  `server.yoop` and `Route` in `router.yoop`. Function parameters and local
  bindings of the same type are fine - it is specific to struct fields.

## std/db/sqlite additions

- **`transaction` kind** (`appliesTo binding`, `requires Disposable`,
  `mustCall dispose beforeScopeEnd`), plus `Tx`, `begin`, `beginImmediate`,
  `commit`, `rollback`. The disposer rolls back unless a commit closed it, so
  every path out of the scope is covered - including an `expr?` in the middle
  of a loop. This is the kind the sqlite papercuts doc asked for, as a binding
  kind rather than the region kind it predicted: a region has no name, and with
  no name there is nothing to call `commit` on.
- **`DbRef` / `dbRef` / `borrow`** - an explicit non-owning handle. A struct
  holding a `Db` has to propagate the disposable obligation, which is right for
  an owner and wrong for the common server shape where `main` owns one
  connection and every handler uses it.

## The example

`examples/playground/todo_api/` is a CRUD JSON API over sqlite: routing with
captures, form-encoded input, JSON output, a bulk import that is all-or-nothing
via the `transaction` kind, and `StoreError implements Into<HttpError>` so a
missing row becomes a 404 with no status decision in any handler. `smoke.sh`
exercises every route including the failure paths.
