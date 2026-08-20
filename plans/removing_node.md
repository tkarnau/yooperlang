# Removing the dependency on Node

The compiler itself no longer needs Node: `bootstrap/` is the only Yooperlang
compiler, it compiles itself, and a build starts from a previously released
`yoopiler_boot` binary rather than from a JavaScript program. What is left is
everything AROUND the compiler - the test harnesses, the build and release
scripts, the package manager, the editor integration, and the task runner - and
one rewrite the compiler still owes: the language server.

Measured, not estimated. Line counts are non-blank source, excluding
`node_modules` and the generated `web/` data.

## The seed, and the trade it carries

`scripts/seed.mjs` resolves the compiler a build starts from: `$YOOP_SEED`, then
the gitignored `.seed/` cache, then a download of the pinned `SEED_TAG` release.
`package:boot` proves the binary it produces can compile hello.yoop with nothing
else on the path, which is what makes a release a usable seed.

The cost, stated plainly: the chain has to start SOMEWHERE. A first-time builder
with no network and no prior binary cannot bootstrap. `YOOP_SEED` is the way out
for anyone who already has a binary, and it is what CI uses for a cached seed.
The alternative that was rejected is committing a seed binary to the repo: it
removes the network dependency and adds a platform-specific binary that has to be
rebuilt for every platform and re-committed on every format change.

## 1. The language server - the one rewrite still owed

Until `yoopiler_boot --lsp` ships, the editor experience is syntax highlighting:
`editors/vscode/extension.js` (323 lines) contains an LSP client with no server
to start.

It has to be a Yoop program built on the compiler's own passes - the lexer, the
module graph and the typechecker's diagnostics are all there, and a server that
reuses them cannot drift from the compiler the way a separate implementation
would. What the protocol needs underneath is already in place: a `Diagnostic`
carrying a code, a source location and a severity, and a module graph that can
be handed source text for an unsaved buffer instead of reading the file.

This is the largest single item here, and it is the only one a USER can feel.
It lands as a flag on the existing driver, so it also has to keep stdout clear:
in LSP mode stdout IS the transport, and anything a compile would print there
corrupts it.

Done when the extension gets diagnostics, hover, go-to-definition, references,
rename and completion back, `editors/vscode/README.md` stops saying they are
absent, and the extension launches `yoopiler_boot --lsp` rather than a Node
child.

## 2. The test estate - 2,137 lines of harness in `src/`

The harnesses DRIVE the bootstrap from Node; none of them is a compiler.

  * `slice.test.js` (346), `pass.test.js` (238), `fail.test.js` (228),
    `selfhost.test.js` (105) and `debug.test.js` (187) compile, run and assert
    programs. Replacing them means a Yoop program that spawns processes and
    compares output; `system()` through an extern already does the spawning, and
    capturing stdout needs `popen` or a redirect.
  * `testProc.js` (258) is the deadline-and-tree-kill discipline every one of
    them depends on. Whatever replaces the harnesses needs an equivalent, or a
    wedged clang goes back to outliving the suite.
  * `runtimeC.test.js` (145) and `std_index.test.js` (99) are about the C runtime
    and the generated index, not about the compiler. They stay either way.
  * `toolchain.js` (338), `runtimeBuild.js` (97) and `install_root.js` (96) are
    shared knowledge about invoking clang and locating `runtime/`. The bootstrap
    has its own copies of the parts it needs; these serve the harnesses.

## 3. Build and release - 1,184 lines across `scripts/`

  * `gen_web.mjs` (804) regenerates the site. It already drives
    `yoopiler_boot`, including `--dump-ast-json`, so a rewrite is a port rather
    than a blocked item. It is the largest script and the one with the most
    file-shuffling.
  * `package_bootstrap.mjs` (221) builds the three stages, checks the fixpoint
    and tarballs the result. A shell script or a Yoop program; it orchestrates
    rather than computes.
  * `seed.mjs` (119) is the bootstrap seed resolver. It is the one script that
    cannot be written in Yoop without a chicken-and-egg problem, since it runs
    BEFORE any Yoop compiler is available. A shell script is the realistic
    target.
  * `gen_std_index.mjs` (40) is already replaced by `tools/stdindex/main.yoop`;
    switching is nearly free.

`probe_surface.sh` and `ci_local.sh` are shell already.

## 4. Everything else - 780 lines

  * `tools/yoopkg/yoopkg.mjs` (247) - the package manager. `tools/yoopdist` and
    `tools/yoopbinder` are already Yoop, so this is the odd one out.
  * `editors/vscode/extension.js` (323) - a VS Code extension IS JavaScript. It
    is not a build dependency and it does not go away; what changes is what it
    launches, once item 1 exists.
  * `tools/mcp-reference/server.js` (210) - a dev convenience, unrelated to
    building.

## 5. npm as the task runner

`package.json` is how every command in CLAUDE.md is spelled. Replacing it is a
Makefile or a shell script, and it is the LAST step rather than an early one -
the scripts have to have somewhere to go first.

## Order

  1. Rebuild the LSP as `yoopiler_boot --lsp` and repoint the extension.
  2. Repoint `gen_std_index` at `tools/stdindex`.
  3. Rewrite `package_bootstrap` and `gen_web`.
  4. Rewrite the harnesses, and `testProc`'s discipline with them.
  5. Replace npm as the task runner.

Steps 2 and 3 leave Node as a TEST dependency only. Steps 4 and 5 are what
actually remove it.
