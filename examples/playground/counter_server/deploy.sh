#!/bin/sh
# Build counter_server for a cloud box and ship it there over ssh.
#
#   ./deploy.sh root@1.2.3.4                     # x86 (Hetzner CX/CPX), 2 workers
#   ./deploy.sh root@1.2.3.4 arm64 4             # ARM (Hetzner CAX), 4 workers
#   ./deploy.sh root@1.2.3.4 amd64 2 80          # ...and publish on port 80
#
#   # AWS EC2: t4g/m6g/c7g are Graviton, so arm64. Key + non-root user:
#   SSH_OPTS="-i ~/.ssh/mykey.pem" DOCKER_SUDO=sudo \
#       ./deploy.sh ec2-user@1.2.3.4 arm64 2 80
#
# Environment overrides:
#   SSH_OPTS     extra ssh flags, e.g. "-i key.pem" or "-p 2222"
#   DOCKER_SUDO  set to "sudo" when the remote user is not in the docker group
#   PUBLIC_HOST  address to poll after deploying, when the ssh target is an
#                ssh-config alias rather than a reachable hostname
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

SSH_OPTS="${SSH_OPTS:-}"
DOCKER_SUDO="${DOCKER_SUDO:-}"
PUBLIC_HOST="${PUBLIC_HOST:-${HOST#*@}}"

NAME=counter_server
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
DOCKERFILE=examples/playground/counter_server/Dockerfile

case "$ARCH" in
    amd64|arm64) ;;
    *) echo "arch must be amd64 or arm64, got '$ARCH'" >&2; exit 1 ;;
esac

# shellcheck disable=SC2086
remote() { ssh $SSH_OPTS "$HOST" "$@"; }

echo "==> checking ssh and docker on $HOST"
if ! remote "${DOCKER_SUDO} docker version >/dev/null 2>&1"; then
    echo "cannot run docker on $HOST." >&2
    echo "  install it:  ssh $SSH_OPTS $HOST 'curl -fsSL https://get.docker.com | sudo sh'" >&2
    echo "  then either add yourself to the docker group and RECONNECT" >&2
    echo "  (group membership does not apply to the session that ran usermod):" >&2
    echo "      sudo usermod -aG docker \$USER" >&2
    echo "  or re-run this with DOCKER_SUDO=sudo" >&2
    exit 1
fi

echo "==> building $NAME for linux/$ARCH"
# --platform is the whole ballgame when your laptop and your server disagree.
# Without it an Apple Silicon Mac builds an arm64 image, `docker load` accepts
# it happily on an x86 host, and the container dies on `exec format error`.
# (AWS Graviton - t4g/m6g/c7g - is arm64, so there it matches natively.)
docker build \
    --platform "linux/$ARCH" \
    -f "$REPO_ROOT/$DOCKERFILE" \
    -t "$NAME:$ARCH" \
    "$REPO_ROOT"

echo "==> shipping to $HOST"
# No gzip: `docker save` already emits per-layer-compressed content, so
# piping it through gzip measured 8.1MB -> 7.9MB. Not worth the moving part.
# shellcheck disable=SC2086
docker save "$NAME:$ARCH" | ssh $SSH_OPTS "$HOST" "${DOCKER_SUDO} docker load"

echo "==> (re)starting the container"
# Workers is passed explicitly because cpuCount() inside a container reports
# the HOST's core count, not the cgroup share - the default would spawn one
# worker per host core to contend over a smaller quota.
remote "
    set -eu
    ${DOCKER_SUDO} docker rm -f $NAME >/dev/null 2>&1 || true
    ${DOCKER_SUDO} docker run -d \
        --name $NAME \
        --restart unless-stopped \
        -p ${PUBPORT}:8080 \
        --cpus=${WORKERS} \
        --memory=256m \
        --ulimit nofile=65535:65535 \
        $NAME:$ARCH 8080 $WORKERS
"

echo "==> waiting for it to answer on ${PUBLIC_HOST}:${PUBPORT}"
i=0
until curl -fsS -m 3 "http://${PUBLIC_HOST}:${PUBPORT}/healthz" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 15 ]; then
        echo "no response after 15 tries. check:" >&2
        echo "  ssh $SSH_OPTS $HOST '${DOCKER_SUDO} docker logs $NAME'" >&2
        echo "  and that inbound port $PUBPORT is allowed:" >&2
        echo "    AWS      - the instance's security group" >&2
        echo "    Hetzner  - Cloud Firewall (and ufw, if you enabled it)" >&2
        exit 1
    fi
    sleep 1
done

echo "==> up"
curl -fsS "http://${PUBLIC_HOST}:${PUBPORT}/stats"
echo
echo "stress it:  ./stress.sh http://${PUBLIC_HOST}:${PUBPORT} 60 200"
