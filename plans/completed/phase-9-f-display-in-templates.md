# Phase 9.F — `Display` trait wired into template literals ✓ landed

> A typechecker-only patch: when `${expr}` in a template literal has a
> type that doesn't satisfy the existing primitive whitelist, look up
> `Display.to_string(ref expr)` on the type and rewrite the
> interpolation to call it. Codegen still sees only printf-style format
> args — the rewrite happens in the typecheck pass and stamps a
> synthetic CALL_EXPRESSION carrying the post-resolution metadata.

## What landed

### Typecheck rewrite

[checkExpr.js:resolveTemplateLiteral](../../src/jsyooptypecheck/checkExpr.js)
gained a Display fallback. The check now reads:

1. If `exprType` is one of the existing printables (string / bool /
   any numeric), continue.
2. Otherwise, if the (deref'd) type is a struct whose
   `implementsTraits` carries a `Display` trait, replace `part.expr`
   with a synthetic CALL_EXPRESSION shaped exactly like the
   post-typecheck form a hand-written `Display.to_string(ref expr)`
   would produce: `calleeMethodOf`, `calleeMethodName`,
   `calleeTrait`, and `calleeMangledName` (computed via
   `mangleTraitMethod`). The first arg is the original expr if its
   type is already `ref T`, otherwise wrapped in a synthetic
   `REF_EXPRESSION` whose `resolvedType` is `RefType(structType)`.
3. Otherwise, emit the standard "must be string/bool/int/float or
   implement Display" error.

The rewrite is the natural shape because the codegen's
`emitPrintfCall` path already handles CALL_EXPRESSION args inside
template parts — it dispatches through `emitExpr`, which finds the
trait-method-call branch via `calleeMethodOf` and emits the indirect
mangled-symbol call. Then `fmtSpec += printfSpec(stringType)` adds
the `%s` for the returned string. No codegen changes needed.

### `Display` on `SocketAddr`

[std/net/addr.yoop](../../std/net/addr.yoop) — `SocketAddr` now
`implements Display` with a `to_string` that returns the host. The
old free function `addr_to_string` is gone (no callers in the tree).
Once an int-to-string helper lands in `std/core`, the `to_string`
body becomes `string_concat(self.host, ":", int_to_string(self.port))`
and templates render the full `host:port` form without a single
caller-side change.

Notes on the other types the original plan listed:

- **HttpMethod** is an `enum`, and yoop enums can't yet implement
  traits (parser doesn't accept an `implements` clause on
  ENUM_DECL). The trait-on-enum feature is its own future change;
  the cleansing-pass plan noted it as a deferred item.
- **StatusCode** is a struct but its informative `to_string` would
  want the integer code formatted ("404 Not Found"), which again
  waits on int-to-string. Holding off until the helper exists rather
  than shipping a near-empty impl.

## Verification

- [examples/pass/display_templates.yoop](../../examples/pass/display_templates.yoop)
  — same-module `Point implements Display` and cross-module
  `SocketAddr` in one template, mixed with primitive interpolations.
  Confirms trait dispatch fires across module boundaries.
- [examples/fail/template_no_display.yoop](../../examples/fail/template_no_display.yoop)
  — a struct without `Display` still fails with a diagnostic that
  now mentions Display so the fix-it is one trait impl away.
- Full suite green: **553 tests**.

## Deferred

- **Display on enums.** Needs `implements` + method bodies on
  ENUM_DECL. The plan tracks this as a separate future feature; once
  it lands, `HttpMethod` (and `Result<T, E>` etc.) become natural
  Display impls.
- **Display on primitives via auto-impls.** Today `${42}` works via
  the primitive whitelist + printf format specs. There's no mechanism
  for "all numeric types implement Display by default" — they
  short-circuit before reaching the trait dispatch. Not a problem in
  practice; primitives already format correctly.
- **`Display` on `Result<T, E>` / `Option<T>` via blanket impls.**
  yoop has no `where`-clause / conditional impl story — this is
  unblocked only when Self-bounded traits exist alongside generic
  enum trait impls.
- **Bare-form Display.to_string at non-template call sites.** Already
  works through the normal trait-method dispatch (Phase 7.4). Not
  Phase 9.F's scope.

## Critical files touched

- [src/jsyooptypecheck/checkExpr.js](../../src/jsyooptypecheck/checkExpr.js)
  — `resolveTemplateLiteral` Display fallback +
  `synthesizeDisplayCall` helper.
- [std/net/addr.yoop](../../std/net/addr.yoop) — `SocketAddr`
  `implements Display`, replacing the old `addr_to_string` free
  function.
- [examples/pass/display_templates.yoop](../../examples/pass/display_templates.yoop),
  [examples/fail/template_no_display.yoop](../../examples/fail/template_no_display.yoop)
  — new fixtures.
- [src/e2e.test.js](../../src/e2e.test.js) — fixture entries.
