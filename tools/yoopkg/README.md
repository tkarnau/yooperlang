# yoopkg

A tiny, deliberately throwaway package manager for yooperlang. Closer to a
sketch than a tool - it copies declared files from a local "registry" into
the consuming project's `yoop_packages/` directory. There's no network, no
semver, no build step.

## Why it can be this small

Yoop imports are file-path based. A `.yoop` file referencing another module
writes `import * as foo from "./relative/path.yoop";`. The compiler already
knows how to follow relative paths and the `std/` prefix. "Installing" a
package, then, is just putting files somewhere the resolver will find them.
That's the whole trick.

The compiler knows no `pkg/` prefix mirroring `std/`, so there is no
`import * as json from "pkg/yooparse/json.yoop";` form - users write the
longer relative path. The tool deliberately does not go there.

## The model

A package is a directory with a `yoop.json` and one or more `.yoop` files.
Example, `examples/playground/yooparse/yoop.json`:

```json
{
  "name": "yooparse",
  "version": "0.1.0",
  "files": ["json.yoop"]
}
```

A consumer is also a directory with a `yoop.json`, but with a `dependencies`
map. Example, `examples/playground/pkgdemo/yoop.json`:

```json
{
  "name": "pkgdemo",
  "version": "0.0.0",
  "dependencies": {
    "yooparse": "0.1.0"
  }
}
```

The "registry" is `tools/yoopkg/registry.json`. It maps package names and
versions to local directories. Override via `YOOPKG_REGISTRY=/path/to/registry.json`.

## Commands

- `yoopkg install` - reads `./yoop.json`, resolves dependencies (transitive,
  topologically), copies each package's declared files to
  `./yoop_packages/<name>/`, and writes `./yoop.lock.json`.
- `yoopkg list` - shows what `yoop.lock.json` thinks is installed.
- `yoopkg registry` - dumps the registry's known packages and versions.

## Try it

From the repo root:

```
cd examples/playground/pkgdemo
node ../../../tools/yoopkg/yoopkg.mjs install
node ../../../src/yoopiler.js main.yoop
./main
```

You should see the same output as the existing `examples/playground/yooparse`
demo, with the difference being that `main.yoop` imports from
`./yoop_packages/yooparse/json.yoop` rather than a sibling `./json.yoop`.

## What is missing on purpose

- No fetch step. The "source" of every registry entry is a local filesystem
  path. To swap in a tarball server or a git fetcher, change the line in
  `yoopkg.mjs` that copies files; everything around it stays.
- No semver. Versions are matched as exact strings.
- No conflict resolution beyond detecting two different versions of the same
  package in a single graph.
- No `publish` / `pack` step. To "publish" a package, add a registry entry
  pointing at its directory.
- No checksums or integrity verification.
- No compiler integration. A package's own internal imports must be
  relative paths inside its own directory; cross-package imports happen
  through `./yoop_packages/<name>/...` from the consumer's side.
