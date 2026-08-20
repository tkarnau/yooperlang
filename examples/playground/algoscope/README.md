# algoscope

A desktop playground that visualizes Yooperlang algorithms. It loads a dumped
AST, lists the functions, and renders the one you pick as abstracted,
math-flavored pseudocode - range-form loops (`for i = 0, ..., n-1`), assignment
arrows (`total <- total + i`), quantifiers (`forall x in xs`), recursion markers
(`recurse quickSort(...)`), and depth-glossed nested blocks so you see the SHAPE
of an algorithm without drowning in the leaves.

It is written entirely in Yooperlang and talks to SDL2 + SDL2_ttf over the C FFI
- a self-hosting / dogfooding exercise. Its input comes from the compiler's own
`--dump-ast-json` flag.

## Build and run

Every command below runs from the repository root. `node scripts/seed.mjs`
prints the path of a compiler, and the two variables point it at this tree's
`std/` and `runtime/`.

```sh
# 1. dump an AST to JSON (the input format)
YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime \
  $(node scripts/seed.mjs) path/to/source.yoop --dump-ast-json /tmp/x.ast.json

# 2. build the playground (one time)
YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime \
  $(node scripts/seed.mjs) examples/playground/algoscope/main.yoop -o /tmp/algoscope

# 3. run it on the dumped AST
/tmp/algoscope /tmp/x.ast.json
```

Try it on the standard-library quicksort (generics, recursion, range loops):

```sh
YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime \
  $(node scripts/seed.mjs) bootstrap/src/utils/arrayUtils.yoop --dump-ast-json /tmp/arr.ast.json
/tmp/algoscope /tmp/arr.ast.json
```

Requires SDL2 + SDL2_ttf (e.g. `brew install sdl2 sdl2_ttf`). The window font is
`/System/Library/Fonts/Supplemental/Arial Unicode.ttf` (a single-face .ttf that
harfbuzz shapes reliably); change `FONT_PATH` in `main.yoop` for other systems.

## Controls

| key / input        | action                              |
| ------------------ | ----------------------------------- |
| up / down, j / k   | select previous / next function     |
| click a row        | select that function                |
| `-` / `=`          | lower / raise the detail depth      |
| mouse wheel        | scroll the pseudocode panel         |
| esc / q            | quit                                |

"Detail depth" is how many block levels deep the renderer expands before
glossing the rest. Lower it to see the high-level shape; raise it to drill in.

## Modules

| file         | role                                                              |
| ------------ | ----------------------------------------------------------------- |
| `json.yoop`  | a minimal JSON reader (recursive-descent over the source bytes)   |
| `ast.yoop`   | typed accessors over the dumped-AST JSON tree                     |
| `pseudo.yoop`| AST node -> pseudocode lines, with range detection and glossing   |
| `sdl.yoop`   | SDL2 + SDL2_ttf FFI bindings and a thin drawing/event helper layer |
| `main.yoop`  | window, two-panel layout, and the event-driven render loop        |

## How it works

`json.yoop` parses the `{ filename, source, ast }` payload into a generic
`JsonValue` tree. `ast.yoop` reads that tree directly through small accessors
(`field_str`, `child_by_label`, `group_items`, `top_functions`) rather than
building a second node tree. `pseudo.yoop` walks a function's statements from the
selection (depth 0), mapping each node kind to a notation string; when a block
sits below the current depth budget it is collapsed to one `<... N statements>`
line instead of being expanded. `sdl.yoop` wraps the SDL handles and renders each
text line via `TTF_RenderUTF8_Blended -> texture -> RenderCopy`. The UI only
redraws after input, so per-line texture creation costs nothing while idle.

## Notes / limitations

- Only top-level functions (including `export function`) are listed; trait/type
  methods are not surfaced.
- A handful of expression kinds (template literals, some patterns) render as
  placeholders; unknown node kinds degrade to a `<KIND>` line rather than crash.
- Notation is intentionally ASCII (the repo avoids non-keyboard glyphs in source);
  the abstraction style, not Unicode symbols, is what makes it read scientific.
