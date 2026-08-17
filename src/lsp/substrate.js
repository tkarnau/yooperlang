// The `@inspect` substrate view: what a marked function actually compiles to.
//
// Two questions, kept deliberately separate:
//
//   1. Is this source position inside a function the author marked with
//      `@inspect`, and for which modes? Answered from the AST the server
//      already has. Cheap, and never depends on codegen succeeding - a
//      function stays marked even if the program does not currently build.
//   2. What did that position compile to? Answered by running codegen and
//      indexing the result. Expensive-ish, so it happens only after (1) says
//      yes, and it is cached until the document changes.
//
// That ordering is the whole performance story: codegen never runs for a file
// with no `@inspect` in it, which is every file, almost always.
//
// The analysis used for codegen is built FRESH rather than borrowed from the
// server's live one. Codegen monomorphizes generics and stamps lowering state
// onto AST nodes, and the server's analysis is what hover, go-to-definition
// and rename read from - so handing it to codegen would let an editor feature
// quietly mutate the data every other editor feature depends on. A fresh
// analyze() is ~40ms and buys total isolation.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { analyze } from "./analyze.js";
import { codegenProgram } from "../jsyoopcodegen/codegen.js";
import { runComptimePass } from "../jsyoopinterp/comptimePass.js";
import { buildIrIndex } from "../jsyoopcodegen/irIndex.js";
import { buildAsmIndex } from "../jsyoopcodegen/asmIndex.js";
import { functionForSource, slice } from "../jsyoopcodegen/sourceIndex.js";
import { resolveClang, clangEnv, windowsClangArgs } from "../toolchain.js";

// ---------- 1. the marker ----------------------------------------------------

// Every `@inspect`ed function in `modules`, as
// Map<absPath, Map<declLine, { name, modes }>>.
//
// Keyed by declaration LINE because that is the one identifier the AST and the
// emitted IR are guaranteed to agree on: debugInfo.js takes a !DISubprogram's
// `line` straight from the same FUNCTION_DECL sourceLoc read here. Matching on
// the mangled symbol instead would mean reimplementing codegen's mangling, and
// matching on the bare name would collide across modules.
export function collectInspectFunctions(modules) {
  const byFile = new Map();
  for (const mod of modules ?? []) {
    if (!mod?.absPath || !mod.ast?.body) continue;
    for (const decl of mod.ast.body) {
      const fn = inspectedFn(decl);
      if (!fn) continue;
      const line = fn.sourceLoc?.line;
      if (line == null) continue;
      let perFile = byFile.get(mod.absPath);
      if (!perFile) byFile.set(mod.absPath, (perFile = new Map()));
      perFile.set(line, { name: fn.name, modes: fn.inspect.modes });
    }
  }
  return byFile;
}

// The FUNCTION_DECL carrying an `inspect` marker, reaching through the export
// wrappers the same way the attribute's own parse-time validation does.
function inspectedFn(decl) {
  if (!decl || typeof decl !== "object") return null;
  if (decl.kind === "FUNCTION_DECL") return decl.inspect ? decl : null;
  if (decl.kind === "EXPORT_DECL") return inspectedFn(decl.decl);
  if (decl.kind === "EXPORT_C_FUNCTION_DECL") return inspectedFn(decl.fn);
  return null;
}

// ---------- 2. the substrate -------------------------------------------------

// Cache of built substrates, one entry per document. The server drops entries
// on didChange, matching how it drops `doc.analysis`.
export class SubstrateCache {
  constructor() {
    this.entries = new Map(); // entry absPath -> built substrate
  }

  invalidate(absPath) {
    if (absPath == null) this.entries.clear();
    else this.entries.delete(absPath);
  }

  // Build (or return) the substrate for the program rooted at `entryAbsPath`.
  // Never throws: a codegen failure comes back as `{ error }` so the hover can
  // say why instead of the request dying.
  get(entryAbsPath, overlays) {
    const hit = this.entries.get(entryAbsPath);
    if (hit) return hit;
    const built = buildSubstrate(entryAbsPath, overlays);
    this.entries.set(entryAbsPath, built);
    return built;
  }
}

// Run the driver's pre-codegen pipeline over a throwaway analysis and index
// the IR that falls out. Returns { ir, irIndex, error }.
export function buildSubstrate(entryAbsPath, overlays = new Map()) {
  let analysis;
  try {
    analysis = analyze(entryAbsPath, overlays);
  } catch (err) {
    return { ir: null, irIndex: null, error: `analysis failed: ${err.message}` };
  }
  const hardErrors = analysis.diagnostics.filter((d) => d.severity === 1);
  if (hardErrors.length > 0) {
    // Codegen over a program that does not typecheck produces nonsense or
    // throws. Say so plainly - "fix the errors first" is a better hover than a
    // stack trace, and the squiggles already show WHERE.
    return {
      ir: null,
      irIndex: null,
      error: `program has ${hardErrors.length} error${hardErrors.length === 1 ? "" : "s"} - IR is only available once it compiles`,
    };
  }
  try {
    // The driver runs this between typecheck and codegen; skipping it would
    // show module-level `@precompile` consts as runtime initialization that a
    // real build folds away.
    runComptimePass(analysis.modules, { programState: analysis.programState });
    const { ir } = codegenProgram(
      analysis.modules,
      analysis.moduleEnv,
      analysis.programState,
    );
    return { ir, irIndex: buildIrIndex(ir), error: null };
  } catch (err) {
    return { ir: null, irIndex: null, error: `codegen failed: ${err.message}` };
  }
}

// Lower already-built IR to assembly and index it. Separate from
// buildSubstrate, and called only when a function actually asks for `asm`,
// because this is the one step that shells out to clang.
//
// -O0 to match what the driver builds with (yoopiler.js passes `-g -O0`). At
// higher levels the function you are looking at may be inlined into its caller
// or deleted outright, and there would be nothing honest to show.
export function buildAsmSubstrate(ir) {
  if (!ir) return { asmIndex: null, error: "no IR to lower" };
  let clang;
  try {
    clang = resolveClang();
  } catch (err) {
    return { asmIndex: null, error: `clang not available: ${err.message}` };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoop-substrate-"));
  try {
    const irPath = path.join(dir, "substrate.ll");
    const asmPath = path.join(dir, "substrate.s");
    fs.writeFileSync(irPath, ir, "utf8");
    execFileSync(
      clang,
      ["-S", "-O0", "-g", ...windowsClangArgs(), irPath, "-o", asmPath],
      { stdio: "pipe", env: clangEnv(), timeout: 30_000 },
    );
    const asm = fs.readFileSync(asmPath, "utf8");
    return { asmIndex: buildAsmIndex(asm), error: null };
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).trim().split("\n")[0] : err.message;
    return { asmIndex: null, error: `clang -S failed: ${detail}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Assembly for an already-built substrate, lowered on first request and then
// memoized on the substrate itself - so it shares the substrate's lifetime and
// is dropped by the same didChange that drops the substrate. Most `@inspect`
// functions ask for `ir` only, and those never pay for a clang process.
export function asmFor(substrate) {
  if (!substrate) return { asmIndex: null, error: "no substrate" };
  if (!substrate.asm) substrate.asm = buildAsmSubstrate(substrate.ir);
  return substrate.asm;
}

// ---------- 3. putting them together ----------------------------------------

// What to show for a source position, or null if the position is not inside an
// `@inspect`ed function.
//
// `startLine` / `endLine` are 1-based inclusive source lines - one line for a
// hover, a span for a selection.
//
// Returns:
//   { name, modes, declLine, sections: [{ mode, refs, index, error }] }
export function substrateAt(ctx, absPath, startLine, endLine = startLine) {
  const marked = collectInspectFunctions(ctx.modules).get(absPath);
  if (!marked || marked.size === 0) return null;

  // Which marked function contains the cursor?
  const substrate = ctx.substrate;
  let declLine = null;
  if (substrate?.irIndex) {
    // Precise: the IR index knows where each function's code actually ends,
    // so a cursor past the closing brace correctly matches nothing.
    const fn = functionForSource(substrate.irIndex, absPath, startLine);
    if (!fn || !marked.has(fn.declLine)) return null;
    declLine = fn.declLine;
  } else {
    // Degraded - codegen failed, so there is no index to ask. Fall back to the
    // nearest marked declaration at or above the cursor. This can over-claim
    // past the end of a function, which is acceptable here because every
    // section it produces is the same "here is why there is no IR" message.
    for (const line of marked.keys()) {
      if (line <= startLine && (declLine == null || line > declLine)) declLine = line;
    }
    if (declLine == null) return null;
  }

  const { name, modes } = marked.get(declLine);
  const sections = [];
  for (const mode of modes) {
    if (substrate?.error) {
      sections.push({ mode, refs: [], index: null, error: substrate.error });
      continue;
    }
    if (mode === "ir") {
      sections.push({
        mode,
        index: substrate.irIndex,
        refs: slice(substrate.irIndex, absPath, startLine, endLine),
        error: null,
      });
    } else if (mode === "asm") {
      const asm = asmFor(substrate);
      sections.push({
        mode,
        index: asm.asmIndex,
        refs: asm.asmIndex ? slice(asm.asmIndex, absPath, startLine, endLine) : [],
        error: asm.error,
      });
    }
  }
  return { name, modes, declLine, sections };
}

// ---------- 4. rendering -----------------------------------------------------

const MODE_LABEL = { ir: "LLVM IR", asm: "x86-64 asm (-O0)" };
// Hover popups do not scroll well; past this many instructions the hover says
// how many were elided and points at the panel, which does scroll.
const HOVER_MAX_INSTRUCTIONS = 24;

// Markdown for a hover over [startLine, endLine] of `absPath`. Returns null
// when there is nothing to say.
export function renderSubstrateHover(view, startLine, endLine = startLine) {
  if (!view) return null;
  const span =
    endLine > startLine ? `lines ${startLine}-${endLine}` : `line ${startLine}`;
  const out = [`**@inspect** \`${view.name}\` - ${span}`];

  for (const section of view.sections) {
    const label = MODE_LABEL[section.mode] ?? section.mode;
    if (section.error) {
      out.push("", `_${label}: ${section.error}_`);
      continue;
    }
    if (section.refs.length === 0) {
      out.push("", `_${label}: this line produced no instructions._`);
      continue;
    }
    const shown = section.refs.slice(0, HOVER_MAX_INSTRUCTIONS);
    const body = renderRefs(section.index, shown, section.mode);
    const elided = section.refs.length - shown.length;
    out.push(
      "",
      `${label} - ${section.refs.length} instruction${section.refs.length === 1 ? "" : "s"}`,
      "```" + (section.mode === "ir" ? "llvm" : "asm"),
      body,
      "```",
    );
    if (elided > 0) {
      out.push(`_${elided} more - open the ${label} panel to see all of them._`);
    }
    if (section.mode === "ir" && shown.some((r) => r.inferred)) {
      // Be honest about which lines are a guess. See irIndex.js: codegen does
      // not tag pure arithmetic with !dbg, so those are attributed by
      // inference rather than read off the metadata.
      out.push(`_Lines marked \`~\` are inferred: codegen does not attach debug locations to pure arithmetic._`);
    }
  }
  return out.join("\n");
}

// Render a set of instruction refs as text, grouping by basic block so a
// reader can see when one source line produced code in several places.
export function renderRefs(index, refs, mode) {
  const lines = [];
  let block = null;
  for (const ref of refs) {
    if (ref.block !== block) {
      block = ref.block;
      if (block) lines.push(`${block}:`);
    }
    const marker = mode === "ir" && ref.inferred ? "~ " : "  ";
    lines.push(`${marker}${index.lines[ref.irLine].trim()}`);
  }
  return lines.join("\n");
}

// The full text of a function in one substrate, for the side panel, plus the
// panel line to highlight for a given source line.
//
// Returns { text, lines, highlight: number[] } with `highlight` holding
// 0-based indices into `lines`.
export function renderFunctionView(index, absPath, declLine, focusLine) {
  if (!index) return null;
  const fn = index.functions.find(
    (f) => f.file === absPath && f.declLine === declLine,
  );
  if (!fn) return null;
  const lines = index.lines.slice(fn.startLine, fn.endLine + 1);
  const highlight = [];
  if (focusLine != null) {
    for (const ref of slice(index, absPath, focusLine)) {
      const rel = ref.irLine - fn.startLine;
      if (rel >= 0 && rel < lines.length) highlight.push(rel);
    }
  }
  return { symbol: fn.symbol, name: fn.name, text: lines.join("\n"), lines, highlight };
}
