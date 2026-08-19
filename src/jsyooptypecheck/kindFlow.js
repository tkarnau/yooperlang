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
// Scope: same-module direct function calls (string callee), imported by-name
// calls, and namespaced member calls (`ns.fn(...)`) at the binding / return /
// call-argument slots. A cross-module callee's annotations are resolved against
// ITS OWN module's kind table via `crossModuleCallee` (imported kinds share
// object identity, so the markers line up with the consuming module's). Field-
// position sources (a `tainted` struct field surfacing through `x.field`)
// are not tracked.

import { ASTNodeKind } from "../contracts.js";
import { pushError } from "./errors.js";

// A marker set is a TREE, not a flat pair of sets: `args` mirrors the
// annotation's type arguments, so `Result<owned string, string>` carries
// nothing at the top level and `owned` at args[0]. That is what lets a marker
// survive a fallible constructor - the value only becomes reachable after a
// `switch` destructures the payload back out, and the payload's markers have
// to have been kept somewhere in between.
function emptyMarkers() {
  return { conferred: new Set(), restrictive: new Set(), args: [] };
}

export function runKindFlow(
  fnOrMethodDecl,
  errors,
  funcDeclTable,
  kindTable,
  containingType,
  crossModuleCallee,
  registry,
  variantDeclLookup,
) {
  if (!fnOrMethodDecl?.body || !kindTable) return;

  // Resolve kind-prefix names to a marker set, dropping non-marker kinds. No
  // validation (callees validate their own annotations); use validateAnnot
  // for the owning function's own sites. `table` defaults to this module's kind
  // table; a cross-module callee passes its own so the names resolve in their
  // home module (imported kinds are the same object, so identity is preserved).
  function markersFromNames(names, table = kindTable) {
    const out = emptyMarkers();
    for (const name of names ?? []) {
      const kt = table.get(name);
      if (!kt || !kt.marker) continue;
      if (kt.marker === "conferred") out.conferred.add(kt);
      else if (kt.marker === "restrictive") out.restrictive.add(kt);
    }
    return out;
  }

  // Same, but reading a whole annotation TREE rather than only its top-level
  // prefixes, so type arguments keep their markers.
  function markersFromAnnot(annot, table = kindTable) {
    if (!annot || typeof annot !== "object") return emptyMarkers();
    const out = markersFromNames(annot.kindPrefixes, table);
    out.args = (annot.typeArgs ?? []).map((a) => markersFromAnnot(a, table));
    return out;
  }

  // Validate the kind prefixes on one of THIS function's own annotations:
  // each must name a known marker kind whose appliesTo includes `site`.
  // Recurses into type arguments, which are validated at the SAME site - an
  // `owned` inside a return's type argument is still part of the return.
  function validateAnnot(annot, site, atNode) {
    if (!annot || typeof annot !== "object") return emptyMarkers();
    const out = emptyMarkers();
    out.args = (annot.typeArgs ?? []).map((a) => validateAnnot(a, site, atNode));
    if (!annot.kindPrefixes) return out;
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

  // Both bounds, applied at the top level and then positionally down the type
  // arguments. `Result<tainted X, E>` flowing into a plain `Result<X, E>` slot
  // is the same hazard as the bare case and is caught the same way.
  function checkBound(value, slot, atNode, role) {
    checkConferred(value, slot, atNode, role);
    checkRestrictive(value, slot, atNode, role);
    const n = Math.min(value.args?.length ?? 0, slot.args?.length ?? 0);
    for (let i = 0; i < n; i++) {
      checkBound(value.args[i], slot.args[i], atNode, `${role} (type argument ${i + 1})`);
    }
  }

  // The return site enforces only the restrictive direction (the signature is
  // the conferring authority), and that stays true down the type arguments.
  function checkRestrictiveDeep(value, slot, atNode, role) {
    checkRestrictive(value, slot, atNode, role);
    const n = Math.min(value.args?.length ?? 0, slot.args?.length ?? 0);
    for (let i = 0; i < n; i++) {
      checkRestrictiveDeep(value.args[i], slot.args[i], atNode, `${role} (type argument ${i + 1})`);
    }
  }

  // name -> declared-type markers, for IDENT lookups. Populated from params
  // and let/const declarations as the walk encounters them. Bindings cannot
  // change their kind set (it is part of their type), so a flat map suffices.
  const bindingMarkers = new Map();

  // Every `return`'s value expression, collected during the walk and read
  // afterwards by the conferred-passthrough check. It has to be afterwards:
  // `bindingMarkers` only holds the parameters until the walk populates the
  // locals, so `return s;` where `s` is a local would look unmarked if the
  // check ran up front.
  const returnValueNodes = [];

  // Resolve a call node to the callee's decl plus the kind table its
  // annotations are written against. Three shapes:
  //   - same-module bare name      -> local funcDeclTable, this kind table
  //   - imported bare name         -> calleeModuleId/calleeExportName stamped by
  //                                   the typechecker; source module's table
  //   - namespaced member `ns.fn`  -> callee.namespaceLookup stamped during
  //                                   field-access resolution; source table
  // The cross-module shapes resolve through `crossModuleCallee` so a marker on
  // a std-style signature is enforced at the call site instead of dropped.
  // Returns null for externs / printf / fn-pointer / trait-method calls.
  function calleeInfo(callNode) {
    const callee = callNode.callee;
    if (typeof callee === "string") {
      if (callNode.calleeModuleId && callNode.calleeExportName && crossModuleCallee) {
        const x = crossModuleCallee(callNode.calleeModuleId, callNode.calleeExportName);
        if (x) return { decl: x.decl, table: x.kindTable, name: callee };
      }
      const decl = funcDeclTable?.get(callee);
      if (decl) return { decl, table: kindTable, name: callee };
      return null;
    }
    const nl = callee?.namespaceLookup;
    if (nl && crossModuleCallee) {
      const x = crossModuleCallee(nl.moduleId, nl.exportName);
      if (x) {
        const ns = callee.object?.name;
        const name = ns ? `${ns}.${nl.exportName}` : nl.exportName;
        return { decl: x.decl, table: x.kindTable, name };
      }
    }
    return null;
  }

  function exprMarkers(e) {
    if (!e || typeof e !== "object") return emptyMarkers();
    if (e.kind === ASTNodeKind.IDENT) {
      return bindingMarkers.get(e.name) ?? emptyMarkers();
    }
    if (e.kind === ASTNodeKind.CALL_EXPRESSION) {
      // Trait method call (`Trait.method(...)`): the receiver type's impl of
      // the trait's method is the authorized transition for any kind whose
      // `appliedBy` names this method on this trait. The kind decl is the
      // source of truth, so the call confers every conferred kind that names
      // this (trait, method) pair. Match by trait NAME since the call's
      // calleeTrait may be a per-instance TraitType while kt.requires holds a
      // generic-trait decl record (different objects, same name). This is the
      // launder boundary, checked before the plain-return path below.
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
      // Direct / imported / namespaced call: result kinds come from the callee's
      // return annotation, resolved in the callee's home module. Free-function
      // laundering is rejected at the callee's own decl-authority check (only
      // trait impl methods may strip/confer), so the markers that ride here are
      // passthroughs the signature declares.
      const info = calleeInfo(e);
      if (info) {
        return markersFromAnnot(info.decl.returnTypeAnnotation, info.table);
      }
    }
    return emptyMarkers();
  }

  // Which type-argument position a variant payload field occupies, or -1 when
  // the field's type is not one of the decl's type parameters (a concrete
  // field type, which carries its markers on its own annotation instead).
  //
  //   variant Result<T, E> { Ok { value: T }, Err { error: E } }
  //   payloadArgIndex(Result<..>, "Ok", "value") === 0
  //
  // Reads the GENERIC decl rather than the instantiated type: instantiation
  // has already substituted `T` away, so the concrete variant only knows the
  // field is a `string` and not which parameter it came from.
  function payloadArgIndex(variantType, variantName, fieldName) {
    const declId = variantType?.genericInstance?.declId;
    if (!declId || !registry?.genericDeclById) return -1;
    const genericDecl = registry.genericDeclById.get(declId);
    if (!genericDecl) return -1;
    const vcase = genericDecl.genericVariants?.get(variantName);
    const field = vcase?.fields?.find((f) => f.name === fieldName);
    // An open field type is a TypeParamType; its name indexes paramNames.
    const paramName = field?.type?.name;
    if (!paramName) return -1;
    const idx = genericDecl.paramNames?.indexOf(paramName) ?? -1;
    return idx;
  }

  // Markers for one destructured payload field, from either direction:
  //   - generic payload (`Ok { value: T }`) -> the scrutinee's type argument
  //   - concrete payload (`Case { f: owned string }`) -> the field's own
  //     annotation on the variant declaration
  // The second needs the decl's AST, since an instantiated or plain variant
  // TYPE keeps only resolved field types and no annotations.
  function payloadFieldMarkers(variantType, variantName, fieldName, scrutMarkers) {
    const idx = payloadArgIndex(variantType, variantName, fieldName);
    if (idx >= 0) return scrutMarkers.args?.[idx] ?? emptyMarkers();
    // A VARIANT_DECL's case list is `variants` (`cases` belongs to ENUM_DECL).
    const decl = variantDeclLookup?.(variantType?.moduleId, variantType?.name);
    const vcase = decl?.variants?.find((c) => c.name === variantName);
    const field = vcase?.fields?.find((f) => f.name === fieldName);
    if (!field) return emptyMarkers();
    return markersFromAnnot(field.typeAnnotation);
  }

  // Sink check: every argument vs the callee's parameter markers (resolved in
  // the callee's home module so namespaced/imported sinks are enforced too).
  function checkCallArgs(callNode) {
    const info = calleeInfo(callNode);
    if (!info) return;
    const args = callNode.args ?? [];
    const params = info.decl.params ?? [];
    for (let i = 0; i < args.length; i++) {
      const param = params[i];
      if (!param) continue;
      // A plain slot is an upper bound of the empty set, so it still rejects a
      // restrictive argument - run the check even when the slot is unmarked.
      const slot = markersFromAnnot(param.typeAnnotation, info.table);
      const value = exprMarkers(args[i]);
      checkBound(value, slot, args[i] ?? callNode,
        `parameter '${param.name ?? `#${i}`}' of '${info.name}'`);
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
  }

  // Conferred passthrough: a function is only CONFERRING K if it produces a
  // value carrying K out of one that did not. When every `return` in the body
  // already yields a K-carrying value, the kind is travelling with the value
  // and no authority is required - the same reasoning the restrictive
  // direction has always applied to a parameter that carries K.
  //
  // Without this a pure forwarder (`function f(s: owned string): owned string
  // { return s; }`) is rejected as an unauthorized conferral, which made
  // wrapping any conferring API impossible.
  //
  // "Every" is load-bearing, not "any": a body that returns a laundered value
  // on one path and a forged one on another is still forging, and still has
  // to answer to the kind decl. An empty list is not vacuous passthrough
  // either - with no returns to inspect there is nothing establishing that
  // the kind came from anywhere.
  function isConferredPassthrough(k) {
    if (returnValueNodes.length === 0) return false;
    for (const v of returnValueNodes) {
      if (!exprMarkers(v).conferred.has(k)) return false;
    }
    return true;
  }

  // `return Result.Ok { value: X }` against a declared
  // `Result<owned string, string>`: the constructor field is a SLOT, and the
  // return annotation's matching type argument is what it must satisfy.
  //
  // Without this the nested position would be forgeable. The decl-authority
  // check is top-level only (it asks what the function hands back, and a
  // `Result` is not itself owned), so nothing else would stop a body from
  // building `Ok { value: "a literal" }` and handing it out as owned - the
  // caller would then destructure it and free read-only memory.
  function checkReturnedConstructor(value) {
    if (value?.kind !== ASTNodeKind.VARIANT_CONSTRUCTOR) return;
    const vtype = value.resolvedEnumType ?? value.resolvedVariantType;
    for (const f of value.fields ?? []) {
      const name = f.name ?? f.fieldName;
      const expr = f.value ?? f.expr;
      if (!name || !expr) continue;
      const idx = payloadArgIndex(vtype, value.variantName, name);
      const slot =
        idx >= 0
          ? (returnMarkers.args?.[idx] ?? emptyMarkers())
          : payloadFieldMarkers(vtype, value.variantName, name, returnMarkers);
      checkBound(exprMarkers(expr), slot, expr, `payload field '${name}'`);
    }
  }

  // Give every payload binding in one arm the markers of the position it was
  // destructured out of, so `case Result.Ok { value: v }` over a
  // `Result<owned string, string>` scrutinee makes `v` an owned string.
  function bindPayloadMarkers(arm, scrutMarkers) {
    for (const pat of arm.patterns ?? []) {
      if (pat.kind !== ASTNodeKind.VARIANT_PATTERN || pat.isWildcard) continue;
      for (const fb of pat.fieldBindings ?? []) {
        if (fb.isWildcard || !fb.bindingName) continue;
        bindingMarkers.set(
          fb.bindingName,
          payloadFieldMarkers(
            pat.resolvedVariantType,
            pat.variantName,
            fb.fieldName,
            scrutMarkers,
          ),
        );
      }
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
          returnValueNodes.push(stmt.value);
          // The function's signature is the authority to CONFER its declared
          // conferred kinds (the launder / transition boundary - the body is
          // trusted to actually produce the cleared form), so only the
          // restrictive direction is enforced here: a hazard may not leak out
          // unless the return type declares it.
          checkRestrictiveDeep(exprMarkers(stmt.value), returnMarkers, stmt, "return");
          checkReturnedConstructor(stmt.value);
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
      case ASTNodeKind.SWITCH_STATEMENT: {
        // The node's slots are `scrutinee` / `arms` / `defaultArm`. This used
        // to read `stmt.value` / `stmt.cases`, which do not exist on it, so
        // NOTHING inside a switch was ever checked - a sink violation in an
        // arm body was silently accepted while the identical call one line
        // outside was rejected.
        walkExpr(stmt.scrutinee);
        const scrutMarkers = exprMarkers(stmt.scrutinee);
        for (const arm of stmt.arms ?? []) {
          bindPayloadMarkers(arm, scrutMarkers);
          walkBranch(arm.body);
        }
        if (stmt.defaultArm) walkBranch(stmt.defaultArm.body ?? stmt.defaultArm);
        return;
      }
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

  // Runs after the walk so `returnValueNodes` and the local half of
  // `bindingMarkers` are populated. See isConferredPassthrough above.
  if (fnName) {
    for (const k of returnMarkers.conferred) {
      if (isConferredPassthrough(k)) continue;
      const res = authorizedAs("appliedBy", k);
      if (!res.ok) pushError(errors, fnOrMethodDecl, explain("appliedBy", k, res.reason));
    }
  }
}
