#!/bin/bash
#
# The vizworld renderer's graphics smoke: build it, then prove the binary
# starts and answers the no-GL case the documented way. This is the ONLY
# graphics-touching check in the tree, and it SKIPS (exit 0, saying so) on a
# machine with no SDL2 - CI has none, and every real assertion about the
# renderer's logic lives in the pure modules' *.test.yoop suites instead.
#
# Under SDL_VIDEODRIVER=dummy there is a window but no GL, so the renderer
# must refuse with its own message and exit 1 - a crash or a hang here is a
# real bug. A machine with a display can simply run the plugin instead.

set -u
cd "$(dirname "$0")/.."

if ! ldconfig -p 2>/dev/null | grep -q libSDL2; then
  echo "viz_smoke: SKIP - no SDL2 on this machine"
  exit 0
fi

npm run viz:build >/dev/null 2>&1 || { echo "viz_smoke: the renderer did not build"; exit 1; }

out=$(SDL_VIDEODRIVER=dummy timeout 20 build/vizworld/vizworld </dev/null 2>&1)
code=$?
if [ "$code" -eq 1 ] && echo "$out" | grep -q "no GL context"; then
  echo "viz_smoke: ok (built, and refused the no-GL driver cleanly)"
  exit 0
fi
echo "viz_smoke: unexpected exit $code:"
echo "$out"
exit 1
