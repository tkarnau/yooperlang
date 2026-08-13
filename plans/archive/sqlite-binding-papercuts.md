# Plan - std/db/sqlite and the papercuts it surfaced

## Context

[std/db/sqlite/ffi.yoop](../../std/db/sqlite/ffi.yoop) +
[std/db/sqlite/db.yoop](../../std/db/sqlite/db.yoop) bind libsqlite3, and
[examples/playground/sqlite_demo/main.yoop](../../examples/playground/sqlite_demo/main.yoop)
drives them from the application side (on-disk db, schema, batched prepared
insert inside a transaction, two read shapes, cleanup).

This was the first binding to a *third-party* C library that is opaque-handle
heavy and uses double-pointer out-params, so it was a real test of whether the
existing FFI surface is enough. The short answer is yes: no compiler change was
needed. What follows is what worked, and the one thing that bit.

## What already worked, unchanged

Worth recording because none of it was obvious going in:

- **`extern "C" from library "sqlite3"` links with no setup.** It lowers to
  `-lsqlite3` in [yoopiler.js](../../src/yoopiler.js), and libsqlite3 ships in the
  macOS SDK. Linux needs libsqlite3-dev installed.
- **`ref x: unsafe_ptr` is a working `void **`.** This is what makes
  `sqlite3_open` and `sqlite3_prepare_v2` bindable at all - both hand back their
  handle through a `sqlite3 **` out-param. Same shape std/fs.yoop already used
  for `yoop_io_normalize_real_path`'s `char **`.
- **`SQLITE_TRANSIENT` without an int-to-pointer cast.** The 5th argument to
  `sqlite3_bind_text` is a `void (*)(void *)` destructor whose one useful value
  is the `(void *)-1` sentinel meaning "copy the buffer". Yoop has no
  int-to-pointer cast, so the slot is declared `c_ssize_t` and passed `-1`:
  identical ABI (same register class on arm64, x86_64 SysV, Win64). Verified the
  copy really happens by binding a template-literal string built at runtime.
- **A one-field envelope struct keeps `unsafe_ptr` out of the safe module.**
  `type RawDb { p: unsafe_ptr }` in the ffi module means std/db/sqlite/db.yoop holds
  handles, passes them around, and never declares `import.unsafe;` - satisfying
  library-design.md 2.1 for a handle-based library, which std/net never had to
  because a socket is an `int` fd. This is the pattern for future bindings.
- **`float64` maps to C `double`** through an extern signature, both directions.
- **Multi-line string literals** work, which keeps embedded DDL readable.

## Issue 1 - a variant payload type must be declared before the variant - FIXED

FIXED while merging std/db into a directory module. Declaration order no longer
affects struct fields, variant payloads, or generic type arguments. Regression
fixture: examples/pass/decl_order_independence.yoop, which uses every type above
the line that declares it.

The root cause was one thing wearing three faces. Pass A registers a shell and
pass C fills it, but pass C REPLACED the table entry with a freshly built
`StructType` instead of filling the shell - so any field that had already
resolved to that struct kept pointing at the empty shell:

- a **variant payload** or **struct field** naming a later struct gave the
  misleading `type "T" has no field "f"` below;
- a plain **forward struct reference** was worse than misleading, it CRASHED the
  compiler (`TypeError: fieldType.fields is not iterable` out of
  `detectRecursiveField`, which walked a shell's null `fields`);
- and across the source files of a directory module, where basename order decides
  what "later" means, the same bug SILENTLY MISCOMPILED - a sqlite `RawStmt`
  handle came back as a shifted pointer and segfaulted inside libsqlite3, which
  is how it was finally caught.

Fixes: `StructShell` is unfrozen and `fillStructShell` fills it in place (the
same treatment variant shells got in 13.A and vtable shells in 9.G),
`detectRecursiveField` tolerates a shell, and pass C now resolves every generic
TYPE body before any concrete decl - because instantiating a generic SNAPSHOTS
its field list, which was the separate generic-flavored half
(`type "Bag__int32" has no field "item"`). See
[modules-as-directories.md](modules-as-directories.md).

The original report follows.

Confirmed, and the only real papercut found.

```yoop
variant StepOutcome {
    Row { row: Row },      // Row declared LATER in the file
    Done,
}

type Row { raw: RawStmt }
```

Constructing that case fails at the payload literal:

```
type "Row" has no field "raw"
    return StepOutcome.Row { row: { raw: s.raw } };
                                    ^
```

Moving `type Row` above the variant fixes it. So a struct used as a variant
payload resolves against a not-yet-populated shell when it is declared later in
the same module - the same "imported structs may be shells mid-pass" hazard
CLAUDE.md documents for the cross-module case, but here within one file, where
declaration order is not otherwise significant in Yoop.

Two things are wrong independently:

1. **The order dependence itself.** Pass A registers the struct shell and pass C
   fills its fields; the variant's payload field types are apparently resolved
   against whatever the shell holds at the time. Nothing else in the language
   asks the author to topologically sort their declarations.
2. **The diagnostic actively misleads.** It names a field that IS declared on
   that type and points at the use site, so the natural read is "I typo'd the
   field name" or "some other `Row` is shadowing mine". The fix (move a decl 60
   lines up) is nowhere near what the message suggests. Even leaving the
   ordering rule in place, this should say something like `type "Row" is not
   fully resolved yet - declare it before "StepOutcome"`.

Fix candidates, in increasing order of ambition: (a) improve the message,
(b) defer variant-payload field resolution to a later point in pass C so order
stops mattering, (c) audit which other decl positions resolve against shells.

## Non-issue, recorded so it is not re-investigated

**A variant case name may share a name with a same-module type.** The first
hypothesis for Issue 1 was that the case `StepOutcome.Row` shadowed the type
`Row` and pinned payload literals to the case-struct. That is NOT what happens:
with the type declared first, `variant Step { Row { row: Row } }` compiles,
constructs, and pattern-matches correctly. The public API keeps
`StepOutcome.Row` on that basis, since it mirrors sqlite's own `SQLITE_ROW`.

## Design notes

Per the kinds-design.md question of "what trait or kind would help here":

- **A `transaction` kind was the clear win. BUILT** - see
  [completed/std-http-rework.md](../completed/std-http-rework.md). It landed as a
  BINDING kind rather than the region kind predicted here, and the reason is
  worth recording: a region has no name, and with no name there is nothing to
  call `commit` on. A transaction that committed itself whenever the block
  ended normally would commit on paths the author never considered successful,
  so the value is named, the rollback is automatic, and the commit is the one
  thing you have to say out loud.

      transaction tx: Tx = sqlite.begin(ref db)?;
      ... work, any `?` here rolls back on the way out ...
      let _c: int32 = sqlite.commit(ref tx)?;

  No compiler change was needed - a userland kind plus a struct, exactly as
  predicted. `examples/playground/todo_api/store.yoop` uses it for an
  all-or-nothing bulk import.
- **A `bound` / `tainted` clearance pair is the flashy one, and is premature.**
  The injection story here is structural: values go through
  `sqlite3_bind_*` and never become SQL text, so there is no escaping question to
  get wrong. A clearance kind would only earn its cost once something in-tree
  builds SQL by concatenation, which nothing does. Revisit if a query builder
  ever lands.
- **`DbRef` covers the shared-connection case.** A struct that stores a `Db`
  has to declare `propagates<disposable>`, because storing one is a claim of
  ownership. That is right for an owner and wrong for a server whose handlers
  all use the one connection `main` owns, so the binding grew an explicit
  non-owning handle (`sqlite.dbRef(ref db)` / `sqlite.borrow(h)`).
- **No kind for `Db` / `Stmt` beyond `disposable`.** Both are plain Disposable
  handles with idempotent disposers (close/finalize, then null). That is the
  discipline the advisory ownership model asks for, and the demo verifies a
  double dispose is harmless.

## Deliberately absent from the binding

- **Blobs.** `sqlite3_bind_blob` / `column_blob` need a pointer+length pair and
  a `uint8[]` round trip; worth its own pass.
- **Connection pooling**, and any notion of a query builder or ORM. Mapping
  columns to a struct stays the caller's job.
- **`sqlite3_exec`'s callback form.** Whether a Yoop function can be handed to C
  as a function pointer is untested; the prepare/step/column API makes it
  unnecessary, so it remains an open question rather than a blocker.
