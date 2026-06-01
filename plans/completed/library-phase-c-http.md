// Library Phase C - HTTP types, wire parser

> Third slice of the library-design rollout
> ([library-design.md §7](library-design.md#7-http-layer)). Pure yoop on
> top of `std/core/bytes` + `std/net/tcp` - no FFI. Lands the wire-level
> request/response shape and a single-pass HTTP/1.1 parser sufficient
> for a hello-world server. Library Phase D layers the server on top.

## 1. Scope

Six new `std/http/*` modules:

```
std/http/
    method.yoop     # HttpMethod enum + parsing
    status.yoop     # StatusCode + ok() / not_found() / etc. constructors
    headers.yoop    # Headers = Vec<HeaderEntry>, case-insensitive lookup
    request.yoop    # Request struct
    response.yoop   # Response struct + serialization to bytes
    parser.yoop     # internal HTTP/1.1 wire parser
```

`parser.yoop` is **internal** - used by Library Phase D, not exported as
a user-facing API. Listed here so it lives next to its consumers in
`std/http`.

## 2. Design decisions

### 2.1 `HttpMethod` as an enum, not a string

Phase 7.5's enums are exactly the right shape: closed set, exhaustive
switch, no string-compare on every dispatch.

```yoop
export enum HttpMethod {
    Get,
    Post,
    Put,
    Delete,
    Head,
    Patch,
    Options,
    // Unknown is intentionally absent - `parse_method` returns a
    // fallible struct instead of a Unknown variant so callers
    // distinguish parse-failure from "we got a method but it's odd."
}

export type ParsedMethod { method: HttpMethod, err: string }
export function parse_method(buf: uint8[]): ParsedMethod { ... }
export function method_bytes(m: HttpMethod): uint8[] { ... }  // canonical wire form
```

### 2.2 `StatusCode` carries its `class` for cheap classification

```yoop
export enum StatusClass {
    Informational,
    Success,
    Redirect,
    ClientError,
    ServerError,
    Unknown,
}

export type StatusCode { code: int32, class: StatusClass }

export function status(code: int32): StatusCode { /* derives class */ }
export function ok():        StatusCode { return status(200); }
export function not_found(): StatusCode { return status(404); }
export function server_err():StatusCode { return status(500); }
// ... a handful of common ones
```

Reason-phrase ("OK", "Not Found") is a separate lookup table; the
serializer fetches it when formatting the status line.

### 2.3 `Headers` is a `Vec<HeaderEntry>`, not a `Map`

[library-design.md §7.1](library-design.md#71-wire-types-enums--structs)
calls this out: typical HTTP requests have < 30 headers, linear scan is
fine, and a real `Map<string, string>` waits for `std/collections`. The
type:

```yoop
export type HeaderEntry { name: string, value: string }

export type Headers implements Disposable propagates<disposable> {
    entries: Vec<HeaderEntry>,
    function dispose(ref self): void { Disposable.dispose(ref self.entries); }
}

export function headers_new(cap: usize): Headers propagates<disposable> { ... }
export function headers_add(ref h: Headers, name: string, value: string): void { ... }
export function headers_get(ref h: Headers, name: string): string { ... }  // "" if absent; case-insensitive
export function headers_has(ref h: Headers, name: string): bool { ... }
```

`Headers` propagates `disposable` because the underlying `Vec` does. Per
the library design, that's the de facto rule.

### 2.4 `Request` / `Response` body as `uint8[]`, not a stream

The library design ([§8 question 2](library-design.md#8-open-language-questions-the-library-exposes))
calls out streaming bodies as deferred until vtables / trait objects
land. MVP: `body: uint8[]` materializes the whole body in memory. For a
hello-world server this is fine (request bodies are typically < 1KB if
they exist at all).

```yoop
export type Request implements Disposable propagates<disposable> {
    method:  HttpMethod,
    path:    string,        // request-target only (server-side); full URL is parsed by client
    version: string,        // "HTTP/1.1" usually
    headers: Headers,
    body:    uint8[],
    function dispose(ref self): void { Disposable.dispose(ref self.headers); }
}

export type Response implements Disposable propagates<disposable> {
    status:  StatusCode,
    headers: Headers,
    body:    uint8[],
    function dispose(ref self): void { Disposable.dispose(ref self.headers); }
}
```

`body` is not auto-disposed - it's a borrowing view in the request case
(slice into the read buffer) and a caller-owned `uint8[]` in the response
case. Documenting this is more honest than papering over with another
kind.

### 2.5 Response serialization: build into a `Vec<uint8>`, hand off as `uint8[]`

```yoop
export function response_to_bytes(ref r: Response, ref out: Vec<uint8>): void { ... }
```

`out` is a caller-supplied buffer; the function pushes bytes into it.
Caller owns disposal of `out` (matches the Vec pattern). No allocation
inside `response_to_bytes` other than what `vec_push` does internally.

## 3. The parser

`std/http/parser.yoop` is a state-machine parser consuming a `uint8[]`
buffer that contains a full request (or response) head + the start of
the body. It does **not** do any I/O - the caller (Phase D's server)
reads bytes off a `TcpStream` and hands the accumulated buffer to the
parser when it sees `\r\n\r\n`.

```yoop
export type ParsedRequest {
    request:       Request,
    body_start:    usize,    // offset into the source buffer where body bytes begin
    content_length: usize,   // 0 if no Content-Length / unknown
    err:           string,
}

export function parse_request_head(buf: uint8[]): ParsedRequest propagates<disposable> { ... }
```

Algorithm:

1. Find `\r\n` -> request line; split on spaces -> method, path, version.
2. Loop until empty line: each line is `name: value`; lower-case the name
   in place during compare; trim leading whitespace on value.
3. Look for `Content-Length` header; parse as decimal int via
   `bytes_parse_int`.
4. Return `body_start` = offset of byte after the `\r\n\r\n`.

Chunked transfer-encoding is rejected with a clear error. HTTP/1.0 is
accepted (we just don't enforce keep-alive).

The parser does **not** materialize header values into fresh strings
unless necessary - every `headers_add` call passes
`string_from_bytes_unchecked` on a borrowing slice into `buf`, so the
parsed request's headers live as long as `buf` does. This means
`Request` is *not* safe to outlive the read buffer it was parsed from -
callers either consume + respond synchronously or `bytes_copy` the
needed strings. **Documented at the function signature.**

A symmetric `parse_response_head(buf)` exists for client-side use; share
the line-walking machinery via a single helper that takes a "is this a
status line or request line" enum.

## 4. Files touched

- **New**: six `std/http/*.yoop` files listed in §1.
- **New unit fixture**: `examples/pass/http_parse_smoke/main.yoop` -
  feeds a hard-coded HTTP/1.1 request buffer to `parse_request_head`,
  prints method, path, content_length, two header values. Confirms the
  parser end-to-end without any sockets.
- **No language changes.**

## 5. Verification

The smoke fixture above is the headline test. Bad-path tests in
`examples/fail/`:

- `http_no_crlf_crlf` - buffer without `\r\n\r\n` ends in a clean error,
  not a panic.
- `http_chunked_rejected` - request with `Transfer-Encoding: chunked`
  rejected with a specific error message.
- `http_bad_method` - request line "FOO / HTTP/1.1\r\n" parses with
  `method.err` set.

## 6. Dependencies

Library Phase B for `Readable` / `Writable` aren't strictly needed at
parser layer (the parser takes a byte buffer, not a `Readable`), but
Library Phase D's server takes a `TcpStream` and feeds the buffer in.
Phase 8.H string + bytes + Vec primitives are heavily used. No new
language work needed.
