import { parseArgs } from "util";
import fs from "fs";
import { execFileSync } from "child_process";
import os from "os";
import path from "path";

import { parse } from "./jsyooparser/parser.js";
import { codegen } from "./jsyoopcodegen/codegen.js";
import { typecheck } from "./jsyooptypecheck/typecheck.js";

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

  let sourceStr = "";
  if (phaseMode) {
    // hard coding phase file
    sourceStr = fs.readFileSync("phasePrograms/phase_1_3_struct.yoop", "utf8");
  } else {
    let inputFile = values.inputFile ?? positionals[0];

    if (!fs.existsSync(inputFile)) {
      console.log("input file not found.");
      process.exit(1);
    }

    sourceStr = fs.readFileSync(inputFile, "utf8");
  }

  const outputFileName = values.outputFile ?? values.inputFile?.replace(".yoop", "") ?? "output";

  const ast = parse(sourceStr);
  console.log("parser: ok");
  console.log("ast", JSON.stringify(ast));
  const { errors } = typecheck(ast);
  if (errors.length > 0) {
    console.error("typecheck errors:");
    errors.forEach((error) => console.error(error));
    process.exit(1);
  }
  console.log("typecheck: ok");
  const ir = codegen(ast);

  console.log("llvm IR: ok");
  console.log(ir);

  const tmpIR = path.join(os.tmpdir(), "yooper_out.ll");
  fs.writeFileSync(tmpIR, ir, "utf8");
  if (process.platform === "win32") {
    const clang = "C:\\Program Files\\LLVM\\bin\\clang.exe"; // todo make more robust
    const clangArgs = [tmpIR, "-o", `${outputFileName}.exe`];
    clangArgs.push("-fuse-ld=link"); // force different linker (couldn't figure out the problem)
    execFileSync(clang, clangArgs, { stdio: "inherit" });
    console.log(`compiled: ${outputFileName}`);
  } else {
    execFileSync("clang", [tmpIR, "-o", outputFileName], { stdio: "inherit" });
    console.log(`compiled: ${outputFileName}`);
  }
}

// start
main();
