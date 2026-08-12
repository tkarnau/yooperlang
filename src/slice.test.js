// The vertical slice: programs the BOOTSTRAP compiler takes all the way to an
// executable, checked against the JS reference by running both.
//
// This is layer-6 parity from plans/bootstrap-pipeline-contracts.md - "identical
// program output" - and it is the one check that exercises every layer at once:
// module graph, lex, parse, typecheck, codegen, clang.
//
// The fixtures are bootstrap/tests/slice/. Add one the moment the bootstrap can
// compile it; the language subset it accepts is deliberately small and grows
// from the bottom.
import { describe, it, before } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";

const REPO = path.resolve(import.meta.dirname, "..");
const SLICE = path.join(REPO, "bootstrap/tests/slice");
const BOOT_SRC = path.join(REPO, "bootstrap/src/main.yoop");

const fixtures = fs
  .readdirSync(SLICE)
  .filter((f) => f.endsWith(".yoop"))
  .sort();

describe("vertical slice: the bootstrap compiler produces working executables", () => {
  let boot;
  let work;

  before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "yoop-slice-"));
    boot = path.join(work, "yoopiler_boot");
    // The bootstrap compiler, built by the JS compiler. Once it can compile
    // itself this line is the thing that changes.
    execFileSync("node", [path.join(REPO, "src/yoopiler.js"), BOOT_SRC, "-o", boot], {
      cwd: REPO,
      stdio: "pipe",
    });
  });

  it("has fixtures", () => {
    assert.ok(fixtures.length > 0, `no .yoop fixtures in ${SLICE}`);
  });

  for (const name of fixtures) {
    it(`${name}: both compilers produce the same behaviour`, () => {
      const src = path.join(SLICE, name);
      const stem = name.replace(/\.yoop$/, "");

      const viaBoot = buildAndRun(boot, [src, "-o", path.join(work, `${stem}_bs`)], path.join(work, `${stem}_bs`));
      const viaJs = buildAndRun(
        "node",
        [path.join(REPO, "src/yoopiler.js"), src, "-o", path.join(work, `${stem}_js`)],
        path.join(work, `${stem}_js`),
      );

      assert.equal(
        `${viaBoot.stdout}exit=${viaBoot.code}`,
        `${viaJs.stdout}exit=${viaJs.code}`,
        `${name}: the two compilers disagree\n` +
          `  js:        ${JSON.stringify(viaJs.stdout)} exit=${viaJs.code}\n` +
          `  bootstrap: ${JSON.stringify(viaBoot.stdout)} exit=${viaBoot.code}`,
      );
    });
  }
});

function buildAndRun(compiler, args, exe) {
  execFileSync(compiler, args, { cwd: REPO, stdio: "pipe" });
  try {
    return { stdout: execFileSync(exe, { encoding: "utf8" }), code: 0 };
  } catch (err) {
    // A non-zero exit is a RESULT here, not a failure - ret_code.yoop asserts on
    // exactly that.
    if (typeof err.status !== "number") throw err;
    return { stdout: err.stdout ?? "", code: err.status };
  }
}
