# Removing the dependency on Node

Retiring the JS COMPILER and removing NODE are different objectives, and the
second is bigger. [retire_js_compiler.md](retire_js_compiler.md) covers the
first; this is what is left after it.

Measured, not estimated. Line counts are non-blank source, excluding
`node_modules` and the generated `web/` data.

## The one thing that is not mechanical: the SEED

Everything else here is work. This is a decision.

`bootstrap/src` is compiled by `src/yoopiler.js`. That is the only way the
compiler gets built from a clean checkout - `package:boot` builds stage1 with
it, and the self-host test seeds stage1 from it. So the JS compiler is not just
a reference: it is the BOOTSTRAP SEED, and deleting it means a checkout can no
longer build the compiler from source alone.

DECIDED: the seed is a YOOP COMPILER - option 1 below. A build seeds from a
previously released `yoopiler_boot` binary rather than from a JavaScript
compiler, so `src/` is DELETED rather than frozen and Node stops being a build
dependency once the rest of this document is done.

Three ways out, and they are not equally good:

  1. SEED FROM A RELEASE - CHOSEN. CI already publishes
     `dist/yoopiler-boot-<version>-<platform>.tar.gz`, and `package:boot`
     proves that binary can compile hello.yoop with no `YOOP_STD_ROOT` set - so
     it is already a working seed. A build downloads the previous release and
     compiles the tree with it. This is what most self-hosted compilers do, and
     the cost is that the chain has to start SOMEWHERE: a first-time builder
     with no network and no prior binary cannot bootstrap.
  2. COMMIT A SEED BINARY. Removes the network dependency and adds a
     platform-specific binary to the repo, which has to be rebuilt for every
     platform and re-committed on every format change. Not recommended.
  3. KEEP THE JS COMPILER AS A SEED ONLY. Frozen, unshipped, not developed, not
     CI-gated except as the thing that builds stage1. Node stays a build
     dependency and nothing else. Cheapest, and it contradicts the objective
     only in the letter.

Nothing below can be finished without picking one.

## What still runs on Node, and what each would take

### 1. The compiler and the language server - 36,539 lines

`src/jsyoop*` plus `src/lsp/`. Retiring it is
[retire_js_compiler.md](retire_js_compiler.md), and the LANGUAGE half of that
is done: the surface probe is at zero refused and zero bad-IR, so the bootstrap
compiles everything the reference does.

What is left there is not the compiler - it is the coverage that dies with it,
plus five driver flags: `--track-heap`, `--warn-disposable`, `--warn-std`,
`--dump-ast-json` and `--list-attributes`.

### 2. The test estate - 13,373 lines of tests plus a 277-line process harness

The biggest single item, and the one with the least glamour.

  * `e2e.test.js` (4,838 lines, 403 tests) - 112 of them drive the JS
    typechecker AS A LIBRARY over `examples/fail/`'s 139 negative fixtures.
    Those need a bootstrap-run diagnostic harness; the rest can be repointed.
  * the per-subsystem unit tests (parser 213, typechecker 203, lexer 57, ...) -
    each needs its bootstrap counterpart to EXIST before its JS file is deleted,
    or the coverage is simply gone.
  * `slice.test.js`, `selfhost.test.js`, `debug.test.js` - these DRIVE the
    bootstrap from Node. They survive the compiler's deletion and are the last
    Node to go. Replacing them means a Yoop program that spawns processes and
    compares output; `system()` through an extern already does the spawning, and
    capturing stdout needs `popen` or a redirect.
  * `runtimeC.test.js` (11) and `std_index.test.js` (4) - about the C runtime
    and the generated index, not about the compiler. They stay either way.

### 3. Build and release - 1,819 lines across `scripts/`

  * `build_sea.mjs` (313) and `package_release.mjs` (182) package the JS
    compiler. They RETIRE with it; nothing replaces them.
  * `package_bootstrap.mjs` (244) builds the three stages, checks the fixpoint
    and tarballs the result. A shell script or a Yoop program; it orchestrates
    rather than computes.
  * `gen_web.mjs` (845) regenerates the site. Needs `--dump-ast-json`, which
    the bootstrap does not have, plus `--dump-tokens`, which
    `bootstrap/tools/dump_tokens.yoop` already covers.
  * `gen_std_index.mjs` (42) is already replaced by `tools/stdindex/main.yoop`;
    switching is nearly free.
  * `migrate-intrinsics.mjs` (193) is a spent one-time migration. Delete it.

### 4. Everything else - 625 lines

  * `tools/yoopkg/yoopkg.mjs` (274) - the package manager. `tools/yoopdist` and
    `tools/yoopbinder` are already Yoop, so this is the odd one out.
  * `editors/vscode/extension.js` (351) - a VSCode extension IS JavaScript. It
    is not a build dependency and it does not go away; what it can stop doing is
    launching `src/lsp/server.js` as a Node child, once `yoopiler_boot --lsp`
    exists.
  * `tools/mcp-reference/` - a dev convenience, unrelated to building.

### 5. npm as the task runner

`package.json` is how every command in CLAUDE.md is spelled. Replacing it is a
Makefile or a shell script, and it is the LAST step rather than an early one -
the scripts have to have somewhere to go first.

## Order

  0. PICK A SEED. Nothing finishes without it.
  1. The five driver flags, so `gen_web` and the diagnostics work have what they
     need.
  2. The diagnostic fixture harness for `examples/fail/`, and the `.expected`
     corpus - the two things that carry e2e's coverage across.
  3. Port the per-subsystem unit tests, deleting each JS file only once its
     counterpart exists.
  4. Repoint `gen_web` and `gen_std_index`; delete `migrate-intrinsics`.
  5. Delete `src/`, `build_sea.mjs`, `package_release.mjs`, `probe_programs.sh`
     and the `npm test` gate.
  6. Rewrite `package_bootstrap.mjs` and the remaining harnesses.
  7. Rebuild the LSP as `yoopiler_boot --lsp` and repoint the extension.
  8. Replace npm as the task runner.

Steps 1-5 leave Node as a TEST and BUILD-SCRIPT dependency only. Steps 6-8 are
what actually remove it.
