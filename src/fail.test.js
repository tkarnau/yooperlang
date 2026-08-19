// The diagnostic fixtures: programs the compiler has to REFUSE.
//
// Each fixture in examples/fail/ that carries a hand-written
// `<name>.expected-errors` beside it is compiled with the BOOTSTRAP, and every
// line of that file has to be matched by a diagnostic the bootstrap actually
// reported. The expectation file is the source of truth; the assertion is
// bootstrap-output contains-expected.
//
// This is the negative twin of src/slice.test.js, and it exists for the same
// reason: 112 of the assertions in src/e2e.test.js drive the JS TYPECHECKER as
// a library over these same fixtures, so when src/ is deleted nothing is left
// checking that bad programs are still refused. Those assertions cannot be
// copied here - the bootstrap words its diagnostics differently on purpose.
// Every expectation below was written by looking at what the BOOTSTRAP says and
// keeping the essential claim.
//
// FORMAT of a `.expected-errors` file:
//
//     # Any line starting with `#` is a comment, and every fixture should have
//     # one saying WHY the program is illegal.
//     <line>:<column>: <substring>
//
// One expected diagnostic per line. The fixture passes when the bootstrap
// reported a diagnostic at exactly that line and column whose message CONTAINS
// that substring. Prefer a short distinctive substring naming the offending
// construct over a whole sentence: the test should survive a reword and fail a
// behaviour change. A fixture must produce at least one error, and the compile
// must fail.
//
// Two things about the bootstrap's diagnostics that the format runs into, both
// recorded here rather than worked around:
//
//   1. A PARSE error's column is one PAST the offending token. `expected
//      SEMICOLON, got LCURLY` on a `{` in column 32 is reported at column 33.
//      Typecheck columns are exact. The expectations below carry the columns
//      the bootstrap actually emits, so fixing that off-by-one is a
//      three-file edit here, and the suite will point at every one of them.
//   2. Some diagnostics have NO location at all - the module graph's "import
//      cycle detected involving <path>" and "cannot resolve import <x>" are
//      whole-file conditions with nothing to point at. `<line>:<column>:` has
//      no spelling for those, so no such fixture is in this batch.
//
// A fixture that is a DIRECTORY is built from its `main.yoop`, and its
// expectation file sits beside the directory rather than inside it, so nothing
// in a module directory is anything but Yoop source.
import { describe, it, before } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";

import { runProc, runProcOrThrow } from "./testProc.js";

const REPO = path.resolve(import.meta.dirname, "..");
const FAIL = path.join(REPO, "examples/fail");
const BOOT_SRC = path.join(REPO, "bootstrap/src/main.yoop");

// Same reasoning as src/slice.test.js: node:test runs the tests within one file
// sequentially, and every byte of work here happens in a child process, so the
// cap is the core count rather than half of it.
const FAIL_CONCURRENCY = Number(process.env.YOOP_FAIL_CONCURRENCY)
  || Math.max(2, Math.min(12, os.cpus().length));

// Deadlines. Nothing spawns without one - see the header of src/testProc.js.
// A fail fixture is a whole-import-closure build that stops at the first bad
// pass, so it is cheaper than a slice fixture; the minute is a hang detector
// with room for twelve of them at once, not a budget.
const COMPILE_TIMEOUT_MS = Number(process.env.YOOP_FAIL_COMPILE_TIMEOUT_MS) || 120000;
const BUILD_TIMEOUT_MS = Number(process.env.YOOP_FAIL_BUILD_TIMEOUT_MS) || 120000;

// Every fixture in examples/fail/, whether or not it has an expectation yet.
// A `.yoop` file is one fixture; a directory is one fixture entered through its
// main.yoop.
const allFixtures = fs
  .readdirSync(FAIL, { withFileTypes: true })
  .flatMap((e) => {
    if (e.isDirectory()) {
      // A directory fixture is entered through its main.yoop. One of them
      // (import_cycle/) has no main.yoop because the cycle it demonstrates has
      // no head, so it is COUNTED as unported rather than dropped, and asking
      // for it by writing an expectation gets a real message.
      const entry = path.join(FAIL, e.name, "main.yoop");
      return [{ name: e.name, entry: fs.existsSync(entry) ? entry : null, dir: true }];
    }
    if (!e.name.endsWith(".yoop")) return [];
    return [{ name: e.name.replace(/\.yoop$/, ""), entry: path.join(FAIL, e.name), dir: false }];
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const expectationOf = (name) => path.join(FAIL, `${name}.expected-errors`);
const ported = allFixtures.filter((f) => fs.existsSync(expectationOf(f.name)));

describe("diagnostics: the bootstrap compiler refuses the programs in examples/fail/", { concurrency: FAIL_CONCURRENCY }, () => {
  let boot;
  let work;

  before(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "yoop-fail-"));
    // YOOP_BOOT_COMPILER runs the whole suite through an ALREADY BUILT
    // bootstrap, which is how a self-hosted stage gets checked against the same
    // hand-written expectations as the one the JS compiler built.
    if (process.env.YOOP_BOOT_COMPILER) {
      boot = process.env.YOOP_BOOT_COMPILER;
      return;
    }
    boot = path.join(work, "yoopiler_boot");
    await runProcOrThrow(
      "node",
      [path.join(REPO, "src/yoopiler.js"), BOOT_SRC, "-o", boot],
      { cwd: REPO, timeout: BUILD_TIMEOUT_MS },
    );
  });

  it("has ported fixtures", () => {
    assert.ok(ported.length > 0, `no .expected-errors files in ${FAIL}`);
  });

  // An expectation whose fixture was renamed away would otherwise sit there
  // asserting nothing.
  it("every .expected-errors names a fixture that exists", () => {
    const known = new Set(allFixtures.map((f) => f.name));
    const orphans = fs
      .readdirSync(FAIL)
      .filter((f) => f.endsWith(".expected-errors"))
      .map((f) => f.replace(/\.expected-errors$/, ""))
      .filter((n) => !known.has(n));
    assert.deepEqual(orphans, [], `expectation files with no fixture: ${orphans.join(", ")}`);
  });

  for (const fixture of ported) {
    it(`${fixture.name}: refused, with the expected diagnostics`, async () => {
      assert.ok(
        fixture.entry !== null,
        `${fixture.name}/ has an expectation but no main.yoop, so the harness has no entry file to compile`,
      );
      const expected = parseExpectations(fs.readFileSync(expectationOf(fixture.name), "utf8"), fixture.name);
      assert.ok(
        expected.length > 0,
        `${fixture.name}.expected-errors has no expectation lines - a fixture must expect at least one error`,
      );

      // --emit-ir stops before the link. Nothing here should reach codegen, and
      // a fixture that unexpectedly does has no business starting a clang.
      const r = await runProc(
        boot,
        [fixture.entry, "-o", path.join(work, fixture.name.replace(/\//g, "_")), "--emit-ir"],
        {
          cwd: REPO,
          env: {
            ...process.env,
            YOOP_STD_ROOT: path.join(REPO, "std"),
            YOOP_RUNTIME_ROOT: path.join(REPO, "runtime"),
          },
          timeout: COMPILE_TIMEOUT_MS,
        },
      );
      const output = `${r.stdout}${r.stderr}`;

      if (r.timedOut) {
        assert.fail(`${fixture.name}: the compiler never finished - it hangs on this program\n${output}`);
      }
      assert.notEqual(
        r.code, 0,
        `${fixture.name}: the bootstrap ACCEPTED a program that must be refused\n${output}`,
      );

      const got = parseDiagnostics(output);
      assert.ok(
        got.length > 0,
        `${fixture.name}: the compile failed but reported no [error] diagnostic\n${output}`,
      );

      for (const want of expected) {
        const here = got.filter((d) => d.line === want.line && d.column === want.column);
        assert.ok(
          here.length > 0,
          `${fixture.name}: expected a diagnostic at ${want.line}:${want.column} containing\n` +
            `    ${want.substring}\n` +
            `but nothing was reported there.\n${render(got)}`,
        );
        assert.ok(
          here.some((d) => d.message.includes(want.substring)),
          `${fixture.name}: the diagnostic at ${want.line}:${want.column} does not contain\n` +
            `    ${want.substring}\n${render(got)}`,
        );
      }
    });
  }

  // Not an assertion, a progress marker. The batch is deliberately partial, so
  // a bare pass would otherwise read as full coverage.
  it("reports how much of examples/fail/ is still unported", () => {
    const remaining = allFixtures.filter((f) => !fs.existsSync(expectationOf(f.name)));
    console.log(
      `# examples/fail/: ${ported.length} of ${allFixtures.length} fixtures have a .expected-errors; ` +
        `${remaining.length} still to port`,
    );
    assert.ok(true);
  });
});

// One `<line>:<column>: <substring>` per line, `#` comments and blank lines
// dropped. A line that is neither throws rather than being skipped: a typo in
// an expectation must not quietly become zero assertions.
function parseExpectations(text, name) {
  const out = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const m = /^(\d+):(\d+):\s?(.+)$/.exec(line);
    if (!m) {
      throw new Error(
        `${name}.expected-errors:${i + 1}: not an expectation and not a '#' comment:\n    ${raw}`,
      );
    }
    out.push({ line: Number(m[1]), column: Number(m[2]), substring: m[3] });
  });
  return out;
}

// `[error] <path>:<line>:<col>: <message>` lines out of the compiler's output.
// A path can hold a colon, so the line and column are taken from the END rather
// than by splitting on the first one. Diagnostics with no location at all - the
// module graph emits a few - are deliberately not returned; nothing in the
// expectation format can name them.
function parseDiagnostics(output) {
  const out = [];
  for (const line of output.split("\n")) {
    const m = /^\[error\]\s+(.*):(\d+):(\d+):\s(.*)$/.exec(line);
    if (!m) continue;
    out.push({ file: m[1], line: Number(m[2]), column: Number(m[3]), message: m[4] });
  }
  return out;
}

function render(got) {
  return ["what the bootstrap reported:", ...got.map((d) => `    ${d.line}:${d.column}: ${d.message}`)].join("\n");
}
