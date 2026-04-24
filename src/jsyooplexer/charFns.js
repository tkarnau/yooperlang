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