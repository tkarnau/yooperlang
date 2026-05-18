# Phase 6.1 — Disposable

Part of [phase 6 — kinds](./phase-6-kinds.md). Phase 5 implemented traits, struct refs, and free-function trait dispatch (`dispose(ref h)` mangled to `@<modId>__<Struct>__dispose`). The compiler can express "this type *supports* `dispose`" but has no way to enforce "this binding *must have* `dispose` called before scope exit." Sub-phase 6.1 introduces the minimum slice of [SPEC.md §6](../SPEC.md#L356) that closes the loop on `Disposable`: kind declarations, kind prefixes on bindings, `mustCall fn beforeScopeEnd` flow analysis, `ownsBlock` with implicit-block synthesis, and cleanup-call insertion at every exit point in the binding's scope.

## Goal

Land the bare-minimum subset of [SPEC.md §6](../SPEC.md#L356) that makes the `disposable` kind work end-to-end against the `Disposable` trait from phase 5:

```yoop
// disposable_basic.yoop
extern "C" from "stdio.h" {
    function printf(fmt: string, ...): int32;
}

trait Disposable {
    function dispose(ref self): void;
}

type FileHandle implements Disposable {
    fd: int32,
    function dispose(ref self): void {
        printf(`disposing fd=${self.fd}\n`);
    }
}

kind disposable {
    appliesTo binding;
    requires Disposable;
    ownsBlock;
    mustCall dispose beforeScopeEnd;
}

function main(): int32 {
    disposable a: FileHandle = { fd: 1 };
    disposable b: FileHandle = { fd: 2 };
    printf(`working\n`);
    return 0;
}
```

`yoopiler disposable_basic.yoop` must compile and print:

```
working
disposing fd=2
disposing fd=1
```

The output proves four things at once: (1) the kind decl parses and validates; (2) the kind prefix on `a` and `b` is recognized and binds a `Disposable`-implementing type; (3) the compiler inserts `dispose(ref b)` and `dispose(ref a)` at function fall-through; (4) implicit-block synthesis uses reverse declaration order (LIFO).

Concretely, this sub-phase delivers:

- `kind foo { ... }` top-level decl, parsed with these clauses: `appliesTo <site>;`, `requires <Trait>;`, `mustCall <fn> beforeScopeEnd;`, `ownsBlock;`. Each clause is a `keyword arg...;`-terminated statement; there are no parens, no colons, and no method chains in clause syntax. Other clauses (`provides`, `mustNotEscape`, `mustNotShare`, `forbids`, `layout`, `restricts`, `autoJoin`, `propagates`, `contains`, parameterized kinds, `&` composition) are rejected with explicit "not yet supported" parse errors.
- `appliesTo` restricted to the single value `binding`. Other application sites (`parameter`, `field`, `function`, `type`, multi-site lists like `appliesTo function binding`) are rejected at parse time with "appliesTo <site> not yet supported in phase 6.1". The default ("any value-site") is forbidden — the clause is required, and must be `binding`.
- Kind-prefixed bindings at statement position: `disposable a: FileHandle = expr;`. The kind prefix replaces (or precedes) the `let` / `const` keyword. Per [SPEC.md §4.4](../SPEC.md#L221), a kind-prefixed binding without `let` is implicitly `const`. `let disposable a: FileHandle = expr;` is also legal, for explicit mutability. `const disposable a: FileHandle = expr;` is legal but redundant — accepted, not flagged.
- Trailing block on a binding whose kind declares `ownsBlock`: `disposable a: FileHandle = expr { ...statements... }`. The block is the binding's scope; the binding is not visible after the block's `}`. Without the trailing block, the binding's scope is the tail of the enclosing scope (implicit-block form, [SPEC.md §4.5](../SPEC.md#L235)).
- Multiple implicit-block bindings in the same enclosing scope nest in reverse declaration order. `dispose(ref b)` fires before `dispose(ref a)`.
- A new flow-analysis pass (`kindCheck.js`) that, for every `disposable` binding, attaches a cleanup record to the AST. At each exit point in the binding's scope (`return`, fall-through `}`, `?` early return), it inserts a synthetic cleanup-call node referencing the binding. Codegen consumes these nodes and emits trait-method calls in LIFO order.
- A failed `?` inside a `disposable`'s scope fires cleanup *before* the early `ret`. This is the only feature in this phase that couples kindCheck to the existing `?` codegen.
- Validation that the binding's RHS type implements every trait listed in the kind's `requires` clause. A non-`Disposable` type bound under `disposable` is a typecheck error.

## Why this is first

Three reasons.

1. **Disposable is half a feature without `mustCall`.** Phase 5 lets you write `dispose(ref h)` but nothing makes you. The whole reason to declare `trait Disposable` is to wire cleanup into the compiler. Until 6.1 lands, every FFI handle (`fopen`, `malloc`, `pthread_create`) is hand-disposed at every site.

2. **It exercises the kind machinery on a single, tractable clause.** `mustCall fn beforeScopeEnd` is the simplest dynamic-rule clause in the spec. It needs scope tracking, exit-point enumeration, and codegen at synthetic insertion points — exactly the infrastructure that 6.2 (escape/share) and 6.3 (`task`/`wait`) lean on. Building it once, here, against a known trait, means 6.2 and 6.3 are extensions, not rewrites.

3. **The hard parts of kinds aren't in the syntax — they're in the analysis.** Implicit-block LIFO synthesis, cleanup-on-`?`, and flow-sensitive obligation tracking are the conceptually weighty pieces. 6.1 ships them all on day one against a single kind. Adding more clauses later is mechanical; getting the analysis topology right is not.

## Scope (what 6.1 does NOT do)

- **No `appliesTo parameter` / `field` / `function` / `type`, no multi-site lists.** Only `appliesTo binding;`. The other application sites are needed for the `task` kind (function), `pooled net<Bytes>` (field), `batchable(n) events` (parameter), and `simd_aligned` (type). 6.1 rejects each at parse time. Reasoning: every other site requires its own resolution rule — kind on a param affects call-site checking, kind on a field affects struct codegen, kind on a function rewrites the return type. Bundling them would balloon the phase; deferring them costs nothing for `disposable`.
- **No `provides Trait`.** That's how the `task` kind generates `Task<T>` return types. Phase 6.3.
- **No `mustCall { a; b; } beforeScopeEnd` (the disjunction/block form).** Single function name only, written `mustCall fn beforeScopeEnd;`. The disjunction is needed by `pooled` (`mustCall { wait; abandon; } beforeScopeEnd;`); revisit in 6.3.
- **No `mustCall fn beforeAny` / `afterAny`.** Method-ordering rules; not needed by `disposable`. Reject at parse time.
- **No `mustNotEscape` / `mustNotShare` / `forbids`.** Phase 6.2.
- **No `autoJoin beforeScopeEnd`.** That's a 6.3 clause used by `scoped`.
- **No `propagates<K>` / `contains<K>`.** Phase 6.4.
- **No `layout { ... }` / `restricts iteration { ... }`.** Phase 6.5.
- **No parameterized kinds** (`kind batchable(n: usize) { ... }`). Rejected at parse time with "parameterized kinds not yet supported".
- **No kind composition.** `kind slow_batch = a & b;` rejected.
- **No `kind` inside `kind`-decl bodies.** Flat clause list only.
- **No discharging `mustCall` by calling the method manually in user code.** If the user writes `dispose(ref a);` inside a `disposable a` scope, the compiler still inserts its own cleanup call at scope exit. Double-call detection is a 6.2 concern; for 6.1 the compiler is permissive — calling `dispose` twice is the user's problem. (We may revisit this if it becomes a footgun, but introducing the analysis now means the goal program shape `disposable f = open(p)? { ... }` is incompatible with users who already call dispose; better to let the compiler always insert and tell users to drop manual calls.)
- **No re-binding under a kind.** `disposable a: FileHandle = b;` where `b` is itself a `disposable` binding is a typecheck error: "cannot re-bind a kind-tracked value under a new kind in phase 6.1". The aliasing rules belong with `mustNotShare` in 6.2.
- **No kind imports.** A `kind` decl is local to its module in 6.1. Exporting/importing kinds is a phase 6.4 concern (it pairs with `propagates<K>` across module boundaries). `import { disposable } from "./foo.yoop";` is rejected. In practice the `disposable` kind decl will live in the same file that declares its `Disposable` trait, or be re-declared per module — the awkwardness is acknowledged and resolved in 6.4.

- **One `requires` per line.** Multiple `requires` are written as separate `requires Trait;` clauses, not as a space-separated list. (List form is reserved for `appliesTo` and `forbids` in later sub-phases.)

## Status snapshot

After phase 5, the compiler has everything the analysis needs to hook into:

- **Trait method dispatch.** `dispose(ref h)` resolves to a mangled symbol via [checkExpr.js:222](../src/jsyooptypecheck/checkExpr.js#L222) (`node.calleeMangledName = \`${structType.moduleId}__${structType.name}__${callee}\``) and emits a call through [codegen.js:706-721](../src/jsyoopcodegen/codegen.js#L706-L721). Synthetic cleanup-call nodes inserted by `kindCheck` will set the same fields and reuse the same emission path.
- **Struct refs.** Phase 5 landed `ref T` for struct `T`. A method body sees `self` as `ref FileHandle`; the same `RefType { inner: StructType }` plumbing lets cleanup-call emission pass `ref a` to `dispose`.
- **Multi-pass typecheck.** [typecheck.js:234-547](../src/jsyooptypecheck/typecheck.js) is already organized as Pass A (shells), Pass B (imports), Pass C.0/C.1/C.3/C.5 (struct fields, trait method sigs, impl validation, import re-sync), Pass D (bodies). Kind decls slot in cleanly: shell in Pass A, clause resolution in a new Pass C.2 (between trait sigs and impl validation), flow analysis in Pass D.
- **`?` early-return codegen.** [codegen.js:343-401](../src/jsyoopcodegen/codegen.js#L343-L401) — `emitTryOpToSlot` builds the failure branch, calls `emitFailVariantReturn` ([codegen.js:381](../src/jsyoopcodegen/codegen.js#L381)) which emits the final `ret`. The hook for "fire pending cleanups before the ret" lives at line 372, immediately before the `emitFailVariantReturn` call (or inside that helper as a parameter). Cleanups must run **after** the err pointer is captured into `errStr` but **before** the failVariantReturn's `ret`.
- **Scope tracking.** [scope.js](../src/jsyooptypecheck/scope.js) — `pushScope` / `popScope` / `declareInScope`. `popScope` already does end-of-scope validation (for fallible-binding observation) — the natural place to extend with "for each binding with a `mustCall` kind, mark cleanup-on-fall-through". The scope chain is per-block: [checkStatement.js:137-142](../src/jsyooptypecheck/checkStatement.js#L137-L142) pushes/pops on `checkBlock`.
- **Top-level dispatch.** [parser.js:143-204](../src/jsyooparser/parser.js#L143-L204) — `parseTopLevel`'s switch. Add `case TokenTags.kind:` next to the `trait` case.
- **`parseVarDecl`** ([parser.js:785-828](../src/jsyooparser/parser.js#L785-L828)) — handles `let` / `const`. We extend it (or wrap it) to also accept a leading kind-name ident.
- **Existing `traits_disposable` fixture.** [examples/pass/traits_disposable/main.yoop](../examples/pass/traits_disposable/main.yoop) already exercises trait + struct ref + `dispose(ref h)`. Our phase-6.1 goal program is a near-superset.

## Files touched

- [src/contracts.js](../src/contracts.js) — new `ASTNodeKind` entries for `KIND_DECL`, `KIND_APPLIES_TO_CLAUSE`, `KIND_REQUIRES_CLAUSE`, `KIND_MUSTCALL_CLAUSE`, `KIND_OWNSBLOCK_CLAUSE`, `CLEANUP_CALL`.
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — new keyword tokens for `kind`, `appliesTo`, `requires`, `mustCall`, `ownsBlock`, `beforeScopeEnd`, `binding`.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — `parseKindDecl`, top-level dispatch, kind-prefix lookahead in statement position, kind-prefix extension to `parseVarDecl`, trailing-block parse for kind-prefixed bindings.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) — `KindType { name, requires, mustCall, ownsBlock, appliesTo, moduleId }`.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) — Pass A shell entry for kind decls, new Pass C.2 for kind-clause resolution, hook into Pass D for cleanup-obligation collection.
- [src/jsyooptypecheck/scope.js](../src/jsyooptypecheck/scope.js) — binding entry carries an optional `kindType` field; `popScope` records implicit-block cleanups.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js) — `checkLetDecl` / `checkConstDecl` recognize kind-prefixed bindings, validate `requires`, register cleanup obligations.
- **New** `src/jsyooptypecheck/kindCheck.js` — flow-analysis pass that consumes obligations registered in Pass D and rewrites the function body AST with synthetic `CLEANUP_CALL` nodes at every exit point.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — emit `CLEANUP_CALL` nodes; extend the `?` early-return path to fire pending cleanups before `ret`; emit fall-through cleanups before the implicit final `ret` of a function.
- [examples/pass/](../examples/pass/) and [examples/fail/](../examples/fail/) — new fixtures (see §10).

## 1. AST node kinds ([contracts.js](../src/contracts.js))

Add to `ASTNodeKind`:

```js
// phase 6.1: kinds
KIND_DECL: "KIND_DECL",
KIND_APPLIES_TO_CLAUSE: "KIND_APPLIES_TO_CLAUSE",
KIND_REQUIRES_CLAUSE: "KIND_REQUIRES_CLAUSE",
KIND_MUSTCALL_CLAUSE: "KIND_MUSTCALL_CLAUSE",
KIND_OWNSBLOCK_CLAUSE: "KIND_OWNSBLOCK_CLAUSE",
CLEANUP_CALL: "CLEANUP_CALL",
```

Node shapes:

- **`kindDecl`** — `{ kind: "KIND_DECL", name: string, clauses: ClauseNode[], sourceLoc }`. Each clause is one of the four below; the parser produces them in declaration order. The typechecker validates that exactly one `appliesTo` is present, at most one `ownsBlock`, at most one `mustCall`, and an arbitrary number of `requires` (but for 6.1 we require exactly zero or one — multi-trait `requires` is fine semantically but `disposable` only needs one; multi-trait isn't blocked at parse, only flagged if no use case appears).

- **`appliesToClause`** — `{ kind: "KIND_APPLIES_TO_CLAUSE", site: "binding", sourceLoc }`. Site is restricted to `"binding"` in 6.1; other values are parse errors.

- **`requiresClause`** — `{ kind: "KIND_REQUIRES_CLAUSE", traitName: string, sourceLoc }`. The `traitName` is a bare identifier; resolution happens in Pass C.2.

- **`mustCallClause`** — `{ kind: "KIND_MUSTCALL_CLAUSE", methodName: string, timing: "beforeScopeEnd", sourceLoc }`. `methodName` is a bare identifier (the trait method the kind requires must run before scope exit). `timing` is restricted to `"beforeScopeEnd"`; `.beforeAny()` / `.afterAny()` parse as errors.

- **`ownsBlockClause`** — `{ kind: "KIND_OWNSBLOCK_CLAUSE", sourceLoc }`. No arguments.

- **`cleanupCall`** — `{ kind: "CLEANUP_CALL", bindingName: string, methodName: string, structType: StructType, moduleId: string, sourceLoc }`. Synthesized by `kindCheck.js`; never written by users. The struct type and module ID are pre-resolved so codegen can emit the mangled symbol directly.

Extensions to existing nodes:

- **`letDecl` / `constDecl`** — gain an optional `kindPrefix: { name: string, sourceLoc } | null` field. If present, parser also accepts a trailing `BLOCK` node in `node.trailingBlock` (otherwise `null`). After Pass C.2 the typechecker populates `node.resolvedKind: KindType | null` on the binding node.

- **`block`** — gains an optional `implicitCleanups: cleanupCall[]` array, populated by `kindCheck.js` for blocks that own one or more `disposable`-style bindings via implicit-block synthesis. Codegen emits these in reverse order before the block's closing terminator.

- **`returnStatement`** — gains an optional `pendingCleanups: cleanupCall[]` populated by `kindCheck.js`. Emitted immediately before the `ret` LLVM instruction.

- **`tryOp`** — gains an optional `pendingCleanups: cleanupCall[]` populated by `kindCheck.js`. Emitted on the failure branch only, immediately before `emitFailVariantReturn`.

## 2. Lexer changes ([lexer.js](../src/jsyooplexer/lexer.js))

New keyword tags (add to `TokenTags`, ~[lexer.js:57](../src/jsyooplexer/lexer.js#L57)) and matching entries in `keywordTagList` (~[lexer.js:151](../src/jsyooplexer/lexer.js#L151)):

```js
kind:           <next-tag>,
appliesTo:      <next-tag>,
requires:       <next-tag>,
mustCall:       <next-tag>,
ownsBlock:      <next-tag>,
beforeScopeEnd: <next-tag>,
binding:        <next-tag>,
```

**Note**: `disposable` is NOT a keyword. Kind names are normal identifiers; the parser disambiguates `disposable a: T = ...` from a generic expression statement via lookahead.

The clause keywords (`appliesTo`, `requires`, `mustCall`, `ownsBlock`) are **globally reserved** in the spec ([§14](../SPEC.md#L861)) so the user can't shadow them with locals; in practice the parser only treats them specially inside `kind { ... }` bodies. The timing modifier `beforeScopeEnd` and the site identifier `binding` are reserved only contextually (per spec §14) — the lexer still emits a dedicated tag for them to keep the parser shape simple, but they remain legal as identifiers outside kind-clause positions. (Phase 6.1's narrow grammar makes this distinction invisible in practice; later sub-phases extend it.)

### 2.a Lexer test cases

- `kind` tokenizes as the `kind` keyword.
- `appliesTo` tokenizes as a single keyword (no underscore — pure camelCase).
- `mustCall` tokenizes as a single keyword.
- `beforeScopeEnd` tokenizes as a single keyword.
- `disposable` tokenizes as a plain identifier.

## 3. Parser changes ([parser.js](../src/jsyooparser/parser.js))

### 3.a Top-level dispatch

Extend the switch at [parser.js:152](../src/jsyooparser/parser.js#L152):

```js
case TokenTags.kind:
  {
    seenNonImport = true;
    node.body.push(parseKindDecl());
  }
  break;
```

### 3.b `parseKindDecl`

```
kindDecl :=
  "kind" IDENT "{"
    kindClause*
  "}"

kindClause :=
    appliesToClause
  | requiresClause
  | mustCallClause
  | ownsBlockClause

appliesToClause := "appliesTo" "binding" ";"
requiresClause  := "requires" IDENT ";"
mustCallClause  := "mustCall" IDENT "beforeScopeEnd" ";"
ownsBlockClause := "ownsBlock" ";"
```

Each clause is a `keyword arg...;` statement. No parens, no colons, no method chains, no block forms in 6.1.

Implementation notes:

- `parseKindDecl` consumes `kind`, then `IDENT` (the kind name — store on `node.name`), then `{`. Loop reading clauses until `}`. The `kind` decl itself takes no trailing `;` (matches `function`, `type`, `trait`).
- Each clause dispatcher peeks the leading keyword token and routes to a `parseXxxClause` helper. Per-clause grammar is fixed (no general "clause-shape" parser) because the clause set is closed.
- `parseAppliesToClause`: consume `appliesTo`, then expect `binding`. Any other identifier (`parameter`, `field`, `function`, `type`) or any second site identifier (i.e. multi-site list like `appliesTo function binding`) is a parse error: `"appliesTo <name> not yet supported in phase 6.1; only 'binding' is accepted"`.
- `parseRequiresClause`: consume `requires`, then `IDENT` (the trait name). Store as `node.traitName`. Don't resolve here — Pass C.2 does. If a second `IDENT` appears before `;`, reject: `"requires takes a single trait per clause; write multiple 'requires Trait;' clauses for multiple traits"`.
- `parseMustCallClause`: consume `mustCall`, then `IDENT` (the method name). If the next token is `{`, reject: `"mustCall { ... } block form (alternation) not yet supported in phase 6.1; single function name only"`. Otherwise expect `beforeScopeEnd` token. If a different timing keyword appears (`beforeAny`, `afterAny`), produce: `"mustCall ... <X> not yet supported in phase 6.1; use 'beforeScopeEnd'"`. Store `node.methodName` and `node.timing = "beforeScopeEnd"`.
- `parseOwnsBlockClause`: consume `ownsBlock`, `;`. No payload. If the user wrote `ownsBlock()` (old syntax), the `(` is the first unexpected token and produces: `"ownsBlock takes no arguments; drop the parentheses"`.

After the clause loop, before returning, validate **at the parser level**: exactly one `appliesToClause` is present. (Spec defaults to "any value-site" if absent, but 6.1 is `binding`-only and we want the user to write it explicitly to avoid surprises when later phases widen the default.) Missing or duplicate `appliesTo` is a parse error.

Other clauses the parser must reject with explicit messages:

| Token sequence | Error message |
|---|---|
| `provides` | `provides clause not yet supported in phase 6.1` |
| `mustNotEscape` | `mustNotEscape not yet supported (phase 6.2)` |
| `mustNotShare` | `mustNotShare not yet supported (phase 6.2)` |
| `autoJoin` | `autoJoin not yet supported (phase 6.3)` |
| `restricts` | `restricts not yet supported (phase 6.5)` |
| `layout` | `layout not yet supported (phase 6.5)` |
| `forbids` | `forbids not yet supported (phase 6.2)` |
| `propagates` | `propagates not yet supported (phase 6.4)` |
| `contains` | `contains not yet supported (phase 6.4)` |
| `kind X(...) {` (parameterized) | `parameterized kinds not yet supported in phase 6.1` |
| `kind X = a & b;` (composition) | `kind composition not yet supported in phase 6.1` |

Each rejection cites the future sub-phase by number, so the error message itself is the documentation pointer.

### 3.c Kind-prefixed binding in `parseVarDecl`

The current binding rule starts with `let` or `const` ([parser.js:785](../src/jsyooparser/parser.js#L785)). Phase 6.1 introduces a new form:

```
varDecl :=
    "let"   IDENT ":" type ("=" expr)? ";"
  | "const" IDENT ":" type ("=" expr)? ";"
  | kindPrefix "let"   IDENT ":" type "=" expr blockOrSemicolon       // existing-let with prefix
  | kindPrefix "const" IDENT ":" type "=" expr blockOrSemicolon       // existing-const with prefix
  | kindPrefix         IDENT ":" type "=" expr blockOrSemicolon       // implicit-const form

kindPrefix := IDENT                                   // the kind name; resolved in typecheck

blockOrSemicolon :=
    "{" statement* "}"     // trailing block (kind must declare ownsBlock)
  | ";"                    // implicit-block form
```

Notes:

- The kind name is a plain identifier at parse time. There's no way to tell from the token stream whether `disposable` is a kind or a typo; that's resolved in the typechecker. The parser only stores the name.
- Detection at statement start: a `parseStatement` dispatcher already has `let` / `const` / `if` / `while` / `return` / `for` / `break` / `continue` / `_` / `{` / expression-statement branches. Add: if the current token is `IDENT` and the next is also `IDENT` and the one after that is `:`, treat it as a kind-prefixed binding. Three-token lookahead is sufficient — no general statement starts `<ident> <ident> :`.
  - Defensive: also reject `kind X X : ...` (the kind name being a *reserved keyword*) — those cases already lex as non-`IDENT` and naturally fail.
- The `let` / `const` keyword may appear *after* the kind prefix (`disposable let a: T = ...`) per [SPEC.md §4.4](../SPEC.md#L221). Place it between the kind name and the binding ident.
- The kind-prefixed forms always have an `=` RHS — a kind without an initializer makes no sense (`mustCall dispose` against what?). Enforce at parse: `disposable a: T;` (no `=`) is a parse error.
- After the RHS expression, peek: if `{`, parse a trailing block (the body is the binding's scope). If `;`, consume it. Anything else: parse error.
- Trailing block must contain at least zero statements; an empty `{}` is legal.

Output AST shape, after parse:

```js
// `disposable a: FileHandle = expr { ...stmts... }`
{
  kind: "CONST_DECL",                      // implicit-const for the prefix-only form
  name: "a",
  typeAnnotation: <typeAnnotation>,
  assignment: <expr>,
  kindPrefix: { name: "disposable", sourceLoc: ... },
  trailingBlock: { kind: "BLOCK", body: [...stmts] } | null,
  sourceLoc: ...
}
```

`letDecl` is identical when `let` was used. The presence of `kindPrefix` and possible `trailingBlock` are the only deltas.

### 3.d Parser test cases — accept

- `kind disposable { appliesTo binding; requires Disposable; mustCall dispose beforeScopeEnd; ownsBlock; }`
- `kind cleanup { appliesTo binding; mustCall close beforeScopeEnd; }` (no `ownsBlock`, no `requires` — but typecheck will then fail per §5.c since `mustCall` needs a `requires`; this is accepted at *parse* time and rejected later)
- `kind handle { appliesTo binding; requires Disposable; requires Closable; mustCall dispose beforeScopeEnd; }` (one `requires` per line)
- `disposable a: FileHandle = make_handle();` (implicit block, implicit const)
- `let disposable a: FileHandle = make_handle();` (explicit let, explicit mutability)
- `disposable a: FileHandle = make_handle() { dispose(ref a); return 0; }` (trailing block — semantically odd but parses)

### 3.e Parser test cases — reject (with the exact phase-6.1 error message)

- `kind disposable { requires Disposable; }` → missing `appliesTo`.
- `kind disposable { appliesTo parameter; ... }` → `appliesTo parameter not yet supported`.
- `kind disposable { appliesTo function binding; ... }` → `appliesTo function not yet supported` (rejects on the first non-`binding` site).
- `kind disposable { appliesTo binding; mustCall dispose beforeAny; }` → `mustCall ... beforeAny not yet supported`.
- `kind disposable { appliesTo binding; mustCall { wait; abandon; } beforeScopeEnd; }` → `mustCall block form (alternation) not yet supported`.
- `kind disposable { appliesTo binding; requires Disposable Closable; }` → `requires takes a single trait per clause`.
- `kind disposable { ownsBlock(); }` → `ownsBlock takes no arguments; drop the parentheses` (catches users writing old-style syntax).
- `kind disposable(n: usize) { ... }` → `parameterized kinds not yet supported`.
- `kind slow = a & b;` → `kind composition not yet supported`.
- `disposable a: FileHandle;` (no `=`) → `kind-prefixed binding requires initializer`.

## 4. Type system ([types.js](../src/jsyooptypecheck/types.js))

### 4.a `KindType`

```js
export function KindType(name, moduleId) {
  this.kind = "kind";
  this.name = name;
  this.moduleId = moduleId;
  this.appliesTo = "binding";       // 6.1: always "binding"
  this.requires = [];               // array of TraitType
  this.mustCall = [];               // array of { methodName, timing: "beforeScopeEnd", traitType }
  this.ownsBlock = false;
}
```

`moduleId` is captured because kinds are module-local in 6.1; cross-module references resolve through the same import table that traits use, even though the table is unused in 6.1 (no kind imports).

### 4.b Binding entry in scope.js

Extend the binding record at [scope.js:18-23](../src/jsyooptypecheck/scope.js#L18-L23):

```js
scope.bindings.set(name, {
  type,
  kind,           // "let" | "const" — the binding's mutability, unrelated to the language-level "kind"
  node,
  errObserved: false,
  kindType: null, // KindType | null  -- the language-level kind (e.g. disposable)
  cleanupRecord: null, // CleanupRecord | null -- populated by kindCheck if kindType has mustCall
});
```

The name collision between "kind" (mutability) and "kindType" (language kind) is unfortunate but the existing field name is well-established; calling the new one `kindType` keeps them distinct.

### 4.c `formatType` for kinds

`formatType(KindType)` returns `"kind " + name`. Used in error messages: `"binding 'a' has kind 'disposable' which requires 'Disposable', but type 'FileHandle' does not implement Disposable"`.

## 5. Typechecker ([typecheck.js](../src/jsyooptypecheck/typecheck.js), [checkStatement.js](../src/jsyooptypecheck/checkStatement.js), new [kindCheck.js](../src/jsyooptypecheck/kindCheck.js))

### 5.a Multi-pass shape

Existing passes ([typecheck.js:234-547](../src/jsyooptypecheck/typecheck.js)):

- Pass A — shells (struct, function, trait): we add **kind shell** here.
- Pass B — imports.
- Pass C.0 — struct fields.
- Pass C.1 — trait method signatures.
- **NEW: Pass C.2 — kind clauses.** Inserted between C.1 and C.3 because clause validation needs trait shells (from C.1) but doesn't need impl-block validation (C.3) to be complete.
- Pass C.3 — impl-block validation.
- Pass C.5 — re-sync imported traits.
- Pass D — body validation. We extend `validateFunction` to call into `kindCheck` after each function body is type-resolved.

### 5.b Pass A — kind shells

In the pass-A loop at [typecheck.js:238-327](../src/jsyooptypecheck/typecheck.js#L238), add a branch:

```js
} else if (d.kind === ASTNodeKind.KIND_DECL) {
  if (mod.kindTable.has(d.name)) {
    pushError(errors, d, `redeclaration of kind '${d.name}'`);
    continue;
  }
  const kt = new KindType(d.name, mod.id);
  mod.kindTable.set(d.name, kt);
  d.resolvedKindType = kt;
}
```

`moduleEnv` already carries `mod.structTable`, `mod.functionTable`, `mod.traitTable`. Add `mod.kindTable: Map<string, KindType>` to the module env constructor.

### 5.c Pass C.2 — kind clauses

```js
function resolveKindClauses(mod, errors) {
  for (const d of mod.ast.body) {
    if (d.kind !== ASTNodeKind.KIND_DECL) continue;
    const kt = d.resolvedKindType;
    let appliesToSeen = false;
    let mustCallSeen = false;
    let ownsBlockSeen = false;
    for (const c of d.clauses) {
      switch (c.kind) {
        case ASTNodeKind.KIND_APPLIES_TO_CLAUSE:
          if (appliesToSeen) { pushError(errors, c, "duplicate appliesTo clause"); }
          appliesToSeen = true;
          kt.appliesTo = c.site; // "binding"
          break;
        case ASTNodeKind.KIND_REQUIRES_CLAUSE: {
          const trait = mod.traitTable.get(c.traitName);
          if (!trait) {
            pushError(errors, c, `unknown trait '${c.traitName}' in requires clause`);
            break;
          }
          kt.requires.push(trait);
          break;
        }
        case ASTNodeKind.KIND_MUSTCALL_CLAUSE: {
          if (mustCallSeen) { pushError(errors, c, "duplicate mustCall clause"); }
          mustCallSeen = true;
          // Resolve the method name against the kind's requires-trait list:
          // the method must be declared by at least one required trait.
          const traitWithMethod = kt.requires.find(t => t.methods.has(c.methodName));
          if (!traitWithMethod) {
            pushError(errors, c, `mustCall ${c.methodName}: no required trait declares this method`);
            break;
          }
          kt.mustCall.push({
            methodName: c.methodName,
            timing: c.timing,
            traitType: traitWithMethod,
          });
          break;
        }
        case ASTNodeKind.KIND_OWNSBLOCK_CLAUSE:
          if (ownsBlockSeen) { pushError(errors, c, "duplicate ownsBlock clause"); }
          ownsBlockSeen = true;
          kt.ownsBlock = true;
          break;
      }
    }
    if (!appliesToSeen) {
      pushError(errors, d, `kind '${kt.name}' missing required 'appliesTo' clause`);
    }
  }
}
```

Notes:

- `mustCall` references a method name that must be declared by one of the kind's `requires` traits. Without `requires`, no `mustCall` is legal (where would the method come from?). Reject with: `mustCall requires at least one 'requires' clause to resolve the method name`.
- `ownsBlock` is semantic-only at this stage; binding-site validation happens in checkStatement / checkExpr.

### 5.d Pass D — `validateFunction` extension

In `validateFunction`, after the body has been walked and `resolvedType` populated on every node, call `runKindCheck(functionDecl, moduleEnv, errors)`. `kindCheck` is the new flow-analysis pass; its job is to (a) walk the function body, (b) build cleanup-obligation records for every kind-prefixed binding, (c) attach synthetic `CLEANUP_CALL` nodes to every exit point in the binding's scope.

### 5.e `checkLetDecl` / `checkConstDecl` — kind-prefix validation

In [checkStatement.js](../src/jsyooptypecheck/checkStatement.js), where `LET_DECL` / `CONST_DECL` are handled:

1. If `node.kindPrefix` is set, resolve the kind name against `moduleEnv.kindTable` (local module only in 6.1). If unknown, error: `unknown kind '${name}'`.
2. Verify `kindType.appliesTo === "binding"`. (For 6.1 this is always true since we reject other values at parse, but the check is a future-proofing line.)
3. Type-check the RHS expression as today; the resulting `resolvedType` must be a `StructType` (not a primitive, not a ref, not an array). For 6.1, kinds only attach to struct values. Non-struct: error `kind '${k}' can only apply to struct values, got '${formatType(t)}'`.
4. For every trait in `kindType.requires`, verify the struct's `implements` list includes that trait. Otherwise: `binding '${name}' has kind '${k}' which requires '${trait}', but type '${struct}' does not implement '${trait}'`.
5. If `node.trailingBlock` is present, require `kindType.ownsBlock === true`. Otherwise: `kind '${k}' does not declare ownsBlock; trailing block is not allowed`.
6. Store `kindType` on the binding via `declareInScope`, by passing it through.
7. If `node.trailingBlock` is present, declare the binding into the **trailing block's** scope, not the enclosing one. Specifically: push a new scope for the trailing block, declare the binding in that scope, walk the trailing block's body, popScope on the trailing block. (Implementation detail: `checkBlock` already pushes a scope; the binding is declared into that nested scope, then `checkBlock` walks the body.) After the trailing block, the binding is not visible — the implicit `popScope` removes it.
8. If `node.trailingBlock` is absent (implicit form), declare the binding into the **current scope** as today, and record that the binding has an implicit-block obligation in the enclosing scope.

### 5.f Cleanup-obligation collection

The job of cleanup tracking is split:

- **`checkStatement` / `checkExpr`** populate the binding's `cleanupRecord` (added to the scope binding entry) when the binding is declared. The record carries the binding name, the resolved struct type, the method name, the module ID, the trait type, and the source location.
- **`kindCheck`** consumes the recorded obligations and walks the function body to insert `CLEANUP_CALL` nodes at every exit point.

The two-step split is intentional: the typecheck pass produces a finished, typed AST; the kindCheck pass is a separate transform that takes that AST and writes synthetic nodes back into it. Codegen sees the result of both. The split mirrors the way phase 2 handled destructuring as a syntactic rewrite over a typed AST.

## 6. The flow pass — [kindCheck.js](../src/jsyooptypecheck/kindCheck.js)

### 6.a Surface

```js
export function runKindCheck(fnDecl, moduleEnv, errors) {
  // Walks fnDecl.body. Returns nothing; mutates the AST:
  //  - block.implicitCleanups       (cleanup calls fired before block's `}`)
  //  - returnStatement.pendingCleanups (cleanup calls before `ret`)
  //  - tryOp.pendingCleanups          (cleanup calls on the failure branch)
}
```

### 6.b Walk model

`kindCheck` runs a single linear walk of the function body, maintaining a stack of "active obligations." Each scope (block, function body) pushes a fresh frame onto the stack when entered, pops on exit. A kind-prefixed binding adds an obligation to the **current top frame**.

Pseudo-shape:

```js
function walkBlock(block) {
  const frame = { obligations: [] };  // array of { bindingName, methodName, structType, moduleId, sourceLoc }
  stack.push(frame);
  for (const stmt of block.body) walkStatement(stmt);
  // exit point: fall-through `}` — synthesize cleanups for everything in this frame
  block.implicitCleanups = frame.obligations
    .slice().reverse()
    .map(o => makeCleanupCall(o));
  stack.pop();
}

function walkStatement(stmt) {
  switch (stmt.kind) {
    case ASTNodeKind.LET_DECL:
    case ASTNodeKind.CONST_DECL: {
      const kindType = stmt.resolvedKindType;
      if (!kindType || kindType.mustCall.length === 0) return;
      const structType = stmt.assignment.resolvedType;
      const mc = kindType.mustCall[0]; // single mustCall per 6.1
      const obligation = {
        bindingName: stmt.name,
        methodName: mc.methodName,
        structType,
        moduleId: structType.moduleId,
        sourceLoc: stmt.sourceLoc,
      };
      if (stmt.trailingBlock) {
        // trailing-block form: cleanup belongs to that block's frame
        const innerFrame = { obligations: [obligation] };
        stack.push(innerFrame);
        for (const s of stmt.trailingBlock.body) walkStatement(s);
        stmt.trailingBlock.implicitCleanups = innerFrame.obligations
          .slice().reverse()
          .map(makeCleanupCall);
        stack.pop();
      } else {
        // implicit-block form: cleanup belongs to current frame
        stack[stack.length - 1].obligations.push(obligation);
      }
      return;
    }
    case ASTNodeKind.RETURN_STATEMENT:
      // every active obligation in EVERY frame must fire, innermost first
      stmt.pendingCleanups = flattenStackReverse().map(makeCleanupCall);
      return;
    case ASTNodeKind.TRY_OP:
      // tryOp is an expression; the failure branch issues an early return,
      // so it needs the same flatten-stack-reverse cleanup list
      stmt.pendingCleanups = flattenStackReverse().map(makeCleanupCall);
      return;
    case ASTNodeKind.IF_STATEMENT:
      walkBlock(stmt.body);
      if (stmt.else) walkBlock(stmt.else);
      return;
    case ASTNodeKind.WHILE_STATEMENT:
    case ASTNodeKind.FOR_LOOP:
      walkBlock(stmt.body);
      return;
    case ASTNodeKind.BLOCK:
      walkBlock(stmt);
      return;
    case ASTNodeKind.EXPRESSION_STATEMENT:
      walkExpr(stmt.expression); // finds nested TRY_OPs
      return;
    // ... other statement kinds: descend if they contain expressions/blocks
  }
}

function walkExpr(e) {
  // Recurse into sub-expressions, hitting any TRY_OP we find.
  if (e.kind === ASTNodeKind.TRY_OP) {
    e.pendingCleanups = flattenStackReverse().map(makeCleanupCall);
  }
  for (const child of childrenOf(e)) walkExpr(child);
}

function flattenStackReverse() {
  // [outer, ..., inner] -> innerObligationsReversed ++ ... ++ outerObligationsReversed
  const out = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    for (let j = frame.obligations.length - 1; j >= 0; j--) {
      out.push(frame.obligations[j]);
    }
  }
  return out;
}

function makeCleanupCall(o) {
  const node = new ASTNode("CLEANUP_CALL", o.sourceLoc);
  node.bindingName = o.bindingName;
  node.methodName = o.methodName;
  node.structType = o.structType;
  node.moduleId = o.moduleId;
  return node;
}
```

### 6.c LIFO and the goal program

For the §1 goal program:

```yoop
function main(): int32 {
    disposable a: FileHandle = { fd: 1 };  // implicit-block obligation in main's frame
    disposable b: FileHandle = { fd: 2 };  // implicit-block obligation in main's frame
    printf(`working\n`);
    return 0;                              // explicit return — fires both, b first
}
```

After kindCheck:

- The frame for `main`'s top-level block has two obligations: `[a, b]` in declaration order.
- The `return 0` statement gets `pendingCleanups: [dispose(b), dispose(a)]` from `flattenStackReverse`.
- The block's `implicitCleanups` is also computed but unused — execution exits via the explicit return before reaching the block's `}`.

For a function that falls off the end without a return:

```yoop
function setup(): void {
    disposable a: FileHandle = { fd: 1 };
    disposable b: FileHandle = { fd: 2 };
    // no return -- fall through `}`
}
```

- Frame has `[a, b]`.
- No return statement to attach to.
- The block's `implicitCleanups` becomes `[dispose(b), dispose(a)]`, emitted before the implicit `ret void` codegen produces.

### 6.d Cleanup-on-`?`

The §1 program doesn't use `?`, but the deeper pass-fixture `disposable_qmark.yoop` does:

```yoop
type Reader { value: int32, err: string }

function read_first(ref h: FileHandle): Reader {
    return { value: h.fd, err: "" };
}

function go(): Reader {
    disposable a: FileHandle = { fd: 1 };
    const r = read_first(ref a)?;       // hypothetically fallible
    return { value: r.value, err: "" };
}
```

`kindCheck` sets `tryOp.pendingCleanups = [dispose(a)]`. Codegen emits the cleanup before `emitFailVariantReturn`.

## 7. Codegen ([codegen.js](../src/jsyoopcodegen/codegen.js))

### 7.a Emitting `CLEANUP_CALL`

Add a new helper:

```js
function emitCleanupCall(node, fnLines) {
  // node: { bindingName, methodName, structType, moduleId, ... }
  const bindingSlot = lookupLocal(node.bindingName);
  const mangled = `${node.moduleId}__${node.structType.name}__${node.methodName}`;
  fnLines.push(`  call void @${mangled}(ptr ${bindingSlot})`);
}
```

`lookupLocal` is the existing local-variable resolver used by every IDENT codegen. `bindingSlot` is the `%a` style SSA name for the binding's stack slot, which is what `ref a` already produces in the trait-method codegen path from phase 5.

### 7.b Cleanup at block fall-through

In the block-codegen path (where the block's statements are emitted in order), after emitting the last statement and before emitting whatever LLVM terminator/successor follows, iterate `block.implicitCleanups` and call `emitCleanupCall` for each. The cleanups are already in LIFO order (kindCheck reversed them).

If the block belongs to a function body (top-level block of a function with `void` return), the implicit `ret void` follows the cleanups. If the block belongs to a non-void function and falls through without an explicit return, that's already a typecheck error from phase 1; codegen never sees it.

If the block is a control-flow body (if/while/for), the cleanups fire before the loop continues or the branch rejoins.

### 7.c Cleanup at `return`

The current `RETURN_STATEMENT` codegen emits the return value, then `ret <ty> <val>`. Change to: emit return-value computation into a temp, fire `node.pendingCleanups` in order, then emit `ret`.

### 7.d Cleanup at `?` early-return

In `emitTryOpToSlot` ([codegen.js:343](../src/jsyoopcodegen/codegen.js#L343)), at the `failLabel:` branch ([codegen.js:371-372](../src/jsyoopcodegen/codegen.js#L371-L372)):

```js
fnLines.push(`${failLabel}:`);
if (node.pendingCleanups) {
  for (const c of node.pendingCleanups) {
    emitCleanupCall(c, fnLines);
  }
}
emitFailVariantReturn(currentReturnType, errStr, fnLines);
```

The cleanups must run **after** `errStr` is captured (which happens at [codegen.js:361](../src/jsyoopcodegen/codegen.js#L361), before the branch) but **before** the final `ret` produced inside `emitFailVariantReturn`. Doing it on the failLabel block is the natural slot.

### 7.e Trailing-block cleanups

When a kind-prefixed binding has a trailing block, the binding's alloca lives in the function's frame (like any other local), but its scope-end cleanup is anchored to the trailing block's `}`. Codegen:

1. Emits the alloca and store at the binding's declaration point (before the block).
2. Walks the trailing block's body.
3. Emits `block.implicitCleanups` at the block's `}`.

After the trailing block, the binding remains alloc'd (stack memory persists for the function's lifetime), but the type system has already removed it from scope — no later code can name it. The duplicate "live alloca but dead binding" is acceptable; structs don't release any resources from going out of stack-name scope.

### 7.f Walking expressions for nested `?`

The existing codegen for expressions descends through nested expressions. `kindCheck` annotates `tryOp.pendingCleanups` on every `?` it encounters, so codegen just consumes whatever's there. No structural change needed; only the emit-cleanups-before-emitFailVariantReturn edit from 7.d.

## 8. Multi-trait `requires`

A kind may list multiple traits, **one per clause** (never a space-separated list — that's reserved for `appliesTo` and `forbids` in later sub-phases):

```yoop
kind ioHandle {
    appliesTo binding;
    requires Disposable;
    requires Closable;
    mustCall dispose beforeScopeEnd;
}
```

The parser accepts repeated `requires` clauses. The typechecker validates each. The `mustCall` method must be declared by at least one required trait — `dispose` is declared by `Disposable`, so this passes. Codegen resolves the cleanup call exactly as in the single-trait case.

This works for free because the resolution rule is "method must be in one of the requires traits"; multiple `requires` clauses just widen the search. No special handling needed.

## 9. Driver wiring ([yoopiler.js](../src/yoopiler.js))

No changes needed. `typecheckProgram` is the existing entry point; it already runs Pass A through Pass D. Adding Pass C.2 inside `typecheckProgram` is invisible to the driver.

## 10. Tests

### 10.1 Pass fixtures — [examples/pass/](../examples/pass/)

#### `disposable_basic.yoop` — the goal program from §1

Verifies: kind decl, two implicit-block bindings, LIFO fall-through cleanup.

Expected output:

```
working
disposing fd=2
disposing fd=1
```

#### `disposable_explicit_block.yoop` — trailing-block form

```yoop
function main(): int32 {
    disposable a: FileHandle = { fd: 7 } {
        printf(`inside block\n`);
    }
    printf(`after block\n`);
    return 0;
}
```

Expected output:

```
inside block
disposing fd=7
after block
```

Verifies: trailing block parses, cleanup fires before `}`, binding `a` not in scope after the block.

#### `disposable_return.yoop` — cleanup on explicit return

```yoop
function early(flag: bool): int32 {
    disposable a: FileHandle = { fd: 9 };
    if (flag) {
        return 1;
    }
    return 0;
}

function main(): int32 {
    let r1: int32 = early(true);
    let r2: int32 = early(false);
    printf(`r1=${r1} r2=${r2}\n`);
    return 0;
}
```

Expected output:

```
disposing fd=9
disposing fd=9
r1=1 r2=0
```

Verifies: cleanup runs on both `return 1` and `return 0` paths.

#### `disposable_qmark.yoop` — cleanup on `?` early-return

```yoop
extern "C" from "stdio.h" { function printf(fmt: string, ...): int32; }

trait Disposable { function dispose(ref self): void; }

type FileHandle implements Disposable {
    fd: int32,
    function dispose(ref self): void { printf(`disposing fd=${self.fd}\n`); }
}

kind disposable {
    appliesTo binding;
    requires Disposable;
    ownsBlock;
    mustCall dispose beforeScopeEnd;
}

type Result { value: int32, err: string }

function readOne(ref h: FileHandle, fail: bool): Result {
    if (fail) {
        return { value: 0, err: "boom" };
    }
    return { value: h.fd, err: "" };
}

function go(fail: bool): Result {
    disposable a: FileHandle = { fd: 5 };
    const r = readOne(ref a, fail)?;
    return { value: r.value, err: "" };
}

function main(): int32 {
    const r1 = go(false);
    printf(`ok r1=${r1.value} err='${r1.err}'\n`);
    const r2 = go(true);
    printf(`fail r2=${r2.value} err='${r2.err}'\n`);
    return 0;
}
```

Expected output:

```
disposing fd=5
ok r1=5 err=''
disposing fd=5
fail r2=0 err='boom'
```

Verifies: cleanup fires before `?`-induced early return on the failure path **and** before normal return on the success path.

#### `disposable_lifo_three.yoop` — three bindings, LIFO

```yoop
function main(): int32 {
    disposable a: FileHandle = { fd: 1 };
    disposable b: FileHandle = { fd: 2 };
    disposable c: FileHandle = { fd: 3 };
    return 0;
}
```

Expected output:

```
disposing fd=3
disposing fd=2
disposing fd=1
```

#### `disposable_nested_block.yoop` — implicit and explicit blocks interleaved

```yoop
function main(): int32 {
    disposable a: FileHandle = { fd: 1 };       // implicit
    disposable b: FileHandle = { fd: 2 } {       // explicit -- inner scope
        disposable c: FileHandle = { fd: 3 };   // implicit, inside b's block
        printf(`inside\n`);
    }
    printf(`outside\n`);
    return 0;
}
```

Expected output (LIFO inside b's block disposes c, then b, then outer scope disposes a):

```
inside
disposing fd=3
disposing fd=2
outside
disposing fd=1
```

#### `disposable_let_explicit.yoop` — explicit `let` for mutability

```yoop
function main(): int32 {
    let disposable a: FileHandle = { fd: 1 };
    a.fd = 99;                                  // mutability check
    return 0;
}
```

Expected output:

```
disposing fd=99
```

#### `disposable_multi_requires.yoop` — kind with two `requires` (§8)

A kind whose `requires` list has two traits, both implemented by the bound struct; `mustCall` names a method from one of them.

### 10.2 Fail fixtures — [examples/fail/](../examples/fail/)

| Fixture | Trigger |
|---|---|
| `kind_missing_appliesTo.yoop` | `kind k { requires D; }` — no `appliesTo` |
| `kind_appliesTo_parameter.yoop` | `appliesTo parameter;` rejected at parse |
| `kind_appliesTo_multi.yoop` | `appliesTo function binding;` rejected (multi-site list deferred) |
| `kind_duplicate_appliesTo.yoop` | two `appliesTo` clauses |
| `kind_duplicate_mustcall.yoop` | two `mustCall` clauses |
| `kind_unknown_trait.yoop` | `requires NotATrait;` |
| `kind_requires_list.yoop` | `requires Disposable Closable;` rejected (list form not allowed) |
| `kind_mustcall_no_requires.yoop` | `mustCall dispose beforeScopeEnd;` with no `requires` clause |
| `kind_mustcall_method_not_in_trait.yoop` | `requires Disposable; mustCall close beforeScopeEnd;` (close not on Disposable) |
| `kind_beforeAny.yoop` | `mustCall dispose beforeAny;` rejected |
| `kind_mustcall_disjunction.yoop` | `mustCall { wait; abandon; } beforeScopeEnd;` rejected (block form deferred) |
| `kind_ownsblock_parens.yoop` | `ownsBlock();` rejected — old syntax with parens |
| `kind_parameterized.yoop` | `kind k(n: usize) { ... }` rejected |
| `kind_composition.yoop` | `kind k = a & b;` rejected |
| `binding_unknown_kind.yoop` | `unknownKind a: T = ...;` |
| `binding_non_struct.yoop` | `disposable a: int32 = 5;` |
| `binding_missing_trait.yoop` | `disposable a: PlainStruct = {...};` where PlainStruct doesn't implement Disposable |
| `binding_trailing_block_no_ownsblock.yoop` | kind without `ownsBlock` clause but binding has a trailing block |
| `binding_no_initializer.yoop` | `disposable a: T;` — no `=` |
| `binding_after_trailing_block_scope.yoop` | reference `a` after `disposable a: T = ... { }` — should fail with "name not in scope" |

Each fail fixture lives in a single-file directory under `examples/fail/` and is run through the regression suite (referenced at [roadmap.md:213](./roadmap.md#L213)). The expected error is a substring match captured in a `.expected_error` sibling file.

### 10.3 Regression — existing fixtures

Every `examples/pass/*` fixture from phases 1-5 must still pass. The `traits_disposable` fixture in particular continues to compile and run unchanged — its manual `dispose(ref h)` call is still legal; the phase-6.1 changes only *add* a new way to get cleanup.

## 11. Verification

Run end-to-end:

```sh
node ./src/yoopiler.js -i examples/pass/disposable_basic.yoop -o output
./output.exe
```

Expected output matches §1. Run the regression suite to verify all pass fixtures compile and run, and all fail fixtures produce the expected typecheck/parse error.

Spot-check the emitted LLVM IR for `disposable_basic.yoop`: at the end of `main`, before the `ret i32 0`, two `call void @<modId>__FileHandle__dispose(ptr %b)` and `call void @<modId>__FileHandle__dispose(ptr %a)` should appear, in that order. Spot-check `disposable_qmark.yoop`: the `try_fail` block should contain a `call void @<modId>__FileHandle__dispose(ptr %a)` immediately before the failVariantReturn's `ret`.

## 12. Out of scope (for reference, addressed later)

- Double-call detection (user manually calls `dispose(ref a)` then compiler inserts another) — deferred to 6.2 alongside the rest of the static-analysis lifetime rules.
- `discard` interaction (`_ = open(p)`) — the discard form sidesteps `mustCall` because there's no binding. Confirmed working incidentally; no fixture needed.
- Cleanup on panic / unwinding — not modeled; Yooper has no exceptions.
- Cleanup on `break` / `continue` — the binding's scope is bounded by its block; `break`/`continue` exit *blocks*, so the block's `implicitCleanups` fire on the way out. **Confirm at implementation time** that the codegen for `break`/`continue` actually emits implicit cleanups before branching — if not, add a `node.pendingCleanups` slot to those statements and have kindCheck populate them.
- Re-bound disposables (`disposable b: FileHandle = a;`) — rejected at typecheck with "cannot re-bind a kind-tracked value under a new kind in phase 6.1" (§Scope).
- Cross-module kind import/export — rejected; deferred to 6.4.
