import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { parse } from "./jsyooparser/parser.js";
import { ASTNodeKind } from "./contracts.js";
import { formatDiagnostic } from "./helpers.js";

const TEMPLATE_PATH = fileURLToPath(new URL("./astViewerTemplate.html", import.meta.url));

let nextId = 1;

function isAstNode(v) {
  return v && typeof v === "object" && typeof v.kind === "string" && ASTNodeKind[v.kind];
}

function serialize(node, label) {
  if (!isAstNode(node)) return null;
  const out = {
    id: nextId++,
    kind: node.kind,
    fields: {},
    children: [],
  };
  if (label) out.label = label;
  if (node.sourceLoc) {
    out.loc = {
      pos: node.sourceLoc.pos,
      length: node.sourceLoc.length ?? 0,
      line: node.sourceLoc.line,
      column: node.sourceLoc.column,
    };
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "kind" || k === "sourceLoc") continue;
    if (Array.isArray(v)) {
      const items = [];
      for (const item of v) {
        const child = serialize(item);
        if (child) items.push(child);
      }
      if (items.length > 0) {
        out.children.push({ id: nextId++, kind: "GROUP", label: k, children: items });
      } else if (v.length > 0) {
        out.fields[k] = sanitizeForJson(v);
      }
    } else if (isAstNode(v)) {
      const child = serialize(v, k);
      if (child) out.children.push(child);
    } else if (v !== null && v !== undefined && typeof v !== "function") {
      out.fields[k] = sanitizeForJson(v);
    }
  }
  return out;
}

function sanitizeForJson(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

// Parse `inputFile` and return the same serialized payload the HTML viewer
// embeds: { filename, source, ast }. Shared by dumpAst (HTML) and
// dumpAstJson (raw JSON). Exits with a formatted diagnostic on parse error.
function buildAstPayload(inputFile) {
  const absPath = fs.realpathSync(path.resolve(inputFile));
  const src = fs.readFileSync(absPath, "utf8");

  let ast;
  try {
    ast = parse(src);
  } catch (err) {
    if (err && err.isParseError) {
      console.error(
        formatDiagnostic({
          filePath: inputFile,
          src,
          loc: { pos: err.pos, line: err.line, column: err.column, length: err.length },
          message: err.rawMessage ?? err.message,
        }),
      );
      process.exit(1);
    }
    throw err;
  }

  nextId = 1;
  return { filename: inputFile, source: src, ast: serialize(ast) };
}

export function dumpAst(inputFile, outFile) {
  const { filename, source, ast: serialized } = buildAstPayload(inputFile);

  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const payload = JSON.stringify({
    filename,
    source,
    ast: serialized,
  })
    .replace(/<\/script/gi, "<\\/script")
    .replace(/<!--/g, "<\\!--");

  const html = template.replace("__DATA__", payload);
  fs.writeFileSync(outFile, html, "utf8");
  console.log(`AST dumped: ${outFile}`);
}

// Raw-JSON sibling of dumpAst: writes the { filename, source, ast } payload
// (same serialize() shape the HTML viewer embeds) so external tools can load
// an AST without scraping HTML. Consumed by the algoscope playground.
export function dumpAstJson(inputFile, outFile) {
  const payload = buildAstPayload(inputFile);
  fs.writeFileSync(outFile, JSON.stringify(payload), "utf8");
  console.log(`AST JSON dumped: ${outFile}`);
}
