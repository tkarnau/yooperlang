export function isDigit(ch) {
  const chCode = ch.charCodeAt(0);
  return (chCode >= 48 && chCode <= 57);
}

export function isAlpha(ch) {
  const chCode = ch.charCodeAt(0);
  return ((chCode >= 97 && chCode <= 122) || (chCode >= 65 && chCode <= 90));
}

export function isAlphaNumOr_(ch) {
  return (
    isAlpha(ch) ||
    isDigit(ch) ||
    (ch === '_')
  );
}

const whitespaceCharCodes = [32, 9, 13, 10];

export function isWhitespace(ch) {
  return whitespaceCharCodes.includes(ch.charCodeAt(0));
}

export function scanDigitsEnd(src, start) {
  let p = start;
  while (p < src.length) {
    let ch = src[p];
    if (isDigit(ch)) {
      p++;
    } else {
      return p;
    }
  }

  return p;
}

export function createErrorPointingOutput(src, pos, padding) {
  const start = Math.max(pos - padding, 0);
  const end = Math.min(pos + padding, src.length - 1);

  const line1 = src.substring(start, end);
  const line2 = "^".padStart(padding, " ").padEnd(padding * 2, " ");
  return [line1, line2].join("\n");
}