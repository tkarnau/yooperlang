import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "../jsyooparser/parser.js";
import { ASTNodeKind } from "../contracts.js";
import { moduleIdFor } from "./moduleId.js";

// Phase 9.C: the std/ import root. By default this is the std/ directory at
// the repo root - i.e. two levels up from this file (src/jsyoopdriver/). The
// driver can override via the options bag (useful for tests or for an
// alternate yoopiler distribution layout).
const DEFAULT_STD_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "std",
);

// Loads the full module graph starting at entryAbsPath.
// Returns { entry: Module, modules: [Module] } where modules is topo-sorted
// leaves-first (so each module's dependencies appear before it).
//
// Each Module:
//   id: string               - stable module identifier
//   absPath: string          - canonicalized absolute path
//   src: string              - file contents
//   ast: ProgramNode
//   imports: [IMPORT_DECL]   - decls with resolvedAbsPath/resolvedModuleId set
//
// Options:
//   readFile(absPath) -> string | null
//     Optional override for reading a module's source. Returning null falls
//     back to fs. Used by the LSP to inject unsaved buffers.
export function loadModuleGraph(entryAbsPath, options = {}) {
  const byPath = new Map(); // absPath -> Module
  const onStack = new Set(); // for cycle detection
  const order = []; // post-order (leaves first)
  const readFile = options.readFile ?? (() => null);
  const stdRoot = options.stdRoot ?? DEFAULT_STD_ROOT;

  // Always pull std/core/format.yoop and std/core/strings.yoop into the
  // graph so codegen can lower interpolated template literals to
  // `string_concat_all([..., int_to_string(x), ...])` without requiring
  // user code to import them explicitly. std/core/traits.yoop rides along
  // so @derive(display) can synthesize `import { Display }` bindings for
  // deriving modules. Loading is idempotent - if the entry transitively
  // imports any of these, this is a no-op.
  //
  // Autoloads walk BEFORE the entry so they precede user modules in the
  // topo order. This is load-bearing for @derive: a deriving module's
  // pass C validates its grafted to_string against Display's method table,
  // which is only filled once the traits module's own pass C has run.
  const autoload = [
    path.resolve(stdRoot, "core", "format.yoop"),
    path.resolve(stdRoot, "core", "strings.yoop"),
    path.resolve(stdRoot, "core", "traits.yoop"),
  ];
  for (const p of autoload) {
    let resolvedAbs;
    try {
      resolvedAbs = fs.realpathSync(p);
    } catch {
      continue; // tests that point stdRoot at a stub directory may not have these
    }
    loadOne(resolvedAbs);
  }
  loadOne(entryAbsPath);
  return {
    entry: byPath.get(entryAbsPath),
    modules: order,
    autoloadedStdModuleIds: collectAutoloadIds(byPath, autoload),
  };

  function loadOne(absPath) {
    if (onStack.has(absPath)) {
      throw new Error(`import cycle detected involving ${absPath}`);
    }
    if (byPath.has(absPath)) return byPath.get(absPath);
    onStack.add(absPath);

    const overlay = readFile(absPath);
    const src = overlay != null ? overlay : fs.readFileSync(absPath, "utf8");
    const ast = parse(src);
    const id = moduleIdFor(absPath);
    const mod = { id, absPath, src, ast, imports: [] };
    byPath.set(absPath, mod);

    for (const decl of ast.body) {
      if (decl.kind !== ASTNodeKind.IMPORT_DECL) break; // imports-first rule
      const sourcePath = decl.sourcePath;
      if (!sourcePath.endsWith(".yoop")) {
        throw new Error(`import path "${sourcePath}" must end in .yoop`);
      }
      // Phase 9.C: `std/...` paths resolve against the std root, not relative
      // to the importing file. Everything else must be `./...`, `../...`, or
      // absolute - preserves the SPEC §1 relative-only contract for non-std
      // imports.
      const isStdImport = sourcePath.startsWith("std/");
      if (
        !isStdImport &&
        !sourcePath.startsWith("./") &&
        !sourcePath.startsWith("../") &&
        !path.isAbsolute(sourcePath)
      ) {
        throw new Error(
          `import path "${sourcePath}" must be relative (./...), absolute, or start with std/`,
        );
      }
      const resolved = isStdImport
        ? path.resolve(stdRoot, sourcePath.slice("std/".length))
        : path.resolve(path.dirname(absPath), sourcePath);
      let resolvedAbs;
      try {
        resolvedAbs = fs.realpathSync(resolved);
      } catch {
        throw new Error(
          `cannot resolve import "${sourcePath}" from ${absPath}: file not found`,
        );
      }
      const child = loadOne(resolvedAbs);
      decl.resolvedAbsPath = resolvedAbs;
      decl.resolvedModuleId = child.id;
      mod.imports.push(decl);
    }

    onStack.delete(absPath);
    order.push(mod);
    return mod;
  }
}

function collectAutoloadIds(byPath, autoloadPaths) {
  const out = {};
  for (const p of autoloadPaths) {
    let resolvedAbs;
    try {
      resolvedAbs = fs.realpathSync(p);
    } catch {
      continue;
    }
    const mod = byPath.get(resolvedAbs);
    if (!mod) continue;
    const base = path.basename(resolvedAbs, ".yoop");
    out[base] = mod.id;
  }
  return out;
}
