import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pushScope, declareInScope, lookupInScope } from "./scope.js";
import { PrimType } from "./types.js";

describe("scope chain", () => {
  it("a fresh scope has no bindings and no parent", () => {
    const s = pushScope(null);
    assert.equal(s.parent, null);
    assert.equal(s.bindings.size, 0);
  });

  it("declare + lookup in same scope", () => {
    const s = pushScope(null);
    const errs = [];
    declareInScope(s, "x", PrimType("int32"), "let", null, errs);
    assert.deepEqual(errs, []);
    const b = lookupInScope(s, "x");
    assert.deepEqual(b.type, PrimType("int32"));
    assert.equal(b.kind, "let");
    assert.equal(b.errObserved, false);
  });

  it("lookup walks up the parent chain", () => {
    const outer = pushScope(null);
    const inner = pushScope(outer);
    declareInScope(outer, "x", PrimType("int32"), "let", null, []);
    assert.deepEqual(lookupInScope(inner, "x").type, PrimType("int32"));
  });

  it("inner declaration shadows outer", () => {
    const outer = pushScope(null);
    const inner = pushScope(outer);
    declareInScope(outer, "x", PrimType("int32"), "let", null, []);
    declareInScope(inner, "x", PrimType("string"), "const", null, []);
    assert.deepEqual(lookupInScope(inner, "x").type, PrimType("string"));
    assert.deepEqual(lookupInScope(outer, "x").type, PrimType("int32"));
  });

  it("missing name returns null", () => {
    const s = pushScope(null);
    assert.equal(lookupInScope(s, "nope"), null);
  });

  it("redeclaration in the same scope pushes an error", () => {
    const s = pushScope(null);
    const errs = [];
    declareInScope(s, "x", PrimType("int32"), "let", null, errs);
    declareInScope(s, "x", PrimType("string"), "let", null, errs);
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /redeclaration of "x"/);
    // first binding is preserved
    assert.deepEqual(lookupInScope(s, "x").type, PrimType("int32"));
  });
});
