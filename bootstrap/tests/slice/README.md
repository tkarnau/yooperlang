# Vertical slice fixtures

Programs the bootstrap compiler can take all the way to an executable. They are
the seed for every layer: each one exercises module graph -> lex -> parse ->
typecheck -> codegen -> clang.

src/slice.test.js compiles each with BOTH compilers and asserts identical stdout
and exit code. That is layer-6 behavioural parity, the last check in
plans/bootstrap-pipeline-contracts.md.

Add a program here as soon as the bootstrap can compile it. Keep every one of
them compilable by the JS reference too, or the parity assert is meaningless.
