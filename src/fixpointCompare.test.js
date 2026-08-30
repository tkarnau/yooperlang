// Tests for the stage comparison the self-hosting fixpoint is decided by.
//
// Two claims, and the whole value of the helper is that BOTH hold at once:
// identical input has to compare equal even though neither macOS nor Windows
// links it to identical bytes, and different input still has to compare
// unequal. A normalizer that only satisfied the first would pass every build
// forever.
//
// C rather than Yoop on purpose: this covers the LINKER, which is downstream of
// the compiler and shared by both languages. That keeps the test independent of
// whether a seed is available and fast enough to live in test:unit.
//
// WHAT VARIES BETWEEN TWO STAGES IS THE `-o` PATH AND NOTHING ELSE. The real
// check compiles ONE source, bootstrap/src/main.yoop, from ONE cwd, to the same
// basename in two different directories. Building the two stages from two
// different SOURCE files would not be the same test: `clang -g` records the
// source path in the debug info (`DW_AT_name`, and `DW_AT_comp_dir` for the
// cwd), so on Linux, where DWARF rides in the executable, that is a real
// difference in the bytes - the path text, plus the 20-byte GNU build-id that
// hashes over it - and the helper is right to report it. macOS hides the
// mistake rather than fixing it, because `strip -S` drops the whole debug map.
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { compareStageBinaries } from "./fixpointCompare.js";

// The source every stage below is built from. One path, written once, so the
// path clang bakes into the debug info is the same for both stages.
function sourceFile(work, text) {
  const src = path.join(work, "src", "prog.c");
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, text);
  return src;
}

// A stage: the SAME basename in a DIFFERENT directory, which is the only thing
// that varies between stage2 and stage3 in the real check.
function build(work, stage, src) {
  const outDir = path.join(work, stage);
  fs.mkdirSync(outDir, { recursive: true });
  const exe = path.join(outDir, process.platform === "win32" ? "yoopiler.exe" : "yoopiler");
  execFileSync("clang", ["-g", "-o", exe, src], { stdio: "ignore", cwd: work });
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
    const src = sourceFile(work, SAME);
    const a = build(work, "same-a", src);
    const b = build(work, "same-b", src);
    assert.equal(compareStageBinaries(a, b), "");
  });

  // One source PATH, two contents, so the machine code is the only thing that
  // differs. Two source paths would differ in their embedded debug info too,
  // which would let a normalizer that erased the code still pass this.
  it("still calls two different programs different", (t) => {
    if (!clangOk) return t.skip("clang is not on PATH");
    const a = build(work, "diff-a", sourceFile(work, SAME));
    const b = build(work, "diff-b", sourceFile(work, OTHER));
    assert.notEqual(compareStageBinaries(a, b), "");
  });

  // The reason the helper is not `Buffer.equals`. If this ever fails on macOS
  // the linker became reproducible and the normalization can be deleted; on
  // every other platform there is nothing to normalize and it is skipped.
  it("is doing real work: macOS does not link the same source to the same bytes", (t) => {
    if (!clangOk) return t.skip("clang is not on PATH");
    if (process.platform !== "darwin") return t.skip("only macOS links irreproducibly");
    const src = sourceFile(work, SAME);
    const a = build(work, "raw-a", src);
    const b = build(work, "raw-b", src);
    assert.ok(
      !fs.readFileSync(a).equals(fs.readFileSync(b)),
      "macOS linked one source to identical bytes twice - drop the normalization",
    );
  });

  // Same claim for Windows, and it fails for different reasons: link.exe
  // stamps the image with the time it ran and gives the PDB a fresh GUID, and
  // the PDB PATH it records contains the output directory - which is the one
  // thing that varies between two stages. If this ever fails, link.exe became
  // reproducible and normalizePe can go.
  it("is doing real work: Windows does not link the same source to the same bytes", (t) => {
    if (!clangOk) return t.skip("clang is not on PATH");
    if (process.platform !== "win32") return t.skip("only Windows links irreproducibly this way");
    const src = sourceFile(work, SAME);
    const a = build(work, "raw-a", src);
    const b = build(work, "raw-b", src);
    assert.ok(
      !fs.readFileSync(a).equals(fs.readFileSync(b)),
      "link.exe linked one source to identical bytes twice - drop the normalization",
    );
  });

  // The normalizer has to be NARROW as well as sufficient. Zeroing the whole
  // debug directory, or giving up and returning true, would satisfy the test
  // above and hide every real miscompile; this pins the machine code down by
  // changing one instruction and nothing else.
  it("on Windows, normalizing does not swallow a code difference", (t) => {
    if (!clangOk) return t.skip("clang is not on PATH");
    if (process.platform !== "win32") return t.skip("covers the PE normalizer");
    const a = build(work, "pe-code-a", sourceFile(work, SAME));
    const b = build(work, "pe-code-b", sourceFile(work, OTHER));
    assert.notEqual(
      compareStageBinaries(a, b),
      "",
      "normalizePe erased a real difference in the code",
    );
  });

  // The trap the fixture above is shaped to avoid, asserted rather than left in
  // a comment: on Linux the source path IS part of the binary, so a fixture
  // that gave each stage its own source file would report a difference that has
  // nothing to do with the compiler. Skipped on macOS, where `strip -S` drops
  // the debug map and with it the evidence.
  it("on Linux, moving the source path alone changes the bytes", (t) => {
    if (!clangOk) return t.skip("clang is not on PATH");
    if (process.platform !== "linux") return t.skip("DWARF rides in the executable only on ELF");
    const a = build(work, "moved-a", sourceFile(path.join(work, "moved-a-src"), SAME));
    const b = build(work, "moved-b", sourceFile(path.join(work, "moved-b-src"), SAME));
    assert.notEqual(
      compareStageBinaries(a, b),
      "",
      "clang stopped embedding the source path - the two-source fixture is no longer a trap",
    );
  });
});
