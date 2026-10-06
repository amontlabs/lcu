#!/bin/sh
# Run the lcu/compat differential tests on Linux (glibc) inside a disposable Docker container, as root.
#
#   tests/compat/docker.sh [unittest arguments...]   (default: the pyerr/shlex/pathlib/lock/accounts/acl/execve tests)
#
# LCU_COMPAT_NODE_MAJOR=22|24 (default 24) selects the Node the modules run on. Node 24 is the image's own;
# Node 22 is copied, without network access, from an already present node:22-bookworm-slim image into
# lcu-blackbox-node22:<arch> (/opt/node22/bin/node).
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

# The image is the black-box image (tests/blackbox/Dockerfile): the verification image plus the project's reference
# interpreter CPython 3.12.10 at /opt/cpython-3.12.10 (checksum-verified source build). Ubuntu's own python3 is 3.12.3,
# whose tarfile/argparse/shutil texts differ, so every Python differential here runs on 3.12.10. /usr/bin/python3 stays
# (the Linux ACL-reader tests use it on purpose). Building it needs the network ONCE; test runs are --network none.
image=${LCU_COMPAT_IMAGE:-lcu-blackbox:$arch}
if ! docker image inspect "$image" >/dev/null 2>&1; then
  if docker image inspect "lcu-verification:$arch" >/dev/null 2>&1; then
    base="lcu-verification:$arch"
  else
    base="lcu-compat:$arch"
    docker image inspect "$base" >/dev/null 2>&1 || {
      echo "build lcu-verification:$arch (tests/Dockerfile) or lcu-compat:$arch first" >&2; exit 2; }
  fi
  echo "building $image from $base + CPython 3.12.10 (network needed once)" >&2
  docker build -q --build-arg "BASE=$base" -t "$image" -f "$root/tests/blackbox/Dockerfile" "$root" >/dev/null
fi

node_env=
case "${LCU_COMPAT_NODE_MAJOR:-24}" in
  24) node_env="-e LCU_COMPAT_NODE_VERSION=v24." ;;
  22)
    base_image=$image
    image="lcu-blackbox-node22:$arch"
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

# With no arguments: EVERY tests/compat differential (discovery) on CPython 3.12.10, then the Linux-only node tests (real
# /proc dispositions of the ignored-signal children, the root-only privilege-dropping helper, the inflate fallback, the
# error hierarchy, the subprocess seam and round-2 regressions).
node_tests=
if [ "$#" -eq 0 ]; then
  set -- discover -v -s . -p 'test_*.py'
  node_tests=1
fi

command='export PATH=/opt/cpython-3.12.10/bin:$PATH LCU_TEST_PYTHON=/opt/cpython-3.12.10/bin/python3.12; python3 -B -m unittest "$@"'
if [ -n "$node_tests" ]; then
  command="$command && \"\${LCU_COMPAT_NODE:-node}\" --test --test-timeout=120000 --test-force-exit /work/tests/node/signals.test.mjs /work/tests/node/inflate.test.mjs /work/tests/node/compat_errors.test.mjs /work/tests/node/compat_round2.test.mjs /work/tests/node/subprocess_seam.test.mjs"
fi

# The frozen Python oracle (the commit in tests/blackbox/BASE): the differential tests import the Python implementation
# of what the Node modules replaced from here, since the worktree no longer contains lcu/*.py.
oracle=$(python3 "$root/tests/blackbox/oracle.py")

# shellcheck disable=SC2086
exec docker run --rm --network none -v "$root:/work:ro" -v "$oracle:/oracle:ro" -e LCU_ORACLE_ROOT=/oracle -w /work/tests/compat \
  --tmpfs /lcu-noexec:rw,noexec,mode=1777 \
  -e PYTHONDONTWRITEBYTECODE=1 -e LCU_COMPAT_IN_DOCKER=1 $node_env \
  "$image" sh -c "$command" sh "$@"
