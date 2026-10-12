# macOS Unicode text input

## Scope and observed baseline

The inspected local official app reports ChatGPT 26.1007.21159, CUA runtime `0.0.29/20261005054403-144090e2ddcb`, macOS arm64 and Node 24.21.0. These are observations, not compatibility gates.

Earlier direct field readbacks on an ordinary Chromium textarea showed native `typeText("LCU: 한글 입력 테스트 가나다 ABC 123")` losing the Korean, with ASCII, digits and spaces retained. The existing original paste path delivered the complete mixed-script string in three trials. Those observations motivate this adaptation; they do not constitute a live test of the patched runtime.

## Official-source evidence

All inspected files remain in the original signed application. No OpenAI source fragment or binary is copied into this repository.

- `cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js` dispatches the requested original client method and arguments.
- `targets/mac/type_text.js` invokes `withComputerUsePolicy` for `type_text` and passes `app` and `text` to the original Mac client.
- `targets/mac/client.js`, `MacComputerUseClient.typeText`, forwards the complete `text` in the native `type` action. Its request serialization removes undefined values, not non-ASCII text. No Korean filtering or ASCII encoding was found in this JavaScript path.
- `targets/mac/paste.js` invokes the original app-policy/approval wrapper for `paste`; the same original client sends the text and format in its native paste action.
- The original macOS API guide states that app paste restores the previous clipboard contents.

The JavaScript transport therefore delivers the complete string. The loss occurs in the signed native helper, as established below. The LCU fix reuses the working original input method instead of changing or re-signing the application.

## Native root cause

The inspected helper is `Codex Computer Use.app` (`com.openai.sky.CUAService`, observed 26.1005.1001425, build 1001425, signature valid). Its symbol table and disassembly were read in place. Nothing was copied, modified or re-signed, and no code or binary fragment is reproduced here.

- The perform-action IPC handler calls `ComputerUseAppController.performKeyboardAction`, whose typing case calls `SynthesizedEvent.type(string:)`. That function holds the only reference to `+[SAIVirtualKeyPress keyPressesForString:]`. Paste and key presses build their key presses without it.
- `keyPressesForString:` reads the current keyboard layout (`TISCopyCurrentKeyboardLayoutInputSource`, its Unicode key layout data and `LMGetKbdType`) and walks the string one UTF-16 code unit at a time, mapping a line feed to a carriage return. For each unit it searches eight modifier combinations of Shift, Option and Control across virtual key codes 0-127 with `UCKeyTranslate`, looking for a key whose output starts with that unit.
- A unit with no matching key is logged as `Could not find key code for character: <c>` and skipped. The method fails only when the layout itself cannot be read, and only that failure raises the helper's key-translation error. A partial result is typed without an error, which is why the call reports success.
- Each surviving key press becomes key-down and key-up events that carry its key code, modifier flags and matched Unicode string, posted to the target process. The event path can carry arbitrary Unicode. The characters are lost earlier, in the layout lookup.

On the inspected standard Korean, ABC and US layouts, precomposed Korean syllables come from input-method composition rather than the output of one key, so every syllable is skipped. Other characters, including UTF-16 surrogate units, are skipped whenever the active layout has no matching key output.

**Runtime evidence.** The macOS unified log of the helper process holds that message for every dropped syllable of the earlier observations: ten typing calls between 11:31:42 and 11:44:56 on 2026-10-12, each logging exactly `한글입력테스트가나다`. The first two match the recorded TextEdit and Chromium readbacks.

```sh
log show --last 3h --predicate 'process == "SkyComputerUseService" AND eventMessage CONTAINS "Could not find key code"'
```

**Model evidence.** Repeating the same lookup through the public Carbon calls, outside the helper and without posting an event, yields `LCU:     ABC 123` for the test string on the 2-Set, 3-Set, 390 and romaja Korean layouts and on ABC and US. The lost set depends on the active layout: ABC and US reach curly quotes, dashes and some symbols through Option, the 2-Set layout does not, and the Russian and Greek layouts have no key for ASCII letters.

## Limits of the non-ASCII rule

The wrapper does not inspect the keyboard layout, so "contains non-ASCII" approximates "the active layout has no key for it". The predicate remains unchanged pending live evidence; the Carbon model alone does not establish a new routing policy.

- Non-ASCII characters that ABC or US can type are routed to paste as well. They still arrive, with paste semantics.
- On a layout without Latin letters the original typing path drops ASCII letters, and the wrapper does not route them. This was modelled, not observed live.
- The original typing path sends a line feed as a Return key press. A routed payload pastes the line feed as text, which can change submission behavior in a single-line field or chat box. The actual paste/submission behavior has not been verified on the patched desktop runtime. The guest test must compare ASCII-plus-LF and Korean-plus-LF in a local-only single-line fixture with an independently observed submission counter. Any newline routing change follows that evidence rather than an assumed failure.

## Change and automated regression evidence

`lcu/macos_sky_service.mjs` translates only one-argument macOS `type_text` requests whose plain-data text contains non-ASCII characters. The entire string goes to original paste once with plain-text format. ASCII, empty strings, setup, explicit paste and malformed/accessor inputs retain the original path. Input and request objects are not mutated. Lifecycle cleanup, app policy, approval and stale-service recovery remain in the existing dispatch chain.

`tests/node/macos_unicode.test.mjs` exercises the actual wrapper against a hand-made original-service stand-in, not an OpenAI code copy. The stand-in models the observed unmapped-character typing loss and Unicode-preserving paste. Before the fix, mixed Korean and mixed Unicode preservation tests failed; after the fix, all nine focused tests passed. Coverage includes ASCII/empty input, target preservation, emoji, combining marks, CJK/newlines, approval denial, paste error propagation without a lossy retry, explicit paste, immutable requests/plain-text format, accessor validation and non-enumerable app/text descriptor preservation.

Focused validation command:

```sh
node --test --test-concurrency=2 tests/node/macos_unicode.test.mjs
node --check lcu/macos_sky_service.mjs
```

## Unverified boundaries

The patched wrapper has not yet passed a live macOS desktop test or a sealed-bundle installation. The wider macOS runtime/host checks and build/native verification were resource-deferred. No running client or installed release was replaced. Fixture and original-JS integration tests prove routing, serialization and policy handling, not OS clipboard restoration, editor compatibility or actual native permissions. No new Linux or Windows verification is claimed.

The intended live verification uses a task-owned disposable macOS guest and independent readback, with clipboard/focus/pointer preservation, selection replacement, multiline text, trailing-LF submission and app-policy denial checked separately. The helper's log is a second oracle: a passing run leaves no `Could not find key code` message in the test interval, alongside exact field readback. Other typing clients must not share that interval, since the message alone has no per-request attribution. Source changes alone do not establish a fixed installed client.

## Guest-free original-JS integration

`tests/node/macos_unicode_original.test.mjs` provides an alternative when the macOS guest is unavailable. It imports the selected installed application's original Sky service, Mac client, policy code and native-pipe frame codecs in place. The test intercepts only `nodeRepl.nativePipe.createConnection` with an in-memory endpoint; it rejects any other endpoint and forbids real application launch. It uses an invented fixture app identity, simulated app-policy responses and fixture-only approval callbacks. Analytics are disabled. No real native service, desktop app or clipboard is contacted or granted access, and no OpenAI source is copied into Git.

On the observed macOS app/runtime pair, seven original-JS integration checks passed, in addition to the nine wrapper regression tests (16/16 total). They establish:

- Unpatched original JS serializes the complete mixed Korean string into native `type`; Unicode is not lost in its JavaScript transport.
- Patched wrapper invokes the original paste policy and serializes one native `paste` action with exact Unicode text, plain-text format and the policy-normalized fixture target.
- ASCII remains one original native `type` action.
- ASCII-plus-LF is sent as native type; Korean-plus-LF is sent inside one paste payload, with no separate native Return/type action. This confirms dispatch semantics, not a real application's submission behavior.
- Original organization-policy denial and user approval refusal prevent all native input actions.
- A native paste error returned by the fake endpoint propagates through the original error classes without a typing retry.

```sh
LCU_TEST_ORIGINAL_MAC_APP=/Applications/ChatGPT.app node --test --test-concurrency=2 tests/node/macos_unicode.test.mjs tests/node/macos_unicode_original.test.mjs
```

Without the explicit app environment variable, the original-JS integration checks skip with a reason. Their passing result must not be reported as live native-helper/UI verification. The native keyboard-loss log was independently re-read for the earlier 11:31:40-11:45:00 interval: 100 messages, each of `한글입력테스트가나다` appearing ten times, with first/last timestamps matching the recorded baseline. The IPC-only tests cannot create a new helper-log oracle because they intentionally do not contact that helper.
