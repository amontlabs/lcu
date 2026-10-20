import { execFile } from 'node:child_process';

/**
 * Approval UI for DeepSeek Harness.
 *
 * The original runtime asks before an agent may control an app (`Allow Computer Use to use "Zed"?`)
 * with an MCP form elicitation. A host that supports elicitation renders that request itself; the
 * DeepSeek Harness MCP client does not advertise the capability, so the relay must present the
 * question and hand the answer back. This module owns that question: one native macOS dialog per
 * request, with the choices the runtime actually offered.
 *
 * The model cannot answer it: the dialog belongs to the relay's process, is created only in answer
 * to an upstream request, and the relay's host guard still refuses the app that hosts this session.
 * Approving an app that is already controllable could still let the model press the dialog, exactly
 * as documented for the other hosts, so the default and cancel button is Decline.
 */

const DIALOG_TITLE = 'Computer use approval';

/** AppleScript string literal for `value`. */
export function appleScriptString(value) {
  return `"${String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * The `display dialog` script for one native-app approval. Choices render in the order the runtime
 * offered them; the decline choice, when present, is both the default and the cancel button.
 */
export function buildApprovalScript({ message, resource, choices }) {
  if (typeof message !== 'string' || !message) throw new TypeError('an approval needs the runtime message');
  if (!Array.isArray(choices) || choices.length === 0) throw new TypeError('an approval needs at least one choice');
  const labels = choices.map(choice => choice.label);
  const decline = choices.find(choice => choice.value === 'decline');
  const fallback = decline ?? choices[choices.length - 1];
  const body = resource ? `${message}\n\nApp: ${resource}` : message;
  return 'display dialog ' + appleScriptString(body) +
    ` with title ${appleScriptString(DIALOG_TITLE)}` +
    ` buttons {${labels.map(appleScriptString).join(', ')}}` +
    ` default button ${appleScriptString(fallback.label)}` +
    ` cancel button ${appleScriptString(fallback.label)}` +
    ' with icon caution';
}

/** Run an AppleScript source file through `osascript -` and return its stdout. */
function runOsascript(script, { execFileImpl = execFile, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFileImpl('osascript', ['-'], { timeout }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin?.end(script, 'utf8');
  });
}

/**
 * Ask the person at the machine and return the selected choice `value`.
 *
 * A dismissed dialog is `cancel`, which the relay turns into the runtime's own cancellation; a
 * platform without this dialog answers `cancel` too, so an unanswered request never becomes an
 * approval. `run` and `platform` exist for tests.
 */
export async function promptForApproval({ message, resource, choices }, { run, platform = process.platform } = {}) {
  if (platform !== 'darwin') return 'cancel';
  const script = buildApprovalScript({ message, resource, choices });
  let stdout;
  try {
    stdout = await (run ?? runOsascript)(script);
  } catch {
    return 'cancel';
  }
  const label = /button returned:(.*)$/m.exec(String(stdout ?? ''))?.[1]?.trim();
  const choice = choices.find(item => item.label === label);
  return choice ? choice.value : 'cancel';
}
