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
// A FLOATLITERAL carries its value as `float=<16 hex digits>` - the IEEE-754
// bit pattern, not a decimal rendering. The dump skipped float values entirely
// until 2026-08-13, on the theory that "this side parses with parseFloat and
// renders with JS number formatting, the bootstrap renders through the C
// runtime" made them incomparable. The formatting is incomparable; the VALUE is
// not, and printing the bits sidesteps the formatting question completely. The
// bootstrap's decoder was off by an ulp for a quarter of the literals it saw
// the whole time nobody was looking.
//
// One thing is still deliberately NOT in the dump, because it really is not
// comparable across the two implementations:
//
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
  if (t.tag === TokenTags.floatLiteral) {
    return `${head} float=${floatBitsHex(t.floatVal)}`;
  }
  const carriesInt =
    t.tag === TokenTags.intLiteral || t.tag === TokenTags.charLiteral;
  if (!carriesInt) return head;
  const val =
    t.intVal > Number.MAX_SAFE_INTEGER ? "unsafe" : String(t.intVal);
  return `${head} int=${val}`;
}

// The 64 bits of a double as 16 uppercase hex digits. Matches
// bootstrap/src/utils/float_bits.yoop, which reaches the same bytes through
// memcpy because the language has no bitcast.
const floatBitsView = new DataView(new ArrayBuffer(8));
function floatBitsHex(x) {
  floatBitsView.setFloat64(0, x);
  return (
    "0x" + floatBitsView.getBigUint64(0).toString(16).toUpperCase().padStart(16, "0")
  );
}
