#!/bin/sh
# Drive load at counter_server and print what it thought of it.
#
#   ./stress.sh                              # localhost:8080, 30s, 50 conns
#   ./stress.sh http://1.2.3.4:8080 60 200   # url, seconds, connections
#
# Prefers a keep-alive-capable generator (oha, wrk, bombardier, hey) and
# falls back to ab. That order is not cosmetic: ab speaks HTTP/1.0, so it
# opens a fresh connection per request and measures connection setup as
# much as it measures the server. Install one of the others before drawing
# conclusions from the number.

set -eu

URL="${1:-http://127.0.0.1:8080}"
DURATION="${2:-30}"
CONNS="${3:-50}"

TARGET="$URL/count"
STATS="$URL/stats"

echo "target:      $TARGET"
echo "duration:    ${DURATION}s"
echo "connections: $CONNS"
echo

echo "--- before ---"
curl -fsS "$STATS" || { echo "server not reachable at $STATS"; exit 1; }
echo

if command -v oha >/dev/null 2>&1; then
    echo "--- oha ---"
    oha -z "${DURATION}s" -c "$CONNS" --no-tui "$TARGET"
elif command -v wrk >/dev/null 2>&1; then
    echo "--- wrk ---"
    wrk -t"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" \
        -c"$CONNS" -d"${DURATION}s" --latency "$TARGET"
elif command -v bombardier >/dev/null 2>&1; then
    echo "--- bombardier ---"
    bombardier -c "$CONNS" -d "${DURATION}s" -l "$TARGET"
elif command -v hey >/dev/null 2>&1; then
    echo "--- hey ---"
    hey -z "${DURATION}s" -c "$CONNS" "$TARGET"
elif command -v ab >/dev/null 2>&1; then
    echo "--- ab (HTTP/1.0: no keep-alive, so this undercounts) ---"
    # ab has no duration flag; approximate from a conservative rate guess.
    ab -n "$((DURATION * 2000))" -c "$CONNS" -k "$TARGET"
else
    echo "no load generator found. install one:"
    echo "  brew install oha        # or wrk, bombardier, hey"
    echo "  apt-get install -y wrk"
    exit 1
fi

echo
echo "--- after ---"
# `count` here is exact regardless of worker count (it is a single atomic
# add), so it should equal the generator's completed-request total. A gap
# means requests the generator counted as sent that never reached a handler.
curl -fsS "$STATS"
echo
