# diskscope

A desktop disk-usage treemap, in the spirit of WinDirStat / GrandPerspective,
written entirely in Yooperlang. Point it at a directory and it scans the tree,
sizes every entry by its aggregate bytes, and draws a squarified treemap where
each file is a tile sized to its share of the disk. Hover a tile to see its name
and size; press `c` to switch coloring schemes.

No menus, no deletion, no settings - just "load it up and look at where the
bytes went."

## Build and run

From the repository root. `node scripts/seed.mjs` prints the path of a compiler,
and the two variables point it at this tree's `std/` and `runtime/`.

```sh
# build (one time)
YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime \
  $(node scripts/seed.mjs) examples/playground/diskscope/main.yoop -o /tmp/diskscope

# run on a directory (defaults to "." if omitted)
/tmp/diskscope ~/some/project
/tmp/diskscope /usr/lib
/tmp/diskscope          # scans the current directory
```

Requires SDL2 + SDL2_ttf (e.g. `brew install sdl2 sdl2_ttf`). The window font is
`/System/Library/Fonts/Supplemental/Arial Unicode.ttf` (a single-face .ttf that
harfbuzz shapes reliably on macOS); change `FONT_PATH` in `main.yoop` for other
systems.

## Controls

- move the mouse over a tile: its name and size show in the header bar
- `c`: toggle the color scheme (by file kind / by tree depth)
- esc or `q`: quit
- resize the window: the treemap re-lays-out to fit

## How it reads

Bigger tile means more bytes. A directory is the rectangle enclosing its
children, so you can see at a glance which folders dominate and drill in
visually by eye. In "by kind" mode tiles are colored by file category (code,
images, media, archives, docs, web, other); in "by depth" mode by how deep they
sit in the tree. Directories themselves are drawn as faint outlines so the
nesting reads without hiding the file tiles.

## Modules

- `fs_walk.yoop`: recursive directory scan into a flat `Vec<FsNode>` where each
  node refers to its children by integer id (the same arena+NodeId shape the
  self-hosting bootstrap uses). Post-order construction lets a directory sum its
  children's sizes the moment it is built.
- `treemap.yoop`: the squarified treemap layout, the hit-test, and a
  `ColorScheme` trait with two implementations.
- `sdl.yoop`: SDL2 + SDL2_ttf FFI bindings and a thin drawing/event helper layer
  (adapted from the algoscope playground).
- `main.yoop`: the window, the event-driven render loop, hover, and the layout
  arena.

## Yooperlang features it leans on

This is a dogfooding exercise, so it deliberately uses a spread of the language:

- The arena allocator (`std/core/alloc.yoop`). The treemap layout buffer is
  bump-allocated from an `Arena` that is reset before every relayout, so resizing
  the window reuses one region instead of churning malloc/free. The scanned tree
  itself stays on the default allocator (its size is not known up front, and the
  v1 arena is a single fixed block), which is the honest split: arenas shine for
  the fixed-size, frequently-recomputed scratch, not the open-ended scan.
- The `disposable` kind for the scanned-node `Vec` (auto cleanup at exit).
- A `ColorScheme` trait with two `implements` (`DepthColors`, `KindColors`),
  dispatched by trait-qualified calls and selected at runtime.
- Generics (`Vec<FsNode>`, `Vec<int32>`), enums + `switch` (`EntryKind`,
  `ColorMode`), and the C FFI for both SDL and a small set of directory-walk
  helpers in the runtime (`runtime/yoop_io.c`: `yoop_io_opendir` / `readdir` /
  `closedir` / `stat2`, an lstat-based probe so symlinks are not followed).

## Notes and limitations

- The scan stops after `MAX_NODES` entries (300k) so pointing it at a huge tree
  degrades instead of exhausting memory; the reported total then undercounts.
- Symlinks are not followed (they read as 0-size leaves), which avoids
  symlink-cycle recursion and double-counting linked trees.
- Tiles smaller than a couple of pixels are not drawn or hover-tested - the
  long tail of tiny files is folded into the visual texture of their directory.
- HiDPI is left at 1:1 (no `ALLOW_HIGHDPI`), matching the algoscope playground,
  so mouse coordinates line up with the renderer without scaling.
