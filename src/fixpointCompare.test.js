// Tests for the stage comparison the self-hosting fixpoint is decided by.
//
// Two claims, and the whole value of the helper is that BOTH hold at once:
// identical input has to compare equal even though macOS does not link it to
// identical bytes, and different input still has to compare unequal. A
// normalizer that only satisfied the first would pass every build forever.
//
// C rather than Yoop on purpose: this covers the LINKER, which is downstream of
// the compiler and shared by both languages. That keeps the test independent of
// whether a seed is available and fast enough to live in test:unit.
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { compareStageBinaries } from "./fixpointCompare.js";

// The two stages of the real check differ in their DIRECTORY, never their
// basename, because the output path is embedded in the image. Mirrored here.
function build(work, dir, source) {
  const outDir = path.join(work, dir);
  fs.mkdirSync(outDir, { recursive: true });
  const src = path.join(outDir, "prog.c");
  const exe = path.join(outDir, "prog");
  fs.writeFileSync(src, source);
  execFileSync("clang", ["-g", "-o", exe, src], { stdio: "ignore" });
  return exe;
}

const SAME = "int main(void) { return 0; }\n";
const OTHER = "int main(void) { return 1; }\n";

describe("comparing two linked stages", () => {
  let work;
  let clangOk = true;

  before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "yoop-fixcmp-"));
    try {
      execFileSync("clang", ["--version"], { stdio: "ignore" });
    } catch {
      clangOk = false;
    }
  });

  after(() => fs.rmSync(work, { recursive: true, force: true }));

  it("calls two links of the same source the same binary", (t) => {
    if (!clangOk) return t.skip("clang is not on PATH");
    const a = build(work, "same-a", SAME);
    const b = build(work, "same-b", SAME);
    assert.equal(compareStageBinaries(a, b), "");
  });

  it("still calls two different programs different", (t) => {
    if (!clangOk) return t.skip("clang is not on PATH");
    const a = build(work, "diff-a", SAME);
    const b = build(work, "diff-b", OTHER);
    assert.notEqual(compareStageBinaries(a, b), "");
  });

  // The reason the helper is not `Buffer.equals`. If this ever fails on macOS
  // the linker became reproducible and the normalization can be deleted; on
  // every other platform there is nothing to normalize and it is skipped.
  it("is doing real work: macOS does not link the same source to the same bytes", (t) => {
    if (!clangOk) return t.skip("clang is not on PATH");
    if (process.platform !== "darwin") return t.skip("only macOS links irreproducibly");
    const a = build(work, "raw-a", SAME);
    const b = build(work, "raw-b", SAME);
    assert.ok(
      !fs.readFileSync(a).equals(fs.readFileSync(b)),
      "macOS linked one source to identical bytes twice - drop the normalization",
    );
  });
});
