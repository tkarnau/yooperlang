import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isHexDigit,
  isBinDigit,
  isOctDigit,
  isDigit,
  isAlpha,
  isAlphaNumOr_,
  isWhitespace,
  scanHexDigitsAndUnderscores,
  scanBinDigitsAndUnderscores,
  scanOctDigitsAndUnderscores,
  scanDecDigitsAndUnderscores,
  scanIdentityToEnd,
} from "./charFns.js";

describe("character predicates", () => {
  it("isDigit recognizes 0-9 only", () => {
    for (const c of "0123456789") assert.ok(isDigit(c));
    for (const c of "abf_/") assert.ok(!isDigit(c));
  });

  it("isHexDigit recognizes 0-9 + a-f + A-F", () => {
    for (const c of "0123456789abcdefABCDEF") assert.ok(isHexDigit(c));
    for (const c of "ghGH_/") assert.ok(!isHexDigit(c));
  });

  it("isBinDigit recognizes 0 and 1 only", () => {
    assert.ok(isBinDigit("0") && isBinDigit("1"));
    assert.ok(!isBinDigit("2") && !isBinDigit("a"));
  });

  it("isOctDigit recognizes 0-7", () => {
    for (const c of "01234567") assert.ok(isOctDigit(c));
    assert.ok(!isOctDigit("8") && !isOctDigit("9"));
  });

  it("isAlpha recognizes a-z + A-Z (no underscore, no digits)", () => {
    assert.ok(isAlpha("a") && isAlpha("Z"));
    assert.ok(!isAlpha("0") && !isAlpha("_"));
  });

  it("isAlphaNumOr_ accepts identifier characters", () => {
    for (const c of "aZ0_") assert.ok(isAlphaNumOr_(c));
    assert.ok(!isAlphaNumOr_("-"));
  });

  it("isWhitespace recognizes space/tab/CR/LF", () => {
    for (const c of [" ", "\t", "\r", "\n"]) assert.ok(isWhitespace(c));
    assert.ok(!isWhitespace("a"));
  });
});

describe("digit scanners with underscore separators", () => {
  it("scans hex digits + underscores until non-hex", () => {
    assert.equal(scanHexDigitsAndUnderscores("DEAD_BEEF;", 0), 9);
  });

  it("scans dec digits + underscores", () => {
    assert.equal(scanDecDigitsAndUnderscores("1_000_000;", 0), 9);
  });

  it("scans bin digits", () => {
    assert.equal(scanBinDigitsAndUnderscores("0100110x", 0), 7);
  });

  it("scans oct digits", () => {
    assert.equal(scanOctDigitsAndUnderscores("76543210x", 0), 8);
  });

  it("rejects leading underscore in hex", () => {
    assert.throws(() => scanHexDigitsAndUnderscores("_FF", 0), /underscore/);
  });
});

describe("scanIdentityToEnd", () => {
  it("scans alphanumeric identifier characters", () => {
    assert.equal(scanIdentityToEnd("foo_bar123 ", 0), 10);
  });

  it("stops at non-identifier characters", () => {
    assert.equal(scanIdentityToEnd("x.y", 0), 1);
  });
});
