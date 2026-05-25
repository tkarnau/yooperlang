# Phase 9.D - `for ... in` loop (arrays)

## Context

Plan: [plans/phase-9.md §9.D](../phase-9.md#phase-9d--for--in--loop--iterable-trait).

Every example in the codebase (and across `std/`) uses the C-style
`for (i = 0; i < n; i = i + 1) { use(xs[i]); }` pattern to walk an array.
The [SDL demo](../../examples/playground/sdl_demo/main.yoop) is the canonical
case - three nearly-identical 8-line `for` blocks for three balls, with a
running comment apologizing for the lack of `for ball in balls`. This phase
adds the form for arrays and retires the boilerplate.

## What landed

- New token `in` (keyword) and AST kind `FOR_IN_LOOP { loopVar, iterExpr, body }`.
- Parser dispatch on `for`: `for (` → classic `FOR_LOOP`, `for IDENT in` → new
  `FOR_IN_LOOP`. One token of lookahead is enough; the disambiguator never
  ambiguates because `(` cannot start an identifier and `in` is a fresh
  keyword. See [parseForStatement / parseForInStatement](../../src/jsyooparser/parser.js).
- Typechecker resolves `iterExpr`, requires it to be an array (`T[]`) and
  binds the loop variable as a `const` of element type `T` inside a fresh
  body scope. Non-array RHS produces a clear error.
- Kind-flow analysis treats the body like `WHILE_STATEMENT` /
  classic `FOR_LOOP`: the body may execute zero times, so any sat-state
  changes inside are discarded at the merge point.
- Codegen lowers to a fat-pointer walk: evaluate the iterable once, cache
  `ptr` and `len`, allocate a hidden i64 counter, copy each element into the
  loop variable's slot at the top of the body. Lives in both the single-module
  ([codegen.js → emitForInLoop](../../src/jsyoopcodegen/codegen.js)) and the
  multi-module (`emitForInLoopStmt`) paths. No new runtime support.

## Verification

- Parser tests: [parser.test.js](../../src/jsyooparser/parser.test.js) under
  *"Phase 9.D: for ... in loop"* - shape of the new node, classic-form
  regression, arbitrary-expression RHS.
- E2E pass: [examples/pass/forin_basic.yoop](../../examples/pass/forin_basic.yoop)
  walks `int32[]`, `bool[]`, and a struct array, plus exercises `break` /
  `continue` and empty-array semantics.
- E2E fail: [examples/fail/forin_non_array.yoop](../../examples/fail/forin_non_array.yoop)
  asserts the "currently requires an array" diagnostic.
- Full test suite green (555 tests).

## Deferred

- **`Iterable<T>` trait + `IterStep<T>` enum in `std/core/traits.yoop`.**
  The plan calls for them, but generic enums (`enum IterStep<T> { ... }`)
  are still rejected by the typechecker - the parser parses the type
  parameter list and then immediately errors with *"generic enums are not
  yet supported (deferred)"*. Lifting that deferral is a prerequisite for
  the trait-form, which doesn't carry its weight until non-array iterables
  exist anyway. Tracked under future Phase 9 follow-ups.
- **Trait-driven iteration over user types.** Once generic enums are in,
  the typechecker can look for an `Iterable<U>` impl on the RHS when the
  RHS is not an array, and the codegen can lower to a `while/switch` over
  `Iterable.next(ref it)`. The current AST + typecheck slot
  (`resolvedElemType` / `resolvedIterType`) is the natural attach point.
- **Strategy traits** (`xs.batched(n)`, `xs.parallel()`, `xs.simd(n)`)
  - explicitly deferred by the plan; same AST overlays cleanly when added.
- **`for ref ball in balls`** - yielding by reference so the body can
  mutate in place. The current form copies each element into a fresh
  loop-var slot. The plan defers this to the strategy-trait phase.

## Known limitation (pre-existing, not new in 9.D)

The loop variable's storage uses the LET_DECL naming convention
(`%<name>` LLVM SSA local). Two `for x in ...` loops in the same function
collide at link time with `multiple definition of local value named 'x'`
- the same collision two sibling `let x` declarations have always hit.
Fixing this needs a per-binding slot-pointer map at codegen time and is a
language-wide cleanup, not in scope for 9.D. Workaround: rename the loop
variable per call site (e.g. `for ball in balls`, then `for b in bullets`).

## Files touched

- [src/jsyooplexer/lexer.js](../../src/jsyooplexer/lexer.js) - `in` keyword.
- [src/contracts.js](../../src/contracts.js) - `FOR_IN_LOOP` AST kind.
- [src/jsyooparser/parser.js](../../src/jsyooparser/parser.js) - dispatch +
  `parseForInStatement`.
- [src/jsyooptypecheck/checkStatement.js](../../src/jsyooptypecheck/checkStatement.js)
  - `checkForInLoop`.
- [src/jsyooptypecheck/kindCheck.js](../../src/jsyooptypecheck/kindCheck.js)
  - branch handling parallels `FOR_LOOP`.
- [src/jsyoopcodegen/codegen.js](../../src/jsyoopcodegen/codegen.js) -
  `emitForInLoop` (single-module) + `emitForInLoopStmt` (multi-module).
- [SPEC.md](../../SPEC.md) §9 - v0 status note added.
- [examples/pass/forin_basic.yoop](../../examples/pass/forin_basic.yoop),
  [examples/fail/forin_non_array.yoop](../../examples/fail/forin_non_array.yoop),
  [src/e2e.test.js](../../src/e2e.test.js),
  [src/jsyooparser/parser.test.js](../../src/jsyooparser/parser.test.js)
  - tests and fixtures.
