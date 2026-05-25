# Phase 6.2 - Escape and sharing constraints

Part of [phase 6 - kinds](./phase-6-kinds.md). Phase 6.1 landed the `disposable` kind: kind declarations, the `binding` application site, `mustCall`/`ownsBlock`/`requires` clauses, the implicit-block-LIFO flow walker in `kindCheck.js`, and synthetic `CLEANUP_CALL` emission at every exit point. The compiler now enforces *lifecycle* obligations but cannot enforce *flow* obligations - there is nothing stopping a user from writing `return a` (returning a `disposable`) or passing `ref a` to a function that secretly keeps the reference around. Phase 6.2 closes that hole with the **escape-analysis** layer: a single flow-sensitive pass that decides where a kind-tracked value is allowed to flow.

## Context

Three things motivate 6.2:

1. **The `disposable` story is leaky without escape.** `disposable a` guarantees `dispose(ref a)` fires before scope exit, but the value of `a` itself can still escape the scope - be returned, be stored in a struct field, be captured via `ref` by some long-lived function. When that happens, the dispose-at-scope-end is meaningless: the caller now holds a dangling handle to an already-disposed resource. Real safety needs both `mustCall` *and* `mustNotEscape` working together, which is the `scoped` kind ([SPEC.md:378-383](../SPEC.md#L378)).

2. **Phase 6.3 (task/concurrency) needs the parameter-kind path.** The `task` kind is `appliesTo function`; the `scoped` and `pooled` task-bindings are kinds on bindings; `wait h` is a method-call site whose parameter must accept a kind. Without `appliesTo parameter` and the call-site validation that goes with it, phase 6.3 has nowhere to land its core abstraction.

3. **Escape, share, and forbid are one analysis at three levels.** They all answer "where can this value flow?" - `mustNotEscape scope` looks at function returns and field stores, `mustNotShare acrossScopes` looks at task-boundary crossings, `forbids io` looks at function-effect annotations. Building the flow walker once, in 6.2, with `mustNotEscape` as the working clause, sets up 6.3 (sharing actually has scopes to cross) and any later effect-tracking work to be incremental.

## Goal

Land the bare-minimum subset of [SPEC.md §6](../SPEC.md#L356) that makes the `scoped` kind work end-to-end against the `Disposable` trait. Goal program:

```yoop
// scoped_basic.yoop
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

kind scoped {
    appliesTo binding parameter;
    requires Disposable;
    ownsBlock;
    mustCall dispose beforeScopeEnd;
    mustNotEscape scope;
}

function use(scoped h: ref FileHandle): void {
    printf(`fd=${h.fd}\n`);
}

function main(): int32 {
    scoped a: FileHandle = { fd: 1 };
    use(ref a);
    return 0;
}
```

`yoopiler scoped_basic.yoop` must compile and print:

```
fd=1
disposing fd=1
```

The output proves: (1) the `scoped` kind decl with a multi-site `appliesTo` parses; (2) `mustNotEscape scope` is accepted and stored; (3) `appliesTo parameter` is widened, so `scoped h: ref FileHandle` is a valid parameter form; (4) passing `ref a` to a `scoped`-marked parameter is legal (the callee promises not to escape); (5) phase 6.1's `mustCall dispose beforeScopeEnd` still fires unchanged.

Companion fail program - every `mustNotEscape` violation rejects cleanly:

```yoop
// scoped_escape_return.yoop  (in examples/fail/)
function bad(): FileHandle {
    scoped a: FileHandle = { fd: 1 };
    return a;                          // ERROR: 'a' has kind 'scoped' which forbids escape via return
}
```

Concretely, 6.2 delivers:

- **`appliesTo` widened** to accept any non-empty subset of `{ binding, parameter, field }` as a space-separated list (`appliesTo binding parameter;`, `appliesTo field;`, `appliesTo binding parameter field;`). The `function` and `type` sites remain rejected with a deferral message (phase 6.5 introduces them via `task` and `simd_aligned`). Multi-site lists, rejected at parse in 6.1, are now accepted.
- **`mustNotEscape scope;`** clause - parsed, stored on `KindType`, enforced by the flow pass. Target is restricted to the single value `scope`; other targets (`function`, `module`) are rejected at parse with "not yet supported".
- **`mustNotShare acrossScopes;`** clause - parsed and stored on `KindType`. No enforcement yet - there are no concurrent scopes in the language until phase 6.3 introduces tasks. Storing it lets users define `pooled`/`scoped` kinds with their full clause set, and lets 6.3 turn enforcement on by extending the flow pass. Targets accepted: `acrossScopes` only. `acrossThreads` rejected with "not yet supported".
- **`forbids X...;`** clause - parsed and stored. Accepted argument identifiers: `io`, `globalState`. No enforcement yet - effect-tracking (which functions touch which effects) is a separate machinery that doesn't belong with escape analysis. The clause is stored so that 6.3's `task` kind can carry it and a later phase can turn enforcement on.
- **Kind on function parameter** at the parse and typecheck level: `function use(scoped h: ref FileHandle): void` is parsed, the parameter binding's `kindType` is populated, the parameter type's struct trait check runs (just like for bindings in 6.1), and the parameter is registered with the flow walker as if it were a kind-prefixed binding declared at function entry.
- **Escape-analysis pass** added to [kindCheck.js](../src/jsyooptypecheck/kindCheck.js). For every binding (or parameter) whose `kindType` declares `mustNotEscape scope`, the walker scans the rest of the scope for three escape paths:
  1. **Return**: `return a;` or `return s;` where `s` is a struct literal containing `a` as a field-value (direct only - non-aggregate paths through helper functions are not tracked in 6.2).
  2. **Field store into longer-lived struct**: an assignment `outer.field = a;` (or `outer.field = ref a;` if and when refs land in fields, currently they don't) where `outer` was declared in an enclosing scope.
  3. **Pass-by-ref to non-`scoped` parameter**: a call `f(ref a)` where the parameter `f` is declared to receive (i.e., its declared `kindType` is null or does not include `mustNotEscape`). Compiler-synthesized cleanup calls (`CLEANUP_CALL` nodes) bypass this check - they are the implementation of the `mustCall` obligation and by construction don't let `ref a` escape the call.
- **Validation at the kind-applicability site**: when a kind-prefixed binding/parameter is checked, `kindType.appliesTo` must include the relevant site. A kind with only `appliesTo binding` rejected on a parameter use; a kind with only `appliesTo parameter` rejected on a binding use.
- **Field-site rejection with a clear message**: a struct field like `conn: scoped FileHandle,` (a kind prefix on a field declaration) parses but is rejected at typecheck with "kind-bearing fields require `propagates<K>` or `contains<K>` on the enclosing struct (phase 6.4)". The `appliesTo field` value on `KindType` is recognized so the kind itself isn't malformed; only the *use site* is gated.

## Why second

Three reasons.

1. **`disposable` ↔ `scoped` is the natural arc.** 6.1 shipped a cleanup contract; 6.2 ships the flow contract that makes cleanup *meaningful*. The user-facing story "if I want a closed resource, mark it `disposable`; if I want a closed *and* non-escaping resource, mark it `scoped`" lands here.

2. **The flow walker is the right scaffold for everything later.** kindCheck's stack-of-frames walker already iterates every node in a function body once and visits every exit point. Phase 6.2 extends that walker with a sub-pass that visits every *escape* point. The same shape is reused in 6.3 for `wait` insertion and in any future effect-tracker that asks "did this value reach forbidden code?"

3. **Parameter kinds unblock 6.3.** Without `appliesTo parameter`, the `wait(scoped h)` style call signatures of 6.3 have nowhere to attach the constraint. Landing parameter kinds here, on a small surface (`scoped` parameter to a void-returning function), keeps 6.3 focused on the task/wait/abandon machinery rather than re-litigating the parameter binding shape.

## Scope (what 6.2 does NOT do)

- **No `forbids` enforcement.** The clause parses and stores. There is no walker that asks "does this function call something marked `io`?" Effect tracking is its own design space; bundling it with escape analysis would balloon the phase. Functions that *declare* a `forbids io` kind don't get rejected for calling `printf` - the clause is recorded for future enforcement.
- **No `mustNotShare` enforcement.** Same posture. No concurrent scopes exist (phase 6.3). The clause is stored on `KindType` and dropped on the floor by the analysis pass.
- **No `appliesTo function` / `appliesTo type`.** Function-applicable kinds (the `task` kind) come in 6.3. Type-applicable kinds (the `simd_aligned` kind) come in 6.5. Both rejected at parse with their deferral phase number.
- **No kind-on-field uses.** A field type written as `conn: scoped FileHandle,` is rejected at typecheck. The `appliesTo field` value is accepted in kind decls - for use by later phases - but no struct field today carries a kind. Phase 6.4 wires this via `propagates<K>` / `contains<K>`.
- **No transitive escape tracking.** A function `function leak(ref h: FileHandle): FileHandle { return some_struct_containing(ref h); }` cannot be reasoned about without modeling the callee's effect on its argument. 6.2 handles direct escapes only:
  - `return <ident>` where `<ident>` is a scoped binding/parameter.
  - `return { ..., field: <ident>, ... }` where the struct-literal explicitly contains the binding by value (also rejected because the struct now carries the value out).
  - `outer.field = <ident>` where `outer` outlives the binding's scope.
  - `f(ref <ident>)` where `f`'s parameter is not declared `scoped` (i.e., does not itself carry `mustNotEscape scope`).
  Indirect paths (helper functions that re-emit the value) are out. A caller wanting to compose with helpers must mark helpers' parameters `scoped`, which is the documented escape-hatch.
- **No closure capture.** Yooper has no closures; nothing to do.
- **No `mustNotEscape <other-target>`.** Only `mustNotEscape scope;` is accepted. `mustNotEscape function;` or `mustNotEscape module;` are rejected at parse with "only 'scope' is supported in phase 6.2".
- **No `forbids` argument set beyond `io` and `globalState`.** Other tokens (`memory`, `time`, …) rejected at parse; the SPEC's "…" list is open-ended but 6.2 doesn't try to enumerate it.
- **No re-binding of scoped values.** Already rejected in 6.1 ("cannot re-bind a kind-tracked value under a new kind in phase 6.1"); 6.2 keeps the rule.
- **No kind composition** (`kind slow = scoped & batchable;`). Still rejected. Phase 6.5.
- **No parameterized kinds.** Still rejected. Phase 6.5.
- **No kind imports/exports.** Still module-local. Phase 6.4.
- **No discharge of `mustNotEscape` by user code.** There is no `_= a; // I promise I dropped it` syntax. The constraint is structural.

## Status snapshot (post-6.1)

Phase 6.1 left these hooks in place:

- **`KindType`** ([types.js:145-153](../src/jsyooptypecheck/types.js#L145-L153)) - `{ name, moduleId, appliesTo: "binding", requires: [], mustCall: [], ownsBlock: false }`. We mutate `appliesTo` from a scalar to a `Set<string>` (or array - see §4.a) and add `mustNotEscape`, `mustNotShare`, `forbids`.
- **Kind clauses** ([contracts.js:61-66](../src/contracts.js#L61-L66)) - `KIND_APPLIES_TO_CLAUSE`, `KIND_REQUIRES_CLAUSE`, `KIND_MUSTCALL_CLAUSE`, `KIND_OWNSBLOCK_CLAUSE`. We add `KIND_MUST_NOT_ESCAPE_CLAUSE`, `KIND_MUST_NOT_SHARE_CLAUSE`, `KIND_FORBIDS_CLAUSE`.
- **Kind keywords** ([lexer.js:59-68](../src/jsyooplexer/lexer.js#L59-L68)) - `kind`, `appliesTo`, `requires`, `mustCall`, `ownsBlock`, `beforeScopeEnd`, `binding`. We add `mustNotEscape`, `mustNotShare`, `forbids`, `scope`, `acrossScopes`, `parameter`, `field`, `io`, `globalState`.
- **`parseKindDecl`** ([parser.js:257-327](../src/jsyooparser/parser.js#L257-L327)) - dispatches per leading clause keyword. We add four new dispatch arms (`mustNotEscape`, `mustNotShare`, `forbids`, plus the multi-site relaxation of `appliesTo`). The "reserved future clause" table at [parser.js:~318](../src/jsyooparser/parser.js#L318) loses `mustNotEscape`, `mustNotShare`, and `forbids` from its rejection list.
- **`parseAppliesToClause`** ([parser.js:349-385](../src/jsyooparser/parser.js#L349-L385)) - currently locked to a single `binding` token. We loop reading site tokens until `;`, validating each token is one of `binding`/`parameter`/`field` (others rejected per scope).
- **`parseVarDecl`** ([parser.js:1049-1132](../src/jsyooparser/parser.js#L1049-L1132)) - kind-prefix on bindings. Already in place; no changes for 6.2 (the scoped-binding form is exactly the disposable-binding form parser-wise).
- **`parseFunctionDecl`** / parameter parser - currently does not accept a kind prefix on parameters. We extend the parameter parser to detect `IDENT IDENT :` (and `IDENT IDENT ref` / `IDENT ref IDENT` - see §3.c) and route to a kind-prefixed parameter parse.
- **`resolveKindClauses`** ([typecheck.js:236-302](../src/jsyooptypecheck/typecheck.js#L236-L302)) - Pass C.2. We add three new clause-resolution arms (`mustNotEscape`, `mustNotShare`, `forbids`). The `appliesTo` arm now stores a set, not a scalar.
- **`validateKindBinding`** ([checkStatement.js:220-259](../src/jsyooptypecheck/checkStatement.js#L220-L259)) - kind-on-binding validation. We extract its struct-trait-and-applicability core into a helper, then call that helper from both `validateKindBinding` (the binding site) and the new `validateKindParam` (the parameter site).
- **`runKindCheck`** ([kindCheck.js:20-181](../src/jsyooptypecheck/kindCheck.js#L20-L181)) - flow walker. We extend its frame-stack with a second axis: in addition to cleanup obligations, each frame carries a list of *escape sentinels* - names of scoped bindings whose escape must be detected. The walker grows new visitors for `RETURN_STATEMENT`, `ASSIGNMENT_STATEMENT`, `CALL_EXPRESSION`, and `STRUCT_LITERAL_EXPRESSION` that consult the sentinels and call `pushError` on violations.
- **No codegen changes.** Escape analysis is purely static - by the time codegen runs, illegal programs have already been rejected. The CLEANUP_CALL emission path is unchanged.

## Files touched

- [src/contracts.js](../src/contracts.js) - three new `ASTNodeKind` entries: `KIND_MUST_NOT_ESCAPE_CLAUSE`, `KIND_MUST_NOT_SHARE_CLAUSE`, `KIND_FORBIDS_CLAUSE`.
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) - new keyword tokens: `mustNotEscape`, `mustNotShare`, `forbids`, `scope`, `acrossScopes`, `parameter`, `field`, `io`, `globalState`.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) - three new clause parsers (`parseMustNotEscapeClause`, `parseMustNotShareClause`, `parseForbidsClause`); `parseAppliesToClause` rewrite for multi-site; parameter parser extension for kind-prefixed params.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) - `KindType` gains `appliesTo: Set<string>` (was scalar), `mustNotEscape: boolean`, `mustNotShare: string[]`, `forbids: string[]`.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) - `resolveKindClauses` extension; `validateFunction` extension to register parameter kinds and feed them to the flow walker.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js) - extract `validateKindApplicability` from `validateKindBinding`; check `appliesTo` membership; reject kind-prefix on struct fields.
- [src/jsyooptypecheck/scope.js](../src/jsyooptypecheck/scope.js) - binding entry gains `scopeDepth` (already-existing if scope tracks depth; otherwise added) so the escape walker can compare two bindings' lexical-depth at the field-store check.
- [src/jsyooptypecheck/kindCheck.js](../src/jsyooptypecheck/kindCheck.js) - frame stack widened; new visitors for escape paths; new error reports.
- [examples/pass/](../examples/pass/) and [examples/fail/](../examples/fail/) - new fixtures (see §10).

## 1. AST node kinds ([contracts.js](../src/contracts.js))

Add to `ASTNodeKind`:

```js
// phase 6.2: escape and sharing
KIND_MUST_NOT_ESCAPE_CLAUSE: "KIND_MUST_NOT_ESCAPE_CLAUSE",
KIND_MUST_NOT_SHARE_CLAUSE: "KIND_MUST_NOT_SHARE_CLAUSE",
KIND_FORBIDS_CLAUSE: "KIND_FORBIDS_CLAUSE",
```

Node shapes:

- **`mustNotEscapeClause`** - `{ kind, target: "scope", sourceLoc }`. Target is the single token after `mustNotEscape`; restricted to `"scope"` in 6.2.
- **`mustNotShareClause`** - `{ kind, target: "acrossScopes", sourceLoc }`. Restricted to `"acrossScopes"` in 6.2. `acrossThreads` rejected.
- **`forbidsClause`** - `{ kind, categories: string[], sourceLoc }`. Whitespace-separated list (this is the only multi-arg clause in 6.2 - `forbids io globalState;` is legal). Each category restricted to `"io"` or `"globalState"`.

Extensions to existing nodes:

- **`appliesToClause`** - `site` becomes `sites: string[]` (or stays as `site: string` plus a second field - pick the simpler refactor). The parser-side default-validation rule still requires exactly one `appliesTo` clause per kind decl.
- **`functionParameter`** - gains an optional `kindPrefix: { name: string, sourceLoc } | null` field. Parser populates when a kind prefix is detected in the parameter list. Typechecker populates `resolvedKindType: KindType | null` in Pass D.
- **`functionDecl`** / **`structFieldDecl`** - no AST shape change; the kind prefix on a struct field is reused from `functionParameter` form, but field-site is rejected at typecheck (§5.f).

## 2. Lexer changes ([lexer.js](../src/jsyooplexer/lexer.js))

New keyword tags (extend `TokenTags`, ~[lexer.js:65](../src/jsyooplexer/lexer.js#L65)):

```js
mustNotEscape:  <next-tag>,
mustNotShare:   <next-tag>,
forbids:        <next-tag>,
scope:          <next-tag>,
acrossScopes:   <next-tag>,
parameter:      <next-tag>,
field:          <next-tag>,
io:             <next-tag>,
globalState:    <next-tag>,
```

Add matching entries in `keywordTagList`.

**Reservation posture** (per [SPEC.md §14](../SPEC.md#L874)):
- `mustNotEscape`, `mustNotShare`, `forbids` are **globally reserved** clause keywords.
- `scope`, `acrossScopes`, `parameter`, `field`, `io`, `globalState` are **contextually reserved** - the lexer emits dedicated tags for parser ergonomics, but they remain legal as identifiers outside kind-clause positions. (In practice the parser only consumes them in `parseAppliesToClause`, `parseMustNotEscapeClause`, `parseMustNotShareClause`, `parseForbidsClause`.)

### 2.a Lexer test cases

- `mustNotEscape` tokenizes as a single keyword (no underscore, camelCase consistent with `mustCall`).
- `mustNotShare` tokenizes as a single keyword.
- `forbids` tokenizes as a single keyword.
- `acrossScopes` tokenizes as a single keyword.
- `scope`, `parameter`, `field`, `io`, `globalState` tokenize as keywords (contextual; safe because no existing fixture uses these as identifiers in non-clause positions).
- `scoped` (the kind name in fixtures) tokenizes as a plain identifier - it is **not** a keyword. Same shape as `disposable` in 6.1.

## 3. Parser changes ([parser.js](../src/jsyooparser/parser.js))

### 3.a `parseAppliesToClause` - multi-site

Current grammar (6.1):

```
appliesToClause := "appliesTo" "binding" ";"
```

New grammar (6.2):

```
appliesToClause := "appliesTo" site (site)* ";"
site            := "binding" | "parameter" | "field"
```

Implementation:

```js
function parseAppliesToClause() {
  // already consumed "appliesTo"
  const sites = [];
  while (peek().tag !== TokenTags.semicolon) {
    const tok = consume();
    let site;
    switch (tok.tag) {
      case TokenTags.binding:   site = "binding"; break;
      case TokenTags.parameter: site = "parameter"; break;
      case TokenTags.field:     site = "field"; break;
      case TokenTags.function:  parseError(tok, "appliesTo function not yet supported (phase 6.5; introduced by task kind)");
      case TokenTags.type:      parseError(tok, "appliesTo type not yet supported (phase 6.5; introduced by layout-bearing kinds)");
      default:                  parseError(tok, `unrecognized appliesTo site '${tok.text}'`);
    }
    if (sites.includes(site)) parseError(tok, `duplicate appliesTo site '${site}'`);
    sites.push(site);
  }
  expect(TokenTags.semicolon);
  if (sites.length === 0) parseError(/*at-loc*/, "appliesTo requires at least one site");
  return makeAppliesToClause(sites);
}
```

The `field` site is accepted at parse - it's needed in the goal `scoped` kind's `appliesTo binding parameter` declaration to *not* include it, but kinds like `disposable` that may later be written `appliesTo binding field` should parse. Field-site *use* (a struct field with a kind prefix) is rejected at typecheck (§5.f).

### 3.b `parseMustNotEscapeClause`, `parseMustNotShareClause`, `parseForbidsClause`

```
mustNotEscapeClause := "mustNotEscape" "scope" ";"
mustNotShareClause  := "mustNotShare" "acrossScopes" ";"
forbidsClause       := "forbids" category (category)* ";"
category            := "io" | "globalState"
```

- `parseMustNotEscapeClause`: consume `mustNotEscape`, expect `scope`, expect `;`. Any other target identifier produces `"mustNotEscape <X> not yet supported in phase 6.2; only 'scope' is accepted"`.
- `parseMustNotShareClause`: consume `mustNotShare`, expect `acrossScopes`, expect `;`. `acrossThreads` produces `"mustNotShare acrossThreads not yet supported (phase 6.3 wires concurrent sharing)"`.
- `parseForbidsClause`: consume `forbids`, then read one or more category tokens until `;`. Accepted: `io`, `globalState`. Other tokens produce `"unrecognized forbids category '<name>'; accepted: io, globalState"`. Empty list (`forbids ;`) is a parse error.

Wire each into the clause dispatcher at [parser.js:~280](../src/jsyooparser/parser.js#L280). Remove the now-resolved entries (`mustNotEscape not yet supported (phase 6.2)`, etc.) from the deferred-clause table at [parser.js:~318](../src/jsyooparser/parser.js#L318). Keep the remaining deferral entries (`autoJoin`, `restricts`, `layout`, `propagates`, `contains`).

### 3.c Kind-prefixed parameter

Function parameter grammar today:

```
parameter := ("ref")? IDENT ":" type
```

New grammar:

```
parameter := kindPrefix? ("ref")? IDENT ":" type
kindPrefix := IDENT     // the kind name; resolved at typecheck
```

Detection: in the parameter loop of `parseFunctionDecl` / `parseFunctionSignature`, before consuming the first token of a parameter, peek. If the current token is `IDENT` and the next is `IDENT` or `ref`, this is a kind-prefixed parameter. (Three-token lookahead - `IDENT (ref)? IDENT :` - is sufficient.)

Examples to accept:
- `scoped h: FileHandle` - kind on value-type parameter
- `scoped h: ref FileHandle` - kind on ref-type parameter (matches the goal program's `function use(scoped h: ref FileHandle)`)
- `scoped ref h: FileHandle` - alternate ordering, per [SPEC.md §4.4](../SPEC.md#L221) (the spec allows `let disposable ref h`-style; for symmetry we accept either ordering on parameters too). Pick one canonical form for the AST; treat both as equivalent.

Examples to reject:
- `scoped h` (no `: type`) - same parse error as a regular parameter missing its type annotation.
- `disposable scoped h: T` - two kind prefixes; reject with `"a parameter may carry at most one kind prefix in phase 6.2"`.

AST output for a kind-prefixed parameter:

```js
{
  kind: "FUNCTION_PARAMETER",
  name: "h",
  typeAnnotation: <RefType { inner: FileHandle } | StructType>,
  isRef: true,                            // existing field
  kindPrefix: { name: "scoped", sourceLoc },   // NEW
  sourceLoc,
}
```

### 3.d Parser test cases - accept

- `kind scoped { appliesTo binding parameter; requires Disposable; ownsBlock; mustCall dispose beforeScopeEnd; mustNotEscape scope; }`
- `kind pooled { appliesTo binding; mustNotShare acrossScopes; }` (no enforcement, but parses)
- `kind safe { appliesTo function; forbids io globalState; }` - wait, `appliesTo function` is rejected (phase 6.5). Use `appliesTo binding` for parser-only test of `forbids` instead: `kind safe { appliesTo binding; forbids io; }`.
- `function use(scoped h: ref FileHandle): void { ... }`
- `function use(scoped ref h: FileHandle): void { ... }` (alternate ordering)

### 3.e Parser test cases - reject

- `kind k { appliesTo binding function; ... }` → `appliesTo function not yet supported`.
- `kind k { appliesTo binding binding; ... }` → `duplicate appliesTo site 'binding'`.
- `kind k { appliesTo; ... }` → `appliesTo requires at least one site`.
- `kind k { appliesTo binding; mustNotEscape function; }` → `mustNotEscape function not yet supported in phase 6.2; only 'scope' is accepted`.
- `kind k { appliesTo binding; mustNotShare acrossThreads; }` → `mustNotShare acrossThreads not yet supported (phase 6.3)`.
- `kind k { appliesTo binding; forbids memory; }` → `unrecognized forbids category 'memory'`.
- `kind k { appliesTo binding; forbids; }` → parse error on empty list.
- `function f(scoped disposable h: T): void` → `a parameter may carry at most one kind prefix in phase 6.2`.

## 4. Type system ([types.js](../src/jsyooptypecheck/types.js))

### 4.a `KindType` shape

Mutate the existing constructor at [types.js:145-153](../src/jsyooptypecheck/types.js#L145-L153):

```js
export function KindType(name, moduleId) {
  this.kind = typeKinds.kind;
  this.name = name;
  this.moduleId = moduleId;
  this.appliesTo = new Set();   // 6.2: was scalar "binding", now Set<"binding"|"parameter"|"field">
  this.requires = [];
  this.mustCall = [];
  this.ownsBlock = false;
  this.mustNotEscape = false;   // 6.2: true iff a mustNotEscape clause is present
  this.mustNotShare = [];       // 6.2: array of "acrossScopes" (stored, not enforced)
  this.forbids = [];            // 6.2: array of "io" | "globalState" (stored, not enforced)
}
```

Migration: every existing read of `kt.appliesTo === "binding"` becomes `kt.appliesTo.has("binding")`. There are two reads - one in `validateKindBinding` ([checkStatement.js:221](../src/jsyooptypecheck/checkStatement.js#L221)) (currently a comment, no actual check - fix as part of 6.2), one in `resolveKindClauses` ([typecheck.js:~262](../src/jsyooptypecheck/typecheck.js#L262)) where the scalar was assigned. Replace assignments with `Set.add` calls.

### 4.b Binding entry - depth tracking

The escape-walker needs to compare two bindings' lexical depths (binding `a` in scope-N stored into struct `outer` declared in scope-M - illegal iff M < N). Two approaches:

- **Read the scope-chain at lookup time.** When the walker visits `outer.field = a`, it asks the scope to report which scope-frame declared `outer` and which scope-frame declared `a`. If `outer`'s frame is an ancestor of `a`'s frame, it's an escape.
- **Annotate the binding with a depth integer.** Each call to `declareInScope` stores a monotonic `scopeDepth` on the entry. The walker compares integers.

Pick option 2 (simpler). Add `scopeDepth: number` to the scope binding entry. `pushScope` increments a counter; `declareInScope` records the current depth on the entry. Phase 6.1 doesn't need this, so the field is `0`-by-default elsewhere.

### 4.c `formatType` for KindType

No change. The format `"kind " + name` already works.

## 5. Typechecker

### 5.a Pass C.2 - clause resolution extension ([typecheck.js](../src/jsyooptypecheck/typecheck.js))

In `resolveKindClauses` ([typecheck.js:236-302](../src/jsyooptypecheck/typecheck.js#L236-L302)), add three new switch arms and rework the `appliesTo` arm:

```js
case ASTNodeKind.KIND_APPLIES_TO_CLAUSE: {
  if (appliesToSeen) { pushError(errors, c, "duplicate appliesTo clause"); break; }
  appliesToSeen = true;
  for (const s of c.sites) kt.appliesTo.add(s);
  break;
}
case ASTNodeKind.KIND_MUST_NOT_ESCAPE_CLAUSE: {
  if (kt.mustNotEscape) { pushError(errors, c, "duplicate mustNotEscape clause"); break; }
  kt.mustNotEscape = true;
  break;
}
case ASTNodeKind.KIND_MUST_NOT_SHARE_CLAUSE: {
  if (kt.mustNotShare.length > 0) { pushError(errors, c, "duplicate mustNotShare clause"); break; }
  kt.mustNotShare.push(c.target);  // "acrossScopes"
  break;
}
case ASTNodeKind.KIND_FORBIDS_CLAUSE: {
  for (const cat of c.categories) {
    if (kt.forbids.includes(cat)) { pushError(errors, c, `duplicate forbids category '${cat}'`); }
    else kt.forbids.push(cat);
  }
  break;
}
```

No cross-clause consistency checks beyond duplicates - `mustNotEscape` + `mustCall` co-existing is the canonical `scoped` shape and must be supported.

### 5.b Validate parameter kinds - new pass step

In `validateFunction` ([typecheck.js:~627](../src/jsyooptypecheck/typecheck.js#L627)), after the parameter scope is opened and parameters are declared, iterate parameters and resolve any `kindPrefix` against `moduleEnv.kindTable`. For each kind-prefixed parameter:

1. Look up `kindPrefix.name` in `moduleEnv.kindTable`. If missing: `"unknown kind '<name>'"`.
2. Validate `kt.appliesTo.has("parameter")`. Else: `"kind '<name>' does not apply to parameters (declared appliesTo: <list>)"`.
3. Validate the parameter's `typeAnnotation` resolves to either a struct or `RefType { inner: struct }`. Reject primitives and arrays per the 6.1 rule.
4. Validate that the (possibly ref-unwrapped) struct implements every trait in `kt.requires`.
5. Store the resolved `kindType` on the parameter's scope-binding entry (so the flow walker can find it).
6. If `kt.mustNotEscape` is true, register the parameter name as a *scope sentinel* in the function's top-level frame - every escape check the walker performs will consult this list.
7. **No `mustCall` enforcement for parameter kinds in 6.2.** A `scoped h: ref FileHandle` parameter does not get an auto-inserted `dispose(ref h)` at function exit - the caller is responsible for cleanup, since `h` was alive before the call. The parameter inherits *only* the `mustNotEscape` clause from its kind. The `mustCall` clause attaches solely to binding-site uses. Document this divergence inline in `validateKindParam` and add a fixture (§10).

(The asymmetry is exactly what makes parameter kinds useful: the callee enforces `mustNotEscape` for the duration of the call, then the binding's owner - the caller - handles cleanup.)

### 5.c `validateKindApplicability` - extracted helper

In [checkStatement.js](../src/jsyooptypecheck/checkStatement.js), refactor `validateKindBinding` ([checkStatement.js:220-259](../src/jsyooptypecheck/checkStatement.js#L220-L259)). Extract two helpers:

- `validateKindApplicability(kindType, site, sourceLoc, errors)` - checks `kt.appliesTo.has(site)`; produces error if not.
- `validateKindTraitImplementation(kindType, structType, bindingName, sourceLoc, errors)` - runs the trait-implements check (currently inline at [checkStatement.js:244-252](../src/jsyooptypecheck/checkStatement.js#L244-L252)).

Use both helpers from `validateKindBinding` (site = `"binding"`) and from the new `validateKindParam` (site = `"parameter"`).

### 5.d Field-site rejection

Phase 6.2 must reject *uses* of a kind on a struct field. Two places this could trip:

- **Field-type kind prefix.** If a struct decl writes `conn: scoped FileHandle,`, the field-type parser currently treats `scoped` as the type name and fails downstream. We need to **detect** this case before that confusing error. Approach: in the struct-field parser, before consuming the type, peek for the kind-prefix pattern (`IDENT IDENT`). If detected, consume the kind prefix as a field-kind, then parse the actual type, and emit an AST with `kindPrefix` set on the field. The typechecker then rejects it with `"kind-bearing struct fields require propagates<K> or contains<K> on the enclosing struct (phase 6.4)"`.
- **Implicit field-site kind via initializer**. `type S { x: ref FileHandle, ... }` where some user later tries to store a `scoped` value into `S.x` - the escape walker catches this as an `outer.field = a` violation (§6.c).

The first is a deliberate parse-extend-then-typecheck-reject pattern: we *want* a clear error message, so we parse the form fully and reject it in the typechecker rather than letting the lexer/parser bail with a confusing token-mismatch error.

### 5.e Re-binding under a `scoped` kind

Phase 6.1 already rejects re-binding a kind-tracked value under any kind. The escape pass needs the same check for `scoped`-parameter aliasing: `let b = a` where `a` is a `scoped` binding/parameter creates an alias whose escape we'd have to track. The 6.1 rejection covers the with-prefix case (`scoped b: T = a`); for the no-prefix case (`let b: ref FileHandle = ref a`), the simplest rule for 6.2 is: **any `let`/`const` binding initialized from a `scoped`-tagged identifier is rejected** with `"cannot alias a scoped binding under a non-scoped name (phase 6.2)"`. This is checked in `checkLetOrConst` after the RHS is type-resolved, by walking the RHS expression for any IDENT whose scope-binding entry carries `kindType.mustNotEscape`.

(This is conservative - some aliases are safe - but it's the simplest static rule that keeps the escape pass tractable. Phase 6.3 may relax it.)

## 6. The flow pass - [kindCheck.js](../src/jsyooptypecheck/kindCheck.js)

### 6.a Frame extension

Each frame currently carries an `obligations: CleanupObligation[]`. Add a parallel field:

```js
const frame = {
  obligations: [],           // existing - for mustCall
  escapeSentinels: [],       // NEW - for mustNotEscape
                             // entries: { bindingName, kindName, structType, sourceLoc, declScope }
};
```

A *sentinel* is a binding-or-parameter name plus the metadata needed to produce a clear error. `declScope` is the scope-depth at which the sentinel was declared, used for the field-store escape check.

### 6.b Walker entry - function parameters as sentinels

Before walking the function body, populate the outer frame's `escapeSentinels` from any parameter whose `kindType?.mustNotEscape` is true:

```js
function runKindCheck(fnDecl, errors) {
  const outerFrame = { obligations: [], escapeSentinels: [] };
  for (const p of fnDecl.parameters) {
    const kt = p.resolvedKindType;
    if (kt?.mustNotEscape) {
      outerFrame.escapeSentinels.push({
        bindingName: p.name,
        kindName: kt.name,
        structType: unwrapRef(p.typeAnnotation.resolvedType),
        sourceLoc: p.sourceLoc,
        declScope: 0,
      });
    }
  }
  stack.push(outerFrame);
  walkBlock(fnDecl.body);
  stack.pop();
}
```

Parameters with kinds that *don't* declare `mustNotEscape` (none exist in 6.2 because `scoped` is the only parameter-applicable kind we ship, and it has `mustNotEscape`) - but the code path is forward-compatible.

### 6.c Escape checks at each AST visitor

Three places need new logic in the walker:

**(1) `RETURN_STATEMENT`.** When visiting a return, walk the returned expression for any IDENT whose name appears in *any frame's* `escapeSentinels`. If found, error:

```
binding 'a' has kind 'scoped' which forbids escape via return
  --> at <sourceLoc of the return>
  --> binding declared at <sourceLoc of decl>
```

A returned struct literal `return { fd: a, ... }` is treated as escape iff `a` is a sentinel (the value is now in a struct that the caller will hold). A returned struct literal that includes `ref a` is also rejected (the ref escapes). A returned expression that's `a.field` (primitive field of a scoped struct) is **fine** - the primitive is a value copy and doesn't keep `a` alive. The walker distinguishes by the resolved type of the returned expression: if the resolved type is a primitive or `int32`/`bool`/`string`, no escape; if it's `StructType`, check IDENT children for sentinels; if it's `RefType`, the inner IDENT must not be a sentinel.

This rule is approximate but sufficient for the goal-program suite. Document the rule inline as a comment in `kindCheck.js`: "An expression escapes a scoped sentinel iff the expression's resolved type is non-primitive AND the expression names the sentinel directly or includes it as a struct-literal field-value."

**(2) `ASSIGNMENT_STATEMENT` / field store.** When visiting `outer.field = expr`, look up the resolved type of `outer`:

- If `outer` is itself a scope-binding entry, find its `scopeDepth` (recorded in 4.b).
- Walk `expr` for any IDENT whose scope-binding entry is a sentinel (i.e., that binding's frame is `>=` outer's depth → store into a longer-lived target).
- If outer's depth is *strictly less than* the sentinel's `declScope`, it's an escape. Error: `"binding '<a>' has kind '<scoped>' which forbids escape via store into longer-lived struct '<outer>'"`.

(Equal-depth field stores within the same scope are not escapes - the struct dies at the same time as the sentinel.)

**(3) `CALL_EXPRESSION` - `f(ref a)`.** When visiting a call, iterate argument-parameter pairs. For each argument that is `ref <ident>` where `<ident>` is a sentinel, check the corresponding parameter's `resolvedKindType`:

- If the parameter has a `kindType` with `mustNotEscape`, the call is legal - the callee promises not to escape. No new sentinel needs to be tracked (the callee's body has its own walker run that enforces).
- Otherwise, error: `"cannot pass 'ref <a>' to parameter '<p>' which does not declare 'scoped' or 'mustNotEscape scope' kind"`.

Exception: synthetic `CLEANUP_CALL` nodes inserted by 6.1's flow pass are *not* user-written and are by construction safe (they call the trait's mustCall method, which receives the sentinel by ref but cannot retain it because the method has only its body-level scope and the binding is destroyed immediately after). Skip them in the walker - they're a different `node.kind` from `CALL_EXPRESSION`, so this falls out for free.

### 6.d Sentinel scope-exit

When a frame is popped (the binding's scope ends), its sentinels are removed from active tracking. This is the natural model: after the scope is gone, escape is no longer a concept - the binding doesn't exist to escape *from*.

Sentinels in *outer* frames remain active throughout inner scopes; an inner scope can't escape an outer scope's sentinel any more than the outer scope itself can.

### 6.e Goal-program trace

For the §Goal program's `main`:

```yoop
function main(): int32 {
    scoped a: FileHandle = { fd: 1 };   // declare sentinel a in main's frame
    use(ref a);                          // call: use's param is scoped → legal
    return 0;                            // return expr is int32 → no sentinel walk
}
```

For `use`:

```yoop
function use(scoped h: ref FileHandle): void {   // h is a sentinel in use's outer frame
    printf(`fd=${h.fd}\n`);                       // h.fd is int32 → ok
}
```

Both pass cleanly. Now the fail case:

```yoop
function bad(): FileHandle {
    scoped a: FileHandle = { fd: 1 };   // sentinel a
    return a;                            // return expr names a, struct type → ERROR
}
```

Walker hits `return a`, sees `a` is a sentinel, sees the return-type is `FileHandle` (a struct), emits the escape error.

## 7. Codegen ([codegen.js](../src/jsyoopcodegen/codegen.js))

**No changes.** Phase 6.2 is a pure static-analysis sub-phase: violations are caught in the typechecker and never reach codegen. Phase 6.1's CLEANUP_CALL emission path is unchanged.

The only "codegen-adjacent" concern is that the *function-parameter* form `scoped h: ref FileHandle` may want a different SSA name or marker - but no, it doesn't. Parameter codegen is unchanged; the `kindType` field on the parameter is consumed by `kindCheck` and discarded before codegen.

## 8. Driver wiring

No changes. `typecheckProgram` already runs Pass C.2 (added in 6.1) and Pass D (calls `runKindCheck`). The new logic plugs into existing seams.

## 9. Multi-clause kinds

The full `scoped` kind from [SPEC.md:378-383](../SPEC.md#L378) combines five clauses:

```yoop
kind scoped {
    appliesTo binding parameter;
    requires Disposable;
    ownsBlock;
    mustCall dispose beforeScopeEnd;
    mustNotEscape scope;
}
```

After 6.2, all five clauses parse and resolve. The `mustCall dispose beforeScopeEnd` clause continues to work exactly as in 6.1 (cleanup at scope exit), and `mustNotEscape scope` adds the new flow check. Together they enforce: "this binding is disposed before scope end, AND cannot escape to be observed after." That's the safety promise users expect from an RAII-style scoped resource.

The `pooled` and `scoped` task-bindings from [SPEC.md:371-383](../SPEC.md#L371) also use `autoJoin` (6.3) and the disjunction form of `mustCall` (6.3) - both rejected at parse in 6.2 with their deferral message, so users writing the full `pooled` kind in 6.2 will see "autoJoin not yet supported (phase 6.3)" and stop there.

## 10. Tests

### 10.1 Pass fixtures - [examples/pass/](../examples/pass/)

#### `scoped_basic.yoop` - the goal program from §Goal

Verifies: kind decl with `mustNotEscape`, multi-site `appliesTo`, kind-prefixed parameter accepted, `ref a` passed to a `scoped` parameter, dispose-at-scope-end still fires.

#### `scoped_param_only.yoop` - parameter kind, no escape attempt

```yoop
function use(scoped h: ref FileHandle): void {
    printf(`fd=${h.fd}\n`);
}

function main(): int32 {
    let h: FileHandle = { fd: 7 };   // plain binding, no kind
    use(ref h);                       // pass to scoped param → legal (caller's binding outlives the call)
    return 0;
}
```

Verifies: a plain `let` binding can be passed `ref` to a `scoped` parameter - the kind constraint applies inside the callee but does not impose any requirement on the caller's binding shape. (This is the "scoped is a callee-side promise" model.)

#### `scoped_lifo_with_disposable.yoop` - `scoped` and `disposable` interleaved

```yoop
function main(): int32 {
    scoped a: FileHandle = { fd: 1 };
    disposable b: FileHandle = { fd: 2 };
    return 0;
}
```

Expected output (LIFO cleanup, both kinds emit `dispose(ref ...)`):

```
disposing fd=2
disposing fd=1
```

Verifies: `scoped` and `disposable` both emit cleanup; LIFO order preserved across kind boundaries.

#### `scoped_field_access_ok.yoop` - primitive field access is not escape

```yoop
function fd_of(scoped h: ref FileHandle): int32 {
    return h.fd;        // primitive field - legal
}

function main(): int32 {
    scoped a: FileHandle = { fd: 9 };
    printf(`fd=${fd_of(ref a)}\n`);
    return 0;
}
```

Expected:

```
fd=9
disposing fd=9
```

Verifies: returning a primitive derived from a scoped binding is not an escape; the binding itself stays in scope.

#### `scoped_nested_block.yoop` - explicit block with `scoped`

```yoop
function main(): int32 {
    scoped a: FileHandle = { fd: 5 } {
        printf(`inside\n`);
    }
    printf(`after\n`);
    return 0;
}
```

Expected:

```
inside
disposing fd=5
after
```

Verifies: trailing-block form works for `scoped` exactly as for `disposable`.

#### `kind_pooled_parse.yoop` - `mustNotShare` parses (no enforcement)

```yoop
trait Disposable { function dispose(ref self): void; }
type Handle implements Disposable {
    id: int32,
    function dispose(ref self): void { printf(`drop ${self.id}\n`); }
}
kind pooled {
    appliesTo binding;
    requires Disposable;
    mustCall dispose beforeScopeEnd;
    mustNotShare acrossScopes;
}
function main(): int32 {
    pooled h: Handle = { id: 1 };
    return 0;
}
```

Expected:

```
drop 1
```

Verifies: `mustNotShare acrossScopes;` parses, stores on `KindType`, doesn't break the mustCall pipeline, and produces no spurious errors. (The sharing isn't actually enforced - there's no concurrent scope.)

#### `kind_forbids_parse.yoop` - `forbids` parses (no enforcement)

```yoop
kind safe {
    appliesTo binding;
    forbids io globalState;
}
type Empty { unused: int32 }
function main(): int32 {
    safe x: Empty = { unused: 0 };
    return 0;
}
```

Expected (program compiles and runs; nothing visible):

```
```

Verifies: `forbids io globalState;` parses, stores categories. No effect-tracking yet, so calling `printf` inside main is *not* rejected even though `safe` would forbid it.

### 10.2 Fail fixtures - [examples/fail/](../examples/fail/)

| Fixture | Trigger | Expected error substring |
|---|---|---|
| `kind_appliesto_function.yoop` | `appliesTo function;` in 6.2 | `appliesTo function not yet supported` |
| `kind_appliesto_duplicate.yoop` | `appliesTo binding binding;` | `duplicate appliesTo site` |
| `kind_appliesto_empty.yoop` | `appliesTo;` | `appliesTo requires at least one site` |
| `kind_mustnotescape_function.yoop` | `mustNotEscape function;` | `mustNotEscape function not yet supported` |
| `kind_mustnotshare_acrossthreads.yoop` | `mustNotShare acrossThreads;` | `acrossThreads not yet supported` |
| `kind_forbids_unknown.yoop` | `forbids memory;` | `unrecognized forbids category 'memory'` |
| `kind_forbids_empty.yoop` | `forbids;` | empty list / parse error |
| `kind_duplicate_mustnotescape.yoop` | two `mustNotEscape scope;` clauses | `duplicate mustNotEscape clause` |
| `param_two_kinds.yoop` | `function f(scoped disposable h: T)` | `a parameter may carry at most one kind prefix` |
| `param_kind_not_applies.yoop` | parameter uses `disposable` kind (which has `appliesTo binding` only) | `kind 'disposable' does not apply to parameters` |
| `binding_kind_not_applies.yoop` | binding uses a kind that's `appliesTo parameter` only | `kind '<k>' does not apply to bindings` |
| `field_with_kind.yoop` | `type S { x: scoped FileHandle, ... }` | `kind-bearing struct fields require propagates<K> or contains<K>` |
| `scoped_escape_return.yoop` | `return a;` where `a` is `scoped` | `forbids escape via return` |
| `scoped_escape_struct_literal.yoop` | `return { handle: a, ... }` carrying scoped `a` | `forbids escape` |
| `scoped_escape_field_store.yoop` | `outer.handle = a;` where outer outlives `a` | `forbids escape via store into longer-lived struct` |
| `scoped_escape_pass_unscoped.yoop` | `f(ref a)` where `f` param is not `scoped` | `parameter '<p>' which does not declare 'scoped'` |
| `scoped_alias.yoop` | `let b: ref FileHandle = ref a;` where `a` is `scoped` | `cannot alias a scoped binding under a non-scoped name` |

### 10.3 Regression - existing fixtures

Every `examples/pass/*` fixture from phases 1-6.1 must still pass. In particular:
- `disposable_*` fixtures from 6.1 - the `disposable` kind continues to work; no new `mustNotEscape` is added to it, so no new errors fire.
- `traits_disposable` - manual `dispose(ref h)` call still legal; passing `ref h` to a non-scoped `dispose` is fine because `h` is a plain `let` binding, not a sentinel.

The 6.1 fail-fixtures (`binding_unknown_kind`, `binding_non_struct`, etc.) continue to fail with the same error messages - the relevant codepaths are extended, not rewritten.

## 11. Verification

End-to-end:

```sh
node ./src/yoopiler.js -i examples/pass/scoped_basic.yoop -o output
./output.exe
```

Expected output matches §Goal. Run the regression suite to confirm all pass fixtures compile and run, and all fail fixtures produce the expected typecheck/parse error substring.

Spot-checks:

- For `scoped_basic.yoop`: LLVM IR should contain a single `call void @<modId>__FileHandle__dispose(ptr %a)` before the `ret i32 0`. The `use(ref a)` call should emit a normal `call void @<modId>__use(ptr %a)` - codegen is unchanged.
- For each fail fixture, the compiler exits with non-zero status and stderr contains the substring from the table in §10.2.

## 12. Out of scope (addressed later)

- **Transitive escape via helper functions.** A function that takes a `ref` parameter and returns a value derived from it requires inter-procedural reasoning. Not in 6.2 - users must mark intermediate parameters `scoped` explicitly.
- **Sharing across concurrent tasks.** Phase 6.3. `mustNotShare acrossScopes;` parses but doesn't enforce until task boundaries exist.
- **Effect-tracking and `forbids` enforcement.** Requires marking which functions touch which effects (FFI declared categories, propagation through call graphs). Separable; lands when the language acquires an effect system, likely after 6.5.
- **Kind-bearing struct fields.** Requires `propagates<K>` / `contains<K>`. Phase 6.4. Field-site is parsed and explicitly rejected in 6.2 to give a clear error message rather than letting users discover the gap accidentally.
- **`mustNotEscape function;` / `module;`.** Other escape granularities. Not in 6.2 - only `scope`. The `function`-granularity is roughly equivalent to "can be passed through `return` of helpers but not out of the original frame," and may not have a clear use case until effect tracking lands.
- **Cleanup-on-`break`/`continue` cleanup for escape sentinels.** Out of scope: `mustNotEscape` is a static check, not a cleanup-injection point. `break`/`continue` exits *blocks*; the sentinel's frame pops as usual.
- **`scoped` on `let` vs. `const`.** Both legal, same as `disposable` in 6.1. No new mutability story.

## Critical files (for implementation)

- [src/contracts.js](../src/contracts.js) - three new AST node kinds.
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) - nine new keyword tokens.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) - `parseAppliesToClause` rewrite, three new clause parsers, parameter-kind detection in function parameter parser, field-kind detection in struct-field parser.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) - `KindType` fields: `appliesTo: Set`, `mustNotEscape`, `mustNotShare`, `forbids`.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) - `resolveKindClauses` extensions; `validateFunction` parameter-kind hook.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js) - `validateKindApplicability` extraction; alias rejection; field-kind rejection.
- [src/jsyooptypecheck/scope.js](../src/jsyooptypecheck/scope.js) - `scopeDepth` on binding entry.
- [src/jsyooptypecheck/kindCheck.js](../src/jsyooptypecheck/kindCheck.js) - escape-sentinel tracking; new visitors for `RETURN_STATEMENT`, `ASSIGNMENT_STATEMENT`, `CALL_EXPRESSION`.
