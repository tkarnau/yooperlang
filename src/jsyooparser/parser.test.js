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
    assert.deepEqual(ast.body[0].returnTypeAnnotation, {
      kind: "typeName",
      name: "int32",
    });
  });

  it("function params parse with name and type", () => {
    const ast = parse(
      "function add(a: int32, b: int32): int32 { return a + b; }",
    );
    const fn = ast.body[0];
    assert.equal(fn.params.length, 2);
    assert.equal(fn.params[0].name, "a");
    assert.deepEqual(fn.params[0].typeAnnotation, {
      kind: "typeName",
      name: "int32",
    });
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
    assert.deepEqual(stmts[0].typeAnnotation, {
      kind: "typeName",
      name: "int32",
    });
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
    assert.throws(() => bodyOf("r? = 5;"), /invalid assignment target: TRY_OP/);
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

describe("parse: phase 5 - traits", () => {
  it("trait Disposable { function dispose(ref self): void; } parses properly", () => {
    const stmts = parse(
      "trait Disposable { function dispose(ref self): void; }",
    ).body;
    assert.equal(stmts.length, 1);
    const trait = stmts[0];
    assert.equal(trait.kind, ASTNodeKind.TRAIT_DECL);
    assert.equal(trait.name, "Disposable");
    assert.equal(trait.methods.length, 1);
    const method = trait.methods[0];
    assert.equal(method.kind, ASTNodeKind.METHOD_SIG);
    assert.equal(method.name, "dispose");
    assert.equal(method.params.length, 1);
    const param = method.params[0];
    assert.equal(param.name, "self");
    assert.equal(param.isRef, true);
    assert.deepEqual(param.typeAnnotation, { kind: "selfType" });
    assert.deepEqual(method.returnTypeAnnotation, {
      kind: "typeName",
      name: "void",
    });
  });
  it("2 method trait parses properly", () => {
    const stmts = parse(`trait Foo {
  function method1(ref self): void;
  function method2(ref self, x: int32): int32;
}`).body;
    assert.equal(stmts.length, 1);
    const trait = stmts[0];
    assert.equal(trait.kind, ASTNodeKind.TRAIT_DECL);
    assert.equal(trait.name, "Foo");
    assert.equal(trait.methods.length, 2);
    const method1 = trait.methods[0];
    assert.equal(method1.kind, ASTNodeKind.METHOD_SIG);
    assert.equal(method1.name, "method1");
    assert.equal(method1.params.length, 1);
    const param1 = method1.params[0];
    assert.equal(param1.name, "self");
    assert.equal(param1.isRef, true);
    assert.deepEqual(param1.typeAnnotation, { kind: "selfType" });
    assert.deepEqual(method1.returnTypeAnnotation, {
      kind: "typeName",
      name: "void",
    });
    const method2 = trait.methods[1];
    assert.equal(method2.kind, ASTNodeKind.METHOD_SIG);
    assert.equal(method2.name, "method2");
    assert.equal(method2.params.length, 2);
    const param2_1 = method2.params[0];
    assert.equal(param2_1.name, "self");
    assert.equal(param2_1.isRef, true);
    assert.deepEqual(param2_1.typeAnnotation, { kind: "selfType" });
    const param2_2 = method2.params[1];
    assert.equal(param2_2.name, "x");
    assert.equal(param2_2.isRef, false);
    assert.deepEqual(param2_2.typeAnnotation, {
      kind: "typeName",
      name: "int32",
    });
    assert.deepEqual(method2.returnTypeAnnotation, {
      kind: "typeName",
      name: "int32",
    });
  });
  it("type implements parses properly", () => {
    const stmts = parse(
      "type FileHandle implements Disposable { fd: int32, function dispose(ref self): void { } }",
    ).body;
    assert.equal(stmts.length, 1);
    const type = stmts[0];
    assert.equal(type.kind, ASTNodeKind.TYPE_DECL);
    assert.equal(type.name, "FileHandle");
    assert.equal(type.implements.length, 1);
    assert.equal(type.implements[0], "Disposable");
    assert.equal(type.fields.length, 1);
    const field = type.fields[0];
    assert.equal(field.kind, ASTNodeKind.FIELD_DECL);
    assert.equal(field.name, "fd");
    assert.deepEqual(field.typeAnnotation, {
      kind: "typeName",
      name: "int32",
    });
    const method = type.methods[0];
    assert.equal(method.kind, ASTNodeKind.METHOD_DECL);
    assert.equal(method.name, "dispose");
    assert.equal(method.params.length, 1);
    const param = method.params[0];
    assert.equal(param.name, "self");
    assert.equal(param.isRef, true);
    assert.deepEqual(param.typeAnnotation, { kind: "selfType" });
    assert.deepEqual(method.returnTypeAnnotation, {
      kind: "typeName",
      name: "void",
    });
  });
  it("type implements multiple traits parses properly", () => {
    const stmts = parse(
      "type Channel implements (Disposable, Closable) { }",
    ).body;
    assert.equal(stmts.length, 1);
    const type = stmts[0];
    assert.equal(type.kind, ASTNodeKind.TYPE_DECL);
    assert.equal(type.name, "Channel");
    assert.equal(type.implements.length, 2);
    assert.equal(type.implements[0], "Disposable");
    assert.equal(type.implements[1], "Closable");
  });
  it("self field references parses properly", () => {
    // A method body using `self.count`: parses as `FIELD_ACCESS { object: IDENT { name: "self" }, field: "count" }`.
    const stmts = parse(
      "type Counter implements Disposable { count: int32, function dispose(ref self): void { self.count = 0; } }",
    ).body;
    assert.equal(stmts.length, 1);
    const type = stmts[0];
    const method = type.methods[0];
    const exprStmt = method.body.body[0];
    assert.equal(exprStmt.kind, ASTNodeKind.EXPRESSION_STATEMENT);
    const stmt = exprStmt.value;

    assert.equal(stmt.kind, ASTNodeKind.ASSIGNMENT);
    assert.equal(stmt.target.kind, ASTNodeKind.FIELD_ACCESS);
    assert.equal(stmt.target.field, "count");
    assert.equal(stmt.target.object.kind, ASTNodeKind.IDENT);
    assert.equal(stmt.target.object.name, "self");
    assert.equal(stmt.value.kind, ASTNodeKind.INT_LITERAL);
    assert.equal(stmt.value.value, 0);
  });
  it("method calls another method parses as call expression", () => {
    // A method that calls another method: `function f(ref self): void { g(ref self); } function g(ref self): void { }` — the `g(ref self)` is just a `CALL_EXPRESSION`, no special parser handling.
    const stmts = parse(
      "type myType implements MyTrait { function f(ref self): void { g(ref self); } function g(ref self): void { } }",
    ).body;
    assert.equal(stmts.length, 1);
    const type = stmts[0];
    const methodF = type.methods[0];
    const exprStmt = methodF.body.body[0];
    assert.equal(exprStmt.kind, ASTNodeKind.EXPRESSION_STATEMENT);
    const callExpr = exprStmt.value;
    assert.equal(callExpr.kind, ASTNodeKind.CALL_EXPRESSION);
    assert.equal(callExpr.callee, "g");
    assert.equal(callExpr.args.length, 1);
    const arg = callExpr.args[0];
    assert.equal(arg.kind, ASTNodeKind.REF_EXPRESSION);
    assert.equal(arg.operand.kind, ASTNodeKind.IDENT);
    assert.equal(arg.operand.name, "self");
  });
  it("trailing comma in fields and methods parses cleanly", () => {
    const stmts = parse(
      "type myType implements MyTrait { field1: int32, function method1(ref self): void { } function method2(ref self): void { } field2: int32, }",
    ).body;
    assert.equal(stmts.length, 1);
    const type = stmts[0];
    assert.equal(type.fields.length, 2);
    assert.equal(type.methods.length, 2);
  });
  it("trailing comma in implements list parses cleanly", () => {
    const stmts = parse(
      "type myType implements (MyTrait1, MyTrait2, ) { }",
    ).body;
    assert.equal(stmts.length, 1);
    const type = stmts[0];
    assert.equal(type.implements.length, 2);
    assert.equal(type.implements[0], "MyTrait1");
    assert.equal(type.implements[1], "MyTrait2");
  });
  describe("reject cases", () => {
    it("rejects generics, not yet supported", () => {
      assert.throws(
        () =>
          parse("trait MyTrait<T> { function method(ref self, x: T): void; }"),
        /trait generics are not supported in v0/,
      );
    });
    it("rejects extends, not yet supported", () => {
      assert.throws(
        () =>
          parse(
            "trait MyTrait extends BaseTrait { function method(ref self): void; }",
          ),
        /extends not yet supported/,
      );
    });
    it("rejects missing ref self in trait method", () => {
      assert.throws(
        () => parse("trait MyTrait { function method(self): void; }"),
        /must take 'ref self' as its first parameter/,
      );
    });
    it("rejects missing self param in trait method", () => {
      assert.throws(
        () => parse("trait MyTrait { function method(ref x): void; }"),
        /expected self, got ident/, // todo better error messages
      );
    });
    it("rejects method body in trait method sig", () => {
      assert.throws(
        () => parse("trait MyTrait { function method(ref self): void { } }"),
        /expected semicolon, got lcurly/, // todo better error messages
      );
    });
    it("rejects methods without implements, methods only allowed in implement types", () => {
      assert.throws(
        () => parse("type MyType { function method(ref self): void { } }"),
        /methods are only allowed inside an 'implements' block - type "MyType" has methods but no 'implements' clause/,
      );
    });
    it("rejects methods in implements block without ref self", () => {
      assert.throws(
        () =>
          parse(
            "type MyType implements MyTrait { function method(self): void { } }",
          ),
        /expected ref, got self/, // todo better error messages
      );
    });
  });
});
