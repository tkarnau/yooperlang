# Self-hosted Yooperlang compiler

The Yooperlang compiler, written in Yooperlang. Built bottom-up, one layer at a
time, cross-checked against the JavaScript reference in [../src/](../src/) at
each layer boundary before the next layer is built on top of it.

The JS version is a REFERENCE, not something to transcribe. The point of doing
it again is clearer boundaries and less code, by leaning on language features
the JS version could not use.

## Layers

1. Lexer -> token stream
2. Parser -> AST arena
3. Typechecker -> typechecked AST
4. Bytecode generator -> bytecode IR (the one planned deviation; deferred)
5. Code generator -> LLVM IR
6. Clang -> executable

## Layout

Each directory here is a MODULE (every file in it starts with `module <name>;`).
Files inside one module see each other's declarations without importing, which
is what lets a layer's vocabulary live with the code that owns it instead of in
a shared header file.

    src/
      main.yoop        the driver
      diagnostics/     SourceLocation, Diagnostic, ParsingError
      lex/             layer 1: tokens, scan tables, char scanning, literals,
                       the lexer
      ast/             the arena: node kinds, ASTNode, AST, slot-name helpers
      parse/           layer 2: recursive descent, one file per construct
      source_graph/    layer 0: Module / ModuleGraph, loading, import resolution
      typecheck/       layer 3: ids, Type, Symbol, Program, the passes
      codegen/         layer 5: typed AST -> LLVM IR text (see the rules below)
      link/            layer 6: IR -> executable, by shelling out to clang
      utils/           sort and iteration helpers with no home in std yet
    tools/             small entry points (dump_tokens)
    tests/parity/      corpus for the layer-1 parity harness
    tests/slice/       programs that compile all the way to an executable

Dependencies run one way:

    diagnostics <- lex <- ast <- parse <- source_graph <- typecheck
                   ^
                   utils

There used to be a single `contracts.yoop` holding all of that vocabulary at
once. It existed only because a module was one FILE, so any two concepts that
referenced each other had to be pulled apart into a third file. Directory
modules removed the reason, and it was dissolved. If you find yourself wanting
to add a "shared types" file, that is the smell it left behind - put the type
with its owner instead.

`diagnostics` is the one module everything depends on, and that is legitimate:
it is a leaf, it depends on nothing, and every layer really does need to say
where in the source a problem is.

## Running it

It is a real compiler now, so build it and point it at a file:

    node ../src/yoopiler.js src/main.yoop -o /tmp/yoopiler_boot
    /tmp/yoopiler_boot tests/slice/hello.yoop -o /tmp/hello
    /tmp/hello

## What it can compile today

Deliberately tiny, and it grows from the bottom. Everything outside the subset
is refused BY NAME - "pass D does not handle X yet", "methods inside a type decl
are not supported by the bootstrap parser yet" - rather than mis-compiled.

  * top-level `function` decls, called from each other
  * `type` decls with fields (registered and resolved, no values yet)
  * `let` / `const` locals, with an annotation or inferred from the initializer
  * function PARAMETERS, readable in the body and passed at call sites
  * `return`, with or without a value
  * int literals, string literals, `+ - * / %`
  * calls, including the `printf` builtin

Not yet: imports, assignment, control flow (`if` / `while` / `switch`), structs
as values, traits, kinds, generics. Each is the next slice outward, and control
flow is the one that forces real work - it is where the flat single-block
emitter has to grow labels and branches.

A program in this subset needs no yoop runtime - only libc - which is what keeps
the link step a single clang invocation. Linking the runtime arrives with the
first feature that needs it.

Tests live beside the module they cover as `*.test.yoop`, which is excluded from
the module's file list, so a test reaches its module through the same import
path a consumer writes:

    node ../src/yoopiler.js --test src/lex
    node ../src/yoopiler.js --test src/typecheck

## Parity with the JS reference

Each layer boundary gets a deterministic dump that both implementations emit in
the same format, and a harness that diffs them. Layer 1 is done:

    npm run test:parity

It compiles `tools/dump_tokens.yoop`, then diffs its output against
`src/dumpTokens.js` over `tests/parity/` plus every `.yoop` file in `std/`,
`bootstrap/` and `examples/` - 557 files today. To eyeball one file:

    diff <(node ../src/yoopiler.js FILE --dump-tokens) <(/tmp/dump_tokens FILE)

Three things the token dump deliberately does not compare, all documented in
src/dumpTokens.js: float values, int literals past 2^53, and non-ASCII spans.

**Layer 2 (AST) parity is not possible yet.** The two ASTs are not the same
shape: this side wraps variable-arity children in NODE_LIST nodes and makes type
annotations real AST nodes, while the JS parser uses plain arrays and a separate
annotation object. A parse dump has to normalize both into one tree before it
can be diffed - that is the next piece of parity work, and it should be designed
before the parser grows much further.


## Codegen readability rules

Bootstrap-specific, not general Yoop style. Codegen is the layer that turns
into unreadable string-append soup fastest, and it is the layer whose bugs are
hardest to spot by reading, so it gets rules of its own.

**Keep files in `codegen/` small and single-purpose** - roughly 150 lines. If a
file is doing two jobs, split it.

**Separate DECIDING from EMITTING.** Three layers, and a function belongs to
exactly one:

    expr.yoop / stmt.yoop   walk the AST, decide what should happen
    instr.yoop              emit one LLVM instruction
    context.yoop            the raw text appenders (only instr.yoop calls these)

The walking code should read as "load the local, then multiply" - if you can see
a quotation mark in `expr.yoop`, something is in the wrong file.

**Every IR-emitting function carries a sample of its output**, and is named for
the IR it produces rather than the AST it came from:

```yoop
//   %t4 = load i32, ptr %count.addr
export function emitLoad(ref cx: Cx, dest: usize, ty: string, slotName: string): void {
```

`emitLoad`, not `emitIdentExpr`. That sample IS the documentation - change the
format, change the sample.

**An instruction emitter takes decisions already made.** Operands and types come
in as arguments; it does no lookups, touches no AST, and makes no choices. That
is what keeps it readable at a glance and testable in isolation.

**Pass the `Cx`, not five arguments.** `context.yoop` bundles the emitter,
program, typed module, AST, and locals behind `ref` fields, so signatures stay
short and the one argument that actually varies is visible.

**No template literals on an emit path** - one malloc per instruction that
nothing frees. See section 3.1 of [../docs/writing_yoop.md](../docs/writing_yoop.md).

## What codegen reads from typecheck

The whole handoff is three things, and `context.yoop` is the only place that
touches it:

- **the AST** - the shape to walk
- **`typeOf(ref cx, nodeId)`** - the LLVM type pass D resolved for that node
- **`returnTypeOf(ref cx, name)`** - a callee's declared return type

Everything else on `Program` / `TypedModule` is typecheck's business. Codegen
does ZERO type-checking and is total on well-formed input: an internal-error
return means pass D let something through, never that the user made a mistake.

## Tests

Three levels, and the rule in ../CLAUDE.md says every change adds to whichever
fits. The point is that they survive the JS compiler being retired.

    node ../src/yoopiler.js --test src/lex        # yoop unit tests
    node ../src/yoopiler.js --test src/typecheck
    npm run test:slice                            # end-to-end executables
    npm run test:parity                           # layer dumps vs the JS side

A slice fixture is a program plus a hand-written `.expected` holding its stdout
and an `exit=N` line. The `.expected` is the source of truth: it is asserted
against the BOOTSTRAP first, and the JS reference is checked against the same
file as a bonus. Never capture one from compiler output.

## Layer 6 parity

`npm run test:slice` compiles every program in `tests/slice/` with BOTH
compilers and asserts identical stdout and exit code. That is the last check in
the contracts doc, and it exercises every layer at once.

One divergence found while setting it up, worth knowing because the bootstrap is
the one that is right: `printf("%d", 2 + 3)` is an error in the JS reference
("this expression still has an unpinned literal type"), which is the live sharp
edge 1.1 in plans/README.md. The bootstrap's pass D defaults an unconstrained
untyped int literal to int32, which is what the JS side still owes.
