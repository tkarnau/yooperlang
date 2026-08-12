# Design doc: Ownership and Typestate (kind-system redesign)

Status: DESIGN ONLY. No implementation done. Revised 2026-06-17 to REJECT the
affine/Rust-style route and instead make ownership advisory and opt-in (a
Jai/Odin-flavored model). The earlier draft chose affine ownership; that choice
has been reversed and affine is now recorded as a considered-and-rejected
alternative.

Style note: ASCII only, no em-dashes, no fancy tables, per repo convention.

---

## Context

The "kind" system is one of the few things that differentiate Yooperlang from
other languages. But the first serious consumer of it - the self-hosting
bootstrap (e.g. `bootstrap/src/source_graph/module_graph.yoop`) - made it feel
cumbersome and not clearly useful. A function that loads a module and owns both
a file read and a heap `Vec<uint8>` could not cleanly hand those obligations up
the chain, and consuming the result via `switch` would silently leak (and the
compiler would error on intermediate bindings).

This doc writes up what we built, diagnoses why it strains, lays out the
alternatives, and records the chosen direction.

Decisions that shape the rest of the doc:

1. Ownership does NOT go the Rust/affine route. The compiler is silent about
   resource lifetimes by default. All ownership help is opt-in and advisory:
   a keyword opts a binding into auto-cleanup; a producer may optionally inform
   callers that a return carries an undisposed resource; the kind system is
   guidance for crossing scope boundaries, not an enforcement gate. There are no
   hard errors on the ownership side. This is close to Jai/Odin (defer +
   allocators, no tracking) with an ergonomic auto-cleanup keyword added.
2. Avoiding double-free is the responsibility of whoever implements `dispose`
   (make it idempotent - e.g. null the pointer and guard on null), NOT the
   compiler. The compiler will not prevent a double dispose.
3. The typestate/marker algebra is elevated to be THE differentiating feature,
   kept as its own clean, separate system. With ownership made deliberately
   boring and unenforced, typestate becomes the language's one place that makes
   real static guarantees - which is exactly where we want the ambition to go.

---

## Part 1: What we actually built

What is called "the kind system" is really three loosely-coupled subsystems
that happen to share one `KindType` object (`src/jsyooptypecheck/types.js:329`)
and one parser surface.

1. Resource ownership / obligations - `src/jsyooptypecheck/kindCheck.js`
   (~850 lines). Flow-sensitive. Tracks per-binding obligations and stamps
   synthetic cleanup nodes (`CLEANUP_CALL`, `TASK_RELEASE`, `TASK_AUTO_WAIT`)
   onto `block.implicitCleanups` / `return.pendingCleanups`. Built-in kinds
   `disposable`, `pooled`, `joined`, `Task` live here. This is the painful 95%.

2. Marker / clearance typestate - `src/jsyooptypecheck/kindFlow.js`.
   Deliberately flow-INsensitive (a value's marker set is fixed by its type
   annotation and validated like assignability). `tainted`/`cleared`,
   `conferred`/`restrictive`, `clearedBy`/`appliedBy`, plus `mustNotEscape`,
   `mustNotShare`, `forbids`. Emits diagnostics only, no codegen.

3. Layout - `aligned`/`packed`. Pure codegen via `effectiveAlign`
   (`codegen.js`), reading `kindType.layoutAlign`. No flow analysis at all.

### The obligation model (subsystem 1) as it works today

A type can declare `propagates<K>`. Any binding of that type carries K's
obligation, which must reach one of three exits or it is a compile ERROR:
(1) auto-cleanup, by writing the kind keyword on the binding
(`disposable x = ...`), which injects the cleanup at scope end;
(2) manual discharge, `Disposable.dispose(ref x)`;
(3) transfer up, `return x` from a function that itself declares
`propagates<K>` on its return type. The exact functions: `obligationsFor`,
`markIdentObligationsTransferred`, `markManualCleanupSatisfies`,
`projectCleanups` (all in kindCheck.js). The redesign keeps the auto-cleanup
mechanism but removes the error.

---

## Part 2: Why it strains (diagnosis)

### 2.1 The machinery-vs-usage mismatch

Repo-wide census of real `.yoop` code:

- `propagates<disposable>`: 116 uses. All other `propagates<...>`: 6.
- Types declaring `implements Disposable propagates<disposable>`: 53.
- `disposable` keyword on bindings: ~127.
- Marker/clearance kinds: present almost exclusively in `examples/`, not std.
- Layout kinds: a handful.

The general "kind algebra" is overwhelmingly exercised as a single feature:
own a heap resource, free it. The rest is mostly theoretical.

### 2.2 The model is safe-by-convention, not safe-by-construction

Structs are passed and assigned as flat by-value copies (no implicit clone, no
move invalidation). The obligation tracker keys everything on `bindingName` and
creates at most one obligation per resource. So:

```
let disposable a: Vec<uint8> = vecNew(8);
let disposable b: Vec<uint8> = a;   // two structs, ONE heap buffer
// both fire dispose at scope end -> double free, nothing catches it
```

The system is memory-safe today only because std follows a convention:
resources are passed by `ref`, never moved by value, one owning binding each.
The compiler trusts this; it does not enforce it.

### 2.3 "Transfer" is special-cased per syntactic site

Because there is no move concept, the tracker hand-codes the few places a
resource may leave a binding (bare-IDENT return, IDENT fields inside the
returned literal). It does NOT recognize move-into-literal at a let/const site,
passing into a function/collection (`vecPush`), or consuming via `switch`
(SWITCH_STATEMENT is not walked at all - case bindings are untracked and the
body silently leaks). Each missing site is a separate hole.

### 2.4 The workarounds this forces (already in the tree)

- Build the entire result struct up front and mutate nested fields by `ref`,
  then `return pr;` as a bare IDENT (documented in `std/http/parser.yoop`).
- Wrapper structs that exist only to satisfy the tracker (`Headers`,
  `ReadFileResult` instead of `Result<...>`, `ClientSendResult`).
- Manual dispose sprinkled across error branches.

### 2.5 The "worst of both" realization (this is what drives the redesign)

Look at where the current system actually sits. Jai and Odin get
convention-level safety (no compile-time guarantee; correctness comes from
discipline + arenas + a runtime leak detector) for ZERO annotation ceremony.
Yoop today is ALSO only safe-by-convention (2.2) - but it charges the full
ceremony of an ownership-tracking system (`propagates<K>`, the `disposable`
keyword, per-site transfer rules, hard errors) to deliver that same
convention-level safety. We pay for a safety system and receive a convention.
That is precisely why it feels cumbersome and not useful.

So the honest fork is not "affine vs. patch." It is:

- Go UP to real, compile-enforced safety -> affine ownership (pay the ceremony,
  get genuine guarantees). This is heavy, and the guarantee it buys is not what
  differentiates this language.
- Go DOWN to honest no-tracking -> Jai/Odin's defer + allocators, plus a small
  opt-in convenience layer (drop the ceremony; accept runtime-detected,
  convention-level safety; let arenas make most cleanup vanish).

We go DOWN. Ownership should be light and unsurprising; the language's
static-checking ambition belongs in typestate, not in babysitting frees.

---

## Part 3: Alternatives considered

### Alternative A: Incremental gap-fill (keep the obligation model, patch holes)

Wire SWITCH into path-coverage, recognize move-into-literal at let-sites, add a
consuming param concept, allow propagating payloads in variants. Low risk, no
codegen change. But it keeps the hard errors and the ceremony, does not fix the
by-value double-free, and accretes more special cases. Treats symptoms.
REJECTED: does not reduce cumbersomeness; doubles down on enforcement we have
decided not to want.

### Alternative B: Affine ownership + auto-drop (Rust minus lifetimes)

Bindings own; consuming uses move; `ref` borrows; owned-at-scope-end auto-drops;
use-after-move is an error. Genuinely memory-safe, handles all gap sites
uniformly, deletes `propagates`/keyword. REJECTED for Yoop: expensive (partial
moves, generic-T:Drop on open generic bodies, drop-timing changes), a multi-week
analysis with Rust-grade subtlety, and - decisively - the guarantee it buys
(compile-time memory safety) is not this language's differentiator. It would
spend the whole analysis budget on making ownership safe instead of making
typestate great. (This was the previous draft's choice; reversed.)

### Alternative C: Staged (shared de-risk, then decide)

Do the steps both A and B need, gather data, then choose. Superseded: the
decision is made (go down, not up), so there is nothing to defer.

### Alternative D: Pure scope RAII, forbid transfer

Auto-drop at scope end, resources always borrowed never moved. REJECTED: cannot
express "produce an owned thing and hand it back," which the codebase does
constantly.

### Alternative E: Jai/Odin - defer + allocators, no tracking (BASIS OF CHOICE)

Neither Jai nor Odin tracks ownership at all: no borrow checker, no move
semantics, no destructors. Cleanup is two things working together:

- `defer free(x)` - scope-bound cleanup run LIFO at scope exit.
- A `context` carrying pluggable allocators, especially arena / temporary-storage
  allocators where you free whole REGIONS instead of individual objects, so most
  "allocations" never need a matching free at all.

Safety net is runtime, not compile-time (Odin's `mem.Tracking_Allocator` reports
leaks / double / bad frees at exit). Zero annotation ceremony; correctness from
discipline + arenas + the leak detector. Strong fit for request/frame-shaped
lifetimes (a compiler pass, an HTTP request - most of what std and the bootstrap
do); weaker for long-lived irregular lifetimes, where it is back to discipline.

The chosen direction (Part 4.1) is this, plus a thin opt-in convenience layer.

---

## Part 4: Chosen direction

### 4.1 Ownership: advisory + opt-in (Jai/Odin, plus an opt-in cleanup keyword)

The compiler does not enforce resource lifetimes. It offers opt-in help and
otherwise stays out of the way. Concretely:

- Default is SILENT. A plain `let buf = vecNew(8);` that is never disposed,
  returned, or marked produces no diagnostic. You are trusted (Jai/Odin
  baseline). No more unsatisfied-obligation errors.

- The `disposable` keyword is opt-in auto-cleanup. `disposable buf = ...` means
  "compiler, please call `dispose` at scope end, unless I already called it
  manually on this path." This is the one place the compiler emits cleanup code,
  and it is entirely the user's choice. (This reuses today's auto-cleanup
  machinery in kindCheck/codegen, just without the surrounding error.)

- An acknowledgment / explicitly-manual marker (name TBD, e.g. `unmanaged` or
  `given` or `manual`) is the opposite opt-in: "this binding holds a disposable
  that I am deliberately managing by hand or handing off; do not auto-clean, and
  this is intentional." With a silent default this is primarily intent
  documentation and a hook for tooling/IDE and for the optional producer
  advisory below; it distinguishes "I forgot" from "on purpose" for human
  readers without changing emitted code.

- A producer may OPTIONALLY inform callers that its return carries an undisposed
  resource (the existing `propagates<disposable>`-shaped annotation, now
  advisory rather than a contract). This is guidance for crossing scope
  boundaries: documentation and an IDE/tooling signal, not a build error. A
  caller is free to ignore it, auto-clean with the keyword, hand it off, or
  acknowledge it with the manual marker.

- There are NO hard errors anywhere on the ownership side (explicit decision).
  The keyword is the only behavior-changing enhancement; everything else is
  advisory/documentation.

- Double-free is the dispose implementer's responsibility. The convention is
  that `dispose` is idempotent (free, then null the handle; guard on null). This
  absorbs the auto-clean-plus-manual-dispose and aliasing cases that the
  compiler no longer guards. The std `Disposable` implementations should follow
  this, and it should be documented as the expectation for any `dispose`.

- Arenas / allocators are the real cleanup story for the common case (encouraged,
  see Part 5): a `context`-style allocator with a temporary/arena allocator lets
  request/frame-shaped code allocate freely and reset a whole region at once, so
  most code needs neither the keyword nor manual dispose.

- The runtime safety net (replacing static enforcement) is a tracking allocator
  that reports leaks / double frees at program exit, run in debug/test builds.
  This is the Odin lesson: give up the compile-time guarantee, but make mistakes
  cheap to FIND at runtime.

- `pooled` / `joined` / `Task` fold into the same opt-in-keyword pattern: a
  keyword opts a binding into an automatic action at scope end (release / wait)
  exactly as `disposable` opts into dispose; without the keyword, silent. Same
  shape, different auto-action.

What this gives up, stated plainly: any compile-time guarantee that a resource
is freed exactly once. That is the deal. In exchange the ownership surface
becomes near-zero-friction and familiar to any systems programmer, and the
double-free hazard is handled by idempotent dispose + a runtime detector rather
than a type system.

### 4.2 Typestate: the differentiator (unchanged, reinforced)

With ownership made deliberately unenforced, the marker/typestate system is now
the ONLY place the language makes real static guarantees - so it carries the
whole "what makes Yoop different" load, and deserves the investment.

- Keep and sharpen the marker model: `conferred` (a capability a slot must have,
  cannot be forged) and `restrictive` (a hazard a slot must not silently drop),
  with transition authority via `requires <Trait>` + `clearedBy` / `appliedBy`
  so only a named trait method may mediate a transition.
- Demote layout (`aligned`/`packed`) out of the "kind" umbrella to plain type
  attributes; it shares nothing with typestate or ownership.
- Close the documented v0 gaps that block real use: cross-module callees,
  namespaced/method calls, and field-position sources.
- Showcase markers (already listed in the design notes): `validated` on
  sanitized strings, `authenticated` on a Request past auth middleware,
  `bounded` on range-checked indices, `nul_terminated` on bytes handed to libc,
  `parsed_uri`, `tainted` on request bodies until a validation boundary.

The framing shift: stop calling all of this one "kind system." There are two
features. Ownership (opt-in, advisory, invisible, deliberately not a guarantee)
and Typestate (markers, flow-insensitive, explicit, THE differentiator and the
one place with real static teeth). Separate names, separate docs.

---

## Part 5: How it could land (design-level sketch, not a task list)

This direction is much cheaper than the affine rework - mostly relaxing existing
behavior rather than building a new analysis, and existing annotations can stay.

1. Remove the unsatisfied-obligation ERROR. The default for an unhandled
   disposable becomes silent (no diagnostic). `reportUnsatisfied` in kindCheck.js
   stops firing for the ownership kinds.
2. Keep the `disposable`-keyword auto-cleanup injection exactly as is - it is
   already the user-opt-in behavior we want. Ensure it still fires correctly for
   keyword bindings declared inside `switch` arms (the one place codegen
   correctness, not just a missing error, depends on walking SWITCH).
3. Make `propagates<disposable>` advisory: no enforcement, no transfer
   requirement on the enclosing function; it becomes a producer-side signal the
   tooling/IDE can surface. Returning a disposable no longer requires any
   annotation and never errors.
4. Add the acknowledgment / explicitly-manual binding marker (name TBD).
5. Document and audit `dispose` idempotency across std `Disposable` impls
   (free-then-null, guard on null) so double dispose is harmless.
6. `pooled`/`joined`/`Task`: keep their keyword-driven auto-actions; drop any
   hard-error paths so they match the advisory model.
7. Future / parallel, the real cleanup ergonomics: a `context`-style allocator
   system with an arena / temporary allocator, and a debug-build tracking
   allocator that reports leaks and double/bad frees at exit.
8. Separately: extract typestate into its own named feature, demote layout to
   attributes, close the marker v0 gaps, build the showcase markers.

Note: ~116 `propagates<disposable>` and ~127 `disposable`-keyword sites can stay
as-is; their meaning relaxes (the keyword still auto-cleans; `propagates` becomes
advisory). No mass rewrite is forced, unlike the affine route.

---

## Part 6: Open questions to resolve before implementation

- Producer advisory surfacing: Part 4.1 keeps the build silent by default, so the
  optional `propagates<disposable>` advisory is surfaced via IDE/tooling/hover,
  NOT as a build warning. Confirm that is the intent, or decide whether an
  unhandled advertised disposable should emit a soft (suppressible) warning at
  the call site after all. (The chosen Q1 answer was "silent by default," which
  this doc reads as "no build diagnostics; advisory lives in tooling.") 
    - Answer: This is the intent for now, I want to see how this feels after a few thousand more lines of working with the language to see if we want something clearer.
- Name for the acknowledgment / explicitly-manual marker: `unmanaged` / `given`
  / `manual` / `raw` / other.
    - Answer: let's not even add the new keyword for now.
- `dispose` idempotency: convention only, or does std provide a helper/pattern
  (e.g. a base that nulls the handle) to make it easy to get right?
    - Answer: Convention only for now.
- Drop timing for the keyword case: keep `ownsBlock`-style early scoping or rely
  purely on lexical scope end? (Still relevant since the keyword still injects.)
    - Answer: keep owns block which enables sub-blocks and such for clarity, otherwise acts as the LIFO style like normal.
- Allocator/context system: introduce now (it is the real ergonomic win) or
  after the relaxation lands? It is a sizeable feature on its own.
    - Answer: after relaxation
- Runtime tracking allocator: build alongside, since giving up static
  enforcement makes a runtime detector the primary safety net.
    - Answer: leave this out, I think, for now.

---

## Appendix: where each concern lives today

- Ownership / obligations: `src/jsyooptypecheck/kindCheck.js` (frame stack,
  merge logic, transfer/satisfy/cleanup, the `reportUnsatisfied` error to
  remove); built-ins in `src/jsyooptypecheck/builtinKinds.js`.
- Typestate / markers: `src/jsyooptypecheck/kindFlow.js`.
- Codegen cleanup surface (small, well isolated): `emitCleanupCall`,
  `emitImplicitCleanups`, `emitPendingCleanups` in `src/jsyoopcodegen/codegen.js`.
- KindType (shared struct all three hang off): `src/jsyooptypecheck/types.js`.
- Parser surface for kind decls, propagates clauses, kind prefixes, marker
  prefixes: `src/jsyooparser/parser.js`.
- Prior design notes: `plans/kinds-design.md`, `plans/clearance-kinds.md`,
  `plans/completed/phase-6-4-*.md`.
- Canonical disposable types and the workarounds the relaxation removes:
  `std/core/vec.yoop`, `std/fs.yoop`, `std/net/socket.yoop`, `std/http/parser.yoop`.
