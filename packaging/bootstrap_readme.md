# yoopiler_boot {{VERSION}} ({{TARGET}})

This is the Yooperlang compiler written in Yooperlang, compiled by itself. Not
the JavaScript one that started this. The binary in `bin/` was built by a
compiler built by a compiler built from this same source, and the last two of
those came out byte-identical, which is the check that says the thing compiles
itself correctly rather than merely compiling.

It is an alpha. It handles the language the compiler itself is written in,
which is a real subset but not all of what the reference implementation takes.

## What you need

`clang`, on your PATH. The compiler emits LLVM IR and shells out to clang to
link it, so clang is not optional and this package does not include one.

    clang --version

On {{PLATFORM_HUMAN}}, that is all.

## Running it

    ./bin/{{BIN}} hello.yoop -o hello
    ./hello

The whole command line:

    {{BIN}} <entry.yoop> [-o <out>] [--emit-ir]

    -o <out>    where the executable goes. The IR is always written beside it,
                as <out>.ll. Defaults to a.out.
    --emit-ir   stop after writing <out>.ll. No clang, no executable.

The entry file pulls in everything else through its imports, so you name one
file no matter how many the program is.

Something to compile, if you want one immediately:

    function main(): int {
      printf("hello from the bootstrap compiler\n");
      return 0;
    }

## What is in here

    bin/{{BIN}}     the compiler
    lib/std/                 the standard library, as .yoop source
    lib/runtime/             the C runtime sources handed to clang

`lib/` stays outside the binary because clang is a separate process and needs
real files at real paths. The compiler finds both by looking beside itself, so
keep `bin/` and `lib/` in the same directory and move them together. If you
would rather point it somewhere else, `YOOP_STD_ROOT` and `YOOP_RUNTIME_ROOT`
override the search.

Everything under `lib/` is ordinary readable source. Reading `lib/std/` is
still the fastest way to learn what the language actually offers.

## On macOS

If you downloaded this through a browser, mail client or chat app, macOS
flagged it. This binary is not notarized, so Gatekeeper kills it on sight with
no error message at all. Run this once, from the directory holding this file:

    xattr -dr com.apple.quarantine .

## If it goes wrong

A "cannot locate the standard library" message means `lib/` is not where the
binary expects it. Either put it back beside `bin/`, or set `YOOP_STD_ROOT` to
the directory that holds `core/`.

A failure that mentions `ld:` and a library name is the link step, not the
compiler. Whatever your program named, install it, or point `YOOP_LIB_PATH` and
`YOOP_INCLUDE_PATH` at the tree that has it.

Anything else is worth reporting: https://github.com/tkarnau/yooperlang/issues
