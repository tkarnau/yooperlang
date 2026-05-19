#!/bin/sh
# Build and run each C-level runtime smoke test. Run from repo root.
set -eu
CC=${CC:-clang}
HERE="$(cd "$(dirname "$0")" && pwd)"
RT="$HERE/.."
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

LINK_FLAGS=""
case "$(uname -s)" in
    Linux|Darwin|*BSD*) LINK_FLAGS="-lpthread" ;;
esac

for t in smoke submit_one submit_many refcount; do
    bin="$OUT/yoop_test_$t"
    echo "[build] $t"
    $CC -std=c11 -O0 -g -Wall -Wextra -Werror -pthread \
        "$RT/yoop_runtime.c" "$HERE/$t.c" \
        $LINK_FLAGS -o "$bin"
    echo "[run]   $t"
    "$bin"
    if command -v valgrind >/dev/null 2>&1; then
        echo "[valgrind] $t"
        valgrind --error-exitcode=1 --leak-check=full \
                 --errors-for-leak-kinds=definite,possible \
                 --quiet "$bin"
    fi
done
echo "all runtime tests passed"
