# Phase 8.D - `errno` access + syscall result conventions

## Context

Phases 8.A/B/C let yoop describe pointers, C-portable integer types, and
buffer interop - enough for an extern declaration of any syscall. The last
missing piece for the FFI surface is `errno`: most libc functions
(`open`, `read`, `write`, `recv`, `send`, `socket`, `bind`, `listen`,
`accept`, `connect`, `clock_gettime`, …) signal failure with a sentinel
return (`-1` or `NULL`) and leave the actual reason in `errno`.

Yoop has no way to read `errno` today. This phase adds three intrinsics:

```yoop
errno.get(): c_int            // read the current thread's errno
errno.set(v: c_int): void     // clear or stash a value
errno.message(c: c_int): string  // strerror wrapper, returns a libc-owned cstring
```

The intrinsic surface is identical in shape to the Phase 8.A
`unsafe_ptr.cast<U>(...)` family - three named operations under a single
namespace identifier - so the parser reuses the same recognition pattern.

### Why a runtime helper instead of direct platform symbols

`errno` is thread-local. The portable mechanism is a per-platform helper
function:

- macOS / iOS: `int* __error(void)`
- glibc + musl: `int* __errno_location(void)`
- Windows MSVCRT: `int* _errno(void)`

Yoop's codegen does not yet have target-triple awareness - it emits IR with
the platform-default triple at link time. Picking the platform symbol at IR
emission time would require introducing that awareness early, which is more
work than the syscall use case demands.

Instead, this phase adds three C helpers to the existing
[runtime/yoop_runtime.c](../runtime/yoop_runtime.c) and declares them in
codegen as ordinary runtime symbols (the same way `yoop_task_submit` etc.
are wired). The C compiler picks the right `errno` lvalue per-platform - no
yoop-side platform branching needed.

```c
int  yoop_errno_get(void);          // returns errno
void yoop_errno_set(int v);         // errno = v
const char* yoop_errno_message(int c);  // strerror(c)
```

`strerror` is technically not thread-safe (return value is process-shared
static storage), but the call shape is the one C programmers expect and
the realistic use case is "format an error message right before logging,"
where the race is benign. `strerror_r` has POSIX vs. glibc signature
divergence and is deferred - if a real concurrency hazard appears, we can
switch the runtime helper internally without changing the yoop-side
intrinsic signature.

### Suspension safety (forward-looking)

`errno` is thread-local. With the current run-to-completion runtime, tasks
do not yield mid-syscall, so `errno` survives intact between any FFI call
and a subsequent `errno.get()` in the same yoop function. **When Phase 8.F
lands real Task suspension**, the suspend point must read+save `errno`
into the Task's saved-state struct before yielding, and restore it on
resume. That's a Phase 8.F concern, but documented here so the contract is
in writing.

### Recommended fallible-wrapping pattern

The yoop convention is: extern signatures return their raw C result type;
user-facing wrappers convert `(rv == -1) + errno` into the
fallible-struct convention (`{ value: T, err: string }` + `?`).

```yoop
extern "C" from "fcntl.h" {
    function open(path: string, flags: c_int): c_int;
}

type OpenResult { fd: c_int, err: string }

function open_safe(path: string, flags: c_int): OpenResult {
    let fd: c_int = open(path, flags);
    if (fd < 0) {
        let code: c_int = errno.get();
        return { fd: -1, err: errno.message(code) };
    }
    return { fd: fd, err: "" };
}
```

The `?` operator can then short-circuit `open_safe(...)?` from a caller
that propagates `err`. No new typechecker plumbing is needed - `errno` is
just three intrinsic calls.

## Sub-phases

### 8.D.0 - SPEC

Extend [SPEC.md](../SPEC.md) §12 with a "errno" subsection documenting the
three intrinsics, the thread-local semantics, and the recommended
fallible-wrapping pattern.

Add `errno` to the §14 reserved-keyword list.

### 8.D.1 - Runtime

Add to [runtime/yoop_runtime.h](../runtime/yoop_runtime.h):

```c
int yoop_errno_get(void);
void yoop_errno_set(int v);
const char* yoop_errno_message(int c);
```

Implement in [runtime/yoop_runtime.c](../runtime/yoop_runtime.c) using
`<errno.h>` + `<string.h>`. Trivial.

### 8.D.2 - Parser

[parser.js](../src/jsyooparser/parser.js) - extend the existing
`unsafe_ptr.*` intrinsic recognizer site so it also matches the literal
sequence `errno . get|set|message ( ... )`. Produces a new AST node
`ERRNO_INTRINSIC { op: "get"|"set"|"message", operand: Expr|null }`.

New AST kind `ERRNO_INTRINSIC` in [contracts.js](../src/contracts.js).

### 8.D.3 - Typecheck

[checkExpr.js](../src/jsyooptypecheck/checkExpr.js) - dispatch for
`ERRNO_INTRINSIC`:

- `get`: 0 args, returns `c_int` (i.e. `PrimType("int32")`).
- `set`: 1 arg, must be int (typed or untyped); pin untyped to `int32`;
  returns `void` (so `errno.set(0)` is a statement-level call).
- `message`: 1 arg, must be int (typed or untyped); pin untyped to
  `int32`; returns `string`.

Gating: not gated by `import.unsafe;` - calling `errno.get()` doesn't
produce any pointer surface and is a peer of `extern "C"`-without-pointers
calls, which are already allowed without the unsafe opt-in.

### 8.D.4 - Codegen

Add three declarations to `RUNTIME_DECLARES` in
[codegen.js](../src/jsyoopcodegen/codegen.js):

```text
declare i32 @yoop_errno_get()
declare void @yoop_errno_set(i32)
declare ptr @yoop_errno_message(i32)
```

Emit `ERRNO_INTRINSIC` in both single- and multi-module paths:

- `get` → `call i32 @yoop_errno_get()`, return `int32`.
- `set` → `call void @yoop_errno_set(i32 %v)`, return void.
- `message` → `call ptr @yoop_errno_message(i32 %c)`, return `string`.

### 8.D.5 - Demo

`examples/pass/errno_open.yoop`:

- `extern "C" function open(path: string, flags: c_int): c_int;` (and
  `close`).
- Call `open("/no/such/file", 0)`. Expect `-1`.
- `errno.get()` should be `ENOENT` (`2` on Linux, `2` on macOS).
- Print `errno.message(code)` - verify the literal contains "No such
  file" via a substring check at the test level.

A second fixture exercises `errno.set(0); errno.get();` to verify the set
path round-trips.

### 8.D.6 - Verification

Unit tests colocated where the dispatch landed. e2e fixture wired into
[src/e2e.test.js](../src/e2e.test.js) - assert the message contains "No
such file" (case-insensitive substring).

## Out of scope

- `errno.clear()` shortcut. Use `errno.set(0)`.
- A `try_libc` higher-order combinator. The fallible-wrapping pattern is
  documented; user code writes the wrapper.
- Errno-aware Task suspension. Deferred to Phase 8.F.
- A typed errno enum (`ENOENT`, `EACCES`, …). Adds value but is a stdlib
  concern, not a language concern.
- `strerror_r` thread-safety. Punt until concurrency exposes the race.

## Files touched

- [SPEC.md](../SPEC.md) - §12 errno subsection, §14 keyword list.
- [runtime/yoop_runtime.h](../runtime/yoop_runtime.h) + [.c](../runtime/yoop_runtime.c) - three new helpers.
- [src/contracts.js](../src/contracts.js) - `ERRNO_INTRINSIC` AST kind.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) - `errno.*` recognizer.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) - dispatcher case.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) - RUNTIME_DECLARES + emit.
- `examples/pass/errno_open.yoop`, `examples/pass/errno_set_get.yoop` - fixtures.
- [src/e2e.test.js](../src/e2e.test.js) - wiring.
