import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  coerceLiteralToType,
  isAssignable,
  isBool,
  unifyArith,
} from "./coerce.js";
import {
  ErrorType,
  PrimType,
  UntypedFloatType,
  UntypedIntType,
} from "./types.js";
import { ASTNodeKind } from "../contracts.js";

describe("isBool", () => {
  it("true for prim bool", () => assert.ok(isBool(PrimType("bool"))));
  it("false for int32", () => assert.ok(!isBool(PrimType("int32"))));
  it("false for untyped int", () => assert.ok(!isBool(UntypedIntType())));
});

describe("isAssignable", () => {
  it("equal prim types are assignable", () => {
    assert.ok(isAssignable(PrimType("int32"), PrimType("int32")));
  });
  it("untyped int -> any int prim", () => {
    assert.ok(isAssignable(PrimType("int32"), UntypedIntType()));
    assert.ok(isAssignable(PrimType("uint8"), UntypedIntType()));
    assert.ok(isAssignable(PrimType("int64"), UntypedIntType()));
  });
  it("untyped float -> any float prim", () => {
    assert.ok(isAssignable(PrimType("float32"), UntypedFloatType()));
    assert.ok(isAssignable(PrimType("float64"), UntypedFloatType()));
  });
  it("untyped int is NOT assignable to a float prim (no implicit cross-coercion)", () => {
    assert.ok(!isAssignable(PrimType("float32"), UntypedIntType()));
  });
  it("string is NOT assignable to int32", () => {
    assert.ok(!isAssignable(PrimType("int32"), PrimType("string")));
  });
  it("error type suppresses cascades on either side", () => {
    assert.ok(isAssignable(ErrorType(), PrimType("int32")));
    assert.ok(isAssignable(PrimType("int32"), ErrorType()));
  });
  it("null/undefined returns false (no crash)", () => {
    assert.ok(!isAssignable(null, PrimType("int32")));
    assert.ok(!isAssignable(PrimType("int32"), undefined));
  });
});

describe("unifyArith", () => {
  it("untyped int + untyped int -> untyped int", () => {
    assert.deepEqual(
      unifyArith(UntypedIntType(), UntypedIntType(), "plus"),
      UntypedIntType(),
    );
  });
  it("untyped float + untyped float -> untyped float", () => {
    assert.deepEqual(
      unifyArith(UntypedFloatType(), UntypedFloatType(), "plus"),
      UntypedFloatType(),
    );
  });
  it("int32 + untyped int -> int32 (typed wins)", () => {
    assert.deepEqual(
      unifyArith(PrimType("int32"), UntypedIntType(), "plus"),
      PrimType("int32"),
    );
  });
  it("comparison op produces bool", () => {
    assert.deepEqual(
      unifyArith(PrimType("int32"), PrimType("int32"), "eqeq"),
      PrimType("bool"),
    );
  });
  it("two int32 with arithmetic op stay int32", () => {
    assert.deepEqual(
      unifyArith(PrimType("int32"), PrimType("int32"), "plus"),
      PrimType("int32"),
    );
  });
  it("int + float is unsupported (no implicit cross-coercion)", () => {
    assert.equal(unifyArith(PrimType("int32"), PrimType("float32"), "plus"), null);
  });
  it("logical 'and' of two bools yields bool", () => {
    assert.deepEqual(
      unifyArith(PrimType("bool"), PrimType("bool"), "and"),
      PrimType("bool"),
    );
  });
  it("logical 'and' on non-bools yields null", () => {
    assert.equal(unifyArith(PrimType("int32"), PrimType("int32"), "and"), null);
  });
  it("error on either side yields ErrorType (suppress cascades)", () => {
    assert.deepEqual(
      unifyArith(ErrorType(), PrimType("int32"), "plus"),
      ErrorType(),
    );
  });
  it("null operand returns null", () => {
    assert.equal(unifyArith(null, PrimType("int32"), "plus"), null);
  });
});

describe("coerceLiteralToType", () => {
  function intLit(value) {
    return { kind: ASTNodeKind.INT_LITERAL, value };
  }
  function floatLit(value) {
    return { kind: ASTNodeKind.FLOAT_LITERAL, value };
  }

  it("pins an in-range int literal to the target type", () => {
    const errs = [];
    const node = intLit(42);
    coerceLiteralToType(node, PrimType("int32"), errs);
    assert.deepEqual(errs, []);
    assert.deepEqual(node.resolvedType, PrimType("int32"));
  });

  it("rejects an int literal exceeding uint8 max (255)", () => {
    const errs = [];
    coerceLiteralToType(intLit(256), PrimType("uint8"), errs);
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /out of range/);
  });

  it("rejects a negative int literal for an unsigned type", () => {
    const errs = [];
    coerceLiteralToType(intLit(-1), PrimType("uint16"), errs);
    assert.equal(errs.length, 1);
  });

  it("accepts int8 boundaries: -128 and 127", () => {
    const errs = [];
    coerceLiteralToType(intLit(-128), PrimType("int8"), errs);
    coerceLiteralToType(intLit(127), PrimType("int8"), errs);
    assert.deepEqual(errs, []);
  });

  it("rejects int8 boundary +1 (128)", () => {
    const errs = [];
    coerceLiteralToType(intLit(128), PrimType("int8"), errs);
    assert.equal(errs.length, 1);
  });

  it("rejects an int literal targeting a non-int prim", () => {
    const errs = [];
    coerceLiteralToType(intLit(42), PrimType("float32"), errs);
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /cannot coerce untyped int/);
  });

  it("pins an ordinary float literal to the target type", () => {
    const errs = [];
    const node = floatLit(3.14);
    coerceLiteralToType(node, PrimType("float64"), errs);
    assert.deepEqual(errs, []);
    assert.deepEqual(node.resolvedType, PrimType("float64"));
  });

  it("rejects a float literal targeting a non-float prim", () => {
    const errs = [];
    coerceLiteralToType(floatLit(3.14), PrimType("int32"), errs);
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /cannot coerce untyped float/);
  });

  it("rejects a non-finite float (NaN/Infinity)", () => {
    const errs = [];
    coerceLiteralToType(floatLit(NaN), PrimType("float32"), errs);
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /invalid float literal/);
  });

  it("rejects a non-literal node (e.g., binary expression)", () => {
    const errs = [];
    coerceLiteralToType(
      { kind: ASTNodeKind.BINARY_EXPRESSION },
      PrimType("int32"),
      errs,
    );
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /can only coerce untyped literals/);
  });
});
