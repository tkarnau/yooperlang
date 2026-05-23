# Library design — patterns and the networking story

> Design contract for "batteries-included" Yooperlang libraries. Parallel
> to [runtime-design.md](runtime-design.md), but for the *library* layer
> that sits on top of the runtime: foundational traits and kinds, then
> the network + HTTP modules built on them.

## 1. Purpose and scope

Phase 8.A–F gave yoop the language and runtime primitives to talk to libc
(pointers, C aliases, errno, multiplexer). This document describes the
**library layer** that turns those primitives into something a user
actually wants to call — a `TcpListener`, an `HttpRequest`, a `Client`.

The goal is one consistent set of conventions so every standard module
looks like every other. Three concrete deliverables:

1. **Library principles** — the rules every `std/*` module follows.
2. **Staple traits and kinds** — the small foundational set that
   downstream modules build *on top of*. Currently: `Disposable`
   (existing), `Readable`, `Writable`, `Display`. Kinds: `disposable`
   (existing). New: none required at the foundational layer — the
   existing kind machinery is enough.
3. **The networking + HTTP layer** designed to fit those rules:
   `std/net/socket`, `std/net/tcp`, `std/http/request`,
   `std/http/response`, `std/http/client`, `std/http/server`.

In scope:

- Module organization and import paths.
- The pure-yoop / unsafe-yoop boundary in library code.
- Resource ownership and cleanup via existing Phase 6 kinds.
- Trait shapes for the staple set (signatures + the rules they imply).
- Networking primitives all the way up to `Listener.accept()`.
- HTTP primitives sufficient for a usable client + a hello-world server.

Out of scope (real follow-ups):

- TLS. Out of scope until the plain-HTTP story is shipped.
- HTTP/2 + HTTP/3. The library design accommodates a future binary
  framing layer but the MVP is HTTP/1.1 only.
- A full collections library (`Map`, `Set`, growable `Vec`). Required
  for some HTTP features (headers in particular) — see §8.
- A logging framework (the "Debugging/Console" category the user
  mentioned). Covered briefly in §9, but its design is a separate doc.

## 2. Library principles

### 2.1 Pure-yoop public API; unsafe-yoop guts allowed

A library module's **public** surface — the names other yoop programs
import — must compile without `import.unsafe;`. Implementation modules
that use `unsafe_ptr<T>`, libc externs, or `xs.ptr` are fine *as long as*
they don't surface pointer types in their exported signatures.

Concretely:

```yoop
// std/net/socket_ffi.yoop  — unsafe, not directly imported by users
import.unsafe;

extern "C" from "sys/socket.h" {
    function socket(domain: c_int, type: c_int, proto: c_int): c_int;
    // ...
}

export function ll_socket(domain: c_int, type: c_int, proto: c_int): c_int {
    return socket(domain, type, proto);
}

// std/net/socket.yoop  — safe, this is what users import
import { ll_socket } from "./socket_ffi.yoop";

type Socket implements Disposable propagates<disposable> {
    fd: c_int,
    closed: bool,
    function dispose(ref self): void { /* close(fd) */ }
}

export type SocketResult { socket: Socket, err: string }

export function open_socket(...): SocketResult { ... }
```

The split is a strong convention, not a typecheck rule. The split makes
it easy for users to grep their dependencies — "do I depend on any
`*_ffi.yoop`?" answers "am I building on unsafe code?".

### 2.2 Failable returns use the `err: string` convention + `?`

Every library function that can fail returns a fallible struct (a struct
ending in `err: string`). The caller propagates with `?` or destructures
explicitly. The pattern is the same as Phase 8.D's `open_safe`:

```yoop
type ConnectResult { conn: TcpStream, err: string }

export function connect(addr: string, port: int32): ConnectResult { ... }

// caller:
function fetch(url: string): FetchResult {
    let c: TcpStream = connect("1.1.1.1", 80)?;   // err propagates
    // ...
}
```

Library code does **not** use enums for errors (no `Result<T, E>`-style
ADTs). The struct convention is what `?` understands today; introducing
a parallel enum-based mechanism would split the ecosystem. If `?` ever
grows to understand enums (a follow-up to Phase 7.5), libraries will
inherit it automatically.

Error messages in `err` are user-facing strings. The standard format is
`"<operation>: <reason>"`. For libc failures, use
`errno.message(errno.get())` directly:

```yoop
return { conn: empty, err: `connect: ${errno.message(errno.get())}` };
```

### 2.3 Resources are `Disposable + propagates<disposable>`

Anything holding an fd, malloc'd buffer, mutex, or task handle declares
the existing Phase 6.4 pattern:

```yoop
type Socket implements Disposable propagates<disposable> {
    fd: c_int,
    function dispose(ref self): void {
        let rc: c_int = close(self.fd);
    }
}
```

The user picks one of the three legal exits (Phase 6.4 spec §):

- **`disposable s: Socket = open_socket(...)?;`** — auto-cleanup at
  scope end.
- **Manual `Disposable.dispose(ref s);`** before scope end.
- **`return s`** out of an enclosing function that itself
  `propagates<disposable>`.

The compiler enforces one of these is chosen; libraries don't need to
write any cleanup checks. **Every library type that owns a resource
should propagate `disposable`.** It's the de facto rule.

### 2.4 Async by default: tasks return `Task<T>`

Anything that may block goes behind `task`:

```yoop
task accept_loop(ref l: Listener): int32 { ... }

// caller:
joined h = accept_loop(ref listener);
let rc: int32 = wait h;
```

For library functions that *might* block (e.g. `read_all`), the choice
is:

- If it almost always blocks (server-side `accept`), declare it `task`.
- If it usually returns immediately (read with hint), provide both a
  sync and a `task`-suffixed variant: `read_some(...)` + `read_some_task(...)`.

The convention is that **anything calling `yoop_io_wait_*` or
`yoop_sleep_*` should be a `task`** so the caller can choose to await it
non-blockingly via `wait`.

### 2.5 Module-level state for true singletons only

Phase 8.E gave us module-level `let`. Use sparingly. Reserve for:

- One-time-initialized constants (`const DEFAULT_PORT: int32 = 80;`).
- Process-singletons that genuinely have one instance (a global cache,
  an `epoll_fd`-equivalent the user can reach into for diagnostics).

**Do not** stash per-call state, per-connection state, or anything a
test might want to vary. Pass it explicitly via parameters. Globals
make testing painful and yoop has no DI machinery.

### 2.6 No method chaining; trait-qualified calls instead

Yoop's call form is `Trait.method(ref x, ...)` (Phase 7.4). Builders
that look like `req.method("GET").header(...).build()` in other
languages are **out of scope**. The yoop idiom is struct literals + a
small number of helper functions:

```yoop
let req: Request = {
    method: "GET",
    url: "http://example.com/",
    headers: [],
    body: empty_bytes(),
};
let resp: Response = Client.send(ref client, req)?;
```

Or, for shapes that need computation, a `make_*` free function:

```yoop
let req: Request = make_get_request("http://example.com/");
```

This is consistent with the rest of yoop and means no new builder
infrastructure is needed.

## 3. Staple traits

These are the foundational traits standard library types implement. Keep
the set small — every additional trait is a thing every library author
needs to know.

### 3.1 `Disposable` (existing — Phase 6.1)

```yoop
trait Disposable {
    function dispose(ref self): void;
}
```

The one trait every resource type implements. Paired with the
`disposable` kind that requires it. Used everywhere from sockets to
tasks to file handles. **Already in use; documented here for completeness.**

### 3.2 `Readable` — byte-stream input source (new)

```yoop
trait Readable {
    // Read into the front of `buf`, up to buf.len bytes. Returns the
    // number of bytes actually read (0 = EOF, negative = err with the
    // returned ReadOutcome's err field set).
    function read(ref self, ref buf: uint8[]): ReadOutcome;
}

type ReadOutcome { n: c_ssize_t, err: string }
```

Every byte source (TcpStream, file, in-memory buffer for testing)
implements `Readable`. The HTTP parser and any framing layer takes
`Readable` as input, so testing with a fake source is a one-struct
implementation.

The return shape is a fallible struct so `?` works:

```yoop
function read_line(ref r: ref Readable, ref buf: uint8[]): ReadResult {
    let outcome: c_ssize_t = Readable.read(ref r, ref buf)?;
    // ...
}
```

(Note: the parameter form `ref Readable` here is sketchy — yoop's
generics don't quite express "anything implementing Readable" as a
function parameter yet. See §8 "Open questions."  In the meantime,
library code can take a concrete struct that implements Readable and
hand-write a small abstraction layer if needed.)

### 3.3 `Writable` — byte-stream output sink (new)

```yoop
trait Writable {
    function write(ref self, ref buf: uint8[]): WriteOutcome;
    function flush(ref self): FlushOutcome;
}

type WriteOutcome { n: c_ssize_t, err: string }
type FlushOutcome { err: string }
```

Symmetric to `Readable`. `flush` is its own method because a buffering
writer needs it; for an unbuffered TcpStream it's a no-op.

### 3.4 `Display` — to-string conversion (new)

```yoop
trait Display {
    function to_string(ref self): string;
}
```

Used by template literals (eventually) and by any "format this for
humans" path. Currently template literals special-case `int`/`float`/
`bool`/`string` — generalizing to `Display`-implementing types is a
follow-up.

Library types that have a sensible string form (`SocketAddr`,
`StatusCode`, `HttpMethod`) implement `Display`. Types that don't
(`TcpStream`, `Client`) don't.

### 3.5 Aspirational: `Iterator` (deferred)

```yoop
// Future. yoop has no for-in loop yet.
trait Iterator<T> {
    function next(ref self): IterStep<T>;
}

enum IterStep<T> {
    Yield { value: T },
    Done,
}
```

Listed here so future libraries know where it's going to land. Don't
implement custom iteration today — for the staple library, all "iterate
over a collection" cases use plain `for (i = 0; i < len; ...)` loops.

## 4. Staple kinds

### 4.1 `disposable` (existing — Phase 6.4)

The only foundational kind library types reach for today. Bound to
`Disposable.dispose` via `mustCall`. Every resource-owning struct
declares `propagates<disposable>` so the obligation flows through
binding boundaries.

```yoop
kind disposable {
    appliesTo binding;
    requires Disposable;
    mustCall dispose beforeScopeEnd;
}
```

(Defined once in `std/core/kinds.yoop` and imported by every module
that produces a resource type.)

### 4.2 Future kinds, listed but deferred

- **`pinned`** — value cannot escape its declaring scope. Useful for
  references that the multiplexer thread holds during a wait. Phase 6.2
  has `mustNotEscape` which is the underlying machinery; a `pinned`
  shorthand could be a follow-up.
- **`exclusive`** — value cannot be shared across tasks. Sockets are
  exclusive in practice (only one task should `recv` on a given fd at
  a time). `mustNotShare` from Phase 6.2 is the machinery; a sugary
  `exclusive` kind would express the intent.

For Phase 8.G's library MVP, the existing `disposable` carries the
weight. Adding more kinds is easy when a real type needs them.

## 5. Module layout

Convention: every public-facing module lives at `std/<area>/<name>.yoop`.
Implementation details (FFI shims, helpers not for direct user import)
live at `std/<area>/<name>_internal.yoop` (or `_ffi.yoop` for the
unsafe split).

```
std/
  core/
    kinds.yoop          # disposable, Disposable trait
    traits.yoop         # Readable, Writable, Display
  io/
    bytes.yoop          # uint8[] helpers (alloc/free/copy)
    stream.yoop         # buffered Readable/Writable adapters
  net/
    addr.yoop           # SocketAddr type + Display impl
    socket.yoop         # Socket (raw fd wrapper)
    socket_ffi.yoop     # unsafe — extern declarations
    tcp.yoop            # TcpListener, TcpStream
  http/
    method.yoop         # HttpMethod enum
    status.yoop         # StatusCode + classification
    headers.yoop        # Headers type (Vec<HeaderEntry>)
    request.yoop        # Request type
    response.yoop       # Response type
    parser.yoop         # internal HTTP/1.1 wire parser
    client.yoop         # Client { default headers, etc. }
    server.yoop         # Server { listener, handler trait }
```

Why "std" as the prefix: matches industry convention and the moment a
real package manager arrives, that's the namespace third-party
libraries don't collide with.

For now the path is just `import { ... } from "../std/net/tcp.yoop";`.
Yoop's module-resolver is path-based and doesn't yet have a "std"
search root — adding one is a small follow-up (see §8).

## 6. Networking layer

Bottom-up: address → raw socket → TcpListener / TcpStream → HTTP.

### 6.1 `SocketAddr`

```yoop
type SocketAddr {
    host: string,    // IPv4 dotted-quad or hostname; resolution is lazy
    port: int32,
}

// Display impl:
function addr_to_string(ref a: SocketAddr): string {
    return `${a.host}:${a.port}`;
}
```

IPv4 only in the MVP. IPv6 + URI authority parsing is a follow-up.

### 6.2 `Socket` (raw fd wrapper)

```yoop
type Socket implements Disposable propagates<disposable> {
    fd: c_int,
    function dispose(ref self): void {
        if (self.fd >= 0) {
            let rc: c_int = close(self.fd);
        }
    }
}

export type SocketResult { socket: Socket, err: string }
export function open_tcp_socket(): SocketResult { ... }
```

A raw fd in a `Disposable` envelope. Users don't usually touch this
directly — `TcpListener` / `TcpStream` wrap it. Exposed because the
network library should have an "escape hatch": if the user needs to
call `setsockopt` directly, they can.

### 6.3 `TcpListener`

```yoop
type TcpListener implements Disposable propagates<disposable> {
    socket: Socket,
    addr: SocketAddr,
    function dispose(ref self): void {
        Disposable.dispose(ref self.socket);
    }
}

export type ListenResult { listener: TcpListener, err: string }

export function listen(addr: SocketAddr, backlog: int32): ListenResult { ... }
```

`listen` does the socket() + bind() + listen() sequence; on failure
every intermediate fd is closed and `err` describes which call failed.

```yoop
export type AcceptResult { stream: TcpStream, peer: SocketAddr, err: string }

export task accept(ref l: TcpListener): AcceptResult {
    let rc: c_int = yoop_io_wait_readable(l.socket.fd);
    if (rc != 0) {
        return { stream: empty_stream, peer: zero_addr, err: ... };
    }
    let cfd: c_int = accept(l.socket.fd, ...);
    // ...
}
```

`accept` is `task` because it always blocks until a connection arrives.
The task suspends on `yoop_io_wait_readable` and resumes when the
listening fd is readable — the standard reactor pattern.

### 6.4 `TcpStream`

```yoop
type TcpStream implements Disposable + Readable + Writable propagates<disposable> {
    socket: Socket,
    function dispose(ref self): void {
        Disposable.dispose(ref self.socket);
    }
    function read(ref self, ref buf: uint8[]): ReadOutcome {
        // wait_readable + read(); convert (-1, errno) to err string.
    }
    function write(ref self, ref buf: uint8[]): WriteOutcome { ... }
    function flush(ref self): FlushOutcome { return { err: "" }; }
}

export type ConnectResult { stream: TcpStream, err: string }
export task connect(addr: SocketAddr): ConnectResult { ... }
```

This is the workhorse. Implements three traits (Disposable + Readable +
Writable) because that's exactly how a TCP byte stream behaves. Every
HTTP-layer abstraction takes a `TcpStream` (or any `Readable + Writable`
when the language allows that constraint).

`connect` is `task` for the same reason `accept` is — it may block.

## 7. HTTP layer

### 7.1 Wire types (enums + structs)

```yoop
enum HttpMethod {
    Get,
    Post,
    Put,
    Delete,
    Head,
    Patch,
    Options,
}

enum StatusClass {
    Informational,
    Success,
    Redirect,
    ClientError,
    ServerError,
}

type StatusCode {
    code: int32,
    // Class is derivable from code/100; cached here to make
    // `if (StatusClass.Success matches class) ...` cheap.
    class: StatusClass,
}

type HeaderEntry { name: string, value: string }

type Headers {
    items: HeaderEntry[],
    // No hash table — linear scan over `items` is fine for typical
    // HTTP requests (< 30 headers). A Vec<HeaderEntry> equivalent or
    // a real Map<string, string> can replace this when the language
    // grows them.
}

type Request {
    method: HttpMethod,
    url: string,         // full URL incl. scheme + host for client use;
                         // request-target for server-parsed values
    headers: Headers,
    body: uint8[],
}

type Response {
    status: StatusCode,
    headers: Headers,
    body: uint8[],
}
```

Bodies as `uint8[]`. A streaming-body story (a `Readable` body) is the
obvious next move once the language can express "any Readable" as a
parameter (§8 open question 2).

### 7.2 Client

```yoop
type Client {
    default_headers: Headers,
    // No connection pooling in MVP. A pool is one of the first
    // follow-ups once we have a Map type.
}

export function make_client(): Client { ... }

export type FetchResult { response: Response, err: string }

export task send(ref c: Client, req: Request): FetchResult {
    // 1. Parse URL → SocketAddr + request-target.
    // 2. connect() → TcpStream.
    // 3. Format request + write to stream.
    // 4. Read response.
    // 5. Parse response.
    // 6. Dispose stream.
    // Returns fallible struct; caller `?`s if needed.
}
```

`Client` holds defaults; per-call state lives in `Request` / `Response`.
No mutation of `Client` across calls — it's effectively a struct of
configuration.

### 7.3 Server

```yoop
trait Handler {
    function handle(ref self, req: Request): HandleResult;
}

type HandleResult { response: Response, err: string }

export type Server {
    listener: TcpListener,
    // Handler is stored as a generic param so the user's handler type
    // is monomorphized in. Requires generic trait bounds (Phase 7.2).
}

export task serve<H implements Handler>(server: Server, ref handler: H): int32 {
    while (true) {
        let acc: AcceptResult = wait accept(ref server.listener);
        if (acc.err.len > 0) {
            continue; // or break, depending on error policy
        }
        // Spawn a per-connection task. The handler does the request
        // parse + response write inside its own task body.
        joined h = handle_connection(acc.stream, ref handler);
        let rc: int32 = wait h;
    }
    return 0;
}

task handle_connection<H implements Handler>(stream: TcpStream, ref handler: H): int32 {
    // Parse Request from stream, call handler, write Response.
}
```

The Handler trait is the user's extension point. A minimal server is:

```yoop
type HelloHandler { greeting: string }

type HelloHandler implements Handler {
    function handle(ref self, req: Request): HandleResult {
        return {
            response: {
                status: ok(),
                headers: empty_headers(),
                body: string_to_bytes(self.greeting),
            },
            err: "",
        };
    }
}

function main(): int32 {
    let listener: TcpListener = listen({ host: "0.0.0.0", port: 8080 }, 128)?;
    let handler: HelloHandler = { greeting: "Hello, World\n" };
    let rc: int32 = wait serve(listener, ref handler);
    return rc;
}
```

### 7.4 Wire parsing

[http/parser.yoop](http/parser.yoop) (internal) is the HTTP/1.1 parser.
A first-cut implementation:

- Read until `\r\n` for the request line.
- Read each header line until empty line.
- Read body per Content-Length (chunked-encoding is a follow-up).

State-machine driven, takes a `Readable` (once the language can
express that constraint cleanly). Designed so the same parser works
client-side (parsing responses) and server-side (parsing requests) —
the request-line vs status-line difference is one branch at the top.

The parser is **not** part of the public surface. Users get a parsed
Request / Response; how it got parsed is a detail.

### 7.5 Routing (minimal)

```yoop
type Route {
    method: HttpMethod,
    path: string,
}

type RouterHandler {
    routes: RouteEntry[],
    fallback: ??? ,
}
```

Deferred to a follow-up. The MVP server takes one Handler; routing is
something the user composes manually until we have first-class
function values or trait-object dispatch (§8 open question 3).

## 8. Open language questions the library exposes

Writing this design surfaces a few gaps the library needs to either
work around or wait on:

1. **Trait-object parameters.** `function read(ref r: ref Readable)` —
   "any Readable" as a parameter type. Yoop generics today require an
   explicit `<R implements Readable>` and *monomorphize*. That's fine
   for performance but means every HTTP parser instantiation is a
   separate function. A real `dyn Trait` (vtable-dispatched) would let
   the HTTP parser take one shape regardless of stream type.
   Workaround: use generics + accept the code bloat.

2. **Streaming bodies.** `Request.body: uint8[]` materializes the whole
   body up front. A `Body` shape that's "this Readable, give it to me
   on demand" needs (1) above.

3. **Function values.** No closures or function-pointer values means a
   router can't take `(req) -> Response` as data. Routing today has to
   be done via a trait-object enum or via codegen-time wiring (every
   handler is a separate type that implements Handler).

4. **Map / hash collections.** `Headers` is a linear-scan vec. A real
   map would let lookups stop being O(n). Probably waits on a generic
   `Map<K, V>` in a `std/collections/` module.

5. **String formatting beyond printf templates.** A `Display` trait
   exists at the syntax level but templates don't yet consult it. The
   library can implement `to_string()` methods today; users call them
   manually and embed the result. Lifting Display into templates is a
   small typechecker change (look up `Display.to_string` when an arg
   isn't an int/float/bool/string).

6. **`std/` import root.** Today, importing the library means
   `import { ... } from "../../std/net/tcp.yoop";` — relative-path
   ugly. A search-root mechanism (`import { ... } from "std/net/tcp";`
   resolved against a configured root) is the obvious fix; doesn't
   require any language change, just a driver tweak.

7. **`?` over enums.** A `Result<T, E>` enum can't be `?`-propagated
   because `?` only understands `err: string`-bearing structs. Phase
   7.5 introduced enums but didn't extend `?`. If we add it, library
   code can move to enum-based error types — but the current convention
   works and is documented.

None of these block the library's MVP. They're listed so future phase
plans know where the friction is.

## 9. Other "batteries-included" categories (sketch)

The user mentioned **Enumerables**, **Networking/HTTP**, and
**Debugging/Console** as example categories. This doc covers
networking/HTTP in depth; the others get a paragraph each.

### Enumerables

Waits on the `Iterator<T>` trait + a `for ... in ...` loop form. When
both exist, the `std/collections/` module grows `Vec<T>`, `Deque<T>`,
`Map<K, V>` with consistent iteration via `Iterator`. The existing
`xs.len` + index-loop is the workaround until then.

### Debugging / Console

A `std/log/` module with leveled loggers (`info`, `warn`, `error`),
formatted output via `Display`, and an optional structured-log JSON
sink. The hard part isn't the library — it's deciding where logs *go*
(stderr by default, a file via env var, a network sink for production).
The library should expose a `Logger` trait and a `default_logger`
module-level let. **Design when we need it; not before.**

A `std/debug/` module with `assert(cond, msg)`, `unreachable(msg)`, and
a `panic(msg)` that calls `abort()` after writing to stderr. These are
trivial; can ship in the same phase as the network library.

## 10. What lands first

A realistic order, each its own phase doc:

- **Library Phase A**: `std/core/` (Disposable, Readable, Writable,
  Display traits; disposable kind re-exported). Tiny.
- **Library Phase B**: `std/net/` (Socket, TcpListener, TcpStream).
  Uses Phase 8.A–F primitives directly. End-to-end demo: echo server.
- **Library Phase C**: `std/http/` (Method, StatusCode, Headers,
  Request, Response, Client). Demo: GET `http://example.com/` and
  print the body.
- **Library Phase D**: `std/http/server` (Server, Handler). Demo:
  Hello-World server that handles N requests in sequence.
- **Library Phase E**: routing, streaming bodies, connection pooling —
  whichever the §8 language work has unblocked by then.

Each phase is small enough to scope into a single PR, has a runnable
demo, and doesn't depend on the next.
