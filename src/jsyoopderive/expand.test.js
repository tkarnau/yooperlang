// Unit tests for the @derive(display) pre-typecheck expansion.
// These exercise the expansion in isolation (no typecheck, no clang) - the
// end-to-end behavior lives in src/e2e.test.js.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parse } from "../jsyooparser/parser.js";
import { ASTNodeKind } from "../contracts.js";
import { expandDerives } from "./expand.js";

// A stand-in for the autoloaded std/core/traits.yoop module.
function traitsStub() {
  return {
    id: "traits_stub",
    absPath: "/stub/std/core/traits.yoop",
    ast: parse(
      `export trait Display {\n  function toString(ref self): string;\n}\n`,
    ),
  };
}

function moduleFromSource(src, id = "fixture") {
  return { id, ast: parse(src) };
}

function expand(src) {
  const mod = moduleFromSource(src);
  const errors = [];
  expandDerives([traitsStub(), mod], errors);
  return { mod, errors };
}

function typeDeclIn(mod, name) {
  for (const decl of mod.ast.body) {
    const inner = decl.kind === ASTNodeKind.EXPORT_DECL ? decl.decl : decl;
    if (inner?.kind === ASTNodeKind.TYPE_DECL && inner.name === name) {
      return inner;
    }
  }
  return null;
}

describe("expandDerives", () => {
  it("grafts toString + implements Display and consumes the ATTRIBUTE", () => {
    const { mod, errors } = expand(
      `@derive(display)\ntype Point {\n  x: int32,\n  y: int32,\n}\n`,
    );
    assert.equal(errors.length, 0);
    assert.ok(
      mod.ast.body.every((d) => d.kind !== ASTNodeKind.ATTRIBUTE),
      "ATTRIBUTE wrapper must not survive expansion",
    );
    const decl = typeDeclIn(mod, "Point");
    assert.ok(decl);
    assert.equal(decl.methods.length, 1);
    assert.equal(decl.methods[0].name, "toString");
    assert.equal(decl.methods[0].params[0].name, "self");
    assert.equal(
      decl.implements.filter((c) => c.name === "Display").length,
      1,
    );
  });

  it("works on the export-wrapped form", () => {
    const { mod, errors } = expand(
      `@derive(display)\nexport type Pt {\n  x: int32,\n}\n`,
    );
    assert.equal(errors.length, 0);
    const decl = typeDeclIn(mod, "Pt");
    assert.equal(decl.methods.length, 1);
    // the export wrapper survives in the body
    assert.ok(
      mod.ast.body.some(
        (d) => d.kind === ASTNodeKind.EXPORT_DECL && d.decl === decl,
      ),
    );
  });

  it("synthesizes an import { Display } at body front when unbound", () => {
    const { mod } = expand(`@derive(display)\ntype P {\n  x: int32,\n}\n`);
    const first = mod.ast.body[0];
    assert.equal(first.kind, ASTNodeKind.IMPORT_DECL);
    assert.equal(first.importKind, "named");
    assert.equal(first.resolvedModuleId, "traits_stub");
    assert.deepEqual(
      first.specifiers.map((s) => [s.exportName, s.localName]),
      [["Display", "Display"]],
    );
  });

  it("skips the import when the module already binds Display", () => {
    const { mod, errors } = expand(
      `import { Display } from "std/core/traits.yoop";\n\n@derive(display)\ntype P {\n  x: int32,\n}\n`,
    );
    assert.equal(errors.length, 0);
    const imports = mod.ast.body.filter(
      (d) => d.kind === ASTNodeKind.IMPORT_DECL,
    );
    assert.equal(imports.length, 1);
  });

  it("does not duplicate an existing implements Display clause", () => {
    const { mod, errors } = expand(
      `import { Display } from "std/core/traits.yoop";\n\n@derive(display)\ntype P implements Display {\n  x: int32,\n}\n`,
    );
    assert.equal(errors.length, 0);
    const decl = typeDeclIn(mod, "P");
    assert.equal(
      decl.implements.filter((c) => c.name === "Display").length,
      1,
    );
    assert.equal(decl.methods.length, 1);
  });

  it("restamps every sourceLoc in the grafted method onto the type decl", () => {
    const { mod } = expand(
      `@derive(display)\ntype P {\n  xs: int32[],\n}\n`,
    );
    const decl = typeDeclIn(mod, "P");
    const locs = [];
    (function walk(node, seen = new Set()) {
      if (node === null || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const x of node) walk(x, seen);
        return;
      }
      for (const key of Object.keys(node)) {
        if (key === "sourceLoc" && node[key] != null) locs.push(node[key]);
        else walk(node[key], seen);
      }
    })(decl.methods[0]);
    assert.ok(locs.length > 0);
    for (const loc of locs) assert.equal(loc, decl.sourceLoc);
  });

  it("is idempotent across repeated calls", () => {
    const mod = moduleFromSource(
      `@derive(display)\ntype P {\n  x: int32,\n}\n`,
    );
    const errors = [];
    const mods = [traitsStub(), mod];
    expandDerives(mods, errors);
    expandDerives(mods, errors);
    assert.equal(errors.length, 0);
    assert.equal(typeDeclIn(mod, "P").methods.length, 1);
  });

  it("rejects a type that already defines toString", () => {
    const { mod, errors } = expand(
      `import { Display } from "std/core/traits.yoop";\n\n@derive(display)\ntype P implements Display {\n  x: int32,\n  function toString(ref self): string {\n    return "manual";\n  }\n}\n`,
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /already defines "toString"/);
    assert.equal(typeDeclIn(mod, "P").methods.length, 1); // manual only
  });

  it("rejects generic type decls", () => {
    const { errors } = expand(
      `@derive(display)\ntype Pair<T> {\n  a: T,\n}\n`,
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /generic type "Pair" is not yet supported/);
  });

  it("rejects type aliases", () => {
    const { errors } = expand(`@derive(display)\ntype NodeId = usize;\n`);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /cannot apply to type alias "NodeId"/);
  });

  it("errors when no traits module is in the graph", () => {
    const mod = moduleFromSource(
      `@derive(display)\ntype P {\n  x: int32,\n}\n`,
    );
    const errors = [];
    expandDerives([mod], errors);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /requires std\/core\/traits\.yoop/);
  });

  it("generates loops for arrays and Vec, placeholders for fn types", () => {
    const { mod, errors } = expand(
      `import { Vec } from "std/core/vec.yoop";\n\n@derive(display)\ntype Bag {\n  xs: int32[],\n  v: Vec<int32>,\n  cb: (n: int32) => int32,\n}\n`,
    );
    assert.equal(errors.length, 0);
    const body = typeDeclIn(mod, "Bag").methods[0].body.body;
    // array + vec loops prepend statements; the final return is a template.
    assert.ok(body.length > 1);
    const last = body[body.length - 1];
    assert.equal(last.kind, ASTNodeKind.RETURN_STATEMENT);
    const text = last.value.parts
      .filter((p) => p.kind === ASTNodeKind.STRING_PART)
      .map((p) => p.value)
      .join("");
    assert.match(text, /cb: <fn>/);
  });

  it("zero-field types return a plain string literal", () => {
    const { mod, errors } = expand(`@derive(display)\ntype Empty {\n}\n`);
    assert.equal(errors.length, 0);
    const body = typeDeclIn(mod, "Empty").methods[0].body.body;
    assert.equal(body.length, 1);
    assert.equal(body[0].kind, ASTNodeKind.RETURN_STATEMENT);
    assert.equal(body[0].value.kind, ASTNodeKind.STRING_LITERAL);
  });
});

describe("expandDerives: variants", () => {
  function variantDeclIn(mod, name) {
    for (const decl of mod.ast.body) {
      const inner = decl.kind === ASTNodeKind.EXPORT_DECL ? decl.decl : decl;
      if (inner?.kind === ASTNodeKind.VARIANT_DECL && inner.name === name) {
        return inner;
      }
    }
    return null;
  }

  it("grafts a switch-bodied toString and appends implements Display", () => {
    const { mod, errors } = expand(
      `@derive(display)\nvariant Shape {\n  Circle { r: int32 },\n  Dot,\n}\n`,
    );
    assert.equal(errors.length, 0);
    assert.ok(mod.ast.body.every((d) => d.kind !== ASTNodeKind.ATTRIBUTE));
    const decl = variantDeclIn(mod, "Shape");
    assert.equal(decl.methods.length, 1);
    assert.equal(decl.methods[0].name, "toString");
    assert.equal(
      decl.implements.filter((c) => c.name === "Display").length,
      1,
    );
    // The body is a single exhaustive switch - no trailing return needed.
    const body = decl.methods[0].body.body;
    assert.equal(body.length, 1);
    assert.equal(body[0].kind, ASTNodeKind.SWITCH_STATEMENT);
    assert.equal(body[0].arms.length, 2);
  });

  it("records payload-local labels so diagnostics can name the field", () => {
    const { mod } = expand(
      `@derive(display)\nvariant Shape {\n  Circle { r: int32 },\n  Dot,\n}\n`,
    );
    const decl = variantDeclIn(mod, "Shape");
    const arm = decl.methods[0].body.body[0].arms[0];
    const ret = arm.body.body[arm.body.body.length - 1];
    assert.equal(ret.kind, ASTNodeKind.RETURN_STATEMENT);
    assert.equal(ret.value.deriveOwner, "Shape");
    // the pattern binding maps back to the declared payload field name
    assert.equal(ret.value.deriveLabels["_deriveP0_0"], "r");
  });

  it("rejects generic variants", () => {
    const { errors } = expand(
      `@derive(display)\nvariant Maybe<T> {\n  Some { value: T },\n  None,\n}\n`,
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /generic variant "Maybe" is not yet supported/);
  });

  it("rejects a variant that already defines toString", () => {
    const { errors } = expand(
      `import { Display } from "std/core/traits.yoop";\n\n@derive(display)\nvariant Shape implements Display {\n  Dot,\n  function toString(ref self): string {\n    return "manual";\n  }\n}\n`,
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /variant "Shape" already defines "toString"/);
  });
});
