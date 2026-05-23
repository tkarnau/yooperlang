# Strict `propagates<K>` enforcement

## Context

`propagates<K>` (Phase 6.4) is partly implemented: the parser/typechecker accept and store the clause on both struct types (`StructType.propagatedKinds`) and function return types (`FuncType.returnPropagatedKinds`), but enforcement is incomplete in two ways:

1. **Function-side leak.** A function can return a value whose type has `propagates<K>` *without* declaring `propagates<K>` on its own signature. The `mustCall` obligation on the local binding silently disappears at `return`. `returnPropagatedKinds` is populated ([typecheck.js:1697-1712](src/jsyooptypecheck/typecheck.js#L1697)) but never consumed anywhere.
2. **Implicit caller acquisition.** At a call site, a binding of a `propagates<K>` type implicitly acquires K's obligations from the struct's `propagatedKinds` list ([kindCheck.js:128-198](src/jsyooptypecheck/kindCheck.js#L128)) — no kind keyword required, no visible signal in the source.

The intended design (per user) is that propagation chains must be **explicit at every boundary**: a helper function that returns a propagating type must either satisfy the obligations itself or re-declare `propagates<K>` so the caller knows it inherits them, and call-site bindings must opt in with an explicit kind keyword. This is the same shape envisioned for future kinds like `transaction-start`/`endtrans` and keeps callsite interaction unambiguous.

Concrete current example — [examples/playground/dynamic_array/main.yoop](examples/playground/dynamic_array/main.yoop):

- Line 54: `function new_dynarray<T>(...): DynArray<T>` — no `propagates<disposable>` clause; should be required.
- Line 55: `const newArr: DynArray<T> = { ... }` — implicitly acquires obligation; should require `disposable` prefix.
- Line 85: `let arr: DynArray<int32> = new_dynarray(4);` — same; should require `disposable` prefix.

## Approach

All enforcement lives in [src/jsyooptypecheck/kindCheck.js](src/jsyooptypecheck/kindCheck.js). The signature shape doesn't change; this is purely a new validation pass plus a tweak to where obligations are acquired.

### 1. Stop implicit acquisition from `propagatedKinds`

In `obligationsFor()` at [kindCheck.js:131-198](src/jsyooptypecheck/kindCheck.js#L131), gate the self-propagation and propagated-field branches on the binding having an explicit `resolvedKindType` matching the propagated kind. If `stmt.resolvedKindType !== propK`, skip — the obligation will be re-emitted via the explicit-kind branch at lines 108-125 because the user wrote the keyword.

Net effect: implicit acquisition is gone. The same struct-type lookups still drive `fieldCarriesKind` for container structs, but only when the binding actively opts in.

### 2. Require explicit kind prefix on initializers of propagating types

Add a new check in the `LET_DECL`/`CONST_DECL` branch ([kindCheck.js:270-303](src/jsyooptypecheck/kindCheck.js#L270)), before `obligationsFor(stmt)`. Compute the set of kinds with `mustCall` obligations that the initializer brings in:

- Resolved type is a struct with `propagatedKinds` containing any `mustCall` kinds (covers struct literals and calls of all flavors).
- For call-expression initializers, also union the callee's `FuncType.returnPropagatedKinds` (handles cases where the function transferred an obligation that's not visible from the type alone — useful once `contains<K>` lands later, but harmless now).

For each such kind `K`:
- If `stmt.resolvedKindType === K` → satisfied (user declared it).
- Else → `pushError(errors, stmt, "binding '${stmt.name}' inherits obligation from propagates<${K.name}> on type ${T.name}; declare it explicitly with the '${K.name}' kind keyword")`.

Skip builtin kinds (`pooled`/`joined`) — those follow Phase 6.3 task rules.

### 3. Enforce function-level `propagates<K>` at RETURN_STATEMENT

Extend the RETURN_STATEMENT handler ([kindCheck.js:305-320](src/jsyooptypecheck/kindCheck.js#L305)). After existing escape-sentinel handling and after `walkExpr(stmt.value)`:

- If the function's `fnOrMethodDecl` declares `returnPropagatedKinds`, build a set of those kinds.
- Compute the kinds the returned expression carries:
  - If `stmt.value.kind === IDENT`, search the active obligation stack for entries with `bindingName === ident.name` and type `"mustCall"`. Each such entry implies a kind — store the source kind on the obligation when emitting it (extend obligation shape with a `kindType` field in Step 1's emit sites).
  - Additionally, if `stmt.value.resolvedType` is a struct with `propagatedKinds`, union those kinds (covers struct-literal and call returns where no local binding exists).
- For each carried kind `K`:
  - If `K` is in `returnPropagatedKinds` → mark the matching active obligation `transferred = true`; the caller will pick it up via Step 2 (which now requires an explicit prefix).
  - Else → `pushError(errors, stmt, "function returns a value of type ${T.name} carrying propagates<${K.name}>; either declare 'propagates<${K.name}>' on the function or satisfy the obligation before return")`.

### 4. Don't emit cleanup calls for transferred obligations

`flattenStackReverse()` at [kindCheck.js:318](src/jsyooptypecheck/kindCheck.js#L318) (used for `pendingCleanups` at return) and the `block.implicitCleanups` projection at [kindCheck.js:260-263](src/jsyooptypecheck/kindCheck.js#L260) must filter out obligations marked `transferred`. Same for the trailing-block variant at [kindCheck.js:293-296](src/jsyooptypecheck/kindCheck.js#L293).

Otherwise codegen would auto-dispose a value that was just returned to the caller.

### Scope note: local satisfaction (deferred)

If the user explicitly calls the cleanup method mid-scope (e.g. `Disposable.dispose(ref x)` before `return x`), today there's no flow-sensitive tracking that marks the obligation satisfied. This work treats any unsatisfied-at-return obligation as still pending. Adding "satisfied" tracking is a small follow-up (a flag flipped in `walkExpr` when we see a direct `Trait.method(ref name)` call against an active obligation). Leave a comment in `kindCheck.js` noting this.

## Files to modify

- **[src/jsyooptypecheck/kindCheck.js](src/jsyooptypecheck/kindCheck.js)** — Steps 1-4. Tag obligations with `kindType`, gate `propagatedKinds` walk on explicit prefix, add LET_DECL "must declare" check, add RETURN_STATEMENT transfer/error logic, filter `transferred` from cleanup projections.
- **[examples/playground/dynamic_array/main.yoop](examples/playground/dynamic_array/main.yoop)** — add `propagates<disposable>` to `new_dynarray` ([line 54](examples/playground/dynamic_array/main.yoop#L54)); add `disposable` prefix to `newArr` ([line 55](examples/playground/dynamic_array/main.yoop#L55)) and `arr` ([line 85](examples/playground/dynamic_array/main.yoop#L85)); update the leading comment block (lines 1-15) to reflect the new "always explicit" rule.
- **[examples/pass/generic_disposable_propagates.yoop](examples/pass/generic_disposable_propagates.yoop)** — audit + add kind prefixes where bindings now need them; ensure factory functions declare `propagates<K>` on the return type. Verify the test still passes end-to-end.
- **[examples/pass/propagates_full/main.yoop](examples/pass/propagates_full/main.yoop)** — same audit: every binding of a `propagates<K>` type needs its explicit prefix; every factory returning such a type needs the clause.
- **Audit other pass fixtures** — grep for `propagates<` to find any fixture that relied on implicit acquisition; add prefixes as needed.

## New test fixtures

- **`examples/fail/propagates_return_not_declared.yoop`** — factory returns `DynArray<int32>` (which has `propagates<disposable>`) but the function omits the clause. Expect the function-side error from Step 3.
- **`examples/fail/propagates_binding_missing_kind.yoop`** — `let arr: DynArray<int32> = new_dynarray(4);` with no kind prefix. Expect the LET_DECL error from Step 2.
- **`examples/fail/propagates_struct_literal_missing_kind.yoop`** — `const x: DynArray<T> = { data: ..., len: 0, cap: 0 };` without prefix where `DynArray` propagates `disposable`. Same error shape as the binding-missing case but via struct literal.

Fail-test discovery follows the existing convention in [src/e2e.test.js](src/e2e.test.js) — verify these are picked up automatically (or add explicit cases there if needed).

## Verification

1. `npm run test:unit` — kindCheck unit tests; add cases mirroring the three new fail fixtures plus a transferred-via-propagates pass case.
2. `npm run test:e2e` — full pipeline, ensures the updated dynamic_array playground still compiles, links, runs, and prints the expected dispose line. The pass/ examples must still pass; the new fail/ examples must report the expected error string.
3. Manually run `node src/yoopiler.js examples/playground/dynamic_array/main.yoop` after the changes — confirm the dispose message still prints exactly once at scope end.
4. Run `node src/yoopiler.js` against each new fail fixture and confirm the diagnostic text matches the planned wording.

## Out of scope (potential follow-ups)

- Flow-sensitive "obligation satisfied locally before return" detection (the deferred case above).
- The `contains<K>` concept mentioned in the user's design notes — leave for a later phase.
- Codegen changes — none expected; the auto-inserted cleanup logic already keys off `pendingCleanups`/`implicitCleanups` arrays, and Step 4 just filters those at the source.
