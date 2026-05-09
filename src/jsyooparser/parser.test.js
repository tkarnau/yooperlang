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

  it("operator precedence: 1 + 2 * 3 -> plus(1, mult(2, 3))", () => {
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

describe("parse: phase 2 — postfix '?'", () => {
  function exprOf(src) {
    const ast = parse(`function f(): int32 { return ${src}; }`);
    return ast.body[0].body.body[0].value;
  }
  function bodyOf(src) {
    return parse(`function f(): int32 { ${src} return 0; }`).body[0].body.body;
  }

  it("'f()?' wraps a CALL_EXPRESSION in TRY_OP", () => {
    const e = exprOf("f()");
    // sanity: bare call has no TRY_OP
    assert.equal(e.kind, ASTNodeKind.CALL_EXPRESSION);

    const t = exprOf("f()?");
    assert.equal(t.kind, ASTNodeKind.TRY_OP);
    assert.equal(t.operand.kind, ASTNodeKind.CALL_EXPRESSION);
    assert.equal(t.operand.callee, "f");
  });

  it("'r?' wraps a plain IDENT in TRY_OP", () => {
    const t = exprOf("r?");
    assert.equal(t.kind, ASTNodeKind.TRY_OP);
    assert.equal(t.operand.kind, ASTNodeKind.IDENT);
    assert.equal(t.operand.name, "r");
  });

  it("'f().a?' parses as ((f().a)?) — '?' applies to the field access", () => {
    const t = exprOf("f().a?");
    assert.equal(t.kind, ASTNodeKind.TRY_OP);
    assert.equal(t.operand.kind, ASTNodeKind.FIELD_ACCESS);
    assert.equal(t.operand.field, "a");
    assert.equal(t.operand.object.kind, ASTNodeKind.CALL_EXPRESSION);
  });

  it("'f()?.a' parses as ((f()?).a) — field access on the TRY_OP result", () => {
    const e = exprOf("f()?.a");
    assert.equal(e.kind, ASTNodeKind.FIELD_ACCESS);
    assert.equal(e.field, "a");
    assert.equal(e.object.kind, ASTNodeKind.TRY_OP);
    assert.equal(e.object.operand.kind, ASTNodeKind.CALL_EXPRESSION);
  });

  it("'?' chains: 'f()?.a?' wraps the inner field access", () => {
    const t = exprOf("f()?.a?");
    assert.equal(t.kind, ASTNodeKind.TRY_OP);
    assert.equal(t.operand.kind, ASTNodeKind.FIELD_ACCESS);
    assert.equal(t.operand.object.kind, ASTNodeKind.TRY_OP);
  });

  it("'r? = 5' is rejected — TRY_OP is not a valid lvalue", () => {
    assert.throws(
      () => bodyOf("r? = 5;"),
      /invalid assignment target: TRY_OP/,
    );
  });
});

describe("parse: phase 2 — destructuring decl", () => {
  function bodyOf(src) {
    return parse(`function f(): int32 { ${src} return 0; }`).body[0].body.body;
  }

  it("'const { a, err } = f();' parses as DESTRUCTURE_DECL with CONST_DECL kind", () => {
    const stmts = bodyOf("const { a, err } = f();");
    const node = stmts[0];
    assert.equal(node.kind, ASTNodeKind.DESTRUCTURE_DECL);
    assert.equal(node.declKind, ASTNodeKind.CONST_DECL);
    assert.deepEqual(node.names, ["a", "err"]);
    assert.equal(node.assignment.kind, ASTNodeKind.CALL_EXPRESSION);
    assert.equal(node.assignment.callee, "f");
  });

  it("'let { a } = f();' parses as DESTRUCTURE_DECL with LET_DECL kind", () => {
    const stmts = bodyOf("let { a } = f();");
    const node = stmts[0];
    assert.equal(node.kind, ASTNodeKind.DESTRUCTURE_DECL);
    assert.equal(node.declKind, ASTNodeKind.LET_DECL);
    assert.deepEqual(node.names, ["a"]);
  });

  it("trailing comma in destructure is accepted", () => {
    const stmts = bodyOf("const { a, err, } = f();");
    assert.deepEqual(stmts[0].names, ["a", "err"]);
  });

  it("destructure RHS can be a TRY_OP — '{ a, b } = f()?;'", () => {
    const stmts = bodyOf("const { a, b } = f()?;");
    const node = stmts[0];
    assert.equal(node.kind, ASTNodeKind.DESTRUCTURE_DECL);
    assert.deepEqual(node.names, ["a", "b"]);
    assert.equal(node.assignment.kind, ASTNodeKind.TRY_OP);
    assert.equal(node.assignment.operand.kind, ASTNodeKind.CALL_EXPRESSION);
  });
});

describe("parse: phase 2 — discard statement", () => {
  function bodyOf(src) {
    return parse(`function f(): int32 { ${src} return 0; }`).body[0].body.body;
  }

  it("'_ = f();' parses as DISCARD_STATEMENT around a CALL_EXPRESSION", () => {
    const stmts = bodyOf("_ = f();");
    const node = stmts[0];
    assert.equal(node.kind, ASTNodeKind.DISCARD_STATEMENT);
    assert.equal(node.value.kind, ASTNodeKind.CALL_EXPRESSION);
    assert.equal(node.value.callee, "f");
  });

  it("'_ = x;' parses as DISCARD_STATEMENT wrapping an IDENT", () => {
    const stmts = bodyOf("_ = x;");
    const node = stmts[0];
    assert.equal(node.kind, ASTNodeKind.DISCARD_STATEMENT);
    assert.equal(node.value.kind, ASTNodeKind.IDENT);
    assert.equal(node.value.name, "x");
  });

  it("'_ = f()?;' threads the TRY_OP through into the discard value", () => {
    const stmts = bodyOf("_ = f()?;");
    const node = stmts[0];
    assert.equal(node.kind, ASTNodeKind.DISCARD_STATEMENT);
    assert.equal(node.value.kind, ASTNodeKind.TRY_OP);
    assert.equal(node.value.operand.kind, ASTNodeKind.CALL_EXPRESSION);
  });
});
