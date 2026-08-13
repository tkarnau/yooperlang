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
import { execFileSync, spawn } from "child_process";

const REPO = path.resolve(import.meta.dirname, "..");
const SLICE = path.join(REPO, "bootstrap/tests/slice");
const BOOT_SRC = path.join(REPO, "bootstrap/src/main.yoop");

const fixtures = fs
  .readdirSync(SLICE)
  .filter((f) => f.endsWith(".yoop"))
  .sort();

// How many fixtures run at once, and the same knob e2e.test.js already has for
// the same reason: node:test runs test FILES in parallel but every test WITHIN
// a file sequentially, so this one file was serializing 134 compile-link-run
// cycles while the rest of the suite sat idle. It was the longest pole in
// `npm test` by a wide margin.
//
// Safe because the fixtures share nothing. Each writes `<stem>_bs` / `<stem>_js`
// into one shared temp dir, so no two of them name the same output, and none
// of them binds a port or touches a fixed path. What made it serial was
// execFileSync and nothing else; the helper below is the async twin.
//
// Measured on a 14-core M-series machine, whole suite, including the ~5s
// `before()` build that no setting can overlap:
//
//     concurrency 1  : 60.1s
//     concurrency 7  : 18.8s
//     concurrency 12 : 18.0s
//     concurrency 20 : 18.6s
//     concurrency 28 : 18.4s
//
// So it PLATEAUS at about seven, and the cap below is not what limits it. The
// number is nonetheless the core count rather than e2e's half of it, because
// the two files are bound by different things: e2e compiles IN this process and
// so competes with itself for CPU, while every byte of work here happens in a
// child and this process only waits.
const SLICE_CONCURRENCY = Number(process.env.YOOP_SLICE_CONCURRENCY)
  || Math.max(2, Math.min(12, os.cpus().length));

describe("vertical slice: the bootstrap compiler produces working executables", { concurrency: SLICE_CONCURRENCY }, () => {
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

    it(`${stem}: the bootstrap compiler produces the expected behaviour`, async () => {
      const expected = fs.readFileSync(path.join(SLICE, `${stem}.expected`), "utf8");
      const got = await buildAndRun(boot, [path.join(SLICE, name), "-o", path.join(work, `${stem}_bs`)], path.join(work, `${stem}_bs`), env);
      assert.equal(got, expected, `${stem}: the bootstrap compiler is wrong`);
    });

    // A `<stem>.bootonly` marker file means the fixture asserts behaviour the
    // JS reference does NOT share, so the parity bonus is skipped for it. Used
    // where the bootstrap is deliberately better - the file's contents say why,
    // and are read here only to force the reason to exist.
    const bootOnly = fs.existsSync(path.join(SLICE, `${stem}.bootonly`));

    // Parity bonus. Delete this block, not the one above, when the JS compiler
    // retires.
    it(`${stem}: the JS reference agrees`, { skip: bootOnly }, async () => {
      const expected = fs.readFileSync(path.join(SLICE, `${stem}.expected`), "utf8");
      const got = await buildAndRun(
        "node",
        [path.join(REPO, "src/yoopiler.js"), path.join(SLICE, name), "-o", path.join(work, `${stem}_js`)],
        path.join(work, `${stem}_js`),
        env,
      );
      assert.equal(got, expected, `${stem}: the JS reference disagrees with the fixture`);
    });
  }

  // The driver's COMMAND LINE. Nested here rather than in its own file because
  // the compiler this needs is the one the outer `before` already built, and
  // building a second would cost more than every assertion below put together.
  //
  // These are bootstrap-only by nature - the JS reference has no `--emit-ir`
  // and its `--keep-ir` means something else - so there is no parity bonus.
  describe("the driver's command line", () => {
    const hello = path.join(SLICE, "hello.yoop");
    const env = () => ({ ...process.env, YOOP_RUNTIME_ROOT: path.join(REPO, "runtime") });

    it("--emit-ir writes the .ll and produces no executable", async () => {
      const out = path.join(work, "cli_emit");
      const r = await runProc(boot, [hello, "-o", out, "--emit-ir"], { cwd: REPO, env: env() });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(fs.existsSync(`${out}.ll`), "--emit-ir did not write the IR");
      assert.ok(!fs.existsSync(out), "--emit-ir linked an executable anyway");
    });

    // The one invariant that matters: the flag stops the pipeline, it does not
    // change it. If these two ever differ, every measurement taken through
    // --emit-ir is about a different compiler than the one that ships.
    it("--emit-ir writes byte-identical IR to a linking run", async () => {
      const linked = path.join(work, "cli_linked");
      const emitted = path.join(work, "cli_emitted");
      const a = await runProc(boot, [hello, "-o", linked], { cwd: REPO, env: env() });
      assert.equal(a.code, 0, a.stderr);
      const b = await runProc(boot, [hello, "-o", emitted, "--emit-ir"], { cwd: REPO, env: env() });
      assert.equal(b.code, 0, b.stderr);
      assert.ok(
        fs.readFileSync(`${linked}.ll`).equals(fs.readFileSync(`${emitted}.ll`)),
        "--emit-ir emits different IR than a linking run",
      );
      assert.ok(fs.existsSync(linked), "the linking run produced no executable");
    });

    it("a flag may stand before the entry file", async () => {
      const out = path.join(work, "cli_prefix");
      const r = await runProc(boot, ["--emit-ir", "-o", out, hello], { cwd: REPO, env: env() });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(fs.existsSync(`${out}.ll`));
    });

    it("an unknown option is refused BY NAME rather than taken for a file", async () => {
      const r = await runProc(boot, [hello, "--bogus"], { cwd: REPO, env: env() });
      assert.equal(r.code, 2);
      assert.match(r.stderr + r.stdout, /unknown option --bogus/);
    });

    it("-o with nothing after it, no input, and two inputs are each named", async () => {
      const noPath = await runProc(boot, [hello, "-o"], { cwd: REPO, env: env() });
      assert.equal(noPath.code, 2);
      assert.match(noPath.stderr + noPath.stdout, /-o needs a path/);

      const noInput = await runProc(boot, [], { cwd: REPO, env: env() });
      assert.equal(noInput.code, 2);
      assert.match(noInput.stderr + noInput.stdout, /no input file/);

      const two = await runProc(boot, [hello, hello], { cwd: REPO, env: env() });
      assert.equal(two.code, 2);
      assert.match(two.stderr + two.stdout, /more than one input file/);
    });
  });
});

// Run a child process and resolve with its output. Async so two fixtures can
// overlap: a test waiting on clang yields to another instead of blocking the
// event loop, which is the whole of what SLICE_CONCURRENCY buys.
//
// A non-zero exit is DATA, not an error - `ret_code` asserts on one. A death by
// SIGNAL gives a null code and is not, which is why it is separated out below
// rather than rendered as `exit=null`.
function runProc(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ stdout, stderr, code, signal }));
  });
}

// Compiles, runs the program, and renders it in .expected form: stdout, then
// `exit=N`. A failed COMPILE throws with the compiler's own stderr attached,
// which is what execFileSync used to do.
async function buildAndRun(compiler, args, exe, env = process.env) {
  const built = await runProc(compiler, args, { cwd: REPO, env });
  if (built.code !== 0) {
    throw new Error(`${compiler} ${args.join(" ")} exited ${built.code}\n${built.stderr}`);
  }
  const ran = await runProc(exe, []);
  if (ran.code === null) throw new Error(`${exe} was killed by ${ran.signal}`);
  return `${ran.stdout}exit=${ran.code}\n`;
}
