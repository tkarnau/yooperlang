# Library design - patterns and the networking story

> Design contract for "batteries-included" Yooperlang libraries. Parallel
> to [runtime-design.md](runtime-design.md), but for the *library* layer
> that sits on top of the runtime: foundational traits and kinds, then
> the network + HTTP modules built on them.

## 1. Purpose and scope

Phase 8.A–F gave yoop the language and runtime primitives to talk to libc
(pointers, C aliases, errno, multiplexer). This document describes the
**library layer** that turns those primitives into something a user
actually wants to call - a `TcpListener`, an `HttpRequest`, a `Client`.

The goal is one consistent set of conventions so every standard module
looks like every other. Three concrete deliverables:

1. **Library principles** - the rules every `std/*` module follows.
2. **Staple traits and kinds** - the small foundational set that
   downstream modules build *on top of*. Currently: `Disposable`
   (existing), `Readable`, `Writable`, `Display`. Kinds: `disposable`
   (existing). New: none required at the foundational layer - the
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
  for some HTTP features (headers in particular) - see §8.
- A logging framework (the "Debugging/Console" category the user
  mentioned). Covered briefly in §9, but its design is a separate doc.

## 2. Library principles

### 2.1 Pure-yoop public API; unsafe-yoop guts allowed

A library module's **public** surface - the names other yoop programs
import - must compile without `import.unsafe;`. Implementation modules
that use `unsafe_ptr<T>`, libc externs, or `xs.ptr` are fine *as long as*
they don't surface pointer types in their exported signatures.

Concretely:

```yoop
// std/net/socket_ffi.yoop  - unsafe, not directly imported by users
import.unsafe;

extern "C" from "sys/socket.h" {
    function socket(domain: c_int, type: c_int, proto: c_int): c_int;
    // ...
}

export function ll_socket(domain: c_int, type: c_int, proto: c_int): c_int {
    return socket(domain, type, proto);
}

// std/net/socket.yoop  - safe, this is what users import
import { ll_socket } from "./socket_ffi.yoop";

type Socket implements Disposable propagates<disposable> {
    fd: c_int,
    closed: bool,
    function dispose(ref self): void { /* close(fd) */ }
}

export type SocketResult implements Disposable propagates<disposable> {
    socket: Socket,
    error:  string,
    function dispose(ref self): void { /* close inner socket */ }
}

export function open_socket(...): SocketResult propagates<disposable> { ... }
```

The split is a strong convention, not a typecheck rule. The split makes
it easy for users to grep their dependencies - "do I depend on any
`*_ffi.yoop`?" answers "am I building on unsafe code?".

### 2.2 Fallible returns use `Result<T, E>` + `?`

Every library function that can fail returns a `Result<T, E>` enum (from
[std/core/types.yoop](../std/core/types.yoop)). The caller propagates with
`?` or branches with `switch`.

```yoop
import { Result } from "std/core/types.yoop";

export function connect(addr: string, port: int32): Result<TcpStream, string> { ... }

// caller:
function fetch(url: string): Result<Response, string> {
    let c: TcpStream = connect("1.1.1.1", 80)?;   // Err propagates
    // ...
}
```

Disposable-bearing failure shapes (`SocketResult`, `ListenResult`,
`AcceptResult`, `ConnectResult`, `ParsedRequest`) stay as plain
`Disposable` structs with an explicit `error: string` field that the
caller inspects directly - `?` doesn't apply (the surrounding lifecycle
needs to be managed before propagation). They're a small handful of
named types, all under `std/net` and `std/http`.

Error messages in `error` payloads are user-facing strings. The standard
format is `"<operation>: <reason>"`. For libc failures, use
`errno.message(errno.get())` directly:

```yoop
return Result.Err { error: `connect: ${errno.message(errno.get())}` };
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

- **`disposable s: Socket = open_socket(...)?;`** - auto-cleanup at
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
the set small - every additional trait is a thing every library author
needs to know.

### 3.1 `Disposable` (existing - Phase 6.1)

```yoop
trait Disposable {
    function dispose(ref self): void;
}
```

The one trait every resource type implements. Paired with the
`disposable` kind that requires it. Used everywhere from sockets to
tasks to file handles. **Already in use; documented here for completeness.**

### 3.2 `Readable` - byte-stream input source (new)

```yoop
trait Readable {
    // Read into the front of `buf`, up to buf.len bytes. Ok payload is the
    // count of bytes actually written (0 = EOF on a stream); Err carries a
    // diagnostic.
    function read(ref self, ref buf: uint8[]): Result<c_ssize_t, string>;
}
```

Every byte source (TcpStream, file, in-memory buffer for testing)
implements `Readable`. The HTTP parser and any framing layer takes
`Readable` as input, so testing with a fake source is a one-struct
implementation.

The return shape is `Result<c_ssize_t, string>` so `?` works:

```yoop
function read_line(ref r: ref Readable, ref buf: uint8[]): Result<usize, string> {
    let n: c_ssize_t = Readable.read(ref r, ref buf)?;
    // ...
}
```

(Note: the parameter form `ref Readable` here is sketchy - yoop's
generics don't quite express "anything implementing Readable" as a
function parameter yet. See §8 "Open questions."  In the meantime,
library code can take a concrete struct that implements Readable and
hand-write a small abstraction layer if needed.)

### 3.3 `Writable` - byte-stream output sink (new)

```yoop
trait Writable {
    function write(ref self, ref buf: uint8[]): Result<c_ssize_t, string>;
    function flush(ref self): FlushOutcome;
}

// err-only outcome; concrete enum (no payload on Ok).
enum FlushOutcome { Ok, Err { error: string } }
```

Symmetric to `Readable`. `flush` is its own method because a buffering
writer needs it; for an unbuffered TcpStream it's a no-op.

### 3.4 `Display` - to-string conversion (new)

```yoop
trait Display {
    function to_string(ref self): string;
}
```

Used by template literals (eventually) and by any "format this for
humans" path. Currently template literals special-case `int`/`float`/
`bool`/`string` - generalizing to `Display`-implementing types is a
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
implement custom iteration today - for the staple library, all "iterate
over a collection" cases use plain `for (i = 0; i < len; ...)` loops.

## 4. Staple kinds

### 4.1 `disposable` (existing - Phase 6.4)

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

- **`pinned`** - value cannot escape its declaring scope. Useful for
  references that the multiplexer thread holds during a wait. Phase 6.2
  has `mustNotEscape` which is the underlying machinery; a `pinned`
  shorthand could be a follow-up.
- **`exclusive`** - value cannot be shared across tasks. Sockets are
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
    socket_ffi.yoop     # unsafe - extern declarations
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
search root - adding one is a small follow-up (see §8).

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

export type SocketResult implements Disposable propagates<disposable> {
    socket: Socket,
    error:  string,
    function dispose(ref self): void { Disposable.dispose(ref self.socket); }
}
export function open_tcp_socket(): SocketResult propagates<disposable> { ... }
```

A raw fd in a `Disposable` envelope. Users don't usually touch this
directly - `TcpListener` / `TcpStream` wrap it. Exposed because the
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

export type ListenResult implements Disposable propagates<disposable> {
    listener: TcpListener,
    error:    string,
    function dispose(ref self): void { Disposable.dispose(ref self.listener); }
}

export function listen(addr: SocketAddr, backlog: int32): ListenResult propagates<disposable> { ... }
```

`listen` does the socket() + bind() + listen() sequence; on failure
every intermediate fd is closed and `error` describes which call failed.

```yoop
export type AcceptResult implements Disposable propagates<disposable> {
    stream:    TcpStream,
    peer_host: uint32,
    peer_port: uint16,
    error:     string,
    function dispose(ref self): void { Disposable.dispose(ref self.stream); }
}

export task accept(ref l: TcpListener): AcceptResult propagates<disposable> {
    let rc: c_int = yoop_io_wait_readable(l.socket.fd);
    // ...
}
```

`accept` is `task` because it always blocks until a connection arrives.
The task suspends on `yoop_io_wait_readable` and resumes when the
listening fd is readable - the standard reactor pattern.

### 6.4 `TcpStream`

```yoop
type TcpStream implements Disposable + Readable + Writable propagates<disposable> {
    socket: Socket,
    function dispose(ref self): void {
        Disposable.dispose(ref self.socket);
    }
    function read(ref self, ref buf: uint8[]): Result<c_ssize_t, string> {
        // wait_readable + read(); convert (-1, errno) to Err.
    }
    function write(ref self, ref buf: uint8[]): Result<c_ssize_t, string> { ... }
    function flush(ref self): FlushOutcome { return FlushOutcome.Ok; }
}

export type ConnectResult implements Disposable propagates<disposable> {
    stream: TcpStream,
    error:  string,
    function dispose(ref self): void { Disposable.dispose(ref self.stream); }
}
export task connect(addr: SocketAddr): ConnectResult propagates<disposable> { ... }
```

This is the workhorse. Implements three traits (Disposable + Readable +
Writable) because that's exactly how a TCP byte stream behaves. Every
HTTP-layer abstraction takes a `TcpStream` (or any `Readable + Writable`
when the language allows that constraint).

`connect` is `task` for the same reason `accept` is - it may block.

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
    // No hash table - linear scan over `items` is fine for typical
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

export task send(ref c: Client, req: Request): Result<Response, string> {
    // 1. Parse URL → SocketAddr + request-target.
    // 2. connect() → TcpStream.
    // 3. Format request + write to stream.
    // 4. Read response.
    // 5. Parse response.
    // 6. Dispose stream.
    // Returns Result<Response, string>; caller `?`s if needed.
}
```

`Client` holds defaults; per-call state lives in `Request` / `Response`.
No mutation of `Client` across calls - it's effectively a struct of
configuration.

### 7.3 Server

```yoop
trait Handler {
    function handle(ref self, ref req: Request, ref resp: Response): HandleOutcome;
}

enum HandleOutcome { Ok, Err { error: string } }

export type Server {
    listener: TcpListener,
    // Handler is stored as a generic param so the user's handler type
    // is monomorphized in. Requires generic trait bounds (Phase 7.2).
}

export task serve<H implements Handler>(server: Server, ref handler: H): int32 {
    while (true) {
        let acc: AcceptResult = wait accept(ref server.listener);
        if (acc.error.len > 0) {
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
client-side (parsing responses) and server-side (parsing requests) -
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

1. **Trait-object parameters.** `function read(ref r: ref Readable)` -
   "any Readable" as a parameter type. Yoop generics today require an
   explicit `<R implements Readable>` and *monomorphize*. That's fine
   for performance but means every HTTP parser instantiation is a
   separate function, and a `Readable[]` can't mix stream types.

   **Direction:** Zig-style runtime polymorphism via a new `vtable`
   keyword that names the type-erased form of an existing trait. No
   magic `dyn` in type position; runtime polymorphism is just a
   concrete struct shape the compiler understands.

   Three pieces compose:

   - **Function types in type position use `=>`.** Declarations keep
     `: T` for return type (`function add(a, b): int32`); function
     *values* in type position use `(params) => Ret`. The two-shape
     split keeps `:` unambiguous inside struct fields and signals
     "this is a function value / pointer" at a glance.
   - **`vtable` type declarations.** A `vtable T { ... }` declares
     the erased shape of a trait. The compiler:
     - inserts an implicit `ctx: unsafe ptr<void>` field,
     - requires every other field to be a function type,
     - threads `ctx` as the implicit first parameter of each function
       field (the user writes the method signature; the compiler adds
       the ctx slot in the stored function pointer's type).
   - **The bridge: `Reader.from(ref s)`.** A built-in constructor on
     any `vtable` type that takes `ref T where T implements <trait>`
     and produces the erased form by looking up the impl's method
     addresses. The trait stays the source of truth; the impl block
     is written normally; `from` does the wiring.

   ```yoop
   trait Readable {
       function read(ref self, ref buf: uint8[]): int32;
   }

   impl Readable for TcpStream {
       function read(ref self, ref buf: uint8[]): int32 { ... }
   }

   vtable Reader for Readable {
       read: (ref buf: uint8[]) => int32,
   }

   // usage
   const r: Reader = Reader.from(ref my_tcp_stream);
   const n = Reader.read(ref r, ref buf);
   ```

   The `for Readable` clause ties the vtable to its trait so `from`
   knows which impls are eligible and the compiler can verify the
   field list matches the trait's method list.

   **Later sugar:** once `vtable T for Trait` is proven, the natural
   follow-up is auto-deriving the vtable struct directly from the
   trait (e.g. `vtable Readable` with no body, generating field names
   from the trait's methods). That removes the need to restate the
   method list and is the path to ergonomic `dyn Readable`-style use
   without ever making `dyn` a magic type.

   Until function values and `vtable` land, the workaround is
   generics plus monomorphization.

2. **Streaming bodies.** `Request.body: uint8[]` materializes the
   whole body up front. Once (1) lands, `body` becomes a `Reader`
   vtable plus a known `content_length` (or chunked-transfer marker),
   and the handler pulls bytes on demand:

   ```yoop
   type Request {
       method: HttpMethod,
       path: string,
       headers: Headers,
       body: Reader,
       content_length: ?usize,  // none = chunked / unknown
   }
   ```

   The MVP HTTP parser is generic over the underlying stream
   (monomorphized per `TcpStream` / `TlsStream` / `BufferedReader`).
   When `vtable Reader for Readable` is in, the parser switches to
   taking a single `Reader` and the handler can stream bodies through
   without buffering. Until then, `body` stays a fully-materialized
   `uint8[]`.

3. **Function values.** Splits into three cases once (1) lands:

   - **Plain function pointers** - top-level functions referenced by
     name, with no captured state. Solved by `=>` types in type
     position (introduced for vtable fields). A field typed
     `(req: Request) => Response` holds the address of any top-level
     function with that signature. A router can store
     `handlers: ((Request) => Response)[]` directly.
   - **Method bound to a struct instance** - "this `Router`'s
     `handle`, packaged up." Solved by `vtable`: a single-method
     vtable is exactly this shape. Each handler that needs state
     (db handle, config, etc.) is a struct implementing
     `HandlerTrait`; the router stores `vtable Handler for
     HandlerTrait` values built via `Handler.from(ref h)`.
   - **Closures** - anonymous functions that capture local variables.
     **Not planned, and may never land.** Closures require the
     language to synthesize a capture struct, decide capture-by-ref
     vs by-value, and pick an allocation strategy (heap / arena /
     stack) - a meaningful complexity tax that may not be worth it
     given the vtable-based workaround.

   Workaround for the closure case: hand-roll the capture as a
   struct, implement the relevant trait on it, hand it to `from`. Verbose, but it's the same machinery as case 2 and stays
   honest about where the state lives.

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
   `import { ... } from "../../std/net/tcp.yoop";` - relative-path
   ugly. A search-root mechanism (`import { ... } from "std/net/tcp";`
   resolved against a configured root) is the obvious fix; doesn't
   require any language change, just a driver tweak.

7. **Cross-shape `?` propagation.** `?` propagates the operand's `Err`
   payload into the enclosing function's `Err` variant only when the two
   payload types match exactly. Mixing `Result<_, IoError>` and
   `Result<_, AppError>` requires an explicit conversion at the `?` site
   (Phase 10.E will add a `From`-style trait). Phase 9.H added the
   enum-`?` recognizer; Phase 10.X retired the struct-fallible
   convention.

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
sink. The hard part isn't the library - it's deciding where logs *go*
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
- **Library Phase E**: routing, a client, and URL parsing landed as
  Phase 10.I ([plans/completed/phase-10-i-networking-polish.md](completed/phase-10-i-networking-polish.md)).
  `std/http/router.yoop` carries the `Router` + `Dispatcher` vtable;
  `std/http/client.yoop` ships `client_send` + `http_get`;
  `std/net/uri.yoop` does the URL parsing. Streaming bodies (Reader-
  backed `Request.body`), connection pooling / keep-alive, and TLS
  remain follow-ups - the `Reader`/`Writer` vtables added in 10.I are
  the language foundation; the parser switch is the next move.

Each phase is small enough to scope into a single PR, has a runnable
demo, and doesn't depend on the next.
