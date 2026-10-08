# LCU 0.10.0 (unreleased)

**LCU no longer needs Python.** Install, setup, launch, the Chrome relay and `lcu update` now run on the Node that ships inside the ChatGPT app (`cua_node`), on Linux, macOS and Windows. Users need nothing installed beyond the official app and their harness. Computer use itself is unchanged: LCU still hands over to the app's original runtime with the same files, arguments and environment. The brief is [docs/REMOVE-PYTHON.md](../REMOVE-PYTHON.md).

## What you may notice

- **Python is not required.** Python 3.12+ is no longer a prerequisite on any platform. The Linux installer no longer installs `libxres1` or `python3`: the Linux input guard speaks the X11 protocol (X-Resource, XTEST) directly from Node. The Claude Code plugin hook no longer looks for Python before installing LCU.
- **Windows installs through `install.ps1` only.** `scripts\install.ps1` checks the registered Store app and runs its own `node.exe` on the Node installer. Windows agent registrations name the account-local `<prefix>\lcu.cmd`. Windows remains a deferred candidate.
- **Error and help wording may differ.** Messages are still `LCU: <message>` with exit status 1 (2 for usage errors), and the commands, flags and exit codes are unchanged, but the text is Node's, not Python's (no argparse-style usage blocks, no `[Errno N]`).
- **Exit status after a signal.** Where `lcu` waits for the original server (macOS, Windows), a server ended by signal N now gives exit status 128 + N, the shell convention. Python LCU gave 256 − N.
- **The Chrome relay was renamed.** The private native-host copy under `~/.local/share/lcu/browser/<id>/` now holds `lcu-native-host.mjs` instead of `lcu-native-host.py`. The `lcu-native-host` launcher the browser manifest points at keeps its name; it is a short `sh` script that runs the Node recorded for the release. `lcu update` and `lcu browser install` replace the old relay.
- **Each release records its Node.** The installer writes `<release>/node-path`, the absolute path of the app's Node. The `bin/lcu*` launchers are `/bin/sh` scripts that run it. If the app is moved or removed, `lcu` says so and asks you to repair the app or reinstall LCU; `lcu --help` still works.
- **Faster startup.** `lcu --version`, `lcu-session --help` and `lcu-codex-sandbox --help` start in roughly half the time of 0.9.7 (end-to-end check on Linux x64: 64 ms against 114 ms, and 32 ms against 64 ms).

## Upgrading from 0.9.7

`lcu update` from 0.9.7 installs 0.10.0 in place: 0.9.7 runs the new archive's `scripts/install.py` with its own Python, and that file is now a stub without logic that hands over to `install.sh` (or `install.ps1`). Agent registrations, saved choices and the release layout carry over, and reinstalling 0.9.7 rolls back. Lock files stay at the paths 0.9.7 uses, as kernel locks of the same kind, so the two releases are meant to exclude each other; on macOS this has not yet been checked against a running 0.9.7.

## Verification

See the status section of [docs/REMOVE-PYTHON.md](../REMOVE-PYTHON.md) for what was verified on which platform.
