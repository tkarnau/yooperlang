// Single-entry analysis used by the LSP server.
//
// Treats `entryAbsPath` as the program entry, runs lex → parse → typecheck on
// the full module graph (with the supplied in-memory overlays for unsaved
// buffers), and returns diagnostics pinned to the entry file. Errors whose
// source position falls outside the entry file's source (i.e. originated in
// an imported module) are surfaced at the top of the entry file with an
// "[import]" prefix so the user still sees them.
//
// Today's typechecker does not record which module raised each error, so we
// can't reliably attribute import-internal errors to the right file. Pinning
// to the entry is correct for the common case (user edits a leaf program)
// and visible-but-imprecise for the rest.

import { loadModuleGraph } from "../jsyoopdriver/moduleGraph.js";
import { typecheckProgram } from "../jsyooptypecheck/typecheck.js";

export const Severity = {
  error: 1,
  warning: 2,
};

// overlays: Map<absPath, srcText>
// Returns: { diagnostics: [Diagnostic] }
//   Each Diagnostic: { absPath, pos, length, line, column, message, severity }
//   absPath is always entryAbsPath in this v1 implementation.
export function analyze(entryAbsPath, overlays = new Map()) {
  const diagnostics = [];

  let graph;
  try {
    graph = loadModuleGraph(entryAbsPath, {
      readFile: (absPath) => overlays.get(absPath) ?? null,
    });
  } catch (err) {
    diagnostics.push(diagFromThrown(err, entryAbsPath));
    return { diagnostics };
  }

  // Entry is the last module in the topo order (post-order leaves-first).
  const entryMod = graph.modules[graph.modules.length - 1];
  const entrySrcLen = entryMod ? entryMod.src.length : 0;

  let typecheckResult;
  try {
    typecheckResult = typecheckProgram(graph.modules);
  } catch (err) {
    diagnostics.push({
      absPath: entryAbsPath,
      pos: 0,
      length: 1,
      line: 1,
      column: 1,
      message: `internal: typecheck threw: ${err.message}`,
      severity: Severity.error,
    });
    return { diagnostics };
  }

  for (const err of typecheckResult.errors) {
    const loc = err.sourceLoc;
    const inEntry = loc && loc.pos >= 0 && loc.pos <= entrySrcLen;
    if (inEntry) {
      diagnostics.push({
        absPath: entryAbsPath,
        pos: loc.pos,
        length: 1,
        line: loc.line ?? 1,
        column: loc.column ?? 1,
        message: err.message,
        severity: Severity.error,
      });
    } else {
      diagnostics.push({
        absPath: entryAbsPath,
        pos: 0,
        length: 1,
        line: 1,
        column: 1,
        message: `[import] ${err.message}`,
        severity: Severity.error,
      });
    }
  }

  return { diagnostics };
}

function diagFromThrown(err, entryAbsPath) {
  if (err && err.isParseError) {
    return {
      absPath: entryAbsPath,
      pos: err.pos ?? 0,
      length: err.length ?? 1,
      line: err.line ?? 1,
      column: err.column ?? 1,
      message: err.rawMessage ?? err.message,
      severity: Severity.error,
    };
  }
  return {
    absPath: entryAbsPath,
    pos: 0,
    length: 1,
    line: 1,
    column: 1,
    message: err && err.message ? err.message : String(err),
    severity: Severity.error,
  };
}
