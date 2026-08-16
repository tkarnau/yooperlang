// Unit tests for nav.js - the position-resolution and definition lookup
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
  docCommentAt,
  findDefinition,
  findNodeAt,
  getHoverInfo,
  hoverFromName,
  identTokenAt,
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

describe("nav: variant + value-enum hover and goto-def", () => {
  it("hover on a variant decl says 'variant', not 'enum'", () => {
    const src = `variant Shape { Circle, Square }
function main(): int32 { return 0; }
`;
    const { mod } = analyzeFixture(src);
    const off = src.indexOf("Shape");
    const node = findNodeAt(mod.ast, off, src);
    assert.equal(node.kind, "VARIANT_DECL");
    const hover = getHoverInfo(node, mod);
    assert.equal(hover, "variant Shape");
  });

  it("hover on a value-enum decl renders 'enum Name' (or with underlying)", () => {
    const src = `enum Color { Red, Green, Blue }
enum Big<int64> { Zero 0 }
function main(): int32 { return 0; }
`;
    const { mod } = analyzeFixture(src);
    const colorOff = src.indexOf("Color");
    const colorNode = findNodeAt(mod.ast, colorOff, src);
    assert.equal(colorNode.kind, "ENUM_DECL");
    assert.equal(getHoverInfo(colorNode, mod), "enum Color");
    const bigOff = src.indexOf("Big");
    const bigNode = findNodeAt(mod.ast, bigOff, src);
    assert.equal(getHoverInfo(bigNode, mod), "enum Big<int64>");
  });

  it("hover on a variant-constructor expression renders Type.Case + carrier", () => {
    const src = `enum Color { Red, Green, Blue }
function main(): int32 {
    let c: Color = Color.Red;
    return 0;
}
`;
    const { mod } = analyzeFixture(src);
    const off = src.indexOf("Color.Red");
    const node = findNodeAt(mod.ast, off, src);
    // After typecheck promotion the node is a VARIANT_CONSTRUCTOR.
    assert.equal(node.kind, "VARIANT_CONSTRUCTOR");
    const hover = getHoverInfo(node, mod);
    assert.match(hover, /^Color\.Red:/);
  });

  it("goto-def on a value-enum case lands on the case row, not the enum decl", () => {
    const src = `enum Color { Red, Green, Blue }
function main(): int32 {
    let c: Color = Color.Red;
    return 0;
}
`;
    const { mod, result } = analyzeFixture(src);
    const caseOff = src.lastIndexOf("Red");
    const tok = identTokenAt(src, caseOff);
    const node = findNodeAt(mod.ast, caseOff, src);
    const def = findDefinition(node, {
      module: mod,
      modById: result.modById,
      tokenText: tok?.text,
      tokenStart: tok?.start,
      moduleEnv: result.moduleEnv,
    });
    assert.ok(def);
    // The case row "Red" lives in the enum body, not at the enum name.
    const enumDeclOff = src.indexOf("Color"); // first "Color" is the decl
    assert.notEqual(def.pos, enumDeclOff, "case def should not point at the enum name");
    // It should point at the "Red" inside the enum body.
    const caseDeclOff = src.indexOf("Red");
    assert.equal(def.pos, caseDeclOff);
  });
});

describe("nav: namespace-prefixed access", () => {
  it("dotted type annotation cursor jumps across modules", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_nav_ns_"));
    const m = path.join(dir, "m.yoop");
    const main = path.join(dir, "main.yoop");
    fs.writeFileSync(m, `export type Point { x: int32, y: int32 }
`);
    const mainSrc = `import * as m from "./m.yoop";
function f(): int32 {
    let p: m.Point = { x: 1, y: 2 };
    return p.x;
}
function main(): int32 { return f(); }
`;
    fs.writeFileSync(main, mainSrc);
    const result = analyze(fs.realpathSync(main), new Map());
    assert.deepEqual(result.diagnostics, []);
    const mainMod = result.modules.find((mm) => mm.absPath === fs.realpathSync(main));
    // Cursor on `Point` in `m.Point` annotation - that's not an AST node,
    // so findNodeAt returns null and findDefinition must fall back via
    // the dotted-sniff path.
    const pointOff = mainSrc.indexOf("m.Point") + 2;
    const tok = identTokenAt(mainSrc, pointOff);
    assert.equal(tok?.text, "Point");
    const node = findNodeAt(mainMod.ast, pointOff, mainSrc);
    const def = findDefinition(node, {
      module: mainMod,
      modById: result.modById,
      tokenText: tok?.text,
      tokenStart: tok?.start,
      moduleEnv: result.moduleEnv,
    });
    assert.ok(def, "expected a def for ns.Type annotation cursor");
    assert.equal(def.absPath, fs.realpathSync(m));
  });

  it("goto-def on a namespace-prefixed const lands in the source module", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_nav_ns2_"));
    const m = path.join(dir, "m.yoop");
    const main = path.join(dir, "main.yoop");
    fs.writeFileSync(m, `export const MAX: int32 = 100;
`);
    const mainSrc = `import * as m from "./m.yoop";
function main(): int32 {
    let n: int32 = m.MAX;
    return n;
}
`;
    fs.writeFileSync(main, mainSrc);
    const result = analyze(fs.realpathSync(main), new Map());
    assert.deepEqual(result.diagnostics, []);
    const mainMod = result.modules.find((mm) => mm.absPath === fs.realpathSync(main));
    const maxOff = mainSrc.indexOf("m.MAX") + 2;
    const tok = identTokenAt(mainSrc, maxOff);
    const node = findNodeAt(mainMod.ast, maxOff, mainSrc);
    const def = findDefinition(node, {
      module: mainMod,
      modById: result.modById,
      tokenText: tok?.text,
      tokenStart: tok?.start,
      moduleEnv: result.moduleEnv,
    });
    assert.ok(def, "expected a def for ns.MAX const access");
    assert.equal(def.absPath, fs.realpathSync(m));
  });

  it("hover on a namespace identifier reads as '(namespace) name'", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_nav_ns3_"));
    const m = path.join(dir, "m.yoop");
    const main = path.join(dir, "main.yoop");
    fs.writeFileSync(m, `export function ping(): int32 { return 1; }
`);
    const mainSrc = `import * as m from "./m.yoop";
function main(): int32 { return m.ping(); }
`;
    fs.writeFileSync(main, mainSrc);
    const result = analyze(fs.realpathSync(main), new Map());
    const mainMod = result.modules.find((mm) => mm.absPath === fs.realpathSync(main));
    const off = mainSrc.indexOf("m.ping");
    const node = findNodeAt(mainMod.ast, off, mainSrc);
    const hover = getHoverInfo(node, mainMod);
    assert.equal(hover, "(namespace) m");
  });
});

describe("nav: import goto-def", () => {
  it("cursor on `import * as ns` jumps into the imported file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_nav_imp_"));
    const m = path.join(dir, "lib.yoop");
    const main = path.join(dir, "main.yoop");
    fs.writeFileSync(m, `export function ping(): int32 { return 1; }\n`);
    const mainSrc = `import * as lib from "./lib.yoop";
function main(): int32 { return lib.ping(); }
`;
    fs.writeFileSync(main, mainSrc);
    const result = analyze(fs.realpathSync(main));
    const mainMod = result.modules.find((mm) => mm.absPath === fs.realpathSync(main));
    const off = mainSrc.indexOf("lib from");
    const tok = identTokenAt(mainSrc, off);
    const node = findNodeAt(mainMod.ast, off, mainSrc);
    const def = findDefinition(node, {
      module: mainMod,
      modById: result.modById,
      moduleEnv: result.moduleEnv,
      tokenText: tok?.text,
      tokenStart: tok?.start,
      cursorOffset: off,
    });
    assert.ok(def);
    assert.equal(def.absPath, fs.realpathSync(m));
  });

  it("cursor inside the import path string jumps into the imported file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_nav_imp2_"));
    const m = path.join(dir, "lib.yoop");
    const main = path.join(dir, "main.yoop");
    fs.writeFileSync(m, `export function ping(): int32 { return 1; }\n`);
    const mainSrc = `import * as lib from "./lib.yoop";
function main(): int32 { return lib.ping(); }
`;
    fs.writeFileSync(main, mainSrc);
    const result = analyze(fs.realpathSync(main));
    const mainMod = result.modules.find((mm) => mm.absPath === fs.realpathSync(main));
    // Cursor inside `"./lib.yoop"` - identTokenAt returns null but the
    // file-fallback should still navigate.
    const off = mainSrc.indexOf("./lib") + 2;
    const tok = identTokenAt(mainSrc, off);
    const node = findNodeAt(mainMod.ast, off, mainSrc);
    const def = findDefinition(node, {
      module: mainMod,
      modById: result.modById,
      moduleEnv: result.moduleEnv,
      tokenText: tok?.text,
      tokenStart: tok?.start,
      cursorOffset: off,
    });
    assert.ok(def, "expected def for cursor inside import path string");
    assert.equal(def.absPath, fs.realpathSync(m));
  });

  it("cursor on a named-import specifier jumps to the export's decl", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_nav_imp3_"));
    const m = path.join(dir, "lib.yoop");
    const main = path.join(dir, "main.yoop");
    fs.writeFileSync(m, `export type Point { x: int32, y: int32 }\n`);
    const mainSrc = `import { Point } from "./lib.yoop";
function f(): int32 {
    let p: Point = { x: 1, y: 2 };
    return p.x;
}
function main(): int32 { return f(); }
`;
    fs.writeFileSync(main, mainSrc);
    const result = analyze(fs.realpathSync(main));
    const mainMod = result.modules.find((mm) => mm.absPath === fs.realpathSync(main));
    // Cursor on `Point` inside the `import { Point }` specifier list.
    const off = mainSrc.indexOf("Point") + 1;
    const tok = identTokenAt(mainSrc, off);
    const node = findNodeAt(mainMod.ast, off, mainSrc);
    const def = findDefinition(node, {
      module: mainMod,
      modById: result.modById,
      moduleEnv: result.moduleEnv,
      tokenText: tok?.text,
      tokenStart: tok?.start,
      cursorOffset: off,
    });
    assert.ok(def);
    assert.equal(def.absPath, fs.realpathSync(m));
    // The jump should land on the `Point` token in the source module's
    // type decl, not at byte 0.
    assert.ok(def.pos > 0, "expected def.pos to point at the decl, not file start");
  });
});

describe("nav: formatType rendering", () => {
  it("renders a generic struct instantiation in source form", () => {
    const src = `type Box<T> { value: T }
function main(): int32 {
    let b: Box<int32> = { value: 42 };
    return b.value;
}
`;
    const { mod } = analyzeFixture(src);
    const off = src.lastIndexOf("b.value");
    const node = findNodeAt(mod.ast, off, src);
    assert.equal(node.kind, "IDENT");
    const hover = getHoverInfo(node, mod);
    assert.match(hover, /Box<int32>/, `hover was: ${hover}`);
  });

  it("renders arrays as 'Elem[]'", () => {
    const src = `function main(): int32 {
    let xs: int32[] = [1, 2, 3];
    if (xs.len > 0) { return 1; }
    return 0;
}
`;
    const { mod } = analyzeFixture(src);
    const off = src.indexOf("let xs") + "let ".length;
    const node = findNodeAt(mod.ast, off, src);
    const hover = getHoverInfo(node, mod);
    assert.match(hover, /int32\[\]/);
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

  // An extern block used to contribute NOTHING to the outline. A file that is
  // all extern - std/core/intrinsics.yoop, std/net/socket_ffi.yoop, the sdl.yoop
  // under examples/playground/nebula_arena - came back with zero symbols, and a
  // mixed file listed only its non-extern half. FFI signatures are exactly what
  // one goes hunting for by name, so hiding them was the wrong default.
  it("emits an extern block as one entry holding its signatures", () => {
    const src = `extern "C" from library "SDL2" {
    type SDL_Window;
    function SDL_Init(flags: uint32): c_int;
    function SDL_Quit(): void;
}
function main(): int32 {
    return 0;
}
`;
    const { mod, src: text } = analyzeFixture(src);
    const symbols = collectDocumentSymbols(mod.ast, text);
    const names = symbols.map((s) => s.name);
    assert.ok(names.includes("main"), `expected main in ${names}`);

    // Named for its SOURCE, which is what tells two blocks in one file apart -
    // the ABI is "C" almost everywhere and so distinguishes nothing.
    const block = symbols.find((s) => s.name.includes("SDL2"));
    assert.ok(block, `expected an extern entry naming SDL2 in ${names}`);

    const kids = (block.children ?? []).map((c) => c.name).sort();
    assert.deepEqual(kids, ["SDL_Init", "SDL_Quit", "SDL_Window"]);

    // An extern TYPE is a type, not a function - the outline icons differ and
    // `SDL_Window` is a handle, not something callable.
    const win = block.children.find((c) => c.name === "SDL_Window");
    const init = block.children.find((c) => c.name === "SDL_Init");
    assert.notEqual(win.kind, init.kind, "extern type and extern function should differ in kind");
  });

  it("emits a header-sourced extern block too", () => {
    const src = `extern "C" from "stdio.h" {
    function printf(fmt: string, ...): int32;
}
`;
    const { mod, src: text } = analyzeFixture(src);
    const symbols = collectDocumentSymbols(mod.ast, text);
    const block = symbols.find((s) => s.name.includes("stdio.h"));
    assert.ok(block, `expected an extern entry naming stdio.h in ${symbols.map((s) => s.name)}`);
    assert.deepEqual((block.children ?? []).map((c) => c.name), ["printf"]);
  });
});

// modules-as-directories: the LSP has to keep working when the file under the
// cursor is one SOURCE FILE of a directory module. Everything below is a
// property that only exists because a source file stays the compilation unit
// while the namespace moves to the directory - if `moduleEnv` had been keyed per
// file, or diagnostics keyed by moduleId, these would break.
// See plans/modules-as-directories.md.
function writeDirModuleFixture(files, moduleDirName = "geom") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_dirmod_"));
  const dir = path.join(root, moduleDirName);
  fs.mkdirSync(dir);
  const written = {};
  for (const [name, text] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text);
    written[name] = fs.realpathSync(p);
  }
  return written;
}

const POINT_YOOP = `module geom;

export type Point { x: int32, y: int32 }

function doubled(v: int32): int32 { return v * 2; }
`;

// Uses `Point` (an exported sibling type) and `doubled` (a PRIVATE sibling
// function) with no import between them.
const AREA_YOOP = `module geom;

export function areaOf(p: Point): int32 {
    return p.x * p.y;
}

export function doubledArea(p: Point): int32 {
    return doubled(areaOf(p));
}
`;

describe("nav: directory modules", () => {
  it("analyzes a source file of a directory module with no spurious diagnostics", () => {
    const files = writeDirModuleFixture({
      "point.yoop": POINT_YOOP,
      "area.yoop": AREA_YOOP,
    });
    const result = analyze(files["area.yoop"], new Map());
    assert.deepEqual(
      result.diagnostics.map((d) => `${path.basename(d.absPath)}:${d.message}`),
      [],
      "sibling declarations must resolve without an import",
    );
    // Both files are one module, so they share the id moduleEnv is keyed by.
    const geom = result.modules.filter((m) => m.absPath.includes(`${path.sep}geom${path.sep}`));
    assert.equal(geom.length, 2);
    assert.equal(geom[0].id, geom[1].id);
  });

  it("goto-definition crosses into a sibling file of the same module", () => {
    const files = writeDirModuleFixture({
      "point.yoop": POINT_YOOP,
      "area.yoop": AREA_YOOP,
    });
    const areaAbs = files["area.yoop"];
    const result = analyze(areaAbs, new Map());
    const mod = result.modules.find((m) => m.absPath === areaAbs);
    assert.ok(mod, "expected area.yoop in the analysis result");

    // `doubled(...)` is declared in point.yoop, with no import in area.yoop.
    const callOff = AREA_YOOP.indexOf("doubled(areaOf");
    const node = findNodeAt(mod.ast, callOff, AREA_YOOP);
    const def = findDefinition(node, {
      module: mod,
      modById: result.modById,
      moduleEnv: result.moduleEnv,
      tokenText: "doubled",
      tokenStart: callOff,
      cursorOffset: callOff,
    });
    assert.ok(def, "expected a definition for a sibling-file function");
    assert.equal(
      def.absPath,
      files["point.yoop"],
      "definition must land in the sibling FILE, not the file under the cursor",
    );
    assert.equal(def.pos, POINT_YOOP.indexOf("doubled"));
  });

  it("documentSymbols lists only the open file's decls, not the whole module", () => {
    const files = writeDirModuleFixture({
      "point.yoop": POINT_YOOP,
      "area.yoop": AREA_YOOP,
    });
    const areaAbs = files["area.yoop"];
    const result = analyze(areaAbs, new Map());
    const mod = result.modules.find((m) => m.absPath === areaAbs);
    const names = collectDocumentSymbols(mod.ast, AREA_YOOP).map((s) => s.name);
    assert.deepEqual(names.sort(), ["areaOf", "doubledArea"]);
    // The outline is per FILE: the sibling's decls belong to point.yoop's outline.
    assert.ok(!names.includes("Point"), `Point leaked into area.yoop's outline: ${names}`);
  });

  it("attributes an import-locality error to the file that used the name", () => {
    // a.yoop imports vec; b.yoop uses it without importing it.
    const files = writeDirModuleFixture(
      {
        "a.yoop": `module m;
import * as vec, { Vec } from "std/core/vec.yoop";
export function capA(): usize {
    let v: Vec<int32> = vec.vecNew(4);
    return v.cap;
}
`,
        "b.yoop": `module m;
export function capB(): usize {
    let v: Vec<int32> = vec.vecNew(8);
    return v.cap;
}
`,
      },
      "m",
    );
    const result = analyze(files["b.yoop"], new Map());
    const leaks = result.diagnostics.filter((d) =>
      /is not imported by this file/.test(d.message),
    );
    assert.ok(leaks.length >= 1, "expected an import-locality diagnostic");
    // Squiggled in b.yoop, not the sibling that owns the import.
    for (const d of leaks) {
      assert.equal(d.absPath, files["b.yoop"], `wrong file for: ${d.message}`);
    }
  });
});

// yooperdoom-takeaways 4.1: the comment above a declaration is documentation,
// and the editor should show it. The scan runs on raw source, because comments
// are eaten by the lexer and never reach the token stream.
describe("nav: docCommentAt", () => {
  // Anchor is the declaration's NAME offset, which is what locOfDecl computes
  // and what goto-definition already jumps to.
  function docFor(src, name) {
    const at = src.indexOf(name);
    assert.notEqual(at, -1, `fixture has no "${name}"`);
    return docCommentAt(src, at);
  }

  it("reads a single-line comment above a function", () => {
    const src = [
      "// Number of command line arguments, including the program name.",
      "export function argCount(): int32 {",
      "    return 0;",
      "}",
    ].join("\n");
    assert.equal(
      docFor(src, "argCount"),
      "Number of command line arguments, including the program name.",
    );
  });

  it("joins a contiguous multi-line block and keeps relative indent", () => {
    const src = [
      "// The value of `name`, or `fallback` when it is UNSET.",
      "//",
      "//     let p: string = env.get(\"PORT\");",
      "export function getOr(name: string): string {",
      "    return name;",
      "}",
    ].join("\n");
    assert.equal(
      docFor(src, "getOr"),
      [
        "The value of `name`, or `fallback` when it is UNSET.",
        "",
        "    let p: string = env.get(\"PORT\");",
      ].join("\n"),
    );
  });

  it("stops at a blank line, so a file header does not attach to the first decl", () => {
    const src = [
      "// std/env.yoop - the module header, which documents the MODULE.",
      "// It must not be reported as the doc for the decl below it.",
      "",
      "export function argCount(): int32 {",
      "    return 0;",
      "}",
    ].join("\n");
    assert.equal(docFor(src, "argCount"), null);
  });

  it("stops at a non-comment line", () => {
    const src = [
      "// belongs to the import, not to f",
      "import * as x from \"std/env.yoop\";",
      "export function f(): int32 { return 0; }",
    ].join("\n");
    assert.equal(docFor(src, "f()"), null);
  });

  it("returns null when there is no comment", () => {
    assert.equal(docCommentAt("export function f(): int32 { return 0; }", 16), null);
  });

  it("takes only the run directly above, not an earlier one", () => {
    const src = [
      "// an earlier comment, separated by a blank line",
      "",
      "// the real doc",
      "export function f(): int32 { return 0; }",
    ].join("\n");
    assert.equal(docFor(src, "f()"), "the real doc");
  });

  it("handles a one-line block comment", () => {
    const src = "/* a block-comment doc */\nexport function f(): int32 { return 0; }";
    assert.equal(docFor(src, "f()"), "a block-comment doc");
  });

  it("survives a decl on the first line of the file", () => {
    assert.equal(docCommentAt("export function f(): int32 { return 0; }", 0), null);
  });

  it("is defensive about out-of-range and non-string input", () => {
    assert.equal(docCommentAt(null, 0), null);
    assert.equal(docCommentAt("// x\nfn", -1), null);
    assert.equal(docCommentAt("// x\nfn", 9999), null);
  });
});
