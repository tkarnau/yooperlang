import { primAnnotations, typeKinds, VoidType } from "./types.js";

// Phase 9.H: a fallible *enum* is any enum with exactly two variants named
// `Ok` and `Err`. The shape is structural — no marker trait — so any user-
// defined enum that matches the naming convention plays in `?` propagation.
// Each variant may have zero or one payload field; the Ok payload becomes
// the stripped value, and the Err payload is the propagated error type.
export function isFallibleEnum(enumType) {
  if (!enumType || enumType.kind !== typeKinds.enum) return false;
  const variants = enumType.variants;
  if (!variants || variants.size !== 2) return false;
  const ok = variants.get("Ok");
  const err = variants.get("Err");
  if (!ok || !err) return false;
  if (ok.fields !== null && ok.fields.length > 1) return false;
  if (err.fields !== null && err.fields.length > 1) return false;
  return true;
}

// Stripped value type produced by `expr?` when expr is a fallible enum.
// Ok with zero fields -> void; Ok with one field -> that field's type.
export function strippedEnumOkType(enumType) {
  const ok = enumType.variants.get("Ok");
  if (!ok || ok.fields === null || ok.fields.length === 0) {
    return VoidType();
  }
  return ok.fields[0].type;
}

// The Err payload type — what the enclosing function's Err variant must
// accept for propagation to be type-safe. void when Err has no payload.
export function enumErrPayloadType(enumType) {
  const err = enumType.variants.get("Err");
  if (!err || err.fields === null || err.fields.length === 0) {
    return VoidType();
  }
  return err.fields[0].type;
}

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
