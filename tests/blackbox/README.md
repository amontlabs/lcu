# Black-box differential harness

Runs LCU entry points (`bin/lcu`, `bin/lcu-codex-sandbox`, `scripts/install.sh`, ...) as subprocesses and compares
two implementations byte for byte. The oracle is the Python implementation at the commit in `BASE`
(`a2c48c21016589d4...`, LCU 0.9.6); the other side is this worktree. Nothing here imports the code under test, so the harness
survives a port to another language. The harness itself is Python 3.12 stdlib only and needs `node` on PATH
(the fake apps' `cua_node/bin/node` is a wrapper that execs the real Node, and every recorder is a Node script).

## Run

```
python3 tests/blackbox/run.py                    # oracle (A) vs worktree (B), host platform scenarios
python3 tests/blackbox/run.py -k mcp -k cli/help # name PREFIX ('mcp' = mcp/..., never rt/mac/...); globs match the whole
                                                 # name ('*mcp*' for substring); repeatable
python3 tests/blackbox/run.py -x rt/mac           # exclude scenarios matching a pattern; repeatable
python3 tests/blackbox/run.py -x rt/mac           # exclude scenarios matching a pattern; repeatable
python3 tests/blackbox/run.py --list
python3 tests/blackbox/run.py --node /path/to/node22    # run every fake app and recorder on another Node
python3 tests/blackbox/run.py --b-overlay DIR    # B = this worktree with DIR's files copied over it (temp copy)
python3 tests/blackbox/run.py --coverage         # trace the oracle only; write .port/coverage.md (see below)
python3 tests/blackbox/run.py --deviations FILE  # reviewed allowlist of expected A/B differences (see below)
tests/blackbox/docker.sh --root [args]           # root container: runs only `needs_root` scenarios
python3 tests/blackbox/npmcache.py [ROOT]        # populate the archive node_modules cache (needs npm + network once)
python3 tests/blackbox/run.py --node /path/to/node22    # run every fake app and recorder on another Node
python3 tests/blackbox/run.py --b-overlay DIR    # B = this worktree with DIR's files copied over it (temp copy)
python3 tests/blackbox/run.py --coverage         # trace the oracle only; write .port/coverage.md (see below)
python3 tests/blackbox/run.py --deviations FILE  # reviewed allowlist of expected A/B differences (see below)
tests/blackbox/docker.sh --root [args]           # root container: runs only `needs_root` scenarios
python3 tests/blackbox/npmcache.py [ROOT]        # populate the archive node_modules cache (needs npm + network once)
python3 tests/blackbox/run.py --a /path/a --b /path/b   # any two implementation roots (a source tree or an extracted archive)
python3 tests/blackbox/run.py --runs 3           # run B three times per scenario; any run-to-run difference is a DIFF
python3 tests/blackbox/run.py --keep             # leave the last sandboxes in /tmp/lcu-bb for inspection
python3 tests/blackbox/run.py --golden           # write A's snapshots to tests/blackbox/golden/<platform>/ for review
python3 tests/blackbox/oracle.py                 # materialise (and print) the cached oracle tree
tests/blackbox/docker.sh [run.py args]           # the same inside the repo's Linux image, no network
```

Output is `PASS`/`DIFF`/`ERROR`/`SKIP` per scenario, a unified diff for every `DIFF`, and exit status 1 on any
`DIFF` or `ERROR`. Oracle against itself (`--a X --b X`) must always be clean: that is the determinism check.

`oracle.py` runs `git -C <worktree> archive <BASE>` into `$TMPDIR/lcu-bb-oracle/<sha>` (override with
`LCU_BB_ORACLE_CACHE`). `docker.sh` materialises it on the host, mounts it at `/oracle` and the worktree at `/src`
(both read-only), runs as the unprivileged `ubuntu` user with `--network none`, and sets `LCU_BB_DISPOSABLE=1`,
which unlocks the scenarios that write the OS account home. `LCU_BB_PLATFORM=linux/amd64` selects the other image
(emulated on Apple silicon). It builds `tests/Dockerfile` as `lcu-verification:<arch>` if that image is missing, and
`tests/blackbox/Dockerfile` as `lcu-blackbox:<arch>` on top of it (rebuilt when its `lcu.blackbox.python` label is not
3.12.10): that stage compiles the official python.org CPython 3.12.10 tarball (sha256 pinned in the Dockerfile,
network needed only at image-build time) into `/opt/cpython-3.12.10`, and the harness, hence the oracle, runs on it
(Ubuntu's own 3.12.3 differs in argparse choice quoting and `shutil.rmtree` messages; `/usr/bin/python3` stays 3.12.3 for
the Linux system-helper tests). On the macOS host run the harness with an exact 3.12.10 (not `python3`, which may be 3.14).

Concurrent harness runs on one machine are safe: each scenario takes an exclusive lock
(`<base>/.lock-<scenario>`) while its sandbox exists. `LCU_BB_ROOT` moves the sandbox base.

Concurrent harness runs on one machine are safe: each scenario takes an exclusive lock
(`<base>/.lock-<scenario>`) while its sandbox exists. `LCU_BB_ROOT` moves the sandbox base.

## How a scenario runs

For each scenario and each side the harness wipes `/tmp/lcu-bb/<scenario>` (`/private/tmp/...` on macOS: no
symlinked path component, because LCU refuses symlinked prefixes) and rebuilds it. Both sides run at the SAME
absolute path, so output needs no path normalisation.

```
<sandbox>/home/            HOME (account-home scenarios use the OS account's home instead; see below)
<sandbox>/tmp/             TMPDIR
<sandbox>/work/            default cwd
<sandbox>/apps/            fake ChatGPT app: chatgpt/ (Linux layout) or ChatGPT.app/ (macOS bundle)
<sandbox>/prefix/          .lcu-install, releases/<ver>-<hex12>/{implementation, bundle.json, app ->, installation.json}, current ->
<sandbox>/src/             the implementation tree as an extracted archive (installer scenarios)
<sandbox>/.bb/             harness only: recorder, fakes/ (first on PATH), tools/ (python3, node), config.json, log/
```

The implementation is copied (minus `.git`, `.port`, `.claude`, `tests`, `docs`, `site`, `node_modules`,
`__pycache__`, and the developer-only files a built archive does not ship: `scripts/agent-tools`,
`scripts/build_bundle.py`, `scripts/check_archive.py`, `scripts/provision_agent_tools.py`,
`scripts/host-source-inventory.json`, `scripts/instructions.lock.json`, `scripts/native`) to where a real install
puts it, and then made archive-faithful: `agent-tools/{package.json,package-lock.json,node_modules}` and
`adapters/node_modules` from a cached `npm ci` with the same flags as scripts/provision_agent_tools.py (keyed by
lockfile hash under `$LCU_BB_NPM_CACHE`, default `$TMPDIR/lcu-bb-npm`; offline once cached; docker.sh fills it on
the host and mounts it read-only), and `agent-tools/node/bin/node` as the archive's relative symlink
`../../../app/resources/cua_node/bin/node` (`app/Contents/Resources/...` on macOS). The release version (bundle
`version`, release dir name `<version>-bb0bb0bb0001`) is read from `scripts/bundle.py` of the tree under test.

The fake app's `cua_node/bin/node` is `#!/bin/sh` + `exec "$LCU_BB_NODE" "$@"` (exec: no extra process stays;
LCU_BB_NODE is the PATH node or `--node`). It cannot be a symlink (the Linux trust check rejects links leaving the
app) and must never be a copy of the official app's Node (AGENTS.md: no OpenAI binaries in fixtures). Environment is replaced entirely: `HOME`, `TMPDIR`, `PATH`
(`.bb/fakes:.bb/tools:/usr/bin:/bin:/usr/sbin:/sbin`), `LANG=C.UTF-8`, `TZ=UTC`, `COLUMNS=80`,
`PYTHONDONTWRITEBYTECODE=1`, plus `LCU_BB_*`. Scenarios add or delete variables per command with `env={...}`.

Snapshot per scenario (`snapshot.py`), one text document:

* per command: argv, cwd, stdin, exit code or terminating signal (`TIMEOUT` if killed), raw stdout, raw stderr;
* the full file tree of the sandbox: relative path, type, mode bits, symlink target, size, sha256, and the content
  of small text files that are new or changed since just before the first command (`[new]`, `[changed]`,
  `[deleted]` markers). Inside implementation directories only differences are listed (against the baseline, or,
  for releases an installer created, against the extracted archive in `src/`), because the code differs by design;
* the recorder log: one entry per fake invocation, in order, with a `harness: run N starts` marker per command.

### Recorder fakes

Everything LCU runs by name is a recorder: `codex claude pi omp hermes npx npm codesign dpkg dpkg-query apt-get
sudo curl open osascript swiftc xdg-open` (self-contained shell scripts in `.bb/fakes`, so they also work when LCU
scrubs the environment). The fake app's own entry points (`node_repl`, `codex`, `codex-code-mode-host`,
`ChatGPT`, `extension-host`, `cua-repl.mjs`, the Sky service, the bundled `add-mcp`/`skills` installers) are
recorders too. Each appends `{tool, argv, cwd, argv0?, env?, stdin?}` JSON to the log and then behaves per config.
Configure with `sb.fake(name, env=[...]|'*', stdin=True, rules=[{'argv': [...prefix] | 'match': regex-on-joined-argv,
'stdout':..., 'stderr':..., 'exit': n, 'sleep': ms}], default={...})`. `argv0` is the path LCU gave the app's Node
(captured by the wrapper). Any recorder configured with `appServer: True` (default for `app-codex`) switches to a fake Codex `app-server` when its
argv contains `app-server`: it answers the JSON-RPC subset LCU's hook installer
uses, and every request is logged. Add a new fake name to `FAKE_NAMES` in `sandbox.py`.

### Normalisers

Anything legitimately different between runs is handled by a NAMED normaliser that a scenario opts into
(`@scenario(..., normalise=('uuid',))`); there is no global fuzzy matching. Defined in `snapshot.NORMALISERS`:
`uuid` (`NODE_REPL_REQUEST_META` session ids), `tmpdir-suffix` (`lcu-codex-config-XXXXXXXX` style temp dirs),
`release-id` (installer release names `<ver>-<hex12>`). The recorder additionally drops variables injected by the
shell wrappers or macOS (`PWD OLDPWD SHLVL _ __CF_USER_TEXT_ENCODING`) and the harness's own `LCU_BB_*`.

### What the sh launchers do to the environment (`rt/launch/shell-env`)

`recorder.mjs`, `spy.mjs`, `client.mjs` and `probe.mjs` hide `PWD`, `OLDPWD`, `SHLVL`, `_` (and `LCU_BB_*`) for both sides, and the
fake app's Node is itself a `/bin/sh` wrapper that would rewrite the environment a second time. `rt/launch/shell-env`
therefore replaces the app's `node` by a Node script started through its absolute interpreter (no shell in between;
`/usr/bin/env node` would find the runtime's own `bin/node` first on PATH) that logs the environment it was exec'd with,
unfiltered, and then `execve`s the real Node unchanged. The oracle's Python launcher passed the caller's environment on
untouched; the `sh` launchers cannot (Linux dash drops names that are not shell identifiers, resets IFS, rewrites PWD;
macOS bash resets IFS, rewrites PWD, drops OLDPWD and `_`, sets SHLVL). That accepted residual is pinned by exact
`launcher-shell-env` entries per host in `deviations.json`.

## Add a scenario

Create or extend a module in `scenarios/` (all modules are auto-imported):

```python
from . import scenario

@scenario('cli/example', hosts=('darwin', 'linux'), normalise=())
def _(sb):
    sb.place_release()                  # or sb.place_release('linux'), agent_tools=True, app_omit=[...], installation=False ...
    sb.fake('codex', rules=[{'argv': ['--version'], 'stdout': 'codex-cli 9.9.9\n'}])
    sb.lcu('status', '--json')          # <release>/bin/lcu; sb.run([...]) for anything else
```

Stable public API (other areas' scenario files depend on it; extend, do not change):

* `Sandbox` attributes: `root home tmp work prefix apps src bb release recorder log_path config_path impl_root`.
* `place_release(target=None, *, app=True, bundle=True, installation=True|False|dict, agent_tools=True|'fake'|False,
  app_omit=(), app_kwargs=None, current=True)`; `place_src(sealed=None|'linux'|'darwin')` (sealed also adds the
  archive node_modules); `archive_modules(root, target, agent_tools)`; `add_old_release(name, mtime)`.
* `run(argv, *, stdin=b''|None, tty=False, env=None, cwd=None, timeout=60, label=None)` (always a new session;
  on timeout only that session is killed, see `kill_own_session`); `lcu(*args, **kw)`; `fake(name, **config)`;
  `add_fake(name)`; `remove_fake(name)`; `base_env()`; `trees()`.
* `fixtures`: `VERSION RUNTIME`, `BUNDLE_VERSION RELEASE_NAME` (read as `fixtures.X` at call time: they follow
  the tree under test), `architecture() write() recorder_script() linux_app() mac_app() agent_tools()
  agent_tools_node_link() seal() read_version()`; `npmcache.node_modules() npmcache.install()`.
* `snapshot.NORMALISERS` (add new named entries; never change existing ones): `uuid`, `release-id`,
  `release-id-any`, `account` (the real account name and home -> `<ACCOUNT>`/`<ACCOUNT_HOME>`; always applied to
  goldens so they name no personal account), `tmpdir-suffix` (8-char Python suffixes), `lcu-ml` (`lcu-ml-<any suffix>`, Python 8 / Node 6),
  `traceback` (an uncaught Python traceback becomes `[uncaught TYPE]`), `update-times` (`checked_at`/`at` values),
  `diagnostic-log` (the adapters' `<adapter>-<stamp>-<pid>.jsonl` log: name, size/hash and `t`/`pid`/`ms` values;
  default for the setup scenarios).
* `run(..., tty='all', script=[(regex, text), ...])`: all three fds on the pty, and scripted answers typed when
  the regex appears in the output since the previous answer (pty and stderr).
* `take_baseline()`, `compare_with(glob, reference=None)` (public forms of what mgmt scenarios did through
  `_take_baseline`/`_impl_dirs`), `show(path, label=None)` (records a file's intermediate state as a pseudo-command).
* `@scenario(..., needs_root=True, account_home='ubuntu')`: root container mode (`docker.sh --root`).
* `tmp/node-compile-cache` is never listed in the tree (Node's compile cache is nondeterministic).
* An implementation tree placed with `place_release`/`place_src` after a command already ran joins the baseline
  at placement, so only what LCU later changes inside it is listed.
* The fake app's Node wrapper sets `LCU_BB_ARGV0` and `LCU_BB_ARGV0_PID=$$`; the recorder reports `argv0` only in
  that exact process, so processes the Node starts (LCU itself after the port) never gain an `argv0` field.

Stable public API (other areas' scenario files depend on it; extend, do not change):

* `Sandbox` attributes: `root home tmp work prefix apps src bb release recorder log_path config_path impl_root`.
* `place_release(target=None, *, app=True, bundle=True, installation=True|False|dict, agent_tools=True|'fake'|False,
  app_omit=(), app_kwargs=None, current=True)`; `place_src(sealed=None|'linux'|'darwin')` (sealed also adds the
  archive node_modules); `archive_modules(root, target, agent_tools)`; `add_old_release(name, mtime)`.
* `run(argv, *, stdin=b''|None, tty=False, env=None, cwd=None, timeout=60, label=None)` (always a new session;
  on timeout only that session is killed, see `kill_own_session`); `lcu(*args, **kw)`; `fake(name, **config)`;
  `add_fake(name)`; `remove_fake(name)`; `base_env()`; `trees()`.
* `fixtures`: `VERSION RUNTIME`, `BUNDLE_VERSION RELEASE_NAME` (read as `fixtures.X` at call time: they follow
  the tree under test), `architecture() write() recorder_script() linux_app() mac_app() agent_tools()
  agent_tools_node_link() seal() read_version()`; `npmcache.node_modules() npmcache.install()`.
* `snapshot.NORMALISERS` (add new named entries; never change existing ones): `uuid`, `release-id`,
  `release-id-any`, `tmpdir-suffix` (8-char Python suffixes), `lcu-ml` (`lcu-ml-<any suffix>`, Python 8 / Node 6),
  `traceback` (an uncaught Python traceback becomes `[uncaught TYPE]`), `update-times` (`checked_at`/`at` values),
  `diagnostic-log` (the adapters' `<adapter>-<stamp>-<pid>.jsonl` log: name, size/hash and `t`/`pid`/`ms` values;
  default for the setup scenarios).
* `run(..., tty='all', script=[(regex, text), ...])`: all three fds on the pty, and scripted answers typed when
  the regex appears in the output since the previous answer (pty and stderr).
* `take_baseline()`, `compare_with(glob, reference=None)` (public forms of what mgmt scenarios did through
  `_take_baseline`/`_impl_dirs`), `show(path, label=None)` (records a file's intermediate state as a pseudo-command).
* `@scenario(..., needs_root=True, account_home='ubuntu')`: root container mode (`docker.sh --root`).
* `tmp/node-compile-cache` is never listed in the tree (Node's compile cache is nondeterministic).
* An implementation tree placed with `place_release`/`place_src` after a command already ran joins the baseline
  at placement, so only what LCU later changes inside it is listed.
* The fake app's Node wrapper sets `LCU_BB_ARGV0` and `LCU_BB_ARGV0_PID=$$`; the recorder reports `argv0` only in
  that exact process, so processes the Node starts (LCU itself after the port) never gain an `argv0` field.

Useful `Sandbox` pieces: `place_release(target, app=, bundle=, installation=, agent_tools=, app_omit=, app_kwargs=)`,
`place_src(sealed='linux'|'darwin')` (extracted archive; `sealed` adds a `bundle.json` so installers accept it),
`add_old_release(name, mtime)`, `run(argv, stdin=b'', tty=False, env={}, cwd=, timeout=, label=)`,
`fake(...)`, `remove_fake(name)`. `hosts` is the OS the scenario can run on (`darwin` or `linux`; it is skipped
elsewhere); the fixture platform (`place_release('linux')`) is independent of the host where the code path allows
(the Linux launch path runs on macOS too). `account_home=True` marks scenarios that write the OS account home.

Rules for scenarios: never read or write the real HOME or the real ChatGPT app; never drive a desktop; keep
network off; a scenario that is nondeterministic needs a named normaliser, not a looser comparison.

### Why some scenarios are Docker-only

`lcu setup` and the installers resolve the target account with the OS account database (`pwd`), not `$HOME`, and
write inside that account's real home. On the macOS host that would be the user's real home, so those scenarios
(`setup/codex*`, `setup/export`, `install/runtime-only`) refuse to run unless `LCU_BB_DISPOSABLE=1`, which only
`docker.sh` sets; there the account is `ubuntu` and its home is emptied before every run.

## Scenarios for LCU 0.9.5/0.9.6 (scenarios/u096.py)

`origins/*` (arguments, list incl. JSON/session/broken files, forget incl. allowed/denied and unrewritable files,
origin forms, CODEX_HOME), `diagnostic-log/status` and `/doctor` (the log line, LCU_DIAGNOSTIC_LOG=0, LCU_LOG_DIR,
XDG_STATE_HOME), `doctor/mac-socket-path` (darwin: the 103-byte socket limit through
SKY_CUA_SERVICE_NATIVE_PIPE_PATH), `browser/reconnect-message`, `update/post-install-relay` (no relay, current,
changed plugin, manifest pointing elsewhere), `windows-host/analyzer` (the shipped lcu/windows_host_analyze.cjs on
JSON requests; runnable off Windows).

## Scenarios (first set)

See `python3 tests/blackbox/run.py --list`. `cli/*` (help, version variants, usage errors, tty guard, status,
doctor, setup help and `--list-agents`, apps, prune, update help), `mcp/*` (launch argv/env/cwd/stdin as received
by the fake `cua-repl.mjs`, flags, caller env, exit status, discovery compat, unusable cwd, codesign failure),
`sandbox-shim/cases`, `install/*` (help, refusals, full runtime-only install), `setup/*`.

## Test TLS

The `lcu update` scenarios talk to a local HTTPS fixture (assets/mgmt/fixture_server.py). Its CA and server key are
generated per sandbox with `/usr/bin/openssl` into `<sandbox>/.bb/tls` (fixtures_mgmt.tls_dir, RSA 2048, 30 days,
SANs for the GitHub host names); no key material is checked in.

## Expected deviations (`--deviations FILE`)

A reviewed JSON allowlist; format and semantics in `deviations.py`. Each entry has an `id`, a `scenario` glob, one
`field` (`stdout`, `stderr`, `exit`, optionally `@N` for run N; `file:<glob>`; `recorder` or `recorder:<key>`), an
exact `before`/`after` pair or `before_re`/`after_re` regexes, and a `justification`. Matching occurrences are
replaced by the same token on both sides within that field only; if the snapshots are then identical the scenario
is `EXPECTED` (never `PASS`), and the summary lists every deviation used with its justification and the scenarios it
covered, plus `UNUSED` entries. Anything else stays `DIFF`. A file present on one side only (an
implementation artifact) uses `"only": "a"|"b"` with a `file:<glob>` field and a full-match pattern for that side;
see deviations.py. The `relay-implementation-stamp` entries are of that kind. Nothing is applied without the file being passed.

Additions for the Node cut-over (see `deviations.py`): `"multiline": true` matches a pattern against the whole text of
one field (a run's stdout, the recorder log, one file entry), so blocks and lines present on one side only can be
expected; field `tree` is the whole file-tree section; `"host": "linux"|"darwin"` restricts an entry to one OS.
`run.py --dump-diffs DIR` writes the A and B snapshots of every `DIFF` scenario and `suggest_deviations.py DIR` lists
what differs field by field (the input for writing exact entries). The checked-in `deviations.json` is the reviewed
set for oracle (0.9.4) against the Node tree: Linux from `docker.sh` (CPython 3.12.10 oracle) and `--root`, macOS from
the host with `tests/node/blackbox_overlay.sh` (the fake app's Node is unsigned, so the launchers' pre-Node gate is
disabled in the overlay copy only).

Root scenarios (`root_cases.py`, `docker.sh --root`): `lcu setup` as root with and without `--user`, the privilege
drop as seen by a recorder agent CLI (real/effective uid, gid, groups, environment, cwd), `--validate-only`,
`scripts/install.sh --user` (runtime-only, full, apt recorder), and `bin/lcu-session` as root.

## Coverage of the Python oracle

`run.py --coverage` runs only the oracle (A), with a `sitecustomize.py` injected through `PYTHONPATH` into the
oracle sandbox (never into B; coverage runs do not compare). It records executed lines with Python 3.12
`sys.monitoring`, for every process under a release or `src/` (children that inherit the environment included),
dumping on exit and before `exec`. Results are saved per host in `.port/coverage-data/<host>.json` and merged
into `.port/coverage.md`: per module functions hit/total and lines hit/total, and per module the functions no
scenario exercised. Run it on the host and through `docker.sh --coverage` to merge both platforms.

## Process safety

`.port/BRIEF.md` SAFETY RULE applies. The framework signals nothing except, on a command timeout, the Popen child
it spawned (session leader of a new session): `kill_own_session` verifies `getsid(pid) == getpgid(pid) == pid` on
the unreaped child before SIGKILLing that group, else signals only the child. Nothing is ever signalled by name,
parent pid or discovery. Signal scenarios use `assets/rt/driver.py` `send()`.

## Test TLS

The `lcu update` scenarios talk to a local HTTPS fixture (assets/mgmt/fixture_server.py). Its CA and server key are
generated per sandbox with `/usr/bin/openssl` into `<sandbox>/.bb/tls` (fixtures_mgmt.tls_dir, RSA 2048, 30 days,
SANs for the GitHub host names); no key material is checked in.

## Expected deviations (`--deviations FILE`)

A reviewed JSON allowlist; format and semantics in `deviations.py`. Each entry has an `id`, a `scenario` glob, one
`field` (`stdout`, `stderr`, `exit`, optionally `@N` for run N; `file:<glob>`; `recorder` or `recorder:<key>`), an
exact `before`/`after` pair or `before_re`/`after_re` regexes, and a `justification`. Matching occurrences are
replaced by the same token on both sides within that field only; if the snapshots are then identical the scenario
is `EXPECTED` (never `PASS`), and the summary lists every deviation used with its justification and the scenarios it
covered, plus `UNUSED` entries. Anything else stays `DIFF`. A file present on one side only (an
implementation artifact) uses `"only": "a"|"b"` with a `file:<glob>` field and a full-match pattern for that side;
see deviations.py. The `relay-implementation-stamp` entries are of that kind. Nothing is applied without the file being passed.

Additions for the Node cut-over (see `deviations.py`): `"multiline": true` matches a pattern against the whole text of
one field (a run's stdout, the recorder log, one file entry), so blocks and lines present on one side only can be
expected; field `tree` is the whole file-tree section; `"host": "linux"|"darwin"` restricts an entry to one OS.
`run.py --dump-diffs DIR` writes the A and B snapshots of every `DIFF` scenario and `suggest_deviations.py DIR` lists
what differs field by field (the input for writing exact entries). The checked-in `deviations.json` is the reviewed
set for oracle (0.9.4) against the Node tree: Linux from `docker.sh` (CPython 3.12.10 oracle) and `--root`, macOS from
the host with `tests/node/blackbox_overlay.sh` (the fake app's Node is unsigned, so the launchers' pre-Node gate is
disabled in the overlay copy only).

Root scenarios (`root_cases.py`, `docker.sh --root`): `lcu setup` as root with and without `--user`, the privilege
drop as seen by a recorder agent CLI (real/effective uid, gid, groups, environment, cwd), `--validate-only`,
`scripts/install.sh --user` (runtime-only, full, apt recorder), and `bin/lcu-session` as root.

## Coverage of the Python oracle

`run.py --coverage` runs only the oracle (A), with a `sitecustomize.py` injected through `PYTHONPATH` into the
oracle sandbox (never into B; coverage runs do not compare). It records executed lines with Python 3.12
`sys.monitoring`, for every process under a release or `src/` (children that inherit the environment included),
dumping on exit and before `exec`. Results are saved per host in `.port/coverage-data/<host>.json` and merged
into `.port/coverage.md`: per module functions hit/total and lines hit/total, and per module the functions no
scenario exercised. Run it on the host and through `docker.sh --coverage` to merge both platforms.

## Process safety

`.port/BRIEF.md` SAFETY RULE applies. The framework signals nothing except, on a command timeout, the Popen child
it spawned (session leader of a new session): `kill_own_session` verifies `getsid(pid) == getpgid(pid) == pid` on
the unreaped child before SIGKILLing that group, else signals only the child. Nothing is ever signalled by name,
parent pid or discovery. Signal scenarios use `assets/rt/driver.py` `send()`.

## GAPS: what the harness cannot observe yet

* Absolute-path invocations cannot be faked by PATH: `/usr/bin/mdfind` (`lcu apps allow <name>` lookup), the
  `bin/lcu-owner-auth` Touch ID helper (apps allow/revoke), `/bin/sh` probes, `/proc` reads, `reg.exe` (Windows),
  `sys.executable` re-execs. Not scenario-covered; stubbing them needs a hook in the implementation or a sandbox
  tool (not done on purpose).
* macOS host: the signed-app lifecycle host (`macos_host.py`, LaunchServices start of the Sky helper, the
  `LCU_MAC_*` sockets) and the darwin MCP launch with the computer surface are NOT covered (only the
  codesign-failure path). `setup`/full installs on macOS are not run on the host (real-home rule); they need a
  disposable macOS account or guest VM.
* Windows: nothing (no host, no fixtures).
* Process lifetime and signals: stdin EOF only. No SIGTERM/SIGINT forwarding, orphan/child cleanup, or timing.
* Real agent CLIs and real `add-mcp`/`skills`: replaced by recorders, so the bytes of real harness config files
  (Codex TOML, Claude JSON, Pi/OMP/Hermes plugins) are not compared; only what LCU passes to them (argv, env, the
  JSON-RPC requests, the `upsertServer` arguments) and what LCU writes itself (`setup.json`, locks, modes).
  Claude Code, Pi, OMP, Hermes, approvals, `--approval auto`, `--reconcile`, `--allow-missing` flows are not yet scenarios.
* `lcu update` (network via fake `curl`, `--check`, apply, post-install), `lcu browser`, `bin/lcu-session`
  (needs Xvfb/XFCE), `--check-desktop`, `lcu doctor` on Linux with a real X session: not yet scenarios.
* The fake Sky service answers only `setup`, `list_windows`, `get_screenshot`; the Linux input wrapper
  (`linux_sky_service.mjs`) and native-cleanup wrappers are never executed.
* Wrapper noise: the app's Node is a shell wrapper (exec'd, so no extra process remains), but `/bin/sh` itself sets
  `PWD/SHLVL/_` before the script runs, so the recorded env hides them and a regression that leaks them cannot be
  seen. Fixing this needs a native exec stub or a symlink (rejected by the Linux trust check). The exec path LCU
  used is visible only as `argv0`.
* Releases created by an installer are compared against the archive, not inventoried byte for byte beyond
  difference-from-archive; files LCU writes into an implementation directory are listed, `__pycache__` is ignored.
* `fixtures.seal` re-implements the `bundle.json` format of `scripts/bundle.py` (format 1, sha256/mode inventory);
  a port that changes the format must update it. The version is read from `scripts/bundle.py` (`VERSION = '...'`);
  a port that moves it must update `fixtures.read_version`.
* Some output depends on the filesystem (e.g. `lcu prune` sizes), so goldens are per host; A and B always run on
  the same host.
* One architecture per run (arm64 here); x64 needs `LCU_BB_PLATFORM=linux/amd64` under emulation.
