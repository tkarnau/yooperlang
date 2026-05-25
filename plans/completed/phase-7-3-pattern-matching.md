# Phase 7.3 - Pattern matching and `switch`

## Context

Spec §10 line 713 explicitly says: *"No `switch` in v2. Pattern-matching on tagged unions is a future addition once the error story hardens."* The error story has hardened (Phase 2 + `?` + the `propagates` work in 6.4), generics have landed (Phase 7.1), and trait bounds will arrive in 7.2. The conditions the spec gated `switch` on are now true - so this phase lifts the deferral.

[phase-7-1-generics.md](phase-7-1-generics.md) (the "Follow-ups" section) sketches the rough split: *"a minimal `switch` over int/char/bool with literal patterns + default could land independently if a real program needs it; the full match-on-sum-type design waits on spec §10."* This plan keeps that split. **7.3 is the literal-only `switch`.** Sum-type destructuring stays deferred until v2 picks up tagged unions (the spec doesn't define them yet - see §11 for the rationale; `err` is the only sum-type-shaped construct, and it's intentionally not a discriminated union).

**Scope.**

- `switch` over an int/char/bool expression.
- Patterns: literal int/char/bool, and `default` (exactly one allowed). No range patterns, no `|`-or patterns, no guards, no destructuring.
- `break` inside a `switch` arm means "fall out of the switch" (matches C and the user's existing `break` keyword from Phase 4). No implicit fall-through between arms - each arm is its own scoped block, control unconditionally exits the `switch` at the closing `}`.
- `switch` is a **statement**, not an expression. Spec consistency: `if` is also statement-only today.
- The fallible/`err` story does **not** change. `switch` does not interact with `?`.

**Non-goals** (revisit when sum types land):

- Tagged unions (`type Result<T,E> = Ok(T) | Err(E)`).
- Destructuring patterns (`case Some(x):`).
- Exhaustiveness checking beyond "needs a `default` if not all literal cases are covered" - there's no closed enum to be exhaustive against.
- `match` as expression.

The scope is deliberately small so this phase is a couple of days of work and frees up the language for "select on an int tag" use cases (state machines, opcode dispatch, parser tables) that are awkward to write today with chained `if/else if`.

---

## Sub-phase order

### 7.3.0 - Lexer + parser

- Add `switch`, `case`, `default` to the keyword list ([lexer.js](../src/jsyooplexer/lexer.js)). `break` already exists (Phase 4). Single-token keywords; no new punctuation.
- New AST kinds in [contracts.js](../src/contracts.js): `SWITCH_STATEMENT { scrutinee: Expr, arms: [SwitchArm], defaultArm: Block | null }`, `SWITCH_ARM { patterns: [Literal], body: Block }`. Both go through `buildSourcedNode` so `sourceLoc` is set.
- Surface syntax:

  ```js
  switch (expr) {
      case 1: { ... }
      case 2: { ... }
      case 'x': { ... }
      default: { ... }
  }
  ```

  Arms can list multiple literals before the `:` separated by `,` (cheap to add; useful enough). Body is always a brace block - no single-statement arms. Matches the rest of the language's "always braces" convention.

- Parsing rules in [parser.js](../src/jsyooparser/parser.js):
  - `parseSwitchStatement()`: expect `switch`, `(`, expression, `)`, `{`. Then loop parsing `case` / `default` arms until `}`.
  - `parseSwitchArm()`: expect `case`, parse comma-separated literal list, expect `:`, parse a brace block. `default` is a `defaultArm` field on the switch node - not a regular arm. Reject duplicate `default` at parse time with a clear diagnostic ("only one default clause allowed").
  - Reject arms after `default` if you want (matches what most readers expect); allowing them is also fine - pick "default must be last" and enforce it. The diagnostic is `"default must be the last clause in a switch"`.
  - Literals in `case` arms must be `INT_LITERAL`, `STRING_LITERAL` with single-char content (the spec lexes `'x'` as a string today - confirm; if not, add a `CHAR_LITERAL` token), or `BOOL_LITERAL`. No other expressions. Anything else: parse-time error.
- Hook `parseSwitchStatement` into the statement dispatcher in `parseStatement` ([parser.js](../src/jsyooparser/parser.js)) at the same level as `if`/`while`/`for`.
- Tests in [parser.test.js](../src/jsyooparser/parser.test.js): assert AST shape for the canonical `switch (n) { case 1: { ... } case 2, 3: { ... } default: { ... } }`. Reject: missing parens, missing braces, duplicate default, default not last, non-literal in case, empty switch (zero arms, no default - parser-error or typecheck-error, pick parse-error for clarity).

**Done when:** parser produces a `SWITCH_STATEMENT` AST; existing test suite still green; typechecker errors with "switch not yet wired into typecheck" until 7.3.1.

### 7.3.1 - Typechecker

- New dispatch case in [checkStatement.js](../src/jsyooptypecheck/checkStatement.js) for `SWITCH_STATEMENT`:
  1. Resolve the scrutinee expression's type. Require it to be one of: integer prim (any width), `bool`, or `char`. Anything else: error `"switch scrutinee must be int, bool, or char; got <type>"`.
  2. For each arm: every literal in the arm's `patterns` list must be assignable to the scrutinee type (reuse `coerceLiteralToType` from [coerce.js](../src/jsyooptypecheck/coerce.js) - untyped int literals get pinned to the scrutinee's prim type, range-checked at the same site). Set `resolvedType` on each literal node.
  3. Check duplicate literal values across all arms. Two `case 1:` arms is a typecheck error. For bool: at most two arms (`true` / `false`).
  4. Push a new scope for each arm's body block and typecheck statements (existing block typechecking handles scoping, `break` validity, kind flow).
  5. **Exhaustiveness**: if there's no `default`, require all possible values to be covered. For `bool`, both arms must exist. For small int types (`int8`/`uint8`/`char`) where the user *could* enumerate exhaustively, we still **don't** require it - just require `default`. Rationale: even with `uint8`, listing 256 cases is absurd. Always-require-default-when-no-`default`-covers-all is the simplest rule; revisit if it's annoying. Error: `"switch is not exhaustive - add a default clause"`.
  6. `break` inside a `switch` arm must be allowed even when the `switch` isn't inside a loop. Update the `break`-validity logic in [checkStatement.js](../src/jsyooptypecheck/checkStatement.js) - track "in switch" alongside "in loop". `continue` inside a `switch` arm targets the enclosing loop (if any), as in C - implement that explicitly so `for (...) { switch (...) { case x: continue; } }` works.
- The scrutinee may be a `TypeParamType` if `switch` is used inside a generic body - reject for 7.3 with `"cannot switch on a type parameter; constrain T or rewrite as if/else"`. Trait bounds (7.2) might lift this later if a `Discriminable` trait shows up; ignore for 7.3.
- Errors push through `pushError` ([errors.js](../src/jsyooptypecheck/errors.js)), not throws.
- Kind flow: `switch` arms are scopes - `mustCall` obligations from a `disposable` binding inside one arm must be satisfied within that arm (or escape through `?` or return), same as `if`/`while` arms. The existing `kindCheck.js` recursion on block bodies handles this naturally; verify with a fixture.
- Fallible interaction: an arm body that returns a fallible value still has to observe `err` (or strip via `?`, or `discard`) - Phase 2 rules apply unchanged inside arm bodies.

**Done when:** every typecheck rule above has a unit or fixture-driven test; codegen still errors with "SWITCH_STATEMENT not implemented".

### 7.3.2 - Codegen

LLVM has a first-class `switch` instruction; use it directly.

- New dispatch case in `emitStatement` ([codegen.js](../src/jsyoopcodegen/codegen.js)) for `SWITCH_STATEMENT`:
  - Emit the scrutinee expression into a temp.
  - Generate a unique label per arm + an `end` label.
  - Emit `switch <intty> %scrut, label %defaultBlock [ <intty> 1, label %arm1 <intty> 2, label %arm2 ... ]`. For multi-literal arms (`case 1, 2: { ... }`), the LLVM switch supports listing multiple labels pointing at the same block - emit one entry per literal value.
  - Each arm block: emit the body's statements, then unconditional `br label %end`. (No implicit fall-through to the next arm.)
  - Default block: if the user wrote `default`, emit its body, then `br label %end`. If no default (exhaustiveness for `bool` is satisfied without one), still emit a default label pointing at `%end` - LLVM requires one.
  - `break` inside an arm: branch to `%end`. The existing `break`-target stack in codegen needs to push the switch's end label when emitting the switch body and pop after. Mirror the existing loop `break` handling.
  - `continue` inside an arm targets the enclosing loop's continue label - leave the existing loop continue target on the stack; only `break` gets a fresh switch-end target.
- Bool scrutinee: LLVM's `i1`-typed `switch` is legal with two case values (`i1 0` and `i1 1`) - emit as such; no special-case needed.
- Char scrutinee: chars are `i8` (or whatever the lexer/codegen settled on); emit as a normal small-int switch.

**Done when:** the showcase program below compiles and runs.

### 7.3.3 - Fixtures + regression

- E2E in `examples/pass/`:
  - `switch_int.yoop` - basic int switch with default.
  - `switch_multi_literal.yoop` - `case 1, 2, 3:`.
  - `switch_bool.yoop` - exhaustive over `true`/`false`, no default required.
  - `switch_break.yoop` - `break` inside an arm exits the switch but not the enclosing loop.
  - `switch_in_loop_continue.yoop` - `continue` inside an arm targets the for-loop.
  - `switch_disposable.yoop` - a `disposable` binding declared inside an arm body is cleaned up before the arm exits.
- Fail in `examples/fail/`:
  - `switch_non_int_scrutinee.yoop` - `switch (some_struct)`.
  - `switch_duplicate_case.yoop` - two `case 1:`.
  - `switch_no_default.yoop` - int scrutinee, no default.
  - `switch_default_not_last.yoop`.
  - `switch_non_literal_case.yoop` - `case x:` where `x` is a variable.

**Done when:** all fixtures pass via `npm test`; the e2e suite includes them following the existing pattern in [src/e2e.test.js](../src/e2e.test.js).

---

## End-to-end showcase program

Land as **`examples/pass/switch_overview.yoop`** and wire into [src/e2e.test.js](../src/e2e.test.js). Exercises int switching, multi-literal arms, default, and `break`/`continue` interaction with an enclosing loop.

```yoop
function classify(n: int32): int32 {
    switch (n) {
        case 0: { return 0; }
        case 1, 2, 3: { return 1; }
        case 10: { return 10; }
        default: { return -1; }
    }
}

function main(): int32 {
    let sum: int32 = 0;
    for (let i: int32 = 0; i < 5; i = i + 1) {
        switch (i) {
            case 0: { continue; }            // skip to next iter
            case 4: { break; }                // exits switch only, loop continues
            default: { sum = sum + i; }
        }
        sum = sum + 100;
    }
    printf(`classify(0)=${classify(0)} classify(2)=${classify(2)} classify(10)=${classify(10)} classify(99)=${classify(99)}\n`);
    printf(`sum=${sum}\n`);
    return 0;
}
```

**Expected stdout** (asserted exactly):

```text
classify(0)=0 classify(2)=1 classify(10)=10 classify(99)=-1
sum=406
```

(`sum` walk: i=0 → continue (no +100); i=1 → default adds 1, then +100 → 101; i=2 → +2+100 → 203; i=3 → +3+100 → 306; i=4 → break out of switch, then +100 → 406.)

---

## Critical files

- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) - `switch`, `case`, `default` keywords.
- [src/contracts.js](../src/contracts.js) - `SWITCH_STATEMENT`, `SWITCH_ARM` AST kinds.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) - `parseSwitchStatement`, hook into `parseStatement`.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js) - `SWITCH_STATEMENT` dispatch; scrutinee type check; duplicate-literal + exhaustiveness checks; `break`/`continue` target tracking through switches.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) - `SWITCH_STATEMENT` emission as LLVM `switch`; break-target stack update.

## Verification

- **Unit**: parser AST-shape assertions for every form; typecheck unit tests for scrutinee type rules, duplicate detection, exhaustiveness, `break`/`continue` semantics under switch.
- **E2E** in [src/e2e.test.js](../src/e2e.test.js) with fixtures listed in 7.3.3 plus `switch_overview.yoop`.
- **Regression**: every existing pass fixture in `examples/pass/` still compiles unchanged. `break`/`continue` regression: the existing Phase 4 `for_break_continue.yoop` still works.
- **Fail cases** all produce typecheck (not codegen) errors with source locations.

## Follow-ups (not in 7.3)

- **`switch` over a string scrutinee** - needs a string-equality lowering (sequence of `if/else` or a hash table). Easy add when needed; skipped here because no current program needs it.
- **Tagged unions + destructuring** - the real spec §10 work. Requires a sum-type representation choice (discriminator + payload union; spec doesn't define one yet). Land when the `Result<T,E>` / `Option<T>` story is real, not before.
- **Guards** (`case x if cond:`) - small addition once destructuring exists; not useful for literal-only switches.
- **`match` as expression** - every arm must produce a value of the same type; uses substitution to unify arms. Cleanest after sum types.
- **Range patterns** (`case 1..10:`) - independent of sum types. Could land as a tiny follow-up if a use case appears.
