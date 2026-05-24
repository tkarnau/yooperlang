import { parseArgs } from "util";
import fs from "fs";
import { execFileSync } from "child_process";
import os from "os";
import path from "path";

import { loadModuleGraph } from "./jsyoopdriver/moduleGraph.js";
import { typecheckProgram } from "./jsyooptypecheck/typecheck.js";
import { codegenProgram } from "./jsyoopcodegen/codegen.js";
import { runAttributePass } from "./jsyoopattributes/pass.js";
import { runComptimePass } from "./jsyoopinterp/comptimePass.js";
import { RUNTIME_C, RUNTIME_SOURCES, runtimeLinkFlags } from "./runtimeBuild.js";
import { formatDiagnostic } from "./helpers.js";
import { dumpAst } from "./dumpAst.js";

const phaseMode = process.env.phaseMode === "true";

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      inputFile: { type: "string", short: "i" },
      outputFile: { type: "string", short: "o" },
      outputModules: { type: "boolean", short: "a" },
      "dump-ast": { type: "boolean" },
    },
    allowPositionals: true,
  });

  let inputFile;
  if (phaseMode) {
    inputFile = "phasePrograms/phase_1_3_struct.yoop";
  } else {
    inputFile = values.inputFile ?? positionals[0];
    if (!inputFile || !fs.existsSync(inputFile)) {
      console.log("input file not found.");
      process.exit(1);
    }
  }

  
  const outputFileName = values.outputFile ?? inputFile?.replace(".yoop", "") ?? "output";
  const modulesOutputFileName = values.outputModules ? `${outputFileName}.m` : null;
  const entryAbs = fs.realpathSync(path.resolve(inputFile));

  if (values["dump-ast"]) {
    const astOut = values.outputFile ?? `${outputFileName}.ast.html`;
    dumpAst(inputFile, astOut);
    return;
  }

  let modules;
  try {
    ({ modules } = loadModuleGraph(entryAbs));
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
          loc: { pos: err.pos, line: err.line, column: err.column, length: err.length },
          message: err.rawMessage ?? err.message,
        }),
      );
      process.exit(1);
    }
    throw err;
  }

  const { errors, moduleEnv, programState } = typecheckProgram(modules);

  if (errors.length > 0) {
    const modById = new Map(modules.map((m) => [m.id, m]));
    console.error(`typecheck failed (${errors.length} error${errors.length === 1 ? "" : "s"}):\n`);
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
  // for that decl). Failures are silent — the existing runtime path
  // handles the unfoldable cases the same way it does today.
  //
  // Phase 11.C: this pass runs BEFORE the attribute pass so the
  // `@precompile` consumer can read each decl's `comptimeFolded` flag
  // and surface a hard error if the user-declared comptime
  // requirement wasn't met.
  runComptimePass(modules);

  // Phase 11.A + 11.C: attribute dispatch pass. `@precompile` now
  // surfaces fold failures as hard errors (the opportunistic
  // fallback was the wrong shape for an explicitly user-marked
  // comptime decl). Future attribute consumers plug into this hook.
  const attrErrors = [];
  runAttributePass(modules, attrErrors);
  if (attrErrors.length > 0) {
    const modById = new Map(modules.map((m) => [m.id, m]));
    console.error(`attribute pass failed (${attrErrors.length} error${attrErrors.length === 1 ? "" : "s"}):\n`);
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

  const tmpIR = path.join(os.tmpdir(), "yooper_out.ll");
  fs.writeFileSync(tmpIR, ir, "utf8");
  const allLinkFlags = [...linkFlags, ...runtimeLinkFlags()];

  // `-g` keeps the DWARF metadata that codegen emits; `-O0` keeps every
  // statement's DILocation distinct so `lldb` stepping doesn't fold lines.
  // Once an opt-level flag lands these should respect it.
  const debugFlags = ["-g", "-O0"];
  if (process.platform === "win32") {
    const clang = "C:\\Program Files\\LLVM\\bin\\clang.exe";
    const clangArgs = [
      tmpIR,
      ...RUNTIME_SOURCES,
      "-o",
      `${outputFileName}.exe`,
      ...debugFlags,
      ...allLinkFlags.map((f) => `-l${f}`),
      "-fuse-ld=link",
    ];
    execFileSync(clang, clangArgs, { stdio: "inherit" });
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
      ...allLinkFlags.map((f) => `-l${f}`),
    ];
    execFileSync("clang", clangArgs, { stdio: "inherit" });
    console.log(`compiled: ${outputFileName}`);
  }
}

// start
main();
