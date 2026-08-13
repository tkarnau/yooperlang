#!/usr/bin/env node
import { parseArgs } from "util";
import fs from "fs";
import { execFileSync } from "child_process";
import os from "os";
import path from "path";

import { loadModuleGraph } from "./jsyoopdriver/moduleGraph.js";
import { typecheckProgram } from "./jsyooptypecheck/typecheck.js";
import { codegenProgram } from "./jsyoopcodegen/codegen.js";
import { runAttributePass } from "./jsyoopattributes/pass.js";
import { knownAttributeNames } from "./jsyoopattributes/registry.js";
import { runComptimePass } from "./jsyoopinterp/comptimePass.js";
import {
  RUNTIME_C,
  RUNTIME_SOURCES,
  glueSourcesForLinkFlags,
  runtimeLinkFlags,
} from "./runtimeBuild.js";
import { formatDiagnostic } from "./helpers.js";
import { dumpAst, dumpAstJson } from "./dumpAst.js";
import { dumpTokens } from "./dumpTokens.js";
import { checkInstallRoots, STD_ROOT } from "./install_root.js";
import {
  clangEnv,
  librarySearchArgs,
  lowerLinkFlag,
  msvcLinkerDir,
  resolveClang,
  toolchainHint,
  windowsClangArgs,
} from "./toolchain.js";
import {
  collectSuiteModules,
  discoverTestFiles,
  entryPathFor,
  exportSuiteFunctions,
  generateEntrySource,
  isTestModuleFile,
  verifyCollectedSuites,
} from "./jsyoopdriver/test_mode.js";


// Run clang, turning its two failure modes into something readable: a missing
// binary becomes an install hint, and a compile/link failure exits with
// clang's own status instead of a node stack trace over already-printed
// diagnostics.
function runClang(clang, clangArgs) {
  try {
    execFileSync(clang, clangArgs, { stdio: "inherit", env: clangEnv() });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      console.error(
        `clang not found (tried "${clang}").\n` +
          `  yoopiler shells out to clang to assemble and link.\n` +
          `  install LLVM/clang and put it on PATH, or set YOOP_CLANG to its full path.`,
      );
      process.exit(1);
    }
    // A link failure on Windows is usually a missing MSVC toolchain rather
    // than anything wrong with the program, and clang's own message for it
    // ("unable to execute command") does not say so. Name the real cause.
    const hint = toolchainHint();
    if (hint) console.error(`\n${hint}`);
    if (typeof err?.status === "number") process.exit(err.status);
    throw err;
  }
}

// Is this source file part of the shipped standard library? Compared against
// the resolved STD_ROOT rather than by looking for "std" in the path, so a
// user directory that happens to be named std is not silenced.
function isStdPath(absPath) {
  if (!absPath) return false;
  const rel = path.relative(STD_ROOT, absPath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      inputFile: { type: "string", short: "i" },
      outputFile: { type: "string", short: "o" },
      outputModules: { type: "boolean", short: "a" },
      "dump-ast": { type: "boolean" },
      "dump-tokens": { type: "boolean" },
      "dump-ast-json": { type: "string" },
      "dump-bc": { type: "boolean" },
      "list-attributes": { type: "boolean" },
      "track-heap": { type: "boolean" },
      "keep-ir": { type: "boolean" },
      "warn-std": { type: "boolean" },
      "warn-disposable": { type: "boolean" },
      lsp: { type: "boolean" },
      test: { type: "boolean" },
    },
    allowPositionals: true,
  });

  // --lsp: become the language server, speaking LSP over stdio, and never
  // return. This exists so a packaged binary can back an editor extension
  // with no repo checkout and no Node install - the same reason the compiler
  // itself got packaged.
  //
  // The import is dynamic on purpose: src/lsp/server.js wires up
  // process.stdin at module scope, so a static import would hijack stdin on
  // every ordinary compile. Nothing may reach stdout past this point either -
  // stdout IS the protocol transport - which is why this sits ahead of every
  // console.log in main().
  if (values.lsp) {
    import("./lsp/server.js").catch((err) => {
      console.error(`failed to start the language server: ${err?.message ?? err}`);
      process.exit(1);
    });
    return;
  }

  // Phase 11.E.4: --list-attributes - dump the registry's known
  // attribute names + each entry's handler phases. Useful for
  // tooling (editor LSP completions, doc generation) and the
  // human-typing-an-@-by-mistake workflow.
  if (values["list-attributes"]) {
    const names = knownAttributeNames();
    if (names.length === 0) {
      process.stdout.write("no attributes registered\n");
    } else {
      process.stdout.write(`known attributes (${names.length}):\n`);
      for (const n of names) process.stdout.write(`  @${n}\n`);
    }
    return;
  }

  // A yoopiler whose std/ or runtime/ didn't come along is unusable. Say so
  // once, up front, instead of failing later as an unresolvable import.
  const installProblems = checkInstallRoots();
  if (installProblems.length > 0) {
    console.error("yoopiler installation looks incomplete:\n");
    for (const p of installProblems) console.error(`  ${p}\n`);
    process.exit(1);
  }

  // Test mode. Entered by `--test [path]`, or implicitly when the entry is a
  // `*.test.yoop` declaring `import.test;` - such a module has no `main`, so
  // without this it would just fail to compile. Everything downstream is the
  // ordinary pipeline; the only difference is a synthetic entry module carrying
  // a generated `main`, and that the executable lands in the temp dir and is
  // run instead of being left in the tree.
  const testCtx = setUpTestMode(values, positionals);

  const inputFile = testCtx
    ? testCtx.entryAbs
    : (values.inputFile ?? positionals[0]);
  if (!inputFile || (!testCtx && !fs.existsSync(inputFile))) {
    console.log("input file not found.");
    process.exit(1);
  }

  const outputFileName =
    values.outputFile ?? inputFile?.replace(".yoop", "") ?? "output";
  const modulesOutputFileName = values.outputModules
    ? `${outputFileName}.m`
    : null;
  // The synthetic test entry has no file on disk, so it cannot be realpath'd.
  const entryAbs = testCtx
    ? testCtx.entryAbs
    : fs.realpathSync(path.resolve(inputFile));

  // Layer 1 parity dump, to stdout so it pipes into a diff. The bootstrap's
  // matching emitter is bootstrap/tools/dump_tokens.yoop.
  if (values["dump-tokens"]) {
    process.stdout.write(dumpTokens(fs.readFileSync(inputFile, "utf8")));
    return;
  }

  if (values["dump-ast"]) {
    const astOut = values.outputFile ?? `${outputFileName}.ast.html`;
    dumpAst(inputFile, astOut);
    return;
  }

  if (values["dump-ast-json"] !== undefined) {
    // Value is the explicit output path; empty string falls back to a default.
    const astOut = values["dump-ast-json"] || `${outputFileName}.ast.json`;
    dumpAstJson(inputFile, astOut);
    return;
  }

  let modules;
  let autoloadedStdModuleIds;
  try {
    ({ modules, autoloadedStdModuleIds } = loadModuleGraph(
      entryAbs,
      testCtx ? { readFile: testCtx.readFile } : {},
    ));
  } catch (err) {
    if (err && err.isParseError) {
      // Parse error from the lexer/parser: it has line/column/length. Which FILE
      // it came from is stamped by moduleGraph's readAndParse (`srcPath` /
      // `srcText`); the entry is only a fallback for a parse that did not go
      // through the graph. Without the stamp, a syntax error in an imported
      // module rendered against the entry's source - wrong file, wrong caret.
      console.error(
        formatDiagnostic({
          filePath: err.srcPath ?? inputFile,
          src: err.srcText ?? fs.readFileSync(entryAbs, "utf8"),
          loc: {
            pos: err.pos,
            line: err.line,
            column: err.column,
            length: err.length,
          },
          message: err.rawMessage ?? err.message,
        }),
      );
      process.exit(1);
    }
    throw err;
  }

  // Test mode: give every suite function its export wrapper before typecheck,
  // so the generated entry's `import { name as suiteN }` resolves without the
  // author having to write `export` on each one.
  if (testCtx) {
    testCtx.testModuleIds = new Set(
      modules
        .filter((m) => testCtx.testFilePaths.has(m.absPath))
        .map((m) => m.id),
    );
    exportSuiteFunctions(modules, testCtx.testModuleIds);
  }

  const { errors, warnings, moduleEnv, programState } = typecheckProgram(modules);
  // Test mode: the syntactic collection pass took every kind-prefixed function.
  // Now that kinds are resolved, reject any that is not enumerable into the
  // table `--test` asked for.
  if (testCtx && errors.length === 0) {
    for (const p of verifyCollectedSuites(modules, testCtx.testModuleIds)) {
      errors.push(p);
    }
  }
  programState.autoloadedStdModuleIds = autoloadedStdModuleIds ?? {};
  // --track-heap: instruct codegen to emit yoop_diag_record_alloc /
  // yoop_diag_record_free calls around the heapAlloc / heapFree
  // intrinsics, and to install an atexit dump in main. See
  // runtime/yoop_runtime.c and the emitBuiltinGenericCall branches in
  // jsyoopcodegen/codegen.js.
  programState.trackHeap = !!values["track-heap"];

  // Resolve a diagnostic back to the SOURCE FILE whose text it should be
  // rendered against. Keyed on srcPath, not moduleId: under
  // modules-as-directories many source files share one moduleId, so a
  // moduleId-keyed map keeps only one of them and every other file's
  // diagnostics would print a caret into the wrong source. moduleId is the
  // fallback for anything stamped before srcPath existed.
  const modByPath = new Map(modules.map((m) => [m.absPath, m]));
  const modById = new Map(modules.map((m) => [m.id, m]));
  const ownerOf = (error) =>
    modByPath.get(error.srcPath) ??
    modById.get(error.moduleId) ??
    modules[modules.length - 1];

  if (errors.length > 0) {
    // Test mode: a bad suite (wrong signature, unresolvable kind) also breaks
    // the generated entry's suite table, producing a second diagnostic that
    // points into source the user never wrote. Report only the real ones. If
    // the ONLY errors are in the generated module, that is a bug in the
    // generator, so those still print - labeled, so it is obvious whose fault
    // it is.
    let reported = errors;
    if (testCtx) {
      const entryModuleId = modules.find((m) => m.absPath === testCtx.entryAbs)?.id;
      const real = errors.filter((e) => e.moduleId !== entryModuleId);
      if (real.length > 0) {
        reported = real;
      } else {
        console.error(
          "internal error: yoopiler's generated test entry failed to typecheck.\n" +
            "  This is a compiler bug, not a problem with your tests.\n",
        );
      }
    }
    console.error(
      `typecheck failed (${reported.length} error${reported.length === 1 ? "" : "s"}):\n`,
    );
    for (const error of reported) {
      const mod = ownerOf(error);
      console.error(
        formatDiagnostic({
          filePath: mod?.absPath ?? inputFile,
          src: mod?.src ?? "",
          loc: error.sourceLoc,
          message: error.message,
        }),
      );
      console.error("");
    }
    process.exit(1);
  }

  // Warnings print after a clean typecheck and never change the exit code.
  // Scoped to the user's own modules: std/ is autoloaded into every graph, so
  // a warning there would attach itself to every compile in the world and be
  // unfixable by whoever is reading it. `--warn-std` opts back in for work on
  // std itself.
  if (warnings.length > 0) {
    let reported = values["warn-std"]
      ? warnings
      : warnings.filter((w) => !isStdPath(ownerOf(w)?.absPath));
    // `unhandled-disposable` is OPT-IN on the command line. The ownership model
    // is advisory by design (plans/ownership-and-typestate-redesign.md), and the
    // warning has two known false-positive classes it cannot yet tell apart
    // from a real leak: a value living in an arena scope, where NOT disposing is
    // the point, and a copy read back out of a container, where disposing would
    // double-free. It stays on in the LSP, which is where that doc says the
    // advisory belongs; `--warn-disposable` surfaces it in a build when you
    // want to audit for leaks.
    if (!values["warn-disposable"]) {
      reported = reported.filter((w) => w.code !== "unhandled-disposable");
    }
    for (const warning of reported) {
      const mod = ownerOf(warning);
      console.error(
        formatDiagnostic({
          filePath: mod?.absPath ?? inputFile,
          src: mod?.src ?? "",
          loc: warning.sourceLoc,
          message: `warning: ${warning.message}${warning.code ? ` [${warning.code}]` : ""}`,
        }),
      );
      console.error("");
    }
  }
  console.log("typecheck: ok");

  // Phase 11.B: opportunistic module-init folding. Each module-level
  // `let` / `const` whose initializer the interpreter can evaluate is
  // stamped with `decl.comptimeFolded = true` + `decl.comptimeValue`;
  // codegen consumes those to emit an LLVM `@global` with a literal
  // initial value (skipping the runtime `module_init` call entirely
  // for that decl). Failures are silent - the existing runtime path
  // handles the unfoldable cases the same way it does today.
  //
  // Phase 11.C: this pass runs BEFORE the attribute pass so the
  // `@precompile` consumer can read each decl's `comptimeFolded` flag
  // and surface a hard error if the user-declared comptime
  // requirement wasn't met.
  runComptimePass(modules, {
    programState,
    dumpBC: !!values["dump-bc"],
  });

  // Phase 11.A + 11.C: attribute dispatch pass. `@precompile` now
  // surfaces fold failures as hard errors (the opportunistic
  // fallback was the wrong shape for an explicitly user-marked
  // comptime decl). Future attribute consumers plug into this hook.
  const attrErrors = [];
  runAttributePass(modules, attrErrors);
  if (attrErrors.length > 0) {
    console.error(
      `attribute pass failed (${attrErrors.length} error${attrErrors.length === 1 ? "" : "s"}):\n`,
    );
    for (const error of attrErrors) {
      const mod = ownerOf(error);
      console.error(
        formatDiagnostic({
          filePath: mod?.absPath ?? inputFile,
          src: mod?.src ?? "",
          loc: error.sourceLoc,
          message: error.message,
        }),
      );
      console.error("");
    }
    process.exit(1);
  }

  const { ir, linkFlags } = codegenProgram(modules, moduleEnv, programState);
  console.log("llvm IR: ok");

  // A per-invocation temp directory, not a fixed path: two yoopiler processes
  // running at once would otherwise clobber each other's IR mid-compile.
  // Removed on the way out unless --keep-ir asks to inspect it.
  const keepIR = !!values["keep-ir"];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoopiler-"));
  // An exit hook rather than try/finally: the clang failure paths below call
  // process.exit(), which skips pending finally blocks but does fire "exit".
  if (!keepIR) {
    process.on("exit", () => fs.rmSync(tmpDir, { recursive: true, force: true }));
  }
  const tmpIR = path.join(tmpDir, "yooper_out.ll");
  fs.writeFileSync(tmpIR, ir, "utf8");
  if (keepIR) console.log(`llvm IR written to ${tmpIR}`);
  // Test mode: the binary is an artifact of the run, not of the project, so it
  // goes in the temp dir and rides the same exit-hook cleanup as the IR.
  // --keep-ir keeps both, which is how you get it under lldb.
  const testExe = testCtx ? path.join(tmpDir, "yoop_tests") : null;
  const linkOutput = testExe ?? outputFileName;
  const allLinkFlags = [...linkFlags, ...runtimeLinkFlags()];

  // Turn each `extern "C" from library "X"` name into the right linker
  // arg(s). Default: `-lX`. macOS Apple-framework escape hatch: a name
  // of shape `framework:NAME` lowers to `-framework NAME` (two argv
  // entries) so OpenGL / Cocoa / etc. can be linked without a tweak to
  // every yoop call site. On Windows only `framework:OpenGL` has an
  // equivalent (opengl32); the rest drop, as does the whole convention on
  // Linux -- it is an Apple concept.
  const linkArgs = allLinkFlags.flatMap(lowerLinkFlag);
  // Where to look for the libraries just named: Homebrew on macOS, vcpkg and
  // the usual unzipped SDK prefixes on Windows, plus YOOP_LIB_PATH anywhere.
  const searchArgs = librarySearchArgs();
  // C glue a named library needs on this platform but not on others (today:
  // the Windows OpenGL entry-point loader).
  const glueSources = glueSourcesForLinkFlags(allLinkFlags);

  // `-g` keeps the DWARF metadata that codegen emits; `-O0` keeps every
  // statement's DILocation distinct so `lldb` stepping doesn't fold lines.
  // Once an opt-level flag lands these should respect it.
  const debugFlags = ["-g", "-O0"];
  const clang = resolveClang();
  if (process.platform === "win32") {
    const clangArgs = [
      tmpIR,
      ...RUNTIME_SOURCES,
      ...glueSources,
      "-o",
      `${linkOutput}.exe`,
      ...debugFlags,
      ...searchArgs,
      ...linkArgs,
      ...windowsClangArgs(),
    ];
    runClang(clang, clangArgs);
    if (testCtx) {
      runTestBinary(`${linkOutput}.exe`, positionals.slice(1), keepIR);
      return;
    }
    console.log(`compiled: ${outputFileName}`);
  } else {
    const clangArgs = [
      tmpIR,
      ...RUNTIME_SOURCES,
      ...glueSources,
      "-o",
      linkOutput,
      ...debugFlags,
      ...searchArgs,
      ...linkArgs,
    ];
    runClang(clang, clangArgs);
    if (testCtx) {
      runTestBinary(linkOutput, positionals.slice(1), keepIR);
      return;
    }
    console.log(`compiled: ${outputFileName}`);
  }
}

// Run the freshly-linked test binary, forwarding any extra positionals as
// suite-name filters (std/test.yoop reads them via std/env.yoop) and
// propagating its exit code, which is the failure count.
function runTestBinary(exePath, filterArgs, keepExe) {
  if (keepExe) console.log(`test binary written to ${exePath}`);
  try {
    execFileSync(exePath, filterArgs, { stdio: "inherit" });
  } catch (err) {
    if (typeof err?.status === "number") process.exit(err.status);
    throw err;
  }
  process.exit(0);
}

// Decide whether this invocation is a test run, and if so do the discovery and
// entry synthesis. Returns null for an ordinary compile.
//
// Two ways in:
//   yoopiler --test [dir-or-file]   - glob **/*.test.yoop under the path
//   yoopiler foo.test.yoop          - the in-file `import.test;` flag
function setUpTestMode(values, positionals) {
  const target = values.inputFile ?? positionals[0];
  let rootDir;
  let files;

  if (values.test) {
    const at = path.resolve(target ?? process.cwd());
    if (!fs.existsSync(at)) {
      console.error(`--test: path not found: ${at}`);
      process.exit(1);
    }
    if (fs.statSync(at).isDirectory()) {
      rootDir = fs.realpathSync(at);
      files = discoverTestFiles(rootDir);
      if (files.length === 0) {
        console.error(`--test: no *.test.yoop files found under ${rootDir}`);
        process.exit(1);
      }
    } else {
      const abs = fs.realpathSync(at);
      rootDir = path.dirname(abs);
      files = [abs];
    }
  } else if (
    target &&
    target.endsWith(".test.yoop") &&
    fs.existsSync(target) &&
    isTestModuleFile(fs.realpathSync(path.resolve(target)))
  ) {
    const abs = fs.realpathSync(path.resolve(target));
    rootDir = path.dirname(abs);
    files = [abs];
  } else {
    return null;
  }

  const { modules: suiteModules, errors } = collectSuiteModules(files, rootDir);
  if (errors.length > 0) {
    for (const e of errors) {
      if (e.message) {
        console.error(e.message);
      } else {
        console.error(`${e.absPath}: ${e.err?.message ?? e.err}`);
      }
      console.error("");
    }
    process.exit(1);
  }

  const suiteCount = suiteModules.reduce((n, m) => n + m.suites.length, 0);
  if (suiteCount === 0) {
    console.error(
      `--test: found ${suiteModules.length} test file(s) but no suites.\n` +
        `  A suite is a top-level function carrying the \`suite\` kind:\n` +
        `    suite function myBehavior(): void { ... }`,
    );
    process.exit(1);
  }
  console.log(
    `test: ${suiteCount} suite(s) in ${suiteModules.length} file(s)`,
  );

  const entryAbs = entryPathFor(rootDir);
  const entrySrc = generateEntrySource(suiteModules);
  return {
    entryAbs,
    entrySrc,
    testFilePaths: new Set(files),
    testModuleIds: new Set(),
    readFile: (absPath) => (absPath === entryAbs ? entrySrc : null),
  };
}

// start
main();
