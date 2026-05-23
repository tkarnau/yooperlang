import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PrimType,
  EnumType,
  VoidType,
  typeKinds,
} from "./types.js";
import {
  isFallibleEnum,
  strippedEnumOkType,
  enumErrPayloadType,
} from "./fallible.js";

function variant(name, fields, ordinal) {
  return { name, fields, ordinal };
}

function fallibleEnum(name, okFields, errFields) {
  return EnumType(
    name,
    new Map([
      ["Ok", variant("Ok", okFields, 0)],
      ["Err", variant("Err", errFields, 1)],
    ]),
  );
}

describe("isFallibleEnum", () => {
  it("returns true for an Ok/Err enum with single-field payloads", () => {
    const t = fallibleEnum(
      "Result",
      [{ name: "value", type: PrimType("int32") }],
      [{ name: "error", type: PrimType("string") }],
    );
    assert.equal(isFallibleEnum(t), true);
  });

  it("returns true when Ok has no payload (null fields)", () => {
    const t = fallibleEnum(
      "StatusResult",
      null,
      [{ name: "error", type: PrimType("string") }],
    );
    assert.equal(isFallibleEnum(t), true);
  });

  it("returns false when a payload has more than one field", () => {
    const t = fallibleEnum(
      "Bad",
      [
        { name: "a", type: PrimType("int32") },
        { name: "b", type: PrimType("int32") },
      ],
      [{ name: "error", type: PrimType("string") }],
    );
    assert.equal(isFallibleEnum(t), false);
  });

  it("returns false when variant names don't match Ok/Err", () => {
    const t = EnumType(
      "Other",
      new Map([
        ["Some", variant("Some", [{ name: "value", type: PrimType("int32") }], 0)],
        ["None", variant("None", null, 1)],
      ]),
    );
    assert.equal(isFallibleEnum(t), false);
  });

  it("returns false for non-enum types", () => {
    assert.equal(isFallibleEnum(PrimType("int32")), false);
    assert.equal(isFallibleEnum(null), false);
    assert.equal(isFallibleEnum(undefined), false);
  });
});

describe("strippedEnumOkType", () => {
  it("returns the single Ok payload type", () => {
    const t = fallibleEnum(
      "Result",
      [{ name: "value", type: PrimType("int32") }],
      [{ name: "error", type: PrimType("string") }],
    );
    assert.deepEqual(strippedEnumOkType(t), PrimType("int32"));
  });

  it("returns void when Ok has no payload", () => {
    const t = fallibleEnum(
      "StatusResult",
      null,
      [{ name: "error", type: PrimType("string") }],
    );
    assert.equal(strippedEnumOkType(t).kind, typeKinds.void);
  });
});

describe("enumErrPayloadType", () => {
  it("returns the single Err payload type", () => {
    const t = fallibleEnum(
      "Result",
      [{ name: "value", type: PrimType("int32") }],
      [{ name: "error", type: PrimType("string") }],
    );
    assert.deepEqual(enumErrPayloadType(t), PrimType("string"));
  });

  it("returns void when Err has no payload", () => {
    const t = fallibleEnum(
      "PointlessResult",
      [{ name: "value", type: PrimType("int32") }],
      null,
    );
    assert.equal(enumErrPayloadType(t).kind, typeKinds.void);
  });
});
