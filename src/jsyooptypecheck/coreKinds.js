// The concurrency core kinds, as declared in std/core/kinds.yoop.
//
// This file used to be builtinKinds.js, and it CONSTRUCTED the kinds:
// three hardcoded objects carrying "synthetic clauses that aren't
// expressible in source" (its own words). `refcounted: true` was a bare
// boolean naming nothing, and codegen simply knew it meant
// yoop_task_retain / yoop_task_release.
//
// Now it is a registry. `std/core/kinds.yoop` declares `task`, `async`,
// `joined`, `pooled` and `Task` as ordinary `kind { ... }` decls, the
// typechecker captures them during pass A, and this holds the resolved
// KindTypes so the rest of the compiler can reach them by name. The
// behavior comes from their clauses; the compiler only asserts they exist
// with the shape it depends on (REQUIRED_CORE_KINDS in typecheck.js).
//
// See plans/kinds-in-std.md.

// Reset at the start of every typecheckProgram run - a single process
// compiles many programs during the test suite, and each gets its own
// std module instances (kinds compare by reference).
let coreKinds = new Map();

export function setCoreKinds(resolved) {
  coreKinds = resolved ?? new Map();
}

// The resolved KindType for a core kind, or null when std/core/kinds.yoop
// is not in the graph. Null is a legitimate answer: the legacy
// single-module typecheck path has no module graph and so no std at all,
// and it does not support tasks either.
export function lookupCoreKind(name) {
  return coreKinds.get(name) ?? null;
}

// True when `kt` is a kind whose values are reference counted. Replaces the
// old `kindType.builtin && kindType.refcounted` test - "builtin" is no
// longer a meaningful distinction now that these are declared like anything
// else, and any user kind carrying `refcounted` gets the same treatment.
export function isRefcountedKind(kt) {
  return !!kt && kt.refcounted !== null && kt.refcounted !== undefined;
}

// The traits `Task<T>` satisfies. This is the irreducible built-in part of
// the design: `Task<T>` is a compiler type, not a nominal struct, so it
// cannot carry an `implements` list - but the core kinds legitimately
// `require` these, and the runtime calls have to come from somewhere.
//
// The impl bodies are compiler-provided: `retain`/`release` lower to
// yoop_task_retain / yoop_task_release, `join` to yoop_task_wait. Everything
// ABOUT the contract (which methods, called when, on what) is declared in
// std/core/kinds.yoop; only the bodies live here.
const TASK_PROVIDED_TRAITS = new Set(["Shared", "Joinable"]);

// True when a Task<T> value satisfies every trait `kt` requires.
export function taskSatisfiesKind(kt) {
  if (!kt) return false;
  const required = kt.requires ?? [];
  if (required.length === 0) return false;
  return required.every((t) => TASK_PROVIDED_TRAITS.has(t?.name));
}
