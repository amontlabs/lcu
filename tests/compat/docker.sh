#!/bin/sh
# Run the lcu/compat differential tests on Linux (glibc) inside a disposable Docker container, as root.
#
#   tests/compat/docker.sh [unittest arguments...]   (default: the pyerr/shlex/pathlib/lock/accounts/acl/execve tests)
#
# LCU_COMPAT_NODE_MAJOR=22|24 (default 24) selects the Node the modules run on. Node 24 is the image's own;
# Node 22 is copied, without network access, from an already present node:22-bookworm-slim image into
# lcu-compat-node22:<arch> (/opt/node22/bin/node).
#
# lcu-compat:<arch> is built (once) from the repository's verification image when it exists, else from
# node:24-bookworm-slim, adding the `acl` package (getfacl/setfacl), python3 and util-linux (flock); that
# first build needs the package mirror. Test runs use --network none, a noexec tmpfs at /lcu-noexec
# (execve noexec-mount cases), and mount the repository read-only; nothing in the working tree changes.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)

command -v docker >/dev/null 2>&1 || { echo "docker is not installed" >&2; exit 2; }

case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  *) arch=amd64 ;;
esac

image=${LCU_COMPAT_IMAGE:-lcu-compat:$arch}
if ! docker image inspect "$image" >/dev/null 2>&1; then
  if docker image inspect "lcu-verification:$arch" >/dev/null 2>&1; then
    base="lcu-verification:$arch"
  else
    base=node:24-bookworm-slim
  fi
  echo "building $image from $base" >&2
  docker build -q -t "$image" - >/dev/null <<EOF
FROM $base
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    acl python3 util-linux passwd procps && rm -rf /var/lib/apt/lists/*
EOF
fi

node_env=
case "${LCU_COMPAT_NODE_MAJOR:-24}" in
  24) node_env="-e LCU_COMPAT_NODE_VERSION=v24." ;;
  22)
    base_image=$image
    image="lcu-compat-node22:$arch"
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      docker image inspect node:22-bookworm-slim >/dev/null 2>&1 || {
        echo "node:22-bookworm-slim is not present (docker pull it first)" >&2; exit 2; }
      echo "building $image from $base_image + node:22-bookworm-slim" >&2
      docker build -q --network none -t "$image" - >/dev/null <<EOF
FROM node:22-bookworm-slim AS node22
FROM $base_image
COPY --from=node22 /usr/local/bin/node /opt/node22/bin/node
EOF
    fi
    node_env="-e LCU_COMPAT_NODE=/opt/node22/bin/node -e LCU_TEST_NODE=/opt/node22/bin/node -e LCU_COMPAT_NODE_VERSION=v22."
    ;;
  *) echo "LCU_COMPAT_NODE_MAJOR must be 22 or 24" >&2; exit 2 ;;
esac

# With no arguments: the default Python differential tests, then the Linux-only node tests (real /proc dispositions of
# the ignored-signal children, the root-only privilege-dropping helper, the inflate fallback, the error hierarchy).
node_tests=
if [ "$#" -eq 0 ]; then
  set -- -v test_pyerr test_shlex test_pathlib test_lock test_accounts test_acl test_execve test_inflate_fallback test_pynum test_plist_decl
  node_tests=1
fi

command='python3 -B -m unittest "$@"'
if [ -n "$node_tests" ]; then
  command="$command && \"\${LCU_COMPAT_NODE:-node}\" --test --test-timeout=120000 --test-force-exit /work/tests/node/signals.test.mjs /work/tests/node/inflate.test.mjs /work/tests/node/compat_errors.test.mjs /work/tests/node/compat_round2.test.mjs"
fi

# The frozen Python oracle (the commit in tests/blackbox/BASE): the differential tests import the Python implementation
# of what the Node modules replaced from here, since the worktree no longer contains lcu/*.py.
oracle=$(python3 "$root/tests/blackbox/oracle.py")

# shellcheck disable=SC2086
exec docker run --rm --network none -v "$root:/work:ro" -v "$oracle:/oracle:ro" -e LCU_ORACLE_ROOT=/oracle -w /work/tests/compat \
  --tmpfs /lcu-noexec:rw,noexec,mode=1777 \
  -e PYTHONDONTWRITEBYTECODE=1 -e LCU_COMPAT_IN_DOCKER=1 $node_env \
  "$image" sh -c "$command" sh "$@"
