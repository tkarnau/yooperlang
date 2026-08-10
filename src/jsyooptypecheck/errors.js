// Error collection + type-formatting helpers for the typechecker.
//
// pushError / pushWarning append to a diagnostics array (the typechecker's
// accumulating list); formatType produces a short human-readable rendering of
// a Type for use in error messages.

import { typeKinds } from "./types.js";

// Diagnostic severity. Both severities ride the SAME array during a check -
// the moduleId/srcPath stamping and every `ctx.errors` call site are shared,
// and threading a second array to every push site would be a lot of plumbing
// for one field. `typecheckProgram` splits them apart in its return value, so
// no existing `errors.length === 0` gate changes meaning.
export const Severity = {
  error: "error",
  warning: "warning",
};

// `locSource` may be either an AST node (we read its `sourceLoc`) or a raw
// sourceLoc object `{ pos, line, column, length? }`. Use the raw form when
// the offending token is finer-grained than the enclosing node - e.g. the
// field identifier of a FIELD_ACCESS expression.
export function pushError(errors, locSource, message) {
  errors.push({ message, sourceLoc: locOf(locSource), severity: Severity.error });
}

// A warning never fails the build. `code` is a stable kebab-case identifier
// (e.g. "unreachable-code") that survives into the LSP diagnostic, where it
// both shows in the Problems panel and selects the rendering: the LSP server
// maps a known code onto a DiagnosticTag so dead code is DIMMED in the
// editor rather than underlined.
export function pushWarning(errors, locSource, message, code) {
  errors.push({
    message,
    sourceLoc: locOf(locSource),
    severity: Severity.warning,
    code,
  });
}

function locOf(locSource) {
  if (locSource && typeof locSource === "object") {
    if (locSource.sourceLoc) return locSource.sourceLoc;
    if ("pos" in locSource) return locSource;
  }
  return undefined;
}

export function formatType(t) {
  if (!t) return "null";
  switch (t.kind) {
    case typeKinds.prim:
      return t.name;
    case typeKinds.struct: {
      // Phase 7.1: a generic instantiation has a mangled name like
      // `Box__int32`; the original decl name + concrete args are stashed on
      // `genericInstance`. Render the source-level form for diagnostics.
      if (t.genericInstance) {
        const args = t.genericInstance.args.map(formatType).join(", ");
        const baseName = t.name.split("__")[0];
        return `struct ${baseName}<${args}>`;
      }
      return `struct ${t.name}`;
    }
    case typeKinds.ref:
      return `ref ${formatType(t.inner)}`;
    case typeKinds.array:
      return `${formatType(t.elem)}[]`;
    case typeKinds.func:
      // A `ref` param's own type IS the RefType (`isRef` is a redundant
      // marker kept for the decl-site checks), so prefixing "ref " here
      // rendered `ref m: Box` as `ref ref struct Box` and made a plain
      // signature mismatch read like a double-reference bug.
      return `(${t.params.map((p) => formatType(p.type)).join(", ")}) -> ${formatType(t.returnType)}`;
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
    case typeKinds.variant:
      if (t.genericInstance) {
        const args = t.genericInstance.args.map(formatType).join(", ");
        // Recover the source decl name from the mangled `Name__a__b__...`.
        // The genericInstance.declId is `<mod>__variant__<Name>`; if available,
        // we'd prefer that - but we only have the mangled t.name here, so
        // strip the trailing `__arg`s.
        const baseName = t.name.split("__")[0];
        return `variant ${baseName}<${args}>`;
      }
      return `variant ${t.name}`;
    case typeKinds.union:
      return `union ${t.name}`;
    case typeKinds.valueEnum:
      return `enum ${t.name}`;
    case typeKinds.typeParam:
      return t.name;
    case typeKinds.unsafePtr:
      // Yoopstore-papercut #3: null pointee is the opaque form.
      return t.pointee === null
        ? `unsafe_ptr`
        : `unsafe_ptr<${formatType(t.pointee)}>`;
    case typeKinds.untypedNull:
      return "null";
    case typeKinds.functionPointer:
      return `(${t.params.map(formatType).join(", ")}) => ${formatType(t.returnType)}`;
    case typeKinds.vtable:
      return `vtable ${t.name}`;
    case typeKinds.namespace:
      return "namespace";
    default:
      return `unknown kind ${t.kind}`;
  }
}
