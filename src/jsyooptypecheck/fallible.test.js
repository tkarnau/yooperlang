import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PrimType,
  StructType,
  RefType,
  VoidType,
  ErrorType,
  typeKinds,
} from "./types.js";
import { isFallible, strippedTypeOf } from "./fallible.js";

const errString = { name: "err", type: PrimType("string") };

describe("isFallible", () => {
  it("returns true for a struct whose last field is err: string", () => {
    const t = StructType("Bytes", [
      { name: "len", type: PrimType("int32") },
      errString,
    ]);
    assert.equal(isFallible(t), true);
  });

  it("returns true for an err-only struct (single field err: string)", () => {
    const t = StructType("Failable", [errString]);
    assert.equal(isFallible(t), true);
  });

  it("returns true for a multi-field struct ending in err: string", () => {
    const t = StructType("Result", [
      { name: "a", type: PrimType("int32") },
      { name: "b", type: PrimType("int32") },
      { name: "c", type: PrimType("int32") },
      errString,
    ]);
    assert.equal(isFallible(t), true);
  });

  it("returns false when err is not the last field", () => {
    const t = StructType("Misordered", [
      errString,
      { name: "len", type: PrimType("int32") },
    ]);
    assert.equal(isFallible(t), false);
  });

  it("returns false for a struct without an err field", () => {
    const t = StructType("Point", [
      { name: "x", type: PrimType("int32") },
      { name: "y", type: PrimType("int32") },
    ]);
    assert.equal(isFallible(t), false);
  });

  it("returns false when the trailing 'err' field is not typed string", () => {
    const t = StructType("WrongErrType", [
      { name: "len", type: PrimType("int32") },
      { name: "err", type: PrimType("int32") },
    ]);
    assert.equal(isFallible(t), false);
  });

  it("returns false when the trailing field is named 'err' but is a non-prim type", () => {
    const t = StructType("RefErr", [
      { name: "len", type: PrimType("int32") },
      { name: "err", type: RefType(PrimType("string")) },
    ]);
    assert.equal(isFallible(t), false);
  });

  it("returns false for a struct whose last field is named differently", () => {
    const t = StructType("HasErrorField", [
      { name: "len", type: PrimType("int32") },
      { name: "error", type: PrimType("string") },
    ]);
    assert.equal(isFallible(t), false);
  });

  it("returns false for a struct with no fields", () => {
    const t = StructType("Empty", []);
    assert.equal(isFallible(t), false);
  });

  it("returns false for a struct whose fields property is missing entirely", () => {
    // forward-declared struct shape — fields is undefined, not []
    const t = StructType("Forward", undefined);
    assert.equal(isFallible(t), false);
  });

  it("returns false for non-struct types", () => {
    assert.equal(isFallible(PrimType("int32")), false);
    assert.equal(isFallible(PrimType("string")), false);
    assert.equal(isFallible(VoidType()), false);
    assert.equal(isFallible(ErrorType()), false);
    assert.equal(
      isFallible(RefType(StructType("Bytes", [errString]))),
      false,
    );
  });

  it("returns false for null / undefined", () => {
    assert.equal(isFallible(null), false);
    assert.equal(isFallible(undefined), false);
  });
});

describe("strippedTypeOf", () => {
  it("single non-err field returns that field's type", () => {
    const t = StructType("Box", [
      { name: "value", type: PrimType("int32") },
      errString,
    ]);
    assert.deepEqual(strippedTypeOf(t), PrimType("int32"));
  });

  it("err-only struct returns void", () => {
    const t = StructType("Failable", [errString]);
    assert.equal(strippedTypeOf(t).kind, typeKinds.void);
  });

  it("multi-field struct returns the strippedMulti sentinel", () => {
    const t = StructType("Result", [
      { name: "data", type: PrimType("int32") },
      { name: "meta", type: PrimType("int32") },
      errString,
    ]);
    const stripped = strippedTypeOf(t);
    assert.equal(stripped.kind, "strippedMulti");
    assert.equal(stripped.sourceName, "Result");
    assert.equal(stripped.fields.length, 2);
    assert.equal(stripped.fields[0].name, "data");
    assert.equal(stripped.fields[1].name, "meta");
  });

  it("non-fallible types return null", () => {
    assert.equal(strippedTypeOf(PrimType("int32")), null);
    assert.equal(
      strippedTypeOf(StructType("Point", [{ name: "x", type: PrimType("int32") }])),
      null,
    );
    assert.equal(strippedTypeOf(null), null);
  });
});
