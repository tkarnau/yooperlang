// Phase 11.B: comptime pass - opportunistic module-init folding.
//
// Walks each module's `moduleInitDecls`, tries to evaluate each
// initializer expression via lower + interp, and on success stamps:
//
//   decl.comptimeFolded = true
//   decl.comptimeValue  = <wrapped value from interp>
//
// On failure (unsupported AST node, runtime error like divide-by-zero,
// non-whitelisted extern call, etc.) the decl is left alone - codegen
// will route it through the existing runtime `<modid>__module_init`
// function as it does today. This silent-fallback policy is
// intentional for module-init folding: existing programs must not
// suddenly grow build errors from the introduction of comptime.
// Explicit `@precompile` (Phase 11.C) takes the opposite policy -
// failures there are hard errors.

import { ASTNodeKind } from "../contracts.js";
import {
  lowerExpressionAsFunction,
  lowerFunction,
  lowerBlockAsFunction,
} from "./lower.js";
import { evaluate } from "./interp.js";
import { ComptimeError } from "./diagnostics.js";
import { dumpBytecode } from "./bytecode.js";
import { lookupExtern } from "./externWhitelist.js";
// Codegen exports the AST-cloner used to monomorphize a generic
// function body for a specific instantiation. We reuse it verbatim
// at comptime to produce the same substituted AST codegen would
// later emit, then lower that AST into bytecode.
import { cloneAstWithSubstitution } from "../jsyoopcodegen/codegen.js";

// Build a `(calleeName, calleeModuleId, calleeExportName) →
// BytecodeFunction | null` resolver for the comptime lowerer. It
// resolves first within the calling module (function defined in this
// file), then through the typechecker's import metadata when the
// callee was annotated cross-module.
//
// Lowered function bytecode is cached on `fnCache` (keyed by FUNCTION_DECL
// AST node identity) so repeated calls don't re-lower. Generic-instance
// dispatch isn't supported here - the interpreter will return null for
// any callee that needs monomorphization, surfacing as a comptime
// fallback at the call site.
function makeResolvers(modules, currentMod, fnCache, programState) {
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
      // Phase 11.D.9: include task fns in the resolver table. The
      // call-site lowering detects a task call (via the CALL_EXPRESSION's
      // resolvedType being Task<T>) and wraps the body's T return in
      // a Task<T> at the bytecode level - see lower.js's
      // CALL_EXPRESSION case. Generic decls stay excluded since they
      // need monomorphization first.
      if (
        inner?.kind === ASTNodeKind.FUNCTION_DECL &&
        !inner.genericDecl
      ) {
        tbl.set(inner.name, inner);
      }
    }
    fnTablesByMod.set(mod.id, tbl);
    return tbl;
  }

  // Per-module typeName → TYPE_DECL lookup. Lets the trait-method
  // resolver find the AST method decls (the StructType only carries
  // method signatures, not bodies).
  const typeTablesByMod = new Map();
  function typeTableFor(mod) {
    if (typeTablesByMod.has(mod.id)) return typeTablesByMod.get(mod.id);
    const tbl = new Map();
    for (const decl of mod.ast.body) {
      const inner =
        decl.kind === ASTNodeKind.EXPORT_DECL ? decl.decl : decl;
      if (inner?.kind === ASTNodeKind.TYPE_DECL) {
        tbl.set(inner.name, inner);
      }
    }
    typeTablesByMod.set(mod.id, tbl);
    return tbl;
  }

  function traitMethodResolver(structType, traitName, methodName) {
    if (!structType || structType.kind !== "struct") return null;
    const ownerMod = structType.moduleId
      ? modById.get(structType.moduleId)
      : currentMod;
    if (!ownerMod) return null;
    const typeDecl = typeTableFor(ownerMod).get(structType.name);
    if (!typeDecl) return null;
    const methodDecl = (typeDecl.methods ?? []).find(
      (m) =>
        m.name === methodName &&
        (m.implementsTraits ?? []).includes(traitName),
    );
    if (!methodDecl) return null;
    const cached = fnCache.get(methodDecl);
    if (cached instanceof ComptimeError) throw cached;
    if (cached !== undefined) return cached;
    try {
      const bc = lowerFunction(methodDecl, {
        moduleConsts: new Map(),
        fnResolver,
        traitMethodResolver,
      });
      fnCache.set(methodDecl, bc);
      return bc;
    } catch (err) {
      // Phase 11.E.1: re-throw the inner ComptimeError so the
      // call chain's deeper failure surfaces in the @precompile
      // diagnostic + traceback. Cache the error so subsequent
      // lookups of the same method short-circuit.
      if (err instanceof ComptimeError) {
        fnCache.set(methodDecl, err);
      }
      throw err;
    }
  }

  function genericInstanceResolver(inst, programState) {
    // The instance object is the cache key - codegen caches its own
    // `inst.emitted` flag separately, so the comptime-side cache lives
    // in `fnCache` keyed on the inst itself rather than the inst.ast
    // (which is the still-generic decl, shared across instances).
    if (!inst) return null;
    const cached = fnCache.get(inst);
    if (cached instanceof ComptimeError) throw cached;
    if (cached !== undefined) return cached;
    // Reject open instantiations (still contain TypeParamType in any
    // argType). These exist as registry artifacts from
    // generic-calls-generic sites; codegen also skips them.
    if (inst.argTypes?.some((t) => t?.kind === "typeParam")) {
      fnCache.set(inst, null);
      return null;
    }
    // Build the substitution: declId → { paramName → argType }.
    const sub = new Map();
    const inner = new Map();
    const paramNames = inst.ast?.genericDecl?.paramNames ?? [];
    for (let i = 0; i < paramNames.length; i++) {
      inner.set(paramNames[i], inst.argTypes[i]);
    }
    sub.set(inst.declId, inner);
    let cloned;
    try {
      cloned = cloneAstWithSubstitution(inst.ast, sub, programState?.registry ?? null);
    } catch (err) {
      fnCache.set(inst, null);
      return null;
    }
    try {
      const bc = lowerFunction(cloned, {
        moduleConsts: new Map(),
        fnResolver,
        traitMethodResolver,
        genericInstanceResolver: (subInst) =>
          genericInstanceResolver(subInst, programState),
      });
      // Use the monomorphized name so traceback frames disambiguate
      // separate instantiations.
      bc.name = inst.mangledName ?? bc.name;
      fnCache.set(inst, bc);
      return bc;
    } catch (err) {
      if (err instanceof ComptimeError) {
        fnCache.set(inst, err);
      }
      throw err;
    }
  }

  function fnResolver(calleeName, calleeModuleId, calleeExportName) {
    const lookupMod = calleeModuleId
      ? modById.get(calleeModuleId)
      : currentMod;
    const declName = calleeExportName ?? calleeName;
    // First try a user FUNCTION_DECL in the calling module (or the
    // named cross-module callee).
    if (lookupMod) {
      const decl = fnTableFor(lookupMod).get(declName);
      if (decl) {
        const cached = fnCache.get(decl);
        if (cached instanceof ComptimeError) throw cached;
        if (cached !== undefined) return cached;
        try {
          const bc = lowerFunction(decl, {
            moduleConsts: new Map(),
            fnResolver,
            traitMethodResolver,
          });
          fnCache.set(decl, bc);
          return bc;
        } catch (err) {
          if (err instanceof ComptimeError) {
            fnCache.set(decl, err);
          }
          throw err;
        }
      }
    }
    // Fall through to the extern whitelist by name. Cross-module
    // externs share the same whitelist (the impl is keyed on the
    // callee's source name, not its declaring module) - adding a
    // new pure extern is a one-line PR in externWhitelist.js.
    const externEntry = lookupExtern(declName);
    if (externEntry) {
      return { kind: "extern", impl: externEntry.impl, name: declName };
    }
    return null;
  }

  // Also pass `traitMethodResolver` to user-fn lowering so a regular
  // function body that itself contains trait calls (very common -
  // e.g. `Display.to_string(ref x)`) resolves correctly. The
  // `fnResolver` closure references it via lexical scope.
  return {
    fnResolver,
    traitMethodResolver,
    genericInstanceResolver: (inst) => genericInstanceResolver(inst, programState),
  };
}

// Tries to fold every module-init in every module. Returns nothing -
// mutates decls in place. Caller is the driver (yoopiler.js).
//
// `options.onSkip(decl, mod, error)` is an optional callback for
// observability (e.g. a future `--warn-unfolded-inits` flag); the
// default is silent.
export function runComptimePass(modules, options = {}) {
  const onSkip = options.onSkip ?? (() => {});
  const programState = options.programState ?? null;
  const dumpBC = !!options.dumpBC;
  // Per-program function-bytecode cache. Each FUNCTION_DECL gets
  // lowered at most once and reused across every call site that
  // references it (including from inside other folded inits).
  const fnCache = new Map();
  for (const mod of modules) {
    // Module-local symbol table threaded into the lowerer so an init
    // can reference earlier (already-folded) module-level consts in
    // its expression. Source-order ensures forward references are
    // never possible - declared-later names just aren't in the map
    // yet when an earlier decl is being folded. Cross-module
    // references aren't supported in this sub-phase; they fall back
    // through the same silent path as any other unsupported lookup.
    const moduleConsts = new Map();
    const { fnResolver, traitMethodResolver, genericInstanceResolver } =
      makeResolvers(modules, mod, fnCache, programState);
    for (const decl of mod.moduleInitDecls ?? []) {
      if (decl.comptimeFolded) {
        // Earlier pass already folded this one - make it visible to
        // later decls in the same module so they can reference it.
        moduleConsts.set(decl.name, decl.comptimeValue);
        continue;
      }
      try {
        const fn = lowerExpressionAsFunction(decl.assignment, decl.resolvedType, {
          fnName: `<${mod.id}__${decl.name}__init>`,
          moduleConsts,
          fnResolver,
          traitMethodResolver,
          genericInstanceResolver,
        });
        if (dumpBC) {
          process.stderr.write(`\n; --dump-bc: ${decl.name} (init fold)\n`);
          process.stderr.write(dumpBytecode(fn) + "\n");
        }
        const result = evaluate(fn);
        decl.comptimeValue = result;
        decl.comptimeFolded = true;
        moduleConsts.set(decl.name, result);
      } catch (err) {
        if (err instanceof ComptimeError) {
          // Stash the error on the decl so the `@precompile`
          // attribute handler can read its traceback when surfacing
          // the failure as a hard build error. The opportunistic
          // fold path discards this and silently falls back, but
          // recording it costs nothing.
          decl.comptimeFoldError = err;
          onSkip(decl, mod, err);
          continue;
        }
        // Non-ComptimeError exceptions are bugs in the interpreter;
        // re-throw so the driver surfaces them rather than silently
        // suppressing a crash.
        throw err;
      }
    }

    // Phase 11.D.18: now run any `@precompile { ... }` block-form
    // attributes in this module. Each block executes with read +
    // write access to module-level state via MODULE_LOAD/STORE; the
    // initial value of each module-level binding comes from its
    // already-folded init (above). After the block runs, any
    // binding whose final value differs from the initial value
    // (or that didn't have a comptime-folded init) gets its decl
    // stamped with comptimeFolded + comptimeValue so codegen
    // emits the result as the LLVM @global initial value and
    // skips the runtime module-init path.
    const declBySym = new Map();
    for (const d of mod.moduleInitDecls ?? []) {
      declBySym.set(`${mod.id}__${d.name}`, d);
    }
    // Initial moduleState: every already-folded decl's value,
    // keyed by mangled sym. Reads of unfolded module decls fail
    // with a clear ComptimeError at MODULE_LOAD time.
    const moduleState = new Map();
    for (const d of mod.moduleInitDecls ?? []) {
      if (d.comptimeFolded) {
        moduleState.set(`${mod.id}__${d.name}`, d.comptimeValue);
      }
    }
    const moduleStateNames = new Set(declBySym.keys());
    for (const decl of mod.ast.body) {
      if (
        decl.kind !== ASTNodeKind.ATTRIBUTE ||
        decl.name !== "precompile"
      ) {
        continue;
      }
      const tgt = decl.target;
      if (!tgt || tgt.kind !== ASTNodeKind.BLOCK) continue;
      try {
        const fn = lowerBlockAsFunction(tgt, {
          fnName: `<${mod.id}__precompile_block_at_${decl.sourceLoc?.line ?? "?"}>`,
          moduleConsts,
          fnResolver,
          traitMethodResolver,
          genericInstanceResolver,
          moduleStateNames,
        });
        if (dumpBC) {
          process.stderr.write(`\n; --dump-bc: @precompile block (line ${decl.sourceLoc?.line ?? "?"})\n`);
          process.stderr.write(dumpBytecode(fn) + "\n");
        }
        evaluate(fn, { moduleState });
        decl.blockExecuted = true;
      } catch (err) {
        if (err instanceof ComptimeError) {
          // Stash the error on the ATTRIBUTE node so the registry's
          // comptimePhase can surface a hard build error with the
          // full traceback. Hard error semantics here match the
          // `@precompile const` form: an explicit comptime
          // commitment that failed is never silently dropped.
          decl.blockFoldError = err;
          continue;
        }
        throw err;
      }
    }
    // Commit the block-form's writes back to their owning decls so
    // codegen picks them up as LLVM @global initial values.
    for (const [sym, val] of moduleState) {
      const d = declBySym.get(sym);
      if (!d) continue;
      // If a value differs from the pre-block folded value, the
      // block wrote to it. If the decl wasn't folded before but is
      // now, that also means the block wrote to it.
      if (!d.comptimeFolded || d.comptimeValue !== val) {
        d.comptimeValue = val;
        d.comptimeFolded = true;
        // Clear any stale fold-error from before the block wrote.
        d.comptimeFoldError = null;
        moduleConsts.set(d.name, val);
      }
    }
  }
  // Phase 11.E.2: also dump every callee bytecode the fold pulled
  // into the cache. Order is "discovery order" (insertion order of
  // the Map). Skipped error-cache entries so the dump shows only
  // bytecode that actually exists.
  if (dumpBC) {
    for (const bc of fnCache.values()) {
      if (bc && !(bc instanceof ComptimeError)) {
        process.stderr.write(`\n; --dump-bc: ${bc.name}\n`);
        process.stderr.write(dumpBytecode(bc) + "\n");
      }
    }
  }
}
