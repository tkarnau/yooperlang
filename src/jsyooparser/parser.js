import {
  lexNext,
  TokenTags,
  inverseTokenTags,
  tokenScanList,
} from "../jsyooplexer/lexer.js";

import {
  ASTNode,
  ASTNodeKind
} from '../contracts.js';

function isBinaryOp(tag) {
  return (
    tag === TokenTags.plus ||
    tag === TokenTags.minus ||
    tag === TokenTags.mult ||
    tag === TokenTags.divide ||
    tag === TokenTags.modulus ||
    tag === TokenTags.eqeq ||
    tag === TokenTags.neq ||
    tag === TokenTags.lt ||
    tag === TokenTags.gt ||
    tag === TokenTags.lte ||
    tag === TokenTags.gte ||
    tag === TokenTags.andand ||
    tag === TokenTags.oror
  );
}

const Precedence = {
  [TokenTags.eq]: 10,
  [TokenTags.oror]: 20,
  [TokenTags.andand]: 30,
  [TokenTags.eqeq]: 40,
  [TokenTags.neq]: 40,
  [TokenTags.lt]: 40,
  [TokenTags.gt]: 40,
  [TokenTags.lte]: 40,
  [TokenTags.gte]: 40,
  [TokenTags.plus]: 50,
  [TokenTags.minus]: 50,
  [TokenTags.mult]: 60,
  [TokenTags.divide]: 60,
};

export function parse(src) {
  let pos = 0;
  let current = null; // current token

  function advance() {
    const tok = current;
    const res = lexNext(src, pos);
    pos = res.nextPos;
    current = res.token;
    return tok;
  }

  function peek() {
    return current;
  }

  function expect(tag) {
    if (current.tag !== tag) {
      throw new Error(
        `expected token ${tag} ${inverseTokenTags[tag]}, got ${current.tag} ${inverseTokenTags[current.tag]} at pos ${current.start}`,
      );
    }
    const tok = current;
    advance();

    return tok;
  }

  // load first token
  advance();

  function parseTopLevel() {
    // root of the current file or program... calling this program for now...
    const node = new ASTNode(ASTNodeKind.PROGRAM);
    try {
      node.body = [];
      while (peek().tag !== TokenTags.eof) {
        // only allow declarations
        const peekTag = peek().tag;
        switch (peekTag) {
          case TokenTags.function:
            {
              node.body.push(parseFunctionDecl());
            }
            break;
          default: {
            throw new Error(
              `unexpected token at top level ${peekTag} ${inverseTokenTags[peekTag]}`,
            );
          }
        }
      }
    } catch (parseErr) {
      console.log("parse error, stopping - AST so far", JSON.stringify(node));
      throw parseErr;
    }

    return node;
  }

  // precedence stuff read from: https://matklad.github.io/2020/04/13/simple-but-powerful-pratt-parsing.html

  function parseExpression(minPrecedence = 0) {
    let node;
    // unary first
    if (peek().tag === TokenTags.minus) {
      advance(); // consume the dash
      const operand = parseExpression(70);
      if (operand.kind === ASTNodeKind.INT_LITERAL || operand.kind === ASTNodeKind.FLOAT_LITERAL) {
        operand.value = -operand.value;
        return operand;
      }

      // non-literal operands, build unary expression node
      node = new ASTNode(ASTNodeKind.UNARY_EXPRESSION);
      node.op = "minus";
      node.operand = operand;

      return node;
    }
    if (peek().tag === TokenTags.intLiteral) {
      node = new ASTNode(ASTNodeKind.INT_LITERAL);
      node.value = advance().intVal;
    } else if (peek().tag === TokenTags.floatLiteral) {
      node = new ASTNode(ASTNodeKind.FLOAT_LITERAL);
      node.value = advance().floatVal;
    } else if (peek().tag === TokenTags.strLiteral) {
      const tok = advance();
      node = new ASTNode(ASTNodeKind.STRING_LITERAL);
      node.value = src.substring(tok.start, tok.start + tok.length);
    } else if (peek().tag === TokenTags.templateLiteral) {
      const tok = advance();
      const raw = src.substring(tok.start, tok.start + tok.length);
      node = parseTemplateLiteralBody(raw);
    } else if (peek().tag === TokenTags.ident) {
      const name = parseIdentAsName();
      if (peek().tag === TokenTags.lparen) {
        // this is a function call
        node = new ASTNode(ASTNodeKind.CALL_EXPRESSION);
        node.callee = name;
        parseCallArgs(node);
      } else if (peek().tag === TokenTags.eq) {
        // assignment
        advance();
        node = new ASTNode(ASTNodeKind.ASSIGNMENT);
        node.name = name;
        node.value = parseExpression();
      } else {
        node = new ASTNode(ASTNodeKind.IDENT);
        node.name = name;
      }
    } else {
      throw new Error(
        `unexpected token in expression: ${peek().tag} ${inverseTokenTags[peek().tag]}`,
      );
    }

    // handle binary ops
    while (true) {
      const opToken = peek();
      const precedence = Precedence[opToken.tag] || 0;
      if (precedence <= minPrecedence) {
        break;
      }

      advance(); // consume op
      const right = parseExpression(precedence);

      const binNode = new ASTNode(ASTNodeKind.BINARY_EXPRESSION);
      binNode.op = inverseTokenTags[opToken.tag];
      binNode.left = node;
      binNode.right = right;
      node = binNode;
    }

    return node;
  }

  // a template literal token still has its surrounding backticks. split it into
  // alternating string parts and embedded expressions, and re-parse each
  // ${...} chunk through the full expression parser.
  function parseTemplateLiteralBody(raw) {
    const inner = raw.slice(1, -1); // strip surrounding backticks
    const parts = []; // each entry: { kind: "stringPart", value } | { kind: "exprPart", expr }
    let buf = "";
    let i = 0;
    while (i < inner.length) {
      const ch = inner[i];
      if (ch === "\\" && i + 1 < inner.length) {
        // pass escape sequence through unchanged; codegen decodes it later
        buf += ch + inner[i + 1];
        i += 2;
        continue;
      }
      if (ch === "$" && inner[i + 1] === "{") {
        if (buf.length > 0) {
          parts.push({ kind: ASTNodeKind.STRING_PART, value: buf });
          buf = "";
        }
        // find matching closing brace, accounting for nested braces
        let depth = 1;
        let j = i + 2;
        while (j < inner.length && depth > 0) {
          if (inner[j] === "{") depth++;
          else if (inner[j] === "}") depth--;
          if (depth === 0) break;
          j++;
        }
        if (depth !== 0) {
          throw new Error(
            `unterminated \${...} in template literal`,
          );
        }
        const exprSrc = inner.substring(i + 2, j);
        // re-parse the expression by recursively invoking parse() on a
        // synthetic top-level wrapper, then unwrap to the inner expression.
        const wrappedSrc = `function __t(): int32 { return ${exprSrc}; }`;
        const subAst = parse(wrappedSrc);
        const exprNode = subAst.body[0].body.body[0].value;
        parts.push({ kind: ASTNodeKind.EXPR_PART, expr: exprNode });
        i = j + 1; // skip past closing }
        continue;
      }
      buf += ch;
      i++;
    }
    if (buf.length > 0) {
      parts.push({ kind: ASTNodeKind.STRING_PART, value: buf });
    }
    const node = new ASTNode(ASTNodeKind.TEMPLATE_LITERAL);
    node.parts = parts;
    return node;
  }

  function parseCallArgs(node) {
    node.args = [];
    expect(TokenTags.lparen);
    while (peek().tag !== TokenTags.rparen && peek().tag !== TokenTags.eof) {
      node.args.push(parseExpression());
      if (peek().tag === TokenTags.comma) {
        advance(); // consume comma, loop continues
      }
    }
    expect(TokenTags.rparen);
  }

  function parseStatement() {
    // only statements
    const peekTag = peek().tag;
    switch (peekTag) {
      case TokenTags.return: {
        return parseReturnStatement();
      }
      case TokenTags.let:
      case TokenTags.const: {
        return parseVarDecl();
      }
      case TokenTags.if: {
        return parseIfStatement();
      }
      case TokenTags.while: {
        return parseWhileStatement();
      }
      default: {
        return parseExpressionStatement();
      }
    }
  }

  function parseReturnStatement() {
    expect(TokenTags.return);
    const node = new ASTNode(ASTNodeKind.RETURN_STATEMENT);
    node.value = parseExpression();
    expect(TokenTags.semicolon);

    return node;
  }

  function parseVarDecl() {
    const varToken = advance();
    let node;
    switch (varToken.tag) {
      case TokenTags.let:
        {
          node = new ASTNode(ASTNodeKind.LET_DECL);
        }
        break;
      case TokenTags.const:
        {
          node = new ASTNode(ASTNodeKind.CONST_DECL);
        }
        break;
      default: {
        throw new Error(
          `unexpected variable declaration token ${varToken.tag} ${inverseTokenTags[varToken.tag]}`,
        );
      }
    }
    node.name = parseIdentAsName();
    expect(TokenTags.colon);
    node.type = parseIdentAsName();
    if (peek().tag === TokenTags.semicolon) {
      advance();
      return node;
    }
    expect(TokenTags.eq);
    node.assignment = parseExpression();
    expect(TokenTags.semicolon);

    return node;
  }

  function parseIfStatement() {
    expect(TokenTags.if);
    expect(TokenTags.lparen);
    const node = new ASTNode(ASTNodeKind.IF_STATEMENT);
    node.expression = parseExpression();
    expect(TokenTags.rparen);
    node.body = parseBlock();
    if (peek().tag === TokenTags.else) {
      advance();
      if (peek().tag === TokenTags.lcurly) {
        node.elseBody = parseBlock();
      }
      if (peek().tag === TokenTags.if) {
        node.elseBody = parseIfStatement();
      }
    }

    return node;
  }

  function parseWhileStatement() {
    expect(TokenTags.while);
    expect(TokenTags.lparen);
    const node = new ASTNode(ASTNodeKind.WHILE_STATEMENT);
    node.expression = parseExpression();
    expect(TokenTags.rparen);
    node.body = parseBlock();

    return node;
  }

  function parseExpressionStatement() {
    const node = new ASTNode(ASTNodeKind.EXPRESSION_STATEMENT);
    node.value = parseExpression();
    expect(TokenTags.semicolon);

    return node;
  }

  // expects an identifier, args, curlys, statements...
  function parseFunctionDecl() {
    expect(TokenTags.function);
    const node = new ASTNode(ASTNodeKind.FUNCTION_DECL);
    // name
    node.name = parseIdentAsName();

    // arg signature
    expect(TokenTags.lparen);

    while (peek().tag === TokenTags.ident || peek().tag === TokenTags.comma) {
      if (peek().tag === TokenTags.comma) {
        // just advance past the comma
        advance();
      }
      if (!node.params) {
        node.params = [];
      }
      node.params.push(parseFunctionParam());
    }

    expect(TokenTags.rparen);
    expect(TokenTags.colon);

    node.returnType = parseIdentAsName();

    // end of signature
    // function body
    node.body = parseBlock();

    return node;
  }

  function parseFunctionParam() {
    const node = new ASTNode(ASTNodeKind.PARAM);
    // name
    node.name = parseIdentAsName();

    // type
    expect(TokenTags.colon);
    node.type = parseIdentAsName();

    return node;
  }

  function parseIdentAsName() {
    const identTok = expect(TokenTags.ident);
    const name = src.substring(
      identTok.start,
      identTok.start + identTok.length,
    );

    return name;
  }

  function parseBlock() {
    expect(TokenTags.lcurly);
    const node = new ASTNode(ASTNodeKind.BLOCK);
    node.body = [];

    // parse rest of statements
    while (peek().tag !== TokenTags.rcurly && peek().tag !== TokenTags.eof) {
      // just eat them for now...
      node.body.push(parseStatement());
    }

    expect(TokenTags.rcurly);

    return node;
  }

  return parseTopLevel();
}

export function testParser(src) {
  const test1 = `
    function add(a: int32, b: int32): int32 {
        return a + b;
      }

      function main(): void {
        const x: int32 = 10;
        const y: int32 = 20;
        const sum: int32 = add(x, y);

        if (sum >= 25) {
          let count: int32 = 0;
          while (count < 3) {
            count = count * 2 + 3;
          }
        } else {
          // who cares
        }
      }
  `;

  const test1Ast = parse(test1);
  const expectedResult = `{"kind":"program","body":[{"kind":"functionDecl","name":"add","params":[{"kind":"param","name":"a","type":"int32"},{"kind":"param","name":"b","type":"int32"}],"returnType":"int32","body":{"kind":"block","body":[{"kind":"returnStatement","value":{"kind":"binaryExpression","op":"plus","left":{"kind":"ident","name":"a"},"right":{"kind":"ident","name":"b"}}}]}},{"kind":"functionDecl","name":"main","returnType":"void","body":{"kind":"block","body":[{"kind":"constDecl","name":"x","type":"int32","assignment":{"kind":"intLiteral","value":10}},{"kind":"constDecl","name":"y","type":"int32","assignment":{"kind":"intLiteral","value":20}},{"kind":"constDecl","name":"sum","type":"int32","assignment":{"kind":"callExpression","callee":"add","args":[{"kind":"ident","name":"x"},{"kind":"ident","name":"y"}]}},{"kind":"ifStatement","expression":{"kind":"binaryExpression","op":"gte","left":{"kind":"ident","name":"sum"},"right":{"kind":"intLiteral","value":25}},"body":{"kind":"block","body":[{"kind":"letDecl","name":"count","type":"int32","assignment":{"kind":"intLiteral","value":0}},{"kind":"whileStatement","expression":{"kind":"binaryExpression","op":"lt","left":{"kind":"ident","name":"count"},"right":{"kind":"intLiteral","value":3}},"body":{"kind":"block","body":[{"kind":"expressionStatement","value":{"kind":"assignment","name":"count","value":{"kind":"binaryExpression","op":"plus","left":{"kind":"binaryExpression","op":"mult","left":{"kind":"ident","name":"count"},"right":{"kind":"intLiteral","value":2}},"right":{"kind":"intLiteral","value":3}}}}]}}]},"elseBody":{"kind":"block","body":[]}}]}}]}`;
  console.log("test1Ast", JSON.stringify(test1Ast) === expectedResult ? "ok" : "failed");
}
