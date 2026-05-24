// Phase 11.B: comptime pass — opportunistic module-init folding.
//
// Walks each module's `moduleInitDecls`, tries to evaluate each
// initializer expression via lower + interp, and on success stamps:
//
//   decl.comptimeFolded = true
//   decl.comptimeValue  = <wrapped value from interp>
//
// On failure (unsupported AST node, runtime error like divide-by-zero,
// non-whitelisted extern call, etc.) the decl is left alone — codegen
// will route it through the existing runtime `<modid>__module_init`
// function as it does today. This silent-fallback policy is
// intentional for module-init folding: existing programs must not
// suddenly grow build errors from the introduction of comptime.
// Explicit `@precompile` (Phase 11.C) takes the opposite policy —
// failures there are hard errors.

import { lowerExpressionAsFunction } from "./lower.js";
import { evaluate } from "./interp.js";
import { ComptimeError } from "./diagnostics.js";

// Tries to fold every module-init in every module. Returns nothing —
// mutates decls in place. Caller is the driver (yoopiler.js).
//
// `options.onSkip(decl, mod, error)` is an optional callback for
// observability (e.g. a future `--warn-unfolded-inits` flag); the
// default is silent.
export function runComptimePass(modules, options = {}) {
  const onSkip = options.onSkip ?? (() => {});
  for (const mod of modules) {
    // Module-local symbol table threaded into the lowerer so an init
    // can reference earlier (already-folded) module-level consts in
    // its expression. Source-order ensures forward references are
    // never possible — declared-later names just aren't in the map
    // yet when an earlier decl is being folded. Cross-module
    // references aren't supported in this sub-phase; they fall back
    // through the same silent path as any other unsupported lookup.
    const moduleConsts = new Map();
    for (const decl of mod.moduleInitDecls ?? []) {
      if (decl.comptimeFolded) {
        // Earlier pass already folded this one — make it visible to
        // later decls in the same module so they can reference it.
        moduleConsts.set(decl.name, decl.comptimeValue);
        continue;
      }
      try {
        const fn = lowerExpressionAsFunction(decl.assignment, decl.resolvedType, {
          fnName: `<${mod.id}__${decl.name}__init>`,
          moduleConsts,
        });
        const result = evaluate(fn);
        decl.comptimeValue = result;
        decl.comptimeFolded = true;
        moduleConsts.set(decl.name, result);
      } catch (err) {
        if (err instanceof ComptimeError) {
          onSkip(decl, mod, err);
          continue;
        }
        // Non-ComptimeError exceptions are bugs in the interpreter;
        // re-throw so the driver surfaces them rather than silently
        // suppressing a crash.
        throw err;
      }
    }
  }
}
