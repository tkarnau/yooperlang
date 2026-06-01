import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pushError, formatType } from "./errors.js";
import {
  PrimType,
  StructType,
  RefType,
  ArrayType,
  FuncType,
  VoidType,
  UntypedIntType,
  UntypedFloatType,
  ErrorType,
} from "./types.js";

describe("pushError", () => {
  it("appends a message + sourceLoc to the array", () => {
    const errs = [];
    pushError(errs, { sourceLoc: { pos: 5, line: 1, column: 6 } }, "boom");
    assert.equal(errs.length, 1);
    assert.equal(errs[0].message, "boom");
    assert.deepEqual(errs[0].sourceLoc, { pos: 5, line: 1, column: 6 });
  });

  it("a missing node yields undefined sourceLoc (no crash)", () => {
    const errs = [];
    pushError(errs, null, "no-node-error");
    assert.equal(errs.length, 1);
    assert.equal(errs[0].sourceLoc, undefined);
  });
});

describe("formatType", () => {
  it("prim -> name", () => assert.equal(formatType(PrimType("int32")), "int32"));
  it("struct -> 'struct Name'", () => {
    assert.equal(formatType(StructType("Point", [])), "struct Point");
  });
  it("ref -> 'ref <inner>'", () => {
    assert.equal(formatType(RefType(PrimType("int32"))), "ref int32");
  });
  it("array -> '<elem>[]'", () => {
    assert.equal(formatType(ArrayType(PrimType("uint8"))), "uint8[]");
  });
  it("func -> '(params) -> return'", () => {
    const ft = FuncType(
      [
        { name: "a", type: PrimType("int32"), isRef: false },
        { name: "b", type: PrimType("int32"), isRef: false },
      ],
      PrimType("int32"),
    );
    assert.equal(formatType(ft), "(int32, int32) -> int32");
  });
  it("void -> 'void'", () => assert.equal(formatType(VoidType()), "void"));
  it("untyped int -> 'untyped int'", () => {
    assert.equal(formatType(UntypedIntType()), "untyped int");
  });
  it("untyped float -> 'untyped float'", () => {
    assert.equal(formatType(UntypedFloatType()), "untyped float");
  });
  it("error -> 'error'", () => assert.equal(formatType(ErrorType()), "error"));
  it("null -> 'null'", () => assert.equal(formatType(null), "null"));
});
