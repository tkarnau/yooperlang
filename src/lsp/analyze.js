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
  const autoloadedStdModuleIds = graph.autoloadedStdModuleIds ?? {};
  const modById = new Map(graph.modules.map((m) => [m.id, m]));
  const modByPath = new Map(graph.modules.map((m) => [m.absPath, m]));

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

  // Warnings are published alongside errors. Unlike the CLI, std/ is NOT
  // filtered out here: the editor squiggles whatever file you have open, and
  // if that file is std/core/vec.yoop you want to see its diagnostics.
  const raised = [
    ...typecheckResult.errors.map((e) => [e, Severity.error]),
    ...(typecheckResult.warnings ?? []).map((w) => [w, Severity.warning]),
  ];
  for (const [err, severity] of raised) {
    const loc = err.sourceLoc;
    // srcPath first: several source files can share one moduleId under
    // modules-as-directories, and modById keeps only one of them, so a
    // moduleId lookup would attribute a sibling's diagnostic to the wrong file.
    const owningMod =
      (err.srcPath && modByPath.get(err.srcPath)) ??
      (err.moduleId && modById.get(err.moduleId)) ??
      entryMod;
    diagnostics.push({
      absPath: owningMod?.absPath ?? entryAbsPath,
      pos: loc?.pos ?? 0,
      length: loc?.length ?? 1,
      line: loc?.line ?? 1,
      column: loc?.column ?? 1,
      message: err.message,
      severity,
      code: err.code,
    });
  }

  // The driver stamps this onto programState right after loading the graph
  // (see yoopiler.js), and codegen hard-errors without it the moment a
  // template literal needs std/core/format.yoop. Stamping it here too is what
  // lets an LSP feature run codegen over the same programState the driver
  // would have built - see lsp/substrate.js.
  if (typecheckResult.programState) {
    typecheckResult.programState.autoloadedStdModuleIds = autoloadedStdModuleIds;
  }

  return {
    diagnostics,
    modules: graph.modules,
    moduleEnv: typecheckResult.moduleEnv,
    programState: typecheckResult.programState,
    entryModule: entryMod,
    modById,
    autoloadedStdModuleIds,
  };
}

function diagFromThrown(err, entryAbsPath) {
  if (err && err.isParseError) {
    return {
      // moduleGraph stamps the failing file on the thrown parse error; without
      // it a syntax error in an imported module got squiggled in the entry file.
      absPath: err.srcPath ?? entryAbsPath,
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
