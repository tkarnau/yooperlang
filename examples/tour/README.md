# The tour

Five short programs, in order. Each one compiles and runs.

1. `hello.yoop` - `main`, `printf`, and the exit code
2. `functions.yoop` - parameters, return types, casts, `ref`
3. `strings.yoop` - `string` vs `Text`, template literals, logging
4. `traits.yoop` - a capability, implemented and used through a bound
5. `kinds.yoop` - the third axis, and cleanup the compiler places for you

The web version of the same five, with the output and the errors already
captured, is at <https://tkarnau.github.io/yooperlang/tour.html>.

## Running them

With the compiler from a release:

```sh
yoopiler_boot examples/tour/hello.yoop
./examples/tour/hello
```

Or from a checkout:

```sh
node ./src/yoopiler.js examples/tour/hello.yoop
./examples/tour/hello
```

The binary lands next to the source with the extension stripped. To hide
clang's target-triple warning:

```sh
node ./src/yoopiler.js examples/tour/kinds.yoop 2>&1 | grep -v "warning:\|generated"
```

## If you add one

Keep it short, keep the comments shorter, and make sure it runs. The site reads
these files directly (`scripts/gen_web.mjs` compiles and runs each one to
capture its output), so a program that stops compiling fails the regeneration
rather than quietly publishing something untrue.
