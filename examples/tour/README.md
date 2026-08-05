# The tour

Twelve mini programs that build up from "this is a function" to "here is a
test framework made out of two declarations."

Written as raw material for a video series, but it works fine as a read. Start
at `ep01_hello.yoop` and go in order. [SCRIPT.md](SCRIPT.md) is the companion
narration: per episode, what to demo, what to break, and what the point is.

## How each file is laid out

1. A header comment explaining the idea.
2. A program that compiles and runs, with its expected output at the bottom.
3. One or more `BREAK IT` sections: a change to make, the exact compiler error
   it produces, and why the error says what it says.

The break-it sections are the interesting part. They are commented out so
every file in here compiles as shipped, and they are meant to be pasted in
live.

## Running them

```sh
node ./src/yoopiler.js examples/tour/ep01_hello.yoop
./examples/tour/ep01_hello
```

Episode 12 is a test module, so it runs through the harness instead:

```sh
node ./src/yoopiler.js --test examples/tour
node ./src/yoopiler.js --test examples/tour clamps    # filter by suite name
```

To hide the clang target-triple warning:

```sh
node ./src/yoopiler.js examples/tour/ep05_variants.yoop 2>&1 | grep -v "warning:\|generated"
```

## The episodes

Act I is deliberately unsurprising if you write TypeScript. It exists to earn
enough trust to spend in Act III.

1. `ep01_hello.yoop` - `main`, `printf`, and the exit code is real
2. `ep02_values_and_loops.yoop` - bindings, loops, ranges, `int32` vs `usize`
3. `ep03_structs.yoop` - data is a struct, behavior is a free function, `ref`
4. `ep04_traits.yoop` - traits, trait-qualified calls, `Display`
5. `ep05_variants.yoop` - sum types, exhaustive `switch`, `@derive(display)`
6. `ep06_generics.yoop` - type params, bounds, inference, no turbofish
7. `ep07_errors.yoop` - `Result`, `?`, and lazy context strings
8. `ep08_kinds.yoop` - **the pivot.** kinds, and auto-cleanup
9. `ep09_regions.yoop` - region kinds, an owner with no name
10. `ep10_typestate.yoop` - marker kinds, taint tracking, trait-gated laundering
11. `ep11_invent_testing.yoop` - inventing `describe`/`it` in one file
12. `ep12_geometry.test.yoop` - the real `--test` harness

Episodes 8 through 12 are the reason the tour exists. 1 through 7 are setup.

## A note on the file names

They are `ep01_` rather than `01_` because a `.yoop` file whose name starts
with a digit currently fails in codegen. The module id is derived from the
filename and mangled into LLVM symbol names, and LLVM rejects an unquoted
identifier starting with a digit:

```text
error: function expected to be numbered '%0'
```

It only bites when the module declares a struct or a function other than
`main`. Not fixed yet.
