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

Heavily leaned on LLMs to clean original work and do a significant portion of codegen. The goal is to learn and have fun and rewrite by hand as we grapple with unfamiliar concepts that the LLMs showed at least a seemingly working happy path for. The legacy version of this language is available if folks want to check that out which was mostly hung up around very basic typechecking before needing to use lots of help.

("Yooper" is what you call someone from Michigan's Upper Peninsula. The name is a bit of a joke, and so is this language.)

## Personal Objective

The main objective with this project, is to help me avoid making unreadable and overabstracted code. This language discourages deeply nested abstractions and forces call-site obligations, which is maybe not a good thing, I don't know. The secondary objective is to learn about compilers. This one is so heavily built up with AI bridging real gaps, that I will need to make another language still to understand better, but I am still enjoying working on it. If other folks help out at some point, these personal stories will likely be abstracted away.

## Status

This is a re-imagining of a version I first wrote in C and have since abandoned. The compiler is written in Yooperlang and compiles itself. Its source is [bootstrap/](bootstrap/), and because a self-hosted compiler needs a compiler to start from, a build begins at a SEED: a previously released `yoopiler_boot` binary, resolved by [scripts/seed.mjs](scripts/seed.mjs).

The workflow is - that I write as much as I "know" and have AI help me understand some of the deep topics and bring the current version into a working state and I scrutinize how it works and try to understand more and more. I eventually rewrite the feature in the bootstrap side or take another pass at it myself to learn. The emitted LLVM IR is relatively simple, but each new concept is harder and harder to understand.

What works today: a "working" chunk of the pipeline (lex, parse, typecheck, codegen, link). That covers structs, traits, kinds, generics, enums and unions, error handling, tasks and concurrency, and a starting standard library (`std/core`, `std/net`, `std/http`, `std/collections`). The compiler compiles itself, and a release is refused unless the second and third stages of that build come out byte-identical.

Typically I will begin writing a small document about the next portion of the language to work on and have a few iterations with LLMs to build out a plan and some pseudocode and begin implementation from there. Ideally very little of the compiler is AI generated, but there are some parts of codegen and LLVM and the C-runtime edges that I will lean on some AI implementation to get a better understanding to see it working in the context of this language.

It is likely that parts of the language get ripped out or rewritten by hand once an understanding of how a particular feature works in the full pipeline after I've written most of the front-end. Like memory allocators, and such. I didn't really understand how they might be implemented beyond the syntax and so most of the lowering was AI-assisted and is slowly being replaced.

It's a moving target and a learning project. I'm new to compilers outside of small DSLs and school projects, so expect rough edges.

### dev platform and build target NOTE

Most of this was written on a macbook in coffee shops and kids' softball
tournament downtimes, with the occasional pass on windows and linux. macOS
(arm64 and intel) and linux (x86_64) both build and pass the full suite today;
windows builds but has not been re-verified as recently.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the suites on
ubuntu-latest, so linux x86_64 is the one platform a green check speaks for.
For macOS and windows, "it works there" means "someone ran it there recently".
Cross-platform bugs here tend to be of one shape - a platform that was never
wired up, silently contributing nothing, rather than doing something visibly
wrong. See [Linux setup](#linux-setup)
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

- `clang` on your `PATH` - the compiler emits LLVM IR and shells out to clang to link it
- Node.js 22 or newer, only if you are working in a checkout: the compiler is a native
  binary, but the seed script, the test suites and the site generator run on Node
- the GitHub CLI (`gh`), authenticated, the first time a checkout downloads its seed

Grab a release from <https://github.com/tkarnau/yooperlang/releases>, unpack it,
and compile a program:

```bash
tar -xzf yoopiler-boot-0.2.0-linux-x64.tar.gz
yoopiler-boot-0.2.0-linux-x64/bin/yoopiler_boot hello.yoop -o hello
./hello
```

A release holds the compiler in `bin/` and the standard library and C runtime in
`lib/`. The binary finds them beside itself, so there is nothing to configure -
keep `bin/` and `lib/` together and move them together.

Or build the compiler from a checkout. `node scripts/seed.mjs` prints the seed's
path, downloading it into the gitignored `.seed/` the first time:

```bash
YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime \
  $(node scripts/seed.mjs) bootstrap/src/main.yoop -o /tmp/yoopiler_boot

YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime \
  /tmp/yoopiler_boot examples/intro/hello.yoop -o /tmp/hello
/tmp/hello
```

Those two variables point a compiler at THIS tree's `std/` and `runtime/`, which
a stage built into `/tmp` has no `lib/` beside it to find.

The whole command line:

```text
yoopiler_boot <entry.yoop> [-o <out>] [--emit-ir]
yoopiler_boot --test <dir-or-file> [filter...]
```

`-o` says where the executable goes and defaults to `a.out`; the IR is always
written beside it as `<out>.ll`. `--emit-ir` stops there, before clang. The entry
file pulls in everything else through its imports, so you name one file no matter
how many the program is.

A few environment variables are available when the defaults don't fit:

- `YOOP_STD_ROOT` - the `std/` directory to import `std/...` paths from
- `YOOP_RUNTIME_ROOT` - the directory holding the C runtime sources
- `YOOP_SEED` - a `yoopiler_boot` binary to build with, instead of downloading one
- `YOOP_LIB_PATH` and `YOOP_INCLUDE_PATH` - extra `-L` and `-I` directories for the link

## Linux setup

Everything below is optional except the first line - clang, plus Node for the
scripts in a checkout, is the whole hard requirement. The rest only matters if
you want the graphical examples or a debugger to read the DWARF the compiler
emits.

```bash
# Arch
sudo pacman -S clang nodejs npm          # required
sudo pacman -S sdl2 mesa                 # graphical examples
sudo pacman -S lldb                      # reading DWARF (npm run test:debug)

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
volta) - it is only needed in a checkout, for the seed script and the test
suites, and it does not care which.

Check it works, straight through the seed compiler:

```bash
YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime \
  $(node scripts/seed.mjs) examples/intro/hello.yoop -o /tmp/hello && /tmp/hello
```

`npm install` is only for the test runner, so run it before `npm test`.

### Graphical examples

`sdl2` and `mesa` above are what [examples/playground/nebula_arena/](examples/playground/nebula_arena/)
and [examples/playground/shader_demo/](examples/playground/shader_demo/) need.
Programs name their libraries in the source - `extern "C" from library "SDL2"`
and `extern "C" from library "framework:OpenGL"` - so there are no flags to pass:

```bash
YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime \
  /tmp/yoopiler_boot examples/playground/nebula_arena/main.yoop -o /tmp/nebula && /tmp/nebula
```

`framework:OpenGL` is the portable spelling. It is an Apple concept by origin,
and it lowers per platform: `-framework OpenGL` on macOS, `-lopengl32` on
windows, `-lGL` on linux.

### Editor

The VS Code extension is in [editors/vscode/](editors/vscode/). It gives you
syntax highlighting, bracket matching and comment toggling, and DIAGNOSTICS:
it starts `yoopiler_boot --lsp`, which is the compiler itself speaking the
Language Server Protocol, so the squiggles are the errors a build would report.
Nothing beyond that is implemented - no hovers, no go-to-definition, no
completion - and the F5 debug launch does not work today. Point
`yoopiler.binaryPath` at a `yoopiler_boot` binary and:

```bash
cd editors/vscode && npm install && cd ../..
ln -s "$PWD/editors/vscode" ~/.vscode/extensions/yoop-lang.yoop-lang-0.1.0
```

Restart VS Code afterwards - it only scans that directory at startup. Full
notes are in [editors/vscode/README.md](editors/vscode/README.md).

### Running the tests

```bash
npm install       # test runner deps only
npm test          # every Node-driven suite: 460 tests, needs clang
npm run test:unit # fast, no clang
```

The compiler's own Yoop tests are the largest body of coverage in the tree, and
they need nothing but a compiler - 1390 of them, out of one build:

```bash
YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime \
  $(node scripts/seed.mjs) --test bootstrap/src
```

The C runtime also has its own suite that runs without Node, and it will use
`valgrind` for leak checking when one is installed:

```bash
bash runtime/tests/run_tests.sh
```

## Packaging the compiler

To hand someone a compiler:

```bash
npm run package:boot
```

That builds three stages - the seed builds the compiler, the compiler builds
itself, and that one builds it again - and refuses to package unless stage2 and
stage3 come out byte-identical, as IR and as binaries. It then stages the
package, compiles and runs `hello.yoop` with the packaged binary and no
environment overrides (the only step that proves the layout is the one discovery
finds), and writes `dist/yoopiler-boot-<version>-<platform>-<arch>.tar.gz` with a
`.sha256` beside it.

The directory inside the tarball:

```text
bin/yoopiler_boot  the compiler
lib/std/           the standard library, as .yoop source
lib/runtime/       the C runtime sources handed to clang
README.md          setup instructions for whoever you send it to
```

`lib/` stays outside the binary because clang is a separate process and needs
real files at real paths. The whole directory is relocatable - the binary finds
`lib/` beside itself - but `bin/` and `lib/` have to move together.

Two caveats. The build produces a binary for the machine it runs on, so build on
each platform you want to ship. And `clang` is still required at run time: this
packages the compiler, not the toolchain underneath it. On macOS the binary is
not notarized, so a recipient who downloads it has to clear the quarantine flag
(`xattr -dr com.apple.quarantine .`) or Gatekeeper kills it with no error
message - the shipped README leads with this.

The shipped README is generated from [packaging/bootstrap_readme.md](packaging/bootstrap_readme.md).

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
- [bootstrap/README.md](bootstrap/README.md) - the compiler's module map, layer by layer
- [docs/writing_yoop.md](docs/writing_yoop.md) - how to write Yooperlang itself (std, the compiler, tools, examples)

Run the tests:

```bash
npm test          # every Node-driven suite (needs clang)
npm run test:unit # fast, no clang
npm run test:e2e  # the suites that build and run programs, needs clang
```

## License

MIT - see [LICENSE](LICENSE).
