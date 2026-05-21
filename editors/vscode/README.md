# Yooperlang VS Code extension

Syntax highlighting, bracket matching, comment toggling, **and live parse / typecheck diagnostics** for `.yoop` files.

The diagnostics come from a Node-based LSP server at [../../src/lsp/server.js](../../src/lsp/server.js) that the extension launches on demand. It reuses the compiler's lexer, parser, and typechecker — no separate implementation to drift.

## Install locally

The extension depends on `vscode-languageclient` to talk to the server, so install its node_modules first, then symlink the directory into VS Code's extensions folder and restart:

```sh
cd editors/vscode
npm install
cd ../..
ln -s "$PWD/editors/vscode" ~/.vscode/extensions/yoop-lang-0.0.1
```

(Run from the repo root.)

To uninstall:

```sh
rm ~/.vscode/extensions/yoop-lang-0.0.1
```

## What it highlights

- All keywords from `src/jsyooplexer/lexer.js` (`keywordTagList`), grouped into control flow, declarations, modifiers, kind clauses, and concurrency.
- Reserved-but-unimplemented keywords (`provides`, `restricts`, `autoJoin`) are flagged with the `invalid.deprecated` scope so themes draw them distinctly — a visual reminder that they're not yet usable.
- Primitive types (`int32`, `uint64`, `float32`, `bool`, `string`, `void`, …) as `support.type.primitive`.
- User types (any PascalCase identifier) as `entity.name.type`.
- Function declarations and call sites as `entity.name.function`.
- Numeric literals including underscore separators and `0x` / `0b` / `0o` prefixes.
- Strings (`"..."`), single-quoted strings / char literals (`'...'`), and template literals (`` `...${expr}...` ``) with embedded expression highlighting.
- Line comments (`//`) and nestable block comments (`/* /* */ */`).

## Diagnostics (LSP)

The language server treats the currently-open `.yoop` file as the program entry, walks its imports, and runs lex → parse → typecheck. Errors are surfaced inline as VS Code diagnostics. Imports are followed from disk; unsaved buffers for other open `.yoop` files are overlaid automatically.

Caveats in this first cut:

- Errors raised inside an imported module are pinned at the top of the open file with an `[import]` prefix — the typechecker doesn't yet record which module each error originated in.
- Sync is full-document on every change (no incremental edits).
- Only diagnostics are wired up; no hover, completion, or go-to-def yet.

To run the server standalone (for non-VS Code editors that speak LSP over stdio):

```sh
npm run lsp        # from the repo root
```

## Known limitations (highlighting)

- Template-literal interpolation handles one level of nested braces inside `${...}`. Deeply nested object literals inside an interpolation may close the interpolation early visually. This is display-only — the lexer and parser handle arbitrary nesting correctly.
- PascalCase-as-type and `name(`-as-function are syntactic heuristics, not type-aware. (The LSP doesn't yet feed semantic tokens back to the editor.)
