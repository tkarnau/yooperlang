// Phase 11.B: comptime evaluation errors.
//
// `ComptimeError` is the unified error type produced by both the lower
// pass (AST → bytecode) and the interpreter. Each carries a yoop
// source location plus an optional frame-stack traceback so the user
// sees the same level of locality they get from the typechecker.
//
// In Phase 11.B these errors are *silent fallbacks* when surfaced from
// the opportunistic module-init folding path — the comptime pass
// catches them and leaves the decl to be runtime-initialized as before.
// In Phase 11.C (`@precompile`) they become hard build errors that
// surface to the user, with full traceback rendering.

export class ComptimeError extends Error {
  constructor(message, sourceLoc, traceback = null) {
    super(message);
    this.name = "ComptimeError";
    this.isComptimeError = true;
    this.sourceLoc = sourceLoc ?? null;
    this.traceback = traceback;
  }
}

// Render a traceback array (innermost-frame-first) into a multi-line
// string suitable for use as a diagnostic suffix. Each frame contributes
// one line: `  at <fnName> (<file>:<line>:<col>)`.
export function formatTraceback(frames) {
  if (!frames || frames.length === 0) return "";
  return frames
    .map((f) => {
      const loc = f.sourceLoc;
      const where = loc
        ? `${f.fileName ?? "<unknown>"}:${loc.line}:${loc.column}`
        : "<unknown>";
      return `  at ${f.fnName ?? "<anon>"} (${where})`;
    })
    .join("\n");
}
