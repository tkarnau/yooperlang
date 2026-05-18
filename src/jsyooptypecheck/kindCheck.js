// Phase 6.1 — flow-analysis pass for `mustCall fn beforeScopeEnd` obligations.
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

import { ASTNodeKind, ASTNode } from "../contracts.js";
import { pushError } from "./errors.js";

export function runKindCheck(fnOrMethodDecl, errors) {
  const body = fnOrMethodDecl.body;
  if (!body || body.kind !== ASTNodeKind.BLOCK) return;

  const stack = []; // array of frames; each frame: { obligations: [obligation] }

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

  function makeCleanupCall(o) {
    const node = new ASTNode(ASTNodeKind.CLEANUP_CALL, o.sourceLoc);
    node.bindingName = o.bindingName;
    node.methodName = o.methodName;
    node.structType = o.structType;
    node.moduleId = o.moduleId;
    return node;
  }

  function obligationFor(stmt) {
    const kt = stmt.resolvedKindType;
    if (!kt || kt.mustCall.length === 0) return null;
    const declaredType = stmt.resolvedType;
    if (!declaredType || declaredType.kind !== "struct") return null;
    const mc = kt.mustCall[0]; // 6.1: single mustCall
    return {
      bindingName: stmt.name,
      methodName: mc.methodName,
      structType: declaredType,
      moduleId: declaredType.moduleId,
      sourceLoc: stmt.sourceLoc,
    };
  }

  function walkBlock(block) {
    if (!block || block.kind !== ASTNodeKind.BLOCK) return;
    const frame = { obligations: [] };
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
        if (!obligation) return;
        if (stmt.trailingBlock) {
          // trailing-block form: the binding's obligation belongs to the
          // inner block's frame (the block itself has no other obligations
          // unless its statements declare more disposables).
          const innerFrame = { obligations: [obligation] };
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
      case ASTNodeKind.RETURN_STATEMENT:
        if (stmt.value) walkExpr(stmt.value);
        stmt.pendingCleanups = flattenStackReverse().map(makeCleanupCall);
        return;
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
        // Bounded to the enclosing block; cleanup falls through the block's
        // implicit cleanup chain. No early-exit cleanup tracking in 6.1.
        return;
      default:
        // Unhandled statement kinds (e.g. trait/type decls don't appear in
        // function bodies). Silently skip; the typechecker has already
        // flagged anything genuinely wrong.
        return;
    }
  }

  // An if-body or loop-body is parsed as either a BLOCK or, for `else if`,
  // an IF_STATEMENT. Dispatch on the kind so we open a frame only for blocks.
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
      // Failure branch exits the function: it must fire every active
      // obligation across all frames, innermost first.
      e.pendingCleanups = flattenStackReverse().map(makeCleanupCall);
      walkExpr(e.operand);
      return;
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

  walkBlock(body);

  // Errors collection is unused in 6.1 — kindCheck never rejects. The
  // parameter is preserved so the call site matches `validateFunction` and so
  // 6.2's escape/share checks can drop in without an API change.
  void errors;
}
