# web/

The Yooperlang site: landing page, an interactive tour, a compiler-pipeline
explorer, the language reference, and a std browser.

No framework, no bundler, no CDN, nothing to install. Plain HTML, one
stylesheet, a few vanilla-JS files. [.github/workflows/pages.yml](../.github/workflows/pages.yml)
publishes it to GitHub Pages on every push that touches this directory.

```text
index.html       landing page: the pitch, the three-layer model, the kind/IR demo
tour.html        get the compiler, then five programs and their real output
pipeline.html    source, tokens, AST, LLVM IR, the program running
reference.html   the language reference, hand written
std.html         every exported signature in std/, generated from the source

assets/site.css      the whole design system, dark and light
assets/highlight.js  the .yoop syntax highlighter (plus a small LLVM one)
assets/site.js       theme, code blocks, scrollspy, search dialog
assets/home.js       the landing page's layer switcher and IR diff
assets/tour.js       episode panes, run buttons, break-it cards
assets/pipeline.js   the five-stage explorer and its cross-highlighting
assets/std.js        the std browser and its filter

data/*.data.js       GENERATED - see below
```

## The generated data is the point

Nothing here retypes what the compiler does. `data/*.data.js` is written by
[scripts/gen_web.mjs](../scripts/gen_web.mjs), which **builds the compiler from
this checkout and runs it**, then writes:

- `std.data.js` - every `export` in `std/` with signature, doc comment and
  source line, from reading `std/**/*.yoop`
- `tour.data.js` - the tour programs, their stdout, stderr and exit codes, plus
  the break-it diagnostics, from compiling and running `examples/tour/` and
  `examples/fail/`
- `pipeline.data.js` - token streams, ASTs and LLVM IR excerpts, from the
  `dump_tokens` tool, `--dump-ast-json`, and the `.ll` beside each executable
- `home.data.js` - the two functions the landing page diffs, sliced out of the
  pipeline data
- `status.data.js` - module and example counts, version, commit
- `search.data.js` - every heading on every page, every std export, every
  episode, from reading the `.html` files here

Regenerate after changing `std/`, the tour programs, or a page's headings:

```bash
npm run gen:web
```

It needs `clang` like every other compile here, and it is strict on purpose: a
tour program that stops compiling, or a break-it fixture that starts compiling,
fails the run rather than quietly publishing a lie.

Output is `.data.js` rather than `.json` so a double-clicked `file://` page still
works. There is no fetch anywhere on this site.

## Run it locally

Any static file server, from the repo root:

```bash
python3 -m http.server -d web 8080
# or, with no install
npx --yes serve web -l 8080
```

Then <http://localhost:8080/>. Opening `web/index.html` straight from the
filesystem also works, which is the reason for `.data.js` above.

## Editing notes

- **Prose lives in the HTML; code and output live in the data.** A tour episode
  writes its narration in `tour.html` and gets its program, output and
  diagnostics injected from `tour.data.js`. That is what keeps the site honest
  when a program changes.
- **Add a tour episode, pipeline sample, or break-it card** by editing the three
  tables at the top of `scripts/gen_web.mjs`, then adding the matching
  `<div data-episode="...">` section to the page.
- **`std.html` is entirely generated.** Write the doc comment in `std/` and
  regenerate; do not hand-write API prose there.
- **Theme.** Both palettes are defined in full in `site.css`. The site follows
  the reader's system preference and remembers an explicit toggle in
  `localStorage`.
- **Writing style** matches the rest of the repository: no em-dash, no
  characters that are awkward to type on an American keyboard.
