import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { llvmType, printfSpec, alignOf, compileSource } from "./codegen.js";

describe("llvmType: yoop type name -> LLVM IR type", () => {
  const cases = [
    ["int32", "i32"],
    ["int8", "i8"],
    ["int64", "i64"],
    ["uint16", "i16"],
    ["float32", "float"],
    ["float64", "double"],
    ["bool", "i1"],
    ["void", "void"],
    ["string", "ptr"],
  ];
  for (const [yoopTy, llTy] of cases) {
    it(`${yoopTy} -> ${llTy}`, () => assert.equal(llvmType(yoopTy), llTy));
  }
  it("unknown name falls back to ptr", () => {
    assert.equal(llvmType("Point"), "ptr");
  });
});

describe("printfSpec: printf format specifier per yoop type", () => {
  it("string -> %s", () => assert.equal(printfSpec("string"), "%s"));
  it("int32 -> %d", () => assert.equal(printfSpec("int32"), "%d"));
  it("int64 -> %lld", () => assert.equal(printfSpec("int64"), "%lld"));
  it("usize -> %lld", () => assert.equal(printfSpec("usize"), "%lld"));
  it("float32 -> %f", () => assert.equal(printfSpec("float32"), "%f"));
  it("float64 -> %lf", () => assert.equal(printfSpec("float64"), "%lf"));
  it("bool -> %d", () => assert.equal(printfSpec("bool"), "%d"));
  it("unknown type throws", () => {
    assert.throws(() => printfSpec("Point"), /don't know how to format/);
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
