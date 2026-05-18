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
import { typecheckSource, typecheckProgram } from "./jsyooptypecheck/typecheck.js";
import { compileSource, compileEntry } from "./jsyoopcodegen/codegen.js";
import { loadModuleGraph } from "./jsyoopdriver/moduleGraph.js";

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

  it("refs_basic.yoop passes a ref param and writes through it", () => {
    const { stdout, exitCode } = runFixture("examples/pass/refs_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "x = 42\n");
  });

  it("refs_swap.yoop swaps two values through ref params", () => {
    const { stdout, exitCode } = runFixture("examples/pass/refs_swap.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "x=10 y=5\n");
  });

  it("arrays_basic.yoop creates an int32[] literal, reads len and elements, writes an element", () => {
    const { stdout, exitCode } = runFixture("examples/pass/arrays_basic.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "len=3 first=10 last=30\nxs[1]=99\n");
  });

  it("arrays_loop.yoop iterates an array with a for-loop and sums elements", () => {
    const { stdout, exitCode } = runFixture("examples/pass/arrays_loop.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "sum = 15\n");
  });

  it("for_break_continue.yoop: break exits loop early, continue skips even values", () => {
    const { stdout, exitCode } = runFixture("examples/pass/for_break_continue.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "sum = 10\nodd = 25\n");
  });

  it("casts.yoop: widening int cast, int-to-float, float-to-float casts", () => {
    const { stdout, exitCode } = runFixture("examples/pass/casts.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "b=100 d=100\nc=100.000000\ne=100.000000\n");
  });

});

// Multi-file fixture: compile entry path through full module graph pipeline.
function runFixtureEntry(relPath) {
  const entryAbs = path.join(repoRoot, relPath);
  const { ir, linkFlags } = compileEntry(entryAbs);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop_e2e_"));
  const llPath = path.join(tmpDir, "out.ll");
  const binPath = path.join(tmpDir, "out");
  fs.writeFileSync(llPath, ir);
  const clangArgs = [llPath, "-o", binPath, ...linkFlags.map((f) => `-l${f}`)];
  execFileSync("clang", clangArgs, { stdio: "pipe" });
  const result = spawnSync(binPath, [], { encoding: "utf8" });
  return { stdout: result.stdout, exitCode: result.status };
}

// Typecheck a multi-file fixture (entry + imports) and return errors.
function typecheckFixtureEntry(relPath) {
  const entryAbs = path.join(repoRoot, relPath);
  const { modules } = loadModuleGraph(entryAbs);
  return typecheckProgram(modules);
}

function typecheckFixture(relPath) {
  const src = fs.readFileSync(path.join(repoRoot, relPath), "utf8");
  return typecheckSource(src);
}

function parseFixture(relPath) {
  const src = fs.readFileSync(path.join(repoRoot, relPath), "utf8");
  return parse(src);
}

describe("e2e: multi-file pass fixtures compile and produce expected output", () => {
  it("imports_basic: named import + call", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/imports_basic/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "9 = 9\n");
  });

  it("imports_namespace: import * as + dotted call", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/imports_namespace/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "5 = 5\n");
  });

  it("imports_renamed: import { x as y }", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/imports_renamed/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "16 = 16\n");
  });

  it("imports_struct: exported struct + cross-module fallible flow", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/imports_struct/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "len = 43\n");
  });

  it("extern_printf: explicit printf via extern block", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/extern_printf/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "hello\n");
  });

  it("extern_library: -lm link flag + cos(0) = 1", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/extern_library/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "cos(0) = 1.000000\n");
  });

  it("imports_diamond: diamond dep loads each module exactly once", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/imports_diamond/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "a=42 b=42\n");
  });

  it("side_effect_import: side-effect-only import succeeds", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/side_effect_import/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "init loaded\n");
  });

  it("export_c: export \"C\" function emits unmangled symbol", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/export_c/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "add_one(5) = 6\n");
  });

  it("traits_disposable: impl of a Disposable trait with a dispose method", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/traits_disposable/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposing fd=7\n");
  });

  it("traits_multi_impl: one type implementing two traits", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/traits_multi_impl/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "closing fd=7\ndisposing fd=7\nrc=7 is_open=0\n");
  });

  it("traits_two_types_one_trait: two distinct types implementing the same trait", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/traits_two_types_one_trait/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "file fd=1\nsocket sock=99\n");
  });

  it("traits_self_field: method body reads multiple fields and returns a value", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/traits_self_field/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "encoded=304\n");
  });

  it("traits_self_call_other_method: method body invokes another method on the same type", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/traits_self_call_other_method/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "closing fd=42\ndisposed via close (rc=42)\n");
  });

  it("traits_cross_module: trait declared in one module, implemented in another, called in main", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/traits_cross_module/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposing fd=13\n");
  });

  it("traits_recursive_method: trait method calls itself recursively", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/traits_recursive_method/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "n=3\nn=2\nn=1\n");
  });

  it("disposable_basic: two implicit-block bindings fire cleanup in LIFO order at function return", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/disposable_basic/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "working\ndisposing fd=2\ndisposing fd=1\n");
  });

  it("disposable_explicit_block: trailing-block binding fires cleanup at its `}`", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/disposable_explicit_block/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "inside block\ndisposing fd=7\nafter block\n");
  });

  it("disposable_return: cleanup fires on every explicit return path", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/disposable_return/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposing fd=9\ndisposing fd=9\nr1=1 r2=0\n");
  });

  it("disposable_qmark: cleanup fires before `?`-induced early return on the failure path", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/disposable_qmark/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposing fd=5\nok r1=5 err=''\ndisposing fd=5\nfail r2=0 err='boom'\n");
  });

  it("disposable_lifo_three: three implicit-block bindings dispose in reverse declaration order", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/disposable_lifo_three/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposing fd=3\ndisposing fd=2\ndisposing fd=1\n");
  });

  it("disposable_nested_block: implicit and explicit blocks interleave with correct LIFO scoping", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/disposable_nested_block/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "inside\ndisposing fd=3\ndisposing fd=2\noutside\ndisposing fd=1\n");
  });

  it("disposable_let_explicit: `let disposable` allows mutation and still fires cleanup", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/disposable_let_explicit/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposing fd=99\n");
  });

  it("disposable_multi_requires: kind with two requires resolves a mustCall method from one of them", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/disposable_multi_requires/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposing fd=11\n");
  });

  // phase 6.2: scoped kind and escape analysis
  it("scoped_basic: scoped kind with mustNotEscape, kind-prefixed param, dispose fires at scope end", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/scoped_basic/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "fd=1\ndisposing fd=1\n");
  });

  it("scoped_param_only: plain let binding may be passed ref to a scoped parameter", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/scoped_param_only/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "fd=7\n");
  });

  it("scoped_lifo_with_disposable: scoped and disposable interleaved dispose in LIFO order", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/scoped_lifo_with_disposable/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "disposing fd=2\ndisposing fd=1\n");
  });

  it("scoped_field_access_ok: returning a primitive field of a scoped binding is not an escape", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/scoped_field_access_ok/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "fd=9\ndisposing fd=9\n");
  });

  it("scoped_nested_block: trailing-block form of scoped kind fires dispose at inner block end", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/scoped_nested_block/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "inside\ndisposing fd=5\nafter\n");
  });

  it("kind_pooled_parse: mustNotShare acrossScopes parses and does not break mustCall pipeline", () => {
    const { stdout, exitCode } = runFixtureEntry("examples/pass/kind_pooled_parse/main.yoop");
    assert.equal(exitCode, 0);
    assert.equal(stdout, "drop 1\n");
  });

  it("kind_forbids_parse: forbids io globalState parses and stores categories without enforcement", () => {
    const { errors } = typecheckFixtureEntry("examples/pass/kind_forbids_parse/main.yoop");
    assert.equal(errors.length, 0, `expected no errors, got: ${errors.map((e) => e.message).join(" | ")}`);
  });
});

describe("e2e: multi-file fail fixtures produce the right errors", () => {
  it("import_no_yoop_ext.yoop: import path must end in .yoop", () => {
    const entryAbs = path.join(repoRoot, "examples/fail/import_no_yoop_ext.yoop");
    assert.throws(
      () => loadModuleGraph(entryAbs),
      /must end in \.yoop/,
    );
  });

  it("extern_unsupported_abi.yoop: extern \"Rust\" is rejected at parse time", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/extern_unsupported_abi.yoop"),
      "utf8",
    );
    assert.throws(() => parse(src), /unsupported extern ABI "Rust"/);
  });

  it("import_after_decl.yoop: import after non-import decl is a parse error", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/import_after_decl.yoop"),
      "utf8",
    );
    assert.throws(() => parse(src), /imports must come before other declarations/);
  });

  it("import_unknown_export: importing a non-exported name is a typecheck error", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/import_unknown_export/main.yoop");
    assert.ok(
      errors.some((e) => /has no export "nope"/.test(e.message)),
      `expected no-export error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("import_collision: re-importing the same local name is a typecheck error", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/import_collision/main.yoop");
    assert.ok(
      errors.some((e) => /collides with an existing declaration/.test(e.message)),
      `expected collision error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("import_cycle: cyclic imports are detected at graph-load time", () => {
    const entryAbs = path.join(repoRoot, "examples/fail/import_cycle/a.yoop");
    assert.throws(
      () => loadModuleGraph(entryAbs),
      /import cycle detected/,
    );
  });

  it("namespace_private: accessing a private export via namespace is a typecheck error", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/namespace_private/main.yoop");
    assert.ok(
      errors.some((e) => /has no export "private_fn"/.test(e.message)),
      `expected namespace-private error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });
});

describe("e2e: fail fixtures fail at the right stage with the right message", () => {
  it("parse_bad_suffix.yoop throws a parse-time error about a missing semicolon", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/parse_bad_suffix.yoop"),
      "utf8",
    );
    assert.throws(() => parse(src), /expected semicolon/);
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

  it("ref_return.yoop rejects a function whose return type is ref T", () => {
    const { errors } = typecheckFixture("examples/fail/ref_return.yoop");
    assert.ok(
      errors.some((e) => /may not return 'ref T'/.test(e.message)),
      `expected ref-return error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("break_outside_loop.yoop rejects break used outside any loop", () => {
    const { errors } = typecheckFixture("examples/fail/break_outside_loop.yoop");
    assert.ok(
      errors.some((e) => /'break' is not inside a loop/.test(e.message)),
      `expected break-outside-loop error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("continue_outside_loop.yoop rejects continue used outside any loop", () => {
    const { errors } = typecheckFixture("examples/fail/continue_outside_loop.yoop");
    assert.ok(
      errors.some((e) => /'continue' is not inside a loop/.test(e.message)),
      `expected continue-outside-loop error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("array_elem_type_mismatch.yoop rejects array literal with wrong element type", () => {
    const { errors } = typecheckFixture("examples/fail/array_elem_type_mismatch.yoop");
    assert.ok(
      errors.some((e) => /element 2 has type/.test(e.message)),
      `expected element-type-mismatch error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("ref_nonlvalue.yoop rejects taking a ref of a non-lvalue expression", () => {
    const { errors } = typecheckFixture("examples/fail/ref_nonlvalue.yoop");
    assert.ok(
      errors.some((e) => /non-lvalue/.test(e.message)),
      `expected non-lvalue error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("cast_nonnumeric.yoop rejects casting a non-numeric type", () => {
    const { errors } = typecheckFixture("examples/fail/cast_nonnumeric.yoop");
    assert.ok(
      errors.some((e) => /cannot cast/.test(e.message)),
      `expected cannot-cast error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_missing_method.yoop rejects impl that omits a required trait method", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_missing_method.yoop");
    assert.ok(
      errors.some((e) => /missing method "dispose"/.test(e.message)),
      `expected missing-method error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_wrong_signature_return.yoop rejects impl method with wrong return type", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_wrong_signature_return.yoop");
    assert.ok(
      errors.some((e) => /method "dispose" on type "T" has signature/.test(e.message)),
      `expected signature-mismatch error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_wrong_signature_param.yoop rejects impl method with extra parameter", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_wrong_signature_param.yoop");
    assert.ok(
      errors.some((e) => /method "dispose" on type "T" has signature/.test(e.message)),
      `expected signature-mismatch error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_collision_two_traits.yoop rejects type implementing two traits with the same method name", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_collision_two_traits.yoop");
    assert.ok(
      errors.some((e) => /cannot implement both "A" and "B"/.test(e.message)),
      `expected trait-collision error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_collision_with_function.yoop rejects impl method colliding with a free function", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_collision_with_function.yoop");
    assert.ok(
      errors.some((e) => /collides with module-level function "dispose"/.test(e.message)),
      `expected function-collision error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_self_outside.yoop rejects 'self' used outside a method body", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_self_outside.yoop");
    assert.ok(
      errors.some((e) => /'self' can only be used inside a trait method body/.test(e.message)),
      `expected self-outside-method error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_extra_method.yoop rejects impl method not required by any trait", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_extra_method.yoop");
    assert.ok(
      errors.some((e) => /declares method "extra", but no implemented trait requires it/.test(e.message)),
      `expected extra-method error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_ref_self_by_value.yoop rejects trait method signature missing 'ref'", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/traits_ref_self_by_value.yoop"),
      "utf8",
    );
    assert.throws(
      () => parse(src),
      /trait method "dispose" must take 'ref self' as its first parameter/,
    );
  });

  it("traits_method_no_implements.yoop rejects methods on a type without implements", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/traits_method_no_implements.yoop"),
      "utf8",
    );
    assert.throws(() => parse(src), /methods are only allowed inside an 'implements' block/);
  });

  it("traits_unknown_trait.yoop rejects implementing an undefined trait", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_unknown_trait.yoop");
    assert.ok(
      errors.some((e) => /implements unknown trait "Foo"/.test(e.message)),
      `expected unknown-trait error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_default_body_in_trait.yoop rejects a method body inside a trait declaration", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/traits_default_body_in_trait.yoop"),
      "utf8",
    );
    assert.throws(() => parse(src), /expected semicolon, got lcurly/);
  });

  it("traits_extends_rejected.yoop rejects trait extends clause", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/traits_extends_rejected.yoop"),
      "utf8",
    );
    assert.throws(() => parse(src), /extends not yet supported/);
  });

  it("traits_generic_rejected.yoop rejects generic trait declaration", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "examples/fail/traits_generic_rejected.yoop"),
      "utf8",
    );
    assert.throws(() => parse(src), /trait generics are not supported/);
  });

  it("traits_method_call_sugar.yoop rejects method-call syntax on a trait method", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_method_call_sugar.yoop");
    assert.ok(
      errors.some((e) => /method-call form.*is not supported/.test(e.message)),
      `expected method-call-sugar error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_redeclared_method.yoop rejects duplicate method in impl block", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_redeclared_method.yoop");
    assert.ok(
      errors.some((e) => /duplicate method "dispose" in type "T"/.test(e.message)),
      `expected duplicate-method error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("traits_self_assignment_wrong_type.yoop rejects wrong-type assignment to a self field", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/traits_self_assignment_wrong_type.yoop");
    assert.ok(
      errors.some((e) => /cannot assign/.test(e.message)),
      `expected type-mismatch error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("kind_unknown_trait.yoop rejects a kind requires clause referencing an undeclared trait", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/kind_unknown_trait.yoop");
    assert.ok(
      errors.some((e) => /unknown trait 'NotATrait'/.test(e.message)),
      `expected unknown-trait error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("kind_mustcall_no_requires.yoop rejects a mustCall clause with no `requires`", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/kind_mustcall_no_requires.yoop");
    assert.ok(
      errors.some((e) => /mustCall requires at least one 'requires' clause/.test(e.message)),
      `expected mustCall-no-requires error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("kind_mustcall_method_not_in_trait.yoop rejects a mustCall method missing from required traits", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/kind_mustcall_method_not_in_trait.yoop");
    assert.ok(
      errors.some((e) => /no required trait declares this method/.test(e.message)),
      `expected method-not-in-trait error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("binding_unknown_kind.yoop rejects a binding prefixed by an undeclared kind", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/binding_unknown_kind.yoop");
    assert.ok(
      errors.some((e) => /unknown kind "notAKind"/.test(e.message)),
      `expected unknown-kind error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("binding_missing_trait.yoop rejects a kind-prefixed binding whose type lacks a required trait", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/binding_missing_trait.yoop");
    assert.ok(
      errors.some((e) => /does not implement "Disposable"/.test(e.message)),
      `expected missing-trait error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("binding_non_struct.yoop rejects a kind-prefixed binding with a non-struct type", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/binding_non_struct.yoop");
    assert.ok(
      errors.some((e) => /can only apply to struct values/.test(e.message)),
      `expected non-struct-kind error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("binding_trailing_block_no_ownsblock.yoop rejects a trailing-block binding under a kind without ownsBlock", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/binding_trailing_block_no_ownsblock.yoop");
    assert.ok(
      errors.some((e) => /does not declare ownsBlock/.test(e.message)),
      `expected no-ownsBlock error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  // phase 6.2 parser rejections
  it("kind_appliesto_function.yoop rejects appliesTo function (phase 6.5)", () => {
    assert.throws(
      () => parseFixture("examples/fail/kind_appliesto_function.yoop"),
      /appliesTo function not yet supported/,
    );
  });

  it("kind_appliesto_duplicate.yoop rejects duplicate appliesTo site", () => {
    assert.throws(
      () => parseFixture("examples/fail/kind_appliesto_duplicate.yoop"),
      /duplicate appliesTo site 'binding'/,
    );
  });

  it("kind_appliesto_empty.yoop rejects empty appliesTo list", () => {
    assert.throws(
      () => parseFixture("examples/fail/kind_appliesto_empty.yoop"),
      /appliesTo requires at least one site/,
    );
  });

  it("kind_mustnotescape_function.yoop rejects mustNotEscape function", () => {
    assert.throws(
      () => parseFixture("examples/fail/kind_mustnotescape_function.yoop"),
      /mustNotEscape function not yet supported/,
    );
  });

  it("kind_mustnotshare_acrossthreads.yoop rejects mustNotShare acrossThreads", () => {
    assert.throws(
      () => parseFixture("examples/fail/kind_mustnotshare_acrossthreads.yoop"),
      /acrossThreads not yet supported/,
    );
  });

  it("kind_forbids_unknown.yoop rejects unrecognized forbids category", () => {
    assert.throws(
      () => parseFixture("examples/fail/kind_forbids_unknown.yoop"),
      /unrecognized forbids category 'memory'/,
    );
  });

  it("kind_forbids_empty.yoop rejects empty forbids list", () => {
    assert.throws(
      () => parseFixture("examples/fail/kind_forbids_empty.yoop"),
      /forbids requires at least one category/,
    );
  });

  it("kind_duplicate_mustnotescape.yoop rejects duplicate mustNotEscape clause", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/kind_duplicate_mustnotescape.yoop");
    assert.ok(
      errors.some((e) => /duplicate mustNotEscape clause/.test(e.message)),
      `expected duplicate-mustNotEscape error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("param_two_kinds.yoop rejects a parameter with two kind prefixes", () => {
    assert.throws(
      () => parseFixture("examples/fail/param_two_kinds.yoop"),
      /a parameter may carry at most one kind prefix/,
    );
  });

  it("param_kind_not_applies.yoop rejects a kind on a parameter when appliesTo excludes parameter", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/param_kind_not_applies.yoop");
    assert.ok(
      errors.some((e) => /does not apply to parameters/.test(e.message)),
      `expected param-applicability error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("binding_kind_not_applies.yoop rejects a kind on a binding when appliesTo excludes binding", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/binding_kind_not_applies.yoop");
    assert.ok(
      errors.some((e) => /does not apply to bindings/.test(e.message)),
      `expected binding-applicability error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("field_with_kind.yoop rejects a kind-prefixed struct field", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/field_with_kind.yoop");
    assert.ok(
      errors.some((e) => /kind-bearing struct fields require propagates/.test(e.message)),
      `expected field-kind error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("scoped_escape_return.yoop rejects returning a scoped binding", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/scoped_escape_return.yoop");
    assert.ok(
      errors.some((e) => /forbids escape via return/.test(e.message)),
      `expected escape-return error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("scoped_escape_pass_unscoped.yoop rejects passing a scoped ref to a non-scoped parameter", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/scoped_escape_pass_unscoped.yoop");
    assert.ok(
      errors.some((e) => /does not declare 'scoped' or 'mustNotEscape scope' kind/.test(e.message)),
      `expected escape-pass-unscoped error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });

  it("scoped_alias.yoop rejects aliasing a scoped binding under a plain name", () => {
    const { errors } = typecheckFixtureEntry("examples/fail/scoped_alias.yoop");
    assert.ok(
      errors.some((e) => /cannot alias a scoped binding/.test(e.message)),
      `expected scoped-alias error, got: ${errors.map((e) => e.message).join(" | ")}`,
    );
  });
});
