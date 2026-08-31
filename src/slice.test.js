// The vertical slice: programs the BOOTSTRAP compiler takes all the way to an
// executable.
//
// Each fixture in bootstrap/tests/slice/ has a hand-written `.expected` holding
// the program's stdout followed by an `exit=N` line. That file is the source of
// truth, and the assertion is bootstrap-output == expected.
//
// It used to carry a second assertion checking the JS reference against the
// same file, as a parity bonus. That reference is gone, and the split it was
// written for did its job: the bonus was deleted and every fixture still tests
// exactly what it tested before. Never capture a `.expected` from compiler
// output - write it from what the program should do. See the bootstrap testing
// rule in CLAUDE.md.
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";

import { runProc, runProcOrThrow, programOutput } from "./testProc.js";
import { EXE_SUFFIX } from "./toolchain.js";
import { seedCompiler, seedEnv } from "../scripts/seed.mjs";

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
// execFileSync and nothing else; src/testProc.js is the async twin, and it is
// where the deadline-and-tree-kill discipline that conversion needs lives.
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

// Deadlines. Nothing here spawns without one - see the header of
// src/testProc.js for why that is a rule rather than a nicety.
//
// A fixture compile is a whole-import-closure build, so it gets the minute the
// slowest of them could plausibly want on a loaded machine. RUNNING a fixture
// is another matter: these programs print a few lines and exit in milliseconds,
// so twenty seconds is not a budget, it is a hang detector with a wide margin
// for twelve of them competing with as many clangs. The fixtures that could
// actually wedge are the concurrency-runtime ones - task_spawn,
// task_intrinsics, async_coroutine - where a shutdown path that regressed would
// otherwise leave a process nobody is waiting on any more.
const COMPILE_TIMEOUT_MS = Number(process.env.YOOP_SLICE_COMPILE_TIMEOUT_MS) || 120000;
const RUN_TIMEOUT_MS = Number(process.env.YOOP_SLICE_RUN_TIMEOUT_MS) || 20000;

describe("vertical slice: the bootstrap compiler produces working executables", { concurrency: SLICE_CONCURRENCY }, () => {
  let boot;
  let work;

  before(async () => {
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
    // EXE_SUFFIX on everything this builds AND then runs. The compiler names its
    // output what the platform needs to consider it executable (withExeSuffix in
    // bootstrap/src/link/clang.yoop), so on Windows a `-o foo` produces `foo.exe`
    // and spawning `foo` is an ENOENT. Naming the output WITH the suffix keeps the
    // path handed to `-o` and the path spawned afterwards one string rather than
    // two that can drift.
    boot = path.join(work, `yoopiler_boot${EXE_SUFFIX}`);
    // The bootstrap compiler, built by the SEED - a previously released
    // yoopiler_boot. `seedEnv` points it at THIS tree's std and runtime rather
    // than the ones packaged beside it: the seed exists only to compile today's
    // source, and today's source imports today's std.
    await runProcOrThrow(
      seedCompiler(),
      [BOOT_SRC, "-o", boot],
      { cwd: REPO, env: seedEnv(), timeout: COMPILE_TIMEOUT_MS },
    );
  });

  // Every run of this suite used to leave its temp dir behind - `mkdtempSync`
  // makes a new one each time and nothing removed it. One session of iterating
  // left 9,882 of them and filled a 16G tmpfs, which surfaces as a LINK failure
  // in whatever runs next ("No space left on device") rather than as anything
  // pointing here.
  after(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
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
      const got = await buildAndRun(boot, [path.join(SLICE, name), "-o", path.join(work, `${stem}_bs${EXE_SUFFIX}`)], path.join(work, `${stem}_bs${EXE_SUFFIX}`), env, work);
      assert.equal(got, expected, `${stem}: the bootstrap compiler is wrong`);
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
      assert.ok(!fs.existsSync(out + EXE_SUFFIX), "--emit-ir linked an executable anyway");
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
      assert.ok(fs.existsSync(linked + EXE_SUFFIX), "the linking run produced no executable");
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

    // `--plugin`: the plugin is ordinary Yoop source the compiler loads,
    // typechecks and INTERPRETS at phase boundaries. The plugins here are
    // written inline because each is a few lines and the assertion is about
    // the driver's behaviour, not about a fixture worth naming.
    //
    // The plugin's own graph autoloads std, so these use testEnv() below
    // rather than the fixture env.
    describe("--plugin", () => {
      const pluginEnv = () => ({
        ...process.env,
        YOOP_RUNTIME_ROOT: path.join(REPO, "runtime"),
        YOOP_STD_ROOT: path.join(REPO, "std"),
      });
      const writePlugin = (name, source) => {
        const p = path.join(work, name);
        fs.writeFileSync(p, source);
        return p;
      };

      it("--plugin needs a path", async () => {
        const r = await runProc(boot, [hello, "--plugin"], { cwd: REPO, env: pluginEnv() });
        assert.equal(r.code, 2);
        assert.match(r.stderr, /--plugin needs a path/);
      });

      it("--plugin with --test is refused rather than ignored", async () => {
        const r = await runProc(boot, ["--test", ".", "--plugin", "x.yoop"], { cwd: REPO, env: pluginEnv() });
        assert.equal(r.code, 2);
        assert.match(r.stderr, /--plugin only applies to an ordinary compile/);
      });

      it("a plugin that does not exist fails the build before it starts", async () => {
        const r = await runProc(boot, [hello, "-o", path.join(work, "plug_none"), "--plugin", path.join(work, "no_such_plugin.yoop")], { cwd: REPO, env: pluginEnv() });
        assert.equal(r.code, 1);
        assert.match(r.stderr, /no_such_plugin\.yoop/);
        assert.ok(!fs.existsSync(path.join(work, "plug_none")), "the build produced a binary anyway");
      });

      it("hooks fire at every phase, in pipeline order, and the build completes", async () => {
        const plug = writePlugin("phases_plugin.yoop",
          'extern "C" from "stdio.h" {\n' +
          "  function printf(fmt: string, ...): int32;\n" +
          "}\n" +
          "export function onStart(entry: string, out: string): int32 { printf(`p:start\\n`); return 0; }\n" +
          "export function onParse(): int32 { printf(`p:parse\\n`); return 0; }\n" +
          "export function onTypecheck(): int32 { printf(`p:typecheck\\n`); return 0; }\n" +
          "export function onCodegen(): int32 { printf(`p:codegen\\n`); return 0; }\n" +
          "export function onLink(): int32 { printf(`p:link\\n`); return 0; }\n" +
          "export function onFinish(ok: int32): void { printf(`p:finish ${ok}\\n`); }\n");
        const out = path.join(work, "plug_phases");
        const r = await runProc(boot, [hello, "-o", out, "--plugin", plug], { cwd: REPO, env: pluginEnv() });
        assert.equal(r.code, 0, r.stderr);
        assert.ok(fs.existsSync(out), "the plugged build produced no executable");
        // Interpreted printf lands in the build log with the [comptime] tag,
        // which is itself worth pinning: plugin output must never reach the
        // compiler's stdout.
        const order = ["p:start", "p:parse", "p:typecheck", "p:codegen", "p:link", "p:finish 1"];
        let at = -1;
        for (const mark of order) {
          const found = r.stderr.indexOf(mark);
          assert.ok(found > at, `${mark} missing or out of order in:\n${r.stderr}`);
          at = found;
        }
        assert.equal(r.stdout, "", "plugin output leaked onto stdout");
      });

      it("a hook pulls real artifacts through std/plugin", async () => {
        // The assertions are shapes, not sizes: hello.yoop's exact token
        // count is not this test's business, but a build that parsed and
        // emitted IR cannot honestly report either as empty.
        const plug = writePlugin("inspect_plugin.yoop",
          'import * as plug from "std/plugin.yoop";\n' +
          "export function onParse(): int32 {\n" +
          "  if (plug.tokens().len == 0) { return 41; }\n" +
          "  if (plug.astJson().len == 0) { return 42; }\n" +
          "  if (plug.modulesJson().len == 0) { return 43; }\n" +
          "  plug.log(`inspect ok: ${plug.phase()}\\n`);\n" +
          "  return 0;\n" +
          "}\n" +
          "export function onCodegen(): int32 {\n" +
          "  if (plug.ir().len == 0) { return 44; }\n" +
          "  return 0;\n" +
          "}\n");
        const out = path.join(work, "plug_inspect");
        const r = await runProc(boot, [hello, "-o", out, "--plugin", plug], { cwd: REPO, env: pluginEnv() });
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stderr, /\[comptime\] inspect ok: parse/);
        assert.ok(fs.existsSync(out));
      });

      it("a hook's nonzero return stops the build with that exit code", async () => {
        const plug = writePlugin("refuse_plugin.yoop",
          "export function onTypecheck(): int32 { return 7; }\n");
        const out = path.join(work, "plug_refused");
        const r = await runProc(boot, [hello, "-o", out, "--plugin", plug], { cwd: REPO, env: pluginEnv() });
        assert.equal(r.code, 7, r.stderr);
        assert.match(r.stderr, /onTypecheck stopped the build \(7\)/);
        assert.ok(!fs.existsSync(out), "a refused build produced a binary anyway");
      });

      it("a hook with the wrong shape is refused when the plugin loads", async () => {
        const plug = writePlugin("badshape_plugin.yoop",
          'export function onParse(): string { return "no"; }\n');
        const r = await runProc(boot, [hello, "-o", path.join(work, "plug_shape"), "--plugin", plug], { cwd: REPO, env: pluginEnv() });
        assert.equal(r.code, 1);
        assert.match(r.stderr, /onParse has the wrong return type/);
      });

      it("a plugin gates the build on a child process over pipes", async () => {
        // The child is the fake renderer: it answers "go" to each line. The
        // build must stream a line per phase, block on each answer, and
        // complete - and the child's log must show the phases in order,
        // which proves the pipe carried the conversation the plugin claims.
        const child = path.join(work, "gate_child.sh");
        const childLog = path.join(work, "gate_child.log");
        fs.writeFileSync(child,
          "#!/bin/sh\n" +
          `while IFS= read -r line; do
            case "$line" in
              at*|finish*) echo "$line" >> "${childLog}"; echo go ;;
            esac
          done\n`);
        fs.chmodSync(child, 0o755);
        const plug = writePlugin("gate_plugin.yoop",
          'import * as plug from "std/plugin.yoop";\n' +
          "export function onStart(entry: string, out: string): int32 {\n" +
          `  if (plug.spawn("${child}") != 0) { return 91; }\n` +
          "  return 0;\n" +
          "}\n" +
          "export function onParse(): int32 { return gate(); }\n" +
          "export function onCodegen(): int32 { return gate(); }\n" +
          // The recvLine between send and kill is load-bearing: kill lands
          // as SIGTERM, and without the ack the child can die before it has
          // read the line the pipe already holds.
          "export function onFinish(ok: int32): void {\n" +
          "  const ignored = plug.sendLine(`finish ${ok}`);\n" +
          "  const ack = plug.recvLine();\n" +
          "  const ignored2 = plug.killChild();\n" +
          "}\n" +
          "function gate(): int32 {\n" +
          "  if (plug.sendLine(`at ${plug.phase()}`) != 0) { return 92; }\n" +
          "  if (plug.recvLine().len == 0) { return 93; }\n" +
          "  return 0;\n" +
          "}\n");
        const out = path.join(work, "plug_gated");
        const r = await runProc(boot, [hello, "-o", out, "--plugin", plug], { cwd: REPO, env: pluginEnv() });
        assert.equal(r.code, 0, r.stderr);
        assert.ok(fs.existsSync(out), "the gated build produced no executable");
        assert.equal(
          fs.readFileSync(childLog, "utf8"),
          "at parse\nat codegen\nfinish 1\n",
          "the child did not see the phases in pipeline order",
        );
      });

      it("the shipped vizworld plugin runs a whole build against the fake renderer", async () => {
        // The real plugin (tools/vizworld/plugin.yoop), the shell stand-in
        // for its window. What this pins: the plugin stays inside the
        // interpreter's subset (any drift is a comptime refusal by name),
        // the protocol leaves in pipeline order, and the build completes
        // once every gate is answered.
        const childLog = path.join(work, "vizworld_fake.log");
        const out = path.join(work, "plug_vizworld");
        const r = await runProc(boot,
          [hello, "-o", out, "--plugin", path.join(REPO, "tools/vizworld/plugin.yoop")],
          { cwd: REPO, env: {
            ...pluginEnv(),
            YOOP_VIZWORLD: path.join(REPO, "tools/vizworld/fake_renderer.sh"),
            VIZWORLD_FAKE_LOG: childLog,
          } });
        assert.equal(r.code, 0, r.stderr);
        assert.ok(fs.existsSync(out), "the vizworld-gated build produced no executable");
        const seen = fs.readFileSync(childLog, "utf8").split("\n").filter(Boolean);
        const gates = seen.filter((l) => l.startsWith("phase ") || l.startsWith("done "));
        assert.deepEqual(
          gates,
          ["phase parse", "phase typecheck", "phase codegen", "phase link", "done 1"],
          `the gates arrived wrong:\n${seen.join("\n")}`,
        );
        // The host streams the whole closure before the parse gate: one
        // `file` line plus a tokens and an ast blob per file (hello plus
        // its autoloaded std modules is at least two), and the plugin's
        // own six entry blobs ride on top of the per-file pairs.
        const files = seen.filter((l) => l.startsWith("file "));
        assert.ok(files.length >= 2, `expected a streamed closure, saw:\n${seen.join("\n")}`);
        const blobs = seen.filter((l) => l.startsWith("blob ")).map((l) => l.split(" ")[1]);
        const count = (kind) => blobs.filter((b) => b === kind).length;
        assert.equal(count("tokens"), files.length + 1, "one tokens blob per streamed file plus the entry's");
        assert.equal(count("ast"), files.length + 1, "one ast blob per streamed file plus the entry's");
        assert.equal(count("modules"), 1);
        assert.equal(count("ir"), 1);
        assert.equal(count("diagnostics"), 2);
        // Every streamed path is absolute and lands with its indices.
        assert.ok(files.every((l) => /^file \d+ \d+ \//.test(l)), `malformed file lines:\n${files.join("\n")}`);
      });

      it("a plugin that does not typecheck is refused with its own diagnostics", async () => {
        const plug = writePlugin("broken_plugin.yoop",
          "export function onParse(): int32 { return nowhere; }\n");
        const r = await runProc(boot, [hello, "-o", path.join(work, "plug_broken"), "--plugin", plug], { cwd: REPO, env: pluginEnv() });
        assert.equal(r.code, 1);
        assert.match(r.stderr, /plugin: .*broken_plugin\.yoop/);
        assert.match(r.stderr, /error\(s\)/);
      });
    });

    // `--test`: discovery, entry synthesis and the export wrapper, all the way
    // to a running test binary. Every expectation below is hand-written from
    // what the run SHOULD report, never captured - see the testing rule in
    // CLAUDE.md - and the exit code is asserted beside the output because it IS
    // the failure count, which is what CI gates on.
    //
    // std has to be pointed at: the boot compiler lives in a temp directory, so
    // there is no packaged `lib/std` beside it to discover.
    const testEnv = () => ({
      ...process.env,
      YOOP_RUNTIME_ROOT: path.join(REPO, "runtime"),
      YOOP_STD_ROOT: path.join(REPO, "std"),
    });

    // The bootstrap's OWN fixture tree, so this assertion survives the JS
    // reference's retirement. Four suites across three files and a
    // subdirectory, in sorted order, with the `.hidden/` copy skipped and
    // `plain.yoop` not discovered - none of which is visible any other way,
    // because a suite with no cases still announces itself.
    it("--test finds every suite below a path, sorted, and runs them", async () => {
      const r = await runProc(boot, ["--test", path.join(REPO, "bootstrap/tests/testmode")], {
        cwd: REPO,
        env: testEnv(),
      });
      assert.equal(
        programOutput(r.stdout),
        "# alpha.test.yoop:addsOne\n" +
          "# alpha.test.yoop:addsTwo\n" +
          "# nested/beta.test.yoop:betaBehaves\n" +
          "# zeta.test.yoop:zetaBehaves\n" +
          "1..0\n" +
          "# 0 passed, 0 failed\n",
        r.stderr,
      );
      assert.equal(r.code, 0, r.stderr);
    });

    it("--test on a passing tree reports every case and exits 0", async () => {
      const r = await runProc(boot, ["--test", path.join(REPO, "examples/testing/pass")], {
        cwd: REPO,
        env: testEnv(),
      });
      assert.equal(
        programOutput(r.stdout),
        "# strange_add.test.yoop:addsStrangelyWhenFirstIsTwoModFive\n" +
          "ok 1 - adds an extra 1 when a % 5 == 2\n" +
          "ok 2 - still adds the extra 1 at 7\n" +
          "# strange_add.test.yoop:addsPlainlyOtherwise\n" +
          "ok 3 - adds plainly when a % 5 is not 2\n" +
          "1..3\n" +
          "# 3 passed, 0 failed\n",
        r.stderr,
      );
      assert.equal(r.code, 0, r.stderr);
    });

    // The exit code IS the failure count, so a two-failure run exits 2.
    it("--test on a failing tree reports the failures and exits with their count", async () => {
      const r = await runProc(boot, ["--test", path.join(REPO, "examples/testing/fail")], {
        cwd: REPO,
        env: testEnv(),
      });
      assert.equal(
        programOutput(r.stdout),
        "# failing.test.yoop:reportsFailures\n" +
          "ok 1 - passes\n" +
          "not ok 2 - fails with detail\n" +
          "    n was 2, which is not 10\n" +
          "not ok 3 - fails with no detail\n" +
          "1..3\n" +
          "# 1 passed, 2 failed\n",
        r.stderr,
      );
      assert.equal(r.code, 2, r.stderr);
    });

    // The in-file flag's payoff: a test module has no `main`, so without the
    // shorthand, pointing the compiler at one would just be an error.
    it("a *.test.yoop entry with no flag enters test mode on its own", async () => {
      const r = await runProc(
        boot,
        [path.join(REPO, "examples/testing/pass/strange_add.test.yoop")],
        { cwd: REPO, env: testEnv() },
      );
      assert.match(programOutput(r.stdout), /# 3 passed, 0 failed\n$/);
      assert.equal(r.code, 0, r.stderr);
    });

    // Extra positionals are suite-name filters rather than a second input file.
    it("a filter after the path selects suites by substring", async () => {
      const r = await runProc(
        boot,
        ["--test", path.join(REPO, "examples/testing/pass"), "addsPlainly"],
        { cwd: REPO, env: testEnv() },
      );
      assert.equal(
        programOutput(r.stdout),
        "# strange_add.test.yoop:addsPlainlyOtherwise\n" +
          "ok 1 - adds plainly when a % 5 is not 2\n" +
          "1..1\n" +
          "# 1 passed, 0 failed\n",
        r.stderr,
      );
      assert.equal(r.code, 0, r.stderr);
    });

    // The three ways a `--test` line has nothing to run, each named rather than
    // left to fail somewhere further down as a missing `main`.
    it("--test refuses a missing path, a tree with no test files, and a tree with no suites", async () => {
      const missing = await runProc(boot, ["--test", "/no/such/place"], { cwd: REPO, env: testEnv() });
      assert.equal(missing.code, 1);
      assert.match(missing.stderr + missing.stdout, /--test: path not found/);

      const noFiles = await runProc(boot, ["--test", path.join(REPO, "runtime")], { cwd: REPO, env: testEnv() });
      assert.equal(noFiles.code, 1);
      assert.match(noFiles.stderr + noFiles.stdout, /no \*\.test\.yoop files found/);

      const noSuites = await runProc(boot, ["--test", path.join(REPO, "bootstrap/tests/graph")], {
        cwd: REPO,
        env: testEnv(),
      });
      assert.equal(noSuites.code, 1);
      assert.match(noSuites.stderr + noSuites.stdout, /test file\(s\) but no suites/);
    });

    it("a *.test.yoop file that does not declare import.test is refused by name", async () => {
      const r = await runProc(
        boot,
        ["--test", path.join(REPO, "bootstrap/tests/testmode_bad")],
        { cwd: REPO, env: testEnv() },
      );
      assert.equal(r.code, 1);
      assert.match(r.stderr + r.stdout, /does not declare 'import\.test;'/);
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

// Compiles, runs the program, and renders it in .expected form: stdout, then
// `exit=N`. A failed COMPILE throws with the compiler's own stderr attached.
//
// Both halves run through src/testProc.js, which is what keeps this file from
// leaking. This helper RUNS COMPILED EXECUTABLES - 134 fixtures, twice each -
// so it is the single spot in the tree where an unkilled child would
// accumulate fastest. Every spawn there
// carries a deadline, and every kill walks the process tree, which is the only
// way to reach the clang the compiler started.
async function buildAndRun(compiler, args, exe, env = process.env, runCwd = undefined) {
  const built = await runProc(compiler, args, {
    cwd: REPO,
    env,
    timeout: COMPILE_TIMEOUT_MS,
  });
  if (built.code !== 0) {
    const how = built.timedOut ? "never finished" : `exited ${built.code}`;
    throw new Error(`${compiler} ${args.join(" ")} ${how}\n${built.stderr}`);
  }
  // Run from the suite's own temp directory rather than from wherever the
  // harness happens to sit. A fixture that touches the filesystem writes a
  // RELATIVE name (see extern_opaque_type.yoop), and the alternative is either
  // an absolute path - which is what made two fixtures POSIX-only - or a
  // scratch file dropped in the repo root.
  const ran = await runProc(exe, [], { cwd: runCwd, timeout: RUN_TIMEOUT_MS });
  if (ran.timedOut) {
    throw new Error(
      `${exe} did not exit within ${RUN_TIMEOUT_MS}ms and was killed - ` +
        `the program hangs, or its runtime never shuts down`,
    );
  }
  if (ran.code === null) throw new Error(`${exe} was killed by ${ran.signal}`);
  return `${programOutput(ran.stdout)}exit=${ran.code}\n`;
}
