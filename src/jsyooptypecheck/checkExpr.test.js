import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveExprType } from "./checkExpr.js";
import { ASTNode, ASTNodeKind } from "../contracts.js";
import { primAnnotations, resolveTypeFromName, typeKinds } from "./types.js";
import { declareInScope, pushScope } from "./scope.js";

describe("resolveExprType", () => {
  it("resolves unknown nodes to error type", () => {
    const unknownNode = new ASTNode(ASTNodeKind.FAIL_TEST_KIND);
    const ctx = { errors: [] };
    const type = resolveExprType(unknownNode, {}, ctx);
    assert.equal(type.kind, "error");
    assert.equal(ctx.errors.length, 1);
    assert.equal(
      ctx.errors[0].message,
      'typecheck: unhandled expression kind "FAIL_TEST_KIND"',
    );
  });
  it("resolves int literal to untyped int", () => {
    const intNode = new ASTNode(ASTNodeKind.INT_LITERAL);
    intNode.value = 42;
    const ctx = { errors: [] };
    const type = resolveExprType(intNode, {}, ctx);
    assert.equal(type.kind, typeKinds.untypedInt);
    assert.equal(intNode.resolvedType, type);
    assert.equal(ctx.errors.length, 0);
  });
  it("resolves float literal to untyped float", () => {
    const floatNode = new ASTNode(ASTNodeKind.FLOAT_LITERAL);
    floatNode.value = 3.14;
    const ctx = { errors: [] };
    const type = resolveExprType(floatNode, {}, ctx);
    assert.equal(type.kind, typeKinds.untypedFloat);
    assert.equal(floatNode.resolvedType, type);
    assert.equal(ctx.errors.length, 0);
  });
  it("resolves string literal to string", () => {
    const stringNode = new ASTNode(ASTNodeKind.STRING_LITERAL);
    stringNode.value = "hello";
    const ctx = { errors: [] };
    const type = resolveExprType(stringNode, {}, ctx);
    assert.equal(type.kind, typeKinds.prim);
    assert.equal(type.name, "string");
    assert.equal(stringNode.resolvedType, type);
    assert.equal(ctx.errors.length, 0);
  });
  describe("ident resolution", () => {
    it("resolves ident to symbol table type", () => {
      const identNode = new ASTNode(ASTNodeKind.IDENT);
      identNode.name = "x";
      const ctx = {
        errors: [],
        moduleSymbols: new Map([["x", { kind: typeKinds.prim, name: "int" }]]),
      };
      // create a int node
      const nodeCtx = { typeContext: { structTable: new Map() } };
      const constDeclNode = new ASTNode(ASTNodeKind.CONST_DECL);
      const typeObj = resolveTypeFromName(primAnnotations.int32, nodeCtx.typeContext.structTable);
      const scope = pushScope(null);
      // declare in scope a variable "x" of type int, to test that ident resolution prefers scope over module symbols
      declareInScope(scope, "x", typeObj, typeKinds.prim, constDeclNode, ctx.errors);
      const type = resolveExprType(identNode, scope, ctx);
      assert.equal(type.kind, typeKinds.prim);
      assert.equal(type.name, primAnnotations.int32);
      assert.equal(identNode.resolvedType, type);
      assert.equal(ctx.errors.length, 0);
    });
  });
});
