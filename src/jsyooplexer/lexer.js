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
} from "./charFns.js";
import { skipWhitespace } from "./charEaters.js";

// this is the list of all the kinds of things that could be tokens
// tokens have different meanings in different contexts, but this will
// be an exhaustive list of potential tokens

// note: ONLY adding the bare minimum from test input files. Expanding as we go.
// the tags will eventually be listed out of order, and that's fine for now
const TokenTags = {
  // atoms
  eof: 0,
  ident: 1, // not a keyword
  intLiteral: 2,
  strLiteral: 3, // included wrapping quote characters

  // keywords
  let: 4,
  // punctuation / operators
  eq: 5,
  semicolon: 6,
  lParen: 7,
  rParen: 8,
  discard: 9,
};

const inverseTokenTags = Object.entries(TokenTags).reduce((a, [k, v]) => {
  a[v] = k;
  return a;
}, {});

const tokenScanList = [
  { str: "(", tag: TokenTags.lParen },
  { str: ")", tag: TokenTags.rParen },
  { str: ";", tag: TokenTags.semicolon },
  { str: "=", tag: TokenTags.eq },
].toSorted((a, b) => b.str.length - a.str.length);

const keywordTagList = {
  let: TokenTags.let,
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

/*
**************************
This is the main logic function for lexing input source code into tokens, it is called in a loop until the input file is consumed, usually. It calls the eater functions.
It returns a LexResult structure/obj
For now I'm replicating the v1 yooper lexer but in a js fashion
so that it is a little more human readable. I had moved too quickly to bootstrapping and the lexer logic was very hard to understand, even with LLM help.
**************************
*/
function lexNext(src, pos) {
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
    res.token.tag = TokenTags.strLiteral;
    res.token.start = p;
    res.token.length = end - p;
    res.nextPos = end;
    return res;
  }

  // integer literal
  if (isDigit(ch)) {
    let end = scanDigitsEnd(src, p);
    let val = parseInt(src.substring(p, end));
    res.token.tag = TokenTags.intLiteral;
    res.token.start = p;
    res.token.length = end - p;
    res.token.intVal = val;
    res.nextPos = end;

    return res;
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

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      inputFile: { type: "string", short: "i" },
    },
    allowPositionals: true,
  });

  let sourceStr = "";
  if (!testMode) {
    let inputFile = values.inputFile ?? positionals[0];

    if (!fs.existsSync(inputFile)) {
      console.log("input file not found.");
      process.exit(1);
    }

    // get string from file...
  } else {
    // initial test
    sourceStr = "let x = 1; printf(`x holds ${x}`);";
  }
  let pos = 0;
  let currIter = 0;
  let failsafe = 100_000_000;
  while (pos <= sourceStr.length && currIter++ < failsafe) {
    const { token, nextPos, err } = lexNext(sourceStr, pos);

    if (err) {
      console.log("err", err);
      console.log(createErrorPointingOutput(sourceStr, nextPos, 15));
      process.exit(1);
    }

    if (token.tag === TokenTags.eof) break; // we're done

    console.log("token", token.tag, inverseTokenTags[token.tag]);
    pos = nextPos;
  }

  console.log("lexer: ok");
}

// start
main();
