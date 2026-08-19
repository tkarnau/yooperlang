# Self-hosted Yooperlang compiler

The Yooperlang compiler, written in Yooperlang. It compiles itself, and each of
its layer boundaries is cross-checked against the JavaScript reference in
[../src/](../src/).

The JS version is a REFERENCE, not something to transcribe. The point of doing
it again is clearer boundaries and less code, by leaning on language features
the JS version cannot use.

## Layers

1. Lexer -> token stream
2. Parser -> AST arena
3. Typechecker -> typechecked AST
4. Bytecode generator -> bytecode IR (not built; the numbering keeps its place)
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
                       float decoding, the lexer
      ast/             the arena: node kinds, ASTNode, AST, slot-name helpers
      parse/           layer 2: recursive descent, one file per construct.
                       derive*.yoop is the `@derive(display)` EXPANSION, which
                       lives here because it generates Yoop source and reparses
                       it into the same arena
      source_graph/    layer 0: Module / SourceFile / ModuleGraph, reading a
                       module's files, the import walk, path resolution,
                       module ids, finding the std root, and the std AUTOLOAD
                       (which two modules join every graph, and in what order).
                       Also where the derive expansion is RUN - see load.yoop
      typecheck/       layer 3: ids, Type, Symbol, Program, the passes.
                       pass_a/b/c walk DECLARATIONS and pass_d walks BODIES,
                       and that line is what context.yoop draws: a body check
                       takes one `ref cx: Cx` (tables, decoration, arena,
                       scope) the way codegen's walk does, while the
                       declaration passes keep their own parameters because
                       there is no scope during one.
                       pass_d.yoop is the DRIVER only; the walk it starts is
                       the check_*.yoop files beside it, one per shape of
                       thing being checked - stmt, expr, call, qualified,
                       access, literal, loop, switch.
                       async.yoop is `await` coloring, task.yoop the spawn's
                       half - `Task<T>`, the binding forms, `wait`;
                       kinds.yoop is what a `kind` DECLARATION is allowed to
                       say - sites, effect categories, composition, and the
                       two clauses that name a trait, kind_use.yoop where one
                       may be WRITTEN and where a field's TYPE carries one into
                       its holder, clearance.yoop who may move a value
                       across a marker, and markers.yoop what a value CARRIES
                       at every place it moves;
                       vtable*.yoop is type ERASURE - what a vtable's slots are
                       and what the three ways of using one mean;
                       diverge.yoop answers "does control flow always leave
                       this statement", for the handler form of `?`
      codegen/         layer 5: typed AST -> LLVM IR text (see the rules below)
      link/            layer 6: IR -> executable, by shelling out to clang;
                       also where the runtime's C sources are found, which glue
                       source a program gets for what it LINKS, and where clang
                       is told to LOOK (search_paths.yoop)
      test_mode/       `--test`: discovering `*.test.yoop` files, collecting
                       their suites, generating the entry module that hands the
                       table to std/test.yoop, and running what comes out
      utils/           sort and iteration helpers with no home in std yet, plus
                       float bit access - which lives here because BOTH lex (the
                       parity dump) and codegen (constants) need it, and utils
                       is the one module below both
    tools/             small entry points (dump_tokens)
    tests/parity/      corpus for the layer-1 parity harness
    tests/slice/       programs that compile all the way to an executable
    tests/graph/       import structures the source_graph tests load
    tests/testmode/    a small tree for the `--test` discovery tests: two
                       `*.test.yoop` files, a nested one, and a `.yoop` that is
                       not a test
    tests/codegen/     multi-MODULE programs the codegen tests emit but never
                       run - one `declare` per symbol is a property of the whole
                       LLVM module, so a single-file source literal cannot pose
                       the question

Dependencies run one way:

    diagnostics <- lex <- ast <- parse <- source_graph <- typecheck
                   ^
                   utils

There is no shared "contracts" or "types" file, and there should not be one. A
module is a DIRECTORY, so two concepts that reference each other sit in the same
module rather than being pulled apart into a third file. If you find yourself
wanting to add a "shared types" file, put the type with its owner instead.

`diagnostics` is the one module everything depends on, and that is legitimate:
it is a leaf, it depends on nothing, and every layer really does need to say
where in the source a problem is.

## Running it

Build it, and point it at a file:

    node ../src/yoopiler.js src/main.yoop -o /tmp/yoopiler_boot
    /tmp/yoopiler_boot tests/slice/hello.yoop -o /tmp/hello
    /tmp/hello

The whole command line:

    yoopiler_boot <entry.yoop> [-o <out>] [--emit-ir]
    yoopiler_boot --test <dir-or-file> [filter...]

    -o <out>    where the executable goes. The IR is always written beside it,
                as <out>.ll. Defaults to a.out.
    --emit-ir   stop after writing <out>.ll. No clang, no executable.
    --test      run the yoop test harness over a directory or one file, with
                any extra positionals as suite-name filters.

Flags may stand anywhere in the line, and an unrecognized option is refused BY
NAME rather than taken for an input file. `--emit-ir` is the bootstrap's own
spelling, not the reference's: the reference has `--keep-ir`, which keeps a temp
copy of the IR and still links, and there is no reference flag that stops before
clang. It exists
because most of what compiles a corpus file only wants to know whether codegen
succeeded, and the link is the expensive half - see the probe note below.

**`--test` is a DRIVER mode, not a language feature**, and `src/test_mode/` is
all of it: glob `**/*.test.yoop` below the path, collect each file's
`suite`-kinded functions, generate an entry module holding a `main` that hands
the table to `std/test.yoop`, compile that through the ORDINARY pipeline, and
run it. There is no test-mode typechecker and no second codegen path - the only
thing test mode adds is an entry module nobody wrote. The binary is an artifact
of the run rather than of the project, so `-o` does not name it: it goes to the
temp directory and is removed on the way out, and the run's exit code is the
failure count `std/test.yoop` returned, which is what lets CI gate on the
command directly. Discovery walks in SORTED order, because suite order is report
order and an unsorted walk would renumber the TAP output between runs.

### Running the tests

    node ../src/yoopiler.js --test bootstrap/src            # all 965, one build
    node ../src/yoopiler.js --test bootstrap/src/typecheck  # one module
    npm run test:slice                                      # executables
    npm run test:parity                                     # layer dumps vs JS
    npm run test:selfhost                                   # the three stages

**Prefer the whole-tree form.** `--test bootstrap/src` builds the module graph
ONCE and runs every module's suite out of one binary; the five per-module
commands build it five times, and measured on a 14-core M-series machine that is
8.2 seconds against 14.9. Reach for the per-module form when you are iterating
on one module and want the shorter feedback loop, not as the default.

## It compiles itself

Point it at its own source and it builds a compiler, and that compiler builds an
identical one:

    node ../src/yoopiler.js src/main.yoop -o /tmp/stage1     # the JS reference
    /tmp/stage1 src/main.yoop -o /tmp/s2/yoopiler            # itself
    /tmp/s2/yoopiler src/main.yoop -o /tmp/s3/yoopiler       # itself again
    cmp /tmp/s2/yoopiler /tmp/s3/yoopiler                    # byte-identical

stage2 and stage3 are byte-identical, as binaries and as emitted `.ll`. That is
the FIXPOINT: both were built by a compiler whose source is the same, so any
difference between them would mean stage1 and stage2 disagree about how to
compile something. `src/selfhost.test.js` runs the whole three-stage build on
every `npm test`, in about 16 seconds.

The two stages go to different DIRECTORIES with the same BASENAME on purpose:
clang embeds the output path in the Mach-O and in the code signature covering
it, so `-o stage2` versus `-o stage3` differ in 49 bytes that say nothing about
the compiler.

Working rather than merely byte-stable, checked three ways. The whole slice
suite runs through stage3 (`YOOP_BOOT_COMPILER=<path> npm run test:slice`). The
surface probe produces a byte-identical report from stage1 and stage3 - the same
files with a `main`, the same no-main libraries, the same refusal sites, the
same messages in the same order. So does the PROGRAM probe:
`scripts/probe_programs.sh` builds every example entry point with both
compilers, runs both binaries, and its stage1 and stage3 reports are
byte-identical line for line, which is a stronger statement than the surface
one because these programs RUN.

The fixpoint is what catches a miscompile the rest of the tree cannot reach: a
disagreement between stage1 and stage2 about how to compile something shows up
as a byte difference and as nothing else. A variant-typed struct FIELD compiled
as a variant CONSTRUCTOR, and a max-value `usize` sentinel the JS reference
wraps to zero, are two such - see the invariants below.

## What it can compile today

Everything outside the subset is refused BY NAME - "pass D does not handle X
yet", "unsupported extern ABI" - rather than mis-compiled.

  * top-level `function` decls, called from each other
  * `type` decls with fields
  * `let` / `const` locals, with an annotation or inferred from the initializer
  * function PARAMETERS, readable in the body and passed at call sites
  * assignment to a local (`x = expr`)
  * `if` / `else if` / `else`, `while`, and `for (let i = 0; i < n; i = i + 1)`
  * `for x in xs { ... }` over an ARRAY - the iterable is evaluated once, and
    the loop variable is a copy of each element, bound to the element type and
    scoped to the loop.
  * `for x in it { ... }` over a type implementing `Iterable<T>` - a SECOND
    lowering rather than a variation, because there is no length to count
    against: call `next`, test the tag against `Yield`, read the payload, run
    the body. The ELEMENT type is whatever `Yield { value: T }` carries, read
    off `next`'s return type rather than off the `Iterable<T>` application,
    which is what keeps it in step with the payload gep. `next` is an ordinary
    STATIC trait dispatch - the receiver is concrete - so nothing here
    instantiates a trait as a value and nothing here is a vtable.
    The iterator is SPILLED to a slot, because `next` takes `ref self` and there
    is nothing to borrow from a loaded value, so the walk advances a COPY: a
    `DirIter` does not care (its state is behind a handle) and a `MapIter` does
    (its cursor is inline, so the local the loop was given is left at 0). Same
    as the reference. A `next` that does not return a two-case `Yield`/`Done`
    variant is refused BY NAME.
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
    word - except four. `pausable` makes the function a COROUTINE (see `async`
    below); `provides Task` on top of it makes it a `task`, whose call site is a
    SPAWN; and on a BINDING, `refcounted` and `mustCall` are what pick where a
    task handle lives and how it is released (see `task` below).
  * `async` and `await` - REAL LLVM COROUTINES:

        async double(x: int32): int32 { return x * 2; }
        async outer(n: int32): int32 { return await double(n); }

    An `async` function lowers to a switched-resume coroutine:
    `define ptr @m__double(i32 %x.arg, ptr %__ret) presplitcoroutine`. It hands
    back its HANDLE rather than its result; the result goes through `%__ret`, a
    slot the CALLER owns, which is what keeps it alive across the caller's own
    suspends. A `void` async function takes the slot too and never writes it, so
    there is one ABI rather than two. There is NO INITIAL SUSPEND - calling one
    runs it eagerly to its first real suspend point, so a call that never blocks
    costs one frame allocation and no resume at all.

    `await g(args)` allocates the result slot in the CALLER's frame, calls the
    callee, and then drives it: test `coro.done`, and if it is not finished
    suspend THIS frame too, resuming the callee each time the scheduler resumes
    us. That loop is the whole feature - it is what carries a suspend four
    frames down back up to the task body, and it is why the runtime only ever
    holds one handle per task rather than tracking the interior of a call chain.

    Three COLORING rules, the reference's unchanged, and between them they are
    what makes a suspend safe: `await` only inside a function carrying a
    pausable kind; its operand must be a CALL to one; and such a function must
    be called through `await`. So there is no way to reach an async function
    except from inside another one. A `task` CALL is carved out of the third
    rule, because a task's call site is a spawn rather than a drive - the
    reference makes the same carve-out.

    Asyncness rides on the FUNC TYPE rather than in a side table, which is what
    makes it work cross-module and through a method table, and being part of
    interning is what makes a sync impl of an async trait method a type
    mismatch. `async` methods, imported async functions and `ns.f(...)` all
    work. `await intr.suspendNow()` is the suspend PRIMITIVE - a bare
    `coro.suspend` with no callee to drive, and the one line everything in std
    that parks a task is built on.

    What is NOT built, and refused BY NAME: an INDIRECT async call through a
    function value or a vtable slot.
  * `task`, `wait`, and the SPAWN - the other half of concurrency, and the one
    that makes async runnable at all:

        task compute(x: int32): int32 { return x * x; }

        const a: int32 = compute(3);   // spawn, join here, bind the result
        joined d = compute(4);         // stack handle, joined at scope end
        pooled h = compute(5);         // heap handle, refcounted
        const v: int32 = wait h;       // join, and read the result slot

    A task call is NOT a call. It fills in a HANDLE, hands it to the scheduler
    in runtime/yoop_runtime.c, and evaluates to `Task<T>` while the body still
    returns T. `wait h` blocks until the handle's state byte flips and reads
    the result. Between them they are the only bridge from ordinary code into
    async: `main` cannot be async and a coroutine is reachable only through
    `await`, so without a task there is no way to run one at all.

    The HANDLE's layout is a contract in BYTE OFFSETS, because the C runtime
    reaches its prefix through `(char*)h + 16` and friends - a field in the
    wrong place is a corrupted mutex rather than a link error:

        %Task_m__compute = type { ptr, i8, [3 x i8], i32, ptr, ptr, ptr, ptr, i32, i32 }
        ;   0 thunk   8 state   9 pad(cancel,park)   12 refcount   16 mutex
        ;  24 cond   32 coro handle   40 allocator ctx   48 result   56+ args

    One struct per task FUNCTION rather than per result type, matching the
    reference: the arguments ride in the handle, so two tasks returning `int32`
    with different parameters are two layouts.

    Each task also gets a THUNK - what a worker thread actually calls, since
    the body is a coroutine whose arguments live in the handle. It hands the
    body the handle's OWN result slot as its `__ret`, so a finished coroutine
    has already written the result where `wait` looks, with no copy. It STARTS
    the coroutine and returns; `yoop_task_settle` decides whether that step
    finished or merely parked, which is what lets a task blocked on I/O give
    its worker thread back.

    `main` opens with `yoop_runtime_init` plus `yoop_runtime_set_coro_ops`
    (handing the scheduler three emitted trampolines around `llvm.coro.*`,
    which C cannot call) and closes with `yoop_runtime_shutdown` before every
    `ret`. Which of the three BINDING forms applies is read off the kind's
    CLAUSES rather than its name - `refcounted` means pooled, `mustCall` means
    joined - because a `Task<T>` has no methods for either clause to name, so
    the compiler is the only thing that can honor one.

    `Task<T>` is spellable in an ANNOTATION too, as a builtin generic name the
    way `unsafe_ptr<T>` is: nothing declares it, so the spelling IS the type.

    Refused BY NAME, each because emitting it would compile and then be wrong: a
    CROSS-MODULE spawn (the handle layout and the thunk belong to the module
    that declared the task, and the reference refuses it in the same place), a
    task call outside a handle binding (`worker(1);` on its own would run the
    body on this thread), copying a handle into a second binding
    (`pooled b = a;` needs a refcount retain, and one without it is a
    use-after-free), `wait` inside a TASK body (it would block a worker, which
    is the thing coroutines exist to avoid - `await` is the in-task form, and a
    plain `async` function may still `wait`), a `task` METHOD, `task main`, and
    a task returning void.
  * `propagates<disposable>` clauses, on a function (after the return type), a
    `type`, or a `variant` (after `implements`). Not optional for self-hosting -
    the bootstrap's own source carries 48 of these across 25 files.
    On a FUNCTION it is parsed and recorded and nothing enforces it. On a TYPE
    it MEANS something: see PROPAGATED DISPOSAL below.
  * char literals - `'a'`, `'\n'`, `'\''` - in expressions and switch patterns
  * `extern "intrinsic" from "compiler" { ... }` - operations the COMPILER
    implements. Thirteen are lowered: `stringAsBytes`,
    `bytesAsStringUnchecked`, `stringFromBytesUnchecked`, `arraySlice`,
    `heapAlloc`, `heapFree`, `ctxAlloc`, `ctxFree`, `suspendNow`, and the four
    `Task<T>` ones - `waitUntil`, `cancel`, `armComplete`, `isDone`. The generic
    ones infer their type argument through the same path every generic function
    uses, which is why NONE of the four needed a special case in the
    typechecker: `waitUntil<T>(h: Task<T>, deadline_ns: uint64): WaitResult<T>`
    infers T from the handle and instantiates `WaitResult<T>` like any other
    generic variant. The reference has a hand-written resolver per intrinsic
    instead; the one thing missing here was a `Task<T>` case in `inferTypeArgs`,
    beside the ones for `T[]` and `ref T`.

    `waitUntil` is the only one with shape. The runtime answers with an i32 -
    0 done, 1 timed out, 2 cancelled - and the language hands back a three-case
    variant, so the lowering is a jump table with one arm per case; only the
    `Done` arm reads the task's result, out of byte 48 of the handle exactly as
    `wait` does. The DEFAULT arm lands on `Cancelled` rather than on an
    unreachable block, matching the reference: an outcome the runtime grows
    later reads as "this task is not going to produce a value", which is the
    safe reading of any extension.

    An intrinsic NAME is an ordinary identifier, so being one somewhere in the
    graph does not make every call to it one. `std/tls/ffi.yoop` exports an
    ordinary `ctxFree(ref c: TlsCtx)` beside the allocator's
    `ctxFree<T>(a: T[])`. A call is the intrinsic when it is QUALIFIED
    (`intr.ctxFree(xs)` reaches whatever that namespace exported) or when THIS
    module wrote the `extern "intrinsic"` block; anything else is an ordinary
    call. A module that reached an intrinsic some other way and then called it
    unqualified gets a link error rather than a wrong answer, and nothing in
    std, examples or bootstrap does that - a std value import has to come
    through a namespace.
  * generic TRAIT declarations (`trait Joinable<T> { function join(ref self): T; }`)
    - the parameters are in scope while the signatures resolve. Applying one
    works: a BOUND (`T implements Comparable<T>`) and an `implements` clause
    (`type Token implements Comparable<Token>`) both substitute the trait's own
    parameters through its method signatures.
    The two things that read as "dispatching through an applied trait" -
    `Iterable<T>` in a `for ... in`, and `Into<E>` for `?` - work, and NEITHER
    needs a trait as a value: the receiver is concrete at every call site in the
    corpus, so each is an ordinary static dispatch. A trait as a RUNTIME value is
    the vtable erasure below, and is the only shape that needs one.
  * function types - `(k: string) => uint64` - as struct fields, parameters and
    locals. A named function is a value of its own signature, so
    `{ hash: myHash }` needs no conversion, and a call through a field is an
    indirect call. Parenthesized type GROUPS come with them, since
    `((k: K) => V)[]` is the only way to spell an array of them.
  * `unsafe_ptr` / `unsafe_ptr<T>` and `null`, gated on `import.unsafe;`. A
    typed pointer widens to the opaque one and not back; `null` fits any raw
    pointer and nothing else. The `c_*` names are LP64 aliases, not types.
  * `vtable Name for Trait { m: (args) => R, }` - declared, laid out, and BUILT.
    Type erasure, in all three of its spellings:

        vtable Dispatcher for Handler { handle: (req: int) => int, }

        let d: Dispatcher = Dispatcher.from(ref h);   // erase a concrete value
        let p: PredVT = PredVT.fromFn(isDigit);       // erase named functions
        Dispatcher.handle(ref d, 10);                 // dispatch indirectly

    A vtable value is `{ ptr ctx, ptr m0, ptr m1, ... }` - the erased receiver
    followed by one function pointer per slot. That leading ctx is the whole
    trick and the reason a vtable is not a struct: a method already takes
    `ptr self` first, so the CONCRETE method symbol is directly usable as the
    erased one and `from` emits no thunk at all. Dispatch loads ctx out of slot
    0 and passes it where `self` goes.

    `fromFn` has no receiver, so ctx is null and each slot holds a generated
    ctx-dropping SHIM around a named function. One shim per target symbol, since
    two defines of one name is an invalid redefinition rather than a duplicate.

    An ASYNC slot works: `await Reader.read(ref r, ref buf)` is an indirect call
    to a coroutine, driven by the same loop a direct `await` uses. Asyncness
    rides on the slot rather than on the `=>` annotation - a `=>` type is never
    written `async`, so the TRAIT is stamped onto the slot in pass C and the two
    sides cannot drift. That is the reference's rule and its reason.

    Both `VTableName.method(ref vt, ...)` and `Trait.method(ref vt, ...)`
    dispatch, and they are the same call: a function handed a `Reader` and
    nothing else has only the trait's name to write, which is what
    `std/core/traits.yoop`'s consumers do.

    `Type.VTable` carries the trait it erases, the slot types and the slot
    ORDER, which is what both the builder and the dispatch read. A vtable is
    `%vtable.mod__Name` in the IR, its own namespace rather than `%struct.`.

    One DIVERGENCE from the reference, and it is unobservable. The slot ORDER is
    the VTABLE's own declaration order and not the trait's: the reference can
    use the trait because a JS Map iterates in insertion order, and the
    bootstrap's `Map` is a hash table with no order to read. A vtable value
    never leaves the program that built it, so nothing can tell.

    Every slot is checked against the trait's method
    of the same name with `ref self` stripped: a missing slot, an extra one, a
    wrong arity and a wrong return type are each refused BY NAME at the
    DECLARATION, because getting one wrong is a call through a mismatched
    signature rather than anything a verifier catches. So are a by-value
    receiver (`VT.from(x)` - the vtable stores an ADDRESS), a receiver whose
    type does not implement the trait, a member that is not a slot, and a
    `fromFn` argument that is not a named function.
  * array slices - `xs[a..b]`, `xs[a..]`, `xs[..b]`, `xs[..]` - half-open, and
    a borrowing VIEW rather than a copy
  * bitwise `& | ^ << >>`, with the opcode chosen from the OPERAND's
    signedness (`ashr` vs `lshr`, and `sdiv`/`udiv` alongside them), and `~` -
    PREFIX only, so unlike `&` and `*` it needs no position rule. It keeps the
    operand's integer type, lets an expectation flow down into an untyped
    literal (`let w: uint8 = ~0` is 255), and takes an int-backed value ENUM as
    the integer it is (`~Flags.A` is a Flags). A bool, a float, a string, a
    struct and a string-backed enum are refused with the reference's own
    message, word for word.
  * `unsafe_ptr.cast<T>(p)`, `.toInt(p)`, `.fromInt<T>(n)` and
    `.toArray<T>(p, n)`, and pointer ARITHMETIC. `unsafe_ptr` is a TYPE NAME
    rather than a namespace, so the four are recognized by TEXT - there is
    nothing to resolve the left side against - and an `unsafe_ptr` followed by
    any other member is an ordinary identifier. Three of them cost between zero
    and one instruction, because LLVM pointers are OPAQUE and `cast` is a change
    of type; `toArray` builds the same `{ ptr, i64 }` descriptor a slice does,
    so what comes out is an ordinary `T[]`. The arithmetic follows C: `p + n`
    steps by ELEMENTS (a gep, so no size to compute), `p - q` is the element
    COUNT (ptrtoint, sub, sdiv), and the opaque pointer is refused throughout -
    it has no element width. `uintptr` is an LP64 alias for `uint64`.
  * `&x` and `*p` - address-of and dereference, gated on `import.unsafe;`.
    Not `ref x`: `&` yields an `unsafe_ptr` with none of a borrow's guarantees.
    `*p = v` stores through the pointer.
  * `s.len` on a string - the BYTE length, one `strlen` - and `xs.ptr` on an
    array, its data pointer
  * a BORROW held as a value - a `ref T` struct FIELD, and a local bound from
    one. It reaches its fields, its elements and its `.len` exactly as the thing
    it borrows does, and it opens (one `load`) wherever a plain `T` is wanted.
    `ref x` written out never opens itself, which is what keeps the call site
    honest about what may be written through.
  * kind prefixes on a METHOD (`async handle(ref self, ...)`) and on a
    PARAMETER (`function use(scoped h: ref FileHandle)`). A method takes any
    number and may write the `function` keyword alongside them; a parameter
    takes exactly ONE, which is the reference's rule.
  * a kind prefix BESIDE the `function` keyword at TOP LEVEL, not only instead
    of it:

        async fetch(u: string): string { ... }        the prefix REPLACES it
        suite function addsNumbers(): void { ... }     both, which is also legal

    Three spellings and all three are the reference's - the third is how every
    `*.test.yoop` in this tree declares a suite. Both the top level and a type's
    member run go through ONE prefix-run parser (`parse/kind_prefix.yoop`),
    which is what keeps them from drifting: they had, and `suite function f()`
    was "unexpected token at top level: IDENT" on a perfectly well formed
    declaration. `parseKindPrefixes` in `parse/types.yoop` is a different job
    and deliberately does NOT do this - in an ANNOTATION position
    (`owned string`) a following `function` keyword means the annotation ended.
  * `extern "C" from library "m"` - the LINKING form of the `from` clause. The
    names are collected graph-wide and lower to `-lm` on the clang line, beside
    `-framework NAME` on macOS and the `ssl`/`crypto` pair. The bare-string form
    (`from "stdio.h"`) is a HEADER name and lowers to nothing.
    Where clang LOOKS for them is `link/search_paths.yoop`: `-L` and `-I` for
    `YOOP_LIB_PATH` / `YOOP_INCLUDE_PATH` first, then the conventional install
    prefixes, then the KEG-ONLY OpenSSL ones by name - which is the only way an
    https program finds libssl on macOS, since Homebrew refuses to shadow the
    system LibreSSL. The reference branches on `process.platform` and
    `process.arch`; the bootstrap has neither, so every candidate from every
    platform is offered and `fs.exists` decides.
    A program that named `ssl` or `crypto` also gets `yoop_tls.c` compiled into
    it - it is excluded from the set every program gets, because it includes
    `<openssl/ssl.h>` and putting it in would make OpenSSL a build requirement
    for hello world.
  * SHADOWING: a nested block may declare a name an enclosing one already has,
    and the outer binding snaps back at the closing brace. Redeclaring a name in
    the SAME block is still refused. Two different questions, and separating
    them is the whole feature - a `for` head is its own scope too, so
    `let i = 99; for (let i = 0; ...) { }` leaves `i` at 99. Both halves matter
    at run time rather than only in the checker: an inner binding gets its own
    alloca either way, so a compiler that forgets to restore the outer NAME
    emits valid IR that reads the wrong slot forever after.
  * `a..b` - a half-open integer RANGE, and it is sugar rather than a loop form.
    The parser lowers it to `$range.exclusive(a, b)` from std/core/range.yoop
    and prepends a namespace import for that module, so `Range` stays an
    ordinary userland type implementing `Iterable<usize>` and the loop that
    walks one is the same `for ... in` any other iterator gets. `..` binds
    looser than arithmetic (`1..n - 1` is `1..(n - 1)`), and a SLICE's bounds
    are parsed at that same precedence, which is what keeps `xs[a..b]` a slice
    rather than an index by a range.
  * a kind-prefixed binding that OWNS a block -
    `disposable reg: ArenaScope = arenaScope(4096) { ... }`. The block IS the
    binding's scope: the name is visible inside it, gone after it, and whatever
    the kind asks for at scope end fires at the closing brace.
  * `ref x.f`, `ref a.b.c`, `ref xs[i]` and `ref xs[i].f.g` - a borrow of a
    FIELD at any DEPTH, of an array ELEMENT, and of a field path bottoming out
    in one. The rule is where the path BOTTOMS OUT rather than how deep it goes:
    a name has an address and so does an element, while `ref f().x` does not -
    the temporary is gone before anything could point at it - and that one stays
    refused by name. Depth costs nothing because `emitFieldAddress` already
    recursed through a nested base for `a.b.c = v`; an element base is the same
    two-step with a gep on the descriptor's data pointer as its first half.
    Reading and WRITING agree (`xs[i].f.g = v` works too), which they have to:
    the two go through one address walk, so one being legal and the other not
    would be an inconsistency with no reason behind it.
  * `type NodeId = usize;` - a TRANSPARENT type alias. The name resolves to the
    RHS's own TypeId and NO type is interned for the alias, so `NodeId` and
    `usize` are one type, interchangeable in both directions, and equality stays
    `id == id`. Resolution is LAZY, so an alias may name one declared further
    down the file; pass C forces every alias in a module while that module's AST
    is the one in hand, which is what lets another module read it later without
    resolving a node id against the wrong arena. A cycle (`type A = B; type B =
    A;`) is refused by name rather than hung on, and a GENERIC alias
    (`type Pair<T> = Box<T>;`) is refused by name too.
  * methods on GENERIC types, emitted one copy per instantiation
  * `ctxAlloc` / `ctxFree` and the `errno` bridge, which LINK the yoop runtime
  * SCOPE-END DISPOSAL, in all three forms:

        disposable ids: Vec<NodeId> = vec.vecNew(4);   // a binding
        ephemeral arenaScope(N) { ... }                // an anonymous region
        ephemeral makeGuard(1);                        // the IMPLICIT region

    A kind carrying `mustCall <method> beforeScopeEnd` names the method; the
    call fires on every way out of the scope - the closing brace, an early
    `return`, a `break` or `continue` - in REVERSE declaration order. Nothing is
    hardcoded to `disposable`: the call is an ordinary static trait dispatch,
    and a user's kind gets the same treatment.

    The two region forms differ in what the region OWNS. With braces it owns the
    block and its call fires at the closing `}`; with a `;` it owns the rest of
    the ENCLOSING scope, so it opens no scope of its own and records into the
    one already open - which is what makes two of them in a row unwind in
    reverse, exactly like two bindings.

    A COMPOSED kind carries what its operands carry:

        kind scoped_alt = disposable_base & { mustNotEscape scope; };

    Both operand shapes work - a NAME, and an inline `{ ... }` body, which is an
    anonymous bag of clauses with no name to look up - and pass A merges each
    named operand's registered clauses in. That merge is not cosmetic: without
    it a `scoped_alt` binding promised a scope-end call and emitted NONE, which
    is a leak that compiles rather than anything a probe could see. An operand
    nothing declares is refused by name.
  * PROPAGATED DISPOSAL - `disposable e: Emitter` where `Emitter` has no
    `dispose` of its own but declares `propagates<disposable>`. The clause says
    the obligation belongs to the FIELDS, so the scope-end call is one call per
    field that supplies the kind, made on that field's own type with a gep in
    front of it:

        type Emitter propagates<disposable> { globals: Text, body: Text, ... }

        %t1 = getelementptr inbounds %struct.c__Emitter, ptr %e.1.addr, i32 0, i32 0
        call void @text__Text__dispose(ptr %t1)

    A field supplies the kind when its own TYPE propagates it, which is how
    `Text`, `Vec<T>` and `Map<K, V>` reach one; a `usize` field supplies nothing
    and is skipped. Order is reverse DECLARATION, matching every other disposal.
    The kind rides on `NominalDecl` and is stamped in pass A / pass C, because
    both readers - pass D and codegen - stand in a different module from the
    declaration and have no access to its arena. ONE kind is recorded, not a
    list: `propagates<disposable, tainted>` keeps only the first, mirroring the
    "first prefix that asks wins" rule the binding side already has.
    Two refusals BY NAME, both where the reference emits a call to a symbol that
    does not exist: a field whose type propagates the kind but has no such
    METHOD (chaining through a second level is a real feature and is not built),
    and a propagating type with NO qualifying field at all (the clause promised
    a cleanup that would emit nothing, which is a leak that compiles).
  * module-level `let` - a MUTABLE GLOBAL, with a literal initializer. Distinct
    from a module `const`, which is inlined and has no storage to write to.
  * a function value held in a LOCAL, called through its name
  * `break` and `continue`, and a SWITCH is a breakable scope exactly as a loop
    is. The two are NOT symmetric, which is the reference's rule and the reason
    two counters and two frame kinds exist: `break` leaves the innermost
    breakable thing, a switch or a loop, and `continue` looks straight past any
    switch to the enclosing LOOP and is refused with none. A `break` at the end
    of an arm is decorative - arms do not fall through - and legal.
  * `while (true)` whose every exit is a `return`. A loop does not normally
    count as terminating (the condition may be false on the first test), so a
    function with no `return` after such a loop would be refused for having no
    return on some path. The LITERAL `true` with no `break` out of it is the
    exception, and it also branches unconditionally into the body: naming the
    exit block in a `br i1 true` would keep a label alive that is then never
    defined. `while (1 == 1)` is not folded - that needs comptime.
  * comparisons `== != < > <= >=`, and `&&` / `||` with real short-circuiting
  * `true` / `false`, unary `-` and `!`, parenthesized grouping
  * compound assignment (`x += 1`), including in a `for` step, on a name, a
    field PATH (`cx.loops.frames.len -= 1`), or an ELEMENT whose subscript is
    itself a name or an integer literal (`xs[1] += 100`,
    `w.sectors[i].ceiling += 2`). The forms desugar to
    `target = target <op> value`, which names the target TWICE, so the rule is
    about what is free to READ twice rather than about what is assignable.
    `xs[f()] += 1` stays refused by name - it would call `f` once to read and
    again to write.
  * nested field paths - `a.b.c = v` reads and writes, at any depth, as long as
    the path bottoms out in a named binding
  * arrays: `T[]` annotations, `[a, b, c]` literals, `xs[i]` read and write,
    `xs.len`, and passing an array to a function
  * integer casts (`usize(n)`, `int8(x)`)
  * `switch` over an integer, with multi-pattern arms and a required `default`,
    and over a BOOL - which is its own scrutinee kind rather than a one-bit
    integer, because two values means `case true` beside `case false` covers
    everything and the default arm becomes optional. A default BESIDE both
    cases is allowed (the opposite of the variant rule, and the reference's
    behaviour). The two spellings do not mix in either direction: `case 1:`
    against a bool and `case true:` against an int32 are both refused
  * structs as VALUES: `{ x: 1 }` literals, field read and write, passing and
    returning by value
  * generics: generic `type`, `variant` and `function` decls, monomorphized on
    demand. Types take explicit arguments (`Box<int>`, `Result<int, string>`,
    `Vec<Map<string, TypeId>>`); a function's are INFERRED, from the arguments
    first and then from the expected type - which is the only source when
    nothing but the return type mentions the parameter (`nothing(): Maybe<T>`).
  * type-parameter BOUNDS, on a generic `function`, `type`, `variant` or
    `trait`:

        function quickSort<T implements Comparable<T>>(arr: T[], lo: usize, hi: usize): void
        function summarize<T implements (Renderable, Named)>(ref t: T): int32

    A bound is a PROMISE: the body may call the bound's methods on the opaque
    parameter, and every instantiation is checked to keep it - at a generic
    CALL and at a generic type ANNOTATION alike. A type parameter satisfies a
    bound its own bounds cover, which is what lets one bounded generic call
    another. PARENTHESES are what make a comma belong to the bound list: a bare
    comma separates type PARAMETERS, so `<X implements A, B>` is a bounded X
    beside an unbounded B. A bound naming a GENERIC trait applied to the
    parameter itself (`Comparable<T>`) substitutes the trait's own parameter,
    so `Comparable.compare(ref a, b)` checks `b` against `T`. Not a trait, not
    declared, or the wrong number of type arguments are each refused by name.
  * `variant` decls, their constructors and their switch patterns:

        variant Shape { Circle { r: int }, Rect { w: int, h: int }, Empty }
        const c: Shape = Shape.Circle { r: 2 };
        switch (s) {
          case Shape.Circle { r: r }: { return r; }
          case Shape.Rect { w: w, h: h }: { return w * h; }
          case Shape.Empty: { return 0; }
        }

    A switch over a variant is exhaustive or has a default, never neither and
    never both, and a pattern BINDS its payload into the arm. A payload field
    may be written SHORTHAND - `case Shape.Circle { r }:` is `{ r: r }` - and
    the two spellings land in the arena identically.

    `==` and `!=` on two variants compare TAGS and nothing else, matching the
    reference: two `Circle`s with different radii are equal, and a structural
    comparison is what `switch` is for.
  * value `enum` decls, their cases and their switch patterns:

        enum Severity { ERROR, WARNING }
        enum Flags<uint8> { A 1, B 2, AB A | B }
        enum Level<string> implements Display {
          Info "info", Warn "warn",
          function toString(ref self): string { ... }
        }

    A value enum is a NOMINAL ALIAS over a primitive - any int width or
    `string` - with named compile-time constants of it, so it is much smaller
    than a variant: no tag, no payload, no layout. A case's value is written by
    JUXTAPOSITION (`A 1`, never `A = 1`) and may be an int or char literal, a
    PRIOR case by bare name, or `| & ^ << >>` over those; anything else is
    refused by name. An implicit case is the previous case's VALUE plus one.
    `Color.Red` is the only spelling of a case - a bare `Red` is not in scope,
    and `ns.Color.Red` is the same gap `ns.Variant.Case` has. There is no
    implicit conversion in either direction here: `int32(c)` casts out and
    nothing casts in. Equality works on both backings, ordering and the bitwise
    family on an int-backed one, arithmetic on neither. A switch over an
    int-backed enum is exhaustive-checked, and over a string-backed one is
    refused by name.

    A FOURTH DIVERGENCE, measured by the program probe: the reference DOES
    coerce an enum to its underlying primitive at an ARGUMENT position.
    `SDL_Init(flags)` against `function SDL_Init(flags: uint32);` with
    `flags: InitFlags` compiles there and is refused here by name, `argument 1
    of "SDL_Init" is uint32, not enum InitFlags`. Left refused, because refusing
    is the safe direction - a program the bootstrap accepts means the same thing
    on both sides - and one playground file wants it.
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
  * DISPLAY dispatch in interpolation - `${p}` on a type carrying
    `toString(ref self): string` becomes a CALL, and the method renders. Having
    the METHOD is the test rather than naming Display: there are no inherent
    methods, so a `toString` is one some trait required. The RETURN is checked,
    because the result is spliced straight into a string buffer.
  * template literals, including `${...}` interpolation:

        `${tagName(kind)} at ${line}:${col}`

    Strings, integers of every width, floats and bools can be interpolated; a
    struct is refused by name, pointing at the interpolation. A template with
    no interpolation does not allocate - it is a string literal wearing
    backticks.
  * FLOATS - `float32` / `float64`, and `float` as an alias for `float32`:

        const a: float64 = 1.5;
        const f: float32 = 0.125;
        printf("%f %d\n", a * 2.0, int32(a));

    A literal is untyped until context pins it and defaults to float64
    unconstrained, the mirror of how an int literal defaults to int32. Nothing
    mixes: not the two widths, not a float with an int, and not an untyped int
    literal with a float slot - `const a: float64 = 2;` is an error and `2.0`
    is what it wants. Arithmetic is `+ - * / %` (`frem` is real), comparison is
    the ordered `fcmp` family, and the bitwise family is refused by name. Casts
    convert in every direction between the numeric primitives; a bool is not
    one. `printf` promotes a float32 to a double at the call, and an
    interpolated float renders through `%g`.
  * `return`, with or without a value
  * int literals, string literals, `+ - * / %`
  * calls, including the `printf` builtin. A call's arguments are checked
    AGAINST the callee's parameters - right number, right types - and each one
    is checked against its own parameter, which is what pins an untyped literal
    to it (`wide(7)` gives the 7 an int64). The undeclared `printf` is the
    exception, and only when it is undeclared: with nothing to check against, it
    takes whatever it is given. A module that writes its own extern for it gets
    that signature checked like any other.

    A `printf` with NO varargs whose format is not a compile-time constant is
    rewritten to `printf("%s", <it>)` - see `codegen/printf_format.yoop`. C
    reads the first argument as a FORMAT, so a string the program BUILT has
    every `%` in its DATA read as a conversion pulling a vararg nobody pushed;
    measured on `examples/pass/http_url_smoke`, `encode=a%20b%2Fc%3Fd%3De`
    printed as `encode=a                   b0.000000c0.000000d8776975808e` and
    that last number was a stack address. The test is the lowered OPERAND rather
    than anything syntactic: `Operand.StrRef` IS "a module-level string
    constant", which is what a string literal and a template with no
    interpolation both lower to. A call WITH varargs is never rewritten, because
    that is the author using it as a format.
  * `export "C" function add_one(n: int32): int32 { ... }` - a definition
    emitted under its bare C name. It asks the mangler the same question an
    `extern "C"` does from the opposite direction, so it gets the same answer:
    the name is recorded per MODULE, which is what makes a SIBLING file of a
    directory module emit the same unmangled symbol the declaring file does.
    A cross-module CALL to one still mangles and fails to link, exactly as it
    does in the reference. `export "intrinsic" function` is refused by name.
  * `type FILE;` inside an `extern` block - an OPAQUE type, which is a struct
    with an EMPTY field list. Not a placeholder: a type with no fields is
    precisely a type nothing can read a field out of. Every use is behind a
    `ref`, and `ref` on something that IS one is a RE-borrow rather than a
    second one - `let fp: ref FILE = fopen(...); fclose(ref fp);` hands over one
    address, because `ref ref T` is not a type. The reference accepts `ref r`
    and a bare `r` into the same slot and writes through to the same object
    either way.
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
  * `...` as the LAST parameter of an `extern "C"` signature -
    `function printf(fmt: string, ...): int32;`. A call to one checks its FIXED
    parameters exactly as any other call's are and accepts any number of
    arguments past them, promoting each per C's default argument promotion. It
    may be the only parameter (`function weird(...): int32;`). It is refused by
    name anywhere else a parameter list appears - an ordinary function, a trait
    method, a function TYPE annotation - and on an intrinsic or a generic
    signature, which have no call site for a calling convention to describe.
  * `?` error propagation - `SelfLexing.advance(ref ps)?`. Yields the operand's
    `Ok` payload, or returns its `Err` from the enclosing function. A POSTFIX
    expression, so it appears wherever an expression may: `f(g()?)`, `a? + b?`,
    `f()?.field`, `g()??`. A FALLIBLE type is a `variant` with exactly two
    cases, named `Ok` and `Err`, each carrying zero or one field - which means
    `Option<T>` is NOT one, and neither is a variant that grows a third case.
    Both the operand and the enclosing function's return type have to be
    fallible, and the two `Err` payload types have to MATCH or CONVERT: a
    mismatch is legal when the operand's error implements `Into<TargetErr>`,
    and the `into` call is emitted in the FAILURE branch, so the success path
    costs nothing. The trait is matched by NAME plus its one argument rather
    than resolved as a symbol - it lives in std/core/traits.yoop, which IS
    autoloaded, but the module writing the `?` still need never have
    imported it while the module declaring the error type certainly did.
  * `expr? "context"` - the same propagation with a NOTE prefixed onto the error
    on the way out, and `` expr? `field ${n}` `` for the interpolated spelling.
    Two shapes, and they are different mechanisms rather than one with a flag:

        f()? "loading config"     both Err payloads `string`: the compiler
                                  builds "loading config: <err>" itself
        f()? "loading header"     anything else: the operand's Err type
                                  promises `WithContext<TargetErr>` and its
                                  method produces the outer payload

    The separator is `": "` and the note goes in FRONT, so contexts STACK as the
    error propagates outward. The `WithContext` call also does the CONVERSION,
    so a `?` between two different Err types needs no separate `Into` when a
    context is written - the clause SUBSUMES `Into` rather than composing with
    it, matching the reference. The context expression is evaluated in the
    FAILURE branch and nowhere else, so an interpolated one costs the success
    path nothing. Only the two LITERAL token forms may follow the `?`, which is
    the reference's rule and its reason: a general expression would make
    `f()? -x` ambiguous with a subtraction, while a string can never continue an
    expression.
  * `expr? e { ... }` - HANDLING the failure at the `?` instead of propagating
    it. `e` names the Err payload for the block's extent, as a const. The
    enclosing function need NOT return a fallible variant, which is the whole
    point: it works in `main`, or in anything returning a plain value, where
    bare `?` is refused outright. The block must LEAVE on every path - it runs
    INSTEAD of producing a value, so falling out of the bottom would leave the
    binding it feeds holding nothing - and `break` and `continue` count as
    leaving, which is what makes a handler usable to skip a loop iteration. The
    binding is REQUIRED: a bare `? { ... }` would be indistinguishable from a
    `for x in items()? { ... }` body. Pending disposals are deliberately NOT
    fired around the block; whichever terminator it uses fires the ones
    appropriate to ITS exit.
  * `import.unsafe;` / `import.test;` - module-level FLAGS rather than imports,
    which is what the `.` distinguishes.
  * module-level `const NAME: T = <literal>;`, INLINED at every use rather than
    emitted as a global - which is what makes an imported one cost nothing, and
    why the initializer has to be something there IS to inline. Four shapes
    qualify: a number (int or float, at any width), a bool, a string, and an
    ARRAY of those. A string inlines as the module-level string constant it
    already is; an array inlines as a constant aggregate
    `{ ptr @.arr.0, i64 4 }` over a module-level payload, so it costs no
    instructions at a use either. Anything else is refused BY NAME, and a CALL
    gets its own message - the reference FOLDS one at compile time, so the
    missing piece is a comptime interpreter rather than anything about the line.
  * `_` in a pattern (`case Res.Err { code: c, detail: _ }`) - names a payload
    field without binding it. Still NAMED, so a case that grows a field breaks
    its patterns loudly.
  * `ref` at a call site (`vec.vecPush(ref out, x)`) - a BORROW. Writing it is
    required, not inferred: a `ref v: T` parameter is `ref T` in the signature,
    so passing a bare `v` is a type error and the reader can see at the call
    which arguments the callee may write through. ONE exception, and it is the
    one the reference makes too: a name that ARRIVED as a `ref` parameter may be
    forwarded into another `ref` slot with no second `ref` written, because
    `ref ref T` is not a thing and forwarding creates no aliasing the caller's
    signature did not already declare. All three of `inner(v)`, `inner(ref v)`
    and `byVal(v)` work on one.
  * `trait Child extends Parent`, or `extends A, B`. A type implementing the
    child owes the parents' methods, a bound on a PARENT is satisfied by a type
    that only wrote `implements Child`, and `Child.parentMethod(ref x)`
    dispatches. A parent declared BELOW its child is refused by name.
  * `_ = expr;` - a DISCARD statement. Its own node kind, so the spelling
    survives into the AST, and checked and emitted exactly as a bare `expr;`.
  * side-effect imports - `import "./init.yoop";`. The one import form with no
    `from`. It binds nothing; what it does is put the module in the graph.
  * `export let` - an exported mutable global, read and written from another
    module. A global has one definition, in the module that declared it, so a
    cross-module read names THAT module's symbol.
  * kind prefixes in an annotation (`owned string`), parsed and RECORDED. No
    kind is enforced, so nothing reads them; the limitation is "not
    enforced" rather than "not parsed", and the JS reference additionally checks
    the kind was imported, which the bootstrap has no kind table to do.
  * `@name(args?) target` attributes, with the reference's SYNTAX: zero or more
    expression arguments, and a target that is a block, a `let`/`const` decl, a
    `type` or `variant` (optionally exported), or a bare `;`. Per-attribute
    rules are checked separately, the way the reference splits parser from
    registry - what an attribute may decorate is a property of that attribute,
    not of `@`. Unknown names are refused listing the known ones, and every
    `@derive` diagnostic matches the reference word for word.
  * `@derive(display)` - EXPANDED. The attribute generates a `toString` from the
    field annotations, and a decorated declaration is indistinguishable from one
    whose author wrote the method out:

        @derive(display)
        type Point { x: int32, y: int32 }     // prints `Point { x: 3, y: 4 }`

        @derive(display)
        variant Shape { Circle { r: int32 }, Dot }   // `Shape.Circle { r: 7 }`

    The method is generated as Yoop SOURCE TEXT, reparsed into the same arena
    with `parseInto`, and spliced onto the end of the declaration's member run;
    `Display` is merged into its `implements` clause, and every source location
    in the grafted subtree is restamped onto the declaration so a diagnostic
    from generated code lands on the line the user wrote. Same design as the
    reference (src/jsyoopderive/expand.js), and worth keeping: the method is
    ordinary code, so anything the parser learns later is inherited for free.

    Five strategies, per field: a scalar or a type with its own `toString`
    interpolates directly; an array, a `Vec<T>` and a `Map<K, V>` of those each
    get an accumulator loop; anything else prints a fixed placeholder
    (`<fn>`, `<map>`, `<option>`) rather than erroring.

    A deriving file need never name `Display` - it is bound out of the
    autoloaded std/core/traits.yoop. Refused BY NAME: a GENERIC type or variant,
    a transparent alias, a declaration that already writes `toString`, and a
    graph with no `Display` in it at all. Those four are LOAD errors rather than
    accumulated diagnostics, which is where the expansion runs and is the one
    thing about it that is not the reference's - see parse/derive.yoop.

    One DIVERGENCE in the rendering, and it is a reference BUG: its `classify`
    for a `Map<K, V>` field checks only the KEY (`classify(annot.typeArgs[1] ===
    "inline")` classifies a boolean, whose answer is truthy), so a map whose
    VALUES are not printable generates `${value}` on a type with no `toString`.
    The bootstrap checks both and prints `<map>` when either fails.

    A related finding, which is a reference bug rather than a divergence: the
    two compilers disagree about MAP ITERATION ORDER, because
    `std/core/strings.yoop`'s FNV-1a offset basis is above int64 max and the JS
    reference loses precision reading it. The bootstrap's hashes are the correct
    ones. No fixture may depend on map order.
  * `@precompile` parses and is REFUSED by name - the one deliberate divergence
    here. The reference folds its initializer at compile time; the bootstrap has
    no comptime interpreter, and emitting the decl unfolded would compile and
    silently do the work at run time, which is the thing it exists to avoid.
  * `ns.Type` in an ANNOTATION (`fs.DirIter`, `vec.Vec<int>[]`) - a type reached
    through an imported namespace, resolved against that module's exports. The
    qualified spelling and a named import reach the SAME type. A qualified
    PATTERN (`case ns.Tag.Hot:`) is a separate surface and is not here.
  * `std/...` import paths, resolved against a root the compiler DISCOVERS:
    `YOOP_STD_ROOT` if set, otherwise a probe beside the executable. Values from
    std must come through a namespace (`import * as log from "std/log.yoop"`);
    types may be imported by name.
  * std AUTOLOADS - two modules join EVERY graph whether or not anything
    imported them:

        std/core/kinds.yoop    async, task, joined, pooled, disposable,
                               ephemeral, owned
        std/core/traits.yoop   Display, Into, WithContext, Iterable,
                               Readable, Writable

    kinds FIRST, because traits.yoop writes `async read(ref self, ...)` and
    `async` is a kind kinds.yoop declares. Both walk BEFORE the entry, so they
    sit early in the topological order and every user module reads declarations
    that are already filled. That is what makes `task compute(): int32` resolve
    in a file that imports nothing - a kind is reached by NAME from a graph-wide
    registry, so merely being IN the graph is the whole requirement.

    A missing file is SKIPPED rather than reported: a caller with no std root -
    which is every source_graph and codegen test - has no std to autoload, and
    turning that into an error would make the autoload a new way for a compile
    to fail.

    The reference autoloads two MORE, `std/core/format.yoop` and
    `std/core/strings.yoop`, because its codegen lowers an interpolated template
    literal into a call to `stringConcatAll`. The bootstrap emits its own string
    builder inline and calls libc, so it would be paying for two modules nothing
    reads. A deliberate divergence, and an invisible one - no program can tell
    whether a module it never named was loaded.

NOT SUPPORTED: an INDIRECT async call through a function-typed FIELD or a local
holding a function value. A vtable SLOT is the other indirect shape and works;
the two are not one gap, because a slot's asyncness comes from the trait and is
stamped, while a function value carries whatever the annotation said and a `=>`
type is never written `async`.
Also a `pooled` PARAMETER or FIELD and
`propagates<pooled>`, and
copying a handle into a second binding (`pooled b = a;`) - a copy needs a
refcount retain, and one without it is a use-after-free rather than a leak, so
it is refused BY NAME.
Also `ns.CONSTANT`, `ns.Variant.Case` and `ns.Enum.Case` (a namespace reaches
types and calls, and nothing else), kind prefixes in a type argument,
a module-level `const` FOLDED through a call (`sortedDefs([...])`) or holding a
struct or variant literal, or an ARRAY of either - the reference evaluates all
of those at compile time and there is no comptime interpreter here, so the
refusal names that rather than the spelling. The bootstrap's own lexer wants two
of them and builds its tables at RUNTIME instead; see the `LexTables` note
below,
a compound assignment on an INDEX whose SUBSCRIPT is not a name or an integer
literal (`xs[g()] += 1`) - the compound forms desugar to
`target = target <op> value`, which names the target twice, so a subscript that
could observe being read twice is refused rather than evaluated twice,
and a CROSS-MODULE call to an `export "C"` function, which mangles the name and
fails to link. That one is not a bootstrap gap: the reference does the same, and
nothing in the corpus writes one.

**Most of std compiles.** Of the probe corpus (every non-test `.yoop` under
`std/`, `examples/pass/` and `bootstrap/src/`), nearly every file either
compiles all the way to an executable or reaches clang and stops only for having
no `main`, which a library compiled standalone always will. That includes every
module the compiler itself imports, the whole of `std/net/`, `std/tls/`,
`std/core/concurrency.yoop`, `std/http/` and `std/https/`. Nothing in the corpus
produces invalid IR.

What stops earlier stops at one of the refusals above, and `@precompile` is the
largest single one - deliberately out of scope, since comptime comes back
self-hosted. `scripts/probe_surface.sh` prints the current breakdown, site by
site.

Integer widths do NOT mix, matching the JS reference: `xs[0] + xs.len` is
`int32 + usize` and is an error. Write the cast. Neither do FLOAT widths, and
neither does a float with an int - `a + n` on a float64 and an int32 is an
error, and so is `a + 2`, because an untyped INT literal does not pin to a
float. `2.0` is the literal that does.

## Invariants

The rules the layers lean on, each easy to break and each expensive when it is:

- **Allocas are hoisted** into `entry:` via `Emitter.prologue`. An alloca must
  dominate every load, and one emitted inside an `if` arm does not dominate a
  use after the join. Slot names carry a uniquing number for the same reason -
  sibling branches may each declare `a`.
- **In a COROUTINE the allocas must land AFTER `coro.begin`**, and that is the
  one ordering the emitter needed a third buffer for. The coro passes move
  frame-resident allocas into the coroutine frame; one emitted before `begin` is
  not one of them, so a local that has to survive a suspend is left on a stack
  that no longer exists. `flushFunction` lays a function out as header, then
  hoisted allocas, then instructions - so the four prologue instructions go into
  the HEADER buffer, which is the only place above the hoisted allocas.
- **A `return` inside a coroutine is not a `ret`.** It stores to `%__ret` and
  branches to the shared final-suspend trailer, which is the block that hands
  the handle back. Every exit goes through the same three trailer blocks, which
  is also what lets an `await` route its two unwind edges (stay suspended,
  destroyed) somewhere that already exists.
- **`llvm.coro.end`'s result is deliberately DISCARDED.** It changed from
  `i1 (ptr, i1)` to `void (ptr, i1, token)` in LLVM 19/20 and newer LLVM
  auto-upgrades the old spelling on read - but only cleanly when nothing names
  the result. With a `%tN =` in front, the upgrade rewrites the call to void and
  leaves the assignment dangling, and the module fails verification with "Broken
  module found". Discarding is legal in both worlds. Same line, same reason, as
  the reference.
- **The task handle's BYTE OFFSETS are a contract with C, and nothing else in
  the tree would notice them being wrong.** `runtime/yoop_runtime.c` reaches the
  prefix through `(char*)h + 16` and friends, so an inserted or reordered field
  is a corrupted mutex pointer at run time rather than a link error. The
  emitted type definition is pinned in `codegen.test.yoop` for exactly that
  reason. Everything from byte 48 on - the result slot and the arguments - is
  the COMPILER's, and the runtime never looks at it; that split is why the
  result slot could move from 32 to 48 when the coroutine handle and the
  allocator context were added without touching the C side.
- **`wait` reads the result at byte 48 ALWAYS, never through a typed gep.** The
  prefix layout is universal, and a `wait` may be handed a `Task<T>` whose
  originating task function the site cannot name (a parameter, a handle passed
  along), so one path that is right everywhere beats two that agree. The
  reference has both and falls back to this one.
- **A live RUNTIME RACE, not a codegen one, and both compilers have it.**
  `yoop_task_settle` flips a handle's state byte and broadcasts before
  `run_task_step` is done with the handle - it still reads the allocator-context
  slot at byte 40 afterwards. A waiter that reuses the handle (a `joined`
  binding is one hoisted alloca, so a loop reuses it every iteration) or drops
  its last reference in that window makes the worker read a slot that is no
  longer the task's, and libmalloc aborts in `yoop_arena_destroy`. It needs
  roughly eight workers or more to show up at all. Neither slice fixture reaches
  it.
- **The scheduler prologue in `main` is emitted only for a program that HAS a
  task**, which is a deliberate divergence: the reference emits init, the
  coroutine trampolines and shutdown unconditionally. The bootstrap already
  links the runtime's C sources on demand, and making every hello-world compile
  fourteen C files to install a worker pool it never uses is a real cost for no
  observable difference. The trampolines keep EXTERNAL linkage for the
  reference's reason - nothing inside the IR calls them, so a discardable
  linkage gets all three deleted by globaldce and the link fails.
- **A `wait` folds into a binary expression here and returns immediately in the
  reference**, so `wait a + wait b` compiles here and is a parse error there.
  The bootstrap's `ref x` has had the same shape for as long as it has existed;
  it is a superset either way. It does mean a slice fixture has to spell the
  joins one per statement - `task_spawn.yoop` says so where it does.
- **One terminator per block.** `emitBlock` / `emitStatement` report whether the
  path definitely `terminated` - a `ret`, but also a `break` or `continue` -
  so no `br` follows one. An `if` whose both arms return emits no join block at
  all. Getting this wrong produces invalid IR that clang rejects, not a wrong
  answer.
- **A `for` loop's step gets its own block.** `continue` jumps to the STEP, not
  the condition, so the counter still advances; wiring it to the condition
  instead spins forever. That is why `LoopLabels` carries two targets.
- **A jump's UNWIND DEPTH lives on the frame it targets, not in a parallel
  stack.** `LoopLabels` carries `scopeDepth` beside its two labels, and
  `dispose_stack.yoop` is a stack of scopes and nothing else. A parallel
  `loopScopeDepths` Vec pushed alongside every loop cannot answer it, because a
  switch is a breakable scope too: a `break` out of a switch inside a loop
  unwinds to the SWITCH's depth while a `continue` in the same arm unwinds to the
  LOOP's, and those are two different numbers alive at once. Getting it wrong is
  a double free, not a compile error. `dispose_break.yoop` guards it.
- **A `break` counts as terminating an arm, and its terminator is a branch to
  the JOIN.** So a switch whose every arm ends in a `break` still reaches its
  join, and `sawBreak` on the frame is what says so. Reading "all arms
  terminated" as "nothing reaches the join" emits no join label while every one
  of those breaks branches to it - `use of undefined value`, which clang
  rejects. `allBreak` in `switch_break.yoop` is the case.
- **An array is a `{ ptr, i64 }` descriptor** - data plus length - and a
  literal's storage is a hoisted `alloca [N x T]` that the descriptor points
  into. So a literal BORROWS the enclosing function's stack: returning one hands
  back a dangling pointer. The JS reference has the same property; a
  heap-allocating form is a separate feature.
- **Structural types must intern to one TypeId.** Type equality is `id == id`,
  so two `int[]` annotations that interned separately would compare unequal.
  `internArray` / `internRef` scan before inserting.
- **A float CONSTANT is spelled as 64 bits of hex, at both widths.** LLVM takes
  an arbitrary decimal for a `double` but not for a `float` - `float 1.3` is
  "floating point constant invalid for type", because 1.3 does not round-trip
  through 32 bits - so the hex form is the only spelling that works for both,
  and it is what the reference emits for both. The two widths differ in which
  VALUE was measured, not in how it is printed: a float32 constant is the bits
  of the value after rounding to float precision and widening back, which is
  also what makes an out-of-range float32 literal come out as an infinity rather
  than as an error. `utils/float_bits.yoop` reaches the bits through `memcpy`,
  because the language has no bitcast and doing it with arithmetic would grow a
  special case each for zero, the subnormal boundary, infinity and NaN.
- **A float literal is decoded EXACTLY or refused, never approximated.**
  `lex/float_literal.yoop` accumulates the digits as a uint64 and applies the
  decimal scale with one multiply or divide, which is correctly rounded while
  the mantissa is under 2^53 and the scale within 10^22. Outside that it
  REFUSES: getting it right needs the big-integer path a real strtod has, and
  the obvious loop (accumulate in a float64, then multiply or divide by ten
  once per place) rounds at every step, and comes out wrong by an ulp or two for
  a quarter of the literals it is given - 2.718281828459045 as
  2.7182818284590446. The parity token dump COMPARES float values, as the bit
  pattern rather than as a decimal rendering, which is the one form of a float
  with no formatting question in it and the only thing that catches this.
- **An exponent may be `e` or `E`.** A scan accepting only the lowercase one
  lexes `1E5` as an int `1` followed by an identifier `E5` - a silent
  difference, since both sides still produce tokens. No file in the corpus uses
  the uppercase form, so a parity run over the corpus cannot catch it;
  `tests/parity/literals.yoop` carries one for that reason.
- **Float comparison uses the ORDERED predicates** (`oeq`, `one`, `olt`, ...),
  matching the reference. The two families differ only on a NaN, where an
  ordered predicate is false - so `x != x` is FALSE for a NaN here, which is C's
  answer and not Rust's or JS's. Picking `une` for `!=` is a one-character
  change that disagrees with the reference on exactly one input.
- **Unary minus on a float is `fneg`, not a subtraction from zero.** `0.0 - 0.0`
  is +0.0 and `fneg 0.0` is -0.0.
- **The bitwise family on floats is refused BY NAME, which is a deliberate
  divergence.** The reference is inconsistent there: `a | b` on two float64s is
  a typecheck error, while `a & b` passes typecheck and crashes its codegen with
  "unknown binary op amp for type prim/float64". One rule and one diagnostic
  here, covering `& | ^ << >>` together.
- **`floatBitWidth` is deliberately NOT folded into `primBitWidth`.** That one
  answers "how wide is this INTEGER", and three callers read a zero from it as
  "not an integer, leave it alone" - vararg promotion, the cast opcode, and
  interpolation's widening to i64. Teaching it about floats makes each of those
  quietly emit a `zext double`.
- **Variadic calls must PROMOTE narrow arguments.** C default argument promotion
  passes integers as 32- or 64-bit, so an `i8` handed to `printf` leaves the rest
  of the slot holding whatever was there before - the printed number is unrelated
  to the value, not merely rounded. `casts.yoop` in the slice fixtures is the
  test: without promotion, `narrow(300)` prints 300 instead of 44.
  A FLOAT promotes to `double` by the same rule and with the same failure mode -
  `floats.yoop` is that half's test, and the float question is asked BEFORE the
  integer width is, because `primBitWidth` answers 0 for a float and a
  fall-through would read as "nothing to promote".
  Promotion starts at the callee's FIXED parameter count, not at index 1: a
  declared parameter has a type and is passed as it, and only the tail is
  promoted. The JS reference promotes at a `printf` call and nowhere else, so an
  `int8` handed to a declared `snprintf` there is passed as `i8`; the bootstrap
  promotes at every variadic call, which is a deliberate divergence and the
  reason `variadic.yoop` keeps its narrow arguments on the printf side (a slice
  fixture has to run identically under both compilers).
- **`...` is a MARKER on the signature, not a parameter.** It produces no PARAM
  node, so `childB` holds exactly the fixed parameters and every later pass
  counts them without knowing varargs exist. It rides on the
  EXTERN_FUNCTION_DECL's `flagA` and pass C reads it only for that node KIND,
  because the same `fillFunctionSignature` fills a FUNCTION_DECL and a
  METHOD_DECL whose `flagA` is free for whatever wants it next.
- **A variadic call site spells the callee's WHOLE function type.** `call i32
  (ptr, i64, ptr, ...) @snprintf`, not `call i32 @snprintf`: the fixed half is
  how LLVM knows where the varargs begin, and the arguments alone cannot say.
  That is the only reason `emitCallVariadic` exists beside `emitCall`, and it is
  why the fixed types are read off the Func type rather than off the arguments -
  `printf("%d")` and `printf("%d", 1, 2)` are one callee and must spell one type.
- **`printf` is a BUILTIN only when nothing declared it.** Pass D looks the name
  up first and falls back to the builtin on a miss, which is the reference's
  precedence, established by probing it: declaring a non-variadic `printf` there
  makes `printf("a %d\n", 3)` an arity error. Checking the builtin FIRST would
  make the 158 files that declare their own printf immune to their own
  declaration.
- **A `declare` is emitted once per SYMBOL for the whole module, and all four
  sources share one table.** An extern is not exported and does not travel
  through an import, so every file that calls `printf` declares it again - that
  is ordinary. One LLVM module holds the whole graph and a symbol may be
  declared in it exactly once. FOUR things declare C symbols into it and none of
  them can see the others: the user's `extern` blocks, the template-literal
  lowering (which is libc rather than std - `strlen` / `malloc` / `free` /
  `memcpy` / `sprintf`), the runtime bridge, and the printf builtin. So the
  `seen` map lives on the EMITTER (`codegen/extern_table.yoop`) rather than
  inside the extern pass, and every one of the four goes through
  `externDeclare`. `variadic_modules.yoop` and `extern_dedupe.yoop` cover it end
  to end; `codegen.test.yoop` covers the refusals.
- **COMPATIBLE means "spells the same LLVM declaration".** Same return type,
  same fixed parameter types in order, same `...`. That is everything a
  `declare` says, so two yoop signatures agreeing on it are interchangeable at
  the ABI - `usize` and `uint64` are both `i64`, `string` and
  `unsafe_ptr<void>` are both `ptr` - and a compatible re-declaration REUSES the
  line rather than emitting a second one. Two that disagree are refused BY NAME,
  quoting both LLVM spellings, which is a deliberate divergence: the reference
  emits both lines and lets clang say "invalid redefinition of function
  'malloc'", which names neither declaration and no source file. The comparison
  is on the LLVM spelling rather than on the Func TypeIds because two identical
  signatures intern to different ids (see the `typeAccepts` note below).
- **User externs are declared FIRST, before any body is walked.** That ordering
  is what makes a lowering reuse the user's line rather than the other way
  round, and it is not an accident: a user's declaration is the one with a
  source location a reader can go and fix.
- **An INTRINSIC block emits no `declare`.** There is no symbol - codegen lowers
  the call to instructions - so a `declare` for one names something nothing
  defines. The reference skips intrinsic blocks for the same reason.
- **A `switch` allocates every arm's label before emitting any of them**, because
  the jump table names them all up front. That is the one structural difference
  from `if`. It also pushes a SWITCH frame on the jump stack around the arm
  bodies, with `breakTarget` = the join and a ZEROED continue target - `continue`
  scans past it for the innermost loop, so a wrong lookup is an obvious zero
  rather than a plausible label from another construct.
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
- **The lexer's two scan tables are BUILT AT RUNTIME and threaded, not reached
  as module globals.** `lexTablesNew` fills the punctuation table and the
  keyword table and sorts the first longest-spelling-first; `lexNext` takes a
  `ref LexTables`, and `tokenize`, `dumpTokens`, `moduleHeaderName` and
  `parseInto` each own one for the length of their walk (ParserState BORROWS
  the one `parseInto` made). Two reasons, and the second is the one that decides
  the shape. FIRST, neither table can BE a module-level array: an array of
  STRUCTS has no static spelling to inline, so even the plain
  `const KEYWORD_LIST = [ ... ]` was refused, and the punctuation table
  additionally went through a CALL (`sortedDefs([ ... ])`) that the reference
  FOLDS with its comptime interpreter. Comptime is deliberately out of scope, and
  those two lines gate every file whose import closure runs through `lex`, which
  is most of the corpus. SECOND, the longest-first ORDER is a correctness requirement rather
  than a formatting preference - `...` scans as three DOTs without it - and
  `quickSort` is what enforces it, so hand-sorting the literal would trade a
  check for a comment.
  Costs two table builds per source FILE (the header peek and the parse), each
  85 vector pushes and one 41-element quicksort, which is not measurable against
  a compile. REVERSIBLE - a self-hosted comptime interpreter would let
  `lexTablesNew` become a module const with no change to anything that reads it.
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
  instantiation, and BOUNDS did not change that.** Pass D checks it with its
  parameters left opaque, so its decoration is written in terms of them; codegen
  walks that same decoration per instance and substitutes on the way out, in
  `resolvedTypeAt` and nowhere else. Before bounds this was sound because an
  opaque `T` supported nothing at all. It is sound WITH bounds for a different
  reason: a bound is a PROMISE, checked once against the body at the decl and
  once against the argument at every instantiation, so a body that checks
  against the bound checks for every type that satisfies it. `return x + 1` on
  an unbounded `T` is still rejected at the decl; `Comparable.compare(ref a, b)`
  on a `T implements Comparable<T>` is accepted there, and each instance emits a
  direct call to the concrete type's own method.
  The alternative - re-checking the body per instantiation - was rejected
  deliberately. It costs a decoration vector per instance, `tm.resolvedTypes`
  / `calleeReceiver` / `calleeInstance` are all keyed by NodeId with one entry
  per node, and it moves every diagnostic from the declaration the author can
  fix to each call site that happens to trip over it. That is the C++ template
  failure mode, and the reference does not do it either (a bounded body is
  checked at its decl even when nothing ever instantiates it - established by
  probing).
- **A bound's methods are reached through the BOUND, and `self` is rewritten to
  the parameter.** A trait method's signature annotates `self` with the trait's
  own name (`parseMethodSig` passes 0 for the owner's type params on purpose),
  so the Func in a trait's method table is `(ref Comparable, T) => int8`.
  `boundMethodOn` hands back that signature with parameter 0 replaced by
  `ref T`. Nothing else about it moves - the rest was already substituted when
  the bound was applied.
- **A trait APPLICATION is a distinct interned type, and its arguments live in
  the `typeParams` slot.** `Comparable<Token>` is a fresh `Type.Trait` whose
  method signatures are substituted; the slot holds the ARGUMENTS for an
  application and the PARAMETERS for the template, which is the same convention
  `GenericInst.args` follows (a template's arguments are its parameters).
  `findTraitApplication` scans before interning, like `internArray`, or every
  call site of a bounded generic would intern its own copy. Trait identity for
  satisfaction is the (module, name) pair - `sameTraitDecl` - because applying
  arguments makes a new TypeId.
- **`substitute` deliberately does NOT recurse into a trait.** A trait method's
  `ref self` names the trait itself, so substituting a trait by substituting its
  method signatures re-enters the trait through its own first parameter and
  never terminates - that was a real stack overflow, not a hypothetical. The two
  places a trait id is stored (a type's `implementsTraits`, a parameter's
  `bounds`) call `substituteTrait` on the list directly, which walks the
  ARGUMENTS and never the methods.
- **A trait's `implementsTraits` records WHICH application, and a bound is
  checked against it.** `implements Comparable<Token>` and `implements
  Comparable<int32>` are different promises, and comparing only the trait NAME
  makes a `T implements Comparable<T>` bound accept the wrong one. The reference
  compares names only and emits IR clang rejects ("defined with type %N but
  expected i32"); the bootstrap refuses by name, which is a deliberate
  divergence.
- **`extends` is a FLAT parent list plus a lookup fall-through, not a merge.**
  `collectImplementedTraits` expands each parent's own extends chain as it
  builds the list, so `Type.Trait.extendsTraits` is already transitive and
  `lookupMethod` needs exactly one level of fall-through and no cycle guard. An
  `implements Child` clause claims the parents the same way, which is what makes
  a bound on a GRANDPARENT satisfied and what makes `checkTraitsSatisfied`
  demand the parents' methods. The tidier version - merging each parent's method
  table into the child's - buys nothing: the flat list needs exactly one level of
  fall-through and no cycle guard, and a merge means iterating a `Map` to arrive
  at the same answer.
- **A parent trait must be declared BEFORE the child that extends it.** Its
  method table is an empty shell until pass C fills it, and an empty parent is
  invisible rather than wrong - every use downstream would report the child as
  missing a method that is one line up. Refused by name.
- **Traits fill FIRST in pass C - before generics, before concrete decls.** A
  generic decl's parameters' bounds and its own `implements` clause both name
  traits, and both have to read a trait's type parameters back to know which
  application they mean. An unfilled shell answers "takes 0 type arguments" and
  the decl is refused for arity. `FillPhase` is the three-way split; a trait
  belongs to none of the other two, because nothing instantiates a trait and
  there is no template to fill first.
- **`checkDeclTraits` RE-READS the implements clause, so it needs the type-param
  scope too.** The clause can name the decl's own parameters
  (`type Box<T> implements Cmp<Box<T>>`), and the satisfaction sweep runs
  outside the fill that put them in scope. Without the second
  `beginTypeParams`, a generic type implementing a generic trait reports
  "unknown type T" about a line that resolved fine moments earlier.
- **The set of monomorphizations has to be CLOSED before codegen.** A generic
  calling a generic records an instance whose ARGUMENTS are the caller's own
  type parameters - `partitionYoop_T`, not `partitionYoop_Token`. That is not a
  monomorphization: its signature still mentions a type with no LLVM spelling.
  `closeFuncInstances` (monomorph.yoop) runs after every body is checked and,
  for each open instance, registers the substituted one implied by every
  concrete instance of the decl whose parameters it mentions. Codegen then skips
  open instances the way `isOpenInstance` makes it skip open type instances, and
  `resolvedFuncInstance` lands each call site on the concrete one.
  An unbounded generic body only moves values around, so getting this wrong
  emits `@inner_T(ptr)` called with an `i32`, which clang accepts and which
  happens to work. A bounded body dispatches a METHOD on `T`, the receiver never
  resolves, and the symbol comes out as `@mod____a`.
- **Reserved index 0 is the sentinel, everywhere.** SymbolId, DeclId and the
  function-instance index all burn slot 0 on a dead entry. Use the idiom: a
  max-value constant in its place silently WRAPS to 0 in the stage the JS
  reference builds, because the JS REFERENCE wraps an integer literal above
  int64 to zero - so `const FIELD_NONE: usize = 18446744073709551615;` is 0
  there and is itself in every stage after that. A sentinel that compares equal
  to a real index is a silent miscompile: the first monomorphization in a
  program emitted as ordinary code under the generic's bare name with its
  parameters unresolved, or field 0 read as "no field". When 0 CANNOT be the
  sentinel - propagated disposal, where index 0 is an ordinary answer - use a
  separate BOOL, not a bigger number. The bootstrap gets the literal right, and
  a codegen assertion keeps it that way.
- **A struct FIELD whose own type is a VARIANT is a field READ, and the base is
  what says so.** `a.value` where `value: Operand` and `Shape.Empty` are the
  same node kind with the same expression TYPE, so testing the whole expression
  compiled the field read as a payload-less constructor of case 0 - a fresh tag
  and an UNWRITTEN payload. Silent: it compiled, ran, and produced garbage
  pointers. The base is the discriminator, exactly as it is for an enum case:
  a constructor's base is a TYPE NAME and is never checked as a value, while a
  field read's base is a struct, so `isStructAt(expr.childA)` comes FIRST in
  `emitExpr`'s FIELD_ACCESS arm. The compiler's own
  `CallArg { ty: string, value: Operand }` is this shape.
  `field_variant.yoop` is the fixture.
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
  caller that already knows its root - a test pointing at a stub, or an editor
  server - never touches the filesystem probing in `std_root.yoop`. The
  discovery rule honours `YOOP_STD_ROOT`, which is what the JS reference honours
  too, so one variable retargets both compilers at the same tree.
- **The `modules/` root is the opposite shape, and deliberately so.** `std/`
  belongs to the COMPILER and is found once beside the executable; `modules/`
  belongs to whoever is being compiled and is answered per IMPORT, by walking UP
  from the importing file's own directory. `source_graph/modules_root.yoop` owns
  it. The FIRST root the walk meets wins whether or not it holds the requested
  name - that is a safety property, not an optimization, since continuing past it
  would let a stray `modules/` in a home directory answer for a program's own.
  The point of the whole thing is relocatability: a library and the consumer that
  vendors it write the same import line and each resolves it against its own root.
- **A module under a modules root may NOT carry a root of its own, and that is
  enforced.** Two copies of one module at two paths get distinct mangled symbols
  and LINK FINE, then fail on the first value passed between them as "Value is
  not assignable to Value". The bootstrap walks UP from the target to the root
  where the reference walks DOWN; same directories, no path split needed, but the
  target directory ITSELF has to be checked first, since `modules/math` resolving
  to `<root>/math` makes `<root>/math/modules` the exact case this catches. A
  DIVERGENCE where the bootstrap is better: the reference throws an uncaught
  JavaScript `Error` for this, so its user gets a stack trace. One case not
  built: a `modules` directory at the FILESYSTEM ROOT is not consulted.
- **A borrow costs no instructions.** Every local already lives in an alloca, so
  `ref x` is the ADDRESS of storage that exists; and a `ref` parameter arrives
  as that pointer, so it gets no alloca and no spill - the incoming pointer IS
  its slot (`LocalSlot.id == ARG_PTR_SLOT`, the reserved zero again). Every load
  and store in the body then works unchanged, because they only ever needed an
  address, and they land on the caller's object. `refs.yoop` in the slice
  fixtures is the test a by-value lowering would still pass most of.
- **A `ref T` parameter is `ref T` in the SIGNATURE and `T` in the BODY, and the
  binding REMEMBERS which it was.** The first is what makes passing a bare value
  an error; the second is what keeps every read, write and field access in the
  body from needing to know about references at all. `bindParams` is where the
  two part company - and `Binding.refParam` is the record it leaves behind,
  because the unwrapping is not total. FORWARDING the name into another `ref T`
  slot has to hand on the pointer, and by then `typeId` says `T`.
  `reborrowIfWanted` in pass D is where the two rejoin: it is the MIRROR of
  `openBorrowIfWanted`, marks the node in `tm.reborrowUses`, and
  `emitForwardBorrow` turns it into the ARG_PTR_SLOT operand `ref v` already
  produces - no instruction at all.
  The rule is keyed on how the name ARRIVED and not on its type, which is what
  keeps it honest: a `ref` parameter is already a borrow, so forwarding it
  creates no aliasing the caller's own signature did not already declare. A
  PLAIN local still has to write `ref` at the call, and the reference refuses it
  there too (probed).
  Binding the parameter as `ref T` instead is a one-line change with at least
  five special cases behind it - `emitLocalRead` would have to stop loading,
  `checkRefExpr` would have to stop double-wrapping, assigning to the name by
  itself would compare `ref T` against `T`, and every method's `self` is a `ref`
  parameter. That is why the binding remembers instead.
- **An UNSIGNED integer comparison uses LLVM's unsigned predicates.** `icmp slt`
  and `icmp ult` are different instructions and picking the wrong one is a WRONG
  ANSWER rather than an error: an i8 holding 128 is -128 to the signed one, so
  `first < 128` on a uint8 byte of 104 comes out FALSE. Get it wrong and every
  multi-byte UTF-8 branch in `std/core/strings.yoop` is taken the wrong way, with
  `stringFromBytes` returning Err on plain ASCII three layers from where anything
  read it as the only symptom. `llvmIntPredicate` takes the OPERAND's
  signedness, exactly as `llvmIntOp` already did for `sdiv`/`udiv` and
  `ashr`/`lshr`. `eq` and `ne` take no sign - two identical bit patterns are
  equal under either reading.
  A DELIBERATE DIVERGENCE falls out of it: an int-backed value ENUM is the
  integer it aliases, unsigned backing and all, so `Flags.HIGH > Flags.LOW` on
  an `enum<uint8>` with cases 200 and 10 is TRUE here. The reference compares it
  signed and says false - its `binaryInstruction` asks `isUnsignedIntPrim` and a
  value enum is not a prim, so the override never fires. `unsigned_compare.yoop`
  covers the rest of the family end to end and leaves that one case to a codegen
  IR assertion, since a slice fixture is asserted against both compilers.
- **A borrow held as a VALUE opens at the USE, never at the binding.** A `ref T`
  FIELD keeps its type for as long as anything holds it - unlike a parameter,
  which `bindParams` unwraps once - so `const s = h.src` is still a `ref uint8[]`
  and `s.len` has to open it. Stripping the `ref` at the binding instead was the
  obvious shortcut and it is a silent miscompile: `let pr = hp.p; pr.x = 42;`
  through a `ref Point` field writes the ORIGINAL, and a copy would not.
- **Opening a borrow is TWO mechanisms because there are two questions.** A
  field or index BASE opens structurally, in codegen (`emitExprValue`), because
  a READ wants the value and a WRITE wants the address and only codegen knows
  which one a base is under. Everything else opens because the CONTEXT wanted a
  plain `T` - an argument, an initializer, an assigned value, a returned value -
  which only pass D can answer, so `openBorrowIfWanted` records the node in
  `tm.derefUses` and the `emitExpr` wrapper emits exactly one load. Do not merge
  them: a marked base would hand `emitFieldAddress` a loaded struct where it
  needs the pointer.
- **A BORROWED base is cheaper to write through than a slot base.** `ref T`
  already IS the address, so `cx.e.usesPrintf = true` geps straight off the
  operand with no slot lookup and no load. `emitFieldAddress` tests that FIRST,
  before the nested-field case, because a borrowed base is very often a field
  read itself and the two answers differ.
- **`ref x` WRITTEN OUT never opens itself.** `takes(ref n)` against
  `takes(n: int32)` stays an error even though a borrow that arrived as a VALUE
  in the same slot is accepted. The whole reason writing `ref` is required is
  that the reader can see at the call which arguments the callee may write
  through, and quietly undoing it would make `f(ref n)` and `f(n)` one call.
  Same rule in the reference, established by probing.
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
  index puts a hole in the tag numbering, and the tag numbering is ABI. A value
  enum's members are arranged the same way and count the same way.
- **A value enum IS its underlying primitive below typecheck.** There is no
  `codegen/enum.yoop` and there should not be one: `llvmType`, `primBitWidth`,
  `primIsSigned` and `sizeOfType` each unwrap the alias once through
  `enumUnderlyingOf`, and that covers layout, casts, vararg promotion, array
  elements, struct fields and `ref` parameters together. `enumUnderlyingOf`
  returns any NON-enum unchanged, which is what makes it safe to call from those
  four places without a test at each site. Note that `isIntPrimType` deliberately
  does NOT unwrap: that one decides what an untyped literal may pin to, and
  pinning a bare `1` to a `Color` would invent a case.
- **An enum's ORDINAL and its VALUE are different numbers, and both are load
  bearing.** The ordinal is declaration order and is what exhaustiveness counts
  and what names a missing case; the value is the constant, and it is what the
  jump table dispatches on. Values may be sparse, negative and repeated, so
  using one for the other is wrong in both directions.
- **`Color.Red` is a FIELD_ACCESS, and only the BASE can say so.** `p.c` on a
  struct with a `Color` field resolves the whole expression to the same enum
  type, so testing the expression's type would emit a case constant where a
  field read belongs. Pass D decorates the BASE with the enum type, and codegen
  tests that - an enum has no fields, so a base that resolved to one is never
  anything else. The payload-less variant constructor beside it tests the whole
  expression, which is the shape to be careful about if a variant ever becomes a
  struct field's type.
- **An enum switch is exhaustive OR defaulted, and may be BOTH.** That is the
  opposite of the variant rule, and it is not an oversight: an enum's values are
  integers, so a value naming no case is representable and the default is never
  provably dead. It is also why an OPEN enum - one whose case was derived with a
  bitwise operator - REQUIRES a default even with every case covered. Both rules
  were established by probing the reference.
- **Two cases may share a VALUE, but a switch may not match both.** Declaring
  `{ Red 1, Crimson 1 }` is legal on both sides; matching both in one switch
  emits a jump table naming `1` twice, which clang rejects with "duplicate case
  value in switch" and no source line. The bootstrap refuses it by name, which
  is a deliberate divergence - the reference emits the invalid IR.
- **An enum method is reachable through `Trait.method(ref e)` here and not in
  the reference,** which refuses an enum receiver ("requires a struct
  receiver"). This falls out of putting the method table on `Type.ValueEnum`
  rather than being added; blocking it would take extra code to make an enum
  less of a type than it is. Interpolation (`${lvl}`) works on both sides and is
  the form the reference intends.
- **An enum case value is folded in pass C, not parsed as a grammar.** The
  parser takes an ordinary expression after the case name, and
  `typecheck/enum_values.yoop` decides whether it could be a constant. That is
  the reference's split too, and it is what makes `Red { r: int32 }` report
  "unsupported expression form in enum case value" rather than "expected comma" -
  a payload is a struct literal to a parser.
- **`function` terminates a case's value expression.** A comma before a method
  is optional, so `Blue\n function toString(...)` would otherwise read the
  keyword as the start of Blue's value.
- **An enum's BACKING type lives in childC, not childA.** childA means "type
  parameters" on every other decl and an enum has none - `enum K<uint8>` is a
  backing type. Putting it in childA would make every "is this generic" test in
  pass C answer yes for an `enum<uint8>`, and the failure would be an instance
  with no members rather than an error.
- **A module `const` is INLINED; a module `let` is a real global.** They get
  different Symbols because they are emitted differently - one has no storage at
  all, which is why writing it is refused with "there is nothing to write to"
  rather than a generic const complaint.
- **A const that needs a DATUM still inlines; what inlines is a constant that
  points at the datum.** A string's bytes and an array's payload have to live
  somewhere, so `codegen/const_data.yoop` materializes them once for the whole
  program and every use inlines `@.str.N` or `{ ptr @.arr.N, i64 LEN }`. LLVM
  takes a constant aggregate as an operand, so an array const costs no
  instructions at a use either - `.len` is an extractvalue on a constant. Keyed
  by SymbolId, which is what makes an IMPORTED const work: an import binds the
  source module's SymbolId rather than a copy.
- **An array const's payload is `internal global`, not `private constant`.**
  Constness is about the BINDING, so `A[0] = 9` through a const is allowed the
  same way it is for a local, and read-only storage turns that into a crash at
  run time. The reference DOES crash there.
- **A method's kind prefixes are RESOLVED, and the reference's are not.** An
  unknown kind on a method is refused by name here, and a PAUSABLE one marks the
  method a coroutine so codegen refuses to emit it. The reference checks neither
  - a typo'd prefix silently produces an ordinary method there, and an `async`
  one is emitted as a function that never suspends. Deliberate divergence, and
  the same reason the function-level refusal exists.
- **A pausable METHOD is keyed by NodeId, not by name.** `pausableNames` is a
  name table and a method's name is not unique in a module: two types may each
  declare `read`, and a plain function may be called `read` as well.
  `pausableMethods` is the NodeId-keyed twin, and `emitMethodRun` asks because
  only the caller has the member's id.
- **`Green function toString(...)` and `async function handle(...)` are the same
  two tokens, and only the BODY decides which.** An enum or variant case may be
  a bare identifier with a method right after it and no comma; a struct field is
  always `name: T`, so there the shape can only be a kind prefix.
  `atKindPrefixedMethod` takes that as a parameter. The two-token rule every
  other kind position uses is not enough here, and neither is "the run ends at
  `(`" on its own - an enum case may be `AB A | B`.
- **A PARAMETER takes exactly one kind prefix, and it comes before `ref`.** The
  count is the reference's rule rather than the grammar's ("a parameter may
  carry at most one kind prefix"), and refusing it here means the two compilers
  agree on what a program MEANS and not only on what it looks like. The
  position is what keeps the lookahead decidable: an identifier followed by
  another identifier OR by `ref` cannot be the parameter's own name, because a
  name is always followed by `:`.
- **`library` is CONTEXTUAL and the two `from` spellings mean different
  things.** `from "stdio.h"` is a HEADER name read by nobody; `from library "m"`
  is a LINK instruction that lowers to `-lm` on the clang line. `library` lexes
  as an ordinary IDENT on both sides, so it is recognized by TEXT the way `kind`
  and `propagates` are, and `operator == LIBRARY` on the EXTERN_BLOCK is what
  tells the link step which spelling was written. Guessing from the name instead
  would make every `from "stdio.h"` into `-lstdio.h`.
- **Link libraries are collected for the GRAPH, not per module.** One clang
  invocation links one program, so a library named in any file has to be on that
  one command line - the same reason `emitExternDeclares` is program-level. They
  ride out on `CodegenOutput` beside `needsRuntime`, because both are properties
  of the emitted IR rather than of any module.
- **A kind-prefixed binding may OWN a block, and the block IS its scope.**
  `disposable reg: T = expr { ... }` puts the name in a scope of its own: it is
  visible inside the block, gone after it, and the scope-end call fires at the
  closing brace rather than at the end of the function. That is not "a binding
  followed by a block" - reading the name afterwards is an error on both sides.
  `emitScopedBinding` is the named twin of `emitKindRegion` and differs in one
  thing: the subject has a name, so it goes in an ordinary local slot the block
  can read instead of an anonymous one. It also pushes a LOCALS scope, which the
  anonymous form needs no equivalent of - `emitBlock` pushes its own scope
  INSIDE this one, too late to hold a binding declared before the block starts.
- **The block form is GATED on there being a kind prefix.** Without the gate an
  ordinary `const p: Point = { x: 1 }` followed by a bare block statement would
  swallow the block; the `{ x: 1 }` was already eaten by the expression, so the
  parser cannot tell them apart by shape.
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
- **A scope-end call already made BY HAND is not made again.**
  `Disposable.dispose(ref c)` on a `disposable` binding answers the obligation and
  the closing brace emits nothing, which is what the reference does too. The
  answer is per EXIT SITE rather than per binding, because a `return` placed
  before the manual call still owes it while the brace past it does not. The
  satisfied-set is a `uint64` bitmask in `typecheck/discharge.yoop`, snapshotted
  at a branch and INTERSECTED at the join; codegen only skips.
- **An ASSIGNMENT REARMS that obligation - a DELIBERATE divergence.**
  `Disposable.dispose(ref s); s = next;` is what std/core/kinds.yoop documents as
  the informed opt-in for a mutable kinded binding, and the reference never clears
  its satisfied flag, so it emits no scope-end call there at all and never
  disposes the value the binding ends up holding. Reproducing a leak on the
  language's own recommended idiom is not parity worth having.
  `tests/slice/dispose_rebind.yoop` is `.bootonly` for that reason.
- **An ARRAY of unions works here and is an internal error in the reference**
  (`arrayElemLlvmName: unsupported elem type "union"`). Representational: the
  reference names one `%yoop_array.T` per element type and has no spelling for a
  union, while the bootstrap uses one anonymous `{ ptr, i64 }` descriptor for
  every element type. The slice fixture avoids the shape so its `.expected` stays
  assertable against both.
- **A union is addressed, never extracted.** Structs here are SSA aggregates, so a
  read is a load plus `extractvalue` and there is nothing to reinterpret one as. A
  union field read is the union's own ADDRESS loaded at the field's type - the
  variant-payload shape. The whole change to the shared read path is two early
  returns guarded on `isUnionAt`, which answers false for every pre-union type, so
  non-union IR is unchanged by construction. Do not add a `Type.Union` case to
  `lookupField`: it returns a field POSITION, and a position is the one thing a
  union does not have.
- **A `void` main is emitted as `define i32 @main()` with `ret i32 0`.**
  `define void @main()` is ABI-illegal for C's entry point - nothing writes the
  return register, so the exit status is whatever the last call left behind. Both
  compilers emit the `i32` form. The two `ret` sites move together: `ret void`
  inside a function returning `i32` does not verify.
- **A module-level `let` with a non-literal initializer gets `zeroinitializer`
  plus a run-time store** from `@<mod>__module_init<N>()`, one per source file
  that owes one, called from `main` in the module graph's TOPOLOGICAL order. Only
  a bare integer literal is baked into the global. An array literal's payload goes
  in a module DATUM rather than an alloca, because the init function's frame is
  gone the moment it returns; a non-literal ELEMENT is refused by name rather than
  lowered into a dangling pointer.
- **`_` is not a reserved word here.** The JS lexer's keyword table maps `_` to
  `discard`, so the reference reports `let _ = 1;` as `"_" is a reserved word`
  and accepts `_` as a struct-literal or pattern FIELD name. The bootstrap leaves
  `_` out of the reserved set: it reports the pre-existing `expected IDENT, got
  DISCARD` for a binding, and still refuses `{ _: 1 }` and `case Ev.type { _ }`.
  `_` is punctuation the lexer happens to spell as a word, and nothing that
  wanted a C name ever wanted it.
- **A member spelled `function` is still a METHOD.** In a struct, variant or enum
  body the bootstrap dispatches on the `function` keyword alone; the reference
  disambiguates a struct FIELD from a method by the trailing colon, so
  `type T { function: int32 }` compiles there and is refused here. Every other
  reserved word works in those positions, and an extern parameter named
  `function` is fine, since nothing there is ambiguous.
- **A field supplies a propagated kind by EITHER spelling: its own type
  propagates the kind, or its annotation carries the kind by PREFIX**
  (`handle: disposable FileHandle`). `Type.Field.carriedKind` holds the second,
  filled in pass C where the annotation node and its KIND_PREFIX list are both in
  hand. Codegen sees no difference - a propagated disposal already records
  `ownerType: field.fieldType`, so both spellings emit the same call. Only a
  plain type name carries one; a prefix on an array or a `ref` is not read,
  because the call would then be on the WRAPPER.
- **`appliesTo` is NOT enforced on a field prefix, and the reference's version of
  that check is broken anyway.** The bootstrap records a kind's clauses by their
  leading word and never reads the site list, so any declared kind may prefix a
  field. The reference requires `appliesTo field` - but it only populates that
  set for an IMPORTED kind, so a kind declared in the same module as the field
  that carries it reads back as `appliesTo: (none)` and the field is refused.
  That is why `examples/pass/propagates_full/io.yoop` declares its own
  `disposable` in a second file, and why `tests/slice/lib/carried.yoop` exists.
  The bootstrap is a superset here, so nothing the reference accepts breaks.
- **A returned VALUE is computed before anything is disposed.** It may read a
  binding that is about to go.
- **`?` IS a return, so it unwinds like one.** Its error path calls the same
  `emitUnwindTo(cx, 0)` a `return` statement does, and the Err value is built
  before the unwind for the same reason a returned value is. This is the half a
  happy-path test cannot see: dropping it leaks only when something actually
  fails. `try_op.yoop` in the slice fixtures runs each `?` function twice, once
  down each path, and the two runs print the same disposals in the same order.
- **A FALLIBLE type is exactly two cases named `Ok` and `Err`, each with at most
  one field.** Every clause is load-bearing and every one was established by
  PROBING the reference. A third case, or a two-field payload on either case,
  makes it non-fallible - and so `Option<T>` is not fallible either, which is
  the one most likely to be assumed. `fallibleShapeOf` in
  `typecheck/fallible.yoop` is the single answer; do not re-derive it by looking
  up two case names somewhere else.
- **`?` REBUILDS the enclosing function's Err rather than forwarding the
  operand's value.** The two fallible types need not be the same type - only
  their Err PAYLOADS have to agree - so the tag and the payload struct both
  belong to the return type. Forwarding the operand's value would compile
  whenever the two happened to have the same layout and corrupt the tag when
  they did not.
- **The Err types must MATCH, or the operand's must implement
  `Into<TargetErr>`.** The conversion is a `ref self` method on the operand's
  error, called in the FAILURE branch, so the success path costs nothing. The
  mismatch diagnostic NAMES Into, so a reader holding neither is told which two
  things are on offer rather than being left thinking the types are simply
  wrong.
- **`?`'s Ok block has exactly ONE predecessor, which is what makes it safe
  mid-expression.** The lowering is a diamond whose error half ends in `ret`, so
  a temp computed before the `?` still dominates everything after it and `a +
  f()?` needs no phi. Anything that gave the error path a way to rejoin would
  break that.
- **The enclosing function's return type is AMBIENT in both passes that need
  it.** `?` can sit at any depth of an expression, so threading the return type
  through `checkExpr` would have meant a new parameter on every one of pass D's
  expression helpers to answer a question all but one of them ignore. Pass D
  reads `Program.currentReturn` (set by `beginFunction`, the twin of
  `beginFile`); codegen reads `Cx.fnRet`. A method goes through the same
  `checkBodyAgainst`, so both are set on that path too - miss that and every
  method's `?` checks against the previous function's return type.
- **A `Vec` read out of the dispose stack is a SHALLOW copy.** Marking it
  `disposable` frees storage the stack still owns and pops it again a moment
  later - a double free, which aborts. Same trap a Vec read out of the type
  arena carries.
- **The runtime is found LAZILY, only when the emitted IR calls into it.** Most
  programs link one input and nothing else; `Emitter.usesRuntime` is what says
  otherwise, and it rides out of codegen with the IR because it is a property of
  those instructions. Discovery mirrors the std root on purpose - one mental
  model for "files the compiler did not compile into itself".
- **TWO different things ask for the runtime, and they answer different
  questions.** `Emitter.usesRuntime` means codegen's OWN lowerings emitted calls
  into it - the allocator context, the errno bridge - and it additionally
  decides whether the runtime's `declare` lines are needed.
  `LinkRequests.namesRuntime` means a user wrote
  `extern "C" from "yoop_runtime" { ... }` and brought their own declarations,
  so it asks for the LINK and nothing else. Either one puts the runtime's C
  sources on the clang line; conflating them would make a user's extern emit
  `declare ptr @yoop_ctx_alloc(i64, i64)` into a program that never calls it.
  Without the second, std/debug, std/env, std/runtime, std/core/atomic and
  fifteen more fail to link with `"_yoop_panic", referenced from`.
- **Which `from` names mean "the runtime" is a BASENAME PREFIX, not a list.**
  A header whose basename starts with `yoop_` belongs to the runtime, which
  covers both spellings in the tree - `from "yoop_runtime"` and
  `from "runtime/yoop_alloc.h"` (std/core/alloc's) - with one rule and nothing
  to keep up to date. `yoop_` is the runtime's symbol prefix as well as its file
  prefix, so a header named that way and not being the runtime is not a thing.
  The LIBRARY spelling is deliberately excluded: `from library "yoop_runtime"`
  stays `-lyoop_runtime` and fails to find an archive, which is what the
  reference does with it too (probed).
  Worth knowing: the REFERENCE ignores the `from` name entirely and links the
  whole runtime into every program, hello-world included - probed, and 197
  `yoop_` symbols end up in a program that calls none of them. So the bootstrap
  links a strict SUBSET, and a program that works there works here as long as it
  names the runtime, which every file in the corpus that uses it does.
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
  still `T[]`; a raw read produces IR that operates on the template, which is
  silently wrong rather than an error.
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
- **Func types compare STRUCTURALLY, and so does everything WRAPPING one.**
  Everything else in the type system is `id == id`, and Funcs cannot be: a
  declared function's signature lives in the SHELL pass A registered for it and
  filled in place, so two identical signatures keep different TypeIds and an
  annotation interns a third. `internArray` and `internRef` do canonicalize, but
  they canonicalize on the id they are HANDED - so two different Func ids give
  two different `Func[]` ids and two different `ref Func[]` ids, and a
  top-level-only compare reported that an array of functions was not an array of
  functions, quoting the same spelling on both sides. So the compare recurses,
  through every STRUCTURAL wrapper: `Ref`, `Array`, `Task`, `UnsafePtr`, a Func's
  own parameters and its return, and `FuncPtr`.
- **It stops at every NOMINAL type, and that is both the right answer and the
  termination argument.** Nominal identity is the DECL, so two distinct struct
  ids are two distinct types no matter how their fields line up - and a nominal
  type is the only way to build a type that contains ITSELF, so a walk that
  never enters one cannot loop on `type Node { next: Node }`. Nothing else can
  cycle: a structural type is interned after the types it composes, which is the
  same argument `typeMentionsTypeParam` makes in generics.yoop. The one shape
  this refuses that a fuller rule would accept is a generic nominal applied to a
  Func (`Box<(a: int32) => int32>` written twice); it is unreachable in the
  corpus, and accepting it needs the INSTANCE registry to dedupe on structural
  argument equality rather than this compare to look further.
- **`typeAccepts` is ASSIGNABILITY and is NOT the equivalence.** The two
  widenings the language has - `null` into any raw pointer, and a typed
  `unsafe_ptr<T>` into the opaque one - apply at the TOP LEVEL and nowhere
  inside a wrapper. `ref unsafe_ptr<uint8>` into a `ref unsafe_ptr` is refused,
  and so is `unsafe_ptr<uint8>[]` into `unsafe_ptr[]`, because the callee could
  store an opaque pointer through either and break the promise the caller still
  holds. Both halves match the reference, established by probing it. The split
  is two functions in `typecheck/type_eq.yoop`: `sameTypeStructurally` is the
  equivalence, `typeAccepts` is that plus the two widenings. Do not reach for
  `==` when a Func can be anywhere on either side.
- **A type in a diagnostic has to READ as the type.** `formatType` answering
  `<type>` turns a real mismatch into "X is not X", which is unactionable - the
  reader cannot tell a compiler bug from their own. Two of those were live:
  every pointer type rendered as `<type>`, and every Func rendered as `() => R`
  with its parameters gone, because `formatTypeList` built into a `disposable`
  Text and returned `text.view` of it - a borrow of storage freed one line
  earlier. A diagnostic is built on a compile that is already failing, so it
  builds with template literals and leaks like every other one in the layer.
- **A `(` in a type annotation is a function type only when the next token is
  `)`, `ref`, or `IDENT :`.** Otherwise it is a parenthesized GROUP, whose only
  job is attaching `[]` - a return type is parsed greedily, so `(k: K) => V[]`
  returns an array and `((k: K) => V)[]` is an array of functions. Parameters
  must be NAMED, which is what makes the fork decidable at one token.
- **A call through anything but a name or a field is REFUSED.** `fns[0](x)` and
  `g()(x)` have no lowering, and emitting one anyway drops the arguments and
  makes the function pointer itself the value.
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
  FUNCTION_DECL has all five earlier slots spoken for, kind prefixes included
  (childE). One slot, one meaning - do not overload it.
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
- **A function carrying a PAUSABLE kind is a COROUTINE**, and emitting it as an
  ordinary function would compile, link and then never suspend - a silent
  miscompile rather than a missing feature. `provides Task` on the same kind
  additionally makes the CALL site a spawn, and on a binding `refcounted` and
  `mustCall` pick a task handle's storage. Those are the only kind clauses
  anything reads; every other one is recorded and understood by nobody.
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
- **A Display interpolation SPILLS its receiver to an anonymous slot.**
  `toString` takes `ref self`, and a borrow is the address of storage that
  exists - but an interpolated expression is a VALUE, and `${f()}` or
  `${p.inner}` has none of its own. Same anonymous-slot pattern a kind region's
  subject uses, and the alloca hoists like every other. Without it the useful
  half of the feature (interpolating anything but a named binding) would have to
  be refused.
- **A built string is libc, not std** - `strlen` / `malloc` / `memcpy` /
  `sprintf`, all in `codegen/instr_str.yoop`. The JS reference routes through
  std's `stringConcatAll` and `format.intToString`, which the bootstrap cannot
  reach until a 9-file slice of std compiles. Both bottom out in a raw malloc
  plus byte copying, so the observable result is the same, including that a
  built string ignores the allocator context. `codegen/template.yoop` is the one
  place that changes when std becomes reachable. An interpolated FLOAT is
  `sprintf` with `%g`, which is exactly what the reference's runtime helper
  `yoop_float_to_string` is - so `${1.5}` is "1.5" and `${4.0}` is "4", with no
  decimal point on a whole number.
- **A template literal handed DIRECTLY to `printf` as its FORMAT renders
  differently in the two compilers, and it is not about floats.** The reference
  has a printf special case that turns a template in format position into
  `printf("x=%f", x)` - C's own conversions - while the bootstrap builds the
  string first and passes the result as the format. So a float prints as
  "3.140000" there and "3.14" here, and a bool as "1" there and "true" here.
  Route it through a `%s` and a template ARGUMENT instead and both agree, which
  is what every slice fixture does; six programs in `examples/pass/` do not, and
  print differently under the two compilers. Note the bootstrap's version is
  also unsafe in a way the reference's is not: a built string containing a `%`
  becomes a conversion specifier.
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
- **`declOf` looks through an ATTRIBUTE as well as an `export`, and so does
  `isExportDecl`.** The two wrappers nest in one order only - the `@` is written
  ABOVE the `export` - so a naive `kind == EXPORT_DECL` test answers no for
  every decorated declaration, and pass A would register it as unexported. One
  unwrap, one place, which is the whole reason `declOf` exists.
- **An import is module-scoped and IDEMPOTENT.** A directory module's files each
  import what they use, so one alias is bound once per file that mentions it -
  `vec` twenty times in codegen. Re-binding it to the SAME module is the same
  import written again and is a no-op; binding it to a DIFFERENT module under
  one name is a real collision and stays refused, as does importing over a
  declaration. Imports are NOT file-scoped, here or in the reference; both
  halves were established by probing it. Note the asymmetry in how sameness is
  tested: a namespace compares by MODULE INDEX, because every `import * as ns`
  interns its own `Symbol.Namespace` and two identical imports never share an
  id, while a named import compares by SymbolId, because it binds the source
  module's own. Check membership BEFORE interning, or a duplicate leaves a dead
  symbol behind.
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

A program whose emitted IR calls nothing in the yoop runtime links only libc,
which keeps the link step a single clang invocation. The runtime's C sources go
on the line only for a program that needs them - see `link_flags.yoop`.

## Parity with the JS reference

Each layer boundary gets a deterministic dump that both implementations emit in
the same format, and a harness that diffs them. Layer 1 has one:

    npm run test:parity

It compiles `tools/dump_tokens.yoop`, then diffs its output against
`src/dumpTokens.js` over `tests/parity/` plus every `.yoop` file in `std/`,
`bootstrap/` and `examples/`. To eyeball one file:

    diff <(node ../src/yoopiler.js FILE --dump-tokens) <(/tmp/dump_tokens FILE)

Two things the token dump deliberately does not compare, both documented in
src/dumpTokens.js: int literals past 2^53, and non-ASCII spans. Float VALUES are
compared, as the 64-bit pattern rather than as a decimal rendering, which is
what makes them comparable at all.

**There is no layer 2 (AST) parity.** The two ASTs are not the same shape: this
side wraps variable-arity children in NODE_LIST nodes and makes type annotations
real AST nodes, while the JS parser uses plain arrays and a separate annotation
object. A parse dump would have to normalize both into one tree before anything
could be diffed.


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
    region.yoop             the two forms where the scope IS a block
    borrow.yoop             opening a `ref T` into the T it points at
    const_data.yoop         module consts that need a module-level datum
    link_flags.yoop         what the link line has to be told: libraries, and
                            whether the runtime's sources belong on it
    extern_table.yoop       ONE `declare` per symbol, shared by all four
                            things that declare one
    try_op.yoop             `expr?`: a tag test, an early return, an unwrap
    instr_str.yoop          the libc calls a built string is made of
    coro.yoop               the coroutine FRAME an `async` function opens
    instr_coro.yoop         the same, one function per `llvm.coro.*`
    await_op.yoop           `await`: the drive loop and the suspend primitive
    task.yoop               the task handle STRUCT, and what a spawn reads
    task_spawn.yoop         a `task` call site: fill a handle, submit it
    task_thunk.yoop         the per-task thunk, and the coro trampolines
    task_wait.yoop          `wait`, and what a handle binding owes its scope
    instr_task.yoop         the same, one function per runtime call

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

**Failures are `EmitResult`, and they propagate with `?`.** An emit function
returns `EmitResult.Ok` or `EmitResult.Err { message }` - never a bare string.
Reaching an `Err` means a pass ABOVE let something through, since every mistake
the user could make was reported by typecheck long before codegen ran.

    emitExpr(ref cx, argId, ref value)?;

The `Ok` case carries no payload, because these functions produce their result
through a `ref out` parameter rather than through the return. That is what makes
the call above a statement.

Not a bare `string` with `""` meaning success: `""` is an ordinary string, so a
check written against the wrong local, or testing the length the wrong way
round, is not a type error anywhere in the layer.

Eighteen sites test the outcome by hand, with `emitFailed(err)`, and they
are all the same shape: a walk holding a SCOPE it has to pop on the way out
(`emitBlock` and the region and loop forms around it), where returning through
`?` would leave the dispose and locals stacks unwound. There is exactly one
DELIBERATE discard, written `_ = emitConcatParts(...)` in `try_forms.yoop`, in a
helper that is total by design - written that way so it reads as a decision
rather than an oversight.

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
    node ../src/yoopiler.js --test src/parse
    node ../src/yoopiler.js --test src/source_graph
    node ../src/yoopiler.js --test src/typecheck
    node ../src/yoopiler.js --test src/codegen
    npm run test:slice                            # end-to-end executables
    npm run test:parity                           # layer dumps vs the JS side

A yoop unit test lives beside the module it covers as `*.test.yoop`, which is
excluded from the module's file list, so it reaches its module through the same
import path a consumer writes. `src/source_graph` is the one that reads files
from disk: `tests/graph/` holds programs whose import structure is the point,
all of them refusals, plus the `tests/slice/imports.yoop` diamond read back for
its topological order.

A slice fixture is a program plus a hand-written `.expected` holding its stdout
and an `exit=N` line. The `.expected` is the source of truth: it is asserted
against the BOOTSTRAP first, and the JS reference is checked against the same
file as a bonus. Never capture one from compiler output.

Beside them are two PROBES, which are measurements rather than tests - nothing
fails, they print a report:

    scripts/probe_surface.sh    every non-test file under std/, examples/pass/
                                and bootstrap/src/, compiled to IR and no
                                further. Says whether codegen HANDLED the file
    scripts/probe_programs.sh   every entry point under examples/ that declares
                                a `main`, built with BOTH compilers and RUN,
                                stdout and exit code compared. Says whether the
                                program WORKS

Run both after a change, and run each with stage1 and stage3. They cover
different sets on purpose and neither may move the other's numbers.

## Layer 6 parity

`npm run test:slice` compiles every program in `tests/slice/` with BOTH
compilers and asserts identical stdout and exit code. It exercises every layer
at once.

Five divergences, worth knowing because the bootstrap is the one that is right
in all five - and worth WRITING DOWN, because once the reference is gone there
is nothing left to notice them against.

  * `printf("%d", 2 + 3)` is an error in the JS reference ("this expression
    still has an unpinned literal type"). The bootstrap's pass D defaults an
    unconstrained untyped int literal to int32.
  * `n += 1` ON A `ref` SCALAR PARAMETER. The reference emits `add ptr %n, 1`,
    never opening the borrow, and clang refuses the module; `n = n + 1` on the
    same parameter is fine. The bootstrap compiles both.
  * `n += 1` ON A `ref` SCALAR PARAMETER. The reference emits `add ptr %n, 1`,
    never opening the borrow, and clang refuses the module; `n = n + 1` on the
    same parameter is fine, which is what makes it easy to hit and easy to miss.
    The bootstrap compiles both.
  * INT LITERALS PAST 2^53. The reference carries them as JS numbers and rounds
    them in the lexer; nothing downstream can recover the value. This is not a
    curiosity: the FNV-1a offset basis in std/core/strings.yoop is one, so under
    the reference every string in every program hashes wrong and a Map iterates
    in an order that follows. `tests/slice/wide_int_literals.yoop` pins it.
  * `${x}` ON A uint64 renders SIGNED under the reference. Same fixture.
  * `${b}` ON A bool renders `1` / `0` under the reference and `true` / `false`
    here; `${f}` on a float renders `3.500000` there and `3.5` here. Between
    them these account for 22 of the 23 lines `scripts/probe_programs.sh`
    reports as DIFFER.
