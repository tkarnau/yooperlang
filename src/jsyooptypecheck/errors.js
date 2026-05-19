// Error collection + type-formatting helpers for the typechecker.
//
// pushError appends to an errors array (the typechecker's accumulating
// list); formatType produces a short human-readable rendering of a Type
// for use in error messages.

import { typeKinds } from "./types.js";

export function pushError(errors, node, message) {
  errors.push({
    message,
    sourceLoc: node?.sourceLoc,
  });
}

export function formatType(t) {
  if (!t) return "null";
  switch (t.kind) {
    case typeKinds.prim:
      return t.name;
    case typeKinds.struct:
      return `struct ${t.name}`;
    case typeKinds.ref:
      return `ref ${formatType(t.inner)}`;
    case typeKinds.array:
      return `array ${formatType(t.elem)}`;
    case typeKinds.func:
      return `(${t.params.map(formatType).join(", ")}) -> ${formatType(t.returnType)}`;
    case typeKinds.void:
      return "void";
    case typeKinds.untypedInt:
      return "untyped int";
    case typeKinds.untypedFloat:
      return "untyped float";
    case typeKinds.error:
      return "error";
    case typeKinds.trait:
      return `trait ${t.name}`;
    case typeKinds.kind:
      return `kind ${t.name}`;
    case typeKinds.task:
      return `Task<${formatType(t.resultType)}>`;
    default:
      return `unknown kind ${t.kind}`;
  }
}
