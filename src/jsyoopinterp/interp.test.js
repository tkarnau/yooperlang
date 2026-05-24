import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parse } from "../jsyooparser/parser.js";
import { typecheckProgram } from "../jsyooptypecheck/typecheck.js";
import { ASTNodeKind } from "../contracts.js";
import { lowerExpressionAsFunction } from "./lower.js";
import { evaluate } from "./interp.js";
import { ComptimeError } from "./diagnostics.js";

// Walk a typechecked single-module program (run via typecheckProgram,
// which is the only path that populates `moduleInitDecls` + stamps
// resolvedType on module-level let/const decls) and pull out the
// initializer of the first such decl.
function firstModuleInitExpr(src) {
  const ast = parse(src);
  const mod = { id: "fixture", absPath: "fixture", src, ast };
  const { errors } = typecheckProgram([mod]);
  assert.equal(errors.length, 0, `unexpected typecheck errors: ${errors.map((e) => e.message).join(" | ")}`);
  for (const decl of mod.moduleInitDecls ?? []) {
    return { ast: decl.assignment, declType: decl.resolvedType };
  }
  throw new Error("no module-level let/const found in test source");
}

describe("comptime: int32 literal + arithmetic fold", () => {
  it("evaluates a single int32 literal", () => {
    const { ast, declType } = firstModuleInitExpr(
      `const N: int32 = 5; function main(): int32 { return 0; }`,
    );
    const fn = lowerExpressionAsFunction(ast, declType);
    const result = evaluate(fn);
    assert.equal(result.v, 5);
  });

  it("evaluates a + b on int32", () => {
    const { ast, declType } = firstModuleInitExpr(
      `const N: int32 = 2 + 3; function main(): int32 { return 0; }`,
    );
    const fn = lowerExpressionAsFunction(ast, declType);
    const result = evaluate(fn);
    assert.equal(result.v, 5);
  });

  it("respects operator precedence (2 + 3 * 4 = 14)", () => {
    const { ast, declType } = firstModuleInitExpr(
      `const N: int32 = 2 + 3 * 4; function main(): int32 { return 0; }`,
    );
    const fn = lowerExpressionAsFunction(ast, declType);
    const result = evaluate(fn);
    assert.equal(result.v, 14);
  });

  it("handles subtraction yielding a negative result", () => {
    const { ast, declType } = firstModuleInitExpr(
      `const N: int32 = 7 - 10; function main(): int32 { return 0; }`,
    );
    const fn = lowerExpressionAsFunction(ast, declType);
    const result = evaluate(fn);
    assert.equal(result.v, -3);
  });

  it("rejects divide-by-zero with a ComptimeError", () => {
    const { ast, declType } = firstModuleInitExpr(
      `const N: int32 = 10 / 0; function main(): int32 { return 0; }`,
    );
    const fn = lowerExpressionAsFunction(ast, declType);
    assert.throws(
      () => evaluate(fn),
      (err) => err instanceof ComptimeError && /divide by zero/.test(err.message),
    );
  });
});

describe("comptime: refuses to lower unsupported AST shapes", () => {
  it("throws ComptimeError for an unsupported node kind", () => {
    // Hand-crafted AST node with a kind the lowerer doesn't handle.
    // Originally this used TEMPLATE_LITERAL (which now lowers as of
    // 11.E.3); the fallback path keeps a real test by reaching for
    // a kind the interpreter is unlikely to ever support directly
    // (DISCARD_STATEMENT belongs to the statement dispatcher, never
    // appears in expression position — exactly the kind of shape
    // the catch-all guard exists to reject).
    const fakeNode = {
      kind: "DISCARD_STATEMENT",
      resolvedType: { kind: "prim", name: "int32" },
      sourceLoc: null,
    };
    assert.throws(
      () => lowerExpressionAsFunction(fakeNode, fakeNode.resolvedType),
      (err) => err instanceof ComptimeError && /DISCARD_STATEMENT.*not supported/.test(err.message),
    );
  });
});
