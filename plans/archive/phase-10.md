# Phase 10 - Library completion, runtime polish, self-hosting

> Most of Phase 10 has landed. This doc tracks what's *left* — the
> per-sub-phase landings are in [plans/completed/](../completed/).

## Already landed

- **10.A** - Generic enums (`Option<T>`, `Result<T, E>`, `IterStep<T>`).
  See [phase-10-a-generic-enums.md](../completed/phase-10-a-generic-enums.md).
- **10.B** - `Iterable<T>` trait + `for x in EXPR` over user types.
  See [phase-10-b-iterable.md](../completed/phase-10-b-iterable.md).
- **10.C** - `std/collections/`: `Option`, `StringMap`.
  See [phase-10-c-collections.md](../completed/phase-10-c-collections.md).
- **10.C.2** - Generic `Map<K, V>` with `KeyOps<K>`.
  See [phase-10-c-2-generic-map.md](../completed/phase-10-c-2-generic-map.md).
- **10.C.3** - `Set<K>`, `Deque<T>`, `map_iter`, more KeyOps.
  See [phase-10-c-3-collections-rest.md](../completed/phase-10-c-3-collections-rest.md).
- **10.D** - `std/debug` (`panic`/`unreachable`/`assert`) + `std/log`.
  See [phase-10-d-debug-log.md](../completed/phase-10-d-debug-log.md).
- **10.E** - Cross-shape `?` via `Into<T>`.
  See [phase-10-e-cross-shape-qmark.md](../completed/phase-10-e-cross-shape-qmark.md).
- **10.F.1** - Deadlines (`wait_until(h, deadline_ns)`).
  See [phase-10-f-1-deadlines.md](../completed/phase-10-f-1-deadlines.md).
- **10.F.2.A** - External cancellation (`cancel(h)` + `WaitResult.Cancelled`).
  See [phase-10-f-2-a-external-cancel.md](../completed/phase-10-f-2-a-external-cancel.md).
- **10.H** - Per-binding alloca uniqueness in codegen.
  See [phase-10-h-alloca-uniqueness.md](../completed/phase-10-h-alloca-uniqueness.md).
- **10.I** - Networking polish (`Reader`/`Writer` vtables, `Router`,
  `Client`, `std/net/uri`).
  See [phase-10-i-networking-polish.md](../completed/phase-10-i-networking-polish.md).
- **10.X** - Fallible-struct retirement (Phase 2 convention removed;
  `std/` on `Result<T, E>`).
  See [phase-10-x-cleansing.md](../completed/phase-10-x-cleansing.md).
- **10.X.2** - Function-pointer-field lifts (func-decl to FPT +
  indirect call).
  See [phase-10-x2-fn-ptr-fields.md](../completed/phase-10-x2-fn-ptr-fields.md).

## Still open

### 10.F.2.b - In-body cancellation polling

The external half of cancellation landed in 10.F.2.A. The cooperative
in-body half is still open: a `cancellation: ref Cancel` parameter
implicitly synthesized on task bodies + a `cancellation_requested(ref c)`
predicate the task polls. Needs a synthesized task-body parameter +
an identifier-resolution special case.

### 10.F.3 - Multiplexer-integrated timers

The 10.F.1 deadline path eliminated the 25ms safety poll by trusting
the broadcast wake. A `timerfd` / `EVFILT_TIMER` integration would
share one I/O thread across `sleep_ms` and any deadline-driven
primitive but is no longer urgent for bench correctness. Drop in
when a real consumer (rate limiter, scheduled task) emerges.

### 10.H rest - Codegen quality + diagnostics

The alloca-uniqueness slice landed. Open items:

- **Pattern-binding diagnostics.** Emit a yoop-level error pointing
  at colliding binding sites instead of relying on the LLVM message.
- **Better parse-error messages.** Several `// todo better error
  messages` markers in
  [src/jsyooparser/parser.test.js](../../src/jsyooparser/parser.test.js).
  Most are one-line fix-it strings.
- **`SWITCH_STATEMENT` + `break`/`continue` in propagates-path-coverage
  merge.** Named in [CLAUDE.md](../../CLAUDE.md) cross-cutting invariants
  as the known gap in the Phase 6.4 sat-state intersection.
- **Array bounds checking** as a `YOOP_BOUNDS_CHECK=1` codegen opt-in
  ([phase-4-refs-arrays-control-flow.md](../completed/phase-4-refs-arrays-control-flow.md)
  defers it). Useful once the self-hosted compiler exists and can use
  it to catch its own bugs.

### 10.I follow-ups (networking)

Per [phase-10-i-networking-polish.md](../completed/phase-10-i-networking-polish.md):

- **Streaming bodies inside `Request.body`.** Switch from `body:
  uint8[]` to `body: Reader` so handlers stream large bodies. The
  `Reader` vtable is already in - needs careful disposal semantics +
  a parser flip from "buffer the whole body in `serve_n`" to "hand
  the Reader to the handler".
- **Connection pooling + keep-alive + pipelining.** Per-host
  `Deque<TcpStream>` pool keyed on `(scheme, host, port)`. Pipelining
  gated behind a config flag.
- **TLS.** OpenSSL or BoringSSL binding; `TlsStream implements
  (Readable, Writable, Disposable)`. Stays gated until a real
  consumer emerges.
- **IPv6 connect path.** The URI parser handles bracketed authority;
  `tcp_connect` still goes through `inet_addr` (IPv4-only). Needs a
  `sockaddr_in6` mirror + AF_INET6 branch in
  [std/net/socket_ffi.yoop](../../std/net/socket_ffi.yoop).
- **Trie-style path matching** in `Router`. Exact match was enough
  for the demo; parametric routes (`/user/:id`) need a path-parameter
  story.
- **`http_post` + body-typed convenience wrappers.** `client_send` is
  generic over method; the GET wrapper exists, POST is a one-liner.

### 10.J - Compiler optimization passes

The first half of the original Phase 10 charter from
[plans/roadmap.md](roadmap.md). The self-hosted compiler is the
worst-case workload for the codegen path, so these become worthwhile
once 10.K is in flight.

- **Const folding.** A single mid-typecheck pass that replaces
  literal-arithmetic subtrees with their values. Note: per
  [phase-11-a-precompile-attribute.md](../completed/phase-11-a-precompile-attribute.md)
  (and related work) some of this already lives in the
  `@precompile` attribute path; the unconditional general-purpose
  pass is still open.
- **Dead-store elimination + load forwarding** at the basic-block
  level. Without these the trivial `let x = y; use(x);` shape emits
  an alloca + store + load triplet.
- **Inlining of small trait method calls.** Generics already
  monomorphize; the resulting LLVM IR has redundant function-call
  boundaries that `clang -O1` already handles - verify before adding
  yoop-side inlining.
- **`libyoop_runtime.a` pre-build.** Today every translation unit
  re-compiles `runtime/yoop_runtime.c`. Build it once as
  `libyoop_runtime.a`, link against that, skip the per-program clang
  recompile.

### 10.K - Self-hosting bootstrap

The second half of the original Phase 10 charter. Rewrite the JS
bootstrap, file-by-file, in yoop. Lexer first (smallest surface),
then parser, then typechecker, then codegen. The JS bootstrap
compiles the yoop version; the yoop version compiles itself; the
result must be byte-identical with the next stage (the classic
bootstrap fixed-point check).

Pre-requirements (all landed): 10.A, 10.B, 10.C, 10.D, 10.H.
Optional-but-desirable: 10.J for compile speed.

First acid test: compile [examples/pass/](../../examples/pass/) bit-for-bit
identically to the JS bootstrap. Discrepancies are bugs in the yoop
version.

## Out of scope here (and why)

Same as the original Phase 10 list - these come up in adjacent
discussions but do **not** land in Phase 10:

- **Classes, inheritance, methods on bare types.** SPEC §16.
  Permanently no - traits + free functions cover the design space.
- **Garbage collection.** SPEC §16. The kind system (`mustCall`,
  `mustNotEscape`, `dispose`) is the lifetime story.
- **Closures with captures.** Library-design §8 q3 defers
  indefinitely; the vtable + hand-rolled-capture-struct workaround
  remains official.
- **`match` as an expression.** Phase 7.5 deferred.
- **Range patterns / `|` patterns / guards in `switch` arms.** Phase
  7.5 deferred.
- **HTTP/2, HTTP/3, QUIC.** Phase 11+.
- **Windows IOCP backend.** CI matrix is Linux + macOS.
- **Bit-fields, anonymous inline unions in structs.** Phase 8.B
  deferred. FFI niche; revisit when a real binding needs them.
- **A package manager.** SPEC §16. Relative-path imports + the Phase
  9.C `std/` root cover the design space.

## What lands next

Priority by DX:

1. **10.K (self-hosting)** is the point of every prior phase. Start
   with the lexer port - smallest surface, no recursive types, easy
   to fixed-point check.
2. **10.J (optimization)** lands in parallel as the self-hosted
   workload hits the codegen path.
3. **10.I follow-ups (streaming bodies, pooling)** - when a real
   consumer turns up.
4. **10.H rest (diagnostics, bounds checking)** - opportunistic; ship
   when something else surfaces the gap.
5. **10.F.2.b, 10.F.3** - cancellation polling + multiplexer timers
   are nice-to-have; no forcing function yet.
