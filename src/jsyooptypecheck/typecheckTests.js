import { typecheck } from "./typecheck.js";


export function runTypecheckTests() {
  // test AST
  const result = typecheck({
    kind: "PROGRAM",
    sourceLoc: {
      pos: 13,
      line: 2,
      column: 13,
    },
    body: [
      {
        kind: "FUNCTION_DECL",
        sourceLoc: {
          pos: 17,
          line: 2,
          column: 17,
        },
        name: "add",
        params: [
          {
            kind: "PARAM",
            sourceLoc: {
              pos: 19,
              line: 2,
              column: 19,
            },
            name: "a",
            type: "int32",
          },
          {
            kind: "PARAM",
            sourceLoc: {
              pos: 29,
              line: 2,
              column: 29,
            },
            name: "b",
            type: "int32",
          },
        ],
        returnType: "int32",
        body: {
          kind: "BLOCK",
          sourceLoc: {
            pos: 61,
            line: 3,
            column: 15,
          },
          body: [
            {
              kind: "RETURN_STATEMENT",
              sourceLoc: {
                pos: 63,
                line: 3,
                column: 17,
              },
              value: {
                kind: "BINARY_EXPRESSION",
                sourceLoc: {
                  pos: 68,
                  line: 3,
                  column: 22,
                },
                op: "plus",
                left: {
                  kind: "IDENT",
                  sourceLoc: {
                    pos: 65,
                    line: 3,
                    column: 19,
                  },
                  name: "a",
                },
                right: {
                  kind: "IDENT",
                  sourceLoc: {
                    pos: 68,
                    line: 3,
                    column: 22,
                  },
                  name: "b",
                },
              },
            },
          ],
        },
      },
      {
        kind: "FUNCTION_DECL",
        sourceLoc: {
          pos: 97,
          line: 6,
          column: 20,
        },
        name: "main",
        returnType: "void",
        body: {
          kind: "BLOCK",
          sourceLoc: {
            pos: 121,
            line: 7,
            column: 14,
          },
          body: [
            {
              kind: "CONST_DECL",
              sourceLoc: {
                pos: 123,
                line: 7,
                column: 16,
              },
              name: "x",
              type: "int32",
              assignment: {
                kind: "INT_LITERAL",
                sourceLoc: {
                  pos: 135,
                  line: 7,
                  column: 28,
                },
                value: 10,
              },
            },
            {
              kind: "CONST_DECL",
              sourceLoc: {
                pos: 152,
                line: 8,
                column: 16,
              },
              name: "y",
              type: "int32",
              assignment: {
                kind: "INT_LITERAL",
                sourceLoc: {
                  pos: 164,
                  line: 8,
                  column: 28,
                },
                value: 20,
              },
            },
            {
              kind: "CONST_DECL",
              sourceLoc: {
                pos: 183,
                line: 9,
                column: 18,
              },
              name: "sum",
              type: "int32",
              assignment: {
                kind: "CALL_EXPRESSION",
                sourceLoc: {
                  pos: 197,
                  line: 9,
                  column: 32,
                },
                callee: "add",
                args: [
                  {
                    kind: "IDENT",
                    sourceLoc: {
                      pos: 199,
                      line: 9,
                      column: 34,
                    },
                    name: "x",
                  },
                  {
                    kind: "IDENT",
                    sourceLoc: {
                      pos: 202,
                      line: 9,
                      column: 37,
                    },
                    name: "y",
                  },
                ],
              },
            },
            {
              kind: "IF_STATEMENT",
              sourceLoc: {
                pos: 220,
                line: 11,
                column: 16,
              },
              expression: {
                kind: "BINARY_EXPRESSION",
                sourceLoc: {
                  pos: 227,
                  line: 11,
                  column: 23,
                },
                op: "gte",
                left: {
                  kind: "IDENT",
                  sourceLoc: {
                    pos: 223,
                    line: 11,
                    column: 19,
                  },
                  name: "sum",
                },
                right: {
                  kind: "INT_LITERAL",
                  sourceLoc: {
                    pos: 226,
                    line: 11,
                    column: 22,
                  },
                  value: 25,
                },
              },
              body: {
                kind: "BLOCK",
                sourceLoc: {
                  pos: 243,
                  line: 12,
                  column: 14,
                },
                body: [
                  {
                    kind: "LET_DECL",
                    sourceLoc: {
                      pos: 249,
                      line: 12,
                      column: 20,
                    },
                    name: "count",
                    type: "int32",
                    assignment: {
                      kind: "INT_LITERAL",
                      sourceLoc: {
                        pos: 260,
                        line: 12,
                        column: 31,
                      },
                      value: 0,
                    },
                  },
                  {
                    kind: "WHILE_STATEMENT",
                    sourceLoc: {
                      pos: 284,
                      line: 13,
                      column: 23,
                    },
                    expression: {
                      kind: "BINARY_EXPRESSION",
                      sourceLoc: {
                        pos: 289,
                        line: 13,
                        column: 28,
                      },
                      op: "lt",
                      left: {
                        kind: "IDENT",
                        sourceLoc: {
                          pos: 286,
                          line: 13,
                          column: 25,
                        },
                        name: "count",
                      },
                      right: {
                        kind: "INT_LITERAL",
                        sourceLoc: {
                          pos: 288,
                          line: 13,
                          column: 27,
                        },
                        value: 3,
                      },
                    },
                    body: {
                      kind: "BLOCK",
                      sourceLoc: {
                        pos: 309,
                        line: 14,
                        column: 18,
                      },
                      body: [
                        {
                          kind: "EXPRESSION_STATEMENT",
                          sourceLoc: {
                            pos: 309,
                            line: 14,
                            column: 18,
                          },
                          value: {
                            kind: "ASSIGNMENT",
                            sourceLoc: {
                              pos: 317,
                              line: 14,
                              column: 26,
                            },
                            name: "count",
                            value: {
                              kind: "BINARY_EXPRESSION",
                              sourceLoc: {
                                pos: 326,
                                line: 14,
                                column: 35,
                              },
                              op: "plus",
                              left: {
                                kind: "BINARY_EXPRESSION",
                                sourceLoc: {
                                  pos: 323,
                                  line: 14,
                                  column: 32,
                                },
                                op: "mult",
                                left: {
                                  kind: "IDENT",
                                  sourceLoc: {
                                    pos: 319,
                                    line: 14,
                                    column: 28,
                                  },
                                  name: "count",
                                },
                                right: {
                                  kind: "INT_LITERAL",
                                  sourceLoc: {
                                    pos: 321,
                                    line: 14,
                                    column: 30,
                                  },
                                  value: 2,
                                },
                              },
                              right: {
                                kind: "INT_LITERAL",
                                sourceLoc: {
                                  pos: 325,
                                  line: 14,
                                  column: 34,
                                },
                                value: 3,
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
              elseBody: {
                kind: "BLOCK",
                sourceLoc: {
                  pos: 388,
                  line: 18,
                  column: 10,
                },
                body: [],
              },
            },
          ],
        },
      },
    ],
  });

  console.log("Test AST:", JSON.stringify(result, null, 2));
}

runTypecheckTests();
