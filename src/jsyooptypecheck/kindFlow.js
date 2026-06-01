// Clearance kinds - static checker for marker kinds (conferred / restrictive).
//
// Marker kinds carry no obligation (no mustCall, no cleanup, no codegen).
// Their only rules are at use sites, expressed as a two-bound check that
// mirrors assignability:
//
//   conferred   (a capability you cannot forge):     slot.conferred  subset-of value.conferred
//   restrictive (a hazard you cannot silently drop):  value.restrictive subset-of slot.restrictive
//
// Every binding in Yoop carries an explicit type annotation and assignments
// must conform to it, so a value's marker set is fixed by annotations - there
// is no flow-sensitivity to track (a binding cannot be "cleared on one branch,
// plain on another"; that would be a type error at the assignment). The check
// is therefore static: walk the body and, at each slot (binding initializer,
// assignment, return, call argument), compare the expression's marker set
// against the slot's. The pass only emits diagnostics; it never mutates the
// AST and produces no codegen.
//
// A value's markers come from:
//   - IDENT            -> the binding's declared-type markers
//   - CALL (direct)    -> the callee's return-type markers (transitions are
//                         signature-driven; there is no baked-in "launder")
//   - anything else    -> plain (empty)
//
// v0 scope: same-module direct function calls (string callee) and the
// binding / return / call-argument slots. Cross-module + namespaced calls,
// method calls, and field-position sources are follow-ups (see
// plans/clearance-kinds.md).

import { ASTNodeKind } from "../contracts.js";
import { pushError } from "./errors.js";

function emptyMarkers() {
  return { conferred: new Set(), restrictive: new Set() };
}

export function runKindFlow(fnOrMethodDecl, errors, funcDeclTable, kindTable, containingType) {
  if (!fnOrMethodDecl?.body || !kindTable) return;

  // Resolve kind-prefix names to a marker set, dropping non-marker kinds. No
  // validation (callees validate their own annotations); use validateAnnot
  // for the owning function's own sites.
  function markersFromNames(names) {
    const out = emptyMarkers();
    for (const name of names ?? []) {
      const kt = kindTable.get(name);
      if (!kt || !kt.marker) continue;
      if (kt.marker === "conferred") out.conferred.add(kt);
      else if (kt.marker === "restrictive") out.restrictive.add(kt);
    }
    return out;
  }

  // Validate the kind prefixes on one of THIS function's own annotations:
  // each must name a known marker kind whose appliesTo includes `site`.
  function validateAnnot(annot, site, atNode) {
    if (!annot?.kindPrefixes) return emptyMarkers();
    const out = emptyMarkers();
    for (const name of annot.kindPrefixes) {
      const kt = kindTable.get(name);
      if (!kt) {
        pushError(errors, atNode, `unknown kind '${name}' used as a type prefix`);
        continue;
      }
      if (!kt.marker) {
        pushError(errors, atNode,
          `kind '${name}' is not a marker kind (it carries an obligation); only conferred/restrictive kinds may prefix a type`);
        continue;
      }
      if (!kt.appliesTo.has(site)) {
        const sites = [...kt.appliesTo].join(", ") || "(none)";
        pushError(errors, atNode,
          `kind '${name}' does not apply to ${site} (declared appliesTo: ${sites})`);
        continue;
      }
      if (kt.marker === "conferred") out.conferred.add(kt);
      else out.restrictive.add(kt);
    }
    return out;
  }

  // conferred (lower bound): the slot requires a capability the value must
  // already carry. Enforced at consumer sites (call args, binding inits).
  function checkConferred(value, slot, atNode, role) {
    for (const k of slot.conferred) {
      if (!value.conferred.has(k)) {
        pushError(errors, atNode,
          `${role} requires kind '${k.name}' but the value does not carry it; obtain it from a function whose return type declares '${k.name}'`);
      }
    }
  }

  // restrictive (upper bound): the value carries a hazard the slot does not
  // permit. Enforced at every slot, including returns.
  function checkRestrictive(value, slot, atNode, role) {
    for (const k of value.restrictive) {
      if (!slot.restrictive.has(k)) {
        pushError(errors, atNode,
          `${role} forbids kind '${k.name}' but the value carries it; pass it through a function that accepts '${k.name}' and returns without it`);
      }
    }
  }

  function checkBound(value, slot, atNode, role) {
    checkConferred(value, slot, atNode, role);
    checkRestrictive(value, slot, atNode, role);
  }

  // name -> declared-type markers, for IDENT lookups. Populated from params
  // and let/const declarations as the walk encounters them. Bindings cannot
  // change their kind set (it is part of their type), so a flat map suffices.
  const bindingMarkers = new Map();

  function exprMarkers(e) {
    if (!e || typeof e !== "object") return emptyMarkers();
    if (e.kind === ASTNodeKind.IDENT) {
      return bindingMarkers.get(e.name) ?? emptyMarkers();
    }
    if (e.kind === ASTNodeKind.CALL_EXPRESSION) {
      // Direct free function call: result kinds come from the callee's return
      // annotation. This still works only for kinds whose `appliedBy` named
      // the free function - but free-function laundering is rejected at the
      // function's own decl-authority check (only trait impl methods may
      // strip/confer), so in practice the return annotation here will be plain.
      const callee = e.callee;
      if (typeof callee === "string" && funcDeclTable) {
        const decl = funcDeclTable.get(callee);
        if (decl) return markersFromNames(decl.returnTypeAnnotation?.kindPrefixes);
      }
      // Trait method call (`Trait.method(...)`): the receiver type's impl of
      // the trait's method is the authorized transition for any kind whose
      // `appliedBy` names this method on this trait. The kind decl is the
      // source of truth, so the call confers every conferred kind that names
      // this (trait, method) pair. Match by trait NAME since the call's
      // calleeTrait may be a per-instance TraitType while kt.requires holds a
      // generic-trait decl record (different objects, same name).
      if (e.calleeMethodName && e.calleeTrait) {
        const traitName = e.calleeTrait.name;
        const out = emptyMarkers();
        for (const kt of kindTable.values()) {
          if (kt.marker !== "conferred") continue;
          if (kt.appliedBy !== e.calleeMethodName) continue;
          if (!kt.requires.some((t) => t.name === traitName)) continue;
          out.conferred.add(kt);
        }
        return out;
      }
    }
    return emptyMarkers();
  }

  // Sink check: every argument vs the callee's parameter markers.
  function checkCallArgs(callNode) {
    const callee = callNode.callee;
    if (typeof callee !== "string" || !funcDeclTable) return;
    const decl = funcDeclTable.get(callee);
    if (!decl) return;
    const args = callNode.args ?? [];
    const params = decl.params ?? [];
    for (let i = 0; i < args.length; i++) {
      const param = params[i];
      if (!param) continue;
      // A plain slot is an upper bound of the empty set, so it still rejects a
      // restrictive argument - run the check even when the slot is unmarked.
      const slot = markersFromNames(param.typeAnnotation?.kindPrefixes);
      const value = exprMarkers(args[i]);
      checkBound(value, slot, args[i] ?? callNode,
        `parameter '${param.name ?? `#${i}`}' of '${callee}'`);
    }
  }

  // `x = e`: e flows into x's declared type. Handled here (not just in
  // walkStmt) because an assignment usually appears as the value of an
  // EXPRESSION_STATEMENT, i.e. as an expression rather than a statement.
  function checkAssignment(node) {
    walkExpr(node.value);
    if (node.target?.kind === ASTNodeKind.IDENT) {
      const slot = bindingMarkers.get(node.target.name) ?? emptyMarkers();
      checkBound(exprMarkers(node.value), slot, node.value,
        `binding '${node.target.name}'`);
    }
  }

  // Recurse through an expression, running the sink check at every call.
  function walkExpr(e) {
    if (!e || typeof e !== "object") return;
    if (e.kind === ASTNodeKind.ASSIGNMENT) {
      checkAssignment(e);
      return;
    }
    if (e.kind === ASTNodeKind.CALL_EXPRESSION) checkCallArgs(e);
    for (const val of Object.values(e)) {
      if (Array.isArray(val)) {
        for (const v of val) walkExpr(v);
      } else if (val && typeof val === "object" && val.kind) {
        walkExpr(val);
      }
    }
  }

  // Return-type markers (validated once); parameter markers seed bindingMarkers.
  const returnMarkers = validateAnnot(
    fnOrMethodDecl.returnTypeAnnotation,
    "return",
    fnOrMethodDecl,
  );
  const paramMarkerSets = [];
  for (const p of fnOrMethodDecl.params ?? []) {
    const pm = validateAnnot(p.typeAnnotation, "parameter", p);
    if (p.name) bindingMarkers.set(p.name, pm);
    paramMarkerSets.push(pm);
  }

  // Decl-authority check: the kind decl is the source of truth for who may
  // strip a restrictive kind and who may confer a conferred kind. The trait
  // is the structural gate: the kind decl pairs `requires <Trait>` with
  // `clearedBy <method>` (or `appliedBy <method>`), and only a method that
  // implements that trait's method on the relevant type is authorized to
  // perform the transition. Free functions are categorically rejected -
  // laundering requires opting in via a trait impl.
  //
  //   - For each restrictive kind K carried by a parameter but NOT carried
  //     by the return (this function would "strip" K), the function must be
  //     a METHOD on a type whose `implements` list includes K's required
  //     trait, and the method's name must match K.clearedBy.
  //   - For each conferred kind K carried by the return, the function must
  //     be a METHOD with the same conditions, matching K.appliedBy.
  //
  // Passthrough (return carries the same kind) needs no authority - the kind
  // travels with the value rather than being transitioned.
  const fnName = fnOrMethodDecl.name;
  const isMethod = fnOrMethodDecl.kind === ASTNodeKind.METHOD_DECL;
  function implementsAny(traitTypes) {
    if (!containingType) return false;
    const names = new Set(
      (containingType.implements ?? []).map((r) => r.name),
    );
    for (const t of traitTypes) if (names.has(t.name)) return true;
    return false;
  }
  function authorizedAs(direction, kt) {
    // direction: "clearedBy" | "appliedBy"
    const methodName = kt[direction];
    if (methodName === null) return { ok: false, reason: "noClause" };
    if (!isMethod) return { ok: false, reason: "notMethod" };
    if (!implementsAny(kt.requires)) return { ok: false, reason: "notTraitImpl" };
    if (fnName !== methodName) return { ok: false, reason: "wrongName" };
    return { ok: true };
  }
  function explain(direction, kt, reason) {
    const role = direction === "clearedBy" ? "strip" : "confer";
    const traitNames = kt.requires.map((t) => t.name).join(", ") || "(none)";
    const where = isMethod ? `method '${fnName}'` : `function '${fnName}'`;
    if (reason === "noClause") {
      return `${where} would ${role} ${direction === "clearedBy" ? "restrictive" : "conferred"} kind '${kt.name}', but kind '${kt.name}' declares no '${direction}' clause; no impl is authorized to ${role} it`;
    }
    if (reason === "notMethod") {
      return `${where} would ${role} kind '${kt.name}', but only an impl method of trait '${traitNames}' (kind '${kt.name}'s '${direction} ${kt[direction]}') may do so; a free function is not authorized`;
    }
    if (reason === "notTraitImpl") {
      const parent = containingType?.name ?? "(unknown)";
      return `${where} on '${parent}' would ${role} kind '${kt.name}', but '${parent}' does not implement the required trait '${traitNames}'`;
    }
    if (reason === "wrongName") {
      return `${where} would ${role} kind '${kt.name}', but only '${kt[direction]}' (kind '${kt.name}'s '${direction}') is authorized to do so`;
    }
    return `${where} unauthorized transition of kind '${kt.name}'`;
  }
  if (fnName) {
    const seenStripped = new Set();
    for (const pm of paramMarkerSets) {
      for (const k of pm.restrictive) {
        if (returnMarkers.restrictive.has(k)) continue; // passthrough
        if (seenStripped.has(k)) continue;
        seenStripped.add(k);
        const res = authorizedAs("clearedBy", k);
        if (!res.ok) pushError(errors, fnOrMethodDecl, explain("clearedBy", k, res.reason));
      }
    }
    for (const k of returnMarkers.conferred) {
      const res = authorizedAs("appliedBy", k);
      if (!res.ok) pushError(errors, fnOrMethodDecl, explain("appliedBy", k, res.reason));
    }
  }

  function walkStmt(stmt) {
    if (!stmt) return;
    switch (stmt.kind) {
      case ASTNodeKind.LET_DECL:
      case ASTNodeKind.CONST_DECL: {
        if (stmt.assignment) walkExpr(stmt.assignment);
        const declMarkers = validateAnnot(stmt.typeAnnotation, "binding", stmt);
        if (stmt.name) bindingMarkers.set(stmt.name, declMarkers);
        if (stmt.assignment) {
          // The initializer flows into the binding's declared type.
          checkBound(exprMarkers(stmt.assignment), declMarkers, stmt.assignment,
            `binding '${stmt.name}'`);
        }
        if (stmt.trailingBlock) walkBlock(stmt.trailingBlock);
        return;
      }
      case ASTNodeKind.ASSIGNMENT:
        checkAssignment(stmt);
        return;
      case ASTNodeKind.EXPRESSION_STATEMENT:
      case ASTNodeKind.DISCARD_STATEMENT:
        walkExpr(stmt.value);
        return;
      case ASTNodeKind.RETURN_STATEMENT:
        if (stmt.value) {
          walkExpr(stmt.value);
          // The function's signature is the authority to CONFER its declared
          // conferred kinds (the launder / transition boundary - the body is
          // trusted to actually produce the cleared form), so only the
          // restrictive direction is enforced here: a hazard may not leak out
          // unless the return type declares it.
          checkRestrictive(exprMarkers(stmt.value), returnMarkers, stmt, "return");
        }
        return;
      case ASTNodeKind.IF_STATEMENT:
        walkExpr(stmt.expression);
        walkBranch(stmt.body);
        if (stmt.elseBody) walkBranch(stmt.elseBody);
        return;
      case ASTNodeKind.WHILE_STATEMENT:
      case ASTNodeKind.FOR_LOOP:
      case ASTNodeKind.FOR_IN_LOOP:
        if (stmt.expression) walkExpr(stmt.expression);
        if (stmt.initExpr) walkExpr(stmt.initExpr);
        if (stmt.cond) walkExpr(stmt.cond);
        if (stmt.stepExpr) walkExpr(stmt.stepExpr);
        if (stmt.iterExpr) walkExpr(stmt.iterExpr);
        walkBranch(stmt.body);
        return;
      case ASTNodeKind.SWITCH_STATEMENT:
        if (stmt.value) walkExpr(stmt.value);
        for (const c of stmt.cases ?? []) walkBranch(c.body);
        if (stmt.defaultCase) walkBranch(stmt.defaultCase.body ?? stmt.defaultCase);
        return;
      case ASTNodeKind.BLOCK:
        walkBlock(stmt);
        return;
      default:
        if (stmt.value) walkExpr(stmt.value);
        return;
    }
  }

  function walkBlock(block) {
    if (!block || block.kind !== ASTNodeKind.BLOCK) {
      walkStmt(block);
      return;
    }
    for (const s of block.body) walkStmt(s);
  }

  function walkBranch(node) {
    if (!node) return;
    if (node.kind === ASTNodeKind.BLOCK) walkBlock(node);
    else walkStmt(node);
  }

  walkBlock(fnOrMethodDecl.body);
}
