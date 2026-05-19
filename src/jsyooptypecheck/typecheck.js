// type checking standalone pass
// intended to be after parsing and before codegen
//
// this file is the orchestration layer:
//   1. collect function signatures and struct shells (pre-pass)
//   2. resolve struct field types (second pre-pass; allows mutual reference)
//   3. for each function, hand off to validateFunction in checkStatement.js
//
// per-AST-kind logic lives in sibling files (checkExpr.js, checkStatement.js,
// coerce.js, scope.js, errors.js, recursiveStruct.js). the pure helpers are
// re-exported here so callers can import them from a single entry point.

import { parse } from "../jsyooparser/parser.js";
import { ASTNodeKind } from "../contracts.js";
import {
  ArrayType,
  ErrorType,
  FuncType,
  KindApplication,
  KindType,
  RefType,
  StructType,
  TaskType,
  VoidType,
  primTypeFromName,
  resolveTypeAnnotation,
  formatAnnotation,
  TraitType,
  TraitSelfPlaceholder,
  typeKinds,
  typesEqual,
} from "./types.js";
import { formatType, pushError } from "./errors.js";
import { coerceLiteralToType, isAssignable, unifyArith } from "./coerce.js";
import { detectRecursiveField } from "./recursiveStruct.js";
import { validateFunction, validateMethod } from "./checkStatement.js";
import { resolveImports } from "./imports.js";
import { runKindCheck } from "./kindCheck.js";
import { TASK_KIND } from "./builtinKinds.js";

export { formatType, coerceLiteralToType, isAssignable, unifyArith };

// ─── helpers ─────────────────────────────────────────────────────────────────

// If decl is an EXPORT_DECL wrapper, unwrap to the inner decl; otherwise
// return the decl itself.
function innerDecl(decl) {
  if (decl.kind === ASTNodeKind.EXPORT_DECL) return decl.decl;
  if (decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL) return decl.fn;
  return decl;
}

// Resolve a type name within a multi-module context: checks local structs,
// primitive types, or structs imported via named imports.
function resolveTypeInModule(name, modId, moduleEnv) {
  const { structTable, importedNames } = moduleEnv.get(modId);
  const local = structTable.get(name);
  // If local is a fully-resolved struct (fields !== null), use it.
  // If it's a shell (fields === null, from pass A / import copy), fall through
  // to importedNames so pass-C-resolved source versions are preferred.
  if (local && local.fields !== null) return local;
  const prim = primTypeFromName(name);
  if (prim) return prim;
  const imp = importedNames.get(name);
  if (imp && imp.kind === "type") {
    const srcEnv = moduleEnv.get(imp.fromModuleId);
    const resolved = srcEnv?.structTable.get(imp.exportName);
    if (resolved) return resolved;
  }
  return local ?? null;
}

// Resolve a structured type annotation within a multi-module context.
function resolveTypeAnnotationInModule(annot, modId, moduleEnv, ctx) {
  if (!annot) return null;
  if (annot.kind === "typeName") {
    return resolveTypeInModule(annot.name, modId, moduleEnv);
  }
  if (annot.kind === "refType") {
    const inner = resolveTypeAnnotationInModule(annot.inner, modId, moduleEnv, ctx);
    if (!inner) return null;
    return RefType(inner);
  }
  if (annot.kind === "arrayType") {
    const elem = resolveTypeAnnotationInModule(annot.elem, modId, moduleEnv, ctx);
    if (!elem) return null;
    return ArrayType(elem);
  }
  if (annot.kind === "taskType") {
    const inner = resolveTypeAnnotationInModule(annot.inner, modId, moduleEnv, ctx);
    if (!inner) return null;
    return TaskType(inner);
  }
  if (annot.kind === "selfType") {
    if (!ctx?.selfType) {
      throw new Error("resolveTypeAnnotationInModule: 'self' used outside trait/method context");
    }
    return ctx.selfType;
  }
  throw new Error(
    `resolveTypeAnnotationInModule: unknown annotation kind "${annot.kind}"`,
  );
}

// ─── propagation helpers (phase 6.4) ────────────────────────────────────────

// Return the list of KindType instances that a struct field carries.
// A field carries a kind iff:
//   - its `kindType` (resolved from `kindPrefix`) is set, OR
//   - its type is `Task<T>` (which inherently carries the `Task` builtin), OR
//   - its type is itself a struct that propagates kinds (transitive — every
//     kind the inner struct propagates is one this field carries).
// Phase 6.5: propagatedKinds entries are KindApplications; we still match
// by KindType identity (args don't affect propagation matching).
export function fieldCarriedKinds(field) {
  const out = [];
  if (field.kindType) out.push(field.kindType);
  if (field.type?.kind === "task") {
    if (!out.includes(TASK_KIND)) out.push(TASK_KIND);
  }
  if (field.type?.kind === "struct" && field.type.propagatedKinds?.length) {
    for (const a of field.type.propagatedKinds) {
      const k = a.kindType ?? a; // tolerate legacy bare-KindType during transition
      if (!out.includes(k)) out.push(k);
    }
  }
  return out;
}

// ─── trait helpers ───────────────────────────────────────────────────────────

function lookupImportedTrait(name, mod, moduleEnv) {
  const env = moduleEnv.get(mod.id);
  const imp = env.importedNames.get(name);
  if (!imp || imp.kind !== "trait") return null;
  const srcEnv = moduleEnv.get(imp.fromModuleId);
  return srcEnv?.traitTable.get(imp.exportName) ?? null;
}

function substituteSelfInSig(traitSig, thisStruct) {
  const params = traitSig.params.map((p) => {
    if (p.type.kind === typeKinds.ref && p.type.inner === TraitSelfPlaceholder) {
      return { ...p, type: RefType(thisStruct) };
    }
    return p;
  });
  return FuncType(params, traitSig.returnType, false);
}

function sigsEqual(a, b) {
  if (a.params.length !== b.params.length) return false;
  for (let i = 0; i < a.params.length; i++) {
    if (!typesEqual(a.params[i].type, b.params[i].type)) return false;
  }
  return typesEqual(a.returnType, b.returnType);
}

function formatSig(sig) {
  const params = sig.params.map((p) => `${p.isRef ? "ref " : ""}${formatType(p.type)}`).join(", ");
  return `(${params}): ${formatType(sig.returnType)}`;
}

function validateImplBlock(typeDecl, mod, moduleEnv, errors) {
  const env = moduleEnv.get(mod.id);
  const structShell = env.structTable.get(typeDecl.name);
  if (!structShell) return;

  // Step 1: resolve trait names.
  const resolvedImplements = [];
  for (const traitName of typeDecl.implements) {
    const trait = env.traitTable.get(traitName) ?? lookupImportedTrait(traitName, mod, moduleEnv);
    if (!trait) {
      errors.push({ message: `type "${typeDecl.name}" implements unknown trait "${traitName}"`, sourceLoc: typeDecl.sourceLoc });
      continue;
    }
    resolvedImplements.push(trait);
  }

  const fields = structShell.fields ?? [];

  // Step 2: substitute self in each trait's required methods.
  const requiredMethods = new Map();
  for (const trait of resolvedImplements) {
    for (const [methodName, traitSig] of trait.methods) {
      if (requiredMethods.has(methodName) && requiredMethods.get(methodName).traitName !== trait.name) {
        errors.push({
          message: `type "${typeDecl.name}" cannot implement both "${requiredMethods.get(methodName).traitName}" and "${trait.name}" — both require method "${methodName}"`,
          sourceLoc: typeDecl.sourceLoc,
        });
        continue;
      }
      requiredMethods.set(methodName, { traitName: trait.name, sig: substituteSelfInSig(traitSig, structShell) });
    }
  }

  // Step 3: match impl methods to required.
  const implMethodNames = new Set();
  const resolvedMethods = new Map();
  for (const methodDecl of typeDecl.methods ?? []) {
    if (implMethodNames.has(methodDecl.name)) {
      errors.push({ message: `duplicate method "${methodDecl.name}" in type "${typeDecl.name}"`, sourceLoc: methodDecl.sourceLoc });
      continue;
    }
    implMethodNames.add(methodDecl.name);

    if (env.localSymbols.has(methodDecl.name)) {
      errors.push({
        message: `method "${methodDecl.name}" on type "${typeDecl.name}" collides with module-level function "${methodDecl.name}" — rename one`,
        sourceLoc: methodDecl.sourceLoc,
      });
    }

    const required = requiredMethods.get(methodDecl.name);
    if (!required) {
      errors.push({
        message: `type "${typeDecl.name}" declares method "${methodDecl.name}", but no implemented trait requires it`,
        sourceLoc: methodDecl.sourceLoc,
      });
      continue;
    }
    methodDecl.implementsTrait = required.traitName;

    const ctxForMethod = { selfType: structShell };
    const params = methodDecl.params.map((p) => {
      const baseType = resolveTypeAnnotationInModule(p.typeAnnotation, mod.id, moduleEnv, ctxForMethod) ?? ErrorType();
      const t = p.isRef ? RefType(baseType) : baseType;
      p.resolvedType = t;
      return { name: p.name, type: t, isRef: p.isRef ?? false };
    });
    const returnType = resolveTypeAnnotationInModule(methodDecl.returnTypeAnnotation, mod.id, moduleEnv, ctxForMethod) ?? ErrorType();
    const implSig = FuncType(params, returnType, false);

    if (!sigsEqual(implSig, required.sig)) {
      errors.push({
        message: `method "${methodDecl.name}" on type "${typeDecl.name}" has signature ${formatSig(implSig)}, expected ${formatSig(required.sig)} from trait "${required.traitName}"`,
        sourceLoc: methodDecl.sourceLoc,
      });
      continue;
    }
    methodDecl.resolvedFuncType = implSig;
    methodDecl.resolvedType = returnType;
    methodDecl.mangledSymbol = `${mod.id}__${typeDecl.name}__${methodDecl.name}`;
    resolvedMethods.set(methodDecl.name, implSig);
  }

  // Step 4: every required method must be implemented.
  for (const [methodName, required] of requiredMethods) {
    if (!resolvedMethods.has(methodName)) {
      errors.push({
        message: `type "${typeDecl.name}" implements trait "${required.traitName}" but is missing method "${methodName}" with signature ${formatSig(required.sig)}`,
        sourceLoc: typeDecl.sourceLoc,
      });
    }
  }

  // Step 5: rebuild StructType with implements + methods set.
  // Phase 6.5: preserve propagatedKinds + kindApplication from the C-pass type.
  const prev = typeDecl.resolvedType;
  const fullStruct = StructType(
    typeDecl.name,
    fields,
    mod.id,
    resolvedImplements,
    resolvedMethods,
    prev?.propagatedKinds ?? [],
    prev?.kindApplication ?? null,
  );
  typeDecl.resolvedType = fullStruct;
  for (const m of typeDecl.methods ?? []) {
    m.implementingType = fullStruct;
  }
  env.structTable.set(typeDecl.name, fullStruct);
}

// ─── kind clause resolution (phase 6.1) ──────────────────────────────────────

// Pass C.2: walk each kind decl and resolve its clauses against the module's
// trait table. `requires` clauses populate kt.requires; `mustCall` clauses
// resolve their method name against the union of required-trait method sets.
function resolveKindClauses(mod, moduleEnv, errors) {
  const env = moduleEnv.get(mod.id);
  for (const decl of mod.ast.body) {
    const d = innerDecl(decl);
    if (d.kind !== ASTNodeKind.KIND_DECL) continue;
    const kt = d.resolvedKindType;
    if (!kt) continue; // rejected in pass A
    // Composition decls have no clauses — they get merged in C.2b.
    if (d.composition) continue;
    let mustCallSeen = false;
    let ownsBlockSeen = false;
    let mustNotEscapeSeen = false;
    let mustNotShareSeen = false;
    let layoutSeen = false;
    let mustCallClause = null;
    for (const c of d.clauses) {
      switch (c.kind) {
        case ASTNodeKind.KIND_APPLIES_TO_CLAUSE:
          // Store all sites from the multi-site list (parser validated at least one).
          for (const s of c.sites) kt.appliesTo.add(s);
          break;
        case ASTNodeKind.KIND_REQUIRES_CLAUSE: {
          const trait =
            env.traitTable.get(c.traitName) ??
            lookupImportedTrait(c.traitName, mod, moduleEnv);
          if (!trait) {
            pushError(errors, c, `unknown trait '${c.traitName}' in requires clause of kind '${kt.name}'`);
            break;
          }
          kt.requires.push(trait);
          break;
        }
        case ASTNodeKind.KIND_MUSTCALL_CLAUSE:
          if (mustCallSeen) {
            pushError(errors, c, `duplicate mustCall clause in kind '${kt.name}'`);
            break;
          }
          mustCallSeen = true;
          mustCallClause = c;
          break;
        case ASTNodeKind.KIND_OWNSBLOCK_CLAUSE:
          if (ownsBlockSeen) {
            pushError(errors, c, `duplicate ownsBlock clause in kind '${kt.name}'`);
            break;
          }
          ownsBlockSeen = true;
          kt.ownsBlock = true;
          break;
        case ASTNodeKind.KIND_MUST_NOT_ESCAPE_CLAUSE:
          if (mustNotEscapeSeen) {
            pushError(errors, c, `duplicate mustNotEscape clause in kind '${kt.name}'`);
            break;
          }
          mustNotEscapeSeen = true;
          kt.mustNotEscape = true;
          break;
        case ASTNodeKind.KIND_MUST_NOT_SHARE_CLAUSE:
          if (mustNotShareSeen) {
            pushError(errors, c, `duplicate mustNotShare clause in kind '${kt.name}'`);
            break;
          }
          mustNotShareSeen = true;
          kt.mustNotShare.push(c.target);
          break;
        case ASTNodeKind.KIND_FORBIDS_CLAUSE:
          for (const cat of c.categories) {
            if (kt.forbids.includes(cat)) {
              pushError(errors, c, `duplicate forbids category '${cat}' in kind '${kt.name}'`);
            } else {
              kt.forbids.push(cat);
            }
          }
          break;
        case ASTNodeKind.KIND_LAYOUT_CLAUSE: {
          if (layoutSeen) {
            pushError(errors, c, `duplicate layout clause in kind '${kt.name}'`);
            break;
          }
          layoutSeen = true;
          const slot = resolveLayoutAlign(c.alignExpr, kt, errors);
          if (slot) kt.layoutAlign = slot;
          break;
        }
      }
    }
    // mustCall resolution runs after requires have been collected so we can
    // search the full trait set.
    if (mustCallClause) {
      if (kt.requires.length === 0) {
        pushError(errors, mustCallClause,
          `mustCall requires at least one 'requires' clause to resolve method '${mustCallClause.methodName}' in kind '${kt.name}'`);
      } else {
        const traitWithMethod = kt.requires.find((t) => t.methods.has(mustCallClause.methodName));
        if (!traitWithMethod) {
          pushError(errors, mustCallClause,
            `mustCall ${mustCallClause.methodName}: no required trait declares this method in kind '${kt.name}'`);
        } else {
          kt.mustCall.push({
            methodName: mustCallClause.methodName,
            timing: mustCallClause.timing,
            traitType: traitWithMethod,
          });
        }
      }
    }
  }
}

// ─── phase 6.5: layout / composition / parameterized kinds ──────────────────

// Validate a `layout { align <expr>; }` align expression. Returns a slot
// `{ kind: "const", value }` for integer literals or `{ kind: "param", name }`
// for an IDENT that names one of the kind's params. Pushes an error and
// returns null on any other shape.
function resolveLayoutAlign(expr, kt, errors) {
  if (!expr) return null;
  if (expr.kind === ASTNodeKind.INT_LITERAL) {
    const v = expr.value;
    if (!Number.isInteger(v) || v <= 0 || (v & (v - 1)) !== 0 || v > 4096) {
      pushError(errors, expr,
        `layout align must be a power of two between 1 and 4096, got ${v}`);
      return null;
    }
    return { kind: "const", value: v };
  }
  if (expr.kind === ASTNodeKind.IDENT) {
    const p = kt.params.find((pp) => pp.name === expr.name);
    if (!p) {
      pushError(errors, expr,
        `layout align references unknown identifier '${expr.name}' (must be a constant or a kind parameter)`);
      return null;
    }
    return { kind: "param", name: expr.name };
  }
  pushError(errors, expr,
    `layout align must be a constant integer literal or a kind parameter reference`);
  return null;
}

// Resolve a kind reference by name into a KindType. Looks up the local
// kindTable (which includes imports + the seeded builtin Task) plus the
// builtin kind table for joined/pooled/Task.
function lookupKindByName(name, modEnv) {
  const fromTable = modEnv.kindTable?.get(name);
  if (fromTable) return fromTable;
  // builtin lookup is centralized in builtinKinds.js
  // but joined/pooled/Task aren't typically composed; the kind table
  // already has Task seeded.
  return null;
}

// Build a KindApplication from a use-site kind prefix: validate arg count,
// evaluate args to constants. Site applicability is NOT checked here —
// caller invokes `validateKindAppSite` after C.2 so the kind's `appliesTo`
// is populated. Returns null on error.
function resolveKindApplication(kindPrefix, modEnv, errors) {
  if (!kindPrefix) return null;
  const kt = lookupKindByName(kindPrefix.name, modEnv);
  if (!kt) {
    pushError(errors, { sourceLoc: kindPrefix.sourceLoc },
      `unknown kind "${kindPrefix.name}"`);
    return null;
  }
  // Arg-count check (params populated in pass A).
  const args = kindPrefix.args ?? [];
  if (args.length !== kt.params.length) {
    pushError(errors, { sourceLoc: kindPrefix.sourceLoc },
      `kind '${kt.name}' expects ${kt.params.length} argument(s), got ${args.length}`);
    return null;
  }
  // Evaluate each arg as a compile-time integer constant.
  const resolvedArgs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.kind !== ASTNodeKind.INT_LITERAL) {
      pushError(errors, a,
        `kind argument must be a constant in phase 6.5 (got ${a.kind})`);
      return null;
    }
    resolvedArgs.push(a.value);
  }
  return new KindApplication(kt, resolvedArgs);
}

// Phase 6.5: separate site-applicability check, runs after C.2 has populated
// every kind's `appliesTo` set.
function validateKindAppSite(app, site, sourceLoc, errors) {
  if (!app) return;
  const kt = app.kindType;
  if (!kt.appliesTo.has(site)) {
    const sites = [...kt.appliesTo].join(", ") || "(none)";
    pushError(errors, { sourceLoc },
      `kind '${kt.name}' does not apply to ${site}s (declared appliesTo: ${sites})`);
  }
}

// Shim to avoid a CJS-style require in this ESM file: builtin kinds are
// already merged into the module's kindTable by typecheckProgram's pass A
// (Task seed) and by parsing for joined/pooled (which take a separate path).
function require_builtin_kind_via_lookup(_name) {
  return null;
}

// Pass C.2b: flatten composition decls. Must run after C.2 so referenced
// kinds' clauses are populated. Cross-module references work because
// imported kinds share the same KindType instance with the source module
// (which is topologically earlier, hence already resolved).
function resolveKindComposition(mod, moduleEnv, errors) {
  const env = moduleEnv.get(mod.id);
  for (const decl of mod.ast.body) {
    const d = innerDecl(decl);
    if (d.kind !== ASTNodeKind.KIND_DECL) continue;
    if (!d.composition) continue;
    const kt = d.resolvedKindType;
    if (!kt) continue;

    // Resolve each reference.
    const refs = [];
    for (const ref of d.composition.kindRefs) {
      const target = env.kindTable.get(ref.name);
      if (!target) {
        pushError(errors, { sourceLoc: ref.sourceLoc },
          `unknown kind '${ref.name}' in composition of kind '${kt.name}'`);
        continue;
      }
      // Validate arg count
      const argCount = (ref.args ?? []).length;
      if (argCount !== target.params.length) {
        pushError(errors, { sourceLoc: ref.sourceLoc },
          `kind '${target.name}' expects ${target.params.length} argument(s) in composition, got ${argCount}`);
        continue;
      }
      // Evaluate args
      const resolvedArgs = [];
      let argOk = true;
      for (const a of ref.args ?? []) {
        if (a.kind !== ASTNodeKind.INT_LITERAL) {
          pushError(errors, a,
            `composition argument must be a constant integer literal`);
          argOk = false;
          break;
        }
        resolvedArgs.push(a.value);
      }
      if (!argOk) continue;
      refs.push({ target, args: resolvedArgs, sourceLoc: ref.sourceLoc });
    }
    kt.composedFrom = refs.map((r) => ({ name: r.target.name, args: r.args }));

    if (refs.length === 0) {
      // Nothing to merge; leave kt with empty slots.
      continue;
    }

    // Compute appliesTo as the intersection of components'.
    let intersected = null;
    for (const r of refs) {
      const set = r.target.appliesTo;
      if (intersected === null) {
        intersected = new Set(set);
      } else {
        for (const s of [...intersected]) {
          if (!set.has(s)) intersected.delete(s);
        }
      }
    }
    if (!intersected || intersected.size === 0) {
      pushError(errors, d,
        `composition has no common application site in kind '${kt.name}'`);
    } else {
      for (const s of intersected) kt.appliesTo.add(s);
    }

    // Flatten clauses.
    let mustCallEntry = null;
    let mustCallSourceName = null;
    let layoutSlot = null;
    let layoutSourceName = null;
    for (const r of refs) {
      const target = r.target;
      // requires — union by trait identity.
      for (const t of target.requires) {
        if (
          !kt.requires.some(
            (e) => e.name === t.name && (e.moduleId ?? null) === (t.moduleId ?? null),
          )
        ) {
          kt.requires.push(t);
        }
      }
      // mustCall — contradiction if two components disagree on method name.
      for (const mc of target.mustCall) {
        if (mustCallEntry && mustCallEntry.methodName !== mc.methodName) {
          pushError(errors, d,
            `composition contradiction in kind '${kt.name}': mustCall ${mustCallSourceName} vs mustCall ${mc.methodName}`);
        } else if (!mustCallEntry) {
          mustCallEntry = mc;
          mustCallSourceName = mc.methodName;
        }
      }
      // ownsBlock, mustNotEscape — boolean union.
      if (target.ownsBlock) kt.ownsBlock = true;
      if (target.mustNotEscape) kt.mustNotEscape = true;
      // mustNotShare, forbids — set union.
      for (const s of target.mustNotShare) {
        if (!kt.mustNotShare.includes(s)) kt.mustNotShare.push(s);
      }
      for (const f of target.forbids) {
        if (!kt.forbids.includes(f)) kt.forbids.push(f);
      }
      // layoutAlign — contradiction if two components specify different
      // constant values. (Param-bearing layouts can't appear here since
      // composition operands take constant args, but we still propagate
      // a substituted-const value.)
      if (target.layoutAlign) {
        let candidateValue = null;
        if (target.layoutAlign.kind === "const") {
          candidateValue = target.layoutAlign.value;
        } else if (target.layoutAlign.kind === "param") {
          const idx = target.params.findIndex((p) => p.name === target.layoutAlign.name);
          if (idx >= 0 && idx < r.args.length) candidateValue = r.args[idx];
        }
        if (candidateValue != null) {
          if (layoutSlot && layoutSlot.value !== candidateValue) {
            pushError(errors, d,
              `composition contradiction in kind '${kt.name}': align ${layoutSlot.value} vs align ${candidateValue}`);
          } else {
            layoutSlot = { kind: "const", value: candidateValue };
            layoutSourceName = target.name;
          }
        }
      }
    }
    if (mustCallEntry) kt.mustCall.push(mustCallEntry);
    if (layoutSlot) kt.layoutAlign = layoutSlot;
  }
}

// Resolve a propagates-clause entry (parser produces { name, args, sourceLoc })
// into a KindApplication suitable for storage on StructType/FuncType.
function resolveKindAppFromPropagatesEntry(ref, modEnv, errors) {
  const target = modEnv.kindTable.get(ref.name);
  if (!target) {
    pushError(errors, { sourceLoc: ref.sourceLoc },
      `unknown kind '${ref.name}' in propagates clause`);
    return null;
  }
  const argCount = (ref.args ?? []).length;
  if (argCount !== target.params.length) {
    pushError(errors, { sourceLoc: ref.sourceLoc },
      `kind '${target.name}' expects ${target.params.length} argument(s) in propagates clause, got ${argCount}`);
    return null;
  }
  const resolvedArgs = [];
  for (const a of ref.args ?? []) {
    if (a.kind !== ASTNodeKind.INT_LITERAL) {
      pushError(errors, a,
        `propagates argument must be a constant integer literal`);
      return null;
    }
    resolvedArgs.push(a.value);
  }
  return new KindApplication(target, resolvedArgs);
}

// Compute the effective layout alignment for a KindApplication after
// substituting parameter references. Returns null if no layout is declared.
export function effectiveLayoutAlign(app) {
  if (!app) return null;
  const slot = app.kindType.layoutAlign;
  if (!slot) return null;
  if (slot.kind === "const") return slot.value;
  if (slot.kind === "param") {
    const idx = app.kindType.params.findIndex((p) => p.name === slot.name);
    if (idx < 0) return null;
    return app.args[idx] ?? null;
  }
  return null;
}

// ─── multi-module entry point ─────────────────────────────────────────────────

// typecheckProgram(modules) — main entry for multi-file compilation.
// modules: topologically sorted (leaves first).
// Returns { modules, errors, moduleEnv }.
export function typecheckProgram(modules) {
  const errors = [];
  const moduleEnv = new Map(); // moduleId -> { localSymbols, structTable, exports, importedNames, linkLibraries }

  // pass A: register struct shells so cross-module struct refs work in pass B
  for (const mod of modules) {
    const localSymbols = new Map();
    const structTable = new Map();
    const exports = new Set();
    const importedNames = new Map();
    const linkLibraries = new Set();
    const traitTable = new Map();
    const kindTable = new Map();
    // Phase 6.4: seed the kind table with the `Task` builtin kind, which is
    // the kind-name that pairs with the built-in `Task<T>` type.
    kindTable.set("Task", TASK_KIND);

    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      if (d.kind === ASTNodeKind.TYPE_DECL) {
        if (structTable.has(d.name)) {
          errors.push({
            message: `redeclaration of type "${d.name}"`,
            sourceLoc: d.sourceLoc,
          });
        } else {
          structTable.set(d.name, StructType(d.name, null, mod.id));
        }
        if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
      }
      // Register function shells so resolveImports (pass B) can find them.
      // Redeclaration check lives here; pass C overwrites with proper sigs.
      const funcDecl = d.kind === ASTNodeKind.FUNCTION_DECL ? d : null;
      if (funcDecl) {
        if (localSymbols.has(funcDecl.name)) {
          errors.push({
            message: `redeclaration of function "${funcDecl.name}"`,
            sourceLoc: funcDecl.sourceLoc,
          });
        } else {
          localSymbols.set(funcDecl.name, FuncType([], ErrorType()));
          if (
            decl.kind === ASTNodeKind.EXPORT_DECL ||
            decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL
          ) {
            exports.add(funcDecl.name);
          }
        }
      }
      if (decl.kind === ASTNodeKind.EXTERN_BLOCK) {
        for (const ext of decl.decls) {
          if (
            ext.kind === ASTNodeKind.EXTERN_TYPE_DECL &&
            !structTable.has(ext.name)
          ) {
            structTable.set(ext.name, StructType(ext.name, [], mod.id));
          }
          if (ext.kind === ASTNodeKind.EXTERN_FUNCTION_DECL) {
            if (localSymbols.has(ext.name)) {
              errors.push({
                message: `redeclaration of "${ext.name}"`,
                sourceLoc: ext.sourceLoc,
              });
            } else {
              localSymbols.set(ext.name, FuncType([], ErrorType()));
            }
          }
        }
        if (decl.source.kind === "library")
          linkLibraries.add(decl.source.value);
      }

      if (d.kind === ASTNodeKind.TRAIT_DECL) {
        if (
          traitTable.has(d.name) ||
          structTable.has(d.name) ||
          localSymbols.has(d.name)
        ) {
          errors.push({
            message: `redeclaration of trait "${d.name}"`,
            sourceLoc: d.sourceLoc,
          });
        } else {
          traitTable.set(d.name, TraitType(d.name, new Map(), mod.id));
        }
        if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
      }

      if (d.kind === ASTNodeKind.KIND_DECL) {
        if (
          kindTable.has(d.name) ||
          traitTable.has(d.name) ||
          structTable.has(d.name) ||
          localSymbols.has(d.name)
        ) {
          errors.push({
            message: `redeclaration of kind "${d.name}"`,
            sourceLoc: d.sourceLoc,
          });
        } else {
          const kt = new KindType(d.name, mod.id);
          // Phase 6.5: record kind parameters on the shell so use-site
          // resolution can validate arg counts during pass C.
          for (const p of d.params ?? []) {
            const annot = p.typeAnnotation;
            const typeName = annot?.kind === "typeName" ? annot.name : null;
            const allowed = ["usize", "uint32", "uint64", "int32", "int64"];
            if (!typeName || !allowed.includes(typeName)) {
              const display = typeName ?? "<complex>";
              errors.push({
                message: `kind parameter type '${display}' not yet supported (use usize/int32/uint32 in phase 6.5)`,
                sourceLoc: p.sourceLoc,
              });
            }
            kt.params.push({ name: p.name, typeName, sourceLoc: p.sourceLoc });
          }
          kindTable.set(d.name, kt);
          d.resolvedKindType = kt;
        }
        if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
      }
    }

    moduleEnv.set(mod.id, {
      localSymbols,
      structTable,
      exports,
      importedNames,
      linkLibraries,
      traitTable,
      kindTable,
    });
  }

  // pass B: wire imports (so pass C can resolve cross-module type names)
  for (const mod of modules) {
    resolveImports(mod, moduleEnv, errors);
  }

  // pass C: struct fields + function sigs + extern decls
  for (const mod of modules) {
    const { localSymbols, structTable, exports, traitTable } = moduleEnv.get(
      mod.id,
    );

    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);

      // struct fields
      if (d.kind === ASTNodeKind.TYPE_DECL) {
        // Phase 6.4: reject `contains<K>` at a single point.
        if (d.containsClause) {
          errors.push({
            message: `contains not yet supported (phase 6.5 or later)`,
            sourceLoc: d.containsClause.sourceLoc,
          });
        }

        // Phase 6.4/6.5: resolve `propagates<K1, K2(args), ...>` into KindApplications.
        const propagatedKinds = [];
        if (d.propagatesClause) {
          const env2 = moduleEnv.get(mod.id);
          for (const ref of d.propagatesClause.kindNames) {
            const app = resolveKindAppFromPropagatesEntry(ref, env2, errors);
            if (!app) continue;
            if (propagatedKinds.some((a) => a.kindType === app.kindType)) {
              errors.push({
                message: `duplicate kind '${ref.name}' in propagates clause of struct "${d.name}"`,
                sourceLoc: ref.sourceLoc,
              });
              continue;
            }
            propagatedKinds.push(app);
          }
        }

        const fields = [];
        for (const field of d.fields ?? []) {
          // Phase 6.4: resolve field kind prefix against the kindTable.
          let fieldKindType = null;
          if (field.kindPrefix) {
            fieldKindType = moduleEnv
              .get(mod.id)
              .kindTable.get(field.kindPrefix.name);
            if (!fieldKindType) {
              errors.push({
                message: `unknown kind '${field.kindPrefix.name}' on field '${field.name}' of struct "${d.name}"`,
                sourceLoc: field.sourceLoc,
              });
            } else if (!fieldKindType.appliesTo.has("field")) {
              const sites = [...fieldKindType.appliesTo].join(", ") || "(none)";
              errors.push({
                message: `kind '${fieldKindType.name}' does not apply to fields (declared appliesTo: ${sites})`,
                sourceLoc: field.sourceLoc,
              });
            }
          }
          field.resolvedKindType = fieldKindType ?? null;

          let fieldType = resolveTypeAnnotationInModule(
            field.typeAnnotation,
            mod.id,
            moduleEnv,
          );
          if (!fieldType) {
            errors.push({
              message: `unknown type "${formatAnnotation(field.typeAnnotation)}" in field "${field.name}" of struct "${d.name}"`,
              sourceLoc: field.sourceLoc,
            });
            fieldType = ErrorType();
          }
          if (fields.some((f) => f.name === field.name)) {
            errors.push({
              message: `duplicate field name "${field.name}" in struct "${d.name}"`,
              sourceLoc: field.sourceLoc,
            });
          }
          if (detectRecursiveField(d.name, fieldType)) {
            errors.push({
              message: `recursive field "${field.name}" in struct "${d.name}"`,
              sourceLoc: field.sourceLoc,
            });
          }
          fields.push({ name: field.name, type: fieldType, kindType: fieldKindType });
        }

        // Phase 6.4: every kind-carrying field's kind must be in propagatedKinds.
        // A field "carries kind K" if its kindPrefix resolves to K, or its type
        // is `Task<T>` (which inherently carries the builtin `Task` kind).
        // Phase 6.5: propagatedKinds entries are KindApplications; compare by
        // KindType identity.
        for (const f of fields) {
          const carried = fieldCarriedKinds(f);
          for (const ck of carried) {
            if (!propagatedKinds.some((a) => a.kindType === ck)) {
              errors.push({
                message: `field '${f.name}' carries kind '${ck.name}' but enclosing struct '${d.name}' does not propagate it`,
                sourceLoc: d.sourceLoc,
              });
            }
          }
        }

        // Phase 6.5: type-decl kind prefix (e.g. `type Vec4 aligned(32) { ... }`).
        // Resolve the application now; site applicability is validated after C.2.
        let typeKindApp = null;
        if (d.kindPrefix) {
          typeKindApp = resolveKindApplication(
            d.kindPrefix,
            moduleEnv.get(mod.id),
            errors,
          );
          d.resolvedKindApplication = typeKindApp;
        }

        const fullType = StructType(
          d.name,
          fields,
          mod.id,
          [],
          new Map(),
          propagatedKinds,
          typeKindApp,
        );
        d.resolvedType = fullType;
        structTable.set(d.name, fullType);
      }

      // function signatures
      let funcDecl = null;
      if (decl.kind === ASTNodeKind.FUNCTION_DECL) {
        funcDecl = decl;
      } else if (
        (decl.kind === ASTNodeKind.EXPORT_DECL ||
          decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL) &&
        d.kind === ASTNodeKind.FUNCTION_DECL
      ) {
        funcDecl = d;
      }
      if (funcDecl) {
        // Overwrite shell placed in pass A with properly-resolved types.
        // Redeclaration was already checked in pass A.
        const declaredReturnType =
          resolveTypeAnnotationInModule(
            funcDecl.returnTypeAnnotation,
            mod.id,
            moduleEnv,
          ) ?? ErrorType();
        funcDecl.declaredReturnType = declaredReturnType;

        // Phase 6.4: resolve `propagates<K1, K2, ...>` on the function return.
        // Reject `contains` on returns at the same point.
        if (funcDecl.containsClause) {
          errors.push({
            message: `contains not yet supported (phase 6.5 or later)`,
            sourceLoc: funcDecl.containsClause.sourceLoc,
          });
        }
        const returnPropagatedKinds = [];
        if (funcDecl.propagatesClause) {
          const env = moduleEnv.get(mod.id);
          for (const ref of funcDecl.propagatesClause.kindNames) {
            const app = resolveKindAppFromPropagatesEntry(ref, env, errors);
            if (!app) continue;
            if (returnPropagatedKinds.some((a) => a.kindType === app.kindType)) {
              errors.push({
                message: `duplicate kind '${ref.name}' in propagates clause of function "${funcDecl.name}"`,
                sourceLoc: ref.sourceLoc,
              });
              continue;
            }
            returnPropagatedKinds.push(app);
          }
        }
        funcDecl.returnPropagatedKinds = returnPropagatedKinds;

        let externalReturnType = declaredReturnType;
        if (funcDecl.isTask) {
          if (funcDecl.name === "main") {
            errors.push({
              message: `task cannot be applied to main`,
              sourceLoc: funcDecl.sourceLoc,
            });
          } else if (
            declaredReturnType.kind === "void" ||
            declaredReturnType.kind === "error"
          ) {
            if (declaredReturnType.kind === "void") {
              errors.push({
                message: `task function "${funcDecl.name}" cannot return void`,
                sourceLoc: funcDecl.sourceLoc,
              });
            }
            externalReturnType = ErrorType();
          } else {
            externalReturnType = TaskType(declaredReturnType);
          }
        }
        localSymbols.set(
          funcDecl.name,
          FuncType(
            (funcDecl.params ?? []).map((p) => {
              const baseType =
                resolveTypeAnnotationInModule(
                  p.typeAnnotation,
                  mod.id,
                  moduleEnv,
                ) ?? ErrorType();
              return {
                name: p.name,
                type: p.isRef ? RefType(baseType) : baseType,
                isRef: p.isRef ?? false,
              };
            }),
            externalReturnType,
            false,
            returnPropagatedKinds,
          ),
        );
        if (
          decl.kind === ASTNodeKind.EXPORT_DECL ||
          decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL
        ) {
          exports.add(funcDecl.name);
        }
      }

      // extern function decls — overwrite shells placed in pass A
      if (decl.kind === ASTNodeKind.EXTERN_BLOCK) {
        for (const ext of decl.decls) {
          if (ext.kind !== ASTNodeKind.EXTERN_FUNCTION_DECL) continue;
          const paramTypes = ext.params.map((p) => {
            const t =
              resolveTypeAnnotationInModule(
                p.typeAnnotation,
                mod.id,
                moduleEnv,
              ) ?? ErrorType();
            p.resolvedType = t;
            return { name: p.name, type: t, isRef: p.isRef ?? false };
          });
          const retType =
            resolveTypeAnnotationInModule(
              ext.returnTypeAnnotation,
              mod.id,
              moduleEnv,
            ) ?? ErrorType();
          ext.resolvedType = retType;
          localSymbols.set(
            ext.name,
            FuncType(paramTypes, retType, ext.variadic),
          );
        }
      }
    }
    // pass C.1 - trait method signatures
    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      if (d.kind !== ASTNodeKind.TRAIT_DECL) continue;
      const trait = traitTable.get(d.name);
      if (!trait) continue; // was rejected in pass A due to redeclaration
      // validate no duplicate method names within the trait
      const seen = new Set();
      for (const sig of d.methods) {
        if (seen.has(sig.name)) {
          errors.push({
            message: `duplicate method name "${sig.name}" in trait "${d.name}"`,
            sourceLoc: sig.sourceLoc,
          });
          continue;
        }
        seen.add(sig.name);
        const ctxForSig = { selfType: TraitSelfPlaceholder };
        const params = sig.params.map((p) => {
          const baseType =
            resolveTypeAnnotationInModule(
              p.typeAnnotation,
              mod.id,
              moduleEnv,
              ctxForSig,
            ) ?? ErrorType();
          return {
            name: p.name,
            type: p.isRef ? RefType(baseType) : baseType,
            isRef: p.isRef ?? false,
          };
        });
        const returnType =
          resolveTypeAnnotationInModule(
            sig.returnTypeAnnotation,
            mod.id,
            moduleEnv,
            ctxForSig,
          ) ?? ErrorType();
        trait.methods.set(sig.name, FuncType(params, returnType, false));
        sig.resolvedFuncType = trait.methods.get(sig.name);
      }
    }

    // pass C.2 - kind clause resolution (between trait sigs and impl blocks).
    // After C.1, every trait shell has its method map populated, which is what
    // `requires`/`mustCall` need to resolve against.
    resolveKindClauses(mod, moduleEnv, errors);
    // pass C.2b - flatten composition decls now that primitive kinds in this
    // module have their clauses resolved. Cross-module operands are already
    // resolved because modules are typechecked in topological order.
    resolveKindComposition(mod, moduleEnv, errors);

    // pass C.2c - validate type-decl kind-prefix applicability now that every
    // kind's `appliesTo` set is populated (struct fields ran before C.2).
    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      if (d.kind !== ASTNodeKind.TYPE_DECL) continue;
      const app = d.resolvedKindApplication;
      if (!app) continue;
      validateKindAppSite(app, "type", d.kindPrefix.sourceLoc, errors);
    }

    // pass C.3 - impl block validation
    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      if (d.kind !== ASTNodeKind.TYPE_DECL || !d.implements?.length) continue;
      validateImplBlock(d, mod, moduleEnv, errors);
    }
  }

  // pass C.5: re-sync imported types now that pass C resolved proper sigs + fields.
  // Pass B copied shells; overwrite with fully-resolved versions.
  for (const mod of modules) {
    const { localSymbols, structTable, importedNames, traitTable, kindTable } = moduleEnv.get(mod.id);
    for (const [
      localName,
      { fromModuleId, exportName, kind },
    ] of importedNames) {
      const srcEnv = moduleEnv.get(fromModuleId);
      if (!srcEnv) continue;
      if (kind === "value") {
        const resolved = srcEnv.localSymbols.get(exportName);
        if (resolved) localSymbols.set(localName, resolved);
      } else if (kind === "type") {
        const resolved = srcEnv.structTable.get(exportName);
        if (resolved) structTable.set(localName, resolved);
      } else if (kind === "trait") {
        const resolved = srcEnv.traitTable.get(exportName);
        if (resolved) traitTable.set(localName, resolved);
      } else if (kind === "kind") {
        const resolved = srcEnv.kindTable.get(exportName);
        if (resolved) kindTable.set(localName, resolved);
      }
    }
  }

  // pass D: function body typechecking.
  // Split into two sub-passes so that all param kind types are resolved before
  // any runKindCheck runs (escape analysis needs param kinds from callees).
  for (const mod of modules) {
    const { localSymbols, structTable, importedNames, kindTable } = moduleEnv.get(mod.id);
    const typeContext = {
      moduleSymbols: localSymbols,
      structTable,
      moduleEnv,
      importedNames,
      currentModId: mod.id,
      kindTable,
    };

    // pass D.1: validate all functions and methods (populates resolvedKindType on params)
    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      if (d.kind === ASTNodeKind.FUNCTION_DECL) {
        validateFunction(d, typeContext, errors);
      } else if (d.kind === ASTNodeKind.TYPE_DECL && d.methods?.length > 0) {
        for (const method of d.methods) {
          validateMethod(method, d.resolvedType, typeContext, errors);
        }
      }
    }

    // Build a table of function declarations for the escape-analysis call-site check.
    const funcDeclTable = new Map();
    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      if (d.kind === ASTNodeKind.FUNCTION_DECL) {
        funcDeclTable.set(d.name, d);
      }
    }

    // pass D.2: run kind check (escape analysis) now that all param kinds are resolved
    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      if (d.kind === ASTNodeKind.FUNCTION_DECL) {
        runKindCheck(d, errors, funcDeclTable);
      } else if (d.kind === ASTNodeKind.TYPE_DECL && d.methods?.length > 0) {
        for (const method of d.methods) {
          runKindCheck(method, errors, funcDeclTable);
        }
      }
    }
  }

  return { modules, errors, moduleEnv };
}

// ─── single-module entry point (legacy + test path) ──────────────────────────

export function typecheck(ast) {
  const errors = [];
  const moduleSymbols = new Map();
  const structTable = new Map();

  const typeContext = {
    moduleSymbols,
    structTable,
    moduleEnv: null,
    kindTable: new Map(),
  };

  // pass 1: struct shells
  for (const decl of ast.body) {
    const d = innerDecl(decl);
    if (d.kind === ASTNodeKind.TYPE_DECL) {
      if (structTable.has(d.name)) {
        errors.push({
          message: `redeclaration of type "${d.name}"`,
          sourceLoc: d.sourceLoc,
        });
      } else {
        structTable.set(d.name, StructType(d.name, null));
      }
    }
    if (decl.kind === ASTNodeKind.EXTERN_BLOCK) {
      for (const ext of decl.decls) {
        if (
          ext.kind === ASTNodeKind.EXTERN_TYPE_DECL &&
          !structTable.has(ext.name)
        ) {
          structTable.set(ext.name, StructType(ext.name, []));
        }
      }
    }
  }

  // pass 2: struct fields
  for (const decl of ast.body) {
    const d = innerDecl(decl);
    if (d.kind === ASTNodeKind.TYPE_DECL) {
      const fields = [];
      for (const field of d.fields ?? []) {
        let fieldType = resolveTypeAnnotation(
          field.typeAnnotation,
          structTable,
        );
        if (!fieldType) {
          errors.push({
            message: `unknown type "${formatAnnotation(field.typeAnnotation)}" in field "${field.name}" of struct "${d.name}"`,
            sourceLoc: field.sourceLoc,
          });
          fieldType = ErrorType();
        }
        if (fields.some((f) => f.name === field.name)) {
          errors.push({
            message: `duplicate field name "${field.name}" in struct "${d.name}"`,
            sourceLoc: field.sourceLoc,
          });
        }
        if (detectRecursiveField(d.name, fieldType)) {
          errors.push({
            message: `recursive field "${field.name}" in struct "${d.name}"`,
            sourceLoc: field.sourceLoc,
          });
        }
        fields.push({ name: field.name, type: fieldType });
      }
      const fullType = StructType(d.name, fields);
      d.resolvedType = fullType;
      structTable.set(d.name, fullType);
    }
  }

  // pass 3: function sigs + extern decls
  for (const decl of ast.body) {
    const d = innerDecl(decl);

    if (d.kind === ASTNodeKind.FUNCTION_DECL) {
      if (moduleSymbols.has(d.name)) {
        errors.push({
          message: `redeclaration of function "${d.name}"`,
          sourceLoc: d.sourceLoc,
        });
      } else {
        moduleSymbols.set(
          d.name,
          FuncType(
            (d.params ?? []).map((p) => {
              const baseType =
                resolveTypeAnnotation(p.typeAnnotation, structTable) ??
                ErrorType();
              return {
                name: p.name,
                type: p.isRef ? RefType(baseType) : baseType,
                isRef: p.isRef ?? false,
              };
            }),
            resolveTypeAnnotation(d.returnTypeAnnotation, structTable) ??
              ErrorType(),
          ),
        );
      }
    }

    if (decl.kind === ASTNodeKind.EXTERN_BLOCK) {
      for (const ext of decl.decls) {
        if (ext.kind !== ASTNodeKind.EXTERN_FUNCTION_DECL) continue;
        if (moduleSymbols.has(ext.name)) {
          errors.push({
            message: `redeclaration of "${ext.name}"`,
            sourceLoc: ext.sourceLoc,
          });
          continue;
        }
        const paramTypes = ext.params.map((p) => {
          const t =
            resolveTypeAnnotation(p.typeAnnotation, structTable) ?? ErrorType();
          p.resolvedType = t;
          return { name: p.name, type: t, isRef: p.isRef ?? false };
        });
        const retType =
          resolveTypeAnnotation(ext.returnTypeAnnotation, structTable) ??
          ErrorType();
        ext.resolvedType = retType;
        moduleSymbols.set(
          ext.name,
          FuncType(paramTypes, retType, ext.variadic),
        );
      }
    }
  }

  // pass 4: function bodies
  for (const decl of ast.body) {
    const d = innerDecl(decl);
    if (d.kind === ASTNodeKind.FUNCTION_DECL) {
      validateFunction(d, typeContext, errors);
    }
  }

  return { ast, errors };
}

// convenience for tests: parse + typecheck in one call.
export function typecheckSource(src) {
  const ast = parse(src);
  return typecheck(ast);
}
