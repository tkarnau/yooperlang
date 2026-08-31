// A minimal LSP client for one job: open a document against a spawned
// `yoopiler_boot --lsp`, collect its diagnostics, and read back the
// typechecked facts the server exposes (documentSymbol for the outline,
// hover for each symbol's resolved type). This is the only machine-readable
// channel for typecheck results; the CLI has no dump flag for them.
//
// The transport is LSP's standard Content-Length framing over stdio, the same
// thing src/lsp.test.js drives.

import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SYMBOL_KINDS = {
  5: "class", 6: "method", 8: "field", 10: "enum", 11: "interface",
  12: "fn", 13: "variable", 14: "const", 23: "struct", 26: "typeParameter",
};

export async function typecheckViaLsp({ compiler, env, filePath, text, timeoutMs = 60000 }) {
  const proc = spawn(compiler, ["--lsp"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const uri = pathToFileURL(path.resolve(filePath)).href;
  let nextId = 1;
  const pending = new Map();
  let diagnostics = null;
  let diagnosticsResolve = null;
  let buffer = Buffer.alloc(0);
  let stderr = "";

  proc.stderr.on("data", (d) => { stderr += d; });
  proc.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.slice(0, headerEnd).toString("utf8");
      const lenMatch = header.match(/Content-Length: (\d+)/i);
      if (!lenMatch) { buffer = buffer.slice(headerEnd + 4); continue; }
      const len = Number(lenMatch[1]);
      if (buffer.length < headerEnd + 4 + len) return;
      const body = buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString("utf8");
      buffer = buffer.slice(headerEnd + 4 + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "lsp error"));
        else resolve(msg.result);
      } else if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri === uri) {
        diagnostics = msg.params.diagnostics || [];
        if (diagnosticsResolve) diagnosticsResolve(diagnostics);
      }
    }
  });

  const send = (msg) => {
    const body = JSON.stringify(msg);
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

  const deadline = new Promise((_, reject) => {
    const t = setTimeout(
      () => reject(new Error(`language server gave no diagnostics within ${timeoutMs}ms\n${stderr.slice(-2000)}`)),
      timeoutMs,
    );
    t.unref();
  });

  try {
    await Promise.race([
      request("initialize", { processId: process.pid, rootUri: null, capabilities: {} }),
      deadline,
    ]);
    notify("initialized", {});
    const diagsArrived = new Promise((resolve) => {
      if (diagnostics) resolve(diagnostics);
      else diagnosticsResolve = resolve;
    });
    notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "yoop", version: 1, text },
    });
    const diags = await Promise.race([diagsArrived, deadline]);

    let decls = [];
    try {
      const symbols = (await Promise.race([
        request("textDocument/documentSymbol", { textDocument: { uri } }),
        deadline,
      ])) || [];
      const flat = flattenSymbols(symbols).slice(0, 80);
      for (const sym of flat) {
        let type = "";
        try {
          const hover = await Promise.race([
            request("textDocument/hover", { textDocument: { uri }, position: sym.pos }),
            deadline,
          ]);
          type = hoverText(hover);
        } catch { /* a symbol without hover is still a symbol */ }
        decls.push({ name: sym.name, kind: sym.kind, type, line: sym.pos.line + 1 });
      }
    } catch { /* documentSymbol unsupported would leave decls empty, which SCHEMA allows */ }

    const out = {
      ok: !diags.some((d) => (d.severity ?? 1) === 1),
      diagnostics: diags.map((d) => ({
        line: d.range.start.line + 1,
        col: d.range.start.character + 1,
        message: d.message,
        severity: (d.severity ?? 1) === 1 ? "error" : "warning",
      })),
      decls,
    };
    try {
      await Promise.race([request("shutdown", null), deadline]);
      notify("exit", null);
    } catch { /* a server that dies before answering shutdown already did what we asked */ }
    return out;
  } finally {
    setTimeout(() => proc.kill("SIGKILL"), 500).unref();
  }
}

function flattenSymbols(symbols, out = []) {
  for (const s of symbols) {
    const range = s.selectionRange || s.range || s.location?.range;
    if (range) {
      out.push({
        name: s.name,
        kind: SYMBOL_KINDS[s.kind] || "symbol",
        pos: range.start,
      });
    }
    if (s.children) flattenSymbols(s.children, out);
  }
  return out;
}

function hoverText(hover) {
  if (!hover || !hover.contents) return "";
  const c = hover.contents;
  const raw = typeof c === "string" ? c
    : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x.value)).join("\n")
    : c.value || "";
  // Hover markdown wraps the signature in a code fence; the signature line is
  // what the HUD shows.
  const lines = raw.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("```"));
  return lines[0]?.trim() || "";
}
