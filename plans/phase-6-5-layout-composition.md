# Phase 6.5 — Layout, composition, parameterized kinds

Part of [phase 6 — kinds](./phase-6-kinds.md). Sub-phases 6.1–6.4 landed kind declarations, the flow walker (`mustCall`, `mustNotEscape`), the task runtime, and propagation across structs and function returns. Three SPEC §6 features remain unbuilt: the `layout { ... }` clause, parameterized kinds (`kind aligned(n: usize)`), and the `&` composition form. 6.5 lands all three, retires the `appliesTo type` deferral from 6.4, and **closes phase 6**. Two SPEC §6 pieces stay deferred past 6.5 with explicit error messages — `restricts iteration { ... }` (waits on `for item in xs.method()`, which depends on generic traits from phase 7) and `contains<K>` (no forcing use case across 6.1–6.4).

## Context

Each preceding sub-phase left explicit deferrals that 6.5 retires:

- 6.1 rejected `kind X(n: usize) { ... }` and `kind X = a & b;` at parse with *"…not yet supported in phase 6.1"* — see [parser.js:338](../src/jsyooparser/parser.js#L338) and [parser.js:343-346](../src/jsyooparser/parser.js#L343).
- 6.1/6.2 left `layout` in `DeferredKindClauseMessages` at [parser.js:48](../src/jsyooparser/parser.js#L48): *"layout not yet supported (phase 6.5)"*.
- 6.2 rejected `appliesTo type` at [parser.js:451-456](../src/jsyooparser/parser.js#L451).
- 6.4 noted parameterized kinds in `propagates<K(n)>` as a 6.5 follow-up — see [phase-6-4-containment-propagation.md:126](./phase-6-4-containment-propagation.md#L126).

## Scope decisions (locked)

1. **`restricts iteration { ... }`** — deferred. Reject at parse with *"iteration restrictions deferred until for-in iteration lands (phase 7)"*. Rationale: language has no `for item in xs` (only C-style numeric `for`); generic traits like `Iterable<T>` are phase 7. Nothing to restrict against.
2. **`layout { align N; }`** — functional, codegen-affecting. When a binding's resolved kind declares `layout { align N }`, the alloca emits with `align N`. Sub-clauses beyond `align` (packing, SoA/AoS) reject at parse.
3. **`contains<K>`** — stays deferred. Continue typecheck-rejecting per 6.4.
4. **Composition `kind X = A & B;`** — **structural union with contradiction detection**. X inherits every clause from A and B flatly. No nominal `X is-a A` subtyping; a binding declared with kind `X` is not interchangeable with kind `A`. Contradictions error at the `&` site.

## Goal program

`examples/pass/layout_compose/main.yoop`:

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

trait Disposable { function dispose(ref self): void; }

kind aligned(n: usize) {
    appliesTo type binding;
    layout { align n; };
}

kind disposable_base {
    appliesTo binding;
    requires Disposable;
    ownsBlock;
    mustCall dispose beforeScopeEnd;
}
kind noescape { appliesTo binding; mustNotEscape scope; }
kind scoped_alt = disposable_base & noescape;

type Vec4 aligned(32) implements Disposable {
    x: float32, y: float32, z: float32, w: float32,
    function dispose(ref self): void { printf(`bye vec4\n`); }
}

function main(): int32 {
    let v: Vec4 = { x: 1.0, y: 2.0, z: 3.0, w: 4.0 };   // type-level layout
    scoped_alt h: Vec4 = { x: 5.0, y: 6.0, z: 7.0, w: 8.0 };
    printf(`v.x=%f h.x=%f\n`, v.x, h.x);
    return 0;
}
```

Expected output:
```
v.x=1.0 h.x=5.0
bye vec4
```

Emitted IR shows `alloca %struct.Vec4, align 32` for both `v` (alignment inherited from the type's kind prefix) and `h` (alignment is `max(natural, type-level)` since `scoped_alt` itself has no `layout`). The `bye vec4` line fires once at scope exit because of `scoped_alt`'s `mustCall dispose` from the composition.

What this proves: (1) `kind aligned(n: usize)` parses; (2) `appliesTo type binding` parses (multi-site including `type`); (3) `layout { align n; }` substitutes parameter `n` at the use site; (4) `type Vec4 aligned(32) { ... }` (kind prefix on type decl) parses and pins the type's alignment; (5) `kind scoped_alt = disposable_base & noescape;` composes; (6) the composed kind's `mustCall` and `mustNotEscape` both fire on `h`.

## In scope

### Lexer ([src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js))

- New keyword tokens: `layout`, `align` (both reserved per [SPEC §14](../SPEC.md#L908)). Add to `TokenTags` and `keywordTagList`.
- Recognize standalone `&` (single ampersand) as `TokenTags.amp`, distinct from the existing `&&`. Used only in composition syntax in 6.5.

### Parser ([src/jsyooparser/parser.js](../src/jsyooparser/parser.js))

1. **`parseKindDecl` — parameter list.** When `peek().tag === lparen` after the kind name (currently rejected at [parser.js:336-342](../src/jsyooparser/parser.js#L336)), consume `(`, parse comma-separated `IDENT : type` pairs, `)`. Store on `node.params: KindParam[]`. Type annotations parse through existing `parseTypeAnnotation`; in 6.5 only `usize`, `int32`, `uint32` are accepted (enforced at typecheck).
2. **`parseKindDecl` — composition.** When `peek().tag === eq` after the kind name (currently rejected at [parser.js:343-349](../src/jsyooparser/parser.js#L343)), consume `=` then parse one or more kind references separated by `&`. A kind reference is `IDENT` optionally followed by `( argList )`. Terminate with `;`. Produces `node.composition: { kindRefs: KindRef[] }` with no `clauses`.
3. **`layout` clause.** Remove the entry in `DeferredKindClauseMessages` at [parser.js:48](../src/jsyooparser/parser.js#L48) and add `layout` to `isKindClauseStartTag` ([parser.js:29-39](../src/jsyooparser/parser.js#L29)). Grammar:
   ```
   layoutClause := "layout" "{" layoutSub ";" "}" ";"
   layoutSub    := "align" expr
   ```
   `expr` is parsed via the existing `parseExpression`; in 6.5 the resolved value must be a constant integer literal or an identifier matching a kind parameter (validated at typecheck). Any other identifier at the `layoutSub` start position rejects with *"layout sub-clause '<X>' deferred"*. Duplicate `align` within one layout body rejects as duplicate.
4. **`appliesTo type`.** Remove the rejection at [parser.js:451-456](../src/jsyooparser/parser.js#L451). Map `TokenTags.type → "type"`. Update the still-rejected `function` site error to point at "phase 7+" (user-declared function kinds with `provides Trait` rewriting return types stays deferred).
5. **Kind prefix on type decl.** In `parseTopLevel` (after the `type IDENT` head is consumed, before `implements`/`propagates`/`{`), allow a single kind application: `IDENT` plus optional `( argList )`. Store as `typeDecl.kindPrefix: { name, args, sourceLoc } | null`. Multi-kind prefix on type decls is rejected in 6.5.
6. **Kind arguments at use sites.** Currently the kind-prefix on bindings/parameters is a bare `IDENT IDENT :`. Widen the kindPrefix recognizer to accept `IDENT ( argList ) IDENT :`. Store `kindPrefix.args: Expr[] | null` on the binding/parameter node.
7. **`propagates<K(n)>` argument syntax.** Widen the propagates-list parser to read `IDENT ( argList )?` per entry, producing `{ name, args, sourceLoc }`.
8. **Deferred messages updated.** `restricts → "iteration restrictions deferred until for-in iteration lands (phase 7)"`. `contains<K>` continues to reject at typecheck (unchanged from 6.4).

### Typechecker ([src/jsyooptypecheck/](../src/jsyooptypecheck/))

1. **`KindType` extension** ([types.js](../src/jsyooptypecheck/types.js)). New fields:
   ```js
   this.params = [];          // KindParam[]: { name, type, sourceLoc }
   this.layoutAlign = null;   // { kind: "const", value } | { kind: "param", name } | null
   this.composedFrom = null;  // KindRef[] | null — diagnostics only; clauses flattened
   ```
   New record `KindApplication { kindType: KindType, args: ConstantValue[] }` — the resolved form stored on each use site. Same `KindType` (e.g. `aligned`) can be applied with different args at different sites; the application is what's compared, with arg identity by value.
2. **Pass A — kind shell.** Record `kt.params` from the parser. For composition decls (no clauses), keep an empty shell; the merge happens in C.2.
3. **Pass C.2 — `resolveKindClauses` layout arm.** Validate the `align` expression: an integer literal becomes `{ kind: "const", value }`; an identifier referencing a `kt.params` entry becomes `{ kind: "param", name }`. Other expression shapes reject with *"layout align must be a constant or kind parameter reference"*. Constant values must be powers of two and `<= 4096` (LLVM's practical alignment ceiling).
4. **Pass C.2 — `resolveKindComposition` (new).** For each kind decl with `composition`: resolve every referenced kind in the local kind table (cross-module names use the imported table from 6.4). For each reference, validate arg count against `params.length` and arg types against parameter types. Then **flatten clauses** into the composed kind's slots (`requires`, `mustCall`, `ownsBlock`, `mustNotEscape`, `mustNotShare`, `forbids`, `layoutAlign`, `appliesTo`).
   - **Contradictions**: two `mustCall` clauses naming different methods → error. Two `layoutAlign` constants with different values → error *"composition contradiction: align N vs align M"*. `appliesTo` sets **intersect**: composed kind's `appliesTo` is the intersection of components'. Empty intersection → error *"composition has no common application site"*. `mustNotEscape`, `ownsBlock`, `mustNotShare` clauses union as booleans. `forbids` and `requires` clauses union as sets.
   - **One level**: nested composition (`kind A = (B & C) & D;`) is rejected — composition operands must be bare or parametric kind references. The parser already restricts to flat `IDENT(args)? & IDENT(args)? & ...`.
   - Record `kt.composedFrom` for diagnostics.
5. **`KindApplication` resolution at every use site.** Wherever the typechecker resolves a kind name today (`checkLetDecl`/`checkConstDecl`, parameter kind prefix, propagates-clause entries, the new type-decl prefix), produce a `KindApplication` rather than a bare `KindType`:
   - Look up the kind in the module's kind table (post-import).
   - Validate arg count matches `kt.params.length`.
   - Args must be **compile-time constants** in 6.5 (literal expressions, typechecked against the param's declared type). Non-constant args reject with *"kind argument must be a constant in phase 6.5"*.
   - Validate `kt.appliesTo` includes the relevant site.
   - Store the application on the AST node as `node.resolvedKindApplication`.
6. **`appliesTo type` semantics.** A kind prefix on a type decl resolves to a `KindApplication`; the kind's `appliesTo` must include `"type"`. The `StructType` gains `kindApplication: KindApplication | null`. **The kind's effect on the type is layout only**: a binding of that struct type inherits the alignment (via the `alignOfStruct` helper, see Codegen) without the user writing the kind prefix at the binding site. Other clauses on a type-applying kind (e.g. a hypothetical `mustCall` on a `appliesTo type` kind) do *not* auto-attach to plain bindings — they require an explicit binding-site kind prefix. This matches the spec's `simd_aligned` intent: type-level kinds carry layout/representation facts; lifecycle is opted in per binding.
7. **Parameter substitution.** When a `KindApplication` is used by codegen (or anywhere that needs the resolved layout/value), walk the kind's clauses substituting `{ kind: "param", name }` slots with the corresponding `app.args[paramIndex]`. The only place this currently matters in 6.5 is `layoutAlign`; other clauses don't reference parameters in this phase.
8. **`propagates<K(n)>`.** Each entry now resolves to a `KindApplication` rather than a bare `KindType`. `StructType.propagatedKinds: KindApplication[]`; `FuncType.returnPropagatedKinds: KindApplication[]`. 6.4's field-carries-kind check compares by `app.kindType` identity (args don't affect propagation matching). 6.4 fixtures keep passing.
9. **Composition identity.** A binding declared `scoped_alt h: Vec4` resolves to `KindApplication(KT_scoped_alt, [])`. The composed kind's flattened `mustCall`/`mustNotEscape` clauses fire because they live directly on `KT_scoped_alt`. A binding with kind `scoped_alt` is *not* assignment-compatible with a parameter typed `disposable_base h: ...` — kind identity is nominal at use sites; only the clause set on the composed kind is unioned.

### Codegen ([src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js))

Single observable change: `alloca` alignment.

1. **Helper `effectiveAlign(declType, kindApp)`.** Given a resolved type and an optional `KindApplication`, returns the binding's alignment:
   - If `kindApp` has a non-null `layoutAlign` after parameter substitution, return that integer.
   - Else if `declType.kind === typeKinds.struct` and `declType.kindApplication?.layoutAlign` is set, return the type-level alignment (substituting params from the type's stored application).
   - Else fall through to existing `alignOfStruct(declType)` / `alignOf(llvmTy)`.
2. **Wire into every alloca site.** Replace the alignment computation at the existing alloca emission points (binding decl, parameter binding, struct return slot) with `effectiveAlign(declType, node.resolvedKindApplication)`.
3. **Type-level alignment propagation.** Extend `alignOfStruct(structType)` to return `max(natural-align, structType.kindApplication ? substitutedAlign : 0)`. Every alloca of the struct (even one without a binding-site kind prefix) inherits the type-level alignment. Globals and field-embedded uses pick it up via the same helper.
4. **No new runtime ABI**, no new LLVM intrinsics, no new IR node kinds. Composition and parameterization are purely compile-time; layout flows through the existing `align` attribute on `alloca`.

## Out of scope (carries past 6.5 into phase 7+)

Phase 6 closes with these explicit deferrals:

- **`restricts iteration { ... }`** — waits on `for item in xs.method()` and the generic iterator traits ([SPEC §9](../SPEC.md#L581)), both phase 7. Parse-rejected.
- **`contains<K>`** — typecheck-rejected with the 6.4 message. No forcing use case has appeared.
- **`layout` sub-clauses beyond `align`** — packing, SoA/AoS. Parse-rejected per sub-clause name.
- **`forbids` enforcement** — still parse-and-store from 6.2; no effect-tracker.
- **`mustNotShare acrossScopes` enforcement** — still parse-and-store from 6.2.
- **Suspendable `wait`**, **`abandon` operator**, **`mustCall` disjunction `{ a; b; }`**, **`mustCall fn beforeAny`/`afterAny`** — unchanged from earlier sub-phases.
- **User-declarable generics** — phase 7. Doesn't affect 6.5's monomorphic fixtures.
- **Non-constant kind arguments** (`aligned(n)` where `n` is a runtime value) — parser accepts, typechecker rejects.
- **Multi-kind prefix on type decls** — single prefix per type decl in 6.5.
- **Nested composition** (`kind A = (B & C) & D;`) — flat composition only.
- **User-declared `appliesTo function` kinds with `provides Trait`** — the `task` built-in covers the only motivating use; user declarations still rejected.

## Verification

End-to-end:
```sh
node ./src/yoopiler.js -i examples/pass/layout_compose/main.yoop -o output
./output.exe
```
Expected: stdout matches §Goal; emitted IR contains `alloca %struct.Vec4, align 32` for both `v` and `h`; the `bye vec4` line fires once at scope exit for `h` (from `scoped_alt`'s composed `mustCall dispose`).

Negative fixtures under `examples/fail/`:

- `kind_compose_contradiction.yoop` — `kind bad = aligned(32) & aligned(64);` → *"composition contradiction: align 32 vs align 64"*.
- `kind_compose_no_common_site.yoop` — composing a `appliesTo binding`-only kind with a `appliesTo type`-only kind → *"composition has no common application site"*.
- `kind_param_wrong_type.yoop` — `kind aligned(n: string) { ... }` → *"kind parameter type 'string' not yet supported"*.
- `kind_app_arg_mismatch.yoop` — `aligned v: Vec4 = ...` missing args → *"kind 'aligned' expects 1 argument(s)"*.
- `kind_app_non_constant.yoop` — `aligned(n) v: ...` where `n` is a local variable → *"kind argument must be a constant in phase 6.5"*.
- `restricts_deferred.yoop` — kind body containing `restricts iteration { ... }` → *"iteration restrictions deferred until for-in iteration lands (phase 7)"*.
- `type_prefix_kind_not_appliesto_type.yoop` — `type Vec4 disposable { ... }` where `disposable.appliesTo` lacks `type` → *"kind 'disposable' does not apply to types"*.
- `layout_unknown_subclause.yoop` — `layout { packing tight; }` → *"layout sub-clause 'packing' deferred"*.
- `nested_composition.yoop` — `kind A = (B & C) & D;` → composition operands must be kind references.

Full regression: every fixture under `examples/pass/` and `examples/fail/` for 6.1–6.4 continues to pass with no changes.

## Critical files

- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — `layout`, `align` keywords; standalone `&` token.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — `parseKindDecl` param-list + composition arms; `parseLayoutClause`; kind-app argument syntax on binding/parameter/propagates entries; `appliesTo type` site enabled; `parseTypeDecl` accepts a single kind prefix; deferral messages updated.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) — `KindType.params`, `KindType.layoutAlign`, `KindType.composedFrom`; new `KindApplication` record; `StructType.kindApplication`.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) — Pass C.2: layout-arm validation and new `resolveKindComposition`; `KindApplication` resolution wired into every kind-use site.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js) — bindings/parameters resolve kind args; site validation widened to include `"type"`.
- [src/jsyooptypecheck/imports.js](../src/jsyooptypecheck/imports.js) — cross-module kind import already handles parameterized kinds unchanged (`params` field comes along with the `KindType`); add a sanity assertion to confirm.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — `effectiveAlign` helper; wire into every alloca-emitting site; `alignOfStruct` extension for type-level kind alignment.
- New fixtures under `examples/pass/layout_compose/` and `examples/fail/` per §Verification.
