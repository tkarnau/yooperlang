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
  // Phase 7.1: a reference to a generic type parameter in a generic decl.
  typeParam: "typeParam",
  // Phase 7.5: tagged sum and C-style overlapping union.
  enum: "enum",
  union: "union",
  // Phase 8.A: raw FFI pointer. Distinct from `ref T` (which is non-null and
  // does not participate in arithmetic).
  unsafePtr: "unsafePtr",
  // Phase 8.A: literal-placeholder for `null`, similar to untypedInt/Float.
  // Pinned by context (assignment target, return, call arg, equality side).
  untypedNull: "untypedNull",
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
  // Phase 8.A: platform pointer-width unsigned integer. Lowered to i64 on
  // 64-bit targets (the only ones we currently support). Distinct from usize
  // in source for documentation purposes — mirrors C uintptr_t vs size_t.
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

// moduleId: the module that defines this struct (for IR name mangling). null for legacy/test usage. Also adding implementsTraits and methods
// propagatedKinds (phase 6.4): list of KindApplication, kinds this struct propagates
// to bindings of this type. A field whose type carries a propagated kind is
// what the struct is "surfacing" upward.
// kindApplication (phase 6.5): optional KindApplication attached via a
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
  // Phase 7.1: when this struct was produced by instantiating a generic decl,
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
export const RefType = (inner) => freezerWrap(typeKinds.ref, { inner });
export const ArrayType = (elem) => freezerWrap(typeKinds.array, { elem });
// variadic: true for C variadic externs (e.g. printf). Skips arity check past fixed params.
// returnPropagatedKinds (phase 6.4): list of KindType the function's return
// type propagates. Mirrors the StructType.propagatedKinds slot so callers see
// the kinds without re-resolving the return type.
export const FuncType = (params, returnType, variadic = false, returnPropagatedKinds = []) =>
  freezerWrap(typeKinds.func, { params, returnType, variadic, returnPropagatedKinds });
export const VoidType = () => freezerWrap(typeKinds.void, {});
// exports: Set<string> of exported names in the source module
export const NamespaceType = (moduleId, exports) =>
  freezerWrap(typeKinds.namespace, { moduleId, exports });
export const UntypedIntType = () => freezerWrap(typeKinds.untypedInt, {});
export const UntypedFloatType = () => freezerWrap(typeKinds.untypedFloat, {});
export const ErrorType = () => freezerWrap(typeKinds.error, {});
// Phase 7.1: trait types carry an optional type-param list for generic traits.
// `typeParams` is a list of TypeParamType. For non-generic traits, it's [].
export const TraitType = (name, methods, moduleId = null, typeParams = []) =>
  freezerWrap(typeKinds.trait, { name, methods, moduleId, typeParams });

// Phase 7.5: tagged sum type.
//   variants: Map<variantName, { fields: [{name, type}] | null, ordinal: number }>
//   fields === null means a payload-less variant (e.g. `Empty`).
//   ordinal: stable 0-indexed integer from declaration order; used as the
//     LLVM discriminator value at codegen time.
export const EnumType = (name, variants, moduleId = null) =>
  freezerWrap(typeKinds.enum, { name, variants, moduleId });

// Phase 7.5: untagged C-style union — every field starts at offset 0,
// size = max(sizeof(field)), alignment = max(alignof(field)). No tag.
export const UnionType = (name, fields, moduleId = null) =>
  freezerWrap(typeKinds.union, { name, fields, moduleId });

// Phase 8.A: raw, nullable, arithmetic-capable pointer for FFI. Gated by
// `import.unsafe;` at module top. Lowers to LLVM opaque `ptr`; the
// typechecker still tracks pointee identity so arithmetic / deref are
// strongly typed in source.
export const UnsafePtrType = (pointee) =>
  freezerWrap(typeKinds.unsafePtr, { pointee });

// Phase 8.A: placeholder for the `null` literal. Pinned to an
// UnsafePtrType<T> by context (similar to untypedInt/Float).
export const UntypedNullType = () => freezerWrap(typeKinds.untypedNull, {});

// Phase 7.1: TypeParamType is a placeholder appearing inside a generic decl's
// resolved types (struct field types, function param/return types, trait
// method signatures). It is replaced via substituteTypeParams at every
// instantiation site. `originDecl` is a stable per-decl id so two unrelated
// `T`s never compare equal.
// Phase 7.2: `bound` is set later in pass C if the param has an `implements`
// clause. Unlike other types in this file, TypeParamType is mutable for that
// one slot — see CLAUDE.md cross-cutting invariants.
export function TypeParamType(name, originDecl) {
  this.kind = typeKinds.typeParam;
  this.name = name;
  this.originDecl = originDecl;
  this.bound = null; // TraitType | null
}

// Phase 6.3: compiler-builtin Task<T>. Not user-declarable; produced as the
// rewritten return type of any function declared with the `task` modifier.
export const TaskType = (resultType) =>
  freezerWrap(typeKinds.task, { resultType });

// KindType is a language-level "kind" decl (phase 6.1: `disposable`). Unlike
// other types in this file, KindType is mutable during pass C.2 — clauses
// resolve trait references and method names after the shell is registered in
// pass A. The shape mirrors the plan in plans/phase-6-1-disposable.md §4.a.
export function KindType(name, moduleId) {
  this.kind = typeKinds.kind;
  this.name = name;
  this.moduleId = moduleId;
  this.appliesTo = new Set();              // 6.2: Set<"binding"|"parameter"|"field"|"type"> (was scalar)
  this.requires = [];                       // array of TraitType
  this.mustCall = [];                       // array of { methodName, timing, traitType }
  this.ownsBlock = false;
  this.mustNotEscape = false;              // 6.2: true iff mustNotEscape clause is present
  this.mustNotShare = [];                  // 6.2: array of "acrossScopes" (stored, not enforced)
  this.forbids = [];                       // 6.2: array of "io"|"globalState" (stored, not enforced)
  // 6.5: parameter list, layout-align slot, composition diagnostics.
  this.params = [];                         // [{ name, type, sourceLoc }]
  this.layoutAlign = null;                  // { kind: "const", value } | { kind: "param", name } | null
  this.composedFrom = null;                 // KindRef[] | null (diagnostics only)
}

// Phase 6.5: a KindApplication is a `KindType` paired with the constant
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

// Phase 8.B: C-portable integer aliases. Resolution-time synonyms — the
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

// Resolve a structured type annotation object (from parseTypeAnnotation) to a Type.
//
// Phase 7.1: ctx may carry:
//   - typeParamScope: Map<paramName, TypeParamType> for resolving bare names
//     to type-params when inside a generic decl
//   - instantiateGeneric: function(name, argTypes, annot) used to handle
//     typeApplication annotations (delegated to the instantiation registry)
export function resolveTypeAnnotation(annot, structTable, ctx) {
  if (!annot) return null;
  if (annot.kind === "typeName") {
    // Phase 7.1: look up type-params in scope first.
    if (ctx?.typeParamScope) {
      const tp = ctx.typeParamScope.get(annot.name);
      if (tp) return tp;
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
    // Phase 8.A: unsafe_ptr<T> is a built-in pointer type, not a generic
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
  throw new Error(
    `resolveTypeAnnotation: unknown annotation kind "${annot.kind}"`,
  );
}

// Format a type annotation object as a human-readable string (for error messages).
export function formatAnnotation(annot) {
  if (!annot) return "unknown";
  if (annot.kind === "typeName") return annot.name;
  if (annot.kind === "refType") return `ref ${formatAnnotation(annot.inner)}`;
  if (annot.kind === "arrayType") return `${formatAnnotation(annot.elem)}[]`;
  if (annot.kind === "taskType") return `Task<${formatAnnotation(annot.inner)}>`;
  if (annot.kind === "typeApplication") {
    const args = annot.typeArgs.map(formatAnnotation).join(", ");
    return `${annot.name}<${args}>`;
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
export function isCastableTo(src, dst) {
  if (!src || !dst) return false;
  if (src.kind !== typeKinds.prim || dst.kind !== typeKinds.prim) return false;
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
  return numericPrims.includes(src.name) && numericPrims.includes(dst.name);
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
  if (a.kind === typeKinds.enum || a.kind === typeKinds.union) {
    return a.name === b.name && (a.moduleId ?? null) === (b.moduleId ?? null);
  }
  if (a.kind === typeKinds.unsafePtr) {
    return typesEqual(a.pointee, b.pointee);
  }
  if (a.kind === typeKinds.untypedNull) {
    return true;
  }
  throw new Error(`Unknown type kind: ${a.kind}`);
}

// Phase 7.1: walk a type, replacing every TypeParamType matched in
// `substitution` (a Map<originDecl-string, Map<paramName, Type>>) with the
// substituted Type. For frozen primitives, just returns the input. New
// composite types are constructed and frozen.
//
// `instantiator` is an optional callback (declId, args) -> StructType used
// when a struct carries a `genericInstance` tag — substitution re-instantiates
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
      );
    }
    case typeKinds.struct: {
      // Phase 7.1: if this struct is a generic instantiation, substitute its
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
    // prim/void/untyped/error/namespace/trait/kind — no nested type
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
  return false;
}
