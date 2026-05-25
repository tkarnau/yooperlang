# Phase 10.I - Networking polish

> The "library Phase E" from [library-design.md §10](../library-design.md#10-what-lands-first):
> routing, streaming-body groundwork, a client, and URL parsing. The HTTP
> client and server libraries had clean MVPs from Library Phases B/C/D
> but lacked the composition shapes real programs reach for. 10.I closes
> those gaps.

## What landed

### `vtable Reader for Readable` + `vtable Writer for Writable`

Two new exports in [std/core/traits.yoop](../../std/core/traits.yoop)
backed by the Phase 9.G vtable machinery. `Reader.from(ref s)` builds a
type-erased view of any `Readable` impl - the natural shape for any
function that wants "any byte source" without monomorphizing per
concrete stream type. Symmetric `Writer` does the same for `Writable`.

The vtables intentionally do NOT carry Disposable - the caller still
owns the underlying stream and disposes it. The vtable is a view, not
a transfer.

Smoke: [examples/pass/reader_vtable_smoke/main.yoop](../../examples/pass/reader_vtable_smoke/main.yoop).

### `std/net/uri.yoop` - URL parser

`parse_uri(url)` returns a `Uri { scheme, host, port, target }` for
absolute `scheme://host[:port][/path[?query]]` URLs. The IPv6
bracketed-host form (`http://[::1]:18080/`) parses; `tcp_connect`
remains IPv4-only (it goes through `inet_addr`), so the parser is
already ahead of the wire layer.

Default ports for `http` (80) and `https` (443) are inferred when the
authority omits one. Userinfo (`user:pass@host`), fragments (`#frag`),
and percent-decoding are explicit non-goals - the caller handles them.

Smoke: [examples/pass/uri_parse_smoke/main.yoop](../../examples/pass/uri_parse_smoke/main.yoop).

### `std/http/router.yoop` - Router + Dispatcher

`Router` is a small route table over `Vec<Route>` where each `Route`
holds a method, a path string, and a `Dispatcher` (the Phase 9.G
vtable for `Handler`). The router itself implements `Handler`, so it
drops directly into `serve_n(ref l, ref router, n)` - no new server
surface.

The `Dispatcher` vtable lives in [std/http/server.yoop](../../std/http/server.yoop)
alongside the `Handler` trait that backs it (validation requires both
to be populated in the same pass, which is simplest when they share a
module). `Router.handle` walks routes in registration order; the first
exact `(method, path)` match wins. A path-match-but-method-mismatch
emits 405; an unmatched path goes to the registered fallback or 404.

Demo: [examples/pass/http_router/main.yoop](../../examples/pass/http_router/main.yoop)
- one router, three concrete handler types, dispatched via a
heterogeneous `Dispatcher[]` slot inside `Router`.

### `std/http/client.yoop` - Minimal HTTP client

`make_client()` builds a `Client` (currently a placeholder for future
per-client state like a connection pool). `client_send(ref c, ref req)`
opens a TCP connection, writes the serialized request, reads the
response head + body, and returns `ClientSendResult { response, error }`.
`http_get(ref c, url)` is the GET-shaped convenience wrapper.

Wire format follows HTTP/1.1 with `Connection: close`. Body sizing
uses `Content-Length` when present, otherwise reads until EOF. Chunked
transfer encoding, TLS, redirects, keep-alive, and connection pooling
are all deferred.

The response head parsing lives in client.yoop's `parse_response_head`
- structurally identical to `std/http/parser.yoop`'s
`parse_request_head` but for status lines instead of request lines.
Consolidating the two into one parser body is a future cleanup; the
status-vs-request-line split is small enough today that duplication
is cheaper than the right abstraction.

End-to-end demo: [examples/pass/http_client_loopback/main.yoop](../../examples/pass/http_client_loopback/main.yoop)
- spawns a `task` running `serve_n(..., n=1)` in-process, then issues
a `client_send` from the main thread and prints the response body.
The e2e test in [src/e2e.test.js](../../src/e2e.test.js) asserts the
round-trip.

### `Option<usize>` Content-Length

`std/http/parser.yoop`'s `ParsedRequest.content_length` switched from
`usize` (where `0` ambiguously meant both "absent" and "explicit zero")
to `Option<usize>`. Server + smoke fixture updated. A
`parsed_content_length(ref pr)` helper preserves the "treat None as
0" behavior the current server loop assumes.

### Parser bug fix: `if/else { ... } if (...)`

While building the URI parser, surfaced a long-standing parser bug:
`parseIfStatement` would consume an `else` block and then *also* try to
consume a following `if` statement as `else if`, **overwriting** the
already-set `elseBody`. The shape `if (a) { ... } else { ... } if (b) {
... }` (two adjacent if-statements) silently dropped the `else` block
and parsed the second `if` as `else if (b)`.

Fix: discriminate `else if` (chains into `elseBody`) from `else { ... }`
(consumes a single block, returns). Previously both paths could fire on
the same `else`, the second clobbering the first. See
[src/jsyooparser/parser.js:parseIfStatement](../../src/jsyooparser/parser.js).

### `ref` in function-pointer-type params

`parseFunctionTypeAnnotation` now accepts an optional `ref` prefix on
each param (`(ref buf: uint8[]) => Result<...>`). Without this the
`Reader` and `Writer` vtables couldn't mirror the `ref buf` shape of
the underlying trait methods - validation failed with "expected ident,
got ref" at the vtable decl site.

### Vtable cross-module imports

`std/jsyooptypecheck/imports.js` now recognizes `vtableTable`-resident
exports as "type" kind imports. Without this fix, naming a vtable in
the import list (`import { Reader, ... }`) silently dropped the vtable
binding - the typechecker fell through to a "not found" message at
use sites instead of importing the populated `VTableType`.

### `http_method_eq` + `http_method_label`

Yoop enums don't yet support `==`. The router needed method equality
for dispatch, and the client needed the canonical uppercase byte form
for the request line. Two small helpers in
[std/http/types.yoop](../../std/http/types.yoop) close those gaps.

## Files touched

- New: `std/net/uri.yoop`, `std/http/router.yoop`, `std/http/client.yoop`.
- New: `examples/pass/reader_vtable_smoke/`, `examples/pass/uri_parse_smoke/`,
  `examples/pass/http_router/`, `examples/pass/http_client_loopback/`.
- Modified: `std/core/traits.yoop` (Reader/Writer vtables), `std/http/types.yoop`
  (method equality + label helpers), `std/http/parser.yoop` (Option<usize>
  Content-Length), `std/http/server.yoop` (Dispatcher vtable + parsed_content_length use).
- Modified: `examples/pass/http_parse_smoke/main.yoop` (Option<usize> usage).
- Modified: `src/jsyooparser/parser.js` (else-block parser bug fix + ref
  in FPT params).
- Modified: `src/jsyooptypecheck/imports.js` (vtable cross-module import).
- Modified: `src/e2e.test.js` (four new test cases).

## Deferred

Per the original plan, several items in the 10.I scope remain open:

- **Streaming bodies inside `Request.body`.** The `Reader` vtable is in
  but the request shape still uses `body: uint8[]` (fully materialized).
  Switching it to `Reader` + retiring the buffered read in `serve_n` is
  the next move - it doesn't need any new language work, but it does
  need careful disposal semantics (the request must outlive the
  underlying stream).
- **Connection pooling + keep-alive + pipelining.** Wait on per-host
  pool keyed by `(scheme, host, port)`. `Deque<TcpStream>` from
  std/collections/ is the right backing structure.
- **TLS.** Pick an OpenSSL or BoringSSL binding; expose `TlsStream
  implements (Readable, Writable, Disposable)`. No real consumer yet,
  so this stays gated.
- **HTTP/2, HTTP/3, QUIC.** Phase 11+.
- **IPv6 connect path.** The parser handles bracketed authority;
  `tcp_connect` is still `inet_addr`-only. Lifting needs a
  `sockaddr_in6` mirror + a small AF_INET6 branch in
  `std/net/socket_ffi.yoop`.
- **Trie-style path matching in `Router`.** Exact-string match was
  enough for the demo. Parametric routes (`/user/:id`) require some
  parser work and probably a `RouteMatch { path_params: Map<string,
  string> }` extension to the handler signature.
- **`http_post` + body-typed convenience wrappers.** `client_send` is
  generic over method; the GET wrapper exists, POST is a one-line
  addition once a consumer needs it.

## Verification

- 609 / 609 tests pass (`npm test`).
- New fixtures: `reader_vtable_smoke`, `uri_parse_smoke`, `http_router`,
  `http_client_loopback`. Each has an e2e assertion in
  [src/e2e.test.js](../../src/e2e.test.js).
- Manual: `curl http://localhost:18081/hello` against
  `/tmp/http_router` returns "Hello via router!"; `/healthz` returns
  "ok"; any other path returns "fallback".
- The loopback test starts a one-shot server task and issues a client
  GET against it in the same process - exercises every wire-format
  path in the new modules.
