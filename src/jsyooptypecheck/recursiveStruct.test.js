import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectRecursiveField } from "./recursiveStruct.js";
import { PrimType, StructType } from "./types.js";

describe("detectRecursiveField", () => {
  it("non-struct field is never recursive", () => {
    assert.equal(detectRecursiveField("Foo", PrimType("int32")), false);
  });

  it("struct that does not mention itself is not recursive", () => {
    const inner = StructType("Inner", [
      { name: "x", type: PrimType("int32") },
    ]);
    assert.equal(detectRecursiveField("Outer", inner), false);
  });

  // detectRecursiveField is invoked per-field by the typechecker:
  //   detectRecursiveField(structName, oneField.type)
  // these tests follow that calling convention.

  it("direct self-reference is recursive", () => {
    const self = StructType("Node", [{ name: "next", type: null }]);
    self.fields[0].type = self;
    assert.equal(detectRecursiveField("Node", self.fields[0].type), true);
  });

  it("mutual recursion (A → B → A) is detected", () => {
    const a = StructType("A", [{ name: "b", type: null }]);
    const b = StructType("B", [{ name: "a", type: null }]);
    a.fields[0].type = b;
    b.fields[0].type = a;
    assert.equal(detectRecursiveField("A", a.fields[0].type), true);
    assert.equal(detectRecursiveField("B", b.fields[0].type), true);
  });

  it("non-cyclic chain (A → B with primitive leaves) is not recursive", () => {
    const b = StructType("B", [{ name: "x", type: PrimType("int32") }]);
    const a = StructType("A", [{ name: "b", type: b }]);
    assert.equal(detectRecursiveField("A", a.fields[0].type), false);
  });
});
