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
    tag === TokenTags.oror
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
    tag === TokenTags.forbids
  );
}

// Identifier text -> deferred-feature error message. Used inside kind { ... }
// to produce a precise "not yet supported" error for clause keywords that
// later sub-phases will introduce; today they lex as plain idents.
const DeferredKindClauseMessages = {
  provides: "provides clause not yet supported in phase 6.1",
  autoJoin: "autoJoin not yet supported (phase 6.3)",
  restricts: "restricts not yet supported (phase 6.5)",
  layout: "layout not yet supported (phase 6.5)",
};

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

  // helper functions for token stream management

  // advances to the next token but returns the current one
  // reason for returning the current token is that often the
  // caller needs to read info from the current token with reference
  // to the next token, which is more complex than just reading the
  // next string character.
  function advance() {
    const tok = current;
    const res = lexNext(src, pos);
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
      kindNames.push({
        name,
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
    let annot = { kind: "typeName", name };
    // Phase 6.4: `Task<T>` — built-in generic. The compiler emits Task<T>
    // internally from `task fn ...` declarations; this is the surface syntax
    // used in struct fields and pooled-parameter annotations.
    if (name === "Task" && peek().tag === TokenTags.lt) {
      advance(); // consume <
      const inner = parseTypeAnnotation();
      expect(TokenTags.gt);
      annot = { kind: "taskType", inner };
    }
    // optional [] suffix for arrays — in type position, [ always means T[]
    if (peek().tag === TokenTags.lbracket) {
      advance(); // consume [
      expect(TokenTags.rbracket); // must be ]
      annot = { kind: "arrayType", elem: annot };
    }
    return annot;
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

    // parameterized kinds — `kind foo(...)` — are reserved for later phases
    if (peek().tag === TokenTags.lparen) {
      throw parseError(
        "parameterized kinds not yet supported in phase 6.1",
        peek().start,
        peek().length,
      );
    }
    // composition — `kind foo = a & b;`
    if (peek().tag === TokenTags.eq) {
      throw parseError(
        "kind composition not yet supported in phase 6.1",
        peek().start,
        peek().length,
      );
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
            "appliesTo function not yet supported (phase 6.5; introduced by task kind)",
            tok.start,
            tok.length,
          );
        case TokenTags.type:
          throw parseError(
            "appliesTo type not yet supported (phase 6.5; introduced by layout-bearing kinds)",
            tok.start,
            tok.length,
          );
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

    if (peek().tag === TokenTags.lt) {
      throw parseError(
        "trait generics are not supported in v0",
        peek().start,
        peek().length,
      );
    }

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
        // kind-prefixed binding form: `IDENT IDENT : ...`
        // (no other statement starts `ident ident :`).
        if (
          peekAhead(1).tag === TokenTags.ident &&
          peekAhead(2).tag === TokenTags.colon
        ) {
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
    //   - declToken was null (shape 3): caller already verified IDENT IDENT :
    //   - declToken was present and we see IDENT IDENT :
    let kindPrefix = null;
    if (
      peek().tag === TokenTags.ident &&
      peekAhead(1).tag === TokenTags.ident &&
      peekAhead(2).tag === TokenTags.colon
    ) {
      const kindTok = advance();
      kindPrefix = {
        name: src.substring(kindTok.start, kindTok.start + kindTok.length),
        sourceLoc: posToSourceLocation(src, kindTok.start),
      };
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

  function parseTypeDecl() {
    expect(TokenTags.type);
    const node = buildSourcedNode(ASTNodeKind.TYPE_DECL);
    // name
    node.name = parseIdentAsName();

    node.implements = [];
    if (peek().tag === TokenTags.implements) {
      advance();
      if (peek().tag === TokenTags.lparen) {
        advance();
        while (peek().tag === TokenTags.ident) {
          node.implements.push(parseIdentAsName());
          if (peek().tag === TokenTags.comma) {
            advance();
          }
        }
        expect(TokenTags.rparen);
      } else {
        node.implements.push(parseIdentAsName());
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
    // Examples: `scoped h: ref FileHandle` or `scoped ref h: FileHandle`.
    if (!node.kindPrefix && peek().tag === TokenTags.ident) {
      const next1 = peekAhead(1);
      if (next1.tag === TokenTags.ident || next1.tag === TokenTags.ref) {
        const kindTok = advance();
        node.kindPrefix = {
          name: src.substring(kindTok.start, kindTok.start + kindTok.length),
          sourceLoc: posToSourceLocation(src, kindTok.start),
        };
        // Reject a second kind prefix: IDENT followed by (IDENT or ref) again
        if (peek().tag === TokenTags.ident) {
          const next2 = peekAhead(1);
          if (next2.tag === TokenTags.ident) {
            throw parseError(
              "a parameter may carry at most one kind prefix in phase 6.2",
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
