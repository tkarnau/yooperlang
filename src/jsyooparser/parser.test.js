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

describe("parse: phase 7.2 - trait bounds on type params", () => {
  it("parses single bound on a generic function param", () => {
    const ast = parse(
      "function drain<T implements Iterable<T>>(ref it: T): void { }",
    );
    const fn = ast.body[0];
    assert.equal(fn.typeParams.length, 1);
    assert.equal(fn.typeParams[0].name, "T");
    assert.ok(fn.typeParams[0].bound);
    assert.equal(fn.typeParams[0].bound.kind, "typeApplication");
    assert.equal(fn.typeParams[0].bound.name, "Iterable");
    assert.equal(fn.typeParams[0].bound.typeArgs.length, 1);
    assert.equal(fn.typeParams[0].bound.typeArgs[0].name, "T");
  });
  it("parses simple (non-generic) trait bound", () => {
    const ast = parse(
      "type Sorted<T implements Ord> { x: T, }",
    );
    const td = ast.body[0];
    assert.equal(td.typeParams[0].name, "T");
    assert.equal(td.typeParams[0].bound.kind, "typeName");
    assert.equal(td.typeParams[0].bound.name, "Ord");
  });
  it("parses bound on a generic trait's type param", () => {
    const ast = parse(
      "trait Container<T implements Display> { function get(ref self): T; }",
    );
    const tr = ast.body[0];
    assert.equal(tr.typeParams[0].name, "T");
    assert.equal(tr.typeParams[0].bound.name, "Display");
  });
  it("unbounded type params still parse with bound: null", () => {
    const ast = parse("function id<T>(x: T): T { return x; }");
    assert.equal(ast.body[0].typeParams[0].bound, null);
  });
  it("parses multiple type params with mixed bounds", () => {
    const ast = parse(
      "function f<T implements Display, U, V implements Iterable<U>>(): void { }",
    );
    const params = ast.body[0].typeParams;
    assert.equal(params.length, 3);
    assert.equal(params[0].bound.name, "Display");
    assert.equal(params[1].bound, null);
    assert.equal(params[2].bound.name, "Iterable");
  });
  describe("reject cases", () => {
    it("rejects missing trait after implements", () => {
      assert.throws(
        () => parse("function f<T implements>(): void { }"),
        /expected trait name after 'implements'/,
      );
    });
    it("rejects empty parenthesized bound list (multiple bounds reserved)", () => {
      assert.throws(
        () => parse("function f<T implements (Foo, Bar)>(): void { }"),
        /multiple trait bounds.*not yet supported/,
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
