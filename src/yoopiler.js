import { parseArgs } from "util";
import fs from "fs";
import { execFileSync } from "child_process";
import os from "os";
import path from "path";

import { loadModuleGraph } from "./jsyoopdriver/moduleGraph.js";
import { typecheckProgram } from "./jsyooptypecheck/typecheck.js";
import { codegenProgram } from "./jsyoopcodegen/codegen.js";

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
  const { errors } = typecheckProgram(modules);
  if (errors.length > 0) {
    console.error("typecheck errors:");
    errors.forEach((error) => console.error(`  ${error.message}`));
    process.exit(1);
  }
  console.log("typecheck: ok");

  const { ir, linkFlags } = codegenProgram(modules);
  console.log("llvm IR: ok");

  const tmpIR = path.join(os.tmpdir(), "yooper_out.ll");
  fs.writeFileSync(tmpIR, ir, "utf8");
  if (process.platform === "win32") {
    const clang = "C:\\Program Files\\LLVM\\bin\\clang.exe";
    const clangArgs = [tmpIR, "-o", `${outputFileName}.exe`, ...linkFlags.map((f) => `-l${f}`), "-fuse-ld=link"];
    execFileSync(clang, clangArgs, { stdio: "inherit" });
    console.log(`compiled: ${outputFileName}`);
  } else {
    const clangArgs = [tmpIR, "-o", outputFileName, ...linkFlags.map((f) => `-l${f}`)];
    execFileSync("clang", clangArgs, { stdio: "inherit" });
    console.log(`compiled: ${outputFileName}`);
  }
}

// start
main();
