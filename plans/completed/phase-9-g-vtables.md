# Phase 9.G - `vtable T for Trait` runtime polymorphism + function value types

## Context

Plan: [plans/phase-9.md §9.G](phase-9.md#phase-9g--vtable-t-for-trait-runtime-polymorphism--function-value-types).
Library rationale: [library-design.md §8 questions 1–3](../archive/library-design.md#8-open-language-questions-the-library-exposes).

Before 9.G, the only polymorphism yoop had was generics + trait bounds
(Phase 7.1/7.2) - every trait-dispatching function monomorphized per
concrete impl type. That meant **heterogeneous handler lists were
impossible**: a `Handler[]` couldn't hold three structurally-distinct
impls of `trait Handler` because each monomorphization was a distinct
type. The natural shape - a router whose slots are a mix of stateful
handlers - had to be hand-rolled with `unsafe_ptr<void>` plus parallel
function-pointer fields, with no compiler help.

This phase adds Zig-style runtime polymorphism: function value types in
type position via `=>`, and a `vtable T for Trait { ... }` decl that
declares a type-erased shape backing a trait. No magic `dyn`, no
separate type category - a vtable is a normal nominal struct the
compiler builds for you.

## What landed

### Surface syntax

```yoop
trait Handler {
    function handle(ref self, req: int32): int32;
}

type Const implements Handler {
    value: int32,
    function handle(ref self, req: int32): int32 { return self.value; }
}

vtable Dispatcher for Handler {
    handle: (req: int32) => int32,
}

function main(): int32 {
    let c: Const = { value: 5 };
    let d: Dispatcher = Dispatcher.from(ref c);  // builder
    let r: int32 = Dispatcher.handle(ref d, 7);  // indirect dispatch
    return 0;
}
```

Two new tokens (`fatArrow` for `=>`, `vtable` keyword) and one new
top-level decl (`VTABLE_DECL`). The implicit `ctx: unsafe_ptr<void>`
first field is added by codegen - the user never names it. Field order
in the vtable's body is irrelevant; method-slot indices follow the
trait's method declaration order.

### Type system

Two new entries in `typeKinds`:

- `FunctionPointerType { params, returnType }` - what `(p: T) => R`
  resolves to in any type-annotation slot. Distinct from `FuncType`
  (which describes named function decls) so call resolution can tell
  the two apart: FuncType callees resolve to a global mangled symbol,
  FunctionPointerType callees lower to an indirect call.
- `VTableType { name, traitName, traitModuleId, fields, methodOrder,
  moduleId }` - a nominal struct-like type whose `fields` are
  FPT-typed entries in trait declaration order. Compared by
  `(name, moduleId)` like structs/enums/unions.

`typesEqual`, `formatType` (`errors.js`), `formatAnnotation`, and the
`resolveTypeAnnotation` family all gained cases for both. Per-module
`vtableTable` joins the `structTable`/`enumTable`/`unionTable` family.

### Pass A / Pass C wiring

- Pass A registers a `VTableType` shell carrying only the trait
  *name* - the trait reference + field FPTs resolve in pass C.3b
  (`validateVTableDecl`) after impl blocks are validated and trait
  method sigs are populated. Validation enforces: trait exists, every
  trait method has a matching vtable field, FPT signature matches the
  trait method's signature minus the leading `ref self`, no
  duplicate / unknown / missing fields.
- Generic traits are rejected with a clear "deferred" diagnostic at
  the decl site.

### Expression resolution

- `VTableName.from(ref x)`: recognized inside `resolveCall` before the
  trait-call branch. Validates `x: ref T` where T implements the
  vtable's trait, stamps `node.vtableBuilder = { vtableType, implType }`
  for codegen.
- `VTableName.<method>(ref v, ...)`: forwarded to
  `resolveTraitQualifiedCall` (with the trait looked up via the
  vtable's `traitName`) - Case 3 in that function handles vtable
  receivers, substitutes the placeholder self, and stamps
  `node.vtableCall = { vtableType, methodName, fieldIndex }`.
- `Trait.<method>(ref v, ...)` where `v: VTableType` also routes
  through Case 3 directly; both spellings produce identical IR.

### Codegen

- LLVM type def: `%vtable.<mod>__<Name> = type { ptr, ptr, ptr, ... }`
  - one pointer slot for ctx + one per trait method, in trait
  declaration order. Emitted at the module-init pass alongside the
  existing struct/enum/union type defs.
- `arrayElemLlvmName` accepts vtable element types so `Dispatcher[]`
  works through the standard fat-pointer array shape - that's what
  makes heterogeneous arrays land cleanly.
- `emitVTableFromBuilder`: alloca the vtable, store the operand's
  pointer (`emitLval` on the REF_EXPRESSION's inner lvalue) at field
  0, then for each method in `methodOrder` store
  `ptr @<mangled trait method symbol>` (using the existing
  Phase 7.4 `mangleTraitMethod` scheme - no new mangling
  conventions needed).
- `emitVTableMethodCall`: GEP+load ctx (field 0) and the function
  pointer (field methodIndex+1), emit
  `call <ret> (ptr, <argTys>) %fnptr(ptr %ctx, args)`. The impl
  function expects `ref self` (a struct `ptr`) as its first arg -
  ctx is exactly that, so the indirect-call signature matches the
  direct-call signature byte for byte.

### Parser ergonomics

`from` is a keyword (used in `import { ... } from "..."` and
`extern "C" from "..."`), so naive field-access parsing rejected
`VTableName.from(...)`. The fix: in the FIELD_ACCESS path, allow `from`
in addition to a bare IDENT as the field name. The keyword stays
reserved everywhere else.

## Verification

- E2E pass: [examples/pass/vtable_handlers.yoop](../../examples/pass/vtable_handlers.yoop)
  - three different impl types (`Const` / `AddOffset` / `Scale`)
  registered into one heterogeneous `Dispatcher[]`, dispatched
  through a single `fan_out(ref Dispatcher[], int32)` function that
  has zero knowledge of the underlying impl types. This is the
  canonical shape that pre-9.G generic monomorphization made
  impossible.
- E2E fail: [examples/fail/vtable_field_sig_mismatch.yoop](../../examples/fail/vtable_field_sig_mismatch.yoop)
  and [examples/fail/vtable_from_non_implementor.yoop](../../examples/fail/vtable_from_non_implementor.yoop)
  exercise the typechecker rejection paths.
- Parser unit tests under *"Phase 9.G.1: `=>` function value type
  annotations"* cover the type-annotation surface.
- Full suite green (561 tests).

## Deferred

- **`vtable Trait` sugar** (auto-derived field list - no `for`-clause
  body). Lands as a follow-up once the explicit form has shipped.
- **Closures.** The hand-rolled capture-struct + `vtable T for Trait`
  workaround remains the official answer; synthesizing capture
  structs requires its own multi-phase plan (capture-by-ref vs
  by-value, allocation strategy). See
  [library-design.md §8 q3](../archive/library-design.md#8-open-language-questions-the-library-exposes).
- **Generic-trait vtables** (`vtable Reader<T> for Readable<T>`).
  Requires threading the type-param scope through vtable decls and
  validating field FPTs against substituted trait methods. The
  current code rejects generic traits at the decl site with a
  clear "deferred" diagnostic.
- **Trait bounds quantifying over a vtable** (`<T implements Reader>`
  where `Reader` is a vtable). The current pattern is to take
  `ref r: Reader` directly - concrete type, monomorphization-free.
- **Trait-object parameters via `dyn Trait`**. Out - the vtable form
  is the official surface for type-erased polymorphism.
