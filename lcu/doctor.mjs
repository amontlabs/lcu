// Check the original desktop provider and guide first-use permissions.
//
// Port of lcu/doctor.py. `internals` holds the injection points the Python tests reach with
// unittest.mock.patch (`_probe`, `_open_settings`, `subprocess.run`, `linux_sandbox_works`, sys.stdin,
// sys.stdout); production code never replaces them.
import { readFileSync, rmSync, writeSync } from 'node:fs';
import { isatty } from 'node:tty';

import { ArgumentParser, pyStrip, pySplitlines } from './compat/argparse.mjs';
import { pyStr } from './compat/pyerr.mjs';
import { stderr_write, stdout_flush, stdout_write } from './compat/pyio.mjs';
import { loads, PyFloat, toPlain, ValueError } from './compat/pyjson.mjs';
import { pathStr } from './compat/pathlib.mjs';
import { InvalidFileException, loads as plist_loads } from './compat/plist.mjs';
import { isOSError, run, SubprocessError } from './compat/subprocess.mjs';
import { mkdtemp } from './compat/tempfile.mjs';
import { decode } from './compat/utf8.mjs';
import { posix as path } from 'node:path';

import { MAC_HELPER, mac_socket_path_problem } from './platforms.mjs';
import { unshimmed_env } from './sandbox_shim.mjs';
import { changed_since_install, report as report_tested_pair } from './tested.mjs';
import { status_line } from './update.mjs';
import { summary as diagnostic_log_summary } from './diagnostic_log.mjs';
import { environment, paths } from './runtime.mjs';
import { attribute_error_get } from './compat/pystr.mjs';

export const MAC_ACCESSIBILITY_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
export const MAC_SCREEN_CAPTURE_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export const PROBE = String.raw`
import { handleRpc } from '@oai/sky/service';
const report = {};
function errorInfo(error) {
  const detail = {};
  if (Number.isInteger(error?.code)) detail.code = error.code;
  if (typeof error?.errorName === 'string') detail.name = error.errorName;
  if (typeof error?.message === 'string') detail.message = error.message.replace(/\s+/g, ' ').slice(0, 240);
  return detail;
}
async function call(method, args = []) {
  try { return {ok: true, value: await handleRpc({type: 'execute', method, args})}; }
  catch (error) { return {ok: false, error: errorInfo(error)}; }
}
try {
  const setup = await handleRpc({type: 'setup'});
  report.target = setup.target;
  if (setup.target === 'linux') {
    const windows = await call('list_windows');
    report.windows = windows.ok && Array.isArray(windows.value)
      ? {ok: true, count: windows.value.length}
      : windows.ok ? {ok: false, error: {message: 'Original runtime returned an invalid window list.'}}
        : {ok: false, error: windows.error};
    if (report.windows.ok) {
      const screenshots = await call('get_screenshot');
      if (!screenshots.ok) {
        report.screenshot = {ok: false, error: screenshots.error};
      } else {
        const images = screenshots.value;
        const valid = Array.isArray(images) && images.length > 0 && images.every(
          image => image && typeof image.data_url === 'string' && image.data_url.startsWith('data:image/'));
        report.screenshot = {ok: valid, count: Array.isArray(images) ? images.length : 0,
          error: valid ? undefined : {message: 'Original runtime returned no usable screenshot.'}};
        // The original API owns its normal temporary capture files. This probe
        // emits no image data and creates no additional screenshot copy.
        if (Array.isArray(images)) for (const image of images) image.data_url = '';
      }
    } else {
      report.screenshot = {ok: false, skipped: true};
    }
  } else if (setup.target === 'windows') {
    const windows = await call('list_windows');
    report.windows = windows.ok && Array.isArray(windows.value)
      ? {ok: true, count: windows.value.length}
      : windows.ok ? {ok: false, error: {message: 'Original runtime returned an invalid window list.'}}
        : {ok: false, error: windows.error};
    report.screenshot = {ok: false, unverified: true};
  } else if (setup.target === 'mac') {
    const methods = Array.isArray(setup.methods) ? setup.methods : [];
    const needed = ['list_apps', 'get_app_state'];
    report.provider = {ok: needed.every(method => methods.includes(method)), methods: methods.filter(
      method => needed.includes(method))};
    report.permissions = {ok: false, unverified: true};
  } else {
    report.provider = {ok: false, error: {message: 'Unsupported original runtime target.'}};
  }
} catch (error) {
  report.provider = {ok: false, error: errorInfo(error)};
}
console.log(JSON.stringify(report));
`;

// input(): reads one line byte by byte so nothing past it is consumed; EOF before any byte is EOFError.
export class EOFError extends Error {
  constructor() {
    super('EOF when reading a line');
    this.name = 'EOFError';
  }
}
class KeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeyError';
  }
}
class KeyboardInterrupt extends Error {
  constructor() {
    super('');
    this.name = 'KeyboardInterrupt';
  }
}

// input()'s read. Asynchronous on process.stdin so that SIGINT can interrupt it the way it interrupts
// CPython's read (KeyboardInterrupt): a synchronous readSync cannot be interrupted by a JavaScript signal handler,
// and the handler would also suppress the default exit. The SIGINT listener exists only while a line is awaited.
// Bytes after the line stay buffered for the next prompt (like sys.stdin's buffer). EOF before any byte is
// EOFError; a final line without a newline is returned. The listener is installed BEFORE `before()` writes the
// prompt: Node's default SIGINT disposition kills the process, so a Ctrl-C right after the prompt appears must
// already find it (CPython's handler is always installed and turns it into KeyboardInterrupt in input()).
const pendingInput = { buffer: Buffer.alloc(0), ended: false };

function readLine(before = () => {}) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let attached = false;
    const finish = () => {
      if (!attached) return;
      attached = false;
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
      process.off('SIGINT', onSigint);
      stdin.pause();
    };
    const take = () => {
      const at = pendingInput.buffer.indexOf(0x0a);
      if (at >= 0) {
        const line = pendingInput.buffer.subarray(0, at);
        pendingInput.buffer = pendingInput.buffer.subarray(at + 1);
        finish();
        resolve(line.toString('utf8'));
        return true;
      }
      if (pendingInput.ended) {
        const rest = pendingInput.buffer;
        pendingInput.buffer = Buffer.alloc(0);
        finish();
        if (rest.length) resolve(rest.toString('utf8'));
        else reject(new EOFError());
        return true;
      }
      return false;
    };
    function onData(chunk) {
      pendingInput.buffer = Buffer.concat([pendingInput.buffer, chunk]);
      take();
    }
    function onEnd() {
      pendingInput.ended = true;
      take();
    }
    function onError(error) {
      finish();
      reject(error);
    }
    function onSigint() {
      finish();
      reject(new KeyboardInterrupt());
    }
    attached = true;
    process.on('SIGINT', onSigint);
    try {
      before();
    } catch (error) {
      finish();
      reject(error);
      return;
    }
    if (take()) return;
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    stdin.resume();
  });
}

/** Injection points for tests (Python's mock.patch targets). */
export const internals = {
  write: (text) => stdout_write(text),
  isatty: () => isatty(0),
  input: (prompt) => readLine(() => {
    // CPython's input() writes the prompt to stderr when stdin and stdout are both terminals (PyOS_Readline).
    if (isatty(0) && isatty(1)) stderr_write(prompt);
    else internals.write(prompt);
    stdout_flush(); // input() flushes sys.stdout before it reads
  }),
  run,
  probe: null, // _probe, set below
  open_settings: null, // _open_settings
  linux_sandbox_works: null,
  mac_instructions: null,
  sys_platform: () => process.platform, // sys.platform
  mac_socket_path_problem: () => mac_socket_path_problem(), // lcu.platforms.mac_socket_path_problem
};

const print = (text = '') => internals.write(text + '\n');

// Python truthiness of a JSON value (pyjson model: Number/BigInt ints, PyFloat floats, Map dicts).
const truthy = (value) => {
  if (value === null || value === undefined || value === false || value === 0 || value === 0n || value === '') return false;
  if (value instanceof PyFloat) return value.value !== 0; // 0.0 and -0.0 are false, NaN is true
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.keys(value).length > 0;
  return true;
};
const orEmpty = (value) => (truthy(value) ? value : {});
const dictGet = (value, key, fallback = null) => {
  if (value instanceof Map) return value.has(key) ? value.get(key) : fallback;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : fallback;
  }
  throw attribute_error_get(value);
};
const first = (text, limit) => Array.from(text).slice(0, limit).join('');
const expectedFailure = (exc) => isOSError(exc) || exc instanceof ValueError || exc instanceof SubprocessError;

export function _bundle_display_name(bundle, fallback) {
  let info;
  try {
    info = plist_loads(readFileSync(pathStr(bundle, 'Contents/Info.plist')));
  } catch (exc) {
    if (isOSError(exc) || exc instanceof InvalidFileException || exc instanceof ValueError) return fallback;
    throw exc;
  }
  for (const key of ['CFBundleDisplayName', 'CFBundleName']) {
    const value = dictGet(info, key);
    if (typeof value === 'string' && pyStrip(value)) return pyStrip(value);
  }
  return fallback;
}

/** Read names from the selected app and its signed helper. */
export function mac_permission_targets(app) {
  const helper = pathStr(app, 'Contents', MAC_HELPER);
  return {
    accessibility: [_bundle_display_name(helper, path.basename(helper)), helper],
    screen_capture: [_bundle_display_name(app, path.basename(pathStr(app))), app],
  };
}

export function _probe(runtime, env, target, { timeout = 25 } = {}) {
  const node = env.NODE_REPL_NODE_PATH;
  if (node === undefined) throw new KeyError("'NODE_REPL_NODE_PATH'");
  const cwd = pathStr(runtime, target === 'windows' ? 'bin' : 'lib');
  const result = internals.run([String(node), '--input-type=module', '-e', PROBE], {
    cwd, env, stdin: 'devnull', capture: true, timeout: timeout * 1000, errors: 'replace',
  });
  if (result.returncode) {
    const detail = first(pyStrip(result.stderr || result.stdout).replaceAll('\n', ' '), 240);
    throw new ValueError(detail || `Original provider exited with status ${result.returncode}.`);
  }
  const lines = pySplitlines(result.stdout).filter((line) => pyStrip(line));
  if (!lines.length) {
    throw new ValueError('Original provider returned no readiness result.');
  }
  let report;
  try {
    report = loads(lines[lines.length - 1]);
  } catch (exc) {
    if (exc instanceof ValueError) throw new ValueError('Original provider returned an unreadable readiness result.');
    throw exc;
  }
  if (!(report instanceof Map)) {
    throw new ValueError('Original provider returned an invalid readiness result.');
  }
  report = toPlain(report, { allowReorder: true });
  const expected = { linux: 'linux', mac: 'mac', darwin: 'mac', windows: 'windows' }[target];
  if (dictGet(report, 'target') !== (expected ?? null)) {
    throw new ValueError(`Original provider target mismatch: expected ${expected ?? 'None'}, received ${pyShown(dictGet(report, 'target'))}.`);
  }
  return report;
}

// str() of a JSON value as an f-string shows it.
function pyShown(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return value;
  return String(value);
}

export function _failure_text(check) {
  const error = orEmpty(dictGet(check, 'error'));
  const code = dictGet(error, 'code');
  const name = dictGet(error, 'name');
  const message = dictGet(error, 'message');
  if (code === -10009 || name === 'permissionsNotGranted') {
    return ('The original runtime reports that a required permission is not granted; ' +
            'it does not identify which macOS permission.');
  }
  if (code === -10014 || name === 'permissionsPending') {
    return 'The original runtime is waiting for a permission decision.';
  }
  if (truthy(message)) {
    return `Original runtime: ${pyShown(message)}`;
  }
  return 'The original runtime did not complete this check.';
}

export function _mac_instructions(app) {
  const targets = mac_permission_targets(app);
  const [accessibility_name, accessibility_path] = targets.accessibility;
  const [screen_name, screen_path] = targets.screen_capture;
  print('macOS privacy status is not available to this CLI. The original Mac API requires');
  print('its connected agent approval before it can inspect an app, so LCU will not inspect one here.');
  print('Review these entries in System Settings > Privacy & Security:');
  print(`  Accessibility: ${accessibility_name} (${accessibility_path})`);
  print(`  Screen & System Audio Recording, or Screen Recording: ${screen_name} (${screen_path})`);
  print('macOS may not list an app until its first approved use. LCU never grants access or opens Settings on its own.');
}

export function _open_settings(url, label) {
  try {
    internals.run(['open', url], { stdin: 'devnull', check: true, timeout: 10000 });
  } catch (exc) {
    if (!expectedFailure(exc)) throw exc;
    print(`Could not open ${label}: ${pyStr(exc)}`);
    print(`Open it manually: ${label}`);
  }
}

async function prompt(text) {
  let choice;
  try {
    choice = pyStrip(await internals.input(text)).toLowerCase();
  } catch (exc) {
    if (!(exc instanceof EOFError || exc instanceof KeyboardInterrupt)) throw exc;
    choice = '';
  }
  return choice;
}

export async function _mac_guidance(app, retry) {
  internals.mac_instructions(app);
  print('\nChoose a settings pane, retry the installed-runtime check, or finish:');
  print('  [a] Open Accessibility settings');
  print('  [s] Open Screen & System Audio Recording settings');
  print('  [r] Recheck original runtime metadata');
  print('  [Enter] Finish');
  for (;;) {
    const choice = await prompt('Choice [a/s/r/Enter]: ');
    if (choice === 'a' || choice === '1') {
      internals.open_settings(MAC_ACCESSIBILITY_SETTINGS,
        'System Settings > Privacy & Security > Accessibility');
    } else if (choice === 's' || choice === '2') {
      internals.open_settings(MAC_SCREEN_CAPTURE_SETTINGS,
        'System Settings > Privacy & Security > Screen & System Audio Recording');
    } else if (choice === 'r') {
      try {
        const probe = retry();
        _print_mac_status(probe);
      } catch (exc) {
        if (!expectedFailure(exc)) throw exc;
        print(`Original runtime check failed: ${pyStr(exc)}`);
        print('This is a runtime/backend failure, not proof that a macOS permission is missing.');
      }
    } else if (choice === '' || choice === 'q' || choice === 'done') {
      break;
    } else {
      print('Choose a, s, r, or press Enter to finish.');
    }
  }
  print('Next: reconnect your agent, open a harmless window such as a blank TextEdit document, and ask it');
  print('to inspect that window with LCU and return a screenshot. Approve the original app request and macOS prompts.');
}

export function _print_mac_status(probe) {
  const provider = orEmpty(dictGet(probe, 'provider'));
  if (truthy(dictGet(provider, 'ok'))) {
    print('Original Mac provider loaded; app listing and app-state methods are available.');
  } else {
    print(`Original Mac provider check failed. ${_failure_text(provider)}`);
  }
  print('macOS privacy permissions: not verified by LCU.');
  return truthy(dictGet(provider, 'ok'));
}

/** Run the check the original node_repl makes: can `codex sandbox` start a confined command here? */
export function linux_sandbox_works(env) {
  env = unshimmed_env(env);
  const codex = env.CODEX_CLI_PATH;
  if (!codex) {
    return [false, 'no Codex executable'];
  }
  const scratch = mkdtemp({ prefix: 'lcu-sandbox-probe-' });
  try {
    const command = [codex, 'sandbox', '-c', 'shell_environment_policy.inherit="all"',
      '-c', 'default_permissions="node_repl"',
      '-c', 'permissions.node_repl={filesystem = {":root" = "read"}, network = {enabled = false}}',
      '--', '/bin/sh', '-c', 'test -r /etc/os-release || exit 10; touch "$1" && exit 11; exit 12',
      'node-repl-sandbox-probe', pathStr(scratch, 'write-must-fail')];
    let result;
    try {
      result = internals.run(command, {
        env, stdin: 'devnull', capture: true, cwd: scratch, timeout: 30000, errors: 'replace',
      });
    } catch (exc) {
      if (!expectedFailure(exc) || exc instanceof ValueError) throw exc;
      return [false, first(pyStr(exc), 200)];
    }
    if (result.returncode === 12) {
      return [true, ''];
    }
    const detail = first(result.stderr.split(/[\s\x1c-\x1f\x85]+/u).filter(Boolean).join(' '), 200);
    return [false, `exit ${result.returncode}` + (detail ? `: ${detail}` : '')];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function print_linux_sandbox_status(env, { works = null } = {}) {
  works = works || internals.linux_sandbox_works;
  const mode = pyStrip(dictGet(env, 'LCU_NODE_REPL_SANDBOX', '')).toLowerCase();
  if (mode === 'host') {
    print('JavaScript sandbox: LCU_NODE_REPL_SANDBOX=host leaves the original runtime behavior. Where ' +
          'bubblewrap works it also confines the Sky desktop service, which then cannot reach X11.');
    return;
  }
  if (mode === 'off') {
    print("JavaScript sandbox: OFF (LCU_NODE_REPL_SANDBOX=off). The kernel that runs the model's " +
          'JavaScript is not sandboxed, unless the agent host asks for one.');
    return;
  }
  const [working, detail] = works(env);
  if (!working) {
    print('JavaScript sandbox: NOT AVAILABLE here (bubblewrap cannot start a sandbox' +
          (detail ? `; ${detail}` : '') + "). The kernel that runs the model's JavaScript is " +
          "not sandboxed on this machine; it has your account's access to files, network and " +
          'processes. Containers and hosts that restrict user namespaces behave this way.');
  } else if (!('LCU_SANDBOX_SHIM' in env)) {
    print("JavaScript sandbox: available, but LCU's launcher shim is missing from this release, so " +
          'the original runtime confines the Sky desktop service too and desktop control will fail.');
  } else {
    print("JavaScript sandbox: active. The kernel that runs the model's JavaScript is confined " +
          '(read-only filesystem, no network; subprocesses it starts are confined too); only the trusted Sky desktop service ' +
          'runs outside it. An agent host that sends a disabled sandbox state gets none.');
  }
}

export function _print_linux_status(probe) {
  const windows = orEmpty(dictGet(probe, 'windows'));
  const screenshot = orEmpty(dictGet(probe, 'screenshot'));
  if (truthy(dictGet(windows, 'ok'))) {
    print(`Window listing: passed (${pyShown(dictGet(windows, 'count', 0))} windows).`);
  } else {
    print(`Window listing: could not verify. ${_failure_text(windows)}`);
  }
  if (truthy(dictGet(screenshot, 'ok'))) {
    print(`Screenshot capture: passed (${pyShown(dictGet(screenshot, 'count', 0))} images); returned image data was discarded by LCU.`);
  } else if (truthy(dictGet(screenshot, 'skipped'))) {
    print('Screenshot capture: not checked because window listing failed.');
  } else {
    print(`Screenshot capture: could not verify. ${_failure_text(screenshot)}`);
  }
  return truthy(truthy(dictGet(windows, 'ok')) && dictGet(screenshot, 'ok'));
}

export async function _linux_guidance(probe, retry) {
  for (;;) {
    if (_print_linux_status(probe)) {
      print('Computer use is ready for the first agent call.');
      return true;
    }
    print('A failed check can be a desktop-service problem; this result alone does not identify a missing permission.');
    print('  [r] Retry the original checks');
    print('  [Enter] Finish');
    const choice = await prompt('Choice [r/Enter]: ');
    if (choice !== 'r') {
      print('Desktop readiness remains incomplete. Rerun lcu doctor after resolving the issue.');
      return false;
    }
    try {
      probe = retry();
    } catch (exc) {
      if (!expectedFailure(exc)) throw exc;
      probe = { windows: { ok: false, error: { message: pyStr(exc) } },
        screenshot: { ok: false, skipped: true } };
    }
  }
}

export function _print_windows_status(probe) {
  const windows = orEmpty(dictGet(probe, 'windows'));
  if (truthy(dictGet(windows, 'ok'))) {
    print(`Original window listing: passed (${pyShown(dictGet(windows, 'count', 0))} windows).`);
  } else {
    print(`Original window listing: could not verify. ${_failure_text(windows)}`);
  }
  print('Screenshot and Windows permission readiness are not verified by this check.');
  return truthy(dictGet(windows, 'ok'));
}

export async function main(root, argv = null, { resolved = null, env = null } = {}) {
  const parser = new ArgumentParser({ description: 'Check the original desktop provider and guide first-use permissions.' });
  parser.add_argument('--non-interactive', { action: 'store_true',
    help: 'Check without prompts or opening System Settings' });
  parser.add_argument('--require-ready', { action: 'store_true',
    help: 'Exit nonzero unless this platform can verify desktop readiness' });
  const args = argv === null ? parser.parse_args() : parser.parse_args(argv);
  if (resolved === null || env === null) {
    resolved = paths(root);
    env = environment(root, resolved);
  }
  const [app, , runtime, metadata] = resolved;
  const installation = () => loads(decode(readFileSync(pathStr(root, 'installation.json'))));
  const platform_name = dictGet(installation(), 'platform', 'linux');
  const target = platform_name === 'darwin' ? 'mac' : platform_name;
  const interactive = internals.isatty() && !args.non_interactive;
  print(`Original app: ChatGPT ${dictGet(metadata, 'version')} (CUA ${dictGet(metadata, 'runtime')}).`);
  report_tested_pair(root, { metadata, file: { write: (text) => internals.write(text) } });
  let changed;
  try {
    changed = changed_since_install(installation(), metadata);
  } catch (exc) {
    if (!(isOSError(exc) || exc instanceof ValueError)) throw exc;
    changed = null;
  }
  if (changed) {
    print(`Warning: ${changed}`);
  }
  const update_line = status_line(root);
  if (update_line) {
    print(update_line);
  }
  print(diagnostic_log_summary());
  // (U3: the diagnostic-log summary line is printed here, before the macOS socket check.)
  if (target === 'mac' && internals.sys_platform() === 'darwin') {
    // The helper runs on this host; a test or tool inspecting a macOS install elsewhere has no home to check.
    const problem = internals.mac_socket_path_problem();
    if (problem) {
      print(problem);
      return 2;
    }
  }
  if (target === 'linux') {
    print_linux_sandbox_status(env);
  }
  if (target === 'linux' && (!env.DISPLAY || !env.DBUS_SESSION_BUS_ADDRESS)) {
    const message = ('A live X11 DISPLAY and DBUS_SESSION_BUS_ADDRESS are required. ' +
                     'Use lcu-session or run inside the desktop session.');
    print(`Window listing: could not verify. ${message}`);
    print('Screenshot capture: not checked because window listing could not start.');
    return 2;
  }
  let probe;
  try {
    probe = internals.probe(runtime, env, target);
  } catch (exc) {
    if (!expectedFailure(exc)) throw exc;
    print(`Original provider check failed: ${pyStr(exc)}`);
    if (target === 'mac') {
      print('This is a runtime/backend failure; it does not prove that a macOS permission is missing.');
      if (interactive) {
        await _mac_guidance(app, () => internals.probe(runtime, env, target));
        return 2;
      }
      internals.mac_instructions(app);
      print('Next: reconnect your agent and make the first approved LCU screenshot call to verify access.');
    }
    return 2;
  }
  if (target === 'linux') {
    let ready;
    if (interactive) {
      ready = await _linux_guidance(probe, () => internals.probe(runtime, env, target));
    } else {
      ready = _print_linux_status(probe);
      if (ready) {
        print('Computer use is ready for the first agent call.');
      }
    }
    if (args.require_ready && !ready) {
      return 2;
    }
    return ready ? 0 : 2;
  }
  if (target === 'windows') {
    const windows_ok = _print_windows_status(probe);
    if (args.require_ready) {
      print('Next: verify an approved screenshot call through the connected agent.');
      return 2;
    }
    if (!windows_ok) {
      return 2;
    }
    return 0;
  }
  if (target === 'mac') {
    const provider_ok = _print_mac_status(probe);
    if (interactive) {
      await _mac_guidance(app, () => internals.probe(runtime, env, target));
    } else {
      internals.mac_instructions(app);
      print('Next: reconnect your agent and make the first approved LCU screenshot call to verify access.');
    }
    if (args.require_ready) {
      print('macOS permission grants cannot be verified by this check; readiness stays unconfirmed.');
      return 2;
    }
    return provider_ok ? 0 : 2;
  }
  const provider = orEmpty(dictGet(probe, 'provider'));
  print(`Original desktop provider: could not verify. ${_failure_text(provider)}`);
  return 2;
}

internals.probe = _probe;
internals.open_settings = _open_settings;
internals.linux_sandbox_works = linux_sandbox_works;
internals.mac_instructions = _mac_instructions;
