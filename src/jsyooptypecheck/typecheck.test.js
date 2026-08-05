// Integration tests for the typechecker: feed in source, parse + typecheck,
// assert on errors. Pure-helper unit tests (isAssignable, unifyArith,
// coerceLiteralToType) live in coerce.test.js.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { typecheckSource, typecheckProgram } from "./typecheck.js";
import { parse } from "../jsyooparser/parser.js";
import { typeKinds } from "./types.js";
import fs from "node:fs";
import path from "node:path";

function singleModule(src, id = "test") {
  return [{ id, ast: parse(src) }];
}

// The concurrency kinds (`task`, `async`, `joined`, `pooled`) live in
// std/core/kinds.yoop now rather than being reserved words, so anything
// exercising them needs that module in the graph. The driver autoloads it;
// a hand-built module list has to include it explicitly.
const CORE_KINDS_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "std",
  "core",
  "kinds.yoop",
);
function withCoreKinds(src, id = "test") {
  return [
    {
      id: "std_core_kinds",
      absPath: CORE_KINDS_PATH,
      ast: parse(fs.readFileSync(CORE_KINDS_PATH, "utf8")),
    },
    { id, ast: parse(src) },
  ];
}

describe("typecheckSource: well-typed programs produce zero errors", () => {
  it("function with int literal return", () => {
    const { errors } = typecheckSource(
      "function main(): int32 { return 0; }",
    );
    assert.deepEqual(errors, []);
  });

  it("let binding with matching int literal", () => {
    const { errors } = typecheckSource(
      "function main(): int32 { let x: int32 = 42; return x; }",
    );
    assert.deepEqual(errors, []);
  });

  it("binary op between two int literals", () => {
    const { errors } = typecheckSource(
      "function main(): int32 { return 1 + 2; }",
    );
    assert.deepEqual(errors, []);
  });

  it("function call with matching arg type", () => {
    const { errors } = typecheckSource(
      "function add(a: int32, b: int32): int32 { return a + b; }\n" +
        "function main(): int32 { return add(1, 2); }",
    );
    assert.deepEqual(errors, []);
  });

  it("binding with no annotation infers its type from the initializer", () => {
    const { errors } = typecheckSource(
      "function main(): int32 { const s = 7; let t = s + 1; return t; }",
    );
    assert.deepEqual(errors, []);
  });

  it("inferred int binding defaults to int32 (usable where int32 is wanted)", () => {
    const { errors } = typecheckSource(
      "function takes_i32(n: int32): int32 { return n; }\n" +
        "function main(): int32 { const x = 5; return takes_i32(x); }",
    );
    assert.deepEqual(errors, []);
  });
});

describe("typecheckSource: ill-typed programs report positioned errors", () => {
  it("string assigned to int32 produces an assignment error", () => {
    const { errors } = typecheckSource(
      'function main(): int32 { let x: int32 = "oops"; return x; }',
    );
    assert.ok(errors.length >= 1);
    assert.match(errors[0].message, /string.*int32|int32.*string/);
  });

  it("undeclared variable produces an undefined error", () => {
    const { errors } = typecheckSource(
      "function main(): int32 { return zzz; }",
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /undefined.*zzz/);
  });

  it("wrong arg count is flagged", () => {
    const { errors } = typecheckSource(
      "function add(a: int32, b: int32): int32 { return a + b; }\n" +
        "function main(): int32 { return add(1); }",
    );
    assert.ok(errors.some((e) => /arg count|wrong arg/.test(e.message)));
  });

  it("redeclaration of a function is flagged", () => {
    const { errors } = typecheckSource(
      "function f(): int32 { return 0; }\n" +
        "function f(): int32 { return 1; }\n" +
        "function main(): int32 { return 0; }",
    );
    assert.ok(errors.some((e) => /redeclaration.*f/.test(e.message)));
  });

  it("int literal out of range for int8", () => {
    const { errors } = typecheckSource(
      "function main(): int32 { let x: int8 = 200; return 0; }",
    );
    assert.ok(errors.some((e) => /out of range|range/i.test(e.message)));
  });

  it("binding with neither annotation nor initializer cannot infer", () => {
    const { errors } = typecheckSource(
      "function main(): int32 { let x; return 0; }",
    );
    assert.ok(errors.some((e) => /type annotation or an initializer/.test(e.message)));
  });

  it("inferring from an orphan struct literal is rejected with a hint", () => {
    const { errors } = typecheckSource(
      "type Point { x: int32, y: int32 }\n" +
        "function main(): int32 { const p = { x: 1, y: 2 }; return p.x; }",
    );
    assert.ok(errors.some((e) => /cannot infer a type/.test(e.message)));
  });
});

describe("typecheckProgram: trait shells - pass A", () => {
  it("registers a trait in traitTable after pass A", () => {
    const { moduleEnv, errors } = typecheckProgram(
      singleModule("trait Disposable { function dispose(ref self): void; }"),
    );
    assert.deepEqual(errors, []);
    const env = moduleEnv.get("test");
    assert.ok(env.traitTable.has("Disposable"));
    const trait = env.traitTable.get("Disposable");
    assert.equal(trait.kind, typeKinds.trait);
    assert.equal(trait.name, "Disposable");
  });

  it("rejects a trait that redeclares a struct name", () => {
    const { errors } = typecheckProgram(
      singleModule(
        "type Disposable { n: int32, }\ntrait Disposable { function dispose(ref self): void; }",
      ),
    );
    assert.ok(errors.some((e) => /redeclaration.*Disposable/.test(e.message)));
  });
});

describe("typecheckProgram: trait method sigs - pass C.1", () => {
  it("populates trait.methods with the resolved FuncType for each method sig", () => {
    const { moduleEnv, errors } = typecheckProgram(
      singleModule(
        "trait Closable { function close(ref self): int32; function name(ref self): int32; }",
      ),
    );
    assert.deepEqual(errors, []);
    const env = moduleEnv.get("test");
    const trait = env.traitTable.get("Closable");
    assert.ok(trait.methods.has("close"));
    assert.ok(trait.methods.has("name"));
    const closeSig = trait.methods.get("close");
    assert.equal(closeSig.kind, typeKinds.func);
    assert.equal(closeSig.params.length, 1);
    assert.equal(closeSig.params[0].name, "self");
    assert.equal(closeSig.params[0].isRef, true);
    assert.equal(closeSig.returnType.name, "int32");
  });

  it("rejects duplicate method names within a single trait", () => {
    const { errors } = typecheckProgram(
      singleModule(
        "trait Dup { function go(ref self): void; function go(ref self): void; }",
      ),
    );
    assert.ok(errors.some((e) => /duplicate method.*go.*Dup/.test(e.message)));
  });
});

describe("typecheckProgram: generic trait dispatch through a bounded type param", () => {
  // Regression: a generic function's `implements` bound on a GENERIC trait used
  // to instantiate that trait before pass C.1 had populated its method sigs, so
  // the cached instance was permanently method-less and `Trait.method(ref x)`
  // through the type param failed with "trait has no method". Generic-trait
  // method population is now hoisted to a pre-pass.
  it("resolves Comparable.compare(ref x, ...) for <T implements Comparable<T>>", () => {
    const { errors } = typecheckProgram(
      singleModule(
        "trait Comparable<T> { function compare(ref self, b: T): int8; }\n" +
          "function cmp<T implements Comparable<T>>(a: T, b: T): int8 {\n" +
          "  return Comparable.compare(ref a, b);\n" +
          "}\n",
      ),
    );
    assert.deepEqual(errors, []);
  });

  // Regression: bound satisfaction compared TraitTypes by identity, so a struct
  // implementing `Comparable<Num>` was rejected against an open `Comparable<T>`
  // bound. Matching is now nominal (name + moduleId).
  it("accepts a concrete struct implementing the generic trait as a type arg", () => {
    const { errors } = typecheckProgram(
      singleModule(
        "trait Comparable<T> { function compare(ref self, b: T): int8; }\n" +
          "type Num implements Comparable<Num> {\n" +
          "  v: int32,\n" +
          "  function compare(ref self, b: Num): int8 { return 0; }\n" +
          "}\n" +
          "function cmp<T implements Comparable<T>>(a: T, b: T): int8 {\n" +
          "  return Comparable.compare(ref a, b);\n" +
          "}\n" +
          "function main(): int32 {\n" +
          "  let x: Num = { v: 1 };\n" +
          "  let y: Num = { v: 2 };\n" +
          "  return int32(cmp(x, y));\n" +
          "}\n",
      ),
    );
    assert.deepEqual(errors, []);
  });
});

describe("typecheckProgram: binary operator on mismatched types", () => {
  // Regression: unifyArith returns null for mismatched operands (e.g. a signed
  // int compared against usize); resolveBinary used to propagate that null,
  // which crashed the for-loop checker (null.kind). It now reports a clean
  // diagnostic and returns an error type.
  it("reports a clean error (no crash) for int32 < usize", () => {
    const { errors } = typecheckSource(
      "function main(): int32 {\n" +
        "  let xs: int32[] = [1, 2, 3];\n" +
        "  let i: int32 = 0;\n" +
        "  for (i = 0; i < xs.len; i = i + 1) {}\n" +
        "  return 0;\n" +
        "}\n",
    );
    assert.ok(
      errors.some((e) => /operator "<" cannot be applied to int32 and usize/.test(e.message)),
      `expected operator-mismatch error, got: ${JSON.stringify(errors.map((e) => e.message))}`,
    );
  });
});

describe("typecheckProgram: for-loop with a let-declared counter", () => {
  // The counterpart to the mismatch test above: the SAME comparison is fine
  // when the loop declares the counter, because an unannotated counter takes
  // its type from the condition instead of defaulting to int32.
  it("an unannotated counter is typed by the condition, not defaulted", () => {
    const { errors } = typecheckSource(
      "function main(): int32 {\n" +
        "  let xs: int32[] = [1, 2, 3];\n" +
        "  for (let i = 0; i < xs.len; i += 1) {}\n" +
        "  return 0;\n" +
        "}\n",
    );
    assert.deepEqual(errors, []);
  });

  it("honors an explicit annotation on the counter", () => {
    const { errors } = typecheckSource(
      "function main(): int32 {\n" +
        "  for (let i: usize = 0; i < 3; i += 1) {}\n" +
        "  return 0;\n" +
        "}\n",
    );
    assert.deepEqual(errors, []);
  });

  it("rejects an initializer that does not fit the annotation", () => {
    const { errors } = typecheckSource(
      "function main(): int32 {\n" +
        '  for (let i: usize = "nope"; i < 3; i += 1) {}\n' +
        "  return 0;\n" +
        "}\n",
    );
    assert.ok(
      errors.some((e) => /initializer of for-loop counter "i"/.test(e.message)),
      `expected counter-initializer error, got: ${JSON.stringify(errors.map((e) => e.message))}`,
    );
  });

  it("scopes the counter to the loop", () => {
    const { errors } = typecheckSource(
      "function main(): int32 {\n" +
        "  for (let i = 0; i < 3; i += 1) {}\n" +
        "  return int32(i);\n" +
        "}\n",
    );
    assert.ok(
      errors.some((e) => /undefined variable "i"/.test(e.message)),
      `expected the counter to be out of scope after the loop, got: ${JSON.stringify(errors.map((e) => e.message))}`,
    );
  });

  it("a loop counter may shadow an outer binding of another type", () => {
    const { errors } = typecheckSource(
      "function main(): int32 {\n" +
        "  let xs: int32[] = [1, 2];\n" +
        "  let i: int32 = 99;\n" +
        "  for (let i = 0; i < xs.len; i += 1) {}\n" +
        "  return i;\n" +
        "}\n",
    );
    assert.deepEqual(errors, []);
  });

  it("with nothing to pin from, an unannotated counter defaults to int32", () => {
    const { errors } = typecheckSource(
      "function main(): int32 {\n" +
        "  let total: int32 = 0;\n" +
        "  for (let i = 0; true; i += 1) { total = total + i; break; }\n" +
        "  return total;\n" +
        "}\n",
    );
    assert.deepEqual(errors, []);
  });
});

describe("typecheckProgram: impl block validation - pass C.3", () => {
  it("well-formed impl produces no errors", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        trait Disposable { function dispose(ref self): void; }
        type FileHandle implements Disposable { fd: int32, function dispose(ref self): void { } }
      `),
    );
    assert.deepEqual(errors, []);
  });

  it("missing method in impl is flagged", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        trait Disposable { function dispose(ref self): void; }
        type FileHandle implements Disposable { fd: int32, }
      `),
    );
    assert.ok(
      errors.some(
        (e) => /implements.*Disposable.*missing.*dispose|missing.*dispose.*Disposable/.test(e.message),
      ),
    );
  });

  it("extra method in impl (no trait requires it) is flagged", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        trait Disposable { function dispose(ref self): void; }
        type FileHandle implements Disposable {
          fd: int32,
          function dispose(ref self): void { }
          function extra(ref self): void { }
        }
      `),
    );
    assert.ok(
      errors.some((e) => /declares method.*extra.*no implemented trait/.test(e.message)),
    );
  });

  it("wrong return type in impl method is flagged", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        trait Disposable { function dispose(ref self): void; }
        type FileHandle implements Disposable {
          fd: int32,
          function dispose(ref self): int32 { return 0; }
        }
      `),
    );
    assert.ok(
      errors.some((e) => /signature.*dispose|dispose.*signature/.test(e.message)),
    );
  });

  // Phase 7.4: cross-trait same-name methods are now allowed when signatures
  // agree, because every call site qualifies through the trait.
  it("two traits requiring the same method name with matching signatures is allowed", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        trait TraitA { function go(ref self): void; }
        trait TraitB { function go(ref self): void; }
        type T implements (TraitA, TraitB) {
          n: int32,
          function go(ref self): void { }
        }
      `),
    );
    assert.deepEqual(errors, []);
  });

  it("two traits requiring the same method name with incompatible signatures is rejected", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        trait TraitA { function go(ref self): void; }
        trait TraitB { function go(ref self): int32; }
        type T implements (TraitA, TraitB) {
          n: int32,
          function go(ref self): void { }
        }
      `),
    );
    assert.ok(
      errors.some((e) => /incompatible signatures/.test(e.message)),
    );
  });

  // Phase 7.4: a trait method name may now coincide with a module-level
  // free function name - the trait-qualified call site disambiguates.
  it("trait method name coinciding with a module-level free function is allowed", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        function dispose(x: int32): void { }
        trait Disposable { function dispose(ref self): void; }
        type FileHandle implements Disposable {
          fd: int32,
          function dispose(ref self): void { }
        }
      `),
    );
    assert.deepEqual(errors, []);
  });

  it("implementing an unknown trait is flagged", () => {
    const { errors } = typecheckProgram(
      singleModule(
        "type FileHandle implements UnknownTrait { fd: int32, }",
      ),
    );
    assert.ok(
      errors.some((e) => /unknown trait.*UnknownTrait|UnknownTrait.*unknown/.test(e.message)),
    );
  });
});

describe("typecheckProgram: self in method body scope", () => {
  it("self is in scope inside a method body and resolves to the implementing type", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        trait Counter { function increment(ref self): void; }
        type C implements Counter {
          count: int32,
          function increment(ref self): void {
            self.count = self.count + 1;
          }
        }
      `),
    );
    assert.deepEqual(errors, []);
  });
});

describe("Phase 7.5: variant declarations and case constructors", () => {
  it("declares a simple variant and constructs each case", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        variant Shape {
          Circle { radius: int32 },
          Empty,
        }
        function main(): int32 {
          let a: Shape = Shape.Circle { radius: 1 };
          let b: Shape = Shape.Empty;
          return 0;
        }
      `),
    );
    assert.deepEqual(errors, []);
  });

  it("rejects unknown case", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        variant E { A, B }
        function main(): int32 {
          let x: E = E.NotThere;
          return 0;
        }
      `),
    );
    assert.equal(errors.length >= 1, true);
    assert.match(errors[0].message, /has no case/);
  });

  it("rejects payload case without braces", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        variant E { A { x: int32 } }
        function main(): int32 {
          let x: E = E.A;
          return 0;
        }
      `),
    );
    assert.equal(errors.length >= 1, true);
    assert.match(errors[0].message, /requires fields/);
  });

  it("rejects payload braces on no-payload case", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        variant E { A }
        function main(): int32 {
          let x: E = E.A { foo: 1 };
          return 0;
        }
      `),
    );
    assert.equal(errors.length >= 1, true);
    assert.match(errors[0].message, /has no payload/);
  });

  it("rejects extra fields in case constructor", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        variant E { A { x: int32 } }
        function main(): int32 {
          let v: E = E.A { x: 1, y: 2 };
          return 0;
        }
      `),
    );
    assert.equal(errors.length >= 1, true);
    assert.match(errors[0].message, /has no field/);
  });
});

describe("Phase 7.5: union declarations and literals", () => {
  it("declares a union and accepts a single-field literal", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        type Channels { r: uint8, g: uint8, b: uint8, a: uint8 }
        union Color { rgba: uint32, channels: Channels }
        function main(): int32 {
          let c: Color = { rgba: 4278190335 };
          let r: uint8 = c.channels.r;
          return 0;
        }
      `),
    );
    assert.deepEqual(errors, []);
  });

  it("rejects multi-field union literal", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        union U { a: int32, b: uint32 }
        function main(): int32 {
          let u: U = { a: 1, b: 2 };
          return 0;
        }
      `),
    );
    assert.equal(errors.length >= 1, true);
    assert.match(errors[0].message, /exactly one field/);
  });
});

describe("Phase 7.5: switch statement", () => {
  it("typechecks an exhaustive variant switch with no default", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        variant E { A { x: int32 }, B }
        function pick(e: E): int32 {
          switch (e) {
            case E.A { x }: { return x; }
            case E.B: { return 0; }
          }
          return -1;
        }
        function main(): int32 { return pick(E.B); }
      `),
    );
    assert.deepEqual(errors, []);
  });

  it("rejects non-exhaustive variant switch without default", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        variant E { A, B, C }
        function pick(e: E): int32 {
          switch (e) {
            case E.A: { return 1; }
            case E.B: { return 2; }
          }
          return 0;
        }
      `),
    );
    assert.equal(errors.length >= 1, true);
    assert.match(errors[0].message, /not exhaustive.*missing variants: C/);
  });

  it("rejects switch over a struct scrutinee", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        type S { x: int32 }
        function f(): int32 {
          let s: S = { x: 1 };
          switch (s) {
            default: { return 0; }
          }
          return 0;
        }
      `),
    );
    assert.equal(errors.length >= 1, true);
    assert.match(errors[0].message, /scrutinee must be int.*variant/);
  });

  it("typechecks an int switch with default", () => {
    const { errors } = typecheckProgram(
      singleModule(`
        function classify(n: int32): int32 {
          switch (n) {
            case 1: { return 10; }
            case 2, 3: { return 23; }
            default: { return 0; }
          }
          return 0;
        }
        function main(): int32 { return classify(2); }
      `),
    );
    assert.deepEqual(errors, []);
  });
});


// ---------------------------------------------------------------------------
// Async coloring (plans/async-coroutines.md)
//
// The two rules are mutually reinforcing: `await` only inside an async
// body, and an async callee only reachable through `await`. Together they
// guarantee a suspend always has a coroutine frame to propagate into, which
// is the property that makes the whole design sound - so each direction is
// pinned here rather than only exercised end-to-end.
describe("typecheck: async/await coloring", () => {
  it("accepts an async function awaited from another async function", () => {
    const { errors } = typecheckSource(
      "async inner(x: int32): int32 { return x + 1; }\n" +
        "async outer(x: int32): int32 { return await inner(x); }\n" +
        "function main(): int32 { return 0; }",
    );
    assert.deepEqual(errors, []);
  });

  // Task support (and trait-impl validation, below) only exists on the
  // multi-module path; the legacy typecheckSource has neither, so these
  // go through typecheckProgram.
  it("accepts await inside a task body (implicitly async)", () => {
    const { errors } = typecheckProgram(
      withCoreKinds(
        "async inner(x: int32): int32 { return x + 1; }\n" +
          "task worker(x: int32): int32 { return await inner(x); }\n" +
          "function main(): int32 { pooled h = worker(1); return wait h; }",
      ),
    );
    assert.deepEqual(errors, []);
  });

  it("rejects await in a plain function", () => {
    const { errors } = typecheckSource(
      "async inner(x: int32): int32 { return x + 1; }\n" +
        "function main(): int32 { return await inner(1); }",
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /await is only allowed inside an async function/);
  });

  it("rejects calling an async function without await", () => {
    const { errors } = typecheckSource(
      "async inner(x: int32): int32 { return x + 1; }\n" +
        "async outer(x: int32): int32 { return inner(x); }\n" +
        "function main(): int32 { return 0; }",
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /async function must be awaited/);
  });

  it("rejects awaiting a non-async callee", () => {
    const { errors } = typecheckSource(
      "function plain(x: int32): int32 { return x; }\n" +
        "async outer(x: int32): int32 { return await plain(x); }\n" +
        "function main(): int32 { return 0; }",
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /this callee is not async/);
  });

  // A task call site is a SPAWN, not an await: it evaluates to Task<T>
  // and is joined with `wait`. Task bodies are implicitly async, so
  // without the spawn carve-out every spawn would report as un-awaited.
  it("does not require await at a task spawn site", () => {
    const { errors } = typecheckProgram(
      withCoreKinds(
        "task worker(x: int32): int32 { return x; }\n" +
          "function main(): int32 { pooled h = worker(1); return wait h; }",
      ),
    );
    assert.deepEqual(errors, []);
  });

  // Asyncness is part of a signature: an async method has a different ABI
  // and a different calling rule, so an impl that disagrees with its trait
  // is a real mismatch.
  it("rejects a sync impl of an async trait method", () => {
    const { errors } = typecheckProgram(
      singleModule(
      "trait R { async read(ref self): int32; }\n" +
        "type S implements R {\n" +
        "  n: int32,\n" +
        "  function read(ref self): int32 { return self.n; }\n" +
        "}\n" +
        "function main(): int32 { return 0; }",
      ),
    );
    assert.ok(errors.length >= 1);
    assert.match(errors[0].message, /expected async \(/);
  });

  // Generic async trait dispatch. The generic body awaits a bound
  // method; asyncness has to survive monomorphization for the await to
  // resolve, which it does via substituteTypeParams.
  it("accepts a generic function awaiting a bound async trait method", () => {
    const { errors } = typecheckProgram(
      withCoreKinds(
        "trait F { async fetch(ref self): int32; }\n" +
          "type C implements F { n: int32, async fetch(ref self): int32 { return self.n; } }\n" +
          "async twice<T implements F>(ref f: T): int32 {\n" +
          "  let a: int32 = await F.fetch(ref f);\n" +
          "  return a + await F.fetch(ref f);\n" +
          "}\n" +
          "task run(): int32 { let c: C = { n: 2 }; return await twice(ref c); }\n" +
          "function main(): int32 { pooled h = run(); return wait h; }",
      ),
    );
    assert.deepEqual(errors, []);
  });

  // A vtable slot inherits the trait method's asyncness, so dispatch
  // through the erased view is awaited like any other async call.
  it("accepts awaiting an async trait method through a vtable", () => {
    const { errors } = typecheckProgram(
      withCoreKinds(
        "trait F { async fetch(ref self): int32; }\n" +
          "vtable FView for F { fetch: () => int32, }\n" +
          "type C implements F { n: int32, async fetch(ref self): int32 { return self.n; } }\n" +
          "async useIt(ref v: FView): int32 { return await F.fetch(ref v); }\n" +
          "task run(): int32 { let c: C = { n: 5 }; let v: FView = FView.from(ref c); return await useIt(ref v); }\n" +
          "function main(): int32 { pooled h = run(); return wait h; }",
      ),
    );
    assert.deepEqual(errors, []);
  });

  it("accepts a matching async impl of an async trait method", () => {
    const { errors } = typecheckProgram(
      singleModule(
      "trait R { async read(ref self): int32; }\n" +
        "type S implements R {\n" +
        "  n: int32,\n" +
        "  async read(ref self): int32 { return self.n; }\n" +
        "}\n" +
        "function main(): int32 { return 0; }",
      ),
    );
    assert.deepEqual(errors, []);
  });
});
