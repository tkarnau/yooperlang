# Phase 10.X.2 — Function-pointer struct fields ✓ landed

> Two small lifts that unlock arbitrary function-pointer-typed struct
> fields: function-decl → `FunctionPointerType` coercion at assignment,
> and `struct.field(args)` lowering when the field has function-pointer
> type. Together they unblock vtable-like dispatch tables without going
> through the trait machinery — most importantly, a fully generic
> `Map<K, V>` keyed off a `KeyOps<K> { hash, eq }` ops struct (the
> deferred prerequisite from
> [phase-10-c-collections.md](phase-10-c-collections.md)).

## What landed

### Typecheck

- **Assignability** ([coerce.js:isAssignable](../../src/jsyooptypecheck/coerce.js))
  grew a `FunctionPointerType ← FuncType` branch. A top-level function
  decl is assignable to a matching FPT when the parameter and return
  types line up. Currently rejects variadic and `ref`-marked params
  on the source side — the FPT surface (`(p: T) => R`) doesn't model
  either.
- **Call resolution** ([checkExpr.js:resolveTryOp area](../../src/jsyooptypecheck/checkExpr.js)).
  The CALL_EXPRESSION dispatcher now checks whether the callee's
  resolved type is a FunctionPointerType *before* falling through to
  the generic "expression is not callable" error. A new helper
  `resolveFunctionPointerCall` validates arity, checks each arg
  against the FPT's param types, and stamps `node.fnPointerCall =
  true`. The node still routes through the normal expression code
  paths — only the call-emission step diverges.
- **Generic-call inference**
  ([checkExpr.js:unifyAgainstTypeParam](../../src/jsyooptypecheck/checkExpr.js))
  gained a `functionPointer` branch so a `K` buried inside an FPT-typed
  struct field still drives inference. Without this,
  `lookup<K>(ops: KeyOps<K>, k: K)` called as `lookup(my_ops, 42)`
  failed with "cannot infer type argument K".
- **Substitution + scanning** in [types.js](../../src/jsyooptypecheck/types.js):
  `substituteTypeParams` now walks `functionPointer` and `unsafePtr`
  (both were silently falling through `default` and returning
  unchanged); `typeHasTypeParam` got matching branches. Without the
  substitution branch, an open `KeyOps<K>` instantiated as
  `KeyOps<int32>` left the K inside `hash: (K) => uint64` un-substituted,
  and downstream typesEqual checks failed.
- **Diagnostic format** ([errors.js:formatType](../../src/jsyooptypecheck/errors.js))
  for `FuncType` was lifted to use the canonical `{name, type, isRef}`
  param shape — a pre-existing bug that only surfaced once the new
  isAssignable error message started printing FuncType. Adjusted the
  one unit test that depended on the broken shape.

### Codegen

- **IDENT-in-expression-position whose resolved type is FuncType**
  now lowers to the function's mangled symbol address
  (`@<moduleId>__<name>`). Without this, assigning a function name to
  an FPT-typed field tripped the "unknown identifier" check in
  emitExpr. Same module by default; imported decls route through
  the existing `calleeModuleId` / `calleeExportName` tagging.
- **Fn-ptr call lowering** in both single- and multi-module call
  emitters: when `node.fnPointerCall` is set, evaluate the callee as
  an rvalue (loads the slot), then `call <ret> <ptr>(args)`. No
  symbol name — the indirect call is purely value-driven.

## Verification

- New fixture: [examples/pass/fn_ptr_field.yoop](../../examples/pass/fn_ptr_field.yoop)
  defines `KeyOps<K> { hash, eq }`, seeds it with `{ hash: int_hash,
  eq: int_eq }` (function decls as values), and exercises both the
  through-the-call path (`lookup(ops, 42)`) and direct field calls
  (`equals(ops, 7, 7)`).
- Smoke-tested manually that the non-generic shape (`KeyOps {hash, eq}`
  with concrete types) also works.
- Full suite green: **547 tests**.

## What's now possible

The fully generic `Map<K, V>` shape from
[phase-10-c-collections.md](phase-10-c-collections.md)'s deferred list
is now expressible:

```yoop
type Map<K, V> implements Disposable propagates<disposable> {
    keys:   K[],
    values: V[],
    states: uint8[],
    len:    usize,
    used:   usize,
    cap:    usize,
    ops:    KeyOps<K>,
    function dispose(ref self): void { ... }
}

function map_new<K, V>(initial_cap: usize, ops: KeyOps<K>): Map<K, V>
    propagates<disposable> { ... }

// Caller:
let m: Map<int32, string> = map_new(16, { hash: int_hash, eq: int_eq });
```

`StringMap<V>` is still in `std/collections/map.yoop` and remains
the recommended path for string keys (less ceremony, FNV-1a hash + 
`string_eq` baked in). A `Map<K, V>` follow-up is now pure library
work — no further compiler features needed.

## Deferred

- **`ref`-param FPTs** (e.g. `(ref T) => U`). The parser doesn't
  currently accept ref params in FPT syntax. Not blocking present use
  cases.
- **Cross-module function-decl refs as FPT values**. The IDENT
  lowering handles same-module + imports tagged with
  `calleeModuleId`/`calleeExportName`, but the typecheck path for
  imported-function-as-FPT-value isn't directly exercised by current
  tests. Likely works (the lookup path is symmetric) but should be
  verified before relying on it for `std/collections/map<K, V>`.
- **FPT-to-FPT assignability beyond exact match**. Currently requires
  param/return `typesEqual`. Subtyping over function pointers is its
  own design question; defer until a concrete use case wants it.
- **Indirect calls through bindings of FPT type** (i.e. `let f: (p:
  int32) => int32 = some_fn; f(42)`). The path probably works
  already — emitExpr on an IDENT whose resolvedType is FPT loads the
  slot — but the call dispatcher's `fnPointerCall` check only fires
  on FIELD_ACCESS callees today. Lift if needed; small change.

## Critical files touched

- [src/jsyooptypecheck/coerce.js](../../src/jsyooptypecheck/coerce.js)
  — `isAssignable` FPT ← Func branch.
- [src/jsyooptypecheck/checkExpr.js](../../src/jsyooptypecheck/checkExpr.js)
  — `resolveFunctionPointerCall`, FPT-callee dispatch, FPT branch in
  `unifyAgainstTypeParam`.
- [src/jsyooptypecheck/types.js](../../src/jsyooptypecheck/types.js)
  — `substituteTypeParams` + `typeHasTypeParam` FPT (and unsafePtr)
  branches.
- [src/jsyooptypecheck/errors.js](../../src/jsyooptypecheck/errors.js)
  — `formatType` FuncType param shape fix.
- [src/jsyoopcodegen/codegen.js](../../src/jsyoopcodegen/codegen.js)
  — IDENT-as-fn-ptr-value emission, `fnPointerCall` indirect-call
  emission in both single- and multi-module call paths.
- [examples/pass/fn_ptr_field.yoop](../../examples/pass/fn_ptr_field.yoop)
  — new fixture.
- [src/e2e.test.js](../../src/e2e.test.js) — fixture registration.
- [src/jsyooptypecheck/errors.test.js](../../src/jsyooptypecheck/errors.test.js)
  — one unit test moved to the canonical FuncType param shape.
