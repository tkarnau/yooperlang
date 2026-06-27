# Yooperlang

A systems language with a TypeScript feel - for folks who spent their career shipping web apps and kept bouncing off the cliff face of "real" systems languages.

- No garbage collector, but you can opt in to / build one
- No classes - structs plus free functions
- Traits and kinds borrowed from other languages, with user-defined, compile-time syntax requirements
- Compiles to LLVM IR and shells out to `clang` to produce a native executable

("Yooper" is what you call someone from Michigan's Upper Peninsula. The name is a bit of a joke. The language is not.)

## Status

This is a re-imagining of a version I first wrote in C and have since abandoned. The current compiler is written in JavaScript (plain Node, no build tools, no dependencies) for readability by me (having lived in web languages and node backend worlds for a bit too long,) with the long-term plan of bootstrapping the compiler in Yooperlang itself once enough of the language is in place.

What works today: a "working" chunk of the pipeline (lex, parse, typecheck, codegen, link). That covers structs, traits, kinds, generics, enums and unions, error handling, tasks and concurrency, and a starting standard library (`std/core`, `std/net`, `std/http`, `std/collections`). Self-hosting (rewriting the compiler in Yooperlang itself) is the current focus, to unlock some iteration on a bytecode layer and feel the language out. See [plans/](plans/) for what is being worked on now, and [plans/archive/roadmap.md](plans/archive/roadmap.md) for the full historical phase map.

Typically I will begin writing a small document about the next portion of the language to work on and have a few iterations with LLMs to build out a plan and some pseudocode and begin implementation from there. Ideally very little of the compiler is AI generated, but there are some parts of LLVM and the C-runtime edges that I will lean on some AI implementation to get a better understanding to see it working in the context of this language.

It is likely that parts of the language get ripped out or rewritten by hand once an understanding of how a particular feature works in the full pipeline after I've written most of the front-end. Like memory allocators, and such. I didn't really understand how they might be implemented beyond the syntax and so most of the lowering was AI-assisted and is slowly being replaced.

It's a moving target and a learning project. I'm relatively new to compilers outside of small DSLs and school projects, so expect rough edges.

### dev platform and build target NOTE

Currently it is working mostly for macos, and we need to go through and get a build server or something for all of the other test/build scenarios to ensure this continues working and being testable cross platform. I started writing this on windows and did a couple passes working on it in linux, but a huge amount has been on the macbook in coffee shops and kids' softball tournament downtimes...

## A taste

```yoop
trait Greeter {
    function greet(ref self): int32;
}

type Megaphone implements Greeter {
    n: int32,
    function greet(ref self): int32 {
        return self.n * 10;
    }
}

function main(): int32 {
    let m: Megaphone = { n: 5 };
    let loud: int32 = Greeter.greet(ref m);
    printf(`loud=${loud}\n`);
    return 0;
}
```

## Quick start

Prerequisites:

- Node.js 18 or newer (no `npm install` needed - the compiler has zero dependencies)
- `clang` on your `PATH` (codegen emits LLVM IR and links it with clang)

Compile and run a program:

```bash
node ./src/yoopiler.js examples/intro/hello.yoop
./examples/intro/hello
```

The compiler writes a native executable next to the input file (same name, no `.yoop` extension).

## Try it

A few small, self-contained programs to start with:

- [examples/intro/](examples/intro/) - tiny, heavily commented starter programs
- [examples/playground/calculate_primes/](examples/playground/calculate_primes/) - a longer worked example
- [examples/playground/dynamic_array/](examples/playground/dynamic_array/) - generics and heap allocation
- installing SDL2 and trying some of the graphical programs

There are also hundreds of feature fixtures under [examples/pass/](examples/pass/) (programs that should compile) and [examples/fail/](examples/fail/) (programs that should be rejected, used as compiler tests).

## Learn the language

- [SPEC.md](SPEC.md) - the language specification (syntax first, with examples)
- A browsable language reference site lives in [web/](web/) (see Getting Started for how to view it)
- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) - install, first program, where to go next
- [tools/mcp-reference/](tools/mcp-reference/) - an MCP server that exposes the spec and standard library to AI assistants (Claude, Cursor, ...) so they can search the reference while you write Yooperlang

## Contributing / hacking on the compiler

- [CONTRIBUTING.md](CONTRIBUTING.md) - how to run the tests and the lay of the land
- [CLAUDE.md](CLAUDE.md) - the architecture deep-dive (subsystem map, invariants, design notes)

Run the tests:

```bash
npm test          # everything (needs clang)
npm run test:unit # fast, no clang
npm run test:e2e  # full pipeline, needs clang
```

## License

MIT - see [LICENSE](LICENSE).
