# Phase 1.3 — Struct types

Part of the [roadmap](./roadmap.md). Phases 1.1 and 1.2 set up clean numeric literals and a real typechecker pass. This phase adds the first compound type: structs. It exercises every layer of the compiler — lexer (new keyword), parser (new top-level form, new infix `.`, new prefix `{...}`), typechecker (struct registration, field resolution, struct-literal target-type pinning), and codegen (struct emission, GEP, struct-by-value).

## Goal

Land a working subset of [SPEC.md §3 — Struct](../SPEC.md):

```yoop
type Point {
    x: int32,
    y: int32,
}

function distance_sq(p: Point): int32 {
    return p.x * p.x + p.y * p.y;
}

function main(): int32 {
    let p: Point = { x: 3, y: 4 };
    printf(`distance_sq = ${distance_sq(p)}\n`);
    return 0;
}
```

Concretely:
- `type Name { f: T, ... }` parses, registers, and reaches codegen as `%struct.Name = type { ... }`
- `expr.field` reads (and `expr.field = ...` writes for plain locals)
- `{ f: e, ... }` literals only in expression position, target type pinned by context
- Struct values pass as parameters, get returned, assign to locals — first-class
- Field-access type errors and struct-literal field mismatches are caught in the typechecker, not codegen

## Why this is next

It's the smallest new language feature that needs every pass we just refactored to cooperate. Phase 1.2's payoff was the type system — Phase 1.3 is the first feature that genuinely needs it (`p.x` requires a real type lookup, not a string match). It's also a prerequisite for Phase 2 (errors as values are just structs with an `err: string` field), so getting struct semantics right now unblocks the next phase.

## Scope (what this phase does NOT do)

- **No methods** on types. Method blocks are part of trait impls (Phase 5). `type X { ... }` here is plain data only.
- **No `implements`** clause. Reserve the `StructType.implements` field (already on the type per Phase 1.2 — leave it `[]`), but do not parse `implements`.
- **No struct embedding / inheritance** — spec doesn't have it either.
- **No nested anonymous structs** in field types (`x: { a: int32 }` is not allowed).
- **No struct equality or comparison** operators (`p1 == p2` stays an error).
- **No destructuring** (`const { x, y } = p;`) — that's spec §11 sugar, comes with Phase 2.
- **No fallible-type detection** — even if a struct has an `err: string` field, there's no `?` operator yet. Just a normal struct.
- **No generic structs** — `type Box<T> { ... }` is deferred per spec §3.
- **No struct field default values** — initializer is required to mention every field.

---

## Files touched

**Edited**:

- [src/contracts.js](../src/contracts.js) — new `ASTNodeKind` entries: `TYPE_DECL`, `FIELD_DECL`, `FIELD_ACCESS`, `STRUCT_LITERAL`, `STRUCT_LITERAL_FIELD`
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — add `type` keyword tag and the `.` punctuation token
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — top-level `parseTypeDecl`, postfix field-access loop after primary, struct-literal prefix branch
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) — `StructType` is already defined; add a `resolveTypeName(name, structTable)` helper that knows about both prims and structs
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) — struct registration pre-pass, `FIELD_ACCESS` and `STRUCT_LITERAL` cases in `checkExpr`, struct support in `isAssignable` (already mostly works via `typesEqual`), struct types as let/return/param annotations
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — emit `%struct.X` declarations, GEP-based field read/write, struct-literal materialization, struct pass-by-value, struct return

**No new files** — the typechecker module already exists.

---

## 1. Lexer changes ([lexer.js](../src/jsyooplexer/lexer.js))

### Add `type` as a keyword

In `TokenTags`:

```js
type: 38,   // new — the `type` keyword for struct decls
```

In `keywordTagList`:

```js
type: TokenTags.type,
```

That's it for the lexer side of `type`. The rest is parsing.

### Add `.` as a punctuation token

Currently `.` is not in [tokenScanList](../src/jsyooplexer/lexer.js#L84-L108). Add:

```js
{ str: ".", tag: TokenTags.dot },
```

And add to `TokenTags`:

```js
dot: 39,
```

The lexer's numeric scanner already handles `.` correctly: `lexNumericLiteral` only consumes a `.` as a fractional part if `isDigit(src[end+1])` ([lexer.js:198](../src/jsyooplexer/lexer.js#L198)). So `1.foo` lexes as `intLiteral(1)`, `dot`, `ident("foo")` — exactly what we want for field access on an integer (which the typechecker will reject, but the *lex* is clean). Phase 1.1 already chose this rule explicitly; nothing to change.

### Test

Add the new keyword/dot to `testLexer`'s expected output, or — easier — just verify the new struct test program tokenizes without errors. The existing `expectedResults` golden in [lexer.js:374](../src/jsyooplexer/lexer.js#L374) doesn't use `type` or `.`, so it won't change.

---

## 2. AST node kinds ([contracts.js](../src/contracts.js))

```js
// declarations
TYPE_DECL: "TYPE_DECL",       // type Point { x: int32, y: int32, }
FIELD_DECL: "FIELD_DECL",     // a single { name, type } inside a TYPE_DECL

// expressions
FIELD_ACCESS: "FIELD_ACCESS",       // p.x
STRUCT_LITERAL: "STRUCT_LITERAL",   // { x: 1, y: 2 }
STRUCT_LITERAL_FIELD: "STRUCT_LITERAL_FIELD",  // a single { name, value } inside a STRUCT_LITERAL
```

`FIELD_DECL` and `STRUCT_LITERAL_FIELD` are not strictly required (could just be `{name, type}` and `{name, value}` plain objects), but keeping them as named AST nodes is consistent with how `PARAM` works today and makes them sourcedNodes (positions for error reporting on a per-field basis).

---

## 3. Parser changes ([parser.js](../src/jsyooparser/parser.js))

### a) Top-level dispatch — accept `type`

Currently `parseTopLevel` only accepts `function` ([parser.js:91-101](../src/jsyooparser/parser.js#L91-L101)). Extend the `switch`:

```js
switch (peekTag) {
  case TokenTags.function:
    node.body.push(parseFunctionDecl());
    break;
  case TokenTags.type:
    node.body.push(parseTypeDecl());
    break;
  default:
    throw new Error(`unexpected token at top level ...`);
}
```

### b) `parseTypeDecl`

```
parseTypeDecl():
  expect(type)
  node = buildSourcedNode(TYPE_DECL)
  node.name = parseIdentAsName()
  expect(lcurly)
  node.fields = []

  while peek().tag != rcurly and peek().tag != eof:
    fieldNode = buildSourcedNode(FIELD_DECL)
    fieldNode.name = parseIdentAsName()
    expect(colon)
    fieldNode.type = parseIdentAsName()   // type-name string; resolved in typecheck
    node.fields.push(fieldNode)
    if peek().tag == comma: advance()
    // trailing comma is allowed; required-comma-between-fields is not strict here
  expect(rcurly)

  return node
```

Mirrors `parseFunctionParam`'s shape exactly. The trailing-comma allowance matches the test program in the roadmap (`type Point { x: int32, y: int32, }`).

### c) Field access — postfix `.ident` loop

Today `parseExpression` parses a primary, then runs a binary-op loop ([parser.js:170-185](../src/jsyooparser/parser.js#L170-L185)). Field access doesn't fit the binary loop because the right side is an identifier, not a sub-expression. Insert a *postfix loop* between the primary and the binary loop:

```js
// after the primary `node` is parsed and before the binary-op loop:

while (true) {
  if (peek().tag === TokenTags.dot) {
    advance(); // consume '.'
    const fieldName = parseIdentAsName();
    const fa = buildSourcedNode(ASTNodeKind.FIELD_ACCESS);
    fa.object = node;
    fa.field = fieldName;
    node = fa;
    continue;
  }
  // Phase 4 will add `[`, `(` (call) here too. Today, calls are still
  // detected during ident parsing — leave that path alone for now.
  break;
}
```

Why postfix loop and not Pratt infix: Pratt's binary path expects `parseExpression(precedence)` on the right side. `.` doesn't take an expression, just an identifier. Cleanest to keep it out of the precedence table and handle it as left-associative postfix chaining. Chains like `a.b.c.d` become `((a.b).c).d` — exactly what we want.

`a.b * 2` parses as `(a.b) * 2` because the postfix loop is greedy *before* the binary loop runs. ✓

### d) Struct literal — prefix `{ ident :`

Today the prefix part of `parseExpression` dispatches on `intLiteral`, `floatLiteral`, `strLiteral`, `templateLiteral`, `ident`. Add `lcurly`. The body:

```
if peek().tag == lcurly:
  advance() // consume '{'
  node = buildSourcedNode(STRUCT_LITERAL)
  node.fields = []

  while peek().tag != rcurly and peek().tag != eof:
    f = buildSourcedNode(STRUCT_LITERAL_FIELD)
    f.name = parseIdentAsName()
    expect(colon)
    f.value = parseExpression()
    node.fields.push(f)
    if peek().tag == comma: advance()

  expect(rcurly)
  // fall through to the postfix/binary loops — `{x:1, y:2}.x` should parse
```

#### Disambiguation note

The same `{` token is also used for blocks. Could a `{` ever reach `parseExpression` and be misparsed as a struct literal when the user actually meant a block? Walk the call sites:

- `parseFunctionDecl` calls `parseBlock()` directly for the body
- `parseIfStatement` / `parseWhileStatement` call `parseBlock()` directly for their bodies
- `parseStatement` dispatches on `return`/`let`/`const`/`if`/`while`, with a default of `parseExpressionStatement` -> `parseExpression`

So a bare `{` at statement-position currently lands in `parseExpressionStatement -> parseExpression`. With this change, that becomes a struct literal. That's *fine*: `{ x: 1 }` as a statement is a useless expression — the typechecker can flag "struct literal at statement position has no target type" cleanly.

What about expression position inside `if (cond) { ... }`? The `(cond)` parses through `parseExpression` and hits `rparen`, returning before reaching `{`. Then `parseIfStatement` handles `{` directly via `parseBlock`. ✓

So the disambiguation is *positional*, not lookahead-based — much simpler than the roadmap's suggestion of `{ ident :` lookahead. We don't need lookahead; we just need to know that statements stop expression parsing before `{` is reached.

### e) Field assignment — `expr.field = value`

Spec implies field writes must work (the roadmap's `Field write: getelementptr then store`). The current parser's `ident` branch detects `name = value` for plain assignment ([parser.js:153-158](../src/jsyooparser/parser.js#L153-L158)). For `p.x = value`, we need a different shape because the LHS is a `FIELD_ACCESS`, not a bare ident.

Two options:

1. **Generalize `ASSIGNMENT`**: change `node.name` -> `node.target` (an AST node — either an `IDENT` or a `FIELD_ACCESS`). Update the typechecker and codegen to handle either.
2. **Defer field assignment** to a follow-up. The Phase 1 test program doesn't write to a field, so we *could* punt.

Recommendation: **do option 1 now**. It's a tiny generalization — the Pratt parser, after building a primary + postfix chain, can detect a trailing `=` and rewrap the whole thing as `ASSIGNMENT { target: node, value: rhs }`. Implementation:

After the postfix loop, before the binary loop:

```js
if (peek().tag === TokenTags.eq) {
  // assignment — but only valid if `node` is an lvalue
  // (IDENT or FIELD_ACCESS today; deref of REF later)
  advance(); // consume '='
  const rhs = parseExpression();
  const a = buildSourcedNode(ASTNodeKind.ASSIGNMENT);
  a.target = node;
  a.value = rhs;
  return a;   // assignment binds loosest; no further binary chaining
}
```

Then *delete* the existing `eq` branch inside the ident-path ([parser.js:153-158](../src/jsyooparser/parser.js#L153-L158)) — it's now redundant.

Update existing `ASSIGNMENT` consumers in typecheck and codegen: `node.name` becomes `node.target.name` (when target is `IDENT`), or follows a `FIELD_ACCESS` for field stores.

If this turns out to be more churn than expected, fall back to deferring field-writes. The Phase 1 test program does not exercise it, so the phase can ship without it. But it's small enough that doing it now is preferred.

### f) Type annotations may be struct names

`parseVarDecl`, `parseFunctionDecl`, `parseFunctionParam` already call `parseIdentAsName()` for type annotations. Nothing changes at the parser level — the resolution happens in the typechecker, where struct names are looked up in the same name table as primitives.

---

## 4. Typechecker changes ([typecheck.js](../src/jsyooptypecheck/typecheck.js))

### a) Two-stage struct registration

Today's pre-pass walks `ast.body` once and records function signatures ([typecheck.js:39-57](../src/jsyooptypecheck/typecheck.js#L39-L57)). Split it into three phases:

```
phase A: struct names
  for each TYPE_DECL in ast.body:
    if structTable.has(name): error "redeclaration of type"
    else: structTable.set(name, StructType(name, /*fields=*/null))   // shell

phase B: struct fields
  for each TYPE_DECL in ast.body:
    fields = []
    for each FIELD_DECL:
      t = resolveTypeName(field.type, structTable)
      if !t: error "unknown type 'X' in field 'foo' of struct 'S'"
        t = ErrorType()
      check no duplicate field name in this struct
      fields.push({ name: field.name, type: t })
    structTable.get(structDecl.name) = StructType(name, fields)
    typeDecl.resolvedType = that StructType

phase C: function signatures (uses both prims and structs)
  for each FUNCTION_DECL:
    same as today, but resolveTypeName instead of primTypeFromName
```

Two-stage struct registration (A then B) handles forward references: `type A { b: B }` and `type B { ... }` both work, regardless of declaration order.

`resolveTypeName(name, structTable)` is the new helper:

```js
function resolveTypeName(name, structTable) {
  return primTypeFromName(name) ?? structTable.get(name) ?? null;
}
```

Recursive struct types (`type Node { next: Node }`) — the field's type is the `StructType` object from the table, which is the same object the struct itself is registered as. That's a self-reference. For now, that *would* be infinite size at codegen, so reject it: in phase B, if a field's resolved type is a `StructType` and the field's containing struct's name appears anywhere in that field's type tree (without going through a `ref`), error: `recursive struct "X" requires ref or pointer indirection`. Phase 4 will introduce `ref` and this check loosens.

Pseudocode:

```js
function detectRecursiveField(structName, fieldType, visited = new Set()) {
  if (fieldType.kind === "struct") {
    if (fieldType.name === structName) return true;
    if (visited.has(fieldType.name)) return false;
    visited.add(fieldType.name);
    for (const f of fieldType.fields) {
      if (detectRecursiveField(structName, f.type, visited)) return true;
    }
  }
  return false;
}
```

### b) Resolve struct names in let/const/param/return-type annotations

Replace every call to `primTypeFromName(node.type)` in [typecheck.js](../src/jsyooptypecheck/typecheck.js) with `resolveTypeName(node.type, ctx.structTable)`. The pre-pass already populated `structTable`, so by the time `checkFunction` runs, struct names resolve cleanly.

Affected sites:
- [typecheck.js:50](../src/jsyooptypecheck/typecheck.js#L50) (param type in pre-pass funcType build)
- [typecheck.js:52](../src/jsyooptypecheck/typecheck.js#L52) (return type in pre-pass)
- [typecheck.js:161](../src/jsyooptypecheck/typecheck.js#L161) (param type in checkFunction)
- [typecheck.js:171](../src/jsyooptypecheck/typecheck.js#L171) (return type in checkFunction)
- [typecheck.js:200](../src/jsyooptypecheck/typecheck.js#L200) (let/const declared type)

Thread `structTable` through the `ctx` object so per-function checks can reach it.

### c) `FIELD_ACCESS` in `checkExpr`

```
case FIELD_ACCESS:
  objType = checkExpr(node.object, scope, ctx)
  if objType.kind == "error":
    node.resolvedType = ErrorType()
    return node.resolvedType
  if objType.kind != "struct":
    error: "field access on non-struct type <formatType(objType)>"
    node.resolvedType = ErrorType()
    return
  field = objType.fields.find(f => f.name == node.field)
  if !field:
    error: "type '<objType.name>' has no field '<node.field>'"
    node.resolvedType = ErrorType()
    return
  node.resolvedType = field.type
  return field.type
```

### d) `STRUCT_LITERAL` in `checkExpr`

A struct literal must know its target type. There's no way to type a bare `{ x: 1 }` without context. The typechecker takes a target type from the surrounding context — already plumbed for literal coercion. Two options:

1. Pass `expectedType` through `checkExpr(node, scope, ctx, expectedType)`. Today `checkExpr` doesn't take this parameter; would have to thread it through every recursion.
2. After `checkExpr` returns, the *caller* (let-decl, return, call-arg, assignment) inspects what came back. If it's `STRUCT_LITERAL` with no `resolvedType` yet, the caller pins it.

Option 2 is closer to how literal coercion already works in this codebase: see [typecheck.js:216-232](../src/jsyooptypecheck/typecheck.js#L216-L232) (let-decl coerces untyped int/float literals after the fact).

So the rule for `STRUCT_LITERAL` in `checkExpr`:
- Walk each field's `value` (recurse into `checkExpr`).
- Set `node.resolvedType = null` for now (signals "needs target").
- Return a sentinel — `UntypedStructType()`? Or just leave `resolvedType` unset and have callers detect it.

Cleanest: introduce a new `UntypedStructType` (parallel to `UntypedIntType`) carrying the literal's parsed shape (`{ fields: [{ name, valueType }] }`). Then `assignable(StructType, UntypedStructType)` checks shape compatibility; the caller then calls a new `coerceStructLiteralToType(node, structType)` that pins it.

Actually simpler: don't introduce `UntypedStructType` at all. Just let `STRUCT_LITERAL` produce `ErrorType` if no caller pins it, and have specific callers (`letDecl` initializer, `returnStatement`, call args, assignment RHS) special-case `STRUCT_LITERAL` *before* recursing. Pseudocode for the let-decl path:

```js
if (node.assignment?.kind === ASTNodeKind.STRUCT_LITERAL) {
  pinStructLiteral(node.assignment, declaredType, ctx);
} else {
  // existing path: checkExpr then assignability check
}

function pinStructLiteral(litNode, targetType, ctx) {
  if (targetType.kind !== "struct") {
    error "struct literal cannot be assigned to non-struct type X";
    litNode.resolvedType = ErrorType();
    return;
  }
  const declaredFields = new Map(targetType.fields.map(f => [f.name, f.type]));
  const seen = new Set();
  for (const lf of litNode.fields) {  // STRUCT_LITERAL_FIELD
    if (seen.has(lf.name)) error "duplicate field"; seen.add(lf.name);
    const expected = declaredFields.get(lf.name);
    if (!expected) {
      error "struct '<X>' has no field '<lf.name>'"; continue;
    }
    const valueType = checkExpr(lf.value, scope, ctx);
    if (!isAssignable(expected, valueType)) {
      error "field '<lf.name>': cannot assign <valueType> to <expected>";
    }
    if (isLiteralCoercible(valueType, expected)) {
      coerceLiteralToType(lf.value, expected, ctx.errors);
    }
    lf.resolvedType = expected;
  }
  for (const declF of targetType.fields) {
    if (!seen.has(declF.name)) {
      error "missing field '<declF.name>' in struct literal";
    }
  }
  litNode.resolvedType = targetType;
}
```

Use this same pinning logic from:
- `LET_DECL` / `CONST_DECL` initializers ([typecheck.js:206-233](../src/jsyooptypecheck/typecheck.js#L206-L233))
- `RETURN_STATEMENT` value ([typecheck.js:260-267](../src/jsyooptypecheck/typecheck.js#L260-L267))
- `ASSIGNMENT` RHS (when LHS is a struct-typed lvalue)
- Call argument when param is struct-typed (`checkCallWithSig`, [typecheck.js:582-593](../src/jsyooptypecheck/typecheck.js#L582-L593))

If a `STRUCT_LITERAL` shows up in `checkExpr` with no caller having pinned it (e.g., `{x:1, y:2};` as an expression statement), error: `struct literal has no target type`. Set `resolvedType = ErrorType()`.

### e) `ASSIGNMENT` with `target: FIELD_ACCESS`

Replace [typecheck.js:518-557](../src/jsyooptypecheck/typecheck.js#L518-L557):

```
case ASSIGNMENT:
  if node.target.kind == IDENT:
    // existing logic, scoped to lookup by node.target.name
  else if node.target.kind == FIELD_ACCESS:
    targetType = checkExpr(node.target, scope, ctx)  // already validates field exists
    if targetType.kind == "error":
      node.resolvedType = ErrorType(); return
    valueType = checkExpr(node.value, scope, ctx)
    if !isAssignable(targetType, valueType):
      error
    // (literal coercion / struct-literal pinning if applicable)
    node.resolvedType = targetType
  else:
    error: "invalid assignment target"
```

Mutability of struct fields: a field on a `let p: Point` is mutable (writeable); on a `const p: Point` it isn't. Walk the field-access chain back to its root and check the root binding's `kind`. Pseudocode:

```js
function rootIdentOf(node) {
  while (node.kind === FIELD_ACCESS) node = node.object;
  return node.kind === IDENT ? node : null;
}
```

If the root binding is `const`, error: `cannot assign to field of const "<x>"`.

### f) `isAssignable` — already mostly works for structs

`typesEqual` ([types.js:146-164](../src/jsyooptypecheck/types.js#L146-L164)) already handles struct equality nominally + structurally. Two `StructType`s with the same name AND same fields are equal. For Phase 1.3's nominal-typing model, name-equality alone would suffice — but the existing code is fine as-is.

Note: [types.js:150](../src/jsyooptypecheck/types.js#L150) iterates `Object.keys(a.fields)` — that assumes `fields` is an object. The `StructType` factory at [types.js:108](../src/jsyooptypecheck/types.js#L108) takes whatever you pass. Make sure `fields` is consistently an array of `{ name, type }` (matching the per-roadmap convention) and update `typesEqual` accordingly:

```js
if (a.kind === typeKinds.struct) {
  if (a.name !== b.name) return false;
  if (a.fields.length !== b.fields.length) return false;
  for (let i = 0; i < a.fields.length; i++) {
    if (a.fields[i].name !== b.fields[i].name) return false;
    if (!typesEqual(a.fields[i].type, b.fields[i].type)) return false;
  }
  return true;
}
```

### g) `formatType` — extend struct case

Current [typecheck.js:670](../src/jsyooptypecheck/typecheck.js#L670): `return \`struct ${t.name}\`;` — fine. Keep.

### h) Template literals — disallow struct interpolation

`printf(\`p = ${p}\n\`)` where `p: Point` — currently the typechecker rejects anything that isn't string/int/float ([typecheck.js:489-503](../src/jsyooptypecheck/typecheck.js#L489-L503)). Already correctly produces an error for struct types. Verify the negative test catches `${p}`.

---

## 5. Codegen changes ([codegen.js](../src/jsyoopcodegen/codegen.js))

### a) Emit struct-type declarations at module top

Before the existing function-sig pre-pass in `emitProgram` ([codegen.js:533-541](../src/jsyoopcodegen/codegen.js#L533-L541)), add:

```js
const structDefs = [];
const structTable = new Map(); // name -> resolvedType (from typechecker)
for (const decl of node.body) {
  if (decl.kind === ASTNodeKind.TYPE_DECL) {
    structTable.set(decl.name, decl.resolvedType);
    const fieldLlvm = decl.resolvedType.fields
      .map(f => llvmType(f.type))
      .join(", ");
    structDefs.push(`%struct.${decl.name} = type { ${fieldLlvm} }`);
  }
}
```

Append `structDefs` to the prelude (before `globals`). The final IR looks like:

```
%struct.Point = type { i32, i32 }

@.str0 = private unnamed_addr constant [...] ...

define i32 @distance_sq(%struct.Point %p.arg) { ... }
define i32 @main() { ... }
```

### b) `llvmType` accepts `Type` objects (already mostly does)

After Phase 1.2, `llvmType` should accept a `Type` object. Today it still takes a string ([codegen.js:26-28](../src/jsyoopcodegen/codegen.js#L26-L28)). Refactor to:

```js
function llvmType(t) {
  if (typeof t === "string") return LLVM_TYPES[t] ?? "ptr";  // back-compat shim
  switch (t.kind) {
    case "prim": return LLVM_TYPES[t.name] ?? "ptr";
    case "struct": return `%struct.${t.name}`;
    case "void": return "void";
    case "ref": return "ptr";
    default: throw new Error(`llvmType: unsupported kind ${t.kind}`);
  }
}
```

Update every call site that currently passes a string (most pass `node.resolvedType.name` today — change those to pass `node.resolvedType`).

### c) Local struct allocation

In `LET_DECL` / `CONST_DECL` handling ([codegen.js:415-428](../src/jsyoopcodegen/codegen.js#L415-L428)):

- For prim types: `alloca i32, align 4` — unchanged.
- For struct types: `alloca %struct.Point, align <max-field-align>`. Use a helper `alignOfStruct(structType)` that returns `Math.max(...fields.map(f => alignOf(llvmType(f.type))))`.

After alloca, if there's an initializer:
- If RHS is a `STRUCT_LITERAL`, materialize directly into `%name` (see (e) below).
- If RHS is another struct expression (call result or another struct local), emit a memcpy (see (f)).

### d) Field read — `FIELD_ACCESS` in `emitExpr`

```
case FIELD_ACCESS:
  objPtr, objType = emitLvalue(node.object, fnLines)
    // objPtr is a pointer to the struct; objType is StructType
  fieldIdx = objType.fields.findIndex(f => f.name == node.field)
  fieldType = objType.fields[fieldIdx].type
  llvmFieldTy = llvmType(fieldType)
  gepTmp = freshTemp()
  fnLines.push(
    `${gepTmp} = getelementptr inbounds %struct.${objType.name}, ptr ${objPtr}, i32 0, i32 ${fieldIdx}`
  )
  loadTmp = freshTemp()
  fnLines.push(`${loadTmp} = load ${llvmFieldTy}, ptr ${gepTmp}`)
  return { val: loadTmp, yoopType: fieldType }
```

Need a new helper `emitLvalue(node, fnLines)` that returns a *pointer* to the value, not the loaded value. For `IDENT`, it's `%name` (the alloca slot). For nested `FIELD_ACCESS`, it returns a chain of GEPs without the final `load`. Today's `emitExpr` for `IDENT` always loads ([codegen.js:217-226](../src/jsyoopcodegen/codegen.js#L217-L226)) — that's correct for r-value contexts. For l-value (LHS of assignment, or base of field access on an aggregate), we need the pointer.

```
emitLvalue(node, fnLines):
  switch node.kind:
    case IDENT:
      // the alloca for that name, no load
      return { ptr: `%${node.name}`, type: symbols.get(node.name) }
    case FIELD_ACCESS:
      base = emitLvalue(node.object, fnLines)
      // base.type must be StructType
      fieldIdx = ...; fieldType = ...
      gepTmp = freshTemp()
      fnLines.push(`${gepTmp} = getelementptr inbounds %struct.${base.type.name}, ptr ${base.ptr}, i32 0, i32 ${fieldIdx}`)
      return { ptr: gepTmp, type: fieldType }
    default:
      throw "not an lvalue"
```

### e) Field write — `ASSIGNMENT` with `FIELD_ACCESS` target

```
case ASSIGNMENT:
  if target.kind == IDENT:
    rhs = emitExpr(node.value, fnLines)
    fnLines.push(`store ${llvmType(targetType)} ${rhs.val}, ptr %${target.name}`)
  else if target.kind == FIELD_ACCESS:
    lv = emitLvalue(node.target, fnLines)
    rhs = emitExpr(node.value, fnLines)
    fnLines.push(`store ${llvmType(lv.type)} ${rhs.val}, ptr ${lv.ptr}`)
```

### f) Struct literal — `STRUCT_LITERAL`

Two contexts:
1. **Direct initializer of a let/const**: write fields directly into the alloca'd slot — no temporary needed.
2. **Embedded** (call arg, return value, assignment RHS to a non-fresh slot): alloca a temp, populate it, then load (or memcpy) into the destination.

For Phase 1.3, do (1) as a special-case inline in the let-decl codegen path; do (2) by alloca + populate + load.

```
emitStructLiteralInto(node, destPtr, structType, fnLines):
  // populate the alloc'd slot at destPtr field-by-field
  for each litField in node.fields:
    fieldIdx = structType.fields.findIndex(f => f.name == litField.name)
    fieldType = structType.fields[fieldIdx].type
    gepTmp = freshTemp()
    fnLines.push(`${gepTmp} = getelementptr inbounds %struct.${structType.name}, ptr ${destPtr}, i32 0, i32 ${fieldIdx}`)
    rhs = emitExpr(litField.value, fnLines)
    fnLines.push(`store ${llvmType(fieldType)} ${rhs.val}, ptr ${gepTmp}`)

emitExpr(STRUCT_LITERAL):
  // r-value context — alloca a temp, populate, return as a struct value
  structType = node.resolvedType
  tmpPtr = freshTemp()  // actually need to use a fresh name like %lit0, since alloca needs a unique name
  fnLines.push(`${tmpPtr} = alloca %struct.${structType.name}, align ${alignOfStruct(structType)}`)
  emitStructLiteralInto(node, tmpPtr, structType, fnLines)
  loadTmp = freshTemp()
  fnLines.push(`${loadTmp} = load %struct.${structType.name}, ptr ${tmpPtr}`)
  return { val: loadTmp, yoopType: structType }
```

In the let-decl case, peephole-special:

```
case LET_DECL/CONST_DECL:
  alloca the slot %name
  if node.assignment?.kind == STRUCT_LITERAL:
    emitStructLiteralInto(node.assignment, `%${name}`, declaredType, fnLines)
  else if node.assignment is some other struct expr:
    rhs = emitExpr(node.assignment, fnLines)  // returns {val: %loaded, yoopType: StructType}
    fnLines.push(`store %struct.X ${rhs.val}, ptr %${name}`)
  else:
    // existing prim path: emitExpr + store
```

### g) Struct call args & returns

LLVM IR can pass and return aggregates by value directly; the backend handles ABI lowering. Don't need `byval`/`sret` for Phase 1.3.

Param sig in `emitFunction` ([codegen.js:502-504](../src/jsyoopcodegen/codegen.js#L502-L504)):

```js
const paramSig = params
  .map(p => `${llvmType(p.resolvedType)} %${p.name}.arg`)
  .join(", ");
```

For struct param: `%struct.Point %p.arg`. Inside the function, allocate a slot and store the param into it (same pattern as for prims today, [codegen.js:511-517](../src/jsyoopcodegen/codegen.js#L511-L517)).

Call site ([codegen.js:271-298](../src/jsyoopcodegen/codegen.js#L271-L298)):

For each struct arg:
- If arg is an `IDENT` of a struct local: `load %struct.Point, ptr %p` first, then pass the loaded value as `%struct.Point %tmp`.
- If arg is a struct r-value (`STRUCT_LITERAL`, call result): `emitExpr` already returns the loaded value. Pass directly.

Return: `ret %struct.Point %loaded` for struct returns. Mostly already works through the existing `ret` path; just verify `llvmType(returnType)` produces `%struct.Point`.

### h) Update `printfSpec` / `promotedLlvmType` to reject structs explicitly

Today these throw on unknown types. After typechecker rejection of struct interpolation, codegen shouldn't see them — but harden anyway:

```js
function printfSpec(t) {
  if (t.kind === "struct") {
    throw new Error("codegen bug: struct reached printf — typechecker should have rejected");
  }
  ...
}
```

### i) `symbols` map now stores `Type` objects

Today `symbols` is `varName -> string` ([codegen.js:158](../src/jsyoopcodegen/codegen.js#L158)). After Phase 1.2 it should already be `varName -> Type`. If not yet, do that now — every load/store call site reads it.

---

## 6. Driver — no changes

`yoopiler.js` already wires typecheck between parse and codegen. The errors collection format is unchanged. ✓

---

## 7. Test programs

### Positive — must compile and run

#### Phase 1.3 canonical test (the one in the roadmap)

```yoop
type Point {
    x: int32,
    y: int32,
}

function distance_sq(p: Point): int32 {
    return p.x * p.x + p.y * p.y;
}

function main(): int32 {
    let p: Point = { x: 3, y: 4 };
    printf(`distance_sq = ${distance_sq(p)}\n`);
    return 0;
}
```

Expected output: `distance_sq = 25`

#### Field write

```yoop
type Counter { value: int32, }

function main(): int32 {
    let c: Counter = { value: 0 };
    c.value = c.value + 10;
    c.value = c.value * 2;
    printf(`c.value = ${c.value}\n`);
    return 0;
}
```

Expected output: `c.value = 20`

#### Struct return

```yoop
type Pair { a: int32, b: int32, }

function make_pair(): Pair {
    return { a: 7, b: 11 };
}

function main(): int32 {
    let p: Pair = make_pair();
    printf(`a=${p.a} b=${p.b}\n`);
    return 0;
}
```

Expected output: `a=7 b=11`

#### Forward reference between structs

```yoop
type B { v: int32, }
type A { inner: B, }   // declared before B's fields are known? — no, all fields resolve

function main(): int32 {
    let a: A = { inner: { v: 42 } };
    printf(`a.inner.v = ${a.inner.v}\n`);
    return 0;
}
```

Verifies: nested struct literals; chained field access (`a.inner.v`); two-stage struct registration handles either declaration order.

### Negative — must produce a single positioned typecheck error

| Program snippet | Expected error |
|---|---|
| `type Point { x: int32 } let p: Point = { x: 1, y: 2 };` | `struct 'Point' has no field 'y'` |
| `type Point { x: int32, y: int32 } let p: Point = { x: 1 };` | `missing field 'y' in struct literal` |
| `type Point { x: int32 } let p: Point = { x: "hi" };` | `field 'x': cannot assign string to int32` |
| `type Point { x: int32 } let p: Point = 42;` | `cannot assign untyped int to struct Point` |
| `type Point { x: int32 } function f(p: Point): int32 { return p.z; }` | `type 'Point' has no field 'z'` |
| `function f(): int32 { let x: int32 = 5; return x.y; }` | `field access on non-struct type int32` |
| `type A {} type A {}` | `redeclaration of type 'A'` |
| `type Point { x: int32, x: int32 }` | `duplicate field 'x' in struct 'Point'` |
| `type Bad { f: nope }` | `unknown type 'nope' in field 'f' of struct 'Bad'` |
| `type Loop { next: Loop }` | `recursive struct 'Loop' requires ref` |
| `type Point { x: int32 } const p: Point = { x: 1 }; p.x = 2;` | `cannot assign to field of const "p"` |
| `printf(\`p=${p}\n\`)` (where `p: Point`) | `template literal interpolation must be a string, int, or float type, found struct Point` |

### Multi-error case

```yoop
type Point { x: int32, y: int32, }

function main(): int32 {
    let p: Point = { x: "wrong", z: 99 };
    return p.q;
}
```

Three errors expected:
1. `field 'x': cannot assign string to int32`
2. `struct 'Point' has no field 'z'`
3. plus implicitly `missing field 'y' in struct literal`
4. `type 'Point' has no field 'q'`

(Exact count can vary depending on whether you stop after the literal-pinning error or keep reporting.)

### Codegen smoke

The Phase 1.1 numeric program and Phase 1.2 typed-arithmetic programs must continue producing identical IR (no struct path means no new code gets exercised).

---

## 8. Edge cases worth getting right

- **Trailing comma in `type` body**: `type P { x: int32, y: int32, }` — already handled by the optional-comma loop. Verify.
- **Trailing comma in struct literal**: `{ x: 1, y: 2, }` — same.
- **Empty struct**: `type Empty {}` — legal? Spec doesn't forbid it; codegen should emit `%struct.Empty = type { }`. Allow it; struct literal `{}` for an empty struct works as the only valid initializer.
- **Field order in literal vs decl**: `let p: Point = { y: 4, x: 3 };` — order doesn't have to match declaration. The pinning logic uses the declared field map, not positional. Correct value goes to correct slot regardless of literal order.
- **Nested struct literals as struct-decl initializers**: `let a: A = { inner: { v: 42 } };` — recursion through `pinStructLiteral` handles this.
- **Field access on struct r-value** (call result): `make_pair().a` — needs `emitLvalue` to handle this *or* explicit alloca-and-store first. For Phase 1.3, simplest: reject in the parser's postfix loop only if the typechecker can't model it. Actually, you can model it as: `make_pair()` returns a struct value (loaded), store it into a fresh alloca, GEP into that. Slightly more complex `emitLvalue`. Could defer if needed; the canonical test program doesn't exercise it.
  - **Recommended**: support it, it's not much extra code: `emitLvalue` for any expression node that isn't IDENT/FIELD_ACCESS falls back to `emitExpr` then materializes into a fresh alloca.
- **Self-referencing struct without ref**: caught by `detectRecursiveField` check above.
- **Struct in template literal interpolation**: typechecker rejects. Codegen never sees one.
- **Struct equality**: `p1 == p2` — typechecker says no (`unifyArith` returns `null` for two `StructType`s with `eqeq`). Verify negative test.
- **Param-name collision with field name**: `function f(x: int32, p: Point): int32 { return p.x; }` — `x` is in scope as a param, `p.x` is a field access. The postfix `.x` runs on the result of looking up `p`, not on the bare `x`. ✓
- **Block vs struct-literal disambiguation**: covered in §3(d). The fact that statements always re-enter expression parsing through `parseStatement` (which doesn't itself accept `{`) means a bare `{` reaching `parseExpression` is unambiguously a struct literal.

---

## 9. Out of scope (for clarity)

- **Methods / `implements`** — Phase 5
- **Default field values** — `type P { x: int32 = 0 }` — not in spec
- **Field-init shorthand** — `let p: Point = { x, y };` (using locals named `x`, `y`) — not in spec for v2
- **Spread / partial update** — `{ ...p, x: 5 }` — not in spec
- **Anonymous structs** — `let p: { x: int32, y: int32 } = ...` — not in spec
- **Generic structs** — deferred
- **Pattern matching on structs** — Phase 7
- **Bitfields, packed structs, alignment overrides** — not in spec for v2
- **`sret` / `byval` ABI lowering** — let LLVM handle it; revisit only if a real ABI need shows up

---

## 10. Phase exit criteria

- All Phase 1.1 and 1.2 test programs continue to produce identical output.
- The roadmap's canonical test program ([roadmap.md §1.3](./roadmap.md)) compiles, runs, and prints `distance_sq = 25`.
- Each negative-case program from §7 produces exactly one error at the right position and does not crash.
- The multi-error case reports every distinct error.
- [codegen.js](../src/jsyoopcodegen/codegen.js) emits `%struct.X = type { ... }` for every `type` decl, before any function definition.
- Field reads use `getelementptr inbounds` + `load`; field writes use `getelementptr inbounds` + `store`.
- Struct values pass as parameters and return from functions; `clang` compiles the IR without warnings or errors.
- `node ./src/yoopiler.js` (test mode) still runs `runTests()`; if a `testTypecheck()` is added for struct cases, all assertions pass.

---

## 11. Implementation order (recommended)

If you want to stage the work in commits, this order minimizes broken intermediate states:

1. **Lexer**: add `type` keyword and `.` token. Verify existing tests still pass.
2. **AST node kinds** in [contracts.js](../src/contracts.js).
3. **Parser**:
   a. `parseTypeDecl` + top-level dispatch
   b. Postfix `.field` loop (no struct literal yet — `p.x` reads still only work in r-value position once typechecker/codegen catch up; but parser tests can already verify the AST shape)
   c. Struct-literal prefix `{ ... }`
   d. `ASSIGNMENT` generalization to `target` (only if doing field-writes now)
4. **Typechecker** (`typecheck.js`):
   a. Two-stage struct registration
   b. `resolveTypeName` everywhere
   c. `FIELD_ACCESS` case
   d. `pinStructLiteral` + thread it through let/return/call/assignment
   e. `ASSIGNMENT` with field target
   f. Recursive-struct rejection
5. **Codegen** ([codegen.js](../src/jsyoopcodegen/codegen.js)):
   a. Emit `%struct.X` declarations
   b. `llvmType` accepts struct types
   c. `alloca`, GEP-load (field read)
   d. `emitLvalue` helper, GEP-store (field write)
   e. `emitStructLiteralInto` (initializer fast path)
   f. R-value struct literal (alloca + populate + load)
   g. Struct call args and returns
6. **Tests**: write each negative-case program as a fixture; assert error count and message; include the positive programs in an `examples/pass/` directory and write a tiny runner that compiles each and asserts return code / stdout.

Each step in 3–5 should keep the existing test programs compiling. Incremental commits make bisecting easy if something breaks.

---

## Critical files reference

- [SPEC.md §3 — Types](../SPEC.md) — struct semantics
- [src/contracts.js](../src/contracts.js) — AST node kinds
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — `type` keyword, `.` token
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — `parseTypeDecl`, postfix field-access, struct literal
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) — `StructType`, `resolveTypeName`
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) — struct registration, field rules, struct-literal pinning
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — `%struct.X` emission, GEP, struct pass-by-value
