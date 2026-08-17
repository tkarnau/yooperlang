// End-to-end LSP server smoke test. Spawns server.js as a child process,
// drives it with real JSON-RPC over stdio, and checks that hover /
// definition / documentSymbol all answer correctly against a tiny
// on-disk fixture.
//
// This is the only place we exercise the full Content-Length framing /
// message-dispatch path. nav.test.js covers the analyze + nav layer
// directly without the framing overhead.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SERVER = path.resolve(import.meta.dirname, "server.js");

// LspClient: a thin DAP/LSP-style framing harness over stdio. Tracks
// pending request IDs and resolves their responses. Notifications are
// buffered so a test can await one - diagnostics arrive that way, unsolicited
// and asynchronously after didOpen, so there is no request to hang them off.
function startClient() {
  const proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = Buffer.alloc(0);
  let seq = 1;
  const pending = new Map();
  const notifications = [];
  const notifyWaiters = [];

  // A notification sent just before close() can still be in flight when the
  // child dies, and writing to a dead child's stdin raises EPIPE. Windows
  // surfaces this where POSIX does not: proc.kill() is TerminateProcess and
  // takes effect immediately, whereas on POSIX the queued write has already
  // drained by the time SIGTERM is handled. With no listener the stream's
  // 'error' event is unhandled and fails whichever test happens to be running.
  // Losing writes to a child we are killing on purpose is fine.
  proc.stdin.on("error", () => {});

  proc.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const hdrEnd = buf.indexOf("\r\n\r\n");
      if (hdrEnd < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, hdrEnd).toString());
      if (!m) { buf = buf.slice(hdrEnd + 4); continue; }
      const len = Number(m[1]);
      if (buf.length < hdrEnd + 4 + len) return;
      const body = buf.slice(hdrEnd + 4, hdrEnd + 4 + len).toString();
      buf = buf.slice(hdrEnd + 4 + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      } else if (msg.id == null && msg.method) {
        notifications.push(msg);
        for (let i = notifyWaiters.length - 1; i >= 0; i--) {
          if (notifyWaiters[i].match(msg)) notifyWaiters.splice(i, 1)[0].resolve(msg);
        }
      }
    }
  });

  function send(message) {
    const json = JSON.stringify(message);
    const payload = Buffer.from(json, "utf8");
    proc.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    proc.stdin.write(payload);
  }
  function request(method, params) {
    const id = seq++;
    const p = new Promise((resolve) => pending.set(id, { resolve }));
    send({ jsonrpc: "2.0", id, method, params });
    return p;
  }
  function notify(method, params) {
    send({ jsonrpc: "2.0", method, params });
  }
  // Resolve with the first notification matching `match`, checking already
  // buffered ones first - a fast server can publish before the test asks.
  function awaitNotification(match, timeoutMs = 15000) {
    const hit = notifications.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      notifyWaiters.push(waiter);
      setTimeout(() => {
        const i = notifyWaiters.indexOf(waiter);
        if (i >= 0) notifyWaiters.splice(i, 1);
        reject(new Error("timed out waiting for notification"));
      }, timeoutMs).unref?.();
    });
  }
  function close() {
    proc.kill();
  }
  return { request, notify, awaitNotification, close };
}

async function withClient(fn) {
  const client = startClient();
  try {
    await client.request("initialize", { processId: process.pid, capabilities: {}, rootUri: null });
    client.notify("initialized", {});
    await fn(client);
  } finally {
    client.close();
  }
}

function writeFixture(src, filename = "main.yoop") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_lsp_"));
  const file = path.join(dir, filename);
  fs.writeFileSync(file, src);
  const absPath = fs.realpathSync(file);
  return {
    absPath,
    // Must go through pathToFileURL rather than "file://" + absPath: on
    // Windows the latter yields "file://C:\dir\main.yoop", which is neither
    // what the server emits nor a valid file URI (a drive path needs the
    // third slash, and separators have to be forward slashes). The server
    // was always right here; only the test's hand-rolled URI was wrong.
    uri: pathToFileURL(absPath).href,
    src,
  };
}

describe("lsp server: end-to-end", () => {
  it("answers initialize with the expected capabilities", async () => {
    await withClient(async (client) => {
      // initialize already happened in withClient; re-doing it would be
      // protocol error. Instead, capture the response from a fresh client.
    });
    // Re-launch to verify capabilities text directly.
    const client = startClient();
    const resp = await client.request("initialize", { processId: process.pid, capabilities: {}, rootUri: null });
    const caps = resp.result?.capabilities ?? {};
    assert.equal(caps.hoverProvider, true);
    assert.equal(caps.definitionProvider, true);
    assert.equal(caps.documentSymbolProvider, true);
    assert.ok(caps.semanticTokensProvider, "expected semanticTokensProvider");
    client.close();
  });

  it("hover returns type info for a local variable reference", async () => {
    const { uri, src } = writeFixture(`function main(): int32 {
    let x: int32 = 7;
    return x;
}
`);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      const refLine = 2; // 0-indexed: "    return x;"
      const refChar = src.split("\n")[refLine].indexOf("x");
      const resp = await client.request("textDocument/hover", {
        textDocument: { uri },
        position: { line: refLine, character: refChar },
      });
      assert.ok(resp.result, "expected a hover result");
      const value = resp.result.contents.value;
      assert.match(value, /int32/);
      assert.match(value, /\bx\b/);
    });
  });

  // yooperdoom-takeaways 4.1: the comment above a declaration is
  // documentation, and hover shows it. Same file first, then the case that
  // actually motivates the feature - a call site in another file.
  it("hover appends the doc comment written above the declaration", async () => {
    const { uri, src } = writeFixture(`// Adds two numbers, the boring way.
// Second line of the doc.
function add(a: int32, b: int32): int32 {
    return a + b;
}
function main(): int32 {
    return add(1, 2);
}
`);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      const lines = src.split("\n");
      const callLine = lines.findIndex((l) => l.includes("return add(1, 2)"));
      const resp = await client.request("textDocument/hover", {
        textDocument: { uri },
        position: { line: callLine, character: lines[callLine].indexOf("add") },
      });
      const value = resp.result?.contents?.value ?? "";
      assert.match(value, /Adds two numbers, the boring way\./);
      assert.match(value, /Second line of the doc\./);
      // The type line still comes first, in its own fence.
      assert.match(value, /^```yoop\n/);
    });
  });

  it("hover reads the doc from the file the declaration lives in", async () => {
    // The whole point of 4.1: the reader is at a CALL SITE in their own file
    // and the documentation lives in the library. A 15,000 line project
    // hand-rolled digit loops in four files because it never found what
    // std/core/format.yoop already exported.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_lsp_doc_"));
    const libPath = path.join(dir, "lib.yoop");
    const mainPath = path.join(dir, "main.yoop");
    fs.writeFileSync(
      libPath,
      `// Pads a number on the left, which is the thing you keep rewriting.
export function padded(n: int32): int32 {
    return n;
}
`,
    );
    const mainSrc = `import * as lib from "./lib.yoop";
function main(): int32 {
    return lib.padded(7);
}
`;
    fs.writeFileSync(mainPath, mainSrc);
    const uri = pathToFileURL(fs.realpathSync(mainPath)).href;

    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: mainSrc },
      });
      const lines = mainSrc.split("\n");
      const callLine = lines.findIndex((l) => l.includes("lib.padded"));
      const resp = await client.request("textDocument/hover", {
        textDocument: { uri },
        position: { line: callLine, character: lines[callLine].indexOf("padded") },
      });
      const value = resp.result?.contents?.value ?? "";
      assert.match(value, /Pads a number on the left/);
    });
  });

  it("definition jumps from a call to its function decl", async () => {
    const { uri, src } = writeFixture(`function add(a: int32, b: int32): int32 {
    return a + b;
}
function main(): int32 {
    return add(1, 2);
}
`);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      const callLine = 4; // "    return add(1, 2);"
      const callChar = src.split("\n")[callLine].indexOf("add");
      const resp = await client.request("textDocument/definition", {
        textDocument: { uri },
        position: { line: callLine, character: callChar },
      });
      assert.ok(resp.result, "expected a definition result");
      assert.equal(resp.result.uri, uri);
      // The range start should be on line 0 (the function decl), pointing
      // at `add` (not at `function`).
      assert.equal(resp.result.range.start.line, 0);
    });
  });

  it("documentSymbol returns Function + Struct nodes", async () => {
    const { uri, src } = writeFixture(`type Point {
    x: int32,
    y: int32,
}
function distance(p: Point): int32 {
    return p.x * p.x + p.y * p.y;
}
`);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      const resp = await client.request("textDocument/documentSymbol", {
        textDocument: { uri },
      });
      assert.ok(Array.isArray(resp.result));
      const names = resp.result.map((s) => s.name);
      assert.ok(names.includes("Point"));
      assert.ok(names.includes("distance"));
    });
  });

  it("references returns every occurrence of a local binding", async () => {
    const { uri, src } = writeFixture(`function f(): int32 {
    let x: int32 = 7;
    let y: int32 = x + x;
    return x + y;
}
`);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      // Cursor on the `x` in the `let x = ...` declaration on line 2.
      const declLine = 1;
      const declChar = src.split("\n")[declLine].indexOf("x");
      const resp = await client.request("textDocument/references", {
        textDocument: { uri },
        position: { line: declLine, character: declChar },
      });
      assert.ok(Array.isArray(resp.result));
      // decl + 2 occurrences inside `let y = x + x` + 1 in `return x + y`
      // = 4 total locations.
      assert.equal(resp.result.length, 4, `got ${JSON.stringify(resp.result)}`);
      for (const ref of resp.result) {
        assert.equal(ref.uri, uri);
      }
    });
  });

  it("rename returns a WorkspaceEdit replacing every reference", async () => {
    const { uri, src } = writeFixture(`function f(): int32 {
    let x: int32 = 7;
    return x + x;
}
`);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      const declLine = 1;
      const declChar = src.split("\n")[declLine].indexOf("x");
      const resp = await client.request("textDocument/rename", {
        textDocument: { uri },
        position: { line: declLine, character: declChar },
        newName: "score",
      });
      assert.ok(resp.result?.changes, `expected changes, got ${JSON.stringify(resp)}`);
      const edits = resp.result.changes[uri];
      assert.ok(Array.isArray(edits));
      // decl + 2 uses = 3 edits, each newText="score".
      assert.equal(edits.length, 3);
      for (const e of edits) assert.equal(e.newText, "score");
    });
  });

  it("rename rejects an invalid identifier", async () => {
    const { uri, src } = writeFixture(`function f(): int32 { let x: int32 = 0; return x; }\n`);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      const idx = src.indexOf("let x") + "let ".length;
      const pos = { line: 0, character: idx };
      const resp = await client.request("textDocument/rename", {
        textDocument: { uri }, position: pos, newName: "123bad",
      });
      assert.ok(resp.error, `expected error, got ${JSON.stringify(resp)}`);
      assert.match(resp.error.message, /not a valid identifier/);
    });
  });

  it("completion returns locals + top-level decls + primitives", async () => {
    const { uri, src } = writeFixture(`function add(a: int32, b: int32): int32 {
    let scratch: int32 = a + b;
    return scratch;
}
function main(): int32 {
    return add(1, 2);
}
`);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      // Cursor inside `add`'s body (line 2 = `    return scratch;`).
      const resp = await client.request("textDocument/completion", {
        textDocument: { uri },
        position: { line: 2, character: 4 },
      });
      const labels = (resp.result.items ?? []).map((i) => i.label);
      assert.ok(labels.includes("a"), `expected param a in ${labels}`);
      assert.ok(labels.includes("b"));
      assert.ok(labels.includes("scratch"));
      assert.ok(labels.includes("add"));
      assert.ok(labels.includes("main"));
      assert.ok(labels.includes("int32"), `expected int32 primitive in ${labels}`);
    });
  });

  // yooperdoom-takeaways 4.1: the doc arrives while you are picking the name,
  // not after. Same scanner as hover, on the LSP `documentation` field.
  it("completion carries the doc comment, including for a namespace import", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_lsp_comp_"));
    fs.writeFileSync(
      path.join(dir, "lib.yoop"),
      `// lib.yoop - the module header, which says what the MODULE is for.

// Pads a number on the left, which is the thing you keep rewriting.
export function padded(n: int32): int32 {
    return n;
}
`,
    );
    const mainSrc = `import * as lib from "./lib.yoop";
// Doubles its argument, and says so.
function twice(n: int32): int32 {
    return n + n;
}
function main(): int32 {
    return 0;
}
`;
    const mainPath = path.join(dir, "main.yoop");
    fs.writeFileSync(mainPath, mainSrc);
    const uri = pathToFileURL(fs.realpathSync(mainPath)).href;

    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: mainSrc },
      });
      const resp = await client.request("textDocument/completion", {
        textDocument: { uri },
        position: { line: 6, character: 4 },
      });
      const items = resp.result.items ?? [];
      const byLabel = (l) => items.find((i) => i.label === l);

      // A decl in the file under the cursor.
      assert.match(
        byLabel("twice")?.documentation?.value ?? "",
        /Doubles its argument, and says so\./,
      );
      // A namespace import documents itself with the imported file's HEADER -
      // there is no decl to look up, and the header is the answer a reader
      // wants for `lib` anyway.
      assert.match(
        byLabel("lib")?.documentation?.value ?? "",
        /the module header, which says what the MODULE is for/,
      );
      // The header must NOT have leaked onto the first decl in that file:
      // docCommentAt stops at the blank line between them.
      assert.equal(byLabel("padded"), undefined, "padded is not imported by name");
    });
  });

  it("semanticTokens/full returns an encoded token stream", async () => {
    const { uri, src } = writeFixture(`function f(): int32 {
    let x: int32 = 7;
    return x;
}
`);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      const resp = await client.request("textDocument/semanticTokens/full", {
        textDocument: { uri },
      });
      assert.ok(resp.result, "expected a tokens result");
      assert.ok(Array.isArray(resp.result.data));
      // Quintuple-encoded - length must be a multiple of 5.
      assert.equal(resp.result.data.length % 5, 0);
      assert.ok(resp.result.data.length >= 5, "expected at least one token");
    });
  });

  it("publishes unreachable code as a dimmed warning over the whole dead run", async () => {
    const src = `function f(): int32 {
    return 1;
    let x: int32 = 2;
    return x;
}

function main(): int32 {
    return f();
}
`;
    const { uri } = writeFixture(src);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      const note = await client.awaitNotification(
        (m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === uri,
      );
      const diags = note.params.diagnostics;
      const dead = diags.find((d) => d.code === "unreachable-code");
      assert.ok(dead, `expected an unreachable-code diagnostic in ${JSON.stringify(diags)}`);
      assert.equal(dead.severity, 2, "warning, so it never blocks a build");
      // DiagnosticTag.Unnecessary. This is the whole point: without the tag
      // the editor underlines dead code in yellow like a mistake instead of
      // fading it out.
      assert.deepEqual(dead.tags, [1]);
      // The range must cover BOTH dead statements, not just the first - a
      // one-statement range would leave the rest of the run undimmed.
      assert.equal(dead.range.start.line, 2);
      assert.equal(dead.range.start.character, 4);
      assert.ok(dead.range.end.line >= 3, `range ended too early: ${JSON.stringify(dead.range)}`);
    });
  });

  it("clears to no diagnostics for a file with no dead code", async () => {
    const src = `function f(): int32 {
    return 1;
}

function main(): int32 {
    return f();
}
`;
    const { uri } = writeFixture(src);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      const note = await client.awaitNotification(
        (m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === uri,
      );
      assert.deepEqual(note.params.diagnostics, []);
    });
  });
});

// The `@inspect` substrate view, driven through the real server. The mapping
// itself is covered in substrate.test.js / irIndex.test.js; what these assert
// is the PROTOCOL wiring - that a hover on a line carries an IR section, that
// the lens shows up, and that the panel request answers.
describe("lsp server: @inspect substrate view", () => {
  const MARKED = `@inspect(ir)
function hotLoop(n: int32): int32 {
    let acc: int32 = 0;
    for (let i: int32 = 0; i < n; i = i + 1) {
        acc = acc + i * i;
    }
    return acc;
}

function unmarked(n: int32): int32 {
    return n * 3;
}

function main(): int32 {
    return hotLoop(10) + unmarked(2);
}
`;
  // 0-based line of `acc = acc + i * i;`.
  const MULTIPLY_LINE = 4;

  it("hover inside a marked function includes its LLVM IR", async () => {
    const { uri, src } = writeFixture(MARKED);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      const resp = await client.request("textDocument/hover", {
        textDocument: { uri },
        // Column 0 of the line: deliberately NOT on an identifier, because
        // the substrate section is keyed off the line rather than a name.
        position: { line: MULTIPLY_LINE, character: 0 },
      });
      const value = resp.result?.contents?.value ?? "";
      assert.match(value, /@inspect/);
      assert.match(value, /hotLoop/);
      assert.match(value, /```llvm/);
      assert.match(value, /\bmul\b/, `no multiply in hover:\n${value}`);
    });
  });

  it("hover inside an unmarked function carries no IR section", async () => {
    const { uri, src } = writeFixture(MARKED);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      const lines = src.split("\n");
      const line = lines.findIndex((l) => l.includes("return n * 3"));
      const resp = await client.request("textDocument/hover", {
        textDocument: { uri },
        position: { line, character: lines[line].indexOf("n") },
      });
      const value = resp.result?.contents?.value ?? "";
      assert.doesNotMatch(value, /@inspect/);
    });
  });

  it("hover still returns type info when the file has no @inspect at all", async () => {
    // The gate must not disturb the ordinary hover path.
    const { uri, src } = writeFixture(`function main(): int32 {
    let x: int32 = 7;
    return x;
}
`);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      const resp = await client.request("textDocument/hover", {
        textDocument: { uri },
        position: { line: 2, character: 11 },
      });
      assert.match(resp.result?.contents?.value ?? "", /int32/);
    });
  });

  it("advertises a code lens provider and emits one lens per marked function", async () => {
    const { uri, src } = writeFixture(MARKED);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      const resp = await client.request("textDocument/codeLens", {
        textDocument: { uri },
      });
      const lenses = resp.result ?? [];
      assert.equal(lenses.length, 1, `expected 1 lens, got ${lenses.length}`);
      assert.equal(lenses[0].command.command, "yoop.showSubstrate");
      assert.match(lenses[0].command.title, /LLVM IR/);
      // The lens sits on the function's declaration line (0-based here).
      assert.equal(lenses[0].range.start.line, 1);
      assert.equal(lenses[0].command.arguments[0].declLine, 2);
    });
  });

  it("emits a lens per requested mode", async () => {
    const { uri, src } = writeFixture(`@inspect(ir, asm)
function doubled(x: int32): int32 { return x * 2; }
function main(): int32 { return doubled(21); }
`);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      const resp = await client.request("textDocument/codeLens", {
        textDocument: { uri },
      });
      assert.deepEqual(
        (resp.result ?? []).map((l) => l.command.arguments[0].mode),
        ["ir", "asm"],
      );
    });
  });

  it("answers yoop/substrate with the function's full IR and highlights", async () => {
    const { uri, src } = writeFixture(MARKED);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      const resp = await client.request("yoop/substrate", {
        textDocument: { uri },
        declLine: 2,
        mode: "ir",
        focusLine: MULTIPLY_LINE + 1, // 1-based source line
      });
      const r = resp.result;
      assert.ok(r, "expected a substrate response");
      assert.equal(r.error, undefined);
      assert.match(r.lines[0], /^define .*hotLoop/);
      assert.equal(r.lines[r.lines.length - 1], "}");
      assert.ok(r.highlight.length > 0, "expected highlighted rows");
      assert.match(
        r.highlight.map((h) => r.lines[h]).join("\n"),
        /\bmul\b/,
      );
    });
  });

  it("reports a build failure through yoop/substrate instead of erroring", async () => {
    const { uri, src } = writeFixture(`@inspect(ir)
function broken(): int32 { return "nope"; }
`);
    await withClient(async (client) => {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "yoop", version: 1, text: src },
      });
      const resp = await client.request("yoop/substrate", {
        textDocument: { uri },
        declLine: 2,
        mode: "ir",
      });
      assert.ok(resp.result?.error, "expected an error field, not a crash");
      assert.match(resp.result.error, /error/);
    });
  });
});
