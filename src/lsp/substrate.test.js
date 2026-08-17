// Tests for the `@inspect` substrate view.
//
// Split by cost. The marker layer (which functions are marked, with which
// modes) is pure AST work and gets a parse-only fixture. The build layer runs
// real codegen, so it uses one shared fixture and asserts on the SHAPE of the
// mapping - "line 5 produced a multiply", not "line 5 produced these exact 6
// instructions" - because the second kind of assertion breaks every time
// codegen improves, without telling us anything true had regressed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "../jsyooparser/parser.js";
import {
  buildSubstrate,
  collectInspectFunctions,
  renderFunctionView,
  renderSubstrateHover,
  substrateAt,
} from "./substrate.js";
import { functionForSource } from "../jsyoopcodegen/sourceIndex.js";

// A module record shaped the way loadModuleGraph produces them: one per source
// FILE, each with its own absPath and ast.
function moduleFrom(src, absPath = "/proj/demo.yoop") {
  return { id: "demo", absPath, src, ast: parse(src) };
}

describe("substrate: collecting @inspect markers", () => {
  it("finds a marked function and the modes it asked for", () => {
    const mod = moduleFrom(`
@inspect(ir)
function marked(): int32 { return 1; }
`);
    const perFile = collectInspectFunctions([mod]).get("/proj/demo.yoop");
    assert.deepEqual([...perFile.values()], [{ name: "marked", modes: ["ir"] }]);
  });

  it("keys markers by declaration line", () => {
    // The decl line is the join between the AST and the emitted !DISubprogram.
    // If this drifts, every hover silently stops matching.
    const mod = moduleFrom(`
@inspect(ir)
function marked(): int32 { return 1; }
`);
    const perFile = collectInspectFunctions([mod]).get("/proj/demo.yoop");
    assert.deepEqual([...perFile.keys()], [3]);
  });

  it("records both modes when both are requested", () => {
    const mod = moduleFrom(`@inspect(ir, asm)
function marked(): int32 { return 1; }
`);
    const perFile = collectInspectFunctions([mod]).get("/proj/demo.yoop");
    assert.deepEqual([...perFile.values()][0].modes, ["ir", "asm"]);
  });

  it("reaches through `export function`", () => {
    const mod = moduleFrom(`@inspect(ir)
export function marked(): int32 { return 1; }
`);
    const perFile = collectInspectFunctions([mod]).get("/proj/demo.yoop");
    assert.equal([...perFile.values()][0].name, "marked");
  });

  it("reaches through `export \"C\" function`", () => {
    const mod = moduleFrom(`@inspect(ir)
export "C" function marked(): int32 { return 1; }
`);
    const perFile = collectInspectFunctions([mod]).get("/proj/demo.yoop");
    assert.equal([...perFile.values()][0].name, "marked");
  });

  it("marks a kind-prefixed function", () => {
    // `async function f()` and the prefix-only `task f()` both start on an
    // ident rather than the `function` keyword, so they take a different
    // branch of the attribute target dispatch.
    const mod = moduleFrom(`@inspect(ir)
async function marked(): int32 { return 1; }
`);
    const perFile = collectInspectFunctions([mod]).get("/proj/demo.yoop");
    assert.equal([...perFile.values()][0].name, "marked");
  });

  it("returns no entry for a file with no @inspect in it", () => {
    const mod = moduleFrom(`function plain(): int32 { return 1; }`);
    assert.equal(collectInspectFunctions([mod]).has("/proj/demo.yoop"), false);
  });

  it("leaves unmarked functions out", () => {
    const mod = moduleFrom(`@inspect(ir)
function marked(): int32 { return 1; }
function plain(): int32 { return 2; }
`);
    const perFile = collectInspectFunctions([mod]).get("/proj/demo.yoop");
    assert.deepEqual([...perFile.values()].map((v) => v.name), ["marked"]);
  });
});

describe("substrate: @inspect is transparent to the compiler", () => {
  // The single most important property of the attribute: it must not change
  // the program. An @inspect that perturbed codegen would be misreporting its
  // own subject.
  const BODY = `function hotLoop(n: int32): int32 {
  let acc: int32 = 0;
  for (let i: int32 = 0; i < n; i = i + 1) {
    acc = acc + i * i;
  }
  return acc;
}
function main(): int32 { return hotLoop(10); }
`;

  it("produces byte-identical IR with and without the attribute", () => {
    // The two fixtures must have the SAME line count, or every DILocation
    // shifts and the diff is about the extra source line rather than about
    // the attribute. So the control gets a comment where the marked version
    // gets `@inspect(ir)`.
    const plain = withFixture(`// not marked\n${BODY}`, (p) =>
      buildSubstrate(p, new Map()),
    );
    const marked = withFixture(`@inspect(ir)\n${BODY}`, (p) =>
      buildSubstrate(p, new Map()),
    );
    assert.equal(plain.error, null, plain.error ?? "");
    assert.equal(marked.error, null, marked.error ?? "");
    assert.equal(normalizeIr(plain.ir), normalizeIr(marked.ir));
  });

  it("does not leave an ATTRIBUTE node in the module body", () => {
    // A transparent attribute hands back its TARGET, so downstream passes see
    // a bare FUNCTION_DECL. If a wrapper leaked through, codegen would skip
    // the function entirely.
    const ast = parse(`@inspect(ir)\nfunction f(): int32 { return 1; }\n`);
    assert.deepEqual(ast.body.map((d) => d.kind), ["FUNCTION_DECL"]);
    assert.deepEqual(ast.body[0].inspect.modes, ["ir"]);
  });
});

describe("substrate: mapping a source line to instructions", () => {
  const SRC = `@inspect(ir)
function hotLoop(n: int32): int32 {
  let acc: int32 = 0;
  for (let i: int32 = 0; i < n; i = i + 1) {
    acc = acc + i * i;
  }
  return acc;
}
function main(): int32 { return hotLoop(10); }
`;
  // Line 5 is `acc = acc + i * i;`, line 9 is inside unmarked `main`.
  const MULTIPLY_LINE = 5;

  function ctxFor(absPath) {
    const substrate = buildSubstrate(absPath, new Map());
    assert.equal(substrate.error, null, substrate.error ?? "");
    return {
      modules: [moduleFrom(fs.readFileSync(absPath, "utf8"), absPath)],
      substrate,
      absPath,
    };
  }

  it("shows the arithmetic a source line compiled to", () => {
    withFixture(SRC, (absPath) => {
      const ctx = ctxFor(absPath);
      const view = substrateAt(ctx, absPath, MULTIPLY_LINE);
      assert.ok(view, "expected line 5 to be inside the @inspect'd function");
      assert.equal(view.name, "hotLoop");
      const text = view.sections[0].refs
        .map((r) => view.sections[0].index.lines[r.irLine])
        .join("\n");
      assert.match(text, /\bmul\b/, `no multiply in:\n${text}`);
      assert.match(text, /\badd\b/, `no add in:\n${text}`);
    });
  });

  it("returns nothing for a line outside any marked function", () => {
    withFixture(SRC, (absPath) => {
      const ctx = ctxFor(absPath);
      assert.equal(substrateAt(ctx, absPath, 9), null);
    });
  });

  it("returns nothing for a line past the end of the file", () => {
    withFixture(SRC, (absPath) => {
      const ctx = ctxFor(absPath);
      assert.equal(substrateAt(ctx, absPath, 500), null);
    });
  });

  it("unions the instructions of a selected range", () => {
    withFixture(SRC, (absPath) => {
      const ctx = ctxFor(absPath);
      const one = substrateAt(ctx, absPath, MULTIPLY_LINE);
      const span = substrateAt(ctx, absPath, 3, 6);
      assert.ok(
        span.sections[0].refs.length > one.sections[0].refs.length,
        "a 4-line range should cover more instructions than one line",
      );
    });
  });

  it("renders a hover naming the function and the line", () => {
    withFixture(SRC, (absPath) => {
      const ctx = ctxFor(absPath);
      const md = renderSubstrateHover(
        substrateAt(ctx, absPath, MULTIPLY_LINE),
        MULTIPLY_LINE,
      );
      assert.match(md, /@inspect/);
      assert.match(md, /hotLoop/);
      assert.match(md, /line 5/);
      assert.match(md, /```llvm/);
    });
  });

  it("labels a range hover with both endpoints", () => {
    withFixture(SRC, (absPath) => {
      const ctx = ctxFor(absPath);
      const md = renderSubstrateHover(substrateAt(ctx, absPath, 3, 6), 3, 6);
      assert.match(md, /lines 3-6/);
    });
  });
});

describe("substrate: whole-function view for the panel", () => {
  const SRC = `@inspect(ir)
function doubled(x: int32): int32 {
  return x * 2;
}
function main(): int32 { return doubled(21); }
`;

  it("returns the function's full IR text", () => {
    withFixture(SRC, (absPath) => {
      const substrate = buildSubstrate(absPath, new Map());
      assert.equal(substrate.error, null, substrate.error ?? "");
      const view = renderFunctionView(substrate.irIndex, absPath, 2, 3);
      assert.ok(view, "expected a function view at decl line 2");
      assert.match(view.lines[0], /^define .*@\S*doubled/);
      assert.equal(view.lines[view.lines.length - 1], "}");
    });
  });

  it("highlights the rows a given source line produced", () => {
    withFixture(SRC, (absPath) => {
      const substrate = buildSubstrate(absPath, new Map());
      const view = renderFunctionView(substrate.irIndex, absPath, 2, 3);
      assert.ok(view.highlight.length > 0, "expected line 3 to highlight rows");
      // Highlights index into `lines`, so every one must be in range.
      for (const h of view.highlight) {
        assert.ok(h >= 0 && h < view.lines.length, `highlight ${h} out of range`);
      }
      assert.match(view.lines[view.highlight.at(-1)], /\bret\b|\bmul\b|\bshl\b/);
    });
  });

  it("returns null for a decl line that emitted no function", () => {
    withFixture(SRC, (absPath) => {
      const substrate = buildSubstrate(absPath, new Map());
      assert.equal(renderFunctionView(substrate.irIndex, absPath, 999, null), null);
    });
  });
});

describe("substrate: failure handling", () => {
  it("reports a type error instead of attempting codegen", () => {
    withFixture(`@inspect(ir)
function broken(): int32 { return "not an int"; }
`, (absPath) => {
      const substrate = buildSubstrate(absPath, new Map());
      assert.equal(substrate.irIndex, null);
      assert.match(substrate.error, /error/);
    });
  });

  it("still names the function when the build failed", () => {
    // A broken build must degrade to an explanation, not to silence - the
    // author asked to see this function's IR and deserves to know why they
    // cannot.
    withFixture(`@inspect(ir)
function broken(): int32 { return "not an int"; }
`, (absPath) => {
      const src = fs.readFileSync(absPath, "utf8");
      const ctx = {
        modules: [moduleFrom(src, absPath)],
        substrate: buildSubstrate(absPath, new Map()),
        absPath,
      };
      const view = substrateAt(ctx, absPath, 2);
      assert.ok(view, "expected a view even though codegen failed");
      assert.equal(view.name, "broken");
      assert.match(renderSubstrateHover(view, 2), /error/);
    });
  });
});

// ---------- helpers ----------------------------------------------------------

// Run `fn` against a fixture written to a fresh temp dir, cleaning up after.
// Each call gets its own directory so module ids (a hash of the path) never
// collide between fixtures within a run.
function withFixture(src, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop-substrate-test-"));
  try {
    const file = path.join(dir, "main.yoop");
    fs.writeFileSync(file, src, "utf8");
    return fn(fs.realpathSync(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Module ids are a hash of the source path, and DIFile records the containing
// directory, so two fixtures in different temp dirs differ in ways that have
// nothing to do with the code. Normalize both so an IR comparison is about
// what was COMPILED rather than about where the file happened to live.
function normalizeIr(ir) {
  return ir
    .replace(/main_[0-9a-f]{8}/g, "main_HASH")
    .replace(/directory: "[^"]*"/g, 'directory: "DIR"');
}
