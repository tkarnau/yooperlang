# Phase 1.2 — Standalone typechecker pass

Part of the [roadmap](./roadmap.md). Phase 1.1 cleaned up numeric literals at the lexer/parser level. This phase introduces a real typechecker pass between [parse](../src/jsyooparser/parser.js) and [codegen](../src/jsyoopcodegen/codegen.js), replacing the string-based, codegen-inline checks that exist today.

## Goal

Move all type reasoning out of [codegen.js](../src/jsyoopcodegen/codegen.js) into a new `src/jsyooptypecheck/` module. Codegen should trust an annotated AST and emit IR. Concretely, after this phase:

- Every expression node carries a resolved `Type` object (`node.resolvedType`)
- Every literal-in-typed-context has been coerced (range-checked) to its target type, with the chosen concrete type recorded on the node
- Type errors are reported with source positions, collected, and emitted at end-of-pass — not thrown one-at-a-time from inside codegen
- Codegen no longer contains `checkAssignable`, `unifyArithType`, or any string comparisons over yooper type names

## Why this is next

Phase 1.3 (structs) needs a real type system to land cleanly. Field-access typing, struct-literal target-type pinning, and assignability of compound values cannot be retrofit on top of the current `if (l !== r) throw` logic in [codegen.js:649-665](../src/jsyoopcodegen/codegen.js#L649-L665) without making that refactor twice as painful. Build the typechecker on the smaller surface area we have today, then add structs to it.

A second motivation: Phase 1.1 added `floatLiteral` and `numSuffix` but punted on what they should resolve to. Right now [codegen.js:210-212](../src/jsyoopcodegen/codegen.js#L210-L212) hardcodes every float literal to `float64`, regardless of declared target type. The typechecker is where that pinning belongs.

## Scope (what this phase does NOT do)

- No struct types — that's Phase 1.3. The `Type` enum reserves a `struct` kind but the typechecker won't construct one yet.
- No `ref` or array types — placeholders only; Phase 4.
- No trait/kind plumbing — placeholders only; Phases 5–6.
- No widening conversions (`int8` → `int32` in arithmetic) — exact-match assignability stays for now, matching current behavior. Adding widening is its own design call we don't need to make yet.
- No multi-file/import resolution — single-file symbol table only. Modules come in Phase 3.
- No const-folding or value-range inference beyond literal coercion.

---

## Files touched

**New files** (under `src/jsyooptypecheck/`):

- `src/jsyooptypecheck/types.js` — `Type` constructors, predicates, helpers (`canonicalize`, `assignable`, `unifyArith`, `coerceLiteralToType`, `formatType`, `primTypeFromName`)
- `src/jsyooptypecheck/typecheck.js` — the pass itself: `typecheck(ast)` entry point, symbol collection, body traversal, error collection
- `src/jsyooptypecheck/errors.js` — small `TypeError` record `{ message, start, length }` and a collector
- `src/jsyooptypecheck/typecheck.test.js` — unit tests; called from `runTests()` in [yoopiler.js](../src/yoopiler.js)

**Edited**:

- [src/yoopiler.js](../src/yoopiler.js) — wire `typecheck(ast)` between `parse()` and `codegen()`; if errors exist, print them and exit non-zero
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — strip type-checking logic; switch to reading `node.resolvedType`; rewrite the `LLVM_TYPES` lookup to take a `Type` object instead of a string
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — minor: ensure every expression `ASTNode` carries `start` / `length` from the originating token range, so the typechecker can produce positioned errors. (The parser already has token positions; this is a hygiene pass over `parseExpression`, `parsePrimary`, etc.)

---

## Type representation (`src/jsyooptypecheck/types.js`)

A discriminated union with a `kind` tag. Plain JS objects, no classes — same convention as AST nodes.

```js
// every Type has at least { kind, ... }
//   kind: "prim" | "struct" | "ref" | "array" | "func" | "void"
//       | "untypedInt" | "untypedFloat" | "error"

PrimType(name)              // name: "int8".."int64", "uint8".."uint64",
                            //       "float32"|"float64", "bool", "char",
                            //       "string", "usize", "isize"

StructType(name, fields)    // fields: [{ name, type }]
                            // implements: [] (reserved for Phase 5)
                            // NOT CONSTRUCTED IN THIS PHASE — Phase 1.3 fills this in

RefType(inner)              // Phase 4 — placeholder
ArrayType(elem)             // Phase 4 — placeholder

FuncType(params, returnType)
  // params: [{ name, type, isRef }]
  // returnType: Type

VoidType                    // singleton; the result of fns returning nothing

UntypedIntType              // tag carried by intLiteral nodes before pinning;
                            // also remembers the parsed value so the
                            // typechecker can range-check on coercion
UntypedFloatType            // same idea for floatLiteral

ErrorType                   // sentinel used to suppress cascading errors —
                            // anything that already produced a typecheck
                            // error has type ErrorType, and most rules treat
                            // it as compatible with everything
```

Keep these as factory functions returning frozen objects, not classes — keeps the rest of the compiler `JSON.stringify`-able for debugging, matching the AST style.

### Helpers in `types.js`

- `canonicalize(name)` — `"int"` → `"int32"`, `"float"` → `"float32"`. This replaces the canonicalization logic at [codegen.js:24-29](../src/jsyoopcodegen/codegen.js#L24-L29).
- `primTypeFromName(name)` — given a string from a type annotation, returns a `PrimType` (after canonicalization) or `null` if unknown. This is what every `: int32` annotation runs through.
- `typesEqual(a, b)` — structural equality across the union. Two `PrimType`s are equal iff their `name` matches; `StructType`s by name (nominal); `FuncType`s by recursive comparison.
- `assignable(dst, src)` — returns true if a value of type `src` can flow into a slot of type `dst`. Initial rules:
  - `typesEqual(dst, src)` → true
  - `src.kind === "untypedInt"` and `dst` is an integer `PrimType` → true (caller is responsible for range-checking)
  - `src.kind === "untypedFloat"` and `dst` is a float `PrimType` → true (caller does the coerce)
  - `src.kind === "error"` or `dst.kind === "error"` → true (suppress cascades)
  - else → false
- `unifyArith(left, right, op)` — returns the result `Type`, or `null` if the op is illegal between these types. Both untyped → still untyped (e.g. `1 + 2` is `untypedInt`, pinned later by the surrounding context). One untyped, one typed → result is the typed one (the untyped side will be coerced). Two typed must match exactly. Comparison ops always produce `bool`. Logical ops require `bool` operands.
- `coerceLiteralToType(literalNode, targetType)` — given an `intLiteral` / `floatLiteral` node and a target `PrimType`, range-check and rewrite the node's `resolvedType` to `targetType`. Returns `{ ok, error }`. Range tables for each primitive go here:
  - `int8`: `[-128, 127]`, `uint8`: `[0, 255]`, etc.
  - For floats: check value is finite; for `float32` check magnitude fits in IEEE-754 single-precision range (use `Math.fround(v) === v` as the simplest "no precision loss" guard, or the looser "in range" guard `Math.abs(v) <= 3.4e38`). Spec doesn't specify precision-loss strictness; start with range-only.
- `formatType(t)` — pretty-printer for error messages. `"int32"`, `"ref int32"`, `"int32 -> int32"`, `"untyped int"`, etc.

The helpers above are **the** type API. Codegen and the typechecker both call them. Nothing else in the compiler should pattern-match on `t.kind`.

---

## The pass (`src/jsyooptypecheck/typecheck.js`)

Public API:

```js
export function typecheck(ast) {
  // returns { ast, errors }
  // - ast: same node objects, mutated in place with .resolvedType set
  //   on every expression; .resolvedType also set on letDecl/constDecl/
  //   functionDecl/param so codegen can read declared types uniformly
  // - errors: [] of { message, start, length }
}
```

The entry point does **not** throw on type errors — it collects and returns them. The driver decides what to do (print, exit). Lex/parse errors still throw upstream; those are bugs in this phase's input, not the user's code.

### Pass shape

**Pre-pass: symbol collection.** Walk `ast.body` (top-level decls). For each `functionDecl`, build a `FuncType` from `params` and `returnType` and store it in a module symbol table keyed by function name. Reject duplicate names. This pre-pass is what makes mutually-recursive and out-of-order function calls type-check correctly — the call site already sees a signature before its callee's body has been visited.

In Phase 1.2 the only top-level decls are functions. Phase 1.3 adds `typeDecl`; this pre-pass is the spot where struct types get registered.

**Main pass: per-function body traversal.** For each `functionDecl`:

1. Push a function-level scope. Insert each param as a binding `{ name, type: PrimType(...), mutable: true }`.
2. Walk the function body. Statements push/pop block scopes. Identifier resolution walks scopes outer-to-inner (innermost wins).
3. For every expression node, after recursing into children, set `node.resolvedType`.
4. For every statement that imposes a typed context (assignment RHS, return value, call argument, declaration initializer), apply the coercion rules below.

### Per-node rules

The function below is the whole pass in shape; details in subsections.

```js
function checkExpr(node, scope, ctx) {
  switch (node.kind) {
    case "intLiteral":     return setType(node, UntypedIntType);
    case "floatLiteral":   return setType(node, UntypedFloatType);
    case "strLiteral":     return setType(node, PrimType("string"));
    case "ident":          ...
    case "binaryExpression": ...
    case "unaryExpression":  ...
    case "callExpression":   ...
    case "assignment":       ...
    case "templateLiteral":  ...
  }
}
```

#### Literals

- `intLiteral` — type is `UntypedIntType` until coerced. Keep `node.value` (the JS number) intact.
- `floatLiteral` — `UntypedFloatType`.
- `strLiteral` — `PrimType("string")`. (`string` stays a primitive in this phase; later it'll likely become a struct or a `ref [u8]`.)

#### Identifier

Look up `node.name` in the active scope chain. If not found, log error, set `node.resolvedType = ErrorType`. If found, set to the binding's type.

#### Binary expression

Recurse left/right. Call `unifyArith(l.type, r.type, node.op)`. If `null`, error: `cannot apply "<op>" to <left> and <right>`. Comparison ops set `node.resolvedType = PrimType("bool")`; arithmetic sets it to the unified type. Logical ops (`and`, `or`) require `bool`.

If either operand is untyped and the other is typed, **coerce the untyped operand in place** by calling `coerceLiteralToType(operand, typedType)` (range-checked). This is where `let x: int8 = 1 + 2;` works: the `+` produces `untypedInt`, the assignment pins both sides.

If both operands are still untyped after the binary op (e.g. nested `1 + 2 + 3`), the binary node's type stays untyped. The eventual typed context coerces the whole subtree. Implementation note: when coercing a binary node, recurse into its operands and coerce each leaf; the result type is the target.

#### Unary expression

Phase 1.1 already folds unary minus over numeric literals into the literal node. What's left: `-x` where `x` is a variable. Type-check the operand; result type is the operand's type (must be numeric). `not x` requires `bool` and produces `bool`.

#### Call expression

Look up `node.callee` in:
1. The module function table.
2. The known-extern table (`printf`, `puts`, `exit`, etc. — see [codegen.js:626-633](../src/jsyoopcodegen/codegen.js#L626-L633)).
3. If neither, error: `unknown function "<name>"`.

For known signatures, check arity. For each argument, recurse, then call `assignable(paramType, argType)`. If the arg is an untyped literal expression, coerce in place (range-check).

`printf` is special — it's variadic and the format string drives the rest. Don't apply arity-check to it. For each argument, just recurse and let codegen handle the variadic plumbing as it already does. The typechecker doesn't need to validate format-spec/argument matchups in this phase (the existing codegen synthesizes the format spec from arg types — that logic stays in codegen because it's IR-shape, not a typing rule).

`templateLiteral` arguments still get walked the same way; each `exprPart` is type-checked but contributes no constraint.

The call node's `resolvedType` is the callee's return type.

#### Assignment

Look up the LHS name. Recurse into RHS. Apply `assignable(lhsType, rhsType)`; if the RHS is an untyped literal, call `coerceLiteralToType(rhsNode, lhsType)` first (range-checked). Mismatch → error.

The current parser only emits `assignment` for bare `name = value`. Once Phase 1.3 adds field-access LHS, this case generalizes.

#### Template literal

Each `exprPart` is type-checked and its `resolvedType` recorded. The whole `templateLiteral` is given `PrimType("string")` for now (matches how codegen treats it — eventually heap-allocated string, but the type's the same).

### Statement rules

#### `letDecl` / `constDecl`

Resolve the annotation via `primTypeFromName(node.type)`. Unknown type → error, but bind the variable as `ErrorType` so subsequent uses don't double-error. (Reserved: in Phase 1.3 the resolver also checks the module's struct-type table.)

If `node.assignment` is present, recurse into it. Then coerce/check assignability into the declared type. Store the binding in the current scope.

Set `node.resolvedType` to the declared type. (Codegen will read this instead of doing its own canonicalization.)

#### `returnStatement`

If no value, the enclosing function must have `returnType = void`. Otherwise recurse into the expression, coerce/check assignability into the function's return type.

#### `ifStatement` / `whileStatement`

Recurse into the condition; require `bool`. (Untyped literals don't coerce to `bool` — `if (1) ...` is an error. This matches most strict languages and the spec's tone.) Push a scope, walk the body. Same for `elseBody`.

#### `expressionStatement`

Recurse into the inner expression. Discard the type. (Statement-position calls and assignments are how side effects happen.)

#### `block`

Push a scope, walk children, pop.

### Scope structure

```js
const scope = {
  parent: parentScope,
  bindings: new Map(), // name -> { type: Type, kind: "let"|"const"|"param" }
};
```

The function-level scope holds params; each `block` pushes a child. Lookup walks parents. Redeclaration in the same scope is an error.

`const` vs `let`: in this phase, just remember which one was used. Phase 1.2 does **not** enforce `const` immutability — that's a separate small rule we can add at the end of the pass once the scaffolding works. (Add a one-line `if (binding.kind === "const") error(...)` in the assignment case if we want to ship it now. Cheap to include; flag if it falls out of scope.)

### Error collection

Replace the throw-on-first style with a collector:

```js
const errors = [];
function reportError(node, message) {
  errors.push({
    message,
    start: node.start ?? 0,
    length: node.length ?? 0,
  });
}
```

Errors carry positions. The driver formats them — line/column from offset is a small util (count newlines in the source up to `start`). Keep the formatter in `yoopiler.js` for now; once we have multiple passes that emit positioned errors (Phase 3), it can move to a shared module.

When an expression fails type-checking, set its `resolvedType = ErrorType` and continue. `ErrorType` is "compatible with anything" in `assignable` and `unifyArith`, so one bad expression doesn't trigger a cascade of meaningless follow-on errors.

---

## Driver wiring ([yoopiler.js](../src/yoopiler.js))

Insert between parse and codegen:

```js
const ast = parse(sourceStr);
console.log("parser: ok");

const { errors } = typecheck(ast);
if (errors.length > 0) {
  for (const e of errors) {
    const { line, col } = locFromOffset(sourceStr, e.start);
    console.error(`type error at ${line}:${col}: ${e.message}`);
  }
  process.exit(1);
}
console.log("typechecker: ok");

const ir = codegen(ast);
```

`locFromOffset` is a five-line helper — count newlines up to offset. Shared with future passes.

---

## Codegen refactor ([codegen.js](../src/jsyoopcodegen/codegen.js))

**Remove**:

- `checkAssignable` ([codegen.js:649-654](../src/jsyoopcodegen/codegen.js#L649-L654))
- `unifyArithType` ([codegen.js:658-665](../src/jsyoopcodegen/codegen.js#L658-L665))
- The inline checks at [codegen.js:240](../src/jsyoopcodegen/codegen.js#L240) (binaryExpression unify), [codegen.js:259](../src/jsyoopcodegen/codegen.js#L259) (assignment), [codegen.js:288-299](../src/jsyoopcodegen/codegen.js#L288-L299) (call arity/types), [codegen.js:415-419](../src/jsyoopcodegen/codegen.js#L415-L419) (return), [codegen.js:443-447](../src/jsyoopcodegen/codegen.js#L443-L447) (decl initializer), [codegen.js:476-479](../src/jsyoopcodegen/codegen.js#L476-L479) (if condition), [codegen.js:503-506](../src/jsyoopcodegen/codegen.js#L503-L506) (while condition).
- The `if (!LLVM_TYPES[declType])` "unknown type" guard at [codegen.js:428-432](../src/jsyoopcodegen/codegen.js#L428-L432) — the typechecker rejects unknown type names earlier.
- All `canonYoopType(...)` calls inside the per-statement walkers — node `.resolvedType` already holds the canonical type.

**Keep** (these are codegen concerns, not typing concerns):

- `LLVM_TYPES` table ([codegen.js:4-22](../src/jsyoopcodegen/codegen.js#L4-L22)) — but rewrite `llvmType` to accept a `Type` object: `llvmType(type)` switches on `type.kind`, then for `"prim"` reads from `LLVM_TYPES[type.name]`.
- `printfSpec`, `promotedLlvmType` ([codegen.js:46-88](../src/jsyoopcodegen/codegen.js#L46-L88)) — same rewrite to take `Type` objects.
- `alignOf` ([codegen.js:636-642](../src/jsyoopcodegen/codegen.js#L636-L642)) — operates on LLVM type strings; no change needed.
- `llvmFloatConstant` ([codegen.js:193-199](../src/jsyoopcodegen/codegen.js#L193-L199)) — no change.

**Change**:

- The `symbols` map currently stores yooper type strings ([codegen.js:223](../src/jsyoopcodegen/codegen.js#L223), [codegen.js:436](../src/jsyoopcodegen/codegen.js#L436)). Switch it to `Type` objects, or remove it entirely and read `node.resolvedType` from the binding's declaration AST node. Removing it is cleaner but means each `ident` codegen needs the decl node; storing the `Type` is the smaller diff. Pick the smaller diff for this phase.
- `intLiteral` codegen ([codegen.js:207-209](../src/jsyoopcodegen/codegen.js#L207-L209)) currently hardcodes `int32`. It must now consult `node.resolvedType` (set by `coerceLiteralToType` during typechecking) to pick the LLVM type. Otherwise an `int8` literal still gets emitted as `i32` and breaks downstream `add i8` instructions.
- `floatLiteral` codegen ([codegen.js:210-212](../src/jsyoopcodegen/codegen.js#L210-L212)) — same deal: read `node.resolvedType`. Also: if the resolved type is `float32`, the IR still uses the double-bit-pattern encoding (LLVM truncates at use); the constant goes alongside `float` operand types instead of `double`.
- The `unifyArithType`-removal path: in `binaryExpression` codegen, the operand type is `node.resolvedType` (the typechecker stored the unified type). Use it directly to drive `binaryInstruction(node.op, opType)`.

After this refactor, codegen contains zero `throw new Error("type error...")` calls. Any throw remaining there is "compiler bug, not user error" territory.

---

## Testing

`src/jsyooptypecheck/typecheck.test.js`, hooked into `runTests()` in [yoopiler.js:14-18](../src/yoopiler.js#L14-L18).

### Positive cases — must produce no errors

```yoop
function add(a: int32, b: int32): int32 { return a + b; }
function main(): int32 {
  let x: int32 = 1 + 2;
  let y: int8 = 100;
  let z: float64 = 3.14;
  let w: float32 = 1.0;
  printf(`x=${x} y=${y} z=${z} w=${w}\n`);
  return add(x, 5);
}
```

Each literal is in a typed context; each binary op unifies; the `add` call type-checks; the return value type-checks.

### Negative cases — must produce a single positioned error each

| Program snippet | Expected error |
|---|---|
| `let x: int32 = "hello";` | `cannot assign string to int32` |
| `let x: uint8 = 256;` | `literal 256 out of range for uint8 [0, 255]` |
| `let x: int8 = -200;` | `literal -200 out of range for int8 [-128, 127]` |
| `let x: int32 = 1 + 1.5;` | `cannot apply "+" to untyped int and untyped float` (or similar — exact wording TBD) |
| `function f(): int32 { return; }` | `function "f" must return int32, got bare return` |
| `function f(): int32 { return "x"; }` | `cannot return string from function returning int32` |
| `add(1);` (defined as 2-arg) | `wrong arg count to "add" — expected 2, got 1` |
| `add(1, "x");` | `arg 2 of "add": cannot pass string to int32` |
| `if (1) { ... }` | `if condition must be bool, got untyped int` |
| `nope();` | `unknown function "nope"` |
| `let x: notatype = 5;` | `unknown type "notatype"` |
| `let x: int32 = y;` (no `y` in scope) | `unknown identifier "y"` |
| `let x: int32 = 5; let x: int32 = 6;` | `redeclaration of "x"` |

### Multi-error case — every error reported

```yoop
function main(): int32 {
  let a: uint8 = 256;
  let b: int8 = -200;
  let c: int32 = "hello";
  return 0;
}
```

Three errors expected, all reported, with three distinct positions. Verify via the test harness.

### Codegen smoke

The test program from [yoopiler.js:69-79](../src/yoopiler.js#L69-L79) (hello-world + arithmetic) must continue to compile and produce the same output. So must [examples/test.yoop](../examples/test.yoop). Both run end-to-end through the new typecheck pass with no errors and identical IR (modulo the literal-type pinning fix — `int32` literals stay `int32`, `float64` literals stay `float64`, so output should be byte-identical).

A new positive end-to-end:

```yoop
function main(): int32 {
  let a: int8 = 100;
  let b: int8 = 27;
  let c: int8 = a + b;
  printf(`c=${c}\n`);
  return 0;
}
```

Expected output: `c=127`. (Pre-Phase-1.2, this would have failed at codegen because `intLiteral` was hardcoded `int32` and the `a + b` would have unified at `i8` while the literals were `i32` — the typechecker's literal pinning is what makes this work.)

---

## Edge cases worth getting right

- **Untyped-on-both-sides binary**: `let x: int8 = 1 + 2;` — both operands are `untypedInt`, the `+` produces `untypedInt`, the assignment pins it to `int8`, and *both leaves* must be coerced (range-checked individually). Implementation: when coercing a binary node, recurse into operands.
- **Mixed untyped + typed**: `let x: int8 = a + 1;` where `a: int8` — `unifyArith` returns `int8` because the typed side wins; `1` gets coerced to `int8`.
- **Float literal that fits in float64 but not float32**: `let x: float32 = 1e40;` — out-of-range error.
- **Negative literal into unsigned**: `let x: uint8 = -1;` — error. The folding from Phase 1.1 made this a literal node with `value = -1`, and the range check (`[0, 255]`) catches it. This is the test that validates Phase 1.1's folding decision.
- **Function in expression position**: `let f: int32 = add;` (taking the function value) — error in this phase: `add` resolves to a `FuncType`, not assignable to `int32`. First-class functions are not in the spec yet; this is fine.
- **Recursive function**: `function f(n: int32): int32 { if (n == 0) { return 0; } return f(n - 1); }` — the symbol-collection pre-pass means `f` is in the table before its body is checked. Should type-check cleanly.
- **Return-type-void with no return statement**: function falls through. No error required from the typechecker; codegen already inserts `ret void`.

---

## Out of scope (for clarity)

- **Widening conversions in arithmetic** — `int8 + int32` is still an error.
- **Mutation tracking for `const`** — flagged as a small drop-in but not required to ship the phase.
- **String concatenation** — `"a" + "b"` stays an error; spec uses template literals.
- **Bool arithmetic** — `true + 1` is an error (`unifyArith` returns `null`).
- **Const-folding** — `let x: int8 = 100 + 30;` is fine (untyped + untyped → untyped, both coerce to int8). But `let x: int8 = 200 + 30;` errors as "literal 200 out of range" *and* "literal 30 out of range" — we don't do `200+30=230 > 127` math at compile time. That's a future polish item; spec doesn't require it.
- **Unused variable warnings** — not in scope.
- **Shadowing rules** — block-scoped shadowing is allowed (inner scope can rebind a name from an outer scope). Same-scope redeclaration is an error.

---

## Phase exit criteria

- [examples/test.yoop](../examples/test.yoop) and the smoke program in [yoopiler.js](../src/yoopiler.js) compile and produce identical output to before Phase 1.2.
- Every negative-case program in the table above produces exactly one error at the right position, with no crash.
- The multi-error program reports all three errors.
- The new `int8 a + b` program prints `c=127`.
- [codegen.js](../src/jsyoopcodegen/codegen.js) contains no `checkAssignable`, no `unifyArithType`, no string comparisons over yooper type names, and no `throw new Error("type error...")`.
- `node ./src/yoopiler.js` (test mode) runs `runTests()` which now includes `testTypecheck()`, all tests pass.

---

## Critical files reference

- [SPEC.md §2](../SPEC.md) — primitive types and literal coercion rules
- [SPEC.md §3](../SPEC.md) — type system, generics deferral
- [src/yoopiler.js](../src/yoopiler.js) — driver wiring
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — AST node kinds and shapes; minor position-tracking hygiene
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — refactor target
- `src/jsyooptypecheck/types.js` — new; the type API
- `src/jsyooptypecheck/typecheck.js` — new; the pass
