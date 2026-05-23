# Phase 7.4 — Trait call syntax: `Trait.method(ref x, ...)`

## Why

Phase 5 picked **free-function form** for trait method calls: `dispose(ref h)`. The plan ([plans/phase-5-traits.md:79](phase-5-traits.md#L79)) flagged this for revisit "if it feels wrong in practice." It did.

The concrete pain in the SDL playground demo: a call site like

```yoop
import { Ball, Steppable } from "./physics.yoop";
// ...
step(ref b1, dt, float32(WIN_W), float32(WIN_H));
```

— nothing in the source brings `step` into scope. The typechecker found it through a second-chance lookup that peeked at the first argument's struct type. The trait `Steppable` is imported but never appears at the call site, so the reader can't tell `step` from any other free function.

That implicit-method-injection forced two real restrictions:

1. A type couldn't implement two traits whose method names overlap.
2. A trait method name couldn't collide with any module-level free-function name.

Both restrictions existed solely because the call form had no namespace.

## What

Trait methods are now called exclusively through a **trait-qualified form**:

```yoop
Steppable.step(ref b1, dt, w, h);
Disposable.dispose(ref handle);
```

- The trait name must be in scope at the call site (imported or locally declared).
- The first argument must be a `ref` expression to a value implementing the named trait, or — inside a generic body — a `TypeParamType` whose bound matches the trait.
- Bare-form `step(ref b1, ...)` is rejected with a hint:

  ```
  unknown function "step" — did you mean `Steppable.step(...)`? Trait methods
  must be called via the qualified form 'Trait.method(ref x, ...)'.
  ```

- Dotted form `b1.step(...)` is still rejected (unchanged from Phase 5).
- Two traits implemented by one type may now share a method name; one impl body satisfies both. Codegen emits one LLVM symbol per (trait, method) — bodies are identical.
- Trait method names may now coincide with module-level free-function names.

## Design

### Parse

`Trait.method(args)` is a `CALL_EXPRESSION` whose `callee` is `FIELD_ACCESS { object: IDENT("Trait"), field: "method" }`. This is the same parse shape the existing namespace-call branch already accepted ([parser.js:1346-1374](../src/jsyooparser/parser.js#L1346-L1374)) — no grammar changes were needed.

### Typecheck — `resolveCall` in [checkExpr.js](../src/jsyooptypecheck/checkExpr.js)

A new branch in `resolveCall` fires ahead of the namespace-call branch: if the callee is a FIELD_ACCESS and its object's IDENT resolves to a trait, dispatch to `resolveTraitQualifiedCall` ([checkExpr.js](../src/jsyooptypecheck/checkExpr.js)). The helper:

1. Looks up the method on the trait.
2. Requires the first arg be a `ref` expression.
3. Resolves the receiver type (unwrapping any outer `ref`).
4. For a struct receiver: checks `implementsTraits` contains the trait, substitutes `self` → `structType` in the sig, tags the node with `calleeMethodOf` / `calleeTrait` / `calleeMethodName` / `calleeMangledName`, then hands off to `resolveCallWithSig`.
5. For a `TypeParamType` receiver (Phase 7.2 trait-bounds path): checks the bound matches, substitutes `self` → the param, sets `boundMethod` for codegen to rewrite post-instantiation, sets `calleeMethodName`.

Generic traits (`trait Container<T>`) are looked up by name and resolved against the receiver's instantiated `TraitType` (the one stored on `implementsTraits`).

The old bare-form trait dispatch and the old `resolveBoundMethodOnTypeParam` helper are gone — their work is folded into the new path.

### Mangling — trait-qualified

Trait method symbols are now mangled `<structModuleId>__<StructName>__<TraitName>__<methodName>` (was `<structModuleId>__<StructName>__<methodName>`). The struct's moduleId scopes the namespace; the trait name disambiguates between same-named methods implemented from different traits. Orphan impls are still forbidden, so the trait name is unique within a given type-decl's `implements` clause — no need to include the trait's moduleId.

The mangler is centralized in [mangleTraitMethod.js](../src/jsyooptypecheck/mangleTraitMethod.js) and used by both typecheck and codegen.

### Codegen — multiple defines per impl

`emitMethod` / `emitMethodFn` ([codegen.js](../src/jsyoopcodegen/codegen.js)) now walks `methodDecl.implementsTraits` (a list of trait names) and emits one `define` per entry. Bodies are identical; the only thing that varies is the mangled symbol. This is what makes cross-trait same-name impls possible — one source-level method, two LLVM symbols.

The CLEANUP_CALL emit path ([codegen.js:2705-2716](../src/jsyoopcodegen/codegen.js#L2705-L2716)) and the bound-method clone-and-rewrite path ([codegen.js:1700-1715](../src/jsyoopcodegen/codegen.js#L1700-L1715)) both use `mangleTraitMethod` with the trait name flowing through.

### Synthesized `mustCall` cleanup calls

The `disposable` kind synthesizes `dispose(ref x)` at scope end. The kind's `requires Trait` clause makes the trait statically known per `mustCall` entry (`mc.traitType`), so the obligation now carries `traitName` through [kindCheck.js:107-160](../src/jsyooptypecheck/kindCheck.js#L107-L160) into the CLEANUP_CALL node, which codegen feeds to `mangleTraitMethod`. No user-visible change; the synthesized call lands on the new trait-qualified symbol.

### Validation rules dropped

`validateImplBlock` in [typecheck.js](../src/jsyooptypecheck/typecheck.js) no longer rejects:

- Two implemented traits requiring the same method name (when the signatures agree). Signatures *must* still agree across the requiring traits — a single impl body can't satisfy two conflicting trait sigs.
- A trait method name coinciding with a module-level free function.

Both checks existed solely because bare-form calls had no syntactic disambiguation.

## Files modified

Compiler:

- [src/jsyooptypecheck/mangleTraitMethod.js](../src/jsyooptypecheck/mangleTraitMethod.js) — new, central mangler.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) — `resolveTraitQualifiedCall`, FIELD_ACCESS-on-trait detection, `lookupTraitByName`, `traitMethodHint`. Bare-form trait dispatch removed; `resolveBoundMethodOnTypeParam` removed (folded in).
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) — `validateImplBlock` groups required methods by name and accepts cross-trait same-name impls when sigs agree. `traitTable` added to `typeContext`.
- [src/jsyooptypecheck/kindCheck.js](../src/jsyooptypecheck/kindCheck.js) — synthesized cleanup obligations carry `traitName`; CLEANUP_CALL nodes pick it up.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — `emitMethod` / `emitMethodFn` emit per-trait defines; mangling sites switched to `mangleTraitMethod`.

Spec / docs:

- [SPEC.md](../SPEC.md) §17.2 — replaced free-function-form description with the trait-qualified form.
- [plans/roadmap.md](roadmap.md) — added pointer to this doc.

Examples:

- [examples/playground/sdl_demo/main.yoop](../examples/playground/sdl_demo/main.yoop) — `step(ref ...)` → `Steppable.step(ref ...)`.
- Every `examples/pass/*` and `examples/playground/*` fixture using trait method calls migrated via the script at `/tmp/migrate_trait_calls.js`.
- New pass fixtures:
  - [examples/pass/traits_cross_trait_same_name/main.yoop](../examples/pass/traits_cross_trait_same_name/main.yoop) — two traits, same method name, one impl, two qualified calls.
  - [examples/pass/traits_method_name_collides_with_fn/main.yoop](../examples/pass/traits_method_name_collides_with_fn/main.yoop) — free `flush(x)` and trait `Flushable.flush(ref x)` coexisting.
- New fail fixture:
  - [examples/fail/traits_bare_form_call.yoop](../examples/fail/traits_bare_form_call.yoop) — bare-form `dispose(ref h)` rejected with a hint.
- Two old fail fixtures (`traits_collision_two_traits.yoop`, `traits_collision_with_function.yoop`) now typecheck cleanly — their e2e tests assert that.

## Verification

1. `npm run test:unit` — 277 unit tests pass, including new trait-qualified call tests.
2. `npm run test:e2e` — 154 e2e tests pass, including the new and migrated fixtures.
3. `npm test` — 431 total tests pass.
4. Manual: `node src/yoopiler.js examples/playground/sdl_demo/main.yoop` compiles the SDL demo end-to-end under the new syntax.
