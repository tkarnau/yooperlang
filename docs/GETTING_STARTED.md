# Getting started with Yooperlang

This walks you from nothing to a running Yooperlang program in a few minutes.

## 1. Install the prerequisites

You need:

- **clang** - the compiler emits LLVM IR text and shells out to `clang` to link
  it into a native executable.
- **Node.js 22 or newer**, if you are working from a checkout. The compiler is a
  native binary, but the script that fetches the seed compiler and the test
  suites run on Node.
- **the GitHub CLI (`gh`)**, authenticated, the first time a checkout fetches its
  seed compiler.

Check that you have them:

```bash
clang --version   # should print a clang version
node --version    # should print v22.x or higher
```

Getting clang:

- macOS: `xcode-select --install` (ships with the Command Line Tools)
- Debian / Ubuntu: `sudo apt install clang`
- Fedora: `sudo dnf install clang`
- Windows: install LLVM (https://releases.llvm.org) and make sure `clang` is on
  your `PATH`

## 2. Get a compiler

The quickest way is a release from
<https://github.com/tkarnau/yooperlang/releases>. Unpack it and the compiler is
`bin/yoopiler_boot`, with the standard library and C runtime in `lib/` beside it:

```bash
tar -xzf yoopiler-boot-0.2.0-linux-x64.tar.gz
yoopiler-boot-0.2.0-linux-x64/bin/yoopiler_boot --list-attributes
```

To work on the language itself, clone the repository instead. The compiler is
written in Yooperlang, so building it starts from a SEED - a previously released
`yoopiler_boot`, which `scripts/seed.mjs` finds and downloads on first use:

```bash
git clone https://github.com/tkarnau/yooperlang.git
cd yooperlang

YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime \
  $(node scripts/seed.mjs) bootstrap/src/main.yoop -o /tmp/yoopiler_boot
```

The two variables point the compiler at this checkout's `std/` and `runtime/`.
A compiler unpacked from a release finds its own and needs neither.

## 3. Compile and run your first program

There are small, commented starter programs in [../examples/intro/](../examples/intro/).
Start with hello:

```bash
YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime \
  /tmp/yoopiler_boot examples/intro/hello.yoop -o /tmp/hello
/tmp/hello
```

You should see:

```
Hello from Yooperlang!
```

`-o` says where the executable goes, and defaults to `a.out` in the current
directory. The LLVM IR is always written beside the executable as `<out>.ll`;
`--emit-ir` stops there and never calls clang.

To compile your own file:

```bash
yoopiler_boot path/to/program.yoop -o program
./program
```

## 4. Walk through the starter programs

In rough order of difficulty:

1. [hello.yoop](../examples/intro/hello.yoop) - `main`, `printf`, exit codes
2. [fibonacci.yoop](../examples/intro/fibonacci.yoop) - variables, a `while`
   loop, template-literal string interpolation
3. [structs_and_traits.yoop](../examples/intro/structs_and_traits.yoop) -
   defining data with `type`, behavior with `trait`, trait-qualified calls
4. [generics.yoop](../examples/intro/generics.yoop) - generic functions with a
   trait bound

For longer worked examples, browse [../examples/playground/](../examples/playground/).

## 5. View the language reference

The full language specification is in [../SPEC.md](../SPEC.md).

The site at <https://tkarnau.github.io/yooperlang/> is the friendlier way in:
a five-program tour that starts at downloading the compiler, an explorer that walks one program
from source through tokens, AST and LLVM IR to its output, the language
reference, and a standard-library browser generated from `std/` itself.

The same site is in [../web/](../web/) and needs no build step. Serve it with
any static file server:

```bash
# Python 3
python3 -m http.server -d web 8080

# or Node, no install
npx --yes serve web -l 8080
```

Then open <http://localhost:8080/>. Opening `web/index.html` straight from the
filesystem works too.

The code, output and diagnostics the site shows are captured by actually
building this checkout's compiler and running it, so after changing `std/` or
the tour programs, regenerate them:

```bash
npm run gen:web
```

## Where to go next

- if using vscode: syntax highlighting for `.yoop` files is in the [editors/vscode](../editors/vscode/README.md) folder
- [../SPEC.md](../SPEC.md) - the language spec, syntax first
- [writing_yoop.md](writing_yoop.md) - current practice for writing Yoop: kinds,
  `string` versus `Text`, arenas, errors, async, modules, tests
- [../CONTRIBUTING.md](../CONTRIBUTING.md) - running the tests, hacking on the
  compiler
