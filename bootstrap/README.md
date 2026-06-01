# Self Hosted Yooperlang compiler

This should contain a pass, or passes, to iterate with creating the self-hosted
Yooperlang compiler. The JavaScript version of the compiler should be used as a
reference, but not copied verbatim. We want clearer boundaries and this should
all be written by hand, and leveraging language features to keep it smaller.

## Clear Boundaries

1. Lexer -> Token stream
2. Parser -> Parsed AST
3. Typechecker -> Typechecked AST
4. BytecodeGenerator -> Bytecode IR
5. CodeGenerator -> LLVM IR
6. Clang -> Executable/DLL/Binary
