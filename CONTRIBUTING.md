# Contributing to Yooperlang

Thanks for taking a look. Yooperlang is a learning project and a moving target,
but issues, questions, and patches are welcome.

## Ground rules

This is a from-scratch compiler with no third-party dependencies. Please keep it
that way: the compiler is Yooperlang plus its own standard library and C runtime,
and the Node scripts around it use nothing but Node's own libraries. (Auxiliary
tooling under `tools/` may have its own isolated dependencies.)

A note on AI: the compiler code is intended to be written by hand, on purpose, so the author
actually understands each piece. AI is used for planning and organizing, not for
generating long-term compiler code. If you send a patch, please understand what it does.
It is okay to use LLMs to assist in adding comments and clarifying code, but
avoid walls of text with complex explanations. If it is a complex topic, prefer
links to extra information beyond what the code is doing.

In docs and comments, keep to plain ASCII: no emdashes, no curly quotes, no
fancy markdown tables.

Branches and idea builds are encouraged and using AI to get an idea moving to
see the ergonomics of trying to write "working" code with that new feature is
valuable. You can write tools as well, but please make sure there are some pass
and/or fail example programs written to validate the compiler features being
added. Every compiler change ships tests, and there are three levels to pick
from: Yoop unit tests (`*.test.yoop` beside the module), the fixture suites
under `bootstrap/tests/slice/`, `examples/pass/` and `examples/fail/`, and the
three-stage self-hosting build. An `.expected` file is written by hand from what
the program should do, never captured from what the compiler currently prints.

## Running the tests

```bash
npm test          # every Node-driven suite: 460 tests, needs clang
npm run test:unit # fast, no clang
npm run test:e2e  # the suites that build and run programs, needs clang
```

The compiler's own tests are written in Yooperlang and run by the compiler
itself - 1390 of them, and the largest body of coverage in the tree:

```bash
YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime \
  $(node scripts/seed.mjs) --test bootstrap/src
```

The Node suites use Node's built-in test runner (`node --test`) and live in
`src/`, which holds test harnesses and nothing else. Each drives the compiler
over a corpus:

- `npm run test:pass` - 247 tests: programs under `examples/pass/` and
  `examples/tour/` compiled, run, and checked against a hand-written `.expected`
- `npm run test:fail` - 77 tests: programs under `examples/fail/` that must be
  REFUSED, checked against `.expected-errors`
- `npm run test:slice` - 205 tests: the fixtures in `bootstrap/tests/slice/`,
  taken all the way to an executable
- `npm run test:selfhost` - 6 tests: the three-stage build and its fixpoint
- `npm run test:debug` - 3 tests: the DWARF the compiler emits, read back by gdb
  or lldb

When in doubt about whether a change works for real, add a small program to one
of those corpora with the output it should produce.

## The lay of the land

The compiler is written in Yooperlang and compiles itself. The pipeline is:
source `.yoop` -> lex -> parse -> typecheck -> codegen (LLVM IR) -> clang ->
executable, and each layer is a module directory under `bootstrap/src/`:

- `bootstrap/src/lex/` - tokens and the lexer
- `bootstrap/src/parse/` - recursive descent, one file per construct
- `bootstrap/src/ast/` - the node arena
- `bootstrap/src/source_graph/` - modules, imports, and finding the std root
- `bootstrap/src/typecheck/` - the type system, kinds, async and tasks
- `bootstrap/src/codegen/` - LLVM IR emission
- `bootstrap/src/link/` - shelling out to clang
- `bootstrap/src/main.yoop` - the driver

Outside that: `std/` is the standard library in Yooperlang, `runtime/` is the C
runtime clang links in, and `src/` holds the Node test harnesses.

Building the compiler starts from a SEED, a previously released `yoopiler_boot`
binary that [scripts/seed.mjs](scripts/seed.mjs) resolves and downloads;
`YOOP_SEED` points at one you already have.

For the module map layer by layer, read [bootstrap/README.md](bootstrap/README.md).
The other two docs worth knowing: [SPEC.md](SPEC.md) is the grammar and semantics
authority, and [docs/writing_yoop.md](docs/writing_yoop.md) is how to write Yoop
itself (std, the compiler, tools, examples).

## Reporting issues

Open an issue with a minimal `.yoop` program that reproduces the problem, what
you expected, and what actually happened (compiler error, wrong output, or
crash). Note your OS and clang version for codegen or linking problems.
