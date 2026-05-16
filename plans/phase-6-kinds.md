# Phase 6 — Kinds

Part of the [roadmap](./roadmap.md). Phase 5 landed traits, struct refs, and free-function trait dispatch (`dispose(ref h)`). The language now has the **capability** layer ([SPEC.md §5](../SPEC.md#L297)) but no way to say "this binding *must* have its capability invoked before scope exit." Every `dispose` site is hand-rolled; every cleanup path is a hazard. Phase 6 closes the gap by introducing the **usage-site contract** layer described in [SPEC.md §6](../SPEC.md#L356) — kinds.

## What a kind is

A kind is a compile-time tag that attaches to a binding, parameter, field, function, or type and encodes one or more enforceable rules: lifecycle (`mustCall`), scoping (`ownsBlock`, `mustNotEscape`), sharing (`mustNotShare`), iteration (`restricts.iteration`), layout (`layout`), capability requirement (`requires Trait`), or capability provisioning (`provides Trait`). Kinds are the **only** mechanism for "the compiler should enforce X here" — there is no other place in the language that does flow-sensitive analysis on bindings.

```yoop
kind disposable {
    requires Disposable;
    ownsBlock();
    mustCall(dispose).beforeScopeEnd();
}

function main(): int32 {
    disposable input = open("x.txt") {
        const bytes = read_all(ref input)?;
        // compiler synthesizes dispose(ref input) before this `}`,
        // and before every `?` and `return` inside the block
    }
    return 0;
}
```

## Why kinds are next

1. **Phase 5 left a sharp edge.** `Disposable` is implemented on `FileHandle`, but nothing forces the user to call `dispose` — fallthrough, early `return`, and `?` propagation all leak the handle. The whole point of `Disposable` is to be paired with a `mustCall` obligation; without kinds, the trait is half a feature.
2. **The rest of the spec is built on kinds.** Concurrency ([§8](../SPEC.md#L532)) is a kind story — `task` is a kind, `scoped`/`pooled` are kinds, `wait`/`abandon` are accounted for through `mustCall`. Iteration strategies ([§9](../SPEC.md#L581)) check the collection's kind. Memory rules ([§6.4 layout](../SPEC.md#L406)) are kind clauses. Nothing more lands without this layer.
3. **It's the hardest single phase** ([roadmap.md:79](./roadmap.md#L79)). Better to land it incrementally now, behind a small first sub-phase, than to bundle it with the polish work in phase 7.

## Scope cut

Phase 6 is too large for one plan file; existing phase plans run 400-1700 lines and a unified phase-6 plan would dwarf the rest of the roadmap combined. We break it into five sub-phases, each landing a coherent slice that compiles, runs, and is testable end-to-end. The first sub-phase establishes the kind-declaration and flow-analysis machinery; the rest layer onto it.

## Sub-phases

### 6.1 — Disposable (the foundation)

`kind` declarations, kind prefixes on bindings, `mustCall`/`ownsBlock`/`requires`/`appliesTo` clauses, implicit-block synthesis in reverse declaration order (LIFO), and cleanup insertion at every exit point (`?`, `return`, fall-through). Lands `disposable` end-to-end against the existing `Disposable` trait from phase 5.

> Detailed plan: [phase-6-1-disposable.md](phase-6-1-disposable.md)

### 6.2 — Escape and sharing constraints

`mustNotEscape.scope()`, `mustNotShare.acrossScopes()`, and `forbids: X` clauses. Adds a flow-sensitive escape-analysis pass over function returns, struct-field stores, and `ref` capture. Widens `appliesTo` to include `parameter` and `field`. Builds on 6.1's binding-flow infrastructure.

### 6.3 — Task and concurrency

The big sub-phase. Generic traits (`trait Task<T>` — phase 5 deferred these), the `task` kind on function declarations, `provides Task` semantics that rewrite a `task` function's return type to `Task<T>`, the binding kinds `scoped` and `pooled` with their `wait` / `mustNotShare` / `mustNotEscape` / `autoJoin` rules per [SPEC.md §8](../SPEC.md#L532), the `wait h` and `_ = h` operators, and compiler-inserted `wait` for immediate and `scoped` bindings. Significant overlap with the runtime story; may need a minimal scheduler shim.

### 6.4 — Containment and propagation

`type T propagates<K> { ... }` and `type T contains<K> { ... }` ([SPEC.md §6.5](../SPEC.md#L460)), plus `function f(...): T propagates<K>` on return types. Containers either surface their fields' kind rules to callers (propagate) or absorb them (contain). Smaller polish layer; depends on 6.1-6.3.

### 6.5 — Layout, iteration restrictions, composition

`layout({ align: N, ... })`, `restricts.iteration({ allow, forbid })`, and kind composition with `&` ([SPEC.md §6.4](../SPEC.md#L451)). Couples to the iteration story ([§9](../SPEC.md#L581)) — a collection's kind decides which `for ... in xs.method()` forms are legal. Also introduces parameterized kinds (`kind batchable(n: usize)`).

## What carries between sub-phases

- The `KindType` representation, declared in 6.1, gains clauses in each later sub-phase.
- The flow-analysis walker, written in 6.1 for `mustCall` only, is the same machinery that 6.2 (escape) and 6.3 (`wait` insertion) extend.
- The cleanup-emission codegen path, established in 6.1, is what 6.3's `autoJoin` reuses for compiler-inserted `wait`.

Each sub-phase has its own pass/fail fixtures under [examples/](../examples/) and is gated on the full regression suite.

## Critical files

- [SPEC.md §6](../SPEC.md#L356) — kind definition, clauses, application sites, composition
- [SPEC.md §4.4-4.5](../SPEC.md#L221) — kind prefix on bindings, block-owning kinds, implicit-block LIFO synthesis
- [src/contracts.js](../src/contracts.js) — new AST kinds for `kindDecl` and its clauses
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — `kind`, `appliesTo`, `requires`, `mustCall`, `ownsBlock`, etc.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — `parseKindDecl`, kind-prefix on `parseVarDecl`
- [src/jsyooptypecheck/](../src/jsyooptypecheck/) — new `kindCheck.js` flow pass; extensions to `typecheck.js`, `scope.js`
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — cleanup-call emission at every exit point
