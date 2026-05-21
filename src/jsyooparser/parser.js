import {
  lexNext,
  TokenTags,
  inverseTokenTags,
  tokenScanList,
} from "../jsyooplexer/lexer.js";

import { ASTNode, ASTNodeKind } from "../contracts.js";
import { posToSourceLocation } from "../helpers.js";

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
    tag === TokenTags.oror ||
    tag === TokenTags.pipe
  );
}

function isKindClauseStartTag(tag) {
  return (
    tag === TokenTags.appliesTo ||
    tag === TokenTags.requires ||
    tag === TokenTags.mustCall ||
    tag === TokenTags.ownsBlock ||
    tag === TokenTags.mustNotEscape ||
    tag === TokenTags.mustNotShare ||
    tag === TokenTags.forbids ||
    tag === TokenTags.layout
  );
}

// Identifier text -> deferred-feature error message. Used inside kind { ... }
// to produce a precise "not yet supported" error for clause keywords that
// later sub-phases will introduce; today they lex as plain idents.
const DeferredKindClauseMessages = {
  provides: "provides clause not yet supported in phase 6.1",
  autoJoin: "autoJoin not yet supported (phase 6.3)",
  restricts:
    "iteration restrictions deferred until for-in iteration lands (phase 7)",
};

const Precedence = {
  [TokenTags.eq]: 10,
  [TokenTags.oror]: 20,
  [TokenTags.andand]: 30,
  [TokenTags.pipe]: 35,
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
  [TokenTags.modulus]: 60,
};

/*
****************
Main entry point for parsing yooperlang source code.
The parser is a recursive descent parser with Pratt-style precedence handling
for binary operators. It produces an AST where each node has a .kind field
indicating its type, and source location information for error reporting.
The AST is designed to be easily traversable for later stages like type
checking and code generation.
****************
*/
export function parse(src) {
  let pos = 0;
  let current = null; // current token
  // Phase 7.1: when a closing `>` is needed inside a type-application and the
  // next token is `>>` (rshift), we consume the rshift and remember that one
  // virtual `>` remains. The next call to `consumeClosingGt()` returns without
  // advancing. The flag is only consulted by `consumeClosingGt`; other parser
  // sites see the underlying token as usual.
  let pendingGtFromRshift = false;

  // helper functions for token stream management

  // advances to the next token but returns the current one
  // reason for returning the current token is that often the
  // caller needs to read info from the current token with reference
  // to the next token, which is more complex than just reading the
  // next string character.
  function advance() {
    const tok = current;
    const res = lexNext(src, pos);
    if (res.err) {
      // Surface lex errors as parse errors at the *actual* offending
      // position. Without this, lexNext leaves nextPos=0 and the parser
      // mistakes the error for an EOF token at line 1:1, masking the real
      // problem. Find the bad char by skipping whitespace from `pos`.
      let p = pos;
      while (p < src.length && /\s/.test(src[p])) p++;
      throw parseError(`lex: ${res.err}`, p, 1);
    }
    pos = res.nextPos;
    current = res.token;
    return tok;
  }

  // just peeks at the current token without advancing
  function peek() {
    return current;
  }

  // Peek `n` tokens ahead without disturbing parser state. peekAhead(0)
  // is equivalent to peek(); peekAhead(1) is the token following `current`,
  // and so on. Used for statement-start disambiguation where a kind-prefixed
  // binding needs three tokens of lookahead (`IDENT IDENT :`).
  function peekAhead(n) {
    if (n === 0) return current;
    let p = pos;
    let tok = null;
    for (let i = 0; i < n; i++) {
      const r = lexNext(src, p);
      tok = r.token;
      p = r.nextPos;
    }
    return tok;
  }

  // Phase 6.5: given that peekAhead(openIdx) is a `(`, walk forward over
  // balanced parens and return the peek-ahead index of the matching `)`.
  // Returns -1 on EOF before a match.
  function findMatchingRparen(openIdx) {
    let depth = 1;
    let i = openIdx + 1;
    while (depth > 0) {
      const t = peekAhead(i);
      if (t.tag === TokenTags.eof) return -1;
      if (t.tag === TokenTags.lparen) depth++;
      else if (t.tag === TokenTags.rparen) depth--;
      i++;
    }
    return i - 1;
  }

  // Phase 6.5: true if the current tokens look like a kind-prefixed binding
  // start: `IDENT IDENT :` or `IDENT ( ... ) IDENT :`. Used for both
  // statement-start dispatch (implicit-const form) and the `let|const`
  // kind-prefix recognizer.
  function looksLikeKindPrefixedBindingStart() {
    if (peek().tag !== TokenTags.ident) return false;
    if (
      peekAhead(1).tag === TokenTags.ident &&
      peekAhead(2).tag === TokenTags.colon
    ) {
      return true;
    }
    if (peekAhead(1).tag === TokenTags.lparen) {
      const j = findMatchingRparen(1);
      if (j < 0) return false;
      return (
        peekAhead(j + 1).tag === TokenTags.ident &&
        peekAhead(j + 2).tag === TokenTags.colon
      );
    }
    return false;
  }

  // Phase 6.5: consume `IDENT ( argList )?` and return a kindPrefix record.
  // Used at every kind-use site (bindings, parameters, type-decl prefixes).
  function consumeKindPrefixWithArgs() {
    const kindTok = expect(TokenTags.ident);
    const name = src.substring(
      kindTok.start,
      kindTok.start + kindTok.length,
    );
    let args = null;
    if (peek().tag === TokenTags.lparen) {
      advance(); // (
      args = [];
      while (
        peek().tag !== TokenTags.rparen &&
        peek().tag !== TokenTags.eof
      ) {
        args.push(parseExpression());
        if (peek().tag === TokenTags.comma) advance();
      }
      expect(TokenTags.rparen);
    }
    return {
      name,
      args,
      sourceLoc: posToSourceLocation(src, kindTok.start),
    };
  }

  // Format a parse error with source context: the offending line plus a caret.
  function parseError(message, pos = current?.start ?? 0, length = 1) {
    const { line, column } = posToSourceLocation(src, pos);
    const lineText = src.split("\n")[line - 1] ?? "";
    const caret =
      " ".repeat(Math.max(0, column - 1)) + "^".repeat(Math.max(1, length));
    return new Error(
      `${message}\n` +
        `  --> line ${line}:${column}\n` +
        `   | ${lineText}\n` +
        `   | ${caret}`,
    );
  }

  // similar to advance but asserts that the current token is the expected one
  // otherwise we capture an error. Very common to use this for unambiguous
  // sets of tokens, e.g. expecting a semicolon after a statement, or a closing
  // paren after
  function expect(tag) {
    if (current.tag !== tag) {
      throw parseError(
        `expected ${inverseTokenTags[tag]}, got ${inverseTokenTags[current.tag]}`,
        current.start,
        current.length,
      );
    }
    const tok = current;
    advance();

    return tok;
  }

  function buildSourcedNode(kind) {
    return new ASTNode(kind, posToSourceLocation(src, pos));
  }

  // Phase 7.1: consume the closing `>` of a type application or type-param
  // list, splitting a `>>` token in two if needed.
  function consumeClosingGt() {
    if (pendingGtFromRshift) {
      pendingGtFromRshift = false;
      return;
    }
    if (peek().tag === TokenTags.gt) {
      advance();
      return;
    }
    if (peek().tag === TokenTags.rshift) {
      advance();
      pendingGtFromRshift = true;
      return;
    }
    throw parseError(
      `expected '>', got ${inverseTokenTags[peek().tag]}`,
      peek().start,
      peek().length,
    );
  }

  // Phase 7.1: peek at "the next closing-gt-equivalent". Returns true if the
  // current token is `gt`, `rshift`, or a pending split-rshift gt.
  function atClosingGt() {
    if (pendingGtFromRshift) return true;
    return peek().tag === TokenTags.gt || peek().tag === TokenTags.rshift;
  }

  // load first token
  advance();

  // Phase 6.4: shared parser for `propagates<K1, K2, ...>` and `contains<K1, ...>`
  // clauses. Lives on struct decls and function return types. The current token
  // must be `propagates` or `contains` when this is called.
  function parseKindListClause() {
    const tok = advance(); // consume propagates|contains
    const variant = tok.tag === TokenTags.propagates ? "propagates" : "contains";
    expect(TokenTags.lt);
    const kindNames = [];
    if (peek().tag === TokenTags.gt) {
      throw parseError(
        `${variant} requires at least one kind name`,
        peek().start,
        peek().length,
      );
    }
    while (peek().tag !== TokenTags.gt && peek().tag !== TokenTags.eof) {
      const nameTok = expect(TokenTags.ident);
      const name = src.substring(nameTok.start, nameTok.start + nameTok.length);
      // Phase 6.5: optional kind arguments — `propagates<K(args)>`
      let args = null;
      if (peek().tag === TokenTags.lparen) {
        advance();
        args = [];
        while (
          peek().tag !== TokenTags.rparen &&
          peek().tag !== TokenTags.eof
        ) {
          args.push(parseExpression());
          if (peek().tag === TokenTags.comma) advance();
        }
        expect(TokenTags.rparen);
      }
      kindNames.push({
        name,
        args,
        sourceLoc: posToSourceLocation(src, nameTok.start),
      });
      if (peek().tag === TokenTags.comma) advance();
    }
    expect(TokenTags.gt);
    return {
      variant,
      kindNames,
      sourceLoc: posToSourceLocation(src, tok.start),
    };
  }

  // Parse zero-or-more `propagates<...>`/`contains<...>` clauses into the
  // provided node, attaching them as `propagatesClause` / `containsClause`.
  function parsePropagationClauses(node) {
    node.propagatesClause = null;
    node.containsClause = null;
    while (
      peek().tag === TokenTags.propagates ||
      peek().tag === TokenTags.contains
    ) {
      const startTok = peek();
      const clause = parseKindListClause();
      if (clause.variant === "propagates") {
        if (node.propagatesClause) {
          throw parseError(
            "duplicate propagates clause",
            startTok.start,
            startTok.length,
          );
        }
        node.propagatesClause = clause;
      } else {
        if (node.containsClause) {
          throw parseError(
            "duplicate contains clause",
            startTok.start,
            startTok.length,
          );
        }
        node.containsClause = clause;
      }
    }
  }

  // Parse a type annotation and return a structured annotation object.
  //   { kind: "typeName", name: "int32" }
  //   { kind: "refType", inner: <annot> }
  //   { kind: "arrayType", elem: <annot> }
  //   { kind: "typeApplication", name: "Box", typeArgs: [<annot>...] }
  function parseTypeAnnotation() {
    // ref T
    if (peek().tag === TokenTags.ref) {
      advance();
      const inner = parseTypeAnnotation();
      return { kind: "refType", inner };
    }
    // base type name
    const nameTok = expect(TokenTags.ident);
    const name = src.substring(nameTok.start, nameTok.start + nameTok.length);
    let annot;
    // Phase 7.1: any identifier followed by `<` parses as a generic type
    // application. The closing `>` may be the first half of a `>>` token —
    // consumeClosingGt() handles the split.
    if (peek().tag === TokenTags.lt) {
      advance(); // consume <
      const typeArgs = [];
      if (atClosingGt()) {
        throw parseError(
          `empty type argument list <> in type annotation`,
          peek().start,
          peek().length,
        );
      }
      while (true) {
        typeArgs.push(parseTypeAnnotation());
        if (peek().tag === TokenTags.comma) {
          advance();
          if (atClosingGt()) {
            throw parseError(
              `trailing comma in type argument list is not allowed`,
              peek().start,
              peek().length,
            );
          }
          continue;
        }
        break;
      }
      consumeClosingGt();
      annot = { kind: "typeApplication", name, typeArgs };
    } else {
      annot = { kind: "typeName", name };
    }
    // optional [] suffix for arrays — in type position, [ always means T[]
    if (peek().tag === TokenTags.lbracket) {
      advance(); // consume [
      expect(TokenTags.rbracket); // must be ]
      annot = { kind: "arrayType", elem: annot };
    }
    return annot;
  }

  // Phase 7.1: parse `<T, U, V>` after a decl name. Returns an array of
  // TYPE_PARAM AST nodes (possibly empty if no `<` follows).
  function parseTypeParamList() {
    if (peek().tag !== TokenTags.lt) return [];
    advance(); // consume <
    const params = [];
    if (atClosingGt()) {
      throw parseError(
        `empty type parameter list <> is not allowed`,
        peek().start,
        peek().length,
      );
    }
    if (peek().tag === TokenTags.comma) {
      throw parseError(
        `leading comma in type parameter list`,
        peek().start,
        peek().length,
      );
    }
    while (true) {
      const nameTok = expect(TokenTags.ident);
      const paramName = src.substring(
        nameTok.start,
        nameTok.start + nameTok.length,
      );
      const node = new ASTNode(
        ASTNodeKind.TYPE_PARAM,
        posToSourceLocation(src, nameTok.start),
      );
      node.name = paramName;
      // Phase 7.2: optional `implements TraitAnnotation` bound on the param.
      node.bound = null;
      if (peek().tag === TokenTags.implements) {
        const implTok = peek();
        advance(); // consume `implements`
        // Reject `<T implements >` and `<T implements ,>` early.
        if (atClosingGt() || peek().tag === TokenTags.comma) {
          throw parseError(
            `expected trait name after 'implements' in type parameter bound`,
            implTok.start,
            implTok.length,
          );
        }
        if (peek().tag === TokenTags.lparen) {
          throw parseError(
            `multiple trait bounds (e.g. <T implements (Foo, Bar)>) are not yet supported`,
            peek().start,
            peek().length,
          );
        }
        const annot = parseTypeAnnotation();
        if (annot.kind === "refType" || annot.kind === "arrayType") {
          throw parseError(
            `trait bound must be a trait name, not a ref/array type`,
            nameTok.start,
            nameTok.length,
          );
        }
        node.bound = annot;
      }
      params.push(node);
      if (peek().tag === TokenTags.comma) {
        advance();
        // allow trailing comma — break if we hit the closing gt now
        if (atClosingGt()) break;
        continue;
      }
      break;
    }
    consumeClosingGt();
    return params;
  }

  function parseTopLevel() {
    // root of the current file or program... calling this program for now...
    const node = buildSourcedNode(ASTNodeKind.PROGRAM);
    try {
      node.body = [];
      let seenNonImport = false;
      while (peek().tag !== TokenTags.eof) {
        // only allow declarations
        const peekTag = peek().tag;
        switch (peekTag) {
          case TokenTags.function:
          case TokenTags.task:
          case TokenTags.type:
            {
              seenNonImport = true;
              if (peekTag === TokenTags.type) {
                node.body.push(parseTypeDecl());
              } else {
                node.body.push(parseFunctionDecl());
              }
            }
            break;
          case TokenTags.import:
            {
              if (seenNonImport) {
                throw parseError("imports must come before other declarations");
              }
              node.body.push(parseImportDecl());
            }
            break;
          case TokenTags.export:
            {
              seenNonImport = true;
              node.body.push(parseExportDecl());
            }
            break;
          case TokenTags.extern:
            {
              seenNonImport = true;
              node.body.push(parseExternBlock());
            }
            break;
          case TokenTags.trait:
            {
              seenNonImport = true;
              node.body.push(parseTraitDecl());
            }
            break;
          case TokenTags.kind:
            {
              seenNonImport = true;
              node.body.push(parseKindDecl());
            }
            break;
          default: {
            throw parseError(
              `unexpected token at top level: ${inverseTokenTags[peekTag]}`,
              peek().start,
              peek().length,
            );
          }
        }
      }
    } catch (parseErr) {
      throw parseErr;
    }

    return node;
  }

  // Strip surrounding quotes from a strLiteral token value.
  function unquoteStringLiteral(tok) {
    return src.substring(tok.start + 1, tok.start + tok.length - 1);
  }

  function parseKindDecl() {
    const node = buildSourcedNode(ASTNodeKind.KIND_DECL);
    expect(TokenTags.kind);
    node.name = parseIdentAsName();
    node.params = [];
    node.composition = null;

    // parameterized kinds — `kind foo(n: usize, ...)`
    if (peek().tag === TokenTags.lparen) {
      advance(); // (
      while (
        peek().tag !== TokenTags.rparen &&
        peek().tag !== TokenTags.eof
      ) {
        const nameTok = expect(TokenTags.ident);
        const pname = src.substring(
          nameTok.start,
          nameTok.start + nameTok.length,
        );
        expect(TokenTags.colon);
        const annot = parseTypeAnnotation();
        node.params.push({
          name: pname,
          typeAnnotation: annot,
          sourceLoc: posToSourceLocation(src, nameTok.start),
        });
        if (peek().tag === TokenTags.comma) advance();
      }
      expect(TokenTags.rparen);
    }

    // composition — `kind foo = a & b(args) & c;`
    if (peek().tag === TokenTags.eq) {
      advance(); // =
      const kindRefs = [];
      while (true) {
        const refTok = expect(TokenTags.ident);
        const refName = src.substring(
          refTok.start,
          refTok.start + refTok.length,
        );
        const args = [];
        let hasArgs = false;
        if (peek().tag === TokenTags.lparen) {
          hasArgs = true;
          advance(); // (
          while (
            peek().tag !== TokenTags.rparen &&
            peek().tag !== TokenTags.eof
          ) {
            args.push(parseExpression());
            if (peek().tag === TokenTags.comma) advance();
          }
          expect(TokenTags.rparen);
        }
        kindRefs.push({
          name: refName,
          args: hasArgs ? args : null,
          sourceLoc: posToSourceLocation(src, refTok.start),
        });
        if (peek().tag === TokenTags.amp) {
          advance();
          continue;
        }
        break;
      }
      expect(TokenTags.semicolon);
      node.composition = { kindRefs };
      node.clauses = [];
      return node;
    }

    expect(TokenTags.lcurly);

    node.clauses = [];
    while (peek().tag !== TokenTags.rcurly && peek().tag !== TokenTags.eof) {
      if (isKindClauseStartTag(peek().tag)) {
        node.clauses.push(parseKindClause());
        continue;
      }
      // Surface a precise message for deferred-feature clause keywords
      // (they currently lex as plain idents).
      if (peek().tag === TokenTags.ident) {
        const text = src.substring(
          peek().start,
          peek().start + peek().length,
        );
        const msg = DeferredKindClauseMessages[text];
        if (msg) {
          throw parseError(msg, peek().start, peek().length);
        }
      }
      throw parseError(
        `unexpected token in kind declaration: ${inverseTokenTags[peek().tag]}`,
        peek().start,
        peek().length,
      );
    }
    expect(TokenTags.rcurly);

    // exactly-one-appliesTo validation. Per the plan, the default
    // ("any value-site") is forbidden in 6.1 to avoid future surprise.
    const appliesToClauses = node.clauses.filter(
      (c) => c.kind === ASTNodeKind.KIND_APPLIES_TO_CLAUSE,
    );
    if (appliesToClauses.length === 0) {
      throw parseError(
        `kind '${node.name}' missing required 'appliesTo' clause`,
        node.sourceLoc.pos,
        1,
      );
    }
    if (appliesToClauses.length > 1) {
      throw parseError(
        "duplicate appliesTo clause",
        appliesToClauses[1].sourceLoc.pos,
        1,
      );
    }
    return node;
  }

  function parseKindClause() {
    switch (peek().tag) {
      case TokenTags.appliesTo:
        return parseAppliesToClause();
      case TokenTags.requires:
        return parseRequiresClause();
      case TokenTags.mustCall:
        return parseMustCallClause();
      case TokenTags.ownsBlock:
        return parseOwnsBlockClause();
      case TokenTags.mustNotEscape:
        return parseMustNotEscapeClause();
      case TokenTags.mustNotShare:
        return parseMustNotShareClause();
      case TokenTags.forbids:
        return parseForbidsClause();
      case TokenTags.layout:
        return parseLayoutClause();
      default:
        // unreachable — caller guards with isKindClauseStartTag
        throw parseError(
          `unexpected token in kind declaration: ${inverseTokenTags[peek().tag]}`,
          peek().start,
          peek().length,
        );
    }
  }

  function parseAppliesToClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_APPLIES_TO_CLAUSE);
    expect(TokenTags.appliesTo);
    const sites = [];
    while (peek().tag !== TokenTags.semicolon && peek().tag !== TokenTags.eof) {
      const tok = peek();
      let site;
      switch (tok.tag) {
        case TokenTags.binding:
          site = "binding";
          break;
        case TokenTags.parameter:
          site = "parameter";
          break;
        case TokenTags.field:
          site = "field";
          break;
        case TokenTags.function:
          throw parseError(
            "user-declared `appliesTo function` kinds are deferred (phase 7+); the built-in task kind covers the only current use case",
            tok.start,
            tok.length,
          );
        case TokenTags.type:
          site = "type";
          break;
        default: {
          const name =
            tok.tag === TokenTags.ident
              ? src.substring(tok.start, tok.start + tok.length)
              : inverseTokenTags[tok.tag];
          throw parseError(
            `unrecognized appliesTo site '${name}'`,
            tok.start,
            tok.length,
          );
        }
      }
      if (sites.includes(site)) {
        throw parseError(
          `duplicate appliesTo site '${site}'`,
          tok.start,
          tok.length,
        );
      }
      sites.push(site);
      advance();
    }
    if (sites.length === 0) {
      throw parseError(
        "appliesTo requires at least one site",
        peek().start,
        peek().length,
      );
    }
    expect(TokenTags.semicolon);
    node.sites = sites;
    return node;
  }

  function parseMustNotEscapeClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_MUST_NOT_ESCAPE_CLAUSE);
    expect(TokenTags.mustNotEscape);
    if (peek().tag !== TokenTags.scope) {
      const tok = peek();
      const name =
        tok.tag === TokenTags.ident
          ? src.substring(tok.start, tok.start + tok.length)
          : inverseTokenTags[tok.tag];
      throw parseError(
        `mustNotEscape ${name} not yet supported in phase 6.2; only 'scope' is accepted`,
        tok.start,
        tok.length,
      );
    }
    advance(); // consume `scope`
    expect(TokenTags.semicolon);
    node.target = "scope";
    return node;
  }

  function parseMustNotShareClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_MUST_NOT_SHARE_CLAUSE);
    expect(TokenTags.mustNotShare);
    if (peek().tag !== TokenTags.acrossScopes) {
      const tok = peek();
      const name =
        tok.tag === TokenTags.ident
          ? src.substring(tok.start, tok.start + tok.length)
          : inverseTokenTags[tok.tag];
      if (name === "acrossThreads") {
        throw parseError(
          "mustNotShare acrossThreads not yet supported (phase 6.3 wires concurrent sharing)",
          tok.start,
          tok.length,
        );
      }
      throw parseError(
        `unrecognized mustNotShare target '${name}'; only 'acrossScopes' is accepted`,
        tok.start,
        tok.length,
      );
    }
    advance(); // consume `acrossScopes`
    expect(TokenTags.semicolon);
    node.target = "acrossScopes";
    return node;
  }

  function parseLayoutClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_LAYOUT_CLAUSE);
    expect(TokenTags.layout);
    expect(TokenTags.lcurly);
    node.alignExpr = null;
    let sawAlign = false;
    while (peek().tag !== TokenTags.rcurly && peek().tag !== TokenTags.eof) {
      const tok = peek();
      if (tok.tag === TokenTags.align) {
        if (sawAlign) {
          throw parseError(
            "duplicate 'align' sub-clause in layout body",
            tok.start,
            tok.length,
          );
        }
        sawAlign = true;
        advance(); // align
        node.alignExpr = parseExpression();
        expect(TokenTags.semicolon);
        continue;
      }
      // Surface a precise message for any unknown sub-clause name.
      const name =
        tok.tag === TokenTags.ident
          ? src.substring(tok.start, tok.start + tok.length)
          : inverseTokenTags[tok.tag];
      throw parseError(
        `layout sub-clause '${name}' deferred`,
        tok.start,
        tok.length,
      );
    }
    expect(TokenTags.rcurly);
    expect(TokenTags.semicolon);
    if (!sawAlign) {
      throw parseError(
        "layout body must contain an 'align' sub-clause",
        node.sourceLoc.pos,
        1,
      );
    }
    return node;
  }

  function parseForbidsClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_FORBIDS_CLAUSE);
    expect(TokenTags.forbids);
    const categories = [];
    while (peek().tag !== TokenTags.semicolon && peek().tag !== TokenTags.eof) {
      const tok = peek();
      let cat;
      switch (tok.tag) {
        case TokenTags.io:
          cat = "io";
          break;
        case TokenTags.globalState:
          cat = "globalState";
          break;
        default: {
          const name =
            tok.tag === TokenTags.ident
              ? src.substring(tok.start, tok.start + tok.length)
              : inverseTokenTags[tok.tag];
          throw parseError(
            `unrecognized forbids category '${name}'; accepted: io, globalState`,
            tok.start,
            tok.length,
          );
        }
      }
      if (categories.includes(cat)) {
        throw parseError(
          `duplicate forbids category '${cat}'`,
          tok.start,
          tok.length,
        );
      }
      categories.push(cat);
      advance();
    }
    if (categories.length === 0) {
      throw parseError(
        "forbids requires at least one category",
        peek().start,
        peek().length,
      );
    }
    expect(TokenTags.semicolon);
    node.categories = categories;
    return node;
  }

  function parseRequiresClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_REQUIRES_CLAUSE);
    expect(TokenTags.requires);
    node.traitName = parseIdentAsName();
    // List form (`requires A B;`) is reserved.
    if (peek().tag === TokenTags.ident) {
      throw parseError(
        "requires takes a single trait per clause; write multiple 'requires Trait;' clauses for multiple traits",
        peek().start,
        peek().length,
      );
    }
    expect(TokenTags.semicolon);
    return node;
  }

  function parseMustCallClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_MUSTCALL_CLAUSE);
    expect(TokenTags.mustCall);
    // The disjunction/block form `mustCall { a; b; } beforeScopeEnd;` is
    // reserved for later sub-phases.
    if (peek().tag === TokenTags.lcurly) {
      throw parseError(
        "mustCall block form (alternation) not yet supported in phase 6.1; single function name only",
        peek().start,
        peek().length,
      );
    }
    node.methodName = parseIdentAsName();
    // After the method name, expect the timing keyword. `beforeAny` /
    // `afterAny` lex as plain idents today, so handle them by source text.
    if (peek().tag === TokenTags.beforeScopeEnd) {
      advance();
      node.timing = "beforeScopeEnd";
    } else if (peek().tag === TokenTags.ident) {
      const text = src.substring(
        peek().start,
        peek().start + peek().length,
      );
      if (text === "beforeAny" || text === "afterAny") {
        throw parseError(
          `mustCall ${node.methodName} ${text} not yet supported in phase 6.1; use 'beforeScopeEnd'`,
          peek().start,
          peek().length,
        );
      }
      throw parseError(
        `expected 'beforeScopeEnd' after mustCall method name, got '${text}'`,
        peek().start,
        peek().length,
      );
    } else {
      throw parseError(
        `expected 'beforeScopeEnd' after mustCall method name, got ${inverseTokenTags[peek().tag]}`,
        peek().start,
        peek().length,
      );
    }
    expect(TokenTags.semicolon);
    return node;
  }

  function parseOwnsBlockClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_OWNSBLOCK_CLAUSE);
    expect(TokenTags.ownsBlock);
    // Reject the old paren-style `ownsBlock();`.
    if (peek().tag === TokenTags.lparen) {
      throw parseError(
        "ownsBlock takes no arguments; drop the parentheses",
        peek().start,
        peek().length,
      );
    }
    expect(TokenTags.semicolon);
    return node;
  }

  function parseImportDecl() {
    const node = buildSourcedNode(ASTNodeKind.IMPORT_DECL);
    expect(TokenTags.import);

    // side-effect: import "./init.yoop";
    if (peek().tag === TokenTags.strLiteral) {
      node.importKind = "side-effect";
      node.sourcePath = unquoteStringLiteral(advance());
      expect(TokenTags.semicolon);
      return node;
    }

    // namespace: import * as ns from "./mod.yoop";
    if (peek().tag === TokenTags.mult) {
      node.importKind = "namespace";
      advance(); // consume *
      expect(TokenTags.as);
      node.namespaceName = parseIdentAsName();
      expect(TokenTags.from);
      node.sourcePath = unquoteStringLiteral(expect(TokenTags.strLiteral));
      expect(TokenTags.semicolon);
      return node;
    }

    // named: import { a, b as c } from "./mod.yoop";
    if (peek().tag === TokenTags.lcurly) {
      node.importKind = "named";
      node.specifiers = [];
      advance(); // consume {
      while (peek().tag === TokenTags.ident) {
        const exportTok = expect(TokenTags.ident);
        const exportName = src.substring(
          exportTok.start,
          exportTok.start + exportTok.length,
        );
        let localName = exportName;
        if (peek().tag === TokenTags.as) {
          advance();
          localName = parseIdentAsName();
        }
        node.specifiers.push({
          exportName,
          localName,
          sourceLoc: posToSourceLocation(src, exportTok.start),
        });
        if (peek().tag === TokenTags.comma) advance();
      }
      expect(TokenTags.rcurly);
      expect(TokenTags.from);
      node.sourcePath = unquoteStringLiteral(expect(TokenTags.strLiteral));
      expect(TokenTags.semicolon);
      return node;
    }

    throw parseError(
      `unexpected token after import: ${inverseTokenTags[peek().tag]}`,
      peek().start,
      peek().length,
    );
  }

  function parseExportDecl() {
    expect(TokenTags.export);

    // export "C" function ...
    if (peek().tag === TokenTags.strLiteral) {
      const abiTok = advance();
      const abi = unquoteStringLiteral(abiTok);
      if (abi !== "C") {
        throw parseError(
          `unsupported export ABI "${abi}" — only "C" is supported`,
          abiTok.start,
          abiTok.length,
        );
      }
      expect(TokenTags.function);
      const fn = parseFunctionDeclBody();
      const node = buildSourcedNode(ASTNodeKind.EXPORT_C_FUNCTION_DECL);
      node.fn = fn;
      return node;
    }

    // wrapping form: export function / type / let / const
    const node = buildSourcedNode(ASTNodeKind.EXPORT_DECL);
    switch (peek().tag) {
      case TokenTags.function:
        node.decl = parseFunctionDecl();
        break;
      case TokenTags.type:
        node.decl = parseTypeDecl();
        break;
      case TokenTags.let:
      case TokenTags.const:
        node.decl = parseVarDecl();
        break;
      case TokenTags.trait:
        node.decl = parseTraitDecl();
        break;
      case TokenTags.kind:
        node.decl = parseKindDecl();
        break;
      default:
        throw parseError(
          `unexpected token after export: ${inverseTokenTags[peek().tag]}`,
          peek().start,
          peek().length,
        );
    }
    return node;
  }

  function parseTraitDecl() {
    const node = buildSourcedNode(ASTNodeKind.TRAIT_DECL);
    expect(TokenTags.trait);

    node.name = parseIdentAsName();

    // Phase 7.1: optional type parameter list — `trait Iter<T> { ... }`.
    node.typeParams = parseTypeParamList();

    if (peek().tag === TokenTags.extends) {
      throw parseError(
        `extends not yet supported`,
        peek().start,
        peek().length,
      );
    }

    expect(TokenTags.lcurly);
    node.methods = [];
    while (peek().tag === TokenTags.function) {
      node.methods.push(parseMethodSig());
    }

    expect(TokenTags.rcurly);
    return node;
  }

  function parseMethodSig() {
    const node = buildSourcedNode(ASTNodeKind.METHOD_SIG);
    expect(TokenTags.function);
    node.name = parseIdentAsName();
    expect(TokenTags.lparen);
    // must be ref self as first param
    if (peek().tag !== TokenTags.ref) {
      throw parseError(
        `trait method "${node.name}" must take 'ref self' as its first parameter`,
        peek().start,
        peek().length,
      );
    }
    expect(TokenTags.ref);
    expect(TokenTags.self);

    const selfParam = buildSourcedNode(ASTNodeKind.PARAM);
    selfParam.isRef = true;
    selfParam.name = "self";
    selfParam.typeAnnotation = { kind: "selfType" };
    node.params = [selfParam];

    while (peek().tag === TokenTags.comma) {
      advance();
      node.params.push(parseFunctionParam());
    }
    expect(TokenTags.rparen);
    expect(TokenTags.colon);
    node.returnTypeAnnotation = parseTypeAnnotation();
    expect(TokenTags.semicolon); // sigs end with ; not a body

    return node;
  }

  function parseExternBlock() {
    const node = buildSourcedNode(ASTNodeKind.EXTERN_BLOCK);
    expect(TokenTags.extern);
    const abiTok = expect(TokenTags.strLiteral);
    node.abi = unquoteStringLiteral(abiTok);
    if (node.abi !== "C") {
      throw parseError(
        `unsupported extern ABI "${node.abi}" — only "C" is supported in v0`,
        abiTok.start,
        abiTok.length,
      );
    }
    expect(TokenTags.from);
    if (peek().tag === TokenTags.library) {
      advance();
      node.source = {
        kind: "library",
        value: unquoteStringLiteral(expect(TokenTags.strLiteral)),
      };
    } else {
      node.source = {
        kind: "header",
        value: unquoteStringLiteral(expect(TokenTags.strLiteral)),
      };
    }
    expect(TokenTags.lcurly);
    node.decls = [];
    while (peek().tag !== TokenTags.rcurly && peek().tag !== TokenTags.eof) {
      if (peek().tag === TokenTags.function)
        node.decls.push(parseExternFunctionDecl());
      else if (peek().tag === TokenTags.type)
        node.decls.push(parseExternTypeDecl());
      else
        throw parseError(
          `unexpected token in extern block: ${inverseTokenTags[peek().tag]}`,
          peek().start,
          peek().length,
        );
    }
    expect(TokenTags.rcurly);
    return node;
  }

  function parseExternFunctionDecl() {
    expect(TokenTags.function);
    const node = buildSourcedNode(ASTNodeKind.EXTERN_FUNCTION_DECL);
    node.name = parseIdentAsName();
    expect(TokenTags.lparen);
    node.params = [];
    node.variadic = false;
    while (peek().tag !== TokenTags.rparen && peek().tag !== TokenTags.eof) {
      if (peek().tag === TokenTags.dotdotdot) {
        advance();
        node.variadic = true;
        break; // ... must be last before )
      }
      node.params.push(parseFunctionParam());
      if (peek().tag === TokenTags.comma) advance();
    }
    expect(TokenTags.rparen);
    expect(TokenTags.colon);
    node.returnTypeAnnotation = parseTypeAnnotation();
    expect(TokenTags.semicolon);
    return node;
  }

  function parseExternTypeDecl() {
    expect(TokenTags.type);
    const node = buildSourcedNode(ASTNodeKind.EXTERN_TYPE_DECL);
    node.name = parseIdentAsName();
    expect(TokenTags.semicolon);
    return node;
  }

  // precedence stuff read from: https://matklad.github.io/2020/04/13/simple-but-powerful-pratt-parsing.html

  function parseExpression(minPrecedence = 0) {
    let node;
    // unary first
    if (peek().tag === TokenTags.minus) {
      advance(); // consume the dash
      const operand = parseExpression(70);
      if (
        operand.kind === ASTNodeKind.INT_LITERAL ||
        operand.kind === ASTNodeKind.FLOAT_LITERAL
      ) {
        operand.value = -operand.value;
        return operand;
      }

      // non-literal operands, build unary expression node
      node = buildSourcedNode(ASTNodeKind.UNARY_EXPRESSION);
      node.op = "minus";
      node.operand = operand;

      return node;
    }

    // ref x — parse lvalue address operand with high precedence so postfixes bind tightly
    if (peek().tag === TokenTags.ref) {
      advance();
      const refNode = buildSourcedNode(ASTNodeKind.REF_EXPRESSION);
      refNode.operand = parseExpression(70);
      return refNode;
    }

    // wait x — task handle await; same tight precedence as ref
    if (peek().tag === TokenTags.wait) {
      advance();
      const waitNode = buildSourcedNode(ASTNodeKind.WAIT_EXPRESSION);
      waitNode.operand = parseExpression(70);
      return waitNode;
    }

    if (peek().tag === TokenTags.intLiteral) {
      node = buildSourcedNode(ASTNodeKind.INT_LITERAL);
      node.value = advance().intVal;
    } else if (
      peek().tag === TokenTags.true ||
      peek().tag === TokenTags.false
    ) {
      const tok = advance();
      node = buildSourcedNode(ASTNodeKind.BOOL_LITERAL);
      node.value = tok.tag === TokenTags.true;
    } else if (peek().tag === TokenTags.floatLiteral) {
      node = buildSourcedNode(ASTNodeKind.FLOAT_LITERAL);
      node.value = advance().floatVal;
    } else if (peek().tag === TokenTags.strLiteral) {
      const tok = advance();
      node = buildSourcedNode(ASTNodeKind.STRING_LITERAL);
      node.value = src.substring(tok.start, tok.start + tok.length);
    } else if (peek().tag === TokenTags.templateLiteral) {
      const tok = advance();
      const raw = src.substring(tok.start, tok.start + tok.length);
      node = parseTemplateLiteralBody(raw);
    } else if (peek().tag === TokenTags.lbracket) {
      // array literal: [e1, e2, e3]
      advance(); // consume [
      node = buildSourcedNode(ASTNodeKind.ARRAY_LITERAL);
      node.elements = [];
      while (
        peek().tag !== TokenTags.rbracket &&
        peek().tag !== TokenTags.eof
      ) {
        node.elements.push(parseExpression());
        if (peek().tag === TokenTags.comma) advance();
      }
      expect(TokenTags.rbracket);
    } else if (peek().tag === TokenTags.ident) {
      const name = parseIdentAsName();
      if (peek().tag === TokenTags.lparen) {
        // this is a function call
        node = buildSourcedNode(ASTNodeKind.CALL_EXPRESSION);
        node.callee = name;
        parseCallArgs(node);
      } else {
        node = buildSourcedNode(ASTNodeKind.IDENT);
        node.name = name;
      }
    } else if (peek().tag === TokenTags.lcurly) {
      advance(); // consume lcurly
      node = buildSourcedNode(ASTNodeKind.STRUCT_LITERAL);
      node.fields = [];
      while (peek().tag !== TokenTags.rcurly && peek().tag !== TokenTags.eof) {
        const fieldNode = buildSourcedNode(ASTNodeKind.STRUCT_LITERAL_FIELD);
        fieldNode.name = parseIdentAsName();
        expect(TokenTags.colon);
        fieldNode.value = parseExpression();
        node.fields.push(fieldNode);
        if (peek().tag === TokenTags.comma) {
          advance();
        } // allow trailing comma
      }
      expect(TokenTags.rcurly);
    } else if (peek().tag === TokenTags.self) {
      advance();
      node = buildSourcedNode(ASTNodeKind.IDENT);
      node.name = "self";
    } else {
      throw parseError(
        `unexpected token in expression: ${inverseTokenTags[peek().tag]}`,
        peek().start,
        peek().length,
      );
    }
    // handle postfix ops: field access, ?, call-on-field, array index
    while (true) {
      if (peek().tag === TokenTags.dot) {
        advance(); // consume dot
        const fieldName = parseIdentAsName();
        const fieldAccessNode = buildSourcedNode(ASTNodeKind.FIELD_ACCESS);
        fieldAccessNode.object = node;
        fieldAccessNode.field = fieldName;
        node = fieldAccessNode;
        continue;
      }
      // handle postfix '?' for error handle for errors as values feature
      if (peek().tag === TokenTags.question) {
        advance(); // consume '?'
        const tryOpNode = buildSourcedNode(ASTNodeKind.TRY_OP);
        tryOpNode.operand = node;
        node = tryOpNode;
        continue;
      }
      // handle postfix call on a field access: ns.method(args)
      if (
        peek().tag === TokenTags.lparen &&
        node.kind === ASTNodeKind.FIELD_ACCESS
      ) {
        const callNode = buildSourcedNode(ASTNodeKind.CALL_EXPRESSION);
        callNode.callee = node; // callee is a FIELD_ACCESS node, not a string
        parseCallArgs(callNode);
        node = callNode;
        continue;
      }
      // array indexing: xs[i]
      if (peek().tag === TokenTags.lbracket) {
        advance(); // consume [
        const indexNode = buildSourcedNode(ASTNodeKind.INDEX_EXPRESSION);
        indexNode.object = node;
        indexNode.index = parseExpression();
        expect(TokenTags.rbracket);
        node = indexNode;
        continue;
      }
      break;
    }

    // assignment — lvalue is whatever the primary+postfix chain produced.
    // valid targets: IDENT, FIELD_ACCESS, INDEX_EXPRESSION
    if (peek().tag === TokenTags.eq) {
      if (
        node.kind !== ASTNodeKind.IDENT &&
        node.kind !== ASTNodeKind.FIELD_ACCESS &&
        node.kind !== ASTNodeKind.INDEX_EXPRESSION
      ) {
        throw parseError(
          `invalid assignment target: ${node.kind}`,
          peek().start,
          peek().length,
        );
      }
      advance(); // consume '='
      const assignNode = buildSourcedNode(ASTNodeKind.ASSIGNMENT);
      assignNode.target = node;
      assignNode.value = parseExpression();
      return assignNode;
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

      const binNode = buildSourcedNode(ASTNodeKind.BINARY_EXPRESSION);
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
          throw parseError(`unterminated \${...} in template literal`);
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
    const node = buildSourcedNode(ASTNodeKind.TEMPLATE_LITERAL);
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

  function parseDiscardStatement() {
    expect(TokenTags.discard);
    expect(TokenTags.eq);
    const node = buildSourcedNode(ASTNodeKind.DISCARD_STATEMENT);
    node.value = parseExpression();
    expect(TokenTags.semicolon);
    return node;
  }

  function parseStatement() {
    // only statements
    const peekTag = peek().tag;
    switch (peekTag) {
      case TokenTags.discard: {
        return parseDiscardStatement();
      }
      case TokenTags.return: {
        return parseReturnStatement();
      }
      case TokenTags.let:
      case TokenTags.const: {
        return parseVarDecl();
      }
      case TokenTags.joined:
      case TokenTags.pooled: {
        return parseTaskBinding();
      }
      case TokenTags.if: {
        return parseIfStatement();
      }
      case TokenTags.while: {
        return parseWhileStatement();
      }
      case TokenTags.for: {
        return parseForStatement();
      }
      case TokenTags.break: {
        return parseBreakStatement();
      }
      case TokenTags.continue: {
        return parseContinueStatement();
      }
      case TokenTags.ident: {
        // kind-prefixed binding form: `IDENT IDENT : ...` or
        // `IDENT(args) IDENT : ...` (phase 6.5).
        if (looksLikeKindPrefixedBindingStart()) {
          return parseVarDecl();
        }
        return parseExpressionStatement();
      }
      default: {
        return parseExpressionStatement();
      }
    }
  }

  function parseReturnStatement() {
    expect(TokenTags.return);
    const node = buildSourcedNode(ASTNodeKind.RETURN_STATEMENT);
    node.value = peek().tag === TokenTags.semicolon ? null : parseExpression();
    expect(TokenTags.semicolon);
    return node;
  }

  // verifies code like `let {x, y} = someExpr;`
  // no renaming or nested destructuring for now, no types declared
  function parseDestructureDecl(varToken, declKind) {
    const node = buildSourcedNode(ASTNodeKind.DESTRUCTURE_DECL);
    node.declKind = declKind;
    node.names = [];
    expect(TokenTags.lcurly);
    while (peek().tag === TokenTags.ident) {
      node.names.push(parseIdentAsName());
      if (peek().tag === TokenTags.comma) {
        advance();
      }
    }
    expect(TokenTags.rcurly);
    expect(TokenTags.eq);
    node.assignment = parseExpression();
    expect(TokenTags.semicolon);
    return node;
  }

  function parseVarDecl() {
    // Three accepted shapes here:
    //   (1) let|const IDENT : type (= expr)? ;
    //   (2) let|const IDENT IDENT : type = expr {block} | ;     (kind-prefixed)
    //   (3) IDENT IDENT : type = expr {block} | ;               (implicit-const kind-prefixed)
    // Shape (3) is dispatched in parseStatement; (1) and (2) start with let/const.
    let declToken = null; // let | const, or null for implicit-const
    if (peek().tag === TokenTags.let || peek().tag === TokenTags.const) {
      declToken = advance();
    }

    // destructure: `let { a, b } = expr;` — only valid for non-kind-prefixed form
    if (declToken !== null && peek().tag === TokenTags.lcurly) {
      const declKind =
        declToken.tag === TokenTags.let
          ? ASTNodeKind.LET_DECL
          : ASTNodeKind.CONST_DECL;
      return parseDestructureDecl(declToken, declKind);
    }

    // Decide whether a kind prefix is present. Either:
    //   - declToken was null (shape 3): caller already verified IDENT (args)? IDENT :
    //   - declToken was present and we see IDENT (args)? IDENT :
    let kindPrefix = null;
    if (looksLikeKindPrefixedBindingStart()) {
      kindPrefix = consumeKindPrefixWithArgs();
    }

    // Build the binding node. Kind-prefixed bindings without a `let` keyword
    // are implicitly const per SPEC §4.4.
    let nodeKind;
    if (declToken === null) {
      nodeKind = ASTNodeKind.CONST_DECL;
    } else if (declToken.tag === TokenTags.let) {
      nodeKind = ASTNodeKind.LET_DECL;
    } else {
      nodeKind = ASTNodeKind.CONST_DECL;
    }
    const node = buildSourcedNode(nodeKind);
    node.kindPrefix = kindPrefix;
    node.trailingBlock = null;

    node.name = parseIdentAsName();
    expect(TokenTags.colon);
    node.typeAnnotation = parseTypeAnnotation();

    // Kind-prefixed bindings always require an initializer; the `mustCall`
    // obligation has nothing to bind against without one.
    if (kindPrefix !== null) {
      if (peek().tag !== TokenTags.eq) {
        throw parseError(
          "kind-prefixed binding requires initializer",
          peek().start,
          peek().length,
        );
      }
      advance(); // consume =
      node.assignment = parseExpression();
      if (peek().tag === TokenTags.lcurly) {
        node.trailingBlock = parseBlock();
      } else {
        expect(TokenTags.semicolon);
      }
      return node;
    }

    // Plain let/const path — semicolon-only is legal (no initializer).
    if (peek().tag === TokenTags.semicolon) {
      advance();
      return node;
    }
    expect(TokenTags.eq);
    node.assignment = parseExpression();
    expect(TokenTags.semicolon);
    return node;
  }

  // Phase 6.3: `joined h = expr;` / `pooled h = expr;` — task-builtin binding
  // prefixes that infer their type from the task call on the RHS. No type
  // annotation is permitted (Task<T> is compiler-internal).
  function parseTaskBinding() {
    const prefixTok = advance(); // joined | pooled
    const builtinName =
      prefixTok.tag === TokenTags.joined ? "joined" : "pooled";

    const node = buildSourcedNode(ASTNodeKind.CONST_DECL);
    node.kindPrefix = {
      name: builtinName,
      builtin: builtinName,
      sourceLoc: posToSourceLocation(src, prefixTok.start),
    };
    node.trailingBlock = null;
    node.name = parseIdentAsName();

    if (peek().tag === TokenTags.colon) {
      throw parseError(
        `${builtinName} bindings infer their type from the task call; remove the type annotation`,
        peek().start,
        peek().length,
      );
    }
    node.typeAnnotation = null;

    if (peek().tag !== TokenTags.eq) {
      throw parseError(
        `${builtinName} binding requires initializer`,
        peek().start,
        peek().length,
      );
    }
    advance(); // =
    node.assignment = parseExpression();
    expect(TokenTags.semicolon);
    return node;
  }

  function parseIfStatement() {
    expect(TokenTags.if);
    expect(TokenTags.lparen);
    const node = buildSourcedNode(ASTNodeKind.IF_STATEMENT);
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
    const node = buildSourcedNode(ASTNodeKind.WHILE_STATEMENT);
    node.expression = parseExpression();
    expect(TokenTags.rparen);
    node.body = parseBlock();

    return node;
  }

  function parseForStatement() {
    expect(TokenTags.for);
    expect(TokenTags.lparen);
    const node = buildSourcedNode(ASTNodeKind.FOR_LOOP);

    // init: ident = expr ;
    node.initIdent = parseIdentAsName();
    expect(TokenTags.eq);
    node.initExpr = parseExpression();
    expect(TokenTags.semicolon);

    // cond: expr ;
    node.cond = parseExpression();
    expect(TokenTags.semicolon);

    // step: ident = expr
    node.stepIdent = parseIdentAsName();
    expect(TokenTags.eq);
    node.stepExpr = parseExpression();

    expect(TokenTags.rparen);
    node.body = parseBlock();
    return node;
  }

  function parseBreakStatement() {
    expect(TokenTags.break);
    expect(TokenTags.semicolon);
    return buildSourcedNode(ASTNodeKind.BREAK_STATEMENT);
  }

  function parseContinueStatement() {
    expect(TokenTags.continue);
    expect(TokenTags.semicolon);
    return buildSourcedNode(ASTNodeKind.CONTINUE_STATEMENT);
  }

  function parseExpressionStatement() {
    const node = buildSourcedNode(ASTNodeKind.EXPRESSION_STATEMENT);
    node.value = parseExpression();
    expect(TokenTags.semicolon);

    return node;
  }

  // expects an identifier, args, curlys, statements...
  function parseFunctionDecl() {
    let isTask = false;
    // Two accepted shapes:
    //   function foo(...) {...}
    //   task foo(...) {...}          (task replaces `function`)
    // The `task function foo(...)` shape is rejected — it's redundant.
    if (peek().tag === TokenTags.task) {
      advance();
      isTask = true;
      if (peek().tag === TokenTags.function) {
        throw parseError(
          "`task function` is redundant — use `task <name>(...)`",
          peek().start,
          peek().length,
        );
      }
    } else {
      expect(TokenTags.function);
    }
    const node = parseFunctionDeclBody();
    node.isTask = isTask;
    return node;
  }

  function parseFunctionDeclBody() {
    const node = buildSourcedNode(ASTNodeKind.FUNCTION_DECL);
    node.isTask = false;
    node.name = parseIdentAsName();
    // Phase 7.1: optional type parameter list — `function map<T, U>(...)`.
    node.typeParams = parseTypeParamList();
    expect(TokenTags.lparen);
    node.params = [];
    // params can start with: ident (name/kind-prefix), ref (modifier), comma
    // (separator), or a kind keyword (phase 6.4: `pooled` is a kind prefix).
    while (
      peek().tag === TokenTags.ident ||
      peek().tag === TokenTags.ref ||
      peek().tag === TokenTags.comma ||
      peek().tag === TokenTags.pooled
    ) {
      if (peek().tag === TokenTags.comma) advance();
      if (peek().tag !== TokenTags.rparen && peek().tag !== TokenTags.eof) {
        node.params.push(parseFunctionParam());
      }
    }
    expect(TokenTags.rparen);
    expect(TokenTags.colon);
    node.returnTypeAnnotation = parseTypeAnnotation();
    // Phase 6.4: optional `propagates<...>` clause on return type.
    parsePropagationClauses(node);
    node.body = parseBlock();
    return node;
  }

  // Phase 7.1: parse a single trait reference inside an `implements ...` clause.
  // Accepts either `TraitName` or `TraitName<T1, T2, ...>`.
  function parseImplementsClauseRef() {
    const nameTok = expect(TokenTags.ident);
    const name = src.substring(nameTok.start, nameTok.start + nameTok.length);
    const sourceLoc = posToSourceLocation(src, nameTok.start);
    let typeArgs = null;
    if (peek().tag === TokenTags.lt) {
      advance();
      typeArgs = [];
      if (atClosingGt()) {
        throw parseError(
          `empty type argument list <> in implements clause`,
          peek().start,
          peek().length,
        );
      }
      while (true) {
        typeArgs.push(parseTypeAnnotation());
        if (peek().tag === TokenTags.comma) {
          advance();
          if (atClosingGt()) break;
          continue;
        }
        break;
      }
      consumeClosingGt();
    }
    return { name, typeArgs, sourceLoc };
  }

  function parseTypeDecl() {
    expect(TokenTags.type);
    const node = buildSourcedNode(ASTNodeKind.TYPE_DECL);
    // name
    node.name = parseIdentAsName();
    // Phase 7.1: optional type parameter list — `type Box<T> { ... }`.
    node.typeParams = parseTypeParamList();

    // Phase 6.5: optional single kind prefix on the type declaration,
    // e.g. `type Vec4 aligned(32) implements Disposable { ... }`.
    // Detected when the next token is an IDENT that is NOT `implements` and
    // is not the start of a propagates/contains clause — i.e. an IDENT
    // followed by (args)? then one of: `implements`, `propagates`, `contains`,
    // `{`, `=` (alias), or `;`.
    node.kindPrefix = null;
    if (peek().tag === TokenTags.ident) {
      let afterIdx = 1;
      if (peekAhead(1).tag === TokenTags.lparen) {
        const j = findMatchingRparen(1);
        if (j > 0) afterIdx = j + 1;
        else afterIdx = -1;
      }
      if (afterIdx > 0) {
        const after = peekAhead(afterIdx);
        if (
          after.tag === TokenTags.implements ||
          after.tag === TokenTags.propagates ||
          after.tag === TokenTags.contains ||
          after.tag === TokenTags.lcurly
        ) {
          node.kindPrefix = consumeKindPrefixWithArgs();
        }
      }
    }

    // Phase 7.1: implements clause now accepts generic trait applications, e.g.
    // `implements Container<int32>`. Each entry is a record { name, typeArgs }
    // where typeArgs is null for non-generic trait references (backward-compatible).
    node.implements = [];
    if (peek().tag === TokenTags.implements) {
      advance();
      if (peek().tag === TokenTags.lparen) {
        advance();
        while (peek().tag === TokenTags.ident) {
          node.implements.push(parseImplementsClauseRef());
          if (peek().tag === TokenTags.comma) {
            advance();
          }
        }
        expect(TokenTags.rparen);
      } else {
        node.implements.push(parseImplementsClauseRef());
      }
    }

    // Phase 6.4: optional `propagates<...>` / `contains<...>` clauses.
    parsePropagationClauses(node);

    if (peek().tag === TokenTags.lcurly) {
      // struct type
      node.fields = [];
      node.methods = [];
      expect(TokenTags.lcurly);
      while (
        peek().tag === TokenTags.ident ||
        peek().tag === TokenTags.function
      ) {
        if (peek().tag === TokenTags.function) {
          node.methods.push(parseMethodDecl());
        } else {
          const fieldNode = buildSourcedNode(ASTNodeKind.FIELD_DECL);
          fieldNode.name = parseIdentAsName();
          expect(TokenTags.colon);
          // Detect kind-prefix on field type: `IDENT IDENT` after colon.
          // Parse it fully so the typechecker can emit a clear error message.
          fieldNode.kindPrefix = null;
          if (peek().tag === TokenTags.ident && peekAhead(1).tag === TokenTags.ident) {
            const kindTok = advance();
            fieldNode.kindPrefix = {
              name: src.substring(kindTok.start, kindTok.start + kindTok.length),
              sourceLoc: posToSourceLocation(src, kindTok.start),
            };
          }
          fieldNode.typeAnnotation = parseTypeAnnotation();
          node.fields.push(fieldNode);
          if (peek().tag === TokenTags.comma) {
            advance();
          } // allow trailing comma
        }
      }
      expect(TokenTags.rcurly);
    } else {
      // type alias, just a reference to another type for now
      node.targetType = parseIdentAsName();
    }

    // constraint: methods only allowed when implements is non-empty
    if (node.methods?.length > 0 && node.implements.length === 0) {
      throw parseError(
        `methods are only allowed inside an 'implements' block - type "${node.name}" has methods but no 'implements' clause`,
        peek().start,
        peek().length,
      );
    }

    return node;
  }

  function parseMethodDecl() {
    const node = buildSourcedNode(ASTNodeKind.METHOD_DECL);
    expect(TokenTags.function);
    node.name = parseIdentAsName();
    expect(TokenTags.lparen);
    // must be ref self as first param
    expect(TokenTags.ref);
    expect(TokenTags.self);
    
    const selfParam = buildSourcedNode(ASTNodeKind.PARAM);
    selfParam.isRef = true;
    selfParam.name = "self";
    selfParam.typeAnnotation = { kind: "selfType" };
    node.params = [selfParam];

    while (peek().tag === TokenTags.comma) {
      advance();
      node.params.push(parseFunctionParam());
    }
    expect(TokenTags.rparen);
    expect(TokenTags.colon);
    node.returnTypeAnnotation = parseTypeAnnotation();
    node.body = parseBlock();

    return node;
  }

  function parseFunctionParam() {
    const node = buildSourcedNode(ASTNodeKind.PARAM);
    node.kindPrefix = null;

    // Phase 6.4: `pooled` is a reserved kind keyword; it lexes as a non-ident
    // token but is a valid param prefix (`pooled h: Task<int32>`). Built-in
    // kind keywords are handled via the same kindPrefix shape as user kinds.
    if (peek().tag === TokenTags.pooled) {
      const kindTok = advance();
      node.kindPrefix = {
        name: "pooled",
        builtin: "pooled",
        sourceLoc: posToSourceLocation(src, kindTok.start),
      };
    }

    // Detect kind prefix: IDENT followed by (IDENT or ref) means kind-prefixed param.
    // Also supports `IDENT(args) IDENT|ref` (phase 6.5 parameterized kinds).
    // Examples: `scoped h: ref FileHandle`, `scoped ref h: FileHandle`,
    //           `aligned(32) v: Vec4`.
    if (!node.kindPrefix && peek().tag === TokenTags.ident) {
      const next1 = peekAhead(1);
      let looksLikeKindPrefix = false;
      if (next1.tag === TokenTags.ident || next1.tag === TokenTags.ref) {
        looksLikeKindPrefix = true;
      } else if (next1.tag === TokenTags.lparen) {
        const j = findMatchingRparen(1);
        if (j >= 0) {
          const after = peekAhead(j + 1);
          if (after.tag === TokenTags.ident || after.tag === TokenTags.ref) {
            looksLikeKindPrefix = true;
          }
        }
      }
      if (looksLikeKindPrefix) {
        node.kindPrefix = consumeKindPrefixWithArgs();
        // Reject a second kind prefix.
        if (peek().tag === TokenTags.ident) {
          const next2 = peekAhead(1);
          if (next2.tag === TokenTags.ident) {
            throw parseError(
              "a parameter may carry at most one kind prefix in phase 6.5",
              peek().start,
              peek().length,
            );
          }
        }
      }
    }

    // ref modifier
    if (peek().tag === TokenTags.ref) {
      advance();
      node.isRef = true;
    } else {
      node.isRef = false;
    }
    // name
    node.name = parseIdentAsName();
    // type
    expect(TokenTags.colon);
    node.typeAnnotation = parseTypeAnnotation();
    // Canonicalize `name: ref T` to `ref name: T` so downstream sees a single
    // form for ref params (common in extern blocks where `ref` reads more
    // naturally next to the type than next to the name).
    if (!node.isRef && node.typeAnnotation?.kind === "refType") {
      node.isRef = true;
      node.typeAnnotation = node.typeAnnotation.inner;
    }
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
    const node = buildSourcedNode(ASTNodeKind.BLOCK);
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
