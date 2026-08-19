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

  it("char literal lowers to an INT_LITERAL carrying its codepoint", () => {
    const e = exprOf("'A'");
    assert.equal(e.kind, ASTNodeKind.INT_LITERAL);
    assert.equal(e.value, 65);
  });

  it("char literal escape lowers to its control codepoint", () => {
    const e = exprOf("'\\n'");
    assert.equal(e.kind, ASTNodeKind.INT_LITERAL);
    assert.equal(e.value, 10);
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

  // Parenthesized subexpressions
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

  // Regression: a unary prefix must fall through to the binary loop rather
  // than returning early, or `!a && b`, `-a + b`, `~a & b` fail to parse.
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

  // Array slice syntax
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

  it("let decl with no annotation leaves typeAnnotation null (inferred)", () => {
    const stmts = bodyOf("let x = 1;");
    assert.equal(stmts[0].kind, ASTNodeKind.LET_DECL);
    assert.equal(stmts[0].name, "x");
    assert.equal(stmts[0].typeAnnotation, null);
    assert.ok(stmts[0].assignment);
  });

  it("const decl with no annotation leaves typeAnnotation null (inferred)", () => {
    const stmts = bodyOf('const s = "hello";');
    assert.equal(stmts[0].kind, ASTNodeKind.CONST_DECL);
    assert.equal(stmts[0].typeAnnotation, null);
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

// `for ITEM in EXPR { ... }` element-walking loop. The classic
// C-style `for (i = 0; ...)` form still parses unchanged; the dispatcher
// looks at whether the token after `for` is `(` or `IDENT in`.
describe("for ... in loop", () => {
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

  // A `{` after an `IDENT.IDENT` RHS must not be swallowed as a variant
  // constructor's payload: that makes `for x in self.items {` a parse error
  // callers can only work around by prebinding the RHS to a local.
  it("a field-access RHS does not swallow the loop body's brace", () => {
    const stmts = bodyOf("for x in self.items { }");
    assert.equal(stmts[0].kind, ASTNodeKind.FOR_IN_LOOP);
    assert.equal(stmts[0].iterExpr.kind, ASTNodeKind.FIELD_ACCESS);
    assert.equal(stmts[0].iterExpr.field, "items");
    assert.equal(stmts[0].body.kind, ASTNodeKind.BLOCK);
  });

  it("a genuine variant payload nested in the RHS still parses as one", () => {
    const stmts = bodyOf("for c in iterOf(Shape.Circle { r: 3 }) { }");
    const arg = stmts[0].iterExpr.args[0];
    assert.equal(stmts[0].kind, ASTNodeKind.FOR_IN_LOOP);
    assert.equal(arg.kind, ASTNodeKind.VARIANT_CONSTRUCTOR);
    assert.equal(arg.enumName, "Shape");
    assert.equal(arg.variantName, "Circle");
  });
});

// The `for (let i = ...; ...; ...)` head. The counter is declared by the loop
// (and scoped to it), the type annotation is optional, and the step slot
// accepts the compound-assignment operators.
describe("for-loop: let-declared counter and compound step", () => {
  function forLoopIn(src) {
    return parse(`function f(): int32 { ${src} return 0; }`).body[0].body.body[0];
  }

  it("`let` in the init marks the counter as loop-declared", () => {
    const loop = forLoopIn("for (let i = 0; i < 5; i = i + 1) { }");
    assert.equal(loop.kind, ASTNodeKind.FOR_LOOP);
    assert.equal(loop.initDeclares, true);
    assert.equal(loop.initIdent, "i");
    assert.equal(loop.initTypeAnnotation, null);
  });

  it("a type annotation on the counter is captured", () => {
    const loop = forLoopIn("for (let i: usize = 0; i < 5; i += 1) { }");
    assert.equal(loop.initDeclares, true);
    assert.deepEqual(loop.initTypeAnnotation, {
      kind: "typeName",
      name: "usize",
    });
  });

  it("the pre-declared form leaves initDeclares false", () => {
    const loop = forLoopIn("for (i = 0; i < 5; i = i + 1) { }");
    assert.equal(loop.initDeclares, false);
    assert.equal(loop.initTypeAnnotation, null);
  });

  it("`i += 2` in the step desugars to `i = i + 2`", () => {
    const loop = forLoopIn("for (let i = 0; i < 5; i += 2) { }");
    assert.equal(loop.stepIdent, "i");
    assert.equal(loop.stepExpr.kind, ASTNodeKind.BINARY_EXPRESSION);
    assert.equal(loop.stepExpr.op, "plus");
    assert.equal(loop.stepExpr.left.kind, ASTNodeKind.IDENT);
    assert.equal(loop.stepExpr.left.name, "i");
    assert.equal(loop.stepExpr.right.value, 2);
  });

  it("every compound step operator maps to its binary op", () => {
    for (const [src, op] of [
      ["i -= 1", "minus"],
      ["i *= 2", "mult"],
      ["i /= 2", "divide"],
      ["i %= 3", "modulus"],
    ]) {
      const loop = forLoopIn(`for (let i = 1; i < 5; ${src}) { }`);
      assert.equal(loop.stepExpr.op, op);
    }
  });

  it("rejects `const` as the counter declaration", () => {
    assert.throws(
      () => forLoopIn("for (const i = 0; i < 5; i += 1) { }"),
      /must be declared with "let"/,
    );
  });
});

// `a..b` builds a RANGE_EXPR, collected on the PROGRAM node so the driver can
// rewrite each one into a std/core/range.yoop call without an AST walk.
describe("range operator: `a..b`", () => {
  function exprOf(src) {
    return parse(`function f(): int32 { const r = ${src}; return 0; }`)
      .body[0].body.body[0].assignment;
  }

  it("builds a RANGE_EXPR with both bounds", () => {
    const r = exprOf("0..10");
    assert.equal(r.kind, ASTNodeKind.RANGE_EXPR);
    assert.equal(r.start.value, 0);
    assert.equal(r.end.value, 10);
  });

  it("collects every range on the PROGRAM node", () => {
    const ast = parse(
      "function f(): int32 { const a = 0..1; const b = 2..3; return 0; }",
    );
    assert.equal(ast.rangeExprs.length, 2);
    assert.equal(ast.rangeExprs[0].kind, ASTNodeKind.RANGE_EXPR);
  });

  it("binds looser than arithmetic, so `0..n - 1` is `0..(n - 1)`", () => {
    const r = exprOf("0..n - 1");
    assert.equal(r.kind, ASTNodeKind.RANGE_EXPR);
    assert.equal(r.end.kind, ASTNodeKind.BINARY_EXPRESSION);
    assert.equal(r.end.op, "minus");
  });

  it("rejects chained bounds", () => {
    assert.throws(() => exprOf("0..2..4"), /cannot be chained/);
  });

  it("leaves the slice form alone", () => {
    // Inside brackets `i..j` is the slice separator, never a range value.
    const s = exprOf("xs[1..3]");
    assert.equal(s.kind, ASTNodeKind.SLICE_EXPRESSION);
    assert.equal(s.start.value, 1);
    assert.equal(s.end.value, 3);
    const open = exprOf("xs[..2]");
    assert.equal(open.kind, ASTNodeKind.SLICE_EXPRESSION);
    assert.equal(open.start, null);
    // A slice whose start is itself arithmetic still finds its `..`.
    const arith = exprOf("xs[a + 1..b]");
    assert.equal(arith.kind, ASTNodeKind.SLICE_EXPRESSION);
    assert.equal(arith.start.kind, ASTNodeKind.BINARY_EXPRESSION);
    assert.equal(arith.end.name, "b");
  });

  it("a range is a plain expression, usable as a for-in RHS", () => {
    const loop = parse(
      "function f(): int32 { for i in 0..3 { } return 0; }",
    ).body[0].body.body[0];
    assert.equal(loop.kind, ASTNodeKind.FOR_IN_LOOP);
    assert.equal(loop.iterExpr.kind, ASTNodeKind.RANGE_EXPR);
    assert.equal(loop.body.kind, ASTNodeKind.BLOCK);
  });
});

// Function value types in type position - `(p: T) => R`. The
// annotation parses to `{ kind: "functionType", params: [...], returnType }`
// and may appear anywhere a type annotation does.
describe("`=>` function value type annotations", () => {
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

describe("parse: postfix '?'", () => {
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

  // The handler form.
  it("'f()? e { ... }' attaches the binding name and the block", () => {
    const stmts = bodyOf("let v: int32 = f()? e { return 0; };");
    const t = stmts[0].assignment;
    assert.equal(t.kind, ASTNodeKind.TRY_OP);
    assert.equal(t.operand.kind, ASTNodeKind.CALL_EXPRESSION);
    assert.equal(t.handlerBinding, "e");
    assert.equal(t.handlerBlock.kind, ASTNodeKind.BLOCK);
    assert.equal(t.handlerBlock.body.length, 1);
    assert.equal(t.handlerBlock.body[0].kind, ASTNodeKind.RETURN_STATEMENT);
    // The handler and context forms are mutually exclusive.
    assert.equal(t.context, null);
  });

  it("the plain and context forms carry no handler", () => {
    const plain = exprOf("f()?");
    assert.equal(plain.handlerBinding, undefined);
    assert.equal(plain.handlerBlock, undefined);

    const ctx = exprOf('f()? "reading it"');
    assert.equal(ctx.context.kind, ASTNodeKind.STRING_LITERAL);
    assert.equal(ctx.handlerBlock, undefined);
  });

  // A `{` directly after `?` is the for-in body, not a handler - which is
  // why the binding is required rather than optional.
  it("'for x in f()? { ... }' keeps the brace as the loop body", () => {
    const ast = parse(
      "function f(): int32 { for x in items()? { printf(\"hi\"); } return 0; }",
    );
    const loop = ast.body[0].body.body[0];
    assert.equal(loop.kind, ASTNodeKind.FOR_IN_LOOP);
    assert.equal(loop.iterExpr.kind, ASTNodeKind.TRY_OP);
    assert.equal(loop.iterExpr.handlerBlock, undefined);
    assert.equal(loop.body.kind, ASTNodeKind.BLOCK);
  });

  it("'r? = 5' is rejected - TRY_OP is not a valid lvalue", () => {
    assert.throws(() => bodyOf("r? = 5;"), /invalid assignment target: TRY_OP/);
  });

  // The optional context clause.
  it("'f()?' has a null context", () => {
    assert.equal(exprOf("f()?").context, null);
  });

  it("'f()? \"loading\"' attaches a STRING_LITERAL context", () => {
    const t = exprOf('f()? "loading"');
    assert.equal(t.kind, ASTNodeKind.TRY_OP);
    assert.equal(t.operand.kind, ASTNodeKind.CALL_EXPRESSION);
    assert.equal(t.context.kind, ASTNodeKind.STRING_LITERAL);
    assert.equal(t.context.value, '"loading"');
  });

  it("'f()? `at ${n}`' attaches an interpolated TEMPLATE_LITERAL context", () => {
    const t = exprOf("f()? `at ${n}`");
    assert.equal(t.kind, ASTNodeKind.TRY_OP);
    assert.equal(t.context.kind, ASTNodeKind.TEMPLATE_LITERAL);
    const exprParts = t.context.parts.filter((p) => p.kind === ASTNodeKind.EXPR_PART);
    assert.equal(exprParts.length, 1);
    assert.equal(exprParts[0].expr.name, "n");
  });

  // The context is restricted to the two literal token forms precisely so
  // this stays subtraction rather than a context expression.
  it("'f()? - x' is still a subtraction, not a context", () => {
    const e = exprOf("f()? - x");
    assert.equal(e.kind, ASTNodeKind.BINARY_EXPRESSION);
    assert.equal(e.op, "minus");
    assert.equal(e.left.kind, ASTNodeKind.TRY_OP);
    assert.equal(e.left.context, null);
  });

  it("a context binds to the nearest '?': 'f()? \"a\" .b?' keeps them separate", () => {
    const t = exprOf('f()? "a".b? "c"');
    assert.equal(t.kind, ASTNodeKind.TRY_OP);
    assert.equal(t.context.value, '"c"');
    assert.equal(t.operand.kind, ASTNodeKind.FIELD_ACCESS);
    assert.equal(t.operand.object.kind, ASTNodeKind.TRY_OP);
    assert.equal(t.operand.object.context.value, '"a"');
  });
});

describe("parse: destructuring decl", () => {
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

describe("parse: discard statement", () => {
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

describe("parse: traits", () => {
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
  it("type alias `type X = Y;` parses targetType as a type annotation", () => {
    const stmts = parse("type NodeId = usize;").body;
    assert.equal(stmts.length, 1);
    const td = stmts[0];
    assert.equal(td.kind, ASTNodeKind.TYPE_DECL);
    assert.equal(td.name, "NodeId");
    assert.equal(td.fields, undefined); // not a struct
    assert.deepEqual(td.targetType, { kind: "typeName", name: "usize" });
  });

  it("type alias accepts a full type annotation RHS (array of an alias)", () => {
    const td = parse("type IdList = NodeId[];").body[0];
    assert.equal(td.kind, ASTNodeKind.TYPE_DECL);
    assert.deepEqual(td.targetType, {
      kind: "arrayType",
      elem: { kind: "typeName", name: "NodeId" },
    });
  });

  it("type alias requires the `=` and a trailing `;`", () => {
    assert.throws(() => parse("type NodeId usize;"), /expected/);
    assert.throws(() => parse("type NodeId = usize"), /expected semicolon/);
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
    it("parses generic traits", () => {
      const ast = parse(
        "trait MyTrait<T> { function method(ref self, x: T): void; }",
      );
      const tr = ast.body[0];
      assert.equal(tr.kind, "TRAIT_DECL");
      assert.equal(tr.name, "MyTrait");
      assert.equal(tr.typeParams.length, 1);
      assert.equal(tr.typeParams[0].name, "T");
    });
    // `extends` is supported.
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

describe("parse: kind decls", () => {
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

  it("`appliesTo region` parses (contextual site ident)", () => {
    const k = parse(
      "kind ephemeral { appliesTo region; requires Disposable; mustCall dispose beforeScopeEnd; ownsBlock; }",
    ).body[0];
    assert.equal(k.clauses[0].kind, ASTNodeKind.KIND_APPLIES_TO_CLAUSE);
    assert.deepEqual(k.clauses[0].sites, ["region"]);
  });

  it("`region` stays usable as an ordinary identifier outside kind clauses", () => {
    const s = parse("function f(): int32 { let region: int32 = 1; return region; }");
    assert.equal(s.body[0].body.body[0].name, "region");
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
    // testing-via-kinds: `appliesTo function` parses. The requirement that
    // it also declare `signature` + `enumerable as` is a typecheck rule, not a
    // grammar one, so the parser accepts the bare site.
    it("accepts appliesTo function site", () => {
      const ast = parse("kind k { appliesTo function; }");
      const clause = ast.body[0].clauses[0];
      assert.deepEqual(clause.sites, ["function"]);
    });

    it("parses a function kind's signature and enumerable clauses", () => {
      const ast = parse(
        'kind suite { appliesTo function; signature (run: ref Run) => void; enumerable as "suites"; }',
      );
      const [applies, signature, enumerable] = ast.body[0].clauses;
      assert.deepEqual(applies.sites, ["function"]);
      assert.equal(signature.signatureAnnotation.kind, "functionType");
      assert.deepEqual(signature.signatureAnnotation.params, [
        { kind: "refType", inner: { kind: "typeName", name: "Run" } },
      ]);
      assert.equal(enumerable.tableName, "suites");
    });

    it("rejects a signature clause that is not a function type", () => {
      assert.throws(
        () => parse("kind k { appliesTo function; signature int32; }"),
        /signature clause requires a function type/,
      );
    });

    it("rejects an enumerable clause with no table name", () => {
      assert.throws(
        () => parse("kind k { appliesTo function; enumerable; }"),
        /enumerable clause requires a table name/,
      );
    });

    it("parses a kind-prefixed top-level function decl", () => {
      const ast = parse(
        'kind suite { appliesTo function; signature () => void; enumerable as "suites"; }\n' +
          "suite function myBehavior(): void {}",
      );
      assert.equal(ast.body[1].kind, "FUNCTION_DECL");
      assert.equal(ast.body[1].name, "myBehavior");
      assert.equal(ast.body[1].kindPrefix.name, "suite");
    });

    it("parses `import.test;` as a module flag", () => {
      assert.equal(parse("import.test;\nfunction main(): int { return 0; }").isTestModule, true);
      assert.equal(parse("function main(): int { return 0; }").isTestModule, false);
      assert.throws(
        () => parse("import.test;\nimport.test;"),
        /duplicate 'import.test;' declaration/,
      );
      assert.throws(
        () => parse("import.bogus;"),
        /only 'import.unsafe' and 'import.test' are supported/,
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
        /mustCall dispose beforeAny is not supported/,
      );
    });
    it("rejects mustCall block (alternation) form", () => {
      assert.throws(
        () =>
          parse(
            "kind k { appliesTo binding; mustCall { wait; abandon; } beforeScopeEnd; }",
          ),
        /mustCall block form \(alternation\) is not supported/,
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
    it("accepts parameterized kind decl", () => {
      const ast = parse("kind k(n: usize) { appliesTo binding; }");
      const k = ast.body[0];
      assert.equal(k.name, "k");
      assert.equal(k.params.length, 1);
      assert.equal(k.params[0].name, "n");
    });
    it("accepts kind composition", () => {
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
    // `provides <Kind>` is what lets `task` rewrite its call-site result
    // type to Task<T>.
    it("parses a provides clause", () => {
      const ast = parse("kind k { appliesTo function; provides Task; }");
      const clause = ast.body[0].clauses.find(
        (c) => c.kind === "KIND_PROVIDES_CLAUSE",
      );
      assert.ok(clause, "expected a provides clause");
      assert.equal(clause.providedName, "Task");
    });

    it("parses a refcounted clause naming its two methods", () => {
      const ast = parse(
        "kind k { appliesTo binding; requires Shared; refcounted retain release; }",
      );
      const clause = ast.body[0].clauses.find(
        (c) => c.kind === "KIND_REFCOUNTED_CLAUSE",
      );
      assert.ok(clause, "expected a refcounted clause");
      assert.equal(clause.retainMethod, "retain");
      assert.equal(clause.releaseMethod, "release");
    });

    // autoJoin is only `mustCall wait beforeScopeEnd` spelled differently;
    // the diagnostic says so.
    it("rejects autoJoin with a pointer at mustCall", () => {
      assert.throws(
        () => parse("kind k { appliesTo binding; autoJoin beforeScopeEnd; }"),
        /mustCall wait beforeScopeEnd/,
      );
    });
    it("rejects mustNotEscape without 'scope' keyword", () => {
      assert.throws(
        () =>
          parse("kind k { appliesTo binding; mustNotEscape; }"),
        /mustNotEscape semicolon is not supported/,
      );
    });
    // `mustNotShare acrossThreads` joins `acrossScopes` as a legal
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

describe("parse: kind-prefixed bindings", () => {
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

  // Inferred-type named binding: `disposable a = expr` (no `: T`). The
  // recognizer accepts the `=` shape alongside `:`.
  it("named binding infers its type when the annotation is omitted (implicit block)", () => {
    const s = stmtOf("disposable a = make_handle();");
    assert.equal(s.kind, ASTNodeKind.CONST_DECL);
    assert.equal(s.name, "a");
    assert.equal(s.kindPrefix.name, "disposable");
    assert.equal(s.typeAnnotation, null);
    assert.equal(s.trailingBlock, null);
    assert.equal(s.assignment.kind, ASTNodeKind.CALL_EXPRESSION);
  });

  it("named binding infers its type with a trailing block", () => {
    const s = stmtOf("disposable a = make_handle() { return 0; }");
    assert.equal(s.name, "a");
    assert.equal(s.typeAnnotation, null);
    assert.equal(s.kindPrefix.name, "disposable");
    assert.equal(s.trailingBlock.kind, ASTNodeKind.BLOCK);
  });

  it("explicit `let disposable a = expr` infers type too", () => {
    const s = stmtOf("let disposable a = make_handle();");
    assert.equal(s.kind, ASTNodeKind.LET_DECL);
    assert.equal(s.kindPrefix.name, "disposable");
    assert.equal(s.typeAnnotation, null);
  });
});

// Anonymous region-kind blocks: `KIND EXPR { ... }` / `KIND EXPR;` with no
// binding name. The kind is the first ident, the second ident begins the
// initializer expression, and there is no `:`/`=`.
describe("parse: region kinds - anonymous block bindings", () => {
  function stmtOf(src) {
    const ast = parse(`function f(): int32 { ${src} return 0; }`);
    return ast.body[0].body.body[0];
  }

  it("anonymous explicit block: `ephemeral mem.scope(arena) { ... }`", () => {
    const s = stmtOf("ephemeral mem.scope(arena) { doThing(); }");
    assert.equal(s.kind, ASTNodeKind.CONST_DECL);
    assert.equal(s.anonymousRegion, true);
    assert.equal(s.kindPrefix.name, "ephemeral");
    assert.equal(s.typeAnnotation, null);
    assert.match(s.name, /^\$region\$\d+$/);
    assert.equal(s.assignment.kind, ASTNodeKind.CALL_EXPRESSION);
    assert.equal(s.trailingBlock.kind, ASTNodeKind.BLOCK);
  });

  it("anonymous implicit block (no braces): `ephemeral mem.scope(arena);`", () => {
    const s = stmtOf("ephemeral mem.scope(arena); doThing();");
    assert.equal(s.anonymousRegion, true);
    assert.equal(s.kindPrefix.name, "ephemeral");
    assert.equal(s.trailingBlock, null);
  });

  it("synthesized names are unique across multiple anonymous blocks", () => {
    const ast = parse(
      "function f(): int32 { ephemeral a(); ephemeral b(); return 0; }",
    );
    const [s0, s1] = ast.body[0].body.body;
    assert.notEqual(s0.name, s1.name);
  });

  it("does not steal a plain call or member-call statement", () => {
    assert.equal(stmtOf("doThing(x);").kind, ASTNodeKind.EXPRESSION_STATEMENT);
    assert.equal(stmtOf("mem.reset(arena);").kind, ASTNodeKind.EXPRESSION_STATEMENT);
  });
});

describe("parse: trait bounds on type params", () => {
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
  // Parenthesized multi-bound form.
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

describe("variant declarations", () => {
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

describe("value enum declarations", () => {
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

describe("union declarations", () => {
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
      /generic unions are not supported/,
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

describe("switch statement", () => {
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

describe("variant constructor expression", () => {
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

  it("user-defined function param rejects keyword names, and names the word", () => {
    // The message names the mistake. `expected rparen, got type` would
    // describe the parser's state instead, leaving the reader to notice that
    // their parameter name is a keyword.
    assert.throws(
      () => parse("function f(type: int32): void { return; }"),
      /"type" is a reserved word and cannot be used as a name/,
    );
  });

  it("names the reason for the three keywords that cannot be made contextual", () => {
    for (const [word, reason] of [
      ["in", /for x in xs/],
      ["from", /import \.\.\. from/],
      ["as", /import \* as ns/],
    ]) {
      assert.throws(
        () => parse(`function f(${word}: int32): void { return; }`),
        reason,
        `expected the "${word}" diagnostic to say why it is reserved`,
      );
    }
  });

  // Two shapes Yoop does not have, where a generic diagnostic would describe
  // the parser's state instead of the rule.
  it("a nested function declaration says to move it to module scope", () => {
    assert.throws(
      () => parse("function f(): void { function g(): void { return; } }"),
      /functions cannot be declared inside another function body/,
    );
  });

  it("a bare block says it is not a statement, instead of a struct-literal error", () => {
    // Used to be `expected colon, got ident` pointing at `x`, because the
    // brace fell through to expression parsing and was read as a struct
    // literal the user was not writing.
    assert.throws(
      () => parse("function f(): void { { let x: int32 = 1; } }"),
      /a bare "\{ \.\.\. \}" block is not a statement/,
    );
  });

  it("a struct literal in expression position still parses", () => {
    // The bare-block check must not touch a `{` that arrives through an
    // initializer or an argument rather than at statement start.
    const ast = parse("function f(): void { let p: P = { x: 1, y: 2 }; }");
    const decl = ast.body[0].body.body[0];
    assert.equal(decl.assignment.kind, ASTNodeKind.STRUCT_LITERAL);
    assert.equal(decl.assignment.fields.length, 2);
  });

  // These are contextual keywords, so they work as ordinary parameter names.
  it("accepts the contextual keywords as parameter names", () => {
    for (const word of [
      "kind", "requires", "propagates", "binding", "parameter",
      "field", "scope", "io", "layout", "align", "library", "contains",
    ]) {
      const ast = parse(`function f(${word}: int32): void { return; }`);
      const decl = ast.body[0];
      assert.equal(
        decl.params[0].name,
        word,
        `expected "${word}" to be usable as a parameter name`,
      );
    }
  });
});

// A parenthesized type group lets `[]` attach to a function type,
// which is the only way to spell an array of function pointers.
describe("parse: parenthesized type groups (array of function pointers)", () => {
  function paramType(srcLine) {
    const ast = parse(`function f(p: ${srcLine}): void { return; }`);
    return ast.body[0].params[0].typeAnnotation;
  }

  it("`(a: int32) => bool` still parses as a bare function type", () => {
    const t = paramType("(a: int32) => bool");
    assert.equal(t.kind, "functionType");
    assert.deepEqual(t.params, [{ kind: "typeName", name: "int32" }]);
    assert.deepEqual(t.returnType, { kind: "typeName", name: "bool" });
  });

  it("`((a: int32) => bool)[]` is an array whose element is a function type", () => {
    const t = paramType("((a: int32) => bool)[]");
    assert.equal(t.kind, "arrayType");
    assert.equal(t.elem.kind, "functionType");
    assert.deepEqual(t.elem.params, [{ kind: "typeName", name: "int32" }]);
    assert.deepEqual(t.elem.returnType, { kind: "typeName", name: "bool" });
  });

  it("`(a: int32) => bool[]` binds the `[]` to the return type (no grouping)", () => {
    const t = paramType("(a: int32) => bool[]");
    assert.equal(t.kind, "functionType");
    assert.deepEqual(t.returnType, {
      kind: "arrayType",
      elem: { kind: "typeName", name: "bool" },
    });
  });

  it("a parenthesized simple type with `[]` is an array of that type", () => {
    const t = paramType("(int32)[]");
    assert.deepEqual(t, {
      kind: "arrayType",
      elem: { kind: "typeName", name: "int32" },
    });
  });

  it("nested `[]` suffixes on a group stack into nested array types", () => {
    const t = paramType("((a: int32) => bool)[][]");
    assert.equal(t.kind, "arrayType");
    assert.equal(t.elem.kind, "arrayType");
    assert.equal(t.elem.elem.kind, "functionType");
  });
});

describe("@derive attribute targets", () => {
  it("parses @derive(display) on a type decl", () => {
    const ast = parse(
      `@derive(display)\ntype Point {\n  x: int32,\n}\n`,
    );
    const attr = ast.body[0];
    assert.equal(attr.kind, ASTNodeKind.ATTRIBUTE);
    assert.equal(attr.name, "derive");
    assert.equal(attr.args.length, 1);
    assert.equal(attr.args[0].kind, ASTNodeKind.IDENT);
    assert.equal(attr.args[0].name, "display");
    assert.equal(attr.target.kind, ASTNodeKind.TYPE_DECL);
    assert.equal(attr.target.name, "Point");
  });

  it("parses @derive(display) on an exported type decl", () => {
    const ast = parse(
      `@derive(display)\nexport type Point {\n  x: int32,\n}\n`,
    );
    const attr = ast.body[0];
    assert.equal(attr.target.kind, ASTNodeKind.EXPORT_DECL);
    assert.equal(attr.target.decl.kind, ASTNodeKind.TYPE_DECL);
  });

  it("rejects unsupported derive names with a clear message", () => {
    assert.throws(
      () => parse(`@derive(eq)\ntype P {\n  x: int32,\n}\n`),
      /@derive\(eq\) is not supported - @derive\(display\) is the only one/,
    );
  });

  it("rejects unknown derive names", () => {
    assert.throws(
      () => parse(`@derive(banana)\ntype P {\n  x: int32,\n}\n`),
      /unknown derive "banana" - supported derives: display/,
    );
  });

  it("rejects a missing or non-ident derive argument", () => {
    assert.throws(
      () => parse(`@derive\ntype P {\n  x: int32,\n}\n`),
      /@derive requires exactly one derive name argument/,
    );
  });

  it("rejects non-type targets", () => {
    assert.throws(
      () => parse(`@derive(display)\nlet x: int32 = 1;\n`),
      /@derive\(display\) only applies to a struct 'type' or 'variant' declaration/,
    );
  });

  it("@precompile still rejects type targets at parse time", () => {
    assert.throws(
      () => parse(`@precompile\ntype P {\n  x: int32,\n}\n`),
      /@precompile requires a '\{ \.\.\. \}' block or a 'let' \/ 'const' declaration/,
    );
  });
});

describe("@derive on variant decls", () => {
  it("parses @derive(display) on a variant decl", () => {
    const ast = parse(
      `@derive(display)\nvariant Shape {\n  Circle { r: int32 },\n  Dot,\n}\n`,
    );
    const attr = ast.body[0];
    assert.equal(attr.kind, ASTNodeKind.ATTRIBUTE);
    assert.equal(attr.target.kind, ASTNodeKind.VARIANT_DECL);
    assert.equal(attr.target.name, "Shape");
    assert.equal(attr.target.variants.length, 2);
  });

  it("parses @derive(display) on an exported variant decl", () => {
    const ast = parse(
      `@derive(display)\nexport variant Shape {\n  Dot,\n}\n`,
    );
    const attr = ast.body[0];
    assert.equal(attr.target.kind, ASTNodeKind.EXPORT_DECL);
    assert.equal(attr.target.decl.kind, ASTNodeKind.VARIANT_DECL);
  });

});

describe("variant case payload must be a record", () => {
  // Without the check `Special MyType` parses silently as TWO payload-less
  // cases (the separating comma is optional), so the only symptom is a
  // phantom "missing variants: MyType" from a later exhaustiveness check.
  it("rejects a bare-type payload with a fix-it", () => {
    assert.throws(
      () =>
        parse(
          `variant MyVariant {\n  Normal { p: int32 },\n  Special MyType,\n}\n`,
        ),
      /variant case 'Special' is followed by 'MyType' with no separator - a case payload must be a record, e\.g\. 'Special \{ value: MyType \}'/,
    );
  });

  it("still accepts the record payload form", () => {
    const ast = parse(
      `variant MyVariant {\n  Normal { p: int32 },\n  Special { value: MyType },\n}\n`,
    );
    const cases = ast.body[0].variants;
    assert.equal(cases.length, 2);
    assert.deepEqual(cases[1].fields.map((f) => f.name), ["value"]);
  });

  it("still accepts payload-less cases and trailing methods", () => {
    const ast = parse(
      `variant V implements D {\n  A,\n  B { x: int32 },\n  function f(ref self): int32 {\n    return 1;\n  }\n}\n`,
    );
    assert.equal(ast.body[0].variants.length, 2);
    assert.equal(ast.body[0].methods.length, 1);
  });
});
