# LCU (unreleased): Node runtime, no Python on Linux and macOS

Draft release notes. The version is not bumped here. Everything below is intentional; the black-box differential
(`tests/blackbox`, oracle = the Python implementation at `tests/blackbox/BASE`) lists each difference as a reviewed entry in
`tests/blackbox/deviations.json` with its justification, and every other scenario is byte-identical.

## What changed

LCU's own code (install, setup, update, doctor, apps, status, prune, browser, the MCP launch path `bin/lcu`,
`bin/lcu-session`, `bin/lcu-codex-sandbox`, and the macOS and Windows lifecycle hosts) now runs on the Node that ships
inside the official ChatGPT app (`cua_node`, Node 24.21.0 today; LCU needs Node >= 22 and `process.execve`, >= 22.15).
No Node ships in the archives, nothing is compiled, and the app is still never copied, modified or re-signed.

- **Python is no longer required on Linux or macOS.** Python 3.12+ is needed only on Windows, and only to run
  `scripts/install_windows.py` (the installer bridge that makes the private copy of the Store app) and `lcu update`
  there. Developers still need Python for the build tools (`scripts/build_bundle.py`, `check_archive.py`, ...).
- **Linux system packages gain `acl`** (`getfacl`), used to refuse an app directory that carries a POSIX ACL LCU cannot
  read. With `--skip-system` install it yourself. If `getfacl` is missing, LCU falls back to a small
  `/usr/bin/python3` xattr reader (python3 stays a Linux system package for that and the X-Resource helper); if
  neither works, the app check refuses with `cannot inspect POSIX ACLs` rather than assume there are none.

## Launch shims and the pre-Node check

`bin/lcu`, `bin/lcu-session`, `bin/lcu-codex-sandbox` and `scripts/install.sh` are `/bin/sh` scripts that run the app's
Node by absolute path (never one found on `PATH`) after a check that runs before any Node code:

- Linux: the Node binary and every directory above it (links followed) must be owned by root or the invoking user and
  not group- or other-writable, except sticky directories. This is stricter than 0.9.4: a location writable by a group
  of trusted members is refused, and root refuses an app that another account can replace (run the installer as that
  account, or make the app root-owned).
- Both: the Node must be the bundled Node of the selected app (the installer's `--existing-app` or default app, the
  release's `app` link for the launchers): the app's own `resources/cua_node/bin/node` (Linux) or
  `Contents/Resources/cua_node/bin/node` (macOS) must resolve to it, and its real path must lie inside the app's real
  path. Links inside the app are allowed, links leaving it are refused, as in 0.9.x.
- macOS, in 0.9.4's order and with its messages: the selected app is a `ChatGPT.app` directory (for `--existing-app`
  not itself a link), its `Contents/Info.plist` names `com.openai.codex` and the Sky helper's names
  `com.openai.sky.CUAService`; then `codesign --verify --strict` must accept the Node as signed by OpenAI's team
  (2DC432GLL2) and the app bundle as `com.openai.codex` of that team. The `--deep` verification of the app and the
  helper, their signer inspection, the CUA manifest/architecture and the required files are still checked on every
  launch, but by LCU's own JavaScript once the Node runs (as 0.9.4 did in Python): LCU's code therefore starts on an
  OpenAI-signed Node inside a correctly identified bundle before that deep check has finished. Doing the deep check in
  the shell too would add seconds to every launch.
- When the Node is missing, not executable or refused, `lcu --help` still prints its static usage text, and everything
  else prints `LCU: Cannot run the ChatGPT app's bundled Node (PATH): REASON. Repair the official app and rerun the LCU
  installer.` and exits 1. This replaces the more specific 0.9.4 messages ("Application payload is incomplete: ...",
  "The application is not in a location only root and this account can change: ...", ...) for the cases in which the
  Node itself is the problem, in `lcu`, `lcu status`, `lcu prune`, `lcu --version` and the installers. `lcu doctor` and
  `lcu setup` need a usable Node for the same reason.
- The Python interpreter selection (`LCU_PYTHON`, the `python3.14 ... python3` search) is gone.
- Node startup variables (`NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, ...) are never applied to LCU's own Node;
  the launcher hands them back unchanged to everything LCU starts, so children see the caller's environment byte for
  byte. Signals the caller left ignored stay ignored for those children.
- An argument or environment variable that is not valid UTF-8 is refused with `LCU: ... is not valid UTF-8; LCU cannot
  pass it on unchanged. Unset or re-encode it and retry.` (Python passed such bytes through; a Node string cannot).
- With a working directory that was deleted, the shells that run the launcher print their own `getcwd` warning before
  LCU starts: dash (Linux `/bin/sh`) prints `sh: 0: getcwd() failed: ...` and macOS bash prints three
  `shell-init: error retrieving current directory: ...` lines (in the black-box fixtures the app Node is itself a
  shell wrapper, which adds its own); LCU's behavior and exit status are unchanged. Only these
  known startup lines are allowed by the black-box allowlist; they never hide an LCU diagnostic.
- **Accepted residual: the `/bin/sh` launchers do not hand the caller's environment on byte for byte.** Python's
  launcher passed `os.environ` through untouched; an `sh` script cannot, whatever it does, and the launchers are
  deliberately plain POSIX `sh` (reviewed design, BRIEF addendum A). What is observable, exactly:
  - Linux (`/bin/sh` is dash): variables whose names are not shell identifiers (`A.B`, `FOO-BAR`, `SPACE KEY`, a
    name starting with a digit) are dropped; an inherited `IFS` is reset to `<space><tab><newline>` (dash does not
    import it); `PWD` is replaced by the real current directory (added when the caller had none).
  - macOS (`/bin/sh` is bash 3.2, run with `-p`): such names survive; an inherited `IFS` is reset; `PWD` is replaced by
    the real current directory; `OLDPWD` and `_` are not passed on; `SHLVL` is `0` when the caller had none.
  - Everything else (every ordinary variable, empty values, values of any content, the Node startup variables) is
    passed on unchanged. LCU's own children get that environment; the Node-startup variables are restored first.
  The black-box scenario `rt/launch/shell-env` records the environment the app Node is exec'd with (a Node script
  started through its absolute interpreter path, so no shell rewrites it a second time) and pins the differences
  with exact `launcher-shell-env` entries per platform; `probe.mjs`/`recorder.mjs` keep hiding `PWD`, `OLDPWD`,
  `SHLVL` and `_` for both sides in every other scenario.

## Installers and `lcu update`

- `scripts/install.sh` runs the selected app's Node. Without a usable app, only `--help` (static) is answered;
  everything else (argparse errors, `--list-agents`, `--offline` without `--skip-system`, ...) prints the pre-Node
  diagnostic `LCU: Cannot run the ChatGPT app's bundled Node (<app>/resources/cua_node/bin/node): it is missing. Repair
  the official app and rerun the LCU installer.` and exits 1 (the old `LCU installer: LCU requires the official ChatGPT
  desktop app ... No app was found at ...` text is no longer produced by the installer; `lcu setup` still has it). Its
  description line no longer says `Python 3.12+`.
- `scripts/install.py`, `scripts/install_macos.py` and `scripts/windows_launcher.py` remain as tiny trampolines so
  `lcu update` from an old (Python) release still works; they `exec /bin/sh install.sh` with the same arguments.
- `lcu update` runs `/bin/sh -p <new>/scripts/install.sh ...` (and `sudo /bin/sh -p ...` in the hint it prints for an
  unwritable prefix), where 0.9.x ran `python -B scripts/install.py`. On Windows it needs Python 3.12+ on `PATH` for the
  install step and says so before downloading anything.
- The detached `lcu update --refresh` runs through the release's own launcher, so the check and the variable
  quarantine apply to it too.
- `lcu update` extracts only the archive formats LCU's own release archives use: gzip tar without GNU sparse
  members, and ZIP with stored or deflate members. Python's extractor also accepted GNU sparse tar members and
  bzip2/LZMA ZIP members; the updater only ever downloads LCU's checksum-verified release archives, which never use
  them, so such an archive is now refused instead of extracted.
- `lcu update` refuses an HTTPS download that redirects to plain HTTP (archive and checksum), where Python followed it.
- On Windows, `lcu update --post-install` moves agent registrations written by earlier releases (the Python
  `windows_launcher.py` form and the interim direct-Node form) to `cmd.exe /d /c <prefix>\lcu.cmd`, through setup's
  own registration path, keeping scope, project, `--chrome`/`--audio` and approval settings. A registration it cannot
  move keeps working through the old launcher and is reported with the `lcu setup` command that finishes it. Project
  registrations are found only in directories LCU recorded (launcher pins, Pi's command file, the saved pending
  context, Claude Code's project list).
- Ctrl-C during `lcu update` removes the partially downloaded archive and the temporary tree, as before; during the
  installer step the installer gets a quarter second, is then killed, and the tree is removed.
- Ctrl-C during the synchronous copy/verify of a release leaves an unpublished `releases/<name>`, never selected;
  `lcu prune` removes it.
- The release launcher on Windows is `bin/lcu.cmd`, which hands over to `<prefix>\lcu.cmd`. `<prefix>\lcu.cmd` checks
  that every path component is not redirected and that `node.exe` still has the digest recorded at install before it
  runs the Node dispatcher; registrations run it through `cmd.exe`. Windows has fixture tests only, no live claim.
- The Chrome native-host relay written by `lcu browser install` is a `/bin/sh` launcher that runs the stable `lcu`
  (`lcu update --post-install` migrates relays LCU wrote earlier; foreign or unmarked files are left alone).
  Its host directory holds a `.lcu-relay-implementation` stamp (a digest of the release's relay code) instead of a
  copied relay script, so `lcu browser status` and the post-update refresh still notice when the relay code changed
  and print the reconnect hint. `windows_launcher.py` is kept as a compatibility trampoline.

## Output and diagnostics

- Standard output is buffered exactly as Python's was (`lcu/compat/pyio.mjs`, one implementation behind every print):
  when stdout is not a terminal it is block buffered (an 8192-byte text chunk over a buffer of the descriptor's
  `st_blksize`, flushed when full, at exit, by `input()` before it reads, and by `print(flush=True)`), so a child that
  inherits stdout (the doctor inside `lcu setup --check-desktop`, the installer inside `lcu update`) still writes its
  lines before the parent's earlier ones in a piped transcript; on a terminal it is line buffered. Output is never lost
  on `process.exit`, an uncaught error or Ctrl-C, and is lost on `execve` and on death by an unhandled signal, as with
  CPython. stderr is written at once. A closed reader is noticed at the flush (`Exception ignored ... BrokenPipeError`,
  exit status 120 at exit). Lone surrogates follow Python's stdout error handler for the locale.
- `input()` prompts follow CPython: on stderr when stdin and stdout are both terminals, on stdout otherwise; stdout is
  flushed before the read.
- An uncaught error prints what CPython prints: `Traceback (most recent call last):`, frame lines, then
  `<PythonType>: <message>` (a missing LCU module is `ModuleNotFoundError: No module named 'lcu.macos_host'`, Node
  errors map to the Python class of the same failure), exit 1. Ctrl-C ends the process by SIGINT after printing
  `Traceback ...` / `KeyboardInterrupt`, as Python does (no exit status 130).
- The curl fallback of `lcu update` runs `curl -q -fsS ...`: `-q` ignores `~/.curlrc`/`.curlrc` and is deliberate,
  approved hardening that Python's argv lacked (it is the only change to the child's argv).
- When a certificate check fails, `curl` is not installed and `lcu update` cannot fall back, the error now reads `LCU cannot verify
  HTTPS certificates and curl is not installed.` (Python's text began `Python cannot verify ...`; LCU no longer uses Python's TLS
  stack). Only that one word changed; no black-box scenario prints it.
- The Chrome relay, when the original host has exited and the relay writes to it, reports `LCU Chrome native-host relay
  failed: [Errno 32] Broken pipe` and prints the same `Exception in thread Thread-1 (inbound)` traceback as Python.
  One residual: when the host exits while the relay is idle and stdin stays open, Python's daemon reader thread made the
  interpreter abort at shutdown (SIGABRT, `Fatal Python error: _enter_buffered_busy`); the Node relay exits 0 quietly.
  This is a documented exception (the status is better, not reproduced on purpose) listed as `python-daemon-shutdown`.
- On macOS, a 70 000-byte lifetime request without a newline is answered `notified:false` and closed, but whether the
  hook client sees the reply or only the reset depends on socket read-ahead timing (Python and Node differ); the client
  never sees success in either case (documented exception, `lifetime-oversize-race`).
- Accepted residual (F11): on macOS, when more peers connect to the lifetime socket than its backlog of 8, Python's
  connect was refused or blocked; with Node the connect succeeds and the excess connection is then closed.
- Accepted residual (R02): on an app whose bundled Node is older than 26.1, a few exec failures (ETXTBSY, loader
  errors, truncated binaries) abort the process (SIGABRT) instead of returning an error to LCU.
- On machines where the previous Python LCU ran under Python 3.13/3.14, some error message wording changes, because
  LCU now matches CPython 3.12.10 messages.
- `lcu prune` and the other readers decode files as strict UTF-8, as Python's `read_text` did under a UTF-8 locale;
  the `lcu apps` helper output is decoded leniently where Python would have printed a traceback.
- Malformed JSON/plist/TOML inputs that Python reported with an `AttributeError`/`TypeError` traceback now report the
  same exception text through the Node error path.

## Developers

- The black-box Docker oracle runs on CPython 3.12.10 exactly (`tests/blackbox/Dockerfile` compiles the python.org
  tarball, checksum verified, at image-build time only; runs stay `--network none`). Ubuntu's own 3.12.3 differs in
  argparse choice quoting and in `shutil.rmtree` error text, so the former allowlist entries for those are gone.

- `scripts/build_bundle.py` ships exactly the per-platform file set (`runtime_files`), smoke-tests the archive with
  Node (every shipped module imports, `lcu --help` runs) and validates the macOS app by running `lcu/platforms.mjs` on
  the app's own signed Node. `tests/node/bundle_closure.test.mjs` proves every platform's entry points load only
  shipped files.
- The Python white-box unit tests of the removed modules are replaced by `tests/node/*.test.mjs`
  (`tests/node/run-all.sh` runs them on the Node on `PATH` and on the app's Node). Differential tests against the Python
  implementation load it from the frozen oracle tree (`tests/blackbox/oracle.py`, `LCU_ORACLE_ROOT`).
- `scripts/bundle_runtime.mjs` repeats `VERSION` of `scripts/bundle.py`; bump both (a test checks they match and
  `scripts/build_bundle.py` refuses to build when they differ).
