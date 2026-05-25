// Library Phase A - Foundational traits (`Readable`, `Writable`, `Display`)

> First slice of the library-design rollout
> ([library-design.md §3](library-design.md)). Tiny: three new traits and
> their fallible-return companion structs. No FFI, no new kinds. Lands the
> shared trait identity that every later std module imports from one
> canonical location.

## 1. Scope

Three traits live in a new `std/core/traits.yoop` module:

```yoop
export type ReadOutcome { n: c_ssize_t, err: string }

export trait Readable {
    function read(ref self, ref buf: uint8[]): ReadOutcome;
}

export type WriteOutcome { n: c_ssize_t, err: string }
export type FlushOutcome { err: string }

export trait Writable {
    function write(ref self, ref buf: uint8[]): WriteOutcome;
    function flush(ref self): FlushOutcome;
}

export trait Display {
    function to_string(ref self): string;
}
```

`Disposable` is already in [std/core/kinds.yoop](../std/core/kinds.yoop)
and re-exported from there; this phase does not move or duplicate it.

Why these three: they're the minimum surface every later library module
either implements (`TcpStream` implements both `Readable` and `Writable`)
or takes as input (the HTTP parser reads from a `Readable`). Putting them
in `std/core` makes the identity canonical - kinds and traits compare by
reference, so one declaration per program is the rule.

## 2. Why a separate file (not in `kinds.yoop`)

`std/core/kinds.yoop` declares the `disposable` kind and the `Disposable`
trait it requires; bundling unrelated traits there would muddle a file
whose purpose is "kind machinery." `traits.yoop` is for traits that are
*not* paired with a kind clause - pure capability declarations downstream
modules opt into.

## 3. Non-goals (deferred to later library phases or to the language)

- **No vtable / `dyn` form.** Library functions that accept "any
  `Readable`" still have to be generic on `<R implements Readable>`.
  Phase E will revisit when the language gains runtime polymorphism
  ([library-design.md §8 question 1](library-design.md#8-open-language-questions-the-library-exposes)).
- **No template-literal integration for `Display`.** Templates still
  special-case `int` / `float` / `bool` / `string`. Lifting `Display` into
  templates is a typechecker change, not a library change.
- **No `Iterator<T>`.** Listed aspirationally in the library design; the
  staple library uses plain index loops until both a `for ... in` loop
  form and trait-object dispatch exist.

## 4. Files touched

- **New**: `std/core/traits.yoop` - the three traits + outcome structs
  above.
- **No change** to lexer, parser, typechecker, or codegen - this phase
  is purely a `.yoop` source addition. The language has supported every
  feature needed since Phase 7.5.

## 5. Verification

A unit-shaped fixture exercises the `Readable` / `Writable` shape via a
tiny in-memory implementation, proving the trait identity carries across
modules without any FFI:

`examples/pass/traits_readable_writable/main.yoop` - defines a
`MemBuffer` struct that implements both traits, runs a round-trip
write-then-read, and prints the byte count back. The fixture lives under
`examples/pass/` so the e2e harness picks it up automatically.

## 6. Dependencies

Strictly ordered: this phase must land before Library Phase B
([library-phase-b-net.md](library-phase-b-net.md)), which imports
`Readable` and `Writable` for `TcpStream`. Library Phase A has no
upstream dependencies beyond what's already in [std/core/](../std/core/).
