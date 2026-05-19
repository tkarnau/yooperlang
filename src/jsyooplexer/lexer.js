// lexer for yooplang, first pass in JS

import {
  isDigit,
  isAlpha,
  isAlphaNumOr_,
  isWhitespace,
  scanDigitsEnd,
  scanIdentityToEnd,
  scanStringLiteralEnd,
  scanHexDigitsAndUnderscores,
  scanBinDigitsAndUnderscores,
  scanOctDigitsAndUnderscores,
  scanDecDigitsAndUnderscores,
} from "./charFns.js";
import { skipWhitespace } from "./charEaters.js";

// this is the list of all the kinds of things that could be tokens
// tokens have different meanings in different contexts, but this will
// be an exhaustive list of potential tokens

// note: ONLY adding the bare minimum from test input files. Expanding as we go.
// the tags will eventually be listed out of order, and that's fine for now
export const TokenTags = {
  // atoms
  eof: 0,
  ident: 1, // not a keyword
  intLiteral: 2,
  strLiteral: 3, // included wrapping quote characters
  templateLiteral: 36, // backtick-quoted, may contain ${...} interpolations
  floatLiteral: 37,

  // keywords
  let: 4,
  function: 14,
  const: 15,
  return: 16,
  if: 17,
  else: 18,
  while: 19,
  for: 20,
  type: 38,
  import: 41,
  export: 42,
  extern: 43,
  from: 44,
  as: 45,
  library: 46,
  dotdotdot: 47, // for variadic params and rest patterns
  ref: 48,
  break: 49,
  continue: 50,
  lbracket: 51, // [
  rbracket: 52, // ]
  true: 53,
  false: 54,
  trait: 55,
  implements: 56,
  self: 57,
  extends: 58,
  kind: 59,
  // kind stuff
  appliesTo: 60,
  requires: 61,
  mustCall: 62,
  ownsBlock: 63,
  beforeScopeEnd: 64,
  binding: 65,
  // phase 6.2: escape and sharing
  mustNotEscape: 66,
  mustNotShare: 67,
  forbids: 68,
  scope: 69,
  acrossScopes: 70,
  parameter: 71,
  field: 72,
  io: 73,
  globalState: 74,
  // phase 6.3: task/concurrency
  task: 75,
  wait: 76,
  joined: 77,
  pooled: 78,

  // punctuation / operators
  eq: 5,
  semicolon: 6,
  lparen: 7,
  rparen: 8,
  discard: 9,
  lcurly: 10,
  rcurly: 11,
  colon: 12,
  comma: 13,
  eqeq: 21,
  neq: 22,
  lte: 23,
  gte: 24,
  lt: 25,
  gt: 26,
  andand: 27,
  oror: 28,
  lshift: 29,
  rshift: 30,
  plus: 31,
  minus: 32,
  mult: 33,
  divide: 34,
  modulus: 35,
  dot: 39,
  question: 40,
};

export const inverseTokenTags = Object.entries(TokenTags).reduce(
  (a, [k, v]) => {
    a[v] = k;
    return a;
  },
  {},
);

// sorted longest to shortest so we can match multi-char without context
export const tokenScanList = [
  { str: "(", tag: TokenTags.lparen },
  { str: ")", tag: TokenTags.rparen },
  { str: ";", tag: TokenTags.semicolon },
  { str: "=", tag: TokenTags.eq },
  { str: "{", tag: TokenTags.lcurly },
  { str: "}", tag: TokenTags.rcurly },
  { str: ":", tag: TokenTags.colon },
  { str: ",", tag: TokenTags.comma },
  { str: "?", tag: TokenTags.question },
  { str: "==", tag: TokenTags.eqeq },
  { str: "!=", tag: TokenTags.neq },
  { str: "<=", tag: TokenTags.lte },
  { str: ">=", tag: TokenTags.gte },
  { str: "<", tag: TokenTags.lt },
  { str: ">", tag: TokenTags.gt },
  { str: "&&", tag: TokenTags.andand },
  { str: "||", tag: TokenTags.oror },
  { str: "<<", tag: TokenTags.lshift },
  { str: ">>", tag: TokenTags.rshift },
  { str: "+", tag: TokenTags.plus },
  { str: "-", tag: TokenTags.minus },
  { str: "*", tag: TokenTags.mult },
  { str: "/", tag: TokenTags.divide },
  { str: "%", tag: TokenTags.modulus },
  { str: ".", tag: TokenTags.dot },
  { str: "...", tag: TokenTags.dotdotdot },
  { str: "[", tag: TokenTags.lbracket },
  { str: "]", tag: TokenTags.rbracket },
].toSorted((a, b) => b.str.length - a.str.length);

const keywordTagList = {
  let: TokenTags.let,
  function: TokenTags.function,
  const: TokenTags.const,
  return: TokenTags.return,
  if: TokenTags.if,
  else: TokenTags.else,
  while: TokenTags.while,
  for: TokenTags.for,
  type: TokenTags.type,
  import: TokenTags.import,
  export: TokenTags.export,
  extern: TokenTags.extern,
  from: TokenTags.from,
  as: TokenTags.as,
  library: TokenTags.library,
  ref: TokenTags.ref,
  break: TokenTags.break,
  continue: TokenTags.continue,
  true: TokenTags.true,
  false: TokenTags.false,
  trait: TokenTags.trait,
  implements: TokenTags.implements,
  self: TokenTags.self,
  extends: TokenTags.extends,
  kind: TokenTags.kind,
  appliesTo: TokenTags.appliesTo,
  requires: TokenTags.requires,
  mustCall: TokenTags.mustCall,
  ownsBlock: TokenTags.ownsBlock,
  beforeScopeEnd: TokenTags.beforeScopeEnd,
  binding: TokenTags.binding,
  mustNotEscape: TokenTags.mustNotEscape,
  mustNotShare: TokenTags.mustNotShare,
  forbids: TokenTags.forbids,
  scope: TokenTags.scope,
  acrossScopes: TokenTags.acrossScopes,
  parameter: TokenTags.parameter,
  field: TokenTags.field,
  io: TokenTags.io,
  globalState: TokenTags.globalState,
  task: TokenTags.task,
  wait: TokenTags.wait,
  joined: TokenTags.joined,
  pooled: TokenTags.pooled,
  _: TokenTags.discard, // bare underscores are discarded
};

// ********* scanners (probably should pull these out)

// basically just scans the string until it sees an unescaped matching quote character.
// needs to be more robust, but works for now.

// *********** end scanners

// basic objects
function Token() {
  this.tag = 0;
  this.start = 0;
  this.length = 0;
  this.intVal = 0;
  this.floatVal = 0.0;
}

function LexResult() {
  this.token = new Token();
  this.nextPos = 0;
  this.err = "";
}
// end basic objects

function lexIdentifierOrKeyword(src, pos) {
  let res = new LexResult();
  let end = scanIdentityToEnd(src, pos);
  let len = end - pos;
  res.token.start = pos;
  res.nextPos = end;
  res.token.length = len;

  // res.token.tag = keyword_tag
  const value = src.substring(pos, end);
  if (keywordTagList[value]) {
    res.token.tag = keywordTagList[value];
  } else {
    res.token.tag = TokenTags.ident;
  }

  return res;
}

function lexNumericLiteral(src, pos) {
  let start = pos;
  let isFloat = false;
  let base = 10;
  let digitsStart = pos;
  let end = digitsStart;

  // check if we have an 0x prefix
  if (src[pos] === '0' && pos + 1 < src.length) {
    let next = src[pos + 1].toLowerCase();
    if (next === 'x') {
      base = 16;
      pos += 2;
      digitsStart = pos;
      end = scanHexDigitsAndUnderscores(src, pos);
    } else if (next === 'b') {
      base = 2;
      pos += 2;
      digitsStart = pos;
      end = scanBinDigitsAndUnderscores(src, pos);
    } else if (next === 'o') {
      base = 8;
      pos += 2;
      digitsStart = pos;
      end = scanOctDigitsAndUnderscores(src, pos);
    } else {
      // plain decimal number starting with 0
      end = scanDecDigitsAndUnderscores(src, pos);
    }
  } else {
    end = scanDecDigitsAndUnderscores(src, pos);
  }

  // float fractional part - only legal in base10
  if (base === 10 && end < src.length && src[end] === '.' && isDigit(src[end+1])) {
    isFloat = true;
    end++;
    end = scanDecDigitsAndUnderscores(src, end);
  }

  // float exponent - only legal in base10
  if (base === 10 && end < src.length && src[end]?.toLowerCase() === 'e') {
    isFloat = true;
    end++;
    if (src[end] === '+' || src[end] === '-') {
      end++;
    }
    end = scanDecDigitsAndUnderscores(src, end);
  }

  // parse the numeric value
  let res = new LexResult()
  const strippedDigits = src.substring(digitsStart, end).replaceAll("_", "");
  if (isFloat) {
    let val = parseFloat(strippedDigits);
    res.token.tag = TokenTags.floatLiteral;
    res.token.floatVal = val;
  } else {
    let val = parseInt(strippedDigits, base);
    res.token.tag = TokenTags.intLiteral;
    res.token.intVal = val;
  }

  res.token.start = start;
  res.token.length = end - start;
  res.nextPos = end;

  return res;
}

/*
**************************
This is the main logic function for lexing input source code into tokens, it is called in a loop until the input file is consumed, usually. It calls the eater functions.
It returns a LexResult structure/obj
For now I'm replicating the v1 yooper lexer but in a js fashion
so that it is a little more human readable. I had moved too quickly to bootstrapping and the lexer logic was very hard to understand, even with LLM help.
**************************
*/
export function lexNext(src, pos) {
  let res = new LexResult();
  let p = skipWhitespace(src, pos);

  // eof
  if (p >= src.length) {
    res.token.tag = TokenTags.eof;
    res.token.start = p;
    res.nextPos = p;

    return res;
  }

  let ch = src[p];

  // tokenscanlist by length longest to shortest
  // so that => is not mistakenly set as = and then >

  // is a common language token?
  for (let i = 0; i < tokenScanList.length; i++) {
    let tokenScanObj = tokenScanList[i];
    if (p + (tokenScanObj.str.length - 1) >= src.length) {
      continue; // definitely not this one, not enough string left
    }

    if (src.substring(p, p + tokenScanObj.str.length) === tokenScanObj.str) {
      res.token.tag = tokenScanObj.tag;
      res.token.length = tokenScanObj.str.length;
      res.nextPos = p + tokenScanObj.str.length;

      return res;
    }
  }

  // string literal
  if (ch === '"' || ch === "'" || ch === "`") {
    let end = scanStringLiteralEnd(src, p);
    if (end === -1) {
      res.err = `unterminated string literal at position ${p}`;
      res.token.start = p;
      res.token.length = 1;
      res.nextPos = p + 1;
      return res;
    }
    res.token.tag =
      ch === "`" ? TokenTags.templateLiteral : TokenTags.strLiteral;
    res.token.start = p;
    res.token.length = end - p;
    res.nextPos = end;
    return res;
  }

  // integer literal
  if (isDigit(ch)) {
    return lexNumericLiteral(src, p);
  }

  // identifiers or keywords
  if (isAlpha(ch) || ch === "_") {
    return lexIdentifierOrKeyword(src, p);
  }

  // if we made it here, we're crashing...

  // unrecognized character - throwaway res with an err
  res.err = `unrecognized character at position ${p}`;

  return res;
}

// runs lexNext to EOF, returning the token list. EOF token is not included.
// throws on lexer errors so tests fail fast with the message.
export function tokenize(src) {
  const tokens = [];
  let pos = 0;
  // failsafe in case lexNext ever fails to advance
  let iters = 0;
  const maxIters = src.length * 2 + 100;
  while (iters++ < maxIters) {
    const { token, nextPos, err } = lexNext(src, pos);
    if (err) {
      throw new Error(`lexer error at ${nextPos}: ${err}`);
    }
    if (token.tag === TokenTags.eof) return tokens;
    tokens.push(token);
    pos = nextPos;
  }
  throw new Error("tokenize: exceeded iteration failsafe");
}
