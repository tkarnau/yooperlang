// The vertical slice: programs the BOOTSTRAP compiler takes all the way to an
// executable.
//
// Each fixture in bootstrap/tests/slice/ has a hand-written `.expected` holding
// the program's stdout followed by an `exit=N` line. That file is the source of
// truth, and the primary assertion is bootstrap-output == expected. The JS
// reference is then checked against the SAME file as a parity bonus.
//
// The split matters: when the JS compiler retires, the second assertion goes
// away and every fixture still tests exactly what it tested before. Never
// capture a `.expected` from compiler output - write it from what the program
// should do. See the bootstrap testing rule in CLAUDE.md.
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
    // YOOP_BOOT_COMPILER runs the whole suite through an ALREADY BUILT
    // bootstrap instead of building one here. That is how a self-hosted stage
    // gets tested: `YOOP_BOOT_COMPILER=/tmp/stage3 npm run test:slice` asserts
    // the compiler the bootstrap built against the same hand-written
    // .expected files as the one the JS compiler built.
    if (process.env.YOOP_BOOT_COMPILER) {
      boot = process.env.YOOP_BOOT_COMPILER;
      return;
    }
    boot = path.join(work, "yoopiler_boot");
    // The bootstrap compiler, built by the JS compiler.
    execFileSync("node", [path.join(REPO, "src/yoopiler.js"), BOOT_SRC, "-o", boot], {
      cwd: REPO,
      stdio: "pipe",
    });
  });

  it("has fixtures", () => {
    assert.ok(fixtures.length > 0, `no .yoop fixtures in ${SLICE}`);
  });

  it("every fixture has a hand-written .expected", () => {
    const missing = fixtures.filter(
      (f) => !fs.existsSync(path.join(SLICE, f.replace(/\.yoop$/, ".expected"))),
    );
    assert.deepEqual(missing, [], `fixtures without an .expected: ${missing.join(", ")}`);
  });

  for (const name of fixtures) {
    const stem = name.replace(/\.yoop$/, "");
    // A fixture that needs a standard library brings its own: `<stem>.std/`
    // beside it becomes YOOP_STD_ROOT for that fixture only. Both compilers
    // honour the same variable, so the parity assertion still holds.
    //
    // A stub rather than the real std/, because the real one needs traits,
    // generics and kinds - the point of the fixture is the RESOLUTION path,
    // which can be tested long before the language can compile std itself.
    const stubStd = path.join(SLICE, `${stem}.std`);
    // The runtime root is the repo's own runtime/ for every fixture. Unlike
    // std, there is no stub to build: these are C sources clang compiles, and a
    // fixture that reaches the runtime wants the real ones. The bootstrap only
    // consults it when the emitted IR actually calls in, so this costs the
    // other fixtures nothing.
    const env = {
      ...process.env,
      YOOP_RUNTIME_ROOT: path.join(REPO, "runtime"),
      ...(fs.existsSync(stubStd) ? { YOOP_STD_ROOT: stubStd } : {}),
    };

    it(`${stem}: the bootstrap compiler produces the expected behaviour`, () => {
      const expected = fs.readFileSync(path.join(SLICE, `${stem}.expected`), "utf8");
      const got = buildAndRun(boot, [path.join(SLICE, name), "-o", path.join(work, `${stem}_bs`)], path.join(work, `${stem}_bs`), env);
      assert.equal(got, expected, `${stem}: the bootstrap compiler is wrong`);
    });

    // A `<stem>.bootonly` marker file means the fixture asserts behaviour the
    // JS reference does NOT share, so the parity bonus is skipped for it. Used
    // where the bootstrap is deliberately better - the file's contents say why,
    // and are read here only to force the reason to exist.
    const bootOnly = fs.existsSync(path.join(SLICE, `${stem}.bootonly`));

    // Parity bonus. Delete this block, not the one above, when the JS compiler
    // retires.
    it(`${stem}: the JS reference agrees`, { skip: bootOnly }, () => {
      const expected = fs.readFileSync(path.join(SLICE, `${stem}.expected`), "utf8");
      const got = buildAndRun(
        "node",
        [path.join(REPO, "src/yoopiler.js"), path.join(SLICE, name), "-o", path.join(work, `${stem}_js`)],
        path.join(work, `${stem}_js`),
        env,
      );
      assert.equal(got, expected, `${stem}: the JS reference disagrees with the fixture`);
    });
  }
});

// Runs the program and renders it in .expected form: stdout, then `exit=N`.
function buildAndRun(compiler, args, exe, env = process.env) {
  execFileSync(compiler, args, { cwd: REPO, stdio: "pipe", env });
  try {
    return `${execFileSync(exe, { encoding: "utf8" })}exit=0\n`;
  } catch (err) {
    // A non-zero exit is a RESULT here, not a failure - ret_code asserts on it.
    if (typeof err.status !== "number") throw err;
    return `${err.stdout ?? ""}exit=${err.status}\n`;
  }
}
