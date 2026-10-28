# Claude lifecycle hooks without a relay, 2026-10-28

Issue: [amontlabs/lcu#64](https://github.com/amontlabs/lcu/issues/64). This fixes disconnected lifecycle hook errors;
it does not establish a cause or fix for the separately reported 30-second upstream startup failure.

## Primary sources and adaptations

- [Claude hooks reference](https://code.claude.com/docs/en/hooks#command-hook-fields): `args` selects direct exec
  form on every platform. It avoids shell quoting and a shell parent between Claude and the helper. PreToolUse
  finishes before tool execution. Command hooks receive hook JSON on stdin; synchronous command hooks default to
  600 seconds. LCU sets that timeout explicitly and prints nothing on success or missing/refused relay routes.
- [Claude environment reference](https://code.claude.com/docs/en/env-vars): the MCP process's
  `CLAUDE_CODE_SESSION_ID` stays at its spawn value across `/clear` and some resume paths. Route by the direct host
  parent, carrying the hook's current session/prompt/tool-use/agent identities in each request.
- [Node 22 IPC reference](https://nodejs.org/docs/latest-v22.x/api/net.html#ipc-support): Unix sockets have short
  path limits and survive crashes; Windows named pipes have a different namespace and OS-managed lifetime.
  LCU uses short account-private `/tmp` directories on POSIX, and random named pipes on Windows. Registrations
  contain a random token, protocol and relay generation, and are published by atomic rename after readiness.
  Windows registration directories receive an explicit current-account-only inheritable ACL from PowerShell
  in the relay, using Microsoft’s [Set-Acl](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-acl?view=powershell-5.1)
  and [FileSystemAccessRule](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.filesystemaccessrule.-ctor?view=netframework-4.8.1)
  APIs and checking the resulting ACL; the helper never spawns a process. Neither plain chmod nor this macOS run proves Windows ACLs.

The helper bounds stdin at 16 MiB and sends only lifecycle identities, with a 64 KiB IPC limit; long assistant
messages and tool inputs are not forwarded. `lcu/claude_hook.mjs` is a self-contained script importing only Node
builtins. Setup and update refresh copy it intact to `~/.local/share/lcu/claude/claude-hook.mjs`, or
`<home>\AppData\Local\LCU\claude\claude-hook.mjs` on Windows. It runs directly on the recorded app Node.
Rollback and release pruning cannot remove that copy. An older relay without lifecycle IPC produces a quiet
no-op; rerunning older setup restores its MCP lifecycle hooks. Windows app-generation pruning can still remove
the recorded Node executable, so refresh setup before pruning after an app selection change.

The existing MCP SDK transport, tool schemas, instructions, caller policy and original upstream remain unchanged.
Only lifecycle IPC is added; bind and cleanup share the relay's existing handlers and maps. Connection/probe
budgets are absolute 400 ms deadlines; accepted cleanup has 590 seconds inside the 600-second hook budget, and
upstream cleanup retains its 120-second per-call timeout. A helper disconnect never cancels cleanup.

Linux additionally verifies `/proc` parent creation identity. Each relay checks its current parent and generation
on requests; other platforms have no independently sampled parent creation time. Windows PID-reuse behavior and
parentage still require native verification. PID liveness only filters candidates. The helper probes every
candidate concurrently using its token and generation; only authenticated ready endpoints count toward ambiguity.
Unreachable, refused and unresponsive endpoints cannot disable a healthy relay, even if a stale registration's
PID belongs to an unrelated live process. Two authenticated ready endpoints for one parent still fail closed.
Probes perform no bind or cleanup. Helpers never remove registration files; shutdown removes only its own generation.

Git history (`3933e94`, `c3bafd7`, `fe364a9`) confirms the exact published MCP bind/Stop/Interrupt templates and the
later SubagentStop template. Migration matches those handlers and matchers exactly, preserving foreign handlers,
extra fields and other settings. Updates refresh an existing account-data helper independently of user-hook
ownership, including project-only installs, and migrate existing owned user hooks. Project scopes lack receipts, so
one re-setup at each project scope migrates them; no new receipt subsystem was introduced for this fix.

## Verification

The original failing-first commit `b03e96b` established three expected failures:

- Generated PreToolUse hooks had type `mcp_tool` instead of `command`.
- Re-setup retained one legacy lifecycle handler instead of removing it.
- The absent helper exited 1 instead of exiting 0 quietly.

The machine-specific stack dump was removed after review. The original whitespace check covered only the working
diff, so it did not establish that `git diff --check main..HEAD` passed. Follow-up verification checks the full
branch range.

Node tests cover exact migration/idempotence and update refresh, private endpoint
validation, wrong capability/generation/route, stale and ambiguous registration, and ownership during shutdown.
Official-SDK adapter fixtures cover acknowledged binding before js, exact current metadata, all cleanup events,
deduplication, slow accepted cleanup and failure reporting, and two concurrent Claude parents sharing one account
and identical session/prompt/tool-use ids. Review regressions also cover a stale registration with a reused live
PID beside a healthy relay, refused/unresponsive probes, and a standalone helper copied away from a pruned release.
A child-process preload makes attempted helper subprocesses fail.

Live CLI: Claude Code **2.1.311**, macOS arm64, local scripted `tests/claude_fake_api.mjs`, dummy API key, disposable
HOME/config/cwd, no model inference, persistence, browser or desktop. Generated hooks came from the actual installer.
The live reproduction uses generated settings and the installed account-data helper, with no user configuration
loaded. Re-run it explicitly:

```sh
LCU_CLAUDE_LIVE_TEST=1 node tests/claude_hooks.mjs /absolute/path/to/claude
```

- Absent relay (`/usr/bin/false` MCP): CLI exit 0, Stop hook exit 0, empty stdout/stderr, zero `stop-hook-error`.
- Connected real relay, fake original upstream: PreToolUse and Stop exit 0 with empty streams. Upstream receives
  `js` with the current session, prompt and tool-use ids; Stop receives exactly the same session/turn pair.

No new Windows live verification or original-host desktop integration is claimed. The task-owned macOS guest
was not exercised. Docker is installed but its daemon is unavailable, so `tests/run.sh` and Linux E2E remain CI
checks. The E2E comparator accepts only exact legacy-to-command handler replacements in the known settings paths;
its regression tests reject altered timeouts, paths, foreign handlers, and helper copies with different bytes or
permissions. Upgrade and rollback comparisons check the retained helper against the new release source. Archive
tests include both helper modules.

Initial implementation checks passed on the tested macOS host, but did not expose stale PID reuse or a missing
helper after rollback. Review follow-up adds failing-first regressions for both and reruns the full suites with
240-second bounds and disposable homes. Follow-up results on the same macOS host:

- `env -u CLAUDE_CONFIG_DIR node --test tests/node/*.test.mjs`: 468 pass, 39 platform skips, no failures (16 s).
- `env -u CLAUDE_CONFIG_DIR node --test adapters/test/*.test.mjs`: 237 pass, 8 opt-in/platform skips, no failures (132 s).
- `python3 -m unittest discover -b -s tests -p 'test_*.py'`: 45 pass, including archive and E2E expectation tests (18 s).
- Focused Claude/setup/update tests on Node 22.22.2: 88 pass. Syntax checks cover all 13 changed/new Node modules.
- The live CLI reproduction against the regenerated hooks and account-data helper passes both absent and
  connected fixture cases (3 s), with zero Stop-hook errors and empty successful hook streams.
- `git diff --check main..HEAD`: pass after removing the stack dump; this supersedes the earlier limited check.


## Installation follow-up

Failing-first regressions reproduced permissive installation under umask `000`, refresh retaining a `0666`
helper with unchanged bytes, and a project-only helper remaining stale after post-install. Setup now repairs
only the POSIX LCU-owned `lcu` and `claude` directories to `0700` and uses the existing private atomic writer
(synced temporary file, explicit `0600`, rename) for helper installation and permission repair. Existing
`.local/share` and `AppData/Local` parents are not chmodded. Windows retains LCU's normal AppData file-writing
behavior; no new Windows ACL guarantee is claimed.

Post-install refreshes an existing helper before checking user-hook ownership. Regression coverage confirms that
project settings remain byte-identical, absent user settings remain absent, and foreign user hooks remain intact.
Project hook migration still requires re-setup; updating their shared helper does not.


Installation follow-up checks used disposable homes and 240-second suite limits:

- Full Node suite: 471 pass, 39 platform skips, no failures (16 s).
- Full adapter suite: 237 pass, 8 opt-in/platform skips, no failures (132 s).
- Build tooling and E2E expectation unittests: 45 pass (18 s).
- Focused Claude/update/private-writer tests on Node 22.22.2: 53 pass.
- Live CLI fixture checks: absent and connected relay cases pass (3 s).
- Syntax checks on the 13 changed/new Node modules and `git diff --check main..HEAD`: pass.

These checks add no native Windows or original-host desktop verification.

## PR 66 CI follow-up

The failed Windows adapter job reported `Get-Acl` module autoload failure, not an ACL rule mutation error.
Microsoft's [PSModulePath reference](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath#starting-windows-powershell-from-powershell-7)
documents this exact launch chain: PowerShell 7 starts an intermediate process (here Node), which passes PS7
module paths to Windows PowerShell. Unlike a direct launch from PS7, this retains incompatible modules.
The ACL subprocess now removes only its own inherited `PSModulePath`, case-insensitively, so Windows PowerShell
constructs its default paths. A Windows-only regression supplies an incompatible security module and requires
the real ACL setup to succeed without loading it. ACL protection and verification remain required before
publishing a registration; failure does not publish an insecure endpoint.

The Windows Node 22 failure in the transport-refusal test was `spawnSync powershell.exe ETIMEDOUT` during ACL
setup at 10 seconds, before any named-pipe request. The earlier follow-up raised the subprocess timeout to
30 seconds for cold Windows PowerShell startup.
That change left the synchronous event-loop stall in place; the Windows startup follow-up below supersedes it.
The transport assertions remain enabled.

Lifecycle setup errors now emit `lifecycle_listen` with `ok: false` through the relay's existing diagnostic
logger and leave MCP connected. A blocked registry directory reproduced `MCP error -32000: Connection closed`
before the change. The same regression now checks original tool descriptors, instructions, correlated tool
execution, caller policy preservation, and a silent absent-route hook. Listener publication failure also
destroys any sockets opened before failure.

Both Linux registration jobs still read the removed `server`, `tool`, and `input` fields. The container
registration check now verifies the exact exec-form command, installed Node, helper bytes and private mode
for all four events in both user and project settings. Searches found no other stale lifecycle shape
assertions in the container scripts; the E2E fixtures retain legacy handlers deliberately for migration checks.

Both upgrade E2E jobs differed only on the four migrated lifecycle handlers, after update and after rollback.
The existing comparator expected the fake app's shell wrapper as the command. Post-install observes the exact
real Node executable that wrapper execs as `process.execPath`. Upgrade comparisons now pass that fixture Node
to the existing exact handler expectations; setup comparisons retain the app wrapper expectation. Runtime-only
rollback intentionally retains the refreshed helper and command hooks. Regression checks still reject a
different Node, helper path, timeout, handler position, or foreign MCP hook.

Local checks on macOS arm64, Node 24.11.1, with `CLAUDE_CONFIG_DIR` unset and disposable suite homes:

- Full Node suite: 471 pass, 40 platform skips, no failures (14 s). The new native Windows ACL check is one skip.
- Full adapter suite via `npm test --prefix adapters`: 238 pass, 8 opt-in/platform skips, no failures (132 s).
- `python3 -I -m unittest discover -b -s tests -p 'test_*.py'`: 45 pass (15 s).
- Changed Node and Python files parse; `git diff --check main..HEAD` and the uncommitted diff pass.

The first adapter invocation hit filesystem denials because existing Pi fixtures create temporary directories
under `HOME`; the complete rerun used a disposable home. Docker's daemon is unavailable, so Linux container
registration and upgrade gates remain CI checks. These results add no native Windows or desktop verification.


## Windows relay startup follow-up (superseded readiness behavior)

CI run `40608137067`, job `Build tooling and adapters (windows-latest)`, confirms the startup regression:
Claude relay tests repeatedly took 24–49 seconds, the host-loss test failed its five-second wait for tool
execution, and the job exhausted its 20-minute budget. `listenLifecycle` called `execFileSync` after the MCP
transport connected. Cold PowerShell startup blocked the same event loop that serves MCP and notices stdin
EOF. Raising the timeout allowed a longer freeze; it did not solve the failure.

The ACL runner now uses asynchronous `execFile`, retains its 30-second timeout, and receives the relay's
shutdown `AbortSignal`. MCP serves while ACL setup runs. Shutdown, stdin EOF, and bridge startup failure
abort the child. The listener checks cancellation after ACL success and after socket/pipe binding, before
writing a registration. ACL errors retain the existing non-fatal `lifecycle_listen` diagnostic with
`ok: false`; no lifecycle endpoint is published. The PSModulePath filtering and account-only inheritable
ACL rules remain in place. Paths are checked again after the asynchronous ACL step.

We retain ACL hardening and verification on each Windows relay start. A first-use marker would trust an ACL
that can change later, and moving under AppData would merely assume the parent's current permissions.
Node's filesystem API does not inspect Windows DACLs. Checking the actual ACL still requires a Windows
process; retaining the existing script adds less state than a setup cache and a separate verification path.
The directory remains account-private before any registration token is written. PowerShell startup can
still delay optional lifecycle availability for up to the bounded timeout; it no longer delays MCP or shutdown.

Primary-source evidence:

- [Node child-process documentation](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback)
  documents asynchronous `execFile`, its timeout and AbortSignal options, and the event-loop blocking behavior
  of `execFileSync`. AbortSignal support predates the minimum supported Node 22 version.
- [Microsoft Set-Acl documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-acl?view=powershell-5.1)
  describes applying security descriptors and disabling inherited access rules. The existing script continues
  to remove inherited/explicit rules, grant only the current SID inheritable full control, and verify the result.

Regression coverage injects an execFile-compatible ACL runner on POSIX and Windows. Its real child stays
alive indefinitely, so the test proves MCP descriptors, correlated tool execution, policy forwarding and ping
complete while ACL setup is still pending. Closing MCP must kill that child and close the original server
within three seconds without publishing. The original host-loss test retains its five-second execution-start
bound and its existing shutdown bound; an additional case holds ACL setup open while an in-flight tool and
its cleanup ignore cancellation. Listener tests cover publication only after success, failure without IPC,
and a successful ACL callback racing with cancellation. IPC routing fixtures now wait explicitly for lifecycle
publication rather than treating MCP initialization as proof of ACL readiness.

Local validation on macOS arm64 used disposable homes, unset `CLAUDE_CONFIG_DIR`, and 240-second suite limits:

- Full Node suite on Node 24.11.1: 473 pass, 40 platform skips, no failures (16 s).
- Full adapter suite on Node 24.11.1, including its diagnostic-log preload: 240 pass, 8 opt-in/platform skips,
  no failures (133 s).
- `python3 -I -m unittest discover -b -s tests -p 'test_*.py'`: 45 pass (18 s).
- Claude adapter and lifecycle listener suites on Node 22.22.2: 72 pass, one native Windows skip (32 s).
- In the full adapter run, normal host-loss shutdown took 2.22 s and the slow-ACL variant took 2.21 s.
  The MCP-serving/ACL-child cancellation regression took 0.27 s. A blocking mutation that inserted a
  seven-second synchronous child call failed the regression at its three-second MCP initialization timeout;
  restoring the asynchronous runner passed it.
- The routing fixture's final cleanup passed its focused Node 22 rerun. Changed modules parse, and
  `git diff --check main..HEAD` passes.

These checks add no native Windows ACL, named-pipe, or original-host desktop verification; Windows CI must
exercise the real PowerShell path.


## PR 66 lifecycle readiness regression

The asynchronous ACL fix removed event-loop blocking but advertised MCP tools before command hooks could
bind them. The earlier slow-ACL test used the legacy `set_turn_context` MCP seam, so it missed that the real
exec helper silently found no endpoint. Its MCP-serving assertions above do not establish usable exec hooks.

Lifecycle setup now starts concurrently with `openUpstream` (including its `listTools`). Before connecting
the downstream SDK transport, the relay waits for lifecycle publication, capped at two additional seconds
after upstream readiness. This overlaps ordinary original-host startup with cold PowerShell startup and
avoids spending the full 30-second ACL timeout on Claude's connection budget. Claude's official
[environment reference](https://code.claude.com/docs/en/env-vars) documents the 30,000 ms `MCP_TIMEOUT` default.
This changes only relay startup wiring; it does not bound or fix the separately reported upstream startup delay.
The official SDK 1.30.0's installed `server/stdio.js` starts reading MCP requests in `start()`, which `server.connect`
invokes; delaying that call prevents tool discovery and calls during the readiness wait.

A failure or exhausted startup cap still connects MCP for diagnosis. Missing-identity refusals for both `js`
and `js_reset` say `LCU's lifecycle channel failed to start (<reason>)`. `lifecycle_listen` failure events
and `identity_refused` events record fixed categories, never paths, hook identities, or subprocess stderr:
`registry_unavailable`, `acl_failed`, `acl_timeout`, `listen_failed`, `publication_failed`, or
`startup_timeout` (with `listener_failed` as a defensive fallback). A healthy channel's unbound call retains
the ordinary missing-PreToolUse error. A timed-out readiness wait does not abort ACL setup: late publication
clears the failure state, logs `lifecycle_listen` with `ok: true`, and lets the next exec PreToolUse bind.
Actual setup failure supersedes an earlier startup-cap reason. Stdin EOF, explicit close and upstream startup
failure still abort the ACL child; cancellation checks prevent a racing success from publishing after shutdown.
The asynchronous child timeout and cancellation use the existing
[Node execFile API](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback).

The new failing-first adapter tests exercise the actual standalone exec helper:

- A file-gated ACL child holds readiness while upstream starts. MCP initialization remains pending until ACL
  release; the first helper PreToolUse then binds and `js` forwards the exact session, prompt and tool-use ids.
- A blocked registry, failed ACL child and timed-out ACL child leave MCP discovery and ping alive. The helper
  finds no route; `js` and `js_reset` refuse with the matching classification and log it without forwarding work.
- ACL setup survives the shorter startup cap. The first helper/call pair fails with `startup_timeout`; releasing
  the child publishes the endpoint, and the next helper/call pair succeeds without restarting MCP.
- Host EOF during the startup wait kills the child without publishing. The existing post-cap shutdown and
  in-flight host-loss tests still require bounded cancellation and upstream Interrupt cleanup.

The fixture injects the ACL runner on POSIX as well as Windows. Five new behavior cases failed against the
previous relay before the implementation changed. Tests use disposable homes and fake original MCP servers;
they add no native Windows ACL, named-pipe, browser, or original-host desktop verification. Stale-registration
pruning remains unchanged; this fix does not delete another relay's registrations or socket files.


Readiness follow-up validation on macOS arm64, using disposable homes, no `CLAUDE_CONFIG_DIR`, and
240-second limits per suite:

- Full Node suite, Node 22.22.2: 473 pass, 40 platform skips, no failures (15.5 s).
- Full adapter suite with the diagnostic-log preload, Node 22.22.2: 245 pass, 8 opt-in/platform skips,
  no failures (132.9 s).
- Python unittests (`python3 -I -m unittest discover -b -s tests -p 'test_*.py'`): 45 pass (21.4 s).
- Focused Claude adapter and lifecycle listener suites, Node 22.22.2: 77 pass, one native Windows skip,
  no failures (34.9 s).
- Changed Node modules parse, and `git diff --check main..HEAD` passes.

The first adapter run used a disposable home under macOS's symlinked `/var` path; Pi's existing private-path
checks correctly refused that cache location, producing 15 Pi cache failures. The complete passing rerun
resolved the home to its real `/private/var` path. The installed Node 24 command could not launch because its
Homebrew binary referenced a missing library; no system installation was changed, and all reported Node suites
used the working Node 22.22.2 executable. No personal configuration or desktop session was used.
