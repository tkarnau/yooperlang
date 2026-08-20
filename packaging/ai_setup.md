# Instructions for an AI assistant helping someone set this up

Hand this whole file to Claude, ChatGPT, Cursor, or whatever assistant you
prefer, along with "help me get this set up". It contains everything needed to
walk someone through installation and their first program.

If you are that assistant: read all of this before running anything. The failure
modes at the bottom are silent and unguessable, and you will waste the user's
time rediscovering them.

## What this package is

Yooperlang is a small systems language. This is an **alpha compiler**, written in
Yooperlang and compiled by itself. It is a hobby project, not a product, so treat
rough edges as expected rather than as something the user did wrong.

A package is built for ONE platform and will not run on any other. If the
directory name says `linux-x64` and the user is on macOS, stop and tell them they
need a build for their machine.

Layout of the unpacked directory:

    bin/yoopiler_boot   the compiler
    lib/std/            the standard library, as .yoop source
    lib/runtime/        the C runtime sources handed to clang
    README.md           human-facing setup

## Ground rules

- **Do not suggest a package manager.** There is no `brew install yoopiler` and
  no npm package. This directory is the entire distribution.
- **Do not run `npm install` anywhere.** Nothing here needs it.
- **Node.js is not required.** The compiler is a native binary.
- **`clang` IS required** and cannot be bundled. This is the one real dependency.
- **Never move `bin/yoopiler_boot` out of the directory.** It locates `lib/`
  relative to itself. Moving the whole folder is fine; moving just the binary
  breaks it. If the user wants it on their PATH, add the `bin` directory to PATH
  rather than copying the file out.

## Setup, in order

Do these in sequence and verify each before moving on.

### Step 1 (macOS only): clear the quarantine flag

Skip on Linux and Windows. On macOS this is mandatory and must come first.

    cd /path/to/the/unpacked/directory
    xattr -dr com.apple.quarantine .

Why: the binary is not notarized (the author has not paid for an Apple Developer
certificate). macOS flags anything arriving via browser, email, or chat, and
Gatekeeper then kills it **with no error message at all**.

Verify:

    ./bin/yoopiler_boot --list-attributes

Expect a short list of attribute names. If the shell prints nothing and the exit
status is 137, the quarantine flag is still set somewhere; re-run the `xattr`
command from inside the directory and check you did not miss a nested copy.

### Step 2: confirm clang

    clang --version

If missing:

- macOS: `xcode-select --install`
- Debian / Ubuntu: `sudo apt install clang`
- Fedora: `sudo dnf install clang`
- Windows: install LLVM from <https://releases.llvm.org>

clang has to be on PATH; there is no setting that points at one somewhere else.

### Step 3: compile a known-good program

Always start with a tiny program of your own writing, never with the user's real
code. This separates "the install is broken" from "the program has a bug". Put
this in `hello.yoop`:

    function main(): int {
      printf("hello from the yooperlang compiler\n");
      return 0;
    }

Then:

    ./bin/yoopiler_boot hello.yoop -o hello
    ./hello

`-o` says where the executable goes and defaults to `a.out`. The LLVM IR is
always written beside the executable as `<out>.ll`, and `--emit-ir` stops there
without calling clang.

Once this works, the installation is good.

### Step 4 (optional): editor support

Only if the user wants it, and set expectations first: the VS Code extension
lives in the repository, not in this package. It does syntax highlighting and
DIAGNOSTICS - `bin/yoopiler_boot --lsp` is a language server, so squiggles work
once the extension can find that binary - and nothing else. No hovers, no
go-to-definition, no completion.

## Helping them write Yooperlang

The language looks like TypeScript but is not TypeScript, and it is obscure
enough that you have most likely never seen it. **Read `lib/std/` before writing
any code** - it is ordinary readable Yooperlang source, it is known-correct, and
it is the fastest way to see what the language actually offers.

Non-obvious rules that commonly trip people up:

- **No turbofish on namespaced generic calls.** Write
  `let v: Vec<int32> = vec.vecNew(4);` and let the binding annotation drive
  inference. `vec.vecNew<int32>()` is a parse error.
- **Kind keywords must be imported.** `disposable` and friends are declared in
  the standard library, not built into the grammar:
  `import { disposable } from "std/core/kinds.yoop";`
- **Trait methods are called trait-qualified**, as `Greeter.greet(ref m)`. Both
  `m.greet()` and a bare `greet(ref m)` are errors.
- **Values imported from `std/` must use the namespace form.**
  `import * as vec from "std/core/vec.yoop";` is required for functions and
  constants. Types, traits, and kinds may be imported by name with braces.
- **`printf` with an explicit format literal behaves like C.** The `%` directives
  in the literal are authoritative. Template literals (backticks with `${...}`)
  are usually the friendlier choice.

When something does not compile, trust the compiler's message. Diagnostics carry
a file, line, column, and a caret pointing at the span, and they are usually
accurate. Do not guess at rewrites; read the error.

The `.ll` file written beside every executable is the generated LLVM IR, which is
occasionally useful for explaining what a construct lowers to.

## Failure modes

Match on the exact symptom.

**Command produces no output at all, exit status 137.**
macOS Gatekeeper killed it. Step 1 was skipped or incomplete. This is the most
common failure by a wide margin, and the silence makes it look like a hang or a
corrupt download. It is neither.

**A failure that mentions `clang`.**
Step 2. The message means the compiler front end worked fine and only the link
step failed, so the install itself is good.

**"cannot locate the standard library".**
`lib/` is missing or the binary was moved out of `bin/`. Re-extract the archive
and keep the directory intact. `YOOP_STD_ROOT` and `YOOP_RUNTIME_ROOT` override
the search if the user really does want `lib/` somewhere else.

**"cannot resolve import ... file not found" for a `std/...` path.**
Same cause: an incomplete extraction. Confirm `lib/std/core/` has `.yoop` files
in it.

**A failure that mentions `ld:` and a library name.**
That is the link step, not the compiler. Whatever the program named, install it,
or point `YOOP_LIB_PATH` and `YOOP_INCLUDE_PATH` at the tree that has it.

**Binary will not execute, "bad CPU type" or similar.**
Wrong platform. The directory name says which one this package is for.
