#!/usr/bin/env node
// One-time migration script for the "de-magic the intrinsics + mandate
// namespace imports from std/" change. Walks examples/ and updates:
//
//   1. Bare intrinsic calls (heap_alloc / heap_free / string_as_bytes /
//      string_from_bytes_unchecked / array_slice) get prefixed with `intr.`
//      and the file gains `import * as intr from "std/core/intrinsics.yoop";`.
//
//   2. Named value imports from std/* are rewritten to namespace imports
//      using a fixed alias per module:
//         std/log.yoop                 -> log
//         std/debug.yoop               -> debug
//         std/core/vec.yoop            -> vec    (functions only; Vec stays a type import)
//         std/core/concurrency.yoop    -> conc   (now_ns, sleep_ms, wait_until, cancel)
//         std/core/strings.yoop        -> strings (functions only; nothing else exported)
//         std/core/bytes.yoop          -> bytes  (functions only; BytesParsed etc stay)
//         std/collections/vec.yoop     -> vec
//         std/collections/deque.yoop   -> deque  (functions only)
//         std/collections/map.yoop     -> map
//         std/collections/set.yoop     -> set
//         std/net/addr.yoop            -> addr   (functions only)
//         std/net/socket.yoop          -> socket
//         std/net/tcp.yoop             -> tcp
//         std/http/types.yoop          -> http_types
//         std/http/parser.yoop         -> http_parser
//         std/http/server.yoop         -> http_server
//      Call sites of those imported names get prefixed with the alias.
//
//   3. Bare wait_until(...) / cancel(...) calls are rewritten to
//      conc.wait_until(...) / conc.cancel(...) (only when std/core/concurrency
//      is imported).

import { promises as fs } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

const INTRINSIC_NAMES = ["heap_alloc", "heap_free", "string_as_bytes", "string_from_bytes_unchecked", "array_slice"];

// Per-module: { alias, valueExports: Set<string>, typeExports: Set<string> }
// typeExports stay named-importable; valueExports trigger namespace migration.
const STD_NAMESPACE_RULES = {
  "std/log.yoop":              { alias: "log",         values: new Set(["info", "warn", "error"]) },
  "std/debug.yoop":            { alias: "debug",       values: new Set(["panic", "unreachable", "assert"]) },
  "std/core/vec.yoop":         { alias: "vec",         values: new Set(["vec_new", "vec_push", "vec_get", "vec_set", "vec_clear", "vec_as_array"]) },
  "std/core/concurrency.yoop": { alias: "conc",        values: new Set(["now_ns", "sleep_ms", "wait_until", "cancel"]) },
  "std/core/strings.yoop":     { alias: "strings",     values: new Set(["string_from_bytes", "string_eq", "string_eq_ignore_ascii_case", "string_starts_with", "string_index_of", "string_slice", "string_hash", "string_concat", "string_concat_all"]) },
  "std/core/bytes.yoop":       { alias: "bytes",       values: new Set(["bytes_eq", "bytes_index_of", "bytes_index_of_seq", "bytes_starts_with", "bytes_eq_ignore_ascii_case", "bytes_slice", "bytes_copy", "bytes_parse_int"]) },
  "std/collections/deque.yoop":{ alias: "deque",       values: new Set(["deque_new", "deque_push_back", "deque_push_front", "deque_pop_back", "deque_pop_front", "deque_get", "deque_len", "deque_clear"]) },
  "std/collections/map.yoop":  { alias: "map",         values: new Set(["map_new", "map_insert", "map_get", "map_contains_key", "map_remove", "map_len", "map_clear", "map_iter", "string_key_ops", "int32_key_ops", "int64_key_ops", "uint64_key_ops", "bytes_key_ops"]) },
  "std/collections/set.yoop":  { alias: "set",         values: new Set(["set_new", "set_insert", "set_contains", "set_remove", "set_len"]) },
  "std/net/addr.yoop":         { alias: "addr",        values: new Set(["localhost", "any_addr"]) },
  "std/net/socket.yoop":       { alias: "socket",      values: new Set(["open_tcp_socket"]) },
  "std/net/tcp.yoop":          { alias: "tcp",         values: new Set(["tcp_listen", "tcp_accept", "tcp_connect"]) },
  "std/http/types.yoop":       { alias: "http_types",  values: new Set(["status_class_for", "status", "ok", "bad_request", "not_found", "method_not_allowed", "server_err", "reason_phrase", "headers_new", "headers_add", "headers_get", "headers_has", "response_new"]) },
  "std/http/parser.yoop":      { alias: "http_parser", values: new Set(["find_header_end", "parse_method", "parse_request_head"]) },
  "std/http/server.yoop":      { alias: "http_server", values: new Set(["serve_n"]) },
};

function visitFiles(dir, out) {
  // sync-ish recursive walk
  return fs.readdir(dir, { withFileTypes: true }).then(async (entries) => {
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await visitFiles(full, out);
      else if (e.isFile() && e.name.endsWith(".yoop")) out.push(full);
    }
  });
}

function rewriteFile(src) {
  let body = src;
  const before = body;

  // ── Step 1: rewrite std named imports to namespace imports ─────────────
  // Parse import { a, b as c, ... } from "std/...";  — preserve the type
  // exports (capitalized identifiers) as a named import; pull value names
  // out and ensure a `import * as <alias> from "std/..."` companion exists.
  const importRegex = /import\s*\{([^}]*)\}\s*from\s*"(std\/[^"]+)"\s*;/g;

  // Collect rewrites + aliases needed
  const replacements = [];
  const aliasesAdded = new Set();
  const valueRenames = new Map(); // localName -> { alias, exportName }

  for (const match of body.matchAll(importRegex)) {
    const [whole, inner, sourcePath] = match;
    const rule = STD_NAMESPACE_RULES[sourcePath];
    if (!rule) {
      // Path under std/ but no rule — leave alone (might be all types).
      continue;
    }
    // Split inner into specs: "a", "b as c", "...".
    const specs = inner.split(",").map((s) => s.trim()).filter(Boolean);
    const typeSpecs = [];
    const valueSpecs = [];
    for (const s of specs) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/.exec(s);
      if (!m) {
        // Unparseable — skip the whole import to be safe.
        typeSpecs.push(s);
        continue;
      }
      const exportName = m[1];
      const localName = m[2] ?? m[1];
      if (rule.values.has(exportName)) {
        valueSpecs.push({ exportName, localName });
      } else {
        typeSpecs.push(s);
      }
    }
    if (valueSpecs.length === 0) continue;

    let replacement = "";
    if (typeSpecs.length > 0) {
      replacement += `import { ${typeSpecs.join(", ")} } from "${sourcePath}";`;
    }
    if (!aliasesAdded.has(rule.alias)) {
      replacement += (replacement ? "\n" : "") + `import * as ${rule.alias} from "${sourcePath}";`;
      aliasesAdded.add(rule.alias);
    }
    for (const v of valueSpecs) {
      valueRenames.set(v.localName, { alias: rule.alias, exportName: v.exportName });
    }
    replacements.push({ whole, replacement });
  }

  // Apply import rewrites first.
  for (const { whole, replacement } of replacements) {
    body = body.replace(whole, replacement);
  }

  // Rewrite call sites of the renamed locals: bareName → alias.exportName.
  // Use lookbehind to skip member-accesses (`.name`) and struct-literal
  // shorthand (`{ name`, `, name:`); a plain identifier-followed-by-paren
  // covers the call positions we care about. Also covers value-position
  // references (assigning a function value to a fn-ptr field).
  for (const [local, { alias, exportName }] of valueRenames) {
    const re = new RegExp(`(?<![.A-Za-z0-9_])${local}(?=\\s*\\(|\\s*[,;)\\}\\]])`, "g");
    body = body.replace(re, `${alias}.${exportName}`);
  }

  // ── Step 2: rewrite bare intrinsic calls ────────────────────────────────
  let usesIntr = false;
  for (const name of INTRINSIC_NAMES) {
    const re = new RegExp(`(?<![.A-Za-z0-9_])${name}\\(`, "g");
    body = body.replace(re, () => { usesIntr = true; return `intr.${name}(`; });
  }
  if (usesIntr && !/import \* as intr from /.test(body)) {
    // Insert after the last import line.
    const lines = body.split("\n");
    let lastImportIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^import(\s|\.unsafe)/.test(lines[i])) lastImportIdx = i;
    }
    const importLine = `import * as intr from "std/core/intrinsics.yoop";`;
    if (lastImportIdx >= 0) {
      lines.splice(lastImportIdx + 1, 0, importLine);
    } else {
      // No imports — find first non-comment, non-blank line and insert above.
      let insertAt = 0;
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t === "" || t.startsWith("//")) continue;
        insertAt = i;
        break;
      }
      lines.splice(insertAt, 0, importLine, "");
    }
    body = lines.join("\n");
  }

  return body === before ? null : body;
}

async function main() {
  const targets = [];
  await visitFiles(path.join(repoRoot, "examples"), targets);

  let touched = 0;
  for (const file of targets) {
    const src = await fs.readFile(file, "utf8");
    const rewritten = rewriteFile(src);
    if (rewritten !== null) {
      await fs.writeFile(file, rewritten);
      touched++;
      console.log("rewrote", path.relative(repoRoot, file));
    }
  }
  console.log(`\n${touched} / ${targets.length} files migrated.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
