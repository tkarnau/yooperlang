# Plan - Package system using `@`-attributes

## Context

The user has read [exploration-package-system.md](/Users/tom/dev/personal/yooperlang/plans/exploration-package-system.md) and wants the language to ship a package system that keeps the "program defines itself" principle and uses `@`-attribute syntax (the same surface Phase 11 introduces for `@precompile`) so that the manifest is itself yoop source. No env vars, no JSON, no TOML.

The user's sketch is at [package-import-system-idea.md](/Users/tom/dev/personal/yooperlang/plans/package-import-system-idea.md). This plan turns that sketch into something implementable on top of the existing Phase 11.A `@`-attribute infrastructure.

### Decisions confirmed with the user

1. **Fetch is a separate command.** `yoopiler fetch` downloads + extracts packages. A regular `yoopiler main.yoop` build errors clearly on cache miss and points at the fetch command. Compile and network IO are kept separate so a normal build never reaches out to the internet.
2. **`@yoopackager` lives only in entry-point modules.** For v1 that means the top-level program's entry file. (A future revision may let packages themselves carry an `@yoopackager` so they can have their own dependencies; out of scope here.)
3. **`packages.yoop` can only contain `@yoopackage(...)` directives.** No functions, no types, no imports, no `let`/`const`. The manifest is a static declaration sublanguage that happens to be expressed in yoop's `@`-attribute grammar. Future work may add `@if(platform == "darwin")` style conditionals; design accommodates without implementing.
4. **No registry concept - URLs only.** Each `@yoopackage` carries the full URL it fetches from. No central registry server, no shared registry URL declared anywhere. Deno-shaped.
5. **v1 supports leaf packages only.** A fetched package contains yoop source but cannot declare its own `@yoopackager`. This collapses `preparePackages` from "recursive manifest walker" to "one-level scan," which is much smaller. Transitive dependencies land in v2.

### What's already in place (so we know what we're building on)

- Phase 11.A landed `@`-attribute lexing/parsing/registry. Files: [src/jsyooplexer/lexer.js](/Users/tom/dev/personal/yooperlang/src/jsyooplexer/lexer.js), [src/jsyooparser/parser.js](/Users/tom/dev/personal/yooperlang/src/jsyooparser/parser.js), [src/jsyoopattributes/registry.js](/Users/tom/dev/personal/yooperlang/src/jsyoopattributes/registry.js), [src/jsyoopattributes/pass.js](/Users/tom/dev/personal/yooperlang/src/jsyoopattributes/pass.js).
- `@`-attribute grammar is `@name(args?) target`. Args MUST be in parens (the user's sketch without parens is not currently legal). Target is `;`, `{ block }`, or a `let`/`const` decl.
- Module graph walker at [src/jsyoopdriver/moduleGraph.js](/Users/tom/dev/personal/yooperlang/src/jsyoopdriver/moduleGraph.js) has a clean `std/*` carve-out at lines 91-104 that `yoopkg/...` slots in next to.
- The parser's imports-first rule sets `seenNonImport = true` on the first `@` token at top-level ([parser.js:690-694](/Users/tom/dev/personal/yooperlang/src/jsyooparser/parser.js#L690-L694)). The module graph walker breaks on the first non-IMPORT_DECL body item ([moduleGraph.js:82](/Users/tom/dev/personal/yooperlang/src/jsyoopdriver/moduleGraph.js#L82)). Both need a small carve-out for "manifest attributes" so `@yoopackager` can sit at the very top of the entry file alongside imports.

## Surface - what the user types

### Entry file

```yoop
@yoopackager("./packages.yoop");

import { Router } from "yoopkg/yooperReactSSR";
import { parse_json } from "yoopkg/yooperJSON";

function main(): int32 {
    // ...
}
```

One `@yoopackager(...)` allowed per entry file. The string arg is a relative path to the manifest. A program with no third-party deps simply omits the directive - zero-config remains the default.

### packages.yoop

```yoop
@yoopackage("yooperReactSSR", "https://yoopkg.example/dl/yooperReactSSR-1.5.3.tar.gz");
@yoopackage("yooperJSON",     "https://yoopkg.example/dl/yooperJSON-0.2.1.tar.gz");

// Optional hash pin for supply-chain integrity. Compiler stamps this on
// first fetch and verifies it on every subsequent build:
@yoopackage("yooperWidgets", "https://github.com/foo/widgets/raw/v0.4.1.tar.gz", "sha256:a1b2c3...");
```

Each `@yoopackage(...)` has two required positional args - the local name used in imports, and the full URL of the source tarball - plus an optional third positional arg, a content hash. No other top-level forms are legal in this file; `preparePackages` rejects anything else with a clear diagnostic pointing at packages.yoop.

### Import sites in any other module

```yoop
// Import the package's main entry file:
import { Router } from "yoopkg/yooperReactSSR";

// Import a specific sub-file inside the package:
import { fast_serialize } from "yoopkg/yooperJSON/internal/codec.yoop";
```

`yoopkg/<name>` resolves to the package's root `main.yoop` by convention. `yoopkg/<name>/<sub/path.yoop>` resolves to a file inside the package. The `.yoop` suffix is required for sub-path imports (matching existing `std/*` rules).

## Compiler pipeline changes

The new top-level flow:

```
yoopiler main.yoop
  -> parse(entry)                         existing
  -> preparePackages(entryAST)            NEW
       - extract @yoopackager, parse manifest, build packageMap
       - error on cache miss with "run `yoopiler fetch`"
  -> loadModuleGraph(entry, { packageMap, stdRoot })   existing + new option
  -> typecheck / comptime / attribute pass / codegen / clang   existing
```

```
yoopiler fetch
  -> parse(entry) + preparePackages(entryAST) without populating cache
  -> for each @yoopackage URL: download, verify hash if pinned, extract
     into ~/.yoopiler/pkg/<name>/<urlhash>/, write hash sidecar
  -> if hash was omitted from packages.yoop, print the computed hash
     and a one-line `@yoopackage(...)` suggestion the user can paste to pin
  -> exit; no compilation
```

The cache layout:

```
~/.yoopiler/pkg/
    yooperReactSSR/
        <sha256-of-url>/
            main.yoop
            ...source files...
            .yoophash             # sha256 of the extracted tree
    yooperJSON/
        <sha256-of-url>/
            ...
```

Keying on URL hash means switching to a new version (different URL) creates a fresh cache entry; old cached versions stick around until the user gc's them (out of scope for v1).

### Three new attribute registry entries

In [src/jsyoopattributes/registry.js](/Users/tom/dev/personal/yooperlang/src/jsyoopattributes/registry.js), after the `@precompile` entry:

- `@yoopackager` - `parsePhase` validates one string arg (the manifest path). Sets a `manifestAttribute: true` capability flag so parser + module graph treat it as transparent to imports-first ordering. `comptimePhase` and `codegenPhase` are no-ops (the driver consumes it pre-graph).
- `@yoopackage` - `parsePhase` validates two-or-three string args (name, URL, optional hash). Allowed only in files reached via `@yoopackager` (rejected elsewhere with a diagnostic). No other handlers needed - the manifest scan is its only consumer.
- The pass-through skip in [pass.js](/Users/tom/dev/personal/yooperlang/src/jsyoopattributes/pass.js) ignores any attribute whose name is on the manifest-attribute list, so they don't trigger spurious "unhandled attribute" errors at the comptime/attribute pass.

### Imports-first carve-out (the gotcha)

Two small changes ensure `@yoopackager` sitting at the top of the entry file doesn't break import collection:

- [parser.js:690-694](/Users/tom/dev/personal/yooperlang/src/jsyooparser/parser.js#L690-L694): when the `@` token is one of the manifest-attribute names, do NOT set `seenNonImport = true`. Imports after `@yoopackager(...)` continue to parse normally.
- [moduleGraph.js:81-83](/Users/tom/dev/personal/yooperlang/src/jsyoopdriver/moduleGraph.js#L81-L83): replace `if (decl.kind !== ASTNodeKind.IMPORT_DECL) break;` with logic that skips ATTRIBUTE nodes whose name is on the manifest-attribute list, but still breaks on any other non-IMPORT_DECL body item.

The manifest-attribute name list (initially just `yoopackager`) is exported from the registry module so parser and driver consult the same source of truth.

### New `yoopkg/...` resolution branch

In [moduleGraph.js](/Users/tom/dev/personal/yooperlang/src/jsyoopdriver/moduleGraph.js), the resolver at lines 84-104 grows a third branch:

```
isYoopkgImport = sourcePath.startsWith("yoopkg/")
```

Resolution rule:

- Split into `["yoopkg", name, ...rest]`.
- Look up `name` in `options.packageMap`. If absent, error: `unknown package "<name>" - declare it in packages.yoop and run \`yoopiler fetch\``.
- If `rest` is empty, resolve to `<cacheRoot>/main.yoop`.
- Otherwise, resolve to `<cacheRoot>/<rest.join("/")>`, requiring a `.yoop` suffix at the very end (consistent with existing rules).
- Cycle detection and topo-sort continue to work unchanged - the resolved absolute path slots into the existing `onStack` Set just like any other file.

The `.yoop`-suffix check at [moduleGraph.js:84-86](/Users/tom/dev/personal/yooperlang/src/jsyoopdriver/moduleGraph.js#L84-L86) needs to gate behind "not the bare `yoopkg/<name>` form" since `yoopkg/yooperReactSSR` itself doesn't end in `.yoop`.

## Critical files to modify

- [src/jsyoopattributes/registry.js](/Users/tom/dev/personal/yooperlang/src/jsyoopattributes/registry.js) - register `@yoopackager` + `@yoopackage`; export a `manifestAttributeNames` set.
- [src/jsyoopattributes/pass.js](/Users/tom/dev/personal/yooperlang/src/jsyoopattributes/pass.js) - skip manifest attributes at the attribute pass.
- [src/jsyooparser/parser.js](/Users/tom/dev/personal/yooperlang/src/jsyooparser/parser.js) (~line 690) - imports-first carve-out for manifest attributes.
- [src/jsyoopdriver/moduleGraph.js](/Users/tom/dev/personal/yooperlang/src/jsyoopdriver/moduleGraph.js) - skip manifest attributes in body loop; new `yoopkg/...` resolution branch; accept `packageMap` option.
- **New: [src/jsyoopdriver/preparePackages.js](/Users/tom/dev/personal/yooperlang/src/jsyoopdriver/preparePackages.js)** - parses entry standalone, extracts `@yoopackager`, parses manifest, validates that every top-level form is `@yoopackage` (with helpful "manifests only contain `@yoopackage` directives" diagnostic otherwise), checks cache presence per package, builds `packageMap`. Errors on cache miss with `yoopiler fetch` hint.
- **New: [src/jsyoopdriver/fetchPackages.js](/Users/tom/dev/personal/yooperlang/src/jsyoopdriver/fetchPackages.js)** - the side that *does* the downloading. Used by the `yoopiler fetch` subcommand. Streams the URL to a temp tarball, computes sha256, verifies against pinned hash if any, extracts into `~/.yoopiler/pkg/<name>/<urlhash>/`, writes a `.yoophash` sidecar. Prints unpinned-hash suggestions to stdout.
- [src/yoopiler.js](/Users/tom/dev/personal/yooperlang/src/yoopiler.js) - call `preparePackages(entryAbs)` before `loadModuleGraph`; pass the resulting `packageMap` through. Add a `yoopiler fetch` subcommand dispatch at argv parsing time.
- [src/lsp/analyze.js](/Users/tom/dev/personal/yooperlang/src/lsp/analyze.js) - tolerate `@yoopackager` in the entry. v1 acceptable behavior: call `preparePackages` with a cache-only flag (no fetching) and surface cache-miss as a diagnostic on the `@yoopackage` line rather than an LSP-wide failure.

## Reusing what's already there

- The attribute registry's `parsePhase` + Levenshtein "did you mean" diagnostics ([registry.js](/Users/tom/dev/personal/yooperlang/src/jsyoopattributes/registry.js)) handle typos in attribute names for free.
- The existing `parse()` function ([parser.js:79](/Users/tom/dev/personal/yooperlang/src/jsyooparser/parser.js#L79)) is used unchanged to parse `packages.yoop` - it's just a yoop file containing only `@yoopackage` decls.
- `posToSourceLocation` from [src/helpers.js](/Users/tom/dev/personal/yooperlang/src/helpers.js) gives `packages.yoop` errors the same line-and-column treatment as regular yoop diagnostics.
- The cycle detection / topo sort in `moduleGraph.js` works unchanged once package paths are resolved to absolute cache paths.

## Verification

- **Unit tests:**
  - `src/jsyoopattributes/registry.test.js` - new cases for `@yoopackager` shape validation and `@yoopackage` arg validation.
  - `src/jsyoopdriver/preparePackages.test.js` (new) - manifest parsing, cache-miss diagnostic, manifest-only-allows-`@yoopackage` enforcement, packageMap construction.
  - `src/jsyoopdriver/moduleGraph.test.js` (new or extended) - `yoopkg/...` resolution branch, sub-path resolution, manifest-attribute transparency in the imports-first walk.

- **E2E fixture** in [src/e2e.test.js](/Users/tom/dev/personal/yooperlang/src/e2e.test.js):
  - `examples/pass/package_basic/` with an entry file + packages.yoop + a stub "package" pre-placed in a test cache directory (sidestep network IO in tests by overriding the cache root via test option). Verifies end-to-end lex -> parse -> preparePackages -> loadModuleGraph -> typecheck -> codegen -> run.
  - `examples/fail/package_cache_miss/` - same setup but with the package absent from cache; verifies the cache-miss error message.
  - `examples/fail/manifest_has_function/` - packages.yoop containing a `function` decl; verifies the rejection diagnostic.

- **Manual verification:**
  - `yoopiler fetch` against a real tarball URL once a test package is hosted somewhere.
  - Hash mismatch path: manually edit a cached file, rebuild, verify integrity error.
  - LSP: open a project with `@yoopackager` and confirm no spurious diagnostics on the entry file.

## Open / deferred items

- **Transitive deps.** A v2 phase. The shape would be `preparePackages` walking recursively into each fetched package's own packages.yoop, with the entry-level pins winning on name collisions. Out of scope here.
- **Platform-conditional packages.** User mentioned wanting future `@if(platform == "...")` style conditionals in packages.yoop. The current design accommodates this naturally - manifest parsing is just AST traversal, and adding a conditional attribute is a registry entry. Don't build it yet.
- **Cache GC.** Old cached versions accumulate forever. A future `yoopiler fetch --gc` or similar can prune unreferenced entries. Out of scope for v1.
- **Offline / proxy.** `~/.yoopiler/pkg/` is the only cache location. No env var override. If corporate-proxy users need a different location later, add a CLI flag (`yoopiler fetch --cache=/path`); CLI flags are per-invocation parameters, not "external config" in the sense the user wants to avoid.
- **Versioning conventions.** The compiler treats URLs as opaque identifiers. Package authors choose their own versioning scheme by URL design (path component, query string, tag in git URL, whatever). The compiler doesn't pick versions, doesn't solve semver, doesn't know what 1.5.3 means.
- **Package self-imports vs absolute imports.** Inside a fetched package, does `import "./util.yoop"` work the same as in any other module? Yes - by the time we're resolving imports inside a package, that package is just another set of yoop files at known absolute paths; relative imports resolve against the importer's directory like always.
- **What happens if a fetch URL 404s?** Hard error, abort the fetch. No fallback resolution.
