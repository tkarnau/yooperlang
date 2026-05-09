import { primAnnotations, typeKinds, VoidType } from "./types.js";

// a struct is fallible if and only if its fields end with 'err: string'.
export function isFallible(structType) {
  if (!structType || structType.kind !== typeKinds.struct) {
    return false;
  }

  const fields = structType.fields ?? [];
  if (fields.length === 0) {
    return false;
  }
  const last = fields[fields.length - 1];
  if (last.name !== "err") {
    return false;
  }
  if (last.type.kind !== typeKinds.prim) {
    return false;
  }
  if (last.type.name !== primAnnotations.string) {
    return false;
  }

  return true;
}

// what `expr?` yields when expr has type t.
//   - { value: T, err: string }            -> T
//   - { f1, f2, ..., err: string }         -> { kind: "strippedMulti", fields, sourceName }
//   - { err: string }                      -> void
//   - non-fallible                         -> null
//
// the multi-field case returns a non-Type sentinel so every caller is forced
// to handle it: destructure permits it, every other context rejects.
export function strippedTypeOf(fallibleType) {
  if (!isFallible(fallibleType)) {
    return null;
  }
  const nonErr = fallibleType.fields.slice(0, -1);
  if (nonErr.length === 0) {
    return VoidType();
  }
  if (nonErr.length === 1) {
    return nonErr[0].type;
  }
  return {
    kind: "strippedMulti",
    fields: nonErr,
    sourceName: fallibleType.name,
  };
}
