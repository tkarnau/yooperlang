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
//     this type" check in the language — let/const initializers, return
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
  PrimType,
  RefType,
  UntypedFloatType,
  UntypedIntType,
  VoidType,
  isCastableTo,
  isIntPrim,
  primAnnotations,
  primTypeFromName,
  resolveTypeFromName,
  typeKinds,
  typesEqual,
} from "./types.js";
import { pushError, formatType } from "./errors.js";
import { lookupInScope } from "./scope.js";
import { isFallible, strippedTypeOf } from "./fallible.js";
import {
  coerceUntypedLiteralToTyped,
  isAssignable,
  isNumeric,
  unifyArith,
} from "./coerce.js";

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

// `x` — looks up the variable in the lexical scope chain.
// If the binding type is RefType, sets autoDeref and returns the inner type.
function resolveIdent(node, scope, ctx) {
  const binding = lookupInScope(scope, node.name);
  if (binding) {
    if (binding.type.kind === typeKinds.namespace) node.kind = ASTNodeKind.NAMESPACE_IDENT;
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
    return setType(node, modType);
  }
  if (node.name === "self") {
    pushError(ctx.errors, node, `'self' can only be used inside a trait method body`);
  } else {
    pushError(ctx.errors, node, `undefined variable "${node.name}"`);
  }
  return setType(node, ErrorType());
}

// `a + b`, `a == b`, `a && b` — recurses into both sides, then asks
// unifyArith for the resulting type given the operator.
function resolveBinary(node, scope, ctx) {
  const leftType = resolveExprType(node.left, scope, ctx);
  const rightType = resolveExprType(node.right, scope, ctx);
  return setType(node, unifyArith(leftType, rightType, node.op));
}

// `f(a, b, c)` or `ns.f(a, b, c)` — looks up the function (local, imported
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
          `cannot cast ${formatType(argType)} to ${formatType(primType)} — only numeric primitive casts are supported`);
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

  // Namespace call: io.greet("hello") — callee is a FIELD_ACCESS node
  if (callee && typeof callee === "object") {
    const calleeType = resolveExprType(callee, scope, ctx);
    if (calleeType.kind === typeKinds.error) return setType(node, ErrorType());
    if (calleeType.kind !== typeKinds.func) {
      pushError(ctx.errors, node, `expression is not callable`);
      return setType(node, ErrorType());
    }
    return resolveCallWithSig(node, calleeType, scope, ctx);
  }

  // printf legacy path — variadic, type-resolve each arg, no arity check.
  if (callee === "printf") {
    const sig = ctx.typeContext.moduleSymbols.get("printf");
    if (sig) {
      // Declared via extern block — use variadic path
    } else {
      for (const arg of node.args) resolveExprType(arg, scope, ctx);
      return setType(node, PrimType(primAnnotations.int32));
    }
  }

  const sig = ctx.typeContext.moduleSymbols.get(callee) ?? KNOWN_EXTERNS[callee];
  if (!sig) {
    // Try trait method dispatch: callee(ref structValue, ...)
    // Also handles `ref self` inside a method body where self: ref T.
    if (node.args.length >= 1 && node.args[0].kind === ASTNodeKind.REF_EXPRESSION) {
      const operandType = resolveExprType(node.args[0].operand, scope, ctx);
      let structType = operandType.kind === typeKinds.ref ? operandType.inner : operandType;
      // Re-lookup from structTable to get the fully-resolved version with methods populated.
      // Inside method bodies, self's inner type may reference a pre-methods shell.
      if (structType.kind === typeKinds.struct && ctx.typeContext.structTable) {
        const canonical = ctx.typeContext.structTable.get(structType.name);
        if (canonical) structType = canonical;
      }
      if (structType.kind === typeKinds.struct && structType.methods?.has(callee)) {
        const methodSig = structType.methods.get(callee);
        node.calleeMethodOf = structType;
        node.calleeMangledName = `${structType.moduleId}__${structType.name}__${callee}`;
        return resolveCallWithSig(node, methodSig, scope, ctx);
      }
    }
    pushError(ctx.errors, node, `unknown function "${callee}"`);
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

// `` `hi ${name}` `` — every interpolation must be a printable scalar
// (string, bool, or any numeric type). The whole expression is a string.
function resolveTemplateLiteral(node, scope, ctx) {
  for (const part of node.parts) {
    if (part.kind === "STRING_PART") continue;
    if (part.kind === "EXPR_PART") {
      const exprType = resolveExprType(part.expr, scope, ctx);
      if (!isPrintableInTemplate(exprType)) {
        pushError(
          ctx.errors,
          part.expr,
          `template literal interpolation must be a string, bool, int, or float type, found ${formatType(exprType)}`,
        );
      }
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
  pushError(
    ctx.errors,
    node,
    `invalid assignment target kind "${node.target.kind}"`,
  );
  return setType(node, ErrorType());
}

function resolveAssignmentToIdent(node, scope, ctx) {
  const targetName = node.target.name;
  const binding = lookupInScope(scope, targetName);
  if (!binding) {
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
  if (isFallible(binding.type)) {
    binding.errObserved = false;
  }
  return setType(node, binding.type);
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
      `invalid assignment target — root of field chain is not an identifier`,
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

// `obj.field` — receiver must be a struct, namespace, string (for .len), or array (for .len).
function resolveFieldAccess(node, scope, ctx) {
  const objType = resolveExprType(node.object, scope, ctx);
  if (objType.kind === typeKinds.error) {
    return setType(node, ErrorType());
  }

  // namespace.field
  if (objType.kind === typeKinds.namespace) {
    if (!objType.exports.has(node.field)) {
      pushError(ctx.errors, node, `namespace "${node.object.name}" has no export "${node.field}"`);
      return setType(node, ErrorType());
    }
    const moduleEnv = ctx.typeContext.moduleEnv;
    const srcEnv = moduleEnv?.get(objType.moduleId);
    if (!srcEnv) {
      pushError(ctx.errors, node, `internal: namespace module ${objType.moduleId} not found`);
      return setType(node, ErrorType());
    }
    const sym = srcEnv.localSymbols.get(node.field) ?? srcEnv.structTable.get(node.field);
    if (!sym) {
      pushError(ctx.errors, node, `internal: export "${node.field}" not found in module ${objType.moduleId}`);
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
  if (objType.kind === typeKinds.array) {
    pushError(ctx.errors, node, `type ${formatType(objType)} has no field "${node.field}"`);
    return setType(node, ErrorType());
  }

  if (objType.kind !== typeKinds.struct) {
    pushError(ctx.errors, node, `field access on non-struct type ${formatType(objType)}`);
    return setType(node, ErrorType());
  }
  const field = objType.fields?.find((f) => f.name === node.field);
  if (!field) {
    pushError(ctx.errors, node, `type "${objType.name}" has no field "${node.field}"`);
    return setType(node, ErrorType());
  }
  if (node.field === "err") {
    markErrObservedThroughRoot(node.object, scope);
  }
  return setType(node, field.type);
}

// `ref x` — takes the address of an lvalue.
function resolveRefExpression(node, scope, ctx) {
  const operandType = resolveExprType(node.operand, scope, ctx);
  if (operandType.kind === typeKinds.error) return setType(node, ErrorType());
  if (operandType.kind === typeKinds.ref) {
    pushError(ctx.errors, node, `cannot take ref of a ref — 'ref ref T' is not supported`);
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

// `[e1, e2, e3]` — infer element type from first element, check all match.
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

// `xs[i]` — object must be an array, index must be an integer type.
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
    idxType.kind === typeKinds.untypedInt;
  if (!isIntIdx) {
    pushError(ctx.errors, node.index,
      `array index must be an integer type, found ${formatType(idxType)}`);
    return setType(node, ErrorType());
  }
  return setType(node, objType.elem);
}

// Walk down through TRY_OP and FIELD_ACCESS chains looking for an IDENT
// root. If we find one bound in scope, flip its `errObserved` flag so the
// scope-exit check accepts it.
export function markErrObservedThroughRoot(exprNode, scope) {
  let n = exprNode;
  while (n) {
    if (n.kind === ASTNodeKind.IDENT) {
      const b = lookupInScope(scope, n.name);
      if (b) b.errObserved = true;
      return;
    }
    if (n.kind === ASTNodeKind.FIELD_ACCESS) {
      n = n.object;
      continue;
    }
    if (n.kind === ASTNodeKind.TRY_OP) {
      n = n.operand;
      continue;
    }
    return;
  }
}

// `expr?` — postfix propagator.
function resolveTryOp(node, scope, ctx) {
  const operandType = resolveExprType(node.operand, scope, ctx);
  if (operandType.kind === typeKinds.error) {
    return setType(node, ErrorType());
  }
  if (!isFallible(operandType)) {
    pushError(
      ctx.errors,
      node,
      `'?' applied to non-fallible type ${formatType(operandType)} — only structs ending in 'err: string' are fallible`,
    );
    return setType(node, ErrorType());
  }
  if (!isFallible(ctx.funcReturnType)) {
    pushError(
      ctx.errors,
      node,
      `'?' is only legal inside a function that returns a fallible type; '${ctx.funcName}' returns ${formatType(ctx.funcReturnType)}`,
    );
    return setType(node, ErrorType());
  }

  markErrObservedThroughRoot(node.operand, scope);

  const stripped = strippedTypeOf(operandType);
  if (stripped && stripped.kind === "strippedMulti") {
    node.strippedMulti = stripped;
    return setType(node, ErrorType());
  }
  return setType(node, stripped);
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
  // Array literal with a known array target type: check elements against elem type
  if (
    valueNode.kind === ASTNodeKind.ARRAY_LITERAL &&
    expectedType.kind === typeKinds.array
  ) {
    checkArrayLiteralAgainstType(valueNode, expectedType, scope, ctx);
    return expectedType;
  }
  const valueType = resolveExprType(valueNode, scope, ctx);
  if (valueNode.kind === ASTNodeKind.TRY_OP && valueNode.strippedMulti) {
    pushError(
      ctx.errors,
      valueNode,
      `'?' on multi-field fallible type 'struct ${valueNode.strippedMulti.sourceName}' must be destructured (e.g. const { a, b } = f()?;)`,
    );
    return ErrorType();
  }
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

// `f(a, b)` — checks arity, then runs each arg through checkInitializer
// against the parameter's declared type.
export function resolveCallType(node, sig, scope, ctx) {
  if (sig.params.length !== node.args.length) {
    pushError(
      ctx.errors,
      node,
      `wrong arg count to "${node.callee}" — expected ${sig.params.length}, got ${node.args.length}`,
    );
    return setType(node, sig.returnType);
  }

  for (let i = 0; i < node.args.length; i++) {
    const param = sig.params[i];
    if (param.isRef) {
      // ref params require an explicit REF_EXPRESSION at the call site
      if (node.args[i].kind !== ASTNodeKind.REF_EXPRESSION) {
        const hint = node.args[i].kind === ASTNodeKind.IDENT ? node.args[i].name : "...";
        pushError(ctx.errors, node.args[i],
          `parameter "${param.name}" expects a ref argument — pass with 'ref ${hint}'`);
        resolveExprType(node.args[i], scope, ctx);
        continue;
      }
      // Validate inner expression type matches param's inner type.
      // If the operand is itself a ref binding (e.g. `ref self` in a method body
      // where self: ref T), unwrap one level so it matches the ref T param.
      const innerExpType = resolveExprType(node.args[i].operand, scope, ctx);
      const paramInner = param.type.inner; // param.type is RefType { inner }
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
          `arg ${i + 1}(${param.name}) of "${node.callee}": cannot pass ${formatType(argType)} to ${formatType(param.type)}`,
      );
    }
  }

  return setType(node, sig.returnType);
}

// `Foo { x: 1, y: 2 }` — type-checks each field value against the target
// struct's declared field type, reports duplicates and missing fields,
// and stamps the literal node with its resolved type.
export function pinStructLiteral(litNode, targetType, scope, ctx) {
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
