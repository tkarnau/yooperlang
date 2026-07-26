// DWARF metadata emitter - enough for `lldb` / VS Code backtraces,
// source-line breakpoints, `step`/`next` over .yoop source, AND structural
// inspection of locals (structs, arrays, strings, refs, variants, unions,
// value enums, vtables, function pointers).
//
// Usage: one `DebugInfo` per program (created in codegenProgram). Per module
// call `beginModule(absPath)` once to get a `{ fileMd, cuMd }` pair, then call
// `subprogram(...)` for each function/method `define` and `location(...)` for
// each emitted instruction that should map to a source line. At the end of
// codegen call `finalize()` and append its output to the IR text.
//
// The type side is `typeRef(yoopType)`: it maps a Yooperlang type onto the
// DWARF description of the LAYOUT CODEGEN ACTUALLY EMITS (see llvmType in
// codegen.js) and returns the `!N` ref to hang off a DILocalVariable. Every
// node is cached by a structural key, and nominal aggregates reserve their
// `!N` slot BEFORE building members so self-referential shapes (`type Node {
// next: ref Node }`) terminate.
//
// LLVM gotcha: the IR MUST declare `!llvm.dbg.cu` and `!llvm.module.flags`
// with the Dwarf Version + Debug Info Version entries - otherwise clang
// silently strips all the DI and emits a warning. `finalize()` always emits
// them.

import path from "node:path";
import { typeKinds } from "../jsyooptypecheck/types.js";

// `layout` injects codegen's sizeOfType / sizeOfAlign (byte units). They live
// in codegen.js next to llvmType so the emitted struct layout and the DWARF
// description of it stay derived from one source; passing them in keeps this
// module free of a circular import.
export function createDebugInfo(layout = {}) {
  const sizeOfType = layout.sizeOfType ?? (() => 8);
  const sizeOfAlign = layout.sizeOfAlign ?? (() => 8);

  const nodes = []; // !N text in order; index N corresponds to nodes[N]
  const cus = []; // ids of DICompileUnit nodes (for !llvm.dbg.cu)
  const locCache = new Map(); // "scope:line:col" -> id

  // Allocate a fresh !N id by pushing a placeholder; caller replaces nodes[id].
  function reserve() {
    const id = nodes.length;
    nodes.push(null);
    return id;
  }

  function emit(id, text) {
    nodes[id] = `!${id} = ${text}`;
    return id;
  }

  function ref(id) {
    return `!${id}`;
  }

  // Build a DIFile + DICompileUnit pair for one source module.
  function beginModule(absPath) {
    const filename = path.basename(absPath);
    const dirname = path.dirname(absPath);
    const fileId = reserve();
    emit(
      fileId,
      `!DIFile(filename: ${jsonStr(filename)}, directory: ${jsonStr(dirname)})`,
    );
    const cuId = reserve();
    // distinct + emissionKind: FullDebug → keep this CU even if no symbols
    // reference it. producer string surfaces in `lldb image list -d`.
    emit(
      cuId,
      `distinct !DICompileUnit(language: DW_LANG_C99, file: ${ref(fileId)}, producer: "yoopiler", isOptimized: false, runtimeVersion: 0, emissionKind: FullDebug)`,
    );
    cus.push(cuId);
    return { fileMd: ref(fileId), cuMd: ref(cuId), fileId, cuId };
  }

  // DISubprogram for a function `define`. Returns the !N ref to attach to the
  // `define ... { ... }` line and to use as the scope for DILocations inside
  // the function body.
  //
  // `signature` is an optional { returnType, paramTypes } pair of Yooperlang
  // types. When present the DISubroutineType carries the real return/parameter
  // types so a debugger can print the frame's signature; when absent (or when
  // a type isn't describable) the slot degrades to `null`, which DWARF reads
  // as "unspecified".
  function subprogram(funcName, linkageName, line, fileMd, cuMd, signature) {
    const subId = reserve();
    // distinct: each subprogram is its own node (LLVM verifier requirement
    // for definitions). spFlags: DISPFlagDefinition.
    const subroutineTypeId = reserve();
    emit(subroutineTypeId, `!DISubroutineType(types: ${subroutineTypes(signature)})`);
    emit(
      subId,
      `distinct !DISubprogram(name: ${jsonStr(funcName)}, linkageName: ${jsonStr(linkageName)}, scope: ${fileMd}, file: ${fileMd}, line: ${line}, type: ${ref(subroutineTypeId)}, scopeLine: ${line}, spFlags: DISPFlagDefinition, unit: ${cuMd})`,
    );
    return ref(subId);
  }

  // The `types:` tuple of a DISubroutineType is [return, ...params]. A `null`
  // entry means "no DWARF description for this slot" - legal, and what we fall
  // back to for a void return or an undescribable type.
  function subroutineTypes(signature) {
    if (!signature) return "!{}";
    const parts = [typeRef(signature.returnType) ?? "null"];
    for (const p of signature.paramTypes ?? []) parts.push(typeRef(p) ?? "null");
    return `!{${parts.join(", ")}}`;
  }

  // Per-program cache of DIBasicType nodes by Yooperlang prim name. Primitive
  // shapes don't depend on the module they're used in, so one node per name is
  // enough - referenced from any DILocalVariable that needs it.
  const basicTypeByPrim = new Map();
  // Opaque pointer DI node - shared for every shape we can't describe
  // structurally (Task<T>'s per-task struct, an untyped FFI handle). lldb
  // shows it as "(void *)".
  let opaquePointerId = null;

  // DIBasicType for a Yooperlang primitive. Returns the `!N` ref, deduped by
  // primName. Returns null for unsupported names (caller should skip emitting
  // a dbg.declare for that local).
  function basicTypeForPrim(primName) {
    const cached = basicTypeByPrim.get(primName);
    if (cached !== undefined) return cached;
    const shape = primShape(primName);
    if (!shape) {
      basicTypeByPrim.set(primName, null);
      return null;
    }
    const id = reserve();
    emit(
      id,
      `!DIBasicType(name: ${jsonStr(primName)}, size: ${shape.size}, encoding: ${shape.encoding})`,
    );
    const r = `!${id}`;
    basicTypeByPrim.set(primName, r);
    return r;
  }

  // DIDerivedType DW_TAG_pointer_type pointing at nothing - a generic
  // 64-bit pointer.
  function opaquePointer() {
    if (opaquePointerId != null) return `!${opaquePointerId}`;
    opaquePointerId = reserve();
    emit(
      opaquePointerId,
      `!DIDerivedType(tag: DW_TAG_pointer_type, baseType: null, size: 64)`,
    );
    return `!${opaquePointerId}`;
  }

  // ---- composite type emission ------------------------------------------

  // Structural key -> `!N` ref (or null when the shape has no DWARF form).
  const typeCache = new Map();

  function pointerTo(baseRef, name) {
    const id = reserve();
    const namePart = name ? `name: ${jsonStr(name)}, ` : "";
    emit(
      id,
      `!DIDerivedType(tag: DW_TAG_pointer_type, ${namePart}baseType: ${baseRef ?? "null"}, size: 64)`,
    );
    return `!${id}`;
  }

  function typedef(name, baseRef) {
    const id = reserve();
    emit(
      id,
      `!DIDerivedType(tag: DW_TAG_typedef, name: ${jsonStr(name)}, baseType: ${baseRef})`,
    );
    return `!${id}`;
  }

  // One DW_TAG_member. Sizes/offsets are in BITS (DWARF's unit), while the
  // caller works in bytes - conversion happens here so call sites stay in the
  // same units as codegen's sizeOfType.
  function member(scopeRef, name, baseRef, byteSize, byteAlign, byteOffset) {
    const id = reserve();
    emit(
      id,
      `!DIDerivedType(tag: DW_TAG_member, name: ${jsonStr(name)}, scope: ${scopeRef}, baseType: ${baseRef ?? "null"}, size: ${byteSize * 8}, align: ${byteAlign * 8}, offset: ${byteOffset * 8})`,
    );
    return `!${id}`;
  }

  // A record-shaped DICompositeType. `tag` is DW_TAG_structure_type or
  // DW_TAG_union_type. `id` is pre-reserved by the caller so members can point
  // their `scope:` back at it (and so recursive shapes can cache it first).
  function composite(id, tag, name, byteSize, byteAlign, memberRefs) {
    emit(
      id,
      `!DICompositeType(tag: ${tag}, name: ${jsonStr(name)}, size: ${byteSize * 8}, align: ${byteAlign * 8}, elements: !{${memberRefs.join(", ")}})`,
    );
    return `!${id}`;
  }

  // Lay out a `{ name, type }` field list the way LLVM lays out a non-packed
  // struct: each field bumped to its own alignment, struct size rounded up to
  // the widest field alignment. Returns { memberRefs, size, align }.
  function layoutFields(scopeRef, fields) {
    const memberRefs = [];
    let off = 0;
    let maxAlign = 1;
    for (const f of fields ?? []) {
      const fAlign = sizeOfAlign(f.type);
      const fSize = sizeOfType(f.type);
      if (fAlign > maxAlign) maxAlign = fAlign;
      off = roundUp(off, fAlign);
      memberRefs.push(member(scopeRef, f.name, typeRef(f.type), fSize, fAlign, off));
      off += fSize;
    }
    return { memberRefs, size: Math.max(roundUp(off, maxAlign), 0), align: maxAlign };
  }

  // DWARF enumeration over the tag of a `variant`, so a debugger prints
  // `tag = Circle` instead of `tag = 0`. Ordinals are the same stable
  // declaration-order integers codegen emits as the i32 discriminator.
  function variantTagEnum(enumName, variants) {
    const enumerators = [];
    for (const [caseName, v] of variants) {
      const id = reserve();
      emit(id, `!DIEnumerator(name: ${jsonStr(caseName)}, value: ${v.ordinal})`);
      enumerators.push(`!${id}`);
    }
    const id = reserve();
    emit(
      id,
      `!DICompositeType(tag: DW_TAG_enumeration_type, name: ${jsonStr(`${enumName}.tag`)}, baseType: ${basicTypeForPrim("int32")}, size: 32, elements: !{${enumerators.join(", ")}})`,
    );
    return `!${id}`;
  }

  // Map a Yooperlang type onto its DWARF description. Returns the `!N` ref, or
  // null for shapes with no useful DWARF form (the caller then skips the
  // dbg.declare so a debugger omits the variable rather than showing garbage).
  function typeRef(t) {
    if (!t) return null;
    const key = typeKey(t);
    const cached = typeCache.get(key);
    if (cached !== undefined) return cached;

    let result = null;
    switch (t.kind) {
      case typeKinds.prim: {
        // `string` is a `ptr` at the LLVM level. Describing it as `char *`
        // under a typedef gets the debugger's C-string summary (the actual
        // text, not just an address) while still naming the yoop type.
        if (t.name === "string") {
          result = typedef("string", pointerTo(basicTypeForPrim("char")));
          break;
        }
        result = basicTypeForPrim(t.name);
        break;
      }
      case typeKinds.struct: {
        const id = reserve();
        typeCache.set(key, `!${id}`); // BEFORE members - self-reference terminates here
        const { memberRefs, align } = layoutFields(`!${id}`, t.fields);
        result = composite(
          id,
          "DW_TAG_structure_type",
          t.name,
          sizeOfType(t),
          Math.max(align, sizeOfAlign(t)),
          memberRefs,
        );
        break;
      }
      // Pointer-ish and enumeration shapes deliberately do NOT pre-cache
      // before recursing: cycles can only close through a nominal aggregate,
      // and those reserve their slot first (above), so recursion terminates
      // there. Pre-caching null here would instead hand a null back to the
      // field that closed the cycle (`type Node { next: ref Node }`).
      case typeKinds.ref: {
        result = pointerTo(typeRef(t.inner));
        break;
      }
      case typeKinds.unsafePtr: {
        // A pointee-less `unsafe_ptr` is C's `void *`.
        result = t.pointee ? pointerTo(typeRef(t.pointee)) : opaquePointer();
        break;
      }
      case typeKinds.array: {
        // `%yoop_array.T = type { ptr, i64 }` - a fat pointer. Typing the
        // data member as `T *` is what makes `p arr.data[2]` work in lldb.
        const id = reserve();
        typeCache.set(key, `!${id}`);
        const scope = `!${id}`;
        const members = [
          member(scope, "data", pointerTo(typeRef(t.elem)), 8, 8, 0),
          member(scope, "len", basicTypeForPrim("usize"), 8, 8, 8),
        ];
        result = composite(id, "DW_TAG_structure_type", typeName(t), 16, 8, members);
        break;
      }
      case typeKinds.variant: {
        // `%variant.X = type { i32, [P x i8] }`. The payload bytes are
        // described as a DWARF union of the per-case payload structs, so a
        // debugger can walk into the active case's fields.
        const id = reserve();
        typeCache.set(key, `!${id}`);
        const scope = `!${id}`;
        const payloadSize = Math.max(variantPayloadSize(t), 1);
        const members = [member(scope, "tag", variantTagEnum(t.name, t.variants), 4, 4, 0)];
        const payloadRef = variantPayloadUnion(t, payloadSize);
        if (payloadRef) members.push(member(scope, "payload", payloadRef, payloadSize, 4, 4));
        // LLVM lays `{ i32, [N x i8] }` out with align 4 (the byte array is
        // align 1), so the whole thing rounds to 4 - not to the widest
        // payload field's alignment.
        result = composite(
          id,
          "DW_TAG_structure_type",
          t.name,
          roundUp(4 + payloadSize, 4),
          4,
          members,
        );
        break;
      }
      case typeKinds.union: {
        // Codegen emits `{ [N x i8] }` and bitcasts through it; DWARF gets to
        // describe the source-level view, which is a real overlapping union.
        const id = reserve();
        typeCache.set(key, `!${id}`);
        const scope = `!${id}`;
        let size = 0;
        let align = 1;
        const members = [];
        for (const f of t.fields ?? []) {
          const fSize = sizeOfType(f.type);
          const fAlign = sizeOfAlign(f.type);
          if (fSize > size) size = fSize;
          if (fAlign > align) align = fAlign;
          members.push(member(scope, f.name, typeRef(f.type), fSize, fAlign, 0));
        }
        result = composite(id, "DW_TAG_union_type", t.name, Math.max(size, 1), align, members);
        break;
      }
      case typeKinds.valueEnum: {
        result = valueEnumType(t);
        break;
      }
      case typeKinds.vtable: {
        // `{ ptr ctx, ptr m1, ptr m2, ... }` - one slot per trait method, in
        // trait declaration order (same order codegen indexes by).
        const id = reserve();
        typeCache.set(key, `!${id}`);
        const scope = `!${id}`;
        const members = [member(scope, "ctx", opaquePointer(), 8, 8, 0)];
        (t.methodOrder ?? []).forEach((m, i) => {
          members.push(member(scope, m, opaquePointer(), 8, 8, (i + 1) * 8));
        });
        result = composite(id, "DW_TAG_structure_type", t.name, members.length * 8, 8, members);
        break;
      }
      case typeKinds.functionPointer: {
        const subId = reserve();
        emit(
          subId,
          `!DISubroutineType(types: ${subroutineTypes({
            returnType: t.returnType,
            paramTypes: (t.params ?? []).map((p) => p.type ?? p),
          })})`,
        );
        result = pointerTo(`!${subId}`);
        break;
      }
      case typeKinds.task: {
        // The per-task struct layout lives in codegen state, not in the type
        // system, so there is nothing structural to point at yet.
        result = opaquePointer();
        break;
      }
      default:
        result = null;
    }
    typeCache.set(key, result);
    return result;
  }

  function valueEnumType(t) {
    const underlying = t.underlying;
    // `enum<string>` has no DWARF enumeration form - fall back to the
    // underlying string description.
    if (!underlying || underlying.kind !== typeKinds.prim || !primShape(underlying.name)) {
      return typeRef(underlying);
    }
    if (underlying.name === "string") return typeRef(underlying);
    const shape = primShape(underlying.name);
    const isUnsigned = shape.encoding === "DW_ATE_unsigned";
    const enumerators = [];
    for (const [caseName, c] of t.cases ?? []) {
      const id = reserve();
      const unsignedPart = isUnsigned ? ", isUnsigned: true" : "";
      emit(id, `!DIEnumerator(name: ${jsonStr(caseName)}, value: ${c.value}${unsignedPart})`);
      enumerators.push(`!${id}`);
    }
    const id = reserve();
    emit(
      id,
      `!DICompositeType(tag: DW_TAG_enumeration_type, name: ${jsonStr(t.name)}, baseType: ${basicTypeForPrim(underlying.name)}, size: ${shape.size}, elements: !{${enumerators.join(", ")}})`,
    );
    return `!${id}`;
  }

  // Widest per-case payload, laid out the same way codegen sizes
  // `%variant.X = type { i32, [P x i8] }`.
  function variantPayloadSize(t) {
    let max = 0;
    for (const v of t.variants.values()) {
      if (!v.fields) continue;
      let off = 0;
      let maxAlign = 1;
      for (const f of v.fields) {
        const a = sizeOfAlign(f.type);
        if (a > maxAlign) maxAlign = a;
        off = roundUp(off, a) + sizeOfType(f.type);
      }
      const padded = roundUp(off, maxAlign);
      if (padded > max) max = padded;
    }
    return max;
  }

  // DW_TAG_union_type over the per-case payload structs (`%variantc.X__C`).
  // Returns null when no case carries a payload (a plain C-style variant).
  function variantPayloadUnion(t, payloadSize) {
    const caseMembers = [];
    const unionId = reserve();
    const unionRef = `!${unionId}`;
    let maxAlign = 1;
    for (const [caseName, v] of t.variants) {
      if (!v.fields || v.fields.length === 0) continue;
      const caseId = reserve();
      const { memberRefs, size, align } = layoutFields(`!${caseId}`, v.fields);
      composite(caseId, "DW_TAG_structure_type", `${t.name}.${caseName}`, size, align, memberRefs);
      if (align > maxAlign) maxAlign = align;
      caseMembers.push(member(unionRef, caseName, `!${caseId}`, size, align, 0));
    }
    if (caseMembers.length === 0) {
      // Nothing to describe; leave the reserved slot unemitted (finalize
      // skips null entries) rather than emitting a dangling union.
      return null;
    }
    return composite(unionId, "DW_TAG_union_type", `${t.name}.payload`, payloadSize, maxAlign, caseMembers);
  }

  // DILocalVariable for a parameter (argIndex >= 1) or a `let`/`const` local
  // (argIndex omitted). `typeRef` should be a typeRef(...) result, or null to
  // skip emission entirely. Returns the `!N` ref to use as the second argument
  // of `llvm.dbg.declare`, or null if no DI is produced.
  function localVariable({ name, scope, file, line, typeRef: varTypeRef, argIndex }) {
    if (!varTypeRef) return null;
    const id = reserve();
    const argPart = argIndex ? `, arg: ${argIndex}` : "";
    emit(
      id,
      `!DILocalVariable(name: ${jsonStr(name)}${argPart}, scope: ${scope}, file: ${file}, line: ${line}, type: ${varTypeRef})`,
    );
    return `!${id}`;
  }

  // DILocation, deduped by (scope, line, column).
  function location(line, column, scopeRef) {
    // line=0 in DWARF means "no location" and lldb won't stop there. Clamp
    // 0/missing to 1 so generated/synthesized statements still attach to the
    // function's first line rather than being effectively invisible.
    const ln = line && line > 0 ? line : 1;
    const col = column && column > 0 ? column : 0;
    const key = `${scopeRef}:${ln}:${col}`;
    const cached = locCache.get(key);
    if (cached !== undefined) return ref(cached);
    const id = reserve();
    emit(id, `!DILocation(line: ${ln}, column: ${col}, scope: ${scopeRef})`);
    locCache.set(key, id);
    return ref(id);
  }

  // Final metadata block: named !llvm.dbg.cu + !llvm.module.flags, then every
  // numbered metadata node. Append to the end of the IR text.
  function finalize() {
    const out = [];
    out.push(`!llvm.dbg.cu = !{${cus.map(ref).join(", ")}}`);
    // Module flags. The behaviour code in slot 0 is `i32 7 = Max` for Dwarf
    // Version (so multiple linked modules pick the highest), `i32 2 = Warning`
    // for Debug Info Version (LLVM expects a specific value, warn on mismatch).
    const flag0 = reserve();
    emit(flag0, `!{i32 7, !"Dwarf Version", i32 4}`);
    const flag1 = reserve();
    emit(flag1, `!{i32 2, !"Debug Info Version", i32 3}`);
    out.push(`!llvm.module.flags = !{${ref(flag0)}, ${ref(flag1)}}`);
    out.push("");
    for (const line of nodes) {
      if (line !== null) out.push(line);
    }
    return out.join("\n");
  }

  return {
    beginModule,
    subprogram,
    location,
    basicTypeForPrim,
    opaquePointer,
    typeRef,
    localVariable,
    finalize,
  };
}

// Structural identity for the type cache. Nominal types (struct / variant /
// union / valueEnum / vtable) are keyed by (moduleId, name) - the same pair
// llvmType mangles with, and already unique per generic instantiation because
// instantiate.js bakes the type args into `name`.
function typeKey(t) {
  if (!t) return "null";
  switch (t.kind) {
    case typeKinds.prim: return `p:${t.name}`;
    case typeKinds.struct: return `s:${nominalId(t)}`;
    case typeKinds.variant: return `v:${nominalId(t)}`;
    case typeKinds.union: return `u:${nominalId(t)}`;
    case typeKinds.valueEnum: return `e:${nominalId(t)}`;
    case typeKinds.vtable: return `vt:${nominalId(t)}`;
    case typeKinds.ref: return `r:${typeKey(t.inner)}`;
    case typeKinds.array: return `a:${typeKey(t.elem)}`;
    case typeKinds.unsafePtr: return `up:${t.pointee ? typeKey(t.pointee) : "void"}`;
    case typeKinds.task: return "task";
    case typeKinds.functionPointer:
      return `fp:${(t.params ?? []).map((p) => typeKey(p.type ?? p)).join(",")}->${typeKey(t.returnType)}`;
    default: return `x:${t.kind}`;
  }
}

function nominalId(t) {
  return t.moduleId ? `${t.moduleId}__${t.name}` : t.name;
}

// Human-readable type name for the DWARF `name:` field.
function typeName(t) {
  if (!t) return "void";
  switch (t.kind) {
    case typeKinds.prim: return t.name;
    case typeKinds.struct:
    case typeKinds.variant:
    case typeKinds.union:
    case typeKinds.valueEnum:
    case typeKinds.vtable: return t.name;
    case typeKinds.ref: return `ref ${typeName(t.inner)}`;
    case typeKinds.array: return `${typeName(t.elem)}[]`;
    case typeKinds.unsafePtr:
      return t.pointee ? `unsafe_ptr<${typeName(t.pointee)}>` : "unsafe_ptr";
    case typeKinds.task: return `Task<${typeName(t.resultType)}>`;
    case typeKinds.functionPointer: return "fn";
    case typeKinds.void: return "void";
    default: return String(t.kind);
  }
}

function roundUp(x, a) {
  return Math.floor((x + a - 1) / a) * a;
}

// Encoding table for Yooperlang primitives -> DWARF basic types. Returns null
// for names we don't yet have DI for (void, etc.). Sizes are in bits.
function primShape(name) {
  switch (name) {
    case "int8": return { size: 8, encoding: "DW_ATE_signed" };
    case "int16": return { size: 16, encoding: "DW_ATE_signed" };
    case "int":
    case "int32": return { size: 32, encoding: "DW_ATE_signed" };
    case "int64":
    case "isize": return { size: 64, encoding: "DW_ATE_signed" };
    case "uint8": return { size: 8, encoding: "DW_ATE_unsigned" };
    case "uint16": return { size: 16, encoding: "DW_ATE_unsigned" };
    case "uint32": return { size: 32, encoding: "DW_ATE_unsigned" };
    case "uint64":
    case "usize":
    case "uintptr": return { size: 64, encoding: "DW_ATE_unsigned" };
    case "float":
    case "float32": return { size: 32, encoding: "DW_ATE_float" };
    case "float64": return { size: 64, encoding: "DW_ATE_float" };
    // LLVM lowers `bool` to i1 in SSA but the alloca slot is i8 (LLVM
    // rounds up to a byte), so DWARF size: 8 matches the in-memory layout
    // lldb actually reads from.
    case "bool": return { size: 8, encoding: "DW_ATE_boolean" };
    // DW_ATE_signed_char (not unsigned_char) is what gets a debugger to apply
    // its C-string summary to `char *`, which is how `string` is described.
    case "char": return { size: 8, encoding: "DW_ATE_signed_char" };
    default: return null;
  }
}

// LLVM metadata strings need C-style escaping. Path components rarely contain
// anything exotic, but quotes and backslashes (Windows paths) must be escaped.
function jsonStr(s) {
  const escaped = String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// Regex used by codegen to decide which IR lines should carry `!dbg`. Match
// the start of a side-effecting / control-flow instruction (call, invoke,
// ret, br, store, load, switch, resume, unreachable). Pure arithmetic /
// GEP / cast / cmp / phi instructions are skipped - we only need enough
// `!dbg` coverage for breakpoints and backtraces, not single-step over every
// SSA temp.
//
// Match shape: optional leading whitespace, optional `%name = ` SSA result,
// then the opcode keyword. Exported so codegen can share the same matcher.
export const DBG_TARGET_RE =
  /^\s+(?:%[\w.$]+\s*=\s*)?(?:call|invoke|tail call|musttail call|notail call|ret|br|store|load|switch|resume|unreachable)\b/;

// Annotate a slice of fnLines (from startIdx to end) with `, !dbg <ref>` on
// every matching instruction that doesn't already carry a `!dbg`. Idempotent:
// re-running over the same slice is a no-op because already-annotated lines
// are skipped.
export function annotateLinesWithDbg(fnLines, startIdx, dbgRef) {
  for (let i = startIdx; i < fnLines.length; i++) {
    const l = fnLines[i];
    if (!DBG_TARGET_RE.test(l)) continue;
    if (/, !dbg !\d+\s*$/.test(l)) continue;
    // Trim trailing whitespace before appending so the result stays tidy.
    fnLines[i] = l.replace(/\s+$/, "") + `, !dbg ${dbgRef}`;
  }
}
