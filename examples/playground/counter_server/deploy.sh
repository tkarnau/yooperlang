#!/bin/sh
# Build counter_server for a cloud box and ship it there over ssh.
#
#   ./deploy.sh root@1.2.3.4                  # x86 host (Hetzner CX/CPX), 2 workers
#   ./deploy.sh root@1.2.3.4 arm64 4          # ARM host (Hetzner CAX), 4 workers
#   ./deploy.sh root@1.2.3.4 amd64 2 80       # ...and publish on port 80
#
# Run from anywhere; it resolves the repo root itself.
#
# No registry involved: the image goes over the ssh pipe with
# `docker save | docker load`. That is 8.1MB with the default slim target
# (31.6MB with `--target full`), so it is quick enough to do repeatedly.
# Move to a registry when you want rollbacks or more than one target box.

set -eu

HOST="${1:?usage: deploy.sh user@host [amd64|arm64] [workers] [published-port]}"
ARCH="${2:-amd64}"
WORKERS="${3:-2}"
PUBPORT="${4:-8080}"

NAME=counter_server
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
DOCKERFILE=examples/playground/counter_server/Dockerfile

case "$ARCH" in
    amd64|arm64) ;;
    *) echo "arch must be amd64 or arm64, got '$ARCH'" >&2; exit 1 ;;
esac

echo "==> building $NAME for linux/$ARCH"
# --platform is the whole ballgame when your laptop is Apple Silicon and the
# server is not. Without it you build an arm64 image, `docker load` accepts
# it happily on an x86 host, and the container dies on `exec format error`.
# Docker Desktop runs the x86 build under Rosetta, so this costs seconds.
docker build \
    --platform "linux/$ARCH" \
    -f "$REPO_ROOT/$DOCKERFILE" \
    -t "$NAME:$ARCH" \
    "$REPO_ROOT"

echo "==> shipping to $HOST"
# No gzip: `docker save` already emits per-layer-compressed content, so
# piping it through gzip measured 8.1MB -> 7.9MB. Not worth the moving part.
docker save "$NAME:$ARCH" | ssh "$HOST" 'docker load'

echo "==> (re)starting the container"
# Workers is passed explicitly because cpuCount() inside a container reports
# the HOST's core count, not the cgroup share - the default would spawn one
# worker per host core to contend over a 2-core quota.
ssh "$HOST" "
    set -eu
    docker rm -f $NAME >/dev/null 2>&1 || true
    docker run -d \
        --name $NAME \
        --restart unless-stopped \
        -p ${PUBPORT}:8080 \
        --cpus=${WORKERS} \
        --memory=256m \
        --ulimit nofile=65535:65535 \
        $NAME:$ARCH 8080 $WORKERS
"

echo "==> waiting for it to answer"
i=0
until curl -fsS -m 3 "http://${HOST#*@}:${PUBPORT}/healthz" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 15 ]; then
        echo "no response after 15 tries. check:" >&2
        echo "  ssh $HOST 'docker logs $NAME'" >&2
        echo "  and that port $PUBPORT is open in the Hetzner Cloud Firewall" >&2
        exit 1
    fi
    sleep 1
done

echo "==> up"
curl -fsS "http://${HOST#*@}:${PUBPORT}/stats"
echo
echo "stress it:  ./stress.sh http://${HOST#*@}:${PUBPORT} 60 200"
