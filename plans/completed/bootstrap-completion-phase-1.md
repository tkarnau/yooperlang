# Bootstrap completion - phase 1, the cheap parser gaps

Landed. Extracted from [../bootstrap-completion.md](../bootstrap-completion.md)
to keep the live plan readable. Items 1.0 through 1.8.

## Phase 1 - the cheap parser gaps

Small, independent, and between them they unblock most of the tree. Each is a
parse-level gap with a named refusal today, so each is "make it parse, then make
it mean something".

**1.0 A borrow held as a VALUE - DONE 2026-08-13, 97 files, 1 site.** Not in the
original plan; it was the critical path 1.6 left behind, at
`bootstrap/src/diagnostics/parse_error.yoop:35` - `.len` on a local bound from a
`ref uint8[]` FIELD, refused with "field access on ref uint8[] is not supported
by the bootstrap typechecker yet".

The brief guessed it was a missing deref rather than a feature, and that was
half right. The rule is the one bootstrap/README.md already states for a
PARAMETER - "a `ref T` is `ref T` in the signature and `T` in the body" - moved
one layer out, and the reason it needed saying twice is that a parameter is
unwrapped ONCE at its declaration while a FIELD keeps its `ref T` type for as
long as anything holds it. `Cx` in `codegen/context.yoop` is seven `ref` fields
and nothing else, so this is not an edge case in the bootstrap's own source; it
is most of how codegen is written.

What the reference actually does, established by compiling probe programs rather
than by reading its source:

  - a `ref T` LOCAL bound from a `ref T` field reaches `.len`, indexing and
    fields exactly as a plain `T` does, and passing it to a BY-VALUE parameter
    inserts a real load (`%t14 = load %yoop_array.uint8, ptr %t13`).
  - it is a real reference, not a copy: `let pr = hp.p; pr.x = 42;` where
    `p: ref Point` changes the ORIGINAL. So stripping the `ref` at the binding
    would have been a silent miscompile, which is what makes the deref belong
    at the USE.
  - `ref x` WRITTEN OUT never opens itself. `takes(ref n)` against
    `takes(n: int32)` is "cannot pass ref int32 to int32" there, even though a
    borrow that ARRIVED as a value in the same slot is accepted. That
    asymmetry is the reason the conversion is keyed on the expression's KIND as
    well as its type: the whole point of writing `ref` is that the call site
    shows what may be written through.
  - a plain `T` in a `ref T` field slot is refused ("cannot assign struct P to
    field p of type ref struct P").

Two DIVERGENCES, both where the reference is wrong rather than stricter:

  - `h.src.len` DIRECTLY - a field access whose base is a `ref T` field read
    rather than a local bound from one - makes the reference emit invalid IR
    ("invalid getelementptr indices"), and `byVal(h.src)` is a typecheck error
    there while `byVal(srcRef)` is fine. The bootstrap accepts both, because
    the rule is about the TYPE and not about how the value was spelled. That is
    a superset, so a program written for the reference still compiles; a
    fixture asserted against both has to stay inside the intersection, which is
    why `ref_fields.yoop` binds a local first.

Where the machinery went, and it is two mechanisms on purpose because there are
two questions:

  - a field or index BASE derefs STRUCTURALLY, in codegen, because a READ wants
    the value and a WRITE wants the address and only codegen knows which. A
    borrowed base is CHEAPER than a slot base for a write - the operand already
    IS the address, so there is no gep on a slot at all.
  - everything else derefs because the CONTEXT wanted a `T`, which only pass D
    can answer. `openBorrowIfWanted` runs at the one place `checkExpr` records
    a node's type, so it covers arguments, initializers, assignments, returned
    values, array elements and struct-literal fields together, and it records
    the node in `tm.derefUses` so codegen emits exactly one load in exactly one
    place (the `emitExpr` wrapper).

**1.1 `...` variadic in an extern signature - DONE 2026-08-13, 169 files.**
`function printf(fmt: string, ...): int32;`. The single highest-leverage item in
the whole plan: nearly every example declares its own `printf` extern, so this
one token blocked 169 of 401 files (the plan said 168; the extra one appeared
between measurements). 44 of them now compile to an executable and the other 125
advanced to a later blocker. `Type.Func` already had the `variadic` field and
codegen already promoted varargs at a printf CALL.

What the reference actually does, established by compiling probe programs rather
than by reading its source:

  - `...` parses ONLY inside an `extern` block. An ordinary function, a trait
    method and a function TYPE annotation all report "expected ident, got
    dotdotdot".
  - It must be immediately before the `)`. A following parameter, a trailing
    comma and a second `...` are all "expected rparen, got comma".
  - It may be the ONLY parameter. `function weird(...): int32;` typechecks and
    emits `declare i32 @weird(...)`.
  - Zero variadic arguments at a call is fine, and is the common case.
  - The FIXED parameters are checked. `printf(7, 8)` against a declared
    `printf(fmt: string, ...)` is "cannot pass untyped int to string".
  - `printf` is a compiler BUILTIN with no checking at all when nothing declares
    it, and a declaration WINS: declaring a non-variadic `printf` there makes
    `printf("a %d\n", 3)` an arity error.

Three places the bootstrap deliberately does better, each because the reference
mis-compiles rather than refuses:

  - Too FEW arguments to a variadic callee is refused by name (`"myvar" takes at
    least 2 argument(s), got 1`). The reference passes it through typecheck and
    emits a call clang rejects as "not enough parameters specified for call".
  - Two modules each declaring `extern printf` collapse to one `declare`. The
    reference emits both, and clang rejects the second as an invalid
    redefinition. This is 2.1's collision from the other direction, and the same
    dedupe is what 2.1 needs.
  - Promotion applies to EVERY variadic callee, not just printf. The reference
    promotes only at a printf call, so an `int8` handed to a declared `snprintf`
    there is passed as `i8` and the callee reads the rest of the slot.

Not implemented, and refused by name: `...` on an `extern "intrinsic"`
signature, and `...` on a generic one. Both would record a calling convention
with no call site to apply it to, and a variadic intrinsic would compile and
then silently drop everything past the fixed parameters.

One trap found while writing the slice fixture, worth knowing before writing
another: a string LITERAL handed straight to `printf` as a vararg
(`printf("%s\n", "seven")`) makes the JS reference print it a SECOND time, out
of order. A string held in a binding is fine, which is why the existing fixtures
that use `%s` pass parity. The bug is in the reference's printf special case
(`emitPrintfCallInner`); the bootstrap has no such case and is correct. Keep
literals out of a fixture's varargs until it is fixed.

**1.2 Value `enum` - DONE 2026-08-13, 90 files.** `export enum Severity { ERROR,
WARNING }`, `enum ASTNodeKind implements Display { ... }`. It was the largest
single item left - 83 files stopped at the exported form and 7 more at the bare
one - and it gated `diagnostics`, `lex`, `ast` and `typecheck` in the
bootstrap's own source. None of the 408 files stops at an ENUM token now. Only 4
of the 90 went all the way, though: 87 landed on the float literal in
`bootstrap/src/lex/lexer.yoop`, which is 1.5 and is now the critical path.

The REPRESENTATION, and it is the whole design: **a value enum is a nominal
alias over a primitive.** `Type.ValueEnum` carries an `underlying` TypeId and a
case list of compile-time constants; at the LLVM layer the enum IS that
primitive - `i32` by default, `i8` for `enum<uint8>`, `ptr` for
`enum<string>` - and a case is an immediate or an interned string constant with
no storage anywhere. That is why there is no `codegen/enum.yoop`: unwrapping the
alias once in `llvmType`, `primBitWidth`, `primIsSigned` and `sizeOfType` covers
layout, casts, varargs, array elements, struct fields and `ref` parameters
together. What is NOT inherited is assignability and the operator set, and those
two refusals are the entire semantic content of the feature.

What the reference actually does, established by compiling probe programs rather
than by reading its source:

  - the default backing is `int32`. `<T>` after the name takes any signed or
    unsigned int width or `string`; `bool`, a float and a nominal type are all
    refused by name. `enum K<K2>` is a BACKING type, not a type parameter - an
    enum is never generic.
  - a case value is written by JUXTAPOSITION (`Sweet 1`), never with `=`. `=`
    is refused as an ordinary expression error.
  - values may be sparse, negative, and DUPLICATED. An implicit case is the
    previous case's value plus one, so `{ Zero 0, Eighteen 18, Auto }` gives
    Auto 19 - it counts off the VALUE, not the ordinal.
  - a value expression may name a PRIOR case by BARE name and combine those
    with `| & ^ << >>` only. Arithmetic is refused, a forward reference is
    refused, and a module `const` is not in scope there. A case that was DERIVED
    makes the enum "open", and a switch over an open enum requires a `default`
    even when every case is covered.
  - a case is reached as `Color.Red` and never as a bare `Red`. The reference
    also accepts `ns.Color.Red`; the bootstrap does not - see below.
  - a switch over an INT-backed enum is exhaustive-checked, and a `default`
    alongside every case is ALLOWED. That is the opposite of the variant rule
    ("exhaustive or defaulted, never both"), and it is right: an enum's values
    are integers, so one naming no case is representable and the default is
    never provably dead. A switch over a STRING-backed enum is refused by name.
  - there is no implicit conversion in either direction, and no `Color(i)` at
    all. `int32(c)` casts OUT; `string(dir)` on an `enum<string>` is refused
    with the ordinary numeric-casts message.
  - `==` and `!=` work on both backings. Ordering and the bitwise family work on
    an int-backed one only. Arithmetic works on neither.
  - an INT-backed enum is a valid array INDEX, which is what makes
    `AST_NODE_KIND_NAMES[kind]` read the way it wants to.
  - a case may not carry a payload - that is what a `variant` is - and the
    refusal comes from the value fold rather than the parser, because
    `Red { r: int32 }` is a struct literal to a parser.
  - an enum takes `implements` and METHODS exactly as a struct does, anywhere in
    the member run and with no comma before a method. A method body may `switch`
    on `self`. There are no inherent methods here either.
  - an interpolated enum renders through its `toString` when it has one, and as
    its underlying value otherwise - the string for `enum<string>`, the number
    for an int-backed one.

Three DIVERGENCES, all recorded in bootstrap/README.md:

  - matching two cases that share a VALUE in one switch is refused BY NAME. The
    reference emits a jump table naming the value twice and lets clang refuse
    it ("duplicate case value in switch"), which names neither case and no
    source line. Declaring two cases with one value stays legal on both sides.
  - `Display.toString(ref c)` on an enum receiver WORKS here and is refused by
    the reference ("requires a struct receiver"). It falls out of the method
    table rather than being added: blocking it would have taken extra code to
    make an enum less of a type than it is.
  - `ns.Color.Red` is not supported. It is the same gap `ns.CONSTANT` and
    `ns.Variant.Case` already have - a namespace reaches types and calls and
    nothing else - and no file in the 408 uses it, so it is recorded rather than
    built.

At SCALE it is linear, which was the thing to check: a synthetic enum with a
`toString` that switches over every case emits 243 / 643 / 1843 lines of IR for
50 / 150 / 450 cases (about 4 lines per case, one jump table) and compiles in
0.05 / 0.05 / 0.09 seconds end to end. The real `ASTNodeKind` is 150 cases and
sits in the middle of that.

**1.3 `?` propagation - DONE 2026-08-13, 41 files.** `SelfLexing.advance(ref
ps)?` - yield the `Ok` payload, or return the `Err` from the enclosing function.
41 files stopped at `expected SEMICOLON, got QUESTION` before; none do now. 5 of
them went all the way to an executable and the other 36 advanced to a later
blocker, 26 of those to value `enum` (1.2), which is now by far the largest
single item left.

What the reference actually does, established by compiling probe programs
rather than by reading its source:

  - A FALLIBLE type is a `variant` with EXACTLY two cases, named `Ok` and
    `Err`, each carrying zero or one field. Every clause bites: a third case, or
    a two-field payload on either case, makes it non-fallible.
  - So `Option<T>` is NOT fallible - `?` on one is refused. This is the single
    most surprising finding, because "the Rust-shaped feature works on the
    Rust-shaped optional" is the natural assumption.
  - The payload FIELD names do not matter. `Err { error: E }` and `Err { e: E }`
    are both fallible; one field is one field.
  - The operand's variant type need NOT equal the enclosing function's. Only the
    two `Err` PAYLOAD types have to agree - `?` rebuilds the enclosing Err
    around the operand's error rather than forwarding the operand's value.
  - When the payloads differ, the reference converts through an
    `Into<TargetErr>` impl on the operand's error type, and the conversion runs
    in the failure branch (the `into` really is called - a tag field proves it).
  - `?` is usable as an ordinary expression EVERYWHERE: nested in a call
    argument, as a binary operand, chained as `f()?.field`, doubled as `f()??`,
    at statement position with the value discarded, and inside a method body.
    `ref f()?` is the one refusal - a `?` result is not an lvalue.
  - Disposals fire on the early-return path, in reverse declaration order,
    exactly as on a `return` - which they are.
  - There is no ternary in the language, so a postfix `?` is never ambiguous.

Two DIVERGENCES, both refusals rather than silent differences:

  - The `Into` conversion is not built. **Built later the same day - see 2.11,
    and note this entry's reasoning was WRONG:** it does not need generic trait
    instantiation at all, only the applied-trait machinery 1.6 shipped, and the
    conversion is an ordinary static dispatch on a concrete receiver.
  - Neither is the handler form `expr? e { ... }`, nor the context form
    `expr? "loading config"` that prefixes a note onto a string `Err`. Both were
    found by the re-probe rather than known up front, and both are refused BY
    NAME: each reads as plain propagation once its extra tokens are dropped, so
    a generic "expected semicolon" would send a reader after punctuation.

Where the desugar went, and why: a TRY_OP EXPRESSION node that pass D types and
codegen lowers to a branch, NOT a statement rewrite in the parser. `f(g()?)` is
the shape that decides it - a statement-level rewrite only ever reaches the `?`
that happens to sit at the top of a `let`. Putting it in the parser's postfix
loop is also what makes `f()?.field` and `f()??` cost nothing extra: the loop
just runs again. Codegen already had every piece (tag tests, payload extraction,
early return with scope unwinding), so `try_op.yoop` is assembly rather than new
machinery.

One thing worth knowing before building anything else that returns
mid-expression: the lowering is a diamond whose error half ends in `ret`, so the
Ok block has exactly ONE predecessor. That is what makes a temp computed before
the `?` still dominate everything after it, and why `a + f()?` needs no phi.

**1.4 Module `const` with a non-literal initializer - DONE 2026-08-13, 8 sites.**
`const RUNTIME_ROOT_VAR: string = "YOOP_RUNTIME_ROOT";`. Consts are INLINED, so
the bootstrap accepted only integer literals; now it accepts anything there IS
something to inline.

**The measurement was out of date the moment 1.1's field access landed, and the
brief's example was not the important one.** Re-measured, the 6 sites were four
different shapes:

  - a STRING (`RUNTIME_ROOT_VAR`, `GREETING`, `STD_ALPHABET`) - 3 sites, the one
    the brief named
  - an ARRAY (`const WHITESPACE_CHAR_CODES: uint8[] = [32, 9, 13, 10]` in
    `lex/chars.yoop`, `const DAY_NAMES: string[] = [...]` in std/time) - and this
    was the CRITICAL PATH, 95 files, not the strings
  - a variant constructor folded at compile time (`comptime_enum_fold.yoop`)
  - a CALL (`vec.vecNew(8)`, and `sortedDefs([...])` in `lex/scan_tables.yoop`)

Four shapes are inlinable now, and the test is "is there an LLVM spelling that
needs no storage of its own":

    const N: int32   = 42;               an immediate
    const F: float64 = 1.5;              an immediate, as 64 bits of hex
    const B: bool    = true;             an immediate
    const S: string  = "YOOP_ROOT";      a module-level string constant
    const A: uint8[] = [32, 9, 13, 10];  a descriptor over a module-level array

FLOATS were included, which the 1.5 note had left open. `Symbol.Value` still has
only an `intVal` and no float slot, and that turned out not to matter: the value
does not have to ride in the symbol at all. Codegen materializes every
non-integer const's operand from the AST in one program-level pass keyed by
SymbolId - which is also what makes an IMPORTED one work, since an import binds
the source module's SymbolId rather than a copy. So the "no float slot" gap was
an artifact of assuming the symbol had to carry the value.

**An array const inlines as a CONSTANT AGGREGATE, `{ ptr @.arr.0, i64 4 }`.**
LLVM takes one as an operand, so an array const costs no instructions at a use
either - `.len` is an `extractvalue` on a constant, and `for c in CODES` walks
the payload directly. That is better than the reference, which emits
`@m__CODES = internal global %yoop_array.uint8 { ... }` and LOADS it at every
use. The payload itself is `internal global` rather than `private constant`,
deliberately: constness is about the BINDING, so `A[0] = 9` through a const is
allowed the same way it is for a local, and read-only storage turns that into a
crash. The reference DOES crash there - `A[0] = 9` on a module const array is a
SIGBUS - which is a divergence where the bootstrap is right.

What the reference actually does, established by compiling probe programs rather
than by reading its source:

  - a module const is NOT inlined there at all: every one becomes an
    `internal global` with a constant initializer and is loaded at each use.
    The bootstrap keeps inlining, which is observably identical for a string
    (both end up naming the same `@.str.N`) and cheaper for everything else.
  - the initializer is checked against the ANNOTATION. `const S: string = 5;`
    is "cannot assign untyped int to string in initializer of module-level S",
    and `const N: int32 = "x";` is the mirror. So a const cannot quietly become
    a zero of the wrong kind, and the bootstrap checks the same thing.
  - a float const works at both widths and a bool const works.
  - `const A: int32[] = [1,2,3]` compiles, and `A[0] = 9` then crashes at run
    time. See above.

Two DIVERGENCES, both refusals rather than silent differences:

  - a const initialized by a CALL stays refused, and now says WHY: "is
    initialized by a CALL - the reference folds one at compile time and the
    bootstrap has no comptime interpreter, so there is nothing to inline". That
    message exists because the generic "needs a literal" one sends a reader
    after punctuation on a program that is perfectly well formed. It is also
    the new critical path - see the probe section above.
  - a struct or variant LITERAL initializer stays refused for the same reason
    (the reference folds `Shape.Circle { radius: 4 }` at compile time).

Not built, and named so nobody looks for it: a module-level `let` holding an
ARRAY. `let counters: int32[] = [0, 0, 0, 0];` is a MUTABLE global, so its
payload has to be writable storage that two globals with the same initial bytes
do not share - a different question from a const's, and the one file that wants
it (`module_level_mutable_array.yoop`) also initializes a second global with
`intr.heapAlloc(4)`, which is a call and refused anyway.

**1.5 Floats - DONE 2026-08-13, 97 files.** `float32` / `float64`, literals,
arithmetic, casts in every direction, printf promotion and interpolation. The
one whole missing PRIMITIVE type; everything else in phase 1 was syntax. 97 of
the 408 files stopped at a float before, 88 of them at ONE line -
`bootstrap/src/lex/lexer.yoop:67`, a `floatVal: 0.0` in a struct literal - and
none do now.

6 of the 97 went all the way to an executable; 2 more now reach clang and fail
only to LINK the runtime's `yoop_float_to_string`, which is 2.3. The other 88
moved as a block to `bootstrap/src/utils/sort.yoop:20`, which is 1.6. That is
the import closure again and it is worth being explicit about, because it will
happen once more: `lex/scan_tables.yoop` imports `quickSort` from `utils`,
`utils` is a directory module so `sort.yoop` loads with it, and the float error
was only the one the walk reached first. **1.6 is now the critical path, at the
same 88-file depth 1.5 had.**

What the reference actually does, established by compiling probe programs rather
than by reading its source:

  - an unsuffixed literal is UNTYPED and pins to whatever float the context
    wants. Unconstrained it infers float64, and `float` is an alias for
    float32 (so `const b: float = 2.5` pins to 32 bits, not 64).
  - nothing MIXES, in any direction: not float32 with float64, not a float with
    an int, and not an untyped INT literal with a float slot -
    `const a: float64 = 2;` is "cannot assign untyped int to float64". `2.0` is
    the literal that fits. There is no implicit widening either, so
    `const b: float64 = someFloat32;` is an error and the cast is the only
    route.
  - `.5` and `1.` are NOT float literals - a leading dot lexes as DOT then an
    int, and a trailing one wants an identifier after it. `1e5`, `1E5`,
    `1.5e-3`, `1.5E+3` and `1_000.5` all are.
  - a literal that overflows float64 is refused ("invalid float literal
    Infinity"). One that overflows float32 is NOT - `const d: float32 = 1.0e40;`
    compiles and the constant is an infinity.
  - `+ - * / %` all work, `%` included: `frem` is a real instruction and the
    reference emits it. So do `== != < > <= >=`, as ORDERED comparisons, which
    is what makes `x != x` FALSE for a NaN.
  - `& | ^ << >>` do not - but the reference is inconsistent about it, and that
    is the one place worth knowing. `a | b` is a typecheck error there; `a & b`
    passes typecheck and crashes its codegen with "unknown binary op amp for
    type prim/float64".
  - casts go every direction between the numeric primitives, as plain `sitofp` /
    `uitofp` / `fptosi` / `fptoui` / `fpext` / `fptrunc`. Truncation is toward
    zero in both signs. Out of range is UNDEFINED in LLVM terms and the
    reference does nothing about it - `int32(1e20)` printing 2147483647 is arm64
    saturating, not a language rule, so no fixture may depend on it.
  - a bool is not a number: `bool(f)` and `float64(b)` are both refused with the
    ordinary numeric-casts message. Nor is a float an array INDEX, an `if`
    condition, a `!` operand, a switch SCRUTINEE pattern ("float literals are
    not allowed in switch patterns"), or an enum BACKING type.
  - `printf("%f", x)` on a float32 emits an `fpext` to double first - C default
    argument promotion, the float twin of what 1.1 built for narrow integers.
  - an interpolated float renders through `%g`: `${1.5}` is "1.5", `${1.0}` is
    "1" with no point at all, `${1.0e20}` is "1e+20", `${-0.0}` is "-0". That is
    the reference's `yoop_float_to_string`, which is one `snprintf(..., "%g", x)`
    and nothing else - so the bootstrap calls libc directly and gets the same
    string without linking the runtime.

**The lexer's existing float decoding was WRONG, and that is the finding worth
carrying forward.** It accumulated the mantissa in a float64 and then multiplied
or divided by ten once per decimal place. Both halves round:
`mantissa * 10.0 + digit` loses bits past 2^53, and each scaling step rounds
again. Measured against strtod over 22 realistic literals it was off by an ulp
or two on 6 of them - 2.718281828459045 came out as 2.7182818284590446, 1e308 as
9.999999999999998e307, 6.02214076e23 one ulp high.

Nobody had noticed because **the parity token dump was deliberately skipping
float values**, on the stated theory that "this side parses with parseFloat and
renders with JS number formatting; the bootstrap renders through the C runtime's
float-to-string" made them incomparable. The FORMATTING is incomparable; the
VALUE is not. The dump now prints `float=<16 hex digits>`, the IEEE-754 bit
pattern, which has no formatting question in it at all - and the whole corpus
passes, over 557 files. That is the answer to "should the harness start
comparing float values": yes, and it should have from the start.

The decoder now accumulates an exact uint64 mantissa and applies the decimal
scale in ONE multiply or divide, which is correctly rounded while the mantissa
is under 2^53 and the scale within 10^22. Outside that it REFUSES BY NAME rather
than approximating: getting `1e308` right needs the big-integer path a real
strtod has (Clinger / Eisel-Lemire), and an off-by-an-ulp constant is a wrong
answer that looks like a right one. Nothing in std, examples or bootstrap is
outside the range - the widest literal in the whole corpus is
3.141592653589793, whose 16-digit mantissa is still under 2^53 - so the refusal
costs zero files today. If a real program ever needs one, that is a plan item
and not a silent difference.

A second lexer bug fell out of the same read: the exponent SCAN accepted only a
lowercase `e` while the value decoder handled both cases, so `1E5` lexed as an
int `1` followed by an identifier `E5`. Silent, because both sides produced
tokens. No corpus file uses the uppercase form, which is exactly why a
whole-corpus parity run never caught it; `tests/parity/literals.yoop` carries
one now.

Two DIVERGENCES, both refusals rather than silent differences:

  - the bitwise family on two floats is refused BY NAME, covering
    `& | ^ << >>` in one rule. The reference refuses four of them at typecheck
    and crashes its codegen on `&`.
  - a float literal outside the exactly-decodable range is refused, as above.

And one PRE-EXISTING divergence that floats made visible rather than caused: a
template literal handed DIRECTLY to `printf` as its FORMAT renders differently
in the two compilers. The reference has a printf special case that rewrites it
into C conversions, so a float prints "3.140000" there and "3.14" here; the same
split already applied to a bool ("1" versus "true") and long predates floats.
Six programs in `examples/pass/` do it and had not been compiling at all, so
the difference appeared the moment they did. Routing through `printf("%s\n",
<template>)` makes both agree, which is what every slice fixture already does.
Recorded in bootstrap/README.md; the bootstrap's version is additionally unsafe
in a way the reference's is not, since a built string containing a `%` becomes a
conversion specifier.

Where the machinery went. A float CONSTANT is spelled as 64 bits of hex at both
widths, because LLVM takes an arbitrary decimal for a `double` but not for a
`float` - `float 1.3` is "floating point constant invalid for type" - and hex is
what the reference emits for both. Reaching those bits needs a bitcast the
language does not have, so `utils/float_bits.yoop` goes through `memcpy` and is
the one `import.unsafe` file below lex. It lives in `utils` because BOTH the
parity dump (in lex) and codegen need it, and utils is the one module under
both. The float32 form measures the value AFTER rounding to float precision,
which is also what makes an out-of-range float32 literal come out as an infinity
rather than an error - matching the reference exactly, constant for constant.

NOT built, and named here so 1.4 picks it up: a module-level `const` or `let`
holding a float. `Symbol.Value` and `Symbol.Global` carry an `intVal` and there
is no float slot beside it, so it is the same shape of gap 1.4's string consts
are. No file in the corpus has one - the single candidate,
`examples/pass/module_init_folded.yoop`, initializes with `float32(42)` and
needs the const FOLDER rather than a float slot.

**1.6 Type-parameter bounds - DONE 2026-08-13, 100 files.**
`<T implements Comparable<T>>`. 100 of the 411 files stopped at
`expected '>', got IMPLEMENTS`, from 8 distinct sites, 93 of them funnelling
through `bootstrap/src/utils/sort.yoop:20` - `lex/scan_tables` imports
`quickSort`, `utils` is a directory module, and everything above lex inherits
the closure. None of the 415 stops at a bound now. 5 went all the way to an
executable and the rest advanced, including the whole 93-file pile.

**The design decision, and it went the reference's way: CHECK THE BODY ONCE,
with the bound's methods callable on the opaque parameter.** The alternative -
re-checking per instantiation - was rejected for three reasons, in order of
weight:

  - It moves every diagnostic from the DECLARATION to the call sites. A body
    that calls a method no bound promises is a bug in the declaration, and the
    author fixing it wants to be told there. That is the C++ template failure
    mode, and avoiding it is most of why a bound exists at all rather than
    being a comment.
  - It costs a decoration vector per instance. `tm.resolvedTypes`,
    `calleeReceiver` and `calleeInstance` are all keyed by NodeId with one
    entry per node, and `resolvedTypeAt` being the ONE place substitution
    happens is an invariant four codegen files lean on.
  - The reference does it this way, and a probe proves it rather than its
    source suggesting it: a bounded body calling a method outside its bound is
    refused AT THE DECL even when nothing ever instantiates the function.

What the reference actually does, established by compiling probe programs
rather than by reading its source:

  - a bound parses on a generic `function`, `type`, `variant` and `trait`. NOT
    on a method - a method cannot be generic there at all ("expected lparen,
    got lt").
  - multiple bounds are PARENTHESIZED: `<T implements (A, B)>`. A bare comma
    separates type PARAMETERS, so `<X implements A, B>` declares a bounded X
    beside an unbounded B, and `A + B` is refused. Multiple bounded parameters
    work and mix freely with unbounded ones.
  - the bound IS checked at the call site (`call to "f": type argument "T" =
    struct Plain does not satisfy bound`) and at a generic type application
    (`type argument for parameter "T" of generic "Box" does not satisfy
    bound`). The second points at the DECL's source location, not the use.
  - the body CAN call the bound's methods on the parameter - that is the whole
    point - and calling one outside the bound is refused with `type parameter
    "T" is not bound to trait "Other" - add 'implements Other' to T's
    declaration`. An unbounded parameter gets the same message.
  - a bound naming a GENERIC trait applied to the parameter (`Cmp<T>`) really
    does SUBSTITUTE the trait's own parameter. Renaming the trait's parameter
    to `U` changes nothing: the body still checks its second argument against
    the function's `T`. A concrete argument works too (`T implements
    Cmp<int32>`).
  - a type parameter can SATISFY a bound, which a bounded generic calling
    another bounded generic needs.
  - an unknown name is `unknown trait "Nope" in bound on type parameter "T"`;
    a non-trait is `bound on type parameter "T" must be a trait, got "Plain"`.
    A duplicate bound (`(A, A)`) is accepted silently.

Two DIVERGENCES, both refusals rather than silent differences:

  - **WHICH application of a generic trait a type implements is part of
    satisfying a bound.** The reference compares trait NAMES only, so a `type N
    implements Cmp<int32>` satisfies a `T implements Cmp<T>` bound with
    `T = N` - and then emits IR clang rejects with `'%t1' defined with type
    '%struct...N' but expected 'i32'`. The bootstrap records the arguments on
    the `implements` clause and compares applications, refusing by name.
  - **A generic trait bound with the wrong number of type arguments, including
    NONE, is an arity error.** The reference registers a generic trait under
    its spelled-out name, so it answers `unknown trait "Cmp"` for a missing
    argument and `unknown trait "Cmp<T, T>"` for a wrong count - both of which
    send the reader looking for a declaration that is right in front of them.

**How much of 3.2 this needed, and it is a real slice.** A bound is where a
generic trait first has to be APPLIED rather than just declared, so
`applyTraitArgs` substitutes a trait's own parameters through its method
signatures and interns the result as a distinct `Type.Trait` whose `typeParams`
slot holds the arguments. `collectImplementedTraits` does the same for an
`implements` clause, and `substitute` reaches trait lists through
`substituteTrait` so `Vec<string>` claims `Iterable<string>` rather than
`Iterable<T>`. What is NOT built, and is still 3.2: dispatching THROUGH an
applied trait as a value - `Iterable<T>` in a `for ... in`, and the `Into<E>`
conversion `?` wants. Those need a trait to be a receiver, not a promise.

**Two things this uncovered, both pre-existing and both load bearing.**

  - **The monomorphization set was never CLOSED.** A generic calling a generic
    passes its own opaque parameters along, so pass D records
    `partitionYoop_T`, not `partitionYoop_Token`. Codegen was emitting that as
    a real function - `define ptr @inner_T(ptr %x.arg)` - and calling it with
    an `i32`. clang accepted the mismatch and it happened to work, because an
    unbounded generic body only ever moves values around. A BOUNDED body
    dispatches a method on `T`, the receiver never resolves to a nominal type,
    and the symbol comes out as `@mod____a` - which is finally an error.
    `typecheck/monomorph.yoop` is the fix: after every body is checked, each
    open instance is closed against every concrete instance of the decl whose
    parameters it mentions, iterated to a fixpoint. Codegen skips the open ones
    and each call site resolves onto the concrete one. `sort.yoop` is exactly
    this shape - `quickSort` calls `partitionYoop` and itself, all with `T`
    open - so nothing on the critical path would have worked without it.
  - **`ref xs[i]` was refused**, and any comparison sort needs it:
    `Comparable.compare(ref arr[j], pivot)` is line 25 of `sort.yoop`. An array
    element has an address - codegen already computes it for `xs[i] = v` - so
    this is pass D widening the `ref` target rule and codegen reusing
    `emitElementAddress`. A temporary still has no address, which is the rule
    that had to survive.

One ORDERING change fell out too, and it belongs in the same list. Pass C used
to fill generic decls first and everything else second, with traits in the
second group. A generic decl's bounds and its `implements` clause both have to
read a trait's type parameters back to know which application they mean, and an
unfilled shell answers "takes 0 type arguments" - so traits now fill in a sweep
of their OWN, ahead of both. `FillPhase` is that three-way split. The
satisfaction sweep afterwards re-reads the implements clause and needed the
type-parameter scope re-established for the same reason.

And one bug fixed on the way, a new face of a trap bootstrap/README.md already
warns about twice: **a container MOVED into an interned type must not be
`disposable`.** `fillTraitMethods` marked a trait's `typeParams` disposable and
got away with it only because nothing ever read a trait's type parameters back;
bounds do, and the freed storage read back as whatever landed there next - which
surfaced as a bound being unsatisfied by the type that plainly implemented it,
three layers away from the annotation that caused it. `fillInstance`'s
substituted trait list had the same shape. Both are `let` now, matching the
`methods` and `fields` beside them.

Also worth knowing before writing another diagnostic: **`text.view` hands back a
BORROW of the Text's buffer**, so `disposable out: Text` plus
`return text.view(ref out)` returns a dangling string. `formatTypeList` in
resolve.yoop does exactly that and has been quietly producing an empty list for
Func-type diagnostics; the bound description was written to build with template
literals instead, matching every other diagnostic in the layer.

**The critical path moved rather than ended, for the third time.** The same 93
files now stop at `bootstrap/src/diagnostics/parse_error.yoop:35` - `.len` on a
`ref uint8[]`, which is field access through a borrow of an array. That is the
next one-line gate.

**1.7 The long tail - DONE 2026-08-13 except for two named refusals.**
`trait X extends Y`, `discard`, side-effect imports (`import "./init.yoop";`),
`union` decls, and - found by measuring rather than from the brief -
`export let` and `export "C" function`. Each is small and independent; they went
in one pass.

Measured first, and the brief's list was two items short and one item wrong.
`wait` is not here (it goes with `await` in 3.3), `union` is sized and skipped
(below), and the probe turned up two shapes nobody had listed: `export let`
(1 site, 2 files) and `export "C" function` (2 sites, 3 files).

**`discard` - DONE, 2 files, 2 sites.** `_ = expr;`. It is `_` then `=` then an
expression, and its own node kind - so the spelling survives into the AST - but
checked and emitted exactly as a bare `expr;` is. Both go through one case arm
in pass D and one in codegen, which is the whole point: the difference is that
the discard was written down on purpose, and nothing below the parser cares.
`_;` on its own is still refused, because `_` is a PATTERN spelling elsewhere
and swallowing one silently would be worse than a syntax error.

**Side-effect imports - DONE, 1 file, 1 site.** `import "./init.yoop";`. It is
the one import form with no `from`, since it has no clause for the keyword to
separate from the path. It still builds an ordinary IMPORT_DECL with zero
specifiers and no namespace name: the node's job is to name a module the graph
has to load, and every layer above reads the path off `strId`. So the only
thing it could get wrong is the GRAPH - binding a bogus name, or loading the
module a second time and defining its functions twice - and the slice fixture
imports the same file twice, once by name and once for effect, to say so.

**`export let` - DONE, 2 files, 1 site.** A module-level `let` is a mutable
global and exporting one is the same parse as `export const`. The load-bearing
half was in CODEGEN and had nothing to do with the parser: a global has exactly
ONE definition, in the module that declared it, so an importing module's read
has to name that module's symbol. `emitLoadGlobal` already took a `home`
parameter and was being handed `cx.tm.moduleId` at both call sites, which is the
READING module - so a cross-module read emitted `@main_0__counter` against a
definition called `@counter_1__counter`. `globalSymbol` is the fix, and it is
the same `importedFrom` lookup an imported CALL already goes through.

**`trait X extends Y` - DONE, 2 files, 2 sites.** `trait Loud extends Greeter`,
or `extends A, B`. Two merges, both at fill time, and nothing else moves:

  - the parents go in the SAME node slot an `implements` clause uses on a type,
    so `collectImplementedTraits` reads either without knowing which it has.
  - an `implements Child` clause claims the PARENTS too, transitively. That is
    what makes a bound on the grandparent satisfied by a type that only ever
    wrote `implements Child`, and it also makes `checkTraitsSatisfied` and
    `checkMethodsRequired` demand the parents' methods with no chain walk.
  - `lookupMethod` on a TRAIT falls through to its parents, which is what makes
    `Child.parentMethod(ref x)` resolve.

The list is FLAT by construction - a trait's own extends clause went through
`collectImplementedTraits` too - so the fall-through is one level deep and needs
no cycle guard. A parent declared BELOW its child is refused by name: its method
table is an empty shell at that moment, and merging one is invisible rather than
wrong, so every use downstream would report the child as missing a method that
is one line up.

The first attempt merged the parents' method tables into the child's instead,
which is tidier and cost two NEW self-compile blockers: the merge iterates a
`Map`, and `for entry in mapIter(...)` is `Iterable<T>` in a `for ... in`, which
is exactly what the bootstrap cannot compile yet. Worth remembering as a general
rule while the bootstrap is still growing - **a change to the compiler that adds
a `map.mapIter` loop adds a self-compile blocker**, and the lookup-side answer
avoided it entirely.

**`union` decls - SIZED and SKIPPED, 4 files, 2 sites.** Left as the named
refusal it already had. It is a C union: every field at offset 0, sized by the
largest, which is its own layout rule, its own `llvmType`, and its own field
read and write - the variant-payload shape rather than the struct one, since
reinterpreting bytes as another type needs an ADDRESS. See the follow-ups.

**`export "C" function` - REFUSED BY NAME, 3 files, 2 sites, NEW.** The message
was `only export function, export type ... are supported, got STRLITERAL`, which
reads as a typo on a declaration that is perfectly well formed. It now names the
feature and the reason: the definition is emitted under its bare C name, every
caller has to agree on that spelling, and `Symbol.Func` carries a TypeId and
nothing else - so an importing module has no way to learn not to mangle it.
Recording it on the symbol is the work, and the corpus's three files all call
theirs from the SAME module, so a `tm.externNames` shortcut would have passed
the probe and broken the first cross-module use.

Tests: 11 parse assertions (the discard node and its child, `_;` still refused,
a side-effect import binding nothing, `export let` and `export const` parsing,
the `export "C"` refusal, one and two parents, the parents' slot, and a generic
trait extending), 6 typecheck assertions (dispatch through the child and through
the parent, a bound on the parent satisfied through extends, a missing parent
method refused, and the declaration-order refusal), and
`bootstrap/tests/slice/long_tail.yoop` with `lib/tally.yoop` and
`lib/side_effect.yoop`, which runs identically under both compilers.

The `wait` half stays with `await` in 3.3 - it is a coroutine feature, not a
parse gap, and grouping it here was the brief's mistake rather than a decision.

Its `~` (bitwise NOT) half is **DONE 2026-08-13, 5 files, 4 sites**, and it is
the one item in this plan that was exactly the size it looked. Three edits:
`TILDE` joins `MINUS` and `BANG` in the prefix switch, `checkUnary` grows a
branch, `emitUnary` emits `xor <ty> %x, -1`. It needs none of the position rule
`&` and `*` need, because there is no binary `~` for a position to tell it apart
from.

What the reference actually does, established by compiling probe programs
rather than by reading its source:

  - `~` keeps the OPERAND's type, at every integer width, signed and unsigned
    alike. `~a` on a uint8 15 is 240; on an int32 5 it is -6; on a uint64 1 it
    is 18446744073709551614.
  - the expectation flows down into an untyped literal exactly as unary minus's
    does. `let w: uint8 = ~0` is 255, not an int32 -1 that then refuses to fit,
    and `let n: int64 = ~5` is an int64 -6.
  - an INT-backed value ENUM is an integer operand and keeps its OWN type, so
    `~Flags.A` is a Flags. That is the same rule the binary bitwise family
    already follows.
  - a bool, a float, a string, a struct and a STRING-backed enum are each
    refused with `bitwise NOT operator requires an integer operand, found X`.
    The bootstrap copies that message word for word.
  - it binds at the same precedence as unary `-` and `!`, so `~2 & 7` is
    `(~2) & 7` and prints 5, not -3.
  - the IR is `xor <ty> %x, -1`. -1 is all ones in two's complement at every
    width, so one spelling covers both signednesses and there is no separate
    complement instruction.

One thing worth noting because it looks like a divergence and is not: an
unconstrained `~-1` handed straight to `printf` is an error in the REFERENCE
("this expression still has an unpinned literal type"), which is the same live
sharp edge every other unconstrained untyped literal hits there. The bootstrap
defaults it to int32 and prints 0. Nothing new - it is 1.1 in plans/README.md,
and the slice fixture binds the value to an annotated local so both sides agree.

Tests: 4 parse assertions (the node kind and operator, the `(~a) & b` grouping,
stacked prefixes, and that there is no INFIX `~`), 8 typecheck assertions
covering the widths, the pinning, the enum and all five refusals, and
`bootstrap/tests/slice/bitwise_not.yoop`, which runs identically under both
compilers.

Its `extern ... from library "m"` half is **DONE 2026-08-13, 6 files, 4 sites**,
and it was not the syntax item it looked like. The two spellings of the `from`
clause MEAN different things:

    extern "C" from "stdio.h"   { ... }   a HEADER name - documentation
    extern "C" from library "m" { ... }   a LIBRARY name - `-lm` at link time

So parsing it was the small half; the load-bearing half is that the names are
collected GRAPH-WIDE and land on the one clang invocation, the way the runtime's
C sources already do. `CodegenOutput` carries them out beside `needsRuntime`,
because both are properties of the emitted program rather than of any module.

What the reference actually does, established by compiling probe programs rather
than by reading its source:

  - `library` is CONTEXTUAL. It lexes as an ordinary IDENT on both sides - the
    token dump proves it - so it is recognized by TEXT, and a variable called
    `library` stays legal. A STRING is required after it: `from library m` is
    "expected strLiteral, got ident".
  - the ABI is NOT consulted. `extern "intrinsic" from library "compiler"`
    contributes `-lcompiler` there and fails to link, which is the one place a
    carve-out was tempting and was skipped for matching behaviour.
  - `ssl` and `crypto` each lower to BOTH `-lssl -lcrypto`, and
    `framework:NAME` lowers to `-framework NAME` on macOS. Both are copied.
  - a library that does not exist fails at the LINK step, not earlier.

Not copied, and it is toolchain policy rather than compilation: the reference
also probes conventional install prefixes for `-L` / `-I` (Homebrew, vcpkg,
`YOOP_LIB_PATH`). Nothing in the corpus needs it to link - `m` is in libSystem
on macOS, and `sqlite3` / `ssl` are named by library files with no `main`, which
never reach a link at all.

**1.8 What item 1.1 uncovered.** Re-probed after 1.1 landed (80 of 401 files
now compile fully, up from 36). These were all hidden behind the variadic
blocker and are new to the plan, with distinct-site counts. Three of the four
are DONE 2026-08-13; `wait` stays with `await` in 3.3.

  - **Kind prefixes where a function is not - DONE, 13 files, 13 sites.** The
    brief called this "a kind prefix on a METHOD", and the 13 sites turned out
    to be TWO shapes: 9 methods (`async handle(ref self, ...)` in a type body)
    and 4 PARAMETERS (`function use(scoped h: ref FileHandle)`,
    `function take_pooled(pooled h: Task<int32>)`). Both are built.

    What the reference actually does, established by probing:

      * a method takes prefixes exactly as a function does, and the prefix
        REPLACES the `function` keyword - but `traced function area(...)`, with
        both, is also accepted. Multiple prefixes work.
      * a PARAMETER takes at most ONE (`marker other h: T` is "a parameter may
        carry at most one kind prefix in phase 6.5"), and it comes before `ref`
        (`marker ref h: H` parses; `h: marker ref H` does not).
      * an unknown kind on a PARAMETER is refused there; an unknown kind on a
        METHOD is NOT - a typo'd prefix silently produces an ordinary method.
      * a parameter's kind is checked against its `appliesTo`, and a
        `conferred` one is refused on a non-struct value.

    Two DIVERGENCES, both the stricter half:

      * a method's kind prefixes ARE resolved here - an unknown one is refused
        by name, and a PAUSABLE one (`async`, `task`) marks the method a
        coroutine so codegen refuses to emit it. Waving it through would emit a
        method that compiles, links and never suspends, which is the silent
        miscompile the whole pausable refusal exists to prevent.
      * `appliesTo` is not checked on a parameter, because the bootstrap's
        `KindInfo` records only `pausable` and `mustCall`. That is the ordinary
        "kinds are not enforced" gap rather than anything about this feature.

    One thing this uncovered that is worth knowing before touching a member
    run: **`Green function toString(...)` and `async function handle(...)` are
    the same two tokens, and only the BODY decides which.** An enum or variant
    case may be a bare identifier with the method right after it and no comma;
    a struct field is always `name: T`, so there the shape can only be a
    prefix. `atKindPrefixedMethod` takes that as a parameter. The two-token
    rule every other kind position uses is not enough here, and neither is
    "ends at `(`" on its own - an enum case may be `AB A | B`.

  - **`wait <expr>` - 10 sites.** `const v: int32 = wait h;`. A DIFFERENT thing
    from `await`: it joins a task handle. Cheap next to `await` and worth doing
    with it rather than separately. NOT done here.

  - **A named kind-region binding - DONE, 6 files, 6 sites.**
    `disposable reg: mem.ArenaScope = mem.arenaScope(4096) { ... }` - the block
    form attached to a BINDING.

    **The block IS the binding's scope**, and that is the whole semantic
    content. Established by probing: the name is visible inside the block, the
    scope-end call fires at the closing brace BEFORE anything after it, and
    reading the name afterwards is `undefined variable`. So it is not "a
    binding, then a block that happens to follow" - `childD` on the decl holds
    the block, pass D pushes a scope around the declaration AND the block, and
    codegen pushes one dispose scope and one locals scope around the same pair.
    That is `emitScopedBinding`, the named twin of `emitKindRegion`, and the
    two differ in exactly one thing: the subject has a name here, so it goes in
    an ordinary local slot instead of an anonymous one.

    The form is GATED on there being a kind prefix, which is what keeps it
    decidable: without the gate an ordinary `const p: Point = { x: 1 }`
    followed by a bare block statement would swallow the block.

    One DIVERGENCE, and it is one the bootstrap already had: `continue` out of
    a region disposes here and LEAKS in the reference, the same way `break`
    does. `dispose_break.yoop` already carries that reason.

    A neighbouring gap fell out of the same probe and is fixed with it: the
    ANONYMOUS form refused a QUALIFIED subject (`ephemeral mem.arenaScope(1024)
    { ... }`, 3 sites), because the statement-position lookahead stopped at
    `(`. Values from std must come through a namespace, so that was refusing
    the spelling every std user writes.

  - **`extern "C" from library "m"` - DONE, 6 files, 4 sites.** Written up
    under 1.7 above, where the rest of the long tail lives.

---

