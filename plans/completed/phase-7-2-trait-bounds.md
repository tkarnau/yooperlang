# Phase 7.2 - Trait bounds on generics

## Context

Phase 7.1 ([phase-7-1-generics.md](phase-7-1-generics.md)) landed user-defined generic structs, functions, and traits - including the substitution machinery, the per-decl `genericStructTable`/`genericFuncTable`, the instantiation registry in [instantiate.js](../src/jsyooptypecheck/instantiate.js), and call-site inference for generic functions. What's missing is the ability to **constrain** a type parameter to types that implement a particular trait.

Spec §5 line 348 reserves the syntax:

```js
function drain<T implements Iterable<T>>(ref it: T): void;
```

Today every `T` in a generic body is treated abstractly - you can pass it around, assign it, return it, but you cannot **call a trait method on it**. That's exactly the gap trait bounds close. Without bounds, polymorphic algorithms over an interface have to inline the impl at every use site, which defeats the point of generics existing at all.

**Scope.** Trait bounds on type parameters of generic functions, generic structs, and generic traits. Single-bound only in 7.2 - `<T implements (Foo, Bar)>` (multiple bounds) is left for a follow-up. No codegen change in the simple monomorphizing path: at the time codegen sees a function, `T` has already been substituted with a concrete type, and that type's impl methods already exist as regular free functions. The new work is **constraint capture in the typechecker**, **bound-aware method resolution inside generic bodies**, and **bound checking at instantiation**.

---

## Sub-phase order

Each sub-phase is independently testable. Land them in order.

### 7.2.0 - Parser scaffolding

Reserve and parse the new syntactic position. No semantic behavior yet - the typechecker errors with "trait bounds not yet wired" until 7.2.1.

- Extend `parseTypeParamList()` (added in 7.1, in [parser.js](../src/jsyooparser/parser.js)) so each entry parses optionally as `Name implements TraitAnnotation`. The trait annotation reuses the existing `parseTypeAnnotation()` so it picks up generic trait applications (`Iterable<T>`) for free.
- Update the `TYPE_PARAM` AST node ([contracts.js](../src/contracts.js)) shape to carry an optional `bound: TypeAnnotation | null` field. Keep `name` as the primary key; nothing changes for bound-less params.
- Reject malformed shapes at parse time with a clear diagnostic: `<T implements>` (missing trait), `<T implements ,>` (empty list - when 7.2 lands as single-bound, this is just a malformed annotation; reserve "multiple bounds" for follow-up but produce a diagnostic that says so).
- Update [parser.test.js](../src/jsyooparser/parser.test.js) with parse-only assertions for `function drain<T implements Iterable<T>>(ref it: T): void;`, `type Sorted<T implements Ord> { ... }`, `trait Container<T implements Display> { ... }`.

**Done when:** all bound forms parse; the typechecker emits a clear "trait bounds not yet typechecked" error (parse pass, semantic fail - the same bridge pattern Phase 7.1.0 used for the trait-generic-rejection bridge).

### 7.2.1 - Capturing bounds on `TypeParamType`

The first semantic change. Every place a `TypeParamType` is created from a generic decl learns about its bound.

- Extend `TypeParamType` ([types.js](../src/jsyooptypecheck/types.js)) with a `bound: TraitType | null` field. `null` means unbounded - preserves the 7.1 default.
- Generic decl registration in pass A ([typecheck.js](../src/jsyooptypecheck/typecheck.js) - the existing blocks that read `d.typeParams` and build the `paramScope`) **must defer bound resolution to pass C**. Reason: a bound can reference a trait declared later in the same module, or a generic trait whose own params depend on the current decl's params (`<T implements Iterable<T>>`). Pass A only records the raw annotation; pass C resolves it once trait decls and the param scope are both available.
- New helper `resolveBoundTrait(annotation, paramScope, env)` in typecheck.js - resolves an annotation in the presence of the **current decl's own param scope** (so `<T implements Iterable<T>>` resolves the inner `T` as the same `TypeParamType` already in scope). Returns the substituted `TraitType` or a typecheck error if the trait doesn't exist.
- Mutate the `TypeParamType` to carry the resolved bound. **This is the only currently-allowed mutation of a `TypeParamType`** - call out in [CLAUDE.md](../CLAUDE.md)'s cross-cutting invariants once 7.2 lands. (Same pattern as `KindType` mutation during pass C.2 in Phase 6.)
- Extend `typesEqual` ([types.js:349](../src/jsyooptypecheck/types.js#L349)) to **ignore bounds** when comparing - two `TypeParamType`s with the same `(name, originDecl)` are still equal regardless of bound. The bound is metadata used at constraint-check time, not at identity-check time.
- Update `mangleType` ([instantiate.js:32](../src/jsyooptypecheck/instantiate.js#L32)) - also ignore bounds for mangling. A monomorphization at `T=int32` looks the same whether `T` was bounded or not.

**Done when:** every generic decl with a bound has its `TypeParamType`s carrying a resolved `TraitType`. No user-visible behavior change yet - the bound is captured but not used.

### 7.2.2 - Bound checking at instantiation

The hard check. Whenever a generic is instantiated at a concrete type arg, the arg must satisfy the bound.

- Add `checkBoundSatisfied(argType, requiredTrait, mod, moduleEnv)` in [typecheck.js](../src/jsyooptypecheck/typecheck.js). Returns `{ ok: true }` or `{ ok: false, message }`.
  - If `argType` is a `StructType`: walk its `implementsTraits` list (populated by `validateImplBlock` ([typecheck.js:236](../src/jsyooptypecheck/typecheck.js#L236))). Compare against `requiredTrait` by trait identity - for **generic** traits, compare by `(declId, instantiated argTypes)` so `Iterable<int32>` ≠ `Iterable<string>`. Reuse the existing instantiation key (`cacheKeyForArgs` from [instantiate.js:54](../src/jsyooptypecheck/instantiate.js#L54)).
  - If `argType` is another `TypeParamType` (bound checking *inside* a generic body - e.g. one generic calling another): the substitution context says nothing about the concrete trait yet. Two sub-cases:
    1. If the outer `T`'s bound trait is the same as (or `extends` - but extends is still deferred) the required trait, accept.
    2. Otherwise, error: `"type parameter T does not satisfy bound Trait - add 'implements Trait' to T's declaration"`.
  - If `argType` is a `PrimType` and the trait happens to be implemented for primitives (none today, but the door is open for built-in numeric traits later): same lookup. Today: error.
  - Otherwise error with a structured message naming the type and trait.
- Hook checking into the three instantiation entry points in [instantiate.js](../src/jsyooptypecheck/instantiate.js):
  - `instantiateStruct(registry, genericDecl, argTypes)` - before the cache lookup, walk `genericDecl.paramNames` in tandem with `argTypes` and call `checkBoundSatisfied` for each bounded param. Stash a `boundChecks` callback on the registry so this stays out of the pure-types layer.
  - `instantiateFunc` and `instantiateTrait` - same.
- Call-site inference in [checkExpr.js](../src/jsyooptypecheck/checkExpr.js) - after unification produces the substitution map, run bound checking on each `(T, inferredType)` pair *before* the instantiation registry lookup. Error early so the diagnostic points at the call site, not the registry.
- New errors flow through `pushError` ([errors.js](../src/jsyooptypecheck/errors.js)), not throws - matches the rest of the typechecker.

**Done when:** instantiating a bounded generic with a satisfying type works; instantiating with a non-satisfying type produces a typecheck error at the instantiation site, with the source location of the type argument (not the generic decl).

### 7.2.3 - Method resolution against `TypeParamType`

The payoff. Inside a generic body, calling a trait method on a value of bounded `T` resolves to the trait's method signature.

- Spec §17.2: methods are called as free functions - `dispose(ref x)`. So "calling a trait method on `T`" means a free-function call where the first argument's resolvedType is a `TypeParamType` carrying a non-null bound, and the function name matches a method on that bound.
- In `resolveExprType` for `CALL_EXPRESSION` in [checkExpr.js](../src/jsyooptypecheck/checkExpr.js): when the callee name isn't found in the module/import scope, *and* there is at least one arg whose type is a `TypeParamType` with a bound, look up the method on the bound `TraitType`. If found, the call's `resolvedType` becomes the trait method's return type (with `self` substituted by the `TypeParamType` itself - so a method returning `T` returns the same `TypeParamType`).
- Tag the call node with the trait method info so codegen knows what to emit *after substitution*. After 7.1's `cloneAstWithSubstitution` runs, the `TypeParamType` will be replaced by a concrete struct, and the bound-method-call should reduce to a normal free-function call into the impl's method - but the call node needs to carry enough info that codegen can name the right mangled symbol. The simplest encoding: tag the node with `boundMethod: { traitId, methodName }`; in `cloneAstWithSubstitution` ([codegen.js:1605](../src/jsyoopcodegen/codegen.js#L1605)), when the concrete type is in hand, rewrite the call to its monomorphic form before the IR walk.
- Ambiguity rule: if two of the call's args have different bounded `TypeParamType`s and both bounds have a method of the same name, error - same diagnostic shape as the existing "same-name method collisions" rule in Phase 5 (see [phase-5-traits.md](phase-5-traits.md)).
- This sub-phase is where `function drain<T implements Iterable<T>>(ref it: T): void { let n = next(ref it); ... }` becomes type-correct.

**Done when:** a generic function body can call a method declared on its bound, and the call typechecks against the trait method signature with `T` substituted appropriately.

### 7.2.4 - Codegen wiring + end-to-end fixtures

No new IR shapes. The work is making sure the bound-method tag from 7.2.3 lowers correctly after substitution.

- In [cloneAstWithSubstitution](../src/jsyoopcodegen/codegen.js#L1605): when visiting a `CALL_EXPRESSION` with a `boundMethod` tag, look up the impl method on the *substituted* concrete type (still using the existing free-function mangling - the trait method is already emitted as a regular free function by Phase 5/7.1 codegen). Replace the call node's callee with the mangled symbol; clear the tag.
- Bound checking in instantiation guarantees the impl exists, so codegen lookup cannot miss - but assert and `throw` on miss to surface typechecker bugs loudly (matches the existing codegen invariant: typecheck guarantees, codegen trusts).
- E2E test fixtures under `examples/pass/`:
  - `generic_bound_basic.yoop` - `function show<T implements Display>(x: T): void` called with a struct that impls `Display`.
  - `generic_bound_iterable.yoop` - the spec's `drain` example, monomorphized over a user iterable. Land this as the showcase for the phase.
  - `generic_bound_propagates.yoop` - generic-calls-generic: `function pipeline<T implements Iterable<int32>>(ref it: T)` calls `drain(ref it)` (where `drain` also takes `T implements Iterable<int32>`). Exercises the `TypeParamType`-as-arg case in `checkBoundSatisfied`.
  - `generic_bound_struct.yoop` - bounded type param on a generic struct, not just a function.
- Fail fixtures under `examples/fail/`:
  - `generic_bound_unsatisfied.yoop` - call a bounded generic with a non-impl type.
  - `generic_bound_unknown_trait.yoop` - `<T implements DoesNotExist>`.
  - `generic_bound_method_missing.yoop` - call a method inside the generic body that isn't on the bound.

**Done when:** the bound showcase compiles end-to-end via `npm test` and produces the expected stdout.

---

## End-to-end showcase program

Land as **`examples/pass/generic_bounds_overview.yoop`** and wire into [src/e2e.test.js](../src/e2e.test.js). Exercises every sub-phase: bound parsing, bound capture, instantiation-time check, bound-method dispatch inside a generic body.

```yoop
trait Display {
    function show(ref self): string;
}

type IntBox implements Display {
    n: int32,
    function show(ref self): string {
        return "IntBox";
    }
}

type Named implements Display {
    name: string,
    function show(ref self): string {
        return self.name;
    }
}

// Single-bound generic function. Calls show() on T via the bound.
function describe<T implements Display>(ref x: T): void {
    printf(`%s\n`, show(ref x));
}

// Bounded type param flowing through a generic - exercises the
// TypeParamType-as-arg case in checkBoundSatisfied.
function describe_twice<T implements Display>(ref x: T): void {
    describe(ref x);
    describe(ref x);
}

function main(): int32 {
    let a: IntBox = { n: 1 };
    let b: Named = { name: "named" };
    describe(ref a);            // T = IntBox
    describe(ref b);            // T = Named
    describe_twice(ref a);      // generic-calls-generic
    return 0;
}
```

**Expected stdout** (asserted exactly):

```text
IntBox
named
IntBox
IntBox
```

---

## Critical files

- [src/contracts.js](../src/contracts.js) - `TYPE_PARAM` gains a `bound` field.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) - extend `parseTypeParamList` to accept `Name implements TraitAnnotation`.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) - `TypeParamType` gains a `bound: TraitType | null` field; `typesEqual` and `mangleType` ignore it.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) - defer bound resolution to pass C; new `resolveBoundTrait` + `checkBoundSatisfied`.
- [src/jsyooptypecheck/instantiate.js](../src/jsyooptypecheck/instantiate.js) - bound checks before each `instantiate*` cache lookup.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) - call-site bound checking after inference; bound-method resolution against `TypeParamType` receivers.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) - `cloneAstWithSubstitution` rewrites bound-method call tags to concrete free-function calls.

## Verification

- **Unit**: bound capture (`TypeParamType.bound` populated correctly), `checkBoundSatisfied` returns ok/error in every combinator (struct-impls, struct-doesn't-impl, generic-trait-equal-args, generic-trait-mismatched-args, type-param-with-matching-bound, type-param-with-mismatching-bound).
- **Parser**: every new syntactic form parses; reject malformed forms.
- **E2E** in [src/e2e.test.js](../src/e2e.test.js) with fixtures listed in 7.2.4 plus `generic_bounds_overview.yoop`.
- **Regression**: every Phase 7.1 fixture in `examples/pass/` (generic_box, generic_identity, generic_pair, generics_overview, ...) still compiles unchanged - bounds are additive.
- **Fail cases** in `examples/fail/`: unsatisfied bound at call site, unknown trait in bound, calling a method not on the bound, ambiguous bound-method dispatch.

## Follow-ups (not in 7.2)

- **Multiple bounds**: `<T implements (Foo, Bar)>`. Reuses 7.2 plumbing - bound becomes a list of `TraitType`. Land when the first real use case appears.
- **`extends` chains**: `BatchIterable<T> extends Iterable<T>` (spec §5). When checking `T implements Iterable<T>`, a `BatchIterable<T>` impl should satisfy it. Requires Phase 7.1.4-style work to fully resolve `extends` in the trait registry. Track as a separate item.
- **Bounded type params in trait method receivers**: the receiver of a trait method already binds `self` - bound checking on `self` is a no-op (it always satisfies the trait it's a method of). Confirm in tests; no implementation work expected.
