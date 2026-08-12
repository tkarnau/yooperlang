# Plan - a module is a directory of source files

## Why

Today a module is one file. The consequence is not the `import * as x`
boilerplate; it is that **acyclicity is enforced at file granularity**, so any
two concepts that reference each other have to be pulled apart into a third
file that owns the shared vocabulary. `bootstrap/src/contracts.yoop` is 1199
lines for exactly this reason: it holds lexer vocabulary, AST vocabulary,
module-graph vocabulary, and typecheck vocabulary in one place because each of
those, if it lived with its owner, would make the owner a dependency of
everything. The tell is one layer down: contracts.yoop imports `quickSort` from
`utils/array_utils.yoop`, while `utils/ast_utils.yoop` imports `AST` back out of
contracts. Those two utils files are one concept split in half purely so the
vocabulary file can call a sort without importing the thing that imports it.

Losing the thread while reading a 1199-line grab bag is the thing to fix. The
point of the bootstrap experiment is to feel the language's ergonomics, and this
is the language telling us something.

**Not to be confused with** [archive/package-system.md](package-system.md),
which is about fetching third-party dependencies (`@yoopackage`, URLs, a
manifest). That is a distribution concern and a different axis. See the
terminology note below for how the two stay out of each other's way.

## What this is not

- Not a change to import syntax. `import * as vec from "..."` stays exactly as
  it is. Implicit namespace binding (the Odin `import "core:fmt"` shape) is a
  separate, smaller question and is deliberately out of scope.
- Not a change to visibility semantics beyond the one that falls out for free:
  `export` starts meaning "visible outside this module" rather than "visible
  outside this file". Non-exported declarations become visible to sibling files
  in the same module, which is the entire point.
- Not the std `snake_case` to `camelCase` rename (`vecNew` to `vecNew`). That
  is a known separate migration and mixing it in would make every diff here
  non-mechanical. Keep it on its own track.

## Terminology

Use **module** for the directory-or-file unit, and **source file** for one
`.yoop` file. Reserve **package** for the distribution unit in
[archive/package-system.md](package-system.md).

This is not just tidiness. The compiler already spells this concept
`moduleId` / `moduleEnv` / `moduleGraph` / `resolvedModuleId` across roughly 150
references. If the directory unit is called a module, every one of those
identifiers keeps its name and simply changes granularity. Calling it a package
means renaming all of them for consistency, which buys nothing and inflates the
diff.

## The shape of the change in the compiler

Written up in full detail during the design discussion; summarized here because
this plan's sequencing depends on it.

The compiler currently conflates two jobs that both key off a file path:

1. **A compilation unit** - an AST, a source string, a path. Used by
   diagnostics, DWARF, the LSP, and the `import.unsafe;` / `import.test;`
   pragmas.
2. **A symbol environment and mangling namespace** - `moduleEnv` keyed by
   `mod.id`, plus `moduleId` as a nominal identity component on types.

Only #2 moves to the directory. #1 stays per source file, and that is what keeps
this tractable. Two pieces of evidence that the split is already latent:

- `sourceLoc` is `{ pos, line, column }` with no file reference
  (src/helpers.js), and diagnostics render through
  `formatDiagnostic({ filePath, src, loc, message })` where filePath and src
  come off the module. Merging ASTs would destroy the node-to-file mapping and
  force a file id onto every sourceLoc plus every diagnostic, LSP, and DWARF
  consumer. Keeping source files as compilation units avoids all of it.
- DWARF already keys on the path, not the id: `beginModule(absPath)` in
  src/jsyoopcodegen/debugInfo.js. Per-file compile units survive untouched.

So: do not merge ASTs. Share the symbol tables.

## The de-risking mechanism: opt in per directory

The thing that makes a migration like this hurt is a flip day where the whole
tree is broken at once. Avoid it entirely by making directory-as-module
**declared, not inferred**:

```yoop
module http;

import * as vec, { Vec } from "std/core/vec.yoop";
```

A `module <name>;` line as the first item of a source file, in the same slot as
`import.unsafe;`. Rules:

- A directory is a module if and only if its `.yoop` files carry a `module`
  header. Every file in such a directory must carry the same name, and a
  mismatch is a clear error.
- A `.yoop` file with no header stays what it is today: a single-file module.
- The name comes from the declaration, not the dirname. That frees directory
  names from identifier constraints and lets a file say out loud which namespace
  it joins, which is worth more than the saved line.

Consequences that matter for sequencing:

- **The compiler change lands with zero std changes and a green test suite.**
  Nothing has a header yet, so nothing behaves differently.
- **Each directory opts in as its own small commit**, independently revertable.
  There is no flip day.
- A file accidentally saved into the wrong directory gets caught instead of
  silently joining a namespace.

`module` cannot be a hard keyword: `bootstrap/src/contracts.yoop` uses `module`
as a struct field name in three places. Recognize it contextually as the first
token of a source file, the same treatment `test` / `suite` / `conferred` /
`clearedBy` already get.

## Module identity and membership

The header names a module; it does not decide which module a file belongs to.
Four rules, and they resolve every "what if two of them..." question:

1. **Identity is the resolved directory path.** `moduleIdFor` keeps hashing a
   path, it just hashes a directory instead of a file. The declared name is a
   LABEL, not an identity. Two directories that both declare `module http;` are
   two different modules that happen to share a label, exactly as two files
   named `types.yoop` are two different modules today. This is Odin's and Go's
   model, and it is the only one compatible with resolution being
   relative-path-based: there is no global registry of module names to consult,
   and adding one would be a build system, not a language feature.

2. **Membership is physical, not declarative.** A file joins the module in the
   directory it sits in. `a/foo.yoop` cannot write `module bar;` and thereby join
   the module in `b/`. If it could, you could no longer learn a module's contents
   by listing a directory, the graph walker would need a whole-tree pre-scan to
   enumerate one module's files, and cycle detection would need that scan before
   it could run. All cost, no benefit.

3. **Modules are not recursive.** A module is exactly the `.yoop` files directly
   in its directory. A subdirectory is a separate module (or not a module at all)
   and is reached by importing it. So `std/http/` becoming a module says nothing
   about a future `std/http/internal/`, and enumeration stays one `readdir`. A
   subdirectory module importing its parent, or the reverse, is just an ordinary
   two-module edge, now checked for cycles at module granularity.

4. **A mixed directory is an error.** Every non-`.test.yoop` file directly in a
   module directory must carry the header. Half a module is not a state worth
   supporting, and the error is what catches a file added later by someone who
   did not notice the directory had opted in. `*.test.yoop` files are excluded
   from the module and need no header.

Two things that follow, worth stating so they are not rediscovered:

- **The declared name carries almost no semantic weight today.** Under explicit
  `import * as x from "path"` the local binding comes from the `as` clause, so
  the name is used for the opt-in signal, the intra-directory consistency check,
  and diagnostics. Nothing resolves through it. It is worth declaring anyway
  because it is what an implicit-namespace import would bind later, and because a
  file stating its own namespace out loud is the thing that catches a misplaced
  file. But do not build anything that depends on it being unique.
- **Name-vs-dirname is deliberately unenforced.** Requiring `module <name>;` to
  match the directory name costs nothing for the std layout below (every
  directory there is already a single lowercase word) and buys predictability.
  It is left unenforced because the one time it bites is vendoring a directory
  whose name you do not control, and convention recovers the predictability for
  free. If a warning channel ever exists, this is a good candidate for one.

Symlinks: resolution already goes through `realpathSync`, so a symlinked
directory module is the same module as its target rather than an alias of it.
That is the current behavior for files and carries over unchanged.

## Phase 1 - remove the name collisions - LANDED

Under the target layout below there were exactly **five** cross-file top-level
name collisions in all of std, plus one that the layout makes moot. No compiler
changes. Both scans now report zero collisions in every std directory, and
`npm test` is 905 pass / 0 fail before and after.

The scan covered top-level `function` / `type` / `trait` / `kind` / `variant` /
`enum` / `union` / `vtable` / `const` / `let` declarations plus kind-prefixed
functions, and separately the contents of `extern "C"` blocks. Methods are
namespaced by their receiver type and cannot collide. The scan was validated
against the two http files by hand-diffing their full decl name sets, which
confirmed it was not missing anything (`readBody` is server-only, `readRest` is
client-only).

1. **`next_pow2_floor8`** - was in both std/collections/deque.yoop and
   std/collections/map.yoop, byte-identical. Deduped NOW rather than at merge
   time, by hoisting it to std/core/numbers.yoop as an exported
   `nextPow2Floor8` (new code, so the camelCase convention rather than the
   legacy snake_case). numbers.yoop is the right permanent home and this needs
   no module merge to pay off. Both containers mask with `& (cap - 1)`, so the
   power-of-two contract is load-bearing and the comment says so.

2. **`libVersion`** - std/db/sqlite_ffi.yoop's raw one renamed to
   `rawLibVersion`, matching the `raw*` prefix every other function in that file
   already uses. The public wrapper in sqlite.yoop keeps `libVersion`; its one
   external caller (examples/playground/sqlite_demo) is untouched.

3. **`readHead`** - renamed per direction: `readRequestHead` in server.yoop,
   `readResponseHead` in client.yoop. Both private with one call site each.
   Better naming than what was there regardless.

4. **`readSome`** - byte-identical in both files. **The plan was wrong here.**
   It said to move one copy into wire.yoop as the shared home; wire.yoop's own
   header documents "It has no dependency on sockets, which is what lets the
   parsers be tested against a byte literal", and `readSome` takes a
   `TcpStream`. That invariant is load-bearing for http_parse_smoke and
   http_url_smoke, so wire.yoop is the wrong home and there is no other
   socket-aware shared file. Renamed per direction instead
   (`readRequestBytes` / `readResponseBytes`, matching item 3), with a comment
   in both files recording that they are twins, why the duplicate is deliberate,
   and that the merge is what collapses them. The dedupe is a 2-line diff at
   merge time; breaking a documented testability invariant to get it 1 phase
   earlier is a bad trade.

5. **`setHeader`** - **the plan's recommendation was over-engineered.** It called
   for a `HasHeaders` trait. The ClientRequest `setHeader` turns out to have
   **zero callers anywhere in the tree**, so a trait would be infrastructure
   built for an unused function. Renamed it to `setRequestHeader` (a comment
   records why it is not just `setHeader`). The Response one in types.yoop keeps
   the short name because it has all 8 call sites, so nothing outside client.yoop
   changed. If a caller ever wants to be generic over "a message with headers",
   the trait is still the right answer then.

Moot under the target layout, noted so a later regrouping does not rediscover
it: **`yoop_now_ns`** is declared in `extern "C"` blocks in both
std/core/cancel_ffi.yoop and std/core/concurrency.yoop. Those two only collide
if all of std/core becomes one module, which the layout below does not do
(cancel_ffi merges with cancel.yoop; concurrency.yoop stays a single-file
module). Two modules declaring the same extern is fine and is already the
situation today. If core ever merges, one of them has to go.

Unrelated pre-existing breakage found while verifying, recorded so it is not
mistaken for fallout: examples/playground/todo_api and examples/playground/
yoopstore both fail to compile with `async function must be awaited` on
`serve` / `serveDefault`. Confirmed pre-existing by stashing std/ and
recompiling. They are stale examples from the async conversion, and they are
under playground/ so e2e does not cover them.

## Target layout for std

Derived from measuring what actually collides and what actually wants to share
privates. The principle: **a module is the smallest grouping that is a coherent
public API surface.** std/core is not one module; it is a directory of many, the
way Odin's `core:` is a collection rather than a package.

Stay as single-file modules, no change at all:

- std/debug.yoop, std/env.yoop, std/fs.yoop, std/log.yoop, std/test.yoop
- std/core/alloc.yoop, bytes.yoop, concurrency.yoop, format.yoop,
  intrinsics.yoop, kinds.yoop, numbers.yoop, range.yoop, strings.yoop,
  traits.yoop, types.yoop, vec.yoop

Become directory modules:

- **std/http/** (7 files) into module `http`. The most valuable merge in the
  tree. wire.yoop is documented INTERNAL and currently has to export
  everything anyway; types / wire / url / parser / server / router / client are
  one layer with one vocabulary. Costs collisions 3, 4, and 5.
- **std/net/** (5 files) into module `net`. Zero collisions. socket_ffi.yoop
  stops being public surface.
- **std/collections/** (3 files: deque, map, set) into module `collections`.
  Costs collision 1, and fixes a duplicated helper in the process.
- **std/db/sqlite/** from std/db/sqlite.yoop plus sqlite_ffi.yoop. Move into a
  `sqlite/` subdirectory rather than making std/db itself the module, so a
  second backend later is a sibling and not a merge. Costs collision 2.
- **std/core/cancel/** from std/core/cancel.yoop plus cancel_ffi.yoop. Zero
  collisions.

The `*_ffi.yoop` files are the clearest signal in the tree that file-as-module
is wrong: each exists solely to be an internal implementation detail, and each
is forced to export its entire surface so its one legitimate consumer can reach
it. Every one of them stops being public API here.

## Phase 2 - compiler support - LANDED except per-file import scope

Directory modules work end to end. `npm test` is 909 pass / 0 fail (905 before,
plus 2 pass fixtures and 2 fail fixtures). No std file has a header yet, so
nothing in the tree behaves differently - the opt-in held.

As built, in the order it was done:

1. **The header.** `module <name>;` is recognized contextually as the very first
   item of a source file (`IDENT IDENT ;`, three-token lookahead) and stamped as
   `PROGRAM.moduleName`. `module` stays an ordinary identifier: verified it still
   works as a struct field name and as a local binding.
2. **Diagnostics had to go per-source-file FIRST**, and this was the one
   prerequisite the plan under-weighted. Rendering resolved a diagnostic through
   `modById.get(error.moduleId)` to get `filePath` + `src`; with siblings sharing
   a moduleId that map keeps only one of them, so every other file's diagnostics
   would have printed a caret into the wrong source. `stampModuleId` became
   `stampErrorOrigin`, which stamps `srcPath` alongside `moduleId`, and the three
   consumers (yoopiler.js x2, lsp/analyze.js) key on `srcPath` first. Confirmed
   working by the cross-file redeclaration test, which points at the right file.
3. **moduleGraph** rewritten around units: `loadOwningUnit` /
   `loadSingleFileUnit` / `loadDirectoryUnit`, with a parse cache so learning a
   file's header does not cost a second parse. `byPath` and the returned
   `modules` list stay per source FILE; `mod.id` is the module id. Cycle
   detection moved to module granularity. Import paths may now name a directory.
4. **typecheck** creates the env on a module's first source file and REUSES it
   for the rest (all 17 tables), gated on a `reused` flag so the coreKinds
   seeding stays once-per-module. Cross-file duplicate declarations report as
   ordinary redeclarations for free.
5. **codegen** emits the module-init symbol per source file
   (`<moduleId>__module_init__<basename>`) when a module spans more than one
   file, keyed off a `moduleSourceFileCount` map built in `codegenProgram`.
   Single-file modules keep the historical unsuffixed name, so their IR is
   unchanged. Reproduced the predicted `invalid redefinition of function
   'm_..._module_init'` first, then fixed it.
6. **`import.unsafe;` stays per source file** - it is read off `mod.ast` at each
   use rather than cached on the shared env, where one file's opt-in would have
   silently covered its siblings.
7. **`*.test.yoop` is excluded** from a module directory's file list, so a test
   module is never absorbed into the module it tests. The basename-keyed autoload
   map needed no change (it resolves by path and reads `mod.id`).

Structural rules enforced, each with a fail fixture or a checked error: a mixed
directory (a file missing the header), a name mismatch between siblings,
importing one source file of a directory module (names the working form),
importing your own module, and a self-import via a sibling file path.

### Pass C intra-module order sensitivity - FIXED

Found after phase 2, fixed before starting phase 3. 910 pass / 0 fail.

**The fix: pass C is now GROUP-MAJOR, STAGE-MINOR.** Source files are grouped by
module id (topo order preserved, since a module's files are contiguous in the
graph), and inside a group each stage runs for every file before the next stage
starts for any of them. Three stages, split at the boundaries the sub-stages
already had:

1. generic pre-pass, struct/variant/enum/union bodies, function sigs, externs
2. trait shape: extends chains, then method signatures (C.1)
3. everything that CONSUMES a trait's method table: kind clauses, impl-block
   validation (C.3), vtable slots (C.3b), module-level decls (C.4)

A single-file module is a group of one, so this is behavior-identical to the old
single loop for every module predating the feature. That property is the reason
to structure it this way.

**A stronger version was tried first and broke.** Hoisting the trait stages into
their own pass over ALL modules ahead of the main loop failed with
`enum "Result__isize__string" has no variant "Ok"` across ten fixtures: trait
signature resolution instantiates generic types, and instantiation SNAPSHOTS the
generic decl, so trait sigs can never precede generic-body resolution
program-wide. Group-major keeps generic bodies first within each module while
still ordering the trait stages ahead of their consumers.

Locked in by examples/pass/dir_module_order/, whose impl file is deliberately
named to sort BEFORE the file declaring the trait, the generic, and the type its
kind governs.

### Probe results for the other stages

The trait case was the one with proof, so the other pass C stages were probed the
same way (build the module twice, renaming files to flip the order):

- **Kinds** (`requires Trait` + `mustCall`, trait in the later-sorting file):
  order-independent, works both ways.
- **Vtables** (`vtable V for T` in the earlier file, trait in the later one):
  fails identically in BOTH orders, and passes in both once the backing trait is
  imported at the use site. That is the existing "vtable's trait must be in
  scope" rule, not an ordering bug.
- **A struct field naming a sibling's generic type**: ORDER-DEPENDENT, and
  **pre-existing** - `type Holder { bag: Bag<int32> }` before `type Bag<T>`
  fails with `type "Bag__int32" has no field "item"` in a SINGLE FILE with no
  modules involved. Same family as the "variant payload must be declared before
  the variant" papercut in sqlite-binding-papercuts.md, and the same thing the
  pass C comment means by "broader use will need a pre-pass before field
  resolution". Not introduced here and deliberately not fixed here.

  Directory modules do make its remedy worse: inside a file you reorder
  declarations, but across siblings you would have to rename a file - exactly the
  pathology just fixed for traits. It does not block phase 3: the only cross-file
  generic field reference in any merge-target directory is
  `inner: Map<K, bool>` in std/collections/set.yoop, and it happens to be safe
  because `map` sorts before `set` (and it sits inside a generic decl, whose
  fields resolve at instantiation). Safe by alphabetical accident is worth
  recording as the reason a pre-pass is still wanted.

### The original finding, kept for the record

Found while probing whether traits/generics/kinds work across files of one
module. They do not, reliably, and the failure is filename-order dependent:

```text
m/impls.yoop    + m/traits.yoop   -> error: 'self' can only be used inside
                                     a trait method body
m/a_traits.yoop + m/b_impls.yoop  -> compiles and runs
```

**Identical code. Only the filenames changed.** A trait declared in one file of
a module and implemented in another works only if the trait's file sorts first.

Cause: pass C is a single MODULE-MAJOR loop (`for (const mod of modules)` around
roughly 920 lines) in which C.1 resolves trait method signatures and C.3
(`validateImplBlock`) consumes them. Across separate modules the topological
order guarantees the trait's module completes pass C first. Files inside one
module have no dependency order, so the loop visits them in basename order and
an impl can be validated against a still-empty `TraitType.methods` map. This is
the intra-module twin of the @derive ordering hazard CLAUDE.md already documents.

**This blocks phase 3 outright, not just theoretically.** `Handler` is declared
in std/http/server.yoop and implemented by `Router` and `NoRoute` in
std/http/router.yoop, and `router` sorts before `server` - so the very first
directory the plan wants to merge hits it.

It also undercuts the point of the feature: "files in a module see each other"
has to be order-independent, or the module is not really one namespace.

Fix direction: hoist the order-sensitive stage(s) out of the module-major loop
into their own pass over all modules, so every module's C.1 completes before any
module's C.3 begins. Files keep their own loop iteration, so `mod` stays in hand
and the per-source-file diagnostics stamping is unaffected. Hoisting only the
extends pre-pass + C.1 is the surgical version; making all of pass C stage-major
is the general version and carries more regression risk. Either way the other
intra-module order sensitivities (C.2 kinds, C.3b vtables, struct-field
resolution vs a sibling's generic) need probing the same way, since the same
argument applies to each.

**This ranks ahead of both phase 3 and per-file import scope.** Per-file import
scope is a tightening of something that works; this is a correctness gap that
makes directory modules silently depend on filename spelling.

### Import locality - LANDED as enforcement, not lexical scope

A module's source files share its DECLARATIONS but not its IMPORTS: using a name
only a sibling imported is an error naming the sibling and the fix. 911 pass /
0 fail. New pass B.1 in src/jsyooptypecheck/importLocality.js.

**Why enforcement rather than true lexical per-file scope.** The lexical version
was scoped first and the audit found a landmine beyond the site count.
`moduleEnv.get(...)` splits into 29 own-scope reads that would become file-keyed
and ~23 cross-module reads that stay module-keyed - but
`resolveTypeAnnotationInModule(annot, modId, ...)` is ALSO called with another
module's id, because an alias RHS resolves "in the alias's home module". Under
per-file scope that has to become "in the alias's home FILE", so `aliasTable`
and every other deferred resolution would need to record file identity. That is
a multi-session refactor of the checker's resolution plumbing with real
wrong-scope failure modes, and half of it is worse than none.

The pass instead leaves resolution module-wide (a sibling's import is still
*resolvable*) and makes USING one an error. It collects, per source file, the
names it references and the names it imports, and reports a reference that is in
the module's `importedNames`, not in this file's own imports, and not bound as a
local anywhere in this file. Only modules with 2+ source files are examined, so
every pre-existing module costs nothing.

Two behavioral differences from true lexical scope, both CONSERVATIVE REJECTIONS
rather than unsoundness, and both arguably wanted anyway:

- a name one file imports and another declares is a redeclaration error;
- two siblings binding the same local name to DIFFERENT modules is an error
  (the phase-2 stopgap already allows the identical-re-import case, which is the
  one that actually matters - every file of a real module imports the same
  handful of namespaces).

The collector is deliberately allowed to be incomplete: a missed name category
is a false NEGATIVE (the wart persists in one spot), which is harmless, while a
false positive would be noise. Guards against the latter: own-imports, and
locally-bound names anywhere in the file.

Verified by probe, beyond the fixture: a LOCAL shadowing a sibling's imported
name is correctly not flagged; a trait reached through `implements` is caught; a
kind used as a binding prefix is caught. One shape worth knowing about was found
while writing it - a direct call stores its callee as a plain STRING, not an
IDENT node, so `someImportedFn(...)` is invisible to an IDENT-only walk.

Fixture: examples/fail/dir_module_import_leak/, asserting both the namespace and
the named-type reference are caught, that each error names the sibling, and that
they are attributed to b.yoop rather than the entry or the sibling.

### The original per-file-scope analysis, kept for the record

The plan called for per-file import scope up front. It is NOT done, and the
reason it is worth its own increment is that measuring the call sites changed the
estimate. `moduleEnv.get(...)` splits into two populations that today are
spelled identically: 29 own-scope reads (`mod.id` x19, `module.id` x5,
`typeContext.currentModId` x5) that must become file-scoped, and ~22
cross-module reads (`imp.fromModuleId` x12 plus the various `type.moduleId`)
that must stay module-keyed. The shape that works is a second map keyed by
absPath whose tables delegate to the module's shared decl tables on a miss, plus
a `currentFileKey` threaded through `typeContext` next to `currentModId` - which
means auditing every consumer of the latter to decide which of the two it wants.
That is a careful pass over the checker, not a mechanical rename.

Consequence of not having it yet, and it is worse than the plan predicted. The
plan said module-wide imports merely "erode locality" (a file can use a sibling's
import). The real blocker showed up immediately when writing the fixture: since
the import tables are shared, two sibling files that both
`import * as vec from "std/core/vec.yoop"` COLLIDED with each other - and
essentially every file of a real module imports the same handful of namespaces,
so directory modules were unusable rather than merely loose.

The stopgap is narrow and deliberate: an **identical** re-import (same local
name, same source module, same exported name) is idempotent instead of a
redeclaration (`sameImportAlready` in imports.js). A different target under the
same local name is still a real conflict, verified by test. So what remains for
per-file scope is one true wart (a file can reference a name a sibling imported),
and it does not block phase 3.

Original plan for this phase, kept for the record:

1. **Directory enumeration and module identity.** src/jsyoopdriver/moduleId.js
   is 10 lines; `moduleIdFor(absPath)` gains a directory-module form. The graph
   walker in src/jsyoopdriver/moduleGraph.js learns to expand a directory import
   into its `.yoop` files (excluding `*.test.yoop`) and to key `byPath` per
   source file while tagging each with its module id. Cycle detection moves to
   module granularity, which is the payoff: intra-module cycles stop existing as
   a category.
2. **Create-or-reuse the environment.** The pass A prologue in
   src/jsyooptypecheck/typecheck.js allocates fresh Maps and calls
   `moduleEnv.set(mod.id, {...})` per file. With several files sharing an id the
   second overwrites the first, so this becomes reuse-if-present. The edit is
   localized to that prologue; all downstream `moduleEnv.get(mod.id)` sites keep
   working unchanged because the returned shape is identical. Cross-file
   redeclarations start erroring for free through the existing checks, though the
   message will not name the sibling file until that is added.
3. **Type identity and mangling need nothing.** src/jsyooptypecheck/types.js
   already defines nominal equality as `name === name && moduleId === moduleId`,
   and mangling is `<moduleId>__<symbol>` write-only (nothing decodes a mangled
   name). Change what moduleId denotes and both follow.
4. **`emitModuleInit` collides.** src/jsyoopcodegen/codegen.js builds
   `${moduleId}__module_init`, so two files in one module emit the same symbol
   and LLVM rejects the redefinition. Emit one merged init per module with a
   deterministic source-file order (sorted basename), which is also the answer
   to "in what order do a module's initializers run".
5. **Per-file pragmas stay per-file.** `allowsUnsafe` is a PROGRAM-node flag
   currently read out of the shared env. Making it module-wide would mean one
   file's `import.unsafe;` silently covers its siblings. Key it by source file.
6. **Import scope.** The one real design fork, called out separately below.
7. **Tail.** `--test` must exclude `*.test.yoop` from the module its directory
   holds; the basename-keyed autoload map in moduleGraph.js needs a look; the
   LSP (33 `moduleEnv` references across 5 files) follows the rekeying.

### The import-scope fork

Decide this before writing code, because it sets the size of phase 2.

**Module-wide imports** (the union of every source file's imports) is nearly
free. src/jsyooptypecheck/imports.js already writes imported names straight into
the same `structTable` and `localSymbols` that declarations live in, so one
shared env works as-is. Downside: a file can call `vec.vecNew` because a sibling
imported vec, which erodes the per-file locality this whole plan is trying to
recover.

**Per-file imports** (Odin's actual semantics) needs the env split in two:
module-shared declaration tables, plus a per-file import table, with lookup
falling through file to module. The invasive part is pulling imported names back
out of the declaration tables, because those tables are consulted directly by
roughly 20 named lookups (`lookupAlias`, `lookupTraitByName`,
`lookupGenericFunc`, and friends) rather than through a chain.
src/jsyooptypecheck/scope.js has a parent-chain shape to copy, but the module
tables are flat Maps today, not scopes.

Recommendation: **per-file imports.** Module-wide imports reintroduce a milder
version of the problem being solved (you can no longer tell what a file depends
on by reading its head), and retrofitting the two-level lookup later means
touching the same 20 sites anyway, just with more code sitting on top of them.
Pay it once, up front.

## Phase 3 - LANDED (four of five directories; collections deliberately skipped)

911 pass / 0 fail. Four directory modules now exist: `std/core/cancel`,
`std/db/sqlite`, `std/net`, `std/http`.

What each merge bought, measured:

- **std/core/cancel** (cancel.yoop + cancel_ffi.yoop -> token.yoop + ffi.yoop).
  All 15 `raw*` wrappers went private; only `RawCancel` stays exported, because
  std/net/socket_ffi legitimately needs the envelope type. `import.unsafe;` being
  a per-FILE pragma is what keeps the split meaningful now that the two files are
  one module: ffi.yoop names `unsafe_ptr`, token.yoop still may not.
- **std/db/sqlite** (sqlite.yoop + sqlite_ffi.yoop -> db.yoop + ffi.yoop). The
  entire 31-name FFI surface went private; nothing outside std/db referenced any
  of it. 41 `ffi.` qualifiers stripped.
- **std/net** (5 files). 22 of socket_ffi's 25 exports plus 2 of socket.yoop's
  went private.
- **std/http** (7 files). 59 intra-module qualifiers stripped
  (`wire.` / `types.` / `parser.` / `url.`), 13 sibling imports deleted, and
  **wire.yoop now exports NOTHING** - its header used to say "nothing here is
  exported by convention" while exporting its whole surface, because that was the
  only way its three consumers could reach it. That is the single clearest win of
  the whole plan.

**std/collections was skipped, and the plan's rationale for including it turned
out to be void.** The plan wanted it merged partly because deque.yoop and map.yoop
duplicated `next_pow2_floor8` - but phase 1 already fixed that by hoisting the
helper to std/core/numbers.yoop. Measuring the rest: every name set.yoop imports
from map.yoop (`Map`, `KeyOps`, `mapNew`, `mapInsert`, ...) is ALSO used outside
std/collections, so merging privatizes nothing. That leaves only churn: 15
external import sites, and a `collections.` prefix replacing the meaningful
`map.` / `deque.` / `set.` distinction. That is the same argument this plan
already used to keep std/core as a directory OF modules rather than one module,
so consistency says leave collections alone. Reverse it only if a genuinely
internal shared helper appears.

**API surface is a design question, not a mechanical one.** A script that
un-exports every name with no in-tree consumer wanted to privatize 60 decls in
std/http, including 39 in types.yoop (`Headers`, `headersNew`, `reasonPhrase`,
the status constructors). Those are the module's public vocabulary; "unused by our
own examples" is a weak signal for a standard library. Only wire.yoop was
privatized wholesale, because its own header already declared it internal. The
same caution applied to std/net (`tcpReadCt` / `tcpWriteAllCt` are documented
public API in CLAUDE.md despite having no in-tree caller). Deciding what std's
public surface SHOULD be is worth doing on purpose, separately.

### Declaration order no longer matters at all - FIXED in two halves

The struct-shell fix (recorded under phase 3b) covered the non-generic half. The
generic half needed a separate fix, because in-place shell filling cannot help
there: instantiating a generic SNAPSHOTS `genericDecl.genericFields` into a fresh
cached type, and substitution builds new field types rather than sharing the
generic's. A snapshot taken before the generic's own body resolved is permanently
field-less, reported as `type "Bag__int32" has no field "item"`.

Fix: pass C stage 1 is split into two sub-stages - every generic TYPE body in the
module group, then everything else. Exactly the "broader use will need a pre-pass
before field resolution" the Phase 7.x comment predicted, and the same shape as
the Phase 7.2 generic-TRAIT pre-pass that already existed for the same reason.
Generic FUNCTION decls deliberately stay in the second sub-stage: their
signatures feed no layout, so moving them would only widen the blast radius.

Now order-independent, all verified: a concrete field naming a later struct, a
variant payload naming a later struct, a concrete field naming a later generic, a
variant payload naming a later generic, a generic naming a LATER generic, and all
of the above across the source files of a directory module in either basename
order. Regression fixture: examples/pass/decl_order_independence.yoop.

### Parse errors blamed the wrong file - FIXED

Not a modules bug, but found twice while writing directory-module fixtures and
worth fixing before phase 3's churn made it common: the parser reports
line/column/length but has no idea which file it was handed, and every caller fell
back to the ENTRY file. A syntax error in an imported module printed the ENTRY's
source with a caret at the imported module's offsets - pointing at unrelated code
in the wrong file. The driver comment said so outright ("we don't know which file
the parser threw from ... assume the entry until we plumb that through").

moduleGraph's `readAndParse` now stamps `srcPath` + `srcText` on the thrown parse
error; the two callers that render a graph-load failure - the driver
(src/yoopiler.js) and the LSP (src/lsp/analyze.js) - prefer them and keep the
entry only as a fallback for a parse that never went through the graph.
`--dump-ast` needs nothing: it parses one file directly, so its `inputFile` was
always the right one. Fixture: examples/fail/parse_error_in_import/.

### Two more codegen bugs, same family as the module-init one

Both are LLVM redefinitions caused by `codegenWithModuleId` running once per
SOURCE FILE while emitting symbols named after the MODULE:

- **String and array literal globals.** `@.str_<moduleId>_<n>` and
  `@.arr_<moduleId>_<n>` share a `strConstCounter` that restarts at 0 for every
  file, so two files of one module both emitted `@.str_net_..._0`. Surfaced the
  moment std/net merged. cancel and sqlite had escaped it only by luck (their ffi
  files happen to contain no string literals).
- **`emittedFromFnShims`** was a per-invocation Set, so two files needing the same
  `fromFn` shim would each emit it. Moved to `programState` (program-wide, which
  is what the symbol's own naming always implied). Latent rather than observed.

Both now go through one `fileTag` helper: `""` for a single-file module, so its IR
stays byte-identical to before the feature, and `__<basename>` otherwise. The
module-init symbol uses the same helper. **If you add a module-scoped generated
symbol in codegen, it needs `fileTag` or a shared counter** - this family has bitten
three times.

### Mechanical hazards worth knowing before the next merge

Both of these were self-inflicted and caught by tests, but they cost time:

- **A qualifier-stripping regex eats import paths and comments.**
  `s/\bwire|parser|types|url\.(\w)/$1/g` turned `"../core/types.yoop"` into
  `"../core/yoop"` in seven files and `std/http/wire.yoop` into `std/http/yoop` in
  six comments. Anchor the substitution away from string literals and comments, or
  fix up afterwards by grepping for `"[^"]*/yoop"` and `[/_]yoop\b`.
- **Normalizing a relative std path to a `std/`-prefixed one changes the rules.**
  The std-imports-must-be-namespaced check keys on `sourcePath.startsWith("std/")`,
  so an example importing `"../../../std/net/uri.yoop"` was exempt and the same
  import written `"std/net"` is not. uri_parse_smoke had to move to the namespace
  form (which is the convention anyway).
- **e2e assertions can pin the old per-file module id.** Two hello_server/http_router
  assertions matched `@server_.*__serveConnection` and `@router_.*__matchPath`;
  after the merge those symbols mangle under `http_*`.

### The original phase 3 recipe

Each of these is one commit, green before and after, revertable on its own:

1. Add the `module <name>;` header to every file in the directory.
2. Delete the now-redundant intra-module imports.
3. Un-export what no longer needs to be public (the `*_ffi` surfaces, wire.yoop's
   internals). This is the step that pays for the plan, and it is worth doing in
   the same commit so the diff shows the win.
4. Rewrite external importers from `"std/http/server.yoop"` to `"std/http"`.

Suggested order, easiest first so the machinery is proven on low-stakes
directories before it touches http:

std/core/cancel (2 files, 0 collisions) -> std/db/sqlite (2 files) ->
std/collections (3 files) -> std/net (5 files) -> std/http (7 files).

## Phase 4 - collect the reward

Only after phase 3 is green. These are the reasons for doing any of this, and
none of them should be attempted earlier:

- Split the oversized files now that splitting is free and does not mean
  inventing a vocabulary module. std/http/types.yoop is the obvious first
  candidate; bootstrap/src/contracts.yoop is the actual motivating case.
- Dissolve `bootstrap/src/contracts.yoop`. Each layer takes back its own
  vocabulary: tokens to the lexer module, AST to the parser module, `Type` /
  `Symbol` / `Program` to the typecheck module. `utils/ast_utils.yoop` and
  `utils/array_utils.yoop` merge back into one utils module.
- Revisit the std `snake_case` to `camelCase` rename as its own track.

## Settled defaults

- **No privileged file name inside a module.** No `index.yoop`, no `mod.yoop`.
  Files are content-named (`server.yoop`, `wire.yoop`) and none is the entry.
  TypeScript's `index.ts` exists because a directory is not a module there and
  something has to be; here the directory already is one, so an index file would
  be a vestige. This is the one place the TS instinct and the module model
  actively disagree, so it is called out rather than assumed.
- **The entry point stays a file path.** `yoopiler_alpha <entry.yoop>` keeps
  working and resolves to the entry file's module, which leaves the 90
  `main.yoop` files under examples/ untouched. Accepting a directory is a
  separate, optional affordance.
- **Directory naming: single lowercase words** for module directories (`http`,
  `net`, `vec`, `sqlite`), `snake_case` for source files inside
  (`socket_ffi.yoop`). Repo convention is `snake_case` for both files and
  folders, and a single lowercase word satisfies that while also being a valid
  identifier, which is what an implicit-namespace import would want later. No
  tension to resolve, just a preference to record.

## Follow-up worth doing in the same pass

- **Cross-file redeclaration diagnostics.** Phase 2 gets cross-file collision
  detection for free but with a message that only names one site. Adding an
  `also declared in <file>` clause needs the env to remember which source file
  contributed each entry. Cheap, and much easier while the context is fresh than
  as an archaeology exercise later.
