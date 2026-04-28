// LLVM IR code generator — walks the AST and creates IR code

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

function llvmType(yoopType) {
  return LLVM_TYPES[yoopType] ?? "ptr";
}

// escapes a string literal (already includes surrounding quotes) into an LLVM
// byte array constant. returns { llvmStr, byteLen } where byteLen includes
// the null terminator.

// AI Generated help
function encodeStringConstant(quotedValue) {
  // Strip surrounding quotes
  const inner = quotedValue.slice(1, -1);
  // Process JS-style escape sequences into their raw characters
  let bytes = "";
  let byteLen = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      // Source-level escape sequence (e.g. the two chars \ and n)
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
        default:
          bytes += inner[i];
          byteLen++;
          break;
      }
    } else if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) > 0x7e) {
      // Raw control/non-ASCII character already in the string — encode it
      const hex = ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
      bytes += `\\${hex}`;
      byteLen++;
    } else {
      bytes += ch;
      byteLen++;
    }
  }
  bytes += "\\00"; // null terminator
  byteLen++;
  return { llvmStr: bytes, byteLen };
}

export function codegen(ast) {
  const lines = []; // output lines of IR
  const globals = []; // string constant globals, emitted before functions
  let strConstCounter = 0;
  let tempCounter = 0;

  function freshTemp() {
    return `%t${tempCounter++}`;
  }

  function freshStrGlobal() {
    return `@.str${strConstCounter++}`;
  }

  // emit a string constant global and return its name + byte length
  function emitStringGlobal(quotedValue) {
    const name = freshStrGlobal();
    const { llvmStr, byteLen } = encodeStringConstant(quotedValue);
    globals.push(
      `${name} = private unnamed_addr constant [${byteLen} x i8] c"${llvmStr}", align 1`,
    );
    return { name, byteLen };
  }

  // ** expression codegen ***********
  // each emitExpr returns the SSA - static single assignment - value name (or a literal) for the result.

  function emitExpr(node, fnLines) {
    switch (node.kind) {
      case "intLiteral":
        return String(node.value);

      case "strLiteral": {
        const { name, byteLen } = emitStringGlobal(node.value);
        const tmp = freshTemp();
        fnLines.push(
          // AI help plz - see llvm language reference https://llvm.org/docs/LangRef.html#getelementptr-instruction
          `  ${tmp} = getelementptr inbounds [${byteLen} x i8], ptr ${name}, i32 0, i32 0`,
        );
        return tmp;
      }

      case "ident":
        // load local varaibles here.
        // not sure what to do yet.
        return `%${node.name}`;

      case "callExpression": {
        const argVals = node.args.map((a) => emitExpr(a, fnLines));
        // we don't have a symbol table from v1 yet, but for hello world just use i32 and expand this func
        // from a small known-function table and fall back to i32.
        const retType = knownFunctionRetType(node.callee);
        const tmp = freshTemp();
        const argList = argVals
          .map((v) => inferArgType(v) + " " + v)
          .join(", ");
        if (retType === "void") {
          fnLines.push(`  call void @${node.callee}(${argList})`);
          return "void";
        }
        fnLines.push(`  ${tmp} = call ${retType} @${node.callee}(${argList})`);
        return tmp;
      }

      case "binaryExpression": {
        const l = emitExpr(node.left, fnLines);
        const r = emitExpr(node.right, fnLines);
        const tmp = freshTemp();
        const instr = binaryInstruction(node.op);

        // example
        // let res = left + right;
        // $t1 = add i32 left right
        fnLines.push(`  ${tmp} = ${instr} i32 ${l}, ${r}`);
        return tmp;

        // note interesting for SIMD: https://llvm.org/docs/LangRef.html#t-vector
      }

      case "assignment": {
        const val = emitExpr(node.value, fnLines);
        fnLines.push(`  store i32 ${val}, ptr %${node.name}`);
        return val;
      }

      default:
        throw new Error(`codegen: unhandled expression kind "${node.kind}"`);
    }
  }

  // ** statement codegen ***

  function emitStatement(node, fnLines) {
    switch (node.kind) {
      case "returnStatement": {
        if (
          !node.value ||
          (node.value.kind === "ident" && node.value.name === "void")
        ) {
          fnLines.push("  ret void");
        } else {
          const val = emitExpr(node.value, fnLines);
          const ty = inferValType(val);
          fnLines.push(`  ret ${ty} ${val}`);
        }
        break;
      }

      case "letDecl":
      case "constDecl": {
        const llvmTy = llvmType(node.type);
        fnLines.push(
          `  %${node.name} = alloca ${llvmTy}, align ${alignOf(llvmTy)}`,
        );
        if (node.assignment) {
          const val = emitExpr(node.assignment, fnLines);
          fnLines.push(`  store ${llvmTy} ${val}, ptr %${node.name}`);
        }
        break;
      }

      case "expressionStatement":
        emitExpr(node.value, fnLines);
        break;

      case "ifStatement":
        emitIf(node, fnLines);
        break;

      case "whileStatement":
        emitWhile(node, fnLines);
        break;

      case "block":
        node.body.forEach((s) => emitStatement(s, fnLines));
        break;

      default:
        throw new Error(`codegen: unhandled statement kind "${node.kind}"`);
    }
  }

  function emitIf(node, fnLines) {
    const condVal = emitExpr(node.expression, fnLines);
    const thenLabel = freshLabel("then");
    const elseLabel = freshLabel("else");
    const mergeLabel = freshLabel("merge");
    fnLines.push(
      `  br i1 ${condVal}, label %${thenLabel}, label %${elseLabel}`,
    );
    fnLines.push(`${thenLabel}:`);
    emitBlock(node.body, fnLines);
    fnLines.push(`  br label %${mergeLabel}`);
    fnLines.push(`${elseLabel}:`);
    if (node.elseBody) emitBlock(node.elseBody, fnLines);
    fnLines.push(`  br label %${mergeLabel}`);
    fnLines.push(`${mergeLabel}:`);
  }

  function emitWhile(node, fnLines) {
    const condLabel = freshLabel("while_cond");
    const bodyLabel = freshLabel("while_body");
    const afterLabel = freshLabel("while_after");
    // branch to the condition label
    fnLines.push(`  br label %${condLabel}`);
    fnLines.push(`${condLabel}:`);
    const condVal = emitExpr(node.expression, fnLines);
    fnLines.push(
      `  br i1 ${condVal}, label %${bodyLabel}, label %${afterLabel}`,
    );
    fnLines.push(`${bodyLabel}:`);
    emitBlock(node.body, fnLines);
    fnLines.push(`  br label %${condLabel}`);
    fnLines.push(`${afterLabel}:`);
  }

  function emitBlock(blockOrNode, fnLines) {
    if (blockOrNode.kind === "block") {
      blockOrNode.body.forEach((s) => emitStatement(s, fnLines));
    } else {
      emitStatement(blockOrNode, fnLines);
    }
  }

  let labelCounter = 0;
  function freshLabel(hint) {
    return `${hint}_${labelCounter++}`;
  }

  // **** function codegen *********

  function emitFunction(node) {
    tempCounter = 0; // reset per function
    labelCounter = 0;

    const retType = llvmType(node.returnType);
    const params = (node.params ?? [])
      .map((p) => `${llvmType(p.type)} %${p.name}`)
      .join(", ");

    const fnLines = [];
    // example - main function - node { name: 'main', params: [] }
    // outputs - define i32 @main() {
    fnLines.push(`define ${retType} @${node.name}(${params}) {`);
    fnLines.push("entry:");

    node.body.body.forEach((s) => emitStatement(s, fnLines));

    // implicit void return if needed
    if (retType === "void") {
      const last = fnLines[fnLines.length - 1].trim();
      if (!last.startsWith("ret")) fnLines.push("  ret void");
    }

    fnLines.push("}");
    lines.push(...fnLines);
  }

  // end function

  // ********* top-level entry ***************

  function emitProgram(node) {
    // emit extern declarations for any called functions not defined in this file.
    // we detect them lazily — collect defined names first, then diff.
    const defined = new Set(node.body.map((n) => n.name));
    const called = collectCalls(node, defined);

    // AI Helped - I don't understand this quite right.
    for (const name of called) {
      const decl = externDecl(name);
      if (decl) lines.push(decl);
    }
    if (called.size > 0) lines.push("");

    node.body.forEach((decl) => {
      if (decl.kind === "functionDecl") emitFunction(decl);
    });
  }

  emitProgram(ast);

  // prepend string globals
  const allLines = [...globals, globals.length ? "" : null, ...lines].filter(
    (l) => l !== null,
  );
  return allLines.join("\n");
}

// walk the AST and collect names of called functions not in `defined`.
// super naive right now.
function collectCalls(node, defined) {
  const called = new Set();
  function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.kind === "callExpression" && !defined.has(n.callee)) {
      called.add(n.callee);
    }
    for (const val of Object.values(n)) {
      // arrays of nodes
      if (Array.isArray(val)) val.forEach(walk);
      // subnodes
      else if (val && typeof val === "object" && val.kind) walk(val);
    }
  }
  walk(node);
  return called;
}

//  very basic returns an LLVM extern declaration for a few well-known C functions.
function externDecl(name) {
  const known = {
    printf: "declare i32 @printf(ptr, ...)",
    fprintf: "declare i32 @fprintf(ptr, ptr, ...)",
    puts: "declare i32 @puts(ptr)",
    exit: "declare void @exit(i32)",
  };

  return known[name] ?? `declare i32 @${name}(...)`;
}

// most things are just i32 for the time-being
function knownFunctionRetType(name) {
  const known = {
    printf: "i32",
    fprintf: "i32",
    puts: "i32",
    exit: "void",
  };
  return known[name] ?? "i32";
}

// very rough type inference for SSA values — refined once we have a symbol table.
function inferArgType(val) {
  if (val === "void") return "void";
  if (/^-?\d+$/.test(val)) return "i32";
  if (val.startsWith("%t")) return "ptr"; // assume pointer for call results for now
  return "ptr";
}

function inferValType(val) {
  if (/^-?\d+$/.test(val)) return "i32";
  return "i32";
}

function alignOf(llvmTy) {
  if (llvmTy === "i64" || llvmTy === "double") return 8;
  if (llvmTy === "i32" || llvmTy === "float") return 4;
  if (llvmTy === "i16") return 2;
  if (llvmTy === "i8" || llvmTy === "i1") return 1;
  return 8; // ptr
}


// look at llvm docs 
// like for add: https://llvm.org/docs/LangRef.html#add-instruction
// like for comparison: https://llvm.org/docs/LangRef.html#icmp-instruction
const OP_MAP = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "sdiv",
  "%": "srem",
  "==": "icmp eq",
  "!=": "icmp ne",
  "<": "icmp slt",
  ">": "icmp sgt",
  "<=": "icmp sle",
  ">=": "icmp sge",
  "&&": "and",
  "||": "or",
  "<<": "shl",
  ">>": "ashr",
};

function binaryInstruction(op) {
  const instr = OP_MAP[op];
  if (!instr) throw new Error(`codegen: unknown binary op "${op}"`);
  return instr;
}
