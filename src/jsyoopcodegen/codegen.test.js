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

  it("template literal STRING_PARTs hex-escape embedded raw double-quotes", () => {
    // Regression: a literal `"` in a template literal STRING_PART used to
    // be emitted unescaped into the LLVM c-string constant, which both
    // terminated the constant early and produced a [N x i8] header
    // whose length didn't match the rendered body. clang rejected the
    // IR with "constant expression type mismatch".
    //
    // We exercise two lowering paths:
    //  - printf(`...`)   - fuses all parts into one format-string global
    //  - return `...`    - calls string_concat_all over per-part globals
    // The compileSource harness is single-module and doesn't autoload
    // std/core/format.yoop, so we can't exercise the `return \`...\``
    // path here (it lowers to string_concat_all). The printf lowering
    // shares the same `encodeStringBytes` -> `emitRawStringGlobal`
    // path for STRING_PARTs, so this is a sufficient regression for
    // the underlying bug. End-to-end coverage of the return path
    // lives in the yoopstore playground program.
    const src = `
      extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }
      function main(): int32 {
        let name: string = "yoop";
        printf(\`fopen("\${name}", "wb") failed - check "\${name}.tmp"\\n\`);
        return 0;
      }
    `;
    const ir = compileSource(src);
    const stringGlobals = ir
      .split("\n")
      .filter((l) => /private unnamed_addr constant \[\d+ x i8\]/.test(l));
    const withQuote = stringGlobals.filter((l) => l.includes("\\22"));
    assert.ok(withQuote.length >= 1, `expected at least one string global with a hex-escaped quote (\\\\22), got:\n${stringGlobals.join("\n")}`);
    // Every emitted [N x i8] header must agree with its body's decoded
    // length. One `\xx` escape counts as one byte; a raw char counts as
    // one byte. This is the exact invariant the old bug violated.
    for (const line of stringGlobals) {
      const m = line.match(/\[(\d+) x i8\] c"((?:\\.|[^"\\])*)"/);
      assert.ok(m, `could not parse string global: ${line}`);
      const declared = Number(m[1]);
      const body = m[2];
      let actual = 0;
      for (let i = 0; i < body.length; i++) {
        if (body[i] === "\\") { actual++; i += 2; }
        else actual++;
      }
      assert.equal(actual, declared, `length mismatch in ${line}: declared ${declared}, body decodes to ${actual} bytes`);
    }
  });
});
