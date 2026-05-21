# Phase 7.5 — Error hardening, tagged unions (`enum`), and untagged unions (`union`)

## Context

SPEC §10 line 713 reads: *"No `switch` in v2. Pattern-matching on tagged unions is a future addition once the **error story hardens**."* The 7.3 plan ([plans/phase-7-3-pattern-matching.md](phase-7-3-pattern-matching.md)) ships a literal-only `switch` and explicitly defers tagged unions — *"Land when the `Result<T,E>` / `Option<T>` story is real, not before"* ([plans/phase-7-3-pattern-matching.md:169-172](phase-7-3-pattern-matching.md#L169-L172)). 7.5 is the "real" sum-type/pattern-matching phase, plus a separate C-style **untagged** union construct for layout-overlap use cases (`uint32` ↔ `{ r,g,b,a: uint8 }`).

The phrase "error story hardens" in the SPEC was a placeholder for the spec author. In practice the convention `{ ...fields, err: string }` + the `?` operator (Phase 2) plus `propagates` (Phase 6.4) has stabilized. What was missing is a typed-sum representation that users can reach for when `err: string` isn't expressive enough. That's what `enum` provides.

**Scope** — three orthogonal additions, landed in this order:

1. **`enum` declarations** — closed-set tagged sum types with named-field payloads, generic-capable: `enum Result<T, E> { Ok { value: T }, Err { error: E } }`.
2. **Pattern-matching extensions to `switch`** — variant patterns with field destructuring and field-binding renames, exhaustiveness across the closed enum set, irrefutable wildcards.
3. **`union` declarations** — untagged overlapping-memory aggregates: every field starts at offset 0, size = max field size, alignment = max field alignment. No discriminator, no compile-checked active field.

**Out of scope (explicit follow-ups):**

- **`?` over enum-shaped `Result<T, E>`.** `?` continues to only work on the `err: string`-bearing struct convention. Generalizing it to a user-defined `enum Result<T, E>` requires a "marker trait or attribute that says *this enum is the fallible enum for this function's return type*" — design choice deserves its own phase. See [§Follow-ups](#follow-ups-not-in-75).
- **`Option<T>`-style sugar.** The language gets the building blocks; a stdlib `Option<T>` is a Phase 8 concern.
- **`match` as expression.** Stays statement-only. Spec-consistent with `if`/`switch`.
- **Range patterns / guards / `|` patterns.** Same deferrals as [phase-7-3-pattern-matching.md §Follow-ups](phase-7-3-pattern-matching.md#L166-L173).
- **C-style anonymous unions inside structs.** A `union` is a top-level declaration; structs can't inline an anonymous union body. Workaround: declare a named `union`, use it as a field type.
- **Untagged union safety opt-in.** The SPEC reserves `import.unsafe;` (§12) for raw pointer access. Untagged unions are a similar foot-gun (bit-reinterpret reads have implementation-defined semantics). For 7.5 we **do not** gate `union` behind `import.unsafe;` — the user explicitly asked for this as a first-class layout feature, and the typical use cases (`rgba` ↔ `uint32`, network packet headers, NaN-boxing) are intentional bit-reinterpret. Revisit if the foot-gun materializes.

**Prerequisite.** 7.5 assumes Phase 7.3 (literal-only `switch`) has landed. The phase-7-3 plan is currently unimplemented; 7.5.0 below covers the 7.3 lexer/parser/typecheck/codegen surface first, then layers the variant-pattern extensions on top. If 7.3 lands separately, the corresponding sub-steps in 7.5.0 become no-ops — same end state.

**Deferrals this phase retires:**

- SPEC §10:713-714 — *"Pattern-matching on tagged unions is a future addition once the error story hardens."* → retired (subject to `?`-over-enum follow-up).
- [plans/phase-7-1-generics.md:7](phase-7-1-generics.md#L7) — *"Without sum types, 'pattern matching' reduces to `switch`"* → retired.
- [plans/phase-7-3-pattern-matching.md:169-172](phase-7-3-pattern-matching.md#L169-L172) — *"Tagged unions + destructuring — the real spec §10 work."* → retired.

---

## Design overview

### 1. `enum` — tagged unions

```yoop
enum Shape {
    Circle { radius: float32 },
    Rectangle { width: float32, height: float32 },
    Square { side: float32 },
    Empty,                                      // no-payload variant
}

enum Result<T, E> {
    Ok { value: T },
    Err { error: E },
}
```

- A variant has either **named fields in braces** (`Circle { radius: float32 }`) or **no payload** (`Empty`). No positional/tuple variants in 7.5 — matches the existing "structs have named fields" convention.
- Variant names are nominal; `Shape.Circle` is not assignment-compatible with `Foo.Circle` for an unrelated `enum Foo`.
- Generics use the same mechanism as `type T<...>` (Phase 7.1).

**Constructor syntax** uses dotted access on the enum name:

```yoop
let s: Shape = Shape.Circle { radius: 5.0 };
let e: Shape = Shape.Empty;
let r: Result<int32, string> = Result.Ok { value: 42 };
```

Rationale: Yooperlang already uses `.` for namespace-qualified access (imports, Phase 7.4 trait-qualified calls `Trait.method(...)`). Reusing `.` keeps the operator surface tight — no `::` introduced. Disambiguation is positional (the LHS of `.` is a *type*, not a value, so we can resolve at typecheck).

**Pattern matching** extends `switch` arms with variant patterns:

```yoop
switch (s) {
    case Shape.Circle { radius }: {
        // `radius: float32` bound in this arm
    }
    case Shape.Rectangle { width: w, height: h }: {
        // rename: `w`, `h` bound, not `width`/`height`
    }
    case Shape.Square { side: _ }: { /* ignore the field */ }
    case Shape.Empty: { /* no payload, no braces */ }
}
```

- Bindings introduced by a pattern are scoped to the arm body — they vanish at the arm's `}`.
- Wildcard `_` inside braces ignores a single field; field count must still match.
- Wildcard whole-pattern (`case _:`) is a synonym for `default:`. Parser canonicalizes to the same node as `default`.
- **Exhaustiveness** over a closed enum set: if every variant is covered by an arm, no `default` is required. If any variant is missing and no `default` is present, typecheck error: `"switch over Shape is not exhaustive — missing variant Empty"`.
- Underscore-bindings (`{ _ }` for the whole payload) — **not** in 7.5; explicitly name or `_` each field.

### 2. `union` — untagged overlapping memory

```yoop
type Channels {
    r: uint8,
    g: uint8,
    b: uint8,
    a: uint8,
}

union Color {
    rgba: uint32,
    channels: Channels,
}

let c: Color = { rgba: 0xFF8040FF };
let red   = c.channels.r;                      // bit-reinterpret read
c.channels.r = 0;                              // bit-reinterpret write
```

- **Layout**: every field starts at offset 0; size = `max(sizeof(field))`; alignment = `max(alignof(field))`.
- **No discriminator** — the compiler emits no tag, no bookkeeping. Reading a field that wasn't most-recently-written is *implementation-defined per LLVM rules* (the language doesn't promise type-punning correctness; on practical targets this works because LLVM lowers it to a bitcast load).
- **Construction** uses the existing struct-literal syntax (bare `{ ... }` pinned by the binding's type annotation), with exactly one field named: `let c: Color = { rgba: 0xFF8040FF };`. Compile error if zero or more-than-one field is named.
- **Field access** uses the same `.` syntax as structs. No pattern-match on union — there's no tag to discriminate against.
- **Generics on unions**: deferred. Real use cases all have concrete fields. Reject `union Foo<T> { ... }` at parse with `"generic unions not yet supported (deferred)"`.
- **Methods / `implements`**: deferred. A union can't implement a trait in 7.5; reject `union X implements Y` at parse.
- **`ref` to a union, `union` as struct field**: allowed. The Phase 5 ref-of-struct machinery generalizes naturally.

### 3. Error hardening (the integration story)

The SPEC's "error hardens" line gated pattern matching. The de-facto hardening is the body of work *already shipped* — Phase 2 `err: string`, `?`, Phase 6.4 `propagates`. 7.5 doesn't change the surface of fallible-by-convention. What 7.5 adds is **structural sum types**, which let users model typed errors when the `err: string` convention is too narrow:

```yoop
enum ParseError {
    Truncated,
    BadMagic { found: uint32, expected: uint32 },
    UnknownVersion { version: uint16 },
}

// Today (7.5): still write the fallible struct convention for `?`.
type ParseResult {
    value: int32,
    err: string,                               // err is a string, not the enum yet
}
```

A future phase can broaden `?` to recognize a fallible enum (a marker, a magic variant name like `Err`, or an explicit kind). For 7.5, **the existing `err: string` rule is unchanged**: `?` only operates on structs with a trailing `err: string` field. Users who want typed errors today destructure the enum with `switch`. Documented as the explicit follow-up.

---

## Sub-phase order

Each sub-phase is independently testable; land them in order.

### 7.5.0 — Lexer + AST contracts + 7.3 prerequisite

Confirms the 7.3 surface (literal `switch`) is in place before extending it. If 7.3 hasn't landed by start of 7.5, do these steps too — they're cheap and 7.3-equivalent.

- **Lexer keywords** ([src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js)):
  - Add to `TokenTags` and `keywordTagList`: `switch`, `case`, `default`, `enum`, `union`.
  - `match` is **not** added — `switch` stays the keyword. The spec says "pattern-matching"; we're naming the construct `switch` for consistency with the existing 7.3 plan.
  - Pure additive; no token-shape changes.
- **AST kinds** ([src/contracts.js](../src/contracts.js)) — add:
  - `SWITCH_STATEMENT { scrutinee, arms: [SwitchArm], defaultArm: Block | null }`
  - `SWITCH_ARM { patterns: [Pattern], body: Block }`
  - `ENUM_DECL { name, typeParams: [TypeParam], variants: [EnumVariant], exported: bool }`
  - `ENUM_VARIANT { name, fields: [FieldDecl] | null }` — `fields == null` for no-payload variants.
  - `UNION_DECL { name, fields: [FieldDecl], exported: bool }`
  - `VARIANT_CONSTRUCTOR { enumName, variantName, fields: [{ name, value }] }` — emitted from `Enum.Variant { ... }` expression form. (For `Enum.Variant` no-payload form, `fields == null`.)
  - `VARIANT_PATTERN { enumName, variantName, fieldBindings: [{ fieldName, bindingName, isWildcard }] | null, isWildcard: bool }` — `isWildcard:true` means bare `_`; `enumName`/`variantName` `null` plus `fieldBindings: null` plus `isWildcard:true` is the catch-all. `fieldBindings: null` (with names set) means no-payload variant. Per-field `isWildcard:true` ignores the field but keeps the count check.
  - `LITERAL_PATTERN { value }` — wraps an INT/CHAR/BOOL literal in arm-pattern position. Distinct from raw `INT_LITERAL` so the typechecker can see "this is a pattern, not an expression."
- **Top-level dispatch** ([src/jsyooparser/parser.js:493](../src/jsyooparser/parser.js#L493) `parseTopLevel`) — add cases for `enum` (→ `parseEnumDecl`) and `union` (→ `parseUnionDecl`).
- **Statement dispatch** (in `parseStatement` / `parseBlockStatement` — find via `parseBlock` callers) — add case for `switch` (→ `parseSwitchStatement`).
- **Tests**: lexer test asserts the five new keywords tokenize correctly; parser tests live in 7.5.1.

**Done when**: lexer recognizes the new keywords; the typechecker errors out with "switch/enum/union not yet wired" diagnostics. No semantic behavior yet.

### 7.5.1 — Parser for `enum`, `union`, `switch`, variant constructor, patterns

- **`parseEnumDecl()`** (new in [parser.js](../src/jsyooparser/parser.js)): `enum Name<TParams?> { Variant1 { fields }, Variant2, ... }`. Reuse `parseTypeParamList` (Phase 7.1) for generics. Each variant: an identifier, optionally followed by `{ field: Type, ... }`. Reject duplicate variant names with a clear diagnostic.
- **`parseUnionDecl()`**: `union Name { field: Type, ... }`. Reject `union Name<T> {...}` (generics deferred) and `union Name implements Trait {...}` (impls deferred) at parse with their deferral messages.
- **`parseSwitchStatement()`** (subsumes 7.3 plan §7.3.0): expect `switch`, `(`, expression, `)`, `{`. Loop parsing arms until `}`. Reject empty switch (zero arms, no default) at parse.
- **`parseSwitchArm()`**: expect `case`, then `parseSwitchPattern()` (one or comma-separated list — multi-pattern arms are allowed only for **homogeneous literal patterns**; mixing variant + literal in one arm is a parse error since the bindings wouldn't unify), then `:`, then a brace block.
  - `default:` is parsed into the switch node's `defaultArm` slot; reject duplicate `default`, and reject `default not last`.
  - `case _:` parses as `default` (canonicalized).
- **`parseSwitchPattern()`**: tries in order:
  1. Pure wildcard `_` → `VARIANT_PATTERN { isWildcard: true }` (caller catches and routes to `defaultArm`).
  2. Literal (`INT_LITERAL`, `FLOAT_LITERAL`(reject — no float patterns; clear diagnostic), `STRING_LITERAL`(reject), `BOOL_LITERAL`, char literal via string syntax) → `LITERAL_PATTERN`.
  3. `Identifier.Identifier` (optionally followed by `{ ... }`) → `VARIANT_PATTERN`. Inside `{}`: comma-separated entries, each `ident` (shorthand bind to same name), `ident : ident` (rename), `ident : _` (ignore), or `_` (ignore — at the field-list level, exactly the unnamed-wildcard form is allowed at the start). Reject `Identifier` alone in pattern position (could be a 0-arity variant of an in-scope enum, but the parser doesn't know what's in scope — punt to typechecker by requiring the `Type.Variant` dotted form everywhere).
- **`VARIANT_CONSTRUCTOR` parsing** — this is an expression, not a pattern. In expression position, the existing struct-literal lookahead handles `Foo { ... }` (Phase 1.3). For variants the LHS is `Foo.Bar`; route via the existing field-access infix parser, then look for a trailing `{`. If found, emit `VARIANT_CONSTRUCTOR { enumName: "Foo", variantName: "Bar", fields }`. If no trailing `{`, emit a bare `VARIANT_CONSTRUCTOR` with `fields: null` (no-payload variant) — the typechecker decides if that's valid. This avoids one extra token of lookahead in `peekAhead`.
- Tests in [parser.test.js](../src/jsyooparser/parser.test.js): AST-shape assertions for every form. Reject malformed: missing braces, duplicate variants, generic union, float literal pattern, etc.

**Done when**: every new surface form parses; typechecker errors with `"X not yet typechecked"` placeholders until 7.5.2.

### 7.5.2 — Typechecker for `enum` / `union` declarations

- **New `Type` constructors** in [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js):
  - `EnumType { name, variants: Map<variantName, { fields: [{name, type}] | null }>, moduleId, typeParams: [TypeParamType], genericInstance: null | {declId, args} }`.
  - `UnionType { name, fields: [{name, type}], moduleId, sizeBytes, alignBytes }` — `sizeBytes`/`alignBytes` computed at typecheck (max over fields).
  - Both go through `freezerWrap` like other immutable types.
- **`enumTable` / `unionTable`** per module (mirror `structTable`/`traitTable`). Pass A registers shells (variants list captured, field types still `null`); pass C resolves field types — same staged shape as struct field resolution.
- **Generic enums**: register in `genericEnumTable` (mirror `genericStructTable`). Add `instantiateEnum(registry, decl, argTypes)` to [src/jsyooptypecheck/instantiate.js](../src/jsyooptypecheck/instantiate.js) — same skeleton as `instantiateStruct`, substituting `TypeParamType`s in every variant's field types. Cache key `E:<declId>:<mangled-args>`. Add the `enum` branch to `substituteTypeParams` in [types.js:464](../src/jsyooptypecheck/types.js#L464).
- **Union fields**: typechecked once at decl; size/alignment are derived constants. Reject zero-field union (parse-level catches this too); reject field types `TaskType`, `RefType`, `KindType` (no `pooled` / `joined` in a union — kind interactions are out of scope for an untagged layout); reject self-referential `union Foo { x: Foo }` (would be infinite size — same logic as recursive struct detection in [recursiveStruct.js](../src/jsyooptypecheck/recursiveStruct.js)).
- **Variant constructor typechecking** ([src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js)): resolve `Enum.Variant` to the variant entry. Per-field type-check against the variant's declared field types (reuse `checkInitializer` — variants are struct-shaped). For no-payload variants, `fields: null` must match `fields: null` on the variant. Resolved type is the parent `EnumType`. Generic enums infer their type-args from the variant payload's field types (same call-site inference logic as generic functions in Phase 7.1) **only when the variant has at least one field constraining a type-param**; for `Result.Ok { value: 5 }` we can't determine `E`, so require an explicit type annotation on the target binding — error: `"cannot infer type parameter E of Result; annotate the target"`.
- **Union construction typechecking**: `Color { rgba: x }` resolves the LHS to `UnionType`, requires exactly one field named, checks its expression against the field type.
- **Field access on union**: same path as struct field access; resolves to the field's type. No "did you write the field" check; reading any field is always typed-OK.
- **`err: string`-fallibility interaction**: `EnumType` is **not** fallible (only struct-with-trailing-err is). A struct field whose type is an enum is fine. Document in [CLAUDE.md](../CLAUDE.md) cross-cutting invariants.

**Done when**: every enum/union form typechecks; switch arms with variant patterns still error (`"variant patterns not yet typechecked"`); construction expressions and field access work. Add typechecker unit tests in [src/jsyooptypecheck/typecheck.test.js](../src/jsyooptypecheck/typecheck.test.js).

### 7.5.3 — Pattern matching: variant patterns, exhaustiveness, scope flow

- **Pattern typecheck** in [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js):
  - `SWITCH_STATEMENT` dispatch (subsumes 7.3 plan §7.3.1): resolve scrutinee. For each arm:
    - If scrutinee is `int`/`bool`/`char` (the 7.3 cases): every arm pattern must be a `LITERAL_PATTERN` assignable to the scrutinee type. Reuse `coerceLiteralToType` from [coerce.js](../src/jsyooptypecheck/coerce.js).
    - If scrutinee is an `EnumType`: every arm pattern must be a `VARIANT_PATTERN` whose `enumName` resolves to the scrutinee's enum (after generic instantiation matches). Variant must exist on the enum. Field-binding list must match the variant's field list (same arity; field names must exist; rename targets become bindings introduced into the arm's scope with the corresponding field type).
    - Mixed `LITERAL_PATTERN`s on an `EnumType` scrutinee → error `"cannot use literal patterns on enum type X — use variant patterns"`.
    - `VARIANT_PATTERN`s on a non-enum scrutinee → error.
    - Other scrutinee types (struct, ref, array, …) → error `"switch scrutinee must be int, bool, char, or an enum type"`.
  - **Duplicate detection**: within one switch, two `case Shape.Circle:` arms is a typecheck error (same shape as the 7.3 duplicate-literal check). Two literal-pattern arms with the same value remain a typecheck error.
  - **Exhaustiveness on enums**: collect the set of covered variant names across all arms. If `coveredVariants == enum.variants.keys()`, exhaustive — no `default` required. If missing variants and no `default`, error: `"switch over Shape is not exhaustive — missing: Empty, Square"`. If `default` present, exhaustive trivially.
  - **Exhaustiveness on bool/int/char**: unchanged from 7.3 plan — bool requires both literals or default; int/char requires `default`.
  - **Variant-pattern binding scope**: each pattern's `fieldBindings` introduce names into a fresh scope pushed for the arm body. Conflicts with outer-scope names follow the usual shadowing rules. Bindings are `const` (cannot be reassigned inside the arm); rationale: pattern bindings are projections from the matched value, mutation would mislead.
- **`break` validity inside switch arms** (subsumes 7.3 §7.3.1): track "in switch" alongside "in loop" in the statement-context stack. `break` inside an arm exits the switch. `continue` inside an arm targets the enclosing loop (per the C-style rule).
- **Kind / fallible flow inside arms**: each arm body is a normal scope — Phase 2 `err`-observation and Phase 6 kind flow recurse naturally. A `disposable` binding declared inside an arm body must be cleaned up before that arm's `}`. Pattern bindings themselves are not kind-prefixed in 7.5; the variant's field type determines the binding's type, and any kind annotation on the field is currently rejected (no `kind`-on-field for variants in 7.5 — same posture as union fields).
- **Generic enum scrutinees**: if the scrutinee is an instantiated `Result<int32, string>`, the variant patterns work against the instantiated variants — payload field types are already concrete via 7.5.2's instantiation. No new substitution work here.
- **Trait-`TypeParamType` scrutinees**: reject — `"cannot switch on a type parameter T; constrain T with a bound or rewrite as if/else"`. Same posture as 7.3.

**Done when**: every typecheck rule above has a unit-test counterpart; pattern bindings are correctly typed; codegen still errors out with `"variant arm codegen not implemented"`.

### 7.5.4 — Codegen: tagged unions and variant patterns

Two-part: **enum layout** and **switch-on-enum lowering**.

- **Enum LLVM layout**:
  - For an enum with N variants, emit one LLVM struct per *concrete* enum type:
    ```llvm
    %ShapeEnum = type { i32, [P x i8] }    ; { tag, payload }
    ```
    - `i32` tag = variant ordinal (0-indexed; **stable from declaration order**, exported in IR comments for debuggability).
    - `[P x i8]` payload = byte array sized to the **largest variant**. P computed at typecheck (`max(sizeof(variant.fields-as-struct))`), alignment = max over variants. (Use the same `alignOfStruct` / `sizeOfStruct` codepath the struct emission uses; mirror in 7.5.4-test fixture.)
  - For payload-less variants, the payload slot is uninitialized — never read in well-typed programs because the typechecker refuses to introduce field bindings for them.
  - **Per-variant struct types** for the payload (`%Shape_Circle = type { float }`, `%Shape_Rectangle = type { float, float }`) are emitted alongside the enum struct so payload reads can bitcast to the right shape before GEP'ing fields.
- **Construction lowering** (`VARIANT_CONSTRUCTOR` in `emitExpr`):
  - `alloca %ShapeEnum`, store the tag into field-0, bitcast the payload pointer to `ptr %Shape_Circle`, GEP+store each field. Load the whole `%ShapeEnum` if the value is consumed by-value (assignment/return); leave the alloca if it's about to be referenced. Reuse the existing struct-literal emission path with the bitcast-on-payload twist; encapsulate the difference in a helper `emitEnumPayloadGep(enumName, variantName, allocaPtr) → ptr`.
- **`switch` on enum lowering** (`SWITCH_STATEMENT` in `emitStatement` when scrutinee is enum):
  - Load the tag (GEP field-0, load i32).
  - Emit an LLVM `switch i32 %tag, label %default [ i32 0, label %arm0 i32 1, label %arm1 ... ]`. Variant ordinal → arm label.
  - Per arm: emit field bindings as **alloca + store** of the payload-bitcast GEP results, so pattern bindings behave like regular `const` locals. (For an ABI-perfect lowering you'd avoid the alloca on read-only paths; profile-driven optimization is out of scope.)
  - Arm body emits normally; `br label %switch_end` at the close.
  - Default block: user `default` body if present, else just `br label %switch_end` (exhaustiveness guarantees only the missing-variant case reaches default, and exhaustive-no-default means default is unreachable — emit `unreachable` instead of `br`).
- **`switch` on literal scrutinee lowering** (subsumes 7.3 plan §7.3.2): unchanged from the 7.3 design — LLVM `switch` with literal case values; bool scrutinee uses `i1`.
- **Generic enums**: codegen walks the **instantiation registry** (same pattern as Phase 7.1 generic structs). For each concrete `EnumType` in the registry, emit the matching `%<mangled>` LLVM struct + per-variant payload structs. Mangling: `<moduleId>__<EnumName>__<arg1>__<arg2>...`, identical scheme to structs. `cloneAstWithSubstitution` ([codegen.js:1605](../src/jsyoopcodegen/codegen.js#L1605)) substitutes type params in `VARIANT_CONSTRUCTOR` / `VARIANT_PATTERN` nodes the same way it does for struct types.
- **Codegen-time invariant** ([CLAUDE.md](../CLAUDE.md)): every `VARIANT_CONSTRUCTOR` and `VARIANT_PATTERN` reaching codegen has its concrete enum + variant resolved (typechecker sets `resolvedEnumType` and `resolvedVariantOrdinal` on these nodes during 7.5.2 / 7.5.3). Codegen never re-resolves names — same trust contract as for struct field offsets.

**Done when**: the showcase enum program below compiles and runs and prints expected output.

### 7.5.5 — Codegen: untagged `union`

Simpler than enums; no tag.

- One LLVM struct per `UnionType`:
  ```llvm
  %Color = type { [4 x i8] }    ; align 4 (max over fields)
  ```
  - Use a byte array sized to `unionType.sizeBytes`. Set alignment via an LLVM `align` attribute on every alloca / GEP touching it.
- **Construction** (`Color { rgba: x }`): alloca, bitcast to the named field's type, store. Tagged as `VARIANT_CONSTRUCTOR`'s simpler cousin — emit via a new helper `emitUnionLiteral`.
- **Field access** (`c.channels.r`): bitcast the union pointer to the field's LLVM type, GEP/load through it. Field access composes with downstream struct-field GEPs naturally (e.g. for `c.channels.r`, the outer `.channels` lowers to a bitcast, then `.r` is a regular struct field GEP on the bitcast result).
- **Assignment to a union field** (`c.channels.r = 0`): same shape — bitcast, GEP, store.
- **Generic unions**: rejected at parse; codegen never sees one.
- **Recursive unions / cycle detection**: handled at typecheck.

**Done when**: the showcase union program below compiles and prints expected output (a byte-pattern read via two different field aliases).

### 7.5.6 — Fixtures, e2e, regression

- **Pass fixtures** under `examples/pass/`:
  - `switch_int.yoop`, `switch_multi_literal.yoop`, `switch_bool.yoop`, `switch_break.yoop`, `switch_in_loop_continue.yoop` (all from 7.3 plan §7.3.3).
  - `enum_basic.yoop` — declare a 4-variant enum with mixed payload/no-payload variants; switch on it exhaustively.
  - `enum_no_default_exhaustive.yoop` — all variants covered, no `default` needed.
  - `enum_default_catchall.yoop` — partial coverage with a `default`.
  - `enum_pattern_rename.yoop` — `case E.V { x: renamed }:`.
  - `enum_pattern_wildcard.yoop` — `case E.V { x: _, y }:`.
  - `enum_generic_result.yoop` — `enum Result<T, E> { Ok { value: T }, Err { error: E } }` instantiated at `<int32, string>`, switch-destructured.
  - `union_rgba.yoop` — the user's headline example: `union Color { rgba: uint32, channels: Channels }`, construct via one alias, read via the other.
  - `union_in_struct.yoop` — a struct field whose type is a union.
- **Fail fixtures** under `examples/fail/`:
  - `enum_duplicate_variant.yoop`
  - `enum_pattern_unknown_variant.yoop`
  - `enum_pattern_wrong_enum.yoop` — pattern names enum A; scrutinee is enum B.
  - `enum_pattern_field_mismatch.yoop` — pattern lists a field the variant doesn't have.
  - `enum_switch_non_exhaustive.yoop`
  - `enum_switch_literal_on_enum.yoop` — `case 5:` on an enum scrutinee.
  - `enum_constructor_missing_field.yoop`
  - `enum_constructor_wrong_payload_shape.yoop` — `Empty { x: 1 }` for a no-payload variant.
  - `union_zero_fields.yoop`
  - `union_multiple_active_fields.yoop` — `Color { rgba: 1, channels: c }` (more than one named in literal).
  - `union_recursive.yoop` — `union Foo { x: Foo }`.
  - `union_generic.yoop` — `union Foo<T> { ... }` rejected at parse.
  - `union_impl.yoop` — `union Foo implements Trait { ... }` rejected at parse.
  - `enum_switch_type_param_scrutinee.yoop` — `switch (x)` where `x: T` (T is a type-param).
- **E2E**: wire every fixture into [src/e2e.test.js](../src/e2e.test.js) following the existing pattern. Pass fixtures assert stdout-equals; fail fixtures assert a typecheck error fires and includes a token of the diagnostic.
- **Regression**: every existing pass fixture in `examples/pass/` compiles unchanged. Phase 4 `for_break_continue.yoop` still works (break/continue stack is now slightly more complex but additive).

---

## End-to-end showcase programs

### Tagged unions — `examples/pass/enum_showcase.yoop`

```yoop
extern "C" from "stdio.h" {
    function printf(fmt: string, ...): int32;
}

enum Shape {
    Circle { radius: float32 },
    Rectangle { width: float32, height: float32 },
    Square { side: float32 },
    Empty,
}

function describe(s: Shape): void {
    switch (s) {
        case Shape.Circle { radius }: {
            printf(`circle r=%.1f\n`, radius);
        }
        case Shape.Rectangle { width: w, height: h }: {
            printf(`rect %.1fx%.1f\n`, w, h);
        }
        case Shape.Square { side }: {
            printf(`square s=%.1f\n`, side);
        }
        case Shape.Empty: {
            printf(`empty\n`);
        }
    }
}

function main(): int32 {
    describe(Shape.Circle { radius: 2.5 });
    describe(Shape.Rectangle { width: 3.0, height: 4.0 });
    describe(Shape.Square { side: 5.0 });
    describe(Shape.Empty);
    return 0;
}
```

**Expected stdout** (asserted exactly):

```text
circle r=2.5
rect 3.0x4.0
square s=5.0
empty
```

### Untagged unions — `examples/pass/union_showcase.yoop`

```yoop
extern "C" from "stdio.h" {
    function printf(fmt: string, ...): int32;
}

type Channels {
    r: uint8,
    g: uint8,
    b: uint8,
    a: uint8,
}

union Color {
    rgba: uint32,
    channels: Channels,
}

function main(): int32 {
    let c: Color = Color { rgba: 0xAABBCCDD };
    // little-endian load: bytes in memory are DD CC BB AA, so:
    //   channels.r = 0xDD, .g = 0xCC, .b = 0xBB, .a = 0xAA
    printf(`r=%02x g=%02x b=%02x a=%02x\n`,
        uint32(c.channels.r),
        uint32(c.channels.g),
        uint32(c.channels.b),
        uint32(c.channels.a));
    c.channels.r = 0x11;
    printf(`rgba=%08x\n`, c.rgba);
    return 0;
}
```

**Expected stdout** (asserted exactly, on little-endian x86_64 / aarch64):

```text
r=dd g=cc b=bb a=aa
rgba=aabbcc11
```

(If we run on big-endian hardware, the byte order flips and the test harness skips. Yooperlang's existing CI is x86_64 / aarch64 only — both little-endian. Document this in [CLAUDE.md](../CLAUDE.md) — union codegen does not byte-swap.)

---

## Critical files

- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — `switch`, `case`, `default`, `enum`, `union` keywords (5 entries in `TokenTags` + `keywordTagList`).
- [src/contracts.js](../src/contracts.js) — six new `ASTNodeKind` entries (see 7.5.0).
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — `parseEnumDecl`, `parseUnionDecl`, `parseSwitchStatement`, `parseSwitchArm`, `parseSwitchPattern`. Hook into `parseTopLevel` and the statement dispatcher.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) — `EnumType`, `UnionType` constructors; extend `substituteTypeParams` for enum case; extend `typesEqual` to compare enums by `(declId, args)`.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) — pass A registers enum/union shells; pass C resolves variant field types and union layout.
- [src/jsyooptypecheck/instantiate.js](../src/jsyooptypecheck/instantiate.js) — `instantiateEnum` with the same shape as `instantiateStruct`.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) — variant-constructor expression resolution; union-literal resolution; field access on union types.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js) — `SWITCH_STATEMENT` dispatch with literal-and-variant pattern handling, exhaustiveness, scope flow for bindings, break/continue context.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — emit enum struct + per-variant payload structs from the instantiation registry; emit union struct; lower `VARIANT_CONSTRUCTOR`, union literal, `VARIANT_PATTERN`-bearing `SWITCH_STATEMENT`; extend `cloneAstWithSubstitution`.
- [CLAUDE.md](../CLAUDE.md) — add to cross-cutting invariants: (a) enum codegen reads `resolvedEnumType` + `resolvedVariantOrdinal` set by typecheck — same trust contract as struct field offsets; (b) untagged-union codegen assumes little-endian; (c) variant ordinal stability rule (declaration order).

## Verification

- **Unit**: AST shape, type-equality, substitution for `EnumType`, `instantiateEnum` cache hits, union size/alignment math, exhaustiveness algorithm (all-covered, partial-with-default, partial-without-default, default-only).
- **Parser tests**: every new surface form parses; every malformed form rejects with the expected diagnostic.
- **Typechecker tests**: pattern arity / field-name / unknown-variant errors point at the right source span.
- **E2E**: every pass fixture in 7.5.6 compiles via `clang` and prints expected stdout (asserted exactly). Every fail fixture errors at typecheck (not codegen) with a recognizable message token.
- **Regression**: full `npm test` green across the existing Phase 1–7.4 fixtures.

---

## Known limitations after 7.5

- **Reused pattern-binding names across arms collide at codegen.** A function with two `switch` arms that both write `case E.V { x }: { ... }` emits two `%x = alloca` instructions in the same LLVM function, which clang rejects. Workaround: rename one (e.g. `case E.V { x: xa }:`). This is the same bug as plain `let x` reused across disjoint blocks in the rest of the language — a pre-existing yooper limitation, not new in 7.5. Tracked as a separate item (alloca-name uniqueness).
- **Generic enums.** Parser accepts the syntax; typechecker rejects with `"generic enums are not yet supported (deferred)"`. Same shape as generic struct instantiation already in the registry — uplift when a real program needs it.
- **`pinStructLiteral` on union targets requires the typechecker to drive checkInitializer.** Bare `{ ... }` standalone (not pinned to a target) is still an error, matching the struct-literal rule. Use `let c: U = { field: value };`.
- **Variant ordinal stability.** Variant ordinals are 0-indexed by declaration order. Reordering an enum's variants is therefore an ABI-incompatible change. Documented in [CLAUDE.md](../CLAUDE.md) (to be added) once a real cross-module enum use case ships.

## Follow-ups (not in 7.5)

- **`?` over enum-shaped `Result<T, E>`.** Design space: a `provides Fallible` trait that an enum opts into? A magic-named `Err` variant? A kind annotation? Punt until a real program demands it. The existing `err: string` convention covers ~all error-handling needs; typed errors are nice-to-have, not load-bearing.
- **`Option<T>`-style sugar** — once an enum + generics combination is in use, library design picks up. Phase 8 stdlib territory.
- **`match` as expression.** Every arm must produce a value of the same type; arms cross-unify. Cleanest after at least one stdlib `Option<T>` use.
- **Range patterns / guards / `|` patterns / nested patterns.** All independent of sum-type representation. Land as small follow-ups when a fixture motivates one.
- **Anonymous tuple-style variant payloads.** `enum Coord { Cartesian(int32, int32), Polar(float32, float32) }`. Adds tuples to the language — too big a coupling for 7.5; revisit after named-payload variants are battle-tested.
- **Anonymous unions inside structs** (C-style `struct { int x; union { int i; float f; } u; }`). Useful for FFI of legacy C headers; deferred until a real `extern "C"` consumer needs it.
- **Untagged-union safety opt-in** (`import.unsafe;`). Reconsider if accidental bit-reinterpret reads turn out to be a common bug source.
- **Variant methods / `enum X implements Trait`.** A trait impl over an enum would dispatch by variant (closed-set virtual dispatch). Nice complement to the existing struct-impls; tracking as a future trait/kind interaction.
