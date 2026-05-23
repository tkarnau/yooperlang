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
  EnumType,
  ErrorType,
  FuncType,
  KindApplication,
  KindType,
  PrimType,
  RefType,
  StructType,
  TaskType,
  TypeParamType,
  UnionType,
  UnsafePtrType,
  UntypedNullType,
  VoidType,
  FunctionPointerType,
  VTableType,
  primTypeFromName,
  resolveTypeAnnotation,
  formatAnnotation,
  TraitType,
  TraitSelfPlaceholder,
  typeKinds,
  typesEqual,
} from "./types.js";
import {
  createInstantiationRegistry,
  instantiateEnum,
  instantiateFunc,
  instantiateStruct,
  instantiateTrait,
  makeInstantiator,
} from "./instantiate.js";
import { setGlobalInstantiator } from "./types.js";
import { formatType, pushError } from "./errors.js";
import { coerceLiteralToType, isAssignable, unifyArith } from "./coerce.js";
import { detectRecursiveField } from "./recursiveStruct.js";
import { validateFunction, validateMethod, validateModuleInit } from "./checkStatement.js";
import { resolveImports } from "./imports.js";
import { runKindCheck } from "./kindCheck.js";
import { TASK_KIND } from "./builtinKinds.js";

export { formatType, coerceLiteralToType, isAssignable, unifyArith };

// ─── helpers ─────────────────────────────────────────────────────────────────

// Phase 8.A: walks an annotation object (from parser) looking for any
// `unsafe_ptr` reference. Returns true if any subtree names the type.
function annotMentionsUnsafePtr(annot) {
  if (!annot) return false;
  if (annot.kind === "typeName") return annot.name === "unsafe_ptr";
  if (annot.kind === "refType") return annotMentionsUnsafePtr(annot.inner);
  if (annot.kind === "arrayType") return annotMentionsUnsafePtr(annot.elem);
  if (annot.kind === "taskType") return annotMentionsUnsafePtr(annot.inner);
  if (annot.kind === "unsafePtrType") return true;
  if (annot.kind === "typeApplication") {
    if (annot.name === "unsafe_ptr") return true;
    return annot.typeArgs.some(annotMentionsUnsafePtr);
  }
  return false;
}

// Phase 8.A: scan the whole AST of a module (which did NOT opt into
// `import.unsafe;`) for any use of the pointer surface, and emit a clear
// diagnostic per occurrence. The walker is structural: it visits every key
// on every plain object, recursing into arrays and child nodes. Cheap
// enough — we do it once per module before pass C.
function walkAstForUnsafe(node, errors, visited = new WeakSet()) {
  if (!node) return;
  if (typeof node !== "object") return;
  if (visited.has(node)) return;
  visited.add(node);

  if (Array.isArray(node)) {
    for (const item of node) walkAstForUnsafe(item, errors, visited);
    return;
  }

  // AST nodes have a `kind` string from ASTNodeKind. Use it to flag the
  // pointer-introducing node kinds directly.
  if (typeof node.kind === "string") {
    switch (node.kind) {
      case ASTNodeKind.ADDRESS_OF_EXPRESSION:
        errors.push({
          message: `'&' (address-of) requires 'import.unsafe;' at module top`,
          sourceLoc: node.sourceLoc,
        });
        break;
      case ASTNodeKind.DEREF_EXPRESSION:
        errors.push({
          message: `'*' pointer dereference requires 'import.unsafe;' at module top`,
          sourceLoc: node.sourceLoc,
        });
        break;
      case ASTNodeKind.NULL_LITERAL:
        errors.push({
          message: `'null' requires 'import.unsafe;' at module top`,
          sourceLoc: node.sourceLoc,
        });
        break;
      case ASTNodeKind.UNSAFE_PTR_CAST:
        errors.push({
          message: `unsafe_ptr cast requires 'import.unsafe;' at module top`,
          sourceLoc: node.sourceLoc,
        });
        break;
      default:
        break;
    }
  }

  // Type annotations are plain objects with a `kind` like "typeName" /
  // "typeApplication" / etc. — distinct from AST node kinds. Detect them
  // via the absence of a sourceLoc-shaped property *and* a string `kind`
  // that names a primitive/struct type or generic application. Cheap test:
  // if walking encounters such an object, run annotMentionsUnsafePtr on it.
  // We attach the error to the nearest enclosing AST node's sourceLoc by
  // passing it down — but that requires extra plumbing. For an MVP we use
  // the parent AST node's loc when we recurse from there (handled below).

  for (const key of Object.keys(node)) {
    if (key === "sourceLoc" || key === "fieldSourceLoc") continue;
    const child = node[key];
    if (!child || typeof child !== "object") continue;
    // Type-annotation slot detection: parser uses `typeAnnotation` field on
    // bindings/params/fields/returns. Flag once per occurrence with the
    // enclosing AST node's source location.
    if (key === "typeAnnotation" || key === "returnTypeAnnotation") {
      if (annotMentionsUnsafePtr(child)) {
        errors.push({
          message: `'unsafe_ptr<T>' requires 'import.unsafe;' at module top`,
          sourceLoc: node.sourceLoc,
        });
      }
      continue; // annotations don't contain AST nodes; no further recursion
    }
    walkAstForUnsafe(child, errors, visited);
  }
}

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
  const { structTable, importedNames, enumTable, unionTable, vtableTable } =
    moduleEnv.get(modId);
  const local = structTable.get(name);
  // If local is a fully-resolved struct (fields !== null), use it.
  // If it's a shell (fields === null, from pass A / import copy), fall through
  // to importedNames so pass-C-resolved source versions are preferred.
  if (local && local.fields !== null) return local;
  const prim = primTypeFromName(name);
  if (prim) return prim;
  // Phase 7.5: enum / union nominal lookup. Both are sibling nominal types
  // alongside struct.
  const localEnum = enumTable?.get(name);
  if (localEnum) return localEnum;
  const localUnion = unionTable?.get(name);
  if (localUnion) return localUnion;
  // Phase 9.G: vtable nominal lookup.
  const localVtable = vtableTable?.get(name);
  if (localVtable) return localVtable;
  const imp = importedNames.get(name);
  if (imp && imp.kind === "type") {
    const srcEnv = moduleEnv.get(imp.fromModuleId);
    const resolved =
      srcEnv?.structTable.get(imp.exportName) ??
      srcEnv?.enumTable?.get(imp.exportName) ??
      srcEnv?.unionTable?.get(imp.exportName) ??
      srcEnv?.vtableTable?.get(imp.exportName);
    if (resolved) return resolved;
  }
  return local ?? null;
}

// Resolve a structured type annotation within a multi-module context.
//
// Phase 7.1: ctx may carry:
//   - typeParamScope: Map<paramName, TypeParamType> for resolving bare names
//     to type-params when inside a generic decl
//   - registry / programState: needed to call into the instantiation registry
//     when an annotation is a typeApplication
function resolveTypeAnnotationInModule(annot, modId, moduleEnv, ctx) {
  if (!annot) return null;
  if (annot.kind === "typeName") {
    // Phase 7.1: type-params in scope shadow normal type lookup.
    if (ctx?.typeParamScope) {
      const tp = ctx.typeParamScope.get(annot.name);
      if (tp) return tp;
    }
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
  if (annot.kind === "typeApplication") {
    const argTypes = [];
    for (const a of annot.typeArgs) {
      const t = resolveTypeAnnotationInModule(a, modId, moduleEnv, ctx);
      if (!t) return null;
      argTypes.push(t);
    }
    // Bridge: built-in Task<T> stays a TaskType.
    if (annot.name === "Task" && argTypes.length === 1) {
      return TaskType(argTypes[0]);
    }
    // Phase 8.A: built-in unsafe_ptr<T>. Gating is enforced where the
    // resolved type ends up bound to source (binding/parameter/return/field).
    if (annot.name === "unsafe_ptr" && argTypes.length === 1) {
      return UnsafePtrType(argTypes[0]);
    }
    return resolveGenericApplication(annot.name, argTypes, modId, moduleEnv, ctx);
  }
  if (annot.kind === "selfType") {
    if (!ctx?.selfType) {
      throw new Error("resolveTypeAnnotationInModule: 'self' used outside trait/method context");
    }
    return ctx.selfType;
  }
  // Phase 9.G: `(p: T) => R` function value type.
  if (annot.kind === "functionType") {
    const params = [];
    for (const p of annot.params) {
      const pt = resolveTypeAnnotationInModule(p, modId, moduleEnv, ctx);
      if (!pt) return null;
      params.push(pt);
    }
    const rt = resolveTypeAnnotationInModule(annot.returnType, modId, moduleEnv, ctx);
    if (!rt) return null;
    return FunctionPointerType(params, rt);
  }
  throw new Error(
    `resolveTypeAnnotationInModule: unknown annotation kind "${annot.kind}"`,
  );
}

// Phase 7.1: resolve `Name<Arg1, Arg2, ...>` by looking up the generic decl
// in the module's generic tables (or imports) and instantiating it.
// Phase 10.A: also reaches into genericEnumTable.
function resolveGenericApplication(name, argTypes, modId, moduleEnv, ctx) {
  const env = moduleEnv.get(modId);
  const registry = ctx?.registry;
  if (!registry) return null;
  // Local generic struct
  const localStruct = env.genericStructTable?.get(name);
  if (localStruct) {
    if (argTypes.length !== localStruct.paramNames.length) {
      return null; // arity mismatch reported by caller via formatAnnotation
    }
    return instantiateStruct(registry, localStruct, argTypes);
  }
  // Local generic trait
  const localTrait = env.genericTraitTable?.get(name);
  if (localTrait) {
    if (argTypes.length !== localTrait.paramNames.length) return null;
    return instantiateTrait(registry, localTrait, argTypes);
  }
  // Local generic enum (Phase 10.A)
  const localEnum = env.genericEnumTable?.get(name);
  if (localEnum) {
    if (argTypes.length !== localEnum.paramNames.length) return null;
    return instantiateEnum(registry, localEnum, argTypes);
  }
  // Imported generics
  const imp = env.importedNames?.get(name);
  if (imp) {
    const srcEnv = moduleEnv.get(imp.fromModuleId);
    if (srcEnv) {
      const remoteStruct = srcEnv.genericStructTable?.get(imp.exportName);
      if (remoteStruct) {
        if (argTypes.length !== remoteStruct.paramNames.length) return null;
        return instantiateStruct(registry, remoteStruct, argTypes);
      }
      const remoteTrait = srcEnv.genericTraitTable?.get(imp.exportName);
      if (remoteTrait) {
        if (argTypes.length !== remoteTrait.paramNames.length) return null;
        return instantiateTrait(registry, remoteTrait, argTypes);
      }
      const remoteEnum = srcEnv.genericEnumTable?.get(imp.exportName);
      if (remoteEnum) {
        if (argTypes.length !== remoteEnum.paramNames.length) return null;
        return instantiateEnum(registry, remoteEnum, argTypes);
      }
    }
  }
  return null;
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

// Phase 7.2: returns { ok: true } if `argType` satisfies `requiredTrait`,
// otherwise { ok: false, message }. `mod` and `moduleEnv` aren't needed
// today but are passed in for symmetry with the resolution helpers above —
// future "trait impls registered in module X" lookups slot here.
export function checkBoundSatisfied(argType, requiredTrait, _mod, _moduleEnv) {
  if (!argType || !requiredTrait) {
    return { ok: false, message: `internal: empty arg or bound` };
  }
  if (argType.kind === typeKinds.error) {
    // suppress secondary errors from a type that already failed to resolve
    return { ok: true };
  }
  if (argType.kind === typeKinds.struct) {
    for (const t of argType.implementsTraits ?? []) {
      if (t === requiredTrait) return { ok: true };
    }
    return {
      ok: false,
      message: `type "${argType.name}" does not implement trait "${requiredTrait.name}"`,
    };
  }
  if (argType.kind === typeKinds.typeParam) {
    if (argType.bound && argType.bound === requiredTrait) {
      return { ok: true };
    }
    return {
      ok: false,
      message: `type parameter "${argType.name}" does not satisfy bound "${requiredTrait.name}" — add 'implements ${requiredTrait.name}' to ${argType.name}'s declaration`,
    };
  }
  // primitives, refs, arrays, etc. — no impls today.
  const typeDesc =
    argType.kind === typeKinds.prim
      ? argType.name
      : argType.kind === typeKinds.ref
      ? `ref ${argType.inner?.name ?? "?"}`
      : argType.kind;
  return {
    ok: false,
    message: `type "${typeDesc}" does not implement trait "${requiredTrait.name}"`,
  };
}

// Phase 7.2: resolve bound annotations on every type param of a generic decl
// and mutate the existing TypeParamType in `genericDecl.paramScope` to carry
// the resolved TraitType. `astTypeParams` is the AST array (each entry has
// optional `bound` field set by the parser). Idempotent — bounds already set
// are left alone (and re-resolution skipped).
function resolveAndAttachBounds(
  genericDecl,
  astTypeParams,
  mod,
  moduleEnv,
  programState,
  errors,
) {
  for (const tpNode of astTypeParams ?? []) {
    if (!tpNode.bound) continue;
    const tpType = genericDecl.paramScope.get(tpNode.name);
    if (!tpType || tpType.bound) continue;
    const result = resolveBoundTrait(
      tpNode.bound,
      genericDecl.paramScope,
      mod,
      moduleEnv,
      programState,
    );
    if (!result) {
      errors.push({
        message: `unknown trait "${formatAnnotation(tpNode.bound)}" in bound on type parameter "${tpNode.name}"`,
        sourceLoc: tpNode.sourceLoc,
      });
      continue;
    }
    if (result.notTrait) {
      errors.push({
        message: `bound on type parameter "${tpNode.name}" must be a trait, got "${formatAnnotation(tpNode.bound)}"`,
        sourceLoc: tpNode.sourceLoc,
      });
      continue;
    }
    tpType.bound = result;
  }
}

// Phase 7.2: resolve a `T implements TraitAnnot` bound. Runs in pass C so that
// trait decls (incl. generic ones) and the current decl's own param scope are
// both visible — `<T implements Iterable<T>>` must resolve the inner `T` to the
// same TypeParamType that's already in scope.
//
// Returns the resolved TraitType or null on failure (caller pushes the error).
function resolveBoundTrait(annot, paramScope, mod, moduleEnv, programState) {
  // Non-generic trait lookup first — `resolveTypeInModule` only checks struct
  // and primitive tables, so a bare trait name would otherwise be unresolved.
  if (annot.kind === "typeName") {
    const env = moduleEnv.get(mod.id);
    const localTrait = env.traitTable?.get(annot.name);
    if (localTrait) return localTrait;
    const imported = lookupImportedTrait(annot.name, mod, moduleEnv);
    if (imported) return imported;
  }
  const ctx = {
    typeParamScope: paramScope,
    registry: programState.registry,
  };
  const resolved = resolveTypeAnnotationInModule(annot, mod.id, moduleEnv, ctx);
  if (!resolved) return null;
  if (resolved.kind !== typeKinds.trait) return { notTrait: true, resolved };
  return resolved;
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

// Phase 9.G: validate a `vtable Name for TraitName { ... }` decl. The decl
// names a trait (by its name in the current module's scope) and declares
// one function-pointer field per trait method. Each field's FPT signature
// must match the trait method's signature minus the leading `ref self` (the
// stored function takes a ctx pointer in self's place — typed as `ref T`
// for the impl, but the vtable erases T to a raw pointer that the function
// re-interprets as `ref T`).
function validateVTableDecl(d, mod, moduleEnv, errors, programState) {
  const env = moduleEnv.get(mod.id);
  const shell = env.vtableTable.get(d.name);
  if (!shell) return; // rejected at pass A due to redeclaration
  const trait =
    env.traitTable.get(d.traitName) ??
    lookupImportedTrait(d.traitName, mod, moduleEnv);
  if (!trait) {
    errors.push({
      message: `vtable "${d.name}" references unknown trait "${d.traitName}"`,
      sourceLoc: d.sourceLoc,
    });
    return;
  }
  if (trait.isGenericTraitRef || (trait.typeParams ?? []).length > 0) {
    errors.push({
      message: `vtable "${d.name}" cannot reference generic trait "${d.traitName}" (deferred — see plans/phase-9-g-vtables.md)`,
      sourceLoc: d.sourceLoc,
    });
    return;
  }

  // Build a map of field name -> resolved FPT. Detect duplicates and unknown
  // field names (i.e. field names that don't appear on the trait).
  const seen = new Set();
  const fieldByName = new Map();
  for (const fieldAst of d.fields) {
    if (seen.has(fieldAst.name)) {
      errors.push({
        message: `duplicate field "${fieldAst.name}" in vtable "${d.name}"`,
        sourceLoc: fieldAst.sourceLoc,
      });
      continue;
    }
    seen.add(fieldAst.name);
    if (!trait.methods.has(fieldAst.name)) {
      errors.push({
        message: `vtable "${d.name}" has field "${fieldAst.name}" not declared on trait "${trait.name}"`,
        sourceLoc: fieldAst.sourceLoc,
      });
      continue;
    }
    const fpt = resolveTypeAnnotationInModule(
      fieldAst.typeAnnotation,
      mod.id,
      moduleEnv,
      { registry: programState.registry },
    );
    if (!fpt) {
      errors.push({
        message: `vtable field "${fieldAst.name}": failed to resolve function-pointer type`,
        sourceLoc: fieldAst.sourceLoc,
      });
      continue;
    }
    fieldByName.set(fieldAst.name, fpt);
  }

  // For each trait method, check that the vtable declared a matching field,
  // and that the field's FPT matches the method's signature minus `ref self`.
  const resolvedFields = [];
  const methodOrder = [];
  for (const [methodName, methodSig] of trait.methods) {
    methodOrder.push(methodName);
    const fpt = fieldByName.get(methodName);
    if (!fpt) {
      errors.push({
        message: `vtable "${d.name}" is missing field "${methodName}" required by trait "${trait.name}"`,
        sourceLoc: d.sourceLoc,
      });
      resolvedFields.push({ name: methodName, type: ErrorType() });
      continue;
    }
    // Trait method sig: [ref self, p1: T1, p2: T2, ...]. Strip the leading
    // self param. The remaining params + return must match the FPT.
    const traitParams = methodSig.params.slice(1).map((p) => p.type);
    if (fpt.params.length !== traitParams.length) {
      errors.push({
        message: `vtable field "${methodName}" expects ${traitParams.length} parameter(s) (matching trait "${trait.name}.${methodName}"), got ${fpt.params.length}`,
        sourceLoc: d.sourceLoc,
      });
      resolvedFields.push({ name: methodName, type: fpt });
      continue;
    }
    let mismatch = false;
    for (let i = 0; i < traitParams.length; i++) {
      if (!typesEqual(fpt.params[i], traitParams[i])) {
        errors.push({
          message: `vtable field "${methodName}" parameter ${i + 1} type ${formatType(fpt.params[i])} does not match trait "${trait.name}.${methodName}" expected ${formatType(traitParams[i])}`,
          sourceLoc: d.sourceLoc,
        });
        mismatch = true;
      }
    }
    if (!typesEqual(fpt.returnType, methodSig.returnType)) {
      errors.push({
        message: `vtable field "${methodName}" return type ${formatType(fpt.returnType)} does not match trait "${trait.name}.${methodName}" expected ${formatType(methodSig.returnType)}`,
        sourceLoc: d.sourceLoc,
      });
      mismatch = true;
    }
    resolvedFields.push({
      name: methodName,
      type: mismatch ? ErrorType() : fpt,
    });
  }

  // Replace the shell with the fully-populated VTableType.
  const populated = VTableType(
    d.name,
    trait.name,
    trait.moduleId,
    resolvedFields,
    methodOrder,
    mod.id,
  );
  env.vtableTable.set(d.name, populated);
  d.resolvedType = populated;
  d.resolvedTrait = trait;
}

function validateImplBlock(typeDecl, mod, moduleEnv, errors, programState) {
  const env = moduleEnv.get(mod.id);
  // Phase 7.x: for generic structs, build an "open" struct shell by
  // instantiating the generic decl with its own TypeParamTypes as args.
  // This yields a StructType whose field slots carry TypeParamType, suitable
  // for serving as `self` during method-sig resolution and substitution.
  const isGeneric = !!typeDecl.genericDecl;
  const typeParamScope = isGeneric ? typeDecl.genericDecl.paramScope : null;
  let structShell;
  if (isGeneric) {
    const gd = typeDecl.genericDecl;
    // Build a throwaway open StructType to serve as `self` during impl
    // resolution. We deliberately don't go through the instantiation registry
    // because (a) we'd cache a frozen shell with empty traits, and (b) the
    // registry path would then need eviction. The shell only lives long enough
    // to substitute through trait sigs and stamp methodDecl.resolvedFuncType.
    const openFields = (gd.genericFields ?? []).map((f) => ({
      name: f.name,
      type: f.type,
      kindType: f.kindType ?? null,
    }));
    structShell = StructType(
      gd.name,
      openFields,
      gd.moduleId,
      [],
      new Map(),
      gd.propagatedKinds ?? [],
      gd.kindApplication ?? null,
      { declId: gd.id, args: gd.paramNames.map((pn) => gd.paramScope.get(pn)) },
    );
    typeDecl.openSelf = structShell;
  } else {
    structShell = env.structTable.get(typeDecl.name);
    if (!structShell) return;
  }

  // Step 1: resolve trait names.
  const resolvedImplements = [];
  // Phase 7.1: implements entries are records { name, typeArgs }. For
  // generic trait implementations (typeArgs != null), instantiate the trait
  // and substitute its method sigs.
  for (const entry of typeDecl.implements) {
    const traitName = typeof entry === "string" ? entry : entry.name;
    const typeArgs = typeof entry === "string" ? null : entry.typeArgs;
    const sourceLoc =
      typeof entry === "string" ? typeDecl.sourceLoc : entry.sourceLoc;
    if (typeArgs) {
      // Generic trait — look up the generic decl and instantiate.
      const localGeneric = env.genericTraitTable?.get(traitName);
      const imp = env.importedNames?.get(traitName);
      const remoteGeneric =
        imp && moduleEnv.get(imp.fromModuleId)?.genericTraitTable?.get(imp.exportName);
      const genericTrait = localGeneric ?? remoteGeneric ?? null;
      if (!genericTrait) {
        errors.push({
          message: `type "${typeDecl.name}" implements unknown generic trait "${traitName}"`,
          sourceLoc,
        });
        continue;
      }
      if (typeArgs.length !== genericTrait.paramNames.length) {
        errors.push({
          message: `trait "${traitName}" expects ${genericTrait.paramNames.length} type argument(s), got ${typeArgs.length}`,
          sourceLoc,
        });
        continue;
      }
      const resolvedArgs = [];
      let ok = true;
      for (const a of typeArgs) {
        // Phase 10.C.3: thread the type-decl's own paramScope so type
        // arguments inside `implements Trait<...>` can mention the
        // decl's type params (e.g.
        // `MapIter<K, V> implements Iterable<MapEntry<K, V>>`).
        const t = resolveTypeAnnotationInModule(a, mod.id, moduleEnv, {
          registry: programState.registry,
          typeParamScope,
        });
        if (!t) {
          errors.push({
            message: `unknown type argument "${formatAnnotation(a)}" in implements clause`,
            sourceLoc,
          });
          ok = false;
          break;
        }
        resolvedArgs.push(t);
      }
      if (!ok) continue;
      const inst = instantiateTrait(programState.registry, genericTrait, resolvedArgs);
      // Stash the resolved arg list on the instance for method substitution.
      programState.registry.traitArgsByInstance.set(inst, resolvedArgs);
      resolvedImplements.push(inst);
      continue;
    }
    const trait = env.traitTable.get(traitName) ?? lookupImportedTrait(traitName, mod, moduleEnv);
    if (!trait) {
      errors.push({ message: `type "${typeDecl.name}" implements unknown trait "${traitName}"`, sourceLoc });
      continue;
    }
    resolvedImplements.push(trait);
  }

  const fields = structShell.fields ?? [];

  // Step 2: substitute self in each trait's required methods. Group by method
  // name so a single impl body can satisfy multiple traits that demand the
  // same name and signature (Phase 7.4 — cross-trait same-name impls are now
  // legal because every call site qualifies through the trait).
  const requiredMethods = new Map(); // methodName -> Array<{traitName, sig}>
  for (const trait of resolvedImplements) {
    for (const [methodName, traitSig] of trait.methods) {
      const subbed = substituteSelfInSig(traitSig, structShell);
      if (!requiredMethods.has(methodName)) requiredMethods.set(methodName, []);
      requiredMethods.get(methodName).push({ traitName: trait.name, sig: subbed });
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

    const requiredList = requiredMethods.get(methodDecl.name);
    if (!requiredList || requiredList.length === 0) {
      errors.push({
        message: `type "${typeDecl.name}" declares method "${methodDecl.name}", but no implemented trait requires it`,
        sourceLoc: methodDecl.sourceLoc,
      });
      continue;
    }

    // If more than one trait requires this name, their signatures must agree —
    // otherwise a single impl body can't satisfy both.
    let sigConflict = false;
    for (let i = 1; i < requiredList.length; i++) {
      if (!sigsEqual(requiredList[0].sig, requiredList[i].sig)) {
        errors.push({
          message: `method "${methodDecl.name}" required by traits "${requiredList[0].traitName}" and "${requiredList[i].traitName}" with incompatible signatures — cannot implement both`,
          sourceLoc: methodDecl.sourceLoc,
        });
        sigConflict = true;
        break;
      }
    }
    if (sigConflict) continue;

    const ctxForMethod = {
      selfType: structShell,
      typeParamScope,
      registry: programState.registry,
    };
    const params = methodDecl.params.map((p) => {
      const baseType = resolveTypeAnnotationInModule(p.typeAnnotation, mod.id, moduleEnv, ctxForMethod) ?? ErrorType();
      const t = p.isRef ? RefType(baseType) : baseType;
      p.resolvedType = t;
      return { name: p.name, type: t, isRef: p.isRef ?? false };
    });
    const returnType = resolveTypeAnnotationInModule(methodDecl.returnTypeAnnotation, mod.id, moduleEnv, ctxForMethod) ?? ErrorType();
    const implSig = FuncType(params, returnType, false);

    const requiredSig = requiredList[0].sig;
    if (!sigsEqual(implSig, requiredSig)) {
      errors.push({
        message: `method "${methodDecl.name}" on type "${typeDecl.name}" has signature ${formatSig(implSig)}, expected ${formatSig(requiredSig)} from trait "${requiredList[0].traitName}"`,
        sourceLoc: methodDecl.sourceLoc,
      });
      continue;
    }
    methodDecl.resolvedFuncType = implSig;
    methodDecl.resolvedType = returnType;
    // Phase 7.4: one impl body can satisfy multiple same-named trait methods;
    // codegen emits one LLVM `define` per (trait, method) using the trait-
    // qualified mangle scheme.
    methodDecl.implementsTraits = requiredList.map((r) => r.traitName);
    resolvedMethods.set(methodDecl.name, implSig);
  }

  // Step 4: every required method must be implemented.
  for (const [methodName, list] of requiredMethods) {
    if (!resolvedMethods.has(methodName)) {
      const traitNames = list.map((r) => `"${r.traitName}"`).join(" / ");
      errors.push({
        message: `type "${typeDecl.name}" implements trait ${traitNames} but is missing method "${methodName}" with signature ${formatSig(list[0].sig)}`,
        sourceLoc: typeDecl.sourceLoc,
      });
    }
  }

  // Step 5: store the resolved impl info.
  if (isGeneric) {
    // For generic decls, stash impls + methods on the genericDecl so
    // subsequent instantiateStruct calls produce concrete instances carrying
    // implementsTraits + methods. instantiateStruct reads these fields when
    // building each StructType (see instantiate.js).
    typeDecl.genericDecl.implementsTraits = resolvedImplements;
    typeDecl.genericDecl.methods = resolvedMethods;
    for (const m of typeDecl.methods ?? []) {
      m.implementingType = structShell;
    }
    return;
  }
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
          // Phase 8.B: store the abi "C" marker. Currently contractual —
          // no downstream consumer yet, but persisted so future codegen /
          // ABI-validation passes can read it off the resolved kind.
          if (c.abiC) kt.layoutAbiC = true;
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

// Builtin generic functions — `heap_alloc<T>(n: usize): T[]` and
// `heap_free<T>(a: T[])`. These are not user-declared; they are registered
// into every module's genericFuncTable so call-site inference + instantiation
// flow through the existing Phase 7.1 path. Codegen intercepts by `declId`
// (see codegen.js) and emits malloc/free directly without a body clone.
//
// Built once per program so the instantiation registry caches across modules.
function makeBuiltinGenericFuncs() {
  const allocDeclId = "$builtin__heap_alloc";
  const allocT = new TypeParamType("T", allocDeclId);
  const allocSig = FuncType(
    [{ name: "n", type: PrimType("usize"), isRef: false }],
    ArrayType(allocT),
  );
  const heapAlloc = {
    id: allocDeclId,
    name: "heap_alloc",
    moduleId: "$builtin",
    paramNames: ["T"],
    paramScope: new Map([["T", allocT]]),
    genericSig: allocSig,
    ast: null,
    isBuiltin: true,
  };

  const freeDeclId = "$builtin__heap_free";
  const freeT = new TypeParamType("T", freeDeclId);
  const freeSig = FuncType(
    [{ name: "a", type: ArrayType(freeT), isRef: false }],
    VoidType(),
  );
  const heapFree = {
    id: freeDeclId,
    name: "heap_free",
    moduleId: "$builtin",
    paramNames: ["T"],
    paramScope: new Map([["T", freeT]]),
    genericSig: freeSig,
    ast: null,
    isBuiltin: true,
  };

  // Phase 8.H: string_as_bytes(s: string): uint8[]
  // Zero-copy view of a string's UTF-8 bytes as a fat-pointer array.
  // Sharing the string's storage; the view does not outlive the string.
  const asBytesDeclId = "$builtin__string_as_bytes";
  const stringAsBytes = {
    id: asBytesDeclId,
    name: "string_as_bytes",
    moduleId: "$builtin",
    paramNames: [],
    paramScope: new Map(),
    genericSig: FuncType(
      [{ name: "s", type: PrimType("string"), isRef: false }],
      ArrayType(PrimType("uint8")),
    ),
    ast: null,
    isBuiltin: true,
  };

  // Phase 8.H: string_from_bytes_unchecked(buf: uint8[]): string
  // Copies buf into a fresh malloc'd string, writes a nul terminator. Does
  // NOT validate UTF-8 — that's the wrapping `string_from_bytes` function's
  // job (lives in std/core/strings.yoop). This intrinsic is the building
  // block; user code should generally prefer the validating wrapper.
  const fromBytesDeclId = "$builtin__string_from_bytes_unchecked";
  const stringFromBytesUnchecked = {
    id: fromBytesDeclId,
    name: "string_from_bytes_unchecked",
    moduleId: "$builtin",
    paramNames: [],
    paramScope: new Map(),
    genericSig: FuncType(
      [{ name: "buf", type: ArrayType(PrimType("uint8")), isRef: false }],
      PrimType("string"),
    ),
    ast: null,
    isBuiltin: true,
  };

  // Phase 8.H: array_slice<T>(xs: T[], start: usize, end: usize): T[]
  // Returns a borrowing fat-pointer view {xs.ptr + start, end - start}.
  // No allocation. Caller is responsible for keeping the parent alive.
  // Matches the naming convention "_slice = view" from the intrinsics
  // index (see plans/phase-8-h-string-bytes-vec.md).
  const sliceDeclId = "$builtin__array_slice";
  const sliceT = new TypeParamType("T", sliceDeclId);
  const sliceSig = FuncType(
    [
      { name: "xs", type: ArrayType(sliceT), isRef: false },
      { name: "start", type: PrimType("usize"), isRef: false },
      { name: "end", type: PrimType("usize"), isRef: false },
    ],
    ArrayType(sliceT),
  );
  const arraySlice = {
    id: sliceDeclId,
    name: "array_slice",
    moduleId: "$builtin",
    paramNames: ["T"],
    paramScope: new Map([["T", sliceT]]),
    genericSig: sliceSig,
    ast: null,
    isBuiltin: true,
  };

  return [heapAlloc, heapFree, arraySlice, stringAsBytes, stringFromBytesUnchecked];
}

// ─── multi-module entry point ─────────────────────────────────────────────────

// typecheckProgram(modules) — main entry for multi-file compilation.
// modules: topologically sorted (leaves first).
// Returns { modules, errors, moduleEnv }.
export function typecheckProgram(modules) {
  const errors = [];
  const moduleEnv = new Map(); // moduleId -> { localSymbols, structTable, exports, importedNames, linkLibraries }
  // Phase 7.1: program-wide instantiation registry, shared across modules.
  const programState = {
    registry: createInstantiationRegistry(),
  };
  // Wire the registry-aware instantiator so substituteTypeParams can
  // re-instantiate open generic struct types into their concrete forms.
  setGlobalInstantiator(makeInstantiator(programState.registry));

  // Build builtin generic func decls once and reuse across all modules so
  // the instantiation registry caches by a stable declId.
  const builtinGenericFuncs = makeBuiltinGenericFuncs();

  // Phase 7.2: install the bound checker. Every instantiate*() that hits the
  // cache for the first time calls back here with each bounded (param, arg)
  // pair. Source-location tracking happens via the call-site error path in
  // checkExpr; this back-channel catches instantiations triggered by type
  // annotations (e.g. fields with `Box<NotImpl>`).
  programState.registry.boundChecker = ({
    genericDecl,
    argType,
    paramName,
    requiredTrait,
  }) => {
    const res = checkBoundSatisfied(argType, requiredTrait);
    if (res.ok) return;
    errors.push({
      message: `type argument for parameter "${paramName}" of generic "${genericDecl.name}" does not satisfy bound: ${res.message}`,
      sourceLoc: genericDecl.ast?.sourceLoc ?? null,
    });
  };

  // pass A: register struct shells so cross-module struct refs work in pass B
  for (const mod of modules) {
    const errStart = errors.length;
    const localSymbols = new Map();
    const structTable = new Map();
    const exports = new Set();
    const importedNames = new Map();
    const linkLibraries = new Set();
    const traitTable = new Map();
    const kindTable = new Map();
    // Phase 7.1: generic decl tables — generic decls live here and never
    // enter structTable/localSymbols/traitTable (those are monomorphic only).
    const genericStructTable = new Map();
    const genericFuncTable = new Map();
    const genericTraitTable = new Map();
    // Phase 10.A: generic enum decls. Sibling of genericStructTable; enumTable
    // stays monomorphic.
    const genericEnumTable = new Map();
    // Phase 7.5: enum / union tables. Like structTable, these hold a "shell"
    // value after pass A and are populated with field types in pass C.
    const enumTable = new Map();
    const unionTable = new Map();
    // Phase 9.G: vtable type table. Like structTable, the shell only carries
    // a name in pass A; pass C resolves field types and trait references.
    const vtableTable = new Map();
    // Phase 6.4: seed the kind table with the `Task` builtin kind, which is
    // the kind-name that pairs with the built-in `Task<T>` type.
    kindTable.set("Task", TASK_KIND);

    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      // Phase 7.5: register an enum shell so pass C can resolve variant fields.
      // Phase 10.A: generic enums register a genericDecl in genericEnumTable
      // (concrete tables stay monomorphic).
      if (d.kind === ASTNodeKind.ENUM_DECL) {
        const hasTypeParams = d.typeParams && d.typeParams.length > 0;
        if (hasTypeParams) {
          if (
            genericEnumTable.has(d.name) ||
            enumTable.has(d.name) ||
            structTable.has(d.name) ||
            genericStructTable.has(d.name) ||
            unionTable.has(d.name)
          ) {
            errors.push({
              message: `redeclaration of type "${d.name}"`,
              sourceLoc: d.sourceLoc,
            });
          } else {
            const declId = `${mod.id}__enum__${d.name}`;
            const paramNames = d.typeParams.map((p) => p.name);
            const paramScope = new Map();
            for (const pn of paramNames) {
              paramScope.set(pn, new TypeParamType(pn, declId));
            }
            const genericDecl = {
              id: declId,
              genericKind: "enum", // dispatch tag for makeInstantiator
              name: d.name,
              moduleId: mod.id,
              paramNames,
              paramScope,
              genericVariants: null, // filled in pass C
              ast: d,
            };
            genericEnumTable.set(d.name, genericDecl);
            d.genericDecl = genericDecl;
          }
          if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
          continue;
        }
        if (
          enumTable.has(d.name) ||
          structTable.has(d.name) ||
          unionTable.has(d.name)
        ) {
          errors.push({
            message: `redeclaration of type "${d.name}"`,
            sourceLoc: d.sourceLoc,
          });
        } else {
          // Shell — variants Map left empty; pass C populates fields.
          enumTable.set(d.name, EnumType(d.name, new Map(), mod.id));
        }
        if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
        continue;
      }
      if (d.kind === ASTNodeKind.UNION_DECL) {
        if (
          enumTable.has(d.name) ||
          structTable.has(d.name) ||
          unionTable.has(d.name)
        ) {
          errors.push({
            message: `redeclaration of type "${d.name}"`,
            sourceLoc: d.sourceLoc,
          });
        } else {
          // Shell — fields filled in pass C.
          unionTable.set(d.name, UnionType(d.name, [], mod.id));
        }
        if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
        continue;
      }
      if (d.kind === ASTNodeKind.TYPE_DECL) {
        const hasTypeParams = d.typeParams && d.typeParams.length > 0;
        if (hasTypeParams) {
          // Phase 7.1: generic struct decl. Register in genericStructTable.
          if (genericStructTable.has(d.name) || structTable.has(d.name)) {
            errors.push({
              message: `redeclaration of type "${d.name}"`,
              sourceLoc: d.sourceLoc,
            });
          } else {
            // The decl id is used as the TypeParamType.originDecl so two
            // unrelated `T`s in different decls don't collide.
            const declId = `${mod.id}__struct__${d.name}`;
            const paramNames = d.typeParams.map((p) => p.name);
            const paramScope = new Map();
            for (const pn of paramNames) {
              paramScope.set(pn, new TypeParamType(pn, declId));
            }
            const genericDecl = {
              id: declId,
              genericKind: "struct", // dispatch tag for makeInstantiator
              name: d.name,
              moduleId: mod.id,
              paramNames,
              paramScope,
              genericFields: null, // filled in pass C
              ast: d,
              implementsTraits: [],
              methods: new Map(),
              propagatedKinds: [],
              kindApplication: null,
            };
            genericStructTable.set(d.name, genericDecl);
            d.genericDecl = genericDecl;
          }
          if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
        } else {
          if (structTable.has(d.name) || genericStructTable.has(d.name)) {
            errors.push({
              message: `redeclaration of type "${d.name}"`,
              sourceLoc: d.sourceLoc,
            });
          } else {
            structTable.set(d.name, StructType(d.name, null, mod.id));
          }
          if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
        }
      }
      // Register function shells so resolveImports (pass B) can find them.
      // Redeclaration check lives here; pass C overwrites with proper sigs.
      const funcDecl = d.kind === ASTNodeKind.FUNCTION_DECL ? d : null;
      if (funcDecl) {
        const hasTypeParams = funcDecl.typeParams && funcDecl.typeParams.length > 0;
        if (hasTypeParams) {
          // Phase 7.1: generic function decl.
          if (
            genericFuncTable.has(funcDecl.name) ||
            localSymbols.has(funcDecl.name)
          ) {
            errors.push({
              message: `redeclaration of function "${funcDecl.name}"`,
              sourceLoc: funcDecl.sourceLoc,
            });
          } else {
            const declId = `${mod.id}__fn__${funcDecl.name}`;
            const paramNames = funcDecl.typeParams.map((p) => p.name);
            const paramScope = new Map();
            for (const pn of paramNames) {
              paramScope.set(pn, new TypeParamType(pn, declId));
            }
            const genericDecl = {
              id: declId,
              name: funcDecl.name,
              moduleId: mod.id,
              paramNames,
              paramScope,
              genericSig: null, // filled in pass C
              ast: funcDecl,
            };
            genericFuncTable.set(funcDecl.name, genericDecl);
            funcDecl.genericDecl = genericDecl;
            if (
              decl.kind === ASTNodeKind.EXPORT_DECL ||
              decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL
            ) {
              exports.add(funcDecl.name);
            }
          }
        } else if (localSymbols.has(funcDecl.name) || genericFuncTable.has(funcDecl.name)) {
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
        const hasTypeParams = d.typeParams && d.typeParams.length > 0;
        if (
          traitTable.has(d.name) ||
          genericTraitTable.has(d.name) ||
          structTable.has(d.name) ||
          genericStructTable.has(d.name) ||
          localSymbols.has(d.name) ||
          genericFuncTable.has(d.name)
        ) {
          errors.push({
            message: `redeclaration of trait "${d.name}"`,
            sourceLoc: d.sourceLoc,
          });
        } else if (hasTypeParams) {
          // Phase 7.1: generic trait decl.
          const declId = `${mod.id}__trait__${d.name}`;
          const paramNames = d.typeParams.map((p) => p.name);
          const paramScope = new Map();
          for (const pn of paramNames) {
            paramScope.set(pn, new TypeParamType(pn, declId));
          }
          const genericDecl = {
            id: declId,
            name: d.name,
            moduleId: mod.id,
            paramNames,
            paramScope,
            genericMethods: new Map(), // filled in pass C
            ast: d,
          };
          genericTraitTable.set(d.name, genericDecl);
          d.genericDecl = genericDecl;
        } else {
          traitTable.set(d.name, TraitType(d.name, new Map(), mod.id));
        }
        if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
      }

      // Phase 9.G: register vtable shell. The trait reference + field types
      // are resolved in pass C alongside other type bodies.
      if (d.kind === ASTNodeKind.VTABLE_DECL) {
        if (
          vtableTable.has(d.name) ||
          structTable.has(d.name) ||
          enumTable.has(d.name) ||
          unionTable.has(d.name) ||
          traitTable.has(d.name) ||
          localSymbols.has(d.name)
        ) {
          errors.push({
            message: `redeclaration of "${d.name}"`,
            sourceLoc: d.sourceLoc,
          });
        } else {
          // Shell: trait name is captured here; trait + field types come in pass C.
          vtableTable.set(
            d.name,
            VTableType(d.name, d.traitName, null, [], [], mod.id),
          );
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

      // Phase 8.E: register module-level let/const shells so cross-module
      // imports and intra-module references can find the name in pass B/C.
      // The real type is resolved in pass C; the initializer is checked in
      // pass D.0. The decl itself is stashed onto `mod.moduleInitDecls` so
      // codegen (and a future CTE pass) can find them in source order
      // without re-walking the AST.
      if (
        (d.kind === ASTNodeKind.LET_DECL || d.kind === ASTNodeKind.CONST_DECL) &&
        d.isModuleLevel
      ) {
        if (localSymbols.has(d.name)) {
          errors.push({
            message: `redeclaration of "${d.name}" at module top`,
            sourceLoc: d.sourceLoc,
          });
        } else {
          // Shell: ErrorType placeholder until pass C resolves the
          // annotation. Marker fields signal "this is a module global"
          // to lookups + codegen.
          localSymbols.set(d.name, ErrorType());
          d.isModuleGlobal = true;
          d.moduleGlobalSym = `${mod.id}__${d.name}`;
          if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
        }
      }
    }

    // Insert builtin generic funcs after user decls so a user-defined function
    // with the same name cleanly shadows. lookupGenericFunc checks the local
    // table first, so this is a no-op when a user has redeclared.
    for (const bi of builtinGenericFuncs) {
      if (!genericFuncTable.has(bi.name)) {
        genericFuncTable.set(bi.name, bi);
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
      genericStructTable,
      genericFuncTable,
      genericTraitTable,
      genericEnumTable,
      enumTable,
      unionTable,
      vtableTable,
      // Phase 8.A: `import.unsafe;` opt-in flag, plumbed from the parser.
      allowsUnsafe: !!mod.ast.allowsUnsafe,
    });
    stampModuleId(errors, errStart, mod.id);
  }

  // pass B: wire imports (so pass C can resolve cross-module type names)
  for (const mod of modules) {
    const errStart = errors.length;
    resolveImports(mod, moduleEnv, errors);
    stampModuleId(errors, errStart, mod.id);
  }

  // Phase 8.A: `import.unsafe;` gating pass — scan each non-unsafe module
  // for any unsafe_ptr type annotation, address-of/deref/null/cast node, and
  // surface a precise diagnostic. Cheap recursive walk; runs once per module.
  for (const mod of modules) {
    const env = moduleEnv.get(mod.id);
    if (env?.allowsUnsafe) continue;
    const errStart = errors.length;
    walkAstForUnsafe(mod.ast, errors);
    stampModuleId(errors, errStart, mod.id);
  }

  // pass C: struct fields + function sigs + extern decls
  for (const mod of modules) {
    const errStart = errors.length;
    const env = moduleEnv.get(mod.id);
    const { localSymbols, structTable, exports, traitTable, enumTable, unionTable } = env;
    // Default ctx (no typeParamScope, registry always available).
    const baseCtx = () => ({ registry: programState.registry });
    // ctx for a generic decl body — adds the type-param scope.
    const genericCtx = (paramScope) => ({
      registry: programState.registry,
      typeParamScope: paramScope,
    });

    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);

      // Phase 7.1: generic struct decl — resolve field types with type params
      // in scope and stash on the genericDecl record.
      if (d.kind === ASTNodeKind.TYPE_DECL && d.genericDecl) {
        const gd = d.genericDecl;
        // Phase 7.2: resolve `implements TraitAnnot` bounds onto the
        // TypeParamTypes in paramScope before resolving field types.
        resolveAndAttachBounds(
          gd,
          d.typeParams,
          mod,
          moduleEnv,
          programState,
          errors,
        );
        const ctxForGeneric = genericCtx(gd.paramScope);
        const genericFields = [];
        for (const field of d.fields ?? []) {
          let fieldType = resolveTypeAnnotationInModule(
            field.typeAnnotation,
            mod.id,
            moduleEnv,
            ctxForGeneric,
          );
          if (!fieldType) {
            errors.push({
              message: `unknown type "${formatAnnotation(field.typeAnnotation)}" in field "${field.name}" of generic struct "${d.name}"`,
              sourceLoc: field.sourceLoc,
            });
            fieldType = ErrorType();
          }
          if (genericFields.some((f) => f.name === field.name)) {
            errors.push({
              message: `duplicate field name "${field.name}" in struct "${d.name}"`,
              sourceLoc: field.sourceLoc,
            });
          }
          field.resolvedKindType = null;
          genericFields.push({
            name: field.name,
            type: fieldType,
            kindType: null,
          });
        }
        gd.genericFields = genericFields;
        // Phase 7.x: resolve `propagates<K, ...>` on the generic struct decl
        // and stash on the genericDecl so each instantiation inherits the
        // propagatedKinds. Mirrors the non-generic branch below.
        if (d.propagatesClause) {
          const env2 = moduleEnv.get(mod.id);
          const propagatedKinds = [];
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
          gd.propagatedKinds = propagatedKinds;
        }
        // Don't continue — fall through to skip the regular TYPE_DECL handler
        // below by checking d.genericDecl there.
      }

      // struct fields
      if (d.kind === ASTNodeKind.TYPE_DECL && !d.genericDecl) {
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
            baseCtx(),
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

      // Phase 7.5: resolve enum variant fields.
      // Phase 10.A: generic enums get a separate branch — their variant fields
      // are resolved with a type-param scope and stashed on the genericDecl
      // for later instantiation. The genericDecl never produces a single
      // resolvedType.
      if (d.kind === ASTNodeKind.ENUM_DECL && d.genericDecl) {
        const gd = d.genericDecl;
        const ctxForGeneric = genericCtx(gd.paramScope);
        const genericVariants = new Map();
        let ordinal = 0;
        for (const variantNode of d.variants ?? []) {
          let resolvedFields = null;
          if (variantNode.fields !== null) {
            resolvedFields = [];
            const seenFieldNames = new Set();
            for (const f of variantNode.fields) {
              if (seenFieldNames.has(f.name)) {
                errors.push({
                  message: `duplicate field "${f.name}" in variant "${variantNode.name}" of generic enum "${d.name}"`,
                  sourceLoc: f.sourceLoc,
                });
                continue;
              }
              seenFieldNames.add(f.name);
              let ft = resolveTypeAnnotationInModule(
                f.typeAnnotation,
                mod.id,
                moduleEnv,
                ctxForGeneric,
              );
              if (!ft) {
                errors.push({
                  message: `unknown type "${formatAnnotation(f.typeAnnotation)}" in variant "${variantNode.name}" of generic enum "${d.name}"`,
                  sourceLoc: f.sourceLoc,
                });
                ft = ErrorType();
              }
              resolvedFields.push({ name: f.name, type: ft });
            }
          }
          genericVariants.set(variantNode.name, {
            name: variantNode.name,
            fields: resolvedFields,
            ordinal,
          });
          variantNode.ordinal = ordinal;
          ordinal++;
        }
        gd.genericVariants = genericVariants;
      } else if (d.kind === ASTNodeKind.ENUM_DECL) {
        const variants = new Map();
        let ordinal = 0;
        for (const variantNode of d.variants ?? []) {
          let resolvedFields = null;
          if (variantNode.fields !== null) {
            resolvedFields = [];
            const seenFieldNames = new Set();
            for (const f of variantNode.fields) {
              if (seenFieldNames.has(f.name)) {
                errors.push({
                  message: `duplicate field "${f.name}" in variant "${variantNode.name}" of enum "${d.name}"`,
                  sourceLoc: f.sourceLoc,
                });
                continue;
              }
              seenFieldNames.add(f.name);
              let ft = resolveTypeAnnotationInModule(
                f.typeAnnotation,
                mod.id,
                moduleEnv,
                baseCtx(),
              );
              if (!ft) {
                errors.push({
                  message: `unknown type "${formatAnnotation(f.typeAnnotation)}" in variant "${variantNode.name}" of enum "${d.name}"`,
                  sourceLoc: f.sourceLoc,
                });
                ft = ErrorType();
              }
              resolvedFields.push({ name: f.name, type: ft });
            }
          }
          variants.set(variantNode.name, {
            name: variantNode.name,
            fields: resolvedFields,
            ordinal,
          });
          variantNode.ordinal = ordinal;
          ordinal++;
        }
        const fullEnum = EnumType(d.name, variants, mod.id);
        d.resolvedType = fullEnum;
        enumTable.set(d.name, fullEnum);
      }

      // Phase 7.5: resolve union field types.
      if (d.kind === ASTNodeKind.UNION_DECL) {
        const fields = [];
        const seenNames = new Set();
        for (const f of d.fields ?? []) {
          if (seenNames.has(f.name)) {
            errors.push({
              message: `duplicate field "${f.name}" in union "${d.name}"`,
              sourceLoc: f.sourceLoc,
            });
            continue;
          }
          seenNames.add(f.name);
          let ft = resolveTypeAnnotationInModule(
            f.typeAnnotation,
            mod.id,
            moduleEnv,
            baseCtx(),
          );
          if (!ft) {
            errors.push({
              message: `unknown type "${formatAnnotation(f.typeAnnotation)}" in union "${d.name}"`,
              sourceLoc: f.sourceLoc,
            });
            ft = ErrorType();
          }
          // Reject fields with disallowed layouts (refs/arrays/tasks/kinds
          // mix poorly with raw bit-reinterpretation; structs and prims are
          // fine).
          if (
            ft.kind === typeKinds.task ||
            ft.kind === typeKinds.ref
          ) {
            errors.push({
              message: `union field "${f.name}" has type ${formatAnnotation(f.typeAnnotation)} — refs and Tasks are not allowed in unions`,
              sourceLoc: f.sourceLoc,
            });
          }
          fields.push({ name: f.name, type: ft });
        }
        const fullUnion = UnionType(d.name, fields, mod.id);
        d.resolvedType = fullUnion;
        unionTable.set(d.name, fullUnion);
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
        // Phase 7.1: generic functions are resolved with type params in scope
        // and their signature is stashed on the genericDecl record. They are
        // NOT inserted into localSymbols.
        const isGenericFunc = !!funcDecl.genericDecl;
        if (isGenericFunc) {
          // Phase 7.2: attach bounds to the type params before resolving the sig.
          resolveAndAttachBounds(
            funcDecl.genericDecl,
            funcDecl.typeParams,
            mod,
            moduleEnv,
            programState,
            errors,
          );
        }
        const ctxForFunc = isGenericFunc
          ? genericCtx(funcDecl.genericDecl.paramScope)
          : baseCtx();
        // Overwrite shell placed in pass A with properly-resolved types.
        // Redeclaration was already checked in pass A.
        const declaredReturnType =
          resolveTypeAnnotationInModule(
            funcDecl.returnTypeAnnotation,
            mod.id,
            moduleEnv,
            ctxForFunc,
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
        const paramTypes = (funcDecl.params ?? []).map((p) => {
          const baseType =
            resolveTypeAnnotationInModule(
              p.typeAnnotation,
              mod.id,
              moduleEnv,
              ctxForFunc,
            ) ?? ErrorType();
          return {
            name: p.name,
            type: p.isRef ? RefType(baseType) : baseType,
            isRef: p.isRef ?? false,
          };
        });
        const funcType = FuncType(
          paramTypes,
          externalReturnType,
          false,
          returnPropagatedKinds,
        );
        if (isGenericFunc) {
          // Stash on the generic decl record for later instantiation.
          funcDecl.genericDecl.genericSig = funcType;
        } else {
          localSymbols.set(funcDecl.name, funcType);
        }
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
            const baseType =
              resolveTypeAnnotationInModule(
                p.typeAnnotation,
                mod.id,
                moduleEnv,
                baseCtx(),
              ) ?? ErrorType();
            const t = p.isRef ? RefType(baseType) : baseType;
            p.resolvedType = t;
            return { name: p.name, type: t, isRef: p.isRef ?? false };
          });
          const retType =
            resolveTypeAnnotationInModule(
              ext.returnTypeAnnotation,
              mod.id,
              moduleEnv,
              baseCtx(),
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
      // Phase 7.1: generic trait — resolve method sigs with type-param scope.
      if (d.genericDecl) {
        const gd = d.genericDecl;
        // Phase 7.2: attach bounds before resolving method signatures.
        resolveAndAttachBounds(
          gd,
          d.typeParams,
          mod,
          moduleEnv,
          programState,
          errors,
        );
        const ctxForSig = {
          ...genericCtx(gd.paramScope),
          selfType: TraitSelfPlaceholder,
        };
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
          const sigFunc = FuncType(params, returnType, false);
          gd.genericMethods.set(sig.name, sigFunc);
          sig.resolvedFuncType = sigFunc;
        }
        continue;
      }
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
        const ctxForSig = { ...baseCtx(), selfType: TraitSelfPlaceholder };
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
      // Phase 7.x: generic structs now support `implements Trait`. validateImplBlock
      // routes to the open-self code path when d.genericDecl is set. Note: this
      // runs *after* struct field resolution in pass C, so a struct field that
      // references DynArray<int32> in the same module would have already been
      // cached with empty implementsTraits. The current playground demo doesn't
      // hit this case; broader use will need a pre-pass before field resolution.
      validateImplBlock(d, mod, moduleEnv, errors, programState);
    }

    // Phase 9.G: pass C.3b - validate vtable decls. Each field must be a
    // function-pointer type matching a trait method's signature minus the
    // leading `ref self`. We build a fresh fully-populated VTableType (the
    // pass-A shell only carried the trait name) and replace it in the table.
    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      if (d.kind !== ASTNodeKind.VTABLE_DECL) continue;
      validateVTableDecl(d, mod, moduleEnv, errors, programState);
    }

    // Phase 8.E: pass C.4 - resolve module-level let/const declared-type
    // annotations and stash the decls onto mod.moduleInitDecls in source
    // order. The initializer expressions are typechecked in pass D.0 once
    // every function signature in this module has resolved (so initializers
    // may freely call functions defined in the same module).
    //
    // (Bytecode/CTE future) — mod.moduleInitDecls is the natural input to
    // a future compile-time evaluator: each entry has a resolved type on
    // the decl, an unresolved `.assignment` AST, and a stable order.
    mod.moduleInitDecls = [];
    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      if (
        (d.kind === ASTNodeKind.LET_DECL || d.kind === ASTNodeKind.CONST_DECL) &&
        d.isModuleLevel
      ) {
        const declaredType =
          resolveTypeAnnotationInModule(
            d.typeAnnotation,
            mod.id,
            moduleEnv,
            baseCtx(),
          ) ?? null;
        if (!declaredType) {
          errors.push({
            message: `unknown type "${formatAnnotation(d.typeAnnotation)}" on module-level "${d.name}"`,
            sourceLoc: d.sourceLoc,
          });
          d.resolvedType = ErrorType();
        } else {
          d.resolvedType = declaredType;
          // Update the previously-installed shell with the real type.
          env.localSymbols.set(d.name, declaredType);
        }
        mod.moduleInitDecls.push(d);
      }
    }
    // Mirror onto env so resolve-assignment-to-module-global (which only has
    // the typeContext) can find the decl list without re-walking the AST.
    env.moduleInitDecls = mod.moduleInitDecls;
    stampModuleId(errors, errStart, mod.id);
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
    const errStart = errors.length;
    const env = moduleEnv.get(mod.id);
    const { localSymbols, structTable, importedNames, kindTable, traitTable } = env;
    const typeContext = {
      moduleSymbols: localSymbols,
      structTable,
      moduleEnv,
      importedNames,
      currentModId: mod.id,
      kindTable,
      // Phase 7.4: trait-qualified call resolution needs the trait table.
      traitTable,
      // Phase 7.1: needed for generic call-site inference and for resolving
      // typeApplication annotations inside function bodies.
      registry: programState.registry,
      genericFuncTable: env.genericFuncTable,
      genericStructTable: env.genericStructTable,
      genericTraitTable: env.genericTraitTable,
      // Phase 10.A: generic enum table for variant-constructor pinning.
      genericEnumTable: env.genericEnumTable,
      // Phase 7.5: enum and union nominal tables.
      enumTable: env.enumTable,
      unionTable: env.unionTable,
      // Phase 9.G: vtable nominal table.
      vtableTable: env.vtableTable,
      // Phase 8.A: per-module unsafe opt-in flag (for kind-check / pure check).
      allowsUnsafe: env.allowsUnsafe,
      // Phase 8.A: callback that resolves a parser-emitted type annotation
      // to a Type in this module's scope. Used by expression-level type-arg
      // intrinsics (`unsafe_ptr.cast<U>(p)`, `unsafe_ptr.fromInt<T>(n)`).
      resolveTypeAnnotation: (annot) =>
        resolveTypeAnnotationInModule(annot, mod.id, moduleEnv, {
          registry: programState.registry,
        }),
    };

    // Phase 8.E: pass D.0 — typecheck module-level let/const initializers.
    // Runs before function bodies because module globals' types are needed
    // by IDENT resolution inside function bodies. Inits may freely call
    // functions defined in this module (their sigs were resolved in pass C).
    //
    // (Bytecode/CTE future) — each call to checkInitializer here is a
    // discrete unit a future evaluator could intercept: if the init expr
    // is purely constant-evaluable, emit the LLVM @global with the
    // computed value and drop this decl from the runtime init function.
    for (const d of mod.moduleInitDecls ?? []) {
      if (d.resolvedType?.kind === typeKinds.error) continue;
      validateModuleInit(d, typeContext, errors);
    }

    // pass D.1: validate all functions and methods (populates resolvedKindType on params)
    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      if (d.kind === ASTNodeKind.FUNCTION_DECL) {
        // Phase 7.1: generic functions are typechecked once with their type
        // params in scope. Per-instantiation IR emission happens in codegen.
        const tcForFn = d.genericDecl
          ? { ...typeContext, typeParamScope: d.genericDecl.paramScope }
          : typeContext;
        validateFunction(d, tcForFn, errors);
      } else if (d.kind === ASTNodeKind.TYPE_DECL && d.methods?.length > 0) {
        // Phase 7.x: generic struct methods are typechecked once against the
        // open self (with TypeParamType fields), then cloned + substituted per
        // instantiation at codegen time.
        const tcForMethod = d.genericDecl
          ? { ...typeContext, typeParamScope: d.genericDecl.paramScope }
          : typeContext;
        const selfShell = d.genericDecl ? d.openSelf : d.resolvedType;
        if (selfShell) {
          for (const method of d.methods) {
            validateMethod(method, selfShell, tcForMethod, errors);
          }
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

    // pass D.2: run kind check (escape analysis) now that all param kinds are resolved.
    // Generic function decls are included — kindCheck operates on the open
    // (TypeParamType-bearing) body since the obligations it stamps onto AST
    // nodes (pendingCleanups, implicitCleanups) are preserved by the
    // per-instance `cloneAstWithSubstitution` walk in codegen.
    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      if (d.kind === ASTNodeKind.FUNCTION_DECL) {
        runKindCheck(d, errors, funcDeclTable, programState.registry);
      } else if (d.kind === ASTNodeKind.TYPE_DECL && d.methods?.length > 0 && !d.genericDecl) {
        for (const method of d.methods) {
          runKindCheck(method, errors, funcDeclTable, programState.registry);
        }
      }
    }
    stampModuleId(errors, errStart, mod.id);
  }

  return { modules, errors, moduleEnv, programState };
}

// Stamp `moduleId` onto error records added to `errors` since `startIdx`.
// Used by typecheckProgram to attribute errors to the module being processed
// without threading moduleId through every pushError call site.
function stampModuleId(errors, startIdx, moduleId) {
  for (let i = startIdx; i < errors.length; i++) {
    if (errors[i].moduleId === undefined) errors[i].moduleId = moduleId;
  }
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
  // Phase 8.A: expose a thin resolver hook so expression-level type-arg
  // intrinsics (`unsafe_ptr.cast<U>(p)`, `unsafe_ptr.fromInt<T>(n)`) can
  // resolve their explicit type arguments.
  typeContext.resolveTypeAnnotation = (annot) =>
    resolveTypeAnnotation(annot, structTable, { typeParamScope: null });
  // Phase 8.A: gating — single-module path mirrors the typecheckProgram
  // walker. Modules that didn't opt into `import.unsafe;` cannot mention
  // any pointer surface.
  typeContext.allowsUnsafe = !!ast.allowsUnsafe;
  if (!ast.allowsUnsafe) {
    walkAstForUnsafe(ast, errors);
  }

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
          const baseType =
            resolveTypeAnnotation(p.typeAnnotation, structTable) ?? ErrorType();
          const t = p.isRef ? RefType(baseType) : baseType;
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
