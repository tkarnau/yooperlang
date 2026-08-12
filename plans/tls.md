# TLS for std/http

> The last item between "a language that can talk to localhost" and "a language
> that can talk to the internet". Every commercial model API is HTTPS-only, and
> that single fact is the entire reason the yooperdoom sidecar was a Node
> process rather than a Yoop one.

Companion to [yooperdoom-takeaways.md](yooperdoom-takeaways.md) section 3.3,
which named this and deferred it pending a plan. Chunked decoding (3.1) and the
async handler plus concurrent serve (3.2) have both landed, so this is what is
left of the HTTP work.

Style: ASCII only, no em-dashes, no fancy tables.

---

## 1. What v1 is, and what it is not

**In scope.**

- Client-side TLS: connect, verify, read, write, close.
- SNI. Not optional in practice - a CDN or any shared host answers with the
  wrong certificate without it.
- ALPN advertising `http/1.1`. Cheap, and some servers now require it.
- Certificate verification ON by default, with hostname checking.
- `https://` working through the existing `std/http` client with no change to
  calling code beyond the URL.

**Out of scope for v1, deliberately.**

- **Server-side TLS.** The design below is symmetric (the same memory-BIO
  machinery serves `SSL_accept`), so this is a later phase rather than a
  redesign, but it is not what unblocks anything today.
- Session resumption, 0-RTT, client certificates, OCSP stapling, CRLs.
- TLS 1.2 and below as a configurable floor. v1 requires TLS 1.2 minimum and
  prefers 1.3; there is no knob to go lower.
- HTTP/2. ALPN is advertised as `http/1.1` only. h2 is a separate protocol
  implementation, not a TLS feature.

---

## 2. D1: OpenSSL 3.x, behind a `yoop_tls_*` shim

**Decision: link OpenSSL 3.x, and reach it only through a C shim in
`runtime/yoop_tls.c`, exactly the way `std/net` reaches sockets through
`runtime/yoop_net.c`.**

That shim precedent exists for a reason worth repeating here: CLAUDE.md records
that `std/net` must not call libc sockets directly, because a Windows socket is
a `SOCKET` handle rather than an fd and reports errors through
`WSAGetLastError` instead of `errno`. TLS has the same shape of problem, twice
over - OpenSSL's error reporting is a per-thread queue (`ERR_get_error`), and
its types (`SSL`, `SSL_CTX`, `BIO`, `X509_STORE`) are opaque pointers that yoop
should hold as `unsafe_ptr<T>` and nothing more. A shim that presents "connect,
feed, pull, read, write, close, last-error-string" is a much smaller surface
than OpenSSL's, and it is the surface that can stay stable if the backend ever
changes.

**Why not the alternatives:**

- **Platform-native (Secure Transport / SChannel / OpenSSL).** Three completely
  different APIs, one of which (Secure Transport) Apple has deprecated, which
  would mean Network.framework on macOS and therefore a fourth model. The
  multiplexer is already split three ways and that was justified by readiness
  genuinely not being portable; TLS is portable, so paying that cost again buys
  only the root store (see D5), and there are cheaper ways to get that.
- **BoringSSL.** No stable API or ABI and no releases. Fine if you vendor and
  pin; wrong for something a user is expected to install.
- **mbedTLS / wolfSSL.** Genuinely attractive - small, easy to vendor, clean
  API. The reason not to lead with one: OpenSSL is what is already installed
  everywhere, and `librarySearchArgs()` in
  [src/toolchain.js](../src/toolchain.js) already probes the Homebrew and vcpkg
  prefixes where it lives. Revisit if the OpenSSL dependency proves painful to
  install on Windows; the shim is what makes that a contained change.
- **Write one.** No.

---

## 3. D2: memory BIOs, and why the socket BIO is not merely worse

**Decision: OpenSSL never touches the socket. It reads and writes two memory
BIOs, and Yoop moves the ciphertext through the existing async I/O path.**

This is the most important decision in the document, and it is FORCED rather
than preferred.

The obvious approach is to hand OpenSSL the fd (`SSL_set_fd`) and let it do its
own I/O. On a non-blocking socket that means the standard OpenSSL loop: call
`SSL_read`, and on `SSL_ERROR_WANT_READ` wait for the socket to become
readable, on `SSL_ERROR_WANT_WRITE` wait for it to become writable, then retry.

`SSL_ERROR_WANT_WRITE` is the problem.
[runtime/yoop_io_internal.h](../runtime/yoop_io_internal.h) states it flatly:

> **write-readiness cannot be expressed on IOCP.** A zero-byte WSASend
> completes immediately even when the socket's send buffer is full, so there is
> no way to ask "is this writable yet". [...] Any design that puts "wait until
> writable" in the shared contract is therefore unimplementable on Windows, no
> matter how the code is arranged.

So the socket-BIO design is not a slower or uglier option. It is unimplementable
on one of the three supported platforms, and it would be discovered only when
someone ran it there.

The memory-BIO design sidesteps it completely, because every socket operation it
performs is one of the three the runtime already exports as a portable
OPERATION:

```
    yoop_iop_recv_begin / _end      "read some bytes"
    yoop_iop_send_begin / _end      "write some bytes"
```

**The shape:**

```
    ssl  <-- rbio (memory) <-- ciphertext we recv'd from the socket
    ssl  --> wbio (memory) --> ciphertext we send to the socket
```

A read becomes: try `SSL_read`; if it wants more input, drain `wbio` to the
socket (the handshake may owe the peer a flight), `recv` from the socket into
`rbio`, retry. A write is the mirror. The handshake is the same loop with
`SSL_do_handshake` in the middle. Every suspend point is an ordinary
`await ffiRecvAsync` / `ffiSendAllAsync`, which already work on all three
platforms and already release the worker.

Secondary benefits, which are real but are not the reason:

- The TLS layer is testable against a byte buffer with no socket at all, the
  same property that makes `std/http/wire.yoop` testable.
- Deadlines and cancellation keep working unchanged, because they live on the
  Yoop side of the socket call rather than inside OpenSSL.

**The cost to be honest about:** one extra copy in each direction (socket
buffer to `rbio`, `wbio` to socket buffer). At the rate an HTTP client moves
bytes this does not matter; if it ever does, `BIO_s_mem` can be replaced with a
custom BIO over the same buffers without changing the Yoop side.

---

## 4. D3: `std/http` stops naming `TcpStream`

**Decision: `std/http` takes a `Reader` / `Writer` pair instead of a concrete
`TcpStream`. This lands FIRST, before any TLS code exists.**

The vtables already exist, and
[std/core/traits.yoop](../std/core/traits.yoop) already names this exact case:

> want to mix concrete impl types behind one parameter (e.g. an HTTP parser
> that doesn't care whether it's reading from a TcpStream, a **TlsStream**, or
> an in-memory buffer) take a `Reader` / `Writer` rather than a generic
> `<R implements Readable>`.

So the groundwork was laid deliberately and has simply never been used. Two
properties make this the right seam rather than a generic bound: the serve loop
is already non-generic on purpose (a generic calling a generic across module
boundaries is the thing `Dispatcher` exists to avoid), and the vtables
deliberately do NOT carry `Disposable`, so ownership of the socket stays with
whoever opened it - which is what we want, because a `TlsStream` owns an `SSL*`
that has to be freed in a particular order relative to the fd.

**Size of the change:** 14 mentions of `TcpStream` in `server.yoop`, 5 in
`client.yoop`. Mechanical.

**Why it lands first, alone:** it is verifiable with the existing test suite
plus one new in-memory-Reader fixture, and it has no external dependency. If
the TLS work stalls on an OpenSSL packaging problem, this still leaves the tree
better than it found it - and `examples/pass/reader_vtable_smoke` already
proves the vtable path works.

**One thing to watch:** a vtable stores a POINTER to the value it was built
from, so the stream must outlive the `Reader`/`Writer`. That is the same rule
`Dispatcher` already has, and the concurrent serve loop already keeps the
connection alive for the whole of `serveConnection`, so the lifetime is already
correct. It needs saying in the doc comment anyway.

---

## 5. D4: `std/tls` is its own module, not part of `std/net`

**Decision: a new directory module `std/tls/`, not a file inside `std/net/`.**

Not a taste call. Link flags are collected PROGRAM-WIDE from every
`extern "C" from library "X"` block reachable in the module graph
([codegen.js:2915](../src/jsyoopcodegen/codegen.js#L2915) adds to a single
`Set`). `std/net` is one directory module, so an `extern ... from library
"ssl"` in a file inside it would make **every program that touches a socket
link OpenSSL**, whether or not it wants TLS.

A separate module keeps the dependency where it belongs: on programs that
import `std/tls`. This mirrors how `framework:OpenGL` already works - only a
program that names it gets `yoop_gl_win32.c` compiled in, via
`glueSourcesForLinkFlags` in [src/runtimeBuild.js](../src/runtimeBuild.js).

`runtime/yoop_tls.c` follows the same rule: it must NOT go into
`RUNTIME_SOURCES` (which every program gets), and instead rides on the
program's own library declaration through `glueSourcesForLinkFlags`. That
function currently special-cases OpenGL and Windows; it needs a second case,
and the OpenGL one shows the shape.

Proposed layout:

```
std/tls/config.yoop   TlsConfig, defaults, verification policy
std/tls/stream.yoop   TlsStream: Disposable + Readable + Writable
std/tls/ffi.yoop      the ONLY file with import.unsafe, per std/net's rule
runtime/yoop_tls.c    the shim
```

---

## 6. D5: verification, the root store, and failing closed

This is the part that is genuinely awkward on three platforms, and the part
most likely to be got wrong quietly.

**Verification is on by default and failures are fatal.** No "fall back to
unverified on error", no `verifyPeer` defaulting to false, no environment
variable that turns it off globally. This document's sibling records what
happens when a safety feature fails open - see yooperdoom-takeaways 0.1, where
a conferred kind silently stopped being enforced and programs were written
against a guarantee that was not there. A TLS client that connects anyway when
verification fails is the same failure with worse consequences.

Turning verification off must be possible (self-signed certificates in
development are real) but must be per-connection, explicit in the source, and
named so it cannot be typed by accident:

```js
let cfg: TlsConfig = tls.tlsConfigNew();
cfg.dangerouslyDisableVerification = true;   // not `verify = false`
```

**Hostname verification is part of it.** `X509_VERIFY_PARAM_set1_host` must be
set, not just chain verification - a valid certificate for a different host is
the classic hole and OpenSSL does not check it for you unless asked.

**The root store, per platform:**

- **Linux.** `SSL_CTX_set_default_verify_paths()` works; the distro ships
  `/etc/ssl/certs` and OpenSSL is compiled to look there.
- **macOS.** OpenSSL does NOT read the system keychain. Homebrew's OpenSSL
  ships its own `cert.pem` from the `ca-certificates` formula, so
  `set_default_verify_paths` works when installed the normal way and fails when
  it is not.
- **Windows.** OpenSSL has no default store at all, and the system roots live
  in CryptoAPI. This needs a bridge in the shim: `CertOpenSystemStoreW(L"ROOT")`,
  enumerate, `d2i_X509` each blob, `X509_STORE_add_cert`. Roughly 40 lines and
  the only genuinely platform-specific code in the TLS work.

Until that bridge exists, Windows verification FAILS - which is the correct
direction to fail, and is why it is worth writing the platform note before the
platform code.

`TlsConfig` carries `caFile` / `caPath` overrides for pinning and for corporate
proxies, which is also how the test suite will point at its own throwaway CA
(section 8).

---

## 7. Phasing

Each phase is separately verifiable and separately valuable. Do not start the
next until the previous one is green.

**Phase 0 - `std/http` becomes stream-agnostic. DONE (2026-08-11).**

`std/http` no longer names `TcpStream` anywhere below the accept/connect
boundary. Every reader and writer parameter through `client.yoop` and
`server.yoop` is now a `Reader` / `Writer`, and the concrete stream is erased
in exactly three places: `serve`, `serveConcurrent`'s `connectionTask`, and
`send`.

- `serveConnection(ref stream: TcpStream, ...)` is KEPT as a thin wrapper that
  builds the pair, so a caller with its own accept loop
  (`examples/playground/counter_server`) needs no change. The work moved to a
  new exported `serveConnectionOn(ref r: Reader, ref w: Writer, ...)`.
- Reading and writing are separate views on purpose. They usually come from
  one stream, but nothing requires it - which is what lets a test drive a
  request in from one buffer and collect the response in another.
- Fixture: `examples/pass/http_no_socket/`. A full exchange with no socket -
  GET, a Content-Length POST, a CHUNKED POST decoded by the same path the
  socket server uses, and a malformed header answering 400 rather than falling
  over. A server test with no port, no timing, and no cleanup.
- All existing HTTP fixtures (loopback, chunked, proxy, concurrent, router)
  passed unchanged, which is what makes this a safe refactor rather than a
  rewrite.

Phase 1 can now add a `TlsStream` implementing `Readable`/`Writable` and hand
it to the same code.

**Phase 1 - the shim and a handshake. DONE (2026-08-11).**

Real TLS 1.3 handshakes, verified, over the memory-BIO design. Landed:

- `runtime/yoop_tls.c` - about a dozen calls. OpenSSL does all the crypto and
  all the protocol; this owns the surface and the ciphertext movement.
- `std/tls/` - `ffi.yoop` (the only file with `import.unsafe;`, mirroring
  std/net's rule) and `stream.yoop` (`TlsConfig`, `TlsStream`, the pump).
  `TlsStream` implements `Readable`/`Writable`, so phase 0's work means every
  `Reader`/`Writer` consumer already accepts one.
- Build wiring: `yoop_tls.c` compiles in only for a program that names
  OpenSSL, `lowerLinkFlag` expands `ssl` to `-lssl -lcrypto` (naming one
  always means both), and `librarySearchArgs` learned the KEG-ONLY Homebrew
  prefixes - `brew install openssl@3` does not symlink into `/opt/homebrew`,
  so the existing probe would have missed it on a clean machine.
- Fixture `examples/pass/https_client/` against a Node HTTPS server with a
  throwaway CA, offline, self-skipping when OpenSSL is absent.

**Three things worth recording:**

1. **The IP-versus-name distinction is a real trap.** A textual IP is checked
   against the certificate's iPAddress SAN and a DNS name against dNSName, and
   using the wrong one silently fails to match. SNI must also be omitted for an
   IP (RFC 6066). Both are handled; `a2i_IPADDRESS` does the detection because
   it has no side effects - using `X509_VERIFY_PARAM_set1_ip_asc` as the test
   leaves the constraint set, and clearing it means passing NULL, which that
   function dereferences. That was a real crash.
2. **`TlsConfig.serverName` was added because the negative test needed it**,
   and it turned out to be a feature rather than a test affordance: the address
   dialled and the name verified genuinely come apart (an IP with a named
   certificate, a proxy, one node of a cluster). Without it the only way to
   reach those is to disable verification entirely - a knob meant for one
   narrow case ending up disabling everything.
3. **Ownership of the socket MOVES into the TlsStream**, so `tcpConnect`'s
   result is bound with a plain `let` and disposed by hand on the error paths.
   A `disposable` binding there closes the fd the moment `tlsConnect` returns,
   which surfaced as "Bad file descriptor" on the first write, several frames
   from the cause.

Also fixed on the way: `runFixtureEntry` in the e2e harness was missing both
`glueSourcesForLinkFlags` and `librarySearchArgs`, so it could never have built
a fixture naming an external library. Invisible until one did.

**Phase 2 - `https://` in the client. DONE (2026-08-11).**

`https.get(ref c, "https://example.com/", ref cfg)` works, against the live
internet and against the local test server.

The dependency runs the OPPOSITE way from what the phase originally sketched,
and that is the interesting part. `std/http/client.yoop` does NOT choose a
TlsStream, because it must not know TLS exists - link flags are program-wide,
so one import there would make every program that speaks HTTP link OpenSSL.
Instead:

- `std/http` gained `sendOn(ref c, ref req, ref u, ref r, ref w)`: the whole
  client minus the socket. `send` is that plus `tcpConnect`.
- `std/https` is a third module that depends on both and supplies the
  connection, dispatching on the URL scheme (an `http://` URL delegates
  straight to `http.send`).

The layering is why `std/https` is about 60 lines of actual code: phase 0 made
std/http take `Reader`/`Writer`, phase 1 made `TlsStream` implement
`Readable`/`Writable`, and this is only the place the two meet. It generalizes
past TLS too - `sendOn` is what a unix socket, a proxy tunnel, or an in-memory
test connection would use.

**Guarded by a test, because it breaks silently.** One `import` added to
std/http and every HTTP program suddenly needs OpenSSL installed to build. The
e2e suite asserts that `hello_server` produces no link flags and no glue
sources, and that `https_client` produces both. It needs no clang - it
inspects what the driver would hand the linker.

The takeaways' HTTP/1.0 workaround (ask in 1.0, which has no chunked encoding,
and read to EOF) is now unnecessary on both counts: chunked decoding landed in
3.1 and TLS here.

**Phase 3 - platform hardening.** The Windows root-store bridge; the macOS
"Homebrew OpenSSL not installed" diagnostic; a clear error when the library is
missing at link time rather than an unresolved-symbol dump.

**Phase 4 - server-side TLS (optional, later).** `SSL_accept` over the same
memory-BIO machinery, a `TlsListener` wrapping `TcpListener`. Nothing in phases
0 to 3 should preclude it, and nothing should wait for it.

---

## 8. Testing

The awkward part, and worth deciding up front rather than discovering.

**The peer is Node.** The test harness is already Node, so `node:tls` gives a
real, independent TLS implementation to handshake against - which is the whole
point, since a TLS client tested only against itself is not tested. Same shape
as the existing loopback fixtures: spawn the server on port 0, read back the
assigned port, connect.

**Certificates are checked in, long-dated, and clearly labelled.** A
self-signed CA plus a `localhost` leaf, generated once with a 100-year lifetime
and committed under something unmissable like
`examples/pass/https_client/testdata/`. The README next to them carries the
regeneration command.

A checked-in private key is normally a bad smell. It is acceptable here for
exactly one reason: it protects nothing, and it is never used to authenticate
anything outside this test. That has to be written next to the file, because
the next person to see it will otherwise either panic or copy it.

**The suite must self-skip when OpenSSL is absent**, the way the DWARF tests
already self-skip on Windows via `dwarfSkipReason` in
[src/e2e.test.js](../src/e2e.test.js). A contributor without OpenSSL should get
a skipped test with a reason, not a wall of link errors.

**Negative tests matter more than the positive one here.** A handshake that
succeeds proves very little; what needs proving is that the bad cases FAIL:

- expired certificate -> refused
- wrong hostname (valid cert, wrong CN/SAN) -> refused
- self-signed, not in the trust store -> refused
- and the same three succeeding once `dangerouslyDisableVerification` is set,
  so the escape hatch is known to work and known to be the only thing that
  opens the gate

That mirrors the `demos/gate_bypass.yoop` habit the takeaways praised: a
security property needs a test that tries to violate it, because a gate that
never binds and a gate that always binds look identical from the passing side.

---

## 9. Risks, in order

1. **OpenSSL on Windows is the schedule risk.** Not the code - the
   availability. vcpkg works, and `librarySearchArgs()` already probes it, but a
   contributor without it gets a link failure. Mitigation: self-skipping tests
   (section 8) and a diagnostic in phase 3 that names the missing library
   instead of dumping symbols.
2. **The memory-BIO loop is fiddly to get right**, particularly around
   `SSL_ERROR_WANT_READ` at handshake time when `wbio` also has bytes pending.
   Mitigation: it is socket-free, so it can be unit-tested against buffers
   before it ever meets a socket.
3. **The Phase 0 refactor touches every signature in std/http.** Mitigation:
   it is mechanical, it lands alone, and the existing HTTP fixtures (loopback,
   chunked, proxy, concurrent, router) all exercise it.
4. **Root-store differences produce a "works on my machine" verification bug.**
   Mitigation: phase 3 exists specifically for this, and the negative tests in
   section 8 catch a store that trusts too much.

---

## 10. Sequencing against everything else

This is not on the self-hosting critical path, and `plans/README.md` is clear
that self-hosting is priority 1. TLS is the largest single item left in the
takeaways and it competes directly for time.

The honest framing: phase 0 is worth doing regardless - it is a cleanup the
codebase was already designed for, it needs no dependency, and it makes
`std/http` testable without sockets. Phases 1 to 3 are worth doing when talking
to a real HTTPS API is the thing actually being blocked, and not before, because
until then the HTTP/1.0 stopgap and a local model runner cover the ground.
