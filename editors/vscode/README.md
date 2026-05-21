# Yooperlang VS Code extension

Syntax highlighting, bracket matching, and comment toggling for `.yoop` files.

No language server — purely declarative (grammar + language config).

## Install locally

Symlink this directory into your VS Code extensions folder, then restart VS Code:

```sh
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

## Known limitations

- Template-literal interpolation handles one level of nested braces inside `${...}`. Deeply nested object literals inside an interpolation may close the interpolation early visually. This is display-only — the lexer and parser handle arbitrary nesting correctly.
- No semantic highlighting (no LSP). PascalCase-as-type and `name(` -as-function are syntactic heuristics, not type-aware.
