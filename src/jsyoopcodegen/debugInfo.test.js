import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDebugInfo } from "./debugInfo.js";
import { sizeOfType, sizeOfAlign } from "./codegen.js";
import {
  PrimType,
  StructType,
  RefType,
  ArrayType,
  VariantType,
  UnionType,
  ValueEnumType,
  VTableType,
  UnsafePtrType,
  TaskType,
} from "../jsyooptypecheck/types.js";

// Same layout functions codegen injects in codegenProgram, so the offsets the
// tests assert on are the offsets the emitted LLVM structs actually have.
function makeDI() {
  return createDebugInfo({ sizeOfType, sizeOfAlign });
}

// Pull the body of the numbered metadata node `ref` (e.g. "!7") out of a
// finalize() dump.
function nodeText(ir, r) {
  const m = ir.match(new RegExp(`^\\${r} = (.*)$`, "m"));
  return m ? m[1] : null;
}

describe("debugInfo.typeRef: primitives", () => {
  it("maps each integer / float / bool prim to a DIBasicType with the right size", () => {
    const di = makeDI();
    const cases = [
      ["int8", 8, "DW_ATE_signed"],
      ["int32", 32, "DW_ATE_signed"],
      ["usize", 64, "DW_ATE_unsigned"],
      ["float32", 32, "DW_ATE_float"],
      ["float64", 64, "DW_ATE_float"],
      ["bool", 8, "DW_ATE_boolean"],
    ];
    const refs = cases.map(([name]) => di.typeRef(PrimType(name)));
    const ir = di.finalize();
    cases.forEach(([name, size, encoding], i) => {
      assert.equal(
        nodeText(ir, refs[i]),
        `!DIBasicType(name: "${name}", size: ${size}, encoding: ${encoding})`,
      );
    });
  });

  it("dedupes: the same prim asked for twice returns the same node", () => {
    const di = makeDI();
    assert.equal(di.typeRef(PrimType("int32")), di.typeRef(PrimType("int32")));
  });

  it("returns null for a prim with no DWARF form, so the caller skips dbg.declare", () => {
    const di = makeDI();
    assert.equal(di.typeRef(PrimType("void")), null);
  });

  it("describes `string` as a typedef over char* so debuggers print the text", () => {
    const di = makeDI();
    const r = di.typeRef(PrimType("string"));
    const ir = di.finalize();
    const td = nodeText(ir, r);
    assert.match(td, /^!DIDerivedType\(tag: DW_TAG_typedef, name: "string", baseType: (!\d+)\)$/);
    const ptr = nodeText(ir, td.match(/baseType: (!\d+)/)[1]);
    assert.match(ptr, /^!DIDerivedType\(tag: DW_TAG_pointer_type, baseType: (!\d+), size: 64\)$/);
    const char = nodeText(ir, ptr.match(/baseType: (!\d+)/)[1]);
    assert.equal(char, `!DIBasicType(name: "char", size: 8, encoding: DW_ATE_signed_char)`);
  });
});

describe("debugInfo.typeRef: structs", () => {
  const Point = StructType("Point", [
    { name: "x", type: PrimType("int32") },
    { name: "y", type: PrimType("int32") },
  ], "m");

  it("emits a DW_TAG_structure_type with one member per field", () => {
    const di = makeDI();
    const r = di.typeRef(Point);
    const ir = di.finalize();
    assert.match(
      nodeText(ir, r),
      /^!DICompositeType\(tag: DW_TAG_structure_type, name: "Point", size: 64, align: 32, elements: !\{(!\d+), (!\d+)\}\)$/,
    );
    assert.match(ir, /!DIDerivedType\(tag: DW_TAG_member, name: "x", scope: !\d+, baseType: !\d+, size: 32, align: 32, offset: 0\)/);
    assert.match(ir, /!DIDerivedType\(tag: DW_TAG_member, name: "y", scope: !\d+, baseType: !\d+, size: 32, align: 32, offset: 32\)/);
  });

  it("pads member offsets to each field's alignment, matching LLVM's layout", () => {
    const di = makeDI();
    // { i8, i64 } -> the i64 lands at byte 8, not byte 1.
    const S = StructType("S", [
      { name: "flag", type: PrimType("int8") },
      { name: "big", type: PrimType("int64") },
    ], "m");
    di.typeRef(S);
    const ir = di.finalize();
    assert.match(ir, /name: "flag",[^)]*offset: 0\)/);
    assert.match(ir, /name: "big",[^)]*offset: 64\)/);
    assert.match(ir, /name: "S", size: 128, align: 64/);
  });

  it("keys nominal types by (moduleId, name) - one node per struct", () => {
    const di = makeDI();
    assert.equal(di.typeRef(Point), di.typeRef(Point));
    // A structurally identical struct from another module is a distinct type.
    const other = StructType("Point", Point.fields, "other");
    assert.notEqual(di.typeRef(Point), di.typeRef(other));
  });

  it("terminates on a self-referential struct and reuses the reserved node", () => {
    const di = makeDI();
    const fields = [{ name: "value", type: PrimType("int32") }];
    const Node = StructType("Node", fields, "m");
    // `next: unsafe_ptr<Node>` closes the cycle back onto Node itself.
    fields.push({ name: "next", type: UnsafePtrType(Node) });
    const r = di.typeRef(Node);
    const ir = di.finalize();
    const next = nodeText(ir, ir.match(/(!\d+) = !DIDerivedType\(tag: DW_TAG_member, name: "next"/)[1]);
    const ptr = nodeText(ir, next.match(/baseType: (!\d+)/)[1]);
    // The pointer's pointee is the very same composite node, not a copy.
    assert.equal(ptr.match(/baseType: (!\d+)/)[1], r);
  });
});

describe("debugInfo.typeRef: pointers and arrays", () => {
  it("describes `ref T` as a pointer whose baseType is T's composite", () => {
    const di = makeDI();
    const Point = StructType("Point", [{ name: "x", type: PrimType("int32") }], "m");
    const pointRef = di.typeRef(Point);
    const r = di.typeRef(RefType(Point));
    const ir = di.finalize();
    assert.equal(
      nodeText(ir, r),
      `!DIDerivedType(tag: DW_TAG_pointer_type, baseType: ${pointRef}, size: 64)`,
    );
  });

  it("describes `T[]` as the { data, len } fat pointer codegen emits", () => {
    const di = makeDI();
    const r = di.typeRef(ArrayType(PrimType("int32")));
    const ir = di.finalize();
    assert.match(
      nodeText(ir, r),
      /^!DICompositeType\(tag: DW_TAG_structure_type, name: "int32\[\]", size: 128, align: 64/,
    );
    assert.match(ir, /name: "data", scope: !\d+, baseType: !\d+, size: 64, align: 64, offset: 0\)/);
    assert.match(ir, /name: "len", scope: !\d+, baseType: !\d+, size: 64, align: 64, offset: 64\)/);
  });

  it("types the array's data member as a pointer to the element type", () => {
    const di = makeDI();
    const elem = di.typeRef(PrimType("int32"));
    di.typeRef(ArrayType(PrimType("int32")));
    const ir = di.finalize();
    const dataMember = ir.match(/name: "data", scope: !\d+, baseType: (!\d+)/)[1];
    assert.equal(
      nodeText(ir, dataMember),
      `!DIDerivedType(tag: DW_TAG_pointer_type, baseType: ${elem}, size: 64)`,
    );
  });

  it("falls back to a void pointer for Task<T> and for an opaque unsafe_ptr", () => {
    const di = makeDI();
    const task = di.typeRef(TaskType(PrimType("int32")));
    const opaque = di.typeRef(UnsafePtrType(null));
    const ir = di.finalize();
    assert.equal(task, opaque);
    assert.equal(
      nodeText(ir, task),
      `!DIDerivedType(tag: DW_TAG_pointer_type, baseType: null, size: 64)`,
    );
  });
});

describe("debugInfo.typeRef: variants, unions, value enums, vtables", () => {
  const Shape = VariantType("Shape", new Map([
    ["Circle", { fields: [{ name: "r", type: PrimType("int32") }], ordinal: 0 }],
    ["Rect", {
      fields: [
        { name: "w", type: PrimType("int32") },
        { name: "h", type: PrimType("int32") },
      ],
      ordinal: 1,
    }],
    ["Dot", { fields: null, ordinal: 2 }],
  ]), "m");

  it("describes a variant as { tag, payload } with the tag as an enumeration", () => {
    const di = makeDI();
    const r = di.typeRef(Shape);
    const ir = di.finalize();
    // %variant.Shape = type { i32, [8 x i8] } -> 12 bytes, align 4.
    assert.match(
      nodeText(ir, r),
      /^!DICompositeType\(tag: DW_TAG_structure_type, name: "Shape", size: 96, align: 32/,
    );
    assert.match(ir, /name: "tag", scope: !\d+, baseType: !\d+, size: 32, align: 32, offset: 0\)/);
    assert.match(ir, /name: "payload", scope: !\d+, baseType: !\d+, size: 64, align: 32, offset: 32\)/);
  });

  it("names each tag value with its case, using the declaration-order ordinal", () => {
    const di = makeDI();
    di.typeRef(Shape);
    const ir = di.finalize();
    assert.match(ir, /!DICompositeType\(tag: DW_TAG_enumeration_type, name: "Shape\.tag", baseType: !\d+, size: 32/);
    assert.match(ir, /!DIEnumerator\(name: "Circle", value: 0\)/);
    assert.match(ir, /!DIEnumerator\(name: "Rect", value: 1\)/);
    assert.match(ir, /!DIEnumerator\(name: "Dot", value: 2\)/);
  });

  it("describes the payload as a union of per-case structs (payload-less cases skipped)", () => {
    const di = makeDI();
    di.typeRef(Shape);
    const ir = di.finalize();
    assert.match(ir, /!DICompositeType\(tag: DW_TAG_union_type, name: "Shape\.payload", size: 64/);
    assert.match(ir, /!DICompositeType\(tag: DW_TAG_structure_type, name: "Shape\.Circle", size: 32/);
    assert.match(ir, /!DICompositeType\(tag: DW_TAG_structure_type, name: "Shape\.Rect", size: 64/);
    assert.doesNotMatch(ir, /name: "Shape\.Dot"/);
  });

  it("omits the payload member entirely for an all-payload-less variant", () => {
    const di = makeDI();
    const E = VariantType("E", new Map([
      ["A", { fields: null, ordinal: 0 }],
      ["B", { fields: null, ordinal: 1 }],
    ]), "m");
    di.typeRef(E);
    const ir = di.finalize();
    assert.doesNotMatch(ir, /name: "payload"/);
    assert.match(ir, /!DIEnumerator\(name: "B", value: 1\)/);
  });

  it("describes a union as DW_TAG_union_type with every field at offset 0", () => {
    const di = makeDI();
    const Channels = StructType("Channels", [
      { name: "r", type: PrimType("uint8") },
      { name: "g", type: PrimType("uint8") },
    ], "m");
    di.typeRef(UnionType("Color", [
      { name: "rgba", type: PrimType("uint32") },
      { name: "channels", type: Channels },
    ], "m"));
    const ir = di.finalize();
    // size = widest field (uint32, 4 bytes), align = widest field alignment.
    assert.match(ir, /!DICompositeType\(tag: DW_TAG_union_type, name: "Color", size: 32, align: 32/);
    assert.match(ir, /name: "rgba",[^)]*offset: 0\)/);
    assert.match(ir, /name: "channels",[^)]*offset: 0\)/);
  });

  it("describes a value enum as a DWARF enumeration over its underlying prim", () => {
    const di = makeDI();
    di.typeRef(ValueEnumType("Color", PrimType("int32"), new Map([
      ["Red", { name: "Red", value: 0, ordinal: 0 }],
      ["Green", { name: "Green", value: 1, ordinal: 1 }],
    ]), "m"));
    const ir = di.finalize();
    assert.match(ir, /!DICompositeType\(tag: DW_TAG_enumeration_type, name: "Color", baseType: !\d+, size: 32/);
    assert.match(ir, /!DIEnumerator\(name: "Green", value: 1\)/);
  });

  it("falls back to the string description for a string-underlying value enum", () => {
    const di = makeDI();
    const r = di.typeRef(ValueEnumType("SortDir", PrimType("string"), new Map([
      ["Asc", { name: "Asc", value: "ASCENDING", ordinal: 0 }],
    ]), "m"));
    const ir = di.finalize();
    assert.match(nodeText(ir, r), /tag: DW_TAG_typedef, name: "string"/);
  });

  it("describes a vtable as { ctx, <one slot per trait method> }", () => {
    const di = makeDI();
    const r = di.typeRef(VTableType("Dispatcher", "Handler", "m", [], ["handle", "reset"], "m"));
    const ir = di.finalize();
    assert.match(
      nodeText(ir, r),
      /^!DICompositeType\(tag: DW_TAG_structure_type, name: "Dispatcher", size: 192, align: 64/,
    );
    assert.match(ir, /name: "ctx",[^)]*offset: 0\)/);
    assert.match(ir, /name: "handle",[^)]*offset: 64\)/);
    assert.match(ir, /name: "reset",[^)]*offset: 128\)/);
  });
});

describe("debugInfo.subprogram", () => {
  it("carries the real return + parameter types in its DISubroutineType", () => {
    const di = makeDI();
    const { fileMd, cuMd } = di.beginModule("/tmp/mod/main.yoop");
    const int32 = di.typeRef(PrimType("int32"));
    const sp = di.subprogram("f", "m__f", 3, fileMd, cuMd, {
      returnType: PrimType("int32"),
      paramTypes: [PrimType("int32")],
    });
    const ir = di.finalize();
    const typeRef = nodeText(ir, sp).match(/type: (!\d+)/)[1];
    assert.equal(nodeText(ir, typeRef), `!DISubroutineType(types: !{${int32}, ${int32}})`);
  });

  it("uses `null` for a void return and for an undescribable parameter", () => {
    const di = makeDI();
    const { fileMd, cuMd } = di.beginModule("/tmp/mod/main.yoop");
    const sp = di.subprogram("f", "m__f", 3, fileMd, cuMd, {
      returnType: null,
      paramTypes: [PrimType("void")],
    });
    const ir = di.finalize();
    const typeRef = nodeText(ir, sp).match(/type: (!\d+)/)[1];
    assert.equal(nodeText(ir, typeRef), `!DISubroutineType(types: !{null, null})`);
  });
});

describe("debugInfo.finalize", () => {
  it("always emits the named metadata clang needs to keep the DI", () => {
    const di = makeDI();
    di.beginModule("/tmp/mod/main.yoop");
    const ir = di.finalize();
    assert.match(ir, /!llvm\.dbg\.cu = !\{!\d+\}/);
    assert.match(ir, /!llvm\.module\.flags = !\{!\d+, !\d+\}/);
    assert.match(ir, /!\d+ = !\{i32 7, !"Dwarf Version", i32 4\}/);
    assert.match(ir, /!\d+ = !\{i32 2, !"Debug Info Version", i32 3\}/);
  });

  it("emits no dangling references - every !N mentioned is defined", () => {
    const di = makeDI();
    di.beginModule("/tmp/mod/main.yoop");
    di.typeRef(VariantType("Shape", new Map([
      ["Circle", { fields: [{ name: "r", type: PrimType("int32") }], ordinal: 0 }],
      ["Dot", { fields: null, ordinal: 1 }],
    ]), "m"));
    di.typeRef(ArrayType(StructType("P", [{ name: "x", type: PrimType("int32") }], "m")));
    di.typeRef(PrimType("string"));
    const ir = di.finalize();
    const defined = new Set([...ir.matchAll(/^(!\d+) = /gm)].map((m) => m[1]));
    for (const m of ir.matchAll(/(?:baseType|scope|type|file|unit|elements: !\{[^}]*?): (!\d+)/g)) {
      assert.ok(defined.has(m[1]), `dangling metadata reference ${m[1]}`);
    }
    for (const m of ir.matchAll(/elements: !\{([^}]*)\}/g)) {
      for (const r of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        assert.ok(defined.has(r), `dangling elements reference ${r}`);
      }
    }
  });
});
