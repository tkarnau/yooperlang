# Phase 9.J — Reserved-syntax cleanups

## Context

Plan: [plans/phase-9.md §9.J](../phase-9.md#phase-9j--reserved-syntax-cleanups-extends-multi-bound-mustnotshare-acrossthreads).

The remaining "the parser intentionally rejects this with a not-yet-supported
message" branches in trait/kind decls. None of the three items was big on its
own; bundling clears the deferred-feature backlog and retires the last
parser-level deferral checks from the SPEC §16 list.

## What landed

### Trait `extends`

- Parser ([parser.js](../../src/jsyooparser/parser.js)): `parseTraitDecl`
  consumes `extends Annot[, Annot]?` and stores the resulting type-annotation
  list on `node.extends`. Each entry reuses `parseTypeAnnotation()` so
  generic parents (`extends Iterable<T>`) parse for free.
- `TraitType` ([types.js](../../src/jsyooptypecheck/types.js)) gained a new
  constructor slot `extendsTraits: TraitType[]`. The outer object stays
  frozen; the list is mutable (the same shape `methods: Map` already
  uses) so pass C.1 can populate it after every trait shell exists.
- Pass C.1 in [typecheck.js](../../src/jsyooptypecheck/typecheck.js) walks
  every trait decl, resolves each extends annotation through the existing
  `resolveBoundTrait` helper (which already handles non-generic + generic
  trait lookup) and pushes into `trait.extendsTraits`. A separate pass over
  the chain via `traitExtendsHasCycle` rejects direct/indirect cycles with a
  `cyclic extends chain involving trait "X"` diagnostic.
- `validateImplBlock` flattens the chain: `flattenedImpls` is the union of
  every user-declared trait and every ancestor reachable by `walkTraitExtends`
  (BFS, dedup by identity). Required-methods grouping reads from the
  flattened list, so an impl block that names `LoudGreeter` is held to
  every method declared on the chain (`greet` from `Greeter`, `shout` from
  `LoudGreeter`). The flattened list is stored on the resulting
  `StructType.implementsTraits` so downstream lookups never re-walk
  `extends`.
- `resolveTraitQualifiedCall` ([checkExpr.js](../../src/jsyooptypecheck/checkExpr.js))
  finds the *declaring* trait by walking `walkTraitExtends(resolvedTrait)`
  when `resolvedTrait.methods` doesn't carry `methodName` itself. Mangling
  uses the declaring trait's name so `Child.method(...)` and
  `Parent.method(...)` resolve to the same `<Struct>__<Parent>__<method>`
  define.
- `checkBoundSatisfied` uses `traitIsOrExtends` so a struct that implements
  `Child` satisfies a bound that asks for `Parent`. The struct path is
  redundant (impls are already flattened) but the type-param path needed it.
- `instantiateTrait` ([instantiate.js](../../src/jsyooptypecheck/instantiate.js))
  substitutes generic-trait extends parents through the registry — a
  `BatchIterable<int32>` instance carries `Iterable<int32>` (not the
  open `Iterable<T>` lifted from the genericDecl) in its `extendsTraits`.

### Multi-bound type parameters `<T implements (A, B)>`

- Parser: the bound slot on `TYPE_PARAM` was renamed `bound -> bounds`
  (always a list). Single bound `T implements A` lexes as a 1-element list;
  the new parenthesized form `T implements (A, B, ...)` is N elements with
  empty-list and trailing-comma rejection.
- `TypeParamType` ([types.js](../../src/jsyooptypecheck/types.js))
  similarly stores `bounds: TraitType[]`. Pass C's `resolveAndAttachBounds`
  iterates every annotation in the list and pushes resolved TraitTypes.
- `runBoundChecks` ([instantiate.js](../../src/jsyooptypecheck/instantiate.js))
  fires one bound check per bound — every constraint must be satisfied at
  the instantiation site. The call-site equivalent in `resolveGenericCall`
  mirrors the same loop.
- `resolveTraitQualifiedCall` walks `recvType.bounds` (rather than a single
  `bound`) to pick the matching trait for a bounded-T receiver, with
  extends-walk threaded through so `Trait.method(...)` resolves through any
  ancestor of any bound.

### `mustNotShare acrossThreads`

- Parser: `parseMustNotShareClause` accepts `acrossScopes` and the new
  `acrossThreads` (the latter lexes as a plain ident — same convention as
  `acrossScopes`). The "not yet supported" branch is gone; the unrecognized-
  target diagnostic now lists both legal targets.
- Pass C.2 stores `"acrossThreads"` into `kt.mustNotShare` the same way it
  stored `"acrossScopes"` — no other type-system plumbing changed.
- Enforcement runs at task-spawn sites:
  `enforceMustNotShareAcrossThreads` ([checkExpr.js](../../src/jsyooptypecheck/checkExpr.js))
  fires from `resolveCallType` whenever the call's `sig.returnType.kind ===
  typeKinds.task`. It walks the args, looks each one up in scope when it's
  an `IDENT` or `ref IDENT`, and rejects bindings whose `kindType` carries
  `"acrossThreads"` in its `mustNotShare` list. The diagnostic names the
  binding and its kind so the user sees exactly which value can't cross the
  spawn boundary.

## Files touched

- [src/jsyooparser/parser.js](../../src/jsyooparser/parser.js) —
  `parseTypeParamList`, `parseTraitDecl`, `parseMustNotShareClause`.
- [src/jsyooptypecheck/types.js](../../src/jsyooptypecheck/types.js) —
  `TraitType` extendsTraits slot, `TypeParamType.bounds` rename.
- [src/jsyooptypecheck/typecheck.js](../../src/jsyooptypecheck/typecheck.js) —
  `walkTraitExtends`, `traitExtendsHasCycle`, extends resolution pass,
  `resolveAndAttachBounds` multi-bound iteration, `checkBoundSatisfied`
  walks chain, `validateImplBlock` flattens.
- [src/jsyooptypecheck/instantiate.js](../../src/jsyooptypecheck/instantiate.js) —
  `runBoundChecks` iterates bounds, `instantiateTrait` substitutes parent
  traits through the registry.
- [src/jsyooptypecheck/checkExpr.js](../../src/jsyooptypecheck/checkExpr.js) —
  multi-bound dispatch + extends walk in `resolveTraitQualifiedCall`,
  multi-bound iteration in `resolveGenericCall`, new
  `enforceMustNotShareAcrossThreads` hook.
- [SPEC.md](../../SPEC.md) — `mustNotShare acrossThreads` row in the kind
  clause table; `acrossThreads` added to the contextual-keyword list.
- [CLAUDE.md](../../CLAUDE.md) — type-immutability invariant updated to
  describe `TypeParamType.bounds` + `TraitType.extendsTraits` mutability;
  trait-method invariant updated to describe the extends chain dispatch.

## Verification

- New pass fixtures under `examples/pass/`:
  - `trait_extends.yoop` — child trait + parent method dispatch via both
    qualifying traits.
  - `trait_extends_generic_bound.yoop` — `<T implements Animal>` accepts a
    type that only declares `implements Mammal` (Mammal extends Animal).
  - `multiple_trait_bounds.yoop` — `<T implements (Renderable, Named)>`
    dispatches both bounds inside the body.
- New fail fixtures under `examples/fail/`:
  - `traits_extends_cycle.yoop` — direct mutual extends triggers the
    cyclic-chain diagnostic.
  - `kind_mustnotshare_acrossthreads.yoop` — repurposed from the old
    "not yet supported" parse-error fixture; now exercises the cross-thread
    binding rejection.
- New parser tests for single/multi extends + multi-bound parsing in
  [parser.test.js](../../src/jsyooparser/parser.test.js).
- New e2e tests in [e2e.test.js](../../src/e2e.test.js) for the three pass
  fixtures + the two fail fixtures.
- Full suite (`npm test`) green: 600 tests pass.

## Caveats / deferred

- **Trait extends + same-name method across siblings.** If `trait Child
  extends A, B` and both `A` and `B` declare a `m()` with the same
  signature, an impl satisfying both will fold the requirements via the
  existing same-signature-collision logic from Phase 7.4. Conflicting
  signatures produce the existing "implemented by trait A and B with
  incompatible signatures" error; nothing new here, but worth flagging
  because the multi-parent shape only became expressible with 9.J.
- **Generic-trait extends with disjoint type-arg lists.** The cache key for
  the parent-instance rewrite in `substituteParentTrait` walks the registry
  looking for the parent's declId; if a generic trait's extends references
  the parent at a type-arg list that the rest of the program never uses
  directly, the rewrite still works (it instantiates on demand). Tested
  implicitly by `trait_extends_generic_bound.yoop` via the
  `BatchIterable<T> extends Iterable<T>` parse test; an end-to-end fixture
  exercising the full chain at a concrete type is a follow-up.
- **`mustNotShare acrossThreads` on parameters / fields.** The current
  check fires only on bindings flowing into a task spawn site. Parameter-
  position and field-position kind annotations enforce `appliesTo`
  presence but don't yet cascade the cross-thread rule — adding those is
  small follow-up work once a real use case appears.
