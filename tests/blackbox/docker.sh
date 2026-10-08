#!/usr/bin/env bash
# Run the black-box harness inside a disposable container: tests/Dockerfile's Ubuntu 24.04 image (Node 24) plus the
# reference CPython 3.12.10 (tests/blackbox/Dockerfile; it compiles the official python.org tarball, checksum
# verified, at image-build time only). The harness, and through it the oracle, run on /opt/cpython-3.12.10. No
# network, repository mounted read-only, unprivileged `ubuntu` user whose home is wiped per scenario (scenarios
# that write the account home only run here). Extra arguments go to run.py.
#
#   tests/blackbox/docker.sh                    # oracle vs this worktree
#   tests/blackbox/docker.sh -k setup --keep
#   tests/blackbox/docker.sh --a /oracle --b /oracle   # self-comparison: determinism
#   LCU_BB_PLATFORM=linux/amd64 tests/blackbox/docker.sh
set -euo pipefail
# --root (first argument): run as root; only `needs_root` scenarios run then (the `ubuntu` account still exists).
user=1000:1000
if [[ ${1:-} == --root ]]; then user=0:0; shift; fi
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
case "$(uname -m)" in arm64|aarch64) native=linux/arm64 ;; *) native=linux/amd64 ;; esac
platform=${LCU_BB_PLATFORM:-$native}
case "$platform" in linux/arm64|linux/amd64) ;; *) echo 'Expected linux/arm64 or linux/amd64' >&2; exit 2 ;; esac
base="lcu-verification:${platform#linux/}"
tag="lcu-blackbox:${platform#linux/}"
python=/opt/cpython-3.12.10/bin/python3.12
if ! docker image inspect "$base" >/dev/null 2>&1; then
  docker build --platform "$platform" -t "$base" -f "$repo/tests/Dockerfile" "$repo"
fi
# A missing or stale (not CPython 3.12.10) image is rebuilt: the oracle must not run on Ubuntu's 3.12.3.
if [[ $(docker image inspect --format '{{ index .Config.Labels "lcu.blackbox.python" }}' "$tag" 2>/dev/null || true) != 3.12.10 ]]; then
  docker build --platform "$platform" --build-arg "BASE=$base" -t "$tag" -f "$repo/tests/blackbox/Dockerfile" "$repo"
fi
oracle=$(python3 "$repo/tests/blackbox/oracle.py")
# Archive node_modules: populate the npm cache on the host (the only step that may use the network), for the
# oracle's and this worktree's lockfiles, then mount it read-only; the container never reaches the network.
npm_cache=${LCU_BB_NPM_CACHE:-${TMPDIR:-/tmp}/lcu-bb-npm}
LCU_BB_NPM_CACHE="$npm_cache" python3 "$repo/tests/blackbox/npmcache.py" "$oracle" >/dev/null
LCU_BB_NPM_CACHE="$npm_cache" python3 "$repo/tests/blackbox/npmcache.py" "$repo" >/dev/null
mkdir -p "$repo/tests/blackbox/golden" "$repo/.port/coverage-data"
# LCU_BB_A_CACHE: a host directory of cached oracle snapshots (run.py --a-cache), world-writable because the container
# user is not the host user. CI keys it on the oracle, harness and image hashes.
cache_args=()
if [[ -n ${LCU_BB_A_CACHE:-} ]]; then
  mkdir -p "$LCU_BB_A_CACHE" && chmod 0777 "$LCU_BB_A_CACHE"
  cache_args=(-v "$(cd -- "$LCU_BB_A_CACHE" && pwd):/acache")
  set -- --a-cache /acache "$@"
fi
exec docker run --rm --network none --platform "$platform" --user "$user" \
  -v "$repo:/src:ro" -v "$oracle:/oracle:ro" -v "$repo/tests/blackbox/golden:/src/tests/blackbox/golden" \
  -v "$repo/.port:/src/.port" -v "$npm_cache:/npmcache:ro" -e LCU_BB_NPM_CACHE=/npmcache "${cache_args[@]}" \
  -e LCU_BB_DISPOSABLE=1 -e PYTHONDONTWRITEBYTECODE=1 -e HOME="$([[ $user == 0:0 ]] && echo /root || echo /home/ubuntu)" \
  "$tag" "$python" /src/tests/blackbox/run.py --a /oracle --b /src "$@"
