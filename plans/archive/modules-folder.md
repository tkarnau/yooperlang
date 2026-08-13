# Plan - a program-owned module root (`modules/`)

## Status: resolution has LANDED

The first cut is in. `modules/<name>` resolves, flat is enforced, and
[examples/modules_demo/](../../examples/modules_demo) is a working program using an
installed module that has a dependency of its own. Full `npm test` is green (991
tests). What landed:

- The resolver branch, the upward walk, the nested-root rejection, and the three
  diagnostics, in [moduleGraph.js](../../src/jsyoopdriver/moduleGraph.js).
- Unit coverage in
  [moduleGraph.test.js](../../src/jsyoopdriver/moduleGraph.test.js) (10 cases, real
  directory trees in a temp dir rather than a stubbed fs, because the feature IS
  filesystem behavior).
- Two e2e cases in [e2e.test.js](../../src/e2e.test.js): the demo program compiles
  and runs, and the module's own tests run out of its `modules/` directory.
- SPEC.md section 1 gained a `modules/` subsection; the "no package manager"
  non-goal was narrowed rather than deleted.

Two claims in the design were verified rather than assumed. The **byte-identical
module file** resolves `modules/<dep>` against a sibling `modules/` while being
developed and against the consumer's flat `modules/` once installed, with no
rewriting. And the **tests-for-a-shared-module** question, listed below as
unresolved, resolved itself in the affirmative - see that section.

Also landed since: [tools/yoopdist](../../tools/yoopdist), the dist builder, **written
in Yoop** - it copies a module's sources and tests, skips its `modules/` folder,
and regenerates the `requires` block. And [modules/](../../modules) at the repo root
is now the home for officially supported non-std modules, which makes the repo its
own consuming program.

Still NOT built, deliberately: the consumer-side reader (`yoopiler modules`, the
recorded-versus-installed view), and there is no manifest or fetch.

Writing the tool in Yoop paid for itself immediately by finding a **silent std
bug**: `lastIndexOfSeq` in [std/core/bytes.yoop](../../std/core/bytes.yoop) had an
inverted loop condition (`i` started one BELOW `max` and the guard was `i > max`),
so the body never executed and every call reported not-found. It failed quietly -
`fs.dirName` returned its own input, which is a wrong answer with no error
attached and a parent-directory walk that never terminates. Fixed, with a
regression fixture at
[examples/pass/strings_last_index_of.yoop](../../examples/pass/strings_last_index_of.yoop).
A related sharp edge is documented but deliberately NOT changed: `dirName` on a
path with no separator returns that path rather than `""`, so a caller walking
parents must stop when the result stops changing.

## Why now

The module rework ([modules-as-directories.md](modules-as-directories.md))
already built the thing a package needs to be. `std/http` today is, structurally,
a third-party package: a directory of source files sharing one namespace,
imported by directory path, mangled under a path-derived id, with sibling
visibility and import locality enforced across it. Nothing about it is special to
being in `std/` except the root it resolves against.

So the remaining question is not "what is a package" but "where does the compiler
look for one it did not ship." That is one more import root, and the resolver has
a clean two-branch shape to add it to.

## What this is not

- **Not a package manager.** No manifest, no fetch, no URLs, no versions, no
  lockfile, no cache. The developer puts a directory in `modules/`, by copy,
  submodule, or symlink. The archived manifest-and-fetch design
  ([archive/package-system.md](package-system.md)) stays archived; if it
  ever lands it lands on top of this, because it would only be deciding what
  populates the folder, not how imports resolve.
- **Not a new vocabulary.** There is deliberately no `package` concept in the
  language or the compiler. What you drop in `modules/` is a module, imported the
  way modules are imported. This keeps the terminology note at
  [modules-as-directories.md:42](modules-as-directories.md#L42) intact rather than
  fighting it.
- **Not a change to import syntax.** `import * as x from "..."` is unchanged. Only
  the set of legal path prefixes grows.

## Decisions

1. **Spelling is `modules/<name>`**, mirroring `std/`. The folder name is the
   prefix, so the convention is self-documenting and there is nothing new to
   learn. A bare specifier (`"json"`) was rejected because it turns a mistyped
   relative path into a silent package lookup and costs the existing clear
   diagnostic.
2. **The root is found by walking up from the importing file.** Nearest ancestor
   directory containing a `modules` subdirectory wins. One rule everywhere: it
   works for an entry under `src/`, it works from inside a package, and the LSP
   can resolve a file without knowing which entry point owns it.
3. **Resolution only in the first cut.** A third branch in the resolver, an
   explicit error on nesting, fixtures, and docs.

## The rule

Resolving `modules/<rest>` from a source file at `F`:

1. Starting at `dirname(F)` and walking to the filesystem root, find the first
   directory `D` where `D/modules` exists and is a directory. That is the modules
   root `R`.
2. If no such `D` exists, error naming the directories searched.
3. Otherwise resolve against `R` exactly the way the `std/` branch resolves
   against `STD_ROOT`, and hand the result to the existing shared tail: realpath,
   directory-or-file check, the `.yoop` extension rule, directory-module loading,
   and the "you named one source file of a directory module" diagnostic.

The first `modules` ancestor wins **whether or not it contains the requested
name**. Continuing the walk past it would let a stray `modules` folder in a home
directory answer for a program's own, and would turn a plain typo into a confusing
resolution from somewhere unexpected. A miss inside the found root is a better
error than a hit outside it.

Step 3 is the point of the design: `modules/json` (a directory module),
`modules/web/router` (a directory module nested inside a plain directory), and
`modules/helper.yoop` (a single-file module) all work with no code beyond picking
the root, because they are the same tail `std/` already runs.

### Flat is the policy, and it is enforced

One copy of a name per program. There is no version conflict to reconcile,
because two versions cannot both be present. That is the same place vendoring and
Go's single-version-per-build rule end up, and it is worth stating as the rule
rather than apologizing for it as a limitation.

The escape hatch exists whether or not it is wanted, which is why it gets an
explicit error instead of silence. `moduleId` is a hash of the resolved path
([moduleId.js:21](../../src/jsyoopdriver/moduleId.js#L21)), so two copies of `json`
at two paths are two distinct modules with distinct mangled symbols. They would
link. But they are also **two distinct nominal types**: passing copy A's
`json.Value` to a function expecting copy B's `json.Value` fails, and the
diagnostic prints `Value` on both sides of the mismatch. That is the diamond
problem arriving as the worst error message in the language.

So: when a module is loaded out of a modules root, error if that module's own
directory contains a `modules` subdirectory. Naming the rule at the point of
violation is cheap; discovering it later through a `Value` is not assignable to
`Value` diagnostic is not. If real multi-version support is ever wanted, the work
is a type-identity story, not a resolution story, and it is much better not to
have shipped the confusing version first.

## Authoring a module meant to be shared

A module in `modules/` may import `modules/...` itself. Two contexts, one rule,
and the convention that falls out is worth stating because it is the whole reason
the upward walk is anchored where it is.

**Consuming.** The dependency resolves to the CONSUMING program's root, not to
anything the package carries:

```text
app/
  main.yoop
  modules/
    json/          <- the package
      parse.yoop   <- imports "modules/http"
    http/          <- resolves HERE
```

The walk from `app/modules/json/parse.yoop` checks `app/modules/json/modules`
(nothing), `app/modules/modules` (nothing), then `app/modules` (hit). The flat
model is automatic; the package does not know it was flattened.

**Authoring.** The shippable unit is the module DIRECTORY ALONE. Development
dependencies live in a `modules/` folder that is a SIBLING of it, and never ship:

```text
json-repo/
  json/            <- the shippable unit
    value.yoop        files declare `module json;`
    parse.yoop        imports "modules/http"
  modules/
    http/          <- dep, for developing and testing json
  tests/
    json.test.yoop
```

The walk from `json-repo/json/parse.yoop` finds `json-repo/modules`. The same
import line in the same file resolves to the author's dev copy in the author's
repo and to the consumer's copy in the consuming program, with **no rewriting on
the way out**. Publishing is handing someone the `json/` directory.

This case is what justifies the upward walk over a fixed anchor at the entry
file's directory. In a consuming program both rules agree; in the author's repo
the "program" is a test harness in a subdirectory, and a fixed anchor would look
for `json-repo/tests/modules`.

It also sharpens the nesting error from the section above. The way a nested
`modules/` actually happens is an author shipping the whole repo instead of the
module directory, so the diagnostic should say that rather than only stating the
one-copy rule.

**The cost, stated plainly:** with no manifest, transitive dependencies are the
consumer's problem, installed by hand. Nothing announces that `json` needs `http`
until the compile fails. That failure is a good one (it names the missing import,
the file inside `modules/json` that wanted it, and the root that answered) and the
diagnostic should lean into it: say that the import came from a module inside the
root, so the fix is to add the dependency alongside it. A build-time error naming
the exact directory to create is a workable floor for a hand-managed folder, and
it is exactly the seam a manifest fills later without changing the resolution
rule.

**Tests ship inside the module directory** (verified, and better than the sibling
`tests/` directory this section originally guessed at). `*.test.yoop` is excluded
from a directory module's source file list, so a test file sitting in the module
directory is its own single-file test module - which is exactly what lets it
import the module under test by the path a CONSUMER writes:

```text
modules/math/
  MODULE
  ints.yoop          module math;
  vec2.yoop          module math;
  math.test.yoop     import * as math from "modules/math";
```

That import resolves by the ordinary upward walk (the file's own directory holds
no `modules/`, so the walk continues to the program's root and comes back down
into `math`). It does not trip the "imports its own module" guard, because the
test file is not part of the module. The payoff is that the module is exercised
through its published surface, with an import line character-for-character
identical to the consuming program's, and the tests travel with the module when
it ships. Worked example: [examples/modules_demo/](../../examples/modules_demo).

## The `MODULE` file (advisory versions)

There is no manifest driving resolution, but a shared module should still be able
to say what it is and what it was built against. The file that does this is
**informational and inert**: nothing in it is resolved, chosen, or enforced. It is
the dependency-shaped version of the same call the ownership redesign made
([ownership-and-typestate-redesign.md](../ownership-and-typestate-redesign.md)):
document the contract, do not enforce it.

It lives in the module directory, so it travels with the shippable unit:

```text
name     json
version  0.3.1

# Dependency versions recorded when this was shipped. Informational: the
# compiler does not resolve, choose, or enforce anything from this file.
requires http 1.2.0
requires csv 0.1.0
```

Named `MODULE`, alongside `LICENSE` and `README`, because an all-caps extensionless
file reads as informational at a glance. It drops in with no loader change:
`listModuleSourceFiles` filters to `.yoop`, so a `MODULE` file is already invisible
to the module graph.

**Not yoop source, deliberately.** The archived plan's `@yoopackage` aesthetic
points the other way, but this file has to be readable when the compiler is not
involved: in a tarball listing, on a repo page, in a review diff. And a `.yoop`
file inside a module directory must declare the module header, which would make it
part of the module and subject to typecheck, creating steady pressure to make it
"real". Staying inert is the feature. The line grammar (`<key> <value...>`, `#`
comments, blank lines ignored, `requires` repeatable) is a dozen lines to parse if
tooling ever needs to and zero if a human is just reading it.

**Generation splits by who knows what.** The author owns the `version` line; a
tool owns the `requires` block. This is built: [tools/yoopdist](../../tools/yoopdist),
written in Yoop, reads the module's imports, resolves each `modules/` dependency's
version from the modules root the module develops against, and rewrites only the
dependency snapshot. It cannot invent a version number and does not derive one
from git tags. A dependency with no `MODULE` records as unknown: silence when
there is no data.

Two rules the implementation settled that the design had not:

- **Refine what you can verify, preserve what you cannot.** If a dependency is
  not installed next to the module being dist'd, the version already recorded in
  the source `MODULE` is kept rather than overwritten with `unknown`. Without
  this, disting an already-dist'd module silently destroyed its snapshot.
- **Blank lines are held back and emitted only when a non-blank line follows.**
  Carrying an existing `MODULE` forward means dropping its old `requires` block
  and appending a new one; emitting the separator eagerly grew the file by a
  blank line on every dist. The tool is idempotent, and there is a test for it.

**Consumption is on demand, not automatic.** The tempting move is a compiler
warning on drift, and the machinery is right there (the loader already visits every
module directory, and `pushWarning` is an advisory channel that prints without
touching the exit code). It is deliberately NOT the first cut, because such a
warning fires on every legitimate upgrade too: bump http to 1.3.0 and every module
that recorded 1.2.0 complains until each is re-shipped. That is a warning people
learn to ignore, which is worse than none. Suppressing it correctly would mean the
compiler deciding which version differences are benign, which means teaching it
what a version MEANS, which is the solver this whole design exists to avoid.

So the consumer-side surface is a command that prints recorded-versus-installed
side by side, on demand. The automatic warning stays available if the on-demand
view turns out to be the thing nobody remembers to run.

**The limitation, which belongs in the file's own comment:** this records what a
module was built and tested against, not what it requires. No ranges, no
compatibility claims. A consumer seeing drift has to use judgment. That is the
point, but `requires` must not be misread as a constraint.

## What comes free

Everything downstream of path resolution, because a package module is just a
module at an absolute path:

- Cycle detection and topological sort (module granularity, absolute paths).
- Sibling visibility and import locality inside a package directory module.
- Symbol mangling, DWARF, and the LSP.
- `extern "C" from library "m"` already emits `-lNAME`, so a package can declare
  its own system library dependencies with no new machinery.
- Relative imports inside a package resolve against the importing file, so a
  package's internal layout is its own business.
- The `--test` harness: the synthetic entry is registered at
  `entryPathFor(rootDir)`, whose dirname is a real directory in the project, so
  the walk works even though the entry itself is an overlay with no file on disk.

## What changes

- [src/jsyoopdriver/moduleGraph.js](../../src/jsyoopdriver/moduleGraph.js) -
  `resolveImportTarget` grows a `modules/` branch. The cleanest shape is to
  restructure it as "pick a root, then run the shared tail": `std/` picks
  `stdRoot`, `modules/` picks the walked-up root, everything else picks
  `dirname(fromAbsPath)`. The tail is already written and stays one copy.
  `loadDirectoryUnit` (or its caller) grows the nested-`modules` check.
- A small helper for the upward walk. It belongs next to `moduleId.js` in the
  driver rather than in [install_root.js](../../src/install_root.js): the modules
  root is **program-relative and never install-relative**, so it must not become
  a fourth `CANDIDATE_PREFIXES` entry. Worth a comment saying so, since that file
  is otherwise the obvious home for "where do things live."
- Docs: [SPEC.md](../../SPEC.md) section 1 (import paths) and the line at
  [SPEC.md:1832](../../SPEC.md#L1832) that says there is no package manager, which
  becomes "no package manager; a program-owned `modules/` root."

Nothing in the packaging path changes. `modules/` is never shipped inside the
compiler distribution.

## Errors to write

- No root found: name the import, the importing file, and the fact that no
  `modules` directory was found in any parent directory.
- Root found, name missing: name the resolved root so the user can see which
  `modules` folder answered, and list its entries as a did-you-mean.
- Nested root: name both directories and state the one-copy rule.
- The existing "import path must be relative, absolute, or start with std/"
  message grows `modules/`.

## Verification

- Unit, `src/jsyoopdriver/moduleGraph.test.js`: root found at the importing file's
  own directory; root found several levels up; entry under `src/` with the root at
  the project root; first-root-wins when two are on the path; miss inside a found
  root; no root at all; a package importing `modules/...` resolving to the
  program's root; nested-root rejection.
- E2E, a fixture under `examples/pass/`: a program with `modules/<pkg>/` as a
  directory module, imported and called, through to a running binary. A second
  case where the package itself imports `std/` and a third where it imports
  another entry in `modules/`.
- Fail fixtures for the missing-root and nested-root diagnostics.
- LSP: confirm a file inside `modules/` opens without spurious diagnostics, since
  the walk is file-local and needs no entry point.

## Deferred

- **A manifest and a fetch command.** [archive/package-system.md](package-system.md).
  Only worth building when there is somewhere to fetch from.
- **Multi-version.** Blocked on type identity, not on resolution. See the flat
  section above.
- **A package shipping its own `.c` file.** `RUNTIME_SOURCES` in
  [runtimeBuild.js](../../src/runtimeBuild.js) is a fixed list and yoop source has no
  way to add a translation unit to the clang invocation. A package can bind to a
  system library today but cannot carry glue code. This is a real boundary and it
  is worth knowing about before someone tries; it is not in scope here.
- **Folder name versus declared module name.** `modules/json/` declaring
  `module jsonp;` is legal, because module identity is the path and the declared
  name is only a label. The import spells the folder, so the two can disagree. The
  existing rule already covers this and no new check is proposed; revisit only if
  it actually confuses someone.
