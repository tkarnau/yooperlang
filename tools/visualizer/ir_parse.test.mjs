// Standalone: node --test tools/visualizer/ir_parse.test.mjs
// Not part of npm test; the visualizer is a toy and stays out of the suites.
// The IR here is hand-written and the expectations are derived by reading it,
// not by capturing parser output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIr, splitFunctions } from "./ir_parse.mjs";

const SAMPLE = `
; ModuleID = 'x'
declare i32 @printf(ptr, ...)

define i32 @main() !dbg !10 {
  %a = alloca i32, !dbg !20
  call void @llvm.dbg.declare(metadata ptr %a, metadata !30, metadata !DIExpression()), !dbg !20
  br i1 true, label %then, label %done, !dbg !21
then:
  store i32 1, ptr %a, !dbg !22
  br label %done
done:
  %v = load i32, ptr %a
  ret i32 %v, !dbg !23
}

define void @arena_vec_helper() {
entry:
  ret void
}

!20 = !DILocation(line: 5, column: 3, scope: !10)
!21 = !DILocation(line: 6, column: 1, scope: !10)
`;

test("functions, blocks, successors", () => {
  const fns = parseIr(SAMPLE);
  assert.equal(fns.length, 2);
  const main = fns[0];
  assert.equal(main.name, "main");
  assert.deepEqual(main.blocks.map((b) => b.label), ["entry", "then", "done"]);
  assert.deepEqual(main.blocks[0].succ, ["then", "done"]);
  assert.deepEqual(main.blocks[1].succ, ["done"]);
  assert.deepEqual(main.blocks[2].succ, []);
});

test("debug intrinsics are dropped, provenance is kept", () => {
  const main = parseIr(SAMPLE)[0];
  const entry = main.blocks[0];
  // alloca and br only: the llvm.dbg.declare between them is not an
  // instruction worth showing.
  assert.deepEqual(entry.instructions.map((i) => i.op), ["alloca", "br"]);
  assert.deepEqual(entry.instructions[0].src, { line: 5, col: 3 });
  assert.deepEqual(entry.instructions[1].src, { line: 6, col: 1 });
  // !22 has no !DILocation line in the sample, so the store carries none.
  assert.equal(main.blocks[1].instructions[0].src, undefined);
  // Display text carries no metadata tail.
  assert.ok(!entry.instructions[0].text.includes("!dbg"));
});

test("declared-only functions do not appear; split by stem", () => {
  const fns = parseIr(SAMPLE);
  assert.ok(!fns.some((f) => f.name === "printf"));
  const { user, std } = splitFunctions(fns, "arena_vec");
  assert.deepEqual(user.map((f) => f.name), ["main", "arena_vec_helper"]);
  assert.deepEqual(std, []);
});
