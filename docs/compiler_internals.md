# Yooperlang compiler internals

Everything around the compiler that is not the compiler's own source tree: the C
runtime, the concurrency ABI, the installed and packaged layout, the parts of
std worth knowing before editing them, the pipeline's layer boundaries, and the
cross-cutting invariants every stage holds to.

Three documents carry the rest, and you usually want one of them instead. The
compiler's own module map - what lives in which directory of
[bootstrap/src/](../bootstrap/src/), the language subset it accepts, how to
build and run it - is [bootstrap/README.md](../bootstrap/README.md). How to
WRITE Yoop (std, the compiler itself, tools, examples) is
[writing_yoop.md](writing_yoop.md). The language is [SPEC.md](../SPEC.md).

Pipeline: source `.yoop` -> **lex** -> **parse** -> **typecheck** -> **codegen**
(LLVM IR) -> `clang` -> executable.

---

## Packaging and data-file resolution

The compiler is a native binary, and it reads two directories it does not carry
inside itself: `std/` (the .yoop standard library, opened by the module graph
loader) and `runtime/` (the C translation units handed to clang). `npm run
package:boot` ([scripts/package_bootstrap.mjs](../scripts/package_bootstrap.mjs))
produces the layout the binary probes for:

```text
<prefix>/bin/yoopiler_boot
<prefix>/lib/std/
<prefix>/lib/runtime/
```

- **The runtime `.c` files can never live in a virtual filesystem.** clang is a
  separate process, so it needs real paths on a real disk. No bundling trick
  removes `lib/runtime/` from the package; the C sources ship as ordinary files
  and always will.
- **Discovery is executable-relative, and `YOOP_STD_ROOT` / `YOOP_RUNTIME_ROOT`
  override it.** `discoverStdRoot`
  ([bootstrap/src/source_graph/std_root.yoop](../bootstrap/src/source_graph/std_root.yoop))
  and `discoverRuntimeRoot`
  ([bootstrap/src/link/runtime_root.yoop](../bootstrap/src/link/runtime_root.yoop))
  check the override first, then `<exeDir>/../lib/<name>` and the flat variant
  beside the binary. Both always RETURN a path even when nothing is there, so a
  broken install fails as a readable "not found" naming a directory rather than
  as a load-time crash deep in the module graph. The two env vars are also how
  a stage binary sitting in `build/` is pointed at this working tree, which is
  what every test harness and `scripts/probe_surface.sh` do.
- **The std root is found up front; the runtime root is found LAZILY.** A
  program that only calls libc links with nothing but its own IR, so the
  runtime is located at the moment codegen reports it emitted a call into it.
  One consequence worth knowing: a missing `lib/runtime/` is invisible until a
  program uses the runtime.
- **Packaging proves the layout rather than asserting it.** `package:boot`
  builds three stages, refuses to go on unless stage2 and stage3 are
  byte-identical (IR and binary both), stages `bin/` beside `lib/std` and
  `lib/runtime`, and then compiles and runs hello.yoop with the PACKAGED binary
  and both env overrides deleted from the environment. That last step is the
  only one that can catch a package which works solely because the person
  building it had `YOOP_STD_ROOT` exported. Output is
  `dist/yoopiler-boot-<version>-<platform>.tar.gz` plus a sha256.
- **Building starts from a SEED.** The compiler compiles itself, so a build
  needs a Yoop compiler that already exists: a previously released
  `yoopiler_boot`, resolved by [scripts/seed.mjs](../scripts/seed.mjs)
  (`YOOP_SEED` points at an explicit one, `.seed/` caches a download, and
  `node scripts/seed.mjs` prints the path it would use). `SEED_TAG` in that file
  is a fact about THIS tree - it names the release that can compile this source
  - so raising it is a deliberate edit whose pull request has to prove the new
  seed builds the tree.
- **[src/install_root.js](../src/install_root.js) locates `runtime/` for Node,
  and only for Node.** It is what [src/runtimeBuild.js](../src/runtimeBuild.js)
  and the C runtime suite ([src/runtimeC.test.js](../src/runtimeC.test.js)) use
  to find the C sources when they build them without involving the compiler at
  all. It has nothing to do with how a compiled program finds its runtime.

## Subsystem map

The compiler's own directories are mapped in
[bootstrap/README.md](../bootstrap/README.md). What follows is everything else
that has internals worth writing down.

### [runtime/](../runtime/) - the C runtime (~2,600 lines)

Linked into every compiled program. The source list the compiler hands clang is `runtimeSources` in [bootstrap/src/link/runtime_root.yoop](../bootstrap/src/link/runtime_root.yoop), and it is deliberately the WHOLE set rather than what a program uses: yoop_runtime.c calls into the I/O and net files, which call into their own, so tracking the subset would mean maintaining a copy of the C files' dependency graph. `yoop_tls.c` is the one exclusion - it includes <openssl/ssl.h>, so linking it unconditionally would make OpenSSL a build requirement for every program that allocates; it comes back as a GLUE source for a program that named OpenSSL. **Adding a `.c` file means adding it to three lists**: that one, `RUNTIME_SOURCES` in [src/runtimeBuild.js](../src/runtimeBuild.js) (what the C test suite builds), and the mirror list in [runtime/tests/run_tests.sh](../runtime/tests/run_tests.sh). The scheduling contract - handle layout, the runtime ABI, and the refcount lifecycle - is [The concurrency runtime](#the-concurrency-runtime) below.

- [yoop_platform.h](../runtime/yoop_platform.h) - the platform shims (`yoop_mutex_t` / `yoop_cond_t` / `yoop_thread_t` plus their inline ops), shared by every TU. **`yoop_cv_wait_until_locked` is the one timed wait in the runtime** - Linux gets `CLOCK_MONOTONIC` condattrs + an absolute timespec, macOS uses `pthread_cond_timedwait_relative_np` (no `pthread_condattr_setclock` there), Windows keeps relative ms. Anything that blocks with a deadline goes through it, which is what stops the deadline clock and the condvar clock from drifting apart.
- [yoop_runtime.c](../runtime/yoop_runtime.c) - worker pool, task submit/wait, pooled refcounts, park tokens, timers, errno bridge. **`yoop_now_ns` is monotonic on all three platforms** and is the base for every deadline; `yoop_wall_ns` is the separate wall-clock reading and must never be used as a deadline base.
- [yoop_cancel.c](../runtime/yoop_cancel.c) - cancellation tokens: a cancelled flag, an optional deadline, a waiter list, and parent/child links. **There is deliberately no timer thread** - a deadline fires because every blocking call folds the token's deadline into its own timed wait via `yoop_cancel_effective_deadline`. The cascade in `yoop_cancel_request` snapshots children under the parent's lock (with a try-retain that skips a child already being destroyed) and then drops the lock before touching any of them, so a deep chain never holds two token mutexes at once.
- [yoop_io.c](../runtime/yoop_io.c) - the kqueue/epoll multiplexer, plus assorted stat/dirent helpers. See the invariant below.
- Others: `yoop_net.c` (the `yoop_sock_*` shims and socket constant helpers), `yoop_alloc.c` (arena + per-thread allocator), `yoop_fs.c` (filesystem and dirent helpers), `yoop_time.c`, `yoop_atomic.c`, `yoop_debug.c`, `yoop_format.c`, `yoop_args.c`, plus the two GLUE translation units a program only gets by naming a library: `yoop_tls.c` (OpenSSL) and `yoop_gl_win32.c` (OpenGL on Windows).
- C-level tests in [runtime/tests/](../runtime/tests/), run both by `sh runtime/tests/run_tests.sh` and from [src/runtimeC.test.js](../src/runtimeC.test.js) (so `npm test` covers them). A new test needs adding to **both** lists.

### [std/http/](../std/http/) - the HTTP layer (~1,800 lines of yoop)

**All seven files are ONE module** (each declares `module http;`) - see the directory-modules invariant below. Consequences when editing here: the files do NOT import each other, every declaration is visible across all seven, symbols mangle as `http_<hash>__<name>`, and **[wire.yoop](../std/http/wire.yoop) exports nothing at all**. File roles and the invariants that cross them:

- [types.yoop](../std/http/types.yoop) - the vocabulary: `HttpMethod`, `StatusCode` (implements `Display`), `Headers`, `Params`, `Request`, `Response`, `ResponseBody`, and `HttpError`. **`HttpError` carries the status the client should see**, which is what lets a failure detected deep in the parse arrive as a 400 instead of a blanket 500; it implements `WithContext<HttpError>` so `expr? "ctx"` stacks context without flattening the status away.
- [wire.yoop](../std/http/wire.yoop) - INTERNAL. Message building (`pushStr`, `pushHeaderLine`) and the one shared header-field reader. Server and client both go through it, which is what keeps the two directions from drifting. **`readHeaderLines` scans to `headEnd + 2`**: `findHeadEnd` points at the CR terminating the LAST header line, so a scan bounded by it silently drops that field.
- [url.yoop](../std/http/url.yoop) - target splitting, percent coding, urlencoded name/value parsing (query strings and form bodies share a grammar). **Split first, decode after** - and `decodePath` rejects an encoded separator (`%2F`, `%5C`) rather than decoding it, so `req.path` stays one safely-routable field.
- [parser.yoop](../std/http/parser.yoop) - `parseRequestHead` / `parseResponseHead`, both `Result`-returning and both socket-free (they parse a byte buffer, report where the body starts, and let the caller read it).
- [server.yoop](../std/http/server.yoop) - `Handler` trait, the `Dispatcher` vtable, `ServerConfig`, and the accept loop. **The loop is not generic** - it takes the erased `Dispatcher`, so there is one copy in the binary and the per-connection work could be split into named functions. **A bad client costs its own connection and nothing else**; only a listener failure ends `serve`. The server owns framing (`Content-Length` / `Connection` / `Transfer-Encoding` are written here and skipped from the handler's list). `Dispatcher.from(ref h)` stores a POINTER to `h`, so handlers must outlive the route table, and it needs a concrete struct receiver (a type parameter is rejected), which is why there is no generic `serveN` wrapper.
- [router.yoop](../std/http/router.yoop) - `matchPath` (literal segments, `:name` captures, a trailing `*`), first-registered-wins, 405-with-`Allow` vs 404, HEAD falling through to GET. The installed fallback renders both the 404 and the 405 with `resp.status` pre-set.
- [client.yoop](../std/http/client.yoop) - `Client` + `send` / `get` / `post` / `put` / `delete`, `Result<ClientResponse, HttpError>`. Bounded by `maxResponseBytes`; no TLS, no redirects, no pooling.

Consumers: [examples/pass/hello_server](../examples/pass/hello_server), [http_router](../examples/pass/http_router), [http_client_loopback](../examples/pass/http_client_loopback), [http_parse_smoke](../examples/pass/http_parse_smoke), [http_url_smoke](../examples/pass/http_url_smoke), and the CRUD demo at [examples/playground/todo_api](../examples/playground/todo_api).

### [modules/](../modules/) and [tools/yoopdist/](../tools/yoopdist/) - modules outside std

- **[modules/](../modules/) is a program-owned import root, and the repo root is one.** `modules/<name>` resolves by walking up from the IMPORTING file to the nearest `modules` directory, then through the same tail the `std/` branch runs (so a directory module, a module under a grouping directory, and a single `.yoop` file all work with no code of their own). Anchoring on the importing file rather than the entry point is what lets one import line resolve against a sibling `modules/` while a module is being developed and against the consumer's flat `modules/` once installed, with **no rewriting**.
- **Dependencies are FLAT and that is enforced.** A module directory carrying its own `modules/` directory is a hard error. Two copies of one module would LINK fine (`moduleId` hashes the path, so the symbols differ) and then fail as two distinct nominal types - `Value` is not assignable to `Value`. The error names both directories rather than leaving that to be discovered.
- **This root is PROGRAM-relative and must never become a compiler-install prefix.** `std/` and `runtime/` ship with the compiler and are found relative to the binary; `modules/` belongs to whoever is being compiled and is found relative to the source.
- **A module's tests ship inside its directory.** `*.test.yoop` is excluded from a directory module's source list, so the test file is its own module and imports the module under test by the same `modules/<name>` path a consumer writes. Worked example: [examples/modules_demo/](../examples/modules_demo/).
- **[tools/yoopdist/](../tools/yoopdist/) is written in Yoop** and builds the directory a user installs: copies sources + tests, skips `modules/`, regenerates the `requires` block of the advisory `MODULE` file. The author owns `name`/`version`; the tool owns the dependency snapshot and **preserves a version it cannot verify** rather than downgrading it to `unknown`. Nothing in the compiler reads `MODULE`.
- `MODULE` is extensionless, so [.gitignore](../.gitignore) needs an explicit `!MODULE` (same as `!LICENSE`) or the blanket `*` rule drops it.


## The concurrency runtime

What the compiler emits, what gets linked, and how the two meet. The language
surface (the `task` / `async` kinds, `wait`, `await`, the binding forms) is
[SPEC.md](../SPEC.md) sections 6 and 8; this is the implementation contract
underneath it, implemented in [runtime/yoop_runtime.c](../runtime/yoop_runtime.c)
and emitted by [bootstrap/src/codegen/](../bootstrap/src/codegen/) (the task
half is task.yoop, task_spawn.yoop, task_thunk.yoop and task_wait.yoop; the
coroutine half is coro.yoop and await_op.yoop).

`async` functions and `await` lower to LLVM switched-resume coroutines, so a
task blocked on I/O releases its worker thread instead of holding it. `std/net`
and `std/http` are async top to bottom -
[examples/pass/async_server_smoke/](../examples/pass/async_server_smoke/) runs an
HTTP server plus three concurrent clients on ONE worker thread, and async trait
methods work through generics and vtables. The coroutine ABI itself is under
"Cross-cutting invariants" below; what follows is the scheduling side.

### The worker pool

A central FIFO queue plus N worker threads, the queue protected by one mutex and
one condvar. Workers `cond_wait` while it is empty; a submitter broadcasts on
push. N defaults to the online CPU count (`sysconf(_SC_NPROCESSORS_ONLN)` on
POSIX, `GetSystemInfo` on Windows), `YOOP_NUM_WORKERS` overrides it, and
`runtime.setWorkerCount(n)` ([std/runtime.yoop](../std/runtime.yoop)) overrides
that from source. **Workers are spawned lazily on the first task submit**, which
is why `setWorkerCount` only takes effect before any task starts and returns
false once the pool is live: shrinking a running pool would mean stopping
threads that may be mid-task. `YOOP_NUM_WORKERS=1` serializes everything, which
is the first thing to try when a concurrency bug will not reproduce.

### Where a handle lives, and why it differs per binding

The binding kind at the call site decides the storage:

- `let x = f()` (immediate) - stack alloca, no refcount. Spawn and wait happen
  in the same statement, so there is one owner and no escape.
- `let joined d = f()` - stack alloca, no refcount. The injected join fires
  before scope exit, so the binding and the worker's interest end together.
- `let pooled h = f()` - `yoop_task_alloc` (heap), refcounted. The handle is a
  value-typed citizen: returnable, storable, copyable, and its lifetime can
  exceed the declaring scope.

For `pooled`, codegen special-cases `Task<T>` at every assignment, return,
parameter pass and scope exit to emit the retain/release pair. That is an
ARC-like mechanism scoped to `Task<T>` alone; **no other type in the language is
refcounted.** Heap-allocating all three would be uniform but wasteful: the other
two have lifetimes bounded by the frame, the kind system already proves they
cannot escape, and a stack alloca is one instruction against a malloc plus a
later free plus allocator contention.

### The handle layout

Codegen emits one `%Task_<moduleId>__<fnName>` struct per task FUNCTION. Offsets
0 through 47 are the runtime-owned prefix and are hard-coded in
`yoop_runtime.c`; everything from 48 belongs to the compiler:

```text
0   ptr    thunk - void (*)(void*)
8   i8     state: 0 = unstarted, 1 = done (atomic)
9   i8     cancel flag
10  i8     park state: 0 = running/queued, 1 = wake pending, 2 = parked
11  i8     spare
12  i32    refcount (atomic; 0 = stack handle, >= 1 = pooled)
16  ptr    per-handle mutex (heap)
24  ptr    per-handle condvar (heap)
32  ptr    coroutine handle for the async body
40  ptr    allocator context (runtime-owned, may be null)
48  <T>    result slot
..  args   one field per task-function parameter
```

**The mutex and condvar are heap POINTERS rather than embedded values** because
`pthread_mutex_t` and `CRITICAL_SECTION` have different sizes, and embedding
them would force codegen to know platform layout. `yoop_task_submit` allocates
and initializes the pair; `yoop_task_free_sync_pair` (reached from
`yoop_task_wait` for a stack handle and from the final `yoop_task_release` for a
pooled one) destroys and frees it.

Every new slot in the prefix has been APPENDED rather than inserted, which is
what keeps the offsets the C runtime hard-codes valid across a change. See the
cross-cutting invariant below for the five codegen sites a move of the result
slot touches, and for the `_Static_assert`s the fake handles in
[runtime/tests/](../runtime/tests/) carry.

### The runtime ABI

The C symbols codegen emits `declare` lines for. Prototypes are in
[runtime/yoop_runtime.h](../runtime/yoop_runtime.h).

- `yoop_runtime_init()` / `yoop_runtime_shutdown()` - init is idempotent behind a
  flag and also puts stdout/stderr into binary mode and starts Winsock; shutdown
  signals the workers to exit, joins them and drains the queue.
- `yoop_task_submit(handle, thunk)` - allocate the handle's mutex and condvar,
  clear its state, push it on the queue. The caller has already populated the
  thunk pointer and the argument fields. The thunk is passed explicitly as well
  as stored on the handle, so the queue never has to GEP into it.
- `yoop_task_wait(handle)` / `yoop_task_wait_until_ns(handle, deadline_ns)` - the
  blocking joins.
- `yoop_task_alloc(size)` / `yoop_task_retain` / `yoop_task_release` - the pooled
  lifecycle.
- `yoop_handle_signal_done(handle)` - publish completion.
- `yoop_task_settle`, `yoop_task_make_runnable`, `yoop_runtime_set_coro_ops`,
  `yoop_current_task` - the coroutine-scheduling half, covered by the
  cross-cutting invariants below.

**Refcount lifecycle for a pooled handle**: `yoop_task_alloc` starts it at 2
(caller plus worker); submit changes nothing, because the worker's reference is
the second one from alloc; every copy or assignment retains; every scope exit
releases; the thunk releases after storing its result and signalling; at 0 the
mutex, condvar and handle are freed. **`yoop_task_wait` does NOT release the
caller's reference** - the binding still owns it and the binding's scope exit
handles it. Waiting and then dropping therefore costs two ref ops, which is
deliberate: it lets a caller wait, read the result, and still hand the handle
somewhere else.

### The thunk, and how a result gets home

The worker never calls a task body directly. Codegen generates a **thunk** per
task function that unpacks the arguments from the handle at known offsets and
drives the body's coroutine. The body is handed the task's OWN result slot as
its `__ret`, so a finished coroutine has already written its result where `wait`
looks, with no copy. `yoop_task_settle` is the single place "finished versus
suspended" is decided, after the initial start and after every resume.

`yoop_handle_signal_done` publishes completion: it takes the handle's mutex,
stores state = 1, broadcasts the handle's condvar, then broadcasts `queue_cv`
(so a `wait` parked there wakes immediately rather than on a poll tick), hands
any task that suspended joining this one back to the queue, and releases the
worker's reference if the handle is pooled.

### Waiting

`yoop_task_wait` is re-entrant rather than a plain condvar park: it checks the
target's state, and while the target is unfinished it pops and RUNS queued tasks
on the calling thread, only parking on `queue_cv` when the queue is empty too,
and re-checking state after taking the queue lock so a completion broadcast that
raced the loop is not missed. That is what stops a chain of nested waits deeper
than the worker count from deadlocking the pool. `yoop_task_wait_until_ns` does
NOT drain the queue: a queued task that ran past the deadline would break the
caller's "give up at time T" contract, so it parks on the condvar with the
deadline as its timeout and lets the workers do the draining.

### Init and shutdown injection

Codegen puts `call void @yoop_runtime_init()` at the top of `main`'s entry
block, before any user code, and `call void @yoop_runtime_shutdown()`
immediately before every `ret` in `main`, including the ones reached by a `?`
early return. A program that exits through an FFI `exit(...)` never reaches
shutdown; the OS reaps the worker threads, which is safe because they own
nothing outside their own stacks.

### What the runtime does not do

- **No work-stealing.** One central FIFO, and every worker contends on its
  mutex. Per-worker queues plus stealing is the answer if profiling ever
  justifies it, and the ABI does not have to change for it.
- **No structured exception handling.** A task body that crashes (segfault,
  abort, an unhandled FFI failure) leaves its handle's state at 0 forever, and
  anything that waits on it blocks forever. There is no crashed state.
- **Cancellation never interrupts a body.** `cancel(h)` and a cancellation token
  both stop the WAIT; the body runs to its natural end unless it polls the token
  itself.


## Cross-cutting invariants

The things that aren't obvious from reading any single file - read this section before editing across stages.

- **A module is a single file OR a DIRECTORY of files that each declare `module <name>;`.** Directory modules today: [std/core/cancel/](../std/core/cancel/), [std/db/sqlite/](../std/db/sqlite/), [std/net/](../std/net/), [std/http/](../std/http/). Everything else is still one-file-one-module, including all of [std/core/](../std/core/) and [std/collections/](../std/collections/) (deliberately - those are directories OF modules, the way Odin's `core:` is a collection rather than a package).
  - **A SOURCE FILE stays the compilation unit; only the namespace moves to the directory.** Each file keeps its own source text, its own AST root and its own absolute path, so every diagnostic and every DWARF compile unit names the file the user edited. What the files SHARE is the module: one symbol table, one id, one mangling prefix. Identity is the resolved DIRECTORY path - the declared name is only a label, so two directories may declare the same name and stay distinct modules.
  - **Declarations are shared; IMPORTS are not.** Siblings see each other's decls (exported or not, which is the whole point), but using a name only a SIBLING imported is an error. That is an enforcement pass rather than lexical per-file scope: the declarations really are one namespace, and the import check is layered on top so a reader of one file can still see where every name it uses came from.
  - **`import.unsafe;` / `import.test;` stay PER SOURCE FILE.** That is what lets [std/core/cancel/ffi.yoop](../std/core/cancel/ffi.yoop) name `unsafe_ptr` while its sibling token.yoop may not.
  - **Importing one source file of a directory module is an error** - the module is the unit, so `import ... from "std/http"`, never `"std/http/server.yoop"`. A mixed directory (a file missing the header) is an error too.
  - **Codegen runs once per SOURCE FILE, so a module-scoped symbol it generates for itself needs a per-file tag.** The module-init function (`@<moduleId>__module_init<fileIndex>`) and the string and array literal globals are the families that carry one. The mirror hazard is a symbol that must be declared exactly ONCE per LLVM module - an `extern` declaration, a shim - which has to be deduped on the emitter instead. Getting either backwards is a duplicate definition or a missing one, and clang is what finds both.
  - **A per-MODULE index built inside a per-FILE loop must MERGE, and both directions of getting this wrong fail silently.** The loop body sees one source file; the index is keyed by module id, which siblings share. Overwriting drops every sibling's entry, and consulting a file-local set answers "no" for a name a sibling declared. Two real ones, neither caught by any earlier stage: a kind-marked sink declared in a sibling file stopped being enforced, with no error and no warning; and a sibling's call to an `extern "C"` symbol emitted a `<moduleId>__`-mangled name that nothing defines, surviving typecheck AND IR generation and caught only when clang read the IR.
  - **Every name codegen generates for itself is a name a user binding can collide with**, because LLVM puts local values and basic-block labels in ONE namespace. A generated name containing a `.` (`%p.arg`, `%<name>.<slot>.addr`, `coro.body`, `await.done`) is safe by construction, since `.` is not legal in a yoop identifier - which is why slot names carry one. Anything spellable as an identifier (`t0`, `__ret`, a bare label hint) is not safe and needs a reserved-name list plus a rename of the colliding binding. `t0`/`t1` are the ones that actually bite, being natural names for timing code, and the symptom is an LLVM verifier error a hundred lines from the source that caused it.
  - **Pass C is GROUP-MAJOR, STAGE-MINOR**: every stage completes for all of a module's files before the next stage starts, because the files of one module have no declaration order between them. Running a stage across ALL modules instead does not work - trait signature resolution instantiates generics, and instantiation snapshots the generic decl.
  - **An index keyed by module id holds ONE file per module, so a name-by-name lookup against a single file's AST silently misses whatever a sibling declared.** Anything that walks declarations by name has to reach the whole module, and in both directions: the file being looked at, and any imported directory module.
  - **`module` is a contextual keyword, not a reserved word.** The header form `IDENT IDENT ;` is recognized only as the first item of a file, so `module` stays usable as a field or binding name. Anything colouring or matching the keyword has to anchor on that position too; a plain `\b(module)\b` miscolours every field named `module`.

- **Quote ownership: double quote = string, backtick = template literal, single quote = CHAR.** There are no single-quoted strings. A char literal decodes exactly one Unicode scalar (escapes `\n \r \t \0 \\ \' \"` and `\xNN`, plus astral scalars) and is lowered to an INT literal carrying the codepoint, so a char literal *is* an untyped int downstream: it pins to any integer type and range-checks like a numeric literal (`ch == '/'` against a `uint8`). There is no `char` type and no char AST node. Empty, multi-character and bad-escape literals are lex errors.
- **`printf` lowering: an explicit format-string LITERAL is authoritative.** A call whose first argument is a string literal is C `printf` - the literal's `%` directives own the varargs behind them, and trailing value args do **not** get an auto-appended specifier, or `printf("x=%d\n", x)` emits the format `"x=%d\n%d"` and reads a vararg nobody pushed. A specifier is synthesized in exactly two places: once per interpolation of a template literal, and once for a bare value argument when there is no format literal at all (`printf(someString)` -> `%s`). The reverse hazard is the same bug from the other side and is handled in the same place: `printf(<a runtime string>)` becomes `printf("%s", <it>)`, because a `%` in the DATA would otherwise be read as a conversion ([bootstrap/src/codegen/printf_format.yoop](../bootstrap/src/codegen/printf_format.yoop)).
- **`..` is lowered before typecheck, so no later stage has a range rule.** `a..b` is rewritten into `$range.exclusive(a, b)` with `import * as $range from "std/core/range.yoop"` injected onto the file's body ([bootstrap/src/parse/range.yoop](../bootstrap/src/parse/range.yoop)). The synthesized import resolves through the ordinary graph machinery, which is also what pulls range.yoop in - and only for files that use `..`. `$range` is unspellable in user source, so it cannot collide; same trick as the anonymous-region `$region$N` name. The consequences are the point: typecheck and codegen have no range rules at all, `Range` stays a plain userland type implementing `Iterable<usize>`, and `for i in 0..n` is the same walk any other iterable gets. Two things to keep in sync in the parser: inside brackets `..` is ALWAYS the slice separator (`xs[i..j]` parses both bounds at the range precedence so its own `..` stays visible), and chained bounds (`a..b..c`) are a parse error.
- **A `{` after an `IDENT.IDENT` in a for-in RHS belongs to the LOOP BODY.** While parsing a for-in iterable expression the variant-constructor postfix only fires when the brace looks like a payload (`{ <name> :`, which no statement can start with). Without that rule `for x in self.items {` is a parse error; with it, a genuine nested payload (`for c in iterOf(Shape.Circle { r: 3 })`) still parses as one. This is also why generated code prebinds an array to a local before looping over it.
- **`@derive(display)` generates SOURCE TEXT and reparses it.** The `Display.toString` it produces is written as ordinary Yoop from the declaration's field annotations, parsed by the ordinary parser, grafted onto the declaration, and `Display` merged into that declaration's `implements` clause ([bootstrap/src/parse/derive.yoop](../bootstrap/src/parse/derive.yoop) plus derive_text.yoop). Generating text rather than nodes means there is no second AST builder to keep in step with the first, and anything the parser learns later is inherited for free. It runs at LOAD time, right after a file is parsed, because that is the only point where the module's arena is reachable as something to write into - typecheck reads a module by value, so a node grafted later lands in a copy and codegen never sees it. Every location is restamped onto the real declaration, so no diagnostic points into text the user never wrote, and every generated local is prefixed `_derive` plus a slot so two fields cannot collide. **Field coverage**: prims and named `Display`-implementing types interpolate directly (refs deref); `T[]` and `Vec<T>` of such elements get generated loops; `Map`, function types and other generics print a fixed placeholder (`<map>`, `<fn>`) rather than failing. **Refused by name**: a GENERIC struct or variant (the method would have to be substituted through every instantiation), a type alias, and a declaration that already defines `toString`. **Variants** expand to an arm-per-case `switch (self)` whose output mirrors constructor syntax (`Shape.Circle { r: 5 }` / `Shape.Dot`), so a dump reads back as the source that would rebuild it. Per-case control is composition, never a hand-written method: declare the payload type OUTSIDE the variant with its own `Display` impl and the derived arm's interpolation dispatches to it. That is deliberate - it keeps variants free of hand-written methods, which is what lets the compiler skip generic-variant method substitution entirely.
- **`async` is a real color, and both halves of the rule are load-bearing.** An `async` function lowers to an LLVM switched-resume coroutine; `await` is the only way to call one, and `await` is only legal inside another async function or a `task` body (implicitly async). Together those two rules guarantee a suspend always has a coroutine frame to propagate into - which is the entire reason the LANGUAGE has to know about async rather than the runtime handling it alone (`llvm.coro.suspend` suspends one frame, and the blocking call is always several frames down). **Asyncness is part of a function's TYPE and part of signature equality**, so a sync impl of an async trait method is a mismatch - and it has to be threaded through every place a signature is rebuilt (self substitution, type-param substitution), each of which dropped it silently at first. **A `task` call site is a SPAWN, not an await** (it evaluates to `Task<T>`); that carve-out keys on the callee's declared return being a task type, without which every `pooled h = f()` reports as an un-awaited async call.
- **The async ABI: `define ptr @f(params..., ptr %__ret) presplitcoroutine`.** An async function RETURNS its coroutine handle and writes its declared result through a caller-owned slot, so the slot lives in the caller's frame and survives the caller's own suspends. Void async functions still take the (unused) slot - one ABI, not two. There is **no initial suspend**: calling an async function runs it eagerly to its first real suspend point, so a call that never blocks costs one frame allocation and no resume. Inside a coroutine body **`return` stores to `%__ret` and branches to the final-suspend block** rather than emitting `ret`. The entry block deliberately ends with `br label %coro.body` so the alloca hoist lands allocas AFTER `coro.begin`, which is where the coro passes expect frame-resident allocas.
- **The C runtime must never link against the coroutine trampolines by name.** `coro.resume`/`destroy`/`done` are LLVM intrinsics that C cannot call, so codegen emits three ordinary wrapper functions - but the runtime receives them as **function pointers** via `yoop_runtime_set_coro_ops` (installed by `main`), because `runtime/*.c` has to keep building standalone for [runtime/tests/](../runtime/tests/). With no ops installed a task is treated as finishing in one step (the pre-async behavior). The trampolines are emitted **once per program with external linkage**: every module is concatenated into one `.ll` so per-module copies are a redefinition, and `linkonce_odr` gets them deleted by globaldce since nothing inside the IR ever calls them.
- **The task struct's runtime-owned prefix runs to offset 48: coro handle at 32, allocator context at 40, result slot at 48.** Each is appended rather than inserted, on purpose - every offset the C runtime hard-codes is below the new one and stays valid. The thunk hands the body the task's OWN result slot as its `__ret`, so a finished coroutine has already written its result where `wait` looks, with no copy. `yoop_task_settle` is the single place "finished vs. suspended" is decided, and it runs after both the initial start and every resume. **Moving the result slot means touching every codegen site that names it, and some of them are BYTE OFFSETS rather than struct indices** (`getelementptr inbounds i8, ptr %h, i64 48` in the anonymous-`wait` and `waitUntil` paths) - a grep for the struct index alone misses them, and the symptom is every task result reading back as zero. **The fake handles in [runtime/tests/](../runtime/tests/) mirror this layout and must be updated with it**; they carry `_Static_assert`s on every offset, because when they drifted (still declaring `result` at 32) the runtime wrote through the coro and context slots past the end of the struct and the tests segfaulted rather than reporting a mismatch.
- **The ambient allocator context is per-THREAD, except while a task step is running, when it is per-TASK.** `run_task_step` ([yoop_runtime.c](../runtime/yoop_runtime.c)) saves the worker's own context, installs the task's from the handle's offset-40 slot, and writes back whatever the step left installed (discarding it instead when the step finished the task). Without that swap the ambient allocator stays on whichever worker ran the last step, and all three of these are silent: a parked task's arena is handed to the next unrelated task that worker picks up, a task resuming on a different worker allocates outside its own region, and its eventual `popAllocator` writes one worker's context onto another's. **This is not an async-only concern** - `yoop_task_wait` drains the queue re-entrantly on the calling thread, so a plain synchronous function holding an arena would otherwise run an arbitrary task inside its region. A spawned task deliberately inherits **nothing** from its spawner (an arena is a single-threaded bump pointer whose lifetime is its scope, so sharing it and outliving it are both unsound); the record is allocated lazily - on the suspend path, or on first temp use - so a task that neither suspends nor touches scratch never allocates one. **The temp arena rides the same record and follows the same rule** (`yoop_temp_handle` / `yoop_temp_reset`): a task's scratch is created on first use, destroyed with the task, and `resetTemp()` inside a task NEVER falls back to the thread's arena, because that would clear storage belonging to whoever dispatched it. Non-task threads keep a per-thread arena, unchanged. Fixtures: [async_arena_context.yoop](../examples/pass/async_arena_context.yoop), [arena_sync_wait.yoop](../examples/pass/arena_sync_wait.yoop), [task_temp_isolation.yoop](../examples/pass/task_temp_isolation.yoop).
- **Two of those fixtures depend on a blocking `hog` task pinned to one worker, and that is load-bearing.** `arena_sync_wait` and `task_temp_isolation` need main to be the thread that runs the task under test, so they occupy the single worker with a task doing `conc.sleepMs` (a BLOCKING call, deliberately not an `await`, which would hand the worker straight back) and let `yoop_task_wait`'s re-entrant queue drain do the dispatch. Without that the task lands on a worker whose thread-local state is already distinct from main's, and both fixtures pass against a broken build.
- **`wait` BLOCKS a thread; `conc.awaitTask(h)` suspends a task. Inside a task body only the second is legal.** `wait` lowers to `yoop_task_wait`, which parks the calling thread (its "suspendable wait" is re-entrant queue DRAINING, not coroutine suspension), so the typechecker rejects `wait` in a task body outright - a task joining another task that way would hold its worker while the target sat unstarted in the queue. `awaitTask` arms a completion interest, suspends, and resumes when the target finishes; **"await all" is an ordinary loop over it**, since each iteration frees the worker and completion order does not change the answer. Underneath: a `{target, waiter}` registry under `queue_mu` fired from `yoop_handle_signal_done` (which already holds that lock, so arming is provably ordered against completion), and **a fired waiter is disarmed COMPLETELY, not just for the target that fired** - one wake is all a task needs, and that rule is what makes a future first-of-N join correct. `armComplete` / `isDone` are intrinsics rather than externs because they take a `Task<T>`, which an `extern "C"` signature cannot name. There is no `TaskGroup` / `awaitAll` / `awaitRace`.
- **A wake can arrive before the task it targets has actually suspended, and the park byte at handle offset 10 is what makes that safe.** An interest is armed from INSIDE a running task (`awaitReadable` registers and only suspends several frames later; `awaitTask` likewise), so the event can fire while the task is still executing on its worker. Queuing the handle there let a second worker call `coro.resume` on a coroutine mid-execution on the first - a data race on the frame, not a lost wakeup. `yoop_task_make_runnable` therefore queues only from PARKED and otherwise records a WAKE that `run_task_step` consumes at the end of the step. Same three-state shape as the thread park token in the same file. It is most reachable on an already-ready fd (loopback).
- **A suspended task releases its worker; that is the whole point, and it is testable.** [examples/pass/async_yield_smoke.yoop](../examples/pass/async_yield_smoke.yoop) runs under `YOOP_NUM_WORKERS=1` and parks two tasks on two pipes simultaneously. If suspension stops actually freeing the thread, the single worker parks inside the first read and the test **hangs rather than fails**. The bridge is `conc.awaitReadable(fd)`: `yoop_io_arm_readable` registers a one-shot interest against the current task (thread-local, set by the worker around each step) and returns, then `await suspendNow()` parks the coroutine; the multiplexer calls `yoop_task_make_runnable` on readiness. `arm` returning **1** means "no current task" (called off a worker), and the caller must fall back to the blocking wait rather than suspend into a hole nothing can resume it from.
- **`Readable.read` / `Writable.write` are ASYNC, and that colors everything above them.** The chain is `ffiRecvAsync` -> `TcpStream.read` -> `Readable.read` -> `std/http`'s `readSome` -> `readHead`/`readBody` -> `exchange` -> `serveConnection` -> `serve`, so all of those are `async` and every entry point bottoms out in the sync/async bridge (`main` spawns a `task`, then `wait`s it). Two deliberate stopping points keep the blast radius down: **`Handler.handle` stays synchronous** (a handler takes a buffered request and fills a response - nothing to await), and **`Writable.flush` stays synchronous**. An in-memory implementer just declares `async` and never suspends - an async function that does no awaiting runs straight through on its first step. **Sockets must be `O_NONBLOCK`** for any of this to work (`newStream` and `ffiListen` set it), because the async path is "try the syscall, and on EAGAIN arm + suspend". A `TcpStream` carrying an ambient `timeoutMs`/token still routes to the BLOCKING cancel-aware helpers - that path parks a thread.
- **Divergence analysis ([bootstrap/src/typecheck/diverge.yoop](../bootstrap/src/typecheck/diverge.yoop)) is the single authority on "does control leave here", and it answers two questions.** It gates the `? e { ... }` handler block AND the missing-return check (the missing-return check, on functions and methods alike) - one analysis, so the two can't disagree. Non-obvious cases it MUST keep handling, each found by a real false positive: **`while (true)` with no escaping `break`** diverges (otherwise every accept/event loop reads as a missing return), and the escaping-`break` search stops descending at nested loops AND at `switch` (a switch arm's `break` targets the switch's end label, not the loop); **a block-owning kind's `trailingBlock`** counts, because `ephemeral scope(a) { ... return v; }` parses as a CONST_DECL carrying the block rather than a BLOCK statement, so the return is invisible to a naive walk (this is what [examples/playground/diskscope](../examples/playground/diskscope) `relayout` does). Everything unlisted answers false: over-reporting costs a user one explicit `return`, under-reporting lets a handler block fall through into an uninitialized binding. Adding a statement kind that can carry a body means adding it here. **It answers a third question too: dead code.** the first-unreachable-statement query in the same file is its dual (everything after the first diverging statement in a block is unreachable), called from the one funnel every block in the language passes through, so function/method bodies, if/loop/switch-arm bodies and a kind binding's `trailingBlock` are all covered by that single call site. The conservatism runs the right way for a diagnostic: it says `true` only when divergence is certain, so this never flags live code and only misses some dead code.
- **`expr? e { ... }` puts STATEMENTS inside an EXPRESSION, which is a shape nothing else in this compiler has.** The handler form runs a block on the Err path instead of propagating, so two things have to give. (1) **Codegen carries the enclosing statement context as ambient state**, because expression emission takes no context and the handler block needs the enclosing break/continue labels to lower a `break` or a `continue` - the same ambient-state pattern the coroutine trailer and the current return type already use. (2) **The block must diverge on every path**, decided by the divergence analysis: the block runs *instead of* producing a value, so a fallthrough would leave the binding it feeds uninitialized. An exhaustive `switch` counts, which is why exhaustiveness is stamped onto the statement when it is checked. The handler form deliberately does **not** require the enclosing function to return a fallible variant - that is the point of it, and it is what makes the form usable in `main` or in a handler returning a plain value. It also skips the pending-cleanup emission: whichever terminator the block uses fires the cleanups for ITS exit.
- **`await f(x)?` needs a parser swap, and `?` inside a coroutine is not a `ret`.** The postfix `?` binds inside `await`'s operand parse, so `await f(x)?` naturally parses as `await (f(x)?)` - backwards. `parseExpression`'s await branch detects a `TRY_OP` operand and swaps the two nodes (the ambiguity Rust spells around with `foo().await?`). Separately, the `?` early-return path in codegen has to store through `%__ret` and branch to the coroutine's final-suspend trailer; emitting a bare `ret` produced IR whose return value did not match the coroutine's `ptr` result type.
- **Async survives every dispatch form, each for a different reason.** A concrete trait call mangles as usual and carries the coroutine ABI. **Generics** work because monomorphization resolves an abstract receiver's bound method into a concrete callee before codegen sees it, so by then generic and concrete are the same thing; what that needs is asyncness carried through type-param substitution, and the async-callee note made from the generic call path too, which bypasses ordinary call resolution. **Vtables** work because the trait method's asyncness is stamped onto the slot's function-pointer type - users never write `async` on a `=>` annotation, and the trait is already the authority for the slot's params and return type.
- **The multiplexer's abandon handshake is `fired`-under-`io_mu`, and breaking it is a use-after-free.** A wait's state (`yoop_io_wait_t`) lives on the PARKING THREAD'S STACK, so once a wait can be abandoned (deadline or cancel) the I/O thread has to be provably done with it before that frame dies. The protocol: the multiplexer sets `fired = 1` and calls `yoop_unpark` **while holding `io_mu`**; an abandoning parker takes `io_mu` and checks `fired` - set means the multiplexer already finished (report ready), clear means the parker deregisters from kqueue/epoll and drops the table entry, after which the multiplexer can never reach the frame again. Registrations are keyed by a never-reused **sequence number**, not by the wait struct's address, because a later wait can land on the same stack address and a stale event would otherwise be misdelivered to it. Lock order is `io_mu` -> park-token mutex, never the reverse. Same rule for cancel tokens: `yoop_cancel_request` unparks under the token's mutex, so `yoop_cancel_remove_waiter` returning proves no unpark is still in flight.
- **One waiter per `(fd, direction)` in the multiplexer.** epoll's `EPOLL_CTL_MOD` and kqueue's `EV_SET` both *overwrite* the stored user payload, so a second concurrent registration silently stole the first waiter's wakeup and stranded it forever. A registration table rejects the second with `EAGAIN`. If you ever want genuine multi-waiter fds, that needs a per-fd waiter list plus a story for the thundering herd against BLOCKING sockets - not a one-line change.
- **`yoop_now_ns` is the monotonic deadline clock; `yoop_wall_ns` is the timestamp.** Every timed wait in the runtime goes through `yoop_cv_wait_until_locked`, which is pinned to the same clock, so `yoop_now_ns() + duration` is always a valid deadline. Using `yoop_wall_ns` as a deadline base reintroduces the bug where an NTP step moved every in-flight deadline.
- **A token deadline elapsing is `TimedOut`; only an explicit `request` is `Cancelled`.** `yoop_cancel_requested` folds both together (the "should I stop?" poll) while `yoop_cancel_flagged` isolates the explicit cancel - blocking calls that are *doing work* branch on the latter so the two reasons stay distinguishable at the call site. The exception is `yoop_cancel_wait`, which *observes* a token rather than doing work: there a token firing for either reason is `Cancelled` and `TimedOut` means the caller's own deadline won.
- **`TcpStream` carries ambient `timeoutMs` + `token` and is constructed in exactly one place.** `Readable.read` / `Writable.write` have fixed trait signatures, so per-stream deadlines ride on the struct (the `SO_RCVTIMEO` shape) rather than in the signatures - which is what lets all of `std/http` inherit timeouts with no change. Both default to off and the no-timeout path still calls the original `ffiRecv` / `ffiSendAll`. Every construction goes through `newStream(fd)` in [std/net/tcp.yoop](../std/net/tcp.yoop), so adding a field does not mean touching every accept/connect return. The trait methods have to squeeze a three-way outcome into `Result<c_ssize_t, string>` (a timeout arrives as `Err "timed out"`); callers that must distinguish use `tcpReadCt` / `tcpWriteAllCt` / `tcpAcceptCt` and get the `IoOutcome` / `AcceptOutcome` variants.
- **Windows is a supported target, and five of its rules are load-bearing.** The port is real (full `npm test` passes there), but it constrains what new code may call.
  - **The multiplexer is split per platform, Go-netpoll style, and Windows is a real IOCP backend.** [yoop_io.c](../runtime/yoop_io.c) is a platform-neutral core (registration table, seq identity, the fired-under-io_mu abandon handshake, public entry points); the engines are [yoop_io_kqueue.c](../runtime/yoop_io_kqueue.c), [yoop_io_epoll.c](../runtime/yoop_io_epoll.c), and [yoop_io_windows.c](../runtime/yoop_io_windows.c), behind the contract in [yoop_io_internal.h](../runtime/yoop_io_internal.h). Read that header before touching any of them - it carries the whole argument for why they are split.
    - **Readiness is not portable, so the shared contract is the OPERATION.** kqueue/epoll say "this fd is readable now, go call recv"; IOCP says "the recv you started has finished". The forcing discovery: **write-readiness cannot be expressed on IOCP at all** - a zero-byte `WSASend` completes immediately whether or not the send buffer has room, so there is nothing to wait on. Hence `yoop_iop_recv_begin` / `send_begin` / `accept_begin` + `yoop_iop_end`: POSIX implements them as "nonblocking syscall, on EAGAIN arm and retry on resume", Windows as overlapped `WSARecv`/`WSASend`/`AcceptEx`. Neither pretends to be the other.
    - **Accept is an operation, and that one is a trap.** It is tempting to leave it on readiness since a readable listener means "connection pending" - but IOCP expresses read-readiness with a zero-byte `WSARecv`, and `WSARecv` on a LISTENING socket fails with `WSAENOTCONN`. There is no probe for a listener on a completion port; `AcceptEx` is the only way. (Found the hard way: the HTTP loopback fixture failed with "not connected".)
    - **`yoop_iop_*_begin` must call `io_ensure_started()` before dispatching to the backend.** `io_mu` is created by `io_start_locked`, so a completion backend that locks it first locks an uninitialized mutex - which segfaults rather than failing cleanly. This bit once already.
    - **Every socket close must route through `yoop_io_closing`, and this is correctness, not hygiene.** IOCP caches which sockets are bound to the completion port (associating twice fails, and there is no "is it bound?" query), and **Windows recycles socket handle VALUES**. A stale cache entry therefore makes the next socket with that same integer look already-bound, `CreateIoCompletionPort` is skipped, and operations on it never deliver a completion. The failure is a HANG that appears only after enough connections to recycle a handle - it reads like a race and is not one. `yoop_sock_close` and `yoop_socketpair_close` both call it; a new close path must too.
    - **A registration for an OPERATION outlives delivery; one for plain readiness does not.** `yoop_iob_deliver` drops the entry only when `kind == YOOP_OP_NONE`, because an operation's byte count has to survive until the resumed task (`yoop_iop_end`) or the woken thread (`yoop_iop_wait`) reads it. Getting this wrong on either branch hangs that flavor.
    - **The buffer handed to a `begin()` must outlive the suspend.** On Windows the kernel writes through it while the task is parked. This is the one rule the operation API adds over the readiness API; every std/net caller passes connection-owned storage, not a local temp.
    - **`pipe()` is not waitable on Windows**, so anything handed to `yoop_io_wait_*` / `yoop_io_arm_*` must come from `yoop_socketpair` (pipe on POSIX, loopback TCP pair on Windows) and be read/written through its `yoop_socketpair_read/write/close` siblings - a Windows SOCKET is not a CRT fd. `concurrent_pipe.yoop` and `async_yield_smoke.yoop` depend on this; a pipe there would *hang* rather than fail.
    - The filesystem/dirent helpers live in [yoop_fs.c](../runtime/yoop_fs.c) rather than in yoop_io.c. Adding any runtime `.c` means updating all three source lists - see the [runtime/](#runtime---the-c-runtime-2600-lines) entry above.
  - **std/net must not call libc sockets directly.** A Windows socket is a `SOCKET` handle (not an fd, so `close` is wrong and `closesocket` required) and reports failures via `WSAGetLastError` (so `errno` is left stale and every `errno.message(errno.get())` printed nonsense). [socket_ffi.yoop](../std/net/socket_ffi.yoop) therefore externs the `yoop_sock_*` shims in [yoop_net.c](../runtime/yoop_net.c), which present the POSIX shape - int descriptors, -1, errno set - on every platform and are plain passthroughs on POSIX. New socket surface goes through a shim, not a fresh libc extern.
  - **Header order in the runtime is fixed by [yoop_platform.h](../runtime/yoop_platform.h) and must stay there.** `<windows.h>` pulls in the legacy `<winsock.h>` unless `WIN32_LEAN_AND_MEAN` is set, and it conflicts with `<winsock2.h>`; the header every TU already includes establishes `winsock2 -> ws2tcpip -> windows` once so no new file has to rediscover it. The same header owns `yoop_thread_spawn/join` and the `yoop_wsa_to_errno` / `yoop_sock_fail` bridge.
  - **stdout/stderr are put into BINARY mode by `yoop_runtime_init`.** The MSVC CRT otherwise rewrites every `\n` into `\r\n` on the way out, which both corrupts binary payloads and made compiled programs' output differ from macOS/Linux for no visible reason. Same call site starts Winsock (`yoop_net_startup`), since std/net reaches sockets by paths that never otherwise touch the runtime.
  - **Debug info on Windows is CodeView, not DWARF** - clang drives the MSVC target with `-gcodeview`. `-g` works and the build is fine; the DWARF debugger tests self-skip there ([src/debug.test.js](../src/debug.test.js)). Getting a debugger working on Windows is unfinished work, not a solved problem.
  - **`opengl32.dll` exports OpenGL 1.1 and nothing newer, so `framework:OpenGL` needs a loader, not just a library.** Every shader / VAO / VBO / uniform entry point (GL 1.5+) belongs to the display driver rather than to the OS and has to be resolved at run time against the CURRENT CONTEXT via `wglGetProcAddress`. GLEW and glad cannot be linked to solve this: they expose the plain `glCreateShader` spelling as a preprocessor macro over `__glewCreateShader` / `glad_glCreateShader`, and a macro is invisible to yoop codegen, which emits a call to the literal symbol named in the extern block. [runtime/yoop_gl_win32.c](../runtime/yoop_gl_win32.c) is therefore a table of real forwarding functions with the real names, each resolving lazily on first call. It is **not** part of the unconditional runtime source list: it is a GLUE source, added only for a program that actually named OpenGL, exactly as `yoop_tls.c` is added only for one that named OpenSSL. `glueSources` in [bootstrap/src/link/runtime_root.yoop](../bootstrap/src/link/runtime_root.yoop) carries the TLS entry today and not the GL one - it has no platform check, and adding the GL file unconditionally would hand clang a translation unit that does not compile on macOS. `framework:OpenGL` lowers to `-lopengl32` on Windows for the 1.1 half. An entry point missing from the table is an ordinary "unresolved external symbol glFoo" at link time; the fix is one line.
  - **A C function returning a bare pointer must NOT be declared as `T[]`.** A yoop array is a 16-byte `{ data, len }`. Under SysV that comes back in rax:rdx, so the pointer lands correctly and the junk `len` is simply never read - the mismatch is invisible on macOS and Linux. The Win64 ABI returns a 16-byte struct through a HIDDEN FIRST ARGUMENT, so the callee sees our return slot as its first real parameter: it writes through it, and the caller reads what it wrote back as the data pointer. Declare `unsafe_ptr<T>` and pair it with `unsafe_ptr.toArray<T>(p, n)`, which also gets a real length. (Found via `SDL_GetKeyboardState` in the nebula_arena demo, whose key reads were garbage on Windows only.)
  - **`setvbuf(stdout, NULL, _IOLBF, 0)` is not just a no-op on Windows - it kills the process.** The MSVC CRT has no line buffering (it downgrades `_IOLBF` to `_IOFBF`) and rejects a size of 0 through its invalid-parameter handler, which fast-fails with `STATUS_STACK_BUFFER_OVERRUN` (0xC0000409) before `main` gets anywhere. `yoop_stdout_linebuf` uses `_IONBF` there instead, which is the closest thing the CRT offers to the guarantee the function makes.
  - Toolchain resolution lives in [bootstrap/src/link/](../bootstrap/src/link/) for the compiler and in [src/toolchain.js](../src/toolchain.js) for the Node-side suites, and the two have to agree or a test passes on a machine where the real compiler fails. Between them they locate clang, find MSVC's `link.exe` via `vswhere` (clang needs it; `-fuse-ld=link` names it deliberately, as `lld-link` is absent from some LLVM packages and broken in others), add the Windows-only flags, and map link-flag names (`m` and `pthread` do not exist as separate libraries there). Library and include search paths are the same idea: Homebrew prefixes on macOS (OpenSSL is keg-only there, and macOS ships its own LibreSSL), vcpkg and the conventional unzipped-SDK prefixes on Windows, searched after an explicit `YOOP_LIB_PATH` / `YOOP_INCLUDE_PATH`. Anything that shells out to clang goes through one of the two.
- **Codegen requires a resolved type on EVERY node it reaches.** Codegen does zero type-checking. If you add an AST kind, the typechecker must decorate it with a concrete type before codegen sees it, or codegen crashes or emits wrong IR.
- **`==` on an `enum<string>` is a POINTER comparison, so a case's constant has to be ONE global.** Equality lowers to `icmp eq ptr` for every type, and plain `string == string` is a typecheck error - a `string` is a borrowed view, so comparing two of them by identity answers the wrong question - which makes string-backed enum cases the only string comparison in the language. Identity is correct only while both sides name the same global. The linker's constant merger cannot be leaned on for that: it dedupes identical `unnamed_addr` constants on Mach-O and ELF but not under MSVC at -O0, where `dir == SortDir.Asc` silently evaluated false while passing everywhere else. Pooling identical literals by content in the emitter is what makes the guarantee explicit rather than a property of the platform.
- **`llvm.coro.end`'s result must be DISCARDED, not bound to a temp.** Its signature changed in LLVM 19/20 from `i1 (ptr, i1)` to `void (ptr, i1, token)`. Newer LLVM auto-upgrades the old spelling on read, but if the call's result is bound to a name the upgrade rewrites the call to `void` and leaves the `%tN =` in front of it - the module then fails verification with "Broken module found", which reads like a codegen bug and is not one. Discarding is legal under both signatures, so one spelling works across every supported LLVM without version detection.
- **The DWARF describes the layout codegen EMITS, not the type the source writes** ([bootstrap/src/codegen/debug_types.yoop](../bootstrap/src/codegen/debug_types.yoop)). An `int32[]` is not a DWARF array - it is the two-word `{ data, len }` fat pointer with `data` typed as `int32 *`; a `string` is a typedef over `char *`, and that typedef is what earns a debugger's C-string summary; a `variant` is `{ tag, payload }` with the tag an enumeration over the case ordinals and the payload a union of the per-case structs; a `union` is a real DWARF union even though codegen emits `[N x i8]` for it. Every shape is derived from the same size and alignment the layout uses, and a shape with no useful description answers NONE so the local gets no `llvm.dbg.declare` at all - a debugger omitting a variable is a far better failure than one printing garbage for it. Nominal aggregates **reserve their `!N` before building members**, so `type Node { next: unsafe_ptr<Node> }` terminates, and nodes are deduped so one shape is shared program-wide. Two traps worth knowing, both found by a debugger rather than by reading IR: source lines are 0-based internally and DWARF is 1-based, and a debugger asked to stop at line 9 will happily stop one statement early and then PRINT line 9, so the only way to see the off-by-one is to ask the debugger where it stopped; and a location must not be attached to the parameter store prologue, because LLVM derives `prologue_end` from the first instruction carrying one, and a FUNCTION breakpoint then stops before the arguments reach their slots and every parameter reads as garbage.
- **A pass-A type SHELL must be FILLED IN PLACE, never replaced.** This is the single most expensive invariant in the typechecker to get wrong, and it has been violated and fixed three separate times (variants, vtables, and structs while merging std/db into a directory module). Pass A registers a name with an empty body; pass C resolves the body. Any field, parameter, or payload that resolved to that type in between holds a REFERENCE to the shell object - so building a fresh populated type and swapping the table entry leaves those references pointing at an empty type. `sizeOfType` then reports no fields, every enclosing struct is undersized, and the emitted IR reads its own fields at the wrong offsets. Symptoms, in ascending order of nastiness: the misleading `type "T" has no field "f"` on a field that IS declared; a compiler CRASH (`detectRecursiveField` walking a shell's null `fields`); and, across the source files of a directory module where nothing forces a declaration order, a SILENT MISCOMPILE. If you add a nominal type kind, register a shell in pass A and FILL THAT SAME ENTRY in pass C - never construct a fresh type and swap it in. Regression fixture: [examples/pass/decl_order_independence.yoop](../examples/pass/decl_order_independence.yoop).
- **Instantiating a generic SNAPSHOTS the generic decl, so generic bodies resolve before any concrete decl.** Instantiation copies the generic decl's fields into a fresh cached type; a snapshot taken before the generic's own body resolved is permanently field-less (`type "Bag__int32" has no field "item"`). Pass C stage 1 is therefore split into two sub-stages - every generic TYPE body in the module group, then everything else. Same reason the generic-TRAIT pre-pass exists. In-place shell filling does NOT cover this case, because substitution builds new field types rather than sharing the generic's.
- **`sizeOfType` must match the layout codegen actually emits, and under-reporting is a memory stomp.** It sizes variant payload buffers (`{ i32, [N x i8] }`) and `Vec`/array allocations, so a type it reports too small gets a buffer that later stores run past. Two cases that are easy to get wrong: a variant is `4 + maxPayload` PLUS the one-byte floor a payload-free variant occupies and the trailing pad (without them, any variant nested in another variant's payload is corrupted), and a `vtable` needs its own case rather than falling through to the default 8 (without it, a `Vec` of structs embedding a `Dispatcher` allocates half of what it writes). Over-reporting is harmless; when adding a type kind, add its `sizeOfType` case.
- **Struct literals can't be typed standalone.** A bare `Foo { x: 1 }` has no type of its own. A struct literal is pinned to the type of the slot it sits in - assignment RHS, return value, call argument, field initializer - and an orphan one is an error rather than an inference.
- **Binding type inference (the annotation is optional).** A `let`/`const` may omit its `: type` when it has an initializer (SPEC section 4: required without an initializer, optional when the initializer is unambiguous). The type comes from the initializer, and untyped literals then default exactly as an annotation would have produced them (`untypedInt` -> `int32`, `untypedFloat` -> `float64`, recursing into array elements and re-pinning untyped array literals), so codegen never sees an untyped literal in a store. For **module-level** bindings the inference is DEFERRED to a later pass than the one that walks the declaration, because the module's full symbol environment does not exist yet when the decl is first seen; the inferred type is published into the module's symbols before any importer typechecks, which is what makes the name resolve across the boundary. "Infer later" is a distinct sentinel from "failed": anything that cannot be typed standalone (an orphan struct literal, an empty array literal) becomes the `cannot infer a type for "x"; add an explicit type annotation` error instead.
- **A `for (let i = ...)` counter is the ONE place the literal default is overridden by context.** An unannotated counter is typed from the LOOP CONDITION: when the condition compares the counter against something with a concrete numeric type, that type wins, so `for (let i = 0; i < xs.len; i += 1)` gives `usize` where a plain `let i = 0;` gives `int32`. Without that shape it falls back to the ordinary literal default. The rule exists because `int32 < usize` is a hard error - there is no implicit widening - which would otherwise make the most common counted loop fail on the very condition the counter serves. The initializer is probed on a throwaway diagnostic channel and then re-checked on the real one, so a broken initializer reports once and an untyped literal still gets pinned. The counter's scope covers the head and the body and nothing else.
- **The concurrency kinds are declared in std, not built into the compiler.** `task`, `async`, `joined`, `pooled` and `Task` are ordinary `kind { ... }` decls in [std/core/kinds.yoop](../std/core/kinds.yoop) (autoloaded into every module graph), and they lex as ordinary identifiers - the same precedent `test`/`suite` set. Their behavior comes from clauses: `pausable` makes a function a coroutine, `provides Task` rewrites the call-site result type, `refcounted <retain> <release>` names the methods the compiler calls, and **storage is derived** (`mustNotEscape scope` -> stack alloca, `refcounted` -> heap). The carve-out is a required-core-kinds check: the compiler asserts std declares each one with the clauses it consults, and names the missing one if not. The irreducible built-in is `Task<T>` SATISFYING `Shared`/`Joinable` - it is a compiler type, so it cannot carry an `implements` list, and satisfaction is answered in the checker instead.
- **A function decl is an optional run of kind prefixes, then an optional `function`** (SPEC section 7). `task fetch(...)` and `task function fetch(...)` are equivalent, and prefixes stack (`async disposable open(...)`, subject to each kind's `appliesTo`). `kindPrefixedFunctionArity()` in the parser is the structural recognizer; which prefixes are legal is a typecheck question.
- **Two unrelated meanings of "kind" on a binding.** One is MUTABILITY - `let` / `const` / `discard`. The other is the user-defined KIND DECLARATION the binding carries (`disposable`, `pooled`, `ephemeral`). Same word, orthogonal semantics, and a walker that reads the wrong one silently does nothing.
- **Imported types may be shells mid-pass.** Pass A registers a nominal type with an unpopulated body; pass C fills it. Do not assume a type reached through an imported module is fully populated before pass C has completed for that module.
- **A struct used as a variant payload must be declared BEFORE the variant, in the same file.** Same shell hazard as the bullet above, but within one module: `variant V { Case { f: T } }` where `type T` appears later resolves `T` against its unpopulated shell, and the constructor literal then fails with the actively misleading `type "T" has no field "<field>"` pointed at the use site (the field IS declared; the decl is just too late). Declaration order is not otherwise significant in Yoop, so this is a papercut rather than a rule worth keeping. Note a variant case name sharing a name with a same-module type is NOT a problem (verified) - only the ordering is.
- **What makes a type FALLIBLE is a shape rule, and it is narrower than it looks.** A fallible type is a `variant` with EXACTLY two cases, named `Ok` and `Err`, each carrying zero or one field ([bootstrap/src/typecheck/fallible.yoop](../bootstrap/src/typecheck/fallible.yoop)). The case NAMES are the whole test; the field names do not matter, because a case with one field has exactly one thing `?` could mean. A third case, two payload fields, or the names `Some`/`None` all disqualify - `Option<T>` is deliberately not fallible, and "the Rust-shaped feature also works on the Rust-shaped optional" is the natural assumption that is wrong here. Adding a new way to produce a fallible value means checking it against this shape, not against a list of blessed types.
- **Error control flow differs by stage.** Lex and parse FAIL FAST: the first bad token or bad statement ends that layer, because everything after it is guesswork. Typecheck ACCUMULATES, reporting as many independent problems as one run can find. Codegen assumes a clean typed AST and must be total on well-formed input, so a crash there is a typecheck bug rather than user error.
- **Warnings ride the same diagnostic channel as errors, and "errors" always means HARD errors.** A warning is a diagnostic with a `warning` severity and a stable kebab-case `code`, pushed onto the channel every check already threads through - one channel, not two, and every "no errors" gate keeps exactly the meaning it had, because a warning must never fail a build. Warnings from std are filtered out of an ordinary compile: std is autoloaded into every graph, so a warning there would attach to every compile in the world and be unfixable by whoever is reading it. `--warn-std` opts back in.
- **Source locations on every AST node are load-bearing.** Every diagnostic and every DWARF line comes from the node's location, so a synthesized node copies the location of whatever it stands for. That is why generated code - `@derive`'s method, the `--test` entry, the `..` lowering - restamps locations onto the real declaration rather than leaving a diagnostic pointing into text the user never wrote.
- **Generic decls are registered apart from concrete ones.** A declaration carrying type params is registered as a GENERIC symbol and instantiated lazily into the registry - by an explicit type application, or by call-site inference for a generic function. Anything answering "what concrete type is this name" only ever holds monomorphic types: never file a type-param-bearing type there, and never reach into the generic side when the question was about a concrete type.
- **Codegen never sees a TYPE PARAMETER.** Generic struct and function bodies that reach codegen have been pre-substituted during monomorphization, so every resolved type is concrete. A type parameter reaching codegen is a typechecker bug - an instantiation was missed at the use site.
- **Type aliases are transparent and live in their own table.** `type NodeId = usize;` is a declaration carrying a target type and no fields; pass A registers it in a per-module ALIAS table, never among the nominal types. Resolution is lazy and transparent: a type name that hits the alias table resolves the alias RHS *in the alias's home module*, with a cycle guard, and the RESULT is the underlying type - no distinct identity, no special cases for indexing or coercion, and codegen never sees the alias name. Cross-module aliases ride the ordinary imported-name machinery; namespaced (`ns.NodeId`) and chained aliases work. Each RHS is validated once at the declaration site (unknown target or cycle is a decl-site error), and the resolved alias is stamped somewhere codegen will not mistake for a struct it has to emit. Generic aliases (`type Pair<T> = ...`) and composed RHS (`A & B`, `A | B`) are refused by name.
- **Trait method calls are always trait-qualified.** Source form is `Trait.method(ref x, ...)`. Bare `method(ref x, ...)` is a typecheck error with a fix-it hint, and the dotted `x.method(...)` is rejected too. Mangled symbols are `<structModuleId>__<StructName>__<TraitName>__<methodName>` ([bootstrap/src/codegen/mangle.yoop](../bootstrap/src/codegen/mangle.yoop)) - one LLVM `define` per (trait, method) pair, so cross-trait same-name impls work, each call site resolving to a distinct symbol. Typecheck decorates every trait call with the trait, the method name and the resolved callee symbol, so codegen resolves nothing itself. **The extends chain**: `trait Child extends Parent { ... }` records the parent, and impl validation FLATTENS the chain onto the struct (every ancestor reachable from a user-declared trait, deduped), so trait-method lookup against a struct never re-walks `extends`. The qualifying trait at a call site may be a DESCENDANT of the trait that declares the method (`BatchIterable.next(...)` where `next` is declared on `Iterable`): resolution walks the qualifying trait's chain to find the declaring trait and mangles with ITS name, so dispatch lines up with the single define. Multi-bound type params (`<T implements (A, B)>`) work the same way, across every bound.
- **`propagates<K>` is ADVISORY, not enforced.** The compiler is **silent by default** about resource lifetimes. A type that declares `propagates<K>` is documenting "bindings of me own a resource" for readers and tooling; it does **not** force the user to do anything, and returning a propagating value never requires the function to declare `propagates<K>`. There are **no unsatisfied-obligation errors on the ownership side** - the one diagnostic is `unhandled-disposable` ([bootstrap/src/typecheck/unhandled.yoop](../bootstrap/src/typecheck/unhandled.yoop)), a WARNING a build opts into with `--warn-disposable`, because what silence costs is the leaks nobody finds. Avoiding double-free is the `dispose` implementer's responsibility (make `dispose` idempotent: free-then-null, guard on null). The two things that still have teeth:
  1. **Auto-cleanup (the one opt-in with codegen)**: declare the kind keyword on the binding (`disposable arr: T = ...`) and the compiler injects the cleanup call at scope end (unless a matching manual `Trait.method(ref arr)` already fired on every path). Same for the refcounted/builtin keywords (`pooled`/`joined`/`Task`) with their own auto-action (release / wait).
  2. **Manual discharge**: a plain `let`/`const` plus an explicit `Disposable.dispose(ref arr)`. Optional, never required.
  Implementation ([bootstrap/src/typecheck/discharge.yoop](../bootstrap/src/typecheck/discharge.yoop)): obligations are computed per binding, and only an auto-cleanup binding ever emits a cleanup - there is no unsatisfied-obligation error and no return-site `propagates<K>` enforcement. A matching manual `Trait.method(ref binding)` call marks the obligation answered, so an already-hand-disposed binding does not also get an injected cleanup (which would be a double free, not a rendering difference - that is why this lives in the checker). **Path coverage** is what makes that safe: `if` and `switch` snapshot the state, walk each arm from the snapshot, and restore the INTERSECTION of the arms that reach the end (arms that diverged via `return` excluded; a `switch` with no `default` also counts the fall-through path), while loops discard inner changes because the body may run zero times. **`switch` arms are walked** specifically so a `disposable` binding declared inside a `case` gets its cleanup at the arm-block end; leaving them unwalked makes those cleanups silently never fire. The marker/typestate kinds (next bullet) and `mustNotEscape` escape analysis are a SEPARATE, still-enforced concern - the relaxation only touched the ownership obligations.
- **Region kinds (`appliesTo region`) are anonymous block owners; the use-site shape, not a flag, picks named-vs-anonymous.** A kind decl that says `appliesTo region` (instead of `appliesTo binding`) governs a lexical scope with no named value - the `ephemeral` shape in [std/core/kinds.yoop](../std/core/kinds.yoop), for allocator-scope, pushed-context and transaction guards. It MUST declare `ownsBlock` and may NOT also name a value site (`binding`/`parameter`/`field`/`type`/`return`); both are enforced where a kind's clauses are validated. The parser recognizes the anonymous form STRUCTURALLY - two adjacent idents at statement start where the second is not a binding name - and builds an ordinary const declaration flagged as an anonymous region with a synthesized `$region$N` name (`$` is unspellable in user source, so it is collision-free and unreferenceable). Everything downstream is unchanged: a region binding is a name-less `disposable` whose cleanup reaches the value by its synthetic name. The gate is symmetric - `appliesTo region` plus a name is an error, `appliesTo binding` with no name is an error - and the synthetic name is never declared in scope, because the value is unobservable. Both the explicit-block form (`ephemeral EXPR { ... }`, dispose at `}`) and the implicit form (`ephemeral EXPR;`, dispose at enclosing scope end, LIFO) work, mirroring `disposable`. **The `: type` annotation is optional on any kind-prefixed binding** (the recognizer accepts `IDENT IDENT =`, not just `IDENT IDENT :`), and an inferred struct binding type is canonicalized against the module's declared type, so a call-return shell with an empty `implements` list is replaced by the populated one - otherwise the kind's `requires` clause reads as unsatisfied on a type that does satisfy it.
- **Marker kinds are a static type-level check, and the kind decl is the authority for transitions.** A kind decl that names a polarity clause (`conferred;` or `restrictive;`) is a *marker* kind: no obligation, no `mustCall`, no codegen. A marker kind names itself in TYPE position (`cleared string`, `tainted uint8[]`), so a type annotation carries a list of kind prefixes. There are two enforcement points, and they are split for a reason: [markers.yoop](../bootstrap/src/typecheck/markers.yoop) asks what a value CARRIES and what a slot DEMANDS, at every place a value actually moves; [clearance.yoop](../bootstrap/src/typecheck/clearance.yoop) reads a SIGNATURE and asks who is authorized to move a value across a marker at all.
  1. **Use-site bound check** at every slot (binding initializer, assignment, return, call argument): `slot.conferred subset-of value.conferred` (a conferred capability cannot be forged; sinks that name it REQUIRE it) and `value.restrictive subset-of slot.restrictive` (a restrictive hazard cannot be silently dropped; plain slots FORBID it). The return site is asymmetric - only the restrictive direction is enforced; the function's signature is the conferring authority (see point 2).
  2. **Decl-authority check** at every function decl: the kind decl pairs a required trait with a method name, and only an impl method of that trait may mediate the transition. A clearance kind declares `requires <Trait>;` plus `clearedBy <method>;` (restrictive) or `appliedBy <method>;` (conferred). For a function whose signature would strip a restrictive kind K (a parameter carries K, the return does not), the function MUST be a METHOD on a type whose `implements` list includes K's required trait, and its name MUST equal K.clearedBy. Same for the conferred direction. **Free functions are categorically rejected** - laundering requires opting in via a trait impl. **Exception, and only for the conferred direction: PASSTHROUGH.** A function is only *conferring* K if it produces a K-carrying value out of one that did not, so when EVERY `return` in the body already yields a value carrying K, no authority is required - the mirror of the exemption the restrictive direction always had for a parameter that carries K. Without it no wrapper around a conferring API could exist, not even `function f(s: cleared T): cleared T { return s; }`. Two things this depends on: **the conferred half runs AFTER the body walk** (before it only parameters are known, so `return someLocal;` misreads as forgery), and **"every" is not "any"** (a body that launders on one path and forges on another is still forging; an empty return list answers false, not vacuously true). That is what makes a `requires`/`appliedBy`-free conferred kind like `owned` usable: its only mint site is a **bodyless `extern` decl**, which the walk skips entirely, so the allocating intrinsic is the authority and everything else reaches the kind by passthrough - which is also why the per-module function index has to collect extern decls as well as ordinary ones, or the marker on an intrinsic's return is silently dropped at every call site. **A marker set is a TREE, not a flat pair of sets**: it mirrors the annotation's type arguments, so `Result<owned string, string>` holds nothing at the top level and `owned` at argument 0, and the bound check recurses positionally. Without that a marker cannot survive a fallible constructor, since the value is only reachable again after a `switch` destructures it. The destructuring side resolves a payload binding's markers from EITHER direction: a GENERIC payload (`Ok { value: T }`) maps field -> type param -> type-argument index through the generic decl (the instantiated type has substituted `T` away, so only the generic decl knows which parameter a field came from), while a CONCRETE payload (`Case { f: owned string }`) reads the field's annotation off the variant DECLARATION, since a variant type keeps only resolved field types and no annotations. **The decl-authority check stays TOP-LEVEL** - it asks what the function hands back, and a `Result` is not itself owned - so the nested position is guarded separately at a `return Variant.Case { f: X }`, where the constructor field is a slot and the return annotation's matching type argument is what it must satisfy; without that `Ok { value: "a literal" }` would launder a literal into an owned payload. Not covered: **field-position sources** (a `tainted` struct field surfacing through `x.field`), and constructor field checks at slots other than a `return`. What this kills is look-alike launderers (`evil(t: tainted X): X` returning a freshly-built `X` that secretly logs the input) and `fake_clear` minters: a signature-shape match does not authorize a transition, an impl of the named trait does. The compiler bakes in no "launder" verb - the user names the trait and its method, and the kind decl names them as the authority.
  Because a binding's type is fixed at its declaration site - either from an explicit annotation or inferred once from its initializer - and assignments must conform, a binding's kind set is likewise fixed at declaration: there is no flow-sensitivity to track, no snapshot/merge, no per-binding kind state. The marker and obligation clauses are mutually exclusive on one kind, and `clearedBy` matches only `restrictive`, `appliedBy` only `conferred`. `conferred` / `restrictive` / `clearedBy` / `appliedBy` are recognized CONTEXTUALLY inside a kind body, so the words stay ordinary identifiers everywhere else. The trait method itself has a plain signature (`function cleanse(ref self): T;` on a `Cleansable<T>`); the kind decl describes its semantic role rather than encoding it in the method's annotation, because trait methods require `ref self` as their first parameter and Yoop has no `Self` placeholder in return position - so a generic trait is the idiomatic shape. Enforcement covers same-module direct calls, **imported by-name calls, and namespaced member calls (`ns.fn(...)`)** at parameter, return and binding sites: an imported or namespaced callee is resolved back to its source decl plus that module's kind table, so a marker on a std-style signature is checked across the boundary instead of silently dropped. Imported kinds share identity, so the marker sets line up. A trait-qualified call's result carries every conferred kind whose `(appliedBy, requires)` pair matches, and argument sink-checks are skipped on trait calls, because there the kind decl IS the contract.
- **Intrinsics enter scope via `extern "intrinsic"` blocks, not auto-injection.** The compiler-recognized intrinsics (`heapAlloc<T>`, `heapFree<T>`, `ctxAlloc<T>`, `ctxFree<T>`, `stringAsBytes`, `stringFromBytesUnchecked`, `bytesAsStringUnchecked`, `arraySlice<T>`, plus `waitUntil<T>` / `cancel<T>`) are declared in [std/core/intrinsics.yoop](../std/core/intrinsics.yoop) (and concurrency.yoop) inside `extern "intrinsic" from "compiler" { ... }` blocks, not injected into every module's symbols. A user must `import * as intr from "std/core/intrinsics.yoop"` to call them as `intr.heapAlloc(...)`. The canonical decls carry stable ids (`$builtin__heap_alloc` and friends), and each module tracks which intrinsic names are actually in scope; the special-case branches for `waitUntil` / `cancel` gate on that set, so user code can shadow those names freely if it does not import concurrency.yoop. `printf` is the lone exception - it is globally callable (the name doesn't collide with user identifiers and ~all examples use it). Codegen dispatches intrinsics by that id, never by name; pass C of the typechecker skips type-annotation resolution for canonical generic intrinsics so the `T[]` in their extern-block signatures (documentation only) doesn't need a type-param scope. **`ctxAlloc<T>` / `ctxFree<T>` are the context-routed siblings of `heapAlloc` / `heapFree`** (arena and context allocators): identical codegen except the `@malloc`/`@free` call becomes `@yoop_ctx_alloc`/`@yoop_ctx_free` (runtime/yoop_alloc.c), which dispatch through the per-thread current allocator (`std/core/alloc.yoop`; default malloc). `Vec<T>` allocates via `ctxAlloc` and is **container-owned**: it stores the `Allocator` it captured at `vecNew` and `pushAllocator(self.alloc)` around every grow/free, so a Vec built inside an arena scope draws from (and frees into) the arena regardless of the ambient allocator at grow/dispose time. `heapAlloc`/`heapFree` are the explicit raw-malloc path.
- **Std value imports must be namespaced** (`import * as ns from "std/..."`). `import { f } from "std/..."` is rejected for any name that resolves to a VALUE (a function or a const), with a fix-it pointing at the namespace form. Types, traits, kinds, enums and unions are exempt: their declaration-position usage, and their capitalization, keeps them from competing with common identifiers. Imports from relative paths - within std itself, or across a user's own multi-file program - are unaffected. Calling a generic function through a namespace (`vec.vecNew<int32>()`, `intr.heapAlloc(8)`) routes through the source module's generic table, and codegen reads the instantiation stamped on the call site so the emitted mangled name carries the type-arg suffix.
- **Enum and union are nominal types alongside struct.** Pass A registers shells; pass C fills enum case payloads and union field types. An enum shell's underlying type is the ERROR type rather than a guessed `int32`, because a sibling file can resolve the enum's name in a signature before the decl is filled and a guess would silently become the answer for an `enum<string>` - a pointer compared as an i32 rather than an error. Variant ordinals are **stable 0-indexed integers in declaration order** and codegen emits them as `i32` tag values, so reordering a variant breaks ABI. The typechecker decorates constructors, patterns and switch scrutinees with their resolved enum or variant type, and codegen reads only those decorations - a missing one is a typecheck bug, not a codegen gap. Untagged-union codegen emits a `{ [N x i8] }` byte buffer that field accesses read through, which assumes little-endian (every supported target is). A bare `EnumName.Variant` with no payload parses as a field access and is PROMOTED in place to a variant constructor once its LHS resolves to an enum, so codegen never sees a field access whose object is an enum name.


## The self-hosting bootstrap

The compiler is written in Yoop and compiles itself. Its source is
[bootstrap/src/](../bootstrap/src/), and the module map, the language subset it
accepts and the commands that build and test it are in
[bootstrap/README.md](../bootstrap/README.md). The shapes that cross each layer
boundary are [Pipeline layer contracts](#pipeline-layer-contracts) below. The
ownership model it is written against is the advisory one described under
[Cross-cutting invariants](#cross-cutting-invariants) above and in
[writing_yoop.md](writing_yoop.md#4-kinds).


## Pipeline layer contracts

The pipeline is a chain of layers, and the shape of the data crossing each
boundary is treated as a contract even though one program implements all of
them. The reason is practical rather than ceremonial: a layer with a stated
boundary can be dumped, tested and replaced on its own, and a bug can be pinned
to one side of a boundary instead of to "the compiler".

A contract here is a boundary shape, the invariants that must hold at it, and
its error channel. Everything else - the data structures inside a pass, the
number of passes, single versus multi-pass codegen, whether an intermediate IR
exists - is an implementation detail.

```text
entry.yoop
  -> module graph     resolve imports, order modules
  -> lex              per module:    source bytes -> tokens
  -> parse            per module:    tokens       -> AST
  -> typecheck        whole program: AST          -> typed AST + types
  -> codegen          typed AST (+ registry)      -> LLVM IR text
  -> clang            .ll + runtime C             -> executable
```

### Three shapes that fall out of Yoop's value semantics

Yoop is nominal, closed and value-semantic: there are no open objects to stamp
arbitrary fields onto, and no reference-shared mutable nodes. Three answers
follow from that, and they shape every boundary above.

- **The AST is an arena plus integer node ids, not a tree of nested values.**
  One `Vec<AstNode>` owns every node; children are named by `NodeId` index, with
  0 reserved as the null id. A nested tree would deep-copy on every pass and
  every child access, and a recursive variant with 80-plus cases is unusable
  under value semantics. The arena makes a whole module's AST one owned value
  that can be passed, dumped and diffed. The node itself is FAT - one struct
  with the child slots and scalars every kind might need - rather than a payload
  variant per kind, so reaching a child stays a field access.
- **Decoration lives in side tables keyed by `NodeId`, not stamped on nodes.**
  The typed AST is the parser's AST plus parallel tables: a dense `Vec` for the
  annotation every node has (the resolved type), a sparse `Map<NodeId, T>` for
  the occasional ones. That makes "typed AST" a real separate contract rather
  than a mutated parse output, and it keeps the parse AST reusable.
- **The error channel is `Result` plus diagnostics, never exceptions.** Yoop has
  no exceptions. A `Diagnostic` carries a message, the file path, a source
  location and a severity. Every layer's boundary is "output or diagnostics",
  whether the layer fails fast on the first problem (lex, parse) or accumulates
  (typecheck). A caller therefore treats every layer the same way.

### Layer by layer

**Module graph.** `loadModuleGraph(entryPath)` takes an entry path and returns
the modules in topological order, leaves first, with the entry among them rather
than duplicated beside them. Invariants: the graph is cycle-free; a module
appears after everything it imports; the module `id` is stable and is the sole
basis for cross-module symbol mangling (`<id>__<symbol>`). Errors: import cycle,
file IO, a member that fails to parse.
[bootstrap/src/source_graph/](../bootstrap/src/source_graph/).

**Lex.** Source bytes in, a flat token stream out, terminated by an `EOF` token.
Invariants: spans are offsets into the EXACT source handed in; numeric and char
values ride on the token rather than being re-parsed later; string and template
literals come out RAW, with `${...}` interpolation left to the parser; block
comments nest; underscore digit separators (valid only between digits) and
`0x` / `0b` / `0o` bases are handled. [bootstrap/src/lex/](../bootstrap/src/lex/).

**Parse.** A module's tokens in, one AST out, rooted at a PROGRAM node.
Invariants: every node carries a real source location, because diagnostics
depend on it; every kind is a member of the shared `ASTNodeKind` vocabulary; a
keyword reserved for later is recognized and REJECTED by name rather than
mis-parsed; `>>` is split into two `gt` tokens parser-side for nested type
applications, with the lexer unchanged. Two rewrites happen at this layer rather
than later, both because a file's arena is only writable while it is being
loaded: the `..` lowering and the `@derive` expansion.
[bootstrap/src/ast/](../bootstrap/src/ast/) for the arena and
[bootstrap/src/parse/](../bootstrap/src/parse/) for the descent.

**Typecheck.** The parsed modules plus the import graph in; per-module typed
ASTs plus the program-level type state out - the module scopes, the interned
types and symbols, the instantiation registry of monomorphized generics, and the
accumulated diagnostics. The invariants codegen relies on:

- every node that reaches codegen has a concrete resolved type, not the
  infer-later sentinel and not an error type;
- no type parameter reaches codegen: generic bodies are monomorphized into the
  registry first;
- generic decls live only in the generic tables, and the concrete tables hold
  only monomorphic types;
- variant ordinals are stable 0-indexed integers in declaration order, because
  they are ABI;
- diagnostics accumulate; nothing is thrown.

Two internal choices are worth knowing, because the boundary above is written to
absorb them. Types are INTERNED in one arena and referenced everywhere by index,
so type equality is an id comparison and "fill the shell in place" means "pass A
inserts a shell, pass C re-sets that arena slot". And there is ONE symbol table
per module rather than a table per declaration kind: struct, trait, variant,
enum, union, vtable, generic and imported names all live in a single
name-to-symbol map, so a lookup is one get and one match, a redeclaration is one
`has`, and an import is a name binding into the shared symbol arena. A kind is a
Symbol, not a Type, because a kind is a declaration rather than a value's type.
[bootstrap/src/typecheck/](../bootstrap/src/typecheck/).

**Codegen.** The typed program in, LLVM IR text plus the link flags gathered
from extern blocks out. What codegen is ALLOWED to assume is the real content of
this contract: every node has a concrete resolved type; multi-module symbols are
mangled `<moduleId>__<symbol>` and generic instances
`<moduleId>__<name>__<arg>__<arg>`; one LLVM definition per registry instance.
Codegen does ZERO type-checking and must be total on well-formed input - a crash
here is a typecheck bug, not user error.
[bootstrap/src/codegen/](../bootstrap/src/codegen/).

There is no intermediate IR between typecheck and codegen. The input contract
above is deliberately phrased as "everything has a concrete type and a mangled
symbol scheme" rather than "codegen walks the typed AST", so that inserting one
later stays a contained change.

**Link.** clang is handed the `.ll`, the runtime C sources and the accumulated
`-l` flags. Yoop has no process API, so
[bootstrap/src/link/clang.yoop](../bootstrap/src/link/clang.yoop) calls libc
`system` directly and is `import.unsafe` for that reason. `--emit-ir` stops one
step short, writing `<out>.ll` and skipping the link entirely, which is what
[scripts/probe_surface.sh](../scripts/probe_surface.sh) uses to ask whether
codegen HANDLED a file without paying for a link nobody reads.

### What is a contract and what is not

Stable, and changed only deliberately:

- the boundary shapes above and their invariants;
- the MEANING of every token tag, every AST node kind and every type;
- the symbol mangling scheme and the ABI - variant ordinals, struct layout, enum
  tag widths, the task handle's runtime-owned prefix;
- diagnostics carrying a source location into the original source.

The ABI half of that list has a concrete reason rather than an aesthetic one:
**the compiler compiles itself**, and it is built by a previously released
binary. Today's compiler therefore has to link against, and agree with, what an
older one emitted. A renumbering or a layout change is a two-step - emit and
accept the new shape first, depend on it after - and the three-stage build is
what catches getting that wrong.

Free to change: data structures within a pass, the number of passes, single
versus multi-pass codegen, whether an intermediate IR exists, caching and
interning strategy. The test of a good boundary is that a layer could be
replaced wholesale and only its own tests would need rewriting.

### How a layer is verified

There is nothing to diff a layer against, so a layer is verified by what it
PRODUCES, at whichever level the property is actually observable:

- **Yoop unit tests beside the module** - `*.test.yoop`, run with
  `yoopiler_boot --test bootstrap/src/<module>` - for anything checkable without
  producing a binary: token values, pass A bindings, the wording and position of
  a diagnostic, the text a lowering generates.
- **Slice fixtures** ([bootstrap/tests/slice/](../bootstrap/tests/slice/)) for
  anything that has to reach an executable. Each carries a hand-written
  `.expected` holding stdout followed by an `exit=N` line, and that file is the
  source of truth.
- **The program corpus** ([examples/pass/](../examples/pass/) and
  [examples/tour/](../examples/tour/)), same `.expected` format, for whether a
  real program is RIGHT rather than merely accepted.
- **The diagnostic corpus** ([examples/fail/](../examples/fail/)) for what must
  be REFUSED: each fixture's `.expected-errors` names a line, a column and a
  substring the reported diagnostic has to contain.
- **The three-stage fixpoint** for the compiler as a whole: stage2 and stage3
  byte-identical, IR and binary both.

**The `.ll` text itself is deliberately not an assertion target.** Behaviour is.
IR text moves whenever an emitter is touched, so a test pinned to it fails on
every such change while catching none of the miscompiles the fixpoint catches.
The one place IR text IS compared is stage2 against stage3, where both sides
were produced from identical source and any difference is a real disagreement
between two compilers about how to compile something.


## The `--test` harness (implementation)

How a Yoop program tests itself, from the compiler's side. The authoring view is
in [writing_yoop.md](writing_yoop.md#8-testing-yoop-code). The governing rule is
that **testing gets no compiler-baked semantics** - there is no `@test`
attribute, no built-in assertion, no reserved keyword. `test` and `suite` are
ordinary kinds declared in userland ([std/test.yoop](../std/test.yoop)), so
`test` / `suite` / `assert` all remain usable as identifiers. Invocation is
`yoopiler_boot --test <dir-or-file> [filter...]`; the implementation is
[bootstrap/src/test_mode/](../bootstrap/src/test_mode/).

- **A test module** is `*.test.yoop` declaring `import.test;` as its first line
  and containing no `main`. The flag is what lets `yoopiler_boot foo.test.yoop`
  work at all - a module with no `main` is otherwise just a compile error - and
  what makes a mis-named file fail loudly instead of being silently skipped. It
  rides the same `import.<feat>;` pragma slot as `import.unsafe;` and sets a
  flag on the PROGRAM node.
- **A suite** is a top-level function carrying the `suite` kind:
  `suite function addsNumbers(): void { ... }`. Cases inside it are
  `let test theory: Case = t.asserts("prose") { ... }` - the binding-position
  `test` kind fires `recordOutcome` at the block's closing brace on every path
  out.
- **Assertions are a bool plus a string, deliberately not a comparison.**
  `theory.isSuccessful` is the outcome; `theory.detail` is a template literal
  the test writes, reported only on failure. There is no `equals(got, want)`
  primitive, because two operands flatten the context that made a check
  meaningful. Helpers for repeated shapes are ordinary yoop functions, added as
  the need shows up.
- **The flow**: discover the test files -> collect their suite names -> generate
  a synthetic entry module in memory (imports plus a `main` that hands the suite
  table to [std/test.yoop](../std/test.yoop)'s `runAll`) -> the ordinary
  pipeline -> link -> run -> propagate the exit code, which is the failure
  count. There is no second codegen path: the generated `main` is *yoop source*,
  reparsed like `@derive`'s output.
  - **Discovery is sorted, and that is not cosmetic.** Suite order is report
    order, so an unsorted directory walk would renumber the TAP output between
    two runs of an unchanged tree and make a diff of them noise. Directories
    starting with `.` are never walked (a `.git` full of packfiles is not a test
    tree), nor are the usual build output directories.
  - **Collection is SYNTACTIC, then validated.** Resolving what a kind
    enumerates into needs typecheck; typecheck needs the entry module; the entry
    module needs the names. The cycle is broken by collecting every
    kind-prefixed top-level function and letting the ordinary passes reject
    anything whose kind is not enumerable into `"suites"` - safe, because a
    kind-prefixed top-level FUNCTION has no other meaning in the grammar. Each
    test file is parsed into an arena of its own that is dropped as soon as the
    names are out of it.
  - **The synthetic entry is never written to disk.** `--test
    bootstrap/src/typecheck` would otherwise drop a `.yoop` file into a
    DIRECTORY MODULE, and every file in such a directory is absorbed into the
    module - so the entry would join the very module it is meant to test. The
    graph is seeded from the generated bytes instead.
  - **Each suite is imported BY NAME under a generated alias**, not through a
    namespace: two test files may each declare a `setup`, and a namespaced
    function in value position is not something codegen lowers.
  - **The `export` wrapper is added by the loader, while the module is still
    being built**
    ([bootstrap/src/source_graph/test_exports.yoop](../bootstrap/src/source_graph/test_exports.yoop)).
    A suite is written without `export` because a file that exists only to hold
    tests should not carry the ceremony, but the generated entry imports it by
    name and an import resolves against exports. It has to happen during the
    load for the same reason the derive expansion does - typecheck reads a
    module by value, so a node grafted afterwards lands in a copy. It is
    idempotent, so an explicit `export suite function` is fine.
  - **The test binary lives in the system temp directory**, named with the pid
    so two `--test` runs cannot link over each other, and is removed when the
    run ends (including the `.ll` left behind by a build that failed at clang).
    It is an artifact of the RUN, not of the project, and writing it beside the
    sources would again mean dropping a file into a directory module.
- **`appliesTo function` kinds are deliberately narrow.** Only
  `signature (p: T) => R;` and `enumerable as "<table>";` are legal alongside
  them, and both are required - a function kind has nothing for `mustCall` /
  `ownsBlock` / `requires` to act on, so those are rejected with a message
  naming the offending clause. `enumerable as` names the table a consumer asks
  for, and is the join key that keeps a future `bench` kind
  (`enumerable as "benches"`) distinct from `suite`. Both clause keywords are
  *contextual* idents, like `conferred` / `clearedBy`, so `signature` and
  `enumerable` stay ordinary identifiers everywhere else.
- **Isolation is a kind, not a runner feature.** `runAll` wraps each suite in
  `ephemeral arenaScope(...)`, so everything a suite allocated is reclaimed in
  bulk before the next one starts. Suites are the unit of isolation; cases are
  the unit of reporting. A segfault still takes the process down - TAP lines are
  written as each case completes rather than buffered, so a crash keeps
  everything already reported and simply omits the plan line.
- **Filters** ride as extra positionals after the path
  (`yoopiler_boot --test . addsPlainly`), forwarded to the binary as argv and
  read via [std/env.yoop](../std/env.yoop). Being argv rather than a compiler
  flag is what would let an `--isolate=process` mode (re-exec per suite) exist
  with no compiler change.
- Not supported: `beforeEach` / `afterEach` timings on `mustCall`, and
  multi-`mustCall` kinds - `kind isolatedTest = test & ephemeral;` fails with
  "composition contradiction", which is what blocks composing isolation onto a
  single case.
- Fixtures: [examples/testing/pass/](../examples/testing/pass/) and
  [examples/testing/fail/](../examples/testing/fail/), driven end to end by
  [src/slice.test.js](../src/slice.test.js), plus
  [bootstrap/tests/testmode/](../bootstrap/tests/testmode/) and testmode_bad/
  for the unit tests of discovery, collection and entry synthesis. Do NOT put a
  `*.test.yoop` under [examples/pass/](../examples/pass/), which is compiled as
  ordinary programs.


## Test conventions

Tests of the compiler itself. (For a yoop program testing itself, see above; for
the rule about where a new test belongs, see CLAUDE.md.)

- **The Node harnesses in [src/](../src/) drive the compiler as a process.**
  Node's native test runner (`node --test`), style `describe` / `it` with
  `node:assert/strict`. `npm test` runs all of them, 460 tests. Every child
  process they start goes through [src/testProc.js](../src/testProc.js), which
  carries a deadline and kills a run as a TREE, deliberately without
  `detached` - a detached child survives the group kill that a Ctrl-C or a tool
  timeout sends, which is the opposite of what is wanted.
- [src/slice.test.js](../src/slice.test.js) - `npm run test:slice`, 205 tests.
  Every fixture in [bootstrap/tests/slice/](../bootstrap/tests/slice/) compiled,
  linked, run, and asserted against its `.expected`, plus the `--test` harness
  end to end over [examples/testing/](../examples/testing/).
- [src/pass.test.js](../src/pass.test.js) - `npm run test:pass`, 247 tests. The
  program corpus: every program under [examples/pass/](../examples/pass/) and
  [examples/tour/](../examples/tour/) that carries a hand-written `.expected` is
  built, run, and checked. This is the suite that can catch a MISCOMPILE, and it
  does it by asserting what the program should print rather than by comparing
  two compilers against each other - the latter passes happily when both are
  wrong the same way.
- [src/fail.test.js](../src/fail.test.js) - `npm run test:fail`, 77 tests. The
  negative twin: every fixture in [examples/fail/](../examples/fail/) with a
  `.expected-errors` file must be refused, with a diagnostic at exactly the
  named line and column whose message contains the named substring. Prefer a
  short distinctive substring naming the offending construct over a whole
  sentence, so the test survives a reword and fails a behaviour change.
- [src/selfhost.test.js](../src/selfhost.test.js) - `npm run test:selfhost`,
  6 tests. The three-stage build and its fixpoint: the seed builds stage1,
  stage1 builds stage2, stage2 builds stage3, and stage2 and stage3 must be
  byte-identical in both IR and binary. It is a full-compiler differential test
  over 30k lines of real Yoop, and it catches the one class of bug a unit test
  cannot: a miscompile that only shows up in the compiler the compiler built.
- [src/debug.test.js](../src/debug.test.js) - `npm run test:debug`, 3 tests. A
  real debugger (gdb or lldb) reads the DWARF the compiler emits; skips when
  neither is on PATH, and on Windows, where the MSVC target emits CodeView. The
  expected line numbers are LOOKED UP in the fixture by marker comment rather
  than written into the test, because a test that hard-codes them agrees with an
  off-by-one bug the moment someone edits the fixture.
- [src/runtimeC.test.js](../src/runtimeC.test.js) - the C runtime's own tests
  ([runtime/tests/](../runtime/tests/)), each a standalone C program that
  exercises the runtime with no compiler involved, so the runtime contract is
  proved independently of any IR. Also runnable directly as
  `sh runtime/tests/run_tests.sh`.
- [src/std_index.test.js](../src/std_index.test.js) - a drift guard for
  [std/INDEX.md](../std/INDEX.md): every importable module on disk has a
  heading, and every heading corresponds to something on disk. It does not
  re-run the generator, because a check that needs clang runs less often than
  the mistake it is guarding against.
- **The bootstrap's own Yoop unit tests are the other half, and there are 1390
  of them**: `$(node scripts/seed.mjs) --test bootstrap/src` runs the lot in one
  build of the graph.
- **An `.expected` is written from what the program SHOULD do, and never
  captured from compiler output.** A captured file asserts that today's
  behaviour equals today's behaviour, which is not an assertion, and it silently
  blesses whatever bug was captured. The format is one file, no comments, no
  blank-line rules: the program's stdout verbatim, then `exit=N` as the last
  line.
- **[examples/playground/](../examples/playground/) is NOT a test surface and
  does not have to be kept compiling.** Nothing under it is covered by the
  suites (only [examples/pass/](../examples/pass/),
  [examples/tour/](../examples/tour/) and
  [examples/testing/](../examples/testing/) are). A breaking compiler or std
  change does **not** oblige you to uplift the playground programs - they are
  scratch space for feeling out ergonomics, and a stale one is expected rather
  than a regression. Do reach for one when it is genuinely the best available
  check on a change (todo_api is the CRUD-shaped HTTP consumer, yoopstore the
  file-serving one, sqlite_demo the FFI one), and say so when you do. If a
  playground program is found broken, note it and move on; do not let it block
  or expand the change in front of you.
