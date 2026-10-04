#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
python=
for name in python3.14 python3.13 python3.12 python3; do
  candidate=$(command -v "$name" || true)
  if [[ -n "$candidate" ]] && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 12))' 2>/dev/null; then
    python=$candidate
    break
  fi
done
if [[ -z "$python" ]]; then
  found=$(command -v python3 || true)
  echo "LCU installation requires Python 3.12 or newer on PATH (found: ${found:-no python3})." >&2
  exit 1
fi
case "$(uname -s)" in
  Darwin) exec "$python" -B "$source_dir/scripts/install_macos.py" "$@" ;;
  Linux) exec "$python" -B "$source_dir/scripts/install.py" "$@" ;;
  *) echo "LCU installation currently supports Linux and macOS." >&2; exit 1 ;;
esac
