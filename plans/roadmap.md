# Yooperlang Compiler Roadmap

## Context

You're building a compiler from scratch in JS that emits LLVM IR, with [SPEC.md](../SPEC.md) as the eventual target. The current implementation is ~1,600 lines across [lexer](../src/jsyooplexer/lexer.js), [parser](../src/jsyooparser/parser.js), [codegen](../src/jsyoopcodegen/codegen.js), and the [driver](../src/yoopiler.js). It supports function definitions with typed params, `let`/`const` with required type annotations, basic arithmetic/comparison/logical ops, `if`/`while`, function calls, and printf-only template-literal interpolation. Type checking happens inline in codegen via string comparisons; there is no separate typecheck pass, no struct types, no imports, no externs (printf is hardcoded), no traits, no kinds, no error handling, and no float/hex/binary literals.

You want a JAI/nob.h-style "program defines itself" compilation model: invoke `yoopiler main.yoop`, and the program transitively pulls in everything else (imports, extern decls, link directives) from source. No CLI flags, no manifest, no separate build process. The roadmap below takes the JS bootstrap all the way to a usable language before any thought of self-hosting.

The decisions baked into this plan: JS bootstrap goes far before self-hosting; single-entry-file compilation walks imports; separate typecheck pass between parse and codegen; explicit `Type` objects (not strings); structs first, then errors-as-values, then traits, then kinds.

---

## High-level roadmap

The phases below are ordered so each one unlocks the next. Distant phases are intentionally sketchy — the language will evolve and locking them in now would be premature.

> **Status**: Phases 1 through 8 (plus library phases A–D) have all landed. Per-phase plan documents have moved to [plans/completed/](completed/). The active plan document for the next batch of work is [phase-9.md](phase-9.md). See the bottom of this file for the current focus.

### Phase 1 — Foundations (typechecker + structs + literals) ✓ landed

The current "typecheck inside codegen with strings" approach won't extend to anything in the spec. Fix the foundation, then add structs as the first new feature.

- **Standalone typechecker pass** with explicit `Type` objects, run between parse and codegen
- **Numeric literal generalization**: untyped int/float literals coerced into their target type per spec §2 (range-checked, no implicit cross-coercion)
- **Float, hex, binary, octal, underscore-separated literals** in the lexer
- **Negative numeric literals** (currently parse as unary minus)
- **Struct types** — `type Point { x: int32, y: int32 }` parsing, codegen as LLVM `%struct.Point`, field access, struct literals, struct returns

### Phase 2 — Errors as values ✓ landed

Errors are a recognizable convention (`err: string` field) plus the `?` operator. They need structs but not traits/kinds, and exercise the typechecker hard.

- Detect "fallible" types (struct with trailing `err: string`)
- Enforce err-observation rules per spec §11 (read err before scope exit, or use `?`, or `_ = f()`)
- The `?` operator: postfix on fallible expr, rewrites to early return; only legal if enclosing fn returns fallible too
- `?` value semantics: strip `err` field, yield the rest (single-field -> bare value, multi-field -> struct, err-only -> `void`)
- Destructuring sugar (`const { value, err } = f()`) as syntactic rewrite

### Phase 3 — Modules and FFI ✓ landed

The "program defines itself" story. The entry file pulls in everything; no flags, no build manifest.

- **Imports**: relative-path only, `.yoop` required; `import {x, y} from "./foo.yoop"`, `import * as ns`, side-effect-only imports
- **Exports**: `export type/function/const`, grouped exports
- **Module graph walker** in the driver: starting from the entry file, transitively load and parse all imports, detect cycles, build a single AST set
- **Symbol resolution** across modules in the typechecker
- **`extern "C" from "stdio.h" { ... }`**: replaces hardcoded printf and friends. Parses C-style fn decls, type aliases, externs become symbols in the typechecker, link directives propagate
- **`extern "C" from library "m"`**: emits `-lm` style link flags to clang
- **`export "C" function`**: unmangled symbols for C ABI

> Detailed plan: [completed/phase-3-modules-and-ffi.md](completed/phase-3-modules-and-ffi.md)

### Phase 4 — Refs, arrays, control flow gaps ✓ landed

Mid-level data shapes the spec leans on. None require traits/kinds to land.

- `ref T` parameters and bindings, auto-deref reads/writes (no null, no arithmetic)
- Arrays as fat pointers (ptr + len), `xs.len` intrinsic, array literals, indexing
- `for (i = 0; ...; ...)` C-style numeric for-loop
- `else if` chaining, `break`, `continue`
- Casts as type-name calls: `int64(x)`, `uint8(x & 0xFF)`

> Detailed plan: [completed/phase-4-refs-arrays-control-flow.md](completed/phase-4-refs-arrays-control-flow.md)

### Phase 5 — Traits ✓ landed

Capability layer. Spec §5. Methods live inside `type X implements Trait { fields; fn; }` blocks (no bare impl blocks). Phase 5 ships **non-generic traits only**, with `extends` and method-call sugar deferred — kept tight so phase 6 (kinds) can lean on it.

- `trait Foo { ... }` parsing and a `TraitType` in the type system
- `type T implements Trait { ... }` parsing, method registration
- Multi-trait impls: `type T implements (A, B) { ... }`
- Trait method resolution at call sites (free-function form, `dispose(ref x)`, per spec §17.2)
- `ref T` for struct `T` (deferred from phase 4 — needed for `ref self`)
- Same-name method collisions (across implemented traits, and against module free functions) rejected at typecheck
- Generic traits, `extends`, and method-call sugar deferred to a later phase

> Detailed plan: [completed/phase-5-traits.md](completed/phase-5-traits.md)

### Phase 6 — Kinds ✓ landed

The big one. Spec §6. Probably the hardest part of the language.

- `kind foo { ... }` parsing with all clauses (`requires`, `provides`, `appliesTo`, `ownsBlock`, `mustCall`, `mustNotShare`, `autoJoin`, `restricts`, `layout`, `propagates`, `contains`, `forbids`); each clause is a `keyword arg...;` statement or `keyword arg... { sub-clauses };` block
- Kind prefix on bindings, params, fields, fn declarations
- Static analysis pass for `mustCall` obligations (with cleanup insertion at `?`, return, fall-through)
- `mustNotEscape` / `mustNotShare` checks
- `task` kind syntax (compile-time): kind-prefixed function decls, `provides Task` semantics, `wait` operator, `joined`/`pooled`/immediate binding behavior
- `task` runtime: pthread-backed worker pool, LLVM coroutine intrinsics for forward-compat, refcounted `pooled` handles, cross-platform threading shim. The runtime contract lives in [runtime-design.md](runtime-design.md) and lands before the language-sugar phase 6.3 work.
- Block-owning kinds with implicit-block synthesis in reverse declaration order

> Detailed plan: [completed/phase-6-kinds.md](completed/phase-6-kinds.md)

### Phase 6.3-prelude — Concurrency runtime ✓ landed

The first piece of phase 6.3 is the runtime, separated from the language-sugar work so the two move on independent tracks. Deliverables:

- `runtime/yoop_runtime.{c,h}` — central FIFO worker pool, mutex/condvar shim, refcount lifecycle for pooled handles, `yoop_runtime_init/shutdown`. Cross-platform via `#ifdef _WIN32`.
- Codegen support in [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) for per-result-type `Task_<T>` struct emission, per-task-function thunks, LLVM coroutine intrinsics, and compiler-injected init/shutdown calls in `main`.
- Build pipeline update in the yoopiler driver to compile and link the runtime alongside user `.ll` output.

This phase lands no surface-language changes; it's the foundation phase 6.3 (language sugar) builds on. The full contract is in [runtime-design.md](runtime-design.md).

### Phase 7 — Generics, pattern matching, switch ✓ landed

Once kinds are stable, the language is usable. From here:

- User-defined generic types (deferred per spec §3)
- Pattern matching / sum types (deferred per spec §10)

> Detailed plans: [completed/phase-7-1-generics.md](completed/phase-7-1-generics.md), [completed/phase-7-2-trait-bounds.md](completed/phase-7-2-trait-bounds.md), [completed/phase-7-3-pattern-matching.md](completed/phase-7-3-pattern-matching.md), [completed/phase-7-4-trait-call-syntax.md](completed/phase-7-4-trait-call-syntax.md), [completed/phase-7-5-sum-types-and-unions.md](completed/phase-7-5-sum-types-and-unions.md)

### Phase 8 — Standard library + FFI primitives ✓ landed

- Phase 8.A–F: unsafe_ptr, C ABI aliases, buffer interop, errno, module-level state, task suspension + I/O multiplexer + timers
- Phase 8.H: string/bytes primitives + standard `Vec<T>`
- Library Phases A–D: `std/core`, `std/net`, `std/http` types + parser, `std/http` server

> Detailed plans live in [completed/](completed/) — [completed/phase-8-networking-prerequisites.md](completed/phase-8-networking-prerequisites.md) is the umbrella, with [completed/phase-8-a-unsafe-ptr.md](completed/phase-8-a-unsafe-ptr.md) through [completed/phase-8-h-string-bytes-vec.md](completed/phase-8-h-string-bytes-vec.md) and [completed/library-phase-a-traits.md](completed/library-phase-a-traits.md) through [completed/library-phase-d-server.md](completed/library-phase-d-server.md) as the per-slice docs.

### Phase 9 — Syntax and ergonomic completion (current focus)

The next batch of language work, picked for the items that are still **forcing workarounds in real yoop code** or **blocking syntax forms already in [SPEC.md](../SPEC.md)**. Highlights: parenthesized subexpressions, `bool[]` arrays, `for ... in` loops, array slice syntax, `std/` import root, `Display` in template literals, `vtable T for Trait` runtime polymorphism + function value types, `?` over enum errors, suspendable `wait`, plus a cleanup pass for `extends` / multi-bound / `mustNotShare acrossThreads`.

> Detailed plan: [phase-9.md](phase-9.md)

### Phase 10 — Library completion, foundation generics, runtime polish, self-hosting (current focus)

The next batch after Phase 9 — closes the *library* workarounds (the
`std/collections/` story, `std/log` + `std/debug`, networking polish)
and the long tail of small "deferred" items from Phases 5–9
(`extends` on traits, multiple trait bounds, cancellation tokens,
cross-shape `?`, alloca uniqueness in codegen). Optimization passes
and the actual self-hosting bootstrap move to the *end* of Phase 10:
the JS bootstrap isn't worth porting until the surface it implements
is something a self-hosted compiler would also want to expose.

The single biggest unlock — **generic enums** — landed as
sub-phase 10.A (see [phase-10-a-generic-enums.md](completed/phase-10-a-generic-enums.md)).
`Option<T>`, `Result<T, E>`, and `IterStep<T>` are now expressible. The
Phase 10.X cleansing pass also landed
(see [phase-10-x-cleansing.md](completed/phase-10-x-cleansing.md)): the
Phase 2 fallible-struct convention has been retired and `std/` is
uniformly on `Result<T, E>`. Phase 10.B (see
[phase-10-b-iterable.md](completed/phase-10-b-iterable.md)) extended
`for ... in` to walk any struct implementing the new generic
`Iterable<T>` trait. Phase 10.C
(see [phase-10-c-collections.md](completed/phase-10-c-collections.md))
shipped its first cut: `Option<T>` and a string-keyed `StringMap<V>` —
plus two codegen fixes that container code needed (variant-record
re-fetch in `cloneAstWithSubstitution`; fixed-point generic emission).
Phase 10.H
([phase-10-h-alloca-uniqueness.md](completed/phase-10-h-alloca-uniqueness.md))
fixed the long-standing codegen gap that made `case Option.Some {
value: v }` arms collide on `%v`. Phase 10.X.2
([phase-10-x2-fn-ptr-fields.md](completed/phase-10-x2-fn-ptr-fields.md))
landed the function-pointer-field lifts (func-decl → FPT coercion +
indirect-call lowering), and Phase 10.C.2
([phase-10-c-2-generic-map.md](completed/phase-10-c-2-generic-map.md))
turned that into a real `Map<K, V>` in `std/collections/map.yoop`,
keyed off a `KeyOps<K>` ops struct with pre-built `string_key_ops()`
and `int32_key_ops()` helpers. Phase 10.C.3
([phase-10-c-3-collections-rest.md](completed/phase-10-c-3-collections-rest.md))
wrapped up the collections arc: `Set<K>`, `Deque<T>`, `for entry in
map_iter(ref m)`, plus int64/uint64/bytes KeyOps helpers and the
five compiler-side fixes container code surfaced.

> Detailed plan: [phase-10.md](phase-10.md).

---

## Near-term detail — Phase 1

Phase 1 is the foundation everything else stands on. Three pieces, in this order:

### 1.1 Numeric literal generalization (lexer-only change)

**Why first**: it's small, exercises the lexer in isolation, and gives you cleaner test inputs for the typechecker.

**Files**: [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js), [src/jsyooplexer/charFns.js](../src/jsyooplexer/charFns.js)

- Add `floatLiteral` token tag alongside `intLiteral`; lexer disambiguates on seeing a `.` or `e`/`E` exponent
- Recognize `0x` (hex), `0b` (binary), `0o` (octal) prefixes; reject prefix-only with no digits
- Allow `_` as digit separator: `1_000_000`, `0xDEAD_BEEF`
- Optional suffixes: `42i32`, `255u8`, `1.0f32`, `3.14f64` — store the suffix on the token
- Keep storing parsed numeric value as `intVal` for ints; add `floatVal` for floats
- Negative literals stay parser-side: parser folds unary `-` over a numeric literal into a literal node, not a unary expr (this keeps `let x: uint8 = -1` failing at typecheck rather than codegen)

> Detailed plan: [phase-1-1-numeric-literals.md](phase-1-1-numeric-literals.md)

### 1.2 Standalone typechecker pass

**Why before structs**: adding struct typechecking on top of the current string-based mishmash will make the eventual refactor harder.

**New file**: `src/jsyooptypecheck/typecheck.js`. Wired in [src/yoopiler.js](../src/yoopiler.js) between `parse()` and `codegen()`.

**Type representation** (`src/jsyooptypecheck/types.js`):

```
Type = {
  kind: "prim" | "struct" | "ref" | "array" | "func" | "void" | "untypedInt" | "untypedFloat",
  ...details
}
```

- `PrimType { name }` — int8/16/32/64, uint8/16/32/64, float32/64, bool, char, string, usize, isize
- `StructType { name, fields: [{name, type}], implements: [TraitType] }` (implements stays empty until Phase 5)
- `RefType { inner }` — for Phase 4
- `ArrayType { elem }` — for Phase 4
- `FuncType { params: [{name, type, isRef}], returnType }`
- `UntypedIntType` / `UntypedFloatType` — literal types before coercion (spec §2: literals are untyped until they reach a typed context)
- Helpers: `canonicalize(name)` (replaces the `int`->`int32` map in [codegen.js:25](../src/jsyoopcodegen/codegen.js#L25)), `assignable(dst, src)`, `unifyArith(left, right, op)`, `coerceLiteralToType(literalType, targetType)`, `formatType(t)` for error messages

**Pass shape**:

1. **Symbol collection** — walk top-level decls, build a module-level symbol table (functions, type decls, consts). This pre-pass means functions can call each other regardless of declaration order.
2. **Function bodies** — for each function, walk its AST, push scopes for blocks, resolve identifiers, infer/check types on every expression, store the resolved `Type` on the AST node (`node.resolvedType`)
3. **Validation rules**: every assignment runs `assignable(dst, src)`; every binary op runs `unifyArith`; every call checks arity and arg types; every return checks against the function's return type; every literal in a typed context gets coerced (range-checked) to the target type
4. **Error reporting**: collect errors with source positions instead of throwing on first; emit them all at end-of-pass

**Codegen refactor**: rip out type checks from [codegen.js](../src/jsyoopcodegen/codegen.js). Codegen now trusts `node.resolvedType` was set by the typechecker. Specifically remove the inline checks at [codegen.js:206](../src/jsyoopcodegen/codegen.js#L206), [572-588](../src/jsyoopcodegen/codegen.js#L572-L588), and the `unifyArithType`/`checkAssignable` helpers — they move into the typechecker. Keep `llvmTypeOf(yoopType)` and the type->format-specifier table in codegen because those are codegen concerns.

**Reuse**: keep `canonicalize`, `llvmType` map, alignment table, format-specifier table from [codegen.js:4-58](../src/jsyoopcodegen/codegen.js#L4-L58). They stay in codegen but operate on resolved `Type` objects instead of raw strings.

### 1.3 Struct types

**Files**: [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js), [src/jsyooparser/parser.js](../src/jsyooparser/parser.js), `src/jsyooptypecheck/typecheck.js`, [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js)

**Lexer**: add `type` keyword (it's not a token tag yet, just an identifier). Add `,` to punctuation if not already there.

**Parser**:

- New top-level form: `parseTypeDecl()` produces `typeDecl { name, fields: [{name, type}] }`. Top-level dispatch needs to accept `typeDecl` alongside `functionDecl` (today it only accepts function decls — see [parser.js:412+](../src/jsyooparser/parser.js#L412))
- Field-access expression: `expr.ident` parses as `fieldAccess { object, field }`. Slot into the Pratt parser at infix-with-high-precedence
- Struct literals: `{ x: 1, y: 2 }`. Disambiguate from blocks — only valid in expression position, never statement position. Easiest: detect `{ ident :` lookahead in expression-start.
- Type annotations now parse type names that may be struct names (just identifiers — typechecker resolves)

**Typechecker**:

- `typeDecl` adds a `StructType` to the module symbol table at the symbol-collection phase
- `fieldAccess`: resolve `object`'s type, look up field by name, set `resolvedType` to field's type
- Struct literal: requires a target type from context (annotation or function return). Each field expr is checked assignable to its declared type. Missing or extra fields are errors.
- Struct values are first-class: assign, return, pass as parameter

**Codegen**:

- Emit `%struct.Point = type { i32, i32 }` per type decl at module top (before functions)
- Locals of struct type: `alloca %struct.Point`
- Field read: `getelementptr inbounds %struct.Point, ptr %p, i32 0, i32 N` then `load`
- Field write: `getelementptr` then `store`
- Struct literal: alloca a temp, GEP+store each field, then load (or pass the alloca pointer if returned/assigned)
- Struct return: pass-by-value via memcpy is the simplest first implementation; sret is an optimization for later
- New helper: `structFieldOffset(structType, fieldName)` returning the field index

**Test program** to land Phase 1:

```
type Point { x: int32, y: int32, }

function distance_sq(p: Point): int32 {
    return p.x * p.x + p.y * p.y;
}

function main(): int32 {
    let p: Point = { x: 3, y: 4 };
    printf(`distance_sq = ${distance_sq(p)}\n`);
    return 0;
}
```

This must compile and print `distance_sq = 25`.

> Detailed plan: [phase-1-3-structs.md](phase-1-3-structs.md)

---

## Verification

After Phase 1:

- Existing test programs ([examples/test.yoop](../examples/test.yoop), the hardcoded test in [yoopiler.js](../src/yoopiler.js)) must still produce the same output
- The typechecker should produce a useful error message for: assigning a string to int32, calling a function with wrong arg count, accessing a nonexistent struct field, range-overflowing literals (`let x: uint8 = 256;`)
- The Phase 1 test program above must compile and run, printing `distance_sq = 25`
- Negative-test programs (invalid code) must fail at typecheck time with positions, not at codegen time

After Phase 6.3-prelude: the runtime in `runtime/yoop_runtime.{c,h}` builds on Linux (and eventually macOS / Windows) and can be linked into a yoopiler-produced executable that calls `yoop_runtime_init` / `yoop_runtime_shutdown` without error, even before any task functions exist in user code.

Run end-to-end via `node ./src/yoopiler.js -i examples/test.yoop -o output` and execute `output.exe`. Add a small test runner script that walks `examples/` (split into `examples/pass/` and `examples/fail/`) and asserts each compiles or fails as expected — this becomes the regression suite for every phase after.

---

## Critical files

- [SPEC.md](../SPEC.md) — language spec; reread before starting each phase
- [runtime-design.md](runtime-design.md) — concurrency runtime contract; the implementation reference for phase 6.3
- [src/yoopiler.js](../src/yoopiler.js) — driver; will need an import-walking loop in Phase 3
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — Phase 1 numeric literals, ongoing keyword additions
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — Phase 1 struct syntax, growing each phase
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — Phase 1 type-check removal, struct emission
- `src/jsyooptypecheck/` — new in Phase 1, grows every phase after
- `runtime/` — companion C runtime added in Phase 6.3
- [examples/test.yoop](../examples/test.yoop) — extend each phase; consider splitting into `pass/` and `fail/`
