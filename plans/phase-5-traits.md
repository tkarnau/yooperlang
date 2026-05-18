# Phase 5 — Traits

Part of the [roadmap](./roadmap.md). Phase 4 landed `ref T` for primitives, fat-pointer arrays, the C-style for-loop, `break`/`continue`, and numeric casts. The compiler now has every primitive ingredient it needs to express the **capability layer** described in [SPEC.md §5](../SPEC.md): a way to declare what operations a type supports (`trait Disposable`), a way to attach those operations to a type (`type FileHandle implements Disposable { ... }`), and a way to call them through an explicit `self` parameter (`dispose(ref h)`). This phase is the one place where method-like binding meets static type-driven dispatch — without classes, vtables, or any runtime machinery.

## Goal

Land a working subset of [SPEC.md §5 — Traits](../SPEC.md) and the call form pinned in [SPEC.md §17.2](../SPEC.md):

```yoop
// disposable.yoop
extern "C" from "stdio.h" {
    function printf(fmt: string, ...): int32;
}

trait Disposable {
    function dispose(ref self): void;
}

trait Closable {
    function close(ref self): int32;
}

type FileHandle implements (Disposable, Closable) {
    fd: int32,
    is_open: bool,
    function dispose(ref self): void {
        printf(`disposing fd=${self.fd}\n`);
        self.is_open = false;
    }
    function close(ref self): int32 {
        printf(`closing fd=${self.fd}\n`);
        self.is_open = false;
        return 0;
    }
}

function main(): int32 {
    let h: FileHandle = { fd: 7, is_open: true };
    let rc: int32 = close(ref h);
    dispose(ref h);
    printf(`rc=${rc} is_open=${h.is_open}\n`);
    return 0;
}
```

`yoopiler disposable.yoop` must compile and print:

```
closing fd=7
disposing fd=7
rc=0 is_open=false
```

Concretely:

- `trait Foo { function m(ref self): T; ... }` declares a capability — a set of method **signatures** with no bodies. Every method's first parameter is named `self` and must be prefixed `ref`. There are no bare functions, no fields, no associated constants — just signatures.
- `type T implements Foo { fields; function m(ref self): T { body } }` attaches the trait to a struct. Method bodies live inside the type-decl block. Every required trait method must appear with a matching signature; no extra methods are allowed.
- `type T implements (Foo, Bar) { ... }` (the parenthesized form) implements multiple traits on one type. Every required method of every listed trait must appear; the same method name may not appear in two implemented traits.
- A trait method is invoked through the **free-function form**: `dispose(ref h)`. The compiler statically resolves the call to a mangled per-type symbol (`@<modId>__FileHandle__dispose`). There is no method-call sugar (`h.dispose()`) in this phase; that's deferred indefinitely.
- A method body sees `self` as a binding of type `ref T` — exactly like a `ref` parameter from phase 4, except `T` may now be a struct (which phase 4 explicitly deferred, see [phase-4-refs-arrays-control-flow.md §11.b](phase-4-refs-arrays-control-flow.md)). `self.fieldName` reads/writes through the auto-deref.
- `extends` is rejected with a clear "extends not yet supported" parse error. Generic traits (`trait Foo<T>`) are rejected with "generic traits not yet supported" at the same point.

## Why this is next

Three reasons — each independently sufficient.

1. **The kind layer in phase 6 is built on traits.** Spec §6 defines kinds in terms of `requires Trait` and `provides Trait` clauses; the entire `disposable` / `task` / `pooled` story collapses without traits. We need the trait machinery before we can do anything kind-shaped.

2. **Phase 4 left struct-ref machinery on the floor.** Phase 4 deferred `ref T`-where-T-is-a-struct ("ref params on struct types") to phase 5 explicitly because the only motivating use case for them was `ref self`. Pulling them in now keeps the design coherent — the same `emitLvalue` infrastructure that already supports `ref` of an array index becomes the natural way to handle `ref` of a struct.

3. **Disposable is the gateway pattern for FFI safety.** A real program using phase-3 externs (`fopen`, `malloc`, `pthread_create`) needs a way to express "this handle must be cleaned up." Without traits there's no language-level way to say "any value of this type supports `dispose`," so cleanup is hand-rolled on every site. Traits are a prerequisite for the `disposable` kind, but they're already useful on their own.

Phase 5 has a deliberate hard scope cut to keep it tractable: **non-generic, non-extending, no-method-sugar, no-vtables**. Every trait call is statically resolved at compile time to a single mangled symbol; there is no dispatch, no fat pointer, no type erasure. This isn't a stepping-stone toward dynamic dispatch — spec §16 is explicit that classes/inheritance are intentionally absent, and dynamic dispatch is intentionally absent forever in v2. Yooper's polymorphism story is generic functions over trait-bounded type parameters, which lands in phase 7+.

## Scope (what this phase does NOT do)

- **No generic traits.** `trait Iterable<T>` and `trait Task<T>` are rejected with `generic traits not yet supported` at parse time. Reasoning: every generic trait method's signature would need substitution, and the substitution machinery is shared with user-defined generic types (deferred per spec §3). Doing both at once is a quagmire; doing neither means a much smaller phase 5.
- **No `extends` chaining.** `trait BatchIterable<T> extends Iterable<T>` is rejected with `extends not yet supported`. Reasoning: `extends` requires the same generic substitution path *and* introduces a sub-trait obligation. Dropping it costs us nothing for `Disposable`/`Closable`-shaped traits and removes a tier of complexity from the resolver.
- **No method-call sugar.** `h.dispose()` is rejected at typecheck. Per [SPEC.md §17.2](../SPEC.md) the v2 picks free-function form; revisit only if it feels wrong in practice.
- **No same-name collisions.** A type cannot implement two traits whose method names overlap, even if the signatures match. The free-function call form has no path syntax to disambiguate (`Trait::method(x)` is not a valid form), so the only sane option is to forbid the collision at typecheck. Same rule applies between trait method names and module-level free-function names — the call site `dispose(ref x)` must resolve unambiguously.
- **No bare impl block / no methods on types without `implements`.** Spec §7 is explicit: "There is no bare `impl` block; a method always implements a trait." Writing `type T { fields; function m(ref self): void { ... } }` (no `implements` clause) is a parse error: `methods are only allowed inside an 'implements' block`.
- **No `Self` keyword.** A method whose return type or param refers to the implementing type uses the explicit type name (`function clone(ref self): FileHandle`), not `Self`. Generic `Self` is bundled with generic traits and lands together later.
- **No dynamic dispatch / no trait objects.** Per spec §16 — there is no `dyn Disposable`, no fat pointer with vtable. Every trait call resolves to exactly one mangled symbol at compile time.
- **No default method bodies.** Trait declarations only carry signatures. A method with a body inside `trait Foo { ... }` is rejected.
- **No `provides` semantics for kinds.** That's phase 6.
- **No trait-bound generics (`function f<T implements Foo>(...)`).** Phase 7+, when user generics land.
- **No introspection / "does T implement Foo".** No syntactic form for it.
- **No orphan impls.** A trait may only be implemented on a struct declared in the same module — `type T implements Trait` declares a *new* type, not an extension of an imported one (see §8.j).

---

## Status snapshot

After phase 4, the compiler has everything it needs:

- Full module graph + extern FFI from phase 3.
- `ref T` lvalues, fat-pointer arrays, for-loops, casts from phase 4. `RefType { inner }` already produces correct LLVM `ptr` lowering for primitive `inner`.
- `emitLvalue` ([codegen.js:246](../src/jsyoopcodegen/codegen.js#L246)) returns `{ ptr, type }` for `IDENT`, `FIELD_ACCESS`, `INDEX_EXPRESSION`. Field-GEP machinery is already in place.
- `resolveCall` ([checkExpr.js:145](../src/jsyooptypecheck/checkExpr.js#L145)) and `resolveCallType` ([checkExpr.js:674](../src/jsyooptypecheck/checkExpr.js#L674)) already understand `param.isRef` — they require an explicit `REF_EXPRESSION` at the call site and verify the inner type. This logic is reused unchanged for trait method calls.
- Multi-module typechecking is multi-pass with shells in pass A, struct fields in pass C, and bodies in pass D ([typecheck.js](../src/jsyooptypecheck/typecheck.js)). Trait decls slot in cleanly as a new shell-then-resolve-then-validate triple.
- LLVM struct-name mangling is already moduleId-prefixed. The same mangle pattern extends naturally to method symbols.

The five things that don't yet exist:

1. The keywords `trait`, `implements`, `self`, and `extends` — none are in `keywordTagList` ([lexer.js:124-144](../src/jsyooplexer/lexer.js#L124)).
2. AST kinds for trait declarations and method blocks ([contracts.js](../src/contracts.js) has no `TRAIT_DECL` / `METHOD_DECL` / `METHOD_SIG`).
3. A `TraitType` in the type system ([types.js](../src/jsyooptypecheck/types.js) has no `typeKinds.trait`).
4. The `implements` clause and the body extension on `parseTypeDecl` ([parser.js:795](../src/jsyooparser/parser.js#L795) currently only parses fields).
5. The `ref T` codegen path for *struct* `T` — `emitLvalue` works for `T` = struct already, but `emitIdent` ([codegen.js:436](../src/jsyoopcodegen/codegen.js#L436)) only emits auto-deref load for primitive `inner`. We need to also handle struct `inner` (load the pointer once, then either return it as a struct value or use it as the base of a field GEP).

Phase 5 fills exactly those five gaps. Everything else builds on what's already there.

---

## Files touched

- [src/contracts.js](../src/contracts.js) — three new AST kinds: `TRAIT_DECL`, `METHOD_SIG`, `METHOD_DECL`. Plus an `implements` array and `methods` array on `TYPE_DECL`.
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — three new keywords (`trait`, `implements`, `self`); one keyword added solely to reject (`extends`).
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — `parseTraitDecl`, extended `parseTypeDecl`, `parseMethodSig`, `parseMethodDecl`, top-level dispatch grows.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) — `TraitType`, extended `StructType` (carries `implementsTraits: [TraitType]` and `methods: Map<name, FuncType>`).
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) — new pass for trait shells; extended struct-shell pass for `implements`; new `validateImplBlock` invoked during pass C; extended pass D walks each impl method body.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js) — `validateMethod(decl, structType, ctx, ...)` parallel to `validateFunction`. Pushes `self` into scope as a `ref T` binding before walking body.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) — `resolveCall` learns to dispatch to a per-type method when the free-function lookup misses; `resolveIdent` rejects `self` outside trait/impl context.
- [src/jsyooptypecheck/imports.js](../src/jsyooptypecheck/imports.js) — `kind: "trait"` import classification.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — `emitMethod()` parallel to `emitFunction`, mangled `${moduleId}__${TypeName}__${methodName}`. `emitIdent` and `emitLvalue` extended to read `ref T` for struct `T`. `emitCall` looks at a new `node.calleeMethodOf` field set by the typechecker.
- [src/e2e.test.js](../src/e2e.test.js) — new pass + fail fixtures.
- [examples/pass/](../examples/pass/) and [examples/fail/](../examples/fail/) — see §7.

---

## 1. AST node kinds ([contracts.js](../src/contracts.js))

Add three kinds and grow one existing one.

```js
TRAIT_DECL: "TRAIT_DECL",
//   { name: string,
//     methods: [METHOD_SIG],
//     // future: typeParams (generics, deferred)
//     // future: extendsList (extends, deferred)
//     sourceLoc }

METHOD_SIG: "METHOD_SIG",
//   { name: string,
//     params: [PARAM],          // first param is the synthetic `self` ref param
//     returnTypeAnnotation: typeAnnotationObject,
//     sourceLoc }

METHOD_DECL: "METHOD_DECL",
//   { name: string,
//     params: [PARAM],          // first param has isRef:true and name "self"
//     returnTypeAnnotation: typeAnnotationObject,
//     body: BLOCK,
//     // resolved during typecheck:
//     implementingType: StructType (set in pass C.3),
//     implementsTrait:  string  (set in pass C.3; the trait this method satisfies),
//     mangledSymbol: string,    // set in pass C.3; "<modId>__<TypeName>__<methodName>"
//     resolvedFuncType: FuncType,
//     sourceLoc }
```

Why each is separate:

- `TRAIT_DECL` is a top-level declaration parallel to `FUNCTION_DECL` / `TYPE_DECL`. The shells-pass needs it identifiable at a glance.
- `METHOD_SIG` is "function decl without a body, with `ref self` baked in." It's distinguishable from `FUNCTION_DECL` because `FUNCTION_DECL` always has a `body`. Shoehorning it as `FUNCTION_DECL { body: null }` would force every later pass to special-case the null-body branch. A separate kind is cheaper.
- `METHOD_DECL` is "function decl that's part of an impl block." The body is mandatory; the resolver needs to know which trait it implements, and which type it lives on. Reusing `FUNCTION_DECL` would mean polluting it with optional `implementingType` / `implementsTrait` fields that are null for free functions, or trying to figure out at every call site whether a given `FUNCTION_DECL` is actually a method. Distinct kinds keep AST-walk patterns honest.

Existing `TYPE_DECL` grows two fields:

```js
TYPE_DECL: {
  // ... existing: name, fields, targetType
  implements: [string],        // raw trait names from the source — empty array if no implements clause
  methods:    [METHOD_DECL],   // empty array if no methods
  // ... resolvedType still set in pass C; will now carry implementsTraits + methods on the StructType too
}
```

Storing trait names as bare strings (not yet `TraitType`) parallels how struct field types are stored as type-annotation objects until pass C resolves them. The resolver fills in `resolvedImplements: [TraitType]` later.

We do **not** need an `IMPL_BLOCK` AST kind. The impl block IS the type decl with `implements` set; methods live directly on the type decl alongside fields. This matches spec §5: "Method blocks sit inside `type … implements Trait { fields; fn; fn; }`."

---

## 2. Lexer changes ([lexer.js](../src/jsyooplexer/lexer.js))

Three keywords plus one rejected-keyword for clean error messages. Tags continue from 54:

```js
TokenTags.trait:      55,
TokenTags.implements: 56,
TokenTags.self:       57,
TokenTags.extends:    58,    // accepted by lexer; rejected by parser with "extends not yet supported"
```

Add to `keywordTagList`:

```js
trait:      TokenTags.trait,
implements: TokenTags.implements,
self:       TokenTags.self,
extends:    TokenTags.extends,
```

> **`self` as a hard keyword.** The framing called `self` "contextual." After looking at how this lexer works — keywords are a flat lookup from `keywordTagList` — making `self` contextual would require either threading parser state into `lex()` (a layering inversion) or running a post-lex sweep that re-tags `self` based on syntactic position. Both are more code than promoting `self` to a hard keyword and tolerating the cost of one fewer identifier name. Anyone trying to use `self` as an unrelated identifier gets a parse error, which is friendlier than a confusing typecheck error 200 lines later. The spec's reserved-words list at [SPEC.md §14](../SPEC.md) doesn't mention `self`, but it doesn't mention `function` either — the table is incomplete. Lock `self` down now. See §11.a for the design discussion.

> **`extends` as a hard keyword.** Lex it so the parser can produce `extends not yet supported` instead of the generic `unexpected token: ident "extends"`. Negligible cost.

> **`trait` and `implements`.** Both appear in the spec reserved-words table. Hard keywords from day one.

### 2.a Lexer test cases

Add to [lexer.test.js](../src/jsyooplexer/lexer.test.js):

- `trait Disposable { ... }` lexes as `[trait, ident("Disposable"), lcurly, ..., rcurly]`.
- `type T implements Foo { ... }` lexes as `[type, ident("T"), implements, ident("Foo"), lcurly, ...]`.
- `function dispose(ref self): void` lexes the bare word `self` as the `self` keyword token, not an ident.
- `extends Foo` lexes the bare word `extends` as the `extends` keyword token.

---

## 3. Parser changes ([parser.js](../src/jsyooparser/parser.js))

### 3.a Top-level dispatch

`parseTopLevel` ([parser.js:142](../src/jsyooparser/parser.js#L142)) currently dispatches on `function`, `type`, `import`, `export`, `extern`. Add `trait`:

```js
case TokenTags.trait:
  seenNonImport = true;
  node.body.push(parseTraitDecl());
  break;
```

`export trait Foo { ... }` is also valid per spec §1: extend `parseExportDecl` ([parser.js:250](../src/jsyooparser/parser.js#L250)) to accept `trait` after the leading `export`:

```js
case TokenTags.trait: node.decl = parseTraitDecl(); break;
```

The `EXPORT_DECL { decl: TRAIT_DECL }` shape mirrors `EXPORT_DECL { decl: TYPE_DECL }` exactly; pass A unwraps via `innerDecl()` so cross-module trait imports work the same way as cross-module struct imports.

### 3.b `parseTraitDecl`

```js
function parseTraitDecl() {
  const node = buildSourcedNode(ASTNodeKind.TRAIT_DECL);
  expect(TokenTags.trait);

  node.name = parseIdentAsName();

  // Reject generic-trait syntax early.
  if (peek().tag === TokenTags.lt) {
    throw parseError(
      `generic traits not yet supported`,
      peek().start, peek().length,
    );
  }

  // Reject `extends` early.
  if (peek().tag === TokenTags.extends) {
    throw parseError(
      `extends not yet supported`,
      peek().start, peek().length,
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

  // First param MUST be `ref self` — enforced syntactically.
  if (peek().tag !== TokenTags.ref) {
    throw parseError(
      `trait method "${node.name}" must take 'ref self' as its first parameter`,
      peek().start, peek().length,
    );
  }
  advance(); // consume ref
  if (peek().tag !== TokenTags.self) {
    throw parseError(
      `trait method "${node.name}" must take 'ref self' as its first parameter`,
      peek().start, peek().length,
    );
  }
  advance(); // consume self
  // Synthetic `self` PARAM. typeAnnotation is a sentinel that resolves
  // to the implementing type at typecheck.
  const selfParam = buildSourcedNode(ASTNodeKind.PARAM);
  selfParam.isRef = true;
  selfParam.name = "self";
  selfParam.typeAnnotation = { kind: "selfType" };
  node.params = [selfParam];

  // Remaining params: standard `parseFunctionParam` loop.
  while (peek().tag === TokenTags.comma) {
    advance();
    node.params.push(parseFunctionParam());
  }
  expect(TokenTags.rparen);
  expect(TokenTags.colon);
  node.returnTypeAnnotation = parseTypeAnnotation();
  expect(TokenTags.semicolon);    // signatures end with `;`, not a body
  return node;
}
```

The `{ kind: "selfType" }` placeholder is recognized by `resolveTypeAnnotation` only inside trait/method context — outside that context it's a typecheck bug. In a trait, `selfType` resolves to a `TraitSelfPlaceholder`; in a method body, `selfType` resolves to the implementing struct type itself.

### 3.c `parseTypeDecl` extension

`parseTypeDecl` ([parser.js:795](../src/jsyooparser/parser.js#L795)) currently parses `type Name { fields }`. Extend to handle `implements`:

```js
function parseTypeDecl() {
  expect(TokenTags.type);
  const node = buildSourcedNode(ASTNodeKind.TYPE_DECL);
  node.name = parseIdentAsName();

  // implements clause — single name OR parenthesized list
  node.implements = [];
  if (peek().tag === TokenTags.implements) {
    advance();
    if (peek().tag === TokenTags.lparen) {
      advance();
      while (peek().tag === TokenTags.ident) {
        node.implements.push(parseIdentAsName());
        if (peek().tag === TokenTags.comma) advance();
      }
      expect(TokenTags.rparen);
    } else {
      node.implements.push(parseIdentAsName());
    }
  }

  if (peek().tag === TokenTags.lcurly) {
    node.fields = [];
    node.methods = [];
    expect(TokenTags.lcurly);
    // Body is a free interleaving of field decls and method decls.
    // A field starts with ident; a method starts with `function`.
    while (peek().tag === TokenTags.ident || peek().tag === TokenTags.function) {
      if (peek().tag === TokenTags.function) {
        node.methods.push(parseMethodDecl());
      } else {
        const fieldNode = buildSourcedNode(ASTNodeKind.FIELD_DECL);
        fieldNode.name = parseIdentAsName();
        expect(TokenTags.colon);
        fieldNode.typeAnnotation = parseTypeAnnotation();
        node.fields.push(fieldNode);
        if (peek().tag === TokenTags.comma) advance();
      }
    }
    expect(TokenTags.rcurly);
  } else {
    // type alias path — preserved from before.
    node.targetType = parseIdentAsName();
  }

  // Constraint: methods only allowed when implements is non-empty.
  if (node.methods?.length > 0 && node.implements.length === 0) {
    throw parseError(
      `methods are only allowed inside an 'implements' block — type "${node.name}" has methods but no 'implements' clause`,
    );
  }

  return node;
}

function parseMethodDecl() {
  const node = buildSourcedNode(ASTNodeKind.METHOD_DECL);
  expect(TokenTags.function);
  node.name = parseIdentAsName();
  expect(TokenTags.lparen);

  // First param: ref self
  if (peek().tag !== TokenTags.ref) {
    throw parseError(
      `method "${node.name}" must take 'ref self' as its first parameter`,
      peek().start, peek().length,
    );
  }
  advance();
  if (peek().tag !== TokenTags.self) {
    throw parseError(
      `method "${node.name}" must take 'ref self' as its first parameter`,
      peek().start, peek().length,
    );
  }
  advance();
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
  node.body = parseBlock();   // method bodies are required
  return node;
}
```

A subtle point: a `field` can only start with an ident, and a `method` can only start with `function`. There's no ambiguity between `fd: int32,` (field) and `function dispose(ref self): void { ... }` (method) — the keyword distinguishes them. Trailing commas after fields keep the existing flexibility.

### 3.d Method-call sugar — typecheck reject

`h.dispose()` parses as `CALL_EXPRESSION { callee: FIELD_ACCESS { object: IDENT("h"), field: "dispose" }, args: [] }` — already a parseable shape after phase 3 (namespace calls). Phase 5 needs the typechecker (not the parser) to recognize this and reject it cleanly:

> "method-call form `h.dispose()` is not supported in this version — write `dispose(ref h)` instead"

Doing this at typecheck rather than at parse is necessary because the same parse shape is used legitimately for namespace calls (`io.greet("hi")`); only at typecheck do we know whether the LHS is a namespace (allowed) or a struct (rejected). See §5.g.

### 3.e Parser-side `self` handling in expressions

`parseExpression`'s atom path currently dispatches on `TokenTags.ident`, literals, etc. Add a `TokenTags.self` branch that synthesizes an IDENT node:

```js
if (peek().tag === TokenTags.self) {
  advance();
  const node = buildSourcedNode(ASTNodeKind.IDENT);
  node.name = "self";
  // Continue into the postfix loop so `self.field` and `self[i]` work.
  // (handled by the existing postfix-operator loop)
}
```

The typechecker enforces the rule that `self` is only legal as an identifier inside a method-decl context (§5.f). Outside that context, `self` parses fine but typecheck-fails with a clear message.

> **Why parse `self` as an IDENT-shaped node?** The downstream code already handles `IDENT { name: ... }` everywhere — `resolveIdent`, `resolveAssignmentToIdent`, `resolveFieldAccess` of `IDENT`. Giving `self` a special AST kind would force every one of those functions to switch on it. Treating it as IDENT and gating its use in `resolveIdent` is one extra branch.

### 3.f Parser test cases — accept

Add to [parser.test.js](../src/jsyooparser/parser.test.js):

- `trait Disposable { function dispose(ref self): void; }` produces `TRAIT_DECL { name: "Disposable", methods: [METHOD_SIG { name: "dispose", params: [PARAM { isRef: true, name: "self", typeAnnotation: { kind: "selfType" } }], returnTypeAnnotation: { kind: "typeName", name: "void" } }] }`.
- `trait Closable { function close(ref self): int32; function name(ref self): string; }` produces a `TRAIT_DECL` with two `METHOD_SIG`s.
- `type FileHandle implements Disposable { fd: int32, function dispose(ref self): void { } }` produces `TYPE_DECL { implements: ["Disposable"], fields: [FIELD_DECL { name: "fd" }], methods: [METHOD_DECL { name: "dispose", body: BLOCK }] }`.
- `type Channel implements (Disposable, Closable) { ... }` produces `implements: ["Disposable", "Closable"]`.
- A method body using `self.count`: parses as `FIELD_ACCESS { object: IDENT { name: "self" }, field: "count" }`.
- A method that calls another method: `function f(ref self): void { g(ref self); } function g(ref self): void { }` — the `g(ref self)` is just a `CALL_EXPRESSION`, no special parser handling.
- Trailing comma between fields and methods: `type T implements Foo { x: int32, function m(ref self): void { } }` parses cleanly.

### 3.g Parser test cases — reject

- `trait Iter<T> { ... }` → `generic traits not yet supported`
- `trait Sub extends Super { ... }` → `extends not yet supported`
- `trait Foo { function dispose(self): void; }` (no `ref`) → `trait method "dispose" must take 'ref self' as its first parameter`
- `trait Foo { function dispose(ref x): void; }` (named non-self) → `trait method "dispose" must take 'ref self' as its first parameter`
- `trait Foo { function dispose(ref self): void { /* body */ } }` → `expected semicolon, got lcurly` (from `parseMethodSig`'s trailing `expect(semicolon)`).
- `type T { function m(ref self): void { } }` (methods without `implements`) → `methods are only allowed inside an 'implements' block`.
- `type T implements Foo { function m(self): void { } }` → `method "m" must take 'ref self' as its first parameter`.
- `type T implements (A,) { ... }` (trailing comma in implements list) — accepted, mirrors the struct field trailing-comma rule.

---

## 4. Type system ([types.js](../src/jsyooptypecheck/types.js))

Add `TraitType`. Extend `StructType`. Extend `resolveTypeAnnotation` to handle the `selfType` sentinel.

### 4.a `TraitType`

```js
export const typeKinds = {
  // ... existing
  trait: "trait",   // new
};

// methods: Map<string, FuncType> — every trait method has signature
// (params: [{name, type, isRef}], returnType, variadic: false)
// where params[0] is { name: "self", type: RefType { inner: TraitSelfPlaceholder }, isRef: true }
export const TraitSelfPlaceholder = Object.freeze({ kind: "trait_self_placeholder" });

export const TraitType = (name, methods, moduleId = null) =>
  freezerWrap(typeKinds.trait, { name, methods, moduleId });
```

The `TraitSelfPlaceholder` is **only** legal inside a `RefType { inner }` slot of a trait method's first param type. When a struct `T` implements `Trait`, we materialize a per-type `FuncType` for each method by substituting `RefType { inner: T }` for `RefType { inner: TraitSelfPlaceholder }`. That substitution happens once per method per impl, in pass C.3.

### 4.b `StructType` extension

```js
// implementsTraits: [TraitType] — set in pass C.3 from TYPE_DECL.implements
// methods: Map<string, FuncType> — for each method this type implements,
//   the resolved per-type signature (with self-substitution applied).
//   The Map keys are method names; codegen uses them with the type's name to
//   build the mangled symbol "<modId>__<TypeName>__<methodName>".
export const StructType = (name, fields, moduleId = null, implementsTraits = [], methods = new Map()) =>
  freezerWrap(typeKinds.struct, { name, fields, moduleId, implementsTraits, methods });
```

Backwards-compat: existing call sites (phase 1–4 single-arg or 3-arg calls) get empty `implementsTraits` and empty `methods`. `typesEqual` doesn't change for structs — struct identity is still nominal-by-name + module.

> **Why a `Map<string, FuncType>` and not just an array?** Lookup-by-name dominates: every trait call site asks "does this type have a method named `dispose`?" An O(1) map keeps the resolver simple.

### 4.c `resolveTypeAnnotation` — `selfType` sentinel

```js
export function resolveTypeAnnotation(annot, structTable, ctx) {
  if (!annot) return null;
  if (annot.kind === "typeName") return resolveTypeFromName(annot.name, structTable);
  if (annot.kind === "refType") {
    const inner = resolveTypeAnnotation(annot.inner, structTable, ctx);
    if (!inner) return null;
    return RefType(inner);
  }
  if (annot.kind === "arrayType") {
    const elem = resolveTypeAnnotation(annot.elem, structTable, ctx);
    if (!elem) return null;
    return ArrayType(elem);
  }
  if (annot.kind === "selfType") {
    // Only legal in trait/method context. ctx.selfType is set by the caller
    // when resolving inside a TRAIT_DECL or METHOD_DECL.
    if (!ctx?.selfType) {
      throw new Error(`resolveTypeAnnotation: 'self' used outside trait/method context`);
    }
    return ctx.selfType;
  }
  throw new Error(`resolveTypeAnnotation: unknown annotation kind "${annot.kind}"`);
}
```

The `ctx.selfType` is:

- `TraitSelfPlaceholder` when resolving a `METHOD_SIG` inside a `TRAIT_DECL`.
- the `StructType` `T` when resolving a `METHOD_DECL` inside `type T implements Foo { ... }`.

The existing 2-arg call sites stay as-is — `ctx` is optional.

### 4.d `formatType` for traits

Add a case to the `formatType` helper in [errors.js](../src/jsyooptypecheck/errors.js):

```js
if (t.kind === typeKinds.trait) return `trait ${t.name}`;
```

Pure error-message readability (`type "FileHandle" does not implement trait "Disposable"`).

### 4.e `typesEqual` for traits

Two traits are equal iff their name and moduleId match. `typesEqual` grows one branch:

```js
if (a.kind === typeKinds.trait) {
  return a.name === b.name && (a.moduleId ?? null) === (b.moduleId ?? null);
}
```

Trait method comparing for sig-equivalence (during impl-block validation) uses `typesEqual` on each param type and the return type — that path already works.

---

## 5. Typechecker ([typecheck.js](../src/jsyooptypecheck/typecheck.js), [checkExpr.js](../src/jsyooptypecheck/checkExpr.js), [checkStatement.js](../src/jsyooptypecheck/checkStatement.js))

### 5.a Multi-pass shape

The current pass structure is A (shells) → B (imports) → C (struct fields, function sigs, externs) → C.5 (re-sync imports) → D (function bodies). Phase 5 adds:

- **Pass A** also registers `TraitType` shells (trait names + empty method map) into a new `traitTable` per module, alongside the existing `structTable`.
- **Pass C** is split into sub-passes:
  - **C.1**: struct field resolution + trait method signature resolution (uses `TraitSelfPlaceholder`).
  - **C.2**: function signature resolution + extern function resolution. Functions need fully-resolved struct types as parameter types.
  - **C.3**: `validateImplBlock` for every `TYPE_DECL` with non-empty `implements`. Needs both struct fields (C.1) and trait method sigs (C.1) resolved, *and* `localSymbols` populated for the no-collision-with-free-functions rule (C.2).
- **Pass C.5** continues to handle imported names — extended to also re-sync imported `TraitType`s.
- **Pass D** is unchanged for free functions; for each `TYPE_DECL` with `implements` non-empty, walks each `METHOD_DECL` body via a new `validateMethod()`.

Order: A → B → C.1 → C.2 → C.3 → C.5 → D.

Concretely, `moduleEnv` per module grows:

```js
{
  localSymbols, structTable, exports, importedNames, linkLibraries,
  traitTable: Map<name, TraitType>,                   // new
  // implicit: each StructType in structTable now carries .methods + .implementsTraits
}
```

### 5.b Pass A — trait shells

Walk each `mod.ast.body`. For each `TRAIT_DECL d` (or `EXPORT_DECL { decl: TRAIT_DECL }`):

```js
if (d.kind === ASTNodeKind.TRAIT_DECL) {
  if (traitTable.has(d.name) || structTable.has(d.name) || localSymbols.has(d.name)) {
    errors.push({ message: `redeclaration of "${d.name}"`, sourceLoc: d.sourceLoc });
  } else {
    traitTable.set(d.name, TraitType(d.name, new Map(), mod.id));
  }
  if (decl.kind === ASTNodeKind.EXPORT_DECL) exports.add(d.name);
}
```

A trait name shares the same namespace as struct names and free function names — the redeclaration check is a flat "any name already exists?" guard. This is consistent with how `function foo` and `type foo` collide today.

### 5.c Pass C.1 — trait method signatures

For each `TRAIT_DECL`, build a per-trait `FuncType` for each `METHOD_SIG`, with the self-inner set to `TraitSelfPlaceholder`. Store on the trait's `methods` map:

```js
for (const decl of mod.ast.body) {
  const d = innerDecl(decl);
  if (d.kind !== ASTNodeKind.TRAIT_DECL) continue;
  const trait = traitTable.get(d.name);
  // Validate no duplicate method names within the trait.
  const seen = new Set();
  for (const sig of d.methods) {
    if (seen.has(sig.name)) {
      errors.push({ message: `duplicate method "${sig.name}" in trait "${d.name}"`, sourceLoc: sig.sourceLoc });
      continue;
    }
    seen.add(sig.name);
    // Resolve param types with selfType sentinel.
    const ctxForSig = { selfType: TraitSelfPlaceholder };
    const params = sig.params.map(p => {
      const baseType = resolveTypeAnnotationInModule(p.typeAnnotation, mod.id, moduleEnv, ctxForSig) ?? ErrorType();
      return { name: p.name, type: p.isRef ? RefType(baseType) : baseType, isRef: p.isRef ?? false };
    });
    const returnType = resolveTypeAnnotationInModule(sig.returnTypeAnnotation, mod.id, moduleEnv, ctxForSig) ?? ErrorType();
    trait.methods.set(sig.name, FuncType(params, returnType, false));
    sig.resolvedFuncType = trait.methods.get(sig.name);
  }
}
```

The trait's `methods` map after this pass holds `FuncType`s where `params[0].type === RefType { inner: TraitSelfPlaceholder }`. Substitution happens later.

### 5.d Pass C.3 — impl-block validation

For each `TYPE_DECL` with non-empty `implements`:

1. **Resolve each named trait** via `traitTable` (current module) or imported names (`importedNames` of kind `"trait"`). Unknown trait → error "type `T` implements unknown trait `Foo`".
2. **Substitute self** in each trait method's signature: `RefType { TraitSelfPlaceholder }` → `RefType { thisStructType }`.
3. **Match impl methods to required methods.** For each implemented trait, walk its (substituted) methods and check each required name is present in the type's `METHOD_DECL` list with a matching `FuncType` (param types + return type all `typesEqual` to the substituted trait sig).
4. **Reject extras.** Every `METHOD_DECL` in the type's body must implement *some* required method of *some* implemented trait. A method whose name doesn't match any required method is an error: "type `T` declares method `m`, but no implemented trait requires it".
5. **No-collision rule (across traits).** If two implemented traits both require a method with the same name, error: "type `T` cannot implement both `A` and `B` because they share method name `m`".
6. **No-collision rule (with free functions).** For each method name `m` on `T`, check `localSymbols.has(m)`. If yes, error: "method `m` on type `T` collides with module-level free function `m`". This guarantees the free-function call form `m(ref x)` is unambiguous.
7. **Build the resolved StructType** with `implementsTraits` filled in and `methods` populated.

```js
function validateImplBlock(typeDecl, mod, moduleEnv, errors) {
  const env = moduleEnv.get(mod.id);
  const structShell = env.structTable.get(typeDecl.name);
  if (!structShell) return;

  // Step 1: resolve trait names.
  const resolvedImplements = [];
  for (const traitName of typeDecl.implements) {
    const trait = env.traitTable.get(traitName)
      ?? lookupImportedTrait(traitName, mod, moduleEnv);
    if (!trait) {
      errors.push({ message: `type "${typeDecl.name}" implements unknown trait "${traitName}"`, sourceLoc: typeDecl.sourceLoc });
      continue;
    }
    resolvedImplements.push(trait);
  }

  const fields = structShell.fields ?? [];

  // Step 2: substitute self in each trait's required methods.
  // requiredMethods: methodName -> { traitName, sig: FuncType (substituted) }
  const requiredMethods = new Map();
  for (const trait of resolvedImplements) {
    for (const [methodName, traitSig] of trait.methods) {
      // No-collision rule across traits:
      if (requiredMethods.has(methodName) &&
          requiredMethods.get(methodName).traitName !== trait.name) {
        errors.push({
          message: `type "${typeDecl.name}" cannot implement both "${requiredMethods.get(methodName).traitName}" and "${trait.name}" — both require method "${methodName}"`,
          sourceLoc: typeDecl.sourceLoc,
        });
        continue;
      }
      requiredMethods.set(methodName, {
        traitName: trait.name,
        sig: substituteSelfInSig(traitSig, structShell),
      });
    }
  }

  // Step 3: match impl methods to required.
  const implMethodNames = new Set();
  const resolvedMethods = new Map();
  for (const methodDecl of typeDecl.methods) {
    if (implMethodNames.has(methodDecl.name)) {
      errors.push({ message: `duplicate method "${methodDecl.name}" in type "${typeDecl.name}"`, sourceLoc: methodDecl.sourceLoc });
      continue;
    }
    implMethodNames.add(methodDecl.name);

    // Collision with free function in same module:
    if (env.localSymbols.has(methodDecl.name)) {
      errors.push({
        message: `method "${methodDecl.name}" on type "${typeDecl.name}" collides with module-level function "${methodDecl.name}" — rename one`,
        sourceLoc: methodDecl.sourceLoc,
      });
    }

    const required = requiredMethods.get(methodDecl.name);
    if (!required) {
      errors.push({
        message: `type "${typeDecl.name}" declares method "${methodDecl.name}", but no implemented trait requires it`,
        sourceLoc: methodDecl.sourceLoc,
      });
      continue;
    }
    methodDecl.implementsTrait = required.traitName;

    // Resolve the impl method's FuncType (with selfType = thisStruct).
    const ctxForMethod = { selfType: structShell };
    const params = methodDecl.params.map(p => {
      const baseType = resolveTypeAnnotationInModule(p.typeAnnotation, mod.id, moduleEnv, ctxForMethod) ?? ErrorType();
      return { name: p.name, type: p.isRef ? RefType(baseType) : baseType, isRef: p.isRef ?? false };
    });
    const returnType = resolveTypeAnnotationInModule(methodDecl.returnTypeAnnotation, mod.id, moduleEnv, ctxForMethod) ?? ErrorType();
    const implSig = FuncType(params, returnType, false);

    if (!sigsEqual(implSig, required.sig)) {
      errors.push({
        message: `method "${methodDecl.name}" on type "${typeDecl.name}" has signature ${formatSig(implSig)}, expected ${formatSig(required.sig)} from trait "${required.traitName}"`,
        sourceLoc: methodDecl.sourceLoc,
      });
      continue;
    }
    methodDecl.resolvedFuncType = implSig;
    methodDecl.mangledSymbol = `${mod.id}__${typeDecl.name}__${methodDecl.name}`;
    resolvedMethods.set(methodDecl.name, implSig);
  }

  // Step 4: every required method must be implemented.
  for (const [methodName, required] of requiredMethods) {
    if (!resolvedMethods.has(methodName)) {
      errors.push({
        message: `type "${typeDecl.name}" implements trait "${required.traitName}" but is missing method "${methodName}" with signature ${formatSig(required.sig)}`,
        sourceLoc: typeDecl.sourceLoc,
      });
    }
  }

  // Step 5: rebuild the StructType with implements + methods set.
  const fullStruct = StructType(typeDecl.name, fields, mod.id, resolvedImplements, resolvedMethods);
  typeDecl.resolvedType = fullStruct;
  for (const m of typeDecl.methods) {
    m.implementingType = fullStruct;
  }
  env.structTable.set(typeDecl.name, fullStruct);
}

function substituteSelfInSig(traitSig, thisStruct) {
  const params = traitSig.params.map(p => {
    if (p.type.kind === typeKinds.ref && p.type.inner === TraitSelfPlaceholder) {
      return { ...p, type: RefType(thisStruct) };
    }
    return p;
  });
  return FuncType(params, traitSig.returnType, false);
}
```

`sigsEqual(a, b)` compares two `FuncType`s (param types in order + return type). The existing `typesEqual` already handles `FuncType`.

### 5.e Pass C.5 — re-sync imported traits

The current pass C.5 re-syncs imported value and type names. Add a third branch for imported traits:

```js
} else if (kind === "trait") {
  const resolved = srcEnv.traitTable.get(exportName);
  if (resolved) {
    const localEnv = moduleEnv.get(mod.id);
    localEnv.traitTable.set(localName, resolved);
  }
}
```

The `imports.js` module (`resolveImports`) gets a parallel branch when classifying imported export kinds: if `sourceMod.traitTable.has(exportName)`, set `kind: "trait"`. The receiving module's import overlay treats trait imports as type-position-only — a trait name appears only after `implements`, never as a value or annotation.

### 5.f Pass D — body validation (`validateMethod`)

`validateMethod(decl, structType, ctx, errors)` — parallel to `validateFunction` in [checkStatement.js](../src/jsyooptypecheck/checkStatement.js). Before walking the body, push a `self` binding into the function-body scope:

```js
export function validateMethod(decl, structType, ctx, errors) {
  const fnScope = pushScope(ctx.rootScope);
  // self is `ref T`
  declareInScope(fnScope, "self", RefType(structType), "param", decl, errors);

  // Push remaining params (skip params[0] which is the synthetic self).
  for (let i = 1; i < decl.params.length; i++) {
    const p = decl.params[i];
    const t = p.isRef ? RefType(p.resolvedBaseType) : p.resolvedBaseType;
    declareInScope(fnScope, p.name, t, "param", p, errors);
  }
  const methodCtx = {
    ...ctx,
    funcName: decl.name,
    funcReturnType: decl.resolvedFuncType.returnType,
    inMethodBody: true,                    // gates `self` legality
    enclosingType: structType,
  };
  for (const stmt of decl.body.body) {
    validateStatement(stmt, fnScope, methodCtx);
  }
  popScope(fnScope, errors);
}
```

Where the body uses `self`:

- **`self` as a bare ident** — `resolveIdent` finds the `self` binding, sees `type.kind === typeKinds.ref`, sets `node.autoDeref = true` (existing infrastructure from phase 4), returns the inner struct type. Same path that already works for `let p: ref int32`.
- **`self.field`** — `FIELD_ACCESS` against an IDENT whose resolved type is the struct type (post auto-deref). Existing `resolveFieldAccess` handles this without modification.
- **`self.field = expr`** — `resolveAssignmentToField` traces the field root, sees `self`'s binding type is `ref T`, applies the auto-deref-write logic that already exists for primitive `ref` bindings ([checkExpr.js:336](../src/jsyooptypecheck/checkExpr.js#L336)). Codegen handles the dereference at emit time (§6.b).
- **`self` outside a method body** — `resolveIdent` finds no `self` in scope. Improve the error: in `resolveIdent`, if the lookup miss is on the literal name `"self"`, push a more specific message: "the keyword 'self' can only be used inside a trait method body".

### 5.g `resolveCall` — trait method dispatch

`resolveCall` ([checkExpr.js:145](../src/jsyooptypecheck/checkExpr.js#L145)) currently handles: cast → namespace call → printf legacy → free function via `moduleSymbols`. Add **trait method resolution** between the free-function lookup and the unknown-function error:

```js
// (after the cast / namespace / printf branches, before the moduleSymbols lookup)
const sig = ctx.typeContext.moduleSymbols.get(callee) ?? KNOWN_EXTERNS[callee];
if (sig) {
  // ... existing path
}

// Free function not found — try trait method dispatch.
// Rule: callee is a string, args.length >= 1, args[0] is a REF_EXPRESSION
// whose operand has type T-where-T-is-a-struct, and T's StructType.methods
// contains `callee`.
if (typeof callee === "string" && node.args.length >= 1) {
  const firstArg = node.args[0];
  if (firstArg.kind === ASTNodeKind.REF_EXPRESSION) {
    const operandType = resolveExprType(firstArg.operand, scope, ctx);
    if (operandType.kind === typeKinds.struct && operandType.methods?.has(callee)) {
      const methodSig = operandType.methods.get(callee);
      // Annotate the call so codegen knows the mangled symbol.
      node.calleeMethodOf = operandType;
      node.calleeMangledName = `${operandType.moduleId}__${operandType.name}__${callee}`;
      // Reuse the existing call-resolution to check params + return.
      // The first param is `ref self: T` — we already know the operand
      // matches; the rest of resolveCallType handles params 1..N.
      return resolveCallType(node, methodSig, scope, ctx);
    }
  }
}

// Unknown function — original error path.
pushError(ctx.errors, node, `unknown function "${callee}"`);
return setType(node, ErrorType());
```

A few edge cases:

- **Self-referential method calls.** Inside `validateMethod` for `T.dispose`, a call to `dispose(ref self)` finds no `dispose` in `localSymbols` (none of the methods are registered as free functions — that's the point), then tries trait dispatch. `firstArg.operand` is `IDENT { name: "self" }`, `resolveExprType` returns `T` (auto-deref'd), and `T.methods.has("dispose")` is true. Resolves correctly.
- **Method on an imported type.** Pass C.5 makes the imported `StructType` reference the same canonical object — `methods` map is preserved. The `node.calleeMangledName` correctly points at the *defining* module's mangled symbol.
- **Method-call sugar reject.** If `node.callee` is a `FIELD_ACCESS` (object form, like `h.dispose()`), the existing namespace-call branch tries to resolve the callee. If the LHS is a struct value (not a namespace), emit "method-call form `h.dispose()` is not supported — use `dispose(ref h)` instead".

### 5.h `lookupImportedTrait` helper

Parallels the existing import-resolution pattern. In [imports.js](../src/jsyooptypecheck/imports.js):

```js
function lookupImportedTrait(name, mod, moduleEnv) {
  const env = moduleEnv.get(mod.id);
  const imp = env.importedNames.get(name);
  if (!imp || imp.kind !== "trait") return null;
  const srcEnv = moduleEnv.get(imp.fromModuleId);
  return srcEnv?.traitTable.get(imp.exportName) ?? null;
}
```

`resolveImports` when classifying an import: if the source module's `traitTable.has(exportName)`, register `kind: "trait"`. Receivers see the canonical `TraitType` after pass C.5's re-sync.

### 5.i `import * as ns; ns.Trait` — not supported

A trait reference can only be a bare identifier in this phase, never `ns.Trait`. The parser's `parseTypeDecl` reads a single identifier after `implements`. `type T implements io.Disposable { ... }` is a parse error. Documented as a known restriction; revisit when generic traits land. Workaround: import the trait by name (`import { Disposable } from "./io.yoop"`).

---

## 6. Codegen ([codegen.js](../src/jsyoopcodegen/codegen.js))

### 6.a Method emission — `emitMethod`

Methods emit as flat LLVM functions, mangled `${moduleId}__${TypeName}__${methodName}`. The signature exposes `self` as a `ptr` parameter — same as a `ref T` parameter from phase 4.

```js
function emitMethod(methodDecl, structType) {
  tempCounter = 0;
  labelCounter = 0;
  symbols = new Map();

  const returnType = methodDecl.resolvedFuncType.returnType;
  currentReturnType = returnType;
  const params = methodDecl.params; // params[0] is self
  const llvmRet = llvmType(returnType);

  const paramSig = params
    .map((p) => {
      // Every method's first param is `ref self`, which lowers to ptr.
      const ty = p.isRef ? "ptr" : llvmType(p.resolvedBaseType);
      return `${ty} %${p.name}.arg`;
    })
    .join(", ");

  const mangled = methodDecl.mangledSymbol; // <modId>__<TypeName>__<methodName>
  const fnLines = [];
  fnLines.push(`define ${llvmRet} @${mangled}(${paramSig}) {`);
  fnLines.push("entry:");

  // Spill each param into a stack slot (existing pattern from emitFunction).
  for (const p of params) {
    if (p.isRef) {
      // Slot for the pointer itself.
      fnLines.push(`  %${p.name} = alloca ptr, align 8`);
      fnLines.push(`  store ptr %${p.name}.arg, ptr %${p.name}`);
      // Symbol carries the *ref* type — resolveIdent's autoDeref path handles loads.
      symbols.set(p.name, RefType(p === params[0] ? structType : p.resolvedBaseType));
    } else {
      const ty = p.resolvedBaseType;
      const llvmTy = llvmType(ty);
      symbols.set(p.name, ty);
      const align = ty.kind === typeKinds.struct ? alignOfStruct(ty) : alignOf(llvmTy);
      fnLines.push(`  %${p.name} = alloca ${llvmTy}, align ${align}`);
      fnLines.push(`  store ${llvmTy} %${p.name}.arg, ptr %${p.name}`);
    }
  }

  const ctx = { fnName: methodDecl.name, returnType };
  methodDecl.body.body.forEach((s) => emitStatement(s, fnLines, ctx));

  if (isVoidReturn(returnType)) {
    const last = fnLines[fnLines.length - 1].trim();
    if (!last.startsWith("ret")) fnLines.push("  ret void");
  }

  fnLines.push("}");
  lines.push(...fnLines);
}
```

Key observation: `self` is just a `ref T` binding in the symbol table, exactly like `let p: ref int32 = ref n`. The phase-4 auto-deref machinery does almost all the work — but only for primitive `inner`. Phase 5 extends it for struct `inner` (§6.b).

### 6.b Auto-deref for struct refs

`emitIdent` currently handles `node.autoDeref` only for primitive `inner` ([codegen.js:441-448](../src/jsyoopcodegen/codegen.js#L441)):

```js
// current:
if (node.autoDeref) {
  const innerType = yoopType.inner;
  const ptrTmp = freshTemp();
  fnLines.push(`  ${ptrTmp} = load ptr, ptr %${node.name}`);
  const valTmp = freshTemp();
  fnLines.push(`  ${valTmp} = load ${llvmType(innerType)}, ptr ${ptrTmp}`);
  return { val: valTmp, yoopType: innerType };
}
```

For a struct `inner` (e.g. `self`), this still produces *correct* IR — `load %struct.FileHandle, ptr %ptr` is a valid LLVM instruction (LLVM happily loads aggregate types). The `valTmp` holds the struct *value* by-value. That's fine for read-only uses. It's wrong for **field access on `self`**: `self.fd` should GEP off the *pointer*, not the loaded struct value, so that `self.fd = 5` writes through the pointer.

The fix: extend `emitLvalue` ([codegen.js:246](../src/jsyoopcodegen/codegen.js#L246)) IDENT case to handle `ref T` bindings — load the pointer once, then return the loaded pointer as the lvalue address:

```js
case ASTNodeKind.IDENT: {
  const t = symbols.get(node.name);
  if (!t) throw new Error(`codegen: unknown identifier "${node.name}"`);
  if (t.kind === typeKinds.ref) {
    // The slot holds a pointer to the actual storage. Load it once so
    // downstream FIELD_ACCESS / INDEX_EXPRESSION GEPs operate on the right base.
    const ptrTmp = freshTemp();
    fnLines.push(`  ${ptrTmp} = load ptr, ptr %${node.name}`);
    return { ptr: ptrTmp, type: t.inner };
  }
  return { ptr: `%${node.name}`, type: t };
}
```

This change affects every `ref T` binding, not just `ref self`. For `let p: ref int32 = ref n`, an lvalue use of `p` (like `p = 99`) goes through `emitLvalue` and now correctly loads the pointer first. **But** the existing primitive auto-deref-write path in `resolveAssignmentToIdent` + `emitExpr ASSIGNMENT` doesn't go through `emitLvalue` — it has its own `autoDerefWrite` short-circuit ([codegen.js:483-499](../src/jsyoopcodegen/codegen.js#L483)). That path stays unchanged. The new lvalue branch only fires when `emitLvalue` is called explicitly (e.g. inside `FIELD_ACCESS`, `INDEX_EXPRESSION`, or `REF_EXPRESSION` lowering).

For `emitIdent`'s autoDeref read context, the existing code handles aggregate inner correctly — `load %struct.T, ptr %ptr` is a valid LLVM instruction. No change required, but adding a struct-aware branch as documentation is fine.

For `resolveAssignmentToIdent` auto-deref-write of a struct ref: `self.field = expr` doesn't go through assignment-to-IDENT (the target is FIELD_ACCESS, not IDENT). `self = something` would, but assigning a whole struct through `self` is a useful corner case; the existing auto-deref-write path already works for any `inner` type because LLVM `store` handles aggregates.

### 6.c `REF_EXPRESSION` of a struct field or struct binding

`emitExpr` for `REF_EXPRESSION` ([codegen.js:455-459](../src/jsyoopcodegen/codegen.js#L455)) currently does:

```js
case ASTNodeKind.REF_EXPRESSION: {
  const innerType = symbols.get(node.operand.name);
  return { val: `%${node.operand.name}`, yoopType: node.resolvedType ?? { kind: typeKinds.ref, inner: innerType } };
}
```

This assumes the operand is always an IDENT and returns the alloca slot. For `let h: FileHandle = { ... }`, the alloca slot is the struct's address — exactly what we want to pass as `ref h` to `dispose`. **No change needed for this primary case.**

But what about `ref self` inside a method body? `self` is a `ref T` binding — its alloca slot holds a pointer, not the struct. So `ref self` should yield the underlying pointer, not the pointer-to-the-pointer. The change:

```js
case ASTNodeKind.REF_EXPRESSION: {
  // `ref expr` returns the address of the operand.
  if (node.operand.kind === ASTNodeKind.IDENT) {
    const operandType = symbols.get(node.operand.name);
    if (operandType?.kind === typeKinds.ref) {
      // Operand is itself a ref binding (like `self`). Forward the underlying ptr.
      const ptrTmp = freshTemp();
      fnLines.push(`  ${ptrTmp} = load ptr, ptr %${node.operand.name}`);
      return { val: ptrTmp, yoopType: node.resolvedType ?? operandType };
    }
    return { val: `%${node.operand.name}`, yoopType: node.resolvedType ?? RefType(operandType) };
  }
  // FIELD_ACCESS or INDEX_EXPRESSION operand: use emitLvalue.
  const lv = emitLvalue(node.operand, fnLines);
  return { val: lv.ptr, yoopType: node.resolvedType ?? RefType(lv.type) };
}
```

This is the second concrete instance of "phase 4's primitive ref machinery doesn't fully cover struct refs."

### 6.d `emitCall` for trait methods

`emitCall` currently has branches for: cast → namespace call → printf → general call. Add a trait-method branch keyed on `node.calleeMethodOf`:

```js
function emitCall(node, fnLines) {
  if (node.isCast) { /* unchanged */ }
  if (node.callee && typeof node.callee === "object" && node.callee.namespaceLookup) { /* unchanged */ }
  if (node.callee === "printf" && !currentExternNames.has("printf")) { /* unchanged */ }

  // Trait method call: typechecker stamped the call with the type and mangled name.
  if (node.calleeMethodOf) {
    const argResults = node.args.map((a) => emitExpr(a, fnLines));
    const sig = node.calleeMethodOf.methods.get(node.callee);
    const argList = sig.params.map((p, i) => {
      const llvmTy = p.isRef ? "ptr" : llvmType(p.type);
      return `${llvmTy} ${argResults[i].val}`;
    }).join(", ");
    const llvmRet = llvmType(sig.returnType);
    const mangledName = node.calleeMangledName;
    if (llvmRet === "void") {
      fnLines.push(`  call void @${mangledName}(${argList})`);
      return { val: "void", yoopType: VoidType() };
    }
    const tmp = freshTemp();
    fnLines.push(`  ${tmp} = call ${llvmRet} @${mangledName}(${argList})`);
    return { val: tmp, yoopType: sig.returnType };
  }

  // ... existing general call path
}
```

Concrete IR for `dispose(ref h)` where `h: FileHandle` lives in `main.yoop`:

```llvm
%h = alloca %struct.main_<hash>__FileHandle, align 4
; ... struct literal initialization elided
call void @main_<hash>__FileHandle__dispose(ptr %h)
```

Concrete IR for the recursive `dispose(ref self)` inside a method body:

```llvm
; self.arg is the ptr param; %self is its alloca slot
%self = alloca ptr, align 8
store ptr %self.arg, ptr %self
; ... later, when emitting `dispose(ref self)`:
%t1 = load ptr, ptr %self            ; load the original pointer
call void @main_<hash>__FileHandle__dispose(ptr %t1)
```

### 6.e Module-level emission of method bodies

`emitProgram` currently iterates `node.body` looking for `FUNCTION_DECL` / `EXPORT_DECL` / `EXPORT_C_FUNCTION_DECL`. Extend the loop to emit methods:

```js
// third pass: emit function bodies (existing loop)
for (const decl of node.body) {
  if (decl.kind === ASTNodeKind.FUNCTION_DECL) {
    emitFunction(decl);
  } else if (decl.kind === ASTNodeKind.EXPORT_DECL && decl.decl.kind === ASTNodeKind.FUNCTION_DECL) {
    emitFunction(decl.decl);
  } else if (decl.kind === ASTNodeKind.EXPORT_C_FUNCTION_DECL) {
    emitFunction(decl.fn, decl.fn.name);
  } else if (decl.kind === ASTNodeKind.TYPE_DECL && decl.methods?.length > 0) {
    for (const method of decl.methods) {
      emitMethod(method, decl.resolvedType);
    }
  } else if (decl.kind === ASTNodeKind.EXPORT_DECL && decl.decl.kind === ASTNodeKind.TYPE_DECL && decl.decl.methods?.length > 0) {
    for (const method of decl.decl.methods) {
      emitMethod(method, decl.decl.resolvedType);
    }
  }
  // TRAIT_DECL: no codegen — traits are compile-time only.
}
```

`TRAIT_DECL` produces no IR at all. Trait declarations exist exclusively at the typechecker level. The first-pass signature collection skips over them naturally.

The codegen file currently has **two** `emitExpr` switches and **two** module-emission paths — the single-module path (around `codegen.js:410`/`codegen.js:1107`) and the multi-module path inside `codegenWithModuleId` (around `codegen.js:1564`/`codegen.js:1107` equivalent). Phase 5 must update both, exactly the way the BOOL_LITERAL extension touched both.

### 6.f Method-symbol tracking for `collectCalls`

`collectCalls` walks the AST building a set of called names so the legacy auto-extern path can declare them. Trait method calls aren't a concern here — they're routed through `node.calleeMangledName` directly, so the `typeof n.callee === "string"` branch sees the bare method name `dispose`, which is *not* in `defined`, and would mistakenly add it to the auto-extern set.

Fix: skip calls whose `calleeMethodOf` is set:

```js
if (
  n.kind === ASTNodeKind.CALL_EXPRESSION &&
  typeof n.callee === "string" &&
  !defined.has(n.callee) &&
  !n.calleeMethodOf                        // new
) {
  called.add(n.callee);
}
```

Without this, the legacy `externDecl` fallback would emit a stray `declare i32 @dispose(...)` line.

### 6.g `functionSigs` map — methods don't go in

The `functionSigs` map registers free functions and externs. Methods are not registered there — their `FuncType` lives on `StructType.methods`. The `emitCall` trait-method branch reads from `node.calleeMethodOf.methods.get(...)` directly, bypassing `functionSigs`. Keep `functionSigs` free of method signatures to avoid name-clash confusion.

### 6.h Cross-module method calls

`io.yoop` declares `type FileHandle implements Disposable { fd: int32, function dispose(ref self): void { ... } }` and exports it. `main.yoop` does `import { FileHandle } from "./io.yoop"` and calls `dispose(ref h)`.

By the time codegen runs on `main.yoop`'s `main()`:
- The `FileHandle` `StructType` is the same canonical object both modules share (pass C.5 re-sync).
- `node.calleeMangledName` was set by `resolveCall` to `io_<hash>__FileHandle__dispose`.
- Codegen emits `call void @io_<hash>__FileHandle__dispose(ptr %h)`.

Because `io.yoop` is in the same compilation unit (single LLVM IR file from `codegenProgram`), the symbol is `define`d when emitted from `io.yoop`'s third-pass and called from `main.yoop`'s third-pass — no `declare` line needed.

### 6.i Struct-name mangling reminder

Phase 3 mangled struct names per-module (`%struct.<modId>__<TypeName>`). The methods follow suit: `methodDecl.mangledSymbol` is computed from `structType.moduleId`, which is the *defining* module's id. Combined with the orphan-rule restriction (§8.j), `mod.id === structShell.moduleId` always, so the mangled symbol is consistent.

---

## 7. Tests

### 7.1 Pass fixtures — [examples/pass/](../examples/pass/)

Multi-file fixtures live in directories with a `main.yoop` entry; single-file fixtures live as `.yoop` files at the top of `examples/pass/`. However, each test in the traits phase should be added using the multi-file structure and put in their own subfolder and use the multi-file area in the e2e js tests.

#### `traits_disposable.yoop` — single trait, single impl, single call

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

trait Disposable {
    function dispose(ref self): void;
}

type FileHandle implements Disposable {
    fd: int32,
    function dispose(ref self): void {
        printf(`disposing fd=${self.fd}\n`);
    }
}

function main(): int32 {
    let h: FileHandle = { fd: 7 };
    dispose(ref h);
    return 0;
}
```

Expected stdout:
```
disposing fd=7
```

Exercises: trait decl, impl with one method, single call site, `self.fd` field read inside method body.

#### `traits_multi_impl.yoop` — one type implementing two traits

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

trait Disposable {
    function dispose(ref self): void;
}

trait Closable {
    function close(ref self): int32;
}

type FileHandle implements (Disposable, Closable) {
    fd: int32,
    is_open: bool,
    function dispose(ref self): void {
        printf(`disposing fd=${self.fd}\n`);
        self.is_open = false;
    }
    function close(ref self): int32 {
        printf(`closing fd=${self.fd}\n`);
        self.is_open = false;
        return self.fd;
    }
}

function main(): int32 {
    let h: FileHandle = { fd: 7, is_open: true };
    let rc: int32 = close(ref h);
    dispose(ref h);
    printf(`rc=${rc} is_open=${h.is_open}\n`);
    return 0;
}
```

Expected stdout:
```
closing fd=7
disposing fd=7
rc=7 is_open=0
```

Exercises: parenthesized `implements (A, B)`, two methods on same type, method call returning a value, method body writing `self.field = expr`, post-call observation of mutated state.

#### `traits_two_types_one_trait.yoop` — distinct types implementing the same trait

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

trait Disposable {
    function dispose(ref self): void;
}

type FileHandle implements Disposable {
    fd: int32,
    function dispose(ref self): void {
        printf(`file fd=${self.fd}\n`);
    }
}

type Socket implements Disposable {
    sock: int32,
    function dispose(ref self): void {
        printf(`socket sock=${self.sock}\n`);
    }
}

function main(): int32 {
    let h: FileHandle = { fd: 1 };
    let s: Socket = { sock: 99 };
    dispose(ref h);
    dispose(ref s);
    return 0;
}
```

Expected stdout:
```
file fd=1
socket sock=99
```

Exercises: same method name on two distinct types resolved correctly (each call site's mangled symbol is different).

#### `traits_self_field.yoop` — method body reads multiple fields

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

trait Encodable {
    function encode(ref self): int32;
}

type Point implements Encodable {
    x: int32,
    y: int32,
    function encode(ref self): int32 {
        return self.x * 100 + self.y;
    }
}

function main(): int32 {
    let p: Point = { x: 3, y: 4 };
    printf(`encoded=${encode(ref p)}\n`);
    return 0;
}
```

Expected stdout: `encoded=304`.

Exercises: method that returns a non-void value, multiple field reads on `self`, method called from outside.

#### `traits_self_call_other_method.yoop` — method body calls another method on the same type

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

trait Closable {
    function close(ref self): int32;
}

trait Disposable {
    function dispose(ref self): void;
}

type FileHandle implements (Closable, Disposable) {
    fd: int32,
    function close(ref self): int32 {
        printf(`closing fd=${self.fd}\n`);
        return self.fd;
    }
    function dispose(ref self): void {
        let rc: int32 = close(ref self);
        printf(`disposed via close (rc=${rc})\n`);
    }
}

function main(): int32 {
    let h: FileHandle = { fd: 42 };
    dispose(ref h);
    return 0;
}
```

Expected stdout:
```
closing fd=42
disposed via close (rc=42)
```

Exercises: method body invoking another method on the same type via the free-function form, `ref self` passed onward.

#### `traits_cross_module/` — trait declared in module A, implemented in B, called in main

```
traits_cross_module/
    main.yoop
    iface.yoop
    impl.yoop
```

`iface.yoop`:
```yoop
export trait Disposable {
    function dispose(ref self): void;
}
```

`impl.yoop`:
```yoop
import { Disposable } from "./iface.yoop";
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

export type FileHandle implements Disposable {
    fd: int32,
    function dispose(ref self): void {
        printf(`disposing fd=${self.fd}\n`);
    }
}
```

`main.yoop`:
```yoop
import { FileHandle } from "./impl.yoop";
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

function main(): int32 {
    let h: FileHandle = { fd: 13 };
    dispose(ref h);
    return 0;
}
```

Expected stdout: `disposing fd=13`.

Exercises: trait import, struct import, cross-module method dispatch, mangled symbol uses `impl.yoop`'s module id (where the type is defined).

#### `traits_recursive_method.yoop` — method calling itself

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

trait Counter {
    function tick(ref self): void;
}

type Tick implements Counter {
    n: int32,
    function tick(ref self): void {
        if (self.n <= 0) { return; }
        printf(`n=${self.n}\n`);
        self.n = self.n - 1;
        tick(ref self);
    }
}

function main(): int32 {
    let t: Tick = { n: 3 };
    tick(ref t);
    return 0;
}
```

Expected stdout:
```
n=3
n=2
n=1
```

Exercises: tail-recursive trait method body with `ref self` re-passed, mutation of `self.n`, terminating condition. Asserts the parser doesn't loop forever and the typechecker resolves the recursive call to the same method.

### 7.2 Fail fixtures — [examples/fail/](../examples/fail/)

| File | Snippet | Expected error pattern |
|---|---|---|
| `traits_missing_method.yoop` | `type T implements Disposable { fd: int32, }` (no `dispose`) | `type "T" implements trait "Disposable" but is missing method "dispose"` |
| `traits_wrong_signature_return.yoop` | impl method has return type `int32` while trait says `void` | `method "dispose" on type "T" has signature .*, expected .* from trait "Disposable"` |
| `traits_wrong_signature_param.yoop` | impl method takes extra param not in trait sig | same shape as above |
| `traits_collision_two_traits.yoop` | `type T implements (A, B)` where both traits declare `m` | `type "T" cannot implement both "A" and "B" — both require method "m"` |
| `traits_collision_with_function.yoop` | a free `function dispose(...)` exists in same module as `type T implements Disposable { ... function dispose(ref self): ... }` | `method "dispose" on type "T" collides with module-level function "dispose"` |
| `traits_self_outside.yoop` | `function f(): int32 { return self.x; }` (no method context) | `the keyword 'self' can only be used inside a trait method body` |
| `traits_extra_method.yoop` | impl block has a method whose name isn't required by any trait | `type "T" declares method "extra", but no implemented trait requires it` |
| `traits_ref_self_by_value.yoop` | `function dispose(self): void;` in a trait decl (no `ref`) | `trait method "dispose" must take 'ref self' as its first parameter` |
| `traits_method_no_implements.yoop` | `type T { function m(ref self): void { } }` | `methods are only allowed inside an 'implements' block` |
| `traits_unknown_trait.yoop` | `type T implements Foo { ... }` where `Foo` is undefined | `type "T" implements unknown trait "Foo"` |
| `traits_default_body_in_trait.yoop` | `trait Foo { function m(ref self): void { } }` (body in trait) | `expected semicolon, got lcurly` (parser error) |
| `traits_extends_rejected.yoop` | `trait Sub extends Super { ... }` | `extends not yet supported` |
| `traits_generic_rejected.yoop` | `trait Iter<T> { ... }` | `generic traits not yet supported` |
| `traits_method_call_sugar.yoop` | `h.dispose()` (object form) | `method-call form .* is not supported — use 'dispose(ref h)' instead` |
| `traits_redeclared_method.yoop` | impl block lists `dispose` twice | `duplicate method "dispose" in type "T"` |
| `traits_self_assignment_wrong_type.yoop` | `self.fd = "hi"` where `fd: int32` | regular assignment-type-mismatch error from phase 1 typechecker — verify it works through the auto-deref |

### 7.3 Updating `e2e.test.js`

Each pass fixture gets an `it()` that:
1. Compiles via `compileSource` (single-file) or `compileEntry` (multi-file).
2. Asserts exit code is 0.
3. Asserts stdout matches the expected literal.

Each fail fixture uses `typecheckSource` (single-file) or `typecheckProgram` (multi-file) and asserts that `errors[0].message` matches the listed pattern.

```js
it("traits_disposable produces expected output", () => {
  const { stdout, exitCode } = runFixture("examples/pass/traits_disposable.yoop");
  assert.equal(exitCode, 0);
  assert.equal(stdout, "disposing fd=7\n");
});

it("traits_missing_method fails typecheck", () => {
  const { errors } = typecheckSource(readFile("examples/fail/traits_missing_method.yoop"));
  assert.match(errors[0].message, /missing method "dispose"/);
});
```

### 7.4 Unit tests

- **[lexer.test.js](../src/jsyooplexer/lexer.test.js)** — new keywords lex correctly, including in identifier-adjacent positions (`disposable` ≠ `dispose` followed by `able`).
- **[parser.test.js](../src/jsyooparser/parser.test.js)** — every accept case in §3.f and reject case in §3.g.
- **[typecheck.test.js](../src/jsyooptypecheck/typecheck.test.js)** — pass-by-pass: trait shells in pass A, trait method sigs in pass C.1, impl validation in pass C.3 (missing method, wrong sig, collision), self in scope inside method bodies.
- **[checkExpr.test.js](../src/jsyooptypecheck/checkExpr.test.js)** — `resolveCall` falls through to trait dispatch when the free-function lookup misses; `self` outside method context is rejected.

### 7.5 Codegen IR-shape tests

In [codegen.test.js](../src/jsyoopcodegen/codegen.test.js):

- An impl block produces a function definition with the mangled name `<modId>__<TypeName>__<methodName>`.
- The first param of every method is `ptr %self.arg`.
- A call to `dispose(ref h)` emits `call void @<modId>__FileHandle__dispose(ptr %h)` (the alloca slot of `h` is the right ptr).
- A method body's `self.fd` produces a `getelementptr inbounds %struct.<modId>__FileHandle, ptr %ptr_loaded, i32 0, i32 0` where `%ptr_loaded` is the loaded pointer from `%self`'s alloca slot.
- A method body's `self.fd = N` produces a GEP + `store i32 N`.
- A `ref self` passed to another method emits `load ptr, ptr %self` followed by `call void @... (ptr %loaded)`.
- Two distinct types with the same method name (`FileHandle.dispose` and `Socket.dispose`) emit two distinct `define` lines with different mangled names.
- A trait declaration emits **zero** IR (no `define`, no `declare`, no `%struct.*`).

---

## 8. Edge cases worth getting right

### 8.a Method body calling itself recursively

`type T implements Foo { function tick(ref self): void { tick(ref self); } }`. The impl method's name `tick` is **not** registered in `localSymbols` (only the type's `methods` map carries it). When `resolveCall` is invoked on the inner `tick(ref self)`:

1. `localSymbols.get("tick")` returns nothing.
2. `KNOWN_EXTERNS["tick"]` returns nothing.
3. The trait-dispatch branch fires: first arg is `REF_EXPRESSION { operand: IDENT("self") }`, `self`'s resolved type is `T`, and `T.methods.has("tick")` is true.
4. The call is resolved to the same mangled `<modId>__T__tick`, and codegen emits a regular self-recursive call.

The parser doesn't loop because the body is consumed left-to-right with regular precedence rules; the inner `tick(ref self)` is a `CALL_EXPRESSION` with no special handling, just like any function call.

### 8.b Impl method shadows a free-function name

The collision check in pass C.3 catches this. Concretely:

```yoop
function dispose(x: int32): void { /* free function */ }

trait Disposable { function dispose(ref self): void; }
type T implements Disposable {
    fd: int32,
    function dispose(ref self): void { ... }
}
```

Pass A registers `dispose` in `localSymbols`. Pass C.3 sees `T` declares method `dispose`, checks `localSymbols.has("dispose")`, and emits the collision error. The user's options: rename the free function, or rename the trait method (which means renaming the trait method declaration too).

### 8.c A trait method's return type references the implementing type

```yoop
trait Cloner {
    function clone(ref self): FileHandle;   // names the implementing type explicitly
}

type FileHandle implements Cloner {
    fd: int32,
    function clone(ref self): FileHandle { return { fd: self.fd }; }
}
```

This works: `FileHandle` resolves at trait-decl time because pass A registers struct shells before C.1 runs. The trait method's return type is `FileHandle`, fully resolved. Pass C.3 substitutes `self` (no occurrences in the return type here) and matches against the impl's return type `FileHandle`. Equal. Done.

The reason `Self` isn't needed: traits in this phase aren't generic, so there's no "what type does `Self` mean across multiple impls?" question. Each trait that names a return type names exactly one type — and that's enough.

### 8.d `ref self` composing with phase-4 argument propagation

Method `f` calls method `g` via `g(ref self)`. The `ref self` expression is `load ptr, ptr %self` (loading the original pointer that was passed to `f`). The call `@T__g(ptr %loaded)` then receives the original pointer — matching how `let p: ref int32 = ref n; increment(p)` works in phase 4. The composability is automatic once the `REF_EXPRESSION` of a ref-binding case is correct (§6.c).

### 8.e Cross-module: trait in A, impl in B, call in C

The mangling rule fixes the resolution: the method's symbol is built from the *defining type's* module id, not the calling site's. So `traits_cross_module/` (§7.1) emits `@impl_<hash>__FileHandle__dispose` and the call from `main.yoop` references that exact symbol regardless of where the trait was declared.

The trait's module id is irrelevant at the call site — the trait is consulted only during typechecking (to validate the impl matches). Codegen doesn't read the trait at all.

### 8.f A type with a `methods` block but no `implements`

Already handled in §3.c parser code: `parseTypeDecl` rejects with `methods are only allowed inside an 'implements' block`. This matches spec §5/§7's stance. No "free methods" are allowed.

### 8.g Empty trait

`trait Marker { }` parses fine. Pass C.1 builds an empty `methods` map. A `type T implements Marker { ... }` impl validates trivially (no required methods to satisfy, no extras allowed). The trait is a tag with no observable behavior — useful as a placeholder for kinds in phase 6 (a kind's `requires Marker` clause becomes a typecheck-only constraint that the type has the trait, even though the trait carries no methods).

### 8.h Trait name conflicting with struct or function name

The `redeclaration of "<name>"` check in pass A walks all kinds. A trait named `FileHandle` colliding with a struct named `FileHandle` in the same module is a hard error. A single import that brings in both a struct and a trait with the same name from different modules collides on the local name (`local name "X" collides with an existing declaration`, from phase 3's `resolveImports`). User must rename via `as`.

### 8.i Self-substitution edge case: a trait that takes a `ref T` non-self param

```yoop
trait Pairwise {
    function combine(ref self, other: int32): int32;
}
```

The `other` param is a regular `int32`, no self-substitution needed. The `self` substitution path only touches param 0 (whose name is exactly `self` and whose type is `RefType { TraitSelfPlaceholder }`). Other params resolve normally.

If a trait wanted to take a `ref T` for the same `T` that implements it (`function compare(ref self, other: ref Self): int32`) — that needs `Self`, which is deferred. For now, traits that need this can name the type explicitly (`other: ref FileHandle`), which only works for traits with a single specific impl type — i.e., traits as glorified type tags. Acceptable for v0; revisit when generics land.

### 8.j Orphan rule: implementing a trait on a struct from another module

```yoop
// foreign.yoop
export type FileHandle { fd: int32, }

// main.yoop
import { FileHandle } from "./foreign.yoop";
trait Disposable { function dispose(ref self): void; }
type FileHandle implements Disposable { ... }    // ?
```

This is "implementing a trait on a foreign type" (Rust calls it the orphan rule problem). Phase 5 forbids it: `type T implements ...` declares a *new* type, not an extension of an import. The line `type FileHandle implements ...` is a redeclaration error (pass A's name-collision check fires because `FileHandle` is already in `structTable` via the import).

The user wanting this pattern has two options: declare `Disposable` and `FileHandle` in the same module, or wrap (`type MyHandle { inner: FileHandle, }` and `type MyHandle implements Disposable { ... }`). Document this restriction.

### 8.k Trait methods can be variadic? (no.)

The `METHOD_SIG` path doesn't accept `...`. Only `EXTERN_FUNCTION_DECL` accepts variadic. Unsurprising, but worth pinning so a future maintainer doesn't try.

### 8.l A method body returning `self`

```yoop
type Builder implements ChainedAdd {
    n: int32,
    function add(ref self, x: int32): Builder {
        self.n = self.n + x;
        return self;
    }
}
```

`self`'s resolved type inside the body is `Builder` (auto-deref of `ref Builder`). The return type annotation is `Builder`. The return statement produces a value of type `Builder`. This works — the auto-deref'd `self` is a struct value, copyable, returnable. The downside is that the returned value is a *copy*, not a reference to the original — phase 4 §11.b forbids `ref T` return values until lifetime tracking lands. Document this as a known limitation.

### 8.m Method body uses `?` operator

A method whose return type is fallible can use `?`. The `?` operator inspects `ctx.funcReturnType` ([checkExpr.js:579](../src/jsyooptypecheck/checkExpr.js#L579)) — `validateMethod` sets that field correctly to the method's declared return type. No new code; `?` works inside method bodies the same as inside free functions.

### 8.n Method body uses arrays and for-loops

The phase-4 features compose with method bodies because `validateMethod` reuses the same `validateStatement` walker. `self.xs.len` is `FIELD_ACCESS` on `FIELD_ACCESS` on `IDENT(self)` — auto-deref happens at `self`, then field lookup chains. `self.xs[i]` is an `INDEX_EXPRESSION` whose `object` is the chained field access. All existing infrastructure.

### 8.o A method that takes additional `ref` params

```yoop
trait Fillable {
    function fill(ref self, source: ref int32): void;
}
```

The extra `ref` param `source` is a phase-4 ref param. Lowers to `ptr` at LLVM level. Method's signature: `define void @T__fill(ptr %self.arg, ptr %source.arg)`. Call site: `fill(ref h, ref n)` — both args are `REF_EXPRESSION`, both lowered to ptr.

### 8.p Trait or impl inside an extern block

Not allowed — `parseExternBlock` accepts only `function` and `type` decls inside braces. The existing `unexpected token in extern block` error suffices.

### 8.q Multiple impl blocks for the same type

The grammar doesn't allow it: `type T implements (A, B) { ... }` is one declaration site. If you want to implement multiple traits, you list them in the parenthesized form. Two `type T implements ...` declarations would be a redeclaration error (pass A).

### 8.r `ref self` in a trait that takes `ref` of an array or struct

A trait method's *other* params can be `ref T` for any `T`, including arrays and structs (the new struct-ref support from §6.b applies). Concretely:

```yoop
trait MoveInto {
    function move_into(ref self, dst: ref FileHandle): void;
}
```

Both `self` and `dst` are `ref T`-where-T-is-a-struct. Both lower to `ptr`. The method body uses `dst.fd = self.fd` and `dst.is_open = self.is_open` through the auto-deref.

### 8.s Method names that shadow built-in `.len`

`type T implements Foo { function len(ref self): int32 { ... } }` — `len` is not reserved. The struct-field-`.len` intrinsic for arrays operates on an array type, not a struct field. The free-function call `len(ref t)` resolves to the method (no free function `len` exists in `localSymbols`). No conflict.

### 8.t Method names that collide with C externs

`type T implements Disposable { function close(ref self): int32 { ... } }` in a module that also has `extern "C" from "stdio.h" { function close(fd: int32): int32; }`. Pass C.3 detects this: `localSymbols.has("close")` is true (the extern is in localSymbols), and the no-collision-with-free-function rule fires. User must rename one or the other.

### 8.u An impl block whose methods are listed in a different order than the trait

Trait says `dispose, close`; impl block has `close, dispose`. No problem — the resolver matches by method name, not by position.

---

## 9. Implementation order

Each step keeps prior tests green and is independently bisect-able. The progression mirrors phase 4: lexer → AST → parser-decls → parser-bodies → types → typecheck → codegen → fixtures.

1. **Lexer** — add `trait`, `implements`, `self`, `extends` tokens. Unit tests in [lexer.test.js](../src/jsyooplexer/lexer.test.js). After this step, source files containing these keywords lex but the parser still throws "unexpected token at top level" (or in the case of `self`, "unexpected token: self").

2. **AST kinds** — add `TRAIT_DECL`, `METHOD_SIG`, `METHOD_DECL` to [contracts.js](../src/contracts.js). Add `implements` and `methods` fields to `TYPE_DECL`. No logic change. Run all phase-1-4 tests; they must still pass.

3. **Parser — decls, no method bodies** — add `parseTraitDecl`, `parseMethodSig`. Wire `parseTopLevel` and `parseExportDecl` to dispatch on `trait`. Add `parseTypeDecl` extension for `implements` clause (without method bodies — yet). Add the early rejects for `extends` and generic traits. Add `parseAtom` branch for `self` ident. Add unit tests for accept/reject cases that don't involve method bodies. After this step, `trait Disposable { function dispose(ref self): void; }` parses; `type T implements Disposable { fd: int32 }` parses (with empty methods array); `extends` is rejected with the correct message.

4. **Parser — method bodies** — add `parseMethodDecl`. Extend `parseTypeDecl` body loop to accept method decls alongside fields. Add the "methods require implements" check. Tests for accept (a type with one method) and reject (method without implements). After this step, full impl blocks parse; the typechecker doesn't yet know about traits/methods.

5. **Type system — `TraitType`, struct extensions** — add `TraitType`, `TraitSelfPlaceholder`, extend `StructType` with `implementsTraits` and `methods`. Add `selfType` annotation kind to `resolveTypeAnnotation`. Update `formatType` and `typesEqual`. Unit tests for the new types.

6. **Typechecker — pass A trait shells** — register `TRAIT_DECL` shells in a new `traitTable` per module. Redeclaration checks. Unit test: `traitTable` populated correctly after pass A.

7. **Typechecker — pass C.1 trait method sigs** — resolve each trait method's signature with `selfType: TraitSelfPlaceholder`. Validate no duplicate method names within a trait. Unit test: trait method sigs are correctly stored on `TraitType.methods`.

8. **Typechecker — pass C.3 impl validation** — `validateImplBlock` covers all the rules: missing methods, extra methods, wrong signature, two-trait collision, free-function collision. After this step, impl blocks are validated but bodies aren't walked yet — codegen would crash if invoked. Skip codegen in this step's tests. Unit tests for every error case in §7.2.

9. **Typechecker — pass C.5 trait import re-sync** — handle `kind: "trait"` in the import overlay. Update `resolveImports` to classify trait exports correctly. Unit test: a cross-module trait import resolves to the same canonical `TraitType` object.

10. **Typechecker — `validateMethod` (pass D extension)** — push `self` into method body scope, walk body via existing `validateStatement`. `self` outside method context is rejected. Unit test: method body type-checks (using only existing expression handlers, no new logic).

11. **Typechecker — trait method dispatch in `resolveCall`** — fall through to trait dispatch when the free-function lookup misses. Annotate `node.calleeMethodOf` and `node.calleeMangledName`. Reject method-call sugar (`h.dispose()`). Unit tests: a call to a method resolves correctly; a call to method-call sugar errors with the right message.

12. **Codegen — struct ref support** — extend `emitLvalue` IDENT case to load through ref bindings. Extend `emitIdent` autoDeref case for struct inner. Extend `emitExpr REF_EXPRESSION` to handle ref-of-ref-binding. After this step, `let p: ref FileHandle = ref h; p.fd` works (this never worked before because phase 4 didn't allow struct refs). Add IR shape tests in [codegen.test.js](../src/jsyoopcodegen/codegen.test.js). **Apply the changes in both `emitExpr` switches** (single-module path ~L410 and multi-module path ~L1564) — same as the BOOL_LITERAL extension.

13. **Codegen — `emitMethod`** — parallel to `emitFunction`, mangled `<modId>__<TypeName>__<methodName>`, params spilled into stack slots, `self` spilled as a ptr. Wire `emitProgram` (and the multi-module variant) to emit methods alongside functions. Skip TRAIT_DECL entirely.

14. **Codegen — trait method calls in `emitCall`** — branch on `node.calleeMethodOf`, look up the method's `FuncType` on the type's `methods` map, emit the call with `ptr` for `ref` params and llvm types for the rest. Update `collectCalls` to ignore method calls. Unit tests for the IR shape.

15. **All pass fixtures** — one by one, in order of complexity from §7.1.

16. **All fail fixtures** — match the error patterns in §7.2.

17. **Cleanup + IR-shape regression tests** — add `traits_*` IR shape assertions to `codegen.test.js`. Verify no phase-1-4 fixture regresses by running the full e2e suite.

Each step independently merges and ships; the codebase is never in a half-broken state for more than one step.

---

## 10. Phase exit criteria

- Every pass fixture in §7.1 compiles via `yoopiler` and runs, producing exactly the expected stdout.
- Every fail fixture in §7.2 errors at typecheck (no crash) with a message matching the pattern.
- All existing phase-1-4 fixtures continue to compile and run identically (no regressions).
- Cross-module trait/impl in `traits_cross_module/` compiles and runs.
- IR-shape regression tests in [codegen.test.js](../src/jsyoopcodegen/codegen.test.js) pass — every method emits `define ... @<modId>__<TypeName>__<methodName>(...)`, every method body's `self.field` access GEPs off the loaded pointer (not the alloca slot), and trait declarations produce zero IR.
- `clang` accepts the generated IR for every pass fixture without errors or warnings.
- Parser and lexer unit tests for the new tokens, accept cases, and reject cases all pass.
- Typechecker unit tests verify the multi-pass shape: trait shells in pass A, sig resolution in C.1, impl validation in C.3, body validation in pass D.
- The same-name collision rules are enforced (no two implemented traits sharing a method name; no method colliding with a free function).
- `extends` and generic-trait syntax are rejected with the documented messages — neither hangs the parser nor produces a confusing typecheck error.

---

## 11. Risk and design questions worth knowing about

The scope decisions are solid. A handful of design choices were made inside this plan that should be visible to anyone implementing it:

### 11.a `self` as hard keyword (departure from "contextual" framing)

The original framing said `self` was "contextual." This plan promotes `self` to a hard keyword. Reasons in §2: contextual keywords require lexer-parser coupling that's expensive in this codebase, and the cost of disallowing `self` as a regular identifier elsewhere is one fewer commonly-used variable name. If the framing is preferred, the alternative is a re-tag pass on top of lex output — workable but adds ~80–100 lines of plumbing. Hard keyword wins on simplicity.

### 11.b `METHOD_DECL` vs reusing `FUNCTION_DECL`

This plan adds `METHOD_DECL` and `METHOD_SIG` rather than overloading `FUNCTION_DECL`. Reasons in §1: `FUNCTION_DECL` is shared by free functions, exported functions, and `EXPORT_C_FUNCTION_DECL` wrappers. Adding `implementsTrait`, `implementingType`, `mangledSymbol` to all of them pollutes the type. Method calls and free-function calls go through subtly different codegen paths (mangling rules differ), so a kind discriminator is useful.

### 11.c All trait methods are mutating (`ref self`)

Spec §5 says all trait methods take `ref self` — there's no `self` (by-value) form, and no `let self: T` form. This phase honors that exactly. **Risk:** there's no way for a trait to express "I only need to read `self`, not mutate it." All trait methods get a mutable pointer. This isn't broken — it's just a v2 spec choice that's coarser than what languages with `&self` vs `&mut self` provide. Defer the question to phase 7+.

### 11.d `extends` parser-rejection vs typecheck-rejection

This plan picks parser-rejection (§3.b). Alternative: parse the `extends Foo` clause into the AST and reject at typecheck. Parser-rejection is simpler for v0 — no AST kind needed. The downside: when a future phase lands `extends`, there's a small refactor to switch from "parse error" to "parse-and-typecheck-validate." Comfortable with parser-rejection because the dependent work is large enough that the refactor disappears in the noise. Same logic for generic traits.

### 11.e Cross-module trait orphan rule

Phase 5 forbids implementing a trait on a struct from another module (§8.j). **Risk:** real programs may want to add a trait to a foreign struct. Workaround: wrap the struct. If user demand surfaces, a future phase could add a separate `impl Trait for T { ... }` form — but that's a substantial new grammar and not v2 territory.

---

## 12. Critical files reference

- [SPEC.md §5 — Traits](../SPEC.md), [§7 — Functions / methods](../SPEC.md), [§17.2 — Trait method resolution](../SPEC.md) — re-read before each step.
- [src/contracts.js](../src/contracts.js) — three new AST kinds (`TRAIT_DECL`, `METHOD_SIG`, `METHOD_DECL`), `TYPE_DECL` extension.
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — four new tokens (`trait`, `implements`, `self`, `extends`).
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — `parseTraitDecl`, `parseMethodSig`, `parseMethodDecl`, `parseTypeDecl` extension, top-level dispatch, `parseAtom` `self` branch.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) — `TraitType`, `TraitSelfPlaceholder`, `StructType` extension, `resolveTypeAnnotation` `selfType` handling.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) — pass A trait shells, pass C.1 trait method sigs, pass C.3 `validateImplBlock`, pass C.5 trait import re-sync, pass D method body walk.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) — `resolveCall` trait-dispatch branch, `resolveIdent` `self`-outside-context error, method-call-sugar reject.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js) — `validateMethod` parallel to `validateFunction`, with self in scope.
- [src/jsyooptypecheck/imports.js](../src/jsyooptypecheck/imports.js) — `kind: "trait"` import classification and `lookupImportedTrait` helper.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — `emitMethod`, `emitLvalue`/`emitIdent` struct-ref support, `emitExpr REF_EXPRESSION` ref-of-ref handling, `emitCall` trait branch, `collectCalls` skip-method-calls. **Both `emitExpr` switches** (single-module ~L410 and multi-module ~L1564) need parallel updates.
- [src/e2e.test.js](../src/e2e.test.js) — pass and fail fixtures from §7.
