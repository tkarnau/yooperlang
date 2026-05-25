# Yooperlang VS Code extension

Syntax highlighting, bracket matching, comment toggling, **and live parse / typecheck diagnostics** for `.yoop` files.

The diagnostics come from a Node-based LSP server at [../../src/lsp/server.js](../../src/lsp/server.js) that the extension launches on demand. It reuses the compiler's lexer, parser, and typechecker - no separate implementation to drift.

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
- Reserved-but-unimplemented keywords (`provides`, `restricts`, `autoJoin`) are flagged with the `invalid.deprecated` scope so themes draw them distinctly - a visual reminder that they're not yet usable.
- Primitive types (`int32`, `uint64`, `float32`, `bool`, `string`, `void`, …) as `support.type.primitive`.
- User types (any PascalCase identifier) as `entity.name.type`.
- Function declarations and call sites as `entity.name.function`.
- Numeric literals including underscore separators and `0x` / `0b` / `0o` prefixes.
- Strings (`"..."`), single-quoted strings / char literals (`'...'`), and template literals (`` `...${expr}...` ``) with embedded expression highlighting.
- Line comments (`//`) and nestable block comments (`/* /* */ */`).

## Language features (LSP)

The language server treats the currently-open `.yoop` file as the program entry, walks its imports, and runs lex → parse → typecheck. Imports are followed from disk; unsaved buffers for other open `.yoop` files are overlaid automatically.

Capabilities advertised today:

- **Diagnostics** - parse + typecheck errors as inline squiggles, with cross-module attribution.
- **Hover** - type info for any identifier (locals, params, function calls, fields). Reads the `resolvedType` the typechecker stamps on every expression.
- **Go to definition** - jumps from an identifier to its declaring `let` / `const` / parameter / `function` / `type` / `enum` / `union` / `trait` / `kind`. Cross-module calls follow imports via the `calleeModuleId` annotation. Struct field accesses jump to the `FIELD_DECL`. Trait-qualified method calls jump to the implementing method. Identifiers inside template-literal interpolations (``` `${arr.len}` ```) resolve correctly thanks to a sourceLoc-remap pass after the parser re-parses each interpolation via a synthetic wrapper.
- **Find all references** (Shift-F12) - every reference to a local, parameter, top-level function, type / enum / union / trait / kind, struct field, or method. Cross-module references are followed via the typechecker's import resolution. References inside `//` comments, block comments, and string / template-literal text are filtered out.
- **Rename** (F2) - built on find-references; produces a `WorkspaceEdit` that updates every reference atomically. Rejects invalid identifiers (digits-leading / non-identifier chars) and refuses to rename enum variants (variant ordinals are ABI-significant - see CLAUDE.md Phase 7.5).
- **Completion** (Ctrl-Space) - suggests locals + parameters in the enclosing function, top-level decls in the current module, imported names, and primitive types. Each suggestion carries a CompletionItemKind icon and a `detail` line with the formatted type when known.
- **Document symbols** - outline view (Cmd-Shift-O / ⌘-T) lists functions, types, fields, methods, enum variants, and traits.
- **Semantic tokens** - type-aware coloring driven by the typechecker (variables vs. parameters vs. types vs. functions vs. methods vs. enum members vs. namespaces). Replaces the regex-based PascalCase heuristic in the TextMate grammar; the editor blends the two.

Caveats:

- Sync is full-document on every change (no incremental edits).
- The parser's `sourceLoc.pos` sometimes lands one or two tokens past the identifier it represents (it captures parser state at node-construction time). The LSP works around this by scanning `src` for the actual identifier span at the cursor, so hover / go-to-def land in the right place even when sourceLoc is approximate. References uses the same source-scan + AST-validation approach to avoid collapsing distinct references onto the same anchor.

To run the server standalone (for non-VS Code editors that speak LSP over stdio):

```sh
npm run lsp        # from the repo root
```

## Debugging (DAP via lldb-dap)

The extension registers a `yoop` debug type that compiles the active `.yoop`
file with `yoopiler` and launches the resulting binary under
[`lldb-dap`](https://lldb.llvm.org/use/dap.html). Source-line breakpoints,
stepping (`step` / `next` / `continue`), call stacks, and primitive-typed
variable inspection (params, `let`/`const` bindings) all work today. Struct,
ref, enum, and union locals don't yet appear in the Variables pane -
composite DWARF types are a follow-up milestone.

### Prerequisites

- `lldb-dap`. On macOS this ships with the Xcode Command Line Tools:

  ```sh
  xcode-select --install
  ```

  On Linux/Windows install LLVM (most distros' `llvm` package ships
  `lldb-dap`). Override the path via the `lldbDapPath` launch property or
  the `LLDB_DAP_PATH` env var if it's installed somewhere non-standard.

- `clang` on `$PATH` (already required for `yoopiler`).

### Use it

Open a `.yoop` file and run **"Yoopiler: Debug Current File"** from the
command palette, or press **F5**. With no `launch.json` entry, the extension
synthesizes a default launch that targets the current file. To customize,
add an entry like this to `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "yoop",
      "request": "launch",
      "name": "Debug Yooperlang program",
      "program": "${workspaceFolder}/examples/playground/dynamic_array/main.yoop",
      "stopOnEntry": false,
      "args": [],
      "cwd": "${workspaceFolder}"
    }
  ]
}
```

Launch attributes:

| Field | Default | Notes |
| --- | --- | --- |
| `program` | `${file}` | `.yoop` entry file. Compiled to a sibling binary before launch. |
| `args` | `[]` | Argv passed to the compiled program. |
| `cwd` | binary's dir | Working directory. |
| `stopOnEntry` | `false` | Pause at program entry. |
| `env` | `{}` | Environment variables. |
| `skipBuild` | `false` | Reuse an existing binary; skip the yoopiler compile step. |
| `yoopilerPath` | bundled | Override `src/yoopiler.js`. |
| `lldbDapPath` | resolved at runtime | Override `lldb-dap` binary. |

### How it works

1. `resolveDebugConfiguration` fills in defaults for F5-from-editor.
2. `resolveDebugConfigurationWithSubstitutedVariables` spawns
   `node src/yoopiler.js <program>` and waits for exit code 0. Output is
   streamed to the **Yoopiler (extension)** output channel.
3. If the yoop file path differs from its `fs.realpathSync` (workspace
   symlinks, `/tmp` → `/private/tmp` on macOS, etc.), a `sourceMap` entry is
   added so breakpoints VSCode sends on the user-facing path match the
   canonical path DWARF embeds.
4. `program` is rewritten from the source path to the compiled binary, and
   the request is handed to `lldb-dap` (located via `xcrun --find lldb-dap`,
   `$LLDB_DAP_PATH`, or the system PATH).

If something doesn't work, the **Yoopiler (extension)** output channel
captures `yoopiler` stdout/stderr and the resolved `lldb-dap` path.

## Known limitations (highlighting)

- Template-literal interpolation handles one level of nested braces inside `${...}`. Deeply nested object literals inside an interpolation may close the interpolation early visually. This is display-only - the lexer and parser handle arbitrary nesting correctly.
- PascalCase-as-type and `name(`-as-function are syntactic heuristics, not type-aware. (The LSP doesn't yet feed semantic tokens back to the editor.)
