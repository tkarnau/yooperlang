// Phase 11.B: wrapped values for the comptime interpreter.
//
// Every value the interpreter manipulates is a `{ ty, v }` pair where
// `ty` is a yoop `Type` (from src/jsyooptypecheck/types.js) and `v` is
// the JS-side payload. The wrapping lets the interpreter dispatch on
// type without separately threading type info alongside raw JS values.
//
// Payload conventions:
//   int8 / int16 / int32 / uint8 / uint16 / uint32 — JS number (safe up
//     to 2^53; the typechecker already range-checks 32-bit integers).
//   int64 / uint64 / usize / isize / uintptr                — JS BigInt
//     so the full range survives without lossy conversion.
//   bool                                                    — JS boolean
//   float32 / float64                                       — JS number
//   string                                                  — JS string
//
// Wider types (struct / array / ref / enum / Task / vtable) land in
// later sub-phases. The interpreter's value layer is intentionally
// kept narrow today so the path from AST → bytecode → result for
// primitive arithmetic is easy to read.

import { typeKinds, getBitWidthOfIntPrim } from "../jsyooptypecheck/types.js";

const BIG_INT_TYPES = new Set(["int64", "uint64", "usize", "isize", "uintptr"]);

// Returns true if a yoop integer-prim type holds its payload as a JS
// BigInt rather than a JS number. Anything narrower than 64-bit fits
// safely into a JS number; 64-bit-and-wider needs BigInt to keep the
// full range.
export function usesBigInt(primName) {
  return BIG_INT_TYPES.has(primName);
}

// Construct a wrapped int value. Caller passes the resolved type and a
// JS number (or BigInt for 64-bit+); we just store the pair.
export function intValue(ty, v) {
  return { ty, v };
}

export function floatValue(ty, v) {
  return { ty, v };
}

export function boolValue(b) {
  return { ty: { kind: typeKinds.prim, name: "bool" }, v: !!b };
}

export function stringValue(s) {
  return { ty: { kind: typeKinds.prim, name: "string" }, v: String(s) };
}

// Normalize a numeric JS value into the canonical representation for
// the given type. For integers narrower than 64 bits, this truncates
// to the bit width to match LLVM's two's-complement semantics. For
// 64-bit-and-wider, ensures BigInt. For floats, no-op.
export function coerceNumeric(ty, raw) {
  if (ty.kind !== typeKinds.prim) return raw;
  const name = ty.name;
  if (name === "bool") return !!raw;
  if (name === "float32" || name === "float64") return Number(raw);
  if (usesBigInt(name)) {
    return typeof raw === "bigint" ? raw : BigInt(raw);
  }
  // Narrower integer: mask + sign-extend. Compute via BigInt so we
  // don't have to special-case JS's modulo-32 bitwise quirks at the
  // 32-bit boundary (`1 << 32 === 1`, so `(1 << 32) - 1 === 0` —
  // would silently truncate every int32 to zero).
  const bits = getBitWidthOfIntPrim(name);
  const big = BigInt.asUintN(bits, BigInt(Math.trunc(Number(raw))));
  if (name.startsWith("uint") || name === "char") {
    return Number(big);
  }
  return Number(BigInt.asIntN(bits, big));
}

// Pretty-print a wrapped value for diagnostics. Not meant for round-trip.
export function formatValue(wrapped) {
  if (wrapped == null) return "<null>";
  const { ty, v } = wrapped;
  if (ty.kind === typeKinds.prim) {
    if (ty.name === "string") return JSON.stringify(v);
    return String(v);
  }
  return `<${ty.kind}>`;
}
