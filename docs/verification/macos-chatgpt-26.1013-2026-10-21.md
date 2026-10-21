# macOS ChatGPT 26.1013.40934 check, 2026-10-21

Installed-app and desktop checks for ChatGPT 26.1013.40934 with CUA 0.0.30/20261014203459-0849368674e2 on
darwin arm64, the pair `lcu doctor` reported as untested ([issue #50](https://github.com/amontlabs/lcu/issues/50)).
It repeats the checks of the [26.1007.30912 record](macos-chatgpt-26.1007-2026-10-12.md) that could run here,
bounded, on the user's own Mac. LCU writes went to scratch directories under `/private/tmp`; the desktop steps
used the installed LCU and approvals already in place (none were answered by the agent). **Result: the archive
installed offline, reusing the signed app in place, and its commands passed; one desktop task each through
Claude Code + LCU and Codex CLI + LCU completed, each with an independent check.**

## Host and app

| Item | Value |
| --- | --- |
| Machine | User's Mac, macOS 26.5 (25F71), arm64 |
| ChatGPT.app | 26.1013.40934 (build 20770), signed `com.openai.codex`, team 2DC432GLL2; `codesign --verify --deep --strict` passed |
| CUA runtime | 0.0.30/20261014203459-0849368674e2 |
| Codex Computer Use.app | build 1001501, both the bundled copy (`cua_node/lib/node_modules/@oai/sky`) and `~/.codex/computer-use` (26.1013.1001501) |
| Node | `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`, v24.21.0 |
| LCU | 0.11.8 source at `b62112b` (0.11.8 plus the `browser status` family change); installed copy at `~/.local/share/lcu/current` is the 0.11.8 release and reports the same pair |
| Agents | Claude Code 2.1.204, codex-cli 0.160.0 |

## Installed-app check

- `node --test tests/node/*.test.mjs`: 471 tests, 432 passed, 39 skipped (platform-specific), 0 failed.
- `python3 scripts/build_bundle.py --platform darwin --app /Applications/ChatGPT.app --output dist/verify-26.1013`
  built `lcu-0.11.8-darwin-arm64.tar.gz` (SHA-256 `60c6d5fa4bbfebf2983140ef5aa389d379c513f88555b4b3634d3c9fac33986c`,
  matching its sidecar). It stays in `dist/`, out of Git.
- From the extracted archive, `scripts/install.sh --prefix /private/tmp/lcu-verify-26.1013 --offline --runtime-only
  --yes` succeeded and printed `The signed application is reused in place.` and `Tested pair: no.`
- From that prefix: `--version` printed `lcu 0.11.8 (ChatGPT darwin 26.1013.40934; CUA
  0.0.30/20261014203459-0849368674e2)`; `doctor` exited 0, reported the same pair, `Tested pair: no.` and
  `Original Mac provider loaded; app listing and app-state methods are available.`; `doctor --help` and `prune`
  (`Nothing to prune`) exited 0.
- `browser status` (read-only original diagnostics) exited 1 with `ChatGPT extension: not found in Chrome, Edge,
  Brave, Opera or Vivaldi.`; `browser status --browser brave` resolved Brave's `Default` profile and reported the
  extension not found and the Brave native-host manifest pointing at the ChatGPT app's own host; `--browser
  firefox` exited 2 naming the five families. No extension is installed here, so only the negative paths ran.

## Desktop checks

### Claude Code + LCU

This agent session, through the installed Claude relay (0.11.8, same pair), `mcp__lcu__js`:

| Step | Result |
| --- | --- |
| `cua.getApp("Calculator")` | AX tree of the French UI (`Calculatrice`), display `0` |
| All Clear, 1 4 3 × 7 = by element clicks | Display `1 001`, expression `143×7` |
| `js_reset`, then `getApp` again | Same state; `getScreenshot({ emit: false })` returned a 48 019-byte JPEG |
| TextEdit (file opened with `open -a TextEdit` from the shell): `setValue` on the text view with Unicode text, then Fichier › Enregistrer by element clicks | Saved; the AX value showed the new text |
| `js_reset` | Reset |

Independent check: `/private/tmp/lcu50-desktop/note.txt` on disk read `LCU 26.1013 check` / `Calculator: 143 x 7 =
1001` / `Unicode: été — ✓` (68 bytes, SHA-256 `f41754ac19e53a96e01ab5c3bdc53556cb9834be49a93edc8ca5d11e3b990e13`).
The relay log recorded `call_end` ok for every call except one `js` call (screenshot) that was issued in parallel
with a `js_reset` and ended `tool_error` (`js execution reset`), as expected for that ordering; it was rerun alone
and passed. Turn-end hooks belong to the parent session and were not observed here.

### Codex CLI + LCU

`codex exec --skip-git-repo-check -C /private/tmp/lcu50-desktop -s workspace-write -c approval_policy='"never"'
"<task>" < /dev/null`, through the installed Codex relay. Calculator is always-allowed. The task: compute 256 × 13
in Calculator by clicking its buttons through LCU's `js` tool, then write the displayed result to `codex.txt`.

- Codex made two `lcu/js` calls and one shell call (`cat codex.txt`, after writing); no AppleScript or shell UI
  calls. It wrote `calculator=3 328`.
- Independent check: 256 × 13 = 3328.
- The relay logged two `approval_open` (kind `other`) ending in `accept` after 2.6 s and 1.9 s, two `call_end`
  ok, and `turn_end` Stop, ok, `sky_hook: live` (51 ms). The agent did not answer those approvals; this log does
  not show which component accepted them.

## Not verified

- Linux and Windows; this pair is darwin arm64 only.
- Event-tap counts (the earlier record's `CGGetEventTapList` tool was not rerun).
- The browser surfaces (external browsers and the in-app browser); `browser status` above is discovery only and
  does not establish a browser action.
