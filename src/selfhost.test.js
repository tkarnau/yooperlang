// The self-hosting fixpoint: the bootstrap compiles ITSELF, twice, to the same
// thing.
//
//   stage1   bootstrap/src, compiled by the JS reference
//   stage2   bootstrap/src, compiled by stage1
//   stage3   bootstrap/src, compiled by stage2
//
// stage2 and stage3 must be byte-identical. stage1 and stage2 are NOT expected
// to be - they were built by two different compilers - but stage2 and stage3
// were both built by a compiler whose source is the same, so any difference
// between them means stage1 and stage2 disagree about how to compile something.
// That is the whole value of the check: it is a full-compiler differential test
// over 30k lines of real Yoop, and it catches exactly the class of bug a unit
// test cannot, where a miscompile only shows up in the compiler the compiler
// built. It found two on the day it first passed - a variant-typed struct field
// read compiled as a variant constructor, and a max-value `usize` sentinel that
// the JS reference silently wraps to zero.
//
// The two stages are written to DIFFERENT DIRECTORIES with the SAME BASENAME on
// purpose. clang embeds the output path in the Mach-O and in the code signature
// it covers, so `-o stage2` and `-o stage3` differ in 49 bytes that have
// nothing to do with the compiler. The emitted `.ll` is compared too, and it is
// the stronger assertion of the two: that IS the compiler's output, and clang
// is downstream of it.
import { describe, it, before } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";

import { runProcOrThrow } from "./testProc.js";

const REPO = path.resolve(import.meta.dirname, "..");
const BOOT_SRC = path.join(REPO, "bootstrap/src/main.yoop");
const HELLO = path.join(REPO, "bootstrap/tests/slice/hello.yoop");

describe("self-hosting: the bootstrap compiles itself to a fixpoint", () => {
  let work;
  let stage1;
  let stage2;
  let stage3;
  const env = {
    ...process.env,
    YOOP_STD_ROOT: path.join(REPO, "std"),
    YOOP_RUNTIME_ROOT: path.join(REPO, "runtime"),
  };

  // Each stage builds the whole compiler and shells out to clang to link it, so
  // every one of these is a two-deep process tree. They run through
  // src/testProc.js for the deadline and for the process-TREE kill: killing a
  // stage that wedged mid-build would otherwise leave its clang behind.
  const BUILD_TIMEOUT_MS = Number(process.env.YOOP_SELFHOST_TIMEOUT_MS) || 300000;

  before(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "yoop-selfhost-"));
    for (const d of ["s1", "s2", "s3"]) fs.mkdirSync(path.join(work, d));
    stage1 = path.join(work, "s1/yoopiler");
    stage2 = path.join(work, "s2/yoopiler");
    stage3 = path.join(work, "s3/yoopiler");

    const opts = { cwd: REPO, env, timeout: BUILD_TIMEOUT_MS };
    await runProcOrThrow("node", [path.join(REPO, "src/yoopiler.js"), BOOT_SRC, "-o", stage1], opts);
    await runProcOrThrow(stage1, [BOOT_SRC, "-o", stage2], opts);
    await runProcOrThrow(stage2, [BOOT_SRC, "-o", stage3], opts);
  });

  it("stage1 - the JS reference builds the bootstrap", () => {
    assert.ok(fs.existsSync(stage1), "stage1 was not produced");
  });

  it("stage2 - the bootstrap builds itself", () => {
    assert.ok(fs.existsSync(stage2), "stage2 was not produced");
  });

  it("stage3 - the compiler the bootstrap built builds it again", () => {
    assert.ok(fs.existsSync(stage3), "stage3 was not produced");
  });

  it("stage2 and stage3 emit byte-identical IR", () => {
    const a = fs.readFileSync(`${stage2}.ll`);
    const b = fs.readFileSync(`${stage3}.ll`);
    assert.ok(
      a.equals(b),
      "stage2 and stage3 emit different IR - stage1 and stage2 disagree about how to compile something; diff the two .ll files",
    );
  });

  it("stage2 and stage3 are byte-identical binaries", () => {
    const a = fs.readFileSync(stage2);
    const b = fs.readFileSync(stage3);
    assert.ok(a.equals(b), "stage2 and stage3 differ as binaries");
  });

  it("stage3 is a working compiler", async () => {
    const exe = path.join(work, "hello");
    await runProcOrThrow(stage3, [HELLO, "-o", exe], { cwd: REPO, env, timeout: BUILD_TIMEOUT_MS });
    const { stdout: out } = await runProcOrThrow(exe, [], { timeout: 10000 });
    const expected = fs.readFileSync(
      path.join(REPO, "bootstrap/tests/slice/hello.expected"),
      "utf8",
    );
    assert.equal(`${out}exit=0\n`, expected);
  });
});
