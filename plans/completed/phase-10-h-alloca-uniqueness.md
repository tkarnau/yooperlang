# Phase 10.H — Codegen alloca-name uniquification ✓ landed

> Codegen used to map every user-visible binding name 1:1 to an LLVM
> SSA slot (`let v` → `%v = alloca`). Two `case Option.Some { value: v }`
> arms in the same function each emitted `%v = alloca`, and clang
> rejected the module with `multiple definition of local value 'v'`.
> The cleansing pass, Phase 10.B and 10.C all hit this and worked around
> it by inventing unique payload names per arm. This sub-phase fixes
> the underlying gap.

## What landed

A small helper, `createLocalSymbols()` in
[src/jsyoopcodegen/codegen.js](../../src/jsyoopcodegen/codegen.js),
replaces the per-function `symbols = new Map()` initialization. The
helper exposes the existing Map-like surface (`set` / `get` / `has`)
plus four new operations:

- **`declare(name, type)`** — registers a local binding and allocates a
  *unique* LLVM slot name. The first declaration for a given name in
  the function gets `%name`; subsequent declarations get `%name.1`,
  `%name.2`, .... Returns the chosen slot string (with leading `%`).
  Every alloca emission for a user binding now goes through this.
- **`slotFor(name)`** — returns the current LLVM slot for `name`,
  honoring scope-stacked shadowing. Every IDENT reference, assignment
  target, ref operand, etc. that previously hard-coded `%${name}` now
  goes through this.
- **`enterScope()` / `leaveScope()`** — lexical scope frames. Each
  `declare` inside a scope is recorded on the frame; `leaveScope`
  restores the prior binding (or removes the entry entirely if there
  was no outer binding). The outermost scope is the function's params;
  every block, switch arm, for-loop body, and for-in body opens its
  own frame.

Wrapped sites:

| Site | What changed |
|---|---|
| Single + multi-module function param allocas | `declare(p.name, ty)` returns the slot used in the alloca + store |
| LET_DECL / CONST_DECL | `declare(node.name, declType)` |
| Destructure declarations | `declare(name, fieldType)` per binding |
| For-in loop variable (array + iterable paths) | `declare(node.loopVar, elemType)` |
| Switch arm pattern-binding allocas | `declare(fb.bindingName, fieldType)` |
| Task-binding sites (joined / pooled / pooled-copy / immediate) | `declare(node.name, taskType)` |
| `emitBlock` / `emitBlockStmt` | `enterScope()` / `leaveScope()` around the body walk |
| Each switch arm body | `enterScope()` before pattern bindings, `leaveScope()` after the body |
| Each for-in loop emission | `enterScope()` before the loop var, `leaveScope()` after the body |

Reads converted via a global rewrite (~28 sites): every
`%${node.name}`, `%${node.operand.name}`, `%${targetName}`,
`%${node.target.name}`, `%${operand.name}`, `%${node.initIdent}`,
`%${node.stepIdent}`, and `%${node.bindingName}` reference is now
`${symbols.slotFor(...)}`. The `%${p.name}.arg` parameter SSA register
names are intentionally left as-is — they're LLVM-level argument
identifiers, not alloca slots.

## Verification

- New positive fixture:
  [examples/pass/alloca_uniqueness.yoop](../../examples/pass/alloca_uniqueness.yoop)
  — four sibling `case Option.Some { value: v }` switches in one
  function, two sibling `if` blocks each with their own `let x`, and a
  nested shadowing scenario that exercises `enterScope` /
  `leaveScope`. Would fail to compile under the old codegen.
- Cleanup pass: [examples/pass/map_smoke/main.yoop](../../examples/pass/map_smoke/main.yoop)
  was using `ga_value` / `gb_value` / `gz_value` etc. as workaround
  names; reverted to plain `value: v` per arm. Tests still green —
  proves the fix actually removes the workaround.
- Full test suite green: **546 tests**.

## Out of scope

- **Renaming user-visible bindings inside diagnostics.** The
  typechecker still reports errors using the source-level name (`v`),
  not the mangled slot (`%v.1`). That's the right behavior — error
  text should read the way the user wrote it.
- **`%${p.name}.arg` parameter SSA names.** Those are LLVM SSA
  identifiers for the incoming parameter value, not alloca slots; they
  don't collide and don't need uniquification.
- **Cross-function deduplication.** Each function emission starts a
  fresh `createLocalSymbols()`; the `.1`/`.2` suffixes are scoped to
  one function only.

## Critical files touched

- [src/jsyoopcodegen/codegen.js](../../src/jsyoopcodegen/codegen.js)
  — `createLocalSymbols` factory, ~7 alloca-site conversions, ~28
  reference-site conversions, scope wraps around `emitBlock` /
  `emitBlockStmt` / switch arms / for-in.
- [examples/pass/alloca_uniqueness.yoop](../../examples/pass/alloca_uniqueness.yoop)
  — new positive fixture.
- [src/e2e.test.js](../../src/e2e.test.js) — fixture registration.
- [examples/pass/map_smoke/main.yoop](../../examples/pass/map_smoke/main.yoop)
  — reverted workaround names.
