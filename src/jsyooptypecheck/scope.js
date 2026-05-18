// Lexical scope chain used by the typechecker. Each scope is a Map of
// name -> { type, kind, node, errObserved } with a pointer to its parent
// scope. lookupInScope walks the chain; declareInScope refuses
// redeclarations within a single scope.

import { pushError, formatType } from "./errors.js";
import { isFallible } from "./fallible.js";

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
    errObserved: false,
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
