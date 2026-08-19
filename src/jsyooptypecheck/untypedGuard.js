// The backstop for "an untyped literal reached codegen".
//
// Codegen does zero type-checking and assumes every node carries a concrete
// `resolvedType`. `untypedInt` / `untypedFloat` are literal PLACEHOLDERS - the
// typechecker is supposed to pin every one of them to a real type at whatever
// context consumes it (an annotation, an assignment, an argument, the typed
// side of a comparison). When one slips through, `llvmType` hits its `default`
// arm and throws:
//
//     Error: llvmType: unhandled yooper type kind "untypedInt"
//
// with a JS stack trace, no source location, and nothing telling the user
// which expression in their program is at fault. Every instance of it is a
// missing pinning rule in checkExpr - a template interpolation (`${-7 / 2}`)
// and a comparison (`x == -24 + 176`) have both reached codegen that way -
// and none of them are anything the user did wrong.
//
// This is where the next such gap surfaces instead, so that it costs a
// diagnostic with a caret rather than an lldb session. It runs only when the
// program is otherwise clean, because an untyped node downstream of a real
// type error is an expected consequence of that error rather than a new
// problem.
//
// The message says "internal" and asks for a report on purpose: reaching here
// always means a compiler bug, never a user mistake, and a diagnostic that
// blames the user for one is worse than the crash it replaced.

import { ASTNodeKind } from "../contracts.js";
import { pushError } from "./errors.js";
import { typeKinds } from "./types.js";

// Nodes codegen defends against on its own. A BARE literal still carrying its
// untyped placeholder is emitted correctly (INT_LITERAL / FLOAT_LITERAL pick a
// default at the emitter), so flagging those would be a false positive on
// working programs. Anything COMPOUND - a binary expression, a call, a field
// access - has no such defence, which is exactly the gap both real bugs fell
// into.
const SELF_DEFENDING = new Set([
  ASTNodeKind.INT_LITERAL,
  ASTNodeKind.FLOAT_LITERAL,
  ASTNodeKind.NULL_LITERAL,
]);

const UNTYPED_KINDS = new Set([
  typeKinds.untypedInt,
  typeKinds.untypedFloat,
]);

// Every value in `typeKinds`, used to stop the walk at a TYPE object. Types
// form a large, deeply shared graph (a struct's fields point at types that
// point back), and nothing inside one is an AST node, so descending into them
// is pure cost. ASTNodeKind values are SCREAMING_SNAKE and typeKinds values
// are camelCase, so `kind` alone tells the two apart.
const TYPE_KIND_VALUES = new Set(Object.values(typeKinds));

// Walk every AST node reachable from `root` and report any whose resolvedType
// is still an untyped literal placeholder. `errors` is the usual accumulating
// diagnostics array.
export function checkNoUntypedSurvivors(root, errors) {
  const seen = new WeakSet();
  visit(root, errors, seen);
}

function visit(value, errors, seen) {
  if (value === null || typeof value !== "object") return;
  if (value instanceof Map || value instanceof Set) return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) visit(item, errors, seen);
    return;
  }

  // A type object, not an AST node - do not descend.
  if (typeof value.kind === "string" && TYPE_KIND_VALUES.has(value.kind)) {
    return;
  }

  const t = value.resolvedType;
  if (
    t &&
    UNTYPED_KINDS.has(t.kind) &&
    typeof value.kind === "string" &&
    !SELF_DEFENDING.has(value.kind)
  ) {
    pushError(
      errors,
      value,
      `internal: this expression still has an unpinned literal type ` +
        `(${t.kind}) after typecheck, and codegen cannot lower it. This is a ` +
        `compiler bug, not a mistake in your program - please report it. ` +
        `Workaround: bind the expression to a local with an explicit type ` +
        `annotation first.`,
    );
  }

  for (const key of Object.keys(value)) {
    visit(value[key], errors, seen);
  }
}
