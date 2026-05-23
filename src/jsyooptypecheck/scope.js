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
    // Phase 6.1: language-level kind attached to this binding (e.g. disposable).
    // `kind` (above) is the mutability of the binding (let/const); `kindType`
    // is the orthogonal phase-6.1 kind decl. The name collision is unfortunate
    // but the existing `kind` field is well-established.
    kindType,
    // Phase 6.2: lexical depth at which this binding was declared. Used by the
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

// Phase 10.X: fallible-struct scope-exit enforcement retired. Fallible
// `Result<T, E>`-shaped enums no longer require an `err` observation at
// scope end — they're ordinary values that propagate via `?` or get
// destructured via `switch`. popScope is kept as a no-op stub so callers
// don't need to change.
export function popScope(scope, errors) {
  // intentionally empty
}
