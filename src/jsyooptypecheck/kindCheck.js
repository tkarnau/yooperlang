// Phase 6.1 - flow-analysis pass for `mustCall fn beforeScopeEnd` obligations.
// Phase 6.2 - escape-analysis extension: tracks `mustNotEscape scope` sentinels
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
// Each frame also carries `escapeSentinels` - the names of scoped bindings/
// parameters whose escape must be detected. The walker checks three escape paths:
//   1. RETURN: expression names a sentinel whose resolved type is non-primitive
//   2. ASSIGNMENT to outer.field: outer's scopeDepth < sentinel's declScope
//   3. CALL with ref <sentinel>: callee param does not declare mustNotEscape

import { ASTNodeKind, ASTNode } from "../contracts.js";
import { pushError } from "./errors.js";
import { typeKinds } from "./types.js";

export function runKindCheck(fnOrMethodDecl, errors, funcDeclTable = null, registry = null) {
  const body = fnOrMethodDecl.body;
  if (!body || body.kind !== ASTNodeKind.BLOCK) return;

  // Phase 7.x: when the struct on a binding is an open generic instantiation
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

  // Phase 6.4 strict propagates: path-coverage satisfaction tracking. The
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
  // Phase 6.4 strict propagates: obligations are emitted for any binding of a
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
  //   - `transferred`     - vestigial (ownership redesign 2026-06-17): never
  //                         set now that `propagates<K>` is advisory only;
  //                         projectCleanups still tolerates it.
  //   - `reported`        - vestigial; the unsatisfied-obligation error it
  //                         deduped no longer exists.
  function obligationsFor(stmt) {
    const out = [];
    const kt = stmt.resolvedKindType;
    const rt = stmt.resolvedType;

    // Phase 6.3: builtin kinds bound directly to Task<T> - joined / pooled.
    // These are always opt-in via keyword, so `autoCleanup` is true.
    if (kt?.builtin && rt?.kind === "task") {
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

    // Phase 13.B: variants can declare `propagates<K>` and carry the
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
    if (
      stmt.assignment?.kind === ASTNodeKind.CALL_EXPRESSION &&
      typeof stmt.assignment.callee === "string" &&
      funcDeclTable
    ) {
      const calleeDecl = funcDeclTable.get(stmt.assignment.callee);
      for (const app of calleeDecl?.returnPropagatedKinds ?? []) addKind(app, false);
    }
    // The kt.builtin && rt is task case is handled above by the early return;
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
          // Phase 7.4: cleanup-call mangling is trait-qualified.
          traitName: mc.traitType?.name,
          structType: rt,
          moduleId: rt.moduleId,
          kindType: K,
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

  // Ownership redesign (2026-06-17): the return-site obligation-transfer
  // machinery (`markIdentObligationsTransferred` /
  // `markLiteralFieldObligationsTransferred`) was removed. `propagates<K>` no
  // longer transfers an enforced obligation across a return, so there is
  // nothing to mark. The `transferred` flag on obligations is now vestigial
  // (never set); projectCleanups still tolerates it.

  // Convert a list of obligations into auto-cleanup nodes for codegen,
  // skipping any that are satisfied, transferred, or not autoCleanup.
  //
  // Ownership redesign (2026-06-17, see plans/ownership-and-typestate-redesign.md):
  // obligations are ADVISORY, not enforced. A non-autoCleanup obligation that
  // reaches scope exit unhandled is NOT an error - the default is silent. Only a
  // binding that opted in via its kind keyword (`disposable`/`pooled`/`joined`/
  // Task -> autoCleanup) gets a cleanup call injected here. What to do with an
  // un-keyworded disposable is left entirely to the caller; avoiding double-free
  // is the `dispose` implementer's responsibility (idempotent dispose).
  function projectCleanups(obligations) {
    const out = [];
    for (const o of obligations) {
      if (o.satisfied || o.transferred) continue;
      if (o.autoCleanup) {
        out.push(makeCleanupCall(o));
      }
      // else: silent. Handling an un-keyworded obligation is the user's choice.
    }
    return out;
  }

  // Does a struct field carry the given kind?
  function fieldCarriesKind(field, kindType) {
    if (field.kindType === kindType) return true;
    if (kindType.builtin && kindType.refcounted && field.type?.kind === "task") {
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
          // Ownership redesign (2026-06-17): returning a value that carries a
          // propagating kind is fine and needs no annotation. `propagates<K>`
          // is now an advisory producer-side signal (surfaced by tooling/IDE),
          // not a transfer contract - there is nothing to enforce or mark here.
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
        // Phase 6.4 strict propagates: walk each arm independently from a
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
        // Ownership redesign (2026-06-17): walk each arm body as its own block
        // so a `disposable`-keyword binding declared inside an arm gets its
        // auto-cleanup injected (walkBlock populates arm.body.implicitCleanups,
        // which codegen's emitBlockStmt emits). Before this, SWITCH fell through
        // to `default` and arm bodies were never walked, so keyword cleanups in
        // a `case` silently failed to fire. We also do an IF-style path-coverage
        // merge across the arms so a manual dispose that appears on every
        // reaching arm can satisfy an outer obligation.
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
      return;
    }

    // Phase 6.2: check ASSIGNMENT for field-store escapes.
    if (e.kind === ASTNodeKind.ASSIGNMENT) {
      checkAssignmentEscape(e);
      walkExpr(e.value);
      return;
    }

    // Phase 6.2: check CALL_EXPRESSION for ref-pass escapes.
    // Phase 6.4: also mark pooled-typed arguments to pooled params for retain.
    if (e.kind === ASTNodeKind.CALL_EXPRESSION) {
      checkCallEscape(e);
      markPooledArgRetains(e);
      markManualCleanupSatisfies(e);
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

  // Phase 6.4 strict propagates: a direct trait-qualified call like
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

  // Phase 6.4: for any call to a function whose params include `pooled`,
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
      if (pkt?.builtin && pkt.refcounted) {
        args[i].pooledArgRetain = true;
      }
    }
  }

  // Phase 6.2: populate outer frame with escape sentinels from scoped parameters.
  // Phase 6.4: also register a release obligation for any pooled parameter.
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
    if (kt?.builtin && kt.refcounted) {
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

  // Phase 6.4: param-level obligations (e.g. pooled param release) live in the
  // outer frame, not the body's block frame. They didn't get folded into
  // body.implicitCleanups by walkBlock, so append them here in LIFO order so
  // fall-through cleanup fires them after body-local obligations.
  if (outerFrame.obligations.length > 0) {
    const extra = projectCleanups(outerFrame.obligations.slice().reverse());
    body.implicitCleanups = (body.implicitCleanups ?? []).concat(extra);
  }
}
