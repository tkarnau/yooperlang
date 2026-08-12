// Statement typechecking.
//
// validateFunction sets up the function's scope (params + return type),
// then walks the body via validateStatement.
//
// validateStatement is a thin dispatcher: each AST node kind delegates to a
// small named helper (checkLetOrConst, checkReturn, checkIf, ...). Helpers
// push errors onto ctx.errors as they go; expressions inside statements
// delegate to resolveExprType in checkExpr.js.

import { ASTNodeKind } from "../contracts.js";
import {
  ArrayType,
  ErrorType,
  KindApplication,
  PrimType,
  RefType,
  StructType,
  primAnnotations,
  resolveTypeFromName,
  resolveTypeAnnotation,
  formatAnnotation,
  isIntPrim,
  typeKinds,
  typesEqual,
} from "./types.js";
import {
  instantiateStruct,
  instantiateTrait,
  resolveTypeInCtx,
} from "./instantiate.js";
import { pushError, pushWarning, formatType } from "./errors.js";
import { coerceUntypedLiteralToTyped, isNumeric } from "./coerce.js";
import { pushScope, popScope, declareInScope, lookupInScope } from "./scope.js";
import {
  checkInitializer,
  lookupGenericFunc,
  resolveExprType,
} from "./checkExpr.js";

// True if `callExpr` is `ns.method(...)` where `ns` resolves to a namespace
// import and the source module has a generic function by that name. Lets
// checkLetOrConst route the call through checkInitializer so the LHS type
// drives return-position type-param inference (e.g. `intr.heapAlloc(8)`).
function isNamespaceGenericCall(callExpr, ctx) {
  const callee = callExpr.callee;
  if (!callee || typeof callee !== "object") return false;
  if (callee.kind !== ASTNodeKind.FIELD_ACCESS) return false;
  if (
    callee.object?.kind !== ASTNodeKind.IDENT &&
    callee.object?.kind !== ASTNodeKind.NAMESPACE_IDENT
  ) return false;
  const ns = ctx.typeContext.moduleSymbols?.get(callee.object.name);
  if (!ns || ns.kind !== typeKinds.namespace) return false;
  const srcEnv = ctx.typeContext.moduleEnv?.get(ns.moduleId);
  return !!srcEnv?.genericFuncTable?.has(callee.field);
}
import { lookupCoreKind, taskSatisfiesKind, isRefcountedKind } from "./coreKinds.js";

// Phase 6.4: kind-prefix resolution walks both the local kindTable (user
// kinds + the seeded `Task` builtin) and the builtin-kind table (joined /
// pooled / Task). Returns null if neither matches.
function resolveKindByName(name, typeContext) {
  return (
    typeContext.kindTable?.get(name) ?? lookupCoreKind(name) ?? null
  );
}
import { TaskType } from "./types.js";
import { isAssignable } from "./coerce.js";
import { mangleTraitMethod } from "./mangleTraitMethod.js";
import { alwaysDiverges, firstUnreachableIndex } from "./diverge.js";

export function validateMethod(methodDecl, structType, typeContext, errors) {
  const scope = pushScope(null);

  // params[0] is self (ref structType); remaining params use types from C.3
  const resolvedParams = methodDecl.resolvedFuncType?.params ?? [];
  for (let i = 0; i < resolvedParams.length; i++) {
    const p = resolvedParams[i];
    declareInScope(scope, i === 0 ? "self" : p.name, p.type, typeKinds.param, methodDecl.params?.[i] ?? methodDecl, errors);
  }

  const funcReturnType = methodDecl.resolvedFuncType?.returnType ?? ErrorType();
  const ctx = {
    funcReturnType,
    funcName: methodDecl.name,
    typeContext,
    errors,
    inLoop: false,
    inMethodBody: true,
    // Same coloring flag as validateFunction - an `async` method body is
    // a coroutine and may contain `await`.
    inAsyncBody: !!methodDecl.isAsync,
    enclosingType: structType,
  };
  validateStatement(methodDecl.body, scope, ctx);
  checkAllPathsReturn(methodDecl, methodDecl.body, funcReturnType, ctx);
  popScope(scope, errors);
}

// Phase 10.E.3: a function with a value to return must actually return on
// every path. Before this existed, falling off the end compiled and trapped
// at runtime (codegen emits `unreachable`), so the failure showed up as a
// SIGTRAP with no source location rather than as a diagnostic.
//
// Void functions are exempt - falling off the end IS the return. An
// already-errored return type is exempt too, so a bad annotation reports
// once instead of twice.
function checkAllPathsReturn(declNode, body, returnType, ctx) {
  if (!body) return;
  if (returnType.kind === typeKinds.void || returnType.kind === typeKinds.error) {
    return;
  }
  if (alwaysDiverges(body)) return;
  pushError(
    ctx.errors,
    declNode,
    `function "${ctx.funcName}" returns ${formatType(returnType)} but not every path returns a value - add a return at the end, or make each branch return`,
  );
}

export function validateFunction(funcNode, typeContext, errors) {
  const scope = pushScope(null);

  for (const param of funcNode.params ?? []) {
    const baseType =
      resolveTypeInCtx(param.typeAnnotation, typeContext) ?? ErrorType();
    if (baseType.kind === typeKinds.error) {
      pushError(errors, param, `unknown type "${formatAnnotation(param.typeAnnotation)}"`);
    }
    // ref params: binding type in scope is RefType(baseType)
    const t = param.isRef ? RefType(baseType) : baseType;

    // Phase 6.2: resolve kind prefix on parameter.
    let paramKindType = null;
    if (param.kindPrefix) {
      const kt = resolveKindByName(param.kindPrefix.name, typeContext);
      if (!kt) {
        pushError(errors, param, `unknown kind "${param.kindPrefix.name}"`);
      } else {
        // Validate applicability: kind must include "parameter" site.
        if (!kt.appliesTo.has("parameter")) {
          const sites = [...kt.appliesTo].join(", ") || "(none)";
          pushError(errors, param,
            `kind '${kt.name}' does not apply to parameters (declared appliesTo: ${sites})`);
        } else if (
          (baseType.kind === typeKinds.ref ? baseType.inner : baseType).kind ===
            typeKinds.task && taskSatisfiesKind(kt)
        ) {
          // `pooled h: Task<int32>` - Task<T> is a compiler type rather than
          // a nominal struct, so it cannot carry an `implements` list. It
          // does satisfy the traits the core kinds require (see
          // taskSatisfiesKind), so skip the struct-shape check here; the
          // associated type is validated by the binding-resolution path.
          paramKindType = kt;
        } else {
          // Unwrap ref to get the underlying nominal type. Phase 13.B:
          // variants are valid receivers for kind-tracked params too.
          const structType = baseType.kind === typeKinds.ref ? baseType.inner : baseType;
          if (
            structType.kind !== typeKinds.struct &&
            structType.kind !== typeKinds.variant
          ) {
            pushError(errors, param,
              `kind "${kt.name}" can only apply to struct or variant values, got ${formatType(baseType)}`);
          } else {
            // Phase 6.4 strict propagates: a struct that propagates this kind
            // satisfies the kind's requirement via its propagated fields, even
            // if it does not implement the required traits directly. Skip the
            // direct-implements check in that case.
            const structPropagatesThisKind = (structType.propagatedKinds ?? []).some(
              (a) => (a.kindType ?? a) === kt,
            );
            if (!structPropagatesThisKind) {
              // Validate required traits.
              for (const reqTrait of kt.requires) {
                const implementsIt = (structType.implementsTraits ?? []).some(
                  (t2) => t2.name === reqTrait.name && (t2.moduleId ?? null) === (reqTrait.moduleId ?? null),
                );
                if (!implementsIt) {
                  pushError(errors, param,
                    `parameter "${param.name}" has kind "${kt.name}" which requires "${reqTrait.name}", but type ${formatType(structType)} does not implement "${reqTrait.name}"`);
                }
              }
            }
          }
          paramKindType = kt;
        }
      }
      param.resolvedKindType = paramKindType;
      // Phase 6.5: build a KindApplication for the parameter site as well.
      if (paramKindType) {
        const args = param.kindPrefix.args ?? [];
        if (args.length !== paramKindType.params.length) {
          pushError(errors, param,
            `kind '${paramKindType.name}' expects ${paramKindType.params.length} argument(s), got ${args.length}`);
        } else {
          const resolved = [];
          let ok = true;
          for (const a of args) {
            if (a.kind !== ASTNodeKind.INT_LITERAL) {
              pushError(errors, a,
                `kind argument must be a constant in phase 6.5`);
              ok = false;
              break;
            }
            resolved.push(a.value);
          }
          if (ok) {
            param.resolvedKindApplication = new KindApplication(paramKindType, resolved);
          }
        }
      }
    } else {
      param.resolvedKindType = null;
      param.resolvedKindApplication = null;
    }

    declareInScope(scope, param.name, t, typeKinds.param, param, errors, paramKindType);
    param.resolvedType = t;
  }

  const funcReturnType =
    resolveTypeInCtx(funcNode.returnTypeAnnotation, typeContext) ??
    ErrorType();
  if (funcReturnType.kind === typeKinds.error) {
    pushError(errors, funcNode, `unknown return type "${formatAnnotation(funcNode.returnTypeAnnotation)}"`);
  }
  // Reject ref return types
  if (funcReturnType.kind === typeKinds.ref) {
    pushError(errors, funcNode,
      `functions may not return 'ref T' - returning a reference to a local binding is unsafe`);
  }
  funcNode.resolvedType = funcReturnType;

  // Phase 6.3: inside a task function body, `return` statements type against
  // the declared T (not Task<T>), and `wait` is rejected.
  const ctx = {
    funcReturnType,
    funcName: funcNode.name,
    typeContext,
    errors,
    inLoop: false,
    inTaskBody: !!funcNode.isTask,
    // Coloring: `await` is legal only where a suspend has a coroutine
    // frame to propagate into. A task body is implicitly async, so the
    // parser has already set isAsync on it.
    inAsyncBody: !!funcNode.isAsync,
  };
  validateStatement(funcNode.body, scope, ctx);
  checkAllPathsReturn(funcNode, funcNode.body, funcReturnType, ctx);
  // params + the synthetic outer body share `scope`. Block-statement
  // bodies open their own inner scope and pop it themselves; this catches
  // the function-level scope (params and any locals declared at function
  // top - there usually are none, but it's the right shape).
  popScope(scope, errors);
}

// Phase 8.E: typecheck a single module-level let/const decl's initializer
// against its declared type. The scope is empty (module-level inits have
// no locals); identifier lookups fall through to moduleSymbols, which by
// pass D.0 holds both this module's bindings and any imported ones.
//
// (Bytecode/CTE future) - this is the call site to swap for a CTE
// evaluator: try evaluating decl.assignment at compile time; on success
// stash the result on the decl for codegen to use as the @global initial
// value; on failure keep the existing runtime-init behavior.
export function validateModuleInit(decl, typeContext, errors) {
  const scope = pushScope(null);
  const ctx = {
    funcReturnType: null,
    funcName: "<module init>",
    typeContext,
    errors,
    inLoop: false,
    inTaskBody: false,
  };
  // No annotation (resolvedType left null by pass C.4): infer the binding's
  // type from its initializer and publish it so function bodies in this module
  // - and any importer, which typechecks later in topological order - resolve
  // the name to the inferred type rather than the ErrorType shell.
  if (decl.typeAnnotation === null) {
    const rhsType = resolveExprType(decl.assignment, scope, ctx);
    decl.resolvedType = concretizeInferred(rhsType) ?? ErrorType();
    if (decl.resolvedType.kind === typeKinds.error) {
      pushError(errors, decl,
        `cannot infer a type for "${decl.name}"; add an explicit type annotation`);
    } else {
      if (
        decl.resolvedType.kind === typeKinds.array &&
        decl.assignment.kind === ASTNodeKind.ARRAY_LITERAL
      ) {
        // Re-pin an untyped array literal to its concrete element type so
        // codegen emits a concrete element type (see checkLetOrConst).
        checkArrayLiteralWithElemType(decl.assignment, decl.resolvedType.elem, scope, ctx);
      }
      typeContext.moduleSymbols.set(decl.name, decl.resolvedType);
    }
    popScope(scope, errors);
    return;
  }
  checkInitializer(
    decl.assignment,
    decl.resolvedType,
    scope,
    ctx,
    (valueType) =>
      `cannot assign ${formatType(valueType)} to ${formatType(decl.resolvedType)} in initializer of module-level "${decl.name}"`,
  );
  popScope(scope, errors);
}

// Phase 11.D.18: typecheck a top-level `@precompile { ... }` block.
// The block has no params and no return type (its only effects are
// writes to module-level state); local bindings declared inside the
// block live only during comptime evaluation. Otherwise it's a
// normal block - IDENT resolution falls through to module symbols
// the same way validateModuleInit does.
export function validatePrecompileBlock(blockAst, typeContext, errors) {
  const scope = pushScope(null);
  const ctx = {
    funcReturnType: null,
    funcName: "<precompile block>",
    typeContext,
    errors,
    inLoop: false,
    inTaskBody: false,
  };
  validateStatement(blockAst, scope, ctx);
  popScope(scope, errors);
}

export function validateStatement(node, scope, ctx) {
  switch (node.kind) {
    case ASTNodeKind.BLOCK:
      return checkBlock(node, scope, ctx);
    case ASTNodeKind.LET_DECL:
    case ASTNodeKind.CONST_DECL:
      return checkLetOrConst(node, scope, ctx);
    case ASTNodeKind.DESTRUCTURE_DECL:
      return checkDestructureDecl(node, scope, ctx);
    case ASTNodeKind.DISCARD_STATEMENT:
      return checkDiscardStatement(node, scope, ctx);
    case ASTNodeKind.RETURN_STATEMENT:
      return checkReturn(node, scope, ctx);
    case ASTNodeKind.EXPRESSION_STATEMENT:
      return checkExpressionStatement(node, scope, ctx);
    case ASTNodeKind.IF_STATEMENT:
      return checkIf(node, scope, ctx);
    case ASTNodeKind.WHILE_STATEMENT:
      return checkWhile(node, scope, ctx);
    case ASTNodeKind.FOR_LOOP:
      return checkForLoop(node, scope, ctx);
    case ASTNodeKind.FOR_IN_LOOP:
      return checkForInLoop(node, scope, ctx);
    case ASTNodeKind.BREAK_STATEMENT:
      return checkBreak(node, ctx);
    case ASTNodeKind.CONTINUE_STATEMENT:
      return checkContinue(node, ctx);
    case ASTNodeKind.SWITCH_STATEMENT:
      return checkSwitch(node, scope, ctx);
    default:
      pushError(
        ctx.errors,
        node,
        `typecheck: unhandled statement kind "${node.kind}"`,
      );
  }
}

// `{ ... }` - opens a fresh child scope, walks each inner statement, then
// enforces fallible-binding observation on every binding declared in this
// scope before letting them go out.
function checkBlock(node, scope, ctx) {
  const inner = pushScope(scope);
  for (const s of node.body) {
    validateStatement(s, inner, ctx);
  }
  popScope(inner, ctx.errors);
  reportUnreachable(node, ctx);
}

// Warn once per block on the dead tail after a diverging statement. Every
// block in the language funnels through checkBlock - function and method
// bodies, `if`/loop/switch-arm bodies, and the trailing block of a
// block-owning kind binding - so this one call site covers all of them.
//
// Reported as a WARNING, not an error, and deliberately so: dead code is a
// smell, not a soundness problem, and hard-erroring is hostile in the middle
// of editing (comment out a branch, add a temporary early return to bisect
// something, and the build stops). Rust, Swift, C# and TS all warn here.
//
// The statements are still typechecked - the walk above ran over all of
// them. Unreachable code that also does not compile should say so.
function reportUnreachable(node, ctx) {
  const dead = firstUnreachableIndex(node.body);
  if (dead < 0) return;
  const start = node.body[dead].startLoc;
  // Both are parser-stamped; a synthesized block (@derive output, the
  // generated --test entry) may lack them, and a warning is never worth
  // risking a crash over.
  if (!start || typeof node.endPos !== "number") return;
  pushWarning(
    ctx.errors,
    { ...start, length: Math.max(1, node.endPos - start.pos) },
    "unreachable code - control never reaches here",
    "unreachable-code",
  );
}

// `let x: T = expr;` / `const x: T = expr;`
//   - resolve the declared type
//   - if there's an initializer, type-check it against the declared type
//   - bind the name in the current scope
//
// Phase 6.1: when `node.kindPrefix` is set, the binding is kind-prefixed
// (e.g. `disposable a: FileHandle = ...`). We additionally:
//   - resolve the kind name against ctx.typeContext.kindTable
//   - validate the RHS struct type implements every trait in kind.requires
//   - if `node.trailingBlock` is present, require kind.ownsBlock and bind
//     the name in the trailing block's scope rather than the enclosing one
// When a binding omits its type annotation, its type is inferred from the
// initializer. Bare integer/float literals resolve to the `untypedInt` /
// `untypedFloat` placeholders, which exist only to be pinned by a surrounding
// context; with no annotation there is no such context, so default them to the
// same concrete types an explicit annotation would have produced (int32 /
// float64). Recurse into array element types so `const xs = [1, 2];` infers
// `int32[]` rather than the un-emittable `untypedInt[]`.
function concretizeInferred(t) {
  if (!t) return t;
  if (t.kind === typeKinds.untypedInt) return PrimType("int32");
  if (t.kind === typeKinds.untypedFloat) return PrimType("float64");
  if (t.kind === typeKinds.array) {
    const elem = concretizeInferred(t.elem);
    return elem === t.elem ? t : ArrayType(elem);
  }
  return t;
}

// A struct type captured from an expression site (e.g. a function-call return)
// may be the pass-A shell, with `implementsTraits`/`methods` still empty.
// Re-fetch the canonical, fully-resolved version from its home module's
// structTable so everything downstream of an *inferred* binding type - kind
// validation, obligation tracking in kindCheck, codegen - sees the populated
// trait list. Returns the input unchanged when no canonical entry exists (a
// generic instantiation carries its traits via the registry, not the table).
// Same technique as `lookupIntoImpl` / the for-in `Iterable` lookup.
function canonicalizeStruct(type, ctx) {
  if (!type || type.kind !== typeKinds.struct) return type;
  const moduleEnv = ctx.typeContext?.moduleEnv;
  if (type.moduleId && moduleEnv) {
    const env = moduleEnv.get(type.moduleId);
    const fromTable = env?.structTable?.get(type.name);
    if (fromTable) return fromTable;
  } else if (ctx.typeContext?.structTable) {
    const fromTable = ctx.typeContext.structTable.get(type.name);
    if (fromTable) return fromTable;
  }
  return type;
}

function checkLetOrConst(node, scope, ctx) {
  // Phase 6.3: `joined h = task_call();` / `pooled h = task_call();` -
  // built-in kind prefix; type is inferred as Task<T> from the RHS.
  // `joined` / `pooled` used to arrive with a parser-stamped `builtin`
  // marker because they were lexer keywords. They are ordinary kind names
  // now, so the task-binding path keys on the name resolving to a builtin
  // kind instead.
  const prefixName = node.kindPrefix?.name ?? null;
  // The task-handle binding forms (`joined d = f()` / `pooled h = f()`)
  // never carry a type annotation - Task<T> is compiler-internal, and the
  // binding infers it from the task call on the right.
  //
  // That absence is the discriminator. The same `pooled` kind also applies
  // at FIELD position and to a binding of a struct that propagates it
  // (`pooled j: Job = launch(6);`), which is an ordinary kind binding and
  // must NOT be routed through the task path - it has no task call to
  // infer from.
  //
  // The kind is matched by its CLAUSES, not its name. `taskSatisfiesKind` is
  // true exactly when every trait the kind requires is one `Task<T>` provides
  // (Shared / Joinable), which is the real question being asked here: "can a
  // task handle satisfy this kind?" Keying on the names `joined` / `pooled`
  // meant a user kind declaring the identical clauses was rejected on the one
  // type its `refcounted` clause was designed for. The PARAMETER path has
  // always used taskSatisfiesKind; this brings the binding path in line.
  const prefixKind = prefixName
    ? (resolveKindByName(prefixName, ctx.typeContext) ?? lookupCoreKind(prefixName))
    : null;
  if (
    prefixKind &&
    node.typeAnnotation == null &&
    taskSatisfiesKind(prefixKind)
  ) {
    return checkTaskBuiltinBinding(node, scope, ctx, prefixKind);
  }

  // No annotation: infer the binding's type from its initializer. The parser
  // guarantees a module-level binding without an annotation has an initializer;
  // a local one might not, which is an error (nothing to infer from).
  const inferred = node.typeAnnotation === null;
  let declaredType;
  if (inferred) {
    if (!node.assignment) {
      pushError(ctx.errors, node,
        `binding "${node.name}" needs either a type annotation or an initializer to infer from`);
      declaredType = ErrorType();
    } else {
      const rhsType = resolveExprType(node.assignment, scope, ctx);
      declaredType = concretizeInferred(rhsType) ?? ErrorType();
      // resolveExprType already reports a specific error for expressions that
      // cannot be typed without a target (bare struct literals, empty array
      // literals); add an inference-focused hint pointing at the fix.
      if (declaredType.kind === typeKinds.error) {
        pushError(ctx.errors, node,
          `cannot infer a type for "${node.name}"; add an explicit type annotation`);
      } else if (
        declaredType.kind === typeKinds.array &&
        node.assignment.kind === ASTNodeKind.ARRAY_LITERAL
      ) {
        // resolveArrayLiteral leaves the literal (and its elements) typed as
        // `untypedInt[]`/`untypedFloat[]`; re-pin them to the concretized
        // element type so codegen sees a concrete element type, matching the
        // annotated `const xs: int32[] = [...]` path.
        checkArrayLiteralWithElemType(node.assignment, declaredType.elem, scope, ctx);
      }
    }
  } else {
    declaredType =
      resolveTypeInCtx(node.typeAnnotation, ctx.typeContext) ?? ErrorType();
    if (declaredType.kind === typeKinds.error) {
      pushError(ctx.errors, node, `unknown type "${formatAnnotation(node.typeAnnotation)}"`);
    }
  }
  // When the type was inferred from a call return (or any expression site), the
  // struct may be a shell with empty implementsTraits; canonicalize so the kind
  // machinery below (and kindCheck / codegen) sees the resolved trait list.
  // No-op for the annotation path, which already yields the canonical struct.
  declaredType = canonicalizeStruct(declaredType, ctx);
  node.resolvedType = declaredType;

  // Resolve kind prefix (phase 6.1, args added in 6.5). null on plain let/const.
  let kindType = null;
  let kindApp = null;
  if (node.kindPrefix) {
    kindType =
      ctx.typeContext.kindTable?.get(node.kindPrefix.name) ??
      lookupCoreKind(node.kindPrefix.name) ??
      null;
    if (!kindType) {
      pushError(ctx.errors, node, `unknown kind "${node.kindPrefix.name}"`);
    } else {
      // Phase 6.5: validate kind arguments (must be constants).
      const args = node.kindPrefix.args ?? [];
      if (args.length !== kindType.params.length) {
        pushError(ctx.errors, node,
          `kind '${kindType.name}' expects ${kindType.params.length} argument(s), got ${args.length}`);
      } else {
        const resolved = [];
        let ok = true;
        for (const a of args) {
          if (a.kind !== ASTNodeKind.INT_LITERAL) {
            pushError(ctx.errors, a,
              `kind argument must be a constant in phase 6.5`);
            ok = false;
            break;
          }
          resolved.push(a.value);
        }
        if (ok) kindApp = new KindApplication(kindType, resolved);
      }
    }
  }
  node.resolvedKindType = kindType;
  node.resolvedKindApplication = kindApp;

  if (node.assignment && !inferred) {
    // Generic function calls need to flow through checkInitializer so the
    // declared LHS type can drive return-type inference (e.g. heapAlloc).
    // The eager resolveExprType inside isTaskCallReturningType would otherwise
    // error out before bidirectional inference gets a chance.
    const isGenericCall =
      node.assignment.kind === ASTNodeKind.CALL_EXPRESSION &&
      ((typeof node.assignment.callee === "string" &&
        lookupGenericFunc(node.assignment.callee, ctx) !== null) ||
        isNamespaceGenericCall(node.assignment, ctx));
    // Phase 6.3: immediate task call - `const x: T = compute(...);` where
    // compute returns Task<T>. Auto-spawn+wait inline; binding sees T.
    if (
      !kindType &&
      !isGenericCall &&
      node.assignment.kind === ASTNodeKind.CALL_EXPRESSION &&
      isTaskCallReturningType(node.assignment, declaredType, scope, ctx)
    ) {
      // resolveCall already populated node.assignment.resolvedType = Task<T>.
      node.immediateTaskCall = true;
    } else if (
      declaredType.kind === typeKinds.array &&
      node.assignment.kind === ASTNodeKind.ARRAY_LITERAL
    ) {
      checkArrayLiteralWithElemType(node.assignment, declaredType.elem, scope, ctx);
    } else {
      checkInitializer(
        node.assignment,
        declaredType,
        scope,
        ctx,
        (rhsType) =>
          `cannot assign ${formatType(rhsType)} to ${formatType(declaredType)} in initializer of "${node.name}"`,
      );
    }
  }

  if (kindType) {
    validateKindBinding(node, kindType, declaredType, scope, ctx);
  } else {
    if (node.trailingBlock) {
      // trailingBlock only legal for kind-prefixed bindings.
      pushError(ctx.errors, node,
        `trailing block on binding "${node.name}" requires a kind prefix that declares ownsBlock`);
    }
    // Phase 6.2: reject aliasing a scoped binding under a non-scoped name.
    if (node.assignment) {
      const escapedName = findScopedIdentInExpr(node.assignment, scope);
      if (escapedName) {
        pushError(ctx.errors, node,
          `cannot alias a scoped binding under a non-scoped name (phase 6.2): '${escapedName}' has mustNotEscape`);
      }
    }
  }

  const declKind = node.kind === ASTNodeKind.CONST_DECL ? "const" : "let";

  // For trailing-block form, the binding is scoped to the inner block only;
  // declare it there and walk the block's body, then return without leaking
  // the name into the enclosing scope. An anonymous region block has no
  // user-visible name, so we open the inner scope and walk it but never
  // declare the synthetic `$region$N` name (the value is unreferenceable; the
  // cleanup machinery reaches it by name in codegen, not via scope lookup).
  if (kindType && node.trailingBlock) {
    const inner = pushScope(scope);
    if (!node.anonymousRegion) {
      declareInScope(inner, node.name, declaredType, declKind, node, ctx.errors, kindType);
    }
    for (const s of node.trailingBlock.body) {
      validateStatement(s, inner, ctx);
    }
    popScope(inner, ctx.errors);
    return;
  }

  // Implicit-block form (no trailing `{}`): the binding lives in the enclosing
  // scope and its cleanup fires at scope end (LIFO). Anonymous region bindings
  // skip the declaration for the same reason as above.
  if (!node.anonymousRegion) {
    declareInScope(scope, node.name, declaredType, declKind, node, ctx.errors, kindType);
  }
}

// Phase 6.3: typecheck `joined h = task_call();` / `pooled h = task_call();`.
// The RHS must be a call to a task function (whose external return type is
// Task<T>); the binding's resolved type is Task<T>.
// Phase 6.4: `pooled` additionally accepts a Task<T>-typed expression (e.g.
// `pooled h3 = h2;` where h2 is pooled). Codegen detects the copy site and
// emits a retain. `joined` still requires a fresh task call.
function checkTaskBuiltinBinding(node, scope, ctx, kt) {
  const builtinName = kt.name;
  node.resolvedKindType = kt;
  node.builtinKind = builtinName;
  // The storage/cleanup shape, derived from the kind's clauses rather than its
  // name - this is what codegen switches on. A `refcounted` kind heap
  // allocates and may be copied (each copy retains, scope exit releases); a
  // kind without it owns the handle outright, lives in a stack slot, and must
  // bind a FRESH call because there is no refcount to share.
  const isRefcounted = isRefcountedKind(kt);
  node.taskHandleMode = isRefcounted ? "refcount" : "join";

  if (!node.assignment) {
    pushError(ctx.errors, node,
      `${builtinName} binding "${node.name}" requires an initializer`);
    node.resolvedType = ErrorType();
    declareInScope(scope, node.name, ErrorType(), "const", node, ctx.errors, kt);
    return;
  }

  const rhsType = resolveExprType(node.assignment, scope, ctx);
  if (rhsType.kind === typeKinds.error) {
    node.resolvedType = ErrorType();
    declareInScope(scope, node.name, ErrorType(), "const", node, ctx.errors, kt);
    return;
  }
  if (rhsType.kind !== typeKinds.task) {
    pushError(ctx.errors, node,
      `${builtinName} binding "${node.name}" requires a task call RHS, got ${formatType(rhsType)}`);
    node.resolvedType = ErrorType();
    declareInScope(scope, node.name, ErrorType(), "const", node, ctx.errors, kt);
    return;
  }

  // joined requires a fresh task call (allocates on stack, can't copy).
  // pooled accepts both task calls and Task<T>-typed copies (phase 6.4).
  const rhsIsCall = node.assignment.kind === ASTNodeKind.CALL_EXPRESSION;
  if (!isRefcounted && !rhsIsCall) {
    pushError(ctx.errors, node,
      `${builtinName} binding "${node.name}" requires a task call RHS, got ${formatType(rhsType)}`);
    node.resolvedType = ErrorType();
    declareInScope(scope, node.name, ErrorType(), "const", node, ctx.errors, kt);
    return;
  }
  // Mark refcounted-copy bindings so codegen branches between submit-vs-retain.
  if (isRefcounted && !rhsIsCall) {
    node.pooledCopy = true;
  }

  node.resolvedType = rhsType;
  declareInScope(scope, node.name, rhsType, "const", node, ctx.errors, kt);
}

// Returns true iff `callExpr` is a CALL_EXPRESSION whose resolved return type
// is Task<targetType>. resolveExprType is invoked as a side effect.
function isTaskCallReturningType(callExpr, targetType, scope, ctx) {
  // Lookahead-only check based on the callee - does the named function have
  // a TaskType return? We must invoke resolveExprType for arity/type checking,
  // but we want to avoid emitting a spurious "Task<T> not assignable to T" error.
  const rhsType = resolveExprType(callExpr, scope, ctx);
  if (rhsType.kind !== typeKinds.task) return false;
  if (targetType.kind === typeKinds.error) return false;
  if (!typesEqual(rhsType.resultType, targetType)) {
    pushError(ctx.errors, callExpr,
      `task call returns ${formatType(rhsType)}, cannot immediately bind to ${formatType(targetType)}`);
    return true; // we still own this site; suppress the cascading mismatch
  }
  return true;
}

// Phase 6.2: Walk an expression and return the name of the first IDENT whose
// scope binding carries mustNotEscape (a scoped sentinel). Returns null if none.
function findScopedIdentInExpr(expr, scope) {
  if (!expr || typeof expr !== "object") return null;
  if (expr.kind === ASTNodeKind.IDENT) {
    const binding = lookupInScope(scope, expr.name);
    if (binding?.kindType?.mustNotEscape) return expr.name;
    return null;
  }
  // REF_EXPRESSION wrapping an IDENT: also an alias
  if (expr.kind === ASTNodeKind.REF_EXPRESSION) {
    return findScopedIdentInExpr(expr.operand, scope);
  }
  // `wait h` is NOT an alias of `h`: it evaluates to the RESULT, a plain
  // value, and the handle itself stays put. Without this carve-out
  // `joined`'s `mustNotEscape scope` clause rejects the ordinary
  // `let v = wait d;` that is the entire point of a joined binding.
  if (expr.kind === ASTNodeKind.WAIT_EXPRESSION) {
    return null;
  }
  // Recursively check children
  for (const val of Object.values(expr)) {
    if (Array.isArray(val)) {
      for (const v of val) {
        const found = findScopedIdentInExpr(v, scope);
        if (found) return found;
      }
    } else if (val && typeof val === "object" && val.kind) {
      const found = findScopedIdentInExpr(val, scope);
      if (found) return found;
    }
  }
  return null;
}

// Validate that a kind-prefixed binding satisfies the kind's clause set.
function validateKindBinding(node, kindType, declaredType, scope, ctx) {
  const isAnon = node.anonymousRegion === true;
  // Human-readable subject for diagnostics: an anonymous region block has no
  // user-visible name (the `$region$N` synthetic name would only confuse).
  const subject = isAnon
    ? `the anonymous '${kindType.name}' region`
    : `binding "${node.name}"`;

  // Region kinds vs. value kinds are disjoint at the use site:
  //   - anonymous block form (`KIND EXPR { ... }` / `KIND EXPR;`) requires a
  //     region kind (`appliesTo region`);
  //   - named binding form (`KIND name = EXPR ...`) requires a value kind
  //     (`appliesTo binding`), and a region kind is rejected (it has no value
  //     to name).
  if (isAnon) {
    if (!kindType.appliesTo.has("region")) {
      const sites = [...kindType.appliesTo].join(", ") || "(none)";
      pushError(ctx.errors, node,
        `kind '${kindType.name}' does not apply to a region (declared appliesTo: ${sites}); the anonymous '${kindType.name} EXPR { ... }' form requires a region kind. To use it as a named resource, give it a name: '${kindType.name} name = EXPR ...'`);
    }
  } else if (kindType.appliesTo.has("region")) {
    pushError(ctx.errors, node,
      `kind '${kindType.name}' applies to a region and cannot be bound to a name; drop the name and use the anonymous form: '${kindType.name} EXPR { ... }' (or '${kindType.name} EXPR;')`);
  } else if (!kindType.appliesTo.has("binding")) {
    // Phase 6.2: check appliesTo includes "binding".
    const sites = [...kindType.appliesTo].join(", ") || "(none)";
    pushError(ctx.errors, node,
      `kind '${kindType.name}' does not apply to bindings (declared appliesTo: ${sites})`);
  }

  // Re-bind under a kind: forbidden. If the RHS is an IDENT that
  // resolves to a binding which already carries a kindType, reject.
  if (node.assignment?.kind === ASTNodeKind.IDENT) {
    const existing = lookupInScope(scope, node.assignment.name);
    if (existing?.kindType) {
      pushError(ctx.errors, node,
        `cannot re-bind a kind-tracked value under a new kind in phase 6.1`);
    }
  }

  // The value under a kind binding must be a plain nominal value (not a
  // ref, not an array, not a primitive). Phase 13.B: variants count too -
  // a variant that implements the kind's required traits binds the same
  // way a struct would.
  if (declaredType.kind === typeKinds.error) return;
  if (
    declaredType.kind !== typeKinds.struct &&
    declaredType.kind !== typeKinds.variant
  ) {
    pushError(ctx.errors, node,
      `kind "${kindType.name}" can only apply to struct or variant values, got ${formatType(declaredType)}`);
    return;
  }

  // Phase 6.4 strict propagates: a struct that propagates this kind satisfies
  // the kind's requirement via propagated fields, even if it does not
  // implement the required traits directly. Skip the direct-implements check
  // in that case - the obligation flows via the field walk in kindCheck.
  const structPropagatesThisKind = (declaredType.propagatedKinds ?? []).some(
    (a) => (a.kindType ?? a) === kindType,
  );
  if (!structPropagatesThisKind) {
    // The RHS struct must implement every required trait.
    for (const reqTrait of kindType.requires) {
      const implementsIt = (declaredType.implementsTraits ?? []).some(
        (t) => t.name === reqTrait.name && (t.moduleId ?? null) === (reqTrait.moduleId ?? null),
      );
      if (!implementsIt) {
        pushError(ctx.errors, node,
          `${subject} has kind "${kindType.name}" which requires "${reqTrait.name}", but type ${formatType(declaredType)} does not implement "${reqTrait.name}"`);
      }
    }
  }

  // Trailing block is only legal when the kind declares ownsBlock.
  if (node.trailingBlock && !kindType.ownsBlock) {
    pushError(ctx.errors, node,
      `kind "${kindType.name}" does not declare ownsBlock; trailing block is not allowed`);
  }
}

// Check an array literal against a known element type (used when the declared
// type provides the target element type).
function checkArrayLiteralWithElemType(litNode, elemType, scope, ctx) {
  if (litNode.elements.length === 0) {
    // Empty literal is OK when element type is known from declaration
    litNode.resolvedType = { kind: typeKinds.array, elem: elemType };
    litNode.knownElemType = elemType;
    return;
  }
  for (let i = 0; i < litNode.elements.length; i++) {
    checkInitializer(
      litNode.elements[i],
      elemType,
      scope,
      ctx,
      (actualType) =>
        `array literal element ${i} has type ${formatType(actualType)}, expected ${formatType(elemType)}`,
    );
  }
  litNode.resolvedType = ArrayType(elemType);
  litNode.knownElemType = elemType;
}

// `const { a, b } = expr;` / `let { a, b } = expr;`
function checkDestructureDecl(node, scope, ctx) {
  const declKind = node.declKind === ASTNodeKind.CONST_DECL ? "const" : "let";
  const rhsType = resolveExprType(node.assignment, scope, ctx);

  if (rhsType.kind === typeKinds.error) {
    for (const n of node.names) {
      declareInScope(scope, n, ErrorType(), declKind, node, ctx.errors);
    }
    return;
  }

  if (rhsType.kind !== typeKinds.struct) {
    pushError(
      ctx.errors,
      node,
      `cannot destructure non-struct type ${formatType(rhsType)}`,
    );
    for (const n of node.names) {
      declareInScope(scope, n, ErrorType(), declKind, node, ctx.errors);
    }
    return;
  }

  const fieldMap = new Map(
    (rhsType.fields ?? []).map((f) => [f.name, f.type]),
  );
  const seenNames = new Set();
  for (const name of node.names) {
    if (seenNames.has(name)) {
      pushError(ctx.errors, node, `duplicate name "${name}" in destructure`);
      continue;
    }
    seenNames.add(name);
    const fieldType = fieldMap.get(name);
    if (!fieldType) {
      pushError(
        ctx.errors,
        node,
        `type ${formatType(rhsType)} has no field "${name}"`,
      );
      declareInScope(scope, name, ErrorType(), declKind, node, ctx.errors);
      continue;
    }
    declareInScope(scope, name, fieldType, declKind, node, ctx.errors);
  }
}

// Statement position is a value context with NO target type, so an
// untyped-literal *expression* (`_ = 1 + 2;`, or a bare `1 + 2;`) has nothing
// to pin it and reaches codegen with `resolvedType` still untypedInt, where
// `llvmType` throws. Same hole, same fix, as the template-interpolation case
// in resolveTemplateLiteral: default it the way an un-annotated `let` does
// (int32 / float64) and push that down through the operands.
//
// A BARE literal (`_ = 1;`) survives without this because codegen defends
// itself at INT_LITERAL/FLOAT_LITERAL - it is only the compound case that has
// no defence. Found by untypedGuard.js, which is exactly what it is for.
function pinContextFreeExpr(valueNode, valueType, ctx) {
  const isUntypedInt = valueType?.kind === typeKinds.untypedInt;
  const isUntypedFloat = valueType?.kind === typeKinds.untypedFloat;
  if (!isUntypedInt && !isUntypedFloat) return valueType;
  const pinned = isUntypedInt
    ? PrimType(primAnnotations.int32)
    : PrimType(primAnnotations.float64);
  coerceUntypedLiteralToTyped(valueNode, valueType, pinned, ctx.errors);
  return valueNode.resolvedType ?? pinned;
}

function checkDiscardStatement(node, scope, ctx) {
  const t = resolveExprType(node.value, scope, ctx);
  pinContextFreeExpr(node.value, t, ctx);
}

function checkExpressionStatement(node, scope, ctx) {
  const t = resolveExprType(node.value, scope, ctx);
  return pinContextFreeExpr(node.value, t, ctx);
}

function checkReturn(node, scope, ctx) {
  if (!node.value) {
    if (ctx.funcReturnType.kind !== "void") {
      pushError(
        ctx.errors,
        node,
        `function "${ctx.funcName}" must return ${formatType(ctx.funcReturnType)}, go bare return`,
      );
    }
    return;
  }
  checkInitializer(
    node.value,
    ctx.funcReturnType,
    scope,
    ctx,
    (returnExprType) =>
      `cannot return ${formatType(returnExprType)} from "${ctx.funcName}" returning ${formatType(ctx.funcReturnType)}`,
  );
}

function checkIf(node, scope, ctx) {
  requireBoolCondition(node, "if-statement", scope, ctx);
  validateStatement(node.body, scope, ctx);
  if (node.elseBody) {
    validateStatement(node.elseBody, scope, ctx);
  }
}

function checkWhile(node, scope, ctx) {
  requireBoolCondition(node, "while-statement", scope, ctx);
  const loopCtx = { ...ctx, inLoop: true };
  validateStatement(node.body, scope, loopCtx);
}

// Comparison operators whose *other* operand can name an unannotated
// counter's type. `==`/`!=` are included because a countdown-to-sentinel loop
// (`for (let i = n; i != 0; i -= 1)`) is as much a type constraint as `<`.
const COUNTER_PINNING_OPS = new Set(["lt", "lte", "gt", "gte", "eqeq", "neq"]);

// True if `n` reads the loop's counter by name - the anchor that tells us
// which side of the condition is the counter and which side can type it.
function isCounterRead(n, counterName) {
  return n?.kind === ASTNodeKind.IDENT && n.name === counterName;
}

// The type an unannotated `let` counter takes when its initializer is a bare
// integer/float literal. The ordinary binding rule (untypedInt -> int32) is
// wrong here often enough to be a papercut: virtually every counted loop
// compares against a length, and `int32 < usize` is not implicitly widened
// (see unifyArith), so `for (let i = 0; i < xs.len; i += 1)` would fail on the
// condition the counter exists to serve. So when the condition compares the
// counter against a concrete numeric operand, that operand names the counter's
// type. Returns null when the condition has no such shape, leaving the
// ordinary literal default in place.
//
// `probeCtx` carries a throwaway error channel - see declareForCounter.
function counterTypeFromCondition(node, scope, probeCtx) {
  const cond = node.cond;
  if (cond?.kind !== ASTNodeKind.BINARY_EXPRESSION) return null;
  if (!COUNTER_PINNING_OPS.has(cond.op)) return null;

  let other = null;
  if (isCounterRead(cond.left, node.initIdent)) other = cond.right;
  else if (isCounterRead(cond.right, node.initIdent)) other = cond.left;
  if (!other) return null;

  const t = resolveExprType(other, scope, probeCtx);
  return t.kind === typeKinds.prim && isNumeric(t) ? t : null;
}

// Resolve the type of a `for (let i = ...; ...)` counter and declare it in the
// loop's own scope.
function declareForCounter(node, loopScope, ctx) {
  let counterType;
  if (node.initTypeAnnotation) {
    counterType =
      resolveTypeInCtx(node.initTypeAnnotation, ctx.typeContext) ?? ErrorType();
    if (counterType.kind === typeKinds.error) {
      pushError(ctx.errors, node,
        `unknown type "${formatAnnotation(node.initTypeAnnotation)}"`);
    }
  } else {
    // Probe the initializer on a throwaway error channel: checkInitializer
    // below is what actually reports on it, and one broken initializer should
    // produce one diagnostic, not two.
    const probeCtx = { ...ctx, errors: [] };
    const initType = resolveExprType(node.initExpr, loopScope, probeCtx);
    if (initType.kind === typeKinds.untypedInt || initType.kind === typeKinds.untypedFloat) {
      counterType =
        counterTypeFromCondition(node, loopScope, probeCtx) ??
        concretizeInferred(initType);
    } else {
      counterType = canonicalizeStruct(initType, ctx);
    }
    if (counterType.kind === typeKinds.error) {
      pushError(ctx.errors, node,
        `cannot infer a type for for-loop counter "${node.initIdent}"; add an explicit type annotation`);
    }
  }

  // Runs for both paths: checks assignability and, crucially, pins an untyped
  // literal initializer to the counter's type so codegen never sees an
  // untypedInt in the loop's init store.
  checkInitializer(
    node.initExpr,
    counterType,
    loopScope,
    ctx,
    (rhsType) =>
      `cannot assign ${formatType(rhsType)} to ${formatType(counterType)} in initializer of for-loop counter "${node.initIdent}"`,
  );

  node.resolvedCounterType = counterType;
  declareInScope(
    loopScope, node.initIdent, counterType, "let", node, ctx.errors, null,
  );
}

// Two head shapes:
//   for (i = 0; i < n; i = i + 1)       counter declared before the loop
//   for (let i = 0; i < n; i += 1)      counter scoped TO the loop
// The `let` form opens a scope covering the head and the body, so the counter
// neither leaks into the enclosing scope nor collides with a same-named
// binding out there.
function checkForLoop(node, scope, ctx) {
  const loopScope = node.initDeclares ? pushScope(scope) : scope;

  if (node.initDeclares) {
    declareForCounter(node, loopScope, ctx);
  } else {
    // init: initIdent must be in scope, initExpr must match its type
    const initBinding = lookupInScope(loopScope, node.initIdent);
    if (!initBinding) {
      pushError(ctx.errors, node,
        `for-loop variable "${node.initIdent}" is not declared - declare it before the loop, or write "for (let ${node.initIdent} = ...; ...)"`);
    } else {
      const initExprType = resolveExprType(node.initExpr, loopScope, ctx);
      checkAssignable(initBinding.type, initExprType, node, ctx);
    }
  }

  // cond: must be bool
  const condType = resolveExprType(node.cond, loopScope, ctx);
  if (condType.kind !== typeKinds.prim || condType.name !== "bool") {
    if (condType.kind !== typeKinds.error) {
      pushError(ctx.errors, node.cond,
        `for-loop condition must be bool, found ${formatType(condType)}`);
    }
  }

  // step: stepIdent must be in scope, stepExpr must match its type
  const stepBinding = lookupInScope(loopScope, node.stepIdent);
  if (!stepBinding) {
    pushError(ctx.errors, node,
      `for-loop step variable "${node.stepIdent}" is not declared`);
  } else {
    const stepExprType = resolveExprType(node.stepExpr, loopScope, ctx);
    checkAssignable(stepBinding.type, stepExprType, node, ctx);
  }

  // body with inLoop: true
  const loopCtx = { ...ctx, inLoop: true };
  validateStatement(node.body, loopScope, loopCtx);

  if (node.initDeclares) popScope(loopScope, ctx.errors);
}

// Phase 9.D + 10.B: `for item in xs { ... }`. The RHS may be either:
//   - An array expression (`T[]`): the fast path. The element type T drives
//     the body binding; codegen walks the fat-pointer.
//   - A struct implementing `Iterable<U>` (Phase 10.B): the loop desugars
//     to a `while (true) { switch (Iterable.next(ref iter)) { ... } }` over
//     `IterStep<U>`. The U from the impl's trait args drives the body binding.
function checkForInLoop(node, scope, ctx) {
  let iterType = resolveExprType(node.iterExpr, scope, ctx);
  let elemType = ErrorType();
  let iterableImpl = null;
  if (iterType.kind === typeKinds.array) {
    elemType = iterType.elem;
  } else if (iterType.kind === typeKinds.struct) {
    // The struct type captured from an expression site (e.g. a function-call
    // return) may be the pass-A shell - re-fetch the canonical version so we
    // see the fully-resolved implementsTraits/methods. Goes through
    // canonicalizeStruct (not just the local structTable) so an iterator
    // returned from ANOTHER module's function resolves too - that is what
    // `for i in 0..n` needs, since `..` lowers to a call into
    // std/core/range.yoop.
    iterType = canonicalizeStruct(iterType, ctx);
    const iterableTrait = (iterType.implementsTraits ?? []).find(
      (t) => t.name === "Iterable",
    );
    if (iterableTrait) {
      const nextSig = iterType.methods?.get("next");
      const retType = nextSig?.returnType;
      if (
        retType &&
        retType.kind === typeKinds.variant &&
        retType.variants?.has("Yield") &&
        retType.variants?.has("Done")
      ) {
        const yieldVariant = retType.variants.get("Yield");
        if (
          yieldVariant.fields &&
          yieldVariant.fields.length === 1 &&
          yieldVariant.fields[0].name === "value"
        ) {
          elemType = yieldVariant.fields[0].type;
          iterableImpl = {
            mangledNextName: mangleTraitMethod(iterType, "Iterable", "next"),
            iterStepType: retType,
          };
        } else {
          pushError(
            ctx.errors,
            node.iterExpr,
            `Iterable.next must return IterStep<T> with a single-field 'Yield { value: T }' variant`,
          );
        }
      } else {
        pushError(
          ctx.errors,
          node.iterExpr,
          `Iterable.next must return an IterStep<T> variant with Yield/Done cases`,
        );
      }
    } else {
      pushError(
        ctx.errors,
        node.iterExpr,
        `type ${formatType(iterType)} is not iterable - expected an array or a type implementing Iterable<T>`,
      );
    }
  } else if (iterType.kind !== typeKinds.error) {
    pushError(
      ctx.errors,
      node.iterExpr,
      `'for ... in' requires an array or a type implementing Iterable<T>; got ${formatType(iterType)}`,
    );
  }
  node.resolvedElemType = elemType;
  node.resolvedIterType = iterType;
  node.iterableImpl = iterableImpl;

  // The loop variable is scoped to the body only. Open a scope, declare it,
  // walk the body's statements, then pop. This mirrors the trailing-block
  // pattern in checkLetOrConst.
  const inner = pushScope(scope);
  declareInScope(inner, node.loopVar, elemType, "const", node, ctx.errors);
  const loopCtx = { ...ctx, inLoop: true };
  if (node.body.kind === ASTNodeKind.BLOCK) {
    for (const s of node.body.body) {
      validateStatement(s, inner, loopCtx);
    }
  } else {
    validateStatement(node.body, inner, loopCtx);
  }
  popScope(inner, ctx.errors);
}

// Phase 7.5: typecheck a `switch` statement. Scrutinee is one of:
//   - integer / bool / char prim  → arms carry LITERAL_PATTERNs
//   - VariantType                    → arms carry VARIANT_PATTERNs
// Exhaustiveness is enforced when the scrutinee is a bool or an enum.
function checkSwitch(node, scope, ctx) {
  const scrutType = resolveExprType(node.scrutinee, scope, ctx);
  if (scrutType.kind === typeKinds.error) {
    // Walk arms for cascade reporting but skip pattern-level checks.
    for (const arm of node.arms) validateStatement(arm.body, scope, ctx);
    if (node.defaultArm) validateStatement(node.defaultArm, scope, ctx);
    return;
  }

  const isInt =
    scrutType.kind === typeKinds.prim &&
    (scrutType.name === "int8" ||
      scrutType.name === "int16" ||
      scrutType.name === "int32" ||
      scrutType.name === "int64" ||
      scrutType.name === "uint8" ||
      scrutType.name === "uint16" ||
      scrutType.name === "uint32" ||
      scrutType.name === "uint64" ||
      scrutType.name === "usize" ||
      scrutType.name === "isize" ||
      scrutType.name === "char");
  const isBool = scrutType.kind === typeKinds.prim && scrutType.name === "bool";
  const isVariant = scrutType.kind === typeKinds.variant;
  // Phase 12: value-enum scrutinee. Patterns use VARIANT_PATTERN with no
  // field bindings. Exhaustiveness checked only when the enum is "closed"
  // (no operator-derived cases).
  const isValueEnum = scrutType.kind === typeKinds.valueEnum;

  if (!isInt && !isBool && !isVariant && !isValueEnum) {
    pushError(
      ctx.errors,
      node.scrutinee,
      `switch scrutinee must be int, bool, char, a variant, or an enum type; got ${formatType(scrutType)}`,
    );
    for (const arm of node.arms) validateStatement(arm.body, scope, ctx);
    if (node.defaultArm) validateStatement(node.defaultArm, scope, ctx);
    return;
  }

  // A value-enum scrutinee must be integer-backed: `switch` lowers to the
  // LLVM `switch` instruction, whose condition must have integer type. A
  // string-backed enum (`enum Foo<string>`) would otherwise slip through
  // typecheck and emit `switch ptr ...` IR that clang rejects with a cryptic
  // "switch condition must have integer type". Reject it here with a real
  // diagnostic; use `==`/`!=` chains for string-backed enums instead.
  if (
    isValueEnum &&
    !(scrutType.underlying?.kind === typeKinds.prim &&
      isIntPrim(scrutType.underlying.name))
  ) {
    pushError(
      ctx.errors,
      node.scrutinee,
      `cannot switch over ${formatType(scrutType)}: its underlying type is ` +
        `${formatType(scrutType.underlying)}, but switch requires an ` +
        `integer-backed enum. Use if/else with == for string-backed enums.`,
    );
    for (const arm of node.arms) validateStatement(arm.body, scope, ctx);
    if (node.defaultArm) validateStatement(node.defaultArm, scope, ctx);
    return;
  }

  node.scrutineeType = scrutType;
  const seenLiterals = new Map(); // value -> arm index
  const seenVariants = new Set();
  const seenEnumCases = new Set();
  let sawAnyWildcardCase = false;

  for (const arm of node.arms) {
    let armPatternIsWildcard = false;

    for (const pat of arm.patterns) {
      if (pat.kind === ASTNodeKind.VARIANT_PATTERN && pat.isWildcard) {
        armPatternIsWildcard = true;
        continue;
      }
      if (pat.kind === ASTNodeKind.LITERAL_PATTERN) {
        if (!isInt && !isBool) {
          pushError(
            ctx.errors,
            pat,
            `literal patterns are only valid on int / bool / char scrutinees, not ${formatType(scrutType)}`,
          );
          continue;
        }
        if (isBool) {
          if (pat.literalKind !== "bool") {
            pushError(
              ctx.errors,
              pat,
              `pattern must be a bool literal to match a bool scrutinee`,
            );
            continue;
          }
        } else if (isInt) {
          if (pat.literalKind !== "int") {
            pushError(
              ctx.errors,
              pat,
              `pattern must be an integer literal to match ${formatType(scrutType)}`,
            );
            continue;
          }
        }
        if (seenLiterals.has(pat.value)) {
          pushError(
            ctx.errors,
            pat,
            `duplicate case value ${pat.value}`,
          );
        } else {
          seenLiterals.set(pat.value, true);
        }
        // Tag the pattern with the scrutinee's prim type so codegen knows
        // what LLVM integer width to emit.
        pat.resolvedType = scrutType;
        continue;
      }
      if (pat.kind === ASTNodeKind.VARIANT_PATTERN) {
        // Phase 12: value-enum dispatch. Patterns are `Foo.Bar` with no
        // field bindings; we match by value equality at codegen time.
        if (isValueEnum) {
          if (pat.enumName !== scrutType.name) {
            pushError(
              ctx.errors,
              pat,
              `pattern names enum "${pat.enumName}" but scrutinee has type ${formatType(scrutType)}`,
            );
            continue;
          }
          const enumCase = scrutType.cases.get(pat.variantName);
          if (!enumCase) {
            pushError(
              ctx.errors,
              pat,
              `enum "${scrutType.name}" has no case "${pat.variantName}"`,
            );
            continue;
          }
          if (pat.fieldBindings !== null && pat.fieldBindings.length > 0) {
            pushError(
              ctx.errors,
              pat,
              `value enum case "${scrutType.name}.${pat.variantName}" has no fields - drop the '{ ... }'`,
            );
            continue;
          }
          if (seenEnumCases.has(pat.variantName)) {
            pushError(
              ctx.errors,
              pat,
              `duplicate enum case pattern "${scrutType.name}.${pat.variantName}"`,
            );
          }
          seenEnumCases.add(pat.variantName);
          pat.resolvedValueEnumType = scrutType;
          pat.resolvedValueEnumCase = enumCase;
          continue;
        }
        if (!isVariant) {
          pushError(
            ctx.errors,
            pat,
            `variant case patterns are only valid on variant scrutinees, not ${formatType(scrutType)}`,
          );
          continue;
        }
        // Phase 10.A: scrutinee may be a generic-enum instantiation whose
        // mangled name differs from the user-written decl name. Match either
        // the concrete name or the generic decl's source name via the
        // registry-stamped genericInstance tag.
        const genericInstance = scrutType.genericInstance;
        let scrutDeclName = scrutType.name;
        if (genericInstance) {
          const decl = ctx.typeContext?.registry?.genericDeclById?.get(
            genericInstance.declId,
          );
          if (decl) scrutDeclName = decl.name;
        }
        if (pat.enumName !== scrutType.name && pat.enumName !== scrutDeclName) {
          pushError(
            ctx.errors,
            pat,
            `pattern names variant "${pat.enumName}" but scrutinee has type ${formatType(scrutType)}`,
          );
          continue;
        }
        const variant = scrutType.variants.get(pat.variantName);
        if (!variant) {
          pushError(
            ctx.errors,
            pat,
            `variant "${scrutType.name}" has no case "${pat.variantName}"`,
          );
          continue;
        }
        if (seenVariants.has(pat.variantName)) {
          pushError(
            ctx.errors,
            pat,
            `duplicate variant pattern for "${scrutType.name}.${pat.variantName}"`,
          );
        }
        seenVariants.add(pat.variantName);
        pat.resolvedVariantType = scrutType;
        pat.resolvedVariant = variant;
        // Field-binding shape: must match the variant's declared shape.
        if (variant.fields === null) {
          if (pat.fieldBindings !== null && pat.fieldBindings.length > 0) {
            pushError(
              ctx.errors,
              pat,
              `variant "${scrutType.name}.${pat.variantName}" has no payload - drop the '{ ... }'`,
            );
          }
        } else {
          if (pat.fieldBindings === null) {
            pushError(
              ctx.errors,
              pat,
              `variant "${scrutType.name}.${pat.variantName}" requires a payload pattern { ${variant.fields.map((f) => f.name).join(", ")} }`,
            );
          } else {
            const fieldMap = new Map();
            for (const f of variant.fields) fieldMap.set(f.name, f.type);
            const seenF = new Set();
            for (const fb of pat.fieldBindings) {
              if (fb.isWildcard && fb.fieldName === null) continue; // bare `_` placeholder
              if (seenF.has(fb.fieldName)) {
                pushError(
                  ctx.errors,
                  pat,
                  `duplicate field "${fb.fieldName}" in variant pattern`,
                );
                continue;
              }
              seenF.add(fb.fieldName);
              if (!fieldMap.has(fb.fieldName)) {
                pushError(
                  ctx.errors,
                  pat,
                  `variant "${scrutType.name}.${pat.variantName}" has no field "${fb.fieldName}"`,
                );
              }
            }
          }
        }
        continue;
      }
      pushError(
        ctx.errors,
        pat,
        `unsupported switch pattern node kind ${pat.kind}`,
      );
    }

    if (armPatternIsWildcard) sawAnyWildcardCase = true;

    // Push a fresh scope for the arm body. Variant-pattern field bindings
    // are declared in this scope before walking the body.
    const armScope = pushScope(scope);
    for (const pat of arm.patterns) {
      if (pat.kind !== ASTNodeKind.VARIANT_PATTERN) continue;
      if (pat.isWildcard) continue;
      const variant = pat.resolvedVariant;
      if (!variant || variant.fields === null) continue;
      if (!pat.fieldBindings) continue;
      for (const fb of pat.fieldBindings) {
        if (fb.isWildcard) continue;
        if (!fb.fieldName || !fb.bindingName) continue;
        const fieldDef = variant.fields.find((f) => f.name === fb.fieldName);
        if (!fieldDef) continue;
        // canonicalizeStruct for the same reason inferred `let` bindings do it:
        // a payload field type resolved while the payload's own module was
        // mid-pass can be a shell whose `implementsTraits` is still empty, and
        // the binding would then fail `Disposable.dispose(ref x)` on a type
        // that plainly does implement it. Swapping in the structTable entry
        // gives the arm the populated type. No-op for non-structs.
        declareInScope(
          armScope,
          fb.bindingName,
          canonicalizeStruct(fieldDef.type, ctx),
          "const",
          pat,
          ctx.errors,
        );
      }
    }
    const armCtx = { ...ctx, inSwitch: true };
    validateStatement(arm.body, armScope, armCtx);
    popScope(armScope, ctx.errors);
  }

  if (node.defaultArm) {
    const dctx = { ...ctx, inSwitch: true };
    validateStatement(node.defaultArm, scope, dctx);
  }

  // Exhaustiveness checks.
  if (!node.defaultArm && !sawAnyWildcardCase) {
    if (isBool) {
      const haveTrue = [...seenLiterals.keys()].includes(true);
      const haveFalse = [...seenLiterals.keys()].includes(false);
      if (!(haveTrue && haveFalse)) {
        pushError(
          ctx.errors,
          node,
          `switch over bool is not exhaustive - add 'default' or list both true and false`,
        );
      }
    } else if (isVariant) {
      const allVariants = [...scrutType.variants.keys()];
      const missing = allVariants.filter((v) => !seenVariants.has(v));
      if (missing.length > 0) {
        pushError(
          ctx.errors,
          node,
          `switch over ${formatType(scrutType)} is not exhaustive - missing variants: ${missing.join(", ")}`,
        );
      }
    } else if (isValueEnum) {
      // Phase 12: an "open" enum (any case derived via bitwise ops) requires
      // a `default` since the reachable set is no longer the named cases. A
      // closed enum (every case is a literal) gets exhaustiveness over its
      // named cases.
      if (scrutType.isOpen) {
        pushError(
          ctx.errors,
          node,
          `switch over open enum "${scrutType.name}" requires a 'default' case - one or more cases are derived via bitwise operators, so values may fall outside the named set`,
        );
      } else {
        const allCases = [...scrutType.cases.keys()];
        const missing = allCases.filter((c) => !seenEnumCases.has(c));
        if (missing.length > 0) {
          pushError(
            ctx.errors,
            node,
            `switch over ${formatType(scrutType)} is not exhaustive - missing cases: ${missing.join(", ")}`,
          );
        }
      }
    } else if (isInt) {
      pushError(
        ctx.errors,
        node,
        `switch over ${formatType(scrutType)} requires a 'default' clause`,
      );
    }
  }

  // Phase 10.E.3: record whether the arms cover every reachable value, so
  // `alwaysDiverges` (diverge.js) can decide that an arms-all-return switch
  // leaves no fallthrough path. Every branch above errors on a non-covering
  // switch, so a stamped-true node that was actually short a case can only
  // occur in a build that is already failing.
  node.isExhaustive =
    Boolean(node.defaultArm) ||
    sawAnyWildcardCase ||
    isBool ||
    isVariant ||
    isValueEnum;
}

function checkBreak(node, ctx) {
  // Phase 7.5: `break` is also valid inside a switch arm - it falls out of the
  // switch. We track the switch context independently from `inLoop` because
  // `continue` inside a switch arm still targets the enclosing loop.
  if (!ctx.inLoop && !ctx.inSwitch) {
    pushError(ctx.errors, node, `'break' is not inside a loop or switch`);
  }
}

function checkContinue(node, ctx) {
  if (!ctx.inLoop) {
    pushError(ctx.errors, node, `'continue' is not inside a loop`);
  }
}

// Check that a value expression is assignable to a binding type (used by for-loop init/step).
function checkAssignable(bindingType, exprType, node, ctx) {
  if (exprType.kind === typeKinds.error) return; // suppress cascade
  if (!isAssignable(bindingType, exprType)) {
    pushError(ctx.errors, node,
      `for-loop assignment: cannot assign ${formatType(exprType)} to ${formatType(bindingType)}`);
  }
}

function requireBoolCondition(node, label, scope, ctx) {
  const boolType = resolveTypeFromName(
    primAnnotations.bool,
    ctx.typeContext.structTable,
  );
  const exprType = resolveExprType(node.expression, scope, ctx);
  if (!typesEqual(exprType, boolType)) {
    pushError(
      ctx.errors,
      node,
      `${label} must be a bool type expression, found ${formatType(exprType)}`,
    );
  }
}
