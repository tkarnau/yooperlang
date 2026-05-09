// End-to-end tests: compile a .yoop fixture all the way to a binary, run it,
// compare stdout/exit code. Each fixture has its own it() with the
// expectation written inline — no comment parsing, no sidecar files.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { parse } from "./jsyooparser/parser.js";
import { typecheckSource } from "./jsyooptypecheck/typecheck.js";
import { compileSource } from "./jsyoopcodegen/codegen.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

function runFixture(relPath) {
  const src = fs.readFileSync(path.join(repoRoot, relPath), "utf8");
  const ir = compileSource(src);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_e2e_"));
  const llPath = path.join(tmpDir, "out.ll");
  const binPath = path.join(tmpDir, "out");
  fs.writeFileSync(llPath, ir);
  execFileSync("clang", [llPath, "-o", binPath], { stdio: "pipe" });
  const result = spawnSync(binPath, [], { encoding: "utf8" });
  return { stdout: result.stdout, exitCode: result.status };
}

describe("e2e: pass fixtures compile, run, and produce expected output", () => {
  it("hello.yoop prints greeting + arithmetic + pow result", () => {
    const { stdout, exitCode } = runFixture("examples/pass/hello.yoop");
    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      "Hello, World!\nx is 9\nsum: 10, doubled: 18\npow: 3 to the 5th is 243\n",
    );
  });

  it("int_literal.yoop prints decoded hex/bin/dec/negative literals", () => {
    const { stdout, exitCode } = runFixture("examples/pass/int_literal.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "a=255 b=10 c=1000000 d=-7\n");
  });

  it("float_literal.yoop prints decimal/negative/scientific floats", () => {
    const { stdout, exitCode } = runFixture("examples/pass/float_literal.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "x=3.140000 y=-0.500000 z=100.000000\n");
  });

  it("range_check.yoop sums two int8 values that fit in range", () => {
    const { stdout, exitCode } = runFixture("examples/pass/range_check.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "a=100, b=27, c=127\n");
  });

  it("struct_basic.yoop creates a Point struct and prints the distance square", () => {
    const { stdout, exitCode } = runFixture("examples/pass/struct_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "distance_sq = 25\n");
  });

  it("struct_field_write.yoop mutates a struct field through a chain of assignments", () => {
    const { stdout, exitCode } = runFixture(
      "examples/pass/struct_field_write.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "c.value = 20\n");
  });

  it("struct_return.yoop returns a struct from a function and reads its fields", () => {
    const { stdout, exitCode } = runFixture(
      "examples/pass/struct_return.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "a=7 b=11\n");
  });

  it("struct_nested.yoop initializes nested struct literals and chains field access", () => {
    const { stdout, exitCode } = runFixture(
      "examples/pass/struct_nested.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "a.inner.v = 42\n");
  });

  it("errors_basic.yoop reads a fallible struct and observes err via field access", () => {
    const { stdout, exitCode } = runFixture("examples/pass/errors_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "len = 42\n");
  });

  it("errors_propagate.yoop uses '?' to bail on err and yield the success value", () => {
    const { stdout, exitCode } = runFixture(
      "examples/pass/errors_propagate.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "total = 84\n");
  });

  it("errors_propagate_failure.yoop traces an err through '?' and a destructure", () => {
    const { stdout, exitCode } = runFixture(
      "examples/pass/errors_propagate_failure.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "err: empty path\n");
  });

  it("errors_discard.yoop satisfies observation via '_ = ...'", () => {
    const { stdout, exitCode } = runFixture(
      "examples/pass/errors_discard.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "done\n");
  });

  it("errors_destructure_no_qmark.yoop destructures a fallible struct including err", () => {
    const { stdout, exitCode } = runFixture(
      "examples/pass/errors_destructure_no_qmark.yoop",
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout, "len = 7\n");
  });
});

function typecheckFixture(relPath) {
  const src = fs.readFileSync(path.join(repoRoot, relPath), "utf8");
  return typecheckSource(src);
}

describe("e2e: fail fixtures fail at the right stage with the right message", () => {
  it("parse_bad_suffix.yoop throws a parse-time error about a missing semicolon", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/parse_bad_suffix.yoop"),
      "utf8",
    );
    assert.throws(() => parse(src), /expected token .* semicolon/);
  });

  it("err_dropped.yoop rejects a bare fallible call statement", () => {
    const { errors } = typecheckFixture("examples/fail/err_dropped.yoop");
    assert.ok(
      errors.some((e) => /fallible result.*dropped/.test(e.message)),
      `expected dropped-fallible error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("err_unobserved.yoop rejects a fallible binding whose err is never read", () => {
    const { errors } = typecheckFixture("examples/fail/err_unobserved.yoop");
    assert.ok(
      errors.some((e) =>
        /fallible binding "r".*must observe its 'err'/.test(e.message),
      ),
      `expected unobserved-err error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("err_destructure_missing_err.yoop rejects a destructure that omits err", () => {
    const { errors } = typecheckFixture(
      "examples/fail/err_destructure_missing_err.yoop",
    );
    assert.ok(
      errors.some((e) => /destructuring a fallible type.*include "err"/.test(e.message)),
      `expected missing-err error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("err_qmark_in_nonfallible.yoop rejects '?' inside a non-fallible function", () => {
    const { errors } = typecheckFixture(
      "examples/fail/err_qmark_in_nonfallible.yoop",
    );
    assert.ok(
      errors.some((e) =>
        /'\?' is only legal inside a function that returns a fallible type/.test(
          e.message,
        ),
      ),
      `expected ?-in-nonfallible error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("err_qmark_on_nonfallible.yoop rejects '?' on a non-fallible operand", () => {
    const { errors } = typecheckFixture(
      "examples/fail/err_qmark_on_nonfallible.yoop",
    );
    assert.ok(
      errors.some((e) => /'\?' applied to non-fallible type/.test(e.message)),
      `expected ?-on-nonfallible error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("err_destructure_unknown_field.yoop rejects an unknown destructured name", () => {
    const { errors } = typecheckFixture(
      "examples/fail/err_destructure_unknown_field.yoop",
    );
    assert.ok(
      errors.some((e) => /no field "nope"/.test(e.message)),
      `expected unknown-field error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("err_multi_strip_no_destructure.yoop rejects multi-field '?' outside a destructure", () => {
    const { errors } = typecheckFixture(
      "examples/fail/err_multi_strip_no_destructure.yoop",
    );
    assert.ok(
      errors.some((e) => /multi-field.*must be destructured/.test(e.message)),
      `expected multi-strip error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });
});
