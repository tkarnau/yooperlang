// Integration tests for the typechecker: feed in source, parse + typecheck,
// assert on errors. Pure-helper unit tests (isAssignable, unifyArith,
// coerceLiteralToType) live in coerce.test.js.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { typecheckSource } from "./typecheck.js";

describe("typecheckSource: well-typed programs produce zero errors", () => {
  it("function with int literal return", () => {
    const { errors } = typecheckSource(
      "function main(): int32 { return 0; }",
    );
    assert.deepEqual(errors, []);
  });

  it("let binding with matching int literal", () => {
    const { errors } = typecheckSource(
      "function main(): int32 { let x: int32 = 42; return x; }",
    );
    assert.deepEqual(errors, []);
  });

  it("binary op between two int literals", () => {
    const { errors } = typecheckSource(
      "function main(): int32 { return 1 + 2; }",
    );
    assert.deepEqual(errors, []);
  });

  it("function call with matching arg type", () => {
    const { errors } = typecheckSource(
      "function add(a: int32, b: int32): int32 { return a + b; }\n" +
        "function main(): int32 { return add(1, 2); }",
    );
    assert.deepEqual(errors, []);
  });
});

describe("typecheckSource: ill-typed programs report positioned errors", () => {
  it("string assigned to int32 produces an assignment error", () => {
    const { errors } = typecheckSource(
      'function main(): int32 { let x: int32 = "oops"; return x; }',
    );
    assert.ok(errors.length >= 1);
    assert.match(errors[0].message, /string.*int32|int32.*string/);
  });

  it("undeclared variable produces an undefined error", () => {
    const { errors } = typecheckSource(
      "function main(): int32 { return zzz; }",
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /undefined.*zzz/);
  });

  it("wrong arg count is flagged", () => {
    const { errors } = typecheckSource(
      "function add(a: int32, b: int32): int32 { return a + b; }\n" +
        "function main(): int32 { return add(1); }",
    );
    assert.ok(errors.some((e) => /arg count|wrong arg/.test(e.message)));
  });

  it("redeclaration of a function is flagged", () => {
    const { errors } = typecheckSource(
      "function f(): int32 { return 0; }\n" +
        "function f(): int32 { return 1; }\n" +
        "function main(): int32 { return 0; }",
    );
    assert.ok(errors.some((e) => /redeclaration.*f/.test(e.message)));
  });

  it("int literal out of range for int8", () => {
    const { errors } = typecheckSource(
      "function main(): int32 { let x: int8 = 200; return 0; }",
    );
    assert.ok(errors.some((e) => /out of range|range/i.test(e.message)));
  });
});

