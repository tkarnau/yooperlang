import { lexNext, TokenTags, inverseTokenTags } from "../jsyooplexer/lexer.js";

function ASTNode(kind) {
  this.kind = kind;
}

export function parse(src) {
  let pos = 0;
  let current = null; // current token

  function advance() {
    const res = lexNext(src, pos);
    pos = res.nextPos;
    current = res.token;
    return current;
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
        if (peek().tag === TokenTags.function) {
          node.body.push(parseFunctionDecl());
        } else {
          throw new Error(
            `unexpected token at top level: ${peek().tag} ${inverseTokenTags[peek().tag]}`,
          );
        }
      }
    } catch (parseErr) {
      console.log("AST so far", JSON.stringify(node));
      throw parseErr;
    }

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
    const name = src.substring(identTok.start, identTok.start + identTok.length);

    return name;
  }

  function parseBlock() {
    const node = new ASTNode("block");
    expect(TokenTags.lcurly);

    // parse rest of statements
    while (peek().tag !== TokenTags.rcurly && peek().tag !== TokenTags.eof) {
      // just eat them for now... 
      // TODO finish implementations!
      if (peek().tag === TokenTags.lcurly) {
        parseBlock(); // toss
      } else {
        advance();
      }
    }

    expect(TokenTags.rcurly);

    return node;
  }

  return parseTopLevel();
}
