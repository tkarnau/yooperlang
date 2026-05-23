# Phase 6.4 — Containment and propagation

Part of [phase 6 — kinds](./phase-6-kinds.md). Sub-phases 6.1–6.3 landed the kind-declaration syntax, flow analysis for `mustCall`/`mustNotEscape`/`mustNotShare`, the task runtime, and the `task`/`joined`/`pooled` language sugar. Each of those sub-phases left explicit deferrals waiting for *cross-type kind flow*: a binding whose type carries a kind obligation. 6.4 is that piece.

## Context

The single-binding case is handled. `disposable f = open(p)` works; `joined d = compute(5)` works. The break point is when a kind-carrying value moves through a struct field or a function return:

- 6.2 rejects `field: scoped FileHandle,` with the literal message *"kind-bearing fields require `propagates<K>` or `contains<K>` on the enclosing struct (phase 6.4)"* — see [phase-6-2-escape.md:86](./phase-6-2-escape.md#L86).
- 6.3 rejects `pooled`-to-`pooled` assignment and `pooled`-as-argument with *"Lift in 6.4 alongside `propagates<Task>` containers"* — see [phase-6-3-task.md:519](./phase-6-3-task.md#L519).
- 6.1 rejects cross-module kind import with *"6.4 concern; it pairs with `propagates<K>` across module boundaries"* — see [phase-6-1-disposable.md:87](./phase-6-1-disposable.md#L87).

6.4 is the smallest scope cut that retires all three at once.

### The generics non-issue

A reasonable worry: the SPEC's headline example for this section is `conn: disposable net<Bytes>` ([SPEC.md §6](../SPEC.md#L454)), which is generic. Generics are deferred to phase 7. Does 6.4 still make sense?

Yes. `propagates<K>` and `contains<K>` look generic-shaped but `K` is a **kind name** — an identifier resolved against the kind table, not a type parameter. The angle-bracket syntax is purely cosmetic from the typechecker's perspective. Every concrete struct in 6.4 is monomorphic: it holds a `FileHandle`, or a `Task<int32>` (compiler builtin from 6.3), or another concrete struct. No type-variable substitution is needed. When user generics arrive in phase 7, `Vec<T> propagates<disposable>` will reuse 6.4's machinery unchanged — the kind-name slot stays the kind-name slot.

## Goal program

A two-module fixture proving every piece end-to-end. `io.yoop`:

```yoop
export trait Disposable { function dispose(ref self): void; }

export kind disposable {
    requires Disposable;
    ownsBlock;
    mustCall dispose beforeScopeEnd;
}

export type FileHandle implements Disposable {
    fd: int32;
    function dispose(ref self): void { /* close(self.fd) */ }
}

export function open(path: string): FileHandle { /* ... */ }
```

`main.yoop`:

```yoop
import { disposable, FileHandle, open, dispose } from "./io.yoop";

type Session propagates<disposable> {
    handle: disposable FileHandle,
}

function load_session(path: string): Session propagates<disposable> {
    return { handle: open(path) };
}

task fetch(url: string): int32 { return 42; }

type Job propagates<Task> {
    work: Task<int32>,
}

function launch(url: string): Job propagates<Task> {
    pooled h = fetch(url);
    return { work: h };
}

function take_pooled(pooled h: Task<int32>): int32 {
    return wait h;
}

function main(): int32 {
    let s: Session = load_session("x.txt");           // s is disposable-by-propagation
    let j: Job = launch("https://example.com");        // j is Task-by-propagation
    pooled h2 = fetch("https://example.com/2");
    pooled h3 = h2;                                    // pooled-to-pooled assignment
    const n: int32 = take_pooled(h3);                  // pooled-as-argument
    // compiler-synthesized at this `}`, in LIFO order:
    //   release j.work; release h3; release h2; dispose(ref s.handle);
    return 0;
}
```

What this proves:

1. Cross-module kind import (`disposable` flows from `io.yoop` to `main.yoop`).
2. `type Session propagates<disposable>` lets `Session` carry a `disposable FileHandle` field, and a binding `s: Session` inherits the `mustCall dispose` obligation.
3. The compiler synthesizes `dispose(ref s.handle)` at scope exit.
4. `function f(...): T propagates<K>` is a typecheck-equivalent of declaring the binding with kind `K`.
5. `propagates<Task>` lets a struct hold a `Task<int32>` field with refcount lifecycle.
6. `pooled`-as-parameter inserts `TASK_RETAIN` at the call site and `TASK_RELEASE` at the callee's scope exit.
7. `pooled`-to-`pooled` assignment inserts a `TASK_RETAIN` on the source and a `TASK_RELEASE` at the new binding's scope exit.
8. Multi-kind syntax (`propagates<disposable, scoped>`) parses (one fixture exercises it; the goal program doesn't need both).

## In scope

### Parser

1. **`propagates<K1, K2, ...>` clause on struct decls.** After `type Name`, before `{`. Comma-separated, angle-bracketed, one or more kind-name identifiers. Lowered to a list on the `typeDecl` AST node.
2. **`propagates<K1, K2, ...>` on function return types.** After `: ReturnType`, before `{` or `;`. Same shape. Lowered to a list on the `functionDecl` node.
3. **Field kind prefix.** Already accepted by the parser in 6.2 (rejected at typecheck). 6.4 keeps the parser unchanged here; the typechecker stops rejecting.
4. **`pooled` parameter prefix.** The kind-on-parameter parser from 6.2 (`function f(scoped x: ...)`) already covers this — `pooled` is now legal at the parameter site once the built-in kind table grants it `appliesTo binding parameter`.
5. **`contains<K>` parses but is rejected** at typecheck with *"contains not yet supported (phase 6.5 or later)"*. The parser shape is identical to `propagates`, so the work is one shared production.

### Typechecker

1. **Cross-module kind import.** Extend [src/jsyooptypecheck/imports.js](../src/jsyooptypecheck/imports.js) to recognize `KindType` entries in the exported-symbols table; export `kind disposable { ... }` when prefixed with `export`. A `KindType` imported into module M is reachable under its bare name in M's `kindTable`. Identity is by `(originModuleId, name)` — re-importing the same kind into a third module preserves identity.
2. **`propagates<K>` validation on struct decls.** For each kind named, resolve against the module's kind table. Then walk the struct's fields: every field whose type or kind-prefix carries an obligation matching one of the propagated kinds is now legal. A field whose obligation is *not* in the propagated set is rejected (the struct silently absorbing an obligation is exactly the case `contains<K>` is reserved for).
3. **`propagates<K>` on function return types.** Validate that the kind is in scope. The function's resolved return type gains a `propagatedKinds: KindType[]` slot.
4. **Binding-kind inheritance.** When a binding's RHS resolves to a struct type with `propagates<K1, K2>`, or to a call of a function with `propagates<K1, K2>` on its return type, the binding behaves as if the user had written `K1 K2 binding: T = ...`. Specifically: for each propagated kind, register the same obligations the explicit-prefix path registers (the `validateKindBinding` machinery from 6.1/6.2). The plumbing is in [src/jsyooptypecheck/kindCheck.js](../src/jsyooptypecheck/kindCheck.js).
5. **Cleanup target for propagated obligations.** A `mustCall dispose beforeScopeEnd` obligation on a binding of type `Session` (which propagates `disposable` from field `handle`) lowers to `dispose(ref binding.handle)`. The compiler walks the struct's field list and emits one cleanup call per kind-carrying field. (Multiple fields carrying the same kind: cleanups fire in field-declaration order.)
6. **`pooled` parameter and assignment.** Already rejected in 6.3 with "deferred"; lift the rejection. Track copy sites in kindCheck: a `pooled` parameter receives a retained reference (`TASK_RETAIN` inserted at the call site, `TASK_RELEASE` at the callee's scope exit). A `pooled x = other_pooled` assignment inserts `TASK_RETAIN` on `other_pooled` and registers a `TASK_RELEASE` obligation on `x`.
7. **Reject `contains<K>`.** Single sentinel rejection point.

### Codegen

The cleanup-emission path already exists ([src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js); each `CLEANUP_CALL` / `TASK_AUTO_WAIT` / `TASK_RELEASE` / `TASK_RETAIN` node is lowered at every exit point). 6.4 emits the same node kinds with no new variants — only the *insertion sites* and *target expressions* change:

1. **Propagated dispose**: `CLEANUP_CALL` with callee `dispose` and argument `ref binding.field` (GEP into the struct, then ref). The walker enumerates propagated kinds × matching fields per binding.
2. **Pooled return through struct**: when a function returns a struct whose `propagates<Task>` field is a `Task<T>`, the return path is already balanced by 6.3's retain-before-return rule — extend the rule to walk struct-literal field-values and retain each `pooled` it contains.
3. **Pooled parameter and pooled-to-pooled assignment**: emit `TASK_RETAIN` at the call site / RHS, `TASK_RELEASE` at the new binding's (or parameter's) scope exit.

No new LLVM intrinsics, no new runtime ABI symbols.

## Out of scope (deferred)

- **`contains<K>`.** Rejected with *"contains not yet supported (phase 6.5 or later)"*. Decision rationale: the propagation case is what every earlier sub-phase explicitly waited on; `contains` doesn't have a forcing deferral. Defer until a real use case appears.
- **Parameterized kinds in `propagates<K(n)>`.** Bare kind-name identifiers only. Phase 6.5 introduces `kind batchable(n: usize)` and only then does `propagates<batchable(8)>` need parser work.
- **User-declarable generic types.** Phase 7. As discussed in [Context](#context), 6.4's machinery doesn't depend on them.
- **`appliesTo type`.** Phase 6.5 (introduced via `simd_aligned`).
- **Transitive escape across propagated returns.** If `function leak(s: Session): FileHandle { return s.handle; }` extracts a kind-carrying field by value, 6.4 still flags it via the existing 6.2 escape rule (the returned value's resolved type carries the kind). No new analysis needed; the existing rule covers it.
- **Propagation chains deeper than one level.** `Session propagates<disposable>` containing a field of type `Wrapper propagates<disposable>` is supported (the inner field's propagation is what makes the outer field carry the obligation), but propagation *composition* (declaring `Outer propagates<all-kinds-of-inner>` implicitly) is not. Every propagated kind is written explicitly on every level.

## Critical files

- [SPEC.md §6.5](../SPEC.md#L470) — containment and propagation surface syntax.
- [src/jsyooplexer/lexer.js](../src/jsyooplexer/lexer.js) — add `propagates`, `contains` keyword tokens (reserved in SPEC §15; not yet lexed).
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) — `parsePropagatesClause` shared between struct decls and function return types; reject `contains` at the same call site with the deferral message.
- [src/jsyooptypecheck/types.js](../src/jsyooptypecheck/types.js) — `StructType` gains `propagatedKinds: KindType[]`; `FuncType` gains `returnPropagatedKinds: KindType[]`.
- [src/jsyooptypecheck/imports.js](../src/jsyooptypecheck/imports.js) — kind export/import.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js) — field-with-kind-prefix now validated (was rejected); binding-kind inheritance from RHS struct/call.
- [src/jsyooptypecheck/kindCheck.js](../src/jsyooptypecheck/kindCheck.js) — propagated-obligation registration; `pooled` parameter/assignment retain/release tracking.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) — `CLEANUP_CALL` against struct-field GEP; struct-literal-return retain walking; `pooled` parameter prologue/epilogue retain/release.

## Verification

End-to-end against the goal program above (placed at `examples/pass/propagates_full/main.yoop` + `io.yoop`). Expected behavior:

1. Compiles cleanly; emitted LLVM IR shows, before `ret i32 0` in `main`:
   - `call void @__release_Task_int32(ptr %j_work)`
   - `call void @__release_Task_int32(ptr %h3)`
   - `call void @__release_Task_int32(ptr %h2)`
   - `call void @<modId>__FileHandle__dispose(ptr %s_handle)`
   in that order (LIFO over the bindings).
2. The compiled binary exits with status 0 and a small `printf` inside `take_pooled` confirms the wait returned 42.
3. `take_pooled`'s function prologue contains a retain on its `h` parameter; its epilogue contains the matching release.

Negative fixtures under `examples/fail/`:

- `propagates_missing.yoop` — `type S { f: disposable FileHandle, }` without a `propagates<disposable>` clause. Expect: *"field 'f' carries kind 'disposable' but enclosing struct 'S' does not propagate it"*.
- `propagates_unknown_kind.yoop` — `type S propagates<bogus> { ... }`. Expect: *"unknown kind 'bogus'"*.
- `contains_deferred.yoop` — `type S contains<disposable> { ... }`. Expect: *"contains not yet supported (phase 6.5 or later)"*.
- `pooled_to_int.yoop` — `let n: int32 = h;` where `h` is `pooled`. Expect: existing 6.3 type error (not a regression).
- `cross_module_kind_unexported.yoop` — `import { disposable } from "./io.yoop";` where `io.yoop` declared the kind without `export`. Expect: *"'disposable' is not exported from './io.yoop'"*.

Full regression: every fixture under `examples/pass/` and `examples/fail/` for sub-phases 6.1, 6.2, 6.3 continues to pass with no changes.

## What carries to 6.5

- The kind-list on `StructType.propagatedKinds` is the slot 6.5's parameterized kinds (`propagates<batchable(8)>`) extends — the slot stores a `KindRef { kind: KindType, args: KindArg[] }` rather than a bare `KindType` once parameters land.
- `contains<K>` parser shape is already written (rejected at typecheck); 6.5 (or whenever a use case appears) only needs to wire the semantic.
- Cross-module kind import is the path 6.5's `simd_aligned` and other library-shipped kinds will travel.
