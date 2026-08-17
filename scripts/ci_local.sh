#!/usr/bin/env bash
#
# Runs what .github/workflows/ci.yml runs, in a Linux container, against the
# working tree as it is right now.
#
# The YAML wiring is the easy part of that workflow. The open question is
# whether a suite that has only ever run on macOS passes on Linux, and this is
# the cheap way to find out without a push-and-wait cycle per attempt.
#
#   scripts/ci_local.sh lint       the YAML itself: actionlint plus the job
#                                  graph act resolves. No container, instant.
#   scripts/ci_local.sh quick      the two things most likely to be broken,
#                                  in about a minute
#   scripts/ci_local.sh test       the whole test job
#   scripts/ci_local.sh release    the packaging job, minus the GitHub upload
#   scripts/ci_local.sh shell      a prompt in the container
#
#   --amd64                        force the runner's architecture. On an
#                                  x86_64 host that is already native and the
#                                  flag is a no-op; on Apple Silicon it means
#                                  qemu, and every process pays for it.
#
# The repo is mounted, not copied, so an edit on the host is visible to the
# next run with no rebuild. node_modules is shadowed by a named volume, which
# matters: esbuild installs a platform-specific binary, and letting a Linux
# `npm ci` write into the host's node_modules would break `npm run build:sea`
# on the mac until it was reinstalled.
#
# What this DOES cover, on an x86_64 Linux host: the runner's OS, its clang
# major version, and its architecture. That is the whole test job, for real.
# What it does not cover is any other target - macOS and Windows are not
# reachable from here by any local means, only from a runner that is one - and
# the parts of the workflow that are GitHub rather than shell: the tag
# condition, artifact upload, and `gh release create`. `lint` gets at the job
# graph; the rest is only ever proven by a push.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dockerfile="$repo/.github/ci-local/Dockerfile"
image="yoopiler-ci-local"
volume="yoopiler-ci-node-modules"
platform=""
mode="quick"

usage() {
  sed -n '3,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    lint | quick | test | release | shell) mode="$arg" ;;
    --amd64) platform="--platform=linux/amd64" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# lint answers a different question than the other modes and needs no
# container, so it runs and exits before any of the docker plumbing below.
#
# actionlint type-checks the YAML, the ${{ }} expressions, and the shell
# inside `run:` blocks - the class of mistake that otherwise costs a push to
# discover. That last part only happens when shellcheck is on PATH; without it
# actionlint says nothing about the shell and does not warn that it skipped.
# `act -l` then prints the job graph it resolved, which is the cheapest read on
# whether `needs:` and the stage ordering say what they were meant to say.
#
# All three come from mise:
#   mise use -g act@latest actionlint@latest shellcheck@latest
if [ "$mode" = "lint" ]; then
  missing=""
  for tool in actionlint act; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  if [ -n "$missing" ]; then
    echo "missing:$missing" >&2
    echo "install with: mise use -g act@latest actionlint@latest shellcheck@latest" >&2
    exit 1
  fi
  if ! command -v shellcheck >/dev/null 2>&1; then
    echo "note: shellcheck is not on PATH, so the shell in run: blocks goes unchecked" >&2
  fi

  echo "==> actionlint"
  actionlint
  echo "ok"

  echo
  echo "==> job graph"
  # act reaches for the docker socket even to list, and says so on stderr.
  # The listing itself is what is wanted here.
  act -l -W "$repo/.github/workflows/ci.yml" 2>/dev/null
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "the docker daemon is not reachable" >&2
  echo "  macOS: start Docker Desktop" >&2
  echo "  Linux: systemctl --user start docker, or check group membership" >&2
  exit 1
fi

# The build context is the directory holding the Dockerfile, which contains
# nothing else. The image COPYs nothing, so a large context would be pure
# upload time.
docker build $platform -t "$image" "$(dirname "$dockerfile")"

# Same deadlines the workflow sets. A container on a laptop is slower again
# than a hosted runner, and a suite that gets killed on a deadline reports as
# a hang rather than as a slow machine.
ci_env=(
  -e YOOP_SELFHOST_TIMEOUT_MS=900000
  -e YOOP_E2E_CLANG_TIMEOUT_MS=300000
  -e YOOP_E2E_RUN_TIMEOUT_MS=90000
  -e YOOP_SLICE_COMPILE_TIMEOUT_MS=300000
  -e YOOP_SLICE_RUN_TIMEOUT_MS=60000
  -e YOOP_PARITY_DUMP_TIMEOUT_MS=90000
)

case "$mode" in
  quick)
    # Two checks, ordered by how likely they are to be the thing that breaks.
    #
    # 1. The C runtime, compiled the way the suites compile it: -Wall -Wextra
    #    -Werror (src/toolchain.js prebuiltRuntimeObjects). Apple clang and
    #    clang 18 do not warn about identical things, and a new warning here
    #    fails every e2e test at once, which is a confusing way to learn about
    #    it. runtimeC.test.js is the test that drives that compile, so this
    #    runs the real gate rather than a restatement of it.
    #
    # 2. Building the bootstrap compiler and linking it. That is codegen, the
    #    link line, and the whole std tree in one command, and it is what the
    #    release job does three times.
    script='
      npm ci
      node --test --test-reporter=spec src/runtimeC.test.js
      node src/yoopiler.js bootstrap/src/main.yoop -o /tmp/stage1
      /tmp/stage1 bootstrap/tests/slice/hello.yoop -o /tmp/hello
      /tmp/hello
    '
    ;;
  test)
    # The test job, step for step.
    script='
      clang --version
      node --version
      npm ci
      node src/yoopiler.js --test bootstrap/src
      npm test
    '
    ;;
  release)
    # The release job, minus `gh release create`. Writes into the host tree at
    # dist/, so the tarball is inspectable afterwards - and it is a LINUX
    # tarball, so do not confuse it with one built by npm run package:boot on
    # the mac.
    script='
      npm ci
      node scripts/package_bootstrap.mjs --version 0.0.0-local
    '
    ;;
  shell)
    script='exec bash'
    ;;
esac

tty_flags=(-i)
if [ -t 0 ]; then tty_flags=(-it); fi

# On a Linux host the container's root IS host root through a bind mount, so a
# default run leaves root-owned dist/ and build/ directories in the working
# tree that the next host-side build cannot overwrite. Running as the invoking
# user avoids that. On macOS the file sharing layer remaps ownership anyway, so
# this is harmless there rather than necessary.
user_flags=(--user "$(id -u):$(id -g)")

# A named volume is created root-owned on first use, which the unprivileged
# user above then cannot write. Chown it once, as root, before the real run.
docker run --rm $platform \
  -v "$volume:/vol" \
  "$image" \
  chown "$(id -u):$(id -g)" /vol

exec docker run --rm "${tty_flags[@]}" $platform \
  "${user_flags[@]}" \
  -v "$repo:/repo" \
  -v "$volume:/repo/node_modules" \
  -w /repo \
  "${ci_env[@]}" \
  "$image" \
  bash -euo pipefail -c "$script"

# On act (https://github.com/nektos/act), which runs the workflow YAML itself.
# `lint` above uses it in listing mode only. Actually EXECUTING the job is the
# next step up:
#
#   mise use -g act@latest
#   act push -W .github/workflows/ci.yml -j test
#
# It answers a different question than the container modes do - whether the
# steps, the job graph and the conditions are wired correctly - and it answers
# it imperfectly. Its images are not the runner images, `gh` is missing from
# the default ones, and actions/upload-artifact needs --artifact-server-path to
# do anything. The release job cannot be exercised meaningfully at all: it is
# gated on refs/tags/v*, and the last step publishes to GitHub for real.
#
# Prefer `test` over `act -j test` for the question "do the suites pass on
# Linux". act would answer it too, but it pulls a multi-gigabyte image, hides
# the failure inside its own step machinery, and cannot be dropped into with
# `shell` when something goes wrong.
