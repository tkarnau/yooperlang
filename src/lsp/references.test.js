// References + rename tests for cross-module + namespace-prefixed access.
// Drives analyze() against on-disk fixtures so the typechecker stamps
// the back-pointers + namespaceLookup slots references.js relies on.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { analyze } from "./analyze.js";
import {
  findNodeAt,
  identTokenAt,
} from "./nav.js";
import { identifyTarget, findReferences } from "./references.js";

function writeMultiFile(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_refs_"));
  const out = {};
  for (const [name, src] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, src);
    out[name] = { absPath: fs.realpathSync(file), src };
  }
  return out;
}

function refsForCursor(analysis, absPath, offset) {
  const mod = analysis.modules.find((m) => m.absPath === absPath);
  if (!mod) throw new Error(`module ${absPath} not in analysis`);
  const tok = identTokenAt(mod.src, offset);
  const node = findNodeAt(mod.ast, offset, mod.src);
  const target = identifyTarget(node, {
    module: mod,
    modById: analysis.modById,
    moduleEnv: analysis.moduleEnv,
    programState: analysis.programState,
    tokenText: tok?.text,
  });
  if (!target) return { target: null, refs: [] };
  const refs = findReferences(target, {
    modules: analysis.modules,
    modById: analysis.modById,
    moduleEnv: analysis.moduleEnv,
    programState: analysis.programState,
  });
  return { target, refs };
}

function countByFile(refs) {
  const m = new Map();
  for (const r of refs) {
    const f = path.basename(r.absPath);
    m.set(f, (m.get(f) ?? 0) + 1);
  }
  return Object.fromEntries(m);
}

describe("references: cross-module exported function", () => {
  it("finds namespace-prefixed call sites in importing modules", () => {
    const files = writeMultiFile({
      "lib.yoop": `export function ping(): int32 { return 1; }
`,
      "main.yoop": `import * as lib from "./lib.yoop";
function main(): int32 {
    let a: int32 = lib.ping();
    let b: int32 = lib.ping();
    return a + b;
}
`,
    });
    const result = analyze(files["main.yoop"].absPath);
    assert.deepEqual(result.diagnostics, []);
    // Cursor on the `ping` decl in lib.yoop.
    const libSrc = files["lib.yoop"].src;
    const off = libSrc.indexOf("ping");
    const { refs } = refsForCursor(result, files["lib.yoop"].absPath, off);
    const byFile = countByFile(refs);
    assert.equal(byFile["lib.yoop"], 1, "expected 1 ref in lib.yoop (the decl)");
    assert.equal(byFile["main.yoop"], 2, "expected 2 cross-module refs in main.yoop");
  });
});

describe("references: cross-module exported const", () => {
  it("finds namespace-prefixed const access in importing modules", () => {
    const files = writeMultiFile({
      "consts.yoop": `export const MAX: int32 = 100;
`,
      "main.yoop": `import * as c from "./consts.yoop";
function main(): int32 {
    let a: int32 = c.MAX;
    let b: int32 = c.MAX + 1;
    return a + b;
}
`,
    });
    const result = analyze(files["main.yoop"].absPath);
    assert.deepEqual(result.diagnostics, []);
    const consSrc = files["consts.yoop"].src;
    const off = consSrc.indexOf("MAX");
    const { refs } = refsForCursor(result, files["consts.yoop"].absPath, off);
    const byFile = countByFile(refs);
    assert.equal(byFile["consts.yoop"], 1);
    assert.equal(byFile["main.yoop"], 2);
  });
});

describe("references: cross-module exported type", () => {
  it("finds ns.Type annotations across modules", () => {
    const files = writeMultiFile({
      "lib.yoop": `export type Point { x: int32, y: int32 }
`,
      "main.yoop": `import * as lib from "./lib.yoop";
function make(): lib.Point { return { x: 1, y: 2 }; }
function take(p: lib.Point): int32 { return p.x; }
function main(): int32 { return take(make()); }
`,
    });
    const result = analyze(files["main.yoop"].absPath);
    assert.deepEqual(result.diagnostics, []);
    const off = files["lib.yoop"].src.indexOf("Point");
    const { refs } = refsForCursor(result, files["lib.yoop"].absPath, off);
    const byFile = countByFile(refs);
    assert.equal(byFile["lib.yoop"], 1);
    assert.ok(byFile["main.yoop"] >= 2, `expected >=2 refs in main.yoop, got ${byFile["main.yoop"]}`);
  });
});
