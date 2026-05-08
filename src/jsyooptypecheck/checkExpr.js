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
  ErrorType,
  PrimType,
  UntypedFloatType,
  UntypedIntType,
  VoidType,
  primAnnotations,
  resolveTypeFromName,
  typeKinds,
  typesEqual,
} from "./types.js";
import { pushError, formatType } from "./errors.js";
import { lookupInScope } from "./scope.js";
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
function resolveIdent(node, scope, ctx) {
  const binding = lookupInScope(scope, node.name);
  if (!binding) {
    pushError(ctx.errors, node, `undefined variable "${node.name}"`);
    return setType(node, ErrorType());
  }
  return setType(node, binding.type);
}

// `a + b`, `a == b`, `a && b` — recurses into both sides, then asks
// unifyArith for the resulting type given the operator.
function resolveBinary(node, scope, ctx) {
  const leftType = resolveExprType(node.left, scope, ctx);
  const rightType = resolveExprType(node.right, scope, ctx);
  return setType(node, unifyArith(leftType, rightType, node.op));
}

// `f(a, b, c)` — looks up the function (declared in this module or a
// known C extern), then hands off to resolveCallType for arity + args.
function resolveCall(node, scope, ctx) {
  // printf is variadic — type-resolve each arg, no arity/type check.
  if (node.callee === "printf") {
    for (const arg of node.args) {
      resolveExprType(arg, scope, ctx);
    }
    return setType(node, PrimType(primAnnotations.int32));
  }

  const sig =
    ctx.typeContext.moduleSymbols.get(node.callee) ??
    KNOWN_EXTERNS[node.callee];
  if (!sig) {
    pushError(ctx.errors, node, `unknown function "${node.callee}"`);
    return setType(node, ErrorType());
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

// `x = expr` or `x.field = expr`. The target is an lvalue — currently
// either a plain identifier or a chain of field accesses rooted in one.
function resolveAssignment(node, scope, ctx) {
  if (node.target.kind === ASTNodeKind.IDENT) {
    return resolveAssignmentToIdent(node, scope, ctx);
  }
  if (node.target.kind === ASTNodeKind.FIELD_ACCESS) {
    return resolveAssignmentToField(node, scope, ctx);
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

function resolveAssignmentToField(node, scope, ctx) {
  const targetType = resolveExprType(node.target, scope, ctx);
  if (targetType.kind === typeKinds.error) {
    return setType(node, ErrorType());
  }
  // const-ness is checked on the root identifier of the field chain. For
  // `a.b.c = 5`, `a` must be `let`, not `const`.
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

// `obj.field` — receiver must be a struct, and `field` must be one of
// its fields. Result type is the field's declared type.
function resolveFieldAccess(node, scope, ctx) {
  const objType = resolveExprType(node.object, scope, ctx);
  if (objType.kind === typeKinds.error) {
    return setType(node, ErrorType());
  }
  if (objType.kind !== typeKinds.struct) {
    pushError(
      ctx.errors,
      node,
      `field access on non-struct type ${formatType(objType)}`,
    );
    return setType(node, ErrorType());
  }
  const field = objType.fields?.find((f) => f.name === node.field);
  if (!field) {
    pushError(
      ctx.errors,
      node,
      `type "${objType.name}" has no field "${node.field}"`,
    );
    return setType(node, ErrorType());
  }
  return setType(node, field.type);
}

// A struct literal that reaches resolveExprType directly has no expected
// target type to check against — we don't infer struct types from field
// shapes. Walk children to surface their errors, then emit a "no target
// type" error and mark this node as error.
//
// Initializers/return/assignments/args go through checkInitializer, which
// pins struct literals via pinStructLiteral instead, so those paths never
// reach this branch.
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
//
// Used by every place where the language has a known expected type:
//   - `let x: T = expr`   /  `const x: T = expr`
//   - `return expr`
//   - `x = expr`          /  `x.field = expr`
//   - call arguments      (target type = parameter type)
//   - struct-literal field values (target type = declared field type)
//
// Steps:
//   1. If the value is a struct literal, pin it to expectedType. (Struct
//      literals can't be type-checked alone — they need a target.)
//   2. Otherwise: resolve the value's type and, if it doesn't fit
//      expectedType, push an error built from `mismatchMessage`.
//   3. If the value is an untyped int/float literal flowing into a typed
//      int/float prim, finish coercing it (range-check + retype).
//
// Returns the value's resolved type (== expectedType for struct literals).
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
  const valueType = resolveExprType(valueNode, scope, ctx);
  if (!isAssignable(expectedType, valueType)) {
    pushError(ctx.errors, valueNode, mismatchMessage(valueType));
  }
  coerceUntypedLiteralToTyped(valueNode, valueType, expectedType, ctx.errors);
  return valueType;
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
    checkInitializer(
      node.args[i],
      param.type,
      scope,
      ctx,
      (argType) =>
        `arg ${i + 1}(${param.name}) of "${node.callee}": cannot pass ${formatType(argType)} to ${formatType(param.type)}`,
    );
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
      // still walk the value so nested errors surface
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
