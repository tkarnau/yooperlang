// MVP DWARF metadata emitter — enough for `lldb` backtraces, source-line
// breakpoints, and `step`/`next` over .yoop source. No DI for locals, params,
// or composite types yet (see plans/i-want-to-add-goofy-cloud.md "Out of
// scope" for the follow-on milestones).
//
// Usage: one `DebugInfo` per program (created in codegenProgram). Per module
// call `beginModule(absPath)` once to get a `{ fileMd, cuMd }` pair, then call
// `subprogram(...)` for each function/method `define` and `location(...)` for
// each emitted instruction that should map to a source line. At the end of
// codegen call `finalize()` and append its output to the IR text.
//
// LLVM gotcha: the IR MUST declare `!llvm.dbg.cu` and `!llvm.module.flags`
// with the Dwarf Version + Debug Info Version entries — otherwise clang
// silently strips all the DI and emits a warning. `finalize()` always emits
// them.

import path from "node:path";

export function createDebugInfo() {
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
  function subprogram(funcName, linkageName, line, fileMd, cuMd) {
    const subId = reserve();
    // distinct: each subprogram is its own node (LLVM verifier requirement
    // for definitions). spFlags: DISPFlagDefinition. We don't have a
    // DISubroutineType emitted (would require typed DI for params/return) —
    // for line-only DWARF, an empty `!DISubroutineType(types: !{})` works.
    const subroutineTypeId = reserve();
    emit(subroutineTypeId, `!DISubroutineType(types: !{})`);
    emit(
      subId,
      `distinct !DISubprogram(name: ${jsonStr(funcName)}, linkageName: ${jsonStr(linkageName)}, scope: ${fileMd}, file: ${fileMd}, line: ${line}, type: ${ref(subroutineTypeId)}, scopeLine: ${line}, spFlags: DISPFlagDefinition, unit: ${cuMd})`,
    );
    return ref(subId);
  }

  // Per-program cache of DIBasicType nodes by Yooperlang prim name. Primitive
  // shapes don't depend on the module they're used in, so one node per name is
  // enough — referenced from any DILocalVariable that needs it.
  const basicTypeByPrim = new Map();
  // Opaque pointer DI node — shared for every `ref T` / Task<T> / array we
  // can't yet describe structurally. lldb shows it as "(void *)".
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
    const ref = `!${id}`;
    basicTypeByPrim.set(primName, ref);
    return ref;
  }

  // DIDerivedType DW_TAG_pointer_type pointing at nothing — a generic
  // 64-bit pointer. Used for refs / arrays / Task<T> until we emit proper
  // composite DI for them.
  function opaquePointer() {
    if (opaquePointerId != null) return `!${opaquePointerId}`;
    opaquePointerId = reserve();
    emit(
      opaquePointerId,
      `!DIDerivedType(tag: DW_TAG_pointer_type, baseType: null, size: 64)`,
    );
    return `!${opaquePointerId}`;
  }

  // DILocalVariable for a parameter (argIndex >= 1) or a `let`/`const` local
  // (argIndex omitted). `typeRef` should be a basicTypeForPrim / opaquePointer
  // result, or null to skip emission entirely. Returns the `!N` ref to use as
  // the second argument of `llvm.dbg.declare`, or null if no DI is produced.
  function localVariable({ name, scope, file, line, typeRef, argIndex }) {
    if (!typeRef) return null;
    const id = reserve();
    const argPart = argIndex ? `, arg: ${argIndex}` : "";
    emit(
      id,
      `!DILocalVariable(name: ${jsonStr(name)}${argPart}, scope: ${scope}, file: ${file}, line: ${line}, type: ${typeRef})`,
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
    localVariable,
    finalize,
  };
}

// Encoding table for Yooperlang primitives -> DWARF basic types. Returns null
// for names we don't yet have DI for (string, void, etc.). Sizes are in bits.
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
    case "usize": return { size: 64, encoding: "DW_ATE_unsigned" };
    case "float":
    case "float32": return { size: 32, encoding: "DW_ATE_float" };
    case "float64": return { size: 64, encoding: "DW_ATE_float" };
    // LLVM lowers `bool` to i1 in SSA but the alloca slot is i8 (LLVM
    // rounds up to a byte), so DWARF size: 8 matches the in-memory layout
    // lldb actually reads from.
    case "bool": return { size: 8, encoding: "DW_ATE_boolean" };
    case "char": return { size: 8, encoding: "DW_ATE_unsigned_char" };
    default: return null;
  }
}

// LLVM metadata strings need C-style escaping. Path components rarely contain
// anything exotic, but quotes and backslashes (Windows paths) must be escaped.
function jsonStr(s) {
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// Regex used by codegen to decide which IR lines should carry `!dbg`. Match
// the start of a side-effecting / control-flow instruction (call, invoke,
// ret, br, store, load, switch, resume, unreachable). Pure arithmetic /
// GEP / cast / cmp / phi instructions are skipped — MVP only needs enough
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
