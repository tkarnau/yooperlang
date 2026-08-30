# vizworld

The compilation, as a place. A build run through the vizworld plugin opens
a native window: a night road with a district per compiler phase - the
token conveyor, the AST grove, the module archipelago, the typecheck gate,
the LLVM IR skyline, the forge at the end. Each phase's artifacts
materialize slowly, and the BUILD ITSELF waits at every gate until you walk
up and open it. The compiler is parked inside its own comptime interpreter
while you look around; see [../../docs/plugins.md](../../docs/plugins.md)
for the mechanism.

    npm run viz:build
    yoopiler_boot file.yoop -o out --plugin tools/vizworld/plugin.yoop

(Any compiler works: the dev build, a stage, the seed - run from the repo
root so the plugin finds `build/vizworld/vizworld`, or point
`YOOP_VIZWORLD` at the renderer.)

Controls: WASD flies (with a glide - velocity eases rather than snaps),
mouse looks, SPACE rises, C sinks, LSHIFT sprints. CLICK pins whatever the
crosshair holds so its highlight and arcs survive a flight to the far end
of them; a click on empty space releases the pin. G or ENTER opens the
pending gate. P pauses every materialization, X steps one notch while
paused, MINUS and EQUALS halve and double the speed. The window resizes freely
and F11 toggles fullscreen. ESCAPE or Q leaves -
a build still waiting at a gate stops rather than hanging. After the
verdict the world stays up until you leave it.

The HUD carries a crosshair, the build's status and speed top-left, the
controls along the bottom, and a tooltip beside the crosshair whenever the
pick holds something: the token's own text and byte range, the AST node's
kind, name and depth, and the pin state.

The SOURCE WALL stands beside the road's start: the entry file itself,
revealed a few lines a second. Aim the crosshair at a character and the
provenance lights up - the covering token's whole range glows on the wall,
an arc flies to that token on the belt (labeled with its own source text),
and a second arc finds the deepest AST node introduced there, labeled with
its kind and name. Click to pin it and fly the arcs. The wall caps at 60
lines and says how many more a bigger file has.

The WHOLE CLOSURE is walkable, not only the entry: the host streams every
file of the graph to the renderer before the parse gate. Aim at an island
in the archipelago and press E - that module's source takes the stage (the
wall, the belt and the grove swap to it) and replays ITS lex and parse
from zero; press E again to cycle a directory module's files. Diagnostics
re-place themselves against whichever file is showing - including the
warning classes std's own files carry - and the HUD names the file on
stage. The module map and the IR stay put: they are whole-program.

## The pieces

- [plugin.yoop](plugin.yoop) - the interpreted half: runs INSIDE the
  compiler, streams artifacts to the renderer, blocks the build at each
  gate. Written strictly in the comptime evaluator's subset; it doubles as
  the reference example for writing a plugin.
- [main.yoop](main.yoop) - the renderer: an ordinary COMPILED Yoop program.
  SDL2 and OpenGL are bound directly from Yoop ([sdl.yoop](sdl.yoop),
  [gl.yoop](gl.yoop), immediate mode on a compatibility context); the
  protocol, scene state, layout, camera math and the dot-matrix font are
  pure modules with `*.test.yoop` suites beside them (`npm run viz:test`).
- [fake_renderer.sh](fake_renderer.sh) - the window's stand-in for tests
  and CI: answers every gate with `continue`. The end-to-end slice test
  drives the real plugin against it.
- [wire.yoop](wire.yoop) - stdin/stdout, the protocol's transport. Nothing
  else in the renderer may print to stdout; logs go to stderr.

The wire protocol (one line per message, blobs length-framed) is documented
in [protocol.yoop](protocol.yoop) and pinned by its tests.

Graphics are checked by [../../scripts/viz_smoke.sh](../../scripts/viz_smoke.sh),
which self-skips without SDL2 - CI runs the pure suites only. Linux is the
supported platform today, matching the CI story; the SDL and GL bindings
carry nothing Linux-only, but nobody has run them elsewhere yet.
