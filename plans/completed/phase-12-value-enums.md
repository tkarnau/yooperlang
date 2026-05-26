# Phase 12 - Value enums + sum-type rename to `variant`

> Phase number is a placeholder. This can land before or after Phase 11
> (comptime); the const-eval surface it needs is small and self-contained,
> so it does not depend on the bytecode interpreter. Rename to whatever
> slot it ends up in.

## Context

Phase 7.5 ([plans/completed/phase-7-5-sum-types-and-unions.md](completed/phase-7-5-sum-types-and-unions.md))
landed `enum` as a tagged sum type. Every variant is a distinct nominal
case, optionally carrying a named-field payload, and `switch` over an
enum is checked for exhaustiveness. That is genuinely useful for
`Result<T, E>`, `Option<T>`, `IterStep<T>`, and the pattern-matched
shapes throughout [std/](../std/).

It is not what most programmers mean when they say "enum". The
overwhelmingly common meaning - in C, C#, Swift's raw-valued enums,
TypeScript, Rust's C-like enums, Java - is *a named set of constants
of some underlying primitive type*. That construct is missing from
Yooperlang today. The user-facing pain point is the SDL demos: piles
of `const WINDOW_FULLSCREEN: int32 = 0x00000001;` floating beside the
struct definitions, no nominal grouping, no type-safety against passing
an unrelated `int32`, no `|` operator that preserves the flag type.

The proposal is to introduce **value enums** under the `enum` keyword
and **rename the existing tagged sum type to `variant`**. The two
constructs have different runtime shapes (tagged payload vs raw
primitive), different switch semantics (variants must be exhaustive
covering all named cases; value enums get exhaustiveness only when
their values are all literals), and different operator support
(variants have none; integer-backed value enums get `|`, `&`, `^`,
`~`, `<<`, `>>` returning the same enum type).

This is partly a naming alignment with user expectations and partly
unlocking the SDL-flag pattern as first-class. The internal AST kinds
`VARIANT_CONSTRUCTOR` and `VARIANT_PATTERN` already use the word
"variant", so the rename is consistent with how the codebase already
talks about these things.

## Goals

1. Rename `enum` (tagged sum) to `variant`. Mechanical sweep of std/,
   examples/, and src/. No semantic change.
2. Introduce a new `enum` keyword for value enums:
   - Default underlying type `int32`.
   - `enum Name<T> { ... }` where `T` is any integer primitive
     (`int8` through `int64`, `uint8` through `uint64`) or `string`.
     The `<T>` slot lives in the same position as a `variant`'s generic
     type-parameter list - value enums aren't generic, so the slot is
     reused for the underlying-primitive selector.
   - Variant body is a const expression evaluated at typecheck time:
     literals, prior-variant references, bitwise ops (`|`, `&`, `^`,
     `~`, `<<`, `>>`), parentheses. No arithmetic in v1.
   - For integer-backed enums, omitted values auto-increment from the
     prior variant (or 0 if first). Explicit values are required for
     string-backed enums and recommended for flag-style enums.
3. First-class operators on integer-backed value enums:
   `MyFlags.A | MyFlags.B` typechecks as `MyFlags`. Same for `&`, `^`,
   `~`, `<<`, `>>`. The programmer is expected to know `1 << 4`; we
   do not auto-generate flag values.
4. Equality and ordering: `==`, `!=` work for any value enum.
   `<`, `>`, `<=`, `>=` work for integer-backed enums only.
5. `switch` over a value enum: exhaustiveness checked when all variants
   are literal-valued (no operator-derived variants). When the enum has
   any operator-derived variant, the switch must include `default` -
   such an enum is "open" because users can construct unnamed values
   via the bitwise operators at use sites.
6. Codegen emits value enums as their underlying primitive. No tag,
   no payload struct, no allocation.

## Non-goals

- **Mixing payload variants and value variants in one declaration.**
  Parse error. If you need both, use a `variant`.
- **Auto-flag numbering.** No `flags` keyword, no `1 << index` magic.
  Programmer writes the bits.
- **Range/contains semantics for bitwise enums.** `value in MyFlags`
  is not a thing. Test bits explicitly with `&`.
- **Casting rules beyond what already exists.** Whatever cast syntax
  exists in Phase 8 between primitives applies between a value enum
  and its underlying primitive. No new implicit conversions.
- **`Display` auto-derivation for value enums.** v1 prints the
  underlying primitive value. A variant-name-aware `Display` impl is
  a follow-up.
- **Generic value enums.** A multi-arg slot like `enum X<int32, int64>`
  is rejected at parse time; the `<T>` slot on `enum` is reserved for
  underlying-type selection only. Generic sum types stay on `variant`
  (`variant Option<T> { ... }`).

## Naming: why `variant`

Considered alternatives and the reason against each:

- `sum` - precise but jargon-y; not in any of the languages users come
  from.
- `oneof` - protobuf-flavored; reads OK but feels wire-format-ish.
- `choice` - friendly but uncommon enough that readers will ask "what
  is this?".
- `data` - Haskell-y, does not match the C-family aesthetic of the
  rest of the language.
- `kind` - already taken by Phase 6 user-defined kinds.
- `case` - clashes with `switch` case labels visually.

`variant` wins for two reasons. First, the AST already uses
`VARIANT_CONSTRUCTOR` and `VARIANT_PATTERN` (Phase 7.5); the keyword
matching the AST term reduces concept count. Second, "variant" is the
established term in type theory for what a tagged sum case is, and it
reads cleanly: `variant Shape { Circle { radius: int32 }, ... }`.

## Grammar

### Variant (renamed from current enum)

Unchanged except for the keyword:

```yoop
variant Shape {
    Circle { radius: int32 },
    Rectangle { width: int32, height: int32 },
    Empty,
}

variant Result<T, E> {
    Ok { value: T },
    Err { error: E },
}
```

Constructor syntax (`Shape.Circle { radius: 5 }`), pattern syntax
(`case Shape.Circle { radius }: ...`), generics, exhaustiveness, and
the `?`-over-fallible-variant machinery (Phase 9.H) all carry over
without change.

### Value enum (new under `enum`)

```yoop
enum Color { Red, Green, Blue }                 // int32, auto 0/1/2

enum MyInt64Enum<int64> {
    MyVal 0,
    OtherVal 42,
}

enum SortDir<string> {
    Asc "ASCENDING",
    Desc "DESCENDING",
}

enum Flavors {                                  // int32
    Sweet 1,
    Sour 2,
    Bitter 4,
    Umami 8,
    SweetAndSour Sweet | Sour,                  // computed: 3
    Everything Sweet | Sour | Bitter | Umami,   // computed: 15
}
```

Production sketch:

```
EnumDecl       := "enum" Ident UnderlyingSlot? "{" EnumVariant ("," EnumVariant)* ","? "}"
UnderlyingSlot := "<" PrimitiveType ">"           ; int*/uint*/string only
EnumVariant    := Ident EnumValueExpr?
EnumValueExpr  := IntLiteral
                | StringLiteral
                | Ident                            ; reference prior variant
                | "(" EnumValueExpr ")"
                | "~" EnumValueExpr
                | EnumValueExpr ("|" | "&" | "^" | "<<" | ">>") EnumValueExpr
```

Notes on the grammar:

- The `<T>` slot is **not** a generic type parameter. It is a single
  primitive type selector that lives in the same source position as a
  `variant`'s generic params (`variant Foo<T>`), repurposed because
  value enums aren't generic. Multiple type args are a syntax error.
- The variant value expression has its own precedence: `~` binds
  tightest, then `<<`/`>>`, then `&`, then `^`, then `|`. Matches C.
- Trailing comma after the last variant is allowed (matches struct/
  variant grammar).
- Whitespace between the variant name and its value is required but
  there is no `=` sign. This keeps the grammar parallel to variant
  declarations (`Circle { radius: int32 }` is also no-equals).

### Auto-numbering rules

- For `enum Name` and `enum Name<intN>` / `enum Name<uintN>`:
  - First variant with no explicit value gets `0`.
  - Subsequent variants with no explicit value get `prior + 1`.
  - "Prior" follows declaration order regardless of whether the
    prior variant was explicit or auto-assigned.
- For `enum Name<string>`: every variant must have an explicit string
  literal. Auto-numbering does not apply. Diagnostic: "string-backed
  enum variant 'X' requires an explicit string value".

### Const-expr restrictions

- Integer underlying types accept: int literals (any base the lexer
  supports), identifier references to prior variants in the same
  enum, unary `~`, binary `|`, `&`, `^`, `<<`, `>>`, and parens.
- String underlying types accept: string literal only. No concat, no
  template literals. (Template literals expand at runtime in current
  Yooperlang; revisit if compile-time string concat lands with
  Phase 11.)
- An identifier in a variant body must resolve to a variant of the
  **same enum**, declared **strictly before** the current one.
  Forward references are an error: "variant 'X' refers to 'Y' which
  is declared later in the enum".
- Shift counts (`<<`, `>>`) must be non-negative and strictly less
  than the bit width of the underlying type. Out-of-range shift is a
  typecheck error.
- Overflow: integer literals and computed values that do not fit in
  the underlying type are a typecheck error. Signed vs unsigned
  follows the underlying type's range. No silent wrap.

## AST changes

New / renamed kinds in [src/contracts.js](../src/contracts.js):

- Rename `ENUM_DECL` -> `VARIANT_DECL`. Every reference in src/ flips
  with it.
- New `ENUM_DECL` (value enum). Shape:

  ```
  {
    kind: ENUM_DECL,
    name: string,
    underlying: TypeAnnotation,        // built by parser, defaults to int32
    variants: [{
        name: string,
        valueExpr: ASTNode | null,      // null means auto-numbered
        sourceLoc,
    }],
    isExported: boolean,
    sourceLoc,
  }
  ```

- `VARIANT_CONSTRUCTOR` and `VARIANT_PATTERN` stay (already
  well-named) but now have to disambiguate at typecheck time: an
  identifier on the LHS of `.Foo` could resolve to either a variant
  decl or a value-enum decl. The typechecker stamps either
  `resolvedVariantType` (sum) or `resolvedEnumType` (value) on the
  node so codegen can dispatch. Today `node.resolvedEnumType` is set
  for sum types; that field stays, semantics shift to "value enum".
  The sum-type field renames to `resolvedVariantType`. Mechanical.

No new expression kinds are needed. Bitwise operators on value enums
reuse the existing `BINARY_OP` / `UNARY_OP` nodes; the typechecker
just gates the type rule.

## Type system

### Types in [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js)

- Rename `EnumType` -> `VariantType`. Update every consumer.
- New `ValueEnumType`:

  ```
  {
    kind: "value_enum",
    name,
    moduleId,
    underlying: PrimType,                 // int32 / int64 / string / etc.
    variants: [{ name, value, ordinal }], // value is a JS number or string
    isOpen: boolean,                      // true if any variant has a non-
                                          // literal value expression
    decl,
  }
  ```

  Frozen after pass C.1. `isOpen` flips the exhaustiveness rule for
  switches against this type.

### Tables in module env

- Rename `enumTable` -> `variantTable`. Move it to alongside
  `structTable` / `unionTable`. Phase 7.5 already kept it as a sibling
  of those.
- New `enumTable` for value enums.

These are separate tables because the runtime shapes are different
and the type-resolver paths differ. Conflating them would require a
discriminator check at every lookup. Two tables, two lookups, no
ambiguity.

### Resolution

- `resolveTypeAnnotation` for a bare identifier checks structTable,
  variantTable, enumTable, unionTable, traitTable in order. Unknown
  identifier on miss is unchanged.
- `Foo.Bar` field access in expression position:
  - If `Foo` resolves to a variantType: existing variant-constructor
    promotion (see CLAUDE.md "Bare `EnumName.Variant`" note - that
    note now applies to the variant flavor).
  - If `Foo` resolves to a valueEnumType: new path. Result type is
    `Foo` (the value enum). The expression has a compile-time-known
    value attached via `node.resolvedValueEnumVariant = variant`.
- Pattern position (`case Foo.Bar`): same disambiguation. Patterns on
  value enums are literal-equality patterns. No field destructuring;
  if the user writes `case Foo.Bar { x }` against a value enum, error
  with "value enum variant 'Bar' has no fields".

### Const-evaluator for variant body

Lives in a new helper, probably
[src/jsyooptypecheck/constEvalEnum.js](../src/jsyooptypecheck/constEvalEnum.js).
Takes the variant's value expression AST and a `priorVariants: Map<string, number | string>`,
returns the computed value or pushes an error. Handles:

- `INTEGER_LITERAL` / `STRING_LITERAL` -> the literal value.
- `IDENTIFIER` -> looked up in `priorVariants`; error if not found.
- `BINARY_OP` with op in `|`, `&`, `^`, `<<`, `>>`: recurse both
  sides, apply, range-check against underlying type.
- `UNARY_OP` with `~`: recurse, bitwise-NOT against underlying type
  mask.
- Anything else: error "unsupported expression in enum variant value".

The evaluator runs in pass C.1 after the underlying type is resolved.
It uses JavaScript `BigInt` for any int64/uint64 enum to avoid
precision loss; smaller widths use regular `Number` plus a range
check. (Phase 11's comptime interpreter could replace this later, but
the scope here is small enough not to wait.)

### Operator typing on value enums

In [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js):

- `BINARY_OP` with op in `|`, `&`, `^`, `<<`, `>>` and both operands
  of the same integer-backed value-enum type: result type is that
  value enum.
- One operand value-enum, other operand the underlying primitive:
  reject. Force users to write `MyFlags.A | MyFlags.B`, not
  `MyFlags.A | 4`. Cast the int side first if needed.
- `UNARY_OP` `~` on an integer-backed value-enum operand: result is
  the same value enum.
- `==` and `!=` on two operands of the same value-enum type: bool
  result. Mixed-enum compare is a type error.
- `<`, `>`, `<=`, `>=` on two operands of the same integer-backed
  value-enum type: bool result. String-backed enums reject ordering.
- All shifts and bitwise ops on string-backed enums: rejected.

### Switch semantics

In [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js):

- Switch on a `VariantType`: existing exhaustiveness (Phase 7.5), no
  change beyond the rename.
- Switch on a `ValueEnumType`:
  - If `isOpen` (any computed variant): require a `default` case.
    Without one, error: "switch over open value enum 'MyFlags'
    requires a `default` case because variants like 'SweetAndSour'
    are computed from others".
  - If not open (every variant is a bare literal): allow exhaustive
    switch covering all variant names with no `default`, like today.
    A `default` is still allowed.
- Case patterns for a value enum: `Foo.Bar` (matches by value
  equality). No `{ field }` destructuring.

### Display in template literals (Phase 9.F interaction)

v1: integer-backed value enums in `${expr}` print as their underlying
integer. String-backed enums print the string literal value. Variant-
name-aware printing waits for a `Display`-style auto-derivation pass.

## Codegen

In [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js):

- Variant decls go through the existing tagged-sum codegen path with
  identifiers renamed. No semantic change.
- Value enum decls emit nothing at the top level. They are purely
  a typecheck-time concept; LLVM never sees them.
- `VARIANT_CONSTRUCTOR` against a value enum emits the constant value
  of the variant directly. For int-backed enums, that is the integer
  literal as the underlying LLVM type. For string-backed enums, emit
  the string the same way string literals are emitted today
  (deduplicated global pointer plus length).
- Bitwise binary ops on value-enum-typed operands: emit the
  corresponding LLVM op (`or`, `and`, `xor`, `shl`, `lshr` or `ashr`
  depending on signedness, plus `xor` with mask for `~`) at the
  underlying primitive width. Indistinguishable from emitting on the
  underlying int.
- Switch on a value-enum scrutinee: emit as if switching on the
  underlying primitive. Integer enums use the existing integer switch
  path. String enums use the existing string-equality cascade (a
  series of compares, like switching on a string literal today).
- Equality and ordering on value enums: same as the underlying
  primitive.

Critically: codegen never sees a `ValueEnumType` per se. Every
expression of value-enum type has a `resolvedType` whose `underlying`
field is the primitive. Codegen routes through `getLlvmTypeForResolved`
or the existing helper, which unwraps `ValueEnumType` to its
underlying and returns the LLVM type for that primitive. This mirrors
the way `TypeParamType` is never seen by codegen after
monomorphization.

## Migration

One sweep across the codebase. Decls only - call sites and patterns
are unaffected.

In std/ and examples/ (27 decls per `grep -rn '^export\? *enum'`):

- Every existing `enum Foo<...> { ... payload variants ... }` becomes
  `variant Foo<...> { ... }`.
- No usage-site changes. `Result.Ok { value: 5 }` and
  `case Result.Ok { value }:` keep working.

In src/ (~129 touchpoints per `grep -c 'ENUM_DECL\|enumTable\|EnumType'`):

- `ASTNodeKind.ENUM_DECL` -> `ASTNodeKind.VARIANT_DECL`.
- `EnumType` -> `VariantType`. `enumTable` -> `variantTable`.
- `resolvedEnumType` on variant constructor/pattern nodes ->
  `resolvedVariantType`.
- New `ASTNodeKind.ENUM_DECL` introduced (re-using the freed-up name).
- New `enumTable` introduced for value enums.

The order matters: do the rename first (a single mechanical commit,
should pass the full test suite with zero behavior change), then
introduce the new `enum` keyword and value-enum machinery in a
follow-up commit. This keeps the rename reviewable in isolation.

## Implementation steps

Numbered for ordering, not as a strict per-commit guide.

1. **Lexer.** Add `variant` as a keyword token (`TokenTags.variant`)
   in [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js). `enum`
   stays a keyword.
2. **Parser - rename.** In [src/jsyooparser/parser.js](../src/jsyooparser/parser.js),
   the existing `parseEnumDecl` becomes `parseVariantDecl` and
   triggers on the `variant` keyword. Builds `VARIANT_DECL` nodes.
   `ENUM_DECL` kind enum value is left in place but no parser path
   emits it yet.
3. **Typecheck / codegen - rename.** Bulk rename `EnumType` ->
   `VariantType`, `enumTable` -> `variantTable`, `resolvedEnumType`
   -> `resolvedVariantType` across [src/jsyooptypecheck/](../src/jsyooptypecheck/)
   and [src/jsyoopcodegen/](../src/jsyoopcodegen/). The
   `ASTNodeKind.ENUM_DECL` references all flip to `VARIANT_DECL`.
   Run the test suite green. **This is a commit-sized milestone.**
4. **Migrate std/ and examples/.** Rewrite the 27 `enum` decls to
   `variant`. Run the test suite green. **Second commit-sized
   milestone - the rename is complete.**
5. **Parser - value enum.** Add `parseEnumDecl` that triggers on the
   `enum` keyword (now free of the sum-type meaning). Parse the
   optional `<T>` slot, parse variant bodies with the const-expr
   sub-grammar. Build `ENUM_DECL` nodes.
6. **Typecheck - value enum decl.** Pass A registers the value-enum
   shell in `enumTable`. Pass C.1 resolves the underlying type,
   runs the const-evaluator on each variant, populates the variants
   list, and freezes the type. Set `isOpen` based on whether any
   variant value expression used an operator.
7. **Typecheck - value enum constructor and pattern.** Wire
   `resolveFieldAccess` to recognize value-enum identifiers on the
   LHS of `.Foo` and produce `VARIANT_CONSTRUCTOR` nodes with
   `resolvedValueEnumVariant` set. Reject `{ field }` payloads on
   value-enum patterns.
8. **Typecheck - operators.** Extend `BINARY_OP` / `UNARY_OP` type
   rules in checkExpr.js to handle value-enum operands per the
   "operator typing" section above.
9. **Typecheck - switch.** In checkStatement.js, add the value-enum
   branch: open enums require `default`, closed enums allow
   exhaustive coverage.
10. **Codegen.** Emit value-enum constructors as constants of the
    underlying type. Route bitwise/comparison ops through the
    existing primitive paths. Switch on value enums dispatches via
    the existing primitive-switch path.
11. **Tests.** Unit tests next to each touched file. End-to-end
    fixtures in [src/e2e.test.js](../src/e2e.test.js) (see "Test
    plan" below).
12. **Docs.** Update [CLAUDE.md](../CLAUDE.md) cross-cutting
    invariants section: the "Enum and union are nominal types"
    bullet splits into "Variants are nominal sum types" and
    "Value enums are primitive aliases with named cases". Update
    [SPEC.md](../SPEC.md) if it touches enums (likely §10).

## Test plan

Unit tests next to source. End-to-end fixtures in
[examples/pass/](../examples/pass/) and [examples/fail/](../examples/fail/).

Pass cases:

- `value_enum_basic.yoop` - default `int32` enum with auto-numbering;
  exhaustive switch over all variants.
- `value_enum_explicit_int.yoop` - `enum Name<int64>` with explicit
  values; mixed of explicit and auto-incremented.
- `value_enum_string.yoop` - `enum Name<string>` with explicit string
  values; switch with string-equality dispatch.
- `value_enum_flags.yoop` - SDL-style bit flags with `Sweet 1, Sour
  2, SweetAndSour Sweet | Sour`; combination and bit-test at use
  sites; switch with `default`.
- `value_enum_operators.yoop` - covers `|`, `&`, `^`, `~`, `<<`,
  `>>`, `==`, `!=`, `<` for int-backed enum.
- `variant_unchanged.yoop` - copy of `enum_showcase.yoop` renamed to
  use `variant`; proves no behavior change.

Fail cases:

- `value_enum_mixed_shapes.yoop` - one variant with `Foo 1`, one
  with `Bar { x: int32 }`. Expect parse error.
- `value_enum_forward_ref.yoop` - `A B | C, B 1, C 2`. Expect error
  on `A` referring to forward variants.
- `value_enum_string_no_value.yoop` - `enum Bad<string>` with a bare
  variant name. Expect error.
- `value_enum_open_switch_no_default.yoop` - switch over flags enum
  without `default`. Expect error.
- `value_enum_shift_oob.yoop` - `enum X<int32> { A 1 << 33 }`.
  Expect error.
- `value_enum_overflow.yoop` - `enum X<int8> { A 256 }`. Expect
  error.
- `value_enum_unrelated_compare.yoop` - `Color.Red == Flavor.Sweet`.
  Expect type error.

Migration validation:

- Full test suite green after step 3 (rename complete, value enums
  not yet added). Same green state after step 4.
- At least one pass test that imports `std/core/types.yoop` and uses
  `Result<T, E>` after the migration to confirm `variant` works
  through generics.

## Open questions

- **Are negative integer literals in variant bodies allowed?**
  - **ANSWER**: yes

  `enum X<int32> { A -1 }` is natural and arguably needed for some
  C-API mirrors. The const-evaluator can handle it by accepting a
  leading `-` in the literal grammar (which the parser already does
  for normal int literals). Default: yes, allow.
- **Should the `<T>` slot accept `bool` or `char`?** v1: no. Both
  are niche and would need extra encode rules. Defer.
- **`Display` derivation.** The naive int-print is fine for SDL
  flags but lousy for `enum Day<int32> { Mon, Tue, ... }`. Punt to a
  follow-up phase that builds an auto-derivation pass on top of the
  `Display` trait (Phase 9.F).
- **Should the rename land separately from the value-enum work?**
  Strongly yes. Step 3 + step 4 together are a no-behavior-change
  commit. Step 5 onward is the new feature. Reviewer effort drops.
- **Trait impls on value enums.** Can `impl Display for MyFlags { ... }`
  work? In principle yes - `MyFlags` is a nominal type. Likely
  unblocked by existing impl-block machinery; verify and either
  enable or explicitly defer in a follow-up note.
- **Generic value enums?** Listed as out-of-scope above. If a user
  actually wants something parameterized like `ResultCode<E>` they
  can use `variant` instead. Reconsider only if a real use case
  surfaces.

## Why this is worth doing now

Two concrete wins:

1. **SDL demo code shrinks.** The flag bitmasks currently live as
   loose `const X: int32 = ...;` declarations. Replacing them with
   one value enum per flag group (`WindowFlags`, `RendererFlags`,
   `EventType`) gives nominal typing, prevents argument-order
   mixups, and lets the API surface read like the C original.
2. **`enum` matches user mental models.** Every programmer coming
   from C, C#, TypeScript, Swift, or Java tries to write a value
   enum first. Today they bounce off our sum-type-only enum,
   re-read the spec, and end up writing constants. After this
   phase, `enum Color { Red, Green, Blue }` does the obvious thing
   and the more-powerful `variant` keyword signals "yes, this is
   different".

The rename is the bigger ergonomic shift; the value-enum machinery
is the bigger code-volume payoff in the demos.
