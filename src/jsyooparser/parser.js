import {
  lexNext,
  TokenTags,
  inverseTokenTags,
  tokenScanList,
  keywordTagList,
} from "../jsyooplexer/lexer.js";

import { ASTNode, ASTNodeKind } from "../contracts.js";
import { posToSourceLocation } from "../helpers.js";
import {
  getAttributeHandler,
  knownAttributeNames,
  suggestAttributeName,
} from "../jsyoopattributes/registry.js";

// Set of tags the lexer assigns to reserved-word identifiers. Used to accept
// keyword-shaped tokens in name-only positions (field decls, extern param
// names, RHS of field access) where the keyword's grammar role doesn't apply
// and the source is being used as a bare identifier.
const keywordTagSet = new Set(Object.values(keywordTagList));

function isIdentLikeTag(tag) {
  return tag === TokenTags.ident || keywordTagSet.has(tag);
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
    tag === TokenTags.oror ||
    tag === TokenTags.pipe
  );
}

// Clause keywords that are still RESERVED WORDS, so a tag alone identifies
// them. `requires` and `layout` used to be here and are now contextual idents
// (see CONTEXTUAL_KIND_CLAUSES below and the note in lexer.js) - the caller
// checks both.
function isKindClauseStartTag(tag) {
  return (
    tag === TokenTags.appliesTo ||
    tag === TokenTags.mustCall ||
    tag === TokenTags.ownsBlock ||
    tag === TokenTags.mustNotEscape ||
    tag === TokenTags.mustNotShare ||
    tag === TokenTags.forbids
  );
}

// Clause keywords that lex as ordinary identifiers and are recognized only
// here, inside a kind body. Keeping them out of keywordTagList is what lets
// `requires` be a struct field and `layout` a local everywhere else.
const CONTEXTUAL_KIND_CLAUSES = new Set(["requires", "layout"]);

// Identifier text -> deferred-feature error message. Used inside kind { ... }
// to produce a precise "not yet supported" error for clause keywords that
// later sub-phases will introduce; today they lex as plain idents.
const DeferredKindClauseMessages = {
  // `autoJoin` was only ever `mustCall wait beforeScopeEnd` under another
  // name; `joined` in std/core/kinds.yoop spells it that way now.
  autoJoin:
    "autoJoin is not a clause - write `mustCall wait beforeScopeEnd;` instead",
  restricts:
    "iteration restrictions deferred until for-in iteration lands (phase 7)",
};

const Precedence = {
  [TokenTags.eq]: 10,
  // `a..b` binds looser than every arithmetic and comparison operator, so
  // `0..n - 1` is `0..(n - 1)` and `i < a..b` is a (nonsensical, and rejected)
  // comparison of a Range - never a range of comparisons. Matches Rust.
  [TokenTags.dotdot]: 15,
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

// The `..` operator's precedence, named because the slice form `xs[i..j]` has
// to parse its bounds at exactly this level to keep its own `..` visible.
const RANGE_PRECEDENCE = Precedence[TokenTags.dotdot];

// Compound-assignment operators accepted in a for-loop's step slot, mapped to
// the binary op they desugar to. Same token set as the statement-position
// compound assignment; the step slot is already an implicit assignment to a
// plain ident, so `i += 1` becomes the `i = i + 1` the node has always held.
const ForStepCompoundOps = {
  [TokenTags.plusEq]: "plus",
  [TokenTags.minusEq]: "minus",
  [TokenTags.multEq]: "mult",
  [TokenTags.divideEq]: "divide",
  [TokenTags.modulusEq]: "modulus",
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
  // Monotonic counter for synthesized names of anonymous region-kind bindings
  // (`ephemeral EXPR { ... }`). The `$` prefix can't appear in user source, so
  // these names are collision-free and unreferenceable - the value exists only
  // so the cleanup machinery has a slot to dispose at scope/block end.
  let anonRegionCounter = 0;
  // Every RANGE_EXPR (`a..b`) built during this parse, published on the
  // PROGRAM node so the driver's range lowering can rewrite them without an
  // AST walk.
  const rangeExprs = [];
  // Set while parsing the RHS of `for ITEM in EXPR { ... }`, where a `{` after
  // an `IDENT.IDENT` path is ambiguous: it can open a variant constructor's
  // payload (`Shape.Circle { r: 5 }`) or the loop's own body (`for x in
  // self.items {`). The constructor used to win unconditionally, so
  // `for x in self.f {` was a parse error and callers had to prebind the RHS to
  // a local first (the workaround @derive still carries for arrays). Inside the
  // RHS the brace must LOOK like a payload to be read as one - see
  // looksLikeVariantPayload.
  let inForInIterExpr = false;

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

  // Phase 6.5: true if the current tokens look like a *named* kind-prefixed
  // binding start: `IDENT IDENT :` / `IDENT IDENT =` or the kind-with-args
  // forms `IDENT ( ... ) IDENT :` / `IDENT ( ... ) IDENT =`. Used for both
  // statement-start dispatch (implicit-const form) and the `let|const`
  // kind-prefix recognizer.
  //
  // The `=` alternative (no `:` type annotation) is the inferred-type form:
  // `disposable allocScope = mem.allocatorScope(arena) { ... }` infers the
  // binding's type from its initializer, exactly like a plain `const x = ...`.
  // No expression statement begins with two bare identifiers, so `IDENT IDENT`
  // is an unambiguous kind-prefix lead.
  function bindingNameFollowedByColonOrEq(idx) {
    return (
      peekAhead(idx).tag === TokenTags.ident &&
      (peekAhead(idx + 1).tag === TokenTags.colon ||
        peekAhead(idx + 1).tag === TokenTags.eq)
    );
  }
  // `kind` is a contextual keyword: it lexes as an ordinary IDENT so it stays
  // usable as a parameter, local, and field name, and is recognized as a
  // declaration only by its shape here. Three tokens, which is the existing
  // peekAhead ceiling:
  //
  //     kind Name {          a clause body
  //     kind Name(n: usize)  a parameterized kind
  //     kind Name = a & b    a composition
  //
  // Only ever consulted in DECLARATION position (top level, and after
  // `export`), which is what keeps it clear of the kind-prefixed BINDING form
  // `someKind name = ...`: a kind-prefixed binding is rejected at module level
  // anyway, so `kind Name = ...` there can only be the declaration.
  //
  // Reserving the word cost more than it bought - it was legal as a struct
  // FIELD and illegal as a local or parameter, so `Room.kind` compiled and
  // `specialFor(kind: uint8)` did not, and the collision surfaced nowhere near
  // where the name was chosen (yooperdoom-takeaways 2.2).
  function looksLikeKindDecl() {
    if (!identTextIs("kind")) return false;
    if (peekAhead(1).tag !== TokenTags.ident) return false;
    const after = peekAhead(2).tag;
    return (
      after === TokenTags.lcurly ||
      after === TokenTags.lparen ||
      after === TokenTags.eq
    );
  }

  function looksLikeKindPrefixedBindingStart() {
    if (peek().tag !== TokenTags.ident) return false;
    if (bindingNameFollowedByColonOrEq(1)) {
      return true;
    }
    if (peekAhead(1).tag === TokenTags.lparen) {
      const j = findMatchingRparen(1);
      if (j < 0) return false;
      return bindingNameFollowedByColonOrEq(j + 1);
    }
    return false;
  }

  // SPEC section 7: a run of one or more kind-prefix identifiers followed by
  // `name(params)` is a function declaration, with `function` optional:
  //
  //     task fetch(url: string): Bytes { ... }
  //     task function fetch(url: string): Bytes { ... }   // equivalent
  //     async disposable openRemote(url: string): Handle { ... }
  //
  // The parser only checks the SHAPE - whether each prefix names a kind whose
  // appliesTo includes `function` is the typechecker's job, because kinds are
  // resolved there. That is the same division `disposable x = ...` already
  // uses for bindings.
  //
  // Returns the number of prefix identifiers, or 0 when this is not a
  // kind-prefixed function. Capped because peekAhead re-lexes: a real decl
  // never stacks more than a couple of prefixes.
  const MAX_KIND_PREFIXES = 8;
  function kindPrefixedFunctionArity() {
    if (peek().tag !== TokenTags.ident) return 0;
    let i = 0;
    while (i <= MAX_KIND_PREFIXES && peekAhead(i).tag === TokenTags.ident) i++;
    if (i > MAX_KIND_PREFIXES) return 0;
    // Optional explicit `function` between the prefixes and the name.
    if (peekAhead(i).tag === TokenTags.function) {
      const nameAt = i + 1;
      if (peekAhead(nameAt).tag !== TokenTags.ident) return 0;
      return startsParamListOrTypeParams(nameAt + 1) ? i : 0;
    }
    // Otherwise the last identifier in the run IS the function name, so we
    // need at least two (one prefix + the name).
    if (i < 2) return 0;
    return startsParamListOrTypeParams(i) ? i - 1 : 0;
  }

  // Method form of the same rule: `async read(ref self)` / `function read(...)`
  // / `async function read(...)`. Returns the prefix list.
  function parseMethodKindPrefixes() {
    const prefixCount = kindPrefixedFunctionArity();
    const prefixes = [];
    for (let i = 0; i < prefixCount; i++) {
      const tok = peek();
      prefixes.push({
        name: parseIdentAsName(),
        sourceLoc: posToSourceLocation(src, tok.start),
      });
    }
    if (peek().tag === TokenTags.function) advance();
    else if (prefixCount === 0) expect(TokenTags.function);
    return prefixes;
  }

  // `(` opens the parameter list; `<` opens a type-parameter list on a
  // generic decl (`task compute<T>(x: T)`).
  function startsParamListOrTypeParams(offset) {
    const tag = peekAhead(offset).tag;
    return tag === TokenTags.lparen || tag === TokenTags.lt;
  }

  // True if the `{` at the cursor looks like a variant constructor's payload
  // rather than a block: a payload always starts `{ <name> :`, and no statement
  // can. Only consulted inside a for-in RHS (see inForInIterExpr), so the
  // ordinary constructor path keeps accepting the empty `Shape.Dot {}` form.
  // A nested payload still matches, so `for x in iterOf(Shape.Circle { r: 5 })`
  // is unaffected by the suppression.
  function looksLikeVariantPayload() {
    return (
      peekAhead(1).tag !== TokenTags.rcurly &&
      peekAhead(2).tag === TokenTags.colon
    );
  }

  // True if the current tokens look like an *anonymous* region-kind block:
  // `IDENT EXPR { ... }` or `IDENT EXPR;` with no binding name (e.g.
  // `ephemeral mem.allocatorScope(arena) { ... }`). The defining lead is two
  // adjacent identifiers where the second is NOT a binding name (no following
  // `:`/`=`); the first identifier is the kind, the second begins the
  // initializer expression. Must be checked AFTER the named recognizer so the
  // `IDENT IDENT :`/`IDENT IDENT =` named forms win.
  function looksLikeAnonymousRegionStart() {
    return (
      peek().tag === TokenTags.ident &&
      peekAhead(1).tag === TokenTags.ident &&
      peekAhead(2).tag !== TokenTags.colon &&
      peekAhead(2).tag !== TokenTags.eq
    );
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
  //
  // BOTH are contextual idents now - they lex as ordinary IDENTs and are
  // recognized only here, in kind decls, and in a decl's clause suffix.
  // `contains` was demoted first (chat-agent-papercut #3); `propagates`
  // followed for the same reason, and a `requires`/`propagates` pair reads
  // naturally as struct fields in anything manifest-shaped.
  function isPropagationClauseStart(tok) {
    const text = identText(tok);
    return text === "propagates" || text === "contains";
  }

  function parseKindListClause() {
    const tok = advance(); // consume propagates|contains
    const variant =
      src.substring(tok.start, tok.start + tok.length) === "propagates"
        ? "propagates"
        : "contains";
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
      // Phase 6.5: optional kind arguments - `propagates<K(args)>`
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
    while (isPropagationClauseStart(peek())) {
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
    // clearance kinds: optional leading marker-kind prefix(es) on a type, e.g.
    // `cleared string`, `tainted uint8[]`, `cleared validated Foo`. A prefix is
    // an IDENT immediately followed by another IDENT (the rest of the type) -
    // the only shape in which two idents are adjacent in type position. The
    // names are resolved + validated in the typechecker. `ref cleared T` works
    // via the recursion below (the prefix lands on the inner type).
    //
    // Exception: a CLAUSE KEYWORD following the type is not part of it. Once
    // `propagates` and `contains` became contextual idents, a return type like
    //
    //     function f(): Bytes propagates<disposable>
    //
    // matched the two-adjacent-idents shape and parsed as the kind-prefixed
    // type `propagates<disposable>` prefixed by `Bytes` - reported as the
    // baffling `unknown return type "propagates<disposable>"`. The clause is
    // the caller's to consume (parsePropagationClauses), so the prefix scan
    // has to stop before it.
    let kindPrefixes = null;
    while (
      peek().tag === TokenTags.ident &&
      peekAhead(1).tag === TokenTags.ident &&
      !isPropagationClauseStart(peekAhead(1))
    ) {
      const tok = advance();
      (kindPrefixes ??= []).push(
        src.substring(tok.start, tok.start + tok.length),
      );
    }
    if (kindPrefixes !== null) {
      // After consuming prefixes the remaining type is always IDENT-led
      // (typeName / typeApplication, optional []). Parse it and attach.
      const base = parseTypeAnnotation();
      base.kindPrefixes = kindPrefixes;
      return base;
    }
    // Phase 9.G: function value type `(p1: T1, p2: T2, ...) => RetT`. The
    // disambiguator from a parenthesized type group is that function-type
    // param lists always start with `(` followed by `)` (no params), `ref`
    // (a ref param), or `IDENT :` (a named param). The unnamed-param form
    // `(T) => R` would be ambiguous with a `(T)` group - we require named
    // params for clarity and to match the function-decl surface.
    //
    // Phase 10.K: anything else after `(` is a parenthesized type *group*,
    // whose only purpose is to attach an array suffix: `((p: T) => R)[]` is
    // the way to spell an array of function pointers. (A bare
    // `(p: T) => R[]` binds the `[]` to the return type, since the return
    // type is parsed greedily - so grouping is required to lift the array
    // out to the whole function type.)
    if (peek().tag === TokenTags.lparen) {
      const after = peekAhead(1);
      const isFnParamList =
        after.tag === TokenTags.rparen ||
        after.tag === TokenTags.ref ||
        (after.tag === TokenTags.ident && peekAhead(2).tag === TokenTags.colon);
      if (isFnParamList) {
        return parseFunctionTypeAnnotation();
      }
      // Parenthesized type group: `( type )` with optional `[]` suffix(es).
      advance(); // consume (
      let grouped = parseTypeAnnotation();
      expect(TokenTags.rparen);
      while (peek().tag === TokenTags.lbracket) {
        advance(); // consume [
        expect(TokenTags.rbracket); // must be ]
        grouped = { kind: "arrayType", elem: grouped };
      }
      return grouped;
    }
    // ref T
    if (peek().tag === TokenTags.ref) {
      advance();
      const inner = parseTypeAnnotation();
      return { kind: "refType", inner };
    }
    // base type name. Optional `ns.` prefix routes the lookup through
    // an imported namespace - the typechecker walks the source module's
    // type tables to find the qualified name.
    let nameTok = expect(TokenTags.ident);
    let name = src.substring(nameTok.start, nameTok.start + nameTok.length);
    let namespace = null;
    if (peek().tag === TokenTags.dot) {
      advance(); // consume .
      namespace = name;
      nameTok = expect(TokenTags.ident);
      name = src.substring(nameTok.start, nameTok.start + nameTok.length);
    }
    let annot;
    // Phase 7.1: any identifier followed by `<` parses as a generic type
    // application. The closing `>` may be the first half of a `>>` token -
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
      annot = namespace
        ? { kind: "typeApplication", name, typeArgs, namespace }
        : { kind: "typeApplication", name, typeArgs };
    } else {
      annot = namespace
        ? { kind: "typeName", name, namespace }
        : { kind: "typeName", name };
    }
    // optional [] suffix for arrays - in type position, [ always means T[]
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
        // Phase 10.I: optional `ref` modifier on the param. Required when
        // mirroring a trait method's `ref T` arg in a vtable field FPT
        // (e.g. `Reader.read: (ref buf: uint8[]) => ...`).
        let isRef = false;
        if (peek().tag === TokenTags.ref) {
          advance();
          isRef = true;
        }
        expect(TokenTags.ident); // param name (discarded)
        expect(TokenTags.colon);
        let annot = parseTypeAnnotation();
        if (isRef) {
          annot = { kind: "refType", inner: annot };
        }
        params.push(annot);
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
      // Phase 7.2 / 9.J: optional `implements` bound list on the param.
      // Single bound: `T implements Display`. Multiple bounds (9.J):
      // `T implements (Foo, Bar)`. Stored uniformly as `bounds: TraitAnnotation[]`
      // - empty when no bound, length 1 for single, length N for the
      // parenthesized form.
      node.bounds = [];
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
        const parseOneBound = () => {
          const annot = parseTypeAnnotation();
          if (annot.kind === "refType" || annot.kind === "arrayType") {
            throw parseError(
              `trait bound must be a trait name, not a ref/array type`,
              nameTok.start,
              nameTok.length,
            );
          }
          node.bounds.push(annot);
        };
        if (peek().tag === TokenTags.lparen) {
          // Phase 9.J: `T implements (A, B, C)` - at least one bound.
          advance(); // consume `(`
          if (peek().tag === TokenTags.rparen) {
            throw parseError(
              `empty trait bound list - write at least one trait after 'implements'`,
              peek().start,
              peek().length,
            );
          }
          while (true) {
            parseOneBound();
            if (peek().tag === TokenTags.comma) {
              advance();
              continue;
            }
            break;
          }
          expect(TokenTags.rparen);
        } else {
          parseOneBound();
        }
      }
      params.push(node);
      if (peek().tag === TokenTags.comma) {
        advance();
        // allow trailing comma - break if we hit the closing gt now
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
      // testing-via-kinds: `import.test;` marks this module as a test module.
      // A test module is allowed to have no `main` - the driver's --test mode
      // synthesizes an entry module that calls its enumerable-kinded functions.
      node.isTestModule = false;
      // modules-as-directories: an optional `module <name>;` header. Declaring
      // it is what opts this file's DIRECTORY in as a module (several source
      // files sharing one namespace and one mangling prefix); a file without
      // one stays a single-file module, exactly as before. Recognized
      // CONTEXTUALLY as the very first item in the file, so `module` remains an
      // ordinary identifier everywhere else - bootstrap/src/contracts.yoop uses
      // it as a struct field name. `IDENT IDENT ;` has no other meaning at top
      // level (a kind-prefixed binding needs `=`, a function needs `(`), so the
      // three-token lookahead is unambiguous. See plans/modules-as-directories.md.
      node.moduleName = null;
      if (
        peek().tag === TokenTags.ident &&
        src.substring(peek().start, peek().start + peek().length) === "module" &&
        peekAhead(1).tag === TokenTags.ident &&
        peekAhead(2).tag === TokenTags.semicolon
      ) {
        advance(); // module
        node.moduleName = parseIdentAsName();
        expect(TokenTags.semicolon);
      }
      let seenNonImport = false;
      while (peek().tag !== TokenTags.eof) {
        // only allow declarations
        const peekTag = peek().tag;
        switch (peekTag) {
          case TokenTags.function:
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
          case TokenTags.variant:
            {
              seenNonImport = true;
              node.body.push(parseVariantDecl());
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
              // Phase 8.A: `import.unsafe;` - module-level opt-in for raw
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
                if (featName !== "unsafe" && featName !== "test") {
                  throw parseError(
                    `unknown import attribute 'import.${featName}' - only 'import.unsafe' and 'import.test' are supported`,
                    featTok.start,
                    featTok.length,
                  );
                }
                advance(); // the feature name
                expect(TokenTags.semicolon);
                const flagSlot =
                  featName === "unsafe" ? "allowsUnsafe" : "isTestModule";
                if (node[flagSlot]) {
                  throw parseError(
                    `duplicate 'import.${featName};' declaration`,
                    importTok.start,
                    importTok.length,
                  );
                }
                node[flagSlot] = true;
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
          case TokenTags.at:
            {
              // Phase 11.A: `@<name>(args?) target` attribute at top level.
              seenNonImport = true;
              const attrNode = parseAttribute();
              // Phase 11.C: an attribute decorating a let/const decl
              // at the top level still produces a module-level decl
              // from the typechecker's perspective. Forward the
              // `isModuleLevel` flag through the wrapper so symbol
              // collection picks it up.
              const tgt = attrNode.target;
              if (
                tgt &&
                (tgt.kind === ASTNodeKind.LET_DECL ||
                  tgt.kind === ASTNodeKind.CONST_DECL)
              ) {
                validateModuleLevelDecl(tgt);
                tgt.isModuleLevel = true;
              }
              node.body.push(attrNode);
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
            // `kind Name { ... }` - checked before the kind-prefixed function
            // form, since `kind` is now an ordinary ident and both start with
            // one.
            if (looksLikeKindDecl()) {
              seenNonImport = true;
              node.body.push(parseKindDecl());
              break;
            }
            // testing-via-kinds: `<kind> function foo(...)` - a kind-prefixed
            // top-level function decl. Two adjacent tokens are enough to
            // recognize it, since `function` is a keyword and can never be an
            // ordinary identifier. The prefix is resolved against the kind
            // table in typecheck; here it is just a name.
            if (kindPrefixedFunctionArity() > 0) {
              seenNonImport = true;
              node.body.push(parseFunctionDecl());
              break;
            }
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

    // Every `a..b` in this module, in parse order. The driver rewrites these
    // in place (see jsyoopdriver/lower_range.js) instead of re-walking the
    // whole AST looking for them.
    node.rangeExprs = rangeExprs;

    return node;
  }

  // Strip surrounding quotes from a strLiteral token value.
  function unquoteStringLiteral(tok) {
    return src.substring(tok.start + 1, tok.start + tok.length - 1);
  }

  // Phase 11.A: `@<name>(args?) target` attribute. Parses the prefix,
  // optional arg list, and the decorated target (block, let/const decl,
  // or bare ; for argless statement-shaped attributes). Looks up the
  // attribute in the registry and runs its parsePhase handler; unknown
  // attribute names produce a "did you mean" diagnostic.
  function parseAttribute() {
    const atTok = expect(TokenTags.at);
    const node = buildSourcedNode(ASTNodeKind.ATTRIBUTE);
    node.sourceLoc = posToSourceLocation(src, atTok.start);
    node.sourceLoc.length = 1;

    const nameTok = expect(TokenTags.ident);
    node.name = src.substring(nameTok.start, nameTok.start + nameTok.length);
    node.nameSourceLoc = posToSourceLocation(src, nameTok.start);
    node.nameSourceLoc.length = nameTok.length;

    node.args = [];
    if (peek().tag === TokenTags.lparen) {
      const lparenTok = advance();
      node.argsSourceLoc = posToSourceLocation(src, lparenTok.start);
      while (
        peek().tag !== TokenTags.rparen &&
        peek().tag !== TokenTags.eof
      ) {
        node.args.push(parseExpression());
        if (peek().tag === TokenTags.comma) {
          advance();
          continue;
        }
        break;
      }
      expect(TokenTags.rparen);
    }

    // Target. Accepted shapes; future attribute consumers can extend the
    // dispatch (e.g. decorate a function decl). The `type` / `export`
    // targets exist for @derive(display) (per-attribute validation of
    // which targets are legal happens in the registry's parsePhase).
    const nextTag = peek().tag;
    if (nextTag === TokenTags.lcurly) {
      node.target = parseBlock();
    } else if (
      nextTag === TokenTags.let ||
      nextTag === TokenTags.const
    ) {
      node.target = parseVarDecl();
    } else if (nextTag === TokenTags.type) {
      node.target = parseTypeDecl();
    } else if (nextTag === TokenTags.variant) {
      node.target = parseVariantDecl();
    } else if (nextTag === TokenTags.export) {
      node.target = parseExportDecl();
    } else if (nextTag === TokenTags.semicolon) {
      advance();
      node.target = null;
    } else {
      throw parseError(
        `@${node.name} requires a '{ ... }' block, a 'let' / 'const' decl, a 'type' / 'variant' declaration (optionally exported), or ';' (got ${inverseTokenTags[nextTag]})`,
        peek().start,
        peek().length,
      );
    }

    const handler = getAttributeHandler(node.name);
    if (!handler) {
      const suggestion = suggestAttributeName(node.name);
      const known = knownAttributeNames()
        .map((n) => `@${n}`)
        .join(", ");
      const hint = suggestion
        ? ` Did you mean @${suggestion}?`
        : known.length
          ? ` Known attributes: ${known}.`
          : "";
      throw parseError(
        `unknown attribute @${node.name}.${hint}`,
        nameTok.start,
        nameTok.length,
      );
    }

    if (handler.parsePhase) {
      handler.parsePhase(node, {
        throwError: (msg, loc) => {
          throw parseError(msg, loc?.pos ?? nameTok.start, loc?.length ?? 1);
        },
      });
    }

    return node;
  }

  function parseKindDecl() {
    const node = buildSourcedNode(ASTNodeKind.KIND_DECL);
    expectContextual("kind");
    node.name = parseIdentAsName();
    node.params = [];
    node.composition = null;

    // parameterized kinds - `kind foo(n: usize, ...)`
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

    // composition - `kind foo = a & b(args) & { clauses } & c;`
    // Inline operands `{ clauses }` are anonymous bags of clauses; they may
    // not declare `appliesTo` (the composition's appliesTo is the intersection
    // of the named operands' sets).
    if (peek().tag === TokenTags.eq) {
      advance(); // =
      const kindRefs = [];
      while (true) {
        if (peek().tag === TokenTags.lcurly) {
          const startTok = peek();
          advance(); // {
          const clauses = [];
          while (
            peek().tag !== TokenTags.rcurly &&
            peek().tag !== TokenTags.eof
          ) {
            if (peek().tag === TokenTags.appliesTo) {
              throw parseError(
                "inline kind body in composition cannot declare 'appliesTo'; the composition inherits appliesTo from its named operands",
                peek().start,
                peek().length,
              );
            }
            if (atKindClauseStart()) {
              clauses.push(parseKindClause());
              continue;
            }
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
              `unexpected token in inline kind body: ${inverseTokenTags[peek().tag]}`,
              peek().start,
              peek().length,
            );
          }
          expect(TokenTags.rcurly);
          if (clauses.length === 0) {
            throw parseError(
              "inline kind body must contain at least one clause",
              startTok.start,
              startTok.length,
            );
          }
          kindRefs.push({
            inline: true,
            clauses,
            sourceLoc: posToSourceLocation(src, startTok.start),
          });
        } else {
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
            inline: false,
            name: refName,
            args: hasArgs ? args : null,
            sourceLoc: posToSourceLocation(src, refTok.start),
          });
        }
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
      if (atKindClauseStart()) {
        node.clauses.push(parseKindClause());
        continue;
      }
      // clearance kinds: `conferred;` / `restrictive;` are recognized
      // contextually inside a kind body (they lex as plain idents, so they
      // stay usable as ordinary identifiers everywhere else).
      if (markerPolarityFromIdent() !== null) {
        node.clauses.push(parseMarkerClause());
        continue;
      }
      // clearance kinds: `clearedBy <fn>;` / `appliedBy <fn>;` name the
      // function authorized to strip / confer this kind. Also contextual
      // idents so the words stay usable elsewhere.
      if (transitionDirectionFromIdent() !== null) {
        node.clauses.push(parseTransitionClause());
        continue;
      }
      // testing-via-kinds: `signature (p: T) => R;` and `enumerable as "x";`
      // for `appliesTo function` kinds. Contextual idents for the same reason
      // as above - `signature` and `enumerable` stay ordinary identifiers.
      if (identTextIs("signature")) {
        node.clauses.push(parseSignatureClause());
        continue;
      }
      if (identTextIs("enumerable")) {
        node.clauses.push(parseEnumerableClause());
        continue;
      }
      if (identTextIs("refcounted")) {
        node.clauses.push(parseRefcountedClause());
        continue;
      }
      if (identTextIs("provides")) {
        node.clauses.push(parseProvidesClause());
        continue;
      }
      if (identTextIs("pausable")) {
        node.clauses.push(parsePausableClause());
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

  // True when the current token starts a kind clause, by reserved tag OR by
  // contextual identifier text. Every caller that used to test
  // `isKindClauseStartTag(peek().tag)` goes through this instead.
  function atKindClauseStart() {
    if (isKindClauseStartTag(peek().tag)) return true;
    return CONTEXTUAL_KIND_CLAUSES.has(identText(peek()));
  }

  function parseKindClause() {
    // Contextual first: these lex as plain idents, so the tag switch below
    // would send them to the default arm.
    if (identTextIs("requires")) return parseRequiresClause();
    if (identTextIs("layout")) return parseLayoutClause();
    switch (peek().tag) {
      case TokenTags.appliesTo:
        return parseAppliesToClause();
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
        // unreachable - caller guards with atKindClauseStart
        throw parseError(
          `unexpected token in kind declaration: ${inverseTokenTags[peek().tag]}`,
          peek().start,
          peek().length,
        );
    }
  }

  // clearance kinds: returns the marker polarity if the current token is the
  // contextual ident `conferred` or `restrictive`, else null. These are not
  // reserved words - they are recognized only in kind-clause position.
  function markerPolarityFromIdent() {
    if (peek().tag !== TokenTags.ident) return null;
    const text = src.substring(peek().start, peek().start + peek().length);
    if (text === "conferred" || text === "restrictive") return text;
    return null;
  }

  // clearance kinds: returns "clearedBy" / "appliedBy" if the current token
  // is the contextual ident naming a transition direction, else null.
  function transitionDirectionFromIdent() {
    if (peek().tag !== TokenTags.ident) return null;
    const text = src.substring(peek().start, peek().start + peek().length);
    if (text === "clearedBy" || text === "appliedBy") return text;
    return null;
  }

  // testing-via-kinds: true when the current token is the given contextual
  // ident. Used for clause keywords that must stay ordinary identifiers
  // everywhere outside a kind body.
  function identTextIs(word) {
    return identText(peek()) === word;
  }

  // The source text of `tok` when it is an identifier, else "". The guard
  // matters: without it a keyword token's text would match a contextual word
  // and two different tokens would be treated as the same thing.
  function identText(tok) {
    if (!tok || tok.tag !== TokenTags.ident) return "";
    return src.substring(tok.start, tok.start + tok.length);
  }

  // The contextual-keyword counterpart of `expect(TokenTags.X)`: assert the
  // current token is the identifier `word`, consume it, and return it.
  function expectContextual(word) {
    if (!identTextIs(word)) {
      throw parseError(
        `expected "${word}", got ${identText(peek()) || inverseTokenTags[peek().tag]}`,
        peek().start,
        peek().length,
      );
    }
    return advance();
  }

  // `refcounted <retain> <release>;` - names the two methods of the kind's
  // required trait that the compiler calls to bump and drop a reference.
  // Contextual ident, like every other clause keyword, so `refcounted`
  // stays usable as an ordinary identifier outside a kind body.
  function parseRefcountedClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_REFCOUNTED_CLAUSE);
    advance(); // refcounted
    node.retainMethod = parseIdentAsName();
    node.releaseMethod = parseIdentAsName();
    expect(TokenTags.semicolon);
    return node;
  }

  // `pausable;` - the function may stop partway through and continue later.
  // No arguments; the clause is the whole statement.
  function parsePausableClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_PAUSABLE_CLAUSE);
    advance(); // pausable
    expect(TokenTags.semicolon);
    return node;
  }

  // `provides <Kind>;` - the call-site result type of a function carrying
  // this kind is rewritten. Today the only provider is `task`
  // (`provides Task` -> the call yields `Task<ReturnType>`).
  function parseProvidesClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_PROVIDES_CLAUSE);
    advance(); // provides
    node.providedName = parseIdentAsName();
    expect(TokenTags.semicolon);
    return node;
  }

  // testing-via-kinds: `signature (p: T) => R;` constrains the shape of a
  // function carrying an `appliesTo function` kind. The annotation goes
  // through the ordinary type-annotation parser, so it is exactly the Phase
  // 9.G function-value type - no separate grammar for signatures.
  function parseSignatureClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_SIGNATURE_CLAUSE);
    advance(); // signature
    node.signatureAnnotation = parseTypeAnnotation();
    if (node.signatureAnnotation?.kind !== "functionType") {
      throw parseError(
        "signature clause requires a function type, e.g. `signature (ref Run) => void;`",
        node.sourceLoc.pos,
        1,
      );
    }
    expect(TokenTags.semicolon);
    return node;
  }

  // testing-via-kinds: `enumerable as "suites";` authorizes the compiler to
  // collect every function carrying this kind into a table, and names the
  // table. The name is the join key between a kind decl and whichever driver
  // mode consumes it, so a second enumerable kind (`bench`) never collides
  // with the first.
  function parseEnumerableClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_ENUMERABLE_CLAUSE);
    advance(); // enumerable
    if (peek().tag !== TokenTags.as) {
      throw parseError(
        'enumerable clause requires a table name, e.g. `enumerable as "suites";`',
        peek().start,
        peek().length,
      );
    }
    advance(); // as
    const nameTok = expect(TokenTags.strLiteral);
    node.tableName = unquoteStringLiteral(nameTok);
    if (node.tableName.length === 0) {
      throw parseError(
        "enumerable table name must not be empty",
        nameTok.start,
        nameTok.length,
      );
    }
    expect(TokenTags.semicolon);
    return node;
  }

  // clearance kinds: `clearedBy <fn>;` on a restrictive kind names the
  // function authorized to strip the kind from a value; `appliedBy <fn>;`
  // on a conferred kind names the function authorized to confer the kind.
  // The function name is a user-chosen identifier ("expressed sentiment") -
  // the compiler bakes in no "launder" verb.
  function parseTransitionClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_TRANSITION_CLAUSE);
    const direction = transitionDirectionFromIdent();
    advance(); // consume direction ident
    node.direction = direction; // "clearedBy" | "appliedBy"
    const fnTok = expect(TokenTags.ident);
    node.functionName = src.substring(fnTok.start, fnTok.start + fnTok.length);
    expect(TokenTags.semicolon);
    return node;
  }

  // clearance kinds: `conferred;` (a capability the slot must have - lower
  // bound) or `restrictive;` (a hazard the slot must not have - upper bound).
  // A marker kind carries no obligation; its only rules are at use sites.
  function parseMarkerClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_MARKER_CLAUSE);
    const polarity = markerPolarityFromIdent();
    advance(); // consume the polarity ident
    node.polarity = polarity; // "conferred" | "restrictive"
    expect(TokenTags.semicolon);
    return node;
  }

  function parseAppliesToClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_APPLIES_TO_CLAUSE);
    expect(TokenTags.appliesTo);
    const sites = [];
    while (peek().tag !== TokenTags.semicolon && peek().tag !== TokenTags.eof) {
      const tok = peek();
      let site;
      switch (tok.tag) {
        case TokenTags.function:
          // testing-via-kinds: a function-position kind. Deliberately narrow -
          // only `signature` and `enumerable as` are legal alongside it (a
          // function kind has no value to be a `mustCall` receiver). Enforced
          // in populateKindFromClauses, not here, so the diagnostic can name
          // the offending clause.
          site = "function";
          break;
        case TokenTags.type:
          site = "type";
          break;
        case TokenTags.return:
          // clearance kinds: a marker kind may prefix a function return type.
          site = "return";
          break;
        default: {
          const name =
            tok.tag === TokenTags.ident
              ? src.substring(tok.start, tok.start + tok.length)
              : inverseTokenTags[tok.tag];
          // Contextual idents, kept usable as ordinary identifiers
          // everywhere else. `region` was always one; `binding`, `parameter`
          // and `field` were reserved words until yooperdoom-takeaways 2.2
          // pointed out they are three of the most natural parameter names in
          // a compiler, and an appliesTo list is the only place they mean
          // anything.
          //
          // A region kind governs a lexical scope rather than a named value -
          // it is used in the anonymous `<kind> EXPR { ... }` / `<kind> EXPR;`
          // block form, with no binding.
          if (
            name === "region" ||
            name === "binding" ||
            name === "parameter" ||
            name === "field"
          ) {
            site = name;
            break;
          }
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
    if (!identTextIs("scope")) {
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
    const tok = peek();
    if (tok.tag === TokenTags.acrossScopes) {
      advance();
      node.target = "acrossScopes";
    } else {
      const name =
        tok.tag === TokenTags.ident
          ? src.substring(tok.start, tok.start + tok.length)
          : inverseTokenTags[tok.tag];
      // Phase 9.J: `acrossThreads` joins `acrossScopes` as a legal target.
      // Lexes as a plain ident (no dedicated TokenTag); recognized contextually
      // here.
      if (name === "acrossThreads") {
        advance();
        node.target = "acrossThreads";
      } else {
        throw parseError(
          `unrecognized mustNotShare target '${name}'; expected 'acrossScopes' or 'acrossThreads'`,
          tok.start,
          tok.length,
        );
      }
    }
    expect(TokenTags.semicolon);
    return node;
  }

  function parseLayoutClause() {
    const node = buildSourcedNode(ASTNodeKind.KIND_LAYOUT_CLAUSE);
    expectContextual("layout");
    expect(TokenTags.lcurly);
    node.alignExpr = null;
    // Phase 8.B: opt-in marker that this layout mirrors a C struct's ABI.
    // Currently contractual only - yoop's natural struct layout already
    // matches C for trivially-aligned structs.
    node.abiC = false;
    let sawAlign = false;
    let sawAbi = false;
    while (peek().tag !== TokenTags.rcurly && peek().tag !== TokenTags.eof) {
      const tok = peek();
      if (identText(tok) === "align") {
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
      // Phase 8.B: `abi "C";` - match by ident name since `abi` isn't a
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
              `abi "${abiName}" is not a supported ABI marker - only "C" is recognized`,
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
        case TokenTags.globalState:
          cat = "globalState";
          break;
        default: {
          const name =
            tok.tag === TokenTags.ident
              ? src.substring(tok.start, tok.start + tok.length)
              : inverseTokenTags[tok.tag];
          // `io` is a contextual ident - two characters, and far too useful a
          // parameter name to reserve for one clause (yooperdoom-takeaways
          // 2.2).
          if (name === "io") {
            cat = "io";
            break;
          }
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
    expectContextual("requires");
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

    // namespace clause: `* as ns`. Yoopstore-papercut #9: a two-axis module
    // (a type plus value-level functions) can combine the namespace and a
    // named clause on one line - `import * as ns, { Type } from "..."` (or
    // the reverse order). Both clauses target the same source path; the node
    // carries both `namespaceName` and `specifiers` and importKind is
    // "combined".
    if (peek().tag === TokenTags.mult) {
      node.importKind = "namespace";
      parseNamespaceClause(node);
      if (peek().tag === TokenTags.comma) {
        advance(); // consume ,
        if (peek().tag !== TokenTags.lcurly) {
          throw parseError(
            `expected a named-import clause '{ ... }' after '* as ${node.namespaceName},'`,
            peek().start,
            peek().length,
          );
        }
        parseNamedClause(node);
        node.importKind = "combined";
      }
      expect(TokenTags.from);
      node.sourcePath = unquoteStringLiteral(expect(TokenTags.strLiteral));
      expect(TokenTags.semicolon);
      return node;
    }

    // named: import { a, b as c } from "./mod.yoop";  (optionally combined
    // with a trailing `, * as ns`.)
    if (peek().tag === TokenTags.lcurly) {
      node.importKind = "named";
      parseNamedClause(node);
      if (peek().tag === TokenTags.comma) {
        advance(); // consume ,
        if (peek().tag !== TokenTags.mult) {
          throw parseError(
            `expected a namespace clause '* as <name>' after the named import`,
            peek().start,
            peek().length,
          );
        }
        parseNamespaceClause(node);
        node.importKind = "combined";
      }
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

  // Parse `* as ns`, stamping `namespaceName` onto the import node. The `*`
  // has already been peeked (not consumed) by the caller.
  function parseNamespaceClause(node) {
    expect(TokenTags.mult); // consume *
    expect(TokenTags.as);
    node.namespaceName = parseIdentAsName();
  }

  // Parse `{ a, b as c }`, stamping `specifiers` onto the import node. The
  // `{` has already been peeked (not consumed) by the caller.
  function parseNamedClause(node) {
    node.specifiers = [];
    expect(TokenTags.lcurly); // consume {
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
  }

  function parseExportDecl() {
    expect(TokenTags.export);

    // export "C" function ...
    if (peek().tag === TokenTags.strLiteral) {
      const abiTok = advance();
      const abi = unquoteStringLiteral(abiTok);
      if (abi !== "C") {
        throw parseError(
          `unsupported export ABI "${abi}" - only "C" is supported`,
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
        // Phase 8.E: `export let|const` - same restrictions as the bare
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
      case TokenTags.variant:
        node.decl = parseVariantDecl();
        break;
      case TokenTags.enum:
        node.decl = parseEnumDecl();
        break;
      case TokenTags.union:
        node.decl = parseUnionDecl();
        break;
      default:
        // `export kind Name { ... }` - before the kind-prefixed function
        // check, since both start with an ordinary ident now.
        if (looksLikeKindDecl()) {
          node.decl = parseKindDecl();
          break;
        }
        // `export <kind> ... name(...)` - any kind-prefixed function, with
        // `function` optional per SPEC section 7. Covers `export task f()`,
        // `export async f()`, and the testing-via-kinds `export suite
        // function f()` (in a test module the driver adds the wrapper
        // itself, so that spelling is for anyone who prefers it explicit).
        if (kindPrefixedFunctionArity() > 0) {
          node.decl = parseFunctionDecl();
          break;
        }
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

    // Phase 7.1: optional type parameter list - `trait Iter<T> { ... }`.
    node.typeParams = parseTypeParamList();

    // Phase 9.J: `trait Child extends Parent[, Parent2]?`. Stored as a list
    // of type annotations (each typically a typeName or typeApplication for a
    // generic parent). Resolved into TraitTypes in typecheck pass C.1.
    node.extends = [];
    if (peek().tag === TokenTags.extends) {
      advance(); // consume `extends`
      while (true) {
        if (
          peek().tag === TokenTags.lcurly ||
          peek().tag === TokenTags.eof
        ) {
          throw parseError(
            `expected trait name after 'extends'`,
            peek().start,
            peek().length,
          );
        }
        const annot = parseTypeAnnotation();
        if (annot.kind === "refType" || annot.kind === "arrayType") {
          throw parseError(
            `extends target must be a trait name, not a ref/array type`,
            peek().start,
            peek().length,
          );
        }
        node.extends.push(annot);
        if (peek().tag === TokenTags.comma) {
          advance();
          continue;
        }
        break;
      }
    }

    expect(TokenTags.lcurly);
    node.methods = [];
    while (
      peek().tag === TokenTags.function ||
      kindPrefixedFunctionArity() > 0
    ) {
      node.methods.push(parseMethodSig());
    }

    expect(TokenTags.rcurly);
    return node;
  }

  // Phase 9.G: `vtable Name for TraitName { method: (params) => ret, ... }`.
  // Each field's type annotation must be a function-pointer type (`=>`) whose
  // signature matches the corresponding trait method minus `ref self`. The
  // implicit `ctx: unsafe_ptr<void>` first slot is added by codegen - the user
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
          `vtable field "${fieldName}" must have a function-pointer type - write '${fieldName}: (params) => Ret'`,
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
    // A trait may declare a method async; an impl has to match (checked
    // in the typechecker, so the diagnostic can name both sites).
    node.kindPrefixes = parseMethodKindPrefixes();
    applyFunctionKindPrefixes(node);
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
    if (node.abi !== "C" && node.abi !== "intrinsic") {
      throw parseError(
        `unsupported extern ABI "${node.abi}" - supported: "C", "intrinsic"`,
        abiTok.start,
        abiTok.length,
      );
    }
    expect(TokenTags.from);
    if (identTextIs("library")) {
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
      if (
        peek().tag === TokenTags.function ||
        identTextIs("async")
      )
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
    // `async function f(): T;` inside an extern "intrinsic" block - the
    // suspend primitive is declared this way. Here `async` PREFIXES
    // `function` rather than replacing it, matching how the rest of an
    // extern signature reads.
    const isAsync = identTextIs("async");
    if (isAsync) advance();
    expect(TokenTags.function);
    const node = buildSourcedNode(ASTNodeKind.EXTERN_FUNCTION_DECL);
    node.isAsync = isAsync;
    node.name = parseIdentAsName();
    // Optional type params, e.g. `function heapAlloc<T>(n: usize): T[];`.
    // Only useful inside `extern "intrinsic"` blocks where the canonical
    // builtin decl carries the real (generic) signature - the annotations
    // here are documentation. The typechecker skips resolution for canonical
    // intrinsic decls, so unresolved TypeParamType references in T[]-style
    // return types don't reach codegen.
    if (peek().tag === TokenTags.lt) {
      node.typeParams = parseTypeParamList();
    }
    expect(TokenTags.lparen);
    node.params = [];
    node.variadic = false;
    while (peek().tag !== TokenTags.rparen && peek().tag !== TokenTags.eof) {
      if (peek().tag === TokenTags.dotdotdot) {
        advance();
        node.variadic = true;
        break; // ... must be last before )
      }
      node.params.push(parseExternFunctionParam());
      if (peek().tag === TokenTags.comma) advance();
    }
    expect(TokenTags.rparen);
    expect(TokenTags.colon);
    node.returnTypeAnnotation = parseTypeAnnotation();
    expect(TokenTags.semicolon);
    return node;
  }

  // Extern function parameters: simpler than yoop-side params - no kind
  // prefixes (the C ABI has no yoop kind notion) and the name is metadata
  // (the C ABI passes positionally). Reserved keyword names are accepted so
  // a generated binding for `glVertexAttribPointer(GLenum type, ...)` doesn't
  // need a hand-edit on the `type` parameter.
  function parseExternFunctionParam() {
    const node = buildSourcedNode(ASTNodeKind.PARAM);
    node.kindPrefix = null;
    if (peek().tag === TokenTags.ref) {
      advance();
      node.isRef = true;
    } else {
      node.isRef = false;
    }
    node.name = parseIdentOrKeywordAsName();
    expect(TokenTags.colon);
    node.typeAnnotation = parseTypeAnnotation();
    if (!node.isRef && node.typeAnnotation?.kind === "refType") {
      node.isRef = true;
      node.typeAnnotation = node.typeAnnotation.inner;
    }
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
    // Arithmetic / logical unary prefixes (`-x`, `!x`, `~x`). Each builds
    // its unary node by recursing with high precedence (70) so the operand
    // captures any postfix tightly, then *falls through* to the binary +
    // assignment loop below. Returning early here was a parser bug -
    // `!a && b` would terminate after `!a` and the trailing `&& b` would
    // hit "expected semicolon, got andand" (see plans/archive/yoopbinder-papercuts.md
    // Issue 1). Chained into the same prefix if/else group as
    // `amp`/`mult`/`null` below so the trailing `else { primary chain }`
    // is only entered when no prefix matched.
    if (peek().tag === TokenTags.minus) {
      advance(); // consume the dash
      const operand = parseExpression(70);
      if (
        operand.kind === ASTNodeKind.INT_LITERAL ||
        operand.kind === ASTNodeKind.FLOAT_LITERAL
      ) {
        // Constant-fold `-<literal>` so the operand carries the negative
        // value directly.
        operand.value = -operand.value;
        node = operand;
      } else {
        const minusNode = buildSourcedNode(ASTNodeKind.UNARY_EXPRESSION);
        minusNode.op = "minus";
        minusNode.operand = operand;
        node = minusNode;
      }
    } else if (peek().tag === TokenTags.bang) {
      // Phase 9.B: prefix `!x` - logical NOT.
      advance();
      const notNode = buildSourcedNode(ASTNodeKind.UNARY_EXPRESSION);
      notNode.op = "not";
      notNode.operand = parseExpression(70);
      node = notNode;
    } else if (peek().tag === TokenTags.tilde) {
      // Phase 9: prefix `~x` - bitwise NOT. Restricted to integer
      // operands by the typechecker.
      advance();
      const bitnotNode = buildSourcedNode(ASTNodeKind.UNARY_EXPRESSION);
      bitnotNode.op = "bitnot";
      bitnotNode.operand = parseExpression(70);
      node = bitnotNode;
    } else if (peek().tag === TokenTags.ref) {
      // ref x - parse lvalue address operand with high precedence so
      // postfixes bind tightly. Returns early because `ref T` isn't an
      // operand for binary operators - the typechecker rejects it.
      advance();
      const refNode = buildSourcedNode(ASTNodeKind.REF_EXPRESSION);
      refNode.operand = parseExpression(70);
      return refNode;
    } else if (peek().tag === TokenTags.wait) {
      // wait x - task handle await; same tight precedence as ref.
      advance();
      const waitNode = buildSourcedNode(ASTNodeKind.WAIT_EXPRESSION);
      waitNode.operand = parseExpression(70);
      return waitNode;
    } else if (peek().tag === TokenTags.await) {
      // await g(...) - suspend until an async call completes. Same tight
      // precedence as ref/wait so postfixes bind to the operand.
      //
      // Distinct from `wait`: `wait h` joins an already-spawned Task<T>
      // handle, while `await` drives a coroutine inline and propagates
      // its suspension into the enclosing frame.
      advance();
      const awaitNode = buildSourcedNode(ASTNodeKind.AWAIT_EXPRESSION);
      const operand = parseExpression(70);
      // `await f(x)?` must mean `(await f(x))?` - await the call, THEN
      // propagate its error. The postfix `?` binds inside parseExpression,
      // so it lands on the call and we get `await (f(x)?)`, which is
      // backwards: it would try to propagate before the value exists and
      // then await a non-call.
      //
      // Rather than restructure the postfix loop (the `?` postfix is
      // shared by every expression form), swap the two nodes here. Same
      // fix every language with both operators needs - Rust spells it
      // `foo().await?` precisely to dodge the ambiguity.
      if (operand && operand.kind === ASTNodeKind.TRY_OP) {
        awaitNode.operand = operand.operand;
        operand.operand = awaitNode;
        return operand;
      }
      awaitNode.operand = operand;
      return awaitNode;
    } else if (peek().tag === TokenTags.amp) {
      // Phase 8.A: prefix `&x` - address-of an lvalue. Same tight precedence
      // as `ref` so postfixes bind to the operand. The `&` token also serves
      // as bitwise-AND in binary position; that's parsed by the precedence
      // climber and never reaches this primary path. We fall through to the
      // postfix + assignment check so address-of expressions still flow
      // through the usual end-of-primary path.
      advance();
      const addrNode = buildSourcedNode(ASTNodeKind.ADDRESS_OF_EXPRESSION);
      addrNode.operand = parseExpression(70);
      node = addrNode;
    } else if (peek().tag === TokenTags.mult) {
      // Phase 8.A: prefix `*p` - pointer dereference. Falls through so that
      // `*p = v` and `*p.field` work via the postfix + assignment path.
      advance();
      const derefNode = buildSourcedNode(ASTNodeKind.DEREF_EXPRESSION);
      derefNode.operand = parseExpression(70);
      node = derefNode;
    } else if (peek().tag === TokenTags.null) {
      // Phase 8.A: `null` literal. Type pinned by context.
      advance();
      node = buildSourcedNode(ASTNodeKind.NULL_LITERAL);
    } else if (peek().tag === TokenTags.intLiteral) {
      node = buildSourcedNode(ASTNodeKind.INT_LITERAL);
      node.value = advance().intVal;
    } else if (peek().tag === TokenTags.charLiteral) {
      // char literal: a single-quoted Unicode scalar. The lexer already
      // decoded it to a codepoint; lower it to an INT_LITERAL so it flows
      // through the untyped-int pinning path (`ch == '/'` against a uint8).
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
      // `unsafe_ptr.fromInt<T>(n)` - explicit type-arg intrinsics.
      // Recognized only by literal token shape so we don't have to weaken
      // the "no `<` in expression position" invariant elsewhere.
      // Phase 8.D: `errno.get()` / `errno.set(v)` / `errno.message(c)` -
      // thread-local errno bridge. Recognized as a literal token shape
      // for the same reason the `unsafe_ptr.*` namespace below is - to
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
            `unknown errno intrinsic 'errno.${opName}' - expected get / set / message`,
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
          // Phase 8.C: toArray takes a second arg - the length.
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
        fieldNode.name = parseIdentOrKeywordAsName();
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
      // Phase 9.A: parenthesized subexpression - `(a + b) * c`. Plain
      // grouping; no tuple syntax. Postfix chain (`.field`, `[i]`, `?`,
      // `(args)`) continues to apply to the inner expression.
      advance(); // consume (
      node = parseExpression();
      expect(TokenTags.rparen);
    } else if (peek().tag === TokenTags.function) {
      // A nested function declaration. Yoop has no local functions and no
      // closures, so this is not a "not yet" - it is a redirect. Without the
      // special case it reports as `unexpected token in expression: function`,
      // which reads like the parser lost its place rather than like a rule.
      //
      // The shape that hits this most is a helper inside a `suite` body, where
      // putting the helper next to the cases it serves is the natural
      // instinct (yooperdoom-takeaways 2.5).
      throw parseError(
        `functions cannot be declared inside another function body - ` +
          `move it to module scope. Yoop has no nested functions or closures.`,
        peek().start,
        peek().length,
      );
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
        // Any identifier-shaped token is accepted here (including reserved
        // keywords like `type`, `kind`, `from`) - the position is purely a
        // name lookup so the keyword's grammar role doesn't apply.
        const fieldTok = peek();
        const fieldName = parseIdentOrKeywordAsName();
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
      // phase 7.5: variant constructor - EnumName.Variant { fields }
      // Only matches IDENT.IDENT followed by `{`. Bare `EnumName.Variant`
      // (no payload) stays a FIELD_ACCESS; the typechecker promotes it.
      if (
        peek().tag === TokenTags.lcurly &&
        node.kind === ASTNodeKind.FIELD_ACCESS &&
        node.object?.kind === ASTNodeKind.IDENT &&
        (!inForInIterExpr || looksLikeVariantPayload())
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
          fieldNode.name = parseIdentOrKeywordAsName();
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
        // Phase 10.E.2 (SPEC 11 "attaching context"): an optional context
        // string after the `?`, prepended to the propagated error.
        //
        //   parseTypeParams(ref ps)? "type params"
        //   parseTypeParams(ref ps)? `type params for ${node.name}`
        //
        // Deliberately restricted to the two literal token forms rather
        // than a general expression: `f()? -x` would otherwise be
        // ambiguous with subtraction, and a string can never continue an
        // expression, so this stays a zero-lookahead decision.
        tryOpNode.context = parseTryContext();
        // Phase 10.E.3: `expr? e { ... }` - HANDLE the failure here instead
        // of propagating it. `e` names the Err payload inside the block,
        // which must diverge on every path (see diverge.js).
        //
        //   let db = sqlite.open(path)? e { return Result.Err { ... }; };
        //
        // The two-token shape `IDENT {` is what distinguishes this from the
        // context form (a string literal) - an ordinary expression can never
        // continue with a bare identifier, so this stays unambiguous. The
        // binding is REQUIRED: a bare `? { ... }` would collide with a
        // for-in body (`for x in items()? { ... }`), which is the same
        // hazard `inForInIterExpr` exists for.
        if (
          tryOpNode.context === null &&
          peek().tag === TokenTags.ident &&
          peekAhead(1).tag === TokenTags.lcurly
        ) {
          tryOpNode.handlerBinding = parseIdentAsName();
          tryOpNode.handlerBlock = parseBlock();
        }
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
        // Both bounds parse at the range operator's own precedence so the `..`
        // separating them stays visible here instead of being consumed as a
        // range value - inside brackets `i..j` is this slice, never a Range.
        let startExpr = null;
        if (peek().tag !== TokenTags.dotdot) {
          startExpr = parseExpression(RANGE_PRECEDENCE);
        }
        if (peek().tag === TokenTags.dotdot) {
          advance(); // consume ..
          const sliceNode = buildSourcedNode(ASTNodeKind.SLICE_EXPRESSION);
          sliceNode.object = node;
          sliceNode.start = startExpr;
          sliceNode.end =
            peek().tag === TokenTags.rbracket
              ? null
              : parseExpression(RANGE_PRECEDENCE);
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

    // assignment - lvalue is whatever the primary+postfix chain produced.
    // valid targets: IDENT, FIELD_ACCESS, INDEX_EXPRESSION, DEREF_EXPRESSION
    // Phase 8.A: only consume assignment at top-level expression precedence.
    // When parseExpression is called recursively (e.g. as the operand of
    // a unary `*` with minPrecedence=70), assignment must stay outside our
    // grammar - otherwise `*p = v` parses as `*(p = v)`.
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

    // Phase 9: compound assignment - `x += y`, `x -= y`, `x *= y`, `x /= y`,
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

      // `a..b` is not an arithmetic binary op - it builds a range value. The
      // node is collected on the PROGRAM so the driver can rewrite it into a
      // call to std/core/range.yoop without re-walking the AST.
      if (opToken.tag === TokenTags.dotdot) {
        if (node.kind === ASTNodeKind.RANGE_EXPR || right.kind === ASTNodeKind.RANGE_EXPR) {
          throw parseError(
            `range bounds cannot be chained - "a..b..c" has no meaning`,
            opToken.start,
            opToken.length,
          );
        }
        const rangeNode = buildSourcedNode(ASTNodeKind.RANGE_EXPR);
        rangeNode.sourceLoc = node.sourceLoc; // point at the start bound
        rangeNode.start = node;
        rangeNode.end = right;
        rangeExprs.push(rangeNode);
        node = rangeNode;
        continue;
      }

      const binNode = buildSourcedNode(ASTNodeKind.BINARY_EXPRESSION);
      binNode.op = inverseTokenTags[opToken.tag];
      binNode.left = node;
      binNode.right = right;
      node = binNode;
    }

    return node;
  }

  // Phase 10.E.2: the optional context clause on a postfix `?`. Returns the
  // context expression node, or null when the `?` has no context. Only a
  // double-quoted string or a backtick template is accepted - see the call
  // site for why this isn't a general expression.
  function parseTryContext() {
    if (peek().tag === TokenTags.strLiteral) {
      const tok = advance();
      const strNode = buildSourcedNode(ASTNodeKind.STRING_LITERAL);
      strNode.value = src.substring(tok.start, tok.start + tok.length);
      return strNode;
    }
    if (peek().tag === TokenTags.templateLiteral) {
      const tok = advance();
      const raw = src.substring(tok.start, tok.start + tok.length);
      return parseTemplateLiteralBody(raw, tok.start);
    }
    return null;
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
      case TokenTags.at: {
        // Phase 11.A: `@<name>(args?) target` attribute at statement
        // position. Body of `@precompile { ... }` etc. lives inside a
        // function body via this path.
        return parseAttribute();
      }
      case TokenTags.lcurly: {
        // A brace at STATEMENT start is a bare block, and Yoop has no such
        // statement - a block is only a statement when something introduces
        // it (a function body, `if`, a loop, a `switch` arm, a block-owning
        // kind). Without this case it falls to parseExpressionStatement and
        // is read as a STRUCT LITERAL, so `{ let x: int32 = 1; }` reports as
        // `expected colon, got ident` pointing at `x` - a complaint about a
        // struct literal the user was not writing.
        //
        // A struct literal in EXPRESSION position is unaffected: it arrives
        // through parseExpression from an initializer or argument, not from
        // here. A bare one as a statement would be a no-op anyway.
        //
        // See yooperdoom-takeaways 2.4b - whether to SUPPORT a bare block
        // (it is the natural way to scope a `disposable` tightly) is an open
        // design question. Describing it accurately is not.
        throw parseError(
          `a bare "{ ... }" block is not a statement - a block belongs to ` +
            `something: a function body, an if/else, a loop, a switch arm, ` +
            `or a block-owning kind (\`ephemeral scope(...) { ... }\`). ` +
            `If you meant a struct literal, give it a target ` +
            `(\`let x: T = { ... };\`).`,
          peek().start,
          peek().length,
        );
      }
      case TokenTags.ident: {
        // kind-prefixed binding form: `IDENT IDENT : ...` / `IDENT IDENT = ...`
        // or `IDENT(args) IDENT : ...` (phase 6.5; inferred `=` form added later).
        if (looksLikeKindPrefixedBindingStart()) {
          return parseVarDecl();
        }
        // Anonymous region-kind block: `IDENT EXPR { ... }` / `IDENT EXPR;`
        // (no binding name). Checked after the named recognizer.
        if (looksLikeAnonymousRegionStart()) {
          return parseAnonymousRegionBinding();
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

    // destructure: `let { a, b } = expr;` - only valid for non-kind-prefixed form
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
    // The type annotation is optional: when omitted, the typechecker infers
    // the binding's type from its initializer (`const testStr = "hello";`).
    if (peek().tag === TokenTags.colon) {
      advance(); // consume :
      node.typeAnnotation = parseTypeAnnotation();
    } else {
      node.typeAnnotation = null;
    }

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

    // Plain let/const path - semicolon-only is legal (no initializer).
    if (peek().tag === TokenTags.semicolon) {
      advance();
      return node;
    }
    expect(TokenTags.eq);
    node.assignment = parseExpression();
    expect(TokenTags.semicolon);
    return node;
  }

  // Anonymous region-kind binding: `KIND EXPR { ... }` (explicit block, cleanup
  // at the trailing `}`) or `KIND EXPR;` (implicit block, cleanup at enclosing
  // scope end in LIFO order - same as a name-less `disposable`). The kind must
  // resolve to a region kind (`appliesTo region`) in the typechecker; the
  // synthesized `$region$N` name is never visible to user code. We reuse the
  // CONST_DECL shape so the entire downstream pipeline (type inference, kind-
  // obligation tracking, cleanup codegen) treats it exactly like a name-less
  // kind-prefixed binding.
  function parseAnonymousRegionBinding() {
    const kindPrefix = consumeKindPrefixWithArgs();
    const node = buildSourcedNode(ASTNodeKind.CONST_DECL);
    node.kindPrefix = kindPrefix;
    node.trailingBlock = null;
    node.anonymousRegion = true;
    node.name = `$region$${anonRegionCounter++}`;
    // The type is always inferred from the initializer - there is no name to
    // annotate, and the value is unobservable anyway.
    node.typeAnnotation = null;
    node.assignment = parseExpression();
    if (peek().tag === TokenTags.lcurly) {
      node.trailingBlock = parseBlock();
    } else {
      expect(TokenTags.semicolon);
    }
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
    // A module-level binding may omit its type annotation; the typechecker
    // infers the type from the initializer. The initializer is therefore
    // mandatory - without an annotation OR a value there is nothing to bind.
    if (!decl.assignment) {
      throw parseError(
        decl.typeAnnotation
          ? "module-level binding requires an initializer (= expr)"
          : "module-level binding without a type annotation requires an initializer to infer from",
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

  function parseIfStatement() {
    expect(TokenTags.if);
    expect(TokenTags.lparen);
    const node = buildSourcedNode(ASTNodeKind.IF_STATEMENT);
    node.expression = parseExpression();
    expect(TokenTags.rparen);
    node.body = parseBlock();
    if (peek().tag === TokenTags.else) {
      advance();
      // `else if (...)` chains as a nested IF_STATEMENT in the elseBody slot.
      // `else { ... }` consumes a single block. Without the if/else if
      // discrimination here, `if (a) { ... } else { ... } if (b) { ... }`
      // (two consecutive statements) would parse as `if (a) { ... } else if
      // (b) { ... }` and silently drop the original else block.
      if (peek().tag === TokenTags.if) {
        node.elseBody = parseIfStatement();
      } else {
        node.elseBody = parseBlock();
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

    // init: `i = expr` steps a counter declared before the loop;
    // `let i = expr` / `let i: T = expr` declares one scoped TO the loop
    // (the common case - it keeps the counter from leaking into the
    // enclosing scope and drops the separate declaration line). The type
    // annotation is optional; see checkForLoop for how an omitted one is
    // inferred.
    if (peek().tag === TokenTags.const) {
      throw parseError(
        `a for-loop counter must be declared with "let" - "const" cannot be stepped`,
        peek().start,
        peek().length,
      );
    }
    node.initDeclares = peek().tag === TokenTags.let;
    if (node.initDeclares) {
      advance(); // consume `let`
    }
    node.initIdent = parseIdentAsName();
    node.initTypeAnnotation = null;
    if (node.initDeclares && peek().tag === TokenTags.colon) {
      advance(); // consume `:`
      node.initTypeAnnotation = parseTypeAnnotation();
    }
    expect(TokenTags.eq);
    node.initExpr = parseExpression();
    expect(TokenTags.semicolon);

    // cond: expr ;
    node.cond = parseExpression();
    expect(TokenTags.semicolon);

    // step: `i = expr`, or a compound form (`i += 1`) which lowers to the
    // same `i = i + expr` shape the node has always carried. The step slot
    // is an implicit assignment to `stepIdent`, so the compound operators
    // need no new node kind - and a plain-ident target can be re-read for
    // free, which is what COMPOUND_ASSIGNMENT exists to avoid elsewhere.
    node.stepIdent = parseIdentAsName();
    const stepOp = ForStepCompoundOps[peek().tag];
    if (stepOp) {
      advance(); // consume `+=` / `-=` / `*=` / `/=` / `%=`
      const counterRead = buildSourcedNode(ASTNodeKind.IDENT);
      counterRead.name = node.stepIdent;
      const binNode = buildSourcedNode(ASTNodeKind.BINARY_EXPRESSION);
      binNode.op = stepOp;
      binNode.left = counterRead;
      binNode.right = parseExpression();
      node.stepExpr = binNode;
    } else {
      expect(TokenTags.eq);
      node.stepExpr = parseExpression();
    }

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
    // The RHS runs to the loop body's `{`, so a trailing `IDENT.IDENT` path
    // must not swallow that brace as a variant payload - see inForInIterExpr.
    const savedForIn = inForInIterExpr;
    inForInIterExpr = true;
    try {
      node.iterExpr = parseExpression();
    } finally {
      inForInIterExpr = savedForIn;
    }
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
  // SPEC section 7. A function decl is an optional run of kind prefixes,
  // then an optional `function` keyword, then the name. At least one of the
  // two must be present:
  //
  //     function foo(...)                 // no prefixes
  //     task foo(...)                     // prefix, `function` dropped
  //     task function foo(...)            // both - equivalent
  //     async disposable openRemote(...)  // stacked prefixes
  //
  // Which prefixes are legal here is a typecheck question (each must name a
  // kind whose appliesTo includes `function`), so the parser records them
  // verbatim on `node.kindPrefixes`.
  function parseFunctionDecl() {
    const prefixCount = kindPrefixedFunctionArity();
    const kindPrefixes = [];
    for (let i = 0; i < prefixCount; i++) {
      const tok = peek();
      kindPrefixes.push({
        name: parseIdentAsName(),
        sourceLoc: posToSourceLocation(src, tok.start),
      });
    }
    // `function` is optional once a prefix is present, required otherwise.
    if (peek().tag === TokenTags.function) {
      advance();
    } else if (prefixCount === 0) {
      expect(TokenTags.function);
    }
    const node = parseFunctionDeclBody();
    node.kindPrefixes = kindPrefixes;
    applyFunctionKindPrefixes(node);
    return node;
  }

  // The parser cannot resolve kinds - that happens in the typechecker, which
  // also asserts these names are the required-core kinds declared in
  // std/core/kinds.yoop. What it can do is record the shape, so the flags the
  // rest of the pipeline already reads stay populated.
  //
  // A `task` body is implicitly async: a task IS the scheduler's unit of
  // work, so it is exactly where a suspend can land, and writing
  // `async task` would be noise.
  const CORE_FUNCTION_KINDS = new Set(["task", "async"]);
  function applyFunctionKindPrefixes(node) {
    const prefixes = node.kindPrefixes ?? [];
    const names = prefixes.map((k) => k.name);
    node.isTask = names.includes("task");
    node.isAsync = node.isTask || names.includes("async");
    // `kindPrefix` (singular) is what the enumerable-kind machinery reads
    // (`suite function addsNumbers()`); the core concurrency kinds ride the
    // flags above instead, so they must not occupy that slot.
    const userPrefix = prefixes.find((k) => !CORE_FUNCTION_KINDS.has(k.name));
    if (userPrefix) node.kindPrefix = userPrefix;
  }

  function parseFunctionDeclBody() {
    const node = buildSourcedNode(ASTNodeKind.FUNCTION_DECL);
    node.isTask = false;
    node.name = parseIdentAsName();
    // Phase 7.1: optional type parameter list - `function map<T, U>(...)`.
    node.typeParams = parseTypeParamList();
    expect(TokenTags.lparen);
    node.params = [];
    // params can start with: ident (name, or a kind prefix like `pooled`),
    // ref (modifier), or comma (separator).
    while (
      peek().tag === TokenTags.ident ||
      peek().tag === TokenTags.ref ||
      peek().tag === TokenTags.comma ||
      atReservedUsedAsName()
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
    // Phase 7.1: optional type parameter list - `type Box<T> { ... }`.
    node.typeParams = parseTypeParamList();

    // Phase 6.5: optional single kind prefix on the type declaration,
    // e.g. `type Vec4 aligned(32) implements Disposable { ... }`.
    // Detected when the next token is an IDENT that is NOT `implements` and
    // is not the start of a propagates/contains clause - i.e. an IDENT
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
          isPropagationClauseStart(after) ||
          after.tag === TokenTags.lcurly ||
          after.tag === TokenTags.eq
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
      while (isIdentLikeTag(peek().tag)) {
        // `function NAME(...)` is a method decl. `function: T` is a field
        // whose name happens to be `function` - disambiguate via the trailing
        // colon. Reserved keywords are accepted as field names so C-style
        // names like `type`, `kind`, `enum` don't collide with the grammar.
        if (
          (peek().tag === TokenTags.function &&
            peekAhead(1).tag !== TokenTags.colon) ||
          kindPrefixedFunctionArity() > 0
        ) {
          node.methods.push(parseMethodDecl());
          continue;
        }
        const fieldNode = buildSourcedNode(ASTNodeKind.FIELD_DECL);
        fieldNode.name = parseIdentOrKeywordAsName();
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
      expect(TokenTags.rcurly);
    } else {
      // Transparent type alias: `type Name = <type annotation>;`. The RHS is a
      // full type annotation, parsed identically to any other type position, so
      // `type Bytes = uint8[];` and `type IdList = NodeId[];` work out of the
      // box. The alias has no distinct identity in the typechecker - it resolves
      // to the underlying type at every use site (indexing, coercion, etc. need
      // no special casing). Storing the parsed annotation (not a bare name) also
      // leaves room for a future `A & B` / `A | B` type-expression RHS without
      // reshaping the AST node.
      expect(TokenTags.eq);
      node.targetType = parseTypeAnnotation();
      expect(TokenTags.semicolon);
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

  // Phase 7.5 (renamed in Phase 12): variant declaration - tagged sum type.
  //   variant Name<TParams?> implements (T, U)? propagates<K>? contains<K>? {
  //       Case1 { f: T, ... },
  //       Case2,
  //       function method(ref self, ...): R { ... },
  //       ...
  //   }
  // Phase 13.B: variants can now implement traits and declare propagates /
  // contains clauses, mirroring `type` decls. The body interleaves variant
  // cases and method bodies; methods are only legal when the variant
  // declares an `implements` clause.
  function parseVariantDecl() {
    expect(TokenTags.variant);
    const node = buildSourcedNode(ASTNodeKind.VARIANT_DECL);
    node.name = parseIdentAsName();
    node.typeParams = parseTypeParamList();

    // Phase 13.B: implements clause - same shape as `parseTypeDecl`.
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

    // Phase 13.B: optional `propagates<...>` / `contains<...>` clauses.
    parsePropagationClauses(node);

    node.variants = [];
    node.methods = [];
    expect(TokenTags.lcurly);
    const seenNames = new Set();
    while (isIdentLikeTag(peek().tag)) {
      // `function NAME(...)` is a method decl. A keyword-as-case-name like
      // `function` is followed by `{` (payload), `,`, or `}` - never `(`. We
      // use the trailing `(` to disambiguate, mirroring how struct bodies
      // distinguish `function name(...)` (method) from `function: T` (field).
      if (
        (peek().tag === TokenTags.function &&
          peekAhead(1).tag !== TokenTags.lcurly &&
          peekAhead(1).tag !== TokenTags.comma &&
          peekAhead(1).tag !== TokenTags.rcurly) ||
        kindPrefixedFunctionArity() > 0
      ) {
        node.methods.push(parseMethodDecl());
        continue;
      }
      const varTok = peek();
      const variant = buildSourcedNode(ASTNodeKind.VARIANT_CASE);
      variant.name = parseIdentOrKeywordAsName();
      if (seenNames.has(variant.name)) {
        throw parseError(
          `duplicate case name '${variant.name}' in variant '${node.name}'`,
          varTok.start,
          varTok.length,
        );
      }
      seenNames.add(variant.name);
      if (peek().tag === TokenTags.lcurly) {
        // payload variant - { field: Type, ... }
        advance(); // consume {
        variant.fields = [];
        while (isIdentLikeTag(peek().tag)) {
          const fieldNode = buildSourcedNode(ASTNodeKind.FIELD_DECL);
          fieldNode.name = parseIdentOrKeywordAsName();
          expect(TokenTags.colon);
          fieldNode.typeAnnotation = parseTypeAnnotation();
          fieldNode.kindPrefix = null;
          variant.fields.push(fieldNode);
          if (peek().tag === TokenTags.comma) advance();
        }
        expect(TokenTags.rcurly);
        if (variant.fields.length === 0) {
          throw parseError(
            `variant '${variant.name}' has empty payload braces - write '${variant.name}' for a no-payload variant`,
            varTok.start,
            varTok.length,
          );
        }
      } else {
        // no-payload variant
        variant.fields = null;
        // Phase 13.D: `Special MyType` is NOT payload syntax - a case payload
        // is always a record. Without this check the case name and the type
        // silently parse as TWO payload-less cases (`Special` and `MyType`),
        // since the separating comma is optional; nothing errors at the decl
        // and the only symptom is a phantom "missing variants: MyType" from a
        // later exhaustiveness check, pointing at a `switch` rather than here.
        //
        // A plain IDENT is the only ambiguous follower: a method decl starts
        // with the `function` keyword, and a real next case is comma-separated
        // in every existing shape.
        if (peek().tag === TokenTags.ident) {
          const nextTok = peek();
          const nextText = src.substring(
            nextTok.start,
            nextTok.start + nextTok.length,
          );
          throw parseError(
            `variant case '${variant.name}' is followed by '${nextText}' with no separator - a case payload must be a record, e.g. '${variant.name} { value: ${nextText} }'; if these are two separate cases, put a comma between them`,
            nextTok.start,
            nextTok.length,
          );
        }
      }
      node.variants.push(variant);
      if (peek().tag === TokenTags.comma) advance();
    }
    expect(TokenTags.rcurly);
    if (node.variants.length === 0) {
      throw parseError(
        `variant '${node.name}' must declare at least one case`,
        node.sourceLoc.pos,
        1,
      );
    }
    if (node.methods.length > 0 && node.implements.length === 0) {
      throw parseError(
        `methods are only allowed inside an 'implements' block - variant "${node.name}" has methods but no 'implements' clause`,
        peek().start,
        peek().length,
      );
    }
    return node;
  }

  // Phase 12: value enum declaration - C-style named primitive constants.
  //   enum Name { Case1, Case2 (value)?, ... }            // default int32
  //   enum Name<int64> { Case 0 }
  //   enum Name<string> { Asc "A", Desc "D" }
  // The `<T>` slot after the name is a single primitive selector
  // (int*/uint*/string), not a generic type parameter list. Generic sum
  // types stay on `variant`. Value expressions are full yoop expressions;
  // the const-evaluator in constEvalEnum.js validates the allowed shape at
  // typecheck time (literals, prior-case refs, bitwise ops).
  function parseEnumDecl() {
    expect(TokenTags.enum);
    const node = buildSourcedNode(ASTNodeKind.ENUM_DECL);
    node.name = parseIdentAsName();
    // Optional `<UnderlyingType>` slot. Defaults to int32 when absent.
    // Reused from the generics slot position: value enums aren't generic, so
    // putting the underlying primitive selector here parallels how the slot
    // reads for `variant Foo<T>`.
    if (peek().tag === TokenTags.lt) {
      advance(); // consume <
      node.underlying = parseTypeAnnotation();
      // Reject multi-arg form: `enum X<int32, int64>` is meaningless. Bail
      // before consuming the closing > so the diagnostic anchors on the
      // comma's token.
      if (peek().tag === TokenTags.comma) {
        throw parseError(
          `value enum '${node.name}' takes a single underlying type, not a type-arg list - use 'variant' for generic sum types`,
          peek().start,
          peek().length,
        );
      }
      consumeClosingGt();
    } else {
      node.implements = [];
      node.underlying = { kind: "typeName", name: "int32" };
      // check if implements?
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
    }
    node.cases = [];
    node.methods = [];
    expect(TokenTags.lcurly);
    const seenNames = new Set();
    while (isIdentLikeTag(peek().tag)) {
      // if enum is impl functions
      if (
        (peek().tag === TokenTags.function &&
          peekAhead(1).tag !== TokenTags.colon) ||
        kindPrefixedFunctionArity() > 0
      ) {
        node.methods.push(parseMethodDecl());
        continue;
      }
      // else...
      const caseTok = peek();
      const caseNode = buildSourcedNode(ASTNodeKind.ENUM_CASE);
      caseNode.name = parseIdentOrKeywordAsName();
      if (seenNames.has(caseNode.name)) {
        throw parseError(
          `duplicate case name '${caseNode.name}' in enum '${node.name}'`,
          caseTok.start,
          caseTok.length,
        );
      }
      seenNames.add(caseNode.name);
      // Optional value expression. Anything that's not `,` or `}` is treated
      // as the start of an expression. The const-evaluator validates the
      // permitted operator set.
      if (peek().tag !== TokenTags.comma && peek().tag !== TokenTags.rcurly) {
        caseNode.valueExpr = parseExpression(0);
      } else {
        caseNode.valueExpr = null;
      }
      node.cases.push(caseNode);
      if (peek().tag === TokenTags.comma) advance();
    }
    expect(TokenTags.rcurly);
    if (node.cases.length === 0) {
      throw parseError(
        `enum '${node.name}' must declare at least one case`,
        node.sourceLoc.pos,
        1,
      );
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

  // Phase 7.5: union declaration - untagged overlapping-memory aggregate.
  //   union Name { field: Type, ... }
  function parseUnionDecl() {
    expect(TokenTags.union);
    const node = buildSourcedNode(ASTNodeKind.UNION_DECL);
    node.name = parseIdentAsName();
    // Reject generics on unions - deferred (see plans/phase-7-5-sum-types-and-unions.md).
    if (peek().tag === TokenTags.lt) {
      throw parseError(
        `generic unions are not yet supported (deferred)`,
        peek().start,
        peek().length,
      );
    }
    // Reject `implements` on unions - deferred.
    if (peek().tag === TokenTags.implements) {
      throw parseError(
        `union types cannot implement traits in this phase (deferred)`,
        peek().start,
        peek().length,
      );
    }
    node.fields = [];
    expect(TokenTags.lcurly);
    while (isIdentLikeTag(peek().tag)) {
      const fieldNode = buildSourcedNode(ASTNodeKind.FIELD_DECL);
      fieldNode.name = parseIdentOrKeywordAsName();
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
        `empty switch - must have at least one case or default`,
        node.sourceLoc.pos,
        1,
      );
    }
    return node;
  }

  // Phase 7.5: parse a single arm pattern. Accepts:
  //   - INT_LITERAL / CHAR_LITERAL / BOOL_LITERAL        → LITERAL_PATTERN
  //   - `_`                                              → VARIANT_PATTERN { isWildcard: true }
  //   - IDENT.IDENT { fieldBindings? }                   → VARIANT_PATTERN
  //   - IDENT.IDENT                                      → VARIANT_PATTERN (no-payload form)
  // (Char literals lower to int-valued LITERAL_PATTERNs - their codepoint;
  // reject string and float literals at pattern position with explicit
  // diagnostics.)
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
    if (tok.tag === TokenTags.intLiteral || tok.tag === TokenTags.charLiteral) {
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
      const variantName = parseIdentOrKeywordAsName();
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
            // bare _ inside braces - placeholder field-ignore (positional-style)
            const dtok = advance();
            fb.fieldName = null;
            fb.bindingName = null;
            fb.isWildcard = true;
            fb.sourceLoc = posToSourceLocation(src, dtok.start);
          } else {
            const fnameTok = peek();
            if (!isIdentLikeTag(fnameTok.tag)) {
              throw parseError(
                `expected ident, got ${inverseTokenTags[fnameTok.tag]}`,
                fnameTok.start,
                fnameTok.length,
              );
            }
            fb.fieldName = parseIdentOrKeywordAsName();
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
                // The rename target is a new local binding, so it must be a
                // plain ident - reserved words would shadow grammar roles in
                // the case body.
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
    // `async NAME(ref self, ...)` is an async method, the same way `async
    // NAME(...)` is an async free function - the keyword REPLACES
    // `function`.
    node.kindPrefixes = parseMethodKindPrefixes();
    applyFunctionKindPrefixes(node);
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

  // Reserved words a user is most likely to reach for as a name, with the
  // reason each one has to stay reserved. These three carry real grammar in
  // positions where an identifier is also legal, so unlike `kind` / `field` /
  // `io` (yooperdoom-takeaways 2.2) they cannot be made contextual.
  const RESERVED_NAME_HINTS = {
    in: "it separates the two halves of `for x in xs`",
    from: "it introduces the path in `import ... from` and `extern ... from`",
    as: "it names the binding in `import * as ns`",
  };

  // True when the current token is a reserved word sitting where a parameter
  // NAME belongs (`f(in: int32)`, `f(x, from)`). The param-list loops stop on
  // any non-ident, so without this the failure surfaces as `expected rparen,
  // got in` - which describes the parser's state, points at a word the reader
  // has stopped seeing as a word, and says nothing about what to do. Entering
  // the loop anyway lets parseIdentAsName report it properly.
  function atReservedUsedAsName() {
    if (!keywordTagSet.has(peek().tag)) return false;
    const after = peekAhead(1).tag;
    return (
      after === TokenTags.colon ||
      after === TokenTags.comma ||
      after === TokenTags.rparen
    );
  }

  function parseIdentAsName() {
    // Without this, a reserved word in name position reports as `expected
    // ident, got in`, which describes the parser's state rather than the
    // user's mistake - and the word is often several lines from where the
    // reader is looking. Naming it is most of the fix.
    if (keywordTagSet.has(peek().tag)) {
      const tok = peek();
      const word = src.substring(tok.start, tok.start + tok.length);
      const hint = RESERVED_NAME_HINTS[word];
      throw parseError(
        `"${word}" is a reserved word and cannot be used as a name` +
          (hint ? ` (${hint})` : "") +
          `. Pick a different name.`,
        tok.start,
        tok.length,
      );
    }
    const identTok = expect(TokenTags.ident);
    const name = src.substring(
      identTok.start,
      identTok.start + identTok.length,
    );

    return name;
  }

  // Like parseIdentAsName, but also accepts any reserved keyword token and
  // returns its source text. Used in positions where the name is metadata
  // (struct / variant / union / enum case + field decls, extern function
  // parameter names, the RHS of `.`, and struct-literal field names) so the
  // growing keyword set doesn't block common C-style names like `type`,
  // `kind`, `enum`. The keyword's grammar role does not apply in these
  // positions - they are syntactically unambiguous.
  function parseIdentOrKeywordAsName() {
    const tok = peek();
    if (!isIdentLikeTag(tok.tag)) {
      throw parseError(
        `expected ident, got ${inverseTokenTags[tok.tag]}`,
        tok.start,
        tok.length,
      );
    }
    advance();
    return src.substring(tok.start, tok.start + tok.length);
  }

  function parseBlock() {
    expect(TokenTags.lcurly);
    const node = buildSourcedNode(ASTNodeKind.BLOCK);
    node.body = [];

    // parse rest of statements
    while (peek().tag !== TokenTags.rcurly && peek().tag !== TokenTags.eof) {
      // `startLoc` is the statement's FIRST token, which `sourceLoc` is not:
      // buildSourcedNode stamps `pos`, and `pos` is the offset PAST the
      // lookahead token, so a statement built after consuming a token or two
      // (`return 1;` -> the `;`, `let x: T` -> the `:`) points into its own
      // middle. Good enough to name a line, useless as the start of a span.
      // The unreachable-code warning needs a real one, so capture it here
      // where the token is still in hand. Only blocks get this - it is the
      // one place a statement list has a span to describe.
      const startTok = peek();
      const stmt = parseStatement();
      stmt.startLoc = posToSourceLocation(src, startTok.start);
      node.body.push(stmt);
    }

    // Offset of the closing `}`, so a span can be measured to the end of the
    // block rather than to the end of some statement (statements record no
    // end position at all).
    node.endPos = peek().start;
    expect(TokenTags.rcurly);

    return node;
  }

  return parseTopLevel();
}
