# Editor setup

Syntax highlighting, live error checking, go-to-definition, and debugging for
Yooperlang in VS Code. The extension is in `editor/vscode/` next to this file.

Everything here is optional. The compiler works fine from a terminal without
any of it.

## Install the extension

The extension is not on the VS Code marketplace, so install it by dropping it
into the extensions folder. From the directory holding this file:

macOS / Linux:

```sh
cp -R editor/vscode ~/.vscode/extensions/yoop-lang-0.1.0
```

Windows (PowerShell):

```powershell
Copy-Item -Recurse editor\vscode "$HOME\.vscode\extensions\yoop-lang-0.1.0"
```

Then fully quit and reopen VS Code. Reload Window is not always enough for a
newly added extension.

Using VS Code Insiders, Cursor, or Windsurf instead? Same idea, different
folder: `~/.vscode-insiders/extensions`, `~/.cursor/extensions`, or
`~/.windsurf/extensions`.

To uninstall, delete that directory.

### If you would rather symlink than copy

A symlink works too and makes updates automatic, but only if this
distribution directory stays where it is:

```sh
ln -s "$(pwd)/editor/vscode" ~/.vscode/extensions/yoop-lang-0.1.0
```

## Check that it worked

Open one of the programs in `samples/`. You should see:

- Keywords, types, strings, and comments colored.
- A red squiggle if you break something. Try changing a number to a string.
- Hover over any variable for its type.
- F12 (or Cmd-click / Ctrl-click) to jump to a definition.

If you get colors but no squiggles or hovers, the language server did not
start. See troubleshooting below.

## How the language server finds the compiler

The extension auto-detects the compiler binary at `../../bin/` relative to
itself, which is the layout of this distribution. If you copied the extension
into your extensions folder rather than symlinking it, that relative path no
longer resolves, so point it at the binary explicitly:

1. Open Settings (Cmd-, / Ctrl-,).
2. Search for `yoopiler.binaryPath`.
3. Set it to the full path of the binary in this distribution's `bin/`
   directory.

Or add it to `settings.json` directly:

```json
{
  "yoopiler.binaryPath": "/full/path/to/yoopiler-<platform>/bin/yoopiler_alpha"
}
```

The setting takes a full path, not a relative one, and not `~`.

## What you get

- **Syntax highlighting** for keywords, types, functions, numbers (including
  `0x` / `0b` / `0o` and `_` separators), strings, template literals with
  embedded expressions, and nestable block comments. Keywords reserved for
  unimplemented features are drawn as invalid, which is a deliberate hint that
  they will not compile yet.
- **Diagnostics** as you type: real parse and typecheck errors from the actual
  compiler, not an approximation of it.
- **Hover** for the resolved type of any expression.
- **Go to definition** across files, including struct fields and trait methods.
- **Find all references** (Shift-F12) and **Rename** (F2).
- **Completion** (Ctrl-Space) for locals, parameters, module declarations,
  imported names, and primitives.
- **Outline view** (Cmd-Shift-O) of functions, types, fields, and traits.

## Debugging

Source-level debugging works through `lldb-dap`, which ships with the Xcode
Command Line Tools on macOS and with LLVM elsewhere. Open a `.yoop` file and
press F5, or run "Yoopiler: Debug Current File" from the command palette.

Breakpoints, stepping, call stacks, and primitive-typed local variables all
work. Struct, ref, enum, and union locals do not appear in the Variables pane
yet.

If `lldb-dap` is somewhere unusual, set `lldbDapPath` in your launch
configuration or the `LLDB_DAP_PATH` environment variable.

## Other editors

The language server speaks standard LSP over stdio, so any LSP-capable editor
can use it. The command is:

```sh
/full/path/to/bin/yoopiler_alpha --lsp
```

Register that for files matching `*.yoop`. Neovim, Helix, Emacs (eglot or
lsp-mode), and Sublime all support this; consult their documentation for the
exact configuration format. You will not get syntax highlighting that way,
only the language features, since the TextMate grammar in
`editor/vscode/syntaxes/` is VS Code specific.

## Troubleshooting

**Colors work but nothing else does.** The language server is not running.
Open the Output panel (View > Output) and pick "Yoopiler (extension)" from the
dropdown. It logs which server it launched and why. The usual cause is the
extension not finding the binary; set `yoopiler.binaryPath` as described above.

**Nothing at all happens on a `.yoop` file.** VS Code did not load the
extension. Confirm the directory is really at
`~/.vscode/extensions/yoop-lang-0.1.0` and contains `package.json` and
`node_modules`, then fully quit and reopen VS Code.

**The extension loads but the server exits immediately.** On macOS this is
almost always the quarantine flag on the binary. See INSTALL.md, step 1.

**Debugging says lldb-dap not found.** Run `xcode-select --install` on macOS,
or install LLVM on Linux or Windows.
