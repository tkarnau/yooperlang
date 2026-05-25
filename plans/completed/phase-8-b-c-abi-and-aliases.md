# Phase 8.B - C-portable integer aliases and C-ABI struct layout

## Context

Phase 8.A landed `unsafe_ptr<T>` so yoop can talk about raw FFI pointers. The next gap before the networking library can start is expressing C ABIs precisely. Two pieces:

1. **Portable C integer aliases** - `c_int`, `c_long`, `c_size_t`, etc. These are the only honest way to write a syscall signature, because the corresponding C types are platform-dependent widths.
2. **`layout { abi "C"; }`** - an opt-in marker stating "this struct mirrors a C struct's ABI." Today yoop already lays out structs in declaration order with natural alignment (matches C for trivially-aligned struct fields), so this is mostly an explicit contract - but it gives us a place to evolve packing/padding rules later without breaking anyone.

The motivating demo for this phase is calling **`clock_gettime(CLOCK_REALTIME, &ts)`** from yoop, declaring `struct timespec` natively and printing the result. That exercises:

- C aliases (`c_int`, `c_long`) in an extern signature
- a struct mirroring a C struct
- `&` on a struct lvalue to produce `unsafe_ptr<TimeSpec>`
- passing that pointer through FFI
- field access on a struct populated by C code

The address-of-struct + extern call path was already proven to work in Phase 8.A - Phase 8.B is the missing type-system vocabulary for the signature.

## Design

### C integer aliases - name aliases, not new types

Treat the aliases as **resolution-time synonyms** for the existing primitive integer types. `c_int` doesn't become a distinct `PrimType`; it resolves to the same `PrimType("int32")` (or whatever the platform width dictates). This keeps the type system unchanged and lets the aliases interoperate freely with the fixed-width types - `c_int(0)` for a literal arg, comparisons against `0`, etc.

| Alias | Linux/macOS LP64 | Windows LLP64 | Rationale |
| --- | --- | --- | --- |
| `c_short` | `int16` | `int16` | always 16-bit |
| `c_ushort` | `uint16` | `uint16` | always 16-bit |
| `c_int` | `int32` | `int32` | always 32-bit on the platforms we support |
| `c_uint` | `uint32` | `uint32` | always 32-bit |
| `c_long` | `int64` | `int32` | the LP64/LLP64 split |
| `c_ulong` | `uint64` | `uint32` | the LP64/LLP64 split |
| `c_size_t` | `usize` (= 64-bit) | `usize` | platform pointer width |
| `c_ssize_t` | `isize` (= 64-bit) | `isize` | platform pointer width |

For Phase 8.B we **assume LP64**. Yoop currently has no notion of a target triple - the codegen emits with whatever clang's default triple is and `usize`/`isize` are hardcoded to 64 bits. The aliases follow the same hardcode: `c_long` → `int64`, `c_ulong` → `uint64`. When yoop grows real target-triple awareness, `canonicalize` learns to consult it; until then this is documented in [SPEC.md](../SPEC.md) and the alias table comment.

Reasoning for resolution-time aliasing rather than new `PrimType` instances: aliasing keeps the surface tiny. No new entries in `typesEqual`, `formatType`, `llvmType`, `isIntPrim`, `unifyArith`, etc. A `c_long` value just *is* an `int64` everywhere downstream. The cost: an error message says "expected int32, got int64" instead of "expected int32, got c_long" - acceptable for the FFI-glue contexts where these aliases are used.

### `layout { abi "C"; }` - explicit C-ABI marker

`layout` already exists and currently accepts only an `align` sub-clause ([phase-6-5-layout-composition.md](phase-6-5-layout-composition.md)). Add a second sub-clause `abi "C";` that:

- Parses as `abi` (ident) followed by a string literal followed by `;`.
- Validates the string is `"C"` (the only supported ABI for now).
- Stores `abiC: true` on the `KIND_LAYOUT_CLAUSE` AST node and on the resolved `KindType`'s layout slot.

**Semantics in Phase 8.B**: contractual only. Yoop's existing struct layout (field-declaration order, natural alignment per field) already matches C-ABI for plain structs. The `abi "C"` marker doesn't change codegen today; it surfaces user intent and gives us a place to enforce future invariants:

- if/when we add field reordering optimizations, `abi "C"` opts out.
- if/when we add `pack N`, `abi "C"` clashes with non-natural padding.

Users may declare `extern "C"` -compatible structs without the marker for now, and they'll still work. The marker is recommended for documentation.

`layout { pack N; }` and field-order guarantees in non-`abi "C"` mode are deferred.

### Documentation

Update SPEC §12 (Foreign interop) to add a "C-portable type aliases" subsection with the alias table. Update SPEC §14 reserved-keyword list to include `abi`, `c_int`, `c_uint`, `c_long`, `c_ulong`, `c_short`, `c_ushort`, `c_size_t`, `c_ssize_t`. The aliases are reserved type names rather than keywords (i.e. they resolve via `canonicalize`, not via tokenized form) - but documenting them as reserved prevents user code from declaring conflicting bindings.

## Sub-phases

### 8.B.0 - SPEC

Add a "C-portable type aliases" subsection to §12 documenting the alias table, the LP64 assumption, and the rule that extern signatures **may** use either the aliases or the fixed-width primitives (the aliases are not required - they're a documentation/portability hint).

Add `abi` to the layout-clause grammar in §6 (or wherever layout is currently described).

### 8.B.1 - Aliases

Extend `canonicalize()` in [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) to map `c_short`/`c_ushort`/`c_int`/`c_uint`/`c_long`/`c_ulong`/`c_size_t`/`c_ssize_t` to their LP64 fixed-width counterparts. This is the only typechecker change; everything else follows automatically.

Add the alias names to a small `C_ALIASES` table next to `canonicalize` so the resolution is greppable and easy to extend for non-LP64 targets later.

### 8.B.2 - `layout { abi "C"; }`

In [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) `parseLayoutClause()`, accept an `abi <stringLiteral> ;` sub-clause alongside the existing `align`. Reject any value other than `"C"` with `abi "<x>" is not a supported C ABI marker`. Store `abiC: true` on the resolved clause. **No codegen change** - the marker is contractual.

Optionally, push a typecheck warning if the struct contains an array field type (which yoop lowers as a fat pointer, not a flat C array) - that's not C-ABI-compatible. For the MVP, skip the warning; the user-facing demo doesn't trip it.

### 8.B.3 - Demo

Add `examples/pass/clock_gettime.yoop` calling `clock_gettime(CLOCK_REALTIME, &ts)` with an externally-declared signature and a yoop-side `TimeSpec` struct. Verify the printed seconds value is plausible (>= a known unix-epoch threshold).

## Out of scope

- Target-triple-aware width resolution (Windows LLP64). Hardcoded to LP64.
- `layout { pack N; }`. Defer.
- Field-order-preservation enforcement. Yoop already preserves declared order; the rule is implicit.
- `c_char` (signedness varies per platform/arch - defer until needed).
- Anonymous inline unions inside structs.
- Bit-fields.

## Files touched

- [SPEC.md](../SPEC.md) - §12 aliases subsection, §14 keyword list, §6 layout clause.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) - `canonicalize()` aliases.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) - `parseLayoutClause()` accepts `abi`.
- `examples/pass/clock_gettime.yoop` - demo program.
- [src/e2e.test.js](../src/e2e.test.js) - e2e test for the demo.
