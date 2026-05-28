# Plan - Marker kinds and kind transitions (taint / clearance, generalized)

## Implementation status: v0 landed

The first cut is in. Headline files:
[src/jsyooptypecheck/kindFlow.js](../src/jsyooptypecheck/kindFlow.js) (the
checker), [src/contracts.js](../src/contracts.js) (`KIND_MARKER_CLAUSE`,
`KIND_TRANSITION_CLAUSE`),
[src/jsyooparser/parser.js](../src/jsyooparser/parser.js) (contextual
`conferred` / `restrictive` / `clearedBy` / `appliedBy` clauses,
`appliesTo return`, kind-prefix in `parseTypeAnnotation`),
[src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js)
(`KindType.marker` / `.clearedBy` / `.appliedBy`),
[src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js)
(pass C.2 resolution + marker/mustCall + polarity/transition matching,
pass D.2 invocation). Pass fixture
[examples/pass/clearance_marker.yoop](../examples/pass/clearance_marker.yoop)
plus seven fail fixtures under [examples/fail/](../examples/fail/);
all wired into [src/e2e.test.js](../src/e2e.test.js). A new
"Cross-cutting invariants" bullet covers the rule end-to-end in
[CLAUDE.md](../CLAUDE.md).

**Design refinement during implementation: the kind decl pairs a
required trait with a method name; the trait is the authority.** Two
earlier cuts surfaced the design forks:

- First cut had transitions be signature-driven (any function with a
  matching shape implicitly authorized the transition). This collapsed
  marker kinds to type prefixes with no kind-machinery role.
- Second cut moved authority to `clearedBy <fn>;` / `appliedBy <fn>;`
  on the kind decl, but kept stringy free-function name matching. The
  authority was centralized but still brittle (rename and the kind decl
  silently breaks) and didn't pair with the existing trait machinery.

The final shape parallels the disposable + Disposable pattern:

1. **Use-site bound check** (as in the original sketch): at every slot
   (binding initializer, assignment, return, call argument), the
   expression's marker set must satisfy the slot's by the two bounds.
2. **Decl-authority check**: a clearance kind declares `requires
   <Trait>;` plus `clearedBy <method>;` (restrictive) or `appliedBy
   <method>;` (conferred). A function whose signature would strip a
   restrictive kind (a parameter carries it, the return does not) MUST
   be a METHOD on a type whose `implements` list includes the kind's
   required trait, with name matching the kind's `clearedBy`. Same for
   the conferred direction. **Free functions are categorically
   rejected** - laundering requires opting in via a trait impl. The
   trait is the structural gate; the method name picks the transition
   from that trait. The compiler still bakes in no "launder" verb - the
   user names the trait and its method; the kind decl just names them
   as the authority ("expressed sentiment").

Trait method signatures stay plain (`function cleanse(ref self): T;` on
a generic `Cleansable<T>`). The kind decl describes the semantic role
rather than encoding kind prefixes in the trait method's annotation
(trait methods require `ref self` as their first parameter, and Yoop
has no `Self` placeholder in return position - so generic traits are
the idiomatic shape). At a trait-qualified call (`Cleansable.cleanse(ref
x)`), kindFlow reads the typechecker's stamped `calleeMethodName` +
`calleeTrait` on the CALL_EXPRESSION and looks up every conferred kind
whose `(appliedBy, requires.name)` pair matches; those kinds are
added to the call's result marker set. Arg sink-checks are skipped on
trait calls (the kind decl is the contract).

**Other deviations from the original flow-pass draft**:

- **No flow pass.** Yoop requires explicit type annotations on every
  binding and assignments must conform, so a binding's kind set is
  pinned at its declaration site - it cannot be "cleared on one
  branch, plain on another" (that would be a type error at the
  assignment). The flow analysis collapses to a single static walk
  that compares static marker sets at each slot.
- `conferred` / `restrictive` / `clearedBy` / `appliedBy` are
  recognized **contextually** inside a kind body (they lex as plain
  idents), not added as reserved keyword tokens - consistent with the
  lesson from [chat-agent-papercuts.md](completed/chat-agent-papercuts.md) #3.
- Resolved types are **not** mutated to carry a `kinds: Set<KindType>`
  annotation. Yoop's resolved-type objects are frozen + shared.
  Instead `parseTypeAnnotation` attaches `kindPrefixes: string[]` to
  the per-occurrence annotation; the checker resolves those to
  `KindType`s on demand. `isAssignable` is untouched - both checks
  live inside kindFlow.
- The plan's `marker_branch_merge.yoop` pass fixture and branch-merge
  fail fixtures are dropped: with mandatory typing the merge scenario
  cannot arise.
- v0 enforces only same-module direct function calls (string callee),
  parameter / return / binding sites. Cross-module + namespaced calls
  (the chat agent's std/http sinks), method calls, and field-position
  sources stay as the listed follow-ups; the chat-agent rewrite waits
  on cross-module callee resolution.

The design discussion below is kept for context - the model (two
polarities + kind-decl-authorized transitions + assignability bounds)
lines up with the implementation; only the runtime topology of "how it
is checked" is the static walk described above, not a flow pass.

---

Adds the one kind capability the existing grammar cannot express:
**kinds that attach to and detach from a value, and slots that require or
forbid a kind**. This is the general primitive behind `tainted`,
`cleared`, `authenticated`, `validated`, `parsed_uri` - every "must have
been X'd before it reaches Y" guarantee in
[kinds-design.md](kinds-design.md)'s in-tree list. Motivated by
[chat-agent-papercuts.md](completed/chat-agent-papercuts.md) Issue 1.

This revises an earlier draft that baked a bespoke `clearedBy launder;`
clause and a `cleared<tainted>` sink marker into the language. Per design
discussion, that was too special-cased: it taught the compiler what
"laundering" means. The model below instead makes the compiler track
only kind-set membership and check it at use sites - "launder" becomes an
ordinary function whose *signature* expresses the transition, not a verb
the compiler knows.

## The gap, in one sentence

Every kind today either carries an obligation discharged before scope
exit (`disposable` = `mustCall dispose beforeScopeEnd`) or is a flat
prohibition (`mustNotShare`, `mustNotEscape`, `forbids`). None can say
"this value carries a marker that a sink requires (or forbids), and the
marker is added or removed by passing the value through a function." That
marker-plus-use-site-rule is what taint/clearance needs.

## What changed from the first draft

- **No `clearedBy` clause.** A transition is expressed by a function
  signature: `function launder(d: tainted uint8[]): cleared uint8[]`. The
  signature is the authorization; the body is trusted to actually
  sanitize (the standard trust model of any taint system - the compiler
  guarantees callers route *through* a declared transition, not that the
  transition's body is correct).
- **Sinks take a bare kind in the type:** `value: cleared string`, not
  `cleared<tainted>`. A kind in a parameter/return/field type is part of
  that type's contract.
- **`cleared` and `tainted` are ordinary marker kinds with no
  obligation.** No `mustCall`, no cleanup, no codegen. Their only rules
  are about where they are required or forbidden.
- **`propagates<K>` is unchanged and works for any kind.** A value can
  propagate a `tainted`, `cleared`, or `disposable` kind. For marker
  kinds there is no cleanup to transfer; the kind simply travels with the
  value.
- **The compiler primitive** is: a kind set per value, a per-kind
  assignability bound, and flow tracking of the set across statements.
  Nothing about "laundering" is baked in.

## The model

### Two flavors of kind

- **Obligation kinds** (existing): `disposable`, the task kinds. Carry
  `mustCall` / refcount obligations. Tracked by
  [kindCheck.js](../src/jsyooptypecheck/kindCheck.js) + `propagates<K>`.
  Unchanged by this plan.
- **Marker kinds** (new): no obligation. Declared with a *polarity* that
  fixes how the kind is acquired, shed, and checked at slots.

### Marker-kind polarity (the core idea)

A marker kind is one of two duals. Both fall out as a single
assignability rule: a value's kind set is compared against a slot's
declared kind set, with the comparison direction set by polarity.

- **conferred** - a capability you cannot forge. Canonical examples:
  `cleared`, `authenticated`, `validated`. A slot that names the kind is
  a **lower bound**: the value must carry *at least* that kind. You may
  drop it freely (a `cleared string` flows into a plain `string` slot -
  you just lose the guarantee). You acquire it only from a value whose
  producing type declares it (a function returning `cleared X`, a field
  typed `cleared X`).

- **restrictive** - a hazard you cannot silently drop. Canonical example:
  `tainted`. A plain slot is an **upper bound**: the value must carry *at
  most* the slot's kinds, so a plain slot forbids `tainted`. You may gain
  it freely (a plain value flows into a `tainted` slot - widening to the
  conservative side). You shed it only by passing through a function that
  accepts the kind and returns without it.

The whole enforcement is then one comparison in `isAssignable`:

```text
value.conferred   superset-of-or-equal   slot.conferred     // must have at least
value.restrictive subset-of-or-equal     slot.restrictive   // must have at most
```

Everything else (which kind is "tainted", what "laundering" means) is
just naming and signatures the user writes.

### Why conferred is the ergonomic workhorse, restrictive the strong dual

They differ in where the friction lands:

- **conferred (`cleared`)** is light. A raw value is simply plain; it
  carries `cleared` only after a transition. Nothing forces you to act
  until you hit a sink that *requires* `cleared`. You typically launder
  as late as possible, producing the `cleared` form right before the
  sink. Helpers in between need no annotation. This is the
  `authenticated` / `validated` pattern and the recommended default.

- **restrictive (`tainted`)** is stronger but heavier. Taint attaches at
  the source and *spreads*: any helper that takes a tainted value and
  wants to pass its result onward must itself thread `tainted` through
  its signature, or it cannot accept the tainted value at all (a plain
  param forbids taint). That eager spread is exactly what you want for
  "track every place untrusted bytes can reach", and exactly the
  annotation burden you do not want for routine code.

A given problem usually picks one. The chat agent uses `cleared`
(conferred). `tainted` is available for code that wants source-to-sink
spread.

### Kinds in type position

A kind name may prefix a type anywhere a type is written, gated by the
kind's `appliesTo` sites:

```text
body:  tainted uint8[]      // a field carrying a restrictive kind (source)
value: cleared string       // a parameter requiring a conferred kind (sink)
function launder(...): cleared uint8[]   // a return conferring a kind
cleared x: string = ...     // a binding (as today for disposable)
```

A type's kind set is an annotation on the resolved type. It does **not**
affect structural equality or codegen - `cleared string` and `string`
are the same runtime representation. The kind set is a contract checked
by assignability and flow, then discarded.

### Transitions are signature-driven (the "expressed sentiment")

There is no transition clause. A function transitions kinds purely by the
kinds on its parameter and return types:

- **Confer**: `function authenticate(r: Request): authenticated Request`
  - the result carries `authenticated`; the input did not. Inside the
  body the programmer asserts the request was actually checked; the
  compiler trusts the signature.
- **Strip / launder**: `function launder(d: tainted uint8[]): uint8[]` -
  accepts `tainted`, returns plain. The result has shed the kind.
- **Both**: `function launder(d: tainted string): cleared string`.

The body is trusted, exactly as a declared sanitizer is trusted in any
taint system. The compiler's guarantee is that callers cannot reach a
sink *except* by routing through some function whose signature performs
the transition.

### Flow tracking

A binding's kind set is flow-sensitive (it changes across statements), so
a flow pass computes the kind set of every value expression:

- `let c = launder(t);` gives `c` the return type's kinds.
- `c = raw;` recomputes `c`'s kinds from the RHS.
- Branch merge is a **union** of kind sets across arms (conservative for
  both polarities: a value is conferred-cleared after a join only if
  every arm cleared it - so conferred merges by *intersection*; a value
  is restrictive-tainted after a join if any arm tainted it - so
  restrictive merges by *union*). Concretely: merge conferred kinds by
  intersection, restrictive kinds by union. This is the dual-lattice
  generalization of kindCheck's `mergeSatIntersect`
  ([kindCheck.js:299-312](../src/jsyooptypecheck/kindCheck.js#L299-L312)).

The assignability check then fires at each slot (call argument, return,
assignment, field store) using the value expression's computed kind set.

### Composition with `propagates<K>`

`propagates<K>` is unchanged. For obligation kinds it transfers the
cleanup obligation as today. For marker kinds there is no obligation, so
propagation just means the kind travels with the value through a return
or field - which the type-position prefix already expresses. A type may
propagate a marker kind and an obligation kind independently; the two
lattices do not interact (one tracks cleanup-before-exit, the other
membership-for-use). A fixture exercising a value that is both
`disposable` and `cleared` confirms non-interaction.

## Goal program

The chat agent's `sanitize()` (a plain function plus a "remember to call
me" comment - the exact "validator without a kind" anti-pattern) becomes
compiler-checked, using `cleared` (conferred):

```yoop
// A marker kind: a capability you cannot forge, only earn by transition.
kind cleared {
    appliesTo binding parameter field return;
    conferred;          // lower-bound: slots that name it REQUIRE it
}

// The launderer. Its signature is the only thing that confers `cleared`:
// it builds a fresh, control-byte-free string. The body is trusted.
function launder(dirty: uint8[]): cleared string {
    // ... copy out, dropping ASCII control bytes, build a string ...
}

// A sink: this parameter requires the conferred kind.
function headers_add(ref h: Headers, name: string, value: cleared string): void { /* ... */ }

function handle(ref req: Request, ref resp: Response): void {
    // ERROR: a plain string lacks `cleared`; the sink requires it.
    //   fix-it: produce a cleared value first (e.g. `launder(...)`).
    headers_add(ref resp.headers, "X-Echo", str(req.body));

    // OK: laundered into the cleared form right at the sink.
    headers_add(ref resp.headers, "X-Echo", launder(req.body));
}
```

The same problem in the restrictive (`tainted`) framing, for comparison:

```yoop
kind tainted {
    appliesTo binding parameter field return;
    restrictive;        // upper-bound: plain slots FORBID it
}

type Request { body: tainted uint8[], /* ... */ }

function launder(dirty: tainted uint8[]): string { /* strip + rebuild */ }

// headers_add's value is plain `string`, which forbids tainted.
function headers_add(ref h: Headers, name: string, value: string): void { /* ... */ }

function handle(ref req: Request, ref resp: Response): void {
    headers_add(ref resp.headers, "X-Echo", str(req.body)); // ERROR: str forbids tainted arg
    headers_add(ref resp.headers, "X-Echo", launder(req.body)); // OK
}
```

## Why this is low-risk

1. **No codegen.** Markers are erased after checking; `cleared string` is
   `string` at runtime. Nothing is emitted.
2. **One assignability rule.** The enforcement is the two-line bound
   check in `isAssignable`; the rest is plumbing kind sets to it.
3. **Reuses the flow topology** already in
   [kindCheck.js](../src/jsyooptypecheck/kindCheck.js) (identifier-level
   state, snapshot/restore/merge across branches).
4. **The grammar already anticipates richer kind use** - `mustCall ...
   beforeAny` / `afterAny` are reserved but unsupported
   ([parser.js:1335-1341](../src/jsyooparser/parser.js#L1335-L1341)); the
   marker-kind direction is orthogonal and additive.

## Files touched

- [src/contracts.js](../src/contracts.js) - one new clause node,
  `KIND_MARKER_CLAUSE` (carries the polarity). No synthetic runtime node.
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) - keyword tokens
  `conferred`, `restrictive`; the `return` site word inside `appliesTo`
  (already lexes as the `return` keyword - recognize it contextually).
  Marker-kind names stay plain identifiers.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js):
  - `parseKindClause` ([parser.js:1027](../src/jsyooparser/parser.js#L1027))
    gains a marker-polarity case (`parseMarkerClause`); reject a kind that
    declares both a polarity and `mustCall` (obligation vs marker are
    exclusive).
  - `parseAppliesToClause` ([parser.js:1055](../src/jsyooparser/parser.js#L1055))
    accepts `return` as a site.
  - `parseTypeAnnotation` (generics section of
    [parser.js](../src/jsyooparser/parser.js)) accepts an optional leading
    kind-name prefix on a type, in field / param / return / binding
    position. Multiple prefixes (`cleared validated string`) form a set.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js):
  - `KindType` ([types.js:329](../src/jsyooptypecheck/types.js#L329)) gains
    `marker: null | "conferred" | "restrictive"`; `appliesTo` accepts
    `"return"`.
  - resolved types gain a `kinds: Set<KindType>` annotation slot;
    `typesEqual` / assignability-of-the-base ignore it.
- [src/jsyooptypecheck/coerce.js](../src/jsyooptypecheck/coerce.js) -
  `isAssignable` extended with the two-bound kind-set check (conferred
  superset, restrictive subset). This is the enforcement home. The
  diagnostic names the polarity and points at "produce/launder via a
  transition".
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js)
  and [checkStatement.js](../src/jsyooptypecheck/checkStatement.js):
  `resolveTypeAnnotation` records kind prefixes onto the resolved type;
  call-argument / return / assignment checks pass the value's
  flow-computed kind set into `isAssignable`.
- **New** `src/jsyooptypecheck/kindFlow.js` - the flow pass computing
  per-binding kind sets across statements (dual-lattice merge). Invoked
  from `validateFunction` after `runKindCheck`.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) -
  Pass C.2 resolves the marker polarity; rejects marker + obligation
  combination.
- Codegen: **untouched**.
- [CLAUDE.md](../CLAUDE.md) - a new "Cross-cutting invariants" bullet
  describing marker kinds and the two-bound assignability rule, parallel
  to the `propagates<K>` bullet.

## Tests

### Pass fixtures (examples/pass/)

- `marker_cleared_basic.yoop` - the goal program (conferred): plain into a
  `cleared` sink fails to *produce* (so we only ship the laundered call);
  laundered value flows in; observable output proves the launder ran.
- `marker_tainted_basic.yoop` - the restrictive framing: tainted source,
  laundered before a plain sink.
- `marker_drop_conferred_ok.yoop` - a `cleared string` flows into a plain
  `string` slot (dropping a conferred kind is allowed).
- `marker_widen_restrictive_ok.yoop` - a plain `string` flows into a
  `tainted` slot (gaining a restrictive kind is allowed).
- `marker_branch_merge.yoop` - conferred merges by intersection (cleared
  only if both arms cleared); restrictive by union (tainted if either arm
  tainted). Pair with the fail fixtures below.
- `marker_with_disposable.yoop` - a binding that is both `disposable` and
  `cleared`; cleanup obligation and marker check coexist without
  interaction.

### Fail fixtures (examples/fail/, each with a .expected_error sibling)

- `marker_cleared_missing.yoop` - plain string into a `cleared` sink;
  assert the fix-it names a conferring transition.
- `marker_tainted_into_plain.yoop` - tainted value into a plain slot;
  assert the fix-it names laundering.
- `marker_forge_conferred.yoop` - constructing a `cleared string` from a
  plain value without a transition (cannot forge a conferred kind).
- `marker_branch_one_arm.yoop` - cleared on one branch only, required
  after the join (intersection merge rejects).
- `marker_tainted_one_arm.yoop` - tainted on one branch only, into a plain
  slot after the join (union merge rejects).
- `kind_marker_and_mustcall.yoop` - a kind declaring both a polarity and
  `mustCall` (obligation and marker are mutually exclusive).
- `kind_prefix_bad_site.yoop` - a kind prefix used in a site its
  `appliesTo` does not list.

### Regression

Every existing `examples/pass/*` and the full e2e suite must still pass -
markers are additive annotations plus a read-only flow pass and an
assignability extension that is a no-op for types with empty kind sets.
The chat agent
([examples/playground/chat_agent/main.yoop](../examples/playground/chat_agent/main.yoop))
is rewritten to use a `cleared` kind once this lands, retiring its plain
`sanitize()` and explanatory comment - the end-to-end fixture that proves
the feature on real code.

## Settled decisions

1. **Ship both polarities.** Both `conferred` and `restrictive` land in
   the first cut - they are duals over the same assignability check, so
   the second costs almost nothing once the first exists. `conferred` is
   the documented default and the shape the chat-agent demo uses;
   `restrictive` is fully supported for source-to-sink spread. Both
   appear in the pass/fail fixture matrix.

2. **Transitions are signature-driven.** A function transitions kinds
   purely via its parameter / return kind sets; "launder" is never a
   compiler concept. No `confers` / `strips` clause. If diagnostics later
   want an explicit hint, it can be added as pure documentation that must
   agree with the signature, never as the source of truth.

## Scope notes / follow-ups

- **Interprocedural inference** - inferring that a helper which consumes a
  conferred/restrictive value also carries it onward, without an explicit
  annotation. Out of scope: the boundary stays explicit (the signature is
  the contract). Conferred's "launder late, right before the sink"
  ergonomics make this rarely needed; restrictive's spread is the case
  that would most want it, and is the heavier-by-design framing.
- **Trait-based transitions** - a transition expressed as a trait method
  for polymorphic clearing of struct types. The free-function/signature
  form covers the array/string/scalar sources that motivate the feature;
  revisit when tainted struct types want per-type clearing.
- **`break` / `continue`** - fold into the kind-set merge (union for
  restrictive, intersection for conferred) rather than ignoring, the same
  gap kindCheck has today for its sat-merge.
