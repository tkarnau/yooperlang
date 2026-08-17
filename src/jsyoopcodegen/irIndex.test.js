import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildIrIndex } from "./irIndex.js";
import { functionForSource, slice } from "./sourceIndex.js";

// Hand-written IR in exactly the shape debugInfo.js emits: a `define` whose
// !dbg sits before the opening brace and points at a !DISubprogram, plus
// per-instruction !dbg at end of line pointing at !DILocations. Written out
// rather than captured from a compile so the test asserts what the mapping
// SHOULD be, not what the compiler currently happens to produce.
const IR = [
  `define i32 @demo__hotLoop(i32 %n.arg) !dbg !10 {`,
  `entry:`,
  `  %acc = alloca i32, align 4`,
  `  store i32 0, ptr %acc, !dbg !12`,
  `  br label %for_cond_0, !dbg !13`,
  `for_cond_0:`,
  `  %t0 = load i32, ptr %acc, !dbg !13`,
  `  %t1 = icmp slt i32 %t0, %n.arg`,
  `  br i1 %t1, label %for_body_1, label %done, !dbg !13`,
  `for_body_1:`,
  `  %t2 = load i32, ptr %acc, !dbg !14`,
  `  %t3 = mul i32 %t2, %t2`,
  `  %t4 = add i32 %t3, 1`,
  `  store i32 %t4, ptr %acc, !dbg !14`,
  `done:`,
  `  %t5 = load i32, ptr %acc, !dbg !15`,
  `  ret i32 %t5, !dbg !15`,
  `}`,
  ``,
  `define void @yoop_coro_resume(ptr %h) {`,
  `entry:`,
  `  ret void`,
  `}`,
  ``,
  `!0 = !DIFile(filename: "demo.yoop", directory: "/proj/src")`,
  `!1 = distinct !DICompileUnit(language: DW_LANG_C99, file: !0, producer: "yoopiler")`,
  `!10 = distinct !DISubprogram(name: "hotLoop", linkageName: "demo__hotLoop", scope: !0, file: !0, line: 4, type: !11, scopeLine: 4, spFlags: DISPFlagDefinition, unit: !1)`,
  `!12 = !DILocation(line: 5, column: 7, scope: !10)`,
  `!13 = !DILocation(line: 6, column: 3, scope: !10)`,
  `!14 = !DILocation(line: 7, column: 5, scope: !10)`,
  `!15 = !DILocation(line: 9, column: 3, scope: !10)`,
].join("\n");

const FILE = "/proj/src/demo.yoop";

// Render a slice as "opcode-ish" text so assertions read as the instructions a
// user would see rather than as line numbers.
function textOf(index, refs) {
  return refs.map((r) => index.lines[r.irLine].trim());
}

describe("irIndex: metadata parsing", () => {
  it("resolves each define to its subprogram name, file, and decl line", () => {
    const index = buildIrIndex(IR);
    const fn = index.functions.find((f) => f.symbol === "demo__hotLoop");
    assert.ok(fn, "expected the hotLoop define to be indexed");
    assert.equal(fn.name, "hotLoop");
    assert.equal(fn.file, FILE);
    assert.equal(fn.declLine, 4);
  });

  it("joins DIFile directory and filename into an absolute path", () => {
    const index = buildIrIndex(IR);
    assert.deepEqual([...index.bySource.keys()], [FILE]);
  });

  it("indexes a define with no !dbg but attributes no source to it", () => {
    // The hand-written coroutine trampolines are real IR with no source
    // behind them. They must still appear as functions (so an IR view can
    // show them) without inventing a file or a line.
    const index = buildIrIndex(IR);
    const coro = index.functions.find((f) => f.symbol === "yoop_coro_resume");
    assert.ok(coro, "expected the trampoline define to be indexed");
    assert.equal(coro.file, null);
    assert.equal(coro.declLine, null);
  });

  it("spans a define from its `define` line through the closing brace", () => {
    const index = buildIrIndex(IR);
    const fn = index.functions.find((f) => f.symbol === "demo__hotLoop");
    assert.match(index.lines[fn.startLine], /^define i32 @demo__hotLoop/);
    assert.equal(index.lines[fn.endLine], "}");
  });
});

describe("irIndex: source line to instruction mapping", () => {
  it("maps a source line to the instructions carrying its !dbg", () => {
    const index = buildIrIndex(IR);
    assert.deepEqual(textOf(index, slice(index, FILE, 5)), [
      "%acc = alloca i32, align 4",
      "store i32 0, ptr %acc, !dbg !12",
    ]);
  });

  it("returns instructions in IR emission order across basic blocks", () => {
    const index = buildIrIndex(IR);
    const refs = slice(index, FILE, 6);
    assert.deepEqual(
      refs.map((r) => r.irLine),
      [...refs.map((r) => r.irLine)].sort((a, b) => a - b),
    );
    // The `for` header genuinely produces code in two blocks; the mapping
    // must show both rather than only the one the header line sits in.
    assert.deepEqual([...new Set(refs.map((r) => r.block))], [
      "entry",
      "for_cond_0",
    ]);
  });

  it("returns an empty slice for a line that produced no code", () => {
    const index = buildIrIndex(IR);
    assert.deepEqual(slice(index, FILE, 99), []);
  });

  it("returns an empty slice for a file that is not in the IR", () => {
    const index = buildIrIndex(IR);
    assert.deepEqual(slice(index, "/proj/src/other.yoop", 5), []);
  });

  it("unions the lines of a range, tagging each with its source line", () => {
    const index = buildIrIndex(IR);
    const refs = slice(index, FILE, 5, 6);
    assert.deepEqual([...new Set(refs.map((r) => r.srcLine))], [5, 6]);
  });
});

describe("irIndex: gap filling", () => {
  // debugInfo.js does not stamp !dbg on pure arithmetic (DBG_TARGET_RE skips
  // mul/add/icmp/GEP/cast/phi). Those are the instructions a reader most wants
  // to see, so the index infers them from their neighbours. If this ever
  // regresses, `acc = acc + i * i` renders as a lone `store`.
  it("attributes a bare arithmetic instruction to the next marked one", () => {
    const index = buildIrIndex(IR);
    const text = textOf(index, slice(index, FILE, 7));
    assert.deepEqual(text, [
      "%t2 = load i32, ptr %acc, !dbg !14",
      "%t3 = mul i32 %t2, %t2",
      "%t4 = add i32 %t3, 1",
      "store i32 %t4, ptr %acc, !dbg !14",
    ]);
  });

  it("flags inferred attributions so they are distinguishable", () => {
    const index = buildIrIndex(IR);
    const refs = slice(index, FILE, 7);
    const inferred = refs.filter((r) => r.inferred).map((r) => index.lines[r.irLine].trim());
    assert.deepEqual(inferred, ["%t3 = mul i32 %t2, %t2", "%t4 = add i32 %t3, 1"]);
  });

  it("falls back to the previous marked instruction when nothing follows", () => {
    // `%acc = alloca` opens the entry block with nothing marked before it, so
    // it must attach forward to the `store` on line 5 rather than drop out.
    const index = buildIrIndex(IR);
    const refs = slice(index, FILE, 5);
    const alloca = refs.find((r) => index.lines[r.irLine].includes("alloca"));
    assert.ok(alloca, "expected the alloca to be attributed");
    assert.equal(alloca.inferred, true);
  });

  it("does not attribute a bare instruction across a basic block boundary", () => {
    // %t1 = icmp sits in for_cond_0. The nearest marked instruction after it
    // is in the same block; if the block guard were dropped, a bare trailing
    // instruction could silently borrow a line from the NEXT block.
    const index = buildIrIndex(IR);
    for (const [, refs] of index.bySource.get(FILE)) {
      for (const r of refs) {
        const line = index.lines[r.irLine];
        if (line.includes("icmp")) assert.equal(r.block, "for_cond_0");
      }
    }
  });
});

describe("irIndex: functionForSource", () => {
  it("finds the function a body line belongs to", () => {
    const index = buildIrIndex(IR);
    assert.equal(functionForSource(index, FILE, 7)?.symbol, "demo__hotLoop");
  });

  it("finds the function from its own declaration line", () => {
    const index = buildIrIndex(IR);
    assert.equal(functionForSource(index, FILE, 4)?.symbol, "demo__hotLoop");
  });

  it("returns null above the first function", () => {
    const index = buildIrIndex(IR);
    assert.equal(functionForSource(index, FILE, 1), null);
  });

  it("returns null below the last instruction of the last function", () => {
    // Line 9 is the final `return`; anything past it is outside the body and
    // must not be claimed by the function that happens to precede it.
    const index = buildIrIndex(IR);
    assert.equal(functionForSource(index, FILE, 40), null);
  });
});
