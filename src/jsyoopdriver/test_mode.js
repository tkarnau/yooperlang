// Test mode - discovery and entry-module synthesis.
//
// A test file is an ordinary module that declares `import.test;` and whose
// suites are functions carrying an `enumerable` function kind (`suite`, from
// std/test.yoop). Nothing here knows what a test IS: it globs the files,
// collects the kind-prefixed function names, and writes a synthetic entry
// module whose `main` hands the table to std. All policy lives in
// std/test.yoop.
//
// The generated entry goes through the ordinary pipeline. There is no second
// codegen path and no test-mode typechecker - the module graph accepts it via
// the `readFile` overlay that already exists for the LSP's unsaved buffers.
//
// See plans/testing-via-kinds.md.

import fs from "node:fs";
import path from "node:path";

import { parse } from "../jsyooparser/parser.js";
import { ASTNodeKind, ASTNode } from "../contracts.js";

// The table name `--test` asks for. A kind declares which table it feeds via
// `enumerable as "<table>"`, so a future `--bench` mode asking for "benches"
// never collides with this one.
export const SUITE_TABLE = "suites";

const TEST_FILE_SUFFIX = ".test.yoop";

// Directories never walked looking for test files.
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target"]);

// Basename of the synthetic entry. Lives in the search root so relative
// imports would resolve, though the generated source uses absolute paths.
// The name is deliberately not a legal thing to want: a real file called this
// would be shadowed, which is why it carries the marker prefix.
const ENTRY_BASENAME = "yoopiler_generated_test_entry.yoop";

// Recursively collect `**/*.test.yoop` under `rootDir`, sorted so a run is
// reproducible (suite order is the report order).
export function discoverTestFiles(rootDir) {
  const found = [];
  walk(rootDir);
  found.sort();
  return found;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory is not a test failure
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile() && e.name.endsWith(TEST_FILE_SUFFIX)) {
        found.push(fs.realpathSync(full));
      }
    }
  }
}

// True when `absPath` parses as a module declaring `import.test;`. Used for the
// single-file shorthand (`yoopiler foo.test.yoop` with no --test), which is the
// concrete payoff of the in-file flag: a test module has no `main`, so without
// the flag compiling one directly is just an error.
export function isTestModuleFile(absPath) {
  try {
    return parse(fs.readFileSync(absPath, "utf8")).isTestModule === true;
  } catch {
    return false; // let the ordinary pipeline report the parse error
  }
}

// Parse each file and collect its kind-prefixed top-level functions.
//
// Collection is SYNTACTIC on purpose. Resolving `enumerable as` requires
// typecheck, and typecheck needs the entry module, which needs the collected
// names - so the cycle is broken by collecting every kind-prefixed top-level
// function here and letting typecheck reject any whose kind is not enumerable
// into the table we asked for. That is safe because a kind-prefixed top-level
// FUNCTION has no other meaning in the grammar (`task` is a keyword, not an
// ident prefix), so there is nothing else to confuse a suite with.
//
// Returns { modules: [{ absPath, relPath, ast, suites: [name] }], errors: [] }.
export function collectSuiteModules(absPaths, rootDir) {
  const modules = [];
  const errors = [];
  for (const absPath of absPaths) {
    const relPath = path.relative(rootDir, absPath) || path.basename(absPath);
    let ast;
    try {
      ast = parse(fs.readFileSync(absPath, "utf8"));
    } catch (err) {
      errors.push({ absPath, err });
      continue;
    }
    if (!ast.isTestModule) {
      errors.push({
        absPath,
        message:
          `${relPath} is named *${TEST_FILE_SUFFIX} but does not declare 'import.test;'.\n` +
          `  Add it as the first line, or rename the file if it is not a test module.`,
      });
      continue;
    }
    const suites = [];
    for (const decl of ast.body) {
      const inner = decl.kind === ASTNodeKind.EXPORT_DECL ? decl.decl : decl;
      if (inner.kind !== ASTNodeKind.FUNCTION_DECL) continue;
      if (!inner.kindPrefix) continue;
      suites.push(inner.name);
    }
    modules.push({ absPath, relPath, ast, suites });
  }
  return { modules, errors };
}

// Generate the entry module source.
//
// Suites are imported by name with a generated alias rather than through a
// namespace, for two reasons: two test files may each define a `setup`, and a
// namespaced function reference in VALUE position (`m0.addsNumbers`) currently
// crashes codegen with `llvmType: unhandled yooper type kind "func"` - the
// Phase 10.X.2 fn-as-value lift covered bare names only.
export function generateEntrySource(suiteModules) {
  const lines = [];
  const aliases = [];
  const labels = [];
  lines.push(`// Generated by yoopiler --test. Not written to disk.`);
  lines.push(`import * as harness from "std/test.yoop";`);
  let n = 0;
  for (const mod of suiteModules) {
    for (const name of mod.suites) {
      const alias = `suite${n}`;
      n += 1;
      lines.push(`import { ${name} as ${alias} } from "${mod.absPath}";`);
      aliases.push(alias);
      labels.push(`${mod.relPath}:${name}`);
    }
  }
  lines.push(``);
  lines.push(`function main(): int {`);
  lines.push(`  const fns: (() => void)[] = [${aliases.join(", ")}];`);
  lines.push(
    `  const names: string[] = [${labels.map((l) => JSON.stringify(l)).join(", ")}];`,
  );
  lines.push(`  return harness.runAll(fns, names);`);
  lines.push(`}`);
  lines.push(``);
  return lines.join("\n");
}

// Absolute path the synthetic entry is registered under.
export function entryPathFor(rootDir) {
  return path.join(rootDir, ENTRY_BASENAME);
}

// Suite functions must be importable by the generated entry, but making every
// test author write `export suite function` is pure ceremony in a file that
// exists only to hold tests. So the wrapper is added here instead, after the
// graph is loaded and before typecheck. Idempotent: an author who DID write
// `export` already has the wrapper.
export function exportSuiteFunctions(modules, testModuleIds) {
  for (const mod of modules) {
    if (!testModuleIds.has(mod.id)) continue;
    mod.ast.body = mod.ast.body.map((decl) => {
      if (decl.kind !== ASTNodeKind.FUNCTION_DECL) return decl;
      if (!decl.kindPrefix) return decl;
      const wrapper = new ASTNode(ASTNodeKind.EXPORT_DECL, decl.sourceLoc);
      wrapper.decl = decl;
      return wrapper;
    });
  }
}

// After typecheck, confirm every function the syntactic pass collected really
// does carry a kind enumerating into `SUITE_TABLE`. This is where a kind that
// is not enumerable at all, or that feeds a different table, gets reported -
// with the kind's own table name, so the fix is obvious.
export function verifyCollectedSuites(modules, testModuleIds) {
  const problems = [];
  for (const mod of modules) {
    if (!testModuleIds.has(mod.id)) continue;
    for (const decl of mod.ast.body) {
      const inner = decl.kind === ASTNodeKind.EXPORT_DECL ? decl.decl : decl;
      if (inner.kind !== ASTNodeKind.FUNCTION_DECL) continue;
      if (!inner.kindPrefix) continue;
      // A kind that failed to resolve, or a signature mismatch, already
      // produced a typecheck error - do not pile on.
      if (!inner.resolvedKindType) continue;
      if (inner.enumerableAs === SUITE_TABLE) continue;
      problems.push({
        sourceLoc: inner.kindPrefix.sourceLoc ?? inner.sourceLoc,
        moduleId: mod.id,
        message:
          `function "${inner.name}" carries kind '${inner.kindPrefix.name}', which enumerates as ` +
          `"${inner.enumerableAs}" - \`--test\` collects "${SUITE_TABLE}"`,
      });
    }
  }
  return problems;
}
