// Flow-analysis pass for `mustCall fn beforeScopeEnd` obligations, plus an
// escape-analysis extension: tracks `mustNotEscape scope` sentinels and
// rejects escape via return, field store, or ref-pass to a non-scoped param.
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
// Sentinel tracking:
// Each frame also carries `escapeSentinels` - the names of scoped bindings/
// parameters whose escape must be detected. The walker checks three escape paths:
//   1. RETURN: expression names a sentinel whose resolved type is non-primitive
//   2. ASSIGNMENT to outer.field: outer's scopeDepth < sentinel's declScope
//   3. CALL with ref <sentinel>: callee param does not declare mustNotEscape

import { ASTNodeKind, ASTNode } from "../contracts.js";
import { pushError, pushWarning } from "./errors.js";
import { typeKinds } from "./types.js";
import { isRefcountedKind } from "./coreKinds.js";

export function runKindCheck(fnOrMethodDecl, errors, funcDeclTable = null, registry = null) {
  const body = fnOrMethodDecl.body;
  if (!body || body.kind !== ASTNodeKind.BLOCK) return;

  // When the struct on a binding is an open generic instantiation
  // (a `Box<T>` referenced inside a generic body, where T is still a
  // TypeParamType), its `implementsTraits` snapshot was taken in pass C.1
  // BEFORE pass C.3's `validateImplBlock` populated the genericDecl. Reach
  // through `genericInstance.declId` into the registry to read the up-to-date
  // trait list from the genericDecl. For closed instances and non-generic
  // structs, the struct's own field is authoritative.
  function effectiveImplementsTraits(rt) {
    if (!rt) return [];
    const direct = rt.implementsTraits ?? [];
    if (direct.length > 0) return direct;
    const declId = rt.genericInstance?.declId;
    if (declId != null && registry?.genericDeclById) {
      const gd = registry.genericDeclById.get(declId);
      if (gd?.implementsTraits) return gd.implementsTraits;
    }
    return direct;
  }

  // Each frame: { obligations: [obligation], escapeSentinels: [sentinel] }
  // sentinel: { bindingName, kindName, declScope }
  const stack = [];

  // Strict propagates: path-coverage satisfaction tracking. The
  // walker treats `o.satisfied` as a per-path mutable flag and uses
  // snapshot/restore around if/else branches to compute "satisfied on every
  // reaching path". After both arms of an if/else, the post-merge sat state
  // is the intersection of each arm's sat state. Branches that diverged
  // (returned, etc.) are excluded from the intersection - they don't reach
  // the merge point. Loops (while/for) discard inner sat changes since the
  // body may execute zero times. `walkDiverged` is set when control flow
  // exits the current branch via `return`; subsequent statements in the
  // block are skipped.
  let walkDiverged = false;

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
    // Obligation `type` selects the synthetic AST node kind.
    if (o.type === "autoWait") {
      const node = new ASTNode(ASTNodeKind.TASK_AUTO_WAIT, o.sourceLoc);
      node.bindingName = o.bindingName;
      node.taskResultType = o.taskResultType;
      return node;
    }
    if (o.type === "release") {
      const node = new ASTNode(ASTNodeKind.TASK_RELEASE, o.sourceLoc);
      node.bindingName = o.bindingName;
      node.fieldName = o.fieldName ?? null;
      node.structType = o.structType ?? null;
      return node;
    }
    const node = new ASTNode(ASTNodeKind.CLEANUP_CALL, o.sourceLoc);
    node.bindingName = o.bindingName;
    node.methodName = o.methodName;
    node.traitName = o.traitName ?? null;
    node.structType = o.structType;
    node.moduleId = o.moduleId;
    node.fieldName = o.fieldName ?? null;
    node.fieldStructType = o.fieldStructType ?? null;
    return node;
  }

  // Returns the array of obligations registered for this binding/param.
  // Strict propagates: obligations are emitted for any binding of a
  // type that propagates a `mustCall`/`refcounted` kind, regardless of whether
  // the binding declares the kind keyword. The keyword is an opt-IN to
  // auto-cleanup-at-scope-exit; bindings without it must satisfy the
  // obligation manually (by calling the cleanup method directly) or transfer
  // it to the caller via the enclosing function's `propagates<K>` clause.
  //
  // Every obligation carries:
  //   - `kindType`        - the K it represents.
  //   - `autoCleanup`     - true if the binding's kind keyword authorises
  //                         the compiler to inject the cleanup call at
  //                         scope exit; false if the obligation is advisory
  //                         and the user handles it (or not) themselves.
  //   - `satisfied`       - flipped by `walkExpr` when it sees a direct call
  //                         to the obligation's cleanup method on the
  //                         tracked binding; lets the compiler skip the
  //                         injected cleanup for an autoCleanup binding that
  //                         was already disposed by hand on every path.
  //   - `transferred`     - the binding was handed to the caller (it appears
  //                         in a `return` expression), so its cleanup is not
  //                         this function's problem. Set by
  //                         `markTransferredByValue`. The
  //                         unhandled-disposable warning reads it: that
  //                         warning needs to know the return-it-onward
  //                         case is fine.
  //   - `reported`        - dedupes the unhandled-disposable warning. One
  //                         binding can reach projectCleanups several times
  //                         (a return, then the enclosing block exit) and
  //                         should warn once.
  function obligationsFor(stmt) {
    const out = [];
    const kt = stmt.resolvedKindType;
    const rt = stmt.resolvedType;

    // Builtin kinds bound directly to Task<T> - joined / pooled.
    // These are always opt-in via keyword, so `autoCleanup` is true.
    if ((kt?.refcounted || kt?.mustCall?.length) && rt?.kind === "task") {
      if (kt.autoJoin) {
        out.push(mkObligation({
          type: "autoWait",
          bindingName: stmt.name,
          taskResultType: rt.resultType,
          kindType: kt,
          autoCleanup: true,
          sourceLoc: stmt.sourceLoc,
        }));
      } else if (kt.refcounted) {
        out.push(mkObligation({
          type: "release",
          bindingName: stmt.name,
          kindType: kt,
          autoCleanup: true,
          sourceLoc: stmt.sourceLoc,
        }));
      }
      return out;
    }

    // Variants can declare `propagates<K>` and carry the
    // same obligations as structs. The shape of `propagatedKinds`,
    // `implementsTraits`, and `methods` is identical, so the rest of
    // this function just works on either receiver. Variants don't
    // contribute field-carried obligations (no `fields` slot) but the
    // mustCall path covers the disposable-tree use case directly.
    if (rt?.kind !== "struct" && rt?.kind !== "variant") return out;

    // Build the set of kinds that produce obligations on this binding, with
    // each kind's `autoCleanup` flag:
    //   - any K in `rt.propagatedKinds` with mustCall/refcounted → tracked
    //     (autoCleanup defaults to false; flipped to true if the binding
    //     declares K via its kind keyword).
    //   - any K from the callee's `returnPropagatedKinds` (if the
    //     initializer is a direct call) → same treatment. Covers cases
    //     where a function propagates a kind the type itself doesn't.
    //   - the explicit `kt` (from the keyword), if it isn't builtin and has
    //     mustCall/refcounted clauses → tracked with autoCleanup=true.
    const kindMeta = new Map(); // kindType -> { autoCleanup: bool }
    const addKind = (propA, autoCleanup) => {
      const propK = propA?.kindType ?? propA;
      if (!propK) return;
      const hasObligation =
        (propK.mustCall?.length ?? 0) > 0 || propK.refcounted;
      if (!hasObligation) return;
      const existing = kindMeta.get(propK);
      if (existing) {
        if (autoCleanup) existing.autoCleanup = true;
      } else {
        kindMeta.set(propK, { autoCleanup });
      }
    };
    for (const propA of rt.propagatedKinds ?? []) addKind(propA, false);
    // Kinds the PRODUCER advertised on its return, as opposed to kinds the
    // binding's type merely carries. Only these warn - see `advertised` below.
    const advertised = new Set();
    if (
      stmt.assignment?.kind === ASTNodeKind.CALL_EXPRESSION &&
      typeof stmt.assignment.callee === "string" &&
      funcDeclTable
    ) {
      const calleeDecl = funcDeclTable.get(stmt.assignment.callee);
      for (const app of calleeDecl?.returnPropagatedKinds ?? []) {
        addKind(app, false);
        const k = app?.kindType ?? app;
        if (k) advertised.add(k);
      }
    }
    // The core-kind + Task case is handled above by the early return;
    // here we additionally flip autoCleanup=true when a builtin kind keyword
    // (e.g. `Task`) is applied to a struct binding whose propagatedKinds
    // includes the kind.
    if (kt) addKind(kt, true);

    const effectiveTraits = effectiveImplementsTraits(rt);
    for (const [K, meta] of kindMeta) {
      const requires = K.requires ?? [];
      const structImplsRequires = requires.every((reqT) =>
        effectiveTraits.some(
          (t) => t.name === reqT.name && (t.moduleId ?? null) === (reqT.moduleId ?? null),
        ),
      );
      if (structImplsRequires && (K.mustCall?.length ?? 0) > 0) {
        const mc = K.mustCall[0];
        out.push(mkObligation({
          type: "mustCall",
          bindingName: stmt.name,
          methodName: mc.methodName,
          // Cleanup-call mangling is trait-qualified.
          traitName: mc.traitType?.name,
          structType: rt,
          moduleId: rt.moduleId,
          kindType: K,
          advertised: advertised.has(K),
          autoCleanup: meta.autoCleanup,
          sourceLoc: stmt.sourceLoc,
        }));
        continue;
      }
      // Via propagation through fields. Also handles refcounted kinds (e.g.
      // `Task`) with no mustCall, where the obligation is a release on the
      // field.
      for (const f of rt.fields ?? []) {
        if (!fieldCarriesKind(f, K)) continue;
        if (K.refcounted) {
          out.push(mkObligation({
            type: "release",
            bindingName: stmt.name,
            fieldName: f.name,
            structType: rt,
            kindType: K,
            autoCleanup: meta.autoCleanup,
            sourceLoc: stmt.sourceLoc,
          }));
        } else if ((K.mustCall?.length ?? 0) > 0) {
          const mc = K.mustCall[0];
          out.push(mkObligation({
            type: "mustCall",
            bindingName: stmt.name,
            fieldName: f.name,
            methodName: mc.methodName,
            traitName: mc.traitType?.name,
            structType: rt,
            fieldStructType: f.type,
            moduleId: f.type?.moduleId,
            kindType: K,
            autoCleanup: meta.autoCleanup,
            sourceLoc: stmt.sourceLoc,
          }));
        }
      }
    }
    return out;
  }

  // Centralised obligation constructor that fills in the lifecycle flags.
  function mkObligation(o) {
    return {
      transferred: false,
      satisfied: false,
      reported: false,
      ...o,
    };
  }

  // Snapshot/restore/merge of `satisfied` flags across the live frame stack.
  // Used by walkStatement's IF/WHILE/FOR cases to compute path coverage.
  function snapshotSat() {
    const map = new Map();
    for (const frame of stack) {
      for (const o of frame.obligations) {
        map.set(o, o.satisfied);
      }
    }
    return map;
  }
  function restoreSat(snap) {
    for (const [o, v] of snap) {
      o.satisfied = v;
    }
  }
  // Intersection: an obligation is "satisfied" in the merged state iff it
  // was satisfied on every contributing path. Used when joining two branches
  // of an if/else at a merge point.
  function mergeSatIntersect(a, b) {
    const merged = new Map();
    const all = new Set([...a.keys(), ...b.keys()]);
    for (const o of all) {
      merged.set(o, (a.get(o) ?? false) && (b.get(o) ?? false));
    }
    return merged;
  }

  // Walk a branch and report whether it diverged (exited via return). The
  // outer `walkDiverged` is saved and restored so each branch is walked
  // independently.
  function walkBranchAndTrack(node) {
    const saved = walkDiverged;
    walkDiverged = false;
    walkBranch(node);
    const branchDiverged = walkDiverged;
    walkDiverged = saved;
    return branchDiverged;
  }

  // `propagates<K>` does not transfer an enforced obligation across a
  // return, so there is no return-site obligation-transfer machinery. The
  // `transferred` flag is set only by `markTransferredByValue`.

  // Convert a list of obligations into auto-cleanup nodes for codegen,
  // skipping any that are satisfied, transferred, or not autoCleanup.
  //
  // Obligations are ADVISORY, not enforced. A non-autoCleanup obligation that
  // reaches scope exit unhandled is NOT an error - the default is silent. Only a
  // binding that opted in via its kind keyword (`disposable`/`pooled`/`joined`/
  // Task -> autoCleanup) gets a cleanup call injected here. What to do with an
  // un-keyworded disposable is left entirely to the caller; avoiding double-free
  // is the `dispose` implementer's responsibility (idempotent dispose).
  function projectCleanups(obligations) {
    const out = [];
    for (const o of obligations) {
      if (o.satisfied) continue;
      // autoCleanup is decided BEFORE `transferred`. A keyword binding's
      // cleanup is injected here regardless; `transferred` exists only to
      // silence the advisory warning below, and letting it skip the
      // injection would change codegen and leak.
      if (o.autoCleanup) {
        out.push(makeCleanupCall(o));
        continue;
      }
      if (o.transferred) continue;   // handed to the caller: not our problem
      // A binding that advertises a cleanup obligation, did not opt into
      // auto-cleanup, was not disposed by hand, and is not handed to the
      // caller. Still not an ERROR - the ownership model is advisory and the
      // user may be managing it deliberately - but silence hides real leaks,
      // so it is a warning. Suppress it by taking the kind keyword
      // (`disposable x = ...`), disposing by hand, or returning the value.
      if (!o.reported && !fnOrMethodDecl.isDeriveGenerated) {
        o.reported = true;
        pushWarning(
          errors,
          o.sourceLoc ? { pos: o.sourceLoc.pos, line: o.sourceLoc.line, column: o.sourceLoc.column, length: o.sourceLoc.length } : undefined,
          `"${o.bindingName}" carries kind '${o.kindType?.name ?? "disposable"}' but nothing handles it - ` +
            `add the '${o.kindType?.name ?? "disposable"}' keyword to auto-clean it at scope exit, ` +
            `call its cleanup directly, or return it`,
          "unhandled-disposable",
        );
      }
    }
    return out;
  }

  // A BY-VALUE use hands the binding on - to the caller (`return x`), to
  // another function (`f(x)`), or into an aggregate (`{ field: x }`,
  // `vecPush(ref v, x)`). After that its cleanup is not this scope's business,
  // so it must not trip the unhandled-disposable warning.
  //
  // `ref x` is deliberately NOT a transfer: a borrow lends the value for the
  // duration of a call and hands it straight back. That distinction is the
  // whole reason the warning is usable - without it every arena/index idiom in
  // the tree (`vecGet` into a local, a local pushed into a Vec) looks like a
  // leak, and with it those go quiet while a binding only ever passed as
  // `ref x` and never disposed still gets flagged.
  //
  // This is a heuristic, not move analysis - the ownership model is advisory
  // by design. It errs toward silence: a missed leak is better than telling
  // someone to dispose a value they already handed away, which would be
  // advice that causes a double free.
  function markTransferredByValue(expr) {
    if (!expr || typeof expr !== "object") return;
    // A borrow, not a transfer. Stop here so the inner IDENT is not marked.
    if (expr.kind === ASTNodeKind.REF_EXPRESSION) return;
    if (expr.kind === ASTNodeKind.IDENT) {
      for (const o of flattenStackReverse()) {
        if (o.bindingName === expr.name) o.transferred = true;
      }
      return;
    }
    for (const key of Object.keys(expr)) {
      if (key === "resolvedType" || key === "sourceLoc") continue;
      const v = expr[key];
      if (Array.isArray(v)) {
        for (const item of v) markTransferredByValue(item);
      } else if (v && typeof v === "object" && typeof v.kind === "string") {
        markTransferredByValue(v);
      } else if (v && typeof v === "object" && v.value) {
        markTransferredByValue(v.value);
      }
    }
  }

  // Does a struct field carry the given kind?
  function fieldCarriesKind(field, kindType) {
    if (field.kindType === kindType) return true;
    if (isRefcountedKind(kindType) && field.type?.kind === "task") {
      return true;
    }
    if (
      field.type?.kind === "struct" &&
      field.type.propagatedKinds?.some((a) => (a.kindType ?? a) === kindType)
    ) {
      return true;
    }
    return false;
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
        if (s) return s; // ref always escapes - the pointer itself carries the reference
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
    for (const s of block.body) {
      if (walkDiverged) break;
      walkStatement(s);
    }
    block.implicitCleanups = projectCleanups(frame.obligations.slice().reverse());
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
        const obligations = obligationsFor(stmt);
        // Register an escape sentinel if this binding has mustNotEscape.
        if (stmt.resolvedKindType?.mustNotEscape) {
          const sentinel = {
            bindingName: stmt.name,
            kindName: stmt.resolvedKindType.name,
            declScope: stack.length - 1,
            sourceLoc: stmt.sourceLoc,
          };
          stack[stack.length - 1].escapeSentinels.push(sentinel);
        }
        if (obligations.length === 0) return;
        if (stmt.trailingBlock) {
          // trailing-block form: the binding's obligations belong to the
          // inner block's frame.
          const innerFrame = { obligations: [...obligations], escapeSentinels: [] };
          stack.push(innerFrame);
          for (const s of stmt.trailingBlock.body) walkStatement(s);
          stmt.trailingBlock.implicitCleanups = projectCleanups(
            innerFrame.obligations.slice().reverse(),
          );
          stack.pop();
        } else {
          for (const o of obligations) {
            stack[stack.length - 1].obligations.push(o);
          }
        }
        return;
      }
      case ASTNodeKind.RETURN_STATEMENT: {
        if (stmt.value) {
          // Check if the return value escapes a sentinel.
          const sentinels = allActiveSentinels();
          if (sentinels.length > 0) {
            const escaped = findEscapedSentinel(stmt.value, sentinels);
            if (escaped) {
              pushError(errors, stmt,
                `binding '${escaped.bindingName}' has kind '${escaped.kindName}' which forbids escape via return`);
            }
          }
          walkExpr(stmt.value);
          // Anything named in the returned expression is the caller's now, so
          // it must not trip the unhandled-disposable warning below.
          markTransferredByValue(stmt.value);
          // Returning a value that carries a propagating kind is fine and
          // needs no annotation. `propagates<K>` is an advisory producer-side
          // signal (surfaced by tooling/IDE), not a transfer contract, so
          // there is nothing to enforce or mark here.
          // The `mustNotEscape` escape check above still applies (that is the
          // separate `scoped` kind, which stays enforced).
        }
        // Project cleanups for every active obligation. Only kind-keyword
        // (autoCleanup) bindings get a CLEANUP_CALL injected here; un-keyworded
        // obligations are advisory and silently left to the user.
        stmt.pendingCleanups = projectCleanups(flattenStackReverse());
        walkDiverged = true;
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
      case ASTNodeKind.IF_STATEMENT: {
        walkExpr(stmt.expression);
        // Strict propagates: walk each arm independently from a
        // shared starting sat state, then merge at the join point. A manual
        // dispose call satisfies an outer-scope obligation only if it
        // appears on every path that reaches the merge.
        const base = snapshotSat();
        const thenDiverged = walkBranchAndTrack(stmt.body);
        const thenSnap = snapshotSat();
        restoreSat(base);
        if (stmt.elseBody) {
          const elseDiverged = walkBranchAndTrack(stmt.elseBody);
          const elseSnap = snapshotSat();
          if (thenDiverged && elseDiverged) {
            // Both arms exit via return - code after the if is unreachable.
            walkDiverged = true;
            restoreSat(base);
          } else if (thenDiverged) {
            // Only the else arm reaches the merge.
            restoreSat(elseSnap);
          } else if (elseDiverged) {
            // Only the then arm reaches the merge.
            restoreSat(thenSnap);
          } else {
            restoreSat(mergeSatIntersect(thenSnap, elseSnap));
          }
        } else {
          // No else: the no-branch (fall-through if cond false) path has
          // sat=base. If the then-arm diverged, that's the only reaching
          // path; otherwise intersect with base.
          if (thenDiverged) {
            restoreSat(base);
          } else {
            restoreSat(mergeSatIntersect(thenSnap, base));
          }
        }
        return;
      }
      case ASTNodeKind.WHILE_STATEMENT: {
        walkExpr(stmt.expression);
        // The body may execute zero times; nothing inside can be relied on
        // to satisfy an outer obligation.
        const base = snapshotSat();
        walkBranchAndTrack(stmt.body);
        restoreSat(base);
        return;
      }
      case ASTNodeKind.FOR_LOOP: {
        if (stmt.initExpr) walkExpr(stmt.initExpr);
        if (stmt.cond) walkExpr(stmt.cond);
        if (stmt.stepExpr) walkExpr(stmt.stepExpr);
        const base = snapshotSat();
        walkBranchAndTrack(stmt.body);
        restoreSat(base);
        return;
      }
      case ASTNodeKind.FOR_IN_LOOP: {
        if (stmt.iterExpr) walkExpr(stmt.iterExpr);
        // Body may execute zero times; like WHILE_STATEMENT / FOR_LOOP,
        // anything satisfied inside cannot discharge an outer obligation.
        const base = snapshotSat();
        walkBranchAndTrack(stmt.body);
        restoreSat(base);
        return;
      }
      case ASTNodeKind.SWITCH_STATEMENT: {
        // Walk each arm body as its own block so a `disposable`-keyword
        // binding declared inside an arm gets its auto-cleanup injected
        // (walkBlock populates arm.body.implicitCleanups, which codegen's
        // emitBlockStmt emits). Letting SWITCH fall through to the default
        // case would leave arm bodies unwalked, and keyword cleanups in a
        // `case` would silently fail to fire. We also do an IF-style
        // path-coverage merge across the arms so a manual dispose that
        // appears on every reaching arm can satisfy an outer obligation.
        walkExpr(stmt.scrutinee);
        const base = snapshotSat();
        const bodies = (stmt.arms ?? []).map((a) => a.body);
        if (stmt.defaultArm) bodies.push(stmt.defaultArm);
        const reachingSnaps = [];
        for (const body of bodies) {
          restoreSat(base);
          const diverged = walkBranchAndTrack(body);
          if (!diverged) reachingSnaps.push(snapshotSat());
        }
        // Without a `default`, a non-matching scrutinee falls through with the
        // pre-switch sat state, so that is a reaching path too.
        if (!stmt.defaultArm) reachingSnaps.push(base);
        if (reachingSnaps.length === 0) {
          // Every arm diverged (returned) and a default covered all cases.
          walkDiverged = true;
          restoreSat(base);
        } else {
          let merged = reachingSnaps[0];
          for (let i = 1; i < reachingSnaps.length; i++) {
            merged = mergeSatIntersect(merged, reachingSnaps[i]);
          }
          restoreSat(merged);
        }
        return;
      }
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
      e.pendingCleanups = projectCleanups(flattenStackReverse());
      walkExpr(e.operand);
      // The optional context string runs on the failure
      // branch, so anything it interpolates is still a use of that binding.
      if (e.context) walkExpr(e.context);
      return;
    }

    // A struct or variant literal takes ownership of whatever it is built from.
    if (e.kind === ASTNodeKind.STRUCT_LITERAL || e.kind === ASTNodeKind.VARIANT_CONSTRUCTOR) {
      for (const f of e.fields ?? []) markTransferredByValue(f.value);
    }

    // Check ASSIGNMENT for field-store escapes.
    if (e.kind === ASTNodeKind.ASSIGNMENT) {
      checkAssignmentEscape(e);
      walkExpr(e.value);
      return;
    }

    // Check CALL_EXPRESSION for ref-pass escapes.
    // Also mark pooled-typed arguments to pooled params for retain.
    if (e.kind === ASTNodeKind.CALL_EXPRESSION) {
      checkCallEscape(e);
      markPooledArgRetains(e);
      markManualCleanupSatisfies(e);
      // An argument passed BY VALUE is handed to the callee (`vecPush(ref v, x)`
      // moves x into v). `ref x` is a borrow and is skipped inside.
      for (const arg of e.args ?? []) markTransferredByValue(arg);
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

  // Check `outer.field = expr` for escapes.
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

  // Check `f(ref a)` where `a` is a sentinel but `f`'s param is not scoped.
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
      // Indirect/imported calls are not tracked.
    }
  }

  // Strict propagates: a direct trait-qualified call like
  // `Disposable.dispose(ref arr)` flips the active mustCall obligation's
  // `satisfied` flag. The walker uses path coverage (snapshot/restore around
  // branches in walkStatement) to ensure a dispose inside one arm of an
  // if/else doesn't satisfy an obligation unless the other arm also
  // disposes - that logic lives in the IF_STATEMENT handler, not here.
  function markManualCleanupSatisfies(callNode) {
    const method = callNode.calleeMethodName;
    if (!method) return;
    const firstArg = callNode.args?.[0];
    if (firstArg?.kind !== ASTNodeKind.REF_EXPRESSION) return;
    const operand = firstArg.operand;
    if (!operand || operand.kind !== ASTNodeKind.IDENT) return;
    const bindingName = operand.name;
    for (const frame of stack) {
      for (const o of frame.obligations) {
        if (
          o.type === "mustCall" &&
          o.bindingName === bindingName &&
          o.methodName === method &&
          !o.satisfied
        ) {
          o.satisfied = true;
        }
      }
    }
  }

  // For any call to a function whose params include `pooled`,
  // mark each matching argument so codegen emits a TASK_RETAIN at the call site.
  function markPooledArgRetains(callNode) {
    const callee = callNode.callee;
    if (typeof callee !== "string" || !funcDeclTable) return;
    const calleeDecl = funcDeclTable.get(callee);
    if (!calleeDecl) return;
    const params = calleeDecl.params ?? [];
    const args = callNode.args ?? [];
    for (let i = 0; i < Math.min(args.length, params.length); i++) {
      const pkt = params[i].resolvedKindType;
      if (!isRefcountedKind(pkt)) continue;
      // The retain codegen emits is `yoop_task_retain`, which is only valid
      // for a `Task<T>` - its retain/release bodies are compiler-provided
      // (coreKinds.js), and a Task is a raw pointer. A refcounted kind on a
      // NON-task receiver (a user struct implementing the required trait)
      // would otherwise be marked here too, and codegen would then hand a
      // struct VALUE to yoop_task_retain - IR that does not even verify.
      //
      // Only mark what codegen can actually emit. A refcounted kind on a
      // struct parameter is left unmarked rather than rejected, because
      // `pooled j: Job` where Job PROPAGATES pooled is a legitimate shape -
      // its handle lives in a field, and the field walk in obligationsFor
      // owns that release. A struct that is itself refcounted (implements the
      // required trait directly) gets no retain here; that would need a
      // trait-dispatched retain, which is the same gap as the release side.
      const pt = params[i].resolvedType ?? null;
      const base = pt?.kind === typeKinds.ref ? pt.inner : pt;
      if (base?.kind !== typeKinds.task) continue;
      args[i].pooledArgRetain = true;
    }
  }

  // Populate outer frame with escape sentinels from scoped parameters.
  // Also register a release obligation for any pooled parameter.
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
    if (isRefcountedKind(kt)) {
      outerFrame.obligations.push(mkObligation({
        type: "release",
        bindingName: p.name,
        kindType: kt,
        autoCleanup: true,
        sourceLoc: p.sourceLoc,
      }));
    }
  }
  stack.push(outerFrame);
  walkBlock(body);
  stack.pop();

  // Param-level obligations (e.g. pooled param release) live in the
  // outer frame, not the body's block frame. They didn't get folded into
  // body.implicitCleanups by walkBlock, so append them here in LIFO order so
  // fall-through cleanup fires them after body-local obligations.
  if (outerFrame.obligations.length > 0) {
    const extra = projectCleanups(outerFrame.obligations.slice().reverse());
    body.implicitCleanups = (body.implicitCleanups ?? []).concat(extra);
  }
}
