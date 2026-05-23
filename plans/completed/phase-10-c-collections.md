# Phase 10.C — `std/collections/` (StringMap<V>) ✓ landed (partial)

> Phase 10.A unblocked generic enums and Phase 10.B wired `Iterable<T>`.
> 10.C is the first user of both: a real hash-based collection, plus
> `Option<T>` and the codegen plumbing that container code reveals.
>
> This sub-phase shipped the marquee piece — a **string-keyed hash map**
> with `Option<V>` returns — plus two compiler fixes that any
> generics-heavy module would have hit. Set/Deque and a fully generic
> `Map<K, V>` are deferred to follow-up sub-phases (see below).

## What landed

### `Option<T>` in `std/core/types.yoop`

```yoop
export enum Option<T> {
    Some { value: T },
    None,
}
```

Naming intentionally diverges from `Result`'s `Ok`/`Err` so `?` doesn't
fire on `Option<T>` — an Option doesn't carry an error to propagate.
`map_get` returning `Option<V>` exercises the new shape end-to-end.

### `string_hash` in `std/core/strings.yoop`

FNV-1a over the underlying UTF-8 bytes. Stable across runs but not
cryptographically secure. Empty string hashes to the FNV offset basis.

### `StringMap<V>` in `std/collections/map.yoop`

Open-addressing hash table with linear probing. State:

- `keys: string[]`, `values: V[]`, `states: uint8[]` (parallel arrays).
- `states[i]` is one of `EMPTY` / `OCCUPIED` / `TOMBSTONE`. Tombstones
  keep probe chains correct after deletion; they're only cleared on
  rehash.
- `cap` is always a power of two; bucket = `hash & (cap - 1)`. `map_new`
  rounds the user's hint up to the next power of two with a floor of 8.
- Grow at 75% load factor over `used = OCCUPIED + TOMBSTONE` (double the
  cap, drop tombstones during rehash).
- `Disposable` + `propagates<disposable>`; one `dispose` frees all three
  backing buffers.

API:

| Function | Returns | Notes |
|---|---|---|
| `map_new<V>(initial_cap: usize): StringMap<V>` | a fresh map | `propagates<disposable>` |
| `map_insert<V>(ref m, k, v): bool` | `true` on overwrite, `false` on fresh | |
| `map_get<V>(ref m, k): Option<V>` | `Some { value }` or `None` | |
| `map_contains_key<V>(ref m, k): bool` | | |
| `map_remove<V>(ref m, k): bool` | `true` if an entry was removed | tombstones the slot |
| `map_len<V>(ref m): usize` | occupied entries (tombstones excluded) | |
| `map_clear<V>(ref m): void` | reset to empty, keep backing buffers | |

### Two compiler fixes that container code surfaced

**`cloneAstWithSubstitution` re-fetches `resolvedVariant`.** When a
generic function body contains `Option.Some { value: x }`, the
typechecker stamps `resolvedEnumType = Option<V>` and
`resolvedVariant = (a record pointing at the open enum's variant)`. The
substitution walk replaces `resolvedEnumType` with the concrete
`Option<int32>` (immutable types get re-instantiated through the frozen
branch), but `resolvedVariant` was a plain non-frozen record whose
recursive clone left its `fields[i].type` pointing at the old, still-open
variant. The fix re-fetches `resolvedVariant` from the substituted
`resolvedEnumType.variants` map after the clone walks the rest of the
node ([codegen.js:cloneAstWithSubstitution](../../src/jsyoopcodegen/codegen.js)).
Without this, codegen tripped on a `TypeParamType` reaching
`llvmType` from `emitVariantConstructor`.

**Generic-instance emission is now a fixed-point.** The per-module
emission walk iterates `funcInstancesByDecl` and emits each concrete
instance. But cloning an outer instance can register additional inner
instances (`map_insert<int32>` → `find_insert_slot<int32>` via the
re-instantiation logic in `cloneAstWithSubstitution`), and those land
on a different declId entry the outer loop may have already passed.
The fix wraps the emission walk in a `while (progressed)` loop — keep
sweeping until a full pass produces no new emissions
([codegen.js around emitGenericFuncInstance](../../src/jsyoopcodegen/codegen.js)).
The header comment on `serve_n` in `std/http/server.yoop` referenced
this gap as a known limitation; that note can come down once a
generic-calls-generic HTTP helper is needed.

## Verification

- **Smoke fixture**:
  [examples/pass/map_smoke/main.yoop](../../examples/pass/map_smoke/main.yoop)
  exercises insert (fresh + overwrite), `Option<V>` get (hit + miss),
  `contains_key`, remove with probe-chain preservation, `len`, and a
  cross-grow burst that forces rehash past the load-factor threshold.
- **e2e**: registered in [src/e2e.test.js](../../src/e2e.test.js)
  under "map_smoke".
- Full test suite green (545 tests).

## Deferred to follow-up sub-phases

- **Generic `Map<K, V>` for arbitrary key types.** Two prerequisites,
  neither in:
  1. Either `Self` in trait signatures (Phase 5 deferred — needed for
     a `trait Hashable { hash; eq(ref self, ref other: Self): bool; }`),
     **or**
  2. A `KeyOps<K>` struct holding function-pointer fields plus two
     small codegen lifts: (a) coerce a top-level function decl to a
     matching `(p: T) => R` function-pointer value at the assignment
     site, and (b) lower `struct.field(args)` calls when the field has
     a function-pointer type. Phase 9.G shipped function value *types*
     and vtables-for-traits but didn't generalize FPT-as-struct-field
     to those two cases.

  Either lift is small (~50–80 LOC each) but a meaningful feature
  add — separate sub-phase work. Until then, string keys cover the
  marquee use case (HTTP `Headers`, env-like configs).
- **`Set<K>`**. Once the generic `Map<K, V>` lands, `Set<K>` is a
  ~30-line wrapper.
- **`Deque<T>`**. Ring buffer over `Vec<T>`. No new compiler features
  needed; pure library work.
- **`Vec<T>` `Iterable<T>` impl.** A small `VecIter<T>` struct that
  holds `{data, len, i}` and implements `Iterable<T>`. Defers until
  the first consumer wants `for x in my_vec` — the existing
  array form on `vec_as_array(ref v)` covers the immediate cases.
- **Map iteration.** `MapIter<V>` walking occupied slots, yielding
  `MapEntry<V> { key: string, value: V }` via `Iterable<MapEntry<V>>`.
  Mechanical once a user needs it.
- **Migrate `std/http/Headers` to `StringMap<string>`.** The current
  linear-scan vec is correct and the `headers_get`/`headers_has`
  hot-paths are usually tiny — benchmarking the switchover is its own
  story. Leaving as-is.

## Critical files touched

- [std/core/types.yoop](../../std/core/types.yoop) — `Option<T>`.
- [std/core/strings.yoop](../../std/core/strings.yoop) — `string_hash`.
- [std/collections/map.yoop](../../std/collections/map.yoop) — new
  module with `StringMap<V>`.
- [src/jsyoopcodegen/codegen.js](../../src/jsyoopcodegen/codegen.js)
  — `cloneAstWithSubstitution` variant re-fetch, generic-instance
  emission fixed-point.
- [examples/pass/map_smoke/main.yoop](../../examples/pass/map_smoke/main.yoop)
  — smoke fixture.
- [src/e2e.test.js](../../src/e2e.test.js) — fixture registration.
