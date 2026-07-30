# Phase 10.E.2 - context strings on `?` via `WithContext<T>` (landed)

> Phase 10.E closed the type-shape gap in `?` propagation but explicitly
> deferred SPEC 11's reserved `expr? "loading config"` form, on the
> grounds that "for enum errors the payload is whatever the user puts
> there, so attaching a string requires either a per-payload-type hook or
> a blessed context-attachable sub-trait." This phase picks the hook, and
> pairs it with a built-in fast path for the payload type that actually
> dominates in practice.
>
> The motivating consumer is the bootstrap parser, where every
> `parseX(ref ps)?` discards the one piece of information the caller has
> and the callee does not: what it was in the middle of parsing.

## Surface

```js
node.childA = parseTypeParamList(ref ps)? "type params";
node.childA = parseTypeParamList(ref ps)? `type params for ${node.name}`;
```

A double-quoted string or a backtick template, and nothing else. NOT a
general expression: `f()? -x` would be ambiguous with subtraction, and a
string literal can never continue an expression, so the restriction keeps
this a zero-lookahead decision in the postfix loop.

The context expression is emitted **inside the failure branch**. `?`
already lowers to `br i1 %failed, label %try_fail, label %try_ok` with
the propagating `ret` built in `try_fail`, so an interpolated template
(which allocates, calls `int_to_string`, and concatenates) costs exactly
nothing when the call succeeds. The pass fixture proves this with a
`noisy()` call interpolated into the context: its print appears only on
the failing call.

## Where the context lands

Two shapes, decided by the typechecker and stamped onto the TRY_OP node:

1. **Both `Err` payloads are `string`** - the compiler builds
   `"<context>: <err>"` itself via `std/core/strings.yoop`'s
   `string_concat_all`. No impl to write. This is every `Result` in
   `std/` (all of them are `Result<_, string>`), so the ergonomic case
   costs the user nothing. Contexts stack naturally as an error
   propagates outward through successive `?`s.
2. **Anything else** - the operand's `Err` payload type must implement
   `WithContext<RetErr>`, and the failure branch calls
   `WithContext.withContext(ref operandErr, context)` to produce the
   outer `Err` payload.

```js
export trait WithContext<T> {
    function withContext(ref self, context: string): T;
}
```

A no-payload `Err` plus a context is an error: there is nothing to attach
to.

### Why a trait and not a blessed field

A structured error has no single "the error string". `ParsingError` in
the bootstrap carries `sourceLoc`, `isParseError`, `rawMessage`, `src`,
and `err` - a compiler that picked one of those by name would be wrong
for the next error type, and silently wrong (writing a field nobody
reads) rather than loudly wrong. Routing through an impl means the type
decides: prefix a message, fill a dedicated field, or push onto a
breadcrumb list. The same-shape pass fixture leans on this - the impl
prefixes `msg` and leaves `line` untouched, which a blind string concat
could not do.

### Why `WithContext<T>` subsumes `Into<T>`

The trait's type parameter is the TARGET type (same convention as
`Into<T>`, and for the same reason: yoop trait methods always take
`ref self`, so the source type has to be `self`). That means one
`IoError implements WithContext<AppError>` impl performs the cross-shape
conversion AND attaches the context, and `resolveTryOp` skips the
`Into<T>` lookup entirely when a context is present. A `?` with no
context is unchanged and still goes through `Into<T>`.

## Implementation

### Parser

[src/jsyooparser/parser.js](../../src/jsyooparser/parser.js) - the
postfix `?` branch calls the new `parseTryContext()`, which consumes a
`strLiteral` (into a `STRING_LITERAL` node) or a `templateLiteral` (via
the existing `parseTemplateLiteralBody`) and returns null otherwise. The
node is built before the context is consumed, so `TRY_OP.sourceLoc` is
unchanged. New field: `TRY_OP.context`.

### Typechecker

In [src/jsyooptypecheck/checkExpr.js](../../src/jsyooptypecheck/checkExpr.js):

- `resolveTryOp` types the context up front (so a bad interpolation
  inside it gets its own diagnostic even when the rest of the `?` fails),
  then routes to the new `resolveTryContext` INSTEAD OF the `Into<T>`
  clause when a context is present.
- `resolveTryContext` stamps either `node.tryContextConcat = true`
  (string/string) or `node.tryContext = { mangledName, targetType }`
  (WithContext impl), or pushes the fix-it.
- `lookupIntoImpl` was generalized into `lookupTraitImplByArg(sourceType,
  traitName, methodName, targetType, ctx)` - both `?` conversion lookups
  now share the canonical-struct re-fetch and the
  `registry.traitArgsByInstance` type-arg match. `lookupIntoImpl` is a
  one-line wrapper.
- New `sourceTypeName(type)` renders a type the way a user WRITES it
  (`ParseError`, not `formatType`'s prose form `struct ParseError`) for
  the copy-pasteable tail of the fix-it.

### Codegen

Both fallible-enum failure emitters gained a context branch ahead of the
`tryConvert` branch:

- [codegen.js](../../src/jsyoopcodegen/codegen.js) `emitFailEnumRet`
  (multi-module) delegates to the new `emitTryContextPayload`, which
  emits the context expression and then either concatenates or calls the
  `WithContext` mangled symbol with `(ptr <errPayload>, ptr <context>)`.
- `emitFailEnumReturn` (single-module / legacy) supports the
  `WithContext` call but throws a clear error for the string concat -
  that path needs autoloaded `std/core/strings.yoop`, which only the
  multi-module driver provides. Same limitation interpolated template
  literals already have there.
- The `string[]`-building tail of `emitInterpolatedTemplateLiteral` was
  extracted into `emitStringConcatParts(partVals, fnLines)` and is now
  shared with the context concat, along with a small
  `requireAutoloadedStd(which, feature)` helper for the
  "multi-module driver required" throw.

### Comptime interpreter

[src/jsyoopinterp/lower.js](../../src/jsyoopinterp/lower.js) TRY_OP
lowering handles both shapes in the err branch: `tryContextConcat` reuses
`OP.TEMPLATE_FORMAT` with an `[expr, ": ", expr]` descriptor list, and
`tryContext` resolves `WithContext.withContext` through the existing
`ctx.traitMethodResolver` and emits a `CALL_DIRECT` with
`[ref self, context]`. Lowering happens after the err LABEL, so comptime
matches runtime on laziness.

### kindCheck

[kindCheck.js](../../src/jsyooptypecheck/kindCheck.js) `walkExpr`'s
TRY_OP case returns early after the operand, so it now also walks
`e.context` - anything the context interpolates is still a use of that
binding.

## Verification

- [examples/pass/qmark_context_string.yoop](../../examples/pass/qmark_context_string.yoop)
  - both literal forms over `Result<int32, string>`, stacked contexts
  through nested `?`s, and the laziness proof (an interpolated `noisy()`
  prints only on the failing call).
- [examples/pass/qmark_context_with_context.yoop](../../examples/pass/qmark_context_with_context.yoop)
  - `ParseError implements WithContext<ParseError>` (same-shape,
  preserving an untouched `line` field) and `IoError implements
  WithContext<AppError>` (cross-shape with no `Into<AppError>` in sight).
- [examples/fail/qmark_context_no_impl.yoop](../../examples/fail/qmark_context_no_impl.yoop)
  - struct payload, no impl, asserts the fix-it.
- Parser unit tests: null context on a bare `?`, both literal forms,
  `f()? - x` still parsing as subtraction, and context-binds-to-nearest-`?`
  for `f()? "a".b? "c"`.

## Deferred

- **The bootstrap parser does not parse this syntax yet.** Nothing in
  `bootstrap/src/` uses it, so nothing is broken today, but the moment
  bootstrap source adopts `? "context"` the bootstrap's own parser has to
  learn the postfix clause (one field on the TRY_OP arena node, one
  optional token check in its postfix loop) or self-hosting stalls on its
  own source. Adopt the syntax and the parser support in the same change.
- **Non-struct payloads still cannot carry a context beyond
  string/string.** `WithContext<T>` lookup goes through
  `implementsTraits`, which only `StructType` has - same limitation
  `Into<T>` has, and it lifts the same way if it ever needs to.
- **The string concat allocates and nothing frees it.** `string_concat_all`
  goes through the current allocator and the result is never disposed -
  the same property every interpolated template literal already has. It
  only happens on a failure path, and a failure path usually ends in a
  report-and-exit, so this is not new debt so much as the existing string
  story showing up in one more place. It gets fixed when strings do.
- **No `Display`-driven default.** A payload that implements `Display`
  but not `WithContext` could in principle get an auto-generated
  "context: <to_string>" - but that produces a `string`, not the payload
  type, so it would only work when the return `Err` is a string. Not
  worth the special case; the explicit impl is one method.
