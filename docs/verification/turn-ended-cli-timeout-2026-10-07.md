# Live macOS multi-turn turn-ended run, 2026-10-07

Live check for [#23](https://github.com/amontlabs/lcu/issues/23) and PR #24. At the
user's request it ran on the user's own macOS host, not the UTM verification guest.
**Result: the PR's slow path was not exercised.** On this host the signed
`SkyComputerUseClient turn-ended` command finished in 11–100 ms. It never took the
~5.2 s reported in #23, so origin/main and this branch behaved the same.

## Host and app

| Item | Value |
| --- | --- |
| Machine | User's macOS host (not the guest), macOS 26.5 (25F71), arm64 |
| ChatGPT.app | 26.930.21537 (build 12776), signed `com.openai.codex`, team 2DC432GLL2 |
| CUA runtime | 0.0.27/20260927214556-b77d38801cca |
| Tested pair | No (`tested-versions.json` lists 26.928.20755 with this runtime; informational only) |
| Codex Computer Use.app | 26.929.1001365 |
| `SkyComputerUseClient` SHA-256 | `1092710656ed437747359ffa32a87447220055f6d11f2a9c3b2f7810f1841f4c` |
| #23 reporter | ChatGPT 26.930.31730, same runtime, macOS 26.5.1 |

## Harness

- Two scratch roots under `/private/tmp`, one per code version: `git archive` of `lcu/`, `bin/` and
  `runtime.lock.json` at origin/main `1180362` and at branch `61b9763`, plus an `app` link to
  `/Applications/ChatGPT.app` and the installed `installation.json`. No setup ran and no agent was registered.
  `CODEX_HOME` and `LCU_LOG_DIR` were set to scratch paths.
- A Node script ran `createCuaClient()` from `adapters/client.mjs` against `<root>/bin/lcu`. One
  MCP server process served 4 turns in one session. Each turn ran one `js` call containing
  `cua.computer.list_apps()` and `cua.computer.get_app_state({app: "com.apple.finder"})` (Finder is
  always-allowed), then called `turnEnded(Stop)`. The next turn started as soon as that returned.
  The actions only read state: no clicks, typing or keys.
- A scratch-only copy of the branch's `macos_sky_service.mjs` recorded timestamps in memory and
  returned them through a scratch-only RPC. It recorded the hook start, the CLI step start and end,
  and each Sky request entry. Output from the trusted worker's `console.error` does not reach the MCP
  client's stderr, so this was the only way to see the wrapper's timings. The repository code was
  not changed.
- To time the command directly, a script ran the signed command 3 times with no service running
  and 133 times while a Sky action was in progress. It used dummy IDs and the same payload shape.

## Results

The native step's duration is the time from the hook starting to the CLI step starting.
"Next request wait" is how long the next turn's first Sky request waited before dispatch.

| Run | Turn | `turn_ended` MCP | Native step | CLI step (lifetime round trip) | Next turn's first `list_apps` | Result |
| --- | --- | --- | --- | --- | --- | --- |
| origin/main | 1–4 | 36, 13, 15, 15 ms | not instrumented | inside the hook | 8, 8, 9 ms | all 8 Sky actions ok |
| branch | 1–4 | 24, 1, 1, 1 ms | not instrumented | in the background | 23, 22, 22 ms | all 8 Sky actions ok |
| branch, instrumented | 1–4 | 23, 1, 1, 1 ms | 22, 1, 1, 1 ms | 14, 14, 12, 12 ms, `notified: true` | 21, 23, 21 ms (waited ~11–14 ms for the CLI) | all 8 Sky actions ok |

- Signed command run directly: 11–12 ms with no service running. While the service was running it
  took 31–100 ms over 133 runs. Every run exited 0 with empty stdout and stderr.
- The branch's host logs the command only when it fails or takes 4.5 s or more. It logged nothing,
  which matches the measured times. The diagnostic log recorded `turn_end outcome=ok` for every turn
  in both versions.
- origin/main's 3 s timeout never triggered, so the failure in #23 (the command killed at 3 s and
  later Sky requests failing) did not reproduce here. This run gives no before/after comparison.
- On the branch the next Sky request waited for the background CLI step, as designed. Here that wait
  was ~12 ms.

## What this shows and what it does not

- Shown: on this host and app build, the branch keeps computer use working across 4 turns in one MCP
  process. The hook returns after the native step. The background command finishes with exit 0 and is
  awaited by the next Sky request.
- Not shown: the 10 s allowance, the background run of a ~5 s command, and the retry-once-then-drop
  policy with the real helper. The ~5.2 s duration and its stated cause (the helper launching the CUA
  service and waiting up to 5 s for XPC) were not observed. Here the command did not launch the service.
  The difference may depend on the app build (26.930.31730 for the reporter) or on whether the ChatGPT
  app was running. The ChatGPT app was not running and was not launched for this test.
- Not shown: delivery to the service. Exit 0 is not proof of delivery, and os_log redacts the
  client's messages. Visible cursor removal was also not checked.
