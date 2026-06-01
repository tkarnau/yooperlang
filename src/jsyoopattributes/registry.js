// Phase 11.A: registry of recognized `@<name>` attributes.
//
// Each entry pairs an attribute name with a small set of per-phase
// handlers. The parser, typechecker, comptime pass, and codegen each
// consult this registry rather than hardcoding per-attribute logic in
// the pipeline - adding a new attribute is one entry here plus any
// helpers it needs.
//
// Handler contract (all optional; default to no-op):
//
//   parsePhase(attrNode, ctx)
//     Called from the parser immediately after the attribute's arg
//     list and target are constructed. `ctx` provides `{ throwError,
//     source, peek }` for parse-time validation. Use this to reject
//     malformed shapes (wrong arg count, missing target block, etc.)
//     before downstream passes see the node.
//
//   typecheckPhase(attrNode, ctx)
//     Called from the typechecker once the target has been validated.
//     Use for cross-cutting checks an attribute imposes on its target
//     (e.g. `@expect` requiring an enclosing `@test`).
//
//   comptimePhase(attrNode, ctx)
//     Called from the new comptime pass (Phase 11.B/C). For now this is
//     where `@precompile` will invoke the interpreter once 11.B/C land.
//     Phase 11.A stubs it to error with a "not yet implemented" message.
//
//   codegenPhase(attrNode, ctx)
//     Called from codegen if the attribute survived the comptime pass.
//     For attributes that lower to runtime code (`@verify`, future
//     `@assert`), this is where they emit. For `@precompile` and `@test`
//     this should never be reached - those attributes consume their AST
//     node during comptime / pre-codegen and any leakage is a bug.
//
// The handler shape is permissive: a missing key on the entry means
// "no-op," letting attributes opt into only the phases they care about.

const REGISTRY = new Map();

// Phase 11.A inaugural consumer; Phase 11.C wires its comptimePhase
// to the interpreter. Two target shapes are accepted today:
//
//   @precompile const X: T = expr;     ← let/const initializer
//   @precompile let   X: T = expr;     ← (mutable not very useful yet)
//
// The block form (`@precompile { ... }`) parses but isn't evaluated
// yet - supporting it cleanly needs a notion of comptime-visible
// module-level state writes that the current interpreter doesn't
// have. Today it errors with a clear "block form not yet supported"
// at the comptimePhase so the surface is reserved for a later
// sub-phase without changing the parser's grammar.
//
// Unlike the opportunistic module-init fold (which silently falls
// back to runtime init on any failure), `@precompile` makes the
// fold *required*: if the decl doesn't end up with
// `comptimeFolded === true`, the attribute pass surfaces a hard
// build error so the user knows their comptime contract wasn't met.
REGISTRY.set("precompile", {
  parsePhase(attrNode, ctx) {
    if (attrNode.args && attrNode.args.length !== 0) {
      ctx.throwError(
        `@precompile takes no arguments; remove the '(...)'`,
        attrNode.argsSourceLoc ?? attrNode.sourceLoc,
      );
    }
    if (attrNode.target == null) {
      ctx.throwError(
        `@precompile requires a target - either a '{ ... }' block or a 'let' / 'const' declaration`,
        attrNode.sourceLoc,
      );
    }
  },
  comptimePhase(attrNode, ctx) {
    const tgt = attrNode.target;
    // Block form: Phase 11.D.18 runs these in the comptime pass.
    // The pass sets `attrNode.blockExecuted = true` on success, or
    // stashes a `blockFoldError` ComptimeError on failure (same
    // shape as the let/const path's `comptimeFoldError`). We
    // surface failures here as hard build errors so the user's
    // explicit `@precompile` commitment is never silently
    // dropped.
    if (tgt && tgt.kind === "BLOCK") {
      if (attrNode.blockExecuted) return;
      const inner = attrNode.blockFoldError;
      let suffix = "";
      if (inner) {
        suffix = `\n  reason: ${inner.message}`;
        if (inner.traceback && inner.traceback.length > 0) {
          suffix += `\n  traceback (innermost first):\n` +
            inner.traceback
              .map((f) => {
                const loc = f.sourceLoc;
                const where = loc
                  ? `line ${loc.line}:${loc.column}`
                  : "<unknown>";
                return `    at ${f.fnName} (${where})`;
              })
              .join("\n");
        }
      }
      ctx.error(
        attrNode,
        `@precompile { ... } block failed to evaluate at comptime - the ` +
          `block references something the comptime interpreter cannot ` +
          `evaluate (unsupported AST node, non-whitelisted extern, ` +
          `runtime-only task, etc.).${suffix}`,
      );
      return;
    }
    // let/const form: the comptime pass has already run; the decl
    // either folded (comptimeFolded === true + comptimeValue set)
    // or didn't. We surface the latter as a hard build error.
    if (
      tgt &&
      (tgt.kind === "LET_DECL" || tgt.kind === "CONST_DECL")
    ) {
      if (!tgt.comptimeFolded) {
        // Phase 11.E.1: if the comptime pass captured a
        // ComptimeError + traceback, include both in the
        // diagnostic. The originating error is usually deeper than
        // the @precompile site itself (e.g. "unsupported extern
        // called from <fn> called from <init>"), so the traceback
        // is the difference between "fold failed for X" and "fold
        // failed for X because Y at line Z called by W at line V".
        const inner = tgt.comptimeFoldError;
        let suffix = "";
        if (inner) {
          suffix = `\n  reason: ${inner.message}`;
          if (inner.traceback && inner.traceback.length > 0) {
            suffix += `\n  traceback (innermost first):\n` +
              inner.traceback
                .map((f) => {
                  const loc = f.sourceLoc;
                  const where = loc
                    ? `line ${loc.line}:${loc.column}`
                    : "<unknown>";
                  return `    at ${f.fnName} (${where})`;
                })
                .join("\n");
          }
        }
        ctx.error(
          attrNode,
          `@precompile fold failed for '${tgt.name}' - the initializer ` +
            `references something the comptime interpreter cannot evaluate ` +
            `(unsupported AST node, non-whitelisted extern, runtime-only ` +
            `task, etc.). Inspect the initializer expression for shapes ` +
            `outside Phase 11.B's supported set.${suffix}`,
        );
      }
      return;
    }
    // Unrecognized target shape. Parse phase already screens out
    // null targets; this branch catches anything else slipping
    // through.
    ctx.error(
      attrNode,
      `@precompile target shape '${tgt?.kind}' is not supported`,
    );
  },
});

export function getAttributeHandler(name) {
  return REGISTRY.get(name) ?? null;
}

export function knownAttributeNames() {
  return [...REGISTRY.keys()];
}

// Levenshtein distance for "did you mean" suggestions on unknown
// attribute names. Small enough to inline rather than pull a dep.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let curPrev = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(prev[j] + 1, prev[j - 1] + 1, curPrev + cost);
      curPrev = prev[j];
      prev[j] = next;
    }
  }
  return prev[b.length];
}

// Returns the best-matching registered attribute name within
// `maxDistance` edits, or null if nothing's close enough. Used to render
// a helpful "did you mean: @precompile?" suffix on unknown-attribute
// diagnostics.
export function suggestAttributeName(name, maxDistance = 2) {
  let best = null;
  let bestDist = Infinity;
  for (const known of REGISTRY.keys()) {
    const d = levenshtein(name, known);
    if (d < bestDist) {
      bestDist = d;
      best = known;
    }
  }
  if (best == null || bestDist > maxDistance) return null;
  return best;
}
