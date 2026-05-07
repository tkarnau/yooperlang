import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenize, TokenTags } from "./lexer.js";

const tag = (t) => TokenTags[t];

describe("lexer: numeric literals", () => {
  it("decimal int", () => {
    const tokens = tokenize("42");
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].tag, tag("intLiteral"));
    assert.equal(tokens[0].intVal, 42);
  });

  it("hex int with underscore separator", () => {
    const tokens = tokenize("0xDEAD_BEEF");
    assert.equal(tokens[0].tag, tag("intLiteral"));
    assert.equal(tokens[0].intVal, 0xdeadbeef);
  });

  it("binary int", () => {
    const tokens = tokenize("0b1010");
    assert.equal(tokens[0].tag, tag("intLiteral"));
    assert.equal(tokens[0].intVal, 10);
  });

  it("decimal int with underscores", () => {
    const tokens = tokenize("1_000_000");
    assert.equal(tokens[0].intVal, 1_000_000);
  });

  it("float with fractional part", () => {
    const tokens = tokenize("3.14");
    assert.equal(tokens[0].tag, tag("floatLiteral"));
    assert.equal(tokens[0].floatVal, 3.14);
  });

  it("float with scientific exponent", () => {
    const tokens = tokenize("1e2");
    assert.equal(tokens[0].tag, tag("floatLiteral"));
    assert.equal(tokens[0].floatVal, 100);
  });
});

describe("lexer: keywords vs identifiers", () => {
  it("'function' is the function keyword", () => {
    const tokens = tokenize("function");
    assert.equal(tokens[0].tag, tag("function"));
  });

  it("'let' is the let keyword", () => {
    const tokens = tokenize("let");
    assert.equal(tokens[0].tag, tag("let"));
  });

  it("'foo' is a plain ident", () => {
    const tokens = tokenize("foo");
    assert.equal(tokens[0].tag, tag("ident"));
  });

  it("'type' is the type keyword", () => {
    const tokens = tokenize("type");
    assert.equal(tokens[0].tag, tag("type"));
  });
});

describe("lexer: punctuation", () => {
  it("recognizes single-char and multi-char operators", () => {
    const tokens = tokenize("== != <= >= < > + - * / { } ( ) , : ; .");
    const tags = tokens.map((t) => t.tag);
    assert.deepEqual(tags, [
      tag("eqeq"),
      tag("neq"),
      tag("lte"),
      tag("gte"),
      tag("lt"),
      tag("gt"),
      tag("plus"),
      tag("minus"),
      tag("mult"),
      tag("divide"),
      tag("lcurly"),
      tag("rcurly"),
      tag("lparen"),
      tag("rparen"),
      tag("comma"),
      tag("colon"),
      tag("semicolon"),
      tag("dot"),
    ]);
  });
});

describe("lexer: string and template literals", () => {
  it("plain double-quoted string", () => {
    const tokens = tokenize('"hello"');
    assert.equal(tokens[0].tag, tag("strLiteral"));
  });

  it("template literal with backticks", () => {
    const tokens = tokenize("`x is ${x}`");
    assert.equal(tokens[0].tag, tag("templateLiteral"));
  });
});

describe("lexer: whitespace handling", () => {
  it("skips spaces, tabs, newlines between tokens", () => {
    const tokens = tokenize("  let \n\tx  =  1 ");
    assert.equal(tokens.length, 4);
    assert.equal(tokens[0].tag, tag("let"));
    assert.equal(tokens[3].tag, tag("intLiteral"));
  });
});
