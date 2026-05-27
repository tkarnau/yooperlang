# Plan - Language papercuts surfaced while writing yoopstore

## Context

[examples/playground/yoopstore](../examples/playground/yoopstore) is a
small S3-style file-storage HTTP server split into four modules:

- `safepath.yoop` - validates the request-target before it touches disk
- `storage.yoop` - libc stdio + POSIX mkdir wrappers for read/write/delete
- `handler.yoop` - the `Handler` impl, dispatches per HTTP method
- `main.yoop` - listener + handler wiring

It exercises three things the existing playground demos didn't:

1. Multi-file program structure for an application (not a library)
2. Filesystem I/O against libc stdio
3. A handler that owns a reusable buffer across requests for response bodies

Roughly the same shape as the yoopbinder rollup
([yoopbinder-papercuts.md](yoopbinder-papercuts.md)): individually small,
collectively they doubled the time the program should have taken. Filed
together because they cluster by theme (FFI ergonomics, response-body
lifetime, codegen edge cases) and the next playground program is going to
hit every one of them again.

## Issues

### 1. Codegen miscounts template-literal length when the literal contains an embedded `"` [FIXED]

Was: `encodeStringBytes` in [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js)
only hex-escaped `"` and `\` when they arrived as `\"` / `\\` escape pairs.
Template-literal STRING_PARTs preserve raw bytes between the backticks
(see `parseTemplateLiteralBody`), so a literal `"` reached `encodeStringBytes`
unescaped and was emitted straight into the LLVM `c"..."` constant -
which terminated the literal early and produced a length-mismatched
`[N x i8]` header.

Fixed by adding two `else if` arms to `encodeStringBytes` that hex-escape
raw `"` to `\22` and raw `\` to `\5C`. Regression test in
[src/jsyoopcodegen/codegen.test.js](../src/jsyoopcodegen/codegen.test.js)
covers a `printf(\`... "${x}" ...\`)` shape and asserts every emitted
string-global header agrees with its body's decoded length.

### 2. No standard-library file I/O [LANDED, MVP]

Was: yoopstore had to hand-roll a libc stdio + POSIX mkdir block in
[storage.yoop](../examples/playground/yoopstore/storage.yoop), about
130 lines of FFI boilerplate.

Landed: [std/fs.yoop](../std/fs.yoop) - top-level module exporting
`read_file`, `read_file_into`, `write_file`, `delete_file`, `mkdir_p`,
and `path_join`. yoopstore's `storage.yoop` collapsed to ~25 lines of
one-line forwards (kept as a thin wrapper so the handler stays free of
the `import.unsafe` requirement and so `join_path` can encode the
project-local `<root>/<rel>` convention).

Still open as follow-ups:

- No `exists(path)` / metadata. Needs `stat` + a yoop-side mirror of
  `struct stat`, or a runtime helper. Punted until there's a use site.
- No streaming reads. `read_file` slurps. Once `std/io` factors a
  `Readable` trait out of `std/net`, an fd-backed implementation
  reading in chunks slots in alongside.
- Errno is dropped on the floor (mkdir_p eats "already exists" along
  with "permission denied"). A `last_errno_message()` helper in std
  would let `std/fs` surface the real reason.
- Windows / non-POSIX path conventions are not handled.

### 3. No type for opaque C pointers [LANDED]

Was: `FILE *` and `void *` had no canonical yoop representation.
yoopstore and std/fs declared `fopen` as returning `unsafe_ptr<uint8>`
and never dereferenced the result - the pointee type was a lie that
happened to be safe because the value was only ever handed back to
libc.

Landed: option 1 from the original write-up - bare `unsafe_ptr` (no
`<T>`) is the opaque C-pointer handle. Lowers to LLVM `ptr`, forbids
deref / arithmetic / `toArray`, still rounds through `toInt` /
`fromInt<T>` and accepts an explicit `unsafe_ptr.cast<T>(p)` to recover
a typed pointee. `unsafe_ptr<T>` decays implicitly to opaque (matches
C's `T*` -> `void*`); the reverse direction requires the cast so the
user has to spell out the pointee they're claiming. std/fs's stdio
externs now use bare `unsafe_ptr` for `FILE *`.

Option 2 (`extern "C" type FILE;` phantom types) is partially wired
already (yoopbinder uses it as the pointee of `unsafe_ptr<FILE>`) but
making `ref FILE` work would still need codegen changes around opaque
struct loads. Not worth doing until something more complex than `FILE*`
shows up.

### 4. Vec<T> can't be filled from a raw T[] in one shot [FIXED]

Was: the Vec API exposed `vec_push` / `vec_clear` but no bulk fill, so
`read_file_into` pushed byte-by-byte (O(log n) capacity-doubling
reallocs).

Fixed: [std/core/vec.yoop](../std/core/vec.yoop) now exports
`vec_extend_from<T>(v: ref Vec<T>, src: T[])` (grows the backing buffer
at most once - to exactly `v.len + src.len`, or not at all when the
existing capacity is big enough - then copies) and
`vec_from_array<T>(src: T[]) -> Vec<T> propagates<disposable>` (fresh
Vec copy, cap == len). `std/fs.read_file_into` now slurps into a scratch
buffer and bulk-copies via `vec_extend_from`, allocating once instead
of `log2(n)` times. Fixture:
[examples/pass/vec_extend_from.yoop](../examples/pass/vec_extend_from.yoop)
(asserts net-0 heap under --track-heap).

### 5. Owned uint8[] without a wrapping struct doesn't exist [FIXED]

Was: `uint8[]` is a borrowing view with no ownership, so "return owned
bytes" APIs had to commit to a wrapper type (Vec, or hand-rolled).

Fixed: [std/core/bytes.yoop](../std/core/bytes.yoop) now exports an owned
`Bytes` type - `{ data: uint8[], len: usize }` implementing
`Disposable propagates<disposable>`. `data` keeps the full allocation's
fat-pointer length (so heap_free / --track-heap stay paired with the
original heap_alloc) and `len` is the valid-byte count, which may be
< data.len when the buffer was handed over from a Vec with spare
capacity. Surface:

- `bytes_to_array(ref b) -> uint8[]` - borrowing view of the valid prefix
- `bytes_from_array(src) -> Bytes` - copy into a fresh owned allocation
- `bytes_from_raw(buf, len) -> Bytes` - zero-copy take of a heap_alloc'd buffer
- `bytes_from_vec(ref v) -> Bytes` - zero-copy seal of a Vec's buffer (the
  Vec is emptied, `cap = 0`, so its own dispose becomes a no-op)

`to_array` is spelled `bytes_to_array(ref b)` rather than the
papercut's `to_array(ref self)` - `self` is a method-only keyword, and
std collections use the free-function `<type>_<op>(ref x, ...)` shape
(vec_get, bytes_eq). Fixture:
[examples/pass/bytes_owned.yoop](../examples/pass/bytes_owned.yoop)
(asserts net-0 heap, i.e. the from_vec seal neither double-frees nor
leaks the transferred buffer).

### 6. Handler-owns-the-response-body is implicit and fragile [FIXED]

Was: `Response.body` was a bare `uint8[]` borrowed view whose backing
storage had to outlive the handler return - a lifetime contract that
lived only in a comment. yoopstore worked around it by stashing a
reusable `Vec<uint8>` on the handler; a first-time implementer would
just as easily heap_alloc inside the handler, free at scope end, and
hand back a view into freed memory.

Fixed: `Response.body` is now an owning `ResponseBody` variant in
[std/http/types.yoop](../std/http/types.yoop):

- `Static { text: string }` - a borrowed static string (literals,
  handler fields, template-literal results). String storage is never
  freed by yoop, so these never dangle and there's no copy.
- `Owned { bytes: Bytes }` - heap-owned bytes (issue #5's `Bytes`),
  disposed when the Response is disposed.

`ResponseBody` and `Response` both implement `Disposable
propagates<disposable>`, so the lifetime contract is now enforced by
the kind system instead of a comment - a handler cannot hand back a
view into a freed local. The blessed surface is two helpers (which
dispose any previous body before overwriting, so re-assignment doesn't
leak):

- `respond_static(ref resp, text)` - borrowed static string, no copy
- `respond_bytes(ref resp, take: Bytes)` - takes ownership of bytes;
  build the arg inline (`respond_bytes(ref resp, bytes_from_array(view))`)
  so no leftover binding holds the obligation

`write_response` reads the body uniformly via `response_body_bytes(ref
resp) -> uint8[]`. Migrated callers: std/http/router.yoop plus the
hello_server / http_router / http_client_loopback / servertest /
yoopstore handlers. yoopstore's GET path now copies the file bytes into
an owned `Bytes` (its `body_buf` Vec stays as a reusable *read* buffer);
verified end-to-end with a PUT/GET/DELETE round-trip and net-0 heap on
the owned path.

This also unblocks a per-connection task-per-request server: the body
travels with the Response rather than relying on a single-threaded
handler-owned buffer.

Note: direct `resp.body = ...` field assignment still works but does
NOT dispose a previous owned body, so the helpers (which do) are the
blessed path. Handlers set the body once off the fresh `Static {""}`
from `response_new`, so the leak only bites on manual re-assignment.

### 7. (retracted) `switch default:` does exist

I claimed `switch` had no `default:` arm. It does -
[examples/playground/yooparse/json.yoop](../examples/playground/yooparse/json.yoop)
uses it in `JsonValue.dispose` and yoopstore's handler should too.
The three redundant `Head` / `Patch` / `Options` arms in
[handler.yoop](../examples/playground/yoopstore/handler.yoop) can
collapse to a single `default:` once the playground gets refactored.
Filed here so future me doesn't trip over the same gap.

### 8. No `path.join` / path helpers [PARTIAL]

`std/fs.path_join(parts)` landed alongside the rest of std/fs. The
"build a path from N components" use case is covered.

Still missing: `dirname`, `basename`, `is_absolute`, `normalize`.
These belong in a `std/path` module once there are enough call sites
to justify the split. Today nothing uses them, so they'd be code
without a consumer.

### 9. Namespace import doubles the import line for a one-type-plus-functions module [FIXED]

Was: a module exporting both a type (`Vec`) and value-level functions
(`vec_new`, `vec_push`, ...) had to be imported on two lines - one
named (for the type), one namespace (for the values, per the std
namespace rule).

Fixed: a combined import binds both axes on one line, in either order:

```yoop
import * as vec, { Vec } from "std/core/vec.yoop";
import { Vec }, * as vec from "std/core/vec.yoop"; // equivalent
```

The parser ([parseImportDecl](../src/jsyooparser/parser.js)) accepts a
trailing `, { ... }` after a namespace clause (or a trailing `, * as ns`
after a named clause) and stamps both `namespaceName` and `specifiers`
onto one IMPORT_DECL with `importKind: "combined"`. The resolver
([imports.js](../src/jsyooptypecheck/imports.js)) wires the namespace
when `namespaceName` is present and always runs the specifier loop, so
both clauses take effect. The std-value-import rule still applies to the
named clause (a value in `{ ... }` from a `std/` path is still
rejected), so the combined form is only ergonomic for the legal
type-named + value-namespaced split. Dogfooded in
[examples/playground/yoopstore/handler.yoop](../examples/playground/yoopstore/handler.yoop)
and [std/fs.yoop](../std/fs.yoop); fixture
[examples/pass/imports_combined](../examples/pass/imports_combined).

### 10. POSIX `mkdir` mode constant is hardcoded [FIXED]

Was: std/fs hand-mirrored `const DIR_MODE: c_int = 493;` (0755 decimal)
and passed it to the libc `mkdir` extern.

Fixed: `yoop_io_mkdir(path)` in [runtime/yoop_io.c](../runtime/yoop_io.c)
computes the standard directory mode from the POSIX `S_*` symbols
(`S_IRWXU | S_IRGRP | S_IXGRP | S_IROTH | S_IXOTH`) at C compile time -
the same pattern std/net uses for `SO_REUSEADDR` via yoop_net.c - so the
numeric mode never appears in yoop. std/fs declares it via `extern "C"
from "yoop_runtime"`, drops the `sys/stat.h` mkdir extern and the
`DIR_MODE` constant, and `mkdir_p` calls `yoop_io_mkdir(prefix)`.
Verified: nested `mkdir_p` produces `drwxr-xr-x` directories.

### 11. Returning a struct literal containing a propagating binding loses the transfer mark [FIXED]

Was: surfaced while writing `std/fs.read_file`:

```yoop
export function read_file(path: string): ReadFileResult propagates<disposable> {
    let buf: Vec<uint8> = vec.vec_new(4096);
    let err: string = read_file_into(ref buf, path);
    return { data: buf, error: err };   // <-- typecheck error (was)
}
```

The typechecker rejected this even though the function declared
`propagates<disposable>`: the transfer-via-return path in
[src/jsyooptypecheck/kindCheck.js](../src/jsyooptypecheck/kindCheck.js)
only fired when the return value was a bare `IDENT`. A struct literal
whose fields moved in propagating bindings didn't propagate the
transfer mark down to those bindings, so they showed up as unsatisfied
at scope exit.

Fixed: the `RETURN_STATEMENT` handler now recurses into a returned
struct / variant literal's field values (helper
`markLiteralFieldObligationsTransferred`) and transfers any contained
IDENT obligation for the kind, the same call the bare-IDENT branch
uses. Nested literals recurse; non-IDENT field values (calls, inline
`vec_new(...)`) have no binding to leak and are skipped. The
keyword-wins rule still holds - a field binding that declared the kind
keyword is committed to local cleanup and is not transferred.
`std/fs.read_file` is back to the natural two-step shape above. Fixtures:
[examples/pass/propagates_return_struct_literal.yoop](../examples/pass/propagates_return_struct_literal.yoop),
[examples/pass/propagates_return_variant_literal.yoop](../examples/pass/propagates_return_variant_literal.yoop),
and the negative
[examples/fail/propagates_return_struct_literal_not_declared.yoop](../examples/fail/propagates_return_struct_literal_not_declared.yoop).

## Priority

All items are now landed. The arc, in the order they were fixed: #1
codegen quote bug; #2 file I/O via std/fs; #8 path_join; #3 opaque
unsafe_ptr; #11 return-struct transfer; #4 Vec bulk fill; #5 owned
Bytes; #6 owning Response body; #10 yoop_io_mkdir; #9 combined import.
(#7 was retracted - `switch default:` exists.)

Remaining follow-ups noted inline, none blocking: std/fs metadata /
streaming reads / errno surfacing (#2), `dirname`/`basename`/etc. in a
future `std/path` (#8), and per-connection task-per-request serving now
that the Response owns its body (#6).
