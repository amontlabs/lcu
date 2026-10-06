#!/bin/sh -p
# LCU installer bootstrap (POSIX sh). Runs the Node installer with the ChatGPT app's own bundled Node:
#   1. find the app (--existing-app with argparse's rules for that one option, expanded like Path.expanduser by
#      __lcu_python_path; else the platform default);
#   2. gate the Node binary BEFORE executing it (__lcu_gate: Linux ownership/mode of every traversed entry, root
#      accepts only root-owned paths; macOS OpenAI signatures of the binary and of its com.openai.codex bundle);
#   3. move Node's startup inputs aside (__lcu_quarantine; restored by scripts/startup_env.mjs), report ignored
#      signals and non-UTF-8 bytes;
#   4. exec <checked node> --disable-warning=ExperimentalWarning <archive>/scripts/install(.mjs|_macos.mjs) "$@".
# --help/-h and unsupported platforms are answered here when Node cannot run. The static help between the
# LCU_STATIC_HELP markers and the LCU COMMON block (lcu/shim/common.sh verbatim) are generated:
#   LCU_UPDATE_INSTALL_SH=1 node --test tests/node/install_sh.test.mjs
# (the test fails when either drifts; tests/node/entry.test.mjs checks the COMMON block too).
# `-p`: bash ignores SHELLOPTS/BASHOPTS/CDPATH/ENV/BASH_ENV/functions; every shell variable is __LCU_* (the
# reserved channel lcu/startup_vars.mjs consumes), so no caller variable is modified; PATH is never consulted.
# Shipped as scripts/install.sh.
set -eu
set -f

__lcu_install_help() {
  case $__LCU_OS in
    Linux) cat <<'LCU_STATIC_HELP_LINUX'
usage: install.py [-h] [--prefix PREFIX] [--user USER] [--agent AGENT]
                  [--scope {user,project}] [--project PROJECT] [--yes]
                  [--list-agents] [--export EXPORT] [--chrome] [--no-chrome]
                  [--audio] [--no-audio] [--approval {ask,auto}]
                  [--session {discover,direct}] [--allow-missing]
                  [--reconcile] [--check-desktop] [--runtime-only]
                  [--skip-system] [--app-package APP_PACKAGE]
                  [--existing-app EXISTING_APP] [--offline]

Install a versioned LCU runtime and optionally register agents. Requires
Linux, X11 and D-Bus; apt system provisioning requires root.

options:
  -h, --help            show this help message and exit
  --prefix PREFIX       Runtime prefix (Linux: /opt/lcu; macOS:
                        ~/.local/share/lcu; Windows: %LOCALAPPDATA%\LCU)
  --user USER           Target account; root must select one explicitly
  --agent AGENT         Agent ID; repeat for several, all for every supported
                        client, or auto for detected clients. Use --list-
                        agents.
  --scope {user,project}
  --project PROJECT     Absolute existing project directory for project scope
  --yes                 Apply explicit choices without a confirmation prompt
  --list-agents         List supported adapters and exit
  --export EXPORT       Export a portable tools plugin for custom clients to a
                        new directory
  --chrome              Opt into original Chrome control, extension connector,
                        and browser guidance
  --no-chrome           Disable Chrome control, overriding a saved opt-in
  --audio               Opt into the original optional computer-audio
                        recording API
  --no-audio            Disable computer-audio recording, overriding a saved
                        opt-in
  --approval {ask,auto}
                        optional, for unattended machines: auto adds only
                        LCU's own harness approval entries so its tools run
                        without a per-call prompt (per-app approval stays);
                        ask removes exactly those entries and leaves harness
                        defaults (the default, kept from the previous setup)
  --session {discover,direct}
                        discover attaches through lcu-session (XFCE); direct
                        uses the current desktop account
  --allow-missing       Skip pi, omp and hermes when their executable is not
                        installed yet and record them as pending (Codex and
                        Claude Code still register); exit 0 when that is the
                        only problem. `lcu setup --reconcile` registers them
                        once they appear
  --reconcile           Register pending harnesses that are now installed,
                        using the saved opt-ins and approval mode; non-
                        interactive, idempotent, and silent when there is
                        nothing to do
  --check-desktop       Require live desktop readiness after setup; never
                        opens System Settings automatically
  --runtime-only        Install without registering an agent
  --skip-system         Skip apt; system libraries must already exist
  --app-package APP_PACKAGE
                        Removed: install the app yourself; this option now
                        fails
  --existing-app EXISTING_APP
                        Use an already installed app outside the default
                        /usr/lib/chatgpt location
  --offline             Never use the network; requires --skip-system and
                        preinstalled system libraries

Run on the machine hosting the agent backend. For Codex SSH remote projects,
that is the VM. This command never installs or authenticates the agent itself.
LCU_STATIC_HELP_LINUX
    ;;
    Darwin) cat <<'LCU_STATIC_HELP_DARWIN'
usage: install_macos.py [-h] [--prefix PREFIX] [--user USER] [--agent AGENT]
                        [--scope {user,project}] [--project PROJECT] [--yes]
                        [--list-agents] [--export EXPORT] [--chrome]
                        [--no-chrome] [--audio] [--no-audio]
                        [--approval {ask,auto}] [--session {discover,direct}]
                        [--allow-missing] [--reconcile] [--check-desktop]
                        [--existing-app EXISTING_APP] [--runtime-only]
                        [--offline] [--skip-system]

Select an existing signed macOS app and install LCU's thin adapters.

options:
  -h, --help            show this help message and exit
  --prefix PREFIX       Runtime prefix (Linux: /opt/lcu; macOS:
                        ~/.local/share/lcu; Windows: %LOCALAPPDATA%\LCU)
  --user USER           Target account; root must select one explicitly
  --agent AGENT         Agent ID; repeat for several, all for every supported
                        client, or auto for detected clients. Use --list-
                        agents.
  --scope {user,project}
  --project PROJECT     Absolute existing project directory for project scope
  --yes                 Apply explicit choices without a confirmation prompt
  --list-agents         List supported adapters and exit
  --export EXPORT       Export a portable tools plugin for custom clients to a
                        new directory
  --chrome              Opt into original Chrome control, extension connector,
                        and browser guidance
  --no-chrome           Disable Chrome control, overriding a saved opt-in
  --audio               Opt into the original optional computer-audio
                        recording API
  --no-audio            Disable computer-audio recording, overriding a saved
                        opt-in
  --approval {ask,auto}
                        optional, for unattended machines: auto adds only
                        LCU's own harness approval entries so its tools run
                        without a per-call prompt (per-app approval stays);
                        ask removes exactly those entries and leaves harness
                        defaults (the default, kept from the previous setup)
  --session {discover,direct}
                        discover attaches through lcu-session (XFCE); direct
                        uses the current desktop account
  --allow-missing       Skip pi, omp and hermes when their executable is not
                        installed yet and record them as pending (Codex and
                        Claude Code still register); exit 0 when that is the
                        only problem. `lcu setup --reconcile` registers them
                        once they appear
  --reconcile           Register pending harnesses that are now installed,
                        using the saved opt-ins and approval mode; non-
                        interactive, idempotent, and silent when there is
                        nothing to do
  --check-desktop       Require live desktop readiness after setup; never
                        opens System Settings automatically
  --existing-app EXISTING_APP
                        Existing signed ChatGPT.app; reused in place without
                        modification
  --runtime-only
  --offline             Accepted for consistency; macOS setup always uses
                        local files
  --skip-system         Accepted for consistency; no system packages are
                        installed

Run on the machine hosting the agent backend. For Codex SSH remote projects,
that is the VM. This command never installs or authenticates the agent itself.
LCU_STATIC_HELP_DARWIN
    ;;
  esac
}

# BEGIN LCU COMMON (lcu/shim/common.sh, inlined verbatim; tests/node/entry.test.mjs checks every copy)
# Shared pre-Node launch code of bin/lcu, bin/lcu-session, bin/lcu-codex-sandbox and scripts/install.sh:
# function definitions only. Every shell variable is named __LCU_*: that prefix is LCU's reserved launch
# channel (lcu/startup_vars.mjs removes all of it before any child starts), so a caller's ordinary exported
# variable is never overwritten. System tools run by absolute path; the caller's PATH is never consulted.

# __lcu_tool VAR CANDIDATE...: the first executable candidate, else __LCU_REASON and status 1.
__lcu_tool() {
  __LCU_TV=$1
  shift
  for __LCU_TC in "$@"; do
    if [ -x "$__LCU_TC" ]; then
      eval "$__LCU_TV=\$__LCU_TC"
      return 0
    fi
  done
  __LCU_REASON="the system tool ${__LCU_TV#__LCU_T_} is missing"
  return 1
}

__lcu_tools() {
  __lcu_tool __LCU_T_UNAME /usr/bin/uname /bin/uname || return 1
  __lcu_tool __LCU_T_READLINK /usr/bin/readlink /bin/readlink || return 1
  __lcu_tool __LCU_T_ID /usr/bin/id /bin/id || return 1
  __lcu_tool __LCU_T_LS /bin/ls /usr/bin/ls || return 1
  __LCU_OS=$("$__LCU_T_UNAME" -s) || { __LCU_REASON='uname failed'; return 1; }
  __LCU_UID=$("$__LCU_T_ID" -u) || { __LCU_REASON='id failed'; return 1; }
  return 0
}

# __lcu_readlink PATH: the link's target into __LCU_TARGET, byte for byte. Command substitution would strip
# trailing newlines, which are legal in file names: `readlink -n` prints no terminator of its own (GNU, BSD and
# busybox alike; plain BSD readlink also drops a target's own final LF) and a sentinel keeps every byte.
__lcu_readlink() {
  __LCU_TARGET=$("$__LCU_T_READLINK" -n "$1" && printf x) || { __LCU_REASON="$1 cannot be read"; return 1; }
  __LCU_TARGET=${__LCU_TARGET%x}
  return 0
}

# __lcu_self_root: the launcher's own symlink-resolved directory's parent (Python: Path(__file__).resolve()
# .parent.parent) into __LCU_ROOT. No `readlink -f`; `cd` only to ./- or /-prefixed paths so CDPATH never applies.
__lcu_self_root() {
  __LCU_SELF=$0
  case $__LCU_SELF in */*) ;; *) __LCU_SELF=./$__LCU_SELF ;; esac
  __LCU_N=0
  while [ -L "$__LCU_SELF" ]; do
    __LCU_N=$((__LCU_N + 1))
    if [ "$__LCU_N" -gt 40 ]; then
      __LCU_REASON="$0 has too many levels of symbolic links"
      return 1
    fi
    __lcu_readlink "$__LCU_SELF" || return 1
    case $__LCU_TARGET in
      /*) __LCU_SELF=$__LCU_TARGET ;;
      *) __LCU_SELF=${__LCU_SELF%/*}/$__LCU_TARGET ;;
    esac
  done
  __LCU_DIR=${__LCU_SELF%/*}
  case $__LCU_DIR in /*|./*|../*) ;; *) __LCU_DIR=./$__LCU_DIR ;; esac
  __LCU_DIR=$(cd -P -- "$__LCU_DIR" >/dev/null 2>&1 && pwd -P && printf x) || { __LCU_REASON="$0 cannot be located"; return 1; }
  __LCU_DIR=${__LCU_DIR%x}
  __LCU_DIR=${__LCU_DIR%?}
  __LCU_ROOT=${__LCU_DIR%/*}
  return 0
}

# __lcu_untrusted PATH: status 0 and __LCU_REASON when someone other than root or this uid could replace the
# entry (not dereferenced). A link's own mode is meaningless; only its owner counts. A sticky directory only lets
# others add entries (lcu/platforms.py's rule); group/other write is otherwise refused (conservative: the
# trusted-group and ACL refinements of platforms.py are left to the full validation in Node).
__lcu_untrusted() {
  # shellcheck disable=SC2046
  set -- "$1" $("$__LCU_T_LS" -ldn -- "$1" 2>/dev/null)
  if [ "$#" -lt 4 ]; then
    __LCU_REASON="$1 cannot be inspected"
    return 0
  fi
  if [ "$4" != 0 ] && [ "$4" != "$__LCU_UID" ]; then
    __LCU_REASON="$1 is owned by uid $4"
    return 0
  fi
  case $2 in
    l*) return 1 ;;
    d????????[tT]*) return 1 ;;
    ?????w*|????????w*)
      __LCU_REASON="$1 is writable by group or other accounts"
      return 0 ;;
  esac
  return 1
}

# __lcu_walk PATH CHECK [ROOT]: resolve PATH physically, component by component, following every link (the targets
# of intermediate links and their ancestors included). With CHECK=1 every entry traversed must be trusted. With ROOT,
# every link met at or below ROOT is stored in __LCU_L1..__LCU_L<__LCU_LN> (numbered variables: a path may contain
# any byte but NUL, newlines included, so no separator can delimit a list). Result: __LCU_REAL (no link left in it).
__lcu_walk() {
  case $1 in
    /*) __LCU_REST=$1 ;;
    *) __LCU_REST=$(pwd -P && printf x) || { __LCU_REASON='the working directory cannot be read'; return 1; }
       __LCU_REST=${__LCU_REST%x}
       __LCU_REST=${__LCU_REST%?}/$1 ;;
  esac
  if [ "$2" = 1 ] && __lcu_untrusted /; then return 1; fi
  __LCU_CUR=
  __LCU_N=0
  __LCU_LN=0
  while [ -n "$__LCU_REST" ]; do
    __LCU_C=${__LCU_REST%%/*}
    if [ "$__LCU_C" = "$__LCU_REST" ]; then __LCU_REST=; else __LCU_REST=${__LCU_REST#*/}; fi
    case $__LCU_C in
      ''|.) continue ;;
      ..) __LCU_CUR=${__LCU_CUR%/*}; continue ;;
    esac
    __LCU_NEXT=$__LCU_CUR/$__LCU_C
    if [ "$2" = 1 ] && __lcu_untrusted "$__LCU_NEXT"; then return 1; fi
    if [ -L "$__LCU_NEXT" ]; then
      if [ -n "${3-}" ]; then
        case $__LCU_NEXT in
          "$3"|"$3"/*) __LCU_LN=$((__LCU_LN + 1)); eval "__LCU_L$__LCU_LN=\$__LCU_NEXT" ;;
        esac
      fi
      __LCU_N=$((__LCU_N + 1))
      if [ "$__LCU_N" -gt 40 ]; then
        __LCU_REASON="$1 has too many levels of symbolic links"
        return 1
      fi
      __lcu_readlink "$__LCU_NEXT" || return 1
      case $__LCU_TARGET in /*) __LCU_CUR= ;; esac
      __LCU_REST=$__LCU_TARGET/$__LCU_REST
    else
      __LCU_CUR=$__LCU_NEXT
    fi
  done
  __LCU_REAL=${__LCU_CUR:-/}
  return 0
}

# __lcu_gate NODE [SELECTED [NOLINK]]: the pre-Node gate (design addendum A). Sets __LCU_REAL, the physical path
# that was checked and that must be executed (never NODE again: its links could change after the check).
#   Linux: every traversed entry trusted (above); with SELECTED, the physical Node must be the
#     resources/cua_node/bin/node of SELECTED's real path (lcu/platforms.py refuses runtime links leaving the app).
#   macOS (before any byte of Node runs, in lcu/platforms.py's order): SELECTED (NOLINK=1: not itself a link, as
#     resolve_installed_mac_app requires of --existing-app) is a directory named ChatGPT.app whose real path is the
#     bundle enclosing the physical Node; Contents/Info.plist (regular, not a link) has CFBundleIdentifier
#     com.openai.codex; the Sky helper's Info.plist has com.openai.sky.CUAService; the binary carries an Apple-anchored
#     signature of OpenAI's team; the bundle satisfies that team with identifier com.openai.codex (--strict, not
#     --deep). As root, the Linux ownership rule applies too.
#   Left to the Node validator (lcu/platforms.mjs) on every launch, as before: --deep verification and signer
#   inspection of app and helper, the CUA manifest/architecture and the required files. So LCU's own JavaScript
#   starts on the OpenAI-signed Node of a correctly identified bundle before the deep check has run.
__lcu_gate() {
  __LCU_CHECK=1
  if [ "$__LCU_OS" = Darwin ] && [ "$__LCU_UID" != 0 ]; then __LCU_CHECK=0; fi
  __lcu_walk "$1" "$__LCU_CHECK" || return 1
  __LCU_NODE_REAL=$__LCU_REAL
  if [ ! -f "$__LCU_NODE_REAL" ] || [ ! -x "$__LCU_NODE_REAL" ]; then
    __LCU_REASON="$__LCU_NODE_REAL is not an executable file"
    return 1
  fi
  __LCU_BUNDLE=
  if [ -n "${2-}" ]; then
    __lcu_selected "$2" "${3-0}" || return 1
  fi
  if [ "$__LCU_OS" = Darwin ]; then
    if [ ! -x /usr/bin/codesign ]; then
      __LCU_REASON='/usr/bin/codesign is missing'
      return 1
    fi
    if ! __LCU_OUT=$(/usr/bin/codesign --verify --strict \
        -R='anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"' "$__LCU_NODE_REAL" 2>&1); then
      __LCU_REASON="its code signature does not verify as OpenAI's (team 2DC432GLL2): $(__lcu_first_line "$__LCU_OUT")"
      return 1
    fi
    if [ -z "${2-}" ]; then
      case $__LCU_NODE_REAL in
        *.app/Contents/Resources/cua_node/bin/node) __LCU_BUNDLE=${__LCU_NODE_REAL%/Contents/Resources/cua_node/bin/node} ;;
        *) __LCU_REASON="$__LCU_NODE_REAL is not the bundled Node of a ChatGPT app bundle"; return 1 ;;
      esac
    fi
    if ! __LCU_OUT=$(/usr/bin/codesign --verify --strict \
        -R='anchor apple generic and identifier "com.openai.codex" and certificate leaf[subject.OU] = "2DC432GLL2"' \
        "$__LCU_BUNDLE" 2>&1); then
      __LCU_REASON="Installed application signature verification failed: $__LCU_BUNDLE: $(__lcu_first_line "$__LCU_OUT")"
      return 1
    fi
  fi
  __LCU_REAL=$__LCU_NODE_REAL
  return 0
}

# __lcu_selected APP NOLINK: the selected application (installer: --existing-app or the default; launchers: the
# release's `app` link) is the one the physical Node belongs to, with the identities lcu/platforms.py checks first.
__lcu_selected() {
  if [ ! -d "$1" ]; then
    if [ "$__LCU_OS" = Darwin ]; then
      __LCU_REASON="Expected a local ChatGPT.app directory: $1"
    else
      __LCU_REASON="Expected an installed ChatGPT application directory: $1"
    fi
    return 1
  fi
  __lcu_walk "$1" 0 || return 1
  __LCU_SELECTED_REAL=$__LCU_REAL
  if [ "$__LCU_OS" = Darwin ]; then
    # The installer's --existing-app itself (NOLINK=1) must be a ChatGPT.app directory and not a link; a launcher's
    # release `app` link (NOLINK=0) must lead to one (runtime.paths checks the descriptor's resolved app).
    if [ "$2" = 1 ]; then __LCU_NAMED=${1%/}; else __LCU_NAMED=$__LCU_SELECTED_REAL; fi
    case $__LCU_NAMED in */ChatGPT.app|ChatGPT.app) __LCU_NAMEOK=1 ;; *) __LCU_NAMEOK=0 ;; esac
    if { [ "$2" = 1 ] && [ -L "${1%/}" ]; } || [ "$__LCU_NAMEOK" = 0 ]; then
      __LCU_REASON="Expected a local ChatGPT.app directory: $1"
      return 1
    fi
  fi
  if [ "$__LCU_OS" = Darwin ]; then
    __LCU_EXPECTED=$__LCU_SELECTED_REAL/Contents/Resources/cua_node/bin/node
  else
    __LCU_EXPECTED=$__LCU_SELECTED_REAL/resources/cua_node/bin/node
  fi
  # lcu/platforms.py's order: the bundle identities first (same messages), then where the Node really is.
  if [ "$__LCU_OS" = Darwin ]; then
    __lcu_bundle_id "$__LCU_SELECTED_REAL" com.openai.codex || return 1
    __lcu_bundle_id "$__LCU_SELECTED_REAL/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app" \
      com.openai.sky.CUAService || return 1
  fi
  # The selected app's own Node path must lead to the Node the release resolves to, and stay inside the app:
  # lcu/platforms.py lets links inside the app point anywhere inside it (each target and its ancestors are
  # validated, which the Linux walk of the Node above did), and refuses a link that leaves it.
  __lcu_walk "$__LCU_EXPECTED" 0 "$__LCU_SELECTED_REAL" || return 1
  if [ "$__LCU_REAL" != "$__LCU_NODE_REAL" ]; then
    __LCU_REASON="$__LCU_NODE_REAL is not the bundled Node of the selected application $1 ($__LCU_SELECTED_REAL)"
    return 1
  fi
  case $__LCU_NODE_REAL in
    "$__LCU_SELECTED_REAL"/*) ;;
    *) __LCU_REASON="$__LCU_EXPECTED resolves outside the application ($__LCU_NODE_REAL)"; return 1 ;;
  esac
  __LCU_I=0
  __LCU_COUNT=$__LCU_LN
  while [ "$__LCU_I" -lt "$__LCU_COUNT" ]; do
    __LCU_I=$((__LCU_I + 1))
    eval "__LCU_LINK=\$__LCU_L$__LCU_I"
    __lcu_walk "$__LCU_LINK" 0 || return 1
    case $__LCU_REAL in
      "$__LCU_SELECTED_REAL"|"$__LCU_SELECTED_REAL"/*) ;;
      *) __LCU_REASON="$__LCU_LINK links outside the application ($__LCU_REAL)"; return 1 ;;
    esac
  done
  __LCU_BUNDLE=$__LCU_SELECTED_REAL
  return 0
}

# __lcu_bundle_id BUNDLE IDENTIFIER: lcu/platforms.py _identity() (same messages).
__lcu_bundle_id() {
  __LCU_INFO=$1/Contents/Info.plist
  if [ ! -f "$__LCU_INFO" ] || [ -L "$__LCU_INFO" ]; then
    __LCU_REASON="Application bundle metadata is missing: $__LCU_INFO"
    return 1
  fi
  if [ ! -x /usr/bin/plutil ]; then
    __LCU_REASON='/usr/bin/plutil is missing'
    return 1
  fi
  if ! __LCU_ID=$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$__LCU_INFO" 2>/dev/null && printf x); then
    __LCU_ID=x
  fi
  __LCU_ID=${__LCU_ID%x}
  __LCU_ID=${__LCU_ID%?}
  if [ "$__LCU_ID" != "$2" ]; then
    __LCU_REASON="Unexpected application bundle identifier: $1"
    return 1
  fi
  return 0
}

__lcu_first_line() {
  __LCU_FL=${1%%
*}
  printf '%s' "${__LCU_FL:-no detail}"
}

# __lcu_quarantine: move each set Node startup variable to __LCU_Q_<NAME> and list it in __LCU_Q (design
# addendum B; restored as data by lcu/startup_vars.mjs). Same list as startup_vars.mjs QUARANTINED.
__lcu_quarantine() {
  unset __LCU_Q
  for __LCU_NAME in NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_ICU_DATA NODE_V8_COVERAGE NODE_COMPILE_CACHE \
      NODE_REDIRECT_WARNINGS NODE_NO_WARNINGS NODE_PENDING_DEPRECATION NODE_TLS_REJECT_UNAUTHORIZED NODE_DEBUG \
      NODE_DEBUG_NATIVE NODE_PRESERVE_SYMLINKS NODE_PRESERVE_SYMLINKS_MAIN NODE_DISABLE_COLORS \
      NODE_SKIP_PLATFORM_CHECK UV_THREADPOOL_SIZE NODE_USE_ENV_PROXY NODE_USE_SYSTEM_CA \
      NODE_DISABLE_COMPILE_CACHE NODE_COMPILE_CACHE_PORTABLE NODE_TEST_CONTEXT NODE_PENDING_PIPE_INSTANCES \
      UV_USE_IO_URING FORCE_COLOR NO_COLOR NODE_FORCE_READLINE \
      OPENSSL_CONF OPENSSL_ENGINES OPENSSL_MODULES OPENSSL_ia32cap OPENSSL_armcap \
      SSL_CERT_FILE SSL_CERT_DIR; do
    eval "__LCU_SET=\${$__LCU_NAME+x}"
    if [ -n "$__LCU_SET" ]; then
      eval "__LCU_Q_$__LCU_NAME=\$$__LCU_NAME"
      export "__LCU_Q_$__LCU_NAME"
      unset "$__LCU_NAME"
      __LCU_Q=${__LCU_Q:+$__LCU_Q,}$__LCU_NAME
    fi
  done
  if [ -n "${__LCU_Q-}" ]; then export __LCU_Q; fi
}

# __lcu_signals: report the signals the caller left ignored (__LCU_SIGIGN); Node resets them at startup.
__lcu_signals() {
  unset __LCU_SIGIGN
  __LCU_IGN=
  if [ "$__LCU_OS" = Linux ] && [ -r /proc/$$/status ]; then
    __LCU_MASK=
    while read -r __LCU_K __LCU_V; do
      case $__LCU_K in SigIgn:) __LCU_MASK=$__LCU_V ;; esac
    done < /proc/$$/status
    case $__LCU_MASK in ''|*[!0-9a-fA-F]*) __LCU_MASK=0 ;; esac
    # The low 32 bits are enough (all listed signals are below 32) and keep the arithmetic in range.
    while [ "${#__LCU_MASK}" -gt 8 ]; do __LCU_MASK=${__LCU_MASK#?}; done
    for __LCU_S in HUP:1 INT:2 QUIT:3 USR1:10 USR2:12 ALRM:14 TERM:15; do
      if [ $(( (0x$__LCU_MASK >> (${__LCU_S#*:} - 1)) & 1 )) = 1 ]; then __LCU_IGN=${__LCU_IGN:+$__LCU_IGN,}${__LCU_S%:*}; fi
    done
  elif [ "$__LCU_OS" = Darwin ] && [ -x /bin/bash ]; then
    # A child inherits the ignored dispositions; bash refuses to trap a signal that was ignored on entry.
    # A failed probe reports nothing (never "everything ignored").
    if __LCU_TRAPS=$(/bin/bash -p -c 'trap : HUP INT QUIT USR1 USR2 ALRM TERM; trap' 2>/dev/null); then
      case $__LCU_TRAPS in
        *SIGTERM*|*SIGHUP*|*SIGINT*|*SIGQUIT*|*SIGUSR1*|*SIGUSR2*|*SIGALRM*)
          for __LCU_S in HUP INT QUIT USR1 USR2 ALRM TERM; do
            case $__LCU_TRAPS in *"SIG$__LCU_S
"*|*"SIG$__LCU_S") ;; *) __LCU_IGN=${__LCU_IGN:+$__LCU_IGN,}$__LCU_S ;; esac
          done ;;
      esac
    fi
  fi
  if [ -n "$__LCU_IGN" ]; then
    __LCU_SIGIGN=$__LCU_IGN
    export __LCU_SIGIGN
  fi
}

# __lcu_bytes_check ARG...: macOS has no /proc to let Node see raw bytes, so flag arguments or environment
# entries that are not UTF-8 (lcu/entry.mjs then refuses instead of passing on U+FFFD replacements).
__lcu_bytes_check() {
  unset __LCU_ENV_INVALID
  if [ "$__LCU_OS" = Darwin ] && [ -x /usr/bin/iconv ] && [ -x /usr/bin/env ]; then
    if ! { /usr/bin/env; printf '%s\n' "$@"; } | /usr/bin/iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1; then
      __LCU_ENV_INVALID=1
      export __LCU_ENV_INVALID
    fi
  fi
}

# __lcu_python_path ARG: str(Path(ARG).expanduser()) into __LCU_PATH (status 1 and __LCU_REASON when Python
# raises "Could not determine home directory."). Path() drops empty and "." components and trailing slashes,
# keeps "..", keeps exactly two leading slashes, and "" is "."; expanduser applies only to a relative first
# component starting with "~": HOME when set (even empty: then "/"), else the account database.
__lcu_python_path() {
  __lcu_pure_path "$1"
  case $__LCU_PATH in
    '~'*)
      __LCU_FIRST=${__LCU_PATH%%/*}
      __LCU_TAIL=${__LCU_PATH#"$__LCU_FIRST"}
      __LCU_NAME=${__LCU_FIRST#'~'}
      if [ -z "$__LCU_NAME" ] && [ -n "${HOME+x}" ]; then
        __LCU_HOMEDIR=$HOME
      else
        if [ -z "$__LCU_NAME" ]; then __LCU_NAME=$("$__LCU_T_ID" -un) || __LCU_NAME=; fi
        case $__LCU_NAME in
          ''|-*|*[!A-Za-z0-9._-]*) __LCU_HOMEDIR='~' ;;
          *) eval "__LCU_HOMEDIR=~$__LCU_NAME" ;;
        esac
        case $__LCU_HOMEDIR in
          '~'*) __LCU_REASON='Could not determine home directory.'; return 1 ;;
        esac
      fi
      while :; do case $__LCU_HOMEDIR in */) __LCU_HOMEDIR=${__LCU_HOMEDIR%/} ;; *) break ;; esac; done
      __LCU_HOMEDIR=$__LCU_HOMEDIR$__LCU_TAIL
      __lcu_pure_path "${__LCU_HOMEDIR:-/}" ;;
  esac
  return 0
}

__lcu_pure_path() {
  case $1 in
    ///*) __LCU_PROOT=/ ;;
    //*) __LCU_PROOT=// ;;
    /*) __LCU_PROOT=/ ;;
    *) __LCU_PROOT= ;;
  esac
  __LCU_PREST=$1/
  __LCU_POUT=
  while [ -n "$__LCU_PREST" ]; do
    __LCU_C=${__LCU_PREST%%/*}
    __LCU_PREST=${__LCU_PREST#*/}
    case $__LCU_C in ''|.) continue ;; esac
    __LCU_POUT=${__LCU_POUT:+$__LCU_POUT/}$__LCU_C
  done
  __LCU_PATH=$__LCU_PROOT$__LCU_POUT
  if [ -z "$__LCU_PATH" ]; then __LCU_PATH=.; fi
}
# END LCU COMMON

# Python's installer answered -h/--help (and its unique prefixes) wherever argparse met it before `--`.
__lcu_install_help_requested() {
  for __LCU_A in "$@"; do
    case $__LCU_A in
      --) return 1 ;;
      -h|--h|--he|--hel|--help) return 0 ;;
    esac
  done
  return 1
}

# argparse's reading of --existing-app: unique prefixes --exi..--existing-app (--e/--ex are ambiguous with --export),
# --opt=value, the last occurrence wins, scanning stops at `--`; a following value starting with `-` is taken only
# when argparse would (a negative number, contains a space, or exactly `-`). Sets __LCU_EXISTING (and _GIVEN=1).
__lcu_install_negative() {
  __LCU_NR=${1#-}
  case $__LCU_NR in ''|*[!0-9.]*) return 1 ;; esac
  case $__LCU_NR in *.*.*|*.) return 1 ;; esac
  return 0
}
__lcu_install_is_option() {
  case $1 in
    --exi|--exis|--exist|--existi|--existin|--existing|--existing-|--existing-a|--existing-ap|--existing-app) return 0 ;;
  esac
  return 1
}
__lcu_install_existing_app() {
  __LCU_EXISTING=
  __LCU_EXISTING_GIVEN=0
  __LCU_EXPECT=0
  for __LCU_A in "$@"; do
    if [ "$__LCU_EXPECT" = 1 ]; then
      __LCU_EXPECT=0
      case $__LCU_A in
        -) __LCU_EXISTING=$__LCU_A; __LCU_EXISTING_GIVEN=1 ;;
        -*)
          if __lcu_install_negative "$__LCU_A"; then __LCU_EXISTING=$__LCU_A; __LCU_EXISTING_GIVEN=1
          else case $__LCU_A in *' '*) __LCU_EXISTING=$__LCU_A; __LCU_EXISTING_GIVEN=1 ;; esac; fi ;;
        *) __LCU_EXISTING=$__LCU_A; __LCU_EXISTING_GIVEN=1 ;;
      esac
      continue
    fi
    case $__LCU_A in
      --) break ;;
      --exi*=*)
        if __lcu_install_is_option "${__LCU_A%%=*}"; then __LCU_EXISTING=${__LCU_A#*=}; __LCU_EXISTING_GIVEN=1; fi ;;
      --exi*) if __lcu_install_is_option "$__LCU_A"; then __LCU_EXPECT=1; fi ;;
    esac
  done
}

__lcu_install_unusable() {
  if __lcu_install_help_requested "$@"; then
    __lcu_install_help
    exit 0
  fi
  printf '%s\n' "LCU: Cannot run the ChatGPT app's bundled Node (${__LCU_NODE-}): $__LCU_REASON. Repair the official app and rerun the LCU installer." >&2
  exit 1
}

__lcu_install() {
  __LCU_NODE=
  __LCU_OS=
  if ! __lcu_tools; then
    __LCU_OS=$(/usr/bin/uname -s 2>/dev/null || /bin/uname -s 2>/dev/null || :)
    __lcu_install_unusable "$@"
  fi
  case $__LCU_OS in
    Linux) __LCU_NAME_PREFIX='LCU installer'; __LCU_ENTRY=scripts/install.mjs
      __LCU_DEFAULT=/usr/lib/chatgpt; __LCU_RELATIVE=resources/cua_node/bin/node ;;
    Darwin) __LCU_NAME_PREFIX='LCU macOS installer'; __LCU_ENTRY=scripts/install_macos.mjs
      __LCU_DEFAULT=/Applications/ChatGPT.app; __LCU_RELATIVE=Contents/Resources/cua_node/bin/node ;;
    *) printf '%s\n' 'LCU installation currently supports Linux and macOS.' >&2; exit 1 ;;
  esac
  if ! __lcu_self_root; then
    printf '%s\n' "LCU: $__LCU_REASON" >&2
    exit 1
  fi
  __lcu_install_existing_app "$@"
  if [ "$__LCU_EXISTING_GIVEN" = 1 ]; then
    if ! __lcu_python_path "$__LCU_EXISTING"; then
      # Python raised RuntimeError here (Path.expanduser), after argparse; help still wins.
      if __lcu_install_help_requested "$@"; then __lcu_install_help; exit 0; fi
      printf '%s\n' "$__LCU_NAME_PREFIX: $__LCU_REASON" >&2
      exit 1
    fi
    __LCU_APP=$__LCU_PATH
  else
    __LCU_APP=$__LCU_DEFAULT
  fi
  case $__LCU_APP in /) __LCU_NODE=/$__LCU_RELATIVE ;; *) __LCU_NODE=$__LCU_APP/$__LCU_RELATIVE ;; esac
  if [ ! -e "$__LCU_NODE" ]; then
    __LCU_REASON='it is missing'
    __lcu_install_unusable "$@"
  fi
  # The selected app itself is validated too (lcu/platforms.py: not a link on macOS, identities, same bundle).
  __LCU_NOLINK=0
  if [ "$__LCU_OS" = Darwin ]; then __LCU_NOLINK=1; fi
  __lcu_gate "$__LCU_NODE" "$__LCU_APP" "$__LCU_NOLINK" || __lcu_install_unusable "$@"
  __lcu_quarantine
  __lcu_signals
  __lcu_bytes_check "$@"
  # The physical path the gate verified, never the spelling it was reached by.
  exec "$__LCU_REAL" --disable-warning=ExperimentalWarning "$__LCU_ROOT/$__LCU_ENTRY" "$@"
}

__lcu_install "$@"
