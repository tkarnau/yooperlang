// Does the DWARF the BOOTSTRAP emits actually work in a debugger?
//
// The codegen unit tests assert the metadata's SHAPE - that a DISubprogram
// exists, that a define is tagged. That is not the same property. Both of the
// bugs this file was written after passed every shape assertion:
//
//   * a `switch` spans several lines, and the `!dbg` went on the first of them:
//     `switch i32 %t6, label %L4 [, !dbg !626`, which is a syntax error
//   * `SourceLocation.line` is 0-based and DWARF is 1-based, so every line was
//     one early - and a debugger asked to stop at line 9 STOPPED, and PRINTED
//     line 9 of the file, having actually stopped on the statement from line 10
//
// The second is the reason this file exists. An off-by-one in line numbers is
// invisible to anything that reads the IR, and invisible to a human reading
// debugger output, because the output is always a real line of a real file.
// The only way to see it is to ask the debugger where it stopped and compare
// against where the fixture says it should have.
//
// So the expected line numbers are LOOKED UP in the fixture by marker comment
// rather than written here. A test that hard-codes them agrees with the bug the
// moment someone edits the fixture.
//
// Deliberately two tests and one fixture. This is a smoke check on its way to
// something bigger, not a port of the reference's dwarf suite.
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";

import { runProc, runProcOrThrow } from "./testProc.js";
import { seedCompiler, seedEnv } from "../scripts/seed.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURE = path.join(REPO, "bootstrap/tests/debug/frames.yoop");
const BOOT_SRC = path.join(REPO, "bootstrap/src/main.yoop");

const COMPILE_TIMEOUT_MS = Number(process.env.YOOP_DEBUG_COMPILE_TIMEOUT_MS) || 120000;
// A debugger that wedges is the failure mode worth bounding here: `run` starts
// the DEBUGGEE as a grandchild, and only the tree kill in testProc.js reaches
// one of those.
const DEBUG_TIMEOUT_MS = Number(process.env.YOOP_DEBUG_TIMEOUT_MS) || 60000;

// The 1-based line carrying `// MARK: <name>`, which is what the debugger
// should report. Looked up rather than written down - see the header.
function markerLine(name) {
  const lines = fs.readFileSync(FIXTURE, "utf8").split("\n");
  const at = lines.findIndex((l) => l.includes(`MARK: ${name}`));
  assert.ok(at >= 0, `no "// MARK: ${name}" in ${FIXTURE}`);
  return at + 1;
}

// gdb or lldb, whichever is here. Neither is a build dependency, so the suite
// skips rather than fails when the machine has no debugger.
let debuggerMemo;
function findDebugger() {
  if (debuggerMemo !== undefined) return debuggerMemo;
  if (process.platform === "win32") {
    debuggerMemo = { skip: "debug info on the MSVC target is CodeView, not DWARF" };
    return debuggerMemo;
  }
  for (const name of ["gdb", "lldb"]) {
    const probe = spawnSync("which", [name], { encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" });
    if (probe.status === 0) {
      debuggerMemo = { name };
      return debuggerMemo;
    }
  }
  debuggerMemo = { skip: "neither gdb nor lldb is on PATH" };
  return debuggerMemo;
}

// One batch session, as whichever debugger is present. Returns everything it
// said; the assertions look for a file and a line in it rather than matching a
// particular debugger's phrasing.
async function debugSession(name, binPath, commands) {
  const args = name === "gdb"
    // debuginfod would otherwise try the network on a machine that has it
    // configured, which turns a 200ms test into a timeout.
    ? ["-batch", "-ex", "set debuginfod enabled off", ...commands.flatMap((c) => ["-ex", c]), binPath]
    : ["--batch", ...commands.flatMap((c) => ["-o", c]), "-o", "quit", binPath];
  const out = await runProc(name, args, { cwd: REPO, timeout: DEBUG_TIMEOUT_MS });
  return `${out.stdout ?? ""}${out.stderr ?? ""}`;
}

describe("dwarf: a debugger can read what the bootstrap emits", () => {
  let work;
  let binPath;

  before(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "yoop-debug-"));
    // Same knob the slice suite has, and for the same reason: it is how a
    // SELF-HOSTED stage gets tested rather than the one the JS compiler built.
    let boot = process.env.YOOP_BOOT_COMPILER;
    if (!boot) {
      boot = path.join(work, "yoopiler_boot");
      await runProcOrThrow(
        seedCompiler(),
        [BOOT_SRC, "-o", boot],
        { cwd: REPO, env: seedEnv(), timeout: COMPILE_TIMEOUT_MS },
      );
    }
    binPath = path.join(work, "frames");
    // No `-g` to pass: the bootstrap emits DWARF unconditionally and its clang
    // line already keeps it. That is itself part of what this asserts.
    await runProcOrThrow(
      boot,
      [FIXTURE, "-o", binPath],
      {
        cwd: REPO,
        timeout: COMPILE_TIMEOUT_MS,
        env: { ...process.env, YOOP_RUNTIME_ROOT: path.join(REPO, "runtime") },
      },
    );
  });

  // Every run of this suite used to leave its temp dir behind - `mkdtempSync`
  // makes a new one each time and nothing removed it. One session of iterating
  // left 9,882 of them and filled a 16G tmpfs, which surfaces as a LINK failure
  // in whatever runs next ("No space left on device") rather than as anything
  // pointing here.
  after(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });


  // No process is started here, so this one works even where launching a
  // debuggee needs a permission the machine has not granted.
  it("resolves `main` to the .yoop line it is declared on", async (t) => {
    const found = findDebugger();
    if (found.skip) { t.skip(found.skip); return; }
    const want = markerLine("main");
    const text = await debugSession(
      found.name,
      binPath,
      found.name === "gdb" ? ["info line main"] : ["image lookup -n main -v"],
    );
    assert.match(text, /frames\.yoop/, `the debugger never mentioned the .yoop source:\n${text}`);
    // The two spell it differently and neither is worth normalizing: gdb says
    // `Line 28 of "frames.yoop"` and lldb says `frames.yoop:28`.
    const wantsLine = found.name === "gdb"
      ? new RegExp(`Line ${want} of "frames\\.yoop"`)
      : new RegExp(`frames\\.yoop:${want}\\b`);
    assert.match(text, wantsLine, `wanted main at frames.yoop:${want}, got:\n${text}`);
  });

  // The launching half: stop somewhere, and prove BOTH the stop and the caller
  // are described by the lines the fixture says they are.
  it("stops on the right statement and unwinds to the right caller", async (t) => {
    const found = findDebugger();
    if (found.skip) { t.skip(found.skip); return; }
    const stopAt = markerLine("breakpoint");
    const callsite = markerLine("callsite");
    const commands = found.name === "gdb"
      ? [`break frames.yoop:${stopAt}`, "run", "bt"]
      : [`breakpoint set --file frames.yoop --line ${stopAt}`, "run", "bt"];
    const text = await debugSession(found.name, binPath, commands);

    assert.match(
      text,
      new RegExp(`frames\\.yoop:${stopAt}\\b`),
      `the debugger did not stop at frames.yoop:${stopAt}:\n${text}`,
    );
    // The caller's frame, which is the half a wrong scope would break: a
    // backtrace that names only the innermost frame still looks plausible.
    assert.match(
      text,
      new RegExp(`frames\\.yoop:${callsite}\\b`),
      `the backtrace did not reach the caller at frames.yoop:${callsite}:\n${text}`,
    );
  });

  // The type side. Frames and lines come from the subprogram and the line
  // table; VALUES need a DILocalVariable and a description of the layout
  // codegen actually emitted, and each of these four exercises a different
  // piece of that. Any one of them can be silently absent while the rest work.
  it("reads a struct, a string, an array and a variant tag by value", async (t) => {
    const found = findDebugger();
    if (found.skip) { t.skip(found.skip); return; }
    const stopAt = markerLine("locals");
    const commands = found.name === "gdb"
      ? [`break frames.yoop:${stopAt}`, "run", "print pt", "print who", "print nums", "print shape"]
      : [
          `breakpoint set --file frames.yoop --line ${stopAt}`, "run",
          "frame variable pt", "frame variable who", "frame variable nums", "frame variable shape",
        ];
    const text = await debugSession(found.name, binPath, commands);

    // A struct by fields, not as an address.
    assert.match(text, /x = 3/, `no struct fields in:\n${text}`);
    assert.match(text, /y = 4/, `no struct fields in:\n${text}`);
    // A `string` is a typedef over char*, which is what makes a debugger print
    // the TEXT rather than the pointer.
    assert.match(text, /"tom"/, `the string printed as an address, not text:\n${text}`);
    // An array is the two-word fat pointer, so its length is readable.
    assert.match(text, /len = 3/, `no array length in:\n${text}`);
    // And the variant's tag is an enumeration, so it prints by NAME. `tag = 1`
    // would mean the enumerators never made it.
    assert.match(text, /tag = Rect/, `the variant tag did not print by name:\n${text}`);
  });
});
