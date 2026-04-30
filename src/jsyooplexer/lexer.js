// lexer for yooplang, first pass in JS

// usage: node ./lexer.js <inputfile.yoop> (outputs to stdout)
//    or if the little test mode flag is true, can just iterate that way for now
//    without an input file

import { parseArgs } from "util";
import fs from "fs";
import {
  isDigit,
  isAlpha,
  isAlphaNumOr_,
  isWhitespace,
  scanDigitsEnd,
  createErrorPointingOutput,
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
};

export const inverseTokenTags = Object.entries(TokenTags).reduce(
  (a, [k, v]) => {
    a[v] = k;
    return a;
  },
  {},
);

export const tokenScanList = [
  { str: "(", tag: TokenTags.lparen },
  { str: ")", tag: TokenTags.rparen },
  { str: ";", tag: TokenTags.semicolon },
  { str: "=", tag: TokenTags.eq },
  { str: "{", tag: TokenTags.lcurly },
  { str: "}", tag: TokenTags.rcurly },
  { str: ":", tag: TokenTags.colon },
  { str: ",", tag: TokenTags.comma },
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
  if (base === 10 && src[end] === '.' && isDigit(src[end+1])) {
    isFloat = true;
    end++;
    end = scanDecDigitsAndUnderscores(src, end);
  }

  // float exponent - only legal in base10
  if (base === 10 && src[end].toLowerCase() == 'e') {
    isFloat = true;
    end++;
    if (src[end] === '+' || src[end] === '-') {
      end++;
    }
    end = scanDecDigitsAndUnderscores(src, end);
  }

  // parse the numeric value
  let res = new LexResult()
  const strippedDigits = src.substring(digitsStart, end).replace("_", "");
  if (isFloat) {
    let val = parseFloat(strippedDigits);
    res.token.tag = TokenTags.floatLiteral;
    res.token.floatVal = val;
  } else {
    let val = parseInt(strippedDigits);
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

const testMode = true;

// can go away, but will leave around to iterate on the lexer independently, if needed...
// todo change to testLexer like we did with the parser and have some basic tests in here...
export function testLexer() {
  // initial test
  const sourceStr = `
      function add(a: int32, b: int32): int32 {
        return a + b;
      }

      function main(): void {
        const x: int32 = 10;
        const y: int32 = 20;
        const sum: int32 = add(x, y);

        if (sum >= 25) {
          let count: int32 = 0;
          while (count < 3) {
            count = count + 1;
          }
        } else {
          _ = sum;
        }
      }
    `;

  let pos = 0;
  let currIter = 0;
  let failsafe = 100_000_000;
  const resultTokens = [];
  while (pos <= sourceStr.length && currIter++ < failsafe) {
    const { token, nextPos, err } = lexNext(sourceStr, pos);

    if (err) {
      console.log("err", err);
      console.log(createErrorPointingOutput(sourceStr, nextPos, 15));
      process.exit(1);
    }

    if (token.tag === TokenTags.eof) break; // we're done

    pos = nextPos;
    resultTokens.push(token);
  }

  const results = JSON.stringify(resultTokens);
  // if making changes to the lexer, verify and update this expecation:

  // console.log(JSON.stringify(results));
  const expectedResults =
    '[{\"tag\":14,\"start\":7,\"length\":8,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":16,\"length\":3,\"intVal\":0,\"floatVal\":0},{\"tag\":7,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":20,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":12,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":23,\"length\":5,\"intVal\":0,\"floatVal\":0},{\"tag\":13,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":30,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":12,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":33,\"length\":5,\"intVal\":0,\"floatVal\":0},{\"tag\":8,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":12,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":41,\"length\":5,\"intVal\":0,\"floatVal\":0},{\"tag\":10,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":16,\"start\":57,\"length\":6,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":64,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":31,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":68,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":6,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":11,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":14,\"start\":86,\"length\":8,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":95,\"length\":4,\"intVal\":0,\"floatVal\":0},{\"tag\":7,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":8,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":12,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":103,\"length\":4,\"intVal\":0,\"floatVal\":0},{\"tag\":10,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":15,\"start\":118,\"length\":5,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":124,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":12,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":127,\"length\":5,\"intVal\":0,\"floatVal\":0},{\"tag\":5,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":2,\"start\":135,\"length\":2,\"intVal\":10,\"floatVal\":0},{\"tag\":6,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":15,\"start\":147,\"length\":5,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":153,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":12,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":156,\"length\":5,\"intVal\":0,\"floatVal\":0},{\"tag\":5,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":2,\"start\":164,\"length\":2,\"intVal\":20,\"floatVal\":0},{\"tag\":6,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":15,\"start\":176,\"length\":5,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":182,\"length\":3,\"intVal\":0,\"floatVal\":0},{\"tag\":12,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":187,\"length\":5,\"intVal\":0,\"floatVal\":0},{\"tag\":5,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":195,\"length\":3,\"intVal\":0,\"floatVal\":0},{\"tag\":7,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":199,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":13,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":202,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":8,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":6,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":17,\"start\":215,\"length\":2,\"intVal\":0,\"floatVal\":0},{\"tag\":7,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":219,\"length\":3,\"intVal\":0,\"floatVal\":0},{\"tag\":24,\"start\":0,\"length\":2,\"intVal\":0,\"floatVal\":0},{\"tag\":2,\"start\":226,\"length\":2,\"intVal\":25,\"floatVal\":0},{\"tag\":8,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":10,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":4,\"start\":242,\"length\":3,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":246,\"length\":5,\"intVal\":0,\"floatVal\":0},{\"tag\":12,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":253,\"length\":5,\"intVal\":0,\"floatVal\":0},{\"tag\":5,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":2,\"start\":261,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":6,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":19,\"start\":274,\"length\":5,\"intVal\":0,\"floatVal\":0},{\"tag\":7,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":281,\"length\":5,\"intVal\":0,\"floatVal\":0},{\"tag\":25,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":2,\"start\":289,\"length\":1,\"intVal\":3,\"floatVal\":0},{\"tag\":8,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":10,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":306,\"length\":5,\"intVal\":0,\"floatVal\":0},{\"tag\":5,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":314,\"length\":5,\"intVal\":0,\"floatVal\":0},{\"tag\":31,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":2,\"start\":322,\"length\":1,\"intVal\":1,\"floatVal\":0},{\"tag\":6,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":11,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":11,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":18,\"start\":347,\"length\":4,\"intVal\":0,\"floatVal\":0},{\"tag\":10,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":9,\"start\":364,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":5,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":1,\"start\":368,\"length\":3,\"intVal\":0,\"floatVal\":0},{\"tag\":6,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":11,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0},{\"tag\":11,\"start\":0,\"length\":1,\"intVal\":0,\"floatVal\":0}]';

  console.assert(results === expectedResults, "lexer did not produce the expected result");

  console.log("lexer test completed");
}
