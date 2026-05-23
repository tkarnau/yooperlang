# Phase 10.C.3 — std/collections/ rest: Set, Deque, Map iteration ✓ landed

> The follow-up to Phase 10.C.2's generic `Map<K, V>`. Lands the
> remaining collection shapes from the original 10.C plan — `Set<K>`,
> `Deque<T>`, and `for entry in map_iter(ref m)` — plus the
> int64/uint64/bytes `KeyOps` helpers. Along the way it picks up four
> compiler-side fixes that container code surfaced.

## What shipped (library)

### `KeyOps` helpers for more key types

In [std/collections/map.yoop](../../std/collections/map.yoop):

- `int64_key_ops()` / `uint64_key_ops()` — Knuth-style multiplicative
  hash; `==` for equality.
- `bytes_key_ops()` — FNV-1a over the byte buffer; `bytes_eq` for
  equality. The map's `keys` array stores the fat pointers — the
  caller is responsible for keeping the backing buffers alive.

### `Set<K>` in [std/collections/set.yoop](../../std/collections/set.yoop)

A thin `Disposable + propagates<disposable>` wrapper over
`Map<K, bool>`. yoop doesn't have `void` as a type argument (you
can't write `Map<K, void>`), and the one-byte-per-slot dummy is
negligible next to the power-of-two key arrays the map maintains.
API mirrors the map: `set_new`, `set_insert` (returns true iff `k`
was already present), `set_contains`, `set_remove`, `set_len`.

### `Deque<T>` in [std/collections/deque.yoop](../../std/collections/deque.yoop)

Power-of-two ring buffer over a single heap allocation. Both ends are
O(1); `grow()` doubles capacity and linearizes (head = 0 in the new
buffer) so future indexing doesn't have to track a non-zero start.
API: `deque_new`, `deque_push_back`, `deque_push_front`,
`deque_pop_back` (→ `Option<T>`), `deque_pop_front` (→ `Option<T>`),
`deque_get(i)` (→ `Option<T>`), `deque_len`, `deque_clear`.

### Map iteration

`MapEntry<K, V> { key: K, value: V }` is the yielded element type.
`MapIter<K, V> implements Iterable<MapEntry<K, V>>` holds borrowing
views of the map's backing arrays (the fat pointers are copies; the
heap data is shared) and walks occupied slots in storage order,
skipping `EMPTY` / `TOMBSTONE`. `map_iter(ref m)` constructs a fresh
iterator. Typical use:

```yoop
for e in map_iter(ref m) {
    use(e.key, e.value);
}
```

The iter is invalidated by any mutation that triggers a rehash — keep
its lifetime scoped to the loop.

## What shipped (compiler)

Four small fixes the new collections forced:

### 1. Cross-module per-instance emission fixed-point

The per-module fixed-point loop introduced in 10.C.1 didn't catch
inter-module dependencies: `Set<K>`'s body in
`std/collections/set.yoop` references generic functions in
`std/collections/map.yoop`. When `Set<string>` is monomorphized, the
clone registers `map_contains_key<string, bool>` etc. on the *map*
module's registry slot — which has already finished its own
per-instance sweep. The fix:

- Each module's per-instance emission is now a closure
  (`flushInstances`) stored on `programState._instanceFlushers`.
- `codegenWithModuleId` returns raw `lines` (no filtering) plus an
  `extract()` callback.
- `codegenProgram` runs all per-decl emissions first, then a
  cross-module fixed-point that calls each module's flushInstances
  until no new emissions. The extract step runs *after* the fixed-point
  so each module's `lines` array sees the post-flush state.

### 2. Substituted methods + traits in `instantiateStruct`

`MapIter<K, V> implements Iterable<MapEntry<K, V>>` with
`next(ref self): IterStep<MapEntry<K, V>>` exposed a long-standing
gap: `instantiateStruct` was copying `genericDecl.methods` and
`genericDecl.implementsTraits` straight onto the new instance —
unsubstituted. For `MapIter<int32, int32>`, this meant
`methods.get("next").returnType` was still
`IterStep<MapEntry<K, V>>` with K/V as `TypeParamType`. The for-in
loop's elem-type extractor read the un-substituted value and the
body's `entry.key` resolved to a `TypeParamType` — arithmetic
failed.

Fix in [instantiate.js:instantiateStruct](../../src/jsyooptypecheck/instantiate.js):

- Allocate the instance with placeholder `Map`/`Array` for methods
  and traits, register it in the cache early.
- Then substitute through each method sig and each trait reference.
  Self-referential walks (e.g. a method with `ref self` typed as the
  open `MapIter<K, V>`) re-instantiate the struct, hit the cache, and
  return the in-progress instance — no infinite recursion.

### 3. Trait method re-mangle after substitution

The cleansing path of 10.C.1 fixed cloning of variant records.
`Set<K>`'s `dispose` method calls
`Disposable.dispose(ref self.inner)` where `self.inner: Map<K, bool>`
(open). The clone for `Set<string>` substitutes `inner` to
`Map<string, bool>`, but the call's `calleeMangledName` was still
the open-form string. The fix in
[codegen.js:cloneAstWithSubstitution](../../src/jsyoopcodegen/codegen.js):
when a `CALL_EXPRESSION` carries `calleeMethodOf` (a concrete struct
type) + `calleeTrait`, re-derive `calleeMangledName` against the
substituted receiver.

### 4. Nested generic type args in `implements` clauses

`MapIter<K, V> implements Iterable<MapEntry<K, V>>` — the type
argument `MapEntry<K, V>` mentions the type-decl's own params (`K`,
`V`). The impl-clause resolver in
[typecheck.js:validateImplBlock](../../src/jsyooptypecheck/typecheck.js)
wasn't threading the decl's `paramScope` into the resolution ctx;
bare `K`/`V` resolved to nothing. Fix: pass `typeParamScope` when
the type-decl is generic.

### 5. Reserve `entry` as an LLVM-collision name

Every function emission writes an `entry:` basic-block label.
`for entry in map_iter(...)` allocated `%entry = alloca`, which
collides with the label's `%entry` reference at the LLVM level
(SSA values and basic-block labels share a namespace). Phase 10.H's
slot uniquifier didn't know about this. Fix: seed `usedSlots` with
`"entry"` at function entry so the user binding falls through to
`entry.1` for the first use — no code-level renaming needed.

## Verification

- [examples/pass/set_smoke.yoop](../../examples/pass/set_smoke.yoop)
  — `Set<string>` insert/contains/remove + duplicate detection +
  Disposable auto-cleanup.
- [examples/pass/deque_smoke.yoop](../../examples/pass/deque_smoke.yoop)
  — `Deque<int32>` push/pop on both ends, growth past the load
  threshold, empty-pop returning `None`.
- [examples/pass/map_iter.yoop](../../examples/pass/map_iter.yoop)
  — `for e in map_iter(ref m)` over `Map<int32, int32>`, summing
  keys and values via `Iterable<MapEntry<K, V>>`.
- Full suite green: **551 tests**.

## Deferred

- **`std/http/Headers` migration to `Map<string, string>`**. The
  current linear-scan vec semantics differ from a hash map in three
  ways: case-insensitive lookup, duplicate-key behavior (multi-value
  headers like `Set-Cookie`), and iteration order. The original plan
  flagged this as a "benchmarked switchover" rather than a
  mechanical migration; it deserves its own sub-phase with a
  case-insensitive `KeyOps<string>` (lowercased FNV-1a +
  `string_eq_ignore_ascii_case`) and a separate multi-value story.
- **Iter invalidation under mutation**. The current `MapIter`
  borrows the map's backing arrays; a `map_insert` that triggers a
  rehash leaves the iter dangling. The compiler doesn't enforce
  "don't mutate the source during iteration" — that's caller
  discipline today. A real fix needs a "borrowed" kind or an iter
  version-tag check; both are larger language changes.
- **`Vec<T>` `Iterable<T>` impl**. Not landed in this sub-phase; the
  array form `for x in vec_as_array(ref v)` covers immediate cases.
- **`Set<K>` / `Deque<T>` iteration**. Same shape as `MapIter` —
  bolt on when a consumer wants it.

## Critical files touched

- [std/collections/map.yoop](../../std/collections/map.yoop) —
  `MapEntry`, `MapIter`, `map_iter`, `int64_key_ops`,
  `uint64_key_ops`, `bytes_key_ops`.
- [std/collections/set.yoop](../../std/collections/set.yoop) — new
  module.
- [std/collections/deque.yoop](../../std/collections/deque.yoop) —
  new module.
- [src/jsyoopcodegen/codegen.js](../../src/jsyoopcodegen/codegen.js)
  — `flushInstances` closure + cross-module fixed-point; trait
  method re-mangle in `cloneAstWithSubstitution`; `entry`
  pre-reserved in `createLocalSymbols`.
- [src/jsyooptypecheck/instantiate.js](../../src/jsyooptypecheck/instantiate.js)
  — `instantiateStruct` substitutes methods + implementsTraits
  through a cycle-safe early-cache pattern.
- [src/jsyooptypecheck/typecheck.js](../../src/jsyooptypecheck/typecheck.js)
  — impl-clause args see the decl's `typeParamScope`.
- [examples/pass/set_smoke.yoop](../../examples/pass/set_smoke.yoop),
  [examples/pass/deque_smoke.yoop](../../examples/pass/deque_smoke.yoop),
  [examples/pass/map_iter.yoop](../../examples/pass/map_iter.yoop)
  — new fixtures.
- [src/e2e.test.js](../../src/e2e.test.js) — three new entries.
