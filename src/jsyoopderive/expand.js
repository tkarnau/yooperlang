// Phase 13.C: @derive(display) - pre-typecheck expansion.
//
// For each module-top-level `@derive(display)`-wrapped TYPE_DECL, generate a
// `Display.to_string` method AS YOOP SOURCE TEXT from the decl's field
// annotations, reparse it with the ordinary parser (inside a dummy wrapper
// type, which satisfies the parser's methods-need-implements constraint),
// restamp every sourceLoc onto the original type decl, and graft the method
// into the decl. Downstream typecheck passes fill in resolvedFuncType /
// implementsTraits / resolvedType exactly as if the user had written the
// method by hand - no post-hoc stamping here.
//
// The ATTRIBUTE wrapper is always replaced by its target in ast.body (success
// or error): codegen and the comptime pass do not unwrap ATTRIBUTE nodes, and
// contracts.js requires that none survive to codegen.
//
// Display is not a builtin - it lives in std/core/traits.yoop, which the
// driver autoloads into every module graph. A deriving module that doesn't
// already bind the name gets a synthesized
// `import { Display } from "std/core/traits.yoop"` unshifted onto its body
// (imports must stay body-first for the imports-first rule in resolveImports).
//
// Runs at the very front of typecheckProgram, before pass A. Errors follow
// the typechecker convention: accumulated into the shared errors array,
// never thrown.

import { parse } from "../jsyooparser/parser.js";
import { ASTNodeKind } from "../contracts.js";

const TRAITS_STD_PATH = "std/core/traits.yoop";

// Entry point. `modules` is the driver's topo-ordered module list; `errors`
// is typecheckProgram's shared accumulator.
export function expandDerives(modules, errors) {
  // Resolved lazily - only programs that actually derive pay the lookup.
  let traitsModuleId;
  const traitsId = () => {
    if (traitsModuleId === undefined) traitsModuleId = findTraitsModuleId(modules);
    return traitsModuleId;
  };

  for (const mod of modules) {
    if (mod.ast.deriveExpanded) continue; // idempotence across re-typechecks
    mod.ast.deriveExpanded = true;

    const body = mod.ast.body;
    for (let i = 0; i < body.length; i++) {
      const node = body[i];
      if (node.kind !== ASTNodeKind.ATTRIBUTE || node.name !== "derive") {
        continue;
      }
      // Unwrap unconditionally so the ATTRIBUTE never reaches codegen; the
      // export wrapper (if any) stays in place.
      body[i] = node.target;
      const typeDecl =
        node.target.kind === ASTNodeKind.EXPORT_DECL
          ? node.target.decl
          : node.target;

      // Guard rails - first hit wins, decl is left underived.
      const isVariant = typeDecl.kind === ASTNodeKind.VARIANT_DECL;
      if (typeDecl.kind !== ASTNodeKind.TYPE_DECL && !isVariant) {
        // parsePhase already screens this; defensive for hand-built ASTs.
        errors.push({
          message: `@derive(display) only applies to a struct 'type' or 'variant' declaration`,
          sourceLoc: node.sourceLoc,
        });
        continue;
      }
      if (typeDecl.targetType) {
        errors.push({
          message: `@derive(display) cannot apply to type alias "${typeDecl.name}" - it only applies to struct and variant declarations`,
          sourceLoc: typeDecl.sourceLoc,
        });
        continue;
      }
      if ((typeDecl.typeParams ?? []).length > 0) {
        // Generic variants additionally need method substitution through the
        // instantiation registry, which does not exist yet; generic structs
        // need type-param-aware interpolation. Both stay manual for now.
        errors.push({
          message: `@derive(display) on generic ${isVariant ? "variant" : "type"} "${typeDecl.name}" is not yet supported - write the Display impl manually`,
          sourceLoc: typeDecl.sourceLoc,
        });
        continue;
      }
      if ((typeDecl.methods ?? []).some((m) => m.name === "to_string")) {
        errors.push({
          message: `${isVariant ? "variant" : "type"} "${typeDecl.name}" already defines "to_string" - remove @derive(display) or the manual method`,
          sourceLoc: typeDecl.sourceLoc,
        });
        continue;
      }
      if (!traitsId()) {
        errors.push({
          message: `@derive(display) requires ${TRAITS_STD_PATH} in the module graph - compile through the yoopiler driver`,
          sourceLoc: typeDecl.sourceLoc,
        });
        continue;
      }

      expandOne(typeDecl, mod, traitsId(), isVariant);
    }
  }
}

function expandOne(typeDecl, mod, traitsModuleId, isVariant) {
  const { method, labels } = buildToStringMethod(typeDecl, isVariant);
  annotateDerived(method, typeDecl.sourceLoc, typeDecl.name, labels);

  typeDecl.methods = typeDecl.methods ?? [];
  typeDecl.methods.push(method);

  if (!(typeDecl.implements ?? []).some((c) => c.name === "Display")) {
    typeDecl.implements = typeDecl.implements ?? [];
    typeDecl.implements.push({
      name: "Display",
      typeArgs: null,
      sourceLoc: typeDecl.sourceLoc,
    });
  }

  if (!moduleBindsDisplay(mod)) {
    mod.ast.body.unshift({
      kind: ASTNodeKind.IMPORT_DECL,
      importKind: "named",
      sourcePath: TRAITS_STD_PATH,
      specifiers: [
        {
          exportName: "Display",
          localName: "Display",
          sourceLoc: typeDecl.sourceLoc,
        },
      ],
      resolvedModuleId: traitsModuleId,
      sourceLoc: typeDecl.sourceLoc,
    });
  }
}

// Generate the method source, wrap it in a dummy host type (the parser
// rejects methods on a type with an empty implements list), parse, and pull
// the METHOD_DECL back out. Also returns the local-name -> field-name map the
// diagnostic path uses to name a field the user can act on (see
// derivedFieldLabel in checkExpr.js).
function buildToStringMethod(decl, isVariant) {
  const labels = {};
  const bodyLines = isVariant
    ? generateVariantBody(decl, labels)
    : generateStructBody(decl, labels);
  const src =
    `type __DeriveHost implements Display {\n` +
    `  function to_string(ref self): string {\n` +
    bodyLines.map((line) => `    ${line}\n`).join("") +
    `  }\n` +
    `}\n`;
  const prog = parse(src);
  return { method: prog.body[0].methods[0], labels };
}

// One field's contribution: pushes any setup statements onto `lines` and
// returns the `name: <text>` fragment for the enclosing template.
//
// `access` is the source expression holding the value - `self.x` for a struct
// field, a pattern-bound local for a variant payload. `slot` uniquifies the
// generated locals. Strategy by classify() shape: scalars and
// Display-implementing types interpolate directly (the template machinery
// handles primitive formatting and Display dispatch, including through
// `ref`); arrays and Vec<T> of such elements get an accumulator loop;
// anything else prints a fixed placeholder rather than erroring.
function fieldFragment(field, access, slot, lines, labels) {
  const cls = classify(field.typeAnnotation);
  if (cls === "inline") {
    // A bare-identifier access (variant payload binding) needs a label so a
    // non-printable field can be named in the diagnostic; `self.x` carries
    // its own field name.
    if (!access.includes(".")) labels[access] = field.name;
    return `${field.name}: \${${access}}`;
  }
  if (cls === "array") {
    // The array is bound to a local before the for-in: `for x in self.f {`
    // trips the variant-constructor postfix (`IDENT.IDENT {` parses as
    // `Enum.Variant { ... }`), so the iterated expression must be a bare
    // identifier.
    labels[`_deriveItem${slot}`] = `${field.name} (element)`;
    lines.push(
      `let _deriveArr${slot} = ${access};`,
      `let _deriveF${slot}: string = "[";`,
      `let _deriveFirst${slot}: bool = true;`,
      `for _deriveItem${slot} in _deriveArr${slot} {`,
      `  if (_deriveFirst${slot}) {`,
      `    _deriveF${slot} = \`\${_deriveF${slot}}\${_deriveItem${slot}}\`;`,
      `    _deriveFirst${slot} = false;`,
      `  } else {`,
      `    _deriveF${slot} = \`\${_deriveF${slot}}, \${_deriveItem${slot}}\`;`,
      `  }`,
      `}`,
      `_deriveF${slot} = \`\${_deriveF${slot}}]\`;`,
    );
    return `${field.name}: \${_deriveF${slot}}`;
  }
  if (cls === "vec") {
    labels[`_deriveElem${slot}`] = `${field.name} (element)`;
    lines.push(
      `let _deriveVec${slot} = ${access};`,
      `let _deriveF${slot}: string = "[";`,
      `let _deriveI${slot}: usize = 0;`,
      `while (_deriveI${slot} < _deriveVec${slot}.len) {`,
      `  if (_deriveI${slot} > 0) {`,
      `    _deriveF${slot} = \`\${_deriveF${slot}}, \`;`,
      `  }`,
      `  let _deriveElem${slot} = _deriveVec${slot}.data[_deriveI${slot}];`,
      `  _deriveF${slot} = \`\${_deriveF${slot}}\${_deriveElem${slot}}\`;`,
      `  _deriveI${slot} = _deriveI${slot} + 1;`,
      `}`,
      `_deriveF${slot} = \`\${_deriveF${slot}}]\`;`,
    );
    return `${field.name}: \${_deriveF${slot}}`;
  }
  if (cls === "map") {
    labels[`_deriveElem${slot}`] = `${field.name} (element)`;
    lines.push(
      `let _deriveMap${slot} = ${access};`,
      `let _deriveF${slot}: string = "[";`,
      `let _deriveI${slot}: usize = 0;`,
      `while (_deriveI${slot} < _deriveMap${slot}.cap) {`, // need to use cap because of sparse data structure... could be big issue at some point.
      `  if (_deriveMap${slot}.states[_deriveI${slot}] != 1) {`, // if not occupied...
      `    _deriveI${slot} = _deriveI${slot} + 1;`,
      `    continue;`, // skip unoccupied
      `  }`,
      `  if (_deriveF${slot}.len > 1) {`, // if we've inserted anything except the '['
      `    _deriveF${slot} = \`\${_deriveF${slot}}, \`;`,
      `  }`,
      `  let _deriveElem${slot}_key = _deriveMap${slot}.keys[_deriveI${slot}];`,
      `  let _deriveElem${slot}_value = _deriveMap${slot}.values[_deriveI${slot}];`,
      `  _deriveF${slot} = \`\${_deriveF${slot}}{ key: \${_deriveElem${slot}_key}, value: \${_deriveElem${slot}_value} }\`;`,
      `  _deriveI${slot} = _deriveI${slot} + 1;`,
      `}`,
      `_deriveF${slot} = \`\${_deriveF${slot}}]\`;`,
    );
    return `${field.name}: \${_deriveF${slot}}`;
  }
  // Placeholder classification carries the display text directly.
  return `${field.name}: ${cls}`;
}

function generateStructBody(typeDecl, labels) {
  const fields = typeDecl.fields ?? [];
  if (fields.length === 0) {
    return [`return "${typeDecl.name} { }";`];
  }
  const lines = [];
  const parts = fields.map((field, i) =>
    fieldFragment(field, `self.${field.name}`, `${i}`, lines, labels),
  );
  lines.push(`return \`${typeDecl.name} { ${parts.join(", ")} }\`;`);
  return lines;
}

// Phase 13.D: an arm-per-case switch over `self`. Payload fields bind to
// generated locals (user field names could collide with our temporaries) and
// print with the same per-field rules as struct fields. Output mirrors the
// constructor syntax - `Shape.Circle { r: 5 }` / `Shape.Dot` - so a dump
// reads back as the source that would rebuild it.
//
// The switch covers every declared case, and an exhaustive switch needs no
// trailing return, so the generated body ends at the closing brace.
function generateVariantBody(variantDecl, labels) {
  const lines = ["switch (self) {"];
  (variantDecl.variants ?? []).forEach((vcase, ci) => {
    const caseName = `${variantDecl.name}.${vcase.name}`;
    const payload = vcase.fields ?? null;
    if (payload === null) {
      lines.push(`  case ${caseName}: {`, `    return "${caseName}";`, `  }`);
      return;
    }
    const bindings = payload
      .map((f, fi) => `${f.name}: _deriveP${ci}_${fi}`)
      .join(", ");
    const armLines = [];
    const parts = payload.map((field, fi) =>
      fieldFragment(field, `_deriveP${ci}_${fi}`, `${ci}_${fi}`, armLines, labels),
    );
    lines.push(`  case ${caseName} { ${bindings} }: {`);
    for (const l of armLines) lines.push(`    ${l}`);
    lines.push(`    return \`${caseName} { ${parts.join(", ")} }\`;`, `  }`);
  });
  lines.push("}");
  return lines;
}

// Classify a field's type annotation into an emission strategy:
//   "inline"       - interpolate `${self.f}` (prims, named types, refs of those)
//   "array"        - T[] of inline elems: for-in accumulator loop
//   "vec"          - Vec<T> of inline elems: index loop over data/len
//   anything else  - the literal placeholder text to print (e.g. "<map>")
function classify(annot) {
  if (!annot) return "<unknown>";
  switch (annot.kind) {
    case "refType":
      // resolveTemplateLiteral derefs refs before the Display/prim check,
      // so a ref field interpolates the same as its inner type. Loops over
      // ref-of-array are not a thing v1 supports - only pass through the
      // inline classification.
      return classify(annot.inner) === "inline" ? "inline" : "<ref>";
    case "typeName":
      return "inline";
    case "arrayType":
      return classify(annot.elem) === "inline" ? "array" : "<array>";
    case "typeApplication":
      if (annot.name === "Vec" && (annot.typeArgs ?? []).length === 1) {
        return classify(annot.typeArgs[0]) === "inline" ? "vec" : "<vec>";
      }
      if (annot.name === "Map" && (annot.typeArgs ?? []).length === 2) {
        const shouldExpand =
          classify(annot.typeArgs[0]) === "inline" &&
          classify(annot.typeArgs[1] === "inline");
        return shouldExpand ? "map" : "<map>";
      }
      return `<${annot.name.toLowerCase()}>`;
    case "functionType":
      return "<fn>";
    default:
      return "<unknown>";
  }
}

// Two jobs in one walk over the extracted method:
//
//   1. Diagnostics from the generated body must point at the user's decl
//      line, never into the synthetic reparsed text - every `sourceLoc`-named
//      slot is overwritten with the decl's location.
//   2. Every TEMPLATE_LITERAL is tagged with the owning type name and the
//      local -> field-name labels, so a non-printable field produces a
//      diagnostic naming the field instead of the generic "template literal
//      interpolation must be..." wording for a template the user never wrote
//      (see resolveTemplateLiteral / derivedFieldLabel in checkExpr.js).
//
// Post-parse ASTs are trees, but the seen-set is cheap insurance against
// future backrefs.
function annotateDerived(node, loc, owner, labels, seen = new Set()) {
  if (node === null || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) annotateDerived(item, loc, owner, labels, seen);
    return;
  }
  if (node.kind === ASTNodeKind.TEMPLATE_LITERAL) {
    node.deriveOwner = owner;
    node.deriveLabels = labels;
  }
  for (const key of Object.keys(node)) {
    if (key === "sourceLoc" || key === "nameSourceLoc" || key === "argsSourceLoc") {
      if (node[key] != null) node[key] = loc;
      continue;
    }
    if (key === "deriveLabels") continue; // not an AST subtree
    annotateDerived(node[key], loc, owner, labels, seen);
  }
}

// A module already binds `Display` if it imports that local name or declares
// a trait named Display itself (std/core/traits.yoop is the canonical case).
function moduleBindsDisplay(mod) {
  for (const decl of mod.ast.body) {
    if (decl.kind === ASTNodeKind.IMPORT_DECL) {
      if ((decl.specifiers ?? []).some((s) => s.localName === "Display")) {
        return true;
      }
      continue;
    }
    const inner = decl.kind === ASTNodeKind.EXPORT_DECL ? decl.decl : decl;
    if (inner?.kind === ASTNodeKind.TRAIT_DECL && inner.name === "Display") {
      return true;
    }
  }
  return false;
}

// The synthesized import needs the traits module's stable id. Prefer the
// module whose absPath ends with std/core/traits.yoop (the autoload);
// fall back to any module exporting a trait named Display (stub std roots
// in tests). Null when absent - callers surface a guard-rail error.
function findTraitsModuleId(modules) {
  for (const mod of modules) {
    const p = mod.absPath ?? "";
    if (
      p.endsWith("std/core/traits.yoop") ||
      p.endsWith("std\\core\\traits.yoop")
    ) {
      return mod.id;
    }
  }
  for (const mod of modules) {
    for (const decl of mod.ast.body) {
      if (decl.kind !== ASTNodeKind.EXPORT_DECL) continue;
      if (decl.decl?.kind === ASTNodeKind.TRAIT_DECL && decl.decl.name === "Display") {
        return mod.id;
      }
    }
  }
  return null;
}
