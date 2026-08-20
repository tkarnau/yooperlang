# Yooperlang VS Code extension

Syntax highlighting, bracket matching, and comment toggling for `.yoop` files.

## State of it

Highlighting works, and so do DIAGNOSTICS: the extension starts
`yoopiler_boot --lsp`, which is the compiler itself speaking the Language
Server Protocol, so the red squiggles are the errors a build would report. It
recompiles on open, on save, and shortly after you stop typing.

Nothing else is implemented, and nothing else is advertised - no hovers, no
go-to-definition, no references, no rename, no completion. The `yoop` debug type
is still registered but launches a program that is not in this tree, so F5
debugging does not work today.

**It needs a compiler to point at.** Set `yoopiler.binaryPath` to a
`yoopiler_boot` binary, or install the extension out of a release, where it
sits beside `bin/yoopiler_boot` and finds it on its own. From a checkout:

```sh
YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime \
  $(node scripts/seed.mjs) bootstrap/src/main.yoop -o /tmp/yoopiler_boot
```

then set `"yoopiler.binaryPath": "/tmp/yoopiler_boot"`. Without those two
environment variables baked in some other way, that binary reads the std and
runtime packaged beside it rather than this tree's - which is what you want for
a released binary and not what you want for one built from a checkout.

## Install locally

The extension depends on `vscode-languageclient`, so install its node_modules
first, then symlink the directory into VS Code's extensions folder and restart:

```sh
cd editors/vscode
npm install
cd ../..
ln -s "$PWD/editors/vscode" ~/.vscode/extensions/yoop-lang.yoop-lang-0.1.0
```

(Run from the repo root. Restart VS Code afterwards - it only scans the
extensions directory at startup.)

The directory name follows VS Code's `publisher.name-version` convention, so it
matches the `publisher` and `version` in `package.json`. Nothing enforces that -
VS Code reads the real values out of `package.json` - but a name that disagrees
with them is confusing next to the other entries in that directory.

To uninstall:

```sh
rm ~/.vscode/extensions/yoop-lang.yoop-lang-0.1.0
```

## What it highlights

- All keywords the lexer knows (`fillKeywordList` in
  [../../bootstrap/src/lex/scan_tables.yoop](../../bootstrap/src/lex/scan_tables.yoop)),
  grouped into control flow, declarations, modifiers, kind clauses, and
  concurrency.
- Reserved-but-unimplemented keywords (`provides`, `restricts`, `autoJoin`) are
  flagged with the `invalid.deprecated` scope so themes draw them distinctly - a
  visual reminder that they are not usable.
- Primitive types (`int32`, `uint64`, `float32`, `bool`, `string`, `void`) as
  `support.type.primitive`.
- User types (any PascalCase identifier) as `entity.name.type`.
- Function declarations and call sites as `entity.name.function`.
- Numeric literals including underscore separators and `0x` / `0b` / `0o`
  prefixes.
- Strings (`"..."`), single-quoted char literals (`'...'`), and template literals
  (`` `...${expr}...` ``) with embedded expression highlighting.
- Line comments (`//`) and nestable block comments (`/* /* */ */`).

## Known limitations

- Template-literal interpolation handles one level of nested braces inside
  `${...}`. Deeply nested object literals inside an interpolation may close the
  interpolation early visually. This is display-only - the lexer and parser
  handle arbitrary nesting correctly.
- PascalCase-as-type and `name(`-as-function are syntactic heuristics, not
  type-aware. Nothing corrects them, because the grammar is the only thing
  coloring a file.
