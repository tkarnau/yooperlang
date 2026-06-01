// Import resolution pass for multi-module typechecking.
// Wires each module's IMPORT_DECLs into its local symbol/struct tables.

import { ASTNodeKind } from "../contracts.js";
import { NamespaceType, typeKinds } from "./types.js";
import { pushError } from "./errors.js";

// resolveImports - pass B of typecheckProgram.
// For each IMPORT_DECL in mod, validates exports exist and populates the
// module's local symbol/struct tables with the imported bindings.
export function resolveImports(mod, moduleEnv, errors) {
  const modEnv = moduleEnv.get(mod.id);
  const { localSymbols, structTable, importedNames, traitTable, kindTable } = modEnv;

  for (const imp of mod.ast.body) {
    if (imp.kind !== ASTNodeKind.IMPORT_DECL) break; // imports-first rule

    if (imp.importKind === "side-effect") continue; // no bindings to wire

    const srcEnv = moduleEnv.get(imp.resolvedModuleId);
    if (!srcEnv) {
      pushError(errors, imp, `internal: module ${imp.resolvedModuleId} not loaded`);
      continue;
    }

    // Namespace clause: `import * as ns ...`. Yoopstore-papercut #9: a
    // "combined" import (`import * as ns, { Type } from "..."`) carries both
    // a namespaceName and specifiers, so this is gated on the field, not on
    // importKind, and we fall through to the named-specifier loop rather than
    // `continue`-ing.
    if (imp.namespaceName) {
      if (localSymbols.has(imp.namespaceName)) {
        pushError(errors, imp, `local name "${imp.namespaceName}" collides with an existing declaration`);
      } else {
        const nsType = NamespaceType(srcEnv === modEnv ? mod.id : imp.resolvedModuleId, srcEnv.exports);
        localSymbols.set(imp.namespaceName, nsType);
        importedNames.set(imp.namespaceName, { fromModuleId: imp.resolvedModuleId, exportName: imp.namespaceName, kind: "namespace" });
      }
    }

    // named: import { a, b as c }
    for (const spec of (imp.specifiers ?? [])) {
      if (!srcEnv.exports.has(spec.exportName)) {
        pushError(errors, imp, `module "${imp.sourcePath}" has no export "${spec.exportName}"`);
        continue;
      }

      if (localSymbols.has(spec.localName) || structTable.has(spec.localName)) {
        pushError(errors, imp, `local name "${spec.localName}" collides with an existing declaration`);
        continue;
      }

      // Determine if it's a kind, trait, type, or value
      const srcKind = srcEnv.kindTable?.get(spec.exportName);
      const srcTrait = srcEnv.traitTable?.get(spec.exportName);
      const srcStruct = srcEnv.structTable.get(spec.exportName);
      const srcSym = srcEnv.localSymbols.get(spec.exportName);
      // Phase 8.H: also check the generic tables. The genericFuncTable
      // lookup is the path through which call-site inference resolves an
      // imported generic call; the genericStructTable lookup wires up
      // imported generic types like `Vec<T>` for resolveTypeAnnotation.
      const srcGenericStruct = srcEnv.genericStructTable?.get(spec.exportName);
      const srcGenericFunc = srcEnv.genericFuncTable?.get(spec.exportName);
      const srcGenericTrait = srcEnv.genericTraitTable?.get(spec.exportName);
      // Phase 10.A: generic enums import-side; lookups for an instantiated
      // generic enum go through genericVariantTable in the source module.
      const srcGenericVariant = srcEnv.genericVariantTable?.get(spec.exportName);
      // Phase 7.5: enum / union are sibling nominal types alongside struct.
      // lookupEnumByName / lookupUnionByName walk importedNames with kind ===
      // "type", so we register them the same way (and surface the resolved
      // type so resolveTypeAnnotation can find it via the type table).
      const srcVariant = srcEnv.variantTable?.get(spec.exportName);
      const srcUnion = srcEnv.unionTable?.get(spec.exportName);
      // Phase 12: value-enum export lookup.
      const srcValueEnum = srcEnv.enumTable?.get(spec.exportName);
      // Phase 9.G / 10.I: vtable nominal lookup. Treated as a "type" kind
      // import - resolveTypeAnnotation walks importedNames and consults
      // the source module's vtableTable when the kind is "type".
      const srcVtable = srcEnv.vtableTable?.get(spec.exportName);

      if (srcKind) {
        // Phase 6.4: cross-module kind import. Identity is preserved by reference -
        // the same KindType instance is shared across modules so equality holds.
        kindTable.set(spec.localName, srcKind);
        importedNames.set(spec.localName, { fromModuleId: imp.resolvedModuleId, exportName: spec.exportName, kind: "kind" });
      } else if (srcTrait) {
        // It's a trait - record the import; pass C.5 re-syncs the resolved version
        importedNames.set(spec.localName, { fromModuleId: imp.resolvedModuleId, exportName: spec.exportName, kind: "trait" });
      } else if (srcStruct) {
        // It's a struct type (possibly a shell; pass C.5 re-syncs the resolved version)
        structTable.set(spec.localName, srcStruct);
        importedNames.set(spec.localName, { fromModuleId: imp.resolvedModuleId, exportName: spec.exportName, kind: "type" });
      } else if (srcGenericStruct) {
        // Phase 8.H: imported generic struct type. lookupGenericStruct
        // (and resolveTypeAnnotation for type-applications) walks
        // importedNames to find it.
        importedNames.set(spec.localName, { fromModuleId: imp.resolvedModuleId, exportName: spec.exportName, kind: "generic-type" });
      } else if (srcGenericFunc) {
        // Phase 8.H: imported generic function. lookupGenericFunc looks
        // here via importedNames + the remote module's genericFuncTable.
        // Generic functions from std/ also fall under the namespace-only
        // rule (see the srcSym branch below for the full rationale).
        if (imp.sourcePath?.startsWith("std/")) {
          pushError(
            errors,
            imp,
            `imports of value "${spec.exportName}" from "${imp.sourcePath}" must use the namespace form: write \`import * as <ns> from "${imp.sourcePath}"\` and call as \`<ns>.${spec.exportName}(...)\``,
          );
          continue;
        }
        importedNames.set(spec.localName, { fromModuleId: imp.resolvedModuleId, exportName: spec.exportName, kind: "generic-func" });
      } else if (srcGenericTrait) {
        importedNames.set(spec.localName, { fromModuleId: imp.resolvedModuleId, exportName: spec.exportName, kind: "generic-trait" });
      } else if (srcGenericVariant) {
        // Phase 10.A: imported generic enum. resolveGenericApplication walks
        // importedNames → genericVariantTable to find it; variant-constructor
        // pinning uses the same path.
        importedNames.set(spec.localName, { fromModuleId: imp.resolvedModuleId, exportName: spec.exportName, kind: "generic-type" });
      } else if (srcVariant) {
        importedNames.set(spec.localName, { fromModuleId: imp.resolvedModuleId, exportName: spec.exportName, kind: "type" });
      } else if (srcUnion) {
        importedNames.set(spec.localName, { fromModuleId: imp.resolvedModuleId, exportName: spec.exportName, kind: "type" });
      } else if (srcValueEnum) {
        importedNames.set(spec.localName, { fromModuleId: imp.resolvedModuleId, exportName: spec.exportName, kind: "type" });
      } else if (srcVtable) {
        importedNames.set(spec.localName, { fromModuleId: imp.resolvedModuleId, exportName: spec.exportName, kind: "type" });
      } else if (srcSym) {
        // It's a value (function, const, etc.). Imports from std/ modules
        // must use the namespace form so common function names ("info",
        // "error", "panic", ...) don't compete with user identifiers.
        // Types/traits/kinds are exempt - they're capitalized (or, for
        // `disposable`, used in declaration-position syntax) and can keep
        // their named-import form.
        if (imp.sourcePath?.startsWith("std/")) {
          pushError(
            errors,
            imp,
            `imports of value "${spec.exportName}" from "${imp.sourcePath}" must use the namespace form: write \`import * as <ns> from "${imp.sourcePath}"\` and call as \`<ns>.${spec.exportName}(...)\``,
          );
          continue;
        }
        localSymbols.set(spec.localName, srcSym);
        importedNames.set(spec.localName, { fromModuleId: imp.resolvedModuleId, exportName: spec.exportName, kind: "value" });
      } else {
        pushError(errors, imp, `internal: export "${spec.exportName}" not found in module ${imp.resolvedModuleId}`);
      }
    }
  }
}
