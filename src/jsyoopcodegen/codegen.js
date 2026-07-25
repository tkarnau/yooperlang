// LLVM IR code generator - walks the AST and creates IR code

import { parse } from "../jsyooparser/parser.js";
import { typecheck, typecheckProgram } from "../jsyooptypecheck/typecheck.js";
import { ASTNodeKind } from "../contracts.js";
import {
  ArrayType,
  PrimType,
  VoidType,
  castInstruction,
  isFloatPrim,
  isIntPrim,
  isUnsignedIntPrim,
  substituteTypeParams,
  typeKinds,
} from "../jsyooptypecheck/types.js";
import {
  isFallibleVariant,
  strippedVariantOkType,
} from "../jsyooptypecheck/fallible.js";
import { loadModuleGraph } from "../jsyoopdriver/moduleGraph.js";
import { instantiateFunc } from "../jsyooptypecheck/instantiate.js";
import { mangleTraitMethod } from "../jsyooptypecheck/mangleTraitMethod.js";
import { runComptimePass } from "../jsyoopinterp/comptimePass.js";
import { runAttributePass } from "../jsyoopattributes/pass.js";
import { createDebugInfo, annotateLinesWithDbg } from "./debugInfo.js";

// yooperlang type names -> LLVM IR type names
const LLVM_TYPES = {
  int: "i32",
  int8: "i8",
  int16: "i16",
  int32: "i32",
  int64: "i64",
  uint8: "i8",
  uint16: "i16",
  uint32: "i32",
  uint64: "i64",
  usize: "i64",
  isize: "i64",
  uintptr: "i64",
  float: "float",
  float32: "float",
  float64: "double",
  bool: "i1",
  void: "void",
  string: "ptr", // i8* - null-terminated UTF-8 pointer, llvm docs thing?
  ptr: "ptr", // default for unknown types
};

// LLVM `declare` lines for the C runtime ABI. Emitted unconditionally so the
// codegen-injected init/shutdown calls in `main` (and any future task
// scheduling) resolve at link time.
const RUNTIME_DECLARES = [
  "declare void @yoop_runtime_init()",
  "declare void @yoop_runtime_shutdown()",
  "declare void @yoop_task_submit(ptr, ptr)",
  "declare void @yoop_task_wait(ptr)",
  // Phase 10.F: bounded wait + monotonic clock for deadlines.
  "declare i32 @yoop_task_wait_until_ns(ptr, i64)",
  "declare i64 @yoop_now_ns()",
  // Phase 10.F.2: external cancellation primitive.
  "declare void @yoop_task_cancel(ptr)",
  "declare ptr @yoop_task_alloc(i64)",
  "declare void @yoop_task_retain(ptr)",
  "declare void @yoop_task_release(ptr)",
  "declare void @yoop_handle_signal_done(ptr)",
  "declare void @yoop_task_free_sync_pair(ptr)",
  "declare ptr @malloc(i64)",
  "declare void @free(ptr)",
  // Context-routed allocation (runtime/yoop_alloc.c): dispatch through the
  // current allocator. Back the ctx_alloc/ctx_free intrinsics.
  "declare ptr @yoop_ctx_alloc(i64, i64)",
  "declare void @yoop_ctx_free(ptr)",
  "declare ptr @memcpy(ptr, ptr, i64)",
  // Phase 8.D: errno bridge - see runtime/yoop_runtime.c
  "declare i32 @yoop_errno_get()",
  "declare void @yoop_errno_set(i32)",
  "declare ptr @yoop_errno_message(i32)",
  // --track-heap diagnostics. Always declared, only referenced when
  // programState.trackHeap is set (see emitBuiltinGenericCall + main fn).
  // atexit registers yoop_diag_dump so every exit path - normal return,
  // exit(), uncaught abort - prints the totals.
  "declare void @yoop_diag_record_alloc(i64)",
  "declare void @yoop_diag_record_free(i64)",
  "declare void @yoop_diag_dump()",
  "declare i32 @atexit(ptr)",
];

export function llvmType(yoopType) {
  switch (yoopType.kind) {
    case typeKinds.prim: {
      return LLVM_TYPES[yoopType.name] ?? LLVM_TYPES.ptr;
    }
    case typeKinds.struct: {
      const id = yoopType.moduleId ? `${yoopType.moduleId}__${yoopType.name}` : yoopType.name;
      return `%struct.${id}`;
    }
    case typeKinds.void: {
      return LLVM_TYPES.void;
    }
    case typeKinds.ref: {
      return LLVM_TYPES.ptr;
    }
    case typeKinds.array: {
      return `%yoop_array.${arrayElemLlvmName(yoopType.elem)}`;
    }
    case typeKinds.task: {
      // SSA values of Task<T> are pointers; the per-task struct definition
      // lives in codegen state, not in the type-system.
      return "ptr";
    }
    case typeKinds.variant: {
      const id = yoopType.moduleId ? `${yoopType.moduleId}__${yoopType.name}` : yoopType.name;
      return `%variant.${id}`;
    }
    case typeKinds.union: {
      const id = yoopType.moduleId ? `${yoopType.moduleId}__${yoopType.name}` : yoopType.name;
      return `%union.${id}`;
    }
    // Phase 12: value enums collapse to their underlying primitive at the
    // LLVM level. No nominal LLVM struct; we just route through the
    // underlying type's llvmType.
    case typeKinds.valueEnum: {
      return llvmType(yoopType.underlying);
    }
    case typeKinds.unsafePtr: {
      // Phase 8.A: LLVM opaque pointers. The pointee type is tracked in the
      // yoop type but never appears in the LLVM type signature.
      return "ptr";
    }
    case typeKinds.functionPointer: {
      // Phase 9.G: function values are LLVM `ptr` at the storage layer. The
      // typed signature lives in the yoop type and gets recovered at each
      // indirect-call site.
      return "ptr";
    }
    case typeKinds.vtable: {
      // Phase 9.G: vtables are nominal struct types - `%vtable.<mod>__<Name>`.
      const id = yoopType.moduleId ? `${yoopType.moduleId}__${yoopType.name}` : yoopType.name;
      return `%vtable.${id}`;
    }
    default: {
      throw new Error(`llvmType: unhandled yooper type kind "${yoopType.kind}"`);
    }
  }
}

// Build a Task struct symbol for a given (moduleId, taskFnName) pair. The
// returned name is the LLVM type identifier that the per-task aggregate gets
// declared under, and is what call-site codegen / thunk emission GEP into.
export function taskStructName(moduleId, taskFnName) {
  return `%Task_${moduleId}__${taskFnName}`;
}

// Mangle a yoop type into a stable suffix for struct names.
export function mangleTypeForTaskName(t) {
  if (!t) return "unknown";
  if (t.kind === typeKinds.prim) return t.name;
  if (t.kind === typeKinds.struct) {
    return t.moduleId ? `${t.moduleId}__${t.name}` : t.name;
  }
  if (t.kind === typeKinds.ref) return `ref_${mangleTypeForTaskName(t.inner)}`;
  return "unknown";
}

// Stable string key for an array element type - used in %yoop_array.<name> struct names.
function arrayElemLlvmName(elemType) {
  if (elemType.kind === typeKinds.prim) return elemType.name;
  if (elemType.kind === typeKinds.struct) {
    return elemType.moduleId ? `${elemType.moduleId}__${elemType.name}` : elemType.name;
  }
  // Phase 9.G: arrays of vtable values - `Dispatcher[]`. Each element is a
  // small struct ({ ptr ctx, ptr m1, ... }); use the vtable's mangled name
  // as the array element key so the standard fat-pointer array shape works.
  if (elemType.kind === typeKinds.vtable) {
    return elemType.moduleId
      ? `vt_${elemType.moduleId}__${elemType.name}`
      : `vt_${elemType.name}`;
  }
  // Phase 10.A: arrays of enum values - `Result<int32, int32>[]`. The mangled
  // enum name is already unique per instantiation; prefix to distinguish
  // from struct-element arrays.
  if (elemType.kind === typeKinds.variant) {
    return elemType.moduleId
      ? `enum_${elemType.moduleId}__${elemType.name}`
      : `enum_${elemType.name}`;
  }
  // Phase 10.K: arrays of function pointers - `((p: T) => R)[]`. Every
  // function pointer is a bare `ptr` at the storage layer (the typed
  // signature lives in the yoop type and is recovered at each call site), so
  // a single shared key is correct regardless of the pointed-to signature.
  if (elemType.kind === typeKinds.functionPointer) {
    return "fnptr";
  }
  throw new Error(`arrayElemLlvmName: unsupported elem type "${elemType.kind}"`);
}

function isIntType(t) {
  return t.kind === typeKinds.prim && isIntPrim(t.name);
}

function isFloatType(t) {
  return t.kind === typeKinds.prim && isFloatPrim(t.name);
}

function isWideInt(name) {
  return name === "int64" || name === "uint64" || name === "isize" || name === "usize";
}

// Phase 11.B: format a wrapped comptime value as an LLVM constant
// initializer text - the literal that follows the type in a
// `@<sym> = global <type> <literal>` line. Returns null when the
// value can't be expressed as a static LLVM constant; the caller
// falls back to `zeroinitializer` + runtime init for those.
//
// Today: primitives (int, bool, float, string). Aggregates (struct,
// array, enum) land in later 11.B sub-phases - those will return LLVM
// `{i32 5, i32 6}` / `[3 x i32] [i32 1, i32 2, i32 3]` style
// constants, but require materializing the comptime value tree into
// LLVM constant syntax which is its own pass.
//
// String folding produces a private `[N x i8]` constant alongside the
// caller's global; we don't have direct access to the closure's
// `globals` array from this top-level helper, so the caller passes an
// `emitRawStringGlobal` callback that does the append. When the
// callback is missing (e.g. unit-testing the formatter in isolation),
// string folding falls back to null and the decl stays on the runtime
// init path.
function comptimeValueAsLlvmInit(wrapped, ty, opts = {}) {
  if (wrapped == null) return null;
  if (ty.kind === typeKinds.array) {
    // Yoop arrays are fat-pointers `{ ptr, i64 }`. The init has two
    // pieces: a private `[N x <elem>]` backing buffer, and the
    // fat-pointer constant `{ ptr @.arr.X, i64 N }`.
    if (typeof opts.emitRawArrayGlobal !== "function") return null;
    const elemTy = ty.elem;
    const buf = wrapped.v?.buf ?? [];
    const len = buf.length;
    const elemLlvm = llvmType(elemTy);
    const elemInits = [];
    for (const elem of buf) {
      const elemInit = comptimeValueAsLlvmInit(elem, elemTy, opts);
      if (elemInit == null) return null;
      elemInits.push(`${elemLlvm} ${elemInit}`);
    }
    const backingSym = opts.emitRawArrayGlobal({
      elemLlvm,
      count: len,
      elemInits,
    });
    return `{ ptr ${backingSym}, i64 ${len} }`;
  }
  if (ty.kind === typeKinds.struct) {
    // Each field is rendered as `<fieldTy> <init>` and wrapped in
    // braces. The outer struct type is supplied by the global's
    // `<Type>` slot, so the constant itself doesn't need a type
    // prefix. Field order follows the declared StructType.fields
    // order (lowering already normalized into it).
    const fields = ty.fields ?? [];
    const parts = [];
    for (const f of fields) {
      const inner = wrapped.v?.[f.name];
      const innerInit = comptimeValueAsLlvmInit(inner, f.type, opts);
      if (innerInit == null) return null;
      parts.push(`${llvmType(f.type)} ${innerInit}`);
    }
    return `{ ${parts.join(", ")} }`;
  }
  if (ty.kind !== typeKinds.prim) return null;
  const name = ty.name;
  if (name === "bool") return wrapped.v ? "1" : "0";
  if (isFloatPrim(name)) {
    // LLVM accepts ordinary decimal for `float` / `double` in IR text,
    // but rejects bare integers in float position (`42` won't parse as
    // a float; `42.0` will). Force a fractional digit when JS's default
    // toString omits one. Special values (NaN, Inf) would need
    // LLVM-specific spellings - refuse to fold them.
    const n = Number(wrapped.v);
    if (!Number.isFinite(n)) return null;
    const s = n.toString();
    return /[.eE]/.test(s) ? s : `${s}.0`;
  }
  if (isIntPrim(name)) {
    // BigInt and Number both stringify into LLVM-acceptable integer
    // literal syntax. `Number(BigInt)` would lose range for 64-bit
    // values; calling .toString() avoids that.
    return wrapped.v.toString();
  }
  if (name === "string") {
    if (typeof opts.emitRawStringGlobal !== "function") return null;
    // Comptime string values store the unquoted, unescaped JS string.
    // Re-encode through the same path as inline literals so escape
    // sequences (\n, \t, ...) round-trip identically to today.
    const inner = encodeStringForRawGlobal(wrapped.v);
    const { name: strSym } = opts.emitRawStringGlobal(inner);
    return strSym;
  }
  return null;
}

// Convert a JS-side string (from a comptime-folded value) into the
// "inner" form that emitRawStringGlobal/encodeStringBytes expects -
// i.e. with literal escape sequences re-escaped so encodeStringBytes
// emits them as LLVM byte-array escape codes. JS already decoded \n
// to a newline character; we need to re-encode it as the two-char
// sequence `\n` so encodeStringBytes can map it back to `\0A`.
function encodeStringForRawGlobal(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = ch.charCodeAt(0);
    if (ch === "\\") { out += "\\\\"; continue; }
    if (ch === '"')  { out += '\\"';  continue; }
    if (ch === "\n") { out += "\\n";  continue; }
    if (ch === "\t") { out += "\\t";  continue; }
    if (ch === "\r") { out += "\\r";  continue; }
    if (code === 0)  { out += "\\0";  continue; }
    out += ch; // encodeStringBytes handles non-printables via hex
  }
  return out;
}

// Phase 12: a value enum collapses to its underlying primitive at the LLVM
// level, so for any printf/varargs purpose it behaves exactly as that
// primitive. Unwrap once here so format-spec and promotion logic stay simple.
function valueEnumUnderlying(t) {
  return t && t.kind === typeKinds.valueEnum ? t.underlying : t;
}

// pick a printf format specifier for a yooper type
export function printfSpec(t) {
  t = valueEnumUnderlying(t);
  if (t.kind === typeKinds.struct) {
    throw new Error(
      `codegen bug: struct ${t.name} reached printf - typechecker should have rejected`,
    );
  }
  if (t.kind === typeKinds.prim) {
    if (t.name === "string") return "%s";
    if (t.name === "bool") return "%d";
    if (isIntPrim(t.name)) return isWideInt(t.name) ? "%lld" : "%d";
    if (isFloatPrim(t.name)) return t.name === "float64" ? "%lf" : "%f";
  }
  throw new Error(
    `printf: don't know how to format yooper type "${t.kind}/${t.name ?? ""}"`,
  );
}

// when a value is passed through C variadic printf, small ints/floats get
// promoted. report the LLVM type that the call site should use.
function promotedLlvmType(t) {
  t = valueEnumUnderlying(t);
  if (t.kind === typeKinds.prim) {
    if (t.name === "string") return "ptr";
    if (t.name === "bool") return "i32";
    if (isIntPrim(t.name)) return isWideInt(t.name) ? "i64" : "i32";
    if (isFloatPrim(t.name)) return "double";
  }
  return "ptr";
}

// escape a JS-source-form string (the inner content, without surrounding
// quotes) into LLVM byte-array constant form. returns { llvmStr, byteLen }
// where byteLen INCLUDES the trailing null terminator.
function encodeStringBytes(inner) {
  let bytes = "";
  let byteLen = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      i++;
      switch (inner[i]) {
        case "n":
          bytes += "\\0A";
          byteLen++;
          break;
        case "t":
          bytes += "\\09";
          byteLen++;
          break;
        case "r":
          bytes += "\\0D";
          byteLen++;
          break;
        case "0":
          bytes += "\\00";
          byteLen++;
          break;
        case "\\":
          bytes += "\\5C";
          byteLen++;
          break;
        case '"':
          bytes += "\\22";
          byteLen++;
          break;
        case "`":
          bytes += "`";
          byteLen++;
          break;
        case "$":
          bytes += "$";
          byteLen++;
          break;
        default:
          bytes += inner[i];
          byteLen++;
          break;
      }
    } else if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) > 0x7e) {
      const hex = ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
      bytes += `\\${hex}`;
      byteLen++;
    } else if (ch === '"') {
      // Template literal STRING_PARTs preserve raw characters between the
      // backticks (see parser's parseTemplateLiteralBody), so a literal
      // `"` reaches us unescaped. LLVM c-string literals use `"` as the
      // closing delimiter, so we must hex-escape it; without this the
      // emitted constant has the wrong [N x i8] length and clang rejects
      // the IR with a type mismatch.
      bytes += "\\22";
      byteLen++;
    } else if (ch === "\\") {
      // Mirror of the `"` case: a stray `\` would also corrupt the
      // LLVM string literal. In practice the escape-pair branch above
      // consumes every well-formed `\X`; this handles the trailing-`\`
      // edge case defensively.
      bytes += "\\5C";
      byteLen++;
    } else {
      bytes += ch;
      byteLen++;
    }
  }
  bytes += "\\00";
  byteLen++;
  return { llvmStr: bytes, byteLen };
}

// LLVM gotcha: only allocas in a function's entry block are "static" and
// released as part of the prologue/epilogue. An alloca emitted in any other
// block becomes a *dynamic* alloca - it adjusts the stack pointer at runtime
// and that adjustment isn't undone until the whole function returns. So an
// alloca inside a loop body leaks stack on every iteration. For long-running
// main loops (e.g. an SDL render loop) this eventually overflows the stack.
//
// Every Yoop alloca has a compile-time-constant size and depends on no prior
// SSA value, so unconditionally moving them into the entry block is safe and
// matches the canonical LLVM idiom.
function hoistAllocasToEntry(fnLines) {
  // fnLines[0] is `define ... {`, fnLines[1] is `entry:`. Find the entry
  // block's terminator (the first br/ret/unreachable/switch/invoke after the
  // entry label) and lift any alloca that appears past it into a position
  // right before that terminator. Inserting before the label of the next
  // block instead would land *between* the terminator and that label - which
  // is invalid IR.
  const terminatorRe = /^\s+(br|ret|unreachable|switch|resume|invoke)\b/;
  let entryTerm = -1;
  for (let i = 2; i < fnLines.length; i++) {
    if (terminatorRe.test(fnLines[i])) { entryTerm = i; break; }
  }
  if (entryTerm === -1) return;

  const allocaRe = /^\s+%\S+\s*=\s*alloca\b/;
  const hoisted = [];
  for (let i = fnLines.length - 1; i > entryTerm; i--) {
    if (allocaRe.test(fnLines[i])) {
      hoisted.push(fnLines[i]);
      fnLines.splice(i, 1);
    }
  }
  if (hoisted.length === 0) return;
  hoisted.reverse();
  fnLines.splice(entryTerm, 0, ...hoisted);
}

// Phase 10.H: per-function local-symbol container with LLVM-slot
// uniquification + lexical scope stacking.
//
// The classic symptom this addresses: two `case Option.Some { value: v }`
// arms in the same function each emit `%v = alloca i32`, and clang
// rejects the module with "multiple definition of local value 'v'".
// More broadly the same shape appears for any `let x` in two disjoint
// blocks, or any user binding name reused across non-overlapping scopes.
//
// Contract:
//   * `set(name, type)` / `get(name)` / `has(name)` keep the existing
//     Map-like surface for callers that only care about the binding's
//     type (function-decl tracking, etc.).
//   * `declare(name, type)` is the new combined "register a local binding
//     and allocate a unique LLVM slot for it" - returns the slot string
//     (with leading `%`). Use this any time an alloca is about to be
//     emitted for a user-visible binding.
//   * `slotFor(name)` returns the LLVM slot string. Use it any time the
//     emitter would otherwise hard-code `%${name}`. Falls back to
//     `%${name}` for legacy reads (so non-migrated paths still link).
//   * `enterScope()` / `leaveScope()` bracket a lexical scope; every
//     `declare` inside the scope is restored on `leaveScope`. The outer
//     binding (if any was shadowed) snaps back into place.
function createLocalSymbols() {
  const types = new Map();        // name -> yoopType
  const slotMap = new Map();      // name -> "%llvmSlot" (current binding)
  // Seed usedSlots with names that collide with LLVM basic-block labels
  // the emitter always produces. Most prominently, every function starts
  // with an `entry:` block - if the user binds `entry`, `%entry = alloca`
  // collides with that label's `%entry` reference. By marking `entry` as
  // already-taken, `declare` falls through to `entry.1` for the first
  // user binding of that name.
  const usedSlots = new Set(["entry"]);
  const slotScopes = [[]];        // stack of [{name, prevSlot}] frames

  function declare(name, type) {
    types.set(name, type);
    let candidate = name;
    if (usedSlots.has(candidate)) {
      let n = 1;
      while (usedSlots.has(`${name}.${n}`)) n++;
      candidate = `${name}.${n}`;
    }
    usedSlots.add(candidate);
    const slot = `%${candidate}`;
    slotScopes[slotScopes.length - 1].push({ name, prevSlot: slotMap.get(name) });
    slotMap.set(name, slot);
    return slot;
  }

  return {
    set(name, type) { types.set(name, type); },
    get(name) { return types.get(name); },
    has(name) { return types.has(name); },
    declare,
    slotFor(name) { return slotMap.get(name) ?? `%${name}`; },
    enterScope() { slotScopes.push([]); },
    leaveScope() {
      const frame = slotScopes.pop();
      for (let i = frame.length - 1; i >= 0; i--) {
        const { name, prevSlot } = frame[i];
        if (prevSlot !== undefined) slotMap.set(name, prevSlot);
        else slotMap.delete(name);
      }
    },
  };
}

export function codegen(ast) {
  const lines = [];
  const globals = [];
  const structDefs = [];
  const emittedArrayTypes = new Set();
  let strConstCounter = 0;
  let tempCounter = 0;
  let labelCounter = 0;

  // populated up front from top-level functionDecl nodes
  const functionSigs = new Map(); // name -> { params: [yoopType], returnType: yoopType }

  // populated per-function during codegen
  let symbols = createLocalSymbols();

  function freshTemp() {
    return `%t${tempCounter++}`;
  }

  function freshStrGlobal() {
    return `@.str${strConstCounter++}`;
  }

  function freshLabel(hint) {
    return `${hint}_${labelCounter++}`;
  }

  function ensureArrayTypeDef(elemType) {
    const name = llvmType({ kind: typeKinds.array, elem: elemType });
    if (!emittedArrayTypes.has(name)) {
      emittedArrayTypes.add(name);
      structDefs.push(`${name} = type { ptr, i64 }`);
    }
  }

  // emit a string global from a *quoted* source-form value (e.g. `"hello\n"`).
  function emitQuotedStringGlobal(quotedValue) {
    const inner = quotedValue.slice(1, -1);
    return emitRawStringGlobal(inner);
  }

  // emit a string global from the already-unquoted inner content.
  function emitRawStringGlobal(inner) {
    const name = freshStrGlobal();
    const { llvmStr, byteLen } = encodeStringBytes(inner);
    globals.push(
      `${name} = private unnamed_addr constant [${byteLen} x i8] c"${llvmStr}", align 1`,
    );
    return { name, byteLen };
  }

  // alignment for a named-struct alloca: max alignment over the fields. nested
  // structs recurse. empty structs align to 1.
  // Phase 6.5: if the struct has a type-level kind application carrying a
  // `layout { align N }`, raise to max(natural, N).
  function alignOfStruct(structType) {
    const fields = structType.fields ?? [];
    let max = fields.length === 0 ? 1 : 1;
    for (const f of fields) {
      const a = f.type.kind === typeKinds.struct
        ? alignOfStruct(f.type)
        : alignOf(llvmType(f.type));
      if (a > max) max = a;
    }
    const typeAlign = typeLevelAlign(structType);
    if (typeAlign && typeAlign > max) max = typeAlign;
    return max;
  }

  // Phase 6.5: read the substituted layout-align value from a struct's
  // type-level KindApplication, or null if none.
  function typeLevelAlign(structType) {
    const app = structType?.kindApplication;
    if (!app) return null;
    const slot = app.kindType?.layoutAlign;
    if (!slot) return null;
    if (slot.kind === "const") return slot.value;
    if (slot.kind === "param") {
      const idx = app.kindType.params.findIndex((p) => p.name === slot.name);
      if (idx < 0 || idx >= app.args.length) return null;
      return app.args[idx];
    }
    return null;
  }

  // Phase 6.5: effective alignment for a binding site. Consults the
  // binding-site KindApplication first, then falls back to the struct's
  // type-level alignment (already folded into alignOfStruct).
  function effectiveAlign(declType, kindApp) {
    if (kindApp) {
      const slot = kindApp.kindType?.layoutAlign;
      if (slot) {
        if (slot.kind === "const") return slot.value;
        if (slot.kind === "param") {
          const idx = kindApp.kindType.params.findIndex((p) => p.name === slot.name);
          if (idx >= 0 && idx < kindApp.args.length) return kindApp.args[idx];
        }
      }
    }
    if (declType?.kind === typeKinds.struct) return alignOfStruct(declType);
    return alignOf(llvmType(declType));
  }

  // walk an lvalue node and return { ptr, type } where ptr addresses the
  // storage and type is the yoop Type at that location. parallel to emitExpr,
  // but loads are deferred to the caller.
  function emitLvalue(node, fnLines) {
    switch (node.kind) {
      case ASTNodeKind.IDENT: {
        const t = symbols.get(node.name);
        if (!t) throw new Error(`codegen: unknown identifier "${node.name}"`);
        if (t.kind === typeKinds.ref) {
          // ref binding (e.g. self): load the actual pointer from its alloca slot
          const ptrTmp = freshTemp();
          fnLines.push(`  ${ptrTmp} = load ptr, ptr ${symbols.slotFor(node.name)}`);
          return { ptr: ptrTmp, type: t.inner };
        }
        return { ptr: `${symbols.slotFor(node.name)}`, type: t };
      }
      case ASTNodeKind.FIELD_ACCESS: {
        const base = emitLvalue(node.object, fnLines);
        if (base.type.kind !== typeKinds.struct) {
          throw new Error(
            `codegen: field access on non-struct type - typechecker should have caught this`,
          );
        }
        const idx = base.type.fields.findIndex((f) => f.name === node.field);
        if (idx < 0) {
          throw new Error(
            `codegen: struct ${base.type.name} has no field "${node.field}"`,
          );
        }
        const fieldType = base.type.fields[idx].type;
        const gepTmp = freshTemp();
        fnLines.push(
          `  ${gepTmp} = getelementptr inbounds ${llvmType(base.type)}, ptr ${base.ptr}, i32 0, i32 ${idx}`,
        );
        return { ptr: gepTmp, type: fieldType };
      }
      case ASTNodeKind.INDEX_EXPRESSION: {
        const base = emitLvalue(node.object, fnLines);
        const arrayLlvmTy = llvmType(base.type);
        const dataPtrField = freshTemp();
        fnLines.push(`  ${dataPtrField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${base.ptr}, i32 0, i32 0`);
        const dataPtr = freshTemp();
        fnLines.push(`  ${dataPtr} = load ptr, ptr ${dataPtrField}`);
        const idx = emitExpr(node.index, fnLines);
        const elemLlvmTy = llvmType(base.type.elem);
        const elemPtr = freshTemp();
        fnLines.push(`  ${elemPtr} = getelementptr inbounds ${elemLlvmTy}, ptr ${dataPtr}, ${llvmType(idx.yoopType)} ${idx.val}`);
        return { ptr: elemPtr, type: base.type.elem };
      }
      default: {
        // r-value treated as an lvalue (e.g. `make_pair().a`): materialize
        // the value into a fresh alloca and return a pointer to it.
        const r = emitExpr(node, fnLines);
        const t = r.yoopType;
        const llvmTy = llvmType(t);
        const slot = freshTemp();
        const align = t.kind === typeKinds.struct
          ? alignOfStruct(t)
          : alignOf(llvmTy);
        fnLines.push(`  ${slot} = alloca ${llvmTy}, align ${align}`);
        fnLines.push(`  store ${llvmTy} ${r.val}, ptr ${slot}`);
        return { ptr: slot, type: t };
      }
    }
  }

  // populate an already-allocated struct slot field-by-field. nested struct
  // literals write directly into the corresponding GEP - no temp alloca.
  function emitStructLiteralInto(litNode, destPtr, structType, fnLines) {
    for (const litField of litNode.fields) {
      const idx = structType.fields.findIndex((f) => f.name === litField.name);
      const fieldType = structType.fields[idx].type;
      const gepTmp = freshTemp();
      fnLines.push(
        `  ${gepTmp} = getelementptr inbounds ${llvmType(structType)}, ptr ${destPtr}, i32 0, i32 ${idx}`,
      );
      if (
        litField.value.kind === ASTNodeKind.STRUCT_LITERAL &&
        fieldType.kind === typeKinds.struct
      ) {
        emitStructLiteralInto(litField.value, gepTmp, fieldType, fnLines);
      } else {
        const rhs = emitExpr(litField.value, fnLines);
        fnLines.push(
          `  store ${llvmType(fieldType)} ${rhs.val}, ptr ${gepTmp}`,
        );
      }
    }
  }

  // lower `expr?` up to the err check, returning the on-stack slot that
  // holds the operand's enum value. Phase 9.H - fallible-enum shape only:
  //   <eval operand> -> %tmp
  //   alloca + store on stack
  //   load i32 tag at field 0; compare to Err ordinal
  //   try_fail: GEP into Err payload, build enclosing return's Err variant
  //             carrying the same payload bytes, ret
  //   try_ok:  control resumes here for the Ok payload extraction
  //
  // The Phase 2 fallible-struct shape was retired in Phase 10.X; only the
  // enum form remains.
  function emitTryOpToSlot(node, fnLines) {
    const operandEnum = node.operand.resolvedType;
    const r = emitExpr(node.operand, fnLines);
    const enumLlvm = llvmType(operandEnum);
    const slot = freshTemp();
    fnLines.push(`  ${slot} = alloca ${enumLlvm}, align ${sizeOfAlign(operandEnum)}`);
    fnLines.push(`  store ${enumLlvm} ${r.val}, ptr ${slot}`);

    const tagPtr = freshTemp();
    fnLines.push(`  ${tagPtr} = getelementptr inbounds ${enumLlvm}, ptr ${slot}, i32 0, i32 0`);
    const tagVal = freshTemp();
    fnLines.push(`  ${tagVal} = load i32, ptr ${tagPtr}`);

    const errVariant = operandEnum.variants.get("Err");
    const failed = freshTemp();
    fnLines.push(`  ${failed} = icmp eq i32 ${tagVal}, ${errVariant.ordinal}`);

    const failLabel = freshLabel("try_fail");
    const okLabel = freshLabel("try_ok");
    fnLines.push(`  br i1 ${failed}, label %${failLabel}, label %${okLabel}`);

    fnLines.push(`${failLabel}:`);
    emitFailEnumReturn(node, operandEnum, slot, currentReturnType, fnLines);

    fnLines.push(`${okLabel}:`);
    return { ptr: slot, type: operandEnum };
  }

  // Phase 9.H + 10.E: build the enclosing function's return-type Err
  // variant carrying the operand's Err payload, then ret. operandEnumSlot
  // points to the operand's enum struct (tag has already been checked ==
  // Err ordinal); we GEP into its payload bytes and either copy the single
  // payload field directly (Phase 9.H - typesEqual fast path) or call the
  // operand-err type's `Into<RetErr>.into(ref self)` impl and store its
  // result (Phase 10.E - cross-shape path, gated on `tryNode.tryConvert`).
  function emitFailEnumReturn(tryNode, operandEnum, operandEnumSlot, retEnumType, fnLines) {
    const retLlvm = llvmType(retEnumType);
    const retSlot = freshTemp();
    fnLines.push(`  ${retSlot} = alloca ${retLlvm}, align ${sizeOfAlign(retEnumType)}`);
    fnLines.push(`  store ${retLlvm} zeroinitializer, ptr ${retSlot}`);

    const retErr = retEnumType.variants.get("Err");
    const tagPtr = freshTemp();
    fnLines.push(`  ${tagPtr} = getelementptr inbounds ${retLlvm}, ptr ${retSlot}, i32 0, i32 0`);
    fnLines.push(`  store i32 ${retErr.ordinal}, ptr ${tagPtr}`);

    // Copy the Err payload (if any) from operand into return value.
    const operandErr = operandEnum.variants.get("Err");
    const hasPayload =
      operandErr.fields !== null && operandErr.fields.length > 0
      && retErr.fields !== null && retErr.fields.length > 0;
    if (hasPayload) {
      const operandEnumId = operandEnum.moduleId
        ? `${operandEnum.moduleId}__${operandEnum.name}`
        : operandEnum.name;
      const retEnumId = retEnumType.moduleId
        ? `${retEnumType.moduleId}__${retEnumType.name}`
        : retEnumType.name;
      const operandPayloadLlvm = `%variantc.${operandEnumId}__Err`;
      const retPayloadLlvm = `%variantc.${retEnumId}__Err`;
      const operandFieldType = operandErr.fields[0].type;
      const retFieldType = retErr.fields[0].type;

      const opPayloadPtr = freshTemp();
      fnLines.push(`  ${opPayloadPtr} = getelementptr inbounds ${llvmType(operandEnum)}, ptr ${operandEnumSlot}, i32 0, i32 1`);
      const opFieldPtr = freshTemp();
      fnLines.push(`  ${opFieldPtr} = getelementptr inbounds ${operandPayloadLlvm}, ptr ${opPayloadPtr}, i32 0, i32 0`);

      const retPayloadPtr = freshTemp();
      fnLines.push(`  ${retPayloadPtr} = getelementptr inbounds ${retLlvm}, ptr ${retSlot}, i32 0, i32 1`);
      const retFieldPtr = freshTemp();
      fnLines.push(`  ${retFieldPtr} = getelementptr inbounds ${retPayloadLlvm}, ptr ${retPayloadPtr}, i32 0, i32 0`);

      if (tryNode.tryConvert) {
        // Phase 10.E: cross-shape - call Into.into(ref operandErr) and
        // store the returned target value.
        const retFieldLlvm = llvmType(retFieldType);
        const converted = freshTemp();
        fnLines.push(`  ${converted} = call ${retFieldLlvm} @${tryNode.tryConvert.mangledName}(ptr ${opFieldPtr})`);
        fnLines.push(`  store ${retFieldLlvm} ${converted} , ptr ${retFieldPtr}`);
      } else {
        const fieldLlvm = llvmType(operandFieldType);
        const fieldVal = freshTemp();
        fnLines.push(`  ${fieldVal} = load ${fieldLlvm}, ptr ${opFieldPtr}`);
        fnLines.push(`  store ${fieldLlvm} ${fieldVal}, ptr ${retFieldPtr}`);
      }
    }

    const retVal = freshTemp();
    fnLines.push(`  ${retVal} = load ${retLlvm}, ptr ${retSlot}`);
    if (inMainFn) fnLines.push("  call void @yoop_runtime_shutdown()");
    fnLines.push(`  ret ${retLlvm} ${retVal}`);
  }

  // Track the enclosing function's return type for emitFailEnumReturn.
  // Set in emitFunction; consumed inside emitTryOpToSlot.
  let currentReturnType = null;

  // True while emitting the body of `main` (the program's C entry point).
  // Consumed at every `ret` site so we can inject yoop_runtime_shutdown().
  let inMainFn = false;

  // Set by codegenProgram for each module. null in single-module mode.
  let currentModuleId = null;
  // Names of extern functions in the current module - not mangled.
  let currentExternNames = new Set();

  // Phase 8.A: pointer-arithmetic / pointer-comparison emitter. Called by
  // BINARY_EXPRESSION when at least one operand is an unsafe_ptr<T> or null.
  function emitPointerBinary(node, fnLines) {
    const op = node.op;
    if (op === "eqeq" || op === "neq") {
      const l = emitExpr(node.left, fnLines);
      const r = emitExpr(node.right, fnLines);
      const cond = op === "eqeq" ? "eq" : "ne";
      const tmp = freshTemp();
      fnLines.push(`  ${tmp} = icmp ${cond} ptr ${l.val}, ${r.val}`);
      return { val: tmp, yoopType: PrimType("bool") };
    }
    if (op === "plus" || op === "minus") {
      const leftIsPtr =
        node.left.resolvedType?.kind === typeKinds.unsafePtr;
      const rightIsPtr =
        node.right.resolvedType?.kind === typeKinds.unsafePtr;
      // ptr - ptr: ptrtoint both, sub, sdiv by sizeof(pointee).
      if (leftIsPtr && rightIsPtr && op === "minus") {
        const l = emitExpr(node.left, fnLines);
        const r = emitExpr(node.right, fnLines);
        const li = freshTemp();
        const ri = freshTemp();
        fnLines.push(`  ${li} = ptrtoint ptr ${l.val} to i64`);
        fnLines.push(`  ${ri} = ptrtoint ptr ${r.val} to i64`);
        const diff = freshTemp();
        fnLines.push(`  ${diff} = sub i64 ${li}, ${ri}`);
        const pointee = node.left.resolvedType.pointee;
        const elemLlvmTy = llvmType(pointee);
        const sizeofTmp = freshTemp();
        // `getelementptr <T>, ptr null, i32 1` gives sizeof(T) - standard trick.
        fnLines.push(
          `  ${sizeofTmp} = getelementptr ${elemLlvmTy}, ptr null, i32 1`,
        );
        const sizeInt = freshTemp();
        fnLines.push(`  ${sizeInt} = ptrtoint ptr ${sizeofTmp} to i64`);
        const out = freshTemp();
        fnLines.push(`  ${out} = sdiv i64 ${diff}, ${sizeInt}`);
        return { val: out, yoopType: PrimType("int64") };
      }
      // ptr +/- int (or int + ptr): emit GEP.
      const ptrSide = leftIsPtr ? node.left : node.right;
      const intSide = leftIsPtr ? node.right : node.left;
      const ptrVal = emitExpr(ptrSide, fnLines);
      const intVal = emitExpr(intSide, fnLines);
      const pointee = ptrSide.resolvedType.pointee;
      const elemLlvmTy = llvmType(pointee);
      // For `p - n`, negate the offset.
      let offsetVal = intVal.val;
      let offsetLlvmTy = llvmType(intVal.yoopType);
      if (
        intVal.yoopType.kind === typeKinds.untypedInt ||
        (intVal.yoopType.kind === typeKinds.prim &&
          intVal.yoopType.name !== "int64")
      ) {
        // Widen non-int64 offsets to i64 for GEP. Sign-extend for signed
        // ints, zero-extend for unsigned - defer that nuance, sext is fine
        // for the integer ranges typical of FFI offsets.
        if (offsetLlvmTy !== "i64") {
          const widened = freshTemp();
          fnLines.push(`  ${widened} = sext ${offsetLlvmTy} ${offsetVal} to i64`);
          offsetVal = widened;
          offsetLlvmTy = "i64";
        }
      }
      if (op === "minus") {
        const neg = freshTemp();
        fnLines.push(`  ${neg} = sub i64 0, ${offsetVal}`);
        offsetVal = neg;
      }
      const out = freshTemp();
      fnLines.push(
        `  ${out} = getelementptr ${elemLlvmTy}, ptr ${ptrVal.val}, i64 ${offsetVal}`,
      );
      return { val: out, yoopType: ptrSide.resolvedType };
    }
    throw new Error(`codegen: unsupported pointer binary op "${op}"`);
  }

  // ** expression codegen ************************************************
  // each emitExpr returns { val, yoopType } where val is an SSA name or
  // an integer literal, and yoopType is the canonical yooper type.

  function emitExpr(node, fnLines) {
    switch (node.kind) {
      case ASTNodeKind.INT_LITERAL: {
        // untyped int literals reach codegen only when used in a context where
        // their type doesn't matter for the IR text (e.g. as the immediate
        // operand of an add); default to int32 so llvmType has something valid.
        const t = node.resolvedType.kind === typeKinds.untypedInt
          ? PrimType("int32")
          : node.resolvedType;
        return { val: String(node.value), yoopType: t };
      }
      case ASTNodeKind.FLOAT_LITERAL: {
        const t = node.resolvedType.kind === typeKinds.untypedFloat
          ? PrimType("float64")
          : node.resolvedType;
        return { val: llvmFloatConstant(node.value, t.name), yoopType: t };
      }
      case ASTNodeKind.STRING_LITERAL: {
        const { name, byteLen } = emitQuotedStringGlobal(node.value);
        const tmp = freshTemp();
        fnLines.push(
          `  ${tmp} = getelementptr inbounds [${byteLen} x i8], ptr ${name}, i32 0, i32 0`,
        );
        return { val: tmp, yoopType: PrimType("string") };
      }

      case ASTNodeKind.BOOL_LITERAL: {
        return { val: node.value ? "1" : "0", yoopType: PrimType("bool") };
      }

      case ASTNodeKind.IDENT: {
        const yoopType = symbols.get(node.name);
        if (!yoopType) {
          throw new Error(`codegen: unknown identifier "${node.name}"`);
        }
        if (node.autoDeref) {
          const innerType = yoopType.inner;
          const ptrTmp = freshTemp();
          fnLines.push(`  ${ptrTmp} = load ptr, ptr ${symbols.slotFor(node.name)}`);
          const valTmp = freshTemp();
          fnLines.push(`  ${valTmp} = load ${llvmType(innerType)}, ptr ${ptrTmp}`);
          return { val: valTmp, yoopType: innerType };
        }
        const llvmTy = llvmType(yoopType);
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = load ${llvmTy}, ptr ${symbols.slotFor(node.name)}`);
        return { val: tmp, yoopType };
      }

      case ASTNodeKind.REF_EXPRESSION: {
        if (node.operand.kind === ASTNodeKind.IDENT) {
          const operandType = symbols.get(node.operand.name);
          if (operandType?.kind === typeKinds.ref) {
            // ref of a ref binding (like `ref self`): forward the underlying pointer
            const ptrTmp = freshTemp();
            fnLines.push(`  ${ptrTmp} = load ptr, ptr ${symbols.slotFor(node.operand.name)}`);
            return { val: ptrTmp, yoopType: node.resolvedType };
          }
          return { val: `${symbols.slotFor(node.operand.name)}`, yoopType: node.resolvedType };
        }
        // field access or index: use emitLvalue to get the address
        const lv = emitLvalue(node.operand, fnLines);
        return { val: lv.ptr, yoopType: node.resolvedType };
      }

      case ASTNodeKind.CALL_EXPRESSION: {
        return emitCall(node, fnLines);
      }

      case ASTNodeKind.BINARY_EXPRESSION: {
        // Phase 8.A: pointer arithmetic and pointer/null comparisons branch
        // off the integer/float path. Detect via operand resolvedType.
        const leftTy = node.left.resolvedType;
        const rightTy = node.right.resolvedType;
        const leftIsPtr = leftTy?.kind === typeKinds.unsafePtr;
        const rightIsPtr = rightTy?.kind === typeKinds.unsafePtr;
        const leftIsNull = leftTy?.kind === typeKinds.untypedNull;
        const rightIsNull = rightTy?.kind === typeKinds.untypedNull;
        if (leftIsPtr || rightIsPtr || leftIsNull || rightIsNull) {
          return emitPointerBinary(node, fnLines);
        }
        // Enum equality: extract the i32 tag from each operand and icmp.
        // Typecheck has already verified both sides are the same enum
        // type (see plans/archive/yoopbinder-papercuts.md Issue 3). Payloads are
        // intentionally not compared - tag-only matches the documented
        // semantics; structural payload comparison stays a `switch` job.
        if (
          (node.op === "eqeq" || node.op === "neq") &&
          leftTy?.kind === typeKinds.variant &&
          rightTy?.kind === typeKinds.variant
        ) {
          const l = emitExpr(node.left, fnLines);
          const r = emitExpr(node.right, fnLines);
          const enumLlvm = llvmType(leftTy);
          const lTag = freshTemp();
          const rTag = freshTemp();
          fnLines.push(`  ${lTag} = extractvalue ${enumLlvm} ${l.val}, 0`);
          fnLines.push(`  ${rTag} = extractvalue ${enumLlvm} ${r.val}, 0`);
          const cond = node.op === "eqeq" ? "eq" : "ne";
          const out = freshTemp();
          fnLines.push(`  ${out} = icmp ${cond} i32 ${lTag}, ${rTag}`);
          return { val: out, yoopType: PrimType("bool") };
        }
        const l = emitExpr(node.left, fnLines);
        const r = emitExpr(node.right, fnLines);
        const resultType = node.resolvedType;
        // for comparisons, the instruction operates on the operand type, not the result (bool)
        const isCmp = ["eqeq", "neq", "lt", "gt", "lte", "gte"].includes(node.op);
        const opType = isCmp ? l.yoopType : resultType;
        const llvmTy = llvmType(opType);
        const tmp = freshTemp();
        const instr = binaryInstruction(node.op, opType);
        fnLines.push(`  ${tmp} = ${instr} ${llvmTy} ${l.val}, ${r.val}`);
        return { val: tmp, yoopType: resultType };
      }

      case ASTNodeKind.NULL_LITERAL: {
        // Phase 8.A: pinned to UnsafePtrType by the typechecker via
        // resolvedType. The LLVM constant for any pointer null is `null`.
        return { val: "null", yoopType: node.resolvedType };
      }

      case ASTNodeKind.ADDRESS_OF_EXPRESSION: {
        // Phase 8.A: lvalue-only operand; reuse emitLvalue to materialize
        // the address. The yoop result type is unsafe_ptr<T>.
        const lv = emitLvalue(node.operand, fnLines);
        return { val: lv.ptr, yoopType: node.resolvedType };
      }

      case ASTNodeKind.DEREF_EXPRESSION: {
        // Phase 8.A: rvalue load through an unsafe_ptr<T>.
        const p = emitExpr(node.operand, fnLines);
        const pointee = node.resolvedType;
        const llvmTy = llvmType(pointee);
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = load ${llvmTy}, ptr ${p.val}`);
        return { val: tmp, yoopType: pointee };
      }

      case ASTNodeKind.ERRNO_INTRINSIC: {
        // Phase 8.D: lower to runtime helpers in yoop_runtime.c.
        if (node.op === "get") {
          const tmp = freshTemp();
          fnLines.push(`  ${tmp} = call i32 @yoop_errno_get()`);
          return { val: tmp, yoopType: PrimType("int32") };
        }
        if (node.op === "set") {
          const arg = emitExpr(node.operand, fnLines);
          fnLines.push(`  call void @yoop_errno_set(i32 ${arg.val})`);
          return { val: "", yoopType: VoidType() };
        }
        if (node.op === "message") {
          const arg = emitExpr(node.operand, fnLines);
          const tmp = freshTemp();
          fnLines.push(`  ${tmp} = call ptr @yoop_errno_message(i32 ${arg.val})`);
          return { val: tmp, yoopType: PrimType("string") };
        }
        throw new Error(`codegen: unknown errno intrinsic "${node.op}"`);
      }

      case ASTNodeKind.UNSAFE_PTR_CAST: {
        // Phase 8.A: bitcast / ptrtoint / inttoptr.
        const operand = emitExpr(node.operand, fnLines);
        if (node.castKind === "bitcast") {
          return { val: operand.val, yoopType: node.resolvedType };
        }
        if (node.castKind === "toInt") {
          const tmp = freshTemp();
          fnLines.push(`  ${tmp} = ptrtoint ptr ${operand.val} to i64`);
          return { val: tmp, yoopType: PrimType("uintptr") };
        }
        if (node.castKind === "fromInt") {
          const tmp = freshTemp();
          const srcLlvmTy = llvmType(operand.yoopType);
          fnLines.push(`  ${tmp} = inttoptr ${srcLlvmTy} ${operand.val} to ptr`);
          return { val: tmp, yoopType: node.resolvedType };
        }
        if (node.castKind === "toArray") {
          // Phase 8.C: build a fat-pointer view {data: operand, len: lenVal}.
          // No copy - the array borrows the underlying memory.
          const arrayType = node.resolvedType;
          ensureArrayTypeDef(arrayType.elem);
          const arrayLlvmTy = llvmType(arrayType);
          const len = emitExpr(node.lengthOperand, fnLines);
          const fatSlot = freshTemp();
          fnLines.push(`  ${fatSlot} = alloca ${arrayLlvmTy}, align 8`);
          const dataField = freshTemp();
          fnLines.push(`  ${dataField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 0`);
          fnLines.push(`  store ptr ${operand.val}, ptr ${dataField}`);
          const lenField = freshTemp();
          fnLines.push(`  ${lenField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 1`);
          fnLines.push(`  store i64 ${len.val}, ptr ${lenField}`);
          const fatVal = freshTemp();
          fnLines.push(`  ${fatVal} = load ${arrayLlvmTy}, ptr ${fatSlot}`);
          return { val: fatVal, yoopType: arrayType };
        }
        throw new Error(`codegen: unknown unsafe_ptr cast kind "${node.castKind}"`);
      }

      case ASTNodeKind.UNARY_EXPRESSION: {
        const operand = emitExpr(node.operand, fnLines);
        const resultType = node.resolvedType;
        const llvmTy = llvmType(resultType);
        const tmp = freshTemp();
        if (node.op === "minus") {
          if (resultType.kind === typeKinds.prim && (resultType.name === "float32" || resultType.name === "float64")) {
            fnLines.push(`  ${tmp} = fneg ${llvmTy} ${operand.val}`);
          } else {
            fnLines.push(`  ${tmp} = sub ${llvmTy} 0, ${operand.val}`);
          }
        } else if (node.op === "not") {
          fnLines.push(`  ${tmp} = xor ${llvmTy} ${operand.val}, 1`);
        } else {
          throw new Error(`codegen: unhandled unary op "${node.op}"`);
        }
        return { val: tmp, yoopType: resultType };
      }

      case ASTNodeKind.ASSIGNMENT: {
        if (node.target.kind === ASTNodeKind.IDENT) {
          const targetName = node.target.name;
          const lhsType = symbols.get(targetName);
          if (!lhsType) {
            throw new Error(
              `codegen: assignment to unknown variable "${targetName}"`,
            );
          }
          if (node.target.autoDerefWrite) {
            const innerType = lhsType.inner;
            const ptrTmp = freshTemp();
            fnLines.push(`  ${ptrTmp} = load ptr, ptr ${symbols.slotFor(targetName)}`);
            const rhs = emitExpr(node.value, fnLines);
            fnLines.push(`  store ${llvmType(innerType)} ${rhs.val}, ptr ${ptrTmp}`);
            return rhs;
          }
          const rhs = emitExpr(node.value, fnLines);
          fnLines.push(
            `  store ${llvmType(lhsType)} ${rhs.val}, ptr ${symbols.slotFor(targetName)}`,
          );
          return rhs;
        }
        if (node.target.kind === ASTNodeKind.FIELD_ACCESS) {
          const lv = emitLvalue(node.target, fnLines);
          if (
            node.value.kind === ASTNodeKind.STRUCT_LITERAL &&
            lv.type.kind === typeKinds.struct
          ) {
            emitStructLiteralInto(node.value, lv.ptr, lv.type, fnLines);
            const llvmTy = llvmType(lv.type);
            const tmp = freshTemp();
            fnLines.push(`  ${tmp} = load ${llvmTy}, ptr ${lv.ptr}`);
            return { val: tmp, yoopType: lv.type };
          }
          const rhs = emitExpr(node.value, fnLines);
          fnLines.push(
            `  store ${llvmType(lv.type)} ${rhs.val}, ptr ${lv.ptr}`,
          );
          return rhs;
        }
        if (node.target.kind === ASTNodeKind.INDEX_EXPRESSION) {
          const lv = emitLvalue(node.target, fnLines);
          const rhs = emitExpr(node.value, fnLines);
          fnLines.push(`  store ${llvmType(lv.type)} ${rhs.val}, ptr ${lv.ptr}`);
          return rhs;
        }
        if (node.target.kind === ASTNodeKind.DEREF_EXPRESSION) {
          // Phase 8.A: `*p = v` - store through an unsafe_ptr<T>.
          const ptrExpr = emitExpr(node.target.operand, fnLines);
          const rhs = emitExpr(node.value, fnLines);
          const pointee = node.target.resolvedType;
          fnLines.push(
            `  store ${llvmType(pointee)} ${rhs.val}, ptr ${ptrExpr.val}`,
          );
          return rhs;
        }
        throw new Error(
          `codegen: unsupported assignment target kind "${node.target.kind}"`,
        );
      }

      case ASTNodeKind.FIELD_ACCESS: {
        // intrinsic: `s.len` on a string -> strlen(s) returning usize.
        const objType = node.object.resolvedType;
        if (
          objType &&
          objType.kind === typeKinds.prim &&
          objType.name === "string" &&
          node.field === "len"
        ) {
          const s = emitExpr(node.object, fnLines);
          const tmp = freshTemp();
          fnLines.push(`  ${tmp} = call i64 @strlen(ptr ${s.val})`);
          return { val: tmp, yoopType: PrimType("usize") };
        }
        // intrinsic: `xs.len` on an array - GEP field 1 of the fat pointer.
        if (node.isArrayLen) {
          const lv = emitLvalue(node.object, fnLines);
          const arrayLlvmTy = llvmType(lv.type);
          const lenField = freshTemp();
          fnLines.push(`  ${lenField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${lv.ptr}, i32 0, i32 1`);
          const lenVal = freshTemp();
          fnLines.push(`  ${lenVal} = load i64, ptr ${lenField}`);
          return { val: lenVal, yoopType: PrimType("usize") };
        }
        // Phase 8.C: `xs.ptr` - GEP field 0 of the fat pointer, load.
        if (node.isArrayPtr) {
          const lv = emitLvalue(node.object, fnLines);
          const arrayLlvmTy = llvmType(lv.type);
          const dataField = freshTemp();
          fnLines.push(`  ${dataField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${lv.ptr}, i32 0, i32 0`);
          const dataVal = freshTemp();
          fnLines.push(`  ${dataVal} = load ptr, ptr ${dataField}`);
          return { val: dataVal, yoopType: node.resolvedType };
        }
        const lv = emitLvalue(node, fnLines);
        const llvmTy = llvmType(lv.type);
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = load ${llvmTy}, ptr ${lv.ptr}`);
        return { val: tmp, yoopType: lv.type };
      }

      case ASTNodeKind.ARRAY_LITERAL: {
        const arrayType = node.resolvedType;
        ensureArrayTypeDef(arrayType.elem);
        const elemLlvmTy = llvmType(arrayType.elem);
        const elemAlign = alignOf(elemLlvmTy);
        const n = node.elements.length;
        // Allocate backing storage
        const dataBuf = freshTemp();
        fnLines.push(`  ${dataBuf} = alloca [${n} x ${elemLlvmTy}], align ${elemAlign}`);
        for (let i = 0; i < n; i++) {
          const elemVal = emitExpr(node.elements[i], fnLines);
          const gepTmp = freshTemp();
          fnLines.push(`  ${gepTmp} = getelementptr [${n} x ${elemLlvmTy}], ptr ${dataBuf}, i32 0, i32 ${i}`);
          fnLines.push(`  store ${elemLlvmTy} ${elemVal.val}, ptr ${gepTmp}`);
        }
        const dataPtr = freshTemp();
        fnLines.push(`  ${dataPtr} = getelementptr [${n} x ${elemLlvmTy}], ptr ${dataBuf}, i32 0, i32 0`);
        // Build fat pointer
        const arrayLlvmTy = llvmType(arrayType);
        const fatSlot = freshTemp();
        fnLines.push(`  ${fatSlot} = alloca ${arrayLlvmTy}, align 8`);
        const dataField = freshTemp();
        fnLines.push(`  ${dataField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 0`);
        fnLines.push(`  store ptr ${dataPtr}, ptr ${dataField}`);
        const lenField = freshTemp();
        fnLines.push(`  ${lenField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 1`);
        fnLines.push(`  store i64 ${n}, ptr ${lenField}`);
        const fatVal = freshTemp();
        fnLines.push(`  ${fatVal} = load ${arrayLlvmTy}, ptr ${fatSlot}`);
        return { val: fatVal, yoopType: arrayType };
      }

      case ASTNodeKind.INDEX_EXPRESSION: {
        const lv = emitLvalue(node, fnLines);
        const llvmTy = llvmType(lv.type);
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = load ${llvmTy}, ptr ${lv.ptr}`);
        return { val: tmp, yoopType: lv.type };
      }

      case ASTNodeKind.TRY_OP: {
        // Phase 9.H: enum operand - extract the Ok variant payload (or void).
        const slot = emitTryOpToSlot(node, fnLines);
        const okStripped = strippedVariantOkType(slot.type);
        if (okStripped.kind === typeKinds.void) {
          return { val: "void", yoopType: VoidType() };
        }
        const enumId = slot.type.moduleId
          ? `${slot.type.moduleId}__${slot.type.name}`
          : slot.type.name;
        const payloadLlvm = `%variantc.${enumId}__Ok`;
        const fieldLlvm = llvmType(okStripped);
        const payloadPtr = freshTemp();
        fnLines.push(`  ${payloadPtr} = getelementptr inbounds ${llvmType(slot.type)}, ptr ${slot.ptr}, i32 0, i32 1`);
        const fieldPtr = freshTemp();
        fnLines.push(`  ${fieldPtr} = getelementptr inbounds ${payloadLlvm}, ptr ${payloadPtr}, i32 0, i32 0`);
        const v = freshTemp();
        fnLines.push(`  ${v} = load ${fieldLlvm}, ptr ${fieldPtr}`);
        return { val: v, yoopType: okStripped };
      }

      case ASTNodeKind.STRUCT_LITERAL: {
        const structType = node.resolvedType;
        const structLlvmTy = llvmType(structType);
        const tmpPtr = freshTemp();
        fnLines.push(
          `  ${tmpPtr} = alloca ${structLlvmTy}, align ${alignOfStruct(structType)}`,
        );
        emitStructLiteralInto(node, tmpPtr, structType, fnLines);
        const loadTmp = freshTemp();
        fnLines.push(
          `  ${loadTmp} = load ${structLlvmTy}, ptr ${tmpPtr}`,
        );
        return { val: loadTmp, yoopType: structType };
      }

      case ASTNodeKind.TEMPLATE_LITERAL: {
        return emitTemplateLiteral(node, fnLines);
      }

      default: {
        throw new Error(`codegen: unhandled expression kind "${node.kind}"`);
      }
    }
  }

  // ** call expressions, including printf as a typed builtin **
  function emitCall(node, fnLines) {
    // Numeric cast: int32(x), float64(y), etc.
    if (node.isCast) {
      const src = emitExpr(node.args[0], fnLines);
      const dstType = node.castTargetType;
      const opcode = castInstruction(src.yoopType, dstType);
      if (!opcode) return { val: src.val, yoopType: dstType };
      const tmp = freshTemp();
      fnLines.push(`  ${tmp} = ${opcode} ${llvmType(src.yoopType)} ${src.val} to ${llvmType(dstType)}`);
      return { val: tmp, yoopType: dstType };
    }
    // Namespace call: io.greet("hello") - callee is a FIELD_ACCESS node.
    // For generic calls (`vec.vec_new(...)`), node.genericInstantiation
    // holds the monomorphic mangled name; otherwise we mangle the bare
    // export name.
    if (node.callee && typeof node.callee === "object" && node.callee.namespaceLookup) {
      const mangledName = node.genericInstantiation
        ? `${node.genericInstantiation.moduleId}__${node.genericInstantiation.mangledName}`
        : `${node.callee.namespaceLookup.moduleId}__${node.callee.namespaceLookup.exportName}`;
      const argResults = node.args.map((a) => emitExpr(a, fnLines));
      const argList = argResults.map((r) => `${llvmType(r.yoopType)} ${r.val}`).join(", ");
      const retType = node.resolvedType;
      const llvmRet = llvmType(retType);
      if (llvmRet === "void") {
        fnLines.push(`  call void @${mangledName}(${argList})`);
        return { val: "void", yoopType: VoidType() };
      }
      const tmp = freshTemp();
      fnLines.push(`  ${tmp} = call ${llvmRet} @${mangledName}(${argList})`);
      return { val: tmp, yoopType: retType };
    }

    if (node.callee === "printf" && !currentExternNames.has("printf")) {
      return emitPrintfCall(node, fnLines);
    }

    // Phase 10.X.2: indirect call through a fn-ptr struct field.
    // Phase 10.K: or a bare identifier naming a fn-ptr parameter/local
    // (string callee - load its slot instead of emitExpr'ing a node).
    if (node.fnPointerCall) {
      const fptType = node.fnPointerType ?? node.callee.resolvedType;
      let fnPtr;
      if (typeof node.callee === "string") {
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = load ptr, ptr ${symbols.slotFor(node.callee)}`);
        fnPtr = { val: tmp };
      } else {
        fnPtr = emitExpr(node.callee, fnLines);
      }
      const argResults = node.args.map((a) => emitExpr(a, fnLines));
      const argList = argResults.map((r, i) =>
        `${llvmType(fptType.params[i])} ${r.val}`,
      ).join(", ");
      const llvmRet = llvmType(fptType.returnType);
      if (isVoidReturn(fptType.returnType)) {
        fnLines.push(`  call void ${fnPtr.val}(${argList})`);
        return { val: "void", yoopType: VoidType() };
      }
      const tmp = freshTemp();
      fnLines.push(`  ${tmp} = call ${llvmRet} ${fnPtr.val}(${argList})`);
      return { val: tmp, yoopType: fptType.returnType };
    }

    // Trait method call: typechecker stamped the mangled symbol.
    if (node.calleeMethodOf) {
      const argResults = node.args.map((a) => emitExpr(a, fnLines));
      const methodSig = node.calleeMethodOf.methods.get(node.calleeMethodName);
      const argList = methodSig.params.map((p, i) => {
        const llvmTy = p.isRef ? "ptr" : llvmType(p.type);
        return `${llvmTy} ${argResults[i].val}`;
      }).join(", ");
      const llvmRet = llvmType(methodSig.returnType);
      if (isVoidReturn(methodSig.returnType)) {
        fnLines.push(`  call void @${node.calleeMangledName}(${argList})`);
        return { val: "void", yoopType: VoidType() };
      }
      const tmp = freshTemp();
      fnLines.push(`  ${tmp} = call ${llvmRet} @${node.calleeMangledName}(${argList})`);
      return { val: tmp, yoopType: methodSig.returnType };
    }

    // Named import: typechecker annotated the call with the source module id.
    let calleeName = node.callee;
    if (node.calleeModuleId) {
      calleeName = mangle(node.calleeModuleId, node.calleeExportName);
    } else if (currentModuleId && !currentExternNames.has(calleeName)) {
      // Local function defined in this module - mangle it.
      calleeName = mangle(currentModuleId, node.callee);
    }

    const argResults = node.args.map((a) => emitExpr(a, fnLines));
    const sig = functionSigs.get(node.callee);
    let argList;
    if (sig && sig.variadic) {
      // Variadic: emit fixed params with declared types, tail with inferred types.
      const fixed = sig.params ?? [];
      const parts = argResults.map((r, i) => {
        const ty = i < fixed.length ? llvmType(fixed[i].type) : llvmType(r.yoopType);
        return `${ty} ${r.val}`;
      });
      argList = parts.join(", ");
    } else if (sig) {
      argList = sig.params
        .map((paramType, i) => `${llvmType(paramType.type ?? paramType)} ${argResults[i].val}`)
        .join(", ");
    } else {
      argList = argResults
        .map((r) => `${llvmType(r.yoopType)} ${r.val}`)
        .join(", ");
    }

    const retType = node.resolvedType;
    const llvmRet = llvmType(retType);
    const callInstr = sig?.variadic ? `call ${llvmRet} (${(sig.params ?? []).map(p => llvmType(p.type ?? p)).join(", ")}${sig.params?.length ? ", " : ""}...) @${calleeName}` : `call ${llvmRet} @${calleeName}`;
    if (llvmRet === "void") {
      fnLines.push(`  ${callInstr}(${argList})`);
      return { val: "void", yoopType: VoidType() };
    }
    const tmp = freshTemp();
    fnLines.push(`  ${tmp} = ${callInstr}(${argList})`);
    return { val: tmp, yoopType: retType };
  }

  // printf is variadic and the format string drives everything. for each
  // arg, decide a format specifier from its yooper type and synthesize a
  // single format string at the front of the call.
  function emitPrintfCall(node, fnLines) {
    if (node.args.length === 0) {
      throw new Error(`codegen: printf called with no arguments`);
    }

    // template literal as the only arg, or a regular expression list
    let fmtSpec = "";
    const valueArgs = []; // { val, yoopType } that follow the format string

    // A call that includes an explicit format-string literal is C printf: the
    // literal's `%` directives are authoritative and trailing value args fill
    // them, so we must NOT auto-append a specifier per value arg (doing so
    // produced a doubled directive, e.g. `printf("x=%d\n", x)` -> "x=%d\n%d").
    // Auto-append only when there is no format literal (`printf(someString)` ->
    // "%s") and for template-literal interpolations (no explicit directive).
    const hasFormatLiteral = node.args.some(
      (a) => a.kind === ASTNodeKind.STRING_LITERAL,
    );

    for (const argNode of node.args) {
      if (argNode.kind === ASTNodeKind.STRING_LITERAL) {
        // raw format text - strip the surrounding quotes, keep escapes intact
        const inner = argNode.value.slice(1, -1);
        fmtSpec += inner;
      } else if (
        argNode.kind === ASTNodeKind.TEMPLATE_LITERAL &&
        !hasFormatLiteral
      ) {
        // The template IS the format string: its text parts become format
        // text and each interpolation gets a synthesized specifier.
        for (const part of argNode.parts) {
          if (part.kind === ASTNodeKind.STRING_PART) {
            fmtSpec += escapePctsRaw(part.value);
          } else {
            const r = emitExpr(part.expr, fnLines);
            fmtSpec += printfSpec(r.yoopType);
            valueArgs.push(r);
          }
        }
      } else {
        // With an explicit format literal, a template-literal arg is an
        // ordinary VALUE arg filling a `%s` directive: evaluate the whole
        // template to its concatenated string (falls through emitExpr).
        // Contributing its parts to fmtSpec here instead reintroduces the
        // doubled-directive bug (`printf("p=%s\n", \`${p}\`)` emitting
        // format "p=%s\n%s" with one value arg - the stray %s reads a
        // garbage vararg).
        const r = emitExpr(argNode, fnLines);
        if (!hasFormatLiteral) fmtSpec += printfSpec(r.yoopType);
        valueArgs.push(r);
      }
    }

    const { name, byteLen } = emitRawStringGlobal(fmtSpec);
    const fmtTmp = freshTemp();
    fnLines.push(
      `  ${fmtTmp} = getelementptr inbounds [${byteLen} x i8], ptr ${name}, i32 0, i32 0`,
    );

    // important learning
    // varargs in C and llvm are passed as 32 bit ints or 64 bit doubles
    // so we have to "promote" them to the right size here.
    // sext is signed-extend, zext is zero-extend, fpext is float-extend
    const argList = ["ptr " + fmtTmp]
      .concat(
        valueArgs.map((r) => {
          // value enums share their underlying primitive's LLVM repr and
          // promotion rules (see valueEnumUnderlying).
          const vt = valueEnumUnderlying(r.yoopType);
          const promoted = promotedLlvmType(vt);
          const actual = llvmType(vt);
          if (promoted !== actual) {
            // varargs promotion: widen the value to the promoted type
            const tmp = freshTemp();
            if (isIntType(vt)) {
              const op = isUnsignedIntPrim(vt.name) ? "zext" : "sext";
              fnLines.push(`  ${tmp} = ${op} ${actual} ${r.val} to ${promoted}`);
            } else if (
              vt.kind === typeKinds.prim &&
              vt.name === "bool"
            ) {
              fnLines.push(`  ${tmp} = zext ${actual} ${r.val} to ${promoted}`);
            } else if (isFloatType(vt)) {
              fnLines.push(`  ${tmp} = fpext ${actual} ${r.val} to ${promoted}`);
            } else {
              throw new Error(
                `codegen: don't know how to promote ${vt.kind}/${vt.name ?? ""} for varargs`,
              );
            }
            return `${promoted} ${tmp}`;
          }
          return `${promoted} ${r.val}`;
        }),
      )
      .join(", ");

    const tmp = freshTemp();
    fnLines.push(`  ${tmp} = call i32 (ptr, ...) @printf(${argList})`);
    return { val: tmp, yoopType: PrimType("int32") };
  }

  // when a template-literal stringPart appears outside a printf format, we
  // still need to escape % so it doesn't read as a format directive.
  function escapePctsRaw(raw) {
    return raw.replace(/%/g, "%%");
  }

  // a template literal in a non-printf context: lower it to a printf call
  // for now (eventually this should produce a heap string via snprintf).
  // for the moment, this evaluates the parts and returns the concatenated
  // *format string* as a static global, which is wrong if there are interp
  // values - so we error in that case.
  function emitTemplateLiteral(node, fnLines) {
    const hasInterp = node.parts.some((p) => p.kind === ASTNodeKind.EXPR_PART);
    if (hasInterp) {
      throw new Error(
        `codegen: template literals with \${...} interpolation are only supported inside printf(...) for now`,
      );
    }
    // pure string template - emit as a regular string global
    const inner = node.parts.map((p) => p.value).join("");
    const { name, byteLen } = emitRawStringGlobal(inner);
    const tmp = freshTemp();
    fnLines.push(
      `  ${tmp} = getelementptr inbounds [${byteLen} x i8], ptr ${name}, i32 0, i32 0`,
    );
    return { val: tmp, yoopType: PrimType("string") };
  }

  // ** statement codegen ***********************************************
  function emitStatement(node, fnLines, ctx) {
    switch (node.kind) {
      case ASTNodeKind.RETURN_STATEMENT: {
        if (
          !node.value ||
          (node.value.kind === ASTNodeKind.IDENT && node.value.name === "void")
        ) {
          if (inMainFn) fnLines.push("  call void @yoop_runtime_shutdown()");
          fnLines.push("  ret void");
        } else {
          const r = emitExpr(node.value, fnLines);
          if (inMainFn) fnLines.push("  call void @yoop_runtime_shutdown()");
          fnLines.push(`  ret ${llvmType(ctx.returnType)} ${r.val}`);
        }
        break;
      }

      case ASTNodeKind.LET_DECL:
      case ASTNodeKind.CONST_DECL: {
        const declType = node.resolvedType;
        if (declType.kind === typeKinds.array) ensureArrayTypeDef(declType.elem);
        const slot = symbols.declare(node.name, declType);
        const llvmTy = llvmType(declType);
        const align = effectiveAlign(declType, node.resolvedKindApplication);
        fnLines.push(`  ${slot} = alloca ${llvmTy}, align ${align}`);
        if (node.assignment) {
          if (
            node.assignment.kind === ASTNodeKind.STRUCT_LITERAL &&
            declType.kind === typeKinds.struct
          ) {
            // populate the alloca'd slot directly - skip the temp + load + store
            emitStructLiteralInto(
              node.assignment,
              slot,
              declType,
              fnLines,
            );
          } else {
            const r = emitExpr(node.assignment, fnLines);
            fnLines.push(`  store ${llvmTy} ${r.val}, ptr ${slot}`);
          }
        }
        break;
      }

      case ASTNodeKind.EXPRESSION_STATEMENT:
        emitExpr(node.value, fnLines);
        break;

      case ASTNodeKind.DESTRUCTURE_DECL:
        emitDestructureDecl(node, fnLines);
        break;

      case ASTNodeKind.DISCARD_STATEMENT:
        // `_ = expr;` - evaluate for side-effects only. If `expr` is a
        // TRY_OP the err propagation still fires inside emitExpr; the
        // discard suppresses the resulting value.
        emitExpr(node.value, fnLines);
        break;

      case ASTNodeKind.IF_STATEMENT:
        emitIf(node, fnLines, ctx);
        break;

      case ASTNodeKind.WHILE_STATEMENT:
        emitWhile(node, fnLines, ctx);
        break;

      case ASTNodeKind.FOR_LOOP:
        emitForLoop(node, fnLines, ctx);
        break;

      case ASTNodeKind.FOR_IN_LOOP:
        emitForInLoop(node, fnLines, ctx);
        break;

      case ASTNodeKind.BREAK_STATEMENT:
        fnLines.push(`  br label %${ctx.breakLabel}`);
        break;

      case ASTNodeKind.CONTINUE_STATEMENT:
        fnLines.push(`  br label %${ctx.continueLabel}`);
        break;

      case ASTNodeKind.BLOCK:
        node.body.forEach((s) => emitStatement(s, fnLines, ctx));
        break;

      default:
        throw new Error(`codegen: unhandled statement kind "${node.kind}"`);
    }
  }

  // `const { a, b } = expr;` - destructure a struct value.
  function emitDestructureDecl(node, fnLines) {
    const r = emitExpr(node.assignment, fnLines);
    const slotType = node.assignment.resolvedType;
    const slotPtr = freshTemp();
    const slotLlvmTy2 = llvmType(slotType);
    fnLines.push(
      `  ${slotPtr} = alloca ${slotLlvmTy2}, align ${alignOfStruct(slotType)}`,
    );
    fnLines.push(
      `  store ${slotLlvmTy2} ${r.val}, ptr ${slotPtr}`,
    );

    for (const name of node.names) {
      const idx = slotType.fields.findIndex((f) => f.name === name);
      if (idx < 0) {
        throw new Error(
          `codegen: destructure name "${name}" not on type ${slotType.name}`,
        );
      }
      const fieldType = slotType.fields[idx].type;
      const llvmTy = llvmType(fieldType);
      const align = fieldType.kind === typeKinds.struct
        ? alignOfStruct(fieldType)
        : alignOf(llvmTy);

      const gepTmp = freshTemp();
      fnLines.push(
        `  ${gepTmp} = getelementptr inbounds ${llvmType(slotType)}, ptr ${slotPtr}, i32 0, i32 ${idx}`,
      );
      const valTmp = freshTemp();
      fnLines.push(`  ${valTmp} = load ${llvmTy}, ptr ${gepTmp}`);

      const slot = symbols.declare(name, fieldType);
      fnLines.push(`  ${slot} = alloca ${llvmTy}, align ${align}`);
      fnLines.push(`  store ${llvmTy} ${valTmp}, ptr ${slot}`);
    }
  }

  function emitIf(node, fnLines, ctx) {
    const cond = emitExpr(node.expression, fnLines);
    const thenLabel = freshLabel("then");
    const elseLabel = freshLabel("else");
    const mergeLabel = freshLabel("merge");
    fnLines.push(
      `  br i1 ${cond.val}, label %${thenLabel}, label %${elseLabel}`,
    );
    fnLines.push(`${thenLabel}:`);
    emitBlock(node.body, fnLines, ctx);
    fnLines.push(`  br label %${mergeLabel}`);
    fnLines.push(`${elseLabel}:`);
    if (node.elseBody) emitBlock(node.elseBody, fnLines, ctx);
    fnLines.push(`  br label %${mergeLabel}`);
    fnLines.push(`${mergeLabel}:`);
  }

  function emitWhile(node, fnLines, ctx) {
    const condLabel = freshLabel("while_cond");
    const bodyLabel = freshLabel("while_body");
    const afterLabel = freshLabel("while_after");
    fnLines.push(`  br label %${condLabel}`);
    fnLines.push(`${condLabel}:`);
    const cond = emitExpr(node.expression, fnLines);
    fnLines.push(
      `  br i1 ${cond.val}, label %${bodyLabel}, label %${afterLabel}`,
    );
    fnLines.push(`${bodyLabel}:`);
    const loopCtx = { ...ctx, breakLabel: afterLabel, continueLabel: condLabel };
    emitBlock(node.body, fnLines, loopCtx);
    if (!blockIsTerminated(fnLines)) fnLines.push(`  br label %${condLabel}`);
    fnLines.push(`${afterLabel}:`);
  }

  function emitForLoop(node, fnLines, ctx) {
    const initType = symbols.get(node.initIdent);
    const initVal = emitExpr(node.initExpr, fnLines);
    fnLines.push(`  store ${llvmType(initType)} ${initVal.val}, ptr ${symbols.slotFor(node.initIdent)}`);

    const condLabel = freshLabel("for_cond");
    const bodyLabel = freshLabel("for_body");
    const stepLabel = freshLabel("for_step");
    const afterLabel = freshLabel("for_after");

    fnLines.push(`  br label %${condLabel}`);
    fnLines.push(`${condLabel}:`);
    const cond = emitExpr(node.cond, fnLines);
    fnLines.push(`  br i1 ${cond.val}, label %${bodyLabel}, label %${afterLabel}`);

    fnLines.push(`${bodyLabel}:`);
    const loopCtx = { ...ctx, breakLabel: afterLabel, continueLabel: stepLabel };
    emitBlock(node.body, fnLines, loopCtx);
    if (!blockIsTerminated(fnLines)) fnLines.push(`  br label %${stepLabel}`);

    fnLines.push(`${stepLabel}:`);
    const stepType = symbols.get(node.stepIdent);
    const stepVal = emitExpr(node.stepExpr, fnLines);
    fnLines.push(`  store ${llvmType(stepType)} ${stepVal.val}, ptr ${symbols.slotFor(node.stepIdent)}`);
    fnLines.push(`  br label %${condLabel}`);

    fnLines.push(`${afterLabel}:`);
  }

  // Phase 10.B: shared lowering for `for x in EXPR` when EXPR's type
  // implements Iterable<U>. The loop owns a mutable copy of the iterator
  // (we want `for x in make_iter()` to walk the freshly-created state, and
  // `for x in my_iter` to leave the caller's binding untouched). Each
  // iteration calls `Iterable.next(ref iter_slot) -> IterStep<U>` and
  // pattern-matches the result.
  function emitForInLoopIterable(node, fnLines, ctx, emitBlockFn) {
    const iterType = node.resolvedIterType;
    const elemType = node.resolvedElemType;
    const iterStepType = node.iterableImpl.iterStepType;
    const mangledNext = node.iterableImpl.mangledNextName;

    const iterLlvm = llvmType(iterType);
    const elemLlvm = llvmType(elemType);
    const stepLlvm = llvmType(iterStepType);
    const elemAlign = elemType.kind === typeKinds.struct
      ? alignOfStruct(elemType)
      : alignOf(elemLlvm);

    symbols.enterScope();

    const r = emitExpr(node.iterExpr, fnLines);
    const iterSlot = freshTemp();
    fnLines.push(`  ${iterSlot} = alloca ${iterLlvm}, align ${alignOfStruct(iterType)}`);
    fnLines.push(`  store ${iterLlvm} ${r.val}, ptr ${iterSlot}`);

    const loopVarSlot = symbols.declare(node.loopVar, elemType);
    fnLines.push(`  ${loopVarSlot} = alloca ${elemLlvm}, align ${elemAlign}`);

    const stepSlot = freshTemp();
    fnLines.push(`  ${stepSlot} = alloca ${stepLlvm}, align ${sizeOfAlign(iterStepType)}`);

    const topLabel = freshLabel("forin_iter_top");
    const bodyLabel = freshLabel("forin_iter_body");
    const stepLabel = freshLabel("forin_iter_step");
    const afterLabel = freshLabel("forin_iter_after");

    fnLines.push(`  br label %${topLabel}`);
    fnLines.push(`${topLabel}:`);
    const stepVal = freshTemp();
    fnLines.push(`  ${stepVal} = call ${stepLlvm} @${mangledNext}(ptr ${iterSlot})`);
    fnLines.push(`  store ${stepLlvm} ${stepVal}, ptr ${stepSlot}`);

    const tagPtr = freshTemp();
    fnLines.push(`  ${tagPtr} = getelementptr inbounds ${stepLlvm}, ptr ${stepSlot}, i32 0, i32 0`);
    const tag = freshTemp();
    fnLines.push(`  ${tag} = load i32, ptr ${tagPtr}`);
    const yieldOrdinal = iterStepType.variants.get("Yield").ordinal;
    const isYield = freshTemp();
    fnLines.push(`  ${isYield} = icmp eq i32 ${tag}, ${yieldOrdinal}`);
    fnLines.push(`  br i1 ${isYield}, label %${bodyLabel}, label %${afterLabel}`);

    fnLines.push(`${bodyLabel}:`);
    const stepEnumId = iterStepType.moduleId
      ? `${iterStepType.moduleId}__${iterStepType.name}`
      : iterStepType.name;
    const yieldVariantLlvm = `%variantc.${stepEnumId}__Yield`;
    const payloadPtr = freshTemp();
    fnLines.push(`  ${payloadPtr} = getelementptr inbounds ${stepLlvm}, ptr ${stepSlot}, i32 0, i32 1`);
    const valuePtr = freshTemp();
    fnLines.push(`  ${valuePtr} = getelementptr inbounds ${yieldVariantLlvm}, ptr ${payloadPtr}, i32 0, i32 0`);
    const elemVal = freshTemp();
    fnLines.push(`  ${elemVal} = load ${elemLlvm}, ptr ${valuePtr}`);
    fnLines.push(`  store ${elemLlvm} ${elemVal}, ptr ${loopVarSlot}`);

    const loopCtx = { ...ctx, breakLabel: afterLabel, continueLabel: stepLabel };
    emitBlockFn(node.body, fnLines, loopCtx);
    if (!blockIsTerminated(fnLines)) fnLines.push(`  br label %${stepLabel}`);

    fnLines.push(`${stepLabel}:`);
    fnLines.push(`  br label %${topLabel}`);

    fnLines.push(`${afterLabel}:`);
    symbols.leaveScope();
  }

  // Phase 9.D: `for item in xs { ... }`. Lowers to a fat-pointer walk with
  // a hidden i64 counter - same shape as the C-style for loop a user would
  // write today, but the index is invisible and the per-iteration value is
  // copied into a fresh loopVar slot at the top of the body.
  function emitForInLoop(node, fnLines, ctx) {
    // Phase 10.B: iterable-impl path. Lowered as
    //   alloca iter_slot, store iter_val
    //   loop_top:
    //     call next(ref iter_slot) -> IterStep<U>
    //     match tag: Yield -> body; Done -> after
    if (node.iterableImpl) {
      emitForInLoopIterable(node, fnLines, ctx, emitBlock);
      return;
    }
    const elemType = node.resolvedElemType;
    ensureArrayTypeDef(elemType);

    // Evaluate the iterable once. emitLvalue will materialize a slot for
    // rvalue expressions, so we always have a stable {ptr, i64} address.
    const base = emitLvalue(node.iterExpr, fnLines);
    const arrayLlvmTy = llvmType(base.type);
    const elemLlvmTy = llvmType(elemType);
    const elemAlign = elemType.kind === typeKinds.struct
      ? alignOfStruct(elemType)
      : alignOf(elemLlvmTy);

    // Cache the data pointer and len once; matches the "evaluate bound
    // once" semantics typical C-style for loops use.
    const dataFieldPtr = freshTemp();
    fnLines.push(`  ${dataFieldPtr} = getelementptr inbounds ${arrayLlvmTy}, ptr ${base.ptr}, i32 0, i32 0`);
    const dataPtr = freshTemp();
    fnLines.push(`  ${dataPtr} = load ptr, ptr ${dataFieldPtr}`);
    const lenFieldPtr = freshTemp();
    fnLines.push(`  ${lenFieldPtr} = getelementptr inbounds ${arrayLlvmTy}, ptr ${base.ptr}, i32 0, i32 1`);
    const lenVal = freshTemp();
    fnLines.push(`  ${lenVal} = load i64, ptr ${lenFieldPtr}`);

    const counterSlot = freshTemp();
    fnLines.push(`  ${counterSlot} = alloca i64, align 8`);
    fnLines.push(`  store i64 0, ptr ${counterSlot}`);

    // Loop variable slot follows the LET_DECL naming convention (%name).
    symbols.enterScope();
    const loopVarSlot = symbols.declare(node.loopVar, elemType);
    fnLines.push(`  ${loopVarSlot} = alloca ${elemLlvmTy}, align ${elemAlign}`);

    const condLabel = freshLabel("forin_cond");
    const bodyLabel = freshLabel("forin_body");
    const stepLabel = freshLabel("forin_step");
    const afterLabel = freshLabel("forin_after");

    fnLines.push(`  br label %${condLabel}`);
    fnLines.push(`${condLabel}:`);
    const counterVal = freshTemp();
    fnLines.push(`  ${counterVal} = load i64, ptr ${counterSlot}`);
    const doneVal = freshTemp();
    fnLines.push(`  ${doneVal} = icmp uge i64 ${counterVal}, ${lenVal}`);
    fnLines.push(`  br i1 ${doneVal}, label %${afterLabel}, label %${bodyLabel}`);

    fnLines.push(`${bodyLabel}:`);
    const idxVal = freshTemp();
    fnLines.push(`  ${idxVal} = load i64, ptr ${counterSlot}`);
    const elemPtr = freshTemp();
    fnLines.push(`  ${elemPtr} = getelementptr inbounds ${elemLlvmTy}, ptr ${dataPtr}, i64 ${idxVal}`);
    const elemVal = freshTemp();
    fnLines.push(`  ${elemVal} = load ${elemLlvmTy}, ptr ${elemPtr}`);
    fnLines.push(`  store ${elemLlvmTy} ${elemVal}, ptr ${loopVarSlot}`);

    const loopCtx = { ...ctx, breakLabel: afterLabel, continueLabel: stepLabel };
    emitBlock(node.body, fnLines, loopCtx);
    if (!blockIsTerminated(fnLines)) fnLines.push(`  br label %${stepLabel}`);

    fnLines.push(`${stepLabel}:`);
    const curVal = freshTemp();
    fnLines.push(`  ${curVal} = load i64, ptr ${counterSlot}`);
    const nextVal = freshTemp();
    fnLines.push(`  ${nextVal} = add i64 ${curVal}, 1`);
    fnLines.push(`  store i64 ${nextVal}, ptr ${counterSlot}`);
    fnLines.push(`  br label %${condLabel}`);

    fnLines.push(`${afterLabel}:`);
    symbols.leaveScope();
  }

  function blockIsTerminated(fnLines) {
    for (let i = fnLines.length - 1; i >= 0; i--) {
      const l = fnLines[i].trim();
      if (!l || l.endsWith(":")) return false;
      return l.startsWith("br ") || l.startsWith("ret ");
    }
    return false;
  }

  function emitBlock(blockOrNode, fnLines, ctx) {
    symbols.enterScope();
    if (blockOrNode.kind === ASTNodeKind.BLOCK) {
      blockOrNode.body.forEach((s) => emitStatement(s, fnLines, ctx));
    } else {
      emitStatement(blockOrNode, fnLines, ctx);
    }
    symbols.leaveScope();
  }

  // **** method codegen *********
  // Phase 7.4: one impl body can satisfy multiple traits (when their method
  // signatures agree). Emit one LLVM `define` per trait in implementsTraits,
  // each under the trait-qualified mangle. Bodies are identical.
  function emitMethod(methodDecl, structType) {
    const traits = methodDecl.implementsTraits ?? [];
    for (const traitName of traits) {
      emitMethodOnce(methodDecl, structType, traitName);
    }
  }

  function emitMethodOnce(methodDecl, structType, traitName) {
    tempCounter = 0;
    labelCounter = 0;
    symbols = createLocalSymbols();

    const returnType = methodDecl.resolvedFuncType.returnType;
    currentReturnType = returnType;
    const params = methodDecl.params;
    const llvmRet = llvmType(returnType);

    const paramSig = params.map((p) => {
      const ty = llvmType(p.resolvedType);
      return `${ty} %${p.name}.arg`;
    }).join(", ");

    const mangled = mangleTraitMethod(structType, traitName, methodDecl.name);
    const fnLines = [];
    fnLines.push(`define ${llvmRet} @${mangled}(${paramSig}) {`);
    fnLines.push("entry:");

    for (const p of params) {
      const ty = p.resolvedType;
      const paramSlot = symbols.declare(p.name, ty);
      if (ty.kind === typeKinds.ref) {
        fnLines.push(`  ${paramSlot} = alloca ptr, align 8`);
        fnLines.push(`  store ptr %${p.name}.arg, ptr ${paramSlot}`);
      } else {
        const llvmTy = llvmType(ty);
        const align = effectiveAlign(ty, p.resolvedKindApplication);
        fnLines.push(`  ${paramSlot} = alloca ${llvmTy}, align ${align}`);
        fnLines.push(`  store ${llvmTy} %${p.name}.arg, ptr ${paramSlot}`);
      }
    }

    const ctx = { fnName: methodDecl.name, returnType };
    methodDecl.body.body.forEach((s) => emitStatement(s, fnLines, ctx));

    if (isVoidReturn(returnType)) {
      const last = fnLines[fnLines.length - 1].trim();
      if (!last.startsWith("ret")) fnLines.push("  ret void");
    } else if (!blockIsTerminated(fnLines)) {
      // See emitFunction: an exhaustive all-diverging switch leaves an
      // unreachable tail block; terminate it.
      fnLines.push("  unreachable");
    }
    fnLines.push("}");
    hoistAllocasToEntry(fnLines);
    lines.push(...fnLines);
  }

  // **** function codegen *********
  function emitFunction(node, forceName = null) {
    tempCounter = 0;
    labelCounter = 0;
    symbols = createLocalSymbols();

    const returnType = node.resolvedType;
    currentReturnType = returnType;
    const params = node.params ?? [];
    const llvmRet = llvmType(returnType);

    const paramSig = params
      .map((p) => `${llvmType(p.resolvedType)} %${p.name}.arg`)
      .join(", ");

    // In multi-module mode, mangle the symbol. forceName overrides (for export "C").
    const symName = forceName ?? (currentModuleId ? mangle(currentModuleId, node.name) : node.name);

    const prevInMain = inMainFn;
    inMainFn = symName === "main";

    const fnLines = [];
    fnLines.push(`define ${llvmRet} @${symName}(${paramSig}) {`);
    fnLines.push("entry:");
    if (inMainFn) fnLines.push("  call void @yoop_runtime_init()");

    // copy params into stack slots so they're addressable like locals
    for (const p of params) {
      const ty = p.resolvedType;
      // Phase 8.H: ensure %yoop_array.<T> is emitted for array-typed params,
      // since the alloca below names that struct type.
      if (ty.kind === typeKinds.array) ensureArrayTypeDef(ty.elem);
      const llvmTy = llvmType(ty);
      const paramSlot = symbols.declare(p.name, ty);
      const align = effectiveAlign(ty, p.resolvedKindApplication);
      fnLines.push(`  ${paramSlot} = alloca ${llvmTy}, align ${align}`);
      fnLines.push(`  store ${llvmTy} %${p.name}.arg, ptr ${paramSlot}`);
    }

    const ctx = { fnName: node.name, returnType };
    node.body.body.forEach((s) => emitStatement(s, fnLines, ctx));

    if (isVoidReturn(returnType)) {
      const last = fnLines[fnLines.length - 1].trim();
      if (!last.startsWith("ret")) {
        if (inMainFn) fnLines.push("  call void @yoop_runtime_shutdown()");
        fnLines.push("  ret void");
      }
    } else if (!blockIsTerminated(fnLines)) {
      // Non-void body left an open tail block - the typechecker proved every
      // path returns, so this block is unreachable (e.g. the body ends in an
      // exhaustive `switch` whose arms all diverge, leaving an empty
      // `switch_end:`). Terminate it so the LLVM verifier accepts the IR.
      fnLines.push("  unreachable");
    }

    fnLines.push("}");
    hoistAllocasToEntry(fnLines);
    lines.push(...fnLines);
    inMainFn = prevInMain;
  }

  // ********* top-level entry ***************
  function emitProgram(node) {
    // zeroth pass: emit named struct type declarations. must come before any
    // use (extern decls, function sigs) so the LLVM verifier sees the type.
    for (const decl of node.body) {
      const d = decl.kind === ASTNodeKind.EXPORT_DECL ? decl.decl : decl;
      if (d.kind === ASTNodeKind.TYPE_DECL && d.resolvedType) {
        const fieldLlvm = d.resolvedType.fields
          ? d.resolvedType.fields.map((f) => llvmType(f.type)).join(", ")
          : "";
        structDefs.push(`${llvmType(d.resolvedType)} = type { ${fieldLlvm} }`);
      }
    }

    // first pass: collect function signatures (user-defined + externs)
    const externFnNames = new Set();
    for (const decl of node.body) {
      const d =
        decl.kind === ASTNodeKind.EXPORT_DECL ? decl.decl :
        decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL ? decl.fn :
        decl;
      if (d.kind === ASTNodeKind.FUNCTION_DECL) {
        functionSigs.set(d.name, {
          params: (d.params ?? []).map((p) => p.resolvedType),
          returnType: d.resolvedType,
        });
      }
      if (decl.kind === ASTNodeKind.EXTERN_BLOCK) {
        const isIntrinsic = decl.abi === "intrinsic";
        for (const ext of decl.decls) {
          if (ext.kind !== ASTNodeKind.EXTERN_FUNCTION_DECL) continue;
          externFnNames.add(ext.name);
          // Generic intrinsics have no resolved param/return types - pass C
          // skips them since the canonical decl carries the signature. Don't
          // build a functionSigs entry for them; codegen dispatches by declId.
          if (isIntrinsic && ext.resolvedType === undefined) continue;
          functionSigs.set(ext.name, {
            params: ext.params.map((p) => p.resolvedType),
            returnType: ext.resolvedType,
            variadic: ext.variadic,
          });
        }
      }
    }
    currentExternNames = externFnNames;

    // second pass: emit extern declarations from EXTERN_BLOCKs, then legacy auto-detect.
    // `extern "intrinsic"` blocks are compiler-recognized - their lowerings
    // live in codegen / the runtime, not in LLVM `declare`s, so we skip them.
    for (const decl of node.body) {
      if (decl.kind !== ASTNodeKind.EXTERN_BLOCK) continue;
      if (decl.abi === "intrinsic") continue;
      for (const ext of decl.decls) {
        if (ext.kind !== ASTNodeKind.EXTERN_FUNCTION_DECL) continue;
        const params = ext.params.map((p) => llvmType(p.resolvedType)).join(", ");
        const ret = llvmType(ext.resolvedType);
        const sig = ext.variadic
          ? `declare ${ret} @${ext.name}(${params}${params ? ", " : ""}...)`
          : `declare ${ret} @${ext.name}(${params})`;
        lines.push(sig);
      }
    }
    const defined = new Set([...functionSigs.keys()]);
    const called = collectCalls(node, defined);
    if (needsStrlen(node)) called.add("strlen");
    for (const name of called) {
      if (externFnNames.has(name)) continue;
      const decl = externDecl(name);
      if (decl) lines.push(decl);
    }
    // Runtime ABI declares - emitted unconditionally so codegen-injected
    // init/shutdown (and future task scheduling) resolve at link time.
    lines.push(...RUNTIME_DECLARES);
    if (defined.size > 0 || called.size > 0) lines.push("");

    // third pass: emit function and method bodies
    for (const decl of node.body) {
      if (decl.kind === ASTNodeKind.FUNCTION_DECL) {
        emitFunction(decl);
      } else if (decl.kind === ASTNodeKind.EXPORT_DECL && decl.decl.kind === ASTNodeKind.FUNCTION_DECL) {
        emitFunction(decl.decl);
      } else if (decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL) {
        // emit with the original unmangled name regardless of currentModuleId
        emitFunction(decl.fn, decl.fn.name);
      } else if (decl.kind === ASTNodeKind.TYPE_DECL && decl.methods?.length > 0) {
        for (const method of decl.methods) {
          emitMethod(method, decl.resolvedType);
        }
      } else if (decl.kind === ASTNodeKind.EXPORT_DECL && decl.decl.kind === ASTNodeKind.TYPE_DECL && decl.decl.methods?.length > 0) {
        for (const method of decl.decl.methods) {
          emitMethod(method, decl.decl.resolvedType);
        }
      } else if (decl.kind === ASTNodeKind.VARIANT_DECL && decl.methods?.length > 0) {
        // Phase 13.B: variant impl methods - same emission pipeline as
        // struct methods. mangleTraitMethod just reads moduleId + name
        // off the receiver type; VariantType has both.
        for (const method of decl.methods) {
          emitMethod(method, decl.resolvedType);
        }
      } else if (decl.kind === ASTNodeKind.EXPORT_DECL && decl.decl.kind === ASTNodeKind.VARIANT_DECL && decl.decl.methods?.length > 0) {
        for (const method of decl.decl.methods) {
          emitMethod(method, decl.decl.resolvedType);
        }
      }
      // TRAIT_DECL: no codegen - traits are compile-time only
    }
  }

  emitProgram(ast);

  const allLines = [
    ...structDefs,
    structDefs.length ? "" : null,
    ...globals,
    globals.length ? "" : null,
    ...lines,
  ].filter((l) => l !== null);
  return allLines.join("\n");
}

function mangle(moduleId, localName) {
  return `${moduleId}__${localName}`;
}

function llvmFloatConstant(jsNumber, primName = "float64") {
  // LLVM IR requires float (32-bit) constants to be exactly representable as
  // float32 even though they're written as 64-bit hex. Round through float32
  // first so the hex form round-trips cleanly.
  const val = primName === "float32" ? Math.fround(jsNumber) : jsNumber;
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(val, 0);
  return "0x" + buf.toString("hex").toUpperCase();
}

// walk the AST and collect names of called functions not in `defined`.
// Only collects string callees - object callees (namespace calls) are handled
// separately in emitCall.
function collectCalls(node, defined) {
  const called = new Set();
  function walk(n) {
    if (!n || typeof n !== "object") return;
    if (
      n.kind === ASTNodeKind.CALL_EXPRESSION &&
      typeof n.callee === "string" &&
      !defined.has(n.callee) &&
      !n.calleeMethodOf
    ) {
      called.add(n.callee);
    }
    for (const val of Object.values(n)) {
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === "object" && val.kind) walk(val);
    }
  }
  walk(node);
  return called;
}

function externDecl(name) {
  const known = {
    printf: "declare i32 @printf(ptr, ...)",
    fprintf: "declare i32 @fprintf(ptr, ptr, ...)",
    puts: "declare i32 @puts(ptr)",
    exit: "declare void @exit(i32)",
    strlen: "declare i64 @strlen(ptr)",
  };
  return known[name] ?? `declare i32 @${name}(...)`;
}

// Walks the AST for nodes that lower to a strlen call: TRY_OP (uses
// strlen for the err-set check) and FIELD_ACCESS with field "len" on a
// string-typed receiver (the s.len intrinsic).
function needsStrlen(node) {
  let found = false;
  function walk(n) {
    if (found || !n || typeof n !== "object") return;
    if (n.kind === ASTNodeKind.TRY_OP) {
      found = true;
      return;
    }
    if (n.kind === ASTNodeKind.FIELD_ACCESS && n.field === "len") {
      const objType = n.object?.resolvedType;
      if (
        objType &&
        objType.kind === typeKinds.prim &&
        objType.name === "string"
      ) {
        found = true;
        return;
      }
    }
    // Phase 8.H: string_as_bytes calls strlen internally.
    if (
      n.kind === ASTNodeKind.CALL_EXPRESSION &&
      n.genericInstantiation?.declId === "$builtin__string_as_bytes"
    ) {
      found = true;
      return;
    }
    for (const val of Object.values(n)) {
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === "object" && val.kind) walk(val);
    }
  }
  walk(node);
  return found;
}

// True for both VoidType() and PrimType("void") - the typechecker emits the
// latter when resolving the "void" type name via resolveTypeAnnotation.
function isVoidReturn(rt) {
  return rt.kind === typeKinds.void || (rt.kind === typeKinds.prim && rt.name === "void");
}

export function alignOf(llvmTy) {
  if (llvmTy === "i64" || llvmTy === "double") return 8;
  if (llvmTy === "i32" || llvmTy === "float") return 4;
  if (llvmTy === "i16") return 2;
  if (llvmTy === "i8" || llvmTy === "i1") return 1;
  return 8; // ptr
}

// Phase 7.5: rough byte size of a yoop type, for sizing union and enum
// payloads. Mirrors `alignOf` - only uses natural sizes and assumes packed
// layout (LLVM will round up to alignment in practice; we round up explicitly
// where it matters).
export function sizeOfType(t) {
  if (!t) return 8;
  if (t.kind === typeKinds.prim) {
    switch (t.name) {
      case "int8":
      case "uint8":
      case "bool":
      case "char":
        return 1;
      case "int16":
      case "uint16":
        return 2;
      case "int32":
      case "uint32":
      case "float32":
      case "float":
      case "int":
        return 4;
      case "int64":
      case "uint64":
      case "usize":
      case "isize":
      case "float64":
        return 8;
      case "string":
        return 8;
      default:
        return 8;
    }
  }
  if (t.kind === typeKinds.ref) return 8;
  if (t.kind === typeKinds.array) return 16; // ptr + len
  if (t.kind === typeKinds.struct) {
    // Approximate: sum field sizes, padding each to the field's alignment.
    let off = 0;
    let maxAlign = 1;
    for (const f of t.fields ?? []) {
      const al = sizeOfAlign(f.type);
      if (al > maxAlign) maxAlign = al;
      off = roundUp(off, al) + sizeOfType(f.type);
    }
    return roundUp(off, maxAlign);
  }
  if (t.kind === typeKinds.union) {
    let max = 0;
    for (const f of t.fields ?? []) {
      const s = sizeOfType(f.type);
      if (s > max) max = s;
    }
    return max;
  }
  if (t.kind === typeKinds.variant) {
    let maxPayload = 0;
    for (const v of t.variants.values()) {
      if (v.fields === null) continue;
      let off = 0;
      let maxAlign = 1;
      for (const f of v.fields) {
        const al = sizeOfAlign(f.type);
        if (al > maxAlign) maxAlign = al;
        off = roundUp(off, al) + sizeOfType(f.type);
      }
      const padded = roundUp(off, maxAlign);
      if (padded > maxPayload) maxPayload = padded;
    }
    return 4 /* tag */ + maxPayload;
  }
  return 8;
}

export function sizeOfAlign(t) {
  if (!t) return 8;
  if (t.kind === typeKinds.prim) return alignOf(LLVM_TYPES[t.name] ?? "ptr");
  if (t.kind === typeKinds.ref) return 8;
  if (t.kind === typeKinds.array) return 8;
  if (t.kind === typeKinds.struct) {
    let max = 1;
    for (const f of t.fields ?? []) {
      const a = sizeOfAlign(f.type);
      if (a > max) max = a;
    }
    return max;
  }
  if (t.kind === typeKinds.union) {
    let max = 1;
    for (const f of t.fields ?? []) {
      const a = sizeOfAlign(f.type);
      if (a > max) max = a;
    }
    return max;
  }
  if (t.kind === typeKinds.variant) {
    let max = 4; // i32 tag
    for (const v of t.variants.values()) {
      if (v.fields === null) continue;
      for (const f of v.fields) {
        const a = sizeOfAlign(f.type);
        if (a > max) max = a;
      }
    }
    return max;
  }
  if (t.kind === typeKinds.vtable) {
    // Phase 9.G: vtables are { ptr ctx, ptr m1, ptr m2, ... } - all pointer-
    // wide, so the natural alignment is one pointer.
    return 8;
  }
  return 8;
}

function roundUp(x, a) {
  return Math.floor((x + a - 1) / a) * a;
}

// ** binary op resolution ****************************

// LLVM docs: https://llvm.org/docs/LangRef.html
//
// Signed-int op map. For unsigned integer types we substitute the
// signedness-aware variants below in `binaryInstruction`.
const INT_OP_MAP = {
  plus: "add",
  minus: "sub",
  mult: "mul",
  divide: "sdiv",
  modulus: "srem",
  eqeq: "icmp eq",
  neq: "icmp ne",
  lt: "icmp slt",
  gt: "icmp sgt",
  lte: "icmp sle",
  gte: "icmp sge",
  andand: "and",
  oror: "or",
  pipe: "or",
  // Phase 9: bitwise AND / XOR. The token names (`amp`, `caret`) double as
  // the op keys the parser stamps onto BINARY_EXPRESSION nodes.
  amp: "and",
  caret: "xor",
  lshift: "shl",
  rshift: "ashr",
};

const FLOAT_OP_MAP = {
  plus: "fadd",
  minus: "fsub",
  mult: "fmul",
  divide: "fdiv",
  modulus: "frem",
  eqeq: "fcmp oeq",
  neq: "fcmp one",
  lt: "fcmp olt",
  gt: "fcmp ogt",
  lte: "fcmp ole",
  gte: "fcmp oge",
};

// Phase 8.H: comparison/division ops must distinguish signed and unsigned
// integer types - LLVM has separate opcodes (icmp slt vs icmp ult, sdiv vs
// udiv, etc.). Without this, uint8 comparisons against literals > 127
// silently produce wrong results (the byte 128 becomes -128 signed).
const UNSIGNED_INT_OVERRIDES = {
  divide: "udiv",
  modulus: "urem",
  lt: "icmp ult",
  gt: "icmp ugt",
  lte: "icmp ule",
  gte: "icmp uge",
  rshift: "lshr",
};

function binaryInstruction(op, opType) {
  const useFloat = opType.kind === typeKinds.prim && isFloatPrim(opType.name);
  if (useFloat) {
    const instr = FLOAT_OP_MAP[op];
    if (!instr)
      throw new Error(
        `codegen: unknown binary op "${op}" for type ${opType.kind}/${opType.name ?? ""}`,
      );
    return instr;
  }
  const isUnsignedInt =
    opType.kind === typeKinds.prim && isUnsignedIntPrim(opType.name);
  if (isUnsignedInt && UNSIGNED_INT_OVERRIDES[op]) {
    return UNSIGNED_INT_OVERRIDES[op];
  }
  const instr = INT_OP_MAP[op];
  if (!instr)
    throw new Error(
      `codegen: unknown binary op "${op}" for type ${opType.kind}/${opType.name ?? ""}`,
    );
  return instr;
}

// convenience for tests: parse + typecheck + codegen in one call.
// returns the IR string. throws if typecheck reports errors.
//
// Phase 7.1: routes through the multi-module pipeline with a single
// synthetic module so generics (which require the program-wide
// instantiation registry) work in single-file test fixtures.
export function compileSource(src) {
  const ast = parse(src);
  const mod = { id: "m", ast };
  const { errors, programState } = typecheckProgram([mod]);
  if (errors.length > 0) {
    throw new Error(
      `compileSource: typecheck failed with ${errors.length} error(s):\n` +
        errors.map((e) => `  ${e.message}`).join("\n"),
    );
  }
  // Phase 11.B / 11.C: run the comptime pass + attribute pass in the
  // same order the driver does so this test entry mirrors the real
  // pipeline. Comptime runs first so `@precompile`'s comptimePhase
  // can read each decl's `comptimeFolded` flag.
  runComptimePass([mod], { programState });
  const attrErrors = [];
  runAttributePass([mod], attrErrors);
  if (attrErrors.length > 0) {
    throw new Error(
      `compileSource: attribute pass failed with ${attrErrors.length} error(s):\n` +
        attrErrors.map((e) => `  ${e.message}`).join("\n"),
    );
  }
  const { ir } = codegenProgram([mod], null, programState);
  return ir;
}

// Multi-module codegen. modules must be topologically sorted (leaves first),
// as returned by loadModuleGraph. Returns { ir, linkFlags }.
export function codegenProgram(modules, _moduleEnv, programState) {
  const allStructDefs = [];
  const allGlobals = [];
  const allExterns = new Set();
  const allLines = [];
  const linkFlags = new Set();
  const emittedStructs = new Set();
  const emittedArrayTypes = new Set();
  // One DebugInfo per program. Each module registers a DIFile + DICompileUnit
  // via beginModule and gets a `{ fileMd, cuMd }` handle threaded into its
  // emitter. The finalize() block is appended after all per-module IR.
  const debugInfo = createDebugInfo();
  // llvm.dbg.declare attaches a DILocalVariable to its alloca slot. Declared
  // once globally so per-module emitters can call it without each emitting
  // their own forward declaration.
  allExterns.add("declare void @llvm.dbg.declare(metadata, metadata, metadata)");

  // Phase 7.1: emit each generic-struct instantiation as a struct def.
  // Done before per-module codegen so call-site references resolve.
  if (programState?.registry) {
    for (const [_key, structType] of programState.registry.structs) {
      // Skip open instantiations (still contain TypeParamType).
      if (structContainsTypeParam(structType)) continue;
      const mangled = llvmType(structType);
      if (emittedStructs.has(mangled)) continue;
      emittedStructs.add(mangled);
      const fieldLlvm = (structType.fields ?? [])
        .map((f) => llvmType(f.type))
        .join(", ");
      allStructDefs.push(`${mangled} = type { ${fieldLlvm} }`);
    }
    // Phase 10.A: emit each generic-variant instantiation as
    // %variant.<mod>__<Mangled> = type { i32, [P x i8] } + per-case payload
    // structs. Mirrors the per-module VARIANT_DECL emission shape so codegen
    // GEPs against either an instantiated or a concrete variant the same way.
    for (const [_key, enumType] of programState.registry.variants) {
      if (variantContainsTypeParam(enumType)) continue;
      const mangled = llvmType(enumType);
      if (emittedStructs.has(mangled)) continue;
      emittedStructs.add(mangled);
      let maxPayload = 0;
      for (const v of enumType.variants.values()) {
        if (v.fields === null) continue;
        let off = 0;
        let maxAlign = 1;
        for (const f of v.fields) {
          const al = sizeOfAlign(f.type);
          if (al > maxAlign) maxAlign = al;
          off = Math.floor((off + al - 1) / al) * al + sizeOfType(f.type);
        }
        const padded = Math.floor((off + maxAlign - 1) / maxAlign) * maxAlign;
        if (padded > maxPayload) maxPayload = padded;
      }
      const payloadSize = Math.max(maxPayload, 1);
      allStructDefs.push(`${mangled} = type { i32, [${payloadSize} x i8] }`);
      const enumId = `${enumType.moduleId}__${enumType.name}`;
      for (const v of enumType.variants.values()) {
        if (v.fields === null) continue;
        const variantLlvm = `%variantc.${enumId}__${v.name}`;
        if (emittedStructs.has(variantLlvm)) continue;
        emittedStructs.add(variantLlvm);
        const fieldLlvm = v.fields.map((f) => llvmType(f.type)).join(", ");
        allStructDefs.push(`${variantLlvm} = type { ${fieldLlvm} }`);
      }
    }
  }

  // Per-module emission: collects each module's structDefs/globals/lines
  // (by reference). The per-instance emission inside each module already
  // runs to a local fixed-point, but cloning a generic body during that
  // sweep can register concrete instances belonging to OTHER modules
  // (e.g. `Set<K>` in std/collections/set.yoop references generics in
  // std/collections/map.yoop). Those land on the owning module's
  // registry slot after its sweep finished, so we re-run all modules'
  // flushers in a cross-module fixed-point below before extracting
  // lines.
  const moduleIRs = [];
  for (const mod of modules) {
    for (const decl of mod.ast.body) {
      if (decl.kind === ASTNodeKind.EXTERN_BLOCK && decl.source.kind === "library") {
        linkFlags.add(decl.source.value);
      }
    }
    moduleIRs.push(codegenModule(mod, emittedStructs, emittedArrayTypes, programState, debugInfo));
  }

  // Cross-module fixed-point: keep calling each module's flushInstances
  // until a full pass produces no new emissions. Each flusher mutates
  // the closure-captured `lines` array by reference, so the extraction
  // step below sees the post-flush state.
  const flushers = programState?._instanceFlushers ?? [];
  let crossProgressed = true;
  while (crossProgressed) {
    crossProgressed = false;
    for (const flush of flushers) {
      if (flush()) crossProgressed = true;
    }
  }

  for (const ir of moduleIRs) {
    const { externs, lines } = ir.extract();
    allStructDefs.push(...ir.structDefs);
    allGlobals.push(...ir.globals);
    for (const e of externs) allExterns.add(e);
    allLines.push(...lines);
  }

  const diText = debugInfo.finalize();
  const parts = [
    ...allStructDefs,
    allStructDefs.length ? "" : null,
    ...allGlobals,
    allGlobals.length ? "" : null,
    ...[...allExterns],
    allExterns.size ? "" : null,
    ...allLines,
    "",
    diText,
  ].filter((l) => l !== null);

  return { ir: parts.join("\n"), linkFlags: [...linkFlags] };
}

// Codegen a single module, returning { structDefs, globals, externs, lines }.
// emittedStructs and emittedArrayTypes are shared across modules to deduplicate type defs.
function codegenModule(mod, emittedStructs, emittedArrayTypes, programState, debugInfo) {
  return codegenWithModuleId(
    mod.ast,
    mod.id,
    emittedStructs,
    emittedArrayTypes,
    programState,
    debugInfo,
    mod.absPath,
  );
}

// Phase 7.1: helper for codegenProgram - true iff a struct's fields contain
// any TypeParamType (i.e. the struct is an "open" instantiation built during
// type-checking of a generic decl body).
// Phase 7.1: deep-clone an AST subtree, substituting type-params in every
// `resolvedType` / `declaredReturnType` / `castTargetType` slot we encounter.
// Skip fields known to introduce back-references or that don't need cloning.
const CLONE_SKIP_FIELDS = new Set([
  "genericDecl", // back-ref from decl AST to genericDecl record
  "genericInstantiation", // back-ref from call site to instance record
  "sourceLoc",
  "implementingType", // back-ref to a frozen StructType
]);
// Phase 11.D.7: exported so the comptime interpreter can reuse the
// same per-instance substituted-AST builder codegen uses for
// generic-fn emission. The comptime path is "lower the substituted
// AST into bytecode" - identical input requirement, different output.
export function cloneAstWithSubstitution(node, sub, registry = null) {
  if (node === null || node === undefined) return node;
  if (typeof node !== "object") return node;
  if (Array.isArray(node)) {
    return node.map((n) => cloneAstWithSubstitution(n, sub, registry));
  }
  if (node instanceof Map || node instanceof Set) return node;
  const out = {};
  for (const key of Object.keys(node)) {
    if (CLONE_SKIP_FIELDS.has(key)) {
      out[key] = node[key];
      continue;
    }
    const v = node[key];
    if (
      key === "resolvedType" ||
      key === "declaredReturnType" ||
      key === "castTargetType"
    ) {
      out[key] = v ? substituteTypeParams(v, sub) : v;
    } else if (Array.isArray(v)) {
      out[key] = v.map((x) => cloneAstWithSubstitution(x, sub, registry));
    } else if (v && typeof v === "object") {
      if (v instanceof Map || v instanceof Set) {
        out[key] = v;
      } else if (Object.isFrozen(v)) {
        out[key] = substituteTypeParams(v, sub);
      } else {
        out[key] = cloneAstWithSubstitution(v, sub, registry);
      }
    } else {
      out[key] = v;
    }
  }
  // Phase 7.2: re-instantiate a generic call whose original argTypes carried
  // an outer TypeParamType. After substitution we have concrete argTypes, so
  // we ask the registry for the concrete instance and re-point the call.
  if (
    out.kind === ASTNodeKind.CALL_EXPRESSION &&
    out.genericInstantiation &&
    registry
  ) {
    const oldInst = out.genericInstantiation;
    const decl =
      oldInst.genericDecl ??
      ([...registry.funcInstancesByDecl.values()].flat().find(
        (i) => i.declId === oldInst.declId,
      )?.ast?.genericDecl ?? null);
    if (decl && oldInst.argTypes.some((t) => t?.kind === typeKinds.typeParam)) {
      const newArgs = oldInst.argTypes.map((t) => substituteTypeParams(t, sub));
      const newInst = instantiateFunc(registry, decl, newArgs);
      if (newInst) out.genericInstantiation = newInst;
    }
  }
  // Phase 10.C.3: re-derive the trait-method mangled symbol after
  // substitution. When the receiver is a *concrete* generic-struct
  // instance whose type args carry an outer TypeParamType (e.g.
  // `self.inner` inside `Set<K>`'s `dispose` method, where inner is
  // `Map<K, bool>`), the original mangle captured the open form
  // (`Map_set-K__bool`). After cloning the body for a concrete
  // instantiation (Set<string>), `out.calleeMethodOf` is the
  // substituted struct (Map<string, bool>) - but `calleeMangledName`
  // is still the open form. Re-mangle so codegen emits the right
  // monomorphized symbol.
  if (
    out.kind === ASTNodeKind.CALL_EXPRESSION &&
    out.calleeMethodOf &&
    out.calleeMethodOf.kind === typeKinds.struct &&
    out.calleeTrait
  ) {
    out.calleeMangledName = mangleTraitMethod(
      out.calleeMethodOf,
      out.calleeTrait.name,
      out.calleeMethodName,
    );
  }
  // Phase 7.2: rewrite a bound-method call into a normal struct-method call
  // once the receiver's TypeParamType has been substituted with a concrete
  // struct. The bound check at instantiation guarantees the impl exists.
  // Phase 13.D: a variant receiver takes the identical path - same `methods`
  // map, same trait mangling.
  if (
    out.kind === ASTNodeKind.CALL_EXPRESSION &&
    out.boundMethod
  ) {
    const firstArg = out.args?.[0];
    let recvType = firstArg?.resolvedType;
    if (recvType?.kind === typeKinds.ref) recvType = recvType.inner;
    if (
      !recvType ||
      (recvType.kind !== typeKinds.struct && recvType.kind !== typeKinds.variant)
    ) {
      // Receiver is still abstract - keep the boundMethod tag. This branch is
      // hit when we're producing an "open" instantiation (the outer T flowed
      // in). Open instances are filtered out before IR emission.
      return out;
    }
    const methodSig = recvType.methods?.get(out.boundMethod.methodName);
    if (!methodSig) {
      throw new Error(
        `codegen: bound-method "${out.boundMethod.methodName}" not found on substituted type "${recvType.name}"`,
      );
    }
    out.calleeMethodOf = recvType;
    out.calleeMethodName = out.boundMethod.methodName;
    out.calleeMangledName = mangleTraitMethod(
      recvType,
      out.boundMethod.traitName,
      out.boundMethod.methodName,
    );
    out.boundMethod = null;
  }
  // Phase 10.C: VARIANT_CONSTRUCTOR / VARIANT_PATTERN carry a `resolvedVariant`
  // pointer into their `resolvedVariantType.variants` map. The generic
  // substitution above replaces resolvedVariantType with a fresh instantiation
  // (via the frozen-type branch), but resolvedVariant was a plain non-frozen
  // record that recursive-cloned - its fields may still reference the
  // pre-substitution variant from the *original* enum's variants map.
  // Re-fetch the variant by name from the (substituted) resolvedVariantType
  // so codegen sees the concrete field types.
  if (
    (out.kind === ASTNodeKind.VARIANT_CONSTRUCTOR ||
      out.kind === ASTNodeKind.VARIANT_PATTERN) &&
    out.resolvedVariantType &&
    out.variantName &&
    out.resolvedVariantType.variants?.has?.(out.variantName)
  ) {
    out.resolvedVariant = out.resolvedVariantType.variants.get(out.variantName);
  }
  return out;
}

function structContainsTypeParam(structType) {
  if (!structType.fields) return false;
  const seen = new Set();
  function hasParam(t) {
    if (!t) return false;
    if (t.kind === typeKinds.typeParam) return true;
    if (t.kind === typeKinds.ref) return hasParam(t.inner);
    if (t.kind === typeKinds.array) return hasParam(t.elem);
    if (t.kind === typeKinds.struct) {
      const key = (t.moduleId ? `${t.moduleId}__` : "") + t.name;
      if (seen.has(key)) return false;
      seen.add(key);
      if (!t.fields) return false;
      return t.fields.some((f) => hasParam(f.type));
    }
    return false;
  }
  return structType.fields.some((f) => hasParam(f.type));
}

// Phase 10.A: mirror of structContainsTypeParam for enum instantiations.
// Returns true for an "open" enum whose variant payloads still mention a
// TypeParamType - those are intermediate substitution products that must
// not be emitted as LLVM struct defs.
function variantContainsTypeParam(enumType) {
  if (!enumType.variants) return false;
  const seenStruct = new Set();
  function hasParam(t) {
    if (!t) return false;
    if (t.kind === typeKinds.typeParam) return true;
    if (t.kind === typeKinds.ref) return hasParam(t.inner);
    if (t.kind === typeKinds.array) return hasParam(t.elem);
    if (t.kind === typeKinds.struct) {
      const key = (t.moduleId ? `${t.moduleId}__` : "") + t.name;
      if (seenStruct.has(key)) return false;
      seenStruct.add(key);
      if (!t.fields) return false;
      return t.fields.some((f) => hasParam(f.type));
    }
    if (t.kind === typeKinds.variant) {
      // An open enum's own variants may carry typeParam.
      if (!t.variants) return false;
      for (const v of t.variants.values()) {
        if (v.fields === null) continue;
        if (v.fields.some((f) => hasParam(f.type))) return true;
      }
      return false;
    }
    return false;
  }
  for (const v of enumType.variants.values()) {
    if (v.fields === null) continue;
    if (v.fields.some((f) => hasParam(f.type))) return true;
  }
  return false;
}

function codegenWithModuleId(
  ast,
  moduleId,
  emittedStructs,
  emittedArrayTypes = new Set(),
  programState = null,
  debugInfo = null,
  moduleAbsPath = null,
) {
  const lines = [];
  const globals = [];
  const structDefs = [];
  // Phase 10.K: ctx-dropping shims emitted for `VTableName.fromFn(...)`, keyed
  // by shim symbol so each (module, target function) pair is emitted once.
  const emittedFromFnShims = new Set();
  let strConstCounter = 0;
  let tempCounter = 0;
  let labelCounter = 0;
  const functionSigs = new Map();
  let symbols = createLocalSymbols();
  // Per-module DWARF handles. Lazily initialized via beginModule on first
  // function emission so callers (like compileSource) that synthesize a
  // module without an absPath still get a stable synthetic file name.
  let diFileMd = null;
  let diCuMd = null;
  function ensureDebugModule() {
    if (!debugInfo || diFileMd) return;
    const handle = debugInfo.beginModule(moduleAbsPath ?? `<${moduleId}>.yoop`);
    diFileMd = handle.fileMd;
    diCuMd = handle.cuMd;
  }
  // Build a DISubprogram for a function/method definition. Returns the !N ref
  // to attach to the `define` line and to thread into ctx.subprogram for
  // statement-level DILocation lookups. Returns null when DI is disabled (e.g.
  // legacy callers that didn't supply a debugInfo handle).
  function makeSubprogram(funcName, linkageName, sourceLoc) {
    if (!debugInfo) return null;
    ensureDebugModule();
    const line = sourceLoc?.line && sourceLoc.line > 0 ? sourceLoc.line : 1;
    return debugInfo.subprogram(funcName, linkageName, line, diFileMd, diCuMd);
  }
  // Look up a DILocation for the given AST node. Returns null when DI is off
  // or the current scope hasn't established a subprogram yet (top-level
  // emission). Falls back to line 1 for synthesized nodes without sourceLoc.
  function dbgLocFor(node, ctx) {
    if (!debugInfo || !ctx?.subprogram) return null;
    const loc = node?.sourceLoc;
    const line = loc?.line && loc.line > 0 ? loc.line : 1;
    const col = loc?.column && loc.column > 0 ? loc.column : 0;
    return debugInfo.location(line, col, ctx.subprogram);
  }
  // Fallback pass: LLVM's verifier requires every `call` to another debug-
  // info-bearing function (and every `ret`/`br`/etc. inside a function with
  // a DISubprogram) to carry a !dbg. The per-statement annotation covers
  // user code, but implicit cleanups, runtime init/shutdown, and a few other
  // synthesized lines emit outside emitStmt's wrapper. Sweep the whole
  // function and attach the subprogram's first-line location to anything
  // still unmarked.
  function finalizeFnDbg(fnLines, subprogramRef, fnSourceLoc) {
    if (!debugInfo || !subprogramRef) return;
    const line = fnSourceLoc?.line && fnSourceLoc.line > 0 ? fnSourceLoc.line : 1;
    const fallback = debugInfo.location(line, 0, subprogramRef);
    annotateLinesWithDbg(fnLines, 0, fallback);
  }

  // Map a Yooperlang type to its DI type reference for use in a
  // DILocalVariable. Returns null for shapes we don't yet describe - caller
  // should skip emitting llvm.dbg.declare for that binding so lldb just
  // omits it from `frame variable` rather than showing garbage.
  function diTypeFor(yoopType) {
    if (!yoopType || !debugInfo) return null;
    switch (yoopType.kind) {
      case typeKinds.prim:
        return debugInfo.basicTypeForPrim(yoopType.name);
      case typeKinds.ref:
      case typeKinds.task:
        // Phase MVP+1: refs and Tasks are described as opaque pointers.
        // Once we emit DICompositeType for the pointee struct, we'll thread
        // it through here as the DIDerivedType's baseType.
        return debugInfo.opaquePointer();
      default:
        return null;
    }
  }

  // Emit `call void @llvm.dbg.declare(metadata ptr <slot>, metadata !VAR,
  // metadata !DIExpression()), !dbg !LOC` so lldb can map %slot -> source
  // variable name + type. No-op when DI is off, when the type isn't
  // describable yet, or when the binding has no usable sourceLoc.
  function emitDbgDeclare(fnLines, { name, slotPtr, yoopType, sourceLoc, subprogramRef, argIndex }) {
    if (!debugInfo || !subprogramRef) return;
    const typeRef = diTypeFor(yoopType);
    if (!typeRef) return;
    ensureDebugModule();
    const line = sourceLoc?.line && sourceLoc.line > 0 ? sourceLoc.line : 1;
    const col = sourceLoc?.column && sourceLoc.column > 0 ? sourceLoc.column : 0;
    const varRef = debugInfo.localVariable({
      name,
      scope: subprogramRef,
      file: diFileMd,
      line,
      typeRef,
      argIndex,
    });
    if (!varRef) return;
    const locRef = debugInfo.location(line, col, subprogramRef);
    fnLines.push(
      `  call void @llvm.dbg.declare(metadata ptr ${slotPtr}, metadata ${varRef}, metadata !DIExpression()), !dbg ${locRef}`,
    );
  }
  // Phase 6.3: bindingName -> { taskFnName }. Tracks which task fn a
  // joined/pooled/immediate binding originated from, so `wait <ident>` can
  // recover the result type + struct layout at the wait site.
  let bindingDeclTable = new Map();

  function freshTemp() { return `%t${tempCounter++}`; }
  function freshStrGlobal() { return `@.str_${moduleId}_${strConstCounter++}`; }
  function freshLabel(hint) { return `${hint}_${labelCounter++}`; }

  function ensureArrayTypeDef(elemType) {
    const name = llvmType({ kind: typeKinds.array, elem: elemType });
    if (!emittedArrayTypes.has(name)) {
      emittedArrayTypes.add(name);
      structDefs.push(`${name} = type { ptr, i64 }`);
    }
  }

  function blockIsTerminated(fnLines) {
    for (let i = fnLines.length - 1; i >= 0; i--) {
      const l = fnLines[i].trim();
      if (!l || l.endsWith(":")) return false;
      return l.startsWith("br ") || l.startsWith("ret ");
    }
    return false;
  }

  function emitRawStringGlobal(inner) {
    const name = freshStrGlobal();
    const { llvmStr, byteLen } = encodeStringBytes(inner);
    globals.push(`${name} = private unnamed_addr constant [${byteLen} x i8] c"${llvmStr}", align 1`);
    return { name, byteLen };
  }

  function emitQuotedStringGlobal(quotedValue) {
    return emitRawStringGlobal(quotedValue.slice(1, -1));
  }

  // Phase 11.B.3: append a private `[N x elem]` global backing a
  // comptime-folded array's fat pointer, and return its symbol so the
  // outer `{ ptr <backing>, i64 N }` fat-pointer constant can reference
  // it. Reuses the string-global counter for naming since both produce
  // private aggregates in the same flat namespace.
  function emitRawArrayGlobal({ elemLlvm, count, elemInits }) {
    const name = `@.arr_${moduleId}_${strConstCounter++}`;
    globals.push(
      `${name} = private unnamed_addr constant [${count} x ${elemLlvm}] [${elemInits.join(", ")}], align 8`,
    );
    return name;
  }

  let currentReturnType = null;
  let inMainFn = false;

  // For now, emit struct defs using mangled names. Phase 7.1: generic type
  // decls (with typeParams) have no resolvedType - their instantiations are
  // emitted in codegenProgram from the registry.
  for (const decl of ast.body) {
    const d = decl.kind === ASTNodeKind.EXPORT_DECL ? decl.decl : decl;
    if (d.kind === ASTNodeKind.TYPE_DECL && d.resolvedType && !d.genericDecl) {
      const mangled = llvmType(d.resolvedType);
      if (!emittedStructs.has(mangled)) {
        emittedStructs.add(mangled);
        const fieldLlvm = d.resolvedType.fields
          ? d.resolvedType.fields.map((f) => llvmType(f.type)).join(", ")
          : "";
        structDefs.push(`${mangled} = type { ${fieldLlvm} }`);
      }
    }
    // Phase 7.5: emit variant struct + per-case payload structs.
    //   %variant.<mod>__<V> = type { i32, [P x i8] }     (tag + payload bytes)
    //   %variantc.<mod>__<V>__<C> = type { ... fields ... }  (per-case payload)
    // Phase 10.A: generic variant decls have no resolvedType - they emit their
    // instantiations from the registry walk in codegenProgram instead.
    if (d.kind === ASTNodeKind.VARIANT_DECL && d.resolvedType && !d.genericDecl) {
      const enumLlvm = llvmType(d.resolvedType);
      if (!emittedStructs.has(enumLlvm)) {
        emittedStructs.add(enumLlvm);
        // Payload size = max variant payload size (computed from sizeOfType).
        let maxPayload = 0;
        for (const v of d.resolvedType.variants.values()) {
          if (v.fields === null) continue;
          let off = 0;
          let maxAlign = 1;
          for (const f of v.fields) {
            const al = sizeOfAlign(f.type);
            if (al > maxAlign) maxAlign = al;
            off = Math.floor((off + al - 1) / al) * al + sizeOfType(f.type);
          }
          const padded = Math.floor((off + maxAlign - 1) / maxAlign) * maxAlign;
          if (padded > maxPayload) maxPayload = padded;
        }
        // Always emit a non-empty payload byte array so LLVM accepts the GEP
        // shape uniformly. Min payload size is 1 byte to keep the indexed
        // form `[N x i8]` legal.
        const payloadSize = Math.max(maxPayload, 1);
        structDefs.push(`${enumLlvm} = type { i32, [${payloadSize} x i8] }`);
        // Per-variant payload struct (for variants that have fields).
        const enumId = d.resolvedType.moduleId
          ? `${d.resolvedType.moduleId}__${d.resolvedType.name}`
          : d.resolvedType.name;
        for (const v of d.resolvedType.variants.values()) {
          if (v.fields === null) continue;
          const variantLlvm = `%variantc.${enumId}__${v.name}`;
          if (!emittedStructs.has(variantLlvm)) {
            emittedStructs.add(variantLlvm);
            const fieldLlvm = v.fields.map((f) => llvmType(f.type)).join(", ");
            structDefs.push(`${variantLlvm} = type { ${fieldLlvm} }`);
          }
        }
      }
    }
    // Phase 7.5: emit union struct as a `[N x i8]`-shaped aggregate (max
    // field size, max field alignment). All field accesses bitcast through
    // the byte buffer.
    if (d.kind === ASTNodeKind.UNION_DECL && d.resolvedType) {
      const unionLlvm = llvmType(d.resolvedType);
      if (!emittedStructs.has(unionLlvm)) {
        emittedStructs.add(unionLlvm);
        let maxSize = 0;
        for (const f of d.resolvedType.fields) {
          const s = sizeOfType(f.type);
          if (s > maxSize) maxSize = s;
        }
        const size = Math.max(maxSize, 1);
        structDefs.push(`${unionLlvm} = type { [${size} x i8] }`);
      }
    }
    // Phase 9.G: emit vtable struct as { ptr ctx, ptr m1, ptr m2, ... } -
    // one pointer slot per trait method, in trait declaration order.
    if (d.kind === ASTNodeKind.VTABLE_DECL && d.resolvedType) {
      const vtLlvm = llvmType(d.resolvedType);
      if (!emittedStructs.has(vtLlvm)) {
        emittedStructs.add(vtLlvm);
        const slots = ["ptr"]; // ctx
        for (const _ of d.resolvedType.methodOrder) slots.push("ptr");
        structDefs.push(`${vtLlvm} = type { ${slots.join(", ")} }`);
      }
    }
  }

  // Collect C-exported function names - these are defined with unmangled symbols.
  const cExportNames = new Set();
  for (const decl of ast.body) {
    if (decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL) cExportNames.add(decl.fn.name);
  }

  // Collect extern function names and emit declares. `extern "intrinsic"`
  // blocks are compiler-recognized - see the note in the legacy path above
  // - so we skip emitting LLVM declares for them.
  const externFnNames = new Set();
  for (const decl of ast.body) {
    if (decl.kind !== ASTNodeKind.EXTERN_BLOCK) continue;
    const isIntrinsic = decl.abi === "intrinsic";
    for (const ext of decl.decls) {
      if (ext.kind !== ASTNodeKind.EXTERN_FUNCTION_DECL) continue;
      externFnNames.add(ext.name);
      if (isIntrinsic) continue;
      const params = ext.params.map((p) => llvmType(p.resolvedType)).join(", ");
      const ret = llvmType(ext.resolvedType);
      const sig = ext.variadic
        ? `declare ${ret} @${ext.name}(${params}${params ? ", " : ""}...)`
        : `declare ${ret} @${ext.name}(${params})`;
      lines.push(sig);
    }
  }
  // strlen (used by try-op and s.len)
  if (needsStrlen(ast)) lines.push("declare i64 @strlen(ptr)");
  // printf legacy fallback
  if (usesLegacyPrintf(ast) && !externFnNames.has("printf")) {
    lines.push("declare i32 @printf(ptr, ...)");
  }
  // Runtime ABI declares - emitted in every module so the dedup pass folds
  // them into a single declare per symbol in the final IR.
  lines.push(...RUNTIME_DECLARES);
  if (lines.length) lines.push("");

  // Phase 6.3: collect task function metadata. Each task fn gets its own
  // %Task_<modId>__<fnName> struct: prefix layout (per runtime-design §1.a)
  // followed by the result slot and per-arg fields.
  const taskFnTable = new Map(); // taskFnName -> { decl, structName, resultType, args }
  for (const decl of ast.body) {
    const d =
      decl.kind === ASTNodeKind.EXPORT_DECL ? decl.decl :
      decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL ? decl.fn :
      decl;
    if (d.kind === ASTNodeKind.FUNCTION_DECL && d.isTask) {
      const structName = taskStructName(moduleId, d.name);
      const resultType = d.declaredReturnType;
      const args = (d.params ?? []).map((p) => p.resolvedType);
      taskFnTable.set(d.name, { decl: d, structName, resultType, args });
      // Emit the struct def: prefix + result + args. LLVM handles alignment.
      const fields = [
        "ptr",                  // 0: thunk
        "i8",                   // 8: state
        "[3 x i8]",             // 9: pad
        "i32",                  // 12: refcount
        "ptr",                  // 16: mutex_ptr
        "ptr",                  // 24: cond_ptr
        llvmType(resultType),   // 32: result slot
        ...args.map((a) => llvmType(a)),
      ];
      structDefs.push(`${structName} = type { ${fields.join(", ")} }`);
    }
  }

  // Phase 8.E: collect module-level let/const decls and emit one LLVM
  // `@<modid>__<name>` global per binding with `zeroinitializer`. The
  // initializer expression itself runs in the synthesized `<modid>__module_init`
  // function emitted at the bottom of this pass. Order is source order -
  // matches the typechecker's mod.moduleInitDecls.
  //
  // (Bytecode/CTE future) - a future evaluator could classify some inits
  // as constant-foldable, emit them as the LLVM initial value, and drop
  // them from the runtime init function. The MVP routes everything
  // through the runtime function.
  // Phase 11.B: a module-level decl that the comptime pass managed to
  // fold carries `decl.comptimeFolded = true` + `decl.comptimeValue`.
  // We emit its `@global` with the literal value baked in and skip it
  // when synthesizing the runtime `module_init` - the value is already
  // there at load time, no init call needed. Unfolded decls still go
  // through the existing `zeroinitializer` + runtime init path.
  const moduleLevelDecls = [];      // decls that still need runtime init
  for (const decl of ast.body) {
    // Phase 11.C: an ATTRIBUTE node (e.g. `@precompile const X = ...`)
    // wraps a let/const decl; unwrap it for the standard
    // module-level-decl path. The attribute's runtime effects (none
    // for @precompile - its sole purpose is to demand the fold
    // succeed) are handled by the attribute pass, which runs before
    // codegen.
    const outer = decl.kind === ASTNodeKind.EXPORT_DECL ? decl.decl : decl;
    const d =
      outer.kind === ASTNodeKind.ATTRIBUTE && outer.target
        ? outer.target
        : outer;
    if (
      (d.kind === ASTNodeKind.LET_DECL || d.kind === ASTNodeKind.CONST_DECL) &&
      d.isModuleLevel
    ) {
      const sym = `@${moduleId}__${d.name}`;
      // Array-typed globals need their `%yoop_array.<T>` type def
      // emitted before any reference to it (LLVM verifier rejects
      // forward references to unknown named types). Today the runtime
      // module_init path triggers this via emitExpr; for folded
      // array globals nothing else calls it, so do it here unconditionally.
      if (d.resolvedType.kind === typeKinds.array) {
        ensureArrayTypeDef(d.resolvedType.elem);
      }
      const lty = llvmType(d.resolvedType);
      const linkage = decl.kind === ASTNodeKind.EXPORT_DECL ? "" : "internal ";
      const initLiteral = d.comptimeFolded
        ? comptimeValueAsLlvmInit(d.comptimeValue, d.resolvedType, {
            emitRawStringGlobal,
            emitRawArrayGlobal,
          })
        : null;
      if (initLiteral != null) {
        globals.push(`${sym} = ${linkage}global ${lty} ${initLiteral}, align 8`);
      } else {
        globals.push(`${sym} = ${linkage}global ${lty} zeroinitializer, align 8`);
        moduleLevelDecls.push(d);
      }
    }
  }
  // Register the symbols on programState so the entry module's `main`
  // emission can call each module's `__module_init` after yoop_runtime_init.
  // Only register when there's actually a function to call - if every
  // module-level decl folded, emitModuleInit emits nothing and a
  // registered symbol would dangle as an undefined reference.
  if (moduleLevelDecls.length > 0) {
    if (programState && !programState.moduleInitSymbols) {
      programState.moduleInitSymbols = [];
    }
    if (programState?.moduleInitSymbols) {
      programState.moduleInitSymbols.push(`${moduleId}__module_init`);
    }
  }

  // Collect function sigs. Phase 7.1: skip generic decls - their
  // instantiations register their own sigs in the registry.
  for (const decl of ast.body) {
    const d =
      decl.kind === ASTNodeKind.EXPORT_DECL ? decl.decl :
      decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL ? decl.fn :
      decl;
    if (d.kind === ASTNodeKind.FUNCTION_DECL && !d.genericDecl) {
      const isTask = !!d.isTask;
      functionSigs.set(d.name, {
        params: (d.params ?? []).map((p) => p.resolvedType),
        // For task fns, the body itself returns the declared T; the rewritten
        // Task<T> return is the *external* signature seen by callers.
        returnType: isTask ? d.declaredReturnType : d.resolvedType,
        isTask,
      });
    }
    if (decl.kind === ASTNodeKind.EXTERN_BLOCK) {
      for (const ext of decl.decls) {
        if (ext.kind !== ASTNodeKind.EXTERN_FUNCTION_DECL) continue;
        functionSigs.set(ext.name, {
          params: ext.params.map((p) => p.resolvedType),
          returnType: ext.resolvedType,
          variadic: ext.variadic,
        });
      }
    }
  }

  // Emit function and method bodies. Phase 7.1: skip generic decls; their
  // per-instantiation bodies are emitted from the registry below.
  for (const decl of ast.body) {
    if (decl.kind === ASTNodeKind.FUNCTION_DECL) {
      if (decl.genericDecl) continue;
      // "main" is the C entry point - never mangle it.
      const sym = decl.name === "main" ? "main" : mangle(moduleId, decl.name);
      emitFn(decl, sym);
      if (decl.isTask) emitTaskThunk(decl);
    } else if (decl.kind === ASTNodeKind.EXPORT_DECL && decl.decl.kind === ASTNodeKind.FUNCTION_DECL) {
      if (decl.decl.genericDecl) continue;
      const sym = decl.decl.name === "main" ? "main" : mangle(moduleId, decl.decl.name);
      emitFn(decl.decl, sym);
      if (decl.decl.isTask) emitTaskThunk(decl.decl);
    } else if (decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL) {
      emitFn(decl.fn, decl.fn.name); // unmangled
    } else if (decl.kind === ASTNodeKind.TYPE_DECL && decl.methods?.length > 0 && !decl.genericDecl) {
      for (const method of decl.methods) {
        emitMethodFn(method, decl.resolvedType);
      }
    } else if (decl.kind === ASTNodeKind.EXPORT_DECL && decl.decl.kind === ASTNodeKind.TYPE_DECL && decl.decl.methods?.length > 0 && !decl.decl.genericDecl) {
      for (const method of decl.decl.methods) {
        emitMethodFn(method, decl.decl.resolvedType);
      }
    } else if (decl.kind === ASTNodeKind.VARIANT_DECL && decl.methods?.length > 0 && !decl.genericDecl) {
      // Phase 13.B: variant impl methods in the multi-module path.
      for (const method of decl.methods) {
        emitMethodFn(method, decl.resolvedType);
      }
    } else if (decl.kind === ASTNodeKind.EXPORT_DECL && decl.decl.kind === ASTNodeKind.VARIANT_DECL && decl.decl.methods?.length > 0 && !decl.decl.genericDecl) {
      for (const method of decl.decl.methods) {
        emitMethodFn(method, decl.decl.resolvedType);
      }
    }
    // TRAIT_DECL: no codegen - traits are compile-time only
  }

  // Phase 8.E: emit the synthesized module-init function for this module's
  // top-level let/const initializers (after user functions so any user
  // function called from an initializer is already declared above).
  emitModuleInit(moduleLevelDecls);

  // Phase 7.1 + 10.C.3: per-instance emission factored out as a closure so
  // codegenProgram can re-invoke it across modules in a fixed-point sweep.
  // Cloning a generic body during emission can register additional concrete
  // instances belonging to OTHER modules (e.g. `Set<K>`'s body in
  // std/collections/set.yoop references generic functions defined in
  // std/collections/map.yoop - when Set<string> is monomorphized,
  // map_contains_key<string, bool> lands in the map module's registry
  // slot, which may have already finished its own per-instance sweep).
  // The outer fixed-point in codegenProgram keeps calling each module's
  // closure until a full pass produces no new emissions.
  function flushInstances() {
    if (!programState?.registry) return false;
    let made = false;
    for (const [_declId, instances] of programState.registry.funcInstancesByDecl) {
      for (const inst of instances) {
        if (inst.moduleId !== moduleId) continue;
        if (inst.emitted) continue;
        // Phase 7.2: skip "open" instances where some argType is still a
        // TypeParamType (came from a generic-calls-generic site). They only
        // exist in the registry as caching artifacts - the concrete instances
        // produced when the outer generic is monomorphized are what get IR.
        if (inst.argTypes.some((t) => t?.kind === typeKinds.typeParam)) continue;
        // Builtin generic funcs (heap_alloc / heap_free) have no AST body -
        // codegen inlines them at every call site (see emitCallExpr).
        if (inst.declId?.startsWith("$builtin")) continue;
        inst.emitted = true;
        emitGenericFuncInstance(inst);
        made = true;
      }
    }
    // Phase 7.x: emit method bodies for each concrete generic-struct instance.
    // For `type Foo<T> implements Trait { function m(ref self): ... }`, each
    // unique Foo<C> needs its own substituted method body, with the symbol
    // mangled via mangleTraitMethod using the monomorphized name.
    const emittedStructMethods =
      programState._emittedStructMethods ??
      (programState._emittedStructMethods = new WeakSet());
    for (const [declId, instances] of programState.registry.structInstancesByDecl) {
      const genericDecl = programState.registry.genericDeclById?.get(declId);
      if (!genericDecl) continue;
      const typeDecl = genericDecl.ast;
      if (!typeDecl || !typeDecl.methods?.length) continue;
      if (genericDecl.moduleId !== moduleId) continue;
      for (const inst of instances) {
        if (inst.moduleId !== moduleId) continue;
        if (emittedStructMethods.has(inst)) continue;
        // Skip open instances (still carry TypeParamType in args).
        if (
          inst.genericInstance?.args?.some(
            (t) => t?.kind === typeKinds.typeParam,
          )
        ) continue;
        emittedStructMethods.add(inst);
        emitGenericStructMethods(inst, genericDecl);
        made = true;
      }
    }
    return made;
  }

  // First sweep at decl-emit time so single-module callers (the legacy
  // `codegen()` entry, tests that don't go through `codegenProgram`)
  // still get per-instance IR alongside the per-decl IR.
  while (flushInstances()) { /* keep sweeping until stable */ }

  if (programState) {
    programState._instanceFlushers ??= [];
    programState._instanceFlushers.push(flushInstances);
  }

  // Return raw lines + a deferred extractor - codegenProgram may invoke
  // flushInstances again (cross-module fixed-point), which mutates the
  // closure-captured `lines` in place. Snapshot-on-return would miss those.
  return {
    structDefs,
    globals,
    rawLines: lines,
    extract() {
      return {
        externs: new Set(lines.filter((l) => l.startsWith("declare"))),
        lines: lines.filter((l) => !l.startsWith("declare")),
      };
    },
  };

  // ---- inner helpers (replicated from codegen() for mangling support) ----

  function alignOfStruct(structType) {
    const fields = structType.fields ?? [];
    let max = 1;
    for (const f of fields) {
      const a = f.type.kind === typeKinds.struct ? alignOfStruct(f.type) : alignOf(llvmType(f.type));
      if (a > max) max = a;
    }
    const typeAlign = typeLevelAlign(structType);
    if (typeAlign && typeAlign > max) max = typeAlign;
    return max;
  }

  // Phase 6.5: read the substituted layout-align value from a struct's
  // type-level KindApplication, or null if none.
  function typeLevelAlign(structType) {
    const app = structType?.kindApplication;
    if (!app) return null;
    const slot = app.kindType?.layoutAlign;
    if (!slot) return null;
    if (slot.kind === "const") return slot.value;
    if (slot.kind === "param") {
      const idx = app.kindType.params.findIndex((p) => p.name === slot.name);
      if (idx < 0 || idx >= app.args.length) return null;
      return app.args[idx];
    }
    return null;
  }

  // Phase 6.5: effective alignment for a binding site (consults the
  // binding-site KindApplication first, then alignOfStruct/alignOf).
  function effectiveAlign(declType, kindApp) {
    if (kindApp) {
      const slot = kindApp.kindType?.layoutAlign;
      if (slot) {
        if (slot.kind === "const") return slot.value;
        if (slot.kind === "param") {
          const idx = kindApp.kindType.params.findIndex((p) => p.name === slot.name);
          if (idx >= 0 && idx < kindApp.args.length) return kindApp.args[idx];
        }
      }
    }
    if (declType?.kind === typeKinds.struct) return alignOfStruct(declType);
    return alignOf(llvmType(declType));
  }

  // Phase 7.1: emit a single instantiation of a generic function. We clone
  // the original AST body with type-params substituted, then run emitFn on
  // the clone with the mangled symbol.
  function emitGenericFuncInstance(inst) {
    const decl = inst.ast;
    const sub = new Map();
    const inner = new Map();
    for (let i = 0; i < inst.argTypes.length; i++) {
      inner.set(decl.genericDecl.paramNames[i], inst.argTypes[i]);
    }
    sub.set(inst.declId, inner);
    const cloned = cloneAstWithSubstitution(
      decl,
      sub,
      programState?.registry ?? null,
    );
    const sym = mangle(moduleId, inst.mangledName);
    emitFn(cloned, sym);
  }

  // Phase 7.x: emit method bodies for a single struct instance. Each method
  // gets cloned with type-param substitution and routed through emitMethodFn,
  // which already handles per-trait mangle and `ref self` plumbing. The
  // structType passed to emitMethodFn is the concrete (monomorphized) instance
  // so mangleTraitMethod produces e.g. `mod__DynArray__int32__Disposable__dispose`.
  function emitGenericStructMethods(structInst, genericDecl) {
    const typeDecl = genericDecl.ast;
    const args = structInst.genericInstance?.args ?? [];
    const sub = new Map();
    const inner = new Map();
    for (let i = 0; i < args.length; i++) {
      inner.set(genericDecl.paramNames[i], args[i]);
    }
    sub.set(genericDecl.id, inner);
    for (const method of typeDecl.methods ?? []) {
      const cloned = cloneAstWithSubstitution(
        method,
        sub,
        programState?.registry ?? null,
      );
      emitMethodFn(cloned, structInst);
    }
  }

  function emitFn(node, symName) {
    tempCounter = 0;
    labelCounter = 0;
    symbols = createLocalSymbols();
    bindingDeclTable = new Map();
    currentReturnType = node.resolvedType;
    const prevInMain = inMainFn;
    inMainFn = symName === "main";
    const params = node.params ?? [];
    const llvmRet = llvmType(node.resolvedType);
    const paramSig = params.map((p) => `${llvmType(p.resolvedType)} %${p.name}.arg`).join(", ");
    const subprogramRef = makeSubprogram(node.name ?? symName, symName, node.sourceLoc);
    const dbgSuffix = subprogramRef ? ` !dbg ${subprogramRef}` : "";
    const fnLines = [`define ${llvmRet} @${symName}(${paramSig})${dbgSuffix} {`, "entry:"];
    if (inMainFn) {
      fnLines.push("  call void @yoop_runtime_init()");
      // --track-heap: register the dump as an atexit handler so every
      // exit path prints heap totals once. Registered before module_init
      // so allocations made during static initializers are counted.
      if (programState?.trackHeap) {
        const atexitRet = freshTemp();
        fnLines.push(`  ${atexitRet} = call i32 @atexit(ptr @yoop_diag_dump)`);
      }
      // Phase 8.E: run every module's __module_init in topological order.
      // The list is populated as each module is codegen'd (see the
      // moduleLevelDecls block earlier in this file). Order matches the
      // module graph's topological order from loadModuleGraph.
      const initSyms = programState?.moduleInitSymbols ?? [];
      for (const sym of initSyms) {
        fnLines.push(`  call void @${sym}()`);
      }
    }
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      const ty = p.resolvedType;
      // Phase 8.H: ensure %yoop_array.<T> is emitted for array-typed params,
      // since the alloca below names that struct type.
      if (ty.kind === typeKinds.array) ensureArrayTypeDef(ty.elem);
      const llvmTy = llvmType(ty);
      const paramSlot = symbols.declare(p.name, ty);
      const al = effectiveAlign(ty, p.resolvedKindApplication);
      fnLines.push(`  ${paramSlot} = alloca ${llvmTy}, align ${al}`);
      fnLines.push(`  store ${llvmTy} %${p.name}.arg, ptr ${paramSlot}`);
      emitDbgDeclare(fnLines, {
        name: p.name,
        slotPtr: paramSlot,
        yoopType: ty,
        sourceLoc: p.sourceLoc ?? node.sourceLoc,
        subprogramRef,
        argIndex: i + 1, // DWARF arg index is 1-based
      });
    }
    const ctx = { fnName: symName, returnType: node.resolvedType, subprogram: subprogramRef };
    node.body.body.forEach((s) => emitStmt(s, fnLines, ctx));
    emitImplicitCleanups(node.body, fnLines);
    if (isVoidReturn(node.resolvedType)) {
      const last = fnLines[fnLines.length - 1].trim();
      if (!last.startsWith("ret")) {
        if (inMainFn) fnLines.push("  call void @yoop_runtime_shutdown()");
        fnLines.push("  ret void");
      }
    } else if (!blockIsTerminated(fnLines)) {
      // Non-void body left an open tail block (e.g. an exhaustive `switch`
      // whose arms all diverge). The typechecker proved every path returns,
      // so the block is unreachable - terminate it for the verifier.
      fnLines.push("  unreachable");
    }
    fnLines.push("}");
    hoistAllocasToEntry(fnLines);
    finalizeFnDbg(fnLines, subprogramRef, node.sourceLoc);
    lines.push(...fnLines);
    inMainFn = prevInMain;
  }

  // Phase 8.E: synthesize @<modid>__module_init that runs every top-level
  // let/const initializer in source order, storing into the corresponding
  // @global. Called from main right after yoop_runtime_init() (see emitFn).
  //
  // (Bytecode/CTE future) - this is the smallest discrete codegen entity
  // for a CTE pass: parameter-free, returns void, operates only on
  // module-owned @globals. A future evaluator can replace this with
  // bytecode interpretation, or skip it entirely when every init has
  // been folded to an LLVM @global initial value.
  function emitModuleInit(decls) {
    if (decls.length === 0) return;
    tempCounter = 0;
    labelCounter = 0;
    symbols = createLocalSymbols();
    const symName = `${moduleId}__module_init`;
    const fnLines = [
      `define internal void @${symName}() {`,
      "entry:",
    ];
    for (const d of decls) {
      const initVal = emitExpr(d.assignment, fnLines);
      const lty = llvmType(d.resolvedType);
      const gsym = `@${moduleId}__${d.name}`;
      fnLines.push(`  store ${lty} ${initVal.val}, ptr ${gsym}`);
    }
    fnLines.push("  ret void");
    fnLines.push("}");
    hoistAllocasToEntry(fnLines);
    lines.push(...fnLines);
  }

  function emitMethodFn(methodDecl, structType) {
    // Phase 7.4: one impl body can satisfy multiple traits - emit one define
    // per trait, all sharing the same body.
    const traits = methodDecl.implementsTraits ?? [];
    for (const traitName of traits) {
      emitMethodFnOnce(methodDecl, structType, traitName);
    }
  }

  function emitMethodFnOnce(methodDecl, structType, traitName) {
    tempCounter = 0;
    labelCounter = 0;
    symbols = createLocalSymbols();
    bindingDeclTable = new Map();
    currentReturnType = methodDecl.resolvedFuncType.returnType;

    const returnType = methodDecl.resolvedFuncType.returnType;
    const params = methodDecl.params;
    const llvmRet = llvmType(returnType);

    const paramSig = params.map((p) => `${llvmType(p.resolvedType)} %${p.name}.arg`).join(", ");
    const mangled = mangleTraitMethod(structType, traitName, methodDecl.name);
    const subprogramRef = makeSubprogram(methodDecl.name, mangled, methodDecl.sourceLoc);
    const dbgSuffix = subprogramRef ? ` !dbg ${subprogramRef}` : "";
    const fnLines = [`define ${llvmRet} @${mangled}(${paramSig})${dbgSuffix} {`, "entry:"];

    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      const ty = p.resolvedType;
      const paramSlot = symbols.declare(p.name, ty);
      if (ty.kind === typeKinds.ref) {
        fnLines.push(`  ${paramSlot} = alloca ptr, align 8`);
        fnLines.push(`  store ptr %${p.name}.arg, ptr ${paramSlot}`);
      } else {
        const llvmTy = llvmType(ty);
        const al = effectiveAlign(ty, p.resolvedKindApplication);
        fnLines.push(`  ${paramSlot} = alloca ${llvmTy}, align ${al}`);
        fnLines.push(`  store ${llvmTy} %${p.name}.arg, ptr ${paramSlot}`);
      }
      emitDbgDeclare(fnLines, {
        name: p.name,
        slotPtr: paramSlot,
        yoopType: ty,
        sourceLoc: p.sourceLoc ?? methodDecl.sourceLoc,
        subprogramRef,
        argIndex: i + 1,
      });
    }

    const ctx = { fnName: methodDecl.name, returnType, subprogram: subprogramRef };
    methodDecl.body.body.forEach((s) => emitStmt(s, fnLines, ctx));
    emitImplicitCleanups(methodDecl.body, fnLines);

    if (isVoidReturn(returnType)) {
      const last = fnLines[fnLines.length - 1].trim();
      if (!last.startsWith("ret")) fnLines.push("  ret void");
    } else if (!blockIsTerminated(fnLines)) {
      // See emitFn: an exhaustive all-diverging switch leaves an unreachable
      // tail block; terminate it.
      fnLines.push("  unreachable");
    }
    fnLines.push("}");
    hoistAllocasToEntry(fnLines);
    finalizeFnDbg(fnLines, subprogramRef, methodDecl.sourceLoc);
    lines.push(...fnLines);
  }

  // Phase 6.3: per-task-function thunk. Layout-aware: GEP into the handle's
  // result slot (field 6) and arg fields (7..) by struct index. The body
  // itself is emitted via emitFn as a regular function returning T.
  function emitTaskThunk(taskDecl) {
    const meta = taskFnTable.get(taskDecl.name);
    if (!meta) return;
    const tcount = (n) => `%tt${n}`;
    let tn = 0;
    const fnLines = [];
    const thunkSym = `${mangle(moduleId, taskDecl.name)}__thunk`;
    fnLines.push(`define void @${thunkSym}(ptr %ts) {`);
    fnLines.push("entry:");
    // Load each arg from its corresponding struct field (7 + i).
    const argVals = [];
    for (let i = 0; i < meta.args.length; i++) {
      const argType = meta.args[i];
      const llvmArgTy = llvmType(argType);
      const gep = tcount(tn++);
      fnLines.push(
        `  ${gep} = getelementptr inbounds ${meta.structName}, ptr %ts, i32 0, i32 ${7 + i}`,
      );
      const val = tcount(tn++);
      fnLines.push(`  ${val} = load ${llvmArgTy}, ptr ${gep}`);
      argVals.push({ val, ty: llvmArgTy });
    }
    const bodySym = mangle(moduleId, taskDecl.name);
    const argList = argVals.map((a) => `${a.ty} ${a.val}`).join(", ");
    const resultLlvm = llvmType(meta.resultType);
    if (isVoidReturn(meta.resultType)) {
      fnLines.push(`  call void @${bodySym}(${argList})`);
    } else {
      const resVal = tcount(tn++);
      fnLines.push(`  ${resVal} = call ${resultLlvm} @${bodySym}(${argList})`);
      // Store the result at field 6.
      const resPtr = tcount(tn++);
      fnLines.push(
        `  ${resPtr} = getelementptr inbounds ${meta.structName}, ptr %ts, i32 0, i32 6`,
      );
      fnLines.push(`  store ${resultLlvm} ${resVal}, ptr ${resPtr}`);
    }
    fnLines.push("  call void @yoop_handle_signal_done(ptr %ts)");
    fnLines.push("  ret void");
    fnLines.push("}");
    hoistAllocasToEntry(fnLines);
    lines.push(...fnLines);
  }

  // Phase 6.3: helpers shared by joined / pooled / immediate binding emission.
  // Initializes the prefix fields and stores args. Caller is responsible for
  // alloca/heap allocation of the handle.
  function emitTaskHandleInit(handlePtr, taskFnName, argNodes, fnLines) {
    const meta = taskFnTable.get(taskFnName);
    const thunkSym = `${mangle(moduleId, taskFnName)}__thunk`;
    // field 0: thunk pointer
    const thunkPtr = freshTemp();
    fnLines.push(
      `  ${thunkPtr} = getelementptr inbounds ${meta.structName}, ptr ${handlePtr}, i32 0, i32 0`,
    );
    fnLines.push(`  store ptr @${thunkSym}, ptr ${thunkPtr}`);
    // field 1: state = 0 (atomic store)
    const statePtr = freshTemp();
    fnLines.push(
      `  ${statePtr} = getelementptr inbounds ${meta.structName}, ptr ${handlePtr}, i32 0, i32 1`,
    );
    fnLines.push(`  store i8 0, ptr ${statePtr}`);
    // Phase 10.F.2: cancel byte at offset 9 = 0. Reuses the first byte of
    // the `[3 x i8]` padding at field index 2 - accessed by byte offset
    // so the struct's LLVM type stays unchanged. Pooled handles via
    // yoop_task_alloc come from calloc and are already zeroed; joined
    // handles via alloca are not, hence the explicit store.
    const cancelPtr = freshTemp();
    fnLines.push(
      `  ${cancelPtr} = getelementptr inbounds i8, ptr ${handlePtr}, i64 9`,
    );
    fnLines.push(`  store i8 0, ptr ${cancelPtr}`);
    // field 4 / 5: mutex_ptr / cond_ptr = null (yoop_task_submit allocates them).
    const mPtr = freshTemp();
    fnLines.push(
      `  ${mPtr} = getelementptr inbounds ${meta.structName}, ptr ${handlePtr}, i32 0, i32 4`,
    );
    fnLines.push(`  store ptr null, ptr ${mPtr}`);
    const cPtr = freshTemp();
    fnLines.push(
      `  ${cPtr} = getelementptr inbounds ${meta.structName}, ptr ${handlePtr}, i32 0, i32 5`,
    );
    fnLines.push(`  store ptr null, ptr ${cPtr}`);
    // args at fields 7..
    for (let i = 0; i < argNodes.length; i++) {
      const arg = emitExpr(argNodes[i], fnLines);
      const llvmArgTy = llvmType(meta.args[i]);
      const slotPtr = freshTemp();
      fnLines.push(
        `  ${slotPtr} = getelementptr inbounds ${meta.structName}, ptr ${handlePtr}, i32 0, i32 ${7 + i}`,
      );
      fnLines.push(`  store ${llvmArgTy} ${arg.val}, ptr ${slotPtr}`);
    }
    return { thunkSym, meta };
  }

  // Compute sizeof(Task struct) via the getelementptr null trick.
  function emitTaskStructSize(meta, fnLines) {
    const sizeTmp = freshTemp();
    fnLines.push(
      `  ${sizeTmp} = getelementptr ${meta.structName}, ptr null, i32 1`,
    );
    const sizeI64 = freshTemp();
    fnLines.push(`  ${sizeI64} = ptrtoint ptr ${sizeTmp} to i64`);
    return sizeI64;
  }

  // Pull the task fn name out of a CALL_EXPRESSION RHS. Currently only
  // local-module task calls are supported (no imported task fns in 6.3).
  function taskCallFnName(callExpr) {
    if (callExpr.kind !== ASTNodeKind.CALL_EXPRESSION) return null;
    if (typeof callExpr.callee !== "string") return null;
    if (callExpr.calleeModuleId) {
      // Imported task fn - out of 6.3 scope; reject at codegen.
      throw new Error(`codegen: cross-module task calls not supported in phase 6.3`);
    }
    return taskFnTable.has(callExpr.callee) ? callExpr.callee : null;
  }

  function calleeSymbol(node) {
    // Phase 7.1: generic-function call - use the instantiation's mangled name.
    if (node.genericInstantiation) {
      const inst = node.genericInstantiation;
      return mangle(inst.moduleId, inst.mangledName);
    }
    if (node.calleeModuleId) return mangle(node.calleeModuleId, node.calleeExportName);
    if (externFnNames.has(node.callee) || cExportNames.has(node.callee)) return node.callee;
    return mangle(moduleId, node.callee);
  }

  // Phase 8.A: multi-module pointer-arithmetic / comparison emitter.
  function emitPointerBinaryMM(node, fnLines) {
    const op = node.op;
    if (op === "eqeq" || op === "neq") {
      const l = emitExpr(node.left, fnLines);
      const r = emitExpr(node.right, fnLines);
      const cond = op === "eqeq" ? "eq" : "ne";
      const tmp = freshTemp();
      fnLines.push(`  ${tmp} = icmp ${cond} ptr ${l.val}, ${r.val}`);
      return { val: tmp, yoopType: PrimType("bool") };
    }
    if (op === "plus" || op === "minus") {
      const leftIsPtr =
        node.left.resolvedType?.kind === typeKinds.unsafePtr;
      const rightIsPtr =
        node.right.resolvedType?.kind === typeKinds.unsafePtr;
      if (leftIsPtr && rightIsPtr && op === "minus") {
        const l = emitExpr(node.left, fnLines);
        const r = emitExpr(node.right, fnLines);
        const li = freshTemp();
        const ri = freshTemp();
        fnLines.push(`  ${li} = ptrtoint ptr ${l.val} to i64`);
        fnLines.push(`  ${ri} = ptrtoint ptr ${r.val} to i64`);
        const diff = freshTemp();
        fnLines.push(`  ${diff} = sub i64 ${li}, ${ri}`);
        const pointee = node.left.resolvedType.pointee;
        const elemLlvmTy = llvmType(pointee);
        const sizeofTmp = freshTemp();
        fnLines.push(`  ${sizeofTmp} = getelementptr ${elemLlvmTy}, ptr null, i32 1`);
        const sizeInt = freshTemp();
        fnLines.push(`  ${sizeInt} = ptrtoint ptr ${sizeofTmp} to i64`);
        const out = freshTemp();
        fnLines.push(`  ${out} = sdiv i64 ${diff}, ${sizeInt}`);
        return { val: out, yoopType: PrimType("int64") };
      }
      const ptrSide = leftIsPtr ? node.left : node.right;
      const intSide = leftIsPtr ? node.right : node.left;
      const ptrVal = emitExpr(ptrSide, fnLines);
      const intVal = emitExpr(intSide, fnLines);
      const pointee = ptrSide.resolvedType.pointee;
      const elemLlvmTy = llvmType(pointee);
      let offsetVal = intVal.val;
      let offsetLlvmTy = llvmType(intVal.yoopType);
      if (offsetLlvmTy !== "i64") {
        const widened = freshTemp();
        fnLines.push(`  ${widened} = sext ${offsetLlvmTy} ${offsetVal} to i64`);
        offsetVal = widened;
        offsetLlvmTy = "i64";
      }
      if (op === "minus") {
        const neg = freshTemp();
        fnLines.push(`  ${neg} = sub i64 0, ${offsetVal}`);
        offsetVal = neg;
      }
      const out = freshTemp();
      fnLines.push(`  ${out} = getelementptr ${elemLlvmTy}, ptr ${ptrVal.val}, i64 ${offsetVal}`);
      return { val: out, yoopType: ptrSide.resolvedType };
    }
    throw new Error(`codegen: unsupported pointer binary op "${op}"`);
  }

  function emitExpr(node, fnLines) {
    switch (node.kind) {
      case ASTNodeKind.INT_LITERAL: {
        const t = node.resolvedType.kind === typeKinds.untypedInt ? PrimType("int32") : node.resolvedType;
        return { val: String(node.value), yoopType: t };
      }
      case ASTNodeKind.FLOAT_LITERAL: {
        const t = node.resolvedType.kind === typeKinds.untypedFloat ? PrimType("float64") : node.resolvedType;
        return { val: llvmFloatConstant(node.value, t.name), yoopType: t };
      }
      case ASTNodeKind.STRING_LITERAL: {
        const { name, byteLen } = emitQuotedStringGlobal(node.value);
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = getelementptr inbounds [${byteLen} x i8], ptr ${name}, i32 0, i32 0`);
        return { val: tmp, yoopType: PrimType("string") };
      }
      case ASTNodeKind.BOOL_LITERAL: {
        return { val: node.value ? "1" : "0", yoopType: PrimType("bool") };
      }
      case ASTNodeKind.IDENT: {
        // Phase 8.E: module-level globals load from @<modid>__<name>.
        // The typechecker tags every IDENT that resolves via moduleSymbols
        // (and is not a function / namespace) with isModuleGlobal + the
        // pre-mangled symbol so codegen doesn't have to re-derive it.
        if (node.isModuleGlobal) {
          const yoopType = node.resolvedType;
          const llvmTy = llvmType(yoopType);
          const tmp = freshTemp();
          fnLines.push(`  ${tmp} = load ${llvmTy}, ptr @${node.moduleGlobalSym}`);
          return { val: tmp, yoopType };
        }
        // Phase 10.X.2: an IDENT in expression position whose resolved type
        // is a FuncType denotes the function decl itself - typically used as
        // a fn-ptr value (assigning to a `(p: T) => R`-typed struct field).
        // Lower to the function's mangled symbol address.
        if (node.resolvedType?.kind === typeKinds.func && !symbols.has(node.name)) {
          const sym = node.calleeModuleId
            ? mangle(node.calleeModuleId, node.calleeExportName ?? node.name)
            : mangle(moduleId, node.name);
          return { val: `@${sym}`, yoopType: node.resolvedType };
        }
        const yoopType = symbols.get(node.name);
        if (!yoopType) throw new Error(`codegen: unknown identifier "${node.name}"`);
        if (node.autoDeref) {
          const innerType = yoopType.inner;
          const ptrTmp = freshTemp();
          fnLines.push(`  ${ptrTmp} = load ptr, ptr ${symbols.slotFor(node.name)}`);
          const valTmp = freshTemp();
          fnLines.push(`  ${valTmp} = load ${llvmType(innerType)}, ptr ${ptrTmp}`);
          return { val: valTmp, yoopType: innerType };
        }
        const llvmTy = llvmType(yoopType);
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = load ${llvmTy}, ptr ${symbols.slotFor(node.name)}`);
        return { val: tmp, yoopType };
      }
      case ASTNodeKind.REF_EXPRESSION: {
        if (node.operand.kind === ASTNodeKind.IDENT) {
          const operandType = symbols.get(node.operand.name);
          if (operandType?.kind === typeKinds.ref) {
            // ref of a ref binding (like `ref self`): forward the underlying pointer
            const ptrTmp = freshTemp();
            fnLines.push(`  ${ptrTmp} = load ptr, ptr ${symbols.slotFor(node.operand.name)}`);
            return { val: ptrTmp, yoopType: node.resolvedType };
          }
          return { val: `${symbols.slotFor(node.operand.name)}`, yoopType: node.resolvedType };
        }
        // field access or index: use emitLval to get the address
        const lv = emitLval(node.operand, fnLines);
        return { val: lv.ptr, yoopType: node.resolvedType };
      }
      case ASTNodeKind.CALL_EXPRESSION: return emitCallExpr(node, fnLines);
      case ASTNodeKind.BINARY_EXPRESSION: {
        // Phase 8.A: route pointer arithmetic / pointer-null comparison
        // through emitPointerBinaryMM. Same logic as single-module path.
        const leftTy = node.left.resolvedType;
        const rightTy = node.right.resolvedType;
        if (
          leftTy?.kind === typeKinds.unsafePtr ||
          rightTy?.kind === typeKinds.unsafePtr ||
          leftTy?.kind === typeKinds.untypedNull ||
          rightTy?.kind === typeKinds.untypedNull
        ) {
          return emitPointerBinaryMM(node, fnLines);
        }
        // Enum tag-comparison branch (mirror of the single-module path
        // above). See plans/archive/yoopbinder-papercuts.md Issue 3.
        if (
          (node.op === "eqeq" || node.op === "neq") &&
          leftTy?.kind === typeKinds.variant &&
          rightTy?.kind === typeKinds.variant
        ) {
          const l = emitExpr(node.left, fnLines);
          const r = emitExpr(node.right, fnLines);
          const enumLlvm = llvmType(leftTy);
          const lTag = freshTemp();
          const rTag = freshTemp();
          fnLines.push(`  ${lTag} = extractvalue ${enumLlvm} ${l.val}, 0`);
          fnLines.push(`  ${rTag} = extractvalue ${enumLlvm} ${r.val}, 0`);
          const cond = node.op === "eqeq" ? "eq" : "ne";
          const out = freshTemp();
          fnLines.push(`  ${out} = icmp ${cond} i32 ${lTag}, ${rTag}`);
          return { val: out, yoopType: PrimType("bool") };
        }
        const l = emitExpr(node.left, fnLines);
        const r = emitExpr(node.right, fnLines);
        const resultType = node.resolvedType;
        const isCmp = ["eqeq","neq","lt","gt","lte","gte"].includes(node.op);
        const opType = isCmp ? l.yoopType : resultType;
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = ${binaryInstruction(node.op, opType)} ${llvmType(opType)} ${l.val}, ${r.val}`);
        return { val: tmp, yoopType: resultType };
      }
      case ASTNodeKind.NULL_LITERAL: {
        return { val: "null", yoopType: node.resolvedType };
      }
      case ASTNodeKind.ADDRESS_OF_EXPRESSION: {
        const lv = emitLval(node.operand, fnLines);
        return { val: lv.ptr, yoopType: node.resolvedType };
      }
      case ASTNodeKind.DEREF_EXPRESSION: {
        const p = emitExpr(node.operand, fnLines);
        const pointee = node.resolvedType;
        const llvmTy = llvmType(pointee);
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = load ${llvmTy}, ptr ${p.val}`);
        return { val: tmp, yoopType: pointee };
      }
      case ASTNodeKind.ERRNO_INTRINSIC: {
        // Phase 8.D: lower to runtime helpers in yoop_runtime.c.
        if (node.op === "get") {
          const tmp = freshTemp();
          fnLines.push(`  ${tmp} = call i32 @yoop_errno_get()`);
          return { val: tmp, yoopType: PrimType("int32") };
        }
        if (node.op === "set") {
          const arg = emitExpr(node.operand, fnLines);
          fnLines.push(`  call void @yoop_errno_set(i32 ${arg.val})`);
          return { val: "", yoopType: VoidType() };
        }
        if (node.op === "message") {
          const arg = emitExpr(node.operand, fnLines);
          const tmp = freshTemp();
          fnLines.push(`  ${tmp} = call ptr @yoop_errno_message(i32 ${arg.val})`);
          return { val: tmp, yoopType: PrimType("string") };
        }
        throw new Error(`codegen: unknown errno intrinsic "${node.op}"`);
      }
      case ASTNodeKind.UNSAFE_PTR_CAST: {
        const operand = emitExpr(node.operand, fnLines);
        if (node.castKind === "bitcast") {
          return { val: operand.val, yoopType: node.resolvedType };
        }
        if (node.castKind === "toInt") {
          const tmp = freshTemp();
          fnLines.push(`  ${tmp} = ptrtoint ptr ${operand.val} to i64`);
          return { val: tmp, yoopType: PrimType("uintptr") };
        }
        if (node.castKind === "fromInt") {
          const tmp = freshTemp();
          const srcLlvmTy = llvmType(operand.yoopType);
          fnLines.push(`  ${tmp} = inttoptr ${srcLlvmTy} ${operand.val} to ptr`);
          return { val: tmp, yoopType: node.resolvedType };
        }
        if (node.castKind === "toArray") {
          // Phase 8.C: fat-pointer view {data, len}. No copy.
          const arrayType = node.resolvedType;
          ensureArrayTypeDef(arrayType.elem);
          const arrayLlvmTy = llvmType(arrayType);
          const len = emitExpr(node.lengthOperand, fnLines);
          const fatSlot = freshTemp();
          fnLines.push(`  ${fatSlot} = alloca ${arrayLlvmTy}, align 8`);
          const dataField = freshTemp();
          fnLines.push(`  ${dataField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 0`);
          fnLines.push(`  store ptr ${operand.val}, ptr ${dataField}`);
          const lenField = freshTemp();
          fnLines.push(`  ${lenField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 1`);
          fnLines.push(`  store i64 ${len.val}, ptr ${lenField}`);
          const fatVal = freshTemp();
          fnLines.push(`  ${fatVal} = load ${arrayLlvmTy}, ptr ${fatSlot}`);
          return { val: fatVal, yoopType: arrayType };
        }
        throw new Error(`codegen: unknown unsafe_ptr cast kind "${node.castKind}"`);
      }
      case ASTNodeKind.UNARY_EXPRESSION: {
        const operand = emitExpr(node.operand, fnLines);
        const resultType = node.resolvedType;
        const llvmTy = llvmType(resultType);
        const tmp = freshTemp();
        if (node.op === "minus") {
          if (resultType.kind === typeKinds.prim && (resultType.name === "float32" || resultType.name === "float64")) {
            fnLines.push(`  ${tmp} = fneg ${llvmTy} ${operand.val}`);
          } else {
            fnLines.push(`  ${tmp} = sub ${llvmTy} 0, ${operand.val}`);
          }
        } else if (node.op === "not") {
          fnLines.push(`  ${tmp} = xor ${llvmTy} ${operand.val}, 1`);
        } else if (node.op === "bitnot") {
          // Phase 9: `~x` lowers to `xor <ty> x, -1`. LLVM treats the -1
          // immediate as all-ones at any integer width.
          fnLines.push(`  ${tmp} = xor ${llvmTy} ${operand.val}, -1`);
        } else {
          throw new Error(`codegen: unhandled unary op "${node.op}"`);
        }
        return { val: tmp, yoopType: resultType };
      }
      case ASTNodeKind.ASSIGNMENT: {
        if (node.target.kind === ASTNodeKind.IDENT) {
          const targetName = node.target.name;
          // Phase 8.E: assignment to a module-level let stores into the
          // @<modid>__<name> global. The typechecker rejected cross-
          // module imported targets, so any isModuleGlobal here is
          // module-local writable.
          if (node.target.isModuleGlobal) {
            const lhsType = node.target.resolvedType;
            const rhs = emitExpr(node.value, fnLines);
            fnLines.push(`  store ${llvmType(lhsType)} ${rhs.val}, ptr @${node.target.moduleGlobalSym}`);
            return rhs;
          }
          const lhsType = symbols.get(targetName);
          if (node.target.autoDerefWrite) {
            const innerType = lhsType.inner;
            const ptrTmp = freshTemp();
            fnLines.push(`  ${ptrTmp} = load ptr, ptr ${symbols.slotFor(targetName)}`);
            const rhs = emitExpr(node.value, fnLines);
            fnLines.push(`  store ${llvmType(innerType)} ${rhs.val}, ptr ${ptrTmp}`);
            return rhs;
          }
          const rhs = emitExpr(node.value, fnLines);
          fnLines.push(`  store ${llvmType(lhsType)} ${rhs.val}, ptr ${symbols.slotFor(targetName)}`);
          return rhs;
        }
        if (node.target.kind === ASTNodeKind.FIELD_ACCESS) {
          const lv = emitLval(node.target, fnLines);
          if (node.value.kind === ASTNodeKind.STRUCT_LITERAL && lv.type.kind === typeKinds.struct) {
            emitStructLitInto(node.value, lv.ptr, lv.type, fnLines);
            const tmp = freshTemp();
            fnLines.push(`  ${tmp} = load ${llvmType(lv.type)}, ptr ${lv.ptr}`);
            return { val: tmp, yoopType: lv.type };
          }
          const rhs = emitExpr(node.value, fnLines);
          fnLines.push(`  store ${llvmType(lv.type)} ${rhs.val}, ptr ${lv.ptr}`);
          return rhs;
        }
        if (node.target.kind === ASTNodeKind.INDEX_EXPRESSION) {
          const lv = emitLval(node.target, fnLines);
          const rhs = emitExpr(node.value, fnLines);
          fnLines.push(`  store ${llvmType(lv.type)} ${rhs.val}, ptr ${lv.ptr}`);
          return rhs;
        }
        if (node.target.kind === ASTNodeKind.DEREF_EXPRESSION) {
          // Phase 8.A: `*p = v` - store through an unsafe_ptr<T>.
          const ptrExpr = emitExpr(node.target.operand, fnLines);
          const rhs = emitExpr(node.value, fnLines);
          const pointee = node.target.resolvedType;
          fnLines.push(`  store ${llvmType(pointee)} ${rhs.val}, ptr ${ptrExpr.val}`);
          return rhs;
        }
        throw new Error(`codegen: unsupported assignment target kind "${node.target.kind}"`);
      }
      // Phase 9: compound assignment - addresses the lvalue exactly once,
      // loads the current value, applies the binary op, stores the result.
      case ASTNodeKind.COMPOUND_ASSIGNMENT: {
        // Resolve the storage slot. Result: { ptr, type, isReg, regName? }
        // For local IDENTs we just remember the register name and emit
        // `%name`-relative load/store; for everything else we emit a pointer
        // through emitLval and load/store through it.
        let slotPtr, slotType;
        if (node.target.kind === ASTNodeKind.IDENT && !node.target.isModuleGlobal && !node.target.autoDerefWrite) {
          slotType = symbols.get(node.target.name);
          slotPtr = `${symbols.slotFor(node.target.name)}`;
        } else if (node.target.kind === ASTNodeKind.IDENT && node.target.isModuleGlobal) {
          slotType = node.target.resolvedType;
          slotPtr = `@${node.target.moduleGlobalSym}`;
        } else if (node.target.kind === ASTNodeKind.IDENT && node.target.autoDerefWrite) {
          const lhsType = symbols.get(node.target.name);
          slotType = lhsType.inner;
          const ptrTmp = freshTemp();
          fnLines.push(`  ${ptrTmp} = load ptr, ptr ${symbols.slotFor(node.target.name)}`);
          slotPtr = ptrTmp;
        } else if (node.target.kind === ASTNodeKind.DEREF_EXPRESSION) {
          const ptrExpr = emitExpr(node.target.operand, fnLines);
          slotType = node.target.resolvedType;
          slotPtr = ptrExpr.val;
        } else {
          // FIELD_ACCESS or INDEX_EXPRESSION - emitLval addresses the slot
          // exactly once (no double-eval of e.g. xs[f()]).
          const lv = emitLval(node.target, fnLines);
          slotType = lv.type;
          slotPtr = lv.ptr;
        }
        const llvmTy = llvmType(slotType);
        const oldVal = freshTemp();
        fnLines.push(`  ${oldVal} = load ${llvmTy}, ptr ${slotPtr}`);
        const rhs = emitExpr(node.value, fnLines);
        const newVal = freshTemp();
        fnLines.push(`  ${newVal} = ${binaryInstruction(node.op, slotType)} ${llvmTy} ${oldVal}, ${rhs.val}`);
        fnLines.push(`  store ${llvmTy} ${newVal}, ptr ${slotPtr}`);
        return { val: newVal, yoopType: slotType };
      }
      case ASTNodeKind.FIELD_ACCESS: {
        // Phase 12: `ns.constName` (non-call) - the typechecker stamped
        // `namespaceLookup` and resolvedType when it walked the namespace
        // dispatch. Load directly from the mangled module-level global.
        // Call-position `ns.fn(...)` is handled in emitCallExpr via the
        // callee.namespaceLookup branch and never reaches here.
        if (node.namespaceLookup) {
          const sym = mangle(node.namespaceLookup.moduleId, node.namespaceLookup.exportName);
          const yoopType = node.resolvedType;
          const llvmTy = llvmType(yoopType);
          const tmp = freshTemp();
          fnLines.push(`  ${tmp} = load ${llvmTy}, ptr @${sym}`);
          return { val: tmp, yoopType };
        }
        const objType = node.object.resolvedType;
        if (objType?.kind === typeKinds.prim && objType.name === "string" && node.field === "len") {
          const s = emitExpr(node.object, fnLines);
          const tmp = freshTemp();
          fnLines.push(`  ${tmp} = call i64 @strlen(ptr ${s.val})`);
          return { val: tmp, yoopType: PrimType("usize") };
        }
        if (node.isArrayLen) {
          const lv = emitLval(node.object, fnLines);
          const arrayLlvmTy = llvmType(lv.type);
          const lenField = freshTemp();
          fnLines.push(`  ${lenField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${lv.ptr}, i32 0, i32 1`);
          const lenVal = freshTemp();
          fnLines.push(`  ${lenVal} = load i64, ptr ${lenField}`);
          return { val: lenVal, yoopType: PrimType("usize") };
        }
        // Phase 8.C: `xs.ptr` - GEP field 0 of the fat pointer, load.
        if (node.isArrayPtr) {
          const lv = emitLval(node.object, fnLines);
          const arrayLlvmTy = llvmType(lv.type);
          const dataField = freshTemp();
          fnLines.push(`  ${dataField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${lv.ptr}, i32 0, i32 0`);
          const dataVal = freshTemp();
          fnLines.push(`  ${dataVal} = load ptr, ptr ${dataField}`);
          return { val: dataVal, yoopType: node.resolvedType };
        }
        const lv = emitLval(node, fnLines);
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = load ${llvmType(lv.type)}, ptr ${lv.ptr}`);
        return { val: tmp, yoopType: lv.type };
      }
      case ASTNodeKind.ARRAY_LITERAL: {
        const arrayType = node.resolvedType;
        ensureArrayTypeDef(arrayType.elem);
        const elemLlvmTy = llvmType(arrayType.elem);
        const n = node.elements.length;
        // Heap-allocate the backing buffer rather than stack-alloca. An array
        // literal's fat pointer escapes the current function whenever it is
        // stored into a module-level global (its initializer runs inside
        // __module_init, which returns), returned, or stashed in a struct
        // field - a stack buffer would dangle the moment that frame unwinds
        // (the dangling-tokenScanList bug). malloc keeps the data alive for
        // the array's full reach. Trade-off: a non-escaping local literal now
        // leaks until an escape analysis can reclaim it; correctness first.
        // Deliberately NOT recorded under --track-heap: with no matching free
        // yet, counting these would report false leaks for the common local
        // case and skew the balanced-accounting fixtures.
        const byteSize = n * sizeOfType(arrayType.elem);
        const dataBuf = freshTemp();
        fnLines.push(`  ${dataBuf} = call ptr @malloc(i64 ${byteSize})`);
        for (let i = 0; i < n; i++) {
          const elemVal = emitExpr(node.elements[i], fnLines);
          const gepTmp = freshTemp();
          fnLines.push(`  ${gepTmp} = getelementptr [${n} x ${elemLlvmTy}], ptr ${dataBuf}, i32 0, i32 ${i}`);
          fnLines.push(`  store ${elemLlvmTy} ${elemVal.val}, ptr ${gepTmp}`);
        }
        const dataPtr = freshTemp();
        fnLines.push(`  ${dataPtr} = getelementptr [${n} x ${elemLlvmTy}], ptr ${dataBuf}, i32 0, i32 0`);
        const arrayLlvmTy = llvmType(arrayType);
        const fatSlot = freshTemp();
        fnLines.push(`  ${fatSlot} = alloca ${arrayLlvmTy}, align 8`);
        const dataField = freshTemp();
        fnLines.push(`  ${dataField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 0`);
        fnLines.push(`  store ptr ${dataPtr}, ptr ${dataField}`);
        const lenField = freshTemp();
        fnLines.push(`  ${lenField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 1`);
        fnLines.push(`  store i64 ${n}, ptr ${lenField}`);
        const fatVal = freshTemp();
        fnLines.push(`  ${fatVal} = load ${arrayLlvmTy}, ptr ${fatSlot}`);
        return { val: fatVal, yoopType: arrayType };
      }
      case ASTNodeKind.INDEX_EXPRESSION: {
        const lv = emitLval(node, fnLines);
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = load ${llvmType(lv.type)}, ptr ${lv.ptr}`);
        return { val: tmp, yoopType: lv.type };
      }
      // Phase 9.E: `xs[i..j]` - zero-copy fat-pointer subview. Builds
      // {xs.ptr + start * sizeof(T), end - start} from the source fat
      // pointer; open bounds default start→0, end→xs.len.
      case ASTNodeKind.SLICE_EXPRESSION: {
        const arrayType = node.resolvedType;
        const elemType = arrayType.elem;
        ensureArrayTypeDef(elemType);
        const arrayLlvmTy = llvmType(arrayType);
        const elemLlvmTy = llvmType(elemType);
        const fatArg = emitExpr(node.object, fnLines);
        // Stash the source fat pointer into an alloca so we can GEP fields.
        const srcSlot = freshTemp();
        fnLines.push(`  ${srcSlot} = alloca ${arrayLlvmTy}, align 8`);
        fnLines.push(`  store ${arrayLlvmTy} ${fatArg.val}, ptr ${srcSlot}`);
        const srcDataField = freshTemp();
        fnLines.push(`  ${srcDataField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${srcSlot}, i32 0, i32 0`);
        const srcDataPtr = freshTemp();
        fnLines.push(`  ${srcDataPtr} = load ptr, ptr ${srcDataField}`);
        const srcLenField = freshTemp();
        fnLines.push(`  ${srcLenField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${srcSlot}, i32 0, i32 1`);
        const srcLen = freshTemp();
        fnLines.push(`  ${srcLen} = load i64, ptr ${srcLenField}`);
        // Widen any narrower integer to i64 (signed-extend mirrors the
        // existing pointer-arithmetic path at line ~3020).
        const widenToI64 = (v) => {
          const ty = llvmType(v.yoopType);
          if (ty === "i64") return v.val;
          const w = freshTemp();
          fnLines.push(`  ${w} = sext ${ty} ${v.val} to i64`);
          return w;
        };
        const startI64 = node.start
          ? widenToI64(emitExpr(node.start, fnLines))
          : "0";
        const endI64 = node.end
          ? widenToI64(emitExpr(node.end, fnLines))
          : srcLen;
        // newDataPtr = srcDataPtr + start (element units).
        const newDataPtr = freshTemp();
        fnLines.push(`  ${newDataPtr} = getelementptr inbounds ${elemLlvmTy}, ptr ${srcDataPtr}, i64 ${startI64}`);
        // newLen = end - start.
        const newLen = freshTemp();
        fnLines.push(`  ${newLen} = sub i64 ${endI64}, ${startI64}`);
        // Build result fat pointer.
        const resSlot = freshTemp();
        fnLines.push(`  ${resSlot} = alloca ${arrayLlvmTy}, align 8`);
        const resDataField = freshTemp();
        fnLines.push(`  ${resDataField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${resSlot}, i32 0, i32 0`);
        fnLines.push(`  store ptr ${newDataPtr}, ptr ${resDataField}`);
        const resLenField = freshTemp();
        fnLines.push(`  ${resLenField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${resSlot}, i32 0, i32 1`);
        fnLines.push(`  store i64 ${newLen}, ptr ${resLenField}`);
        const resVal = freshTemp();
        fnLines.push(`  ${resVal} = load ${arrayLlvmTy}, ptr ${resSlot}`);
        return { val: resVal, yoopType: arrayType };
      }
      case ASTNodeKind.TRY_OP: {
        // Phase 9.H: enum operand - extract the Ok variant payload (or void).
        const slot = emitTrySlot(node, fnLines);
        const okStripped = strippedVariantOkType(slot.type);
        if (okStripped.kind === typeKinds.void) {
          return { val: "void", yoopType: VoidType() };
        }
        const enumId = slot.type.moduleId
          ? `${slot.type.moduleId}__${slot.type.name}`
          : slot.type.name;
        const payloadLlvm = `%variantc.${enumId}__Ok`;
        const fieldLlvm = llvmType(okStripped);
        const payloadPtr = freshTemp();
        fnLines.push(`  ${payloadPtr} = getelementptr inbounds ${llvmType(slot.type)}, ptr ${slot.ptr}, i32 0, i32 1`);
        const fieldPtr = freshTemp();
        fnLines.push(`  ${fieldPtr} = getelementptr inbounds ${payloadLlvm}, ptr ${payloadPtr}, i32 0, i32 0`);
        const v = freshTemp();
        fnLines.push(`  ${v} = load ${fieldLlvm}, ptr ${fieldPtr}`);
        return { val: v, yoopType: okStripped };
      }
      case ASTNodeKind.STRUCT_LITERAL: {
        const st = node.resolvedType;
        const tmpPtr = freshTemp();
        fnLines.push(`  ${tmpPtr} = alloca ${llvmType(st)}, align ${alignOfStruct(st)}`);
        emitStructLitInto(node, tmpPtr, st, fnLines);
        const loadTmp = freshTemp();
        fnLines.push(`  ${loadTmp} = load ${llvmType(st)}, ptr ${tmpPtr}`);
        return { val: loadTmp, yoopType: st };
      }
      case ASTNodeKind.TEMPLATE_LITERAL: {
        const hasInterp = node.parts.some((p) => p.kind === ASTNodeKind.EXPR_PART);
        if (hasInterp) {
          return emitInterpolatedTemplateLiteral(node, fnLines);
        }
        const inner = node.parts.map((p) => p.value).join("");
        const { name, byteLen } = emitRawStringGlobal(inner);
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = getelementptr inbounds [${byteLen} x i8], ptr ${name}, i32 0, i32 0`);
        return { val: tmp, yoopType: PrimType("string") };
      }
      case ASTNodeKind.WAIT_EXPRESSION: {
        return emitWaitExpression(node, fnLines);
      }
      case ASTNodeKind.VARIANT_CONSTRUCTOR: {
        return emitVariantConstructor(node, fnLines);
      }
      default: throw new Error(`codegen: unhandled expression kind "${node.kind}"`);
    }
  }

  // Phase 7.5: emit `Variant.Case { f1: v1, ... }` (or no-payload `Variant.C`).
  // Layout: alloca variant struct -> store tag at field 0 -> bitcast payload
  // bytes to the per-case payload struct and GEP/store each field -> load
  // the whole struct as the rvalue.
  // Phase 12: when the constructor targets a value enum, emit the case's
  // primitive constant value directly (no alloca/load).
  function emitVariantConstructor(node, fnLines) {
    if (node.resolvedValueEnumType) {
      return emitValueEnumConstant(node, fnLines);
    }
    const enumType = node.resolvedVariantType;
    const variant = node.resolvedVariant;
    if (!enumType || !variant) {
      throw new Error(`codegen: variant constructor missing resolved enum/variant`);
    }
    const enumLlvm = llvmType(enumType);
    const slot = freshTemp();
    fnLines.push(`  ${slot} = alloca ${enumLlvm}, align ${sizeOfAlign(enumType)}`);
    // tag store
    const tagPtr = freshTemp();
    fnLines.push(`  ${tagPtr} = getelementptr inbounds ${enumLlvm}, ptr ${slot}, i32 0, i32 0`);
    fnLines.push(`  store i32 ${variant.ordinal}, ptr ${tagPtr}`);
    // payload store (only if the variant has fields)
    if (variant.fields !== null && node.fields !== null && node.fields.length > 0) {
      const payloadPtr = freshTemp();
      fnLines.push(`  ${payloadPtr} = getelementptr inbounds ${enumLlvm}, ptr ${slot}, i32 0, i32 1`);
      const enumId = enumType.moduleId
        ? `${enumType.moduleId}__${enumType.name}`
        : enumType.name;
      const variantLlvm = `%variantc.${enumId}__${variant.name}`;
      for (const litField of node.fields) {
        const idx = variant.fields.findIndex((f) => f.name === litField.name);
        if (idx < 0) continue;
        const fieldType = variant.fields[idx].type;
        const fieldPtr = freshTemp();
        fnLines.push(`  ${fieldPtr} = getelementptr inbounds ${variantLlvm}, ptr ${payloadPtr}, i32 0, i32 ${idx}`);
        const rhs = emitExpr(litField.value, fnLines);
        fnLines.push(`  store ${llvmType(fieldType)} ${rhs.val}, ptr ${fieldPtr}`);
      }
    }
    const loadTmp = freshTemp();
    fnLines.push(`  ${loadTmp} = load ${enumLlvm}, ptr ${slot}`);
    return { val: loadTmp, yoopType: enumType };
  }

  // Phase 12: emit a value-enum case as its underlying primitive constant.
  // Integer underlyings produce the integer literal directly (immediate).
  // String underlyings produce a getelementptr against a deduplicated global.
  function emitValueEnumConstant(node, fnLines) {
    const enumType = node.resolvedValueEnumType;
    const enumCase = node.resolvedValueEnumCase;
    if (!enumType || !enumCase) {
      throw new Error(`codegen: value-enum constructor missing resolved type/case`);
    }
    const underlying = enumType.underlying;
    if (underlying.name === "string") {
      const { name: gname, byteLen } = emitRawStringGlobal(enumCase.value);
      const tmp = freshTemp();
      fnLines.push(
        `  ${tmp} = getelementptr inbounds [${byteLen} x i8], ptr ${gname}, i32 0, i32 0`,
      );
      return { val: tmp, yoopType: enumType };
    }
    // Integer underlying: emit the bigint as a decimal literal (LLVM accepts
    // negative decimals for signed ints).
    const v = typeof enumCase.value === "bigint"
      ? enumCase.value.toString()
      : String(enumCase.value);
    return { val: v, yoopType: enumType };
  }

  // Phase 6.3: `wait <ident>`. The operand must be a Task<T>-typed binding
  // (joined or pooled). Load its handle ptr, block in the runtime, then load
  // the result from field 6.
  // Phase 6.4: also accepts a pooled parameter (no bindingDeclTable entry);
  // we fall back to a byte-offset GEP since the originating task fn is unknown.
  function emitWaitExpression(node, fnLines) {
    const operand = node.operand;
    if (operand.kind !== ASTNodeKind.IDENT) {
      throw new Error(`codegen: wait operand must be a binding identifier in phase 6.3`);
    }
    const handlePtr = freshTemp();
    fnLines.push(`  ${handlePtr} = load ptr, ptr ${symbols.slotFor(operand.name)}`);
    fnLines.push(`  call void @yoop_task_wait(ptr ${handlePtr})`);

    const decl = bindingDeclTable.get(operand.name);
    if (decl) {
      // Known task fn: use the typed GEP for clarity.
      const meta = taskFnTable.get(decl.taskFnName);
      const resultLlvm = llvmType(meta.resultType);
      const resPtr = freshTemp();
      fnLines.push(
        `  ${resPtr} = getelementptr inbounds ${meta.structName}, ptr ${handlePtr}, i32 0, i32 6`,
      );
      const resVal = freshTemp();
      fnLines.push(`  ${resVal} = load ${resultLlvm}, ptr ${resPtr}`);
      return { val: resVal, yoopType: meta.resultType };
    }

    // Anonymous source (e.g. `pooled h` parameter). The result type comes
    // from the operand's TaskType; the result slot lives at byte offset 32
    // of every task struct (prefix layout is universal - see runtime-design.md).
    const operandType = symbols.get(operand.name);
    const resultType = operandType.resultType;
    const resultLlvm = llvmType(resultType);
    const resPtr = freshTemp();
    fnLines.push(`  ${resPtr} = getelementptr inbounds i8, ptr ${handlePtr}, i64 32`);
    const resVal = freshTemp();
    fnLines.push(`  ${resVal} = load ${resultLlvm}, ptr ${resPtr}`);
    return { val: resVal, yoopType: resultType };
  }

  // Phase 10.F + 10.F.2: `wait_until(h, deadline_ns): WaitResult<T>`
  // lowering. The runtime returns an i32 outcome - 0 done, 1 timeout, 2
  // cancelled - and we dispatch via a switch to build the matching
  // variant. The result-slot byte offset is the universal task-struct
  // prefix offset (32) so the same shape works for joined/pooled
  // bindings and pooled parameters alike.
  function emitWaitUntilCall(node, fnLines) {
    const handleVal = emitExpr(node.args[0], fnLines);
    const deadlineVal = emitExpr(node.args[1], fnLines);

    const outcomeTmp = freshTemp();
    fnLines.push(
      `  ${outcomeTmp} = call i32 @yoop_task_wait_until_ns(ptr ${handleVal.val}, i64 ${deadlineVal.val})`,
    );

    const waitResultType = node.builtinWaitResultType;
    const resultT = node.builtinTaskResultType;
    const enumLlvm = llvmType(waitResultType);
    const slot = freshTemp();
    fnLines.push(
      `  ${slot} = alloca ${enumLlvm}, align ${sizeOfAlign(waitResultType)}`,
    );
    fnLines.push(`  store ${enumLlvm} zeroinitializer, ptr ${slot}`);

    const doneVariant = waitResultType.variants.get("Done");
    const timeoutVariant = waitResultType.variants.get("Timeout");
    const cancelledVariant = waitResultType.variants.get("Cancelled");

    const doneLabel = freshLabel("wu_done");
    const timeoutLabel = freshLabel("wu_timeout");
    const cancelledLabel = freshLabel("wu_cancelled");
    const joinLabel = freshLabel("wu_join");

    // Three-way switch on the runtime outcome - `cancelled` only appears
    // when the Cancelled variant exists in the user's WaitResult shape,
    // which it always does post-10.F.2 (Cancelled is now part of the
    // canonical std/core/concurrency.yoop enum). Default branch jumps
    // to cancelled so any future runtime extension (e.g. CancelledByPeer)
    // falls through to a safe interpretation instead of u.b.
    fnLines.push(
      `  switch i32 ${outcomeTmp}, label %${cancelledLabel} [ i32 0, label %${doneLabel} i32 1, label %${timeoutLabel} ]`,
    );

    const enumId = waitResultType.moduleId
      ? `${waitResultType.moduleId}__${waitResultType.name}`
      : waitResultType.name;

    fnLines.push(`${doneLabel}:`);
    {
      const tagPtr = freshTemp();
      fnLines.push(
        `  ${tagPtr} = getelementptr inbounds ${enumLlvm}, ptr ${slot}, i32 0, i32 0`,
      );
      fnLines.push(`  store i32 ${doneVariant.ordinal}, ptr ${tagPtr}`);

      // Copy the task's result (handle byte offset 32) into the Done variant's
      // single payload field `value`.
      const resPtr = freshTemp();
      fnLines.push(
        `  ${resPtr} = getelementptr inbounds i8, ptr ${handleVal.val}, i64 32`,
      );
      const resultLlvm = llvmType(resultT);
      const resVal = freshTemp();
      fnLines.push(`  ${resVal} = load ${resultLlvm}, ptr ${resPtr}`);

      const payloadPtr = freshTemp();
      fnLines.push(
        `  ${payloadPtr} = getelementptr inbounds ${enumLlvm}, ptr ${slot}, i32 0, i32 1`,
      );
      const valuePtr = freshTemp();
      fnLines.push(
        `  ${valuePtr} = getelementptr inbounds %variantc.${enumId}__Done, ptr ${payloadPtr}, i32 0, i32 0`,
      );
      fnLines.push(`  store ${resultLlvm} ${resVal}, ptr ${valuePtr}`);
      fnLines.push(`  br label %${joinLabel}`);
    }

    fnLines.push(`${timeoutLabel}:`);
    {
      const tagPtr = freshTemp();
      fnLines.push(
        `  ${tagPtr} = getelementptr inbounds ${enumLlvm}, ptr ${slot}, i32 0, i32 0`,
      );
      fnLines.push(`  store i32 ${timeoutVariant.ordinal}, ptr ${tagPtr}`);
      fnLines.push(`  br label %${joinLabel}`);
    }

    fnLines.push(`${cancelledLabel}:`);
    {
      const tagPtr = freshTemp();
      fnLines.push(
        `  ${tagPtr} = getelementptr inbounds ${enumLlvm}, ptr ${slot}, i32 0, i32 0`,
      );
      fnLines.push(`  store i32 ${cancelledVariant.ordinal}, ptr ${tagPtr}`);
      fnLines.push(`  br label %${joinLabel}`);
    }

    fnLines.push(`${joinLabel}:`);
    const loadTmp = freshTemp();
    fnLines.push(`  ${loadTmp} = load ${enumLlvm}, ptr ${slot}`);
    return { val: loadTmp, yoopType: waitResultType };
  }

  // Phase 10.F.2: `cancel(h): void` - thin wrapper over @yoop_task_cancel.
  // Stamped by the typechecker's resolveCancelCall; the arg is a Task<T>
  // value which lowers to the handle ptr directly.
  function emitCancelCall(node, fnLines) {
    const handleVal = emitExpr(node.args[0], fnLines);
    fnLines.push(`  call void @yoop_task_cancel(ptr ${handleVal.val})`);
    return { val: "void", yoopType: VoidType() };
  }

  // Inline emission for builtin generic functions: heap_alloc / heap_free
  // (Phase 7+) and array_slice (Phase 8.H). These have `declId` starting with
  // `$builtin` and no AST body; codegen lowers each call directly.
  function emitBuiltinGenericCall(node, fnLines) {
    const inst = node.genericInstantiation;
    if (inst.declId === "$builtin__heap_alloc") {
      const elemType = inst.argTypes[0];
      const arrayType = ArrayType(elemType);
      ensureArrayTypeDef(elemType);
      // Element size in bytes.
      const elemSize = sizeOfType(elemType);
      // Emit the count argument.
      const nArg = emitExpr(node.args[0], fnLines);
      // Multiply count by element size to get byte size.
      const byteSize = freshTemp();
      fnLines.push(`  ${byteSize} = mul i64 ${nArg.val}, ${elemSize}`);
      // --track-heap: record the alloc before malloc so the counter
      // reflects intent even if malloc returns null.
      if (programState?.trackHeap) {
        fnLines.push(`  call void @yoop_diag_record_alloc(i64 ${byteSize})`);
      }
      // Allocate on the heap.
      const raw = freshTemp();
      fnLines.push(`  ${raw} = call ptr @malloc(i64 ${byteSize})`);
      // Build fat pointer.
      const arrayLlvmTy = llvmType(arrayType);
      const fatSlot = freshTemp();
      fnLines.push(`  ${fatSlot} = alloca ${arrayLlvmTy}, align 8`);
      const dataField = freshTemp();
      fnLines.push(`  ${dataField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 0`);
      fnLines.push(`  store ptr ${raw}, ptr ${dataField}`);
      const lenField = freshTemp();
      fnLines.push(`  ${lenField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 1`);
      fnLines.push(`  store i64 ${nArg.val}, ptr ${lenField}`);
      const fatVal = freshTemp();
      fnLines.push(`  ${fatVal} = load ${arrayLlvmTy}, ptr ${fatSlot}`);
      return { val: fatVal, yoopType: arrayType };
    }
    if (inst.declId === "$builtin__ctx_alloc") {
      // Same as heap_alloc, but the byte allocation routes through the current
      // allocator (yoop_ctx_alloc) instead of malloc. Alignment is 8, which
      // satisfies every current Yoop scalar/struct type.
      const elemType = inst.argTypes[0];
      const arrayType = ArrayType(elemType);
      ensureArrayTypeDef(elemType);
      const elemSize = sizeOfType(elemType);
      const nArg = emitExpr(node.args[0], fnLines);
      const byteSize = freshTemp();
      fnLines.push(`  ${byteSize} = mul i64 ${nArg.val}, ${elemSize}`);
      if (programState?.trackHeap) {
        fnLines.push(`  call void @yoop_diag_record_alloc(i64 ${byteSize})`);
      }
      const raw = freshTemp();
      fnLines.push(`  ${raw} = call ptr @yoop_ctx_alloc(i64 ${byteSize}, i64 8)`);
      const arrayLlvmTy = llvmType(arrayType);
      const fatSlot = freshTemp();
      fnLines.push(`  ${fatSlot} = alloca ${arrayLlvmTy}, align 8`);
      const dataField = freshTemp();
      fnLines.push(`  ${dataField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 0`);
      fnLines.push(`  store ptr ${raw}, ptr ${dataField}`);
      const lenField = freshTemp();
      fnLines.push(`  ${lenField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 1`);
      fnLines.push(`  store i64 ${nArg.val}, ptr ${lenField}`);
      const fatVal = freshTemp();
      fnLines.push(`  ${fatVal} = load ${arrayLlvmTy}, ptr ${fatSlot}`);
      return { val: fatVal, yoopType: arrayType };
    }
    if (inst.declId === "$builtin__ctx_free") {
      // Same as heap_free, but frees through the current allocator.
      const elemType = inst.argTypes[0];
      const arrayType = ArrayType(elemType);
      ensureArrayTypeDef(elemType);
      const fatArg = emitExpr(node.args[0], fnLines);
      const arrayLlvmTy = llvmType(arrayType);
      const fatSlot = freshTemp();
      fnLines.push(`  ${fatSlot} = alloca ${arrayLlvmTy}, align 8`);
      fnLines.push(`  store ${arrayLlvmTy} ${fatArg.val}, ptr ${fatSlot}`);
      const dataField = freshTemp();
      fnLines.push(`  ${dataField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 0`);
      const dataPtr = freshTemp();
      fnLines.push(`  ${dataPtr} = load ptr, ptr ${dataField}`);
      if (programState?.trackHeap) {
        const elemSize = sizeOfType(elemType);
        const lenField = freshTemp();
        fnLines.push(`  ${lenField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 1`);
        const lenVal = freshTemp();
        fnLines.push(`  ${lenVal} = load i64, ptr ${lenField}`);
        const byteSize = freshTemp();
        fnLines.push(`  ${byteSize} = mul i64 ${lenVal}, ${elemSize}`);
        fnLines.push(`  call void @yoop_diag_record_free(i64 ${byteSize})`);
      }
      fnLines.push(`  call void @yoop_ctx_free(ptr ${dataPtr})`);
      return { val: "void", yoopType: VoidType() };
    }
    if (inst.declId === "$builtin__heap_free") {
      const elemType = inst.argTypes[0];
      const arrayType = ArrayType(elemType);
      ensureArrayTypeDef(elemType);
      const fatArg = emitExpr(node.args[0], fnLines);
      // Extract field 0 (data pointer) from the fat pointer.
      const arrayLlvmTy = llvmType(arrayType);
      const fatSlot = freshTemp();
      fnLines.push(`  ${fatSlot} = alloca ${arrayLlvmTy}, align 8`);
      fnLines.push(`  store ${arrayLlvmTy} ${fatArg.val}, ptr ${fatSlot}`);
      const dataField = freshTemp();
      fnLines.push(`  ${dataField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 0`);
      const dataPtr = freshTemp();
      fnLines.push(`  ${dataPtr} = load ptr, ptr ${dataField}`);
      // --track-heap: load len and record `len * elemSize` bytes freed
      // before the call to @free so the counters stay paired with the
      // matching alloc record.
      if (programState?.trackHeap) {
        const elemSize = sizeOfType(elemType);
        const lenField = freshTemp();
        fnLines.push(`  ${lenField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 1`);
        const lenVal = freshTemp();
        fnLines.push(`  ${lenVal} = load i64, ptr ${lenField}`);
        const byteSize = freshTemp();
        fnLines.push(`  ${byteSize} = mul i64 ${lenVal}, ${elemSize}`);
        fnLines.push(`  call void @yoop_diag_record_free(i64 ${byteSize})`);
      }
      fnLines.push(`  call void @free(ptr ${dataPtr})`);
      return { val: "void", yoopType: VoidType() };
    }
    if (inst.declId === "$builtin__string_as_bytes") {
      // Phase 8.H: zero-copy view {s, strlen(s)} as uint8[].
      const arrayType = ArrayType(PrimType("uint8"));
      ensureArrayTypeDef(PrimType("uint8"));
      const arrayLlvmTy = llvmType(arrayType);
      const sArg = emitExpr(node.args[0], fnLines);
      const lenTmp = freshTemp();
      fnLines.push(`  ${lenTmp} = call i64 @strlen(ptr ${sArg.val})`);
      const fatSlot = freshTemp();
      fnLines.push(`  ${fatSlot} = alloca ${arrayLlvmTy}, align 8`);
      const dataField = freshTemp();
      fnLines.push(`  ${dataField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 0`);
      fnLines.push(`  store ptr ${sArg.val}, ptr ${dataField}`);
      const lenField = freshTemp();
      fnLines.push(`  ${lenField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${fatSlot}, i32 0, i32 1`);
      fnLines.push(`  store i64 ${lenTmp}, ptr ${lenField}`);
      const fatVal = freshTemp();
      fnLines.push(`  ${fatVal} = load ${arrayLlvmTy}, ptr ${fatSlot}`);
      return { val: fatVal, yoopType: arrayType };
    }
    if (inst.declId === "$builtin__string_from_bytes_unchecked") {
      // Phase 8.H: malloc(buf.len + 1), memcpy from buf.ptr, write nul.
      // Returns the malloc'd ptr as a string (zero-terminated UTF-8 by
      // contract - caller asserts UTF-8 validity).
      const arrayType = ArrayType(PrimType("uint8"));
      ensureArrayTypeDef(PrimType("uint8"));
      const arrayLlvmTy = llvmType(arrayType);
      const bufArg = emitExpr(node.args[0], fnLines);
      // Extract buf.ptr and buf.len from the fat pointer.
      const bufSlot = freshTemp();
      fnLines.push(`  ${bufSlot} = alloca ${arrayLlvmTy}, align 8`);
      fnLines.push(`  store ${arrayLlvmTy} ${bufArg.val}, ptr ${bufSlot}`);
      const bufDataField = freshTemp();
      fnLines.push(`  ${bufDataField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${bufSlot}, i32 0, i32 0`);
      const bufDataPtr = freshTemp();
      fnLines.push(`  ${bufDataPtr} = load ptr, ptr ${bufDataField}`);
      const bufLenField = freshTemp();
      fnLines.push(`  ${bufLenField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${bufSlot}, i32 0, i32 1`);
      const bufLenVal = freshTemp();
      fnLines.push(`  ${bufLenVal} = load i64, ptr ${bufLenField}`);
      // alloc len + 1 bytes for the nul terminator.
      const allocSize = freshTemp();
      fnLines.push(`  ${allocSize} = add i64 ${bufLenVal}, 1`);
      const raw = freshTemp();
      fnLines.push(`  ${raw} = call ptr @malloc(i64 ${allocSize})`);
      // Copy the bytes in.
      fnLines.push(`  call ptr @memcpy(ptr ${raw}, ptr ${bufDataPtr}, i64 ${bufLenVal})`);
      // Write the nul terminator at p[len].
      const nulPtr = freshTemp();
      fnLines.push(`  ${nulPtr} = getelementptr inbounds i8, ptr ${raw}, i64 ${bufLenVal}`);
      fnLines.push(`  store i8 0, ptr ${nulPtr}`);
      return { val: raw, yoopType: PrimType("string") };
    }
    if (inst.declId === "$builtin__array_slice") {
      // Phase 8.H: array_slice<T>(xs, start, end) - borrowing view, no copy.
      // Build {xs.ptr + start * sizeof(T), end - start} as a fresh fat pointer.
      const elemType = inst.argTypes[0];
      const arrayType = ArrayType(elemType);
      ensureArrayTypeDef(elemType);
      const arrayLlvmTy = llvmType(arrayType);
      const elemLlvmTy = llvmType(elemType);
      // Emit args.
      const fatArg = emitExpr(node.args[0], fnLines);
      const startArg = emitExpr(node.args[1], fnLines);
      const endArg = emitExpr(node.args[2], fnLines);
      // Extract source data pointer.
      const srcSlot = freshTemp();
      fnLines.push(`  ${srcSlot} = alloca ${arrayLlvmTy}, align 8`);
      fnLines.push(`  store ${arrayLlvmTy} ${fatArg.val}, ptr ${srcSlot}`);
      const srcDataField = freshTemp();
      fnLines.push(`  ${srcDataField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${srcSlot}, i32 0, i32 0`);
      const srcDataPtr = freshTemp();
      fnLines.push(`  ${srcDataPtr} = load ptr, ptr ${srcDataField}`);
      // Compute element-typed offset: srcDataPtr + start (in element units).
      const newDataPtr = freshTemp();
      fnLines.push(`  ${newDataPtr} = getelementptr inbounds ${elemLlvmTy}, ptr ${srcDataPtr}, i64 ${startArg.val}`);
      // Compute new length = end - start.
      const newLen = freshTemp();
      fnLines.push(`  ${newLen} = sub i64 ${endArg.val}, ${startArg.val}`);
      // Build result fat pointer.
      const resSlot = freshTemp();
      fnLines.push(`  ${resSlot} = alloca ${arrayLlvmTy}, align 8`);
      const resDataField = freshTemp();
      fnLines.push(`  ${resDataField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${resSlot}, i32 0, i32 0`);
      fnLines.push(`  store ptr ${newDataPtr}, ptr ${resDataField}`);
      const resLenField = freshTemp();
      fnLines.push(`  ${resLenField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${resSlot}, i32 0, i32 1`);
      fnLines.push(`  store i64 ${newLen}, ptr ${resLenField}`);
      const resVal = freshTemp();
      fnLines.push(`  ${resVal} = load ${arrayLlvmTy}, ptr ${resSlot}`);
      return { val: resVal, yoopType: arrayType };
    }
    throw new Error(`codegen: unknown builtin generic declId "${inst.declId}"`);
  }

  // Lower an interpolated template literal to a string by routing each
  // `${expr}` through the matching `<prim>_to_string` shim (or the
  // Display.to_string call the typechecker pre-synthesized for struct
  // operands), collecting the parts into a `string[]` fat pointer, and
  // feeding that to `string_concat_all`. Requires the driver to have
  // autoloaded std/core/format.yoop + std/core/strings.yoop.
  function emitInterpolatedTemplateLiteral(node, fnLines) {
    const std = programState?.autoloadedStdModuleIds;
    if (!std || !std.format || !std.strings) {
      throw new Error(
        "codegen: template literals with ${...} interpolation require the multi-module driver (autoloaded std/core/format.yoop + strings.yoop missing)",
      );
    }
    const fmtMod = std.format;
    const strMod = std.strings;
    const stringTy = PrimType("string");
    const arrType = { kind: typeKinds.array, elem: stringTy };
    ensureArrayTypeDef(stringTy);

    const partVals = [];
    for (const part of node.parts) {
      if (part.kind === ASTNodeKind.STRING_PART) {
        const { name, byteLen } = emitRawStringGlobal(part.value);
        const tmp = freshTemp();
        fnLines.push(
          `  ${tmp} = getelementptr inbounds [${byteLen} x i8], ptr ${name}, i32 0, i32 0`,
        );
        partVals.push(tmp);
        continue;
      }
      const r = emitExpr(part.expr, fnLines);
      // Phase 12: a value enum shares its underlying primitive's LLVM repr,
      // so route it through the same per-prim to_string shim (string passes
      // through, ints go to int_to_string, etc).
      const t = valueEnumUnderlying(r.yoopType);
      if (t.kind === typeKinds.prim && t.name === "string") {
        partVals.push(r.val);
        continue;
      }
      if (t.kind === typeKinds.prim && t.name === "bool") {
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = call ptr @${fmtMod}__bool_to_string(i1 ${r.val})`);
        partVals.push(tmp);
        continue;
      }
      if (isIntType(t)) {
        const unsigned = isUnsignedIntPrim(t.name);
        const llvm = llvmType(t);
        let widened = r.val;
        if (llvm !== "i64") {
          const w = freshTemp();
          fnLines.push(`  ${w} = ${unsigned ? "zext" : "sext"} ${llvm} ${r.val} to i64`);
          widened = w;
        }
        const fn = unsigned ? "uint_to_string" : "int_to_string";
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = call ptr @${fmtMod}__${fn}(i64 ${widened})`);
        partVals.push(tmp);
        continue;
      }
      if (isFloatType(t)) {
        const llvm = llvmType(t);
        let widened = r.val;
        if (llvm !== "double") {
          const w = freshTemp();
          fnLines.push(`  ${w} = fpext ${llvm} ${r.val} to double`);
          widened = w;
        }
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = call ptr @${fmtMod}__float_to_string(double ${widened})`);
        partVals.push(tmp);
        continue;
      }
      throw new Error(
        `codegen: template literal interpolation produced unexpected type "${t.kind}/${t.name ?? ""}"`,
      );
    }

    const n = partVals.length;
    const storage = freshTemp();
    fnLines.push(`  ${storage} = alloca [${n} x ptr], align 8`);
    for (let i = 0; i < n; i++) {
      const slot = freshTemp();
      fnLines.push(`  ${slot} = getelementptr [${n} x ptr], ptr ${storage}, i32 0, i32 ${i}`);
      fnLines.push(`  store ptr ${partVals[i]}, ptr ${slot}`);
    }
    const dataPtr = freshTemp();
    fnLines.push(`  ${dataPtr} = getelementptr [${n} x ptr], ptr ${storage}, i32 0, i32 0`);

    const arrLlvm = llvmType(arrType);
    const fatSlot = freshTemp();
    fnLines.push(`  ${fatSlot} = alloca ${arrLlvm}, align 8`);
    const dataField = freshTemp();
    fnLines.push(`  ${dataField} = getelementptr inbounds ${arrLlvm}, ptr ${fatSlot}, i32 0, i32 0`);
    fnLines.push(`  store ptr ${dataPtr}, ptr ${dataField}`);
    const lenField = freshTemp();
    fnLines.push(`  ${lenField} = getelementptr inbounds ${arrLlvm}, ptr ${fatSlot}, i32 0, i32 1`);
    fnLines.push(`  store i64 ${n}, ptr ${lenField}`);
    const fatVal = freshTemp();
    fnLines.push(`  ${fatVal} = load ${arrLlvm}, ptr ${fatSlot}`);

    const result = freshTemp();
    fnLines.push(`  ${result} = call ptr @${strMod}__string_concat_all(${arrLlvm} ${fatVal})`);
    return { val: result, yoopType: stringTy };
  }

  function emitCallExpr(node, fnLines) {
    // Phase 10.F: builtin wait_until lowering (multi-module path).
    if (node.builtinWaitUntil) {
      return emitWaitUntilCall(node, fnLines);
    }
    // Phase 10.F.2: builtin cancel lowering.
    if (node.builtinCancel) {
      return emitCancelCall(node, fnLines);
    }
    if (node.genericInstantiation?.declId?.startsWith("$builtin")) {
      return emitBuiltinGenericCall(node, fnLines);
    }
    if (node.isCast) {
      const src = emitExpr(node.args[0], fnLines);
      const dstType = node.castTargetType;
      // Phase 12: value enums collapse to their underlying primitive for
      // cast purposes. The LLVM-level type and SSA value are already the
      // underlying width; just unwrap so castInstruction can read .name.
      const unwrap = (t) =>
        t && t.kind === typeKinds.valueEnum ? t.underlying : t;
      const srcEff = unwrap(src.yoopType);
      const dstEff = unwrap(dstType);
      const opcode = castInstruction(srcEff, dstEff);
      if (!opcode) return { val: src.val, yoopType: dstType };
      const tmp = freshTemp();
      fnLines.push(`  ${tmp} = ${opcode} ${llvmType(srcEff)} ${src.val} to ${llvmType(dstEff)}`);
      return { val: tmp, yoopType: dstType };
    }
    if (node.callee && typeof node.callee === "object" && node.callee.namespaceLookup) {
      // Generic-namespace calls (`vec.vec_new(...)`) carry a
      // `genericInstantiation` from the typechecker - its mangled name
      // includes the type-arg suffix so we land on the concrete monomorphic
      // function rather than the (non-existent) base symbol.
      const mangledName = node.genericInstantiation
        ? mangle(node.genericInstantiation.moduleId, node.genericInstantiation.mangledName)
        : mangle(node.callee.namespaceLookup.moduleId, node.callee.namespaceLookup.exportName);
      const argResults = node.args.map((a) => emitExpr(a, fnLines));
      const argList = argResults.map((r) => `${llvmType(r.yoopType)} ${r.val}`).join(", ");
      const retType = node.resolvedType;
      const llvmRet = llvmType(retType);
      if (llvmRet === "void") { fnLines.push(`  call void @${mangledName}(${argList})`); return { val: "void", yoopType: VoidType() }; }
      const tmp = freshTemp();
      fnLines.push(`  ${tmp} = call ${llvmRet} @${mangledName}(${argList})`);
      return { val: tmp, yoopType: retType };
    }
    if (node.callee === "printf") {
      return emitPrintfCallInner(node, fnLines);
    }

    // Phase 10.X.2: indirect call through a fn-ptr struct field. The
    // typechecker tagged the CALL_EXPRESSION with `fnPointerCall`; the
    // callee is a FIELD_ACCESS whose rvalue evaluation loads the slot.
    // Phase 10.K: the callee may instead be a bare identifier naming a
    // function-pointer parameter or local - then it's a string, so load the
    // pointer from its slot rather than emitExpr'ing a node.
    if (node.fnPointerCall) {
      const fptType = node.fnPointerType ?? node.callee.resolvedType;
      let fnPtr;
      if (typeof node.callee === "string") {
        const slot = symbols.slotFor(node.callee);
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = load ptr, ptr ${slot}`);
        fnPtr = { val: tmp };
      } else {
        fnPtr = emitExpr(node.callee, fnLines);
      }
      const argResults = node.args.map((a) => emitExpr(a, fnLines));
      const argList = argResults.map((r, i) =>
        `${llvmType(fptType.params[i])} ${r.val}`,
      ).join(", ");
      const llvmRet = llvmType(fptType.returnType);
      if (isVoidReturn(fptType.returnType)) {
        fnLines.push(`  call void ${fnPtr.val}(${argList})`);
        return { val: "void", yoopType: VoidType() };
      }
      const tmp = freshTemp();
      fnLines.push(`  ${tmp} = call ${llvmRet} ${fnPtr.val}(${argList})`);
      return { val: tmp, yoopType: fptType.returnType };
    }

    // Trait method call: typechecker stamped the mangled symbol.
    if (node.calleeMethodOf) {
      const argResults = node.args.map((a) => emitExpr(a, fnLines));
      const methodSig = node.calleeMethodOf.methods.get(node.calleeMethodName);
      const argList = methodSig.params.map((p, i) => {
        const llvmTy = p.isRef ? "ptr" : llvmType(p.type);
        return `${llvmTy} ${argResults[i].val}`;
      }).join(", ");
      const llvmRet = llvmType(methodSig.returnType);
      if (isVoidReturn(methodSig.returnType)) {
        fnLines.push(`  call void @${node.calleeMangledName}(${argList})`);
        return { val: "void", yoopType: VoidType() };
      }
      const tmp = freshTemp();
      fnLines.push(`  ${tmp} = call ${llvmRet} @${node.calleeMangledName}(${argList})`);
      return { val: tmp, yoopType: methodSig.returnType };
    }

    // Phase 9.G: `VTableName.from(ref x)` - synthesize the vtable struct.
    if (node.vtableBuilder) {
      return emitVTableFromBuilder(node, fnLines);
    }
    // Phase 10.K: `VTableName.fromFn(f1, ...)` - vtable from named functions.
    if (node.vtableFromFnBuilder) {
      return emitVTableFromFnBuilder(node, fnLines);
    }
    // Phase 9.G: `Trait.method(ref vt, args)` where vt is a vtable value -
    // lower to an indirect call through the slot, threading ctx as the
    // first argument.
    if (node.vtableCall) {
      return emitVTableMethodCall(node, fnLines);
    }

    const sym = calleeSymbol(node);
    const argResults = node.args.map((a) => emitExpr(a, fnLines));
    // Phase 6.4: for each arg flagged by kindCheck as a pooled-to-pooled
    // transfer, retain before passing so the callee's scope-exit release is
    // balanced.
    for (let i = 0; i < node.args.length; i++) {
      if (node.args[i].pooledArgRetain) {
        fnLines.push(`  call void @yoop_task_retain(ptr ${argResults[i].val})`);
      }
    }
    const sig = functionSigs.get(node.callee);
    let argList;
    if (sig?.variadic) {
      argList = argResults.map((r, i) => {
        const ty = i < (sig.params?.length ?? 0) ? llvmType(sig.params[i]) : llvmType(r.yoopType);
        return `${ty} ${r.val}`;
      }).join(", ");
    } else if (sig) {
      argList = sig.params.map((pt, i) => `${llvmType(pt)} ${argResults[i].val}`).join(", ");
    } else {
      argList = argResults.map((r) => `${llvmType(r.yoopType)} ${r.val}`).join(", ");
    }
    const retType = node.resolvedType;
    const llvmRet = llvmType(retType);
    const callInstr = sig?.variadic
      ? `call ${llvmRet} (${(sig.params ?? []).map(p => llvmType(p)).join(", ")}${sig.params?.length ? ", " : ""}...) @${sym}`
      : `call ${llvmRet} @${sym}`;
    if (llvmRet === "void") { fnLines.push(`  ${callInstr}(${argList})`); return { val: "void", yoopType: VoidType() }; }
    const tmp = freshTemp();
    fnLines.push(`  ${tmp} = ${callInstr}(${argList})`);
    return { val: tmp, yoopType: retType };
  }

  // Phase 9.G: lower `VTableName.from(ref x)` to a stack-allocated vtable
  // struct populated with:
  //   field 0 (ctx)   <- the receiver's address (`&x`, materialized via emitLval)
  //   field i+1       <- the address of the receiver type's trait-method impl
  //                      symbol, mangled per Phase 7.4 conventions.
  // Returns a loaded SSA value of vtable struct type.
  function emitVTableFromBuilder(node, fnLines) {
    const { vtableType, implType } = node.vtableBuilder;
    const vtLlvm = llvmType(vtableType);

    // Materialize the receiver's address. The arg is REF_EXPRESSION whose
    // operand is an IDENT or lvalue; emitLval gives us a stable pointer.
    const refArg = node.args[0];
    const lv = emitLval(refArg.operand, fnLines);
    const ctxPtr = lv.ptr;

    const slot = freshTemp();
    fnLines.push(`  ${slot} = alloca ${vtLlvm}, align 8`);

    // ctx at index 0
    const ctxGep = freshTemp();
    fnLines.push(`  ${ctxGep} = getelementptr inbounds ${vtLlvm}, ptr ${slot}, i32 0, i32 0`);
    fnLines.push(`  store ptr ${ctxPtr}, ptr ${ctxGep}`);

    // One method pointer per trait method, in trait declaration order.
    for (let i = 0; i < vtableType.methodOrder.length; i++) {
      const methodName = vtableType.methodOrder[i];
      const mangled = mangleTraitMethod(implType, vtableType.traitName, methodName);
      const slotGep = freshTemp();
      fnLines.push(`  ${slotGep} = getelementptr inbounds ${vtLlvm}, ptr ${slot}, i32 0, i32 ${i + 1}`);
      fnLines.push(`  store ptr @${mangled}, ptr ${slotGep}`);
    }

    const loaded = freshTemp();
    fnLines.push(`  ${loaded} = load ${vtLlvm}, ptr ${slot}`);
    return { val: loaded, yoopType: vtableType };
  }

  // Phase 10.K: emit (once per module + target symbol) a ctx-dropping shim so
  // a plain named function can fill a vtable method slot. Vtable dispatch
  // always passes the ctx pointer as the first call argument; a stateless
  // function has no ctx/self param, so the shim takes a leading `ptr` it
  // ignores and forwards the remaining args. `fpt` is the slot's
  // FunctionPointerType (trait method signature minus `ref self`). Pushed
  // directly into `lines` (top-level defines), which is safe because emitFn
  // only flushes its in-progress fnLines into `lines` at the very end.
  function registerFromFnShim(targetSym, fpt) {
    const shimSym = `yoop_fromfn_shim__${moduleId}__${targetSym}`;
    if (emittedFromFnShims.has(shimSym)) return shimSym;
    emittedFromFnShims.add(shimSym);
    const llvmRet = llvmType(fpt.returnType);
    const paramSig = ["ptr %ctx", ...fpt.params.map((p, i) => `${llvmType(p)} %a${i}`)].join(", ");
    const callArgs = fpt.params.map((p, i) => `${llvmType(p)} %a${i}`).join(", ");
    const def = [`define ${llvmRet} @${shimSym}(${paramSig}) {`, "entry:"];
    if (llvmRet === "void") {
      def.push(`  call void @${targetSym}(${callArgs})`);
      def.push("  ret void");
    } else {
      def.push(`  %r = call ${llvmRet} @${targetSym}(${callArgs})`);
      def.push(`  ret ${llvmRet} %r`);
    }
    def.push("}");
    lines.push(...def);
    return shimSym;
  }

  // Phase 10.K: lower `VTableName.fromFn(f1, f2, ...)` to a stack-allocated
  // vtable whose ctx is null and whose method slots hold ctx-dropping shims
  // (see registerFromFnShim) wrapping the named functions, in trait method
  // declaration order. Each arg IDENT lowers to its `@symbol` address via the
  // Phase 10.X.2 function-reference materialization.
  function emitVTableFromFnBuilder(node, fnLines) {
    const { vtableType } = node.vtableFromFnBuilder;
    const vtLlvm = llvmType(vtableType);

    const slot = freshTemp();
    fnLines.push(`  ${slot} = alloca ${vtLlvm}, align 8`);

    // ctx = null (the functions are stateless).
    const ctxGep = freshTemp();
    fnLines.push(`  ${ctxGep} = getelementptr inbounds ${vtLlvm}, ptr ${slot}, i32 0, i32 0`);
    fnLines.push(`  store ptr null, ptr ${ctxGep}`);

    for (let i = 0; i < vtableType.methodOrder.length; i++) {
      const fpt = vtableType.fields[i].type; // FunctionPointerType
      const argRes = emitExpr(node.args[i], fnLines); // -> { val: "@sym" }
      const targetSym = argRes.val.startsWith("@") ? argRes.val.slice(1) : argRes.val;
      const shimSym = registerFromFnShim(targetSym, fpt);
      const slotGep = freshTemp();
      fnLines.push(`  ${slotGep} = getelementptr inbounds ${vtLlvm}, ptr ${slot}, i32 0, i32 ${i + 1}`);
      fnLines.push(`  store ptr @${shimSym}, ptr ${slotGep}`);
    }

    const loaded = freshTemp();
    fnLines.push(`  ${loaded} = load ${vtLlvm}, ptr ${slot}`);
    return { val: loaded, yoopType: vtableType };
  }

  // Phase 9.G: lower `Trait.method(ref vt, args...)` where vt is typed as a
  // vtable. The first arg is the vtable itself (its address via the REF_EXPR);
  // the rest are the user's args. Load the function pointer from the vtable's
  // method slot, load ctx from slot 0, indirect-call passing ctx + args.
  function emitVTableMethodCall(node, fnLines) {
    const { vtableType, fieldIndex } = node.vtableCall;
    const vtLlvm = llvmType(vtableType);

    // The first arg is `ref vt`. Get the address of vt.
    const refArg = node.args[0];
    const vtPtr = emitLval(refArg.operand, fnLines).ptr;

    const ctxGep = freshTemp();
    fnLines.push(`  ${ctxGep} = getelementptr inbounds ${vtLlvm}, ptr ${vtPtr}, i32 0, i32 0`);
    const ctxVal = freshTemp();
    fnLines.push(`  ${ctxVal} = load ptr, ptr ${ctxGep}`);

    const fnSlot = freshTemp();
    fnLines.push(`  ${fnSlot} = getelementptr inbounds ${vtLlvm}, ptr ${vtPtr}, i32 0, i32 ${fieldIndex + 1}`);
    const fnPtr = freshTemp();
    fnLines.push(`  ${fnPtr} = load ptr, ptr ${fnSlot}`);

    // Evaluate user args (everything after the vtable receiver).
    const userArgResults = node.args.slice(1).map((a) => emitExpr(a, fnLines));
    const fpt = vtableType.fields[fieldIndex].type; // FunctionPointerType
    const userParamTypes = fpt.params;

    // Build call signature. The stored function pointer's first arg is `ptr`
    // (the ctx), followed by the FPT's declared params (which are exactly the
    // trait method's params minus `ref self`).
    const userArgList = userParamTypes.map((pt, i) => {
      return `${llvmType(pt)} ${userArgResults[i].val}`;
    }).join(", ");
    const fullArgList = `ptr ${ctxVal}${userArgList ? ", " + userArgList : ""}`;
    const llvmRet = llvmType(fpt.returnType);
    const sigParamList = ["ptr", ...userParamTypes.map((p) => llvmType(p))].join(", ");

    if (llvmRet === "void") {
      fnLines.push(`  call void (${sigParamList}) ${fnPtr}(${fullArgList})`);
      return { val: "void", yoopType: VoidType() };
    }
    const tmp = freshTemp();
    fnLines.push(`  ${tmp} = call ${llvmRet} (${sigParamList}) ${fnPtr}(${fullArgList})`);
    return { val: tmp, yoopType: fpt.returnType };
  }

  function emitPrintfCallInner(node, fnLines) {
    if (node.args.length === 0) throw new Error("codegen: printf called with no arguments");
    let fmtSpec = "";
    const valueArgs = [];
    // See emitPrintfCall: an explicit format-string literal is C printf, so a
    // bare value arg fills a `%` directive already in the string and must not
    // get an auto-appended specifier. Only auto-append with no format literal
    // (`printf(someString)`) or for template-literal interpolations.
    const hasFormatLiteral = node.args.some(
      (a) => a.kind === ASTNodeKind.STRING_LITERAL,
    );
    for (const argNode of node.args) {
      if (argNode.kind === ASTNodeKind.STRING_LITERAL) {
        fmtSpec += argNode.value.slice(1, -1);
      } else if (
        argNode.kind === ASTNodeKind.TEMPLATE_LITERAL &&
        !hasFormatLiteral
      ) {
        // Template-as-format-string. With an explicit format literal present
        // the template instead falls through as a plain VALUE arg (else
        // branch) filling a %s - contributing its parts here would
        // reintroduce the doubled-directive bug (see emitPrintfCall).
        for (const part of argNode.parts) {
          if (part.kind === ASTNodeKind.STRING_PART) { fmtSpec += part.value.replace(/%/g, "%%"); }
          else { const r = emitExpr(part.expr, fnLines); fmtSpec += printfSpec(r.yoopType); valueArgs.push(r); }
        }
      } else {
        const r = emitExpr(argNode, fnLines);
        if (!hasFormatLiteral) fmtSpec += printfSpec(r.yoopType);
        valueArgs.push(r);
      }
    }
    const { name, byteLen } = emitRawStringGlobal(fmtSpec);
    const fmtTmp = freshTemp();
    fnLines.push(`  ${fmtTmp} = getelementptr inbounds [${byteLen} x i8], ptr ${name}, i32 0, i32 0`);
    const argList = ["ptr " + fmtTmp].concat(valueArgs.map((r) => {
      // value enums share their underlying primitive's LLVM repr and
      // promotion rules (see valueEnumUnderlying).
      const vt = valueEnumUnderlying(r.yoopType);
      const promoted = promotedLlvmType(vt);
      const actual = llvmType(vt);
      if (promoted !== actual) {
        const tmp = freshTemp();
        if (isIntType(vt)) {
          const op = isUnsignedIntPrim(vt.name) ? "zext" : "sext";
          fnLines.push(`  ${tmp} = ${op} ${actual} ${r.val} to ${promoted}`);
        } else if (vt.kind === typeKinds.prim && vt.name === "bool") {
          fnLines.push(`  ${tmp} = zext ${actual} ${r.val} to ${promoted}`);
        } else if (isFloatType(vt)) {
          fnLines.push(`  ${tmp} = fpext ${actual} ${r.val} to ${promoted}`);
        } else {
          throw new Error(`codegen: don't know how to promote ${vt.kind}/${vt.name ?? ""} for varargs`);
        }
        return `${promoted} ${tmp}`;
      }
      return `${promoted} ${r.val}`;
    })).join(", ");
    const tmp = freshTemp();
    fnLines.push(`  ${tmp} = call i32 (ptr, ...) @printf(${argList})`);
    return { val: tmp, yoopType: PrimType("int32") };
  }

  function emitLval(node, fnLines) {
    switch (node.kind) {
      case ASTNodeKind.IDENT: {
        // Phase 8.E: a module-level global used as an lvalue (indexing,
        // field access, address-of) lives in its owning module's @global
        // table, not this function's local `symbols`. Resolve straight to
        // @<modid>__<name>, mirroring the emitExpr IDENT path.
        if (node.isModuleGlobal) {
          return { ptr: `@${node.moduleGlobalSym}`, type: node.resolvedType };
        }
        const t = symbols.get(node.name);
        if (!t) throw new Error(`codegen: unknown identifier "${node.name}"`);
        if (t.kind === typeKinds.ref) {
          // ref binding (e.g. self): load the actual pointer from its alloca slot
          const ptrTmp = freshTemp();
          fnLines.push(`  ${ptrTmp} = load ptr, ptr ${symbols.slotFor(node.name)}`);
          return { ptr: ptrTmp, type: t.inner };
        }
        return { ptr: `${symbols.slotFor(node.name)}`, type: t };
      }
      case ASTNodeKind.FIELD_ACCESS: {
        // Phase 12: `ns.name` lvalue - the global itself is the slot. Used
        // when an enclosing assignment / `&` / indexing wants the address
        // of a module-level binding accessed through a namespace.
        if (node.namespaceLookup) {
          const sym = mangle(node.namespaceLookup.moduleId, node.namespaceLookup.exportName);
          return { ptr: `@${sym}`, type: node.resolvedType };
        }
        const base = emitLval(node.object, fnLines);
        // Phase 7.5: union field access - every field overlaps at offset 0;
        // the union's pointer is already the field's pointer (just retyped).
        if (base.type.kind === typeKinds.union) {
          const uf = base.type.fields.find((f) => f.name === node.field);
          if (!uf) throw new Error(`codegen: union has no field ${node.field}`);
          return { ptr: base.ptr, type: uf.type };
        }
        const idx = base.type.fields.findIndex((f) => f.name === node.field);
        const fieldType = base.type.fields[idx].type;
        const gepTmp = freshTemp();
        fnLines.push(`  ${gepTmp} = getelementptr inbounds ${llvmType(base.type)}, ptr ${base.ptr}, i32 0, i32 ${idx}`);
        return { ptr: gepTmp, type: fieldType };
      }
      case ASTNodeKind.INDEX_EXPRESSION: {
        const base = emitLval(node.object, fnLines);
        const arrayLlvmTy = llvmType(base.type);
        const dataPtrField = freshTemp();
        fnLines.push(`  ${dataPtrField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${base.ptr}, i32 0, i32 0`);
        const dataPtr = freshTemp();
        fnLines.push(`  ${dataPtr} = load ptr, ptr ${dataPtrField}`);
        const idx = emitExpr(node.index, fnLines);
        const elemLlvmTy = llvmType(base.type.elem);
        const elemPtr = freshTemp();
        fnLines.push(`  ${elemPtr} = getelementptr inbounds ${elemLlvmTy}, ptr ${dataPtr}, ${llvmType(idx.yoopType)} ${idx.val}`);
        return { ptr: elemPtr, type: base.type.elem };
      }
      default: {
        const r = emitExpr(node, fnLines);
        const t = r.yoopType;
        const llvmTy = llvmType(t);
        const slot = freshTemp();
        const al = t.kind === typeKinds.struct ? alignOfStruct(t) : alignOf(llvmTy);
        fnLines.push(`  ${slot} = alloca ${llvmTy}, align ${al}`);
        fnLines.push(`  store ${llvmTy} ${r.val}, ptr ${slot}`);
        return { ptr: slot, type: t };
      }
    }
  }

  function emitStructLitInto(litNode, destPtr, structType, fnLines) {
    // Phase 7.5: union literal - exactly one field gets stored, and it lives
    // at byte offset 0 of the union (the field's LLVM type, treated as an
    // overlay onto the byte buffer). All fields share offset 0, so we can
    // ignore the lookup `idx` here.
    if (structType.kind === typeKinds.union) {
      for (const litField of litNode.fields) {
        const f = structType.fields.find((ff) => ff.name === litField.name);
        if (!f) continue;
        const rhs = emitExpr(litField.value, fnLines);
        // destPtr is a ptr to the union struct, which has shape [N x i8].
        // Storing the RHS as its own LLVM type at that pointer is a valid
        // type-pun (LLVM types are erased at the IR level).
        fnLines.push(`  store ${llvmType(f.type)} ${rhs.val}, ptr ${destPtr}`);
      }
      return;
    }
    for (const litField of litNode.fields) {
      const idx = structType.fields.findIndex((f) => f.name === litField.name);
      const fieldType = structType.fields[idx].type;
      const gepTmp = freshTemp();
      fnLines.push(`  ${gepTmp} = getelementptr inbounds ${llvmType(structType)}, ptr ${destPtr}, i32 0, i32 ${idx}`);
      if (litField.value.kind === ASTNodeKind.STRUCT_LITERAL && fieldType.kind === typeKinds.struct) {
        emitStructLitInto(litField.value, gepTmp, fieldType, fnLines);
      } else {
        const rhs = emitExpr(litField.value, fnLines);
        fnLines.push(`  store ${llvmType(fieldType)} ${rhs.val}, ptr ${gepTmp}`);
        // Phase 6.4: storing a Task<T> handle into a struct field transfers a
        // reference. Retain so the source binding's scope-exit release stays
        // balanced and the receiving struct owns its own count.
        if (fieldType.kind === typeKinds.task) {
          fnLines.push(`  call void @yoop_task_retain(ptr ${rhs.val})`);
        }
      }
    }
  }

  // Phase 9.H - enum-shaped `?` (multi-module path). Mirrors emitTryOpToSlot
  // in the single-module section.
  function emitTrySlot(node, fnLines) {
    const operandEnum = node.operand.resolvedType;
    const r = emitExpr(node.operand, fnLines);
    const enumLlvm = llvmType(operandEnum);
    const slot = freshTemp();
    fnLines.push(`  ${slot} = alloca ${enumLlvm}, align ${sizeOfAlign(operandEnum)}`);
    fnLines.push(`  store ${enumLlvm} ${r.val}, ptr ${slot}`);

    const tagPtr = freshTemp();
    fnLines.push(`  ${tagPtr} = getelementptr inbounds ${enumLlvm}, ptr ${slot}, i32 0, i32 0`);
    const tagVal = freshTemp();
    fnLines.push(`  ${tagVal} = load i32, ptr ${tagPtr}`);

    const errVariant = operandEnum.variants.get("Err");
    const failed = freshTemp();
    fnLines.push(`  ${failed} = icmp eq i32 ${tagVal}, ${errVariant.ordinal}`);

    const failLabel = freshLabel("try_fail");
    const okLabel = freshLabel("try_ok");
    fnLines.push(`  br i1 ${failed}, label %${failLabel}, label %${okLabel}`);

    fnLines.push(`${failLabel}:`);
    // Phase 6.1: fire any pending cleanups in the failure branch before the
    // early `ret` produced by emitFailEnumRet.
    emitPendingCleanups(node, fnLines);
    emitFailEnumRet(node, operandEnum, slot, currentReturnType, fnLines);

    fnLines.push(`${okLabel}:`);
    return { ptr: slot, type: operandEnum };
  }

  // Phase 9.H + 10.E - multi-module sibling of emitFailEnumReturn.
  function emitFailEnumRet(tryNode, operandEnum, operandEnumSlot, retEnumType, fnLines) {
    const retLlvm = llvmType(retEnumType);
    const retSlot = freshTemp();
    fnLines.push(`  ${retSlot} = alloca ${retLlvm}, align ${sizeOfAlign(retEnumType)}`);
    fnLines.push(`  store ${retLlvm} zeroinitializer, ptr ${retSlot}`);

    const retErr = retEnumType.variants.get("Err");
    const tagPtr = freshTemp();
    fnLines.push(`  ${tagPtr} = getelementptr inbounds ${retLlvm}, ptr ${retSlot}, i32 0, i32 0`);
    fnLines.push(`  store i32 ${retErr.ordinal}, ptr ${tagPtr}`);

    const operandErr = operandEnum.variants.get("Err");
    const hasPayload =
      operandErr.fields !== null && operandErr.fields.length > 0
      && retErr.fields !== null && retErr.fields.length > 0;
    if (hasPayload) {
      const operandEnumId = operandEnum.moduleId
        ? `${operandEnum.moduleId}__${operandEnum.name}`
        : operandEnum.name;
      const retEnumId = retEnumType.moduleId
        ? `${retEnumType.moduleId}__${retEnumType.name}`
        : retEnumType.name;
      const operandPayloadLlvm = `%variantc.${operandEnumId}__Err`;
      const retPayloadLlvm = `%variantc.${retEnumId}__Err`;
      const operandFieldType = operandErr.fields[0].type;
      const retFieldType = retErr.fields[0].type;

      const opPayloadPtr = freshTemp();
      fnLines.push(`  ${opPayloadPtr} = getelementptr inbounds ${llvmType(operandEnum)}, ptr ${operandEnumSlot}, i32 0, i32 1`);
      const opFieldPtr = freshTemp();
      fnLines.push(`  ${opFieldPtr} = getelementptr inbounds ${operandPayloadLlvm}, ptr ${opPayloadPtr}, i32 0, i32 0`);

      const retPayloadPtr = freshTemp();
      fnLines.push(`  ${retPayloadPtr} = getelementptr inbounds ${retLlvm}, ptr ${retSlot}, i32 0, i32 1`);
      const retFieldPtr = freshTemp();
      fnLines.push(`  ${retFieldPtr} = getelementptr inbounds ${retPayloadLlvm}, ptr ${retPayloadPtr}, i32 0, i32 0`);

      if (tryNode.tryConvert) {
        // Phase 10.E: cross-shape - call Into.into(ref operandErr) and
        // store the returned target value.
        const retFieldLlvm = llvmType(retFieldType);
        const converted = freshTemp();
        fnLines.push(`  ${converted} = call ${retFieldLlvm} @${tryNode.tryConvert.mangledName}(ptr ${opFieldPtr})`);
        fnLines.push(`  store ${retFieldLlvm} ${converted}, ptr ${retFieldPtr}`);
      } else {
        const fieldLlvm = llvmType(operandFieldType);
        const fieldVal = freshTemp();
        fnLines.push(`  ${fieldVal} = load ${fieldLlvm}, ptr ${opFieldPtr}`);
        fnLines.push(`  store ${fieldLlvm} ${fieldVal}, ptr ${retFieldPtr}`);
      }
    }

    const retVal = freshTemp();
    fnLines.push(`  ${retVal} = load ${retLlvm}, ptr ${retSlot}`);
    if (inMainFn) fnLines.push("  call void @yoop_runtime_shutdown()");
    fnLines.push(`  ret ${retLlvm} ${retVal}`);
  }

  // Phase 6.1: emit a single CLEANUP_CALL node. The binding's alloca slot is
  // `%<bindingName>` (kind-prefixed bindings always declare a struct value;
  // the trait method takes `ref self` so we pass the slot pointer directly).
  // Phase 6.3: also dispatches TASK_AUTO_WAIT / TASK_RELEASE / TASK_RETAIN.
  // Phase 6.4: when `node.fieldName` is set, GEP into the binding's struct
  // field (and for TASK_RELEASE additionally load the handle ptr) before
  // dispatching, so propagated obligations target `binding.field` instead of
  // the binding directly.
  function emitCleanupCall(node, fnLines) {
    if (node.kind === ASTNodeKind.TASK_AUTO_WAIT) {
      // joined binding: handle ptr is stored in %<name>'s ptr slot.
      const handlePtr = freshTemp();
      fnLines.push(`  ${handlePtr} = load ptr, ptr ${symbols.slotFor(node.bindingName)}`);
      fnLines.push(`  call void @yoop_task_wait(ptr ${handlePtr})`);
      fnLines.push(`  call void @yoop_task_free_sync_pair(ptr ${handlePtr})`);
      return;
    }
    if (node.kind === ASTNodeKind.TASK_RELEASE) {
      const handlePtr = freshTemp();
      if (node.fieldName) {
        // Propagated release: GEP into the field (Task<T> = ptr), then load.
        const fieldPtr = emitFieldGep(node, fnLines);
        fnLines.push(`  ${handlePtr} = load ptr, ptr ${fieldPtr}`);
      } else {
        fnLines.push(`  ${handlePtr} = load ptr, ptr ${symbols.slotFor(node.bindingName)}`);
      }
      fnLines.push(`  call void @yoop_task_release(ptr ${handlePtr})`);
      return;
    }
    if (node.kind === ASTNodeKind.TASK_RETAIN) {
      const handlePtr = freshTemp();
      fnLines.push(`  ${handlePtr} = load ptr, ptr ${symbols.slotFor(node.bindingName)}`);
      fnLines.push(`  call void @yoop_task_retain(ptr ${handlePtr})`);
      return;
    }
    // CLEANUP_CALL - mustCall dispatch.
    if (node.fieldName) {
      // Phase 6.4: propagated dispose. GEP into binding's struct field; the
      // trait method takes `ref self` so we pass the field pointer directly.
      // Phase 7.4: mangled with the supplying trait name.
      const fieldStruct = node.fieldStructType;
      const mangled = mangleTraitMethod(fieldStruct, node.traitName, node.methodName);
      const fieldPtr = emitFieldGep(node, fnLines);
      fnLines.push(`  call void @${mangled}(ptr ${fieldPtr})`);
      return;
    }
    const mangled = mangleTraitMethod(node.structType, node.traitName, node.methodName);
    fnLines.push(`  call void @${mangled}(ptr ${symbols.slotFor(node.bindingName)})`);
  }

  // Phase 6.4: GEP into `%<binding>.<field>`. Returns the SSA name of the
  // field pointer.
  function emitFieldGep(node, fnLines) {
    const enclosing = node.structType;
    const idx = enclosing.fields.findIndex((f) => f.name === node.fieldName);
    if (idx < 0) {
      throw new Error(`codegen: struct ${enclosing.name} has no field "${node.fieldName}"`);
    }
    const tmp = freshTemp();
    fnLines.push(
      `  ${tmp} = getelementptr inbounds ${llvmType(enclosing)}, ptr ${symbols.slotFor(node.bindingName)}, i32 0, i32 ${idx}`,
    );
    return tmp;
  }

  // Phase 6.3: `joined h = task_call();` - stack-allocate the Task struct,
  // submit it, and bind %h to a ptr slot holding the handle. The auto-wait
  // and free_sync_pair are inserted by kindCheck at scope exit.
  function emitJoinedBinding(node, fnLines) {
    const fnName = taskCallFnName(node.assignment);
    if (!fnName) {
      throw new Error(`codegen: joined RHS must be a task call`);
    }
    const meta = taskFnTable.get(fnName);
    const handleSlot = freshTemp();
    fnLines.push(
      `  ${handleSlot} = alloca ${meta.structName}, align 8`,
    );
    // zero-init the struct so refcount/state start clean.
    fnLines.push(`  store ${meta.structName} zeroinitializer, ptr ${handleSlot}`);
    emitTaskHandleInit(handleSlot, fnName, node.assignment.args ?? [], fnLines);
    fnLines.push(`  call void @yoop_task_submit(ptr ${handleSlot}, ptr @${mangle(moduleId, fnName)}__thunk)`);
    // Bind %name as a ptr slot pointing at the on-stack handle.
    const slot = symbols.declare(node.name, node.resolvedType); // TaskType
    bindingDeclTable.set(node.name, { taskFnName: fnName });
    fnLines.push(`  ${slot} = alloca ptr, align 8`);
    fnLines.push(`  store ptr ${handleSlot}, ptr ${slot}`);
  }

  // Phase 6.3: `pooled h = task_call();` - heap-allocate a refcounted handle.
  // yoop_task_alloc returns a zero-init buffer with refcount=2 (caller +
  // worker). kindCheck inserts a release at scope exit; the worker thunk
  // releases its own reference via yoop_handle_signal_done.
  function emitPooledBinding(node, fnLines) {
    const fnName = taskCallFnName(node.assignment);
    if (!fnName) {
      throw new Error(`codegen: pooled RHS must be a task call`);
    }
    const meta = taskFnTable.get(fnName);
    const size = emitTaskStructSize(meta, fnLines);
    const heapPtr = freshTemp();
    fnLines.push(`  ${heapPtr} = call ptr @yoop_task_alloc(i64 ${size})`);
    emitTaskHandleInit(heapPtr, fnName, node.assignment.args ?? [], fnLines);
    fnLines.push(`  call void @yoop_task_submit(ptr ${heapPtr}, ptr @${mangle(moduleId, fnName)}__thunk)`);
    const slot = symbols.declare(node.name, node.resolvedType); // TaskType
    bindingDeclTable.set(node.name, { taskFnName: fnName });
    fnLines.push(`  ${slot} = alloca ptr, align 8`);
    fnLines.push(`  store ptr ${heapPtr}, ptr ${slot}`);
  }

  // Phase 6.4: `pooled h3 = h2;` - copy the existing handle pointer and
  // retain it. The scope-exit release on h3 then balances the retain.
  function emitPooledCopyBinding(node, fnLines) {
    const rhs = emitExpr(node.assignment, fnLines);
    const slot = symbols.declare(node.name, node.resolvedType); // TaskType
    fnLines.push(`  ${slot} = alloca ptr, align 8`);
    fnLines.push(`  store ptr ${rhs.val}, ptr ${slot}`);
    fnLines.push(`  call void @yoop_task_retain(ptr ${rhs.val})`);
  }

  // Phase 6.3: immediate task call - `const x: T = compute(...);`. Allocate
  // on the stack, submit, wait inline, load the result, free the sync pair.
  function emitImmediateTaskBinding(node, fnLines) {
    const fnName = taskCallFnName(node.assignment);
    if (!fnName) {
      throw new Error(`codegen: immediate task binding expects a task call RHS`);
    }
    const meta = taskFnTable.get(fnName);
    const handleSlot = freshTemp();
    fnLines.push(`  ${handleSlot} = alloca ${meta.structName}, align 8`);
    fnLines.push(`  store ${meta.structName} zeroinitializer, ptr ${handleSlot}`);
    emitTaskHandleInit(handleSlot, fnName, node.assignment.args ?? [], fnLines);
    fnLines.push(`  call void @yoop_task_submit(ptr ${handleSlot}, ptr @${mangle(moduleId, fnName)}__thunk)`);
    fnLines.push(`  call void @yoop_task_wait(ptr ${handleSlot})`);
    // Load the result from field 6.
    const declType = node.resolvedType;
    const slot = symbols.declare(node.name, declType);
    const llvmTy = llvmType(declType);
    fnLines.push(`  ${slot} = alloca ${llvmTy}, align ${alignOf(llvmTy)}`);
    const resPtr = freshTemp();
    fnLines.push(
      `  ${resPtr} = getelementptr inbounds ${meta.structName}, ptr ${handleSlot}, i32 0, i32 6`,
    );
    const resVal = freshTemp();
    fnLines.push(`  ${resVal} = load ${llvmTy}, ptr ${resPtr}`);
    fnLines.push(`  store ${llvmTy} ${resVal}, ptr ${slot}`);
    fnLines.push(`  call void @yoop_task_free_sync_pair(ptr ${handleSlot})`);
  }

  function emitImplicitCleanups(block, fnLines) {
    const cleanups = block?.implicitCleanups;
    if (!cleanups || cleanups.length === 0) return;
    if (blockIsTerminated(fnLines)) return;
    for (const c of cleanups) emitCleanupCall(c, fnLines);
  }

  function emitPendingCleanups(node, fnLines) {
    const cleanups = node?.pendingCleanups;
    if (!cleanups || cleanups.length === 0) return;
    for (const c of cleanups) emitCleanupCall(c, fnLines);
  }

  function emitStmt(node, fnLines, ctx) {
    // Post-pass !dbg annotation: record where this statement's emission
    // starts, dispatch to the real emitter, then walk the new lines and
    // attach `, !dbg <loc>` to every side-effecting / control-flow
    // instruction that isn't already annotated. Nested statements
    // (if/while/for/block) attach their own !dbg first, so this outer pass
    // is a no-op on their lines (annotateLinesWithDbg skips them).
    const startIdx = fnLines.length;
    emitStmtImpl(node, fnLines, ctx);
    if (debugInfo && ctx?.subprogram) {
      const loc = dbgLocFor(node, ctx);
      if (loc) annotateLinesWithDbg(fnLines, startIdx, loc);
    }
  }

  function emitStmtImpl(node, fnLines, ctx) {
    switch (node.kind) {
      case ASTNodeKind.RETURN_STATEMENT: {
        // Compute the return value first, fire pending cleanups, then ret.
        // Cleanups must come AFTER the return value is computed (in case the
        // value reads from a binding being cleaned up) but BEFORE `ret`.
        // Runtime shutdown comes AFTER cleanups (cleanups may call into user /
        // FFI code) and immediately before the `ret`.
        if (!node.value || (node.value.kind === ASTNodeKind.IDENT && node.value.name === "void")) {
          emitPendingCleanups(node, fnLines);
          if (inMainFn) fnLines.push("  call void @yoop_runtime_shutdown()");
          fnLines.push("  ret void");
        } else {
          const r = emitExpr(node.value, fnLines);
          emitPendingCleanups(node, fnLines);
          if (inMainFn) fnLines.push("  call void @yoop_runtime_shutdown()");
          fnLines.push(`  ret ${llvmType(ctx.returnType)} ${r.val}`);
        }
        break;
      }
      case ASTNodeKind.LET_DECL:
      case ASTNodeKind.CONST_DECL: {
        // Phase 6.3: builtin task-binding kinds (joined / pooled) and the
        // immediate-task-call shape have their own emission paths.
        const builtin = node.kindPrefix?.builtin;
        if (builtin === "joined") {
          emitJoinedBinding(node, fnLines);
          break;
        }
        if (builtin === "pooled") {
          if (node.pooledCopy) {
            emitPooledCopyBinding(node, fnLines);
          } else {
            emitPooledBinding(node, fnLines);
          }
          break;
        }
        if (node.immediateTaskCall) {
          emitImmediateTaskBinding(node, fnLines);
          break;
        }

        const declType = node.resolvedType;
        if (declType.kind === typeKinds.array) ensureArrayTypeDef(declType.elem);
        const slot = symbols.declare(node.name, declType);
        const llvmTy = llvmType(declType);
        const al = effectiveAlign(declType, node.resolvedKindApplication);
        fnLines.push(`  ${slot} = alloca ${llvmTy}, align ${al}`);
        emitDbgDeclare(fnLines, {
          name: node.name,
          slotPtr: slot,
          yoopType: declType,
          sourceLoc: node.sourceLoc,
          subprogramRef: ctx.subprogram,
        });
        if (node.assignment) {
          if (node.assignment.kind === ASTNodeKind.STRUCT_LITERAL && declType.kind === typeKinds.struct) {
            emitStructLitInto(node.assignment, slot, declType, fnLines);
          } else {
            const r = emitExpr(node.assignment, fnLines);
            fnLines.push(`  store ${llvmTy} ${r.val}, ptr ${slot}`);
          }
        }
        // Phase 6.1: kind-prefixed binding with `ownsBlock` form. Walk the
        // trailing block in place, then fire its implicit cleanups before
        // control falls out of the trailing block's scope.
        if (node.trailingBlock) {
          node.trailingBlock.body.forEach((s) => emitStmt(s, fnLines, ctx));
          emitImplicitCleanups(node.trailingBlock, fnLines);
        }
        break;
      }
      case ASTNodeKind.CLEANUP_CALL:
        // Synthetic node produced by kindCheck; codegen normally emits these
        // inline via emitCleanupCall(...). Reach this case only if a stray
        // node slipped into a statement list.
        emitCleanupCall(node, fnLines);
        break;
      case ASTNodeKind.EXPRESSION_STATEMENT: emitExpr(node.value, fnLines); break;
      case ASTNodeKind.DESTRUCTURE_DECL: emitDestrDecl(node, fnLines); break;
      case ASTNodeKind.DISCARD_STATEMENT: emitExpr(node.value, fnLines); break;
      case ASTNodeKind.IF_STATEMENT: emitIfStmt(node, fnLines, ctx); break;
      case ASTNodeKind.WHILE_STATEMENT: emitWhileStmt(node, fnLines, ctx); break;
      case ASTNodeKind.FOR_LOOP: emitForLoopStmt(node, fnLines, ctx); break;
      case ASTNodeKind.FOR_IN_LOOP: emitForInLoopStmt(node, fnLines, ctx); break;
      case ASTNodeKind.BREAK_STATEMENT: fnLines.push(`  br label %${ctx.breakLabel}`); break;
      case ASTNodeKind.CONTINUE_STATEMENT: fnLines.push(`  br label %${ctx.continueLabel}`); break;
      case ASTNodeKind.BLOCK: node.body.forEach((s) => emitStmt(s, fnLines, ctx)); break;
      case ASTNodeKind.SWITCH_STATEMENT: emitSwitchStmt(node, fnLines, ctx); break;
      case ASTNodeKind.ATTRIBUTE: {
        // Phase 11.D.18: an ATTRIBUTE node inside a function body
        // (e.g. `@precompile { ... }` as a statement). The
        // attribute / comptime pass already consumed it. No runtime
        // code is emitted - the block's side effects are baked into
        // the module-level @globals during the comptime pass.
        break;
      }
      default: throw new Error(`codegen: unhandled statement kind "${node.kind}"`);
    }
  }

  // Phase 7.5: lower a `switch` statement.
  //
  //   Scrutinee int/bool/char:
  //     emit scrutinee → use LLVM `switch <ty>` with a case list mapping
  //     literal -> arm-entry label and a default label (user default body or
  //     the merge label).
  //
  //   Scrutinee enum:
  //     load tag from field 0, switch on i32 ordinal. Each variant arm gets
  //     an arm-entry label; the arm body binds payload fields by GEP'ing into
  //     the (allocated) enum slot's payload bytes via the variant struct.
  function emitSwitchStmt(node, fnLines, ctx) {
    const scrutType = node.scrutineeType;
    const endLabel = freshLabel("switch_end");
    const defaultLabel = freshLabel("switch_default");

    // For enum scrutinees we need the underlying alloca slot so payload GEPs
    // resolve. emitLval handles that for any lvalue; for arbitrary scrutinee
    // expressions emitLval will materialize a temp slot for us.
    let scrutSlot = null;
    let scrutVal = null;
    if (scrutType.kind === typeKinds.variant) {
      scrutSlot = emitLval(node.scrutinee, fnLines);
      const enumLlvm = llvmType(scrutType);
      const tagPtr = freshTemp();
      fnLines.push(`  ${tagPtr} = getelementptr inbounds ${enumLlvm}, ptr ${scrutSlot.ptr}, i32 0, i32 0`);
      const tagVal = freshTemp();
      fnLines.push(`  ${tagVal} = load i32, ptr ${tagPtr}`);
      scrutVal = { val: tagVal, yoopType: PrimType("int32") };
    } else {
      scrutVal = emitExpr(node.scrutinee, fnLines);
    }

    // Build (literal, label) pairs for the LLVM switch.
    const armEntries = []; // { label, arm }
    const caseLines = []; // strings inside `[ ... ]`

    for (const arm of node.arms) {
      const armLabel = freshLabel("switch_arm");
      armEntries.push({ label: armLabel, arm });
      for (const pat of arm.patterns) {
        if (pat.kind === ASTNodeKind.LITERAL_PATTERN) {
          const litVal = literalPatternIRValue(pat, scrutType);
          const ty = llvmType(scrutType);
          caseLines.push(`${ty} ${litVal}, label %${armLabel}`);
        } else if (pat.kind === ASTNodeKind.VARIANT_PATTERN && !pat.isWildcard) {
          if (pat.resolvedValueEnumCase) {
            // Phase 12: value-enum pattern. Match the underlying primitive
            // constant of the case.
            const ty = llvmType(scrutType);
            const v = typeof pat.resolvedValueEnumCase.value === "bigint"
              ? pat.resolvedValueEnumCase.value.toString()
              : String(pat.resolvedValueEnumCase.value);
            caseLines.push(`${ty} ${v}, label %${armLabel}`);
          } else {
            caseLines.push(`i32 ${pat.resolvedVariant.ordinal}, label %${armLabel}`);
          }
        }
        // VARIANT_PATTERN { isWildcard: true } only appears as `case _:` which
        // the parser routed through the default-arm slot already (we don't
        // emit cases for it).
      }
    }

    const scrutTyForSwitch =
      scrutType.kind === typeKinds.variant ? "i32" : llvmType(scrutType);
    fnLines.push(
      `  switch ${scrutTyForSwitch} ${scrutVal.val}, label %${defaultLabel} [ ${caseLines.join(" ")} ]`,
    );

    for (const { label, arm } of armEntries) {
      fnLines.push(`${label}:`);
      // Phase 10.H: each arm is its own lexical scope (pattern bindings +
      // arm body). Push before emitting pattern bindings so their slot
      // uniquification undoes when the arm exits.
      symbols.enterScope();
      // Bind any variant-pattern field bindings for this arm. We support
      // exactly one variant pattern per arm body (multi-pattern arms are
      // typecheck-restricted to literal-only homogeneous lists).
      const vp = arm.patterns.find(
        (p) => p.kind === ASTNodeKind.VARIANT_PATTERN && !p.isWildcard,
      );
      // Phase 12: value-enum patterns have no payload - skip the field-binding
      // path entirely.
      if (vp && vp.resolvedValueEnumCase) {
        // nothing to bind; value-enum cases are scalar constants.
      } else if (vp && vp.resolvedVariant.fields !== null && vp.fieldBindings) {
        const enumType = vp.resolvedVariantType;
        const enumLlvm = llvmType(enumType);
        const enumId = enumType.moduleId
          ? `${enumType.moduleId}__${enumType.name}`
          : enumType.name;
        const variantLlvm = `%variantc.${enumId}__${vp.variantName}`;
        const payloadPtr = freshTemp();
        fnLines.push(
          `  ${payloadPtr} = getelementptr inbounds ${enumLlvm}, ptr ${scrutSlot.ptr}, i32 0, i32 1`,
        );
        for (const fb of vp.fieldBindings) {
          if (fb.isWildcard) continue;
          if (!fb.fieldName || !fb.bindingName) continue;
          const idx = vp.resolvedVariant.fields.findIndex(
            (f) => f.name === fb.fieldName,
          );
          if (idx < 0) continue;
          const fieldType = vp.resolvedVariant.fields[idx].type;
          const fieldLlvmTy = llvmType(fieldType);
          const fieldPtr = freshTemp();
          fnLines.push(
            `  ${fieldPtr} = getelementptr inbounds ${variantLlvm}, ptr ${payloadPtr}, i32 0, i32 ${idx}`,
          );
          const valTmp = freshTemp();
          fnLines.push(`  ${valTmp} = load ${fieldLlvmTy}, ptr ${fieldPtr}`);
          // Materialize the binding as a normal local alloca.
          const bindingSlot = symbols.declare(fb.bindingName, fieldType);
          fnLines.push(
            `  ${bindingSlot} = alloca ${fieldLlvmTy}, align ${sizeOfAlign(fieldType)}`,
          );
          fnLines.push(
            `  store ${fieldLlvmTy} ${valTmp}, ptr ${bindingSlot}`,
          );
        }
      }
      const armCtx = { ...ctx, breakLabel: endLabel };
      emitBlockStmt(arm.body, fnLines, armCtx);
      if (!blockIsTerminated(fnLines)) {
        fnLines.push(`  br label %${endLabel}`);
      }
      symbols.leaveScope();
    }

    fnLines.push(`${defaultLabel}:`);
    if (node.defaultArm) {
      const armCtx = { ...ctx, breakLabel: endLabel };
      emitBlockStmt(node.defaultArm, fnLines, armCtx);
      if (!blockIsTerminated(fnLines)) {
        fnLines.push(`  br label %${endLabel}`);
      }
    } else {
      fnLines.push(`  br label %${endLabel}`);
    }
    fnLines.push(`${endLabel}:`);
  }

  // Phase 7.5: format a LITERAL_PATTERN value as the LLVM constant for its
  // case label. For bool we emit i1 0/1; for ints we emit the numeric value
  // directly (LLVM accepts decimal constants).
  function literalPatternIRValue(pat, scrutType) {
    if (scrutType.kind === typeKinds.prim && scrutType.name === "bool") {
      return pat.value ? "1" : "0";
    }
    return String(pat.value);
  }

  function emitDestrDecl(node, fnLines) {
    const r = emitExpr(node.assignment, fnLines);
    const slotType = node.assignment.resolvedType;
    const slotPtr = freshTemp();
    const slotLlvmTy = llvmType(slotType);
    fnLines.push(`  ${slotPtr} = alloca ${slotLlvmTy}, align ${alignOfStruct(slotType)}`);
    fnLines.push(`  store ${slotLlvmTy} ${r.val}, ptr ${slotPtr}`);
    for (const name of node.names) {
      const idx = slotType.fields.findIndex((f) => f.name === name);
      const fieldType = slotType.fields[idx].type;
      const llvmTy = llvmType(fieldType);
      const al = fieldType.kind === typeKinds.struct ? alignOfStruct(fieldType) : alignOf(llvmTy);
      const gepTmp = freshTemp();
      fnLines.push(`  ${gepTmp} = getelementptr inbounds ${llvmType(slotType)}, ptr ${slotPtr}, i32 0, i32 ${idx}`);
      const valTmp = freshTemp();
      fnLines.push(`  ${valTmp} = load ${llvmTy}, ptr ${gepTmp}`);
      const declSlot = symbols.declare(name, fieldType);
      fnLines.push(`  ${declSlot} = alloca ${llvmTy}, align ${al}`);
      fnLines.push(`  store ${llvmTy} ${valTmp}, ptr ${declSlot}`);
    }
  }

  function emitIfStmt(node, fnLines, ctx) {
    const cond = emitExpr(node.expression, fnLines);
    const thenLabel = freshLabel("then");
    const elseLabel = freshLabel("else");
    const mergeLabel = freshLabel("merge");
    fnLines.push(`  br i1 ${cond.val}, label %${thenLabel}, label %${elseLabel}`);
    fnLines.push(`${thenLabel}:`);
    emitBlockStmt(node.body, fnLines, ctx);
    fnLines.push(`  br label %${mergeLabel}`);
    fnLines.push(`${elseLabel}:`);
    if (node.elseBody) emitBlockStmt(node.elseBody, fnLines, ctx);
    fnLines.push(`  br label %${mergeLabel}`);
    fnLines.push(`${mergeLabel}:`);
  }

  function emitWhileStmt(node, fnLines, ctx) {
    const condLabel = freshLabel("while_cond");
    const bodyLabel = freshLabel("while_body");
    const afterLabel = freshLabel("while_after");
    fnLines.push(`  br label %${condLabel}`);
    fnLines.push(`${condLabel}:`);
    const cond = emitExpr(node.expression, fnLines);
    fnLines.push(`  br i1 ${cond.val}, label %${bodyLabel}, label %${afterLabel}`);
    fnLines.push(`${bodyLabel}:`);
    const loopCtx = { ...ctx, breakLabel: afterLabel, continueLabel: condLabel };
    emitBlockStmt(node.body, fnLines, loopCtx);
    if (!blockIsTerminated(fnLines)) fnLines.push(`  br label %${condLabel}`);
    fnLines.push(`${afterLabel}:`);
  }

  function emitForLoopStmt(node, fnLines, ctx) {
    const initType = symbols.get(node.initIdent);
    const initVal = emitExpr(node.initExpr, fnLines);
    fnLines.push(`  store ${llvmType(initType)} ${initVal.val}, ptr ${symbols.slotFor(node.initIdent)}`);

    const condLabel = freshLabel("for_cond");
    const bodyLabel = freshLabel("for_body");
    const stepLabel = freshLabel("for_step");
    const afterLabel = freshLabel("for_after");

    fnLines.push(`  br label %${condLabel}`);
    fnLines.push(`${condLabel}:`);
    const cond = emitExpr(node.cond, fnLines);
    fnLines.push(`  br i1 ${cond.val}, label %${bodyLabel}, label %${afterLabel}`);

    fnLines.push(`${bodyLabel}:`);
    const loopCtx = { ...ctx, breakLabel: afterLabel, continueLabel: stepLabel };
    emitBlockStmt(node.body, fnLines, loopCtx);
    if (!blockIsTerminated(fnLines)) fnLines.push(`  br label %${stepLabel}`);

    fnLines.push(`${stepLabel}:`);
    const stepType = symbols.get(node.stepIdent);
    const stepVal = emitExpr(node.stepExpr, fnLines);
    fnLines.push(`  store ${llvmType(stepType)} ${stepVal.val}, ptr ${symbols.slotFor(node.stepIdent)}`);
    fnLines.push(`  br label %${condLabel}`);

    fnLines.push(`${afterLabel}:`);
  }

  function emitBlockStmt(blockOrNode, fnLines, ctx) {
    symbols.enterScope();
    if (blockOrNode.kind === ASTNodeKind.BLOCK) {
      blockOrNode.body.forEach((s) => emitStmt(s, fnLines, ctx));
      emitImplicitCleanups(blockOrNode, fnLines);
    } else {
      emitStmt(blockOrNode, fnLines, ctx);
    }
    symbols.leaveScope();
  }

  // Phase 9.D: `for item in xs { ... }` - multi-module codegen path. Mirrors
  // Phase 10.B: iterable-impl twin of emitForInLoopIterable in the
  // single-module section. See that function for the lowering rationale.
  function emitForInLoopIterableStmt(node, fnLines, ctx) {
    const iterType = node.resolvedIterType;
    const elemType = node.resolvedElemType;
    const iterStepType = node.iterableImpl.iterStepType;
    const mangledNext = node.iterableImpl.mangledNextName;

    const iterLlvm = llvmType(iterType);
    const elemLlvm = llvmType(elemType);
    const stepLlvm = llvmType(iterStepType);
    const elemAlign = elemType.kind === typeKinds.struct
      ? alignOfStruct(elemType)
      : alignOf(elemLlvm);

    symbols.enterScope();

    const r = emitExpr(node.iterExpr, fnLines);
    const iterSlot = freshTemp();
    fnLines.push(`  ${iterSlot} = alloca ${iterLlvm}, align ${alignOfStruct(iterType)}`);
    fnLines.push(`  store ${iterLlvm} ${r.val}, ptr ${iterSlot}`);

    const loopVarSlot = symbols.declare(node.loopVar, elemType);
    fnLines.push(`  ${loopVarSlot} = alloca ${elemLlvm}, align ${elemAlign}`);

    const stepSlot = freshTemp();
    fnLines.push(`  ${stepSlot} = alloca ${stepLlvm}, align ${sizeOfAlign(iterStepType)}`);

    const topLabel = freshLabel("forin_iter_top");
    const bodyLabel = freshLabel("forin_iter_body");
    const stepLabel = freshLabel("forin_iter_step");
    const afterLabel = freshLabel("forin_iter_after");

    fnLines.push(`  br label %${topLabel}`);
    fnLines.push(`${topLabel}:`);
    const stepVal = freshTemp();
    fnLines.push(`  ${stepVal} = call ${stepLlvm} @${mangledNext}(ptr ${iterSlot})`);
    fnLines.push(`  store ${stepLlvm} ${stepVal}, ptr ${stepSlot}`);

    const tagPtr = freshTemp();
    fnLines.push(`  ${tagPtr} = getelementptr inbounds ${stepLlvm}, ptr ${stepSlot}, i32 0, i32 0`);
    const tag = freshTemp();
    fnLines.push(`  ${tag} = load i32, ptr ${tagPtr}`);
    const yieldOrdinal = iterStepType.variants.get("Yield").ordinal;
    const isYield = freshTemp();
    fnLines.push(`  ${isYield} = icmp eq i32 ${tag}, ${yieldOrdinal}`);
    fnLines.push(`  br i1 ${isYield}, label %${bodyLabel}, label %${afterLabel}`);

    fnLines.push(`${bodyLabel}:`);
    const stepEnumId = iterStepType.moduleId
      ? `${iterStepType.moduleId}__${iterStepType.name}`
      : iterStepType.name;
    const yieldVariantLlvm = `%variantc.${stepEnumId}__Yield`;
    const payloadPtr = freshTemp();
    fnLines.push(`  ${payloadPtr} = getelementptr inbounds ${stepLlvm}, ptr ${stepSlot}, i32 0, i32 1`);
    const valuePtr = freshTemp();
    fnLines.push(`  ${valuePtr} = getelementptr inbounds ${yieldVariantLlvm}, ptr ${payloadPtr}, i32 0, i32 0`);
    const elemVal = freshTemp();
    fnLines.push(`  ${elemVal} = load ${elemLlvm}, ptr ${valuePtr}`);
    fnLines.push(`  store ${elemLlvm} ${elemVal}, ptr ${loopVarSlot}`);

    const loopCtx = { ...ctx, breakLabel: afterLabel, continueLabel: stepLabel };
    emitBlockStmt(node.body, fnLines, loopCtx);
    if (!blockIsTerminated(fnLines)) fnLines.push(`  br label %${stepLabel}`);

    fnLines.push(`${stepLabel}:`);
    fnLines.push(`  br label %${topLabel}`);

    fnLines.push(`${afterLabel}:`);
    symbols.leaveScope();
  }

  // emitForInLoop in the single-module section: evaluate the iterable once,
  // cache the data pointer and length, then walk an i64 counter.
  function emitForInLoopStmt(node, fnLines, ctx) {
    if (node.iterableImpl) {
      emitForInLoopIterableStmt(node, fnLines, ctx);
      return;
    }
    const elemType = node.resolvedElemType;
    ensureArrayTypeDef(elemType);

    const base = emitLval(node.iterExpr, fnLines);
    const arrayLlvmTy = llvmType(base.type);
    const elemLlvmTy = llvmType(elemType);
    const elemAlign = elemType.kind === typeKinds.struct
      ? alignOfStruct(elemType)
      : alignOf(elemLlvmTy);

    const dataFieldPtr = freshTemp();
    fnLines.push(`  ${dataFieldPtr} = getelementptr inbounds ${arrayLlvmTy}, ptr ${base.ptr}, i32 0, i32 0`);
    const dataPtr = freshTemp();
    fnLines.push(`  ${dataPtr} = load ptr, ptr ${dataFieldPtr}`);
    const lenFieldPtr = freshTemp();
    fnLines.push(`  ${lenFieldPtr} = getelementptr inbounds ${arrayLlvmTy}, ptr ${base.ptr}, i32 0, i32 1`);
    const lenVal = freshTemp();
    fnLines.push(`  ${lenVal} = load i64, ptr ${lenFieldPtr}`);

    const counterSlot = freshTemp();
    fnLines.push(`  ${counterSlot} = alloca i64, align 8`);
    fnLines.push(`  store i64 0, ptr ${counterSlot}`);

    symbols.enterScope();
    const loopVarSlot = symbols.declare(node.loopVar, elemType);
    fnLines.push(`  ${loopVarSlot} = alloca ${elemLlvmTy}, align ${elemAlign}`);

    const condLabel = freshLabel("forin_cond");
    const bodyLabel = freshLabel("forin_body");
    const stepLabel = freshLabel("forin_step");
    const afterLabel = freshLabel("forin_after");

    fnLines.push(`  br label %${condLabel}`);
    fnLines.push(`${condLabel}:`);
    const counterVal = freshTemp();
    fnLines.push(`  ${counterVal} = load i64, ptr ${counterSlot}`);
    const doneVal = freshTemp();
    fnLines.push(`  ${doneVal} = icmp uge i64 ${counterVal}, ${lenVal}`);
    fnLines.push(`  br i1 ${doneVal}, label %${afterLabel}, label %${bodyLabel}`);

    fnLines.push(`${bodyLabel}:`);
    const idxVal = freshTemp();
    fnLines.push(`  ${idxVal} = load i64, ptr ${counterSlot}`);
    const elemPtr = freshTemp();
    fnLines.push(`  ${elemPtr} = getelementptr inbounds ${elemLlvmTy}, ptr ${dataPtr}, i64 ${idxVal}`);
    const elemVal = freshTemp();
    fnLines.push(`  ${elemVal} = load ${elemLlvmTy}, ptr ${elemPtr}`);
    fnLines.push(`  store ${elemLlvmTy} ${elemVal}, ptr ${loopVarSlot}`);

    const loopCtx = { ...ctx, breakLabel: afterLabel, continueLabel: stepLabel };
    emitBlockStmt(node.body, fnLines, loopCtx);
    if (!blockIsTerminated(fnLines)) fnLines.push(`  br label %${stepLabel}`);

    fnLines.push(`${stepLabel}:`);
    const curVal = freshTemp();
    fnLines.push(`  ${curVal} = load i64, ptr ${counterSlot}`);
    const nextVal = freshTemp();
    fnLines.push(`  ${nextVal} = add i64 ${curVal}, 1`);
    fnLines.push(`  store i64 ${nextVal}, ptr ${counterSlot}`);
    fnLines.push(`  br label %${condLabel}`);

    fnLines.push(`${afterLabel}:`);
    symbols.leaveScope();
  }
}

function usesLegacyPrintf(ast) {
  let found = false;
  function walk(n) {
    if (found || !n || typeof n !== "object") return;
    if (n.kind === ASTNodeKind.CALL_EXPRESSION && n.callee === "printf") { found = true; return; }
    for (const val of Object.values(n)) {
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === "object" && val.kind) walk(val);
    }
  }
  walk(ast);
  return found;
}

export function compileEntry(entryAbsPath, opts = {}) {
  const { modules, autoloadedStdModuleIds } = loadModuleGraph(entryAbsPath);
  const { errors, moduleEnv, programState } = typecheckProgram(modules);
  // Thread the well-known std module ids through programState so codegen
  // can mint mangled symbols (`<fmtModId>__int_to_string`, etc.) when
  // lowering interpolated template literals.
  programState.autoloadedStdModuleIds = autoloadedStdModuleIds ?? {};
  // --track-heap parity with the yoopiler.js driver. Tests pass this
  // through opts; production code paths go through the driver flag.
  programState.trackHeap = !!opts.trackHeap;
  if (errors.length > 0) {
    throw new Error(
      `compileEntry: typecheck failed with ${errors.length} error(s):\n` +
        errors.map((e) => `  ${e.message}`).join("\n"),
    );
  }
  // Phase 11.B/C: mirror the driver pipeline so multi-module e2e
  // fixtures see the same fold behavior as `node src/yoopiler.js ...`.
  // Comptime pass runs first (sets decl.comptimeFolded), then the
  // attribute pass surfaces `@precompile` failures as hard errors.
  runComptimePass(modules, { programState });
  const attrErrors = [];
  runAttributePass(modules, attrErrors);
  if (attrErrors.length > 0) {
    throw new Error(
      `compileEntry: attribute pass failed with ${attrErrors.length} error(s):\n` +
        attrErrors.map((e) => `  ${e.message}`).join("\n"),
    );
  }
  return codegenProgram(modules, moduleEnv, programState);
}
