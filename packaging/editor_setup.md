# Editor setup

Syntax highlighting for Yooperlang in VS Code. The extension is in
[../editors/vscode/](../editors/vscode/) in the repository; a release tarball
ships the compiler only.

Everything here is optional. The compiler works fine from a terminal without any
of it.

## What you get, and what you do not

Working today: highlighting for keywords, types, functions, numbers (including
`0x` / `0b` / `0o` and `_` separators), strings, template literals with embedded
expressions, and nestable block comments. Keywords reserved for unimplemented
features are drawn as invalid, which is a deliberate hint that they will not
compile yet. Bracket matching and comment toggling come with it.

Also working: DIAGNOSTICS. The extension starts `yoopiler_boot --lsp` - the
compiler itself, speaking the Language Server Protocol - so the red squiggles
are the errors a build would report, and they refresh on open, on save, and
shortly after you stop typing. It needs to be able to find the compiler: set
`yoopiler.binaryPath`, or install the extension out of a release, where it sits
beside `bin/yoopiler_boot` and finds it on its own.

Not working today: hover, go-to-definition, references, rename, completion, and
the F5 debug launch. None of those is advertised to the editor either, so
nothing waits on a reply that is not coming.

## Install the extension

The extension is not on the VS Code marketplace, so install it out of a
checkout. From the repository root:

macOS / Linux:

```sh
cd editors/vscode && npm install && cd ../..
ln -s "$PWD/editors/vscode" ~/.vscode/extensions/yoop-lang.yoop-lang-0.1.0
```

Windows (PowerShell), copying rather than linking:

```powershell
Copy-Item -Recurse editors\vscode "$HOME\.vscode\extensions\yoop-lang.yoop-lang-0.1.0"
```

Then fully quit and reopen VS Code. Reload Window is not always enough for a
newly added extension.

Using VS Code Insiders, Cursor, or Windsurf instead? Same idea, different
folder: `~/.vscode-insiders/extensions`, `~/.cursor/extensions`, or
`~/.windsurf/extensions`.

To uninstall, delete that directory.

## Check that it worked

Open any `.yoop` file. Keywords, types, strings, and comments should be colored.
If nothing happens at all, VS Code did not load the extension: confirm the
directory really is at `~/.vscode/extensions/yoop-lang.yoop-lang-0.1.0` and holds
`package.json` and `node_modules`, then fully quit and reopen VS Code.

## Other editors

The TextMate grammar in `editors/vscode/syntaxes/` is VS Code specific, and
editors that read TextMate grammars can borrow it. For diagnostics, register
`bin/yoopiler_boot --lsp` as a stdio language server for `.yoop` files - it is
an ordinary LSP server and needs no VS Code.
