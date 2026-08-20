// Every child process the JS test suites start goes through here.
//
// Why this file exists. The suites shell out constantly - a compiler, a clang,
// a freshly linked executable, a driver running a test binary of its own - and
// every one of those spawns had at least one way to outlive the run:
//
//   - no timeout at all, so a compiler stuck in a loop burns a core forever and
//     the suite waits for it forever,
//   - a kill that names ONE pid, when the thing that actually burns the CPU is
//     a GRANDCHILD (the compiler's clang, the driver's test binary, lldb's
//     debuggee) that a single-pid kill cannot reach,
//   - no cleanup when the run itself is interrupted, so every child in flight
//     is orphaned at once.
//
// The symptom is slow: a handful of survivors per suite run, doing real work
// with nobody left to read the result, until a day of edit-verify loops has
// eaten the machine. So the rules here are absolute rather than best-effort:
//
//   1. EVERY child gets a deadline. There is no way to spawn without one.
//   2. Every kill is a TREE kill: descendants first, then the child, so the
//      clang under a compiler and the test binary under the driver go too.
//   3. Every live child is tracked, and an interrupted run kills the tracked
//      set before it exits.
//   4. stdin is /dev/null, never a pipe nobody writes to. A program that reads
//      stdin gets EOF and exits instead of blocking forever.
//
// A note on what is deliberately NOT done here, because it looks like the
// obvious answer and it is a trap. `detached: true` puts each child in its own
// process group, which makes killing grandchildren a one-line `kill(-pid)`.
// It also makes those children SURVIVE a group-directed kill of the test run -
// measured, not assumed: same-group child dies with `kill -9 -<pgid>`, detached
// child does not. Since the common way a run ends badly is exactly a
// group-directed kill from a terminal or a tool wrapper, detaching would trade
// one leak for a worse one. Children stay in the runner's group, and the tree
// walk below does the job the group kill would have done.
//
// The one case nothing here can cover is the test process being SIGKILLed on
// its own, without its group - then its children are orphaned with no handler
// left to run. A group-directed SIGKILL, which is what a terminal or a tool
// wrapper sends, takes the children with it precisely BECAUSE they were not
// detached. See the survivor check in CLAUDE.md.
import { spawn, spawnSync } from "node:child_process";

// The deadline every child gets unless its caller sets a shorter one. Long
// enough for the slowest thing any suite legitimately does (the ~9s
// `--test bootstrap/src` build, the ~5s bootstrap rebuild, a cold clang on a
// loaded machine) and short enough that a hang is a test failure inside one
// coffee refill rather than an all-day CPU tax.
export const DEFAULT_TIMEOUT_MS =
  Number(process.env.YOOP_TEST_PROC_TIMEOUT_MS) || 120000;

// After the deadline: SIGTERM first so a program with a shutdown path gets to
// take it, SIGKILL to the tree shortly after so one that ignores SIGTERM does
// not get a vote.
const TERM_GRACE_MS = 2000;

// `close` fires when the child has exited AND its stdio pipes have reached EOF.
// A grandchild that inherited those pipes holds them open after the child is
// gone, so `close` alone can wait forever on a process that already died. Wait
// this long after `exit`, then take the tree and settle anyway.
const DRAIN_GRACE_MS = 5000;

const live = new Set();
let netInstalled = false;

// Every live descendant of `pid`, breadth first. `pgrep -P` is the portable
// way to ask, and this only ever runs on a kill path, so its cost is paid when
// something has already gone wrong.
function descendants(pid) {
  const found = [];
  const queue = [pid];
  while (queue.length) {
    const p = queue.shift();
    const r = spawnSync("pgrep", ["-P", String(p)], {
      encoding: "utf8",
      timeout: 5000,
    });
    const kids = String(r.stdout ?? "")
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 1);
    found.push(...kids);
    queue.push(...kids);
  }
  return found;
}

// Kill a child AND everything it started.
//
// Descendants go FIRST and the child last, because killing the child first
// reparents its children to pid 1 and loses the only handle on them. Two
// passes: the second catches anything the child spawned while the first was
// walking. Best effort by nature - a tree walk cannot be atomic - but every
// tree this file kills is two or three deep and stops growing the moment its
// root is gone.
export function killTree(child, signal = "SIGKILL") {
  if (!child || typeof child.pid !== "number") return;
  if (process.platform === "win32") {
    // Windows has no process groups to walk; taskkill /t is the tree kill.
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } catch { /* already gone */ }
    return;
  }
  for (let pass = 0; pass < 2; pass++) {
    const kin = descendants(child.pid);
    if (kin.length === 0) break;
    for (const pid of kin) {
      try { process.kill(pid, signal); } catch { /* already gone */ }
    }
  }
  try {
    child.kill(signal);
  } catch { /* already reaped */ }
}

function killEveryone() {
  for (const child of live) killTree(child, "SIGKILL");
  live.clear();
}

// The interrupted-run net. `exit` covers a normal end, a thrown assertion and
// an uncaught exception; the signal handlers cover Ctrl-C and a runner that
// terminates its file children. Signal listeners do not hold the event loop
// open, so installing them cannot make a suite hang.
function installSafetyNet() {
  if (netInstalled) return;
  netInstalled = true;
  process.on("exit", killEveryone);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGBREAK"]) {
    try {
      process.on(sig, () => {
        killEveryone();
        process.exit(sig === "SIGINT" ? 130 : 1);
      });
    } catch { /* signal not supported on this platform */ }
  }
}

// Start a child that the caller manages itself - a helper server that has to
// outlive one await. It is tracked like any other, so an interrupted run still
// takes it down; `stopChild` is how the caller ends it.
export function trackChild(cmd, args = [], opts = {}) {
  installSafetyNet();
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  live.add(child);
  return child;
}

export function stopChild(child) {
  live.delete(child);
  killTree(child, "SIGKILL");
}

// Run a child to completion and resolve with what it produced.
//
// A non-zero exit is DATA, not an error - plenty of fixtures assert on a
// failing exit code. Both `code` and `status` name the same number, because the
// two suites that share this helper grew up around `spawn` and `spawnSync`
// respectively and neither spelling is worth a churn commit.
//
// Death by SIGNAL gives a null code and a set `signal`, and a deadline gives
// `timedOut: true` on top of that, so a caller can tell "the program crashed"
// from "the program never finished" without guessing.
export function runProc(cmd, args = [], opts = {}) {
  installSafetyNet();
  const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        // Never a pipe: a program that reads stdin must see EOF, not block.
        stdio: ["ignore", "pipe", "pipe"],
        // Deliberately NOT detached - see the header. Same process group as the
        // runner, so a group-directed kill of the run reaches this too.
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        stdout: "", stderr: `spawn failed: ${err?.message ?? err}\n`,
        code: null, status: null, signal: null, timedOut: false, spawnError: err,
      });
      return;
    }
    live.add(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    let deadlineTimer = null;
    let killTimer = null;
    let drainTimer = null;

    const settle = (code, signal, sweepTree) => {
      if (settled) return;
      settled = true;
      for (const t of [deadlineTimer, killTimer, drainTimer]) if (t) clearTimeout(t);
      live.delete(child);
      // Sweep only when something is actually suspected of being left behind.
      // A clean `close` means the pipes reached EOF, which means nothing
      // inherited them, and the tree walk costs a `pgrep` per child - not worth
      // paying 280 times a slice run for an answer already known to be empty.
      if (sweepTree) killTree(child, "SIGKILL");
      // Drop the handles either way: a lingering readable stream on a pipe a
      // grandchild still holds would keep this process alive.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve({ stdout, stderr, code, status: code, signal, timedOut, spawnError });
    };

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    child.on("error", (err) => {
      spawnError = err;
      stderr += `spawn failed: ${err.message}\n`;
      settle(null, null, false);
    });

    child.on("exit", (code, signal) => {
      // `settled` in the guard because `close` is not strictly ordered after
      // `exit`; without it a timer set here would hold the event loop open for
      // its full grace period after the result was already delivered.
      if (settled || drainTimer) return;
      drainTimer = setTimeout(() => settle(code, signal, true), DRAIN_GRACE_MS);
    });

    child.on("close", (code, signal) => settle(code, signal, false));

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        stderr += `\n[testProc] no exit after ${timeoutMs}ms; killing the process tree\n`;
        killTree(child, "SIGTERM");
        killTimer = setTimeout(() => killTree(child, "SIGKILL"), TERM_GRACE_MS);
        // Last resort: a tree walk cannot make a pipe EOF if something outside
        // the tree holds it, so stop waiting rather than hang forever.
        drainTimer = setTimeout(
          () => settle(null, "SIGKILL", true),
          TERM_GRACE_MS + DRAIN_GRACE_MS,
        );
      }, timeoutMs);
    }
  });
}

// runProc for the call sites that used execFileSync and relied on its throw.
// The message names WHY - exited, killed, or never finished - because "command
// failed" over a timeout sends the reader looking for a compile error that is
// not there.
export async function runProcOrThrow(cmd, args = [], opts = {}) {
  const r = await runProc(cmd, args, opts);
  if (r.code === 0) return r;
  const how = r.timedOut
    ? `never finished (killed after ${opts.timeout ?? DEFAULT_TIMEOUT_MS}ms)`
    : r.signal
      ? `was killed by ${r.signal}`
      : `exited ${r.code}`;
  const err = new Error(`${cmd} ${args.join(" ")} ${how}\n${r.stderr}`);
  err.stdout = r.stdout;
  err.stderr = r.stderr;
  err.status = r.code;
  err.timedOut = r.timedOut;
  throw err;
}
