# Sample programs (drop zone)

Everything in this directory gets copied into a distribution build as
`samples/`, so whatever you leave here is what your recipient finds when they
unzip it.

Add or delete freely. `npm run build:sea` copies the directory as-is on every
build, so there is no list to keep in sync.

Three starter programs are here to begin with, copied from `examples/intro/`,
plus `yoopls.yoop` - a small `ls` built on `std/fs` that shows a trait, a kind
and a variant doing real work. Swap them out for whatever you want to show off.

## Conventions worth keeping

- Only `.yoop` sources and markdown. Compiled binaries are extensionless and
  the build skips them, but there is no reason to commit them here anyway.
- Each program should compile against the shipped standard library alone. If a
  sample needs something outside `std/` (SDL2, a network service on localhost),
  say so in a comment at the top - the recipient has no way to guess.
- Keep them runnable end to end. A sample that fails to compile is a worse
  first impression than no sample at all.

## Checking them before you ship

There is no automated test over this directory. To sanity check the whole set
against a build:

```sh
npm run build:sea
for f in dist/yoopiler-*/samples/*.yoop; do
  ./dist/yoopiler-*/bin/yoopiler_alpha "$f" || echo "FAILED: $f"
done
```
