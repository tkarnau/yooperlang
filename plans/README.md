# Plans

**This directory is history and forward work, not guidance.** Plan docs record
how a system was designed and BUILT, at the time it was built. Several describe a
language that has since changed shape.

If you want to know how to write Yoop today, read
[../docs/writing_yoop.md](../docs/writing_yoop.md); it wins over anything here.
For compiler internals, read
[../docs/compiler_internals.md](../docs/compiler_internals.md).

Style for anything written here: ASCII only. No em-dashes, no curly quotes, no
fancy markdown tables.

Layout:

- **This file** - what is being worked on now, plus the index below.
- **Top level** - the small set of docs that are still ACTIVE: open work, or a
  contract the current work is written against.
- [archive/](archive/) - dormant, future, historical, and everything that has
  fully LANDED. Viewable and still useful when you want the reasoning behind a
  shipped system; just not part of the working set.
- [completed/](completed/) - per-phase write-ups for everything that shipped
  (phases 1 through 9, library phases A through D, the 10.x sub-phases).

---

## The real goal right now

Two things, in priority order:

1. **Self-host.** Rewrite the JS compiler in Yoop, layer by layer, cross-checking
   each layer's output against the JS reference before building the next one on
   top of it. This is roadmap item 10.K and the point of every prior phase.
2. **Write larger Yoop programs.** Use the self-hosting work (and the example
   programs) to get a real feel for the language's ergonomics, and feed the
   friction back into small, targeted language fixes.

Everything not in service of those two is deferred. The full language surface
(structs, traits, kinds, generics, enums/unions, errors-as-values, tasks, and a
starting standard library) already shipped. The language is usable; now it has to
compile itself.

---

## Where the bootstrap stands

Source lives under [../bootstrap/src/](../bootstrap/src/). Build order is
bottom-up, diffing each layer against the JS reference before moving up.

**`contracts.yoop` is gone as of 2026-08-12.** Its 1199 lines were an artifact
of a module being one FILE; directory modules removed the reason, and each
layer's vocabulary now lives with the layer that owns it. The tree is one module
per directory - `diagnostics`, `lex`, `ast`, `parse`, `source_graph`,
`typecheck`, `utils` - and the map is in
[../bootstrap/README.md](../bootstrap/README.md). Do not reintroduce a shared
types file.

- **Layer 0 - module graph**: WORKING. `source_graph/` walks imports depth-first,
  dedupes by absolute path (so a diamond loads its shared leaf once), refuses
  import cycles, and hands back a topologically ordered `Vec<Module>` with the
  entry LAST. Each module gets a readable, LLVM-safe id (`mathx_1`) that every
  symbol it defines is mangled against. A module is one file, or a DIRECTORY of
  files that each declare `module <name>;` and share one namespace, one id and
  one AST arena. Not yet: the `std/` and `modules/` roots, autoloads,
  side-effect imports - all refused by name.
- **Layer 1 - lex**: WORKING AND AT PARITY. `npm run test:parity` diffs the
  bootstrap token stream against the JS lexer's over 557 real source files.
  Getting there found three bugs: `0o755` lexed base-2, 14 words were promoted
  to keywords that the JS lexer leaves as contextual identifiers, and `await`
  was missing. `lex/` covers the full token set; the old
  `tests/lexer_tests` harness checks every keyword, structural token, and atom,
  and `lex/lex.test.yoop` covers sorting, precedence, keyword-vs-ident,
  literal values, and nested block comments.
- **Layer 2 - parse**: IN PROGRESS. The arena and recursive descent are built.
  Handles top-level `type` (struct body, transparent alias, type params, kind
  prefix) and `function` decls, blocks, `let`/`const`, `return`, assignment,
  `if`/`else if`/`else`, `while`, `for`, `break`/`continue`, calls, arrays
  (`T[]`, literals, indexing, `.len`), structs as values (literals, field read
  and write), `switch` with multi-pattern arms, integer casts, unary and
  compound-assignment forms, expressions by precedence climbing, `module`
  headers, `export`, every `import` form but the side-effect one (named,
  namespace, combined, and directory-module paths), and `variant` decls with
  their constructors and patterns, `trait` decls, `implements` clauses and
  methods in a type or variant body (`self` is a keyword, and its annotation is
  synthesized from the enclosing type), and template literals with `${...}`
  interpolation, `for x in xs` over an array, and `kind` declarations plus the
  prefixed forms (`async fetch(...)`, `type X c_layout { ... }`), `propagates`
  clauses, char literals, function types, raw pointers with `null`, vtable
  declarations, array slices, bitwise operators, and address-of / dereference.
  Not yet: enums, unions, `await`,
  `propagates`/`contains` clauses, type-parameter bounds - each a named "not
  supported yet" refusal rather than a mis-parse.
- **Layer 3 - typecheck**: IN PROGRESS. The interned Type/Symbol/Program model
  is built, with pass A (shells + redeclaration + exports), pass B (imports and
  namespaces), pass C (function signatures, struct fields) and a thin pass D
  (bodies + resolvedTypes decoration, including `ns.fn()` resolution). An import
  binds the SOURCE module's SymbolId - the same integer - which is what makes an
  imported type compare equal to the declared one, since type equality is
  `id == id`. Diagnostics name the file they came from. The largest layer.
- **Layer 4 - bytecode IR**: the one planned deviation from the JS pipeline
  (JS has no IR; the bootstrap may add one). Hold the codegen input contract
  stable so this stays an absorbable, contained change. Deferred until a pass or
  optimization actually wants it.
- **Layer 5 - codegen**: IN PROGRESS. `codegen/` emits LLVM IR text for the
  slice subset (functions with parameters, return, int/string literals,
  arithmetic, comparisons as `icmp`, calls, printf, locals/params as hoisted
  alloca + store/load, and `if`/`while`/`for`/`break`/`continue` as labels and
  branches over a loop-label stack, and short-circuiting `&&`/`||` through a
  stack slot rather than a phi, arrays as a `{ ptr, i64 }` descriptor, `switch`
  as an LLVM jump table, named struct types passed by value, C varargs
  promotion, `<moduleId>__<name>` symbol mangling so one LLVM module can
  hold the whole graph, and variants as a tag plus a payload blob). Split
  into deciding (`expr`/`stmt`), emitting (`instr`, one function per LLVM
  instruction with a sample of its output) and appending (`context`); the rules
  are in bootstrap/README.md and are bootstrap-specific.
- **Layer 6 - link**: WORKING. `link/` shells out to clang via libc `system`.

**A vertical slice runs end to end as of 2026-08-12.** The bootstrap compiles
`bootstrap/tests/slice/*.yoop` to real executables, and `npm run test:slice`
asserts the JS compiler and the bootstrap produce identical stdout and exit
codes. Seeding every layer first was the right call: it is what turned codegen
and link from "someday" into concrete, small modules.

**The module system landed on 2026-08-12.** Three slice fixtures cover it:
`imports.yoop` (named imports, aliases, a diamond), `namespaces.yoop` (`* as ns`
and `ns.fn()`), and `dir_modules.yoop` (a directory of files sharing one
namespace). Every layer carries its share - the graph walk and the directory
unit (layer 0), headers and all three import clauses (layer 2), pass B and the
export table (layer 3), symbol mangling (layer 5).

The one refactor it forced is worth knowing: a Module now owns several
SourceFiles that share ONE arena, so NodeIds stay unique per module and
typecheck's decoration stays a single dense vector. Diagnostics gained a file
path in the same change, because `12:5` stopped identifying anything.

**Variants landed on 2026-08-12.** `tests/slice/variants.yoop` covers tagged
unions end to end: constructors, exhaustive and defaulted switches, payload
bindings, a struct inside a payload, and value-copy semantics. The layout is
`{ i32 tag, [N x i8] payload }` with one payload struct per case, sized by
`typecheck/layout.yoop` to match the JS reference. Errors-as-values is the point
of it - `Result` and `Option` are in essentially every bootstrap signature.

**The `std/` import root landed on 2026-08-12.** `std/...` resolves against a
root discovered from `YOOP_STD_ROOT` or probed beside the executable - the same
variable the JS reference honours, which is what lets one setting point both
compilers at a stub. `tests/slice/std_imports.yoop` does exactly that, with its
own `std_imports.std/` beside it, so the resolution path is tested end to end
long before the language can compile the real std. Values from std must come
through a namespace; types may not need to. Same rule, same message, as
src/jsyooptypecheck/imports.js.

Pointing it at the REAL std now gives a precise, ordered blocker list instead of
a blanket refusal - which is the whole reason to do this before the features it
is waiting on:

    std/core/types.yoop    generic variant "Result" is not supported yet
    std/core/strings.yoop  a generic type application in an annotation
    std/core/vec.yoop      "implements" clauses on a type decl
    std/log.yoop           `extern` blocks

**Generic TYPES landed on 2026-08-12, and `std/core/types.yoop` compiles.**
That is `Result<T, E>` and `Option<T>` - the file the rest of std is built on -
going all the way to an executable through the bootstrap.

The design worth remembering: a generic decl is resolved ONCE into a TEMPLATE
whose member types are `TypeParam` placeholders, and an instance is that
template substituted. Instantiation is therefore pure TypeId arithmetic and
never touches an AST, which is what makes cross-module generics work - `Vec<T>`
is declared in one module's arena and applied in another's, and typecheck is
handed a Program, not the graph. Instantiating from syntax instead would have
meant threading the ModuleGraph through every pass.

**Generic FUNCTIONS landed the same day**, with call-site inference: from the
arguments first, then from the expected type - which is the only source when
nothing but the return type mentions the parameter, as in `Option.None`. A
generic body is CHECKED once with its parameters opaque and EMITTED once per
instantiation, substituting in `resolvedTypeAt` and nowhere else. That is sound
only because parameters have no bounds yet, and it is the decision to revisit
when they do; the note is in bootstrap/README.md.

Call arguments are also checked against their parameters now - arity and types.
That had been silently unchecked for every call in the language, which is a
worse category of gap than a refusal, and it was found by writing a generics
test that turned out to be asserting something nothing checked.

**`extern` blocks, `import.unsafe;` and kind prefixes landed next**, which
together got `std/log.yoop` compiling - a module whose whole job is calling into
the runtime through externs. An extern is the one function whose symbol keeps
its exact spelling, since that spelling IS what the linker resolves against;
`mangle.yoop` learned the exception from a table pass A fills. Kind prefixes are
parsed and RECORDED rather than dropped: nothing enforces kinds, so the
limitation is "not enforced" instead of "not parsed".

**Module-level `const` and the `_` discard landed after that.** A const is
INLINED at every use rather than emitted as a global, which is what makes an
imported one cost nothing and why its initializer has to be a compile-time
integer. `_` names a payload field without binding it - still named, so a case
that grows a field breaks its patterns loudly rather than silently leaving one
unbound. Patterns got their own payload parser in the process: they bind NAMES,
not expressions, and reusing the struct-literal parser had put that rule in
pass D and made `_` a syntax error.

**`ref` at a call site landed next.** A borrow costs no instructions at all,
because every local already lives in an alloca and a `ref` parameter arrives as
that pointer - so it gets no alloca and no spill, and the incoming pointer IS
its slot. A `ref T` parameter is `ref T` in the signature (so a bare value is a
type error) and plain `T` in the body (so nothing in the body knows about
references). Doing this before traits was worth it: a method's receiver is a
borrow, so traits inherited the whole mechanism rather than growing a second one.

**Traits landed on 2026-08-12, with STATIC dispatch.** `Shape.area(ref r)` is
resolved at compile time by the receiver's concrete type, so the emitted call is
as direct as an ordinary one - no vtable, no indirect call, nothing read at run
time. That is the form the bootstrap's own source uses almost exclusively
(`SelfLexing.peek(ref ps)`).

The shape that made it cheap: **a method IS a function whose first parameter is
`ref self`**. The source omits the annotation because there is only one type it
could be, so the parser fills it in from the enclosing type's name - and from
there every later layer treats a method as an ordinary function. Codegen got no
traits file at all, only a mangled name. Two rules fell out and are worth
keeping:

- The symbol carries the TYPE and not the trait (`Rect__area`). Two types
  implementing one trait need two symbols; one type cannot declare a method name
  twice, so type plus name is already unique, and a call site needs nothing
  beyond the receiver's type.
- There are no INHERENT methods. A method no implemented trait requires is
  refused, which is what keeps `Trait.method(ref x)` the only spelling a call
  ever needs. The JS reference already worked this way; the bootstrap was looser
  and got tightened to match.

`traits.yoop` in the slice fixtures covers two implementers of one trait, a
variant implementing one, a method calling another on `self`, a receiver mutated
between calls, and a trait and type imported from another module.

Bounds (`<T implements Comparable<T>>`) are deliberately NOT in this pass. A
generic body is checked once with an opaque `T`, which is sound only because a
type parameter can promise nothing - bounds are what break that, so they are
their own piece of work.

**Template literals landed on 2026-08-12**, interpolation included. They are the
first bootstrap feature that ALLOCATES: the result is a fresh buffer rather than
values moved between registers and stack slots.

Two decisions are worth keeping.

**An interpolation ends where its EXPRESSION ends.** The parser repositions into
the same source buffer at the byte after `${` and parses an ordinary expression;
wherever it stops IS the closing brace. That is cheaper than matching braces and
it is also the only version that is CORRECT - brace matching gets
`${g({ x: 1 })}` and `${g("}")}` wrong. The JS reference matches braces, and it
turns out it cannot lex the second one at all, so the bootstrap is strictly
better here. Repositioning is legitimate because ParserState's whole cursor is
`pos` plus a one-token lookahead.

**A built string is libc, not std.** The JS reference lowers this to std's
`stringConcatAll` and `format.intToString`, autoloaded into every graph. Reaching
those would have meant compiling a 9-file, ~1450-line slice of std first - which
needs `export kind`, `extern "intrinsic"` with generics, vtables, `propagates`
clauses and the range expression. Both std functions bottom out in a raw malloc
plus byte copying and decimal conversion, so `strlen`/`malloc`/`memcpy`/`sprintf`
is the same operation with the same observable result, including that a built
string ignores the allocator context. `codegen/template.yoop` is the single place
that changes when that std slice becomes reachable. Strings, integers of every
width and bools interpolate; floats and structs are refused by name, pointing at
the interpolation.

**`for x in xs` landed next, over ARRAYS.** The counted form could already
express all of it, so the point is not new power - it is that the index is gone,
and with it every off-by-one the index made possible. The iterable is evaluated
ONCE with its data pointer and length cached: re-evaluating per iteration would
call `headersView(ref h)` on every step, and an array growing underneath the walk
would change length mid-loop.

The other form, a type implementing `Iterable<T>`, is refused BY NAME rather than
reported as "not an array" - one is a feature to go build and the other is a
mistake, and they should not read alike. It needs **generic traits**:
`Iterable<T>` has to be instantiated before its `next` can be called, and the
bootstrap records a trait's type params today without substituting them. Six std
types implement it (`MapIter<K, V>`, `VecIter<T>`, `Range`, `Chars`, `DirIter`,
`Rows`), so it is the next real piece of the trait system. Measured first: 7 of
the bootstrap's own 8 for-in sites walk arrays, as do the http ones that were
blocked, so the array form is what actually unblocks.

**A gap this surfaced, wider than for-in, and fixed next: the bootstrap did not
enforce `const` at all.** `const a: int = 1; a = 2;` compiled clean. `LocalScope`
mapped a name to a TypeId and nothing else, so there was nothing to check
against; it now carries a `Binding` with a mutability bit, set at all five
declare sites.

The rules were established by PROBING the reference rather than read off its
source, because the two disagreed. Immutable: `const`, a for-in loop variable, a
pattern binding. Mutable: `let`, a counted loop's counter, and parameters
including `ref` ones - a parameter is a local copy, and a borrow exists to be
written through. Constness is about the BINDING, so `p.x = 2` and `xs[0] = 9`
through a const stay legal; deep immutability would be a different feature.

One deliberate divergence: the reference refuses `a = 2` on a const and ALLOWS
`a += 2` on the same binding. In the bootstrap the compound forms desugar to a
plain assignment in the parser, so one check covers both, and closing that hole
was free. Reproducing it would have meant writing code to be bug-compatible.

**Kinds landed next, and the headline is that `async` is not a keyword.** It is
declared in std/core/kinds.yoop as an ordinary `kind { appliesTo function;
pausable; }`, and `async fetch(...)` is a function carrying it - as is
`task worker(...)`, and as is anything a user declares. So the parser has no
list of blessed words: a kind prefix is an identifier standing where the
`function` keyword would, and the shape `IDENT IDENT (` is the whole tell. A
kind on a TYPE goes after the name (`type SockAddrIn c_layout { ... }`).

Kinds are AMBIENT - resolved by name against a graph-wide registry rather than
through imports, because `async fetch(...)` in std/http names a kind declared in
std/core/kinds.yoop with nothing linking the two files. The JS reference has the
same registry for the same reason. An undeclared kind is refused with the
reference's own message. Resolution happens in pass C rather than pass A, since
pass A is what registers the kinds and a file may declare one below the function
that carries it.

Nothing enforces kinds, so clauses are recorded by their leading word and read by
nobody - with one exception. `pausable` makes the function a COROUTINE, and
codegen refuses to emit one by name, because an async function emitted as an
ordinary function compiles, links, and then never suspends. That is a silent
miscompile rather than a missing feature, which is the distinction worth paying a
registry for.

Scope was set by measuring: the bootstrap's own source is fully synchronous, and
the only `async` anywhere in its std closure is two TRAIT METHOD SIGNATURES in
std/core/traits.yoop, which have no body to emit. So self-hosting needs no
coroutine lowering at all, and `llvm.coro.*` stays deferred.

Two pre-existing bugs fell out, neither reachable before: `consumeKindPrefixWithArgs`
read TWO identifiers where it should read one, and `findMatchingRParen` peeked at
a constant offset instead of its loop index, so `aligned(16)` on a type decl HUNG
the parser rather than failing.

**`propagates` clauses and char literals landed next**, both picked by measuring
the SELF-HOSTING closure rather than std at large: the 16 std files the
bootstrap's own source actually imports. That is the list that matters, and it
was 4 of 16 compiling.

`propagates<disposable>` is not optional - the bootstrap's own source carries 48
of them across 25 of its 86 files, so a compiler that cannot READ the clause
cannot read the compiler. It goes on a function after the return type, on a
`type` after the name, and on a `variant` after `implements`, and it is parsed
and recorded like every other kind surface. It needed a new fat-node slot:
FUNCTION_DECL had all five spoken for once kind prefixes landed in childE, and
`childF` now means "propagates" everywhere.

The parse problem worth remembering: `Buf propagates<tracked>` and
`disposable Buf` are BOTH two identifiers in a row - one a type followed by a
clause, the other a kind prefix followed by a type. `propagates` is contextual,
so telling them apart means reading the second identifier's text rather than its
tag. Getting it wrong makes `propagates` itself the type name.

Char literals were nearly free: the lexer already decoded `'a'` to its codepoint
into the token, so a char literal builds the same INT_LITERAL node a number does
and pins to context identically. There is no char type, and adding one to carry
the literal would have been the wrong shape - these exist for byte comparisons
in a lexer. They work in switch patterns too, which have their own literal path.

Two more JS-reference codegen bugs surfaced while writing fixtures, both crashes
rather than wrong answers: `for x in [1, 2, 3]` (untyped int elements) and
`for x in xs` where `xs: T[]` inside a generic function. The bootstrap handles
both; the fixtures route around them since a `.expected` is asserted against both
compilers.

**`extern "intrinsic"` landed next, and it took generic traits with it.**
Intrinsics are operations whose implementation IS the compiler: there is no
symbol behind `stringAsBytes`, so a call becomes instructions rather than a
`call` to anything. Six are lowered - `stringAsBytes`, `bytesAsStringUnchecked`,
`arraySlice`, `heapAlloc`, `heapFree`, `stringFromBytesUnchecked` - and five of
those are free or nearly so, which is the whole point: a yoop string is a
NUL-terminated pointer and a `uint8[]` is that pointer plus a length, so
converting between them is arithmetic. Only `stringFromBytesUnchecked`
allocates, because a byte range has no NUL and a string must have one.

Three rules worth keeping:

- An intrinsic name must NOT go in `externNames`. That table means "emit this
  call unmangled"; an intrinsic has no symbol at all. `Program.intrinsics` is
  the separate table, PROGRAM-level for the same reason `kinds` is - the module
  that calls `intr.stringAsBytes` is not the one that declared it.
- The name list and the codegen dispatch are two halves of one table, so pass A
  refuses a name codegen cannot lower. User code cannot fabricate an intrinsic.
- An intrinsic extern is implicitly EXPORTED and a C extern is not - there is
  nowhere to write `export`, since the block is the declaration.

A generic intrinsic registers as an ordinary generic decl, so `heapAlloc<T>`
infers `T` through the path every generic function already uses. That reuse is
what kept this small; the only thing that differs is that there is no body to
monomorphize.

`ctxAlloc` / `ctxFree` are REFUSED by name. They route through `yoop_ctx_alloc`
in the yoop runtime, and the bootstrap's link step is one clang call with no
runtime on it. Lowering them to malloc/free instead would compile, run, and
silently stop an installed arena from capturing the bytes - which is the entire
reason they exist. **Linking the runtime is now the next real item**, and it is
the same shape as std-root discovery: find the directory, add its `.c` files to
the clang line.

Generic TRAIT declarations came along because `std/core/kinds.yoop` declares
`trait Joinable<T>` and intrinsics.yoop imports it. The parameters are now in
scope while a trait's signatures resolve, which makes one DECLARE. It does not
make one dispatch: instantiating `Iterable<T>` before calling its `next` is
still open, and is what `for x in` over an iterable waits on.

Self-hosting closure now: `types`, `kinds`, `intrinsics`, `numbers`, `debug`,
`env`, `log` clean - 7 of 16, up from 4.

**Function types landed next** - `(k: string) => uint64` as struct fields,
parameters and locals. This is what `Map<K, V>` needs: a `KeyOps<K>` holding a
hash and an equality function, so a map over a new key type is a pair of free
functions rather than a trait impl.

The design in one line: **a function value is its address, and its type is its
signature**. There is no separate function-pointer type to convert to - an
annotation and a declared function's signature intern to the same `Type.Func`,
which is exactly what makes `{ hash: myHash }` typecheck with nothing in
between. In LLVM it is a `ptr`, and the signature lives at the call site.

That forced one real change: Func types have to compare **structurally**.
Everything else in the type system is `id == id`, and Funcs cannot be, because a
declared function's signature lives in the shell pass A registered for it and
filled in place - so two identical signatures keep different TypeIds.
`typeAccepts` is now the one place that knows.

Parenthesized type GROUPS came along, because a return type is parsed greedily:
`(k: K) => V[]` returns an array, and `((k: K) => V)[]` is an array of
functions. The fork after a `(` is decided at one token - `)`, `ref`, or
`IDENT :` means a parameter list - which is why parameters must be named.

**A silent miscompile got closed on the way.** `fns[0](x)` and `g()(x)` were
accepted and then lowered with the arguments DROPPED, the function pointer
itself becoming the value. Both compilers do it; it was unreachable before,
since the annotation did not parse. The bootstrap now refuses it by name.

**Raw pointers, `null`, vtable declarations and array slices landed together** -
three small features that all bottom out in "a pointer is a pointer".

`unsafe_ptr` is gated on `import.unsafe;`, and the conversion rule is worth
stating: a TYPED pointer widens to the opaque one and not back. `unsafe_ptr`
means "some pointer" and `unsafe_ptr<uint8>` is a promise about what it points
at, so forgetting the promise is safe and inventing one is not. `null` fits any
raw pointer and nothing else - the pointer twin of an untyped int literal, with
its own reserved TypeId. Every rule here was established by PROBING the
reference rather than reading its source.

A vtable is the type-erased shape of a trait, and the bootstrap types it as what
it is: a struct of function pointers. That gives field access, layout and
literals for free; the SYMBOL records that it erases a trait. Building one
(`Reader.from(ref s)`) is the erasure machinery and is deliberately absent -
nothing in the closure builds one, and inventing the rule before the machinery
exists would be guessing. The `c_*` names came along as LP64 aliases; the
bootstrap had `c_int` and `c_long` and was missing six.

A slice BORROWS. `xs[a..b]` is a data pointer and a length over the base's own
storage, so writing through one is visible in the base - the assertion a copying
implementation would fail. It is the same three instructions the `arraySlice`
intrinsic emits, which is the point: this is syntax for an operation that was
already there. An omitted bound is 0 rather than a synthesized literal, because
"to the end" is the base's length and codegen is the only layer holding it.

**`&` turned out not to be bitwise AND.** It was ADDRESS-OF - `&m` handing a
local to a foreign function - which is a different feature from the binary
operator that shares the token. Both landed, along with `*p`, which is the
inverse and blocked the identical seven files: taking an address you can never
read through is a half-feature.

`&x` is NOT `ref x`. A borrow is checked; `&` yields an `unsafe_ptr` with none
of those guarantees, which is why both it and `*p` are gated on
`import.unsafe;` - handing out a raw address without saying the file is unsafe
would bypass the pointer-type gate by one character. Neither needs lookahead:
`&` and `*` are each both a prefix and a binary operator, and the prefix switch
runs where a binary operator cannot appear.

The bitwise set came with them, and one thing there is worth keeping: **the
integer opcode depends on the OPERAND's signedness, not the result's**. Three
operators care - `/`, `%` and `>>` - and the bootstrap was emitting `sdiv` and
`srem` unconditionally, which is latently wrong for unsigned operands above
2^63. Fixed in the same function, since adding the signedness parameter and then
not using it would have been odd.

**A real parser bug fell out**, found by the first `*p = 9` test: assignment was
parsed regardless of the caller's precedence, so a prefix operand swallowed it
and `*p = 9` became `*(p = 9)`. It then reported "cannot assign to const p" and
pointed at the wrong thing. Assignment now only parses at minPrecedence 0, where
it belongs.

**Then the typechecker gaps that real std code found.** Seven fixes, each
invisible until std hit it and each producing a message far from its cause:

- `ref self` inside `type Vec<T>` annotated as bare `Vec`, reporting "Vec is
  generic, so it needs type arguments" and pointing at the method
- a generic function's BODY had no type parameters in scope, so
  `let new_data: T[] = ...` inside it reported "unknown type T"
- instantiating a generic type DROPPED its methods and implemented traits, so
  `Vec<string>` stopped satisfying what `Vec<T>` declares - surfacing as
  "Vec_string does not implement Disposable.dispose"
- `substitute` had no `Type.Func` case, so a method's signature survived
  instantiation still saying `(ref Vec_T) => void`
- trait satisfaction was checked DURING the fill, but the generic sweep runs
  before traits are filled - so a generic implementer was told no trait required
  its method, about a trait that simply was not populated yet
- a cast PINNED its operand, so `uint8(48 + (rest % 10))` refused to add an int
  to a uint64 - a difference the writer never wrote
- a LEADING int literal defaulted to int32 before the right operand was known

And one invariant violation worth calling out on its own: **six codegen query
helpers read `tm.resolvedTypes` directly instead of going through
`resolvedTypeAt`**, which is documented as the one place substitution happens.
Inside a monomorphization each was silently wrong - the recorded type is still
`T[]`, and the emitted IR operated on the template. That is exactly the class of
bug the invariant exists to prevent, and it had been there since generics landed.

`s.len` on a string came along with them - one `strlen`, since a string has no
length beside it the way an array does.

**The self-hosting closure is now fully accounted for: 9 of 16 compile end to
end, and the other 7 are blocked on exactly ONE thing - linking the yoop
runtime.** `vec`, `bytes`, `strings`, `text` and `map` reach codegen and stop at
`ctxAlloc` / `ctxFree`; `fs` stops at `errno.get`, which lowers to
`yoop_errno_get`; `test` stops at `ephemeral arenaScope(...) { }`, whose whole
meaning is installing an allocator for the block. All three now say so by name
rather than failing as three unrelated mysteries.

**The runtime links now, and it did unblock the rest - 15 of the 16 closure
files compile end to end.**

Discovery mirrors the std root (`YOOP_RUNTIME_ROOT`, then beside the exe),
deliberately: one mental model for "files the compiler did not compile into
itself". It is LAZY, though, where std is eager - most programs link one input
and nothing else, so the runtime is only located when codegen says the emitted
IR calls into it. That flag rides out of codegen WITH the IR, because it is a
property of those instructions rather than a separate question.

The whole runtime set gets linked rather than just what is used: `yoop_runtime.c`
calls `yoop_net_startup` and `yoop_io_shutdown`, so the dependency graph belongs
to the C files and tracking it here would mean keeping a second copy correct.

`ctxAlloc` / `ctxFree` and the `errno` bridge then became real, and the reason
they were REFUSED rather than faked held up: `ctxAlloc` lowered to malloc would
have run fine and quietly not used an installed arena, and `errno.get` cannot be
approximated at all.

Four more gaps fell out on the way, each found by the next file:

- **Methods on a GENERIC type** are now emitted one copy per instantiation, with
  `cx.typeInstance` as the substitution - the type twin of `cx.instance`. Both
  compose in `resolvedTypeAt`.
- **`Vec<T>` inside `Vec<T>`'s own body IS the template**, not a second
  instantiation. Without that, `ref self` interned an empty `Vec_T` and a method
  reading `self.i` was told its own type had no such field.
- **A generic type's method bodies were never CHECKED** - `ownTypeOf` had no
  `Symbol.GenericDecl` case, so it silently did nothing, and codegen found out
  as an empty owner name and a void return.
- **`ref x.f`** - a borrow of a field, 13 sites in std - and **`xs.ptr`**, an
  array's data pointer.

**The self-hosting closure is 15 of 16.** The one left is `std/test.yoop`, and
its blocker is no longer the runtime: `ephemeral arenaScope(N) { ... }` desugars
to a constructor, a body, and a `dispose` at the closing brace, and the bootstrap
has no scope-end disposal at all - kinds are recorded and nothing enforces them.
Running the body and never tearing the arena down is a silent leak, so it stays
refused, now saying that rather than blaming the runtime.

**Scope-end disposal landed next, and it is the first thing that makes a kind
MEAN something at run time.** Both forms work:

    disposable ids: Vec<NodeId> = vec.vecNew(4);   // a binding
    ephemeral arenaScope(N) { ... }                // an anonymous region

Nothing is hardcoded to `disposable`. A kind carrying
`mustCall <method> beforeScopeEnd` names the method, the binding's type has it,
and the emitted call is an ordinary static trait dispatch - the same
instructions `Closer.close(ref r)` would produce written by hand. A user's kind
gets the same treatment, which is the emergent-kinds design actually paying out.

The work was in finding every way OUT of a scope, not in the call: `return`
unwinds every enclosing scope innermost-first, `break` and `continue` unwind out
to the loop, and the closing brace unwinds its own. Reverse declaration order
throughout, because a later binding may hold a borrow of an earlier one.

**One deliberate divergence**: the reference does NOT dispose on `break` - a
`disposable` in a loop body leaks on the iteration that breaks. The bootstrap
disposes there. That cannot go in an ordinary fixture, since a `.expected` is
asserted against both compilers, so the slice harness grew a `<stem>.bootonly`
marker: the parity bonus is skipped and the marker file carries the reason. It
is the right shape for a suite meant to outlive the JS compiler.

Two bugs on the way, both worth remembering. Pool index 0 is a REAL string, so a
`strId` of 0 cannot mean "absent" - the clause argument is now always interned.
And a `Vec` read out of the dispose stack is a shallow copy: marking it
`disposable` freed storage the stack still owned and popped it again, which
aborts. Same trap the type arena carries, and the second time this session it
has bitten.

**Mutable globals landed last, and with them the self-hosting closure is 16 of
16 - every std file the bootstrap's own source imports now compiles end to
end.**

A module `const` is INLINED at every use; a module `let` is a real LLVM global
with an address, so a write in one function is visible in another. They get
different Symbols rather than a shared one with a flag, because they are emitted
differently - and writing a const is refused with "there is nothing to write to"
rather than a generic complaint, since the reason is that it has no storage.
Initializers must be literals: a global's initializer is fixed at compile time.
The reference accepts more there, constant-folding through function calls and
dropping their side effects; the bootstrap refuses instead.

`std/test.yoop` also needed a function value held in a LOCAL to be callable
(`const runSuite = suites[i]; runSuite();`) - the same indirect call a
function-typed field produces, reached through a name.

**A real bug fell out of writing the fixture**, which is the case for fixtures
that assert against both compilers: codegen's local NAMES were never scoped to
their block. Slots are hoisted and never reused, so nothing had noticed - but a
binding that shadowed something in an inner block went on shadowing it forever.
It is only observable when the outer name is a global, because pass D refuses an
out-of-scope read of a local, so nothing else ever asked. `unshadowed` read 99
where it should read 5.

---

## Where the bootstrap stands on self-hosting

The closure - the 16 std files `bootstrap/src` imports - compiles completely.
What remains before the bootstrap can compile ITSELF is its own source, which is
a different and larger list: the bootstrap uses `async`-free code throughout but
leans on `Result`/`Option` propagation (`?`), `switch` over variants with
payloads, `@derive(display)`, and the test harness's `suite`/`test` kinds. Those
are the next thing to measure, the same way the std closure was measured rather
than guessed at.

Past those, and not blocking a parse: **linking the yoop runtime**, which
`ctxAlloc` / `ctxFree` need, and **instantiating a generic trait**, which
`for x in` over an `Iterable<T>` needs.

Probing all 45 non-test files under `std/` with the bootstrap: five compile all
the way to clang (`core/atomic`, `core/types`, `debug`, `env`, `log`). Template
literals, for-in, and top-level async/kind are all off the blocker list. What
those files hit next:

- **`await` expressions** - 7 files, the new biggest bar, and the coroutine
  surface this pass deliberately stopped short of
- **`&` address-of** - 6 files
- **`vtable` declarations** - 2 files
- **`extern "intrinsic"`** with generics - 3 files
- **`null` and the unsafe-pointer surface** - 3 files
- the **`a..b` range expression**, and char literals

Immediate build sequence:

1. DONE - token dump + parity harness (src/dumpTokens.js,
   bootstrap/src/lex/dump.yoop, src/parity.test.js).
2. Design the layer-2 AST dump. The two ASTs are different shapes (NODE_LIST
   wrappers and annotation nodes here, plain arrays and annotation objects in
   JS), so a normalized tree format has to come BEFORE the parser grows much
   further. Then grow the parser toward what the bootstrap itself uses.
3. Typecheck pass C (fill the shells: struct fields, function signatures), then
   pass D (bodies + decoration); diff resolved types + diagnostics.
4. Build codegen straight from the typed AST (skip the IR layer initially, as
   JS does); diff the `.ll` and run the binary.

---

## Active docs (top level)

- [bootstrap-pipeline-contracts.md](bootstrap-pipeline-contracts.md) -
  **north star.** Pins the data shape that crosses each layer boundary in the
  self-hosting compiler (arena + NodeId AST, side-table decoration,
  Result + Diagnostic error channel) so the Yoop and JS implementations can
  diverge internally without losing a shared, diffable target.
- [ownership-and-typestate-redesign.md](ownership-and-typestate-redesign.md) -
  **north star.** The advisory ownership model the bootstrap follows: ownership
  is opt-in and silent by default, and the marker/typestate kinds are the part
  with teeth. Summarized for daily use in
  [../docs/writing_yoop.md](../docs/writing_yoop.md).
- [strings-ownership-and-ergonomics.md](strings-ownership-and-ergonomics.md) -
  S1, S2, S2.1 and S3 (`Text`) have LANDED. **S4 (routing bare `string`
  allocation through `ctxAlloc`) and S5 (`string ==`) are open**, which is why
  this is still here: today a bare `string` ignores the allocator context
  entirely while `Text` respects it.
- [tls.md](tls.md) - PLANNED / in progress. `std/tls/` and `std/https/` exist.
- [yooperdoom-takeaways.md](yooperdoom-takeaways.md) - the action list from a
  15,000 line DOOM port. **Partly stale**: re-verified on 2026-08-11, `bool ==`
  (2.1) and `printf` with a template-literal format (2.3) are FIXED, and the
  bare-block (2.4b) and nested-function (2.5) items are deliberate errors with
  good diagnostics now. The live items are 1.1 (untyped-literal arithmetic
  reaching codegen) and 1.2 (allocation failure is a null dereference); both are
  in the sharp-edges list in [../docs/writing_yoop.md](../docs/writing_yoop.md).

Reference for shipped systems whose invariants are subtle enough to be worth
keeping close (all cited by
[../docs/compiler_internals.md](../docs/compiler_internals.md)):

- [runtime-design.md](runtime-design.md) - the concurrency runtime contract
  (worker pool, task struct layout, refcounted pooled handles). Written against
  the 6.3 MVP, so read its scope lists with the "since landed" note at the top.
- [async-coroutines.md](async-coroutines.md) - `async`/`await` and the LLVM
  coroutine lowering that lets a task blocked on I/O give its worker thread back.
- [cancellation-and-io-deadlines.md](cancellation-and-io-deadlines.md) -
  cancellation tokens, deadline- and cancel-aware I/O, and the multiplexer fixes
  that went with them. Supersedes runtime-design.md on cancellation.
- [clearance-kinds.md](clearance-kinds.md) - the marker/clearance kind design and
  implementation (conferred/restrictive transitions, decl-authority).
- [kinds-design.md](kinds-design.md) - heuristics for when a kind earns its cost.

---

## Recently landed (moved to archive/)

These all shipped; the docs moved to [archive/](archive/) on 2026-08-11 so the
working set stays small.

- [archive/modules-as-directories.md](archive/modules-as-directories.md) - a
  module as a DIRECTORY of files that each declare `module <name>;`. Phases 1
  through 3 landed; `std/core/cancel`, `std/db/sqlite`, `std/net`, `std/http` and
  `std/tls` are directory modules. Records where the plan itself turned out to be
  wrong, plus the pass C ordering bug it surfaced (a module's semantics depended
  on the alphabetical spelling of its filenames).
- [archive/modules-folder.md](archive/modules-folder.md) - the program-owned
  `modules/` import root. Flat by policy; nesting is a hard error, because two
  copies of a type would link fine and then mismatch as `Value` versus `Value`.
- [archive/arena-and-context-allocators.md](archive/arena-and-context-allocators.md)
  and [archive/async-allocator-context.md](archive/async-allocator-context.md) -
  the ambient allocator, arenas, the temp allocator, and the per-task context
  swap.
- [archive/kinds-in-std.md](archive/kinds-in-std.md) - moving `task`, `async`,
  `joined`, `pooled` and `Task` out of the compiler into `std/core/kinds.yoop`.
- [archive/task-combinators.md](archive/task-combinators.md) - `awaitTask`, and
  why `TaskGroup`/`awaitAll`/`awaitRace` are deferred.
- [archive/testing-via-kinds.md](archive/testing-via-kinds.md) - the `--test`
  harness built out of userland kinds. Usage is in
  [../docs/writing_yoop.md](../docs/writing_yoop.md); the driver flow is in
  [../docs/compiler_internals.md](../docs/compiler_internals.md).
- [archive/library-design.md](archive/library-design.md) - the original standard
  library design contract.
- [archive/sqlite-binding-papercuts.md](archive/sqlite-binding-papercuts.md) -
  what binding libsqlite3 proved the FFI surface can already do without a compiler
  change. The `transaction` kind it asked for is built.

---

## Open TODOs

- **Naming migration, remaining tail.** std went fully `camelCase` on 2026-08-11
  (`vecNew`, `mapGet`, `Display.toString`). Still `snake_case`: tool-internal
  helpers in [../tools/](../tools/) (~30 names) and example-local helpers under
  [../examples/](../examples/). The bootstrap's module-level consts were fixed
  on 2026-08-12 (`TOKEN_SCAN_LIST`, `KEYWORD_LIST`, `WHITESPACE_CHAR_CODES`).
- **Two playground examples are stale** since the async conversion and no longer
  compile: `examples/playground/todo_api` and `examples/playground/yoopstore`
  both hit `async function must be awaited` on `serve` / `serveDefault`. Nothing
  under playground/ is covered by e2e, which is why this sat unnoticed. Fixing
  them is a call-site `await` plus whatever coloring that cascades into.
- **Figure out the idempotent cleanup/dispose pattern** (free-then-null, guard on
  null) so `dispose` is safe to call more than once. This is the discipline the
  advisory ownership model leans on instead of compiler-enforced affine moves.
- **Generic call-site inference cannot see through a generic enum's type
  arguments**: `function bridge<T>(r: Result<T, string>)` will not infer `T` from
  a `Result<int32, string>` argument, and there is no turbofish to say it out
  loud. The workaround is one bridging helper per payload type.
- **Consumer-side `yoopiler modules`** - the recorded-versus-installed view for
  the `modules/` root.

---

## What is deliberately NOT being worked on

The reasoning lives in [archive/phase-10.md](archive/phase-10.md) ("Out of
scope") and the individual archived plans:

- Classes/inheritance, garbage collection, capturing closures, `match` as an
  expression - permanently no, or covered by an existing workaround.
- A package MANAGER ([archive/package-system.md](archive/package-system.md)) -
  manifest, fetch command, URLs, hashes, versions. Only worth building when there
  is somewhere to fetch from, and narrower than it was: the `modules/` root
  covers USING third-party code, and a manifest would only decide what populates
  the folder.
- Comptime/bytecode beyond the shipped `@precompile`
  ([archive/phase-11-comptime.md](archive/phase-11-comptime.md)), variant
  ergonomics ([archive/phase-13-variant-ergonomics.md](archive/phase-13-variant-ergonomics.md)),
  and cross-binary generic vtables
  ([archive/exploration-dynamic-vtables.md](archive/exploration-dynamic-vtables.md))
  - future explorations, not committed.
- Networking polish, in-body cancellation, optimization passes, and the other
  long-tail items tracked in [archive/phase-10.md](archive/phase-10.md) - land
  opportunistically when the self-hosting work or a real consumer surfaces the
  need.
