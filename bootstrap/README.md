# Self-hosted Yooperlang compiler

The Yooperlang compiler, written in Yooperlang. Built bottom-up, one layer at a
time, cross-checked against the JavaScript reference in [../src/](../src/) at
each layer boundary before the next layer is built on top of it.

The JS version is a REFERENCE, not something to transcribe. The point of doing
it again is clearer boundaries and less code, by leaning on language features
the JS version could not use.

## Layers

1. Lexer -> token stream
2. Parser -> AST arena
3. Typechecker -> typechecked AST
4. Bytecode generator -> bytecode IR (the one planned deviation; deferred)
5. Code generator -> LLVM IR
6. Clang -> executable

## Layout

Each directory here is a MODULE (every file in it starts with `module <name>;`).
Files inside one module see each other's declarations without importing, which
is what lets a layer's vocabulary live with the code that owns it instead of in
a shared header file.

    src/
      main.yoop        the driver
      diagnostics/     SourceLocation, Diagnostic, ParsingError
      lex/             layer 1: tokens, scan tables, char scanning, literals,
                       the lexer
      ast/             the arena: node kinds, ASTNode, AST, slot-name helpers
      parse/           layer 2: recursive descent, one file per construct
      source_graph/    layer 0: Module / SourceFile / ModuleGraph, reading a
                       module's files, the import walk, path resolution,
                       module ids, finding the std root
      typecheck/       layer 3: ids, Type, Symbol, Program, the passes
      codegen/         layer 5: typed AST -> LLVM IR text (see the rules below)
      link/            layer 6: IR -> executable, by shelling out to clang;
                     also where the runtime's C sources are found
      utils/           sort and iteration helpers with no home in std yet
    tools/             small entry points (dump_tokens)
    tests/parity/      corpus for the layer-1 parity harness
    tests/slice/       programs that compile all the way to an executable

Dependencies run one way:

    diagnostics <- lex <- ast <- parse <- source_graph <- typecheck
                   ^
                   utils

There used to be a single `contracts.yoop` holding all of that vocabulary at
once. It existed only because a module was one FILE, so any two concepts that
referenced each other had to be pulled apart into a third file. Directory
modules removed the reason, and it was dissolved. If you find yourself wanting
to add a "shared types" file, that is the smell it left behind - put the type
with its owner instead.

`diagnostics` is the one module everything depends on, and that is legitimate:
it is a leaf, it depends on nothing, and every layer really does need to say
where in the source a problem is.

## Running it

It is a real compiler now, so build it and point it at a file:

    node ../src/yoopiler.js src/main.yoop -o /tmp/yoopiler_boot
    /tmp/yoopiler_boot tests/slice/hello.yoop -o /tmp/hello
    /tmp/hello

## What it can compile today

Deliberately tiny, and it grows from the bottom. Everything outside the subset
is refused BY NAME - "pass D does not handle X yet", "unsupported extern ABI" -
rather than mis-compiled.

  * top-level `function` decls, called from each other
  * `type` decls with fields
  * `let` / `const` locals, with an annotation or inferred from the initializer
  * function PARAMETERS, readable in the body and passed at call sites
  * assignment to a local (`x = expr`)
  * `if` / `else if` / `else`, `while`, and `for (let i = 0; i < n; i = i + 1)`
  * `for x in xs { ... }` over an ARRAY - the iterable is evaluated once, and
    the loop variable is a copy of each element, bound to the element type and
    scoped to the loop. A type implementing `Iterable<T>` is refused by name:
    that form needs generic traits, since `Iterable<T>` has to be instantiated
    before its `next` can be called.
  * `kind` declarations and the declarations that carry one:

        kind c_layout { appliesTo type; layout { abi "C"; }; }
        type SockAddrIn c_layout { sin_family: uint16, }
        async fetch(u: string): string { ... }

    `async` and `task` are NOT keywords - they are kinds declared in
    std/core/kinds.yoop like any other, so a kind prefix stands where the
    `function` keyword would and the parser needs no list of blessed words. A
    kind on a TYPE goes after the name instead. Kinds are reached by NAME from
    a graph-wide registry rather than through imports, and an undeclared one is
    refused. Nothing enforces kinds, so clauses are recorded by their leading
    word - except `pausable`, which makes the function a coroutine that codegen
    refuses to emit.
  * `propagates<disposable>` clauses, on a function (after the return type), a
    `type`, or a `variant` (after `implements`). Parsed and recorded; nothing
    enforces them. Not optional for self-hosting - the bootstrap's own source
    carries 48 of these across 25 files.
  * char literals - `'a'`, `'\n'`, `'\''` - in expressions and switch patterns
  * `extern "intrinsic" from "compiler" { ... }` - operations the COMPILER
    implements. Six are lowered: `stringAsBytes`, `bytesAsStringUnchecked`,
    `arraySlice`, `heapAlloc`, `heapFree`, `stringFromBytesUnchecked`. The
    generic ones infer their type argument through the same path every generic
    function uses. `ctxAlloc` / `ctxFree` are refused by name - they route
    through the yoop runtime's allocator context, which the link step does not
    pull in yet.
  * generic TRAIT declarations (`trait Joinable<T> { function join(ref self): T; }`)
    - the parameters are in scope while the signatures resolve. That makes one
    DECLARE; instantiating `Iterable<T>` to dispatch through it is still open.
  * function types - `(k: string) => uint64` - as struct fields, parameters and
    locals. A named function is a value of its own signature, so
    `{ hash: myHash }` needs no conversion, and a call through a field is an
    indirect call. Parenthesized type GROUPS come with them, since
    `((k: K) => V)[]` is the only way to spell an array of them.
  * `unsafe_ptr` / `unsafe_ptr<T>` and `null`, gated on `import.unsafe;`. A
    typed pointer widens to the opaque one and not back; `null` fits any raw
    pointer and nothing else. The `c_*` names are LP64 aliases, not types.
  * `vtable Name for Trait { m: (args) => R, }` - DECLARED, resolved, and laid
    out as the struct of function pointers it is. Building one
    (`Reader.from(ref s)`) is the erasure machinery and is not here.
  * array slices - `xs[a..b]`, `xs[a..]`, `xs[..b]`, `xs[..]` - half-open, and
    a borrowing VIEW rather than a copy
  * bitwise `& | ^ << >>`, with the opcode chosen from the OPERAND's
    signedness (`ashr` vs `lshr`, and `sdiv`/`udiv` alongside them)
  * `&x` and `*p` - address-of and dereference, gated on `import.unsafe;`.
    Not `ref x`: `&` yields an `unsafe_ptr` with none of a borrow's guarantees.
    `*p = v` stores through the pointer.
  * `s.len` on a string - the BYTE length, one `strlen` - and `xs.ptr` on an
    array, its data pointer
  * `ref x.f` - a borrow of a FIELD, not just of a whole binding
  * methods on GENERIC types, emitted one copy per instantiation
  * `ctxAlloc` / `ctxFree` and the `errno` bridge, which LINK the yoop runtime
  * SCOPE-END DISPOSAL, in both forms:

        disposable ids: Vec<NodeId> = vec.vecNew(4);   // a binding
        ephemeral arenaScope(N) { ... }                // an anonymous region

    A kind carrying `mustCall <method> beforeScopeEnd` names the method; the
    call fires on every way out of the scope - the closing brace, an early
    `return`, a `break` or `continue` - in REVERSE declaration order. Nothing is
    hardcoded to `disposable`: the call is an ordinary static trait dispatch,
    and a user's kind gets the same treatment.
  * module-level `let` - a MUTABLE GLOBAL, with a literal initializer. Distinct
    from a module `const`, which is inlined and has no storage to write to.
  * a function value held in a LOCAL, called through its name
  * `break` and `continue`, checked to be inside a loop
  * comparisons `== != < > <= >=`, and `&&` / `||` with real short-circuiting
  * `true` / `false`, unary `-` and `!`, parenthesized grouping
  * compound assignment (`x += 1`), including in a `for` step, on a name or a
    field PATH (`cx.loops.frames.len -= 1`). Not on an index: the forms desugar
    to `target = target <op> value`, and `xs[f()] += 1` would call `f` twice.
  * nested field paths - `a.b.c = v` reads and writes, at any depth, as long as
    the path bottoms out in a named binding
  * arrays: `T[]` annotations, `[a, b, c]` literals, `xs[i]` read and write,
    `xs.len`, and passing an array to a function
  * integer casts (`usize(n)`, `int8(x)`)
  * `switch` over an integer, with multi-pattern arms and a required `default`
  * structs as VALUES: `{ x: 1 }` literals, field read and write, passing and
    returning by value
  * generics: generic `type`, `variant` and `function` decls, monomorphized on
    demand. Types take explicit arguments (`Box<int>`, `Result<int, string>`,
    `Vec<Map<string, TypeId>>`); a function's are INFERRED, from the arguments
    first and then from the expected type - which is the only source when
    nothing but the return type mentions the parameter (`nothing(): Maybe<T>`).
  * `variant` decls, their constructors and their switch patterns:

        variant Shape { Circle { r: int }, Rect { w: int, h: int }, Empty }
        const c: Shape = Shape.Circle { r: 2 };
        switch (s) {
          case Shape.Circle { r: r }: { return r; }
          case Shape.Rect { w: w, h: h }: { return w * h; }
          case Shape.Empty: { return 0; }
        }

    A switch over a variant is exhaustive or has a default, never neither and
    never both, and a pattern BINDS its payload into the arm.
  * `trait` decls, `implements` clauses, and methods, with STATIC dispatch:

        trait Shape { function area(ref self): int; }
        type Rect implements Shape {
          w: int,
          h: int,
          function area(ref self): int { return self.w * self.h; }
        }
        printf("%d\\n", Shape.area(ref r));

    `Shape.area(ref r)` is resolved at COMPILE time by the receiver's concrete
    type, so the emitted call is as direct as an ordinary one. A variant takes
    methods the same way a struct does. There are no INHERENT methods: a method
    a trait does not require is refused, which keeps `Trait.method(ref x)` the
    only spelling a call ever needs.
  * template literals, including `${...}` interpolation:

        `${tagName(kind)} at ${line}:${col}`

    Strings, integers of every width, and bools can be interpolated; a float or
    a struct is refused by name, pointing at the interpolation. A template with
    no interpolation does not allocate - it is a string literal wearing
    backticks. This is the first bootstrap feature that allocates at all.
  * `return`, with or without a value
  * int literals, string literals, `+ - * / %`
  * calls, including the `printf` builtin. A call's arguments are checked
    AGAINST the callee's parameters - right number, right types - and each one
    is checked against its own parameter, which is what pins an untyped literal
    to it (`wide(7)` gives the 7 an int64). `printf` is the exception: variadic,
    so there is no signature to check against.
  * `export function` / `export type`, and every import form but one:

        import { add, scale as times, Point } from "./lib/mathx.yoop";
        import * as mathx from "./lib/mathx.yoop";
        import { Point }, * as mathx from "./lib/mathx.yoop";
        import { Point } from "./lib/geo";        // a DIRECTORY module

  * `ns.fn(...)`, resolved against the namespaced module's EXPORTS
  * directory modules: a directory whose `.yoop` files each declare
    `module <name>;` is ONE module - one namespace, one mangled prefix, and its
    files see each other's declarations without importing

  * `extern "C" from "stdio.h" { function puts(s: string): int; }` - signatures
    for functions that live somewhere else. An extern is the one function whose
    symbol keeps its exact spelling, since that spelling IS what the linker
    resolves against.
  * `import.unsafe;` / `import.test;` - module-level FLAGS rather than imports,
    which is what the `.` distinguishes.
  * module-level `const NAME: T = <integer literal>;`, INLINED at every use
    rather than emitted as a global - which is what makes an imported one cost
    nothing, and why the initializer has to be something there is to inline.
    Module-level `let` is refused: a mutable global is a different feature.
  * `_` in a pattern (`case Res.Err { code: c, detail: _ }`) - names a payload
    field without binding it. Still NAMED, so a case that grows a field breaks
    its patterns loudly.
  * `ref` at a call site (`vec.vecPush(ref out, x)`) - a BORROW. Writing it is
    required, not inferred: a `ref v: T` parameter is `ref T` in the signature,
    so passing a bare `v` is a type error and the reader can see at the call
    which arguments the callee may write through.
  * kind prefixes in an annotation (`owned string`), parsed and RECORDED. No
    kind is enforced, so nothing reads them yet; the limitation is "not
    enforced" rather than "not parsed", and the JS reference additionally checks
    the kind was imported, which the bootstrap has no kind table to do.
  * `ns.Type` in an ANNOTATION (`fs.DirIter`, `vec.Vec<int>[]`) - a type reached
    through an imported namespace, resolved against that module's exports. The
    qualified spelling and a named import reach the SAME type. A qualified
    PATTERN (`case ns.Tag.Hot:`) is a separate surface and is not here.
  * `std/...` import paths, resolved against a root the compiler DISCOVERS:
    `YOOP_STD_ROOT` if set, otherwise a probe beside the executable. Values from
    std must come through a namespace (`import * as log from "std/log.yoop"`);
    types may be imported by name.

Not yet: side-effect imports (`import "./init.yoop";`), the `modules/` import
root, std AUTOLOADS, `ns.CONSTANT` and `ns.Variant.Case` in a PATTERN (a
namespace reaches types and calls, and nothing else), type-parameter BOUNDS
(`T implements Display`), kind
prefixes in a type argument, value `enum`s, unions, `@derive(display)`, `?`
propagation, floats, and a compound assignment on an INDEX (`xs[i] += 1`), which
is refused rather than desugared because the desugaring would evaluate the
subscript twice.


**`std/core/types.yoop` and `std/log.yoop` compile** - `Result<T, E>` and
`Option<T>`, and a module whose whole job is calling into the runtime through
externs. The next ones up still need language the bootstrap does not have:

    std/core/strings.yoop  the `a..b` range expression
    std/fs.yoop            `null`, and the unsafe-pointer surface behind it
    std/core/vec.yoop      "implements" clauses on a type decl
    std/core/text.yoop     the same

Traits are the wall.

Integer widths do NOT mix, matching the JS reference: `xs[0] + xs.len` is
`int32 + usize` and is an error. Write the cast.

Two invariants control flow introduced, both easy to break:

- **Allocas are hoisted** into `entry:` via `Emitter.prologue`. An alloca must
  dominate every load, and one emitted inside an `if` arm does not dominate a
  use after the join. Slot names carry a uniquing number for the same reason -
  sibling branches may each declare `a`.
- **One terminator per block.** `emitBlock` / `emitStatement` report whether the
  path definitely `terminated` - a `ret`, but also a `break` or `continue` -
  so no `br` follows one. An `if` whose both arms return emits no join block at
  all. Getting this wrong produces invalid IR that clang rejects, not a wrong
  answer.
- **A `for` loop's step gets its own block.** `continue` jumps to the STEP, not
  the condition, so the counter still advances; wiring it to the condition
  instead spins forever. That is why `LoopLabels` carries two targets.
- **An array is a `{ ptr, i64 }` descriptor** - data plus length - and a
  literal's storage is a hoisted `alloca [N x T]` that the descriptor points
  into. So a literal BORROWS the enclosing function's stack: returning one hands
  back a dangling pointer. The JS reference has the same property; a
  heap-allocating form is a separate feature.
- **Structural types must intern to one TypeId.** Type equality is `id == id`,
  so two `int[]` annotations that interned separately would compare unequal.
  `internArray` / `internRef` scan before inserting.
- **Variadic calls must PROMOTE narrow arguments.** C default argument promotion
  passes integers as 32- or 64-bit, so an `i8` handed to `printf` leaves the rest
  of the slot holding whatever was there before - the printed number is unrelated
  to the value, not merely rounded. `casts.yoop` in the slice fixtures is the
  test; it printed 300 for `narrow(300)` before promotion existed, instead of 44.
- **A `switch` allocates every arm's label before emitting any of them**, because
  the jump table names them all up front. That is the one structural difference
  from `if`.
- **A struct is a VALUE, and a field read and a field write take different
  routes.** A read is `extractvalue` on the loaded value, so it works on any
  struct expression including a call result; a write is `getelementptr` on the
  binding's slot, because a store needs an address and only a named binding has
  one. Struct literals store by field POSITION, so a literal may list its fields
  in any order - `structs.yoop` covers both that and the copy-on-assign that a
  pointer representation would break.
- **`&&` and `||` branch, they do not compute.** Both lower to a condition, a
  right-hand-side block, and a stack slot the two paths write - never a single
  instruction over two evaluated operands. `expressions.yoop` in the slice
  fixtures is the test that catches a non-short-circuiting lowering; every other
  assertion in it passes either way.
- **The module graph is topologically ordered, and everything above it leans on
  that.** A module's imports are loaded, and therefore indexed, before it is; so
  a module's ModuleId is greater than every module it imports. That single fact
  is what lets typecheck run all four passes in ONE walk per module instead of
  four walks over the graph, and what makes pass B a lookup rather than a second
  fixpoint. An import cycle is refused during the walk, which is the only place
  that can see one.
- **A MODULE is the namespace and mangling unit; a SOURCE FILE is the
  compilation unit.** They are the same thing for `./util.yoop` and different for
  a directory module. Every layer above walks `m.files`, never one root.
- **A module's files share ONE arena.** NodeIds are therefore unique across the
  whole module, which is what keeps typecheck's decoration a single dense vector
  indexed by NodeId rather than one vector per file - the alternative would have
  changed every one of pass D's decoration sites. `parseInto` moves the arena in
  and back out, so each file appends to it and keeps its own PROGRAM root.
- **The module header is read by LEXING three tokens, not by parsing.** The
  graph cannot parse a file until it knows which module owns it (that is which
  arena it goes in), and it cannot know that without the header - so
  `parse/header.yoop` answers the question without an AST. That is what the JS
  reference needs a parse cache for.
- **A variant is `{ i32 tag, [N x i8] payload }`,** with one payload STRUCT per
  case that carries something (`%variantc.m__Shape__Circle`). LLVM has no union,
  so N is the largest case's naturally-aligned size and every case reads the same
  bytes as a different struct. The sizes come from `typecheck/layout.yoop`, which
  matches the JS reference case for case - the two compilers never link together,
  but a payload-size disagreement would show up as a corrupted field rather than
  as an error, so it is worth being able to diff. The tag is i32 for the same
  reason, which means an 8-byte payload field sits at offset 4; that matches the
  reference and is fine on every target the compiler supports.
- **A variant is a VALUE, and both directions go through a stack slot.** The
  payload is addressed as whichever case struct the tag names, and only an
  ADDRESS can be reinterpreted that way - a loaded value has none. Same
  asymmetry as a struct field write versus a read, and for the same reason.
- **An exhaustive variant switch has no default arm, so its jump table gets an
  `unreachable` block.** Without one the fall-through would make the switch look
  non-terminating, and a function whose every arm returns would be rejected for
  having no return on some path. `variants.yoop` in the slice fixtures covers it.
- **A `Vec` read out of the type arena is a SHALLOW copy that shares the arena's
  storage.** Never mark one `disposable`: it frees the arena's own fields, and
  the next lookup reads freed memory. `VariantCaseLookup` is deliberately shaped
  to hand out an ordinal and a count rather than the case's `Vec<Field>`, because
  that is exactly the bug it caused - a null dereference three passes away from
  the annotation that caused it.
- **A generic decl is resolved ONCE into a TEMPLATE, and an instance is that
  template SUBSTITUTED.** Instantiation is pure TypeId arithmetic and never
  touches an AST - which is what makes cross-module generics work at all, since
  `Vec<T>` is declared in one module's arena and applied in another's, and
  typecheck is handed a Program rather than the graph. The alternative
  (instantiate from the decl's syntax) would need every pass to carry the
  ModuleGraph. See `typecheck/generics.yoop`.
- **An instance is REGISTERED before it is filled, and deduplicated by (origin,
  args).** That is what makes `type Node<T> { next: Node<T> }` terminate rather
  than recurse: the second request is a registry hit. It is also why
  `Box<int>` written in two places is ONE type - and it has to be, or nothing
  could be passed between two annotations that spell it the same way.
- **Templates are skipped by codegen.** A template's members are TypeParams,
  which have no LLVM type and which nothing ever holds a value of; only the
  instances substitution produced are real. `isOpenInstance` is the test.
- **Openness is a property of the whole type TREE, so the test recurses.**
  `Box<Box<T>>` has no TypeParam among its own arguments - the argument is
  `Box<T>`, a struct instance - so a top-level check calls it closed and codegen
  emits a typedef whose field type is `Box_T`, the template it just skipped.
  Clang rejects the dangling reference. `typeMentionsTypeParam` walks nominal
  arguments and the structural wrappers (`Ref`, `Array`, `Task`, `UnsafePtr`,
  `Func`, `FuncPtr`) alike. It terminates because an argument is always built
  before the instance carrying it, so the argument graph has no cycle.
- **A generic function's body is CHECKED once and EMITTED once per
  instantiation.** Pass D checks it with its parameters left opaque, so its
  decoration is written in terms of them; codegen walks that same decoration per
  instance and substitutes on the way out, in `resolvedTypeAt` and nowhere else.
  That is sound only because a parameter has no BOUNDS: an opaque `T` supports
  nothing, so a body that checks generically checks for every instantiation
  (`return x + 1` on an unbounded `T` is rejected at the decl). When bounds land,
  this is the decision to revisit - re-checking per instantiation is the
  alternative, and it costs a decoration vector per instance.
- **Reserved index 0 is the sentinel, everywhere.** SymbolId, DeclId and the
  function-instance index all burn slot 0 on a dead entry. The first attempt at
  the last one used a max-value constant instead, and it silently WRAPPED to 0 -
  so the first monomorphization in every program was emitted as ordinary code,
  under the generic's bare name with its parameters unresolved. Use the idiom.
- **`>>` is one token, and closing a nested type-argument list splits it.**
  `Vec<Map<string, TypeId>>` ends in a right-shift, so `consumeClosingGt`
  consumes it and remembers that one `>` is still owed. Same trick, same reason,
  as the JS reference's `pendingGtFromRshift`.
- **A pending `>` CLOSES the list, so nothing may peek past it.** While one is
  owed the cursor already sits beyond the whole annotation, so
  `parseTypeArgList` must break on `ps.pendingGt` BEFORE it looks for a comma.
  Without that, `Vec<Vec<T>>, g: int` reads the field separator as another type
  argument and swallows the next field - and the failure surfaces as "expected
  IDENT, got COLON" pointing at the field AFTER the one that is wrong. It bites
  wherever a `,` follows a `>>`: fields, parameters, and the middle of an
  enclosing argument list all break identically.
- **The std root is DISCOVERED once, by the driver, and passed in.**
  `loadModuleGraph` takes it as a parameter rather than probing for it, so a
  caller that already knows its root - a test pointing at a stub, and eventually
  the LSP - never touches the filesystem probing in `std_root.yoop`. The
  discovery rule honours `YOOP_STD_ROOT`, which is what the JS reference honours
  too, so one variable retargets both compilers at the same tree.
- **A borrow costs no instructions.** Every local already lives in an alloca, so
  `ref x` is the ADDRESS of storage that exists; and a `ref` parameter arrives
  as that pointer, so it gets no alloca and no spill - the incoming pointer IS
  its slot (`LocalSlot.id == ARG_PTR_SLOT`, the reserved zero again). Every load
  and store in the body then works unchanged, because they only ever needed an
  address, and they land on the caller's object. `refs.yoop` in the slice
  fixtures is the test a by-value lowering would still pass most of.
- **A `ref T` parameter is `ref T` in the SIGNATURE and `T` in the BODY.** The
  first is what makes passing a bare value an error; the second is what keeps
  every read, write and field access in the body from needing to know about
  references at all. `bindParams` is where the two part company.
- **A METHOD IS A FUNCTION whose first parameter is `ref self`.** The source
  omits the annotation because there is only one type it could be, so the PARSER
  fills it in from the enclosing type's name (`parse/traits.yoop`). Everything
  below that point treats a method as an ordinary function - the same childB /
  childC / childD slots, the same body checker, the same emitter, and the borrow
  machinery unchanged. Do not add a method-shaped path to a later pass; if one
  seems necessary, the annotation is probably not being synthesized.
- **A method's symbol carries the TYPE and not the TRAIT** (`Rect__area`). Two
  types implementing one trait need two symbols, so the type has to be in it. A
  type cannot declare the same method name twice no matter how many traits asked
  for it, so the type plus the name is already unique - and a call site has the
  receiver's type and the method name, and needs nothing else. The home module is
  the one that declared the TYPE, so an imported type's method stays one symbol.
- **A method body is only reached through its type decl.** Pass D's walk visits
  top-level names, and a method is not one, so `checkMethodBodies` reaches into
  each TYPE_DECL and VARIANT_DECL. Miss that and a method body is never checked
  at all, and its parameters are never decorated - which codegen finds out about
  much later and much less clearly.
- **A variant's methods share the member run with its cases,** so the case
  ordinal counts off `cases.len` and not off the loop index. Counting off the
  index puts a hole in the tag numbering, and the tag numbering is ABI.
- **A module `const` is INLINED; a module `let` is a real global.** They get
  different Symbols because they are emitted differently - one has no storage at
  all, which is why writing it is refused with "there is nothing to write to"
  rather than a generic const complaint.
- **Codegen's local NAMES are scoped to their block, though their slots are
  not.** Allocas stay hoisted and a slot id is never reused, but a name has to
  stop resolving at the closing brace - otherwise a binding that shadowed
  something in an inner block shadows it forever. Only observable when the outer
  name is a global: pass D refuses an out-of-scope read of a local, so nothing
  else ever asks.
- **A disposal fires on EVERY way out of a scope,** not just the closing brace.
  `return` unwinds every enclosing scope innermost-first; `break` and `continue`
  unwind out to the loop. The dispose stack (`dispose_stack.yoop`) is what makes
  "how far" answerable, and it is parallel to the loop-label stack by
  construction.
- **Reverse declaration order.** A later binding may hold a borrow of an earlier
  one - a `Text` built into an arena has to go before the arena.
- **Disposing on `break` is a DELIBERATE divergence.** The JS reference leaks
  there. `dispose_break.yoop` asserts the bootstrap alone, via a
  `<stem>.bootonly` marker that skips the parity bonus and carries the reason.
- **A returned VALUE is computed before anything is disposed.** It may read a
  binding that is about to go.
- **A `Vec` read out of the dispose stack is a SHALLOW copy.** Marking it
  `disposable` frees storage the stack still owns and pops it again a moment
  later - a double free, which aborts. Same trap a Vec read out of the type
  arena carries.
- **The runtime is found LAZILY, only when the emitted IR calls into it.** Most
  programs link one input and nothing else; `Emitter.usesRuntime` is what says
  otherwise, and it rides out of codegen with the IR because it is a property of
  those instructions. Discovery mirrors the std root on purpose - one mental
  model for "files the compiler did not compile into itself".
- **The WHOLE runtime set gets linked, not what is used.** `yoop_runtime.c`
  calls `yoop_net_startup` and `yoop_io_shutdown`; that dependency graph belongs
  to the C files, and tracking it here would mean keeping a second copy correct.
  `yoop_tls.c` is the one exclusion - it needs OpenSSL.
- **A generic type's METHODS are emitted once per instantiation,** with
  `cx.typeInstance` as the substitution - the type twin of `cx.instance`. Both
  compose in `resolvedTypeAt`, since a generic function can be called from
  inside a generic type's method.
- **`Vec<T>` inside `Vec<T>`'s own body IS the template,** not a second
  instantiation. `instantiate` returns the template when the args are the
  params; without that, `ref self` interns an empty `Vec_T` and a method reading
  `self.i` is told its own type has no such field.
- **`resolvedTypeAt` is the ONE place substitution happens, so nothing may read
  `tm.resolvedTypes` directly.** Inside a monomorphization the recorded type is
  still `T[]`; a raw read produces IR that operates on the template. Six query
  helpers were doing it, and each was silently wrong inside a generic instance.
- **A generic decl's METHODS and implemented TRAITS travel with the instance.**
  Instantiation substitutes fields; dropping the rest leaves `Vec<string>` with
  an empty method table, so it stops satisfying the traits `Vec<T>` declares -
  which surfaces far away as "Vec_string does not implement Disposable.dispose".
- **`substitute` covers `Type.Func` too.** A method's signature is one, and
  without it the instance keeps a `(ref Vec_T) => void` that talks about the
  template.
- **Trait satisfaction is checked in its OWN sweep, after every fill.** The
  generic sweep runs before traits are filled, so checking during the fill
  reports "no implemented trait requires it" about a trait that was not
  populated yet.
- **A generic function's type parameters must be in scope for its BODY,** not
  just its signature - `let xs: T[] = ...` is an annotation inside the body.
- **A cast must NOT pin its operand.** It converts what it is given, so passing
  the target down makes `uint8(48 + big)` pin the 48 to uint8 and then refuse to
  add it to a uint64.
- **A LEADING int literal is re-pinned from the other operand.** The right side
  is checked with the left as its expectation and gets this free; the left has
  already defaulted to int32 by the time the right is known.
- **`&` and `*` are each BOTH a prefix and a binary operator,** told apart by
  position alone - the prefix switch runs where a binary operator cannot appear.
  No lookahead, and none is needed.
- **Assignment is only parsed at minPrecedence 0.** It binds loosest of
  anything, so a prefix operand must not swallow it: without the guard `*p = 9`
  parses as `*(p = 9)` and reports "cannot assign to const p", pointing at the
  wrong thing entirely.
- **The integer opcode depends on the OPERAND's signedness**, not the result's.
  Three operators care: `/` (sdiv/udiv), `%` (srem/urem) and `>>` (ashr/lshr).
  `and`, `or` and `xor` are bit-for-bit and never do.
- **A slice BORROWS; it does not copy.** `xs[a..b]` is a data pointer and a
  length over the base's own storage, which is why writing through one is
  visible in the base - and why nothing keeps the base alive. Same three
  instructions the `arraySlice` intrinsic emits, because it is the same
  operation with syntax on it.
- **An omitted slice bound is 0, not a synthesized literal.** "To the end" is
  the base's own length, and codegen is the only layer that has it.
- **An index and a slice open the same way**, so the index expression is parsed
  FIRST and reinterpreted when a `..` follows. Do not add lookahead for it.
- **A typed `unsafe_ptr<T>` widens to the opaque `unsafe_ptr`, and not back.**
  The opaque one means "some pointer"; narrowing it invents a promise about what
  it points at. Opaque is `pointee == 0`, the reserved none-id.
- **A vtable IS a struct** - of function pointers, one per trait method - so it
  gets a struct TYPE and field access, layout and literals come free. The
  SYMBOL is what records that it erases a trait.
- **A function VALUE is its address, and its type is its signature.** There is
  no separate "function pointer" type to convert to: an annotation
  `(k: string) => uint64` and a declared function's signature intern to the same
  `Type.Func`, which is exactly what makes `{ hash: myHash }` typecheck.
- **Func types compare STRUCTURALLY, through `typeAccepts`.** Everything else in
  the type system is `id == id`, and Funcs cannot be: a declared function's
  signature lives in the SHELL pass A registered for it and filled in place, so
  two identical signatures keep different TypeIds. `typeAccepts` is the one
  place that knows; do not reach for `==` when a Func can be on either side.
- **A `(` in a type annotation is a function type only when the next token is
  `)`, `ref`, or `IDENT :`.** Otherwise it is a parenthesized GROUP, whose only
  job is attaching `[]` - a return type is parsed greedily, so `(k: K) => V[]`
  returns an array and `((k: K) => V)[]` is an array of functions. Parameters
  must be NAMED, which is what makes the fork decidable at one token.
- **A call through anything but a name or a field is REFUSED.** `fns[0](x)` and
  `g()(x)` were silently miscompiled before - arguments dropped, the function
  pointer itself becoming the value - and only became reachable when function
  types landed.
- **An intrinsic is not a call, so its name must NOT be in `externNames`.**
  That table means "emit this call with its name unmangled"; an intrinsic has no
  symbol at all, and codegen lowers it to instructions. `Program.intrinsics` is
  the separate table, and it is PROGRAM-level for the same reason `kinds` is:
  the module that calls `intr.stringAsBytes` is not the one that declared it.
- **The intrinsic list and the codegen dispatch are two halves of one table.**
  Pass A refuses a name codegen has no lowering for - user code cannot fabricate
  an intrinsic, because the name IS the implementation. Adding to one side
  without the other emits a call to a symbol nothing defines.
- **An intrinsic extern is implicitly EXPORTED; a C extern is not.** There is
  nowhere to write `export` - the block is the declaration - and every std
  module reaches them through `import * as intr`. The reference does the same.
- **A generic intrinsic registers as an ordinary generic decl.** Call sites then
  infer `T` through the path every generic function already uses. What differs
  is that there is no body to monomorphize, and codegen never looks for one
  because the intrinsic dispatch runs before any symbol is resolved.
- **A char literal IS an int literal.** The lexer decodes `'a'` to its codepoint
  into the token, so the parser builds the same INT_LITERAL node a number would
  and it pins to context the same way. There is no char TYPE and adding one to
  carry the literal would be the wrong shape - these exist for byte comparisons
  in a lexer, and a byte is what they are.
- **A clause keyword is not a kind prefix, and both are two identifiers.**
  `Buf propagates<tracked>` is a type followed by a clause; `disposable Buf` is
  a kind followed by a type. `propagates` is CONTEXTUAL, so telling them apart
  means reading the second identifier's TEXT rather than its tag - getting it
  wrong makes `propagates` the type name and reports "unknown type propagates".
- **`childF` is the propagates clause, on every kind that has one.** A
  FUNCTION_DECL had all five earlier slots spoken for once kind prefixes landed
  in childE. One slot, one meaning - do not overload it.
- **`async` is a kind, not a keyword,** and so is `task`. Both are declared in
  std/core/kinds.yoop as ordinary `kind { ... }` decls. Nothing in the parser
  may special-case either word: a kind prefix is an identifier standing where a
  keyword would, and the shape `IDENT IDENT (` is the whole tell. A user kind
  gets the same treatment, which is the point.
- **Kinds are AMBIENT, reached by name from `Program.kinds`.** A kind prefix is
  not imported - `async fetch(...)` in std/http names a kind declared in
  std/core/kinds.yoop with nothing linking the two files - so it resolves
  against a graph-wide registry. The JS reference has the same registry for the
  same reason.
- **Kind prefixes resolve in pass C, not pass A.** Pass A REGISTERS the kinds,
  and a file may declare one below the function carrying it. Resolving in the
  walk that registers would make declaration order matter, which it does
  nowhere else in the language.
- **A function carrying a PAUSABLE kind is refused by codegen.** It is a
  coroutine, and emitting it as an ordinary function compiles, links, and then
  never suspends - a silent miscompile rather than a missing feature. This is
  the one kind clause anything reads.
- **A kind clause ends at the `;` at DEPTH ZERO.** `layout { abi "C"; };` has a
  braced body, and stopping at the first `;` leaves a stray `}` that surfaces
  much later as "unexpected token at top level".
- **A scope binding carries MUTABILITY, not just a type.** `const a = 1; a = 2;`
  has to be refused and the type alone cannot say so. It rides in the binding
  rather than in a second table so there is one source of truth per name - a
  parallel mutability map is a thing to forget at a new declare site. Immutable:
  `const`, a for-in loop variable, a pattern binding. Mutable: `let`, a counted
  loop's counter, and PARAMETERS including `ref` ones - a parameter is a local
  copy and a borrow exists to be written through.
- **Constness is about the BINDING, not the value behind it.** `p.x = 2` and
  `xs[0] = 9` through a `const` are allowed, matching the reference. Deep
  immutability would be a different feature, not a stricter version of this one.
- **The compound forms desugar to a plain assignment in the PARSER,** so one
  check covers `a = 2` and `a += 2` both. The JS reference checks somewhere that
  the desugaring bypasses, so it refuses the first and allows the second on the
  same binding; the bootstrap deliberately does not copy that.
- **Desugaring names the target TWICE, so it is gated on the target being a
  PLACE** - a name, or a path of fields reaching one. Those cost nothing to read
  a second time. `xs[f()] += 1` would call `f` once to read and again to write,
  so an index target is refused by name until a real COMPOUND_ASSIGNMENT node
  exists. `isPlaceExpr` is the gate and it is about SIDE EFFECTS, not about what
  is assignable - pass D still decides that.
- **The re-read is a COPY of the path, not the same NodeId.** The arena is a
  TREE: sharing one node between the read and the write would have pass D
  decorate it from two directions and codegen walk it twice under one entry.
  `clonePlaceExpr` copies the source location along with the node, so a
  diagnostic about the re-read points at what the writer actually wrote.
- **A field WRITE needs its base to have an ADDRESS; a READ needs nothing.**
  `a.b.c = v` walks down to a named binding, and `emitFieldAddress` recurses -
  gep from `a`'s slot to `b`, then from THAT POINTER to `c` via
  `emitGepFieldOfPtr`. `f().x = v` is refused because a call's result lives in a
  temp with nowhere to store back to, while `f().x` reads fine as an
  extractvalue on the loaded value. Same asymmetry as the one-level case, just
  applied at every step.
- **A `for ... in` iterable is evaluated ONCE**, before the loop, with its data
  pointer and length cached. Re-evaluating per iteration calls
  `headersView(ref h)` on every step, and an array that grows underneath the
  walk changes length mid-loop. The condition is `uge` against that cached
  length, not `eq` - an equality test on an empty array runs the body once and
  then walks off the end.
- **An interpolation ends where its EXPRESSION ends, not at a matching brace.**
  `parseTemplateLiteral` repositions into the same source buffer at the byte
  after `${` and parses an ordinary expression; wherever that stops IS the
  closing brace. Brace matching gets `${g({ x: 1 })}` and `${g("}")}` wrong -
  the JS reference matches braces and cannot lex the second one at all. Do not
  "simplify" this into a scan.
- **The template parser must not lex PAST the closing brace.** The bytes after
  it are template text, not code, so the brace is PEEKED and never consumed, and
  the cursor is repositioned for whatever comes next. Consuming it lexes one
  token of raw text as code, and an unterminated one is reported as a lex error
  from the middle of a string.
- **Repositioning is legitimate because ParserState's whole cursor is `pos` plus
  the one-token `currentLex`.** Setting `pos` and priming with one `advance`
  puts the parser anywhere. Anything added to ParserState that is not derivable
  from those two breaks this, so keep the state that small.
- **A built string is libc, not std** - `strlen` / `malloc` / `memcpy` /
  `sprintf`, all in `codegen/instr_str.yoop`. The JS reference routes through
  std's `stringConcatAll` and `format.intToString`, which the bootstrap cannot
  reach until a 9-file slice of std compiles. Both bottom out in a raw malloc
  plus byte copying, so the observable result is the same, including that a
  built string ignores the allocator context. `codegen/template.yoop` is the one
  place that changes when std becomes reachable.
- **A diagnostic carries the FILE it was found in.** `Program.currentFile` is
  ambient, set by each pass as it starts a file, because the alternative is a
  path parameter on forty `reportError` call sites that all want the same
  answer. A bare `12:5` was already ambiguous across modules and became
  ambiguous within one.
- **A qualified type annotation resolves through the namespace's EXPORTS, and
  is checked FIRST.** `fs.DirIter` is never a type parameter, never
  `unsafe_ptr`, and never a primitive spelling, so `resolveTypeName` handles the
  qualified case before any of those - falling through would let an unlucky
  alias shadow something unrelated. After the lookup it rejoins the ordinary
  path, which is what makes `vec.Vec<int>[]` instantiate and take an array
  suffix with no extra code. The QUALIFIER rides in `strId` with `flagA` saying
  it is there, since pool index 0 is a real string.
- **An import binds the source module's SymbolId - the same integer, not a
  copy.** Type equality is `id == id`, so this is what makes an imported `Point`
  compare equal to the declared one instead of being a second nominal type. It
  also means an imported shell stays correct when pass C fills it, since filling
  re-SETS the arena slot the id already points at.
- **Every symbol is mangled `<moduleId>__<name>`,** because one LLVM module holds
  the whole graph and two yoop modules may each define `add`. `main` and `printf`
  are the only exceptions and are decided in one place (`codegen/mangle.yoop`).
  That carve-out is why a non-entry module declaring `main` is a typecheck error:
  two bare `@main`s would otherwise reach the linker.
- **A call is mangled against the callee's HOME module, under its EXPORT name.**
  `import { scale as times }` calls `times` locally and must emit
  `@mathx_1__scale` - using the local name emits a call to a symbol nothing
  defines. `TypedModule.importedFrom` carries both halves.

A program in this subset needs no yoop runtime - only libc - which is what keeps
the link step a single clang invocation. Linking the runtime arrives with the
first feature that needs it.

Tests live beside the module they cover as `*.test.yoop`, which is excluded from
the module's file list, so a test reaches its module through the same import
path a consumer writes:

    node ../src/yoopiler.js --test src/lex
    node ../src/yoopiler.js --test src/parse
    node ../src/yoopiler.js --test src/source_graph
    node ../src/yoopiler.js --test src/typecheck

`src/source_graph` is the one that reads files from disk: `tests/graph/` holds
programs whose import structure is the point, all of them refusals, plus the
`tests/slice/imports.yoop` diamond read back for its topological order.

## Parity with the JS reference

Each layer boundary gets a deterministic dump that both implementations emit in
the same format, and a harness that diffs them. Layer 1 is done:

    npm run test:parity

It compiles `tools/dump_tokens.yoop`, then diffs its output against
`src/dumpTokens.js` over `tests/parity/` plus every `.yoop` file in `std/`,
`bootstrap/` and `examples/` - 557 files today. To eyeball one file:

    diff <(node ../src/yoopiler.js FILE --dump-tokens) <(/tmp/dump_tokens FILE)

Three things the token dump deliberately does not compare, all documented in
src/dumpTokens.js: float values, int literals past 2^53, and non-ASCII spans.

**Layer 2 (AST) parity is not possible yet.** The two ASTs are not the same
shape: this side wraps variable-arity children in NODE_LIST nodes and makes type
annotations real AST nodes, while the JS parser uses plain arrays and a separate
annotation object. A parse dump has to normalize both into one tree before it
can be diffed - that is the next piece of parity work, and it should be designed
before the parser grows much further.


## Codegen readability rules

Bootstrap-specific, not general Yoop style. Codegen is the layer that turns
into unreadable string-append soup fastest, and it is the layer whose bugs are
hardest to spot by reading, so it gets rules of its own.

**Keep files in `codegen/` small and single-purpose** - roughly 150 lines. If a
file is doing two jobs, split it. `instr.yoop` is the one deliberate exception:
it is a flat catalogue of every instruction, and its value is that you can read
the whole IR surface in one place, so it grows by entries rather than splitting.

**Separate DECIDING from EMITTING.** Three layers, and a function belongs to
exactly one:

    expr.yoop / stmt.yoop   walk the AST, decide what should happen
    flow.yoop               the same, for `if` (block discipline lives here)
    loop.yoop               the same, for `while` / `for` / `for ... in`
    loop_stack.yoop         where break/continue jump
    array.yoop              array literals, indexing, `.len`
    call.yoop               call expressions
    switch.yoop             `switch` -> a jump table
    struct.yoop             struct literals, field read and write
    variant.yoop            variant constructors, tags, pattern bindings
    typedefs.yoop           the module-level struct type definitions
    instr.yoop              emit one LLVM instruction
    instr_mem.yoop          the same, for aggregates and computed addresses
    instr_flow.yoop         the same, for branches, labels, the jump table
    vocab.yoop              which opcode/predicate an operator lowers to
    context.yoop            the Cx, and the raw text appenders
    query.yoop              THE typecheck boundary - everything codegen asks
    mangle.yoop             what a symbol is CALLED in the emitted module
    template.yoop           template literals: parts -> one built string
    intrinsic.yoop          the calls that are not calls
    dispose.yoop            emitting what a scope owes
    dispose_stack.yoop      which bindings, which scopes, how far to unwind
    instr_str.yoop          the libc calls a built string is made of

There is no traits.yoop here, and that is the point: a method is an ordinary
function by the time codegen sees it, so it emits through the same path. All
traits cost this layer is a mangled name, in mangle.yoop.

The walking code should read as "load the local, then multiply" - if you can see
a quotation mark in `expr.yoop`, something is in the wrong file.

**Every IR-emitting function carries a sample of its output**, and is named for
the IR it produces rather than the AST it came from:

```yoop
//   %t4 = load i32, ptr %count.addr
export function emitLoad(ref cx: Cx, dest: usize, ty: string, slotName: string): void {
```

`emitLoad`, not `emitIdentExpr`. That sample IS the documentation - change the
format, change the sample.

**An instruction emitter takes decisions already made.** Operands and types come
in as arguments; it does no lookups, touches no AST, and makes no choices. That
is what keeps it readable at a glance and testable in isolation.

**Pass the `Cx`, not five arguments.** `context.yoop` bundles the emitter,
program, typed module, AST, and locals behind `ref` fields, so signatures stay
short and the one argument that actually varies is visible.

**No template literals on an emit path** - one malloc per instruction that
nothing frees. See section 3.1 of [../docs/writing_yoop.md](../docs/writing_yoop.md).

## What codegen reads from typecheck

The whole handoff is three things, and `context.yoop` is the only place that
touches it:

- **the AST** - the shape to walk
- **`typeOf(ref cx, nodeId)`** - the LLVM type pass D resolved for that node
- **`returnTypeOf(ref cx, name)`** - a callee's declared return type

Everything else on `Program` / `TypedModule` is typecheck's business. Codegen
does ZERO type-checking and is total on well-formed input: an internal-error
return means pass D let something through, never that the user made a mistake.

## Tests

Three levels, and the rule in ../CLAUDE.md says every change adds to whichever
fits. The point is that they survive the JS compiler being retired.

    node ../src/yoopiler.js --test src/lex        # yoop unit tests
    node ../src/yoopiler.js --test src/typecheck
    npm run test:slice                            # end-to-end executables
    npm run test:parity                           # layer dumps vs the JS side

A slice fixture is a program plus a hand-written `.expected` holding its stdout
and an `exit=N` line. The `.expected` is the source of truth: it is asserted
against the BOOTSTRAP first, and the JS reference is checked against the same
file as a bonus. Never capture one from compiler output.

## Layer 6 parity

`npm run test:slice` compiles every program in `tests/slice/` with BOTH
compilers and asserts identical stdout and exit code. That is the last check in
the contracts doc, and it exercises every layer at once.

One divergence found while setting it up, worth knowing because the bootstrap is
the one that is right: `printf("%d", 2 + 3)` is an error in the JS reference
("this expression still has an unpinned literal type"), which is the live sharp
edge 1.1 in plans/README.md. The bootstrap's pass D defaults an unconstrained
untyped int literal to int32, which is what the JS side still owes.
