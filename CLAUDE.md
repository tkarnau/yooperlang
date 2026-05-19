# Yooperlang — Claude working notes

A JS-implemented compiler for the Yooperlang language. Emits LLVM IR text, shells out to `clang` to link and produce an executable. Language spec in [SPEC.md](SPEC.md); phase-by-phase build plan in [plans/roadmap.md](plans/roadmap.md). Currently mid Phase 6 (kinds), with Phase 7 (generics, pattern matching) next.

Pipeline: source `.yoop` → **lex** → **parse** → **typecheck** → **codegen** (LLVM IR) → `clang` → executable.

## Run / test

- `npm test` — all tests (unit + e2e)
- `npm run test:unit` — fast, no clang
- `npm run test:e2e` — full pipeline, requires `clang` on PATH
- Driver entry: [src/yoopiler.js](src/yoopiler.js). End-user invocation is `yoopiler <entry.yoop>`; the entry file pulls in everything else via its imports.

## Subsystem map

### [src/jsyooplexer/](src/jsyooplexer/) — lexing (~630 lines)
- Public entry: `tokenize(src) → Token[]` at [lexer.js:406](src/jsyooplexer/lexer.js#L406). Throws on first lex error.
- Single-token form: `lexNext(src, pos)` at [lexer.js:334](src/jsyooplexer/lexer.js#L334).
- Token shape: `{ tag, start, length, intVal?, floatVal? }`. `start`+`length` are character offsets into `src` — extract text via `src.substring(start, start + length)`.
- `TokenTags` enum and `keywordTagList` map live in [lexer.js](src/jsyooplexer/lexer.js). Character predicates in [charFns.js](src/jsyooplexer/charFns.js); whitespace + nestable block comments in [charEaters.js](src/jsyooplexer/charEaters.js).
- Numeric literals support underscore separators (validated: must be between digits) and `0x`/`0b`/`0o` bases. Block comments nest. Template literals (backticks) are returned raw; `${...}` interpolation is parsed later in the parser.

### [src/jsyooparser/](src/jsyooparser/) — parsing (~1,900 lines)
- Public entry: `parse(src) → ASTNode` (PROGRAM root) at [parser.js:79](src/jsyooparser/parser.js#L79). Throws via `parseError` with line/column/caret; one error aborts the whole parse.
- Recursive descent with Pratt-style precedence climbing for binary ops. Precedence table at [parser.js:52](src/jsyooparser/parser.js#L52); climbing loop in `parseExpression(minPrecedence)`.
- Parser state (`pos`, `current`) is closure-scoped inside `parse()`. No resumability. Helpers: `advance`, `peek`, `peekAhead(n)` (re-lexes, no cache — keep lookahead shallow; existing max is 3 tokens for kind-prefixed bindings).
- Every node is created via `buildSourcedNode(ASTNodeKind.X)` at [parser.js:218](src/jsyooparser/parser.js#L218) so `sourceLoc` is set — downstream error reporting depends on this.
- Deferred-feature pattern: keywords reserved for later phases (e.g. `provides`, `restricts`) lex as plain identifiers and the parser emits an explicit "not yet supported" message if they appear in a clause. Mirror this when reserving anything new.

### [src/jsyooptypecheck/](src/jsyooptypecheck/) — type system (~3,900 lines across ~12 files)
- Orchestration in [typecheck.js](src/jsyooptypecheck/typecheck.js) — passes A (declarations), B (signatures), C (bodies + kind resolution).
- Types in [types.js](src/jsyooptypecheck/types.js): `PrimType`, `StructType`, `RefType`, `ArrayType`, `FuncType`, `KindType`, `KindApplication`, `TaskType`. Also `untypedInt`/`untypedFloat` literal placeholders and `error`/`namespace`.
- Per-node dispatchers (recursive on `node.kind`, not visitor): expressions in [checkExpr.js](src/jsyooptypecheck/checkExpr.js) (`resolveExprType`, `checkInitializer`); statements + function bodies in [checkStatement.js](src/jsyooptypecheck/checkStatement.js).
- Kind flow analysis (mustCall obligations, escape analysis, propagation) in [kindCheck.js](src/jsyooptypecheck/kindCheck.js).
- Coercion rules in [coerce.js](src/jsyooptypecheck/coerce.js) (`isAssignable`, `unifyArith`, literal pinning). Lexical scope chain in [scope.js](src/jsyooptypecheck/scope.js). Errors accumulated via `pushError` in [errors.js](src/jsyooptypecheck/errors.js) (not thrown). Fallible (`err`-bearing) binding tracking in [fallible.js](src/jsyooptypecheck/fallible.js). Builtin kinds (`joined`, `pooled`, `Task`) in [builtinKinds.js](src/jsyooptypecheck/builtinKinds.js). Cross-module symbol resolution in [imports.js](src/jsyooptypecheck/imports.js).

### [src/jsyoopcodegen/](src/jsyoopcodegen/) — LLVM IR emission (~2,800 lines)
- Public entries:
  - `compileEntry(absPath)` at [codegen.js:2811](src/jsyoopcodegen/codegen.js#L2811) — full pipeline from entry file.
  - `codegenProgram(modules)` at [codegen.js:1526](src/jsyoopcodegen/codegen.js#L1526) — multi-module IR from already-typechecked modules.
  - `codegen(ast)` at [codegen.js:215](src/jsyoopcodegen/codegen.js#L215) — single-module (legacy / tests).
- Single-pass AST → LLVM IR text. No intermediate IR, no optimization. Dispatchers: `emitStatement`, `emitExpr`, `emitCall`, `emitLvalue`. Temp + label counters reset per function.
- Emits to `/tmp/yooper_out.ll` and shells out to `clang` with link flags from [src/runtimeBuild.js](src/runtimeBuild.js).
- Multi-module symbol mangling: `<moduleId>__<symbolName>`. Internal to codegen; doesn't appear in user source.

### [src/jsyoopdriver/](src/jsyoopdriver/) — driver (~80 lines)
- [moduleGraph.js](src/jsyoopdriver/moduleGraph.js) walks imports from the entry file, detects cycles, returns a topologically ordered list of modules for typecheck + codegen.
- [moduleId.js](src/jsyoopdriver/moduleId.js) — stable per-module id derivation (used for mangling).

## Shared contracts

- [src/contracts.js](src/contracts.js) — `ASTNodeKind` enum (40+ kinds) and `ASTNode` constructor. Every AST consumer depends on these names; renaming a kind is a whole-pipeline change.
- [src/helpers.js](src/helpers.js) — `posToSourceLocation` and related utilities.
- [src/runtimeBuild.js](src/runtimeBuild.js) — path to the C runtime (under [runtime/](runtime/)) and the clang link flags codegen needs.

## Cross-cutting invariants

The things that aren't obvious from reading any single file — read this section before editing across stages.

- **Codegen requires `node.resolvedType` on every node.** Codegen does zero type-checking. If you add an AST kind, the typechecker must set `.resolvedType` on it before codegen sees it, or codegen will crash or emit wrong IR.
- **Types are immutable (`Object.freeze`'d) — except `KindType`.** `KindType` mutates during pass C.2 to fill in resolved clause details. Don't freeze it; do treat every other type object as immutable.
- **Struct literals can't be typed standalone.** A bare `Foo { x: 1 }` returns an error from `resolveExprType`. Struct literals must be pinned to a target type via `checkInitializer` (assignment RHS, return value, call argument, etc.).
- **Two unrelated meanings of "kind" on a binding.** `binding.kind` = mutability (`"let"` / `"const"` / `"discard"`). `binding.kindType` = the Phase 6 user-defined kind declaration. Same word, orthogonal semantics.
- **Imported structs may be shells mid-pass.** Pass A registers struct types with `fields: null`; pass C fills them in. Don't assume a `StructType` from an imported module is fully populated before pass C completes.
- **Fallible `err` fields unobserved at scope exit are compile errors, not warnings.** Enforced in `popScope` via [fallible.js](src/jsyooptypecheck/fallible.js). Adding a new way to produce a fallible value means making sure `err` observation is tracked.
- **Error control flow differs by stage.** Lexer + parser throw and abort on first error. Typechecker accumulates into an `errors` array. Codegen assumes a clean AST and will crash on malformed input.
- **Source locations on every AST node are load-bearing.** Diagnostics rely on `node.sourceLoc` being set. Use `buildSourcedNode` (parser) or copy `sourceLoc` when synthesizing nodes elsewhere.

## Phase model

Features land phase-by-phase per [plans/roadmap.md](plans/roadmap.md). Currently mid Phase 6.5; recent landings include `propagates` (6.4), kind composition with `&`, and `layout { align ... }` (6.5).

Code is annotated with phase comments (e.g. `// 6.5:`, `// phase 6.4:`). Treat these as load-bearing — they mark the version a piece of logic became correct and help future readers locate the spec section.

## Test conventions

- Node's native test runner (`node --test`), style `describe` / `it` with `node:assert/strict`.
- Unit tests colocated as `<file>.test.js` next to source.
- [src/e2e.test.js](src/e2e.test.js) is the full lex → parse → typecheck → codegen → `clang` → run integration suite. Expensive but authoritative — when in doubt about whether a change works end-to-end, add a small fixture there.
