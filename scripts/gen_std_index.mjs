// Regenerate std/INDEX.md.
//
//     npm run gen:index
//
// The generator itself is written in Yoop (tools/stdindex/main.yoop), the same
// way tools/yoopdist is. This wrapper only compiles it and runs it, because
// npm cannot do either on its own. Keeping the logic on the Yoop side is
// deliberate: it dogfoods the language on a real file-and-string task, which is
// how `&&` was found to be non-short-circuiting.
//
// Requires clang on PATH, like every other compile in this repo.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tool = path.join(repoRoot, "tools/stdindex/main.yoop");
const outFile = path.join(repoRoot, "std/INDEX.md");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_stdindex_"));
const bin = path.join(tmpDir, "stdindex" + (process.platform === "win32" ? ".exe" : ""));

try {
  execFileSync(
    process.execPath,
    [path.join(repoRoot, "src/yoopiler.js"), tool, "-o", bin],
    { stdio: "inherit", cwd: repoRoot },
  );
  // Run from the repo root: the tool takes the std directory and the output
  // path as ordinary relative paths.
  execFileSync(bin, ["std", "std/INDEX.md"], { stdio: "inherit", cwd: repoRoot });
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (!fs.existsSync(outFile)) {
  console.error("gen:index: expected std/INDEX.md to exist afterwards");
  process.exit(1);
}
