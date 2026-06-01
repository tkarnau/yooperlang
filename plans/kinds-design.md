# Kinds design heuristics

## The trigger

Every kind in this codebase encodes the same shape: "if you have a
value of this type, something has happened to it (or must happen to
it)."

The test for whether something wants to be a kind is: when you catch
yourself writing or thinking that sentence in a comment, a parameter
name, or a "you must call X first" docstring, that's a kind asking to
exist.

Existing kinds in the codebase:

- `disposable` (std/core/kinds.yoop) - "this owns heap state that must
  be cleaned up at scope end or transferred via a propagating return"
- `joined` / `pooled` (std/core/concurrency.yoop) - task obligations,
  who's responsible for `wait`ing on the result
- `Task` - async coordination shape

All three encode obligations that a function signature alone can't
express, because the obligation has to survive across a return,
through a struct field, or up a call chain.

## When to reach for a kind

Reach for one when at least two of these are true:

- The obligation must survive a function boundary (return, struct
  field, closure capture, task spawn)
- The proof and the use site are in different modules
- A reasonable caller could plausibly skip the obligation and the
  compiler would not notice
- The obligation has a discrete discharge point (a method to call, a
  scope to close, a transfer to perform), not just a vague "be careful"

When all three are true, write a kind. When two are true, it's
borderline - lean toward writing the kind for std-library code and
toward plain validation for one-off programs.

## When NOT to reach for a kind

- The proof and the use are in the same function. Plain code is
  clearer; you can see both ends.
- The obligation reduces to "be a well-formed T". That's what types
  are for, not what kinds are for. A kind layered on a type that
  already excludes the bad cases is noise.
- You have three slightly-different states of the same value and you
  reach for three kinds. That's a sign the value wants to be an enum
  (states) or a state machine (transitions), not a kind soup.
- The discharge isn't a single discrete event. If "use carefully" is
  the obligation, no kind can encode it; the right answer is a more
  restrictive type or a different API.

## In-tree opportunities (uncommitted, illustrative)

Places this codebase has a "must have been X'd" comment-shaped
guarantee that a kind would carry instead:

- `validated` (or `safe_path`) on strings returned by
  `safepath.sanitize` in the yoopstore playground. Today the function
  returns `Result<string, string>` and storage.write_file takes a bare
  `string` - nothing stops a caller from feeding the original
  unsanitized `req.path` in. A kind would refuse.
- `authenticated` on a `Request` after an auth-middleware Handler has
  cleared it. Downstream handlers would only accept the authenticated
  form.
- `parsed_uri` on bytes / strings that have been through URI parsing.
  Stops "we have a host string, did we parse it" defensive checks.
- `tainted` on `req.body` until it crosses a validation boundary.
  Makes "where did this user input go" tractable.
- `bounded` on counters / indices that have been range-checked against
  a cap.
- `nul_terminated` on `uint8[]` handed to libc, separate from generic
  byte buffers.
- `transaction_scoped` on a database / arena ref that must not escape
  the txn block (Phase 6.4's mustNotShare-style sentinel pairs well).

None of these are committed work - they're the calls I'd make if I
were doing a kind audit of the codebase today. Each one would need a
discharging trait (or scope rule), a usage example, and a
fail-fixture showing the compiler reject the unsatisfied case.

## How to add a new kind

1. Decide where it lives. Cross-cutting (used by std and apps) goes in
   `std/core/kinds.yoop`. App-specific kinds live in the app's own
   module - kinds are not privileged to std.
2. Declare the kind and, if it needs an active discharge, the trait
   that discharges it. (`disposable` pairs with `Disposable`;
   `joined`/`pooled` pair with task-shape traits.)
3. Document the discharge sites. A kind without a clear "this call
   satisfies it" is the kind soup anti-pattern.
4. Add a passing-fixture demonstrating the happy path and a
   failing-fixture showing the compiler reject the unsatisfied case.
   Both go under `examples/`.
5. If the kind changes a cross-cutting invariant (propagation,
   transfer, escape), update CLAUDE.md's "Cross-cutting invariants"
   section.

## Anti-patterns to watch for

- **Validator without a kind.** Any function named `validate_*`,
  `assert_*`, `check_*` that returns its input unchanged on success
  is shouting "I want to be a kind."
- **Naming the obligation in the parameter.** `safe_path: string`,
  `unchecked_buf: uint8[]`, `validated_id: int32` - the prefix is
  doing the kind's job, badly, with no compiler help.
- **"This MUST be called before X" comments.** Either the type
  enforces it or it doesn't; comments don't compile.
- **A runtime assertion that the caller "should" have done.** If you
  find yourself defensively re-checking an invariant on entry to a
  function, the contract belongs in the type, not the function body.

## Cost calculus

Adding a kind costs:

- A declaration
- A discharging trait or scope rule
- Updates to every function that produces or consumes the type, to
  thread the kind through
- A failing fixture to demonstrate enforcement
- Possible churn in CLAUDE.md if it touches cross-cutting invariants

The kind earns this back when it eliminates a class of "did I forget
to validate" bugs across multiple consumers. One-off programs
typically don't earn it back; std-library APIs typically do.
