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
  ].includes(name);
}

export function isUnsignedIntPrim(name) {
  return [
    primAnnotations.uint8,
    primAnnotations.uint16,
    primAnnotations.uint32,
    primAnnotations.uint64,
    primAnnotations.usize,
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

// moduleId: the module that defines this struct (for IR name mangling). null for legacy/test usage.
export const StructType = (name, fields, moduleId = null) =>
  freezerWrap(typeKinds.struct, { name, fields, moduleId });
export const RefType = (inner) => freezerWrap(typeKinds.ref, { inner });
export const ArrayType = (elem) => freezerWrap(typeKinds.array, { elem });
// variadic: true for C variadic externs (e.g. printf). Skips arity check past fixed params.
export const FuncType = (params, returnType, variadic = false) =>
  freezerWrap(typeKinds.func, { params, returnType, variadic });
export const VoidType = () => freezerWrap(typeKinds.void, {});
// exports: Set<string> of exported names in the source module
export const NamespaceType = (moduleId, exports) =>
  freezerWrap(typeKinds.namespace, { moduleId, exports });
export const UntypedIntType = () => freezerWrap(typeKinds.untypedInt, {});
export const UntypedFloatType = () => freezerWrap(typeKinds.untypedFloat, {});
export const ErrorType = () => freezerWrap(typeKinds.error, {});

// conventional name conversions go here
export function canonicalize(name) {
  if (name === "int") return "int32";
  if (name === "float") return "float32";
  return name;
}

// try to find primitive from type name, else return null
export function primTypeFromName(name) {
  const canonName = canonicalize(name);
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
export function resolveTypeAnnotation(annot, structTable) {
  if (!annot) return null;
  if (annot.kind === "typeName") {
    return resolveTypeFromName(annot.name, structTable);
  }
  if (annot.kind === "refType") {
    const inner = resolveTypeAnnotation(annot.inner, structTable);
    if (!inner) return null;
    return RefType(inner);
  }
  if (annot.kind === "arrayType") {
    const elem = resolveTypeAnnotation(annot.elem, structTable);
    if (!elem) return null;
    return ArrayType(elem);
  }
  throw new Error(`resolveTypeAnnotation: unknown annotation kind "${annot.kind}"`);
}

// Format a type annotation object as a human-readable string (for error messages).
export function formatAnnotation(annot) {
  if (!annot) return "unknown";
  if (annot.kind === "typeName") return annot.name;
  if (annot.kind === "refType") return `ref ${formatAnnotation(annot.inner)}`;
  if (annot.kind === "arrayType") return `${formatAnnotation(annot.elem)}[]`;
  return "unknown";
}

function bitWidthOf(name) {
  switch (name) {
    case "int8": case "uint8": return 8;
    case "int16": case "uint16": return 16;
    case "int32": case "uint32": return 32;
    case "int64": case "uint64": case "usize": case "isize": return 64;
    case "float32": return 32;
    case "float64": return 64;
    default: throw new Error(`bitWidthOf: unknown type "${name}"`);
  }
}

// Returns true if a numeric cast from src to dst is valid (both must be numeric prims).
export function isCastableTo(src, dst) {
  if (!src || !dst) return false;
  if (src.kind !== typeKinds.prim || dst.kind !== typeKinds.prim) return false;
  const numericPrims = [
    "int8","int16","int32","int64",
    "uint8","uint16","uint32","uint64","usize","isize",
    "float32","float64",
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
  throw new Error(`Unknown type kind: ${a.kind}`);
}
