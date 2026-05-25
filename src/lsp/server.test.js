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

const SERVER = path.resolve(import.meta.dirname, "server.js");

// LspClient: a thin DAP/LSP-style framing harness over stdio. Tracks
// pending request IDs and resolves their responses; notifications get
// dropped on the floor (we don't need them for these tests beyond
// observing the server is alive).
function startClient() {
  const proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = Buffer.alloc(0);
  let seq = 1;
  const pending = new Map();

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
  function close() {
    proc.kill();
  }
  return { request, notify, close };
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
  return {
    absPath: fs.realpathSync(file),
    uri: "file://" + fs.realpathSync(file),
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
});
