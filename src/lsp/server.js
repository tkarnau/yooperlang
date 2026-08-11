#!/usr/bin/env node
// Yooperlang LSP server.
//
// Self-contained: speaks the Language Server Protocol over stdio using Node's
// stdlib only. The server reuses the existing lexer/parser/typechecker via
// the analyze() helper.
//
// Capabilities:
//   - Full text-document sync (client sends the whole file on every change).
//   - publishDiagnostics on open / change / save.
//   - clear diagnostics on close.
//   - textDocument/hover  - type info from resolvedType.
//   - textDocument/definition - back-pointers stamped during typecheck.
//   - textDocument/documentSymbol - outline view.
//   - textDocument/semanticTokens/full - type-aware coloring.

import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import { analyze } from "./analyze.js";
import {
  collectDocumentSymbols,
  docCommentAt,
  findDefinition,
  findNodeAt,
  getHoverInfo,
  hoverFromName,
  identTokenAt,
  offsetToPos,
  offsetToRange,
  posToOffset,
} from "./nav.js";
import { buildSemanticTokens, SEMANTIC_TOKEN_LEGEND } from "./semanticTokens.js";
import { findReferences, identifyTarget } from "./references.js";
import { renameAtCursor } from "./rename.js";
import { collectCompletions } from "./completion.js";

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
      // Malformed header - drop everything up to the separator and retry.
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

// uri -> { text, absPath, version, analysis? }
//   `analysis` is the cached result of analyze() at the last didOpen/didChange.
//   It's invalidated by setting analysis = null on didChange before the next
//   request rebuilds it lazily.
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

// Read the current text for a module: prefer an open overlay (so an
// unsaved buffer reflects the latest edits) and fall back to disk.
// Returns null if the file isn't readable.
function textForAbsPath(absPath) {
  for (const doc of documents.values()) {
    if (doc.absPath === absPath) return doc.text;
  }
  try { return fs.readFileSync(absPath, "utf8"); } catch { return null; }
}

// Build the overlay map: for every open doc, prefer its in-memory text.
function buildOverlays() {
  const overlays = new Map();
  for (const doc of documents.values()) {
    if (doc.absPath) overlays.set(doc.absPath, doc.text);
  }
  return overlays;
}

// Run analyze() for the document at `uri` (or return the cached result).
// The cache key is implicit: `doc.analysis` is invalidated to null by
// didChange. Returns null when the document doesn't exist.
function analysisFor(uri) {
  const doc = documents.get(uri);
  if (!doc || !doc.absPath) return null;
  if (doc.analysis) return doc.analysis;
  const overlays = buildOverlays();
  try {
    doc.analysis = analyze(doc.absPath, overlays);
  } catch (err) {
    // analyze() shouldn't throw, but if it does, surface a single diagnostic
    // and an empty analysis so feature handlers no-op cleanly.
    doc.analysis = {
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
      modules: [],
      moduleEnv: null,
      programState: null,
      entryModule: null,
      modById: new Map(),
    };
  }
  return doc.analysis;
}

// Resolve a (uri, LSP position) tuple to { node, module, ancestry, offset }
// or null if the doc isn't open / position is out of range.
function resolveAt(uri, position) {
  const doc = documents.get(uri);
  if (!doc) return null;
  const analysis = analysisFor(uri);
  if (!analysis) return null;
  const mod = analysis.modules.find((m) => m.absPath === doc.absPath);
  if (!mod) return null;
  const src = doc.text;
  const offset = posToOffset(src, position.line, position.character);
  const ancestry = [];
  const node = findNodeAt(mod.ast, offset, src, ancestry);
  return { node, module: mod, ancestry, offset, src, analysis };
}

// The doc comment for whatever the cursor is on, or null.
//
// Goes through findDefinition rather than reading the node under the cursor,
// because the useful case is a USE site: hovering `padStart` in your own file
// has to reach the comment written above it in std/core/strings.yoop. That
// returns { absPath, pos } pointing at the declaration's NAME, which is
// exactly the anchor docCommentAt wants.
//
// Prefers the open buffer's text over the module's parsed copy so an unsaved
// edit to a comment shows immediately, matching how diagnostics already work.
function docForHover(at) {
  const tok = identTokenAt(at.src, at.offset);
  let def = null;
  try {
    def = findDefinition(at.node, {
      module: at.module,
      modById: at.analysis.modById,
      moduleEnv: at.analysis.moduleEnv,
      tokenText: tok?.text,
      tokenStart: tok?.start,
      cursorOffset: at.offset,
    });
  } catch {
    // Hover is best-effort decoration; a resolution failure must never cost
    // the type line that was already computed.
    return null;
  }
  if (!def?.absPath || typeof def.pos !== "number") return null;
  const src = sourceForPath(at.analysis, def.absPath);
  if (!src) return null;
  return docCommentAt(src, def.pos);
}

function sourceForPath(analysis, absPath) {
  for (const doc of documents.values()) {
    if (doc.absPath === absPath) return doc.text;
  }
  return analysis.modules.find((m) => m.absPath === absPath)?.src ?? null;
}

// ---------- diagnostics ------------------------------------------------------

function posToRange(text, pos, length) {
  return offsetToRange(text, pos, length);
}

// LSP DiagnosticTag values (spec 3.16).
const DiagnosticTag = {
  unnecessary: 1, // rendered faded out / dimmed rather than underlined
  deprecated: 2, // rendered struck through
};

// Which diagnostic codes render as something other than a squiggle. Dead code
// wants to be DIMMED over its whole extent - a squiggle under the first
// statement (or worse, one parked on the enclosing function) says "there is a
// mistake here" about code whose only problem is that it does not run.
// Editors key that rendering off the tag, not the severity, so the code the
// typechecker stamps is what selects it.
const TAGS_BY_CODE = {
  "unreachable-code": [DiagnosticTag.unnecessary],
};


function publishFor(uri) {
  const doc = documents.get(uri);
  if (!doc || !doc.absPath) return;

  const result = analysisFor(uri);
  if (!result) return;

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

    const lspDiagnostics = diags.map((d) => {
      const diag = {
        severity: d.severity,
        range: posToRange(text, d.pos, d.length),
        message: d.message,
        source: "yoopiler",
      };
      if (d.code) diag.code = d.code;
      const tags = TAGS_BY_CODE[d.code];
      if (tags) diag.tags = tags;
      return diag;
    });

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
        hoverProvider: true,
        definitionProvider: true,
        documentSymbolProvider: true,
        referencesProvider: true,
        renameProvider: { prepareProvider: false },
        completionProvider: {
          // No trigger characters yet - VSCode fires completion on
          // identifier-char input by default, which is enough for now.
          resolveProvider: false,
        },
        semanticTokensProvider: {
          legend: SEMANTIC_TOKEN_LEGEND,
          full: true,
          range: false,
        },
      },
      serverInfo: { name: "yoopiler-lsp", version: "0.1.0" },
    });
    return;
  }
  if (msg.method === "initialized") return;

  if (msg.method === "textDocument/didOpen") {
    const td = msg.params.textDocument;
    const absPath = uriToAbsPath(td.uri);
    documents.set(td.uri, { text: td.text, absPath, analysis: null });
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
    // Invalidate cached analysis so the next feature request reanalyzes.
    doc.analysis = null;
    publishFor(td.uri);
    return;
  }

  if (msg.method === "textDocument/didSave") {
    const doc = documents.get(msg.params.textDocument.uri);
    if (doc) doc.analysis = null;
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

  if (msg.method === "textDocument/hover") {
    const { textDocument, position } = msg.params;
    const at = resolveAt(textDocument.uri, position);
    if (!at) { sendResponse(msg.id, null); return; }
    let text = at.node ? getHoverInfo(at.node, at.module) : null;
    // Fall back to a type/kind hover when the cursor is on a type
    // annotation (parser object, not an AST node) - getHoverInfo on the
    // enclosing decl wouldn't show anything useful about the type name.
    if (!text) {
      const tok = identTokenAt(at.src, at.offset);
      if (tok) {
        text = hoverFromName(tok.text, at.module, at.analysis, {
          src: at.src,
          tokenStart: tok.start,
        });
      }
    }
    if (!text) { sendResponse(msg.id, null); return; }
    // Append the declaration's own comment block, if it has one. Resolved
    // through findDefinition so it works at a CALL SITE and across files -
    // hovering `padStart` in your code shows the header written above it in
    // std/core/strings.yoop. See docCommentAt in nav.js for why.
    const doc = docForHover(at);
    const value = doc
      ? "```yoop\n" + text + "\n```\n\n---\n\n" + doc
      : "```yoop\n" + text + "\n```";
    sendResponse(msg.id, { contents: { kind: "markdown", value } });
    return;
  }

  if (msg.method === "textDocument/definition") {
    const { textDocument, position } = msg.params;
    const at = resolveAt(textDocument.uri, position);
    if (!at) { sendResponse(msg.id, null); return; }
    // Compute the identifier under the cursor so findDefinition can fall
    // back to a name lookup when the AST hit is null (type annotations,
    // kind references - these aren't AST nodes with sourceLocs).
    const tok = identTokenAt(at.src, at.offset);
    const def = findDefinition(at.node, {
      module: at.module,
      modById: at.analysis.modById,
      moduleEnv: at.analysis.moduleEnv,
      programState: at.analysis.programState,
      tokenText: tok?.text,
      tokenStart: tok?.start,
      cursorOffset: at.offset,
    });
    if (!def) { sendResponse(msg.id, null); return; }
    // Read the target file's text to build a valid range. Prefer the open
    // overlay if one exists.
    let targetText = null;
    for (const d of documents.values()) {
      if (d.absPath === def.absPath) { targetText = d.text; break; }
    }
    if (targetText == null) {
      try { targetText = fs.readFileSync(def.absPath, "utf8"); } catch { targetText = ""; }
    }
    sendResponse(msg.id, {
      uri: absPathToUri(def.absPath),
      range: offsetToRange(targetText, def.pos, def.length),
    });
    return;
  }

  if (msg.method === "textDocument/documentSymbol") {
    const { textDocument } = msg.params;
    const at = resolveAt(textDocument.uri, { line: 0, character: 0 });
    if (!at) { sendResponse(msg.id, []); return; }
    sendResponse(msg.id, collectDocumentSymbols(at.module.ast, at.src));
    return;
  }

  if (msg.method === "textDocument/semanticTokens/full") {
    const { textDocument } = msg.params;
    const at = resolveAt(textDocument.uri, { line: 0, character: 0 });
    if (!at) { sendResponse(msg.id, { data: [] }); return; }
    sendResponse(msg.id, buildSemanticTokens(at.module.ast, at.src));
    return;
  }

  if (msg.method === "textDocument/references") {
    const { textDocument, position } = msg.params;
    const at = resolveAt(textDocument.uri, position);
    if (!at) { sendResponse(msg.id, []); return; }
    const tok = identTokenAt(at.src, at.offset);
    const target = identifyTarget(at.node, {
      module: at.module,
      modById: at.analysis.modById,
      moduleEnv: at.analysis.moduleEnv,
      programState: at.analysis.programState,
      tokenText: tok?.text,
    });
    if (!target) { sendResponse(msg.id, []); return; }
    const refs = findReferences(target, { modules: at.analysis.modules });
    const out = [];
    for (const ref of refs) {
      const text = textForAbsPath(ref.absPath);
      if (text == null) continue;
      out.push({
        uri: absPathToUri(ref.absPath),
        range: offsetToRange(text, ref.pos, ref.length),
      });
    }
    sendResponse(msg.id, out);
    return;
  }

  if (msg.method === "textDocument/rename") {
    const { textDocument, position, newName } = msg.params;
    const at = resolveAt(textDocument.uri, position);
    if (!at) { sendError(msg.id, -32603, "rename: no document"); return; }
    const tok = identTokenAt(at.src, at.offset);
    const result = renameAtCursor(at.node, newName, {
      module: at.module,
      modById: at.analysis.modById,
      moduleEnv: at.analysis.moduleEnv,
      programState: at.analysis.programState,
      modules: at.analysis.modules,
      tokenText: tok?.text,
      getModuleText: textForAbsPath,
    });
    if (result.error) { sendError(msg.id, -32602, result.error); return; }
    sendResponse(msg.id, result.workspaceEdit);
    return;
  }

  if (msg.method === "textDocument/completion") {
    const { textDocument, position } = msg.params;
    const at = resolveAt(textDocument.uri, position);
    if (!at) { sendResponse(msg.id, { isIncomplete: false, items: [] }); return; }
    const items = collectCompletions(at.module, at.src, position, {
      moduleEnv: at.analysis.moduleEnv,
      modById: at.analysis.modById,
    });
    sendResponse(msg.id, { isIncomplete: false, items });
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

// Keep `offsetToPos` reachable so importing modules can use it via this
// barrel - currently only nav.js does, but server.js also exposes it for
// future ad-hoc helpers.
export { offsetToPos };
