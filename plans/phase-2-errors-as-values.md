# Phase 2 — Errors as values

Part of the [roadmap](./roadmap.md). Phase 1 landed structs and a real type system. This phase turns "a struct with an `err: string` field" into a first-class compiler concept and adds the postfix `?` operator on top of it, plus the destructuring sugar that makes the syntax livable. No new types — fallible-ness is a *predicate* on existing struct types.

## Goal

Land a working subset of [SPEC.md §11 — Errors as values](../SPEC.md):

```yoop
type Bytes  { len: int32, err: string, }
type Config { id: int32, err: string, }

function read_all(path: string): Bytes {
    if (path.len == 0) {
        return { len: 0, err: "empty path" };
    }
    return { len: 42, err: "" };
}

function load_config(path: string): Config {
    const b = read_all(path)?;          // bail on error, otherwise b: int32 (Bytes minus err)
    return { id: b, err: "" };
}

function main(): int32 {
    const { id, err } = load_config("foo.cfg");
    if (err.len > 0) {
        printf(`err: ${err}\n`);
        return 1;
    }
    printf(`id = ${id}\n`);
    return 0;
}
```

Concretely:
- A struct type is **fallible** iff its fields end with `err: string`. Detection lives in the typechecker, not in the syntax.
- `expr?` parses as a postfix operator, type-checks against fallible expr + fallible enclosing fn, and codegens to an early-return on error.
- `const { a, err } = f()` parses as destructuring, type-checks all observed fields exist on the source struct, and lowers to a temp + per-field reads.
- The compiler refuses any of these slip-ups: bare `f();` on a fallible call, `const { a } = f()` that omits `err`, `const r = f()` whose `r.err` is never read before scope exit, `?` in a function whose return type has no `err: string`.
- `_ = f();` is the explicit-discard escape hatch (kinds-aware variant comes in Phase 6 — for now this phase accepts `_ =` unconditionally).

## Why this is next

Errors as values are a recognizable convention (`err: string` field) plus the `?` operator. They need structs (Phase 1.3 — done) but not traits, kinds, or refs. They exercise the typechecker hard — the new analyses are *flow-sensitive* (was `r.err` read before scope exit?) and *return-shape-aware* (does the enclosing function return a fallible type?). Getting this in before Phase 3 (modules / FFI) means real-world programs that need to call `fopen` / `fread` / etc. through Phase 3's externs already have a working error idiom waiting for them.

## Scope (what this phase does NOT do)

- **No `?` context suffix** — `read_all(path)? "loading config"` is reserved syntax in the spec; not in v0.
- **No multi-field strip values that aren't immediately destructured.** `let s = fetch()?;` where `fetch` returns `{ data, meta, err }` would need an anonymous struct type for `s`. Destructure or strip-to-single-field in this phase; reject the rest with a clear error. (See §6.d.)
- **No early `?` inside expressions in branches that don't reach a `return`** — the rewrite always inserts a return at the failure path, full stop. No try/catch shape.
- **No kind-aware discard.** `_ = f()` is permitted unconditionally. Phase 6 tightens this so only `mustCall`/disposable kinds reject it.
- **No nested-fallible default synthesis.** `default(Config)` for a `Config` whose first field is itself a fallible struct walks all the way down using zero values; this lands. But there is no ergonomic `default()` user-callable function — purely compiler-internal.
- **No `?` on chained / curried tasks** (`wait h?`) — Phase 6 (kinds + Task<T>).
- **No `?` on non-call expressions that *happen* to be fallible-typed** — actually, this lands: `?` is legal on any expression whose static type is fallible. The spec is explicit. So a value-typed local works: `const r = read_all(p); const v = r?;` — but the observation rule still applies to `r` (this just happens to satisfy it via the `?`).

---

## Status snapshot

Nothing for Phase 2 has been built yet. Phase 1.3 is complete:
- Structs parse, typecheck, and codegen.
- The typechecker has `pinStructLiteral`, `checkInitializer`, nominal struct equality, recursive-struct detection.
- Codegen emits `%struct.X = type {...}` declarations, handles GEP-based reads/writes, struct return-by-value, struct call args.

What this phase adds, ordered by where it slots into the pipeline:

1. **Lexer**: a single new token (`question` for `?`).
2. **Parser**: postfix `?`, destructuring `const { a, b } = expr;`, and `_ = expr;` discard.
3. **AST**: three new node kinds (`TRY_OP`, `DESTRUCTURE_DECL`, `DISCARD_STATEMENT`).
4. **Typechecker**: fallible-type predicate, `?` operator typecheck, destructure typecheck, scope-exit observation analysis.
5. **Codegen**: `?` lowering with `default + propagate` early return, destructure lowering to a temp + N field reads.

---

## Files touched

- [src/contracts.js](../src/contracts.js) — new AST kinds.
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — `?` token.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — postfix `?`, destructuring `let`/`const`, `_ = ...` statement.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) — `isFallible(structType)` helper. Also a pure helper `strippedTypeOf(structType)` returning the `?`'s yielded Type.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) — `resolveTryOp`.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js) — destructuring decl, discard, observation tracking on scope exit.
- [src/jsyooptypecheck/scope.js](../src/jsyooptypecheck/scope.js) — extend bindings with an `errObserved: bool` flag and an iterator over scope contents on pop.
- New file [src/jsyooptypecheck/fallible.js](../src/jsyooptypecheck/fallible.js) — `isFallible`, `strippedTypeOf`, `defaultStructLiteralFor`. Pure helpers, easy to unit-test.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — `TRY_OP` lowering, default-struct emit, destructure lowering, discard lowering.
- [src/e2e.test.js](../src/e2e.test.js) — new pass + fail fixtures (see §10).
- [examples/pass/](../examples/pass/) — three new programs (§10.1).
- [examples/fail/](../examples/fail/) — six new programs (§10.2).

---

## 1. AST node kinds ([contracts.js](../src/contracts.js))

Add:

```js
TRY_OP: "TRY_OP",                          // postfix `?` — { operand: ASTNode, sourceLoc }
DESTRUCTURE_DECL: "DESTRUCTURE_DECL",      // const { a, b } = expr; — { kind: "let"|"const", names: [{ name, sourceLoc }], assignment, sourceLoc }
DISCARD_STATEMENT: "DISCARD_STATEMENT",    // _ = expr; — { value: ASTNode, sourceLoc }
```

Why three new kinds rather than reusing existing ones:

- `TRY_OP` is *not* a unary expression — its semantics insert a control-flow edge (early return). Tagging it explicitly keeps codegen and typecheck honest. Modeling as `UNARY_EXPRESSION { op: "try" }` would invite the binary loop or the resolveUnary path to accidentally handle it.
- `DESTRUCTURE_DECL` mirrors `LET_DECL` / `CONST_DECL` shape but with `names: [string]` instead of a single `name`. We can't reuse `LET_DECL` because the typechecker pre-walk for "fallible binding observation" needs to see this as one statement that introduces N bindings.
- `DISCARD_STATEMENT` is needed because `_` isn't a valid lvalue — if we tried to treat it as `ASSIGNMENT { target: IDENT { name: "_" }, value: ... }` the assignment-resolver would try to look `_` up in scope.

---

## 2. Lexer changes ([lexer.js](../src/jsyooplexer/lexer.js))

One new token:

```js
TokenTags.question: 40,                    // ?
```

Add to `tokenScanList`:

```js
{ str: "?", tag: TokenTags.question },
```

The list is re-sorted by length, so it'll land in the right position automatically. No new scanner logic — single-char punctuation.

> **Note on `??`**: the spec does not use `??`. Don't pre-add it; we'll get a misleading error for `??` instead of a "near-miss" suggestion, which is fine.

---

## 3. Parser changes ([parser.js](../src/jsyooparser/parser.js))

### 3.a Postfix `?`

Slot into the postfix loop right after the field-access loop at [parser.js:204-217](../src/jsyooparser/parser.js#L204-L217). The loop is the natural place: postfix `?` is left-associative, binds tighter than binary ops, and chains with field access.

```js
while (true) {
  if (peek().tag === TokenTags.dot) { ... }
  if (peek().tag === TokenTags.question) {
    advance(); // consume '?'
    const tryNode = buildSourcedNode(ASTNodeKind.TRY_OP);
    tryNode.operand = node;
    node = tryNode;
    continue;
  }
  break;
}
```

This means `f().a?` parses as `((f()).a)?`, and `f()?.a` parses as `((f())?).a`. The latter is allowed by the grammar but the typechecker rejects it for now (the stripped type from `?` may not have `.a`). Both are syntactically valid; semantic rejection happens later.

**Critical**: the `?` postfix must run *before* the assignment branch at [parser.js:219-236](../src/jsyooparser/parser.js#L219-L236). After `?`, the resulting node is `TRY_OP`, which is not a valid lvalue, so `r? = 5` fails the lvalue check. Correct outcome.

### 3.b Destructuring `let { ... } = ...;` / `const { ... } = ...;`

Replace `parseVarDecl` ([parser.js:357-389](../src/jsyooparser/parser.js#L357-L389)) so it dispatches on what follows `let` / `const`:

```js
function parseVarDecl() {
  const varToken = advance();
  const declKind = (varToken.tag === TokenTags.let)
    ? ASTNodeKind.LET_DECL
    : ASTNodeKind.CONST_DECL;

  if (peek().tag === TokenTags.lcurly) {
    return parseDestructureDecl(varToken, declKind);
  }
  // ... existing body unchanged
}

function parseDestructureDecl(varToken, declKind) {
  const node = buildSourcedNode(ASTNodeKind.DESTRUCTURE_DECL);
  node.declKind = declKind;     // "LET_DECL" | "CONST_DECL"
  node.names = [];
  expect(TokenTags.lcurly);
  while (peek().tag === TokenTags.ident) {
    const tok = advance();
    node.names.push({
      name: src.substring(tok.start, tok.start + tok.length),
      sourceLoc: posToSourceLocation(src, tok.start),
    });
    if (peek().tag === TokenTags.comma) advance(); // trailing comma OK
  }
  expect(TokenTags.rcurly);
  expect(TokenTags.eq);
  node.assignment = parseExpression();
  expect(TokenTags.semicolon);
  return node;
}
```

Notes:
- No declared *type* on the destructure (`const { a, err }: Foo = ...` — not legal). The source type comes from the RHS.
- Disallow renaming sugar (`{ data: d, err: e }`) — not in scope.
- Disallow nested destructuring (`{ outer: { inner } }`) — not in scope.

### 3.c Discard `_ = expr;`

`_` already lexes as `TokenTags.discard`. Add a pre-check at the top of `parseStatement` ([parser.js:325-346](../src/jsyooparser/parser.js#L325-L346)):

```js
function parseStatement() {
  if (peek().tag === TokenTags.discard) {
    return parseDiscardStatement();
  }
  // ... existing dispatch unchanged
}

function parseDiscardStatement() {
  expect(TokenTags.discard);
  expect(TokenTags.eq);
  const node = buildSourcedNode(ASTNodeKind.DISCARD_STATEMENT);
  node.value = parseExpression();
  expect(TokenTags.semicolon);
  return node;
}
```

Discard appears only as a statement, never as an expression. `let x = _ = f();` is not legal — that's intentional (the spec wording is "`_ = f();`" — a statement form).

---

## 4. Typechecker — fallible helpers ([fallible.js](../src/jsyooptypecheck/fallible.js))

New file. Pure functions, no side effects, easy to unit-test.

```js
import { typeKinds, primAnnotations, PrimType, StructType, VoidType } from "./types.js";

// A struct type is fallible iff its fields end with `err: string`.
// (Per spec §11: trailing `err: string` is the marker.)
export function isFallible(t) {
  if (!t || t.kind !== typeKinds.struct) return false;
  const fields = t.fields ?? [];
  if (fields.length === 0) return false;
  const last = fields[fields.length - 1];
  if (last.name !== "err") return false;
  if (last.type.kind !== typeKinds.prim) return false;
  if (last.type.name !== primAnnotations.string) return false;
  return true;
}

// What `expr?` yields when `expr` has type t.
//   - { value: T, err: string }                  -> T
//   - { f1: T1, f2: T2, ..., err: string }       -> StructType (anonymous, see §6.d)
//   - { err: string }                            -> void
//   - non-fallible                               -> null  (caller pushes the right error)
export function strippedTypeOf(t) {
  if (!isFallible(t)) return null;
  const nonErr = t.fields.slice(0, -1);
  if (nonErr.length === 0) return VoidType();
  if (nonErr.length === 1) return nonErr[0].type;
  // Multi-field strip — needs an anonymous struct. Phase 2 returns a tagged
  // sentinel so callers can reject this in non-destructure contexts.
  return { kind: "strippedMulti", fields: nonErr, sourceName: t.name };
}

// Synthesize a STRUCT_LITERAL AST node that zero-initializes every non-err
// field of `structType`, then sets err to the given errExpr (an AST node).
// Used by the `?` lowering: `return { ...default(EnclosingReturnType), err: _tmp.err };`
export function defaultStructLiteralFor(structType, errExprNode, sourceLoc) {
  // returns an AST node — see §6.b for the exact shape.
}
```

`strippedTypeOf` returning a non-`Type` sentinel for the multi-field case is a deliberate ugly: it forces every caller to handle the case. Callers either:
- Allow it and immediately destructure — fine.
- Reject it: "multi-field `?` result must be destructured."

Once Phase 6/7 brings in proper anonymous structs we can revisit. For now the constraint is small and the error message is clear.

---

## 5. Typechecker — `TRY_OP` ([checkExpr.js](../src/jsyooptypecheck/checkExpr.js))

Add a new case to `resolveExprType`'s switch ([checkExpr.js:57-90](../src/jsyooptypecheck/checkExpr.js#L57-L90)):

```js
case ASTNodeKind.TRY_OP:
  return resolveTryOp(node, scope, ctx);
```

Implementation:

```js
function resolveTryOp(node, scope, ctx) {
  const operandType = resolveExprType(node.operand, scope, ctx);
  if (operandType.kind === typeKinds.error) {
    return setType(node, ErrorType());
  }
  if (!isFallible(operandType)) {
    pushError(
      ctx.errors,
      node,
      `'?' applied to non-fallible type ${formatType(operandType)} — only structs ending in 'err: string' are fallible`,
    );
    return setType(node, ErrorType());
  }
  if (!isFallible(ctx.funcReturnType)) {
    pushError(
      ctx.errors,
      node,
      `'?' is only legal inside a function that returns a fallible type; '${ctx.funcName}' returns ${formatType(ctx.funcReturnType)}`,
    );
    return setType(node, ErrorType());
  }

  const stripped = strippedTypeOf(operandType);
  // strippedTypeOf returns either a Type, VoidType, or { kind: "strippedMulti", ... }
  if (stripped && stripped.kind === "strippedMulti") {
    // Allowed iff the parent context is a DESTRUCTURE_DECL — checked by the
    // caller (see checkDestructureDecl in §6.c). Mark the node so the caller
    // can find it without re-running the analysis.
    node.strippedMulti = stripped;
    return setType(node, ErrorType());  // "error" suppresses cascades; the
                                         // caller upgrades this to a real
                                         // type if it permits multi-strip.
  }
  return setType(node, stripped);
}
```

The "error type as a temporary placeholder" trick reuses the existing cascade-suppression: any further use of this `?` value flows through `isAssignable`'s error-type passthrough and produces no extra noise. The destructure path notices `node.strippedMulti` and upgrades.

**The `?` mark on the binding (used by §6 observation tracking)**: when `?` is applied to an expression whose root is an IDENT or chain rooted in one (e.g. `r?` or `r.field?`), the root binding's `errObserved` flag should be flipped. See §6.e — this is a sibling concern handled there, not here.

---

## 6. Typechecker — statements that bind fallible values

The shape of all the statement-level work: when a fallible-typed expression appears as the RHS of a binding, the binding gets an `errObserved` flag attached. When the scope pops, walk every binding; for any fallible binding whose `errObserved` is false, push an error.

### 6.a Extending bindings — [scope.js](../src/jsyooptypecheck/scope.js)

Add `errObserved` and `node` (the source AST node, for error positioning) to `declareInScope`:

```js
export function declareInScope(scope, name, type, kind, node, errors) {
  if (scope.bindings.has(name)) { ... }
  scope.bindings.set(name, {
    type,
    kind,
    node,                    // for error reporting at scope-exit
    errObserved: false,      // flipped true when err is read
  });
}
```

Also add an iterator-over-scope-entries helper used by `popScope`:

```js
export function popScope(scope, ctx) {
  for (const [name, binding] of scope.bindings) {
    if (isFallible(binding.type) && !binding.errObserved && binding.kind !== "discard") {
      pushError(
        ctx.errors,
        binding.node,
        `fallible binding "${name}" of type ${formatType(binding.type)} must observe its 'err' field before scope exit (read .err, destructure with err, propagate with ?, or discard with _ = ...)`,
      );
    }
  }
}
```

`pushScope` already exists; adapt `checkBlock` to call `popScope` at the end of its iteration ([checkStatement.js:78-83](../src/jsyooptypecheck/checkStatement.js#L78-L83)). The function's outermost scope (params + body) is the same: see `validateFunction` ([checkStatement.js:23-51](../src/jsyooptypecheck/checkStatement.js#L23-L51)) — call `popScope(scope, ctx)` after `validateStatement(funcNode.body, ...)`.

> **Note on the `discard` kind**: a `_ = expr;` doesn't bind anything, so this kind label only ever exists if we end up scaffolding a synthetic binding for tracking. Probably we don't — see §6.f.

### 6.b Resolving the err-observation when reading `r.err`

In `resolveFieldAccess` ([checkExpr.js:286-309](../src/jsyooptypecheck/checkExpr.js#L286-L309)):

```js
function resolveFieldAccess(node, scope, ctx) {
  // ... existing body ...
  // BEFORE returning successfully:
  if (node.field === "err") {
    const root = rootIdentOf(node);
    if (root) {
      const binding = lookupInScope(scope, root.name);
      if (binding) binding.errObserved = true;
    }
  }
  // ...
}
```

The "root chain" rule means `r.err` flips `r`, but `r.inner.err` flips `r` too. That's fine — `r.inner.err` *is* observing `r`'s err transitively. The spec doesn't carve this out.

### 6.c `LET_DECL` / `CONST_DECL` with fallible RHS

Existing code at [checkStatement.js:89-110](../src/jsyooptypecheck/checkStatement.js#L89-L110). No structural change — once the binding is declared via `declareInScope` with the new shape, observation tracking handles itself. The only consideration: the binding's *declared type* may not be fallible (e.g. `let n: int32 = read_all(p)?;` — `n` is int32, the `?` strips), in which case `errObserved` will never matter. `popScope`'s `isFallible(binding.type)` check covers that.

But if the user writes `let r: Bytes = read_all(p);` with no `?`, `r` is fallible and observation rules kick in.

### 6.d `TRY_OP` whose stripped type is `strippedMulti`

The only legal context for a multi-field strip in this phase is a `DESTRUCTURE_DECL`. So:

In `resolveExprType` (the orphan `TRY_OP` path), if `node.strippedMulti` was set, push an error from the caller side. The caller is one of:
- A `LET_DECL` initializer ([checkStatement.js:97-105](../src/jsyooptypecheck/checkStatement.js#L97-L105)) — error: "use destructuring to bind multi-field `?` result".
- A `RETURN_STATEMENT` value ([checkStatement.js:114-133](../src/jsyooptypecheck/checkStatement.js#L114-L133)) — currently rejects since the return type can't match `strippedMulti`.
- A call argument — same as `LET_DECL`.

The cleanest place: special-case `node.kind === ASTNodeKind.TRY_OP && node.strippedMulti` at the *top* of `checkInitializer` ([checkExpr.js:353-370](../src/jsyooptypecheck/checkExpr.js#L353-L370)) and emit the message there. That single check covers all four call sites.

### 6.e `DESTRUCTURE_DECL`

New `validateStatement` case:

```js
case ASTNodeKind.DESTRUCTURE_DECL:
  return checkDestructureDecl(node, scope, ctx);
```

Implementation:

```js
function checkDestructureDecl(node, scope, ctx) {
  // Resolve the RHS type — may include TRY_OP that yields strippedMulti.
  let rhsType;
  if (node.assignment.kind === ASTNodeKind.TRY_OP) {
    rhsType = resolveExprType(node.assignment, scope, ctx);  // sets strippedMulti
    if (node.assignment.strippedMulti) {
      // Upgrade: pretend the RHS is the multi-field shape.
      rhsType = StructType("__stripped", node.assignment.strippedMulti.fields);
    }
  } else {
    rhsType = resolveExprType(node.assignment, scope, ctx);
  }

  if (rhsType.kind !== typeKinds.struct) {
    pushError(ctx.errors, node, `cannot destructure non-struct type ${formatType(rhsType)}`);
    // still declare each name with ErrorType so subsequent uses don't cascade
    for (const n of node.names) {
      declareInScope(scope, n.name, ErrorType(), declKindOf(node), n, ctx.errors);
    }
    return;
  }

  // Check every name corresponds to a field on the source type.
  const fieldMap = new Map((rhsType.fields ?? []).map(f => [f.name, f.type]));
  const seenNames = new Set();
  for (const n of node.names) {
    if (seenNames.has(n.name)) {
      pushError(ctx.errors, n, `duplicate name "${n.name}" in destructure`);
      continue;
    }
    seenNames.add(n.name);
    const fieldType = fieldMap.get(n.name);
    if (!fieldType) {
      pushError(ctx.errors, n, `type ${formatType(rhsType)} has no field "${n.name}"`);
      declareInScope(scope, n.name, ErrorType(), declKindOf(node), n, ctx.errors);
      continue;
    }
    declareInScope(scope, n.name, fieldType, declKindOf(node), n, ctx.errors);
  }

  // Observation rule: if the source struct is fallible, the user MUST name `err`
  // (or use ? to propagate, but ? doesn't compose with destructure here — see §6.d).
  // The pre-? rhsType is what determines fallibility at the call site, not the
  // post-? stripped type. So we re-check the *operand's* type when the RHS was a TRY_OP.
  let observedSource = rhsType;
  if (node.assignment.kind === ASTNodeKind.TRY_OP) {
    observedSource = node.assignment.operand.resolvedType;
    // The TRY_OP itself counts as full observation — it consumes err entirely.
    // No need for "err" to appear in destructured names.
  } else if (isFallible(rhsType) && !seenNames.has("err")) {
    pushError(
      ctx.errors,
      node,
      `destructuring a fallible type ${formatType(rhsType)} must include "err" or use '?' to propagate`,
    );
  }
}
```

Two subtle interactions worth calling out:
- `const { a, err } = f()?;` — the `?` already consumed `err`, so the destructure no longer sees it. The bound names come from the *stripped* fields. So when the RHS is a `TRY_OP`, the err-observation requirement is satisfied by the `?` itself, and we *don't* require `err` in `node.names`. This is the spec's intent (§11 sample shows both forms).
- `const { a, err } = f();` (no `?`) — the destructure must include `err` to satisfy observation.

### 6.f `DISCARD_STATEMENT` — `_ = expr;`

`_ = f();` resolves the expression purely for side-effects + type validation. No binding is introduced. The expression's err is considered observed (the user opted into discard).

```js
case ASTNodeKind.DISCARD_STATEMENT: {
  resolveExprType(node.value, scope, ctx);
  // No fallible-observation work needed — the discard is the observation.
  return;
}
```

If the expression's root is an IDENT bound elsewhere (rare — user wrote `_ = r;` for some local `r`), the discard still counts: walk the root chain and mark the binding's `errObserved = true` for completeness. This is a small loop:

```js
function markErrObservedThroughRoot(exprNode, scope) {
  // walk down through TRY_OP, FIELD_ACCESS, etc. to find an IDENT root
  let n = exprNode;
  while (n) {
    if (n.kind === ASTNodeKind.IDENT) {
      const b = lookupInScope(scope, n.name);
      if (b) b.errObserved = true;
      return;
    }
    if (n.kind === ASTNodeKind.FIELD_ACCESS) { n = n.object; continue; }
    if (n.kind === ASTNodeKind.TRY_OP)        { n = n.operand; continue; }
    return;
  }
}
```

### 6.g Plain `EXPRESSION_STATEMENT` with a fallible call

If the user writes `read_all(path);` as a statement (no binding, no destructure, no discard), that's a compile error. Existing `EXPRESSION_STATEMENT` handler at [checkStatement.js:62-63](../src/jsyooptypecheck/checkStatement.js#L62-L63) just resolves the expression and walks on. Add a check after:

```js
case ASTNodeKind.EXPRESSION_STATEMENT: {
  const t = resolveExprType(node.value, scope, ctx);
  if (isFallible(t)) {
    pushError(
      ctx.errors,
      node,
      `fallible result of type ${formatType(t)} dropped — bind it, destructure, propagate with ?, or discard with _ = ...`,
    );
  }
  return;
}
```

`?` in expression position (e.g. `f()?;`) is handled separately: `f()?` returns void if `f` is err-only fallible (§11 table). For all other shapes, the expression has a non-void type but the result is dropped — same error.

Special-case for the err-only case: if `node.value.kind === TRY_OP` and the stripped type is `void`, it's legal as a statement.

---

## 7. Typechecker — `RETURN_STATEMENT` interaction with default-fill

The `?` operator's lowering produces `return { ...default(ReturnType), err: _tmp.err };` — a synthetic struct literal with every non-err field at its zero value. This is a *codegen-time* transformation; the typechecker doesn't need to know.

But: any user-written `return { ... }` from a fallible function still goes through `pinStructLiteral`, so they have to spell out every field even when `err: ""`. This is per spec — there's no `?(...)` shorthand for "construct the success variant". Could ergonomically improve later; not in scope.

---

## 8. Codegen — `TRY_OP` lowering ([codegen.js](../src/jsyoopcodegen/codegen.js))

The lowering for `expr?` where `expr` has fallible type `T`:

```
%tmp = <eval expr>                          ; SSA value of type %struct.T
store %struct.T %tmp, ptr %tmp_slot         ; stash on stack so we can GEP
%err_ptr = getelementptr inbounds %struct.T, ptr %tmp_slot, i32 0, i32 N  ; N = err's index
%err_str = load ptr, ptr %err_ptr
%err_len = call i64 @strlen(ptr %err_str)   ; "err is set" iff err.len > 0
%failed = icmp ne i64 %err_len, 0
br i1 %failed, label %try_fail, label %try_ok

try_fail:
  ; build the default success variant with err = %err_str
  ; (synthesized struct literal zero-init for every non-err field, then store err)
  ...
  ret %struct.<EnclosingReturnType> %fail_value

try_ok:
  ; SSA value the rest of the function consumes
  ; - single non-err field: load that field
  ; - err-only: nothing (statement position only — caller emits void)
  ; - multi-field: only reachable inside a destructure; caller handles
```

A few specifics:

### 8.a Detecting "err is set"

Problem: yooper's err is a `string` (LLVM `ptr`). An empty string `""` is a real interned empty string global, *not* a null pointer. So "no error" is `err.len == 0`, not `err == null`.

Cleanest first cut: call `strlen(err)` and compare to 0. This relies on `strlen` being available as an extern, which is automatic given the existing `externDecl` fallback (`declare i32 @<name>(...)` is wrong here — strlen is `declare i64 @strlen(ptr)`). Add `strlen` to the known-externs map at [codegen.js:781-787](../src/jsyoopcodegen/codegen.js#L781-L787):

```js
const known = {
  printf: "declare i32 @printf(ptr, ...)",
  ...
  strlen: "declare i64 @strlen(ptr)",
};
```

And mark it called by injecting `called.add("strlen")` from the `?` lowering path so the `extern` block emits it.

> Alternative: zero-initialize err to literal null and check for null — simpler, but it changes the language semantics (`err: ""` and "no error" become two different states). Reject this; stick with strlen.

### 8.b Default value for the enclosing return type

Per spec, on failure: `return { ...default(EnclosingReturnType), err: _tmp.err };`. So we need to materialize a fallible struct of the enclosing function's return type with:
- `err = _tmp.err`
- every other field = its zero value

Zero values per type:
- prim int / bool / char / usize / isize: `0`
- prim float: `0.0`
- prim string: an interned empty string (`@.str.empty`)
- struct: zeroinit recursively
- ref: not in this phase
- array: not in this phase

LLVM has `zeroinitializer` which does the right thing for aggregates (recursively zero-fills). The simplest lowering:

```llvm
try_fail:
  %fail_slot = alloca %struct.<RetType>, align <X>
  store %struct.<RetType> zeroinitializer, ptr %fail_slot
  %fail_err_ptr = getelementptr inbounds %struct.<RetType>, ptr %fail_slot, i32 0, i32 <N>
  store ptr %err_str, ptr %fail_err_ptr
  %fail_value = load %struct.<RetType>, ptr %fail_slot
  ret %struct.<RetType> %fail_value
```

`zeroinitializer` makes string fields null pointers, not "" pointers. This matters: if the caller ever inspects a non-err field of the failure variant (which they shouldn't — they're supposed to short-circuit on err), they'd see null.

For Phase 2 this is acceptable: the spec is explicit that on failure, callers only read err. Document this in a comment in codegen and revisit if it bites.

> A tighter alternative: emit a per-fallible-struct `@__default_<TypeName>` global constant initialized field-by-field with proper empty strings. More IR, slightly cleaner. Not required for v0; leave a TODO.

Add a helper `emitFailVariantReturn(retType, errStrSSA, fnLines)` in codegen that emits the four lines above.

### 8.c `try_ok` — extracting the success value

Three sub-cases mirroring §4's `strippedTypeOf`:

```js
case ASTNodeKind.TRY_OP: {
  const operandType = node.operand.resolvedType;
  const labels = { fail: freshLabel("try_fail"), ok: freshLabel("try_ok") };

  // 1. Evaluate operand, stash on stack
  const r = emitExpr(node.operand, fnLines);
  const slot = freshTemp();
  fnLines.push(`  ${slot} = alloca %struct.${operandType.name}, align ${alignOfStruct(operandType)}`);
  fnLines.push(`  store %struct.${operandType.name} ${r.val}, ptr ${slot}`);

  // 2. Branch on err
  const errIdx = operandType.fields.length - 1;   // `err` is always last by isFallible's rule
  const errPtr = freshTemp();
  fnLines.push(`  ${errPtr} = getelementptr inbounds %struct.${operandType.name}, ptr ${slot}, i32 0, i32 ${errIdx}`);
  const errStr = freshTemp();
  fnLines.push(`  ${errStr} = load ptr, ptr ${errPtr}`);
  const errLen = freshTemp();
  fnLines.push(`  ${errLen} = call i64 @strlen(ptr ${errStr})`);
  externalsCalled.add("strlen");
  const failed = freshTemp();
  fnLines.push(`  ${failed} = icmp ne i64 ${errLen}, 0`);
  fnLines.push(`  br i1 ${failed}, label %${labels.fail}, label %${labels.ok}`);

  // 3. Fail block
  fnLines.push(`${labels.fail}:`);
  emitFailVariantReturn(ctx.returnType, errStr, fnLines);

  // 4. OK block — strip err and yield the value
  fnLines.push(`${labels.ok}:`);
  const stripped = strippedTypeOf(operandType);   // non-multi guaranteed at this stage
  if (stripped.kind === "void") {
    return { val: "void", yoopType: VoidType() };
  }
  // single non-err field path
  const valPtr = freshTemp();
  fnLines.push(`  ${valPtr} = getelementptr inbounds %struct.${operandType.name}, ptr ${slot}, i32 0, i32 0`);
  const val = freshTemp();
  fnLines.push(`  ${val} = load ${llvmType(stripped)}, ptr ${valPtr}`);
  return { val, yoopType: stripped };
}
```

For the multi-field case, the destructure lowering is the only context that sees this — so handle it inline there (§9). The bare `TRY_OP` codegen here can throw "codegen bug: multi-strip reached emitExpr — typechecker should have rejected" defensively.

### 8.d Threading `externalsCalled`

Codegen currently auto-collects called externs by walking the AST in `collectCalls` ([codegen.js:763-778](../src/jsyoopcodegen/codegen.js#L763-L778)). The `?` lowering injects `strlen` calls that aren't in the AST. Easiest fix: have `codegen()` initialize a set `extraExterns = new Set()` and OR it into `called` before the extern emission loop. The `?` codegen pushes `"strlen"` into `extraExterns`.

The order is fragile: the extern emission runs *before* function bodies, so `extraExterns` must be populated before that. Options:

1. **Pre-walk the AST for `?` nodes in `emitProgram`'s pre-pass** — clean, easy: any `TRY_OP` in the AST means strlen is needed. Add a tiny walker.
2. **Move extern emission to *after* function bodies** — wrong, externs belong at module-top.
3. **Always emit `strlen`** if any `TRY_OP` exists — this is what option 1 does, just plumbed slightly differently.

Use option 1: in `emitProgram`, walk the AST once for `TRY_OP`; if any, add `strlen` to `called`. Two tiny lines.

---

## 9. Codegen — `DESTRUCTURE_DECL`

Lowering follows the spec rewrite verbatim:

```yoop
const { a, b, err } = f();
```

becomes (conceptually):

```yoop
const _tmp = f();
const a = _tmp.a;
const b = _tmp.b;
const err = _tmp.err;
```

In LLVM:

```llvm
%_tmp = alloca %struct.SourceType, align <X>
%call = call %struct.SourceType @f()
store %struct.SourceType %call, ptr %_tmp

%a_ptr = getelementptr inbounds %struct.SourceType, ptr %_tmp, i32 0, i32 0
%a_slot = alloca <T_a>, align <X_a>
%a_val = load <T_a>, ptr %a_ptr
store <T_a> %a_val, ptr %a_slot
; ... same for b, err
```

Add this case to `emitStatement` ([codegen.js:565-628](../src/jsyoopcodegen/codegen.js#L565-L628)):

```js
case ASTNodeKind.DESTRUCTURE_DECL: {
  emitDestructureDecl(node, fnLines, ctx);
  break;
}
```

Implementation, with the `TRY_OP`-as-RHS sub-case folded in:

```js
function emitDestructureDecl(node, fnLines, ctx) {
  // Special path: const { a, b, err } = f()?;
  // The `?` propagates err out, then the destructure takes over the
  // stripped fields. Emit the ? in "multi-strip" mode so it gives us a
  // pointer to the source-typed slot we can GEP into directly.
  if (node.assignment.kind === ASTNodeKind.TRY_OP) {
    const slot = emitTryOpToSlot(node.assignment, fnLines, ctx);
    // slot.{ptr, type} addresses the original (pre-strip) struct on stack
    // — fields are still indexed as in the source type.
    bindEachFromSlot(node, slot, fnLines);
    return;
  }
  // Regular destructure — emit RHS into a slot and read fields.
  const r = emitExpr(node.assignment, fnLines);
  const sourceType = node.assignment.resolvedType;
  const slot = freshTemp();
  fnLines.push(`  ${slot} = alloca %struct.${sourceType.name}, align ${alignOfStruct(sourceType)}`);
  fnLines.push(`  store %struct.${sourceType.name} ${r.val}, ptr ${slot}`);
  bindEachFromSlot(node, { ptr: slot, type: sourceType }, fnLines);
}

function bindEachFromSlot(node, slot, fnLines) {
  for (const n of node.names) {
    const idx = slot.type.fields.findIndex(f => f.name === n.name);
    const fieldType = slot.type.fields[idx].type;
    const llvmTy = llvmType(fieldType);
    const gepTmp = freshTemp();
    fnLines.push(`  ${gepTmp} = getelementptr inbounds %struct.${slot.type.name}, ptr ${slot.ptr}, i32 0, i32 ${idx}`);
    const valTmp = freshTemp();
    fnLines.push(`  ${valTmp} = load ${llvmTy}, ptr ${gepTmp}`);
    symbols.set(n.name, fieldType);
    fnLines.push(`  %${n.name} = alloca ${llvmTy}, align ${alignOf(llvmTy)}`);
    fnLines.push(`  store ${llvmTy} ${valTmp}, ptr %${n.name}`);
  }
}
```

`emitTryOpToSlot` is a refactor of the §8.c codegen that returns a `{ ptr, type }` pointing at the on-stack source-typed slot, instead of materializing a single field. The bare-`TRY_OP` `emitExpr` case wraps `emitTryOpToSlot`, then loads the single non-err field. Avoids duplicating the err-check.

---

## 10. Codegen — `DISCARD_STATEMENT`

```js
case ASTNodeKind.DISCARD_STATEMENT: {
  emitExpr(node.value, fnLines);   // side-effects only; result is dropped
  break;
}
```

`emitExpr` returns a value but we don't use it. The SSA temp is dead — LLVM's optimizer drops it.

If `node.value` is a `TRY_OP`, the err-propagation still fires before we get here — so `_ = f()?;` actually doesn't suppress the propagate. That's correct per spec: `?` is its own thing. The discard form is for "I know this returns a fallible value but I want to ignore the error completely and not bind it".

> **Subtle**: `_ = f()?;` is a valid program. The `?` propagates if err, otherwise the (stripped) value is computed and discarded. Document this in a `// note:` comment near the discard handler.

---

## 11. Tests

### 11.1 Pass fixtures — [examples/pass/](../examples/pass/)

Each ends with a comment naming the expected stdout.

#### `errors_basic.yoop`

```yoop
type Bytes { len: int32, err: string, }

function read_all(path: string): Bytes {
    return { len: 42, err: "" };
}

function main(): int32 {
    const b = read_all("foo");
    if (b.err.len > 0) {
        printf(`err: ${b.err}\n`);
        return 1;
    }
    printf(`len = ${b.len}\n`);
    return 0;
}

// expected output: len = 42
```

> Note: this exercises `b.err` as the observation — no `?`, no destructure. Validates the scope-exit observation rule.

#### `errors_propagate.yoop`

```yoop
type Bytes  { len: int32, err: string, }
type Result { total: int32, err: string, }

function read_all(path: string): Bytes {
    if (path.len == 0) {
        return { len: 0, err: "empty path" };
    }
    return { len: 42, err: "" };
}

function load_and_double(path: string): Result {
    const n = read_all(path)?;       // n: int32 (single-field strip)
    return { total: n + n, err: "" };
}

function main(): int32 {
    const { total, err } = load_and_double("foo.cfg");
    if (err.len > 0) {
        printf(`err: ${err}\n`);
        return 1;
    }
    printf(`total = ${total}\n`);
    return 0;
}

// expected output: total = 84
```

Exercises: postfix `?`, single-field strip, destructure with `err`, fallible-return, success path.

#### `errors_propagate_failure.yoop`

```yoop
type Bytes  { len: int32, err: string, }
type Result { total: int32, err: string, }

function read_all(path: string): Bytes {
    if (path.len == 0) {
        return { len: 0, err: "empty path" };
    }
    return { len: 42, err: "" };
}

function load_and_double(path: string): Result {
    const n = read_all(path)?;
    return { total: n + n, err: "" };
}

function main(): int32 {
    const { total, err } = load_and_double("");      // empty path triggers failure
    if (err.len > 0) {
        printf(`err: ${err}\n`);
        return 0;       // success of the test, even though load failed
    }
    printf(`total = ${total}\n`);
    return 1;
}

// expected output: err: empty path
```

Exercises: `?`'s failure path, `default(...)` synthesis, err propagation across function boundaries.

#### `errors_discard.yoop`

```yoop
type Bytes { len: int32, err: string, }

function noisy_op(): Bytes {
    return { len: 0, err: "ignored" };
}

function main(): int32 {
    _ = noisy_op();
    printf(`done\n`);
    return 0;
}

// expected output: done
```

Exercises: `_ =` discard satisfies observation.

#### `errors_destructure_no_qmark.yoop`

```yoop
type Bytes { len: int32, err: string, }

function read_all(path: string): Bytes {
    return { len: 7, err: "" };
}

function main(): int32 {
    const { len, err } = read_all("foo");
    if (err.len > 0) {
        return 1;
    }
    printf(`len = ${len}\n`);
    return 0;
}

// expected output: len = 7
```

Exercises: destructure-with-err satisfies observation without `?`.

### 11.2 Fail fixtures — [examples/fail/](../examples/fail/)

Each is a single program that should produce one (or one set of) typecheck errors. The test runner asserts the error message matches.

| File | Snippet (essentials) | Expected error |
|---|---|---|
| `err_dropped.yoop` | `read_all("x");` (statement-position fallible call) | `fallible result of type struct Bytes dropped` |
| `err_unobserved.yoop` | `const r = read_all("x");` then function returns without reading `r.err` | `fallible binding "r" ... must observe its 'err' field` |
| `err_destructure_missing_err.yoop` | `const { len } = read_all("x");` | `destructuring a fallible type ... must include "err"` |
| `err_qmark_in_nonfallible.yoop` | `function f(): int32 { const x = read_all("x")?; return x; }` | `'?' is only legal inside a function that returns a fallible type` |
| `err_qmark_on_nonfallible.yoop` | Apply `?` to a plain `int32` value | `'?' applied to non-fallible type int32` |
| `err_destructure_unknown_field.yoop` | `const { nope, err } = read_all("x");` | `type struct Bytes has no field "nope"` |
| `err_multi_strip_no_destructure.yoop` | Three-field fallible struct, `let s = f()?;` (no destructure) | `use destructuring to bind multi-field '?' result` |

### 11.3 Updating `e2e.test.js`

Each pass fixture gets an `it()` clause mirroring [e2e.test.js:30-87](../src/e2e.test.js#L30-L87)'s pattern: read source, compile, link, run, assert stdout + exit code.

Each fail fixture gets an `it()` in the *fail* describe block at [e2e.test.js:89-97](../src/e2e.test.js#L89-L97). The pattern for typecheck failures:

```js
it("err_dropped.yoop fails typecheck with the right message", () => {
  const src = fs.readFileSync(path.join(repoRoot, "examples/fail/err_dropped.yoop"), "utf8");
  const { errors } = typecheckSource(src);
  assert.ok(errors.length >= 1);
  assert.match(errors[0].message, /fallible result.*dropped/);
});
```

### 11.4 Unit tests for `fallible.js`

New file [src/jsyooptypecheck/fallible.test.js](../src/jsyooptypecheck/fallible.test.js):

- `isFallible({ x: int32 })` → false
- `isFallible({ x: int32, err: string })` → true
- `isFallible({ err: string, x: int32 })` → false (trailing-only marker)
- `isFallible({ err: int32 })` → false (string-typed only)
- `strippedTypeOf({ value: int32, err: string })` → `int32`
- `strippedTypeOf({ err: string })` → `void`
- `strippedTypeOf({ a: int32, b: int32, err: string })` → `{ kind: "strippedMulti", fields: [...] }`
- `strippedTypeOf({ x: int32 })` → null

### 11.5 Parser unit tests

In [parser.test.js](../src/jsyooparser/parser.test.js), add cases that assert the AST shapes:

- `f()?` → `TRY_OP { operand: CALL_EXPRESSION }`
- `f().a?` → `TRY_OP { operand: FIELD_ACCESS { object: CALL_EXPRESSION, field: "a" } }`
- `f()?.a` → `FIELD_ACCESS { object: TRY_OP { operand: ... }, field: "a" }`
- `const { a, err } = f();` → `DESTRUCTURE_DECL { declKind: "CONST_DECL", names: [{name:"a"},{name:"err"}], assignment: ... }`
- `let { a } = f();` → ditto with declKind `"LET_DECL"`
- `_ = f();` → `DISCARD_STATEMENT { value: CALL_EXPRESSION }`
- `r? = 5;` → parse error (TRY_OP isn't a valid lvalue)

### 11.6 Codegen IR-shape tests

In [codegen.test.js](../src/jsyoopcodegen/codegen.test.js):

- A program with `?` produces IR containing `call i64 @strlen(ptr` — the err-check.
- A `?`'s fail block emits `store ... zeroinitializer, ptr` for the success-shape allocation.
- The `try_fail` and `try_ok` labels are present.
- Destructure-with-err emits N GEPs and N loads, one per name.

Don't be too rigid about specific SSA names (`%t0` etc.) — match on substrings.

---

## 12. Edge cases worth getting right

### 12.a Zero-width fallible (err-only) in expression position

`f()?` where `f` returns `{ err: string }` — the spec says this is statement-position only. Our parser will happily make a `TRY_OP` here; the typechecker rejects when the resulting void flows into a non-statement context. The `EXPRESSION_STATEMENT` case at §6.g specifically permits this shape (see the guard there).

### 12.b `?` on a chain rooted in a temporary

`make_pair().a?` — only legal if `make_pair().a`'s static type is itself fallible (a struct with `err: string`). The typechecker doesn't care that the root is a call result; codegen materializes the `make_pair()` result via `emitLvalue`'s default branch (already lands in Phase 1.3). No new code.

### 12.c Empty string err field

The spec says "no error" is `err: ""`. Codegen detects errors via `strlen(err) > 0`. If the user accidentally writes `err: " "` (space) and returns it as success — the `?` will treat it as failure. That's a runtime bug in user code, not our problem; document that "no error" means "len(err) == 0".

### 12.d Multi-field strip in argument position

`f(g()?)` where `g` returns a multi-field fallible — typechecker rejects with the "multi-field strip must be destructured" error. This matches the call-arg path in §6.d's hooks via `checkInitializer`.

### 12.e Re-assignment of fallible binding before observation

```yoop
let r = read_all("a");
r = read_all("b");           // first r's err never observed
return r.err;
```

The first `r`'s err observation is *not* checked — once the binding is reassigned, we lose the previous value entirely. Per the spec the rule is "before scope exit", and reassignment is not scope exit. Document this as known-permissive: a future flow analysis could tighten it.

For Phase 2: leave permissive. The `errObserved` flag gets *reset* on assignment to the binding (so the second value still requires observation):

```js
// in resolveAssignmentToIdent
if (binding && isFallible(binding.type)) {
  binding.errObserved = false;
}
```

### 12.f `?` on a fallible param

`function f(b: Bytes): Bytes { return b?; }` — `?` on a param is legal: the param's type is fallible, the function returns fallible, the rule fires. Useful for "rethrow on failure". No new code needed; the existing checks cover it.

### 12.g Default-value strings

`default(EnclosingReturnType)` zero-init makes string fields null pointers. If the caller writes `if (b.err.len > 0)` after `?`-success, that's fine — they're reading `err` which we *did* set to `_tmp.err` (which is `""` on success). But if someone reads a non-err string field of the `?`-failure-variant, they'll deref null. The spec is that callers don't do this; document and move on.

### 12.h Destructure on a non-struct RHS

`const { a } = 42;` — typechecker rejects with "cannot destructure non-struct type untyped int". Already covered by §6.e's first check.

### 12.i Nested `?` in same expression

`f(g()?)?` — both apply: `g()?` strips to a value, that value flows into `f`, and `f`'s result has `?` applied. Each `?` independently checks its rules. As long as `f`'s param accepts the stripped type and `f`'s return is fallible, this composes. Good. No new code.

### 12.j `TRY_OP` whose operand has type `error` (cascaded)

The operand's type is `error` (typecheck failure earlier). Set the `TRY_OP`'s type to `error` and don't push a new error — cascade suppression. Covered in §5's first check.

---

## 13. Out of scope (for clarity)

- **`?` context suffix** — `f()? "loading config"` is reserved syntax, not implemented.
- **Anonymous structs as bindings** — `let s = f()?;` for multi-field fallible. Forced through destructure for now.
- **Kind-aware discard rules** — `_ = f()` always allowed; `mustCall` etc. lands in Phase 6.
- **Result/Either generic types** — explicitly not in the spec.
- **`try` / `catch` / exceptions** — not in the spec.
- **`?` inside `wait` (tasks)** — Phase 6 (kinds + `Task<T>` trait).
- **Per-error context attachment / chaining** — strings only, no error wrapping.
- **Match on err** — pattern matching is Phase 7.

---

## 14. Phase exit criteria

- Every program in §11.1 compiles and runs, producing exactly the expected stdout / exit code.
- Every program in §11.2 fails typecheck (does not crash) with at least one error matching the listed pattern.
- All existing Phase 1 tests still pass identically. No IR diffs for any program that doesn't use `?` / destructure / discard / err.
- `clang` accepts the generated IR for every fixture without warnings or errors.
- The new unit tests for `fallible.js` and the parser/codegen additions all pass.
- Each fail fixture does not produce *additional* unrelated cascading errors — the err-observation message is the only one for unobserved cases, etc.

---

## 15. Implementation order from here

The order minimizes the time spent in a broken intermediate state.

1. **Lexer + AST**: add `?` token, add three new AST node kinds. No semantic change yet — confirm `parser.test.js` and `lexer.test.js` still pass.
2. **Parser**: postfix `?`, destructure decl, discard statement, plus the new parser tests in §11.5. After this commit, the new shapes are syntactically accepted but the typechecker will throw "unhandled" on them.
3. **`fallible.js`**: implement `isFallible`, `strippedTypeOf`, `defaultStructLiteralFor`, plus unit tests in §11.4. Pure functions, easy to merge alone.
4. **Typechecker — `TRY_OP`**: §5. Nothing else changes yet. Programs that *only* use `?` (no observation, no destructure) start working through typecheck. Add `extra externals: strlen` plumbing to codegen at the same time so an end-to-end test on `errors_propagate.yoop` lands here.
5. **Typechecker — observation tracking**: §6.a, §6.b, §6.g — extend bindings, mark err on field access, reject dropped fallible expressions. After this, `examples/fail/err_dropped.yoop` and `err_unobserved.yoop` start failing typecheck correctly.
6. **Typechecker — destructure**: §6.e. After this, `errors_destructure_no_qmark.yoop` (pass) and `err_destructure_missing_err.yoop`, `err_destructure_unknown_field.yoop` (fail) all work.
7. **Typechecker — discard**: §6.f. `errors_discard.yoop` works.
8. **Codegen — `?` and default-fill**: §8 — fully wire up `emitTryOpToSlot` + `emitFailVariantReturn`. Run `errors_propagate.yoop` and `errors_propagate_failure.yoop` end-to-end. **Verify** that the multi-field-strip codegen path is unreachable (typechecker rejects).
9. **Codegen — destructure**: §9. Run `errors_basic.yoop`, `errors_destructure_no_qmark.yoop`, both propagate fixtures end-to-end.
10. **Codegen — discard**: §10. Run `errors_discard.yoop`.
11. **Test runner**: ensure `e2e.test.js` adds an `it()` per fixture, both pass and fail. Unit tests for the new modules.

Each step keeps the prior step's tests green. Bisect-friendly.

---

## 16. Critical files reference

- [SPEC.md §11 — Errors as values](../SPEC.md) — re-read before each step.
- [src/contracts.js](../src/contracts.js) — `TRY_OP`, `DESTRUCTURE_DECL`, `DISCARD_STATEMENT`.
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — `question` token.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — postfix `?`, destructure decl, discard statement.
- [src/jsyooptypecheck/fallible.js](../src/jsyooptypecheck/fallible.js) — `isFallible`, `strippedTypeOf`, `defaultStructLiteralFor` (new file).
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) — `resolveTryOp`, `markErrObservedThroughRoot`, multi-strip rejection in `checkInitializer`.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js) — `checkDestructureDecl`, dropped-fallible rejection in `EXPRESSION_STATEMENT`, discard handler.
- [src/jsyooptypecheck/scope.js](../src/jsyooptypecheck/scope.js) — extended binding shape, `popScope` enforcement.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — `emitTryOpToSlot`, `emitFailVariantReturn`, `emitDestructureDecl`, `strlen` extern plumbing.
- [src/e2e.test.js](../src/e2e.test.js) — pass + fail fixtures wired in.
- [examples/pass/](../examples/pass/) — `errors_basic`, `errors_propagate`, `errors_propagate_failure`, `errors_discard`, `errors_destructure_no_qmark`.
- [examples/fail/](../examples/fail/) — `err_dropped`, `err_unobserved`, `err_destructure_missing_err`, `err_qmark_in_nonfallible`, `err_qmark_on_nonfallible`, `err_destructure_unknown_field`, `err_multi_strip_no_destructure`.
