# Phase 10.X - Cleansing pass ✓ landed

> Now that Phase 10.A (generic enums) has landed, the compiler is carrying a
> meaningful amount of redundant scaffolding: features that pre-dated more
> general successors, dual code paths covering the same intent, and example
> fixtures that test behavior already covered elsewhere. This document is the
> cleansing pass - what to retire, what's safe now, and what is still blocked
> on features that haven't landed.
>
> **Status**: the marquee migration (fallible-struct → `Result<T, E>`) is
> in. `std/` is uniformly on the enum convention; the five compiler
> modules that carried dual paths now have a single one; ~300 LOC of
> compiler code retired; 13 demo/negative fixtures retired; SPEC §11 and
> `library-design.md` describe one convention only. Class B types
> (disposable-bearing returns: `SocketResult`, `ListenResult`,
> `AcceptResult`, `ConnectResult`, `ParsedRequest`) stayed as ordinary
> Disposable structs with `error: string` fields the caller inspects -
> no `?` interop, which is what the existing callers already wanted.

## What "sprawling" means here

Concrete signals collected from a sweep of `src/`, `std/`, `examples/`,
`plans/completed/`, and `SPEC.md`:

- **Two coexisting fallible mechanisms.** Phase 2's "struct ending in
  `err: string`" convention and Phase 9.H's "enum with `Ok`/`Err` variants"
  convention both drive the same `?` operator. Five compiler modules carry
  dual branches; the standard library splits inconsistently between the two.
- **Hand-rolled stand-ins for generics.** Some fixtures predate
  Phase 7.1 / 10.A - `examples/pass/dynarray_push.yoop` is the obvious
  example, a hand-rolled `DynArray<T>` for a job that `std/core/vec.yoop`
  already does.
- **Per-form fixtures kept after a "combined" fixture appeared.** The
  `task_immediate` / `task_joined` / `task_pooled` triple is now strictly
  covered by `task_three_forms/main.yoop`.
- **Documentation drift.** SPEC §11 documents only the struct convention as
  *the* error story; the enum convention is in §11 too but appended as if
  it were an afterthought. The roadmap calls Phase 10 the "next" phase
  even though 10.A landed.

This isn't about removing capabilities. Every retirement below has an
already-shipped replacement that covers the same use case.

## The marquee item - retire fallible structs in favor of `Result<T, E>`

This is the single biggest sprawl reduction. Phase 10.A makes
`Result<T, E>` expressible, and Phase 9.H's `?` already works on
Ok/Err enums. Keeping both conventions forever doubles every relevant
code path in the compiler and forces every std/ author to pick one
ad hoc.

### What gets simpler

**Compiler.** Five modules collapse to one path:

- [src/jsyooptypecheck/fallible.js](../src/jsyooptypecheck/fallible.js) -
  delete `isFallible` and `strippedTypeOf` (lines 40-88). The enum-side
  recognizer at the top of the file stays. ~50 LOC out.
- [src/jsyooptypecheck/checkExpr.js](../src/jsyooptypecheck/checkExpr.js) -
  the `?` operator collapses to its enum branch only; mark-err-observed
  bookkeeping (lines 615-617, 1225-1230) is gone. The struct-targeted
  diagnostic at lines 1283-1295 collapses to the enum one. ~80 LOC out.
- [src/jsyooptypecheck/checkStatement.js](../src/jsyooptypecheck/checkStatement.js)
  - the "destructure must include `err`" check (line 634) and the
  "fallible call dropped" check (line 650) both go. Destructure of an
  ordinary struct stays; bare-statement calls of any function with an
  unhandled return become a separate (much smaller) concern. ~30 LOC out.
- [src/jsyooptypecheck/scope.js](../src/jsyooptypecheck/scope.js) -
  the scope-exit unobserved-`err` check (lines 52-59) goes. ~15 LOC out.
- [src/jsyoopcodegen/codegen.js](../src/jsyoopcodegen/codegen.js) - the
  struct-fallible `try_fail` codegen path (lines 506-533), the multi-field
  strip plumbing (lines 1110, 1127), and the dual instruction lowering
  (lines 3753, 3770) collapse to the enum path. ~120 LOC out.

Roughly **300 LOC of compiler code retires.** No new capabilities are
needed for the cut - every test currently covered by `?` over fallible
structs has an `?` over `Result<_, _>` equivalent.

**Standard library.** Twelve types convert mechanically:

| Old (struct) | New (enum) |
|---|---|
| `ReadOutcome { n, err }` in `std/core/traits.yoop` | `Result<c_ssize_t, string>` |
| `WriteOutcome { n, err }` in `std/core/traits.yoop` | `Result<c_ssize_t, string>` |
| `FlushOutcome { err }` in `std/core/traits.yoop` | `Result<void, string>` |
| `StringSlice { value, err }` in `std/core/strings.yoop` | `Result<string, string>` |
| `BytesParseInt { value, consumed, err }` in `std/core/bytes.yoop` | `Result<BytesParseIntOk, string>` where `BytesParseIntOk { value: int64, consumed: usize }` |
| `ConnectResult { …, err }` in `std/core/types.yoop` | `Result<ConnectInfo, string>` (named success struct) |
| `AddrBuild { addr, err }` in `std/net/socket_ffi.yoop` | `Result<SockAddrIn, string>` |
| `FdResult { fd, err }` in `std/net/socket_ffi.yoop` | `Result<c_int, string>` |
| `AcceptFdResult { fd, peer_host, peer_port, err }` in `std/net/socket_ffi.yoop` | `Result<AcceptInfo, string>` (named success struct) |
| `ConnectOutcome { err }` in `std/net/socket_ffi.yoop` | `Result<void, string>` |
| `ParsedMethod { method, err }` in `std/http/parser.yoop` | `Result<HttpMethod, string>` |
| `HandleOutcome { err }` + `ServeOutcome { served, err }` in `std/http/server.yoop` | `Result<void, string>` and `Result<int32, string>` |

Callers update from `r.err` checks / `?` over structs / destructuring
sugar to `switch` over the enum or `?` (works unchanged). The multi-field
strip cases (`BytesParseInt`, `AcceptFdResult`, `ConnectResult`) need a
named success struct, since yoop doesn't have anonymous tuples. That's
~20 LOC of new type decls in `std/`.

**Examples.** Eleven fallible-struct example fixtures + their `examples/fail/`
counterparts become moot. Either delete them or convert one or two as
"struct-form pattern, same as `Result<T, _>`" reference points (recommend
delete - the enum-form fixtures cover identical ground).

- `examples/pass/errors_basic.yoop` (replaceable with a `Result<int32, string>`
  example), `errors_destructure_no_qmark.yoop`, `errors_discard.yoop`,
  `errors_propagate.yoop`, `errors_propagate_failure.yoop`, `errno_fallible.yoop`
- `examples/fail/err_dropped.yoop`, `err_unobserved.yoop`,
  `err_destructure_missing_err.yoop`, `err_destructure_unknown_field.yoop`,
  `err_qmark_in_nonfallible.yoop` (enum-form `qmark_enum_in_non_fallible_fn.yoop`
  already covers this), `err_qmark_on_nonfallible.yoop`,
  `err_multi_strip_no_destructure.yoop`

**Tests.** [src/jsyooptypecheck/fallible.test.js](../src/jsyooptypecheck/fallible.test.js)
mostly goes - the `isFallible` / `strippedTypeOf` tests retire with the
functions. The `isFallibleEnum` / `strippedEnumOkType` / `enumErrPayloadType`
tests stay. ~12 of ~16 cases retire. In [src/e2e.test.js](../src/e2e.test.js)
the 5 `errors_*` + 1 `errno_fallible` cases retire, the 7 `err_*` fail-fixture
cases retire, the enum-side `fallible_enum_qmark` + `generic_enum_result` +
`qmark_enum_in_non_fallible_fn` cases stay and become the canonical coverage.

**Docs.** SPEC §11 collapses from "two conventions sharing one operator"
to "one convention". `plans/library-design.md` §80-96 + §236-267 + §414-474
+ §555-579 update to `Result<T, E>` everywhere. Both docs get shorter.

### Open questions before doing this

1. **Cross-shape `?` (Phase 10.E) - does it block this work?** No. Phase
   10.E lets you `?` an `IoError` into an `AppError`. Within a single
   shape (everything is `Result<T, string>` after migration) regular
   `?` works fine. Cross-shape lands later.

2. **Multi-field strip ergonomics.** The current `?` over a struct
   `{ a, b, err: string }` produces `{ a, b }` magically. `Result<{a,b}, _>`
   needs a named success struct. This is a real ergonomics loss for
   exactly two stdlib sites (`BytesParseInt`, `AcceptFdResult`). The
   trade is "one named struct" vs "permanent dual-path tax everywhere".
   Recommend pay the trade.

3. **Migration safety.** Doing it in one sweep is the right call -
   leaving half the std/ on the old shape and half on the new would be
   strictly worse than either pure state. The change is mechanical
   enough that the e2e suite is the right safety net.

### Scope estimate

- ~300 LOC compiler delete
- ~150 LOC std/ rewrite (~12 types + ~30 callers)
- ~150 LOC example deletes (~13 fixtures)
- ~50 LOC test reshape (`fallible.test.js`, `e2e.test.js`)
- ~80 LOC SPEC + library-design rewrite
- **Total: ~250 LOC net deletion**, but the surface change touches ~25 files.

## Small independent cleanups (do now)

These don't depend on the marquee item and have no prerequisites.

### Consolidate redundant task-form fixtures

[examples/pass/task_three_forms/main.yoop](../examples/pass/task_three_forms/main.yoop)
is a strict superset of `task_immediate`, `task_joined`, and `task_pooled`.
The single-form fixtures predate the combined one. Delete the three
single-form fixtures + their e2e entries (`src/e2e.test.js:851-867`),
keep `task_three_forms`.

### Retire stale "deferred" comments whose features shipped

A handful of `// not yet supported` / `// deferred` / `// TODO Phase X.Y`
markers reference features that have since landed. Cross-reference each
against `plans/completed/` and either delete the comment or update it
to point at the actual implementation. (Found candidates: the for-in
"trait-driven iteration deferred" comment at
[src/jsyooptypecheck/checkStatement.js:732](../src/jsyooptypecheck/checkStatement.js#L732)
correctly stays - Phase 10.B isn't in yet; the
[runtime/yoop_io.c:212](../runtime/yoop_io.c#L212) TODO is a runtime
limit, not a language gap; nothing else surfaced as stale.)

### Documentation hygiene

- `plans/roadmap.md` still calls Phase 10 the "next" phase though 10.A
  landed. Update the bottom-of-doc focus pointer.
- The phase 9.H plan doc + the phase 10.A plan doc both contain the
  exact same `Result<T, E>` enum example in their goal sections. Once
  the marquee migration above lands, the SPEC becomes the canonical
  reference and these can stay as-is (they're frozen history).

## Blocked by features that haven't landed

Listing these so we don't accidentally try to retire them too early.

### Cannot retire - needs a successor feature

- **Generic unions** (`union Foo<T> { ... }`) - rejected at
  [src/jsyooparser/parser.js:2604](../src/jsyooparser/parser.js#L2604).
  Phase 7.5 deferred. *Not retiring anything* - this is an open
  capability gap; the rejection is the right answer until someone
  implements it.
- **`contains<K>` on struct fields / function returns** - rejected at
  [typecheck.js:1870](../src/jsyooptypecheck/typecheck.js#L1870) and
  [:2171](../src/jsyooptypecheck/typecheck.js#L2171). Phase 6.5 backlog.
  Same status.
- **`extends` on traits**, **multi-trait bounds `<T implements (A, B)>`**,
  **`mustNotShare acrossThreads`** - Phase 10.G work, all still
  rejecting at the parser. Not retire-able.
- **`Iterable<T>` trait + user-type `for ... in`** - Phase 10.B. The
  array-only special case in
  [checkStatement.js](../src/jsyooptypecheck/checkStatement.js) stays
  the only path until 10.B lands.
- **vtable over generic traits** - Phase 9.G restriction, Phase 10.B
  hopes to lift. Until then, vtable code paths special-case non-generic
  traits.
- **Cross-shape `?`** - Phase 10.E. Doesn't block the fallible-struct
  removal (within-shape is enough); does need to land before std/ can
  freely mix error enums of different shapes.

### Looks built-in, but isn't really workaround-y

- **`Task<T>` hardcoding in three places**
  ([typecheck.js:238](../src/jsyooptypecheck/typecheck.js#L238),
  [instantiate.js:406](../src/jsyooptypecheck/instantiate.js#L406),
  [types.js:391](../src/jsyooptypecheck/types.js#L391)). `Task` is
  intrinsically built-in: its layout, its runtime handle, its lifecycle
  are all compiler/runtime concerns. Treating it as a normal generic
  struct would require exposing those internals. Recommend keep.
- **Builtin kinds in [builtinKinds.js](../src/jsyooptypecheck/builtinKinds.js)**.
  Same story - `joined`, `pooled`, `Task` are language-level concepts,
  not workarounds.

## Recommended sequence

1. **Now (this session)**: write this plan, do the
   task-form fixture consolidation, fix any stale "deferred" comments
   whose features have shipped, update `plans/roadmap.md` to point at
   10.A as landed.
2. **Next session**: the marquee fallible-struct → `Result<T, E>`
   migration. Single bounded effort. ~25 files touched, ~250 LOC net
   delete. Verification is the e2e suite.
3. **After that**: pick up Phase 10.B / 10.C / 10.E on the schedule in
   [plans/phase-10.md](phase-10.md).

The marquee item is the cleansing. Everything else here is small
hygiene around the edges.
