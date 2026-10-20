# DeepSeek Harness adapter (verification, 2026-10-20)

Scope: `adapters/deepseek.mjs`, `adapters/deepseek-approval.mjs`, `lcu setup --agent deepseek`, and the
registration writer in `lcu/harness_setup.mjs` (see [DeepSeek Harness](../ADAPTERS.md#deepseek-harness)).

## What the checks establish

- `adapters/test/deepseek.test.mjs` (10 tests, in-process relay against a synthetic upstream MCP server
  in `adapters/test/deepseek-fixture.mjs`): the model surface is exactly `js` and `js_reset`; a host-only
  tool (`turn_ended`) is refused when the model calls it; a native-app approval is relayed unchanged to a
  client that advertises elicitation, including the runtime's `persist` scope; the app hosting the agent
  is declined by the host guard before any question is asked; with no client elicitation and
  `LCU_DEEPSEEK_APPROVAL=deny`, an approval is cancelled rather than approved; a four-scope request stays
  within `display dialog`'s three-button limit and keeps Decline as the default and cancel button;
  AppleScript quoting keeps quotes and backslashes literal; a platform without the dialog answers cancel.
- `npm test` in `adapters/`: 217 tests, 209 passed, 8 skipped, 0 failed.
- Live, macOS arm64, Apple Silicon, ChatGPT 26.1013.40934 with CUA 0.0.30/20261014203459-0849368674e2
  (an untested pair; `lcu status` warned): `lcu setup --agent deepseek` wrote one
  `capabilities.items.lcu` entry into `~/.dsh/bot/state.json`, with `.lcu-backup` beside it and the new
  file published by rename; the other entries and the harness's own keys were preserved. After the
  harness restarted, it mounted the relay (a `deepseek.mjs` child of the harness's own Node), listed the
  two model tools, and `cua.getState()` returned the window inventory. `cua.getApp("WeChat")` raised the
  runtime's per-app approval; the relay's dialog rendered with "Allow for this session", "Always allow"
  and "Decline"; the person answered with the session scope; `getApp` then bound the window with no
  second prompt and `getScreenshot()` returned it. The harness restarted the relay by itself after it was
  killed, and the session-scope grant survived that restart long enough to repeat the call.
- `configureDeepseek` was also run against a copy of a capability store: one entry added, an unrelated
  `iphone-use` entry and a `bots` map byte-preserved, the `.lcu-backup` copy written first.

## Failure the checks found and fixed

The first dialog offered all four scopes the runtime asks for. AppleScript's `display dialog` accepts at
most three buttons and returns `-50` for a fourth; the relay read the rejected script as a cancelled
request, so every per-app approval was answered `cancel` and the runtime reported
`Computer Use was not approved to use WeChat`. `dialogChoices()` now answers with at most three buttons
and shows the once scope as "Allow for this session" only when the runtime offers no session scope, as
the Claude approval card does.

## Not verified

- Linux and Windows: the adapter was not run on either. The dialog is macOS-only, and both platforms have
  no per-app approval for the runtime to request.
- Chrome: origin approvals are cancelled by this adapter, so browser control is not available through it.
- `LCU_DEEPSEEK_APPROVAL=deny` was exercised only by the unit tests, not by an unattended run.
- A registration after the harness rewrote its capability store from its own settings was not run.
- The app-update restart path (`createAppUpdateRestart` after a `js` call) was not exercised against a
  live app update; it is shared with the Codex relay and was verified there only.
- The harness's own approval UI, and `lcu setup --agent deepseek` through `scripts/install.sh` rather than
  the installed command, were not run.
