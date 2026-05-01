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

export function isFloatPrim(name) {
  return [primAnnotations.float32, primAnnotations.float64].includes(name);
}

export const PrimType = (name) => freezerWrap(typeKinds.prim, { name });

export const StructType = (name, fields) =>
  freezerWrap(typeKinds.struct, { name, fields });
export const RefType = (inner) => freezerWrap(typeKinds.ref, { inner });
export const ArrayType = (elem) => freezerWrap(typeKinds.array, { elem });
export const FuncType = (params, returnType) =>
  freezerWrap(typeKinds.func, { params, returnType });
export const VoidType = () => freezerWrap(typeKinds.void, {});
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
  if (primAnnotations[name]) {
    return PrimType(name);
  }

  return null;
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
  // todo more fleshing out here...
}
