# Phase 9.H — `?` over Result-shaped enums

## Context

Plan: [plans/phase-9.md §9.H](../phase-9.md#phase-9h----over-enum-shaped-errors).

Pre-9.H, `?` only understood structs ending in `err: string` (Phase 2 design).
With Phase 7.5 enums + variant patterns + exhaustiveness in, the standard
`enum Result<T, E> { Ok { value: T }, Err { error: E } }` shape was
*expressible* but `expr?` on a `Result` was a typecheck error — users had to
hand-roll the early-return or convert to a struct fallible at the API
boundary. This phase teaches `?` the second shape.

## What landed

- Two new helpers in [src/jsyooptypecheck/fallible.js](../../src/jsyooptypecheck/fallible.js):
  `isFallibleEnum(t)` (structural recognizer — exactly two variants named
  `Ok` and `Err`, each with 0 or 1 fields), `strippedEnumOkType(t)` (what
  `expr?` yields), and `enumErrPayloadType(t)` (what propagates).
- `resolveTryOp` in [src/jsyooptypecheck/checkExpr.js](../../src/jsyooptypecheck/checkExpr.js)
  dispatches on operand kind: enum → fallible-enum path, otherwise existing
  struct-fallible path. Enum operands tag the AST node with
  `fallibleEnum: true` so codegen knows which lowering to pick.
- Cross-shape propagation is **rejected**: the enclosing function's return
  type must also be a fallible enum with a `typesEqual` `Err` payload.
  Struct ⇄ enum and enum ⇄ different-Err-payload conversions need an
  explicit `From` trait or per-`?` conversion clause (deferred).
- Codegen: new `emitTryOpEnumToSlot` / `emitTrySlotEnum` (single- and
  multi-module paths) read the i32 tag at field 0, compare to the `Err`
  ordinal, fail-branch builds the enclosing return's `Err` variant carrying
  the operand's `Err` payload field-for-field, and `ret`s. The Ok-branch
  resumes; the TRY_OP expr handler extracts the Ok variant's payload field
  by GEP through `%enumv.<id>__Ok`.
- Both `emitFailEnumReturn` (single-module) and `emitFailEnumRet`
  (multi-module) handle the no-payload `Err` case (skip the payload copy).

## Verification

- E2E pass: [examples/pass/fallible_enum_qmark.yoop](../../examples/pass/fallible_enum_qmark.yoop)
  — `IntResult { Ok { value: int32 }, Err { error: int32 } }`, propagates
  through `add_two_positives`, switch-destructures the result.
- E2E fail: [examples/fail/qmark_enum_in_non_fallible_fn.yoop](../../examples/fail/qmark_enum_in_non_fallible_fn.yoop)
  asserts the new "requires the enclosing function to return a fallible
  enum" diagnostic.
- Full test suite green (557 tests).

## Deferred

- **Cross-shape propagation.** Enum-`Err: string` ⇄ struct-`err: string`
  conversion at a `?` site is the obvious follow-up — every std/http +
  std/net function still returns struct-fallibles, so today users have to
  unwrap into a switch to bridge an enum-`Err` into a struct-`err` return.
  An explicit conversion form (`expr? as Err::Kind`) or a `From` trait is
  the standard path.
- **`?`-attaches-context** on enum errors. The reserved `? "loading config"`
  suffix from SPEC §11 still applies only to struct fallibles; for enums,
  the `Err` payload is whatever the user puts there and the context-attach
  story would need a per-payload-type hook.
