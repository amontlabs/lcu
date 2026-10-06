// Report the installed LCU release, the selected app and whether the pair is tested.
// Port of lcu/status.py. `main` is async only because lcu/runtime.mjs awaits every sub-command.
// Loaded JSON follows compat/pyjson (dict -> Map); the setup state and update notice that sibling modules
// return may be Maps or plain objects, so they are read through `get` and printed through pyjson.dumps.
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';

import { ArgumentParser, PySystemExit } from './compat/argparse.mjs';
import { io } from './compat/argparse.mjs';
import { dumps, JSONDecodeError, loads, ValueError } from './compat/pyjson.mjs';
import { pathExpanduser, pathStr } from './compat/pathlib.mjs';
import { fromNodeError, isOSError, pyStr } from './compat/pyerr.mjs';
import { decode } from './compat/utf8.mjs';
import { paths } from './runtime.mjs';
import * as diagnostic_log from './diagnostic_log.mjs';
import * as tested from './tested.mjs';
import * as update from './update.mjs';
import { load_setup_state, setup_state_path } from './setup.mjs';

export const DOC = 'Report the installed LCU release, the selected app and whether the pair is tested.';

/** Test injection points (Python's mock.patch targets). */
export const internals = {
  saved_setup: () => saved_setup(),
  paths: (root, descriptor) => paths(root, descriptor),
};

const get = (dict, key, fallback = null) => {
  if (dict instanceof Map) return dict.has(key) ? dict.get(key) : fallback;
  return dict !== null && typeof dict === 'object' && Object.hasOwn(dict, key) ? dict[key] : fallback;
};
const truthy = (value) => {
  if (value === null || value === undefined || value === false || value === '' || value === 0 || value === 0n) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
};
class KeyError extends Error {
  constructor(key) {
    super(`'${key}'`);
    this.name = 'KeyError';
  }
}
const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const read_text = (path) => {
  let data;
  try {
    data = readFileSync(path);
  } catch (exc) {
    throw fromNodeError(exc, { filename: path }) ?? exc;
  }
  return decode(data);
};
const named = (exc, names) => {
  for (let cls = exc?.constructor; cls && cls !== Object; cls = Object.getPrototypeOf(cls)) {
    if (names.includes(cls.name)) return true;
  }
  return names.includes(exc?.name);
};
const is_os_error = isOSError;
const print = (text, file = 'stdout') => io[file](`${text}\n`);

/** The signed-in account's remembered opt-ins, or null when none are saved or readable. */
export function saved_setup() {
  try {
    const home = pathExpanduser('~');
    if (!isFile(setup_state_path(home))) return null;
    return load_setup_state(home);
  } catch (exc) {
    // (ValueError, OSError, RuntimeError)
    if (exc instanceof ValueError || named(exc, ['ValueError', 'PyValueError', 'RuntimeError', 'JSONDecodeError',
      'UnicodeDecodeError']) || is_os_error(exc)) return null;
    throw exc;
  }
}

/** Machine-readable status for one release; throws ValueError if the app cannot be read. */
export function collect(root) {
  root = pathStr(root);
  const descriptor_path = pathStr(root, 'installation.json');
  if (!isFile(descriptor_path)) {
    throw new ValueError(`No application is selected for this release: ${descriptor_path} is missing.`);
  }
  const descriptor = loads(read_text(descriptor_path));
  const bundle = pathStr(root, 'bundle.json');
  let version = 'source-checkout';
  if (isFile(bundle)) {
    const parsed = loads(read_text(bundle));
    if (!(parsed instanceof Map) || !parsed.has('version')) throw new KeyError('version');
    version = parsed.get('version');
  }
  const resolved = internals.paths(root, descriptor);
  const observed = tested.observe(root, descriptor, resolved[3]);
  const changed = tested.changed_since_install(descriptor, {
    version: observed.app_version, runtime: observed.runtime });
  const saved = internals.saved_setup();
  return {
    lcu_version: version,
    release: root,
    platform: observed.platform,
    architecture: observed.architecture,
    app: { path: String(resolved[0]), version: observed.app_version, runtime: observed.runtime },
    compatibility: tested.assess(root, observed),
    changed_since_install: changed,
    setup: saved,
    pending: truthy(saved) ? get(saved, 'pending') : [],
    update: update.cached_notice(root),
    diagnostic_log: diagnostic_log.status(),
  };
}

export async function main(root, argv = null) {
  const parser = new ArgumentParser({ prog: 'lcu status', description: DOC });
  parser.add_argument('--json', { action: 'store_true', help: 'Print one JSON object instead of text' });
  const args = parser.parse_args(argv);
  let status;
  try {
    status = collect(root);
  } catch (exc) {
    // (ValueError, OSError, KeyError, json.JSONDecodeError)
    if (!(exc instanceof ValueError || exc instanceof JSONDecodeError ||
          named(exc, ['ValueError', 'PyValueError', 'KeyError', 'JSONDecodeError', 'UnicodeDecodeError']) || is_os_error(exc))) {
      throw exc;
    }
    if (args.json) {
      print(dumps({ error: pyStr(exc) }));
    } else {
      print(`lcu status: ${pyStr(exc)}`, 'stderr');
    }
    throw new PySystemExit(1);
  }
  if (args.json) {
    print(dumps(status, { indent: 2 }));
    return;
  }
  const app = status.app;
  print(`LCU ${status.lcu_version} (${status.platform} ${status.architecture}).`);
  print(`Original app: ChatGPT ${app.version} (CUA ${app.runtime}) at ${app.path}.`);
  print(tested.status_lines(status.compatibility).join('\n'));
  if (status.changed_since_install) {
    print(`Warning: ${status.changed_since_install}`);
  }
  const saved = status.setup;
  if (truthy(saved)) {
    print(`Saved setup: chrome ${truthy(get(saved, 'chrome')) ? 'on' : 'off'}, audio ${truthy(get(saved, 'audio')) ? 'on' : 'off'}, ` +
          `approval ${get(saved, 'approval')}.`);
    if (truthy(get(saved, 'pending'))) {
      print('Pending harnesses (not installed yet; `lcu setup --reconcile` registers them): ' +
            get(saved, 'pending').join(', ') + '.');
    }
  }
  if (truthy(status.update)) {
    const line = update.status_line(root);
    print(line === null || line === undefined ? 'None' : line);
  }
  print(diagnostic_log.summary());
}
