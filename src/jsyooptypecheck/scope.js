// Lexical scope chain used by the typechecker. Each scope is a Map of
// name -> { type, kind } with a pointer to its parent scope. lookupInScope
// walks the chain; declareInScope refuses redeclarations within a single
// scope.

import { pushError } from "./errors.js";

export function pushScope(parent) {
  return { parent, bindings: new Map() };
}

export function declareInScope(scope, name, type, kind, node, errors) {
  if (scope.bindings.has(name)) {
    pushError(errors, node, `redeclaration of "${name}"`);
    return;
  }
  scope.bindings.set(name, { type, kind });
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
