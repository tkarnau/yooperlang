# Vertical slice fixtures

Programs the compiler can take all the way to an executable. They are the seed
for every layer: each one exercises module graph -> lex -> parse -> typecheck ->
codegen -> clang.

src/slice.test.js compiles each one, runs it, and asserts its stdout and exit
code. That is layer-6 behaviour, checked end to end.

The `.expected` beside a program is the source of truth and is written by HAND:
it holds the program's stdout plus an `exit=N` line, and the assertion is
compiler-output equals expected. Never capture one from compiler output - a
captured file asserts that today's behaviour equals today's behaviour, and
blesses whatever bug is being captured along with it.

The suite builds a compiler from `bootstrap/src/` with the seed
(`scripts/seed.mjs`) before it starts. `YOOP_BOOT_COMPILER=<path>` runs the
whole suite through an ALREADY BUILT compiler instead, which is what makes a
stage from the self-hosting chain testable:
`YOOP_BOOT_COMPILER=/tmp/s3/yoopiler npm run test:slice` asserts these same
`.expected` files against stage3.
