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
  Windows registrations live below the selected profile’s `AppData\Local\LCU\claude\hooks`. Setup/update
  applies an explicit current-account-only inheritable ACL there through Microsoft’s [Set-Acl](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-acl?view=powershell-5.1)
  and [FileSystemAccessRule](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.filesystemaccessrule.-ctor?view=netframework-4.8.1)
  APIs in a setup-time PowerShell subprocess and checks the result; the helper never spawns a process. Neither plain chmod nor this macOS run proves Windows ACLs.

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


## Windows relay startup follow-up (per-start ACL hardening superseded below)

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


## PR 66 lifecycle readiness regression (publication and EOF ordering superseded below)

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

## PR 66 startup publication and disconnect regressions

The readiness change above published a lifecycle endpoint before `openUpstream` assigned its link, and attached
stdin EOF handling only after startup. A Stop during a 1.2-second original-server initialization delay therefore
reached cleanup without an upstream client and exited 1. An old relay whose stdin closed during stalled startup
could continue answering probes beside a replacement, making the helper silently refuse both routes. These
findings supersede the earlier claim that startup EOF reliably aborted preparation.

Preparation and publication are now separate operations. Directory creation and any explicitly requested asynchronous hardening overlap upstream startup.
The Windows hot-path follow-up below removes the default per-relay PowerShell invocation. Only after initialize and listTools complete and the relay owns the upstream
link does it open its socket/pipe and write the registration. Path and cancellation checks run again at publication.
Preparation failure remains non-fatal and classified; late ACL success after the readiness cap still recovers.
Cleanup of a never-bound turn succeeds without upstream work while retaining bounded prompt-closure history.
A missing upstream client also makes cleanup a no-op. A defensive bind without a live link returns a classified
`upstream_unavailable` error rather than binding an unusable context.

The official SDK stdio transport starts reading at relay startup, before upstream initialization or ACL waits.
LCU temporarily retains its decoded messages, then transfers that same transport to the downstream SDK server
and replays them after readiness. The instance's second `start` call performs that handoff instead of starting a
second reader. Framing, JSON-RPC validation, dispatch and serialization remain in SDK 1.30.0; this adaptation is
transport lifetime wiring only. No MCP parser or original computer-use implementation was added.

Primary sources checked for this change:

- [Node readable stream EOF](https://nodejs.org/api/stream.html#event-end) requires consuming input before `end`
  fires. Merely attaching an early EOF listener while leaving stdin paused does not solve the regression.
- The [official SDK stdio transport](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/server/stdio.ts)
  consumes input in `start`, validates through its shared ReadBuffer and refuses a second start. Its
  [Protocol.connect implementation](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/shared/protocol.ts)
  installs protocol callbacks before invoking transport.start. Both behaviors were also checked in the locally
  installed SDK 1.30.0 `dist/esm/server/stdio.js` and `dist/esm/shared/protocol.js`.
- [Node execFile cancellation](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback)
  supports the existing AbortSignal and timeout. EOF aborts the ACL subprocess and pending upstream startup
  requests; the starting client closes even before it has become the relay's active link.

Shutdown first removes its own registration, closes the listener and destroys its sockets, then aborts preparation
and drains active turns. A replacement cannot see a closing endpoint as ready during the two-second cleanup
window. Cancellation before or during publication prevents a late listener from surviving shutdown. Helpers
still never remove another relay's registration.

The extra readiness wait is `max(0, min(2000, 28000 - elapsedStartupMs))`, measured with a monotonic clock from
entry to runClaudeBridge. Upstream startup consumes the same budget, so an upstream that already took 28 seconds
adds no readiness wait. This reserves two seconds of Claude's documented default
[30-second MCP_TIMEOUT](https://code.claude.com/docs/en/env-vars) for the downstream handshake. It cannot guarantee
a successful connection if upstream startup, module loading or the host itself exhausts the budget. Custom
shorter Claude timeouts remain caller policy. ACL preparation is still allowed to finish later and recover.

Regression fixtures use disposable homes, real exec helpers and fake original MCP servers on POSIX as well as
Windows. They cover Stop during a 1.2-second initialization delay, no publication before upstream readiness,
never-bound cleanup after publication, and EOF during file-gated upstream startup both with and without an
indefinitely pending ACL child. A same-parent replacement must acknowledge exec PreToolUse and execute js;
the old registration must disappear and its ACL child must die within one second. Releasing both gates after
EOF cannot resurrect the old endpoint. The active-call shutdown regression checks unpublication and connection refusal within one
second, before cleanup drains. A scaled 100-ms total startup budget with 500-ms upstream delay proves the
extra two-second wait is skipped and late ACL readiness still recovers. Listener tests separately verify that
completed preparation creates neither a socket nor a registration and cannot publish after cancellation.

The accepted-cleanup duration/failure and disconnected-helper regressions now bind contexts before cleanup.
They retain their slow acknowledgement, upstream failure reporting and uncancelled accepted-cleanup assertions;
never-bound cleanup is covered by the new successful no-op case instead.

These checks add no native Windows ACL, named-pipe, browser or original-host desktop verification.

A disposable baseline copy of `36162b6`, using the new regression fixtures, failed all three symptom cases:
Stop exited 1 with `The original CUA server is not running`, the published old registration survived the
one-second EOF bound, and the stalled ACL child survived that bound. The fixed replacement cases each finish
in approximately 0.7 seconds, including replacement startup and exec-helper tool binding.

Validation on macOS arm64, Node 22.22.2, with disposable homes, `CLAUDE_CONFIG_DIR` unset, and a
240-second subprocess limit per suite:

- Full Node suite (`node --test tests/node/*.test.mjs`): 474 pass, 40 platform skips, zero failures (15.0 s).
- Full adapter suite with `adapters/test/no-diagnostic-log.mjs`: 249 pass, 8 opt-in/platform skips, zero
  failures (132.9 s). This final run includes the injected fast ACL replacement and direct endpoint-refusal
  assertions. The earlier complete run also passed before those fixture refinements.
- Python unittests (`python3 -I -m unittest discover -b -s tests -p 'test_*.py'`): 45 pass (20.6 s).
- The three startup symptom cases fail against the disposable original-head baseline and pass with the fix.
  Existing accepted cleanup, host-loss, readiness failure, recovery and routing tests pass in the full suite.
- Changed runtime modules parse; `git diff --check main..HEAD` passes.

No personal configuration or desktop session was used. The runtime and platform evidence limits above remain
unchanged; these are adapter/IPC integration tests with fixture upstream servers.


## Windows lifecycle hot path: AppData registry and setup-time ACL hardening

The supplied windows-latest log for `36162b6` (`win-122566498598.log`) confirms that the two-second readiness
cap regularly expires during real PowerShell startup. The existing identity-isolation tests at their then-lines
373 and 451 expected `Missing exact Claude PreToolUse identity` but received `startup_timeout`. That is a
usable-channel failure, not a reason to weaken those assertions. A two-second cap only bounds the delay;
it cannot make cold PowerShell predictably complete before tools become available.

We chose the AppData option. Both relay and standalone helper now use
`<selected USERPROFILE>\AppData\Local\LCU\claude\hooks`, beside the existing account-data helper.
The old `<profile>\.lcu-claude-hooks` registry is no longer read, copied or pruned. An arbitrary `LOCALAPPDATA`
override cannot redirect just the lifecycle registry to a shared location. This follows LCU's existing helper
path policy. Update refreshes that helper's bytes; restart the Claude MCP connection after upgrading so helper
and relay both use the new route. POSIX registry paths and mode checks are unchanged.

Default relay preparation creates/checks the directory and rechecks every Windows path component for links,
then waits only for the original upstream before publication. It never launches PowerShell, including on first
creation and after a directory is removed. Startup is therefore independent of PowerShell availability and cold
start time. The previous two-second extra wait and 28-second total lifecycle deadline remain for explicitly
requested asynchronous preparation; normal Windows startup has no ACL subprocess to wait for.

The privacy baseline is the standard per-user profile/AppData ACL, allowing the account, SYSTEM and
Administrators rather than other unprivileged accounts. This is the chosen Windows trust boundary, not a claim
that Node audits a manually altered DACL on every launch. Setup and update additionally create and harden only
the LCU-owned hooks directory with the existing current-SID-only inheritable ACL and verification script.
They do not change AppData or other user-owned parent ACLs. A hardening error now warns through setup’s
existing warning output and installation/refresh continues with the AppData inheritance baseline (see the
review follow-up below). The relay leaves this Windows directory in place when it unpublishes its registration,
so the setup-time hardening survives subsequent starts. There is no ACL-success marker or per-start ACL probe.

This supersedes the earlier decision to check a DACL on every relay start. That approach's measured cold-start
cost makes the channel unusable on ordinary Windows CI starts. Requiring that work on every launch, or merely
raising its timeout, cannot satisfy the connection budget. AppData supplies the normal profile boundary;
setup-time hardening supplies the narrower explicit ACL without putting a subprocess in that budget.

Primary-source evidence:

- Microsoft's [KNOWNFOLDERID reference](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid)
  defines LocalAppData as a per-user directory, with default path `%USERPROFILE%\AppData\Local`.
- Microsoft's [ACE inheritance rules](https://learn.microsoft.com/en-us/windows/win32/secauthz/ace-inheritance-rules)
  document how child files/directories inherit access rules. Using the standard private profile inheritance
  as the hot-path baseline is our explicit design choice, not an assertion that this reference proves every
  customized profile private.
- The existing [Set-Acl API](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-acl?view=powershell-5.1)
  remains the setup-time hardening mechanism. The script still removes inherited/explicit rules, grants the
  current account inheritable FullControl, verifies the result, and removes inherited PS7 `PSModulePath` only
  from that subprocess's environment.

Deterministic regressions now run preparation in a subprocess forced down the Windows branch with both
`execFile` and `execFileSync` forbidden, then publish successfully. An adapter regression forbids PowerShell
launches while starting the real relay, executes standalone PreToolUse plus js, checks successful publication,
retains the exact missing-identity refusal for an unbound call, and acknowledges Stop. Neither test grants
PowerShell a larger deadline or accepts `startup_timeout`. The existing slow injected preparation, EOF,
replacement, startup budget and late recovery cases remain enabled. The native Windows PS7-module regression
now exercises setup-time hardening separately from MCP startup. These tests add no claim of new native Windows
or original-host desktop verification on the macOS development host.

A disposable copy of `a8c3b6e` fails the forced-Windows no-PowerShell preparation probe with
`PowerShell forbidden`, classified `acl_failed`; the current implementation completes preparation and
publication with empty output. This establishes that the new test detects the old default launch rather
than relying on how quickly a real PowerShell happens to finish.

Hot-path follow-up validation on macOS arm64, Node 22.22.2, with disposable homes,
`CLAUDE_CONFIG_DIR` unset and 240-second limits:

- Full Node suite: 477 pass, 40 platform skips, zero failures (15.6 s).
- Full adapter suite with the diagnostic-log preload: 250 pass, 8 opt-in/platform skips, zero failures (134.4 s).
- Python unittests: 45 pass (21.7 s).
- Focused no-PowerShell, AppData-path, setup-script and registry-failure checks: five pass, one native Windows skip.
- Changed runtime modules parse, and `git diff --check main..HEAD` passes.

The Windows-specific no-PowerShell preparation branch is exercised on POSIX by the subprocess probe; the
actual Windows named pipe, native DACL setup and the unchanged identity-isolation tests remain Windows CI
checks. No personal configuration or desktop session was used.


## PR 66 review follow-up

The unbound-turn shortcut incorrectly skipped upstream prompt closure and child cascading after upstream
was ready. A parent that never called CUA could Stop while its background child continued using CUA with
cross-turn off. Cleanup now takes the same path as main, including a restart in progress or a failed restart.
The existing `sendTurnEnded` check skips the upstream call itself when no upstream exists. The exec helper
still exits zero with empty output on success or absent routes. Four exec-helper regressions cover children bound before
and after the unbound parent's Stop, with cross-turn off refusing their calls and cross-turn on preserving
main's independent child behavior. Running the current regression file against a disposable source copy
of `0faa88d` fails all four cases; both off-mode cases fail because `js` succeeds after Stop. The startup
regression separately checks zero upstream cleanup before publication and normal prompt cleanup afterwards.

Setup-time Windows ACL hardening is defence in depth over profile/AppData inheritance. Failure or timeout
now emits a short warning through `terminal.warn` and continues writing the helper, lifecycle hooks and
approval mod. Setup and post-install regressions inject both `EACCES` and `ETIMEDOUT` from the ACL runner;
they check successful configuration, refreshed helper bytes and hook commands, and approval-mod installation.
The four tests failed before the local catch was added and pass afterwards. The inheritance baseline and
ACL script remain the Windows choices documented above; this adds no native DACL verification.

A missing registration JSON is republished atomically on an unref'd 60-second interval. Existing files,
including replacement generations, are left alone; recovery rechecks directory privacy and Windows parent
links. Closing the listener clears the interval. Deterministic timer tests remove the JSON, advance one
interval and deliver a hook through the recovered route, then check that shutdown stops repair. Another
test preserves a replacement and refuses a POSIX directory made public. A deleted socket or directory
still requires restarting the relay. Node's [timer documentation](https://nodejs.org/api/timers.html#timeoutunref)
confirms that `unref()` does not keep the process running. The missing-registration test failed before
repair was added.

Uninstall instructions now name the current Windows AppData hooks directory and the current POSIX
`/tmp/lcu-claude-<uid>-<home-hash>` directory.

The optional POSIX registry relocation remains deferred. Directly replacing `/tmp` with this macOS
account's per-user temp root produces a 114-byte socket pathname with the existing short hashed names.
Node documents [103 usable bytes on macOS](https://nodejs.org/docs/latest-v22.x/api/net.html#ipc-support).
Shorter names address length but not routing: [os.tmpdir() uses TMPDIR, TMP and TEMP](https://nodejs.org/api/os.html#ostmpdir),
so relay and helper processes with different overrides can choose different preferred directories. Merely
having the helper check its own preferred root and `/tmp` does not find a relay published under another
preferred root. A safe change needs stable discovery or a shared registration location separate from the
socket root, plus migration tests. This exceeds the requested small follow-up. The known cross-account
pre-creation denial of service remains; existing owner/mode checks still refuse a foreign directory.


Review validation on macOS arm64 used disposable homes/configuration, fake upstream fixtures, and
240-second process-group limits. The full suites used the locally installed app's Node **24.21.0**:

- Full Node suite: **483 pass, 40 skips, zero failures** (15.5 s).
- Full adapter suite with the diagnostic-log preload: **254 pass, 8 skips, zero failures** (131.9 s).
- Python 3.14 unittests: **45 pass** (17.7 s).
- Focused Claude/setup/update/lifecycle tests on Node **22.22.2**: **103 pass, one native Windows skip** (2.6 s).
- Final full adapter suite on Node **22.22.2**, after the cleanup simplification: **254 pass, 8 skips,
  zero failures** (133.2 s).
- Changed runtime modules pass Node 22 syntax checks; `git diff --check main..HEAD` passes.
- `tests/run.sh linux/arm64`: blocked at Docker build because the local Docker daemon is unavailable.

No personal configuration, agent credentials or desktop session was used. These fixture checks add no native Windows or original-host
desktop verification; the prior platform evidence limits remain unchanged.
