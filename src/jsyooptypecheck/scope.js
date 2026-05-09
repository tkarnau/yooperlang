// Lexical scope chain used by the typechecker. Each scope is a Map of
// name -> { type, kind, node, errObserved } with a pointer to its parent
// scope. lookupInScope walks the chain; declareInScope refuses
// redeclarations within a single scope.

import { pushError, formatType } from "./errors.js";
import { isFallible } from "./fallible.js";

export function pushScope(parent) {
  return { parent, bindings: new Map() };
}

export function declareInScope(scope, name, type, kind, node, errors) {
  if (scope.bindings.has(name)) {
    pushError(errors, node, `redeclaration of "${name}"`);
    return;
  }
  scope.bindings.set(name, {
    type,
    kind,
    node,
    errObserved: false,
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

// Called when a scope ends. Any binding whose type is fallible and whose
// `err` field has not been observed (read directly, destructured, propagated
// with `?`, or discarded) is a compile error. The discard kind label means
// the binding was synthesized for a `_ = expr;` and is exempt.
export function popScope(scope, errors) {
  for (const [name, binding] of scope.bindings) {
    if (binding.kind === "discard") continue;
    if (!isFallible(binding.type)) continue;
    if (binding.errObserved) continue;
    pushError(
      errors,
      binding.node,
      `fallible binding "${name}" of type ${formatType(binding.type)} must observe its 'err' field before scope exit (read .err, destructure with err, propagate with '?', or discard with '_ = ...')`,
    );
  }
}
