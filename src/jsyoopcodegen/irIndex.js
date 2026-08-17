// The inverse of debugInfo.js: read the DWARF metadata back OUT of emitted IR
// and rebuild the source-to-instruction mapping from it.
//
// debugInfo.js already stamps every `define` with a !DISubprogram (name, file,
// line) and nearly every instruction with a !DILocation (line, column, scope).
// That is a complete source map - it is just written in the direction LLVM
// wants to read it. This module walks it the other way so an editor can ask
// "which instructions did line 34 of arena_scope.yoop turn into".
//
// Deliberately a pure string-in / data-out module: no clang, no filesystem, no
// codegen coupling. It takes the `ir` string that codegenProgram already
// returns, which is why the LSP can build this index without writing a
// temp file or shelling out to anything.
//
// What we DON'T have to handle, given how debugInfo.js emits today:
//   - inlining. Nothing sets `inlinedAt`, so a DILocation belongs to exactly
//     one function.
//   - lexical blocks. Nothing emits !DILexicalBlock, so a DILocation's scope
//     is always the !DISubprogram directly.
// Both are still handled defensively below (the scope walk is a loop, not a
// single hop) because they are the obvious next things debugInfo.js might
// grow, and a silently wrong source map is worse than a slow one.

import path from "node:path";

// One `!N = ...` metadata line, parsed into the shapes we care about.
// Anything that is not a DIFile / DISubprogram / DILocation is skipped -
// DISubroutineType, DILocalVariable, DIBasicType and friends carry no
// source-position information we use.
const MD_LINE = /^!(\d+) = (?:distinct )?(.*)$/;
const DEFINE_LINE = /^define\s+.*?@("?)([^\s("]+)\1\s*\(/;
const TRAILING_DBG = /!dbg !(\d+)\s*$/;
// A `define` carries its !DISubprogram before the opening brace rather than at
// end of line (`define i32 @main() !dbg !994 {`), so TRAILING_DBG - which is
// anchored to end-of-line for instructions - cannot see it.
const DEFINE_DBG = /!dbg !(\d+)\s*\{\s*$/;
const BLOCK_LABEL = /^([A-Za-z0-9_.$-]+):/;

// `field: value` out of an LLVM metadata argument list. Values are unquoted
// strings, bare integers, or `!N` refs; we only ever want one at a time, so a
// targeted match beats parsing the whole list.
function field(body, name) {
  const m = body.match(new RegExp(`\\b${name}: ("(?:[^"\\\\]|\\\\.)*"|![0-9]+|[A-Za-z0-9_]+)`));
  if (!m) return null;
  const raw = m[1];
  if (raw.startsWith('"')) return JSON.parse(raw);
  return raw;
}

function refId(raw) {
  return raw != null && raw.startsWith("!") ? Number(raw.slice(1)) : null;
}

// Parse every `!N = ...` line into a map of id -> record. Returns only the
// three node kinds that carry source positions.
function parseMetadata(lines) {
  const md = new Map();
  for (const line of lines) {
    const m = line.match(MD_LINE);
    if (!m) continue;
    const id = Number(m[1]);
    const body = m[2];
    if (body.startsWith("!DIFile(")) {
      const filename = field(body, "filename");
      const directory = field(body, "directory");
      md.set(id, {
        kind: "file",
        // Absolute where debugInfo.js gave us a directory, which it always
        // does today. Kept relative rather than resolved against cwd if not:
        // guessing a root would produce a path that silently matches nothing.
        path: directory ? path.join(directory, filename ?? "") : filename,
      });
    } else if (body.startsWith("!DISubprogram(")) {
      md.set(id, {
        kind: "subprogram",
        name: field(body, "name"),
        linkageName: field(body, "linkageName"),
        fileId: refId(field(body, "file")),
        line: Number(field(body, "line")),
      });
    } else if (body.startsWith("!DILocation(")) {
      md.set(id, {
        kind: "location",
        line: Number(field(body, "line")),
        column: Number(field(body, "column")),
        scopeId: refId(field(body, "scope")),
        inlinedAtId: refId(field(body, "inlinedAt")),
      });
    } else if (body.startsWith("!DILexicalBlock(")) {
      // Not emitted today. Present so that if debugInfo.js starts emitting
      // them, locations keep resolving instead of dropping to null.
      md.set(id, { kind: "lexicalBlock", scopeId: refId(field(body, "scope")) });
    }
  }
  return md;
}

// Walk a DILocation's scope chain up to the enclosing DISubprogram. Bounded
// rather than recursive so a malformed or cyclic chain degrades to null
// instead of blowing the stack.
function subprogramFor(md, scopeId) {
  let cur = scopeId;
  for (let hops = 0; cur != null && hops < 64; hops++) {
    const node = md.get(cur);
    if (!node) return null;
    if (node.kind === "subprogram") return node;
    if (node.kind === "lexicalBlock") {
      cur = node.scopeId;
      continue;
    }
    return null;
  }
  return null;
}

// Build the index.
//
//   irText: the `ir` string from codegenProgram
//
// Returns:
//   {
//     lines:     string[]            the IR, split, so callers can slice it
//     functions: Fn[]                one per `define`, in emission order
//     bySource:  Map<absPath, Map<srcLine, IrRef[]>>
//   }
//
// Fn:     { symbol, name, file, declLine, startLine, endLine }
//         startLine/endLine are 0-based indices into `lines`, inclusive, and
//         span `define ... {` through the closing `}`.
// IrRef:  { irLine, column, fn, block }
//         irLine is a 0-based index into `lines`; `block` is the basic-block
//         label the instruction sits under, which is the cheapest way to show
//         a reader that one source line produced code in three blocks.
export function buildIrIndex(irText) {
  const lines = irText.split("\n");
  const md = parseMetadata(lines);

  const functions = [];
  const bySource = new Map();

  const record = (file, srcLine, ref) => {
    if (!file || !Number.isFinite(srcLine)) return;
    let perFile = bySource.get(file);
    if (!perFile) bySource.set(file, (perFile = new Map()));
    let refs = perFile.get(srcLine);
    if (!refs) perFile.set(srcLine, (refs = []));
    refs.push(ref);
  };

  let i = 0;
  while (i < lines.length) {
    const defMatch = lines[i].match(DEFINE_LINE);
    if (!defMatch) {
      i++;
      continue;
    }
    const symbol = defMatch[2];
    const defDbg = lines[i].match(DEFINE_DBG);
    const spId = defDbg ? Number(defDbg[1]) : null;
    // A `define` whose trailing !dbg is missing is one of the hand-written
    // runtime trampolines (yoop_coro_resume and friends) - real IR, but with
    // no source behind it, so it gets a function entry and no line mapping.
    const sp = spId != null ? md.get(spId) : null;
    const spFile = sp?.fileId != null ? md.get(sp.fileId)?.path : null;

    const startLine = i;
    let block = "entry";
    let end = i;
    // First pass over the body: one slot per instruction line, carrying the
    // basic block it sits in and the !dbg it carries (if any).
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line === "}") {
        end = j;
        break;
      }
      end = j;
      if (line.trim() === "") continue;
      const label = line.match(BLOCK_LABEL);
      if (label) {
        block = label[1];
        continue;
      }
      const dbg = line.match(TRAILING_DBG);
      body.push({ irLine: j, block, dbgId: dbg ? Number(dbg[1]) : null });
    }

    // Second pass: gap-fill. debugInfo.js only stamps !dbg on side-effecting
    // and control-flow instructions (see DBG_TARGET_RE) - pure arithmetic,
    // GEP, cast, cmp and phi are deliberately left bare, because that is all a
    // DEBUGGER needs for breakpoints and backtraces. For a visibility tool it
    // is exactly the wrong half to drop: `acc = acc + i * i` would show its
    // `store` and hide the `mul` and the `add`.
    //
    // Rather than widen DBG_TARGET_RE - which would change the IR of every
    // build, for every user, to serve an editor feature - we infer here. A
    // bare instruction is a pure SSA computation whose result feeds a later
    // instruction, and codegen emits operands before their uses, so it belongs
    // to the next marked instruction IN THE SAME BLOCK. Trailing bare
    // instructions with nothing marked after them fall back to the previous
    // marked one. Inferred attributions are flagged so the UI can show them as
    // the inference they are rather than as ground truth.
    for (let k = 0; k < body.length; k++) {
      if (body[k].dbgId != null) continue;
      let src = null;
      for (let f = k + 1; f < body.length && body[f].block === body[k].block; f++) {
        if (body[f].dbgId != null) {
          src = body[f].dbgId;
          break;
        }
      }
      if (src == null) {
        for (let b = k - 1; b >= 0 && body[b].block === body[k].block; b--) {
          if (body[b].dbgId != null) {
            src = body[b].dbgId;
            break;
          }
        }
      }
      if (src != null) {
        body[k].dbgId = src;
        body[k].inferred = true;
      }
    }

    for (const slot of body) {
      if (slot.dbgId == null) continue;
      const loc = md.get(slot.dbgId);
      if (!loc || loc.kind !== "location") continue;
      const owner = subprogramFor(md, loc.scopeId);
      const ownerFile = owner?.fileId != null ? md.get(owner.fileId)?.path : null;
      record(ownerFile, loc.line, {
        irLine: slot.irLine,
        column: loc.column,
        fn: owner?.linkageName ?? symbol,
        block: slot.block,
        inferred: !!slot.inferred,
      });
    }

    functions.push({
      symbol,
      name: sp?.name ?? symbol,
      file: spFile,
      declLine: sp?.line ?? null,
      startLine,
      endLine: end,
    });
    i = end + 1;
  }

  return { lines, functions, bySource };
}
