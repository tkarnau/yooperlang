#!/usr/bin/env node
// Yooperlang LSP server.
//
// Self-contained: speaks the Language Server Protocol over stdio using Node's
// stdlib only. The server reuses the existing lexer/parser/typechecker via
// the analyze() helper.
//
// Capabilities (v1):
//   - Full text-document sync (client sends the whole file on every change).
//   - publishDiagnostics on open / change / save.
//   - clear diagnostics on close.
//
// Future: incremental sync, hover, go-to-def, completion, code actions.

import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import { analyze } from "./analyze.js";

// ---------- LSP framing (Content-Length headers) -----------------------------

let stdinBuffer = Buffer.alloc(0);

function send(message) {
  const json = JSON.stringify(message);
  const payload = Buffer.from(json, "utf8");
  const header = `Content-Length: ${payload.length}\r\n\r\n`;
  process.stdout.write(header);
  process.stdout.write(payload);
}

function sendNotification(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function sendResponse(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function processBuffer() {
  while (true) {
    const headerEnd = stdinBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = stdinBuffer.slice(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      // Malformed header — drop everything up to the separator and retry.
      stdinBuffer = stdinBuffer.slice(headerEnd + 4);
      continue;
    }
    const length = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (stdinBuffer.length < bodyStart + length) return; // wait for more
    const body = stdinBuffer.slice(bodyStart, bodyStart + length).toString("utf8");
    stdinBuffer = stdinBuffer.slice(bodyStart + length);
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      // Skip invalid JSON and move on.
      continue;
    }
    handleMessage(message);
  }
}

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  processBuffer();
});

process.stdin.on("end", () => {
  process.exit(0);
});

// ---------- document store ---------------------------------------------------

// uri -> { text, absPath }
const documents = new Map();

function uriToAbsPath(uri) {
  try {
    return fs.realpathSync(fileURLToPath(uri));
  } catch {
    // File may not exist on disk yet (untitled buffer); fall back to the
    // URI's path with no realpath resolution.
    try {
      return fileURLToPath(uri);
    } catch {
      return null;
    }
  }
}

function absPathToUri(absPath) {
  return pathToFileURL(absPath).toString();
}

// Build the overlay map: for every open doc, prefer its in-memory text.
function buildOverlays() {
  const overlays = new Map();
  for (const doc of documents.values()) {
    if (doc.absPath) overlays.set(doc.absPath, doc.text);
  }
  return overlays;
}

// ---------- diagnostics ------------------------------------------------------

function posToRange(text, pos, length) {
  // Convert a flat offset to LSP {line, character} (both 0-indexed).
  const before = text.slice(0, pos);
  const newlineCount = (before.match(/\n/g) || []).length;
  const lastNewline = before.lastIndexOf("\n");
  const character = lastNewline === -1 ? pos : pos - lastNewline - 1;
  const startLine = newlineCount;
  const startChar = character;
  // For a length, walk forward. Most diagnostics have length 1; clamp at the
  // end of the file to avoid running off the buffer.
  const endPos = Math.min(text.length, pos + Math.max(1, length));
  const between = text.slice(pos, endPos);
  const newlinesBetween = (between.match(/\n/g) || []).length;
  let endLine = startLine + newlinesBetween;
  let endChar;
  if (newlinesBetween === 0) {
    endChar = startChar + (endPos - pos);
  } else {
    const lastNl = between.lastIndexOf("\n");
    endChar = endPos - pos - lastNl - 1;
  }
  return {
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar },
  };
}

function publishFor(uri) {
  const doc = documents.get(uri);
  if (!doc || !doc.absPath) return;

  const overlays = buildOverlays();
  let result;
  try {
    result = analyze(doc.absPath, overlays);
  } catch (err) {
    // Defensive: analyze() should swallow exceptions itself, but if anything
    // sneaks through, surface it as a single diagnostic so the user knows.
    result = {
      diagnostics: [
        {
          absPath: doc.absPath,
          pos: 0,
          length: 1,
          line: 1,
          column: 1,
          message: `internal LSP error: ${err.message}`,
          severity: 1,
        },
      ],
    };
  }

  // Group diagnostics by absPath; we publish one notification per file we
  // produced diagnostics for. Also publish an empty array for the current
  // document if it produced none, so old squiggles clear.
  const byPath = new Map();
  byPath.set(doc.absPath, []);
  for (const d of result.diagnostics) {
    if (!byPath.has(d.absPath)) byPath.set(d.absPath, []);
    byPath.get(d.absPath).push(d);
  }

  for (const [absPath, diags] of byPath) {
    const targetUri = absPathToUri(absPath);
    // Use the open document's text if we have it; otherwise read from disk.
    let text;
    const openDoc = [...documents.values()].find((d) => d.absPath === absPath);
    if (openDoc) {
      text = openDoc.text;
    } else {
      try {
        text = fs.readFileSync(absPath, "utf8");
      } catch {
        text = "";
      }
    }

    const lspDiagnostics = diags.map((d) => ({
      severity: d.severity,
      range: posToRange(text, d.pos, d.length),
      message: d.message,
      source: "yoopiler",
    }));

    sendNotification("textDocument/publishDiagnostics", {
      uri: targetUri,
      diagnostics: lspDiagnostics,
    });
  }
}

// ---------- message dispatch -------------------------------------------------

let shutdownRequested = false;

function handleMessage(msg) {
  // Notification: no `id` field.
  // Request: has `id`, expects a response.
  if (msg.method === "initialize") {
    sendResponse(msg.id, {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: 1, // Full
          save: { includeText: false },
        },
      },
      serverInfo: { name: "yoopiler-lsp", version: "0.0.1" },
    });
    return;
  }
  if (msg.method === "initialized") return;

  if (msg.method === "textDocument/didOpen") {
    const td = msg.params.textDocument;
    const absPath = uriToAbsPath(td.uri);
    documents.set(td.uri, { text: td.text, absPath });
    publishFor(td.uri);
    return;
  }

  if (msg.method === "textDocument/didChange") {
    const td = msg.params.textDocument;
    const doc = documents.get(td.uri);
    if (!doc) return;
    // Full-sync mode: the single content change carries the entire new text.
    const change = msg.params.contentChanges[msg.params.contentChanges.length - 1];
    if (change && typeof change.text === "string") {
      doc.text = change.text;
    }
    publishFor(td.uri);
    return;
  }

  if (msg.method === "textDocument/didSave") {
    publishFor(msg.params.textDocument.uri);
    return;
  }

  if (msg.method === "textDocument/didClose") {
    const uri = msg.params.textDocument.uri;
    documents.delete(uri);
    // Clear any squiggles on the closed file.
    sendNotification("textDocument/publishDiagnostics", { uri, diagnostics: [] });
    return;
  }

  if (msg.method === "shutdown") {
    shutdownRequested = true;
    sendResponse(msg.id, null);
    return;
  }

  if (msg.method === "exit") {
    process.exit(shutdownRequested ? 0 : 1);
  }

  // Unknown request: respond with MethodNotFound so the client doesn't hang.
  if (msg.id !== undefined) {
    sendError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}
