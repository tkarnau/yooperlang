// Phase 6.3: built-in kind keywords `joined` and `pooled`. These are reserved
// and resolved before any user-declared `kind { ... }` decl in the module
// scope. They carry synthetic clauses that aren't expressible in source.

import { KindType } from "./types.js";

function makeBuiltin(name, extra) {
  const k = new KindType(name, "<builtin>");
  k.appliesTo = new Set(["binding"]);
  k.builtin = true;
  Object.assign(k, extra);
  return k;
}

// `joined h = task_call();` — stack-allocated Task<T>, autoJoin (compiler
// inserts `wait` + free_sync_pair before scope exit).
export const JOINED_KIND = makeBuiltin("joined", { autoJoin: true });

// `pooled h = task_call();` — heap-allocated, refcounted Task<T>. Scope-exit
// inserts release; copy/return sites get retain pairs.
export const POOLED_KIND = makeBuiltin("pooled", { refcounted: true });

export function lookupBuiltinKind(name) {
  if (name === "joined") return JOINED_KIND;
  if (name === "pooled") return POOLED_KIND;
  return null;
}
