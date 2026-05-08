import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { posToSourceLocation } from "./helpers.js";

describe("posToSourceLocation", () => {
  const src = "line1\nline2\nline3";
  const cases = [
    { pos: 0, line: 1, column: 1 },
    { pos: 5, line: 1, column: 6 },
    { pos: 6, line: 2, column: 1 },
    { pos: 11, line: 2, column: 6 },
    { pos: 12, line: 3, column: 1 },
    { pos: 17, line: 3, column: 6 },
  ];

  for (const { pos, line, column } of cases) {
    it(`pos ${pos} -> line ${line}, column ${column}`, () => {
      const result = posToSourceLocation(src, pos);
      assert.equal(result.line, line);
      assert.equal(result.column, column);
    });
  }
});
