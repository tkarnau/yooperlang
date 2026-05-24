// Phase 11.A: registry of recognized `@<name>` attributes.
//
// Each entry pairs an attribute name with a small set of per-phase
// handlers. The parser, typechecker, comptime pass, and codegen each
// consult this registry rather than hardcoding per-attribute logic in
// the pipeline — adding a new attribute is one entry here plus any
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
//     this should never be reached — those attributes consume their AST
//     node during comptime / pre-codegen and any leakage is a bug.
//
// The handler shape is permissive: a missing key on the entry means
// "no-op," letting attributes opt into only the phases they care about.

const REGISTRY = new Map();

// Phase 11.A inaugural consumer. Parses fine; everything else stubbed
// until the interpreter lands in Phase 11.B/C. The error message names
// the gating phase so the user knows the syntax is wired but the engine
// behind it isn't yet.
REGISTRY.set("precompile", {
  parsePhase(attrNode, ctx) {
    // The target must be a block (statement form) or a let/const decl
    // (initializer form). Other shapes are rejected so we surface the
    // intent mismatch before downstream confusion.
    if (attrNode.args && attrNode.args.length !== 0) {
      ctx.throwError(
        `@precompile takes no arguments; remove the '(...)'`,
        attrNode.argsSourceLoc ?? attrNode.sourceLoc,
      );
    }
    if (attrNode.target == null) {
      ctx.throwError(
        `@precompile requires a target — either a '{ ... }' block or a 'let' / 'const' declaration`,
        attrNode.sourceLoc,
      );
    }
  },
  // Phase 11.C wires this up to the interpreter. Until then the
  // typechecker walks the target normally (so the body is still
  // typechecked even though it won't be evaluated), and the comptime
  // pass errors out.
  comptimePhase(attrNode, ctx) {
    ctx.error(
      attrNode,
      `@precompile cannot run yet — the compile-time interpreter lands in Phase 11.C. ` +
        `The attribute parses and typechecks; evaluation is pending.`,
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
