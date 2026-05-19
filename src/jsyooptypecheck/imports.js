// Import resolution pass for multi-module typechecking.
// Wires each module's IMPORT_DECLs into its local symbol/struct tables.

import { ASTNodeKind } from "../contracts.js";
import { NamespaceType, typeKinds } from "./types.js";
import { pushError } from "./errors.js";

// resolveImports — pass B of typecheckProgram.
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

    if (imp.importKind === "namespace") {
      // import * as ns from "./mod.yoop"
      if (localSymbols.has(imp.namespaceName)) {
        pushError(errors, imp, `local name "${imp.namespaceName}" collides with an existing declaration`);
        continue;
      }
      const nsType = NamespaceType(srcEnv === modEnv ? mod.id : imp.resolvedModuleId, srcEnv.exports);
      localSymbols.set(imp.namespaceName, nsType);
      importedNames.set(imp.namespaceName, { fromModuleId: imp.resolvedModuleId, exportName: imp.namespaceName, kind: "namespace" });
      continue;
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

      if (srcKind) {
        // Phase 6.4: cross-module kind import. Identity is preserved by reference —
        // the same KindType instance is shared across modules so equality holds.
        kindTable.set(spec.localName, srcKind);
        importedNames.set(spec.localName, { fromModuleId: imp.resolvedModuleId, exportName: spec.exportName, kind: "kind" });
      } else if (srcTrait) {
        // It's a trait — record the import; pass C.5 re-syncs the resolved version
        importedNames.set(spec.localName, { fromModuleId: imp.resolvedModuleId, exportName: spec.exportName, kind: "trait" });
      } else if (srcStruct) {
        // It's a struct type (possibly a shell; pass C.5 re-syncs the resolved version)
        structTable.set(spec.localName, srcStruct);
        importedNames.set(spec.localName, { fromModuleId: imp.resolvedModuleId, exportName: spec.exportName, kind: "type" });
      } else if (srcSym) {
        // It's a value (function, const, etc.)
        localSymbols.set(spec.localName, srcSym);
        importedNames.set(spec.localName, { fromModuleId: imp.resolvedModuleId, exportName: spec.exportName, kind: "value" });
      } else {
        pushError(errors, imp, `internal: export "${spec.exportName}" not found in module ${imp.resolvedModuleId}`);
      }
    }
  }
}
