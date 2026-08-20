// Builds the SELF-HOSTED bootstrap compiler and bundles it into one tarball.
// Run with `node scripts/package_bootstrap.mjs [--version 0.2.0]`.
//
// This packages
// the JS reference. The two produce different things on purpose: that one ships
// a node binary with the reference compiler injected into it, this one ships a
// native executable the bootstrap compiled from its own source.
//
// What it does, in order:
//
//   1. Builds three stages. stage1 is the bootstrap built by the SEED - a
//      previously released yoopiler_boot, see scripts/seed.mjs -
//      stage2 is the bootstrap built by stage1, stage3 is the bootstrap built
//      by stage2.
//   2. Asserts stage2 and stage3 are byte-identical, IR and binary both. Same
//      check src/selfhost.test.js makes, and the same reasoning: stage2 and
//      stage3 were built by compilers whose SOURCE is identical, so a
//      difference means stage1 and stage2 disagree about how to compile
//      something. A release must not ship a compiler that fails this.
//   3. Stages dist/<target>/ in the layout the binary probes for at run time
//      (bin/ beside lib/), so the recipient needs no environment variables.
//   4. Compiles and runs a hello program with the PACKAGED binary and a clean
//      environment. This is the only step that proves the layout in 3 is the
//      one discovery actually finds, since every other build here is handed
//      YOOP_STD_ROOT explicitly.
//   5. Tars it and writes a sha256 beside it.
//
// The shipped binary is stage2, not stage3. They are byte-identical by the
// time step 2 passes, so it makes no difference to the artifact, and stage2 is
// the one whose provenance is easiest to state: built by a compiler the JS
// reference built from this commit.
//
// clang remains a hard runtime dependency for the recipient. This packages the
// compiler, not the toolchain underneath it.

import { execFileSync } from "node:child_process";
import { seedCompiler } from "./seed.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const versionFlag = argv.indexOf("--version");
const version =
  versionFlag !== -1 && argv[versionFlag + 1]
    ? argv[versionFlag + 1]
    : JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;

const binName = process.platform === "win32" ? "yoopiler_boot.exe" : "yoopiler_boot";
const target = `yoopiler-boot-${version}-${process.platform}-${process.arch}`;
const distDir = path.join(repoRoot, "dist", target);
const stagesDir = path.join(repoRoot, "build", "selfhost");

const PLATFORM_HUMAN =
  {
    darwin: process.arch === "arm64" ? "macOS on Apple Silicon" : "macOS on Intel",
    linux: `Linux (${process.arch})`,
    win32: `Windows (${process.arch})`,
  }[process.platform] ?? `${process.platform} ${process.arch}`;

// The stage builds are handed the repo's std and runtime explicitly. A stage
// binary sits in build/selfhost/sN/ with no lib/ beside it, so discovery would
// find nothing; only the packaged binary in step 4 is asked to find its own.
const buildEnv = {
  ...process.env,
  YOOP_STD_ROOT: path.join(repoRoot, "std"),
  YOOP_RUNTIME_ROOT: path.join(repoRoot, "runtime"),
};

function step(msg) {
  process.stdout.write(`\n==> ${msg}\n`);
}

function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    stdio: "inherit",
    cwd: repoRoot,
    env: buildEnv,
    ...opts,
  });
}

// clang links every one of the three stages, so a missing one fails four
// minutes in with a message about a link step rather than about the toolchain.
try {
  execFileSync("clang", ["--version"], { stdio: "ignore" });
} catch {
  fail("clang is not on PATH. It links every stage, and the recipient needs it too.");
}

// 1. The three stages.
//
// Same basename in different directories, which matters: clang embeds the
// output path in the Mach-O and in the code signature covering it, so
// `-o stage2` and `-o stage3` would differ in bytes that have nothing to do
// with the compiler. Kept in build/ rather than a temp dir so CI can upload
// the .ll files when the comparison below fails.
fs.rmSync(stagesDir, { recursive: true, force: true });
const stage = {};
for (const s of ["s1", "s2", "s3"]) {
  fs.mkdirSync(path.join(stagesDir, s), { recursive: true });
  stage[s] = path.join(stagesDir, s, binName);
}
const bootSrc = path.join(repoRoot, "bootstrap", "src", "main.yoop");

step("stage1: the released seed builds the bootstrap");
run(seedCompiler(), [bootSrc, "-o", stage.s1]);

step("stage2: the bootstrap builds itself");
run(stage.s1, [bootSrc, "-o", stage.s2]);

step("stage3: the compiler the bootstrap built builds it again");
run(stage.s2, [bootSrc, "-o", stage.s3]);

// 2. The fixpoint. The IR comparison is the stronger of the two: that IS the
//    compiler's output, and clang is downstream of it.
step("checking the self-hosting fixpoint");
for (const [what, a, b] of [
  ["IR", `${stage.s2}.ll`, `${stage.s3}.ll`],
  ["binary", stage.s2, stage.s3],
]) {
  if (!fs.readFileSync(a).equals(fs.readFileSync(b))) {
    fail(
      `stage2 and stage3 differ (${what}).\n` +
        `stage1 and stage2 disagree about how to compile something, so this build\n` +
        `is not shippable. Diff the two:\n\n  diff ${stage.s2}.ll ${stage.s3}.ll\n`,
    );
  }
  process.stdout.write(`    ok    stage2 and stage3 ${what} are byte-identical\n`);
}

// 3. Stage the package. The binary probes <exeDir>/../lib/std and
//    <exeDir>/../lib/runtime at run time (bootstrap/src/source_graph/std_root.yoop
//    and bootstrap/src/link/runtime_root.yoop), which is exactly this layout.
step(`staging dist/${target}/`);
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(path.join(distDir, "bin"), { recursive: true });
fs.copyFileSync(stage.s2, path.join(distDir, "bin", binName));
fs.chmodSync(path.join(distDir, "bin", binName), 0o755);

fs.cpSync(path.join(repoRoot, "std"), path.join(distDir, "lib", "std"), {
  recursive: true,
});
fs.cpSync(path.join(repoRoot, "runtime"), path.join(distDir, "lib", "runtime"), {
  recursive: true,
  // The C runtime's own test sources are not needed to compile yoop programs.
  filter: (src) => path.basename(src) !== "tests",
});

const readmeTemplate = fs.readFileSync(
  path.join(repoRoot, "packaging", "bootstrap_readme.md"),
  "utf8",
);
const readme = readmeTemplate
  .replaceAll("{{VERSION}}", version)
  .replaceAll("{{TARGET}}", target)
  .replaceAll("{{BIN}}", binName)
  .replaceAll("{{PLATFORM_HUMAN}}", PLATFORM_HUMAN);
if (readme.includes("{{")) {
  fail("README.md still contains an unsubstituted {{placeholder}}");
}
fs.writeFileSync(path.join(distDir, "README.md"), readme);

// 4. Smoke test through the packaged layout, with the overrides REMOVED. A
//    package that only works for someone who exports YOOP_STD_ROOT is a broken
//    package, and nothing above this line would notice.
step("smoke-testing the packaged binary");
const packagedBin = path.join(distDir, "bin", binName);
const smokeEnv = { ...process.env };
delete smokeEnv.YOOP_STD_ROOT;
delete smokeEnv.YOOP_RUNTIME_ROOT;

const smokeDir = path.join(repoRoot, "build", "smoke");
fs.rmSync(smokeDir, { recursive: true, force: true });
fs.mkdirSync(smokeDir, { recursive: true });
const helloSrc = path.join(repoRoot, "bootstrap", "tests", "slice", "hello.yoop");
const helloExe = path.join(smokeDir, "hello");

try {
  execFileSync(packagedBin, [helloSrc, "-o", helloExe], {
    cwd: smokeDir,
    env: smokeEnv,
    stdio: "pipe",
  });
} catch (err) {
  const detail = [err.stdout, err.stderr]
    .filter(Boolean)
    .map((b) => b.toString().trim())
    .join("\n");
  fail(`the packaged binary could not compile hello.yoop:\n\n${detail}`);
}

// Same shape the slice suite asserts: stdout, then the exit line.
let actual;
try {
  actual = `${execFileSync(helloExe, [], { encoding: "utf8" })}exit=0\n`;
} catch (err) {
  actual = `${err.stdout ?? ""}exit=${err.status}\n`;
}
const expected = fs.readFileSync(
  path.join(repoRoot, "bootstrap", "tests", "slice", "hello.expected"),
  "utf8",
);
if (actual !== expected) {
  fail(`the packaged binary compiled hello.yoop but it ran wrong.\n\nexpected:\n${expected}\ngot:\n${actual}`);
}
process.stdout.write("    ok    hello.yoop compiled and ran from the packaged layout\n");

// 5. Tarball and checksum. tar rather than zip because this is a native
//    binary for one platform and tar preserves the executable bit; zip does
//    not, and a downloaded compiler that needs chmod is a bad first minute.
//    COPYFILE_DISABLE stops bsdtar on macOS from adding ._ resource forks.
step("tarring");
const tarName = `${target}.tar.gz`;
const tarPath = path.join(repoRoot, "dist", tarName);
fs.rmSync(tarPath, { force: true });
execFileSync("tar", ["-czf", tarPath, "-C", path.join(repoRoot, "dist"), target], {
  stdio: "inherit",
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});

const digest = crypto.createHash("sha256").update(fs.readFileSync(tarPath)).digest("hex");
fs.writeFileSync(`${tarPath}.sha256`, `${digest}  ${tarName}\n`);

const tarMB = (fs.statSync(tarPath).size / 1024 / 1024).toFixed(1);
process.stdout.write(
  `\n${"=".repeat(64)}\n` +
    `bootstrap package ready\n\n` +
    `  ${tarPath}\n` +
    `  ${tarMB} MB\n\n` +
    `  version:   ${version}\n` +
    `  platform:  ${PLATFORM_HUMAN}\n` +
    `  compiler:  stage2, fixpoint-verified against stage3\n` +
    `  contents:  bin/${binName} lib/std/ lib/runtime/ README.md\n` +
    `  sha256:    ${digest}\n\n` +
    `Recipient needs clang on PATH.\n` +
    `${"=".repeat(64)}\n`,
);
