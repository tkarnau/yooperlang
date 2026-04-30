# Phase 1.1 — Numeric literal generalization

Part of the [roadmap](./roadmap.md). This is the smallest piece of Phase 1: a lexer-and-parser-only change that gets numeric literals up to spec §2 before the typechecker is built. No typechecker work, no codegen changes beyond what's needed to keep existing programs working.

## Goal

Support every numeric literal form the spec lists in §2:

| Form | Examples |
|---|---|
| Decimal int | `0`, `42`, `1_000_000` |
| Hex int | `0xFF`, `0xDEAD_BEEF` |
| Binary int | `0b1010`, `0b1111_0000` |
| Octal int | `0o755` |
| Float | `1.0`, `3.14`, `1e-9`, `6.022e23` |
| Negative literals | `-7`, `-0.5` (folded from unary `-`) |

Per spec §2, literals are **untyped** until they reach a typed context. This phase doesn't enforce range-checking yet (that's the typechecker's job in Phase 1.2) — it just makes sure the lexer can recognize every form and the parser carries the value, kind (int vs float).

## Why this is first

It's the smallest, most isolated change that exercises real language design: untyped literals, suffixes, negative-literal folding. Doing it now means the typechecker (Phase 1.2) starts from clean inputs instead of needing to retrofit float/hex/etc. later.

## Scope (what this phase does NOT do)

- No range checking — `let x: uint8 = 256;` is not yet a compile error
- No literal coercion logic — that lives in the typechecker
- No new keywords
- No struct or extern work — that's Phase 1.3 and Phase 3

---

## Files touched

- [src/jsyooplexer/charFns.js](../src/jsyooplexer/charFns.js) — replace/augment `scanDigitsEnd` with richer numeric scanners
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — add `floatLiteral` tag, `floatVal` and `numSuffix` token fields, dispatch new scanners
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — read `floatLiteral`, fold unary minus into numeric literal nodes, attach `suffix` field when present
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — minor: handle `floatLiteral` AST node (emit as IR float constant). The bulk of float-codegen plumbing (fadd/fsub etc.) already exists; this just connects literal nodes to it.

No new files in this phase.

---

## Detailed changes

### 1. Lexer — character-level scanners ([charFns.js](../src/jsyooplexer/charFns.js))

Add three new scanner helpers and a small classifier. Keep existing `scanDigitsEnd` for now — other call sites may use it; we'll deprecate later if unused.

```
isHexDigit(ch)        // 0-9, a-f, A-F
isBinDigit(ch)        // 0, 1
isOctDigit(ch)        // 0-7

scanDecDigitsAndUnderscores(src, start)    // scans [0-9_]+, returns end pos
scanHexDigitsAndUnderscores(src, start)    // scans [0-9a-fA-F_]+
scanBinDigitsAndUnderscores(src, start)    // scans [01_]+
scanOctDigitsAndUnderscores(src, start)    // scans [0-7_]+
```

Underscore rules per spec §2 examples (`1_000_000`, `0xDEAD_BEEF`):
- `_` may appear between digits
- Leading `_` after a prefix is allowed by some languages but the spec doesn't show it — disallow for now (`0x_FF` is an error; `0xFF_FF` is fine). Keep this strict; we can loosen later.
- Trailing `_` (`1_000_`) is a syntax error.
- Two underscores in a row (`1__000`) is a syntax error.

These rules are easiest to enforce in the high-level numeric scanner (next section), not in the per-digit-class helpers. The helpers just consume `digit | _` greedily; the higher-level scanner validates structure.

### 2. Lexer — high-level numeric scanner ([lexer.js](../src/jsyooplexer/lexer.js))

Add a single function `lexNumericLiteral(src, pos)` that returns a `LexResult`. It owns all numeric scanning logic:

```
lexNumericLiteral(src, pos):
  start = pos
  isFloat = false
  base = 10
  digitsStart = pos

  if src[pos] == '0' and pos+1 < len:
    next = src[pos+1]
    if next == 'x' or 'X':
      base = 16; pos += 2; digitsStart = pos
      end = scanHexDigitsAndUnderscores(src, pos)
      // hex floats not supported (spec doesn't list them)
    elif next == 'b' or 'B':
      base = 2;  pos += 2; digitsStart = pos
      end = scanBinDigitsAndUnderscores(src, pos)
    elif next == 'o' or 'O':
      base = 8;  pos += 2; digitsStart = pos
      end = scanOctDigitsAndUnderscores(src, pos)
    else:
      // plain decimal starting with 0 — fall through to decimal
      end = scanDecDigitsAndUnderscores(src, pos)
  else:
    end = scanDecDigitsAndUnderscores(src, pos)

  // float fractional part — only legal in base 10
  if base == 10 and src[end] == '.' and isDigit(src[end+1]):
    isFloat = true
    end += 1
    end = scanDecDigitsAndUnderscores(src, end)

  // float exponent — only legal in base 10
  if base == 10 and (src[end] == 'e' or 'E'):
    isFloat = true
    end += 1
    if src[end] == '+' or '-': end += 1
    end = scanDecDigitsAndUnderscores(src, end)


  // parse the numeric value
  if isFloat:
    val = parseFloat(stripUnderscores(src.substring(digitsStart, end)))
    token.tag = floatLiteral
    token.floatVal = val
  else:
    val = parseInt(stripUnderscores(src.substring(digitsStart, end)), base)
    token.tag = intLiteral
    token.intVal = val

  if suffix: token.numSuffix = suffix
  token.start = start
  token.length = end - start
  res.nextPos = end
```

### 3. Lexer — token shape ([lexer.js](../src/jsyooplexer/lexer.js))

Update `Token`:
```js
function Token() {
  this.tag = 0;
  this.start = 0;
  this.length = 0;
  this.intVal = 0;
  this.floatVal = 0;       // new
  this.numSuffix = null;   // new — string like "i32", or null
}
```

Add to `TokenTags`:
```js
floatLiteral: 37,
```

Update `lexNext`: replace the `if (isDigit(ch))` branch with a call to `lexNumericLiteral`.

### 4. Parser — literal nodes and unary-minus folding ([parser.js](../src/jsyooparser/parser.js))

#### a) Read `floatLiteral`

In `parseExpression`, alongside the existing `intLiteral` branch:

```js
} else if (peek().tag === TokenTags.floatLiteral) {
  const tok = advance();
  node = new ASTNode("floatLiteral");
  node.value = tok.floatVal;
}
```

#### b) Unary-minus folding

Currently `-7` parses as a binary `0 - 7` accidentally — actually it doesn't, because there's no unary handling at all. `parseExpression` would fail or misbehave on a leading `-`. Add a unary-prefix branch at the top of `parseExpression`:

```js
if (peek().tag === TokenTags.minus) {
  advance(); // consume `-`
  const operand = parseExpression(/* high precedence */ 70);
  // fold unary minus over a numeric literal — produce a literal, not a unary expr
  if (operand.kind === "intLiteral" || operand.kind === "floatLiteral") {
    operand.value = -operand.value;
    return operand;
  }
  // for non-literal operands, build a unaryExpression node
  // (this also unblocks `-x` for variables — small bonus)
  node = new ASTNode("unaryExpression");
  node.op = "minus";
  node.operand = operand;
  return node;
}
```

Why fold: the spec says "negative literals are not valid for unsigned types" (§2). Folding makes `-1` a literal whose value is `-1`, which the typechecker can range-check. If we left it as `unaryMinus(intLiteral(1))`, the typechecker would have to do the folding itself — same logic, worse place.

The precedence number 70 is higher than `*`/`/` (60) so `-x * 2` parses as `(-x) * 2`, matching most languages.


### 5. Codegen — handle `floatLiteral` AST node ([codegen.js](../src/jsyoopcodegen/codegen.js))

Most float infrastructure already exists in codegen ([codegen.js:609-621](../src/jsyoopcodegen/codegen.js#L609-L621) for `fadd`/`fsub`/etc.). What's missing is generating an LLVM IR float constant from a `floatLiteral` AST node.

In whatever function dispatches on `node.kind` for expressions, add a `floatLiteral` branch that emits the value as an LLVM IR `double` or `float` constant. LLVM IR uses the form `0x` followed by the IEEE-754 hex bit pattern of the **double** representation, even for `float` constants (the constant gets truncated to 32-bit at use time when the operand type is `float`).

Helper:
```js
function llvmFloatConstant(jsNumber) {
  // LLVM IR float constants are written as the hex-encoded IEEE-754 double
  // bit pattern, regardless of whether the operand is float or double.
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(jsNumber, 0);
  return "0x" + buf.toString("hex").toUpperCase();
}
```

Without a typechecker yet, we don't know whether a literal should be `float` or `double` at the use site. For Phase 1.1, default to `double` when emitting in untyped contexts (matches spec's "untyped literals" — they pick up their type from context, but in this phase there's no context-pinning yet, so the safe default is `double`). The typechecker will revisit this in Phase 1.2.

For the `intLiteral` path, no codegen change is needed: hex/binary/octal literals are already parsed to JS numbers in the lexer, and codegen has always taken the JS number directly.

For literals with a `suffix`, Phase 1.1 ignores the suffix in codegen — the typechecker will use it, but for now codegen behaves as if no suffix was given. This is fine because the suffix only narrows the type; it doesn't change the bit pattern.

---

## Edge cases to handle (write tests for each)

| Input | Expected token / behavior |
|---|---|
| `0` | `intLiteral` value=0 |
| `42` | `intLiteral` value=42 |
| `-7` | `intLiteral` value=-7 (folded) |
| `1_000_000` | `intLiteral` value=1000000 |
| `0xFF` | `intLiteral` value=255 |
| `0xDEAD_BEEF` | `intLiteral` value=3735928559 |
| `0b1010` | `intLiteral` value=10 |
| `0o755` | `intLiteral` value=493 |
| `1.0` | `floatLiteral` value=1.0 |
| `3.14` | `floatLiteral` value=3.14 |
| `-0.5` | `floatLiteral` value=-0.5 (folded) |
| `1e-9` | `floatLiteral` value=1e-9 |
| `6.022e23` | `floatLiteral` value=6.022e23 |
| `1_000` then ident | `1000` followed by separate ident token |
| `0x_FF` | error — leading underscore |
| `1__000` | error — double underscore |
| `1_` | error — trailing underscore |
| `0x` | error — prefix with no digits |
| `42x` (no whitespace) | error — invalid suffix `x` |
| `1.` (trailing dot, no digits) | NOT a float — `1` followed by `.` (consistent with most C-style langs; this matters once `.` becomes field-access syntax in Phase 1.3) |

The "trailing dot is not a float" rule is important: it keeps `1.foo` working as field access on integer 1 (not legal but at least parses cleanly). The scanner already enforces this via the `isDigit(src[end+1])` check in the fractional-part branch.

---

## Verification

Existing programs must still produce identical output:
- `node ./src/yoopiler.js` (test mode) — hardcoded hello-world still compiles and prints
- [examples/test.yoop](../examples/test.yoop) — must still produce the same output

New programs that should compile and run:
```yoop
function main(): int32 {
  let a: int32 = 0xFF;
  let b: int32 = 0b1010;
  let c: int32 = 1_000_000;
  let d: int32 = -7;
  printf(`a=${a} b=${b} c=${c} d=${d}\n`);
  return 0;
}
```
Expected output: `a=255 b=10 c=1000000 d=-7`

Float test (will need codegen path verified):
```yoop
function main(): int32 {
  let x: float64 = 3.14;
  let y: float64 = -0.5;
  let z: float64 = 1e2;
  printf(`x=${x} y=${y} z=${z}\n`);
  return 0;
}
```
Expected output: `x=3.140000 y=-0.500000 z=100.000000` (or whatever the existing printf %lf format produces — verify against [codegen.js:44-58](../src/jsyoopcodegen/codegen.js#L44-L58)).

Negative tests (must produce a lex/parse error, NOT crash silently):
- `let x: int32 = 0x_FF;`
- `let x: int32 = 1__000;`
- `let x: int32 = 0x;`
- `let x: int32 = 42x;`

For now, errors can be `throw new Error(...)` from the lexer — Phase 1.2 introduces structured error collection.

---

## Out of scope (deferred to Phase 1.2 or later)

- Range checking (`let x: uint8 = 256;` → error)
- Literal type coercion based on annotation
- `int` and `float` as aliases for `int32` and `float32` (spec §14) — already in codegen's `canonicalize` table; typechecker will own this
- Hex floats (`0x1.0p10`) — not in spec
- Char literals (`'A'`, `'\n'`, `'\x41'`) — spec §2 covers these but they're a separate token class; deferring to a later sub-phase

---

## Critical files reference

- [SPEC.md §2](../SPEC.md) — primitives and literals (the source of truth for this phase)
- [src/jsyooplexer/charFns.js](../src/jsyooplexer/charFns.js) — character classifiers and scanners
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — tokens, dispatch, `lexNext`
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — expression parsing, `testParser` golden
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — float constant emission
