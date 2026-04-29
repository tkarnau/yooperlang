export function isHexDigit(ch) {
  const chCode = ch.charCodeAt(0);
  return (
    (chCode >= 48 && chCode <= 57) ||
    (chCode >= 97 && charCode <= 102) ||
    (chCode >= 65 && chCode <= 70)
  ); //digit or a-fA-F
}

export function isBinDigit(ch) {
  const chCode = ch.charCodeAt(0);
  return (chCode === 48 || chCode === 49); // 0, 1
}

export function isOctDigit(ch) {
  const chCode = ch.charCodeAt(0);
  return (chCode >= 48 && chCode <= 55); // 0-7
}

export function isDigit(ch) {
  const chCode = ch.charCodeAt(0);
  return chCode >= 48 && chCode <= 57;
}

export function isAlpha(ch) {
  const chCode = ch.charCodeAt(0);
  return (chCode >= 97 && chCode <= 122) || (chCode >= 65 && chCode <= 90);
}

export function isAlphaNumOr_(ch) {
  return isAlpha(ch) || isDigit(ch) || ch === "_";
}

const whitespaceCharCodes = [32, 9, 13, 10];

export function isWhitespace(ch) {
  return whitespaceCharCodes.includes(ch.charCodeAt(0));
}

// common scanner for contiguous characters that satisfy at least one predicate
function scanCharPredicates(src, start, predicates) {
  let p = start;
  while (p < src.length) {
    let ch = src[p];
    if (predicates.some(pred => pred(ch, src, start, p))) {
      p++;
    } else {
      return p;
    }
  }
  
  return p;
}

// stupid but avoids a lot of anon funcs
function isValidUnderscore(ch, src, start, p) {
  // todo, ensure _ is between digits
  return ch === "_";
}


export function scanDigitsEnd(src, start) {
  return scanCharPredicates(src, start, [isDigit]);
}

export function scanDecDigitsAndUnderscores(src, start) {
  return scanCharPredicates(src, start, [isDigit, isValidUnderscore]);
}

export function scanHexDigitsAndUnderscores(src, start) {
  return scanCharPredicates(src, start, [isHexDigit, isValidUnderscore]);
}

export function scanBinDigitsAndUnderscores(src, start) {
  return scanCharPredicates(src, start, [isBinDigit, isValidUnderscore]);
}

export function scanOctDigitsAndUnderscores(src, start) {
  return scanCharPredicates(src, start, [isOctDigit, isValidUnderscore]);
}

export function scanStringLiteralEnd(src, start) {
  const quote = src[start];
  let p = start + 1;
  while (p < src.length) {
    const ch = src[p];
    if (ch === "\\") {
      p += 2;
    } else if (ch === quote) {
      return p + 1;
    } else {
      p++;
    }
  }
  return -1;
}

export function scanIdentityToEnd(src, start) {
  let p = start;
  while (p < src.length) {
    const ch = src[p];
    if (isAlphaNumOr_(ch)) {
      p++;
    } else {
      break;
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
