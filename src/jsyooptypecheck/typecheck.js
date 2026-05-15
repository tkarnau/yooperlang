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
  RefType,
  StructType,
  primTypeFromName,
  resolveTypeAnnotation,
  formatAnnotation,
  TraitType,
  TraitSelfPlaceholder,
  typeKinds,
  typesEqual,
} from "./types.js";
import { formatType } from "./errors.js";
import { coerceLiteralToType, isAssignable, unifyArith } from "./coerce.js";
import { detectRecursiveField } from "./recursiveStruct.js";
import { validateFunction, validateMethod } from "./checkStatement.js";
import { resolveImports } from "./imports.js";

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
  const fullStruct = StructType(typeDecl.name, fields, mod.id, resolvedImplements, resolvedMethods);
  typeDecl.resolvedType = fullStruct;
  for (const m of typeDecl.methods ?? []) {
    m.implementingType = fullStruct;
  }
  env.structTable.set(typeDecl.name, fullStruct);
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
    }

    moduleEnv.set(mod.id, {
      localSymbols,
      structTable,
      exports,
      importedNames,
      linkLibraries,
      traitTable,
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
        const fields = [];
        for (const field of d.fields ?? []) {
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
          fields.push({ name: field.name, type: fieldType });
        }
        const fullType = StructType(d.name, fields, mod.id);
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
            resolveTypeAnnotationInModule(
              funcDecl.returnTypeAnnotation,
              mod.id,
              moduleEnv,
            ) ?? ErrorType(),
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
    const { localSymbols, structTable, importedNames, traitTable } = moduleEnv.get(mod.id);
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
      }
    }
  }

  // pass D: function body typechecking
  for (const mod of modules) {
    const { localSymbols, structTable, importedNames } = moduleEnv.get(mod.id);
    const typeContext = {
      moduleSymbols: localSymbols,
      structTable,
      moduleEnv,
      importedNames,
      currentModId: mod.id,
    };

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
