// Import locality for directory modules (modules-as-directories).
//
// A module's DECLARATIONS are shared by all of its source files - that is the
// point of a directory module. Its IMPORTS should not be: you should be able to
// tell what a file depends on by reading its head, which is the whole reason the
// feature exists (a 1199-line shared-vocabulary dumping ground was costing more
// reading context than the file split saved).
//
// WHAT THIS IS, PRECISELY. Name resolution is still module-wide: imported names
// land in the same tables the module's declarations live in, so a sibling's
// import is still *resolvable*. This pass makes using one an ERROR. That is
// enforcement, not lexical per-file scope, and the distinction is deliberate -
// true lexical scoping means every deferred resolution has to remember which
// FILE it came from (an alias RHS resolves "in the alias's home module", which
// under per-file scope has to become "in the alias's home FILE"), which is a
// much larger and riskier change through the checker's resolution plumbing. See
// plans/modules-as-directories.md for the measured cost of that version.
//
// Two consequences of doing it this way, both conservative rejections rather
// than unsoundness, and both arguably desirable on their own:
//   * a name one file imports and another file declares is a redeclaration
//     error, where true per-file scope would allow it;
//   * two siblings binding the SAME local name to DIFFERENT modules is an
//     error, where true per-file scope would allow it.
//
// The name collector below is intentionally allowed to be incomplete. A missed
// name category is a false NEGATIVE (the wart persists in that one spot), which
// is harmless. False positives are the only real hazard, so a referenced name is
// only reported when it is imported by a SIBLING, not imported here, and not
// bound as a local anywhere in this file.

import { pushError } from "./errors.js";

// Keys that hold resolved/derived data rather than source structure. Walking
// them is pointless and risks cycles (back-references to decls, frozen type
// graphs that are shared program-wide).
const SKIP_KEYS = new Set([
  "sourceLoc",
  "fieldSourceLoc",
  "resolvedType",
  "resolvedFuncType",
  "resolvedAliasType",
  "resolvedEnumType",
  "resolvedVariant",
  "resolvedKindType",
  "scrutineeType",
  "declaredReturnType",
  "genericDecl",
  "genericInstantiation",
  "boundMethod",
  "calleeTrait",
  "paramScope",
  "genericMethods",
  "genericFields",
]);

// Names a source file binds locally. Over-collecting here only produces false
// negatives, so this leans broad on purpose: anything that looks like a binding
// site suppresses reporting for that name anywhere in the file.
const BINDING_KINDS = new Set([
  "LET_DECL",
  "CONST_DECL",
  "PARAM",
  "FOR_IN_LOOP",
  "FUNCTION_DECL",
  "METHOD_DECL",
]);

// The local names a file's own import statements bring into scope.
export function ownImportedNames(ast) {
  const names = new Set();
  for (const decl of ast.body) {
    if (decl.kind !== "IMPORT_DECL") break; // imports-first rule
    if (decl.namespaceName) names.add(decl.namespaceName);
    for (const spec of decl.specifiers ?? []) names.add(spec.localName);
  }
  return names;
}

// Depth-first walk that threads down the nearest enclosing `sourceLoc`. Type
// annotations are plain objects with no location of their own, so without the
// inherited one a diagnostic about `Vec` in `let v: Vec<int32>` would have no
// caret to point at.
function walk(root, visit) {
  const seen = new Set();
  const stack = [[root, null]];
  while (stack.length > 0) {
    const [node, inheritedLoc] = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);
    const loc = node.sourceLoc ?? inheritedLoc;
    if (!Array.isArray(node)) visit(node, loc);
    for (const [key, value] of Object.entries(node)) {
      if (SKIP_KEYS.has(key)) continue;
      if (value !== null && typeof value === "object") stack.push([value, loc]);
    }
  }
}

// Every name a file REFERENCES, mapped to a source location to blame.
function collectReferencedNames(ast) {
  const refs = new Map(); // name -> sourceLoc | null
  const note = (name, loc) => {
    if (typeof name !== "string" || name.length === 0) return;
    if (!refs.has(name)) refs.set(name, loc ?? null);
  };

  walk(ast, (node, loc) => {
    switch (node.kind) {
      case "IDENT":
        note(node.name, loc);
        break;
      // A type annotation's head, plus the `ns.` qualifier when it has one.
      case "typeName":
      case "typeApplication":
        note(node.name, loc);
        note(node.namespace, loc);
        break;
      // A kind decl's `requires <Trait>;` clause.
      case "KIND_REQUIRES_CLAUSE":
        note(node.traitName, loc);
        break;
      default:
        break;
    }
    // A direct call stores its callee as a plain STRING, not an IDENT node, so
    // `someImportedFn(...)` is invisible to the IDENT case above.
    if (node.kind === "CALL_EXPRESSION" && typeof node.callee === "string") {
      note(node.callee, loc);
    }
    // Marker kinds in type position (`cleared string`) are a string array;
    // kind prefixes on decls/bindings are `{ name, args }` objects.
    for (const list of [node.kindPrefixes, node.prefixes]) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (typeof entry === "string") note(entry, loc);
        else if (entry && typeof entry === "object") note(entry.name, loc);
      }
    }
    if (node.kindPrefix && typeof node.kindPrefix === "object") {
      note(node.kindPrefix.name, loc);
    }
    // `implements (A, B)` refs are `{ name, typeArgs }` with no `kind`.
    // (`extends` entries are typeName nodes and are covered above.)
    if (Array.isArray(node.implements)) {
      for (const ref of node.implements) {
        if (ref && typeof ref === "object") note(ref.name, ref.sourceLoc ?? loc);
      }
    }
  });

  return refs;
}

function collectLocallyBoundNames(ast) {
  const bound = new Set();
  walk(ast, (node) => {
    if (typeof node.name === "string" && BINDING_KINDS.has(node.kind)) {
      bound.add(node.name);
    }
    // switch-case variant payload bindings (`case Result.Ok { value: n }`)
    if (typeof node.kind === "string" && node.kind.endsWith("PATTERN")) {
      for (const value of Object.values(node)) {
        if (typeof value === "string") bound.add(value);
        if (Array.isArray(value)) {
          for (const entry of value) {
            if (entry && typeof entry === "object" && typeof entry.binding === "string") {
              bound.add(entry.binding);
            }
          }
        }
      }
    }
  });
  return bound;
}

// checkImportLocality - runs after pass B, once imports are wired.
//
// Only modules that span more than one source file can leak an import, so
// single-file modules (every module that predates directory modules) are skipped
// outright and cost nothing.
export function checkImportLocality(modules, moduleEnv, errors) {
  const byModule = new Map();
  for (const mod of modules) {
    let group = byModule.get(mod.id);
    if (!group) {
      group = [];
      byModule.set(mod.id, group);
    }
    group.push(mod);
  }

  for (const [modId, files] of byModule) {
    if (files.length < 2) continue;
    const importedNames = moduleEnv.get(modId)?.importedNames;
    if (!importedNames || importedNames.size === 0) continue;

    const ownByFile = new Map();
    for (const mod of files) ownByFile.set(mod, ownImportedNames(mod.ast));

    for (const mod of files) {
      const own = ownByFile.get(mod);
      const bound = collectLocallyBoundNames(mod.ast);
      for (const [name, loc] of collectReferencedNames(mod.ast)) {
        if (own.has(name)) continue; // imported right here - fine
        if (bound.has(name)) continue; // a local of this file shadows it
        if (!importedNames.has(name)) continue; // a module declaration, or global
        // Name the sibling that did import it, so the fix is obvious.
        const owner = files.find((f) => f !== mod && ownByFile.get(f).has(name));
        const via = owner ? ` (imported by ${basename(owner.absPath)})` : "";
        pushError(
          errors,
          { sourceLoc: loc },
          `"${name}" is not imported by this file${via} - a module's source files share its declarations but NOT its imports, so add the import here`,
        );
        // Stamp the origin here: this pass reports per source FILE across a
        // whole module group, so the caller has no single `mod` to attribute to.
        const pushed = errors[errors.length - 1];
        if (pushed) {
          pushed.moduleId ??= mod.id;
          pushed.srcPath ??= mod.absPath;
        }
      }
    }
  }
}

function basename(absPath) {
  return String(absPath ?? "").replace(/^.*[/\\]/, "");
}
