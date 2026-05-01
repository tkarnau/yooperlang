// type checking standalone pass
// intended to be after parsing and before codegen

import { ASTNodeKind } from "../contracts.js";
import {
  ErrorType,
  isFloatPrim,
  isIntPrim,
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

  // walk ast.body
  for (const decl of ast.body) {
    if (decl.kind === ASTNodeKind.FUNCTION_DECL) {
      // check function
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

function pushError(errors, node, message) {
  errors.push({
    message,
    start: node?.start ?? 0,
    length: node?.length ?? 0,
  });
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

        // TODO: coerce literal to type when rhs is untyped
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
      const t = checkExpr(node.value, scope, ctx);
      if (!isAssignable(ctx.funcReturnType, t)) {
        pushError(
          ctx.errors,
          node,
          `cannot return ${formatType(t)} from "${ctx.funcName}" returning ${formatType(ctx.funcReturnType)}`,
        );
      }
      // todo corce literal to type when value is untyped
      return;
    }
    case ASTNodeKind.EXPRESSION_STATEMENT: {
      checkExpr(node.value, scope, ctx);

      return;
    }
    // todo if-statement
    // todo whilestatement
    // todo call expression as a statement
    default: {
      pushError(
        ctx.errors,
        node,
        `typecheck: unhandled statement kind "${node.kind}`,
      );
    }
  }
}

// is source type assignable to destination type?
function isAssignable(dest, src) {
  if (!dst || !src) {
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
    // todo continue...
  }
}


// function unifyArith(left, right, op) {
//   if (!left || !right) return null;
//   if (left.kind === "error" || right.kind === "error") return ErrorType();

//   const isCmp = ["eqeq", "neq", "lt", "gt", "lte", "gte"].includes(op);
//   const isLogical = op === "and" || op === "or";

//   if (isLogical) {
//     if (isBool(left) && isBool(right)) return PrimType("bool");
//     return null;
//   }

//   // both untyped → stay untyped (pinned later at a typed context)
//   if (left.kind === "untypedInt" && right.kind === "untypedInt") {
//     return isCmp ? PrimType("bool") : UntypedIntType();
//   }
//   if (left.kind === "untypedFloat" && right.kind === "untypedFloat") {
//     return isCmp ? PrimType("bool") : UntypedFloatType();
//   }

//   // one untyped, one typed → typed wins (caller coerces the literal)
//   const typed = left.kind === "prim" ? left : right.kind === "prim" ? right : null;
//   const untyped = left.kind.startsWith("untyped") ? left : right.kind.startsWith("untyped") ? right : null;
//   if (typed && untyped) {
//     if (untyped.kind === "untypedInt" && isIntPrim(typed.name)) return isCmp ? PrimType("bool") : typed;
//     if (untyped.kind === "untypedFloat" && isFloatPrim(typed.name)) return isCmp ? PrimType("bool") : typed;
//     return null;
//   }

//   // both typed → must match exactly (no widening yet)
//   if (typesEqual(left, right)) {
//     if (left.kind !== "prim") return null;
//     if (!(isIntPrim(left.name) || isFloatPrim(left.name))) return null;
//     return isCmp ? PrimType("bool") : left;
//   }

//   return null;
// }