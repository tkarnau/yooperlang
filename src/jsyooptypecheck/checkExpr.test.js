import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { pinStructLiteral, resolveExprType } from "./checkExpr.js";
import { ASTNode, ASTNodeKind } from "../contracts.js";
import {
  PrimType,
  StructType,
  FuncType,
  RefType,
  primAnnotations,
  resolveTypeFromName,
  typeKinds,
} from "./types.js";
import { declareInScope, pushScope } from "./scope.js";
import { typecheckProgram } from "./typecheck.js";
import { parse } from "../jsyooparser/parser.js";

function singleModule(src, id = "test") {
  return [{ id, ast: parse(src) }];
}

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

describe("resolveCall: trait-qualified method dispatch (Phase 7.4)", () => {
  it("typechecks a Trait.method(ref x) call cleanly", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        trait Disposable { function dispose(ref self): void; }
        type FileHandle implements Disposable {
          fd: int32,
          function dispose(ref self): void { }
        }
        function main(): int32 {
          let h: FileHandle = { fd: 3 };
          Disposable.dispose(ref h);
          return 0;
        }
      `),
    );
    assert.deepEqual(errors, []);
  });

  it("annotates the call node with calleeMethodOf, calleeTrait, and trait-qualified calleeMangledName", () => {
    const src = `
      trait Disposable { function dispose(ref self): void; }
      type FileHandle implements Disposable {
        fd: int32,
        function dispose(ref self): void { }
      }
      function main(): int32 {
        let h: FileHandle = { fd: 3 };
        Disposable.dispose(ref h);
        return 0;
      }
    `;
    const { errors, modules } = typecheckProgram(singleModule(src));
    assert.deepEqual(errors, []);
    const mainDecl = modules[0].ast.body.find(
      (d) => d.kind === ASTNodeKind.FUNCTION_DECL && d.name === "main",
    );
    const disposeCall = mainDecl.body.body[1].value;
    assert.equal(disposeCall.kind, ASTNodeKind.CALL_EXPRESSION);
    assert.ok(disposeCall.calleeMethodOf, "should annotate calleeMethodOf");
    assert.equal(disposeCall.calleeMethodOf.name, "FileHandle");
    assert.equal(disposeCall.calleeTrait?.name, "Disposable");
    assert.match(disposeCall.calleeMangledName, /FileHandle__Disposable__dispose/);
  });

  it("hints at the trait-qualified form when bare-form call misses", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        trait Disposable { function dispose(ref self): void; }
        type FileHandle implements Disposable {
          fd: int32,
          function dispose(ref self): void { }
        }
        function main(): int32 {
          let h: FileHandle = { fd: 3 };
          dispose(ref h);
          return 0;
        }
      `),
    );
    assert.ok(
      errors.some((e) => /unknown function "dispose".*Disposable\.dispose/.test(e.message)),
      `expected hint at Disposable.dispose; got: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects unknown function that is not a method call", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        function main(): int32 {
          notAFunction(42);
          return 0;
        }
      `),
    );
    assert.ok(errors.some((e) => /unknown function.*notAFunction/.test(e.message)));
  });
});

describe("resolveExprType: self outside method context", () => {
  it("self used in a free function body produces an error", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        function main(): int32 {
          let x: int32 = self;
          return 0;
        }
      `),
    );
    assert.ok(
      errors.some((e) => /'self'.*inside.*trait|trait.*method.*self/.test(e.message)),
    );
  });
});
