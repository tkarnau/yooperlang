// Library Phase B — Networking primitives (`Socket`, `TcpListener`, `TcpStream`)

> Second slice of the library-design rollout
> ([library-design.md §6](library-design.md#6-networking-layer)). Wraps the
> Phase 8.A–F primitives (unsafe_ptr, c_int, errno, multiplexer) into
> safe, disposable, task-aware yoop types.

## 1. Scope

Five new `std/net/*` modules build the pure-yoop networking surface on
top of libc + the multiplexer:

```
std/net/
    addr.yoop         # SocketAddr struct + display helpers
    socket_ffi.yoop   # unsafe — extern C bindings, htons/inet_addr
    socket.yoop       # Socket (raw fd, Disposable propagates<disposable>)
    tcp.yoop          # TcpListener, TcpStream (task accept/read/write)
```

Each user-importable module (`addr.yoop`, `socket.yoop`, `tcp.yoop`)
compiles **without** `import.unsafe;`. The split is the
[library-design.md §2.1](library-design.md#21-pure-yoop-public-api-unsafe-yoop-guts-allowed)
convention.

### Architecture sketch

```
TcpListener  --owns--> Socket(fd)        # listen() bound listening fd
TcpStream    --owns--> Socket(fd)        # connect() / accept() result fd

task TcpListener.accept     -> AcceptResult { stream: TcpStream, peer: SocketAddr, err }
task TcpStream.connect      -> ConnectResult { stream: TcpStream, err }
task Readable.read on TcpStream
task Writable.write on TcpStream
```

The `task` calls go through `yoop_io_wait_readable` /
`yoop_io_wait_writable` so they cooperate with the runtime multiplexer:
when a task is parked waiting for an fd, the worker thread picks up other
work. Same pattern as
[examples/pass/concurrent_pipe.yoop](../examples/pass/concurrent_pipe.yoop).

## 2. Design decisions

### 2.1 IPv4 only, blocking sockets, multiplexer-driven readiness

The MVP targets IPv4 (`AF_INET`) only — IPv6 + URI authority parsing is a
follow-up the library design names as out of scope. Sockets are left in
**blocking mode**; concurrency comes from spawning one task per
connection and parking each task on `yoop_io_wait_readable` /
`yoop_io_wait_writable` before issuing the actual `recv` / `send`. This
mirrors the existing concurrent_pipe pattern and avoids the complexity
of EAGAIN-retry loops.

The trade-off: if a peer sends a 1-byte SYN+ACK with no payload, our
task will `wait_readable`, the multiplexer fires, and then the `recv`
call may still return 0 (EOF). Code must handle that case. It's
documented and tested.

### 2.2 `sockaddr_in` via a `c_layout` struct, not a byte buffer

[examples/pass/clock_gettime_layout.yoop](../examples/pass/clock_gettime_layout.yoop)
showed the pattern: declare a `kind c_layout` once, attach it to types
that need C-ABI layout. `SockAddrIn` lives in `socket_ffi.yoop`:

```yoop
kind c_layout {
    appliesTo type;
    layout { abi "C"; };
}

export type SockAddrIn c_layout {
    sin_family: uint16,
    sin_port:   uint16,   // network byte order, build via htons
    sin_addr:   uint32,   // network byte order, build via htonl or inet_addr
    sin_zero:   uint64,   // 8 bytes of padding required by sockaddr_in shape
}
```

Total size 16 bytes, matching `sizeof(struct sockaddr_in)` on every
mainstream platform. Passed to `bind` / `accept` as
`unsafe_ptr<SockAddrIn>` via the `&` address-of operator.

### 2.3 `Socket` is the universal Disposable envelope

```yoop
export type Socket implements Disposable propagates<disposable> {
    fd: c_int,
    function dispose(ref self): void {
        if (self.fd >= 0) {
            let rc: c_int = close(self.fd);
        }
    }
}
```

`TcpListener` and `TcpStream` each own a `Socket` (not a raw fd) so the
close path is centralized: if `dispose` ever needs to grow (logging
shutdown errors, draining a Linger queue), one edit reaches every
resource. Per Phase 6.4, both wrapper types declare
`propagates<disposable>` so the obligation flows through binding
boundaries.

### 2.4 Errors via the fallible-struct convention

Every operation that can fail returns a struct ending in `err: string`.
For libc failures the message is `errno.message(errno.get())` so the
caller gets the underlying reason. The fallible-struct shape is what `?`
understands today — same pattern Phase 8.D's `errno_fallible` example
uses.

`Result` types:

```yoop
export type SocketResult { socket: Socket, err: string }       propagates<disposable>
export type ListenResult { listener: TcpListener, err: string } propagates<disposable>
export type AcceptResult { stream: TcpStream, peer: SocketAddr, err: string } propagates<disposable>
export type ConnectResult { stream: TcpStream, err: string }   propagates<disposable>
```

Note: every `*Result` propagates `disposable` so an unobserved happy-path
binding still has its fd closed at scope end.

### 2.5 No connection pooling, no `SO_REUSEADDR` toggle

`TcpListener.listen` always sets `SO_REUSEADDR` (most servers want it;
saves a "Address already in use" footgun during dev). No toggle to turn
it off — add when a user has a real reason.

No connection pooling for client-side use; each `Client.send` opens a
fresh socket. A pool is one of the first follow-ups when `Map<K, V>`
lands.

## 3. Module layout in detail

### 3.1 `std/net/socket_ffi.yoop` (unsafe — not user-importable)

Declares the `SockAddrIn` struct and the libc / runtime externs. Exports
helper wrappers that hide the unsafe operations so callers don't have to
`import.unsafe;` themselves.

```yoop
import.unsafe;

extern "C" from "sys/socket.h" {
    function socket(domain: c_int, type: c_int, proto: c_int): c_int;
    function bind(fd: c_int, addr: unsafe_ptr<SockAddrIn>, len: c_int): c_int;
    function listen(fd: c_int, backlog: c_int): c_int;
    function accept(fd: c_int, addr: unsafe_ptr<SockAddrIn>, len: unsafe_ptr<c_int>): c_int;
    function connect(fd: c_int, addr: unsafe_ptr<SockAddrIn>, len: c_int): c_int;
    function setsockopt(fd: c_int, lvl: c_int, opt: c_int, val: unsafe_ptr<c_int>, valLen: c_int): c_int;
    function send(fd: c_int, buf: unsafe_ptr<uint8>, n: c_size_t, flags: c_int): c_ssize_t;
    function recv(fd: c_int, buf: unsafe_ptr<uint8>, n: c_size_t, flags: c_int): c_ssize_t;
}
extern "C" from "unistd.h" {
    function close(fd: c_int): c_int;
}
extern "C" from "arpa/inet.h" {
    function htons(port: uint16): uint16;
    function inet_addr(addr: string): uint32;
}
extern "C" from "yoop_runtime" {
    function yoop_io_wait_readable(fd: c_int): c_int;
    function yoop_io_wait_writable(fd: c_int): c_int;
}
```

Constants needed from `<sys/socket.h>` (`AF_INET = 2`, `SOCK_STREAM = 1`,
`SOL_SOCKET = 1`, `SO_REUSEADDR = 2`) are exposed as
yoop-side `const` declarations — yoop doesn't yet have a way to pull
preprocessor constants from headers, so they're hand-mirrored. **Linux**
values; macOS is identical for the four we need.

Exports four thin task-aware helpers used by `socket.yoop` and
`tcp.yoop`:

- `function ffi_socket_open(): SocketFdResult`
- `function ffi_bind_listen(fd, port, backlog): c_int` (port; binds to
  INADDR_ANY)
- `task ffi_accept(fd): AcceptFdResult` — parks on multiplexer, returns
  `(client_fd, peer_addr)` or err
- `task ffi_recv(fd, buf): RecvResult` — parks then recv into `buf`
- `task ffi_send_all(fd, buf): c_ssize_t` — parks then send loop

Each FFI helper returns a fallible struct with the same shape as the
public-facing wrappers; `socket.yoop` and `tcp.yoop` just re-wrap to
attach a `Socket` / `TcpStream` envelope around the bare fd.

### 3.2 `std/net/addr.yoop`

```yoop
export type SocketAddr {
    host: string,    // dotted-quad IPv4 only in MVP
    port: int32,
}

export function addr_to_string(ref a: SocketAddr): string { /* host:port */ }
export function localhost(port: int32): SocketAddr { return { host: "127.0.0.1", port: port }; }
export function any_addr(port: int32): SocketAddr  { return { host: "0.0.0.0", port: port }; }
```

`Display` impl deferred to when template literals consult the trait — for
now `addr_to_string` is a free function callers reach for explicitly
(matches the rest of std/core's pattern).

### 3.3 `std/net/socket.yoop`

`Socket { fd: c_int }` + `dispose`. `open_tcp_socket(): SocketResult`
delegates to `ffi_socket_open`. Re-exports `SocketResult` so callers
import one module instead of two.

### 3.4 `std/net/tcp.yoop`

```yoop
export type TcpListener implements Disposable propagates<disposable> {
    socket: Socket,
    addr:   SocketAddr,
    function dispose(ref self): void {
        Disposable.dispose(ref self.socket);
    }
}

export type TcpStream implements Disposable + Readable + Writable propagates<disposable> {
    socket: Socket,
    function dispose(ref self): void { Disposable.dispose(ref self.socket); }
    function read(ref self, ref buf: uint8[]): ReadOutcome { ... wait_readable + recv ... }
    function write(ref self, ref buf: uint8[]): WriteOutcome { ... wait_writable + send ... }
    function flush(ref self): FlushOutcome { return { err: "" }; }    // unbuffered, no-op
}

export task accept(ref l: TcpListener): AcceptResult { ... }
export task connect(addr: SocketAddr): ConnectResult { ... }
export function listen(addr: SocketAddr, backlog: int32): ListenResult { ... }
```

`accept` and `connect` are `task` because they always block on the
multiplexer. `read` and `write` are trait methods on `TcpStream`; the
language doesn't allow trait methods to *themselves* be `task`, so the
task suspension happens inside the regular method body (calling
`ffi_recv` / `ffi_send_all` which are tasks) — this works because trait
method bodies can invoke task functions and immediately `wait` on them
when only one in-flight is needed. **Confirmation needed at
implementation time**: if the trait-method-can't-call-task constraint
turns out to be stricter than expected, the workaround is to expose
`tcp_read` / `tcp_write` as free `task` functions and have the trait
method delegate via a single-call thunk that does `joined h = ffi_recv(...)`
+ `wait h`.

## 4. Files touched

- **New**: `std/net/socket_ffi.yoop`, `std/net/addr.yoop`,
  `std/net/socket.yoop`, `std/net/tcp.yoop`.
- **New test fixture**: `examples/pass/tcp_echo/main.yoop` — opens a
  listener on `127.0.0.1:0` (kernel-picked port), spawns a client task
  that connects and writes "ping", server task accepts + echoes the
  bytes back, prints round-trip success.
- **No language changes.** Every piece this phase needs landed in
  Phase 8.A–F.

## 5. Verification

End-to-end test in [src/e2e.test.js](../src/e2e.test.js) runs the
fixture above and checks exit code 0 plus a deterministic stdout. The
test must complete in under 5 seconds wall-clock — the multiplexer is
exercised, but no external network call is made (loopback only).

A negative test (`examples/fail/`) confirms the disposable obligation:
opening a socket without one of the three legal exits is a typecheck
error.

## 6. Dependencies

Library Phase A must have landed (`std/core/traits.yoop` for `Readable`,
`Writable`). Phase 8 prerequisites must have landed (unsafe_ptr, c_int,
errno, multiplexer) — all already in.
