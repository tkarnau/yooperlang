// type checking standalone pass
// intended to be after parsing and before codegen

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

  // walk ast.body
  // for (let topLevelBodyNode of ast.body) {
  //   if (topLevelBodyNode.kind === )
  // }
}

