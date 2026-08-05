# The tour: a video script

Twelve short episodes that go from "this is just a function" to "I built a
test framework out of two declarations and the compiler never learned what a
test is."

Every `.yoop` file in this directory compiles and runs as-is. Each one ends
with `BREAK IT` sections: a change to make on camera, the exact error the
compiler prints, and the point to make while it is on screen. Those are the
beats. The working program is just the setup.

The through-line, if you want one sentence: **most languages give you types
and functions and then a pile of special-purpose keywords bolted on for
cleanup, testing, and safety. This one has a third thing instead, and the
keywords fall out of it.**

## Before you record

```sh
node ./src/yoopiler.js examples/tour/ep01_hello.yoop && ./examples/tour/ep01_hello
node ./src/yoopiler.js --test examples/tour
```

A few notes that will save you a take:

- Compile output is noisy. `2>&1 | grep -v "warning:\|generated"` hides the
  clang triple warning if you want a clean terminal.
- The binary lands next to the source with the extension stripped.
- `--keep-ir` prints the temp directory holding the LLVM IR, which you need
  for the episode 6 and 7 payoffs.
- Files are named `ep01_` and not `01_` because a leading digit in a filename
  currently breaks codegen. See "The bug I found making this" at the bottom.

---

## Act I: it looks like TypeScript, it acts like C

This act should feel almost boring to a web dev, and that is the goal. Earn
the trust, then spend it in Act III.

### Episode 1: the smallest program

**File:** `ep01_hello.yoop`

Cold open on an empty file. Type it live, it is six lines.

Beats:

1. `main` returns `int32`. That is the process exit code, C-style.
2. `printf` is the one thing always in scope.
3. Break it: `return "zero";` The signature and the body stop agreeing.
4. Break it: `return 3;`, recompile, `echo $?`. It prints 3. Nothing is
   wrapping `main`. That number IS the exit status.

The point to plant: no implicit conversions. Not int32 to int64, not int to
float, not anything to string. It annoys people for a day and then stops.

Plant the exit-code thing deliberately. Episode 11 pays it off when a test
runner's failure count becomes the exit code with no wrapper script.

### Episode 2: values, loops, and the first real surprise

**File:** `ep02_values_and_loops.yoop`

Beats:

1. `let` and `const`, annotations optional when the initializer is obvious.
2. Backtick template literals, same as JS.
3. `for x in xs` over an array. `for i in 0..xs.len` over a range.
4. Break it: hand-roll the counted loop like you would in C.

```text
operator "<" cannot be applied to int32 and usize
```

This is the episode's whole reason to exist. The no-implicit-conversion rule
from episode 1 just bit the single most common loop in programming, because
`xs.len` is `usize` and `let k = 0` gives you `int32`.

Then show the special case: `for (let j = 0; j < xs.len; j += 1)` works,
because an unannotated counter in a for-head takes its type from the loop
CONDITION rather than from the literal. It is the one place in the language
where context overrides a literal's default type, and it exists precisely
because otherwise the most ordinary loop you can write would fail on its own
condition.

Honest framing: that is a special case, and special cases are a smell. Say so.
The alternative was implicit widening everywhere, which is worse. Invite
disagreement.

Also flag the small wart in the output: `flag=1`, not `flag=true`.

### Episode 3: structs

**File:** `ep03_structs.yoop`

Beats:

1. No classes. `type` is data, functions are separate and free.
2. Copy by default. `ref` for a reference, and `ref` is written at the CALL
   SITE too, so you never wonder whether a callee can mutate your value.
3. Break it: drop an annotation off a struct literal.

```text
struct literal has no target type
cannot infer a type for "p"; add an explicit type annotation
```

The talking point: inference here flows one way, initializer to binding. A
struct literal is the one case where the initializer has no type of its own,
so the arrow would have to reverse. Rather than guess (structurally? by field
name match? first declared type that fits?) it asks. Compare with
`const moved = shifted(p, 10);` right above, which infers fine because a call
has a return type.

### Episode 4: traits

**File:** `ep04_traits.yoop`

This is the first "wait, why" episode. Lean into it.

Beats:

1. A trait is a capability. `implements` opts in. `(A, B)` for more than one.
2. You call `Greeter.greet(ref t)`. Not `t.greet()`. Ever.
3. Sit on the objection for a second: yes, that is more typing.
4. Then scroll down to the free function ALSO named `greet` in the same file.
   Both callable, same scope, zero ambiguity, no shadowing rule to memorize.
5. Break it: `t.greet()`

```text
method-call form '.greet()' is not supported - use the free-function form 'greet(ref value)'
```

6. Break it: `greet(ref t)` with the free function deleted first, to get the
   clean fix-it that names the trait for you.

7. `Display` is the trait behind `${...}` interpolation. Delete the impl and
   watch interpolation stop working. It is a trait lookup, not a hardcoded
   list of printable types. Plant this: episode 11 leans on the same idea.

8. Bonus take: `@derive(display)` generates `to_string` from the field list at
   compile time, by emitting source text and reparsing it.

Be upfront about the gap: two traits declaring the same method name,
implemented by one type with two DIFFERENT bodies, is not expressible. There
is no `function Greeter.greet(ref self)` form. One body satisfies both. A
viewer will find that and you want to have said it first.

### Episode 5: variants and exhaustive switch

**File:** `ep05_variants.yoop`

Beats:

1. `variant` is a tagged union. Cases carry payloads.
2. `switch` destructures and must be exhaustive.
3. Break it: delete an arm.

```text
switch over variant Shape is not exhaustive - missing variants: Dot
```

4. The refactor demo, which is the real sell: ADD a case to `Shape` on camera
   and let the compiler walk you to every switch that now needs an arm.

5. `@derive(display)` on a variant generates an arm per case, and the output
   mirrors constructor syntax, so a dump reads back as source that would
   rebuild the value.

6. Optional honest beat: move the payload struct to the bottom of the file and
   get `type "Center" has no field "x"`, which is actively misleading. It is a
   known papercut, written up in `plans/sqlite-binding-papercuts.md`.

### Episode 6: generics

**File:** `ep06_generics.yoop`

Beats:

1. `<T>`, bounds via `<T implements Display>`. Monomorphized, no boxing.
2. Break it: pass a type with no `Display` impl.

```text
call to "describe": type argument "T" = struct Plain does not satisfy bound -
type "Plain" does not implement trait "Display"
```

Read it out loud: it names the function, the parameter, what it got bound to,
and the missing trait. Then fix it live with one `@derive(display)` line.

3. Break it: pass a bare literal, `identity(42)`.

```text
cannot infer type argument "T" for generic function "identity"
```

This one is worth real airtime. `42` is an untyped literal that gets pinned by
context, and deliberately that pinning does not happen against a type
parameter, because then the defaulting rule would be silently choosing your
generic instantiation. Arguable call. Say it is arguable.

4. Break it: try a turbofish. There isn't one. `<` in expression position is
   still less-than. The tradeoff is a shallow parser lookahead in exchange for
   losing manual disambiguation.

5. Payoff: compile with `--keep-ir` and grep the LLVM for two separate
   `define`s of `unwrap`, one per concrete type.

### Episode 7: errors

**File:** `ep07_errors.yoop`

Beats:

1. No exceptions. `Result<T, E>` is an ordinary generic variant in
   `std/core/types.yoop`, not a built-in.
2. `?` propagates. It is only legal in a function that itself returns a
   fallible shape.
3. Break it: put a `?` in `main`.

```text
'?' is only legal inside a function that returns a fallible enum (Ok/Err);
'main' returns int32
```

The point: `?` can never silently swallow. To stop propagating you have to
`switch` and say what happens, so the place the buck stops is visible.

4. `? "context"` prefixes the error as it travels, and contexts stack:
   `loading config: reading width: negative input`.

5. The bit to slow down for: **the context expression is lazy.** Look at the
   output. `template happy` has no `(building context for tag 9)` line above
   it. `template sad` does. Same expression, same call site. The context is
   emitted inside the failure branch, so an interpolated template costs
   nothing on the happy path. Confirm it with `--keep-ir` if you want.

6. Comment out the `Result` import to prove it is userland. Then define a
   local `variant Maybe<T, E> { Ok {...}, Err {...} }` and watch `?` work on
   it, because `?` matches structurally.

---

## Act II: the pivot

### Episode 8: kinds

**File:** `ep08_kinds.yoop`

**This is the episode the series exists for.** Everything before now exists
somewhere else. Slow down.

Open with the three-layer model:

- **type** is what the value IS
- **trait** is what the value CAN DO
- **kind** is how the BINDING is USED

The key move is that a kind attaches to the binding, not the type. Same type,
two bindings, different obligations.

Then show the entire declaration of `disposable` from `std/core/kinds.yoop`.
It is nine lines and there is no magic in it. You could have written it.

Beats, in output order:

1. `plainLet` uses a plain `let`. No cleanup, and NO ERROR. Leaks silently.
2. `withKind` changes exactly one word. `close 2` appears in the output.
3. `manualDispose` calls dispose by hand. It fires once, not twice. The
   compiler tracks that the obligation was discharged on that path.
4. `withBlock` uses a trailing block. Cleanup at the brace, not function end.
5. `earlyReturn` bails early and `close 5` still prints. The compiler placed
   the call on the return path too.

Point 5 is the payoff. You are not remembering to clean up on every branch,
you are declaring that a binding owns something.

Break it: delete `implements Disposable` and watch `requires Disposable` in
the kind declaration turn into a real error.

Then be straight about the advisory part. `plainLet` leaks and the compiler
says nothing. That is a deliberate reversal: an earlier version made unhandled
resources a hard error and it was miserable to use. Silent by default, opt in
with the keyword. The writeup is in
`plans/ownership-and-typestate-redesign.md`.

Last beat, and it matters for episode 11: `disposable` is imported, not
reserved. `let disposable: int32 = 5;` compiles. So does `let test = 6;` and
`let suite = 7;` None of these are keywords.

### Episode 9: region kinds

**File:** `ep09_regions.yoop`

Beats:

1. Some guards have no value worth naming. An allocator scope, a transaction,
   an indent level. `appliesTo region` is for those.
2. Write your own: `Indent` prints on the way in and on the way out. Show the
   nested output indenting correctly.
3. Implicit form with no block: teardown fires at enclosing scope end, LIFO.
4. The real payoff: an arena. Everything allocated inside the region is
   reclaimed in one move at the brace. No per-object free.
5. Break it, both directions:

```text
kind 'ephemeral' applies to a region and cannot be bound to a name; drop the
name and use the anonymous form: 'ephemeral EXPR { ... }' (or 'ephemeral EXPR;')

kind 'disposable' does not apply to a region (declared appliesTo: binding); the
anonymous 'disposable EXPR { ... }' form requires a region kind. To use it as a
named resource, give it a name: 'disposable name = EXPR ...'
```

Read both on camera. Each names the kind, states what it declared, and hands
you the other spelling.

The design point: no `defer` statement, no `using` statement, no `with`
statement. One mechanism, and these are two spellings that fall out of one
clause in a declaration.

---

## Act III: the emergent stuff

### Episode 10: typestate

**File:** `ep10_typestate.yoop`

Episode 8's kinds injected calls. These generate nothing at all. A marker kind
is a purely static tag: no runtime cost, nothing in the binary. It exists only
to make certain programs fail to compile.

Beats:

1. Two polarities. `restrictive` is a hazard that plain slots FORBID.
   `conferred` is a capability that slots naming it REQUIRE.
2. The demo is taint tracking. `tainted` on request input, `cleared` on what
   the SQL sink demands.
3. Break it: skip the sanitizer, `execute(dirty)`. You get BOTH errors,
   because they are genuinely two problems: missing something it needs, and
   carrying something it must not.

4. **The moment to build the episode around.** Play the attacker. Write a
   function with exactly the right shape to launder, that does something else:

```js
function fakeClear(t: tainted Query): Query {
    printf(`exfiltrating: ${t.sql}\n`);
    return { sql: t.sql };
}
```

In a system where the signature authorizes the transition, that compiles and
the whole scheme is theater. Here:

```text
function 'fakeClear' would strip kind 'tainted', but only an impl method of
trait 'Cleansable' (kind 'tainted's 'clearedBy cleanse') may do so; a free
function is not authorized
```

Read the last clause slowly. **A free function is not authorized.** Matching
the shape proves nothing. The only way to strip the hazard is to be a method,
on a type implementing the trait the kind names, with the method name the kind
names. Laundering is something you opt into by writing an impl, which is a
visible, greppable, reviewable act.

That is the difference between "the types line up" and "someone authorized
this," and most taint systems bolted onto a language cannot express the
second.

5. Then the reframe that makes it general: search the file for a built-in
   notion of taint or security. There is none. `tainted`, `cleared`,
   `Cleansable` and `cleanse` are all names you chose. The compiler knows five
   clauses. Rename everything to `draft` / `published`, or `unvalidated` /
   `validated`, on camera. It keeps working.

Known gap to state plainly: field-position sources are not wired up. A
`tainted` struct FIELD read through `x.field` loses its marker. Parameters,
returns and bindings are enforced. Fields are the follow-up.

### Episode 11: inventing a test framework

**File:** `ep11_invent_testing.yoop`

**This is the finale of the arc.** It is also the true story, so tell it that
way.

The setup: you wanted `describe` / `it` blocks. Not "call a function that
takes a closure," but actual blocks where the result reports itself at the
closing brace, nesting works, and the failure count falls out as the exit
code. You did not add a keyword or touch the compiler. Two kinds and about
sixty lines.

Structure the reveal so the payoff lands:

1. Show the FINAL `main` first, before any of the machinery. It looks like a
   test file in any language the viewer has used. Let that sit.
2. Then scroll up and show there are exactly two new declarations.
3. `it` is episode 8's shape: a binding kind, `ownsBlock`, `mustCall report
   beforeScopeEnd`.
4. `describing` is episode 9's shape: a region kind, same `mustCall` clause.
5. That is it. Everything else is ordinary structs and functions.

Run it:

```text
describe add
  ok - adds two positives
  ok - adds a negative
  describe edge cases
    ok - zero is the identity
    NOT OK - deliberately broken
          add(1, 1) gave 2, wanted 3
  end edge cases
end add

3 passed, 1 failed
```

`echo $?` prints 1. Episode 1 pays off.

Things to point at:

- **There is no runner.** Nothing collects checks into a list and walks them.
  Each block reports itself, in place, at its own closing brace.
- Delete the `it` keyword from one case. It still compiles, and that check
  silently vanishes from the output. One word is the difference between a test
  that reports and a test that does not exist.
- `it` is not a keyword. `let it: int32 = 5;` compiles fine.
- Mention why a check is a bool plus a sentence rather than
  `equals(got, want)`: two operands flatten the context that made the check
  meaningful. A sentence does not, and template literals interpolate anything
  implementing `Display`, which is episode 4 coming back around.

**Then show the wall,** because the episode is better with it. You wanted
per-case isolation composed from the kinds you already had:

```js
kind isolatedTest = it & describing;
```

```text
composition has no common application site in kind 'isolatedTest'
composition contradiction in kind 'isolatedTest': mustCall report vs mustCall dispose
```

Both complaints are legitimate. One kind applies to a binding and the other to
a region, and a composed kind cannot carry two different `beforeScopeEnd`
obligations under the current model. Which is why suites, not cases, are the
unit of isolation in the real harness. Multi-`mustCall` kinds are an open
design question, not a shipped feature.

Ending on the limitation is the right call. It is more convincing than the
demo.

### Episode 12: the real harness

**Files:** `ep12_geometry.yoop`, `ep12_geometry.test.yoop`

Episode 11 ran from `main`. That does not scale to a project, because you
would hand-call every suite from one place and edit that list forever.
`std/test.yoop` closes the gap with ONE clause.

```sh
node ./src/yoopiler.js --test examples/tour
```

Beats:

1. There is no `main` in the test file. `import.test;` is the flag that says
   so on purpose. Without it, a module with no `main` is a compile error, so a
   mis-named test file fails loudly instead of being skipped silently.
2. `suite` is an `appliesTo function` kind, a third application site. Its
   `enumerable as "suites"` clause is the entire compiler contribution to
   testing: notice the flag, gather the kinded functions, generate a `main`
   that calls `runAll`.
3. The generated `main` is yoop source, reparsed by the ordinary parser. There
   is no second codegen path.
4. Isolation is episode 9's mechanism: `runAll` wraps each suite in
   `ephemeral arenaScope(...)`.
5. Filters are positionals, read from argv by fifteen lines of ordinary yoop:
   `--test examples/tour clamps`.
6. Break one test on purpose and show that `detail` only prints on failure.
7. Break it: give a suite a parameter.

```text
function "clampsDownToTheGrid" carries kind 'suite' and must match `() => void`
(declared by kind 'suite'), but takes 1 parameter(s) instead of 0
```

Without the `signature` clause that would blow up inside generated code,
pointing at source the user never wrote. One clause, much better diagnostic.

8. Break it: `import { asserts } from "std/test.yoop"` and get the namespace
   fix-it. Note that `suite`, `test` and `Case` on the next line are imported
   by name and that is fine, because types, traits and kinds are exempt. Only
   values need the namespace, or a name like `asserts` would shadow user code
   in every module that touched the library.

Close the series by opening `std/test.yoop` and scrolling it. About 150 lines
including comments. Ordering, isolation, filtering, reporting and the exit
code are all plain yoop that anyone could fork.

---

## Two things to be honest about on camera

**This is a first real language, not a research project.** The voice that will
land is "here is a thing I built and here is where it breaks," not "here is
the correct way to design a language." Every episode above has a break-it or a
known-gap beat for that reason. Use them.

**The bug I found making this.** Every file here is named `ep01_` instead of
`01_` because a `.yoop` filename starting with a digit currently produces an
invalid LLVM symbol:

```text
define %struct.03_structs_53e6716b__Point @03_structs_53e6716b__shifted(...)
error: function expected to be numbered '%0'
```

Module ids are derived from the filename and get mangled into symbol names,
and LLVM will not accept an unquoted identifier that starts with a digit. It
only shows up when a module declares a struct or a non-`main` function, which
is why `ep01` and `ep02` would have been fine.

That is a genuinely good five-minute bonus episode if you want one: reproduce
it, read the IR, find `moduleId.js`, and fix it live.
