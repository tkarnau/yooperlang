#!/bin/bash
#
# The PROGRAM probe: build every runnable example with BOTH compilers, run both
# binaries, and compare stdout and exit code.
#
# This is the sibling of scripts/probe_surface.sh and it answers a different
# question. probe_surface asks "does codegen produce valid IR for this FILE",
# over std/, examples/pass/ and bootstrap/src/. It never links and never runs,
# so it cannot tell a program that works from one that merely compiles. This
# one takes the ENTRY POINTS - the files with a `main` - links them, runs them,
# and diffs the two compilers against each other.
#
# The two probes are deliberately separate rather than one flag apart. The
# surface numbers are what the bootstrap-completion plan has been steered by
# for its whole life, and a probe that made them move would be a broken probe.
#
# Usage:
#   scripts/probe_programs.sh [compiler] [jobs] [filter]
#
#   compiler   the bootstrap under test, default /tmp/yoopiler_boot
#   jobs       parallel workers, default core count capped at 12
#   filter     a grep -E pattern over the entry path, default everything
#
# Output: one line per program on stdout, sorted, plus a per-group summary on
# stderr. A program's line is `<entry>\t<CATEGORY>\t<detail>`.
#
# The categories, and what each one is a finding ABOUT:
#
#   OK        both compilers built it, both ran it, same stdout and same exit
#             code. The only category that says the bootstrap is fine.
#   DIFFER    both built and ran it and the two disagree. The most interesting
#             result there is, and always worth chasing.
#   BOOTGAP   the reference built it and the bootstrap did not. A BOOTSTRAP bug.
#   REFGAP    the bootstrap built it and the reference did not. Rare, and a
#             finding about the reference.
#   STALE     neither compiler built it. A finding about the PROGRAM, not about
#             either compiler - a stale example, or one whose libraries are not
#             installed on this machine.
#
# Nothing here is a test. examples/playground/ in particular is explicitly not
# a test surface (see CLAUDE.md), so a STALE line there is a note and not a
# regression.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPILER="${1:-/tmp/yoopiler_boot}"
JOBS="${2:-}"
FILTER="${3:-.}"

if [ ! -x "$COMPILER" ]; then
  echo "probe_programs: no compiler at $COMPILER" >&2
  echo "build one with: node src/yoopiler.js bootstrap/src/main.yoop -o /tmp/yoopiler_boot" >&2
  exit 1
fi

if [ -z "$JOBS" ]; then
  JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)"
  [ "$JOBS" -gt 12 ] && JOBS=12
fi

export YOOP_STD_ROOT="${YOOP_STD_ROOT:-$ROOT/std}"
export YOOP_RUNTIME_ROOT="${YOOP_RUNTIME_ROOT:-$ROOT/runtime}"

# How long a compile and a run each get. Several examples are SERVERS or
# graphical loops that never return on their own; they time out under both
# compilers, which is a matching outcome and classifies as OK. The limit is
# what keeps the probe finite, not a judgement about the program.
COMPILE_LIMIT="${YOOP_PROBE_COMPILE_LIMIT:-120}"
RUN_LIMIT="${YOOP_PROBE_RUN_LIMIT:-20}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Run a command with a wall-clock limit, since macOS ships no `timeout`.
# Exits 124 on the limit, and 128+signal when the child is killed, so a
# segfault reads as 139 on both sides rather than being flattened into a
# generic failure.
limit_run() {
  perl -e '
    my $t = shift @ARGV;
    my $pid = fork();
    exit 125 if !defined $pid;
    if ($pid == 0) { exec @ARGV; exit 127; }
    $SIG{ALRM} = sub { kill 9, $pid; waitpid($pid, 0); exit 124; };
    alarm $t;
    waitpid($pid, 0);
    my $st = $?;
    exit(($st & 127) ? 128 + ($st & 127) : ($st >> 8));
  ' "$@"
}
export -f limit_run

# One program, both compilers.
#
# The two builds go to different DIRECTORIES rather than different basenames,
# for the same reason the self-host fixpoint check does it: clang embeds the
# output path in the Mach-O, so `-o x_bs` and `-o x_js` differ in bytes that
# say nothing about the compiler. It matters less here (nothing compares the
# binaries) but keeping one rule is cheaper than keeping two.
#
# cwd is the ENTRY's OWN DIRECTORY, which is what a user typing the command
# would have. A few examples open an asset by relative path and https_client
# wants its testdata/ beside it.
probe_program() {
  local entry="$1"
  local tag; tag="$(printf '%s' "$entry" | tr '/.' '__')"
  local dir="$WORK/$tag"
  local entryDir; entryDir="$(dirname "$ROOT/$entry")"
  mkdir -p "$dir/bs" "$dir/js"

  local bsLog="$dir/bs.log" jsLog="$dir/js.log"
  local bsRc jsRc
  limit_run "$COMPILE_LIMIT" "$COMPILER" "$ROOT/$entry" -o "$dir/bs/prog" \
    >"$bsLog" 2>&1
  bsRc=$?
  limit_run "$COMPILE_LIMIT" node "$ROOT/src/yoopiler.js" "$ROOT/$entry" \
    -o "$dir/js/prog" >"$jsLog" 2>&1
  jsRc=$?

  local bsBuilt=0 jsBuilt=0
  [ "$bsRc" -eq 0 ] && [ -x "$dir/bs/prog" ] && bsBuilt=1
  [ "$jsRc" -eq 0 ] && [ -x "$dir/js/prog" ] && jsBuilt=1

  if [ "$bsBuilt" -eq 0 ] && [ "$jsBuilt" -eq 0 ]; then
    printf '%s\tSTALE\t%s\n' "$entry" "$(first_error "$jsLog")"
    return
  fi
  if [ "$bsBuilt" -eq 0 ]; then
    printf '%s\tBOOTGAP\t%s\n' "$entry" "$(first_error "$bsLog")"
    return
  fi
  if [ "$jsBuilt" -eq 0 ]; then
    printf '%s\tREFGAP\t%s\n' "$entry" "$(first_error "$jsLog")"
    return
  fi

  # Both built. Run each the same way: no arguments, stdin closed, the entry's
  # own directory as cwd, stdout and stderr merged so a program that reports
  # through log.error is compared on that too.
  local bsOut="$dir/bs.out" jsOut="$dir/js.out"
  ( cd "$entryDir" && limit_run "$RUN_LIMIT" "$dir/bs/prog" </dev/null \
    >"$bsOut" 2>&1 )
  local bsRun=$?
  ( cd "$entryDir" && limit_run "$RUN_LIMIT" "$dir/js/prog" </dev/null \
    >"$jsOut" 2>&1 )
  local jsRun=$?

  if [ "$bsRun" -ne "$jsRun" ]; then
    printf '%s\tDIFFER\texit %s (boot) vs %s (ref)\n' "$entry" "$bsRun" "$jsRun"
    return
  fi
  if ! cmp -s "$bsOut" "$jsOut"; then
    printf '%s\tDIFFER\tstdout differs: %s\n' "$entry" "$(first_diff "$bsOut" "$jsOut")"
    return
  fi
  printf '%s\tOK\texit %s\n' "$entry" "$bsRun"
}
export -f probe_program

# The one line of a compile log worth reporting, in preference order. The two
# compilers do not agree on a diagnostic format - the bootstrap prefixes
# `[error]` and the reference renders a caret block under a `path:line:col:`
# header - so a single grep would find one of them and report the other's
# banner or its trailing caret. Clang and a node stack trace are the fallbacks.
first_error() {
  local line
  line="$(grep -E '^\[error\]' "$1" | head -1)"
  [ -z "$line" ] && line="$(grep -E '\.yoop:[0-9]+:[0-9]+: ' "$1" | head -1)"
  [ -z "$line" ] && line="$(grep -E 'error:|Error' "$1" | head -1)"
  [ -z "$line" ] && line="$(grep -v '^$' "$1" | tail -1)"
  printf '%s' "${line#\[error\] }" | sed "s|$ROOT/||g" | cut -c1-160
}
export -f first_error

# The first differing line pair, rendered on one line. Enough to tell a wrong
# number from a missing section without dumping either file.
first_diff() {
  diff "$1" "$2" 2>/dev/null | grep -E '^[<>]' | head -2 | tr '\n' ' ' \
    | cut -c1-160
}
export -f first_diff

export COMPILER WORK ROOT COMPILE_LIMIT RUN_LIMIT

# ---------------------------------------------------------------------------
# The entry set.
#
# An ENTRY is a file that DECLARES a `main`, which in this tree means a
# top-level `.yoop` beside its siblings or a `main.yoop` inside a program
# directory. The `main` test is not decoration: `examples/tour/ep12_geometry.yoop`
# is a library its sibling test file exercises, and without the test it would
# report as a program that fails to link on both sides - a finding about the
# probe rather than about anything.
#
# `examples/fail/` is excluded on purpose: those programs are compile-error
# fixtures, so "does it build" is the wrong question to ask of one.
# `*.test.yoop` is excluded too - a test module has no `main` by design, and
# the `--test` driver mode it needs is measured separately (see item 4.3 in
# plans/bootstrap-completion.md).
# ---------------------------------------------------------------------------
cd "$ROOT"
{
  ls examples/pass/*.yoop 2>/dev/null
  ls examples/pass/*/main.yoop 2>/dev/null
  ls examples/intro/*.yoop 2>/dev/null
  ls examples/tour/*.yoop 2>/dev/null
  ls examples/modules_demo/main.yoop 2>/dev/null
  ls examples/playground/*.yoop 2>/dev/null
  ls examples/playground/*/main.yoop 2>/dev/null
} | grep -v '\.test\.yoop$' | grep -E "$FILTER" | sort -u \
  | while read -r f; do
      grep -qE '^[[:space:]]*(export[[:space:]]+)?function[[:space:]]+main[[:space:]]*\(' "$f" \
        && echo "$f"
    done > "$WORK/entries.txt"

# Three substitutions, all so two runs of this diff cleanly - which is the whole
# point of running it once per stage. The repo root goes (two checkouts), this
# run's work directory goes (it is an mktemp), and so does the REFERENCE's own
# temp directory: `yoopiler-XXXXXX` is where it stages its `.ll`, it appears in
# a clang error message, and it was the ONLY byte separating the stage1 and
# stage3 reports - a random name saying nothing about either compiler.
xargs -P "$JOBS" -I{} bash -c 'probe_program "$@"' _ {} < "$WORK/entries.txt" \
  | sed "s|$ROOT/||g; s|$WORK/[^ ]*|<out>|g; s|/[^ ]*/yoopiler-[A-Za-z0-9]*/|<jstmp>/|g" \
  | sort > "$WORK/results.txt"

cat "$WORK/results.txt"

# ---------------------------------------------------------------------------
# Summary, by GROUP. The groups answer different questions and their totals
# should never be added together: examples/pass is a test surface, the tour and
# intro are teaching material, and examples/playground is explicitly not a test
# surface at all.
# ---------------------------------------------------------------------------
group_of() {
  case "$1" in
    examples/playground/*) echo playground ;;
    examples/tour/*)       echo tour ;;
    examples/intro/*)      echo intro ;;
    examples/modules_demo/*) echo modules_demo ;;
    *)                     echo pass ;;
  esac
}

{
  echo
  printf '  %-14s %5s %5s %6s %7s %6s %6s\n' \
    group total ok differ bootgap refgap stale
  for g in pass intro tour modules_demo playground; do
    n=0; ok=0; differ=0; bootgap=0; refgap=0; stale=0
    while IFS=$'\t' read -r f cat _rest; do
      [ "$(group_of "$f")" = "$g" ] || continue
      n=$((n + 1))
      case "$cat" in
        OK)      ok=$((ok + 1)) ;;
        DIFFER)  differ=$((differ + 1)) ;;
        BOOTGAP) bootgap=$((bootgap + 1)) ;;
        REFGAP)  refgap=$((refgap + 1)) ;;
        STALE)   stale=$((stale + 1)) ;;
      esac
    done < "$WORK/results.txt"
    [ "$n" -eq 0 ] && continue
    printf '  %-14s %5d %5d %6d %7d %6d %6d\n' \
      "$g" "$n" "$ok" "$differ" "$bootgap" "$refgap" "$stale"
  done
  echo
  echo "  BOOTGAP and DIFFER are the bootstrap's problems. STALE is the"
  echo "  program's. Full lines are on stdout."
  echo
  awk -F'\t' '$2=="BOOTGAP" || $2=="DIFFER"' "$WORK/results.txt" \
    | while IFS=$'\t' read -r f cat detail; do
        printf '  %-8s %s\n           %s\n' "$cat" "$f" "$detail"
      done
} >&2
