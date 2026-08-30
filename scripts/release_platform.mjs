// Build THIS platform's bootstrap archive and upload it to an existing release.
//
// CI releases the Linux archive on a `v*` tag (.github/workflows/ci.yml). The
// other two platforms have no hosted runner here, so they are built on a real
// machine of that kind and uploaded to the release the tag already made. This
// script is that step, and it is the same script on macOS and on Windows:
// everything that varies is already inside scripts/package_bootstrap.mjs.
//
//   node scripts/release_platform.mjs v0.3.0
//   node scripts/release_platform.mjs v0.3.0 --dry-run
//
// What it refuses to do, and why each one is worth a refusal rather than a
// warning:
//
//   * upload from a tree that is not the tag. The archive would carry a version
//     it was not built from, which is the one thing a release must never lie
//     about. `--allow-dirty` exists for a genuine emergency and says so in the
//     output.
//   * upload an asset that is already there. A silent overwrite would replace a
//     binary other people have already seeded from. `--clobber` is the explicit
//     way to say that is what you mean.
//   * upload without the fixpoint having passed. That check lives in
//     package_bootstrap.mjs and a failure there stops this script before `gh`
//     is ever reached.
//
// The release must already EXIST - this adds a platform to it rather than
// creating it. Pushing the tag is what creates it, through CI.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const tag = argv.find((a) => !a.startsWith("--"));
const dryRun = argv.includes("--dry-run");
const allowDirty = argv.includes("--allow-dirty");
const clobber = argv.includes("--clobber");

function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

function step(msg) {
  process.stdout.write(`\n==> ${msg}\n`);
}

function capture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: repoRoot, encoding: "utf8", ...opts }).trim();
}

if (!tag) {
  fail(
    "usage: node scripts/release_platform.mjs <tag> [--dry-run] [--clobber] [--allow-dirty]\n" +
      "  <tag>  the release to add this platform to, e.g. v0.3.0",
  );
}
if (!/^v\d/.test(tag)) {
  fail(`"${tag}" does not look like a release tag - they are spelled v0.3.0`);
}
const version = tag.replace(/^v/, "");

// ---- the machine can do this at all ---------------------------------------
step("checking the toolchain");
for (const [tool, why] of [
  ["clang", "links every stage, and the recipient needs it too"],
  ["gh", "uploads the archive, and downloads the seed when there is no cache"],
  ["tar", "packs the archive"],
]) {
  try {
    execFileSync(tool, ["--version"], { stdio: "ignore" });
    process.stdout.write(`    ok    ${tool}\n`);
  } catch {
    fail(`${tool} is not on PATH. It ${why}.`);
  }
}

// gh being installed is not gh being logged in, and the difference only shows
// up at the upload, after several minutes of building.
try {
  execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
  process.stdout.write("    ok    gh is authenticated\n");
} catch {
  fail("gh is installed but not authenticated. Run: gh auth login");
}

// ---- the tree is the tag ---------------------------------------------------
step(`checking the working tree is ${tag}`);
let tagSha;
try {
  // stderr silenced: for an unknown ref git prints advice about using `--` to
  // separate paths from revisions, which on top of this script's own message is
  // noise rather than help.
  tagSha = capture("git", ["rev-list", "-n", "1", tag], { stdio: ["ignore", "pipe", "ignore"] });
} catch {
  fail(
    `the tag ${tag} does not exist locally.\n` +
      `  git fetch --tags   (the release is made by PUSHING the tag, which runs CI)`,
  );
}
const headSha = capture("git", ["rev-parse", "HEAD"]);
if (headSha !== tagSha) {
  fail(
    `HEAD is not ${tag}.\n` +
      `  HEAD  ${headSha}\n` +
      `  ${tag}  ${tagSha}\n` +
      `  git checkout ${tag}\n` +
      `An archive built anywhere else would carry a version it was not built from.`,
  );
}

const dirty = capture("git", ["status", "--porcelain"]);
if (dirty) {
  if (!allowDirty) {
    fail(
      `the working tree has uncommitted changes, so what would be built is not ${tag}:\n\n${dirty}\n\n` +
        `Commit or stash them. --allow-dirty overrides this, and should be rare enough to explain.`,
    );
  }
  process.stdout.write("    WARNING: building a DIRTY tree because --allow-dirty was passed\n");
}
process.stdout.write(`    ok    HEAD is ${tag}\n`);

// ---- the release exists, and does not already have this platform ----------
const target = `yoopiler-boot-${version}-${process.platform}-${process.arch}`;
const tarName = `${target}.tar.gz`;

step(`checking the ${tag} release`);
let assets;
try {
  assets = JSON.parse(capture("gh", ["release", "view", tag, "--json", "assets"])).assets.map(
    (a) => a.name,
  );
} catch {
  fail(
    `there is no ${tag} release to upload to.\n` +
      `  Push the tag first - CI creates the release and attaches the Linux archive:\n` +
      `      git push origin ${tag}`,
  );
}
if (assets.includes(tarName) && !clobber) {
  fail(
    `${tarName} is already attached to ${tag}.\n` +
      `  Someone may already have seeded from it, so this will not replace it silently.\n` +
      `  Pass --clobber if replacing it is what you mean.`,
  );
}
process.stdout.write(`    ok    ${tag} exists, ${assets.length} asset(s) attached\n`);

// ---- build ----------------------------------------------------------------
// package_bootstrap.mjs does the whole job: three stages, the fixpoint, the
// packaged layout, a smoke test through it, the tarball and the checksum. A
// failure anywhere in there stops the release.
step(`building ${target}`);
execFileSync("node", [path.join("scripts", "package_bootstrap.mjs"), "--version", version], {
  cwd: repoRoot,
  stdio: "inherit",
});

const tarPath = path.join(repoRoot, "dist", tarName);
const sumPath = `${tarPath}.sha256`;
for (const f of [tarPath, sumPath]) {
  if (!fs.existsSync(f)) fail(`the build reported success but ${f} is not there`);
}

// ---- upload ---------------------------------------------------------------
if (dryRun) {
  process.stdout.write(
    `\n${"=".repeat(64)}\n` +
      `DRY RUN - nothing was uploaded\n\n` +
      `  would attach to ${tag}:\n` +
      `    ${tarName}\n` +
      `    ${tarName}.sha256\n` +
      `${"=".repeat(64)}\n`,
  );
  process.exit(0);
}

step(`uploading to ${tag}`);
const uploadArgs = ["release", "upload", tag, tarPath, sumPath];
if (clobber) uploadArgs.push("--clobber");
execFileSync("gh", uploadArgs, { cwd: repoRoot, stdio: "inherit" });

const digest = fs.readFileSync(sumPath, "utf8").trim();
process.stdout.write(
  `\n${"=".repeat(64)}\n` +
    `attached to ${tag}\n\n` +
    `  ${tarName}\n` +
    `  ${digest}\n\n` +
    `  https://github.com/tkarnau/yooperlang/releases/tag/${tag}\n` +
    `${"=".repeat(64)}\n`,
);
