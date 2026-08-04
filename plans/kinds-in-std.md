# Moving the concurrency kinds into std

> `task`, `async`, `joined` and `pooled` are declared as ordinary
> `kind { ... }` decls in std, their behavior derived from their clauses,
> with a compiler-side assertion that the required core exists.

## The problem

[builtinKinds.js](../src/jsyooptypecheck/builtinKinds.js) hardcodes three
kinds whose own comment admits they "carry synthetic clauses that aren't
expressible in source":

    JOINED_KIND = { appliesTo: binding, autoJoin: true }
    POOLED_KIND = { appliesTo: binding|parameter, refcounted: true }
    TASK_KIND   = { appliesTo: field|binding,     refcounted: true }

`refcounted: true` is the clearest symptom. It is a bare boolean; nothing
names WHAT gets called to retain or release. Codegen simply knows it means
`yoop_task_retain` / `yoop_task_release`. The kind declaration is a label
on behavior that lives somewhere else entirely.

`task` is worse: it is not a kind at all, but a lexer keyword handled
structurally in `parseFunctionDecl`. [SPEC.md section 6](../SPEC.md) writes
it as `kind task { appliesTo function; provides Task; }` and
[section 7](../SPEC.md) says dropping `function` is the general rule for
ANY function-position kind, with `task function fetch(...)` explicitly
equivalent and prefixes stacking (`pure task compute(...)`). None of that
is implemented.

## The target

Three properties, in priority order:

1. **The declarations are real source.** `std/core/kinds.yoop` holds them,
   readable and diffable like `disposable` already is.
2. **The behavior comes from the clauses.** `refcounted` becomes a general
   clause naming its two methods; any user kind can use it. `pooled` is
   simply the kind std happens to declare with it.
3. **The compiler asserts the core exists.** A required-core registry names
   each kind the compiler depends on plus the clause shape it needs, and
   errors if std does not provide it. That is the carve-out - a fixed
   requirement, not a fixed implementation.

What stays genuinely built in: `Task<T>` **satisfying** the traits those
kinds require. The impl bodies are compiler-provided and lower to
`yoop_task_retain` / `yoop_task_release` / `yoop_task_wait`. That is the
irreducible minimum - the runtime calls have to come from somewhere.

## Clause vocabulary

Two traits, so the kinds have something to require:

    trait Shared {
        function retain(ref self): void;
        function release(ref self): void;
    }

    trait Waitable<T> {
        function wait(ref self): T;
    }

One new clause, general-purpose:

    refcounted <retainMethod> <releaseMethod>;

It names two methods of the `requires` trait. The compiler inserts a
retain at every copy/parameter-pass and a release at scope exit, calling
those methods by name rather than by assumption.

`autoJoin beforeScopeEnd` disappears - it was always just
`mustCall wait beforeScopeEnd` with a different spelling.

## Storage is derived, not declared

The one thing I expected to stay compiler-owned turns out to fall out of
the clauses. The SPEC's own decls carry the distinction:

- `joined` declares `mustNotEscape scope` - the binding provably cannot
  outlive its frame, so a **stack alloca** is safe.
- `pooled` does not, and declares `refcounted` - it is meant to escape,
  which is the entire point of refcounting it, so it needs the **heap**.

So the rule is "mustNotEscape scope -> stack, refcounted -> heap", read
off the declaration. No name matching in codegen.

## The required core

    KIND       CLAUSES THE COMPILER DEPENDS ON
    task       appliesTo function; provides Task
    async      appliesTo function
    joined     appliesTo binding; requires Waitable; mustCall wait beforeScopeEnd; mustNotEscape scope
    pooled     appliesTo binding parameter field; requires Shared; refcounted

`std/core/kinds.yoop` is autoloaded into every module graph (the graph
already does this for `format.yoop`, `strings.yoop`, and `traits.yoop`),
so the core is always present without a user import. A missing or
wrong-shaped entry is a compiler error naming the file, which is what
makes this a checked contract rather than a convention.

## Keywords become identifiers

`task`, `async`, `joined`, and `pooled` stop being lexer keywords and
become ordinary identifiers resolved as kind names - exactly the
precedent `test` and `suite` set in `std/test.yoop`, where the whole point
was that testing gets no compiler-baked syntax. Users get those four words
back as identifiers.

`await` and `wait` stay keywords: they are expression operators, not
declaration prefixes.

## Status: LANDED

All four stages are in, and `builtinKinds.js` is deleted.

What shipped differently from the plan:

- **The keyword removal had to come FIRST, not last.** `kind pooled { ... }`
  could not even be written while `pooled` was a reserved word, so stage 4
  turned out to be stage 0.
- **`pausable` is the clause that makes a function a coroutine.** The plan
  had `async` as a bare `kind async { appliesTo function; }`, which is
  indistinguishable from any other function kind (`suite`, say). It needed
  a clause that actually says what it does.
- **`Waitable`/`wait` became `Joinable`/`join`.** `wait` is an expression
  operator and cannot also be an identifier, so `mustCall wait` would not
  parse. `joined` calling `join` reads better anyway.
- **`joined`'s `mustNotEscape scope` was stricter than the old hardcoded
  kind**, which only carried `autoJoin: true`. It flagged the ordinary
  `let v = wait d;` as aliasing the handle. `wait` yields the RESULT, not
  the handle, so the alias walker now stops there.
- **`kind Task` is gone, merged into `pooled`.** The two decls were
  byte-identical except for `appliesTo` - the same kind wearing a second
  name, and that name collided with the `Task<T>` TYPE. You could write
  `type Job propagates<Task> { work: Task<int32> }` with the two `Task`s
  meaning different things. `pooled` now covers `binding parameter field`
  and the spelling is `propagates<pooled>`.

  They were not quite interchangeable, which the merge surfaced: the
  task-handle binding forms (`pooled h = f()`) never carry a type
  annotation, while a binding of a propagating struct
  (`pooled j: Job = launch(6)`) does. That absence is now the
  discriminator for routing to the task-binding path.
- **Programs using the concurrency kinds need the module graph.** The
  legacy single-module path (`compileSource`) has no std, so a fixture
  using `pooled` either imports `std/core/kinds.yoop` or goes through
  `compileEntry`.

The compiler-side remainder is exactly the irreducible part: `Task<T>` is a
compiler type rather than a nominal struct, so it cannot carry an
`implements` list. `taskSatisfiesKind` in `coreKinds.js` records that it
satisfies `Shared` and `Joinable`, and the method bodies lower to the
runtime calls. Everything about the CONTRACT - which methods, called when,
on what - is declared in std.

## Build order

- **1 - clause vocabulary.** `refcounted` clause, `Shared` / `Waitable`
  traits, relax the `appliesTo function` clause rules (today `signature`
  and `enumerable as` are both required, which suits `suite` and nothing
  else), implement `provides`.
- **2 - Task<T> satisfies traits.** Compiler-provided `Shared` /
  `Waitable` impls whose methods lower to the runtime calls.
- **3 - required-core registry.** Autoload `std/core/kinds.yoop`, assert
  the table above, and route kindCheck/codegen through the resolved
  KindType instead of the hardcoded objects.
- **4 - function kinds.** `task` / `async` as kind prefixes, `function`
  optional, prefixes stack; drop the four keywords.

Each stage keeps the suite green on its own.

## Deliberately not in this pass

- **`Task<T>` becoming a nominal generic struct.** Trait satisfaction is
  enough for the kinds to require something real; a full nominal type
  would mean exposing the thunk/state/args-blob layout for no gain here.
- **`pure`.** SPEC section 7 uses it in the stacking examples; it is not a
  kind that exists yet and this pass does not add it.
