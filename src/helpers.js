export function posToSourceLocation(src, pos) {
    const lineCount = src.slice(0, pos).split("\n");
    const line = lineCount.length;
    const column = pos - src.lastIndexOf("\n", pos - 1);
    return { pos, line, column };
}

