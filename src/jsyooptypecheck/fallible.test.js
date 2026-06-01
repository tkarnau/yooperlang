import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PrimType,
  VariantType,
  VoidType,
  typeKinds,
} from "./types.js";
import {
  isFallibleVariant,
  strippedVariantOkType,
  variantErrPayloadType,
} from "./fallible.js";

function caseEntry(name, fields, ordinal) {
  return { name, fields, ordinal };
}

function fallibleVariant(name, okFields, errFields) {
  return VariantType(
    name,
    new Map([
      ["Ok", caseEntry("Ok", okFields, 0)],
      ["Err", caseEntry("Err", errFields, 1)],
    ]),
  );
}

describe("isFallibleVariant", () => {
  it("returns true for an Ok/Err variant with single-field payloads", () => {
    const t = fallibleVariant(
      "Result",
      [{ name: "value", type: PrimType("int32") }],
      [{ name: "error", type: PrimType("string") }],
    );
    assert.equal(isFallibleVariant(t), true);
  });

  it("returns true when Ok has no payload (null fields)", () => {
    const t = fallibleVariant(
      "StatusResult",
      null,
      [{ name: "error", type: PrimType("string") }],
    );
    assert.equal(isFallibleVariant(t), true);
  });

  it("returns false when a payload has more than one field", () => {
    const t = fallibleVariant(
      "Bad",
      [
        { name: "a", type: PrimType("int32") },
        { name: "b", type: PrimType("int32") },
      ],
      [{ name: "error", type: PrimType("string") }],
    );
    assert.equal(isFallibleVariant(t), false);
  });

  it("returns false when case names don't match Ok/Err", () => {
    const t = VariantType(
      "Other",
      new Map([
        ["Some", caseEntry("Some", [{ name: "value", type: PrimType("int32") }], 0)],
        ["None", caseEntry("None", null, 1)],
      ]),
    );
    assert.equal(isFallibleVariant(t), false);
  });

  it("returns false for non-variant types", () => {
    assert.equal(isFallibleVariant(PrimType("int32")), false);
    assert.equal(isFallibleVariant(null), false);
    assert.equal(isFallibleVariant(undefined), false);
  });
});

describe("strippedVariantOkType", () => {
  it("returns the single Ok payload type", () => {
    const t = fallibleVariant(
      "Result",
      [{ name: "value", type: PrimType("int32") }],
      [{ name: "error", type: PrimType("string") }],
    );
    assert.deepEqual(strippedVariantOkType(t), PrimType("int32"));
  });

  it("returns void when Ok has no payload", () => {
    const t = fallibleVariant(
      "StatusResult",
      null,
      [{ name: "error", type: PrimType("string") }],
    );
    assert.equal(strippedVariantOkType(t).kind, typeKinds.void);
  });
});

describe("variantErrPayloadType", () => {
  it("returns the single Err payload type", () => {
    const t = fallibleVariant(
      "Result",
      [{ name: "value", type: PrimType("int32") }],
      [{ name: "error", type: PrimType("string") }],
    );
    assert.deepEqual(variantErrPayloadType(t), PrimType("string"));
  });

  it("returns void when Err has no payload", () => {
    const t = fallibleVariant(
      "PointlessResult",
      [{ name: "value", type: PrimType("int32") }],
      null,
    );
    assert.equal(variantErrPayloadType(t).kind, typeKinds.void);
  });
});
