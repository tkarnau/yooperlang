#!/bin/bash
#
# The surface probe: compile every non-test .yoop under std/, examples/pass/ and
# bootstrap/src/ with a bootstrap compiler, and report what stops each one.
#
# This is the measurement the bootstrap-completion plan is steered by, so it
# gets run many times a day. It is PARALLEL because it is subprocess-bound
# rather than compute-bound: the compiler itself is fast and most of the wall
# clock is spent waiting on clang, so a serial run uses about 15% of one core
# on a 14-core machine. Ten workers takes it from ~7 minutes to well under one.
#
# It also does NOT LINK. `--emit-ir` stops the compiler one step short of
# clang, and the two things the link used to answer as a side effect are asked
# directly instead: `clang -S -emit-llvm` says whether the IR is valid, and the
# IR itself says whether there is a `main` to link. That is the whole
# difference between `ok` and `no-main`, and reading it off a `define` line is
# both faster and more honest than reading it off a linker message.
#
# Usage:
#   scripts/probe_surface.sh [compiler] [jobs]
#
#   compiler   defaults to /tmp/yoopiler_boot
#   jobs       defaults to the machine's core count, capped at 12
#
# Output: one line per file on stdout, sorted, plus a summary on stderr.
# A file's line is its category and, for the two failing ones, the message -
# with the repo root stripped so two runs from different checkouts diff cleanly.
#
# Reading the numbers:
#
#   ok         codegen produced valid IR that defines a `main`
#   no-main    codegen produced valid IR with no `main` - a library compiled
#              standalone. Its code is fully handled, so `done` counts these.
#   bad-ir     codegen produced INVALID IR. A real codegen bug.
#   refused    stopped earlier, at a named parse or typecheck refusal.
#
# The DISTINCT SITE count is the honest measure of what is left, not the file
# count: the bootstrap's own source is one deep import closure, so a single
# unsupported line gates most of the tree and the totals move in a block.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPILER="${1:-/tmp/yoopiler_boot}"
JOBS="${2:-}"

if [ ! -x "$COMPILER" ]; then
  echo "probe_surface: no compiler at $COMPILER" >&2
  echo "build one with: node src/yoopiler.js bootstrap/src/main.yoop -o /tmp/yoopiler_boot" >&2
  exit 1
fi

if [ -z "$JOBS" ]; then
  JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)"
  [ "$JOBS" -gt 12 ] && JOBS=12
fi

export YOOP_STD_ROOT="${YOOP_STD_ROOT:-$ROOT/std}"
export YOOP_RUNTIME_ROOT="${YOOP_RUNTIME_ROOT:-$ROOT/runtime}"

# How long the compiler and the IR validation each get.
#
# This probe runs many times a day against a compiler that is being actively
# changed, and the failure mode that costs the most is not a wrong answer, it is
# a compiler that does not terminate: a lexer that stops advancing or a resolver
# that cycles pins a core at 100% and nothing here used to stop it. With
# `xargs -P 12` that is up to twelve of them, and they outlive an interrupted
# probe. A minute is many times the slowest file in the corpus
# (typecheck/pass_d.yoop, at about 3 seconds), so nothing healthy comes near it.
COMPILE_LIMIT="${YOOP_PROBE_COMPILE_LIMIT:-60}"
IR_LIMIT="${YOOP_PROBE_IR_LIMIT:-60}"

# Same supervisor scripts/probe_programs.sh uses, and the reasoning is written
# out there. Short version: it kills the process TREE so the clang a compiler
# started goes with the compiler, it deliberately leaves the child in this
# probe's process group so a group-directed kill of the probe still reaches it,
# and it holds its own alarm so the limit survives losing its caller.
limit_run() {
  perl -e '
    sub descend {
      my @out; my @q = @_;
      while (@q) {
        my $p = shift @q;
        my @k = grep { /^\d+$/ } split /\s+/, (`pgrep -P $p 2>/dev/null` || "");
        push @out, @k; push @q, @k;
      }
      return @out;
    }
    my $t = shift @ARGV;
    my $pid = fork();
    exit 125 if !defined $pid;
    if ($pid == 0) { exec @ARGV; exit 127; }
    my $reap = sub {
      for (1 .. 2) { my @d = descend($pid); last unless @d; kill(9, @d); }
      kill(9, $pid);
    };
    $SIG{ALRM} = sub { $reap->(); waitpid($pid, 0); exit 124; };
    $SIG{INT}  = sub { $reap->(); exit 130; };
    $SIG{TERM} = sub { $reap->(); exit 143; };
    alarm $t;
    waitpid($pid, 0);
    my $st = $?;
    alarm 0;
    exit(($st & 127) ? 128 + ($st & 127) : ($st >> 8));
  ' "$@"
}
export -f limit_run

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# One file. Each worker needs its OWN output path - they all used to write
# /tmp/sp, which is a race the moment this went parallel and would have shown up
# as a flaky link failure rather than as anything obviously wrong. The stale
# `.ll` is removed BEFORE the compile as well as after, because a PID can be
# reused and a leftover from the previous holder of this name would be read as
# this file's output.
probe_one() {
  local f="$1"
  local out="$WORK/out.$$"
  local all err irerr rc
  rm -f "$out.ll"
  all="$(limit_run "$COMPILE_LIMIT" "$COMPILER" "$f" -o "$out" --emit-ir 2>&1)"
  rc=$?
  # TIMEOUT is its own category rather than a REFUSED with an odd message: a
  # compiler that does not terminate is a different finding from a named parse
  # or typecheck refusal, and folding it into `refused` would quietly move the
  # number the completion plan is steered by. On a healthy run it never appears.
  if [ "$rc" -eq 124 ]; then
    rm -f "$out.ll"
    printf '%s\tTIMEOUT\tcompiler did not finish within %ss (killed)\n' "$f" "$COMPILE_LIMIT"
    return
  fi
  err="$(printf '%s\n' "$all" | grep -E '^\[error\]' | head -1)"
  if [ -n "$err" ]; then
    rm -f "$out.ll"
    printf '%s\tREFUSED\t%s\n' "$f" "${err#\[error\] }"
    return
  fi

  # Codegen succeeded, so the file's CODE is handled. What is left is the two
  # questions the link used to answer by failing: is the IR valid, and is there
  # a `main`? `-S -emit-llvm` parses and verifies without generating code, and
  # it names the offending instruction where "clang failed (exit 256)" named
  # nothing.
  irerr="$(limit_run "$IR_LIMIT" "$CLANG" -Wno-override-module -S -emit-llvm "$out.ll" -o /dev/null 2>&1 \
    | grep -E ': error: ' | head -1)"
  if [ -n "$irerr" ]; then
    printf '%s\tBADIR\tinvalid IR: %s\n' "$f" "${irerr##*: error: }"
  elif grep -qE '^define [^@]*@main\(' "$out.ll"; then
    printf '%s\tOK\t\n' "$f"
  else
    printf '%s\tNOMAIN\t\n' "$f"
  fi
  rm -f "$out.ll"
}
export -f probe_one
# `YOOP_CLANG` is how the rest of the tree names a clang that is not on PATH, so
# the validity check honours it too rather than inventing a second rule.
CLANG="${YOOP_CLANG:-clang}"
export COMPILER WORK CLANG COMPILE_LIMIT IR_LIMIT

cd "$ROOT"
find std examples/pass bootstrap/src -name '*.yoop' ! -name '*.test.yoop' \
  | sort \
  | xargs -P "$JOBS" -I{} bash -c 'probe_one "$@"' _ {} \
  | sed "s|$ROOT/||g; s|$WORK/out\.[0-9]*|<out>|g" \
  | sort > "$WORK/results.txt"

cat "$WORK/results.txt"

count_cat() { awk -F'\t' -v c="$1" '$2==c' "$WORK/results.txt" | wc -l | tr -d ' '; }
total=$(wc -l < "$WORK/results.txt" | tr -d ' ')
ok=$(count_cat OK); nomain=$(count_cat NOMAIN)
badir=$(count_cat BADIR); refused=$(count_cat REFUSED)
timeout=$(count_cat TIMEOUT)
sites=$(awk -F'\t' '$2=="REFUSED" || $2=="BADIR"' "$WORK/results.txt" \
  | cut -f3 | sort -u | wc -l | tr -d ' ')

{
  echo
  echo "  files      $total"
  echo "  ok         $ok"
  echo "  no-main    $nomain"
  echo "  done       $((ok + nomain))"
  echo "  bad-ir     $badir"
  echo "  refused    $refused"
  # Printed only when it happens, so the shape of a healthy report is unchanged.
  [ "$timeout" -gt 0 ] && echo "  timeout    $timeout   (compiler did not terminate - a hang, not a gap)"
  echo "  sites      $sites   (distinct file:line:message - the honest measure)"
  echo
  echo "  top blockers by file count:"
  awk -F'\t' '$2=="REFUSED" || $2=="BADIR"' "$WORK/results.txt" | cut -f3 \
    | sed 's/^[^ ]*yoop:[0-9]*:[0-9]*: //' \
    | sed 's/"[^"]*"/"X"/g; s/[0-9][0-9]*/N/g' \
    | sort | uniq -c | sort -rn | head -8 | cut -c1-96
} >&2
