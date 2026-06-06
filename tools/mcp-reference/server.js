#!/usr/bin/env node
// Yooperlang language-reference MCP server.
//
// A Model Context Protocol server that exposes the Yooperlang language
// reference to MCP-aware clients (Claude Desktop, Cursor, etc.) so an
// assistant can read the spec and search it while helping you write
// Yooperlang.
//
// It is intentionally dependency-free: MCP is JSON-RPC 2.0 over stdio,
// and we speak it directly rather than pulling in the SDK. That keeps
// this tool aligned with the rest of the project (plain Node, no npm
// packages) and means there is nothing to install - just point your MCP
// client at `node tools/mcp-reference/server.js`.
//
// What it serves:
//   - resources: the spec (yoop://spec) and every std module
//     (yoop://std/<path>), read straight from the repo so they never
//     drift from source.
//   - a tool: search_reference(query) - section-aware search over
//     SPEC.md, returns the matching sections.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "yooperlang-reference", version: "0.1.0" };

// This file lives at <repo>/tools/mcp-reference/server.js.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const SPEC_PATH = path.join(repoRoot, "SPEC.md");
const STD_DIR = path.join(repoRoot, "std");

// --- repo content helpers -------------------------------------------------

function readSpec() {
  return fs.readFileSync(SPEC_PATH, "utf8");
}

// Every std/*.yoop file, returned as { uri, relPath, absPath }.
function listStdModules() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.name.endsWith(".yoop")) {
        const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
        out.push({ uri: `yoop://${rel}`, relPath: rel, absPath: abs });
      }
    }
  };
  if (fs.existsSync(STD_DIR)) walk(STD_DIR);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

// Split SPEC.md into sections keyed by their `##` / `###` headings.
function specSections() {
  const lines = readSpec().split("\n");
  const sections = [];
  let current = { heading: "(preamble)", body: [] };
  for (const line of lines) {
    if (/^#{2,3} /.test(line)) {
      if (current.body.length) sections.push(current);
      current = { heading: line.replace(/^#{2,3}\s*/, ""), body: [line] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.length) sections.push(current);
  return sections.map((s) => ({ heading: s.heading, text: s.body.join("\n").trim() }));
}

function searchReference(query) {
  const needle = String(query || "").toLowerCase().trim();
  if (!needle) return "Provide a non-empty query.";
  const hits = specSections().filter(
    (s) => s.heading.toLowerCase().includes(needle) || s.text.toLowerCase().includes(needle),
  );
  if (hits.length === 0) {
    return `No sections of SPEC.md matched "${query}".`;
  }
  // Heading matches first, then keep it readable by capping output.
  hits.sort((a, b) => {
    const ah = a.heading.toLowerCase().includes(needle) ? 0 : 1;
    const bh = b.heading.toLowerCase().includes(needle) ? 0 : 1;
    return ah - bh;
  });
  const shown = hits.slice(0, 8);
  const header = `${hits.length} section(s) of SPEC.md matched "${query}"` +
    (hits.length > shown.length ? ` (showing first ${shown.length})` : "") + ":\n";
  return header + "\n\n---\n\n" + shown.map((s) => s.text).join("\n\n---\n\n");
}

// --- MCP method handlers --------------------------------------------------

function handleInitialize() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {}, resources: {} },
    serverInfo: SERVER_INFO,
  };
}

function handleResourcesList() {
  const resources = [
    {
      uri: "yoop://spec",
      name: "Yooperlang language specification (SPEC.md)",
      mimeType: "text/markdown",
    },
    ...listStdModules().map((m) => ({
      uri: m.uri,
      name: m.relPath,
      mimeType: "text/plain",
    })),
  ];
  return { resources };
}

function handleResourcesRead(params) {
  const uri = params && params.uri;
  if (uri === "yoop://spec") {
    return { contents: [{ uri, mimeType: "text/markdown", text: readSpec() }] };
  }
  // yoop://std/... -> a repo-relative file. Resolve and guard against escapes.
  if (typeof uri === "string" && uri.startsWith("yoop://")) {
    const rel = uri.slice("yoop://".length);
    const abs = path.resolve(repoRoot, rel);
    if (abs.startsWith(repoRoot) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return { contents: [{ uri, mimeType: "text/plain", text: fs.readFileSync(abs, "utf8") }] };
    }
  }
  throw { code: -32602, message: `Unknown resource: ${uri}` };
}

function handleToolsList() {
  return {
    tools: [
      {
        name: "search_reference",
        description:
          "Search the Yooperlang language specification (SPEC.md) and return " +
          "the matching sections. Use for questions about syntax and semantics " +
          "(traits, kinds, generics, enums, tasks, imports, etc.).",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keyword or phrase to look for." },
          },
          required: ["query"],
        },
      },
    ],
  };
}

function handleToolsCall(params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  if (name === "search_reference") {
    return { content: [{ type: "text", text: searchReference(args.query) }] };
  }
  throw { code: -32602, message: `Unknown tool: ${name}` };
}

function dispatch(method, params) {
  switch (method) {
    case "initialize":
      return handleInitialize();
    case "ping":
      return {};
    case "resources/list":
      return handleResourcesList();
    case "resources/read":
      return handleResourcesRead(params);
    case "tools/list":
      return handleToolsList();
    case "tools/call":
      return handleToolsCall(params);
    default:
      throw { code: -32601, message: `Method not found: ${method}` };
  }
}

// --- JSON-RPC over stdio --------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function handleMessage(msg) {
  // Notifications have no id and get no response.
  const isNotification = msg.id === undefined || msg.id === null;
  try {
    const result = dispatch(msg.method, msg.params);
    if (!isNotification) send({ jsonrpc: "2.0", id: msg.id, result });
  } catch (err) {
    if (isNotification) return;
    const error =
      err && typeof err.code === "number"
        ? { code: err.code, message: err.message }
        : { code: -32603, message: String((err && err.message) || err) };
    send({ jsonrpc: "2.0", id: msg.id, error });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore malformed lines
    }
    handleMessage(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
