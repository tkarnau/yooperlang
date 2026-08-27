# Yooperlang VS Code extension

Syntax highlighting, bracket matching, comment toggling, and a language server
for `.yoop` files.

## State of it

The extension starts `yoopiler_boot --lsp`, which is the compiler itself
speaking the Language Server Protocol. So everything below is the compiler's
own answer rather than a second implementation that can drift from it:

- **Diagnostics.** The red squiggles are the errors and warnings a build would
  report, on the line and column they belong to. It recompiles on open, on
  save, and shortly after you stop typing.
- **Hover.** The declaration under the cursor, as one line, taken from the
  source that declares it - so a function shows the signature somebody wrote,
  parameter names and all. A local shows its inferred type instead, and a name
  from another file says which file it came from.
- **Go to definition.** Across files of the same module, across modules, and
  into std. A parameter or a local resolves inside the function it is in.
- **Outline** (the breadcrumb bar, and Ctrl-Shift-O / Cmd-Shift-O). Every
  declaration in the file, with a type's fields and methods under it.

What you are editing is what gets checked, even unsaved and even when it is one
file of a directory module: the buffer is handed to the compiler in place of
that one file while its siblings are read off the disk.

Nothing else is implemented, and nothing else is advertised - no references, no
rename, no completion, no formatting. The `yoop` debug type is still registered
but launches a program that is not in this tree, so F5 debugging does not work
today.

## Which compiler it talks to

There are two kinds of Yoop folder on a machine that has this compiler on it,
and they want opposite things from a language server. So the extension resolves
one per WORKSPACE FOLDER:

- a Yooperlang compiler CHECKOUT gets the compiler built from that checkout,
  reading that checkout's own `std/` and `runtime/`.
- any OTHER Yoop project gets a released compiler, reading the std packaged
  with it.

That split is the point. Working on a compiler means breaking it, and a broken
working tree must not break the editor for a program you are writing in the
language. Open both in one window and two servers run, one per folder.

A folder is a compiler checkout when it has `bootstrap/src/main.yoop`, `std/core`
and `runtime/` in it, looking upwards - so opening `bootstrap/src/lsp/` still
counts. The status bar shows which mode the file in front of you is getting, and
clicking it opens the log, which says which binary and why.

**In a checkout** it looks for, in order: `yoopiler.devBinaryPath`, then
`build/dev/bin/yoopiler_boot` (what `npm run setup` builds), then the bootstrap
seed under `.seed/`. The seed fallback is what gives a fresh clone a working
server before anything is built - it answers as the previous release, and the
log says so.

**Outside one** it looks for: `yoopiler.binaryPath`, then a binary shipped
beside this extension inside a distribution, then `yoopiler_boot` on PATH. No
std root is forced there, because a released compiler brings its own and handing
it another one is how it ends up compiling against a std it was never built
against.

**After rebuilding the compiler, run "Yoopiler: Restart Language Server"** from
the command palette. A server is spawned once and held, so a fresh binary on
disk is not picked up until it is.

From a checkout, `npm run setup` at the repo root builds the compiler this
looks for and prints the two install commands below.

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
