# Phase 10.A - Generic enums

> Lift the typechecker rejection of `enum Foo<T> { ... }` and wire generic
> enums through the same Phase 7.1 monomorphization machinery that already
> powers generic structs, functions, and traits. The single biggest unlock
> in [plans/phase-10.md](phase-10.md): without it, `Option<T>`,
> `Result<T, E>`, and `IterStep<T>` are unspellable, and the `std/collections/`
> story has nowhere to start.

## Goal

Make this compile and run end-to-end:

```yoop
enum Result<T, E> {
    Ok { value: T },
    Err { error: E },
}

function parse_positive(n: int32): Result<int32, int32> {
    if (n < 0) { return Result.Err { error: n }; }
    return Result.Ok { value: n };
}

function add_two(a: int32, b: int32): Result<int32, int32> {
    let x: int32 = parse_positive(a)?;
    let y: int32 = parse_positive(b)?;
    return Result.Ok { value: x + y };
}
```

i.e. all of:

- `enum Foo<T, ...>` registers and survives pass A.
- Variant payload fields can mention `T`.
- `Result<int32, int32>` as a type annotation instantiates the enum.
- `Result.Ok { value: 5 }` in expression position pinned by a target type
  selects the right instantiation.
- `Result.Err`/`Result.Ok` no-payload bare form (when applicable) still works.
- `switch` over `Result<int32, int32>` - including variant patterns with
  field bindings - type-checks and lowers cleanly.
- Phase 9.H's `?` operator detects the `Ok`/`Err`-shape instantiation as
  fallible and propagates through it.
- Codegen emits one LLVM enum struct per instantiation, mangled exactly
  like the Phase 7.1 generic-struct pattern.

## What already exists (do not redesign)

- **Parser**: `parseEnumDecl()` at
  [src/jsyooparser/parser.js:2536](../src/jsyooparser/parser.js#L2536) already
  calls `parseTypeParamList()` and stamps `node.typeParams` onto the
  `ENUM_DECL`. Variant payload field types parse with `parseTypeAnnotation()`,
  which already accepts bare type-param names. Nothing in the parser needs to
  change.
- **VARIANT_CONSTRUCTOR shape**: parser produces `{ enumName: string,
  variantName: string, fields: [...] | null }`. The `enumName` is the
  generic decl name (`"Result"`), not an instantiated form. We will keep
  that - the existing inference path through `checkInitializer` is where the
  concrete type gets picked.
- **VARIANT_PATTERN shape**: same - pattern carries `enumName`/`variantName`
  and the typechecker stamps `resolvedEnumType` + `resolvedVariant` on it
  during the switch resolution. We just need that stamp to be the
  *instantiated* enum, not the (open) generic decl.
- **`switch`**: `scrutType` comes from `resolveExprType` on the scrutinee.
  When the scrutinee is a `Result<int32, int32>`-typed binding, scrutType
  is the instantiated EnumType. Pattern resolution looks up
  `enumTable.get(pat.enumName)` today - we'll need to also reach into the
  generic table and instantiate to match.
- **Phase 9.H `?`**: `isFallibleEnum()` in [fallible.js](../src/jsyooptypecheck/fallible.js)
  is purely structural - any EnumType with `Ok`/`Err` variants qualifies.
  Instantiated `Result<T, E>` is an EnumType with those variants, so the
  recognizer should fire unchanged.
- **Codegen `llvmType` for enum** at
  [src/jsyoopcodegen/codegen.js:95](../src/jsyoopcodegen/codegen.js#L95)
  derives `%enum.<mod>__<name>` from `enumType.moduleId` + `enumType.name`.
  Instantiations will be named with the mangled form
  (`Result__int32__int32`) the same way generic structs are
  (`Box__int32`), so this routine needs no change.
- **Codegen `sizeOfAlign` / payload sizing** for enums already walks
  `variants` and reads field types - runs identically on an instantiated
  EnumType.
- **`structContainsTypeParam`** at
  [codegen.js:2384](../src/jsyoopcodegen/codegen.js#L2384) is the gate used
  to skip "open" generic struct instances in registry-driven emission. We'll
  add a sibling `enumContainsTypeParam`.

## Design

### Data model

Three small additions to the type system + one to the registry.

**1. `EnumType.genericInstance`** - mirror the StructType slot.

```js
// types.js
export const EnumType = (name, variants, moduleId = null, genericInstance = null) =>
  freezerWrap(typeKinds.enum, { name, variants, moduleId, genericInstance });
```

`genericInstance: { declId, args } | null` lets `substituteTypeParams`
re-instantiate an open `Result<T, E>` into the canonical
`Result<int32, int32>` when the outer T/E gets pinned.

**2. `genericEnumTable`** per module env - sibling of `genericStructTable`.
Holds the genericDecl record:

```js
{
  id: string,                          // `<mod>__enum__<Name>`
  name: string,
  moduleId: string,
  paramNames: string[],                // e.g. ["T", "E"]
  paramScope: Map<string, TypeParamType>,
  genericVariants: Map<              // filled in pass C
    name,
    { name, fields: [{ name, type }] | null, ordinal }
  >,
  ast: ASTNode,                       // the original ENUM_DECL
}
```

**3. `registry.enums`** - `Map<key, EnumType>` keyed `E:<declId>:<argkey>`,
parallel to `registry.structs`. Plus `registry.enumInstancesByDecl` for
codegen-side walking, parallel to `structInstancesByDecl`.

**4. `substituteTypeParams` extension** - same shape as the struct branch.
When an EnumType has a `genericInstance`, substitute its args and
re-instantiate via the global instantiator. Cross-decl `genericInstantiator`
is already a registered Map; we extend `makeInstantiator` to dispatch on
the cached decl-id prefix or by lookup in `genericDeclById`. (Cleaner:
each genericDecl record gets a `kind: "struct" | "enum"` field; the
instantiator dispatches on that.)

### Pass A - registration

In [typecheck.js:1395-1402](../src/jsyooptypecheck/typecheck.js#L1395-L1402),
replace the "generic enums are not yet supported (deferred)" branch with
the same path used for generic struct decls:

```js
if (d.kind === ASTNodeKind.ENUM_DECL) {
  const hasTypeParams = d.typeParams && d.typeParams.length > 0;
  if (hasTypeParams) {
    if (
      genericEnumTable.has(d.name) ||
      enumTable.has(d.name) ||
      structTable.has(d.name) ||
      genericStructTable.has(d.name) ||
      unionTable.has(d.name)
    ) {
      errors.push({ message: `redeclaration of type "${d.name}"`, ... });
    } else {
      const declId = `${mod.id}__enum__${d.name}`;
      const paramNames = d.typeParams.map((p) => p.name);
      const paramScope = new Map();
      for (const pn of paramNames) {
        paramScope.set(pn, new TypeParamType(pn, declId));
      }
      const genericDecl = {
        id: declId,
        name: d.name,
        moduleId: mod.id,
        paramNames,
        paramScope,
        genericVariants: null,    // filled in pass C
        ast: d,
      };
      genericEnumTable.set(d.name, genericDecl);
      d.genericDecl = genericDecl;
    }
    if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
    continue;
  }
  // existing non-generic path unchanged
  ...
}
```

Wire `genericEnumTable` into the env returned at line 1700, into
`resolveImports` exports walk (so cross-module use works), into the
redeclaration checks for structs/traits/funcs at this layer (any name
collision should be one error, not none-then-strange-error-later).

### Pass C - resolve variant fields with type-param scope

After the existing TYPE_DECL/generic-struct branch, add:

```js
if (d.kind === ASTNodeKind.ENUM_DECL && d.genericDecl) {
  const gd = d.genericDecl;
  const ctxForGeneric = genericCtx(gd.paramScope);
  const genericVariants = new Map();
  let ordinal = 0;
  for (const variantNode of d.variants ?? []) {
    let resolvedFields = null;
    if (variantNode.fields !== null) {
      resolvedFields = [];
      const seen = new Set();
      for (const f of variantNode.fields) {
        if (seen.has(f.name)) {
          errors.push({ message: `duplicate field "${f.name}" in variant "${variantNode.name}" of generic enum "${d.name}"`, ... });
          continue;
        }
        seen.add(f.name);
        let ft = resolveTypeAnnotationInModule(f.typeAnnotation, mod.id, moduleEnv, ctxForGeneric);
        if (!ft) {
          errors.push({ message: `unknown type "${formatAnnotation(f.typeAnnotation)}" in variant "${variantNode.name}" of generic enum "${d.name}"`, ... });
          ft = ErrorType();
        }
        resolvedFields.push({ name: f.name, type: ft });
      }
    }
    genericVariants.set(variantNode.name, {
      name: variantNode.name,
      fields: resolvedFields,
      ordinal,
    });
    variantNode.ordinal = ordinal;
    ordinal++;
  }
  gd.genericVariants = genericVariants;
  // Don't set d.resolvedType - there isn't one type, just a decl.
}
```

The existing `if (d.kind === ASTNodeKind.ENUM_DECL)` non-generic branch at
[typecheck.js:1939](../src/jsyooptypecheck/typecheck.js#L1939) already
fires only when `d.genericDecl` is absent (we'll add the explicit guard
the same way the TYPE_DECL branch does).

### Instantiation

Add `instantiateEnum(registry, genericDecl, argTypes)` to
[instantiate.js](../src/jsyooptypecheck/instantiate.js):

```js
export function instantiateEnum(registry, genericDecl, argTypes) {
  const key = `E:${genericDecl.id}:${cacheKeyForArgs(argTypes)}`;
  const cached = registry.enums.get(key);
  if (cached) return cached;

  if (argTypes.length !== genericDecl.paramNames.length) {
    return ErrorType();
  }
  runBoundChecks(registry, genericDecl, argTypes); // works generically - already param-scoped

  const mangledName = monomorphizedName(genericDecl.name, argTypes);
  const sub = buildSubstitution(genericDecl.id, genericDecl.paramNames, argTypes);
  const variants = new Map();
  for (const [vname, v] of genericDecl.genericVariants ?? []) {
    let fields = null;
    if (v.fields !== null) {
      fields = v.fields.map((f) => ({
        name: f.name,
        type: substituteTypeParams(f.type, sub),
      }));
    }
    variants.set(vname, { name: vname, fields, ordinal: v.ordinal });
  }
  const inst = EnumType(
    mangledName,
    variants,
    genericDecl.moduleId,
    { declId: genericDecl.id, args: argTypes },
  );
  registry.enums.set(key, inst);
  registry.byMangledName.set(`${genericDecl.moduleId}__${mangledName}`, inst);
  if (!registry.genericDeclById) registry.genericDeclById = new Map();
  registry.genericDeclById.set(genericDecl.id, genericDecl);
  registry.enumInstancesByDecl.set(
    genericDecl.id,
    [...(registry.enumInstancesByDecl.get(genericDecl.id) ?? []), inst],
  );
  return inst;
}
```

`createInstantiationRegistry` grows `enums: new Map()` and
`enumInstancesByDecl: new Map()` slots. `makeInstantiator` needs to know
whether a declId is a struct or enum - we'll mark each genericDecl with a
`kind: "struct" | "enum"` (or look up by id-prefix) so substitution can
dispatch correctly.

### Wiring the instantiator into substitution

`substituteTypeParams` switch on `typeKinds.enum`:

```js
case typeKinds.enum: {
  if (type.genericInstance && inst) {
    const newArgs = type.genericInstance.args.map((a) =>
      substituteTypeParams(a, substitution, inst),
    );
    const allSame = newArgs.every((a, i) => a === type.genericInstance.args[i]);
    if (allSame) return type;
    const fresh = inst(type.genericInstance.declId, newArgs);
    if (fresh) return fresh;
  }
  if (!type.variants) return type;
  // Walk variant fields the same way struct fields are walked.
  // Re-construct only if any field actually moved.
  ...
}
```

And `typeHasTypeParam` grows an enum branch (walk `variants → fields →
type`).

`makeInstantiator(registry)` becomes decl-kind aware. Cleanest is to
record on each genericDecl which type-constructor to call, since the
registry already holds `genericDeclById`:

```js
export function makeInstantiator(registry) {
  return (declId, argTypes) => {
    const decl = registry.genericDeclById?.get(declId);
    if (!decl) return null;
    if (decl.kind === "enum") return instantiateEnum(registry, decl, argTypes);
    return instantiateStruct(registry, decl, argTypes);
  };
}
```

Stamp `genericDecl.kind = "struct"` / `"enum"` at the registration site.
Existing struct decls have no `kind` slot - we add it during pass A so the
dispatch is unambiguous.

### `resolveAnnotMulti` / `resolveGenericApplication`

In `resolveGenericApplication` at [typecheck.js:272](../src/jsyooptypecheck/typecheck.js#L272),
add the same lookup chain that exists for structs/traits, but for enums:

```js
const localEnum = env.genericEnumTable?.get(name);
if (localEnum) {
  if (argTypes.length !== localEnum.paramNames.length) return null;
  return instantiateEnum(registry, localEnum, argTypes);
}
// imported:
const remoteEnum = srcEnv.genericEnumTable?.get(imp.exportName);
if (remoteEnum) {
  if (argTypes.length !== remoteEnum.paramNames.length) return null;
  return instantiateEnum(registry, remoteEnum, argTypes);
}
```

Also mirror this in `resolveAnnotMulti` (the `typeApplication` branch in
[instantiate.js:334](../src/jsyooptypecheck/instantiate.js#L334)) so the
ctx-driven resolver used by checkStatement/checkExpr can find generic
enums.

### Variant-constructor resolution (expression position)

This is the trickiest piece. `Result.Ok { value: 5 }` parses as
VARIANT_CONSTRUCTOR with `enumName: "Result"`. Today `lookupEnumByName`
looks only in `enumTable` (concrete). Two paths to handle generic enums:

**1. Bare `resolveExprType` (no target type).**
   - Look up `enumName` in `genericEnumTable` too.
   - If generic, the constructor isn't pinned → return `ErrorType()` like
     unpinned struct literals do (but only if `checkInitializer` won't pin
     it). Actually: we *cannot* know the instantiation without context, so
     we leave the node "open" - return ErrorType + push an error
     "cannot determine type arguments for generic enum X - pin via a
     typed binding/return/call argument". Mirrors the bare struct-literal
     diagnostic.

**2. `checkInitializer` with a concrete EnumType target.**
   - Add a VARIANT_CONSTRUCTOR clause at the top of `checkInitializer`,
     before `resolveExprType` is called:
     ```js
     if (valueNode.kind === ASTNodeKind.VARIANT_CONSTRUCTOR) {
       if (
         expectedType?.kind === typeKinds.enum &&
         expectedType.genericInstance &&
         // generic-enum name matches expected
         genericEnumDeclForName(valueNode.enumName, ctx)?.id ===
           expectedType.genericInstance.declId
       ) {
         return pinVariantConstructor(valueNode, expectedType, scope, ctx);
       }
     }
     ```
   - `pinVariantConstructor(node, enumType, scope, ctx)` stamps
     `resolvedEnumType = enumType`, looks up the variant in
     `enumType.variants` (already substituted!), and checks each field's
     value via `checkInitializer(field.value, expectedField.type, ...)`.
     Sets `node.resolvedVariant` to the substituted variant.
   - The non-generic path stays in `resolveVariantConstructor` as today.

**3. Bare no-payload form `Result.Err`** - already promoted in
   `resolveFieldAccess` ([checkExpr.js:743](../src/jsyooptypecheck/checkExpr.js#L743)).
   The same generic-vs-concrete fork applies: we need `lookupEnumByName`
   to fall through to `lookupGenericEnumByName`. If generic, defer pinning
   to checkInitializer just like the payload form. (Add a checkInitializer
   shortcut for VARIANT_CONSTRUCTOR with `fields === null` and
   `resolvedEnumType` still unset.)

### Variant-pattern resolution in `switch`

`switch (r)` where `r: Result<int32, int32>` already produces
`scrutType.kind === typeKinds.enum` with a concrete instantiated EnumType.
The pattern-resolution code at
[checkStatement.js: resolveVariantPattern]
looks the pattern's `enumName` up against the scrutinee's enum. The fix
is small: when `pat.enumName` is the *generic* decl name (e.g. `"Result"`)
but the scrutinee type is an instantiation (with `name:
"Result__int32__int32"`), accept the match if the scrutinee's
`genericInstance.declId` corresponds to a generic decl whose name equals
`pat.enumName`. Stamp `pat.resolvedEnumType = scrutType`,
`pat.resolvedVariant = scrutType.variants.get(pat.variantName)` -
already substituted. Field bindings get their types from the instantiated
variant, same as today.

(There's also the case of `Result<int32, int32>` written in the pattern
itself. That's not supported in current syntax - patterns are
`EnumName.Variant { ... }` - so the user *must* write the bare decl name
and rely on scrutinee-side inference. This is a non-issue.)

### Codegen

**1. Skip generic-enum decls in per-module struct-def emission.**

In [codegen.js:2569](../src/jsyoopcodegen/codegen.js#L2569), add the same
`!d.genericDecl` gate that the TYPE_DECL branch above already uses:

```js
if (d.kind === ASTNodeKind.ENUM_DECL && d.resolvedType && !d.genericDecl) { ... }
```

(Generic ENUM_DECLs have no `d.resolvedType` set - but belt-and-suspenders.)

**2. Emit per-instantiation enum struct + per-variant payload structs from
the registry.**

Right after the `programState.registry.structs` walk in `codegenProgram`
([codegen.js:2224](../src/jsyoopcodegen/codegen.js#L2224)), add an enum
walk:

```js
if (programState?.registry) {
  for (const [_key, enumType] of programState.registry.enums) {
    if (enumContainsTypeParam(enumType)) continue;
    const mangled = llvmType(enumType);
    if (emittedStructs.has(mangled)) continue;
    emittedStructs.add(mangled);
    // payload size - same calculation as the per-module ENUM_DECL branch
    let maxPayload = 0;
    for (const v of enumType.variants.values()) {
      if (v.fields === null) continue;
      let off = 0;
      let maxAlign = 1;
      for (const f of v.fields) {
        const al = sizeOfAlign(f.type);
        if (al > maxAlign) maxAlign = al;
        off = Math.floor((off + al - 1) / al) * al + sizeOfType(f.type);
      }
      const padded = Math.floor((off + maxAlign - 1) / maxAlign) * maxAlign;
      if (padded > maxPayload) maxPayload = padded;
    }
    const payloadSize = Math.max(maxPayload, 1);
    allStructDefs.push(`${mangled} = type { i32, [${payloadSize} x i8] }`);
    // per-variant payload structs
    const enumId = `${enumType.moduleId}__${enumType.name}`;
    for (const v of enumType.variants.values()) {
      if (v.fields === null) continue;
      const variantLlvm = `%enumv.${enumId}__${v.name}`;
      if (emittedStructs.has(variantLlvm)) continue;
      emittedStructs.add(variantLlvm);
      const fieldLlvm = v.fields.map((f) => llvmType(f.type)).join(", ");
      allStructDefs.push(`${variantLlvm} = type { ${fieldLlvm} }`);
    }
  }
}
```

(Factor the payload-size computation into a small helper so the per-module
and per-instantiation branches don't drift.)

`enumContainsTypeParam(enumType)` mirrors `structContainsTypeParam`: walk
variant fields, return true on any TypeParamType. Open instantiations
(snapshotted before substitution) are filtered out.

**3. `emitVariantConstructor` / switch payload GEP** - no change needed.
Both read `node.resolvedEnumType` and `node.resolvedVariant`. As long as
the typechecker stamps the *instantiated* enum (which it will, because
checkInitializer pins to the target type), codegen already does the right
thing. The `enumId` derivation
(`${moduleId}__${name}`) becomes
`${moduleId}__Result__int32__int32` for instantiated names - matches
the struct defs emitted above.

**4. `arrayElemLlvmName` for arrays of generic-enum instantiations.** Add
an enum branch identical to the struct one - the array `Result<...>[]`
needs a stable element key.

### Fallible enum recognition (Phase 9.H)

[fallible.js: isFallibleEnum](../src/jsyooptypecheck/fallible.js#L8) is
structural - it checks `enumType.kind === typeKinds.enum` and looks for
`Ok`/`Err` variants. Instantiated `Result<T, E>` is an EnumType with those
variants, so the check fires unchanged. Verify and add an e2e test.

`enumErrPayloadType()` returns the `Err` variant's first field type. For
an instantiated `Result<int32, string>`, that's `string`, since the
substitution already ran.

Cross-shape propagation across two *different* generic enums (e.g.
`Result<T, IOError>` into `Result<T, AppError>`) is out of scope - that
falls under Phase 10.E. Same-shape (same generic decl, same type args) is
in scope.

### Diagnostics

A short, complete list of new error messages:

- `redeclaration of type "Foo"` - already covered by extending the
  redeclaration check chain.
- `unknown type "T" in variant "X" of generic enum "Foo"` - pass C with
  type-param scope misses (typically a typo).
- `cannot determine type arguments for generic enum "Foo" - pin via a
  typed binding/return/call argument` - bare unpinned use.
- `enum "Foo" has no variant "X"` - already exists for concrete; reuse.
- `arity mismatch instantiating "Foo": expected N type arguments, got M`
  - already exists for generic structs; reuse the same wording.

## Verification

- **Negative**: `examples/fail/generic_enum_unpinned.yoop` - bare
  `Result.Ok { value: 5 };` as a statement, expects the "cannot determine
  type arguments" diagnostic.
- **Negative**: `examples/fail/generic_enum_arity.yoop` -
  `Result<int32>` (missing `E`), expects an arity error.
- **Positive**: `examples/pass/generic_enum_result.yoop` - the Goal block
  above. Round-trips through lex → parse → typecheck → codegen → clang
  → runtime; expected stdout `happy=7\nsad err=-7\n`.
- **Positive**: `examples/pass/generic_enum_option_like.yoop` -
  `Option<T>` with `Some { value: T }` / `None`, exercises the no-payload
  variant path on a generic enum.
- **Unit** (`src/jsyooptypecheck/typecheck.test.js`): pass-A
  redeclaration check; pass-C field resolution with type-param scope;
  `instantiateEnum` cache hit; substitution re-instantiation through
  `substituteTypeParams`.
- **e2e** ([src/e2e.test.js](../src/e2e.test.js)): the two
  positive examples above run to clean exit with the expected stdout;
  a third fixture proves Phase 9.H's `?` propagates through an
  instantiated `Result<int32, int32>`.

## Out of scope

- **Cross-shape `?` propagation** (e.g. `Result<int32, IOError>` →
  `Result<int32, AppError>`). Lands in Phase 10.E with the `From` trait.
- **Generic enums with bounded type params** (`<T implements Hashable>`).
  The Phase 7.2 bound-check machinery is generic over decl kind, so this
  should work for free once `runBoundChecks` is wired - but it's not the
  primary goal and may surface latent issues in the bound checker. Allow
  it; defer test fixtures to Phase 10.C.
- **`Iterable<T>` trait + `IterStep<T>`** - that's Phase 10.B, blocked on
  this.
- **`match` as an expression** - still Phase 7.5 deferred.
- **`vtable<T>` for generic traits via generic enums** - Phase 9.G's
  vtable restrictions are independent; revisit in 10.B.

## Estimated scope

- ~150 LOC typechecker (pass A + pass C + instantiateEnum + variant
  pinning + variant-pattern resolution + substitution + diagnostics)
- ~80 LOC codegen (registry walk + enumContainsTypeParam + arrayElem
  branch)
- ~20 LOC tests + ~3 fixtures
- Total: ~250 LOC implementation + tests.

## Critical files

- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) -
  EnumType.genericInstance, substituteTypeParams enum branch,
  typeHasTypeParam enum branch.
- [src/jsyooptypecheck/instantiate.js](../src/jsyooptypecheck/instantiate.js)
  - instantiateEnum, registry slots, makeInstantiator dispatch,
  resolveAnnotMulti typeApplication enum branch, mangleType enum branch.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js)
  - pass A registration, pass C variant resolution, env wiring,
  resolveGenericApplication.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js)
  - variant-constructor pinning, generic-enum lookup in
  lookupEnumByName, bare no-payload form promotion.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js)
  - variant-pattern resolution accepting generic decl name against an
  instantiated scrutinee.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) -
  registry-driven enum + payload-struct emission,
  enumContainsTypeParam, arrayElemLlvmName enum branch, ENUM_DECL gate.
- [examples/pass/generic_enum_result.yoop](../examples/pass/), etc.
- [src/e2e.test.js](../src/e2e.test.js) - fixtures registered.
