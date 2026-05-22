# Yooperlang — Language Specification (v2 Draft)

Yooper - person from the Upper Peninsula of Michigan

A syntax-first specification for a fresh Yooperlang design.

Yooperlang (`.yoop`) is a **systems language with a TypeScript feel**:
no garbage collector, no classes, structs + free functions, types on the right,
and every behavioral contract (capability, lifetime, layout, iteration, concurrency)
expressed through two orthogonal mechanisms — **traits** and **kinds**.

This document is organized **syntax first, semantics briefly**. Each section shows
the form you will actually type, followed by a short note on what it means.

---

## 0. The three-layer model

Yooperlang separates three ideas that other languages tend to conflate:

| Layer | Role | Attached to | Example |
|---|---|---|---|
| **Trait** | Capability — operations a value supports | Types | `Disposable`, `Task<T>`, `Iterable<T>` |
| **Kind** | Usage contract — scoping, lifecycle, iteration, sharing rules | Bindings, parameters, fields, functions | `disposable`, `scoped`, `pooled`, `batchable(n)` |
| **Type** | Concrete data shape | Variables, fields | `int`, `FileHandle`, `Point` |

A **type** says *what the value is*. A **trait** says *what the value can do*. A
**kind** says *how the binding must be used*. Kinds can require traits (the value
must support certain operations) and can provide trait implementations (the kind
supplies the machinery for free).

This separation is what makes `async` go away: `task` is a kind applied to a function,
the return value implements the `Task<T>` trait, and concurrency-mode kinds on the
binding site (`scoped`, `pooled`) decide when the compiler forces the `wait`.

---

## 1. Files, modules, imports, and exports

Every `.yoop` file is a module. Imports use **relative paths** only.

```js
import { parse, lex } from "./lexer.yoop";
import * as lex        from "./lexer.yoop";
import { parse as p }  from "./ast.yoop";
import "./init.yoop";                    // side-effect only
```

The `.yoop` extension is required. Any top-level declaration can be exported:

```js
export type Token { ... }
export trait Disposable { ... }
export kind disposable { ... }
export task fetch(url: string): Bytes { ... }
export const MAX_SIZE: int32 = 1024;
export { parse, lex, Token };            // grouped at bottom of file
```

No `default` exports. Explicit names only.

---

## 2. Primitives and literals

### Integer types

| Type | Range | Notes |
|---|---|---|
| `int8` | −2⁷ … 2⁷−1 | two's-complement signed |
| `int16` | −2¹⁵ … 2¹⁵−1 | two's-complement signed |
| `int32`/`int` | −2³¹ … 2³¹−1 | two's-complement signed |
| `int64` | −2⁶³ … 2⁶³−1 | two's-complement signed |
| `uint8` | 0 … 2⁸−1 | unsigned; also the canonical byte type |
| `uint16` | 0 … 2¹⁶−1 | unsigned |
| `uint32` | 0 … 2³²−1 | unsigned |
| `uint64` | 0 … 2⁶⁴−1 | unsigned |
| `usize` | 0 … platform max | unsigned, pointer-width; used for sizes, indices, `xs.len` |
| `isize` | platform-signed | signed pointer-width; used for pointer differences |

### Floating-point types

| Type | IEEE-754 form |
|---|---|
| `float32`/`float` | binary32 (single) |
| `float64` | binary64 (double) |

### Other primitives

| Type | Literal examples | Notes |
|---|---|---|
| `bool` | `true`, `false` | |
| `char` | `'A'`, `'\n'`, `'\x41'` | evaluates to a `uint32` Unicode codepoint |
| `string` | `"hello"`, `"line\n"` | immutable, UTF-8, zero-terminated for C interop |
| `void` | — | function return only |

### Numeric literals

Integer and float literals are **untyped** until they reach a typed context, at which
point they're checked for range and coerced to the target type. No implicit widening or
narrowing between named numeric types — explicit casts only.

```js
let hp: int32   = 100;            // literal typed as int32
let mask: uint8 = 0xFF;            // literal typed as uint8
let big: uint64 = 1_000_000_000;
let dt: float32 = 1.0 / 60.0;      // both literals typed as float32

let a: int32 = 10;
let b: int64 = a;                  // compile error — explicit cast required
let b: int64 = int64(a);           // ok
```

Literal forms:

| Form | Examples |
|---|---|
| Decimal int | `0`, `42`, `-7`, `1_000_000` |
| Hex int | `0xFF`, `0xDEAD_BEEF` |
| Binary int | `0b1010`, `0b1111_0000` |
| Octal int | `0o755` |
| Float | `1.0`, `3.14`, `-0.5`, `1e-9`, `6.022e23` |

A literal that doesn't fit its inferred or annotated type is a compile error at parse
time (e.g. `let x: uint8 = 256;`). Negative literals are not valid for unsigned types.

### Casts

Explicit casts use the type name as a call:

```js
let i: int32  = 42;
let f: float32 = float32(i);
let u: uint8  = uint8(i & 0xFF);      // narrowing — bits preserved, value truncated
```

Narrowing casts truncate; widening casts between signed/unsigned of the same width
reinterpret bits. Float ↔ int casts truncate toward zero.

### String interpolation (reserved, not required for v2)

```js
log(`hello, ${name}`);
```

---

## 3. Types

### Struct

```js
type Point {
    x: int32,
    y: int32,
}

type Result {
    value: int32,
    err: string,
}
```

Plain data. No methods defined inside `type`. No inheritance. All fields public.

### Arrays

```js
let xs: int32[];
let ys: int32[] = [1, 2, 3];
let zs: Point[] = [{x:1,y:2}];
```

Length is intrinsic: `xs.len`. Arrays are fat pointers (ptr + len).

### Generic / opaque handles

```js
let h: file<string>;
```

User-defined generic types are deferred until after v2 stabilizes.

### References — `ref T`

```js
let n: int32 = 0;
let p: ref int32 = ref n;      // bind
p = 42;                        // auto-deref write
log_int(p);                    // auto-deref read -> 42
```

`ref` is visible at formation and at passing; usage is transparent. No null, no
arithmetic. The `unsafe_ptr` kind (see §12) is the escape hatch for C-style pointers.

### Nullability

There is no null. Absence is modeled with a validity field, an `optional` kind, or a
predicate built-in on foreign handles (e.g. `file_is_null(h)`).

---

## 4. Variables and bindings

```js
let x: int32;                       // zero-initialized
let y: int32 = 3;
const z: int32 = 42;                // immutable binding

let disposable f: FileHandle = open("x.txt") { ... }   // disposable owns a block
let scoped result = fetch(url);
let pooled h      = fetch(url);
let (disposable throughput_capped(4)) buf: Bytes = recv() { ... }
```

- `let` — mutable
- `const` — immutable binding
- Kind prefixes go **between `let` / `const` and the name**. Parentheses group multiple kinds.
- Type annotations are required without an initializer; optional when the initializer is unambiguous.

### `let` / `const` is optional when a kind prefix is present

Symmetric to the function rule (§7): a kind prefix on a binding lets you drop the
`let` / `const` keyword. Such bindings are **implicitly `const`**; write `let` explicitly
when you need mutability.

```js
disposable input = open_input(path) { ... }        // implicitly const
scoped result    = fetch(url);                     // implicitly const
pooled h         = fetch(url);                     // implicitly const

let disposable input = open_input(path) { ... }    // explicit let for mutability
```

### Block-owning kinds

A kind can declare `ownsBlock` in its definition (see §6). Such a binding's scope is
**narrowable** to an explicit trailing `{ ... }`; if no block is written, the compiler
synthesizes an implicit block at the tail of the enclosing scope, nesting multiple
block-owning bindings in **reverse declaration order** (LIFO cleanup).

```js
// Explicit block form — scope is lexically visible
disposable input = open_input(path)? "opening input" {
    const bytes = read_all(ref input)? "reading bytes";
    const stats = scan(bytes)? "scanning";
    return { stats: stats, err: "" };
    // dispose(input) fires at `}` — satisfies mustCall dispose beforeScopeEnd
}
// `input` is not in scope here

// Implicit form — same cleanup, scope is the rest of the enclosing scope
task analyze_implicit(path: string): Report {
    disposable input = open_input(path)?;
    const bytes = read_all(ref input)?;
    const stats = scan(bytes)?;
    return { stats: stats, err: "" };
    // compiler inserts dispose(input) before every exit path: `?`, return, fall-through
}

// Multiple block-owning bindings — LIFO ordering
task analyze_pair(): Report {
    disposable a = open_a()?;
    disposable b = open_b()?;
    // ... work ...
    return make_report();
    // cleanup order: dispose(b), then dispose(a) — reverse declaration
}
```

Semantically, the implicit form is equivalent to writing every block-owning binding's
block explicitly, nested in reverse order; the compiler just doesn't make you type it.

A kind-prefixed binding may only have a trailing block when **at least one** of its
kinds declares `ownsBlock`. For kinds without that clause, no block is allowed.

### Destructuring (sugar)

Destructuring is **surface sugar**, not a codegen primitive. The callee always returns
a plain struct; the compiler rewrites destructuring into field reads:

```js
const { value, err } = fetch_sync("x");

// compiler rewrites to:
const _tmp  = fetch_sync("x");
const value = _tmp.value;
const err   = _tmp.err;
```

This keeps the syntax readable at the call site without introducing multiple-return
ABIs or special codegen. `err` observation is still enforced — the type system
requires the `err` field of an error-carrying struct to be read before scope exit.

---

## 5. Traits

A **trait** is a set of operations a type must provide. It's the capability layer.

### Declaring a trait

```js
trait Disposable {
    function dispose(ref self): void;
}

trait Task<T> {
    function wait(ref self): { value: T, err: string };
    function abandon(ref self): void;
}

trait Iterable<T> {
    function next(ref self): { value: T, done: bool };
}

trait BatchIterable<T> extends Iterable<T> {
    function next_batch(ref self, n: usize): T[];
}
```

- `self` is always a `ref` (no hidden aliasing).
- `extends` chains traits — a `BatchIterable<T>` is also an `Iterable<T>`.
- Traits never carry state.

### Implementing a trait on a type

```js
type FileHandle implements Disposable {
    fd: int32,
    function dispose(ref self): void {
        close_fd(self.fd);
    }
}
```

Method blocks sit inside `type … implements Trait { fields; fn; fn; }`. A type can
implement multiple traits:

```js
type Channel implements (Disposable, Iterable<Message>) {
    ...
}
```

### Trait bounds on generics (reserved)

```js
function drain<T implements Iterable<T>>(ref it: T): void;
```

Reserved syntax; semantics pinned when user generics land.

---

## 6. Kinds

A **kind** is a usage-site contract. It attaches to bindings, parameters, fields, or
functions and encodes lifecycle, scoping, iteration, layout, sharing, or concurrency
rules. Kinds are the single mechanism for "the compiler should enforce X here."

### Defining a kind

```js
kind disposable {
    requires Disposable;
    ownsBlock;                               // binding may take a trailing `{ ... }`
    mustCall dispose beforeScopeEnd;
}

kind pooled {
    appliesTo binding;
    requires Task;
}

kind joined {
    appliesTo binding;
    requires Task;
    autoJoin beforeScopeEnd;
    mustNotEscape scope;
}

kind task {
    appliesTo function;
    provides Task;                           // call results are Task<ReturnType>
}

kind batchable(n: usize) {
    requires BatchIterable;
    restricts iteration {
        allow batched { max n; };
    };
}

kind simd_aligned {
    appliesTo type binding;
    layout {
        align 32;
    };
    restricts iteration {
        allow sequential;
        allow simd { width 8; };
        forbid parallel;
    };
}
```

Every clause is a `;`-terminated statement of the form `keyword arg...` or
`keyword arg... { sub-clauses }`. There are no parens, no method chains,
and no colons in clause syntax — clause types are a closed set the compiler
owns, and the grammar reflects that.

Multiple `requires` are written as separate clauses
(`requires Disposable; requires Closable;`), not as a list.

### What a kind can declare

| Clause | Meaning |
|---|---|
| `appliesTo X...` | One or more of `binding`, `parameter`, `field`, `function`, `type`. Default: any value-site. |
| `requires Trait` | Values of this kind must implement the named trait. Repeat to require multiple. |
| `provides Trait` | The kind supplies the trait's implementation (can transform its initializer). |
| `ownsBlock` | Binding may take a trailing `{ ... }` that narrows its scope. Without one, compiler synthesizes an implicit block at the tail of the enclosing scope; multiple such bindings nest in reverse declaration order (LIFO). |
| `mustCall fn beforeScopeEnd` | Fn must run before the binding's scope exits — an explicit block if present, otherwise the enclosing scope. |
| `mustCall fn beforeAny` | *(reserved — not implemented.)* Fn must run before any other method. |
| `mustCall { a; b; } beforeScopeEnd` | *(reserved — not implemented.)* At least one of these must run. |
| `mustCall fn afterAny` | *(reserved — not implemented.)* Fn must run after every other method. |
| `mustNotShare acrossScopes` | Cannot cross into a concurrent task. |
| `mustNotEscape scope` | Cannot be returned or stored outside its scope. |
| `autoJoin beforeScopeEnd` | Compiler inserts `wait` at scope exit. |
| `restricts iteration { ... }` | Which `for*` forms are legal on this value. |
| `layout { ... }` | Memory layout contract (align, packing, SoA/AoS). |
| `propagates<K>` / `contains<K>` | How containers surface or absorb another kind's constraints. |
| `forbids X...` | Categories a function may not touch (`io`, `globalState`, …). |

**Cleanup on early return from `?`.** Any `mustCall` obligation that's live at the
point a `?` triggers an early return must be satisfied before the return actually
happens. The compiler inserts the call. This is how `disposable input = open(p) { … ?
… }` can promise `dispose(input)` runs even when the block exits via `?`.

### Applying a kind

Kind prefixes sit wherever the kind's `appliesTo` permits:

```js
// on a binding
let disposable f: FileHandle = open("x.txt");

// on a parameter
function drain(batchable(4) events: Event[]): void { ... }

// on a type field (declares the field carries the kind's constraints)
type Session {
    conn: disposable net<Bytes>,
}

// on a function declaration — replaces the `function` keyword
task fetch(url: string): Bytes { ... }
```

### Composition

```js
kind slow_batch = throughput_capped(8) & mustNotEscape;
```

Contradictory compositions are compile errors (`align: 32` & `align: 64`,
`allow parallel` & `mustNotShare acrossScopes`, …).

### Containment and propagation

When a struct embeds a field whose type or kind carries rules, the struct must declare intent:

```js
type RenderPass propagates<gpu_buffer> { buf: GpuBuffer; }   // callers inherit rules
type RenderPass contains<gpu_buffer>   { buf: GpuBuffer; }   // struct absorbs them
```

`contains<K>` is reserved but not yet implemented; until it lands, a function that breaks the propagates chain (creates a value of a propagating type, satisfies its rules locally, and returns it without re-declaring `propagates<K>`) is implicitly a "contains" boundary — the caller sees a value with no outstanding obligation.

Functions propagate the same way:

```js
function make_pass(scene: Scene): RenderPass propagates<gpu_buffer>;
```

**`propagates<K>` is a "must handle, or hand off" contract.** A value of a type that declares `propagates<K>` cannot be silently discarded. The user has exactly three legal ways to discharge the obligation:

1. **Auto-cleanup via the kind keyword.** Bind the value with the kind prefix and the compiler injects the cleanup at scope end:

   ```js
   usedisposable arr: DynArray<int32> = new_dynarray(4);
   // compiler inserts: Disposable.dispose(ref arr) before scope end
   ```

2. **Manual discharge.** Bind with plain `let`/`const` and call the cleanup method directly before the binding goes out of scope:

   ```js
   let arr: DynArray<int32> = new_dynarray(4);
   use(arr);
   Disposable.dispose(ref arr);   // satisfies the obligation
   ```

3. **Transfer to the caller.** Bind with plain `let`/`const` and `return` it from a function whose return type also declares `propagates<K>`:

   ```js
   function new_dynarray<T>(n: usize): DynArray<T> propagates<usedisposable> {
       let a: DynArray<T> = { ... };
       return a;   // obligation flows to caller
   }
   ```

Failing to choose one of the three is a compile error: a binding whose obligation is unsatisfied at scope end, or a function that returns a propagating value without declaring `propagates<K>`, both fail to typecheck. The kind keyword on a binding is opt-in convenience for case (1); it does not change what `propagates<K>` on the type means.

---

## 7. Functions

### Plain function

```js
function add(a: int32, b: int32): int32 {
    return a + b;
}
```

No kinds, no concurrency, no special contract. Called directly:

```js
let n: int32 = add(1, 2);
```

### Kind-prefixed functions — `function` keyword optional

A sequence of **one or more kind prefixes** followed by `name(params): ReturnType { body }`
is parsed as a function declaration. The `function` keyword is optional when at least
one kind prefix is present:

```js
task fetch(url: string): Bytes { ... }              // idiomatic
task function fetch(url: string): Bytes { ... }     // explicit; equivalent

task disposable open_remote(url: string): RemoteHandle { ... }   // multiple kinds
pure add(a: int32, b: int32): int32 { ... }
pure task compute(x: int32): Result { ... }
```

The parser sees a run of identifiers; each must name a kind whose
`appliesTo` includes `function`. If any doesn't, it's a compile error.

### Reference parameters

```js
function increment(ref counter: int32): void {
    counter = counter + 1;
}

let n: int32 = 0;
increment(ref n);
```

`ref` at both the declaration and the call makes aliasing visible at every site where
it happens.

### Methods on types

Methods live inside `type … implements Trait { ... }` blocks (see §5). There is no
bare `impl` block; a method always implements a trait.

---

## 8. Concurrency

Concurrency is a **kind story**. There are no `async` / `await` keywords in v2.

The runtime contract — how tasks are allocated, scheduled, waited on, and torn
down — is specified separately in [plans/runtime-design.md](plans/runtime-design.md).
This section describes only the language surface.

### The model

- `task` is a kind applied to a function. It declares that the function's return value becomes a `Task<T>` at the call site.
- Every call to a `task` function is **semantically a spawn**. The compiler may lower spawn-then-immediate-wait into a direct synchronous call when it can prove no observable difference; otherwise the runtime schedules the work on a worker thread.
- `wait` blocks the calling thread until the task body completes. (Suspendable `wait` — yielding the worker rather than blocking it — is a planned future capability and does not change the surface syntax.)
- The **binding's kind** decides when the compiler forces the `wait`:

| Binding form | When `wait` is forced | Lifetime / storage |
|---|---|---|
| `let x = f()` (no kind) | Immediately — the next statement sees the value. | Stack-allocated handle; spawn + wait inline. |
| `let joined d = f()` | At the enclosing scope's `}` (`autoJoin`); also on first read of `d` if earlier. | Stack-allocated; bounded by scope. |
| `let pooled h = f()` | Never automatically — you call `wait h` yourself. | Heap-allocated, atomically refcounted. |

Allocation details and the refcount lifecycle are specified in
[runtime-design.md §4 and §6](plans/runtime-design.md).

### Example

```js
task fetch(url: string): Bytes { ... }

function main(): void {
    let data     = fetch(url);             // synchronous-looking; wait inserted inline
    let joined d = fetch(url);             // concurrent; wait inserted at the next `}`
    let pooled h = fetch(url);             // handle value; copyable, returnable
    let result   = wait h;                  // block on h, read its result

    _ = fetch(url);                         // fire-and-forget; result is dropped
}
```

### Safety

- A plain `function` (no `task`) cannot be bound as `joined` or `pooled` — the binding kind's `requires Task` isn't satisfied.
- `joined` carries `mustNotEscape scope` — the value cannot be returned or stored outside its declaring scope.
- `pooled` is a plain value-typed handle. It can be returned, stored in arrays, passed by value or by `ref`. The kind imposes no compiler-enforced lifecycle obligation; the user calls `wait` (or simply drops the handle to fire-and-forget).

### Handle operations

| Operator | Meaning |
|---|---|
| `wait h` | Block until the task referenced by `h` completes; evaluate to the result. `h` must name a binding of type `Task<T>`. |

`wait` is a keyword-level operation, not a method on `Task<T>`, so the compiler can
account for it during flow analysis (in particular, the `joined` kind's `autoJoin`
clause is implemented by inserting a synthetic `wait` at scope exit, and the
compiler must recognize the operator to detect when an explicit user `wait` makes
the synthetic insertion redundant).

`_ = expr;` is the language's generic discard form (see §4). When `expr` is a
task call (`_ = fetch(url);`), the result handle is spawned and immediately
dropped; the body still runs to completion in the background, and its result is
discarded when the worker releases the last reference. This is the
fire-and-forget idiom — it is not a task-specific operator.

### Safety and deadlock

The MVP runtime model uses run-to-completion tasks on a fixed-size worker pool
(see [runtime-design.md §3](plans/runtime-design.md)). A `wait` inside a `task`
function body blocks the worker thread. With N workers and deeper-than-N nested
waits, deadlock is possible:

- Submitting N tasks that all `wait` on an N+1th task that's still queued behind
  them deadlocks the pool.

Mitigations until suspendable wait lands:

- Oversize the pool via `YOOP_NUM_WORKERS` (default is `num_cpus`).
- Prefer composing tasks at non-task call sites (i.e., in `main` or regular
  functions). The deadlock surface only matters when waits nest inside task
  bodies.

Suspendable `wait` inside task bodies — `wait` yielding the worker rather than
blocking it — is a planned future capability that eliminates this hazard. The
language surface does not change when it lands.

---

## 9. Loops

Two loop keywords, both reserved for iteration — no extra keywords per strategy.
Iteration *strategy* is expressed as a **trait method call on the collection** in the
RHS of `in`. This keeps the `for … in` slot recognizable as a loop while letting kinds
and traits extend the strategy set.

```js
// C-style numeric counter
for (i = 0; i < n; i = i + 1) { ... }

// Iteration over a collection — strategy comes from a trait method
for item  in xs                    { ... }   // default, from Iterable
for chunk in xs.batched(4)         { ... }   // chunk: T[] — from BatchIterable
for v     in xs.simd(8)            { ... }   // v is a SIMD lane — from SimdIterable
for item  in xs.parallel()         { ... }   // each iter a concurrent task — from ParIterable
```

The body's bound variable's **type** tells you the mode: a `T[]` binding means you're
iterating in chunks; a parallel iterator's body runs under concurrent-task rules
automatically. No new keyword per strategy — the method name *is* the strategy, and
it's checked against the collection's kind and the iterator trait it returns.

### Iteration traits

```js
trait Iterable<T> {
    function next(ref self): { value: T, done: bool };
}

trait BatchIterable<T> extends Iterable<T> {
    function batched(ref self, n: usize): Iterable<T[]>;
}

trait SimdIterable<T> extends Iterable<T> {
    function simd(ref self, width: usize): Iterable<T>;    // body runs in SIMD context
}

trait ParIterable<T> extends Iterable<T> {
    function parallel(ref self): Iterable<T>;              // body runs under `scoped`-like rules
}
```

User-defined strategies (reversed walks, windowed iterators, priority order) drop into
the same shape: add a trait method that returns an `Iterable<U>` and it is legal as the
RHS of `for … in`.

### When is a strategy legal?

- The collection's type must implement the trait the method lives on.
- The collection's kind must not forbid the resulting iteration mode (e.g. a
  `mustNotShare acrossScopes` kind forbids `.parallel()`; a non-scalar layout kind
  forbids `.simd(n)`).
- The body binding's kind (if any) is checked against the iterator's element rules.

### Intent-revealing body context

For strategies that change the body's execution context (parallel, SIMD), the body
**inherits the iterator's body kind automatically** — inside `for item in xs.parallel()`,
shared-mutable writes to captured state are a compile error because the body is treated
as if it were inside `let scoped … = …`. No new keyword; the type-and-kind system does
the work.

If you want additional rules on the body, the binding can take its own kind prefix:

```js
for scoped item in xs.parallel() { ... }   // make scoped-like rules explicit
```

---

## 10. Control flow

```js
if (cond) { ... } else if (cond) { ... } else { ... }

while (cond) { ... }

return;
return expr;

break;
continue;
```

No `switch` in v2. Pattern-matching on tagged unions is a future addition once the
error story hardens.

---

## 11. Errors as values

### The convention

A **fallible** return type is a struct with a trailing `err: string` field. That's the
only marker — there's no `Result<T, E>` wrapper, no discriminated union, no throwing.

```js
type Readout {
    data: Bytes,
    err: string,
}

function read_all(path: string): Readout { ... }
```

A type is fallible iff it has an `err: string` field. Nothing else needs to be marked.

### Forcing rules

The compiler refuses to let an error slip away silently. Every call that returns a
fallible type falls into one of four categories — anything else is a compile error:

| What you wrote | Must also | Compiler reaction |
|---|---|---|
| `const r = f();` then read `r.err` before scope exit | — | OK (explicit handling) |
| `const { data, err } = f(); if (err) return;` | — | OK (destructure sugar) |
| `const data = f()?;` | — | OK (propagate — see below) |
| `_ = f();` | — | OK only if fn's kind allows discard |
| `f();` (result dropped) | — | Compile error |
| `const { data } = f();` (err not named) | — | Compile error |
| `const r = f();` and `r.err` never read | — | Compile error at scope end |

The common-case rewrite of "call something, bail if it failed" is noisy enough to
deserve its own operator.

### The `?` operator — forced propagation

Postfix `?` on a fallible expression means: **if the call failed, return its error
from the enclosing function now; otherwise produce the non-error value**.

```js
function load_config(path: string): Config {
    const bytes = read_all(path)?;          // bail with read_all's err, or bind data
    const parsed = parse(bytes)?;
    return parsed;
}
```

The compiler rewrites `f()?` into the obvious early return:

```js
// let r = f()?;   expands to:
const _tmp = f();
if (_tmp.err) return { ...default(EnclosingReturnType), err: _tmp.err };
// `r` then refers to _tmp with `err` stripped
```

### What `?` yields

`?` produces the argument's value with the `err` field removed.

| Argument type | Result of `expr?` |
|---|---|
| `{ value: T, err: string }` (single non-err field) | `T` — the inner value |
| `{ data: T, meta: M, err: string }` (multiple fields) | `{ data: T, meta: M }` — struct minus `err` |
| `{ err: string }` (err-only) | `void` — statement-position only |
| non-fallible type | compile error — nothing to propagate |

This composes with destructuring sugar:

```js
const { data, meta } = fetch(url)?;         // strip err, then destructure the rest
const bytes          = read_all(p)?;        // single-field short form
read_config(p)?;                            // err-only, statement position
```

And with chaining:

```js
return parse(read_all(path)?)?;
```

### What the enclosing function must look like

`?` only compiles inside a function whose return type is also fallible (has an
`err: string` field). The compiler refuses `?` in a function that returns a
non-fallible type — you must handle the error, not propagate it.

```js
function total(path: string): usize {
    const bytes = read_all(path)?;          // compile error: usize has no err field
    return bytes.len;
}
```

### Attaching context (optional, reserved)

A suffix string on `?` prepends a context message to the propagated error. Reserved
syntactically; not required for the first cut:

```js
const bytes = read_all(path)? "loading config";
// on error, propagates err with "loading config: " prefixed
```

### Interaction with concurrency kinds

`?` inspects the `err` field of its argument — which means it needs the result to
exist. That constrains how it composes with `scoped` / `pooled` bindings:

```js
// Synchronous binding — result is available immediately
const bytes = fetch(url)?;                  // OK

// Scoped binding — task hasn't joined yet at this statement
let scoped r = fetch(url)?;                 // compile error

// Pooled binding — task handle, not a result
let pooled h = fetch(url)?;                 // compile error

// Correct: propagate after the wait
let pooled h = fetch(url);
const bytes  = wait h?;                     // OK — wait returns a fallible type
```

The rule: `?` is legal on any expression whose type is fallible *and is available at
the point the `?` appears*. A task handle is not; a completed task result (or a
synchronous call's result) is.

### Why not `?? throw` or exceptions?

Earlier drafts had `?? throw` as a sugar form. `?` subsumes it — one operator, tighter
syntax, and it integrates with destructuring. There are no exceptions in Yooperlang;
every error boundary is visible at the token level (`?`, `if (err)`, or explicit
`_ = f();`).

---

## 12. Foreign interop (C and others)

```js
extern "C" from "stdio.h" {
    function printf(fmt: string, ...): int;
    function fopen(path: string, mode: string): ref FILE;
    function fclose(f: ref FILE): int;
    type FILE;
}

extern "C" from library "m" {
    function cos(x: float64): float64;
}

export "C" function on_tick(ms: int32): int32 { return ms + 1; }
```

- `extern "C" from "..."` reads like `import … from …` and positions C interop as a peer of module imports.
- `extern "C" from library "..."` links against a named library (emits `-lNAME`).
- `export "C" function …` emits a function with the C ABI and an unmangled symbol.
- `extern "Rust" from ...` / `extern "Zig" from ...` — syntax reserved.

### Unsafe pointers

C interop sometimes needs raw, nullable, arithmetic-capable pointers. Only available
when a file opts in at the top:

```js
import.unsafe;                             // enables unsafe_ptr<T>

let p: unsafe_ptr<int32> = null;
let q: unsafe_ptr<int32> = &x;             // address-of an lvalue
let v: int32 = *p;                          // deref read
*p = 42;                                    // deref write
let r: unsafe_ptr<int32> = p + 1;          // strides by sizeof(int32)
let n: int64 = q - p;                       // element count (matching pointees)
let b: bool = (p == null);
```

`unsafe_ptr<T>` is a distinct type, not a kind on `ref T`. Operators:

| Form | Result | Notes |
| --- | --- | --- |
| `&lvalue` | `unsafe_ptr<T>` | Prefix `&`; lvalue-only. |
| `*p` | `T` | Prefix `*`; load through the pointer. Reading through `null` is UB. |
| `*p = v` | — | Assignment LHS form; `v` must be assignable to `T`. |
| `p + n`, `p - n` | `unsafe_ptr<T>` | `n` is any integer; stride is `sizeof(T)`. |
| `p - q` | `int64` | Element count; both sides must share pointee type. |
| `p[i]` | `T` (lvalue) | Sugar for `*(p + i)`. |
| `p == q`, `p != q` | `bool` | Pointees must match, or one side is `null`. |

Casts are explicit and spelled as intrinsics:

```js
let bp: unsafe_ptr<uint8> = unsafe_ptr.cast<uint8>(p);
let n: uintptr = unsafe_ptr.toInt(p);
let p2: unsafe_ptr<int32> = unsafe_ptr.fromInt<int32>(n);
```

`uintptr` is a built-in integer type with the platform pointer width. `null` is a
literal whose type is pinned by context (assignment target, return type, call
arg, or the other side of an equality compare) — a bare `null` in an
unconstrained position is a typecheck error.

Without `import.unsafe;`, `unsafe_ptr<T>` is not in scope and any mention of it
is a typecheck error. Pointers do not participate in kind containment: a struct
holding `unsafe_ptr<T>` does not inherit kind obligations from `T`. `unsafe_ptr`
is also rejected inside `pure` functions.

---

## 13. Operators

| Category | Operators |
|---|---|
| Arithmetic | `+  -  *  /  %`  (same-type integer or float operands; no implicit cross-coercion) |
| Comparison | `==  !=  <  >  <=  >=`  (returns `bool`) |
| Logical | `&&  \|\|  !`  (short-circuiting, `bool` only) |
| Bitwise | `&  \|  ^  ~  <<  >>`  (integer types only) |
| Assignment | `=  +=  -=  *=  /=  %=` |
| Ref-taking | `ref expr`  (from an lvalue) |
| Error propagation | `expr?`  (postfix; forces early return on `err`, yields the stripped value) |

---

## 14. Reserved keywords

```
appliesTo       autoJoin         bool             break
char            const            contains         continue
else            export           extern           false
float32         float64          for              forbids
from            function         if               implements
import          in               int8             int16
int32           int64            isize            joined
kind            layout           let              mustCall
mustNotEscape   mustNotShare     null             pooled
propagates      provides         pure             ref
requires        restricts        return           scoped
string          task             Task             trait
true            type             uint8            uint16
uint32          uint64           uintptr          unsafe_ptr
usize           void             wait             while
int             float
```

int is 32 bit signed int
float is 32 bit float

Identifiers: `[A-Za-z_][A-Za-z0-9_]*`. Kind and trait names are conventionally
`snake_case` and `PascalCase` respectively.

Contextual keywords (reserved only in their syntactic positions): `in`, `layout`,
`restricts`, `provides`, `requires`, `appliesTo`, `ownsBlock`, `mustCall`,
`mustNotShare`, `mustNotEscape`, `autoJoin`, `forbids`, `propagates`,
`contains`, `from`, `library`, `as`. Inside kind-clause bodies, the timing
modifiers `beforeScopeEnd`, `beforeAny`, `afterAny`, the axis identifiers
`scope`, `acrossScopes`, and the `appliesTo` site identifiers `binding`,
`parameter`, `field` are also contextual.

---

## 15. End-to-end example

```ts
// main.yoop

import { Stats, scan } from "./scan.yoop";

extern "C" from "stdio.h" {
    function printf(fmt: string, ...): int;
    function fprintf(stream: ref FILE, fmt: string, ...): int;
    type FILE;
    const stderr: ref FILE;
}

trait Disposable {
    function dispose(ref self): void;
}

kind disposable {
    requires Disposable;
    ownsBlock;
    mustCall dispose beforeScopeEnd;
}

type Input implements Disposable {
    handle: file<string>,
    function dispose(ref self): void {
        file_close(self.handle);
    }
}

type OpenResult { input: Input,   err: string }
type Readout    { bytes: Bytes,   err: string }
type Report     { stats: Stats,   err: string }

task open_input(path: string): OpenResult { ... }
task read_all(ref input: Input): Readout { ... }

// `disposable` is a block-owning kind. The binding's scope is the trailing `{ ... }`.
// `dispose(input)` is inserted at the block's end on every exit path:
// fall-through, `?` propagation, or `return`.
task analyze(path: string): Report {
    disposable input = open_input(path)? "opening input" {
        const bytes = read_all(ref input)? "reading bytes";
        const stats = scan(bytes)?          "scanning";
        return { stats: stats, err: "" };
    }
    // `input` is not in scope here
}

// Top-level handles errors explicitly — main returns void, so `?` isn't available.
function main(): void {
    const { stats, err } = analyze("data.txt");
    if (err) {
        fprintf(stderr, "analyze failed: %s\n", err);
        return;
    }
    printf("upper=%d lower=%d\n", stats.upper, stats.lower);
}

// Top-level handles errors explicitly — main returns void, so `?` isn't available here.
function main(): void {
    const { stats, err } = analyze("data.txt");
    if (err) {
        fprintf(stderr, "analyze failed: %s\n", err);
        return;
    }
    printf("upper=%d lower=%d\n", stats.upper, stats.lower);
}
```

What this example demonstrates:

- **Block-owning `disposable`** — the kind's block is the input's lifetime, lexically visible. `dispose(input)` runs at the block's `}` regardless of how it exits.
- **`?` propagation with cleanup** — each `?` inside the block propagates the error *after* the compiler inserts `dispose(input)`.
- **Dropped `const`** — `disposable input = …` has no `const` keyword; the kind prefix makes it implicitly `const`. Symmetric with `task fetch(...)` dropping `function`.
- **Context attachment** — `? "msg"` prefixes the propagated error with a human-readable tag.
- **Boundary handling** — `main` returns `void`, so `?` is unavailable; errors are consumed via destructure + `if (err)`.
- **Destructuring as sugar** — `const { stats, err } = analyze(...)` compiles to a temp + two field reads, same codegen as hand-written field access.

---

## 16. What's intentionally not here

- **Classes, inheritance, methods attached to bare types.** Traits + free functions only.
- **Garbage collection.** Lifetimes through `mustCall`, `mustNotEscape`, and `dispose`.
- **Implicit conversions.** Explicit casts only.
- **Exceptions.** Errors are values; `?? throw` is sugar.
- **`async` / `await` keywords.** Subsumed by `task` (kind) + binding kinds.
- **Per-strategy loop keywords.** One `for … in` slot; the strategy is a trait method call (`xs.batched(4)`, `xs.parallel()`).
- **Multiple-return-value ABI.** Destructuring is compile-time sugar over a returned struct.
- **Generic user types.** Revisit after traits and kinds are stable.
- **A package manager.** Relative-path imports only.

---

## 17. Open questions

1. **Kind-transforms-RHS (`provides` semantics).** When `scoped` / `pooled` bind a call expression, the kind supplies the spawn wrapping. This is the one place a kind modifies *code*, not just enforces rules. Worth giving it a distinct grammar (`provides … intercepts { … }`) to keep it visible?
2. **Trait method resolution.** Methods live on `type … implements Trait` blocks. Call syntax is **trait-qualified**: `Disposable.dispose(ref x)` — the trait name must be in scope at the call site. (Phase 7.4 settled this: bare-form `dispose(ref x)` and dotted form `x.dispose()` are both rejected. Trait method names live in the trait's namespace and may freely coincide with module-level free-function names or with method names from other traits implemented by the same type, because every call site is unambiguously qualified.)
3. **String ↔ cstr.** UTF-8 immutable `string` is TypeScript-adjacent; C expects null-terminated bytes. Options: implicit cstr view, explicit conversion, or two types.
4. **Array length & FFI.** `xs.len` intrinsic means fat pointers; worth a separate `c_array<T>` for ABI-exact interop.
5. **`ref` lifetimes.** Minimum rule: a `ref` cannot outlive the stack frame it names. Beyond that, `mustNotEscape` covers the rest.
6. **Multiple trait impls per type.** `type T implements (A, B)` — confirm grouping syntax.
7. **Kind parameters vs. trait generics.** `batchable(n: usize)` takes a value parameter; traits take type parameters. Keep them distinct or unify?
