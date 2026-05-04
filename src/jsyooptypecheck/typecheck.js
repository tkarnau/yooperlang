// type checking standalone pass
// intended to be after parsing and before codegen

import { ASTNodeKind } from "../contracts.js";
import {
  ErrorType,
  FuncType,
  getBitWidthOfIntPrim,
  isFloatPrim,
  isIntPrim,
  isUnsignedIntPrim,
  primAnnotations,
  PrimType,
  primTypeFromName,
  typeKinds,
  typesEqual,
  UntypedFloatType,
  UntypedIntType,
} from "./types.js";

/***************
 * 1. Symbol collection
 * 2. Function bodies
 * 3. Validation rules
 * 4. Error reporting
 */

export function typecheck(ast) {
  // returns { ast, errors }
  // - ast: same node objects, mutated in place with .resolvedType set
  //   on every expression; .resolvedType also set on letDecl/constDecl/
  //   functionDecl/param so codegen can read declared types uniformly
  // - errors: [] of { message, start, length }

  const errors = [];
  const moduleSymbols = new Map(); // name -> FuncType

  // pre-pass to collect function signatures for mutual recursion support, and also to check for duplicate function names
  for (const decl of ast.body) {
    if (decl.kind === ASTNodeKind.FUNCTION_DECL) {
      if (moduleSymbols.has(decl.name)) {
        errors.push({
          message: `redeclaration of function "${decl.name}"`,
          sourceLoc: decl.sourceLoc,
        });
      } else {
        const funcType = FuncType(
          (decl.params ?? []).map((p) => ({
            name: p.name,
            type: primTypeFromName(p.type) ?? ErrorType(),
          })),
          primTypeFromName(decl.returnType) ?? ErrorType(),
        );
        moduleSymbols.set(decl.name, funcType);
      }
    }
  }

  // walk ast.body
  for (const decl of ast.body) {
    if (decl.kind === ASTNodeKind.FUNCTION_DECL) {
      checkFunction(decl, moduleSymbols, errors);
    }
  }

  return { ast, errors };
}

function pushScope(parent) {
  return { parent, bindings: new Map() };
}

function declareInScope(scope, name, type, kind, node, errors) {
  if (scope.bindings.has(name)) {
    pushError(errors, node, `redeclaration of "${name}"`);

    return;
  }
  scope.bindings.set(name, { type, kind });
}

function lookupInScope(scope, name) {
  let s = scope;
  while (s) {
    if (s.bindings.has(name)) {
      return s.bindings.get(name);
    }
    // else continue up to parent scope
    s = s.parent;
  }

  return null; // not found...
}

function pushError(errors, node, message) {
  errors.push({
    message,
    sourceLoc: node?.sourceLoc,
  });
}

function coerceLiteralToType(literalNode, targetType, errors) {
  //coerce untyped literal to the target type with range checking
  if (literalNode.kind === ASTNodeKind.INT_LITERAL) {
    if (!isIntPrim(targetType.name)) {
      pushError(
        errors,
        literalNode,
        `cannot coerce untyped int to non-int type ${formatType(targetType)}`,
      );
      return;
    }
    // range check
    const value = literalNode.value;
    const bitSize = getBitWidthOfIntPrim(targetType.name);
    const isUnsigned = isUnsignedIntPrim(targetType.name);
    // unsigned min is always 0, signed min is -(2^(bits-1))
    const min = isUnsigned ? 0 : -(2 ** (bitSize - 1)); // does this work in javascript?
    // unsigned max is 2^bits - 1, signed max is 2^(bits-1) - 1
    const max = isUnsigned ? 2 ** bitSize - 1 : 2 ** (bitSize - 1) - 1;
    if (value < min || value > max) {
      pushError(
        errors,
        literalNode,
        `integer literal ${value} out of range for type ${formatType(targetType)} (must be between ${min} and ${max})`,
      );
      return;
    }
    literalNode.resolvedType = targetType;
  } else if (literalNode.kind === ASTNodeKind.FLOAT_LITERAL) {
    if (!isFloatPrim(targetType.name)) {
      pushError(
        errors,
        literalNode,
        `cannot coerce untyped float to non-float type ${formatType(targetType)}`,
      );
      return;
    }
    // range check
    // for simplicity, we'll just check that it's a finite number that fits in JS's number type, which is a 64-bit float
    const value = literalNode.value;
    if (typeof value !== "number" || !isFinite(value)) {
      pushError(errors, literalNode, `invalid float literal ${value}`);
      return;
    }
    literalNode.resolvedType = targetType;
  } else {
    pushError(
      errors,
      literalNode,
      `can only coerce untyped literals, found ${literalNode.kind}`,
    );
  }
}

function checkFunction(funcNode, moduleSymbols, errors) {
  // start with null parent
  const scope = pushScope(null);

  for (const param of funcNode.params ?? []) {
    const t = primTypeFromName(param.type) ?? ErrorType();
    if (t.kind === typeKinds.error) {
      pushError(errors, param, `unknown type "${param.type}"`);
    }
    // will create an error if duplicate declaration
    declareInScope(scope, param.name, t, typeKinds.param, param, errors);
    // mutate the node in AST and add the finally resolved type
    param.resolvedType = t;
  }

  const funcReturnType = primTypeFromName(funcNode.returnType) ?? ErrorType();
  if (funcReturnType.kind === typeKinds.error) {
    pushError(errors, funcNode, `unknown return type "${funcNode.returnType}"`);
  }
  funcNode.resolvedType = funcReturnType;

  const ctx = {
    funcReturnType,
    funcName: funcNode.name,
    moduleSymbols,
    errors,
  };
  // now check the statements
  checkStatement(funcNode.body, scope, ctx);
}

function checkStatement(node, scope, ctx) {
  switch (node.kind) {
    case ASTNodeKind.BLOCK: {
      const inner = pushScope(scope);
      for (const s of node.body) {
        checkStatement(s, inner, ctx);
      }

      return;
    }

    case ASTNodeKind.LET_DECL:
    case ASTNodeKind.CONST_DECL: {
      const declaredType = primTypeFromName(node.type) ?? ErrorType();
      if (declaredType.kind === typeKinds.error) {
        pushError(ctx.errors, node, `unknown type "${node.type}"`);
      }
      node.resolvedType = declaredType;

      if (node.assignment) {
        const rhsType = checkExpr(node.assignment, scope, ctx);
        if (!isAssignable(declaredType, rhsType)) {
          pushError(
            ctx.errors,
            node,
            `cannot assign ${formatType(rhsType)} to ${formatType(declaredType)} in initializer of "${node.name}"`,
          );
        }

        if (
          (rhsType.kind === typeKinds.untypedInt &&
            isIntPrim(declaredType.name)) ||
          (rhsType.kind === typeKinds.untypedFloat &&
            isFloatPrim(declaredType.name))
        ) {
          // only call coerceLiteralToType for actual literals (range check);
          // for compound expressions (binary, call, etc.) just pin the resolved type
          if (
            node.assignment.kind === ASTNodeKind.INT_LITERAL ||
            node.assignment.kind === ASTNodeKind.FLOAT_LITERAL
          ) {
            coerceLiteralToType(node.assignment, declaredType, ctx.errors);
          } else {
            node.assignment.resolvedType = declaredType;
          }
        }
      }

      const declKind = node.kind === ASTNodeKind.CONST_DECL ? "const" : "let";
      declareInScope(
        scope,
        node.name,
        declaredType,
        declKind,
        node,
        ctx.errors,
      );

      return;
    }
    case ASTNodeKind.RETURN_STATEMENT: {
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
      // else make sure expression is assignable as the return type
      const returnExprType = checkExpr(node.value, scope, ctx);
      if (!isAssignable(ctx.funcReturnType, returnExprType)) {
        pushError(
          ctx.errors,
          node,
          `cannot return ${formatType(returnExprType)} from "${ctx.funcName}" returning ${formatType(ctx.funcReturnType)}`,
        );
      }
      return;
    }
    case ASTNodeKind.EXPRESSION_STATEMENT: {
      checkExpr(node.value, scope, ctx);

      return;
    }
    case ASTNodeKind.IF_STATEMENT: {
      const boolPrimType = primTypeFromName(primAnnotations.bool);
      const exprType = checkExpr(node.expression, scope, ctx);
      if (!typesEqual(exprType, boolPrimType)) {
        pushError(
          ctx.errors,
          node,
          `if-statement must be a bool type expression, found ${formatType(exprType)}`,
        );
      }
      // always a block for now...
      checkStatement(node.body, scope, ctx);

      // if there's an else body...
      if (node.elseBody) {
        checkStatement(node.elseBody, scope, ctx);
      }

      return;
    }
    case ASTNodeKind.WHILE_STATEMENT: {
      const boolPrimType = primTypeFromName(primAnnotations.bool);
      const exprType = checkExpr(node.expression, scope, ctx);
      if (!typesEqual(exprType, boolPrimType)) {
        pushError(
          ctx.errors,
          node,
          `while-statement must be a bool type expression, found ${formatType(exprType)}`,
        );
      }
      // will be a body block and create its own scope, unless we have blockless support,
      // we could just add another scope but for now skipping this.
      checkStatement(node.body, scope, ctx);

      return;
    }
    // todo call expression as a statement ? do I need this if I have expression statements?
    default: {
      pushError(
        ctx.errors,
        node,
        `typecheck: unhandled statement kind "${node.kind}"`,
      );
    }
  }
}

// is source type assignable to destination type?
function isAssignable(dest, src) {
  if (!dest || !src) {
    return false;
  }
  // if the types equal
  if (typesEqual(dest, src)) {
    return true;
  }
  // if either are an error, return true to suppress cascades
  /*
  "SUPPRESS CASCADES" means that since we're not stopping the typechecking, we can't have an 
  error reported in one type assignment be propagated to more assignments and coercion, otherwise
  we wouldn't really know what the real error is anymore. We know we already have an error so the
  original spot is the only time we want to flag it.
  Example: 
  {
    let x: int32 = "notAnInt"; // real error #1
    let y: int32 = x + 1;      // another type error here because error + int literal
  }
  So... if either type is an error type, we don't flag an assignment error
  */
  if (dest.kind === typeKinds.error || src.kind === typeKinds.error) {
    return true;
  }

  // int
  if (
    src.kind === typeKinds.untypedInt &&
    dest.kind === typeKinds.prim &&
    isIntPrim(dest.name)
  ) {
    return true;
  }

  // float
  if (
    src.kind === typeKinds.untypedFloat &&
    dest.kind === typeKinds.prim &&
    isFloatPrim(dest.name)
  ) {
    return true;
  }

  return false;
}

function checkExpr(node, scope, ctx) {
  switch (node.kind) {
    case ASTNodeKind.INT_LITERAL: {
      node.resolvedType = UntypedIntType();
      return node.resolvedType;
    }
    case ASTNodeKind.FLOAT_LITERAL: {
      node.resolvedType = UntypedFloatType();
      return node.resolvedType;
    }
    case ASTNodeKind.STRING_LITERAL: {
      node.resolvedType = PrimType(primAnnotations.string);
      return node.resolvedType;
    }
    case ASTNodeKind.IDENT: {
      const binding = lookupInScope(scope, node.name);
      if (!binding) {
        pushError(ctx.errors, node, `undefined variable "${node.name}"`);
        node.resolvedType = ErrorType();
        return node.resolvedType;
      }
      node.resolvedType = binding.type;
      return node.resolvedType;
    }
    case ASTNodeKind.BINARY_EXPRESSION: {
      const leftType = checkExpr(node.left, scope, ctx);
      const rightType = checkExpr(node.right, scope, ctx);
      const unified = unifyArith(leftType, rightType, node.op);
      node.resolvedType = unified;
      return unified;
    }
    case ASTNodeKind.CALL_EXPRESSION: {
      // printf is variadic — just recurse into args, no arity/type check
      if (node.callee === "printf") {
        for (const arg of node.args) {
          checkExpr(arg, scope, ctx);
        }
        node.resolvedType = PrimType(primAnnotations.int32);
        return node.resolvedType;
      }

      // Look up callee in module symbols (user-defined functions)
      const sig = ctx.moduleSymbols.get(node.callee);

      if (!sig) {
        // Check known externs
        const knownExterns = {
          puts: {
            params: [PrimType(primAnnotations.string)],
            returnType: PrimType(primAnnotations.int32),
          },
          exit: {
            params: [PrimType(primAnnotations.int32)],
            returnType: VoidType(),
          },
        };
        const externSig = knownExterns[node.callee];
        if (!externSig) {
          pushError(ctx.errors, node, `unknown function "${node.callee}"`);
          node.resolvedType = ErrorType();
          return node.resolvedType;
        }
        // treat extern like a known sig
        return checkCallWithSig(node, externSig, scope, ctx);
      }

      return checkCallWithSig(node, sig, scope, ctx);
    }
    case ASTNodeKind.UNARY_EXPRESSION: {
      const operandType = checkExpr(node.operand, scope, ctx);
      if (node.op === "minus") {
        if (
          operandType.kind === typeKinds.untypedInt ||
          (operandType.kind === typeKinds.prim &&
            isIntPrim(operandType.name)) ||
          operandType.kind === typeKinds.untypedFloat ||
          (operandType.kind === typeKinds.prim && isFloatPrim(operandType.name))
        ) {
          node.resolvedType = operandType;
          return node.resolvedType;
        } else {
          pushError(
            ctx.errors,
            node,
            `unary minus operator requires an int or float operand, found ${formatType(operandType)}`,
          );
          node.resolvedType = ErrorType();
          return node.resolvedType;
        }
      } else if (node.op === "not") {
        const boolPrimType = primTypeFromName(primAnnotations.bool);
        if (typesEqual(operandType, boolPrimType)) {
          node.resolvedType = boolPrimType;
          return node.resolvedType;
        } else {
          pushError(
            ctx.errors,
            node,
            `logical not operator requires a bool operand, found ${formatType(operandType)}`,
          );
          node.resolvedType = ErrorType();
          return node.resolvedType;
        }
      } else {
        pushError(ctx.errors, node, `unknown unary operator "${node.op}"`);
        node.resolvedType = ErrorType();
        return node.resolvedType;
      }
    }
    case ASTNodeKind.TEMPLATE_LITERAL: {
      // check each part: STRING_PART is implicitly string,
      // EXPR_PART contains an .expr we need to typecheck
      for (const part of node.parts) {
        if (part.kind === "STRING_PART") {
          // string literal fragment, always fine
          continue;
        }
        if (part.kind === "EXPR_PART") {
          const exprType = checkExpr(part.expr, scope, ctx);
          // allow int/float/string types in template interpolation
          if (
            !(
              (exprType.kind === typeKinds.prim &&
                (exprType.name === primAnnotations.string ||
                  isIntPrim(exprType.name) ||
                  isFloatPrim(exprType.name))) ||
              exprType.kind === typeKinds.untypedInt ||
              exprType.kind === typeKinds.untypedFloat
            )
          ) {
            pushError(
              ctx.errors,
              part.expr,
              `template literal interpolation must be a string, int, or float type, found ${formatType(exprType)}`,
            );
          }
          continue;
        }
        // unknown part kind
        pushError(
          ctx.errors,
          node,
          `unknown template literal part kind "${part.kind}"`,
        );
      }
      node.resolvedType = PrimType(primAnnotations.string);
      return node.resolvedType;
    }
    case ASTNodeKind.ASSIGNMENT: {
      // assignment target is an lvalue node — IDENT today, FIELD_ACCESS once
      // §4(e) / §5(e) of the structs plan land. dispatch on its kind.
      if (node.target.kind === ASTNodeKind.IDENT) {
        const targetName = node.target.name;
        const binding = lookupInScope(scope, targetName);
        if (!binding) {
          pushError(ctx.errors, node, `undefined variable "${targetName}"`);
          node.resolvedType = ErrorType();
          return node.resolvedType;
        }
        if (binding.kind === "const") {
          pushError(ctx.errors, node, `cannot assign to const "${targetName}"`);
          node.resolvedType = ErrorType();
          return node.resolvedType;
        }
        node.target.resolvedType = binding.type;
        const valueType = checkExpr(node.value, scope, ctx);
        if (!isAssignable(binding.type, valueType)) {
          pushError(
            ctx.errors,
            node,
            `cannot assign ${formatType(valueType)} to ${formatType(binding.type)} in assignment to "${targetName}"`,
          );
        }

        if (
          (valueType.kind === typeKinds.untypedInt &&
            isIntPrim(binding.type.name)) ||
          (valueType.kind === typeKinds.untypedFloat &&
            isFloatPrim(binding.type.name))
        ) {
          // coerce untyped literal to the binding's declared type
          if (
            node.value.kind === ASTNodeKind.INT_LITERAL ||
            node.value.kind === ASTNodeKind.FLOAT_LITERAL
          ) {
            coerceLiteralToType(node.value, binding.type, ctx.errors);
          } else {
            node.value.resolvedType = binding.type;
          }
        }

        node.resolvedType = binding.type;
        return node.resolvedType;
      }

      if (node.target.kind === ASTNodeKind.FIELD_ACCESS) {
        // §4(e) — full field-write checking lands with struct registration.
        // for now: typecheck both sides so cascading errors stay quiet, then
        // bail with an explicit unimplemented marker.
        checkExpr(node.target, scope, ctx);
        checkExpr(node.value, scope, ctx);
        pushError(
          ctx.errors,
          node,
          `field assignment typecheck not yet implemented (struct support pending)`,
        );
        node.resolvedType = ErrorType();
        return node.resolvedType;
      }

      pushError(ctx.errors, node, `invalid assignment target`);
      node.resolvedType = ErrorType();
      return node.resolvedType;
    }
    default: {
      pushError(
        ctx.errors,
        node,
        `typecheck: unhandled expression kind "${node.kind}"`,
      );
      node.resolvedType = ErrorType();
      return node.resolvedType;
    }
  }
}

function checkCallWithSig(node, sig, scope, ctx) {
  // Arity check
  if (sig.params.length !== node.args.length) {
    pushError(
      ctx.errors,
      node,
      `wrong arg count to "${node.callee}" — expected ${sig.params.length}, got ${node.args.length}`,
    );
    node.resolvedType = sig.returnType;
    return node.resolvedType;
  }

  // Type-check each argument
  for (let i = 0; i < node.args.length; i++) {
    const argType = checkExpr(node.args[i], scope, ctx);
    const paramType = sig.params[i].type;
    if (!isAssignable(paramType, argType)) {
      pushError(
        ctx.errors,
        node.args[i],
        `arg ${i + 1}(${sig.params[i].name}) of "${node.callee}": cannot pass ${formatType(argType)} to ${formatType(paramType)}`,
      );
    }
    // TODO: coerce untyped literals to param type
  }

  node.resolvedType = sig.returnType;
  return node.resolvedType;
}

function isBool(t) {
  return t.kind === typeKinds.prim && t.name === primAnnotations.bool;
}

// todo clear up and simplify this logic...
function unifyArith(left, right, op) {
  if (!left || !right) return null;
  if (left.kind === typeKinds.error || right.kind === typeKinds.error)
    return ErrorType();

  const isCmp = ["eqeq", "neq", "lt", "gt", "lte", "gte"].includes(op);
  const isLogical = op === "and" || op === "or";

  if (isLogical) {
    if (isBool(left) && isBool(right)) return PrimType("bool");
    return null;
  }

  // both untyped -> stay untyped (pinned later at a typed context)
  if (
    left.kind === typeKinds.untypedInt &&
    right.kind === typeKinds.untypedInt
  ) {
    return isCmp ? PrimType(primAnnotations.bool) : UntypedIntType();
  }
  if (
    left.kind === typeKinds.untypedFloat &&
    right.kind === typeKinds.untypedFloat
  ) {
    return isCmp ? PrimType(primAnnotations.bool) : UntypedFloatType();
  }

  // one untyped, one typed -> typed wins (caller coerces the literal)
  const typed =
    left.kind === typeKinds.prim
      ? left
      : right.kind === typeKinds.prim
        ? right
        : null;
  const untyped = left.kind.startsWith("untyped")
    ? left
    : right.kind.startsWith("untyped")
      ? right
      : null;
  if (typed && untyped) {
    if (untyped.kind === typeKinds.untypedInt && isIntPrim(typed.name))
      return isCmp ? PrimType(primAnnotations.bool) : typed;
    if (untyped.kind === typeKinds.untypedFloat && isFloatPrim(typed.name))
      return isCmp ? PrimType(primAnnotations.bool) : typed;
    return null;
  }

  // both typed -> must match exactly (no widening yet)
  if (typesEqual(left, right)) {
    if (left.kind !== typeKinds.prim) return null;
    if (!(isIntPrim(left.name) || isFloatPrim(left.name))) return null;
    return isCmp ? PrimType(primAnnotations.bool) : left;
  }

  return null;
}

// takes in a type or a node...
function formatType(t) {
  if (!t) return "null";
  switch (t.kind) {
    case typeKinds.prim:
      return t.name;
    case typeKinds.struct:
      return `struct ${t.name}`;
    case typeKinds.ref:
      return `ref ${formatType(t.inner)}`;
    case typeKinds.array:
      return `array ${formatType(t.elem)}`;
    case typeKinds.func:
      return `(${t.params.map(formatType).join(", ")}) -> ${formatType(t.returnType)}`;
    case typeKinds.void:
      return "void";
    case typeKinds.untypedInt:
      return "untyped int";
    case typeKinds.untypedFloat:
      return "untyped float";
    case typeKinds.error:
      return "error";
    default:
      return `unknown kind ${t.kind}`;
  }
}
