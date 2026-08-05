#!/bin/sh
# Build and run each C-level runtime smoke test. Run from repo root.
#
# Every test links the FULL runtime source set. Linking only
# yoop_runtime.c stopped working when 8.F.2 made yoop_runtime_shutdown
# call yoop_io_shutdown, which lives in yoop_io.c - the script had been
# failing at the first link ever since.
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

# Keep in sync with RUNTIME_SOURCES in src/runtimeBuild.js.
RUNTIME_SRCS="$RT/yoop_runtime.c $RT/yoop_io.c $RT/yoop_cancel.c $RT/yoop_net.c \
$RT/yoop_debug.c $RT/yoop_format.c $RT/yoop_args.c $RT/yoop_alloc.c"

TESTS="smoke submit_one submit_many refcount park_unpark sleep_ms io_pipe \
cancel_token io_deadline io_cancel io_fd_conflict"

for t in $TESTS; do
    bin="$OUT/yoop_test_$t"
    echo "[build] $t"
    $CC -std=c11 -O0 -g -Wall -Wextra -Werror -pthread \
        $RUNTIME_SRCS "$HERE/$t.c" \
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
