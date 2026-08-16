#!/usr/bin/env bash
#
# Runs what .github/workflows/ci.yml runs, in a Linux container, against the
# working tree as it is right now.
#
# The YAML wiring is the easy part of that workflow. The open question is
# whether a suite that has only ever run on macOS passes on Linux, and this is
# the cheap way to find out without a push-and-wait cycle per attempt.
#
#   scripts/ci_local.sh quick      the two things most likely to be broken,
#                                  in about a minute
#   scripts/ci_local.sh test       the whole test job
#   scripts/ci_local.sh release    the packaging job, minus the GitHub upload
#   scripts/ci_local.sh shell      a prompt in the container
#
#   --amd64                        run under the runner's actual architecture
#                                  instead of the mac's. Correct, and slow:
#                                  every process goes through qemu.
#
# The repo is mounted, not copied, so an edit on the host is visible to the
# next run with no rebuild. node_modules is shadowed by a named volume, which
# matters: esbuild installs a platform-specific binary, and letting a Linux
# `npm ci` write into the host's node_modules would break `npm run build:sea`
# on the mac until it was reinstalled.
#
# Not a replacement for the real thing. It does not exercise the workflow's
# own logic (job dependencies, the tag condition, gh release), and on Apple
# Silicon without --amd64 it is Linux on arm64, which is the same operating
# system as CI but not the same architecture. For the workflow logic itself,
# `act` runs the YAML; see the note at the bottom of this file.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dockerfile="$repo/.github/ci-local/Dockerfile"
image="yoopiler-ci-local"
volume="yoopiler-ci-node-modules"
platform=""
mode="quick"

usage() {
  sed -n '3,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    quick | test | release | shell) mode="$arg" ;;
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

if ! docker info >/dev/null 2>&1; then
  echo "the docker daemon is not running (start Docker Desktop)" >&2
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

exec docker run --rm "${tty_flags[@]}" $platform \
  -v "$repo:/repo" \
  -v "$volume:/repo/node_modules" \
  -w /repo \
  "${ci_env[@]}" \
  "$image" \
  bash -euo pipefail -c "$script"

# On act (https://github.com/nektos/act), which runs the workflow YAML itself:
#
#   brew install act
#   act push -W .github/workflows/ci.yml -j test
#
# It answers a different question than this script does - whether the steps,
# the job graph and the conditions are wired correctly - and it answers it
# imperfectly. Its images are not the runner images, `gh` is missing from the
# default ones, and actions/upload-artifact needs --artifact-server-path to do
# anything. The release job cannot be exercised meaningfully at all: it is
# gated on refs/tags/v*, and the last step publishes to GitHub for real.
