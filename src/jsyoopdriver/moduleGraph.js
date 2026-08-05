import fs from "node:fs";
import path from "node:path";

import { parse } from "../jsyooparser/parser.js";
import { ASTNodeKind } from "../contracts.js";
import { moduleIdFor, directoryModuleIdFor } from "./moduleId.js";
import { lowerRangeExprs } from "./lower_range.js";
import { STD_ROOT } from "../install_root.js";

// Phase 9.C: the std/ import root. Resolution of the installed location (repo
// checkout, npm install, or packaged binary) lives in install_root.js. The
// driver can still override via the options bag, which is what tests that
// point at a stub std/ directory use.
const DEFAULT_STD_ROOT = STD_ROOT;

// Loads the full module graph starting at entryAbsPath.
// Returns { entry: Module, modules: [Module] } where modules is topo-sorted
// leaves-first (so each module's dependencies appear before it).
//
// Each Module is ONE SOURCE FILE:
//   id: string               - the MODULE id (see below - shared by siblings)
//   absPath: string          - canonicalized absolute path of this source file
//   src: string              - this file's contents
//   ast: ProgramNode
//   imports: [IMPORT_DECL]   - decls with resolvedAbsPath/resolvedModuleId set
//   siblings: [Module]       - every source file of this module, INCLUDING this
//                              one (length 1 for a single-file module). Carried
//                              on the record so anything holding a Module can
//                              reach the whole namespace without a second map:
//                              a `Map<moduleId, Module>` keeps only ONE file per
//                              module, which is exactly what made the LSP miss
//                              declarations living in a sibling file.
//
// modules-as-directories: a MODULE is either one source file (no header) or a
// DIRECTORY of source files that each declare `module <name>;`. A source file
// stays the compilation unit either way - it keeps its own ast/src/absPath, so
// diagnostics, DWARF and the LSP are unaffected - while `id` becomes the
// namespace and mangling unit and is SHARED by every file of a directory
// module. Identity is the resolved directory path; the declared name is only a
// label. Cycle detection is at module granularity, which is the payoff: files
// inside one module do not import each other, so intra-module cycles stop
// existing as a category. See plans/modules-as-directories.md.
//
// Options:
//   readFile(absPath) -> string | null
//     Optional override for reading a module's source. Returning null falls
//     back to fs. Used by the LSP to inject unsaved buffers.
export function loadModuleGraph(entryAbsPath, options = {}) {
  const byPath = new Map(); // source-file absPath -> Module
  const unitById = new Map(); // moduleId -> { id, dir, name, files: [Module] }
  const onStack = new Set(); // moduleIds mid-load, for cycle detection
  const order = []; // post-order over source files (leaves first)
  const parsedCache = new Map(); // absPath -> { src, ast }
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
  // std/core/kinds.yoop rides along too: it declares the concurrency core
  // (`task`, `async`, `joined`, `pooled`, `Task`), which used to be reserved
  // words and so was always in scope. Autoloading keeps that true now that
  // they are ordinary kind decls, and gives the typechecker something to
  // assert the required core against. See plans/kinds-in-std.md.
  const autoload = [
    path.resolve(stdRoot, "core", "format.yoop"),
    path.resolve(stdRoot, "core", "strings.yoop"),
    path.resolve(stdRoot, "core", "kinds.yoop"),
    path.resolve(stdRoot, "core", "traits.yoop"),
  ];
  for (const p of autoload) {
    let resolvedAbs;
    try {
      resolvedAbs = fs.realpathSync(p);
    } catch {
      continue; // tests that point stdRoot at a stub directory may not have these
    }
    loadOwningUnit(resolvedAbs);
  }
  loadOwningUnit(entryAbsPath);
  return {
    entry: byPath.get(entryAbsPath),
    modules: order,
    autoloadedStdModuleIds: collectAutoloadIds(byPath, autoload),
  };

  // ─── reading ──────────────────────────────────────────────────────────────

  // Memoized so learning a file's `module` header (which needs a parse) does
  // not cost a second parse when the file is then loaded for real.
  function readAndParse(absPath) {
    const hit = parsedCache.get(absPath);
    if (hit) return hit;
    const overlay = readFile(absPath);
    const src = overlay != null ? overlay : fs.readFileSync(absPath, "utf8");
    let ast;
    try {
      ast = parse(src);
    } catch (err) {
      // Attach WHERE the parse failed. The parser reports line/column/length but
      // has no idea which file it was handed, and every caller fell back to the
      // ENTRY file - so a syntax error in an imported module printed the entry's
      // source with a caret at the imported module's offsets, pointing at
      // unrelated code. Callers prefer `srcPath`/`srcText` when present.
      if (err !== null && typeof err === "object" && err.isParseError) {
        err.srcPath ??= absPath;
        err.srcText ??= src;
      }
      throw err;
    }
    // Rewrite `a..b` into a call to std/core/range.yoop and unshift the import
    // it needs. Runs before the import walk below so the synthesized import is
    // resolved like any other - which is also what pulls range.yoop into the
    // graph, and only for modules that use `..`.
    lowerRangeExprs(ast);
    const parsed = { src, ast };
    parsedCache.set(absPath, parsed);
    return parsed;
  }

  function makeFileRecord(absPath, moduleId) {
    const { src, ast } = readAndParse(absPath);
    return { id: moduleId, absPath, src, ast, imports: [] };
  }

  // The source files a directory module is made of: every `.yoop` directly in
  // the directory, sorted for determinism, minus test files. `*.test.yoop` is
  // excluded because a test module is its own thing (`import.test;`, no main)
  // and must not be absorbed into the module it tests.
  function listModuleSourceFiles(dir) {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isFile() && e.name.endsWith(".yoop") && !e.name.endsWith(".test.yoop"),
      )
      .map((e) => e.name)
      .sort()
      .map((name) => fs.realpathSync(path.join(dir, name)));
  }

  // ─── loading ──────────────────────────────────────────────────────────────

  // Load whatever MODULE owns this source file, and return that unit.
  function loadOwningUnit(absPath) {
    const known = byPath.get(absPath);
    if (known) return reuseUnit(known.id, absPath);
    const { ast } = readAndParse(absPath);
    if (ast.moduleName === null) return loadSingleFileUnit(absPath);
    return loadDirectoryUnit(path.dirname(absPath), absPath);
  }

  // A unit we have already seen. Still has to fail if it is mid-load, which is
  // exactly what an import cycle looks like from here.
  function reuseUnit(id, blameAbsPath) {
    if (onStack.has(id)) {
      throw new Error(`import cycle detected involving ${blameAbsPath}`);
    }
    return unitById.get(id);
  }

  function loadSingleFileUnit(absPath) {
    const id = moduleIdFor(absPath);
    if (unitById.has(id)) return reuseUnit(id, absPath);
    onStack.add(id);
    const mod = makeFileRecord(absPath, id);
    const unit = { id, dir: null, name: null, files: [mod] };
    mod.siblings = unit.files;
    unitById.set(id, unit);
    byPath.set(absPath, mod);
    walkUnitImports(unit);
    onStack.delete(id);
    order.push(mod);
    return unit;
  }

  // `blameAbsPath` is whatever made us look here - a source file with a header,
  // or the importing file for a directory import. Used only in diagnostics.
  function loadDirectoryUnit(dir, blameAbsPath) {
    const files = listModuleSourceFiles(dir);
    if (files.length === 0) {
      throw new Error(
        `import of directory "${dir}" from ${blameAbsPath}: the directory holds no .yoop source files`,
      );
    }

    // The name comes from the first file; every other file must agree. Identity
    // is the DIRECTORY, so a disagreement cannot split one directory into two
    // modules - it is just an error.
    const first = readAndParse(files[0]);
    if (first.ast.moduleName === null) {
      throw new Error(
        `"${dir}" is not a module: ${files[0]} has no \`module <name>;\` header. ` +
          `Add the header to every .yoop file in the directory to make it one, ` +
          `or import a specific source file instead.`,
      );
    }
    const declaredName = first.ast.moduleName;
    const id = directoryModuleIdFor(dir, declaredName);
    if (unitById.has(id)) return reuseUnit(id, blameAbsPath);
    onStack.add(id);

    const records = [];
    for (const f of files) {
      const { ast } = readAndParse(f);
      // A mixed directory is an error: half a module is not a state worth
      // supporting, and this is what catches a file dropped in later by
      // someone who did not notice the directory had opted in.
      if (ast.moduleName === null) {
        throw new Error(
          `${f} is in module directory "${dir}" but has no \`module ${declaredName};\` header - ` +
            `every .yoop file in a module directory must declare it (*.test.yoop is exempt)`,
        );
      }
      if (ast.moduleName !== declaredName) {
        throw new Error(
          `${f} declares \`module ${ast.moduleName};\` but "${dir}" is module "${declaredName}" ` +
            `(from ${path.basename(files[0])}) - every .yoop file in a directory must declare the same name`,
        );
      }
      records.push(makeFileRecord(f, id));
    }

    const unit = { id, dir, name: declaredName, files: records };
    for (const r of records) r.siblings = unit.files;
    unitById.set(id, unit);
    for (const r of records) byPath.set(r.absPath, r);
    walkUnitImports(unit);
    onStack.delete(id);
    for (const r of records) order.push(r);
    return unit;
  }

  // ─── imports ──────────────────────────────────────────────────────────────

  function walkUnitImports(unit) {
    for (const mod of unit.files) {
      for (const decl of mod.ast.body) {
        if (decl.kind !== ASTNodeKind.IMPORT_DECL) break; // imports-first rule
        const target = resolveImportTarget(decl.sourcePath, mod.absPath);

        let childUnit;
        if (target.isDir) {
          if (unit.dir !== null && target.abs === unit.dir) {
            throw new Error(
              `${mod.absPath} imports its own module ("${decl.sourcePath}") - ` +
                `a module's source files already see each other, so drop the import`,
            );
          }
          childUnit = loadDirectoryUnit(target.abs, mod.absPath);
        } else {
          // A source file that belongs to a directory module is not importable
          // on its own: the module is the unit. Say so, and name the form that
          // works, rather than silently pulling in the whole directory.
          const { ast } = readAndParse(target.abs);
          if (ast.moduleName !== null) {
            const asDir = path.dirname(target.abs);
            if (unit.dir !== null && asDir === unit.dir) {
              throw new Error(
                `${mod.absPath} imports "${decl.sourcePath}", a source file of its own module ` +
                  `"${ast.moduleName}" - siblings in a module already see each other, so drop the import`,
              );
            }
            throw new Error(
              `import "${decl.sourcePath}" from ${mod.absPath} names one source file of module ` +
                `"${ast.moduleName}" - import the module itself instead ` +
                `(drop the file name and the .yoop extension)`,
            );
          }
          childUnit = loadOwningUnit(target.abs);
        }

        decl.resolvedAbsPath = target.abs;
        decl.resolvedModuleId = childUnit.id;
        mod.imports.push(decl);
      }
    }
  }

  // Phase 9.C: `std/...` paths resolve against the std root, not relative
  // to the importing file. Everything else must be `./...`, `../...`, or
  // absolute - preserves the SPEC §1 relative-only contract for non-std
  // imports. A path may name a `.yoop` source file or, for a directory
  // module, the directory.
  function resolveImportTarget(sourcePath, fromAbsPath) {
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
    // A path carrying a non-.yoop file extension can never name a module
    // directory, so reject it up front with the extension message. Without this
    // a typo'd `"./m.txt"` would fail as "not found", which points at the wrong
    // problem. `.` / `..` / `.hidden` are not extensions.
    const lastSegment = sourcePath
      .replace(/[/\\]+$/, "")
      .replace(/^.*[/\\]/, "");
    const hasFileExtension =
      lastSegment !== "." && lastSegment !== ".." && /.\./.test(lastSegment);
    if (hasFileExtension && !sourcePath.endsWith(".yoop")) {
      throw new Error(`import path "${sourcePath}" must end in .yoop`);
    }

    const resolved = isStdImport
      ? path.resolve(stdRoot, sourcePath.slice("std/".length))
      : path.resolve(path.dirname(fromAbsPath), sourcePath);

    let abs;
    try {
      abs = fs.realpathSync(resolved);
    } catch {
      throw new Error(
        `cannot resolve import "${sourcePath}" from ${fromAbsPath}: not found`,
      );
    }
    const isDir = fs.statSync(abs).isDirectory();
    if (!isDir && !sourcePath.endsWith(".yoop")) {
      throw new Error(
        `import path "${sourcePath}" must end in .yoop (or name a module directory)`,
      );
    }
    return { abs, isDir };
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
