# Sample programs (drop zone)

Small, self-contained programs meant to be handed to someone who has just
installed the compiler: `hello.yoop`, `fibonacci.yoop`,
`structs_and_traits.yoop` (all three from `examples/intro/`), and
`yoopls.yoop` - a small `ls` built on `std/fs` that shows a trait, a kind and a
variant doing real work.

Nothing copies this directory into a release today. `npm run package:boot`
ships the compiler, `lib/std`, `lib/runtime` and
[../bootstrap_readme.md](../bootstrap_readme.md), and nothing else. Adding
samples to the package means adding them to
[../../scripts/package_bootstrap.mjs](../../scripts/package_bootstrap.mjs).

## Conventions worth keeping

- Only `.yoop` sources and markdown. Compiled binaries are extensionless and
  there is no reason to commit them here.
- Each program should compile against the shipped standard library alone. If a
  sample needs something outside `std/` (SDL2, a network service on localhost),
  say so in a comment at the top - the recipient has no way to guess.
- Keep them runnable end to end. A sample that fails to compile is a worse
  first impression than no sample at all.

## Checking them

There is no automated test over this directory. To sanity check the whole set:

```sh
YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime \
  $(node scripts/seed.mjs) bootstrap/src/main.yoop -o /tmp/yoopiler_boot
for f in packaging/samples/*.yoop; do
  YOOP_STD_ROOT=$PWD/std YOOP_RUNTIME_ROOT=$PWD/runtime \
    /tmp/yoopiler_boot "$f" -o /tmp/sample || echo "FAILED: $f"
done
```
