// Phase 6.1 — flow-analysis pass for `mustCall fn beforeScopeEnd` obligations.
// Phase 6.2 — escape-analysis extension: tracks `mustNotEscape scope` sentinels
//             and rejects escape via return, field store, or ref-pass to non-scoped param.
//
// Runs after Pass D has populated `resolvedType` and `resolvedKindType` on
// every binding node. Walks each function body, maintaining a stack of
// active obligations (one frame per lexical scope). For each kind-prefixed
// binding whose kind declares `mustCall`, the pass attaches synthetic
// CLEANUP_CALL nodes at every exit point in that binding's scope:
//
//   - block fall-through `}`        -> block.implicitCleanups
//   - explicit return                -> returnStatement.pendingCleanups
//   - early return via `?`           -> tryOp.pendingCleanups
//
// Codegen consumes these arrays in LIFO order. Bindings with a trailing
// `ownsBlock` form have a dedicated inner frame; implicit-block bindings
// share their enclosing scope's frame.
//
// Phase 6.2 sentinel tracking:
// Each frame also carries `escapeSentinels` — the names of scoped bindings/
// parameters whose escape must be detected. The walker checks three escape paths:
//   1. RETURN: expression names a sentinel whose resolved type is non-primitive
//   2. ASSIGNMENT to outer.field: outer's scopeDepth < sentinel's declScope
//   3. CALL with ref <sentinel>: callee param does not declare mustNotEscape

import { ASTNodeKind, ASTNode } from "../contracts.js";
import { pushError } from "./errors.js";
import { typeKinds } from "./types.js";

export function runKindCheck(fnOrMethodDecl, errors, funcDeclTable = null) {
  const body = fnOrMethodDecl.body;
  if (!body || body.kind !== ASTNodeKind.BLOCK) return;

  // Each frame: { obligations: [obligation], escapeSentinels: [sentinel] }
  // sentinel: { bindingName, kindName, declScope }
  const stack = [];

  function flattenStackReverse() {
    // Innermost frame first, and within each frame, latest binding first.
    const out = [];
    for (let i = stack.length - 1; i >= 0; i--) {
      const frame = stack[i];
      for (let j = frame.obligations.length - 1; j >= 0; j--) {
        out.push(frame.obligations[j]);
      }
    }
    return out;
  }

  function allActiveSentinels() {
    const out = [];
    for (let i = 0; i < stack.length; i++) {
      for (const s of stack[i].escapeSentinels) out.push(s);
    }
    return out;
  }

  function makeCleanupCall(o) {
    // Phase 6.3: obligation `type` selects the synthetic AST node kind.
    if (o.type === "autoWait") {
      const node = new ASTNode(ASTNodeKind.TASK_AUTO_WAIT, o.sourceLoc);
      node.bindingName = o.bindingName;
      node.taskResultType = o.taskResultType;
      return node;
    }
    if (o.type === "release") {
      const node = new ASTNode(ASTNodeKind.TASK_RELEASE, o.sourceLoc);
      node.bindingName = o.bindingName;
      return node;
    }
    const node = new ASTNode(ASTNodeKind.CLEANUP_CALL, o.sourceLoc);
    node.bindingName = o.bindingName;
    node.methodName = o.methodName;
    node.structType = o.structType;
    node.moduleId = o.moduleId;
    return node;
  }

  function obligationFor(stmt) {
    const kt = stmt.resolvedKindType;
    if (!kt) return null;
    // Phase 6.3: builtin kinds — joined / pooled — yield task-flavored obligations.
    if (kt.builtin && stmt.resolvedType?.kind === "task") {
      if (kt.autoJoin) {
        return {
          type: "autoWait",
          bindingName: stmt.name,
          taskResultType: stmt.resolvedType.resultType,
          sourceLoc: stmt.sourceLoc,
        };
      }
      if (kt.refcounted) {
        return {
          type: "release",
          bindingName: stmt.name,
          sourceLoc: stmt.sourceLoc,
        };
      }
    }
    if (kt.mustCall.length === 0) return null;
    const declaredType = stmt.resolvedType;
    if (!declaredType || declaredType.kind !== "struct") return null;
    const mc = kt.mustCall[0]; // 6.1: single mustCall
    return {
      type: "mustCall",
      bindingName: stmt.name,
      methodName: mc.methodName,
      structType: declaredType,
      moduleId: declaredType.moduleId,
      sourceLoc: stmt.sourceLoc,
    };
  }

  // Returns true if the resolved type is non-primitive (struct or ref to struct),
  // meaning a value of this type could meaningfully "hold onto" a resource.
  function isNonPrimitive(t) {
    if (!t) return false;
    if (t.kind === typeKinds.struct) return true;
    if (t.kind === typeKinds.ref) return true;
    return false;
  }

  // Walk an expression and return the first sentinel it directly names in an
  // escape context, or null if none. "An expression escapes a scoped sentinel
  // iff the expression's resolved type is non-primitive AND the expression
  // names the sentinel directly or includes it as a struct-literal field-value."
  function findEscapedSentinel(expr, sentinels) {
    if (!expr || typeof expr !== "object") return null;
    if (expr.kind === ASTNodeKind.IDENT) {
      const s = sentinels.find((s) => s.bindingName === expr.name);
      if (s && isNonPrimitive(expr.resolvedType)) return s;
      return null;
    }
    if (expr.kind === ASTNodeKind.REF_EXPRESSION) {
      const operand = expr.operand;
      if (operand?.kind === ASTNodeKind.IDENT) {
        const s = sentinels.find((s) => s.bindingName === operand.name);
        if (s) return s; // ref always escapes — the pointer itself carries the reference
      }
      return null;
    }
    if (expr.kind === ASTNodeKind.STRUCT_LITERAL) {
      for (const field of expr.fields ?? []) {
        const s = findEscapedSentinel(field.value, sentinels);
        if (s) return s;
      }
      return null;
    }
    return null;
  }

  function walkBlock(block) {
    if (!block || block.kind !== ASTNodeKind.BLOCK) return;
    const frame = { obligations: [], escapeSentinels: [] };
    stack.push(frame);
    for (const s of block.body) walkStatement(s);
    block.implicitCleanups = frame.obligations
      .slice()
      .reverse()
      .map(makeCleanupCall);
    stack.pop();
  }

  function walkStatement(stmt) {
    if (!stmt) return;
    switch (stmt.kind) {
      case ASTNodeKind.LET_DECL:
      case ASTNodeKind.CONST_DECL: {
        // First descend into the initializer for any nested ? operators that
        // still need pending-cleanup annotation under the current frame.
        if (stmt.assignment) walkExpr(stmt.assignment);
        const obligation = obligationFor(stmt);
        // Phase 6.2: register an escape sentinel if this binding has mustNotEscape.
        if (stmt.resolvedKindType?.mustNotEscape) {
          const sentinel = {
            bindingName: stmt.name,
            kindName: stmt.resolvedKindType.name,
            declScope: stack.length - 1,
            sourceLoc: stmt.sourceLoc,
          };
          stack[stack.length - 1].escapeSentinels.push(sentinel);
        }
        if (!obligation) return;
        if (stmt.trailingBlock) {
          // trailing-block form: the binding's obligation belongs to the
          // inner block's frame.
          const innerFrame = { obligations: [obligation], escapeSentinels: [] };
          stack.push(innerFrame);
          for (const s of stmt.trailingBlock.body) walkStatement(s);
          stmt.trailingBlock.implicitCleanups = innerFrame.obligations
            .slice()
            .reverse()
            .map(makeCleanupCall);
          stack.pop();
        } else {
          stack[stack.length - 1].obligations.push(obligation);
        }
        return;
      }
      case ASTNodeKind.RETURN_STATEMENT: {
        if (stmt.value) {
          // Phase 6.2: check if the return value escapes a sentinel.
          const sentinels = allActiveSentinels();
          if (sentinels.length > 0) {
            const escaped = findEscapedSentinel(stmt.value, sentinels);
            if (escaped) {
              pushError(errors, stmt,
                `binding '${escaped.bindingName}' has kind '${escaped.kindName}' which forbids escape via return`);
            }
          }
          walkExpr(stmt.value);
        }
        stmt.pendingCleanups = flattenStackReverse().map(makeCleanupCall);
        return;
      }
      case ASTNodeKind.EXPRESSION_STATEMENT:
        walkExpr(stmt.value);
        return;
      case ASTNodeKind.DISCARD_STATEMENT:
        walkExpr(stmt.value);
        return;
      case ASTNodeKind.DESTRUCTURE_DECL:
        if (stmt.assignment) walkExpr(stmt.assignment);
        return;
      case ASTNodeKind.IF_STATEMENT:
        walkExpr(stmt.expression);
        walkBranch(stmt.body);
        if (stmt.elseBody) walkBranch(stmt.elseBody);
        return;
      case ASTNodeKind.WHILE_STATEMENT:
        walkExpr(stmt.expression);
        walkBranch(stmt.body);
        return;
      case ASTNodeKind.FOR_LOOP:
        if (stmt.initExpr) walkExpr(stmt.initExpr);
        if (stmt.cond) walkExpr(stmt.cond);
        if (stmt.stepExpr) walkExpr(stmt.stepExpr);
        walkBranch(stmt.body);
        return;
      case ASTNodeKind.BLOCK:
        walkBlock(stmt);
        return;
      case ASTNodeKind.BREAK_STATEMENT:
      case ASTNodeKind.CONTINUE_STATEMENT:
        return;
      default:
        return;
    }
  }

  function walkBranch(node) {
    if (!node) return;
    if (node.kind === ASTNodeKind.BLOCK) {
      walkBlock(node);
    } else {
      walkStatement(node);
    }
  }

  function walkExpr(e) {
    if (!e || typeof e !== "object") return;

    if (e.kind === ASTNodeKind.TRY_OP) {
      e.pendingCleanups = flattenStackReverse().map(makeCleanupCall);
      walkExpr(e.operand);
      return;
    }

    // Phase 6.2: check ASSIGNMENT for field-store escapes.
    if (e.kind === ASTNodeKind.ASSIGNMENT) {
      checkAssignmentEscape(e);
      walkExpr(e.value);
      return;
    }

    // Phase 6.2: check CALL_EXPRESSION for ref-pass escapes.
    if (e.kind === ASTNodeKind.CALL_EXPRESSION) {
      checkCallEscape(e);
      // Fall through to generic recursion below to walk args.
    }

    // Generic recursion: visit any child object/array with a .kind field.
    for (const val of Object.values(e)) {
      if (Array.isArray(val)) {
        for (const v of val) walkExpr(v);
      } else if (val && typeof val === "object" && val.kind) {
        walkExpr(val);
      }
    }
  }

  // Phase 6.2: check `outer.field = expr` for escapes.
  function checkAssignmentEscape(assignNode) {
    const sentinels = allActiveSentinels();
    if (sentinels.length === 0) return;
    if (assignNode.target?.kind !== ASTNodeKind.FIELD_ACCESS) return;

    const obj = assignNode.target.object;
    if (!obj) return;

    // Get the scope depth of the object being assigned into.
    const outerDepth = obj.bindingScopeDepth ?? 0;

    // Walk the RHS for any sentinel IDENT.
    const escaped = findEscapedSentinel(assignNode.value, sentinels);
    if (!escaped) return;

    // If outer's depth is strictly less than the sentinel's declared depth, it's an escape.
    if (outerDepth < escaped.declScope) {
      pushError(errors, assignNode,
        `binding '${escaped.bindingName}' has kind '${escaped.kindName}' which forbids escape via store into longer-lived struct`);
    }
  }

  // Phase 6.2: check `f(ref a)` where `a` is a sentinel but `f`'s param is not scoped.
  function checkCallEscape(callNode) {
    const sentinels = allActiveSentinels();
    if (sentinels.length === 0) return;

    const args = callNode.args ?? [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      // Only check `ref <sentinel>` arguments.
      if (arg.kind !== ASTNodeKind.REF_EXPRESSION) continue;
      const operand = arg.operand;
      if (!operand || operand.kind !== ASTNodeKind.IDENT) continue;
      const sentinel = sentinels.find((s) => s.bindingName === operand.name);
      if (!sentinel) continue;

      // Look up the callee's parameter kind type.
      const callee = callNode.callee;
      if (typeof callee === "string" && funcDeclTable) {
        const calleeDecl = funcDeclTable.get(callee);
        if (calleeDecl) {
          const param = calleeDecl.params?.[i];
          if (param?.resolvedKindType?.mustNotEscape) continue; // callee promises not to escape
          const paramName = param?.name ?? `param${i}`;
          pushError(errors, arg,
            `cannot pass 'ref ${sentinel.bindingName}' to parameter '${paramName}' which does not declare 'scoped' or 'mustNotEscape scope' kind`);
          continue;
        }
      }
      // If we can't look up the callee (external, namespace call, etc.), conservatively allow.
      // Indirect/imported calls are not tracked in phase 6.2.
    }
  }

  // Phase 6.2: populate outer frame with escape sentinels from scoped parameters.
  const outerFrame = { obligations: [], escapeSentinels: [] };
  for (const p of fnOrMethodDecl.params ?? []) {
    const kt = p.resolvedKindType;
    if (kt?.mustNotEscape) {
      outerFrame.escapeSentinels.push({
        bindingName: p.name,
        kindName: kt.name,
        declScope: 0,
        sourceLoc: p.sourceLoc,
      });
    }
  }
  stack.push(outerFrame);
  walkBlock(body);
  stack.pop();
}
