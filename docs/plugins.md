# Compiler plugins

A build can carry a PLUGIN: a Yoop source file whose hook functions the
compiler runs at its own phase boundaries.

    yoopiler_boot file.yoop -o out --plugin path/to/plugin.yoop

The plugin is loaded as its own module graph and typechecked like any
program; a plugin that does not typecheck refuses the build up front, with
its own diagnostics. Its hooks are then INTERPRETED by the comptime
evaluator (the `@precompile` machinery in
[../bootstrap/src/comptime/](../bootstrap/src/comptime/)) - the plugin is
never compiled, and nothing it computes lands in the build's artifact. The
host lives in [../bootstrap/src/plugin/](../bootstrap/src/plugin/).

`--plugin` applies only to the ordinary compile: `--test`, `--lsp`,
`--dump-ast-json` and `--list-attributes` refuse it rather than ignore it.

## The hooks

All optional, found by name in the plugin's entry module, and validated for
shape when the plugin loads:

    onStart(entry: string, out: string): int32   before the graph loads
    onParse(): int32                             graph loaded and parsed
    onTypecheck(): int32                         typechecked, diagnostics ok
    onCodegen(): int32                           IR emitted, not yet linked
    onLink(): int32                              executable produced
    onFinish(ok: int32): void                    always, success or not

A hook BLOCKS the build until it returns - that is the feature, not a
hazard: a plugin may hold the pipeline at a boundary for as long as it has
something to show or someone to wait for. Returning nonzero stops the build
with that exit code (clamped to 1..255), and the log names the hook that
decided it. An evaluation failure inside a hook stops the build with the
plugin file's own source location.

## What a hook can do

A hook runs on the comptime evaluator and is bound by its subset: strings,
ints, structs, arrays, variants, control flow, template literals, and calls
into modules imported as namespaces. No Vec, no Text, no closures, no
pointers, no async. Every gap is refused BY NAME with a location in the
plugin's source.

The build reaches a hook through [../std/plugin.yoop](../std/plugin.yoop),
which wraps the plugin builtins - externs answered by the compiler itself
from artifact snapshots it refreshes at each boundary (the PluginBridge in
[../bootstrap/src/comptime/plugin_bridge.yoop](../bootstrap/src/comptime/plugin_bridge.yoop)):

- `phase() entryPath() outPath() buildOk()` - where the build stands.
- `tokens() astJson() modulesJson() diagnosticsJson() ir()` - the phase
  artifacts, each one finished string serialized host-side.
- `log(s)` - a `[comptime]`-tagged line in the build log; a hook never
  touches the compiler's stdout.
- `spawn(cmd) sendLine(s) sendArtifact(kind) recvLine() childAlive()
  killChild() sleepMs(ms)` - ONE child process over line pipes, the handle
  held on the bridge so it survives between hooks. `recvLine` blocks the
  build; an empty answer means the child is gone. `sendArtifact` frames a
  whole artifact for the child (`blob <kind> <bytes>`, then the bytes) -
  framing has to be host-side because the subset has no string library.
  POSIX only; on Windows the family fails cleanly and `--plugin` with a
  child errors rather than half-working.

Outside a `--plugin` hook every builtin is refused by name - the purity
policy of [../bootstrap/src/comptime/externs.yoop](../bootstrap/src/comptime/externs.yoop)
still holds for `@precompile`, and the carve-out is exactly the hook frame.

## The visualizer

The flagship plugin is [../tools/vizworld/](../tools/vizworld/): it spawns
a native SDL2/OpenGL renderer (itself a compiled Yoop program) and parks
the build at every phase gate until the player walks up and opens it. Its
README has the two-command demo.

## Writing one

The smallest useful plugin is a phase logger:

    import * as plug from "std/plugin.yoop";

    export function onCodegen(): int32 {
      plug.log(`ir is ${plug.ir().len} bytes\n`);
      return 0;
    }

Test surface: the host's own suite is
[../bootstrap/src/plugin/host.test.yoop](../bootstrap/src/plugin/host.test.yoop),
driver behaviour is pinned in `src/slice.test.js` ("--plugin"), and the
extern gate in `bootstrap/src/comptime/comptime.test.yoop`.
