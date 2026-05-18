import { isAlpha, isAlphaNumOr_, isDigit, isWhitespace } from './charFns.js';

// functions that eat the source code and assist forward movement while tokenizing

export function skipLineComment(src, pos) {
  let p = pos;
  while (p < src.length) {
    let ch = src.charCodeAt(p);
    if (ch === 10) { // new line
      return p;
    }
    p++;
  }

  return p;
}

export function skipWhitespace(src, pos) {
  let p = pos;

  // iterate over each character until hitting non-whitespace and non comment lines
  while (p < src.length) {
    let ch = src[p];
    if (isWhitespace(ch)) {
      p++;
    } else { // check for comments
      if (p + 1 < src.length) {
        let nextCh = src[p + 1];
        if (ch === '/' && nextCh == '/') { // forward slashes '//'
          p = skipLineComment(src, p);

          // continue skipping whitespace
          return skipWhitespace(src, p);
        }
        if (ch === '/' && nextCh === '*') { // block comment '/* */'
          p += 2; // skip the '/*'
          let blockCommentStack = 1; // support nested block comments
          while (p + 1 < src.length) {
            if (src[p] === '*' && src[p + 1] === '/') {
              p += 2; // skip the '*/'
              blockCommentStack--;
              if (blockCommentStack === 0) {
                break;
              }
            } else if (src[p] === '/' && src[p + 1] === '*') {
              p += 2; // skip the '/*'
              blockCommentStack++;
            }
            p++;
          }

          // continue skipping whitespace
          return skipWhitespace(src, p);
        }
      }

      // done skipping whitespace
      return p;
    }
  }

  // hit end of source...
  return p;
}