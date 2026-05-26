import { typeKinds, VoidType } from "./types.js";

// Phase 9.H: a fallible *variant* is any variant decl with exactly two cases
// named `Ok` and `Err`. The shape is structural - no marker trait - so any
// user-defined variant that matches the naming convention plays in `?`
// propagation. Each case may have zero or one payload field; the Ok payload
// becomes the stripped value, and the Err payload is the propagated error type.
//
// Phase 10.X: the older Phase 2 "struct ending in `err: string`" convention
// has been retired in favor of `Result<T, E>`-shaped variants. The fallible
// machinery now recognizes exactly one shape: this one.
// Phase 12: renamed from `isFallibleEnum`; the source-level keyword is `variant`.
export function isFallibleVariant(variantType) {
  if (!variantType || variantType.kind !== typeKinds.variant) return false;
  const variants = variantType.variants;
  if (!variants || variants.size !== 2) return false;
  const ok = variants.get("Ok");
  const err = variants.get("Err");
  if (!ok || !err) return false;
  if (ok.fields !== null && ok.fields.length > 1) return false;
  if (err.fields !== null && err.fields.length > 1) return false;
  return true;
}

// Stripped value type produced by `expr?` when expr is a fallible variant.
// Ok with zero fields -> void; Ok with one field -> that field's type.
export function strippedVariantOkType(variantType) {
  const ok = variantType.variants.get("Ok");
  if (!ok || ok.fields === null || ok.fields.length === 0) {
    return VoidType();
  }
  return ok.fields[0].type;
}

// The Err payload type - what the enclosing function's Err case must
// accept for propagation to be type-safe. void when Err has no payload.
export function variantErrPayloadType(variantType) {
  const err = variantType.variants.get("Err");
  if (!err || err.fields === null || err.fields.length === 0) {
    return VoidType();
  }
  return err.fields[0].type;
}
