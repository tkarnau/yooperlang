# Yooperlang

A systems language attempt with a TypeScript syntax feel - for myself and folks who want to try a stab at a systems language attempt that looks like something they are more familiar with.

- No garbage collector, but you can opt in to / build one
- No classes - structs plus free functions
- Traits for shared behaviour, without inheritance
- Compiles to LLVM IR and shells out to `clang` to produce a native executable
- **Kinds** - you declare a compile-time rule (`mustCall dispose beforeScopeEnd`,
  `mustNotEscape scope`, `mustNotShare acrossThreads`) and the compiler enforces
  it. The language's own `disposable` / `async` / `task` are written this way, in
  std, not baked into the compiler. See [A taste](#a-taste).

("Yooper" is what you call someone from Michigan's Upper Peninsula. The name is a bit of a joke, and so is this language.)

## Personal Objective

The main objective with this project, is to help me avoid making unreadable and overabstracted code. This language discourages deeply nested abstractions and forces call-site obligations, which is maybe not a good thing, I don't know. The secondary objective is to learn about compilers. This one is so heavily built up with AI bridging real gaps, that I will need to make another language still to understand better, but I am still enjoying working on it. If other folks help out at some point, these personal stories will likely be abstracted away.

## Status

This is a re-imagining of a version I first wrote in C and have since abandoned. The current compiler is written in JavaScript (plain Node, no build tools, no dependencies) for readability by me (having lived in web languages and node backend worlds for a bit too long,) with the long-term plan of bootstrapping the compiler in Yooperlang itself once enough of the language is in place.

The workflow is - that I write as much as I "know" and have AI help me understand some of the deep topics and bring the current version into a working state and I scrutinize how it works and try to understand more and more. I eventually rewrite the feature in the bootstrap side or take another pass at it myself to learn. The emitted LLVM IR is relatively simple, but each new concept is harder and harder to understand.

What works today: a "working" chunk of the pipeline (lex, parse, typecheck, codegen, link). That covers structs, traits, kinds, generics, enums and unions, error handling, tasks and concurrency, and a starting standard library (`std/core`, `std/net`, `std/http`, `std/collections`). Self-hosting (rewriting the compiler in Yooperlang itself) is the current focus, to unlock some iteration on a bytecode layer and feel the language out; the bootstrap compiler under [bootstrap/](bootstrap/) already compiles itself.

Typically I will begin writing a small document about the next portion of the language to work on and have a few iterations with LLMs to build out a plan and some pseudocode and begin implementation from there. Ideally very little of the compiler is AI generated, but there are some parts of codegen and LLVM and the C-runtime edges that I will lean on some AI implementation to get a better understanding to see it working in the context of this language.

It is likely that parts of the language get ripped out or rewritten by hand once an understanding of how a particular feature works in the full pipeline after I've written most of the front-end. Like memory allocators, and such. I didn't really understand how they might be implemented beyond the syntax and so most of the lowering was AI-assisted and is slowly being replaced.

It's a moving target and a learning project. I'm new to compilers outside of small DSLs and school projects, so expect rough edges.

### dev platform and build target NOTE

Most of this was written on a macbook in coffee shops and kids' softball
tournament downtimes, with the occasional pass on windows and linux. macOS
(arm64 and intel) and linux (x86_64) both build and pass the full suite today;
windows builds but has not been re-verified as recently.

There is still no build server, so "works on the other two" means "someone ran
it there recently" rather than "CI says so". Cross-platform bugs here tend to be
of one shape - a platform that was never wired up, silently contributing
nothing, rather than doing something visibly wrong. See [Linux setup](#linux-setup)
for what the linux bring-up needed.

## A taste

Every language hands you a fixed set of modifiers - `const`, `async`,
`static`, `mut`. Yooperlang lets you declare your own, and then enforces them
like type errors.

```yoop
kind scoped {
    appliesTo binding parameter;
    requires Disposable;
    mustCall dispose beforeScopeEnd;   // it has to be cleaned up
    mustNotEscape scope;               // and it must not leave
}

function bad(): FileHandle {
    scoped a: FileHandle = { fd: 1 };
    return a;
}
```

```text
examples/fail/scoped_escape_return.yoop:26:13: binding 'a' has kind 'scoped' which forbids escape via return
   |
26 |     return a;
   |             ^
```

Nothing in the compiler knows what `scoped` is. It reads those four clauses and
enforces them at every use site - and that is also how the language's own
vocabulary works. `disposable`, `async`, `task` and `owned` are not keywords.
They are kinds, declared in [std/core/kinds.yoop](std/core/kinds.yoop) in this
exact syntax, and you can write your own next to them.

That program is [examples/fail/scoped_escape_return.yoop](examples/fail/scoped_escape_return.yoop),
and the error above is what the compiler actually prints for it.

The rest reads about how you'd guess:

```yoop
type Megaphone implements Greeter {
    n: int32,
    function greet(ref self): int32 {
        return self.n * 10;
    }
}
```

## Quick start

Prerequisites:

- Node.js 22 or newer (no `npm install` needed - the compiler has zero dependencies)
- `clang` on your `PATH` (codegen emits LLVM IR and links it with clang)

Install the compiler, then compile and run a program:

```bash
npm install -g yooperlang
yoopiler_alpha hello.yoop
./hello
```

Or run it straight from a checkout, no install step:

```bash
node ./src/yoopiler.js examples/intro/hello.yoop
./examples/intro/hello
```

The compiler writes a native executable next to the input file (same name, no `.yoop` extension) - you can use the `-o {path}` to override this.

A few environment variables are available when the defaults don't fit:

- `YOOP_CLANG` - full path to clang, if it isn't on your `PATH`
- `YOOP_STD_ROOT` - the `std/` directory to import `std/...` paths from
- `YOOP_RUNTIME_DIR` - the directory holding the C runtime sources

And `--keep-ir` keeps the generated `.ll` around and prints its path, which is handy when you want to read the IR for a program.

## Linux setup

Everything below is optional except the first line - Node and clang are the
whole hard requirement, and the rest only matters if you want the graphical
examples, the editor, or the debugger.

```bash
# Arch
sudo pacman -S clang nodejs npm          # required
sudo pacman -S sdl2 mesa                 # graphical examples
sudo pacman -S lldb                      # F5 debugging in VS Code

# Debian / Ubuntu
sudo apt install clang nodejs npm
sudo apt install libsdl2-dev libgl1-mesa-dev
sudo apt install lldb

# Fedora
sudo dnf install clang nodejs npm
sudo dnf install SDL2-devel mesa-libGL-devel
sudo dnf install lldb
```

Node 22 or newer, from your distro or from a version manager (nvm / fnm /
volta) - the compiler does not care which.

Check it works:

```bash
node src/yoopiler.js examples/intro/hello.yoop -o /tmp/hello && /tmp/hello
```

That needs no `npm install`: the compiler itself has zero runtime dependencies.
`npm install` is only for the test runner and the packaging scripts, so run it
before `npm test`.

### Graphical examples

`sdl2` and `mesa` above are what [examples/playground/nebula_arena/](examples/playground/nebula_arena/)
and [examples/playground/shader_demo/](examples/playground/shader_demo/) need.
Programs name their libraries in the source - `extern "C" from library "SDL2"`
and `extern "C" from library "framework:OpenGL"` - so there are no flags to pass:

```bash
node src/yoopiler.js examples/playground/nebula_arena/main.yoop -o /tmp/nebula && /tmp/nebula
```

`framework:OpenGL` is the portable spelling. It is an Apple concept by origin,
and it lowers per platform: `-framework OpenGL` on macOS, `-lopengl32` on
windows, `-lGL` on linux.

### Editor

The VS Code extension is in [editors/vscode/](editors/vscode/) and gives you
diagnostics, hover, go-to-definition, find-references, rename, completion, and
an outline:

```bash
cd editors/vscode && npm install && cd ../..
ln -s "$PWD/editors/vscode" ~/.vscode/extensions/yoop-lang.yoop-lang-0.1.0
```

Restart VS Code afterwards - it only scans that directory at startup. Full
notes, including the debugger, are in [editors/vscode/README.md](editors/vscode/README.md).

### Running the tests

```bash
npm install       # test runner + packaging deps only
npm test          # everything: ~1270 tests, needs clang
npm run test:unit # fast, no clang
```

The C runtime also has its own suite that runs without Node, and it will use
`valgrind` for leak checking when one is installed:

```bash
bash runtime/tests/run_tests.sh
```

## Building a standalone binary

If you'd rather hand someone a compiler that doesn't need Node installed:

```bash
npm install          # only for the build tooling; the compiler itself still has no runtime deps
npm run package      # build, verify the samples, and zip it up
```

That produces `dist/yoopiler-alpha-<version>-<platform>-<arch>.zip`, ready to hand to someone. Use `npm run build:sea` instead if you only want the unzipped directory.

That writes `dist/yoopiler-<platform>-<arch>/`:

```text
bin/            the compiler (Node is baked in)
lib/            std library + C runtime it reads at compile time
samples/        whatever you put in packaging/samples/
editor/vscode/  the VS Code extension, node_modules included
INSTALL.md      setup instructions for whoever you send it to
EDITOR_SETUP.md editor + LSP instructions
AI_SETUP.md     a runbook to paste into an AI assistant (npm run package only)
```

The whole directory is relocatable - move it anywhere, and the binary finds its data files relative to itself. It's around 114 MB (35 MB zipped), because a single-executable build embeds the Node runtime.

To change what ships in `samples/`, add or remove `.yoop` files in [packaging/samples/](packaging/samples/); the build copies the directory as-is. The editor instructions are [packaging/editor_setup.md](packaging/editor_setup.md).

The bundled extension needs no configuration: it auto-detects the compiler at `../../bin/` relative to itself, and drives it via `yoopiler_alpha --lsp`, so a recipient gets diagnostics, hover, and go-to-definition without a repo or a Node install.

Three caveats. The build copies the *running* Node binary, so it only produces a binary for the machine it runs on - build on each platform you want to ship. `clang` is still required at run time: this packages the compiler, not the toolchain underneath it. And on macOS the binary is ad-hoc signed rather than notarized, so a recipient who downloads it has to clear the quarantine flag (`xattr -dr com.apple.quarantine .`) or Gatekeeper kills it with no error message - the generated INSTALL.md leads with this.

## Try it

A few small, self-contained programs to start with:

- [examples/intro/](examples/intro/) - tiny, heavily commented starter programs
- [examples/playground/calculate_primes/](examples/playground/calculate_primes/) - a longer worked example
- [examples/playground/dynamic_array/](examples/playground/dynamic_array/) - generics and heap allocation
- [examples/playground/nebula_arena/](examples/playground/nebula_arena/) - a small SDL2 + OpenGL game, once you have those installed (see [Linux setup](#linux-setup))

There are also hundreds of feature fixtures under [examples/pass/](examples/pass/) (programs that should compile) and [examples/fail/](examples/fail/) (programs that should be rejected, used as compiler tests).

## Learn the language

- [SPEC.md](SPEC.md) - the language specification (syntax first, with examples)
- <https://tkarnau.github.io/yooperlang/> - the site: a five-program tour that starts at downloading the compiler, a compiler-pipeline explorer, the language reference, and a generated standard-library browser (source in [web/](web/), regenerate its data with `npm run gen:web`)
- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) - install, first program, where to go next
- [tools/mcp-reference/](tools/mcp-reference/) - an MCP server that exposes the spec and standard library to AI assistants (Claude, Cursor, ...) so they can search the reference while you write Yooperlang

## Contributing / hacking on the compiler

- [CONTRIBUTING.md](CONTRIBUTING.md) - how to run the tests and the lay of the land
- [docs/compiler_internals.md](docs/compiler_internals.md) - the architecture deep-dive (subsystem map, invariants, design notes)
- [docs/writing_yoop.md](docs/writing_yoop.md) - how to write Yooperlang itself (std, the bootstrap compiler, tools, examples)

Run the tests:

```bash
npm test          # everything (needs clang)
npm run test:unit # fast, no clang
npm run test:e2e  # full pipeline, needs clang
```

## License

MIT - see [LICENSE](LICENSE).
