import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getAttributeHandler,
  knownAttributeNames,
  suggestAttributeName,
} from "./registry.js";

describe("attributeRegistry", () => {
  it("returns @precompile as a known attribute", () => {
    assert.ok(knownAttributeNames().includes("precompile"));
    assert.ok(getAttributeHandler("precompile"));
    assert.equal(getAttributeHandler("nonexistent"), null);
  });

  it("returns @derive as a known attribute", () => {
    assert.ok(knownAttributeNames().includes("derive"));
    assert.ok(getAttributeHandler("derive"));
  });

  it("suggests close matches for typos", () => {
    assert.equal(suggestAttributeName("precompil"), "precompile"); // 1 deletion
    assert.equal(suggestAttributeName("precompiel"), "precompile"); // 2 substitutions
    assert.equal(suggestAttributeName("precompike"), "precompile"); // 1 substitution
  });

  it("returns null for completely unrelated names", () => {
    assert.equal(suggestAttributeName("totally_unrelated_attribute"), null);
    assert.equal(suggestAttributeName("xyz"), null);
  });
});
