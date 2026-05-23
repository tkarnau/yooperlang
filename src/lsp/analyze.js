// Single-entry analysis used by the LSP server.
//
// Treats `entryAbsPath` as the program entry, runs lex → parse → typecheck on
// the full module graph (with the supplied in-memory overlays for unsaved
// buffers), and returns diagnostics attributed to whichever module produced
// each error (via the `moduleId` the typechecker stamps onto every error).
// Errors without a moduleId fall back to the entry module.

import { loadModuleGraph } from "../jsyoopdriver/moduleGraph.js";
import { typecheckProgram } from "../jsyooptypecheck/typecheck.js";

export const Severity = {
  error: 1,
  warning: 2,
};

// overlays: Map<absPath, srcText>
// Returns: { diagnostics, modules, moduleEnv, programState, entryModule, modById }
//   diagnostics: [{ absPath, pos, length, line, column, message, severity }]
//   modules: typechecked module list (each carries `ast` with resolvedType
//     filled in on every expression/decl node). Empty array if loading failed.
//   moduleEnv: Map<moduleId, env> from typecheckProgram (localSymbols,
//     structTable, traitTable, etc.). Null on failure.
//   programState: the instantiation registry + global state. Null on failure.
//   entryModule: the entry-point module (last in topo order). May be null on
//     load failure.
//   modById: Map<moduleId, module> for fast cross-module lookups.
export function analyze(entryAbsPath, overlays = new Map()) {
  const diagnostics = [];

  let graph;
  try {
    graph = loadModuleGraph(entryAbsPath, {
      readFile: (absPath) => overlays.get(absPath) ?? null,
    });
  } catch (err) {
    diagnostics.push(diagFromThrown(err, entryAbsPath));
    return {
      diagnostics,
      modules: [],
      moduleEnv: null,
      programState: null,
      entryModule: null,
      modById: new Map(),
    };
  }

  // Entry is the last module in the topo order (post-order leaves-first).
  const entryMod = graph.modules[graph.modules.length - 1];
  const modById = new Map(graph.modules.map((m) => [m.id, m]));

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
    return {
      diagnostics,
      modules: graph.modules,
      moduleEnv: null,
      programState: null,
      entryModule: entryMod,
      modById,
    };
  }

  for (const err of typecheckResult.errors) {
    const loc = err.sourceLoc;
    const owningMod = (err.moduleId && modById.get(err.moduleId)) ?? entryMod;
    diagnostics.push({
      absPath: owningMod?.absPath ?? entryAbsPath,
      pos: loc?.pos ?? 0,
      length: loc?.length ?? 1,
      line: loc?.line ?? 1,
      column: loc?.column ?? 1,
      message: err.message,
      severity: Severity.error,
    });
  }

  return {
    diagnostics,
    modules: graph.modules,
    moduleEnv: typecheckResult.moduleEnv,
    programState: typecheckResult.programState,
    entryModule: entryMod,
    modById,
  };
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
