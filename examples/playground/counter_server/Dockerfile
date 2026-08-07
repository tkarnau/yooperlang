# counter_server - build the yoop compiler's output, ship only the binary.
#
# Build from the REPO ROOT, not from this directory - the compiler needs
# src/, std/ and runtime/ in its context:
#
#     docker build -f examples/playground/counter_server/Dockerfile -t counter_server .
#
# ---- stage 1: compile -------------------------------------------------------
#
# The yoop compiler is JS that shells out to clang, so the builder needs
# both. Nothing from this stage reaches the final image.
FROM node:22-bookworm-slim AS build

# clang-19, NOT the unversioned `clang` package. Bookworm's default is
# clang 14, which predates LLVM opaque pointers - codegen emits `ptr` and
# 14 rejects it outright ("expected type" on the first variant typedef).
# LLVM 15 is the floor; 19 is what bookworm has that is newest.
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang-19 \
 && rm -rf /var/lib/apt/lists/*

# resolveClang() in src/yoopiler.js checks YOOP_CLANG before PATH, which is
# how a versioned binary name gets used without a symlink.
ENV YOOP_CLANG=/usr/bin/clang-19

WORKDIR /src

# The compiler itself has zero runtime dependencies, so there is no
# `npm install` step here. src/ is the compiler, std/ is the yoop stdlib it
# reads off disk, runtime/ is the C it hands to clang - install_root.js
# resolves all three module-relative, which this layout preserves.
COPY package.json ./
COPY src/ ./src/
COPY std/ ./std/
COPY runtime/ ./runtime/
COPY examples/playground/counter_server/main.yoop ./app/main.yoop

RUN mkdir -p /out && node ./src/yoopiler.js ./app/main.yoop -o /out/counter_server

# ---- stage 2a: full runtime (docker build --target full) --------------------
#
# The binary on bookworm-slim, plus curl so HEALTHCHECK works and a shell so
# `docker exec` is useful. About 4x the transfer size of `slim` below, which
# is what you feel when you deploy by piping `docker save` over ssh
# (32MB vs 8MB).
#
# NOTE this stage is FIRST on purpose: `docker build` with no `--target`
# uses the LAST stage, and slim is the better default.
FROM debian:bookworm-slim AS full

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home counter

COPY --from=build /out/counter_server /usr/local/bin/counter_server

USER counter
EXPOSE 8080

# argv is `<port> [workers]`. Workers defaults to the CPU count the process
# can see, which inside a container is the HOST's - `--cpus=2` on a 16-core
# box still reports 16 and would spawn 16 workers. Pass the count explicitly
# whenever you also set a CPU limit; see docker-compose.yml.
ENTRYPOINT ["/usr/local/bin/counter_server"]
CMD ["8080"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

# ---- stage 2b: slim runtime (the default) -----------------------------------
#
# distroless/base is glibc and nothing else - no shell, no package manager,
# no curl. The compiled binary is about 650KB and links ONLY libc (glibc
# 2.34+ folded libpthread and libm into it), so that really is all it needs.
# 8.4MB image, 8.1MB over the wire.
#
# Alpine is not an option for the mirror-image reason: musl would require a
# static build, which glibc does not do cleanly.
#
# The tradeoff is HEALTHCHECK - with no shell and no curl there is nothing to
# run one with, so health has to be checked from outside (a `curl /healthz`
# from your monitoring, or `--target full` if you want the container to
# report its own).
FROM gcr.io/distroless/base-debian12 AS slim

COPY --from=build /out/counter_server /usr/local/bin/counter_server

# distroless ships a `nonroot` user (uid 65532); no useradd needed (or
# possible - there is no shell to run it).
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/counter_server"]
CMD ["8080"]
