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
 * At most this many buttons: `display dialog` rejects a fourth (`-50`), and a rejected script would
 * read as a cancelled request. The runtime may offer once, session, always and decline.
 */
export const MAX_DIALOG_BUTTONS = 3;

/**
 * The buttons to show for the choices the runtime offered.
 *
 * "Allow this session" stands for the once choice when the runtime offers no session scope, as the
 * Claude approval card does: four scopes do not fit in one dialog, and a per-session grant is the
 * closest visible equivalent of "allow once" for the person answering. Never invents a scope the
 * runtime did not offer.
 */
export function dialogChoices(choices) {
  if (!Array.isArray(choices) || choices.length === 0) throw new TypeError('an approval needs at least one choice');
  const offered = new Set(choices.map(choice => choice.value));
  const buttons = [];
  if (offered.has('session')) buttons.push({ value: 'session', label: 'Allow for this session' });
  else if (offered.has('once')) buttons.push({ value: 'once', label: 'Allow once' });
  if (offered.has('always')) buttons.push({ value: 'always', label: 'Always allow' });
  const decline = choices.find(choice => choice.value === 'decline');
  if (decline) buttons.push({ value: 'decline', label: decline.label });
  return buttons.slice(0, MAX_DIALOG_BUTTONS);
}

/**
 * The `display dialog` script for one native-app approval; the decline choice, when present, is both
 * the default and the cancel button.
 */
export function buildApprovalScript({ message, resource, choices }) {
  if (typeof message !== 'string' || !message) throw new TypeError('an approval needs the runtime message');
  const buttons = dialogChoices(choices);
  const labels = buttons.map(choice => choice.label);
  const decline = buttons.find(choice => choice.value === 'decline');
  const fallback = decline ?? buttons[buttons.length - 1];
  const body = resource ? `${message}\n\nApp: ${resource}` : message;
  return 'display dialog ' + appleScriptString(body) +
    ` with title ${appleScriptString(DIALOG_TITLE)}` +
    ` buttons {${labels.map(appleScriptString).join(', ')}}` +
    ` default button ${appleScriptString(fallback.label)}` +
    ` cancel button ${appleScriptString(fallback.label)}` +
    ' with icon caution';
}

/**
 * Run an AppleScript source file through `osascript -` and return its stdout.
 *
 * `signal` closes the dialog: the child is terminated, which takes its window down with it. A
 * cancelled approval must not leave a question on screen for a request that already ended.
 */
function runOsascript(script, { execFileImpl = execFile, timeout = 0, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('the approval was cancelled'));
      return;
    }
    let settled = false;
    const finish = (error, stdout) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(stdout);
    };
    const child = execFileImpl('osascript', ['-'], { timeout }, (error, stdout) => finish(error, stdout));
    const onAbort = () => {
      // Terminating osascript dismisses the dialog it is showing.
      try { child.kill('SIGTERM'); } catch { /* the child is already gone */ }
      finish(signal.reason ?? new Error('the approval was cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
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
export async function promptForApproval({ message, resource, choices }, { run, platform = process.platform, signal } = {}) {
  if (platform !== 'darwin') return 'cancel';
  if (signal?.aborted) return 'cancel';
  const script = buildApprovalScript({ message, resource, choices });
  let stdout;
  try {
    stdout = await (run ? run(script, { signal }) : runOsascript(script, { signal }));
  } catch (error) {
    if (signal?.aborted) return 'cancel';
    // A dialog that cannot be shown must never become an approval.
    console.error('LCU DeepSeek approval dialog failed:', error instanceof Error ? error.message : String(error));
    return 'cancel';
  }
  // A child that was terminated can still have printed: never read an answer from a cancelled request.
  if (signal?.aborted) return 'cancel';
  const label = /button returned:(.*)$/m.exec(String(stdout ?? ''))?.[1]?.trim();
  const choice = dialogChoices(choices).find(item => item.label === label);
  return choice ? choice.value : 'cancel';
}
