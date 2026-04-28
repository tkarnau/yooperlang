import {
  lexNext,
  TokenTags,
  inverseTokenTags,
  tokenScanList,
} from "../jsyooplexer/lexer.js";

function ASTNode(kind) {
  this.kind = kind;
}

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
    const node = new ASTNode("program");
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
    if (peek().tag === TokenTags.intLiteral) {
      node = new ASTNode("intLiteral");
      node.value = advance().intVal;
    } else if (peek().tag === TokenTags.strLiteral) {
      const tok = advance();
      node = new ASTNode("strLiteral");
      node.value = src.substring(tok.start, tok.start + tok.length);
    } else if (peek().tag === TokenTags.ident) {
      const name = parseIdentAsName();
      if (peek().tag === TokenTags.lparen) {
        // this is a function call
        node = new ASTNode("callExpression");
        node.callee = name;
        parseCallArgs(node);
      } else if (peek().tag === TokenTags.eq) {
        // assignment
        advance();
        node = new ASTNode("assignment");
        node.name = name;
        node.value = parseExpression();
      } else {
        node = new ASTNode("ident");
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

      const binNode = new ASTNode("binaryExpression");
      binNode.op = inverseTokenTags[opToken.tag];
      binNode.left = node;
      binNode.right = right;
      node = binNode;
    }

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
    const node = new ASTNode("returnStatement");
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
          node = new ASTNode("letDecl");
        }
        break;
      case TokenTags.const:
        {
          node = new ASTNode("constDecl");
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
    const node = new ASTNode("ifStatement");
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
    const node = new ASTNode("whileStatement");
    node.expression = parseExpression();
    expect(TokenTags.rparen);
    node.body = parseBlock();

    return node;
  }

  function parseExpressionStatement() {
    const node = new ASTNode("expressionStatement");
    node.value = parseExpression();
    expect(TokenTags.semicolon);

    return node;
  }

  // expects an identifier, args, curlys, statements...
  function parseFunctionDecl() {
    expect(TokenTags.function);
    const node = new ASTNode("functionDecl");
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
    const node = new ASTNode("param");
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
    const node = new ASTNode("block");
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
