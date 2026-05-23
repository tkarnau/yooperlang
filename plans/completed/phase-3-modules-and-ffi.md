# Phase 3 — Modules and FFI

Part of the [roadmap](./roadmap.md). Phase 1 landed structs and a real type system; phase 2 landed errors-as-values. Up to now the compiler has been single-file and printf has been a hardcoded built-in. This phase delivers the "program defines itself" story from [SPEC.md §1](../SPEC.md) and [§12](../SPEC.md): the entry file pulls in everything else through `import`, and FFI declarations (`extern "C" from "stdio.h"` etc.) replace the printf hack and let the program declare its link flags inline. After this phase, real programs that need to call C functions through their headers will work end-to-end with no driver-side knowledge of the C library.

## Goal

Land a working subset of [SPEC.md §1 — Files, modules, imports, exports](../SPEC.md) and [§12 — Foreign interop](../SPEC.md):

```yoop
// math.yoop
export function square(x: int32): int32 {
    return x * x;
}

export const TWO_PI: float64 = 6.283185307;
```

```yoop
// io.yoop
extern "C" from "stdio.h" {
    function printf(fmt: string, ...): int32;
    function puts(s: string): int32;
}

extern "C" from library "m" {
    function cos(x: float64): float64;
}

export function greet(name: string): int32 {
    return puts(name);
}
```

```yoop
// main.yoop
import { square, TWO_PI } from "./math.yoop";
import * as io from "./io.yoop";
import "./init.yoop";                   // side-effect-only

function main(): int32 {
    io.greet("hello");
    printf(`9 squared is ${square(3)}\n`);
    printf(`2pi = ${TWO_PI}\n`);
    return 0;
}
```

`yoopiler main.yoop` walks `main.yoop`, transitively loads `math.yoop`, `io.yoop`, and `init.yoop`, links the produced `.ll` against `-lm`, and produces an executable that prints the expected output. Concretely:

- A module is a `.yoop` file. Imports are relative-path strings ending in `.yoop`.
- `import { a, b as c } from "./x.yoop"` brings names in by binding (`b` is locally available as `c`).
- `import * as ns from "./x.yoop"` exposes the module under a single namespace identifier.
- `import "./x.yoop";` runs the module's top-level decls without binding anything.
- `export` may prefix any top-level decl (`export function`, `export const`, `export type`). Unprefixed decls are private to the module.
- `extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; type FILE; }` declares C symbols as if they were yooperlang functions/types — the typechecker treats them as in-scope module-level symbols, and codegen emits the matching `declare` lines.
- `extern "C" from library "m" { ... }` does the same and adds `-lm` to the clang link line.
- `export "C" function on_tick(ms: int32): int32 { ... }` emits an unmangled C-ABI symbol.
- The compiler refuses cycles between modules (a → b → a), missing imports, missing exports, name collisions across imports, and `?` / observation rules continue to work across module boundaries unchanged.

## Why this is next

Errors as values in phase 2 use the convention "fallible struct", but the structs that real programs care about — `Bytes` from `read_all`, `Config` from `parse_toml`, etc. — live in libraries and call into C through `fopen` / `fread` / `fclose` etc. Without imports, every program is a single file; without externs, every C function has to be hardcoded into codegen the way printf is today. Both ceilings hit the same way: you can write toy fallible programs but you can't write a real one.

This phase also unlocks the JAI/nob.h-style "no manifest, no flags" model from the roadmap. Once a `.yoop` file can declare its own link flags via `extern "C" from library "m"`, the driver's CLI can stay at exactly one positional argument — the entry file — through phase 6 at least. That property is worth investing in early because every later phase will sit on top of it.

Phase 3 has no hard dependency on phase 2 (errors don't need imports), but they were ordered this way because phase 2 is small and self-contained while phase 3 touches every layer of the compiler. Doing 2 first kept the foundation clean.

## Scope (what this phase does NOT do)

- **No re-exports.** `export { x } from "./other.yoop"` is reserved syntax in the spec; not in v0. Re-exporting is straightforward to add later but the cycle/visibility rules get fiddly, so defer.
- **No conditional / dynamic imports.** No `import.unsafe` (spec §12), no `if (...) import`. Imports are static, top-of-file, syntactically fixed.
- **No glob exports.** No `export *`. Every exported name is spelled out.
- **No package / project root resolution.** Imports resolve relative to the *importing file's directory*, not a project root or `node_modules`-style lookup. Absolute paths and `..` walks are allowed (the spec doesn't forbid them) but no search-path logic.
- **No `extern "Rust"` / `extern "Zig"`.** The grammar accepts them as reserved syntax (per spec §12) but the typechecker rejects with "only \"C\" externs are supported in v0".
- **No header parsing.** `extern "C" from "stdio.h" { ... }` doesn't read `stdio.h`. The block contents are the source of truth — yooper-style fn decls that the user writes by hand. The header path is only used as a documentation/grouping affordance for now (it might also drive `-include` flags in a later phase, but not yet).
- **No mangled-name override syntax.** The C interop functions inside an `extern "C"` block use their declared name verbatim as the LLVM symbol. There's no `extern "C" function printf as @my_printf`.
- **No type aliases inside extern blocks beyond opaque `type FILE;` shells.** `type FILE;` (no body) declares an opaque C type that yooper code can hold as `ref FILE` — but we have no `ref T` in the language until phase 4. So in this phase, opaque externs typecheck but you can't *use* a `ref FILE` value yet. The declaration itself works (round-trips through typecheck and codegen). Real consumption arrives with phase 4.
- **No diamond-dependency deduping bugs to chase down.** A diamond (a→b, a→c, b→d, c→d) loads `d` exactly once; this is the easy property. We do not handle the *multi-version diamond* (a wants d-v1, c wants d-v2) — there are no versions. The compiler just loads each unique absolute path once.
- **No incremental compilation.** Every `yoopiler` invocation reparses and retypechecks the full graph. Caching is a phase 7+ concern.
- **No C-ABI struct-passing rules.** `export "C" function` rejects functions that take or return struct values until phase 4 brings refs in. Primitive params + primitive return only.
- **No printf-format string validation across modules.** printf's variadic typing is what it was in phase 1 — codegen drives format specifiers from arg types. No new analysis here.

---

## Status snapshot

Nothing for phase 3 has been built yet. Phase 1 + 2 leave:

- Single-file compilation: `parse(src)` → `typecheck(ast)` → `codegen(ast)`.
- Driver ([yoopiler.js](../src/yoopiler.js)) reads one file, calls clang with no link flags.
- printf, fprintf, puts, exit, strlen are baked into [externDecl()](../src/jsyoopcodegen/codegen.js#L962) and [KNOWN_EXTERNS](../src/jsyooptypecheck/checkStatement.js#L47) respectively. Calling any other unknown name codegens to a stub `declare i32 @<name>(...)`.
- `parse()` only accepts `function` and `type` decls at the top level; everything else throws.
- Symbol resolution is one flat `moduleSymbols` map per parse — there's no concept of "another module".

Phase 3 reshapes the pipeline:

1. **Driver**: replace single-file read with a module graph walker. Returns `[Module]`.
2. **Lexer**: `import`, `export`, `extern`, `from`, `as`, `library`, plus the existing `*` (mult) doing double duty inside `import * as ns`.
3. **Parser**: top-level `import`, `export`, `extern "C" from "..."`, `export "C" function`. New AST kinds for each.
4. **Typechecker**: per-module symbol tables, import resolution, export verification, extern symbols routed into the same symbol table, namespace identifiers.
5. **Codegen**: emit one IR file from the merged graph. Mangle yooper-internal names with a module prefix; leave externs and `export "C"` symbols unmangled. Track link flags on a `linkFlags` set returned alongside the IR.
6. **Driver again**: receive `linkFlags` and pass to clang as `-l<name>` arguments.

---

## Files touched

- [src/contracts.js](../src/contracts.js) — new AST kinds: `IMPORT_DECL`, `EXPORT_DECL`, `EXTERN_BLOCK`, `EXTERN_FUNCTION_DECL`, `EXTERN_TYPE_DECL`, `EXPORT_C_FUNCTION_DECL`, `NAMESPACE_IDENT`.
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — `import`, `export`, `extern`, `from`, `as`, `library` keywords. `...` (rest token) for variadic externs.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — top-level dispatch grows: `parseImportDecl`, `parseExportDecl`, `parseExternBlock`, `parseExportCFunctionDecl`. Inside extern blocks: `parseExternFunctionDecl`, `parseExternTypeDecl`.
- New file `src/jsyoopdriver/moduleGraph.js` — `loadModuleGraph(entryPath)` walks imports, dedupes by canonical path, detects cycles. Returns `[Module]`.
- New file `src/jsyoopdriver/moduleId.js` — `moduleIdFor(absPath, repoRoot)` returns a stable, valid-LLVM-symbol identifier. Pure.
- [src/yoopiler.js](../src/yoopiler.js) — replace single-file flow with module-graph flow; thread `linkFlags` to clang.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) — new entry point `typecheckProgram(modules)`; per-module typecheck pass.
- New file `src/jsyooptypecheck/imports.js` — `resolveImports(module, allModules, errors)`: validates every import binds to a real export and returns a per-module symbol overlay.
- [src/jsyooptypecheck/scope.js](../src/jsyooptypecheck/scope.js) — extend bindings with `kind: "namespace"` so `lookupInScope` can return a namespace value.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) — extend `resolveFieldAccess` to handle namespace identifiers (`io.greet`).
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) — `NamespaceType { moduleId, exports }`. `resolveTypeFromName` learns to consult imported types via the per-module overlay.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — new entry point `codegenProgram(modules)`; mangling helper `mangle(moduleId, name)`; extern emit now sourced from the AST instead of `KNOWN_EXTERNS`. Track and return `linkFlags`.
- [src/e2e.test.js](../src/e2e.test.js) — new pass + fail fixtures (see §11).
- [examples/pass/](../examples/pass/) — multi-file fixtures land as directories: each fixture's entry is the `main.yoop` inside a folder.
- [examples/fail/](../examples/fail/) — single-file *or* directory fail fixtures with expected typecheck-error patterns.

---

## 1. AST node kinds ([contracts.js](../src/contracts.js))

Add:

```js
IMPORT_DECL: "IMPORT_DECL",
//   { kind: "named" | "namespace" | "side-effect",
//     specifiers: [{ exportName, localName, sourceLoc }],   // named only
//     namespaceName: string,                                 // namespace only
//     sourcePath: string,                                    // raw "./foo.yoop" string
//     resolvedAbsPath: string,                               // filled in by driver
//     resolvedModuleId: string,                              // filled in by driver
//     sourceLoc }

EXPORT_DECL: "EXPORT_DECL",
//   { decl: ASTNode (FUNCTION_DECL | TYPE_DECL | LET_DECL | CONST_DECL),
//     sourceLoc }

EXTERN_BLOCK: "EXTERN_BLOCK",
//   { abi: "C",
//     source: { kind: "header" | "library", value: string },
//     decls: [ EXTERN_FUNCTION_DECL | EXTERN_TYPE_DECL ],
//     sourceLoc }

EXTERN_FUNCTION_DECL: "EXTERN_FUNCTION_DECL",
//   { name, params: [PARAM], variadic: bool, returnType: string, sourceLoc }

EXTERN_TYPE_DECL: "EXTERN_TYPE_DECL",
//   { name, sourceLoc }              // opaque — no fields

EXPORT_C_FUNCTION_DECL: "EXPORT_C_FUNCTION_DECL",
//   { fn: FUNCTION_DECL, sourceLoc } // wraps a normal FUNCTION_DECL with the
//                                    // sole semantic effect of "don't mangle"

NAMESPACE_IDENT: "NAMESPACE_IDENT",
//   { name, moduleId, sourceLoc }    // produced by typechecker when an
//                                    // IDENT resolves to an `import * as ns`
//                                    // binding. Codegen sees this and routes
//                                    // FIELD_ACCESS off it specially.
```

Why each is a new kind, not a reuse:

- `IMPORT_DECL` and `EXPORT_DECL` are *declarations*, not statements. Reusing `LET_DECL` would mean carrying around `kind === "let"` plus side-fields that don't apply.
- `EXTERN_BLOCK` is a *grouped* container — it lifts the `from "stdio.h"` / `from library "m"` info up so codegen can attribute every contained extern back to a header/lib without re-walking. Modeling it as a flat list of externs would lose that grouping.
- `EXTERN_FUNCTION_DECL` could in principle be a `FUNCTION_DECL` with `body: null`, but the variadic flag (`...`) doesn't exist on yooper functions — only on externs. Plus codegen treats `EXTERN_FUNCTION_DECL` very differently (just emits `declare ...`, no body).
- `EXPORT_C_FUNCTION_DECL` wraps rather than flagging because the wrapper carries the codegen instruction "emit unmangled" without polluting `FUNCTION_DECL`'s shape.
- `NAMESPACE_IDENT` is *synthesized* by the typechecker when it sees `IDENT { name: "io" }` and the binding is a namespace. Keeping it distinct from `IDENT` lets codegen reject `io` in any context that's not the LHS of a `FIELD_ACCESS`.

---

## 2. Lexer changes ([lexer.js](../src/jsyooplexer/lexer.js))

Six new keywords, all context-sensitive:

```js
TokenTags.import:  41,
TokenTags.export:  42,
TokenTags.extern:  43,
TokenTags.from:    44,
TokenTags.as:      45,
TokenTags.library: 46,
TokenTags.dotdotdot: 47,    // for variadic externs
```

Add to `keywordTagList`:

```js
import: TokenTags.import,
export: TokenTags.export,
extern: TokenTags.extern,
from:   TokenTags.from,
as:     TokenTags.as,
library: TokenTags.library,
```

`...` to `tokenScanList`:

```js
{ str: "...", tag: TokenTags.dotdotdot },
```

The list re-sorts by length, so `...` lands before `.`. Verify with a unit test that `a...b` (which would never occur in real source but is a sanity check) lexes as three tokens, and that `a.b.c` still lexes as five tokens (no greedy `...` match across an identifier).

> **`library` as a keyword.** The spec lists "library" only inside `extern "C" from library "m"`. Making it a hard keyword would steal a perfectly good identifier name. The trade-off: contextual keywords need parser help. We make it a hard keyword for now (it's listed in the reserved-words table at SPEC §14 implicitly via `from`'s context — and the alternative is fragile). If users complain we can demote later by parsing `from <ident>` and special-casing `<ident>.value === "library"` in `parseExternBlock`. Not in v0.

> **`as` as a keyword.** Same trade-off; same decision. It's used in two places: `import { x as y }` and `import * as ns`. Both are syntactically distinguishable and `as` doesn't show up in expressions, so making it a keyword is safe.

> **`...` for variadic externs only.** The token is rejected by the parser everywhere except inside an `EXTERN_FUNCTION_DECL`'s param list. We don't have first-class variadics in yooper — printf is the only function that uses them and it's defined inside an extern block.

---

## 3. Parser changes ([parser.js](../src/jsyooparser/parser.js))

### 3.a Top-level dispatch

`parseTopLevel` ([parser.js:102-134](../src/jsyooparser/parser.js#L102-L134)) currently switches on `function` and `type`. Extend:

```js
case TokenTags.import:
  node.body.push(parseImportDecl());
  break;
case TokenTags.export:
  node.body.push(parseExportDecl());
  break;
case TokenTags.extern:
  node.body.push(parseExternBlock());
  break;
```

`parseExportDecl` looks at the next-next token:
- `export "C" function ...` → `parseExportCFunctionDecl()` (returns `EXPORT_C_FUNCTION_DECL`)
- `export function ...` → wrap a `parseFunctionDecl()` result in an `EXPORT_DECL`
- `export type ...` → wrap a `parseTypeDecl()` result
- `export const ...` / `export let ...` → wrap a `parseVarDecl()` result

> **Source ordering rule.** Spec §1 doesn't fix import position, but to keep the parser simple, **imports must precede all other top-level decls**. Mixing imports between functions parses cleanly enough today, but the typechecker assumes "imports are all collected up front" — see §5.b. Enforce in the parser: once we've seen any non-import top-level decl, an `import` keyword is a syntax error ("imports must come before other declarations").

### 3.b `parseImportDecl`

Three shapes, dispatched on what follows `import`:

```js
function parseImportDecl() {
  const node = buildSourcedNode(ASTNodeKind.IMPORT_DECL);
  expect(TokenTags.import);

  if (peek().tag === TokenTags.strLiteral) {
    // side-effect: import "./init.yoop";
    node.kind = "side-effect";
    const tok = advance();
    node.sourcePath = unquoteStringLiteral(src, tok);
    expect(TokenTags.semicolon);
    return node;
  }

  if (peek().tag === TokenTags.mult) {
    // namespace: import * as ns from "./mod.yoop";
    node.kind = "namespace";
    advance();                      // consume *
    expect(TokenTags.as);
    node.namespaceName = parseIdentAsName();
    expect(TokenTags.from);
    const tok = expect(TokenTags.strLiteral);
    node.sourcePath = unquoteStringLiteral(src, tok);
    expect(TokenTags.semicolon);
    return node;
  }

  if (peek().tag === TokenTags.lcurly) {
    // named: import { a, b as c } from "./mod.yoop";
    node.kind = "named";
    node.specifiers = [];
    advance();                      // consume {
    while (peek().tag === TokenTags.ident) {
      const exportTok = expect(TokenTags.ident);
      const exportName = src.substring(exportTok.start, exportTok.start + exportTok.length);
      let localName = exportName;
      if (peek().tag === TokenTags.as) {
        advance();
        localName = parseIdentAsName();
      }
      node.specifiers.push({
        exportName,
        localName,
        sourceLoc: posToSourceLocation(src, exportTok.start),
      });
      if (peek().tag === TokenTags.comma) advance();
    }
    expect(TokenTags.rcurly);
    expect(TokenTags.from);
    const tok = expect(TokenTags.strLiteral);
    node.sourcePath = unquoteStringLiteral(src, tok);
    expect(TokenTags.semicolon);
    return node;
  }

  throw new Error(`unexpected token after import: ${inverseTokenTags[peek().tag]}`);
}
```

Helper `unquoteStringLiteral(src, tok)` strips the surrounding `"` from a strLiteral token. Reuse-friendly — `parseExternBlock` needs it too.

### 3.c `parseExportDecl`

```js
function parseExportDecl() {
  const sourceLoc = posToSourceLocation(src, peek().start);
  expect(TokenTags.export);

  if (peek().tag === TokenTags.strLiteral) {
    // export "C" function ...
    const abiTok = advance();
    const abi = unquoteStringLiteral(src, abiTok);
    if (abi !== "C") {
      throw new Error(`unsupported export ABI "${abi}" — only "C" is supported`);
    }
    return parseExportCFunctionDecl(sourceLoc);
  }

  // wrapping form
  let inner;
  switch (peek().tag) {
    case TokenTags.function: inner = parseFunctionDecl(); break;
    case TokenTags.type:     inner = parseTypeDecl(); break;
    case TokenTags.let:
    case TokenTags.const:    inner = parseVarDecl(); break;
    default:
      throw new Error(`unexpected token after export: ${inverseTokenTags[peek().tag]}`);
  }
  const node = new ASTNode(ASTNodeKind.EXPORT_DECL, sourceLoc);
  node.decl = inner;
  return node;
}

function parseExportCFunctionDecl(sourceLoc) {
  expect(TokenTags.function);
  const fn = parseFunctionDeclBody();   // refactor: parseFunctionDecl minus the
                                        // leading `function` token
  const node = new ASTNode(ASTNodeKind.EXPORT_C_FUNCTION_DECL, sourceLoc);
  node.fn = fn;
  return node;
}
```

### 3.d `parseExternBlock`

```js
function parseExternBlock() {
  const node = buildSourcedNode(ASTNodeKind.EXTERN_BLOCK);
  expect(TokenTags.extern);
  const abiTok = expect(TokenTags.strLiteral);
  node.abi = unquoteStringLiteral(src, abiTok);
  if (node.abi !== "C") {
    throw new Error(`unsupported extern ABI "${node.abi}" — only "C" is supported in v0`);
  }
  expect(TokenTags.from);
  if (peek().tag === TokenTags.library) {
    advance();
    const tok = expect(TokenTags.strLiteral);
    node.source = { kind: "library", value: unquoteStringLiteral(src, tok) };
  } else {
    const tok = expect(TokenTags.strLiteral);
    node.source = { kind: "header", value: unquoteStringLiteral(src, tok) };
  }
  expect(TokenTags.lcurly);
  node.decls = [];
  while (peek().tag !== TokenTags.rcurly && peek().tag !== TokenTags.eof) {
    if (peek().tag === TokenTags.function) node.decls.push(parseExternFunctionDecl());
    else if (peek().tag === TokenTags.type) node.decls.push(parseExternTypeDecl());
    else throw new Error(`unexpected token in extern block: ${inverseTokenTags[peek().tag]}`);
  }
  expect(TokenTags.rcurly);
  return node;
}

function parseExternFunctionDecl() {
  const node = buildSourcedNode(ASTNodeKind.EXTERN_FUNCTION_DECL);
  expect(TokenTags.function);
  node.name = parseIdentAsName();
  expect(TokenTags.lparen);
  node.params = [];
  node.variadic = false;
  while (peek().tag !== TokenTags.rparen) {
    if (peek().tag === TokenTags.dotdotdot) {
      advance();
      node.variadic = true;
      break;        // ... must be the last token before )
    }
    node.params.push(parseFunctionParam());
    if (peek().tag === TokenTags.comma) advance();
  }
  expect(TokenTags.rparen);
  expect(TokenTags.colon);
  node.returnType = parseIdentAsName();
  expect(TokenTags.semicolon);
  return node;
}

function parseExternTypeDecl() {
  const node = buildSourcedNode(ASTNodeKind.EXTERN_TYPE_DECL);
  expect(TokenTags.type);
  node.name = parseIdentAsName();
  expect(TokenTags.semicolon);
  return node;
}
```

### 3.e Test cases the parser must accept

Add to [parser.test.js](../src/jsyooparser/parser.test.js):

- `import "./init.yoop";` → `IMPORT_DECL { kind: "side-effect", sourcePath: "./init.yoop" }`
- `import * as io from "./io.yoop";` → `IMPORT_DECL { kind: "namespace", namespaceName: "io" }`
- `import { a, b as c } from "./m.yoop";` → 2 specifiers, second has `localName !== exportName`
- `export function foo(): int32 { return 0; }` → `EXPORT_DECL { decl: FUNCTION_DECL }`
- `export "C" function on_tick(ms: int32): int32 { return ms; }` → `EXPORT_C_FUNCTION_DECL`
- `extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }` → variadic flag set
- `extern "C" from library "m" { function cos(x: float64): float64; }` → `source.kind === "library"`
- `extern "C" from "stdio.h" { type FILE; }` → `EXTERN_TYPE_DECL { name: "FILE" }`

### 3.f Test cases the parser must reject

- `import { x } from "./m.yoop"` (missing semicolon) → parse error
- `function f(): int32 {}\nimport ...` (import after non-import top-level) → "imports must come before other declarations"
- `extern "Rust" from "..."` → "unsupported extern ABI \"Rust\""
- `import * from "./m.yoop";` (missing `as` clause) → parse error
- `extern "C" from library "m" { function f(...): int32; }` (variadic with no preceding params) — actually allowed (printf-shape). Make sure this parses without throwing.

---

## 4. Driver — module graph walker (`src/jsyoopdriver/moduleGraph.js`, new file)

The shape:

```js
// Module
//   id: string                  // "main", "math__a8c1", etc — see moduleId.js
//   absPath: string             // canonicalized via fs.realpathSync
//   sourcePath: string          // as the user typed it (only for the entry)
//   src: string                 // file contents
//   ast: ProgramNode            // from parse()
//   imports: [resolved IMPORT_DECL]   // .resolvedAbsPath / .resolvedModuleId set
//
// Returned shape
//   { entry: Module, modules: [Module] (topo-sorted, leaves first) }
```

Algorithm:

```js
function loadModuleGraph(entryAbsPath) {
  const byPath = new Map();         // absPath -> Module
  const onStack = new Set();         // absPath in current DFS path (cycle detection)
  const order = [];                  // post-order — leaves first
  loadOne(entryAbsPath);
  return { entry: byPath.get(entryAbsPath), modules: order };

  function loadOne(absPath) {
    if (byPath.has(absPath)) return byPath.get(absPath);
    if (onStack.has(absPath)) throw new Error(`import cycle detected involving ${absPath}`);
    onStack.add(absPath);

    const src = fs.readFileSync(absPath, "utf8");
    const ast = parse(src);
    const id = moduleIdFor(absPath);
    const mod = { id, absPath, src, ast, imports: [] };
    byPath.set(absPath, mod);

    for (const decl of ast.body) {
      if (decl.kind !== ASTNodeKind.IMPORT_DECL) continue;
      if (!decl.sourcePath.endsWith(".yoop")) {
        throw new Error(`import path "${decl.sourcePath}" must end in .yoop`);
      }
      if (!decl.sourcePath.startsWith("./") && !decl.sourcePath.startsWith("../")
          && !path.isAbsolute(decl.sourcePath)) {
        throw new Error(`import path "${decl.sourcePath}" must be relative or absolute`);
      }
      const resolvedAbs = fs.realpathSync(path.resolve(path.dirname(absPath), decl.sourcePath));
      decl.resolvedAbsPath = resolvedAbs;
      const child = loadOne(resolvedAbs);
      decl.resolvedModuleId = child.id;
      mod.imports.push(decl);
    }

    onStack.delete(absPath);
    order.push(mod);
    return mod;
  }
}
```

Notes:
- **Cycle policy**: hard error in v0. Programs that need cycles can split shared declarations into a third module. The error is "import cycle detected" with the ring of paths reported. (Mutual recursion *within* a single module already works because typecheck pre-passes function signatures before bodies.)
- **Path canonicalization** uses `fs.realpathSync` so `./foo.yoop` and `./bar/../foo.yoop` dedupe correctly. Casing on macOS / Windows is the OS's call.
- **Topological order** of returned `modules` is leaves-first, which is the order codegen wants (so a module's emitted IR can reference the symbols of any module it imports).
- **Errors during walk** throw immediately; there's no error-collection mode here. Users get one error message and a stack — typecheck-error collection comes later, after the graph is loaded.

### 4.a `moduleIdFor(absPath)` (`src/jsyoopdriver/moduleId.js`, new file)

Each module needs a stable, valid-as-LLVM-symbol identifier for name mangling. Use the file's basename plus a short hash of the absolute path:

```js
import crypto from "node:crypto";
import path from "node:path";

export function moduleIdFor(absPath) {
  const base = path.basename(absPath, ".yoop")
    .replace(/[^a-zA-Z0-9_]/g, "_");
  const hash = crypto.createHash("sha1").update(absPath).digest("hex").slice(0, 8);
  return `${base}_${hash}`;
}
```

`hello.yoop` at `/Users/x/proj/hello.yoop` → `hello_a8c1f203`. Stable per-path, distinct across paths, valid LLVM identifier characters.

> **Why not just basename?** Two files named `utils.yoop` in different folders need distinct module IDs.
> **Why not just the hash?** Helpful to read the IR with the source name in mangled symbols.

### 4.b Wiring into `yoopiler.js`

Replace the single-file flow:

```js
import { loadModuleGraph } from "./jsyoopdriver/moduleGraph.js";
import { typecheckProgram } from "./jsyooptypecheck/typecheck.js";
import { codegenProgram } from "./jsyoopcodegen/codegen.js";

const entryAbs = fs.realpathSync(path.resolve(inputFile));
const { modules } = loadModuleGraph(entryAbs);

const { errors } = typecheckProgram(modules);
if (errors.length > 0) { /* report and exit */ }

const { ir, linkFlags } = codegenProgram(modules);

// ... write to tmp .ll, then:
const clangArgs = [tmpIR, "-o", outputFileName, ...linkFlags.map(f => `-l${f}`)];
execFileSync(clangArg0, clangArgs, { stdio: "inherit" });
```

Existing single-file callers (`compileSource`, `typecheckSource`) remain — they wrap a fake one-module graph for unit-test convenience.

---

## 5. Typechecker — module-aware ([typecheck.js](../src/jsyooptypecheck/typecheck.js))

### 5.a Surface

New entry:

```js
export function typecheckProgram(modules) {
  const errors = [];
  const moduleEnv = new Map();   // moduleId -> { localSymbols, structTable, exports, importedNames }

  // pass A: per-module shells (struct shells, function sigs, exported names)
  for (const mod of modules) collectModuleShells(mod, moduleEnv, errors);

  // pass B: struct fields, extern symbols
  for (const mod of modules) resolveStructFields(mod, moduleEnv, errors);

  // pass C: import resolution — wire imported names into each module's overlay
  for (const mod of modules) resolveImports(mod, moduleEnv, errors);

  // pass D: function bodies (typechecked against each module's local + imported overlay)
  for (const mod of modules) checkBodies(mod, moduleEnv, errors);

  return { modules, errors, moduleEnv };
}
```

The existing `typecheck(ast)` becomes a thin wrapper:

```js
export function typecheck(ast) {
  // legacy single-module path used by tests and intra-module repls
  const fakeMod = { id: "main", ast, imports: [] };
  const r = typecheckProgram([fakeMod]);
  return { ast, errors: r.errors };
}
```

### 5.b Per-module symbol table — `moduleEnv.get(id)`

```js
{
  localSymbols: Map<name, FuncType | ConstBinding | NamespaceType>,
  structTable: Map<name, StructType>,
  exports: Set<name>,                 // names that may appear in another module's import
  importedNames: Map<localName, { fromModuleId, exportName, kind: "value" | "type" | "namespace" }>,
  externs: [{ name, source, params, returnType, variadic }],     // collected from EXTERN_BLOCKs
  linkLibraries: Set<libName>,        // populated from `extern "C" from library "m"`
}
```

Why per-module:
- Two modules can both define `function helper()` privately. Without per-module tables they'd collide.
- A module's `import { x }` must resolve to a specific other module's exports — not "every module's exports".

### 5.c Pass A: shells

For each module, walk `mod.ast.body`:
- `FUNCTION_DECL` → `localSymbols.set(name, FuncType-shell)` (params/return resolved in pass C since types may be imported)
- `TYPE_DECL` → `structTable.set(name, StructType-shell)`
- `EXPORT_DECL { decl }` → recurse on `decl`, then `exports.add(decl.name)`
- `EXPORT_C_FUNCTION_DECL { fn }` → register `fn.name` as a normal function in `localSymbols` *and* mark it C-ABI for codegen (set a flag on the AST node). Also `exports.add(fn.name)`. C-ABI exports are visible to other modules via normal `import`.
- `EXTERN_BLOCK` → for each contained `EXTERN_FUNCTION_DECL`, register in `localSymbols` as a `FuncType` with the variadic flag carried separately. Each extern is module-private (other modules must declare their own externs *or* the extern's owner exports a yooper wrapper). For each `EXTERN_TYPE_DECL`, register in `structTable` as an opaque `StructType` (no fields). For library externs, `linkLibraries.add(source.value)`.
- `IMPORT_DECL` → store on `mod.imports` (already there from pass A in driver), and pre-register each `localName` in `importedNames` with placeholder values resolved in pass C.

### 5.d Pass B: struct fields + extern resolution

Same as the current `typecheck.js` pass-2 logic, except `resolveTypeFromName` now consults *both* the current module's local `structTable` *and* `importedNames` for type imports. A new helper:

```js
function resolveTypeNameInModule(name, mod, moduleEnv) {
  const local = mod.structTable.get(name);
  if (local) return local;
  const prim = primTypeFromName(name);
  if (prim) return prim;
  const imported = mod.importedNames.get(name);
  if (imported && imported.kind === "type") {
    const sourceMod = moduleEnv.get(imported.fromModuleId);
    return sourceMod.structTable.get(imported.exportName) ?? null;
  }
  return null;
}
```

**Edge**: `import { Foo } from "./x.yoop"` where `Foo` is a struct name; `import * as ns; ns.Foo` is *not* valid as a type annotation in this phase (would require parser support for `ns.Foo` in type-name position). Stick with named imports for types.

### 5.e Pass C: import resolution (`src/jsyooptypecheck/imports.js`, new file)

For each `IMPORT_DECL` on the module:

```js
function resolveImports(mod, moduleEnv, errors) {
  for (const imp of mod.ast.body) {
    if (imp.kind !== ASTNodeKind.IMPORT_DECL) break;     // imports-first rule
    const sourceMod = moduleEnv.get(imp.resolvedModuleId);
    if (!sourceMod) {
      pushError(errors, imp, `internal: module ${imp.resolvedModuleId} not loaded`);
      continue;
    }

    if (imp.kind === "side-effect") continue;            // nothing to bind

    if (imp.kind === "namespace") {
      // Bind imp.namespaceName to a NamespaceType on the local symbol table.
      mod.localSymbols.set(imp.namespaceName, NamespaceType(sourceMod.id, sourceMod.exports));
      continue;
    }

    // named
    for (const spec of imp.specifiers) {
      if (!sourceMod.exports.has(spec.exportName)) {
        pushError(errors, imp, `module "${imp.sourcePath}" has no export "${spec.exportName}"`);
        continue;
      }
      // Look up what kind of symbol it is.
      const sourceSym = sourceMod.localSymbols.get(spec.exportName)
        ?? sourceMod.structTable.get(spec.exportName);
      if (!sourceSym) {
        pushError(errors, imp, `internal: export "${spec.exportName}" not found in module ${sourceMod.id}`);
        continue;
      }
      if (mod.localSymbols.has(spec.localName) || mod.structTable.has(spec.localName)) {
        pushError(errors, imp, `local name "${spec.localName}" collides with an existing declaration`);
        continue;
      }
      // Decide kind: structs go into structTable; everything else into localSymbols.
      if (sourceSym.kind === typeKinds.struct) {
        mod.structTable.set(spec.localName, sourceSym);
        mod.importedNames.set(spec.localName, { fromModuleId: sourceMod.id, exportName: spec.exportName, kind: "type" });
      } else {
        mod.localSymbols.set(spec.localName, sourceSym);
        mod.importedNames.set(spec.localName, { fromModuleId: sourceMod.id, exportName: spec.exportName, kind: "value" });
      }
    }
  }
}
```

Notes:
- Importing a struct *type* makes the local name available both as a type (annotation) and at runtime — but yooper has no type-as-value, so only the annotation use matters.
- Importing a `function` makes its `FuncType` visible to call resolution but doesn't import any private symbols transitively. No re-export.
- Renaming (`as`) only affects local lookup; the source module sees no difference.

### 5.f Namespace identifiers in expression position ([checkExpr.js](../src/jsyooptypecheck/checkExpr.js))

When `resolveIdent` finds a binding of kind `NamespaceType`, instead of returning the namespace as a value (yooper has no first-class namespaces), set the AST node's kind to `NAMESPACE_IDENT` and return a sentinel `NamespaceType`. Then `resolveFieldAccess` learns to handle a `NAMESPACE_IDENT` LHS:

```js
function resolveFieldAccess(node, scope, ctx) {
  if (node.object.kind === ASTNodeKind.NAMESPACE_IDENT) {
    const ns = lookupInScope(scope, node.object.name).type;     // NamespaceType
    if (!ns.exports.has(node.field)) {
      pushError(ctx.errors, node, `namespace "${node.object.name}" has no export "${node.field}"`);
      return setType(node, ErrorType());
    }
    const sourceMod = ctx.typeContext.moduleEnv.get(ns.moduleId);
    const sym = sourceMod.localSymbols.get(node.field) ?? sourceMod.structTable.get(node.field);
    // Mark the FIELD_ACCESS as a namespace lookup so codegen routes it to a
    // direct call/global-load against the imported symbol instead of GEP.
    node.namespaceLookup = { moduleId: sourceMod.id, exportName: node.field };
    return setType(node, sym.kind === typeKinds.func ? sym : sym /* values + types alike */);
  }
  // ... existing struct-field logic unchanged
}
```

A `NAMESPACE_IDENT` outside a `FIELD_ACCESS` LHS is an error: "namespace identifier `io` cannot be used as a value — access a member with `io.<name>`".

### 5.g `resolveCall` updates

Currently `resolveCall` routes by `node.callee` (a string) into `KNOWN_EXTERNS`, then `moduleSymbols`. New logic:

1. If `node.callee` is a string and lives in the current module's `localSymbols`, use that.
2. If `node.callee` is a `FIELD_ACCESS` on a namespace, resolve through that.
3. If `node.callee` is in `importedNames` with kind `"value"`, use the source module's symbol.
4. If `node.callee` is one of the legacy `KNOWN_EXTERNS` (`puts`, `exit`) AND the current module has *no* explicit extern decl for that name, fall back to it. **This is a transitional kindness** — once stdlib-ish files exist, `KNOWN_EXTERNS` gets removed entirely. For phase 3 we keep the fallback so existing single-file fixtures don't break.

> **printf transition.** [SPEC.md §15](../SPEC.md) shows printf used freely without an extern import in many places. The transitional kindness above keeps the existing fixtures (which call `printf` directly) working: if `printf` is not declared, codegen falls back to the existing `extern declaration` emission. Once we have an `io.yoop` stdlib module the user can `import` from, we delete the fallback. That deletion is a follow-up, not part of phase 3 exit criteria.

### 5.h Variadic externs

Variadic flag travels on the FuncType (new field `variadic: bool`) and `resolveCall` skips arity / param-type checking past the declared params. printf's existing check at [codegen.js:569+](../src/jsyoopcodegen/codegen.js#L569) already drives format spec from arg types — that path is unchanged; the typechecker just stops policing it after the fixed args. (Currently the typechecker doesn't policed printf at all — it's special-cased in codegen. With variadic externs the typechecker validates the *fixed* prefix and walks arg types but emits no errors for variadic tail.)

### 5.i Mutating `validateFunction`

The `ctx` passed into `validateFunction` already carries `typeContext`. Add `moduleEnv` and `currentModule` to it. The interior helpers (`resolveIdent`, `resolveCall`, `resolveTypeFromName`-callers in `checkLetOrConst` etc.) consult `currentModule`'s tables, falling back to `moduleEnv` for cross-module lookups when necessary.

---

## 6. Codegen — multi-module ([codegen.js](../src/jsyoopcodegen/codegen.js))

### 6.a Surface

```js
export function codegenProgram(modules) {
  const lines = [];
  const globals = [];
  const structDefs = [];
  const externs = new Set();           // string -> "declare ..." line (deduped across modules)
  const linkFlags = new Set();          // library names

  for (const mod of modules) emitModule(mod, { lines, globals, structDefs, externs, linkFlags });

  // assemble final IR: structDefs, then globals, then externs, then function bodies
  return { ir: [...structDefs, ...globals, ...externs, ...lines].join("\n"), linkFlags: [...linkFlags] };
}
```

The legacy `codegen(ast)` becomes a thin wrapper that calls `codegenProgram([{ id: "main", ast, imports: [] }])` and returns just the IR string. Tests that import `codegen` keep working.

### 6.b Symbol mangling

```js
function mangle(moduleId, localName) {
  return `${moduleId}__${localName}`;
}
```

`function square` in `math_a8c1f203.yoop` becomes `@math_a8c1f203__square` in IR.

Rules:
- Every yooper-internal function and global is mangled.
- Every `extern "C"` symbol is **NOT** mangled — it's whatever the user wrote (`@printf`, `@cos`, `@strlen`).
- Every `export "C" function` is **NOT** mangled — the user's name is the C ABI symbol.
- Every `import { x } from "./other.yoop"` call site emits `@<other_module_id>__x`.
- `import * as ns; ns.x()` → also `@<other_module_id>__x`.

The `functionSigs` map in codegen becomes per-module-aware. `emitCall` looks up the callee in `currentModule`'s symbol table to determine whether to mangle, and which moduleId to mangle with.

### 6.c Extern emission

Walk each module's `EXTERN_BLOCK`s and emit the LLVM `declare` lines:

```js
function emitExternDecls(mod, externs) {
  for (const decl of mod.ast.body) {
    if (decl.kind !== ASTNodeKind.EXTERN_BLOCK) continue;
    for (const ext of decl.decls) {
      if (ext.kind !== ASTNodeKind.EXTERN_FUNCTION_DECL) continue;
      const params = ext.params.map(p => llvmType(resolveTypeFromName(p.type, ...))).join(", ");
      const ret = llvmType(resolveTypeFromName(ext.returnType, ...));
      const sig = ext.variadic
        ? `declare ${ret} @${ext.name}(${params}${params ? ", " : ""}...)`
        : `declare ${ret} @${ext.name}(${params})`;
      externs.add(sig);
    }
  }
}
```

`KNOWN_EXTERNS` and the per-name lookup table at [codegen.js:962-971](../src/jsyoopcodegen/codegen.js#L962-L971) shrink dramatically — only the legacy printf-without-extern fallback remains. Eventually it goes away once an io.yoop stdlib module is in.

### 6.d Link flags

Walk `EXTERN_BLOCK`s with `source.kind === "library"`:

```js
for (const decl of mod.ast.body) {
  if (decl.kind === ASTNodeKind.EXTERN_BLOCK && decl.source.kind === "library") {
    linkFlags.add(decl.source.value);
  }
}
```

`linkFlags` is returned from `codegenProgram` and the driver passes it to clang as `-l<name>` arguments.

### 6.e `EXPORT_C_FUNCTION_DECL` codegen

Same as a regular `FUNCTION_DECL` but:
- The emitted symbol is unmangled: `define i32 @on_tick(i32 %ms) ...`
- Reject struct params/returns at typecheck time (deferred to phase 4 when refs land).

### 6.f Namespace field-access codegen

When `emitCall` sees `callee` is a `FIELD_ACCESS` with `namespaceLookup` set:

```js
if (node.callee?.namespaceLookup) {
  const { moduleId, exportName } = node.callee.namespaceLookup;
  const fullName = `@${mangle(moduleId, exportName)}`;
  // emit call as if it were a normal call to fullName
}
```

Cleanest: pre-walk lowers `FIELD_ACCESS { object: NAMESPACE_IDENT, namespaceLookup }` into a synthetic `IDENT { name: fullName }` before regular `emitCall` runs. One node transform, no special branches.

### 6.g Multi-module struct deduping

If `math.yoop` exports `type Vec2`, and `main.yoop` does `import { Vec2 }`, both modules end up referencing the same `StructType` object (same name `Vec2`). But codegen must emit `%struct.Vec2 = type { ... }` exactly once. Solve by:
- Tracking emitted struct names in a module-set scope (`emittedStructs: Set<string>`) shared across all modules in `codegenProgram`.
- The struct's name in IR is `%struct.<moduleId>__<typeName>` — i.e., struct names are also mangled. `Vec2` from `math.yoop` becomes `%struct.math_a8c1f203__Vec2`. Imports in `main.yoop` reference *that* name, not a re-emitted local one.

This means `llvmType` for a struct type needs the source module's id, not just the type name. Add `moduleId` to the StructType payload during the typecheck struct-shell pass — the same field already exists conceptually as part of the type's identity.

### 6.h Test-runner test surface

`compileSource` (single-file convenience) keeps its shape. But there's a new convenience `compileEntry(entryAbsPath)` that returns `{ ir, linkFlags }` for an entry file. The e2e runner uses the new form for multi-file fixtures; old fixtures keep using `compileSource`.

---

## 7. Driver linkage ([yoopiler.js](../src/yoopiler.js))

The diff:

- Replace `fs.readFileSync(inputFile)` + `parse` + `typecheck` + `codegen` with `loadModuleGraph` → `typecheckProgram` → `codegenProgram`.
- Add link flags to the clang argv:
  ```js
  const clangArgs = [tmpIR, "-o", outputFileName, ...linkFlags.map(f => `-l${f}`)];
  ```
- On Windows, library flags also work via `-l<name>` for clang. No path translation needed.

---

## 8. Edge cases worth getting right

### 8.a Importing a name that doesn't exist

`import { nope } from "./m.yoop";` where `m.yoop` doesn't export `nope`. Error at pass C: `module "./m.yoop" has no export "nope"`. Source location is the specifier inside the import block — point at the right name, not the whole line.

### 8.b Importing a private name

Same shape as 8.a — non-exported names are not in the source module's `exports` set, so the lookup fails the same way.

### 8.c Re-importing the same name twice

```yoop
import { x } from "./a.yoop";
import { x } from "./b.yoop";
```

Second import collides on `localName` `x`. Error: `local name "x" collides with an existing declaration` at the second specifier. User must rename via `as`.

### 8.d `import * as ns; ns.private` access

`m.yoop`:
```yoop
function private(): int32 { return 1; }
export function public(): int32 { return 2; }
```

`main.yoop`:
```yoop
import * as m from "./m.yoop";
function main(): int32 {
    return m.private();         // error: "private" not exported
}
```

`resolveFieldAccess` checks `ns.exports.has(field)`. Reject with: `namespace "m" has no export "private"`. Don't leak the fact that there's a private function with that name — but the error message is still clear.

### 8.e Cycles

`a.yoop` imports `b.yoop`; `b.yoop` imports `a.yoop`. Detected at graph load (`onStack` check) → throw `import cycle detected: a.yoop -> b.yoop -> a.yoop`. Hard error — split the shared declarations into a third module.

### 8.f File path canonicalization

`./foo.yoop` and `./Foo.yoop` are different files on Linux, same file on macOS. `fs.realpathSync` handles both; we trust the OS. No special handling.

### 8.g Imports of files outside the entry's tree

`import "../shared/u.yoop";` is allowed. Filesystem says it's there or not. If absent, `fs.readFileSync` throws — bubble up as a parse error with the importing file's source location.

### 8.h An `extern` declaration that shadows a local

Two scenarios:
- `extern "C" from "stdio.h" { function foo(): int32; }` and also `function foo(): int32 { ... }` in the same module. Reject at pass A: `redeclaration of "foo"`.
- An import named `foo` and a local extern `foo`. Same rule: collision detected at pass C when imports overlay onto the local symbol table.

### 8.i An extern type with no body referenced as a type annotation

```yoop
extern "C" from "stdio.h" { type FILE; }
function f(p: FILE): int32 { return 0; }
```

Reject: `cannot use opaque extern type "FILE" as a value parameter — use ref FILE (refs land in phase 4)`. Until phase 4, opaque externs are declaration-only — they parse and typecheck but every code-position use is rejected. This keeps the symbol available so `extern "C" from "stdio.h" { function fopen(...): ref FILE; }` parses; the rejection moves into the call-site type check.

### 8.j Variadic extern called with zero variadic args

`printf("hello\n")` (no `${...}` parts) — fine, just one fixed arg, zero variadic. Existing printf logic already handles this.

### 8.k `export "C" function` with an `int` return

`export "C" function on_tick(ms: int32): int32 { return ms + 1; }` — emits `define i32 @on_tick(i32 %ms) { ... }`. No mangling. Should be callable from C code that links against the produced object. (We don't test this in v0 — the test fixtures all have a yooper `main`. But the IR shape should be right.)

### 8.l `export "C" function` whose name collides with an `extern` declaration

`extern "C" from "stdio.h" { function foo(): int32; }` plus `export "C" function foo(): int32 { return 0; }`. Both want symbol `@foo` unmangled — link error at clang time. We *can* catch this at typecheck (both register `foo` in localSymbols → collision). Do so.

### 8.m Side-effect-only imports run nothing yet

`import "./init.yoop";` — yooper has no top-level code outside functions. So a side-effect-only import contributes only its struct/extern/library decls to the link, not any executed code. The driver's job is to load and typecheck the module so its declarations are registered. Codegen still emits the module's function bodies as defined-but-uncalled — clang won't dead-strip them by default, but that's fine for v0.

### 8.n Imported struct in destructure target

```yoop
import { Bytes } from "./io.yoop";
function consume(b: Bytes): int32 { const { len, err } = b; ... }
```

The imported `Bytes` is a fully-resolved StructType (same object, due to pass A sharing). `checkDestructureDecl` already handles this — no new code.

### 8.o A namespace import used as a function call

`import * as io from "./io.yoop"; io();` — `io` resolves to a NamespaceType, `resolveCall` rejects: `cannot call namespace "io" — use io.<name>`.

### 8.p A `?` across module boundaries

```yoop
// io.yoop
export type Bytes { len: int32, err: string, }
export function read_all(p: string): Bytes { ... }

// main.yoop
import { read_all, Bytes } from "./io.yoop";
function load(): Bytes {
    const n = read_all("foo")?;
    return { len: n, err: "" };
}
```

`read_all` returns the *imported* `Bytes`, which is the same StructType object as in `io.yoop`. `isFallible(t)` returns true. The `?` lowering proceeds normally and returns the *enclosing function's* return type — also `Bytes`, which happens to be the same struct. Good.

The pathological case: `function load(): MainBytes { const n = read_all("foo")?; ... }` where `MainBytes` is a *different* fallible type. The `?` semantics already say "fail-variant return uses the *enclosing* function's return type, with err copied across". Cross-module doesn't change that. Just make sure codegen reads the enclosing return type correctly — it already does.

### 8.q Forward-referencing exports across modules

`a.yoop` imports `Vec2` from `b.yoop`; `b.yoop` declares `Vec2` after declaring something that references `Vec2`. The two passes (A: shells, B: fields) decouple this: shells are registered before any field types resolve, so cross-module forward references work too — provided no *cycle* is involved.

### 8.r Non-`.yoop` file paths

`import { x } from "./m.txt";` → parse-time error from the driver: `import path "./m.txt" must end in .yoop`. Same shape as missing-relative-prefix.

### 8.s `extern` block in a non-entry file

Allowed. `extern "C" from library "m" { ... }` in a module that's transitively imported propagates its `linkLibraries` up to the global `linkFlags` set. Codegen walks all modules; the link flag is recorded once regardless of where it was declared.

---

## 9. Tests

### 9.1 Pass fixtures — [examples/pass/](../examples/pass/)

Multi-file fixtures live in their own directories; each has a `main.yoop` that's the entry. The e2e harness invokes the entry path.

#### `imports_basic/` — named import + use

```
imports_basic/
    main.yoop
    helpers.yoop
```

`helpers.yoop`:
```yoop
export function square(x: int32): int32 { return x * x; }
```

`main.yoop`:
```yoop
import { square } from "./helpers.yoop";

function main(): int32 {
    printf(`9 = ${square(3)}\n`);
    return 0;
}
```

Expected: `9 = 9`.

#### `imports_namespace/` — `import * as` + dotted call

```yoop
// main.yoop
import * as helpers from "./helpers.yoop";

function main(): int32 {
    printf(`5 = ${helpers.square(2) + 1}\n`);
    return 0;
}
```

Expected: `5 = 5`.

#### `imports_renamed/` — `import { x as y }` works

```yoop
// main.yoop
import { square as sq } from "./helpers.yoop";

function main(): int32 {
    printf(`16 = ${sq(4)}\n`);
    return 0;
}
```

Expected: `16 = 16`.

#### `imports_struct/` — exported struct + cross-module fallible flow

```yoop
// io.yoop
export type Bytes { len: int32, err: string, }
export function read_all(p: string): Bytes {
    if (p.len == 0) { return { len: 0, err: "empty path" }; }
    return { len: 42, err: "" };
}

// main.yoop
import { read_all, Bytes } from "./io.yoop";

function load(p: string): Bytes {
    const n = read_all(p)?;
    return { len: n + 1, err: "" };
}

function main(): int32 {
    const { len, err } = load("foo");
    if (err.len > 0) { printf(`err: ${err}\n`); return 1; }
    printf(`len = ${len}\n`);
    return 0;
}
```

Expected: `len = 43`. Exercises imported struct, `?` across modules, cross-module fallible composition.

#### `extern_printf/` — explicit printf via extern

```yoop
// main.yoop
extern "C" from "stdio.h" {
    function printf(fmt: string, ...): int32;
}

function main(): int32 {
    printf(`hello\n`);
    return 0;
}
```

Expected: `hello`. Verifies the extern path emits the same `declare i32 @printf(ptr, ...)` as the legacy hardcoded path.

#### `extern_library/` — `-lm` link flag

```yoop
// main.yoop
extern "C" from "stdio.h" {
    function printf(fmt: string, ...): int32;
}
extern "C" from library "m" {
    function cos(x: float64): float64;
}

function main(): int32 {
    let x: float64 = cos(0.0);
    printf(`cos(0) = ${x}\n`);
    return 0;
}
```

Expected: `cos(0) = 1.000000`. Asserts `linkFlags` contains `m` and clang receives `-lm`.

#### `imports_diamond/` — diamond loads each module once

```
diamond/
    main.yoop  (imports a, imports b)
    a.yoop     (imports util)
    b.yoop     (imports util)
    util.yoop
```

`util.yoop`:
```yoop
export function answer(): int32 { return 42; }
```

`a.yoop`:
```yoop
import { answer } from "./util.yoop";
export function via_a(): int32 { return answer(); }
```

`b.yoop`:
```yoop
import { answer } from "./util.yoop";
export function via_b(): int32 { return answer(); }
```

`main.yoop`:
```yoop
import { via_a } from "./a.yoop";
import { via_b } from "./b.yoop";
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }
function main(): int32 {
    printf(`a=${via_a()} b=${via_b()}\n`);
    return 0;
}
```

Expected: `a=42 b=42`. Asserts the IR contains exactly one `define i32 @util_<hash>__answer` (not two).

#### `side_effect_import/` — module loaded only for its decls

```yoop
// init.yoop
extern "C" from library "m" {
    function cos(x: float64): float64;
}

// main.yoop
import "./init.yoop";
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }
function main(): int32 {
    let x: float64 = cos(0.0);
    printf(`x = ${x}\n`);
    return 0;
}
```

Wait — `cos` is a *symbol* in `init.yoop`, and a side-effect import does NOT bind that symbol into `main.yoop`. So `main.yoop`'s call to `cos` is unresolved.

Two interpretations:
- (A) Side-effect imports propagate library link flags but no symbols. Then this fixture *doesn't* compile — `cos` is unresolved in `main.yoop`. Move the extern block into `main.yoop` itself.
- (B) Side-effect imports also propagate extern declarations into the current scope (because externs are "module-private declarations of symbols available at link time, not module values"). Then this fixture compiles.

The spec is silent. (A) is cleaner and what we adopt — externs are private to their module like everything else. The fixture's `main.yoop` should declare `cos` itself, and `init.yoop` is renamed to be a module that *re-exports* a wrapper or simply be a yooper-side noop. Replace this fixture with one that genuinely tests side-effect imports. For now, use:

```yoop
// init.yoop
const _: int32 = 1;       // future: module-init code; for now, just a private const
```

```yoop
// main.yoop
import "./init.yoop";
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }
function main(): int32 {
    printf(`init loaded\n`);
    return 0;
}
```

Expected: `init loaded`. Verifies the parser/driver/typecheck happy path for side-effect imports — no failure modes.

#### `export_c/` — unmangled C ABI symbol

```yoop
// main.yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

export "C" function add_one(n: int32): int32 { return n + 1; }

function main(): int32 {
    printf(`add_one(5) = ${add_one(5)}\n`);
    return 0;
}
```

Expected: `add_one(5) = 6`. The fixture also asserts the IR contains exactly `define i32 @add_one(i32 %n)` (no mangling).

### 9.2 Fail fixtures — [examples/fail/](../examples/fail/)

| File | Snippet | Expected error |
|---|---|---|
| `import_missing.yoop` | `import { x } from "./does_not_exist.yoop";` | filesystem error bubbled — message contains `does_not_exist.yoop` |
| `import_no_yoop_ext.yoop` | `import { x } from "./m.txt";` | `import path "./m.txt" must end in .yoop` |
| `import_unknown_export/` | `import { nope } from "./m.yoop";` where `m.yoop` doesn't export `nope` | `module "./m.yoop" has no export "nope"` |
| `import_collision/` | Two `import { x } from ...` lines | `local name "x" collides` |
| `import_cycle/` | `a.yoop` imports `b`; `b` imports `a` | `import cycle detected` |
| `extern_unsupported_abi.yoop` | `extern "Rust" from "..."` | `unsupported extern ABI "Rust"` |
| `export_c_struct.yoop` | `export "C" function f(p: Point): int32` | `'export "C"' functions cannot take struct values until phase 4` |
| `namespace_call.yoop` | `import * as io from "./io.yoop"; io();` | `cannot call namespace "io"` |
| `namespace_private.yoop` | `import * as m from "./m.yoop"; m.private();` (private not exported) | `namespace "m" has no export "private"` |
| `import_after_decl.yoop` | `function main():int32{return 0;} import {x} from "./m.yoop";` | `imports must come before other declarations` |

### 9.3 Updating `e2e.test.js`

Each multi-file fixture's `it()` invokes a new `runFixtureEntry(relPath)` that calls `compileEntry(absPath)` → writes IR → links with `-l<flag>` for each link flag → spawns and asserts. Pattern:

```js
it("imports_basic compiles and prints squared output", () => {
  const { stdout, exitCode } = runFixtureEntry("examples/pass/imports_basic/main.yoop");
  assert.equal(exitCode, 0);
  assert.equal(stdout, "9 = 9\n");
});
```

Fail fixtures use `typecheckProgram` (not `compileEntry`) and assert `errors[0].message` matches.

### 9.4 Unit tests

- `src/jsyoopdriver/moduleId.test.js` — same path → same id; different paths → different ids; identifier-safe characters only.
- `src/jsyoopdriver/moduleGraph.test.js` — happy path, dedup, cycle detection, missing file, non-`.yoop` extension. Uses an in-memory or tmp directory — no real fs writes in the user's tree.
- `src/jsyooptypecheck/imports.test.js` — `resolveImports` with mocked `moduleEnv`; unknown export, collision, namespace shape.

### 9.5 Codegen IR-shape tests

In [codegen.test.js](../src/jsyoopcodegen/codegen.test.js):

- A two-module compile produces exactly one `%struct.<id>__Foo = type {...}` per imported struct.
- An `export "C" function` produces `define i32 @<name>` (no `<moduleid>__`).
- An `extern "C" from library "m"` produces a `linkFlags` containing `m`.
- A `?`-across-modules program produces a single `call i64 @strlen` (just like single-module today).

---

## 10. Implementation order

The order minimizes time spent in a broken intermediate state. Each step keeps prior tests green.

1. **Lexer**: keywords + `...` token. Add unit tests. After this, source files containing the new keywords lex but the parser still throws "unexpected token at top level".
2. **AST kinds + parser** for `import`, `export`, `extern "C"`, `export "C"`. Plus parser tests in §3.e/f. Typechecker still throws on the new kinds — that's fine because no fixture uses them yet.
3. **moduleId.js + moduleGraph.js**: the driver-side graph walker. Unit tests in §9.4. Wire into `yoopiler.js` *behind a flag* so the existing single-file fixtures keep working: if no imports are present, fall through to the legacy single-file flow. Once typecheck/codegen are graph-aware, remove the flag.
4. **Typechecker — `typecheckProgram`**: passes A/B/C/D structure described in §5.a. For now, pass A handles only `FUNCTION_DECL`, `TYPE_DECL`, `EXPORT_DECL`, `IMPORT_DECL`; passes B and D reuse the existing logic. After this step, `imports_basic/` works end-to-end.
5. **Namespace identifiers**: `NamespaceType`, `NAMESPACE_IDENT` synthesis in `resolveIdent`, `FIELD_ACCESS` namespace path. After this step, `imports_namespace/` works.
6. **Imported structs**: the cross-module struct-table sharing in §5.d. After this step, `imports_struct/` works.
7. **Diamond/dedup**: verify in `imports_diamond/`. Should be free if §6.g is implemented correctly.
8. **`extern "C"`**: AST → typechecker symbol routing → codegen `declare` emission. Drop printf from `KNOWN_EXTERNS` and verify all phase 1/2 fixtures still pass via the legacy fallback. After this, `extern_printf/` works.
9. **Library externs + link flags**: `linkLibraries` set in moduleEnv → returned from `codegenProgram` → driver passes to clang. After this, `extern_library/` works.
10. **`export "C" function`**: unmangled-symbol path. Reject struct params/returns. After this, `export_c/` works.
11. **Side-effect imports**: should be free at this point — already covered by graph walker + typecheck pass A. Verify with `side_effect_import/`.
12. **All fail fixtures** in §9.2.
13. **Test runner**: `runFixtureEntry` for the multi-file shape; `compileEntry` API; CI runs on every pass/fail fixture.
14. **Cleanup**: delete `KNOWN_EXTERNS` if every fixture now uses an explicit extern. Add a follow-up issue to delete the printf legacy fallback once `io.yoop` stdlib lands.

Each step is independently bisect-able. Steps 1–3 land plumbing without changing language semantics. Steps 4–7 deliver imports/exports. Steps 8–10 deliver FFI. Step 14 tightens.

---

## 11. Critical files reference

- [SPEC.md §1 — Modules and imports](../SPEC.md), [§12 — Foreign interop](../SPEC.md) — re-read before each step.
- [src/contracts.js](../src/contracts.js) — new AST kinds.
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — new keywords, `...` token.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — top-level dispatch + new `parse*` helpers.
- `src/jsyoopdriver/moduleGraph.js` (new) — `loadModuleGraph(entryAbsPath)`.
- `src/jsyoopdriver/moduleId.js` (new) — `moduleIdFor(absPath)`.
- [src/yoopiler.js](../src/yoopiler.js) — driver replaces single-file flow with graph flow; passes `-l<flag>` to clang.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) — `typecheckProgram(modules)`.
- `src/jsyooptypecheck/imports.js` (new) — `resolveImports(mod, moduleEnv, errors)`.
- [src/jsyooptypecheck/scope.js](../src/jsyooptypecheck/scope.js) — `kind: "namespace"` binding.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) — namespace-aware `resolveIdent`, `resolveFieldAccess`, `resolveCall`.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) — `NamespaceType`, struct mangling-aware `llvmType` callers.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — `codegenProgram(modules)`, `mangle()`, extern emission from AST, `linkFlags`.
- [src/e2e.test.js](../src/e2e.test.js) — `runFixtureEntry`, multi-file fixtures.
- `examples/pass/imports_basic/`, `imports_namespace/`, `imports_renamed/`, `imports_struct/`, `imports_diamond/`, `extern_printf/`, `extern_library/`, `side_effect_import/`, `export_c/`.
- `examples/fail/` — `import_missing`, `import_no_yoop_ext`, `import_unknown_export/`, `import_collision/`, `import_cycle/`, `extern_unsupported_abi`, `export_c_struct`, `namespace_call`, `namespace_private`, `import_after_decl`.
