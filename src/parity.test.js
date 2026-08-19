// Layer 1 parity: the bootstrap lexer must produce the same token stream as
// this one.
//
// The cross-check is "for the same input source, assert yoop_layer_dump ==
// js_layer_dump", and it is the pattern the parse and typecheck boundaries
// copy for their own dumps.
//
// The corpus is bootstrap/tests/parity/. Those files only have to LEX, so they
// can hold constructs neither parser accepts yet. src/dumpTokens.js documents
// the format and the three things it deliberately leaves uncompared.
import { describe, it, before } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";

import { dumpTokens } from "./dumpTokens.js";
import { runProcOrThrow } from "./testProc.js";

const REPO = path.resolve(import.meta.dirname, "..");
const CORPUS = path.join(REPO, "bootstrap/tests/parity");
const DUMPER_SRC = path.join(REPO, "bootstrap/tools/dump_tokens.yoop");

const inputs = fs
  .readdirSync(CORPUS)
  .filter((f) => f.endsWith(".yoop"))
  .sort();

describe("parity: layer 1 (lex) - bootstrap token stream matches the JS lexer", () => {
  let dumper;

  before(async () => {
    // One compile for the whole suite; the binary is the bootstrap's lexer
    // wrapped in a main that prints the dump.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop-parity-"));
    dumper = path.join(outDir, "dump_tokens");
    await runProcOrThrow(
      "node",
      [path.join(REPO, "src/yoopiler.js"), DUMPER_SRC, "-o", dumper],
      { cwd: REPO, timeout: 120000 },
    );
  });

  it("has a corpus", () => {
    assert.ok(inputs.length > 0, `no .yoop inputs in ${CORPUS}`);
  });

  // The dumper is the bootstrap's own lexer, which is under active development,
  // and a lexer that fails to advance is an infinite loop that pins a core.
  // Without a deadline one bad file means a spinning process for as long as
  // the machine is up. This is the deadline that turns that into a test
  // failure.
  const DUMP_TIMEOUT_MS = Number(process.env.YOOP_PARITY_DUMP_TIMEOUT_MS) || 30000;

  async function dump(file) {
    const r = await runProcOrThrow(dumper, [file], { timeout: DUMP_TIMEOUT_MS });
    return r.stdout;
  }

  for (const name of inputs) {
    it(`${name}: identical token dumps`, async () => {
      const file = path.join(CORPUS, name);
      const expected = dumpTokens(fs.readFileSync(file, "utf8"));
      const actual = await dump(file);
      assert.equal(actual, expected, firstDivergence(name, expected, actual));
    });
  }

  // The hand-written corpus above targets specific constructs; this sweeps
  // every real source file in the tree. It is the check that catches a
  // divergence nobody thought to write a case for.
  it("every .yoop file in std/, bootstrap/ and examples/ lexes identically", async () => {
    const files = [
      ...collectYoop(path.join(REPO, "std")),
      ...collectYoop(path.join(REPO, "bootstrap")),
      ...collectYoop(path.join(REPO, "examples")),
    ].sort();

    const skipped = [];
    const failures = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      // Spans are JS string indices on this side and byte offsets on the
      // other, so only ASCII files are comparable. Report what is skipped
      // rather than letting a silent filter read as full coverage.
      // eslint-disable-next-line no-control-regex
      if (/[^\x00-\x7F]/.test(text)) {
        skipped.push(path.relative(REPO, file));
        continue;
      }
      const rel = path.relative(REPO, file);
      let expected;
      try {
        expected = dumpTokens(text);
      } catch {
        skipped.push(`${rel} (js lexer rejects it)`);
        continue;
      }
      const actual = await dump(file);
      if (actual !== expected) failures.push(firstDivergence(rel, expected, actual));
    }

    assert.ok(
      files.length - skipped.length > 400,
      `expected a broad sweep, only compared ${files.length - skipped.length} files`,
    );
    assert.equal(
      failures.length,
      0,
      `${failures.length} of ${files.length} files diverged` +
        (skipped.length ? ` (${skipped.length} skipped: ${skipped.join(", ")})` : "") +
        `\n\n${failures.slice(0, 5).join("\n\n")}`,
    );
  });
});

function collectYoop(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.endsWith(".dSYM")) continue;
      out.push(...collectYoop(full));
    } else if (entry.name.endsWith(".yoop")) {
      out.push(full);
    }
  }
  return out;
}

// A whole-dump diff is unreadable at a few hundred tokens, so point at the
// first line that differs and say what is on each side.
function firstDivergence(name, expected, actual) {
  const e = expected.split("\n");
  const a = actual.split("\n");
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] !== a[i]) {
      return (
        `${name}: token streams diverge at line ${i + 1}\n` +
        `  js:        ${e[i] ?? "(end of stream)"}\n` +
        `  bootstrap: ${a[i] ?? "(end of stream)"}`
      );
    }
  }
  return `${name}: dumps differ`;
}
