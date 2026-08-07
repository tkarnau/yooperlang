import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ASTNodeKind } from "../contracts.js";
import { alwaysDiverges } from "./diverge.js";

const ret = () => ({ kind: ASTNodeKind.RETURN_STATEMENT });
const brk = () => ({ kind: ASTNodeKind.BREAK_STATEMENT });
const cont = () => ({ kind: ASTNodeKind.CONTINUE_STATEMENT });
const expr = () => ({ kind: ASTNodeKind.EXPRESSION_STATEMENT });
const block = (...body) => ({ kind: ASTNodeKind.BLOCK, body });

const ifStmt = (body, elseBody = null) => ({
  kind: ASTNodeKind.IF_STATEMENT,
  body,
  elseBody,
});

const switchStmt = (arms, { isExhaustive = true, defaultArm = null } = {}) => ({
  kind: ASTNodeKind.SWITCH_STATEMENT,
  arms: arms.map((body) => ({ body })),
  defaultArm,
  isExhaustive,
});

describe("alwaysDiverges - terminators", () => {
  it("counts return, break and continue", () => {
    assert.equal(alwaysDiverges(ret()), true);
    assert.equal(alwaysDiverges(brk()), true);
    assert.equal(alwaysDiverges(cont()), true);
  });

  it("does not count an ordinary statement", () => {
    assert.equal(alwaysDiverges(expr()), false);
  });

  it("tolerates a null statement", () => {
    assert.equal(alwaysDiverges(null), false);
  });
});

describe("alwaysDiverges - blocks", () => {
  it("diverges when any statement does, not just the last", () => {
    assert.equal(alwaysDiverges(block(expr(), ret(), expr())), true);
  });

  it("does not diverge when no statement does", () => {
    assert.equal(alwaysDiverges(block(expr(), expr())), false);
  });

  it("does not diverge when empty", () => {
    assert.equal(alwaysDiverges(block()), false);
  });
});

describe("alwaysDiverges - if", () => {
  it("requires both arms", () => {
    assert.equal(alwaysDiverges(ifStmt(block(ret()), block(ret()))), true);
  });

  it("does not diverge with no else, even if the then-arm returns", () => {
    assert.equal(alwaysDiverges(ifStmt(block(ret()))), false);
  });

  it("does not diverge when only one arm does", () => {
    assert.equal(alwaysDiverges(ifStmt(block(ret()), block(expr()))), false);
  });

  it("sees through an else-if chain", () => {
    // if (a) { return } else if (b) { return } else { return }
    const chain = ifStmt(
      block(ret()),
      ifStmt(block(ret()), block(ret())),
    );
    assert.equal(alwaysDiverges(chain), true);
  });

  it("rejects an else-if chain whose tail can fall through", () => {
    const chain = ifStmt(block(ret()), ifStmt(block(ret())));
    assert.equal(alwaysDiverges(chain), false);
  });
});

describe("alwaysDiverges - switch", () => {
  it("diverges when exhaustive and every arm diverges", () => {
    const s = switchStmt([block(ret()), block(cont())]);
    assert.equal(alwaysDiverges(s), true);
  });

  it("does not diverge when one arm falls through", () => {
    const s = switchStmt([block(ret()), block(expr())]);
    assert.equal(alwaysDiverges(s), false);
  });

  it("does not diverge when not exhaustive, even if all arms diverge", () => {
    const s = switchStmt([block(ret())], { isExhaustive: false });
    assert.equal(alwaysDiverges(s), false);
  });

  it("requires the default arm to diverge too", () => {
    const s = switchStmt([block(ret())], { defaultArm: block(expr()) });
    assert.equal(alwaysDiverges(s), false);
  });

  it("accepts a diverging default arm", () => {
    const s = switchStmt([block(ret())], { defaultArm: block(ret()) });
    assert.equal(alwaysDiverges(s), true);
  });
});

const whileStmt = (cond, body) => ({
  kind: ASTNodeKind.WHILE_STATEMENT,
  expression: cond,
  body,
});
const boolLit = (value) => ({ kind: ASTNodeKind.BOOL_LITERAL, value });
const ident = (name) => ({ kind: ASTNodeKind.IDENT, name });

describe("alwaysDiverges - loops", () => {
  it("does not count a conditional loop, even if the body returns", () => {
    // The condition may be false on entry, so the body might never run.
    assert.equal(alwaysDiverges(whileStmt(ident("k"), block(ret()))), false);
  });

  it("counts `while (true)` with no break", () => {
    const w = whileStmt(boolLit(true), block(expr()));
    assert.equal(alwaysDiverges(w), true);
  });

  it("does not count `while (true)` when a break escapes it", () => {
    const w = whileStmt(boolLit(true), block(ifStmt(block(brk()))));
    assert.equal(alwaysDiverges(w), false);
  });

  it("ignores a break captured by a nested loop", () => {
    const inner = whileStmt(ident("k"), block(brk()));
    const w = whileStmt(boolLit(true), block(inner));
    assert.equal(alwaysDiverges(w), true);
  });

  it("ignores a break captured by a nested switch", () => {
    // A `break` in a switch arm targets the switch's end label, not the
    // enclosing loop, so it does not let control escape the `while (true)`.
    const inner = switchStmt([block(brk())]);
    const w = whileStmt(boolLit(true), block(inner));
    assert.equal(alwaysDiverges(w), true);
  });

  it("does not count `while (false)`", () => {
    assert.equal(alwaysDiverges(whileStmt(boolLit(false), block(ret()))), false);
  });
});

describe("alwaysDiverges - block-owning kind declarations", () => {
  // `ephemeral allocatorScope(a) { ... return v; }` parses as a CONST_DECL
  // carrying a trailingBlock, so the return is not a statement of the
  // enclosing body. Reaching it is what keeps diskscope's `relayout` valid.
  it("reaches a return inside a decl's trailing block", () => {
    const decl = {
      kind: ASTNodeKind.CONST_DECL,
      trailingBlock: block(expr(), ret()),
    };
    assert.equal(alwaysDiverges(decl), true);
  });

  it("does not diverge when the trailing block falls through", () => {
    const decl = {
      kind: ASTNodeKind.CONST_DECL,
      trailingBlock: block(expr()),
    };
    assert.equal(alwaysDiverges(decl), false);
  });

  it("does not diverge for a decl with no trailing block", () => {
    assert.equal(alwaysDiverges({ kind: ASTNodeKind.LET_DECL }), false);
  });
});
