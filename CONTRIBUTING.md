# Contributing to Yooperlang

Thanks for taking a look. Yooperlang is a learning project and a moving target,
but issues, questions, and patches are welcome.

## Ground rules

This is a from-scratch compiler with no third-party dependencies. Please keep it
that way for the JavaScript compiler itself - plain Node, no build tools, no npm
packages. (Auxiliary tooling under `tools/` may have its own isolated
dependencies.)

A note on AI: the compiler code is written by hand, on purpose, so the author
actually understands each piece. AI is used for planning and organizing, not for
generating compiler code. If you send a patch, please understand what it does.

In docs and comments, keep to plain ASCII: no emdashes, no curly quotes, no
fancy markdown tables.

## Running the tests

```bash
npm test          # everything (unit + end-to-end; needs clang)
npm run test:unit # fast unit tests, no clang required
npm run test:e2e  # full lex -> parse -> typecheck -> codegen -> clang -> run
```

Tests use Node's built-in test runner (`node --test`) with `node:assert/strict`.
Unit tests live next to the code they cover as `<file>.test.js`. The
end-to-end suite is [src/e2e.test.js](src/e2e.test.js) - when in doubt about
whether a change works for real, add a small fixture there.

The `examples/pass/` and `examples/fail/` directories are also test material:
programs that must compile, and programs that must be rejected, respectively.

## The lay of the land

The pipeline is: source `.yoop` -> lex -> parse -> typecheck -> codegen (LLVM IR)
-> clang -> executable. Each stage lives in its own subdirectory under `src/`:

- `src/jsyooplexer/` - lexing
- `src/jsyooparser/` - parsing
- `src/jsyooptypecheck/` - the type system
- `src/jsyoopcodegen/` - LLVM IR emission
- `src/jsyoopdriver/` - module graph and driver
- `src/yoopiler.js` - the entry point

For the full subsystem map, the cross-cutting invariants, and the design notes
that are not obvious from any single file, read [CLAUDE.md](CLAUDE.md). It is the
de facto architecture document for this repo.

## The phase model

Features land phase by phase. The plan lives in
[plans/roadmap.md](plans/roadmap.md); per-phase write-ups are in
[plans/completed/](plans/completed/). Code is annotated with phase comments
(`// Phase 7.1:`, `// 6.5:`) marking the version a piece of logic became correct
- treat those as load-bearing breadcrumbs.

## Reporting issues

Open an issue with a minimal `.yoop` program that reproduces the problem, what
you expected, and what actually happened (compiler error, wrong output, or
crash). Note your OS and clang version for codegen or linking problems.
