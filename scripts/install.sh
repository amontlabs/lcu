#!/bin/sh
# Install LCU on Linux or macOS: find the locally installed ChatGPT app, check its Node, and run the Node
# installer (scripts/install.mjs) on it with all arguments. The app is never downloaded or installed here.
set -eu

fail() { printf 'LCU installer: %s\n' "$*" >&2; exit 1; }

self=$0
while [ -L "$self" ]; do
  link=$(readlink -- "$self")
  case $link in /*) self=$link ;; *) self=${self%/*}/$link ;; esac
done
case $self in */*) source_dir=$(cd -P -- "${self%/*}/.." && pwd -P) ;; *) source_dir=$(cd -P .. && pwd -P) ;; esac

# The app the installer will select: --existing-app (either spelling), else the platform default.
system=$(uname -s)
case $system in
  Linux) app=/usr/lib/chatgpt ;;
  Darwin) app=/Applications/ChatGPT.app ;;
  *) fail 'LCU installation currently supports Linux and macOS.' ;;
esac
take=
for arg do
  if [ -n "$take" ]; then app=$arg; take=; continue; fi
  case $arg in
    --existing-app) take=1 ;;
    --existing-app=*) app=${arg#--existing-app=} ;;
  esac
done
case $app in '~') app=$HOME ;; '~/'*) app=$HOME/${app#'~/'} ;; esac

if [ "$system" = Darwin ]; then node_dir=$app/Contents/Resources/cua_node/bin; else node_dir=$app/resources/cua_node/bin; fi
if ! node_dir=$(cd -P -- "$node_dir" 2>/dev/null && pwd -P) || [ ! -f "$node_dir/node" ] || [ ! -x "$node_dir/node" ]; then
  fail "LCU requires the official ChatGPT desktop app, which includes Codex, to be installed first. LCU does not download or install the app. No app with its Node was found at $app. Install it from https://chatgpt.com/download/ and rerun LCU. If it is installed elsewhere, pass --existing-app PATH."
fi
node=$node_dir/node

# Check the Node before running it. Linux: no account other than root or this one may replace it or a
# directory above it (the installer then checks the whole app tree). macOS: the binary carries OpenAI's
# signature (the installer then verifies the app bundle and its helper).
# (A function, so `set --` leaves the installer's arguments alone.)
trusted() {
  # shellcheck disable=SC2046
  set -- $(ls -ldn -- "$1")
  case $3 in 0|"$uid") ;; *) fail "$path is owned by uid $3; the app must be owned by root or this account." ;; esac
  case $1 in d????????t*|d????????T*|l*) ;; ????????w*) fail "$path is writable by every account." ;; esac
}
if [ "$system" = Linux ]; then
  uid=$(id -u)
  path=$node
  while :; do
    trusted "$path"
    [ "$path" = / ] && break
    path=${path%/*}
    [ -n "$path" ] || path=/
  done
else
  /usr/bin/codesign --verify --strict \
    -R='anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"' "$node" 2>/dev/null ||
    fail "$node is not signed by OpenAI; reinstall the ChatGPT app."
fi

exec "$node" "$source_dir/scripts/install.mjs" "$@"
