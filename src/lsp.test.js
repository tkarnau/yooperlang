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
import { pathToFileURL } from "node:url";

// The URI an editor would actually send for `file`.
//
// Not `file://` + the path. That happens to read correctly on POSIX and is
// simply wrong on Windows, where an absolute path starts with a drive letter:
// it produces `file://C:\\dir\\x.yoop`, which has the drive as its HOST and
// backslashes in a place the grammar does not allow them. Every one of these
// tests would then be asserting against a URI no client emits. pathToFileURL
// is Node's implementation of the same rule the LSP clients use.
const uriFor = (file) => pathToFileURL(file).href;
import fs from "fs";
import path from "path";
import os from "os";

import { runProcOrThrow, trackChild, stopChild } from "./testProc.js";
import { EXE_SUFFIX } from "./toolchain.js";
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
    boot = path.join(work, `yoopiler_boot${EXE_SUFFIX}`);
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
    const uri = uriFor(file);
    const client = new LspClient(boot, env);
    try {
      client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      const init = await client.next();
      assert.equal(init.id, 1);
      // Only what is implemented is advertised. A capability announced and not
      // built is a client waiting on a reply that never comes.
      assert.deepEqual(init.result.capabilities, {
        textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
        hoverProvider: true,
        definitionProvider: true,
        documentSymbolProvider: true,
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
    const uri = uriFor(file);
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

  // A DIRECTORY module, which is the shape the compiler's own source is in and
  // the one an editor has the most trouble with: the module is the compilation
  // unit, so a name declared in one file is visible in its sibling with no
  // import to follow. Everything below is asked from `use.yoop` about things
  // declared in `shapes.yoop`.
  const MODULE_FILES = {
    "shapes.yoop": [
      "module lib;",
      "",
      'import { Text }, * as text from "std/core/text.yoop";',
      "",
      "export type Point {",
      "  x: int32,",
      "  y: int32,",
      "}",
      "",
      "export function twice(n: int32): int32 {",
      "  return n * 2;",
      "}",
      "",
      // Deliberately leaky, and deliberately in the file that sorts FIRST: a
      // `Text` binding with no `disposable` keyword, never disposed and never
      // handed on, is exactly what the unhandled-disposable warning is for.
      // Which file it is reported against is the thing being tested.
      "export function leaky(): usize {",
      "  let t: Text = text.make(8);",
      "  text.push(ref t, \"x\");",
      "  return t.len;",
      "}",
      "",
    ].join("\n"),
    "use.yoop": [
      "module lib;",
      "",
      "export function widen(p: Point): int32 {",
      "  const scaled = twice(p.x);",
      "  return scaled;",
      "}",
      "",
    ].join("\n"),
  };
  const MODULE_MAIN = [
    'import { widen } from "./lib";',
    "",
    "function main(): int32 {",
    "  const p: Point = { x: 2, y: 3 };",
    "  return widen(p);",
    "}",
    "",
  ].join("\n");

  // The 0-based (line, character) of `needle` in `text`. Positions are DERIVED
  // from the fixture rather than written down, so a test says which token it is
  // pointing at instead of asserting a number nobody can check.
  function positionOf(text, needle, offsetIntoNeedle = 0) {
    const at = text.indexOf(needle);
    assert.ok(at >= 0, `the fixture does not contain ${JSON.stringify(needle)}`);
    const upTo = text.slice(0, at + offsetIntoNeedle);
    const line = upTo.split("\n").length - 1;
    const character = upTo.length - (upTo.lastIndexOf("\n") + 1);
    return { line, character };
  }

  // Write the two-file module plus its entry, and hand back what the test needs
  // to talk about `use.yoop`.
  function writeModuleFixture(name) {
    const dir = path.join(work, name);
    fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
    for (const [base, text] of Object.entries(MODULE_FILES)) {
      fs.writeFileSync(path.join(dir, "lib", base), text);
    }
    fs.writeFileSync(path.join(dir, "main.yoop"), MODULE_MAIN);
    const file = path.join(dir, "lib", "use.yoop");
    return { dir, file, uri: uriFor(file), text: MODULE_FILES["use.yoop"] };
  }

  // `initialize` + `didOpen`, through the first publish. Every query test below
  // starts here and none of them cares what the diagnostics were.
  async function openDocument(client, uri, text) {
    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await client.next();
    client.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    client.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "yoop", version: 1, text } },
    });
    return client.next();
  }

  it("hovers a name declared in a sibling file of the same module", async () => {
    const fx = writeModuleFixture("hover");
    const client = new LspClient(boot, env);
    try {
      await openDocument(client, fx.uri, fx.text);

      // `twice` in `twice(p.x)`, which is declared in shapes.yoop and reached
      // with no import at all.
      client.send({
        jsonrpc: "2.0", id: 2, method: "textDocument/hover",
        params: { textDocument: { uri: fx.uri }, position: positionOf(fx.text, "twice(p.x)") },
      });
      const hover = await client.next();
      assert.equal(hover.id, 2);
      assert.equal(hover.result.contents.kind, "markdown");
      // The signature as it was WRITTEN, which is what a reader wants to see -
      // parameter names included.
      assert.match(hover.result.contents.value,
        /export function twice\(n: int32\): int32/);
      assert.match(hover.result.contents.value, /shapes\.yoop/);

      // A LOCAL, whose answer is its type rather than a signature: its source
      // line is an initializer, which is longer and says less.
      client.send({
        jsonrpc: "2.0", id: 3, method: "textDocument/hover",
        params: { textDocument: { uri: fx.uri }, position: positionOf(fx.text, "return scaled", 7) },
      });
      const local = await client.next();
      assert.equal(local.id, 3);
      assert.match(local.result.contents.value, /scaled: int32/);
      // Declared in this file, so there is no "declared in" line to read.
      assert.ok(!/declared in/.test(local.result.contents.value),
        `a same-file answer named its own file: ${local.result.contents.value}`);

      // Whitespace is not an error, it is an absence. `null` is the protocol's
      // way of saying so, and an error here would be a red banner in the
      // editor for a mouse that paused in the wrong place.
      client.send({
        jsonrpc: "2.0", id: 4, method: "textDocument/hover",
        params: { textDocument: { uri: fx.uri }, position: { line: 1, character: 0 } },
      });
      const empty = await client.next();
      assert.equal(empty.id, 4);
      assert.equal(empty.result, null);

      client.send({ jsonrpc: "2.0", id: 5, method: "shutdown" });
      await client.next();
      client.send({ jsonrpc: "2.0", method: "exit" });
      assert.equal(await client.exited, 0);
    } finally {
      client.kill();
    }
  });

  it("jumps to a declaration in another file, and to a local in this one", async () => {
    const fx = writeModuleFixture("definition");
    const client = new LspClient(boot, env);
    try {
      await openDocument(client, fx.uri, fx.text);

      client.send({
        jsonrpc: "2.0", id: 2, method: "textDocument/definition",
        params: { textDocument: { uri: fx.uri }, position: positionOf(fx.text, "twice(p.x)") },
      });
      const across = await client.next();
      assert.equal(across.id, 2);
      assert.match(across.result.uri, /shapes\.yoop$/);
      // The name in `export function twice(...)`, which is on source line 8 -
      // line 7 to an editor - and starts at column 16.
      const declared = positionOf(MODULE_FILES["shapes.yoop"], "twice(n: int32)");
      assert.deepEqual(across.result.range.start, declared);
      assert.equal(across.result.range.end.character, declared.character + "twice".length);

      // A TYPE from the sibling file, named in this file's signature.
      client.send({
        jsonrpc: "2.0", id: 3, method: "textDocument/definition",
        params: { textDocument: { uri: fx.uri }, position: positionOf(fx.text, "Point)") },
      });
      const toType = await client.next();
      assert.match(toType.result.uri, /shapes\.yoop$/);
      assert.deepEqual(toType.result.range.start,
        positionOf(MODULE_FILES["shapes.yoop"], "Point {"));

      // A FIELD, which is not a name in any scope: `p.x` is a member of
      // whatever `p` turned out to be, so it takes the base's type first and
      // then the member inside that type's declaration.
      client.send({
        jsonrpc: "2.0", id: 6, method: "textDocument/definition",
        params: { textDocument: { uri: fx.uri }, position: positionOf(fx.text, "p.x", 2) },
      });
      const toField = await client.next();
      assert.match(toField.result.uri, /shapes\.yoop$/);
      assert.deepEqual(toField.result.range.start,
        positionOf(MODULE_FILES["shapes.yoop"], "x: int32"));

      // A LOCAL: the answer is in this file, at the binding.
      client.send({
        jsonrpc: "2.0", id: 4, method: "textDocument/definition",
        params: { textDocument: { uri: fx.uri }, position: positionOf(fx.text, "return scaled", 7) },
      });
      const toLocal = await client.next();
      assert.equal(toLocal.result.uri, fx.uri);
      assert.deepEqual(toLocal.result.range.start, positionOf(fx.text, "scaled = twice"));

      client.send({ jsonrpc: "2.0", id: 5, method: "shutdown" });
      await client.next();
      client.send({ jsonrpc: "2.0", method: "exit" });
      assert.equal(await client.exited, 0);
    } finally {
      client.kill();
    }
  });

  it("outlines the file it was asked about", async () => {
    const fx = writeModuleFixture("outline");
    const client = new LspClient(boot, env);
    try {
      await openDocument(client, fx.uri, fx.text);
      client.send({
        jsonrpc: "2.0", id: 2, method: "textDocument/documentSymbol",
        params: { textDocument: { uri: fx.uri } },
      });
      const outline = await client.next();
      assert.equal(outline.id, 2);
      // THIS file's declarations and not the module's: `use.yoop` declares one
      // function, and the sibling's Point and twice belong to the sibling's
      // outline.
      assert.equal(outline.result.length, 1,
        `wanted use.yoop's own declarations, got ${JSON.stringify(outline.result)}`);
      assert.equal(outline.result[0].name, "widen");
      assert.equal(outline.result[0].kind, 12, "SymbolKind.Function");
      assert.deepEqual(outline.result[0].selectionRange.start,
        positionOf(fx.text, "widen(p: Point)"));

      client.send({ jsonrpc: "2.0", id: 3, method: "shutdown" });
      await client.next();
      client.send({ jsonrpc: "2.0", method: "exit" });
      assert.equal(await client.exited, 0);
    } finally {
      client.kill();
    }
  });

  // The decision this test exists to pin, and the one that makes the server
  // usable on this compiler's own source: one file of a DIRECTORY module is
  // compiled from the editor's buffer while its siblings are read off the
  // disk. Seeding the whole module from one file's bytes instead would lose
  // every declaration the sibling makes, and the editor would fill with
  // "unknown name" on code that is fine.
  it("typechecks an unsaved buffer against its saved siblings", async () => {
    const fx = writeModuleFixture("overlay");
    const client = new LspClient(boot, env);
    try {
      const opened = await openDocument(client, fx.uri, fx.text);
      assert.deepEqual(opened.params.diagnostics, [],
        "the fixture should compile as written");

      // An edit that is wrong only because of what the SIBLING declares:
      // `twice` takes one argument there.
      const broken = fx.text.replace("twice(p.x)", "twice(p.x, p.y)");
      client.send({
        jsonrpc: "2.0", method: "textDocument/didChange",
        params: { textDocument: { uri: fx.uri, version: 2 }, contentChanges: [{ text: broken }] },
      });
      const pub = await client.next();
      assert.equal(pub.params.version, 2);
      assert.equal(pub.params.diagnostics.length, 1,
        `wanted one arity error, got ${JSON.stringify(pub.params.diagnostics)}`);
      assert.match(pub.params.diagnostics[0].message, /"twice" takes 1 argument/);
      // Against the BUFFER's coordinates, which is the line the edit is on.
      assert.deepEqual(pub.params.diagnostics[0].range.start,
        positionOf(broken, "twice(p.x, p.y)"));
      // And nothing was written to disk.
      assert.equal(fs.readFileSync(fx.file, "utf8"), fx.text);

      client.send({ jsonrpc: "2.0", id: 9, method: "shutdown" });
      await client.next();
      client.send({ jsonrpc: "2.0", method: "exit" });
      assert.equal(await client.exited, 0);
    } finally {
      client.kill();
    }
  });

  // A warning belongs to the file that earned it, and a module has several.
  // Every pass that walks a directory module's files has to say which one it
  // is on; one that forgets stamps whatever file the pass before it finished
  // on, which is the module's last. The symptom is a squiggle drawn on an
  // unrelated file at a line number that may not exist there.
  it("attributes a warning to the file that earned it, not to its module's last", async () => {
    const fx = writeModuleFixture("attribution");
    const client = new LspClient(boot, env);
    try {
      // `use.yoop` sorts AFTER `shapes.yoop`, so it is where a misattributed
      // warning would land - and it has nothing to warn about.
      const onUse = await openDocument(client, fx.uri, fx.text);
      assert.deepEqual(onUse.params.diagnostics, [],
        "a warning from the sibling file was published against this one");

      // And the warning is not merely lost: opening the file it belongs to
      // shows it. Warnings are not filtered in the editor the way a build
      // filters them - an advisory belongs where the reader can see the line.
      const shapesText = MODULE_FILES["shapes.yoop"];
      const shapesFile = path.join(fx.dir, "lib", "shapes.yoop");
      const shapesUri = uriFor(shapesFile);
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri: shapesUri, languageId: "yoop", version: 1, text: shapesText },
        },
      });
      const onShapes = await client.next();
      assert.equal(onShapes.params.uri, shapesUri);
      const warnings = onShapes.params.diagnostics.filter((d) => d.severity === 2);
      assert.equal(warnings.length, 1,
        `wanted one warning on shapes.yoop, got ${JSON.stringify(onShapes.params.diagnostics)}`);
      assert.match(warnings[0].message, /"t" carries kind 'disposable'/);
      assert.deepEqual(warnings[0].range.start, positionOf(shapesText, "t: Text = text.make"));

      client.send({ jsonrpc: "2.0", id: 9, method: "shutdown" });
      await client.next();
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
