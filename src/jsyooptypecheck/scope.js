// Lexical scope chain used by the typechecker. Each scope is a Map of
// name -> { type, kind, node } with a pointer to its parent scope.
// lookupInScope walks the chain; declareInScope refuses redeclarations
// within a single scope.

import { pushError } from "./errors.js";

export function pushScope(parent) {
  return { parent, bindings: new Map(), depth: (parent?.depth ?? -1) + 1 };
}

export function declareInScope(scope, name, type, kind, node, errors, kindType = null) {
  if (scope.bindings.has(name)) {
    pushError(errors, node, `redeclaration of "${name}"`);
    return;
  }
  scope.bindings.set(name, {
    type,
    kind,
    node,
    // Language-level kind attached to this binding (e.g. disposable).
    // `kind` (above) is the mutability of the binding (let/const); `kindType`
    // is the orthogonal kind decl. The name collision is unfortunate
    // but the existing `kind` field is well-established.
    kindType,
    // Lexical depth at which this binding was declared. Used by the
    // escape-analysis walker to detect field-store escapes into longer-lived structs.
    scopeDepth: scope.depth,
  });
}

export function lookupInScope(scope, name) {
  let s = scope;
  while (s) {
    if (s.bindings.has(name)) {
      return s.bindings.get(name);
    }
    s = s.parent;
  }
  return null;
}

// Scope exit has no fallible-value obligations. `Result<T, E>`-shaped enums
// are ordinary values that propagate via `?` or get destructured via
// `switch`, so there is no `err` observation to enforce at scope end.
// popScope is a no-op stub that callers can keep calling.
export function popScope(scope, errors) {
  // intentionally empty
}
