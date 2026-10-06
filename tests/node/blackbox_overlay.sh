#!/bin/sh
# Build an implementation tree (a copy of this worktree) whose bin/lcu, bin/lcu-session and bin/lcu-codex-sandbox
# have the pre-Node gate disabled, for `python3 tests/blackbox/run.py --b <tree>` on the macOS host.
#
#   tests/node/blackbox_overlay.sh DEST [--keep-gate]
#
# TEST-ONLY: by default __lcu_gate is redefined after the LCU COMMON block to resolve the path and require a regular
# executable file (no signature or ownership checks),
# because the black-box fake apps' `cua_node/bin/node` is an unsigned shell wrapper that the macOS codesign gate
# rightly refuses. The production launchers in bin/ are never modified. Use --keep-gate on Linux (Docker),
# where the fixtures satisfy the ownership gate.
set -eu
dest=${1:?usage: blackbox_overlay.sh DEST [--keep-gate]}
keep=${2:-}
here=$(cd "$(dirname "$0")/../.." && pwd -P)
rm -rf "$dest"
mkdir -p "$dest"
(cd "$here" && tar -cf - --exclude ./.git --exclude ./.claude --exclude ./node_modules --exclude ./adapters/node_modules \
  --exclude '*/__pycache__' .) | (cd "$dest" && tar -xf -)
# scripts/install.sh carries the same LCU COMMON block (its bootstrap gates the app's Node too).
for name in bin/lcu bin/lcu-session bin/lcu-codex-sandbox scripts/install.sh; do
  if [ "$keep" = --keep-gate ]; then
    cp "$here/$name" "$dest/$name"
  else
    # Only the signature/ownership checks are dropped: the regular+executable-file check (and its reason) stays,
    # so an unusable Node gives the production diagnostic, not the shell's own exec error.
    awk '{ print }
         /^# END LCU COMMON$/ {
           print "__lcu_gate() { # blackbox overlay: signature and ownership checks disabled (test-only)"
           print "  __lcu_walk \"$1\" 0 || return 1"
           print "  if [ ! -f \"$__LCU_REAL\" ] || [ ! -x \"$__LCU_REAL\" ]; then"
           print "    __LCU_REASON=\"$__LCU_REAL is not an executable file\""
           print "    return 1"
           print "  fi"
           print "}"
         }' \
      "$here/$name" > "$dest/$name"
  fi
  chmod 755 "$dest/$name"
done
echo "$dest"
