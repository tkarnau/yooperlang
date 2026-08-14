# CI, cross-platform builds, and release identity

**Status: initial thoughts. Nothing here is built, and nothing here is decided.**
This is a sketch of the shape the problem has, written the day the bootstrap
finished, so the decisions get made deliberately rather than by whatever the
first CI file happens to do.

Style, as everywhere in plans/: ASCII only, no em-dashes, no fancy tables.

---

## What is already true, so we do not re-solve it

Worth leading with, because the naive version of this document would be a
porting plan and a porting plan is not what is needed.

- **Windows is a supported target and the port is real** - full `npm test`
  passes there. The multiplexer is split three ways behind one contract
  (kqueue, epoll, a genuine IOCP backend), `std/net` goes through the
  `yoop_sock_*` shims rather than libc, header order and CRT quirks are pinned.
  All of it is written up in
  [../docs/compiler_internals.md](../docs/compiler_internals.md), and that
  section is the prerequisite reading for anything here.
- **Toolchain resolution is already centralized.** `src/toolchain.js` locates
  clang, finds MSVC's `link.exe` via `vswhere`, adds the Windows-only flags, and
  maps link-flag names - and it is shared by the driver AND both test harnesses,
  deliberately, "so a test can never pass on a machine where the real driver
  fails". That invariant is exactly what a CI matrix needs, and it already
  holds.
- **The bootstrap self-hosts to a byte-identical fixpoint**, and as of
  2026-08-14 it can also RUN the Yoop test suite itself (`--test bootstrap/src`,
  1020 assertions, TAP byte-identical to the reference).
- **GitHub Actions is already in use** - `.github/workflows/pages.yml`.
- `YOOP_BOOT_COMPILER` already runs the slice suite through an
  already-built stage, which is the hook a CI job wants.

So the open work is not portability. It is three things: **how to iterate on a
compiler that compiles itself**, **how to automate what currently only happens
on one laptop**, and **what a release is called**.

---

## 1. The seed problem, which shapes everything else

Today the chain starts with the JS reference:

    node src/yoopiler.js bootstrap/src/main.yoop -o stage1    the JS reference
    stage1 bootstrap/src/main.yoop -o stage2                  itself
    stage2 bootstrap/src/main.yoop -o stage3                  itself again
    stage2 == stage3                                          byte-identical

The moment `src/` retires, **something has to build stage1**, and that something
is a yoopiler binary. This is the one genuinely new problem, and every other
decision hangs off which answer we pick.

Four options, in rough order of how much I would trust them:

- **A pinned seed, fetched from the last release.** CI and developers download a
  known-good compiler for their platform, verified by hash, pinned by a file in
  the repo (`seed.lock` or similar). This is what Rust does with stage0 and it
  is the boring correct answer. Costs: a network dependency in the build, and a
  release process that has to exist before it can bootstrap itself (chicken and
  egg, solved once by hand from the JS reference and never again).
- **A checked-in `.ll`.** Commit the compiler's own emitted LLVM IR - it is
  TEXT, and any platform with clang can turn it into a binary. Genuinely
  attractive here in a way it would not be for most languages, because this
  compiler's output IS portable text and it already shells out to clang. No
  network, no binaries in git, and the seed is inspectable. Costs: it is about
  6MB per bump, git will carry every one of them forever, and the IR is only as
  portable as its target triple and data layout (see the open questions below).
- **Keep the JS reference alive as a seed only.** Cheapest today, and it rots
  fastest: the first time `bootstrap/src` uses a feature the JS compiler never
  learned, the seed cannot build it, and you are back to option A in a hurry.
  Worth considering as a transitional measure and not as an answer.
- **Checked-in binaries per platform.** Works, everyone hates it, and it grows
  the repo without bound.

**Recommendation: A, with B as the fallback if the network dependency turns out
to be painful.** Decide before writing any CI, because the CI job for A and the
CI job for B are different jobs.

### The staging rule, which is not optional under any of them

**A new language feature may not be used in `bootstrap/src` until a seed that
understands it has been published.** Otherwise the seed cannot build the
compiler that would have replaced it, and the tree is bricked until someone
hand-builds a rescue compiler.

So a feature lands in two steps, in two separate merges:

1. Teach the compiler the feature. Ship a seed.
2. Only then, start using it in the compiler's own source.

Rust calls this `cfg(bootstrap)` and pays real complexity for it. We can pay
much less, because the rule can simply be "step 2 waits for a release", but the
rule has to be WRITTEN DOWN or it will be violated by whoever is enjoying the
new feature most. It belongs in CLAUDE.md once the seed mechanism exists.

Corollary: **the seed bump is the dangerous commit.** It should be its own
change, with the full platform matrix green, and never bundled with a feature.

---

## 2. What the fixpoint proves, and what it does not

Worth stating plainly before designing gates around it.

`stage2 == stage3` proves the compiler is a FIXPOINT - that it compiles itself
to itself. It does not prove the compiler is CORRECT. A compiler that
consistently miscompiles the same construct the same way is a perfectly stable
fixpoint.

Correctness comes from the hand-written `.expected` files, which is exactly why
CLAUDE.md forbids capturing them from compiler output. That rule is what makes
the slice corpus a cross-platform oracle: an `.expected` says what a program
should DO, and that answer is the same on every runner.

So the per-platform gate is both, not either:

- the fixpoint, which is per-platform (stage2 on macOS will never equal stage2
  on Linux - different triple, different clang, different linker)
- the `.expected` corpus, which SHOULD agree on every platform, and where a
  disagreement is a finding

### A cheap invariant nobody is checking yet

The compiler emits IR as text. So for a fixed target, **the emitted `.ll` should
be identical no matter which host emitted it.** Build the compiler on macOS and
on Linux, have both emit IR for the same fixture and the same target, and diff.

Any difference is a host-dependence bug: a map iterated in hash order, a path
separator leaking into a symbol, a locale-dependent float format, a timestamp.
Those are exactly the bugs that are invisible on one machine and produce
"works on my laptop" release artifacts.

This is a handful of lines of CI and I think it is the highest-value new check
available. It needs codegen to take the target as a PARAMETER rather than
inheriting the host's - see the open questions.

---

## 3. What a release actually is

**Not a binary.** `std/` and `runtime/` ship as SOURCE and are compiled into
every user program: the compiler shells out to clang with the runtime's `.c`
files on the line, and `std/` is resolved per-import from a root discovered
beside the executable (`YOOP_STD_ROOT`, `YOOP_RUNTIME_ROOT`).

So an artifact is a TREE, and its layout is dictated by that discovery rule:

    yoopiler-0.2.0-darwin-arm64/
      bin/yoopiler
      lib/std/...
      lib/runtime/...
      MANIFEST

Three consequences:

- A user program's behavior depends on the compiler, on `std/`, and on
  `runtime/` INDEPENDENTLY. That is what makes the versioning question below a
  real question rather than decoration.
- **clang is a runtime dependency of the shipped product**, not just of the
  build. Two identical yoopiler versions paired with different clangs can behave
  differently - and this project has already been bitten by exactly that, since
  `llvm.coro.end` changed signature between LLVM 19 and 20. So the clang a build
  was VALIDATED against belongs in the manifest, and probably in
  `yoopiler --version`.
- The archive has to preserve the layout the discovery probe expects, so the
  packaging step is not just "zip the binary".

---

## 4. Build identity

The proposal in the brief was
`windows-x86.{runtimeVer}.{stdVer}.{buildNumber}` as a suffix to other
versioning, and I think the instinct is right for the reason in section 3: three
things vary independently, so one number cannot describe the artifact.

**Use SemVer BUILD METADATA, the part after `+`.** It exists for precisely this,
and it is defined as ignored when comparing versions - which is what "separate
from semver" means formally:

    0.2.0+darwin-arm64.rt4.std12.b1183
    0.2.0+windows-x86-64.rt4.std12.b1183
    0.2.0+linux-x86-64.rt4.std12.b1183

One language version, several build identities, and no tooling will ever think
one of them is newer than another.

Two mechanical notes:

- The charset for build metadata is `[0-9A-Za-z-]` in dot-separated identifiers.
  Hyphens are legal, **underscores are not**, so `windows_x86` would make the
  string an invalid SemVer. Use `windows-x86-64`.
- Put the platform FIRST, as the brief did. It is the field a human checks first
  when a bug report comes in.

### What `rt4` and `std12` should actually be

The trap is that a hand-bumped integer WILL be forgotten, and a forgotten bump
is worse than no bump - it makes two different trees claim the same identity.

Suggestion, in the spirit of the rest of this project: **a hand-bumped integer,
plus a content hash of the tree, and CI refuses the build when the hash moved
and the integer did not.** The integer is what humans read and order by; the
hash is what makes forgetting impossible. Same shape as "refuse by name rather
than diverge silently".

`bNNNN` is the CI run number, monotonic, and is the only field that changes on a
rebuild of identical inputs.

### The shared build

The brief asks for "a shared build with per-platform assembly info". Concretely
that is: the shared part is `rt4.std12.b1183`, the varying part is the platform,
and **the shared build should be a real artifact** - a manifest listing every
platform archive with its hash:

    version: 0.2.0
    build:   rt4.std12.b1183
    clang-validated: 20.1.4
    artifacts:
      darwin-arm64    sha256:...
      darwin-x86-64   sha256:...
      linux-x86-64    sha256:...
      linux-arm64     sha256:...
      windows-x86-64  sha256:...

That file is what a future package manager, an installer script, and
`yoopiler --version` all agree on. It is also the thing to sign, if signing ever
matters.

---

## 5. Shape of the pipeline

Nothing exotic. Fan out, gather, publish.

**Per platform, in parallel:**

1. Fetch the pinned seed, verify its hash.
2. Three-stage build; assert stage2 and stage3 are byte-identical as binaries
   AND as emitted `.ll`. Note the trick already learned: clang embeds the output
   path in the Mach-O and in the signature that covers it, so the two stages go
   to different directories with the SAME basename.
3. `yoopiler_boot --test bootstrap/src` - the Yoop unit suite, through the
   compiler just built. This is the regression suite that survives the JS
   retirement.
4. The slice corpus through the built stage (`YOOP_BOOT_COMPILER`), asserted
   against the hand-written `.expected` files.
5. Both probes, `probe_surface.sh` and `probe_programs.sh`. Compare the numbers
   against the ones recorded in `plans/bootstrap-completion.md` and fail on a
   REGRESSION rather than on any change - the counts are supposed to move
   upward.
6. Package the tree, upload.

**Once, on any one runner:** the host-independence IR diff from section 2.

**On all green:** assemble the manifest, tag, publish.

During the transition, the JS-side suites (`npm test`, `test:parity`) run too;
they come out of the matrix the day `src/` retires.

Rough cost, extrapolating from this machine: the three-stage build is about 20
seconds, the Yoop suite 14, the slice corpus 27, the surface probe 63. Call it
three minutes per platform, comfortably parallel.

### One non-obvious dependency

**Node does not leave with the JS compiler.** `slice.test.js`, `e2e.test.js` and
`testProc.js` are node, and both probes are shell. So retiring `src/` retires
the reference COMPILER but leaves node as a CI and developer dependency until
those harnesses are themselves ported to Yoop. That is fine, and it is worth
being explicit about rather than discovering it on the day.

Porting the slice harness to Yoop is a plausible follow-on now that `--test`
works, and it would make the toolchain genuinely self-contained.

---

## 6. Open questions, roughly in the order they need answering

1. **Which seed mechanism** (section 1). Blocks everything.
2. **Does codegen take the target as a parameter?** I found no target-triple
   emission in either codegen, and clang warns about "overriding the module
   target triple", which suggests the host's default is being inherited. If so,
   the host-independence check and the portable-`.ll` seed both need a
   `--target` flag first. Worth measuring before assuming either way.
3. **`c_long` is `int64` in BOTH compilers.** That is the LP64 assumption, and
   Windows is LLP64, where `long` is 32 bits. Windows passes its full suite
   today, so either nothing exercised on Windows uses `c_long` or this is
   latent. It needs one probe to settle, and if it is latent it is a
   silent-wrong-answer class bug in FFI signatures, which is the worst class.
4. **Which fixtures are platform-sensitive**, and what marks them. There is
   already precedent for both halves: `.bootonly` markers in the slice corpus
   and `dwarfSkipReason` self-skipping the DWARF tests on Windows (Windows uses
   CodeView). A `.platform` marker is the obvious extension. This wants a survey
   before the matrix goes green-or-red on it.
5. **Runner prerequisites.** `std/tls` wants OpenSSL, and `librarySearchArgs()`
   already knows about Homebrew prefixes and vcpkg. Each runner image needs
   pinning, and the pinned clang version needs recording in the manifest.
6. **Does `yoopiler --version` exist**, and does it print the full build
   identity? If not, that is the smallest piece of work here and the one that
   makes every bug report better.
7. **Which platforms are in the matrix on day one.** Suggest starting with
   darwin-arm64 (where everything is known good) and linux-x86-64 (the most
   different thing that is cheap), and adding windows-x86-64 third even though
   it is supported, because it has the most environment-specific setup.

---

## What I would do first, if this were being built

Not a commitment, just the ordering I would defend:

1. Answer question 2 (target as a parameter). It is a measurement, it is cheap,
   and two other decisions depend on it.
2. Pick the seed mechanism and build the one-time hand bootstrap from the JS
   reference. Nothing else can start until a seed exists.
3. Stand up a ONE-platform pipeline end to end, on darwin-arm64, including the
   manifest and the build identity. Get the release shape right where everything
   already works.
4. Add linux-x86-64. The first foreign platform is where the host-dependence
   bugs surface, and finding them with one added runner is cheaper than finding
   them with four.
5. Add the host-independence IR diff, which is only meaningful once there are
   two platforms.
6. Then windows-x86-64, then the remaining architectures, then retire `src/`
   from the matrix.
