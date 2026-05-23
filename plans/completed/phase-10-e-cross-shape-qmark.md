# Phase 10.E — Cross-shape `?` propagation via `Into<T>` ✓ landed

> Phase 9.H taught `?` to propagate over Result-shaped enums but rejected
> any case where the operand's `Err` payload type differed from the
> enclosing function's `Err` payload type. That made every cross-module
> error pipeline a hand-rolled `switch`. Phase 10.E lifts that restriction
> through a new `Into<T>` trait: when the typechecker sees a `?` whose
> operand and return `Err` payloads disagree, it looks for an
> `Into<RetErr>` impl on the operand-Err type and threads the call onto
> the failure branch.
>
> The surface design — recommended by the parent plan as "an explicit
> conversion trait" — picks `Into<T>` over Rust's `From<T>` because yoop's
> trait methods always take `ref self`. With `Into<T>`, the source type is
> `self` and the target is the trait parameter, so the natural read is
> "IoError implements Into<AppError>" — "an IoError can be converted into
> an AppError" — and the existing trait-method machinery emits the right
> code without any special-casing of receiver position.

## What landed

### Std-library trait

[std/core/traits.yoop](../../std/core/traits.yoop) gains one trait:

```yoop
export trait Into<T> {
    function into(ref self): T;
}
```

It's a normal generic trait — instantiated lazily by the Phase 7.1
registry the moment any user writes `implements Into<X>`. No marker, no
compiler-side recognition by identity. The typechecker matches the trait
purely by name in `implementsTraits`, the same way `Iterable<T>` is
recognized by the for-in lowering. Users can technically define a
different `Into` in another module; the impl wins as long as it's the one
visible at the `?` site.

### Typechecker

[src/jsyooptypecheck/checkExpr.js](../../src/jsyooptypecheck/checkExpr.js)
`resolveTryOp` now splits the same-type fast path (Phase 9.H) from the
cross-shape path (Phase 10.E). When the operand-Err and return-Err
`typesEqual` check fails, the new helper `lookupIntoImpl(sourceType,
targetType, ctx)` searches `sourceType.implementsTraits` for a trait
named `Into` whose registry-recorded type-args list is exactly
`[targetType]`. A hit stamps `node.tryConvert = { mangledName,
targetType }` and resumes; a miss emits a fix-it pointing at the missing
trait impl. Same-type calls still take the original zero-overhead path —
the conversion gate is paid only when shapes actually differ.

The lookup re-fetches the canonical struct from the right module's
`structTable` before reading `implementsTraits`. Without that, the struct
pulled out of an enum-payload field is the pass-A shell with an empty
trait list, and even a present impl wouldn't be visible. Mirrors the
Phase 10.B `Iterable` lookup.

Only struct payload types are eligible — primitives, enums, voids, etc.
fall through to the same diagnostic the original 9.H gate emitted because
they can't carry an `implementsTraits` list today.

### Codegen

[src/jsyoopcodegen/codegen.js](../../src/jsyoopcodegen/codegen.js)
`emitFailEnumReturn` (single-module) and `emitFailEnumRet` (multi-module)
both grow a `tryNode` parameter and branch on `tryNode.tryConvert`. The
fast path is unchanged: GEP into the operand's `Err` payload, load the
field, store it into the return's `Err` payload, then `ret`. The
cross-shape path GEPs to the operand-Err payload pointer (we already had
it for the bit-copy) and calls
`@<sourceModule>__<SourceName>__Into__into(ptr <payloadPtr>)` — the
standard trait-method mangle from Phase 7.4 — and stores the returned
target value into the return slot. The trait-method body is already
emitted by the existing trait-impl path; no new symbol-emission work.

The fallible-enum path stays the only entry point — Phase 10.X retired
the struct-fallible shape, so we only had two codegen sites to update.

### Verification

- [examples/pass/qmark_cross_shape_into.yoop](../../examples/pass/qmark_cross_shape_into.yoop)
  — `Result<int32, IoError>` from `parse_positive`, propagated through
  `?` into a `Result<int32, AppError>` returner. `IoError` impls
  `Into<AppError>` and tags the converted value with `tag: 7`, which the
  test reads back from the failure path to prove the conversion ran (a
  bit-copy of the operand payload would not produce the tag).
- [examples/fail/qmark_cross_shape_no_into.yoop](../../examples/fail/qmark_cross_shape_no_into.yoop)
  — same shape minus the `Into<AppError>` impl. Asserts the new
  ``no `Into<struct AppError>` impl on struct IoError`` diagnostic.
- Full suite green: **558 tests**.

## Deferred

- **Bidirectional `From` and `Into`.** Today only `Into<Target>` on the
  source is recognized; a symmetric `From<Source>` on the target — which
  would let library authors define the conversion at whichever end is
  more natural — would need a second lookup table in `resolveTryOp` plus
  a second mangle in codegen. Either form composes the same way at the
  call site, and the source-side `Into` is enough to unblock every
  current consumer (`std/http` + `std/net` calling into user-defined Err
  enums), so the symmetry waits for a real ergonomic complaint.
- **`?` chained over `Display`-style context strings.** SPEC §11.6
  reserves `expr? "loading config"` as a context-prepending form. For
  enum errors the payload is whatever the user puts there, so attaching
  a string requires either a per-payload-type hook or a blessed
  "context-attachable" sub-trait. Out of scope here; Phase 10.E only
  fixes the type-shape gap.
- **Non-struct Err payloads.** `Into<T>` requires `implementsTraits`,
  which structs carry but enums, primitives, refs, arrays, and unions
  do not. A real consumer that wants `?` between, say, an enum-payload
  Err and a struct-payload Err can hand-roll the switch today; if this
  comes up enough we'd lift `implementsTraits` onto EnumType (and
  re-validate the impl-validation pipeline against the new home).

## Critical files touched

- [std/core/traits.yoop](../../std/core/traits.yoop) — `Into<T>` added.
- [src/jsyooptypecheck/checkExpr.js](../../src/jsyooptypecheck/checkExpr.js)
  — `resolveTryOp` cross-shape branch + `lookupIntoImpl` helper.
- [src/jsyoopcodegen/codegen.js](../../src/jsyoopcodegen/codegen.js) —
  both `emitFailEnumReturn` (single-module) and `emitFailEnumRet`
  (multi-module) gained the conversion branch.
- [examples/pass/qmark_cross_shape_into.yoop](../../examples/pass/qmark_cross_shape_into.yoop),
  [examples/fail/qmark_cross_shape_no_into.yoop](../../examples/fail/qmark_cross_shape_no_into.yoop)
  — fixtures.
- [src/e2e.test.js](../../src/e2e.test.js) — pass + fail entries.
- [SPEC.md §11](../../SPEC.md) — cross-shape paragraph updated from
  "deferred" to a description of the `Into<T>` rewrite.
