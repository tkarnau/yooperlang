import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { pinStructLiteral, resolveExprType } from "./checkExpr.js";
import { ASTNode, ASTNodeKind } from "../contracts.js";
import {
  PrimType,
  StructType,
  primAnnotations,
  resolveTypeFromName,
  typeKinds,
} from "./types.js";
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
  describe("field access", () => {
    const makePointScope = () => {
      const pointType = StructType("Point", [
        { name: "x", type: PrimType(primAnnotations.int32) },
        { name: "y", type: PrimType(primAnnotations.float32) },
      ]);
      const scope = pushScope(null);
      const declNode = new ASTNode(ASTNodeKind.LET_DECL);
      declareInScope(scope, "p", pointType, "let", declNode, []);
      return scope;
    };

    const makeFieldAccessOf = (objName, fieldName) => {
      const obj = new ASTNode(ASTNodeKind.IDENT);
      obj.name = objName;
      const node = new ASTNode(ASTNodeKind.FIELD_ACCESS);
      node.object = obj;
      node.field = fieldName;
      return node;
    };

    it("resolves a known field to the field's type", () => {
      const scope = makePointScope();
      const node = makeFieldAccessOf("p", "y");
      const ctx = { errors: [] };
      const type = resolveExprType(node, scope, ctx);
      assert.equal(type.kind, typeKinds.prim);
      assert.equal(type.name, primAnnotations.float32);
      assert.equal(node.resolvedType, type);
      assert.equal(ctx.errors.length, 0);
    });

    it("reports an error when the field does not exist", () => {
      const scope = makePointScope();
      const node = makeFieldAccessOf("p", "z");
      const ctx = { errors: [] };
      const type = resolveExprType(node, scope, ctx);
      assert.equal(type.kind, typeKinds.error);
      assert.equal(ctx.errors.length, 1);
      assert.equal(
        ctx.errors[0].message,
        'type "Point" has no field "z"',
      );
    });

    it("reports an error when the receiver is not a struct", () => {
      const scope = pushScope(null);
      const declNode = new ASTNode(ASTNodeKind.LET_DECL);
      declareInScope(
        scope,
        "i",
        PrimType(primAnnotations.int32),
        "let",
        declNode,
        [],
      );
      const node = makeFieldAccessOf("i", "x");
      const ctx = { errors: [] };
      const type = resolveExprType(node, scope, ctx);
      assert.equal(type.kind, typeKinds.error);
      assert.equal(ctx.errors.length, 1);
      assert.equal(
        ctx.errors[0].message,
        "field access on non-struct type int32",
      );
    });
  });
  describe("struct literal pinning", () => {
    it("reports an error when trying to pin a struct literal to a non-struct type", () => {
      const litNode = new ASTNode(ASTNodeKind.STRUCT_LITERAL);
      const targetType = PrimType(primAnnotations.int32);
      const ctx = { errors: [] };
      pinStructLiteral(litNode, targetType, null, ctx);
      assert.equal(ctx.errors.length, 1);
      assert.equal(
        ctx.errors[0].message,
        "cannot pin struct literal to non-struct type int32",
      );
    });
  });
});
