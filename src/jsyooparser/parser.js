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
    tag === TokenTags.star ||
    tag === TokenTags.slash ||
    tag === TokenTags.percent ||
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

export function parse(src) {
  console.log("inverseTokenTags:", inverseTokenTags);
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
      console.log("AST so far", JSON.stringify(node));
      throw parseErr;
    }

    return node;
  }

  function parseExpression() {
    let node;
    if (peek().tag === TokenTags.intLiteral) {
      node = new ASTNode("intLiteral");
      node.value = advance().intVal;
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
    while (isBinaryOp(peek().tag)) {
      const op = advance();
      const right = parseExpression(); // precedence not working yet
      const binNode = new ASTNode("binaryExpression");
      binNode.op = inverseTokenTags[op.tag];
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
