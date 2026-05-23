// Phase 7.1: instantiation registry for generic structs, functions, and traits.
//
// A generic decl is described by:
//   - decl id (a stable string used as the originDecl for its TypeParamTypes)
//   - param list ([{name, typeParam: TypeParamType}])
//   - "body" (struct field list / function signature / trait method map) with
//     TypeParamTypes embedded where the user wrote `T`
//
// `instantiateStruct`/`instantiateFunc`/`instantiateTrait` look up a cached
// monomorphic Type by (declId, argTypes). On miss they substitute the param
// map across the body, build a fresh frozen Type, cache, and return it.
//
// The keying uses `cacheKeyForArgs(argTypes)` which serializes types into a
// stable string. Nested generic args contribute their already-instantiated
// names (e.g. `Box<int32>` is keyed by the mangled "m__Box__int32").

import {
  ArrayType,
  EnumType,
  ErrorType,
  FuncType,
  FunctionPointerType,
  RefType,
  StructType,
  TaskType,
  TraitType,
  UnsafePtrType,
  primTypeFromName,
  substituteTypeParams,
  typeKinds,
} from "./types.js";

// Serialize a type to a stable key string. Used both for registry keys and
// for mangled struct/function names.
export function mangleType(t) {
  if (!t) return "unknown";
  switch (t.kind) {
    case typeKinds.prim:
      return t.name;
    case typeKinds.struct:
      return t.moduleId ? `${t.moduleId}__${t.name}` : t.name;
    case typeKinds.enum:
      return t.moduleId ? `${t.moduleId}__${t.name}` : t.name;
    case typeKinds.ref:
      return `ref_${mangleType(t.inner)}`;
    case typeKinds.array:
      return `arr_${mangleType(t.elem)}`;
    case typeKinds.task:
      return `Task__${mangleType(t.resultType)}`;
    case typeKinds.void:
      return "void";
    case typeKinds.typeParam:
      return `tp_${t.originDecl}_${t.name}`;
    default:
      return `unk_${t.kind}`;
  }
}

function cacheKeyForArgs(argTypes) {
  return argTypes.map(mangleType).join("__");
}

// Build a substitution Map<originDecl, Map<paramName, Type>> for a single decl.
function buildSubstitution(declId, paramNames, argTypes) {
  const inner = new Map();
  for (let i = 0; i < paramNames.length; i++) {
    inner.set(paramNames[i], argTypes[i]);
  }
  const outer = new Map();
  outer.set(declId, inner);
  return outer;
}

// Instantiate a generic struct decl at concrete `argTypes`.
//   genericDecl: {
//     id, name, moduleId, paramNames: [string],
//     genericFields: [{name, type, kindType}],
//     implementsTraits: [...], methods: Map<...>,
//     propagatedKinds: [...], kindApplication: ...
//   }
// Returns a fully-frozen monomorphic StructType (or an "open" instantiation
// when argTypes contain TypeParamType — substitution will canonicalize it).
export function instantiateStruct(registry, genericDecl, argTypes) {
  const key = `S:${genericDecl.id}:${cacheKeyForArgs(argTypes)}`;
  const cached = registry.structs.get(key);
  if (cached) return cached;

  if (argTypes.length !== genericDecl.paramNames.length) {
    return ErrorType();
  }
  // Phase 7.2: registry-level bound checks. The typechecker installs
  // `boundChecker` so the pure-types layer stays out of the way.
  runBoundChecks(registry, genericDecl, argTypes);

  const mangledName = monomorphizedName(genericDecl.name, argTypes);
  const sub = buildSubstitution(
    genericDecl.id,
    genericDecl.paramNames,
    argTypes,
  );
  // Phase 10.C.3: a generic struct's methods may reference the struct
  // itself by name (e.g. `function next(ref self): IterStep<T>` where
  // `self` is the open `MapIter<K, V>`). Substituting through those
  // method sigs re-instantiates the struct with concrete args — which
  // would recurse back into us. To break the cycle, cache the new
  // instance BEFORE substituting methods/traits; the recursive lookup
  // then hits the cache and returns the in-progress instance.
  const placeholderMethods = new Map();
  const placeholderTraits = [];
  const fields = (genericDecl.genericFields ?? []).map((f) => ({
    name: f.name,
    type: substituteTypeParams(f.type, sub),
    kindType: f.kindType ?? null,
  }));
  const inst = StructType(
    mangledName,
    fields,
    genericDecl.moduleId,
    placeholderTraits,
    placeholderMethods,
    genericDecl.propagatedKinds ?? [],
    genericDecl.kindApplication ?? null,
    { declId: genericDecl.id, args: argTypes },
  );
  registry.structs.set(key, inst);
  registry.byMangledName.set(`${genericDecl.moduleId}__${mangledName}`, inst);
  // Also index by declId so the registry-aware substitution can re-instantiate.
  if (!registry.genericDeclById) registry.genericDeclById = new Map();
  registry.genericDeclById.set(genericDecl.id, genericDecl);
  // Per-decl instance list — used by codegen to walk concrete instances and
  // emit substituted method bodies for `type Foo<T> implements Trait` impls.
  registry.structInstancesByDecl.set(
    genericDecl.id,
    [...(registry.structInstancesByDecl.get(genericDecl.id) ?? []), inst],
  );
  // Now substitute. Self-referential lookups will find the cached `inst`
  // above and return it instead of re-entering instantiateStruct.
  for (const t of genericDecl.implementsTraits ?? []) {
    placeholderTraits.push(substituteTypeParams(t, sub));
  }
  for (const [name, sig] of (genericDecl.methods ?? new Map())) {
    placeholderMethods.set(name, substituteTypeParams(sig, sub));
  }
  return inst;
}

// Phase 10.A: instantiate a generic enum decl at concrete `argTypes`.
// Mirrors instantiateStruct — substitutes type params in variant payload
// fields, returns a frozen monomorphic EnumType, caches by (declId, argKey).
//   genericDecl: {
//     id, name, moduleId, paramNames: [string], paramScope,
//     genericVariants: Map<vname, { name, fields: [{name,type}] | null, ordinal }>,
//     ast
//   }
export function instantiateEnum(registry, genericDecl, argTypes) {
  const key = `E:${genericDecl.id}:${cacheKeyForArgs(argTypes)}`;
  const cached = registry.enums.get(key);
  if (cached) return cached;

  if (argTypes.length !== genericDecl.paramNames.length) {
    return ErrorType();
  }
  runBoundChecks(registry, genericDecl, argTypes);

  const mangledName = monomorphizedName(genericDecl.name, argTypes);
  const sub = buildSubstitution(
    genericDecl.id,
    genericDecl.paramNames,
    argTypes,
  );
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
  const inst = EnumType(mangledName, variants, genericDecl.moduleId, {
    declId: genericDecl.id,
    args: argTypes,
  });
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

// Phase 7.1: a registry-aware instantiator closure suitable for the
// `instantiator` argument of substituteTypeParams.
// Phase 10.A: dispatches on the recorded `genericKind` slot of the genericDecl
// so enums route to instantiateEnum and structs to instantiateStruct. The
// field is named `genericKind` (not `kind`) to avoid colliding with the
// generic AST-walking heuristic in codegen.
export function makeInstantiator(registry) {
  return (declId, argTypes) => {
    const decl = registry.genericDeclById?.get(declId);
    if (!decl) return null;
    if (decl.genericKind === "enum")
      return instantiateEnum(registry, decl, argTypes);
    return instantiateStruct(registry, decl, argTypes);
  };
}

// Instantiate a generic function decl.
//   genericFuncDecl: { id, name, moduleId, paramNames: [string],
//     genericSig: FuncType with TypeParamTypes embedded,
//     ast: original FUNCTION_DECL node (for codegen) }
// Returns { funcType, mangledName, argTypes, declId }.
export function instantiateFunc(registry, genericFuncDecl, argTypes) {
  const key = `F:${genericFuncDecl.id}:${cacheKeyForArgs(argTypes)}`;
  const cached = registry.funcs.get(key);
  if (cached) return cached;

  if (argTypes.length !== genericFuncDecl.paramNames.length) {
    return null;
  }
  runBoundChecks(registry, genericFuncDecl, argTypes);
  const sub = buildSubstitution(
    genericFuncDecl.id,
    genericFuncDecl.paramNames,
    argTypes,
  );
  const sig = genericFuncDecl.genericSig;
  const instSig = substituteTypeParams(sig, sub);
  const mangledName = monomorphizedName(genericFuncDecl.name, argTypes);
  const inst = {
    funcType: instSig,
    mangledName,
    argTypes,
    declId: genericFuncDecl.id,
    declName: genericFuncDecl.name,
    moduleId: genericFuncDecl.moduleId,
    ast: genericFuncDecl.ast,
    // Direct back-ref to the generic decl record. Used by cloneAstWithSubstitution
    // to re-instantiate a call whose argTypes contained an outer TypeParamType,
    // and works for builtin (`ast: null`) generics too.
    genericDecl: genericFuncDecl,
  };
  registry.funcs.set(key, inst);
  registry.funcInstancesByDecl.set(
    genericFuncDecl.id,
    [...(registry.funcInstancesByDecl.get(genericFuncDecl.id) ?? []), inst],
  );
  return inst;
}

// Instantiate a generic trait. Returns a TraitType with substituted method sigs.
export function instantiateTrait(registry, genericTraitDecl, argTypes) {
  const key = `T:${genericTraitDecl.id}:${cacheKeyForArgs(argTypes)}`;
  const cached = registry.traits.get(key);
  if (cached) return cached;
  runBoundChecks(registry, genericTraitDecl, argTypes);
  const sub = buildSubstitution(
    genericTraitDecl.id,
    genericTraitDecl.paramNames,
    argTypes,
  );
  const methods = new Map();
  for (const [name, sig] of genericTraitDecl.genericMethods) {
    methods.set(name, substituteTypeParams(sig, sub));
  }
  // Build a TraitType. We keep the original name + moduleId — the type-args
  // are recorded separately on the instance (in a registry side-map) but
  // typesEqual on TraitType still compares by (name, moduleId).
  const inst = TraitType(
    genericTraitDecl.name,
    methods,
    genericTraitDecl.moduleId,
    [],
  );
  registry.traits.set(key, inst);
  registry.traitArgsByInstance.set(inst, argTypes);
  return inst;
}

// Build a stable monomorphized name suffix from the type arg list.
// e.g. `Box`, [int32] -> "Box__int32"
//      `Pair`, [int32, Box<int32>] -> "Pair__int32__m__Box__int32"
function monomorphizedName(baseName, argTypes) {
  return `${baseName}__${argTypes.map(mangleType).join("__")}`;
}

// Create an empty registry. One per program (across all modules).
export function createInstantiationRegistry() {
  return {
    structs: new Map(),
    funcs: new Map(),
    traits: new Map(),
    // Phase 10.A: per-instantiation enum cache, parallel to `structs`.
    enums: new Map(),
    byMangledName: new Map(),
    funcInstancesByDecl: new Map(),
    structInstancesByDecl: new Map(),
    // Phase 10.A: per-decl enum instance list — used by codegen to walk
    // concrete instances and emit one LLVM enum struct + per-variant payload
    // struct per instantiation.
    enumInstancesByDecl: new Map(),
    traitArgsByInstance: new Map(),
    // Phase 7.2: callback installed by the typechecker. Receives
    // ({ genericDecl, argTypes, paramIndex, paramName, requiredTrait }) and
    // pushes a typecheck error if the arg doesn't satisfy the bound.
    boundChecker: null,
  };
}

// Phase 7.2: walk a generic decl's typeParam AST nodes and call the
// registry's `boundChecker` for any param whose TypeParamType carries a bound.
// Bound checking is best-effort here — even on failure we proceed with the
// instantiation so dependent type checking can still progress. The diagnostic
// surfaces via the typechecker's error array.
function runBoundChecks(registry, genericDecl, argTypes) {
  const check = registry.boundChecker;
  if (!check) return;
  const paramScope = genericDecl.paramScope;
  if (!paramScope) return;
  for (let i = 0; i < genericDecl.paramNames.length; i++) {
    const pn = genericDecl.paramNames[i];
    const tpType = paramScope.get(pn);
    if (!tpType?.bound) continue;
    check({
      genericDecl,
      argType: argTypes[i],
      paramName: pn,
      requiredTrait: tpType.bound,
    });
  }
}

// Phase 7.1: resolve a type annotation using a typeContext (as built by
// typecheckProgram in pass D). This wraps the multi-module resolver and
// supplies the registry + the typeContext's typeParamScope. Used in
// checkStatement.js and checkExpr.js where the historical resolver took only
// `(annot, structTable)`.
//
// `extraScope` lets a caller (e.g. a method body) inject `selfType` without
// modifying the typeContext.
export function resolveTypeInCtx(annot, typeContext, extraScope) {
  if (!annot) return null;
  if (typeContext.moduleEnv) {
    // Multi-module path
    return resolveAnnotMulti(annot, typeContext, extraScope);
  }
  // Single-module fallback — minimal: support primitives, refs, arrays,
  // taskType. Generic applications fail because there's no registry/decl.
  return resolveAnnotSingle(annot, typeContext, extraScope);
}

function resolveAnnotMulti(annot, typeContext, extraScope) {
  const tps = extraScope?.typeParamScope ?? typeContext.typeParamScope ?? null;
  if (annot.kind === "typeName") {
    if (tps) {
      const tp = tps.get(annot.name);
      if (tp) return tp;
    }
    const env = typeContext.moduleEnv.get(typeContext.currentModId);
    const local = env.structTable?.get(annot.name);
    if (local && local.fields !== null) return local;
    const prim = primTypeFromName(annot.name);
    if (prim) return prim;
    // Phase 7.5: enum / union tables.
    const localEnum = env.enumTable?.get(annot.name);
    if (localEnum) return localEnum;
    const localUnion = env.unionTable?.get(annot.name);
    if (localUnion) return localUnion;
    // Phase 9.G: vtable nominal lookup.
    const localVtable = env.vtableTable?.get(annot.name);
    if (localVtable) return localVtable;
    const imp = env.importedNames?.get(annot.name);
    if (imp && imp.kind === "type") {
      const srcEnv = typeContext.moduleEnv.get(imp.fromModuleId);
      const resolved =
        srcEnv?.structTable.get(imp.exportName) ??
        srcEnv?.enumTable?.get(imp.exportName) ??
        srcEnv?.unionTable?.get(imp.exportName) ??
        srcEnv?.vtableTable?.get(imp.exportName);
      if (resolved) return resolved;
    }
    return local ?? null;
  }
  // Phase 9.G: function value type — `(p: T, ...) => R`.
  if (annot.kind === "functionType") {
    const params = [];
    for (const p of annot.params) {
      const pt = resolveAnnotMulti(p, typeContext, extraScope);
      if (!pt) return null;
      params.push(pt);
    }
    const rt = resolveAnnotMulti(annot.returnType, typeContext, extraScope);
    if (!rt) return null;
    return FunctionPointerType(params, rt);
  }
  if (annot.kind === "refType") {
    const inner = resolveAnnotMulti(annot.inner, typeContext, extraScope);
    if (!inner) return null;
    return RefType(inner);
  }
  if (annot.kind === "arrayType") {
    const elem = resolveAnnotMulti(annot.elem, typeContext, extraScope);
    if (!elem) return null;
    return ArrayType(elem);
  }
  if (annot.kind === "taskType") {
    const inner = resolveAnnotMulti(annot.inner, typeContext, extraScope);
    if (!inner) return null;
    return TaskType(inner);
  }
  if (annot.kind === "typeApplication") {
    const argTypes = [];
    for (const a of annot.typeArgs) {
      const t = resolveAnnotMulti(a, typeContext, extraScope);
      if (!t) return null;
      argTypes.push(t);
    }
    if (annot.name === "Task" && argTypes.length === 1) {
      return TaskType(argTypes[0]);
    }
    // Phase 8.A: built-in unsafe_ptr<T>.
    if (annot.name === "unsafe_ptr" && argTypes.length === 1) {
      return UnsafePtrType(argTypes[0]);
    }
    if (!typeContext.registry) return null;
    const env = typeContext.moduleEnv.get(typeContext.currentModId);
    const localStruct = env.genericStructTable?.get(annot.name);
    if (localStruct) {
      if (argTypes.length !== localStruct.paramNames.length) return null;
      return instantiateStruct(typeContext.registry, localStruct, argTypes);
    }
    const localTrait = env.genericTraitTable?.get(annot.name);
    if (localTrait) {
      if (argTypes.length !== localTrait.paramNames.length) return null;
      return instantiateTrait(typeContext.registry, localTrait, argTypes);
    }
    const localEnum = env.genericEnumTable?.get(annot.name);
    if (localEnum) {
      if (argTypes.length !== localEnum.paramNames.length) return null;
      return instantiateEnum(typeContext.registry, localEnum, argTypes);
    }
    const imp = env.importedNames?.get(annot.name);
    if (imp) {
      const srcEnv = typeContext.moduleEnv.get(imp.fromModuleId);
      if (srcEnv) {
        const rs = srcEnv.genericStructTable?.get(imp.exportName);
        if (rs) {
          if (argTypes.length !== rs.paramNames.length) return null;
          return instantiateStruct(typeContext.registry, rs, argTypes);
        }
        const rt = srcEnv.genericTraitTable?.get(imp.exportName);
        if (rt) {
          if (argTypes.length !== rt.paramNames.length) return null;
          return instantiateTrait(typeContext.registry, rt, argTypes);
        }
        const re = srcEnv.genericEnumTable?.get(imp.exportName);
        if (re) {
          if (argTypes.length !== re.paramNames.length) return null;
          return instantiateEnum(typeContext.registry, re, argTypes);
        }
      }
    }
    return null;
  }
  if (annot.kind === "selfType") {
    return extraScope?.selfType ?? null;
  }
  return null;
}

function resolveAnnotSingle(annot, typeContext, extraScope) {
  const tps = extraScope?.typeParamScope ?? typeContext.typeParamScope ?? null;
  if (annot.kind === "typeName") {
    if (tps) {
      const tp = tps.get(annot.name);
      if (tp) return tp;
    }
    return (
      primTypeFromName(annot.name) ??
      typeContext.structTable?.get(annot.name) ??
      null
    );
  }
  if (annot.kind === "refType") {
    const inner = resolveAnnotSingle(annot.inner, typeContext, extraScope);
    if (!inner) return null;
    return RefType(inner);
  }
  if (annot.kind === "arrayType") {
    const elem = resolveAnnotSingle(annot.elem, typeContext, extraScope);
    if (!elem) return null;
    return ArrayType(elem);
  }
  if (annot.kind === "taskType") {
    const inner = resolveAnnotSingle(annot.inner, typeContext, extraScope);
    if (!inner) return null;
    return TaskType(inner);
  }
  if (annot.kind === "typeApplication") {
    const argTypes = [];
    for (const a of annot.typeArgs) {
      const t = resolveAnnotSingle(a, typeContext, extraScope);
      if (!t) return null;
      argTypes.push(t);
    }
    if (annot.name === "Task" && argTypes.length === 1) {
      return TaskType(argTypes[0]);
    }
    // Phase 8.A: built-in unsafe_ptr<T>.
    if (annot.name === "unsafe_ptr" && argTypes.length === 1) {
      return UnsafePtrType(argTypes[0]);
    }
    return null;
  }
  if (annot.kind === "selfType") {
    return extraScope?.selfType ?? null;
  }
  return null;
}
