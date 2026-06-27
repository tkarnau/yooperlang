# Contributing to Yooperlang

Thanks for taking a look. Yooperlang is a learning project and a moving target,
but issues, questions, and patches are welcome.

## Ground rules

This is a from-scratch compiler with no third-party dependencies. Please keep it
that way for the JavaScript compiler itself - plain Node, no build tools, no npm
packages. (Auxiliary tooling under `tools/` may have its own isolated
dependencies.)

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
added. I don't care really how those are written in the JS side of the compiler,
but eventually we need to write a yoop test harness for the bootstrap compiler.
Keeping that in mind, we should stick to only testing with features that will
eventually exist in the regular language. The default node testing library
should be good enough.

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

Features land phase by phase. The current focus and the small consolidated plan
live in [plans/](plans/); per-phase write-ups for shipped work are in
[plans/completed/](plans/completed/), and the full historical roadmap is at
[plans/archive/roadmap.md](plans/archive/roadmap.md). Code is annotated with phase comments
(`// Phase 7.1:`, `// 6.5:`) marking the version a piece of logic became
correct - treat those as load-bearing breadcrumbs.

## Reporting issues

Open an issue with a minimal `.yoop` program that reproduces the problem, what
you expected, and what actually happened (compiler error, wrong output, or
crash). Note your OS and clang version for codegen or linking problems.
