import { parseArgs } from "util";
import fs from "fs";

import { parse } from './jsyooparser/parser.js';

const testMode = true;

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      inputFile: { type: "string", short: "i" },
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

    // get string from file...
  } else {
    // initial test
    sourceStr = `
        function add(a: int32, b: int32): int32 {
          return a + b;
        }
  
        function main(): void {
          const x: int32 = 10;
          const y: int32 = 20;
          const sum: int32 = add(x, y);
  
          if (sum >= 25) {
            let count: int32 = 0;
            while (count < 3) {
              count = count + 1;
            }
          } else {
            _ = sum;
          }
        }
      `;
  }
  parse(sourceStr);

  console.log("compiler: ok");
}

// start
main();
