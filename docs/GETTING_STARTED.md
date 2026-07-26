# Getting started with Yooperlang

This walks you from nothing to a running Yooperlang program in a few minutes.

## 1. Install the prerequisites

You need two things:

- **Node.js 18 or newer** - the compiler itself is written in plain JavaScript
  and runs on Node. There are no dependencies, so there is no `npm install`
  step.
- **clang** - the compiler emits LLVM IR text and shells out to `clang` to link
  it into a native executable.

Check that you have both:

```bash
node --version    # should print v18.x or higher
clang --version   # should print a clang version
```

Getting clang:

- macOS: `xcode-select --install` (ships with the Command Line Tools)
- Debian / Ubuntu: `sudo apt install clang`
- Fedora: `sudo dnf install clang`
- Windows: install LLVM (https://releases.llvm.org) and make sure `clang` is on
  your `PATH`

## 2. Get the code

```bash
git clone https://github.com/tkarnau/yooperlang.git
cd yooperlang
```

## 3. Compile and run your first program

There are small, commented starter programs in [../examples/intro/](../examples/intro/).
Start with hello:

```bash
node ./src/yoopiler.js examples/intro/hello.yoop
./examples/intro/hello
```

You should see:

```
Hello from Yooperlang!
```

The compiler writes the native executable next to the source file, using the
same name without the `.yoop` extension. So `examples/intro/hello.yoop` produces
`examples/intro/hello`.

To compile your own file somewhere else:

```bash
node ./src/yoopiler.js path/to/program.yoop
./path/to/program
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

There is also a browsable reference site in [../web/](../web/). It is a static
site with no build step - serve it with any static file server:

```bash
# Python 3
python3 -m http.server -d web 8080

# or Node, no install
npx --yes serve web -l 8080
```

Then open <http://localhost:8080/>.

## Where to go next

- if using vscode: try installing the debugger, LSP, and syntax highlighting in the [editors/vscode](../editors/vscode/README.md) folder
- [../SPEC.md](../SPEC.md) - the language spec, syntax first
- [../plans/](../plans/) - the current focus and small consolidated plan ([../plans/archive/roadmap.md](../plans/archive/roadmap.md) for the full historical phase map)
- [../CONTRIBUTING.md](../CONTRIBUTING.md) - running the tests, hacking on the
  compiler
