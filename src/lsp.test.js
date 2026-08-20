// The language server, driven the way an editor drives it.
//
// Everything below the protocol is covered by Yoop unit tests in
// bootstrap/src/lsp/lsp.test.yoop - the framing, the position conversion, the
// exact bytes of each message. What only a SPAWNED process can say is that the
// three fit together: that `yoopiler_boot --lsp` reads a real
// `Content-Length` frame off a pipe, compiles the buffer the notification
// carried, and writes a `publishDiagnostics` back. A unit test that never runs
// the binary is not evidence that an editor can talk to it.
//
// One server per scenario, and each scenario is a whole conversation rather
// than a single message: the interesting assertions are about ORDER (a
// diagnostic arrives after the open, an empty list arrives after the fix) and
// about a server that is still healthy several messages in.
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";

import { runProcOrThrow, trackChild, stopChild } from "./testProc.js";
import { seedCompiler, seedEnv } from "../scripts/seed.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const BOOT_SRC = path.join(REPO, "bootstrap/src/main.yoop");

const COMPILE_TIMEOUT_MS = Number(process.env.YOOP_LSP_COMPILE_TIMEOUT_MS) || 120000;
// How long one message may take to be answered. A `didOpen` answer is a whole
// typecheck of the document's import closure, so this is a hang detector with
// a wide margin rather than a budget.
const REPLY_TIMEOUT_MS = Number(process.env.YOOP_LSP_REPLY_TIMEOUT_MS) || 60000;

// A client for one server process: write framed messages, await framed
// replies. Deliberately a byte-level reader rather than a JSON stream, because
// the framing is half of what is under test.
class LspClient {
  constructor(bin, env) {
    this.child = trackChild(bin, ["--lsp"], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.buf = Buffer.alloc(0);
    this.frames = [];
    this.waiters = [];
    this.stderr = "";
    this.exited = new Promise((resolve) => {
      this.child.on("exit", (code) => resolve(code));
    });
    this.child.stdout.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
    });
    this.child.stderr.on("data", (d) => { this.stderr += d.toString(); });
  }

  drain() {
    for (;;) {
      const sep = this.buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const header = this.buf.subarray(0, sep).toString("latin1");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      assert.ok(m, `a frame with no Content-Length: ${JSON.stringify(header)}`);
      const len = Number(m[1]);
      if (this.buf.length < sep + 4 + len) return;
      const body = this.buf.subarray(sep + 4, sep + 4 + len).toString("utf8");
      this.buf = this.buf.subarray(sep + 4 + len);
      const parsed = JSON.parse(body);
      const w = this.waiters.shift();
      if (w) w(parsed); else this.frames.push(parsed);
    }
  }

  send(msg) {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  // The next frame the server produced, waiting for it if it has not arrived.
  next() {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no reply within ${REPLY_TIMEOUT_MS}ms; stderr:\n${this.stderr}`)),
        REPLY_TIMEOUT_MS,
      );
      this.waiters.push((frame) => { clearTimeout(timer); resolve(frame); });
    });
  }

  closeStdin() { this.child.stdin.end(); }
  kill() { stopChild(this.child); }
}

describe("the language server speaks LSP over stdio", () => {
  let boot;
  let work;
  let env;

  before(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "yoop-lsp-"));
    env = seedEnv();
    if (process.env.YOOP_BOOT_COMPILER) {
      boot = process.env.YOOP_BOOT_COMPILER;
      return;
    }
    boot = path.join(work, "yoopiler_boot");
    await runProcOrThrow(
      seedCompiler(),
      [BOOT_SRC, "-o", boot],
      { cwd: REPO, env: seedEnv(), timeout: COMPILE_TIMEOUT_MS },
    );
  });

  after(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });

  const BROKEN = "function main(): int32 {\n  const a: int32 = nope;\n  return 0;\n}\n";
  const CLEAN = "function main(): int32 {\n  return 0;\n}\n";
  const UNPARSEABLE = "function main(): int32 {\n  return 0\n}\n";

  it("initializes, diagnoses a document, and shuts down", async () => {
    const file = path.join(work, "broken.yoop");
    fs.writeFileSync(file, BROKEN);
    const uri = `file://${file}`;
    const client = new LspClient(boot, env);
    try {
      client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      const init = await client.next();
      assert.equal(init.id, 1);
      // Only what is implemented is advertised. A capability announced and not
      // built is a client waiting on a reply that never comes.
      assert.deepEqual(init.result.capabilities, {
        textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
      });

      client.send({ jsonrpc: "2.0", method: "initialized", params: {} });
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId: "yoop", version: 1, text: BROKEN } },
      });

      const pub = await client.next();
      assert.equal(pub.method, "textDocument/publishDiagnostics");
      assert.equal(pub.params.uri, uri);
      assert.equal(pub.params.version, 1);
      assert.equal(pub.params.diagnostics.length, 1);
      const d = pub.params.diagnostics[0];
      assert.equal(d.severity, 1);
      assert.equal(d.source, "yoopiler");
      assert.match(d.message, /unknown name "nope"/);
      // Zero-based, and on the line the error is on. `nope` is on source line
      // 2, which is line 1 to an editor.
      assert.equal(d.range.start.line, 1);
      assert.ok(d.range.end.character > d.range.start.character,
        `an empty range draws nothing: ${JSON.stringify(d.range)}`);

      // The fix. An empty diagnostics array is a real message, not an
      // omission: it is the only thing that clears the squiggle.
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: CLEAN }],
        },
      });
      const cleared = await client.next();
      assert.equal(cleared.method, "textDocument/publishDiagnostics");
      assert.equal(cleared.params.version, 2);
      assert.deepEqual(cleared.params.diagnostics, []);

      // Closing clears too, so a closed file does not sit in the problem list.
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didClose",
        params: { textDocument: { uri } },
      });
      const onClose = await client.next();
      assert.equal(onClose.method, "textDocument/publishDiagnostics");
      assert.deepEqual(onClose.params.diagnostics, []);

      client.send({ jsonrpc: "2.0", id: 2, method: "shutdown" });
      const bye = await client.next();
      assert.equal(bye.id, 2);
      assert.equal(bye.result, null);
      client.send({ jsonrpc: "2.0", method: "exit" });
      assert.equal(await client.exited, 0);
    } finally {
      client.kill();
    }
  });

  // The decision this test exists to pin: what is compiled is the buffer the
  // editor is holding, not the bytes on disk. The file below is written CLEAN
  // and opened BROKEN.
  it("diagnoses the unsaved buffer rather than the file on disk", async () => {
    const file = path.join(work, "unsaved.yoop");
    fs.writeFileSync(file, CLEAN);
    const uri = `file://${file}`;
    const client = new LspClient(boot, env);
    try {
      client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await client.next();
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId: "yoop", version: 1, text: UNPARSEABLE } },
      });
      const pub = await client.next();
      assert.equal(pub.params.uri, uri);
      assert.equal(pub.params.diagnostics.length, 1,
        `wanted the buffer's syntax error, got ${JSON.stringify(pub.params.diagnostics)}`);
      assert.equal(pub.params.diagnostics[0].severity, 1);
      // On disk this file compiles clean, so anything here proves the buffer
      // is what was read.
      assert.equal(fs.readFileSync(file, "utf8"), CLEAN);

      client.closeStdin();
      // No `shutdown`, so the protocol says the exit code is 1.
      assert.equal(await client.exited, 1);
    } finally {
      client.kill();
    }
  });

  it("answers a request it does not implement rather than leaving the client waiting", async () => {
    const client = new LspClient(boot, env);
    try {
      // Before `initialize`, every request but the lifecycle ones is refused
      // by name rather than ignored.
      client.send({ jsonrpc: "2.0", id: 7, method: "textDocument/hover", params: {} });
      const early = await client.next();
      assert.equal(early.id, 7);
      assert.equal(early.error.code, -32002);

      client.send({ jsonrpc: "2.0", id: 8, method: "initialize", params: {} });
      await client.next();
      client.send({ jsonrpc: "2.0", id: 9, method: "textDocument/completion", params: {} });
      const late = await client.next();
      assert.equal(late.id, 9);
      assert.equal(late.error.code, -32601);
      assert.match(late.error.message, /textDocument\/completion/);

      // A NOTIFICATION for the same unimplemented method must be silently
      // ignored: answering one is a protocol violation.
      client.send({ jsonrpc: "2.0", method: "$/setTrace", params: { value: "off" } });
      client.send({ jsonrpc: "2.0", id: 10, method: "shutdown" });
      const bye = await client.next();
      assert.equal(bye.id, 10, "a notification was answered, which the protocol forbids");

      client.send({ jsonrpc: "2.0", method: "exit" });
      assert.equal(await client.exited, 0);
    } finally {
      client.kill();
    }
  });

  it("keeps its place when several messages arrive in one write", async () => {
    // Two frames in one `write` is completely ordinary, and a reader that
    // scanned for the blank line instead of counting bytes would lose the
    // second. Sent as one buffer deliberately.
    const client = new LspClient(boot, env);
    try {
      const bodies = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", method: "initialized", params: {} },
        { jsonrpc: "2.0", id: 2, method: "shutdown" },
        { jsonrpc: "2.0", method: "exit" },
      ].map((m) => Buffer.from(JSON.stringify(m), "utf8"));
      const wire = Buffer.concat(
        bodies.flatMap((b) => [Buffer.from(`Content-Length: ${b.length}\r\n\r\n`), b]),
      );
      client.child.stdin.write(wire);

      const init = await client.next();
      assert.equal(init.id, 1);
      const bye = await client.next();
      assert.equal(bye.id, 2);
      assert.equal(await client.exited, 0);
    } finally {
      client.kill();
    }
  });
});
