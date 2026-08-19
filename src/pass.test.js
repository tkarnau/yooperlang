// The program corpus: every example the BOOTSTRAP compiler has to build, run,
// and get RIGHT.
//
// Each program under examples/pass/ and examples/tour/ that carries a
// hand-written `.expected` beside it is compiled with the bootstrap, run, and
// its stdout plus exit code asserted against that file. The `.expected` is the
// source of truth.
//
// WHY THIS EXISTS. scripts/probe_programs.sh answers the same question by
// building each program with BOTH compilers and diffing the two runs against
// each other. That is the only thing in the tree that can catch a miscompile,
// and it dies with the JS reference: two compilers are what it needs, and after
// the retirement there is one. This suite is what replaces it, and the
// difference is the whole point - a differential comparison says "the two
// agree", an absolute one says "the program is right". The former passes
// happily when both compilers are wrong the same way.
//
// FORMAT of a `.expected` file - the same one bootstrap/tests/slice/ uses, so
// there is one format to learn and not two:
//
//     the program's stdout, verbatim, line for line
//     exit=N
//
// No comments, no blank-line rules: the file IS the output. `exit=N` is always
// the last line.
//
// NEVER CAPTURE ONE FROM COMPILER OUTPUT. Write it by reading the program and
// working out what it should print. A captured file asserts that today's
// behaviour equals today's behaviour, which is not an assertion; it also
// silently blesses whatever bug is being captured. This is the rule from
// CLAUDE.md and it is the only reason the corpus is worth building.
//
// WHERE THE FILE GOES. Beside the program for a plain `.yoop`
// (`arrays.yoop` -> `arrays.expected`), and beside the DIRECTORY for a
// directory fixture (`http_router/` -> `http_router.expected`), so that nothing
// inside a module directory is anything but Yoop source. Same convention
// examples/fail/ already uses for `.expected-errors`.
//
// THE CORPUS IS PORTED INCREMENTALLY. A program with no `.expected` yet gets no
// test rather than a failing one, and the last test in the file reports how
// many are left. A bare green run must never read as full coverage.
//
// There is no JS parity bonus here, unlike the slice suite. These expectations
// are written from the PROGRAM, and there are already programs where the
// reference disagrees with the program and the bootstrap is right (`${bool}`
// rendering 1 rather than true, among others - see bootstrap/README.md). A
// parity assertion would fail on those, and asserting the reference against a
// file that documents the reference's own bugs is not a test worth having.
import { describe, it, before } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";

import { runProc, runProcOrThrow } from "./testProc.js";

const REPO = path.resolve(import.meta.dirname, "..");
const PASS = path.join(REPO, "examples/pass");
const TOUR = path.join(REPO, "examples/tour");
const BOOT_SRC = path.join(REPO, "bootstrap/src/main.yoop");

// Same reasoning as src/slice.test.js: every byte of work here happens in a
// child process, so this process only waits and the cap is the core count.
const PASS_CONCURRENCY = Number(process.env.YOOP_PASS_CONCURRENCY)
  || Math.max(2, Math.min(12, os.cpus().length));

// Deadlines. Nothing spawns without one - see the header of src/testProc.js.
// A compile is a whole-import-closure build; a RUN of one of these programs is
// milliseconds, so the run limit is a hang detector rather than a budget. The
// ones that could actually wedge are the loopback-socket and task programs,
// where a shutdown path that regressed would otherwise leave a process nobody
// is waiting on.
const COMPILE_TIMEOUT_MS = Number(process.env.YOOP_PASS_COMPILE_TIMEOUT_MS) || 120000;
const RUN_TIMEOUT_MS = Number(process.env.YOOP_PASS_RUN_TIMEOUT_MS) || 20000;

// One entry per program: the entry file to compile, the stem its artifacts and
// its expectation file are named by, and the directory the expectation sits in.
//
// A directory fixture is entered through its main.yoop and named by the
// DIRECTORY, which is what keeps `http_router.expected` out of `http_router/`.
function corpusIn(dir, prefix) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      if (e.isDirectory()) {
        const entry = path.join(dir, e.name, "main.yoop");
        return fs.existsSync(entry) ? [{ stem: `${prefix}${e.name}`, entry, dir }] : [];
      }
      if (!e.name.endsWith(".yoop")) return [];
      return [{ stem: `${prefix}${e.name.slice(0, -5)}`, entry: path.join(dir, e.name), dir }];
    })
    .sort((a, b) => a.stem.localeCompare(b.stem));
}

const programs = [
  ...corpusIn(PASS, "pass/"),
  ...corpusIn(TOUR, "tour/"),
];

// The expectation file for a program, and the marker that says it cannot have
// one. Both are named by the STEM, in the directory the program lives in.
const expectationOf = (p) => path.join(p.dir, `${path.basename(p.stem)}.expected`);
const markerOf = (p) => path.join(p.dir, `${path.basename(p.stem)}.nondeterministic`);

const ported = programs.filter((p) => fs.existsSync(expectationOf(p)));
const excluded = programs.filter((p) => !fs.existsSync(expectationOf(p)) && fs.existsSync(markerOf(p)));

describe("the corpus: the bootstrap compiler builds and runs examples/ correctly", { concurrency: PASS_CONCURRENCY }, () => {
  let work;
  let boot;

  before(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "yoop-pass-"));
    // YOOP_BOOT_COMPILER runs the whole suite through an ALREADY BUILT
    // bootstrap instead of building one here, which is how a self-hosted stage
    // gets tested against the same expectations.
    if (process.env.YOOP_BOOT_COMPILER) {
      boot = process.env.YOOP_BOOT_COMPILER;
      return;
    }
    boot = path.join(work, "yoopiler_boot");
    await runProcOrThrow(
      "node",
      [path.join(REPO, "src/yoopiler.js"), BOOT_SRC, "-o", boot],
      { cwd: REPO, timeout: COMPILE_TIMEOUT_MS },
    );
  });

  it("finds programs", () => {
    assert.ok(programs.length > 0, `no programs under ${PASS} or ${TOUR}`);
  });

  // A marker means "this program's output is not fully determined by the
  // program", so no `.expected` can be written for it. Its CONTENTS say why,
  // and are read here only to force the reason to exist - the same trick the
  // slice suite's `.bootonly` uses.
  it("every exclusion marker states a reason", () => {
    const silent = excluded.filter((p) => fs.readFileSync(markerOf(p), "utf8").trim().length === 0);
    assert.deepEqual(
      silent.map((p) => p.stem),
      [],
      "a .nondeterministic marker has to say WHY the program cannot have an expectation",
    );
  });

  // A program cannot be both ported and excluded: the marker would then be
  // documenting a reason that the expectation beside it disproves.
  it("no program is both ported and excluded", () => {
    const both = programs.filter((p) => fs.existsSync(expectationOf(p)) && fs.existsSync(markerOf(p)));
    assert.deepEqual(both.map((p) => p.stem), [], "these have an .expected AND a .nondeterministic marker");
  });

  for (const program of ported) {
    it(`${program.stem}: builds, runs, and produces the expected output`, async () => {
      const expected = fs.readFileSync(expectationOf(program), "utf8");
      const slug = program.stem.replace(/\//g, "_");
      const out = path.join(work, slug);
      const got = await buildAndRun(boot, [program.entry, "-o", out], out, sandboxFor(program, slug));
      assert.equal(
        got,
        expected,
        `${program.stem}: the program did not do what ${path.relative(REPO, expectationOf(program))} says it should`,
      );
    });
  }

  // A private working directory for one program's RUN, with any data files the
  // program reads staged into it.
  //
  // Two things go wrong without this, and the second one bit before it was
  // added. A program that writes a relative path writes it into the REPO,
  // because npm runs the suite from there - `fs_metadata` leaves a
  // `yoop_fs_meta_test.bin` in the working tree. And src/e2e.test.js runs some
  // of these same programs, from the same cwd, in a test FILE that node runs in
  // parallel with this one: two runs of `fs_metadata` then create, stat and
  // delete ONE file, and whichever loses the race reports a size for a file the
  // other already removed. That is an intermittent failure that looks like a
  // compiler bug and is not one.
  //
  // Staging is what an asset-reading program needs anyway: `language_showcase`
  // fopens `language_showcase.txt` beside itself, which no cwd but its own
  // directory would find.
  function sandboxFor(program, slug) {
    const dir = path.join(work, `run_${slug}`);
    fs.mkdirSync(dir, { recursive: true });
    // Everything beside the program that is not source or expectation is an
    // asset it might read. Cheap to copy and it keeps the rule to one line
    // rather than a per-program table that would drift.
    for (const e of fs.readdirSync(program.dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      if (/\.(yoop|expected|nondeterministic)$/.test(e.name)) continue;
      fs.copyFileSync(path.join(program.dir, e.name), path.join(dir, e.name));
    }
    return dir;
  }

  // Not an assertion, a progress marker. The corpus is deliberately partial
  // while it is being written, so a bare pass would otherwise read as full
  // coverage - which is the exact thing this suite exists to stop.
  it("reports how much of the corpus is still unported", () => {
    const remaining = programs.length - ported.length - excluded.length;
    console.log(
      `# examples/: ${ported.length} of ${programs.length} programs have a hand-written .expected; ` +
        `${excluded.length} excluded as nondeterministic; ${remaining} still to port`,
    );
    assert.ok(true);
  });
});

// Compiles, runs, and renders the result in `.expected` form: stdout, then
// `exit=N`. A failed COMPILE throws with the compiler's own stderr attached,
// because "the expectation did not match" would be a misleading way to report a
// program that never built.
//
// stderr is deliberately NOT part of the comparison. These programs write their
// results to stdout; stderr carries the runtime's own diagnostics, which are
// not what the program is asserting and which a leak tracker or a sanitizer
// would otherwise make the corpus fight over.
//
// Both spawns go through src/testProc.js, which carries the deadline and kills
// the process TREE. This helper runs COMPILED EXECUTABLES several hundred times
// per suite run, so it is the spot where an unkilled child would accumulate
// fastest.
async function buildAndRun(compiler, args, exe, runCwd) {
  const env = {
    ...process.env,
    YOOP_STD_ROOT: path.join(REPO, "std"),
    YOOP_RUNTIME_ROOT: path.join(REPO, "runtime"),
  };
  const built = await runProc(compiler, args, { cwd: REPO, env, timeout: COMPILE_TIMEOUT_MS });
  if (built.code !== 0) {
    const how = built.timedOut ? "never finished" : `exited ${built.code}`;
    throw new Error(`${compiler} ${args.join(" ")} ${how}\n${built.stderr}`);
  }
  // The COMPILE runs from the repo, because the entry path is written relative
  // to it. The PROGRAM runs from its own sandbox - see sandboxFor.
  const ran = await runProc(exe, [], { cwd: runCwd, env, timeout: RUN_TIMEOUT_MS });
  if (ran.timedOut) {
    throw new Error(
      `${exe} did not exit within ${RUN_TIMEOUT_MS}ms and was killed - ` +
        `the program hangs, or its runtime never shuts down`,
    );
  }
  if (ran.code === null) throw new Error(`${exe} was killed by ${ran.signal}`);
  return `${ran.stdout}exit=${ran.code}\n`;
}
