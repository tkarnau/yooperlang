#!/bin/sh
# The renderer's stand-in for tests and CI: answers every `phase` gate with
# `continue` and every `done` with `bye`, appending what it saw to
# $VIZWORLD_FAKE_LOG when that is set. Blob payload lines pass through
# unanswered, exactly as the real renderer consumes them silently.
while IFS= read -r line; do
  case "$line" in
    "phase "*)
      if [ -n "$VIZWORLD_FAKE_LOG" ]; then echo "$line" >> "$VIZWORLD_FAKE_LOG"; fi
      echo "continue"
      ;;
    "blob "*)
      if [ -n "$VIZWORLD_FAKE_LOG" ]; then echo "$line" >> "$VIZWORLD_FAKE_LOG"; fi
      ;;
    "file "*)
      if [ -n "$VIZWORLD_FAKE_LOG" ]; then echo "$line" >> "$VIZWORLD_FAKE_LOG"; fi
      ;;
    "done "*)
      if [ -n "$VIZWORLD_FAKE_LOG" ]; then echo "$line" >> "$VIZWORLD_FAKE_LOG"; fi
      echo "bye"
      ;;
  esac
done
