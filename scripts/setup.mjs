// Get a fresh checkout to a working development loop, on any machine.
//
// `node scripts/setup.mjs` after a clone. It checks what has to be installed,
// fetches the bootstrap seed, builds a DEVELOPMENT COMPILER out of this tree,
// proves it works, and then prints the two editor steps - which it does not do
// itself, because they write outside the repo.
//
// WHAT IT BUILDS AND WHY IT LIVES WHERE IT DOES. The output is
// `build/dev/bin/yoopiler_boot`, which is gitignored like everything else under
// build/, and it is a CONVENTION rather than an implementation detail: the VS
// Code extension looks for exactly that path when the folder you have open is a
// compiler checkout. That is what separates the compiler's own language server
// from the one a Yoop program you are writing gets - see the extension's
// resolveServer(). Nothing else in the tree reads it, and no test depends on
// it; a suite builds its own compiler.
//
// It is deliberately NOT a `npm test` prerequisite. The suites build what they
// need from the seed, so setup being stale can never make a test lie.
//
// IDEMPOTENT. Run it again after a pull to refresh the dev compiler; run it
// again after a failed run to pick up where it left off. Nothing here removes
// anything you have.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SEED_TAG, seedCompiler, seedEnv } from "./seed.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXE = process.platform === "win32" ? ".exe" : "";

// The development compiler this builds, and the path the editor looks for.
export const DEV_BIN = path.join(repoRoot, "build", "dev", "bin", `yoopiler_boot${EXE}`);

const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
const skipSmoke = args.has("--skip-smoke") || skipBuild;

function say(msg) {
  process.stdout.write(`${msg}\n`);
}

function step(n, total, msg) {
  say(`\n[${n}/${total}] ${msg}`);
}

// A tool's version line, or null when it is not on PATH. Used for reporting
// rather than for gating, except where noted: a version this does not
// understand is not a reason to refuse to try.
function toolVersion(cmd, cmdArgs) {
  try {
    const out = execFileSync(cmd, cmdArgs, { stdio: ["ignore", "pipe", "ignore"] });
    return out.toString().split("\n")[0].trim();
  } catch {
    return null;
  }
}

/*
  What has to be installed, and what each one is FOR.

  Only clang is hard. The compiler emits LLVM IR text and shells out to clang to
  assemble and link, so without it nothing reaches an executable - and the error
  you get much later is a failed link rather than a missing tool.

  `gh` is conditionally hard: it is how the seed is downloaded, so it matters
  only on a machine that has neither a cached seed nor a YOOP_SEED pointing at
  a binary it already has.
*/
function checkPrerequisites() {
  const clang = toolVersion("clang", ["--version"]);
  const git = toolVersion("git", ["--version"]);
  const gh = toolVersion("gh", ["--version"]);
  const lldb = toolVersion("lldb", ["--version"]) || toolVersion("gdb", ["--version"]);

  say(`  node    ${process.version}`);
  say(`  clang   ${clang ?? "NOT FOUND"}`);
  say(`  git     ${git ?? "not found"}`);
  say(`  gh      ${gh ?? "not found"}`);
  say(`  lldb    ${lldb ?? "not found (only the debugger tests need it)"}`);

  if (!clang) {
    fail(
      "clang is required and is not on PATH.\n" +
        "  The compiler emits LLVM IR and shells out to clang to link.\n" +
        `  ${installHint("clang")}`,
    );
  }

  const seedCached = seedIsAvailable();
  if (!seedCached && !gh) {
    fail(
      "no bootstrap seed, and no `gh` to download one.\n" +
        "  The compiler is self-hosted, so building it needs a previous release to start from.\n" +
        `  Either install and authenticate the GitHub CLI (gh auth login) so ${SEED_TAG} can be\n` +
        "  fetched, or point YOOP_SEED at a yoopiler_boot binary you already have:\n" +
        "      YOOP_SEED=/path/to/yoopiler_boot node scripts/setup.mjs",
    );
  }
}

// Whether a seed is already reachable without the network. Deliberately does
// not CALL seedCompiler, which would download - the point here is to report
// what is missing before anything long-running starts.
function seedIsAvailable() {
  if (process.env.YOOP_SEED) return fs.existsSync(process.env.YOOP_SEED);
  const cache = path.join(repoRoot, ".seed");
  if (!fs.existsSync(cache)) return false;
  return findFile(cache, `yoopiler_boot${EXE}`) !== null;
}

// The first file named `name` anywhere under `dir`, or null. Small enough trees
// that a plain recursive walk is the right amount of machinery.
function findFile(dir, name) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (e.name === name) {
      return full;
    }
  }
  return null;
}

// What to type to get a missing tool, for the platform this is running on.
// Named guesses, not a package manager this script is willing to run for you.
function installHint(tool) {
  if (process.platform === "darwin") {
    return `Try: xcode-select --install   (or: brew install ${tool})`;
  }
  if (process.platform === "linux") {
    return `Try: sudo apt install ${tool}   (or your distribution's equivalent)`;
  }
  return `Install ${tool} and put it on PATH.`;
}

function fail(msg) {
  process.stderr.write(`\nsetup: ${msg}\n`);
  process.exit(1);
}

// Run a command, letting its output through. Throws on a non-zero exit, which
// the caller turns into an actionable message.
function run(cmd, cmdArgs, opts = {}) {
  execFileSync(cmd, cmdArgs, { stdio: "inherit", cwd: repoRoot, ...opts });
}

/*
  Build the development compiler out of this tree, with the seed.

  `seedEnv()` is not optional and is the whole reason this is a script rather
  than a line in a README. A compiler that is not given YOOP_STD_ROOT and
  YOOP_RUNTIME_ROOT reads the std and C runtime packaged BESIDE IT, so the seed
  would compile today's source against the std it shipped with - quietly, and
  with no error to read.
*/
function buildDevCompiler(seed) {
  fs.mkdirSync(path.dirname(DEV_BIN), { recursive: true });
  try {
    run(seed, [path.join("bootstrap", "src", "main.yoop"), "-o", DEV_BIN], { env: seedEnv() });
  } catch (e) {
    fail(
      `the compiler did not build.\n` +
        `  This is the one failure that is probably not your setup: the seed is fine and the\n` +
        `  tree did not compile. Read the errors above.\n` +
        `  Original error: ${e.message}`,
    );
  }
  if (!fs.existsSync(DEV_BIN)) {
    fail(`the build reported success but ${DEV_BIN} is not there`);
  }
}

/*
  Prove the thing that was just built actually compiles and runs a program.

  A compiler that builds and then cannot link is the failure this catches, and
  it is the common one on a fresh machine: clang is present but its headers or
  its C library are not. The program is written here rather than taken from
  examples/ so that a smoke test can never be broken by an unrelated change to
  the corpus.
*/
function smokeTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop-setup-"));
  try {
    const src = path.join(dir, "hello.yoop");
    const out = path.join(dir, `hello${EXE}`);
    fs.writeFileSync(
      src,
      [
        'import * as log from "std/log.yoop";',
        "",
        "function main(): int32 {",
        '  log.info("setup: the compiler you just built works");',
        "  return 0;",
        "}",
        "",
      ].join("\n"),
    );
    run(DEV_BIN, [src, "-o", out], { env: seedEnv() });
    run(out, []);
  } catch (e) {
    fail(
      `the compiler built, but it could not compile and run a hello program.\n` +
        `  That is usually clang: it is on PATH but cannot link (missing headers or libc).\n` +
        `  ${installHint("clang")}\n` +
        `  Original error: ${e.message}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The two things this script will not do for you, because they write outside
// the repo. See editors/vscode/README.md for what each one is.
function printEditorSteps() {
  const extDir = path.join(repoRoot, "editors", "vscode");
  const linkTarget = path.join(os.homedir(), ".vscode", "extensions", "yoop-lang.yoop-lang-0.1.0");
  say("\nThe editor is two commands, and they write outside this repo so they are yours to run:");
  say("");
  say(`    (cd ${extDir} && npm install)`);
  if (process.platform === "win32") {
    say(`    mklink /D "${linkTarget}" "${extDir}"`);
  } else {
    say(`    ln -s "${extDir}" "${linkTarget}"`);
  }
  say("");
  say("Then restart VS Code - it only scans the extensions directory at startup.");
  say("");
  say("The extension works out which compiler to speak to from the folder you have OPEN:");
  say("  this checkout      -> the compiler you just built, against this tree's std");
  say("  any other project  -> a released compiler, against the std packaged with it");
  say("so a broken working tree cannot break the editor for your other Yoop projects.");
}

// ----- the run --------------------------------------------------------------

say("Yooperlang development setup");
say(`  repo     ${repoRoot}`);
say(`  platform ${process.platform}-${process.arch}`);

const TOTAL = skipBuild ? 2 : (skipSmoke ? 3 : 4);
let n = 0;

step(++n, TOTAL, "checking what has to be installed");
checkPrerequisites();

step(++n, TOTAL, `resolving the bootstrap seed (${SEED_TAG})`);
let seed;
try {
  seed = seedCompiler();
} catch (e) {
  fail(e.message);
}
say(`  seed ${seed}`);

if (!skipBuild) {
  step(++n, TOTAL, "building the development compiler from this tree");
  buildDevCompiler(seed);
  say(`  built ${DEV_BIN}`);
}

if (!skipSmoke) {
  step(++n, TOTAL, "checking it can compile and run a program");
  smokeTest();
}

say("\nDone. From here:");
say("  npm test                      every Node-driven suite");
say("  npm run test:unit             the fast subset, no clang needed");
if (!skipBuild) {
  say(`  ${path.relative(repoRoot, DEV_BIN)}   the compiler you just built`);
}
printEditorSteps();
