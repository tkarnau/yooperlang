# Phase 8.H - String + bytes primitives, and a standard `Vec<T>`

## Context

[plans/library-design.md](library-design.md) lays out the std-library shape - `std/net`, `std/http`, the trait set (`Disposable`, `Readable`, `Writable`, `Display`), the fallible-struct convention. Its §8 "open language questions" enumerates the gaps the library exposes (dyn-Trait, function values, Map, Display-in-templates, `std/` import root, `?`-over-enums).

Three things the library design **assumes** but that aren't actually in the language today, and aren't on the §8 list:

1. **String manipulation primitives.** `string` today is a zero-terminated UTF-8 C string with one intrinsic: `s.len` (= `strlen(s)`). No substring, no index-of, no equality beyond `==`, no case-insensitive compare. An HTTP/1.1 parser needs every one of those - status-line parsing, header-name lookup (case-insensitive!), Content-Length parsing.
2. **`string` ↔ `uint8[]` bridges.** Example library code references `string_to_bytes(s)` and the doc assumes both directions exist, but there's no intrinsic for either today. Every HTTP code path crosses this boundary - request lines, header values, request/response bodies.
3. **A blessed growable-vector type.** [library-design.md](library-design.md) §7.1 declares `Headers` as `HeaderEntry[]`, but yoop's `T[]` is a fixed fat-pointer view - you cannot push into it. [examples/pass/dynarray_push.yoop](../examples/pass/dynarray_push.yoop) shows the `DynArray<T>` pattern works via `heap_alloc` / `heap_free`, but it isn't part of std and every library author who needs "headers I'm building up while parsing" would otherwise hand-roll their own.

None of these are addressable by the planned library phases - they're language / std-core work that must land before Library Phase A (`std/core/`) is usable. **This document is the prerequisite phase that sits between [phase-8-f.md](phase-8-f.md) and Library Phase A.**

What already exists and is reusable:

- `string` as a zero-terminated UTF-8 byte sequence with the `.len` intrinsic (= `strlen`). Pointer-shaped at the LLVM level (codegen treats it as `ptr`).
- `uint8[]` as a fat-pointer `{ ptr, len }` with element indexing, `.len`, and (Phase 8.C) `.ptr`.
- Generics (Phase 7.1) - `DynArray<T>` already typechecks today.
- `heap_alloc<T>(n)` / `heap_free<T>(buf)` - present in the dynarray example.
- Trait bounds (Phase 7.2) - needed if `Vec<T: ...>` ever grows constraints.
- The fallible-struct + `?` convention - error-bearing string ops return `{ value, err }`.

## Intrinsics as a first-class concept

Phase 8 has accumulated a population of "intrinsic" operations - calls that look like normal yoop functions but are implemented by codegen against LLVM / libc rather than by user yoop code. They're scattered across the spec in different shapes:

- **Field-shaped**: `s.len`, `xs.len`, `xs.ptr` (Phase 8.C).
- **Namespaced**: `unsafe_ptr.cast<T>(p)`, `unsafe_ptr.toInt(p)`, `unsafe_ptr.fromInt<T>(n)`, `unsafe_ptr.toArray<T>(p, n)` (Phase 8.A / 8.C); `errno.get()`, `errno.set(v)`, `errno.message(c)` (Phase 8.D).
- **Free functions**: `heap_alloc<T>(n)`, `heap_free<T>(buf)` (appear in [examples/pass/dynarray_push.yoop](../examples/pass/dynarray_push.yoop) but undocumented in SPEC).
- **Runtime functions** exposed to user code: `yoop_io_wait_readable(fd)`, `yoop_sleep(ns)` (Phase 8.F).

This phase formalizes the category. Three deliverables on the intrinsics front, independent of the bytes / strings / Vec work:

1. **SPEC §12 becomes the intrinsics index.** Every intrinsic, regardless of shape, gets one entry under §12 with signature, allocation behavior, gating (`import.unsafe;` or not), and a one-line semantics summary. `heap_alloc` / `heap_free` are no longer "they just exist in an example file" - they get a SPEC entry alongside `unsafe_ptr.cast` and the rest.
2. **Naming conveys allocation behavior.** The library design assumes call sites surface cost ("the programmer easily knows when memory reallocation is happening"). Codified as a naming convention every new intrinsic must follow:
   - **Views / borrows** (no allocation): `_as_*`, `_slice`, `xs.ptr`, `vec_as_array`. The returned value shares storage with an input; the caller is responsible for keeping the parent alive.
   - **Construction / copy** (heap allocation): `_new`, `_copy`, `_from_*`, `_concat`, `vec_new`, `string_from_bytes`. The returned value owns its storage.
   - **Mutation that may reallocate**: `vec_push` is the canonical case. Documented in its signature comment and the SPEC entry; the user is told it may grow the backing buffer.
3. **No new `borrowed` kind.** Phase 6 already has `mustNotEscape` if a future intrinsic ever needs to enforce a borrow at the type level, but for the 8.H surface the naming convention + SPEC documentation carries the contract. This keeps library code reading like normal yoop and doesn't burden every parser with lifetime annotations. (If a real footgun emerges, the kind escape hatch is still available - design when needed, not before.)

This framing is the dependency-free part of 8.H - it could land on its own as a documentation-and-spec pass, and the new bytes / strings / Vec entries plug into it.

## Design

### 8.H.1 - Byte-buffer primitives

The HTTP wire parser works on bytes, not on `string`. Bytes from the wire might not be valid UTF-8 until validated, and even when they are, scanning for `\r\n` or `:` is cheaper on raw `uint8[]` than on a `string` whose only operations are "call into libc". This sub-phase gives `uint8[]` the operations a parser actually needs.

All primitives are pure-yoop intrinsics - no `import.unsafe;` gate, no FFI. They live in `std/core/bytes.yoop` and are exposed as free functions (not methods on `uint8[]` - yoop has no method syntax on primitive types).

```yoop
// std/core/bytes.yoop

// Byte-equality on two views. Returns true iff lengths match and every byte matches.
function bytes_eq(ref a: uint8[], ref b: uint8[]): bool;

// First index i in `buf` such that `buf[i] == needle`, or buf.len if not found.
function bytes_index_of(ref buf: uint8[], needle: uint8): usize;

// First index i such that buf[i..i+needle.len] == needle, or buf.len if not found.
function bytes_index_of_seq(ref buf: uint8[], ref needle: uint8[]): usize;

// True iff buf starts with prefix.
function bytes_starts_with(ref buf: uint8[], ref prefix: uint8[]): bool;

// ASCII-only case-insensitive equality. Non-ASCII bytes compare exactly.
// (HTTP headers are ASCII; full Unicode case folding is out of scope.)
function bytes_eq_ignore_ascii_case(ref a: uint8[], ref b: uint8[]): bool;

// Borrowing sub-slice [start, end). No copy. Caller is responsible for
// keeping the parent buffer alive as long as the slice is used; the slice
// is a fat-pointer view into the parent's storage.
function bytes_slice(ref buf: uint8[], start: usize, end: usize): uint8[];

// Parse a decimal ASCII integer at the start of `buf`. Stops at the first
// non-digit. Returns the value and how many bytes were consumed.
// err is non-empty if no digits matched or the value overflowed int64.
type BytesParseInt { value: int64, consumed: usize, err: string }
function bytes_parse_int(ref buf: uint8[]): BytesParseInt;
```

**`bytes_slice` is the new piece worth scrutinizing.** It's a borrowing view, same shape as Phase 8.C's `unsafe_ptr.toArray`. Lifetimes are not encoded in the type system; the contract is documented and reviewed in user code. The alternative is a copying slice that allocates, which makes the parser quadratic in the body size. Borrowing is the right default; if a copy is needed the user can `bytes_copy(slice)` explicitly (added in 8.H.2 below).

Codegen: each function is a small LLVM `define` in the `std__core__bytes__*` mangling namespace. None of them need an `import.unsafe;` gate. `bytes_slice` does the fat-pointer GEP shape from Phase 8.C - alloca a fresh fat-pointer slot, write `parent.ptr + start` into field 0 and `end - start` into field 1, load and return.

Bounds checks: `bytes_slice` traps via `abort()` if `start > end` or `end > buf.len` - same convention as array indexing today. No silent saturation.

### 8.H.2 - `string` primitives and `string` ↔ `uint8[]` bridges

Bytes are the parser's working representation; `string` is the API surface (URL parameters, header values exposed to user code, error messages). This sub-phase makes the boundary crossable in both directions and adds the minimum `string` ops library code needs at the boundary.

```yoop
// std/core/strings.yoop

// View a string's UTF-8 bytes as a uint8[] without copying. The view shares
// the string's storage and the string outlives any binding; the view does
// NOT outlive the string.
function string_as_bytes(s: string): uint8[];

// Build a fresh heap-allocated string from a UTF-8 byte buffer. Validates
// UTF-8; err is non-empty if the bytes are not valid UTF-8. The returned
// string is independent of the input buffer (one copy).
type StringFromBytes { value: string, err: string }
function string_from_bytes(ref buf: uint8[]): StringFromBytes;

// Copy a uint8[] view into a fresh heap-allocated uint8[]. Useful for
// turning a borrowing bytes_slice() result into an owned buffer that can
// outlive its parent.
function bytes_copy(ref buf: uint8[]): uint8[];

// All string-on-string ops below are conveniences and could be expressed
// via string_as_bytes + the bytes_* primitives. They're inlined here
// because (a) parser code shouldn't have to round-trip through bytes for
// trivial things, and (b) match the obvious mental model.

function string_eq(a: string, b: string): bool;
function string_eq_ignore_ascii_case(a: string, b: string): bool;
function string_starts_with(s: string, prefix: string): bool;
function string_index_of(s: string, needle: string): usize;  // s.len if not found

// Substring [start, end) in BYTE offsets. Allocates a fresh string.
// Errors if start/end land mid-UTF-8-codepoint (not just at byte
// boundary) - see "Open: codepoint-vs-byte indexing" below.
type StringSlice { value: string, err: string }
function string_slice(s: string, start: usize, end: usize): StringSlice;

// Concat two strings into a fresh heap-allocated string.
function string_concat(a: string, b: string): string;

// Concat N strings into one fresh heap-allocated string. One allocation
// total (sum the lengths, then alloc + copy). Takes an ordinary string[];
// real `...string` variadic parameters are a future ergonomic upgrade
// once user-defined variadic functions land in the language.
function string_concat_all(parts: string[]): string;
```

**Lifetimes and ownership.** `string_as_bytes` is a *zero-copy view* - the same backing storage as the string, no allocation. The returned `uint8[]` is borrowed; if the string is freed (today this only happens when its enclosing function returns; yoop has no string GC), the view dangles. For a parser that reads a request line, calls `string_as_bytes`, scans for spaces, and returns before the string goes out of scope, this is fine. For storing the bytes long-term, use `bytes_copy`.

`string_from_bytes` *copies* and *validates*. Two reasons: (a) yoop's `string` is zero-terminated, so we need to write a terminator byte that may not exist in the input buffer; (b) the standard library should never produce a `string` whose bytes aren't UTF-8 - too easy a footgun. Validation is a single forward scan; copy + validate in one pass.

**Open: codepoint-vs-byte indexing.** `string_slice(s, start, end)` takes byte offsets. The risk is splitting a multi-byte UTF-8 codepoint - we reject this at runtime via the `err` field. The alternative is codepoint-indexed slicing, which is O(n) every time you want the kth char. HTTP/1.1 parsing is byte-oriented (the wire is ASCII), so byte indexing is the right primary surface. A future `std/text/` could add codepoint helpers.

**Open: `string` interning vs always-fresh.** Today every string literal is a separate `@.str` LLVM global; `string_concat` would `malloc` + write. We're not solving deduplication here. The cost shows up if a parser allocates one string per header - which it will - and that's something to revisit if profiling demands it. Out of scope for 8.H.

Codegen: same `std__core__strings__*` mangling namespace. `string_as_bytes` is a fat-pointer construction: write `s` into field 0 and `strlen(s)` (or a cached value if we add one later) into field 1, load.

### 8.H.3 - `Vec<T>` in std

Bless the `DynArray<T>` pattern from [examples/pass/dynarray_push.yoop](../examples/pass/dynarray_push.yoop) as the standard growable-array type, living at `std/core/vec.yoop`. Rename to `Vec<T>` to match industry convention. Same shape, no new language features needed - Phase 7.1 generics already make this expressible.

```yoop
// std/core/vec.yoop

type Vec<T> implements Disposable propagates<disposable> {
    data: T[],
    len: usize,
    cap: usize,
    function dispose(ref self): void {
        if (self.cap > 0) {
            heap_free(self.data);
        }
    }
}

export function vec_new<T>(initial_cap: usize): Vec<T>;
export function vec_push<T>(ref v: Vec<T>, value: T): void;
export function vec_pop<T>(ref v: Vec<T>): { value: T, err: string };
export function vec_get<T>(ref v: Vec<T>, i: usize): T;        // traps on OOB
export function vec_set<T>(ref v: Vec<T>, i: usize, value: T): void;
export function vec_clear<T>(ref v: Vec<T>): void;             // len = 0, cap unchanged

// Borrowing view of the populated prefix as a regular yoop array.
// Lifetime: the view is valid until the next mutation (push/pop/clear/dispose).
export function vec_as_array<T>(ref v: Vec<T>): T[];
```

The `Disposable + propagates<disposable>` declaration is load-bearing: `Vec<T>` owns heap memory, so by [library-design.md](library-design.md) §2.3 it must carry the `disposable` obligation. Every library that uses `Vec<HeaderEntry>` (the headers case) will pick one of the three legal exits - auto-cleanup, manual dispose, or transfer-up - and the compiler enforces it.

**Why this isn't just "use the example file."** Three reasons:
1. The example uses `heap_alloc` / `heap_free` as plain functions; whether those are blessed std-library intrinsics or just shows-up-in-tests primitives is unclear. This phase pins it down: they're stable std-library functions documented in SPEC §12.
2. The example doesn't carry the disposable obligation. Without `propagates<disposable>`, callers leak memory silently. The library-shipped `Vec<T>` must carry it.
3. Every library code path that builds up a collection should reach for the same name. `Vec` is industry-standard.

**Out of scope for 8.H.3**: `vec_reserve`, `vec_extend`, iterator helpers (await for-in loops + `Iterator<T>`), `Vec<T>` ↔ `T[]` ownership transfer (today it's view-only), shrink-to-fit. Add as a real program needs them.

## Sub-phase order and dependencies

- **8.H.1** is standalone. Depends on Phase 8.C (`xs.ptr`, fat-pointer slicing shape).
- **8.H.2** depends on 8.H.1 (`bytes_copy`).
- **8.H.3** depends on Phase 7.1 (already landed) and the existing `heap_alloc`/`heap_free` story; independent of 8.H.1/8.H.2 in principle, but should ship together so Library Phase A has a coherent foundation.

## SPEC additions

[SPEC.md](../SPEC.md) §12 is restructured as the **intrinsics index** (see the "Intrinsics as a first-class concept" section above). Existing entries that today live as ad-hoc mentions across the spec are gathered here under uniform headings. Each entry carries: signature, gating (`import.unsafe;` or not), allocation behavior ("view" / "fresh allocation" / "may reallocate"), and one-line semantics.

The §12 reorganization is in-scope for this phase even where the underlying intrinsic isn't new:

- **Memory**: `heap_alloc<T>(n)`, `heap_free<T>(buf)` - promoted from "shows up in the dynarray example" to a real entry with a signature and the rule that misuse is UB (no double-free detection in the language today).
- **Pointers**: `unsafe_ptr.cast<T>(p)`, `unsafe_ptr.toInt(p)`, `unsafe_ptr.fromInt<T>(n)`, `unsafe_ptr.toArray<T>(p, n)`, `xs.ptr` - cross-references to Phases 8.A and 8.C.
- **Errno**: `errno.get()`, `errno.set(v)`, `errno.message(c)` - cross-reference to Phase 8.D.
- **Length**: `s.len`, `xs.len` - the long-existing intrinsics, now indexed alongside the rest.

New entries added by this phase:

- **Bytes** - the 8.H.1 functions. `bytes_slice` is documented as a view; `bytes_copy` (added in 8.H.2) as a fresh allocation.
- **Strings** - the 8.H.2 functions. `string_as_bytes` is a view; `string_from_bytes`, `string_slice`, `string_concat`, `string_concat_all` are fresh allocations.
- **Vec** - pointer to `std/core/vec.yoop`. `vec_new` allocates; `vec_push` is flagged "may reallocate"; `vec_as_array` is a view valid until the next mutation; the Disposable contract is called out at the top of the entry.

## Verification

Per existing project conventions in [CLAUDE.md](../CLAUDE.md):

- Unit tests colocated where each intrinsic is implemented (typechecker resolver, codegen emitter).
- e2e fixtures under `examples/pass/`:
  - `bytes_primitives.yoop` - round-trip every 8.H.1 function on a literal `uint8[]`.
  - `string_bytes_bridge.yoop` - `string_as_bytes` → scan → `string_from_bytes` round trip; bad-UTF-8 fail path.
  - `string_primitives.yoop` - `string_slice`, `string_starts_with`, `string_eq_ignore_ascii_case`.
  - `vec_basic.yoop` - push/pop/get/set/clear, with `disposable v: Vec<int32> = vec_new(4)` showing auto-cleanup.
  - `vec_headers_shape.yoop` - `Vec<HeaderEntry>` building up a fake header set, exercising the disposable propagation through a function boundary.
- Fail fixtures under `examples/fail/`:
  - `bytes_slice_oob.yoop` - slice past end traps (compile passes, runtime aborts; e2e fixture asserts the abort).
  - `string_slice_mid_codepoint.yoop` - returns err.
  - `vec_no_disposable.yoop` - plain `let v: Vec<int32> = vec_new(4);` with no cleanup is a typecheck error per [propagates strict enforcement](phase-6-4-propagates-strict-enforcement.md).
- Once 8.H lands, [src/e2e.test.js](../src/e2e.test.js) gets a "library prereqs" describe block.

The end-to-end smoke test for the whole phase is: write a 30-line `parse_request_line` function in pure yoop that takes a `uint8[]` containing `"GET /path HTTP/1.1\r\n"`, returns `{ method: string, path: string, version: string, err: string }`. If it compiles cleanly with only `std/core/bytes` and `std/core/strings` imports - no `import.unsafe;` - 8.H is done.

## Open questions

1. **`bytes_index_of_seq` performance.** Naive O(n*m) is fine for the parser (HTTP needles are short). Defer harder optimization (Boyer-Moore, `memmem` shim) until a real workload proves it matters - premature without profiling data.
2. **Variadic `string_concat`.** This phase ships `string_concat_all(parts: string[])` taking an array. Real `...string` variadic *user* functions are a future ergonomic upgrade; not in scope here.
3. **Naming: snake_case free functions vs trait methods.** This phase uses snake_case free functions (`bytes_index_of`) rather than a `Bytes.index_of(ref buf, ...)` trait-qualified call. Rationale: `uint8[]` is a primitive, not a user-defined type that can implement a trait. If yoop later grows extension methods on primitives, these can become `Bytes.index_of(...)` without source breakage by re-exporting.

Decisions previously open, now resolved:

- ~~`heap_alloc` / `heap_free` SPEC location~~ - resolved by the "Intrinsics as a first-class concept" section above; they get a real §12 entry alongside `unsafe_ptr.cast` and the rest.
- ~~`borrowed` kind for views~~ - not introduced. Allocation behavior is conveyed at the call site by the naming convention (`_as_*` / `_slice` for views; `_new` / `_copy` / `_from_*` / `_concat` for allocations; `vec_push` explicitly flagged as "may reallocate"). The Phase 6 `mustNotEscape` escape hatch is still available if a real footgun emerges.

## Files touched

- [SPEC.md](../SPEC.md) - §12 bytes / strings / Vec subsections.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) - register each new function as a builtin with signature, or - if std modules are user-importable today - just compile `std/core/bytes.yoop` etc. as normal modules and skip intrinsic registration. (Pick whichever fits the existing pattern for `heap_alloc`/`heap_free`.)
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) - emitter for each primitive that isn't expressible in pure yoop (the bytes_* ops need raw LLVM `memcmp`/`memchr`/byte loop; vec_* are pure yoop and need no codegen support beyond what generics already give).
- new: `std/core/bytes.yoop`, `std/core/strings.yoop`, `std/core/vec.yoop`.
- `examples/pass/bytes_primitives.yoop`, `string_bytes_bridge.yoop`, `string_primitives.yoop`, `vec_basic.yoop`, `vec_headers_shape.yoop`.
- `examples/fail/bytes_slice_oob.yoop`, `string_slice_mid_codepoint.yoop`, `vec_no_disposable.yoop`.
- [src/e2e.test.js](../src/e2e.test.js) - wire the new fixtures.

## Out of scope

- A real `Map<K, V>` / hash-table type. Open question §8.4 in [library-design.md](library-design.md); waits on a follow-up.
- For-in loops and `Iterator<T>`. Open question §8 in [library-design.md](library-design.md).
- Full Unicode case folding, normalization, grapheme cluster iteration. ASCII case folding for HTTP is enough.
- A streaming `Display`-aware template literal. Library types can implement `Display.to_string` today and users embed the result manually; lifting into templates is a small typechecker change tracked under library-design §8.5.
- `string` interning / deduplication. Out of scope; revisit if profiling demands it.
- A `borrowed` lifetime kind. Naming convention carries the contract instead - see the "Intrinsics as a first-class concept" section.
- User-defined variadic functions (`function f(parts: ...string)`). `string_concat_all` takes an array for now; real variadics are a separate language feature.
