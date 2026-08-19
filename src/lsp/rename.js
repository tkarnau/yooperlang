// Rename: produce an LSP WorkspaceEdit by reusing findReferences().
//
// Every reference (including the decl itself) becomes a TextEdit that
// replaces the existing name with `newName`. Locations are bucketed by
// document URI so VSCode applies edits atomically per file.
//
// The validation pass rejects:
//   - newName empty / starts with a digit / contains non-identifier chars
//   - an unsupported target kind (struct fields are renameable by name
//     match, but enum variants are not, because variant ordinals are
//     ABI-significant)
//
// On rejection we return { error } and the server surfaces it via the
// LSP error response so the user gets a clear "rename not allowed"
// message rather than a silent no-op.

import { findReferences, identifyTarget, TargetKind } from "./references.js";
import { offsetToRange } from "./nav.js";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Build the WorkspaceEdit for renaming `target` to `newName`. Returns
// either { workspaceEdit } or { error } on validation failure.
//
// `ctx`:
//   modules        - analyze().modules
//   modById        - analyze().modById
//   moduleEnv      - analyze().moduleEnv
//   programState   - analyze().programState
//   getModuleText  - (absPath) => string. Used to render TextEdit ranges
//                    against the right document content; pass the
//                    server's overlay-aware text lookup.
export function prepareRename(target, newName, ctx) {
  if (!target) return { error: "no symbol under the cursor" };
  if (!IDENT_RE.test(newName)) return { error: `not a valid identifier: ${newName}` };
  if (target.kind === TargetKind.variant) {
    return {
      error: "renaming an enum variant changes its ABI tag - not supported via LSP rename",
    };
  }

  const refs = findReferences(target, ctx);
  if (refs.length === 0) return { error: "no references found" };

  const changes = {};
  for (const ref of refs) {
    const uri = pathToFileURL(ref.absPath).toString();
    const text = ctx.getModuleText(ref.absPath);
    if (text == null) continue;
    const range = offsetToRange(text, ref.pos, ref.length);
    (changes[uri] ??= []).push({ range, newText: newName });
  }

  return { workspaceEdit: { changes } };
}

// Convenience for the LSP server: resolve identify + rename in one call.
//
//   ctx: same shape as findDefinition's ctx, plus getModuleText.
export function renameAtCursor(node, newName, ctx) {
  const target = identifyTarget(node, ctx);
  if (!target) return { error: "no renameable symbol under the cursor" };
  return prepareRename(target, newName, ctx);
}

// File-system fallback text reader for tests / standalone use. The LSP
// server should pass its own overlay-aware reader instead.
export function defaultModuleTextReader(absPath) {
  try { return fs.readFileSync(absPath, "utf8"); } catch { return null; }
}
