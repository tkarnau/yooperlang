# Phase 8 - Networking Prerequisites: Language & Runtime Primitives for HTTP

> Phase 7 has now finished landing the language-design pieces this plan depends on: 7.2 (trait bounds), 7.3 (literal `switch`), 7.4 (trait-qualified call syntax), and 7.5 (`enum` tagged unions, C-style `union`, variant patterns + exhaustiveness). Phase 8 absorbs the deferred Phase 6 `unsafe_ptr` work into Phase 8.A.

## Context

We want to build a standard networking library (HTTP client + async HTTP server) in Yooperlang. This document does **not** design the HTTP library. It enumerates the language and runtime primitives that must land first, given two design choices:

- **FFI strategy: add real language primitives** (raw pointers, C-ABI structs, errno) rather than hiding the syscall surface behind a thin C shim in `runtime/`. Goal: the networking library is pure-yoop on top of libc.
- **Server model: event-loop / async I/O.** This blocks on real `Task<T>` suspension landing (currently the runtime is run-to-completion; LLVM coroutine IR shape is in place but bodies are empty).

What already exists and is reusable (do not redesign):

- `extern "C" from "..."` FFI blocks, including variadics and `library "..."` link flags ([src/jsyooparser/parser.js:1160](../src/jsyooparser/parser.js#L1160), [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js)).
- `uint8[]` fat-pointer arrays (data + len) and immutable UTF-8 `string`.
- Fallible-struct convention with `err: string` and the `?` operator ([src/jsyooptypecheck/fallible.js](../src/jsyooptypecheck/fallible.js)).
- Pthread-based worker pool in [runtime/yoop_runtime.c](../runtime/yoop_runtime.c) and the `Task<T>` builtin type with run-to-completion semantics.
- `layout { align N; }` clause for forcing struct alignment ([plans/phase-6-5-layout-composition.md](phase-6-5-layout-composition.md)).
- **Tagged `enum` types, untagged `union` types, and `switch` with literal + variant patterns + exhaustiveness checking** (Phase 7.5 - [plans/phase-7-5-sum-types-and-unions.md](phase-7-5-sum-types-and-unions.md)). `union` is a first-class top-level decl: every field starts at offset 0, total size = max field size, total alignment = max field alignment. Sufficient to express `sockaddr_in` / `sockaddr_in6` / `sockaddr_storage`-shaped overlap directly.
- Generics (Phase 7.1), trait bounds (Phase 7.2), and trait-qualified call syntax `Trait.method(ref x, ...)` (Phase 7.4).

What is missing or under-specified (this plan addresses):

1. `unsafe_ptr` is reserved in [SPEC.md](../SPEC.md) §12 but has no operational spec - no arithmetic, deref, address-of, casts, nullability rules.
2. `layout` clause is **alignment-only** - no field-order guarantee, no packing, no padding control. Insufficient for `sockaddr_in`-style structs whose ABI is pinned by libc.
3. No `c_int` / `c_size_t` / `c_ssize_t` / `c_long` portable aliases - extern signatures cannot match the platform-dependent widths of syscall signatures.
4. No way to get the raw data pointer out of a `uint8[]`, nor to construct one from `(ptr, len)` - blocks passing buffers to `read` / `recv` / `send` / `write`.
5. No `errno` access - most socket syscalls report failure via `errno`.
6. No module-level mutable state. An event loop wants a process-singleton.
7. No array slice syntax (`xs[i..j]` reserved but unimplemented).
8. `Task<T>` cannot actually suspend - coroutine bodies are empty.
9. No I/O multiplexer in the runtime (no epoll/kqueue/IOCP integration with the scheduler).
10. No timers exposed to user code.
11. No `task` / `wait` language surface yet (Phase 6.3 sugar planned, not landed).
12. No anonymous-union fields *inside* structs. Standalone `union` exists (Phase 7.5); the sockaddr family can use that. Inline anonymous unions remain a follow-up - see [phase-7-5-sum-types-and-unions.md](phase-7-5-sum-types-and-unions.md).

## Recommended approach

Land the prerequisites in the order below. Each subsection is intended to become its own self-contained phase document (e.g. `plans/phase-8-a-unsafe-ptr.md`) when its turn comes - this file is the index and design overview. **No HTTP code is scoped here.**

### Phase 8.A - `unsafe_ptr` operational spec (formerly "Phase 6 deferred")

Promotes `unsafe_ptr` from a reserved kind to a real type with operations. Required by every subsequent phase that touches libc buffers or pointer-bearing C structs.

Spec additions to [SPEC.md](../SPEC.md):

- Type form: `unsafe_ptr<T>` (replacing the kind-on-ref reservation; cleaner and matches `ref T`).
- Address-of operator: pick a sigil (`&x` is the obvious one - currently free since yoop has no bitwise-and on bools and `&` is the kind-composition operator inside `layout`/kind clauses only; confirm grammar collision).
- Deref: `*p` for read, `*p = v` for write.
- Arithmetic: `p + n`, `p - n`, `p - q` (returns `int64`); strides by `sizeof(T)`.
- Casts: `unsafe_ptr<T>` ↔ `unsafe_ptr<U>`, `unsafe_ptr<T>` ↔ `uintptr` (new fixed-width integer alias for the platform pointer width).
- Nullability: `unsafe_ptr<T>` is nullable; literal `null`; compares with `==` / `!=`.
- Gating: requires `import.unsafe;` at module top (already reserved in spec § 12). Without it, all `unsafe_ptr` uses are typecheck errors.
- Interaction with `ref T`: `&x` on a `ref T` binding produces `unsafe_ptr<T>`. Going the other way (`unsafe_ptr<T>` → `ref T`) is an explicit cast and a soundness escape hatch, only legal inside `import.unsafe;` modules.

Files touched: spec, lexer (new tokens if needed), parser (new expression forms and the type-annotation form), typechecker (new `UnsafePtrType` in [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js); rules in [checkExpr.js](../src/jsyooptypecheck/checkExpr.js) and [coerce.js](../src/jsyooptypecheck/coerce.js)), codegen ([src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) - LLVM `ptr`, `getelementptr` for arithmetic, `ptrtoint` / `inttoptr` for casts).

### Phase 8.B - C-ABI struct layout & C-portable integer aliases

Extends the `layout` clause from alignment-only to full C-ABI control, and introduces the platform-width integer aliases needed for syscall signatures.

- `layout { abi "C"; }` - opt-in marker forcing field order preservation and C-padding rules.
- `layout { pack N; }` - optional packing for unusual headers (not strictly needed for sockets; nice to have).
- Built-in type aliases: `c_int`, `c_uint`, `c_long`, `c_ulong`, `c_size_t` (= `usize`), `c_ssize_t`, `c_short`, `c_ushort`. Width resolved at codegen time from a target-triple table (Linux / macOS / Windows × 32 / 64).
- Document the rule that an `extern "C"` function signature must use only C-portable integer aliases or `unsafe_ptr<T>` - fixed-width yoop ints (`int32`, `int64`) are still accepted where they happen to match, but the canonical form uses the aliases.

Files touched: spec, parser ([parser.js:1160](../src/jsyooparser/parser.js#L1160) extern blocks; layout clause), typechecker ([types.js](../src/jsyooptypecheck/types.js) for new `PrimType` instances or a `CIntType` family), codegen (target-triple-aware width resolution).

The `sockaddr_in` / `sockaddr_in6` overlap is now expressible as a real `union` (Phase 7.5 landed) - declare `union SockAddrStorage { v4: sockaddr_in, v6: sockaddr_in6, raw: uint8 }` and the layout rules (size = max, align = max, offset-0 fields) match the C semantics directly. No `unsafe_ptr<uint8>` ↔ `unsafe_ptr<sockaddr_in>` reinterpret cast needed for that case. Inline *anonymous* unions inside a struct remain unsupported and stay deferred - workaround is the standalone union.

### Phase 8.C - Buffer interop intrinsics

The minimal surface to pass yoop-owned bytes across FFI.

- `xs.ptr: unsafe_ptr<T>` - intrinsic field, returns the data pointer of an array.
- `uint8[].from_raw(p: unsafe_ptr<uint8>, len: c_size_t): uint8[]` - constructs a borrowing view (no copy, no ownership). Document the lifetime hazard (caller is responsible - only legal in `import.unsafe;`).
- `arr[i..j]` slice syntax (lift the Phase 4 deferral). Backed by fat-pointer subview; no allocation.
- A mutable byte buffer story: confirm whether `uint8[]` can be allocated mutable today; if not, add `uint8[].alloc(n: c_size_t): uint8[]` and `.free()` (or tie it to a kind, e.g. a `disposable` kind on the buffer). Needed for read buffers in a server.

Files touched: spec, parser (slice grammar), typechecker (intrinsic resolution in [checkExpr.js](../src/jsyooptypecheck/checkExpr.js)), codegen (fat-pointer field extract for `.ptr`, GEP for slices).

### Phase 8.D - `errno` and syscall result conventions

- Expose `errno` as a thread-local intrinsic: `errno.get(): c_int`, `errno.set(v: c_int)`, plus `errno.message(c: c_int): string` (wraps `strerror_r`).
- Document the recommended pattern: extern fns return their raw C result type; user-facing wrappers convert `(rv == -1)` + `errno` into the fallible-struct convention (`err: string`).
- Confirm that calling FFI from a Task thread does not corrupt `errno` between resumptions (errno is thread-local; with the current run-to-completion runtime this is fine; once Phase 8.F lands, the suspension boundary must read/save `errno` before yielding).

Files touched: typechecker (intrinsic registration), codegen (TLS access for `errno` - platform-dependent, on glibc it's `__errno_location()`, on macOS `__error()`, on Windows `_errno()`).

### Phase 8.E - Module-level mutable state

Required so the event loop and any global registries are expressible.

- Permit `let` at module top with explicit init expression. Visibility defaults to module-private; `export let` for cross-module access (probably restrict initially to `import.unsafe;` modules to keep the surface small).
- Initialization order: same topological order as imports (already computed by [src/jsyoopdriver/moduleGraph.js](../src/jsyoopdriver/moduleGraph.js)). Document that cycles forbid mutually-dependent top-level `let` initializers.
- Codegen: LLVM `@global` with a runtime-init function called once from `main` after `yoop_runtime_init()` and before user code.

Files touched: parser (top-level `let`), typechecker (module symbol table - currently rejects `let` at top), codegen (global emission + init sequencing).

### Phase 8.F - Real `Task<T>` suspension and the I/O multiplexer

The big one. Splits naturally into F1 (scheduler) and F2 (multiplexer); they can land in the same phase document but in two stages.

**F1 - Suspension:**

- Fill in the LLVM coroutine bodies that are currently empty shells (per `Phase 6.3-prelude`).
- Add a suspend point in the scheduler: tasks yield to the worker pool's run queue when they block on a wake-condition.
- Surface the `task` / `wait` keywords (the Phase 6.3 sugar that is still planned). Bind kinds `joined` / `pooled` per the existing design.
- Cancellation: define propagation rules for parent-task cancellation. Even an MVP needs a "cancel" wake-up reason, otherwise a closed server socket leaves accepters stuck.

**F2 - Multiplexer:**

- New runtime subsystem in [runtime/](../runtime/): `yoop_io.c` exposing platform-agnostic `yoop_io_wait_readable(fd)` / `wait_writable(fd)` / `wait_timeout(ns)` calls.
- Platform impls: `epoll` on Linux, `kqueue` on macOS/BSD, `IOCP` on Windows.
- Each call suspends the caller's Task and registers (fd, interest, task-wake-handle) with the multiplexer; one dedicated thread (or a worker rotating into the role) drives the poll loop and re-enqueues ready tasks.
- Document the integration with the pthread worker pool (queue semantics, wakeup races, errno preservation across suspension - see Phase 8.D).

**F3 - Timers:**

- `yoop_sleep(ns: c_size_t)` and `yoop_deadline(ns)` exposed to user code, implemented via `timerfd` / `EVFILT_TIMER` / IOCP timer queues.

This is the largest of the prerequisite phases by a wide margin and likely needs its own design document with cross-platform implementation notes - list it here, write it separately.

Files touched: [runtime/yoop_runtime.c](../runtime/yoop_runtime.c), new `runtime/yoop_io.c`, [src/runtimeBuild.js](../src/runtimeBuild.js) (new link flags per-platform), codegen (coroutine body emission for Task suspension), parser/typechecker for the `task` / `wait` surface.

### Phase 8.G (optional, can defer) - Signal handling

`SIGPIPE` will kill any socket-writing process by default. Either set `SO_NOSIGPIPE` per-socket in the user-space library (no language change needed), or install `signal(SIGPIPE, SIG_IGN)` in `yoop_runtime_init()`. Recommend the runtime do this once at init - it's a hidden footgun otherwise. `SIGINT` graceful shutdown is a server-library concern, not a language one.

## Critical files (existing)

- [SPEC.md](../SPEC.md) - `unsafe_ptr` reservation at lines 885–890; `import.unsafe;` at § 12; `let` / `const` distinction at § 217.
- [src/jsyooparser/parser.js:1160](../src/jsyooparser/parser.js#L1160) - `extern "C"` blocks; touched by Phase 8.B.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) - adds `UnsafePtrType` (Phase 8.A), C-int alias family (Phase 8.B).
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) - new operators (Phase 8.A), intrinsics (Phase 8.C, 8.D).
- [src/jsyooptypecheck/coerce.js](../src/jsyooptypecheck/coerce.js) - ptr/int cast rules (Phase 8.A).
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) - pointer ops, target-triple width resolution, coroutine bodies, global init sequencing.
- [runtime/yoop_runtime.c](../runtime/yoop_runtime.c) - scheduler suspension hooks (Phase 8.F1).
- new `runtime/yoop_io.c` - multiplexer (Phase 8.F2).
- [src/runtimeBuild.js](../src/runtimeBuild.js) - platform link flags for the multiplexer.

## Out of scope here

- The networking library itself (socket wrappers, HTTP/1.1 parser, router, TLS).
- A pure-sync HTTP client variant (would be possible after Phases 8.A–8.E without 8.F, but the design chose async-first).
- Anonymous inline unions inside structs. Standalone `union` decls (Phase 7.5) cover the sockaddr family; nested anonymous unions are a follow-up.
- Pattern matching's interaction with raw pointers - `switch` exhaustiveness (Phase 7.5) is defined for `bool`, integer literal sets, and `enum` variants only. `unsafe_ptr<T>` does not participate.

## Verification (for each phase, when implemented)

Per existing project conventions in [CLAUDE.md](../CLAUDE.md):

- Unit tests colocated as `<file>.test.js` alongside parser/typechecker/codegen changes.
- An e2e fixture in [src/e2e.test.js](../src/e2e.test.js) per phase, e.g.:
  - Phase 8.A: an `examples/pass/unsafe_ptr_basic/` that allocates, pointer-arithmetics, derefs, and frees via libc `malloc` / `free`.
  - Phase 8.B: a fixture that declares `struct timespec` and calls `clock_gettime` from yoop.
  - Phase 8.C: round-trip `uint8[]` ↔ `unsafe_ptr<uint8>` via `memcpy`.
  - Phase 8.D: a fixture that calls `open` with a bogus path and checks the resulting `errno` matches `ENOENT`.
  - Phase 8.E: two modules sharing a top-level `let counter: int32 = 0;` with increments observable across modules.
  - Phase 8.F: a fixture that spawns 100 tasks, each `wait`s on a 10ms timer, and asserts total wall-time is ~10ms not ~1000ms (proves real suspension and multiplexer integration).
- For Phase 8.F specifically, run the e2e suite on both macOS (kqueue) and Linux (epoll) before merging; Windows can be a separate follow-up if not in scope yet.

The end-to-end smoke test for the whole stack - once all phases land - is "write a 50-line yoop program that listens on a port, accepts connections, echoes received bytes, and serves 10k concurrent connections with `wrk`." This belongs in the eventual networking-library plan, not here.
