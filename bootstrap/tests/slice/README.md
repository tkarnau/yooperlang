# Vertical slice fixtures

Programs the bootstrap compiler can take all the way to an executable. They are
the seed for every layer: each one exercises module graph -> lex -> parse ->
typecheck -> codegen -> clang.

src/slice.test.js compiles each with BOTH compilers and asserts identical stdout
and exit code. That is layer-6 behavioural parity.

The `.expected` beside a program is the source of truth and is written by hand:
it holds the program's stdout plus an `exit=N` line, is asserted against the
BOOTSTRAP first, and the JS reference is checked against the same file as a
parity bonus. Never capture one from compiler output. A fixture the reference
cannot compile carries a `<stem>.bootonly` marker naming the reason, which skips
that bonus; everything else has to stay compilable by both.
