// Error collection + type-formatting helpers for the typechecker.
//
// pushError appends to an errors array (the typechecker's accumulating
// list); formatType produces a short human-readable rendering of a Type
// for use in error messages.

import { typeKinds } from "./types.js";

// `locSource` may be either an AST node (we read its `sourceLoc`) or a raw
// sourceLoc object `{ pos, line, column, length? }`. Use the raw form when
// the offending token is finer-grained than the enclosing node - e.g. the
// field identifier of a FIELD_ACCESS expression.
export function pushError(errors, locSource, message) {
  let sourceLoc;
  if (locSource && typeof locSource === "object") {
    if (locSource.sourceLoc) {
      sourceLoc = locSource.sourceLoc;
    } else if ("pos" in locSource) {
      sourceLoc = locSource;
    }
  }
  errors.push({ message, sourceLoc });
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
      return `(${t.params.map((p) => `${p.isRef ? "ref " : ""}${formatType(p.type)}`).join(", ")}) -> ${formatType(t.returnType)}`;
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
    case typeKinds.enum:
      if (t.genericInstance) {
        const args = t.genericInstance.args.map(formatType).join(", ");
        // Recover the source decl name from the mangled `Name__a__b__...`.
        // The genericInstance.declId is `<mod>__enum__<Name>`; if available,
        // we'd prefer that - but we only have the mangled t.name here, so
        // strip the trailing `__arg`s.
        const baseName = t.name.split("__")[0];
        return `enum ${baseName}<${args}>`;
      }
      return `enum ${t.name}`;
    case typeKinds.union:
      return `union ${t.name}`;
    case typeKinds.typeParam:
      return t.name;
    case typeKinds.unsafePtr:
      return `unsafe_ptr<${formatType(t.pointee)}>`;
    case typeKinds.untypedNull:
      return "null";
    case typeKinds.functionPointer:
      return `(${t.params.map(formatType).join(", ")}) => ${formatType(t.returnType)}`;
    case typeKinds.vtable:
      return `vtable ${t.name}`;
    default:
      return `unknown kind ${t.kind}`;
  }
}
