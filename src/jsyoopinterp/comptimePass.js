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
    for (const decl of mod.moduleInitDecls ?? []) {
      if (decl.comptimeFolded) continue; // already done by a prior pass
      try {
        const fn = lowerExpressionAsFunction(decl.assignment, decl.resolvedType, {
          fnName: `<${mod.id}__${decl.name}__init>`,
        });
        const result = evaluate(fn);
        decl.comptimeValue = result;
        decl.comptimeFolded = true;
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
