export const ASTNodeKind = Object.freeze({
  // declarations
  FUNCTION_DECL: "FUNCTION_DECL",
  LET_DECL: "LET_DECL",
  CONST_DECL: "CONST_DECL",
  TYPE_DECL: "TYPE_DECL",
  FIELD_DECL: "FIELD_DECL",

  // literals
  TEMPLATE_LITERAL: "TEMPLATE_LITERAL",
  STRING_PART: "STRING_PART",
  INT_LITERAL: "INT_LITERAL",
  FLOAT_LITERAL: "FLOAT_LITERAL",
  STRING_LITERAL: "STRING_LITERAL",

  // expressions
  CALL_EXPRESSION: "CALL_EXPRESSION",
  EXPRESSION_STATEMENT: "EXPRESSION_STATEMENT",
  EXPR_PART: "EXPR_PART",
  UNARY_EXPRESSION: "UNARY_EXPRESSION",
  BINARY_EXPRESSION: "BINARY_EXPRESSION",
  FIELD_ACCESS: "FIELD_ACCESS",
  STRUCT_LITERAL: "STRUCT_LITERAL",
  STRUCT_LITERAL_FIELD: "STRUCT_LITERAL_FIELD",

  // other
  BLOCK: "BLOCK",
  PARAM: "PARAM",
  IDENT: "IDENT",
  ASSIGNMENT: "ASSIGNMENT",
  PROGRAM: "PROGRAM",
  RETURN_STATEMENT: "RETURN_STATEMENT",
  IF_STATEMENT: "IF_STATEMENT",
  WHILE_STATEMENT: "WHILE_STATEMENT",

  // test undefined kind handling for iteration tests
  FAIL_TEST_KIND: "FAIL_TEST_KIND",
});

export function SourceLocation(pos, line, column) {
  this.pos = pos;
  this.line = line;
  this.column = column;
}

export function ASTNode(kind, sourceLoc) {
  this.kind = ASTNodeKind[kind];
  if (!this.kind) {
    throw new Error(`Invalid AST node kind: ${kind}`);
  }
  if (sourceLoc) {
    this.sourceLoc = new SourceLocation(sourceLoc.pos, sourceLoc.line, sourceLoc.column);
  }
}
