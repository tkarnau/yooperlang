// LLVM IR code generator — walks the AST and creates IR code

import { parse } from "../jsyooparser/parser.js";
import { typecheck, typecheckProgram } from "../jsyooptypecheck/typecheck.js";
import { ASTNodeKind } from "../contracts.js";
import {
  PrimType,
  VoidType,
  castInstruction,
  isFloatPrim,
  isIntPrim,
  isUnsignedIntPrim,
  substituteTypeParams,
  typeKinds,
} from "../jsyooptypecheck/types.js";
import { strippedTypeOf } from "../jsyooptypecheck/fallible.js";
import { loadModuleGraph } from "../jsyoopdriver/moduleGraph.js";
import { instantiateFunc } from "../jsyooptypecheck/instantiate.js";
import { mangleTraitMethod } from "../jsyooptypecheck/mangleTraitMethod.js";

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
  float: "float",
  float32: "float",
  float64: "double",
  bool: "i1",
  void: "void",
  string: "ptr", // i8* — null-terminated UTF-8 pointer, llvm docs thing?
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
  "declare ptr @yoop_task_alloc(i64)",
  "declare void @yoop_task_retain(ptr)",
  "declare void @yoop_task_release(ptr)",
  "declare void @yoop_handle_signal_done(ptr)",
  "declare void @yoop_task_free_sync_pair(ptr)",
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
    case typeKinds.enum: {
      const id = yoopType.moduleId ? `${yoopType.moduleId}__${yoopType.name}` : yoopType.name;
      return `%enum.${id}`;
    }
    case typeKinds.union: {
      const id = yoopType.moduleId ? `${yoopType.moduleId}__${yoopType.name}` : yoopType.name;
      return `%union.${id}`;
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

// Stable string key for an array element type — used in %yoop_array.<name> struct names.
function arrayElemLlvmName(elemType) {
  if (elemType.kind === typeKinds.prim) return elemType.name;
  if (elemType.kind === typeKinds.struct) {
    return elemType.moduleId ? `${elemType.moduleId}__${elemType.name}` : elemType.name;
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

// pick a printf format specifier for a yooper type
export function printfSpec(t) {
  if (t.kind === typeKinds.struct) {
    throw new Error(
      `codegen bug: struct ${t.name} reached printf — typechecker should have rejected`,
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
// block becomes a *dynamic* alloca — it adjusts the stack pointer at runtime
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
  // block instead would land *between* the terminator and that label — which
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
  let symbols = new Map(); // varName -> yoopType

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
          fnLines.push(`  ${ptrTmp} = load ptr, ptr %${node.name}`);
          return { ptr: ptrTmp, type: t.inner };
        }
        return { ptr: `%${node.name}`, type: t };
      }
      case ASTNodeKind.FIELD_ACCESS: {
        const base = emitLvalue(node.object, fnLines);
        if (base.type.kind !== typeKinds.struct) {
          throw new Error(
            `codegen: field access on non-struct type — typechecker should have caught this`,
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
  // literals write directly into the corresponding GEP — no temp alloca.
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
  // holds the operand's full struct value. Caller decides what to do with
  // the success value (single field load, void, or destructure).
  //
  // shape:
  //   <eval operand> -> %tmp
  //   alloca + store on stack
  //   load err pointer; strlen(err) > 0 -> branch
  //   try_fail: build default fallible return value, set err, ret
  //   try_ok:  control resumes here for the success path
  function emitTryOpToSlot(node, fnLines) {
    const operandType = node.operand.resolvedType;
    const r = emitExpr(node.operand, fnLines);
    const slot = freshTemp();
    const operandLlvmTy = llvmType(operandType);
    fnLines.push(
      `  ${slot} = alloca ${operandLlvmTy}, align ${alignOfStruct(operandType)}`,
    );
    fnLines.push(
      `  store ${operandLlvmTy} ${r.val}, ptr ${slot}`,
    );

    const errIdx = operandType.fields.length - 1;
    const errPtr = freshTemp();
    fnLines.push(
      `  ${errPtr} = getelementptr inbounds ${operandLlvmTy}, ptr ${slot}, i32 0, i32 ${errIdx}`,
    );
    const errStr = freshTemp();
    fnLines.push(`  ${errStr} = load ptr, ptr ${errPtr}`);
    const errLen = freshTemp();
    fnLines.push(`  ${errLen} = call i64 @strlen(ptr ${errStr})`);
    const failed = freshTemp();
    fnLines.push(`  ${failed} = icmp ne i64 ${errLen}, 0`);

    const failLabel = freshLabel("try_fail");
    const okLabel = freshLabel("try_ok");
    fnLines.push(`  br i1 ${failed}, label %${failLabel}, label %${okLabel}`);

    fnLines.push(`${failLabel}:`);
    emitFailVariantReturn(currentReturnType, errStr, fnLines);

    fnLines.push(`${okLabel}:`);
    return { ptr: slot, type: operandType };
  }

  // build the failure-variant struct of the *enclosing function's* return
  // type: zeroinitializer for every field, then write `err`. Per spec, the
  // caller short-circuits on err and never reads the other fields.
  function emitFailVariantReturn(retType, errStr, fnLines) {
    const retLlvmTy = llvmType(retType);
    const failSlot = freshTemp();
    fnLines.push(
      `  ${failSlot} = alloca ${retLlvmTy}, align ${alignOfStruct(retType)}`,
    );
    fnLines.push(
      `  store ${retLlvmTy} zeroinitializer, ptr ${failSlot}`,
    );
    const errIdx = retType.fields.length - 1;
    const failErrPtr = freshTemp();
    fnLines.push(
      `  ${failErrPtr} = getelementptr inbounds ${retLlvmTy}, ptr ${failSlot}, i32 0, i32 ${errIdx}`,
    );
    fnLines.push(`  store ptr ${errStr}, ptr ${failErrPtr}`);
    const failVal = freshTemp();
    fnLines.push(
      `  ${failVal} = load ${retLlvmTy}, ptr ${failSlot}`,
    );
    if (inMainFn) fnLines.push("  call void @yoop_runtime_shutdown()");
    fnLines.push(`  ret ${retLlvmTy} ${failVal}`);
  }

  // Track the enclosing function's return type for emitFailVariantReturn.
  // Set in emitFunction; consumed inside emitTryOpToSlot.
  let currentReturnType = null;

  // True while emitting the body of `main` (the program's C entry point).
  // Consumed at every `ret` site so we can inject yoop_runtime_shutdown().
  let inMainFn = false;

  // Set by codegenProgram for each module. null in single-module mode.
  let currentModuleId = null;
  // Names of extern functions in the current module — not mangled.
  let currentExternNames = new Set();

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
          fnLines.push(`  ${ptrTmp} = load ptr, ptr %${node.name}`);
          const valTmp = freshTemp();
          fnLines.push(`  ${valTmp} = load ${llvmType(innerType)}, ptr ${ptrTmp}`);
          return { val: valTmp, yoopType: innerType };
        }
        const llvmTy = llvmType(yoopType);
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = load ${llvmTy}, ptr %${node.name}`);
        return { val: tmp, yoopType };
      }

      case ASTNodeKind.REF_EXPRESSION: {
        if (node.operand.kind === ASTNodeKind.IDENT) {
          const operandType = symbols.get(node.operand.name);
          if (operandType?.kind === typeKinds.ref) {
            // ref of a ref binding (like `ref self`): forward the underlying pointer
            const ptrTmp = freshTemp();
            fnLines.push(`  ${ptrTmp} = load ptr, ptr %${node.operand.name}`);
            return { val: ptrTmp, yoopType: node.resolvedType };
          }
          return { val: `%${node.operand.name}`, yoopType: node.resolvedType };
        }
        // field access or index: use emitLvalue to get the address
        const lv = emitLvalue(node.operand, fnLines);
        return { val: lv.ptr, yoopType: node.resolvedType };
      }

      case ASTNodeKind.CALL_EXPRESSION: {
        return emitCall(node, fnLines);
      }

      case ASTNodeKind.BINARY_EXPRESSION: {
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
            fnLines.push(`  ${ptrTmp} = load ptr, ptr %${targetName}`);
            const rhs = emitExpr(node.value, fnLines);
            fnLines.push(`  store ${llvmType(innerType)} ${rhs.val}, ptr ${ptrTmp}`);
            return rhs;
          }
          const rhs = emitExpr(node.value, fnLines);
          fnLines.push(
            `  store ${llvmType(lhsType)} ${rhs.val}, ptr %${targetName}`,
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
        // intrinsic: `xs.len` on an array — GEP field 1 of the fat pointer.
        if (node.isArrayLen) {
          const lv = emitLvalue(node.object, fnLines);
          const arrayLlvmTy = llvmType(lv.type);
          const lenField = freshTemp();
          fnLines.push(`  ${lenField} = getelementptr inbounds ${arrayLlvmTy}, ptr ${lv.ptr}, i32 0, i32 1`);
          const lenVal = freshTemp();
          fnLines.push(`  ${lenVal} = load i64, ptr ${lenField}`);
          return { val: lenVal, yoopType: PrimType("usize") };
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
        const slot = emitTryOpToSlot(node, fnLines);
        const stripped = strippedTypeOf(node.operand.resolvedType);
        if (!stripped || stripped.kind === "strippedMulti") {
          // multi-strip in expression position is rejected by the
          // typechecker — defensive.
          throw new Error(
            `codegen: TRY_OP at emitExpr saw an unsupported strip shape — typechecker should have rejected`,
          );
        }
        if (stripped.kind === typeKinds.void) {
          return { val: "void", yoopType: VoidType() };
        }
        // single non-err field: load it from index 0 of the on-stack source slot.
        const valPtr = freshTemp();
        const slotLlvmTy = llvmType(slot.type);
        fnLines.push(
          `  ${valPtr} = getelementptr inbounds ${slotLlvmTy}, ptr ${slot.ptr}, i32 0, i32 0`,
        );
        const val = freshTemp();
        const llvmTy = llvmType(stripped);
        fnLines.push(`  ${val} = load ${llvmTy}, ptr ${valPtr}`);
        return { val, yoopType: stripped };
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
    // Namespace call: io.greet("hello") — callee is a FIELD_ACCESS node
    if (node.callee && typeof node.callee === "object" && node.callee.namespaceLookup) {
      const { moduleId, exportName } = node.callee.namespaceLookup;
      const mangledName = `${moduleId}__${exportName}`;
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
      // Local function defined in this module — mangle it.
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

    for (const argNode of node.args) {
      if (argNode.kind === ASTNodeKind.STRING_LITERAL) {
        // raw format text — strip the surrounding quotes, keep escapes intact
        const inner = argNode.value.slice(1, -1);
        fmtSpec += inner;
      } else if (argNode.kind === ASTNodeKind.TEMPLATE_LITERAL) {
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
        const r = emitExpr(argNode, fnLines);
        fmtSpec += printfSpec(r.yoopType);
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
          const promoted = promotedLlvmType(r.yoopType);
          const actual = llvmType(r.yoopType);
          if (promoted !== actual) {
            // varargs promotion: widen the value to the promoted type
            const tmp = freshTemp();
            if (isIntType(r.yoopType)) {
              const op = isUnsignedIntPrim(r.yoopType.name) ? "zext" : "sext";
              fnLines.push(`  ${tmp} = ${op} ${actual} ${r.val} to ${promoted}`);
            } else if (
              r.yoopType.kind === typeKinds.prim &&
              r.yoopType.name === "bool"
            ) {
              fnLines.push(`  ${tmp} = zext ${actual} ${r.val} to ${promoted}`);
            } else if (isFloatType(r.yoopType)) {
              fnLines.push(`  ${tmp} = fpext ${actual} ${r.val} to ${promoted}`);
            } else {
              throw new Error(
                `codegen: don't know how to promote ${r.yoopType.kind}/${r.yoopType.name ?? ""} for varargs`,
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
  // values — so we error in that case.
  function emitTemplateLiteral(node, fnLines) {
    const hasInterp = node.parts.some((p) => p.kind === ASTNodeKind.EXPR_PART);
    if (hasInterp) {
      throw new Error(
        `codegen: template literals with \${...} interpolation are only supported inside printf(...) for now`,
      );
    }
    // pure string template — emit as a regular string global
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
        symbols.set(node.name, declType);
        const llvmTy = llvmType(declType);
        const align = effectiveAlign(declType, node.resolvedKindApplication);
        fnLines.push(`  %${node.name} = alloca ${llvmTy}, align ${align}`);
        if (node.assignment) {
          if (
            node.assignment.kind === ASTNodeKind.STRUCT_LITERAL &&
            declType.kind === typeKinds.struct
          ) {
            // populate the alloca'd slot directly — skip the temp + load + store
            emitStructLiteralInto(
              node.assignment,
              `%${node.name}`,
              declType,
              fnLines,
            );
          } else {
            const r = emitExpr(node.assignment, fnLines);
            fnLines.push(`  store ${llvmTy} ${r.val}, ptr %${node.name}`);
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
        // `_ = expr;` — evaluate for side-effects only. If `expr` is a
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

  // `const { a, b, err } = expr;`
//
// Two RHS shapes:
//   - plain expression: stash the result in a slot, GEP each name out
//   - TRY_OP: emitTryOpToSlot (handles err propagation), then GEP from the
//     post-success slot using the *operand's* type (its fields are still
//     all there, including err — we just won't pick err from them since
//     the destructure names won't include it).
  function emitDestructureDecl(node, fnLines) {
    let slotPtr;
    let slotType;
    if (node.assignment.kind === ASTNodeKind.TRY_OP) {
      const slot = emitTryOpToSlot(node.assignment, fnLines);
      slotPtr = slot.ptr;
      slotType = slot.type;
    } else {
      const r = emitExpr(node.assignment, fnLines);
      slotType = node.assignment.resolvedType;
      slotPtr = freshTemp();
      const slotLlvmTy2 = llvmType(slotType);
      fnLines.push(
        `  ${slotPtr} = alloca ${slotLlvmTy2}, align ${alignOfStruct(slotType)}`,
      );
      fnLines.push(
        `  store ${slotLlvmTy2} ${r.val}, ptr ${slotPtr}`,
      );
    }

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

      symbols.set(name, fieldType);
      fnLines.push(`  %${name} = alloca ${llvmTy}, align ${align}`);
      fnLines.push(`  store ${llvmTy} ${valTmp}, ptr %${name}`);
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
    fnLines.push(`  store ${llvmType(initType)} ${initVal.val}, ptr %${node.initIdent}`);

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
    fnLines.push(`  store ${llvmType(stepType)} ${stepVal.val}, ptr %${node.stepIdent}`);
    fnLines.push(`  br label %${condLabel}`);

    fnLines.push(`${afterLabel}:`);
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
    if (blockOrNode.kind === ASTNodeKind.BLOCK) {
      blockOrNode.body.forEach((s) => emitStatement(s, fnLines, ctx));
    } else {
      emitStatement(blockOrNode, fnLines, ctx);
    }
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
    symbols = new Map();

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
      if (ty.kind === typeKinds.ref) {
        fnLines.push(`  %${p.name} = alloca ptr, align 8`);
        fnLines.push(`  store ptr %${p.name}.arg, ptr %${p.name}`);
      } else {
        const llvmTy = llvmType(ty);
        const align = effectiveAlign(ty, p.resolvedKindApplication);
        fnLines.push(`  %${p.name} = alloca ${llvmTy}, align ${align}`);
        fnLines.push(`  store ${llvmTy} %${p.name}.arg, ptr %${p.name}`);
      }
      symbols.set(p.name, ty);
    }

    const ctx = { fnName: methodDecl.name, returnType };
    methodDecl.body.body.forEach((s) => emitStatement(s, fnLines, ctx));

    if (isVoidReturn(returnType)) {
      const last = fnLines[fnLines.length - 1].trim();
      if (!last.startsWith("ret")) fnLines.push("  ret void");
    }
    fnLines.push("}");
    hoistAllocasToEntry(fnLines);
    lines.push(...fnLines);
  }

  // **** function codegen *********
  function emitFunction(node, forceName = null) {
    tempCounter = 0;
    labelCounter = 0;
    symbols = new Map();

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
      const llvmTy = llvmType(ty);
      symbols.set(p.name, ty);
      const align = effectiveAlign(ty, p.resolvedKindApplication);
      fnLines.push(`  %${p.name} = alloca ${llvmTy}, align ${align}`);
      fnLines.push(`  store ${llvmTy} %${p.name}.arg, ptr %${p.name}`);
    }

    const ctx = { fnName: node.name, returnType };
    node.body.body.forEach((s) => emitStatement(s, fnLines, ctx));

    if (isVoidReturn(returnType)) {
      const last = fnLines[fnLines.length - 1].trim();
      if (!last.startsWith("ret")) {
        if (inMainFn) fnLines.push("  call void @yoop_runtime_shutdown()");
        fnLines.push("  ret void");
      }
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
        for (const ext of decl.decls) {
          if (ext.kind !== ASTNodeKind.EXTERN_FUNCTION_DECL) continue;
          externFnNames.add(ext.name);
          functionSigs.set(ext.name, {
            params: ext.params.map((p) => p.resolvedType),
            returnType: ext.resolvedType,
            variadic: ext.variadic,
          });
        }
      }
    }
    currentExternNames = externFnNames;

    // second pass: emit extern declarations from EXTERN_BLOCKs, then legacy auto-detect
    for (const decl of node.body) {
      if (decl.kind !== ASTNodeKind.EXTERN_BLOCK) continue;
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
    // Runtime ABI declares — emitted unconditionally so codegen-injected
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
      }
      // TRAIT_DECL: no codegen — traits are compile-time only
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
// Only collects string callees — object callees (namespace calls) are handled
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
    for (const val of Object.values(n)) {
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === "object" && val.kind) walk(val);
    }
  }
  walk(node);
  return found;
}

// True for both VoidType() and PrimType("void") — the typechecker emits the
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
// payloads. Mirrors `alignOf` — only uses natural sizes and assumes packed
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
  if (t.kind === typeKinds.enum) {
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
  if (t.kind === typeKinds.enum) {
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
  return 8;
}

function roundUp(x, a) {
  return Math.floor((x + a - 1) / a) * a;
}

// ** binary op resolution ****************************

// LLVM docs: https://llvm.org/docs/LangRef.html
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

function binaryInstruction(op, opType) {
  const useFloat = opType.kind === typeKinds.prim && isFloatPrim(opType.name);
  const map = useFloat ? FLOAT_OP_MAP : INT_OP_MAP;
  const instr = map[op];
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
  }

  for (const mod of modules) {
    // Collect link flags from EXTERN_BLOCKs
    for (const decl of mod.ast.body) {
      if (decl.kind === ASTNodeKind.EXTERN_BLOCK && decl.source.kind === "library") {
        linkFlags.add(decl.source.value);
      }
    }

    // Run single-module codegen with this module's id set
    const ir = codegenModule(mod, emittedStructs, emittedArrayTypes, programState);
    allStructDefs.push(...ir.structDefs);
    allGlobals.push(...ir.globals);
    for (const e of ir.externs) allExterns.add(e);
    allLines.push(...ir.lines);
  }

  const parts = [
    ...allStructDefs,
    allStructDefs.length ? "" : null,
    ...allGlobals,
    allGlobals.length ? "" : null,
    ...[...allExterns],
    allExterns.size ? "" : null,
    ...allLines,
  ].filter((l) => l !== null);

  return { ir: parts.join("\n"), linkFlags: [...linkFlags] };
}

// Codegen a single module, returning { structDefs, globals, externs, lines }.
// emittedStructs and emittedArrayTypes are shared across modules to deduplicate type defs.
function codegenModule(mod, emittedStructs, emittedArrayTypes, programState) {
  return codegenWithModuleId(mod.ast, mod.id, emittedStructs, emittedArrayTypes, programState);
}

// Phase 7.1: helper for codegenProgram — true iff a struct's fields contain
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
function cloneAstWithSubstitution(node, sub, registry = null) {
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
      registry.funcInstancesByDecl &&
      [...registry.funcInstancesByDecl.values()].flat().find(
        (i) => i.declId === oldInst.declId,
      )?.ast?.genericDecl;
    if (decl && oldInst.argTypes.some((t) => t?.kind === typeKinds.typeParam)) {
      const newArgs = oldInst.argTypes.map((t) => substituteTypeParams(t, sub));
      const newInst = instantiateFunc(registry, decl, newArgs);
      if (newInst) out.genericInstantiation = newInst;
    }
  }
  // Phase 7.2: rewrite a bound-method call into a normal struct-method call
  // once the receiver's TypeParamType has been substituted with a concrete
  // struct. The bound check at instantiation guarantees the impl exists.
  if (
    out.kind === ASTNodeKind.CALL_EXPRESSION &&
    out.boundMethod
  ) {
    const firstArg = out.args?.[0];
    let recvType = firstArg?.resolvedType;
    if (recvType?.kind === typeKinds.ref) recvType = recvType.inner;
    if (!recvType || recvType.kind !== typeKinds.struct) {
      // Receiver is still abstract — keep the boundMethod tag. This branch is
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

function codegenWithModuleId(ast, moduleId, emittedStructs, emittedArrayTypes = new Set(), programState = null) {
  const lines = [];
  const globals = [];
  const structDefs = [];
  let strConstCounter = 0;
  let tempCounter = 0;
  let labelCounter = 0;
  const functionSigs = new Map();
  let symbols = new Map();
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

  let currentReturnType = null;
  let inMainFn = false;

  // For now, emit struct defs using mangled names. Phase 7.1: generic type
  // decls (with typeParams) have no resolvedType — their instantiations are
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
    // Phase 7.5: emit enum struct + per-variant payload structs.
    //   %enum.<mod>__<E> = type { i32, [P x i8] }     (tag + payload bytes)
    //   %enumv.<mod>__<E>__<V> = type { ... fields ... }  (per-variant payload)
    if (d.kind === ASTNodeKind.ENUM_DECL && d.resolvedType) {
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
          const variantLlvm = `%enumv.${enumId}__${v.name}`;
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
  }

  // Collect C-exported function names — these are defined with unmangled symbols.
  const cExportNames = new Set();
  for (const decl of ast.body) {
    if (decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL) cExportNames.add(decl.fn.name);
  }

  // Collect extern function names and emit declares
  const externFnNames = new Set();
  for (const decl of ast.body) {
    if (decl.kind !== ASTNodeKind.EXTERN_BLOCK) continue;
    for (const ext of decl.decls) {
      if (ext.kind !== ASTNodeKind.EXTERN_FUNCTION_DECL) continue;
      externFnNames.add(ext.name);
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
  // Runtime ABI declares — emitted in every module so the dedup pass folds
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

  // Collect function sigs. Phase 7.1: skip generic decls — their
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
      // "main" is the C entry point — never mangle it.
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
    }
    // TRAIT_DECL: no codegen — traits are compile-time only
  }

  // Phase 7.1: emit one function per generic instantiation owned by this
  // module (registry tracks each instance's source module).
  if (programState?.registry) {
    for (const [_declId, instances] of programState.registry.funcInstancesByDecl) {
      for (const inst of instances) {
        if (inst.moduleId !== moduleId) continue;
        if (inst.emitted) continue;
        // Phase 7.2: skip "open" instances where some argType is still a
        // TypeParamType (came from a generic-calls-generic site). They only
        // exist in the registry as caching artifacts — the concrete instances
        // produced when the outer generic is monomorphized are what get IR.
        if (inst.argTypes.some((t) => t?.kind === typeKinds.typeParam)) continue;
        inst.emitted = true;
        emitGenericFuncInstance(inst);
      }
    }
  }

  return { structDefs, globals, externs: new Set(lines.filter(l => l.startsWith("declare"))), lines: lines.filter(l => !l.startsWith("declare")) };

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

  function emitFn(node, symName) {
    tempCounter = 0;
    labelCounter = 0;
    symbols = new Map();
    bindingDeclTable = new Map();
    currentReturnType = node.resolvedType;
    const prevInMain = inMainFn;
    inMainFn = symName === "main";
    const params = node.params ?? [];
    const llvmRet = llvmType(node.resolvedType);
    const paramSig = params.map((p) => `${llvmType(p.resolvedType)} %${p.name}.arg`).join(", ");
    const fnLines = [`define ${llvmRet} @${symName}(${paramSig}) {`, "entry:"];
    if (inMainFn) fnLines.push("  call void @yoop_runtime_init()");
    for (const p of params) {
      const ty = p.resolvedType;
      const llvmTy = llvmType(ty);
      symbols.set(p.name, ty);
      const al = effectiveAlign(ty, p.resolvedKindApplication);
      fnLines.push(`  %${p.name} = alloca ${llvmTy}, align ${al}`);
      fnLines.push(`  store ${llvmTy} %${p.name}.arg, ptr %${p.name}`);
    }
    const ctx = { fnName: symName, returnType: node.resolvedType };
    node.body.body.forEach((s) => emitStmt(s, fnLines, ctx));
    emitImplicitCleanups(node.body, fnLines);
    if (isVoidReturn(node.resolvedType)) {
      const last = fnLines[fnLines.length - 1].trim();
      if (!last.startsWith("ret")) {
        if (inMainFn) fnLines.push("  call void @yoop_runtime_shutdown()");
        fnLines.push("  ret void");
      }
    }
    fnLines.push("}");
    hoistAllocasToEntry(fnLines);
    lines.push(...fnLines);
    inMainFn = prevInMain;
  }

  function emitMethodFn(methodDecl, structType) {
    // Phase 7.4: one impl body can satisfy multiple traits — emit one define
    // per trait, all sharing the same body.
    const traits = methodDecl.implementsTraits ?? [];
    for (const traitName of traits) {
      emitMethodFnOnce(methodDecl, structType, traitName);
    }
  }

  function emitMethodFnOnce(methodDecl, structType, traitName) {
    tempCounter = 0;
    labelCounter = 0;
    symbols = new Map();
    bindingDeclTable = new Map();
    currentReturnType = methodDecl.resolvedFuncType.returnType;

    const returnType = methodDecl.resolvedFuncType.returnType;
    const params = methodDecl.params;
    const llvmRet = llvmType(returnType);

    const paramSig = params.map((p) => `${llvmType(p.resolvedType)} %${p.name}.arg`).join(", ");
    const mangled = mangleTraitMethod(structType, traitName, methodDecl.name);
    const fnLines = [`define ${llvmRet} @${mangled}(${paramSig}) {`, "entry:"];

    for (const p of params) {
      const ty = p.resolvedType;
      if (ty.kind === typeKinds.ref) {
        fnLines.push(`  %${p.name} = alloca ptr, align 8`);
        fnLines.push(`  store ptr %${p.name}.arg, ptr %${p.name}`);
      } else {
        const llvmTy = llvmType(ty);
        const al = effectiveAlign(ty, p.resolvedKindApplication);
        fnLines.push(`  %${p.name} = alloca ${llvmTy}, align ${al}`);
        fnLines.push(`  store ${llvmTy} %${p.name}.arg, ptr %${p.name}`);
      }
      symbols.set(p.name, ty);
    }

    const ctx = { fnName: methodDecl.name, returnType };
    methodDecl.body.body.forEach((s) => emitStmt(s, fnLines, ctx));
    emitImplicitCleanups(methodDecl.body, fnLines);

    if (isVoidReturn(returnType)) {
      const last = fnLines[fnLines.length - 1].trim();
      if (!last.startsWith("ret")) fnLines.push("  ret void");
    }
    fnLines.push("}");
    hoistAllocasToEntry(fnLines);
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
      // Imported task fn — out of 6.3 scope; reject at codegen.
      throw new Error(`codegen: cross-module task calls not supported in phase 6.3`);
    }
    return taskFnTable.has(callExpr.callee) ? callExpr.callee : null;
  }

  function calleeSymbol(node) {
    // Phase 7.1: generic-function call — use the instantiation's mangled name.
    if (node.genericInstantiation) {
      const inst = node.genericInstantiation;
      return mangle(inst.moduleId, inst.mangledName);
    }
    if (node.calleeModuleId) return mangle(node.calleeModuleId, node.calleeExportName);
    if (externFnNames.has(node.callee) || cExportNames.has(node.callee)) return node.callee;
    return mangle(moduleId, node.callee);
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
        const yoopType = symbols.get(node.name);
        if (!yoopType) throw new Error(`codegen: unknown identifier "${node.name}"`);
        if (node.autoDeref) {
          const innerType = yoopType.inner;
          const ptrTmp = freshTemp();
          fnLines.push(`  ${ptrTmp} = load ptr, ptr %${node.name}`);
          const valTmp = freshTemp();
          fnLines.push(`  ${valTmp} = load ${llvmType(innerType)}, ptr ${ptrTmp}`);
          return { val: valTmp, yoopType: innerType };
        }
        const llvmTy = llvmType(yoopType);
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = load ${llvmTy}, ptr %${node.name}`);
        return { val: tmp, yoopType };
      }
      case ASTNodeKind.REF_EXPRESSION: {
        if (node.operand.kind === ASTNodeKind.IDENT) {
          const operandType = symbols.get(node.operand.name);
          if (operandType?.kind === typeKinds.ref) {
            // ref of a ref binding (like `ref self`): forward the underlying pointer
            const ptrTmp = freshTemp();
            fnLines.push(`  ${ptrTmp} = load ptr, ptr %${node.operand.name}`);
            return { val: ptrTmp, yoopType: node.resolvedType };
          }
          return { val: `%${node.operand.name}`, yoopType: node.resolvedType };
        }
        // field access or index: use emitLval to get the address
        const lv = emitLval(node.operand, fnLines);
        return { val: lv.ptr, yoopType: node.resolvedType };
      }
      case ASTNodeKind.CALL_EXPRESSION: return emitCallExpr(node, fnLines);
      case ASTNodeKind.BINARY_EXPRESSION: {
        const l = emitExpr(node.left, fnLines);
        const r = emitExpr(node.right, fnLines);
        const resultType = node.resolvedType;
        const isCmp = ["eqeq","neq","lt","gt","lte","gte"].includes(node.op);
        const opType = isCmp ? l.yoopType : resultType;
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = ${binaryInstruction(node.op, opType)} ${llvmType(opType)} ${l.val}, ${r.val}`);
        return { val: tmp, yoopType: resultType };
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
          if (node.target.autoDerefWrite) {
            const innerType = lhsType.inner;
            const ptrTmp = freshTemp();
            fnLines.push(`  ${ptrTmp} = load ptr, ptr %${targetName}`);
            const rhs = emitExpr(node.value, fnLines);
            fnLines.push(`  store ${llvmType(innerType)} ${rhs.val}, ptr ${ptrTmp}`);
            return rhs;
          }
          const rhs = emitExpr(node.value, fnLines);
          fnLines.push(`  store ${llvmType(lhsType)} ${rhs.val}, ptr %${targetName}`);
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
        throw new Error(`codegen: unsupported assignment target kind "${node.target.kind}"`);
      }
      case ASTNodeKind.FIELD_ACCESS: {
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
        const lv = emitLval(node, fnLines);
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = load ${llvmType(lv.type)}, ptr ${lv.ptr}`);
        return { val: tmp, yoopType: lv.type };
      }
      case ASTNodeKind.ARRAY_LITERAL: {
        const arrayType = node.resolvedType;
        ensureArrayTypeDef(arrayType.elem);
        const elemLlvmTy = llvmType(arrayType.elem);
        const elemAlign = alignOf(elemLlvmTy);
        const n = node.elements.length;
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
      case ASTNodeKind.TRY_OP: {
        const slot = emitTrySlot(node, fnLines);
        const stripped = strippedTypeOf(node.operand.resolvedType);
        if (!stripped || stripped.kind === "strippedMulti") throw new Error("codegen: unsupported TRY_OP shape");
        if (stripped.kind === typeKinds.void) return { val: "void", yoopType: VoidType() };
        const valPtr = freshTemp();
        fnLines.push(`  ${valPtr} = getelementptr inbounds ${llvmType(slot.type)}, ptr ${slot.ptr}, i32 0, i32 0`);
        const val = freshTemp();
        fnLines.push(`  ${val} = load ${llvmType(stripped)}, ptr ${valPtr}`);
        return { val, yoopType: stripped };
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
        if (hasInterp) throw new Error("codegen: template literal with interpolation only supported inside printf");
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

  // Phase 7.5: emit `Enum.Variant { f1: v1, ... }` (or no-payload `Enum.V`).
  // Layout: alloca enum struct → store tag at field 0 → bitcast payload
  // bytes to the per-variant payload struct and GEP/store each field → load
  // the whole enum as the rvalue.
  function emitVariantConstructor(node, fnLines) {
    const enumType = node.resolvedEnumType;
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
      const variantLlvm = `%enumv.${enumId}__${variant.name}`;
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
    fnLines.push(`  ${handlePtr} = load ptr, ptr %${operand.name}`);
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
    // of every task struct (prefix layout is universal — see runtime-design.md).
    const operandType = symbols.get(operand.name);
    const resultType = operandType.resultType;
    const resultLlvm = llvmType(resultType);
    const resPtr = freshTemp();
    fnLines.push(`  ${resPtr} = getelementptr inbounds i8, ptr ${handlePtr}, i64 32`);
    const resVal = freshTemp();
    fnLines.push(`  ${resVal} = load ${resultLlvm}, ptr ${resPtr}`);
    return { val: resVal, yoopType: resultType };
  }

  function emitCallExpr(node, fnLines) {
    if (node.isCast) {
      const src = emitExpr(node.args[0], fnLines);
      const dstType = node.castTargetType;
      const opcode = castInstruction(src.yoopType, dstType);
      if (!opcode) return { val: src.val, yoopType: dstType };
      const tmp = freshTemp();
      fnLines.push(`  ${tmp} = ${opcode} ${llvmType(src.yoopType)} ${src.val} to ${llvmType(dstType)}`);
      return { val: tmp, yoopType: dstType };
    }
    if (node.callee && typeof node.callee === "object" && node.callee.namespaceLookup) {
      const { moduleId: nsModId, exportName } = node.callee.namespaceLookup;
      const mangledName = mangle(nsModId, exportName);
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

  function emitPrintfCallInner(node, fnLines) {
    if (node.args.length === 0) throw new Error("codegen: printf called with no arguments");
    let fmtSpec = "";
    const valueArgs = [];
    for (const argNode of node.args) {
      if (argNode.kind === ASTNodeKind.STRING_LITERAL) {
        fmtSpec += argNode.value.slice(1, -1);
      } else if (argNode.kind === ASTNodeKind.TEMPLATE_LITERAL) {
        for (const part of argNode.parts) {
          if (part.kind === ASTNodeKind.STRING_PART) { fmtSpec += part.value.replace(/%/g, "%%"); }
          else { const r = emitExpr(part.expr, fnLines); fmtSpec += printfSpec(r.yoopType); valueArgs.push(r); }
        }
      } else {
        const r = emitExpr(argNode, fnLines);
        fmtSpec += printfSpec(r.yoopType);
        valueArgs.push(r);
      }
    }
    const { name, byteLen } = emitRawStringGlobal(fmtSpec);
    const fmtTmp = freshTemp();
    fnLines.push(`  ${fmtTmp} = getelementptr inbounds [${byteLen} x i8], ptr ${name}, i32 0, i32 0`);
    const argList = ["ptr " + fmtTmp].concat(valueArgs.map((r) => {
      const promoted = promotedLlvmType(r.yoopType);
      const actual = llvmType(r.yoopType);
      if (promoted !== actual) {
        const tmp = freshTemp();
        if (isIntType(r.yoopType)) {
          const op = isUnsignedIntPrim(r.yoopType.name) ? "zext" : "sext";
          fnLines.push(`  ${tmp} = ${op} ${actual} ${r.val} to ${promoted}`);
        } else if (r.yoopType.kind === typeKinds.prim && r.yoopType.name === "bool") {
          fnLines.push(`  ${tmp} = zext ${actual} ${r.val} to ${promoted}`);
        } else if (isFloatType(r.yoopType)) {
          fnLines.push(`  ${tmp} = fpext ${actual} ${r.val} to ${promoted}`);
        } else {
          throw new Error(`codegen: don't know how to promote ${r.yoopType.kind}/${r.yoopType.name ?? ""} for varargs`);
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
        const t = symbols.get(node.name);
        if (!t) throw new Error(`codegen: unknown identifier "${node.name}"`);
        if (t.kind === typeKinds.ref) {
          // ref binding (e.g. self): load the actual pointer from its alloca slot
          const ptrTmp = freshTemp();
          fnLines.push(`  ${ptrTmp} = load ptr, ptr %${node.name}`);
          return { ptr: ptrTmp, type: t.inner };
        }
        return { ptr: `%${node.name}`, type: t };
      }
      case ASTNodeKind.FIELD_ACCESS: {
        const base = emitLval(node.object, fnLines);
        // Phase 7.5: union field access — every field overlaps at offset 0;
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
    // Phase 7.5: union literal — exactly one field gets stored, and it lives
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

  function emitTrySlot(node, fnLines) {
    const operandType = node.operand.resolvedType;
    const r = emitExpr(node.operand, fnLines);
    const slot = freshTemp();
    const operandLlvmTy = llvmType(operandType);
    fnLines.push(`  ${slot} = alloca ${operandLlvmTy}, align ${alignOfStruct(operandType)}`);
    fnLines.push(`  store ${operandLlvmTy} ${r.val}, ptr ${slot}`);
    const errIdx = operandType.fields.length - 1;
    const errPtr = freshTemp();
    fnLines.push(`  ${errPtr} = getelementptr inbounds ${operandLlvmTy}, ptr ${slot}, i32 0, i32 ${errIdx}`);
    const errStr = freshTemp();
    fnLines.push(`  ${errStr} = load ptr, ptr ${errPtr}`);
    const errLen = freshTemp();
    fnLines.push(`  ${errLen} = call i64 @strlen(ptr ${errStr})`);
    const failed = freshTemp();
    fnLines.push(`  ${failed} = icmp ne i64 ${errLen}, 0`);
    const failLabel = freshLabel("try_fail");
    const okLabel = freshLabel("try_ok");
    fnLines.push(`  br i1 ${failed}, label %${failLabel}, label %${okLabel}`);
    fnLines.push(`${failLabel}:`);
    // Phase 6.1: fire any pending cleanups in the failure branch before the
    // early `ret` produced by emitFailRet. errStr has already been captured
    // above, so it survives the cleanup calls.
    emitPendingCleanups(node, fnLines);
    emitFailRet(currentReturnType, errStr, fnLines);
    fnLines.push(`${okLabel}:`);
    return { ptr: slot, type: operandType };
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
      fnLines.push(`  ${handlePtr} = load ptr, ptr %${node.bindingName}`);
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
        fnLines.push(`  ${handlePtr} = load ptr, ptr %${node.bindingName}`);
      }
      fnLines.push(`  call void @yoop_task_release(ptr ${handlePtr})`);
      return;
    }
    if (node.kind === ASTNodeKind.TASK_RETAIN) {
      const handlePtr = freshTemp();
      fnLines.push(`  ${handlePtr} = load ptr, ptr %${node.bindingName}`);
      fnLines.push(`  call void @yoop_task_retain(ptr ${handlePtr})`);
      return;
    }
    // CLEANUP_CALL — mustCall dispatch.
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
    fnLines.push(`  call void @${mangled}(ptr %${node.bindingName})`);
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
      `  ${tmp} = getelementptr inbounds ${llvmType(enclosing)}, ptr %${node.bindingName}, i32 0, i32 ${idx}`,
    );
    return tmp;
  }

  // Phase 6.3: `joined h = task_call();` — stack-allocate the Task struct,
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
    symbols.set(node.name, node.resolvedType); // TaskType
    bindingDeclTable.set(node.name, { taskFnName: fnName });
    fnLines.push(`  %${node.name} = alloca ptr, align 8`);
    fnLines.push(`  store ptr ${handleSlot}, ptr %${node.name}`);
  }

  // Phase 6.3: `pooled h = task_call();` — heap-allocate a refcounted handle.
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
    symbols.set(node.name, node.resolvedType); // TaskType
    bindingDeclTable.set(node.name, { taskFnName: fnName });
    fnLines.push(`  %${node.name} = alloca ptr, align 8`);
    fnLines.push(`  store ptr ${heapPtr}, ptr %${node.name}`);
  }

  // Phase 6.4: `pooled h3 = h2;` — copy the existing handle pointer and
  // retain it. The scope-exit release on h3 then balances the retain.
  function emitPooledCopyBinding(node, fnLines) {
    const rhs = emitExpr(node.assignment, fnLines);
    symbols.set(node.name, node.resolvedType); // TaskType
    fnLines.push(`  %${node.name} = alloca ptr, align 8`);
    fnLines.push(`  store ptr ${rhs.val}, ptr %${node.name}`);
    fnLines.push(`  call void @yoop_task_retain(ptr ${rhs.val})`);
  }

  // Phase 6.3: immediate task call — `const x: T = compute(...);`. Allocate
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
    symbols.set(node.name, declType);
    const llvmTy = llvmType(declType);
    fnLines.push(`  %${node.name} = alloca ${llvmTy}, align ${alignOf(llvmTy)}`);
    const resPtr = freshTemp();
    fnLines.push(
      `  ${resPtr} = getelementptr inbounds ${meta.structName}, ptr ${handleSlot}, i32 0, i32 6`,
    );
    const resVal = freshTemp();
    fnLines.push(`  ${resVal} = load ${llvmTy}, ptr ${resPtr}`);
    fnLines.push(`  store ${llvmTy} ${resVal}, ptr %${node.name}`);
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

  function emitFailRet(retType, errStr, fnLines) {
    const retLlvmTy = llvmType(retType);
    const failSlot = freshTemp();
    fnLines.push(`  ${failSlot} = alloca ${retLlvmTy}, align ${alignOfStruct(retType)}`);
    fnLines.push(`  store ${retLlvmTy} zeroinitializer, ptr ${failSlot}`);
    const errIdx = retType.fields.length - 1;
    const failErrPtr = freshTemp();
    fnLines.push(`  ${failErrPtr} = getelementptr inbounds ${retLlvmTy}, ptr ${failSlot}, i32 0, i32 ${errIdx}`);
    fnLines.push(`  store ptr ${errStr}, ptr ${failErrPtr}`);
    const failVal = freshTemp();
    fnLines.push(`  ${failVal} = load ${retLlvmTy}, ptr ${failSlot}`);
    if (inMainFn) fnLines.push("  call void @yoop_runtime_shutdown()");
    fnLines.push(`  ret ${retLlvmTy} ${failVal}`);
  }

  function emitStmt(node, fnLines, ctx) {
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
        symbols.set(node.name, declType);
        const llvmTy = llvmType(declType);
        const al = effectiveAlign(declType, node.resolvedKindApplication);
        fnLines.push(`  %${node.name} = alloca ${llvmTy}, align ${al}`);
        if (node.assignment) {
          if (node.assignment.kind === ASTNodeKind.STRUCT_LITERAL && declType.kind === typeKinds.struct) {
            emitStructLitInto(node.assignment, `%${node.name}`, declType, fnLines);
          } else {
            const r = emitExpr(node.assignment, fnLines);
            fnLines.push(`  store ${llvmTy} ${r.val}, ptr %${node.name}`);
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
      case ASTNodeKind.BREAK_STATEMENT: fnLines.push(`  br label %${ctx.breakLabel}`); break;
      case ASTNodeKind.CONTINUE_STATEMENT: fnLines.push(`  br label %${ctx.continueLabel}`); break;
      case ASTNodeKind.BLOCK: node.body.forEach((s) => emitStmt(s, fnLines, ctx)); break;
      case ASTNodeKind.SWITCH_STATEMENT: emitSwitchStmt(node, fnLines, ctx); break;
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
    if (scrutType.kind === typeKinds.enum) {
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
          caseLines.push(`i32 ${pat.resolvedVariant.ordinal}, label %${armLabel}`);
        }
        // VARIANT_PATTERN { isWildcard: true } only appears as `case _:` which
        // the parser routed through the default-arm slot already (we don't
        // emit cases for it).
      }
    }

    const scrutTyForSwitch =
      scrutType.kind === typeKinds.enum ? "i32" : llvmType(scrutType);
    fnLines.push(
      `  switch ${scrutTyForSwitch} ${scrutVal.val}, label %${defaultLabel} [ ${caseLines.join(" ")} ]`,
    );

    for (const { label, arm } of armEntries) {
      fnLines.push(`${label}:`);
      // Bind any variant-pattern field bindings for this arm. We support
      // exactly one variant pattern per arm body (multi-pattern arms are
      // typecheck-restricted to literal-only homogeneous lists).
      const vp = arm.patterns.find(
        (p) => p.kind === ASTNodeKind.VARIANT_PATTERN && !p.isWildcard,
      );
      if (vp && vp.resolvedVariant.fields !== null && vp.fieldBindings) {
        const enumType = vp.resolvedEnumType;
        const enumLlvm = llvmType(enumType);
        const enumId = enumType.moduleId
          ? `${enumType.moduleId}__${enumType.name}`
          : enumType.name;
        const variantLlvm = `%enumv.${enumId}__${vp.variantName}`;
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
          symbols.set(fb.bindingName, fieldType);
          fnLines.push(
            `  %${fb.bindingName} = alloca ${fieldLlvmTy}, align ${sizeOfAlign(fieldType)}`,
          );
          fnLines.push(
            `  store ${fieldLlvmTy} ${valTmp}, ptr %${fb.bindingName}`,
          );
        }
      }
      const armCtx = { ...ctx, breakLabel: endLabel };
      emitBlockStmt(arm.body, fnLines, armCtx);
      if (!blockIsTerminated(fnLines)) {
        fnLines.push(`  br label %${endLabel}`);
      }
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
    let slotPtr, slotType;
    if (node.assignment.kind === ASTNodeKind.TRY_OP) {
      const slot = emitTrySlot(node.assignment, fnLines);
      slotPtr = slot.ptr; slotType = slot.type;
    } else {
      const r = emitExpr(node.assignment, fnLines);
      slotType = node.assignment.resolvedType;
      slotPtr = freshTemp();
      const slotLlvmTy = llvmType(slotType);
      fnLines.push(`  ${slotPtr} = alloca ${slotLlvmTy}, align ${alignOfStruct(slotType)}`);
      fnLines.push(`  store ${slotLlvmTy} ${r.val}, ptr ${slotPtr}`);
    }
    for (const name of node.names) {
      const idx = slotType.fields.findIndex((f) => f.name === name);
      const fieldType = slotType.fields[idx].type;
      const llvmTy = llvmType(fieldType);
      const al = fieldType.kind === typeKinds.struct ? alignOfStruct(fieldType) : alignOf(llvmTy);
      const gepTmp = freshTemp();
      fnLines.push(`  ${gepTmp} = getelementptr inbounds ${llvmType(slotType)}, ptr ${slotPtr}, i32 0, i32 ${idx}`);
      const valTmp = freshTemp();
      fnLines.push(`  ${valTmp} = load ${llvmTy}, ptr ${gepTmp}`);
      symbols.set(name, fieldType);
      fnLines.push(`  %${name} = alloca ${llvmTy}, align ${al}`);
      fnLines.push(`  store ${llvmTy} ${valTmp}, ptr %${name}`);
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
    fnLines.push(`  store ${llvmType(initType)} ${initVal.val}, ptr %${node.initIdent}`);

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
    fnLines.push(`  store ${llvmType(stepType)} ${stepVal.val}, ptr %${node.stepIdent}`);
    fnLines.push(`  br label %${condLabel}`);

    fnLines.push(`${afterLabel}:`);
  }

  function emitBlockStmt(blockOrNode, fnLines, ctx) {
    if (blockOrNode.kind === ASTNodeKind.BLOCK) {
      blockOrNode.body.forEach((s) => emitStmt(s, fnLines, ctx));
      emitImplicitCleanups(blockOrNode, fnLines);
    } else {
      emitStmt(blockOrNode, fnLines, ctx);
    }
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

export function compileEntry(entryAbsPath) {
  const { modules } = loadModuleGraph(entryAbsPath);
  const { errors, moduleEnv, programState } = typecheckProgram(modules);
  if (errors.length > 0) {
    throw new Error(
      `compileEntry: typecheck failed with ${errors.length} error(s):\n` +
        errors.map((e) => `  ${e.message}`).join("\n"),
    );
  }
  return codegenProgram(modules, moduleEnv, programState);
}
