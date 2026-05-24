// Phase 11.B.0: typed bytecode lowering for the minimum slice —
// integer/float literals and arithmetic binary operators, wrapped in a
// synthesized `return <expr>` function so the interpreter has a real
// function to evaluate.
//
// Later sub-phases extend the per-node dispatcher with control flow,
// memory ops, calls, structs/arrays/refs, enums, tasks, and kind-flow
// cleanups. The dispatcher's shape is intentionally similar to
// `emitExpr` in codegen.js so future maintenance can read both in
// parallel.

import { ASTNodeKind } from "../contracts.js";
import { typeKinds, isFloatPrim } from "../jsyooptypecheck/types.js";
import { OP, instruction, bytecodeFunction } from "./bytecode.js";
import { ComptimeError } from "./diagnostics.js";
import { coerceNumeric } from "./values.js";

// Map parser BINARY_EXPRESSION `.op` strings (the inverse-token-tag
// names) onto opcode pairs (int variant, float variant). The variant
// chosen depends on the operand types resolved by the typechecker.
// `bool` always picks the `int` slot (logical/bool ops have a
// single opcode form that doesn't differ between int and float
// because the result is a bool either way).
const BIN_OP_MAP = {
  plus:    { int: OP.IADD,    float: OP.FADD },
  minus:   { int: OP.ISUB,    float: OP.FSUB },
  mult:    { int: OP.IMUL,    float: OP.FMUL },
  divide:  { int: OP.IDIV,    float: OP.FDIV },
  modulus: { int: OP.IREM,    float: null    },
  eqeq:    { int: OP.ICMP_EQ, float: OP.FCMP_EQ },
  neq:     { int: OP.ICMP_NE, float: OP.FCMP_NE },
  lt:      { int: OP.ICMP_LT, float: OP.FCMP_LT },
  lte:     { int: OP.ICMP_LE, float: OP.FCMP_LE },
  gt:      { int: OP.ICMP_GT, float: OP.FCMP_GT },
  gte:     { int: OP.ICMP_GE, float: OP.FCMP_GE },
  andand:  { int: OP.LAND,    float: null    }, // bool-typed both sides
  oror:    { int: OP.LOR,     float: null    },
  amp:     { int: OP.BIT_AND, float: null    },
  pipe:    { int: OP.BIT_OR,  float: null    },
  caret:   { int: OP.BIT_XOR, float: null    },
  lshift:  { int: OP.SHL,     float: null    },
  rshift:  { int: OP.SHR,     float: null    },
};

// Container we build up while lowering one logical "function" (in
// 11.B.0 always a synthesized wrapper around a single expression; in
// 11.B.7 also real user-defined functions invoked via CALL_DIRECT).
//
// `moduleConsts` is an optional Map<name, wrappedValue> the comptime
// pass threads through when lowering one module-init expression that
// might reference an earlier (already-folded) module-level const. An
// IDENT whose name is in the map lowers to a LITERAL of the referenced
// value.
//
// `fnResolver` is an optional callback `(calleeName, calleeModuleId,
// calleeExportName) → BytecodeFunction | null`. The lowerer invokes
// it at every CALL_EXPRESSION; null means "this call can't be folded"
// and surfaces as a ComptimeError (silent module-init fallback).
class LowerCtx {
  constructor(fnName, sourceLoc, moduleConsts, fnResolver) {
    this.fnName = fnName;
    this.sourceLoc = sourceLoc;
    this.instructions = [];
    this.registerTypes = [];
    this.moduleConsts = moduleConsts ?? new Map();
    this.fnResolver = fnResolver ?? null;
    this.labelCounter = 0;
  }
  allocReg(ty) {
    this.registerTypes.push(ty);
    return this.registerTypes.length - 1;
  }
  emit(inst) {
    this.instructions.push(inst);
  }
  // Mint a unique label name within this function. Used by IF /
  // WHILE / future control-flow lowering. Per-function counter so
  // labels stay stable across cached function bytecode.
  freshLabel(hint) {
    return `${hint}_${this.labelCounter++}`;
  }
}

// Lexical scope chain for IDENT resolution inside function bodies.
// Bindings hold a register index that the IDENT case looks up. Param
// regs live in the function's outermost scope; locals (LET_DECL,
// CONST_DECL) extend a child scope opened per BLOCK in later
// sub-phases. Today the chain only has the param scope.
class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.bindings = new Map();
  }
  declare(name, regIdx) {
    this.bindings.set(name, regIdx);
  }
  lookup(name) {
    if (this.bindings.has(name)) return this.bindings.get(name);
    return this.parent ? this.parent.lookup(name) : null;
  }
}

// Lower a single typecheck-validated expression into a BytecodeFunction
// whose body is `return <expr>`. Returns the function, or throws
// ComptimeError if the expression contains an unsupported node kind
// for this sub-phase.
export function lowerExpressionAsFunction(exprAst, returnType, opts = {}) {
  const ctx = new LowerCtx(
    opts.fnName ?? "<comptime-fold>",
    exprAst.sourceLoc ?? null,
    opts.moduleConsts,
    opts.fnResolver,
  );
  const scope = new Scope(null);
  const resultReg = lowerExpr(exprAst, ctx, scope);
  ctx.emit(
    instruction(OP.RET, {
      args: [resultReg],
      type: ctx.registerTypes[resultReg],
      sourceLoc: exprAst.sourceLoc,
    }),
  );
  return bytecodeFunction({
    name: ctx.fnName,
    params: [],
    returnType,
    registerTypes: ctx.registerTypes,
    instructions: ctx.instructions,
    sourceLoc: ctx.sourceLoc,
  });
}

// Lower a user-defined function decl into a BytecodeFunction. The
// param list seeds the function's first N registers and the outer
// scope binds param names to those registers. The body walks via the
// statement-level lowerer (today: just BLOCK + RETURN_STATEMENT;
// later sub-phases add LET_DECL, IF_STATEMENT, WHILE_STATEMENT, etc.).
export function lowerFunction(funcDecl, opts = {}) {
  const ctx = new LowerCtx(
    funcDecl.name,
    funcDecl.sourceLoc ?? null,
    opts.moduleConsts,
    opts.fnResolver,
  );
  const scope = new Scope(null);
  const paramTypes = [];
  for (const param of funcDecl.params ?? []) {
    const ty = param.resolvedType;
    paramTypes.push(ty);
    const reg = ctx.allocReg(ty);
    scope.declare(param.name, reg);
  }
  lowerStatement(funcDecl.body, ctx, scope);
  // Defensive: a function whose body lacks a return must trip a
  // ComptimeError rather than fall off the end of the instruction
  // stream silently. The typechecker should have caught missing
  // returns for non-void functions, but the interpreter's "fell off
  // the end" diagnostic is a sharper signal during dev.
  return bytecodeFunction({
    name: funcDecl.name,
    params: paramTypes,
    returnType: funcDecl.resolvedType ?? funcDecl.declaredReturnType ?? null,
    registerTypes: ctx.registerTypes,
    instructions: ctx.instructions,
    sourceLoc: funcDecl.sourceLoc ?? null,
  });
}

// Lower one statement. Coverage today: BLOCK, RETURN_STATEMENT,
// LET_DECL, CONST_DECL, ASSIGNMENT, EXPRESSION_STATEMENT,
// IF_STATEMENT, WHILE_STATEMENT. Statement kinds not on this list
// throw ComptimeError and surface as the silent module-init fallback.
function lowerStatement(node, ctx, scope) {
  switch (node.kind) {
    case ASTNodeKind.BLOCK: {
      const inner = new Scope(scope);
      for (const stmt of node.body ?? []) {
        lowerStatement(stmt, ctx, inner);
      }
      return;
    }
    case ASTNodeKind.RETURN_STATEMENT: {
      if (node.value) {
        const reg = lowerExpr(node.value, ctx, scope);
        ctx.emit(
          instruction(OP.RET, {
            args: [reg],
            type: ctx.registerTypes[reg],
            sourceLoc: node.sourceLoc,
          }),
        );
      } else {
        ctx.emit(instruction(OP.RET, { args: [], sourceLoc: node.sourceLoc }));
      }
      return;
    }
    case ASTNodeKind.LET_DECL:
    case ASTNodeKind.CONST_DECL: {
      // Allocate a stable "slot reg" the binding's IDENT references
      // resolve to. The init expression's result is MOVE'd into it so
      // a future ASSIGNMENT (for LET_DECL) can overwrite the same slot
      // without re-binding the IDENT to a new register.
      if (!node.assignment) {
        throw new ComptimeError(
          `comptime: let / const without initializer is not supported (declare and assign on one line)`,
          node.sourceLoc,
        );
      }
      const valReg = lowerExpr(node.assignment, ctx, scope);
      const ty = node.resolvedType ?? ctx.registerTypes[valReg];
      const slotReg = ctx.allocReg(ty);
      ctx.emit(
        instruction(OP.MOVE, {
          dst: slotReg,
          args: [valReg],
          type: ty,
          sourceLoc: node.sourceLoc,
        }),
      );
      scope.declare(node.name, slotReg);
      return;
    }
    case ASTNodeKind.EXPRESSION_STATEMENT: {
      // The parser wraps a bare `x = y;` as EXPRESSION_STATEMENT
      // { value: ASSIGNMENT }. The result reg of the lowered
      // expression is discarded — the side effect lives in MOVE / other
      // mutation instructions emitted during lowering.
      lowerExpr(node.value, ctx, scope);
      return;
    }
    case ASTNodeKind.IF_STATEMENT: {
      const condReg = lowerExpr(node.expression, ctx, scope);
      const thenLabel = ctx.freshLabel("if_then");
      const elseLabel = ctx.freshLabel("if_else");
      const endLabel  = ctx.freshLabel("if_end");
      ctx.emit(
        instruction(OP.BRCOND, {
          args: [condReg],
          immediate: { then: thenLabel, else: elseLabel },
          sourceLoc: node.sourceLoc,
        }),
      );
      ctx.emit(instruction(OP.LABEL, { immediate: thenLabel }));
      lowerStatement(node.body, ctx, scope);
      ctx.emit(
        instruction(OP.BR, {
          immediate: endLabel,
          sourceLoc: node.sourceLoc,
        }),
      );
      ctx.emit(instruction(OP.LABEL, { immediate: elseLabel }));
      if (node.elseBody) {
        lowerStatement(node.elseBody, ctx, scope);
      }
      ctx.emit(instruction(OP.LABEL, { immediate: endLabel }));
      return;
    }
    case ASTNodeKind.WHILE_STATEMENT: {
      const headLabel = ctx.freshLabel("while_head");
      const bodyLabel = ctx.freshLabel("while_body");
      const exitLabel = ctx.freshLabel("while_exit");
      ctx.emit(instruction(OP.LABEL, { immediate: headLabel }));
      const condReg = lowerExpr(node.expression, ctx, scope);
      ctx.emit(
        instruction(OP.BRCOND, {
          args: [condReg],
          immediate: { then: bodyLabel, else: exitLabel },
          sourceLoc: node.sourceLoc,
        }),
      );
      ctx.emit(instruction(OP.LABEL, { immediate: bodyLabel }));
      lowerStatement(node.body, ctx, scope);
      ctx.emit(
        instruction(OP.BR, {
          immediate: headLabel,
          sourceLoc: node.sourceLoc,
        }),
      );
      ctx.emit(instruction(OP.LABEL, { immediate: exitLabel }));
      return;
    }
    default:
      throw new ComptimeError(
        `comptime: statement kind '${node.kind}' is not supported yet`,
        node.sourceLoc,
      );
  }
}

// Walk one expression node, append the instructions needed to produce
// its result, and return the register holding that result.
function lowerExpr(node, ctx, scope) {
  switch (node.kind) {
    case ASTNodeKind.INT_LITERAL: {
      const ty = node.resolvedType;
      // Coerce via the same width-aware path the interpreter uses so
      // narrower-than-32-bit literals stay correctly truncated.
      const v = coerceNumeric(ty, node.value);
      const dst = ctx.allocReg(ty);
      ctx.emit(
        instruction(OP.LITERAL, {
          dst,
          type: ty,
          immediate: { ty, v },
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.FLOAT_LITERAL: {
      const ty = node.resolvedType;
      const dst = ctx.allocReg(ty);
      ctx.emit(
        instruction(OP.LITERAL, {
          dst,
          type: ty,
          immediate: { ty, v: Number(node.value) },
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.BOOL_LITERAL: {
      const ty = node.resolvedType;
      const dst = ctx.allocReg(ty);
      ctx.emit(
        instruction(OP.LITERAL, {
          dst,
          type: ty,
          immediate: { ty, v: !!node.value },
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.STRING_LITERAL: {
      // The parser stores STRING_LITERAL.value INCLUDING the surrounding
      // double-quotes; strip them here. Escape-sequence decoding happens
      // later when the interpreter formats the value or codegen emits the
      // bytes — at the comptime layer we keep the raw inner content.
      const ty = node.resolvedType;
      const raw = String(node.value);
      const inner =
        raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"'
          ? raw.slice(1, -1)
          : raw;
      const dst = ctx.allocReg(ty);
      ctx.emit(
        instruction(OP.LITERAL, {
          dst,
          type: ty,
          immediate: { ty, v: inner },
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.BINARY_EXPRESSION: {
      const opName = node.op;
      const opPair = BIN_OP_MAP[opName];
      if (!opPair) {
        throw new ComptimeError(
          `comptime: binary operator '${opName}' is not supported yet (lands in a later 11.B sub-phase)`,
          node.sourceLoc,
        );
      }
      const lhsReg = lowerExpr(node.left, ctx, scope);
      const rhsReg = lowerExpr(node.right, ctx, scope);
      const lhsTy = ctx.registerTypes[lhsReg];
      const useFloat =
        lhsTy.kind === typeKinds.prim && isFloatPrim(lhsTy.name);
      const op = useFloat ? opPair.float : opPair.int;
      if (op == null) {
        throw new ComptimeError(
          `comptime: operator '${opName}' is not defined for ${lhsTy.kind === typeKinds.prim ? lhsTy.name : "non-primitive"} types`,
          node.sourceLoc,
        );
      }
      const dst = ctx.allocReg(node.resolvedType);
      ctx.emit(
        instruction(op, {
          dst,
          args: [lhsReg, rhsReg],
          type: node.resolvedType,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.FIELD_ACCESS: {
      // `arr.len` desugars at typecheck time but reaches lowering as
      // FIELD_ACCESS over an array-typed receiver. Detect that and
      // emit ARRAY_LEN; everything else is a real struct field read.
      const receiverReg = lowerExpr(node.object, ctx, scope);
      const receiverTy = ctx.registerTypes[receiverReg];
      if (receiverTy.kind === typeKinds.array && node.field === "len") {
        const dst = ctx.allocReg(node.resolvedType);
        ctx.emit(
          instruction(OP.ARRAY_LEN, {
            dst,
            args: [receiverReg],
            type: node.resolvedType,
            sourceLoc: node.sourceLoc,
          }),
        );
        return dst;
      }
      const dst = ctx.allocReg(node.resolvedType);
      ctx.emit(
        instruction(OP.FIELD_LOAD, {
          dst,
          args: [receiverReg],
          type: node.resolvedType,
          immediate: node.field,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.INDEX_EXPRESSION: {
      const arrReg = lowerExpr(node.object, ctx, scope);
      const idxReg = lowerExpr(node.index, ctx, scope);
      const dst = ctx.allocReg(node.resolvedType);
      ctx.emit(
        instruction(OP.INDEX_LOAD, {
          dst,
          args: [arrReg, idxReg],
          type: node.resolvedType,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.IDENT: {
      // Resolution order: lexical scope (function params + locals)
      // first, then module-level folded consts. A miss in both is
      // unsupported and surfaces as a ComptimeError (silent
      // module-init fallback path).
      const scopeReg = scope ? scope.lookup(node.name) : null;
      if (scopeReg != null) return scopeReg;
      const folded = ctx.moduleConsts.get(node.name);
      if (folded == null) {
        throw new ComptimeError(
          `comptime: identifier '${node.name}' is not a comptime-known constant in this scope`,
          node.sourceLoc,
        );
      }
      const dst = ctx.allocReg(folded.ty);
      ctx.emit(
        instruction(OP.LITERAL, {
          dst,
          type: folded.ty,
          immediate: folded,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.ASSIGNMENT: {
      // Assignment is parsed as an expression (the AST distinguishes
      // it from LET_DECL — see parser line ~1933). Lower the RHS,
      // MOVE into the target's slot, return the value register so an
      // outer expression context can use the assigned value if it
      // wants (yoop allows `if ((x = f()) > 0) { ... }`).
      if (node.target?.kind !== ASTNodeKind.IDENT) {
        throw new ComptimeError(
          `comptime: assignment to non-identifier targets ('${node.target?.kind}') is not supported yet`,
          node.sourceLoc,
        );
      }
      const slotReg = scope ? scope.lookup(node.target.name) : null;
      if (slotReg == null) {
        throw new ComptimeError(
          `comptime: assignment to unknown binding '${node.target.name}'`,
          node.sourceLoc,
        );
      }
      const valReg = lowerExpr(node.value, ctx, scope);
      ctx.emit(
        instruction(OP.MOVE, {
          dst: slotReg,
          args: [valReg],
          type: ctx.registerTypes[slotReg],
          sourceLoc: node.sourceLoc,
        }),
      );
      return slotReg;
    }

    case ASTNodeKind.CALL_EXPRESSION: {
      if (!ctx.fnResolver) {
        throw new ComptimeError(
          `comptime: function call requires a function resolver`,
          node.sourceLoc,
        );
      }
      const calleeFn = ctx.fnResolver(
        node.callee,
        node.calleeModuleId ?? null,
        node.calleeExportName ?? null,
      );
      if (!calleeFn) {
        throw new ComptimeError(
          `comptime: function '${node.callee}' is not comptime-evaluable (extern, generic-unresolved, or in a not-yet-lowered module)`,
          node.sourceLoc,
        );
      }
      // Lower arguments left-to-right, collect their result regs in
      // declared-param order. The typechecker has already validated
      // arity + types.
      const argRegs = (node.args ?? []).map((a) => lowerExpr(a, ctx, scope));
      const dst = ctx.allocReg(node.resolvedType);
      ctx.emit(
        instruction(OP.CALL_DIRECT, {
          dst,
          args: argRegs,
          type: node.resolvedType,
          immediate: calleeFn,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.ARRAY_LITERAL: {
      const arrType = node.resolvedType;
      if (arrType?.kind !== typeKinds.array) {
        throw new ComptimeError(
          `comptime: array literal without a resolved ArrayType — typechecker bug?`,
          node.sourceLoc,
        );
      }
      const elemRegs = (node.elements ?? []).map((e) => lowerExpr(e, ctx, scope));
      const dst = ctx.allocReg(arrType);
      ctx.emit(
        instruction(OP.ARRAY_CONSTRUCT, {
          dst,
          args: elemRegs,
          type: arrType,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.STRUCT_LITERAL: {
      const structType = node.resolvedType;
      if (structType?.kind !== typeKinds.struct) {
        throw new ComptimeError(
          `comptime: struct literal without a resolved StructType — typechecker bug?`,
          node.sourceLoc,
        );
      }
      // Normalize source-order fields to declared-order. The
      // typechecker has already validated the literal matches the
      // type's field set; here we just look each up by name.
      const fieldByName = new Map();
      for (const f of node.fields) fieldByName.set(f.name, f);
      const orderedRegs = [];
      const orderedNames = [];
      for (const declared of structType.fields ?? []) {
        const litField = fieldByName.get(declared.name);
        if (!litField) {
          // Should not happen for a typechecked literal, but guard so
          // we surface the inconsistency as a comptime fallback rather
          // than a JS crash.
          throw new ComptimeError(
            `comptime: struct literal missing field "${declared.name}" (typechecker should have caught this)`,
            node.sourceLoc,
          );
        }
        orderedRegs.push(lowerExpr(litField.value, ctx, scope));
        orderedNames.push(declared.name);
      }
      const dst = ctx.allocReg(structType);
      ctx.emit(
        instruction(OP.STRUCT_CONSTRUCT, {
          dst,
          args: orderedRegs,
          type: structType,
          immediate: orderedNames,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    case ASTNodeKind.UNARY_EXPRESSION: {
      const reg = lowerExpr(node.operand, ctx, scope);
      const ty = ctx.registerTypes[reg];
      const useFloat = ty.kind === typeKinds.prim && isFloatPrim(ty.name);
      let op;
      switch (node.op) {
        case "minus":
          op = useFloat ? OP.FNEG : OP.INEG;
          break;
        case "not":
          op = OP.LNOT;
          break;
        case "bitnot":
          op = OP.BIT_NOT;
          break;
        default:
          throw new ComptimeError(
            `comptime: unary operator '${node.op}' is not supported yet`,
            node.sourceLoc,
          );
      }
      const dst = ctx.allocReg(node.resolvedType);
      ctx.emit(
        instruction(op, {
          dst,
          args: [reg],
          type: node.resolvedType,
          sourceLoc: node.sourceLoc,
        }),
      );
      return dst;
    }

    default:
      throw new ComptimeError(
        `comptime: AST node kind '${node.kind}' is not supported yet`,
        node.sourceLoc,
      );
  }
}
