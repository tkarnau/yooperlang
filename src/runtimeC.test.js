// C-level smoke tests for the yoop runtime. Each one is a tiny standalone C
// program that exercises the runtime without involving the compiler — proves
// the runtime contract independently of any LLVM IR we emit.
//
// See plans/phase-6-3-prelude.md §7.1.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { RUNTIME_C, RUNTIME_SOURCES, runtimeLinkFlags } from "./runtimeBuild.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const testsDir = path.join(repoRoot, "runtime", "tests");

function buildAndRun(name) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_rt_"));
  const bin = path.join(tmpDir, name);
  const linkFlagArgs = runtimeLinkFlags().map((f) => `-l${f}`);
  execFileSync(
    "clang",
    [
      "-std=c11",
      "-O0",
      "-g",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pthread",
      ...RUNTIME_SOURCES,
      path.join(testsDir, `${name}.c`),
      ...linkFlagArgs,
      "-o",
      bin,
    ],
    { stdio: "pipe" },
  );
  const result = spawnSync(bin, [], { encoding: "utf8" });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status };
}

describe("runtime: C-level smoke tests", () => {
  it("smoke: init/shutdown round-trips cleanly (twice, exercising re-init)", () => {
    const { exitCode, stderr } = buildAndRun("smoke");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
  });

  it("submit_one: a single task runs end-to-end, state flips, result is stored", () => {
    const { exitCode, stderr } = buildAndRun("submit_one");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
  });

  it("submit_many: 1000 tasks complete in order under queue contention", () => {
    const { exitCode, stdout, stderr } = buildAndRun("submit_many");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
    assert.equal(stdout, "submit_many: 1000 tasks ok\n");
  });

  it("refcount: alloc seeds rc=2, retain/release balances, pooled submit cleans up", () => {
    const { exitCode, stdout, stderr } = buildAndRun("refcount");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
    assert.equal(stdout, "refcount: ok\n");
  });

  it("park_unpark: pre-armed wake, cross-thread wake, and a 200-round burst all complete", () => {
    const { exitCode, stdout, stderr } = buildAndRun("park_unpark");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
    assert.equal(stdout, "park_unpark: ok\n");
  });

  it("sleep_ms: yoop_sleep_ms(50) elapses ~50ms (within loose CI tolerances)", () => {
    const { exitCode, stdout, stderr } = buildAndRun("sleep_ms");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
    assert.match(stdout, /^sleep_ms: ok/);
  });

  it("io_pipe: a thread writing one byte to a pipe wakes a yoop_io_wait_readable on the read end", () => {
    const { exitCode, stdout, stderr } = buildAndRun("io_pipe");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
    assert.equal(stdout, "io_pipe: ok\n");
  });
});
