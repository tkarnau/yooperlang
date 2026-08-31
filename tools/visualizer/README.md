# The compilation explorer

A toy, on purpose: point it at a `.yoop` file and it serves a walkable 3D
world where each stage of the pipeline is a district along a road. A stage
does not exist until you walk to its pedestal and pull the lever - that
REALLY runs the compiler, right then - and its artifacts then materialize
in deliberate slow motion, with a debugger bar to pause, step, and rescale
time. The world is a novelty; everything in it is a real artifact of a real
compile.

    npm run visualize -- examples/pass/arena_vec.yoop
    npm run visualize -- file.yoop --port 7177 --no-open
    npm run visualize -- file.yoop --compiler /path/to/yoopiler_boot

First use: `cd tools/visualizer && npm install` (fetches three.js, the only
dependency; nothing else has a build step).

Compiler resolution, first hit wins: `--compiler`, `$YOOP_BOOT_COMPILER`,
the dev build (`build/dev/bin/yoopiler_boot`), the seed. Same philosophy as
the editor extension: prefer the compiler built from this tree, fall back
to a release rather than to nothing. Every spawn gets `YOOP_STD_ROOT` and
`YOOP_RUNTIME_ROOT` pointed at this tree (via `seedEnv`).

## The districts, in pipeline order

1. **Source Plaza** - the file as a glowing text wall. Every other district
   highlights spans back onto it.
2. **Lexer Conveyor** - `dump_tokens` output (the tool is built into
   `build/visualizer/` on first use) as colored blocks riding a conveyor.
3. **AST Grove** - the `--dump-ast-json` parse tree as a literal tree,
   depth as height, colored by node category.
4. **Module Archipelago** - the import graph as floating islands, sized by
   lines, bridged by dependency arcs. Reconstructed by scanning `import ...
   from` paths the way the loader resolves them; the compiler has no graph
   dump.
5. **Typecheck Gate** - a gate across the road that opens only if the
   program typechecks. Diagnostics hover as sigils; declarations appear
   with their resolved types. The facts come from a real `--lsp` session
   (publishDiagnostics, documentSymbol, hover) - the only machine-readable
   channel the compiler has for typecheck results.
6. **Codegen Hall** - the emitted LLVM IR (`--emit-ir`): the entry file's
   functions as platforms, basic blocks as slabs, the CFG as catwalks,
   instructions as bars that point back at the source line that produced
   them (parsed from the `!dbg` metadata). The std prelude is a distant
   skyline.
7. **Linker Forge** - the full compile-and-link, forging the binary.
8. **Run Pad** - the binary actually runs (20s deadline); stdout types out
   on a terminal monolith, exit code and all.

## Controls

Click to enter. WASD + mouse, Shift sprint, Space jump, F toggles flying,
E pulls the lever you are looking at, Esc releases the mouse. The debugger
bar (bottom): pause, single-step, and a 0.25x-8x speed slider over every
materialization. Stage chips (top) show locked / ready / running / done /
failed. Refreshing the page restores every stage already run.

Debug URL params (used by the headless screenshot checks): `?fast=1`
(instant materialization), `?run=all` or `?run=source,lex,...` (auto-run
stages), `?cam=x,y,z,ry` (camera), `?nolock=1` (skip intro and pointer
lock).

## How it is put together

- `visualize.mjs` - CLI, compiler resolution, and a localhost server: the
  viewer's static files, three.js from `node_modules`, and a tiny JSON API.
- `stages.mjs` - one function per stage; each runs a real compiler
  invocation and normalizes the artifact. Stage order is enforced.
- `ir_parse.mjs` - line-level reader of the textual `.ll`: functions,
  blocks, successors, `!dbg` provenance.
- `lsp_client.mjs` - a minimal LSP client over stdio for the typecheck
  stage.
- `viewer/` - the Three.js world. Renders only the shapes in `SCHEMA.md`,
  never raw compiler output, so the compiler's dump formats can change
  without touching the scene.
- `SCHEMA.md` - the contract between the two halves.

Working files (the dump_tokens binary, per-file ASTs, `.ll`, binaries) go
under `build/visualizer/`, which is gitignored like the rest of `build/`.

Payload guards, so a big input stays a world and not a heap dump: IR
instructions cap at 8000 across the entry file's functions, the std
skyline lists at most 400 functions, program output clips at 64 KiB. The
driver has been run against `bootstrap/src/main.yoop`, where the module
archipelago is 30 islands and the typecheck gate takes the ~10s one full
compile of the compiler costs.
