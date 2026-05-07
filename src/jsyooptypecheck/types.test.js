import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PrimType,
  StructType,
  RefType,
  VoidType,
  UntypedIntType,
  UntypedFloatType,
  ErrorType,
  typesEqual,
  primTypeFromName,
  resolveTypeName,
  canonicalize,
  isIntPrim,
  isUnsignedIntPrim,
  isSignedIntPrim,
  isFloatPrim,
  getBitWidthOfIntPrim,
} from "./types.js";

describe("canonicalize", () => {
  it("'int' → 'int32'", () => assert.equal(canonicalize("int"), "int32"));
  it("'float' → 'float32'", () => assert.equal(canonicalize("float"), "float32"));
  it("named primitives are unchanged", () => {
    assert.equal(canonicalize("int64"), "int64");
    assert.equal(canonicalize("uint8"), "uint8");
  });
});

describe("primTypeFromName", () => {
  it("returns a PrimType for known primitives", () => {
    assert.deepEqual(primTypeFromName("int32"), PrimType("int32"));
  });
  it("returns null for unknown names", () => {
    assert.equal(primTypeFromName("Point"), null);
  });
  it("canonicalizes aliases", () => {
    assert.deepEqual(primTypeFromName("int"), PrimType("int32"));
  });
});

describe("resolveTypeName", () => {
  it("resolves primitives without consulting the struct table", () => {
    assert.deepEqual(resolveTypeName("int32", new Map()), PrimType("int32"));
  });
  it("resolves struct names from the struct table", () => {
    const point = StructType("Point", [{ name: "x", type: PrimType("int32") }]);
    const table = new Map([["Point", point]]);
    assert.equal(resolveTypeName("Point", table), point);
  });
  it("returns null for unknown names", () => {
    assert.equal(resolveTypeName("Nope", new Map()), null);
  });
});

describe("typesEqual", () => {
  it("two PrimTypes with the same name are equal", () => {
    assert.ok(typesEqual(PrimType("int32"), PrimType("int32")));
  });
  it("PrimTypes with different names are not equal", () => {
    assert.ok(!typesEqual(PrimType("int32"), PrimType("int64")));
  });
  it("VoidType equals VoidType", () => {
    assert.ok(typesEqual(VoidType(), VoidType()));
  });
  it("UntypedIntType equals UntypedIntType", () => {
    assert.ok(typesEqual(UntypedIntType(), UntypedIntType()));
  });
  it("RefType compares inner type", () => {
    assert.ok(
      typesEqual(RefType(PrimType("int32")), RefType(PrimType("int32"))),
    );
    assert.ok(
      !typesEqual(RefType(PrimType("int32")), RefType(PrimType("int64"))),
    );
  });
  it("ErrorType equals ErrorType", () => {
    assert.ok(typesEqual(ErrorType(), ErrorType()));
  });
});

describe("int prim classifications", () => {
  it("isIntPrim covers signed + unsigned + size-named", () => {
    for (const n of ["int8", "uint16", "int64", "usize", "isize"]) {
      assert.ok(isIntPrim(n), n);
    }
    assert.ok(!isIntPrim("float32"));
  });

  it("isUnsignedIntPrim only flags unsigned", () => {
    assert.ok(isUnsignedIntPrim("uint32"));
    assert.ok(!isUnsignedIntPrim("int32"));
  });

  it("isSignedIntPrim only flags signed", () => {
    assert.ok(isSignedIntPrim("int32"));
    assert.ok(!isSignedIntPrim("uint32"));
  });

  it("isFloatPrim covers float32/float64", () => {
    assert.ok(isFloatPrim("float32") && isFloatPrim("float64"));
    assert.ok(!isFloatPrim("int32"));
  });

  it("getBitWidthOfIntPrim returns expected sizes", () => {
    assert.equal(getBitWidthOfIntPrim("int8"), 8);
    assert.equal(getBitWidthOfIntPrim("uint16"), 16);
    assert.equal(getBitWidthOfIntPrim("int32"), 32);
    assert.equal(getBitWidthOfIntPrim("int64"), 64);
    assert.equal(getBitWidthOfIntPrim("usize"), 64);
  });
});
