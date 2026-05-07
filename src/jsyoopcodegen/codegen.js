// LLVM IR code generator — walks the AST and creates IR code

import { parse } from "../jsyooparser/parser.js";
import { typecheck } from "../jsyooptypecheck/typecheck.js";
import { ASTNodeKind } from "../contracts.js";

// yooperlang type names → LLVM IR type names
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
};

export function llvmType(yoopType) {
  return LLVM_TYPES[yoopType] ?? "ptr";
}

function isIntType(yoopType) {
  return /^(int|uint)(8|16|32|64)?$|^[ui]size$/.test(yoopType);
}

function isFloatType(yoopType) {
  return (
    yoopType === "float" || yoopType === "float32" || yoopType === "float64"
  );
}

// pick a printf format specifier for a yooper type
export function printfSpec(yoopType) {
  if (yoopType === "string") return "%s";
  if (yoopType === "bool") return "%d";
  if (isIntType(yoopType)) {
    if (
      yoopType === "int64" ||
      yoopType === "uint64" ||
      yoopType === "isize" ||
      yoopType === "usize"
    ) {
      return "%lld";
    }
    return "%d";
  }
  if (isFloatType(yoopType)) {
    if (yoopType === "float64") return "%lf";
    return "%f";
  }
  throw new Error(`printf: don't know how to format yooper type "${yoopType}"`);
}

// when a value is passed through C variadic printf, small ints/floats get
// promoted. report the LLVM type that the call site should use.
function promotedLlvmType(yoopType) {
  if (yoopType === "string") return "ptr";
  if (yoopType === "bool") return "i32";
  if (isIntType(yoopType)) {
    // int8/int16 → i32; int64 stays i64
    if (
      yoopType === "int64" ||
      yoopType === "uint64" ||
      yoopType === "isize" ||
      yoopType === "usize"
    ) {
      return "i64";
    }
    return "i32";
  }
  if (isFloatType(yoopType)) {
    return "double"; // float promotes to double through varargs
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

export function codegen(ast) {
  const lines = [];
  const globals = [];
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

  function llvmFloatConstant(jsNumber) {
    const buf = Buffer.alloc(8);
    // big endian hex encoded double (llvm docsthing),
    // all floats are double and get potentially truncated based on operand type later
    buf.writeDoubleBE(jsNumber, 0);
    return "0x" + buf.toString("hex").toUpperCase();
  }

  // ** expression codegen ************************************************
  // each emitExpr returns { val, yoopType } where val is an SSA name or
  // an integer literal, and yoopType is the canonical yooper type.

  function emitExpr(node, fnLines) {
    switch (node.kind) {
      case ASTNodeKind.INT_LITERAL: {
        return { val: String(node.value), yoopType: node.resolvedType.name ?? "int32" };
      }
      case ASTNodeKind.FLOAT_LITERAL: {
        return { val: llvmFloatConstant(node.value), yoopType: node.resolvedType.name ?? "float64" };
      }
      case ASTNodeKind.STRING_LITERAL: {
        const { name, byteLen } = emitQuotedStringGlobal(node.value);
        const tmp = freshTemp();
        fnLines.push(
          `  ${tmp} = getelementptr inbounds [${byteLen} x i8], ptr ${name}, i32 0, i32 0`,
        );
        return { val: tmp, yoopType: "string" };
      }

      case ASTNodeKind.IDENT: {
        const yoopType = symbols.get(node.name);
        if (!yoopType) {
          throw new Error(`codegen: unknown identifier "${node.name}"`);
        }
        const llvmTy = llvmType(yoopType);
        const tmp = freshTemp();
        fnLines.push(`  ${tmp} = load ${llvmTy}, ptr %${node.name}`);
        return { val: tmp, yoopType };
      }

      case ASTNodeKind.CALL_EXPRESSION: {
        return emitCall(node, fnLines);
      }

      case ASTNodeKind.BINARY_EXPRESSION: {
        const l = emitExpr(node.left, fnLines);
        const r = emitExpr(node.right, fnLines);
        const resultType = node.resolvedType.name;
        // for comparisons, the instruction operates on the operand type, not the result (bool)
        const isCmp = ["eqeq", "neq", "lt", "gt", "lte", "gte"].includes(node.op);
        const opType = isCmp ? l.yoopType : resultType;
        const llvmTy = llvmType(opType);
        const tmp = freshTemp();
        const instr = binaryInstruction(node.op, opType);
        fnLines.push(`  ${tmp} = ${instr} ${llvmTy} ${l.val}, ${r.val}`);
        return { val: tmp, yoopType: resultType };
      }

      case ASTNodeKind.ASSIGNMENT: {
        // §5(e) will add FIELD_ACCESS targets via emitLvalue + GEP+store.
        // today only IDENT targets are wired through.
        if (node.target.kind === ASTNodeKind.IDENT) {
          const targetName = node.target.name;
          const lhsType = symbols.get(targetName);
          if (!lhsType) {
            throw new Error(
              `codegen: assignment to unknown variable "${targetName}"`,
            );
          }
          const rhs = emitExpr(node.value, fnLines);
          fnLines.push(
            `  store ${llvmType(lhsType)} ${rhs.val}, ptr %${targetName}`,
          );
          return rhs;
        }
        throw new Error(
          `codegen: field assignment not yet implemented (target kind ${node.target.kind})`,
        );
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
    if (node.callee === "printf") {
      return emitPrintfCall(node, fnLines);
    }

    const argResults = node.args.map((a) => emitExpr(a, fnLines));
    const sig = functionSigs.get(node.callee);
    let argList;
    if (sig) {
      argList = sig.params
        .map((paramType, i) => `${llvmType(paramType)} ${argResults[i].val}`)
        .join(", ");
    } else {
      // unknown extern (e.g. C funcs other than printf)
      argList = argResults
        .map((r) => `${llvmType(r.yoopType)} ${r.val}`)
        .join(", ");
    }

    const retType = node.resolvedType.name;
    const llvmRet = llvmType(retType);
    if (llvmRet === "void") {
      fnLines.push(`  call void @${node.callee}(${argList})`);
      return { val: "void", yoopType: "void" };
    }
    const tmp = freshTemp();
    fnLines.push(`  ${tmp} = call ${llvmRet} @${node.callee}(${argList})`);
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
              const op = r.yoopType.startsWith("uint") ? "zext" : "sext";
              fnLines.push(`  ${tmp} = ${op} ${actual} ${r.val} to ${promoted}`);
            } else if (isFloatType(r.yoopType)) {
              fnLines.push(`  ${tmp} = fpext ${actual} ${r.val} to ${promoted}`);
            }
            return `${promoted} ${tmp}`;
          }
          return `${promoted} ${r.val}`;
        }),
      )
      .join(", ");

    const tmp = freshTemp();
    fnLines.push(`  ${tmp} = call i32 (ptr, ...) @printf(${argList})`);
    return { val: tmp, yoopType: "int32" };
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
    return { val: tmp, yoopType: "string" };
  }

  // ** statement codegen ***********************************************
  function emitStatement(node, fnLines, ctx) {
    switch (node.kind) {
      case ASTNodeKind.RETURN_STATEMENT: {
        if (
          !node.value ||
          (node.value.kind === ASTNodeKind.IDENT && node.value.name === "void")
        ) {
          fnLines.push("  ret void");
        } else {
          const r = emitExpr(node.value, fnLines);
          fnLines.push(`  ret ${llvmType(ctx.returnType)} ${r.val}`);
        }
        break;
      }

      case ASTNodeKind.LET_DECL:
      case ASTNodeKind.CONST_DECL: {
        const declType = node.resolvedType.name;
        symbols.set(node.name, declType);
        const llvmTy = llvmType(declType);
        fnLines.push(
          `  %${node.name} = alloca ${llvmTy}, align ${alignOf(llvmTy)}`,
        );
        if (node.assignment) {
          const r = emitExpr(node.assignment, fnLines);
          fnLines.push(`  store ${llvmTy} ${r.val}, ptr %${node.name}`);
        }
        break;
      }

      case ASTNodeKind.EXPRESSION_STATEMENT:
        emitExpr(node.value, fnLines);
        break;

      case ASTNodeKind.IF_STATEMENT:
        emitIf(node, fnLines, ctx);
        break;

      case ASTNodeKind.WHILE_STATEMENT:
        emitWhile(node, fnLines, ctx);
        break;

      case ASTNodeKind.BLOCK:
        node.body.forEach((s) => emitStatement(s, fnLines, ctx));
        break;

      default:
        throw new Error(`codegen: unhandled statement kind "${node.kind}"`);
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
    emitBlock(node.body, fnLines, ctx);
    fnLines.push(`  br label %${condLabel}`);
    fnLines.push(`${afterLabel}:`);
  }

  function emitBlock(blockOrNode, fnLines, ctx) {
    if (blockOrNode.kind === ASTNodeKind.BLOCK) {
      blockOrNode.body.forEach((s) => emitStatement(s, fnLines, ctx));
    } else {
      emitStatement(blockOrNode, fnLines, ctx);
    }
  }

  // **** function codegen *********
  function emitFunction(node) {
    tempCounter = 0;
    labelCounter = 0;
    symbols = new Map();

    const returnType = node.resolvedType.name;
    const params = node.params ?? [];
    const llvmRet = llvmType(returnType);

    const paramSig = params
      .map((p) => `${llvmType(p.resolvedType.name)} %${p.name}.arg`)
      .join(", ");

    const fnLines = [];
    fnLines.push(`define ${llvmRet} @${node.name}(${paramSig}) {`);
    fnLines.push("entry:");

    // copy params into stack slots so they're addressable like locals
    for (const p of params) {
      const ty = p.resolvedType.name;
      const llvmTy = llvmType(ty);
      symbols.set(p.name, ty);
      fnLines.push(`  %${p.name} = alloca ${llvmTy}, align ${alignOf(llvmTy)}`);
      fnLines.push(`  store ${llvmTy} %${p.name}.arg, ptr %${p.name}`);
    }

    const ctx = { fnName: node.name, returnType };
    node.body.body.forEach((s) => emitStatement(s, fnLines, ctx));

    if (returnType === "void") {
      const last = fnLines[fnLines.length - 1].trim();
      if (!last.startsWith("ret")) fnLines.push("  ret void");
    }

    fnLines.push("}");
    lines.push(...fnLines);
  }

  // ********* top-level entry ***************
  function emitProgram(node) {
    // first pass: collect user function signatures
    for (const decl of node.body) {
      if (decl.kind === ASTNodeKind.FUNCTION_DECL) {
        functionSigs.set(decl.name, {
          params: (decl.params ?? []).map((p) => p.resolvedType.name),
          returnType: decl.resolvedType.name,
        });
      }
    }

    // second pass: collect external calls (calls to names not defined here)
    const defined = new Set([...functionSigs.keys()]);
    const called = collectCalls(node, defined);
    for (const name of called) {
      const decl = externDecl(name);
      if (decl) lines.push(decl);
    }
    if (called.size > 0) lines.push("");

    // third pass: emit function bodies
    node.body.forEach((decl) => {
      if (decl.kind === ASTNodeKind.FUNCTION_DECL) emitFunction(decl);
    });
  }

  emitProgram(ast);

  const allLines = [...globals, globals.length ? "" : null, ...lines].filter(
    (l) => l !== null,
  );
  return allLines.join("\n");
}

// walk the AST and collect names of called functions not in `defined`.
function collectCalls(node, defined) {
  const called = new Set();
  function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.kind === ASTNodeKind.CALL_EXPRESSION && !defined.has(n.callee)) {
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
  };
  return known[name] ?? `declare i32 @${name}(...)`;
}

export function alignOf(llvmTy) {
  if (llvmTy === "i64" || llvmTy === "double") return 8;
  if (llvmTy === "i32" || llvmTy === "float") return 4;
  if (llvmTy === "i16") return 2;
  if (llvmTy === "i8" || llvmTy === "i1") return 1;
  return 8; // ptr
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
  const map = isFloatType(opType) ? FLOAT_OP_MAP : INT_OP_MAP;
  const instr = map[op];
  if (!instr)
    throw new Error(`codegen: unknown binary op "${op}" for type ${opType}`);
  return instr;
}

// convenience for tests: parse + typecheck + codegen in one call.
// returns the IR string. throws if typecheck reports errors.
export function compileSource(src) {
  const ast = parse(src);
  const { errors } = typecheck(ast);
  if (errors.length > 0) {
    throw new Error(
      `compileSource: typecheck failed with ${errors.length} error(s):\n` +
        errors.map((e) => `  ${e.message}`).join("\n"),
    );
  }
  return codegen(ast);
}
