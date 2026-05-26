# Exploration - Dynamic vtables for cross-binary generics

> Not a committed plan. Five alternatives for the same problem:
> what happens when a `.so` / `.dll` written in yoop wants to use a
> generic function or trait method but the necessary monomorphization
> wasn't baked into the binary at compile time. Companion to
> [exploration-package-system.md](exploration-package-system.md) -
> the package system question and the dynamic-linking question are
> independent but rhyme.

## What's the actual problem

Today the compiler is whole-program. The instantiation registry in
[src/jsyooptypecheck/instantiate.js](../src/jsyooptypecheck/instantiate.js)
sees every call site and emits one LLVM define per concrete
`(generic_decl, [type_args])` tuple via `codegenProgram` in
[src/jsyoopcodegen/codegen.js:1533](../src/jsyoopcodegen/codegen.js#L1533).
Codegen never sees a `TypeParamType` - everything is concrete by the
time it gets there ([codegen.js:1605 `cloneAstWithSubstitution`](../src/jsyoopcodegen/codegen.js#L1605)).

This works because the call sites and the generic definitions are in
the same compilation. If we ship a precompiled `mylib.yoop.so` that
exports `function process<T implements Display>(x: T): void`, none of
its call sites are visible at link time:

- The host that loads the `.so` has its own `T = AppWidget` and wants
  `process<AppWidget>` to exist.
- The `.so` was compiled without ever seeing `AppWidget` - the
  monomorphization doesn't exist anywhere.
- The trait method `Display.show(ref AppWidget)` was compiled into
  the host. The `.so` needs to call it but can't have linked against
  a symbol it never knew about.

There's a related sub-problem: the user phrased it as "augment vtables
based on whatever a DLL/dynamic binary might require." That suggests
the scenario where the DLL knows its own types and traits, but the
host needs to *consume* them - the inverse direction. Same root cause:
the compilation that emits the trait-method symbol isn't the
compilation that needs to call it.

We already have one piece of infrastructure that points at the
solution: Phase 9.G landed `vtable T for Trait` as a first-class
value, with `=>` function value types. A `vtable<AppWidget, Display>`
is a real heap-allocatable struct of function pointers. If we lean on
this, the dynamic-linking story is mostly about *who builds the
vtable and when*.

## What changes in the language vs in the toolchain

Some alternatives below are purely toolchain changes - the language
doesn't grow. Others introduce real language-level concepts (a `dyn`
modifier, an exported manifest of needed monomorphizations). Tagging
each one for clarity.

## Alternatives

### Alternative A - "No dynamic generics" (status quo extended to .so)

Rule: a yoop `.so`/`.dll` is allowed to *export* only concrete,
fully-monomorphic functions and types. Generic decls cannot cross
binary boundaries. If the DLL wants a polymorphic API, it has to
materialize concrete shims:

```yoop
// inside the .so
function process_widget(x: ref AppWidget): void { generic_process(x); }
function process_button(x: ref AppButton): void { generic_process(x); }

export "C" process_widget;
export "C" process_button;
```

Trait methods on DLL-internal types stay internal. Trait methods that
the DLL needs to call on host types are passed in as function-pointer
arguments at the C ABI boundary (or via the `=>` function value types
we already have).

Cost to the language: zero. Cost to users: high - generics are a
load-bearing feature and forcing them to be concrete at every binary
edge is a real downgrade.

Pros:

- Nothing new to design or implement.
- All the existing performance characteristics survive (monomorphic
  inlinable code).
- Easy to explain.

Cons:

- Defeats the point of having a generic `process<T>` if you can't
  ship it. Every consumer of the DLL has to be linked statically.
- Trait composition across DLL boundaries collapses to manual
  function-pointer plumbing.

When this is right: when the dynamic-linking story is purely "talk to
C from yoop" and "ship a yoop CLI." It is *not* right if we want
plugin systems, hot-reloading, or any of the "ship a library that
others can use polymorphically" stories.

### Alternative B - "Caller-supplies-monomorphizations" via a needs manifest

Language touch: small. Toolchain touch: medium.

The DLL is compiled, and alongside the `.so` the compiler emits a
`mylib.yoopneeds` file that lists every generic decl the DLL contains
plus every trait-method site the DLL calls. The host's compiler reads
this file when linking against the DLL and:

- Generates monomorphizations of the DLL's generic functions for each
  concrete type the host uses, and emits them into the *host* binary
  with mangled names the DLL knows to look up.
- Generates per-trait method symbols for host types that the DLL
  needs to call.

The DLL has stub call sites that go through a lookup table populated
at load time by the host (or via a registration callback on dlopen).

Pros:

- Keeps full monomorphic performance everywhere - no runtime vtable
  indirection beyond what trait dispatch already does.
- DLL's source doesn't have to ship - only signatures and the
  `.yoopneeds` manifest.
- Works without any new language surface.

Cons:

- The host's compiler has to generate code for the DLL author's
  generic bodies, which means the bodies have to be available in
  *some* form. Either the `.yoopneeds` ships the bodies inline (yoop
  source or some IR), or there's a chicken-and-egg problem.
- A lot of new build-system machinery: a manifest format, a
  registration handshake at load time, mangling negotiation between
  the host's compiler and the DLL's exported names.
- Doesn't solve the "host has a type the DLL has never seen" case
  unless the DLL ships its generic bodies as IR.

When this is right: when DLL authors are willing to ship their
generic bodies (in source or in some intermediate form) and the
performance target is "as fast as static linking."

### Alternative C - "Uniform `dyn` calling convention at binary edges"

Language touch: medium (new `dyn` modifier on types). Toolchain touch:
medium.

A function signature exposed across a binary boundary can use `dyn
Trait` in place of a generic type parameter:

```yoop
// today (whole-program):
function process<T implements Display>(x: ref T): void { ... }

// the dyn form (binary-boundary):
function process(x: ref dyn Display): void { ... }
```

`dyn Display` is a wide pointer - `(data_ptr, vtable_ptr)`. Trait
calls through it go through the vtable. The function has *one* LLVM
define, not one per type; the cost is paid at the call site (one
indirect load + indirect call per trait method).

Because Phase 9.G already gave us `vtable T for Trait` as a real
value, the implementation is largely "package up an existing vtable
value as half of a fat pointer." The host calls
`process(value, vtable<AppWidget, Display>)`; the DLL emits one body
that does `vtable.show(data)` instead of `T.Display.show(data)`.

For multi-bound type params (`<T implements (A, B)>`), the `dyn` form
takes one vtable per trait: `dyn (Display, Hash)` becomes a triple
`(data, vtable_Display, vtable_Hash)`.

Pros:

- Solves the cross-binary problem cleanly. One symbol per function,
  works with any caller-side type that satisfies the trait, no host
  cooperation required.
- Builds directly on existing 9.G machinery. The vtable type is
  already in the type system.
- Familiar shape - Rust users will recognize `dyn Trait`. Java users
  will recognize "interface dispatch."
- Authors choose where to pay the cost. Internal hot paths stay
  monomorphic, exported API surfaces opt into `dyn`.

Cons:

- Real language surface - new keyword, new type form, new wide-pointer
  ABI to specify.
- No monomorphization-driven inlining at the boundary. The cost is
  small but real (one indirect call per trait method, no specialization
  on the type).
- Doesn't trivially extend to free generic functions (those without
  trait bounds, e.g. `function box<T>(x: T): Box<T>`). For those you'd
  still need either Alternative B's manifest approach, or full type
  erasure (Alternative E).
- Doesn't help "the DLL has a type the host needs to dispatch over" -
  that scenario flips direction. (Discussed below in §Augmentation.)

When this is right: when most "wants to cross a binary boundary"
APIs are naturally trait-bounded (which they tend to be), and we're
OK with a slight perf hit at the boundary in exchange for not needing
a registration dance.

### Alternative D - "Hybrid: monomorphize when static, `dyn`-shim when not"

Language touch: same as C. Toolchain touch: more.

Combine Alternative A (whole-program monomorphization for internal
calls) with Alternative C (`dyn` shape for cross-binary calls). When
the compiler emits a generic function it produces *two* versions:

1. The monomorphic specializations needed by callers in the same
   compilation unit (existing behavior).
2. A single uniform-`dyn` version exported under a stable mangled
   name. This version takes `(data_ptr, vtable_ptr)` parameters in
   place of generic type params.

Each call site picks based on visibility: if the callee is in the
same compilation unit, route to the monomorphic version. If the
callee is in a different binary, route to the `dyn` version,
constructing the vtable on the fly from the call site's known type.

For trait methods on types from the other binary: the calling binary
reads the vtable for the (type, trait) pair from a symbol the other
binary exports. Each binary exports a `vtable__<Type>__<Trait>` symbol
for every (Type, Trait) pair it defines an impl for.

Pros:

- Best of both worlds. Internal calls stay maximally optimized; cross-
  binary calls take the small indirection cost.
- Doesn't require Alternative B's "ship the source bodies" - the dyn
  version is the only thing the consumer needs at link time.
- Doesn't require the user to manually choose `dyn` vs monomorphic -
  the toolchain picks.

Cons:

- Code size grows. Every generic function exists in N monomorphic
  forms plus one `dyn` form. For libraries with deep generic chains
  this is real.
- The two paths need careful testing - bugs that only show up via the
  `dyn` path are easy to miss in a same-compilation-unit test suite.
- The mangling discipline gets fiddly. Trait-method dispatch via the
  `dyn` ABI has to agree byte-for-byte across compilations done at
  different times.

When this is right: when we want Alternative C's flexibility without
forcing the language user to ever think about it. Probably the
"production" endpoint if we go down the `dyn`-at-binary-edges path.

### Alternative E - "Vtable registry: runtime augmentation"

Language touch: small (existing 9.G primitives). Toolchain touch:
small. Runtime touch: medium.

A process-wide table maps `(type_id, trait_id) -> vtable_ptr`. A
binary that defines an impl `type Foo implements Bar { ... }` emits
a constructor function that runs at `dlopen` (or program startup)
and calls `runtime_register_vtable(type_id_Foo, trait_id_Bar,
&vtable_Foo_Bar)`. A binary that needs to dispatch over a value of
unknown-at-compile-time type calls `runtime_lookup_vtable(type_id,
trait_id)` and dispatches through the result.

Type IDs are stable hashes of the fully-qualified type name plus a
structural fingerprint (field types). Trait IDs likewise. Both are
known at compile time everywhere they're used; the registry is just
a runtime indirection over their lookup.

This is the direct answer to "augment vtables based on what a DLL
requires types that were not monomorphized pre-emptively":

- A DLL loads. Its constructors register vtables for every (Type,
  Trait) pair it defines locally. The host's vtable table grows.
- Code in the DLL (or in the host, after the DLL loads) that
  dispatches over a value of one of the DLL's types now finds the
  vtable in the table.

Pros:

- True plugin model. Hot-loadable, hot-unloadable. The host doesn't
  need to know what types a plugin will introduce.
- Cleanly handles both directions: DLL adding types for the host to
  use, host adding types for the DLL to dispatch over.
- Re-uses 9.G machinery. The vtable values are real.
- Each binary stays small - no whole-program monomorphization, no
  shadow `dyn` copies.

Cons:

- Every trait call that goes through the registry pays a hash-table
  lookup. Caching can amortize but not eliminate.
- Runtime registration order matters - if a host binary tries to use
  a DLL type before the DLL's constructors run, we get a stale-lookup
  error. This is a familiar shared-library problem with familiar
  solutions, but it's a real new failure mode.
- Type IDs need to be stable across separate compilations, which
  means the structural-fingerprint hash has to agree byte-for-byte
  between compiler invocations of possibly different versions.
- The registry is process-global, which means subtle issues around
  multiple yoop binaries linked into the same process (rare today,
  but for plugin hosts not unimaginable).

When this is right: when the use case is "load arbitrary user
plugins at runtime" - the case where Alternative D's "compile time
knows about both sides" assumption breaks. This is what Lua, Python
extension modules, and Rust's `inventory` crate are for.

## A note on "augmentation" specifically

The user's framing - "augment vtables based on what a DLL might
require for types that were not monomorphized pre-emptively" - is
really asking about two different scenarios that look the same:

**Scenario 1: DLL has a type the host wants to use polymorphically.**
Host code wants to call `Display.show(some_dll_value)` where `some_dll_value`
has a type defined inside the DLL. The host's compiler never saw the
type. Alternatives C, D, and E all solve this.

**Scenario 2: DLL has a generic function, host has a type the DLL never
saw.** Host code wants to call `dll_lib.process(my_widget)` where
`process<T>` is generic and the host's `Widget` is new to the DLL.
Alternative A says "you can't." Alternative B ships the body and
monomorphizes host-side. Alternative C makes `process` take a `dyn
Display` and the host packages up a vtable. Alternative D auto-picks
the dyn form because the call is cross-binary. Alternative E is
orthogonal - it answers "where do the vtables come from" rather than
"how does the call get made."

The two scenarios likely want the same mechanism even though they
sound different. Picking that mechanism is the design decision.

## My read

For the language we have today, where Phase 9.G has already invested
in first-class vtables and `=>` function value types, **Alternative D
(hybrid mono + dyn)** is the cleanest payoff. It builds entirely on
existing machinery, doesn't force a runtime registry, and pays its
cost only at the binary edge. Alternative C is Alternative D minus
the automatic toolchain switching - if "ship two versions of every
generic" feels too heavy, C is the manual escape hatch.

**Alternative E** is the right answer if the goal is genuine
runtime-loaded plugins. It's a different shape of problem (plugins
that didn't exist at compile time) and a runtime registry is the
honest tool. We could ship D first and add E later, both built on the
same 9.G vtable values.

**Alternative B** is interesting but probably a research project. If
we want "as fast as static linking even across binaries" we'd build
it; if we don't, D covers the field.

**Alternative A** is what we have by accident today. Worth saying
out loud so we can pick something better.

## Open questions

- How does this interact with Phase 11's comptime IR? The bytecode IR
  the comptime evaluator is building is *exactly* the right format to
  ship inside a `.yoopneeds` manifest for Alternative B. If Phase 11
  lands first and the IR is solid, B gets a lot cheaper to build.
- Trait `extends` chains (Phase 9.J) make vtable layout
  multi-leveled. A `dyn Child` where `Child extends Parent` needs to
  carry both methods. Either the vtable embeds the parent vtable
  (simpler, fixed offset) or carries a pointer to it (more flexible,
  one indirection). Worth nailing down before the ABI freezes.
- `propagates<K>` semantics (the kind-flow system) presume the
  compiler can see every call site to insert cleanup. A `dyn` value
  whose underlying type has `propagates<disposable>` needs a vtable
  entry for the cleanup function, and the kind checker needs to
  treat dyn values as carrying obligations the same way concrete
  values do. The vtable already has a `dispose` slot for `Disposable`
  impls; the kind machinery just needs to learn to follow it.
- Multi-bound type params (`<T implements (A, B)>`) need a per-trait
  vtable layout. Easy when each trait is independent; gets tricky if
  we ever add diamond inheritance. Worth banning that explicitly
  rather than discovering it later.
