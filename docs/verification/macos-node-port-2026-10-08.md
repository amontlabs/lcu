# macOS Node port check on the user's Mac, 2026-10-08

Live check of PR #31 (LCU 0.10.0, Python removed) against LCU 0.9.7. At the user's request it ran on the user's
own Mac, not the task-owned guest, with every LCU write confined to scratch directories under `/private/tmp`.
**Result: install, `--version`/`status`/`doctor`, setup isolation, MCP launch through both registrations,
shutdown, the 0.9.7 → 0.10.0 upgrade with rollback, and the setup lock passed. The TextEdit action (screenshot,
Unicode typing, save, `xxd`) was not run: in a scratch HOME no app is approved, and approving one needs the
user (see [Not verified](#not-verified)).** No Python ran in any step that used the new build.

## Isolation incident and the HOME fix

An earlier attempt the same day ran `env -i HOME=<scratch> <prefix>/bin/lcu setup --agent codex|claude-code --yes`
and expected isolation. Setup took the account's home from the user database (`os.userInfo().homedir`), not
`HOME`, so it rewrote the real `~/.codex/config.toml`, `~/.claude.json`, `~/.claude/skills/lcu-approve` and
`~/.local/state/lcu/setup.json`. The user restored them (LCU 0.9.5). The default prefix, `lcu status`,
`lcu update` and the agents themselves already followed `HOME`, so LCU disagreed with itself.

Commit `5507f1f` (`fix(setup): target $HOME for non-root runs`): without `--user`, setup, the installer's setup
step, `lcu status` and `lcu update` (including its refresh of the Claude Code mod) use `$HOME` when it is an
absolute, existing directory owned by the caller with no symbolic link on its path. Otherwise they use the
user database home. Root and `--user` are unchanged (root must still pass `--user`). The installer now forwards
`--user` only when it was given; before, it always forwarded the caller's name, which would also have selected
the user database home. A failed setup's retry command names `--user` only when the caller did. Unit tests:
`tests/node/fsutil.test.mjs` (HOME honoured; unset, empty, relative, missing, linked, linked parent, `..`,
control character and another owner's HOME fall back; root ignores HOME) and two tests in
`tests/node/setup.test.mjs`.

Commit `0e47a2e` (`fix(setup): warn when a macos home is not the account home`) follows from step 3 below.

## Host and app

| Item | Value |
| --- | --- |
| Machine | User's Mac, macOS 26.5 (25F71), arm64 |
| ChatGPT.app | 26.930.61225 (build 13232), signed `com.openai.codex`, team 2DC432GLL2 |
| CUA runtime | 0.0.27/20260927214556-b77d38801cca |
| Node (recorded `node-path`) | `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`, v24.21.0 |
| Tested pair | No. `tested-versions.json` lists 26.917.62051 (CUA 0.0.16) and 26.928.20755 with this runtime; informational only |
| New archive | `lcu-0.10.0-darwin-arm64.tar.gz` built by `scripts/build_bundle.py --platform darwin --app /Applications/ChatGPT.app` at `5507f1f`, SHA-256 `a3a6f2e7…5695a6`; rebuilt at `0e47a2e` (`49ab05d2…e0a1fb`) for the warning check. `check_archive.py`: ok |
| Old archive | `lcu-0.9.7-darwin-arm64.tar.gz`, SHA-256 `5078fb7e…312b6f4a`, matching `docs/releases/0.9.7.md` |
| Clients present | Codex CLI 0.160.0, Claude Code 2.1.204 |

## Safety guard

Before any install, setup, update or lock run, a script recorded SHA-256 and mtime of the real
`~/.codex/config.toml`, `~/.codex/hooks.json` and `hooks/`, `~/.claude/settings.json`,
`~/.claude/skills/lcu-approve/**`, `~/.local/state/lcu/**`, `~/.local/share/lcu` (three levels),
`~/.omp/agent/config.yml` and its MCP and extension entries, `~/.local/bin/lcu*`, the approved-app list
(`~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/…/ComputerUseAppApprovals.json`) and a hash
of the MCP server entries in `~/.claude.json` (the whole file changes with every Claude Code session). It was
re-checked after every step and after cleanup: **no change at any point**.

Every new-build step ran with `env -i`, a scratch `HOME` and `PATH=<stubs>:/usr/bin:/bin:/usr/sbin:/sbin`, where
`<stubs>` held `python` and `python3` scripts that log argv, ppid, cwd and time and exit 127. **Their log stayed
empty for every new-build step.** It got one line once, when the new build's setup was pointed at a 0.9.7
prefix and ran 0.9.7's own Python launcher (`prefixU/current/bin/lcu --version`); that run was repeated with
Python on `PATH` and is not a new-build call.

## Steps

| Step | Result | Evidence |
| --- | --- | --- |
| 1. Build and install | Pass | `install.sh --prefix <A> --runtime-only --yes`: `lcu 0.10.0 (ChatGPT darwin 26.930.61225; CUA 0.0.27/…)`; stub log empty |
| 2. `--version`, `status`, `doctor`; startup | Pass | All exit 0; diagnostic log under the scratch HOME; table below |
| 3. Setup isolation | Pass | Configs only in the scratch homes; guard unchanged |
| 3. MCP launch through each registration | Pass (minimal client) | `cua.getState()` lists running apps through both the Codex and the Claude Code registration |
| 3. TextEdit: screenshot, Unicode, save, `xxd` | **Not run** | `Computer Use was not approved to use TextEdit` |
| 4. SIGINT, SIGTERM, SIGKILL | Pass for Codex; Claude Code drains in about 22 s, as 0.9.7 does | ps output below |
| 5. 0.9.7 `lcu update` → new, rollback | Pass, with the registration caveat below | |
| 6. Setup lock | Pass, with 0.9.7's lock code instead of a full 0.9.7 `lcu setup` | |

### Startup (step 2)

`/private/tmp/…/tools/timing.mjs`: one warm-up, then 21 runs per side, alternating order, `env -i` with a scratch
HOME; the new build with the Python stubs, 0.9.7 with Python 3.12 on `PATH`.

| Command | 0.10.0 median | 0.9.7 median | 0.10.0 min | 0.9.7 min |
| --- | --- | --- | --- | --- |
| `lcu --version` | 692 ms | 710 ms | 675 ms | 690 ms |
| `lcu status` | 710 ms | 750 ms | 701 ms | 739 ms |
| `lcu doctor` | 758 ms | 795 ms | 741 ms | 767 ms |

The previous run measured 688/703, 705/743 and 748/784 ms. Both versions spend most of this time in the app's
signature checks.

### Setup into a scratch HOME (step 3)

~~~sh
env -i HOME=<W>/homeCodex  PATH=<stubs>:… <A>/current/bin/lcu setup --prefix <A> --agent codex       --yes --no-chrome
env -i HOME=<W>/homeClaude PATH=<stubs>:… <A>/current/bin/lcu setup --prefix <A> --agent claude-code --yes --no-chrome
~~~

Both exited 0. Files written: `homeCodex/.codex/config.toml` (`[mcp_servers.lcu]` running
`<A>/current/agent-tools/node/bin/node <A>/current/adapters/codex.mjs <A>/current/bin/lcu`, the
Stop/Interrupt/SubagentStop `turn_ended` hooks with their trust state, the update-notice hooks) and
`homeCodex/.local/state/lcu/{setup.json,setup.lock}`; `homeClaude/.claude.json` (`mcpServers.lcu`, same shape with
`adapters/claude.mjs`), `homeClaude/.claude/settings.json` (deny list and the `set_turn_context`/`turn_ended`
hooks), `homeClaude/.claude/skills/lcu-approve/**`, and `homeClaude/.local/state/lcu/*`. Guard: unchanged.
`install.sh --prefix <A2> --agent codex` from the rebuilt archive also wrote only into its scratch HOME.

**Client authentication.** `codex login status` and `claude auth status` in the scratch homes report not
logged in, and no credentials were copied. So both actions used a **minimal MCP client, not Codex or Claude
Code**: a Node script using the official MCP SDK (1.30.0, the copy vendored in `adapters/node_modules`) that reads
the registered command from the scratch `config.toml` or `.claude.json` and starts it with the scratch HOME. For
Claude Code it also sends what the registered hooks send: `set_turn_context` before each `js` call (with the
`claudecode/toolUseId` `_meta`) and `turn_ended` Stop at the end.

**The helper socket follows HOME.** With only the scratch HOME, `cua.getState()` returned
`{"apps":[],"browsers":[],"errors":["Native apps: Error: Sky Computer Use native pipe startup failed"]}`
through both registrations. The original client builds the helper's socket path from `HOME`
(`~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock`), and the running helper
listens under the real home. The attempt also started a second `SkyComputerUseService` (pid 46969, from the app
bundle, parent launchd); it exited on its own within 9 minutes and was not signalled. With
`SKY_CUA_SERVICE_NATIVE_PIPE_PATH` set to the real socket in the server environment, `cua.getState()` listed the
running apps through both registrations. Because setup now honours `HOME`, setup on macOS warns when the home it
configured is not the account's home folder (commit `0e47a2e`, rebuilt archive):

~~~
Warning: setup configured the agents in /private/tmp/lcunp.CZBu/homeW, not in this account's home folder
/Users/polarzero. The original Computer Use client finds the ChatGPT helper from HOME, so an agent started with
this HOME cannot reach it ('native pipe startup failed') unless SKY_CUA_SERVICE_NATIVE_PIPE_PATH names the
helper's socket.
~~~

**TextEdit.** `let app = await cua.getApp("TextEdit");` returned `Computer Use was not approved to use TextEdit`
through both registrations. The original client reads its approved-app list from `HOME` too, and the scratch
homes have none. The minimal client advertises no elicitation, so no approval panel appeared; none was answered
and no approval file was edited. Without an approved app there is no app to screenshot either. The sub-step
stopped here.

### Shutdown (step 4)

Each run: `cua.getState()`, then a `js` call that waits 60 s; 6 s in, the client got the signal; `ps` 5 s later.

| Client | SIGINT | SIGTERM | SIGKILL |
| --- | --- | --- | --- |
| Codex registration | 0 left | 0 left | 0 left |
| Claude Code registration | relay and tree left at 5 s | same | same |

Before the signal, each run had 7 processes: the client; `adapters/{codex,claude}.mjs`; `lcu/runtime.mjs` on the
app's Node; two `codex sandbox` processes; the original `kernel.js` and `trusted-worker.js`. For Claude Code,
`adapters/claude.mjs` was re-parented to launchd and its tree stayed until the in-flight call's turn cleanup
ended. Polling every 0.5 s, the last process exited **22.0 s** after SIGKILL and 22.0 s after SIGTERM with the new
build, and **22.0 s** and 21.5 s with 0.9.7. The relay is the same file in both releases. On stdin EOF it
sends Interrupt cleanup for active turns before closing upstream, bounded by the 20 s cleanup step
(`CLEANUP_STEP_HARD_TIMEOUT_MS`). With no call in flight, SIGKILL and SIGTERM left nothing behind for either
registration (0 processes at the first poll). This is not a port regression; whether the relay should cut the
drain shorter is a separate question. Example `ps` 5 s after SIGKILL of the Claude Code client:

~~~
51444     1 …/prefixA/current/agent-tools/node/bin/node …/adapters/claude.mjs …/bin/lcu
51445 51444 /Applications/ChatGPT.app/…/cua_node/bin/node …/prefixA/current/bin/../lcu/runtime.mjs
51466 51451 …/CodexCLI.app/Contents/MacOS/codex sandbox …
51467 51451 …/CodexCLI.app/Contents/MacOS/codex sandbox …
51482 51467 …/cua_node/bin/node --experimental-vm-modules /private/tmp/.tmpt5EpBM/trusted-worker.js …
51483 51466 …/cua_node/bin/node --experimental-vm-modules /private/tmp/.tmpt5EpBM/kernel.js …
~~~

Two artefacts of the minimal client: closing it right after `turn_ended` stops the server while the original
`turn-ended` command runs (`exit=SIGKILL elapsed=5 ms`); waiting 1.5–3 s before closing avoids it. Reusing a
turn id after its `turn_ended` gives `Computer Use is unavailable because the current turn ended`. Real clients
keep the server between turns and use new turn ids.

### Upgrade and rollback (step 5)

1. 0.9.7 `install.sh --prefix <U> --runtime-only` with HOME `<W>/homeU`.
2. Registrations for Codex and Claude Code in `homeU` pointing at `<U>/current`. **These were written by the new
   build's setup (`<A>/current/bin/lcu setup --prefix <U>`), not by 0.9.7's:** 0.9.7's setup takes the home from
   the user database and cannot be pointed at a scratch home on this account. Both launched 0.9.7 and listed apps.
3. 0.9.7's own `lcu update` through `UPDATE_DRIVER` from `tests/e2e/e2e.py` (its downloads redirected to the local
   archive and its `.sha256`), `python3 -I` with the stubs on `PATH`: exit 0, `LCU update: 0.9.7 -> 0.10.0`, the
   new installer's output, `Refreshed the Claude Code lcu-approve mod at <W>/homeU/.claude/skills/lcu-approve`.
   `current` → `releases/0.10.0-ead33c7c36a3`; the 0.9.7 release stayed. Stub log empty.
4. After the update, with the stubs: `--version` (`lcu 0.10.0`), `status`, `doctor` exit 0, and both
   registrations started the Node runtime and listed apps.
5. Rollback by reinstalling 0.9.7 runtime-only: `current` → `releases/0.9.7-472a9dc7f2d5`; `lcu --version`
   `0.9.7`, `status`, and both registrations listed apps again.

Guard: unchanged after each step. Without the HOME fix, step 3 would have refreshed the real home's mod.

### Setup lock (step 6)

All in `<W>/homeL`. A full 0.9.7 `lcu setup` cannot be isolated (it uses the user database home), so the 0.9.7
side used 0.9.7's own `lcu.setup.setup_lock` (`fcntl.flock`) imported from its installed release.

| Holder | Waiter | While held | After `kill -9` of the holder |
| --- | --- | --- | --- |
| 0.9.7 `setup_lock` | new `lcu setup --agent codex` | still running at 8 s, printed `LCU: waiting for another LCU process to release …/setup.lock...`, no config written; `lsof`: only the Python holder | setup finished, exit 0, 9 s in total; config written |
| new `setupLock` (`O_EXLOCK`) | 0.9.7 `setup_lock` | blocked at 5 s; `lsof`: both descriptors | acquired after 5.1 s |
| new `setupLock` | new `lcu setup --agent claude-code` | blocked at 6 s, same waiting message | exit 0, 7 s in total; config written |

## Not verified

- **The TextEdit action** (screenshot, typing `Héllo wörld — 日本語 🚀`, saving as plain text, `xxd`). In a
  scratch HOME no app is approved. The approval prompt needs a real client with the user present, and adding the
  app needs the user's authentication. To run it, after recreating a scratch home and prefix as above:

  ~~~sh
  HOME=<scratch home> <prefix>/current/bin/lcu apps allow TextEdit
  ~~~

  This asks for Touch ID or the password and writes only the scratch home's approved-app list. The agent then also
  needs `SKY_CUA_SERVICE_NATIVE_PIPE_PATH` set to the real helper socket, because the scratch HOME hides it.
- **A real Codex or Claude Code session.** Neither is logged in in a scratch home, and credentials were not
  copied. The minimal client above stood in for both.
- **0.9.7's own `lcu setup`** (for the upgrade's starting registrations and the lock test). It writes the user
  database home, so it needs a throwaway macOS account.
