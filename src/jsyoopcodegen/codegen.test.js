import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { llvmType, printfSpec, alignOf, compileSource } from "./codegen.js";
import { PrimType, StructType, VoidType } from "../jsyooptypecheck/types.js";

describe("llvmType: yoop Type -> LLVM IR type", () => {
  const cases = [
    [PrimType("int32"), "i32"],
    [PrimType("int8"), "i8"],
    [PrimType("int64"), "i64"],
    [PrimType("uint16"), "i16"],
    [PrimType("float32"), "float"],
    [PrimType("float64"), "double"],
    [PrimType("bool"), "i1"],
    [VoidType(), "void"],
    [PrimType("string"), "ptr"],
  ];
  for (const [t, llTy] of cases) {
    it(`${t.kind === "void" ? "void" : t.name} -> ${llTy}`, () =>
      assert.equal(llvmType(t), llTy));
  }
  it("named struct type -> %struct.<name>", () => {
    assert.equal(llvmType(StructType("Point", [])), "%struct.Point");
  });
});

describe("printfSpec: printf format specifier per yoop Type", () => {
  it("string -> %s", () =>
    assert.equal(printfSpec(PrimType("string")), "%s"));
  it("int32 -> %d", () => assert.equal(printfSpec(PrimType("int32")), "%d"));
  it("int64 -> %lld", () =>
    assert.equal(printfSpec(PrimType("int64")), "%lld"));
  it("usize -> %lld", () =>
    assert.equal(printfSpec(PrimType("usize")), "%lld"));
  it("float32 -> %f", () =>
    assert.equal(printfSpec(PrimType("float32")), "%f"));
  it("float64 -> %lf", () =>
    assert.equal(printfSpec(PrimType("float64")), "%lf"));
  it("bool -> %d", () => assert.equal(printfSpec(PrimType("bool")), "%d"));
  it("struct type throws as a codegen bug", () => {
    assert.throws(
      () => printfSpec(StructType("Point", [])),
      /typechecker should have rejected/,
    );
  });
});

describe("alignOf: LLVM type alignment", () => {
  it("i64 and double align to 8", () => {
    assert.equal(alignOf("i64"), 8);
    assert.equal(alignOf("double"), 8);
  });
  it("i32 and float align to 4", () => {
    assert.equal(alignOf("i32"), 4);
    assert.equal(alignOf("float"), 4);
  });
  it("i16 aligns to 2", () => assert.equal(alignOf("i16"), 2));
  it("i8 and i1 align to 1", () => {
    assert.equal(alignOf("i8"), 1);
    assert.equal(alignOf("i1"), 1);
  });
  it("ptr (default) aligns to 8", () => assert.equal(alignOf("ptr"), 8));
});

describe("compileSource: smoke", () => {
  it("emits IR containing a main function for a minimal program", () => {
    const ir = compileSource("function main(): int32 { return 0; }");
    assert.match(ir, /define i32 @main/);
    assert.match(ir, /ret i32 0/);
  });

  it("throws if typecheck reports errors", () => {
    assert.throws(
      () => compileSource("function main(): int32 { return zzz; }"),
      /typecheck failed/,
    );
  });
});
