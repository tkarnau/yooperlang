# Phase 8.C - Buffer interop intrinsics

## Context

Phase 8.A landed `unsafe_ptr<T>`, Phase 8.B landed the C integer aliases. The
remaining gap before a yoop-side networking library can call `read` / `recv` /
`send` is moving bytes between yoop-owned arrays and libc-owned buffers.

Yoop's array type is a fat pointer - `{ data: ptr, len: i64 }` - but the data
pointer slot is not addressable from user code today. The `.len` intrinsic
already exposes the length half; this phase adds the symmetric **`.ptr`**
intrinsic on the data half and a paired **`unsafe_ptr.toArray<T>(p, n)`**
intrinsic to materialize a yoop array view from an externally-allocated
buffer.

Together these unblock the two FFI directions:

- yoop → C: pass `buf.ptr` and `buf.len` as separate args to `read(fd, buf.ptr, buf.len)`.
- C → yoop: take a `malloc`-allocated `unsafe_ptr<uint8>` and wrap it as a
  `uint8[]` so the rest of the program can use `xs[i]` / `xs.len` on it.

Slice syntax (`arr[i..j]`) is **deferred** to a follow-up - implementing it
requires a new `..` token and parser-level slice grammar, and the same use
cases are coverable with `.ptr + offset + toArray` for now. Listed at the end
of this doc.

## Design

### `xs.ptr` - array data-pointer intrinsic

Mirrors the existing `xs.len` intrinsic. For an `xs: T[]`, `xs.ptr` returns
`unsafe_ptr<T>` pointing at the first element of the underlying storage. This
is a **borrow**, not a transfer: the array still owns its memory; the caller
must not free it through the pointer (it may be stack-allocated or heap-owned
by yoop), and the pointer must not outlive the array binding.

Gating: `xs.ptr` requires `import.unsafe;` because the produced
`unsafe_ptr<T>` is itself an unsafe-pointer value. (`xs.len` does not need the
gate - it's just an integer.) This is consistent with Phase 8.A's blanket
rule that *mentioning* `unsafe_ptr<T>` in any form requires the gate.

Codegen: GEP field 0 of the fat-pointer struct, load → `ptr`. Identical
shape to `xs.len`'s GEP field 1.

### `unsafe_ptr.toArray<T>(p, n)` - wrap a raw pointer + length as a `T[]`

Companion intrinsic in the existing `unsafe_ptr.*` namespace (Phase 8.A
introduced `unsafe_ptr.cast<U>` / `toInt` / `fromInt`). Signature:

```yoop
unsafe_ptr.toArray<T>(p: unsafe_ptr<T>, n: c_size_t): T[]
```

Returns a fat-pointer **view**: `{ data: p, len: n }`. No allocation, no
copy. The caller is responsible for the lifetime of the underlying memory -
this is an `import.unsafe;`-gated operation.

Parser: parses identically to the existing `unsafe_ptr.cast<U>(...)` etc.
intrinsics - the literal token sequence `unsafe_ptr . toArray < TypeAnnot > ( ... )`.
AST shape reuses `UNSAFE_PTR_CAST` with a new `castKind: "toArray"`. The
node carries two operands rather than one, so the AST shape is
`{ castKind: "toArray", typeArg, ptr, length }`.

Codegen: alloca a fresh fat-pointer slot (the existing `%yoop_array.<T>`
struct that `ensureArrayTypeDef` produces), store the ptr into field 0,
store the length into field 1, load and return the value. Same shape as the
ARRAY_LITERAL codegen path's final "load the fat ptr" step.

Typecheck: arg 1 must be `unsafe_ptr<T>` for the same `T` as the type
argument (mismatch is a typecheck error with a fix-it hint mentioning
`unsafe_ptr.cast`). Arg 2 must be an integer (`c_size_t` / `usize` / any
int prim).

### Lifetimes & safety

Both intrinsics are explicit foot-guns gated by `import.unsafe;`. Documenting
the contract:

- `xs.ptr` is **transient**. If the array is stack-allocated, the pointer
  dangles after the enclosing function returns. The caller is responsible
  for ensuring the array outlives every use of the pointer.
- `unsafe_ptr.toArray<T>(p, n)` produces a **borrowing view**. Reads/writes
  through the array go straight to `p`'s memory. Freeing `p` while a view
  exists invalidates the view; using the view after free is UB.

These match the standard C/Rust conventions for raw-pointer borrows and don't
require a new safety mechanism in the typechecker. The Phase 6 kind system
could later carry a `borrowed` kind to encode the lifetime obligation, but
that's out of scope here - the contract is documented in the SPEC and lives
in user code reviews.

## Sub-phases

### 8.C.0 - SPEC

Update [SPEC.md](../SPEC.md) §12 with a "Buffer interop" subsection:
- `xs.ptr` intrinsic, signature `T[] → unsafe_ptr<T>`, gated by `import.unsafe;`.
- `unsafe_ptr.toArray<T>(p, n)` intrinsic, signature
  `(unsafe_ptr<T>, c_size_t) → T[]`, with the lifetime caveat.

### 8.C.1 - `xs.ptr` intrinsic

[checkExpr.js](../src/jsyooptypecheck/checkExpr.js) - extend the FIELD_ACCESS
resolver next to the existing `xs.len` case. Set `node.isArrayPtr = true`
and return `UnsafePtrType(elem)`. Gate against `ctx.allowsUnsafe` if the
flag's available; otherwise rely on the AST-walker gating from 8.A (which
already errors on any `UnsafePtrType` annotation but won't catch a
synthesized type - add it to the AST walker too).

[codegen.js](../src/jsyoopcodegen/codegen.js) - extend the FIELD_ACCESS
emitter in both single-module and multi-module paths next to the `isArrayLen`
case. GEP field 0, load, return as `ptr`.

### 8.C.2 - `unsafe_ptr.toArray<T>(...)` intrinsic

[parser.js](../src/jsyooparser/parser.js) - extend the existing
`unsafe_ptr.cast<U>(p)` / `toInt(p)` / `fromInt<T>(n)` recognition to also
accept `toArray<T>(p, n)`. New `UNSAFE_PTR_CAST` shape adds an optional
`lengthOperand` field for the second arg.

[checkExpr.js](../src/jsyooptypecheck/checkExpr.js) - extend
`resolveUnsafePtrCast` with the `toArray` case. Validate ptr operand type
matches the type arg, validate length is integer-ish, return
`ArrayType(typeArg)`.

[codegen.js](../src/jsyoopcodegen/codegen.js) - in `UNSAFE_PTR_CAST`
emitters: detect `castKind === "toArray"`, call `ensureArrayTypeDef`, alloca
+ two stores + load.

### 8.C.3 - Demo

`examples/pass/buffer_interop.yoop`:

- `malloc` a 16-byte buffer.
- `unsafe_ptr.toArray<uint8>(buf, 16)` to wrap as `uint8[]`.
- Use `.len` to iterate, writing `i * 2` into each byte.
- Pass `.ptr` to a libc function (`memcmp` against a yoop-local literal
  array) - exercises the yoop → C direction.
- `free` the underlying pointer.
- Print whether the comparison matched.

### 8.C.4 - Verification

Unit tests colocated in the existing checkExpr / codegen test files. e2e
fixture under `examples/pass/buffer_interop.yoop`. Fail fixture for `xs.ptr`
without `import.unsafe;`.

## Out of scope

- **`arr[i..j]` slice syntax.** Requires `..` token + slice grammar. Same use
  cases coverable today with `xs.ptr + offset` + `toArray`. Lift the Phase 4
  deferral in a follow-up sub-phase if a real program needs the ergonomics.
- **Mutable heap-allocated yoop arrays.** Reachable via `malloc` + `toArray`
  for `uint8[]` use cases (read buffers in a server). A general allocator
  story across all element types is its own design.
- **A `borrowed` lifetime kind.** Phase 6 kind infrastructure could express
  the borrow obligation; out of scope here.
- **`from_raw` for typed buffers shared across yoop / C.** `toArray<T>` is
  the same thing under a different name - pick the namespace, ship it.

## Files touched

- [SPEC.md](../SPEC.md) - §12 buffer-interop subsection.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) - recognize
  `unsafe_ptr.toArray<T>(p, n)` as a primary intrinsic.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) -
  `xs.ptr` field intrinsic, `toArray` resolver case.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) -
  extend the unsafe gating walker to flag `xs.ptr` access on a `uint8[]`-or-
  any-array binding (since the result is an unsafe pointer).
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) - emitter
  for `xs.ptr` (both paths) + `toArray` (both paths).
- `examples/pass/buffer_interop.yoop`, `examples/fail/array_ptr_no_import.yoop`
  - fixtures.
- [src/e2e.test.js](../src/e2e.test.js) - e2e wiring for the new fixtures.
