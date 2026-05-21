import { parseArgs } from "util";
import fs from "fs";
import { execFileSync } from "child_process";
import os from "os";
import path from "path";

import { loadModuleGraph } from "./jsyoopdriver/moduleGraph.js";
import { typecheckProgram } from "./jsyooptypecheck/typecheck.js";
import { codegenProgram } from "./jsyoopcodegen/codegen.js";
import { RUNTIME_C, runtimeLinkFlags } from "./runtimeBuild.js";

const phaseMode = process.env.phaseMode === "true";

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      inputFile: { type: "string", short: "i" },
      outputFile: { type: "string", short: "o" },
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
  const entryAbs = fs.realpathSync(path.resolve(inputFile));

  const { modules } = loadModuleGraph(entryAbs);
  const { errors, moduleEnv, programState } = typecheckProgram(modules);
  if (errors.length > 0) {
    console.error("typecheck errors:");
    errors.forEach((error) => console.error(`  ${error.message}`));
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
