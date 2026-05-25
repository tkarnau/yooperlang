# Phase 8.E - Module-level mutable state

## Context

The networking library will need at least one process-singleton - the
event-loop registry, an `epoll`/`kqueue` handle, a connection table - and
yoop currently has nowhere to put it. Today every `let` / `const` lives
inside a function body; module top is restricted to declarations
(`type`, `function`, `extern`, `trait`, `kind`, `enum`, `union`).

This phase lifts that restriction:

```yoop
let counter: int32 = 0;
const GREETING: string = "hello";

export let registry: Registry = { conns: [] };  // visible across modules

function tick(): int32 {
    counter = counter + 1;
    return counter;
}
```

The user also mentioned interest in **a future bytecode / compile-time
execution layer** (CTE - yoop programs running parts of themselves at
compile time, e.g. `comptime` blocks à la Zig). Module-level
initializers are the natural seam for that work - see the "Future:
bytecode + CTE injection points" section below for the architectural
callouts.

## Design

### Surface

- **`let name: T = expr;`** at module top - mutable, module-private.
- **`const name: T = expr;`** at module top - immutable, module-private.
- **`export let name: T = expr;`** / **`export const name: T = expr;`** -
  visible cross-module via named imports.
- Explicit type annotation **required**. No inference at module top - the
  signature is part of the module's contract.
- Initializer **required**. No uninitialized top-level state. The init
  expression is checked against the declared type.
- **No kind prefix** at module top in MVP. Kinds in 6.x carry obligations
  (mustCall, mustNotEscape, propagates) that only make sense inside a
  function scope. Defer to a follow-up if needed.
- **No `?` operator** at module top. The fallible-binding mechanism (Phase
  2 + 6.4) requires an enclosing function with a fallible return type;
  there's no such enclosing scope at module top. Initializer must produce
  a non-fallible value, or the module fails to load.

### Visibility and cross-module access

- Default visibility: **module-private**. Other modules can't read or write.
- `export let` / `export const`: visible cross-module via the existing
  named-import machinery. Importing a `let` gives the importer **read
  access**. Cross-module **write** access is rejected with a clear error
  ("`X` is an imported let; assignment from outside its module is not
  permitted"). Rationale: cross-module mutation is the highest-risk shape
  for global-state spaghetti. A real "shared mutable across modules"
  story can land later, scoped behind `import.unsafe;` if needed.

### Initialization order

Within a module: top-down, in source order.

Across modules: same topological order as imports (already computed by
[src/jsyoopdriver/moduleGraph.js](../src/jsyoopdriver/moduleGraph.js)).

**Cycles**: the module graph already rejects import cycles at load time -
no further work needed. A module's init function may freely reference
imported `let`s from already-initialized dependencies.

**Within-module ordering**: each module gets one synthesized init function
that runs every top-level let/const initializer in source order. If a
later init references an earlier one, that's fine - the earlier global
has been stored by then. If a *later* let is referenced by an *earlier*
init, the codegen will emit a load of the global's zeroinitializer
default. We don't try to detect this - same shape as forward references
to a struct field that hasn't been written yet. Documented foot-gun.

### Mutability

`let` allows reassignment from any function body in the same module.
`const` rejects reassignment with an error at the assignment site,
mirroring the function-scope behavior.

The existing `binding.kind = "const" | "let"` track on scope bindings
extends directly - module-level globals get the same field on their
`moduleSymbols` entry.

### Thread safety

**No synchronization.** A top-level `let` is shared mutable state.
Concurrent access from Task threads is a data race. The current
run-to-completion task runtime doesn't preempt, so this is theoretical
today, but the contract is explicit: users wanting safe sharing wrap the
value in a synchronization primitive (Phase 8.F's scheduler will likely
introduce one).

### Codegen layout

For each module M with top-level let/const decls:

1. **One LLVM `@global` per binding**: `@<modid>__<name>` with type
   `llvmType(declaredType)`. Initial value:
   - For a trivially-constant initializer (literal int/float/bool, or
     `null`), emit the constant directly as the initial value (no runtime
     init needed for that binding).
   - For everything else, emit `zeroinitializer` and emit a corresponding
     store into the module init function.
2. **One module-init function** per module that has *any* non-constant
   initializer: `@<modid>__module_init()`. Body emits the initializer
   expressions in source order, storing into the corresponding `@global`s.
3. **Sequencing**: at the top of `main`, just after `yoop_runtime_init()`,
   emit a call to each module's `__module_init` in topological order
   (using `mod.id` from the module graph).
4. **Linkage**: `private` for module-private, `external` for `export`ed.

References inside function bodies:

- **Read** of an IDENT that resolves to a module-level global: emit
  `load <T>, ptr @<modid>__<name>`.
- **Write** to it (when not `const`): emit `store <T> %v, ptr @<modid>__<name>`.

### Trivial-constant folding (MVP)

To keep the MVP scope small, do **bare-minimum** constant detection:
recognize `INT_LITERAL`, `FLOAT_LITERAL`, `BOOL_LITERAL`, `STRING_LITERAL`,
`NULL_LITERAL`, and the unary-minus-of-literal shape. Anything else goes
through the runtime init function.

This is intentionally less than a full constant folder. A real CTE pass
(see below) is the right place to grow this - duplicating folding logic
in codegen-land would be wasted work.

## Future: bytecode + CTE injection points

The user mentioned wanting to potentially layer a bytecode VM / CTE
mechanism on top of yoop later. Phase 8.E's module-init function is the
natural injection point. Spots to call out for that future work:

### 1. `mod.moduleInitDecls` - the AST list to evaluate

Phase 8.E stashes the list of top-level let/const decls onto the module
object as `mod.moduleInitDecls: [LET_DECL | CONST_DECL]` (a stable
ordered list). This list is:

- The single piece of program state that the synthesized init function
  produces.
- AST-level, with `resolvedType` on every node, ready for a generic AST
  evaluator.

A future CTE pass walks this list, attempting to evaluate each init's
`.assignment` AST under a small interpreter. Successful evaluations
become LLVM `@global` constants and the corresponding entries in the
init function are dropped. Failed evaluations fall through to the
runtime path.

### 2. `emit_module_init` is a discrete codegen entry point

[codegen.js](../src/jsyoopcodegen/codegen.js) gets a new function
`emitModuleInit(mod, ...)` that produces an LLVM function whose body
is exactly the runtime init for one module. It's:

- Parameter-free.
- Returns void.
- Operates only on the module's `@global`s.
- Identified by a stable symbol (`<modid>__module_init`).
- Has no implicit dependencies beyond its own module's imports being
  initialized.

A future VM can re-emit this same function from bytecode without changing
the codegen ABI. Or skip the LLVM emission entirely for modules whose
init is fully CTE-able.

### 3. Initializer classification

`isTriviallyConstant(initExpr)` lives in codegen and decides "emit as
LLVM constant" vs "emit as runtime store." For a future CTE layer, this
classifier should grow into `tryEvaluateAtCompileTime(initExpr, ctx)`
returning `{ ok, value }`. The MVP's narrow `isTriviallyConstant` is the
trivial base case of that richer predicate.

Suggested signature for the future:

```js
// In a future src/jsyoopcomptime/ module:
function tryEvaluateAtCompileTime(astNode, ctx): { ok: boolean, value?: any }
```

The same evaluator could later back a `comptime { ... }` block syntax.

### 4. Codegen never trusts user code at top level

The synthesized init function calls user code (e.g. a function defined
in the same module). Future CTE either needs to inline / interpret
those function bodies too, or refuse to fold initializers that call
user functions. The MVP doesn't fold them - runtime path only - so
this is a latent design choice for the CTE phase.

### 5. Init sequencing is data-driven

The "call every module's `__module_init` from `main`" sequencing is
emitted by walking the topologically-ordered module list. A CTE pass
can elide modules whose init has been fully folded.

These are the architectural seams. Phase 8.E does not implement any of
the CTE layer - only the MVP runtime path - but every codegen change
below is shaped so the CTE work can hook in without re-design.

## Sub-phases

### 8.E.0 - SPEC

[SPEC.md](../SPEC.md) §4 currently describes `let` / `const` inside
function bodies. Add a "Module-level state" subsection covering the new
allowed top-level forms, the mutability rules, the cross-module read
rule, and the no-thread-safety contract.

Note in the spec that initializers run after `yoop_runtime_init()` and
before `main`'s user code.

### 8.E.1 - Parser

[src/jsyooparser/parser.js](../src/jsyooparser/parser.js) `parseTopLevel`:
accept `TokenTags.let` and `TokenTags.const` at top level. Reuse the
existing `parseVarDecl` (or a thin wrapper that asserts no kind prefix +
explicit initializer). Set `node.isModuleLevel = true` on the resulting
AST node so downstream passes can disambiguate from function-scope
bindings without re-tracing the AST parent.

Continue to accept `export let` / `export const` via the existing
`parseExportDecl` path that wraps the inner decl in an `EXPORT_DECL`.

### 8.E.2 - Typecheck

[src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js):

- **Pass A**: when iterating `mod.ast.body`, recognize `LET_DECL` /
  `CONST_DECL`. Register a *shell* entry in `localSymbols` so other
  module-level decls can reference the name. The shell type is null
  initially - filled in pass C.
- **Pass B (imports)**: extend the cross-module symbol import to also
  resolve `LET_DECL` / `CONST_DECL` exports. The importing module's
  `localSymbols` gets the imported type and a marker `{ kind:
  "importedLet", fromModuleId, exportName }` for codegen to look up.
- **Pass C**: for each module-level let/const, resolve the type
  annotation, store on `localSymbols`, then check the initializer via
  `checkInitializer` against the declared type. Stash the decl onto
  `mod.moduleInitDecls` for codegen.

[src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js)
`resolveIdent`: when the name resolves via `moduleSymbols`, set
`node.isModuleGlobal = true` and (for cross-module imports) the
`(moduleId, exportName)` pair, so codegen can emit the right symbol.

[src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js)
`resolveAssignmentToIdent`: when the assignment target resolves to a
module global, allow if `let`, reject with a clear message if `const`
or if imported from another module.

### 8.E.3 - Codegen

[src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js):

- New `emitModuleGlobals(mod, ...)` - emits the `@<modid>__<name>`
  globals.
- New `emitModuleInit(mod, ...)` - emits `@<modid>__module_init` if any
  non-trivially-constant initializers exist.
- In `codegenProgram`, after emitting each module's user code, also emit
  its globals + init function.
- In `main` prelude (existing post-`yoop_runtime_init` slot), emit
  `call void @<modid>__module_init()` for each module that has one, in
  the topological order from `loadModuleGraph`.
- IDENT reads of a module global emit `load <T>, ptr @<sym>`.
- Assignment to a module global emits `store ... ptr @<sym>`.

Cross-module imports: resolve the global's symbol via the importer's
`localSymbols` entry's `(fromModuleId, exportName)` pair, mangled with
`__`.

### 8.E.4 - Demo

Two demos:

1. **`examples/pass/module_counter.yoop`** - single file. Top-level
   `let counter: int32 = 0;` + a `tick()` function. Main calls `tick()`
   three times and asserts the values.

2. **`examples/pass/module_state_cross/`** - two-file. `counter.yoop`
   has `export let counter: int32 = 0;` + `export function tick()`.
   `main.yoop` imports both, calls tick + reads counter, asserts.

A fail fixture exercises the "cannot assign cross-module imported let"
rule.

### 8.E.5 - Verification

Unit tests where the change lands. e2e wired into
[src/e2e.test.js](../src/e2e.test.js).

## Out of scope

- `comptime { ... }` blocks. Phase 8.E lays the seams (see "Future"
  section); the syntax + evaluator is a separate phase.
- Real constant folding. MVP recognizes only literal-shaped initializers
  for direct `@global` initial values.
- Cross-module mutation. Imported `let`s are read-only.
- Synchronized globals (atomics, mutex-wrapped). User-space concern.
- Top-level kind prefixes. Deferred.
- Module-level destructuring (`let { a, b } = ...;`). Deferred.
- Top-level fallible initializers + `?`. Defer with the kind-prefix work.

## Files touched

- [SPEC.md](../SPEC.md) - module-state subsection.
- [src/jsyooparser/parser.js](../src/jsyooparser/parser.js) - top-level
  let/const acceptance.
- [src/jsyooptypecheck/typecheck.js](../src/jsyooptypecheck/typecheck.js)
  - pass A/B/C registration of module-level bindings.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js)
  - `resolveIdent` global fallback, `resolveAssignmentToIdent`
  cross-module-read-only enforcement.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) -
  global emission, init function, sequencing.
- Demos + e2e wiring.
