// Layer 1 parity target: a deterministic, line-oriented token dump.
//
// The bootstrap lexer emits the identical format from
// bootstrap/src/lex/dump.yoop, and src/parity.test.js diffs the two. Format is
// one token per line, ending with an explicit EOF line:
//
//   FUNCTION 0 8
//   IDENT 9 3
//   INTLITERAL 15 4 int=1000
//   EOF 20 0
//
// Tag spelling is the bootstrap's SCREAMING form, which is just this side's
// camelCase uppercased - that mapping is total in both directions.
//
// Two things are deliberately NOT in the dump, because they are not comparable
// across the two implementations rather than because they do not matter:
//
//   * float values. This side parses with parseFloat and renders with JS
//     number formatting; the bootstrap renders through the C runtime's
//     float-to-string. FLOATLITERAL still contributes its tag and span.
//   * the exact value of an int literal past 2^53. parseInt here is a double,
//     while the bootstrap accumulates a real uint64 - so on FNV-1a's offset
//     basis this side reads ...655000 and the bootstrap reads ...656037, and
//     the bootstrap is the correct one. Both sides print `int=unsafe` above the
//     threshold so the gap is declared in the dump rather than showing up as a
//     mystery diff.
//
// Spans are also only comparable for ASCII source: `start`/`length` are JS
// string indices here and byte offsets in the bootstrap.
import { lexNext, TokenTags } from "./jsyooplexer/lexer.js";

export function dumpTokens(src) {
  const lines = [];
  let pos = 0;
  // Walks lexNext directly rather than calling tokenize(), which drops the
  // trailing EOF. The layer contract says the stream is EOF-terminated, so the
  // dump keeps it.
  for (;;) {
    const { token, nextPos, err } = lexNext(src, pos);
    if (err) throw new Error(`lexer error at ${nextPos}: ${err}`);
    lines.push(formatToken(token));
    if (token.tag === TokenTags.eof) break;
    pos = nextPos;
  }
  return lines.join("\n") + "\n";
}

function formatToken(t) {
  const head = `${t.tag.toUpperCase()} ${t.start} ${t.length}`;
  const carriesInt =
    t.tag === TokenTags.intLiteral || t.tag === TokenTags.charLiteral;
  if (!carriesInt) return head;
  const val =
    t.intVal > Number.MAX_SAFE_INTEGER ? "unsafe" : String(t.intVal);
  return `${head} int=${val}`;
}
