import { parseArgs } from "util";
import fs from "fs";
import { execFileSync } from "child_process";
import os from "os";
import path from "path";

import { loadModuleGraph } from "./jsyoopdriver/moduleGraph.js";
import { typecheckProgram } from "./jsyooptypecheck/typecheck.js";
import { codegenProgram } from "./jsyoopcodegen/codegen.js";
import { RUNTIME_C, runtimeLinkFlags } from "./runtimeBuild.js";
import { formatDiagnostic } from "./helpers.js";

const phaseMode = process.env.phaseMode === "true";

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      inputFile: { type: "string", short: "i" },
      outputFile: { type: "string", short: "o" },
      outputModules: { type: "boolean", short: "a" }
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

  const { ir, linkFlags } = codegenProgram(modules, moduleEnv, programState);
  console.log("llvm IR: ok");

  const tmpIR = path.join(os.tmpdir(), "yooper_out.ll");
  fs.writeFileSync(tmpIR, ir, "utf8");
  const allLinkFlags = [...linkFlags, ...runtimeLinkFlags()];

  if (process.platform === "win32") {
    const clang = "C:\\Program Files\\LLVM\\bin\\clang.exe";
    const clangArgs = [
      tmpIR,
      RUNTIME_C,
      "-o",
      `${outputFileName}.exe`,
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
      RUNTIME_C,
      "-o",
      outputFileName,
      ...extraSearchPaths,
      ...allLinkFlags.map((f) => `-l${f}`),
    ];
    execFileSync("clang", clangArgs, { stdio: "inherit" });
    console.log(`compiled: ${outputFileName}`);
  }
}

// start
main();
