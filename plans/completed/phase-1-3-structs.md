# Phase 1.3 — Struct types

Part of the [roadmap](./roadmap.md). Phases 1.1 and 1.2 set up clean numeric literals and a real typechecker pass. This phase adds the first compound type: structs. It exercises every layer of the compiler — lexer (new keyword), parser (new top-level form, new infix `.`, new prefix `{...}`), typechecker (struct registration, field resolution, struct-literal target-type pinning), and codegen (struct emission, GEP, struct-by-value).

## Goal

Land a working subset of [SPEC.md §3 — Struct](../SPEC.md):

```yoop
type Point {
    x: int32,
    y: int32,
}

function distance_sq(p: Point): int32 {
    return p.x * p.x + p.y * p.y;
}

function main(): int32 {
    let p: Point = { x: 3, y: 4 };
    printf(`distance_sq = ${distance_sq(p)}\n`);
    return 0;
}
```

Concretely:
- `type Name { f: T, ... }` parses, registers, and reaches codegen as `%struct.Name = type { ... }`
- `expr.field` reads (and `expr.field = ...` writes for plain locals)
- `{ f: e, ... }` literals only in expression position, target type pinned by context
- Struct values pass as parameters, get returned, assign to locals — first-class
- Field-access type errors and struct-literal field mismatches are caught in the typechecker, not codegen

## Why this is next

It's the smallest new language feature that needs every pass we just refactored to cooperate. Phase 1.2's payoff was the type system — Phase 1.3 is the first feature that genuinely needs it (`p.x` requires a real type lookup, not a string match). It's also a prerequisite for Phase 2 (errors as values are just structs with an `err: string` field), so getting struct semantics right now unblocks the next phase.

## Scope (what this phase does NOT do)

- **No methods** on types. Method blocks are part of trait impls (Phase 5). `type X { ... }` here is plain data only.
- **No `implements`** clause. Reserve the `StructType.implements` field (already on the type per Phase 1.2 — leave it `[]`), but do not parse `implements`.
- **No struct embedding / inheritance** — spec doesn't have it either.
- **No nested anonymous structs** in field types (`x: { a: int32 }` is not allowed).
- **No struct equality or comparison** operators (`p1 == p2` stays an error).
- **No destructuring** (`const { x, y } = p;`) — that's spec §11 sugar, comes with Phase 2.
- **No fallible-type detection** — even if a struct has an `err: string` field, there's no `?` operator yet. Just a normal struct.
- **No generic structs** — `type Box<T> { ... }` is deferred per spec §3.
- **No struct field default values** — initializer is required to mention every field.

---

## Status snapshot

This plan was originally written before the typechecker was split into per-concern modules. The lexer / AST / parser changes (§1–§3) are **done**. The typechecker structural pieces (§4.a–§4.c, plus the recursive-struct guard) are **done**. What remains, in rough order:

1. **§4.d** — `STRUCT_LITERAL` typechecking (the case in [checkExpr.js:260-262](../src/jsyooptypecheck/checkExpr.js#L260-L262) is currently a commented-out stub).
2. **§4.e** — `ASSIGNMENT` with a `FIELD_ACCESS` target. Currently emits a placeholder "not yet implemented" error at [checkExpr.js:213-226](../src/jsyooptypecheck/checkExpr.js#L213-L226).
3. **§5** — Codegen. None of the struct emission / GEP / struct-pass-by-value paths exist yet; codegen still keys on string `yoopType` names and will need a small refactor to take `Type` objects before structs can be lowered.

The bulk of the new work for the user from here is sections 4.D, 4.E, and all of 5.

---

## Files touched

The typechecker now lives in several files under [src/jsyooptypecheck/](../src/jsyooptypecheck/), not a single `typecheck.js`. Quick map:

- [typecheck.js](../src/jsyooptypecheck/typecheck.js) — orchestration only (the three pre-passes + per-function dispatch). Re-exports the helpers from siblings.
- [checkExpr.js](../src/jsyooptypecheck/checkExpr.js) — `resolveExprType` (was `checkExpr`) and `resolveCallType`.
- [checkStatement.js](../src/jsyooptypecheck/checkStatement.js) — `validateFunction` and `validateStatement` (was `checkFunction` / per-stmt cases inside `checkExpr`).
- [coerce.js](../src/jsyooptypecheck/coerce.js) — `isAssignable`, `unifyArith`, `coerceLiteralToType`.
- [scope.js](../src/jsyooptypecheck/scope.js) — `pushScope`, `lookupInScope`, `declareInScope`.
- [errors.js](../src/jsyooptypecheck/errors.js) — `pushError`, `formatType`.
- [recursiveStruct.js](../src/jsyooptypecheck/recursiveStruct.js) — `detectRecursiveField` (already wired in).
- [types.js](../src/jsyooptypecheck/types.js) — Type factories. Note: the helper is **`resolveTypeFromName(name, structTable)`** (the original plan called it `resolveTypeName`).

**Edited / to edit**:

- [src/contracts.js](../src/contracts.js) — done: `TYPE_DECL`, `FIELD_DECL`, `FIELD_ACCESS`, `STRUCT_LITERAL`, `STRUCT_LITERAL_FIELD` are all registered.
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — done: `type` keyword and `.` punctuation.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — done: top-level dispatch, `parseTypeDecl`, postfix `.field` loop, struct-literal prefix branch, generalized `ASSIGNMENT` with `target`.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) — done: `StructType` factory, `resolveTypeFromName(name, structTable)`, nominal `typesEqual` for struct kind.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) — done: three-pass struct registration (shells → fields → function sigs); per-function handoff to `validateFunction`.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) — done: `FIELD_ACCESS` case. **Pending**: `STRUCT_LITERAL` case; `ASSIGNMENT` with `FIELD_ACCESS` target (currently a placeholder error).
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js) — **pending**: `LET_DECL` / `CONST_DECL` / `RETURN_STATEMENT` need to recognise an unpinned `STRUCT_LITERAL` initializer/return value and pin it to the declared/expected type.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — **pending**: emit `%struct.X` declarations, GEP-based field read/write, struct-literal materialization, struct pass-by-value, struct return. This file currently keys on string `yoopType` names everywhere — see §5(b).

---

## 1. Lexer changes ([lexer.js](../src/jsyooplexer/lexer.js)) — done

Already in place:

- `type` keyword: `TokenTags.type = 38` ([lexer.js:42](../src/jsyooplexer/lexer.js#L42)) plus the `keywordTagList` entry ([lexer.js:115](../src/jsyooplexer/lexer.js#L115)).
- `.` punctuation: `TokenTags.dot = 39` ([lexer.js:68](../src/jsyooplexer/lexer.js#L68)) plus the `tokenScanList` entry ([lexer.js:103](../src/jsyooplexer/lexer.js#L103)).

The numeric-literal scanner already only consumes `.` as a fractional part if `isDigit(src[end+1])` — so `1.foo` lexes as `intLiteral(1)`, `dot`, `ident("foo")`. Phase 1.1 chose this rule explicitly; nothing to change.

---

## 2. AST node kinds ([contracts.js](../src/contracts.js)) — done

All five kinds are present in [contracts.js](../src/contracts.js):

```js
TYPE_DECL: "TYPE_DECL",                    // type Point { x: int32, y: int32, }
FIELD_DECL: "FIELD_DECL",                  // a single { name, type } inside a TYPE_DECL
FIELD_ACCESS: "FIELD_ACCESS",              // p.x
STRUCT_LITERAL: "STRUCT_LITERAL",          // { x: 1, y: 2 }
STRUCT_LITERAL_FIELD: "STRUCT_LITERAL_FIELD",  // a single { name, value } inside a STRUCT_LITERAL
```

---

## 3. Parser changes ([parser.js](../src/jsyooparser/parser.js)) — done

Already implemented:

- **Top-level `type` dispatch** at [parser.js:94-98](../src/jsyooparser/parser.js#L94-L98).
- **`parseTypeDecl`** at [parser.js:441-468](../src/jsyooparser/parser.js#L441-L468). Includes a small bonus path for type aliases (`type X = Y` style — sets `node.targetType` instead of `node.fields`); the typechecker ignores aliases for now, only `node.fields` flows through.
- **Postfix `.field` loop** at [parser.js:183-195](../src/jsyooparser/parser.js#L183-L195) — runs after the primary, before binary ops, so `a.b * 2` parses as `(a.b) * 2`.
- **Struct-literal prefix `{ ... }`** at [parser.js:162-176](../src/jsyooparser/parser.js#L162-L176). The disambiguation works positionally: `parseStatement` dispatches `return` / `let` / `const` / `if` / `while` / expression-statement, and `parseBlock` is only called from places that expect a block (function body, if/while body) — so a bare `{` reaching `parseExpression` is unambiguously a struct literal.
- **Generalized `ASSIGNMENT` with `target`** at [parser.js:200-214](../src/jsyooparser/parser.js#L200-L214) — chose the recommended Option 1 from the original plan. After the primary + postfix chain, an `=` triggers wrapping the lvalue (which must be `IDENT` or `FIELD_ACCESS`) into an `ASSIGNMENT` node. Assignment binds loosest and doesn't chain into the binary loop.

---

## 4. Typechecker changes

The original plan called the dispatcher `checkExpr`. After Phase 1.2's split it is now **`resolveExprType`** in [checkExpr.js](../src/jsyooptypecheck/checkExpr.js); per-statement logic lives in **`validateStatement`** in [checkStatement.js](../src/jsyooptypecheck/checkStatement.js); function-level setup is **`validateFunction`**. The orchestration (the three pre-passes) is still in [typecheck.js](../src/jsyooptypecheck/typecheck.js).

Throughout the typechecker, `ctx` carries `ctx.typeContext = { moduleSymbols, structTable }` (so e.g. `ctx.typeContext.structTable` rather than the original plan's `ctx.structTable`). The plan below uses the current shapes.

### a) Three-stage struct registration — done

Implemented in [typecheck.js:53-121](../src/jsyooptypecheck/typecheck.js#L53-L121). Three passes (the original plan called this two-stage; it is now genuinely three because the function-signature pass is split out so it can resolve struct-typed params/returns):

1. **Shells**: walk `ast.body`; for each `TYPE_DECL`, register `StructType(name, null)` in `structTable`. Reject redeclarations.
2. **Fields**: walk again; for each `TYPE_DECL`, resolve every field's type via `resolveTypeFromName(field.type, structTable)`, push errors for unknown / duplicate / recursive fields, and replace the shell with a populated `StructType(name, fields)`. Also stamp `decl.resolvedType = fullType` so codegen can pull the canonical struct shape from the AST node.
3. **Function signatures**: walk again; for each `FUNCTION_DECL`, build a `FuncType` using `resolveTypeFromName` (so struct-typed params/returns capture the populated `StructType`).

Recursive-struct rejection lives in [recursiveStruct.js](../src/jsyooptypecheck/recursiveStruct.js) and is already wired into pass 2.

### b) Resolve struct names in let/const/param/return-type annotations — done

`primTypeFromName` is no longer called from any check site — every annotation goes through `resolveTypeFromName(name, structTable)`. Live sites:

- Param resolution: [checkStatement.js:26-33](../src/jsyooptypecheck/checkStatement.js#L26-L33).
- Return-type resolution: [checkStatement.js:35-41](../src/jsyooptypecheck/checkStatement.js#L35-L41).
- Let/const declared type: [checkStatement.js:64-69](../src/jsyooptypecheck/checkStatement.js#L64-L69).
- Pre-pass funcType build: [typecheck.js:111-117](../src/jsyooptypecheck/typecheck.js#L111-L117).

`resolveTypeFromName` is the *only* type-name lookup helper in the typechecker now.

### c) `FIELD_ACCESS` in `resolveExprType` — done

Implemented at [checkExpr.js:232-259](../src/jsyooptypecheck/checkExpr.js#L232-L259). Recurses into `node.object`, errors if the object's type isn't `struct`, looks up the named field in `objType.fields`, sets `node.resolvedType = field.type`. Cascading errors are suppressed when the object's type is already an `error` type.

### d) `STRUCT_LITERAL` in `resolveExprType` — **pending**

This is the next thing to implement. The case is currently a commented-out stub at [checkExpr.js:260-262](../src/jsyooptypecheck/checkExpr.js#L260-L262):

```js
// case ASTNodeKind.STRUCT_LITERAL: {

// }
```

**Why it's awkward.** A struct literal `{ x: 1, y: 2 }` cannot be typed in isolation — `{ x: 1 }` could be a `Point2D`, a `JustX`, anything with an `x` field. The literal needs a *target type* from its surrounding context (a let-decl's declared type, a return statement's expected type, a call argument's param type, or an assignment LHS's type). This is the same shape problem we already solve for untyped int/float literals (see [checkStatement.js:81-97](../src/jsyooptypecheck/checkStatement.js#L81-L97) — coercion happens in the *caller* after `resolveExprType` returns).

**Recommended approach.** Mirror the literal-coercion pattern that already works:

1. In `resolveExprType`, if `STRUCT_LITERAL` shows up uninvited (no caller has pinned it), recurse through each field's `value` so child errors still surface, then set `node.resolvedType = ErrorType()` and push `"struct literal has no target type"`. This keeps the case from blowing up on stray literals like `{x:1};` as an expression statement.
2. Add a new helper `pinStructLiteral(litNode, targetType, scope, ctx)` — most natural home is [checkExpr.js](../src/jsyooptypecheck/checkExpr.js) alongside `resolveExprType`, since it walks expression nodes. It does:
   - Reject `targetType.kind !== "struct"` ("cannot assign struct literal to non-struct type X").
   - Walk `targetType.fields` once into a Map of `name -> declared field type`.
   - For each `STRUCT_LITERAL_FIELD` in the literal: dedupe by name; look up the declared field type; recurse `resolveExprType(lf.value, scope, ctx)`; check `isAssignable(expected, valueType)`; if the value is an untyped literal, call `coerceLiteralToType`. Recurse `pinStructLiteral` if `lf.value.kind === STRUCT_LITERAL` (nested literals like `{ inner: { v: 42 } }`).
   - After the loop, complain about any declared field that wasn't seen ("missing field 'y' in struct literal").
   - Set `litNode.resolvedType = targetType`.
3. Call `pinStructLiteral` from each context that supplies a target type:
   - **Let/const initializer** ([checkStatement.js:71-98](../src/jsyooptypecheck/checkStatement.js#L71-L98)): before the existing `resolveExprType(node.assignment, ...)` call, special-case `node.assignment?.kind === STRUCT_LITERAL` to call `pinStructLiteral(node.assignment, declaredType, scope, ctx)` instead. Skip the `isAssignable` re-check after — pinning has already done it field-wise.
   - **Return statement** ([checkStatement.js:112-132](../src/jsyooptypecheck/checkStatement.js#L112-L132)): same pattern, target type is `ctx.funcReturnType`.
   - **Call argument** ([checkExpr.js:286-297](../src/jsyooptypecheck/checkExpr.js#L286-L297) inside `resolveCallType`): when `paramType.kind === "struct"` and `node.args[i].kind === STRUCT_LITERAL`, pin instead of `resolveExprType`. Useful for `distance_sq({ x: 3, y: 4 })`.
   - **Assignment RHS** (see §4.e below).

The reason to keep this as a separate helper rather than threading an `expectedType` parameter through every `resolveExprType` recursion: literal coercion already uses the "caller pins after the fact" pattern, and adding an `expectedType` param would touch every call site. The downside is each caller has to remember to special-case `STRUCT_LITERAL` — that's a small, finite list, and the unhandled fallback in `resolveExprType` itself produces a clean error.

### e) `ASSIGNMENT` with `target: FIELD_ACCESS` — **pending**

Currently a placeholder at [checkExpr.js:213-226](../src/jsyooptypecheck/checkExpr.js#L213-L226):

```js
if (node.target.kind === ASTNodeKind.FIELD_ACCESS) {
  resolveExprType(node.target, scope, ctx);
  resolveExprType(node.value, scope, ctx);
  pushError(
    ctx.errors,
    node,
    `field assignment typecheck not yet implemented (struct support pending)`,
  );
  node.resolvedType = ErrorType();
  return node.resolvedType;
}
```

Replace with the real check. The shape mirrors the existing IDENT branch right above it ([checkExpr.js:170-211](../src/jsyooptypecheck/checkExpr.js#L170-L211)):

1. `targetType = resolveExprType(node.target, scope, ctx)` — this already validates the field exists and bails out with `ErrorType` on non-struct objects. If `targetType.kind === "error"`, set `node.resolvedType = ErrorType()` and return (cascading errors are suppressed by `isAssignable`).
2. **Mutability check**: walk the chain back to its root and verify the root binding isn't a `const`. The IDENT branch checks `binding.kind === "const"` directly; for nested chains we need a small helper:

   ```js
   function rootIdentOf(node) {
     while (node.kind === ASTNodeKind.FIELD_ACCESS) node = node.object;
     return node.kind === ASTNodeKind.IDENT ? node : null;
   }
   ```

   If the root is an IDENT, look up its binding and reject const (`cannot assign to field of const "p"`). If the root isn't an IDENT (e.g. a call result like `make_pair().x = 1`), reject that too — the LLVM lowering would write to a temporary that gets discarded.
3. RHS handling: if `node.value.kind === STRUCT_LITERAL`, call `pinStructLiteral(node.value, targetType, scope, ctx)`. Otherwise `valueType = resolveExprType(node.value, scope, ctx)` and check `isAssignable(targetType, valueType)`. For untyped int/float values, call `coerceLiteralToType` the same way the IDENT branch does.
4. Set `node.resolvedType = targetType` and return it.

### f) `isAssignable` — already works for structs

[coerce.js:26-57](../src/jsyooptypecheck/coerce.js#L26-L57) calls `typesEqual(dest, src)` first, and `typesEqual` for `struct` kind is now nominal — same name = equal struct ([types.js:156-161](../src/jsyooptypecheck/types.js#L156-L161)). This is necessary for self-referential structs: the deep-walk version in the original plan would loop forever on `type Node { next: Ref<Node> }`. Nothing to change here.

### g) `formatType` — done

[errors.js:21-22](../src/jsyooptypecheck/errors.js#L21-L22) returns `struct ${t.name}`. Fine as-is.

### h) Template literals — already correct

[checkExpr.js:140-156](../src/jsyooptypecheck/checkExpr.js#L140-L156) only allows string / int / float interpolations; struct types fall through and get rejected with `template literal interpolation must be a string, int, or float type, found struct Point`. Verify the negative test catches `${p}` once an end-to-end test exists.

---

## 5. Codegen changes ([codegen.js](../src/jsyoopcodegen/codegen.js)) — **pending**

None of the struct codegen paths exist yet. There is one preparatory refactor that makes everything else shorter, then the actual struct work. Each subsection notes where the change drops in.

### a) Emit struct-type declarations at module top

Currently `emitProgram` ([codegen.js:542-566](../src/jsyoopcodegen/codegen.js#L542-L566)) walks `ast.body` twice (collect function sigs, then emit function bodies) and emits externs in between. Add a *zeroth* pass before the existing first pass:

```js
const structDefs = [];
for (const decl of node.body) {
  if (decl.kind === ASTNodeKind.TYPE_DECL) {
    // decl.resolvedType is the StructType the typechecker stamped on in pass 2.
    const fieldLlvm = decl.resolvedType.fields
      .map(f => llvmType(f.type))
      .join(", ");
    structDefs.push(`%struct.${decl.name} = type { ${fieldLlvm} }`);
  }
}
```

Then prepend `structDefs` to `lines` before the function bodies (or to the `globals` block — order in `allLines` at the bottom of `codegen` decides where it lands). The final IR should look like:

```
%struct.Point = type { i32, i32 }

@.str0 = private unnamed_addr constant [...] ...

declare i32 @printf(ptr, ...)

define i32 @distance_sq(%struct.Point %p.arg) { ... }
define i32 @main() { ... }
```

Why before externs and before function definitions: LLVM verifier requires all named struct types to be declared before use, and function signatures referring to `%struct.Point` are uses.

### b) `llvmType` accepts `Type` objects — preparatory refactor

Right now [codegen.js:28-30](../src/jsyoopcodegen/codegen.js#L28-L30) takes a string `yoopType` and looks it up in `LLVM_TYPES`. Every caller passes either a string literal (`"i32"`) or `node.resolvedType.name` / `param.resolvedType.name` ([codegen.js:513](../src/jsyoopcodegen/codegen.js#L513), [codegen.js:548-549](../src/jsyoopcodegen/codegen.js#L548-L549), etc.). For struct types `name` is fine, but the LLVM form is `%struct.Point`, not `Point`, and there's nothing in `LLVM_TYPES` to handle that.

Rewrite to dispatch on `Type.kind`:

```js
export function llvmType(t) {
  if (typeof t === "string") return LLVM_TYPES[t] ?? "ptr"; // back-compat shim — remove once all callers pass Type
  switch (t.kind) {
    case "prim":   return LLVM_TYPES[t.name] ?? "ptr";
    case "struct": return `%struct.${t.name}`;
    case "void":   return "void";
    case "ref":    return "ptr";
    default: throw new Error(`llvmType: unsupported kind ${t.kind}`);
  }
}
```

Then sweep call sites — most read `.name` off a `resolvedType`. Drop the `.name` and pass the `Type` object instead. Two specific spots to be careful of:

- The `symbols` map ([codegen.js:160](../src/jsyoopcodegen/codegen.js#L160)) currently stores `varName -> string`. Switch to `varName -> Type`. Every load/store site reads from this map (`emitExpr` IDENT case, `LET_DECL`, etc.), so update them in lockstep.
- `printfSpec` and `promotedLlvmType` ([codegen.js:43-85](../src/jsyoopcodegen/codegen.js#L43-L85)) currently take a string and `switch` on it. Either keep them string-keyed and have the call site pass `t.name` only when `t.kind === "prim"` (cleaner), or update them to take `Type` and reject struct kinds explicitly. Either works — pick whichever is shorter when the time comes.

This refactor is independent of structs; once it's in, structs slot in cleanly. Without it, every struct path needs special-casing.

### c) Local struct allocation in `LET_DECL` / `CONST_DECL`

[codegen.js:425-438](../src/jsyoopcodegen/codegen.js#L425-L438) currently does:

```js
const declType = node.resolvedType.name;
symbols.set(node.name, declType);
const llvmTy = llvmType(declType);
fnLines.push(`  %${node.name} = alloca ${llvmTy}, align ${alignOf(llvmTy)}`);
if (node.assignment) {
  const r = emitExpr(node.assignment, fnLines);
  fnLines.push(`  store ${llvmTy} ${r.val}, ptr %${node.name}`);
}
```

After §5(b) this becomes `Type`-aware. For struct types specifically:

- `alloca %struct.Point, align <max-field-align>` — the alignment for an aggregate is the max of its fields' alignments. Add a small `alignOfStruct(structType)` helper that does `Math.max(...fields.map(f => alignOf(llvmType(f.type))))`.
- If the initializer is a `STRUCT_LITERAL`, **skip the generic `emitExpr` + `store` path** — instead, populate the freshly-alloca'd slot field-by-field using `emitStructLiteralInto` (defined in §5(f)). That avoids the redundant temp-alloca+memcpy.
- If the initializer is anything else that returns a struct value (a call result, another struct local being copied in), the generic `emitExpr` + `store` path still works (LLVM IR `store %struct.Point %val, ptr %name` is legal for aggregates).

### d) Field read — `FIELD_ACCESS` in `emitExpr`

Add a new case to the switch in `emitExpr` ([codegen.js:202-278](../src/jsyoopcodegen/codegen.js#L202-L278)). For an r-value field read:

```js
case ASTNodeKind.FIELD_ACCESS: {
  const { ptr, type: objType } = emitLvalue(node.object, fnLines);
  // objType is a StructType; node.resolvedType is the field's Type (typechecker stamped it)
  const fieldIdx = objType.fields.findIndex(f => f.name === node.field);
  const fieldType = objType.fields[fieldIdx].type;
  const llvmFieldTy = llvmType(fieldType);
  const gepTmp = freshTemp();
  fnLines.push(
    `  ${gepTmp} = getelementptr inbounds %struct.${objType.name}, ptr ${ptr}, i32 0, i32 ${fieldIdx}`
  );
  const loadTmp = freshTemp();
  fnLines.push(`  ${loadTmp} = load ${llvmFieldTy}, ptr ${gepTmp}`);
  return { val: loadTmp, yoopType: fieldType };
}
```

This needs a new helper `emitLvalue(node, fnLines)` that returns a *pointer* to the value, not a load of it. Today `emitExpr`'s IDENT case ([codegen.js:219-228](../src/jsyoopcodegen/codegen.js#L219-L228)) always emits a `load` — fine for r-values, wrong for the base of a field access on an aggregate. `emitLvalue` is a parallel walker:

```js
function emitLvalue(node, fnLines) {
  switch (node.kind) {
    case ASTNodeKind.IDENT: {
      const t = symbols.get(node.name);
      return { ptr: `%${node.name}`, type: t };
    }
    case ASTNodeKind.FIELD_ACCESS: {
      const base = emitLvalue(node.object, fnLines);
      const idx = base.type.fields.findIndex(f => f.name === node.field);
      const fieldType = base.type.fields[idx].type;
      const gepTmp = freshTemp();
      fnLines.push(
        `  ${gepTmp} = getelementptr inbounds %struct.${base.type.name}, ptr ${base.ptr}, i32 0, i32 ${idx}`
      );
      return { ptr: gepTmp, type: fieldType };
    }
    default:
      // r-value used as lvalue (e.g. `make_pair().a`). Materialize into a fresh alloca.
      // See §8 edge cases — this is the "support it, it's not much extra code" path.
      throw new Error(`emitLvalue: unsupported node kind "${node.kind}" — see plan §8`);
  }
}
```

The `default` branch is where the "field access on a struct r-value" edge case (`make_pair().a`) lands. Cleanest implementation: call `emitExpr` to get the loaded struct value, alloca a fresh slot, store the value into it, return a pointer to that slot. The phase 1.3 canonical test doesn't exercise this, but the test for "Forward reference between structs" (§7) does (`a.inner.v` where `a.inner` is a chained field access — but that's already handled by the recursive `FIELD_ACCESS` case above; `make_pair().a` is the genuinely new case). Recommended to add the fallback.

### e) Field write — `ASSIGNMENT` with `FIELD_ACCESS` target

Currently [codegen.js:248-268](../src/jsyoopcodegen/codegen.js#L248-L268) only handles `target.kind === IDENT` and throws on anything else. Add the FIELD_ACCESS branch:

```js
case ASTNodeKind.ASSIGNMENT: {
  if (node.target.kind === ASTNodeKind.IDENT) {
    // existing path — unchanged
  }
  if (node.target.kind === ASTNodeKind.FIELD_ACCESS) {
    const lv = emitLvalue(node.target, fnLines);
    const rhs = emitExpr(node.value, fnLines);
    fnLines.push(`  store ${llvmType(lv.type)} ${rhs.val}, ptr ${lv.ptr}`);
    return rhs;
  }
  throw new Error(`codegen: unsupported assignment target ${node.target.kind}`);
}
```

### f) Struct literal — `STRUCT_LITERAL` in `emitExpr`

Two contexts:

1. **Direct initializer of a let/const** (the `node.assignment?.kind === STRUCT_LITERAL` shortcut from §5(c)): write fields directly into the alloca'd slot, no temp.
2. **Embedded** (call arg, return value, assignment RHS to a non-fresh slot): alloca a temp, populate it, then `load` (so the value can be passed/returned by value).

Helper for case 1 (call from the LET_DECL/CONST_DECL handler):

```js
function emitStructLiteralInto(node, destPtr, structType, fnLines) {
  for (const litField of node.fields) {
    const idx = structType.fields.findIndex(f => f.name === litField.name);
    const fieldType = structType.fields[idx].type;
    const gepTmp = freshTemp();
    fnLines.push(
      `  ${gepTmp} = getelementptr inbounds %struct.${structType.name}, ptr ${destPtr}, i32 0, i32 ${idx}`
    );
    const rhs = emitExpr(litField.value, fnLines);
    fnLines.push(`  store ${llvmType(fieldType)} ${rhs.val}, ptr ${gepTmp}`);
  }
}
```

Case 2 — the `STRUCT_LITERAL` case in `emitExpr`:

```js
case ASTNodeKind.STRUCT_LITERAL: {
  const structType = node.resolvedType; // pinned by the typechecker (§4.d)
  const tmpPtr = freshTemp();
  fnLines.push(
    `  ${tmpPtr} = alloca %struct.${structType.name}, align ${alignOfStruct(structType)}`
  );
  emitStructLiteralInto(node, tmpPtr, structType, fnLines);
  const loadTmp = freshTemp();
  fnLines.push(
    `  ${loadTmp} = load %struct.${structType.name}, ptr ${tmpPtr}`
  );
  return { val: loadTmp, yoopType: structType };
}
```

Note `yoopType: structType` (a `Type` object, not a string) — once §5(b) is in, the rest of the codegen handles this correctly.

### g) Struct call args & returns

LLVM passes/returns aggregates by value directly; the backend handles ABI lowering. No `byval` / `sret` needed for Phase 1.3.

- **Param sig** in `emitFunction` ([codegen.js:512-514](../src/jsyoopcodegen/codegen.js#L512-L514)): currently `${llvmType(p.resolvedType.name)} %${p.name}.arg`. After §5(b), drop `.name` so structs flow through correctly.
- **Param-to-stack copy** ([codegen.js:521-527](../src/jsyoopcodegen/codegen.js#L521-L527)): same shape works for structs (`alloca %struct.Point` + `store %struct.Point %p.arg, ptr %p`). Just make sure `symbols` stores the `Type` object, not a string.
- **Call site** ([codegen.js:286-309](../src/jsyoopcodegen/codegen.js#L286-L309)): for each struct arg, `emitExpr` already produces a loaded struct value (an SSA temp of `%struct.X` type after §5(f)). Pass it directly with `${llvmType(paramType)} ${argResults[i].val}`. No special handling needed once §5(b) lands.
- **Return**: [codegen.js:419-420](../src/jsyoopcodegen/codegen.js#L419-L420) already does `ret ${llvmType(ctx.returnType)} ${r.val}` — works for struct returns once `ctx.returnType` is the `Type` object instead of a string.

### h) Update `printfSpec` / `promotedLlvmType` to reject structs explicitly

Today these throw on unknown strings ([codegen.js:43-85](../src/jsyoopcodegen/codegen.js#L43-L85)). The typechecker already rejects struct interpolation, so this is defense-in-depth. Once they take `Type` objects, add an explicit struct-kind branch that throws `codegen bug: struct reached printf — typechecker should have rejected`. Until then, the existing throw-on-unknown is fine.

### i) `symbols` map now stores `Type` objects

Already mentioned in §5(b). Worth calling out separately because every load/store site reads from this map. Sweep:

- `emitExpr` IDENT case at [codegen.js:219-228](../src/jsyoopcodegen/codegen.js#L219-L228).
- `LET_DECL` / `CONST_DECL` at [codegen.js:425-438](../src/jsyoopcodegen/codegen.js#L425-L438).
- `ASSIGNMENT` IDENT branch at [codegen.js:251-263](../src/jsyoopcodegen/codegen.js#L251-L263).
- `emitFunction` param-copy at [codegen.js:521-527](../src/jsyoopcodegen/codegen.js#L521-L527).

---

## 6. Driver — no changes

`yoopiler.js` already wires typecheck between parse and codegen. The errors collection format is unchanged.

---

## 7. Test programs

### Positive — must compile and run

The canonical Phase 1.3 test program is already in the repo at [phasePrograms/phase_1_3_struct.yoop](../phasePrograms/phase_1_3_struct.yoop) and matches the goal at the top of this plan. Expected output: `distance_sq = 25`.

#### Field write

```yoop
type Counter { value: int32, }

function main(): int32 {
    let c: Counter = { value: 0 };
    c.value = c.value + 10;
    c.value = c.value * 2;
    printf(`c.value = ${c.value}\n`);
    return 0;
}
```

Expected output: `c.value = 20`

#### Struct return

```yoop
type Pair { a: int32, b: int32, }

function make_pair(): Pair {
    return { a: 7, b: 11 };
}

function main(): int32 {
    let p: Pair = make_pair();
    printf(`a=${p.a} b=${p.b}\n`);
    return 0;
}
```

Expected output: `a=7 b=11`

#### Forward reference between structs

```yoop
type B { v: int32, }
type A { inner: B, }   // declared before B's fields are known? — no, all fields resolve

function main(): int32 {
    let a: A = { inner: { v: 42 } };
    printf(`a.inner.v = ${a.inner.v}\n`);
    return 0;
}
```

Verifies: nested struct literals; chained field access (`a.inner.v`); three-pass struct registration handles either declaration order.

### Negative — must produce a single positioned typecheck error

| Program snippet | Expected error |
|---|---|
| `type Point { x: int32 } let p: Point = { x: 1, y: 2 };` | `struct 'Point' has no field 'y'` |
| `type Point { x: int32, y: int32 } let p: Point = { x: 1 };` | `missing field 'y' in struct literal` |
| `type Point { x: int32 } let p: Point = { x: "hi" };` | `field 'x': cannot assign string to int32` |
| `type Point { x: int32 } let p: Point = 42;` | `cannot assign untyped int to struct Point` |
| `type Point { x: int32 } function f(p: Point): int32 { return p.z; }` | `type 'Point' has no field 'z'` |
| `function f(): int32 { let x: int32 = 5; return x.y; }` | `field access on non-struct type int32` |
| `type A {} type A {}` | `redeclaration of type 'A'` |
| `type Point { x: int32, x: int32 }` | `duplicate field 'x' in struct 'Point'` |
| `type Bad { f: nope }` | `unknown type 'nope' in field 'f' of struct 'Bad'` |
| `type Loop { next: Loop }` | `recursive field 'next' in struct 'Loop'` |
| `type Point { x: int32 } const p: Point = { x: 1 }; p.x = 2;` | `cannot assign to field of const "p"` |
| `printf(\`p=${p}\n\`)` (where `p: Point`) | `template literal interpolation must be a string, int, or float type, found struct Point` |

### Multi-error case

```yoop
type Point { x: int32, y: int32, }

function main(): int32 {
    let p: Point = { x: "wrong", z: 99 };
    return p.q;
}
```

Three errors expected:
1. `field 'x': cannot assign string to int32`
2. `struct 'Point' has no field 'z'`
3. plus implicitly `missing field 'y' in struct literal`
4. `type 'Point' has no field 'q'`

(Exact count can vary depending on whether you stop after the literal-pinning error or keep reporting.)

### Codegen smoke

The Phase 1.1 numeric program and Phase 1.2 typed-arithmetic programs must continue producing identical IR (no struct path means no new code gets exercised).

---

## 8. Edge cases worth getting right

- **Trailing comma in `type` body**: `type P { x: int32, y: int32, }` — already handled by the optional-comma loop in `parseTypeDecl`. Verify.
- **Trailing comma in struct literal**: `{ x: 1, y: 2, }` — same.
- **Empty struct**: `type Empty {}` — legal? Spec doesn't forbid it; codegen should emit `%struct.Empty = type { }`. Allow it; struct literal `{}` for an empty struct works as the only valid initializer.
- **Field order in literal vs decl**: `let p: Point = { y: 4, x: 3 };` — order doesn't have to match declaration. The pinning logic uses the declared field map, not positional. Correct value goes to correct slot regardless of literal order.
- **Nested struct literals as struct-decl initializers**: `let a: A = { inner: { v: 42 } };` — recursion through `pinStructLiteral` handles this.
- **Field access on struct r-value** (call result): `make_pair().a` — needs `emitLvalue` to handle this *or* explicit alloca-and-store first. For Phase 1.3, simplest: model as `make_pair()` returns a struct value (loaded), store it into a fresh alloca, GEP into that. See the `default` branch sketch in §5(d).
- **Self-referencing struct without ref**: caught by `detectRecursiveField` already.
- **Struct in template literal interpolation**: typechecker rejects. Codegen never sees one.
- **Struct equality**: `p1 == p2` — typechecker says no (`unifyArith` returns `null` for two `StructType`s with `eqeq`). Verify negative test.
- **Param-name collision with field name**: `function f(x: int32, p: Point): int32 { return p.x; }` — `x` is in scope as a param, `p.x` is a field access. The postfix `.x` runs on the result of looking up `p`, not on the bare `x`.
- **Block vs struct-literal disambiguation**: covered in §3. Statements always re-enter expression parsing through `parseStatement` (which doesn't itself accept `{`), so a bare `{` reaching `parseExpression` is unambiguously a struct literal.

---

## 9. Out of scope (for clarity)

- **Methods / `implements`** — Phase 5
- **Default field values** — `type P { x: int32 = 0 }` — not in spec
- **Field-init shorthand** — `let p: Point = { x, y };` (using locals named `x`, `y`) — not in spec for v2
- **Spread / partial update** — `{ ...p, x: 5 }` — not in spec
- **Anonymous structs** — `let p: { x: int32, y: int32 } = ...` — not in spec
- **Generic structs** — deferred
- **Pattern matching on structs** — Phase 7
- **Bitfields, packed structs, alignment overrides** — not in spec for v2
- **`sret` / `byval` ABI lowering** — let LLVM handle it; revisit only if a real ABI need shows up

---

## 10. Phase exit criteria

- All Phase 1.1 and 1.2 test programs continue to produce identical output.
- The roadmap's canonical test program ([phasePrograms/phase_1_3_struct.yoop](../phasePrograms/phase_1_3_struct.yoop)) compiles, runs, and prints `distance_sq = 25`.
- Each negative-case program from §7 produces exactly one error at the right position and does not crash.
- The multi-error case reports every distinct error.
- [codegen.js](../src/jsyoopcodegen/codegen.js) emits `%struct.X = type { ... }` for every `type` decl, before any function definition.
- Field reads use `getelementptr inbounds` + `load`; field writes use `getelementptr inbounds` + `store`.
- Struct values pass as parameters and return from functions; `clang` compiles the IR without warnings or errors.

---

## 11. Implementation order from here

The remaining work, in the order that minimizes broken intermediate states:

1. **Typechecker §4.d — `STRUCT_LITERAL`**:
   a. Add `pinStructLiteral` helper in [checkExpr.js](../src/jsyooptypecheck/checkExpr.js).
   b. Wire it into the `LET_DECL` / `CONST_DECL` initializer path in [checkStatement.js](../src/jsyooptypecheck/checkStatement.js).
   c. Wire it into `RETURN_STATEMENT` in the same file.
   d. Wire it into the call-arg path in `resolveCallType` ([checkExpr.js](../src/jsyooptypecheck/checkExpr.js)).
   e. Add the unhandled fallback case in `resolveExprType` so stray literals produce a clean error.
2. **Typechecker §4.e — Field assignment**:
   a. Replace the placeholder error at [checkExpr.js:213-226](../src/jsyooptypecheck/checkExpr.js#L213-L226) with the real check.
   b. Add `rootIdentOf` mutability check.
   c. Wire `pinStructLiteral` into the RHS path so `p.field = { ... }` works.
3. **Codegen preparatory refactor §5(b)**: switch `llvmType` to take `Type` objects, switch `symbols` to store `Type` objects, sweep all call sites. No struct support yet — just makes structs slot in cleanly. Verify Phase 1.1 / 1.2 IR output is unchanged.
4. **Codegen §5(a)**: emit `%struct.X = type { ... }` declarations at the top of `emitProgram`.
5. **Codegen §5(c, d, e, f, g)**: in roughly this order — local alloca, field read via `emitLvalue`, field write, struct literal materialization, call args / returns. The canonical test program exercises all of these.
6. **Tests**: each negative-case program in §7 as a fixture; assert error count + message; positive programs in `phasePrograms/` (or a sibling `examples/pass/`) with a runner that compiles each and asserts return code / stdout.

Each step keeps the existing test programs compiling. Incremental commits make bisecting easy if something breaks.

---

## Critical files reference

- [SPEC.md §3 — Types](../SPEC.md) — struct semantics
- [src/contracts.js](../src/contracts.js) — AST node kinds
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — `type` keyword, `.` token
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — `parseTypeDecl`, postfix field-access, struct literal, generalized assignment
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) — `StructType`, `resolveTypeFromName`, nominal `typesEqual`
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) — three-pass struct registration (orchestration only)
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) — `resolveExprType`, `resolveCallType`; will host `pinStructLiteral`
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js) — `validateFunction`, `validateStatement`; struct-literal pinning hooks land here
- [src/jsyooptypecheck/recursiveStruct.js](../src/jsyooptypecheck/recursiveStruct.js) — `detectRecursiveField` (already wired)
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — `%struct.X` emission, GEP, struct pass-by-value (all pending)
