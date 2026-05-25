# Phase 10.D - `std/debug` + `std/log` ✓ landed

> Two tiny modules + a runtime helper. `std/debug` exposes
> `panic`/`unreachable`/`assert`; `std/log` exposes `info`/`warn`/`error`.
> Each delegates to a C helper in `runtime/yoop_debug.c` that does the
> stderr formatting and (for panic/unreachable) the `exit(1)`.

## What landed

### Runtime helper

[runtime/yoop_debug.c](../../runtime/yoop_debug.c) - five C functions:

- `yoop_panic(msg)` - `fflush(stdout)` (so buffered prior output
  appears in order), `fprintf(stderr, "panic: %s\n", msg)`, `exit(1)`.
- `yoop_unreachable(msg)` - same shape with the `unreachable:` prefix.
- `yoop_log_info(msg)` / `yoop_log_warn(msg)` / `yoop_log_error(msg)`
  - `fprintf(stderr, "[level] %s\n", msg)`, no exit.

Wired into [src/runtimeBuild.js](../../src/runtimeBuild.js) so the
e2e harness and the production `yoopiler.js` driver link it into
every program. The translation unit is independent of the other
runtime sources; programs that don't use debug/log still pay only
the link-time symbol cost of a few small fns.

### yoop side

- [std/debug.yoop](../../std/debug.yoop) - exports
  `panic(msg: string): void`, `unreachable(msg: string): void`,
  `assert(cond: bool, msg: string): void`. Each is a one-line wrapper
  around the C helper; `assert` adds the `if (!cond)` guard.
- [std/log.yoop](../../std/log.yoop) - exports
  `info(msg: string): void`, `warn(msg: string): void`,
  `error(msg: string): void`.

Both modules compose naturally with Phase 9.F's Display-in-template
support: `panic(`bad state: ${ctx}`)` and `info(`served ${n} reqs`)`
read the way they should.

### e2e infrastructure

[src/e2e.test.js](../../src/e2e.test.js) `runFixtureEntry` now
returns `{ stdout, stderr, exitCode, binPath }` (was `{ stdout,
exitCode, binPath }`). All existing entries that only destructured
`stdout` / `exitCode` keep working. The new field lets the panic
fixture assert on both streams + the exit code.

## Verification

- [examples/pass/debug_smoke.yoop](../../examples/pass/debug_smoke.yoop)
  - `assert(true, ...)` is a no-op; normal-path codegen is unaffected.
- [examples/pass/log_smoke.yoop](../../examples/pass/log_smoke.yoop)
  - three log levels write to stderr; an interleaved stdout printf
  confirms streams don't interfere.
- [examples/pass/panic_smoke.yoop](../../examples/pass/panic_smoke.yoop)
  - `panic("intentional")` after a buffered stdout printf. Asserts
  exit code 1, exact stderr line, and that the pre-panic stdout
  appears (proving the `fflush(stdout)` ordering).
- Full suite green: **556 tests**.

## Deferred

- **Release-mode `assert` gating.** A `YOOP_RELEASE=1` env switch at
  codegen time would erase `assert(...)` calls entirely (no eval, no
  call). Today `assert` always evaluates. The codegen point would
  recognize the trait-call symbol or a synthetic `@assert` marker.
  Not a forcing function; ships when there's a real "release build"
  story.
- **`std/log` JSON sink + alternate destinations.** Today the sink is
  hardcoded to stderr. A `YOOP_LOG_SINK=file:/path` or
  `YOOP_LOG_SINK=tcp:host:port` env var plus a `--structured`
  runtime flag for JSON output were both called out in the 10.D plan
  as follow-ups.
- **`Logger` trait.** A trait abstracting the sink, so library code
  can take `ref l: Logger` instead of writing to a fixed stderr. Falls
  out naturally once the alternate-destination story exists.
- **String concat for richer diagnostics.** `panic(`expected ${want}
  got ${got}`)` works for primitive `want`/`got` (template literals
  inline format specs) and for any `Display` type (Phase 9.F). But
  `${`prefix ${inner}`}` (nested templates) and full sprintf-style
  composition are still hand-rolled. `std/core`'s `string_concat` is
  the workaround for now.

## Critical files touched

- [runtime/yoop_debug.c](../../runtime/yoop_debug.c) - new.
- [src/runtimeBuild.js](../../src/runtimeBuild.js) - list extended.
- [std/debug.yoop](../../std/debug.yoop),
  [std/log.yoop](../../std/log.yoop) - new modules.
- [examples/pass/debug_smoke.yoop](../../examples/pass/debug_smoke.yoop),
  [examples/pass/log_smoke.yoop](../../examples/pass/log_smoke.yoop),
  [examples/pass/panic_smoke.yoop](../../examples/pass/panic_smoke.yoop)
  - fixtures.
- [src/e2e.test.js](../../src/e2e.test.js) - three new entries +
  `runFixtureEntry` returns `stderr`.
