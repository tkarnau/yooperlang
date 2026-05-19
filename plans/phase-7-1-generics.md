# Phase 7.1 — Generics

## Context

Phase 6 (kinds) is wrapping up. The roadmap ([roadmap.md](roadmap.md)) names Phase 7 as "generics, pattern matching, switch" but doesn't fix an order. Generics first, for three reasons:

1. Spec §10 defers pattern matching until "the error story hardens"; v2 has no sum types. Without sum types, "pattern matching" reduces to `switch` over ints/bools — small and isolated.
2. Generic traits already exist as **hardcoded built-ins** — `Task<T>`, `Iterable<T>`, `BatchIterable<T>` are special-cased in [parser.js:323-328](../src/jsyooparser/parser.js#L323-L328) and the typechecker. Every iteration-related trait we add doubles that debt until generics are real.
3. Pattern matching will eventually want to destructure generic types (`Option<T>`, `Result<T,E>`). Building it before generics means rewriting it later.

**Scope.** Generic functions + generic structs + generic traits (replacing the built-in `Task<T>`/`Iterable<T>` specialness). Trait bounds (`<T implements Foo>`) deferred to Phase 7.2. Type arguments **inferred only** at call sites — explicit type args appear only in type-annotation position. This sidesteps the `<` ambiguity in expression position entirely (no turbofish, no backtracking).

---

## Sub-phase order

Each sub-phase is independently shippable and testable. Land them in order; don't interleave.

### 7.1.0 — Lexer / parser / AST scaffolding

Reserve syntax and add AST nodes. No type-system or codegen behavior yet — this sub-phase ends with everything parsing and the existing test suite still green.

- New AST kind in [src/contracts.js](../src/contracts.js): `TYPE_PARAM` (single name; later carries bounds). Add a `typeParams` field on `FUNCTION_DECL`, `TYPE_DECL`, `TRAIT_DECL`. **No** new node for type application — extend the type-annotation object shape instead.
- Generalize `parseTypeAnnotation()` at [parser.js:309](../src/jsyooparser/parser.js#L309) so **any** identifier followed by `<` parses as a type application, not just `Task`. Drop the `Task`-specific branch at [parser.js:323-328](../src/jsyooparser/parser.js#L323-L328). Type-annotation objects gain an optional `typeArgs: [TypeAnnotation]`.
- New helper `parseTypeParamList()` — parses `<T, U, V>` after a decl name. Wire into `parseFunctionDecl()` ([parser.js:1632](../src/jsyooparser/parser.js#L1632)), `parseTypeDecl()` ([parser.js:1684](../src/jsyooparser/parser.js#L1684)), `parseTraitDecl()` ([parser.js:953](../src/jsyooparser/parser.js#L953)).
- Remove the existing rejection `"trait generics are not supported in v0"` at [parser.js:959-964](../src/jsyooparser/parser.js#L959-L964). Update [examples/fail/traits_generic_rejected.yoop](../examples/fail/traits_generic_rejected.yoop) — keep as a parse-pass / typecheck-fail bridge until 7.1.4 makes it pass-pass and it moves to `examples/pass/`.
- Reject malformed param lists at parse time: `<>`, `<,T>`, trailing comma is fine (match existing struct-field style).
- **`>>` lexer hazard**. The lexer tokenizes `>>` as a single `rshift` token ([lexer.js:150](../src/jsyooplexer/lexer.js#L150)). `Pair<int32, Box<int32>>` therefore fails to parse today. Fix: when `parseTypeAnnotation` expects a closing `>` and sees `rshift`, split it into two `gt` tokens. The cleanest approach is a parser-side helper `expectGtSplittingRshift()` that consumes a `gt` if present, or peeks an `rshift` and rewrites it into a pending `gt` for the outer call to consume. Keep the lexer unchanged so binary `>>` in expressions stays a single token.
- Every new node goes through `buildSourcedNode()` ([parser.js:218](../src/jsyooparser/parser.js#L218)).
- **No explicit type args at call sites.** `parseExpression()`'s `<` stays a binary op. Keeps `peekAhead` shallow (≤3) per CLAUDE.md.
- Tests in [src/jsyooparser/parser.test.js](../src/jsyooparser/parser.test.js): parse-only assertions for `function map<T,U>(...)`, `type Box<T> { value: T }`, `trait Iter<T> { ... }`, `let b: Box<int32> = ...`.

**Done when:** all new forms parse; full existing test suite still passes; the typechecker errors on any generic decl with a clear "generics not yet wired into typecheck" message (parse pass, semantic fail — same bridge pattern as deferred clauses).

### 7.1.1 — Type system: type variables + substitution

The single foundational change. Everything after reuses these primitives.

- Add `typeParam` kind to [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js): `TypeParamType { name, originDecl }`. `originDecl` (declaring function/type/trait id) prevents two unrelated `T`s being conflated.
- Extend `typesEqual` at [types.js:349](../src/jsyooptypecheck/types.js#L349) to compare `typeParam` by `(name, originDecl)`.
- New helper `substituteTypeParams(type, substitution: Map<TypeParamType, Type>)` — recursive walk producing a new frozen type with params replaced. Covers prim (passthrough), struct (substitute in field types), ref/array (substitute inner), func (substitute in params and return), trait (substitute in method sigs).
- Extend `resolveTypeAnnotation()` ([types.js:235](../src/jsyooptypecheck/types.js#L235)) and `resolveTypeAnnotationInModule()` ([typecheck.js:74](../src/jsyooptypecheck/typecheck.js#L74)) to (a) look up bare names in a "type params in scope" map first (added to the `ctx` arg); (b) when the annotation has `typeArgs`, treat it as an application: resolve the base name to a generic decl, resolve each type arg, call into the instantiation registry (7.1.2 / 7.1.3).
- The existing `substituteSelfInSig` at [typecheck.js:140](../src/jsyooptypecheck/typecheck.js#L140) will eventually become a thin wrapper over `substituteTypeParams` with `{self ↦ thisStruct}`. **Don't refactor it now** — do it in 7.1.4 when trait substitution becomes the hot path.
- Unit tests for substitution: nested types, repeated params, identity (no-op) cases.

**Done when:** substitution helper has unit tests; type-params-in-scope plumbed through the `ctx` arg; no behavior change visible to users yet.

### 7.1.2 — Generic structs

Build on the substitution machinery; reuse the shell pattern already used for imported structs (CLAUDE.md: "Imported structs may be shells mid-pass").

- **Pass A** ([typecheck.js:669-797](../src/jsyooptypecheck/typecheck.js#L669)): when a `TYPE_DECL` has `typeParams`, register a **generic decl** in a new `genericStructTable` (per-module map) — **not** in `structTable`. Decl carries the param list and the unresolved field AST. The concrete `structTable` only ever holds monomorphic types.
- **Pass C** ([typecheck.js:814-931](../src/jsyooptypecheck/typecheck.js#L814)): when resolving field types of a generic decl, push its type params into the `ctx` so they resolve as `TypeParamType`. Store the resulting "generic body" (field list with type params in it) on the decl.
- **Instantiation registry** — new module `src/jsyooptypecheck/instantiate.js`. Keyed by `(declId, [arg types])`, value is a fully-frozen `StructType`. On miss: substitute the param map across the generic body, build a `StructType` with mangled name, recurse into any nested generic args, freeze, return. On hit: return cached.
- **Recursive instantiation**: instantiating `Vec<Box<int32>>` must first instantiate `Box<int32>`. The registry walk handles this naturally — `resolveTypeAnnotation` on the inner annotation triggers a registry lookup before the outer one builds.
- **Where instantiations trigger**: any `resolveTypeAnnotation` call that sees a type-application shape. Covers field types, param types, return types, local annotations — every site already in the typechecker.
- **Codegen** ([codegen.js:1619-1631](../src/jsyoopcodegen/codegen.js#L1619)): emit one struct def per **resolved** `StructType` reached during program walk. Existing emission loop already deduplicates by mangled name; the only change is making sure the walk picks up types reached only through instantiations (not just `TYPE_DECL` AST nodes). A second emission pass over the typechecker's instantiation registry covers this cleanly.
- **Mangling**: extend the existing `<moduleId>__<name>` pattern at [codegen.js:55-82](../src/jsyoopcodegen/codegen.js#L55-L82) to `<moduleId>__<name>__<arg1>__<arg2>` for instantiations. Nested args flatten via the same scheme: `Vec<Box<int32>>` → `m__Vec__m__Box__int32`. `__` is already the separator convention.
- **Recursive layout** (decision needed during 7.1.2): `type Bad<T> { x: Bad<T> }` is structurally identical to the already-rejected `type Node { next: Node }`. Reject it with the same diagnostic. `type LL<T> { next: ref LL<T> }` is fine because `ref` breaks the layout cycle — same as today's non-generic ref-cycle handling.
- Tests in `examples/pass/`: `generic_box.yoop` (single param), `generic_pair.yoop` (two params), `generic_nested.yoop` (`Box<Box<int32>>`), `generic_struct_in_field.yoop`. Fail cases in `examples/fail/`: missing type args on a generic struct annotation, wrong arity, recursive non-ref layout.

**Done when:** the e2e suite ([src/e2e.test.js](../src/e2e.test.js)) includes `generic_box.yoop` printing the right value end-to-end.

### 7.1.3 — Generic functions

Mirrors 7.1.2 for functions; the new piece is **call-site inference**.

- **Pass A / C**: generic function decls land in `genericFuncTable`; the resolved generic signature stores `params: [{name, type, isRef}]` where types may contain `TypeParamType`s, plus a `typeParams` list.
- **Call-site inference** in [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) inside `resolveExprType` for `CALL_EXPRESSION`:
  1. Resolve callee. If generic, fetch its signature.
  2. Resolve every arg's type as usual.
  3. **Unification**: walk param types and arg types in tandem. Each `TypeParamType` accumulates a constraint set; pick the first concrete type seen. If two args constrain the same param differently, error. If a param is never constrained (e.g. used only in return type), error `"cannot infer type argument T"` (this is the explicit "no turbofish" cost — accept it; the diagnostic is the fix).
  4. With the substitution map built, look up (or build) the monomorphic `FuncType` in the instantiation registry. Set `node.resolvedType` to the substituted return type; tag the call node with the instantiation key for codegen.
- **Untyped literal interaction**: `unifyArith` and `isAssignable` already handle `untypedInt`/`untypedFloat` → primitive coercion ([coerce.js:68-100](../src/jsyooptypecheck/coerce.js#L68)). For inference, an untyped literal arg should **not** pin a type param — only a concrete arg does. If all args binding a param are untyped, default per existing rules (untypedInt → int32). Encode this in unification.
- **Codegen**: emit one LLVM function per instantiation. Mangle as `<moduleId>__<fnName>__<arg1>__<arg2>`. Call sites use the tagged instantiation key to pick the mangled symbol. Reuse the existing single-module codegen for the body, with the substitution applied to AST type annotations on entry (simplest: pre-substitute `resolvedType` throughout the body before walking).
- Tests: `generic_identity.yoop` (`fn id<T>(x: T): T`), `generic_swap.yoop`, `generic_map.yoop` over `[T]`. Fail cases: un-inferrable T, arity mismatch.

**Done when:** `generic_identity.yoop` called with both int32 and float64 produces both monomorphizations in IR and runs correctly.

### 7.1.4 — Generic traits (kill the built-in special case)

Now that the machinery exists, remove the hardcoded `Task<T>`/`Iterable<T>` paths.

- `TraitType` ([types.js:152](../src/jsyooptypecheck/types.js#L152)) gains a `typeParams` field. Trait decls with `<T>` register as generic traits.
- Trait method signatures resolve with the type params in scope (same `ctx` mechanism as 7.1.2).
- `validateImplBlock` ([typecheck.js:163](../src/jsyooptypecheck/typecheck.js#L163)) extends `substituteSelfInSig` to also substitute trait type params. The substitution map becomes `{self ↦ ThisStruct, T ↦ <arg from impl decl>, ...}`. This is the refactor flagged in 7.1.1.
- Update parsing for `type Foo implements Iterable<int32> { ... }` — the impl trait reference is a type application, parsed by the existing extended annotation parser.
- Remove the `Task<T>` hardcoding in the parser ([parser.js:323-328](../src/jsyooparser/parser.js#L323-L328)) and any matching hardcoding in [src/jsyooptypecheck/builtinKinds.js](../src/jsyooptypecheck/builtinKinds.js) and `task`-related codegen. `Task` becomes a user-visible generic trait declared in a runtime prelude (or built-in declaration injected at typecheck time, but as a proper generic trait, not a special case).
- Move [examples/fail/traits_generic_rejected.yoop](../examples/fail/traits_generic_rejected.yoop) into `examples/pass/`.
- Tests: `generic_iter_impl.yoop` (impl `Iterable<int32>` for a user type, free-fn `next` dispatch works), regression for all existing `task`/`wait` programs, parse + typecheck for `trait BatchIterable<T> extends Iterable<T>` (extends stays deferred; just confirm the parser handles the type-arg).

**Done when:** every existing `task`/`wait` example still compiles and runs; `Task<T>` is no longer special-cased in the parser; `generic_iter_impl.yoop` works end-to-end.

---

## Critical files

- [src/contracts.js](../src/contracts.js) — new `TYPE_PARAM` kind, `typeParams` field on decl nodes.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — `parseTypeParamList`, generalized `parseTypeAnnotation`, drop hardcoded `Task<T>` and the trait-generic rejection.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) — `TypeParamType`, `substituteTypeParams`, extended `typesEqual`.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) — pass A/C handling of generic decls, type-param scope in `ctx`.
- **New**: `src/jsyooptypecheck/instantiate.js` — instantiation registry for structs, funcs, and traits.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) — call-site inference for generic functions.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — extended mangling; per-instantiation emission for structs and functions.
- [src/jsyooptypecheck/builtinKinds.js](../src/jsyooptypecheck/builtinKinds.js) — remove `Task<T>` specialness in 7.1.4.

## End-to-end showcase program

The implementer must land this program as **`examples/pass/generics_overview.yoop`** and wire it into the e2e regression suite ([src/e2e.test.js](../src/e2e.test.js)) before declaring Phase 7.1 done. It exercises every sub-phase deliverable (generic struct, generic function with inference, generic function returning a generic struct, two-param generic, nested generic instantiation, generic trait + impl + free-function dispatch) in a single fixture.

```yoop
type Box<T> {
    value: T,
}

type Pair<A, B> {
    first: A,
    second: B,
}

// Generic function, T inferred from arg type.
function identity<T>(x: T): T {
    return x;
}

// Generic function returning a generic struct.
function wrap<T>(x: T): Box<T> {
    return { value: x };
}

// Generic function consuming a generic struct.
function unwrap<T>(b: Box<T>): T {
    return b.value;
}

// Generic trait.
trait Container<T> {
    function get(ref self): T;
}

// Impl of the generic trait at a concrete type argument.
type IntCell implements Container<int32> {
    n: int32,
    function get(ref self): int32 {
        return self.n;
    }
}

function main(): int32 {
    // Generic struct, monomorphization #1 at int32.
    let bi: Box<int32> = { value: 42 };
    printf(`bi=${bi.value}\n`);

    // Same generic, monomorphization #2 at float64 — via a generic function.
    let f: float64 = float64(35) / float64(10);
    let bf: Box<float64> = wrap(f);
    printf(`bf=${bf.value}\n`);

    // identity called with two distinct concrete arg types — two
    // monomorphizations, both inferred from the arg (no turbofish needed).
    let n: int32 = 100;
    let id_i: int32 = identity(n);
    let id_f: float64 = identity(f);
    printf(`id_i=${id_i} id_f=${id_f}\n`);

    // Generic function consuming Box<int32>.
    let u: int32 = unwrap(bi);
    printf(`u=${u}\n`);

    // Two-param generic with a nested generic argument. Exercises:
    //   - multi-parameter monomorphization (Pair<int32, _>)
    //   - recursive instantiation (Box<int32> must instantiate first)
    //   - the `>>` lexer hazard (must split into two `gt` tokens in type position)
    let p: Pair<int32, Box<int32>> = { first: 10, second: { value: 20 } };
    printf(`p.first=${p.first} p.second.value=${p.second.value}\n`);

    // Generic trait + concrete impl. Free-function dispatch per spec §17.2.
    let cell: IntCell = { n: 99 };
    let v: int32 = get(ref cell);
    printf(`cell=${v}\n`);

    return 0;
}
```

**Expected stdout** (asserted exactly in the e2e test):

```text
bi=42
bf=3.500000
id_i=100 id_f=3.500000
u=42
p.first=10 p.second.value=20
cell=99
```

**How to wire it in.** Add an `it(...)` block to [src/e2e.test.js](../src/e2e.test.js) following the existing pattern (e.g. the `arrays_basic.yoop` entry at [e2e.test.js:148](../src/e2e.test.js#L148)):

```js
it("generics_overview.yoop exercises generic structs, fns, traits", () => {
  const { stdout, exitCode } = runFixture("examples/pass/generics_overview.yoop");
  assert.equal(exitCode, 0);
  assert.equal(
    stdout,
    "bi=42\nbf=3.500000\nid_i=100 id_f=3.500000\nu=42\np.first=10 p.second.value=20\ncell=99\n",
  );
});
```

This single program is the integration acceptance gate for Phase 7.1. Each sub-phase below also lands its own narrower fixtures, but `generics_overview.yoop` must compile and produce that exact output before 7.1 ships.

## Verification

- **Unit**: substitution round-trips; instantiation registry caches; inference produces correct substitution and errors on un-inferrable T.
- **Parser** in [src/jsyooparser/parser.test.js](../src/jsyooparser/parser.test.js): every new syntactic form parses; reject malformed forms (`<>`, `<,T>`).
- **e2e** in [src/e2e.test.js](../src/e2e.test.js) with fixtures in `examples/pass/`:
  - `generic_box.yoop` — `type Box<T> { value: T } ... let b: Box<int32> = { value: 5 }; printf("${b.value}\n")`
  - `generic_identity.yoop` — `function id<T>(x: T): T` called with int32 and float64
  - `generic_pair.yoop` — two type params
  - `generic_iter_impl.yoop` — user struct impls `Iterable<int32>`, free-fn `next` dispatch
  - `generic_nested.yoop` — `Box<Box<int32>>` reaches codegen
- **Regression**: existing `task`/`wait` programs in `examples/pass/` still compile and run after 7.1.4.
- **Fail cases** in `examples/fail/`: un-inferrable T, wrong type arg arity, generic struct used without args in annotation position, recursive non-ref layout.

## Follow-ups (not in 7.1)

- **Phase 7.2 — Trait bounds.** `<T implements Foo>` per spec §3 line 348. Reuses substitution. Parser: bound clause after type param. Typechecker: at instantiation, verify the substituted type implements the required trait (hook into existing `validateImplBlock` data). No codegen change.
- **Phase 7.3 — Pattern matching / switch.** Detailed plan deferred until 7.1 ships and the sum-type story firms up. A minimal `switch` over int/char/bool with literal patterns + default could land independently if a real program needs it; the full match-on-sum-type design waits on spec §10.
