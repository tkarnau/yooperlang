import { ASTNodeKind } from "../contracts.js";

// "Does control flow always leave this statement?"
//
// Written for the handler form of `?` (`expr? e { ... }`), whose block is
// required to diverge on every path: the block runs INSTEAD of producing a
// value, so falling out the bottom would leave the binding it feeds
// uninitialized. Reporting that at the `}` is the whole safety story for the
// form, and it is a static question, so it gets a static answer here.
//
// The rule is DIVERGES, not "ends in a return". `break` and `continue` leave
// the block just as permanently as far as the enclosing expression is
// concerned, which is what makes this legal inside a loop:
//
//     for row in rows {
//         let v = step(ref st)? e { continue; };
//     }
//
// Deliberately conservative: anything not listed answers false. A false
// negative costs the user an explicit `return`; a false positive would let
// codegen fall through into the Ok path with no value in hand.
export function alwaysDiverges(stmt) {
  if (!stmt) return false;
  switch (stmt.kind) {
    // The terminators themselves.
    case ASTNodeKind.RETURN_STATEMENT:
    case ASTNodeKind.BREAK_STATEMENT:
    case ASTNodeKind.CONTINUE_STATEMENT:
      return true;

    // A block diverges as soon as ANY of its statements does - everything
    // after that point is unreachable.
    case ASTNodeKind.BLOCK:
      return (stmt.body ?? []).some(alwaysDiverges);

    // Both halves must diverge, which means an `if` with no `else` never
    // does. `else if` chains work because the else slot holds a nested
    // IF_STATEMENT and this recurses into it.
    case ASTNodeKind.IF_STATEMENT:
      return (
        Boolean(stmt.elseBody) &&
        alwaysDiverges(stmt.body) &&
        alwaysDiverges(stmt.elseBody)
      );

    // Exhaustive plus every-arm-diverges. Without exhaustiveness there is an
    // implicit fallthrough path that diverges nowhere.
    case ASTNodeKind.SWITCH_STATEMENT: {
      if (!stmt.isExhaustive) return false;
      const arms = stmt.arms ?? [];
      if (arms.length === 0 && !stmt.defaultArm) return false;
      if (!arms.every((a) => alwaysDiverges(a.body))) return false;
      if (stmt.defaultArm && !alwaysDiverges(stmt.defaultArm)) return false;
      return true;
    }

    // A block-owning kind binding (`ephemeral scope(a) { ... }`, or the
    // `disposable x = v { ... }` form) hangs its block off the DECL rather
    // than appearing as a BLOCK statement, so the body has to be reached
    // through `trailingBlock`. Without this, a function whose only `return`
    // sits inside a region scope reads as falling off the end - which is
    // exactly what examples/playground/diskscope's `relayout` does.
    case ASTNodeKind.LET_DECL:
    case ASTNodeKind.CONST_DECL:
      return alwaysDiverges(stmt.trailingBlock);

    // `while (true) { ... }` with no `break` reaching it never falls out the
    // bottom. This case has to be handled or every accept/event loop written
    // as `while (true)` looks like a missing return.
    //
    // Any other loop is NOT counted: its condition may be false on entry, so
    // the body might not run at all.
    case ASTNodeKind.WHILE_STATEMENT:
      return isLiteralTrue(stmt.expression) && !hasEscapingBreak(stmt.body);

    default:
      return false;
  }
}

// The dual of alwaysDiverges: index of the first statement in `body` that
// control can never reach, or -1 if every statement is reachable.
//
// This is free - `alwaysDiverges` on a BLOCK is already "does any statement
// diverge", and everything after the first one that does is by definition
// dead. The only new part is reporting it.
//
// Soundness runs the right way for a diagnostic. alwaysDiverges is
// conservative in the safe direction (it answers `true` only when divergence
// is CERTAIN), so this never flags live code; it just misses some dead code,
// which costs nothing.
export function firstUnreachableIndex(body) {
  if (!Array.isArray(body)) return -1;
  for (let i = 0; i < body.length - 1; i++) {
    if (alwaysDiverges(body[i])) return i + 1;
  }
  return -1;
}

function isLiteralTrue(expr) {
  return expr?.kind === ASTNodeKind.BOOL_LITERAL && expr.value === true;
}

// Does this statement contain a `break` that targets the loop we are asking
// about? Descent stops at any construct that CAPTURES a break - a nested
// loop, or a `switch` (codegen points an arm's break at the switch's end
// label, not the enclosing loop). A `break` found outside those belongs to
// the loop in question.
function hasEscapingBreak(stmt) {
  if (!stmt) return false;
  switch (stmt.kind) {
    case ASTNodeKind.BREAK_STATEMENT:
      return true;

    // These capture a `break` of their own; anything inside is not ours.
    case ASTNodeKind.WHILE_STATEMENT:
    case ASTNodeKind.FOR_LOOP:
    case ASTNodeKind.FOR_IN_LOOP:
    case ASTNodeKind.SWITCH_STATEMENT:
      return false;

    case ASTNodeKind.BLOCK:
      return (stmt.body ?? []).some(hasEscapingBreak);

    case ASTNodeKind.IF_STATEMENT:
      return (
        hasEscapingBreak(stmt.body) || hasEscapingBreak(stmt.elseBody)
      );

    default:
      return false;
  }
}
