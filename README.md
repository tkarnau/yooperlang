# Yooperlang

An attempt at a systems language with a TypeScript syntax feel, for myself and
for folks who want a stab at systems work in something that looks more
familiar.

- No garbage collector, but you can opt in to / build one
- No classes - structs plus free functions
- Traits for shared behaviour, without inheritance
- Compiles to LLVM IR and shells out to `clang` to produce a native executable
- **Kinds** - you declare a compile-time rule (`mustCall dispose
  beforeScopeEnd`, `mustNotEscape scope`, `mustNotShare acrossThreads`) and the
  compiler enforces it. The language's own `disposable` / `async` / `task` are
  written this way, in std, not baked into the compiler. See [A
  taste](#a-taste).

("Yooper" is what you call someone from Michigan's Upper Peninsula. The name is
a bit of a joke, and so is this language.)

## Status

A re-imagining of a version I first wrote in C and have since abandoned. The
compiler is written in Yooperlang and compiles itself, so a build starts from a
SEED: a previously released `yoopiler_boot`, resolved by
[scripts/seed.mjs](scripts/seed.mjs). Source is in [bootstrap/](bootstrap/).

Working today: lex, parse, typecheck, codegen and link, covering structs,
traits, kinds, generics, enums and unions, error handling, tasks and
concurrency, and a starting std (`std/core`, `std/net`, `std/http`,
`std/collections`).

I leaned on LLMs heavily around codegen, LLVM and the C runtime edges, the
parts I did not understand well enough to write cold. The pattern is to get it
working, read it until I understand it, then rewrite it by hand; plenty is
still waiting on that pass. What I was after is a language that discourages
deep nesting and forces call-site obligations, because that is the kind of code
I keep writing myself into. Whether that is a good idea I don't know yet. I'm
new to compilers outside small DSLs and school projects, so expect rough edges.

**Platforms.** macOS (arm64 and intel) and linux (x86_64) build and pass the
full suite; windows builds but has not been re-verified recently. CI runs on
ubuntu-latest, so linux x86_64 is the one platform a green check speaks for.

## A taste

Most languages give you a fixed set of modifiers: `const`, `async`, `static`,
`mut`. Here you declare your own, and the compiler enforces them at every use
site.

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
[error] examples/fail/scoped_escape_return.yoop:26:13: "a" is bounded by the scope that declares it (mustNotEscape scope), so it cannot be returned out of one
```

Nothing in the compiler knows what `scoped` is; it reads those four clauses.
The language's own vocabulary works the same way: `disposable`, `async`, `task`
and `owned` are not keywords, they are kinds declared in
[std/core/kinds.yoop](std/core/kinds.yoop) in this exact syntax. That program
is
[examples/fail/scoped_escape_return.yoop](examples/fail/scoped_escape_return.yoop)
and that is its error, with the leading path shortened.

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

`clang` on your `PATH` is the one hard requirement. A checkout also wants Node
22+ and, the first time it downloads a seed, an authenticated `gh`.

Grab a release from <https://github.com/tkarnau/yooperlang/releases>:

```bash
tar -xzf yoopiler-boot-0.2.0-darwin-arm64.tar.gz   # or -linux-x64
cd yoopiler-boot-0.2.0-darwin-arm64
xattr -dr com.apple.quarantine .                   # macOS only, see Setup
bin/yoopiler_boot hello.yoop -o hello && ./hello
```

Keep `bin/` and `lib/` together and move them together; the binary finds std
and the C runtime beside itself, so there is nothing to configure.

Or build from a checkout. Every command below assumes these, which point a
compiler at THIS tree instead of whatever std shipped beside it:

```bash
export YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime
$(node scripts/seed.mjs) bootstrap/src/main.yoop -o /tmp/yoopiler_boot
/tmp/yoopiler_boot examples/intro/hello.yoop -o /tmp/hello && /tmp/hello
```

`node scripts/seed.mjs` prints the seed's path, downloading it into the
gitignored `.seed/` the first time.

### Command line

```text
yoopiler_boot <entry.yoop> [-o <out>] [--emit-ir]
yoopiler_boot --test <dir-or-file> [filter...]
```

`-o` defaults to `a.out`, and the IR is always written beside it as `<out>.ll`.
`--emit-ir` stops there, before clang. You name one entry file no matter how
many the program is; imports pull in the rest.

Other environment variables: `YOOP_SEED` (a `yoopiler_boot` to build with
instead of downloading one), `YOOP_LIB_PATH` and `YOOP_INCLUDE_PATH` (extra
`-L` and `-I` for the link).

## Setup

Only the first line of each block is required. The rest is the graphical
examples and a debugger that can read the DWARF the compiler emits.

### macOS

```bash
xcode-select --install        # clang and lldb
brew install node gh          # checkout only
brew install sdl2             # graphical examples (OpenGL ships with the OS)
```

Two macOS-only gotchas:

- **A downloaded release is quarantined.** The binary is not notarized, so
  Gatekeeper kills it with no useful message. `xattr -dr com.apple.quarantine`
  on the unpacked directory clears it. A compiler you built yourself is fine.
- **`npm run test:debug` hangs until macOS has authorized debugging**, once,
  through a GUI prompt. Not a compiler bug: a trivial `int main(){return 0;}`
  under `lldb -o run` hangs identically, which is the check worth running
  first.

### Linux

```bash
# Arch
sudo pacman -S clang nodejs npm && sudo pacman -S sdl2 mesa lldb

# Debian / Ubuntu
sudo apt install clang nodejs npm && sudo apt install libsdl2-dev libgl1-mesa-dev lldb

# Fedora
sudo dnf install clang nodejs npm && sudo dnf install SDL2-devel mesa-libGL-devel lldb
```

Node 22+ from your distro or a version manager (nvm / fnm / volta), it does not
care which. Check either platform works straight through the seed:

```bash
$(node scripts/seed.mjs) examples/intro/hello.yoop -o /tmp/hello && /tmp/hello
```

## Running the tests

```bash
npm install       # test runner deps only
npm test          # every Node-driven suite: 467 tests, needs clang
npm run test:unit # fast, needs no seed
npm run test:e2e  # the suites that build and run programs, needs clang
```

The compiler's own Yoop tests are the largest body of coverage in the tree and
need nothing but a compiler. 1436 of them, out of one build:

```bash
$(node scripts/seed.mjs) --test bootstrap/src
```

The C runtime has its own suite that runs without Node, and uses `valgrind` for
leak checking when one is installed:

```bash
bash runtime/tests/run_tests.sh
```

## Graphical examples

[nebula_arena/](examples/playground/nebula_arena/) (a small SDL2 + OpenGL game)
and [shader_demo/](examples/playground/shader_demo/) need the SDL2 and OpenGL
packages from [Setup](#setup). Programs name their libraries in the source, so
there are no flags to pass:

```bash
/tmp/yoopiler_boot examples/playground/nebula_arena/main.yoop -o /tmp/nebula && /tmp/nebula
```

`framework:OpenGL` is the portable spelling, an Apple concept by origin that
lowers to `-framework OpenGL` on macOS, `-lopengl32` on windows, `-lGL` on
linux.

## Editor

[editors/vscode/](editors/vscode/) gives you highlighting, bracket matching,
comment toggling, and diagnostics from `yoopiler_boot --lsp` (the compiler
itself speaking LSP, so the squiggles are what a build would report). Nothing
else is implemented: no hovers, no go-to-definition, no completion, and F5
debug launch does not work. Point `yoopiler.binaryPath` at a binary, then:

```bash
cd editors/vscode && npm install && cd ../..
ln -s "$PWD/editors/vscode" ~/.vscode/extensions/yoop-lang.yoop-lang-0.1.0
```

Restart VS Code, it only scans that directory at startup. Full notes in
[editors/vscode/README.md](editors/vscode/README.md).

## Packaging the compiler

```bash
npm run package:boot
```

Builds three stages (seed builds the compiler, the compiler builds itself, that
one builds it again), refuses to package unless stage2 and stage3 come out
identical as IR and as binaries, then compiles and runs `hello.yoop` with the
packaged binary and no environment overrides. Output is
`dist/yoopiler-boot-<version>-<platform>-<arch>.tar.gz` plus a `.sha256`,
holding `bin/yoopiler_boot`, `lib/std/`, `lib/runtime/` and a README for the
recipient.

`lib/` stays outside the binary because clang is a separate process and needs
real files at real paths. Two caveats: the build produces a binary for the
machine it runs on, so build on each platform you ship, and `clang` is still
required at run time. This packages the compiler, not the toolchain under it.

## Try it

- [examples/intro/](examples/intro/) - tiny, heavily commented starter programs
- [examples/playground/calculate_primes/](examples/playground/calculate_primes/)
  a longer worked example
- [examples/playground/dynamic_array/](examples/playground/dynamic_array/) -
  generics and heap allocation

Hundreds of feature fixtures live under [examples/pass/](examples/pass/)
(programs that should compile) and [examples/fail/](examples/fail/) (programs
that should be rejected, used as compiler tests).

## Learn the language

- [SPEC.md](SPEC.md) - the language specification (syntax first, with examples)
- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) - install, first program,
  where to go next
- <https://tkarnau.github.io/yooperlang/> - a five-program tour, a pipeline
  explorer, the reference, and a generated std browser (source in [web/](web/))

## Contributing / hacking on the compiler

- [CONTRIBUTING.md](CONTRIBUTING.md) - how to run the tests and the lay of the
  land
- [bootstrap/README.md](bootstrap/README.md) - the compiler's module map, layer
  by layer
- [docs/writing_yoop.md](docs/writing_yoop.md) - how to write Yooperlang itself

## License

MIT - see [LICENSE](LICENSE).
