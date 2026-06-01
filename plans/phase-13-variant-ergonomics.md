## Phase 13 - Variant ergonomics: forward-ref sizing + variant trait impls

Two related sharp edges surfaced while writing the first real downstream
package against yoop (a JSON parser, [examples/playground/yooparse/json.yoop](../examples/playground/yooparse/json.yoop)).
Both block the natural shape a tree-of-tagged-values library wants to take,
and the workarounds for each are visible in the package's header comment.

This phase fixes both. Each fix is a small, well-scoped compiler change;
together they let `variant` types stand on their own as Disposable owners
without a wrapper-struct trampoline.

### Context

Concrete shape that doesn't work today:

```yoop
type JsonMember {
    key:   string,
    value: JsonValue,
}

variant JsonValue {
    Null,
    Number { value: int64 },
    String { value: string },
    Array  { items:   JsonValue[] },
    Object { members: JsonMember[] },
}
```

Two distinct failures, depending on declaration order:

1. **JsonMember first** - typechecks and codegens, then corrupts the heap
   at runtime. `sizeOfType(JsonMember)` returns 16 bytes; LLVM lays each
   one out at 32 bytes. `heap_alloc<JsonMember>(n)` undersizes the buffer
   by half, the third-or-later write past the end clobbers malloc
   bookkeeping, and the next free traps with SIGABRT. The package
   currently sidesteps this by exploding the object payload into two
   parallel arrays (`keys: string[], values: JsonValue[]`) so no carrier
   struct sits between the variant and itself.

2. **JsonValue first** - typecheck rejects with `type "JsonMember" has no
   field "key"`. The struct shell that pass A registered is still
   `fields: null` when the variant tries to resolve its payload's element
   type, and the resolver treats a `null`-fields struct as "no fields".

Separately, the package has to wrap `JsonValue` in a `JsonDoc` struct just
to hang `implements Disposable propagates<disposable>` off something - the
parser doesn't accept `implements` / `propagates` clauses on `variant`
decls today. The walk-and-free logic naturally lives on the variant (it's
a switch on the cases), so the wrapper struct is pure ceremony.

The two issues compound: even if you fix the trait-impl one, the
forward-ref sizing one still corrupts memory; even if you fix the
sizing one, you still need a wrapper struct to own the disposal.

### Phase 13.A - Variant shells mutate in place (pass C)

**The bug**, narrowed to a single line:

[src/jsyooptypecheck/typecheck.js:2342-2344](../src/jsyooptypecheck/typecheck.js#L2342-L2344)

```js
const fullEnum = VariantType(d.name, variants, mod.id);
d.resolvedType = fullEnum;
variantTable.set(d.name, fullEnum);
```

Pass A registered a shell at [typecheck.js:1667](../src/jsyooptypecheck/typecheck.js#L1667):
`variantTable.set(d.name, VariantType(d.name, new Map(), mod.id));`. Pass
C builds a *new* VariantType with the populated variants Map and replaces
the table entry. Any struct field whose type was resolved between those
two points captured the shell reference; that reference is never
back-patched.

At codegen time, `sizeOfType` on the field walks the stale shell, sees
`variants.size === 0`, computes `4 /* tag */ + 0 /* no payload */ = 4`,
and the enclosing struct sizes too small. `heap_alloc<EnclosingStruct>(n)`
undersizes by exactly the missing payload bytes times n, and writes past
the buffer corrupt the heap.

**The fix**, matching the trait pattern documented in
[CLAUDE.md](../CLAUDE.md) ("TraitType is itself frozen, but its methods:
Map ... slots are mutable containers that pass C.1 populates"):

- Pass C mutates the shell's `variants` Map in place instead of
  constructing a new VariantType.
- The shell stays the canonical object; every captured reference sees
  the populated variants on the next read.
- `d.resolvedType` is set to the same shell (no replacement).

Concretely, the diff inside the `else if (d.kind === ASTNodeKind.VARIANT_DECL)`
branch becomes:

```js
const shell = variantTable.get(d.name);
// ... build resolved variant cases the same way ...
for (const [name, entry] of variants) {
    shell.variants.set(name, entry);
}
d.resolvedType = shell;
```

The `VariantType` constructor needs to keep the Map mutable (don't
freeze it) - mirror what `TraitType` already does.

**Generic variants** (the `gd.genericVariants = genericVariants` path at
[typecheck.js:2300](../src/jsyooptypecheck/typecheck.js#L2300)) need the
same in-place treatment if they hit the same hazard. Worth checking
whether generic-variant pass C can race ahead of struct-field resolution
the same way the concrete path can; if so, store directly into the
generic-decl's shell instead of building a fresh Map.

**Verification**

- New fail-then-pass fixture: a struct + variant pair declared in either
  order, where the struct field is the variant and the variant payload
  is a heap-allocated array carrying the struct. Confirm `sizeOfType` at
  codegen matches LLVM's expected element size (one easy check is to
  alloca a `[2 x %struct]` and compare the offset of element 1 against
  `sizeOfType`-multiplied-by-1).
- Re-test the parallel-array workaround in
  [examples/playground/yooparse/json.yoop](../examples/playground/yooparse/json.yoop)
  reverted to the natural `members: JsonMember[]` shape - it should run
  the existing demo cleanly.
- Add a small E2E fixture under `examples/pass/` that exercises
  forward-referenced variant fields: a `Tree { Leaf, Node { children:
  Tree[] } }` is enough, plus a deeper `Pair { l: Tree, r: Tree }` style
  if the resolver has both directions of the cycle.

### Phase 13.B - `variant T implements Trait propagates<K>`

**The gap**: the variant parser at
[src/jsyooparser/parser.js:2802-2851](../src/jsyooparser/parser.js#L2802)
goes straight from `variant Name<Tparams>` to `{` without considering
`implements` or `propagates` clauses. The struct parser
(`parseTypeDecl`) accepts both - the variant parser was never extended.
Consequence: any disposable / iterable / displayable wrapper that wants
to *be* a variant has to be a struct that *wraps* a variant.

**The fix** has parser, typechecker, and codegen pieces.

Parser:

- After `name` + `typeParams`, accept an optional `implements (T, U,
  ...)` and an optional `propagates<K>` clause, in either order, exactly
  matching `parseTypeDecl`'s shape.
- Methods inside the variant body. Today the variant body is only
  `Variant { field: Type, ... }` cases separated by commas. With trait
  methods, the body has to interleave variant cases and `function name(ref
  self, ...): ReturnT { ... }` blocks the same way `parseTypeDecl` does.
- Stamp `implementsTraits` / `propagates` / `methods` onto the AST node
  alongside `variants`.

Typechecker:

- Pass A: when registering the variant shell, also stash the parsed
  `implementsTraits` list and `propagates` clause on the shell - the
  trait-method validation in pass C.1 needs them.
- Pass C.1 (validateImplBlock equivalent): for variant types, walk the
  declared `methods`, type-check each body with `self: VariantT` in
  scope (the receiver is `ref self` against the variant's own type),
  and register each method on the variant's `methods` Map. Identical
  control flow to the struct path; the only difference is the receiver
  type.
- `runKindCheck` ([src/jsyooptypecheck/kindCheck.js](../src/jsyooptypecheck/kindCheck.js))
  participates the same way: a binding of a variant type that declares
  `propagates<K>` carries the obligation, and a return that transfers
  the variant value satisfies / transfers the obligation. The existing
  struct path is the template.

Codegen:

- `Trait.method(ref some_variant_binding)` already lowers as
  `<structModuleId>__<StructName>__<TraitName>__<methodName>` when the
  receiver is a struct. Switch the mangling lookup to read from a
  shared "nominal type" view that covers struct *and* variant, so a
  variant receiver dispatches through `<variantModuleId>__<VariantName>__<TraitName>__<methodName>`.
- The receiver pointer the impl method gets as `ref self` is just a
  pointer to the variant's storage (`{ i32, [N x i8] }`). Method bodies
  can switch on `self` exactly like user-written switches; no special
  lowering needed.
- For the disposal use case specifically: this enables
  `function dispose(ref self): void { switch (self) { ... walk ... } }`
  inside the variant body. The body's switch arms see the variant's
  cases by name, same as outside.

**Verification**

- E2E pass: a minimal variant implementing Disposable - e.g.
  `Owned { Empty, Buffer { data: uint8[] } }` with `dispose` switching
  on the cases and `intr.heap_free`-ing the data when non-Empty. The
  variant is propagates<disposable>; binding it as `disposable` and
  letting scope exit fire `dispose` should work.
- E2E pass: revert
  [examples/playground/yooparse/json.yoop](../examples/playground/yooparse/json.yoop)
  to wear its own Disposable - the `JsonDoc` wrapper goes away, the
  variant gets the `dispose_value` switch as its own method, and
  `disposable doc: JsonValue = parse(input)` binds the same way.
- E2E fail: a variant declaring `implements Disposable` but missing the
  `dispose` method - the typecheck error should match the struct case
  exactly ("type X does not implement trait Disposable: missing method
  dispose").
- E2E fail: a variant that returns a propagating field through a return
  statement without declaring `propagates<K>` on the return type -
  rejected for the same reason structs are.

### Intentionally out of scope

- **Variant fields that contain a variant by-value with mutually
  recursive shape**. The 13.A fix covers the captured-shell-reference
  case. A variant whose payload contains *itself* by value
  (`variant V { Case { inner: V } }`) is genuinely infinite-sized and
  the existing struct-side `detectRecursiveField` check has no variant
  twin yet. Adding the recursion check for variants is a separate item,
  not blocking the sizing fix.
- **Trait `extends` chains rooted at a variant.** Phase 9.J landed
  `extends` for traits; impls of an extends-chain trait on a variant
  receiver should fall out of the 13.B work, but the cross-product test
  matrix (multi-bound type params bounded by a variant-implementing
  trait, etc.) is a follow-up.
- **`vtable T for Trait` over a variant**. Phase 9.G vtables wrap a
  struct receiver; lifting them to variants is the obvious next step
  but isn't required for the JSON-style use case (the disposal walk
  uses concrete dispatch).
- **Inline auto-derive of `dispose` for variants whose payloads are
  themselves disposable.** Phase 13.B makes it possible to *write* the
  walking dispose by hand; a derive macro / synthesized impl could
  remove the boilerplate later but is its own design problem.

### Critical files

- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js)
  - pass A shell registration at line 1667, pass C variant resolution
  at lines 2301-2344.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js)
  - `VariantType` constructor: confirm `variants` Map stays mutable
  after construction (mirror `TraitType.methods`).
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js)
  - `parseVariantDecl` at line 2802; teach it `implements` /
  `propagates` clauses and interleaved method bodies.
- [src/jsyooptypecheck/kindCheck.js](../src/jsyooptypecheck/kindCheck.js)
  - obligation flow for variant bindings that propagate.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js)
  - trait-method mangling lookup widening to cover variant receivers;
  dispatch through the same `<mod>__<Name>__<Trait>__<method>` shape.
- [src/e2e.test.js](../src/e2e.test.js) - new fixture registrations.
- [examples/playground/yooparse/json.yoop](../examples/playground/yooparse/json.yoop)
  - reverts the parallel-array workaround and the JsonDoc wrapper once
  both fixes land.
