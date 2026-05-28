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

  // Phase 9.A: parenthesized subexpressions
  it("parens around a single literal", () => {
    const e = exprOf("(42)");
    assert.equal(e.kind, ASTNodeKind.INT_LITERAL);
    assert.equal(e.value, 42);
  });

  it("parens override precedence: (1 + 2) * 3 -> mult(plus(1,2), 3)", () => {
    const e = exprOf("(1 + 2) * 3");
    assert.equal(e.kind, ASTNodeKind.BINARY_EXPRESSION);
    assert.equal(e.op, "mult");
    assert.equal(e.left.op, "plus");
    assert.equal(e.left.left.value, 1);
    assert.equal(e.left.right.value, 2);
    assert.equal(e.right.value, 3);
  });

  it("nested parens collapse to inner expression", () => {
    const e = exprOf("((1 + 2))");
    assert.equal(e.kind, ASTNodeKind.BINARY_EXPRESSION);
    assert.equal(e.op, "plus");
  });

  it("postfix field access on parenthesized expression", () => {
    const e = exprOf("(a + b).x");
    assert.equal(e.kind, ASTNodeKind.FIELD_ACCESS);
    assert.equal(e.field, "x");
    assert.equal(e.object.kind, ASTNodeKind.BINARY_EXPRESSION);
  });

  it("postfix index on parenthesized expression", () => {
    const e = exprOf("(xs)[0]");
    assert.equal(e.kind, ASTNodeKind.INDEX_EXPRESSION);
    assert.equal(e.object.kind, ASTNodeKind.IDENT);
    assert.equal(e.index.value, 0);
  });

  it("postfix '?' on parenthesized expression", () => {
    const e = exprOf("(f())?");
    assert.equal(e.kind, ASTNodeKind.TRY_OP);
    assert.equal(e.operand.kind, ASTNodeKind.CALL_EXPRESSION);
  });

  it("parens around a unary minus operand", () => {
    const e = exprOf("-(a + b)");
    assert.equal(e.kind, ASTNodeKind.UNARY_EXPRESSION);
    assert.equal(e.op, "minus");
    assert.equal(e.operand.kind, ASTNodeKind.BINARY_EXPRESSION);
  });

  // Regression: unary prefixes used to return early instead of falling
  // through to the binary loop, so `!a && b`, `-a + b`, `~a & b` failed
  // to parse. See plans/yoopbinder-papercuts.md Issue 1.
  it("`!a && b` parses as `&&((!a), b)` not as a syntax error", () => {
    const e = exprOf("!a && b");
    assert.equal(e.kind, ASTNodeKind.BINARY_EXPRESSION);
    assert.equal(e.op, "andand");
    assert.equal(e.left.kind, ASTNodeKind.UNARY_EXPRESSION);
    assert.equal(e.left.op, "not");
    assert.equal(e.right.kind, ASTNodeKind.IDENT);
  });

  it("`-a + b` composes unary minus with binary plus", () => {
    const e = exprOf("-a + b");
    assert.equal(e.kind, ASTNodeKind.BINARY_EXPRESSION);
    assert.equal(e.op, "plus");
    assert.equal(e.left.kind, ASTNodeKind.UNARY_EXPRESSION);
    assert.equal(e.left.op, "minus");
    assert.equal(e.right.kind, ASTNodeKind.IDENT);
  });

  it("`~a & b` composes bitwise not with bitwise and", () => {
    const e = exprOf("~a & b");
    assert.equal(e.kind, ASTNodeKind.BINARY_EXPRESSION);
    assert.equal(e.op, "amp");
    assert.equal(e.left.kind, ASTNodeKind.UNARY_EXPRESSION);
    assert.equal(e.left.op, "bitnot");
  });

  it("`!a || !b` chains unary not on both sides", () => {
    const e = exprOf("!a || !b");
    assert.equal(e.kind, ASTNodeKind.BINARY_EXPRESSION);
    assert.equal(e.op, "oror");
    assert.equal(e.left.kind, ASTNodeKind.UNARY_EXPRESSION);
    assert.equal(e.left.op, "not");
    assert.equal(e.right.kind, ASTNodeKind.UNARY_EXPRESSION);
    assert.equal(e.right.op, "not");
  });

  it("`!flags[i]` keeps the postfix binding tight to the operand", () => {
    const e = exprOf("!flags[i]");
    assert.equal(e.kind, ASTNodeKind.UNARY_EXPRESSION);
    assert.equal(e.op, "not");
    assert.equal(e.operand.kind, ASTNodeKind.INDEX_EXPRESSION);
  });

  // Phase 9.E: array slice syntax
  it("plain index parses as INDEX_EXPRESSION", () => {
    const e = exprOf("xs[5]");
    assert.equal(e.kind, ASTNodeKind.INDEX_EXPRESSION);
    assert.equal(e.index.value, 5);
  });

  it("closed slice xs[i..j] parses with both bounds", () => {
    const e = exprOf("xs[1..3]");
    assert.equal(e.kind, ASTNodeKind.SLICE_EXPRESSION);
    assert.equal(e.start.value, 1);
    assert.equal(e.end.value, 3);
  });

  it("open-end slice xs[i..] parses with null end", () => {
    const e = exprOf("xs[1..]");
    assert.equal(e.kind, ASTNodeKind.SLICE_EXPRESSION);
    assert.equal(e.start.value, 1);
    assert.equal(e.end, null);
  });

  it("open-start slice xs[..j] parses with null start", () => {
    const e = exprOf("xs[..3]");
    assert.equal(e.kind, ASTNodeKind.SLICE_EXPRESSION);
    assert.equal(e.start, null);
    assert.equal(e.end.value, 3);
  });

  it("fully open slice xs[..] parses with both bounds null", () => {
    const e = exprOf("xs[..]");
    assert.equal(e.kind, ASTNodeKind.SLICE_EXPRESSION);
    assert.equal(e.start, null);
    assert.equal(e.end, null);
  });

  it("slice bounds can be arbitrary expressions", () => {
    const e = exprOf("xs[i + 1..j - 1]");
    assert.equal(e.kind, ASTNodeKind.SLICE_EXPRESSION);
    assert.equal(e.start.kind, ASTNodeKind.BINARY_EXPRESSION);
    assert.equal(e.end.kind, ASTNodeKind.BINARY_EXPRESSION);
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

// Phase 9.D: `for ITEM in EXPR { ... }` element-walking loop. The classic
// C-style `for (i = 0; ...)` form still parses unchanged; the dispatcher
// looks at whether the token after `for` is `(` or `IDENT in`.
describe("Phase 9.D: for ... in loop", () => {
  function bodyOf(src) {
    return parse(`function f(): int32 { ${src} return 0; }`).body[0].body.body;
  }

  it("parses `for x in xs { }` as FOR_IN_LOOP with loopVar + iterExpr", () => {
    const stmts = bodyOf("let xs: int32[] = [1,2,3]; for x in xs { }");
    const loop = stmts[1];
    assert.equal(loop.kind, ASTNodeKind.FOR_IN_LOOP);
    assert.equal(loop.loopVar, "x");
    assert.equal(loop.iterExpr.kind, ASTNodeKind.IDENT);
    assert.equal(loop.iterExpr.name, "xs");
    assert.equal(loop.body.kind, ASTNodeKind.BLOCK);
  });

  it("classic for-loop syntax still parses to FOR_LOOP", () => {
    const stmts = bodyOf("let i: int32 = 0; for (i = 0; i < 5; i = i + 1) { }");
    assert.equal(stmts[1].kind, ASTNodeKind.FOR_LOOP);
  });

  it("accepts an arbitrary expression on the RHS of `in`", () => {
    const stmts = bodyOf("let xs: int32[] = [1,2,3]; for x in xs { }");
    const loop = stmts[1];
    assert.equal(loop.kind, ASTNodeKind.FOR_IN_LOOP);
    // Index expressions, calls, field access etc. all flow through
    // parseExpression - verify a call-shape RHS works.
    const stmts2 = bodyOf("for v in build() { }");
    assert.equal(stmts2[0].kind, ASTNodeKind.FOR_IN_LOOP);
    assert.equal(stmts2[0].iterExpr.kind, ASTNodeKind.CALL_EXPRESSION);
  });
});

// Phase 9.G.1: function value types in type position - `(p: T) => R`. The
// annotation parses to `{ kind: "functionType", params: [...], returnType }`
// and may appear anywhere a type annotation does.
describe("Phase 9.G.1: `=>` function value type annotations", () => {
  it("parses a struct field of function-pointer type", () => {
    const ast = parse(
      "type Handler { handle: (req: int32) => int32 }",
    );
    const td = ast.body[0];
    assert.equal(td.kind, ASTNodeKind.TYPE_DECL);
    assert.equal(td.fields[0].name, "handle");
    assert.deepEqual(td.fields[0].typeAnnotation, {
      kind: "functionType",
      params: [{ kind: "typeName", name: "int32" }],
      returnType: { kind: "typeName", name: "int32" },
    });
  });

  it("parses a function parameter typed as a function pointer", () => {
    const ast = parse(
      "function pick(cb: (n: int32) => int32): int32 { return cb(5); }",
    );
    const fn = ast.body[0];
    assert.deepEqual(fn.params[0].typeAnnotation, {
      kind: "functionType",
      params: [{ kind: "typeName", name: "int32" }],
      returnType: { kind: "typeName", name: "int32" },
    });
  });

  it("parses an empty parameter list `() => int32`", () => {
    const ast = parse("type T { gen: () => int32 }");
    assert.deepEqual(ast.body[0].fields[0].typeAnnotation, {
      kind: "functionType",
      params: [],
      returnType: { kind: "typeName", name: "int32" },
    });
  });
});

describe("parse: phase 2 - postfix '?'", () => {
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

  it("'f().a?' parses as ((f().a)?) - '?' applies to the field access", () => {
    const t = exprOf("f().a?");
    assert.equal(t.kind, ASTNodeKind.TRY_OP);
    assert.equal(t.operand.kind, ASTNodeKind.FIELD_ACCESS);
    assert.equal(t.operand.field, "a");
    assert.equal(t.operand.object.kind, ASTNodeKind.CALL_EXPRESSION);
  });

  it("'f()?.a' parses as ((f()?).a) - field access on the TRY_OP result", () => {
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

  it("'r? = 5' is rejected - TRY_OP is not a valid lvalue", () => {
    assert.throws(() => bodyOf("r? = 5;"), /invalid assignment target: TRY_OP/);
  });
});

describe("parse: phase 2 - destructuring decl", () => {
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

  it("destructure RHS can be a TRY_OP - '{ a, b } = f()?;'", () => {
    const stmts = bodyOf("const { a, b } = f()?;");
    const node = stmts[0];
    assert.equal(node.kind, ASTNodeKind.DESTRUCTURE_DECL);
    assert.deepEqual(node.names, ["a", "b"]);
    assert.equal(node.assignment.kind, ASTNodeKind.TRY_OP);
    assert.equal(node.assignment.operand.kind, ASTNodeKind.CALL_EXPRESSION);
  });
});

describe("parse: phase 2 - discard statement", () => {
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
    assert.equal(type.implements[0].name, "Disposable");
    assert.equal(type.implements[0].typeArgs, null);
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
    assert.equal(type.implements[0].name, "Disposable");
    assert.equal(type.implements[1].name, "Closable");
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
    // A method that calls another method: `function f(ref self): void { g(ref self); } function g(ref self): void { }` - the `g(ref self)` is just a `CALL_EXPRESSION`, no special parser handling.
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
    assert.equal(type.implements[0].name, "MyTrait1");
    assert.equal(type.implements[1].name, "MyTrait2");
  });
  describe("reject cases", () => {
    it("parses generic traits (phase 7.1)", () => {
      const ast = parse(
        "trait MyTrait<T> { function method(ref self, x: T): void; }",
      );
      const tr = ast.body[0];
      assert.equal(tr.kind, "TRAIT_DECL");
      assert.equal(tr.name, "MyTrait");
      assert.equal(tr.typeParams.length, 1);
      assert.equal(tr.typeParams[0].name, "T");
    });
    // Phase 9.J: `extends` is supported.
    it("parses single extends", () => {
      const ast = parse(
        "trait MyTrait extends BaseTrait { function method(ref self): void; }",
      );
      const tr = ast.body[0];
      assert.equal(tr.kind, "TRAIT_DECL");
      assert.equal(tr.name, "MyTrait");
      assert.equal(tr.extends.length, 1);
      assert.equal(tr.extends[0].kind, "typeName");
      assert.equal(tr.extends[0].name, "BaseTrait");
    });
    it("parses multiple extends", () => {
      const ast = parse(
        "trait Child extends A, B { function method(ref self): void; }",
      );
      const tr = ast.body[0];
      assert.equal(tr.extends.length, 2);
      assert.equal(tr.extends[0].name, "A");
      assert.equal(tr.extends[1].name, "B");
    });
    it("parses generic extends", () => {
      const ast = parse(
        "trait BatchIterable<T> extends Iterable<T> { function next_batch(ref self): T; }",
      );
      const tr = ast.body[0];
      assert.equal(tr.extends.length, 1);
      assert.equal(tr.extends[0].kind, "typeApplication");
      assert.equal(tr.extends[0].name, "Iterable");
      assert.equal(tr.extends[0].typeArgs[0].name, "T");
    });
    it("rejects extends with no trait name", () => {
      assert.throws(
        () => parse("trait MyTrait extends { function m(ref self): void; }"),
        /expected trait name after 'extends'/,
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

describe("parse: phase 6.1 - kind decls", () => {
  it("full clause set parses, clauses preserved in order", () => {
    const stmts = parse(
      `kind disposable {
         appliesTo binding;
         requires Disposable;
         mustCall dispose beforeScopeEnd;
         ownsBlock;
       }`,
    ).body;
    assert.equal(stmts.length, 1);
    const k = stmts[0];
    assert.equal(k.kind, ASTNodeKind.KIND_DECL);
    assert.equal(k.name, "disposable");
    assert.equal(k.clauses.length, 4);
    assert.equal(k.clauses[0].kind, ASTNodeKind.KIND_APPLIES_TO_CLAUSE);
    assert.deepEqual(k.clauses[0].sites, ["binding"]);
    assert.equal(k.clauses[1].kind, ASTNodeKind.KIND_REQUIRES_CLAUSE);
    assert.equal(k.clauses[1].traitName, "Disposable");
    assert.equal(k.clauses[2].kind, ASTNodeKind.KIND_MUSTCALL_CLAUSE);
    assert.equal(k.clauses[2].methodName, "dispose");
    assert.equal(k.clauses[2].timing, "beforeScopeEnd");
    assert.equal(k.clauses[3].kind, ASTNodeKind.KIND_OWNSBLOCK_CLAUSE);
  });

  it("kind with only appliesTo and mustCall parses (typecheck enforces requires)", () => {
    const k = parse(
      "kind cleanup { appliesTo binding; mustCall close beforeScopeEnd; }",
    ).body[0];
    assert.equal(k.clauses.length, 2);
  });

  it("multiple requires clauses parse independently", () => {
    const k = parse(
      `kind handle {
         appliesTo binding;
         requires Disposable;
         requires Closable;
         mustCall dispose beforeScopeEnd;
       }`,
    ).body[0];
    const requires = k.clauses.filter(
      (c) => c.kind === ASTNodeKind.KIND_REQUIRES_CLAUSE,
    );
    assert.equal(requires.length, 2);
    assert.equal(requires[0].traitName, "Disposable");
    assert.equal(requires[1].traitName, "Closable");
  });

  describe("reject cases", () => {
    it("rejects missing appliesTo clause", () => {
      assert.throws(
        () => parse("kind disposable { requires Disposable; }"),
        /missing required 'appliesTo' clause/,
      );
    });
    it("rejects duplicate appliesTo clause", () => {
      assert.throws(
        () =>
          parse(
            "kind disposable { appliesTo binding; appliesTo binding; }",
          ),
        /duplicate appliesTo clause/,
      );
    });
    it("rejects appliesTo function site", () => {
      assert.throws(
        () => parse("kind k { appliesTo function; }"),
        /user-declared `appliesTo function` kinds are deferred/,
      );
    });
    it("rejects duplicate appliesTo site", () => {
      assert.throws(
        () => parse("kind k { appliesTo binding binding; }"),
        /duplicate appliesTo site 'binding'/,
      );
    });
    it("rejects mustCall beforeAny", () => {
      assert.throws(
        () =>
          parse(
            "kind k { appliesTo binding; mustCall dispose beforeAny; }",
          ),
        /mustCall dispose beforeAny not yet supported/,
      );
    });
    it("rejects mustCall block (alternation) form", () => {
      assert.throws(
        () =>
          parse(
            "kind k { appliesTo binding; mustCall { wait; abandon; } beforeScopeEnd; }",
          ),
        /mustCall block form \(alternation\) not yet supported/,
      );
    });
    it("rejects requires list form", () => {
      assert.throws(
        () =>
          parse(
            "kind k { appliesTo binding; requires Disposable Closable; }",
          ),
        /requires takes a single trait per clause/,
      );
    });
    it("rejects ownsBlock with parentheses", () => {
      assert.throws(
        () => parse("kind k { appliesTo binding; ownsBlock(); }"),
        /ownsBlock takes no arguments/,
      );
    });
    it("accepts parameterized kind decl (phase 6.5)", () => {
      const ast = parse("kind k(n: usize) { appliesTo binding; }");
      const k = ast.body[0];
      assert.equal(k.name, "k");
      assert.equal(k.params.length, 1);
      assert.equal(k.params[0].name, "n");
    });
    it("accepts kind composition (phase 6.5)", () => {
      const ast = parse("kind slow = a & b;");
      const k = ast.body[0];
      assert.equal(k.name, "slow");
      assert.equal(k.composition.kindRefs.length, 2);
      assert.equal(k.composition.kindRefs[0].name, "a");
      assert.equal(k.composition.kindRefs[1].name, "b");
    });
    it("accepts inline kind body in composition", () => {
      const ast = parse("kind slow = a & { mustNotEscape scope; };");
      const k = ast.body[0];
      assert.equal(k.composition.kindRefs.length, 2);
      assert.equal(k.composition.kindRefs[0].inline, false);
      assert.equal(k.composition.kindRefs[0].name, "a");
      assert.equal(k.composition.kindRefs[1].inline, true);
      assert.equal(k.composition.kindRefs[1].clauses.length, 1);
      assert.equal(
        k.composition.kindRefs[1].clauses[0].kind,
        ASTNodeKind.KIND_MUST_NOT_ESCAPE_CLAUSE,
      );
    });
    it("rejects appliesTo inside an inline composition body", () => {
      assert.throws(
        () => parse("kind bad = a & { appliesTo binding; };"),
        /inline kind body in composition cannot declare 'appliesTo'/,
      );
    });
    it("rejects empty inline composition body", () => {
      assert.throws(
        () => parse("kind bad = a & { };"),
        /inline kind body must contain at least one clause/,
      );
    });
    it("rejects provides clause", () => {
      assert.throws(
        () =>
          parse("kind k { appliesTo binding; provides Foo; }"),
        /provides clause not yet supported/,
      );
    });
    it("rejects mustNotEscape without 'scope' keyword", () => {
      assert.throws(
        () =>
          parse("kind k { appliesTo binding; mustNotEscape; }"),
        /mustNotEscape semicolon not yet supported/,
      );
    });
    // Phase 9.J: `mustNotShare acrossThreads` joins `acrossScopes` as a legal
    // target.
    it("accepts mustNotShare acrossThreads", () => {
      const ast = parse(
        "kind k { appliesTo binding; mustNotShare acrossThreads; }",
      );
      const k = ast.body[0];
      const c = k.clauses.find(
        (c) => c.kind === ASTNodeKind.KIND_MUST_NOT_SHARE_CLAUSE,
      );
      assert.equal(c.target, "acrossThreads");
    });
    it("accepts mustNotShare acrossScopes", () => {
      const ast = parse(
        "kind k { appliesTo binding; mustNotShare acrossScopes; }",
      );
      const k = ast.body[0];
      const c = k.clauses.find(
        (c) => c.kind === ASTNodeKind.KIND_MUST_NOT_SHARE_CLAUSE,
      );
      assert.equal(c.target, "acrossScopes");
    });
    it("rejects mustNotShare with unrecognized target", () => {
      assert.throws(
        () =>
          parse("kind k { appliesTo binding; mustNotShare acrossPlanets; }"),
        /unrecognized mustNotShare target/,
      );
    });
  });
});

describe("parse: phase 6.1 - kind-prefixed bindings", () => {
  // run a single body statement through the parser by wrapping it in a function
  function stmtOf(src) {
    const ast = parse(`function f(): int32 { ${src} return 0; }`);
    return ast.body[0].body.body[0];
  }

  it("implicit-const, implicit-block: `disposable a: FileHandle = expr;`", () => {
    const s = stmtOf("disposable a: FileHandle = make_handle();");
    assert.equal(s.kind, ASTNodeKind.CONST_DECL);
    assert.equal(s.name, "a");
    assert.equal(s.kindPrefix.name, "disposable");
    assert.equal(s.trailingBlock, null);
    assert.deepEqual(s.typeAnnotation, {
      kind: "typeName",
      name: "FileHandle",
    });
    assert.equal(s.assignment.kind, ASTNodeKind.CALL_EXPRESSION);
  });

  it("explicit let with kind prefix retains LET_DECL", () => {
    const s = stmtOf("let disposable a: FileHandle = make_handle();");
    assert.equal(s.kind, ASTNodeKind.LET_DECL);
    assert.equal(s.kindPrefix.name, "disposable");
    assert.equal(s.trailingBlock, null);
  });

  it("explicit const with kind prefix retains CONST_DECL", () => {
    const s = stmtOf("const disposable a: FileHandle = make_handle();");
    assert.equal(s.kind, ASTNodeKind.CONST_DECL);
    assert.equal(s.kindPrefix.name, "disposable");
  });

  it("trailing block parses into trailingBlock field", () => {
    const s = stmtOf(
      "disposable a: FileHandle = make_handle() { return 0; }",
    );
    assert.equal(s.kindPrefix.name, "disposable");
    assert.equal(s.trailingBlock.kind, ASTNodeKind.BLOCK);
    assert.equal(s.trailingBlock.body.length, 1);
    assert.equal(
      s.trailingBlock.body[0].kind,
      ASTNodeKind.RETURN_STATEMENT,
    );
  });

  it("plain `let x: T = expr;` still parses without kindPrefix", () => {
    const s = stmtOf("let x: int32 = 5;");
    assert.equal(s.kind, ASTNodeKind.LET_DECL);
    assert.equal(s.kindPrefix ?? null, null);
    assert.equal(s.trailingBlock ?? null, null);
  });

  describe("reject cases", () => {
    it("rejects kind-prefixed binding without initializer", () => {
      assert.throws(
        () =>
          parse("function f(): int32 { disposable a: FileHandle; return 0; }"),
        /kind-prefixed binding requires initializer/,
      );
    });
  });
});

describe("parse: phase 7.2 / 9.J - trait bounds on type params", () => {
  it("parses single bound on a generic function param", () => {
    const ast = parse(
      "function drain<T implements Iterable<T>>(ref it: T): void { }",
    );
    const fn = ast.body[0];
    assert.equal(fn.typeParams.length, 1);
    assert.equal(fn.typeParams[0].name, "T");
    assert.equal(fn.typeParams[0].bounds.length, 1);
    assert.equal(fn.typeParams[0].bounds[0].kind, "typeApplication");
    assert.equal(fn.typeParams[0].bounds[0].name, "Iterable");
    assert.equal(fn.typeParams[0].bounds[0].typeArgs.length, 1);
    assert.equal(fn.typeParams[0].bounds[0].typeArgs[0].name, "T");
  });
  it("parses simple (non-generic) trait bound", () => {
    const ast = parse(
      "type Sorted<T implements Ord> { x: T, }",
    );
    const td = ast.body[0];
    assert.equal(td.typeParams[0].name, "T");
    assert.equal(td.typeParams[0].bounds[0].kind, "typeName");
    assert.equal(td.typeParams[0].bounds[0].name, "Ord");
  });
  it("parses bound on a generic trait's type param", () => {
    const ast = parse(
      "trait Container<T implements Display> { function get(ref self): T; }",
    );
    const tr = ast.body[0];
    assert.equal(tr.typeParams[0].name, "T");
    assert.equal(tr.typeParams[0].bounds[0].name, "Display");
  });
  it("unbounded type params still parse with empty bounds list", () => {
    const ast = parse("function id<T>(x: T): T { return x; }");
    assert.deepEqual(ast.body[0].typeParams[0].bounds, []);
  });
  it("parses multiple type params with mixed bounds", () => {
    const ast = parse(
      "function f<T implements Display, U, V implements Iterable<U>>(): void { }",
    );
    const params = ast.body[0].typeParams;
    assert.equal(params.length, 3);
    assert.equal(params[0].bounds[0].name, "Display");
    assert.deepEqual(params[1].bounds, []);
    assert.equal(params[2].bounds[0].name, "Iterable");
  });
  // Phase 9.J: parenthesized multi-bound form.
  it("parses multiple trait bounds on one param", () => {
    const ast = parse(
      "function f<T implements (Display, Iterable<T>)>(ref x: T): void { }",
    );
    const params = ast.body[0].typeParams;
    assert.equal(params.length, 1);
    assert.equal(params[0].bounds.length, 2);
    assert.equal(params[0].bounds[0].name, "Display");
    assert.equal(params[0].bounds[1].name, "Iterable");
  });
  describe("reject cases", () => {
    it("rejects missing trait after implements", () => {
      assert.throws(
        () => parse("function f<T implements>(): void { }"),
        /expected trait name after 'implements'/,
      );
    });
    it("rejects empty parenthesized bound list", () => {
      assert.throws(
        () => parse("function f<T implements ()>(): void { }"),
        /empty trait bound list/,
      );
    });
    it("rejects ref-type as bound", () => {
      assert.throws(
        () => parse("function f<T implements ref Foo>(): void { }"),
        /trait bound must be a trait name/,
      );
    });
  });
});

describe("Phase 7.5: variant declarations", () => {
  it("parses a variant with payload + no-payload cases", () => {
    const ast = parse(
      "variant Shape { Circle { radius: float32 }, Rectangle { w: float32, h: float32 }, Empty, }",
    );
    assert.equal(ast.body.length, 1);
    const e = ast.body[0];
    assert.equal(e.kind, ASTNodeKind.VARIANT_DECL);
    assert.equal(e.name, "Shape");
    assert.equal(e.variants.length, 3);
    assert.equal(e.variants[0].name, "Circle");
    assert.equal(e.variants[0].fields.length, 1);
    assert.equal(e.variants[0].fields[0].name, "radius");
    assert.equal(e.variants[1].name, "Rectangle");
    assert.equal(e.variants[1].fields.length, 2);
    assert.equal(e.variants[2].name, "Empty");
    assert.equal(e.variants[2].fields, null);
  });

  it("parses a generic variant", () => {
    const ast = parse(
      "variant Result<T, E> { Ok { value: T }, Err { error: E } }",
    );
    const e = ast.body[0];
    assert.equal(e.kind, ASTNodeKind.VARIANT_DECL);
    assert.equal(e.typeParams.length, 2);
    assert.equal(e.typeParams[0].name, "T");
    assert.equal(e.typeParams[1].name, "E");
    assert.equal(e.variants[0].name, "Ok");
    assert.equal(e.variants[1].name, "Err");
  });

  it("rejects duplicate case names", () => {
    assert.throws(
      () => parse("variant E { A, A }"),
      /duplicate case name 'A'/,
    );
  });

  it("rejects empty variant decl", () => {
    assert.throws(() => parse("variant E { }"), /must declare at least one case/);
  });

  it("rejects empty payload braces", () => {
    assert.throws(
      () => parse("variant E { A { } }"),
      /empty payload braces/,
    );
  });

  it("parses an exported variant", () => {
    const ast = parse("export variant E { A, B }");
    assert.equal(ast.body[0].kind, ASTNodeKind.EXPORT_DECL);
    assert.equal(ast.body[0].decl.kind, ASTNodeKind.VARIANT_DECL);
    assert.equal(ast.body[0].decl.name, "E");
  });
});

describe("Phase 12: value enum declarations", () => {
  it("parses a default-int32 value enum with bare cases", () => {
    const ast = parse("enum Color { Red, Green, Blue }");
    assert.equal(ast.body.length, 1);
    const e = ast.body[0];
    assert.equal(e.kind, ASTNodeKind.ENUM_DECL);
    assert.equal(e.name, "Color");
    assert.equal(e.underlying.kind, "typeName");
    assert.equal(e.underlying.name, "int32");
    assert.equal(e.cases.length, 3);
    assert.equal(e.cases[0].name, "Red");
    assert.equal(e.cases[0].valueExpr, null);
  });

  it("parses an enum with an explicit underlying type after the name", () => {
    const ast = parse("enum X<int64> { A 0, B 42 }");
    const e = ast.body[0];
    assert.equal(e.underlying.kind, "typeName");
    assert.equal(e.underlying.name, "int64");
    assert.equal(e.cases.length, 2);
    assert.equal(e.cases[0].valueExpr.kind, ASTNodeKind.INT_LITERAL);
    assert.equal(e.cases[0].valueExpr.value, 0);
    assert.equal(e.cases[1].valueExpr.value, 42);
  });

  it("parses an enum Name<string> with string-literal values", () => {
    const ast = parse('enum S<string> { Asc "A", Desc "D" }');
    const e = ast.body[0];
    assert.equal(e.underlying.name, "string");
    assert.equal(e.cases[0].valueExpr.kind, ASTNodeKind.STRING_LITERAL);
  });

  it("parses a flag-style enum with bitwise OR over prior cases", () => {
    const ast = parse("enum F { A 1, B 2, AB A | B }");
    const e = ast.body[0];
    assert.equal(e.cases[2].name, "AB");
    assert.equal(e.cases[2].valueExpr.kind, ASTNodeKind.BINARY_EXPRESSION);
    assert.equal(e.cases[2].valueExpr.op, "pipe");
  });

  it("rejects duplicate case names", () => {
    assert.throws(
      () => parse("enum E { A, A }"),
      /duplicate case name 'A'/,
    );
  });

  it("rejects an empty enum", () => {
    assert.throws(() => parse("enum E { }"), /must declare at least one case/);
  });

  it("rejects multi-arg type slots on value enums (the <T> slot is the underlying type)", () => {
    assert.throws(
      () => parse("enum Result<int32, int64> { A }"),
      /takes a single underlying type/,
    );
  });

  it("parses an exported enum", () => {
    const ast = parse("export enum E { A, B }");
    assert.equal(ast.body[0].kind, ASTNodeKind.EXPORT_DECL);
    assert.equal(ast.body[0].decl.kind, ASTNodeKind.ENUM_DECL);
    assert.equal(ast.body[0].decl.name, "E");
  });
});

describe("Phase 7.5: union declarations", () => {
  it("parses a union with multiple field types", () => {
    const ast = parse(
      "union Color { rgba: uint32, channels: Channels }",
    );
    const u = ast.body[0];
    assert.equal(u.kind, ASTNodeKind.UNION_DECL);
    assert.equal(u.name, "Color");
    assert.equal(u.fields.length, 2);
    assert.equal(u.fields[0].name, "rgba");
    assert.equal(u.fields[1].name, "channels");
  });

  it("rejects generic unions", () => {
    assert.throws(
      () => parse("union U<T> { x: T }"),
      /generic unions are not yet supported/,
    );
  });

  it("rejects union with implements", () => {
    assert.throws(
      () => parse("union U implements Foo { x: int32 }"),
      /union types cannot implement traits/,
    );
  });

  it("rejects empty union", () => {
    assert.throws(
      () => parse("union U { }"),
      /must declare at least one field/,
    );
  });

  it("parses an exported union", () => {
    const ast = parse("export union U { x: int32, y: uint32 }");
    assert.equal(ast.body[0].kind, ASTNodeKind.EXPORT_DECL);
    assert.equal(ast.body[0].decl.kind, ASTNodeKind.UNION_DECL);
  });
});

describe("Phase 7.5: switch statement", () => {
  function switchOf(src) {
    const ast = parse(`function f(): void { ${src} }`);
    return ast.body[0].body.body[0];
  }

  it("parses a literal-arm switch with default", () => {
    const sw = switchOf(
      "switch (n) { case 1: { return; } case 2: { return; } default: { return; } }",
    );
    assert.equal(sw.kind, ASTNodeKind.SWITCH_STATEMENT);
    assert.equal(sw.arms.length, 2);
    assert.equal(sw.arms[0].patterns.length, 1);
    assert.equal(sw.arms[0].patterns[0].kind, ASTNodeKind.LITERAL_PATTERN);
    assert.equal(sw.arms[0].patterns[0].literalKind, "int");
    assert.equal(sw.arms[0].patterns[0].value, 1);
    assert.notEqual(sw.defaultArm, null);
  });

  it("parses multi-pattern arms", () => {
    const sw = switchOf(
      "switch (n) { case 1, 2, 3: { return; } default: { return; } }",
    );
    assert.equal(sw.arms[0].patterns.length, 3);
    assert.deepEqual(
      sw.arms[0].patterns.map((p) => p.value),
      [1, 2, 3],
    );
  });

  it("parses variant patterns with field bindings", () => {
    const sw = switchOf(
      "switch (s) { case Shape.Circle { radius }: { return; } case Shape.Rectangle { w: ww, h: _ }: { return; } case Shape.Empty: { return; } default: { return; } }",
    );
    assert.equal(sw.arms.length, 3);
    const p0 = sw.arms[0].patterns[0];
    assert.equal(p0.kind, ASTNodeKind.VARIANT_PATTERN);
    assert.equal(p0.enumName, "Shape");
    assert.equal(p0.variantName, "Circle");
    assert.equal(p0.fieldBindings.length, 1);
    assert.equal(p0.fieldBindings[0].fieldName, "radius");
    assert.equal(p0.fieldBindings[0].bindingName, "radius");
    assert.equal(p0.fieldBindings[0].isWildcard, false);
    const p1 = sw.arms[1].patterns[0];
    assert.equal(p1.fieldBindings[0].fieldName, "w");
    assert.equal(p1.fieldBindings[0].bindingName, "ww");
    assert.equal(p1.fieldBindings[1].fieldName, "h");
    assert.equal(p1.fieldBindings[1].isWildcard, true);
    const p2 = sw.arms[2].patterns[0];
    assert.equal(p2.enumName, "Shape");
    assert.equal(p2.variantName, "Empty");
    assert.equal(p2.fieldBindings, null);
  });

  it("parses bool literal patterns", () => {
    const sw = switchOf(
      "switch (b) { case true: { return; } case false: { return; } }",
    );
    assert.equal(sw.arms.length, 2);
    assert.equal(sw.arms[0].patterns[0].literalKind, "bool");
    assert.equal(sw.arms[0].patterns[0].value, true);
    assert.equal(sw.arms[1].patterns[0].value, false);
  });

  it("parses underscore as a synonym for default-pattern", () => {
    const sw = switchOf(
      "switch (n) { case _: { return; } }",
    );
    assert.equal(sw.arms[0].patterns[0].isWildcard, true);
  });

  it("parses negative-int literal patterns", () => {
    const sw = switchOf("switch (n) { case -1: { return; } default: { return; } }");
    assert.equal(sw.arms[0].patterns[0].literalKind, "int");
    assert.equal(sw.arms[0].patterns[0].value, -1);
  });

  it("rejects duplicate default", () => {
    assert.throws(
      () => parse("function f(): void { switch (n) { default: { } default: { } } }"),
      /duplicate 'default'/,
    );
  });

  it("rejects default-not-last", () => {
    assert.throws(
      () =>
        parse(
          "function f(): void { switch (n) { default: { } case 1: { } } }",
        ),
      /'default' must be the last clause/,
    );
  });

  it("rejects empty switch body", () => {
    assert.throws(
      () => parse("function f(): void { switch (n) { } }"),
      /empty switch/,
    );
  });

  it("rejects float literal in pattern", () => {
    assert.throws(
      () =>
        parse("function f(): void { switch (n) { case 1.5: { } default: { } } }"),
      /float literals are not allowed/,
    );
  });

  it("rejects bare identifier in pattern", () => {
    assert.throws(
      () =>
        parse("function f(): void { switch (n) { case foo: { } default: { } } }"),
      /variant patterns must be written as EnumName.Variant/,
    );
  });
});

describe("Phase 7.5: variant constructor expression", () => {
  function exprOf(src) {
    const ast = parse(`function f(): void { let _x: T = ${src}; }`);
    return ast.body[0].body.body[0].assignment;
  }

  it("parses a payload variant constructor", () => {
    const e = exprOf("Shape.Circle { radius: 5 }");
    assert.equal(e.kind, ASTNodeKind.VARIANT_CONSTRUCTOR);
    assert.equal(e.enumName, "Shape");
    assert.equal(e.variantName, "Circle");
    assert.equal(e.fields.length, 1);
    assert.equal(e.fields[0].name, "radius");
  });

  it("parses a multi-field variant constructor", () => {
    const e = exprOf("Shape.Rect { w: 3, h: 4 }");
    assert.equal(e.fields.length, 2);
  });

  it("leaves Enum.Variant without payload as a FIELD_ACCESS", () => {
    const e = exprOf("Shape.Empty");
    assert.equal(e.kind, ASTNodeKind.FIELD_ACCESS);
    assert.equal(e.field, "Empty");
    assert.equal(e.object.kind, ASTNodeKind.IDENT);
    assert.equal(e.object.name, "Shape");
  });
});

// Issue 10 path A: reserved keywords accepted in name-only positions so the
// growing keyword set doesn't block common C-style names like `type`, `kind`,
// `enum` in extern bindings, struct fields, etc.
describe("parse: reserved keywords in name-only positions", () => {
  it("struct field name can be a reserved keyword", () => {
    const ast = parse("type Foo { type: int32, kind: int32, enum: bool }");
    const td = ast.body[0];
    assert.equal(td.kind, ASTNodeKind.TYPE_DECL);
    assert.equal(td.fields.length, 3);
    assert.deepEqual(
      td.fields.map((f) => f.name),
      ["type", "kind", "enum"],
    );
  });

  it("struct can mix keyword fields and methods", () => {
    const ast = parse(`
      trait T { function go(ref self): void; }
      type Foo implements T {
        type: int32,
        function go(ref self): void { return; }
      }
    `);
    const td = ast.body[1];
    assert.equal(td.fields.length, 1);
    assert.equal(td.fields[0].name, "type");
    assert.equal(td.methods.length, 1);
    assert.equal(td.methods[0].name, "go");
  });

  it("union field name can be a reserved keyword", () => {
    const ast = parse("union U { type: int32, kind: float32 }");
    const ud = ast.body[0];
    assert.equal(ud.kind, ASTNodeKind.UNION_DECL);
    assert.deepEqual(
      ud.fields.map((f) => f.name),
      ["type", "kind"],
    );
  });

  it("enum case name can be a reserved keyword", () => {
    const ast = parse("enum E { type, kind, enum }");
    const ed = ast.body[0];
    assert.equal(ed.kind, ASTNodeKind.ENUM_DECL);
    assert.deepEqual(
      ed.cases.map((c) => c.name),
      ["type", "kind", "enum"],
    );
  });

  it("variant case name and payload field name can be reserved keywords", () => {
    const ast = parse(
      "variant V { type { kind: int32 }, function }",
    );
    const vd = ast.body[0];
    assert.equal(vd.kind, ASTNodeKind.VARIANT_DECL);
    assert.equal(vd.variants.length, 2);
    assert.equal(vd.variants[0].name, "type");
    assert.equal(vd.variants[0].fields[0].name, "kind");
    assert.equal(vd.variants[1].name, "function");
    assert.equal(vd.variants[1].fields, null);
  });

  it("extern function parameter name can be a reserved keyword", () => {
    const ast = parse(`
      extern "C" from "stdio.h" {
        function f(type: int32, kind: int32, enum: int32): void;
      }
    `);
    const block = ast.body[0];
    assert.equal(block.kind, ASTNodeKind.EXTERN_BLOCK);
    const fn = block.decls[0];
    assert.deepEqual(
      fn.params.map((p) => p.name),
      ["type", "kind", "enum"],
    );
  });

  it("extern ref param keeps the keyword name", () => {
    const ast = parse(`
      extern "C" from "x.h" { function f(ref type: int32): void; }
    `);
    const fn = ast.body[0].decls[0];
    assert.equal(fn.params[0].name, "type");
    assert.equal(fn.params[0].isRef, true);
  });

  it("field access RHS can be a reserved keyword", () => {
    const ast = parse("function f(): int32 { return obj.type; }");
    const ret = ast.body[0].body.body[0];
    assert.equal(ret.value.kind, ASTNodeKind.FIELD_ACCESS);
    assert.equal(ret.value.field, "type");
  });

  it("struct literal field name can be a reserved keyword", () => {
    const ast = parse(
      "function f(): Foo { let x: Foo = { type: 1, kind: 2 }; return x; }",
    );
    const decl = ast.body[0].body.body[0];
    const lit = decl.assignment;
    assert.equal(lit.kind, ASTNodeKind.STRUCT_LITERAL);
    assert.deepEqual(
      lit.fields.map((f) => f.name),
      ["type", "kind"],
    );
  });

  it("variant constructor field name can be a reserved keyword", () => {
    const ast = parse(
      "function f(): int32 { let x: E = E.A { type: 1 }; return 0; }",
    );
    const decl = ast.body[0].body.body[0];
    const vc = decl.assignment;
    assert.equal(vc.kind, ASTNodeKind.VARIANT_CONSTRUCTOR);
    assert.equal(vc.fields[0].name, "type");
  });

  it("user-defined function param still rejects keyword names", () => {
    assert.throws(
      () => parse("function f(type: int32): void { return; }"),
      /expected rparen, got type/,
    );
  });
});
