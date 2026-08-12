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
      source_graph/    layer 0: Module / SourceFile / ModuleGraph, reading a
                       module's files, the import walk, path resolution,
                       module ids, finding the std root
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
  * `type` decls with fields
  * `let` / `const` locals, with an annotation or inferred from the initializer
  * function PARAMETERS, readable in the body and passed at call sites
  * assignment to a local (`x = expr`)
  * `if` / `else if` / `else`, `while`, and `for (let i = 0; i < n; i = i + 1)`
  * `break` and `continue`, checked to be inside a loop
  * comparisons `== != < > <= >=`, and `&&` / `||` with real short-circuiting
  * `true` / `false`, unary `-` and `!`, parenthesized grouping
  * compound assignment (`x += 1`), including in a `for` step
  * arrays: `T[]` annotations, `[a, b, c]` literals, `xs[i]` read and write,
    `xs.len`, and passing an array to a function
  * integer casts (`usize(n)`, `int8(x)`)
  * `switch` over an integer, with multi-pattern arms and a required `default`
  * structs as VALUES: `{ x: 1 }` literals, field read and write, passing and
    returning by value
  * `variant` decls, their constructors and their switch patterns:

        variant Shape { Circle { r: int }, Rect { w: int, h: int }, Empty }
        const c: Shape = Shape.Circle { r: 2 };
        switch (s) {
          case Shape.Circle { r: r }: { return r; }
          case Shape.Rect { w: w, h: h }: { return w * h; }
          case Shape.Empty: { return 0; }
        }

    A switch over a variant is exhaustive or has a default, never neither and
    never both, and a pattern BINDS its payload into the arm.
  * `return`, with or without a value
  * int literals, string literals, `+ - * / %`
  * calls, including the `printf` builtin
  * `export function` / `export type`, and every import form but one:

        import { add, scale as times, Point } from "./lib/mathx.yoop";
        import * as mathx from "./lib/mathx.yoop";
        import { Point }, * as mathx from "./lib/mathx.yoop";
        import { Point } from "./lib/geo";        // a DIRECTORY module

  * `ns.fn(...)`, resolved against the namespaced module's EXPORTS
  * directory modules: a directory whose `.yoop` files each declare
    `module <name>;` is ONE module - one namespace, one mangled prefix, and its
    files see each other's declarations without importing

  * `std/...` import paths, resolved against a root the compiler DISCOVERS:
    `YOOP_STD_ROOT` if set, otherwise a probe beside the executable. Values from
    std must come through a namespace (`import * as log from "std/log.yoop"`);
    types may be imported by name.

Not yet: side-effect imports (`import "./init.yoop";`), the `modules/` import
root, std AUTOLOADS, `ns.CONSTANT` (anything but a call through a namespace),
generic variants, value `enum`s, unions, `for x in xs`, module-level
`let` / `const`, nested field paths (`a.b.c = v`), floats, traits, kinds,
generics.

**Resolving `std/` is not the same as compiling it.** The path arithmetic works
today; the real standard library still needs language the bootstrap does not
have. Pointing it at `std/` gives, in the order you hit them:

    std/core/types.yoop    generic variant "Result" is not supported yet
    std/core/strings.yoop  a generic type application in an annotation
    std/core/vec.yoop      "implements" clauses on a type decl
    std/log.yoop           `extern` blocks

Generics is the big one, and `Result<T, E>` is on the far side of it.

Integer widths do NOT mix, matching the JS reference: `xs[0] + xs.len` is
`int32 + usize` and is an error. Write the cast.

Two invariants control flow introduced, both easy to break:

- **Allocas are hoisted** into `entry:` via `Emitter.prologue`. An alloca must
  dominate every load, and one emitted inside an `if` arm does not dominate a
  use after the join. Slot names carry a uniquing number for the same reason -
  sibling branches may each declare `a`.
- **One terminator per block.** `emitBlock` / `emitStatement` report whether the
  path definitely `terminated` - a `ret`, but also a `break` or `continue` -
  so no `br` follows one. An `if` whose both arms return emits no join block at
  all. Getting this wrong produces invalid IR that clang rejects, not a wrong
  answer.
- **A `for` loop's step gets its own block.** `continue` jumps to the STEP, not
  the condition, so the counter still advances; wiring it to the condition
  instead spins forever. That is why `LoopLabels` carries two targets.
- **An array is a `{ ptr, i64 }` descriptor** - data plus length - and a
  literal's storage is a hoisted `alloca [N x T]` that the descriptor points
  into. So a literal BORROWS the enclosing function's stack: returning one hands
  back a dangling pointer. The JS reference has the same property; a
  heap-allocating form is a separate feature.
- **Structural types must intern to one TypeId.** Type equality is `id == id`,
  so two `int[]` annotations that interned separately would compare unequal.
  `internArray` / `internRef` scan before inserting.
- **Variadic calls must PROMOTE narrow arguments.** C default argument promotion
  passes integers as 32- or 64-bit, so an `i8` handed to `printf` leaves the rest
  of the slot holding whatever was there before - the printed number is unrelated
  to the value, not merely rounded. `casts.yoop` in the slice fixtures is the
  test; it printed 300 for `narrow(300)` before promotion existed, instead of 44.
- **A `switch` allocates every arm's label before emitting any of them**, because
  the jump table names them all up front. That is the one structural difference
  from `if`.
- **A struct is a VALUE, and a field read and a field write take different
  routes.** A read is `extractvalue` on the loaded value, so it works on any
  struct expression including a call result; a write is `getelementptr` on the
  binding's slot, because a store needs an address and only a named binding has
  one. Struct literals store by field POSITION, so a literal may list its fields
  in any order - `structs.yoop` covers both that and the copy-on-assign that a
  pointer representation would break.
- **`&&` and `||` branch, they do not compute.** Both lower to a condition, a
  right-hand-side block, and a stack slot the two paths write - never a single
  instruction over two evaluated operands. `expressions.yoop` in the slice
  fixtures is the test that catches a non-short-circuiting lowering; every other
  assertion in it passes either way.
- **The module graph is topologically ordered, and everything above it leans on
  that.** A module's imports are loaded, and therefore indexed, before it is; so
  a module's ModuleId is greater than every module it imports. That single fact
  is what lets typecheck run all four passes in ONE walk per module instead of
  four walks over the graph, and what makes pass B a lookup rather than a second
  fixpoint. An import cycle is refused during the walk, which is the only place
  that can see one.
- **A MODULE is the namespace and mangling unit; a SOURCE FILE is the
  compilation unit.** They are the same thing for `./util.yoop` and different for
  a directory module. Every layer above walks `m.files`, never one root.
- **A module's files share ONE arena.** NodeIds are therefore unique across the
  whole module, which is what keeps typecheck's decoration a single dense vector
  indexed by NodeId rather than one vector per file - the alternative would have
  changed every one of pass D's decoration sites. `parseInto` moves the arena in
  and back out, so each file appends to it and keeps its own PROGRAM root.
- **The module header is read by LEXING three tokens, not by parsing.** The
  graph cannot parse a file until it knows which module owns it (that is which
  arena it goes in), and it cannot know that without the header - so
  `parse/header.yoop` answers the question without an AST. That is what the JS
  reference needs a parse cache for.
- **A variant is `{ i32 tag, [N x i8] payload }`,** with one payload STRUCT per
  case that carries something (`%variantc.m__Shape__Circle`). LLVM has no union,
  so N is the largest case's naturally-aligned size and every case reads the same
  bytes as a different struct. The sizes come from `typecheck/layout.yoop`, which
  matches the JS reference case for case - the two compilers never link together,
  but a payload-size disagreement would show up as a corrupted field rather than
  as an error, so it is worth being able to diff. The tag is i32 for the same
  reason, which means an 8-byte payload field sits at offset 4; that matches the
  reference and is fine on every target the compiler supports.
- **A variant is a VALUE, and both directions go through a stack slot.** The
  payload is addressed as whichever case struct the tag names, and only an
  ADDRESS can be reinterpreted that way - a loaded value has none. Same
  asymmetry as a struct field write versus a read, and for the same reason.
- **An exhaustive variant switch has no default arm, so its jump table gets an
  `unreachable` block.** Without one the fall-through would make the switch look
  non-terminating, and a function whose every arm returns would be rejected for
  having no return on some path. `variants.yoop` in the slice fixtures covers it.
- **A `Vec` read out of the type arena is a SHALLOW copy that shares the arena's
  storage.** Never mark one `disposable`: it frees the arena's own fields, and
  the next lookup reads freed memory. `VariantCaseLookup` is deliberately shaped
  to hand out an ordinal and a count rather than the case's `Vec<Field>`, because
  that is exactly the bug it caused - a null dereference three passes away from
  the annotation that caused it.
- **The std root is DISCOVERED once, by the driver, and passed in.**
  `loadModuleGraph` takes it as a parameter rather than probing for it, so a
  caller that already knows its root - a test pointing at a stub, and eventually
  the LSP - never touches the filesystem probing in `std_root.yoop`. The
  discovery rule honours `YOOP_STD_ROOT`, which is what the JS reference honours
  too, so one variable retargets both compilers at the same tree.
- **A diagnostic carries the FILE it was found in.** `Program.currentFile` is
  ambient, set by each pass as it starts a file, because the alternative is a
  path parameter on forty `reportError` call sites that all want the same
  answer. A bare `12:5` was already ambiguous across modules and became
  ambiguous within one.
- **An import binds the source module's SymbolId - the same integer, not a
  copy.** Type equality is `id == id`, so this is what makes an imported `Point`
  compare equal to the declared one instead of being a second nominal type. It
  also means an imported shell stays correct when pass C fills it, since filling
  re-SETS the arena slot the id already points at.
- **Every symbol is mangled `<moduleId>__<name>`,** because one LLVM module holds
  the whole graph and two yoop modules may each define `add`. `main` and `printf`
  are the only exceptions and are decided in one place (`codegen/mangle.yoop`).
  That carve-out is why a non-entry module declaring `main` is a typecheck error:
  two bare `@main`s would otherwise reach the linker.
- **A call is mangled against the callee's HOME module, under its EXPORT name.**
  `import { scale as times }` calls `times` locally and must emit
  `@mathx_1__scale` - using the local name emits a call to a symbol nothing
  defines. `TypedModule.importedFrom` carries both halves.

A program in this subset needs no yoop runtime - only libc - which is what keeps
the link step a single clang invocation. Linking the runtime arrives with the
first feature that needs it.

Tests live beside the module they cover as `*.test.yoop`, which is excluded from
the module's file list, so a test reaches its module through the same import
path a consumer writes:

    node ../src/yoopiler.js --test src/lex
    node ../src/yoopiler.js --test src/parse
    node ../src/yoopiler.js --test src/source_graph
    node ../src/yoopiler.js --test src/typecheck

`src/source_graph` is the one that reads files from disk: `tests/graph/` holds
programs whose import structure is the point, all of them refusals, plus the
`tests/slice/imports.yoop` diamond read back for its topological order.

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
file is doing two jobs, split it. `instr.yoop` is the one deliberate exception:
it is a flat catalogue of every instruction, and its value is that you can read
the whole IR surface in one place, so it grows by entries rather than splitting.

**Separate DECIDING from EMITTING.** Three layers, and a function belongs to
exactly one:

    expr.yoop / stmt.yoop   walk the AST, decide what should happen
    flow.yoop               the same, for `if` (block discipline lives here)
    loop.yoop               the same, for `while` / `for`
    loop_stack.yoop         where break/continue jump
    array.yoop              array literals, indexing, `.len`
    call.yoop               call expressions
    switch.yoop             `switch` -> a jump table
    struct.yoop             struct literals, field read and write
    variant.yoop            variant constructors, tags, pattern bindings
    typedefs.yoop           the module-level struct type definitions
    instr.yoop              emit one LLVM instruction
    instr_mem.yoop          the same, for aggregates and computed addresses
    instr_flow.yoop         the same, for branches, labels, the jump table
    vocab.yoop              which opcode/predicate an operator lowers to
    context.yoop            the Cx, and the raw text appenders
    query.yoop              THE typecheck boundary - everything codegen asks

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
