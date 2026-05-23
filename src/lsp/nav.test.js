// Unit tests for nav.js — the position-resolution and definition lookup
// layer shared by hover / definition / documentSymbol. Drives analyze()
// against a temp on-disk fixture so the module graph + typecheck run
// end-to-end and resolvedType / resolvedDeclNode are stamped on the AST.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { analyze } from "./analyze.js";
import {
  collectDocumentSymbols,
  findDefinition,
  findNodeAt,
  getHoverInfo,
  posToOffset,
} from "./nav.js";

function writeFixture(src, filename = "main.yoop") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_nav_"));
  const file = path.join(dir, filename);
  fs.writeFileSync(file, src);
  return fs.realpathSync(file);
}

function analyzeFixture(src, filename = "main.yoop") {
  const entry = writeFixture(src, filename);
  const result = analyze(entry, new Map());
  const mod = result.modules.find((m) => m.absPath === entry);
  assert.ok(mod, "expected entry module in analyze result");
  return { result, mod, entry, src };
}

describe("nav: posToOffset", () => {
  it("treats line/character as 0-indexed", () => {
    const src = "abc\ndef\nghi";
    assert.equal(posToOffset(src, 0, 0), 0);
    assert.equal(posToOffset(src, 0, 2), 2);
    assert.equal(posToOffset(src, 1, 0), 4);
    assert.equal(posToOffset(src, 2, 2), 10);
  });

  it("clamps characters past end of line at the newline", () => {
    const src = "ab\ncd";
    assert.equal(posToOffset(src, 0, 50), 2); // stops at the \n
  });
});

describe("nav: findNodeAt", () => {
  it("returns the smallest containing node", () => {
    const src = `function add(a: int32, b: int32): int32 {
    return a + b;
}
`;
    const { mod } = analyzeFixture(src);
    // Position over the `a` in `a + b` (line 1, col 11 in 0-indexed)
    const aOffset = src.indexOf("a + b");
    const node = findNodeAt(mod.ast, aOffset, src);
    assert.ok(node, "expected to find a node");
    // The smallest enclosing node should be the IDENT `a` (length 1).
    assert.equal(node.kind, "IDENT");
    assert.equal(node.name, "a");
  });

  it("returns null when offset is outside any node", () => {
    const src = `function f(): int32 { return 0; }\n`;
    const { mod } = analyzeFixture(src);
    // Offset past the end of file
    const node = findNodeAt(mod.ast, src.length + 100, src);
    assert.equal(node, null);
  });
});

describe("nav: getHoverInfo", () => {
  it("returns type info for a local IDENT reference", () => {
    const src = `function f(): int32 {
    let x: int32 = 7;
    return x;
}
`;
    const { mod } = analyzeFixture(src);
    // Position over the `x` in `return x;`
    const refOff = src.lastIndexOf("x");
    const node = findNodeAt(mod.ast, refOff, src);
    assert.equal(node.kind, "IDENT");
    const hover = getHoverInfo(node, mod);
    assert.match(hover, /int32/);
    assert.match(hover, /\bx\b/);
  });

  it("returns function signature for a FUNCTION_DECL", () => {
    const src = `function add(a: int32, b: int32): int32 {
    return a + b;
}
`;
    const { mod } = analyzeFixture(src);
    // Position over the `add` identifier in the function decl
    const off = src.indexOf("add");
    const node = findNodeAt(mod.ast, off, src);
    assert.equal(node?.kind, "FUNCTION_DECL");
    const hover = getHoverInfo(node, mod);
    assert.match(hover, /function add\(.*\):/);
    assert.match(hover, /int32/);
  });
});

describe("nav: findDefinition", () => {
  it("resolves an IDENT reference to its LET_DECL", () => {
    const src = `function f(): int32 {
    let x: int32 = 7;
    return x;
}
`;
    const { mod, result } = analyzeFixture(src);
    const refOff = src.lastIndexOf("x");
    const node = findNodeAt(mod.ast, refOff, src);
    const def = findDefinition(node, { module: mod, modById: result.modById });
    assert.ok(def);
    // Jump lands on the variable name `x`, not the `let` keyword.
    const nameOff = src.indexOf("x: int32");
    assert.equal(def.pos, nameOff, `expected def.pos at "x: int32" (${nameOff}), got ${def.pos}`);
    assert.equal(def.absPath, mod.absPath);
  });

  it("resolves a call to its function decl in the same module", () => {
    const src = `function add(a: int32, b: int32): int32 {
    return a + b;
}
function main(): int32 {
    return add(1, 2);
}
`;
    const { mod, result } = analyzeFixture(src);
    const callOff = src.indexOf("add(1");
    const node = findNodeAt(mod.ast, callOff, src);
    assert.equal(node.kind, "CALL_EXPRESSION");
    const def = findDefinition(node, { module: mod, modById: result.modById });
    assert.ok(def);
    // Jump lands on the function *name* token, not the `function` keyword.
    const nameOff = src.indexOf("add");
    assert.equal(def.pos, nameOff);
  });
});

describe("nav: collectDocumentSymbols", () => {
  it("emits a Function + Struct outline", () => {
    const src = `type Point {
    x: int32,
    y: int32,
}
function distance(p: Point): int32 {
    return p.x * p.x + p.y * p.y;
}
`;
    const { mod, src: text } = analyzeFixture(src);
    const symbols = collectDocumentSymbols(mod.ast, text);
    const names = symbols.map((s) => s.name);
    assert.ok(names.includes("Point"), `expected Point in ${names}`);
    assert.ok(names.includes("distance"), `expected distance in ${names}`);
    const point = symbols.find((s) => s.name === "Point");
    const fieldNames = (point.children ?? []).map((c) => c.name);
    assert.deepEqual(fieldNames.sort(), ["x", "y"]);
  });
});
