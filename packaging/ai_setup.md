# Instructions for an AI assistant helping someone set this up

Hand this whole file to Claude, ChatGPT, Cursor, or whatever assistant you
prefer, along with "help me get this set up". It contains everything needed to
walk someone through installation and their first program.

If you are that assistant: read all of this before running anything. The
failure modes at the bottom are silent and unguessable, and you will waste the
user's time rediscovering them.

## What this package is

Yooperlang is a small systems language. This is an **alpha compiler**, handed
out directly rather than published anywhere. It is a hobby project, not a
product, so treat rough edges as expected rather than as something the user
did wrong.

The package is `{{TARGET}}` and was built for **{{PLATFORM_HUMAN}}**. It will
not run on any other platform. If the user is on something else, stop and tell
them they need a build for their machine; there is no universal binary and no
download page.

Layout:

    bin/{{BIN}}     the compiler
    lib/            standard library and C runtime, read at compile time
    samples/        working example programs
    editor/vscode/  VS Code extension (syntax highlighting + language server)
    INSTALL.md      human-facing setup
    EDITOR_SETUP.md human-facing editor setup

## Ground rules

- **Do not suggest a package manager.** There is no `brew install yoopiler`,
  no npm package to install, no repository to clone. This directory is the
  entire distribution.
- **Do not run `npm install` anywhere.** Nothing here needs it. The extension
  already has its `node_modules`.
- **Node.js is not required.** It is compiled into the binary. Do not have the
  user install it.
- **`clang` IS required** and cannot be bundled. This is the one real
  dependency.
- **Never move `bin/{{BIN}}` out of the directory.** It locates `lib/`
  relative to itself. Moving the whole folder is fine; moving just the binary
  breaks it. If the user wants it on their PATH, add the `bin` directory to
  PATH rather than copying the file out.

## Setup, in order

Do these in sequence and verify each before moving on.

### Step 1 (macOS only): clear the quarantine flag

Skip on Linux and Windows. On macOS this is mandatory and must come first.

    cd /path/to/{{TARGET}}
    xattr -dr com.apple.quarantine .

Why: the binary is ad-hoc signed, not notarized (the author has not paid for
an Apple Developer certificate). macOS flags anything arriving via browser,
email, or chat, and Gatekeeper then kills it **with no error message at all**.

Verify:

    ./bin/{{BIN}} --list-attributes

Expect a short list of attribute names. If the shell prints nothing and the
exit status is 137, the quarantine flag is still set somewhere; re-run the
`xattr` command from inside the directory and check you did not miss a nested
copy.

### Step 2: confirm clang

    clang --version

If missing:

- macOS: `xcode-select --install`
- Debian / Ubuntu: `sudo apt install clang`
- Fedora: `sudo dnf install clang`
- Windows: install LLVM from <https://releases.llvm.org>

If clang exists but somewhere unusual, set `YOOP_CLANG` to its full path
instead of trying to move it.

### Step 3: compile a known-good sample

Always start with a shipped sample, never with new code. This separates "the
install is broken" from "the program has a bug".

    ./bin/{{BIN}} samples/hello.yoop
    ./samples/hello

Expect it to print a greeting. The compiler writes the executable next to the
source with the `.yoop` dropped; `-o path` overrides that.

Once this works, the installation is good.

### Step 4 (optional): editor support

Only if the user wants it. Full detail is in EDITOR_SETUP.md; the short
version is to copy `editor/vscode` into the extensions folder and fully quit
and reopen VS Code:

    cp -R editor/vscode ~/.vscode/extensions/yoop-lang-0.1.0

The extension finds the compiler automatically **only** when it can see
`../../bin/` relative to itself, which a plain copy breaks. So after copying,
set this in VS Code settings:

    "yoopiler.binaryPath": "/full/absolute/path/to/{{TARGET}}/bin/{{BIN}}"

Use a real absolute path. Not `~`, not a relative path.

Alternatively symlink instead of copying, which preserves auto-detection, but
only if the package directory will stay where it is:

    ln -s "$(pwd)/editor/vscode" ~/.vscode/extensions/yoop-lang-0.1.0

Other editors: the language server speaks standard LSP over stdio via
`{{BIN}} --lsp`. Register that for `*.yoop`. Syntax highlighting is VS Code
only.

## Helping them write Yooperlang

The language looks like TypeScript but is not TypeScript, and it is obscure
enough that you have most likely never seen it. **Read `samples/` before
writing any code** - they are known-correct and show real usage. Prefer
copying their patterns over inventing syntax.

Non-obvious rules that commonly trip people up:

- **No turbofish on namespaced generic calls.** Write
  `let v: Vec<int32> = vec.vecNew(4);` and let the binding annotation drive
  inference. `vec.vecNew<int32>()` is a parse error.
- **Kind keywords must be imported.** `disposable` and friends are declared in
  the standard library, not built into the grammar:
  `import { disposable } from "std/core/kinds.yoop";`
- **Trait methods are called trait-qualified**, as
  `Greeter.greet(ref m)`. Both `m.greet()` and a bare `greet(ref m)` are
  errors.
- **Values imported from `std/` must use the namespace form.**
  `import * as vec from "std/core/vec.yoop";` is required for functions and
  constants. Types, traits, and kinds may be imported by name with braces.
- **`printf` with an explicit format literal behaves like C.** The `%`
  directives in the literal are authoritative. Template literals
  (backticks with `${...}`) are usually the friendlier choice.

When something does not compile, trust the compiler's message. Diagnostics
carry a file, line, column, and a caret pointing at the span, and they are
usually accurate. Do not guess at rewrites; read the error.

The `--keep-ir` flag prints the path to the generated LLVM IR, which is
occasionally useful for explaining what a construct lowers to.

## Failure modes

Match on the exact symptom.

**Command produces no output at all, exit status 137.**
macOS Gatekeeper killed it. Step 1 was skipped or incomplete. This is the most
common failure by a wide margin, and the silence makes it look like a hang or
a corrupt download. It is neither.

**"clang not found (tried ...)".**
Step 2. The message means the compiler front end worked fine and only the link
step failed, so the install itself is good.

**"yoopiler installation looks incomplete".**
`lib/` is missing or the binary was moved out of `bin/`. Re-extract the
archive and keep the directory intact.

**"cannot resolve import ... file not found" for a `std/...` path.**
Same cause: an incomplete extraction. Confirm `lib/std/core/` has `.yoop`
files in it.

**Binary will not execute, "bad CPU type" or similar.**
Wrong platform. This package is {{PLATFORM_HUMAN}} only.

**Editor shows colors but no error squiggles or hovers.**
The language server is not running. Open View > Output and select "Yoopiler
(extension)" from the dropdown; it logs which server it tried to launch.
Almost always the fix is setting `yoopiler.binaryPath` to an absolute path.

**VS Code does nothing at all on a `.yoop` file.**
The extension was not loaded. Check the directory really is at
`~/.vscode/extensions/yoop-lang-0.1.0` with `package.json` and `node_modules`
inside, then fully quit and reopen VS Code. Reload Window is often not enough.

**A sample fails to compile.**
This should not happen; every sample is verified against this exact binary at
package time. If one does fail, it indicates a corrupt or partial extraction
rather than a user error. Re-extract and try again.
