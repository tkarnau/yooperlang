# Phase 11 — Compile-time execution + `@`-attribute namespace

> Supersedes the earlier `phase-testing.md` plan. That doc was framed
> around landing built-in testing support; the conversation that produced
> it pivoted to compile-time execution as the more foundational unlock,
> with testing (`@test` / `@expect`) deferred to a later phase that
> builds on the machinery this plan lands.

## Context

The existing pipeline is `src → lex → parse → typecheck → codegen
(LLVM IR) → clang → exe`. There is no facility to evaluate yoop code
*during* compilation: every literal-arithmetic init, every constant
table, every const-foldable initializer routes through a runtime
`<modid>__module_init` function that runs once at startup. Five
`(Bytecode/CTE future)` TODO comments scattered through the codebase
([typecheck.js:2430](../src/jsyooptypecheck/typecheck.js#L2430),
[typecheck.js:2538](../src/jsyooptypecheck/typecheck.js#L2538),
[checkStatement.js:203](../src/jsyooptypecheck/checkStatement.js#L203),
[codegen.js:2923](../src/jsyoopcodegen/codegen.js#L2923),
[codegen.js:3256](../src/jsyoopcodegen/codegen.js#L3256))
signpost where a compile-time evaluator would plug in.

This phase lands that evaluator, framed as a **typed register-based
bytecode IR** between typecheck and codegen plus an **interpreter**
written in JS. It also lands a general **`@`-attribute syntax** as a
compile-time / static-analysis directive namespace — `@`-prefixed
constructs are **always** compile-time effects (transformations,
checks, lowering hints). They are not C#-style metadata that a
running program queries; nothing about an `@`-attribute survives to
runtime as queryable metadata.

The first user-facing consumer is `@precompile { ... }` / `@precompile
expr` — evaluate this code at compile time, replace it with the
computed result. The interpreter is sized for **aspirational
robustness**: not "good enough to fold `2 + 3`," but "robust enough
that wrapping the SDL demo's pure logic in `@precompile` could
plausibly work modulo extern boundaries." Future `@`-attribute
consumers (`@test` / `@expect` / `@verify` / `@deprecated` / others)
are listed but **not implemented** here. They land as their own
follow-ups built on the machinery in this phase.

The intended outcome: comptime is a real architectural layer of the
language, not a shoehorned optimization. Module-init folding falls
out of it as a free side effect. Testing, macros-style AST
transforms, and any other compile-time DX work plug into the
attribute registry without re-litigating the surface.

## Surface — what users see

### `@`-attribute syntax (parser)

A new prefix token `@` and a new AST node `ATTRIBUTE`. Two parse
positions in this phase:

- **Declaration position** — `@ident(args?) decl-or-block` decorates
  a top-level decl. Example: `@precompile const TABLE = build_table();`
- **Statement position** — `@ident(args?)( ; | block | stmt )`
  appears inside a function body. Example: `@precompile { ... }` as
  a stand-alone statement.

Expression-position attributes (e.g. `@inline foo(x)`) are
**deferred** — no real consumer needs them yet, and avoiding the
precedence-table change keeps the surface contained.

Unknown attribute names are parse-time errors with a "did you mean"
hint listing the registry's known names. This means typos surface
immediately rather than silently being treated as no-ops.

### `@precompile` — the inaugural consumer

Two forms:

```yoop
// Statement form — evaluate the block at compile time. Body sees
// module scope only (no enclosing-fn locals). Side effects on
// module-level state persist into the compiled program as folded
// initial values.
@precompile {
    let cap: int32 = 256;
    let tbl: int32[] = heap_alloc(usize(cap));
    let i: int32 = 0;
    while (i < cap) { tbl[i] = i * i; i = i + 1; }
    PRIMES = tbl;  // module-level binding; its initial value is now folded
}

// Initializer form — evaluate the RHS at comptime; emit the result as
// an LLVM @global initial value. The runtime <modid>__module_init
// path never touches this decl.
@precompile const TABLE: int32[] = generate_table(256);
```

Failures (a comptime call hits a non-whitelisted extern, recursion
limit, mustCall obligation violation in the interpreter's view, etc.)
are **hard build errors** with a full yoop-source-line traceback —
never silent fallbacks. The explicit `@precompile` is a user
commitment.

The reverse pathway — implicit opportunistic folding of every module
init that *happens* to be comptime-evaluable — also lands as part of
this phase, but is silent-fallback (consistent with today's behavior:
if it can't be folded, it routes through the runtime module-init the
same way it does now).

### Other future attributes (not implemented here — registry shape only)

The registry is designed so each of these is a single entry +
handler set, not a parser/typechecker change:

- `@test { ... }` — test block (separate phase; testing is the next
  consumer once `@precompile` is solid)
- `@expect(cond)` — assertion inside `@test`
- `@verify(cond, msg)` — opt-in extra runtime check; semantics
  deferred until the user has a concrete forcing program
- `@deprecated("msg")` — emit a comptime warning at use sites
- Whatever else lands later

This plan does **not** specify or implement those. It only makes
sure the attribute registry can absorb them without redesign.

## Architecture

### Bytecode IR

**Register-based, typed, SSA-adjacent.** Every register has a static
yoop `Type` (the existing `Type` objects from
[src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js)). Typed
instructions let the interpreter dispatch correctly (e.g. `add.i32`
vs `add.f64`) and let a future verification pass run independently.

A stack machine is simpler but worse for typed-language fidelity —
yoop's struct-by-value semantics, real reference types, refcounted
`Task<T>` handles, and trait/vtable indirection are register-natural
and stack-painful. The "robust enough for the SDL demo" aspiration
tilts the call hard toward register.

Instruction categories (not opcode listing — listing is part of
implementation):

- **Arithmetic / logical / compare** — `iadd / isub / imul / idiv / irem`,
  `fadd / ... / frem`, `shl / shr / and / or / xor / not`,
  `icmp_<op>` / `fcmp_<op>`, bool ops.
- **Memory** — `alloca <Type>`, `load`, `store`, `gep_field <StructType> <fieldIdx>`,
  `gep_index <ArrayType>`, `array_len`. `alloca` returns a logical
  handle into the interpreter's value heap; addresses are not
  pointer-arithmetic-able.
- **Control flow** — `br <label>`, `brcond <reg> <then> <else>`,
  `switch_i32`, `ret <reg?>`.
- **Calls** — `call_direct <FuncRef> <args>`,
  `call_indirect <fnPtrReg> <FuncType> <args>` (for vtable +
  function-pointer-field calls from Phase 10.X.2),
  `call_trait <TraitName> <method> <receiver> <args>` resolved at
  lowering, `call_extern <ExternRef> <args>` (handled specially —
  see extern whitelist).
- **Structured / yoop-specific** — `variant_construct <EnumType>
  <variantIdx> <payload>`, `variant_tag`, `variant_payload_field`,
  `ref_make`, `ref_deref`, `try_op` (Phase 9.H/10.E `?` desugar).
- **Task / kind** — `task_spawn <FuncRef> <args>`, `task_wait`,
  `task_retain` / `task_release`, `cleanup_call <ImplRef> <binding>`
  matching the existing `CLEANUP_CALL` AST node so the interpreter
  doesn't re-derive lifetime logic — kindCheck.js's emitted
  cleanups become first-class IR.

### Interpreter

New directory **`src/jsyoopinterp/`** containing:

- `lower.js` — typecheck AST → bytecode. Per-node dispatchers mirror
  codegen's `emitStmt` / `emitExpr` shape.
- `bytecode.js` — instruction constructors, function / module
  containers, IR pretty-printer for diagnostics + `--dump-bc`.
- `interp.js` — evaluator. Frame stack + dispatch loop.
- `values.js` — wrapped-value constructors. Schema:
  - `{ ty: PrimType("int32"), v: <number> }` (BigInt for `int64` / `uint64`)
  - `{ ty: StructType(...), v: { fieldName: <wrapped>, ... } }`
  - `{ ty: ArrayType(elem), v: { buf: [...wrapped], len } }`
  - `{ ty: RefType(inner), v: { container, key } }` — refs are
    `(container, key)` pairs so `load`/`store` go through them with
    real reference semantics
  - `{ ty: EnumType(...), v: { tag, variantName, payload } }`
  - `{ ty: TaskType(T), v: { state, result, refcount, source } }`
  - `{ ty: VTableType(...), v: { ctx, methods } }`
  - `{ ty: FunctionPointerType(...), v: <FuncRef> }`
- `externWhitelist.js` — pure-extern allowlist. Initial set:
  `strlen` / `strcmp` / `memcmp` / `malloc` / `free` / `realloc` /
  `sqrt` / `pow` / `floor` / `ceil` / `fabs` / `abs` / `labs` /
  `isdigit` / `isalpha`, plus yoop runtime intrinsics that the
  interpreter natively models (`yoop_now_ns` → JS `Date.now()`,
  `yoop_errno_get` → 0, `yoop_runtime_init` /
  `yoop_runtime_shutdown` → no-op, `yoop_panic` → comptime build
  error). Anything else raises a "comptime evaluation cannot call
  extern `<name>` (not in the comptime-allowed list)" diagnostic
  with both the extern's source location and the call-site location.
- `diagnostics.js` — comptime error formatter that walks the frame
  stack and produces a yoop-source-line traceback, with generic
  monomorph frame names pretty-printed back to source form
  (`Map<string, int32>.insert` rather than the mangled
  `<mod>__Map__string__int32__insert`).

**Frame stack** uses a worklist dispatch loop, **not** JS recursion —
30-deep comptime recursion mustn't blow the host stack. Recursion
limit is configurable, default 1024 frames.

**Memory model**: every comptime value lives in the compiler's JS
heap. Comptime code that would touch real OS state (file I/O,
sockets, env vars, threads beyond the synchronous-inline task model)
fails through the extern-whitelist gate. `malloc` / `free` /
`realloc` are natively implemented inside the interpreter (backed by
a JS-side allocator), since rejecting them would kill collections at
comptime and therefore kill the SDL aspiration.

**Tasks at comptime** run synchronously inline: `task_spawn`
records the function + args, `task_wait` invokes the body
immediately and stores its result. `pooled` handles go through
`task_retain` / `task_release` with refcount discipline enforced —
the interpreter asserts on negative refcount. A `wait` on a handle
that hasn't been spawned-and-resolved is a comptime deadlock
diagnostic (trivially detectable since there are no other workers).

### Integration points

The comptime pass is a new pipeline stage invoked from
[src/yoopiler.js](../src/yoopiler.js) **after** typecheck returns clean
and **before** `codegenProgram`. It:

1. Walks every module's AST collecting `@precompile` attributes
   (block + initializer forms).
2. For each, lowers its target to bytecode via `lower.js`, runs the
   interpreter, splices the result back into the AST (replacing the
   `@precompile` node with a constant `INT_LITERAL` /
   `STRING_LITERAL` / `ARRAY_LITERAL` / `STRUCT_LITERAL` node, or
   eliding it entirely for block forms whose only effect was on
   module-level state).
3. Opportunistically lowers each `mod.moduleInitDecls` entry and
   tries to fold it. On success, stamps `decl.comptimeValue` for
   codegen to consume as the LLVM `@global` initial value. On
   failure, leaves the decl alone — runtime module-init handles it
   the way it does today.

Codegen ([codegen.js](../src/jsyoopcodegen/codegen.js)) changes:

- Honor `decl.comptimeValue` when emitting module globals
  (replaces the `zeroinitializer` at
  [codegen.js:2938](../src/jsyoopcodegen/codegen.js#L2938)).
- The synthesized `<modid>__module_init` skips folded decls.
- Reject any `@`-attribute AST node that survives to codegen with
  an internal-error diagnostic — every attribute consumer must
  consume its node before this point.

**No existing program changes runtime behavior** from this addition.
That is load-bearing — opportunistic folding is a silent
optimization; only explicit `@precompile` failures can surface.

## Phasing

Five sub-phases. Each is intended to be landable on its own with
useful intermediate state. Total: ~4,600 LOC across 5-6 weeks of
focused work — comparable to Phase 6 (kinds) in scope.

### 11.A — `@`-attribute lexer/parser + registry skeleton (~600 LOC, 4-5 days)

- Lex `@` as a new single-char punctuation token (`at`).
- Add `ATTRIBUTE` to `ASTNodeKind` in [src/contracts.js](../src/contracts.js).
- Parser: `parseAttribute()` at statement position (inside
  [parseStatement](../src/jsyooparser/parser.js)) and declaration
  position (inside
  [parseTopLevel near line 539](../src/jsyooparser/parser.js#L539)).
- `attributeRegistry` table in JS mapping `@name` → `{ parsePhase,
  typecheckPhase, comptimePhase, codegenPhase }` handlers.
- Land `@precompile` *parsing only* in this sub-phase — the handler
  errors with "comptime engine not yet implemented (Phase 11.C
  pending)" until 11.C wires it up. This proves the registry
  end-to-end without needing the interpreter.
- Unknown-attribute diagnostic with Levenshtein-based "did you
  mean" suggestion.
- Verification: a passing fixture with a parseable `@precompile`
  attribute that errors at the registry handler step; a failing
  fixture with `@unknown` showing the suggestion.

### 11.B — Bytecode IR + minimal interpreter (~1500 LOC, 1.5 weeks)

- `src/jsyoopinterp/` with `bytecode.js`, `lower.js`, `interp.js`,
  `values.js`, `externWhitelist.js`, `diagnostics.js`.
- Instruction set covers: arithmetic, memory, control flow, direct
  calls, struct / array / ref ops, enum variant
  construct/match. **Does not yet cover** tasks, generics, vtables,
  kind-flow cleanup calls — those land in 11.E.
- New comptime pass in [src/yoopiler.js](../src/yoopiler.js) between
  typecheck and codegen. **Opportunistic module-init folding only**
  in this sub-phase; no user-facing `@precompile` yet. Failures are
  silent fallbacks.
- Codegen consumes `decl.comptimeValue` to emit LLVM `@global`
  initial values where possible.
- Verification: `examples/pass/module_init_folded.yoop` produces an
  LLVM `@global` with the literal value baked in; unit tests for
  each instruction category in `src/jsyoopinterp/interp.test.js`.

### 11.C — `@precompile` consumer wired to the interpreter (~600 LOC, 1 week)

- `@precompile` registry handler now invokes `lower.js` + the
  interpreter; AST splicing replaces the attribute node with the
  computed result.
- Failures here are **hard errors** with full traceback (unlike
  11.B's silent fallback for module-init folding).
- Non-whitelisted-extern diagnostic with both call-site and
  extern-decl source locations.
- Verification: `examples/pass/at_precompile_block.yoop`,
  `examples/pass/at_precompile_expr.yoop`, and
  `examples/fail/at_precompile_disallowed_extern.yoop`.

### 11.D — Interpreter feature completeness (~1500 LOC, 2 weeks)

- Generic-function instantiation at comptime via the existing
  [instantiate.js](../src/jsyooptypecheck/instantiate.js) registry.
  The interpreter reuses the same monomorphization path as codegen.
- Vtable indirect dispatch.
- `Task<T>` synchronous-inline semantics + refcount discipline.
- Kind-flow `cleanup_call` execution.
- Fallible-enum `?` (Phase 9.H + 10.E lowering).
- Verification acid test: a stripped-down version of the SDL
  demo's table-generation logic runs under `@precompile`.

### 11.E — Diagnostic + driver polish (~400 LOC, 3-4 days)

- `--dump-bc` flag dumps the lowered bytecode for a given module
  (debugging the comptime pass).
- Pretty traceback rendering with monomorph-name reverse mapping.
- Recursion-limit + memory-budget configurable via env vars.
- Comptime `printf` writes to stderr with a `[comptime]` prefix so
  it doesn't intermingle with the compiler's own output.

## Critical files

- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — add `at`
  token + scanner entry.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) —
  attribute parsing in `parseTopLevel` (~line 539) and
  `parseStatement`.
- [src/contracts.js](../src/contracts.js) — `ATTRIBUTE` AST node kind.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js)
  — attribute typecheck phase dispatch; `mod.moduleInitDecls`
  already exists at line 2433 as the natural input for module-init
  folding.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js)
  — `validateModuleInit` at line 207 stays as the typecheck call
  site; the comptime fold attempt moves into the new pass.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) —
  honor `decl.comptimeValue` when emitting `@global`s at line
  2938; the `(Bytecode/CTE future)` comments at lines 2923 and
  3256 are the exact integration sites.
- [src/yoopiler.js](../src/yoopiler.js) — add comptime pass
  invocation between typecheck and codegen.
- **New**: `src/jsyoopinterp/` — entire directory.
- Reuse the existing
  [instantiate.js](../src/jsyooptypecheck/instantiate.js) registry
  from Phase 7.1 for generic monomorphization (11.D).
- Reuse the `CLEANUP_CALL` AST node already emitted by
  [kindCheck.js](../src/jsyooptypecheck/kindCheck.js) so the
  interpreter doesn't re-derive lifetime logic.

## Verification

End-to-end, per sub-phase, using the existing `node --test`
infrastructure + `src/e2e.test.js` fixtures:

- **11.A**: `examples/pass/at_attribute_parse_smoke.yoop` parses;
  `examples/fail/at_unknown_attribute.yoop` errors with "did you
  mean" suggestion; running the binary still works (no behavior
  change in absence of attributes).
- **11.B**: `examples/pass/module_init_folded.yoop` produces an LLVM
  `@global` with a literal initial value (verify via
  `--dump-llvm`); `examples/pass/module_init_fallback.yoop` (init
  calls a non-whitelisted extern) silently falls back to runtime
  init and still produces correct runtime output. Unit test suite
  in `src/jsyoopinterp/interp.test.js` covers each instruction
  category in isolation.
- **11.C**: `examples/pass/at_precompile_block.yoop` and
  `examples/pass/at_precompile_expr.yoop` both produce constant
  `@global`s and run correctly; the original code's effect on
  module state matches running the equivalent runtime version.
  `examples/fail/at_precompile_disallowed_extern.yoop` errors with
  both source locations named.
- **11.D**: `examples/pass/at_precompile_generic.yoop` (generic
  call), `examples/pass/at_precompile_vtable.yoop` (vtable indirect
  dispatch), `examples/pass/at_precompile_task.yoop` (synchronous
  task). Acid: a SDL-demo-style pure-logic fixture (no SDL externs)
  runs under `@precompile` and produces identical output to a
  non-`@precompile` build.
- **11.E**: `--dump-bc` produces readable bytecode IR for a chosen
  module; traceback fixture verifies monomorph names render in
  source form.

Each sub-phase also runs the full existing `npm test` to confirm no
regression.

## Open questions / decisions during implementation

1. **`malloc`/`free` at comptime backed by JS heap** — recommended
   above. Decision needed before 11.B starts: is this the right
   semantics, or should it be opt-in (`@precompile_alloc`-style)?
   Default recommendation: native, no opt-in needed. Collections
   *need* this.

2. **Module-init folding silent-fallback vs warn-fallback** —
   recommended silent so existing programs don't suddenly grow
   warnings. Could expose `--warn-unfolded-inits` as a developer aid.

3. **Self-hosting (Phase 10.K) interaction** — the self-hosted
   compiler will eventually want comptime too, which means the
   bytecode IR + interpreter become language primitives the yoop
   port has to reimplement. Recommendation: defer comptime to a
   post-self-host phase; document in `CLAUDE.md` that any `std/`
   code written between now and self-host **must not depend on
   `@precompile`** for correctness, only for optimization.

4. **`std/debug.assert` retention** — outside this plan but adjacent.
   Phase 10.D left release-mode gating as a follow-up. With
   `@`-attributes landed, a future `@assert(cond, msg)` could
   replace `std/debug.assert` entirely. Defer until a forcing
   program shows up.

5. **Recursion + memory budgets** — what are sensible defaults
   before users hit them in practice? 1024 frames + 64 MB JS heap
   for comptime values are guesses. Reassess in 11.E once real
   programs are running.

6. **Comptime determinism** — should the interpreter assert that
   evaluation is deterministic (no `Date.now()` results visible
   except through explicit clock externs, no order-dependent map
   iteration)? Recommend yes, but exact rules deferred until a
   real reproducibility need surfaces.

7. **Diagnostic surface for attribute discovery** — should a
   `yoopiler --list-attributes` flag enumerate the registered
   attributes for tooling? Cheap to add; defer to 11.E.
