// Parses LLVM IR TEXT (the .ll a compile writes) into the codegen shape in
// SCHEMA.md: defined functions, their basic blocks, each block's instructions
// with successor labels and source provenance. This is a line-level reading of
// the textual format, not a real IR parser: it only needs to be right about
// where functions and blocks begin, which labels a terminator names, and what
// !DILocation a !dbg reference points at - all of which the textual format
// makes unambiguous.

const DEFINE_RE = /^define\b.*?@([-\w$.]+|"[^"]+")\s*\(/;
const BLOCK_RE = /^([-\w$.]+):(\s*;.*)?$/;
const OP_RE = /^(?:%[-\w$.]+|"[^"]+")?\s*=?\s*(?:tail\s+|musttail\s+)?([a-z_][a-z0-9_.]*)/;
const DILOC_RE = /^!(\d+) = (?:distinct )?!DILocation\(line: (\d+), column: (\d+)/;

export function parseIr(text) {
  const functions = [];
  const dilocations = new Map();
  let fn = null;
  let block = null;

  const openBlock = (label) => {
    block = { label, instructions: [], succ: [] };
    fn.blocks.push(block);
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith(";")) continue;

    const diloc = line.match(DILOC_RE);
    if (diloc) {
      dilocations.set(diloc[1], { line: Number(diloc[2]), col: Number(diloc[3]) });
      continue;
    }

    const def = line.match(DEFINE_RE);
    if (def) {
      fn = { name: def[1].replace(/^"|"$/g, ""), blocks: [] };
      functions.push(fn);
      block = null;
      // The entry block often has no label line of its own; open one now so
      // the first instructions have somewhere to live.
      openBlock("entry");
      continue;
    }
    if (!fn) continue;
    if (line === "}") {
      fn.blocks = fn.blocks.filter((b) => b.instructions.length > 0);
      fn = null;
      block = null;
      continue;
    }

    const bl = line.match(BLOCK_RE);
    if (bl) {
      // An explicit label supersedes the implicit entry if nothing landed in
      // it yet (the emitter labeled its entry itself).
      if (block && block.instructions.length === 0) fn.blocks.pop();
      openBlock(bl[1]);
      continue;
    }

    if (!block) openBlock("entry");
    // Debug intrinsics carry no computation; the !dbg provenance on real
    // instructions is what the viewer maps back to source.
    if (line.includes("@llvm.dbg.")) continue;
    const dbgRef = line.match(/,?\s*!dbg !(\d+)/);
    const display = line.replace(/,?\s*!dbg !\d+/, "").replace(/,?\s*!\w+ !\d+/g, "");
    const op = display.match(OP_RE);
    const inst = { text: display, op: op ? op[1] : "?" };
    if (dbgRef) inst.dbgId = dbgRef[1];
    block.instructions.push(inst);
    for (const m of display.matchAll(/\blabel\s+%([-\w$.]+)/g)) {
      if (!block.succ.includes(m[1])) block.succ.push(m[1]);
    }
  }

  // Resolve !dbg references now that every !DILocation line has been seen
  // (metadata sits at the bottom of the file).
  for (const f of functions) {
    for (const b of f.blocks) {
      for (const inst of b.instructions) {
        if (inst.dbgId !== undefined) {
          const loc = dilocations.get(inst.dbgId);
          if (loc) inst.src = loc;
          delete inst.dbgId;
        }
      }
    }
  }
  return functions;
}

// Splits parsed functions into the ones the entry file owns and the std
// prelude, by the same naming rule gen_web uses: the entry's functions are
// `main` and `<stem>_*`.
export function splitFunctions(functions, stem) {
  const user = [];
  const std = [];
  const prefix = `${stem}_`;
  for (const f of functions) {
    if (f.name === "main" || f.name.startsWith(prefix)) user.push(f);
    else std.push(f);
  }
  return { user, std };
}
