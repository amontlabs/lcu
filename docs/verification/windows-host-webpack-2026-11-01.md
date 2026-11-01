# Windows host extraction from the webpack layout (2026-11-01)

GitHub issue 82 reported that the Windows installer stopped on `OpenAI.Codex` `26.1027.3384.0` with "no main bundle has a top-level native-pipe host factory". The bundle file name was only the first problem: the app became a webpack build, so the factory sits inside one module, beside code that imports Electron. The [provenance notes](../PROVENANCE.md) describe the extraction rules.

This record is not Windows live evidence. Nothing here ran on Windows, used the Windows helper, or exercised a real Computer Use action. It makes no claim for `tested-versions.json`. Windows Node install behaviour stays as the [development notes](../DEVELOPMENT.md) describe it.

## Inputs

| Package | Source | Result |
| --- | --- | --- |
| Windows MSIX `26.1027.3384.0` x64, SHA-256 `d442a3d7d5c229f45e5e11995711ac2619c8dbc89e3fa2bc185287dc8db8e76e` | `persistent.oaistatic.com/codex-app-prod/releases/26.1027.3384.0/ChatGPT-x64.msix` | Webpack layout |
| Linux `.deb` `26.1027.51404` amd64, the release the Windows manifest names for Store build `26.1027.6604.0` | `persistent.oaistatic.com/codex-app-prod/linux/deb/pool/main/c/chatgpt/` | Webpack layout, with different names and module ids |
| Installed macOS ChatGPT `26.1013.40934` | `/Applications/ChatGPT.app` | Earlier Rolldown layout, as a control |

The Store build `26.1027.6604.0` was not inspected: its MSIX returned HTTP 404 at the versioned URL. Packages were kept in a temporary directory and deleted afterwards. No package content entered Git.

## Layout

In the Windows package, `.vite/build/` holds 28 files and none is `main*.js`. Only `early-bootstrap-491-e75c34fa1b2c0832.js` names all four factory options. It is a chunk (`exports.ids=[491],exports.modules={...}`) whose module `83678` is about 4.5 MB, exports `runMainAppStartup`, and imports module `4482`, which is `require("electron")`. All 17 files the installer requires are present (MSIX member names encode `@` as `%40`). `@oai/sky`'s `service.js` still exports `handleRpc`, which `lcu/windows_sky_service.mjs` forwards to.

## Results

`python3 scripts/check_windows_host_layout.py <app.asar> --node <app Node>` ran on macOS arm64 with the app's own Node `24.21.0`. It loads the generated module with Electron blocked, starts the host, calls `closeActiveTurn` and disposes it.

| Package | Factory | Generated characters | Calls not carried | Files copied | Result |
| --- | --- | --- | --- | --- | --- |
| Windows `26.1027.3384.0` | `sl` | 33,558 | 14 | 33 | Passed |
| Linux `26.1027.51404` | `si` | 26,718 | 11 | 32 | Passed |
| macOS `26.1013.40934` | `lre` | 10,616 | 7 | 9 | Passed |

A separate throwaway probe drove each extracted host through its real socket with a stand-in helper transport: `ping`, an unsupported method, a schema-rejected request, a request that raised an approval and got the answer back, `end_turn`, a `closeActiveTurn` with a stale identity (closed nothing), one with the matching identity (closed the transport), `close` and `dispose`. Both webpack builds matched each other exactly. Against the `26.1013` control, the only differences were that a turn is no longer active after its `end_turn`, and the order of analytics events. Both come from the app's own changed code, which LCU copies verbatim. Loading took about 135 ms against 40 ms for the control.

The installer's own load check (`materializeOriginalHost`) also passed on both webpack packages on the app's Node. Its failure path is covered by `tests/node/windows_host.test.mjs`.

## Limits

The Linux and macOS runs prove extraction and the JavaScript host path, not Windows named pipes, the Windows helper, or a live action. The named-pipe entry is covered only by the synthetic tests in `tests/node/windows_host.test.mjs`. The issue reporter offered to test a patch on a real Windows 11 desktop; a result from that machine would be the reporter's evidence, and is not recorded here.
