// The BOOTSTRAP SEED: where a build gets its first working compiler.
//
// The compiler is written in Yoop and compiles itself, so building it needs a
// Yoop compiler that already exists. That used to be `src/yoopiler.js`, the JS
// reference implementation. It is gone, and the seed is now a PREVIOUSLY
// RELEASED `yoopiler_boot` binary - which is what most self-hosted compilers
// do, and it is why `package:boot` proves its output can compile hello.yoop
// with nothing else on the path.
//
// The cost of that choice, stated plainly: the chain has to start SOMEWHERE. A
// first-time builder with no network and no prior binary cannot bootstrap. That
// is the trade recorded in plans/removing_node.md, and `YOOP_SEED` is the way
// out for anyone who has a binary already.
//
// RESOLUTION ORDER, first hit wins:
//
//   1. $YOOP_SEED            an explicit path to a yoopiler_boot binary. This
//                            is what CI uses for a cached seed, and what a
//                            developer uses to build against a stage they just
//                            produced.
//   2. .seed/<version>/...   a previous download, kept in the repo's own
//                            gitignored cache so a second build costs nothing.
//   3. the GitHub release     downloaded and unpacked into (2).
//
// THE PINNED VERSION IS A FACT ABOUT THE TREE, not a moving target. `SEED_TAG`
// below says which release can compile THIS source, so a checkout of an old
// commit still knows its own seed. Raising it is a deliberate edit, made when
// the compiler starts using a language feature the old seed does not have -
// and the pull request that raises it is the one that has to prove the new
// seed builds the tree.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The release that can compile this tree. See the note above before changing it.
export const SEED_TAG = "v0.1.0";
export const SEED_VERSION = "0.1.0";

const EXE = process.platform === "win32" ? ".exe" : "";

// The platform slug the release archives are named by, matching what
// scripts/package_bootstrap.mjs writes.
function platformSlug() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") return `darwin-${arch}`;
  if (process.platform === "win32") return `windows-${arch}`;
  return `linux-${arch}`;
}

const cacheRoot = path.join(repoRoot, ".seed", SEED_VERSION);
const cachedBin = path.join(
  cacheRoot,
  `yoopiler-boot-${SEED_VERSION}-${platformSlug()}`,
  "bin",
  `yoopiler_boot${EXE}`,
);

// The seed binary's path, downloading it if this is the first build here.
//
// Throws with an actionable message rather than returning a path that does not
// work: every caller is a build or a test suite, and "the compiler is missing"
// has to be told apart from "the compiler is wrong".
export function seedCompiler() {
  const explicit = process.env.YOOP_SEED;
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`YOOP_SEED points at ${explicit}, which does not exist`);
    }
    return explicit;
  }
  if (fs.existsSync(cachedBin)) return cachedBin;
  download();
  if (!fs.existsSync(cachedBin)) {
    throw new Error(
      `the seed archive unpacked but ${cachedBin} is not there - the release layout changed`,
    );
  }
  return cachedBin;
}

// `gh` rather than a bare https fetch, because the release may be private while
// the repo is, and `gh` already holds the credentials for that. A checkout that
// has neither `gh` nor a seed gets told both ways out.
function download() {
  const archive = `yoopiler-boot-${SEED_VERSION}-${platformSlug()}.tar.gz`;
  fs.mkdirSync(cacheRoot, { recursive: true });
  try {
    execFileSync("gh", ["release", "download", SEED_TAG, "-p", archive, "-D", cacheRoot], {
      stdio: "inherit",
      cwd: repoRoot,
    });
  } catch (e) {
    throw new Error(
      `could not download the bootstrap seed ${SEED_TAG} (${archive}).\n` +
        `The compiler is self-hosted, so building it needs a previous release to start from.\n` +
        `Either install and authenticate the GitHub CLI (gh auth login), or point\n` +
        `YOOP_SEED at a yoopiler_boot binary you already have:\n` +
        `    YOOP_SEED=/path/to/yoopiler_boot npm test\n` +
        `Original error: ${e.message}`,
    );
  }
  execFileSync("tar", ["-xzf", path.join(cacheRoot, archive), "-C", cacheRoot], {
    stdio: "inherit",
  });
  fs.chmodSync(cachedBin, 0o755);
}

// The environment a seed (or any stage) needs to find std and the C runtime.
// Both are read from THIS tree, never from the ones packaged beside the seed:
// the seed is only there to compile today's source, and today's source imports
// today's std.
export function seedEnv(extra = {}) {
  return {
    ...process.env,
    YOOP_STD_ROOT: path.join(repoRoot, "std"),
    YOOP_RUNTIME_ROOT: path.join(repoRoot, "runtime"),
    ...extra,
  };
}

// Called as a script (`node scripts/seed.mjs`), print the path. That is what
// the shell probes use, and it makes the download a one-liner in CI.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${seedCompiler()}\n`);
}
