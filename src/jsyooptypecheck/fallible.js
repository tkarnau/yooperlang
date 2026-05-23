import { typeKinds, VoidType } from "./types.js";

// Phase 9.H: a fallible *enum* is any enum with exactly two variants named
// `Ok` and `Err`. The shape is structural — no marker trait — so any user-
// defined enum that matches the naming convention plays in `?` propagation.
// Each variant may have zero or one payload field; the Ok payload becomes
// the stripped value, and the Err payload is the propagated error type.
//
// Phase 10.X: the older Phase 2 "struct ending in `err: string`" convention
// has been retired in favor of `Result<T, E>`-shaped enums. The fallible
// machinery now recognizes exactly one shape: this one.
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
