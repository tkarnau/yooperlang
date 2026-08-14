// C-level smoke tests for the yoop runtime. Each one is a tiny standalone C
// program that exercises the runtime without involving the compiler - proves
// the runtime contract independently of any LLVM IR we emit.
//
// See plans/phase-6-3-prelude.md §7.1.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runProc, runProcOrThrow } from "./testProc.js";
import { RUNTIME_C, RUNTIME_SOURCES, runtimeLinkFlags } from "./runtimeBuild.js";
import {
  EXE_SUFFIX,
  clangEnv,
  lowerLinkFlag,
  prebuiltRuntimeObjects,
  resolveClang,
  windowsClangArgs,
} from "./toolchain.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const testsDir = path.join(repoRoot, "runtime", "tests");

// These are the programs in the tree MOST likely to hang, and they are the
// reason both halves below carry a deadline. Half of them are about parking,
// cancellation and wakeup races - a missed wakeup is a thread that waits
// forever, and a lost race is a process that never reaches its exit. Without a
// deadline that used to be a test run that never finished and a process that
// stayed put; with one it is a named failure and a killed process tree.
const BUILD_TIMEOUT_MS = Number(process.env.YOOP_RUNTIMEC_BUILD_TIMEOUT_MS) || 180000;
const RUN_TIMEOUT_MS = Number(process.env.YOOP_RUNTIMEC_RUN_TIMEOUT_MS) || 60000;

async function buildAndRun(name) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_rt_"));
  // Windows will not CreateProcess an extensionless file, so the binary has
  // to be named with .exe up front rather than after the fact.
  const bin = path.join(tmpDir, name + EXE_SUFFIX);
  const linkFlagArgs = runtimeLinkFlags().flatMap(lowerLinkFlag);
  await runProcOrThrow(
    resolveClang(),
    [
      "-std=c11",
      "-O0",
      "-g",
      "-Wall",
      "-Wextra",
      "-Werror",
      // -pthread is a POSIX toolchain concept; the MSVC target rejects it and
      // yoop_platform.h uses the Win32 primitives there anyway.
      ...(process.platform === "win32" ? [] : ["-pthread"]),
      // Prebuilt objects rather than the source list: the runtime is identical
      // for all 11 of these programs, and recompiling it each time dominated
      // the suite. See prebuiltRuntimeObjects for why this cannot go stale.
      ...prebuiltRuntimeObjects(RUNTIME_SOURCES),
      path.join(testsDir, `${name}.c`),
      ...linkFlagArgs,
      "-o",
      bin,
      ...windowsClangArgs(),
    ],
    { env: clangEnv(), timeout: BUILD_TIMEOUT_MS },
  );
  try {
    const result = await runProc(bin, [], { timeout: RUN_TIMEOUT_MS });
    if (result.timedOut) {
      throw new Error(
        `${name} did not exit within ${RUN_TIMEOUT_MS}ms and was killed - ` +
          `the runtime wedged (a missed wakeup, or a shutdown that never completes)` +
          `\n${result.stdout}\n${result.stderr}`,
      );
    }
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
  } finally {
    // In a finally: the temp dir used to be removed only when the program
    // returned normally, so every wedged or crashed run left one behind.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("runtime: C-level smoke tests", () => {
  it("smoke: init/shutdown round-trips cleanly (twice, exercising re-init)", async () => {
    const { exitCode, stderr } = await buildAndRun("smoke");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
  });

  it("submit_one: a single task runs end-to-end, state flips, result is stored", async () => {
    const { exitCode, stderr } = await buildAndRun("submit_one");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
  });

  it("submit_many: 1000 tasks complete in order under queue contention", async () => {
    const { exitCode, stdout, stderr } = await buildAndRun("submit_many");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
    assert.equal(stdout, "submit_many: 1000 tasks ok\n");
  });

  it("refcount: alloc seeds rc=2, retain/release balances, pooled submit cleans up", async () => {
    const { exitCode, stdout, stderr } = await buildAndRun("refcount");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
    assert.equal(stdout, "refcount: ok\n");
  });

  it("park_unpark: pre-armed wake, cross-thread wake, and a 200-round burst all complete", async () => {
    const { exitCode, stdout, stderr } = await buildAndRun("park_unpark");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
    assert.equal(stdout, "park_unpark: ok\n");
  });

  it("sleep_ms: yoop_sleep_ms(50) elapses ~50ms (within loose CI tolerances)", async () => {
    const { exitCode, stdout, stderr } = await buildAndRun("sleep_ms");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
    assert.match(stdout, /^sleep_ms: ok/);
  });

  it("io_pipe: a thread writing one byte to a pipe wakes a yoop_io_wait_readable on the read end", async () => {
    const { exitCode, stdout, stderr } = await buildAndRun("io_pipe");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
    assert.equal(stdout, "io_pipe: ok\n");
  });

  it("cancel_token: flags, deadlines, parent/child cascade, and the blocking helpers", async () => {
    const { exitCode, stdout, stderr } = await buildAndRun("cancel_token");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
    assert.match(stdout, /cancel_token: ok\n$/);
  });

  it("io_deadline: a wait on a silent fd gives up on its deadline and frees the slot", async () => {
    const { exitCode, stdout, stderr } = await buildAndRun("io_deadline");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
    assert.match(stdout, /io_deadline: ok\n$/);
  });

  // Includes a 200-round storm that races the abandon teardown against
  // the multiplexer's delivery - the fired-under-io_mu handshake is
  // what keeps that from being a use-after-free on the parker's frame.
  it("io_cancel: a token unparks a thread blocked in the multiplexer, incl. a 200-round race", async () => {
    const { exitCode, stdout, stderr } = await buildAndRun("io_cancel");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
    assert.match(stdout, /io_cancel: ok\n$/);
  });

  // Regression: a second waiter on one (fd, direction) used to overwrite
  // the first's payload via EPOLL_CTL_MOD / EV_SET and strand it with no
  // wakeup coming. It is now refused with EAGAIN.
  it("io_fd_conflict: a second waiter on one fd is refused instead of stranding the first", async () => {
    const { exitCode, stdout, stderr } = await buildAndRun("io_fd_conflict");
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
    assert.match(stdout, /io_fd_conflict: ok\n$/);
  });
});
