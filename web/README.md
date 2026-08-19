# web/

The Yooperlang site: a landing page, an interactive tour, a compiler-pipeline
explorer, the language reference, and a standard-library browser.

No framework, no bundler, no CDN, and nothing to install. Plain HTML, one
stylesheet, and a handful of vanilla-JS files. It is published to GitHub Pages
by [.github/workflows/pages.yml](../.github/workflows/pages.yml) on every push
that touches this directory.

## What is here

```text
index.html       landing page: the pitch, the three-layer model, the kind/IR demo
tour.html        install the compiler, then five programs and their real output
pipeline.html    source -> tokens -> AST -> LLVM IR -> the program running
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

Nothing on this site retypes what the compiler does. `data/*.data.js` is written
by [scripts/gen_web.mjs](../scripts/gen_web.mjs), which **actually runs the
compiler in this checkout** and captures what came out:

| File | What is in it | Where it came from |
| --- | --- | --- |
| `std.data.js` | every `export` in `std/`, with signature, doc comment and source line | reading `std/**/*.yoop` |
| `tour.data.js` | the tour programs, their stdout and stderr, their exit codes, plus the break-it diagnostics | compiling and running `examples/tour/` and `examples/fail/` |
| `pipeline.data.js` | token streams, ASTs, LLVM IR excerpts | `--dump-tokens`, `--dump-ast-json`, `--keep-ir` |
| `home.data.js` | the two functions the landing page diffs, in source and in IR | sliced out of the pipeline data |
| `status.data.js` | module and example counts, version, commit | the repository |
| `search.data.js` | every heading on every page, every std export, every episode | reading the `.html` files in this directory |

Regenerate after changing `std/`, the tour programs, or a page's headings:

```bash
npm run gen:web
```

It needs `clang` on PATH like every other compile here, and it is strict on
purpose: a tour program that stops compiling, or a break-it fixture that starts
compiling, fails the run rather than quietly publishing a lie.

The output is `.data.js` rather than `.json` so a double-clicked `file://` page
still works. There is no fetch anywhere in this site.

## Run it locally

Any static file server works. From the repo root:

```bash
python3 -m http.server -d web 8080
# or, with no install
npx --yes serve web -l 8080
```

Then open <http://localhost:8080/>. Opening `web/index.html` directly from the
filesystem also works, which is the reason for the `.data.js` choice above.

## Editing notes

- **Prose lives in the HTML; code and output live in the data.** A tour episode
  writes its narration in `tour.html` and gets its program, its output and its
  diagnostics injected from `tour.data.js`. That is what keeps the site honest
  when a program changes.
- **Add a tour episode, a pipeline sample, or a break-it card** by editing the
  three tables at the top of `scripts/gen_web.mjs`, then adding the matching
  prose section (`<div data-episode="...">`) to the page.
- **`std.html` is entirely generated.** Do not hand-write API prose there; write
  the doc comment in `std/` and regenerate.
- **Theme.** Both palettes are defined in full in `site.css`. The site follows
  the reader's system preference and remembers an explicit toggle in
  `localStorage`.
- **Writing style** matches the rest of the repository: no em-dash, no
  characters that are awkward to type on an American keyboard.
