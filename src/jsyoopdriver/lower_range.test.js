import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parse } from "../jsyooparser/parser.js";
import { ASTNodeKind } from "../contracts.js";
import { lowerRangeExprs } from "./lower_range.js";

describe("lowerRangeExprs", () => {
  function loweredBody(src) {
    const ast = parse(src);
    const needed = lowerRangeExprs(ast);
    return { ast, needed };
  }

  it("rewrites `a..b` into a namespaced call to range.exclusive", () => {
    const { ast, needed } = loweredBody(
      "function f(): int32 { const r = 2..7; return 0; }",
    );
    assert.equal(needed, true);
    // body[0] is the synthesized import; the function moved down one slot.
    const call = ast.body[1].body.body[0].assignment;
    assert.equal(call.kind, ASTNodeKind.CALL_EXPRESSION);
    assert.equal(call.callee.kind, ASTNodeKind.FIELD_ACCESS);
    assert.equal(call.callee.object.name, "$range");
    assert.equal(call.callee.field, "exclusive");
    assert.equal(call.args.length, 2);
    assert.equal(call.args[0].value, 2);
    assert.equal(call.args[1].value, 7);
    // The RANGE_EXPR fields are gone, so nothing downstream can read them.
    assert.equal(call.start, undefined);
    assert.equal(call.end, undefined);
  });

  it("unshifts a namespace import for std/core/range.yoop", () => {
    const { ast } = loweredBody(
      "function f(): int32 { for i in 0..3 { } return 0; }",
    );
    const imp = ast.body[0];
    assert.equal(imp.kind, ASTNodeKind.IMPORT_DECL);
    assert.equal(imp.importKind, "namespace");
    assert.equal(imp.namespaceName, "$range");
    assert.equal(imp.sourcePath, "std/core/range.yoop");
  });

  it("keeps the import first when the module already has imports", () => {
    // The graph walk stops reading imports at the first non-import decl, so a
    // synthesized import that landed after one would never be resolved.
    const { ast } = loweredBody(
      'import * as m from "./m.yoop";\nfunction f(): int32 { for i in 0..3 { } return 0; }',
    );
    assert.equal(ast.body[0].kind, ASTNodeKind.IMPORT_DECL);
    assert.equal(ast.body[1].kind, ASTNodeKind.IMPORT_DECL);
    assert.equal(ast.body[2].kind, ASTNodeKind.FUNCTION_DECL);
  });

  it("is a no-op for a module with no ranges", () => {
    const { ast, needed } = loweredBody(
      "function f(): int32 { const r = 2; return 0; }",
    );
    assert.equal(needed, false);
    assert.equal(ast.body.length, 1);
    assert.equal(ast.body[0].kind, ASTNodeKind.FUNCTION_DECL);
  });

  it("is idempotent - a second call adds no second import", () => {
    const ast = parse("function f(): int32 { const r = 0..3; return 0; }");
    assert.equal(lowerRangeExprs(ast), true);
    assert.equal(lowerRangeExprs(ast), false);
    assert.equal(ast.body.filter((d) => d.kind === ASTNodeKind.IMPORT_DECL).length, 1);
  });

  it("rewrites every range in the module", () => {
    const { ast } = loweredBody(
      "function f(): int32 { for i in 0..2 { } for j in 3..4 { } return 0; }",
    );
    const body = ast.body[1].body.body;
    for (const loop of [body[0], body[1]]) {
      assert.equal(loop.iterExpr.kind, ASTNodeKind.CALL_EXPRESSION);
      assert.equal(loop.iterExpr.callee.field, "exclusive");
    }
  });
});
