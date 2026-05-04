import { posToSourceLocation } from "./helpers.js";

function testPosToSourceLocation() {
  const src = "line1\nline2\nline3";
  const tests = [
    { pos: 0, expected: { line: 1, column: 1 } },
    { pos: 5, expected: { line: 1, column: 6 } },
    { pos: 6, expected: { line: 2, column: 1 } },
    { pos: 11, expected: { line: 2, column: 6 } },
    { pos: 12, expected: { line: 3, column: 1 } },
    { pos: 17, expected: { line: 3, column: 6 } },
  ];
  for (const { pos, expected } of tests) {
    const result = posToSourceLocation(src, pos);
    if (result.line !== expected.line || result.column !== expected.column) {
      console.error(
        `Test failed for pos ${pos}: expected ${JSON.stringify(
          expected,
        )}, got ${JSON.stringify(result)}`,
      );
    } else {
      console.log(`Test passed for pos ${pos}`);
    }
  }
}

testPosToSourceLocation();