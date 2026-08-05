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
});
