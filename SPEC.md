# Yooperlang - Language Specification (v2 Draft)

Yooper - person from the Upper Peninsula of Michigan

A syntax-first specification for a fresh Yooperlang design.

Yooperlang (`.yoop`) is a **systems language with a TypeScript feel**:
no garbage collector, no classes, structs + free functions, types on the right,
and every behavioral contract (capability, lifetime, layout, iteration, concurrency)
expressed through two orthogonal mechanisms - **traits** and **kinds**.

This document is organized **syntax first, semantics briefly**. Each section shows
the form you will actually type, followed by a short note on what it means.

---

## 0. The three-layer model

Yooperlang separates three ideas that other languages tend to conflate:

| Layer | Role | Attached to | Example |
|---|---|---|---|
| **Trait** | Capability - operations a value supports | Types | `Disposable`, `Task<T>`, `Iterable<T>` |
| **Kind** | Usage contract - scoping, lifecycle, iteration, sharing rules | Bindings, parameters, fields, functions, regions | `disposable`, `ephemeral`, `scoped`, `pooled`, `batchable(n)` |
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

Every `.yoop` file is a module. Imports use **relative paths** by default; the
`std/` prefix resolves against the bundled standard library.

```js
import { parse, lex } from "./lexer.yoop";
import * as lex        from "./lexer.yoop";
import { parse as p }  from "./ast.yoop";
import "./init.yoop";                    // side-effect only

import { Vec } from "std/core/vec.yoop";  // type imports stay named
import * as vec from "std/core/vec.yoop"; // value imports require namespace

// Combined form: a two-axis module (a type plus value-level functions) can
// bind both on one line. Either ordering is accepted.
import * as vec, { Vec } from "std/core/vec.yoop";
import { Vec }, * as vec from "std/core/vec.yoop"; // equivalent
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

### Std imports must use the namespace form for values

Function imports from any `std/` path must use `import * as <ns> from "std/..."`
- short names like `info`, `error`, `panic`, or `vec_new` would otherwise
shadow user identifiers across every module that touched the library. Types,
traits, kinds, and other declaration-position names (e.g. `Vec`, `Result`,
`disposable`) can keep their named-import form because their capitalization
(or syntactic position) separates them from value identifiers.

```js
// REJECTED - std value import in named form
import { info, error } from "std/log.yoop";

// CORRECT - namespace form, calls become `log.info(...)`, `log.error(...)`
import * as log from "std/log.yoop";
```

### Intrinsics live in `std/core/intrinsics.yoop`

The compiler-recognized intrinsics - `heap_alloc<T>`, `heap_free<T>`,
`string_as_bytes`, `string_from_bytes_unchecked`, `array_slice<T>` - are
declared inside an `extern "intrinsic" from "compiler" { ... }` block in
[std/core/intrinsics.yoop](std/core/intrinsics.yoop). They are not in scope
by default; import the module to use them:

```js
import * as intr from "std/core/intrinsics.yoop";

function main(): int32 {
    let buf: int32[] = intr.heap_alloc(8);
    intr.heap_free(buf);
    return 0;
}
```

`wait_until<T>` and `cancel<T>` are intrinsics declared in
[std/core/concurrency.yoop](std/core/concurrency.yoop) (next to `now_ns` and
`sleep_ms`); import that module as `conc` to use them.

`printf` is an exception - it stays globally callable without an import
because the name is specific enough not to collide with user identifiers,
and ~every example file would otherwise need an extra line.

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
| `char` | `'A'`, `'\n'`, `'\x41'` | a Unicode scalar; see below |
| `string` | `"hello"`, `"line\n"` | immutable, UTF-8, zero-terminated for C interop |
| `void` | - | function return only |

**Char literals are single-quoted, and the single quote is reserved exclusively
for them** - strings use double quotes, templates use backticks. A char literal
is one Unicode scalar between single quotes (`'a'`, `'\n'`, `'\x41'`, or an
astral scalar like an emoji). Supported escapes: `\n \r \t \0 \\ \' \"` and the
`\xNN` two-hex-digit byte form. An empty `''` or multi-character `'ab'` literal
is a lex error.

A char literal evaluates to its codepoint and is **untyped, exactly like an
integer literal**: it pins to whatever integer type the context requires and is
range-checked there. So `ch == '/'` against a `uint8` works (`'/'` is `47`,
fits a byte), while pinning an astral scalar to a `uint8` is the same overflow
error as `let x: uint8 = 256`. With no pinning context it defaults to `int32`
like any untyped integer. This is what makes byte-oriented code (a lexer
scanning `uint8[]`) read as `ch == '\n'` instead of `ch == 10`.

### Numeric literals

Integer and float literals are **untyped** until they reach a typed context, at which
point they're checked for range and coerced to the target type. No implicit widening or
narrowing between named numeric types - explicit casts only.

```js
let hp: int32   = 100;            // literal typed as int32
let mask: uint8 = 0xFF;            // literal typed as uint8
let big: uint64 = 1_000_000_000;
let dt: float32 = 1.0 / 60.0;      // both literals typed as float32

let a: int32 = 10;
let b: int64 = a;                  // compile error - explicit cast required
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
let u: uint8  = uint8(i & 0xFF);      // narrowing - bits preserved, value truncated
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

### Type aliases

```js
type NodeId = usize;        // alias a primitive
type IdList = NodeId[];      // RHS is a full type annotation, so arrays work
type Coord = Point;          // alias a struct (and aliases may chain)
```

`type Name = <type>;` (note the `=` and the trailing `;`, vs the brace-bodied
struct form) introduces a *transparent* alias: it has no identity of its own and
resolves straight through to the underlying type at every use. A `NodeId` IS a
`usize` everywhere - the two are freely interchangeable, indexing an aliased
array (`IdList`) yields the underlying element type, and no conversions are
needed. Aliases are documentation and intent, not a distinct nominal type (so
they will not stop you passing a raw `usize` where a `NodeId` is expected).

The right-hand side is any type annotation, resolved in the module that declares
the alias; an unknown target or a cyclic chain (`type A = B; type B = A;`) is a
compile error at the declaration. Generic aliases (`type Pair<T> = ...`) and
composed forms (`A & B`, `A | B`) are reserved for a later phase.

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

### References - `ref T`

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

- `let` - mutable
- `const` - immutable binding
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
// Explicit block form - scope is lexically visible
disposable input = open_input(path)? "opening input" {
    const bytes = read_all(ref input)? "reading bytes";
    const stats = scan(bytes)? "scanning";
    return { stats: stats, err: "" };
    // dispose(input) fires at `}` - satisfies mustCall dispose beforeScopeEnd
}
// `input` is not in scope here

// Implicit form - same cleanup, scope is the rest of the enclosing scope
task analyze_implicit(path: string): Report {
    disposable input = open_input(path)?;
    const bytes = read_all(ref input)?;
    const stats = scan(bytes)?;
    return { stats: stats, err: "" };
    // compiler inserts dispose(input) before every exit path: `?`, return, fall-through
}

// Multiple block-owning bindings - LIFO ordering
task analyze_pair(): Report {
    disposable a = open_a()?;
    disposable b = open_b()?;
    // ... work ...
    return make_report();
    // cleanup order: dispose(b), then dispose(a) - reverse declaration
}
```

Semantically, the implicit form is equivalent to writing every block-owning binding's
block explicitly, nested in reverse order; the compiler just doesn't make you type it.

A kind-prefixed binding may only have a trailing block when **at least one** of its
kinds declares `ownsBlock`. For kinds without that clause, no block is allowed.

The `: type` annotation is **optional** on a kind-prefixed binding, exactly as on a
plain `let` / `const` - the type is inferred from the initializer:

```js
disposable input = open_input(path) { ... }   // type inferred from open_input
```

### Region kinds - anonymous block owners

A kind whose definition says `appliesTo region` (rather than `appliesTo binding`)
governs a **lexical region, not a named value**. It is the right shape when the value
exists only for the ambient state it installs on entry and undoes on exit - an
allocator scope, a pushed context, a transaction - and there is nothing to refer to
inside the block. A region kind is used with **no binding name**:

```js
// Explicit block - the guard's effect is active inside, undone at `}`
ephemeral allocator_scope(arena) {
    const rects = ctx_alloc(n);   // draws from `arena`
    // ...
}                                 // dispose() fires here

// Implicit block - effect active for the rest of the enclosing scope (LIFO)
ephemeral allocator_scope(arena);
const rects = ctx_alloc(n);
// dispose() fires at the enclosing scope end
```

A region kind must declare `ownsBlock` (the region *is* the block) and may not also
apply to a value site. The two shapes are mutually exclusive at the use site and the
compiler enforces the distinction: an `appliesTo binding` kind used without a name is
an error (give it a name), and an `appliesTo region` kind given a name is an error
(drop it). The cleanup machinery is identical to a name-less `disposable` - the value
is still constructed and disposed; you simply cannot name it. `ephemeral`
(`std/core/kinds.yoop`) is the standard-library region kind; define your own for other
ambient guards.

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
ABIs or special codegen. `err` observation is still enforced - the type system
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
- `extends` chains traits - a `BatchIterable<T>` is also an `Iterable<T>`.
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

### Vtables - type-erased trait dispatch (Phase 9.G)

Generics give yoop **compile-time** trait polymorphism: each trait method
call against an `<T implements Trait>` bound monomorphizes per concrete `T`.
That's the right answer for performance, but it makes heterogeneous
collections impossible - a `T[]` can only hold one monomorphization at a
time.

`vtable Name for TraitName { ... }` declares a **runtime-polymorphic shape**
backing a trait: a struct of `{ ctx, methodPtr1, methodPtr2, ... }` whose
slots match the trait's methods. The compiler owns the ctx slot; the
user names the method slots and writes their function-pointer types using
the `(p: T) => R` form (the **only** place `=>` is currently legal - see
"function value types in type position" below).

```js
trait Readable {
    function read(ref self, ref buf: uint8[]): int32;
}

vtable Reader for Readable {
    read: (ref buf: uint8[]) => int32,
}

const r: Reader = Reader.from(ref my_tcp_stream);   // builder
const n = Reader.read(ref r, ref buf);              // indirect dispatch
```

Two builtins on every vtable type:

- **`VTableName.from(ref x)`** - constructs a vtable value from any
  `ref T` where `T implements TraitName`. The compiler stores `&x` as
  the ctx and pulls the method addresses from `T`'s impl.
- **`VTableName.fromFn(f1, f2, ...)`** (Phase 10.K) - constructs a vtable
  value directly from named functions, one per trait method in declaration
  order, with no struct + impl boilerplate. Each function's signature must
  match the corresponding method slot (the trait method minus `ref self`).
  The functions are stateless, so the ctx slot is null; the compiler emits a
  ctx-dropping shim around each function so the uniform ctx-first dispatch
  convention still calls them. fromFn-built and from(ref struct)-built values
  share the same nominal vtable type, so one array can hold a mix of both.
  Arguments must be named functions (so their address is known statically),
  not runtime function-pointer values.
- **`VTableName.method(ref v, ...)`** - dispatches through the vtable's
  method slot. Equivalent to `TraitName.method(ref v, ...)` where v is
  the vtable value; both forms produce the same IR.

Field signatures must match the trait method's signature **minus
`ref self`**. The vtable's ctx pointer is what the impl method's
`ref self` lands as at runtime - the impl was already written assuming
`ref self` is a struct pointer, so no per-impl shim is needed.

Heterogeneous lists work directly: a `Reader[]` can mix `TcpStream`,
`BufferedReader`, and `FileReader` impls because every slot is a vtable
value of the same nominal type. Pre-9.G this required hand-rolled
`unsafe_ptr<void>` plus parallel fn-pointer fields, with no compiler help.

### Function value types in type position (Phase 9.G)

`(p1: T1, p2: T2, ...) => RetT` is a **function-value type annotation**. It
is legal in struct fields, parameter type annotations, return type
annotations, and vtable field declarations. Call sites use the same `f(args)`
syntax whether `f` is a named function or a function-pointer value.

```js
type Handler {
    handle: (req: Request) => Response,
}
```

A function-value type may be wrapped in parentheses to form a type group, so
an array suffix attaches to the whole function type rather than its return
type (Phase 10.K). This is the way to spell an **array of function pointers**:

```js
// array of predicates - each element is a (uint8) => bool function pointer
preds: ((ch: uint8) => bool)[]
```

Without the grouping parens, `(ch: uint8) => bool[]` parses as a function
returning `bool[]` (the return type is parsed greedily). The grouping form
`( T )` works for any type, but its only load-bearing use is lifting an array
suffix out past a `=>`.

The form is **only** valid in type position - `=>` is not a closure-literal
syntax (closures aren't planned). Function-value materialization (Phase
10.X.2) lets a bare top-level function name be used as a value wherever a
matching `(p: T) => R` is expected - a struct field initializer
(`{ handle: my_func }`), a function-pointer parameter
(`count_where(src, isDigit)`), or a `VTableName.fromFn(...)` argument. A
function-pointer parameter or local is itself callable by name -
`pred(ch)` is an indirect call through the stored pointer. A named
function captures nothing, so it materializes to a plain code-pointer address
with no environment or allocation - the non-capturing case that needs no
closure machinery.

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

// The three below are the real declarations from std/core/kinds.yoop.
// The concurrency kinds are not compiler keywords - they are ordinary kind
// decls, and the compiler checks that std declares them with the clauses it
// consults. See "Clauses you can use vs. clauses that describe a builtin".

kind pooled {
    appliesTo binding parameter field;
    requires Shared;
    refcounted retain release;               // names the two methods to bump/drop a ref
}

kind joined {
    appliesTo binding;
    requires Joinable;
    mustCall join beforeScopeEnd;
    mustNotEscape scope;
}

kind task {
    appliesTo function;
    pausable;                                // the function is a coroutine
    provides Task;                           // the CALL SITE yields Task<ReturnType>
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
and no colons in clause syntax - clause types are a closed set the compiler
owns, and the grammar reflects that.

Multiple `requires` are written as separate clauses
(`requires Disposable; requires Closable;`), not as a list.

### What a kind can declare

| Clause | Meaning |
|---|---|
| `appliesTo X...` | One or more of `binding`, `parameter`, `field`, `function`, `type`, or the standalone `region`. Default: any value-site. |
| `appliesTo region` | The kind governs a lexical region, not a named value: used only in the anonymous block form (`KIND EXPR { ... }` / `KIND EXPR;`), with no binding. Requires `ownsBlock`; mutually exclusive with the value sites above. See §4 "Region kinds". |
| `requires Trait` | Values of this kind must implement the named trait. Repeat to require multiple. |
| `provides Name` | Rewrites the **call-site result type** of a function carrying the kind: the body returns `T`, the call evaluates to `Name<T>`. Requires `appliesTo function`. `Name` resolves only to `Task` today. |
| `pausable` | Functions carrying the kind are coroutines: they may suspend, which forces the `await` calling convention. Requires `appliesTo function`. |
| `refcounted retain release` | Names the two methods of the required trait the compiler calls to bump and drop a reference. Dispatched for a `Task<T>` receiver; on any other receiver use `mustCall`. |
| `signature (p: T) => R` | The shape every function carrying this kind must have. Required on a *collected* function kind. |
| `enumerable as "table"` | Names the table a consumer asks the compiler for (e.g. `suite` is `enumerable as "suites"`). Required on a *collected* function kind. |
| `conferred` / `restrictive` | Makes this a **marker kind** - a static type-level tag with no obligation and no codegen. See §6 "Marker kinds". |
| `clearedBy m` / `appliedBy m` | Names the method of the `requires` trait authorized to strip (`restrictive`) or grant (`conferred`) the marker. |
| `ownsBlock` | Binding may take a trailing `{ ... }` that narrows its scope. Without one, compiler synthesizes an implicit block at the tail of the enclosing scope; multiple such bindings nest in reverse declaration order (LIFO). |
| `mustCall fn beforeScopeEnd` | Fn must run before the binding's scope exits - an explicit block if present, otherwise the enclosing scope. |
| `mustCall fn beforeAny` | *(reserved - not implemented.)* Fn must run before any other method. |
| `mustCall { a; b; } beforeScopeEnd` | *(reserved - not implemented.)* At least one of these must run. |
| `mustCall fn afterAny` | *(reserved - not implemented.)* Fn must run after every other method. |
| `mustNotShare acrossScopes` | Cannot cross into a concurrent task. |
| `mustNotShare acrossThreads` | Cannot flow into a `task` spawn. Statically rejected at every task-call argument site. |
| `mustNotEscape scope` | Cannot be returned or stored outside its scope. |
| `autoJoin beforeScopeEnd` | *(Removed - not a clause.)* It was `mustCall wait beforeScopeEnd` under another name. Writing it is an error with a fix-it; `joined` in std/core/kinds.yoop spells it `mustCall join beforeScopeEnd`. |
| `restricts iteration { ... }` | *(Reserved - not implemented.)* Which `for*` forms are legal on this value. Writing it is a "not yet supported" error. |
| `layout { ... }` | Memory layout contract (align, packing, SoA/AoS). |
| `propagates<K>` / `contains<K>` | How containers surface or absorb another kind's constraints. |
| `forbids X...` | Categories a function may not touch (`io`, `globalState`, …). |

**Cleanup on early return from `?`.** Any `mustCall` obligation that's live at the
point a `?` triggers an early return must be satisfied before the return actually
happens. The compiler inserts the call. This is how `disposable input = open(p) { … ?
… }` can promise `dispose(input)` runs even when the block exits via `?`.

### Clause behavior comes from the clause, not the kind's name

Every clause in the table above works on any kind you declare. The compiler
reads the clause off whatever kind decl it finds, so your kind gets the same
treatment std's does. Nothing in the system is reserved to std. (A small group
of clauses is reserved and rejected outright with a "not yet supported"
message; those are marked in the table.)

That is worth stating explicitly because the concurrency kinds look built in
and are not. `task`, `async`, `joined`, and `pooled` are ordinary
`kind { ... }` decls in [std/core/kinds.yoop](std/core/kinds.yoop), autoloaded
into every module graph, and `task`/`async` lex as ordinary identifiers exactly
like `test` and `suite` do. Declaring their clauses under your own name gets
you their behavior:

```js
// `spawn` is `task` under another name. This is a real coroutine, and the
// call site really does produce Task<int32>.
kind spawn {
    appliesTo function;
    pausable;                 // the function is a coroutine
    provides Task;            // the call site yields Task<ReturnType>
}

spawn function work(): int32 { return 7; }

function main(): int32 {
    pooled h = work();        // h is Task<int32>
    printf("v=%d\n", wait h);
    return 0;
}
```

The same holds for the handle-binding side. A kind declaring `requires Shared`
plus `refcounted retain release` binds a task handle exactly the way `pooled`
does, copy-retain included; one declaring `mustCall join beforeScopeEnd`
behaves like `joined`.

**What the compiler still owns.** Three things are not derived from clauses and
cannot be spelled by a user kind:

- **`Task<T>` itself.** It is a compiler type, so it cannot carry an
  `implements` list, and its `retain` / `release` / `join` bodies lower to the
  runtime's `yoop_task_*` calls directly. A kind may `require` the traits a
  Task satisfies (`Shared`, `Joinable`), which is what lets your kind bind one.
- **`refcounted` on a non-Task receiver.** The retain/release the clause names
  are only dispatched for a task handle today. A struct that implements the
  required trait directly gets no automatic retain or release; use `mustCall`
  for that, which is trait-dispatched and works on any receiver.
- **`provides <Name>`** resolves only to `Task`. There is no general
  call-site wrapping into an arbitrary user generic - see §17 open question 1.

**The core-kind contract.** Because the compiler consults these clauses rather
than the names, std's declaration is load-bearing, and the compiler checks it.
Delete `provides Task` from std's `task` and every program that spawns a task
stops building:

```text
std/core/kinds.yoop's kind 'task' is missing a clause the compiler depends on.
Expected at least: kind task { appliesTo function; pausable; provides Task; }
```

So `kind task { appliesTo function; pausable; provides Task; }` is both the
definition of `task` and a checked description of what the compiler does with
it. Read it when you want to know why `task fetch(): Bytes` produces a
`Task<Bytes>` at the call site, rather than leaving that as folklore.

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

// on a function declaration - replaces the `function` keyword
task fetch(url: string): Bytes { ... }
```

### Composition

```js
kind slow_batch = throughput_capped(8) & mustNotEscape;
```

Operands can also be inline `{ ... }` bodies - anonymous bags of clauses
for tacking a single restriction onto a composition without declaring a
named kind for it:

```js
kind scoped_alt = disposable_base & { mustNotEscape scope; };
```

An inline body may contain any kind clause except `appliesTo` (the
composition's `appliesTo` is the intersection of its named operands; inline
operands inherit it). Inline bodies must contain at least one clause.

Contradictory compositions are compile errors (`align: 32` & `align: 64`,
`allow parallel` & `mustNotShare acrossScopes`, …).

### Containment and propagation

When a struct embeds a field whose type or kind carries rules, the struct must declare intent:

```js
type RenderPass propagates<gpu_buffer> { buf: GpuBuffer; }   // callers inherit rules
type RenderPass contains<gpu_buffer>   { buf: GpuBuffer; }   // struct absorbs them
```

`contains<K>` is reserved but not yet implemented; until it lands, a function that breaks the propagates chain (creates a value of a propagating type, satisfies its rules locally, and returns it without re-declaring `propagates<K>`) is implicitly a "contains" boundary - the caller sees a value with no outstanding obligation.

Functions propagate the same way:

```js
function make_pass(scene: Scene): RenderPass propagates<gpu_buffer>;
```

**`propagates<K>` is a "must handle, or hand off" contract.** A value of a type that declares `propagates<K>` cannot be silently discarded. The user has exactly three legal ways to discharge the obligation:

1. **Auto-cleanup via the kind keyword.** Bind the value with the kind prefix and the compiler injects the cleanup at scope end:

   ```js
   disposable arr: DynArray<int32> = new_dynarray(4);
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
   function new_dynarray<T>(n: usize): DynArray<T> propagates<disposable> {
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

### Kind-prefixed functions - `function` keyword optional

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

The runtime contract - how tasks are allocated, scheduled, waited on, and torn
down - is specified separately in [plans/runtime-design.md](plans/runtime-design.md).
This section describes only the language surface.

### The model

- `task` is a kind applied to a function. It declares that the function's return value becomes a `Task<T>` at the call site.
- Every call to a `task` function is **semantically a spawn**. The compiler may lower spawn-then-immediate-wait into a direct synchronous call when it can prove no observable difference; otherwise the runtime schedules the work on a worker thread.
- `wait` blocks the calling thread until the task body completes. (Suspendable `wait` - yielding the worker rather than blocking it - is a planned future capability and does not change the surface syntax.)
- The **binding's kind** decides when the compiler forces the `wait`:

| Binding form | When `wait` is forced | Lifetime / storage |
|---|---|---|
| `let x = f()` (no kind) | Immediately - the next statement sees the value. | Stack-allocated handle; spawn + wait inline. |
| `let joined d = f()` | At the enclosing scope's `}` (`autoJoin`); also on first read of `d` if earlier. | Stack-allocated; bounded by scope. |
| `let pooled h = f()` | Never automatically - you call `wait h` yourself. | Heap-allocated, atomically refcounted. |

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

- A plain `function` (no `task`) cannot be bound as `joined` or `pooled` - the binding kind's `requires Task` isn't satisfied.
- `joined` carries `mustNotEscape scope` - the value cannot be returned or stored outside its declaring scope.
- `pooled` is a plain value-typed handle. It can be returned, stored in arrays, passed by value or by `ref`. The kind imposes no compiler-enforced lifecycle obligation; the user calls `wait` (or simply drops the handle to fire-and-forget).

### Handle operations

| Operator | Meaning |
|---|---|
| `wait h` | Block until the task referenced by `h` completes; evaluate to the result. `h` must name a binding of type `Task<T>`. |
| `wait_until(h, deadline_ns)` | Bounded wait. Returns `WaitResult<T>` from [std/core/concurrency.yoop](std/core/concurrency.yoop) - `Done { value: T }` on completion, `Timeout` on deadline expiry, `Cancelled` if `cancel(h)` was observed first. `deadline_ns` is absolute, in the same clock space as `now_ns()`. Phase 10.F.1 + 10.F.2.a. |
| `cancel(h)` | External cancellation primitive (Phase 10.F.2.a). Sets the handle's cancel byte and broadcasts so any `wait_until` parked on `h` wakes immediately and observes `WaitResult.Cancelled`. The task body itself is not yet cooperative - it keeps running to natural completion; the caller has simply chosen to stop observing the result. Cooperative in-body polling (the `cancellation: ref Cancel` implicit parameter) lands in 10.F.2.b. |

`wait` is a keyword-level operation, not a method on `Task<T>`, so the compiler can
account for it during flow analysis (in particular, the `joined` kind's `autoJoin`
clause is implemented by inserting a synthetic `wait` at scope exit, and the
compiler must recognize the operator to detect when an explicit user `wait` makes
the synthetic insertion redundant).

`wait_until` is the bounded sibling - same builtin-call shape, two args
instead of one. Unlike `wait`, it does **not** dispatch queued tasks on
the calling thread while blocked: a queued task that ran past the
deadline would invalidate the user's "give up at time T" contract.
Worker threads continue to drain the queue normally; the caller simply
parks on the queue condvar with the deadline as the timeout. A typical
call shape:

```js
import { WaitResult, now_ns } from "std/core/concurrency.yoop";

pooled h = fetch(url);
let deadline: uint64 = now_ns() + 250_000_000;  // 250ms from now
switch (wait_until(h, deadline)) {
    case WaitResult.Done { value: body }: { use(body); }
    case WaitResult.Timeout: { abandon_request(); }
}
```

`_ = expr;` is the language's generic discard form (see §4). When `expr` is a
task call (`_ = fetch(url);`), the result handle is spawned and immediately
dropped; the body still runs to completion in the background, and its result is
discarded when the worker releases the last reference. This is the
fire-and-forget idiom - it is not a task-specific operator.

### Safety and deadlock

The MVP runtime model uses run-to-completion tasks on a fixed-size worker pool
(see [runtime-design.md §3](plans/runtime-design.md)). Pre-Phase 9.I, a `wait`
inside a `task` body blocked the worker thread; with N workers and deeper-than-N
nested waits, the pool could deadlock - N tasks each waiting on an N+1th task
queued behind them with no worker free to drain it.

**Phase 9.I** changes the runtime so `wait` is suspendable: instead of parking
the calling thread on the awaited handle's condvar, the wait loop
opportunistically drains the global task queue on the calling thread until the
target completes (or new submissions / done-signals wake a short polling
park). The language surface is unchanged - `wait h` still has the same
synchronous appearance - but the chain-of-N+1 deadlock above no longer
deadlocks.

The semantics that user code can rely on:

- `wait h` still blocks the caller until `h` is done. From the caller's
  perspective there is no behavioral change.
- While the caller is "blocked", the runtime may run other queued tasks on the
  caller's thread. Per-thread state inside a task body (e.g. errno, thread-local
  vars) can therefore be observed in a different order than under the old
  always-park model. Treat thread-local state as task-local for portability.
- Recursion depth is bounded by the nested-wait chain; very deep chains can
  exhaust the OS stack the same way deep direct recursion would.

---

## 9. Loops

Two loop keywords, both reserved for iteration - no extra keywords per strategy.
Iteration *strategy* is expressed as a **trait method call on the collection** in the
RHS of `in`. This keeps the `for … in` slot recognizable as a loop while letting kinds
and traits extend the strategy set.

> **v0 status.** The `for ITEM in EXPR { ... }` form works over arrays (Phase
> 9.D) and over any type implementing `Iterable<T>` (Phase 10.B), which is what
> `a..b` ranges, `Vec`, and `Map` ride on. The remaining trait-driven strategy
> slots below (`BatchIterable`, `SimdIterable`, `ParIterable`) are the long-term
> shape and are not implemented; the only strategy today is the sequential walk.

```js
// C-style numeric counter. The counter may be declared in the head, in which
// case it is scoped to the loop; the step slot takes `=` or a compound op.
for (let i = 0; i < n; i += 1) { ... }
for (i = 0; i < n; i = i + 1) { ... }        // counter declared before the loop

// Over an index space, via a range value (see "Ranges" below)
for i in 0..n { ... }

// Iteration over a collection - strategy comes from a trait method
for item  in xs                    { ... }   // default, from Iterable
for chunk in xs.batched(4)         { ... }   // chunk: T[] - from BatchIterable
for v     in xs.simd(8)            { ... }   // v is a SIMD lane - from SimdIterable
for item  in xs.parallel()         { ... }   // each iter a concurrent task - from ParIterable
```

### The C-style counter

The init slot accepts either an assignment to an existing binding
(`for (i = 0; ...)`) or a `let` declaration (`for (let i = 0; ...)`). A
`let`-declared counter is **scoped to the loop**: it does not leak into the
enclosing scope, and it may shadow a same-named binding out there. `const` is
rejected in the init slot, since the step mutates the counter.

The counter's type annotation is optional. When it is omitted and the
initializer is a bare numeric literal, the type comes from the **loop
condition**: if the condition compares the counter against a concrete numeric
operand, that operand's type wins. So `for (let i = 0; i < xs.len; i += 1)`
gives `i: usize`, not the `int32` a plain `let i = 0;` binding would infer.
Without such a comparison the ordinary literal defaults apply (`int32` /
`float64`). Annotate the counter to say something else:

```js
for (let i: int32 = 0; i < 10; i += 3) { ... }
for (let k: int32 = 3; k > 0; k -= 1) { ... }     // counting down
```

The step slot accepts `i = <expr>` or any compound-assignment operator
(`+= -= *= /= %=`), which means the same thing: `i += 2` is `i = i + 2`.

### Ranges

`a..b` is a half-open integer range: it yields `a`, `a + 1`, ... `b - 1`, and
nothing at all when `b <= a`. Elements are `usize`, matching every length and
index in the language, so `0..xs.len` needs no casts.

```js
for i in 0..xs.len { ... }         // the common index walk
for i in 1..xs.len - 1 { ... }     // `..` binds looser than arithmetic
```

The operator is **sugar, not a loop form**: `a..b` lowers to a call to
`exclusive` in `std/core/range.yoop`, so a range is an ordinary `Range` value
implementing `Iterable<usize>`. It can be bound, passed, returned, and walked
more than once (each walk gets its own copy of the cursor).

```js
const rows = 0..3;
paintEvery(rows);                  // Range is just a value
for i in rows { ... }
for i in rows { ... }              // walks again from 0
```

Bounds cannot be chained (`a..b..c` is an error). Inside brackets `..` keeps its
existing slice meaning (`xs[i..j]`, Phase 9.E) and never builds a range.

The body's bound variable's **type** tells you the mode: a `T[]` binding means you're
iterating in chunks; a parallel iterator's body runs under concurrent-task rules
automatically. No new keyword per strategy - the method name *is* the strategy, and
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
**inherits the iterator's body kind automatically** - inside `for item in xs.parallel()`,
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

<!-- No `switch` in v2. Pattern-matching on tagged unions is a future addition once the
error story hardens. (not true any more) -->

---

## 11. Errors as values

### The convention

A **fallible** return type is an enum with exactly two variants named `Ok` and
`Err`. Each variant carries zero or one payload field. The shape is structural -
there is no marker trait - so any user-defined enum that matches the convention
participates in `?` propagation. With generic enums (Phase 10.A) this collapses
to the standard library's `Result<T, E>` in [std/core/types.yoop](std/core/types.yoop):

```js
export enum Result<T, E> {
    Ok { value: T },
    Err { error: E },
}

function read_all(path: string): Result<Bytes, string> {
    if (path.len == 0) {
        return Result.Err { error: "empty path" };
    }
    // ...
    return Result.Ok { value: bytes };
}
```

A type is fallible iff it is an Ok/Err enum with at most one payload field per
variant. Nothing else qualifies. (The older Phase 2 struct-with-trailing-`err:
string` convention was retired in Phase 10.X - `Result<T, E>` covers the same
use case with cleaner mechanics.)

### The `?` operator - forced propagation

Postfix `?` on a fallible expression means: **if the call returned `Err`, return
the Err from the enclosing function now; otherwise produce the `Ok` payload**.

```js
function load_config(path: string): Result<Config, string> {
    const bytes  = read_all(path)?;         // bail on Err, bind Ok payload
    const parsed = parse(bytes)?;
    return Result.Ok { value: parsed };
}
```

The compiler rewrites `f()?` into the obvious early return:

```js
// let r = f()?;   expands to:
const _tmp = f();
switch (_tmp) {
    case Result.Err { error: e }: return Result.Err { error: e };
    case Result.Ok  { value: v }: r = v;
}
```

### What `?` yields

`?` produces the `Ok` payload value.

| Argument type | Result of `expr?` |
|---|---|
| `Ok { value: T }` | `T` - the Ok payload value |
| `Ok` (no payload) | `void` - statement-position only |
| non-fallible type | compile error - nothing to propagate |

### What the enclosing function must look like

`?` only compiles inside a function whose return type is also a fallible enum,
and whose `Err` payload type matches the operand's `Err` payload type exactly.

```js
function total(path: string): usize {
    const bytes = read_all(path)?;          // compile error: usize is not fallible
    return bytes.len;
}
```

Cross-shape propagation (operand and enclosing return have *different* `Err`
payload types - e.g. `Result<_, IoError>` into `Result<_, AppError>`) works
when the operand's `Err` payload type implements `Into<RetErr>` from
[std/core/traits.yoop](std/core/traits.yoop):

```js
trait Into<T> {
    function into(ref self): T;
}

type IoError implements Into<AppError> {
    code: int32,
    function into(ref self): AppError {
        return { msg: "io failed", code: self.code };
    }
}

function load(path: string): Result<Config, AppError> {
    const bytes = read_all(path)?;   // read_all returns Result<_, IoError>
    // ...                              the compiler inserts Into.into on the
    //                                  failure branch before building Err
}
```

The typechecker looks for a trait named `Into` in the operand-Err type's
`implementsTraits` whose single type-arg is the enclosing return's `Err`
payload type. A miss produces a fix-it pointing at the missing impl;
a hit rewrites the `?` failure branch to call
`Into.into(ref operandErr)` and store the returned target value into the
outer `Err` variant. The Phase 9.H same-type fast path is unchanged - the
conversion is paid only when the shapes actually differ.

### Attaching context (optional)

A suffix string on `?` attaches a context message to the propagated error. Both
literal forms are accepted - a double-quoted string, or a backtick template with
`${...}` interpolation:

```js
const bytes = read_all(path)? "loading config";
const field = parse_field(ref ps)? `parsing field ${n}`;
```

The context expression is evaluated **only on the failure branch**, so an
interpolated template costs nothing when the call succeeds.

Only those two literal forms are legal - not a general expression. `f()? -x`
would otherwise be ambiguous with subtraction.

Where the context lands depends on the `Err` payload type:

- **`string` payload on both sides** (the shape every `Result` in `std/` uses):
  the compiler concatenates `"<context>: <err>"` itself. No impl needed. Contexts
  stack as the error propagates outward through successive `?`s.
- **Any other payload type**: the operand's `Err` payload type must implement
  `WithContext<RetErr>` from [std/core/traits.yoop](std/core/traits.yoop), and the
  failure branch calls it to build the outer `Err` payload.

```js
trait WithContext<T> {
    function withContext(ref self, context: string): T;
}

type ParseError implements WithContext<ParseError> {
    msg: string,
    line: int32,
    function withContext(ref self, context: string): ParseError {
        return { msg: `${context}: ${self.msg}`, line: self.line };
    }
}
```

The impl decides where the context goes - a message prefix, a dedicated field, or
an accumulated breadcrumb list - which is why a structured payload routes through
a method instead of a blind string concat (`line` above survives untouched).

`WithContext<T>` subsumes `Into<T>`: because the target type is the trait's type
parameter, a single `IoError implements WithContext<AppError>` impl handles the
cross-shape conversion *and* the context, so a `?`-with-context between differing
`Err` types does not additionally need `Into<AppError>`. A `?` with no context
still uses `Into<T>` as described above.

A context string on a `?` whose `Err` variant carries no payload is an error -
there is nothing to attach to.

### Interaction with concurrency kinds

`?` inspects the discriminant of its argument - which means it needs the result
to exist. That constrains how it composes with `scoped` / `pooled` bindings:

```js
// Synchronous binding - result is available immediately
const bytes = fetch(url)?;                  // OK

// Scoped binding - task hasn't joined yet at this statement
let scoped r = fetch(url)?;                 // compile error

// Pooled binding - task handle, not a result
let pooled h = fetch(url)?;                 // compile error

// Correct: propagate after the wait
let pooled h = fetch(url);
const bytes  = wait h?;                     // OK - wait returns a fallible type
```

The rule: `?` is legal on any expression whose type is fallible *and is available at
the point the `?` appears*. A task handle is not; a completed task result (or a
synchronous call's result) is.

### Why not `?? throw` or exceptions?

Earlier drafts had `?? throw` as a sugar form. `?` subsumes it - one operator,
tighter syntax, and it integrates with `switch`. There are no exceptions in
Yooperlang; every error boundary is visible at the token level (`?` or an
explicit `switch` over `Ok`/`Err`).

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
- `extern "Rust" from ...` / `extern "Zig" from ...` - syntax reserved.

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
| `*p = v` | - | Assignment LHS form; `v` must be assignable to `T`. |
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
arg, or the other side of an equality compare) - a bare `null` in an
unconstrained position is a typecheck error.

Without `import.unsafe;`, `unsafe_ptr<T>` is not in scope and any mention of it
is a typecheck error. Pointers do not participate in kind containment: a struct
holding `unsafe_ptr<T>` does not inherit kind obligations from `T`. `unsafe_ptr`
is also rejected inside `pure` functions.

### C-portable integer aliases

Extern signatures often need to match C types whose width is platform-dependent.
The following aliases are name-aliases that resolve to fixed-width yoop integers:

| Alias | LP64 (Linux / macOS) | LLP64 (Windows, deferred) |
| --- | --- | --- |
| `c_short` / `c_ushort` | `int16` / `uint16` | `int16` / `uint16` |
| `c_int` / `c_uint` | `int32` / `uint32` | `int32` / `uint32` |
| `c_long` / `c_ulong` | `int64` / `uint64` | `int32` / `uint32` |
| `c_size_t` / `c_ssize_t` | `usize` / `isize` (= 64-bit) | `usize` / `isize` |

The aliases are typecheck-time synonyms - a `c_int` value *is* an `int32` for
every purpose, including coercion and assignment. Using the alias in an extern
signature documents portability intent.

Phase 8.B targets **LP64** only; the LLP64 column is the future-Windows mapping.

A struct mirroring a C struct should declare `layout { abi "C"; }` to mark its
intent to match the C ABI. The marker is contractual today - yoop's natural
struct layout (field-declaration order, per-field natural alignment) already
matches C for trivially-aligned structs.

### Buffer interop

Two `import.unsafe;`-gated intrinsics bridge yoop's fat-pointer arrays and
raw libc buffers:

```js
let xs: int32[] = [1, 2, 3];
let dp: unsafe_ptr<int32> = xs.ptr;       // borrow the data pointer
read(0, raw.ptr, raw.len);                 // pass yoop buffer to libc

let buf: unsafe_ptr<uint8> = malloc(16);
let view: uint8[] = unsafe_ptr.toArray<uint8>(buf, 16);
view[0] = 42;                              // index/iterate the malloc'd buffer
```

- `xs.ptr` (intrinsic field on any array type) returns `unsafe_ptr<T>` to the
  first element. It is a *borrow*: the array still owns its memory, the
  pointer must not be freed through, and must not outlive the array binding.
- `unsafe_ptr.toArray<T>(p, n)` wraps a `(ptr, len)` pair as a borrowing
  `T[]` view - no copy, no allocation. Underlying memory must outlive the
  view.

Both raise a typecheck error in modules without `import.unsafe;`.

### `errno`

Most libc functions signal failure with a sentinel return value and leave
the actual reason in `errno`. Yoop exposes three thread-local intrinsics:

```js
errno.get(): c_int                   // read the current thread's errno
errno.set(v: c_int): void            // clear or stash a value
errno.message(c: c_int): string      // strerror(c)
```

`errno` is thread-local on every supported platform. With the current
run-to-completion task runtime, the value survives any sequence of FFI
calls within a single yoop function. Once Phase 8.F lands real Task
suspension, the suspension boundary will save and restore `errno`.

Recommended pattern: extern signatures return raw C result types; a
yoop-side wrapper converts `(rv == -1)` + `errno` into the fallible-struct
convention.

```js
extern "C" from "fcntl.h" {
    function open(path: string, flags: c_int): c_int;
}

type OpenResult { fd: c_int, err: string }

function open_safe(path: string, flags: c_int): OpenResult {
    let fd: c_int = open(path, flags);
    if (fd < 0) {
        let code: c_int = errno.get();
        return { fd: -1, err: errno.message(code) };
    }
    return { fd: fd, err: "" };
}
```

`errno` is not gated by `import.unsafe;` - reading or setting an integer
does not surface any pointer values.

### Memory (heap allocation)

Two compiler-recognized generic functions are available globally - no
import required, no `import.unsafe;` required, no extern decl required:

```js
heap_alloc<T>(n: usize): T[]    // malloc n * sizeof(T); fat-pointer view
heap_free<T>(a: T[]): void      // free the underlying data pointer
```

`heap_alloc<T>` returns a fresh heap-backed `T[]`. The element type `T` is
inferred from the call's context (typically the LHS annotation, e.g.
`let xs: int32[] = heap_alloc(64);`). The result is a fat pointer view -
indexing, `.len`, and assignment work exactly like a stack-allocated array
literal.

`heap_free<T>` frees the buffer behind a `heap_alloc`-produced array.
Using the array after free is undefined behavior; double-free is undefined
behavior. The yoop type system does not check either invariant - typical
usage is through a `Disposable + propagates<disposable>` wrapper (see
`Vec<T>` in `std/core/vec.yoop`) that ties the free to scope exit.

These functions live in the `$builtin` namespace and are registered into
every module's generic-function table, so call-site inference handles
them uniformly with other generics.

### Bytes, strings, and the conversion bridges

Two compiler-recognized functions bridge yoop's `string` and `uint8[]`
representations. Both are global (no import needed) and not gated by
`import.unsafe;` - they produce values entirely inside yoop's type
system:

```js
string_as_bytes(s: string): uint8[]
    // Zero-copy view. The returned uint8[] shares the string's storage.
    // The view does not outlive the string.

string_from_bytes_unchecked(buf: uint8[]): string
    // Fresh heap allocation: malloc(buf.len + 1), memcpy, write NUL.
    // Does NOT validate UTF-8 - callers asserting UTF-8 should reach for
    // the validating wrapper `string_from_bytes` in std/core/strings.yoop.

array_slice<T>(xs: T[], start: usize, end: usize): T[]
    // Zero-copy fat-pointer view {xs.ptr + start, end - start}. Caller
    // responsible for keeping `xs` alive as long as the slice is used.
```

Higher-level operations are pure-yoop wrappers in the `std/core/` modules:

- **`std/core/bytes.yoop`** - `bytes_eq`, `bytes_index_of`,
  `bytes_index_of_seq`, `bytes_starts_with`,
  `bytes_eq_ignore_ascii_case`, `bytes_slice`, `bytes_copy`,
  `bytes_parse_int`.
- **`std/core/strings.yoop`** - `string_eq`, `string_eq_ignore_ascii_case`,
  `string_starts_with`, `string_index_of`, `string_slice`,
  `string_concat`, `string_concat_all`, plus the validating
  `string_from_bytes` wrapper that returns `StringFromBytes { value, err }`.

Naming convention conveys allocation cost at the call site:

- **`_as_*`, `_slice`** - borrowing views, no allocation.
- **`_new`, `_copy`, `_from_*`, `_concat`, `_concat_all`** - fresh heap
  allocations. Caller owns the returned storage.

### `std/core/vec.yoop` - growable vector

```js
type Vec<T> implements Disposable propagates<disposable> {
    data: T[],
    len: usize,
    cap: usize,
    // dispose frees the backing buffer
}

vec_new<T>(initial_cap: usize): Vec<T> propagates<disposable>
vec_push<T>(v: ref Vec<T>, value: T): void   // MAY REALLOCATE
vec_get<T>(v: ref Vec<T>, i: usize): T
vec_set<T>(v: ref Vec<T>, i: usize, value: T): void
vec_clear<T>(v: ref Vec<T>): void
vec_as_array<T>(v: ref Vec<T>): T[]          // view; valid until next mutation
```

`Vec<T>` propagates `disposable`, so every binding picks one of the
standard discharge mechanisms:

```js
disposable v: Vec<int32> = vec_new(4);   // auto-cleanup at scope end
// or
let v: Vec<int32> = vec_new(4);
// ... use ...
Disposable.dispose(ref v);               // manual
// or
function build(): Vec<int32> propagates<disposable> {
    return vec_new(4);                   // transfer up
}
```

`vec_push` is flagged "MAY REALLOCATE" in the API contract: when
`len == cap`, the backing buffer doubles, and any prior `vec_as_array`
view dangles.

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
abi             appliesTo        autoJoin         bool
break           c_int            c_long           c_short
c_size_t        c_ssize_t        c_uint           c_ulong
c_ushort        char             const            contains
continue        else             errno            export
extern           false
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

Identifiers: `[A-Za-z_][A-Za-z0-9_]*`. Naming convention: types, traits,
variants / enums / unions, vtables, type parameters, and `variant` case names
are `PascalCase`; functions, methods, local bindings, parameters, fields, and
kind names are `camelCase`; value-`enum` case names and module-level `const`
declarations are `SCREAMING_SNAKE`. `snake_case` is reserved for file and folder
names - it is not used in identifiers (the underscore remains legal in the
grammar above). See CLAUDE.md "Naming and file conventions".

Contextual keywords (reserved only in their syntactic positions): `in`, `layout`,
`restricts`, `provides`, `requires`, `appliesTo`, `ownsBlock`, `mustCall`,
`mustNotShare`, `mustNotEscape`, `autoJoin`, `forbids`, `propagates`,
`contains`, `from`, `library`, `as`. Inside kind-clause bodies, the timing
modifiers `beforeScopeEnd`, `beforeAny`, `afterAny`, the axis identifiers
`scope`, `acrossScopes`, `acrossThreads`, and the `appliesTo` site identifiers
`binding`, `parameter`, `field` are also contextual.

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

// Top-level handles errors explicitly - main returns void, so `?` isn't available.
function main(): void {
    const { stats, err } = analyze("data.txt");
    if (err) {
        fprintf(stderr, "analyze failed: %s\n", err);
        return;
    }
    printf("upper=%d lower=%d\n", stats.upper, stats.lower);
}

// Top-level handles errors explicitly - main returns void, so `?` isn't available here.
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

- **Block-owning `disposable`** - the kind's block is the input's lifetime, lexically visible. `dispose(input)` runs at the block's `}` regardless of how it exits.
- **`?` propagation with cleanup** - each `?` inside the block propagates the error *after* the compiler inserts `dispose(input)`.
- **Dropped `const`** - `disposable input = …` has no `const` keyword; the kind prefix makes it implicitly `const`. Symmetric with `task fetch(...)` dropping `function`.
- **Context attachment** - `? "msg"` prefixes the propagated error with a human-readable tag.
- **Boundary handling** - `main` returns `void`, so `?` is unavailable; errors are consumed via destructure + `if (err)`.
- **Destructuring as sugar** - `const { stats, err } = analyze(...)` compiles to a temp + two field reads, same codegen as hand-written field access.

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

1. **What `provides` may wrap into.** Mostly settled. `provides Name` means the call-site result type of a function carrying the kind becomes `Name<DeclaredReturn>` - `task f(): T` yields `Task<T>` where it is called - and it is now derived from the clause, so a user kind declaring `pausable; provides Task;` gets a real coroutine and a real task handle (§6 "Clause behavior comes from the clause, not the kind's name"). What remains open is the *range* of `Name`: it resolves only to `Task` today. Letting it name an arbitrary user generic needs an answer for how the wrap and unwrap happen - `Task<T>` is not just a type, it carries a worker pool, `wait`, and cancellation, so a kind that wrapped into a plain `MyBox<T>` would mint a value with no way to get the `T` back out. That is what the `provides … intercepts { … }` sketch was reaching for: a companion clause naming the wrap/unwrap pair, so a code-transforming kind stays visibly different from a constraining one. Related and smaller: `refcounted` dispatches its named retain/release only for a `Task<T>` receiver; generalizing it to any type implementing the required trait would make it a true sibling of `mustCall`.
2. **Trait method resolution.** Methods live on `type … implements Trait` blocks. Call syntax is **trait-qualified**: `Disposable.dispose(ref x)` - the trait name must be in scope at the call site. (Phase 7.4 settled this: bare-form `dispose(ref x)` and dotted form `x.dispose()` are both rejected. Trait method names live in the trait's namespace and may freely coincide with module-level free-function names or with method names from other traits implemented by the same type, because every call site is unambiguously qualified.)
3. **String ↔ cstr.** UTF-8 immutable `string` is TypeScript-adjacent; C expects null-terminated bytes. Options: implicit cstr view, explicit conversion, or two types.
4. **Array length & FFI.** `xs.len` intrinsic means fat pointers; worth a separate `c_array<T>` for ABI-exact interop.
5. **`ref` lifetimes.** Minimum rule: a `ref` cannot outlive the stack frame it names. Beyond that, `mustNotEscape` covers the rest.
6. **Multiple trait impls per type.** `type T implements (A, B)` - confirm grouping syntax.
7. **Kind parameters vs. trait generics.** `batchable(n: usize)` takes a value parameter; traits take type parameters. Keep them distinct or unify?
