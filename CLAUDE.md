# Yooperlang - Claude working notes

A JS-implemented compiler for the Yooperlang language. Emits LLVM IR text, shells
out to `clang` to link and produce an executable.

**Current focus: the self-hosting bootstrap** - rewriting the JS compiler in Yoop,
layer by layer, cross-checked against the JS reference.

Pipeline: source `.yoop` -> **lex** -> **parse** -> **typecheck** -> **codegen**
(LLVM IR) -> `clang` -> executable.

IMPORTANT: even in Auto mode, when writing plans or example ideas, do not spend a
lot of time on assumptions! Stop and ask for clarification early on contradictions
or when spinning wheels on tooling or other areas to test things out.

---

## Where to look

This file is a router. It stays short on purpose; the detail lives in the docs
below, and you usually need exactly one of them.

- **Writing Yoop code** (std, bootstrap, tools, examples):
  [docs/writing_yoop.md](docs/writing_yoop.md). Current best practice for kinds,
  `string` vs `Text`, arenas and the allocator context, errors, async coloring,
  modules, and the test harness. **That doc wins over any plan doc or older
  example**; the language changed shape several times and `plans/` records how
  things were BUILT, not how to use them now.
- **Editing the JS compiler** (`src/`, `runtime/`):
  [docs/compiler_internals.md](docs/compiler_internals.md). Subsystem map, pass
  ordering, codegen and runtime invariants, packaging, the `--test` driver flow.
- **Language reference**: [SPEC.md](SPEC.md). Grammar and semantics.
- **What is being worked on now**: [plans/README.md](plans/README.md).

Std API index: [std/INDEX.md](std/INDEX.md) (generated; regenerate with
`node scripts/gen_std_index.mjs` after adding or renaming a std export).

---

## Always-on rules

**Writing style** for docs, plans, comments, anything: **no em-dash**, **no
characters that are awkward to type on an American keyboard** (no arrows, no
curly quotes), **no fancy markdown tables**.

**Code style**: 2-space indentation in all new code.

**Naming** (full version, including the carve-outs, in
[docs/writing_yoop.md](docs/writing_yoop.md)):

- Files and directories: `snake_case`. Module names match their folder, so prefer
  single words.
- Yoop types and type-like declarations: `PascalCase`.
- Yoop functions, methods, locals, parameters, fields, kind names: `camelCase`.
  This includes all of std as of 2026-08-11 (`vec.vecNew`, `map.mapGet`,
  `Display.toString`); the old `snake_case` spellings are gone.
- Value-`enum` cases and module-level `const`s: `SCREAMING_SNAKE`.
- Never `snake_case` for an identifier. Two carve-outs, both "mirror C exactly":
  `extern "C"` symbol names, and structs mirroring a C ABI struct.
- The JS reference impl uses ordinary JS conventions; only the file/directory
  rule applies to it.

**[examples/playground/](examples/playground/) is not a test surface** and does
not have to be kept compiling. Nothing under it is covered by e2e (only
[examples/pass/](examples/pass/) and [examples/testing/](examples/testing/) are).
Do not treat a stale program there as a regression, and do not let one expand the
change in front of you. Do reach for one when it is genuinely the best available
check on a change, and say so when you do.

---

## Run / test

- `npm test` - all tests (unit + e2e). Currently 1085 tests, ~35s.
- `npm run test:unit` - fast, no clang.
- `npm run test:e2e` - full pipeline, requires `clang` on PATH.
- Compile one file: `node src/yoopiler.js path/to/file.yoop -o out`.
- Driver entry: [src/yoopiler.js](src/yoopiler.js). End-user invocation is
  `yoopiler_alpha <entry.yoop>` (the `bin` name in package.json); the entry file
  pulls in everything else via its imports.
- `yoopiler --test <dir>` runs the Yoop-level test harness (filters ride as extra
  positionals).
- `yoopiler --lsp` runs the language server over stdio instead of compiling. The
  import of [src/lsp/server.js](src/lsp/server.js) is **dynamic on purpose** -
  that module attaches `process.stdin` handlers at module scope, so a static
  import would hijack stdin on every ordinary compile. The flag is handled before
  anything in `main()` reaches stdout, because in LSP mode stdout IS the transport.
- `npm run build:sea` / `npm run package` - standalone binary and release zip.
  See [docs/compiler_internals.md](docs/compiler_internals.md) for the dist
  layout and what adding a non-JS data file requires.
