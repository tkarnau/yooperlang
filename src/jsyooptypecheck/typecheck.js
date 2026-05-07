// type checking standalone pass
// intended to be after parsing and before codegen
//
// this file is the orchestration layer:
//   1. collect function signatures and struct shells (pre-pass)
//   2. resolve struct field types (second pre-pass; allows mutual reference)
//   3. for each function, hand off to validateFunction in checkStatement.js
//
// per-AST-kind logic lives in sibling files (checkExpr.js, checkStatement.js,
// coerce.js, scope.js, errors.js, recursiveStruct.js). the pure helpers are
// re-exported here so callers can import them from a single entry point.

import { parse } from "../jsyooparser/parser.js";
import { ASTNodeKind } from "../contracts.js";
import {
  ErrorType,
  FuncType,
  resolveTypeName,
  StructType,
} from "./types.js";
import { formatType } from "./errors.js";
import { coerceLiteralToType, isAssignable, unifyArith } from "./coerce.js";
import { detectRecursiveField } from "./recursiveStruct.js";
import { validateFunction } from "./checkStatement.js";

export { formatType, coerceLiteralToType, isAssignable, unifyArith };

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
  const structTable = new Map(); // name -> StructType

  const typeContext = {
    moduleSymbols,
    structTable,
  };

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
            type: resolveTypeName(p.type, structTable) ?? ErrorType(),
          })),
          resolveTypeName(decl.returnType, structTable) ?? ErrorType(),
        );
        moduleSymbols.set(decl.name, funcType);
      }
    }
    if (decl.kind === ASTNodeKind.TYPE_DECL) {
      // Handle type declaration
      // two stage so that types can refer to themselves or each other
      // don't worry about fields for now
      if (structTable.has(decl.name)) {
        errors.push({
          message: `redeclaration of type "${decl.name}"`,
          sourceLoc: decl.sourceLoc,
        });
      } else {
        structTable.set(decl.name, StructType(decl.name, null)); // null fields for now
      }
    }
  }

  // struct fields pass
  for (const decl of ast.body) {
    if (decl.kind === ASTNodeKind.TYPE_DECL) {
      const fields = [];
      for (const field of decl.fields) {
        let fieldType = resolveTypeName(field.type, structTable);
        if (!fieldType) {
          errors.push({
            message: `unknown type "${field.type}" in field "${field.name}" of struct "${decl.name}"`,
            sourceLoc: field.sourceLoc,
          });
          fieldType = ErrorType();
        }
        if (fields.some((f) => f.name === field.name)) {
          errors.push({
            message: `duplicate field name "${field.name}" in struct "${decl.name}"`,
            sourceLoc: field.sourceLoc,
          });
        }
        // check for recursive fields:
        if (detectRecursiveField(decl.name, fieldType)) {
          errors.push({
            message: `recursive field "${field.name}" in struct "${decl.name}"`,
            sourceLoc: field.sourceLoc,
          });
        }
        fields.push({ name: field.name, type: fieldType });
        // set the ast resolved type now that fields are resolved
        decl.resolvedType = StructType(decl.name, fields);
      }
    }
  }

  // walk ast.body
  for (const decl of ast.body) {
    if (decl.kind === ASTNodeKind.FUNCTION_DECL) {
      validateFunction(decl, typeContext, errors);
    }
  }

  return { ast, errors };
}


// convenience for tests: parse + typecheck in one call.
// returns { ast, errors } — mirrors typecheck()'s shape.
export function typecheckSource(src) {
  const ast = parse(src);
  return typecheck(ast);
}
