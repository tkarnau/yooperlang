# Make `string` a borrow, not a buffer

Status: an idea, not scheduled. Written while deciding to keep the advisory
ownership model (deterministic cleanup, manual liveness) and lean on smell
detection rather than enforcement. This is the one structural cleanup that
kills a whole leak class rather than warning about it.

## The problem

`string` plays two roles, and only one is a footgun.

- **Borrowed view.** A literal, `text.view(ref t)`, a name interned from
  source, anything a read-only function reads. One pointer, no ownership,
  nothing to free. Essential, and most of what `string` is.
- **Owned buffer.** What `stringConcat`, template literals, `padStart`,
  `intToString` hand back: a fresh malloc the caller must free or leak. This is
  the leak the writing guide keeps warning about, the one `--track-heap` cannot
  even see.

## The idea

Keep `string` for the first role and take away the second. Every function that
BUILDS text returns `Text`; nothing hands back an owned bare `string`. Then
every `string` you hold is either a literal (static, never freed) or a view
into something the owner frees, and the build-a-string leak class is gone by
construction, because there is no owned bare string left to leak. It is the
&str / String, string_view / string, []const u8 / owned split done on purpose.

## Why this is not "isolate string to constants"

The view role covers literals AND `text.view` AND every read-only parameter,
which is most uses. A literal cannot be a `Text` (Text is heap-allocated,
captures an allocator, is disposable), and read-only params cannot take
`ref Text` or you could not pass a literal to them. So a borrow type that both a
literal and a Text-view satisfy has to exist, and that type is `string`. What is
removable is only its owned-buffer job.

## Already in place

- `text.concat` / `text.join` already return `Text propagates<disposable>`. The
  `strings.yoop` functions returning `string` are the legacy convenience layer
  this would retire or repoint.
- The `owned` kind already tags "this string was allocated" vs "this is a
  borrow" (`strFree` demands `owned`). Borrow-only `string` is what you get by
  deleting the sites that mint `owned` and routing them through `Text`.

## The one real decision (SPEC open question 3, String <-> cstr)

`string` is nul-terminated for C. That makes it a poor arbitrary-substring
view: `s[i..j]` cannot be a borrowed `string`, because it would not be
nul-terminated at `j` (only slicing to the end is). Two ways out, and this fork
has to be settled before any sweep:

1. **Keep `string` nul-terminated.** Substring ops that are not to-the-end keep
   returning `Text` (a copy). Simplest, C interop stays trivial, non-tail slices
   cost an allocation.
2. **Make the view a length-carrying fat pointer, keep a separate `cstr` for
   C.** Zero-copy substrings, but two text types at the boundary and every
   extern signature has to say which it means.

## Costs

- Builders returning `Text` add a disposable obligation at call sites that a
  returned `string` did not. Safer, more ceremony; an arena scope makes it free.
- `string` is everywhere in std and the compiler. Each edit is boring but there
  are many.

## The cheap first step, if the sweep is too big to want yet

The `owned` kind already marks exactly the values that leak, so a smell WARNING
("an `owned string` is dropped here without `strFree` or a transfer") catches
them where they happen with no language change. That is the advisory end of the
same lever; borrow-only `string` is the structural end. Doing the warning first
also measures how often the owned role is actually used, which is the data the
sweep decision wants.
