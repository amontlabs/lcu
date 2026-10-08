# Remove Python from LCU

Status: in progress, delivered as one PR. This brief replaces the first attempt (PR #25, branch `node-runtime`), which was
closed unmerged. Every agent working on this port works from this page; if something here is wrong or unclear, raise
it before working around it.

## Goal

**Remove Python from LCU.** LCU runs entirely on the Node that ships inside the ChatGPT app (`cua_node`), on Linux,
macOS and Windows: install, setup, launch, browser relay and update. Users need nothing installed beyond the official
app.

Codex computer use itself is already JavaScript running on that Node. Only LCU's own glue is Python today, so the port
removes a dependency; it does not change what computer use does.

### What must not change

These are what users and agents depend on:

- The files `lcu setup` writes for each agent (Codex, Claude, Pi, OMP, Hermes, ...), compared as parsed data, not
  bytes.
- Exit codes, and the commands and flags LCU accepts.
- How computer use is launched: which original app files run, with which arguments and environment. LCU hands over to
  the original runtime and adds nothing to it (AGENTS.md).
- Safety checks: app identity and signature, file permissions, caller sandbox and approval settings.
- The install layout, and upgrading in place from an installed Python release (0.9.7).

### What may change

- The wording of errors and help text (keep it clear and actionable).
- The internal file layout of the LCU tree.
- Anything a user cannot observe.

### How it is built

- Idiomatic Node using its own libraries: `node:util` `parseArgs` (or a small hand-written parser), `node:zlib`, JSON,
  `node:path`, `node:child_process`. **Do not imitate Python's libraries, error formats or quirks.** No CPython-style
  argparse, tracebacks, `[Errno N]` formatting, Python JSON spacing, chunked-read emulation, and so on.
- **Size check.** The Python runtime is about 9k lines (`lcu/*.py` plus the shipped `scripts/*.py`). The Node runtime
  should be about the same size. If `lcu/` grows past about 1.5x, stop and explain why in the PR.
- **Speed budget.** Every entry point (`lcu`, `lcu-session`, `lcu-codex-sandbox`) must start at least as fast as the
  Python version on the same machine. CI measures the median startup time and fails above the budget. Pre-launch
  checks must not fork a process per path component or verify a code signature twice.
- The AGENTS.md rules still apply in full: use the original app's runtime, add no input, screenshot, accessibility,
  browser or MCP implementation of LCU's own, and keep app binaries out of Git.

### How it is tested, in proportion

1. **Port the existing unit tests.** `tests/test_*.py` (43 files, about 12k lines) already describe the intended
   behaviour. Port each one to `node:test` alongside the module it covers, and keep the assertions that matter (files
   written, exit codes, commands run). Drop assertions that only pin Python wording.
2. **One end-to-end check per command against 0.9.7.** Run the old and new releases in the disposable Linux image.
   Compare the written agent config files as parsed data, plus exit codes and the launch command and environment. Do
   not compare stdout or stderr byte for byte.
3. **One upgrade test.** Install 0.9.7, run its `lcu update` against the new archive, then check `lcu status`,
   `lcu doctor`, an MCP launch, the agent registrations, and rollback. Run it on Linux in CI, and on the macOS guest
   before release.
4. **The existing real-desktop gates.** `tests/run.sh` (Linux, CI), the macOS guest
   (`docs/verification/macos-test-guest-access.md`) and a Windows run, each before claiming that platform.

A test that needs code written only to make the test pass is a red flag. Report it instead of writing that code.

## What uses Python today (on `main`)

| Area | Files | Notes |
|---|---|---|
| Launchers | `bin/lcu`, `bin/lcu-session`, `bin/lcu-codex-sandbox` | `#!/usr/bin/env python3` |
| Launch path | `lcu/runtime.py`, `platforms.py`, `app_layout.py`, `interpreter.py`, `session.py`, `sandbox_shim.py`, `native_host.py`, `capture.py`, `diagnostic_log.py`, `macos_host.py` | Hands over to the original runtime |
| Setup and management | `lcu/setup.py`, `setup_clients.py`, `harness_setup.py`, `approval.py`, `codex_hooks.py`, `app_server.py`, `claude_mod.py`, `claude_visibility.py`, `apps.py`, `asar.py`, `origins.py`, `browser.py`, `doctor.py`, `status.py`, `maintenance.py`, `tested.py` | |
| Install and update | `scripts/install.py`, `install_macos.py`, `install_windows.py`, `windows_launcher.py`, `installed_app.py`, `bundle.py`; `lcu/update.py`, `update_apply.py`, `windows.py`, `windows_host.py` | Windows install is Python today |
| Linux input guard | `XRES_HELPER_SCRIPT` in `lcu/linux_sky_service.mjs` | Runs `python3 -c` with ctypes into libX11, XRes and XTest. See the open question below |

**Out of scope:**

- **`adapters/hermes/__init__.py`.** It is Hermes's own plugin and runs inside Hermes, which is a Python agent.
- **Build and CI tooling** (`scripts/build_bundle.py`, `check_archive.py`, `provision_agent_tools.py`, test drivers)
  may stay Python for now. It is never shipped to users. Porting it later is optional.

**Compatibility stubs.** Thin compatibility stubs are allowed temporarily, only where an *already installed* Python
release calls into the new archive during its own `lcu update` (for example a `scripts/install.py` that only hands
over to the Node installer). They must contain no logic. The old release's own Python is what runs them.

## Open question: the Linux input guard

LCU's Linux service wrapper checks, before and after input, which window is under the pointer and whether another
client holds a pointer grab. It also releases keys and buttons when a call times out. It does this through a Python
ctypes script, because Node cannot call libX11 without a native add-on.

Before porting it:

1. Check whether the original app's Linux computer-use runtime already covers this, in which case LCU should drop it
   (AGENTS.md: input belongs to the original runtime).
2. If LCU must keep it, speak the X11 protocol directly from Node over the display socket (XRes `QueryClientIds`,
   `QueryPointer`, `QueryKeymap`, `GrabPointer`, `TranslateCoordinates`, XTEST `FakeInput`). That is a few hundred
   lines with no dependency. Port its behaviour as it is, without redesigning it.

Either way, no Python remains on Linux.

## Order of work

The port is delivered as **one PR**. It merges once everything below is done and CI is green. Work proceeds in this
order inside it:

1. **Foundation and launch path:** the launcher contract below, the three launchers and the modules they need. The
   speed budget applies here first.
2. **Setup and management commands. Install and update** on all three platforms, plus the upgrade test from 0.9.7.
   **The Linux input guard**, per the open question.
3. **End-to-end checks, the speed budget in CI, and a check that no `python3` is reachable** while installing and
   running.
4. **Cleanup:** delete the Python runtime, update `docs/INSTALLATION.md`, `docs/ADAPTERS.md` and
   `docs/DEVELOPMENT.md` requirements, and record what was verified on which platform.

## Conventions for the Node code

- ES modules (`.mjs`) under `lcu/`, one per Python module, with the same name (`lcu/setup.py` becomes
  `lcu/setup.mjs`). Merge or drop modules only where the Python split no longer makes sense. Node 22.15 or later
  (`process.execve`). No npm dependencies in the runtime.
- **Errors:** throw an `Error` with a clear message. The entry point prints `LCU: <message>` and exits 1, like the
  Python launchers. No custom exception hierarchies beyond what callers need to tell cases apart.
- **Tests:** `tests/node/<module>.test.mjs` with `node:test` and `node:assert/strict`, run by `node --test tests/node/`.
  A ported module's Python test file is deleted in the same change.
- **Reading the Python originals:** once a `.py` file is deleted, read it with `git show origin/main:<path>`.

### Launcher contract (Linux and macOS)

- `bin/lcu`, `bin/lcu-session` and `bin/lcu-codex-sandbox` are short `/bin/sh` scripts. They read the absolute path
  of the app's Node that the installer recorded in the release, check that it is executable, and `exec` it on the
  matching `.mjs` entry with all arguments. They spawn nothing else.
- Identity checks on the app (signature, ownership) run inside Node, as the Python runtime ran them, and each runs
  once per launch.
- `lcu --help` must still work when the recorded Node is missing, and every other command must say clearly that the
  app needs repairing or LCU needs reinstalling.

### Windows bootstrap

- `scripts/install.ps1` finds the registered official Store app, checks its identity and signature, and runs the
  app's `node.exe` on the Node installer. If that `node.exe` cannot be executed in place, it uses a temporary copy of
  `cua_node` instead.
- Everything else, including the private app copy, is Node.

## Using the first attempt as reference

The `node-runtime` branch (PR #25) is kept for reference, not for merging. Reviewers confirmed that its computer-use
handover is faithful to the original runtime. Its platform knowledge is worth reading:

- handing the process over with `process.execve`
- verifying `cua_node` before running it
- macOS code-signature checks
- Windows file locks
- running under an app-owned Node

Do not copy its `lcu/compat/` layer, its byte-for-byte black-box harness, or its deviations list. They exist to
imitate Python and are what this brief rules out.
