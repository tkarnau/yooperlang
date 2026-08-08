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
import { expandDerives } from "../jsyoopderive/expand.js";
import {
  ArrayType,
  VariantType,
  ValueEnumType,
  ErrorType,
  isIntPrim,
  FuncType,
  KindApplication,
  KindType,
  PrimType,
  RefType,
  StructType,
  StructShell,
  fillStructShell,
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
  lookupAlias,
  formatAnnotation,
  TraitType,
  TraitSelfPlaceholder,
  typeKinds,
  typesEqual,
} from "./types.js";
import {
  createInstantiationRegistry,
  instantiateVariant,
  instantiateFunc,
  instantiateStruct,
  instantiateTrait,
  makeInstantiator,
} from "./instantiate.js";
import { setGlobalInstantiator } from "./types.js";
import { formatType, pushError, Severity } from "./errors.js";
import { coerceLiteralToType, isAssignable, unifyArith } from "./coerce.js";
import { detectRecursiveField } from "./recursiveStruct.js";
import { evalEnumValueExpr, autoIncrementValue } from "./constEvalEnum.js";
import {
  validateFunction,
  validateMethod,
  validateModuleInit,
  validatePrecompileBlock,
} from "./checkStatement.js";
import { resolveImports } from "./imports.js";
import { checkImportLocality } from "./importLocality.js";
import { runKindCheck } from "./kindCheck.js";
import { runKindFlow } from "./kindFlow.js";
import { lookupCoreKind, setCoreKinds } from "./coreKinds.js";

export { formatType, coerceLiteralToType, isAssignable, unifyArith };

// ─── helpers ─────────────────────────────────────────────────────────────────

// Phase 8.A: walks an annotation object (from parser) looking for any
// `unsafe_ptr` reference. Returns true if any subtree names the type.
function annotMentionsUnsafePtr(annot) {
  if (!annot) return false;
  // Both the bare `unsafe_ptr` (typeName) and the parametric `unsafe_ptr<T>`
  // (typeApplication) flow through here; both require `import.unsafe;`.
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
// enough - we do it once per module before pass C.
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
  // "typeApplication" / etc. - distinct from AST node kinds. Detect them
  // via the absence of a sourceLoc-shaped property *and* a string `kind`
  // that names a primitive/struct type or generic application. Cheap test:
  // if walking encounters such an object, run annotMentionsUnsafePtr on it.
  // We attach the error to the nearest enclosing AST node's sourceLoc by
  // passing it down - but that requires extra plumbing. For an MVP we use
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
// return the decl itself. ATTRIBUTE nodes (phase 11.A) that decorate a
// concrete decl are also unwrapped so every existing decl-walking pass
// sees the inner decl without having to know about attributes - the
// attribute metadata stays on the wrapper, which downstream pieces
// (e.g. the comptime pass, codegen) read through `decl.attributes`
// if they care. Today only `@precompile` decorates decls, and the
// metadata it needs is "this fold must succeed or hard-error" which
// the comptime pass reads off the inner decl via a flag stamped
// during pass C.4.
function innerDecl(decl) {
  if (decl.kind === ASTNodeKind.EXPORT_DECL) return decl.decl;
  if (decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL) return decl.fn;
  if (decl.kind === ASTNodeKind.ATTRIBUTE && decl.target) {
    return innerDecl(decl.target);
  }
  return decl;
}

// Resolve a type name within a multi-module context: checks local structs,
// primitive types, or structs imported via named imports.
function resolveTypeInModule(name, modId, moduleEnv) {
  const { structTable, importedNames, variantTable, unionTable, enumTable, vtableTable } =
    moduleEnv.get(modId);
  const local = structTable.get(name);
  // If local is a fully-resolved struct (fields !== null), use it.
  // If it's a shell (fields === null, from pass A / import copy), fall through
  // to importedNames so pass-C-resolved source versions are preferred.
  if (local && local.fields !== null) return local;
  const prim = primTypeFromName(name);
  if (prim) return prim;
  // Phase 7.5: variant / union nominal lookup. Both are sibling nominal types
  // alongside struct.
  const localVariant = variantTable?.get(name);
  if (localVariant) return localVariant;
  const localUnion = unionTable?.get(name);
  if (localUnion) return localUnion;
  // Phase 12: value-enum nominal lookup.
  const localValueEnum = enumTable?.get(name);
  if (localValueEnum) return localValueEnum;
  // Phase 9.G: vtable nominal lookup.
  const localVtable = vtableTable?.get(name);
  if (localVtable) return localVtable;
  const imp = importedNames.get(name);
  if (imp && imp.kind === "type") {
    const srcEnv = moduleEnv.get(imp.fromModuleId);
    const resolved =
      srcEnv?.structTable.get(imp.exportName) ??
      srcEnv?.variantTable?.get(imp.exportName) ??
      srcEnv?.unionTable?.get(imp.exportName) ??
      srcEnv?.enumTable?.get(imp.exportName) ??
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
    // Transparent type alias: resolve the alias RHS in the module that declared
    // it, so the result IS the underlying type (no distinct identity). Threads a
    // cycle-guard set so `type A = B; type B = A;` terminates (returns null,
    // surfaced as a clear error by the decl-site validation in pass C). The RHS
    // is resolved with no type-param/self scope - an alias is a top-level decl.
    const aliasHit = lookupAlias(annot.namespace, annot.name, modId, moduleEnv);
    if (aliasHit) {
      const stack = ctx?.aliasStack;
      if (stack?.has(aliasHit.key)) return null;
      const nextStack = new Set(stack ?? []);
      nextStack.add(aliasHit.key);
      return resolveTypeAnnotationInModule(aliasHit.annot, aliasHit.homeModId, moduleEnv, {
        ...ctx,
        typeParamScope: null,
        selfType: undefined,
        aliasStack: nextStack,
      });
    }
    // Phase 12: `ns.TypeName` qualifies the lookup through an imported
    // namespace's source module.
    if (annot.namespace) {
      return resolveNamespacedTypeName(annot.namespace, annot.name, modId, moduleEnv);
    }
    // Yoopstore-papercut #3: bare `unsafe_ptr` (no `<T>`) is the opaque
    // C-pointer handle. import.unsafe gating is handled by walkAstForUnsafe.
    if (annot.name === "unsafe_ptr") {
      return UnsafePtrType(null);
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
    // Phase 12: `ns.GenericName<...>` - namespace-qualified generic.
    if (annot.namespace) {
      return resolveNamespacedGenericApplication(
        annot.namespace, annot.name, argTypes, modId, moduleEnv, ctx,
      );
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
// Phase 10.A: also reaches into genericVariantTable.
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
  const localEnum = env.genericVariantTable?.get(name);
  if (localEnum) {
    if (argTypes.length !== localEnum.paramNames.length) return null;
    return instantiateVariant(registry, localEnum, argTypes);
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
      const remoteEnum = srcEnv.genericVariantTable?.get(imp.exportName);
      if (remoteEnum) {
        if (argTypes.length !== remoteEnum.paramNames.length) return null;
        return instantiateVariant(registry, remoteEnum, argTypes);
      }
    }
  }
  return null;
}

// Phase 12: resolve `ns.TypeName` in a type annotation. `ns` must be a local
// namespace binding; the name is looked up in the source module's nominal
// type tables (struct / variant / value-enum / union / vtable).
function resolveNamespacedTypeName(nsName, typeName, modId, moduleEnv) {
  const env = moduleEnv.get(modId);
  const imp = env.importedNames?.get(nsName);
  if (!imp || imp.kind !== "namespace") return null;
  const srcEnv = moduleEnv.get(imp.fromModuleId);
  if (!srcEnv) return null;
  return (
    srcEnv.structTable?.get(typeName) ??
    srcEnv.variantTable?.get(typeName) ??
    srcEnv.enumTable?.get(typeName) ??
    srcEnv.unionTable?.get(typeName) ??
    srcEnv.vtableTable?.get(typeName) ??
    null
  );
}

// Phase 12: resolve `ns.GenericName<args>` by walking the source module's
// generic tables for the looked-up name and instantiating.
function resolveNamespacedGenericApplication(nsName, typeName, argTypes, modId, moduleEnv, ctx) {
  const env = moduleEnv.get(modId);
  const imp = env.importedNames?.get(nsName);
  if (!imp || imp.kind !== "namespace") return null;
  const srcEnv = moduleEnv.get(imp.fromModuleId);
  const registry = ctx?.registry;
  if (!srcEnv || !registry) return null;
  const gs = srcEnv.genericStructTable?.get(typeName);
  if (gs) {
    if (argTypes.length !== gs.paramNames.length) return null;
    return instantiateStruct(registry, gs, argTypes);
  }
  const gt = srcEnv.genericTraitTable?.get(typeName);
  if (gt) {
    if (argTypes.length !== gt.paramNames.length) return null;
    return instantiateTrait(registry, gt, argTypes);
  }
  const gv = srcEnv.genericVariantTable?.get(typeName);
  if (gv) {
    if (argTypes.length !== gv.paramNames.length) return null;
    return instantiateVariant(registry, gv, argTypes);
  }
  return null;
}

// ─── propagation helpers (phase 6.4) ────────────────────────────────────────

// Return the list of KindType instances that a struct field carries.
// A field carries a kind iff:
//   - its `kindType` (resolved from `kindPrefix`) is set, OR
//   - its type is `Task<T>` (which inherently carries the `Task` builtin), OR
//   - its type is itself a struct that propagates kinds (transitive - every
//     kind the inner struct propagates is one this field carries).
// Phase 6.5: propagatedKinds entries are KindApplications; we still match
// by KindType identity (args don't affect propagation matching).
export function fieldCarriedKinds(field) {
  const out = [];
  if (field.kindType) out.push(field.kindType);
  if (field.type?.kind === "task") {
    const taskKind = lookupCoreKind("pooled");
    if (taskKind && !out.includes(taskKind)) out.push(taskKind);
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

// Phase 9.J: walk a trait's `extends` chain transitively, yielding each
// reachable ancestor (the trait itself is NOT yielded). Order is
// breadth-first; duplicates (a diamond shape) are dropped via identity-set.
export function* walkTraitExtends(trait) {
  const seen = new Set();
  const queue = [...(trait?.extendsTraits ?? [])];
  while (queue.length) {
    const t = queue.shift();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    yield t;
    for (const parent of t.extendsTraits ?? []) queue.push(parent);
  }
}

// Phase 9.J: cycle detection for the extends graph. `root` can be either a
// TraitType or a generic-trait decl record (since both carry `extendsTraits`).
// Returns true if walking parents reaches `root` again.
function traitExtendsHasCycle(root) {
  const seen = new Set();
  const stack = [...(root.extendsTraits ?? [])];
  while (stack.length) {
    const t = stack.pop();
    if (!t) continue;
    if (t === root) return true;
    if (seen.has(t)) continue;
    seen.add(t);
    for (const parent of t.extendsTraits ?? []) stack.push(parent);
  }
  return false;
}

// Two TraitTypes name the same trait when they share (name, moduleId). This
// is the same nominal identity `typesEqual` uses for traits (see
// instantiate.js). For generic traits, distinct instantiations
// (`Comparable<Num>` vs the open bound `Comparable<T>`) are different object
// instances but the SAME trait nominally - bound satisfaction must treat them
// as matching, since a struct implementing `Comparable<Num>` does satisfy a
// `<T implements Comparable<T>>` bound at T = Num. Generic type-arg agreement
// is not verified here (v0 limitation, consistent with name-based dispatch).
function traitNominalEq(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.name === b.name && a.moduleId === b.moduleId;
}

// Phase 9.J: true if `subject` is `target` or transitively extends it.
function traitIsOrExtends(subject, target) {
  if (!subject || !target) return false;
  if (traitNominalEq(subject, target)) return true;
  for (const t of walkTraitExtends(subject)) {
    if (traitNominalEq(t, target)) return true;
  }
  return false;
}

// Phase 7.2: returns { ok: true } if `argType` satisfies `requiredTrait`,
// otherwise { ok: false, message }. `mod` and `moduleEnv` aren't needed
// today but are passed in for symmetry with the resolution helpers above -
// future "trait impls registered in module X" lookups slot here.
// Phase 9.J: TypeParamType bounds are a list (`bounds`); satisfaction is OR
// across the list, walking each bound's `extends` chain transitively.
export function checkBoundSatisfied(argType, requiredTrait, _mod, _moduleEnv) {
  if (!argType || !requiredTrait) {
    return { ok: false, message: `internal: empty arg or bound` };
  }
  if (argType.kind === typeKinds.error) {
    // suppress secondary errors from a type that already failed to resolve
    return { ok: true };
  }
  // Phase 13.D: variants carry the same `implementsTraits` surface as structs
  // (13.B) and dispatch through the same mangling, so bound satisfaction is
  // the identical check.
  if (
    argType.kind === typeKinds.struct ||
    argType.kind === typeKinds.variant
  ) {
    for (const t of argType.implementsTraits ?? []) {
      if (traitIsOrExtends(t, requiredTrait)) return { ok: true };
    }
    return {
      ok: false,
      message: `type "${argType.name}" does not implement trait "${requiredTrait.name}"`,
    };
  }
  if (argType.kind === typeKinds.typeParam) {
    for (const b of argType.bounds ?? []) {
      if (traitIsOrExtends(b, requiredTrait)) return { ok: true };
    }
    return {
      ok: false,
      message: `type parameter "${argType.name}" does not satisfy bound "${requiredTrait.name}" - add 'implements ${requiredTrait.name}' to ${argType.name}'s declaration`,
    };
  }
  // primitives, refs, arrays, etc. - no impls today.
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

// Phase 7.2 / 9.J: resolve bound annotations on every type param of a generic
// decl and mutate the existing TypeParamType in `genericDecl.paramScope` to
// carry the resolved TraitType list. `astTypeParams` is the AST array (each
// entry has a `bounds: TraitAnnotation[]` slot set by the parser). Idempotent -
// already-populated bounds are skipped on re-entry.
function resolveAndAttachBounds(
  genericDecl,
  astTypeParams,
  mod,
  moduleEnv,
  programState,
  errors,
) {
  for (const tpNode of astTypeParams ?? []) {
    const boundAnnots = tpNode.bounds ?? [];
    if (boundAnnots.length === 0) continue;
    const tpType = genericDecl.paramScope.get(tpNode.name);
    if (!tpType || (tpType.bounds && tpType.bounds.length > 0)) continue;
    for (const annot of boundAnnots) {
      const result = resolveBoundTrait(
        annot,
        genericDecl.paramScope,
        mod,
        moduleEnv,
        programState,
      );
      if (!result) {
        errors.push({
          message: `unknown trait "${formatAnnotation(annot)}" in bound on type parameter "${tpNode.name}"`,
          sourceLoc: tpNode.sourceLoc,
        });
        continue;
      }
      if (result.notTrait) {
        errors.push({
          message: `bound on type parameter "${tpNode.name}" must be a trait, got "${formatAnnotation(annot)}"`,
          sourceLoc: tpNode.sourceLoc,
        });
        continue;
      }
      tpType.bounds.push(result);
    }
  }
}

// Phase 7.2: resolve a `T implements TraitAnnot` bound. Runs in pass C so that
// trait decls (incl. generic ones) and the current decl's own param scope are
// both visible - `<T implements Iterable<T>>` must resolve the inner `T` to the
// same TypeParamType that's already in scope.
//
// Returns the resolved TraitType or null on failure (caller pushes the error).
function resolveBoundTrait(annot, paramScope, mod, moduleEnv, programState) {
  // Non-generic trait lookup first - `resolveTypeInModule` only checks struct
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
  // Carry asyncness through the self-substitution, or the trait's
  // requirement arrives at sigsEqual looking synchronous and an impl
  // that disagrees is silently accepted.
  return FuncType(params, traitSig.returnType, false, [], !!traitSig.isAsync);
}

function sigsEqual(a, b) {
  if (a.params.length !== b.params.length) return false;
  for (let i = 0; i < a.params.length; i++) {
    if (!typesEqual(a.params[i].type, b.params[i].type)) return false;
  }
  // Asyncness is part of the signature: an async method has a different
  // ABI (it returns a coroutine handle) and a different calling rule
  // (`await`), so an impl that disagrees with its trait is a real
  // mismatch, not a cosmetic one.
  if (!!a.isAsync !== !!b.isAsync) return false;
  return typesEqual(a.returnType, b.returnType);
}

function formatSig(sig) {
  const params = sig.params.map((p) => `${p.isRef ? "ref " : ""}${formatType(p.type)}`).join(", ");
  return `${sig.isAsync ? "async " : ""}(${params}): ${formatType(sig.returnType)}`;
}

// Phase 9.G: validate a `vtable Name for TraitName { ... }` decl. The decl
// names a trait (by its name in the current module's scope) and declares
// one function-pointer field per trait method. Each field's FPT signature
// must match the trait method's signature minus the leading `ref self` (the
// stored function takes a ctx pointer in self's place - typed as `ref T`
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
      message: `vtable "${d.name}" cannot reference generic trait "${d.traitName}" (deferred - see plans/phase-9-g-vtables.md)`,
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
    // Stamp the trait method's asyncness onto the slot. An async trait
    // method needs an async-shaped slot (coroutine handle return + result
    // slot argument); the user's `=>` annotation has no way to say so, and
    // the trait is the authority for everything else about this field too.
    const finalFpt =
      fpt.isAsync === !!methodSig.isAsync
        ? fpt
        : FunctionPointerType(fpt.params, fpt.returnType, !!methodSig.isAsync);
    resolvedFields.push({
      name: methodName,
      type: mismatch ? ErrorType() : finalFpt,
    });
  }

  // Fill the pass-A shell IN PLACE rather than replacing it. A struct field
  // annotated with this vtable resolved during an earlier pass and is holding
  // a reference to the shell object; swapping the table entry would leave that
  // field pointing at a type with no method slots.
  shell.traitName = trait.name;
  shell.traitModuleId = trait.moduleId;
  shell.fields = resolvedFields;
  shell.methodOrder = methodOrder;
  env.vtableTable.set(d.name, shell);
  d.resolvedType = shell;
  d.resolvedTrait = trait;
}

function validateImplBlock(typeDecl, mod, moduleEnv, errors, programState) {
  const env = moduleEnv.get(mod.id);
  // Phase 13.B: variants share the same impl-block validation pipeline
  // as structs. The variant shell lives in `variantTable` and (since
  // 13.A) is the canonical mutable object; we populate its
  // implementsTraits + methods in place. Generic variants are deferred -
  // there's no `genericDecl` path for them today and the open-self
  // dance below is struct-shaped.
  const isVariant = typeDecl.kind === ASTNodeKind.VARIANT_DECL;
  const isEnum = typeDecl.kind === ASTNodeKind.ENUM_DECL;
  // Phase 7.x: for generic structs, build an "open" struct shell by
  // instantiating the generic decl with its own TypeParamTypes as args.
  // This yields a StructType whose field slots carry TypeParamType, suitable
  // for serving as `self` during method-sig resolution and substitution.
  const isGeneric = !!typeDecl.genericDecl;
  const typeParamScope = isGeneric ? typeDecl.genericDecl.paramScope : null;
  let structShell;
  if (isVariant) {
    structShell = env.variantTable.get(typeDecl.name);
    if (!structShell) return;
  } else if (isEnum) {
    structShell = env.enumTable.get(typeDecl.name);
    if (!structShell) return;
  } else if (isGeneric) {
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
    if (!structShell) {
      return;
    }
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
      // Generic trait - look up the generic decl and instantiate.
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

  // Phase 9.J: flatten the extends chain. A type implementing `Child` must
  // also provide methods declared on every ancestor; conversely, the type
  // implicitly implements every ancestor for downstream trait-method
  // dispatch. Walk each user-declared trait's extendsTraits transitively and
  // record every ancestor (de-duplicated by identity) into `flattenedImpls`.
  const flattenedImpls = [];
  const implsSeen = new Set();
  const addImpl = (t) => {
    if (!t || implsSeen.has(t)) return;
    implsSeen.add(t);
    flattenedImpls.push(t);
  };
  for (const t of resolvedImplements) {
    addImpl(t);
    for (const anc of walkTraitExtends(t)) addImpl(anc);
  }

  // Step 2: substitute self in each trait's required methods. Group by method
  // name so a single impl body can satisfy multiple traits that demand the
  // same name and signature (Phase 7.4 - cross-trait same-name impls are now
  // legal because every call site qualifies through the trait).
  const requiredMethods = new Map(); // methodName -> Array<{traitName, sig}>
  for (const trait of flattenedImpls) {
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

    // If more than one trait requires this name, their signatures must agree -
    // otherwise a single impl body can't satisfy both.
    let sigConflict = false;
    for (let i = 1; i < requiredList.length; i++) {
      if (!sigsEqual(requiredList[0].sig, requiredList[i].sig)) {
        errors.push({
          message: `method "${methodDecl.name}" required by traits "${requiredList[0].traitName}" and "${requiredList[i].traitName}" with incompatible signatures - cannot implement both`,
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
    const implSig = FuncType(params, returnType, false, [], !!methodDecl.isAsync);

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
  // Phase 9.J: store the flattened impls list (user-declared traits +
  // every extends ancestor, deduped) so downstream trait-method dispatch
  // doesn't need to re-walk the extends chain on every lookup.
  if (isVariant || isEnum) {
    // Phase 13.B: variants mutate the shell in place (same shape as the
    // 13.A variants-Map fix). No fresh VariantType, no table replacement -
    // so struct fields that captured the shell during their own
    // resolution see the populated implementsTraits + methods on their
    // next read.
    for (const t of flattenedImpls) {
      structShell.implementsTraits.push(t);
    }
    for (const [name, sig] of resolvedMethods) {
      structShell.methods.set(name, sig);
    }
    for (const m of typeDecl.methods ?? []) {
      m.implementingType = structShell;
    }
    return;
  }
  if (isGeneric) {
    // For generic decls, stash impls + methods on the genericDecl so
    // subsequent instantiateStruct calls produce concrete instances carrying
    // implementsTraits + methods. instantiateStruct reads these fields when
    // building each StructType (see instantiate.js).
    typeDecl.genericDecl.implementsTraits = flattenedImpls;
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
    flattenedImpls,
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

// Populate a KindType from a list of clause AST nodes. Used by named-kind
// resolution (pass C.2) and by inline-kind operands in compositions
// (pass C.2b). `displayName` appears in diagnostics; for inline kinds it's
// a placeholder like "(inline kind)".
function populateKindFromClauses(kt, clauses, displayName, mod, moduleEnv, errors) {
  const env = moduleEnv.get(mod.id);
  let mustCallSeen = false;
  let ownsBlockSeen = false;
  let mustNotEscapeSeen = false;
  let mustNotShareSeen = false;
  let layoutSeen = false;
  let markerSeen = false;
  let mustCallClause = null;
  // Duplicate detection for the two clauses pass A pre-scans (see the KIND_DECL
  // registration there). These MUST be local flags rather than a read of
  // `kt.pausable` / `kt.provides` - pass A has already populated those, so
  // testing the slot would report every pausable/provides kind as a duplicate.
  let pausableSeen = false;
  let providesSeen = false;
  let refcountedSeen = false;
  for (const c of clauses) {
    switch (c.kind) {
      case ASTNodeKind.KIND_MARKER_CLAUSE:
        if (markerSeen) {
          pushError(errors, c, `duplicate marker (conferred/restrictive) clause in kind '${displayName}'`);
          break;
        }
        markerSeen = true;
        kt.marker = c.polarity; // "conferred" | "restrictive"
        break;
      case ASTNodeKind.KIND_TRANSITION_CLAUSE: {
        if (c.direction === "clearedBy") {
          if (kt.clearedBy !== null) {
            pushError(errors, c, `duplicate clearedBy clause in kind '${displayName}'`);
          } else {
            kt.clearedBy = c.functionName;
          }
        } else {
          if (kt.appliedBy !== null) {
            pushError(errors, c, `duplicate appliedBy clause in kind '${displayName}'`);
          } else {
            kt.appliedBy = c.functionName;
          }
        }
        break;
      }
      case ASTNodeKind.KIND_APPLIES_TO_CLAUSE:
        // Store all sites from the multi-site list (parser validated at least one).
        for (const s of c.sites) kt.appliesTo.add(s);
        break;
      case ASTNodeKind.KIND_REQUIRES_CLAUSE: {
        // Look up the trait in both the concrete table and the generic-trait
        // table - a `requires` clause may reference either. The downstream
        // check (methods.has / genericMethods.has) handles both shapes.
        const trait =
          env.traitTable.get(c.traitName) ??
          env.genericTraitTable?.get(c.traitName) ??
          lookupImportedTrait(c.traitName, mod, moduleEnv);
        if (!trait) {
          pushError(errors, c, `unknown trait '${c.traitName}' in requires clause of kind '${displayName}'`);
          break;
        }
        kt.requires.push(trait);
        break;
      }
      case ASTNodeKind.KIND_MUSTCALL_CLAUSE:
        if (mustCallSeen) {
          pushError(errors, c, `duplicate mustCall clause in kind '${displayName}'`);
          break;
        }
        mustCallSeen = true;
        mustCallClause = c;
        break;
      case ASTNodeKind.KIND_OWNSBLOCK_CLAUSE:
        if (ownsBlockSeen) {
          pushError(errors, c, `duplicate ownsBlock clause in kind '${displayName}'`);
          break;
        }
        ownsBlockSeen = true;
        kt.ownsBlock = true;
        break;
      case ASTNodeKind.KIND_MUST_NOT_ESCAPE_CLAUSE:
        if (mustNotEscapeSeen) {
          pushError(errors, c, `duplicate mustNotEscape clause in kind '${displayName}'`);
          break;
        }
        mustNotEscapeSeen = true;
        kt.mustNotEscape = true;
        break;
      case ASTNodeKind.KIND_MUST_NOT_SHARE_CLAUSE:
        if (mustNotShareSeen) {
          pushError(errors, c, `duplicate mustNotShare clause in kind '${displayName}'`);
          break;
        }
        mustNotShareSeen = true;
        kt.mustNotShare.push(c.target);
        break;
      case ASTNodeKind.KIND_FORBIDS_CLAUSE:
        for (const cat of c.categories) {
          if (kt.forbids.includes(cat)) {
            pushError(errors, c, `duplicate forbids category '${cat}' in kind '${displayName}'`);
          } else {
            kt.forbids.push(cat);
          }
        }
        break;
      case ASTNodeKind.KIND_LAYOUT_CLAUSE: {
        if (layoutSeen) {
          pushError(errors, c, `duplicate layout clause in kind '${displayName}'`);
          break;
        }
        layoutSeen = true;
        const slot = resolveLayoutAlign(c.alignExpr, kt, errors);
        if (slot) kt.layoutAlign = slot;
        // Phase 8.B: store the abi "C" marker. Currently contractual -
        // no downstream consumer yet, but persisted so future codegen /
        // ABI-validation passes can read it off the resolved kind.
        if (c.abiC) kt.layoutAbiC = true;
        break;
      }
      // testing-via-kinds: `signature (p: T) => R;` - the raw annotation is
      // stashed here and resolved in pass C (resolveFunctionKindSignatures),
      // because it names user types that pass A has only registered as shells.
      case ASTNodeKind.KIND_SIGNATURE_CLAUSE:
        if (kt.signatureAnnotation) {
          pushError(errors, c, `duplicate signature clause in kind '${displayName}'`);
          break;
        }
        kt.signatureAnnotation = c.signatureAnnotation;
        break;
      // testing-via-kinds: `enumerable as "suites";`
      case ASTNodeKind.KIND_ENUMERABLE_CLAUSE:
        if (kt.enumerableAs !== null) {
          pushError(errors, c, `duplicate enumerable clause in kind '${displayName}'`);
          break;
        }
        kt.enumerableAs = c.tableName;
        break;
      // `pausable;` - functions carrying this kind are coroutines.
      case ASTNodeKind.KIND_PAUSABLE_CLAUSE:
        if (pausableSeen) {
          pushError(errors, c, `duplicate pausable clause in kind '${displayName}'`);
          break;
        }
        pausableSeen = true;
        kt.pausable = true;
        break;
      // `provides <Kind>;` - rewrites the call-site result type.
      case ASTNodeKind.KIND_PROVIDES_CLAUSE:
        if (providesSeen) {
          pushError(errors, c, `duplicate provides clause in kind '${displayName}'`);
          break;
        }
        providesSeen = true;
        kt.provides = c.providedName;
        break;
      // `refcounted <retain> <release>;` - names the two methods of the
      // required trait the compiler calls to bump and drop a reference.
      case ASTNodeKind.KIND_REFCOUNTED_CLAUSE:
        if (refcountedSeen) {
          pushError(errors, c, `duplicate refcounted clause in kind '${displayName}'`);
          break;
        }
        refcountedSeen = true;
        kt.refcounted = {
          retainMethod: c.retainMethod,
          releaseMethod: c.releaseMethod,
          // Filled in below, once `requires` has been collected. Null means
          // "no declaring trait found" - only a Task<T> receiver can be
          // refcounted then, since its retain/release bodies are compiler
          // provided rather than dispatched through a trait.
          traitType: null,
          sourceLoc: c.sourceLoc ?? null,
        };
        break;
    }
  }
  // testing-via-kinds: a function-position kind is deliberately narrow. It has
  // no value to be the receiver of a `mustCall`, no scope of its own to own,
  // and nothing to escape - the lifecycle of whatever it marks belongs to the
  // consumer that enumerates it. Only `signature` and `enumerable as` are legal
  // alongside `appliesTo function`, and both are required: without a signature
  // the collected table has no type, and without a table name nothing can ask
  // for it.
  if (kt.appliesTo.has("function")) {
    for (const otherSite of ["binding", "parameter", "field", "type", "return", "region"]) {
      if (kt.appliesTo.has(otherSite)) {
        pushError(errors, { sourceLoc: kt.sourceLoc ?? null },
          `kind '${displayName}' applies to a function and to '${otherSite}'; a function kind marks a declaration rather than a value, so it cannot also apply to a value site`);
      }
    }
    const disallowed = [];
    if (mustCallClause) disallowed.push("mustCall");
    if (ownsBlockSeen) disallowed.push("ownsBlock");
    if (mustNotEscapeSeen) disallowed.push("mustNotEscape");
    if (mustNotShareSeen) disallowed.push("mustNotShare");
    if (layoutSeen) disallowed.push("layout");
    if (markerSeen) disallowed.push("conferred/restrictive");
    if (kt.requires.length > 0) disallowed.push("requires");
    if (kt.forbids.length > 0) disallowed.push("forbids");
    if (kt.refcounted) disallowed.push("refcounted");
    for (const clauseName of disallowed) {
      pushError(errors, { sourceLoc: kt.sourceLoc ?? null },
        `kind '${displayName}' applies to a function and declares '${clauseName}'; a function kind marks a declaration rather than a value, so there is nothing for '${clauseName}' to act on`);
    }
    // `signature` + `enumerable as` are required only for a COLLECTED
    // function kind - one a consumer asks the compiler to enumerate, like
    // `suite`. A kind that instead changes what the function IS
    // (`pausable`, `provides`) is complete on its own: there is no table
    // for it to land in and no shared shape for its members. Requiring
    // both of every function kind is what kept `task` and `async` out of
    // std in the first place.
    const changesTheFunction = kt.pausable || kt.provides !== null;
    if (!changesTheFunction) {
      if (!kt.signatureAnnotation) {
        pushError(errors, { sourceLoc: kt.sourceLoc ?? null },
          `kind '${displayName}' applies to a function but declares no 'signature'; add e.g. \`signature (run: ref Run) => void;\` so functions carrying the kind can be checked and collected`);
      }
      if (kt.enumerableAs === null) {
        pushError(errors, { sourceLoc: kt.sourceLoc ?? null },
          `kind '${displayName}' applies to a function but declares no 'enumerable as "<table>"'; without a table name nothing can ask the compiler for these functions`);
      }
    }
  } else {
    if (kt.pausable) {
      pushError(errors, { sourceLoc: kt.sourceLoc ?? null },
        `kind '${displayName}' declares 'pausable' but does not declare 'appliesTo function'; only a function can pause`);
    }
    if (kt.provides !== null) {
      pushError(errors, { sourceLoc: kt.sourceLoc ?? null },
        `kind '${displayName}' declares 'provides' but does not declare 'appliesTo function'; only a function call has a result type to rewrite`);
    }
    if (kt.signatureAnnotation) {
      pushError(errors, { sourceLoc: kt.sourceLoc ?? null },
        `kind '${displayName}' declares 'signature' but does not declare 'appliesTo function'; a signature only constrains a function declaration`);
    }
    if (kt.enumerableAs !== null) {
      pushError(errors, { sourceLoc: kt.sourceLoc ?? null },
        `kind '${displayName}' declares 'enumerable as' but does not declare 'appliesTo function'; only function kinds can be enumerated`);
    }
  }
  // clearance kinds: a marker kind (conferred/restrictive) carries no
  // obligation, so it cannot also declare mustCall - the two discharge
  // models are mutually exclusive.
  if (markerSeen && mustCallClause) {
    pushError(errors, mustCallClause,
      `kind '${displayName}' declares a marker polarity (conferred/restrictive) and 'mustCall'; a marker kind carries no obligation, so the two are mutually exclusive`);
  }
  // clearance kinds: transition clauses must match the kind's polarity.
  // `clearedBy` only makes sense on a restrictive kind (stripping a hazard);
  // `appliedBy` only on a conferred kind (minting a capability).
  if (kt.clearedBy !== null && kt.marker !== "restrictive") {
    pushError(errors, { sourceLoc: kt.sourceLoc ?? null },
      `kind '${displayName}' declares 'clearedBy ${kt.clearedBy}' but is not restrictive; clearedBy only applies to restrictive marker kinds`);
  }
  if (kt.appliedBy !== null && kt.marker !== "conferred") {
    pushError(errors, { sourceLoc: kt.sourceLoc ?? null },
      `kind '${displayName}' declares 'appliedBy ${kt.appliedBy}' but is not conferred; appliedBy only applies to conferred marker kinds`);
  }
  // clearance kinds: the named transition method must be declared by one of
  // the required traits. The trait is the structural authority; the method
  // name is what the kind decl picks out of that trait. Mirrors how
  // `mustCall` resolves against a `requires Disposable;` clause.
  for (const [direction, methodName] of [
    ["clearedBy", kt.clearedBy],
    ["appliedBy", kt.appliedBy],
  ]) {
    if (methodName === null) continue;
    if (kt.requires.length === 0) {
      pushError(errors, { sourceLoc: kt.sourceLoc ?? null },
        `kind '${displayName}' declares '${direction} ${methodName}' but no 'requires <Trait>;' clause; the trait is the authority that names the method`);
      continue;
    }
    const traitWithMethod = kt.requires.find((t) =>
      (t.methods ?? t.genericMethods)?.has(methodName),
    );
    if (!traitWithMethod) {
      const traitNames = kt.requires.map((t) => t.name).join(", ");
      pushError(errors, { sourceLoc: kt.sourceLoc ?? null },
        `kind '${displayName}' declares '${direction} ${methodName}' but no required trait (${traitNames}) declares a method by that name`);
    }
  }
  // mustCall resolution runs after requires have been collected so we can
  // search the full trait set.
  if (mustCallClause && !markerSeen) {
    if (kt.requires.length === 0) {
      pushError(errors, mustCallClause,
        `mustCall requires at least one 'requires' clause to resolve method '${mustCallClause.methodName}' in kind '${displayName}'`);
    } else {
      const traitWithMethod = kt.requires.find((t) =>
        (t.methods ?? t.genericMethods)?.has(mustCallClause.methodName),
      );
      if (!traitWithMethod) {
        pushError(errors, mustCallClause,
          `mustCall ${mustCallClause.methodName}: no required trait declares this method in kind '${displayName}'`);
      } else {
        kt.mustCall.push({
          methodName: mustCallClause.methodName,
          timing: mustCallClause.timing,
          traitType: traitWithMethod,
        });
      }
    }
  }
  // refcounted resolution runs after `requires` has been collected, exactly
  // like mustCall above: the clause names two METHODS, and the trait that
  // declares them is how a NON-Task receiver dispatches them. `Task<T>` is the
  // exception - it is a compiler type that cannot carry an `implements` list,
  // and its retain/release bodies lower to yoop_task_* directly (see
  // coreKinds.js), so an unresolved trait is not an error here. It only means
  // this kind can be applied to a Task and nothing else.
  if (kt.refcounted && kt.requires.length > 0) {
    const { retainMethod, releaseMethod } = kt.refcounted;
    const traitWithBoth = kt.requires.find((t) => {
      const m = t.methods ?? t.genericMethods;
      return !!m?.has(retainMethod) && !!m?.has(releaseMethod);
    });
    if (traitWithBoth) {
      kt.refcounted.traitType = traitWithBoth;
    } else {
      const traitNames = kt.requires.map((t) => t.name).join(", ");
      pushError(errors, { sourceLoc: kt.refcounted.sourceLoc },
        `refcounted ${retainMethod} ${releaseMethod}: no required trait (${traitNames}) declares both methods in kind '${displayName}'`);
    }
  }
  // region kinds: a kind that `appliesTo region` governs a lexical scope, not a
  // named value. It is used only in the anonymous block form
  // (`<kind> EXPR { ... }` / `<kind> EXPR;`), so it must own a block and cannot
  // also apply to a value site (binding/parameter/field/type/return) - the two
  // are conceptually distinct (a resource you hold vs. an ambient state change
  // over a scope), and the use-site syntax for each is disjoint.
  if (kt.appliesTo.has("region")) {
    if (!ownsBlockSeen) {
      pushError(errors, { sourceLoc: kt.sourceLoc ?? null },
        `kind '${displayName}' applies to a region but does not declare 'ownsBlock'; a region kind governs a block, so ownsBlock is required`);
    }
    for (const valueSite of ["binding", "parameter", "field", "type", "return"]) {
      if (kt.appliesTo.has(valueSite)) {
        pushError(errors, { sourceLoc: kt.sourceLoc ?? null },
          `kind '${displayName}' applies to a region and to '${valueSite}'; a region kind has no named value, so it cannot also apply to a value site`);
      }
    }
  }
}

// Pass C.2: walk each kind decl and resolve its clauses against the module's
// trait table. `requires` clauses populate kt.requires; `mustCall` clauses
// resolve their method name against the union of required-trait method sets.
// Verify std/core/kinds.yoop declared every kind the compiler depends on,
// with the clauses it depends on. See REQUIRED_CORE_KINDS.
//
// Silent when NOTHING was found: the legacy single-module typecheck path
// has no module graph and therefore no std, and it does not support tasks
// either. A PARTIAL core is a real error - that means the file exists and
// something was edited out of it.
function assertRequiredCoreKinds(coreKinds, errors) {
  if (coreKinds.size === 0) return;
  for (const [name, spec] of REQUIRED_CORE_KINDS) {
    const kt = coreKinds.get(name);
    if (!kt) {
      errors.push({
        message:
          `${CORE_KINDS_MODULE} must declare the kind '${name}' - the compiler depends on it. ` +
          `Expected: kind ${name} { ${spec.want} }`,
        sourceLoc: null,
      });
      continue;
    }
    if (!spec.check(kt)) {
      errors.push({
        message:
          `${CORE_KINDS_MODULE}'s kind '${name}' is missing a clause the compiler depends on. ` +
          `Expected at least: kind ${name} { ${spec.want} }`,
        sourceLoc: kt.sourceLoc ?? null,
      });
    }
  }
}

function resolveKindClauses(mod, moduleEnv, errors) {
  for (const decl of mod.ast.body) {
    const d = innerDecl(decl);
    if (d.kind !== ASTNodeKind.KIND_DECL) continue;
    const kt = d.resolvedKindType;
    if (!kt) continue; // rejected in pass A
    // Composition decls have no clauses - they get merged in C.2b.
    if (d.composition) continue;
    populateKindFromClauses(kt, d.clauses, kt.name, mod, moduleEnv, errors);
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
// Derive a function decl's coroutine flags from the CLAUSES of the kinds it
// carries, rather than from the kind's name.
//
// The parser sets `isTask`/`isAsync` from the literal names `task`/`async`
// (parser.js `applyFunctionKindPrefixes`) because it cannot resolve kinds - it
// runs before there is a kind table at all. That is still the fallback, and it
// is what keeps the legacy single-module path (no module graph, therefore no
// std) working. This runs on top of it, in pass C where kinds ARE resolvable,
// so a kind that declares the clauses gets the behavior the clauses describe:
//
//   kind spawn { appliesTo function; pausable; provides Task; }
//   spawn function work(): int32 { ... }     // now a coroutine returning Task<int32>
//
// Additive on purpose - it can only turn a flag ON. std's `task` and `async`
// therefore behave identically whether they resolve here or not, which keeps
// this from becoming a second, disagreeing source of truth for the core kinds.
// `lookupCoreKind` is the reason `task`/`async` resolve at all in a module that
// never imported them.
function deriveFunctionKindFlags(funcDecl, modEnv) {
  for (const prefix of funcDecl.kindPrefixes ?? []) {
    const kt =
      (modEnv ? lookupKindByName(prefix.name, modEnv) : null) ??
      lookupCoreKind(prefix.name);
    if (!kt) continue;
    // `provides` implies the function is spawned rather than called, and
    // every such spawn needs a frame to suspend into - so it implies async
    // the same way std's `task` does (which is why `async task` is noise).
    if (kt.provides === "Task") {
      funcDecl.isTask = true;
      funcDecl.isAsync = true;
    }
    if (kt.pausable) funcDecl.isAsync = true;
  }
}

function lookupKindByName(name, modEnv) {
  const fromTable = modEnv.kindTable?.get(name);
  if (fromTable) return fromTable;
  // builtin lookup is centralized in builtinKinds.js
  // but joined/pooled/Task aren't typically composed; the kind table
  // already has Task seeded.
  return null;
}

// Build a KindApplication from a use-site kind prefix: validate arg count,
// evaluate args to constants. Site applicability is NOT checked here -
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

    // Resolve each reference. Inline operands `{ ... }` produce an anonymous
    // KindType populated from their clauses; named operands are looked up in
    // the kindTable. Both shapes flow through the same flatten loop below.
    const refs = [];
    for (const ref of d.composition.kindRefs) {
      if (ref.inline) {
        const anon = new KindType(`(inline kind in '${kt.name}')`, mod.id);
        populateKindFromClauses(anon, ref.clauses, anon.name, mod, moduleEnv, errors);
        refs.push({ target: anon, args: [], sourceLoc: ref.sourceLoc, inline: true });
        continue;
      }
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
    kt.composedFrom = refs.map((r) =>
      r.inline ? { inline: true } : { name: r.target.name, args: r.args },
    );

    if (refs.length === 0) {
      // Nothing to merge; leave kt with empty slots.
      continue;
    }

    // Compute appliesTo as the intersection of components'. Inline operands
    // with no explicit appliesTo are treated as "applies anywhere" and don't
    // constrain the intersection - parser rejects inline appliesTo today so
    // every inline op falls into this branch in practice.
    let intersected = null;
    for (const r of refs) {
      if (r.inline && r.target.appliesTo.size === 0) continue;
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
      // requires - union by trait identity.
      for (const t of target.requires) {
        if (
          !kt.requires.some(
            (e) => e.name === t.name && (e.moduleId ?? null) === (t.moduleId ?? null),
          )
        ) {
          kt.requires.push(t);
        }
      }
      // mustCall - contradiction if two components disagree on method name.
      for (const mc of target.mustCall) {
        if (mustCallEntry && mustCallEntry.methodName !== mc.methodName) {
          pushError(errors, d,
            `composition contradiction in kind '${kt.name}': mustCall ${mustCallSourceName} vs mustCall ${mc.methodName}`);
        } else if (!mustCallEntry) {
          mustCallEntry = mc;
          mustCallSourceName = mc.methodName;
        }
      }
      // ownsBlock, mustNotEscape - boolean union.
      if (target.ownsBlock) kt.ownsBlock = true;
      if (target.mustNotEscape) kt.mustNotEscape = true;
      // mustNotShare, forbids - set union.
      for (const s of target.mustNotShare) {
        if (!kt.mustNotShare.includes(s)) kt.mustNotShare.push(s);
      }
      for (const f of target.forbids) {
        if (!kt.forbids.includes(f)) kt.forbids.push(f);
      }
      // layoutAlign - contradiction if two components specify different
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

// Canonical declIds for every compiler-recognized intrinsic. The keys are
// the names a user writes inside an `extern "intrinsic" from "compiler"`
// block; the values are the stable declIds codegen dispatches on.
//
// An extern "intrinsic" declaration whose name isn't in this map is rejected
// in pass A. A user-defined function with one of these names is allowed -
// the auto-injection that used to shadow such names was removed when these
// became opt-in via import.
// The concurrency kinds the compiler depends on. They are declared as
// ordinary `kind { ... }` decls in std/core/kinds.yoop (autoloaded into
// every module graph); this table is the carve-out that makes it a CHECKED
// contract rather than a convention - each entry names the clauses the
// compiler will actually consult, and a missing or reshaped decl is an
// error naming the file.
//
// See plans/kinds-in-std.md.
export const CORE_KINDS_MODULE = "std/core/kinds.yoop";
export const REQUIRED_CORE_KINDS = new Map([
  ["task", {
    check: (k) => k.appliesTo.has("function") && k.pausable && k.provides === "Task",
    want: "appliesTo function; pausable; provides Task;",
  }],
  ["async", {
    check: (k) => k.appliesTo.has("function") && k.pausable,
    want: "appliesTo function; pausable;",
  }],
  ["joined", {
    check: (k) =>
      k.appliesTo.has("binding") &&
      k.mustCall.length > 0 &&
      k.mustNotEscape,
    want: "appliesTo binding; requires Joinable; mustCall join beforeScopeEnd; mustNotEscape scope;",
  }],
  ["pooled", {
    check: (k) =>
      k.appliesTo.has("binding") && k.appliesTo.has("field") && k.refcounted !== null,
    want: "appliesTo binding parameter field; requires Shared; refcounted retain release;",
  }],
]);

export const INTRINSIC_DECL_IDS = new Map([
  ["heap_alloc", "$builtin__heap_alloc"],
  ["heap_free", "$builtin__heap_free"],
  // Context-routed siblings of heap_alloc/heap_free: allocate/free through the
  // current allocator (std/core/alloc.yoop) instead of raw malloc/free.
  ["ctx_alloc", "$builtin__ctx_alloc"],
  ["ctx_free", "$builtin__ctx_free"],
  ["string_as_bytes", "$builtin__string_as_bytes"],
  ["string_from_bytes_unchecked", "$builtin__string_from_bytes_unchecked"],
  ["array_slice", "$builtin__array_slice"],
  ["wait_until", "$builtin__wait_until"],
  ["cancel", "$builtin__cancel"],
  // The async suspend primitive. Non-generic, and lowered inline by
  // codegen (a bare coro.suspend) rather than to any call, so unlike the
  // entries above it needs no makeBuiltinGenericFuncs counterpart.
  ["suspendNow", "$builtin__suspendNow"],
  // Note: `printf` stays magic - it's used by ~all examples and the name
  // never collides with user identifiers in practice. Lives outside this
  // map so it isn't subject to the import-required rule.
]);

// Builtin generic functions - `heap_alloc<T>(n: usize): T[]` and friends.
// Built once per program, then installed into a module's genericFuncTable
// only when the module imports them (via the std/core/intrinsics.yoop
// extern "intrinsic" block). Codegen intercepts by `declId` (see codegen.js)
// and emits malloc/free/bitcast/etc directly without a body clone.
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
  // NOT validate UTF-8 - that's the wrapping `string_from_bytes` function's
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

  // Context-routed allocation: same shapes as heap_alloc/heap_free, but codegen
  // lowers the malloc/free to yoop_ctx_alloc/yoop_ctx_free (current allocator).
  const ctxAllocDeclId = "$builtin__ctx_alloc";
  const ctxAllocT = new TypeParamType("T", ctxAllocDeclId);
  const ctxAlloc = {
    id: ctxAllocDeclId,
    name: "ctx_alloc",
    moduleId: "$builtin",
    paramNames: ["T"],
    paramScope: new Map([["T", ctxAllocT]]),
    genericSig: FuncType(
      [{ name: "n", type: PrimType("usize"), isRef: false }],
      ArrayType(ctxAllocT),
    ),
    ast: null,
    isBuiltin: true,
  };

  const ctxFreeDeclId = "$builtin__ctx_free";
  const ctxFreeT = new TypeParamType("T", ctxFreeDeclId);
  const ctxFree = {
    id: ctxFreeDeclId,
    name: "ctx_free",
    moduleId: "$builtin",
    paramNames: ["T"],
    paramScope: new Map([["T", ctxFreeT]]),
    genericSig: FuncType(
      [{ name: "a", type: ArrayType(ctxFreeT), isRef: false }],
      VoidType(),
    ),
    ast: null,
    isBuiltin: true,
  };

  return [heapAlloc, heapFree, arraySlice, stringAsBytes, stringFromBytesUnchecked, ctxAlloc, ctxFree];
}

// ─── multi-module entry point ─────────────────────────────────────────────────

// typecheckProgram(modules) - main entry for multi-file compilation.
// modules: topologically sorted (leaves first).
// Returns { modules, errors, moduleEnv }.
export function typecheckProgram(modules) {
  const errors = [];
  // Phase 13.C: @derive(display) expansion. Runs before pass A so grafted
  // to_string methods and appended `implements Display` clauses flow through
  // the ordinary passes; consumes every top-level derive ATTRIBUTE wrapper.
  expandDerives(modules, errors);
  const moduleEnv = new Map(); // moduleId -> { localSymbols, structTable, exports, importedNames, linkLibraries }
  // Phase 7.1: program-wide instantiation registry, shared across modules.
  const programState = {
    registry: createInstantiationRegistry(),
  };
  // Wire the registry-aware instantiator so substituteTypeParams can
  // re-instantiate open generic struct types into their concrete forms.
  setGlobalInstantiator(makeInstantiator(programState.registry));

  // Build builtin generic func decls once and reuse across all modules so
  // the instantiation registry caches by a stable declId. Indexed by name
  // for lookup from extern "intrinsic" declarations in pass A.
  const builtinGenericDeclsByName = new Map(
    makeBuiltinGenericFuncs().map((d) => [d.name, d]),
  );

  // Phase 7.2: install the bound checker. Every instantiate*() that hits the
  // cache for the first time calls back here with each bounded (param, arg)
  // pair. Source-location tracking happens via the call-site error path in
  // checkExpr; this back-channel catches instantiations triggered by type
  // annotations (e.g. fields with `Box<NotImpl>`).
  // Re-fetch the canonical struct / variant for a bound check - an argType
  // captured through an imported instantiation (e.g. the elem type inside a
  // Vec<T> field) can be a pass-A shell with an empty `implementsTraits`.
  // Same hazard and fix as canonicalNominalType in checkExpr.js.
  const canonicalForBoundCheck = (argType) => {
    if (!argType) return argType;
    const isStruct = argType.kind === typeKinds.struct;
    const isVariant = argType.kind === typeKinds.variant;
    if (!isStruct && !isVariant) return argType;
    const env = argType.moduleId ? moduleEnv.get(argType.moduleId) : null;
    const table = isStruct ? env?.structTable : env?.variantTable;
    return table?.get(argType.name) ?? argType;
  };
  programState.registry.boundChecker = ({
    genericDecl,
    argType,
    paramName,
    requiredTrait,
  }) => {
    const res = checkBoundSatisfied(canonicalForBoundCheck(argType), requiredTrait);
    if (res.ok) return;
    errors.push({
      message: `type argument for parameter "${paramName}" of generic "${genericDecl.name}" does not satisfy bound: ${res.message}`,
      sourceLoc: genericDecl.ast?.sourceLoc ?? null,
    });
  };

  // pass A: register struct shells so cross-module struct refs work in pass B
  // Populated as the autoloaded std/core/kinds.yoop declares them, then
  // seeded into every later module so `pooled h = f()` resolves without an
  // explicit import - which is the behavior these had as reserved words.
  const coreKinds = new Map();
  setCoreKinds(coreKinds);
  for (const mod of modules) {
    const errStart = errors.length;
    // modules-as-directories: every table below belongs to the MODULE, not to
    // this source file, so a directory module's second and later files reuse
    // the ones its first file created. `reused` gates the one-time seeding
    // below (re-seeding coreKinds into a populated kindTable would report a
    // redeclaration against the module's own first file).
    const reused = moduleEnv.get(mod.id);
    const localSymbols = reused?.localSymbols ?? new Map();
    const structTable = reused?.structTable ?? new Map();
    const exports = reused?.exports ?? new Set();
    const importedNames = reused?.importedNames ?? new Map();
    const linkLibraries = reused?.linkLibraries ?? new Set();
    const traitTable = reused?.traitTable ?? new Map();
    const kindTable = reused?.kindTable ?? new Map();
    // The declaring module itself gets nothing here (coreKinds is still
    // empty when it runs), so this never trips the redeclaration check.
    if (!reused) {
      for (const [coreName, coreKind] of coreKinds) kindTable.set(coreName, coreKind);
    }
    // Phase 7.1: generic decl tables - generic decls live here and never
    // enter structTable/localSymbols/traitTable (those are monomorphic only).
    const genericStructTable = reused?.genericStructTable ?? new Map();
    const genericFuncTable = reused?.genericFuncTable ?? new Map();
    const genericTraitTable = reused?.genericTraitTable ?? new Map();
    // Phase 10.A: generic enum decls. Sibling of genericStructTable; variantTable
    // stays monomorphic.
    const genericVariantTable = reused?.genericVariantTable ?? new Map();
    // Phase 7.5: variant / union tables. Like structTable, these hold a "shell"
    // value after pass A and are populated with field types in pass C.
    const variantTable = reused?.variantTable ?? new Map();
    const unionTable = reused?.unionTable ?? new Map();
    // Phase 12: value-enum table - nominal aliases over primitive underlying
    // types. Separate from variantTable: different runtime shape (raw
    // primitive vs tagged payload) and different switch semantics.
    const enumTable = reused?.enumTable ?? new Map();
    // Phase 9.G: vtable type table. Like structTable, the shell only carries
    // a name in pass A; pass C resolves field types and trait references.
    const vtableTable = reused?.vtableTable ?? new Map();
    // Transparent type aliases (`type NodeId = usize;`). Maps the alias name to
    // the parsed RHS type annotation; resolution happens lazily at every use
    // site (see resolveTypeAnnotationInModule) so an alias to a struct picks up
    // the same shell-then-filled type object a direct reference would. The alias
    // is NOT a distinct type - it resolves straight through to the underlying
    // type, so nothing downstream (coercion, indexing, codegen) sees the name.
    const aliasTable = reused?.aliasTable ?? new Map();
    // Names this module brought into scope via an `extern "intrinsic"`
    // block. checkExpr.js's special-case paths for `wait_until` / `cancel`
    // gate on membership here so that user code that hasn't imported the
    // intrinsics module can freely shadow these names.
    const builtinIntrinsicNames = reused?.builtinIntrinsicNames ?? new Set();
    // `Task` used to be seeded here from a hardcoded object. It is declared
    // in std/core/kinds.yoop now and arrives via the coreKinds seeding
    // above, like `pooled` and `joined`.

    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      // Phase 7.5: register an enum shell so pass C can resolve variant fields.
      // Phase 10.A: generic enums register a genericDecl in genericVariantTable
      // (concrete tables stay monomorphic).
      if (d.kind === ASTNodeKind.VARIANT_DECL) {
        const hasTypeParams = d.typeParams && d.typeParams.length > 0;
        if (hasTypeParams) {
          if (
            genericVariantTable.has(d.name) ||
            variantTable.has(d.name) ||
            structTable.has(d.name) ||
            genericStructTable.has(d.name) ||
            unionTable.has(d.name) ||
            enumTable.has(d.name) ||
            aliasTable.has(d.name)
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
              genericKind: "variant", // dispatch tag for makeInstantiator
              name: d.name,
              moduleId: mod.id,
              paramNames,
              paramScope,
              genericVariants: null, // filled in pass C
              ast: d,
            };
            genericVariantTable.set(d.name, genericDecl);
            d.genericDecl = genericDecl;
          }
          if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
          continue;
        }
        if (
          variantTable.has(d.name) ||
          structTable.has(d.name) ||
          unionTable.has(d.name) ||
          enumTable.has(d.name) ||
          aliasTable.has(d.name)
        ) {
          errors.push({
            message: `redeclaration of type "${d.name}"`,
            sourceLoc: d.sourceLoc,
          });
        } else {
          // Shell - variants Map left empty; pass C populates fields.
          variantTable.set(d.name, VariantType(d.name, new Map(), mod.id));
        }
        if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
        continue;
      }
      if (d.kind === ASTNodeKind.UNION_DECL) {
        if (
          variantTable.has(d.name) ||
          structTable.has(d.name) ||
          unionTable.has(d.name) ||
          enumTable.has(d.name) ||
          aliasTable.has(d.name)
        ) {
          errors.push({
            message: `redeclaration of type "${d.name}"`,
            sourceLoc: d.sourceLoc,
          });
        } else {
          // Shell - fields filled in pass C.
          unionTable.set(d.name, UnionType(d.name, [], mod.id));
        }
        if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
        continue;
      }
      // Phase 12: value enum decl. Shell registered here; pass C resolves
      // the underlying type, const-evaluates each case value, and freezes.
      if (d.kind === ASTNodeKind.ENUM_DECL) {
        if (
          variantTable.has(d.name) ||
          structTable.has(d.name) ||
          unionTable.has(d.name) ||
          enumTable.has(d.name) ||
          aliasTable.has(d.name)
        ) {
          errors.push({
            message: `redeclaration of type "${d.name}"`,
            sourceLoc: d.sourceLoc,
          });
        } else {
          // Shell - underlying is null + cases empty; pass C fills both.
          enumTable.set(d.name, ValueEnumType(d.name, null, new Map(), [], new Map(), mod.id, false));
        }
        if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
        continue;
      }
      if (d.kind === ASTNodeKind.TYPE_DECL && d.targetType) {
        // Transparent type alias: `type Name = <annotation>;`. Registered in a
        // dedicated table - never in structTable (which holds monomorphic struct
        // types only). The RHS annotation is resolved lazily at each use site.
        if (d.typeParams && d.typeParams.length > 0) {
          errors.push({
            message: `generic type aliases are not yet supported - declare "${d.name}" without type parameters`,
            sourceLoc: d.sourceLoc,
          });
        } else if (
          structTable.has(d.name) ||
          genericStructTable.has(d.name) ||
          variantTable.has(d.name) ||
          unionTable.has(d.name) ||
          enumTable.has(d.name) ||
          aliasTable.has(d.name)
        ) {
          errors.push({
            message: `redeclaration of type "${d.name}"`,
            sourceLoc: d.sourceLoc,
          });
        } else {
          aliasTable.set(d.name, { annot: d.targetType, sourceLoc: d.sourceLoc });
        }
        if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
      } else if (d.kind === ASTNodeKind.TYPE_DECL) {
        const hasTypeParams = d.typeParams && d.typeParams.length > 0;
        if (hasTypeParams) {
          // Phase 7.1: generic struct decl. Register in genericStructTable.
          if (genericStructTable.has(d.name) || structTable.has(d.name) || aliasTable.has(d.name)) {
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
          if (structTable.has(d.name) || genericStructTable.has(d.name) || aliasTable.has(d.name)) {
            errors.push({
              message: `redeclaration of type "${d.name}"`,
              sourceLoc: d.sourceLoc,
            });
          } else {
            // Unfrozen shell: pass C fills THIS object rather than replacing
            // the table entry, so a field that resolves to this struct before
            // its body is resolved still ends up pointing at the populated
            // type. See StructShell in types.js for what replacing broke.
            structTable.set(d.name, StructShell(d.name, mod.id));
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
        const isIntrinsic = decl.abi === "intrinsic";
        for (const ext of decl.decls) {
          if (
            ext.kind === ASTNodeKind.EXTERN_TYPE_DECL &&
            !structTable.has(ext.name)
          ) {
            structTable.set(ext.name, StructType(ext.name, [], mod.id));
          }
          if (ext.kind === ASTNodeKind.EXTERN_FUNCTION_DECL) {
            if (isIntrinsic) {
              // Reject unknown intrinsics - user code can't fabricate fake ones.
              const canonicalDeclId = INTRINSIC_DECL_IDS.get(ext.name);
              if (!canonicalDeclId) {
                errors.push({
                  message: `unknown intrinsic "${ext.name}" - see std/core/intrinsics.yoop for the full list`,
                  sourceLoc: ext.sourceLoc,
                });
                continue;
              }
              ext.intrinsicDeclId = canonicalDeclId;
              builtinIntrinsicNames.add(ext.name);

              // Generic intrinsic - install the pre-built canonical decl so
              // the instantiation registry can cache by its stable declId.
              // Pass C will skip the type-resolution step for these.
              const canonicalGenericDecl = builtinGenericDeclsByName.get(ext.name);
              if (canonicalGenericDecl) {
                if (
                  genericFuncTable.has(ext.name) ||
                  localSymbols.has(ext.name)
                ) {
                  errors.push({
                    message: `redeclaration of "${ext.name}"`,
                    sourceLoc: ext.sourceLoc,
                  });
                  continue;
                }
                genericFuncTable.set(ext.name, canonicalGenericDecl);
                exports.add(ext.name);
                continue;
              }

              // Non-generic intrinsic (printf, wait_until, cancel) - fall
              // through to the regular extern shell path. Pass C resolves
              // the user-written parameter/return types; checkExpr.js
              // recognizes the name via builtinIntrinsicNames.
            }
            if (localSymbols.has(ext.name)) {
              errors.push({
                message: `redeclaration of "${ext.name}"`,
                sourceLoc: ext.sourceLoc,
              });
            } else {
              localSymbols.set(ext.name, FuncType([], ErrorType()));
              if (isIntrinsic) exports.add(ext.name);
            }
          }
        }
        if (!isIntrinsic && decl.source.kind === "library")
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
          variantTable.has(d.name) ||
          unionTable.has(d.name) ||
          traitTable.has(d.name) ||
          aliasTable.has(d.name) ||
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
          kt.sourceLoc = d.sourceLoc ?? null;
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
          // Pre-scan the two clauses a FUNCTION SIGNATURE depends on.
          // `pausable` decides the coroutine ABI and `provides` rewrites the
          // call-site result type, and signatures are built in pass C - which
          // runs BEFORE pass C.2 resolves clauses, and before C.2 has run at
          // all for a kind declared in the same module that uses it. Neither
          // clause needs the trait table (one is a bare flag, the other a
          // name), so both are safe to read this early. C.2 still owns
          // validation; it tracks duplicates with local flags rather than by
          // reading these slots, so populating them here is not a "duplicate".
          for (const c of d.clauses ?? []) {
            if (c.kind === ASTNodeKind.KIND_PAUSABLE_CLAUSE) {
              kt.pausable = true;
            } else if (
              c.kind === ASTNodeKind.KIND_PROVIDES_CLAUSE &&
              kt.provides === null
            ) {
              kt.provides = c.providedName;
            }
          }
          kindTable.set(d.name, kt);
          d.resolvedKindType = kt;
          // Capture the concurrency core as std declares it, so every other
          // module in the graph sees the same KindType objects (kinds
          // compare by reference).
          if (
            REQUIRED_CORE_KINDS.has(d.name) &&
            (mod.absPath ?? "").replace(/\\/g, "/").endsWith(CORE_KINDS_MODULE)
          ) {
            coreKinds.set(d.name, kt);
          }
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

    // Intrinsics are no longer auto-injected - they enter genericFuncTable /
    // localSymbols only via an `extern "intrinsic" from "compiler"` block,
    // which user code triggers by importing std/core/intrinsics.yoop (or, for
    // wait_until/cancel, std/core/concurrency.yoop).

    // modules-as-directories: the env object is created by the FIRST source
    // file of a module and reused (not replaced) by the rest, which is what
    // makes a module's declarations visible to its siblings with no import and
    // makes a cross-file duplicate report as an ordinary redeclaration. Note
    // there is no `allowsUnsafe` here on purpose: `import.unsafe;` is a
    // per-source-file pragma, so it is read off `mod.ast` at each use rather
    // than cached on the shared env, where one file's opt-in would silently
    // cover its siblings.
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
      genericVariantTable,
      variantTable,
      unionTable,
      enumTable,
      vtableTable,
      aliasTable,
      builtinIntrinsicNames,
    });
    stampErrorOrigin(errors, errStart, mod);
  }

  // pass B: wire imports (so pass C can resolve cross-module type names)
  for (const mod of modules) {
    const errStart = errors.length;
    resolveImports(mod, moduleEnv, errors);
    stampErrorOrigin(errors, errStart, mod);
  }

  // pass B.1 - import locality for directory modules. A module's source files
  // share its DECLARATIONS but not its IMPORTS: using a name a sibling imported
  // is an error, so a file's head still tells you what it depends on. No-op for
  // single-file modules. See importLocality.js for why this is enforcement
  // rather than lexical per-file scope.
  // Stamps its own errors, since it reports per source FILE across a group.
  checkImportLocality(modules, moduleEnv, errors);

  // Phase 8.A: `import.unsafe;` gating pass - scan each non-unsafe module
  // for any unsafe_ptr type annotation, address-of/deref/null/cast node, and
  // surface a precise diagnostic. Cheap recursive walk; runs once per module.
  for (const mod of modules) {
    if (mod.ast.allowsUnsafe) continue;
    const errStart = errors.length;
    walkAstForUnsafe(mod.ast, errors);
    stampErrorOrigin(errors, errStart, mod);
  }

  // modules-as-directories: pass C's sub-stages are ordered relative to each
  // OTHER (generic bodies -> trait method sigs -> impl validation), and across
  // separate modules the topological order of `modules` satisfies that. It does
  // NOT satisfy it across the SOURCE FILES OF ONE MODULE, because siblings have
  // no dependency order between them - the graph lists them in basename order.
  // So `validateImplBlock` in router.yoop could run against the still-empty
  // `methods` map of a trait declared in server.yoop, which made a directory
  // module's semantics depend on the alphabetical spelling of its filenames:
  // renaming a file turned a hard error ("'self' can only be used inside a trait
  // method body") into a working program.
  //
  // The fix is to run pass C GROUP-MAJOR, STAGE-MINOR: group the source files by
  // module (topo order preserved, since a module's files are contiguous), and
  // inside a group run each stage for every file before starting the next stage.
  // A single-file module is a group of one, so this is behavior-identical to the
  // old single loop for every module that predates the feature - which is the
  // reason to structure it this way rather than making all of pass C
  // stage-major across modules. That stronger form was tried first and broke:
  // trait signature resolution instantiates generic types, and instantiation
  // snapshots the generic decl, so trait sigs cannot precede generic-body
  // resolution program-wide. See plans/modules-as-directories.md.
  const passCGroups = [];
  {
    const groupById = new Map();
    for (const mod of modules) {
      let group = groupById.get(mod.id);
      if (!group) {
        group = [];
        groupById.set(mod.id, group);
        passCGroups.push(group);
      }
      group.push(mod);
    }
  }

  // pass C: struct fields + function sigs + extern decls
  for (const group of passCGroups) {
    // STAGE 1 of the group - generic pre-pass, struct/variant/enum/union
    // bodies, function signatures, extern decls.
    //
    // Split into two sub-stages, and the split is load-bearing. Instantiating a
    // generic type SNAPSHOTS the generic decl: `instantiateStruct` copies
    // `genericDecl.genericFields` into a fresh cached StructType. If a concrete
    // field names `Bag<int32>` before `type Bag<T>`'s own body has been
    // resolved, that snapshot is taken from an EMPTY field list and the cached
    // instance is permanently field-less - reported downstream as the actively
    // misleading `type "Bag__int32" has no field "item"`. Declaration order
    // decided it inside one file, and basename order decided it across the
    // source files of a directory module.
    //
    // So: every generic TYPE body in the group is resolved before any concrete
    // decl in the group. This is the "broader use will need a pre-pass before
    // field resolution" that the Phase 7.x comment below predicted, and it is
    // the same shape as the Phase 7.2 generic-TRAIT pre-pass that already exists
    // for exactly this reason. The unfrozen-shell fix in types.js handles the
    // non-generic half of the same hazard.
    for (const subStage of ["genericTypes", "rest"]) {
    for (const mod of group) {
    const errStart = errors.length;
    const env = moduleEnv.get(mod.id);
    const { localSymbols, structTable, exports, traitTable, variantTable, unionTable, enumTable, genericFuncTable } = env;
    // Default ctx (no typeParamScope, registry always available).
    const baseCtx = () => ({ registry: programState.registry });
    // ctx for a generic decl body - adds the type-param scope.
    const genericCtx = (paramScope) => ({
      registry: programState.registry,
      typeParamScope: paramScope,
    });

    // Phase 7.2 fix: generic-trait method sigs must be resolved BEFORE the
    // main pass-C loop, because that loop resolves generic function/struct
    // `implements` bounds (resolveAndAttachBounds), which instantiate the
    // bound generic trait via the registry. instantiateTrait snapshots
    // `gd.genericMethods` into a fresh (cached) TraitType; if genericMethods
    // is still empty at snapshot time the instance is permanently method-less,
    // and trait-qualified dispatch through a bounded type param
    // (`Comparable.compare(ref x, ...)` for `<T implements Comparable<T>>`)
    // later fails with "trait has no method". Non-generic bounds don't hit
    // this because they attach the live mutable trait object whose `.methods`
    // map is filled in-place by C.1. Hoisting generic-trait population to a
    // pre-pass keeps the snapshot well-formed; the C.1 generic branch then
    // just `continue`s.
    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      if (d.kind !== ASTNodeKind.TRAIT_DECL || !d.genericDecl) continue;
      const gd = d.genericDecl;
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
    }

    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);

      // Partition the decls across the two sub-stages (see the comment on the
      // subStage loop). Generic TYPE decls go first because instantiating one
      // snapshots its body; generic FUNCTION decls stay with "rest" - their
      // signatures do not feed any layout, and moving them earlier would only
      // widen the blast radius. Every decl is handled in exactly one sub-stage.
      const isGenericTypeDecl =
        !!d.genericDecl &&
        (d.kind === ASTNodeKind.TYPE_DECL || d.kind === ASTNodeKind.VARIANT_DECL);
      if (subStage === "genericTypes" ? !isGenericTypeDecl : isGenericTypeDecl) {
        continue;
      }

      // Phase 7.1: generic struct decl - resolve field types with type params
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
        // Don't continue - fall through to skip the regular TYPE_DECL handler
        // below by checking d.genericDecl there.
      }

      // struct fields
      // Transparent type alias: resolve its RHS once here so an unknown target
      // type or a cyclic alias is reported at the declaration, not at every use.
      // The alias has no struct/resolvedType - codegen never emits anything for
      // it (every use already resolved through to the underlying type).
      if (d.kind === ASTNodeKind.TYPE_DECL && d.targetType && !(d.typeParams?.length)) {
        const resolved = resolveTypeAnnotationInModule(
          d.targetType,
          mod.id,
          moduleEnv,
          baseCtx(),
        );
        if (!resolved) {
          errors.push({
            message: `type alias "${d.name}" references an unknown type or is cyclic: ${formatAnnotation(d.targetType)}`,
            sourceLoc: d.sourceLoc,
          });
        } else {
          d.resolvedAliasType = resolved;
        }
      }

      if (d.kind === ASTNodeKind.TYPE_DECL && !d.genericDecl && !d.targetType) {
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

        // Fill the pass-A shell IN PLACE. Replacing the table entry here left
        // every already-resolved field pointing at an empty struct, which
        // undersized the enclosing layout and silently miscompiled (see
        // StructShell in types.js). Falls back to a fresh StructType if the
        // entry is not our shell - e.g. a redeclaration replaced it.
        const shell = structTable.get(d.name);
        const fullType =
          shell && !Object.isFrozen(shell) && shell.fields === null
            ? fillStructShell(shell, fields, propagatedKinds, typeKindApp)
            : StructType(d.name, fields, mod.id, [], new Map(), propagatedKinds, typeKindApp);
        d.resolvedType = fullType;
        structTable.set(d.name, fullType);
      }

      // Phase 7.5: resolve enum variant fields.
      // Phase 10.A: generic enums get a separate branch - their variant fields
      // are resolved with a type-param scope and stashed on the genericDecl
      // for later instantiation. The genericDecl never produces a single
      // resolvedType.
      if (d.kind === ASTNodeKind.VARIANT_DECL && d.genericDecl) {
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
                  message: `duplicate field "${f.name}" in variant "${variantNode.name}" of generic variant "${d.name}"`,
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
                  message: `unknown type "${formatAnnotation(f.typeAnnotation)}" in variant "${variantNode.name}" of generic variant "${d.name}"`,
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
      } else if (d.kind === ASTNodeKind.VARIANT_DECL) {
        // Phase 13.A: mutate the shell registered by pass A in place
        // instead of constructing a fresh VariantType and replacing it.
        // Any struct field whose type was resolved earlier in pass C
        // captured the shell reference; if we swapped a new object into
        // variantTable here, those references would point at the empty
        // shell and `sizeOfType` on the field would compute as 4 (tag
        // only), undersizing every enclosing struct. Mirrors the
        // TraitType pattern (frozen outer, mutable `methods` Map).
        const shell = variantTable.get(d.name);
        // A name collision (this variant redeclares a struct/alias/etc.) means
        // pass A pushed a redeclaration error and skipped registering the shell.
        // Skip body resolution rather than dereferencing the missing shell.
        if (!shell) continue;

        // Phase 13.B: resolve `propagates<...>` on the variant decl and
        // store on the shell. Same shape as the struct branch above.
        if (d.propagatesClause) {
          const env2 = moduleEnv.get(mod.id);
          for (const ref of d.propagatesClause.kindNames) {
            const app = resolveKindAppFromPropagatesEntry(ref, env2, errors);
            if (!app) continue;
            if (shell.propagatedKinds.some((a) => a.kindType === app.kindType)) {
              errors.push({
                message: `duplicate kind '${ref.name}' in propagates clause of variant "${d.name}"`,
                sourceLoc: ref.sourceLoc,
              });
              continue;
            }
            shell.propagatedKinds.push(app);
          }
        }

        let ordinal = 0;
        for (const variantNode of d.variants ?? []) {
          let resolvedFields = null;
          if (variantNode.fields !== null) {
            resolvedFields = [];
            const seenFieldNames = new Set();
            for (const f of variantNode.fields) {
              if (seenFieldNames.has(f.name)) {
                errors.push({
                  message: `duplicate field "${f.name}" in variant "${variantNode.name}" of variant "${d.name}"`,
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
                  message: `unknown type "${formatAnnotation(f.typeAnnotation)}" in variant "${variantNode.name}" of variant "${d.name}"`,
                  sourceLoc: f.sourceLoc,
                });
                ft = ErrorType();
              }
              resolvedFields.push({ name: f.name, type: ft });
            }
          }
          shell.variants.set(variantNode.name, {
            name: variantNode.name,
            fields: resolvedFields,
            ordinal,
          });
          variantNode.ordinal = ordinal;
          ordinal++;
        }
        d.resolvedType = shell;
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
              message: `union field "${f.name}" has type ${formatAnnotation(f.typeAnnotation)} - refs and Tasks are not allowed in unions`,
              sourceLoc: f.sourceLoc,
            });
          }
          fields.push({ name: f.name, type: ft });
        }
        const fullUnion = UnionType(d.name, fields, mod.id);
        d.resolvedType = fullUnion;
        unionTable.set(d.name, fullUnion);
      }

      // Phase 12: resolve value-enum underlying type and const-eval each case.
      if (d.kind === ASTNodeKind.ENUM_DECL) {
        const underlying = resolveTypeAnnotationInModule(
          d.underlying,
          mod.id,
          moduleEnv,
          baseCtx(),
        );
        let valid = true;
        if (!underlying || underlying.kind !== typeKinds.prim) {
          errors.push({
            message: `enum '${d.name}' underlying type must be a primitive (int8..int64, uint8..uint64, or string); got ${formatAnnotation(d.underlying)}`,
            sourceLoc: d.sourceLoc,
          });
          valid = false;
        } else if (
          underlying.name !== "string" &&
          !isIntPrim(underlying.name)
        ) {
          errors.push({
            message: `enum '${d.name}' underlying type '${underlying.name}' is not supported (must be int8..int64, uint8..uint64, or string)`,
            sourceLoc: d.sourceLoc,
          });
          valid = false;
        }
        const cases = new Map();
        let isOpen = false;
        let priorValue = null;
        let ordinal = 0;
        for (const caseNode of d.cases ?? []) {
          let value;
          let usedOperator = false;
          if (caseNode.valueExpr === null) {
            value = autoIncrementValue(
              priorValue,
              valid ? underlying : { name: "int32" },
              errors,
              caseNode,
            );
          } else if (valid) {
            const evalCtx = {
              underlying,
              priorCases: new Map(
                Array.from(cases.values()).map((c) => [c.name, c.value]),
              ),
              errors,
              enumName: d.name,
              caseName: caseNode.name,
              srcLoc: caseNode.sourceLoc,
            };
            const r = evalEnumValueExpr(caseNode.valueExpr, evalCtx);
            value = r.value;
            usedOperator = r.usedOperator;
          } else {
            value = underlying?.name === "string" ? "" : 0n;
          }
          if (usedOperator) isOpen = true;
          cases.set(caseNode.name, {
            name: caseNode.name,
            value,
            ordinal,
          });
          caseNode.ordinal = ordinal;
          caseNode.resolvedValue = value;
          priorValue = value;
          ordinal++;
        }
        const fullEnum = ValueEnumType(
          d.name,
          underlying ?? PrimType("int32"),
          cases,
          [],
          new Map(),
          mod.id,
          isOpen,
        );
        d.resolvedType = fullEnum;
        enumTable.set(d.name, fullEnum);
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

        deriveFunctionKindFlags(funcDecl, moduleEnv.get(mod.id));

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
          // A `task` body is implicitly async (the parser sets isAsync on
          // it too); an `async` decl says so directly.
          !!funcDecl.isAsync,
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

      // extern function decls - overwrite shells placed in pass A.
      // Generic intrinsics are skipped: pass A installed the canonical
      // pre-built decl into genericFuncTable and that signature is the
      // source of truth (the user-written annotations are documentation).
      if (decl.kind === ASTNodeKind.EXTERN_BLOCK) {
        const isIntrinsic = decl.abi === "intrinsic";
        for (const ext of decl.decls) {
          if (ext.kind !== ASTNodeKind.EXTERN_FUNCTION_DECL) continue;
          if (isIntrinsic && genericFuncTable.has(ext.name)) continue;
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
            FuncType(paramTypes, retType, ext.variadic, [], !!ext.isAsync),
          );
        }
      }
    }
    stampErrorOrigin(errors, errStart, mod);
    }
    }

    // STAGE 2 of the group - every trait's SHAPE: extends chains, then method
    // signatures. Runs for EVERY source file of the module before stage 3 (which
    // consumes those method tables) runs for any of them. Stage 1 above has
    // already resolved this module's generic bodies, which trait signature
    // resolution depends on: a signature mentioning `Result<isize, string>`
    // instantiates that generic enum, and instantiation SNAPSHOTS the generic
    // decl - so hoisting this any earlier yields a permanently variant-less
    // instance ("enum Result__isize__string has no variant Ok").
    for (const mod of group) {
    const errStart = errors.length;
    const { traitTable } = moduleEnv.get(mod.id);
    const baseCtx = () => ({ registry: programState.registry });
    const genericCtx = (paramScope) => ({
      registry: programState.registry,
      typeParamScope: paramScope,
    });

    // Phase 9.J: resolve every trait's `extends` list first, before any
    // method signatures. Method-sig resolution doesn't depend on parents'
    // method tables (extends is only consulted at impl-block validation and at
    // call dispatch), but the typecheck contract is "trait.extendsTraits is
    // populated by the time impl validation runs". Doing this in one pass over
    // all trait decls keeps the trait-name lookup window simple.
    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      if (d.kind !== ASTNodeKind.TRAIT_DECL) continue;
      const extendsAnnots = d.extends ?? [];
      if (extendsAnnots.length === 0) continue;
      const traitObj = d.genericDecl
        ? null // generic-trait extends list is attached to the genericDecl below
        : traitTable.get(d.name);
      const targetExtendsList = d.genericDecl
        ? (d.genericDecl.extendsTraits ??= [])
        : traitObj?.extendsTraits;
      if (!targetExtendsList) continue;
      const paramScope = d.genericDecl?.paramScope ?? null;
      for (const annot of extendsAnnots) {
        const result = resolveBoundTrait(
          annot,
          paramScope,
          mod,
          moduleEnv,
          programState,
        );
        if (!result) {
          errors.push({
            message: `unknown trait "${formatAnnotation(annot)}" in extends list for trait "${d.name}"`,
            sourceLoc: d.sourceLoc,
          });
          continue;
        }
        if (result.notTrait) {
          errors.push({
            message: `extends target for trait "${d.name}" must be a trait, got "${formatAnnotation(annot)}"`,
            sourceLoc: d.sourceLoc,
          });
          continue;
        }
        // Reject direct self-extension (trait Foo extends Foo).
        if (!d.genericDecl && result === traitObj) {
          errors.push({
            message: `trait "${d.name}" cannot extend itself`,
            sourceLoc: d.sourceLoc,
          });
          continue;
        }
        targetExtendsList.push(result);
      }
      // Cycle check after pushing - diagnose only here so the SCC is whole.
      const root = traitObj ?? d.genericDecl;
      if (root && traitExtendsHasCycle(root)) {
        errors.push({
          message: `cyclic extends chain involving trait "${d.name}"`,
          sourceLoc: d.sourceLoc,
        });
        // Clear the list so downstream walks don't loop.
        targetExtendsList.length = 0;
      }
    }
    // pass C.1 - trait method signatures
    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      if (d.kind !== ASTNodeKind.TRAIT_DECL) continue;
      // Phase 7.1: generic trait method sigs are resolved in the pre-pass
      // above (so generic bounds instantiate against a populated method map);
      // nothing left to do here.
      if (d.genericDecl) continue;
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
        trait.methods.set(
          sig.name,
          FuncType(params, returnType, false, [], !!sig.isAsync),
        );
        sig.resolvedFuncType = trait.methods.get(sig.name);
      }
    }
    stampErrorOrigin(errors, errStart, mod);
    }

    // STAGE 3 of the group - everything that CONSUMES a trait's method table:
    // kind clauses (`requires`/`mustCall`), impl-block validation, vtable slot
    // matching, and module-level decls. Because stage 2 above already ran for
    // every source file of this module, an impl in one file now sees the fully
    // populated methods map of a trait declared in a sibling file.
    for (const mod of group) {
    const errStart = errors.length;
    const env = moduleEnv.get(mod.id);
    const { localSymbols, structTable, exports, traitTable, variantTable, unionTable, enumTable, genericFuncTable } = env;
    const baseCtx = () => ({ registry: programState.registry });
    const genericCtx = (paramScope) => ({
      registry: programState.registry,
      typeParamScope: paramScope,
    });

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
      if (
        (d.kind !== ASTNodeKind.TYPE_DECL &&
          d.kind !== ASTNodeKind.VARIANT_DECL &&
          d.kind !== ASTNodeKind.ENUM_DECL) ||
        !d.implements?.length
      ) {
        continue;
      }
      // Phase 7.x: generic structs now support `implements Trait`. validateImplBlock
      // routes to the open-self code path when d.genericDecl is set. Note: this
      // runs *after* struct field resolution in pass C, so a struct field that
      // references DynArray<int32> in the same module would have already been
      // cached with empty implementsTraits. The current playground demo doesn't
      // hit this case; broader use will need a pre-pass before field resolution.
      // Phase 13.B: variants flow through the same validator. The shell
      // mutation pattern (13.A) means struct fields that captured the
      // variant before its impls landed will see the populated
      // implementsTraits + methods on their next read.
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
    // (Bytecode/CTE future) - mod.moduleInitDecls is the natural input to
    // a future compile-time evaluator: each entry has a resolved type on
    // the decl, an unresolved `.assignment` AST, and a stable order.
    mod.moduleInitDecls = [];
    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      if (
        (d.kind === ASTNodeKind.LET_DECL || d.kind === ASTNodeKind.CONST_DECL) &&
        d.isModuleLevel
      ) {
        if (d.typeAnnotation === null) {
          // No annotation: the type is inferred from the initializer in pass
          // D.0 (validateModuleInit), where the full per-module typeContext
          // and all same-module function signatures are available. Leave the
          // ErrorType shell in place until then; resolvedType stays null as a
          // "needs inference" sentinel (distinct from an ErrorType failure).
          d.resolvedType = null;
          mod.moduleInitDecls.push(d);
          continue;
        }
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
    stampErrorOrigin(errors, errStart, mod);
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

  // Cross-module function-decl index for kindFlow (clearance markers). Resolves
  // an imported or namespaced callee (`db.runQuery(...)`, or a by-name imported
  // `readBody()`) to its source decl plus that module's kind table, so a marker
  // on a std-style signature is enforced across the boundary instead of being
  // silently dropped at the call site. Built once; keyed by module id then
  // export name.
  const funcDeclsByModule = new Map();
  for (const m of modules) {
    const t = new Map();
    for (const decl of m.ast.body) {
      const d = innerDecl(decl);
      if (d.kind === ASTNodeKind.FUNCTION_DECL) t.set(d.name, d);
    }
    funcDeclsByModule.set(m.id, t);
  }
  const resolveCrossModuleCallee = (moduleId, exportName) => {
    const decl = funcDeclsByModule.get(moduleId)?.get(exportName);
    if (!decl) return null;
    const kindTable = moduleEnv.get(moduleId)?.kindTable;
    if (!kindTable) return null;
    return { decl, kindTable };
  };

  // The required-core assertion. Clauses are populated in pass C.2, so this
  // runs after every module has been through it.
  //
  // This is the carve-out the whole design rests on: the compiler does not
  // define these kinds, but it does insist they exist with the shape it
  // consults. A std that dropped `refcounted` from `pooled`, or `provides
  // Task` from `task`, would silently miscompile every task program - so it
  // is an error naming the file and the expected clauses instead.
  assertRequiredCoreKinds(coreKinds, errors);

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
      genericVariantTable: env.genericVariantTable,
      // Phase 7.5: variant and union nominal tables.
      variantTable: env.variantTable,
      unionTable: env.unionTable,
      // Phase 12: value-enum nominal table.
      enumTable: env.enumTable,
      // Phase 9.G: vtable nominal table.
      vtableTable: env.vtableTable,
      // Names imported into this module via an `extern "intrinsic"` block.
      // Gates wait_until/cancel special-cases in checkExpr.js.
      builtinIntrinsicNames: env.builtinIntrinsicNames,
      // Phase 8.A: per-module unsafe opt-in flag (for kind-check / pure check).
      allowsUnsafe: !!mod.ast.allowsUnsafe,
      // Phase 8.A: callback that resolves a parser-emitted type annotation
      // to a Type in this module's scope. Used by expression-level type-arg
      // intrinsics (`unsafe_ptr.cast<U>(p)`, `unsafe_ptr.fromInt<T>(n)`).
      resolveTypeAnnotation: (annot) =>
        resolveTypeAnnotationInModule(annot, mod.id, moduleEnv, {
          registry: programState.registry,
        }),
    };

    // Phase 8.E: pass D.0 - typecheck module-level let/const initializers.
    // Runs before function bodies because module globals' types are needed
    // by IDENT resolution inside function bodies. Inits may freely call
    // functions defined in this module (their sigs were resolved in pass C).
    //
    // (Bytecode/CTE future) - each call to checkInitializer here is a
    // discrete unit a future evaluator could intercept: if the init expr
    // is purely constant-evaluable, emit the LLVM @global with the
    // computed value and drop this decl from the runtime init function.
    for (const d of mod.moduleInitDecls ?? []) {
      if (d.resolvedType?.kind === typeKinds.error) continue;
      validateModuleInit(d, typeContext, errors);
    }

    // Phase 11.D.18 pass D.0.5: typecheck `@precompile { ... }`
    // block-form bodies. These blocks are top-level, see only
    // module scope, and have no return type - same shape as
    // validateModuleInit but on a BLOCK statement. Done before
    // pass D.1 (function bodies) so the block's calls into module
    // functions resolve against fully-typechecked sigs.
    for (const decl of mod.ast.body) {
      if (
        decl.kind === ASTNodeKind.ATTRIBUTE &&
        decl.name === "precompile" &&
        decl.target?.kind === ASTNodeKind.BLOCK
      ) {
        validatePrecompileBlock(decl.target, typeContext, errors);
      }
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
      } else if (d.kind === ASTNodeKind.VARIANT_DECL && d.methods?.length > 0) {
        // Phase 13.B: variant methods are typechecked the same way as
        // struct methods, with `self` bound to the variant's shell.
        // Generic variants are not yet supported on the impl side.
        const selfShell = d.resolvedType;
        if (selfShell) {
          for (const method of d.methods) {
            validateMethod(method, selfShell, typeContext, errors);
          }
        }
      } else if (d.kind === ASTNodeKind.ENUM_DECL && d.methods?.length > 0) {
        const selfShell = d.resolvedType;
        if (selfShell) {
          for (const method of d.methods) {
            validateMethod(method, selfShell, typeContext, errors);
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
    // Generic function decls are included - kindCheck operates on the open
    // (TypeParamType-bearing) body since the obligations it stamps onto AST
    // nodes (pendingCleanups, implicitCleanups) are preserved by the
    // per-instance `cloneAstWithSubstitution` walk in codegen.
    const flowKindTable = moduleEnv.get(mod.id)?.kindTable;
    for (const decl of mod.ast.body) {
      const d = innerDecl(decl);
      if (d.kind === ASTNodeKind.FUNCTION_DECL) {
        // testing-via-kinds: `<kind> function foo(...)`. Runs here rather than
        // in the signature pass because `kindTable` only has imported kinds
        // merged into it by pass C.4, and the kind almost always comes from
        // another module (`suite` from std/test.yoop).
        if (d.kindPrefix) {
          validateFunctionKindPrefix(d, mod, moduleEnv, flowKindTable, errors);
        }
        runKindCheck(d, errors, funcDeclTable, programState.registry);
        runKindFlow(d, errors, funcDeclTable, flowKindTable, null, resolveCrossModuleCallee);
      } else if (d.kind === ASTNodeKind.TYPE_DECL && d.methods?.length > 0 && !d.genericDecl) {
        for (const method of d.methods) {
          runKindCheck(method, errors, funcDeclTable, programState.registry);
          runKindFlow(method, errors, funcDeclTable, flowKindTable, d, resolveCrossModuleCallee);
        }
      } else if (d.kind === ASTNodeKind.VARIANT_DECL && d.methods?.length > 0) {
        // Phase 13.B: variant methods participate in kind-check like
        // struct methods.
        for (const method of d.methods) {
          runKindCheck(method, errors, funcDeclTable, programState.registry);
          runKindFlow(method, errors, funcDeclTable, flowKindTable, d, resolveCrossModuleCallee);
        }
      }
    }
    stampErrorOrigin(errors, errStart, mod);
  }

  // Split the one accumulating array into the two the callers want. Warnings
  // rode along with the errors so that `ctx.errors` stayed a single channel
  // and stampErrorOrigin covered both, but a warning must never fail a build
  // - so `errors` here means HARD errors only, and every existing
  // `errors.length === 0` gate keeps the meaning it had.
  return {
    modules,
    errors: errors.filter((e) => e.severity !== Severity.warning),
    warnings: errors.filter((e) => e.severity === Severity.warning),
    moduleEnv,
    programState,
  };
}

// testing-via-kinds: validate `<kind> function foo(...)`.
//
// Resolves the prefix against the module's (import-merged) kind table, checks
// that the kind is a function kind, and checks the decl against the kind's
// declared `signature`. On success, stamps `resolvedKindType` plus
// `enumerableAs` onto the decl - the latter is what the driver's --test mode
// reads to collect a table without needing to resolve kinds itself.
function validateFunctionKindPrefix(funcDecl, mod, moduleEnv, kindTable, errors) {
  const prefixName = funcDecl.kindPrefix.name;
  const at = { sourceLoc: funcDecl.kindPrefix.sourceLoc ?? funcDecl.sourceLoc };
  const kt = kindTable?.get(prefixName);
  if (!kt) {
    pushError(errors, at, `unknown kind "${prefixName}" on function "${funcDecl.name}"`);
    return;
  }
  if (!kt.appliesTo.has("function")) {
    const sites = [...kt.appliesTo].join(", ");
    pushError(errors, at,
      `kind '${prefixName}' cannot prefix a function declaration; it applies to ${sites}`);
    return;
  }
  // A generic function has no single concrete signature, so there is nothing to
  // put in an enumerated table. Reject rather than silently skip.
  if (funcDecl.genericDecl || funcDecl.typeParams?.length) {
    pushError(errors, at,
      `kind '${prefixName}' cannot prefix generic function "${funcDecl.name}"; an enumerated function needs one concrete signature`);
    return;
  }
  // Resolve the kind's declared signature once, lazily, in the kind's OWN
  // module - the annotation names types visible there (`Run` in std/test.yoop),
  // not necessarily in the module carrying the prefix.
  if (!kt.signature && kt.signatureAnnotation) {
    kt.signature = resolveTypeAnnotationInModule(
      kt.signatureAnnotation,
      kt.moduleId ?? mod.id,
      moduleEnv,
      { typeParamScope: null },
    );
  }
  const want = kt.signature;
  if (!want) return; // the kind decl itself already errored
  const got = moduleEnv.get(mod.id)?.localSymbols.get(funcDecl.name);
  if (!got || got.kind === typeKinds.error) return; // signature pass already errored

  const describe = () =>
    `\`${formatType(want)}\` (declared by kind '${prefixName}')`;
  if (got.params.length !== want.params.length) {
    pushError(errors, at,
      `function "${funcDecl.name}" carries kind '${prefixName}' and must match ${describe()}, but takes ${got.params.length} parameter(s) instead of ${want.params.length}`);
    return;
  }
  for (let i = 0; i < want.params.length; i++) {
    // FuncType params are { name, type, isRef } records; a function-value type's
    // params are bare types. Compare the types positionally.
    if (!typesEqual(got.params[i].type, want.params[i])) {
      pushError(errors, at,
        `function "${funcDecl.name}" carries kind '${prefixName}' and must match ${describe()}, but parameter ${i + 1} is ${formatType(got.params[i].type)} instead of ${formatType(want.params[i])}`);
      return;
    }
  }
  if (!typesEqual(got.returnType, want.returnType)) {
    pushError(errors, at,
      `function "${funcDecl.name}" carries kind '${prefixName}' and must match ${describe()}, but returns ${formatType(got.returnType)} instead of ${formatType(want.returnType)}`);
    return;
  }
  funcDecl.resolvedKindType = kt;
  funcDecl.enumerableAs = kt.enumerableAs;
}

// Stamp `moduleId` onto error records added to `errors` since `startIdx`.
// Used by typecheckProgram to attribute errors to the module being processed
// without threading moduleId through every pushError call site.
// Tag every error a pass just produced with where it came from.
//
// TWO ids, deliberately: `moduleId` is the namespace/mangling unit and
// `srcPath` is the SOURCE FILE. Under modules-as-directories several source
// files share one moduleId, so moduleId alone can no longer find the text to
// render a code frame against - a diagnostic keyed only by module would print
// the caret against whichever file happened to be last. `srcPath` is what
// diagnostic rendering keys on; `moduleId` stays because --test filters the
// synthetic entry MODULE, which is a module-level question.
function stampErrorOrigin(errors, startIdx, mod) {
  for (let i = startIdx; i < errors.length; i++) {
    if (errors[i].moduleId === undefined) errors[i].moduleId = mod.id;
    if (errors[i].srcPath === undefined) errors[i].srcPath = mod.absPath;
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
  // Phase 8.A: gating - single-module path mirrors the typecheckProgram
  // walker. Modules that didn't opt into `import.unsafe;` cannot mention
  // any pointer surface.
  typeContext.allowsUnsafe = !!ast.allowsUnsafe;
  if (!ast.allowsUnsafe) {
    walkAstForUnsafe(ast, errors);
  }

  // pass 1: struct shells
  for (const decl of ast.body) {
    const d = innerDecl(decl);
    // Type aliases aren't supported in the legacy single-module path (only the
    // multi-module pipeline used by compileEntry/e2e); skip so they aren't
    // mis-registered as empty structs.
    if (d.kind === ASTNodeKind.TYPE_DECL && !d.targetType) {
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
    if (d.kind === ASTNodeKind.TYPE_DECL && !d.targetType) {
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
            false,
            [],
            // The legacy single-module path builds its own signatures, so
            // asyncness has to be carried here too - otherwise every
            // await in a single-module program reports "callee is not
            // async" and the coloring rules silently do not apply.
            !!d.isAsync,
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
          FuncType(paramTypes, retType, ext.variadic, [], !!ext.isAsync),
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

  // Same split as typecheckProgram. This legacy single-module path has no
  // caller that surfaces warnings, and it reports whatever is in `errors` as
  // a hard failure - so drop them rather than turn dead code into an error
  // here alone.
  return { ast, errors: errors.filter((e) => e.severity !== Severity.warning) };
}

// convenience for tests: parse + typecheck in one call.
export function typecheckSource(src) {
  const ast = parse(src);
  return typecheck(ast);
}
