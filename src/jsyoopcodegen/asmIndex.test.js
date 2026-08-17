import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAsmIndex } from "./asmIndex.js";
import { functionForSource, slice } from "./sourceIndex.js";

// Hand-written x86-64 assembly in the shape `clang -S -g` produces: a numbered
// `.file` table, stateful `.loc` directives, `# %bb.N: # %block` comments
// carrying the original LLVM block names, and `.Lfunc_endN` terminators.
// Written out rather than captured so the test asserts the mapping we want
// rather than whatever the local clang version happens to emit.
const ASM = [
  `\t.file\t"yooper_out.ll"`,
  `\t.text`,
  `\t.globl\tdemo__hotLoop`,
  `demo__hotLoop:                          # @demo__hotLoop`,
  `.Lfunc_begin0:`,
  `\t.file\t1 "/proj/src" "demo.yoop"`,
  `\t.loc\t1 4 0 is_stmt 1                 # demo.yoop:4:0`,
  `\t.cfi_startproc`,
  `# %bb.0:                                # %entry`,
  `\tmovl\t%edi, -4(%rsp)`,
  `\t.loc\t1 5 7 prologue_end              # demo.yoop:5:7`,
  `\tmovl\t$0, -8(%rsp)`,
  `.LBB0_1:                                # %for_cond_0`,
  `\tmovl\t-8(%rsp), %eax`,
  `\tcmpl\t-4(%rsp), %eax`,
  `\tjge\t.LBB0_4`,
  `# %bb.2:                                # %for_body_1`,
  `\t.loc\t1 7 5                           # demo.yoop:7:5`,
  `\tmovl\t-8(%rsp), %eax`,
  `\timull\t-8(%rsp), %eax`,
  `\taddl\t$1, %eax`,
  `\tmovl\t%eax, -8(%rsp)`,
  `.LBB0_4:                                # %done`,
  `\t.loc\t1 9 3                           # demo.yoop:9:3`,
  `\tmovl\t-8(%rsp), %eax`,
  `\tretq`,
  `.Lfunc_end0:`,
  `\t.globl\tdemo__other`,
  `demo__other:                            # @demo__other`,
  `.Lfunc_begin1:`,
  `\t.loc\t1 14 0 is_stmt 1                # demo.yoop:14:0`,
  `# %bb.0:                                # %entry`,
  `\txorl\t%eax, %eax`,
  `\tretq`,
  `.Lfunc_end1:`,
].join("\n");

const FILE = "/proj/src/demo.yoop";

function textOf(index, refs) {
  return refs.map((r) => index.lines[r.irLine].trim().replace(/\s+/g, " "));
}

describe("asmIndex: file table and function boundaries", () => {
  it("joins a numbered .file directive's directory and name", () => {
    const index = buildAsmIndex(ASM);
    assert.deepEqual([...index.bySource.keys()], [FILE]);
  });

  it("ignores the unnumbered .file naming the assembler input", () => {
    // `.file "yooper_out.ll"` is the .ll we handed clang, not a Yoop source.
    // If it entered the table it would shadow file number 1.
    const index = buildAsmIndex(ASM);
    assert.equal(index.bySource.has("yooper_out.ll"), false);
  });

  it("records one function per symbol label, ended by .Lfunc_end", () => {
    const index = buildAsmIndex(ASM);
    assert.deepEqual(
      index.functions.map((f) => f.symbol),
      ["demo__hotLoop", "demo__other"],
    );
  });

  it("takes each function's decl line from its first .loc", () => {
    const index = buildAsmIndex(ASM);
    const [hot, other] = index.functions;
    assert.equal(hot.declLine, 4);
    assert.equal(hot.file, FILE);
    assert.equal(other.declLine, 14);
  });
});

describe("asmIndex: source line to instruction mapping", () => {
  it("attributes a whole run of instructions to the .loc that opened it", () => {
    // A .loc is stateful - it covers every instruction until the next one.
    // Unlike IR there is no gap to infer: the arithmetic comes for free.
    const index = buildAsmIndex(ASM);
    assert.deepEqual(textOf(index, slice(index, FILE, 7)), [
      "movl -8(%rsp), %eax",
      "imull -8(%rsp), %eax",
      "addl $1, %eax",
      "movl %eax, -8(%rsp)",
    ]);
  });

  it("carries the open .loc across a basic block label", () => {
    // The loop condition in .LBB0_1 has no .loc of its own, so it belongs to
    // the line still in effect - the `for` header on line 5.
    const index = buildAsmIndex(ASM);
    assert.deepEqual(textOf(index, slice(index, FILE, 5)), [
      "movl $0, -8(%rsp)",
      "movl -8(%rsp), %eax",
      "cmpl -4(%rsp), %eax",
      "jge .LBB0_4",
    ]);
  });

  it("tags instructions with the LLVM block name from clang's comment", () => {
    const index = buildAsmIndex(ASM);
    assert.deepEqual(
      [...new Set(slice(index, FILE, 5).map((r) => r.block))],
      ["entry", "for_cond_0"],
    );
  });

  it("does not carry a .loc across a function boundary", () => {
    // demo__other's body must not inherit line 9 from the function above it.
    const index = buildAsmIndex(ASM);
    const refs = slice(index, FILE, 9);
    assert.equal(
      refs.every((r) => r.fn === "demo__hotLoop"),
      true,
    );
  });

  it("attributes each instruction to the function containing it", () => {
    const index = buildAsmIndex(ASM);
    assert.deepEqual(
      [...new Set(slice(index, FILE, 14).map((r) => r.fn))],
      ["demo__other"],
    );
  });

  it("skips directives, labels, and comments", () => {
    const index = buildAsmIndex(ASM);
    for (const [, refs] of index.bySource.get(FILE)) {
      for (const r of refs) {
        const t = index.lines[r.irLine].trim();
        assert.ok(!t.startsWith("."), `directive leaked in: ${t}`);
        assert.ok(!t.startsWith("#"), `comment leaked in: ${t}`);
        assert.ok(!/^[\w$.]+:/.test(t), `label leaked in: ${t}`);
      }
    }
  });

  it("returns an empty slice for a line with no instructions", () => {
    const index = buildAsmIndex(ASM);
    assert.deepEqual(slice(index, FILE, 6), []);
  });
});

describe("asmIndex: shares the query layer with irIndex", () => {
  it("resolves a source line to its enclosing function", () => {
    const index = buildAsmIndex(ASM);
    assert.equal(functionForSource(index, FILE, 7)?.symbol, "demo__hotLoop");
    assert.equal(functionForSource(index, FILE, 14)?.symbol, "demo__other");
  });
});
