# Module-graph fixtures

Programs whose IMPORT structure is the point, used by
`bootstrap/src/source_graph/source_graph.test.yoop`. Every one of them is
REFUSED - they exist to pin the message the refusal carries, because "refuse by
name" is the rule the whole bootstrap is built on and a wrong message sends the
reader to the wrong file.

    cycle_a/b.yoop     an import cycle, which is the one failure that would
                       otherwise HANG rather than fail
    missing.yoop       an import of a file that is not there
    std_import.yoop    the std/ root, which the bootstrap does not resolve yet
    mixed/             a module directory with one file missing its header
    clash/             two files of one directory declaring different names
    onlytests/         a directory holding nothing but *.test.yoop
    unit/              a real directory module, imported the wrong way by
                       file_of_module.yoop (naming one of its source files)
    selfy/             a directory module whose file imports its own module

The ACCEPTING cases live in [../slice/](../slice/), where they compile and run:
`imports.yoop` is the diamond and `dir_modules.yoop` is the directory module.
The graph test reads both back for its shape assertions, so the two levels check
the same fixtures from different angles.

Fixtures are found by PATH. The test tries the repository root first and then
`bootstrap/`, so either working directory works:

    node src/yoopiler.js --test bootstrap/src/source_graph
