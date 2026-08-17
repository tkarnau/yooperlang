// Queries over a source-to-instruction index.
//
// buildIrIndex (irIndex.js) and buildAsmIndex (asmIndex.js) produce the same
// shape - `{ lines, functions, bySource }` - because the question you ask of
// them is identical: "what did this source line become". The two substrates
// differ only in how that mapping has to be RECOVERED (per-instruction !dbg
// metadata vs stateful .loc directives), so the recovery lives in those two
// modules and everything downstream of it lives here, used by both.

// The function whose `define` covers a given source position, or null. Matches
// on the source file plus the subprogram's declaration line, so it finds the
// function by where it was WRITTEN rather than by name - which is what lets a
// caller go from "cursor is in fn X" to "here is X's IR" without mangling.
export function functionForSource(index, file, srcLine) {
  const perFile = index.bySource.get(file);
  if (!perFile) return null;
  // The subprogram line is the `function` keyword's line; a body line is
  // always greater. Pick the latest declaration at or before srcLine that
  // also actually has instructions attributed at/after it.
  let best = null;
  for (const fn of index.functions) {
    if (fn.file !== file || fn.declLine == null) continue;
    if (fn.declLine > srcLine) continue;
    if (best == null || fn.declLine > best.declLine) best = fn;
  }
  if (!best) return null;
  // Guard against picking a function the cursor is merely BELOW (past its
  // closing brace) by requiring the cursor to sit within the span the
  // function's own instructions cover.
  let maxLine = best.declLine;
  for (const [line, refs] of perFile) {
    if (refs.some((r) => r.fn === best.symbol)) {
      if (line > maxLine) maxLine = line;
    }
  }
  return srcLine <= maxLine ? best : null;
}

// Every instruction attributed to `srcLine` (or to any line in
// [startLine, endLine] when a range is given), in IR emission order.
export function slice(index, file, startLine, endLine = startLine) {
  const perFile = index.bySource.get(file);
  if (!perFile) return [];
  const out = [];
  for (let line = startLine; line <= endLine; line++) {
    for (const ref of perFile.get(line) ?? []) out.push({ ...ref, srcLine: line });
  }
  out.sort((a, b) => a.irLine - b.irLine);
  return out;
}
