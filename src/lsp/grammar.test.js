// Tests for the TextMate grammar the VS Code extension ships
// (editors/vscode/syntaxes/yoop.tmLanguage.json).
//
// The grammar had no coverage at all. It gets some here because the
// `module <name>;` rule is CONTEXTUAL, and the failure mode of getting that
// wrong is silent: `module` is not a reserved word (bootstrap/src/contracts.yoop
// uses it as a struct field name), so a rule written as the obvious
// `\b(module)\b` would colour every one of those field names as a keyword and
// nothing would complain. Keyword colouring comes entirely from this grammar -
// semanticTokens.js declares a "keyword" token type but never emits one - so
// there is no second layer that would catch a mistake here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { keywordTagList } from "../jsyooplexer/lexer.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const grammarPath = path.join(
  repoRoot,
  "editors/vscode/syntaxes/yoop.tmLanguage.json",
);

function loadGrammar() {
  return JSON.parse(fs.readFileSync(grammarPath, "utf8"));
}

describe("vscode grammar", () => {
  it("is valid JSON with the expected scope name", () => {
    const g = loadGrammar();
    assert.equal(g.scopeName, "source.yoop");
    assert.ok(Array.isArray(g.repository?.keywords?.patterns));
  });

  it("every pattern's `match` is a valid regex", () => {
    const g = loadGrammar();
    const bad = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      for (const key of ["match", "begin", "end"]) {
        if (typeof node[key] === "string") {
          try {
            new RegExp(node[key]);
          } catch (err) {
            bad.push(`${key}: ${node[key]} (${err.message})`);
          }
        }
      }
      Object.values(node).forEach(walk);
    };
    walk(g);
    assert.deepEqual(bad, []);
  });

  describe("the `module <name>;` header rule", () => {
    const moduleRule = () => {
      const g = loadGrammar();
      const rule = g.repository.keywords.patterns.find(
        (p) => typeof p.match === "string" && p.match.includes("module"),
      );
      assert.ok(rule, "expected a keyword pattern matching `module`");
      return rule;
    };

    it("names the keyword and the module name separately", () => {
      const rule = moduleRule();
      assert.match(rule.captures?.["1"]?.name ?? "", /^keyword\./);
      assert.match(rule.captures?.["2"]?.name ?? "", /^entity\.name\./);
    });

    // The whole point: a header at column 0 is a keyword, `module` anywhere
    // else is an ordinary identifier.
    const cases = [
      ["module cancel;", true, "the header form"],
      ["module http;", true, "another header"],
      ["module a_b;", true, "underscored name"],
      ["  module: ModuleId,", false, "a struct FIELD named module"],
      ["    module cancel;", false, "indented - not a file header"],
      ["module foo", false, "no semicolon"],
      ["moduleName x = 1;", false, "a longer identifier starting with module"],
      ["let module: int32 = 1;", false, "a local binding named module"],
    ];

    for (const [line, shouldMatch, why] of cases) {
      it(`${shouldMatch ? "matches" : "does not match"}: ${why}`, () => {
        const re = new RegExp(moduleRule().match);
        assert.equal(
          re.test(line),
          shouldMatch,
          `${JSON.stringify(line)} should ${shouldMatch ? "" : "not "}match`,
        );
      });
    }
  });

  // A batch of reserved words are contextual keywords so they can be ordinary
  // names. The grammar has to follow: a bare \b(kind)\b rule would colour
  // every `kind: uint8` field as a keyword, which is exactly the silent
  // failure the `module` rule above exists to prevent. Same shape of guard,
  // same reason.
  function ruleMatching(fragment) {
    const g = loadGrammar();
    const rule = g.repository.keywords.patterns.find(
      (p) => typeof p.match === "string" && p.match.includes(fragment),
    );
    assert.ok(rule, `expected a keyword pattern containing ${fragment}`);
    return rule;
  }

  describe("the `kind <Name>` declaration rule", () => {
    const cases = [
      ["kind disposable {", true, "a kind decl"],
      ["export kind cleared {", true, "an exported kind decl"],
      ["kind isolatedTest = test & ephemeral;", true, "a composition"],
      ["kind throughputCapped(n: usize) {", true, "a parameterized kind"],
      ["    kind: uint8,", false, "a struct FIELD named kind"],
      ["    let kind: int32 = 1;", false, "a local named kind"],
      ["function specialFor(kind: uint8): int32 {", false, "a PARAMETER named kind"],
      ["    return r.kind;", false, "a field access"],
      ["kindOfThing x = 1;", false, "a longer identifier starting with kind"],
    ];
    for (const [line, shouldMatch, why] of cases) {
      it(`${shouldMatch ? "matches" : "does not match"}: ${why}`, () => {
        const re = new RegExp(ruleMatching("(kind)").match);
        assert.equal(
          re.test(line),
          shouldMatch,
          `${JSON.stringify(line)} should ${shouldMatch ? "" : "not "}match`,
        );
      });
    }
  });

  describe("the kind-clause keyword rule", () => {
    const cases = [
      ["    appliesTo binding parameter field;", true, "an appliesTo clause"],
      ["    requires Disposable;", true, "a requires clause"],
      ["    mustCall dispose beforeScopeEnd;", true, "a mustCall clause"],
      ["    layout { abi \"C\"; }", true, "a layout clause"],
      ["    requires: int32,", false, "a struct FIELD named requires"],
      ["    field: int32,", false, "a struct FIELD named field"],
      ["    scope: int32,", false, "a struct FIELD named scope"],
      ["    io: int32,", false, "a struct FIELD named io"],
      ["function f(scope: int32, io: int32): void {", false, "PARAMETERS named scope and io"],
      ["    return self.requires;", false, "a field access"],
    ];
    for (const [line, shouldMatch, why] of cases) {
      it(`${shouldMatch ? "matches" : "does not match"}: ${why}`, () => {
        const re = new RegExp(ruleMatching("appliesTo|requires").match);
        assert.equal(
          re.test(line),
          shouldMatch,
          `${JSON.stringify(line)} should ${shouldMatch ? "" : "not "}match`,
        );
      });
    }
  });

  // The drift guard. Every one of the above pins a rule that EXISTS; none of
  // them notices a keyword that has no rule at all, which is a silent failure
  // in the same way and was a live one: `null` had no rule anywhere in the
  // grammar, and `in` (the `for x in xs` separator) had none either. Both are
  // plain reserved words in the lexer, so both read as undifferentiated
  // identifiers in the editor.
  //
  // Matching a literal word in some pattern is a deliberately weak assertion -
  // it says a keyword is ACCOUNTED FOR, not that its rule is contextually
  // right. The cases above are where correctness-of-context is pinned, and
  // they only work on rules someone remembered to write.
  it("every lexer keyword is named by some grammar rule", () => {
    const g = loadGrammar();
    const words = new Set();
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      for (const key of ["match", "begin", "end"]) {
        if (typeof node[key] !== "string") continue;
        // After JSON.parse a pattern like "\\bself\\b" is the string \bself\b,
        // so the single-character escapes have to be blanked before scanning -
        // otherwise \bself\b scans as the one word "bself" and every anchored
        // keyword looks absent.
        const cleaned = node[key].replace(/\\[a-zA-Z]/g, " ");
        for (const m of cleaned.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
          words.add(m[0]);
        }
      }
      Object.values(node).forEach(walk);
    };
    walk(g);

    const missing = Object.keys(keywordTagList)
      .filter((k) => k !== "__proto__")
      .filter((k) => !words.has(k))
      .sort();
    assert.deepEqual(missing, [], `keywords with no rule in the grammar: ${missing.join(", ")}`);
  });

  it("does not colour `kind` or `library` via the bare declaration-keyword rule", () => {
    const g = loadGrammar();
    const decl = g.repository.keywords.patterns.find(
      (p) => typeof p.match === "string" && p.match.includes("let|const|function"),
    );
    assert.ok(decl, "expected the declaration-keyword rule");
    const re = new RegExp(decl.match);
    assert.ok(re.test("let x = 1;"), "still matches let");
    assert.ok(!re.test("    kind: uint8,"), "must not match a field named kind");
    assert.ok(!re.test("    library: int32,"), "must not match a field named library");
  });
});
