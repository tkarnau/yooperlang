import { parseArgs } from "util";
import fs from "fs";
import { execFileSync } from "child_process";
import os from "os";
import path from "path";

import { parse, testParser } from "./jsyooparser/parser.js";
import { codegen } from "./jsyoopcodegen/codegen.js";
import { testCharacterFns } from "./jsyooplexer/charFns.js";
import { testLexer } from "./jsyooplexer/lexer.js";
import { typecheck } from "./jsyooptypecheck/typecheck.js";

const testMode = process.env.testMode === "true";

function runTests() {
  testCharacterFns();
  testLexer();
  testParser();
}

function main() {
  if (testMode) {
    runTests();
  }

  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      inputFile: { type: "string", short: "i" },
      outputFile: { type: "string", short: "o" },
    },
    allowPositionals: true,
  });

  let sourceStr = "";
  if (!testMode) {
    let inputFile = values.inputFile ?? positionals[0];

    if (!fs.existsSync(inputFile)) {
      console.log("input file not found.");
      process.exit(1);
    }

    sourceStr = fs.readFileSync(inputFile, "utf8");
  } else {
    // initial test
    // sourceStr = `
    //     function add(a: int32, b: int32): int32 {
    //       return a + b;
    //     }

    //     function main(): void {
    //       const x: int32 = 10;
    //       const y: int32 = 20;
    //       const sum: int32 = add(x, y);
    //       const s: string;

    //       if (sum >= 25) {
    //         let count: int32 = 0;
    //         while (count < 3) {
    //           count = count + 1;
    //         }
    //       } else {
    //         // nobody cares
    //         s = "test";
    //       }
    //     }
    //   `;

    // Hello-world smoke test — exercises string literals + extern calls + codegen
    sourceStr =
      "\n" +
      "      function main(): int32 {\n" +
      '        printf("Hello, World!\\n");\n' +
      "        let x: int32 = 4 + 5;\n" +
      "        printf(`x is ${x}\\n`);\n" +
      "        printf(`sum: ${x + 1}, doubled: ${x * 2}\\n`);\n" +
      "        return 0;\n" +
      "      }\n" +
      "    ";
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
