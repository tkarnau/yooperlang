// every Type has at least { kind, ... }
//   kind: "prim" | "struct" | "ref" | "array" | "func" | "void" | "untypedInt" | "untypedFloat" | "error"

export const typeKinds = {
  prim: "prim",
  struct: "struct",
  ref: "ref",
  array: "array",
  func: "func",
  void: "void",
  untypedInt: "untypedInt",
  untypedFloat: "untypedFloat",
  error: "error",
  namespace: "namespace",
  trait: "trait",
  kind: "kind",
  task: "task",
  // A reference to a generic type parameter in a generic decl.
  typeParam: "typeParam",
  // Tagged sum and C-style overlapping union.
  // Tagged sum renamed from `enum` to `variant`. The new `enum`
  // keyword introduces a value-enum: a nominal alias over a primitive
  // underlying type (int*/uint*/string) with named-constant cases.
  variant: "variant",
  union: "union",
  valueEnum: "valueEnum",
  // Raw FFI pointer. Distinct from `ref T` (which is non-null and
  // does not participate in arithmetic).
  unsafePtr: "unsafePtr",
  // Literal-placeholder for `null`, similar to untypedInt/Float.
  // Pinned by context (assignment target, return, call arg, equality side).
  untypedNull: "untypedNull",
  // A value-shaped function pointer. The `=>` form in a type
  // annotation. Distinct from `func` (which describes named function decls).
  functionPointer: "functionPointer",
  // A type-erased trait shape. See VTableType.
  vtable: "vtable",
};

const freezerWrap = (kind, obj) => {
  const self = {
    kind,
    ...obj,
  };

  return Object.freeze(self);
};

export const primAnnotations = {
  int8: "int8",
  int16: "int16",
  int32: "int32",
  int64: "int64",
  uint8: "uint8",
  uint16: "uint16",
  uint32: "uint32",
  uint64: "uint64",
  float32: "float32",
  float64: "float64",
  bool: "bool",
  char: "char",
  string: "string",
  usize: "usize",
  isize: "isize",
  // Platform pointer-width unsigned integer. Lowered to i64 on
  // 64-bit targets (the only ones we currently support). Distinct from usize
  // in source for documentation purposes - mirrors C uintptr_t vs size_t.
  uintptr: "uintptr",
  void: "void",
};

export function isIntPrim(name) {
  return [
    primAnnotations.int8,
    primAnnotations.int16,
    primAnnotations.int32,
    primAnnotations.int64,
    primAnnotations.uint8,
    primAnnotations.uint16,
    primAnnotations.uint32,
    primAnnotations.uint64,
    primAnnotations.usize,
    primAnnotations.isize,
    primAnnotations.uintptr,
  ].includes(name);
}

export function isUnsignedIntPrim(name) {
  return [
    primAnnotations.uint8,
    primAnnotations.uint16,
    primAnnotations.uint32,
    primAnnotations.uint64,
    primAnnotations.usize,
    primAnnotations.uintptr,
  ].includes(name);
}

export function isSignedIntPrim(name) {
  return [
    primAnnotations.int8,
    primAnnotations.int16,
    primAnnotations.int32,
    primAnnotations.int64,
    primAnnotations.isize,
  ].includes(name);
}

export function getBitWidthOfIntPrim(name) {
  switch (name) {
    case primAnnotations.int8:
    case primAnnotations.uint8:
      return 8;
    case primAnnotations.int16:
    case primAnnotations.uint16:
      return 16;
    case primAnnotations.int32:
    case primAnnotations.uint32:
      return 32;
    case primAnnotations.int64:
    case primAnnotations.uint64:
      return 64;
    case primAnnotations.isize:
    case primAnnotations.usize:
    case primAnnotations.uintptr:
      // for simplicity, we'll just treat these as 64-bit for now
      return 64;
    default:
      throw new Error(`Not an int primitive: ${name}`);
  }
}

export function isFloatPrim(name) {
  return [primAnnotations.float32, primAnnotations.float64].includes(name);
}

export const PrimType = (name) => freezerWrap(typeKinds.prim, { name });

// moduleId: the module that defines this struct (for IR name mangling). null for test usage. Also carries implementsTraits and methods.
// propagatedKinds: list of KindApplication, kinds this struct propagates
// to bindings of this type. A field whose type carries a propagated kind is
// what the struct is "surfacing" upward.
// kindApplication: optional KindApplication attached via a
// type-decl kind prefix (e.g. `type Vec4 aligned(32) { ... }`). Layout
// information is read off this at every binding site.
export const StructType = (
  name,
  fields,
  moduleId = null,
  implementsTraits = [],
  methods = new Map(),
  propagatedKinds = [],
  kindApplication = null,
  // When this struct was produced by instantiating a generic decl,
  // `genericInstance: { declId, args }` captures the original generic decl
  // and the type-args used. Substitution uses this to re-instantiate when
  // args are themselves type-params (open instantiation -> concrete).
  genericInstance = null,
) =>
  freezerWrap(typeKinds.struct, {
    name,
    fields,
    moduleId,
    implementsTraits,
    methods,
    propagatedKinds,
    kindApplication,
    genericInstance,
  });
// An UNFROZEN struct shell for pass A, filled in place by pass C via
// fillStructShell.
//
// Identity is the whole point. If pass C instead built a fresh StructType and
// REPLACED the table entry, any field that had already resolved to this struct
// would point at the empty shell - and `sizeOfType` on an empty struct reports
// no fields, so every enclosing struct comes out undersized and the emitted IR
// reads its own fields at the wrong offsets. Inside one file that surfaces as
// the misleading `type "T" has no field "f"` papercut; across the source files
// of one directory module it SILENTLY MISCOMPILES (a sqlite `RawStmt` handle
// comes back as a shifted pointer and segfaults in libsqlite3).
//
// Variant shells and vtable shells are built the same way, for the same
// reason. `fields` stays null until filled so the "is this a shell?" checks
// across the checker keep working.
export const StructShell = (name, moduleId = null) => ({
  kind: typeKinds.struct,
  name,
  fields: null,
  moduleId,
  implementsTraits: [],
  methods: new Map(),
  propagatedKinds: [],
  kindApplication: null,
  genericInstance: null,
});

// Fill a shell in place and freeze it, so it is indistinguishable from a
// StructType built in one shot. `implementsTraits` / `methods` are deliberately
// left alone: they are mutable containers the impl-validation stage populates
// later, and they are already present on the shell.
export function fillStructShell(shell, fields, propagatedKinds, kindApplication) {
  shell.fields = fields;
  shell.propagatedKinds = propagatedKinds;
  shell.kindApplication = kindApplication;
  return Object.freeze(shell);
}

export const RefType = (inner) => freezerWrap(typeKinds.ref, { inner });
export const ArrayType = (elem) => freezerWrap(typeKinds.array, { elem });
// variadic: true for C variadic externs (e.g. printf). Skips arity check past fixed params.
// returnPropagatedKinds: list of KindType the function's return
// type propagates. Mirrors the StructType.propagatedKinds slot so callers see
// the kinds without re-resolving the return type.
// isAsync: the function is a coroutine. It may only be called through
// `await`, and `await` may only appear inside another async function (or
// a task body, which is implicitly async). That pair of rules is what
// makes the coloring checkable locally - there is no path to an async
// function except from an async caller, so a suspend always has a frame
// to propagate into. See docs/writing_yoop.md on async coloring.
export const FuncType = (
  params,
  returnType,
  variadic = false,
  returnPropagatedKinds = [],
  isAsync = false,
) =>
  freezerWrap(typeKinds.func, {
    params,
    returnType,
    variadic,
    returnPropagatedKinds,
    isAsync,
  });
export const VoidType = () => freezerWrap(typeKinds.void, {});
// exports: Set<string> of exported names in the source module
export const NamespaceType = (moduleId, exports) =>
  freezerWrap(typeKinds.namespace, { moduleId, exports });
export const UntypedIntType = () => freezerWrap(typeKinds.untypedInt, {});
export const UntypedFloatType = () => freezerWrap(typeKinds.untypedFloat, {});
export const ErrorType = () => freezerWrap(typeKinds.error, {});
// Trait types carry an optional type-param list for generic traits.
// `typeParams` is a list of TypeParamType. For non-generic traits, it's [].
// `extendsTraits` is the list of parent traits a `trait Child extends A, B`
// declaration names. The list itself is mutable (constructed empty in pass A,
// populated in pass C.1 once parent-trait shells are resolvable), so the
// outer freezerWrap is unchanged. Method resolution walks this chain
// transitively - a type implementing `Child` is required to provide methods
// for `Child` and every ancestor.
export const TraitType = (
  name,
  methods,
  moduleId = null,
  typeParams = [],
  extendsTraits = [],
) =>
  freezerWrap(typeKinds.trait, {
    name,
    methods,
    moduleId,
    typeParams,
    extendsTraits,
  });

// Tagged sum type. Source-level keyword is
// `variant`. AST kind is VARIANT_DECL.
//   variants: Map<caseName, { fields: [{name, type}] | null, ordinal: number }>
//   fields === null means a payload-less case (e.g. `Empty`).
//   ordinal: stable 0-indexed integer from declaration order; used as the
//     LLVM discriminator value at codegen time.
// `genericInstance: { declId, args } | null` tags instantiations
// of a generic variant decl, mirroring StructType. Substitution re-instantiates
// open instances via the registry.
// `variants` is populated in-place by pass C (mutates the shell
// the table registered in pass A) so back-references captured during struct
// field resolution see the populated cases at codegen time.
// Variants can `implements Trait propagates<K>` like structs.
// `implementsTraits`, `methods`, and `propagatedKinds` are mutable slots
// populated by pass C / pass C.1; the outer object stays frozen.
export const VariantType = (
  name,
  variants,
  moduleId = null,
  genericInstance = null,
  implementsTraits = [],
  methods = new Map(),
  propagatedKinds = [],
) =>
  freezerWrap(typeKinds.variant, {
    name,
    variants,
    moduleId,
    genericInstance,
    implementsTraits,
    methods,
    propagatedKinds,
  });

// Untagged C-style union - every field starts at offset 0,
// size = max(sizeof(field)), alignment = max(alignof(field)). No tag.
export const UnionType = (name, fields, moduleId = null) =>
  freezerWrap(typeKinds.union, { name, fields, moduleId });

// The pass-A shell for a union, unfrozen so pass C can fill it in place - same
// reason as ValueEnumShell below. Unlike StructShell this keeps `fields` as an
// empty array rather than null: nothing in the checker uses `fields === null`
// as a union shell test, and an empty array keeps every existing reader
// total. Shell-ness is "not frozen yet".
export const UnionShell = (name, moduleId = null) => ({
  kind: typeKinds.union,
  name,
  fields: [],
  moduleId,
});

export function fillUnionShell(shell, fields) {
  shell.fields = fields;
  return Object.freeze(shell);
}

// A value enum - nominal alias over a primitive underlying type
// (any signed/unsigned int width, or string). Each case is a named compile-
// time constant of the underlying type.
//   underlying: PrimType (int*/uint*/string)
//   cases: Map<name, { name, value, ordinal }> - `value` is a JS number or
//     BigInt for integer underlyings, or a string for `enum<string>`.
//   isOpen: true if any case's value was derived from bitwise operators on
//     other cases. Switch over an open enum requires `default` because the
//     reachable set is no longer the named cases alone.
export const ValueEnumType = (name, underlying, cases, implementsTraits = [], methods = new Map(), moduleId = null, isOpen = false) =>
  freezerWrap(typeKinds.valueEnum, { name, underlying, cases, implementsTraits, methods, moduleId, isOpen });

// The pass-A shell for a value enum: unfrozen, with `underlying` null until
// pass C fills it. Same discipline as StructShell above, and for the same
// reason. Replacing the table entry in pass C instead left anything that had
// already resolved the NAME holding the shell - a null underlying - which
// surfaced much later as "cannot switch over enum X: its underlying type is
// null". Directory modules made it reachable: within one module the files have
// no dependency order, so a sibling's function signature can resolve the enum
// before the enum's own decl is processed.
export const ValueEnumShell = (name, moduleId = null) => ({
  kind: typeKinds.valueEnum,
  name,
  underlying: null,
  cases: new Map(),
  implementsTraits: [],
  methods: new Map(),
  moduleId,
  isOpen: false,
});

// Fill a value-enum shell in place and freeze it. `implementsTraits` /
// `methods` are deliberately left alone: impl validation populates them later,
// and they are already present on the shell.
export function fillValueEnumShell(shell, underlying, cases, isOpen) {
  shell.underlying = underlying;
  shell.cases = cases;
  shell.isOpen = isOpen;
  return Object.freeze(shell);
}

// A first-class function value type - what `(p: T) => R` resolves
// to in a type annotation. Distinct from FuncType (which describes a named
// function decl) so call resolution can tell the two apart: FuncType callees
// resolve to a global mangled symbol, FunctionPointerType callees lower to
// an indirect call through a value slot.
// isAsync: the slot holds a coroutine-returning function (the async ABI -
// returns a handle, takes a trailing result slot). Users never write this
// on a `=>` annotation; for a vtable field it is stamped from the trait
// method's own asyncness during validateVTableDecl, so the trait stays
// the single authority and the two cannot drift.
export const FunctionPointerType = (params, returnType, isAsync = false) =>
  freezerWrap(typeKinds.functionPointer, { params, returnType, isAsync });

// A type-erased shape for a trait. Conceptually a struct with one
// `ctx` pointer + one function-pointer field per trait method. The compiler
// owns the field layout; the user only writes the method-pointer fields in
// the `vtable T for Trait { ... }` body. Two vtables are typesEqual if their
// `(name, moduleId)` match - they are nominal types, like structs.
//   methodOrder: list of method names in trait declaration order. Codegen
//                uses this to pick a stable LLVM field index for each.
//
// NOT frozen, unlike every other type but KindType / TypeParamType. Pass A
// registers a shell (no trait module, no fields, no methodOrder) and pass
// C.3b fills it in ON THE SAME OBJECT. Building a fresh populated type and
// swapping the table entry would leave any struct field that had already
// resolved `d: MyVtable` pointing at the shell - and a shell has no method
// slots, so a same-module `MyVtable.method(ref x.d, ...)` would fail with
// "vtable has no slot for trait method". Same shell-mutation pattern
// variants use, and for the same reason.
export const VTableType = (name, traitName, traitModuleId, fields, methodOrder, moduleId = null) => ({
  kind: typeKinds.vtable,
  name,
  traitName,
  traitModuleId,
  fields,
  methodOrder,
  moduleId,
});

// Raw, nullable, arithmetic-capable pointer for FFI. Gated by
// `import.unsafe;` at module top. Lowers to LLVM opaque `ptr`; the
// typechecker still tracks pointee identity so arithmetic / deref are
// strongly typed in source.
//
// Yoopstore-papercut #3: a `null` pointee represents the bare `unsafe_ptr`
// (no `<T>`) - an opaque C-pointer handle (think `void *` / `FILE *`).
// Opaque pointers compare to null and other unsafe_ptrs, can be cast to a
// typed pointer with `unsafe_ptr.cast<T>(p)`, and can round-trip through
// integers, but deref / pointer arithmetic / `toArray` are rejected.
// `unsafe_ptr<T>` decays implicitly to opaque (matches C's `T*` -> `void*`);
// the reverse requires the explicit cast.
export const UnsafePtrType = (pointee) =>
  freezerWrap(typeKinds.unsafePtr, { pointee });

// Placeholder for the `null` literal. Pinned to an
// UnsafePtrType<T> by context (similar to untypedInt/Float).
export const UntypedNullType = () => freezerWrap(typeKinds.untypedNull, {});

// TypeParamType is a placeholder appearing inside a generic decl's
// resolved types (struct field types, function param/return types, trait
// method signatures). It is replaced via substituteTypeParams at every
// instantiation site. `originDecl` is a stable per-decl id so two unrelated
// `T`s never compare equal.
// `bounds` is populated later in pass C if the param has an
// `implements` clause. Empty list means unbounded; single-bound is a list of
// length 1; multi-bound `<T implements (A, B)>` is a list of length N.
// Unlike other types in this file, TypeParamType is mutable for that one slot
// - see CLAUDE.md cross-cutting invariants.
export function TypeParamType(name, originDecl) {
  this.kind = typeKinds.typeParam;
  this.name = name;
  this.originDecl = originDecl;
  this.bounds = []; // TraitType[]
}

// Compiler-builtin Task<T>. Not user-declarable; produced as the
// rewritten return type of any function declared with the `task` modifier.
export const TaskType = (resultType) =>
  freezerWrap(typeKinds.task, { resultType });

// KindType is a language-level "kind" decl (e.g. `disposable`). Unlike
// other types in this file, KindType is mutable during pass C.2 - clauses
// resolve trait references and method names after the shell is registered in
// pass A.
export function KindType(name, moduleId) {
  this.kind = typeKinds.kind;
  this.name = name;
  this.moduleId = moduleId;
  this.appliesTo = new Set();              // Set<"binding"|"parameter"|"field"|"type">
  this.requires = [];                       // array of TraitType
  this.mustCall = [];                       // array of { methodName, timing, traitType }
  this.ownsBlock = false;
  // clearance kinds: marker polarity. null = obligation kind (disposable etc.);
  // "conferred" = capability a slot must have (lower bound); "restrictive" =
  // hazard a slot must not have (upper bound). A marker kind carries no
  // mustCall obligation - the two are mutually exclusive.
  this.marker = null;                      // null | "conferred" | "restrictive"
  // clearance kinds: name of the user function authorized to transition this
  // kind. `clearedBy` is the only function permitted to strip a restrictive
  // kind from a value; `appliedBy` is the only function permitted to confer
  // a conferred kind. The kind decl is the source of truth - random functions
  // with a matching signature shape are NOT authorized.
  this.clearedBy = null;                   // string | null (only on restrictive)
  this.appliedBy = null;                 // string | null (only on conferred)
  // Concurrency-core clauses, populated from real kind clauses.
  this.pausable = false;                   // `pausable;`  - function is a coroutine
  this.provides = null;                    // `provides X;` - call-site result rewrite
  this.refcounted = null;                  // `refcounted <retain> <release>;`
  this.mustNotEscape = false;              // true iff mustNotEscape clause is present
  this.mustNotShare = [];                  // array of "acrossScopes" (stored, not enforced)
  this.forbids = [];                       // array of "io"|"globalState" (stored, not enforced)
  // Parameter list, layout-align slot, composition diagnostics.
  this.params = [];                         // [{ name, type, sourceLoc }]
  this.layoutAlign = null;                  // { kind: "const", value } | { kind: "param", name } | null
  this.composedFrom = null;                 // KindRef[] | null (diagnostics only)
  // testing-via-kinds: `appliesTo function` support. `signature` holds the
  // resolved FuncType every function carrying this kind must match (filled in
  // pass C, since it names user types); `enumerableAs` is the table name a
  // consumer asks for, and the join key that keeps two enumerable kinds
  // distinct. Both null on every non-function kind.
  this.signature = null;                    // FuncType | null
  this.signatureAnnotation = null;          // raw annot, kept for pass-C resolution
  this.enumerableAs = null;                 // string | null
}

// A KindApplication is a `KindType` paired with the constant
// arguments supplied at a use site (`aligned(32)` => { kindType: aligned, args: [32] }).
// Use sites store the application on their AST node so codegen can read
// per-site layout without re-resolving.
export function KindApplication(kindType, args) {
  this.kindType = kindType;
  this.args = args; // array of constants (numbers for now)
}

/****************
 * Placeholders - these are things that get materialized later in the pipeline,
 * but we want to be able to represent them as types for now so that we can
 * resolve type annotations that refer to them, these are not legal to appear
 * outside of special situations
 ***************** */

// The `TraitSelfPlaceholder` is **only** legal inside a `RefType { inner }`
// slot of a trait method's first param type. When a struct `T` implements
// `Trait`, we materialize a per-type `FuncType` for each method by substituting
// `RefType { inner: T }` for `RefType { inner: TraitSelfPlaceholder }`. That
// substitution happens once per method per impl,
export const TraitSelfPlaceholder = Object.freeze({
  kind: "trait_self_placeholder",
});

// C-portable integer aliases. Resolution-time synonyms - the
// alias *is* the target type for every downstream purpose (typesEqual,
// assignability, codegen). Hardcoded to LP64 (Linux + macOS); Windows
// LLP64 mapping waits on real target-triple awareness in the compiler.
const C_ALIASES_LP64 = {
  c_short: "int16",
  c_ushort: "uint16",
  c_int: "int32",
  c_uint: "uint32",
  c_long: "int64",
  c_ulong: "uint64",
  c_size_t: "usize",
  c_ssize_t: "isize",
};

// conventional name conversions go here
export function canonicalize(name) {
  if (name === "int") return "int32";
  if (name === "float") return "float32";
  if (C_ALIASES_LP64[name]) return C_ALIASES_LP64[name];
  return name;
}

// try to find primitive from type name, else return null
export function primTypeFromName(name) {
  const canonName = canonicalize(name);
  if (canonName === "void") return VoidType();
  if (primAnnotations[canonName]) {
    return PrimType(canonName);
  }

  return null;
}

/**** important function ****
 * This resolves a type name relative to some context decided by the caller
 * For now this is going to handle structs as something non-primitive,
 * but this is also where we would handle type aliases, generics, etc. in the future
 */
export function resolveTypeFromName(name, structTable) {
  // naive for now
  return primTypeFromName(name) ?? structTable.get(name) ?? null;
}

// Find a transparent type alias (`type NodeId = usize;`) visible from `modId`
// under `name`, optionally namespace-qualified. Returns
// { annot, homeModId, key } - `annot` is the alias RHS to resolve, `homeModId`
// is the module whose scope that RHS must be resolved in, and `key` is a stable
// identity for cycle detection. Returns null when `name` is not an alias.
//
// Shared by both type resolvers (resolveTypeAnnotationInModule in typecheck.js
// and resolveAnnotMulti in instantiate.js) so alias visibility stays identical
// across the declaration-resolution and body-checking paths.
export function lookupAlias(namespace, name, modId, moduleEnv) {
  const env = moduleEnv?.get(modId);
  if (!env) return null;
  if (namespace) {
    const imp = env.importedNames?.get(namespace);
    if (!imp || imp.kind !== "namespace") return null;
    const srcEnv = moduleEnv.get(imp.fromModuleId);
    const a = srcEnv?.aliasTable?.get(name);
    if (a) {
      return { annot: a.annot, homeModId: imp.fromModuleId, key: `${imp.fromModuleId}::${name}` };
    }
    return null;
  }
  const local = env.aliasTable?.get(name);
  if (local) {
    return { annot: local.annot, homeModId: modId, key: `${modId}::${name}` };
  }
  const imp = env.importedNames?.get(name);
  if (imp && imp.kind === "alias") {
    const srcEnv = moduleEnv.get(imp.fromModuleId);
    const a = srcEnv?.aliasTable?.get(imp.exportName);
    if (a) {
      return {
        annot: a.annot,
        homeModId: imp.fromModuleId,
        key: `${imp.fromModuleId}::${imp.exportName}`,
      };
    }
  }
  return null;
}

// Resolve a structured type annotation object (from parseTypeAnnotation) to a Type.
//
// ctx may carry:
//   - typeParamScope: Map<paramName, TypeParamType> for resolving bare names
//     to type-params when inside a generic decl
//   - instantiateGeneric: function(name, argTypes, annot) used to handle
//     typeApplication annotations (delegated to the instantiation registry)
export function resolveTypeAnnotation(annot, structTable, ctx) {
  if (!annot) return null;
  if (annot.kind === "typeName") {
    // Look up type-params in scope first.
    if (ctx?.typeParamScope) {
      const tp = ctx.typeParamScope.get(annot.name);
      if (tp) return tp;
    }
    // Yoopstore-papercut #3: bare `unsafe_ptr` (no `<T>`) is the opaque
    // C-pointer handle. Gated by `import.unsafe;` via the same path that
    // catches the generic form.
    if (annot.name === "unsafe_ptr") {
      return UnsafePtrType(null);
    }
    return resolveTypeFromName(annot.name, structTable);
  }
  if (annot.kind === "refType") {
    const inner = resolveTypeAnnotation(annot.inner, structTable, ctx);
    if (!inner) return null;
    return RefType(inner);
  }
  if (annot.kind === "arrayType") {
    const elem = resolveTypeAnnotation(annot.elem, structTable, ctx);
    if (!elem) return null;
    return ArrayType(elem);
  }
  if (annot.kind === "taskType") {
    const inner = resolveTypeAnnotation(annot.inner, structTable, ctx);
    if (!inner) return null;
    return TaskType(inner);
  }
  if (annot.kind === "typeApplication") {
    // Resolve each type arg first.
    const argTypes = [];
    for (const a of annot.typeArgs) {
      const t = resolveTypeAnnotation(a, structTable, ctx);
      if (!t) return null;
      argTypes.push(t);
    }
    // Bridge: Task<T> is the only built-in generic in the single-module
    // path. The multi-module path uses ctx.instantiateGeneric for user
    // generics.
    if (annot.name === "Task" && argTypes.length === 1) {
      return TaskType(argTypes[0]);
    }
    // unsafe_ptr<T> is a built-in pointer type, not a generic
    // struct. Gating against `import.unsafe;` is enforced by the caller
    // when ctx.allowsUnsafe === false (see typecheck.js).
    if (annot.name === "unsafe_ptr" && argTypes.length === 1) {
      return UnsafePtrType(argTypes[0]);
    }
    if (ctx?.instantiateGeneric) {
      return ctx.instantiateGeneric(annot.name, argTypes, annot);
    }
    return null;
  }
  if (annot.kind === "selfType") {
    if (!ctx?.selfType) {
      throw new Error(
        "resolveTypeAnnotation: 'self' used outside the trait/method context",
      );
    }
    return ctx.selfType;
  }
  // `(p: T) => R` function value type.
  if (annot.kind === "functionType") {
    const params = [];
    for (const p of annot.params) {
      const pt = resolveTypeAnnotation(p, structTable, ctx);
      if (!pt) return null;
      params.push(pt);
    }
    const rt = resolveTypeAnnotation(annot.returnType, structTable, ctx);
    if (!rt) return null;
    return FunctionPointerType(params, rt);
  }
  throw new Error(
    `resolveTypeAnnotation: unknown annotation kind "${annot.kind}"`,
  );
}

// Format a type annotation object as a human-readable string (for error messages).
export function formatAnnotation(annot) {
  if (!annot) return "unknown";
  if (annot.kind === "typeName") {
    return annot.namespace ? `${annot.namespace}.${annot.name}` : annot.name;
  }
  if (annot.kind === "refType") return `ref ${formatAnnotation(annot.inner)}`;
  if (annot.kind === "arrayType") return `${formatAnnotation(annot.elem)}[]`;
  if (annot.kind === "taskType") return `Task<${formatAnnotation(annot.inner)}>`;
  if (annot.kind === "typeApplication") {
    const args = annot.typeArgs.map(formatAnnotation).join(", ");
    const head = annot.namespace ? `${annot.namespace}.${annot.name}` : annot.name;
    return `${head}<${args}>`;
  }
  if (annot.kind === "functionType") {
    const params = annot.params.map(formatAnnotation).join(", ");
    return `(${params}) => ${formatAnnotation(annot.returnType)}`;
  }
  return "unknown";
}

function bitWidthOf(name) {
  switch (name) {
    case "int8":
    case "uint8":
      return 8;
    case "int16":
    case "uint16":
      return 16;
    case "int32":
    case "uint32":
      return 32;
    case "int64":
    case "uint64":
    case "usize":
    case "isize":
    case "uintptr":
      return 64;
    case "float32":
      return 32;
    case "float64":
      return 64;
    default:
      throw new Error(`bitWidthOf: unknown type "${name}"`);
  }
}

// Returns true if a numeric cast from src to dst is valid (both must be numeric prims).
// An integer-backed value enum is castable to/from any numeric prim
// via its underlying primitive. String-backed enums are not castable.
export function isCastableTo(src, dst) {
  if (!src || !dst) return false;
  const numericPrims = [
    "int8",
    "int16",
    "int32",
    "int64",
    "uint8",
    "uint16",
    "uint32",
    "uint64",
    "usize",
    "isize",
    "float32",
    "float64",
  ];
  const effective = (t) => {
    if (t.kind === typeKinds.valueEnum) return t.underlying;
    return t;
  };
  const s = effective(src);
  const d = effective(dst);
  if (s.kind !== typeKinds.prim || d.kind !== typeKinds.prim) return false;
  return numericPrims.includes(s.name) && numericPrims.includes(d.name);
}

// Returns the LLVM cast opcode string for casting srcType to dstType.
// Caller must verify isCastableTo first. Returns null for no-op (same width int).
export function castInstruction(srcType, dstType) {
  const srcIsFloat = srcType.name.startsWith("float");
  const dstIsFloat = dstType.name.startsWith("float");
  const srcBits = bitWidthOf(srcType.name);
  const dstBits = bitWidthOf(dstType.name);

  if (srcIsFloat && dstIsFloat) {
    return srcBits < dstBits ? "fpext" : "fptrunc";
  }
  if (!srcIsFloat && !dstIsFloat) {
    if (srcBits === dstBits) return null; // same representation
    if (srcBits < dstBits) {
      return isUnsignedIntPrim(srcType.name) ? "zext" : "sext";
    }
    return "trunc";
  }
  if (!srcIsFloat && dstIsFloat) {
    return isUnsignedIntPrim(srcType.name) ? "uitofp" : "sitofp";
  }
  // float to int
  return isUnsignedIntPrim(dstType.name) ? "fptoui" : "fptosi";
}

export function typesEqual(a, b) {
  if (!a || !b) {
    return false;
  }
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === typeKinds.prim) {
    return a.name === b.name;
  }
  if (a.kind === typeKinds.struct) {
    // nominal by name + module; moduleId null means legacy/test single-module path.
    return a.name === b.name && (a.moduleId ?? null) === (b.moduleId ?? null);
  }
  if (a.kind === typeKinds.ref) {
    return typesEqual(a.inner, b.inner);
  }
  if (a.kind === typeKinds.array) {
    return typesEqual(a.elem, b.elem);
  }
  if (a.kind === typeKinds.func) {
    if (a.params.length !== b.params.length) {
      return false;
    }
    for (let i = 0; i < a.params.length; i++) {
      if (!typesEqual(a.params[i], b.params[i])) {
        return false;
      }
    }
    return typesEqual(a.returnType, b.returnType);
  }
  if (
    a.kind === typeKinds.void ||
    a.kind === typeKinds.untypedInt ||
    a.kind === typeKinds.untypedFloat ||
    a.kind === typeKinds.error
  ) {
    return true;
  }
  if (a.kind === typeKinds.trait) {
    return a.name === b.name && (a.moduleId ?? null) === (b.moduleId ?? null);
  }
  if (a.kind === typeKinds.task) {
    return typesEqual(a.resultType, b.resultType);
  }
  if (a.kind === typeKinds.typeParam) {
    return a.name === b.name && a.originDecl === b.originDecl;
  }
  if (a.kind === typeKinds.functionPointer) {
    if (a.params.length !== b.params.length) return false;
    for (let i = 0; i < a.params.length; i++) {
      if (!typesEqual(a.params[i], b.params[i])) return false;
    }
    return typesEqual(a.returnType, b.returnType);
  }
  if (a.kind === typeKinds.vtable) {
    return a.name === b.name && (a.moduleId ?? null) === (b.moduleId ?? null);
  }
  if (a.kind === typeKinds.variant || a.kind === typeKinds.union) {
    return a.name === b.name && (a.moduleId ?? null) === (b.moduleId ?? null);
  }
  if (a.kind === typeKinds.valueEnum) {
    return a.name === b.name && (a.moduleId ?? null) === (b.moduleId ?? null);
  }
  if (a.kind === typeKinds.unsafePtr) {
    // Yoopstore-papercut #3: a null pointee is the opaque `unsafe_ptr`.
    // Two opaques are equal; typed and opaque are not.
    if (a.pointee === null && b.pointee === null) return true;
    if (a.pointee === null || b.pointee === null) return false;
    return typesEqual(a.pointee, b.pointee);
  }
  if (a.kind === typeKinds.untypedNull) {
    return true;
  }
  throw new Error(`Unknown type kind: ${a.kind}`);
}

// Walk a type, replacing every TypeParamType matched in
// `substitution` (a Map<originDecl-string, Map<paramName, Type>>) with the
// substituted Type. For frozen primitives, just returns the input. New
// composite types are constructed and frozen.
//
// `instantiator` is an optional callback (declId, args) -> StructType used
// when a struct carries a `genericInstance` tag - substitution re-instantiates
// against the registry so an open `Box<T>` becomes the canonical `Box<int32>`.
let _globalInstantiator = null;
export function setGlobalInstantiator(fn) {
  _globalInstantiator = fn;
}
export function substituteTypeParams(type, substitution, instantiator = null) {
  if (!type) return type;
  const inst = instantiator ?? _globalInstantiator;
  switch (type.kind) {
    case typeKinds.typeParam: {
      const byDecl = substitution.get(type.originDecl);
      if (!byDecl) return type;
      const v = byDecl.get(type.name);
      return v ?? type;
    }
    case typeKinds.ref:
      return RefType(substituteTypeParams(type.inner, substitution, inst));
    case typeKinds.array:
      return ArrayType(substituteTypeParams(type.elem, substitution, inst));
    case typeKinds.task:
      return TaskType(substituteTypeParams(type.resultType, substitution, inst));
    case typeKinds.func: {
      const params = type.params.map((p) => ({
        ...p,
        type: substituteTypeParams(p.type, substitution, inst),
      }));
      return FuncType(
        params,
        substituteTypeParams(type.returnType, substitution, inst),
        type.variadic ?? false,
        type.returnPropagatedKinds ?? [],
        // Asyncness survives monomorphization - an instantiated generic
        // async function is still a coroutine, and dropping the flag
        // here makes every generic async call site report "callee is not
        // async" at the await.
        type.isAsync ?? false,
      );
    }
    case typeKinds.struct: {
      // If this struct is a generic instantiation, substitute its
      // type args and re-instantiate via the registry. This is what turns an
      // open `Box<T>` (inside a generic body) into the concrete `Box<int32>`
      // at codegen time.
      if (type.genericInstance && inst) {
        const newArgs = type.genericInstance.args.map((a) =>
          substituteTypeParams(a, substitution, inst),
        );
        // If args are unchanged (no substitution happened), keep the original.
        const allSame = newArgs.every(
          (a, i) => a === type.genericInstance.args[i],
        );
        if (allSame) return type;
        const fresh = inst(type.genericInstance.declId, newArgs);
        if (fresh) return fresh;
      }
      if (!type.fields) return type;
      const hasParam = type.fields.some((f) => typeHasTypeParam(f.type));
      if (!hasParam) return type;
      const fields = type.fields.map((f) => ({
        ...f,
        type: substituteTypeParams(f.type, substitution, inst),
      }));
      return StructType(
        type.name,
        fields,
        type.moduleId,
        type.implementsTraits ?? [],
        type.methods ?? new Map(),
        type.propagatedKinds ?? [],
        type.kindApplication ?? null,
        type.genericInstance ?? null,
      );
    }
    case typeKinds.variant: {
      // Mirror the struct branch. Open instances (carrying
      // genericInstance with TypeParamType args) re-route through the
      // registry once their args have concrete substitutions.
      if (type.genericInstance && inst) {
        const newArgs = type.genericInstance.args.map((a) =>
          substituteTypeParams(a, substitution, inst),
        );
        const allSame = newArgs.every(
          (a, i) => a === type.genericInstance.args[i],
        );
        if (allSame) return type;
        const fresh = inst(type.genericInstance.declId, newArgs);
        if (fresh) return fresh;
      }
      return type;
    }
    case typeKinds.functionPointer: {
      // FPT carries plain-type params + return. Walk both.
      const newParams = type.params.map((p) =>
        substituteTypeParams(p, substitution, inst),
      );
      const newRet = substituteTypeParams(type.returnType, substitution, inst);
      const allSame =
        newParams.every((p, i) => p === type.params[i]) &&
        newRet === type.returnType;
      if (allSame) return type;
      return FunctionPointerType(newParams, newRet);
    }
    case typeKinds.unsafePtr: {
      // Yoopstore-papercut #3: opaque (null pointee) is invariant under
      // substitution.
      if (type.pointee === null) return type;
      const newPointee = substituteTypeParams(type.pointee, substitution, inst);
      if (newPointee === type.pointee) return type;
      return UnsafePtrType(newPointee);
    }
    // prim/void/untyped/error/namespace/trait/kind - no nested type
    default:
      return type;
  }
}

// Helper: does this type (or anything it contains) reference a typeParam?
export function typeHasTypeParam(type) {
  if (!type) return false;
  if (type.kind === typeKinds.typeParam) return true;
  if (type.kind === typeKinds.ref) return typeHasTypeParam(type.inner);
  if (type.kind === typeKinds.array) return typeHasTypeParam(type.elem);
  if (type.kind === typeKinds.task) return typeHasTypeParam(type.resultType);
  if (type.kind === typeKinds.func) {
    return (
      type.params.some((p) => typeHasTypeParam(p.type)) ||
      typeHasTypeParam(type.returnType)
    );
  }
  if (type.kind === typeKinds.struct) {
    if (!type.fields) return false;
    return type.fields.some((f) => typeHasTypeParam(f.type));
  }
  if (type.kind === typeKinds.variant) {
    if (!type.variants) return false;
    for (const v of type.variants.values()) {
      if (v.fields === null) continue;
      if (v.fields.some((f) => typeHasTypeParam(f.type))) return true;
    }
    return false;
  }
  if (type.kind === typeKinds.functionPointer) {
    return (
      type.params.some((p) => typeHasTypeParam(p)) ||
      typeHasTypeParam(type.returnType)
    );
  }
  if (type.kind === typeKinds.unsafePtr) {
    if (type.pointee === null) return false;
    return typeHasTypeParam(type.pointee);
  }
  return false;
}
