# The image scripts/ci_local.sh runs the CI job inside.
#
# It stands in for the `ubuntu-latest` runner image. It is not that image and
# does not try to be: the runner ships hundreds of preinstalled tools, and the
# only ones this repo's job touches are node, clang and git. What it does match
# is the pair that decides whether the suites pass - the Ubuntu release and the
# clang major version - because those are what a macOS dev machine cannot
# reproduce and what breaks first.
#
# ubuntu:24.04 is what `ubuntu-latest` resolves to, and its clang is 18, the
# same one the runner puts on PATH. `-Wall -Wextra -Werror` on the C runtime is
# the sharpest edge between it and Apple clang.
#
# The repo is NOT copied in. ci_local.sh bind-mounts the working tree, so the
# build context here is an empty directory and the image never goes stale
# against the source.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# ca-certificates and curl are needed to fetch the NodeSource list below.
# xz-utils is what npm's tarballs and the SEA build want. git is here because
# the suites shell out to it for the version stamp.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    clang \
    curl \
    git \
    lld \
    make \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Node 24, matching the setup-node version pinned in .github/workflows/ci.yml.
# Ubuntu's own nodejs package is far older than that.
ARG NODE_MAJOR=24
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# ci_local.sh runs the container as the invoking host user so that anything
# written into the bind-mounted tree (dist/, build/) is owned by that user
# rather than by root. That user has no entry in /etc/passwd, so point HOME at
# a world-writable place; npm refuses to run with an unwritable one.
ENV HOME=/tmp/ci-home
RUN mkdir -p /tmp/ci-home && chmod 777 /tmp/ci-home

WORKDIR /repo
