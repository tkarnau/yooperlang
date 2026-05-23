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
  // Phase 9: bitwise XOR sits between OR and AND (C-style precedence).
  [TokenTags.caret]: 36,
  // Phase 9: bitwise AND. `&` is also the prefix address-of and the
  // kind-composition operator; both of those are parsed in non-binary
  // positions so the precedence entry doesn't conflict.
  [TokenTags.amp]: 37,
  [TokenTags.eqeq]: 40,
  [TokenTags.neq]: 40,
  [TokenTags.lt]: 40,
  [TokenTags.gt]: 40,
  [TokenTags.lte]: 40,
  [TokenTags.gte]: 40,
  // Phase 9: shifts bind tighter than comparisons, looser than additive.
  [TokenTags.lshift]: 45,
  [TokenTags.rshift]: 45,
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
    const err = new Error(
      `${message}\n` +
        `  --> line ${line}:${column}\n` +
        `   | ${lineText}\n` +
        `   | ${caret}`,
    );
    // Structured fields so consumers (LSP, tooling) can map the error to a
    // source range without re-parsing the formatted text.
    err.isParseError = true;
    err.rawMessage = message;
    err.pos = pos;
    err.length = length;
    err.line = line;
    err.column = column;
    return err;
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
  //   { kind: "functionType", params: [<annot>...], returnType: <annot> }
  function parseTypeAnnotation() {
    // Phase 9.G: function value type `(p1: T1, p2: T2, ...) => RetT`. The
    // disambiguator from a non-existent "parenthesized type" is that
    // function-type annotations always start with `(` and contain either
    // `)` (no params) or `IDENT :` (named param) right after it. The
    // unnamed-param form `(T) => R` would be ambiguous with `(IDENT)` —
    // we require named params for clarity and to match the function-decl
    // surface.
    if (peek().tag === TokenTags.lparen) {
      return parseFunctionTypeAnnotation();
    }
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

  // Phase 9.G: parse `(p1: T1, p2: T2, ...) => RetT` as a function value
  // type annotation. The leading `(` has already been peeked. Params are
  // required to be named for parity with the function-decl surface; the
  // names themselves are discarded after parse (the param list at the
  // type level is purely positional). An empty list `() => Ret` is legal.
  function parseFunctionTypeAnnotation() {
    expect(TokenTags.lparen);
    const params = [];
    if (peek().tag !== TokenTags.rparen) {
      while (true) {
        expect(TokenTags.ident); // param name (discarded)
        expect(TokenTags.colon);
        params.push(parseTypeAnnotation());
        if (peek().tag === TokenTags.comma) {
          advance();
          continue;
        }
        break;
      }
    }
    expect(TokenTags.rparen);
    expect(TokenTags.fatArrow);
    const returnType = parseTypeAnnotation();
    return { kind: "functionType", params, returnType };
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
      // Phase 8.A: `import.unsafe;` enables `unsafe_ptr<T>` and friends.
      // Defaults to false; set true if the module opts in at top.
      node.allowsUnsafe = false;
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
          case TokenTags.enum:
            {
              seenNonImport = true;
              node.body.push(parseEnumDecl());
            }
            break;
          case TokenTags.union:
            {
              seenNonImport = true;
              node.body.push(parseUnionDecl());
            }
            break;
          case TokenTags.import:
            {
              if (seenNonImport) {
                throw parseError("imports must come before other declarations");
              }
              // Phase 8.A: `import.unsafe;` — module-level opt-in for raw
              // pointers. Sets a flag on the PROGRAM node; doesn't push a
              // body entry (it's an attribute, not a declaration).
              if (peekAhead(1).tag === TokenTags.dot) {
                const importTok = peek();
                advance(); // import
                advance(); // .
                if (peek().tag !== TokenTags.ident) {
                  throw parseError(
                    `expected identifier after 'import.'`,
                    peek().start,
                    peek().length,
                  );
                }
                const featTok = peek();
                const featName = src.substring(
                  featTok.start,
                  featTok.start + featTok.length,
                );
                if (featName !== "unsafe") {
                  throw parseError(
                    `unknown import attribute 'import.${featName}' — only 'import.unsafe' is supported`,
                    featTok.start,
                    featTok.length,
                  );
                }
                advance(); // unsafe
                expect(TokenTags.semicolon);
                if (node.allowsUnsafe) {
                  throw parseError(
                    `duplicate 'import.unsafe;' declaration`,
                    importTok.start,
                    importTok.length,
                  );
                }
                node.allowsUnsafe = true;
                break;
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
          case TokenTags.vtable:
            {
              seenNonImport = true;
              node.body.push(parseVTableDecl());
            }
            break;
          case TokenTags.kind:
            {
              seenNonImport = true;
              node.body.push(parseKindDecl());
            }
            break;
          case TokenTags.let:
          case TokenTags.const:
            {
              // Phase 8.E: module-level mutable state. The full VarDecl
              // grammar inside parseVarDecl is fine to reuse; we add a
              // post-condition that forbids the constructs that don't
              // make sense at module top (kind prefix, no initializer,
              // destructuring, trailing block).
              seenNonImport = true;
              const decl = parseVarDecl();
              validateModuleLevelDecl(decl);
              decl.isModuleLevel = true;
              node.body.push(decl);
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
    // Phase 8.B: opt-in marker that this layout mirrors a C struct's ABI.
    // Currently contractual only — yoop's natural struct layout already
    // matches C for trivially-aligned structs.
    node.abiC = false;
    let sawAlign = false;
    let sawAbi = false;
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
      // Phase 8.B: `abi "C";` — match by ident name since `abi` isn't a
      // tokenized keyword. Reserved per SPEC §14 so user code shouldn't
      // shadow it accidentally.
      if (tok.tag === TokenTags.ident) {
        const name = src.substring(tok.start, tok.start + tok.length);
        if (name === "abi") {
          if (sawAbi) {
            throw parseError(
              "duplicate 'abi' sub-clause in layout body",
              tok.start,
              tok.length,
            );
          }
          sawAbi = true;
          advance(); // abi
          const valueTok = expect(TokenTags.strLiteral);
          const abiName = src.substring(
            valueTok.start + 1,
            valueTok.start + valueTok.length - 1,
          );
          if (abiName !== "C") {
            throw parseError(
              `abi "${abiName}" is not a supported ABI marker — only "C" is recognized`,
              valueTok.start,
              valueTok.length,
            );
          }
          node.abiC = true;
          expect(TokenTags.semicolon);
          continue;
        }
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
    if (!sawAlign && !sawAbi) {
      throw parseError(
        "layout body must contain at least one sub-clause ('align' or 'abi')",
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
        // Phase 8.E: `export let|const` — same restrictions as the bare
        // module-level form. Mark isModuleLevel so the typechecker can
        // route to the global-state pass.
        node.decl = parseVarDecl();
        validateModuleLevelDecl(node.decl);
        node.decl.isModuleLevel = true;
        break;
      case TokenTags.trait:
        node.decl = parseTraitDecl();
        break;
      case TokenTags.vtable:
        node.decl = parseVTableDecl();
        break;
      case TokenTags.kind:
        node.decl = parseKindDecl();
        break;
      case TokenTags.enum:
        node.decl = parseEnumDecl();
        break;
      case TokenTags.union:
        node.decl = parseUnionDecl();
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

  // Phase 9.G: `vtable Name for TraitName { method: (params) => ret, ... }`.
  // Each field's type annotation must be a function-pointer type (`=>`) whose
  // signature matches the corresponding trait method minus `ref self`. The
  // implicit `ctx: unsafe_ptr<void>` first slot is added by codegen — the user
  // never names it. Method order in the vtable struct follows the trait
  // declaration order, not the order fields appear in the body.
  function parseVTableDecl() {
    const node = buildSourcedNode(ASTNodeKind.VTABLE_DECL);
    expect(TokenTags.vtable);
    node.name = parseIdentAsName();
    expect(TokenTags.for);
    node.traitName = parseIdentAsName();
    expect(TokenTags.lcurly);
    node.fields = [];
    while (peek().tag !== TokenTags.rcurly && peek().tag !== TokenTags.eof) {
      const fieldNameTok = expect(TokenTags.ident);
      const fieldName = src.substring(
        fieldNameTok.start,
        fieldNameTok.start + fieldNameTok.length,
      );
      expect(TokenTags.colon);
      const annot = parseTypeAnnotation();
      if (annot.kind !== "functionType") {
        throw parseError(
          `vtable field "${fieldName}" must have a function-pointer type — write '${fieldName}: (params) => Ret'`,
          fieldNameTok.start,
          fieldNameTok.length,
        );
      }
      node.fields.push({
        name: fieldName,
        typeAnnotation: annot,
        sourceLoc: posToSourceLocation(src, fieldNameTok.start),
      });
      if (peek().tag === TokenTags.comma) {
        advance();
      } else {
        break;
      }
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

    // Phase 9.B: prefix `!x` — logical NOT. High precedence so postfixes
    // bind to the operand (e.g. `!flags[i]` parses as `!(flags[i])`).
    if (peek().tag === TokenTags.bang) {
      advance();
      const notNode = buildSourcedNode(ASTNodeKind.UNARY_EXPRESSION);
      notNode.op = "not";
      notNode.operand = parseExpression(70);
      return notNode;
    }

    // Phase 9: prefix `~x` — bitwise NOT. Same shape as `!`, restricted to
    // integer operands by the typechecker.
    if (peek().tag === TokenTags.tilde) {
      advance();
      const bitnotNode = buildSourcedNode(ASTNodeKind.UNARY_EXPRESSION);
      bitnotNode.op = "bitnot";
      bitnotNode.operand = parseExpression(70);
      return bitnotNode;
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

    // Phase 8.A: prefix `&x` — address-of an lvalue. Same tight precedence
    // as `ref` so postfixes bind to the operand. The `&` token also serves
    // as bitwise-AND in binary position; that's parsed by the precedence
    // climber and never reaches this primary path. We fall through to the
    // postfix + assignment check so address-of expressions still flow
    // through the usual end-of-primary path.
    if (peek().tag === TokenTags.amp) {
      advance();
      const addrNode = buildSourcedNode(ASTNodeKind.ADDRESS_OF_EXPRESSION);
      addrNode.operand = parseExpression(70);
      node = addrNode;
    } else if (peek().tag === TokenTags.mult) {
      // Phase 8.A: prefix `*p` — pointer dereference. Falls through so that
      // `*p = v` and `*p.field` work via the postfix + assignment path.
      advance();
      const derefNode = buildSourcedNode(ASTNodeKind.DEREF_EXPRESSION);
      derefNode.operand = parseExpression(70);
      node = derefNode;
    } else if (peek().tag === TokenTags.null) {
      // Phase 8.A: `null` literal. Type pinned by context.
      advance();
      node = buildSourcedNode(ASTNodeKind.NULL_LITERAL);
    } else

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
      node = parseTemplateLiteralBody(raw, tok.start);
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
      // Phase 8.A: `unsafe_ptr.cast<U>(p)` / `unsafe_ptr.toInt(p)` /
      // `unsafe_ptr.fromInt<T>(n)` — explicit type-arg intrinsics.
      // Recognized only by literal token shape so we don't have to weaken
      // the "no `<` in expression position" invariant elsewhere.
      // Phase 8.D: `errno.get()` / `errno.set(v)` / `errno.message(c)` —
      // thread-local errno bridge. Recognized as a literal token shape
      // for the same reason the `unsafe_ptr.*` namespace below is — to
      // avoid weakening the no-`<`-in-expression-position invariant.
      if (
        name === "errno" &&
        peek().tag === TokenTags.dot &&
        peekAhead(1).tag === TokenTags.ident
      ) {
        const opTok = peekAhead(1);
        const opName = src.substring(opTok.start, opTok.start + opTok.length);
        if (opName === "get" || opName === "set" || opName === "message") {
          advance(); // .
          advance(); // get/set/message
          const errNode = buildSourcedNode(ASTNodeKind.ERRNO_INTRINSIC);
          errNode.op = opName;
          errNode.operand = null;
          expect(TokenTags.lparen);
          if (opName === "set" || opName === "message") {
            errNode.operand = parseExpression();
          }
          expect(TokenTags.rparen);
          node = errNode;
        } else {
          throw parseError(
            `unknown errno intrinsic 'errno.${opName}' — expected get / set / message`,
            opTok.start,
            opTok.length,
          );
        }
      } else if (
        name === "unsafe_ptr" &&
        peek().tag === TokenTags.dot &&
        peekAhead(1).tag === TokenTags.ident
      ) {
        const opTok = peekAhead(1);
        const opName = src.substring(opTok.start, opTok.start + opTok.length);
        if (
          opName === "cast" ||
          opName === "toInt" ||
          opName === "fromInt" ||
          opName === "toArray"
        ) {
          advance(); // .
          advance(); // cast/toInt/fromInt/toArray
          const castNode = buildSourcedNode(ASTNodeKind.UNSAFE_PTR_CAST);
          castNode.castKind =
            opName === "cast"
              ? "bitcast"
              : opName === "toInt"
              ? "toInt"
              : opName === "fromInt"
              ? "fromInt"
              : "toArray";
          castNode.typeArg = null;
          if (opName === "cast" || opName === "fromInt" || opName === "toArray") {
            expect(TokenTags.lt);
            castNode.typeArg = parseTypeAnnotation();
            consumeClosingGt();
          }
          expect(TokenTags.lparen);
          castNode.operand = parseExpression();
          // Phase 8.C: toArray takes a second arg — the length.
          castNode.lengthOperand = null;
          if (opName === "toArray") {
            expect(TokenTags.comma);
            castNode.lengthOperand = parseExpression();
          }
          expect(TokenTags.rparen);
          node = castNode;
        } else {
          // fall through to regular IDENT, postfix loop handles `.`
          node = buildSourcedNode(ASTNodeKind.IDENT);
          node.name = name;
        }
      } else if (peek().tag === TokenTags.lparen) {
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
    } else if (peek().tag === TokenTags.lparen) {
      // Phase 9.A: parenthesized subexpression — `(a + b) * c`. Plain
      // grouping; no tuple syntax. Postfix chain (`.field`, `[i]`, `?`,
      // `(args)`) continues to apply to the inner expression.
      advance(); // consume (
      node = parseExpression();
      expect(TokenTags.rparen);
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
        // Capture the field name token before consuming it so we can pin
        // diagnostics (e.g. "no such variant") at the field identifier
        // rather than at the FIELD_ACCESS node's overall anchor.
        // Phase 9.G: allow `from` here in addition to an IDENT, so
        // `VTableName.from(ref x)` parses without making `from` non-reserved
        // at the lexer level (it's still a keyword in `import ... from ...`
        // and `extern "C" from ..."` contexts).
        const fieldTok = peek();
        let fieldName;
        if (fieldTok.tag === TokenTags.from) {
          advance();
          fieldName = "from";
        } else {
          fieldName = parseIdentAsName();
        }
        const fieldAccessNode = new ASTNode(
          ASTNodeKind.FIELD_ACCESS,
          posToSourceLocation(src, node.sourceLoc?.pos ?? fieldTok.start),
        );
        fieldAccessNode.object = node;
        fieldAccessNode.field = fieldName;
        fieldAccessNode.fieldSourceLoc = posToSourceLocation(
          src,
          fieldTok.start,
          fieldTok.length,
        );
        node = fieldAccessNode;
        continue;
      }
      // phase 7.5: variant constructor — EnumName.Variant { fields }
      // Only matches IDENT.IDENT followed by `{`. Bare `EnumName.Variant`
      // (no payload) stays a FIELD_ACCESS; the typechecker promotes it.
      if (
        peek().tag === TokenTags.lcurly &&
        node.kind === ASTNodeKind.FIELD_ACCESS &&
        node.object?.kind === ASTNodeKind.IDENT
      ) {
        const vc = buildSourcedNode(ASTNodeKind.VARIANT_CONSTRUCTOR);
        vc.enumName = node.object.name;
        vc.variantName = node.field;
        vc.fields = [];
        advance(); // consume {
        while (
          peek().tag !== TokenTags.rcurly &&
          peek().tag !== TokenTags.eof
        ) {
          const fieldNode = buildSourcedNode(ASTNodeKind.STRUCT_LITERAL_FIELD);
          fieldNode.name = parseIdentAsName();
          expect(TokenTags.colon);
          fieldNode.value = parseExpression();
          vc.fields.push(fieldNode);
          if (peek().tag === TokenTags.comma) advance();
        }
        expect(TokenTags.rcurly);
        node = vc;
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
      // Phase 9.E: array slice xs[i..j], xs[..j], xs[i..], xs[..]
      if (peek().tag === TokenTags.lbracket) {
        advance(); // consume [
        // Sniff the start: either expression or bare `..` for an open start.
        let startExpr = null;
        if (peek().tag !== TokenTags.dotdot) {
          startExpr = parseExpression();
        }
        if (peek().tag === TokenTags.dotdot) {
          advance(); // consume ..
          const sliceNode = buildSourcedNode(ASTNodeKind.SLICE_EXPRESSION);
          sliceNode.object = node;
          sliceNode.start = startExpr;
          sliceNode.end =
            peek().tag === TokenTags.rbracket ? null : parseExpression();
          expect(TokenTags.rbracket);
          node = sliceNode;
          continue;
        }
        // Plain index: startExpr is required.
        if (startExpr === null) {
          throw parseError(
            "expected index expression or slice form 'i..j'",
            peek().start,
            peek().length,
          );
        }
        const indexNode = buildSourcedNode(ASTNodeKind.INDEX_EXPRESSION);
        indexNode.object = node;
        indexNode.index = startExpr;
        expect(TokenTags.rbracket);
        node = indexNode;
        continue;
      }
      break;
    }

    // assignment — lvalue is whatever the primary+postfix chain produced.
    // valid targets: IDENT, FIELD_ACCESS, INDEX_EXPRESSION, DEREF_EXPRESSION
    // Phase 8.A: only consume assignment at top-level expression precedence.
    // When parseExpression is called recursively (e.g. as the operand of
    // a unary `*` with minPrecedence=70), assignment must stay outside our
    // grammar — otherwise `*p = v` parses as `*(p = v)`.
    if (peek().tag === TokenTags.eq && minPrecedence === 0) {
      if (
        node.kind !== ASTNodeKind.IDENT &&
        node.kind !== ASTNodeKind.FIELD_ACCESS &&
        node.kind !== ASTNodeKind.INDEX_EXPRESSION &&
        node.kind !== ASTNodeKind.DEREF_EXPRESSION
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

    // Phase 9: compound assignment — `x += y`, `x -= y`, `x *= y`, `x /= y`,
    // `x %= y`. Stored as a dedicated AST node so codegen evaluates the
    // lvalue once even if it contains side-effecting subexpressions.
    const compoundOpMap = {
      [TokenTags.plusEq]: "plus",
      [TokenTags.minusEq]: "minus",
      [TokenTags.multEq]: "mult",
      [TokenTags.divideEq]: "divide",
      [TokenTags.modulusEq]: "modulus",
    };
    if (compoundOpMap[peek().tag] && minPrecedence === 0) {
      if (
        node.kind !== ASTNodeKind.IDENT &&
        node.kind !== ASTNodeKind.FIELD_ACCESS &&
        node.kind !== ASTNodeKind.INDEX_EXPRESSION &&
        node.kind !== ASTNodeKind.DEREF_EXPRESSION
      ) {
        throw parseError(
          `invalid compound-assignment target: ${node.kind}`,
          peek().start,
          peek().length,
        );
      }
      const opTok = advance();
      const compoundNode = buildSourcedNode(ASTNodeKind.COMPOUND_ASSIGNMENT);
      compoundNode.target = node;
      compoundNode.op = compoundOpMap[opTok.tag];
      compoundNode.value = parseExpression();
      return compoundNode;
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
  function parseTemplateLiteralBody(raw, templateStart) {
    const inner = raw.slice(1, -1); // strip surrounding backticks
    // inner[k] corresponds to outer offset (templateStart + 1 + k) because
    // the leading backtick consumes one outer char before `inner` starts.
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
        // Re-parse the expression via a synthetic wrapper. The resulting
        // sourceLocs are relative to `wrappedSrc`; we remap them to the
        // outer source so LSP go-to-definition / hover land on the actual
        // characters the user sees.
        const wrapperPrefix = "function __t(): int32 { return ";
        const wrappedSrc = `${wrapperPrefix}${exprSrc}; }`;
        const subAst = parse(wrappedSrc);
        const exprNode = subAst.body[0].body.body[0].value;
        // Outer offset of exprSrc's first char:
        //   templateStart (the opening backtick)
        //   + 1 (skip backtick to reach `inner`)
        //   + i + 2 (skip past `${`)
        const exprOuterStart = templateStart + 1 + i + 2;
        remapSourceLocs(exprNode, src, wrapperPrefix.length, exprOuterStart);
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

  // Walk a sub-AST whose sourceLocs are relative to a synthetic source and
  // rewrite each sourceLoc to be relative to the outer source. `innerStart`
  // is the offset within the synthetic source where the user-written
  // expression begins; `outerStart` is its corresponding offset in `outerSrc`.
  function remapSourceLocs(node, outerSrc, innerStart, outerStart) {
    const visited = new WeakSet();
    function visit(n) {
      if (!n || typeof n !== "object" || visited.has(n)) return;
      visited.add(n);
      if (Array.isArray(n)) { for (const c of n) visit(c); return; }
      if (n.sourceLoc && typeof n.sourceLoc.pos === "number") {
        const innerPos = n.sourceLoc.pos;
        const newOuterPos = outerStart + (innerPos - innerStart);
        if (newOuterPos >= 0 && newOuterPos <= outerSrc.length) {
          const remapped = posToSourceLocation(outerSrc, newOuterPos);
          if (n.sourceLoc.length != null) remapped.length = n.sourceLoc.length;
          n.sourceLoc = remapped;
        }
      }
      for (const key of Object.keys(n)) {
        if (key === "sourceLoc" || key === "resolvedType" || key === "resolvedDeclNode") continue;
        const v = n[key];
        if (v && typeof v === "object") visit(v);
      }
    }
    visit(node);
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
      case TokenTags.switch: {
        return parseSwitchStatement();
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

  // Phase 8.E: enforce MVP restrictions on module-level let/const decls.
  // Throws a parseError on violation. The decl AST is already built; we
  // inspect its shape and reject what we don't support yet.
  function validateModuleLevelDecl(decl) {
    if (decl.kind === ASTNodeKind.DESTRUCTURE_DECL) {
      throw parseError(
        "destructuring at module top is not supported",
        decl.sourceLoc?.pos ?? 0,
        1,
      );
    }
    if (decl.kindPrefix) {
      throw parseError(
        "kind prefix on a module-level binding is not supported",
        decl.kindPrefix.sourceLoc?.pos ?? decl.sourceLoc?.pos ?? 0,
        1,
      );
    }
    if (!decl.typeAnnotation) {
      throw parseError(
        "module-level binding requires an explicit type annotation",
        decl.sourceLoc?.pos ?? 0,
        1,
      );
    }
    if (!decl.assignment) {
      throw parseError(
        "module-level binding requires an initializer (= expr)",
        decl.sourceLoc?.pos ?? 0,
        1,
      );
    }
    if (decl.trailingBlock) {
      throw parseError(
        "trailing block is not supported on a module-level binding",
        decl.sourceLoc?.pos ?? 0,
        1,
      );
    }
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
    // Phase 9.D: dispatch between the classic C-style `for (i = ...; ...; ...)`
    // and the new `for ITEM in EXPR { ... }` element-walking form. The
    // disambiguator is one token of lookahead after `for`:
    //   `for (`         -> classic
    //   `for IDENT in`  -> for-in
    if (peek().tag === TokenTags.ident && peekAhead(1).tag === TokenTags.in) {
      return parseForInStatement();
    }
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

  // Phase 9.D: `for item in xs { ... }`. The expression after `in` is parsed
  // with parseExpression(0); typecheck enforces it resolves to an array (and,
  // in a later phase, to any type implementing Iterable<T>).
  function parseForInStatement() {
    const node = buildSourcedNode(ASTNodeKind.FOR_IN_LOOP);
    node.loopVar = parseIdentAsName();
    expect(TokenTags.in);
    node.iterExpr = parseExpression();
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

  // Phase 7.5: enum declaration.
  //   enum Name<TParams?> { Variant1 { f: T, ... }, Variant2, ... }
  function parseEnumDecl() {
    expect(TokenTags.enum);
    const node = buildSourcedNode(ASTNodeKind.ENUM_DECL);
    node.name = parseIdentAsName();
    node.typeParams = parseTypeParamList();
    node.variants = [];
    expect(TokenTags.lcurly);
    const seenNames = new Set();
    while (peek().tag === TokenTags.ident) {
      const varTok = peek();
      const variant = buildSourcedNode(ASTNodeKind.ENUM_VARIANT);
      variant.name = parseIdentAsName();
      if (seenNames.has(variant.name)) {
        throw parseError(
          `duplicate variant name '${variant.name}' in enum '${node.name}'`,
          varTok.start,
          varTok.length,
        );
      }
      seenNames.add(variant.name);
      if (peek().tag === TokenTags.lcurly) {
        // payload variant — { field: Type, ... }
        advance(); // consume {
        variant.fields = [];
        while (peek().tag === TokenTags.ident) {
          const fieldNode = buildSourcedNode(ASTNodeKind.FIELD_DECL);
          fieldNode.name = parseIdentAsName();
          expect(TokenTags.colon);
          fieldNode.typeAnnotation = parseTypeAnnotation();
          fieldNode.kindPrefix = null;
          variant.fields.push(fieldNode);
          if (peek().tag === TokenTags.comma) advance();
        }
        expect(TokenTags.rcurly);
        if (variant.fields.length === 0) {
          throw parseError(
            `variant '${variant.name}' has empty payload braces — write '${variant.name}' for a no-payload variant`,
            varTok.start,
            varTok.length,
          );
        }
      } else {
        // no-payload variant
        variant.fields = null;
      }
      node.variants.push(variant);
      if (peek().tag === TokenTags.comma) advance();
    }
    expect(TokenTags.rcurly);
    if (node.variants.length === 0) {
      throw parseError(
        `enum '${node.name}' must declare at least one variant`,
        node.sourceLoc.pos,
        1,
      );
    }
    return node;
  }

  // Phase 7.5: union declaration — untagged overlapping-memory aggregate.
  //   union Name { field: Type, ... }
  function parseUnionDecl() {
    expect(TokenTags.union);
    const node = buildSourcedNode(ASTNodeKind.UNION_DECL);
    node.name = parseIdentAsName();
    // Reject generics on unions — deferred (see plans/phase-7-5-sum-types-and-unions.md).
    if (peek().tag === TokenTags.lt) {
      throw parseError(
        `generic unions are not yet supported (deferred)`,
        peek().start,
        peek().length,
      );
    }
    // Reject `implements` on unions — deferred.
    if (peek().tag === TokenTags.implements) {
      throw parseError(
        `union types cannot implement traits in this phase (deferred)`,
        peek().start,
        peek().length,
      );
    }
    node.fields = [];
    expect(TokenTags.lcurly);
    while (peek().tag === TokenTags.ident) {
      const fieldNode = buildSourcedNode(ASTNodeKind.FIELD_DECL);
      fieldNode.name = parseIdentAsName();
      expect(TokenTags.colon);
      fieldNode.typeAnnotation = parseTypeAnnotation();
      fieldNode.kindPrefix = null;
      node.fields.push(fieldNode);
      if (peek().tag === TokenTags.comma) advance();
    }
    expect(TokenTags.rcurly);
    if (node.fields.length === 0) {
      throw parseError(
        `union '${node.name}' must declare at least one field`,
        node.sourceLoc.pos,
        1,
      );
    }
    return node;
  }

  // Phase 7.5: switch statement with optional variant patterns.
  //   switch (expr) { case Pat: { ... }  default: { ... } }
  function parseSwitchStatement() {
    expect(TokenTags.switch);
    const node = buildSourcedNode(ASTNodeKind.SWITCH_STATEMENT);
    expect(TokenTags.lparen);
    node.scrutinee = parseExpression();
    expect(TokenTags.rparen);
    expect(TokenTags.lcurly);
    node.arms = [];
    node.defaultArm = null;
    let sawDefault = false;
    while (
      peek().tag !== TokenTags.rcurly &&
      peek().tag !== TokenTags.eof
    ) {
      const armStartTok = peek();
      if (peek().tag === TokenTags.default) {
        if (sawDefault) {
          throw parseError(
            `duplicate 'default' clause in switch`,
            armStartTok.start,
            armStartTok.length,
          );
        }
        advance(); // consume default
        expect(TokenTags.colon);
        node.defaultArm = parseBlock();
        sawDefault = true;
        continue;
      }
      if (peek().tag !== TokenTags.case) {
        throw parseError(
          `expected 'case' or 'default' in switch body, got ${inverseTokenTags[peek().tag]}`,
          armStartTok.start,
          armStartTok.length,
        );
      }
      if (sawDefault) {
        throw parseError(
          `'default' must be the last clause in a switch`,
          armStartTok.start,
          armStartTok.length,
        );
      }
      advance(); // consume case
      const arm = buildSourcedNode(ASTNodeKind.SWITCH_ARM);
      arm.patterns = [parseSwitchPattern()];
      while (peek().tag === TokenTags.comma) {
        advance();
        arm.patterns.push(parseSwitchPattern());
      }
      expect(TokenTags.colon);
      arm.body = parseBlock();
      node.arms.push(arm);
    }
    expect(TokenTags.rcurly);
    if (node.arms.length === 0 && node.defaultArm === null) {
      throw parseError(
        `empty switch — must have at least one case or default`,
        node.sourceLoc.pos,
        1,
      );
    }
    return node;
  }

  // Phase 7.5: parse a single arm pattern. Accepts:
  //   - INT_LITERAL / BOOL_LITERAL                       → LITERAL_PATTERN
  //   - `_`                                              → VARIANT_PATTERN { isWildcard: true }
  //   - IDENT.IDENT { fieldBindings? }                   → VARIANT_PATTERN
  //   - IDENT.IDENT                                      → VARIANT_PATTERN (no-payload form)
  // (Char literals tokenize as strLiterals today; reject string and float
  // literals at pattern position with explicit diagnostics.)
  function parseSwitchPattern() {
    const tok = peek();
    if (tok.tag === TokenTags.discard) {
      advance();
      const p = buildSourcedNode(ASTNodeKind.VARIANT_PATTERN);
      p.isWildcard = true;
      p.enumName = null;
      p.variantName = null;
      p.fieldBindings = null;
      return p;
    }
    // negative-literal sugar: `-N` consumed as a single INT/FLOAT literal value.
    if (tok.tag === TokenTags.minus) {
      advance();
      const num = peek();
      if (num.tag !== TokenTags.intLiteral) {
        throw parseError(
          `expected integer literal after '-' in pattern`,
          num.start,
          num.length,
        );
      }
      advance();
      const p = buildSourcedNode(ASTNodeKind.LITERAL_PATTERN);
      p.literalKind = "int";
      p.value = -num.intVal;
      return p;
    }
    if (tok.tag === TokenTags.intLiteral) {
      advance();
      const p = buildSourcedNode(ASTNodeKind.LITERAL_PATTERN);
      p.literalKind = "int";
      p.value = tok.intVal;
      return p;
    }
    if (tok.tag === TokenTags.true || tok.tag === TokenTags.false) {
      advance();
      const p = buildSourcedNode(ASTNodeKind.LITERAL_PATTERN);
      p.literalKind = "bool";
      p.value = tok.tag === TokenTags.true;
      return p;
    }
    if (tok.tag === TokenTags.floatLiteral) {
      throw parseError(
        `float literals are not allowed in switch patterns`,
        tok.start,
        tok.length,
      );
    }
    if (tok.tag === TokenTags.strLiteral) {
      throw parseError(
        `string literals are not allowed in switch patterns`,
        tok.start,
        tok.length,
      );
    }
    if (tok.tag === TokenTags.ident) {
      const enumName = parseIdentAsName();
      if (peek().tag !== TokenTags.dot) {
        throw parseError(
          `variant patterns must be written as EnumName.Variant; bare identifier '${enumName}' is not allowed in a pattern`,
          tok.start,
          tok.length,
        );
      }
      advance(); // consume dot
      const variantName = parseIdentAsName();
      const p = buildSourcedNode(ASTNodeKind.VARIANT_PATTERN);
      p.isWildcard = false;
      p.enumName = enumName;
      p.variantName = variantName;
      p.fieldBindings = null;
      if (peek().tag === TokenTags.lcurly) {
        advance();
        p.fieldBindings = [];
        while (
          peek().tag !== TokenTags.rcurly &&
          peek().tag !== TokenTags.eof
        ) {
          const fb = {};
          if (peek().tag === TokenTags.discard) {
            // bare _ inside braces — placeholder field-ignore (positional-style)
            const dtok = advance();
            fb.fieldName = null;
            fb.bindingName = null;
            fb.isWildcard = true;
            fb.sourceLoc = posToSourceLocation(src, dtok.start);
          } else {
            const fnameTok = expect(TokenTags.ident);
            fb.fieldName = src.substring(
              fnameTok.start,
              fnameTok.start + fnameTok.length,
            );
            fb.sourceLoc = posToSourceLocation(src, fnameTok.start);
            fb.isWildcard = false;
            fb.bindingName = fb.fieldName; // shorthand: bind to same name
            if (peek().tag === TokenTags.colon) {
              advance();
              if (peek().tag === TokenTags.discard) {
                advance();
                fb.isWildcard = true;
                fb.bindingName = null;
              } else {
                const renameTok = expect(TokenTags.ident);
                fb.bindingName = src.substring(
                  renameTok.start,
                  renameTok.start + renameTok.length,
                );
              }
            }
          }
          p.fieldBindings.push(fb);
          if (peek().tag === TokenTags.comma) advance();
        }
        expect(TokenTags.rcurly);
      }
      return p;
    }
    throw parseError(
      `unexpected token in switch pattern: ${inverseTokenTags[tok.tag]}`,
      tok.start,
      tok.length,
    );
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
