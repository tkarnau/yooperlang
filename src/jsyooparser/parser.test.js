import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "./parser.js";
import { ASTNodeKind } from "../contracts.js";

describe("parse: top-level shape", () => {
  it("empty source yields a PROGRAM with no body", () => {
    const ast = parse("");
    assert.equal(ast.kind, ASTNodeKind.PROGRAM);
    assert.deepEqual(ast.body, []);
  });

  it("a single function decl produces one FUNCTION_DECL in body", () => {
    const ast = parse("function main(): int32 { return 0; }");
    assert.equal(ast.body.length, 1);
    assert.equal(ast.body[0].kind, ASTNodeKind.FUNCTION_DECL);
    assert.equal(ast.body[0].name, "main");
    assert.equal(ast.body[0].returnType, "int32");
  });

  it("function params parse with name and type", () => {
    const ast = parse("function add(a: int32, b: int32): int32 { return a + b; }");
    const fn = ast.body[0];
    assert.equal(fn.params.length, 2);
    assert.equal(fn.params[0].name, "a");
    assert.equal(fn.params[0].type, "int32");
    assert.equal(fn.params[1].name, "b");
  });
});

describe("parse: expressions", () => {
  function exprOf(src) {
    const ast = parse(`function f(): int32 { return ${src}; }`);
    return ast.body[0].body.body[0].value;
  }

  it("int literal", () => {
    const e = exprOf("42");
    assert.equal(e.kind, ASTNodeKind.INT_LITERAL);
    assert.equal(e.value, 42);
  });

  it("binary + has correct shape", () => {
    const e = exprOf("1 + 2");
    assert.equal(e.kind, ASTNodeKind.BINARY_EXPRESSION);
    assert.equal(e.op, "plus");
    assert.equal(e.left.value, 1);
    assert.equal(e.right.value, 2);
  });

  it("operator precedence: 1 + 2 * 3 → plus(1, mult(2, 3))", () => {
    const e = exprOf("1 + 2 * 3");
    assert.equal(e.op, "plus");
    assert.equal(e.left.value, 1);
    assert.equal(e.right.op, "mult");
  });

  it("call expression", () => {
    const e = exprOf("add(1, 2)");
    assert.equal(e.kind, ASTNodeKind.CALL_EXPRESSION);
    assert.equal(e.callee, "add");
    assert.equal(e.args.length, 2);
  });
});

describe("parse: statements", () => {
  function bodyOf(src) {
    return parse(`function f(): int32 { ${src} return 0; }`).body[0].body.body;
  }

  it("let decl", () => {
    const stmts = bodyOf("let x: int32 = 1;");
    assert.equal(stmts[0].kind, ASTNodeKind.LET_DECL);
    assert.equal(stmts[0].name, "x");
    assert.equal(stmts[0].type, "int32");
  });

  it("const decl", () => {
    const stmts = bodyOf("const y: int32 = 2;");
    assert.equal(stmts[0].kind, ASTNodeKind.CONST_DECL);
  });

  it("if statement with else", () => {
    const stmts = bodyOf("if (1) { } else { }");
    assert.equal(stmts[0].kind, ASTNodeKind.IF_STATEMENT);
    assert.ok(stmts[0].elseBody);
  });

  it("while statement", () => {
    const stmts = bodyOf("while (1) { }");
    assert.equal(stmts[0].kind, ASTNodeKind.WHILE_STATEMENT);
  });
});
