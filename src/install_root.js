// Where the yoopiler's data files (std/ and runtime/) live at run time.
//
// The compiler needs two directories that are NOT JavaScript and therefore
// can't ride along in an `import`:
//
//   std/      - the .yoop standard library, read by the module graph loader.
//   runtime/  - the C runtime translation units, handed to clang as real
//               paths. A bundler's virtual filesystem can't help here,
//               because clang is a separate process.
//
// Three layouts have to work:
//
//   repo checkout   <repo>/src/install_root.js  + <repo>/{std,runtime}
//   npm install     <pkg>/src/install_root.js   + <pkg>/{std,runtime}
//   packaged exe    <prefix>/bin/yoopiler       + <prefix>/lib/{std,runtime}
//
// The first two are the same shape (package.json's `files` list preserves the
// repo layout), so module-relative resolution covers both. The third is for a
// single-file build (Node SEA / bun compile), where module-relative paths point
// into a synthetic bundle path that doesn't exist on disk - that probe fails
// and we fall through to the executable-relative candidate.
//
// `YOOP_STD_ROOT` / `YOOP_RUNTIME_DIR` override either one, which is also the
// escape hatch for pointing a packaged binary at a working tree.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exeDir = path.dirname(process.execPath);

// Normally the directory this file lives in. In a bundled single-file build
// (esbuild -> CJS for Node SEA) `import.meta.url` has no meaning and comes
// through as undefined, so fall back to the executable - which is exactly
// what the packaged-layout candidates below are relative to anyway.
const moduleDir = (() => {
  const url = import.meta.url;
  if (typeof url === "string" && url.startsWith("file:")) {
    return path.dirname(fileURLToPath(url));
  }
  return exeDir;
})();

// Ordered most-specific first. Each is a prefix expected to CONTAIN std/ and
// runtime/ as siblings.
const CANDIDATE_PREFIXES = [
  path.resolve(moduleDir, ".."), // repo checkout / npm install
  path.resolve(exeDir, "..", "lib"), // packaged: bin/yoopiler + lib/
  path.resolve(exeDir, "lib"), // packaged, flat variant
];

function resolveRoot(envVar, dirName) {
  const override = process.env[envVar];
  if (override) return path.resolve(override);
  for (const prefix of CANDIDATE_PREFIXES) {
    const candidate = path.join(prefix, dirName);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Nothing found. Return the repo-layout path anyway so the failure surfaces
  // as an ordinary "file not found" against a path the user can read, rather
  // than as a module-load-time throw. `checkInstallRoots` upgrades that into
  // an actionable message for the driver.
  return path.join(CANDIDATE_PREFIXES[0], dirName);
}

export const STD_ROOT = resolveRoot("YOOP_STD_ROOT", "std");
export const RUNTIME_DIR = resolveRoot("YOOP_RUNTIME_DIR", "runtime");

// Non-JS files that sit next to the source in a checkout (today just the AST
// viewer's HTML template). A bundler inlines the .js around them but leaves
// these behind, so a packaged build copies them into lib/ and we probe there
// too. Same shape as resolveRoot, minus the env override - these are
// implementation detail, not something a user retargets.
export function resolveAsset(name) {
  const candidates = [
    path.join(moduleDir, name), // repo checkout / npm install: next to the source
    ...CANDIDATE_PREFIXES.slice(1).map((prefix) => path.join(prefix, name)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

// Returns an array of human-readable problems with the install, empty if the
// data directories are where we expect. The driver calls this once up front so
// a broken package fails with a pointer at the env-var override instead of a
// confusing per-import "cannot resolve" error deep in the module graph.
export function checkInstallRoots() {
  const problems = [];
  if (!fs.existsSync(STD_ROOT)) {
    problems.push(
      `standard library not found at ${STD_ROOT}\n` +
        `  set YOOP_STD_ROOT to the directory containing core/, collections/, net/, http/`,
    );
  }
  if (!fs.existsSync(RUNTIME_DIR)) {
    problems.push(
      `C runtime sources not found at ${RUNTIME_DIR}\n` +
        `  set YOOP_RUNTIME_DIR to the directory containing yoop_runtime.c`,
    );
  }
  return problems;
}
