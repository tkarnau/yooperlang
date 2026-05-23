// Library Phase D — HTTP server (`Handler`, `serve_forever`)

> Fourth and final slice of the library-design rollout. Glues
> Phase B (TCP) and Phase C (HTTP types + parser) into a hello-world
> server: accept connections, parse each request, dispatch to a user
> handler, write back a response, close. Targets a yoop program that can
> be `curl localhost:8080`'d successfully.

## 1. Scope

One public-facing module + one example:

```
std/http/
    server.yoop                # Handler trait, serve_forever, serve_n

examples/pass/hello_server/
    main.yoop                  # 30-line hello-world server
```

`server.yoop` exports:

```yoop
export trait Handler {
    function handle(ref self, ref req: Request, ref resp: Response): HandleOutcome;
}

export type HandleOutcome { err: string }

export type Server implements Disposable propagates<disposable> {
    listener: TcpListener,
    function dispose(ref self): void { Disposable.dispose(ref self.listener); }
}

export function bind_server(addr: SocketAddr, backlog: int32): ServerResult { ... }
export type ServerResult { server: Server, err: string } propagates<disposable>

// One-shot: accept the next connection, handle it, return. Useful for tests.
export task serve_one<H implements Handler>(ref s: Server, ref h: H): ServeOutcome;

// Loop forever (or until `n` requests have completed if n > 0).
export task serve_n<H implements Handler>(ref s: Server, ref h: H, n: int32): ServeOutcome;

export type ServeOutcome { served: int32, err: string }
```

## 2. Design decisions

### 2.1 Handler trait writes into a caller-provided `Response`

The library design ([§7.3](library-design.md#73-server)) sketched
`handle(ref self, req: Request): HandleResult` returning a fresh
`Response`. Two changes for the MVP:

1. **`Response` is passed by-ref**, not returned. The server pre-creates
   it with a default `Headers` Vec, hands it to the handler, and disposes
   it after writing. This keeps allocation in the server's control and
   avoids "where does this Response's Vec live" ambiguity.
2. **`Request` is also passed by-ref.** The server owns it, the handler
   borrows it, and the server disposes both after responding. Same
   ownership story as `Response`.

```yoop
type HelloHandler implements Handler {
    greeting: string,
    function handle(ref self, ref req: Request, ref resp: Response): HandleOutcome {
        resp.status = ok();
        headers_add(ref resp.headers, "Content-Type", "text/plain");
        headers_add(ref resp.headers, "Connection", "close");
        resp.body = string_as_bytes(self.greeting);
        return { err: "" };
    }
}
```

### 2.2 No keep-alive, no pipelining, no concurrency at the handler level

`Connection: close` is the canonical hello-world response header. Each
accepted connection is read, parsed, dispatched, written, and closed in
sequence — no per-connection task fan-out at the server level. The
runtime multiplexer still gives us cooperative concurrency *within* a
connection (the recv waits and send waits don't block the worker
thread), but two simultaneous clients are handled sequentially.

This is the *correct* MVP shape. Per-connection task spawning is in the
library design but lifts the bar from "first server" to "production
shape" — leave it to a follow-up so the surface this phase has to
defend is small.

### 2.3 `serve_one` for tests, `serve_n` for demos, no `serve_forever`

```yoop
export task serve_n<H implements Handler>(ref s: Server, ref h: H, n: int32): ServeOutcome;
```

`n <= 0` means "loop forever." `n > 0` is the test-friendly version
(handle exactly N requests, then return). Both have the same body shape;
no two separate functions.

`serve_one` is sugar for `serve_n(s, h, 1)` and exists because the
fixture in `examples/pass/hello_server/` uses it: serve one request, get
verified by the e2e test (which curls the port and checks the body),
then exit cleanly.

### 2.4 The server's read loop

Per connection:

1. `disposable buf: Vec<uint8> = vec_new(4096);` — accumulator.
2. Loop: `tcp_read` into a 1KB scratch slice, push into `buf`, look for
   `\r\n\r\n`. Bail with err if buffer grows past 64KB without finding
   it (DoS guard).
3. Call `parse_request_head(vec_as_array(ref buf))`.
4. If parsed `content_length > 0`, continue reading until buf has that
   many trailing bytes after `body_start`. Slice into `req.body`.
5. Pre-create `Response { status: server_err(), headers, body: [] }`.
6. Call `Handler.handle(ref self, ref req, ref resp)`.
7. Serialize `resp` into a fresh `Vec<uint8>`, call `tcp_write_all`.
8. Dispose all four (`buf`, `req`, `resp`, `stream`).

Every "fresh `Vec`" is a `disposable` binding so the autocleanup at
scope end handles errors without leaking on the exception path.

### 2.5 `Handler` is **not** stored type-erased

The user's handler type is monomorphized in via generics
(`serve_n<H implements Handler>`). Storing it inside `Server` would
require type erasure (vtable, the §8 open question), which doesn't exist
yet. The user passes the handler at `serve_n` time:

```yoop
let server: Server = bind_server(localhost(8080), 128)?;
let handler: HelloHandler = { greeting: "Hello, World\n" };
let outcome: ServeOutcome = wait serve_n(ref server, ref handler, 1);
```

When vtables land, `Server` can grow a stored handler field and
`bind_server` can take it directly — backwards-compatible with the
current free-handler shape.

**Implementation note**: generic *functions* are well-supported (Phase
7.1). Generic *tasks* may need verification — the parser accepts the
syntax (`parseFunctionDeclBody` calls `parseTypeParamList` regardless of
`isTask`) but codegen / kindcheck paths might require small fixes. **If
generic tasks turn out not to typecheck cleanly**, the workaround is to
make `serve_n` a regular function that internally spawns one non-generic
`accept_one` task per connection; the handler-trait dispatch is done
synchronously between accepts. Same external behavior, no language change
needed.

## 3. The example

```yoop
// examples/pass/hello_server/main.yoop
import { localhost } from "../../../std/net/addr.yoop";
import { Server, bind_server, serve_n, Handler, HandleOutcome }
    from "../../../std/http/server.yoop";
import { Request, Response, headers_add, ok }
    from "../../../std/http/response.yoop";
import { string_as_bytes } from "../../../std/core/strings.yoop";
import { disposable } from "../../../std/core/kinds.yoop";

extern "C" from "stdio.h" {
    function printf(fmt: string, ...): int32;
}

type HelloHandler implements Handler {
    greeting: string,
    function handle(ref self, ref req: Request, ref resp: Response): HandleOutcome {
        resp.status = ok();
        headers_add(ref resp.headers, "Content-Type", "text/plain");
        headers_add(ref resp.headers, "Connection", "close");
        resp.body = string_as_bytes(self.greeting);
        return { err: "" };
    }
}

function main(): int32 {
    let r: ServerResult = bind_server(localhost(8080), 128);
    if (r.err.len > 0) {
        printf(`bind failed: ${r.err}\n`);
        return 1;
    }
    disposable server: Server = r.server;
    let handler: HelloHandler = { greeting: "Hello, World\n" };
    printf(`listening on 127.0.0.1:8080\n`);
    let outcome: ServeOutcome = wait serve_n(ref server, ref handler, 1);
    printf(`served=${outcome.served} err=${outcome.err}\n`);
    return 0;
}
```

Run it manually:

```
$ node ./src/yoopiler.js examples/pass/hello_server/main.yoop -o /tmp/hello_server
$ /tmp/hello_server &
listening on 127.0.0.1:8080
$ curl -v http://localhost:8080/
... HTTP/1.1 200 OK\nContent-Type: text/plain\nConnection: close\n...
Hello, World
$ wait                # serve_n(..., 1) means the server exits after the curl
served=1 err=
```

## 4. E2E test

`src/e2e.test.js` gets a new fixture:

```javascript
it("hello_server: bind + serve 1 request + curl returns 200 + body matches", async () => {
    // 1. Compile and start the server binary as a background process.
    // 2. Wait briefly for "listening on" stdout (or sleep ~50ms).
    // 3. Make an HTTP request to localhost:8080 via Node's `http.request`.
    // 4. Assert status 200, body "Hello, World\n".
    // 5. Server exits on its own (serve_n with n=1). Check exit code.
});
```

Port `8080` may be in use on a CI runner; the test picks an ephemeral
port by reading it back from the server's stdout, or hard-codes a
high-numbered port that's typically free (`18080`). The fixture is
parameterized via an env var read at runtime — keeps the fixture
deterministic when run standalone.

## 5. Files touched

- **New**: `std/http/server.yoop`.
- **New**: `examples/pass/hello_server/main.yoop`.
- **Modified**: `src/e2e.test.js` (one new test case).
- **No language changes**, except possibly small typechecker /
  codegen fixes if generic tasks don't already work (see §2.5).

## 6. Dependencies

Strictly downstream of Library Phases A, B, C. Once this lands, the
"first runnable web server in yoop" milestone is complete.

## 7. Follow-ups (not in this phase)

- Per-connection task fan-out for true concurrency.
- Keep-alive and pipelining.
- Routing (`Router` type, multiple `Handler`s by path).
- Streaming bodies (waits on vtable / dyn-Trait in the language).
- Client-side `Client.send` parallel to the server (uses the same
  parser; trivial once the server's working).
- TLS, HTTP/2, HTTP/3.
