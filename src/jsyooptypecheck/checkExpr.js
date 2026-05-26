// Expression typechecking.
//
// resolveExprType is a thin dispatcher: each AST node kind delegates to a
// small named helper (resolveIdent, resolveBinary, resolveCall, ...). Every
// helper sets node.resolvedType and returns the same Type so its caller can
// chain on the result.
//
// Two cross-cutting helpers live in this file because both are about
// "checking an expression against a known target type":
//
//   - checkInitializer: the one place that handles every "value must fit
//     this type" check in the language - let/const initializers, return
//     values, assignments, call args, and struct-literal field values. It
//     folds (1) struct-literal pinning OR plain expression resolution, (2)
//     assignability checking, and (3) untyped-literal coercion into one call.
//
//   - pinStructLiteral: type-checks `Foo { x: 1, y: 2 }` against a known
//     target struct type. resolveExprType can't type a struct literal alone
//     (we don't infer struct types from field shapes), so any context that
//     has a target type calls pinStructLiteral via checkInitializer instead.


import { ASTNodeKind } from "../contracts.js";
import {
  ArrayType,
  ErrorType,
  FuncType,
  PrimType,
  RefType,
  TraitSelfPlaceholder,
  UnsafePtrType,
  UntypedFloatType,
  UntypedIntType,
  UntypedNullType,
  VoidType,
  isCastableTo,
  isIntPrim,
  primAnnotations,
  primTypeFromName,
  resolveTypeFromName,
  substituteTypeParams,
  typeKinds,
  typesEqual,
} from "./types.js";
import { pushError, formatType } from "./errors.js";
import { lookupInScope } from "./scope.js";
import {
  isFallibleVariant,
  strippedVariantOkType,
  variantErrPayloadType,
} from "./fallible.js";
import {
  coerceUntypedLiteralToTyped,
  isAssignable,
  isNumeric,
  unifyArith,
} from "./coerce.js";
import { instantiateVariant, instantiateFunc, mangleType } from "./instantiate.js";
import { checkBoundSatisfied, walkTraitExtends } from "./typecheck.js";
import { mangleTraitMethod } from "./mangleTraitMethod.js";

// Built-in C-runtime functions the typechecker accepts even when the
// program doesn't declare them. printf is variadic so it's special-cased
// in resolveCall instead of living here.
const KNOWN_EXTERNS = {
  puts: {
    params: [{ name: "s", type: PrimType(primAnnotations.string) }],
    returnType: PrimType(primAnnotations.int32),
  },
  exit: {
    params: [{ name: "code", type: PrimType(primAnnotations.int32) }],
    returnType: VoidType(),
  },
};

export function resolveExprType(node, scope, ctx) {
  switch (node.kind) {
    case ASTNodeKind.INT_LITERAL:
      return setType(node, UntypedIntType());
    case ASTNodeKind.FLOAT_LITERAL:
      return setType(node, UntypedFloatType());
    case ASTNodeKind.STRING_LITERAL:
      return setType(node, PrimType(primAnnotations.string));
    case ASTNodeKind.BOOL_LITERAL:
      return setType(node, PrimType(primAnnotations.bool));
    case ASTNodeKind.IDENT:
      return resolveIdent(node, scope, ctx);
    case ASTNodeKind.BINARY_EXPRESSION:
      return resolveBinary(node, scope, ctx);
    case ASTNodeKind.CALL_EXPRESSION:
      return resolveCall(node, scope, ctx);
    case ASTNodeKind.UNARY_EXPRESSION:
      return resolveUnary(node, scope, ctx);
    case ASTNodeKind.TEMPLATE_LITERAL:
      return resolveTemplateLiteral(node, scope, ctx);
    case ASTNodeKind.ASSIGNMENT:
      return resolveAssignment(node, scope, ctx);
    case ASTNodeKind.COMPOUND_ASSIGNMENT:
      return resolveCompoundAssignment(node, scope, ctx);
    case ASTNodeKind.FIELD_ACCESS:
      return resolveFieldAccess(node, scope, ctx);
    case ASTNodeKind.STRUCT_LITERAL:
      return resolveOrphanStructLiteral(node, scope, ctx);
    case ASTNodeKind.TRY_OP:
      return resolveTryOp(node, scope, ctx);
    case ASTNodeKind.REF_EXPRESSION:
      return resolveRefExpression(node, scope, ctx);
    case ASTNodeKind.ARRAY_LITERAL:
      return resolveArrayLiteral(node, scope, ctx);
    case ASTNodeKind.INDEX_EXPRESSION:
      return resolveIndexExpression(node, scope, ctx);
    case ASTNodeKind.SLICE_EXPRESSION:
      return resolveSliceExpression(node, scope, ctx);
    case ASTNodeKind.WAIT_EXPRESSION:
      return resolveWaitExpression(node, scope, ctx);
    case ASTNodeKind.VARIANT_CONSTRUCTOR:
      return resolveVariantConstructor(node, scope, ctx);
    case ASTNodeKind.ADDRESS_OF_EXPRESSION:
      return resolveAddressOf(node, scope, ctx);
    case ASTNodeKind.DEREF_EXPRESSION:
      return resolveDeref(node, scope, ctx);
    case ASTNodeKind.NULL_LITERAL:
      return setType(node, UntypedNullType());
    case ASTNodeKind.UNSAFE_PTR_CAST:
      return resolveUnsafePtrCast(node, scope, ctx);
    case ASTNodeKind.ERRNO_INTRINSIC:
      return resolveErrnoIntrinsic(node, scope, ctx);
    case ASTNodeKind.NAMESPACE_IDENT:
      // resolveIdent already mutated this node from IDENT and stamped its
      // resolved namespace type - re-resolving it should be a no-op.
      return node.resolvedType ?? ErrorType();
    default: {
      pushError(
        ctx.errors,
        node,
        `typecheck: unhandled expression kind "${node.kind}"`,
      );
      return setType(node, ErrorType());
    }
  }
}

// Most helpers end with `return setType(node, ...)`.
function setType(node, type) {
  node.resolvedType = type;
  return type;
}

// `x` - looks up the variable in the lexical scope chain.
// If the binding type is RefType, sets autoDeref and returns the inner type.
function resolveIdent(node, scope, ctx) {
  const binding = lookupInScope(scope, node.name);
  if (binding) {
    if (binding.type.kind === typeKinds.namespace) node.kind = ASTNodeKind.NAMESPACE_IDENT;
    // Phase 6.2: record the binding's lexical depth for escape analysis.
    node.bindingScopeDepth = binding.scopeDepth ?? 0;
    // LSP: back-pointer to the declaring AST node so go-to-definition and
    // hover can navigate from a reference to its declaration without
    // re-running scope resolution. Stored non-enumerably so generic AST
    // walkers (kindCheck.walkExpr, checkStatement.findScopedIdentInExpr,
    // codegen.cloneAstWithSubstitution, etc.) don't follow the cycle this
    // back-pointer creates from a reference to its decl and back.
    if (binding.node) {
      Object.defineProperty(node, "resolvedDeclNode", {
        value: binding.node,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    // Auto-deref: ref bindings transparently expose the inner type
    if (binding.type.kind === typeKinds.ref) {
      node.autoDeref = true;
      return setType(node, binding.type.inner);
    }
    return setType(node, binding.type);
  }
  // Fall back to module-level symbols (namespace imports, etc.)
  const modType = ctx.typeContext.moduleSymbols?.get(node.name);
  if (modType) {
    if (modType.kind === typeKinds.namespace) node.kind = ASTNodeKind.NAMESPACE_IDENT;
    // Phase 8.E: mark IDENT references that resolve to a module-level
    // let/const binding so codegen emits a load from @<modid>__<name>
    // rather than %<name>. Functions and namespaces stay on their own
    // resolution paths.
    if (
      modType.kind !== typeKinds.func &&
      modType.kind !== typeKinds.namespace
    ) {
      const tc = ctx.typeContext;
      const imp = tc.importedNames?.get(node.name);
      if (imp && imp.kind === "value") {
        node.isModuleGlobal = true;
        node.moduleGlobalSym = `${imp.fromModuleId}__${imp.exportName}`;
        node.moduleGlobalImported = true;
      } else if (tc.currentModId) {
        node.isModuleGlobal = true;
        node.moduleGlobalSym = `${tc.currentModId}__${node.name}`;
        node.moduleGlobalImported = false;
      }
    }
    // Phase 10.X.2 follow-up: tag imported-function IDENTs in expression
    // position with their source module so codegen can emit the right
    // mangled symbol when the reference is used as a function-pointer
    // *value* (e.g. `{ hash: imported_hash }` in a KeyOps<K> literal).
    // The call-site path stamps these on CALL_EXPRESSION at line ~342;
    // this branch handles the non-call case.
    if (modType.kind === typeKinds.func) {
      const tc = ctx.typeContext;
      const imp = tc.importedNames?.get(node.name);
      if (imp && imp.kind === "value") {
        node.calleeModuleId = imp.fromModuleId;
        node.calleeExportName = imp.exportName;
      }
    }
    return setType(node, modType);
  }
  if (node.name === "self") {
    pushError(ctx.errors, node, `'self' can only be used inside a trait method body`);
  } else {
    pushError(ctx.errors, node, `undefined variable "${node.name}"`);
  }
  return setType(node, ErrorType());
}

// `a + b`, `a == b`, `a && b` - recurses into both sides, then asks
// unifyArith for the resulting type given the operator.
function resolveBinary(node, scope, ctx) {
  const leftType = resolveExprType(node.left, scope, ctx);
  const rightType = resolveExprType(node.right, scope, ctx);
  const resultType = unifyArith(leftType, rightType, node.op);
  // Pin untyped literal operands to the unified type so downstream (codegen)
  // doesn't have to second-guess their precision. E.g. `b.hue + 0.015` where
  // b.hue is float32 should coerce 0.015 from untypedFloat to float32.
  if (resultType && resultType.kind === typeKinds.prim) {
    coerceUntypedLiteralToTyped(node.left, leftType, resultType, ctx.errors);
    coerceUntypedLiteralToTyped(node.right, rightType, resultType, ctx.errors);
  }
  return setType(node, resultType);
}

// Render the callee expression as a short string for use in diagnostics.
// Bare identifiers stay as-is; FIELD_ACCESS (namespace / trait-qualified
// calls) renders as `ns.name`. Anything more exotic falls back to "call".
function calleeDisplayName(callee) {
  if (typeof callee === "string") return callee;
  if (
    callee &&
    callee.kind === ASTNodeKind.FIELD_ACCESS &&
    (callee.object?.kind === ASTNodeKind.IDENT ||
      callee.object?.kind === ASTNodeKind.NAMESPACE_IDENT) &&
    typeof callee.field === "string"
  ) {
    return `${callee.object.name}.${callee.field}`;
  }
  return "call";
}

// `f(a, b, c)` or `ns.f(a, b, c)` - looks up the function (local, imported
// namespace, or known C extern), then checks arity + arg types.
function resolveCall(node, scope, ctx) {
  const callee = node.callee;

  // Cast detection: callee is a single IDENT matching a primitive type name.
  // e.g. int64(x), float32(x), uint8(x & 0xFF)
  if (typeof callee === "string") {
    const primType = primTypeFromName(callee);
    if (primType) {
      if (node.args.length !== 1) {
        pushError(ctx.errors, node,
          `cast '${callee}(...)' requires exactly one argument`);
        return setType(node, primType);
      }
      const argType = resolveExprType(node.args[0], scope, ctx);
      // Coerce untyped literal to the cast target before checking castability
      const effectiveArgType = argType.kind === typeKinds.untypedInt || argType.kind === typeKinds.untypedFloat
        ? primType  // untyped literal → cast target is a no-op
        : argType;
      if (!isCastableTo(effectiveArgType, primType)) {
        pushError(ctx.errors, node,
          `cannot cast ${formatType(argType)} to ${formatType(primType)} - only numeric primitive casts are supported`);
        return setType(node, primType);
      }
      node.isCast = true;
      node.castTargetType = primType;
      // If the arg is an untyped literal, coerce it to the cast target
      if (argType.kind === typeKinds.untypedInt || argType.kind === typeKinds.untypedFloat) {
        coerceUntypedLiteralToTyped(node.args[0], argType, primType, ctx.errors);
      }
      return setType(node, primType);
    }
  }

  // Phase 7.4: trait-qualified call - `Steppable.step(ref b1, ...)`. Intercept
  // before the namespace-call branch below: a FIELD_ACCESS whose object IDENT
  // resolves to a TraitType dispatches through the trait's method table.
  if (
    callee &&
    typeof callee === "object" &&
    callee.kind === ASTNodeKind.FIELD_ACCESS &&
    (callee.object?.kind === ASTNodeKind.IDENT ||
      callee.object?.kind === ASTNodeKind.NAMESPACE_IDENT)
  ) {
    // Phase 9.G: `VTableName.from(ref x)` - builtin vtable constructor.
    // The only legal method name is `from`; anything else is a typecheck
    // error with a clear hint. Resolution checks that the argument is a
    // `ref T` where T implements the vtable's trait.
    const vt = lookupVTableByName(callee.object.name, ctx);
    if (vt) {
      return resolveVTableBuiltinCall(node, vt, callee.field, scope, ctx);
    }
    const trait = lookupTraitByName(callee.object.name, ctx);
    if (trait) {
      return resolveTraitQualifiedCall(node, trait, callee.field, scope, ctx);
    }
    // Generic function call via namespace: `intr.heap_alloc(8)` or
    // `vec.vec_new(...)`. The source module's genericFuncTable holds the
    // canonical decl; namespace lookups otherwise only check localSymbols
    // and structTable, so generic funcs need an explicit hop here.
    // Also covers intrinsic special-cases (`conc.wait_until`, `conc.cancel`)
    // where the special-case branches do the typing work - bare-callee form
    // and namespace-prefixed form should land in the same checker.
    //
    // Peek at the binding without going through resolveExprType (which would
    // mutate `callee.object.kind` to NAMESPACE_IDENT and break the regular
    // namespace-call dispatch below if we fall through).
    const objBinding =
      lookupInScope(scope, callee.object.name) ??
      (ctx.typeContext.moduleSymbols?.get(callee.object.name)
        ? { type: ctx.typeContext.moduleSymbols.get(callee.object.name) }
        : null);
    const nsType = objBinding?.type;
    if (nsType && nsType.kind === typeKinds.namespace) {
      const srcEnv = ctx.typeContext.moduleEnv?.get(nsType.moduleId);
      const srcBuiltins = srcEnv?.builtinIntrinsicNames;
      if (srcBuiltins?.has(callee.field)) {
        if (callee.field === "wait_until") {
          callee.namespaceLookup = {
            moduleId: nsType.moduleId,
            exportName: callee.field,
          };
          callee.object.kind = ASTNodeKind.NAMESPACE_IDENT;
          callee.object.resolvedType = nsType;
          return resolveWaitUntilCall(node, scope, ctx);
        }
        if (callee.field === "cancel") {
          callee.namespaceLookup = {
            moduleId: nsType.moduleId,
            exportName: callee.field,
          };
          callee.object.kind = ASTNodeKind.NAMESPACE_IDENT;
          callee.object.resolvedType = nsType;
          return resolveCancelCall(node, scope, ctx);
        }
      }
      const remoteGeneric = srcEnv?.genericFuncTable?.get(callee.field);
      if (remoteGeneric) {
        if (!nsType.exports.has(callee.field)) {
          pushError(
            ctx.errors,
            callee,
            `namespace "${callee.object.name}" has no export "${callee.field}"`,
          );
          return setType(node, ErrorType());
        }
        callee.namespaceLookup = {
          moduleId: nsType.moduleId,
          exportName: callee.field,
        };
        callee.object.kind = ASTNodeKind.NAMESPACE_IDENT;
        callee.object.resolvedType = nsType;
        return resolveGenericCall(node, remoteGeneric, scope, ctx);
      }
    }
  }

  // Namespace call: io.greet("hello") - callee is a FIELD_ACCESS node
  if (callee && typeof callee === "object") {
    const calleeType = resolveExprType(callee, scope, ctx);
    if (calleeType.kind === typeKinds.error) return setType(node, ErrorType());
    // Phase 10.X.2: a FIELD_ACCESS resolving to a FunctionPointerType means
    // the user is calling a function-pointer-typed struct field -
    // `ops.hash(k)` with `hash: (k: K) => uint64`. Lower as an indirect
    // call through the stored slot.
    if (calleeType.kind === typeKinds.functionPointer) {
      return resolveFunctionPointerCall(node, calleeType, scope, ctx);
    }
    if (calleeType.kind !== typeKinds.func) {
      pushError(ctx.errors, node, `expression is not callable`);
      return setType(node, ErrorType());
    }
    return resolveCallWithSig(node, calleeType, scope, ctx);
  }

  // `wait_until(h, deadline_ns)` and `cancel(h)` are builtin call forms (the
  // bounded-wait sibling of the `wait` keyword and its cancellation
  // counterpart). They're only special-cased when the current module has
  // imported them via an `extern "intrinsic"` block in std/core/concurrency
  // - user code that hasn't imported the intrinsics module is free to define
  // and call its own `wait_until` / `cancel` functions.
  const builtinIntrinsicNames = ctx.typeContext.builtinIntrinsicNames;
  if (callee === "wait_until" && builtinIntrinsicNames?.has("wait_until")) {
    return resolveWaitUntilCall(node, scope, ctx);
  }
  if (callee === "cancel" && builtinIntrinsicNames?.has("cancel")) {
    return resolveCancelCall(node, scope, ctx);
  }

  // printf legacy path - variadic, type-resolve each arg, no arity check.
  // Stays a magic builtin: the name doesn't compete with user identifiers
  // and is used pervasively; gating it on import would multiply churn.
  if (callee === "printf") {
    const sig = ctx.typeContext.moduleSymbols.get("printf");
    if (sig) {
      // Declared via extern block - use variadic path
    } else {
      for (const arg of node.args) resolveExprType(arg, scope, ctx);
      return setType(node, PrimType(primAnnotations.int32));
    }
  }

  // Phase 7.1: generic function call - look up in the genericFuncTable
  // (local or imported) and run call-site inference.
  if (typeof callee === "string") {
    const generic = lookupGenericFunc(callee, ctx);
    if (generic) {
      return resolveGenericCall(node, generic, scope, ctx);
    }
  }

  const sig = ctx.typeContext.moduleSymbols.get(callee) ?? KNOWN_EXTERNS[callee];
  if (!sig) {
    // Phase 7.4: bare-form `m(ref x)` is no longer a trait dispatch path.
    // If any in-scope trait has a method by this name, hint at the qualified
    // form (`Trait.m(ref x)`); otherwise emit a plain "unknown function".
    const hint = traitMethodHint(callee, ctx);
    if (hint) {
      pushError(
        ctx.errors,
        node,
        `unknown function "${callee}" - did you mean ${hint}? Trait methods must be called via the qualified form 'Trait.method(ref x, ...)'.`,
      );
    } else {
      pushError(ctx.errors, node, `unknown function "${callee}"`);
    }
    return setType(node, ErrorType());
  }
  // Annotate imported calls so codegen knows the source module for mangling.
  const importedNames = ctx.typeContext.importedNames;
  if (importedNames) {
    const imp = importedNames.get(callee);
    if (imp && imp.kind === "value") {
      node.calleeModuleId = imp.fromModuleId;
      node.calleeExportName = imp.exportName;
    }
  }
  return resolveCallWithSig(node, sig, scope, ctx);
}

// Shared call resolution once the sig is known. Handles variadic externs.
function resolveCallWithSig(node, sig, scope, ctx) {
  if (sig.variadic) {
    // Check the fixed prefix, then resolve variadic tail freely.
    const fixedParams = sig.params ?? [];
    for (let i = 0; i < fixedParams.length && i < node.args.length; i++) {
      checkInitializer(node.args[i], fixedParams[i].type, scope, ctx,
        (vt) => `arg ${i + 1} of call: cannot pass ${formatType(vt)} to ${formatType(fixedParams[i].type)}`);
    }
    for (let i = fixedParams.length; i < node.args.length; i++) {
      resolveExprType(node.args[i], scope, ctx);
    }
    return setType(node, sig.returnType);
  }
  return resolveCallType(node, sig, scope, ctx);
}

// Phase 10.X.2: a CALL_EXPRESSION whose callee resolves to a
// FunctionPointerType (typically `ops.hash(k)` where `hash` is a
// fn-ptr struct field) lowers to an indirect call through the field.
// Arity and arg-type checks run as usual; the codegen reads
// `node.fnPointerCall = true` to switch from symbol call to load+call.
function resolveFunctionPointerCall(node, fptType, scope, ctx) {
  const params = fptType.params ?? [];
  if (node.args.length !== params.length) {
    pushError(
      ctx.errors,
      node,
      `function-pointer call: expected ${params.length} argument(s), got ${node.args.length}`,
    );
    for (const a of node.args) resolveExprType(a, scope, ctx);
    return setType(node, ErrorType());
  }
  for (let i = 0; i < params.length; i++) {
    checkInitializer(
      node.args[i],
      params[i],
      scope,
      ctx,
      (vt) =>
        `arg ${i + 1} of function-pointer call: cannot pass ${formatType(vt)} to ${formatType(params[i])}`,
    );
  }
  node.fnPointerCall = true;
  return setType(node, fptType.returnType);
}

// `wait h` - operand must be Task<T>; result type is T. Rejected inside a
// task function body (no nested waits in 6.3; future suspension lifts it).
function resolveWaitExpression(node, scope, ctx) {
  const operandType = resolveExprType(node.operand, scope, ctx);
  if (operandType.kind === typeKinds.error) {
    return setType(node, ErrorType());
  }
  if (operandType.kind !== typeKinds.task) {
    pushError(
      ctx.errors,
      node,
      `wait requires a Task<T> operand, found ${formatType(operandType)}`,
    );
    return setType(node, ErrorType());
  }
  if (ctx.inTaskBody) {
    pushError(
      ctx.errors,
      node,
      `wait inside task body not supported (future phase will land coroutine suspension)`,
    );
  }
  return setType(node, operandType.resultType);
}

// `-x` or `!x`. Minus accepts any numeric type; not requires bool.
function resolveUnary(node, scope, ctx) {
  const operandType = resolveExprType(node.operand, scope, ctx);

  if (node.op === "minus") {
    if (isNumeric(operandType)) {
      return setType(node, operandType);
    }
    pushError(
      ctx.errors,
      node,
      `unary minus operator requires an int or float operand, found ${formatType(operandType)}`,
    );
    return setType(node, ErrorType());
  }

  // Phase 9: bitwise NOT - integer types only, returns the same type.
  // Phase 12: also accepted on integer-backed value enums - returns the
  // same enum type. String-backed enums reject.
  if (node.op === "bitnot") {
    if (
      operandType.kind === typeKinds.prim &&
      isIntPrim(operandType.name)
    ) {
      return setType(node, operandType);
    }
    if (operandType.kind === typeKinds.untypedInt) {
      return setType(node, operandType);
    }
    if (
      operandType.kind === typeKinds.valueEnum &&
      operandType.underlying?.kind === typeKinds.prim &&
      isIntPrim(operandType.underlying.name)
    ) {
      return setType(node, operandType);
    }
    pushError(
      ctx.errors,
      node,
      `bitwise NOT operator requires an integer operand, found ${formatType(operandType)}`,
    );
    return setType(node, ErrorType());
  }

  if (node.op === "not") {
    const boolType = resolveTypeFromName(
      primAnnotations.bool,
      ctx.typeContext.structTable,
    );
    if (typesEqual(operandType, boolType)) {
      return setType(node, boolType);
    }
    pushError(
      ctx.errors,
      node,
      `logical not operator requires a bool operand, found ${formatType(operandType)}`,
    );
    return setType(node, ErrorType());
  }

  pushError(ctx.errors, node, `unknown unary operator "${node.op}"`);
  return setType(node, ErrorType());
}

// `` `hi ${name}` `` - every interpolation must be a printable scalar
// (string, bool, or any numeric type) or a type that implements
// `Display`. For Display types we rewrite the interpolation at
// typecheck time to call `Display.to_string(ref expr)` first and use
// the resulting string - codegen still only sees printf-style args.
function resolveTemplateLiteral(node, scope, ctx) {
  for (const part of node.parts) {
    if (part.kind === "STRING_PART") continue;
    if (part.kind === "EXPR_PART") {
      const exprType = resolveExprType(part.expr, scope, ctx);
      if (isPrintableInTemplate(exprType)) continue;
      // Phase 9.F: try Display. Look for a `Display` trait on the
      // (deref'd) struct's implementsTraits; synthesize a trait call.
      const innerType = exprType.kind === typeKinds.ref ? exprType.inner : exprType;
      if (
        innerType.kind === typeKinds.struct &&
        (innerType.implementsTraits ?? []).some((t) => t.name === "Display")
      ) {
        part.expr = synthesizeDisplayCall(part.expr, innerType, exprType);
        continue;
      }
      pushError(
        ctx.errors,
        part.expr,
        `template literal interpolation must be a string, bool, int, or float type, or implement Display; found ${formatType(exprType)}`,
      );
      continue;
    }
    pushError(
      ctx.errors,
      node,
      `unknown template literal part kind "${part.kind}"`,
    );
  }
  return setType(node, PrimType(primAnnotations.string));
}

// Phase 9.F: build the post-typecheck shape of `Display.to_string(ref expr)`
// directly. We bypass the parser by stamping `calleeMethodOf` +
// `calleeMangledName` + a synthetic REF_EXPRESSION arg, mirroring what
// resolveTraitQualifiedCall does for source-written trait calls.
//
// `exprType` is the type of `originalExpr` (used to materialize the ref
// arg if needed); `structType` is the (deref'd) struct that carries the
// Display impl - its mangled symbol is what the call dispatches to.
function synthesizeDisplayCall(originalExpr, structType, exprType) {
  // Arg = `ref originalExpr` when expr isn't already a ref; pass
  // through when it already is.
  let argNode;
  if (exprType.kind === typeKinds.ref) {
    argNode = originalExpr;
  } else {
    argNode = {
      kind: ASTNodeKind.REF_EXPRESSION,
      operand: originalExpr,
      sourceLoc: originalExpr.sourceLoc,
      resolvedType: RefType(structType),
    };
  }
  return {
    kind: ASTNodeKind.CALL_EXPRESSION,
    callee: "Display.to_string", // diagnostic-only; codegen reads calleeMangledName
    args: [argNode],
    sourceLoc: originalExpr.sourceLoc,
    resolvedType: PrimType(primAnnotations.string),
    calleeMethodOf: structType,
    calleeMethodName: "to_string",
    calleeTrait: (structType.implementsTraits ?? []).find(
      (t) => t.name === "Display",
    ),
    calleeMangledName: mangleTraitMethod(structType, "Display", "to_string"),
  };
}

function isPrintableInTemplate(t) {
  if (!t) return false;
  if (t.kind === typeKinds.prim && t.name === primAnnotations.string)
    return true;
  if (t.kind === typeKinds.prim && t.name === primAnnotations.bool) return true;
  return isNumeric(t);
}

// `x = expr` or `x.field = expr` or `xs[i] = expr`.
function resolveAssignment(node, scope, ctx) {
  if (node.target.kind === ASTNodeKind.IDENT) {
    return resolveAssignmentToIdent(node, scope, ctx);
  }
  if (node.target.kind === ASTNodeKind.FIELD_ACCESS) {
    return resolveAssignmentToField(node, scope, ctx);
  }
  if (node.target.kind === ASTNodeKind.INDEX_EXPRESSION) {
    return resolveAssignmentToIndex(node, scope, ctx);
  }
  if (node.target.kind === ASTNodeKind.DEREF_EXPRESSION) {
    return resolveAssignmentToDeref(node, scope, ctx);
  }
  pushError(
    ctx.errors,
    node,
    `invalid assignment target kind "${node.target.kind}"`,
  );
  return setType(node, ErrorType());
}

// Phase 9: `x op= rhs`. Treated as the merge of an assignment (target must be
// a mutable lvalue) and a binary op (target's current type must accept `op`
// with the RHS). Codegen evaluates the lvalue exactly once.
function resolveCompoundAssignment(node, scope, ctx) {
  // Resolve the target as an lvalue read first to pick up its current type.
  // resolveExprType handles IDENT / FIELD_ACCESS / INDEX_EXPRESSION /
  // DEREF_EXPRESSION uniformly. Mutability is checked below.
  const targetType = resolveExprType(node.target, scope, ctx);
  if (targetType.kind === typeKinds.error) return setType(node, ErrorType());

  // Block writes to a `const` binding (mirrors plain ASSIGNMENT to IDENT).
  if (node.target.kind === ASTNodeKind.IDENT) {
    const binding = lookupInScope(scope, node.target.name);
    if (binding && binding.kind === "const") {
      pushError(
        ctx.errors,
        node,
        `cannot compound-assign to const "${node.target.name}"`,
      );
      return setType(node, ErrorType());
    }
  }

  const rhsType = resolveExprType(node.value, scope, ctx);
  if (rhsType.kind === typeKinds.error) return setType(node, ErrorType());

  // The op must be applicable to (targetType, rhsType). unifyArith returns
  // the result type or errors; we reuse the same path binary ops use.
  const unified = unifyArith(targetType, rhsType, node.op);
  if (unified.kind === typeKinds.error) {
    pushError(
      ctx.errors,
      node,
      `compound op '${node.op}=' rejects operands ${formatType(targetType)} and ${formatType(rhsType)}`,
    );
    return setType(node, ErrorType());
  }
  // Result must be assignable back into the target slot - guards against
  // e.g. an untyped int RHS that would resolve to something narrower.
  if (!isAssignable(targetType, unified)) {
    pushError(
      ctx.errors,
      node,
      `compound op '${node.op}=' yields ${formatType(unified)} which is not assignable to ${formatType(targetType)}`,
    );
    return setType(node, ErrorType());
  }
  // Pin any untyped-literal RHS (and any nested arithmetic with untyped
  // intermediate types) to the target type - same helper as plain binary ops.
  coerceUntypedLiteralToTyped(node.value, rhsType, targetType, ctx.errors);
  return setType(node, targetType);
}

// Phase 8.A: `*p = v` - assignment through an unsafe_ptr<T>. Resolves the
// pointer, checks the RHS against the pointee type.
function resolveAssignmentToDeref(node, scope, ctx) {
  const ptrType = resolveExprType(node.target.operand, scope, ctx);
  if (ptrType.kind === typeKinds.error) return setType(node, ErrorType());
  if (ptrType.kind !== typeKinds.unsafePtr) {
    pushError(
      ctx.errors,
      node,
      `cannot deref non-pointer type ${formatType(ptrType)}`,
    );
    return setType(node, ErrorType());
  }
  const pointee = ptrType.pointee;
  node.target.resolvedType = pointee;
  checkInitializer(
    node.value,
    pointee,
    scope,
    ctx,
    (valueType) =>
      `cannot assign ${formatType(valueType)} to ${formatType(pointee)} through pointer`,
  );
  return setType(node, pointee);
}

function resolveAssignmentToIdent(node, scope, ctx) {
  const targetName = node.target.name;
  const binding = lookupInScope(scope, targetName);
  if (!binding) {
    // Phase 8.E: not in lexical scope - fall back to module-level globals.
    const moduleAssign = resolveAssignmentToModuleGlobal(node, scope, ctx);
    if (moduleAssign) return moduleAssign;
    pushError(ctx.errors, node, `undefined variable "${targetName}"`);
    return setType(node, ErrorType());
  }
  if (binding.kind === "const") {
    pushError(ctx.errors, node, `cannot assign to const "${targetName}"`);
    return setType(node, ErrorType());
  }

  // Auto-deref write: if the binding is a ref, write through the pointer
  if (binding.type.kind === typeKinds.ref) {
    node.target.autoDerefWrite = true;
    node.target.resolvedType = binding.type.inner;
    checkInitializer(
      node.value,
      binding.type.inner,
      scope,
      ctx,
      (valueType) =>
        `cannot assign ${formatType(valueType)} to ${formatType(binding.type.inner)} through ref "${targetName}"`,
    );
    return setType(node, binding.type.inner);
  }

  node.target.resolvedType = binding.type;

  checkInitializer(
    node.value,
    binding.type,
    scope,
    ctx,
    (valueType) =>
      `cannot assign ${formatType(valueType)} to ${formatType(binding.type)} in assignment to "${targetName}"`,
  );
  return setType(node, binding.type);
}

// Phase 8.E: handle assignment to a module-level let. Returns the assignment's
// resolved type if the target was a module global; null if the target wasn't
// found at module scope (caller falls through to "undefined variable").
//
// Phase 11.D.18: `scope` is now threaded through so that a `@precompile
// { ... }` block can assign to a module-level binding from a RHS that
// references local block bindings (`SUM = acc;` where `acc` is a local
// `let` declared earlier in the block). Module-init decls still call
// this with a fresh scope (no locals), so the existing behavior is a
// no-op there.
function resolveAssignmentToModuleGlobal(node, scope, ctx) {
  const targetName = node.target.name;
  const tc = ctx.typeContext;
  const modType = tc.moduleSymbols?.get(targetName);
  if (!modType) return null;
  if (
    modType.kind === typeKinds.func ||
    modType.kind === typeKinds.namespace
  ) {
    return null;
  }
  // Imported lets are read-only across module boundaries.
  const imp = tc.importedNames?.get(targetName);
  if (imp && imp.kind === "value") {
    pushError(
      ctx.errors,
      node,
      `"${targetName}" is imported from module "${imp.fromModuleId}" - assignment from outside its module is not permitted`,
    );
    return setType(node, ErrorType());
  }
  // Module-local: must be a `let` (not `const`). Find the decl in
  // moduleInitDecls to check mutability. moduleInitDecls is stashed onto
  // the module by typecheck pass C.4.
  const decl = findModuleInitDecl(tc, targetName);
  if (decl && decl.kind === ASTNodeKind.CONST_DECL) {
    pushError(
      ctx.errors,
      node,
      `cannot assign to const "${targetName}"`,
    );
    return setType(node, ErrorType());
  }
  // Mark target so codegen emits store to @<modid>__<name>.
  node.target.isModuleGlobal = true;
  node.target.moduleGlobalSym = `${tc.currentModId}__${targetName}`;
  node.target.moduleGlobalImported = false;
  node.target.resolvedType = modType;
  checkInitializer(
    node.value,
    modType,
    scope,
    ctx,
    (valueType) =>
      `cannot assign ${formatType(valueType)} to ${formatType(modType)} in assignment to module-level "${targetName}"`,
  );
  return setType(node, modType);
}

// Phase 8.E: best-effort lookup of the AST decl for a module-level binding.
// Uses mod.moduleInitDecls (set in typecheck pass C.4) reachable via the
// moduleEnv. Returns null if the binding isn't a module-level let/const.
function findModuleInitDecl(tc, name) {
  if (!tc.moduleEnv || !tc.currentModId) return null;
  const env = tc.moduleEnv.get(tc.currentModId);
  const decls = env?.moduleInitDecls;
  if (!decls) return null;
  for (const d of decls) {
    if (d.name === name) return d;
  }
  return null;
}

function resolveAssignmentToField(node, scope, ctx) {
  const targetType = resolveExprType(node.target, scope, ctx);
  if (targetType.kind === typeKinds.error) {
    return setType(node, ErrorType());
  }
  const rootIdent = rootIdentOf(node.target);
  if (!rootIdent) {
    pushError(
      ctx.errors,
      node,
      `invalid assignment target - root of field chain is not an identifier`,
    );
    return setType(node, ErrorType());
  }
  const rootBinding = lookupInScope(scope, rootIdent.name);
  if (rootBinding && rootBinding.kind === "const") {
    pushError(
      ctx.errors,
      node,
      `cannot assign to field of const "${rootIdent.name}"`,
    );
    return setType(node, ErrorType());
  }

  checkInitializer(
    node.value,
    targetType,
    scope,
    ctx,
    (valueType) =>
      `cannot assign ${formatType(valueType)} to ${formatType(targetType)} in field assignment`,
  );
  return setType(node, targetType);
}

function resolveAssignmentToIndex(node, scope, ctx) {
  // Resolve the index expression to get the element type
  const elemType = resolveExprType(node.target, scope, ctx);
  if (elemType.kind === typeKinds.error) {
    return setType(node, ErrorType());
  }
  checkInitializer(
    node.value,
    elemType,
    scope,
    ctx,
    (valueType) =>
      `cannot assign ${formatType(valueType)} to ${formatType(elemType)} in index assignment`,
  );
  return setType(node, elemType);
}

// `obj.field` - receiver must be a struct, namespace, string (for .len), or array (for .len).
function resolveFieldAccess(node, scope, ctx) {
  // Phase 7.5: bare `EnumName.Variant` (no payload). Detect before
  // resolveExprType on the IDENT object would error with "undefined variable".
  if (node.object.kind === ASTNodeKind.IDENT) {
    const maybeEnum = lookupVariantTypeByName(node.object.name, ctx);
    if (maybeEnum) {
      const variant = maybeEnum.variants.get(node.field);
      const fieldLoc = node.fieldSourceLoc ?? node;
      if (!variant) {
        pushError(
          ctx.errors,
          fieldLoc,
          `variant "${maybeEnum.name}" has no case "${node.field}"`,
        );
        return setType(node, ErrorType());
      }
      if (variant.fields !== null) {
        pushError(
          ctx.errors,
          fieldLoc,
          `variant "${maybeEnum.name}.${variant.name}" requires fields { ${variant.fields.map((f) => f.name).join(", ")} } - write '${maybeEnum.name}.${variant.name} { ... }'`,
        );
        return setType(node, ErrorType());
      }
      // Promote in-place to a VARIANT_CONSTRUCTOR with no fields.
      node.kind = ASTNodeKind.VARIANT_CONSTRUCTOR;
      node.enumName = node.object.name;
      node.variantName = node.field;
      node.fields = null;
      node.resolvedVariantType = maybeEnum;
      node.resolvedVariant = variant;
      // Clean up FIELD_ACCESS-specific properties (best-effort tidiness).
      delete node.object;
      delete node.field;
      return setType(node, maybeEnum);
    }
    // Phase 10.A: bare `GenericEnum.Variant` (no payload). Promote in place
    // to an unpinned VARIANT_CONSTRUCTOR; checkInitializer will pin it to a
    // concrete instantiation against the target type. Without a target type
    // (statement-position use), resolveVariantConstructor reports an error.
    const maybeGenericEnum = lookupGenericVariantDecl(node.object.name, ctx);
    if (maybeGenericEnum) {
      const variant = maybeGenericEnum.genericVariants?.get(node.field);
      const fieldLoc = node.fieldSourceLoc ?? node;
      if (!variant) {
        pushError(
          ctx.errors,
          fieldLoc,
          `variant "${maybeGenericEnum.name}" has no case "${node.field}"`,
        );
        return setType(node, ErrorType());
      }
      if (variant.fields !== null) {
        pushError(
          ctx.errors,
          fieldLoc,
          `variant "${maybeGenericEnum.name}.${variant.name}" requires fields { ${variant.fields.map((f) => f.name).join(", ")} } - write '${maybeGenericEnum.name}.${variant.name} { ... }'`,
        );
        return setType(node, ErrorType());
      }
      node.kind = ASTNodeKind.VARIANT_CONSTRUCTOR;
      node.enumName = node.object.name;
      node.variantName = node.field;
      node.fields = null;
      // resolvedVariantType / resolvedVariant left unset - pinning happens in
      // checkInitializer (or resolveVariantConstructor reports an error).
      delete node.object;
      delete node.field;
      return resolveVariantConstructor(node, scope, ctx);
    }
    // Phase 12: bare `EnumName.Case` for a value enum. Promote to a
    // VARIANT_CONSTRUCTOR carrying `resolvedValueEnumType` + the case record;
    // codegen will emit the underlying constant value.
    const maybeValueEnum = lookupValueEnumByName(node.object.name, ctx);
    if (maybeValueEnum) {
      const enumCase = maybeValueEnum.cases.get(node.field);
      const fieldLoc = node.fieldSourceLoc ?? node;
      if (!enumCase) {
        pushError(
          ctx.errors,
          fieldLoc,
          `enum "${maybeValueEnum.name}" has no case "${node.field}"`,
        );
        return setType(node, ErrorType());
      }
      node.kind = ASTNodeKind.VARIANT_CONSTRUCTOR;
      node.enumName = node.object.name;
      node.variantName = node.field;
      node.fields = null;
      node.resolvedValueEnumType = maybeValueEnum;
      node.resolvedValueEnumCase = enumCase;
      delete node.object;
      delete node.field;
      return setType(node, maybeValueEnum);
    }
  }

  const objType = resolveExprType(node.object, scope, ctx);
  if (objType.kind === typeKinds.error) {
    return setType(node, ErrorType());
  }

  // For "no such field"-style diagnostics, prefer the field identifier's
  // location so the squiggle lands on the field name, not the whole expr.
  const fieldLoc = node.fieldSourceLoc ?? node;

  // namespace.field
  if (objType.kind === typeKinds.namespace) {
    if (!objType.exports.has(node.field)) {
      pushError(ctx.errors, fieldLoc, `namespace "${node.object.name}" has no export "${node.field}"`);
      return setType(node, ErrorType());
    }
    const moduleEnv = ctx.typeContext.moduleEnv;
    const srcEnv = moduleEnv?.get(objType.moduleId);
    if (!srcEnv) {
      pushError(ctx.errors, node, `internal: namespace module ${objType.moduleId} not found`);
      return setType(node, ErrorType());
    }
    // Phase 12: a namespace can export variant / value-enum / union /
    // vtable types in addition to values + structs. Look through every
    // table so `ns.VariantOrEnum.Case` resolves correctly through the
    // promotion that runs at the IDENT-field branch above.
    const sym =
      srcEnv.localSymbols.get(node.field) ??
      srcEnv.structTable.get(node.field) ??
      srcEnv.variantTable?.get(node.field) ??
      srcEnv.enumTable?.get(node.field) ??
      srcEnv.unionTable?.get(node.field) ??
      srcEnv.vtableTable?.get(node.field);
    if (!sym) {
      pushError(ctx.errors, fieldLoc, `internal: export "${node.field}" not found in module ${objType.moduleId}`);
      return setType(node, ErrorType());
    }
    node.namespaceLookup = { moduleId: objType.moduleId, exportName: node.field };
    return setType(node, sym);
  }

  // string.len intrinsic
  if (
    objType.kind === typeKinds.prim &&
    objType.name === primAnnotations.string &&
    node.field === "len"
  ) {
    return setType(node, PrimType(primAnnotations.usize));
  }

  // array.len intrinsic
  if (objType.kind === typeKinds.array && node.field === "len") {
    node.isArrayLen = true;
    return setType(node, PrimType(primAnnotations.usize));
  }
  // Phase 8.C: array.ptr intrinsic - borrow the data pointer.
  // Gated by `import.unsafe;` because the produced unsafe_ptr<T> is itself
  // an unsafe pointer; mirrors the Phase 8.A blanket rule.
  if (objType.kind === typeKinds.array && node.field === "ptr") {
    if (!ctx.typeContext.allowsUnsafe) {
      pushError(
        ctx.errors,
        fieldLoc,
        `'.ptr' on an array requires 'import.unsafe;' at module top`,
      );
      return setType(node, ErrorType());
    }
    node.isArrayPtr = true;
    return setType(node, UnsafePtrType(objType.elem));
  }
  if (objType.kind === typeKinds.array) {
    pushError(ctx.errors, fieldLoc, `type ${formatType(objType)} has no field "${node.field}"`);
    return setType(node, ErrorType());
  }

  // Phase 12: `<expr>.Case` against a value-enum-typed receiver - happens
  // when the receiver isn't a bare IDENT (e.g. `ns.MyEnum.Case` where
  // `ns.MyEnum` already resolved to a ValueEnumType via the namespace
  // branch above). Same promotion as the bare-IDENT path.
  if (objType.kind === typeKinds.valueEnum) {
    const enumCase = objType.cases.get(node.field);
    if (!enumCase) {
      pushError(
        ctx.errors,
        fieldLoc,
        `enum "${objType.name}" has no case "${node.field}"`,
      );
      return setType(node, ErrorType());
    }
    node.kind = ASTNodeKind.VARIANT_CONSTRUCTOR;
    node.enumName = objType.name;
    node.variantName = node.field;
    node.fields = null;
    node.resolvedValueEnumType = objType;
    node.resolvedValueEnumCase = enumCase;
    delete node.object;
    delete node.field;
    return setType(node, objType);
  }

  // Phase 7.5: field access on a union type - same path as struct, just a
  // type-punning read into the union's chosen field type. Codegen lowers via
  // a bitcast.
  if (objType.kind === typeKinds.union) {
    const uf = objType.fields?.find((f) => f.name === node.field);
    if (!uf) {
      pushError(
        ctx.errors,
        fieldLoc,
        `union "${objType.name}" has no field "${node.field}"`,
      );
      return setType(node, ErrorType());
    }
    return setType(node, uf.type);
  }
  if (objType.kind !== typeKinds.struct) {
    pushError(ctx.errors, node, `field access on non-struct type ${formatType(objType)}`);
    return setType(node, ErrorType());
  }
  const field = objType.fields?.find((f) => f.name === node.field);
  if (!field) {
    if (objType.methods?.has(node.field)) {
      pushError(
        ctx.errors,
        fieldLoc,
        `method-call form '.${node.field}()' is not supported - use the free-function form '${node.field}(ref value)'`,
      );
    } else {
      pushError(ctx.errors, fieldLoc, `type "${objType.name}" has no field "${node.field}"`);
    }
    return setType(node, ErrorType());
  }
  return setType(node, field.type);
}

// `ref x` - takes the address of an lvalue.
function resolveRefExpression(node, scope, ctx) {
  const operandType = resolveExprType(node.operand, scope, ctx);
  if (operandType.kind === typeKinds.error) return setType(node, ErrorType());
  if (operandType.kind === typeKinds.ref) {
    pushError(ctx.errors, node, `cannot take ref of a ref - 'ref ref T' is not supported`);
    return setType(node, ErrorType());
  }
  // Only lvalues can be ref'd
  if (
    node.operand.kind !== ASTNodeKind.IDENT &&
    node.operand.kind !== ASTNodeKind.FIELD_ACCESS &&
    node.operand.kind !== ASTNodeKind.INDEX_EXPRESSION
  ) {
    pushError(ctx.errors, node, `cannot take ref of a non-lvalue expression`);
    return setType(node, ErrorType());
  }
  return setType(node, RefType(operandType));
}

// Phase 8.A: `&lvalue` - address-of. Returns unsafe_ptr<T> where T is the
// lvalue's type. Only lvalues are accepted (IDENT, FIELD_ACCESS,
// INDEX_EXPRESSION, DEREF_EXPRESSION).
function resolveAddressOf(node, scope, ctx) {
  const operandType = resolveExprType(node.operand, scope, ctx);
  if (operandType.kind === typeKinds.error) return setType(node, ErrorType());
  if (
    node.operand.kind !== ASTNodeKind.IDENT &&
    node.operand.kind !== ASTNodeKind.FIELD_ACCESS &&
    node.operand.kind !== ASTNodeKind.INDEX_EXPRESSION &&
    node.operand.kind !== ASTNodeKind.DEREF_EXPRESSION
  ) {
    pushError(
      ctx.errors,
      node,
      `cannot take address of an rvalue - operand of '&' must be an lvalue`,
    );
    return setType(node, ErrorType());
  }
  return setType(node, UnsafePtrType(operandType));
}

// Phase 8.A: `*p` - dereference an unsafe_ptr<T>. Returns T.
function resolveDeref(node, scope, ctx) {
  const operandType = resolveExprType(node.operand, scope, ctx);
  if (operandType.kind === typeKinds.error) return setType(node, ErrorType());
  if (operandType.kind !== typeKinds.unsafePtr) {
    pushError(
      ctx.errors,
      node,
      `cannot deref non-pointer type ${formatType(operandType)}`,
    );
    return setType(node, ErrorType());
  }
  return setType(node, operandType.pointee);
}

// Phase 8.A: unsafe_ptr.cast<U>(p), unsafe_ptr.toInt(p), unsafe_ptr.fromInt<T>(n)
function resolveUnsafePtrCast(node, scope, ctx) {
  const operandType = resolveExprType(node.operand, scope, ctx);
  if (operandType.kind === typeKinds.error) return setType(node, ErrorType());

  if (node.castKind === "bitcast") {
    if (operandType.kind !== typeKinds.unsafePtr) {
      pushError(
        ctx.errors,
        node,
        `unsafe_ptr.cast expects an unsafe_ptr<T>, got ${formatType(operandType)}`,
      );
      return setType(node, ErrorType());
    }
    const targetPointee = resolveTypeAnnotInCtx(node.typeArg, ctx);
    if (!targetPointee) {
      pushError(ctx.errors, node, `unsafe_ptr.cast: unknown target pointee type`);
      return setType(node, ErrorType());
    }
    return setType(node, UnsafePtrType(targetPointee));
  }

  if (node.castKind === "toInt") {
    if (operandType.kind !== typeKinds.unsafePtr) {
      pushError(
        ctx.errors,
        node,
        `unsafe_ptr.toInt expects an unsafe_ptr<T>, got ${formatType(operandType)}`,
      );
      return setType(node, ErrorType());
    }
    return setType(node, PrimType(primAnnotations.uintptr));
  }

  if (node.castKind === "fromInt") {
    const isIntegerSource =
      (operandType.kind === typeKinds.prim && isIntPrim(operandType.name)) ||
      operandType.kind === typeKinds.untypedInt;
    if (!isIntegerSource) {
      pushError(
        ctx.errors,
        node,
        `unsafe_ptr.fromInt expects an integer argument, got ${formatType(operandType)}`,
      );
      return setType(node, ErrorType());
    }
    const targetPointee = resolveTypeAnnotInCtx(node.typeArg, ctx);
    if (!targetPointee) {
      pushError(ctx.errors, node, `unsafe_ptr.fromInt: unknown target pointee type`);
      return setType(node, ErrorType());
    }
    return setType(node, UnsafePtrType(targetPointee));
  }

  // Phase 8.C: unsafe_ptr.toArray<T>(p, n) - borrow a (ptr, len) pair as T[].
  if (node.castKind === "toArray") {
    const targetElem = resolveTypeAnnotInCtx(node.typeArg, ctx);
    if (!targetElem) {
      pushError(ctx.errors, node, `unsafe_ptr.toArray: unknown element type`);
      return setType(node, ErrorType());
    }
    if (operandType.kind !== typeKinds.unsafePtr) {
      pushError(
        ctx.errors,
        node,
        `unsafe_ptr.toArray expects unsafe_ptr<T> as the first arg, got ${formatType(operandType)}`,
      );
      return setType(node, ErrorType());
    }
    if (!typesEqual(operandType.pointee, targetElem)) {
      pushError(
        ctx.errors,
        node,
        `unsafe_ptr.toArray<${formatType(targetElem)}> expects unsafe_ptr<${formatType(targetElem)}>, got ${formatType(operandType)} - use unsafe_ptr.cast first if a reinterpret is intended`,
      );
      return setType(node, ErrorType());
    }
    const lenType = resolveExprType(node.lengthOperand, scope, ctx);
    const isInt =
      (lenType.kind === typeKinds.prim && isIntPrim(lenType.name)) ||
      lenType.kind === typeKinds.untypedInt;
    if (!isInt) {
      pushError(
        ctx.errors,
        node.lengthOperand,
        `unsafe_ptr.toArray length must be an integer, got ${formatType(lenType)}`,
      );
      return setType(node, ErrorType());
    }
    // Pin untyped-int length to usize so codegen emits an i64 store.
    if (lenType.kind === typeKinds.untypedInt) {
      coerceUntypedLiteralToTyped(
        node.lengthOperand,
        lenType,
        PrimType(primAnnotations.usize),
        ctx.errors,
      );
    }
    return setType(node, ArrayType(targetElem));
  }

  pushError(ctx.errors, node, `unknown unsafe_ptr cast kind ${node.castKind}`);
  return setType(node, ErrorType());
}

// Phase 8.D: errno.get() / errno.set(v) / errno.message(c).
// `get` is nullary and returns c_int. `set` takes an int and returns void.
// `message` takes an int and returns string. Untyped int args pin to int32.
function resolveErrnoIntrinsic(node, scope, ctx) {
  if (node.op === "get") {
    if (node.operand) {
      pushError(ctx.errors, node, `errno.get() takes no arguments`);
      return setType(node, ErrorType());
    }
    return setType(node, PrimType(primAnnotations.int32));
  }
  if (node.op === "set" || node.op === "message") {
    if (!node.operand) {
      pushError(
        ctx.errors,
        node,
        `errno.${node.op}(...) requires one integer argument`,
      );
      return setType(node, ErrorType());
    }
    const argType = resolveExprType(node.operand, scope, ctx);
    if (argType.kind === typeKinds.error) return setType(node, ErrorType());
    const isInt =
      (argType.kind === typeKinds.prim && isIntPrim(argType.name)) ||
      argType.kind === typeKinds.untypedInt;
    if (!isInt) {
      pushError(
        ctx.errors,
        node.operand,
        `errno.${node.op} expects an integer argument, got ${formatType(argType)}`,
      );
      return setType(node, ErrorType());
    }
    if (argType.kind === typeKinds.untypedInt) {
      coerceUntypedLiteralToTyped(
        node.operand,
        argType,
        PrimType(primAnnotations.int32),
        ctx.errors,
      );
    }
    return setType(
      node,
      node.op === "set" ? VoidType() : PrimType(primAnnotations.string),
    );
  }
  pushError(ctx.errors, node, `unknown errno intrinsic "${node.op}"`);
  return setType(node, ErrorType());
}

// Resolve a type annotation node within an expression context. The caller
// provides ctx which carries the typeContext (single-module path) and/or
// module-resolver hooks for the multi-module path.
function resolveTypeAnnotInCtx(annot, ctx) {
  if (!annot) return null;
  // Prefer the typeContext.resolveTypeAnnotation hook if installed by the
  // caller (multi-module path threads this through ctx.typeContext).
  if (ctx?.typeContext?.resolveTypeAnnotation) {
    return ctx.typeContext.resolveTypeAnnotation(annot);
  }
  // Single-module fallback: use the static resolver.
  if (ctx?.typeContext?.structTable) {
    // Lazy require to avoid an import cycle.
    // Direct delegation through the static helper exported by types.js.
    // We import here-by-reference via globalThis to avoid circular import.
    const fn = ctx.typeContext.resolveTypeAnnotationFallback;
    if (fn) return fn(annot);
  }
  return null;
}

// `[e1, e2, e3]` - infer element type from first element, check all match.
function resolveArrayLiteral(node, scope, ctx) {
  if (node.elements.length === 0) {
    pushError(ctx.errors, node, `empty array literal requires explicit type annotation`);
    return setType(node, ErrorType());
  }
  const firstType = resolveExprType(node.elements[0], scope, ctx);
  for (let i = 1; i < node.elements.length; i++) {
    const elemType = resolveExprType(node.elements[i], scope, ctx);
    if (!typesEqual(firstType, elemType) && firstType.kind !== typeKinds.error && elemType.kind !== typeKinds.error) {
      // Allow untyped int to match first typed element
      if (!(elemType.kind === typeKinds.untypedInt && firstType.kind === typeKinds.prim) &&
          !(elemType.kind === typeKinds.untypedFloat && firstType.kind === typeKinds.prim) &&
          !(firstType.kind === typeKinds.untypedInt && elemType.kind === typeKinds.prim) &&
          !(firstType.kind === typeKinds.untypedFloat && elemType.kind === typeKinds.prim)) {
        pushError(ctx.errors, node.elements[i],
          `array literal element ${i} has type ${formatType(elemType)}, expected ${formatType(firstType)}`);
      }
    }
  }
  return setType(node, ArrayType(firstType));
}

// `xs[i]` - object must be an array, index must be an integer type.
function resolveIndexExpression(node, scope, ctx) {
  const objType = resolveExprType(node.object, scope, ctx);
  const idxType = resolveExprType(node.index, scope, ctx);
  if (objType.kind === typeKinds.error) return setType(node, ErrorType());
  if (objType.kind !== typeKinds.array) {
    pushError(ctx.errors, node, `cannot index non-array type ${formatType(objType)}`);
    return setType(node, ErrorType());
  }
  const isIntIdx =
    (idxType.kind === typeKinds.prim && isIntPrim(idxType.name)) ||
    idxType.kind === typeKinds.untypedInt ||
    // Phase 12: integer-backed value enums decay to their underlying
    // primitive for indexing (matches the implicit coercion used in
    // assignment / call positions).
    (idxType.kind === typeKinds.valueEnum &&
      idxType.underlying?.kind === typeKinds.prim &&
      isIntPrim(idxType.underlying.name));
  if (!isIntIdx) {
    pushError(ctx.errors, node.index,
      `array index must be an integer type, found ${formatType(idxType)}`);
    return setType(node, ErrorType());
  }
  return setType(node, objType.elem);
}

// Phase 9.E: `xs[i..j]` / `xs[i..]` / `xs[..j]` / `xs[..]` - zero-copy
// fat-pointer subview. Result type is the same array type as `xs`.
function resolveSliceExpression(node, scope, ctx) {
  const objType = resolveExprType(node.object, scope, ctx);
  if (objType.kind === typeKinds.error) return setType(node, ErrorType());
  if (objType.kind !== typeKinds.array) {
    pushError(
      ctx.errors,
      node,
      `cannot slice non-array type ${formatType(objType)}`,
    );
    return setType(node, ErrorType());
  }
  const checkBound = (boundNode, label) => {
    if (boundNode === null) return;
    const t = resolveExprType(boundNode, scope, ctx);
    const ok =
      (t.kind === typeKinds.prim && isIntPrim(t.name)) ||
      t.kind === typeKinds.untypedInt;
    if (!ok) {
      pushError(
        ctx.errors,
        boundNode,
        `slice ${label} must be an integer type, found ${formatType(t)}`,
      );
    }
  };
  checkBound(node.start, "start");
  checkBound(node.end, "end");
  return setType(node, objType);
}

// `expr?` - postfix propagator over a fallible enum (Phase 9.H + 10.E).
// A fallible operand is an enum with two variants named `Ok` and `Err`,
// each with zero or one payload field. The enclosing function must also
// return a fallible enum. When the two Err payload types differ, the
// typechecker looks for an `Into<ReturnErr>` impl on the operand's err
// type (Phase 10.E) and stamps the conversion onto the node so codegen
// can wrap the propagated value before constructing the outer `Err`
// variant.
function resolveTryOp(node, scope, ctx) {
  const operandType = resolveExprType(node.operand, scope, ctx);
  if (operandType.kind === typeKinds.error) {
    return setType(node, ErrorType());
  }

  if (!isFallibleVariant(operandType)) {
    pushError(
      ctx.errors,
      node,
      `'?' applied to non-fallible type ${formatType(operandType)} - only enums with Ok/Err variants are fallible`,
    );
    return setType(node, ErrorType());
  }

  const retType = ctx.funcReturnType;
  if (!isFallibleVariant(retType)) {
    pushError(
      ctx.errors,
      node,
      `'?' is only legal inside a function that returns a fallible enum (Ok/Err); '${ctx.funcName}' returns ${formatType(retType)}`,
    );
    return setType(node, ErrorType());
  }

  const operandErr = variantErrPayloadType(operandType);
  const returnErr = variantErrPayloadType(retType);
  if (!typesEqual(operandErr, returnErr)) {
    // Phase 10.E: same-type fast path failed - try the cross-shape path
    // via `Into<ReturnErr>` on the operand's Err payload type. Only
    // struct payloads can carry an `implementsTraits` list today, so
    // anything else (void, prim, enum, array, ...) lands in the same
    // diagnostic the original phase 9.H gate emitted.
    const conversion = lookupIntoImpl(operandErr, returnErr, ctx);
    if (!conversion) {
      pushError(
        ctx.errors,
        node,
        `'?' cannot propagate Err of ${formatType(operandErr)} into a function returning Err of ${formatType(returnErr)} - no \`Into<${formatType(returnErr)}>\` impl on ${formatType(operandErr)}`,
      );
      return setType(node, ErrorType());
    }
    node.tryConvert = conversion;
  }

  node.fallibleEnum = true;
  return setType(node, strippedVariantOkType(operandType));
}

// Phase 10.F: `wait_until(h, deadline_ns): WaitResult<T>` - bounded-wait
// counterpart to the `wait` keyword. Recognized by callee name in
// resolveCall; user-defined `wait_until` functions are shadowed.
//
//   - arg[0]: must resolve to a `Task<T>` (the same shape `wait` accepts);
//     T is extracted and used to instantiate the result type.
//   - arg[1]: deadline in nanoseconds from yoop_now_ns(); must coerce to
//     uint64.
//   - return: `WaitResult<T>` from std/core/concurrency.yoop, which the
//     caller must have imported (otherwise the typechecker can't
//     instantiate the result type and emits a fix-it pointing at the
//     missing import).
//
// The node is stamped with `builtinWaitUntil = true`, `builtinTaskResultType`
// (the T), and `builtinWaitResultType` (the instantiated enum) so codegen
// can lower the call directly.
function resolveWaitUntilCall(node, scope, ctx) {
  if (node.args.length !== 2) {
    pushError(
      ctx.errors,
      node,
      `wait_until(h, deadline_ns) takes exactly 2 arguments, got ${node.args.length}`,
    );
    for (const arg of node.args) resolveExprType(arg, scope, ctx);
    return setType(node, ErrorType());
  }
  const handleType = resolveExprType(node.args[0], scope, ctx);
  if (handleType.kind === typeKinds.error) {
    resolveExprType(node.args[1], scope, ctx);
    return setType(node, ErrorType());
  }
  if (handleType.kind !== typeKinds.task) {
    pushError(
      ctx.errors,
      node,
      `wait_until's first argument must be a Task<T>, got ${formatType(handleType)}`,
    );
    resolveExprType(node.args[1], scope, ctx);
    return setType(node, ErrorType());
  }
  const resultT = handleType.resultType;

  const uint64Type = PrimType(primAnnotations.uint64);
  const deadlineType = resolveExprType(node.args[1], scope, ctx);
  if (deadlineType.kind === typeKinds.error) {
    return setType(node, ErrorType());
  }
  if (deadlineType.kind === typeKinds.untypedInt) {
    coerceUntypedLiteralToTyped(node.args[1], deadlineType, uint64Type, ctx.errors);
  } else if (!typesEqual(deadlineType, uint64Type)) {
    pushError(
      ctx.errors,
      node,
      `wait_until's deadline_ns argument must be uint64, got ${formatType(deadlineType)}`,
    );
    return setType(node, ErrorType());
  }

  const genericDecl = lookupGenericVariantDecl("WaitResult", ctx);
  if (!genericDecl) {
    pushError(
      ctx.errors,
      node,
      `wait_until requires WaitResult<T> in scope - import it from "std/core/concurrency.yoop"`,
    );
    return setType(node, ErrorType());
  }
  const waitResultType = instantiateVariant(
    ctx.typeContext.registry,
    genericDecl,
    [resultT],
  );
  node.builtinWaitUntil = true;
  node.builtinTaskResultType = resultT;
  node.builtinWaitResultType = waitResultType;
  return setType(node, waitResultType);
}

// Phase 10.F.2: `cancel(h): void` - external cancellation primitive.
// Recognized by callee name in resolveCall; user-defined `cancel`
// functions are shadowed. The single arg must be a `Task<T>`; the call
// itself returns void. Codegen lowers to `@yoop_task_cancel(handle_ptr)`.
function resolveCancelCall(node, scope, ctx) {
  if (node.args.length !== 1) {
    pushError(
      ctx.errors,
      node,
      `cancel(h) takes exactly 1 argument, got ${node.args.length}`,
    );
    for (const arg of node.args) resolveExprType(arg, scope, ctx);
    return setType(node, ErrorType());
  }
  const handleType = resolveExprType(node.args[0], scope, ctx);
  if (handleType.kind === typeKinds.error) {
    return setType(node, ErrorType());
  }
  if (handleType.kind !== typeKinds.task) {
    pushError(
      ctx.errors,
      node,
      `cancel's argument must be a Task<T>, got ${formatType(handleType)}`,
    );
    return setType(node, ErrorType());
  }
  node.builtinCancel = true;
  return setType(node, VoidType());
}

// Phase 10.E: look for a `trait Into<T> { function into(ref self): T; }`
// impl that converts `sourceType` into `targetType`. Returns
// `{ mangledName, targetType }` (so codegen knows the symbol to call and
// what to store) or null when no impl matches.
//
// The trait is recognized structurally by name + arity: any TraitType named
// `Into` with a single type arg satisfying `typesEqual(arg, targetType)`
// counts. This mirrors how `Iterable<T>` is recognized in the for-in
// lowering - the std/core trait isn't blessed by identity, it's blessed by
// shape.
function lookupIntoImpl(sourceType, targetType, ctx) {
  if (!sourceType || sourceType.kind !== typeKinds.struct) return null;
  // The struct flowing in from an enum payload field may be the pass-A
  // shell (empty implementsTraits) - re-fetch the canonical version from
  // the right module's structTable so the impl list is populated. Same
  // technique as the for-in / `Iterable` lookup.
  let canonical = sourceType;
  const moduleEnv = ctx.typeContext?.moduleEnv;
  if (sourceType.moduleId && moduleEnv) {
    const env = moduleEnv.get(sourceType.moduleId);
    const fromTable = env?.structTable?.get(sourceType.name);
    if (fromTable) canonical = fromTable;
  } else if (ctx.typeContext?.structTable) {
    const fromTable = ctx.typeContext.structTable.get(sourceType.name);
    if (fromTable) canonical = fromTable;
  }
  const registry = ctx.typeContext?.registry;
  for (const trait of canonical.implementsTraits ?? []) {
    if (trait.name !== "Into") continue;
    const args = registry?.traitArgsByInstance?.get(trait);
    if (!args || args.length !== 1) continue;
    if (!typesEqual(args[0], targetType)) continue;
    return {
      mangledName: mangleTraitMethod(canonical, "Into", "into"),
      targetType,
    };
  }
  return null;
}

function resolveOrphanStructLiteral(node, scope, ctx) {
  for (const field of node.fields) {
    resolveExprType(field.value, scope, ctx);
    field.value.resolvedType = ErrorType();
    pushError(ctx.errors, field.value, `struct literal has no target type`);
  }
  return setType(node, ErrorType());
}

function rootIdentOf(node) {
  while (node.kind === ASTNodeKind.FIELD_ACCESS) {
    node = node.object;
  }
  return node.kind === ASTNodeKind.IDENT ? node : null;
}

// Phase 7.5: look up an enum type by name. Checks the local variantTable then
// imported names. Returns null when the name isn't an enum.
export function lookupVariantTypeByName(name, ctx) {
  const tc = ctx.typeContext;
  if (!tc) return null;
  const local = tc.variantTable?.get(name);
  if (local) return local;
  const imp = tc.importedNames?.get(name);
  if (imp && imp.kind === "type") {
    const srcEnv = tc.moduleEnv?.get(imp.fromModuleId);
    const resolved = srcEnv?.variantTable?.get(imp.exportName);
    if (resolved) return resolved;
  }
  return null;
}

// Phase 10.A: look up a generic enum decl by name. Mirrors lookupVariantTypeByName.
// Returns the generic decl record (not a Type), or null.
export function lookupGenericVariantDecl(name, ctx) {
  const tc = ctx.typeContext;
  if (!tc) return null;
  const local = tc.genericVariantTable?.get(name);
  if (local) return local;
  const imp = tc.importedNames?.get(name);
  if (imp && (imp.kind === "generic-type" || imp.kind === "type")) {
    const srcEnv = tc.moduleEnv?.get(imp.fromModuleId);
    const resolved = srcEnv?.genericVariantTable?.get(imp.exportName);
    if (resolved) return resolved;
  }
  return null;
}

// Phase 12: look up a value-enum type by name. Mirrors lookupVariantTypeByName.
export function lookupValueEnumByName(name, ctx) {
  const tc = ctx.typeContext;
  if (!tc) return null;
  const local = tc.enumTable?.get(name);
  if (local) return local;
  const imp = tc.importedNames?.get(name);
  if (imp && imp.kind === "type") {
    const srcEnv = tc.moduleEnv?.get(imp.fromModuleId);
    const resolved = srcEnv?.enumTable?.get(imp.exportName);
    if (resolved) return resolved;
  }
  return null;
}

// Phase 7.5: look up a union type by name. Mirrors lookupVariantTypeByName.
export function lookupUnionByName(name, ctx) {
  const tc = ctx.typeContext;
  if (!tc) return null;
  const local = tc.unionTable?.get(name);
  if (local) return local;
  const imp = tc.importedNames?.get(name);
  if (imp && imp.kind === "type") {
    const srcEnv = tc.moduleEnv?.get(imp.fromModuleId);
    const resolved = srcEnv?.unionTable?.get(imp.exportName);
    if (resolved) return resolved;
  }
  return null;
}

// Phase 7.5: `Shape.Circle { radius: 5.0 }` - typecheck a variant constructor
// with a payload. The parser also emits this node for the bare no-payload form
// `Shape.Empty`, but only after promotion inside resolveFieldAccess.
// Phase 10.A: if `enumName` resolves to a generic enum decl rather than a
// concrete VariantType, we can't pick an instantiation without a target type.
// In statement position we surface "cannot determine type arguments"; the
// pin path runs through checkInitializer instead.
// Phase 12: if a value-enum case was already stamped during a prior visit
// (resolveFieldAccess promotion path), short-circuit so a second resolution
// pass doesn't re-look-up the name in the variant table and report "unknown
// enum". A pre-stamped node carries `resolvedValueEnumType`.
function resolveVariantConstructor(node, scope, ctx) {
  if (node.resolvedValueEnumType) {
    return setType(node, node.resolvedValueEnumType);
  }
  const enumType = lookupVariantTypeByName(node.enumName, ctx);
  if (!enumType) {
    const genericDecl = lookupGenericVariantDecl(node.enumName, ctx);
    if (genericDecl) {
      // Visit the field expressions so any internal type errors still surface.
      for (const f of node.fields ?? []) {
        resolveExprType(f.value, scope, ctx);
      }
      pushError(
        ctx.errors,
        node,
        `cannot determine type arguments for generic variant "${genericDecl.name}" - pin via a typed binding/return/call argument`,
      );
      return setType(node, ErrorType());
    }
    pushError(
      ctx.errors,
      node,
      `unknown enum "${node.enumName}"`,
    );
    for (const f of node.fields ?? []) {
      resolveExprType(f.value, scope, ctx);
    }
    return setType(node, ErrorType());
  }
  const variant = enumType.variants.get(node.variantName);
  if (!variant) {
    pushError(
      ctx.errors,
      node,
      `enum "${enumType.name}" has no variant "${node.variantName}"`,
    );
    for (const f of node.fields ?? []) {
      resolveExprType(f.value, scope, ctx);
    }
    return setType(node, ErrorType());
  }
  // Stash the resolved variant info for codegen.
  node.resolvedVariantType = enumType;
  node.resolvedVariant = variant;

  if (variant.fields === null) {
    // No-payload variant - fields must be null (or empty) on the constructor.
    if (node.fields && node.fields.length > 0) {
      pushError(
        ctx.errors,
        node,
        `variant "${enumType.name}.${variant.name}" has no payload - drop the '{ ... }'`,
      );
    }
    return setType(node, enumType);
  }

  if (node.fields === null) {
    pushError(
      ctx.errors,
      node,
      `variant "${enumType.name}.${variant.name}" requires fields { ${variant.fields.map((f) => f.name).join(", ")} }`,
    );
    return setType(node, enumType);
  }

  const targetFieldMap = new Map();
  for (const f of variant.fields) targetFieldMap.set(f.name, f.type);
  const seen = new Set();
  for (const litField of node.fields) {
    if (seen.has(litField.name)) {
      pushError(
        ctx.errors,
        litField,
        `duplicate field "${litField.name}" in variant constructor for ${enumType.name}.${variant.name}`,
      );
      continue;
    }
    seen.add(litField.name);
    const expected = targetFieldMap.get(litField.name);
    if (!expected) {
      pushError(
        ctx.errors,
        litField,
        `variant "${enumType.name}.${variant.name}" has no field "${litField.name}"`,
      );
      resolveExprType(litField.value, scope, ctx);
      continue;
    }
    checkInitializer(
      litField.value,
      expected,
      scope,
      ctx,
      (actualType) =>
        `cannot assign ${formatType(actualType)} to field "${litField.name}" of ${enumType.name}.${variant.name} (expected ${formatType(expected)})`,
    );
  }
  for (const targetField of variant.fields) {
    if (!node.fields.some((f) => f.name === targetField.name)) {
      pushError(
        ctx.errors,
        node,
        `missing field "${targetField.name}" in variant constructor for ${enumType.name}.${variant.name}`,
      );
    }
  }
  return setType(node, enumType);
}

// Phase 10.A: pin a generic-enum variant constructor to a concrete
// instantiation supplied by the target type. Stamps `resolvedVariantType` and
// `resolvedVariant` from the instantiated (already-substituted) enum so
// codegen sees concrete field types. Diagnostics mirror the concrete path.
function pinVariantConstructor(node, enumType, scope, ctx) {
  const variant = enumType.variants.get(node.variantName);
  if (!variant) {
    pushError(
      ctx.errors,
      node,
      `enum "${enumType.name}" has no variant "${node.variantName}"`,
    );
    for (const f of node.fields ?? []) {
      resolveExprType(f.value, scope, ctx);
    }
    return setType(node, ErrorType());
  }
  node.resolvedVariantType = enumType;
  node.resolvedVariant = variant;

  if (variant.fields === null) {
    if (node.fields && node.fields.length > 0) {
      pushError(
        ctx.errors,
        node,
        `variant "${enumType.name}.${variant.name}" has no payload - drop the '{ ... }'`,
      );
    }
    return setType(node, enumType);
  }

  if (node.fields === null) {
    pushError(
      ctx.errors,
      node,
      `variant "${enumType.name}.${variant.name}" requires fields { ${variant.fields.map((f) => f.name).join(", ")} }`,
    );
    return setType(node, enumType);
  }

  const targetFieldMap = new Map();
  for (const f of variant.fields) targetFieldMap.set(f.name, f.type);
  const seen = new Set();
  for (const litField of node.fields) {
    if (seen.has(litField.name)) {
      pushError(
        ctx.errors,
        litField,
        `duplicate field "${litField.name}" in variant constructor for ${enumType.name}.${variant.name}`,
      );
      continue;
    }
    seen.add(litField.name);
    const expected = targetFieldMap.get(litField.name);
    if (!expected) {
      pushError(
        ctx.errors,
        litField,
        `variant "${enumType.name}.${variant.name}" has no field "${litField.name}"`,
      );
      resolveExprType(litField.value, scope, ctx);
      continue;
    }
    checkInitializer(
      litField.value,
      expected,
      scope,
      ctx,
      (actualType) =>
        `cannot assign ${formatType(actualType)} to field "${litField.name}" of ${enumType.name}.${variant.name} (expected ${formatType(expected)})`,
    );
  }
  for (const targetField of variant.fields) {
    if (!node.fields.some((f) => f.name === targetField.name)) {
      pushError(
        ctx.errors,
        node,
        `missing field "${targetField.name}" in variant constructor for ${enumType.name}.${variant.name}`,
      );
    }
  }
  return setType(node, enumType);
}

// "Does this value-expression fit this target type?"
export function checkInitializer(
  valueNode,
  expectedType,
  scope,
  ctx,
  mismatchMessage,
) {
  if (valueNode.kind === ASTNodeKind.STRUCT_LITERAL) {
    pinStructLiteral(valueNode, expectedType, scope, ctx);
    return expectedType;
  }
  // Phase 10.A: pin a variant constructor whose enum name belongs to a
  // generic enum decl and whose target type is a matching instantiation.
  // Bare no-payload variants (fields === null with no stamped enum yet)
  // and payload variants both flow through here.
  if (
    valueNode.kind === ASTNodeKind.VARIANT_CONSTRUCTOR &&
    !valueNode.resolvedVariantType &&
    expectedType?.kind === typeKinds.variant &&
    expectedType.genericInstance
  ) {
    const genericDecl = lookupGenericVariantDecl(valueNode.enumName, ctx);
    if (genericDecl && genericDecl.id === expectedType.genericInstance.declId) {
      return pinVariantConstructor(valueNode, expectedType, scope, ctx);
    }
  }
  // Phase 10.A: pre-promote a FIELD_ACCESS of shape `GenericEnum.Variant`
  // (bare no-payload form) before resolveExprType has a chance to error
  // about unpinned generic enums. The promotion stamps a VARIANT_CONSTRUCTOR
  // with `resolvedVariantType` unset; pinVariantConstructor then attaches the
  // target instantiation.
  if (
    valueNode.kind === ASTNodeKind.FIELD_ACCESS &&
    valueNode.object?.kind === ASTNodeKind.IDENT &&
    expectedType?.kind === typeKinds.variant &&
    expectedType.genericInstance
  ) {
    const genericDecl = lookupGenericVariantDecl(valueNode.object.name, ctx);
    if (genericDecl && genericDecl.id === expectedType.genericInstance.declId) {
      const variantName = valueNode.field;
      const variant = genericDecl.genericVariants?.get(variantName);
      if (variant && variant.fields === null) {
        valueNode.kind = ASTNodeKind.VARIANT_CONSTRUCTOR;
        valueNode.enumName = valueNode.object.name;
        valueNode.variantName = variantName;
        valueNode.fields = null;
        delete valueNode.object;
        delete valueNode.field;
        return pinVariantConstructor(valueNode, expectedType, scope, ctx);
      }
    }
  }
  // Array literal with a known array target type: check elements against elem type
  if (
    valueNode.kind === ASTNodeKind.ARRAY_LITERAL &&
    expectedType.kind === typeKinds.array
  ) {
    checkArrayLiteralAgainstType(valueNode, expectedType, scope, ctx);
    return expectedType;
  }
  // Bidirectional inference for generic function calls: when the callee is a
  // generic function, hint the expected return type so type params that
  // appear only in the return position (e.g. `heap_alloc<T>(n: usize): T[]`)
  // can be inferred from context.
  if (
    valueNode.kind === ASTNodeKind.CALL_EXPRESSION &&
    typeof valueNode.callee === "string"
  ) {
    const generic = lookupGenericFunc(valueNode.callee, ctx);
    if (generic) {
      const valueType = resolveGenericCall(valueNode, generic, scope, ctx, expectedType);
      if (
        valueType.kind !== typeKinds.error &&
        !isAssignable(expectedType, valueType)
      ) {
        pushError(ctx.errors, valueNode, mismatchMessage(valueType));
      }
      return valueType;
    }
  }
  // Same bidirectional inference, but for namespace-prefixed generic calls
  // like `intr.heap_alloc(8)`. The remote module's genericFuncTable carries
  // the canonical decl; we route through resolveGenericCall directly so the
  // expectedType hint reaches return-position type params.
  if (
    valueNode.kind === ASTNodeKind.CALL_EXPRESSION &&
    valueNode.callee &&
    typeof valueNode.callee === "object" &&
    valueNode.callee.kind === ASTNodeKind.FIELD_ACCESS &&
    (valueNode.callee.object?.kind === ASTNodeKind.IDENT ||
      valueNode.callee.object?.kind === ASTNodeKind.NAMESPACE_IDENT)
  ) {
    const callee = valueNode.callee;
    const objBinding =
      lookupInScope(scope, callee.object.name) ??
      (ctx.typeContext.moduleSymbols?.get(callee.object.name)
        ? { type: ctx.typeContext.moduleSymbols.get(callee.object.name) }
        : null);
    const nsType = objBinding?.type;
    if (nsType && nsType.kind === typeKinds.namespace) {
      const srcEnv = ctx.typeContext.moduleEnv?.get(nsType.moduleId);
      const remoteGeneric = srcEnv?.genericFuncTable?.get(callee.field);
      if (remoteGeneric && nsType.exports.has(callee.field)) {
        callee.namespaceLookup = {
          moduleId: nsType.moduleId,
          exportName: callee.field,
        };
        callee.object.kind = ASTNodeKind.NAMESPACE_IDENT;
        callee.object.resolvedType = nsType;
        const valueType = resolveGenericCall(valueNode, remoteGeneric, scope, ctx, expectedType);
        if (
          valueType.kind !== typeKinds.error &&
          !isAssignable(expectedType, valueType)
        ) {
          pushError(ctx.errors, valueNode, mismatchMessage(valueType));
        }
        return valueType;
      }
    }
  }
  const valueType = resolveExprType(valueNode, scope, ctx);
  if (!isAssignable(expectedType, valueType)) {
    pushError(ctx.errors, valueNode, mismatchMessage(valueType));
  }
  coerceUntypedLiteralToTyped(valueNode, valueType, expectedType, ctx.errors);
  return valueType;
}

// Check array literal elements against a known array type's element type.
function checkArrayLiteralAgainstType(litNode, arrayType, scope, ctx) {
  const elemType = arrayType.elem;
  if (litNode.elements.length === 0) {
    litNode.resolvedType = arrayType;
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
  litNode.resolvedType = arrayType;
  litNode.knownElemType = elemType;
}

// `f(a, b)` - checks arity, then runs each arg through checkInitializer
// against the parameter's declared type.
export function resolveCallType(node, sig, scope, ctx) {
  if (sig.params.length !== node.args.length) {
    pushError(
      ctx.errors,
      node,
      `wrong arg count to "${calleeDisplayName(node.callee)}" - expected ${sig.params.length}, got ${node.args.length}`,
    );
    return setType(node, sig.returnType);
  }

  for (let i = 0; i < node.args.length; i++) {
    const param = sig.params[i];
    if (param.isRef) {
      // ref params accept either an explicit `ref expr` taking the address of
      // a local, OR a bare IDENT/field-access whose value is itself ref-typed
      // (so an opaque C handle held in `let win: ref SDL_Window = ...` or in
      // a struct field `handle: ref SDL_Window` can be passed straight
      // through to the next FFI call without writing `ref win`).
      const paramInner = param.type.inner; // param.type is RefType { inner }
      if (
        node.args[i].kind === ASTNodeKind.IDENT ||
        node.args[i].kind === ASTNodeKind.FIELD_ACCESS
      ) {
        const argType = resolveExprType(node.args[i], scope, ctx);
        // For IDENT, resolveIdent auto-derefs ref bindings; consult the
        // binding type directly. For FIELD_ACCESS, the resolved expression
        // type is already the field's declared type (no auto-deref).
        let refType = null;
        if (node.args[i].kind === ASTNodeKind.IDENT) {
          const binding = lookupInScope(scope, node.args[i].name);
          if (binding && binding.type.kind === typeKinds.ref) refType = binding.type;
        } else if (argType && argType.kind === typeKinds.ref) {
          refType = argType;
        }
        if (refType) {
          if (paramInner && refType.inner.kind !== typeKinds.error && !typesEqual(refType.inner, paramInner)) {
            pushError(ctx.errors, node.args[i],
              `ref argument type ${formatType(refType)} does not match param type ${formatType(paramInner)}`);
          }
          node.args[i].resolvedType = param.type;
          node.args[i].passRefBinding = true;
          continue;
        }
      }
      if (node.args[i].kind !== ASTNodeKind.REF_EXPRESSION) {
        const hint = node.args[i].kind === ASTNodeKind.IDENT ? node.args[i].name : "...";
        pushError(ctx.errors, node.args[i],
          `parameter "${param.name}" expects a ref argument - pass with 'ref ${hint}'`);
        resolveExprType(node.args[i], scope, ctx);
        continue;
      }
      // Run resolveExprType on the whole REF_EXPRESSION first so the
      // non-lvalue check inside resolveRefExpression fires (e.g. `ref 42`
      // is rejected here). Then re-derive the inner type for the
      // param-shape check below.
      resolveExprType(node.args[i], scope, ctx);
      // Validate inner expression type matches param's inner type.
      // If the operand is itself a ref binding (e.g. `ref self` in a method body
      // where self: ref T), unwrap one level so it matches the ref T param.
      const innerExpType = resolveExprType(node.args[i].operand, scope, ctx);
      const effectiveInner = innerExpType.kind === typeKinds.ref ? innerExpType.inner : innerExpType;
      if (paramInner && effectiveInner.kind !== typeKinds.error && !typesEqual(effectiveInner, paramInner)) {
        pushError(ctx.errors, node.args[i],
          `ref argument type ${formatType(innerExpType)} does not match param type ${formatType(paramInner)}`);
      }
      node.args[i].resolvedType = param.type;
    } else {
      checkInitializer(
        node.args[i],
        param.type,
        scope,
        ctx,
        (argType) =>
          `arg ${i + 1}(${param.name}) of "${calleeDisplayName(node.callee)}": cannot pass ${formatType(argType)} to ${formatType(param.type)}`,
      );
    }
  }

  // Phase 9.J: `mustNotShare acrossThreads` enforcement at task-spawn sites.
  // A call whose return type is a TaskType is the entry point for handing
  // work off to a worker thread; any argument that resolves to a binding
  // carrying a kind with `mustNotShare acrossThreads` cannot flow across the
  // task boundary.
  if (sig.returnType?.kind === typeKinds.task) {
    enforceMustNotShareAcrossThreads(node, scope, ctx);
  }

  return setType(node, sig.returnType);
}

// Phase 9.J: walk a call's args at a task-spawn site and reject any that
// resolve to an IDENT (or `ref IDENT`) whose binding carries a kindType with
// `mustNotShare acrossThreads`. Diagnostics point at the offending arg so the
// user sees which value is the problem.
function enforceMustNotShareAcrossThreads(node, scope, _ctx) {
  for (const arg of node.args ?? []) {
    const ident =
      arg.kind === ASTNodeKind.IDENT
        ? arg
        : arg.kind === ASTNodeKind.REF_EXPRESSION &&
          arg.operand?.kind === ASTNodeKind.IDENT
        ? arg.operand
        : null;
    if (!ident) continue;
    const binding = lookupInScope(scope, ident.name);
    const kt = binding?.kindType;
    if (!kt) continue;
    if ((kt.mustNotShare ?? []).includes("acrossThreads")) {
      pushError(
        _ctx.errors,
        arg,
        `binding "${ident.name}" has kind "${kt.name}" with 'mustNotShare acrossThreads' — cannot pass into a task spawn`,
      );
    }
  }
}

// Phase 7.4: trait-qualified call resolution - `Steppable.step(ref b1, ...)`.
// The trait is looked up by name; the method's first param must be `ref self`
// and receives a struct (or, inside a generic body, a TypeParamType whose
// bound matches `trait`). Tags the node with `calleeMangledName` for codegen.
function resolveTraitQualifiedCall(node, trait, methodName, scope, ctx) {
  if (node.args.length < 1 || node.args[0].kind !== ASTNodeKind.REF_EXPRESSION) {
    pushError(
      ctx.errors,
      node,
      `trait method "${trait.name}.${methodName}" requires a 'ref' receiver as the first argument`,
    );
    for (const arg of node.args) resolveExprType(arg, scope, ctx);
    return setType(node, ErrorType());
  }

  const operandType = resolveExprType(node.args[0].operand, scope, ctx);
  let recvType = operandType.kind === typeKinds.ref ? operandType.inner : operandType;
  // Inside method bodies, `self`'s inner type may reference a pre-methods
  // shell; re-fetch from structTable for the canonical fully-resolved version.
  if (recvType.kind === typeKinds.struct && ctx.typeContext.structTable) {
    const canonical = ctx.typeContext.structTable.get(recvType.name);
    if (canonical) recvType = canonical;
  }

  // Phase 7.4 + 7.1: if the trait reference is generic (e.g. `Container.get`
  // where Container is `trait Container<T>`), resolve it against the
  // receiver's concrete instantiation by name. The receiver's
  // implementsTraits already contains the substituted TraitType with the
  // concrete method sigs.
  // Phase 9.J: TypeParamType bounds is a list; multi-bound dispatch picks the
  // bound matching `trait.name`. Empty bounds = unbounded type-param can't
  // dispatch a trait method.
  let resolvedTrait = trait;
  if (trait.isGenericTraitRef) {
    const implTraits = recvType.kind === typeKinds.struct
      ? (recvType.implementsTraits ?? [])
      : recvType.kind === typeKinds.typeParam
      ? recvType.bounds ?? []
      : [];
    resolvedTrait = implTraits.find((t) => t.name === trait.name) ?? null;
    if (!resolvedTrait) {
      pushError(
        ctx.errors,
        node,
        `${recvType.kind === typeKinds.typeParam ? `type parameter "${recvType.name}"` : `type "${recvType.name ?? "?"}"`} does not implement trait "${trait.name}"`,
      );
      for (const arg of node.args) resolveExprType(arg, scope, ctx);
      return setType(node, ErrorType());
    }
  }

  // Phase 9.J: the qualifying trait may inherit `methodName` from an ancestor
  // - `BatchIterable.next(...)` where `BatchIterable extends Iterable` and
  // `next` is declared on `Iterable`. Walk the extends chain to find the
  // declaring trait; mangling uses that ancestor's name so dispatch lines up
  // with the LLVM define emitted by validateImplBlock.
  let methodSig = resolvedTrait.methods?.get(methodName);
  let declaringTrait = resolvedTrait;
  if (!methodSig) {
    for (const anc of walkTraitExtends(resolvedTrait)) {
      const sig = anc.methods?.get(methodName);
      if (sig) {
        methodSig = sig;
        declaringTrait = anc;
        break;
      }
    }
  }
  if (!methodSig) {
    pushError(ctx.errors, node, `trait "${resolvedTrait.name}" has no method "${methodName}"`);
    for (const arg of node.args) resolveExprType(arg, scope, ctx);
    return setType(node, ErrorType());
  }

  // Case 1: receiver is a struct implementing the trait.
  // Phase 9.J: extends chain - a type that implements a sub-trait `Child`
  // implicitly implements every ancestor; `validateImplBlock` flattens
  // ancestors into `implementsTraits`, so this check still trips when a struct
  // implements `Child` and the user qualifies via `Parent.method(...)`.
  if (recvType.kind === typeKinds.struct) {
    const implementsIt = (recvType.implementsTraits ?? []).some(
      (t) => t === resolvedTrait || (trait.isGenericTraitRef && t.name === resolvedTrait.name),
    );
    if (!implementsIt) {
      pushError(
        ctx.errors,
        node,
        `type "${recvType.name}" does not implement trait "${resolvedTrait.name}"`,
      );
      for (const arg of node.args) resolveExprType(arg, scope, ctx);
      return setType(node, ErrorType());
    }
    const subbedSig = substituteSelfPlaceholder(methodSig, recvType);
    node.calleeMethodOf = recvType;
    node.calleeTrait = declaringTrait;
    node.calleeMethodName = methodName;
    // Phase 9.J: mangle by the declaring trait, not the qualifying trait, so
    // `BatchIterable.next(...)` lines up with the `Iterable.next` define.
    node.calleeMangledName = mangleTraitMethod(recvType, declaringTrait.name, methodName);
    return resolveCallWithSig(node, subbedSig, scope, ctx);
  }

  // Phase 9.G - Case 3: receiver is a VTableType for this trait. The call
  // lowers to an indirect call through the stored function pointer at the
  // method's field slot, with the vtable's ctx passed as the first arg.
  // The trait method's "ref self" lands as the ctx pointer; the function
  // body knows how to re-interpret it as `ref T` for its concrete T.
  if (recvType.kind === typeKinds.vtable) {
    if (recvType.traitName !== resolvedTrait.name) {
      pushError(
        ctx.errors,
        node,
        `vtable "${recvType.name}" backs trait "${recvType.traitName}", not "${resolvedTrait.name}"`,
      );
      for (const arg of node.args) resolveExprType(arg, scope, ctx);
      return setType(node, ErrorType());
    }
    const fieldIdx = recvType.methodOrder.indexOf(methodName);
    if (fieldIdx < 0) {
      pushError(
        ctx.errors,
        node,
        `vtable "${recvType.name}" has no slot for trait method "${methodName}"`,
      );
      for (const arg of node.args) resolveExprType(arg, scope, ctx);
      return setType(node, ErrorType());
    }
    // Substitute ref self -> ref VTableType so the first-arg ref-check passes.
    // The vtable is the receiver - the user writes `Trait.method(ref vt, ...)`
    // or equivalently `VTableName.method(ref vt, ...)`.
    const subbedSig = substituteSelfPlaceholder(methodSig, recvType);
    node.vtableCall = {
      vtableType: recvType,
      methodName,
      fieldIndex: fieldIdx,
    };
    return resolveCallWithSig(node, subbedSig, scope, ctx);
  }

  // Case 2 (Phase 7.2): receiver is a TypeParamType whose bound list contains
  // this trait - or extends it (Phase 9.J).
  if (recvType.kind === typeKinds.typeParam) {
    const bounds = recvType.bounds ?? [];
    const boundMatchesAncestor = (b) => {
      if (!b) return false;
      if (b === resolvedTrait) return true;
      if (trait.isGenericTraitRef && b.name === resolvedTrait.name) return true;
      for (const t of walkTraitExtends(b)) {
        if (t === resolvedTrait) return true;
        if (trait.isGenericTraitRef && t.name === resolvedTrait.name) return true;
      }
      return false;
    };
    const boundMatches = bounds.some(boundMatchesAncestor);
    if (!boundMatches) {
      pushError(
        ctx.errors,
        node,
        `type parameter "${recvType.name}" is not bound to trait "${resolvedTrait.name}" - add 'implements ${resolvedTrait.name}' to ${recvType.name}'s declaration`,
      );
      for (const arg of node.args) resolveExprType(arg, scope, ctx);
      return setType(node, ErrorType());
    }
    const subbedSig = substituteSelfPlaceholder(methodSig, recvType);
    // Phase 9.J: tag with the declaring trait so codegen's post-substitution
    // rewrite picks the right mangled symbol when `Child.method(...)` lands on
    // a method declared on `Parent`.
    node.boundMethod = {
      methodName,
      traitName: declaringTrait.name,
      traitModuleId: declaringTrait.moduleId,
      receiverParamName: recvType.name,
      receiverOriginDecl: recvType.originDecl,
    };
    node.calleeMethodName = methodName;
    return resolveCallWithSig(node, subbedSig, scope, ctx);
  }

  pushError(
    ctx.errors,
    node,
    `trait method "${trait.name}.${methodName}" requires a struct (or trait-bounded type parameter) receiver, got ${formatType(recvType)}`,
  );
  for (const arg of node.args) resolveExprType(arg, scope, ctx);
  return setType(node, ErrorType());
}

// Replace `ref TraitSelfPlaceholder` with `ref concreteType` in a method sig.
function substituteSelfPlaceholder(methodSig, concreteType) {
  const params = methodSig.params.map((p) => {
    if (p.type.kind === typeKinds.ref && p.type.inner === TraitSelfPlaceholder) {
      return { ...p, type: RefType(concreteType) };
    }
    return p;
  });
  return FuncType(params, methodSig.returnType, false);
}

// Look up a trait by name in the current module's trait table or its imports.
// For generic traits (declared as `trait Foo<T>`), returns a placeholder
// `{ isGeneric: true, name }` - `resolveTraitQualifiedCall` matches it
// against the receiver's instantiated trait by name.
// Phase 9.G: VTableName lookup. Mirrors lookupVariantTypeByName / lookupUnionByName
// - checks the local vtableTable, then imports of nominal types.
export function lookupVTableByName(name, ctx) {
  const tc = ctx.typeContext;
  if (!tc) return null;
  const local = tc.vtableTable?.get(name);
  if (local) return local;
  const imp = tc.importedNames?.get(name);
  if (imp && imp.kind === "type") {
    const srcEnv = tc.moduleEnv?.get(imp.fromModuleId);
    const resolved = srcEnv?.vtableTable?.get(imp.exportName);
    if (resolved) return resolved;
  }
  return null;
}

// Phase 9.G: `VTableName.method(...)` dispatch. Two cases:
//   - `from(ref x)`: builtin constructor, returns a vtable value.
//   - `<method>(ref v, ...)`: forwarding form for trait dispatch through
//     the vtable. Equivalent to `Trait.method(ref v, ...)` where v is a
//     vtable value, but lets callers use the vtable type as the dispatch
//     namespace (matches the library-design surface in §8 q1).
function resolveVTableBuiltinCall(node, vtableType, methodName, scope, ctx) {
  if (methodName !== "from") {
    // Forwarding to trait dispatch: synthesize a trait reference and route
    // through resolveTraitQualifiedCall, which already knows how to handle
    // vtable receivers (Case 3).
    const trait =
      ctx.typeContext.traitTable?.get(vtableType.traitName) ??
      lookupTraitByName(vtableType.traitName, ctx);
    if (!trait) {
      pushError(
        ctx.errors,
        node,
        `vtable "${vtableType.name}" backs trait "${vtableType.traitName}", but that trait is not in scope`,
      );
      for (const arg of node.args) resolveExprType(arg, scope, ctx);
      return setType(node, ErrorType());
    }
    return resolveTraitQualifiedCall(node, trait, methodName, scope, ctx);
  }
  if (node.args.length !== 1) {
    pushError(
      ctx.errors,
      node,
      `\`${vtableType.name}.from(ref x)\` expects exactly one ref argument, got ${node.args.length}`,
    );
    for (const arg of node.args) resolveExprType(arg, scope, ctx);
    return setType(node, vtableType);
  }
  const arg = node.args[0];
  if (arg.kind !== ASTNodeKind.REF_EXPRESSION) {
    pushError(
      ctx.errors,
      node,
      `\`${vtableType.name}.from(ref x)\` requires a 'ref' argument`,
    );
    resolveExprType(arg, scope, ctx);
    return setType(node, vtableType);
  }
  const operandType = resolveExprType(arg.operand, scope, ctx);
  let recvType = operandType.kind === typeKinds.ref ? operandType.inner : operandType;
  if (recvType.kind === typeKinds.struct && ctx.typeContext.structTable) {
    const canonical = ctx.typeContext.structTable.get(recvType.name);
    if (canonical) recvType = canonical;
  }
  if (recvType.kind !== typeKinds.struct) {
    pushError(
      ctx.errors,
      node,
      `\`${vtableType.name}.from(ref x)\` requires a struct receiver, got ${formatType(recvType)}`,
    );
    return setType(node, vtableType);
  }
  const implementsIt = (recvType.implementsTraits ?? []).some(
    (t) => t.name === vtableType.traitName
      && (t.moduleId ?? null) === (vtableType.traitModuleId ?? null),
  );
  if (!implementsIt) {
    pushError(
      ctx.errors,
      node,
      `struct "${recvType.name}" does not implement trait "${vtableType.traitName}" required by vtable "${vtableType.name}"`,
    );
    return setType(node, vtableType);
  }
  // Stamp codegen breadcrumbs: vtable to build, struct providing the impl.
  node.vtableBuilder = {
    vtableType,
    implType: recvType,
  };
  arg.resolvedType = operandType;
  return setType(node, vtableType);
}

function lookupTraitByName(name, ctx) {
  const tc = ctx.typeContext;
  const local = tc.traitTable?.get(name);
  if (local) return local;
  const imp = tc.importedNames?.get(name);
  if (imp && imp.kind === "trait") {
    const srcEnv = tc.moduleEnv?.get(imp.fromModuleId);
    const remote = srcEnv?.traitTable.get(imp.exportName);
    if (remote) return remote;
  }
  // Phase 7.4 + Phase 7.1: generic trait reference at a call site. We can't
  // resolve the methodSig from the generic shell directly (it carries
  // TypeParamType placeholders), so return a name-only marker. The receiver
  // will carry the concrete instantiated TraitType we'll resolve through.
  if (tc.genericTraitTable?.has(name)) {
    return { isGenericTraitRef: true, name };
  }
  if (imp && imp.kind === "trait") {
    const srcEnv = tc.moduleEnv?.get(imp.fromModuleId);
    if (srcEnv?.genericTraitTable?.has(imp.exportName)) {
      return { isGenericTraitRef: true, name: imp.exportName };
    }
  }
  return null;
}

// Phase 7.4: when free-function lookup misses, hint at the trait-qualified
// form if any in-scope trait has a method by that name. Returns a hint string
// like '`Steppable.step(...)`' or null.
function traitMethodHint(methodName, ctx) {
  const tc = ctx.typeContext;
  const candidates = [];
  if (tc.traitTable) {
    for (const [traitName, trait] of tc.traitTable) {
      if (trait.methods?.has(methodName)) candidates.push(traitName);
    }
  }
  if (tc.importedNames) {
    for (const [localName, imp] of tc.importedNames) {
      if (imp.kind !== "trait") continue;
      const srcEnv = tc.moduleEnv?.get(imp.fromModuleId);
      const trait = srcEnv?.traitTable.get(imp.exportName);
      if (trait?.methods?.has(methodName)) candidates.push(localName);
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return `\`${candidates[0]}.${methodName}(...)\``;
  return `one of: ${candidates.map((t) => `\`${t}.${methodName}(...)\``).join(", ")}`;
}

// Phase 7.1: look up a generic function decl by name in the local + imported
// generic func tables.
export function lookupGenericFunc(name, ctx) {
  const tc = ctx.typeContext;
  const local = tc.genericFuncTable?.get(name);
  if (local) return local;
  const imp = tc.importedNames?.get(name);
  if (imp) {
    const srcEnv = tc.moduleEnv?.get(imp.fromModuleId);
    const remote = srcEnv?.genericFuncTable?.get(imp.exportName);
    if (remote) return remote;
  }
  return null;
}

// Phase 7.1: unify a generic param type against a concrete arg type, filling
// the `subst` map (paramName -> Type). Returns true on success, false on
// conflict. Untyped literals do NOT pin a type param - only concrete types do.
function unifyAgainstTypeParam(paramType, argType, declId, subst) {
  if (!paramType) return true;
  // If paramType is a TypeParamType belonging to our decl, capture argType.
  if (
    paramType.kind === typeKinds.typeParam &&
    paramType.originDecl === declId
  ) {
    // Skip untyped literals - don't pin a param to "untypedInt".
    if (
      argType.kind === typeKinds.untypedInt ||
      argType.kind === typeKinds.untypedFloat
    ) {
      return true;
    }
    const prev = subst.get(paramType.name);
    if (!prev) {
      subst.set(paramType.name, argType);
      return true;
    }
    return typesEqual(prev, argType);
  }
  // Recursive walks on composite types.
  if (
    paramType.kind === typeKinds.ref &&
    argType?.kind === typeKinds.ref
  ) {
    return unifyAgainstTypeParam(paramType.inner, argType.inner, declId, subst);
  }
  if (
    paramType.kind === typeKinds.array &&
    argType?.kind === typeKinds.array
  ) {
    return unifyAgainstTypeParam(paramType.elem, argType.elem, declId, subst);
  }
  if (
    paramType.kind === typeKinds.task &&
    argType?.kind === typeKinds.task
  ) {
    return unifyAgainstTypeParam(
      paramType.resultType,
      argType.resultType,
      declId,
      subst,
    );
  }
  if (
    paramType.kind === typeKinds.struct &&
    argType?.kind === typeKinds.struct
  ) {
    // Same generic instantiation? Walk field by field.
    if ((paramType.fields ?? []).length !== (argType.fields ?? []).length) {
      return true; // arity differs - caller handles via assignability
    }
    for (let i = 0; i < (paramType.fields ?? []).length; i++) {
      if (
        !unifyAgainstTypeParam(
          paramType.fields[i].type,
          argType.fields[i].type,
          declId,
          subst,
        )
      ) {
        return false;
      }
    }
    return true;
  }
  // Phase 10.X.2: walk function-pointer params + return so a type
  // parameter buried inside an FPT-typed field can drive inference
  // (e.g. `KeyOps<K> { hash: (k: K) => uint64 }` constrains K when
  // the user passes a `KeyOps<int32>` to a generic `lookup<K>`).
  if (
    paramType.kind === typeKinds.functionPointer &&
    argType?.kind === typeKinds.functionPointer
  ) {
    if (paramType.params.length !== argType.params.length) return true;
    for (let i = 0; i < paramType.params.length; i++) {
      if (
        !unifyAgainstTypeParam(
          paramType.params[i],
          argType.params[i],
          declId,
          subst,
        )
      ) {
        return false;
      }
    }
    return unifyAgainstTypeParam(
      paramType.returnType,
      argType.returnType,
      declId,
      subst,
    );
  }
  return true;
}

// Phase 7.1: handle a call to a generic function. Walks param types against
// arg types to infer the type-arg map, then instantiates the function.
//
// `expectedReturnType` (optional): if supplied (typically by `checkInitializer`
// when the call appears in a typed binding/initializer position), the return
// type is also unified against it. This enables type-parameters that only
// appear in the return position to be inferred - e.g. `heap_alloc<T>(n: usize): T[]`
// where T is bound from the LHS annotation.
function resolveGenericCall(node, generic, scope, ctx, expectedReturnType = null) {
  const sig = generic.genericSig;
  if (!sig) {
    pushError(ctx.errors, node, `generic function "${generic.name}" has no resolved signature`);
    return setType(node, ErrorType());
  }
  if (sig.params.length !== node.args.length) {
    pushError(
      ctx.errors,
      node,
      `wrong arg count to "${calleeDisplayName(node.callee)}" - expected ${sig.params.length}, got ${node.args.length}`,
    );
    return setType(node, ErrorType());
  }

  // First pass: resolve each arg's type (without pinning untyped literals)
  // so we can do unification on concrete shapes.
  //
  // Struct-literal args are DEFERRED: a bare `{ field: 1, ... }` has no
  // standalone type (resolveOrphanStructLiteral would emit "struct literal
  // has no target type"), but the param's substituted type after
  // unification IS the target. Stash these indices and check them in
  // the second pass once we know T. See plans/yoopbinder-papercuts.md
  // Issue 2.
  const argTypes = [];
  const deferredStructLits = new Set();
  for (let i = 0; i < node.args.length; i++) {
    if (node.args[i].kind === ASTNodeKind.STRUCT_LITERAL) {
      deferredStructLits.add(i);
      argTypes.push(ErrorType());
      continue;
    }
    const argType = resolveExprType(node.args[i], scope, ctx);
    argTypes.push(argType);
  }

  // Unify.
  const subst = new Map();
  for (let i = 0; i < sig.params.length; i++) {
    const paramT = sig.params[i].type;
    const argT = argTypes[i];
    if (argT.kind === typeKinds.error) continue;
    if (
      !unifyAgainstTypeParam(paramT, argT, generic.id, subst)
    ) {
      pushError(
        ctx.errors,
        node.args[i],
        `conflicting type argument for generic function "${calleeDisplayName(node.callee)}": ${formatType(argT)} vs prior binding`,
      );
    }
  }

  // Return-type-driven inference (e.g. for `heap_alloc<T>(n: usize): T[]`
  // where T appears only in the return). Only applied when a hint is
  // available (initializer / return / arg-pinning contexts).
  if (expectedReturnType && expectedReturnType.kind !== typeKinds.error) {
    unifyAgainstTypeParam(sig.returnType, expectedReturnType, generic.id, subst);
  }

  // Every type param must be bound.
  const concreteArgs = [];
  for (const pn of generic.paramNames) {
    const bound = subst.get(pn);
    if (!bound) {
      pushError(
        ctx.errors,
        node,
        `cannot infer type argument "${pn}" for generic function "${calleeDisplayName(node.callee)}"`,
      );
      return setType(node, ErrorType());
    }
    concreteArgs.push(bound);
  }

  // Phase 7.2 / 9.J: call-site bound check. Runs before instantiation so the
  // diagnostic points at the call site, not the registry side-channel. With
  // multi-bound type params, every bound must be satisfied - fire one check
  // per bound.
  let boundCheckFailed = false;
  for (let i = 0; i < generic.paramNames.length; i++) {
    const pn = generic.paramNames[i];
    const tpType = generic.paramScope?.get(pn);
    const bounds = tpType?.bounds ?? [];
    for (const requiredTrait of bounds) {
      const res = checkBoundSatisfied(concreteArgs[i], requiredTrait);
      if (!res.ok) {
        pushError(
          ctx.errors,
          node,
          `call to "${calleeDisplayName(node.callee)}": type argument "${pn}" = ${formatType(concreteArgs[i])} does not satisfy bound - ${res.message}`,
        );
        boundCheckFailed = true;
      }
    }
  }
  if (boundCheckFailed) {
    return setType(node, ErrorType());
  }

  // Instantiate.
  const inst = instantiateFunc(
    ctx.typeContext.registry,
    generic,
    concreteArgs,
  );
  if (!inst) {
    pushError(ctx.errors, node, `internal: failed to instantiate generic "${calleeDisplayName(node.callee)}"`);
    return setType(node, ErrorType());
  }

  // Second pass: now that we know the substituted param types, check arg
  // assignability and pin untyped literals. Deferred struct literals
  // (see first-pass note) get their target type from the concrete param
  // type and flow through checkInitializer / pinStructLiteral.
  for (let i = 0; i < inst.funcType.params.length; i++) {
    const param = inst.funcType.params[i];
    const argNode = node.args[i];
    if (param.isRef) {
      if (argNode.kind !== ASTNodeKind.REF_EXPRESSION) {
        pushError(
          ctx.errors,
          argNode,
          `parameter "${param.name}" expects a ref argument`,
        );
        continue;
      }
      const innerType = argTypes[i].kind === typeKinds.ref ? argTypes[i].inner : argTypes[i];
      const paramInner = param.type.inner;
      if (paramInner && innerType.kind !== typeKinds.error && !typesEqual(innerType, paramInner)) {
        pushError(
          ctx.errors,
          argNode,
          `ref argument type ${formatType(argTypes[i])} does not match param type ${formatType(paramInner)}`,
        );
      }
      argNode.resolvedType = param.type;
      continue;
    }
    if (deferredStructLits.has(i)) {
      // Pin `{ ... }` to the now-known concrete param type. If the param
      // didn't turn out to be a struct, the struct literal can't fit there
      // - flag it explicitly rather than letting pinStructLiteral spew
      // about a non-struct target.
      if (param.type.kind !== typeKinds.struct) {
        pushError(
          ctx.errors,
          argNode,
          `arg ${i + 1}(${param.name}) of "${calleeDisplayName(node.callee)}": struct literal cannot be passed where ${formatType(param.type)} is expected`,
        );
        continue;
      }
      checkInitializer(argNode, param.type, scope, ctx);
      continue;
    }
    if (argTypes[i].kind === typeKinds.error) continue;
    if (!isAssignable(param.type, argTypes[i])) {
      pushError(
        ctx.errors,
        argNode,
        `arg ${i + 1}(${param.name}) of "${calleeDisplayName(node.callee)}": cannot pass ${formatType(argTypes[i])} to ${formatType(param.type)}`,
      );
    } else {
      coerceUntypedLiteralToTyped(argNode, argTypes[i], param.type, ctx.errors);
    }
  }

  // Annotate the call for codegen.
  node.genericInstantiation = inst;
  node.calleeMangledName = `${inst.moduleId}__${inst.mangledName}`;
  // If the function was imported, the IR symbol still mangles by source module.
  return setType(node, inst.funcType.returnType);
}

// `Foo { x: 1, y: 2 }` - type-checks each field value against the target
// struct's declared field type, reports duplicates and missing fields,
// and stamps the literal node with its resolved type.
export function pinStructLiteral(litNode, targetType, scope, ctx) {
  // Phase 7.5: a union literal looks identical to a struct literal in source
  // (`Color { rgba: 0x...}`), but only one field may be named.
  if (targetType.kind === typeKinds.union) {
    if (litNode.fields.length === 0) {
      pushError(
        ctx.errors,
        litNode,
        `union literal must initialize exactly one field; ${targetType.name} has [${targetType.fields.map((f) => f.name).join(", ")}]`,
      );
      litNode.resolvedType = targetType;
      return;
    }
    if (litNode.fields.length > 1) {
      pushError(
        ctx.errors,
        litNode,
        `union literal must initialize exactly one field - found ${litNode.fields.length} (${litNode.fields.map((f) => f.name).join(", ")})`,
      );
    }
    const targetFieldMap = new Map();
    for (const tf of targetType.fields) targetFieldMap.set(tf.name, tf.type);
    for (const litField of litNode.fields) {
      const expected = targetFieldMap.get(litField.name);
      if (!expected) {
        pushError(
          ctx.errors,
          litField,
          `union "${targetType.name}" has no field "${litField.name}"`,
        );
        resolveExprType(litField.value, scope, ctx);
        continue;
      }
      checkInitializer(
        litField.value,
        expected,
        scope,
        ctx,
        (actualType) =>
          `cannot assign ${formatType(actualType)} to union field "${litField.name}" of union "${targetType.name}" (expected ${formatType(expected)})`,
      );
    }
    litNode.resolvedType = targetType;
    litNode.isUnionLiteral = true;
    return;
  }
  if (targetType.kind !== typeKinds.struct) {
    pushError(
      ctx.errors,
      litNode,
      `cannot pin struct literal to non-struct type ${formatType(targetType)}`,
    );
    return;
  }

  const targetFieldMap = new Map();
  for (const targetField of targetType.fields ?? []) {
    targetFieldMap.set(targetField.name, targetField.type);
  }

  const seen = new Set();
  for (const field of litNode.fields) {
    if (seen.has(field.name)) {
      pushError(
        ctx.errors,
        field,
        `duplicate field "${field.name}" in struct literal for "${targetType.name}"`,
      );
      continue;
    }
    seen.add(field.name);

    const expectedType = targetFieldMap.get(field.name);
    if (!expectedType) {
      pushError(
        ctx.errors,
        field,
        `type "${targetType.name}" has no field "${field.name}"`,
      );
      if (field.value.kind !== ASTNodeKind.STRUCT_LITERAL) {
        resolveExprType(field.value, scope, ctx);
      }
      continue;
    }

    checkInitializer(
      field.value,
      expectedType,
      scope,
      ctx,
      (actualType) =>
        `cannot assign ${formatType(actualType)} to field "${field.name}" of type ${formatType(expectedType)} in struct literal for "${targetType.name}"`,
    );
  }

  for (const targetField of targetType.fields ?? []) {
    if (!litNode.fields.some((f) => f.name === targetField.name)) {
      pushError(
        ctx.errors,
        litNode,
        `missing field "${targetField.name}" in struct literal for "${targetType.name}"`,
      );
    }
  }

  litNode.resolvedType = targetType;
}
