# Phase 10.C.2 - Generic `Map<K, V>` ✓ landed

> The pure-library follow-up to Phase 10.X.2's function-pointer
> struct-field lifts. The earlier `StringMap<V>` (Phase 10.C) is
> replaced with a fully generic `Map<K, V>` keyed off a `KeyOps<K>`
> behavior pack carrying `hash` + `eq` function pointers. Pre-built
> ops for `string` and `int32` ship alongside.

## What changed

### `std/collections/map.yoop`

- New exported `KeyOps<K> { hash: (k: K) => uint64, eq: (a: K, b: K) => bool }`.
  Two function-pointer fields supplied by the caller; the map dispatches
  through them. This is the language's stand-in for a `Hashable` trait
  whose `eq` would want `Self` - yoop doesn't model `Self` yet, and a
  generic `Hashable<K>` wouldn't carry its weight with only `Map<K, V>`
  as a consumer. If `Self` lands later, `KeyOps<K>` becomes a thin shim
  over `trait Hashable`.
- `Map<K, V>` replaces `StringMap<V>`. Same open-addressing layout
  (parallel `keys`/`values`/`states` arrays, power-of-two cap, 75%
  load factor, tombstone deletion); the only difference is `keys: K[]`
  + `ops: KeyOps<K>` instead of hardcoded string keys + inline
  `string_hash`/`string_eq` calls.
- Pre-built ops:
  - `string_key_ops(): KeyOps<string>` - wires `string_hash` +
    `string_eq` from `std/core/strings.yoop`. Pure cross-module FPT
    coercion (validated this case worked end-to-end).
  - `int32_key_ops(): KeyOps<int32>` - a Knuth multiplicative
    scrambler for the hash, `==` for equality.

API (all functions generic over `<K, V>`):

| Function | Returns | Notes |
|---|---|---|
| `map_new<K, V>(initial_cap, ops)` | a fresh map | `propagates<disposable>` |
| `map_insert<K, V>(ref m, k, v)` | `true` on overwrite, `false` on fresh | |
| `map_get<K, V>(ref m, k)` | `Option<V>` | |
| `map_contains_key<K, V>(ref m, k)` | `bool` | |
| `map_remove<K, V>(ref m, k)` | `true` if an entry was removed | tombstones the slot |
| `map_len<K, V>(ref m)` | `usize` | occupied entries (no tombstones) |
| `map_clear<K, V>(ref m)` | `void` | reset, keep buffers |

### One compiler-side fix this surfaced

Cross-module function-decl-as-FPT-value was tagged as deferred in
[phase-10-x2-fn-ptr-fields.md](phase-10-x2-fn-ptr-fields.md) - likely
worked but unverified. Verifying showed it didn't: the typechecker
only stamped `calleeModuleId` / `calleeExportName` on
CALL_EXPRESSION nodes (at the call-site path), not on bare IDENT
references in expression position. So `{ hash: string_hash }` where
`string_hash` is imported from another module crashed at link time
with `use of undefined value '@<caller-module>__string_hash'`.

The fix in [checkExpr.js:resolveIdent](../../src/jsyooptypecheck/checkExpr.js):
when the IDENT resolves to a module-level FuncType *and* it's
imported, stamp the same two slots that the call-site path already
sets. The codegen-side IDENT-as-fn-ptr emission (which already
honored those slots) now finds the right mangled symbol for both
local and imported function names.

## Verification

- [examples/pass/map_smoke/main.yoop](../../examples/pass/map_smoke/main.yoop)
  - rewritten to use `Map<string, int32>` + `string_key_ops()`.
  Exercises insert/overwrite/get/contains/remove/grow + the
  Disposable lifecycle. Identical expected output to the previous
  `StringMap<int32>` form.
- [examples/pass/map_int32_keys.yoop](../../examples/pass/map_int32_keys.yoop)
  - new fixture for `Map<int32, string>` via `int32_key_ops()`.
  Covers the integer-keyed shape with `Option<string>` returns and
  tombstoned removals.
- Full suite green: **548 tests**.

## Deferred / out of scope

- **`bytes` / `int64` / `uint64` `KeyOps` helpers**. The two we
  shipped (`string`, `int32`) cover the marquee shapes; the others
  are mechanical follow-ups whenever a consumer wants them.
- **`Hashable` trait + `Self` in trait sigs**. If yoop grows `Self`,
  `KeyOps<K>` becomes redundant - `Map<K, V>` could take any
  `K implements Hashable`. Not a forcing function today.
- **Map iteration** (`MapIter<K, V>` implementing `Iterable<MapEntry<K, V>>`).
  Mechanical given Phase 10.B; deferred until a consumer wants it.
- **`Set<K>`** - wraps `Map<K, void>`-shaped or stores no values.
  Pure library work.
- **Migrate `std/http/Headers` to `Map<string, string>`**. The
  current linear-scan vec is fine for small N; switching has its own
  benchmark + correctness story.

## Critical files touched

- [std/collections/map.yoop](../../std/collections/map.yoop) -
  full rewrite to the generic form.
- [src/jsyooptypecheck/checkExpr.js](../../src/jsyooptypecheck/checkExpr.js)
  - IDENT-resolve-as-imported-FuncType tagging.
- [examples/pass/map_smoke/main.yoop](../../examples/pass/map_smoke/main.yoop)
  - converted to the generic API.
- [examples/pass/map_int32_keys.yoop](../../examples/pass/map_int32_keys.yoop)
  - new fixture.
- [src/e2e.test.js](../../src/e2e.test.js) - fixture entries.
