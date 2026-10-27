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
builtins. Setup and owned user-hook refresh copy it intact to `~/.local/share/lcu/claude/claude-hook.mjs`, or
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
extra fields and other settings. Updates refresh existing owned user hooks. Project scopes lack receipts, so
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
