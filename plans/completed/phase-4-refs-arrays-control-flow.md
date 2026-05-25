# Phase 4 - Refs, arrays, control flow gaps

Part of the [roadmap](./roadmap.md). Phase 3 landed modules and FFI. Programs can now call C functions and compose across files, but they still can't pass mutable output parameters, work with collections of values, or use a numeric for-loop. This phase fills those gaps - none requiring traits or kinds - and adds explicit casts to make cross-type arithmetic practical.

## Goal

Land working support for [SPEC.md §3 - refs and arrays](../SPEC.md), [§9 - loops](../SPEC.md), [§10 - control flow](../SPEC.md), and [§2 - casts](../SPEC.md):

```yoop
// refs.yoop
extern "C" from "stdio.h" {
    function printf(fmt: string, ...): int32;
}

function increment(ref n: int32): void {
    n = n + 1;
}

function sum(xs: int32[], len: usize): int32 {
    let total: int32 = 0;
    let i: usize = 0;
    for (i = 0; i < len; i = i + 1) {
        total = total + xs[i];
    }
    return total;
}

function find_first_big(xs: int32[]): int32 {
    let i: usize = 0;
    for (i = 0; i < xs.len; i = i + 1) {
        if (xs[i] > 25) {
            break;
        }
    }
    if (i >= xs.len) {
        return -1;
    }
    return xs[i];
}

function main(): int32 {
    let xs: int32[] = [10, 20, 30, 40, 50];
    let total: int32 = sum(xs, xs.len);
    increment(ref total);

    let big: int32 = find_first_big(xs);
    printf(`total=%d big=%d\n`, total, big);

    let f: float32 = float32(total);
    let b: uint8   = uint8(total & 0xFF);
    printf(`as float=%f as byte=%d\n`, f, b);
    return 0;
}
```

`yoopiler refs.yoop` must compile and print `total=151 big=30` followed by `as float=151.000000 as byte=151`.

Concretely:

- `ref T` as a type annotation for bindings (`let p: ref int32`). `ref T` as a parameter modifier (`ref n: int32`). `ref x` at call sites to form a reference. Auto-deref on all reads and writes of a `ref` binding.
- `T[]` as an array type. Array literals `[e1, e2, e3]`. `xs[i]` indexing. `xs.len` intrinsic returning `usize`. Arrays are fat pointers (ptr + len) passed by value.
- `for (ident = expr; cond; ident = expr) { ... }` where the loop variable is pre-declared.
- `break` and `continue` inside `while` and `for` loops.
- `else if` chaining - already implemented in the parser; this phase adds tests and confirms the full pipeline handles it.
- Numeric casts as type-name calls: `int64(x)`, `float32(x)`, `uint8(x & 0xFF)`.

## Why this is next

Phase 3 made FFI practical: programs can now call `fread`, `fwrite`, `malloc`. But those functions take pointers and work on buffers. Without `ref T` for pointer-passing and `T[]` for buffer representation, FFI is limited to primitives. The `fread` / `fwrite` signatures alone require both.

The `for` loop is necessary the moment you touch an array. `break` and `continue` are regularly expected in any loop. Casts are needed as soon as you do boundary arithmetic: `fread` returns `usize`; feeding that back into an `int32` operation needs a cast.

None of these features require traits, kinds, or generics. Phase 5 (traits) needs `self: ref T` parameters, which depend on phase 4's `ref` support. Phase 6 (kinds) needs fat-pointer arrays for `T[]` slice semantics. Getting this right now unblocks both.

## Scope (what this phase does NOT do)

- **No heap allocation.** Arrays are stack-allocated in v0. `malloc` is available via an extern, but the language has no `new` keyword and no garbage collector. Users who need heap buffers call `malloc`/`free` through externs and use the raw pointer with extern functions directly - no fat-pointer wrapping.
- **No bounds checking.** `xs[i]` emits a bare GEP + load. Out-of-bounds is UB in v0. Bounds checks come in a future quality pass.
- **No arrays of arrays** (`int32[][]`). The parser and type system accept the syntax but the typechecker rejects at phase 4 with a clear "nested arrays not yet supported" error.
- **No slices / subarray syntax.** `xs[a..b]` is reserved syntax per the spec; not in v0.
- **No `for item in xs` iteration** - that requires the `Iterable` trait (phase 5).
- **No `ref ref T`.** Double refs are rejected by the typechecker.
- **No `ref T` return type.** Functions may not return a ref - the referenced binding could have expired. This restriction can be loosened when lifetime analysis lands (phase 7+).
- **No struct auto-ref unpacking.** `ref point: Point` is not supported as a param modifier in phase 4. `ref` params must have a primitive or array base type. Struct refs come in phase 5 when `self: ref T` is wired up.
- **No unsafe pointer arithmetic.** The `unsafe_ptr` kind is phase 6.
- **No cast from/to `string`, `bool`, or struct types** - only numeric primitive ↔ numeric primitive casts.
- **No array assignment** (`xs[i] = v` is implemented; but `xs = ys` replaces the fat pointer, which works naturally since arrays are value types in the fat-pointer model).

---

## Status snapshot

After phase 3, the compiler has:

- Full module graph, imports/exports, extern FFI.
- `for` keyword already in the lexer (`for: 20`) but no parser for it.
- `else if` already works in the parser - `parseIfStatement` recurses via `else if` lookahead at [parser.js:641-643](../src/jsyooparser/parser.js#L641-L643). The typechecker and codegen already handle an IF_STATEMENT whose `elseBody` is itself an IF_STATEMENT.
- `RefType { inner }` and `ArrayType { elem }` constructors exist in [types.js](../src/jsyooptypecheck/types.js#L112-L113) as placeholders but the typechecker never produces them.
- Type annotations are stored as plain strings everywhere (`node.type`, `param.type`, `node.returnType`). `resolveTypeFromName(str, structTable)` converts a string to a `Type` object.

Phase 4 needs to:

1. Add new tokens: `ref`, `break`, `continue`, `[`, `]`.
2. Promote type annotation storage from plain strings to structured annotation nodes (required for `ref T` and `T[]`).
3. Add parser for for-loops, break, continue, `ref x` expressions, array literals, array indexing.
4. Activate `RefType` and `ArrayType` in the typechecker.
5. Implement ref/array/for/break/continue/cast codegen.

---

## Files touched

- [src/contracts.js](../src/contracts.js) - six new AST node kinds.
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) - five new tokens.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) - `parseTypeAnnotation`, for-loop, break, continue, `ref` expressions, array literals, array indexing.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) - extend `resolveTypeFromName` to handle annotation objects; add `isCastableTo(src, dst)`, `castInstruction(src, dst)`.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) - ref expression, array literal, index expression, cast detection in call resolution.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js) - for-loop, break, continue; loop-depth tracking on `ctx`.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) - ref LLVM emit, array fat-pointer LLVM emit, for-loop LLVM emit, break/continue label threading, cast instruction emit.
- [src/e2e.test.js](../src/e2e.test.js) - new pass + fail fixtures.
- [examples/pass/](../examples/pass/) - new programs (§9).
- [examples/fail/](../examples/fail/) - new negative test programs (§9).

---

## 1. AST node kinds ([contracts.js](../src/contracts.js))

Add:

```js
FOR_LOOP: "FOR_LOOP",
//   { initIdent: string, initExpr: ASTNode,
//     cond: ASTNode,
//     stepIdent: string, stepExpr: ASTNode,
//     body: BLOCK,
//     sourceLoc }

BREAK_STATEMENT: "BREAK_STATEMENT",
//   { sourceLoc }

CONTINUE_STATEMENT: "CONTINUE_STATEMENT",
//   { sourceLoc }

ARRAY_LITERAL: "ARRAY_LITERAL",
//   { elements: [ASTNode], sourceLoc }

INDEX_EXPRESSION: "INDEX_EXPRESSION",
//   { object: ASTNode, index: ASTNode, sourceLoc }

REF_EXPRESSION: "REF_EXPRESSION",
//   { operand: ASTNode, sourceLoc }
```

Why each is separate:
- `FOR_LOOP` carries three init/cond/step sub-ASTs that a `WHILE_STATEMENT` doesn't have. Reusing `WHILE_STATEMENT` would require nullable fields and special-casing everywhere.
- `BREAK_STATEMENT` and `CONTINUE_STATEMENT` are zero-payload statements; distinct kinds let the typechecker reject them outside loops without touching unrelated statement handling.
- `ARRAY_LITERAL` is not a struct literal and not a call - it has an ordered element list with no field names.
- `INDEX_EXPRESSION` is syntactically similar to `FIELD_ACCESS` but takes an expression index, not a name. Sharing the same node kind would pollute every downstream pass.
- `REF_EXPRESSION` is a unary operator with specific type semantics (`T` → `ref T`). Modeling as `UNARY_EXPRESSION { op: "ref" }` works but makes `resolveUnary` a catch-all for a semantically special form.

---

## 2. Lexer changes ([lexer.js](../src/jsyooplexer/lexer.js))

Five new tokens. Assign tag numbers continuing from 47:

```js
TokenTags.ref:       48,
TokenTags.break:     49,
TokenTags.continue:  50,
TokenTags.lbracket:  51,   // [
TokenTags.rbracket:  52,   // ]
```

Keywords in `keywordTagList`:

```js
ref:      TokenTags.ref,
break:    TokenTags.break,
continue: TokenTags.continue,
```

Punctuation in `tokenScanList`:

```js
{ str: "[", tag: TokenTags.lbracket },
{ str: "]", tag: TokenTags.rbracket },
```

`[` and `]` are single-character and sort correctly among the existing punctuation. No length-ordering issues.

> **`ref` as a keyword.** The spec uses `ref` as both a keyword in parameter lists (`ref n: int32`) and as an expression prefix (`ref n`). Making it a hard keyword removes it as a valid identifier name; the spec implies this - `ref` appears in the reserved-words table (§14). Lock it down now.

> **`break` / `continue` as keywords.** Both appear in the spec's reserved-words table. Hard keywords.

---

## 3. Parser changes ([parser.js](../src/jsyooparser/parser.js))

### 3.a Type annotations become structured objects

Currently every type annotation is stored as a plain string via `parseIdentAsName()`. Phase 4 introduces `ref T` and `T[]` which are compound types. Replace the pattern with a new function `parseTypeAnnotation()` that returns a type annotation object:

```js
// Simple: int32, Point, string
{ kind: "typeName", name: "int32" }

// Ref: ref int32
{ kind: "refType", inner: { kind: "typeName", name: "int32" } }

// Array: int32[]
{ kind: "arrayType", elem: { kind: "typeName", name: "int32" } }

// Nested arrays are parsed but rejected later by the typechecker.
// ref ref T is parsed but rejected later.
```

Implementation:

```js
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
  // optional [] suffix for arrays
  if (peek().tag === TokenTags.lbracket && lookAhead(1).tag === TokenTags.rbracket) {
    advance(); // consume [
    advance(); // consume ]
    annot = { kind: "arrayType", elem: annot };
  }
  return annot;
}
```

`lookAhead(n)` peeks `n` tokens ahead without consuming - needed here to distinguish `T[` (array type) from `xs[i]` (index expression, but that's in expression position, not type-annotation position - so this lookahead isn't needed, just `lbracket` followed immediately by `rbracket` disambiguates). Actually: in type-annotation position, seeing `[` always means it's an array type, because we only call `parseTypeAnnotation` where a type is expected. So just check for `lbracket` and consume both brackets:

```js
if (peek().tag === TokenTags.lbracket) {
  advance();                          // consume [
  expect(TokenTags.rbracket);         // must be ]
  annot = { kind: "arrayType", elem: annot };
}
```

**Call-site migration**: every location that previously called `parseIdentAsName()` in a type-annotation position switches to `parseTypeAnnotation()`. The affected fields change from `node.type = <string>` to `node.typeAnnotation = <object>`:

| Call site | Old field | New field |
|---|---|---|
| `parseFunctionParam` - param type | `param.type` | `param.typeAnnotation` |
| `parseFunctionDecl` / `parseExternFunctionDecl` - return type | `node.returnType` | `node.returnTypeAnnotation` |
| `parseVarDecl` - let/const type | `node.type` | `node.typeAnnotation` |
| `parseTypeDecl` - struct field type | `fieldNode.type` | `fieldNode.typeAnnotation` |

`parseIdentAsName()` continues to be used wherever a plain identifier name is needed (declaration names, import specifiers, namespace names) - only type-annotation call sites switch.

The typechecker's `resolveTypeFromName(name: string, structTable)` is joined by a new function:

```js
export function resolveTypeAnnotation(annot, structTable) {
  if (annot.kind === "typeName") {
    return resolveTypeFromName(annot.name, structTable);
  }
  if (annot.kind === "refType") {
    return RefType(resolveTypeAnnotation(annot.inner, structTable));
  }
  if (annot.kind === "arrayType") {
    return ArrayType(resolveTypeAnnotation(annot.elem, structTable));
  }
  throw new Error(`unknown type annotation kind: ${annot.kind}`);
}
```

Everywhere in the typechecker that previously called `resolveTypeFromName(node.type, ...)`, replace with `resolveTypeAnnotation(node.typeAnnotation, ...)`. The old `resolveTypeFromName` stays for any callers that still pass plain strings (extern decls continue to use `parseIdentAsName` for their type fields - keep those as strings for now; phase 5 can migrate them).

### 3.b `ref` parameter modifier

In `parseFunctionParam` (called from both `parseFunctionDecl` and `parseExternFunctionDecl`):

```js
function parseFunctionParam() {
  const node = buildSourcedNode(ASTNodeKind.PARAM);
  // ref modifier
  if (peek().tag === TokenTags.ref) {
    advance();
    node.isRef = true;
  } else {
    node.isRef = false;
  }
  node.name = parseIdentAsName();
  expect(TokenTags.colon);
  node.typeAnnotation = parseTypeAnnotation();
  return node;
}
```

Param with `isRef: true` has type `RefType { inner: resolvedBaseType }` in the typechecker, regardless of what the user wrote in the type annotation (`ref n: int32` gives type `RefType { inner: int32 }`, not `RefType { inner: RefType { inner: int32 } }`). The `isRef` modifier is the ref; the `typeAnnotation` is the inner type.

### 3.c `ref x` expression

Slot into `parseAtom` before the general ident path:

```js
if (peek().tag === TokenTags.ref) {
  advance();
  const node = buildSourcedNode(ASTNodeKind.REF_EXPRESSION);
  node.operand = parseAtom();   // ref of a field access or ident - no recursive ref
  return node;
}
```

`ref f().x` is syntactically accepted and typecheck-rejected. `ref ref x` is accepted syntactically and rejected by typecheck. Parse leniently, check strictly.

### 3.d `parseForStatement`

```js
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
```

The loop variable is pre-declared; the init and step are plain assignments. No `let` / `const` inside the for header in v0.

Add to `parseStatement`'s switch:

```js
case TokenTags.for:      return parseForStatement();
case TokenTags.break:    return parseBreakStatement();
case TokenTags.continue: return parseContinueStatement();
```

### 3.e `parseBreakStatement` / `parseContinueStatement`

```js
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
```

### 3.f Array literals and indexing

**Array literal** in `parseAtom`: when we see `[` in expression position, parse a comma-separated list of expressions terminated by `]`:

```js
if (peek().tag === TokenTags.lbracket) {
  advance();
  const node = buildSourcedNode(ASTNodeKind.ARRAY_LITERAL);
  node.elements = [];
  while (peek().tag !== TokenTags.rbracket && peek().tag !== TokenTags.eof) {
    node.elements.push(parseExpression());
    if (peek().tag === TokenTags.comma) advance();
  }
  expect(TokenTags.rbracket);
  return node;
}
```

**Array indexing** in the postfix loop (after field access, before assignment check):

```js
if (peek().tag === TokenTags.lbracket) {
  advance();
  const indexNode = buildSourcedNode(ASTNodeKind.INDEX_EXPRESSION);
  indexNode.object = node;
  indexNode.index = parseExpression();
  expect(TokenTags.rbracket);
  node = indexNode;
  continue;
}
```

Precedence: array indexing binds tighter than binary operators, same level as field access. Adding it to the postfix loop (which already handles `.field`) is correct.

### 3.g `xs[i] = v` - index assignment

After the postfix loop, the assignment branch already handles `ASSIGNMENT`. An `INDEX_EXPRESSION` as the LHS of an assignment (`xs[i] = v`) is a valid lvalue. The assignment branch currently checks `if the accumulated node is an IDENT or FIELD_ACCESS` before returning an ASSIGNMENT node. Extend the lvalue check to also accept `INDEX_EXPRESSION`:

```js
if (peek().tag === TokenTags.eq) {
  if (
    node.kind === ASTNodeKind.IDENT ||
    node.kind === ASTNodeKind.FIELD_ACCESS ||
    node.kind === ASTNodeKind.INDEX_EXPRESSION    // new
  ) {
    advance();
    const assignNode = buildSourcedNode(ASTNodeKind.ASSIGNMENT);
    assignNode.target = node;
    assignNode.value = parseExpression();
    return assignNode;
  }
}
```

### 3.h Parser test cases

Additions to [parser.test.js](../src/jsyooparser/parser.test.js):

- `for (i = 0; i < 10; i = i + 1) { }` → `FOR_LOOP { initIdent: "i", ... }`
- `break;` → `BREAK_STATEMENT`
- `continue;` → `CONTINUE_STATEMENT`
- `ref n` → `REF_EXPRESSION { operand: IDENT { name: "n" } }`
- `[1, 2, 3]` → `ARRAY_LITERAL { elements: [3 INT_LITERALs] }`
- `xs[i]` → `INDEX_EXPRESSION { object: IDENT, index: IDENT }`
- `xs[i] = 5;` → `ASSIGNMENT { target: INDEX_EXPRESSION, value: ... }`
- `let p: ref int32 = ref n;` → `LET_DECL { typeAnnotation: { kind: "refType", inner: ... } }`
- `let xs: int32[] = [1, 2];` → `LET_DECL { typeAnnotation: { kind: "arrayType", elem: ... } }`
- `function f(ref n: int32): void {}` → `FUNCTION_DECL { params: [PARAM { isRef: true, name: "n", typeAnnotation: { kind: "typeName", name: "int32" } }] }`

Reject cases:

- `break;` outside any block - parse succeeds, typechecks fails (not a parser error)
- `[1, 2,]` (trailing comma) - should be accepted (trailing commas are fine)
- `for (let i: int32 = 0; ...)` - parse error: expected ident, got `let`

---

## 4. Type system - `resolveTypeAnnotation` ([types.js](../src/jsyooptypecheck/types.js))

`resolveTypeAnnotation` (described in §3.a) joins the existing `resolveTypeFromName`. All typechecker call sites that previously read `node.type` now read `node.typeAnnotation` and call `resolveTypeAnnotation`.

Two new helpers needed for casts (§7):

```js
// Returns true if a numeric cast from `src` to `dst` is valid.
// src and dst must both be numeric primitives (int or float family).
export function isCastableTo(src, dst) {
  if (src.kind !== typeKinds.prim || dst.kind !== typeKinds.prim) return false;
  const numericPrims = [
    "int8","int16","int32","int64",
    "uint8","uint16","uint32","uint64","usize","isize",
    "float32","float64",
  ];
  return numericPrims.includes(src.name) && numericPrims.includes(dst.name);
}

// Returns the LLVM cast opcode string for casting `srcType` to `dstType`.
// Caller must verify isCastableTo first.
export function castInstruction(srcType, dstType) {
  const srcIsFloat = srcType.name.startsWith("float");
  const dstIsFloat = dstType.name.startsWith("float");
  const srcBits = bitWidthOf(srcType.name);  // helper: int8->8, int32->32, float64->64 etc.
  const dstBits = bitWidthOf(dstType.name);

  if (srcIsFloat && dstIsFloat) {
    return srcBits < dstBits ? "fpext" : "fptrunc";
  }
  if (!srcIsFloat && !dstIsFloat) {
    if (srcBits === dstBits) return null;   // no-op, same representation
    if (srcBits < dstBits) {
      return isUnsignedIntPrim(srcType.name) ? "zext" : "sext";
    }
    return "trunc";
  }
  if (!srcIsFloat && dstIsFloat) {
    return isUnsignedIntPrim(srcType.name) ? "uitofp" : "sitofp";
  }
  // float to int
  return isUnsignedIntPrim(dstType.name) ? "fptoui" : "fptosi";
}
```

`bitWidthOf` is a simple helper returning the LLVM bit width for a named primitive type.

---

## 5. Typechecker - `ref` ([checkExpr.js](../src/jsyooptypecheck/checkExpr.js) + [checkStatement.js](../src/jsyooptypecheck/checkStatement.js))

### 5.a `REF_EXPRESSION` resolution

```js
case ASTNodeKind.REF_EXPRESSION: {
  const operandType = resolveExprType(node.operand, scope, ctx);
  if (operandType.kind === typeKinds.error) return setType(node, ErrorType());
  if (operandType.kind === typeKinds.ref) {
    pushError(ctx.errors, node, `cannot take ref of a ref - 'ref ref T' is not supported`);
    return setType(node, ErrorType());
  }
  // Only lvalues can be ref'd: IDENT, FIELD_ACCESS, INDEX_EXPRESSION
  if (
    node.operand.kind !== ASTNodeKind.IDENT &&
    node.operand.kind !== ASTNodeKind.FIELD_ACCESS &&
    node.operand.kind !== ASTNodeKind.INDEX_EXPRESSION
  ) {
    pushError(ctx.errors, node, `cannot take ref of a non-lvalue expression`);
    return setType(node, ErrorType());
  }
  return setType(node, RefType(operandType));
}
```

### 5.b `ref` param call-site matching

In `resolveCall`, when checking each argument against the corresponding param type:

- If `param.isRef` is true: the resolved param type is `RefType { inner: baseType }`. The argument must be a `REF_EXPRESSION` whose operand resolves to `baseType`. Plain values are not implicitly ref'd - the user must write `ref x` at every call site.

```js
if (param.isRef) {
  if (arg.kind !== ASTNodeKind.REF_EXPRESSION) {
    pushError(ctx.errors, arg,
      `parameter "${param.name}" expects a ref - pass with 'ref ${arg.kind === ASTNodeKind.IDENT ? arg.name : "..."}'`);
    continue;
  }
  const innerType = arg.operand.resolvedType;
  if (!typesEqual(innerType, resolveTypeAnnotation(param.typeAnnotation, ctx.structTable))) {
    pushError(ctx.errors, arg,
      `ref argument type ${formatType(innerType)} does not match param type ${formatType(resolveTypeAnnotation(param.typeAnnotation, ctx.structTable))}`);
  }
} else {
  checkInitializer(arg, resolvedParamType, ctx);
}
```

### 5.c Auto-deref on reads and writes

When the typechecker resolves an IDENT whose binding type is `RefType { inner }`:

- **Read context** (the value is used in an expression): the result type is `inner`, not `RefType { inner }`. The typechecker sets `node.autoDeref = true` on the IDENT so codegen knows to emit a double load.
- **Write context** (the IDENT is the target of an ASSIGNMENT): the assignment value must match `inner`, and codegen emits a store-through-pointer.

In `resolveIdent`:

```js
function resolveIdent(node, scope, ctx) {
  const binding = lookupInScope(scope, node.name);
  if (!binding) { /* error */ }
  const bindingType = binding.type;
  if (bindingType.kind === typeKinds.ref) {
    node.autoDeref = true;
    return setType(node, bindingType.inner);   // transparent deref
  }
  return setType(node, bindingType);
}
```

In `resolveAssignment` (target is an IDENT):

```js
const binding = lookupInScope(scope, target.name);
if (binding.type.kind === typeKinds.ref) {
  target.autoDerefWrite = true;
  // value must match inner type
  checkInitializer(assignNode.value, binding.type.inner, ctx);
} else {
  // existing logic
}
```

### 5.d `ref T` return type - rejected

If a function's `returnTypeAnnotation` resolves to `RefType`, reject it at function-validation time:

```js
if (resolvedReturnType.kind === typeKinds.ref) {
  pushError(ctx.errors, funcNode,
    `functions may not return 'ref T' - returning a reference to a local binding is unsafe`);
}
```

---

## 6. Typechecker - arrays ([checkExpr.js](../src/jsyooptypecheck/checkExpr.js))

### 6.a `ARRAY_LITERAL`

```js
case ASTNodeKind.ARRAY_LITERAL: {
  if (node.elements.length === 0) {
    // Empty array literal requires a type annotation context to determine element type.
    // For now, reject.
    pushError(ctx.errors, node, `empty array literal requires explicit type annotation`);
    return setType(node, ErrorType());
  }
  // Infer element type from first element, check all elements match.
  const firstType = resolveExprType(node.elements[0], scope, ctx);
  for (let i = 1; i < node.elements.length; i++) {
    const elemType = resolveExprType(node.elements[i], scope, ctx);
    if (!typesEqual(firstType, elemType)) {
      pushError(ctx.errors, node.elements[i],
        `array literal element ${i} has type ${formatType(elemType)}, expected ${formatType(firstType)}`);
    }
  }
  return setType(node, ArrayType(firstType));
}
```

When the context provides a target array type (e.g., `let xs: int32[] = [1, 2, 3]`), `checkInitializer` coerces the element literals into the declared element type. Use `checkInitializer` on each element against the declared element type when available. When the target type is known (from `let xs: int32[]`), prefer it over inference.

The initializer check in `checkLetOrConst`: if the declared type is `ArrayType { elem: T }` and the initializer is `ARRAY_LITERAL`, check each element against `T` rather than inferring.

### 6.b `xs.len` intrinsic

In `resolveFieldAccess`, add a special case before the struct-field lookup:

```js
if (objectType.kind === typeKinds.array && node.field === "len") {
  node.isArrayLen = true;         // flag for codegen
  return setType(node, PrimType("usize"));
}
```

Any other field access on an array type is an error: `xs.other → type int32[] has no field "other"`.

### 6.c `INDEX_EXPRESSION`

```js
case ASTNodeKind.INDEX_EXPRESSION: {
  const objType = resolveExprType(node.object, scope, ctx);
  const idxType = resolveExprType(node.index, scope, ctx);
  if (objType.kind !== typeKinds.array) {
    pushError(ctx.errors, node, `cannot index non-array type ${formatType(objType)}`);
    return setType(node, ErrorType());
  }
  const isIntIdx = idxType.kind === typeKinds.prim && isIntPrim(idxType.name) ||
                   idxType.kind === typeKinds.untypedInt;
  if (!isIntIdx) {
    pushError(ctx.errors, node.index,
      `array index must be an integer type, found ${formatType(idxType)}`);
    return setType(node, ErrorType());
  }
  return setType(node, objType.elem);
}
```

### 6.d Index assignment

When the assignment target is `INDEX_EXPRESSION`, the typechecker validates:
- The object is an array type (verified above during `resolveExprType` on the target).
- The value matches the array's element type.
- Arrays declared as `const` cannot be indexed-assigned (the fat pointer itself is const, but elements are mutable in v0 if the binding is `let`).

For simplicity in v0: both `let` and `const` array bindings allow element assignment. The `const` modifier prevents replacing the fat pointer itself, not the elements. Document this as a known-permissive and address in a future quality pass.

---

## 7. Typechecker - casts ([checkExpr.js](../src/jsyooptypecheck/checkExpr.js))

Casts look like function calls: `int64(x)`. The typechecker intercepts `CALL_EXPRESSION` nodes where the callee is an IDENT whose name resolves to a primitive type name:

In `resolveCall`, before looking up the callee as a function:

```js
function resolveCall(node, scope, ctx) {
  // Cast detection: callee is a single IDENT matching a primitive type name
  if (node.callee.kind === ASTNodeKind.IDENT) {
    const primType = primTypeFromName(node.callee.name);  // returns PrimType or null
    if (primType) {
      // It's a cast, not a call.
      if (node.args.length !== 1) {
        pushError(ctx.errors, node,
          `cast '${node.callee.name}(...)' requires exactly one argument`);
        return setType(node, primType);
      }
      const argType = resolveExprType(node.args[0], scope, ctx);
      const coerced = coerceLiteralIfNeeded(argType, primType);
      if (!isCastableTo(coerced ?? argType, primType)) {
        pushError(ctx.errors, node,
          `cannot cast ${formatType(argType)} to ${formatType(primType)} - only numeric primitive casts are supported`);
        return setType(node, primType);
      }
      node.isCast = true;
      node.castTargetType = primType;
      return setType(node, primType);
    }
  }
  // ... existing function-call resolution ...
}
```

`primTypeFromName(name)` returns `PrimType(name)` for any name in `primAnnotations`, or null if it's not a primitive.

> **No cast to `void`, `string`, `bool`, or `char`.** `isCastableTo` returns false for these. A user writing `bool(x)` gets "cannot cast int32 to bool"; they should use a comparison instead.

---

## 8. Typechecker - for-loop, break, continue ([checkStatement.js](../src/jsyooptypecheck/checkStatement.js))

### 8.a Loop context on `ctx`

Add `inLoop: bool` to the typecheck context:

```js
// In validateFunction setup:
const ctx = {
  funcName: ...,
  funcReturnType: ...,
  errors: ...,
  structTable: ...,
  typeContext: ...,
  inLoop: false,    // new
};
```

`checkBlock` (and `checkForLoop`) push a new context with `inLoop: true` for the body.

### 8.b `FOR_LOOP`

```js
case ASTNodeKind.FOR_LOOP: {
  // Validate init assignment: initIdent must be in scope, initExpr type must match.
  const initBinding = lookupInScope(scope, node.initIdent);
  if (!initBinding) {
    pushError(ctx.errors, node,
      `for-loop variable "${node.initIdent}" is not declared - declare it before the loop`);
  } else {
    const initExprType = resolveExprType(node.initExpr, scope, ctx);
    checkAssignable(initBinding.type, initExprType, node, ctx);
  }

  // Validate condition: must be bool.
  const condType = resolveExprType(node.cond, scope, ctx);
  if (condType.kind !== typeKinds.prim || condType.name !== "bool") {
    if (condType.kind !== typeKinds.error) {
      pushError(ctx.errors, node.cond,
        `for-loop condition must be bool, found ${formatType(condType)}`);
    }
  }

  // Validate step assignment: stepIdent must be in scope.
  const stepBinding = lookupInScope(scope, node.stepIdent);
  if (!stepBinding) {
    pushError(ctx.errors, node,
      `for-loop step variable "${node.stepIdent}" is not declared`);
  } else {
    const stepExprType = resolveExprType(node.stepExpr, scope, ctx);
    checkAssignable(stepBinding.type, stepExprType, node, ctx);
  }

  // Validate body with inLoop: true.
  const loopCtx = { ...ctx, inLoop: true };
  validateStatement(node.body, scope, loopCtx);
  return;
}
```

### 8.c `BREAK_STATEMENT` / `CONTINUE_STATEMENT`

```js
case ASTNodeKind.BREAK_STATEMENT:
  if (!ctx.inLoop) {
    pushError(ctx.errors, node, `'break' is not inside a loop`);
  }
  return;

case ASTNodeKind.CONTINUE_STATEMENT:
  if (!ctx.inLoop) {
    pushError(ctx.errors, node, `'continue' is not inside a loop`);
  }
  return;
```

`WHILE_STATEMENT` must also set `inLoop: true` on the body context. Update `checkWhileStatement` to propagate `loopCtx`.

### 8.d `else if` - already working

The parser already recurses for `else if` at [parser.js:641-643](../src/jsyooparser/parser.js#L641-L643). The typechecker's `IF_STATEMENT` handler recursively calls `validateStatement(node.elseBody, ...)` which handles any statement kind, including a nested `IF_STATEMENT`. The codegen similarly recurses. No code changes needed; phase 4 adds tests to confirm.

---

## 9. Codegen ([codegen.js](../src/jsyoopcodegen/codegen.js))

### 9.a LLVM type helpers

New mappings for `llvmTypeOf`:

```js
case typeKinds.ref:
  return "ptr";

case typeKinds.array:
  return `%yoop_array.${llvmElemTag(t.elem)}`;
  // Where llvmElemTag returns a mangled tag for the element type, e.g. "int32" -> "i32"
```

For each distinct array element type used in a module, emit a named struct type at module top:

```llvm
%yoop_array.i32 = type { ptr, i64 }
%yoop_array.i64 = type { ptr, i64 }
```

These are all the same shape `{ ptr, i64 }` (pointer to elements + length as 64-bit integer). The named types improve IR readability. Track emitted array types in a set (similar to struct deduplication in phase 3) - emit each distinct element-type variant at most once.

### 9.b `ref` bindings and params - LLVM emit

**`ref` local binding** (`let p: ref int32 = ref n`):

```llvm
%p = alloca ptr, align 8
; ref n evaluates to the address of n's alloca slot
store ptr %n, ptr %p     ; n's alloca is %n
```

The `REF_EXPRESSION` emitter simply returns the alloca pointer of the operand, not a loaded value:

```js
case ASTNodeKind.REF_EXPRESSION: {
  // We need the address of the operand, not its value.
  // For IDENT: return the alloca slot directly.
  // For FIELD_ACCESS / INDEX_EXPRESSION: compute and return the GEP result.
  return { val: emitLvalueAddress(node.operand, fnLines), yoopType: node.resolvedType };
}
```

`emitLvalueAddress(exprNode, fnLines)` is a new helper that returns the LLVM pointer for an lvalue without doing the final load:

```js
function emitLvalueAddress(node, fnLines) {
  if (node.kind === ASTNodeKind.IDENT) {
    return `%${node.name}`;          // the alloca slot
  }
  if (node.kind === ASTNodeKind.FIELD_ACCESS) {
    // emit GEP but no load
    return emitFieldGEP(node, fnLines);
  }
  if (node.kind === ASTNodeKind.INDEX_EXPRESSION) {
    return emitIndexGEP(node, fnLines);
  }
  throw new Error(`codegen bug: emitLvalueAddress on non-lvalue ${node.kind}`);
}
```

**Auto-deref read** (an IDENT with `autoDeref: true`):

```llvm
%ptr = load ptr, ptr %p          ; load the stored pointer from p's alloca
%val = load i32, ptr %ptr        ; load the value through that pointer
```

In `emitIdent`:

```js
if (node.autoDeref) {
  const tmp1 = freshTemp();
  fnLines.push(`  ${tmp1} = load ptr, ptr %${node.name}`);
  const tmp2 = freshTemp();
  fnLines.push(`  ${tmp2} = load ${llvmType}, ptr ${tmp1}`);
  return { val: tmp2, yoopType: node.resolvedType };
}
```

**Auto-deref write** (assignment target is an IDENT with `autoDerefWrite: true`):

```js
if (target.autoDerefWrite) {
  const tmp = freshTemp();
  fnLines.push(`  ${tmp} = load ptr, ptr %${target.name}`);
  fnLines.push(`  store ${llvmType} ${rhsVal}, ptr ${tmp}`);
  return;
}
```

**`ref` params** - when emitting a function definition, a `ref` param uses `ptr` as its LLVM type. The param is stored as a `ptr` in its alloca slot:

```llvm
define void @main__increment(ptr %n) {
  %n_slot = alloca ptr, align 8
  store ptr %n, ptr %n_slot
  ; all accesses to n go through: load ptr, ptr %n_slot; load/store i32 through that
}
```

**`ref` arg at call site** - when `emitCall` sees a `REF_EXPRESSION` arg:

```js
if (arg.kind === ASTNodeKind.REF_EXPRESSION) {
  const addr = emitLvalueAddress(arg.operand, fnLines);
  emittedArgs.push({ val: addr, llvmType: "ptr" });
} else {
  // normal arg
}
```

### 9.c Array fat pointer - LLVM emit

**Array literal** `[1, 2, 3]: int32[]`:

```llvm
; Allocate backing store
%arr_buf = alloca [3 x i32], align 4
; Store elements
%e0 = getelementptr inbounds [3 x i32], ptr %arr_buf, i32 0, i32 0
store i32 1, ptr %e0
%e1 = getelementptr inbounds [3 x i32], ptr %arr_buf, i32 0, i32 1
store i32 2, ptr %e1
%e2 = getelementptr inbounds [3 x i32], ptr %arr_buf, i32 0, i32 2
store i32 3, ptr %e2
; Build fat pointer
%fat0 = insertvalue %yoop_array.i32 undef, ptr %arr_buf, 0
%fat1 = insertvalue %yoop_array.i32 %fat0, i64 3, 1
; fat1 is the array value
```

The array value is then stored into the binding's alloca slot (same pattern as structs).

**`xs.len` intrinsic** (FIELD_ACCESS with `isArrayLen: true`):

```llvm
%xs_val = load %yoop_array.i32, ptr %xs
%len = extractvalue %yoop_array.i32 %xs_val, 1
```

**`xs[i]` index expression**:

```llvm
%xs_val = load %yoop_array.i32, ptr %xs
%data_ptr = extractvalue %yoop_array.i32 %xs_val, 0
%i_val = load i64, ptr %i           ; if i is a usize (i64)
%elem_ptr = getelementptr inbounds i32, ptr %data_ptr, i64 %i_val
%elem = load i32, ptr %elem_ptr
```

For index types smaller than `i64` (e.g. `int32`), zero/sign-extend to `i64` before the GEP.

**`xs[i] = v` index assignment**:

```llvm
%xs_val = load %yoop_array.i32, ptr %xs
%data_ptr = extractvalue %yoop_array.i32 %xs_val, 0
%i_val = load i64, ptr %i
%elem_ptr = getelementptr inbounds i32, ptr %data_ptr, i64 %i_val
store i32 %v_val, ptr %elem_ptr
```

`emitLvalueAddress` for INDEX_EXPRESSION extracts the data pointer and returns the GEP result - reused by both the index-expression emitter and the ref-of-index case.

### 9.d `FOR_LOOP` - LLVM emit

```llvm
; init
store i32 0, ptr %i          ; node.initIdent = "i", node.initExpr = 0

br label %for_cond_N

for_cond_N:
  %i_val = load i32, ptr %i
  %n_val = load i32, ptr %n
  %cmp = icmp slt i32 %i_val, %n_val
  br i1 %cmp, label %for_body_N, label %for_exit_N

for_body_N:
  ; ... body ...
  br label %for_step_N

for_step_N:
  %i_val2 = load i32, ptr %i
  %inc = add nsw i32 %i_val2, 1
  store i32 %inc, ptr %i
  br label %for_cond_N

for_exit_N:
  ; continues here
```

Use a fresh label counter `N` per loop to avoid label collisions when loops nest.

**Loop context for break/continue**: codegen threads a `loopCtx` through `emitStatement`:

```js
function emitStatement(node, fnLines, ctx) {
  // ctx has: { returnType, symbols, loopExitLabel, loopContinueLabel }
  ...
  case ASTNodeKind.FOR_LOOP: {
    const N = freshLabel("for");
    const condLabel = `${N}_cond`;
    const bodyLabel = `${N}_body`;
    const stepLabel = `${N}_step`;
    const exitLabel = `${N}_exit`;

    // init
    emitAssignToIdent(node.initIdent, node.initExpr, fnLines, ctx);
    fnLines.push(`  br label %${condLabel}`);

    // cond
    fnLines.push(`${condLabel}:`);
    const cond = emitExpr(node.cond, fnLines, ctx);
    fnLines.push(`  br i1 ${cond.val}, label %${bodyLabel}, label %${exitLabel}`);

    // body - with break/continue labels set
    fnLines.push(`${bodyLabel}:`);
    const loopCtx = { ...ctx, loopExitLabel: exitLabel, loopContinueLabel: stepLabel };
    emitBlock(node.body, fnLines, loopCtx);
    fnLines.push(`  br label %${stepLabel}`);

    // step
    fnLines.push(`${stepLabel}:`);
    emitAssignToIdent(node.stepIdent, node.stepExpr, fnLines, ctx);
    fnLines.push(`  br label %${condLabel}`);

    // exit
    fnLines.push(`${exitLabel}:`);
    break;
  }
```

For `WHILE_STATEMENT`, wire in `loopExitLabel` and `loopContinueLabel` pointing at the existing exit and condition labels.

### 9.e `BREAK_STATEMENT` / `CONTINUE_STATEMENT`

```js
case ASTNodeKind.BREAK_STATEMENT:
  fnLines.push(`  br label %${ctx.loopExitLabel}`);
  // After a terminator, LLVM requires no more instructions in this basic block.
  // Emit an unreachable label so any following IR lands somewhere valid.
  fnLines.push(`${freshLabel("after_break")}:`);
  break;

case ASTNodeKind.CONTINUE_STATEMENT:
  fnLines.push(`  br label %${ctx.loopContinueLabel}`);
  fnLines.push(`${freshLabel("after_continue")}:`);
  break;
```

The "dead label" trick (a fresh label after the unconditional branch) keeps the IR structurally valid for clang/LLVM even if code follows `break`/`continue` in the source (which would be unreachable but parseable).

### 9.f Cast emit

In `emitCall`, when `node.isCast` is true:

```js
if (node.isCast) {
  const src = emitExpr(node.args[0], fnLines, ctx);
  const srcLlvmType = llvmTypeOf(node.args[0].resolvedType);
  const dstLlvmType = llvmTypeOf(node.castTargetType);
  const opcode = castInstruction(node.args[0].resolvedType, node.castTargetType);
  if (opcode === null) {
    // Same-width int reinterpret: no instruction needed, just annotate.
    // Emit a bitcast so the IR type system sees the new type.
    const tmp = freshTemp();
    fnLines.push(`  ${tmp} = bitcast ${srcLlvmType} ${src.val} to ${dstLlvmType}`);
    return { val: tmp, yoopType: node.castTargetType };
  }
  const tmp = freshTemp();
  fnLines.push(`  ${tmp} = ${opcode} ${srcLlvmType} ${src.val} to ${dstLlvmType}`);
  return { val: tmp, yoopType: node.castTargetType };
}
```

---

## 10. Tests

### 10.1 Pass fixtures - [examples/pass/](../examples/pass/)

#### `refs_basic.yoop`

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

function increment(ref n: int32): void {
    n = n + 1;
}

function main(): int32 {
    let x: int32 = 10;
    increment(ref x);
    printf(`x = ${x}\n`);
    return 0;
}
```

Expected: `x = 11`. Exercises ref param, auto-deref write inside function, auto-deref read at call site.

#### `refs_binding.yoop`

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

function main(): int32 {
    let n: int32 = 42;
    let p: ref int32 = ref n;
    p = 99;
    printf(`n = ${n}\n`);
    return 0;
}
```

Expected: `n = 99`. Exercises a ref binding, auto-deref write through the binding.

#### `arrays_basic.yoop`

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

function main(): int32 {
    let xs: int32[] = [10, 20, 30];
    printf(`len=%d\n`, xs.len);
    printf(`xs[1]=%d\n`, xs[1]);
    xs[2] = 99;
    printf(`xs[2]=%d\n`, xs[2]);
    return 0;
}
```

Expected: `len=3`, `xs[1]=20`, `xs[2]=99`. Exercises array literal, `.len`, indexing, index assignment.

#### `arrays_loop.yoop`

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

function sum(xs: int32[]): int32 {
    let total: int32 = 0;
    let i: usize = 0;
    for (i = 0; i < xs.len; i = i + 1) {
        total = total + xs[i];
    }
    return total;
}

function main(): int32 {
    let xs: int32[] = [1, 2, 3, 4, 5];
    printf(`sum = ${sum(xs)}\n`);
    return 0;
}
```

Expected: `sum = 15`. Exercises for-loop over array length, array pass-by-value (fat pointer copy), element access inside loop.

#### `for_break_continue.yoop`

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

function main(): int32 {
    let i: int32 = 0;
    for (i = 0; i < 10; i = i + 1) {
        if (i == 3) { continue; }
        if (i == 7) { break; }
        printf(`i=%d\n`, i);
    }
    return 0;
}
```

Expected: `i=0`, `i=1`, `i=2`, `i=4`, `i=5`, `i=6` (skips 3, stops before 7).

#### `else_if.yoop`

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

function classify(x: int32): int32 {
    if (x < 0) {
        printf(`negative\n`);
        return 0;
    } else if (x == 0) {
        printf(`zero\n`);
        return 1;
    } else {
        printf(`positive\n`);
        return 2;
    }
}

function main(): int32 {
    classify(-1);
    classify(0);
    classify(1);
    return 0;
}
```

Expected: `negative`, `zero`, `positive`. Verifies `else if` works end-to-end.

#### `casts.yoop`

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

function main(): int32 {
    let a: int32  = 100;
    let b: int64  = int64(a);
    let c: float32 = float32(a);
    let d: uint8  = uint8(a);
    let e: int32  = int32(c);
    printf(`b=%lld c=%f d=%d e=%d\n`, b, c, d, e);
    return 0;
}
```

Expected: `b=100 c=100.000000 d=100 e=100`. Exercises widening, int-to-float, narrowing, float-to-int casts.

#### `casts_truncate.yoop`

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

function main(): int32 {
    let big: int32 = 300;
    let small: uint8 = uint8(big);
    printf(`small=%d\n`, small);
    return 0;
}
```

Expected: `small=44` (300 & 0xFF = 44). Exercises truncating cast.

### 10.2 Fail fixtures - [examples/fail/](../examples/fail/)

| File | Snippet | Expected error |
|---|---|---|
| `ref_of_literal.yoop` | `ref 42` | `cannot take ref of a non-lvalue expression` |
| `ref_ref.yoop` | `let p: ref ref int32 = ...` | `cannot take ref of a ref` |
| `ref_return.yoop` | Function with `ref int32` return type | `functions may not return 'ref T'` |
| `ref_no_keyword.yoop` | `increment(n)` where increment expects `ref n: int32` | `parameter "n" expects a ref` |
| `array_wrong_elem.yoop` | `let xs: int32[] = [1, 2.0, 3]` | type mismatch on second element |
| `array_non_int_index.yoop` | `xs["a"]` | `array index must be an integer type` |
| `array_nested.yoop` | `let xs: int32[][] = ...` | `nested arrays not yet supported` |
| `break_outside_loop.yoop` | `break;` at top level of a function | `'break' is not inside a loop` |
| `continue_outside_loop.yoop` | `continue;` inside an `if` but not a loop | `'continue' is not inside a loop` |
| `for_undeclared_var.yoop` | `for (z = 0; ...)` where `z` is not in scope | `for-loop variable "z" is not declared` |
| `cast_to_string.yoop` | `string(42)` | `cannot cast int32 to string` |
| `cast_wrong_arity.yoop` | `int32(1, 2)` | `cast 'int32(...)' requires exactly one argument` |

### 10.3 Updating `e2e.test.js`

Each pass fixture gets an `it()` mirroring the existing pattern. Each fail fixture checks that `typecheckSource(src).errors` contains a matching message.

### 10.4 Lexer and parser unit tests

In [lexer.test.js](../src/jsyooplexer/lexer.test.js):

- `ref n` lexes as `[ref, ident("n")]`
- `break;` lexes as `[break, semicolon]`
- `continue;` lexes as `[continue, semicolon]`
- `[1, 2]` lexes as `[lbracket, intLiteral, comma, intLiteral, rbracket]`

In [parser.test.js](../src/jsyooparser/parser.test.js): cases listed in §3.h.

### 10.5 Codegen IR-shape tests

In [codegen.test.js](../src/jsyoopcodegen/codegen.test.js):

- A `ref` param function produces `define ... (ptr %)` in the signature.
- An `increment(ref x)` call site emits the alloca address directly (no load before the call).
- An array literal of 3 elements emits a `[3 x i32]` alloca + 3 stores + 2 `insertvalue`s.
- `xs.len` emits `extractvalue ... 1`.
- `xs[i]` emits a GEP on the extracted data pointer.
- A `for` loop emits the `for_cond_N`, `for_body_N`, `for_step_N`, `for_exit_N` labels.
- `break` emits `br label %for_exit_N` (match on pattern, not exact label name).
- `int64(x)` where `x: int32` emits `sext i32 %x to i64`.
- `uint8(x)` where `x: int32` emits `trunc i32 %x to i8`.
- `float32(x)` where `x: int32` emits `sitofp i32 %x to float`.

---

## 11. Edge cases worth getting right

### 11.a `ref` binding passed to another `ref` param

```yoop
function f(ref n: int32): void { n = n + 1; }
function g(ref m: int32): void { f(ref m); }
```

`ref m` inside `g` is a `REF_EXPRESSION` on an IDENT whose type is `int32` (auto-deref). The resolved type is `ref int32`, which matches `f`'s param. `emitLvalueAddress(m)` returns `m`'s slot loaded once through the ref (the pointer-to-the-original, not the alloca of `m` itself). Concretely: `m` is declared as `ptr` in `g`'s alloca; `ref m` returns `load ptr, ptr %m_slot`. That pointer is the address of the original binding in the caller of `g`.

### 11.b Array passed to a `ref`-param function

`ref xs: int32[]` is not supported in phase 4 (see Scope). The typechecker rejects `function f(ref xs: int32[]): void` with "ref params must have a primitive base type in phase 4". Struct refs and array refs come with phase 5.

### 11.c `continue` inside a nested `if` inside a `for`

```yoop
for (i = 0; i < 10; i = i + 1) {
    if (i == 5) { continue; }
    use(i);
}
```

The `ctx.inLoop` is `true` inside the `if` body because `inLoop` is carried through recursively. `ctx.loopContinueLabel` points at `for_step_N`. The `continue` emits `br label %for_step_N` - correct.

### 11.d Dead code after `break` / `continue`

```yoop
for (i = 0; i < 10; i = i + 1) {
    break;
    printf(`unreachable\n`);
}
```

The parser accepts this. The typechecker does not reject it (dead-code elimination is out of scope). Codegen emits the break + a dead label + the unreachable printf call. LLVM's optimizer will remove it; clang accepts the IR. No error in v0.

### 11.e `for` loop with no body execution

`for (i = 0; i < 0; i = i + 1) { ... }` - the condition is false immediately. The emitted IR jumps from `for_cond_N` to `for_exit_N` without executing the body. The step `i = i + 1` also never executes. Correct by the cond-first structure.

### 11.f Cast of an untyped literal

`int64(42)` - the literal `42` is `UntypedIntType`. The typechecker coerces it to `int64` directly (same as `let x: int64 = 42`). The cast is a no-op at the IR level. This is fine; codegen emits an `int64` constant directly.

### 11.g `xs.len` used as a `usize` in arithmetic

```yoop
let half: usize = xs.len / 2;
```

`xs.len` has type `usize` (`i64` in LLVM). The literal `2` is `UntypedIntType`. `unifyArith(usize, untypedInt, "/")` returns `usize`, coercing the literal. Codegen emits `udiv i64 %len, 2`. Correct - `usize` is unsigned, use unsigned division.

### 11.h `for` step variable different from init variable

```yoop
let i: int32 = 0;
let j: int32 = 0;
for (i = 0; i < 10; j = j + 1) { ... }  // step updates j, not i
```

This is syntactically valid. The typechecker accepts it (each ident is independently verified to exist). The result is a loop that increments `j` but tests `i` - probably not what the user wanted, but the compiler doesn't enforce that init/step use the same variable. Document this as a known gotcha.

### 11.i Empty array literal in a typed context

```yoop
let xs: int32[] = [];
```

The array literal has no elements - element type cannot be inferred from the literal alone. But the declared type `int32[]` provides the context. `checkLetOrConst` passes the declared element type into `checkArrayLiteral(node, elemType, ctx)`. For an empty literal, just check `node.elements.length === 0` and emit a zero-length fat pointer: `insertvalue { undef, i64 0 }`. No buffer alloca needed.

Empty arrays without a type annotation (e.g., as an argument to a function or in a struct literal) are rejected with "empty array literal requires explicit type annotation".

### 11.j Passing an array to a function by value

Arrays are fat pointers `{ ptr, i64 }`. When passed to a function, the fat pointer struct is passed by value (copied). The backing buffer is not copied - the callee gets a fat pointer pointing to the same buffer. This is intentional and per spec ("arrays are fat pointers … passed by value"). Document this: mutating `xs[i]` inside the called function mutates the caller's buffer.

---

## 12. Out of scope (for clarity)

- **Heap-allocated arrays.** `malloc` is available via extern; no language-level array heap allocation.
- **Slice syntax** `xs[a..b]`. Reserved per spec.
- **Bounds checking.** Out-of-bounds is UB in v0.
- **`for item in xs`** - trait-driven iteration; phase 5.
- **Array length change / push / pop.** Arrays are fixed-size once created.
- **`ref T` return values.** Lifetime tracking needed; phase 7+.
- **`ref` params on struct types.** Phase 5 (`self` params).
- **`unsafe_ptr`.** Phase 6 (kinds).
- **Pattern matching on arrays.** Phase 7.
- **Cast to/from `bool`, `string`, `char`, or struct types.**

---

## 13. Phase exit criteria

- Every fixture in §10.1 compiles and runs, producing exactly the expected stdout.
- Every fixture in §10.2 fails typecheck (no crash) with an error matching the listed pattern.
- All existing phase 1–3 fixtures still pass identically (no regressions).
- `else if` works end-to-end (`else_if.yoop` passes).
- The IR shape tests in §10.5 all pass.
- `clang` accepts the generated IR for every fixture without warnings.
- Parser and lexer unit tests for the new tokens and constructs all pass.

---

## 14. Implementation order

Each step keeps prior tests green and is independently bisect-able.

1. **Lexer**: add `ref`, `break`, `continue`, `[`, `]` tokens. Unit test in `lexer.test.js`. No semantic change yet - the parser throws on the new keywords.
2. **AST kinds**: add six new kinds. No logic change.
3. **Parser - `parseTypeAnnotation`**: introduce the structured annotation object, migrate all type-annotation call sites. Update typechecker call sites (`resolveTypeAnnotation`). This is the largest change and the riskiest regression - run all existing tests after this step before proceeding. The observable behavior should be identical since `{ kind: "typeName", name: "int32" }` resolves to the same `PrimType("int32")` as before.
4. **Parser - for / break / continue**: `parseForStatement`, `parseBreakStatement`, `parseContinueStatement`, add to `parseStatement` switch. Parser unit tests from §3.h.
5. **Parser - ref expression, array literal, array indexing**: extend `parseAtom` and the postfix loop. Parser unit tests.
6. **Typechecker - casts**: detect type-name calls in `resolveCall`, annotate `node.isCast`. Add `isCastableTo`/`castInstruction` to `types.js`. Unit tests for the helpers. End-to-end `casts.yoop` works.
7. **Typechecker - `ref`**: `REF_EXPRESSION`, `isRef` param handling, `autoDeref` flags, ref-return rejection. End-to-end `refs_basic.yoop` compiles but codegen not yet wired - it will crash at codegen. That's fine - we can write the typecheck tests first.
8. **Typechecker - arrays**: `ARRAY_LITERAL`, `xs.len`, `INDEX_EXPRESSION`, `checkLetOrConst` with declared-array-type context. End-to-end `arrays_basic.yoop` not yet compiled.
9. **Typechecker - for/break/continue**: `inLoop` context, validation. Fail fixtures `break_outside_loop` and `continue_outside_loop` start working.
10. **Codegen - casts**: `node.isCast` path in `emitCall`. `casts.yoop` works end-to-end.
11. **Codegen - `ref`**: `emitLvalueAddress`, `REF_EXPRESSION` emitter, `autoDeref` / `autoDerefWrite` paths in `emitIdent` / `emitAssignment`, `ref` param LLVM type. `refs_basic.yoop` and `refs_binding.yoop` work end-to-end.
12. **Codegen - arrays**: array type registration, `ARRAY_LITERAL` emit, `isArrayLen` in field access, `INDEX_EXPRESSION` emit, index assignment. `arrays_basic.yoop` works end-to-end.
13. **Codegen - for/break/continue**: `FOR_LOOP` label structure, `loopExitLabel` / `loopContinueLabel` threading, `BREAK_STATEMENT` / `CONTINUE_STATEMENT` emit, wire `loopCtx` into `WHILE_STATEMENT`. `arrays_loop.yoop` and `for_break_continue.yoop` work end-to-end.
14. **All fail fixtures** in §10.2.
15. **Test cleanup**: ensure `e2e.test.js` covers all new pass/fail fixtures; run full suite.
16. **`else if` test**: add `else_if.yoop` to confirm the existing implementation is complete.

---

## 15. Critical files reference

- [SPEC.md §2 - Literals and casts](../SPEC.md), [§3 - Types: refs and arrays](../SPEC.md), [§9 - Loops](../SPEC.md), [§10 - Control flow](../SPEC.md) - re-read before each step.
- [src/contracts.js](../src/contracts.js) - six new AST node kinds.
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) - five new tokens.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) - `parseTypeAnnotation`, type-annotation call-site migration, `parseForStatement`, `parseBreakStatement`, `parseContinueStatement`, ref expression, array literal/indexing.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) - `resolveTypeAnnotation`, `isCastableTo`, `castInstruction`.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) - `REF_EXPRESSION`, `ARRAY_LITERAL`, `INDEX_EXPRESSION`, cast detection in `resolveCall`, `xs.len` in `resolveFieldAccess`.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js) - `FOR_LOOP`, `BREAK_STATEMENT`, `CONTINUE_STATEMENT`, `inLoop` context, `WHILE_STATEMENT` loop-ctx propagation.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) - `emitLvalueAddress`, `ref` LLVM patterns, array fat-pointer emit, for-loop label structure, break/continue label threading, cast instruction emit.
- [src/e2e.test.js](../src/e2e.test.js) - new pass + fail fixtures.
- `examples/pass/refs_basic.yoop`, `refs_binding.yoop`, `arrays_basic.yoop`, `arrays_loop.yoop`, `for_break_continue.yoop`, `else_if.yoop`, `casts.yoop`, `casts_truncate.yoop`.
- `examples/fail/` - `ref_of_literal`, `ref_ref`, `ref_return`, `ref_no_keyword`, `array_wrong_elem`, `array_non_int_index`, `array_nested`, `break_outside_loop`, `continue_outside_loop`, `for_undeclared_var`, `cast_to_string`, `cast_wrong_arity`.
