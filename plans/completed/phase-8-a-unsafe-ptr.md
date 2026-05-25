# Phase 8.A - `unsafe_ptr<T>` operational spec

## Context

[SPEC.md](../SPEC.md) §12 reserves `unsafe_ptr` as the FFI escape hatch and gates it behind a `import.unsafe;` module attribute, but only sketches one example (`let unsafe_ptr p: ref int32;`). There are no operational rules - no deref, no arithmetic, no address-of, no nullability, no casts. Phase 8.B/C/D (C-ABI structs, buffer interop, errno) all need a real pointer type to talk about; this phase delivers it.

The SPEC sketch treats `unsafe_ptr` as a *kind* applied to a `ref T`. This phase reshapes it as a generic-style *type* - `unsafe_ptr<T>` - which is cleaner (composes with imports/struct fields like any other type), mirrors how the existing `Task<T>` builtin is exposed in the type system, and stops conflating it with the Phase 6 kind machinery. The SPEC must be edited to match.

This is an `import.unsafe;`-gated escape hatch. Without that opt-in at module top, every `unsafe_ptr<T>` mention is a typecheck error. The gate keeps the rest of the language pointer-safe and lets us scope safety arguments to a small number of files.

## Design

### Type

- New type constructor `UnsafePtrType { pointee: Type }`. Lives in [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js). Immutable (frozen) like every type except `KindType` / `TypeParamType`.
- Source syntax: `unsafe_ptr<T>`. `T` is any type annotation, including another `unsafe_ptr<...>` (for `T**`-shaped pointers), `ref T` (for `unsafe_ptr<ref Foo>` - pointer to a yoop reference, useful as out-parameters from libc into yoop), `void` (= type-erased pointer; pointee is the special `void` type), and concrete structs / unions / enums.
- Codegen lowers `unsafe_ptr<T>` to LLVM's opaque `ptr`. We do **not** use typed-pointer IR (LLVM 15+ is opaque-pointer-only anyway); the typechecker tracks pointee identity, codegen uses `getelementptr` on the typed pointee for arithmetic.

### Gating

- Add a per-module flag `module.allowsUnsafe: bool`, set by parser when it sees `import.unsafe;` at the top of the file. Already reserved in SPEC §12 - the parser currently does not accept this syntax; this phase adds it.
- Recognition rule: `import.unsafe;` consists of three tokens: `import`, `.`, ident `"unsafe"` (no special lexer change needed - `unsafe` is not a keyword). Parsed only at module top, before any non-import statement; out-of-place use is a parse error with a helpful diagnostic.
- Typecheck rule: in any module where `allowsUnsafe == false`, surfacing an `unsafe_ptr<T>` in a type annotation, expression, or extern signature is an error: `"unsafe_ptr requires 'import.unsafe;' at module top"`.
- Imports across modules: a non-unsafe module **may** import functions from an unsafe module, but cannot *name* the `unsafe_ptr<...>` type itself in its own source. (i.e. the gate is on text, not on values.) Pragmatic - lets a safe-mode wrapper module export `function read(fd, buf, len): SafeReadResult` whose body uses pointers internally but whose signature is pointer-free.

### Operators

| Op | Form | Result type | Notes |
|---|---|---|---|
| Address-of | `&lvalue` | `unsafe_ptr<T>` where `T` is the lvalue's type | Prefix `&`, lvalue-only. Disallowed on rvalue temporaries. |
| Deref (read) | `*p` | `T` for `p: unsafe_ptr<T>` | Prefix `*`. Reading through a null pointer is undefined behavior (compiler will emit a load; no runtime check). |
| Deref (assign) | `*p = v` | - | Assignment LHS form. `v` must be assignable to `T`. |
| Pointer + int | `p + n`, `p - n` | `unsafe_ptr<T>` | `n` is any signed/unsigned integer type. Stride is `sizeof(T)`. |
| Pointer diff | `p - q` (both `unsafe_ptr<T>`) | `int64` | Element count, not bytes (matches C `ptrdiff_t` semantics with same pointee). Different pointees → typecheck error. |
| Comparison | `p == q`, `p != q` | `bool` | Pointees must match, **or** one side is `null`. Ordered comparisons (`<`, `<=` …) deferred - not needed for sockets work. |
| Index sugar | `p[i]` | `T` (lvalue) | Equivalent to `*(p + i)`. Phase 8.A includes this - it's load-bearing for buffer interop and trivial to lower. |

`&` and `*` did not have prefix meanings before this phase:
- `&` was tokenized only as the binary bitwise-AND operator. Prefix `&` is currently a parse error; we add it as `ADDRESS_OF_EXPRESSION` in the unary parse position.
- `*` was tokenized only as multiplication. Same story - add prefix `*` as `DEREF_EXPRESSION`.

Precedence: both `&x` and `*x` parse at the same precedence as the existing unary `-` and `!` (i.e. higher than any binary). Composition: `*&x` ≡ `x`, `&*p` ≡ `p` (typecheck-equivalent; no codegen optimization assumed).

`p + n` and `p - n`: typed in [checkExpr.js](../src/jsyooptypecheck/checkExpr.js)'s binary-op resolver. When either side is `unsafe_ptr<T>`, switch to pointer-arithmetic typing instead of the integer/float unification path:

- `unsafe_ptr<T> + int` → `unsafe_ptr<T>`
- `int + unsafe_ptr<T>` → `unsafe_ptr<T>` (commutative)
- `unsafe_ptr<T> - int` → `unsafe_ptr<T>`
- `unsafe_ptr<T> - unsafe_ptr<T>` → `int64` (matching pointees only)
- `unsafe_ptr<T> - unsafe_ptr<U>` for `T ≠ U` → typecheck error with fix-it: "cast one side first via `unsafe_ptr.cast<...>`"

`*` and `/` and `%` on pointers are typecheck errors.

### `null`

- Add `null` as a keyword token. Used as a literal: `let p: unsafe_ptr<int32> = null;`.
- Like untyped int/float literals, `null` does not have a standalone type - it pins from context (assignment RHS, return value, call arg, comparison-against-typed-side). A bare `null` in an unconstrained position is a typecheck error.
- Codegen: lowers to LLVM `ptr null`.
- Only `unsafe_ptr<T>` accepts `null`. References (`ref T`) do not - yoop refs are non-null.

### Casts

Three forms, all expressed as built-in functions (no new `as` operator yet):

1. `unsafe_ptr.cast<U>(p: unsafe_ptr<T>): unsafe_ptr<U>` - bitcast between pointee types. Codegen is a no-op (LLVM `ptr` is opaque).
2. `unsafe_ptr.toInt(p: unsafe_ptr<T>): uintptr` - pointer-to-integer.
3. `unsafe_ptr.fromInt(n: uintptr): unsafe_ptr<T>` - integer-to-pointer.

New built-in integer type `uintptr` = platform pointer width (64-bit on the targets we currently care about; codegen consults the target triple). Lowered to LLVM `i64` on 64-bit targets. `uintptr` and `usize` are distinct names in source but lower to the same LLVM type on the current targets - this matches C usage (`uintptr_t` vs `size_t` semantic distinction) and gives us a name to grow into if 32-bit targets are added.

`unsafe_ptr.cast` is a generic intrinsic and is the one place where the parser must accept explicit type arguments in expression position - but only on the literal token sequence `unsafe_ptr.cast<...>(`. Implement as a recognized built-in callee in the typechecker, *not* by generalizing the parser to accept turbofish everywhere; we don't want to weaken the "no `<` in expression position" invariant the existing peekahead relies on.

### Interaction with `ref T`

- `&x` on an lvalue of type `T` gives `unsafe_ptr<T>`. If `x` itself has type `ref T`, `&x` gives `unsafe_ptr<ref T>` - i.e. address of the ref slot. To get the address that the ref points to, use `&*x` (deref first, then address-of), which simplifies to a typechecker rule: applied together they round-trip to `unsafe_ptr<T>`.
- The other direction - `unsafe_ptr<T>` → `ref T` - is *not* an operator. The escape hatch is `unsafe_ptr.cast<...>` followed by deref, and the user takes responsibility for non-null-ness. We do not provide an automatic `unsafe_ptr<T>` → `ref T` coercion; the asymmetry is the whole point of `import.unsafe;`.

### Kind / safety interactions

- `unsafe_ptr<T>` is **not** a containing type for the purposes of Phase 6 kind containment. A struct holding an `unsafe_ptr<T>` does **not** propagate kinds from `T`. (Pointer indirection severs the containment chain - analogous to how a raw C pointer doesn't carry a destructor.)
- `unsafe_ptr<T>` values are *not* allowed in pure functions (Phase 5 `pure`). Adding them taints the function - flag as a typecheck error inside `pure`.
- `unsafe_ptr<T>` is freely copyable / Plain-Old-Data - no `mustCall`, no `mustNotEscape`, no `mustNotShare` obligations. The whole point of the gate is "these don't participate in the safety system; you've opted out."

### Diagnostics

Concrete error messages to emit (each with sourceLoc):

- `"unsafe_ptr requires 'import.unsafe;' at module top"` - any use of the type name outside a gated module.
- `"cannot take address of an rvalue - operand of '&' must be an lvalue"` - `&(1 + 2)`, `&f()`, etc.
- `"cannot deref non-pointer type X"` - `*x` where `x: int32`.
- `"pointer arithmetic requires same pointee type - got unsafe_ptr<T> and unsafe_ptr<U>"` - `p - q`.
- `"cannot compare unsafe_ptr<T> with unsafe_ptr<U>"` - mismatched pointee equality.
- `"null requires an expected pointer type"` - `null` in unconstrained context.
- `"unsafe_ptr is not allowed in pure functions"` - `unsafe_ptr<T>` referenced inside a `pure` body.

## Sub-phase order

### 8.A.0 - SPEC edits

[SPEC.md](../SPEC.md) §12 currently shows the kind-on-ref form. Rewrite the section to document the new type form, the operators, the `null` literal, the casts, and the `import.unsafe;` gate. Update SPEC §14 reserved-keyword list to add `null`. Remove the now-stale example `let unsafe_ptr p: ref int32;`.

### 8.A.1 - Lexer

- Add `null` to `keywordTagList` and `TokenTags`. Single new token.
- No other lexer changes - `&` and `*` already lex; `unsafe_ptr` lexes as a plain identifier (currently NOT a keyword despite being on the SPEC reserved list - keeping it as an identifier is fine for now, the parser will recognize it by name in type-annotation position).

### 8.A.2 - Parser

- `parseProgram()`: accept zero or one `import.unsafe;` at the top of the file (before any non-import statement). Set `programNode.allowsUnsafe = true`.
- `parseTypeAnnotation()`: when the head identifier is `unsafe_ptr`, expect `<`, recursively parse one type annotation, expect `>` (with the existing `consumeClosingGt` handling for `>>`). Produce `{ kind: "unsafePtrType", inner: <annot> }`.
- `parseExpression()` (unary level): add prefix `&` → `ADDRESS_OF_EXPRESSION { operand }` and prefix `*` → `DEREF_EXPRESSION { operand }`. Same precedence (70) as the existing prefix `ref`. Both go through `buildSourcedNode`.
- Lvalue handling: extend the assignment-LHS recognizer to accept `DEREF_EXPRESSION` (i.e. `*p = v` parses as an assignment). Also extend the index-expression recognizer so `p[i]` on a pointer (recognized at typecheck time) works without any parser change - the existing `INDEX_EXPRESSION` already covers it.
- `null` literal: add a primary-expression case producing `NULL_LITERAL` node. No `.value` field - the type is target-pinned.
- `unsafe_ptr.cast<U>(p)`: parsed via the existing `FIELD_ACCESS` + `CALL_EXPRESSION` paths once the typechecker treats `unsafe_ptr` as a built-in namespace. Recognize the `<` after the field-access name in primary-position when the callee head is `unsafe_ptr.cast` - implemented in the typechecker rather than the parser to keep `peekahead` shallow.

  Pragmatic simplification for 8.A: parser accepts the literal token sequence `unsafe_ptr . cast < TypeAnnot > ( expr )` in a tiny dedicated production at the same precedence as a primary call. Generates `UNSAFE_PTR_CAST { typeArg, operand }`. Same for `unsafe_ptr.toInt(p)` and `unsafe_ptr.fromInt<T>(n)`. These are intrinsics, not real namespace calls - keeping them in a dedicated production avoids any change to expression-level `<` handling.

### 8.A.3 - Typechecker

- New AST kinds in [src/contracts.js](../src/contracts.js): `ADDRESS_OF_EXPRESSION`, `DEREF_EXPRESSION`, `NULL_LITERAL`, `UNSAFE_PTR_CAST`. (`unsafe_ptr.toInt` / `fromInt` can reuse `UNSAFE_PTR_CAST` with a `castKind: "toInt" | "fromInt" | "bitcast"` discriminator.)
- `UnsafePtrType(pointee, opts?)` constructor in [types.js](../src/jsyooptypecheck/types.js).
- New PrimType: `uintptr`. Lower it to a 64-bit unsigned integer for now; document as platform pointer width.
- `resolveTypeAnnotation()`: handle `{ kind: "unsafePtrType", inner }` → `UnsafePtrType(resolveTypeAnnotation(inner))`. Bubble through the `allowsUnsafe` check; error if the current module doesn't permit unsafe.
- `resolveExprType()` cases:
  - `ADDRESS_OF_EXPRESSION`: assert lvalue, return `UnsafePtrType(operandType)`. Requires `allowsUnsafe`.
  - `DEREF_EXPRESSION`: assert operand is `UnsafePtrType`, return `pointee`. Requires `allowsUnsafe`.
  - `NULL_LITERAL`: return a placeholder `untypedNull` (similar to `untypedInt`/`untypedFloat`). Pinned by `checkInitializer` and by call-argument / return / comparison contexts.
  - `UNSAFE_PTR_CAST` (variant `bitcast` / `toInt` / `fromInt`): per the table above.
  - Binary-op resolver: detect `UnsafePtrType` operand(s) and branch to pointer arithmetic rules.
  - Comparison resolver: extend to accept ptr/ptr and ptr/null forms.
- `coerce.js`: `isAssignable(target, source)` - `UnsafePtrType<T>` accepts `untypedNull`. No implicit ptr-to-ptr conversion across pointees (must `unsafe_ptr.cast`).
- `pure` checker: walk the body once `allowsUnsafe` is true on the module, flag any `unsafe_ptr` references inside a `pure` function body.
- Fallible / `?` / `propagates`: no change. Pointers don't carry `err`.

### 8.A.4 - Codegen

- `UnsafePtrType` → LLVM `ptr` everywhere (struct fields, locals, return values, params).
- `ADDRESS_OF_EXPRESSION`: emit the LLVM address of the lvalue (i.e. skip the final load that codegen normally inserts for rvalue use of a variable). Yoop lvalues already use `alloca`-backed slots, so this is "use the alloca pointer directly."
- `DEREF_EXPRESSION` rvalue: emit `load <pointeeTy>, ptr %p`. In lvalue position: skip the load, hand the `ptr` to the assignment emitter.
- Pointer arithmetic: emit `getelementptr <pointeeTy>, ptr %p, i64 %n` for `p + n`. For `p - n`, negate `n` first. For `p - q`, emit `ptrtoint` on both sides, subtract, and divide by `sizeof(pointeeTy)` (LLVM provides this via a runtime constant - use `ptrtoint` and emit the `sizeof` constant directly from the typechecker's size table).
- Pointer index `p[i]`: same as `*(p + i)`.
- `UNSAFE_PTR_CAST` `bitcast`: no-op (LLVM ptrs are opaque).
- `UNSAFE_PTR_CAST` `toInt`: `ptrtoint ptr %p to i64`.
- `UNSAFE_PTR_CAST` `fromInt`: `inttoptr i64 %n to ptr`.
- `NULL_LITERAL` of type `UnsafePtrType<T>`: emit the LLVM constant `ptr null`.
- Pointer `==` / `!=`: emit `icmp eq ptr` / `icmp ne ptr`.

No mangling change. No symbol-table change. Codegen never sees `unsafe_ptr` as a generic instantiation - `UnsafePtrType` is a primitive shape, not a generic struct.

### 8.A.5 - Verification

- Unit tests colocated with each touched file:
  - [src/jsyooparser/parser.test.js](../src/jsyooparser/parser.test.js): `unsafe_ptr<T>` type annotation parses; prefix `&` / `*`; `null` literal; `import.unsafe;` accepted at top only.
  - [src/jsyooptypecheck/checkExpr.test.js](../src/jsyooptypecheck/checkExpr.test.js) (or new dedicated file): pointer arithmetic typing, mismatched-pointee error, null pinning, gating error without `import.unsafe;`.
- e2e fixture in [src/e2e.test.js](../src/e2e.test.js):
  - `examples/pass/unsafe_ptr_basic/` - calls libc `malloc` / `free` via `extern "C"`, writes through `*p`, reads back, frees, exits 0.
  - `examples/pass/unsafe_ptr_arithmetic/` - `malloc`s an array of `int32`, walks it via `p[i]` and `p + i`, sums, asserts.
  - `examples/fail/unsafe_ptr_no_import/` - using `unsafe_ptr<int32>` without `import.unsafe;` is a typecheck error.
  - `examples/fail/unsafe_ptr_pure/` - using a pointer inside a `pure` function fails.

## Out of scope (Phase 8.A)

- `unsafe_ptr<T>` ↔ `ref T` coercion. Use `*` + `&` (or explicit cast) explicitly each time.
- Ordered pointer comparisons `< <= > >=`. Add when needed.
- `volatile` / atomic loads. Defer.
- Pointer-to-function types. Yoop already lowers function values via a different path; mixing pointer-to-function into `unsafe_ptr<T>` is a separate design.
- Alignment-aware loads. We rely on the target's natural alignment of `T`; misaligned access is undefined.

## Files touched

- [SPEC.md](../SPEC.md) - §12 rewrite, §14 keyword list.
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) - add `null` keyword.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) - `import.unsafe;`, `unsafe_ptr<T>` type form, prefix `&`/`*`, `null`, cast intrinsics.
- [src/contracts.js](../src/contracts.js) - new AST kinds.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) - `UnsafePtrType`, `uintptr` prim, `untypedNull` placeholder.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js) - module-level `allowsUnsafe` flag plumbing, gating.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) - new expression cases, binary-op pointer arithmetic.
- [src/jsyooptypecheck/coerce.js](../src/jsyooptypecheck/coerce.js) - `null` pinning.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) - pointer LLVM lowering, GEP, ptrtoint/inttoptr.
