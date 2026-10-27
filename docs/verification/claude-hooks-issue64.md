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
messages and tool inputs are not forwarded. The dedicated `lcu/claude_hook.mjs` entry avoids importing
app-discovery/launch code. On installed Windows it is
selected by the stable `windows_launcher.mjs claude-hook` dispatch in the same Node process. Setup uses the app's
recorded Node. The existing MCP SDK transport, tool schemas, instructions, caller policy and original upstream
remain unchanged. Only lifecycle IPC is added; bind and cleanup share the relay's existing handlers and maps.
Connection/acceptance detection has a 400 ms budget; accepted cleanup has 590 seconds, inside the 600-second hook
budget, and upstream cleanup retains its 120-second per-call timeout. A helper disconnect never cancels cleanup.

Linux additionally verifies `/proc` parent creation identity. Each relay checks its current parent and generation
on requests; other platforms have no independently sampled parent creation time. Windows PID-reuse behavior and
parentage still require native verification. Multiple live registrations for one parent fail closed. Dead/stale
registrations are ignored and never removed by a helper. Shutdown removes only its own registration generation.

Git history (`3933e94`, `c3bafd7`, `fe364a9`) confirms the exact published MCP bind/Stop/Interrupt templates and the
later SubagentStop template. Migration matches those handlers and matchers exactly, preserving foreign handlers,
extra fields and other settings. Updates refresh existing owned user hooks. Project scopes lack receipts, so
one re-setup at each project scope migrates them; no new receipt subsystem was introduced for this fix.
Downgrading below this helper requires removing these command hooks and running the older setup, because a
runtime-only rollback preserves settings and the older release has no helper.

## Verification

The repository record `docs/verification/claude-hooks-issue64-failing.txt` records two installer failures and
the absent helper failure before implementation. Node tests cover exact migration/idempotence and update refresh, private endpoint
validation, wrong capability/generation/route, stale and ambiguous registration, and ownership during shutdown.
Official-SDK adapter fixtures cover acknowledged binding before js, exact current metadata, all cleanup events,
deduplication, slow accepted cleanup and failure reporting, and two concurrent Claude parents sharing one account
and identical session/prompt/tool-use ids. A child-process preload makes attempted helper subprocesses fail.

Live CLI: Claude Code **2.1.311**, macOS arm64, local scripted `tests/claude_fake_api.mjs`, dummy API key, disposable
HOME/config/cwd, no model inference, persistence, browser or desktop. Generated hooks came from the actual installer.
The scratch reproduction driver was adapted from the supplied issue64 `repro.mjs`; evidence remains at
`/private/tmp/lcu-issue64-live/{absent,connected}/result.json`. The final checked-in-driver run also passed both
cases, with evidence at `/private/tmp/lcu-claude-hooks-live-1vpFon/{absent,connected}/result.json`. Re-run the equivalent checked-in driver explicitly:

```sh
LCU_CLAUDE_LIVE_TEST=1 node tests/claude_hooks.mjs /absolute/path/to/claude
```

- Absent relay (`/usr/bin/false` MCP): CLI exit 0, Stop hook exit 0, empty stdout/stderr, zero `stop-hook-error`.
- Connected real relay, fake original upstream: PreToolUse and Stop exit 0 with empty streams. The upstream saw
  `js` with call id `toolu_01FAKE1`, current session id, and prompt id
  `c03ed26d-07a6-4fbf-8a31-ae55095536f0`; Stop received exactly that session/turn pair. Successful IPC delivery
  also verifies that generated hook and relay share the direct Claude parent in this macOS CLI topology.

No new Windows live verification or original-host desktop integration is claimed. The task-owned macOS guest
was not exercised. Docker is installed but its daemon is unavailable, so `tests/run.sh` and Linux E2E remain CI
checks. The E2E comparator accepts only exact legacy-to-command handler replacements in the known settings paths;
its regression test rejects altered timeouts, paths and foreign handlers. Archive tests include both helper modules.

Final local checks used a disposable HOME/USERPROFILE and removed `CLAUDE_CONFIG_DIR` for the Node and adapter
suites. The runner bounded each suite at 240 seconds and captured logs in `/private/tmp/lcu-issue64-final-checks`:

- `node --test tests/node/*.test.mjs`: 465 pass, 39 platform skips, no failures (Node 26.10.0).
- `node --test adapters/test/*.test.mjs`: 236 pass, 8 opt-in/platform skips, no failures (132 seconds).
- `python3 -m unittest discover -b -s tests -p 'test_*.py'`: 44 pass, including archive and E2E expectation tests.
- Focused Claude/setup/update tests on Node 22.22.2: 85 pass. The Windows archive inventory check also passed.
- Syntax checks on all 14 changed/new Node modules and `git diff --check`: pass.
