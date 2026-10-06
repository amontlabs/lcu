# Development and validation

LCU releases are thin platform/architecture-specific Linux and macOS tarballs. A Windows candidate ZIP can be built separately; Windows remains deferred from the current delivery. The official app is never part of an archive and must already be installed before setup. Local app selection checks official identity/signature where applicable, supported architecture, runtime manifest, required files, and recognized host layout; it records the observed app and runtime versions instead of requiring repository app-version or component-hash allowlists. macOS uses the signed installed app in place. Linux selects an installed app by runtime manifest, architecture and structure, and uses it in place. The URL and checksums in [runtime.lock.json](../runtime.lock.json) are retained for separate development/test package inputs and do not authorize installer downloads. Windows selects the registered official Store app and records a source-derived inventory for its private copy.

## Building from source

Use the [release installation guide](INSTALLATION.md) unless you are changing LCU. Build on the target OS and architecture with Python 3.12+ (the build tools `scripts/build_bundle.py`, `provision_agent_tools.py`, `check_archive.py` and `bundle.py` are the only Python a developer needs to build; installed LCU is Node only) and a Node >= 22 on `PATH` for the archive smoke test (the macOS build uses the app's own Node). The macOS build validates the app by running `lcu/platforms.mjs` on that app's signed Node. macOS also requires a compatible official app, `npm` and `swiftc` (Xcode Command Line Tools), which compiles and ad-hoc signs LCU's own `bin/lcu-owner-auth` helper for [`lcu apps`](INSTALLATION.md#manage-approved-apps); Linux builds provision their own pinned Node dependency. Dependency downloads need network access during the build. The official app is never downloaded by the builder.

Clone the repository and read its version:

~~~sh
git clone https://github.com/amontlabs/lcu.git
cd lcu
LCU_VERSION=$(python3 -c 'from scripts.bundle import VERSION; print(VERSION)')
~~~

On Apple Silicon macOS:

~~~sh
python3 scripts/build_bundle.py --platform darwin --app /Applications/ChatGPT.app --output dist
tar -xzf "dist/lcu-$LCU_VERSION-darwin-arm64.tar.gz" -C dist
cd "dist/lcu-$LCU_VERSION-darwin-arm64"
~~~

On Linux ARM64 or x86-64:

~~~sh
LCU_ARCH=$(python3 -c 'from scripts.bundle import architecture; print(architecture())')
python3 scripts/build_bundle.py --platform linux --output dist
tar -xzf "dist/lcu-$LCU_VERSION-linux-$LCU_ARCH.tar.gz" -C dist
cd "dist/lcu-$LCU_VERSION-linux-$LCU_ARCH"
~~~

From the extracted directory, follow the [macOS](INSTALLATION.md#macos) or [Linux](INSTALLATION.md#linux) installation steps. The source checkout has no sealed bundle manifest and cannot be installed directly. Rebuilding the same version requires a fresh output directory, such as `dist/rebuild-1`; generated archives stay under `dist/` and out of Git.

The builder creates a tarball and SHA-256 sidecar. It provisions the fixed third-party agent registration tools and links their Node executable to the application that setup selects later. It does not download or extract the OpenAI app. Build-time `--package` is retired. Install the official app separately, then pass its installed Linux directory with `--existing-app PATH` only when it is outside `/usr/lib/chatgpt`.

The deferred Windows x64 candidate ZIP is built with `python3 scripts/build_bundle.py --platform windows --output dist`. It contains no OpenAI payload. Direct execution from the protected WindowsApps tree returned Access denied, and the original sandboxed Node REPL could not spawn the native helper directly. The installer stages an intact copy of the registered Store-signed application, records and checks its source-derived inventory, and extracts the required original `Wre` pipe host outside that sandbox. It does not use the inspected package version or component hashes as compatibility gates. Installed candidates in a disposable Windows 11 guest initialized the original MCP, listed a live Notepad window, and saved exact Unicode text to an existing file with an independent byte oracle. A matching Stop and Interrupt each removed the native helper; a stale Stop left a newer turn's helper running, and MCP shutdown removed the final helper. These observations establish installed native action and lifetime behavior, not a Windows Chrome or model-driven task. The [live Windows record](verification/windows-source.md) gives the guest boundaries.

Claude Code registration on Windows does not supply original per-turn cleanup. Its documented [`Stop` hook](https://code.claude.com/docs/en/hooks) excludes user interruption, while `StopFailure` covers API errors and `SessionEnd` fires only when the session ends. Until a supported ordinary-CLI interruption event and matching turn metadata are validated, use Pi or a compatible Codex CLI for Windows native work that needs automatic per-turn helper cleanup; the same recommendation applies to optional Chrome temporary-tab cleanup.

Linux and macOS archives include the same shared MCP SDK client and Pi extension. The macOS archive adds app resolution, signature validation, installation dispatch and native turn-cleanup wiring. Selection reads actual app/runtime metadata and supports the legacy and current recognized Codex tool locations; supported architecture remains Apple Silicon. The builder uses the verified app's Node and the host's npm CLI to install locked registration and adapter dependencies. It does not install or alter the app.

Run adapter checks with `npm test --prefix adapters`. [Mac runtime verification](verification/macos-runtime.md) distinguishes transport/instruction checks from live native control. A sandbox that prevents `codesign` reading signing services or prohibits nested `sandbox-exec` cannot perform those checks; preserve original sandbox settings and run verification in an appropriate host environment.

Before publishing, inspect the tar member list and unpacked tree. They must contain LCU-owned launchers, lock/installer metadata and redistributable registration dependencies only. They must not contain app binaries, upstream instruction copies, generated app fragments, profiles or tokens. Portable exports have the same no-OpenAI-payload requirement.

## Tested version record

[tested-versions.json](../tested-versions.json) lists the app and CUA runtime pairs that checked-in verification covers; [tested app versions](INSTALLATION.md#tested-app-versions) describes how LCU reports it. It is informational and is never used to select or refuse an app. Add an entry only after the pair itself passed: for Linux, `tests/run.sh` against that package on both architectures, with the package's SHA-256 as `app_sha256`; for macOS, the installed-app and desktop checks in the release notes. Set `lcu_version` to the release whose gates covered it, point `evidence` at the release notes or verification record, and never record a pair that only installed. An entry may also list `"native_input": ["gtk4", "qt-scroll"]` for the Linux toolkits whose window-targeted input that exact pair handles natively, which turns off [LCU's input translation](STANDALONE-ADAPTATIONS.md#linux-window-targeted-input-reason-and-removal-criterion) for those toolkits on that pair; add it only after the gates passed with the translation off. `tests/test_tested_versions.py` checks that every entry is well formed, unique and points at an existing file.

## Release severity marker

`lcu update` notices can say how urgent a release is. Add one of these HTML comments to `docs/releases/<version>.md`, on a line of its own:

~~~md
<!-- lcu-severity: security -->
<!-- lcu-severity: breaking -->
~~~

`lcu update --check` and the background refresh fetch that file for the latest release tag and read the marker. The notice is then prefixed "Security update:" or "Breaking update:". The marker must be on a line of its own; a mention inside other text is ignored, so notes can describe the syntax safely. Without a marker, or with any other value, the notice has no prefix. The marker must be in the notes file at the release tag, because that is the copy that is fetched; a later edit on main is not seen for an already tagged release.

## Install and exercise an isolated fixture

Prepare a disposable Ubuntu 24.04-compatible Linux desktop and account. A test may use a verified local official .deb as input, but extract it into the disposable fixture before invoking LCU:

~~~sh
mkdir -p /absolute/test-app-root
dpkg-deb --extract /absolute/chatgpt.deb /absolute/test-app-root
./scripts/install.sh --prefix /absolute/test-prefix --user testuser --skip-system --existing-app /absolute/test-app-root/usr/lib/chatgpt --offline --runtime-only --yes
/absolute/test-prefix/current/bin/lcu doctor
~~~

Root is required only for apt and another account's setup; the target app/REPL must be exercised as that unprivileged desktop account. Use an isolated HOME, CODEX_HOME, X11 session and browser profile. Keep the untouched original package baseline independent of LCU helpers, then compare observable GTK/X11/file/clipboard outcomes. Do not count a matching failure, tools/list, browser inventory or extension discovery as a successful browser action.

Run `tests/run.sh` and focused checks inside disposable containers. Besides the writable-extraction gate (`tests/offline.sh`), it runs `tests/offline-readonly.sh`: the package's app is copied into a Docker volume that is mounted read-only at two `/opt/silo/chatgpt/<version>` folders, LCU is installed with `--existing-app` at the first, the GTK desktop suite runs as the target account, and a reinstall at the second path must follow it. The volume is removed afterward. For focused checks during implementation, run these in the container:

~~~sh
python3 -m unittest discover -b -s tests -p 'test_*.py'
tests/node/run-all.sh
npm test --prefix adapters
~~~

`-b` buffers setup output from passing tests and shows it only for failures. Narrow `-p` to one file, such as `test_bundle.py`, while iterating. The runtime's own tests are Node tests: `tests/node/run-all.sh` runs every `tests/node/*.test.mjs` on the Node on `PATH` and on the ChatGPT app's Node. Python tests remain for the build tools, the Windows install bridge and the trampolines. The differential tests that compare a Node module with the Python implementation it replaced (`tests/compat`, parts of `tests/node`) load that implementation from a frozen oracle tree: the commit named in `tests/blackbox/BASE`, which `tests/blackbox/oracle.py` extracts from the repository history (the Docker runners mount it at `/oracle`; `LCU_ORACLE_ROOT` overrides it). Those differentials expect CPython 3.12.10 and say so when `python3` is another version. `tests/blackbox/docker.sh` and `tests/blackbox/docker.sh --root` run the black-box harness (see `tests/blackbox/README.md`); `tests/compat/docker.sh` runs the Linux compatibility differentials. On the macOS host, `tests/blackbox/run.py` needs the test-only overlay `tests/node/blackbox_overlay.sh` for the tree under test, because the fake app's `node` is unsigned and the launcher's pre-Node check refuses it; the check itself is covered by `tests/node/entry.test.mjs` against the real signed app Node.

GitHub Actions (`.github/workflows/ci.yml`) runs, for every push and pull request: the Python unit tests (Python 3.12 on Linux and macOS with the whole suite including the `tests/compat` differentials, which compare against the frozen 0.9.4 oracle and so check out the full history; Python 3.14 and Windows run the build-tool tests only), `tests/node/run-all.sh` on Linux and macOS with the Node that `actions/setup-node` installs (CI has no ChatGPT app, so only the `PATH` Node is used: `LCU_TEST_NODES` pins it, and tests that need the app, bubblewrap or root skip themselves), the same suite on Node 22 (the supported floor), the black-box differential (`tests/blackbox/docker.sh --runs 2` and `--root --runs 2`, oracle against this tree), the Windows build and fixture tests (the Node suite there is advisory until it has a recorded green run), bug-class lint with a syntax check of every `.mjs`/`.cjs`, and `scripts/check_archive.py` on freshly built Linux and Windows archives. On Windows, tests of POSIX-only targets (Linux and macOS installers and layouts, fcntl locks, mode bits, Unix sockets) skip themselves; Windows tests are not live Windows desktop evidence. `tests/run.sh` runs natively on amd64 and arm64 for pull requests to main and nightly (`.github/workflows/linux-gate.yml`); its `.verification/` output holds official app files and is never uploaded. CI does not replace real macOS or Windows desktop evidence.

The developer and live-acceptance drivers under `tests/` (`codex_*`, `claude_*`, `hermes_*`, `omp_*`, `macos_*`, `browser_runtime.py`, ...) stay Python. They run LCU through its real entry points (`bin/lcu`, `scripts/install.sh`) as subprocesses; where one used to import a runtime function (`configure_omp`, `locate_codex_tools`, `install_hooks`, the Codex app-server client, ...) it calls the same function of `lcu/*.mjs` through `tests/lcu_bridge.py` / `tests/lcu_bridge.mjs` (one Node process per call, or a persistent session for the app-server). The bridge uses `$LCU_BRIDGE_ROOT` (a source tree or an installed release; default: this repository) and `$LCU_TEST_NODE`, else `<root>/agent-tools/node/bin/node`, else the `node` on `PATH`.

The final gate must test both architectures, mark emulation explicitly, and run native and Chrome actions under a normal Ubuntu host policy outside a privileged container. Inspect the actual process confinement labels and policy denials; the ChatGPT Electron profile is not a prerequisite for LCU's direct Node/REPL path. The [ARM64 and x86-64 Ubuntu AppArmor host runs](verification/installed-app-2026-09-23.md) passed native use and no-sign-in Chrome actions with actual process labels. The x86-64 guest used KVM on physical AMD hardware. Docker fixtures alone prove bounded native behavior and offline failure paths, not host OS confinement.

`tests/node/sandbox_shim.test.mjs` covers the Linux sandbox launcher's recognition rules. On a Linux host where bubblewrap works, `LCU_TEST_SANDBOX_SHIM_FAULT=unrecognized-kernel`, `unrecognized-worker` or `unrecognized-format` makes the launcher see that invocation in a format it does not recognise; it can only make the launcher refuse (exit 70), never run something unsandboxed, and is for checking that a refusal leaves nothing running. LCU never sets it. The [kernel sandbox record](verification/linux-kernel-sandbox-2026-10-05.md) shows its use.

`tests/node/approval.test.mjs` covers the approval-mode entries for every harness, including OMP against the real `omp config` when OMP is installed. `tests/codex_approval_mode.py --cli PATH` drives a Codex CLI with a scripted local provider and compares `ask` and `auto` registration; it needs Node and `npm ci --prefix adapters`, and is not part of `tests/run.sh`.

Chrome verification uses the original MCP → browser service → LCU relay → original native host → extension chain and an isolated Chrome profile. The target path must complete navigation, input, click, screenshot and lifecycle without Codex sign-in, and the fixture server must observe `x-browser-agent` on the requests. The original browser also requests scoped MCP site approval; a test client may approve its own disposable localhost fixture, but must not synthesize a broader grant. Never copy a personal credential store. The [current status](PARITY-STATUS.md) distinguishes this local policy override from the original Codex account policy.

Historical IAB fixture and full-copy bundle evidence predates this migration. [Verification](VERIFICATION.md) and [current status](PARITY-STATUS.md) separate those results from final thin-artifact claims.
