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

import { ASTNodeKind } from "../contracts.js";
import { lowerExpressionAsFunction, lowerFunction } from "./lower.js";
import { evaluate } from "./interp.js";
import { ComptimeError } from "./diagnostics.js";
import { lookupExtern } from "./externWhitelist.js";

// Build a `(calleeName, calleeModuleId, calleeExportName) →
// BytecodeFunction | null` resolver for the comptime lowerer. It
// resolves first within the calling module (function defined in this
// file), then through the typechecker's import metadata when the
// callee was annotated cross-module.
//
// Lowered function bytecode is cached on `fnCache` (keyed by FUNCTION_DECL
// AST node identity) so repeated calls don't re-lower. Generic-instance
// dispatch isn't supported here — the interpreter will return null for
// any callee that needs monomorphization, surfacing as a comptime
// fallback at the call site.
function makeFnResolver(modules, currentMod, fnCache) {
  const modById = new Map(modules.map((m) => [m.id, m]));

  // Per-module function-name → FUNCTION_DECL lookup. Built lazily on
  // first use to keep startup cheap.
  const fnTablesByMod = new Map();
  function fnTableFor(mod) {
    if (fnTablesByMod.has(mod.id)) return fnTablesByMod.get(mod.id);
    const tbl = new Map();
    for (const decl of mod.ast.body) {
      // EXPORT_DECL wraps the inner decl; EXPORT_C_FUNCTION_DECL has
      // a .fn slot pointing at the actual FUNCTION_DECL. Walk both.
      const inner =
        decl.kind === ASTNodeKind.EXPORT_DECL ? decl.decl :
        decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL ? decl.fn :
        decl;
      if (
        inner?.kind === ASTNodeKind.FUNCTION_DECL &&
        !inner.genericDecl &&
        !inner.isTask
      ) {
        tbl.set(inner.name, inner);
      }
    }
    fnTablesByMod.set(mod.id, tbl);
    return tbl;
  }

  return function fnResolver(calleeName, calleeModuleId, calleeExportName) {
    const lookupMod = calleeModuleId
      ? modById.get(calleeModuleId)
      : currentMod;
    const declName = calleeExportName ?? calleeName;
    // First try a user FUNCTION_DECL in the calling module (or the
    // named cross-module callee).
    if (lookupMod) {
      const decl = fnTableFor(lookupMod).get(declName);
      if (decl) {
        if (fnCache.has(decl)) return fnCache.get(decl);
        try {
          const bc = lowerFunction(decl, {
            moduleConsts: new Map(),
            fnResolver,
          });
          fnCache.set(decl, bc);
          return bc;
        } catch (err) {
          if (err instanceof ComptimeError) {
            fnCache.set(decl, null);
            return null;
          }
          throw err;
        }
      }
    }
    // Fall through to the extern whitelist by name. Cross-module
    // externs share the same whitelist (the impl is keyed on the
    // callee's source name, not its declaring module) — adding a
    // new pure extern is a one-line PR in externWhitelist.js.
    const externEntry = lookupExtern(declName);
    if (externEntry) {
      return { kind: "extern", impl: externEntry.impl, name: declName };
    }
    return null;
  };
}

// Tries to fold every module-init in every module. Returns nothing —
// mutates decls in place. Caller is the driver (yoopiler.js).
//
// `options.onSkip(decl, mod, error)` is an optional callback for
// observability (e.g. a future `--warn-unfolded-inits` flag); the
// default is silent.
export function runComptimePass(modules, options = {}) {
  const onSkip = options.onSkip ?? (() => {});
  // Per-program function-bytecode cache. Each FUNCTION_DECL gets
  // lowered at most once and reused across every call site that
  // references it (including from inside other folded inits).
  const fnCache = new Map();
  for (const mod of modules) {
    // Module-local symbol table threaded into the lowerer so an init
    // can reference earlier (already-folded) module-level consts in
    // its expression. Source-order ensures forward references are
    // never possible — declared-later names just aren't in the map
    // yet when an earlier decl is being folded. Cross-module
    // references aren't supported in this sub-phase; they fall back
    // through the same silent path as any other unsupported lookup.
    const moduleConsts = new Map();
    const fnResolver = makeFnResolver(modules, mod, fnCache);
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
          fnResolver,
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
