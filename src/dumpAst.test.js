import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { dumpAstJson } from "./dumpAst.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dumpast-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function dumpSource(src) {
  const inFile = path.join(tmp, "in.yoop");
  const outFile = path.join(tmp, "out.ast.json");
  fs.writeFileSync(inFile, src, "utf8");
  dumpAstJson(inFile, outFile);
  return JSON.parse(fs.readFileSync(outFile, "utf8"));
}

describe("dumpAstJson", () => {
  it("writes a {filename, source, ast} payload with a PROGRAM root", () => {
    const src = "function f(): int32 { return 0; }\n";
    const data = dumpSource(src);
    assert.deepEqual(Object.keys(data).sort(), ["ast", "filename", "source"]);
    assert.equal(data.source, src);
    assert.equal(data.ast.kind, "PROGRAM");
  });

  it("serializes a function body with the documented field/child/group shape", () => {
    const data = dumpSource(
      "function sumTo(n: int32): int32 {\n" +
        "  let total: int32 = 0;\n" +
        "  for (total = 0; total < n; total = total + 1) {}\n" +
        "  return total;\n" +
        "}\n",
    );
    // PROGRAM wraps its decls in a GROUP labeled "body".
    const progBody = data.ast.children.find((c) => c.kind === "GROUP" && c.label === "body");
    assert.ok(progBody, "PROGRAM should have a body GROUP");
    const fn = progBody.children.find((c) => c.kind === "FUNCTION_DECL");
    assert.ok(fn, "should find the FUNCTION_DECL");
    assert.equal(fn.fields.name, "sumTo");
    // params are a GROUP; body is a labeled BLOCK child.
    assert.ok(fn.children.some((c) => c.kind === "GROUP" && c.label === "params"));
    assert.ok(fn.children.some((c) => c.kind === "BLOCK" && c.label === "body"));
    // FOR_LOOP carries initIdent/stepIdent as scalar fields.
    const block = fn.children.find((c) => c.kind === "BLOCK");
    const stmts = block.children.find((c) => c.kind === "GROUP" && c.label === "body").children;
    const forLoop = stmts.find((c) => c.kind === "FOR_LOOP");
    assert.equal(forLoop.fields.initIdent, "total");
    assert.equal(forLoop.fields.stepIdent, "total");
  });
});
