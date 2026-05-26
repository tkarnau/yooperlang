# Plan - Language papercuts surfaced while writing yoopbinder

## Context

Writing [tools/yoopbinder/main.yoop](../tools/yoopbinder/main.yoop) - a
~700-line yoop program that shells out to `clang -E`, tokenises the
output, parses C function declarations, and emits a yoop `extern "C"`
block - was the first non-trivial yoop *tool* (as opposed to a demo or
a std-lib module). It surfaced a cluster of small friction points that
each individually feel like a footnote but together kept extending what
should have been an afternoon's work.

These all look like things the language wants to handle better,
especially because the self-hosting work in [phase-10.md](phase-10.md)
and the package-system tooling in
[package-system.md](package-system.md) will hit every one of them
again - probably more than once.

Filed here as a single rollup rather than five separate plans because
they're related in flavour (parser / typecheck / codegen interactions
with idiomatic library code) and would naturally be picked up by the
same person in a single session.

## Issues, by impact

### Issue 1 - Unary `!` binds wrong with `&&` / `||`

**Severity: HIGH (parser bug, real, easy fix).**

#### Symptom

```yoop
function f(a: bool, b: bool): bool { return !a && b; }
```

Parser rejects this with `expected semicolon, got andand` at the `&&`.
Workarounds: parenthesise `(!a) && b`, or bind `let na: bool = !a;`
first.

Tight repro saved at `/tmp/not_test.yoop` while writing this plan; one
liner reproducer:

```
$ echo 'function main(): int32 { let a: bool = true; if (!a && false) {} return 0; }' \
    | node src/yoopiler.js /dev/stdin
expected semicolon, got andand
```

#### Cause

The Pratt-style precedence loop in
[src/jsyooparser/parser.js](../src/jsyooparser/parser.js) (precedence
table near [parser.js:52](../src/jsyooparser/parser.js#L52)) treats `!`
as a *prefix* operator that fully consumes its operand and returns - it
doesn't re-enter the binary-operator loop after producing the unary
result. So `!a` is the whole expression and the next `&&` is "after"
it, hitting the statement terminator path.

For comparison: `-a + b` parses fine (`-` is also unary), so the bug
may be specific to `!`'s handling rather than unary operators in
general. Worth a 10-minute read of the prefix-operator code to be
sure.

#### Fix

After emitting the unary `!` node, fall back into the precedence loop
the same way unary minus does. The fix should be tiny - probably 1-3
lines around the `!` handler.

#### Acceptance

- `!a && b`, `!a || !b`, `!(x.field) && y` all parse.
- Existing `!x` standalone still parses.
- Add unit tests next to the parser tests covering each shape.

---

### Issue 2 - Struct literals don't get target type inferred through generic-call args

**Severity: HIGH (most pervasive ergonomic friction in tooling code).**

#### Symptom

```yoop
let v: Vec<MyStruct> = vec.vec_new(8);
vec.vec_push(ref v, { field: 1, other: "x" });
```

Fails with `struct literal has no target type`. The workaround is to
bind the literal to a typed local first:

```yoop
let t: MyStruct = { field: 1, other: "x" };
vec.vec_push(ref v, t);
```

This shows up *everywhere* in tooling code. yoopbinder had ~15 of these,
each one a separate edit. Same shape in any collection-building loop.

#### Cause

[CLAUDE.md](../CLAUDE.md) already documents this under "Cross-cutting
invariants": *"Struct literals can't be typed standalone. A bare
`Foo { x: 1 }` returns an error from `resolveExprType`. Struct literals
must be pinned to a target type via `checkInitializer` (assignment RHS,
return value, call argument, etc.)."*

The call-arg case *should* work - `vec_push<T>(v: ref Vec<T>, item: T)`
unifies `T = MyStruct` from `v`, and the second argument's target type
is `T`. But the existing call-site generic inference pipeline in
[src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js)
walks args to *infer* `T`, then doesn't use the inferred `T` as the
*target type* for those same arg expressions in a second pass.

#### Fix

Two-pass call resolution for generic functions:

1. Pass 1 - walk args that can be type-checked standalone, unify with
   their param's `TypeParamType`s as today.
2. Pass 2 - for any arg that resolved to an "error" type *because* it
   needed a target (struct literal, array literal, untyped enum
   variant), re-check it with the now-known concrete param type as the
   target.

The instantiation registry in
[src/jsyooptypecheck/instantiate.js](../src/jsyooptypecheck/instantiate.js)
already has the machinery to substitute `TypeParamType` into a
concrete `StructType`; what's missing is a `checkInitializer`-style
second pass on the struct-literal args.

Untyped int/float literals already have a "deferred pinning" story
(see CLAUDE.md - they default per existing rules if every other arg
constraining the param is also untyped). Struct literals want the same
treatment but stricter: they should *fail* if T can't be inferred from
the other args, not silently default.

#### Acceptance

- `vec_push(ref v, { ... })` works when `v: Vec<T>` and the literal
  shape matches `T`.
- Same for `Result.Ok { ... }` and enum-variant constructors in call
  arg position.
- A diagnostic when the call has *only* struct-literal args and `T`
  can't be inferred, with a fix-it pointing at "bind the literal to a
  typed local first or annotate the call with explicit type args (once
  supported)".

---

### Issue 3 - Enum value equality (`==` / `!=`) not supported

**Severity: MEDIUM (workaround is verbose; recognised in std).**

#### Symptom

```yoop
enum Color { Red, Green, Blue }
function eq(a: Color, b: Color): bool {
    return a == b;   // not supported
}
```

The std workaround is in
[std/http/types.yoop:34-114](../std/http/types.yoop#L34-L114) -
`http_method_eq` is an 80-line nested switch that compares two enum
values by walking both. Real yooperlang code that wants enum equality
either writes a switch-of-switches per enum or sidesteps with int
constants.

The yoopbinder workaround was to abandon `enum CTokKind { ... }` and
use `const TK_IDENT: int32 = 0; const TK_NUMBER: int32 = 1; ...`
instead, losing the type safety of the enum. Self-hosting work and any
state-machine code will keep wanting `==` on enums.

#### Fix

Lower `a == b` on enum types to a tag comparison in codegen. Enum
ordinals are already stable `i32` tag values per Phase 7.5 (see
[CLAUDE.md](../CLAUDE.md) - "Enum and union are nominal types
alongside struct"); the typecheck can recognise `eq_op` over
`(EnumType, EnumType)` of the same type and emit
`%t = icmp eq i32 %tag_a, %tag_b`. `!=` symmetric.

For variant enums with payloads, `==` between two values needs to
also compare payloads - reasonable to *not* support that in this fix
and leave it for a follow-up (raise an explicit "use a switch for
payload-bearing comparison" diagnostic).

#### Acceptance

- `enum E { A, B, C }; let x: E = ...; let y: E = ...; if (x == y) {}` works.
- `==` between *different* enum types is still rejected (type mismatch).
- `==` between an enum and an int literal is rejected (no implicit
  conversion - the user wants to be explicit about tag access).
- Payload-bearing enums get a clear "this only compares tags; use
  switch for structural equality" diagnostic.
- `http_method_eq` in std can be replaced with `a == b` after the
  feature lands (good cleanup commit).

---

### Issue 4 - Opaque extern types via `ref T` trigger LLVM verifier errors when used in user functions

**Severity: MEDIUM (workaround documented; fix is real codegen work).**

#### Symptom

```yoop
extern "C" from library "SDL2" { type SDL_Renderer; }

function fill_circle(ref ren: SDL_Renderer, ...): void {
    SDL_RenderDrawLine(ren, ...);   // codegen emits a load on an unsized type
}
```

Hits LLVM verifier error: `loading unsized types is not allowed`.

Same shape with `FILE`, `SDL_Texture`, anything declared as
`type Name;` inside an `extern "C"` block.

Two existing workarounds in the codebase:

1. [twinstick/main.yoop:315-321](../examples/playground/twinstick/main.yoop#L315-L321)
   wraps the opaque handle in a yoop struct (`type Renderer { handle: ref SDL_Renderer }`)
   and passes `ref Renderer` to user helpers. The comment there
   explicitly documents the workaround.
2. yoopbinder used `unsafe_ptr<FILE>` everywhere instead of `ref FILE`
   for the file handles. Works but requires `import.unsafe;` and means
   no null-check ergonomics.

#### Cause

Codegen for `ref T` where T is an opaque extern (no body, no size)
emits a `load %struct.T` somewhere along the parameter-passing path
inside the *user* function. Extern-to-extern calls don't have this
problem because codegen passes those by raw pointer at the C ABI
boundary. The bug is in the codegen path for user functions that
*receive* a `ref OpaqueExtern` and forward it to another extern.

Probably one of: `emitCall` constructing an alloca + store + load for
the param ([codegen.js:emitCall](../src/jsyoopcodegen/codegen.js#L216)
area), or the function-entry alloca emission for `ref T` params
materialising a copy of the opaque struct.

#### Fix

Recognise opaque extern types in codegen and lower `ref T` for
them as a bare `ptr` value, no alloca/load. Track "this type has no
body" through the `StructType`/`extern type` machinery and emit IR
accordingly.

If that's invasive, an alternate fix is to make the parser auto-wrap
opaque extern types: any `type Name;` inside an `extern` block
generates a synthetic `struct Name { _opaque: i8 }` so they have a
size for LLVM's purposes. Less correct (sizeof goes wrong) but might
be a faster first step.

#### Acceptance

- `function helper(ref ren: SDL_Renderer): void { SDL_RenderClear(ren); }`
  compiles and runs.
- The Renderer/Texture/FILE wrapper structs in
  [examples/playground/sdl_demo](../examples/playground/sdl_demo/),
  [examples/playground/twinstick](../examples/playground/twinstick/),
  [examples/playground/sun_moon](../examples/playground/sun_moon/),
  and [tools/yoopbinder](../tools/yoopbinder/) can be removed (or kept
  for ergonomic disposable RAII but no longer required for
  correctness).
- Reproducer test in `examples/pass/` that takes a `ref FILE` through a
  user helper.

---

### Issue 5 - C-style `printf` format strings don't compose with yoop strings

**Severity: LOW (workaround is clear, fix is design-y).**

#### Symptom

```yoop
printf("got %d items: %s\n", n, name);   // garbled / wrong output
```

Yoop strings lower to a nul-terminated `ptr` (per
[src/jsyoopcodegen/codegen.js:321](../src/jsyoopcodegen/codegen.js#L321) -
`if (t.name === "string") return "ptr";`), which is what C's
`printf %s` wants. But the *format string itself* doesn't get
recognised by yoop as a format string - it's just a regular string -
and the varargs ABI passing is what `printf` reads.

In practice on macOS arm64 with template-literal-derived strings, the
format-string + vararg combination produced visibly garbled output
(stray "0" prefixes from return-value-of-prior-printf, etc.) when I
tried it in yoopbinder. Template literals worked because they pre-
concatenate everything into a single string with no `%`-codes.

#### Cause

Two related issues:

1. yoop's `printf` extern declaration is `function printf(fmt: string, ...): int32`.
   The `...` is variadic and yoop doesn't have a way to declare
   "format string + matching args" type-safely.
2. There's no convention encouraging template literals over C-style
   format. The std uses both inconsistently (mostly templates, but
   `printf("foo %d\n", x)` appears).

#### Fix

Two paths:

1. **Make template-literal `printf` ergonomic and document it as the
   only blessed form.** Add a `print(s: string)` / `println(s: string)`
   pair in `std/core` that's the recommended way and lowers to
   `fwrite(stdout)` directly. Then `printf` is for advanced/format
   cases only and the rule is "if you're touching format codes, use C
   convention deliberately." Light touch, mostly docs + a tiny std
   helper.
2. **Add a real format-aware printf.** New builtin or std function that
   the typechecker validates: `printf!("got %d items: %s\n", n, name)`
   typechecks `%d` against `n: int`, `%s` against `name: string`, and
   lowers correctly. Heavier; might be Phase 11+ scope.

Path 1 is the right v0 - it doesn't paper over the underlying issue
but it removes the daily friction. Path 2 is a real format-checking
story for later.

#### Acceptance

- A `print` / `println` helper exists in std/core and is used in all
  example programs in place of `printf("...")`.
- The std modules' use of `printf("...%d...", x)` is converted to
  template literals.
- The yoopbinder workaround comment can be removed.

---

### Issue 6 - argv access (DONE - keep on the list for the language-level promotion)

**Severity: DONE for tools (runtime helper landed). MEDIUM as a
language feature.**

#### Symptom

`function main(): int32` doesn't get argc/argv. Tools that want CLI
args have nowhere to read them from.

#### Current state

[runtime/yoop_args.c](../runtime/yoop_args.c) exposes `yoop_argc()`
and `yoop_argv(i)` (macOS via `_NSGetArgv`, Linux via
`/proc/self/cmdline`), wired into every binary via
[src/runtimeBuild.js](../src/runtimeBuild.js). yoopbinder uses them.

This is a workaround. The language-level story should be: user can
declare `function main(args: string[]): int32` and the entry-point
wrapper in codegen builds the `string[]` fat pointer from the C
argc/argv before calling user main.

#### Fix

In codegen's `main` emission ([codegen.js:3184-3190](../src/jsyoopcodegen/codegen.js#L3184-L3190)
area), recognise a `main(args: string[]): int32` signature and:

1. Always emit the C entry as `int main(int argc, char** argv)`.
2. Synthesise a fat-pointer `args` value from `(argv, (i64)argc)` and
   pass it to the user main.
3. Keep the existing `main(): int32` signature working for backwards
   compat (just ignore argv).

The runtime helpers can stay as a lower-level alternative for code
that needs them inside non-main functions, but the canonical CLI shape
becomes `function main(args: string[]): int32`.

#### Acceptance

- `function main(args: string[]): int32 { ... args[0] ... }` works.
- args[0] is the program name (matches C convention).
- Zero-arg `function main(): int32` still works.
- Update [examples/](../examples/) to use the new shape in any
  CLI-shaped programs (yoopbinder is the obvious one).
- The runtime `yoop_argc`/`yoop_argv` helpers stay available for
  non-main callers.

---

### Issue 7 - Investigate: Vec\<UserStruct\> may corrupt data in tooling-shaped code

**Severity: NEEDS INVESTIGATION (no isolated repro).**

#### Symptom

While writing yoopbinder, a `Vec<ParsedFn>` (where `ParsedFn` had a
`params: ParamOut[]` field with `ParamOut { yoop_type: string, name: string }`)
gave back wrong contents at read time. Specifically: after pushing 9
ParsedFn structs, iterating the Vec and reading `fns[0].params[0].name`
returned a string that belonged to a *later* ParsedFn's parsing
(e.g. `"char"` from `void greet(const char *name)` showing up as
param 0 of `int simple_add(int a, int b)`).

#### Repros tried

Three minimal repros tried while writing this plan, all in
`/tmp/vec_struct_repro{2,3,4}.yoop`:

- Vec\<Pair\> where Pair has two string fields, returned from a function
  in a wrapper struct, called multiple times - **passes correctly**.
- Vec\<Result\> where Result contains a heap_alloc'd Pair[], 9 elements
  pushed, iterated - **passes correctly**.
- Same shape with strings derived from `intr.string_from_bytes_unchecked`
  (matching the yoopbinder tokenizer) - **passes correctly**.

So the bug is real (yoopbinder reproducibly hit it, fixed by switching
to parallel `string[]` arrays in [tools/yoopbinder/main.yoop](../tools/yoopbinder/main.yoop)),
but minimal repros don't trigger it. Something about the interaction
between disposable Vec lifetimes, nested function calls, and the
specific shape of ParsedFn (which had 6 fields including bool, string,
and a fat-pointer field) is load-bearing.

#### Suggested investigation

1. Use git to recover the pre-fix version of `tools/yoopbinder/main.yoop`
   that had `ParamOut[]` instead of parallel `string[]` arrays. Build
   and run it under `lldb`. Inspect the actual addresses of each
   ParamOut buffer across multiple parse_params calls; check whether
   malloc is returning overlapping ranges or whether something else is
   stomping the data.
2. Look at `sizeOfType` for the ParamOut struct case
   ([codegen.js:2232-2241](../src/jsyoopcodegen/codegen.js#L2232-L2241)).
   For a struct of two `string` fields (each lowered to `ptr` of size
   8), the result should be 16. Verify with an emit of
   `getelementptr` indices.
3. Check `vec_push`'s grow-and-realloc path
   ([std/core/vec.yoop:43-61](../std/core/vec.yoop#L43-L61)) - the
   `new_data[i] = v.data[i]` element copy for struct T may have a
   subtle codegen issue.
4. Check whether `vec_get<T>(ref v, i): T` for struct T returns a
   proper struct copy or partial.

#### Acceptance

- Either: an isolated 50-line repro that reliably triggers the bug,
  plus a fix in codegen / vec.yoop / wherever.
- Or: confirmation that the bug doesn't exist (the yoopbinder symptom
  was something else), with a write-up of what was really happening,
  to retire this entry.

---

### Issue 8 - Disposable obligation annotation burden

**Severity: MEDIUM (mostly an inference / ergonomics fix).**

#### Symptom

Every local Vec binding in tooling code needs `let disposable v: Vec<T> = ...`
or the typechecker rejects it with "binding has unsatisfied obligation
from propagates\<disposable\>". yoopbinder ended up with ~10 `disposable`
keywords, all functionally identical ("this binding cleans up at scope
end").

Same for any local that owns a propagating type - the user always
wants `disposable` for "I'm not transferring this; clean up at scope
end" and the compiler always knows that's the only correct answer
(transfer would require an explicit `return` of the binding,
which the typechecker can see).

#### Cause

The kind-check in
[src/jsyooptypecheck/kindCheck.js](../src/jsyooptypecheck/kindCheck.js)
requires explicit user choice between auto-cleanup, manual dispose,
and transfer-up. This is the right *semantic* model but the syntax
makes the most common case (auto-cleanup) the most verbose.

#### Fix

Either:

1. **Make `let` bindings of propagating types default to auto-cleanup
   unless explicitly transferred** (returned, stored in a struct
   field that's then returned, passed to a `propagates<K>`-declaring
   function). Removes 90% of `disposable` keywords. Users who want
   manual dispose can write `Disposable.dispose(ref x)` explicitly,
   which already satisfies the obligation.
2. **Infer the keyword conservatively**: only auto-cleanup if the
   binding is *never* transferred in any reachable code path.
   Otherwise require the explicit keyword. This is what kindCheck
   already computes; just don't require the keyword when the answer
   is unambiguous.

Option 2 is safer (preserves the current behaviour exactly when
transfer happens, just removes ceremony when it doesn't). Should be a
small change to kindCheck's "unsatisfied obligation" emit path.

#### Acceptance

- `let v: Vec<int32> = vec_new(8); ... ` works when v is never
  returned/transferred - codegen synthesises the dispose at scope end.
- Explicit `let disposable v: Vec<int32> = ...` still works (no-op
  but accepted).
- `let v = vec_new(8); return v;` still errors with the original
  "function returns a propagating value; declare `propagates<K>`"
  diagnostic.
- yoopbinder, the std modules, and the playground demos can drop
  most `disposable` keywords.

---

## Suggested order

Priorities are about ROI per implementation hour, not pure severity.

1. **Issue 1 (`!` + `&&`)** - tiny parser fix, unblocks a class of
   conditions that today need parens or temp bindings.
2. **Issue 3 (enum `==`)** - one extra arm in the equality-op
   typechecker + codegen; removes the 80-line `http_method_eq` and
   any future variants. Big readability win per line of compiler
   change.
3. **Issue 2 (struct-literal generic inference)** - bigger lift but
   the most pervasive friction in real code. Should land before
   self-hosting work where this would compound across the whole
   compiler rewrite.
4. **Issue 6 (argv in main)** - small codegen change, makes CLI
   tools feel native instead of leaning on a runtime helper.
5. **Issue 8 (disposable inference)** - kindCheck change, mostly
   ergonomics; saves a lot of noise across std and tools.
6. **Issue 4 (opaque-extern `ref T` in user fns)** - real codegen
   investigation, but the workaround is already widely used and
   documented. Less urgent.
7. **Issue 5 (printf format strings)** - mostly a documentation +
   `print`/`println` helper rollout. Low engineering cost, low impact.
8. **Issue 7 (Vec corruption)** - needs an investigation pass first.
   Could turn out to be a non-issue or a real codegen bug; we don't
   know yet.

## What this *doesn't* cover

Out of scope for this rollup, but worth noting in case they come up
together:

- Lifetime tracking for `vec_as_array` borrows. Today the returned
  view dangles if the Vec is disposed; only convention prevents it.
  Real fix probably waits for whatever borrow story Phase 12+ has.
- C string vs yoop string conventions at FFI boundaries beyond
  printf - the codebase has consistent rules but they're spread
  across [CLAUDE.md](../CLAUDE.md) and
  [std/core/strings.yoop](../std/core/strings.yoop) comments.
- Template-literal parsing edge cases (none hit during yoopbinder,
  but escape-handling under `${expr}` interpolation is a known
  area).
