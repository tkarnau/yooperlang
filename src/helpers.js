export function posToSourceLocation(src, pos, length) {
    const lineCount = src.slice(0, pos).split("\n");
    const line = lineCount.length;
    const column = pos - src.lastIndexOf("\n", pos - 1);
    const loc = { pos, line, column };
    if (length !== undefined) loc.length = length;
    return loc;
}

// Render a single diagnostic as a multi-line string suitable for stderr.
// Shape:
//   <file>:<line>:<col>: <message>
//      |
//   42 |     let x: E = E.NotThere;
//      |                  ^^^^^^^^
// `loc` may be undefined (we then emit just the message). `src` may be the
// empty string if we don't have it; in that case the code frame is skipped.
export function formatDiagnostic({ filePath, src, loc, message }) {
    if (!loc || typeof loc.line !== "number") {
        return filePath ? `${filePath}: ${message}` : message;
    }
    const head = `${filePath ?? "<unknown>"}:${loc.line}:${loc.column}: ${message}`;
    if (!src) return head;
    const lines = src.split("\n");
    const lineText = lines[loc.line - 1] ?? "";
    const gutter = String(loc.line);
    const pad = " ".repeat(gutter.length);
    const caretCol = Math.max(0, loc.column - 1);
    // The frame shows ONE line, so a span that runs past its end has to be
    // clipped or the carets run off into empty space. Multi-line spans are
    // real (the unreachable-code warning covers a whole dead tail), and
    // before this a `length` of 200 drew 200 carets under a 30-column line.
    const caretLen = Math.max(
        1,
        Math.min(loc.length ?? 1, Math.max(1, lineText.length - caretCol)),
    );
    const caret = " ".repeat(caretCol) + "^".repeat(caretLen);
    return [
        head,
        `${pad} |`,
        `${gutter} | ${lineText}`,
        `${pad} | ${caret}`,
    ].join("\n");
}

