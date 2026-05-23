# Phase 10.B — `Iterable<T>` trait + `for ... in` over user types ✓ landed

> Phase 9.D shipped `for x in xs` for arrays only because `Iterable<T>`
> needed generic enums (`enum IterStep<T> { ... }`) for its return shape.
> Phase 10.A unblocked generic enums; Phase 10.B wires them into the
> existing `for ... in` syntax so any user type implementing
> `Iterable<T>` works the same way `T[]` already does.

## What landed

- **`std/core/traits.yoop`** grew two new exports
  ([std/core/traits.yoop](../../std/core/traits.yoop)):
  ```yoop
  export enum IterStep<T> {
      Yield { value: T },
      Done,
  }

  export trait Iterable<T> {
      function next(ref self): IterStep<T>;
  }
  ```
  The trait is generic; the existing Phase 7.1/7.4 machinery handles the
  instantiation and trait-method dispatch.

- **Typechecker** now accepts a struct whose `implementsTraits` contains
  `Iterable<U>` as the RHS of `for ... in`. The element type `U` is
  pulled from the impl's `next` method's return type
  (`IterStep<U>` — the typechecker walks the `Yield` variant's `value`
  field). The check lives in `checkForInLoop` at
  [src/jsyooptypecheck/checkStatement.js](../../src/jsyooptypecheck/checkStatement.js).
  Failure modes (no `Iterable` impl on the struct, malformed `next`
  signature) produce specific diagnostics.

- **Codegen** lowers the iterable-impl form to a call-tag-branch loop —
  shape:
  ```
  alloca iter_slot ; store iter_value
  top:
    step = call Iterable.next(ref iter_slot)
    alloca step_slot ; store step
    tag = load i32, step_slot[0]
    br tag == YieldOrdinal ? body : after
  body:
    elem = step_slot.Yield.value
    store elem -> loop_var
    <user body>
    br top
  after:
  ```
  Lives as `emitForInLoopIterable` (single-module) and
  `emitForInLoopIterableStmt` (multi-module) in
  [src/jsyoopcodegen/codegen.js](../../src/jsyoopcodegen/codegen.js).
  The array path is unchanged — it's the fast path and stays.

- **Ownership semantics**: the loop owns a mutable copy of the iterator.
  `for x in my_iter { ... }` leaves the caller's `my_iter` binding
  untouched (the loop walks a local copy); `for x in make_iter() { ... }`
  walks the freshly-returned iterator. The choice keeps user expectations
  simple — no surprise mutation of named bindings.

## Verification

- **Positive**: [examples/pass/forin_iterable.yoop](../../examples/pass/forin_iterable.yoop)
  defines a `Counter implements Iterable<int32>` and walks it three
  ways (named binding, function-returned iterator, with `break`).
  Confirms ownership (`c.cur` is still 0 after the loop) and that
  `break` exits the new loop form cleanly.
- **Negative**:
  [examples/fail/forin_non_iterable_struct.yoop](../../examples/fail/forin_non_iterable_struct.yoop)
  expects a diagnostic when the RHS is a struct without an
  `Iterable<T>` impl. The previous
  `forin_non_array.yoop` fixture covers the non-struct case
  (its diagnostic message was updated to mention `Iterable<T>`).
- **e2e**: [src/e2e.test.js](../../src/e2e.test.js) gained one positive
  + one negative entry. Existing forin_basic + array-form coverage is
  unchanged.
- Full test suite green (544 tests).

## Deferred

- **`vtable Iter<T> for Iterable<T>`** — Phase 9.G rejected vtables over
  generic traits. Lifting that restriction is small but distinct work;
  until it lands, `for` over a heterogeneous iterator pipeline requires
  the concrete type at the use site. Plan doc in
  [plans/phase-10.md §10.B](../phase-10.md).
- **Built-in `Iter_array<T>`** that exposes an Iterable view of an
  array. The current array form is hard-wired in codegen and doesn't
  need it; if a future generic API wants "anything iterable, including
  T[]" the array gets a synthetic impl at that point.
- **Disposable iterators**. The current lowering doesn't fire the iter's
  `Disposable.dispose` at loop exit. Real iterators that own resources
  (file streams, sockets) are rare in current code; when they appear the
  loop will need to either auto-dispose at scope end or require an
  explicit `disposable` keyword on the loop binding.
- **`Iterable<T>` adapter combinators** (`.map`, `.filter`, `.collect`).
  Each is a small struct that holds an inner iterator + a transform.
  Library work; not part of this phase's lowering.

## Critical files touched

- [std/core/traits.yoop](../../std/core/traits.yoop) — trait + enum
  decls.
- [src/jsyooptypecheck/checkStatement.js](../../src/jsyooptypecheck/checkStatement.js)
  — `checkForInLoop` extended.
- [src/jsyoopcodegen/codegen.js](../../src/jsyoopcodegen/codegen.js) —
  `emitForInLoopIterable` (and `Stmt` twin).
- [examples/pass/forin_iterable.yoop](../../examples/pass/forin_iterable.yoop)
  — positive fixture.
- [examples/fail/forin_non_iterable_struct.yoop](../../examples/fail/forin_non_iterable_struct.yoop)
  — negative fixture.
- [src/e2e.test.js](../../src/e2e.test.js) — fixture registrations.
