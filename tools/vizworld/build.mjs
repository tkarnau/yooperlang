// Build (or test) the vizworld renderer.
//
//   npm run viz:build     compile main.yoop -> build/vizworld/vizworld
//   npm run viz:test      run the pure modules' *.test.yoop suites
//
// The compiler is resolved the way the whole tree resolves one: the dev
// build if it exists, else the seed - and YOOP_BOOT_COMPILER overrides both,
// which is how a freshly built stage gets exercised. Linking needs SDL2 and
// OpenGL development libraries; the error from clang names whichever is
// missing.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedCompiler, seedEnv } from "../../scripts/seed.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function resolveCompiler() {
  if (process.env.YOOP_BOOT_COMPILER) return process.env.YOOP_BOOT_COMPILER;
  const dev = path.join(repoRoot, "build", "dev", "bin", "yoopiler_boot");
  if (fs.existsSync(dev)) return dev;
  return seedCompiler();
}

const mode = process.argv[2] === "--test" ? "test" : "build";
const compiler = resolveCompiler();

if (mode === "test") {
  const r = spawnSync(compiler, ["--test", path.join(repoRoot, "tools", "vizworld")], {
    stdio: "inherit",
    env: seedEnv(),
  });
  process.exit(r.status ?? 1);
}

const outDir = path.join(repoRoot, "build", "vizworld");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "vizworld");
const r = spawnSync(compiler, [path.join(here, "main.yoop"), "-o", out], {
  stdio: "inherit",
  env: seedEnv(),
});
if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);
console.error(`vizworld renderer: ${out}`);
