// The program-owned `modules/` import root.
//
// These build real directory trees in a temp dir rather than stubbing fs,
// because the whole feature IS filesystem behavior - an upward walk, a
// first-hit rule, and two checks that only mean anything against real
// directories.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadModuleGraph } from "./moduleGraph.js";

// A stub std root. The autoload list tolerates missing files (it `continue`s),
// so pointing at an empty directory keeps these unit tests off the real std
// tree - which is both faster and keeps a std edit from breaking them.
let tmpRoot;
let stubStd;

before(() => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yoop-modroot-")));
  stubStd = path.join(tmpRoot, "stub-std");
  fs.mkdirSync(stubStd);
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let caseCounter = 0;

// Materialize { "relative/path.yoop": "source" } under a fresh directory and
// return that directory.
function project(files) {
  const dir = path.join(tmpRoot, `case${caseCounter++}`);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  return dir;
}

function load(dir, entryRel) {
  return loadModuleGraph(path.join(dir, entryRel), { stdRoot: stubStd });
}

// The ids of every module in the graph, which is what "did it resolve to the
// right directory" reduces to once the walk has run.
function loadedPaths(graph) {
  return graph.modules.map((m) => m.absPath);
}

const MAIN = `function main(): int32 { return 0; }\n`;

describe("moduleGraph: the modules/ import root", () => {
  it("resolves against a modules/ directory beside the entry file", () => {
    const dir = project({
      "main.yoop": `import * as a from "modules/alpha";\n${MAIN}`,
      "modules/alpha/alpha.yoop": `module alpha;\nexport function f(): int32 { return 1; }\n`,
    });
    const graph = load(dir, "main.yoop");
    assert.ok(
      loadedPaths(graph).includes(path.join(dir, "modules/alpha/alpha.yoop")),
      "expected modules/alpha to be in the graph",
    );
  });

  it("walks up past intermediate directories to find the root", () => {
    // The layout that a fixed anchor at the entry file's directory would miss.
    const dir = project({
      "src/deep/main.yoop": `import * as a from "modules/alpha";\n${MAIN}`,
      "modules/alpha/alpha.yoop": `module alpha;\nexport function f(): int32 { return 1; }\n`,
    });
    const graph = load(dir, "src/deep/main.yoop");
    assert.ok(loadedPaths(graph).includes(path.join(dir, "modules/alpha/alpha.yoop")));
  });

  it("resolves a single-file module and a module under a grouping directory", () => {
    const dir = project({
      "main.yoop":
        `import * as h from "modules/helper.yoop";\n` +
        `import * as r from "modules/web/router";\n${MAIN}`,
      "modules/helper.yoop": `export function h(): int32 { return 1; }\n`,
      "modules/web/router/router.yoop": `module router;\nexport function r(): int32 { return 2; }\n`,
    });
    const paths = loadedPaths(load(dir, "main.yoop"));
    assert.ok(paths.includes(path.join(dir, "modules/helper.yoop")));
    assert.ok(paths.includes(path.join(dir, "modules/web/router/router.yoop")));
  });

  it("resolves a module's own dependency against the SAME root, flat", () => {
    // The subdependency case: alpha is installed in the program's modules/ and
    // reaches beta through that root rather than through anything it carries.
    const dir = project({
      "main.yoop": `import * as a from "modules/alpha";\n${MAIN}`,
      "modules/alpha/alpha.yoop":
        `module alpha;\nimport * as b from "modules/beta";\nexport function f(): int32 { return 1; }\n`,
      "modules/beta/beta.yoop": `module beta;\nexport function g(): int32 { return 2; }\n`,
    });
    const paths = loadedPaths(load(dir, "main.yoop"));
    assert.ok(paths.includes(path.join(dir, "modules/beta/beta.yoop")));
  });

  it("resolves the same module file in an author repo and in a consumer", () => {
    // The property the whole anchoring choice exists for: one import line,
    // resolved against a sibling modules/ while being developed and against the
    // consumer's flat modules/ once installed, with no rewriting.
    const alphaSrc =
      `module alpha;\nimport * as b from "modules/beta";\nexport function f(): int32 { return 1; }\n`;
    const betaSrc = `module beta;\nexport function g(): int32 { return 2; }\n`;

    const repo = project({
      "main.yoop": `import * as a from "./alpha";\n${MAIN}`,
      "alpha/alpha.yoop": alphaSrc,
      "modules/beta/beta.yoop": betaSrc,
    });
    assert.ok(loadedPaths(load(repo, "main.yoop")).includes(path.join(repo, "modules/beta/beta.yoop")));

    const consumer = project({
      "main.yoop": `import * as a from "modules/alpha";\n${MAIN}`,
      "modules/alpha/alpha.yoop": alphaSrc,
      "modules/beta/beta.yoop": betaSrc,
    });
    assert.ok(
      loadedPaths(load(consumer, "main.yoop")).includes(path.join(consumer, "modules/beta/beta.yoop")),
    );
  });

  it("stops at the FIRST modules/ root even when it lacks the name", () => {
    // A nearer root that does not hold the name must not fall through to a
    // farther one - a stray modules/ up the tree answering for the program's
    // own would resolve a typo from somewhere the reader never looks.
    const dir = project({
      "modules/decoy/decoy.yoop": `module decoy;\nexport function d(): int32 { return 0; }\n`,
      "inner/modules/alpha/alpha.yoop": `module alpha;\nexport function f(): int32 { return 1; }\n`,
      "inner/main.yoop": `import * as d from "modules/decoy";\n${MAIN}`,
    });
    assert.throws(
      () => load(dir, "inner/main.yoop"),
      (err) => {
        assert.match(err.message, /not found/);
        // It reports the NEAR root, and says what that root actually holds.
        assert.match(err.message, /searched the modules root .*inner[/\\]modules/);
        assert.match(err.message, /it holds: alpha/);
        return true;
      },
    );
  });

  it("names the dependent when a module's own dependency is missing", () => {
    const dir = project({
      "main.yoop": `import * as a from "modules/alpha";\n${MAIN}`,
      "modules/alpha/alpha.yoop":
        `module alpha;\nimport * as b from "modules/beta";\nexport function f(): int32 { return 1; }\n`,
    });
    assert.throws(
      () => load(dir, "main.yoop"),
      (err) => {
        assert.match(err.message, /cannot resolve import "modules\/beta"/);
        assert.match(err.message, /it holds: alpha/);
        assert.match(err.message, /"alpha" is what needs it/);
        return true;
      },
    );
  });

  it("reports no modules/ root anywhere without falling back to a relative path", () => {
    const dir = project({ "main.yoop": `import * as a from "modules/alpha";\n${MAIN}` });
    assert.throws(
      () => load(dir, "main.yoop"),
      (err) => {
        assert.match(err.message, /no "modules" directory found in/);
        return true;
      },
    );
  });

  it("rejects a module that carries its own modules/ directory", () => {
    // Flat is enforced, not conventional: two copies of one module link fine
    // and then mismatch as two distinct nominal types.
    const dir = project({
      "main.yoop": `import * as a from "modules/alpha";\n${MAIN}`,
      "modules/alpha/alpha.yoop": `module alpha;\nexport function f(): int32 { return 1; }\n`,
      "modules/alpha/modules/beta/beta.yoop": `module beta;\nexport function g(): int32 { return 2; }\n`,
    });
    assert.throws(
      () => load(dir, "main.yoop"),
      (err) => {
        assert.match(err.message, /carries its own "modules" directory/);
        assert.match(err.message, /dependencies are flat/);
        return true;
      },
    );
  });

  it("still rejects a bare specifier, and names modules/ as an option", () => {
    const dir = project({ "main.yoop": `import * as a from "alpha";\n${MAIN}` });
    assert.throws(
      () => load(dir, "main.yoop"),
      (err) => {
        assert.match(err.message, /must be relative \(\.\/\.\.\.\), absolute, or start with std\/ or modules\//);
        return true;
      },
    );
  });
});
