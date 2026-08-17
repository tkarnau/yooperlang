// The assembly counterpart to irIndex.js: read `clang -S -g` output and
// rebuild the source-to-instruction mapping from its DWARF line directives.
//
// Produces the SAME index shape as buildIrIndex - `{ lines, functions,
// bySource }` - so a caller that already knows how to render an IR slice can
// render an asm slice without a second code path.
//
// The mechanism is different, and simpler. Where LLVM IR tags instructions
// individually with `!dbg`, an assembler file carries `.loc <fileno> <line>
// <col>` directives that are STATEFUL: a `.loc` applies to every instruction
// after it until the next one. So there are no gaps to infer here - a run of
// instructions under one `.loc` all belong to that source line, including the
// pure arithmetic that irIndex.js has to reconstruct.
//
// The file numbers come from `.file <n> "<dir>" "<name>"` directives, which
// clang emits at first use rather than all up front, so the table is built as
// we scan rather than in a prepass.

import path from "node:path";

const FILE_DIRECTIVE = /^\s*\.file\s+(\d+)\s+"((?:[^"\\]|\\.)*)"(?:\s+"((?:[^"\\]|\\.)*)")?/;
const LOC_DIRECTIVE = /^\s*\.loc\s+(\d+)\s+(\d+)(?:\s+(\d+))?/;
// A function's body ends at `.Lfunc_endN:`; its start is the bare symbol label
// at column 0 that precedes `.Lfunc_beginN:`.
const FUNC_END = /^\.Lfunc_end\d+:/;
const SYMBOL_LABEL = /^([A-Za-z_$.][\w$.]*):/;
// Basic-block markers. clang annotates both the numbered block comment and the
// branch-target label with the original LLVM block name, which is what lets an
// asm view show the same block names the IR view shows.
const BLOCK_COMMENT = /^\s*#\s*%bb\.\d+:\s*#\s*%(\S+)/;
const BLOCK_LABEL = /^\.LBB\d+_\d+:\s*#\s*%(\S+)/;

// True for a line that is an actual machine instruction rather than a
// directive, a label, a comment, or blank. Everything the assembler acts on
// that is not prefixed with `.` and not a label.
function isInstruction(line) {
  const t = line.trim();
  if (t === "") return false;
  if (t.startsWith("#")) return false;
  if (t.startsWith(".")) return false;
  // Column-0 labels (`main:`) and any other `name:` line.
  if (/^[\w$.]+:/.test(t)) return false;
  return true;
}

// Build the index.
//
//   asmText: the output of `clang -S -g` on the IR from codegenProgram
//
// Returns the same shape as buildIrIndex:
//   lines:     string[]
//   functions: [{ symbol, name, file, declLine, startLine, endLine }]
//   bySource:  Map<absPath, Map<srcLine, AsmRef[]>>
// AsmRef: { irLine, column, fn, block }
//   `irLine` keeps the irIndex field name (a 0-based index into `lines`) so
//   both indexes render through one function; here it indexes asm lines.
export function buildAsmIndex(asmText) {
  const lines = asmText.split("\n");
  const files = new Map(); // fileno -> absolute path
  const functions = [];
  const bySource = new Map();

  let current = null; // open function record
  let loc = null; // { file, line, column } from the last .loc
  let block = null;

  const record = (file, srcLine, ref) => {
    if (!file || !Number.isFinite(srcLine)) return;
    let perFile = bySource.get(file);
    if (!perFile) bySource.set(file, (perFile = new Map()));
    let refs = perFile.get(srcLine);
    if (!refs) perFile.set(srcLine, (refs = []));
    refs.push(ref);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fileM = line.match(FILE_DIRECTIVE);
    if (fileM) {
      // Two spellings: `.file N "dir" "name"` and `.file N "path"`. The
      // leading `.file "yooper_out.ll"` with no number is the assembler's own
      // source name and never carries a number, so it does not match.
      const [, no, a, b] = fileM;
      files.set(Number(no), b ? path.join(a, b) : a);
      continue;
    }

    const locM = line.match(LOC_DIRECTIVE);
    if (locM) {
      loc = {
        file: files.get(Number(locM[1])) ?? null,
        line: Number(locM[2]),
        column: locM[3] != null ? Number(locM[3]) : 0,
      };
      // The first .loc inside a function is its declaration position, which
      // is where clang points the prologue. Use it as the function's decl
      // line so functionForSource works the same way it does over IR.
      if (current && current.declLine == null) {
        current.file = loc.file;
        current.declLine = loc.line;
      }
      continue;
    }

    const blockM = line.match(BLOCK_COMMENT) ?? line.match(BLOCK_LABEL);
    if (blockM) {
      block = blockM[1];
      continue;
    }

    if (FUNC_END.test(line)) {
      if (current) {
        current.endLine = i;
        functions.push(current);
        current = null;
      }
      // A `.loc` never carries across a function boundary.
      loc = null;
      block = null;
      continue;
    }

    const symM = line.match(SYMBOL_LABEL);
    if (symM && !line.startsWith(".")) {
      // Close any function left open by malformed input rather than letting
      // its instructions leak into the next one.
      if (current) {
        current.endLine = i - 1;
        functions.push(current);
      }
      current = {
        symbol: symM[1],
        name: symM[1],
        file: null,
        declLine: null,
        startLine: i,
        endLine: i,
      };
      block = "entry";
      continue;
    }

    if (!isInstruction(line)) continue;
    if (loc == null) continue;
    record(loc.file, loc.line, {
      irLine: i,
      column: loc.column,
      fn: current?.symbol ?? null,
      block,
    });
  }

  if (current) {
    current.endLine = lines.length - 1;
    functions.push(current);
  }

  return { lines, functions, bySource };
}
