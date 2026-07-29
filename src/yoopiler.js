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
  runtimeLinkFlags,
} from "./runtimeBuild.js";
import { formatDiagnostic } from "./helpers.js";
import { dumpAst, dumpAstJson } from "./dumpAst.js";
import { checkInstallRoots } from "./install_root.js";

// Locate the clang binary. `YOOP_CLANG` wins if set (and is a hard error if it
// points at nothing, since that's explicit user intent). On Windows we keep
// the historical Program Files probe as a fallback, but PATH is consulted
// first everywhere now, so an LLVM installed anywhere else just works.
function resolveClang() {
  const override = process.env.YOOP_CLANG;
  if (override) {
    if (!fs.existsSync(override)) {
      console.error(`YOOP_CLANG points at a file that does not exist: ${override}`);
      process.exit(1);
    }
    return override;
  }
  if (process.platform === "win32") {
    const fallback = "C:\\Program Files\\LLVM\\bin\\clang.exe";
    // Prefer PATH; only reach for the well-known install if PATH has no clang.
    try {
      execFileSync("clang", ["--version"], { stdio: "ignore" });
      return "clang";
    } catch {
      if (fs.existsSync(fallback)) return fallback;
      return "clang";
    }
  }
  return "clang";
}

// Run clang, turning its two failure modes into something readable: a missing
// binary becomes an install hint, and a compile/link failure exits with
// clang's own status instead of a node stack trace over already-printed
// diagnostics.
function runClang(clang, clangArgs) {
  try {
    execFileSync(clang, clangArgs, { stdio: "inherit" });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      console.error(
        `clang not found (tried "${clang}").\n` +
          `  yoopiler shells out to clang to assemble and link.\n` +
          `  install LLVM/clang and put it on PATH, or set YOOP_CLANG to its full path.`,
      );
      process.exit(1);
    }
    if (typeof err?.status === "number") process.exit(err.status);
    throw err;
  }
}

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      inputFile: { type: "string", short: "i" },
      outputFile: { type: "string", short: "o" },
      outputModules: { type: "boolean", short: "a" },
      "dump-ast": { type: "boolean" },
      "dump-ast-json": { type: "string" },
      "dump-bc": { type: "boolean" },
      "list-attributes": { type: "boolean" },
      "track-heap": { type: "boolean" },
      "keep-ir": { type: "boolean" },
      lsp: { type: "boolean" },
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

  const inputFile = values.inputFile ?? positionals[0];
  if (!inputFile || !fs.existsSync(inputFile)) {
    console.log("input file not found.");
    process.exit(1);
  }

  const outputFileName =
    values.outputFile ?? inputFile?.replace(".yoop", "") ?? "output";
  const modulesOutputFileName = values.outputModules
    ? `${outputFileName}.m`
    : null;
  const entryAbs = fs.realpathSync(path.resolve(inputFile));

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
    ({ modules, autoloadedStdModuleIds } = loadModuleGraph(entryAbs));
  } catch (err) {
    if (err && err.isParseError) {
      // Parse error from the lexer/parser: it has line/column/length and
      // already includes a formatted code frame in `message`. We don't know
      // which file the parser threw from (loadModuleGraph throws bare), so
      // assume the entry until we plumb that through.
      console.error(
        formatDiagnostic({
          filePath: inputFile,
          src: fs.readFileSync(entryAbs, "utf8"),
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

  const { errors, moduleEnv, programState } = typecheckProgram(modules);
  programState.autoloadedStdModuleIds = autoloadedStdModuleIds ?? {};
  // --track-heap: instruct codegen to emit yoop_diag_record_alloc /
  // yoop_diag_record_free calls around the heap_alloc / heap_free
  // intrinsics, and to install an atexit dump in main. See
  // runtime/yoop_runtime.c and the emitBuiltinGenericCall branches in
  // jsyoopcodegen/codegen.js.
  programState.trackHeap = !!values["track-heap"];

  if (errors.length > 0) {
    const modById = new Map(modules.map((m) => [m.id, m]));
    console.error(
      `typecheck failed (${errors.length} error${errors.length === 1 ? "" : "s"}):\n`,
    );
    for (const error of errors) {
      const mod = modById.get(error.moduleId) ?? modules[modules.length - 1];
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
    const modById = new Map(modules.map((m) => [m.id, m]));
    console.error(
      `attribute pass failed (${attrErrors.length} error${attrErrors.length === 1 ? "" : "s"}):\n`,
    );
    for (const error of attrErrors) {
      const mod = modById.get(error.moduleId) ?? modules[modules.length - 1];
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
  const allLinkFlags = [...linkFlags, ...runtimeLinkFlags()];

  // Turn each `extern "C" from library "X"` name into the right linker
  // arg(s). Default: `-lX`. macOS Apple-framework escape hatch: a name
  // of shape `framework:NAME` lowers to `-framework NAME` (two argv
  // entries) so OpenGL / Cocoa / etc. can be linked without a tweak to
  // every yoop call site. Ignored / passes through as `-lframework:NAME`
  // on Windows + Linux, which won't link -- the convention is meant for
  // macOS-targeted demos.
  function lowerLinkFlag(name) {
    if (name.startsWith("framework:")) {
      return ["-framework", name.slice("framework:".length)];
    }
    return [`-l${name}`];
  }
  const linkArgs = allLinkFlags.flatMap(lowerLinkFlag);

  // `-g` keeps the DWARF metadata that codegen emits; `-O0` keeps every
  // statement's DILocation distinct so `lldb` stepping doesn't fold lines.
  // Once an opt-level flag lands these should respect it.
  const debugFlags = ["-g", "-O0"];
  const clang = resolveClang();
  if (process.platform === "win32") {
    const clangArgs = [
      tmpIR,
      ...RUNTIME_SOURCES,
      "-o",
      `${outputFileName}.exe`,
      ...debugFlags,
      ...linkArgs,
      "-fuse-ld=link",
    ];
    runClang(clang, clangArgs);
    console.log(`compiled: ${outputFileName}`);
  } else {
    // On macOS, Homebrew installs libraries under /opt/homebrew (Apple Silicon)
    // or /usr/local (Intel). Add those to clang's search paths if they exist so
    // `extern "C" from library "SDL2"` and friends link without extra setup.
    const extraSearchPaths = [];
    if (process.platform === "darwin") {
      for (const prefix of ["/opt/homebrew", "/usr/local"]) {
        if (fs.existsSync(`${prefix}/lib`)) {
          extraSearchPaths.push(`-L${prefix}/lib`, `-I${prefix}/include`);
        }
      }
    }
    const clangArgs = [
      tmpIR,
      ...RUNTIME_SOURCES,
      "-o",
      outputFileName,
      ...debugFlags,
      ...extraSearchPaths,
      ...linkArgs,
    ];
    runClang(clang, clangArgs);
    console.log(`compiled: ${outputFileName}`);
  }
}

// start
main();
