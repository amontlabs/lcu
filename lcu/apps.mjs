// Manage the apps that Computer Use may always control, behind owner authentication (macOS).
//
// Port of lcu/apps.py. Python-only behaviours go through lcu/compat: unicode.mjs (str.casefold, ljust and sort by
// code point), plist.mjs (plistlib; binary plists via `plutil`), pyjson.mjs (json bytes), pathlib.mjs,
// tempfile.mjs, argparse.mjs. `hooks` holds the injection points the Python tests reach with mock.patch
// (app_directories, _mdfind, os.fsync, time.sleep); production code never replaces them.
import { spawnSync } from './compat/spawn.mjs';
import {
  accessSync, chmodSync, closeSync, constants, fsyncSync, mkdirSync, readdirSync, readFileSync, renameSync,
  statSync, unlinkSync, writeSync,
} from 'node:fs';
import { constants as osConstants } from 'node:os';

import { ArgumentParser, io, PySystemExit, pySplitlines, pyStrip, RawDescriptionHelpFormatter } from './compat/argparse.mjs';
import { pathExpanduser, expanduser, pathStr } from './compat/pathlib.mjs';
import { fromNodeError, pyStr } from './compat/pyerr.mjs';
import { dumps, isDict, loads, UnicodeEncodeError, ValueError } from './compat/pyjson.mjs';
import { loads as plistLoads, ExpatError, InvalidFileException } from './compat/plist.mjs';
import { mkstemp } from './compat/tempfile.mjs';
import { execError, preflight } from './compat/execve.mjs';
import { TimeoutExpired } from './compat/subprocess.mjs';
import { casefold, compare, len, ljust, stem } from './compat/unicode.mjs';

export const KEY = 'approvedBundleIdentifiers';
export const STORE = 'Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/'
  + 'Library/Application Support/Software/ComputerUseAppApprovals.json';
export const HELPER = 'bin/lcu-owner-auth';

// The original runtime refuses these before it asks anyone, so an entry would never take effect.
export const FORBIDDEN = {
  'com.apple.Terminal': 'Terminal', 'com.googlecode.iterm2': 'iTerm2',
  'com.openai.codex': 'ChatGPT', 'com.apple.UserNotificationCenter': 'Notification Center',
};
// The original runtime marks these "Elevated Risk" (browsers, password managers, iPhone Mirroring).
export const HIGH_RISK = new Set([
  'com.apple.Safari', 'com.google.Chrome', 'app.zen-browser.zen', 'com.apple.Passwords',
  'com.apple.keychainaccess', 'com.apple.ScreenContinuity', 'org.mozilla.firefox',
  'com.microsoft.edgemac', 'com.brave.Browser', 'company.thebrowser.Browser',
  'com.operasoftware.Opera', 'com.vivaldi.Vivaldi', 'org.chromium.Chromium',
  'com.1password.1password', 'com.bitwarden.desktop',
]);
export const RISK_NOTE = ('This app is marked high risk by Computer Use (browsers, password managers and iPhone '
  + 'Mirroring are): content it shows can carry prompt injection, and the agent can read '
  + 'or change what it holds. Watch the agent while it uses this app.');

export const AUTH_TIMEOUT = 300;
export const WRITE_ATTEMPTS = 8;

const sleepSync = (seconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);

export const hooks = {
  app_directories: (home = null) => _app_directories(home),
  _mdfind: (query) => _mdfind(query),
  fsync: (fd) => fsyncSync(fd),
  sleep: sleepSync,
};

const print = (text = '') => io.stdout(`${text}\n`);
const printError = (text = '') => io.stderr(`${text}\n`);

/** A problem to show the user without a traceback. */
export class AppsError extends ValueError {
  constructor(message) {
    super(message);
    this.name = 'AppsError';
  }
}

const homeDirectory = () => expanduser('~');

export function store_path(home = null) {
  return pathStr(home || homeDirectory(), STORE);
}

const isFile = (path) => {
  try { return statSync(path).isFile(); } catch { return false; }
};
const isDir = (path) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};
const exists = (path) => {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EBADF', 'ELOOP'].includes(error.code)) return false;
    throw error;
  }
};
const dirname = (path) => pathStr(path).replace(/\/?[^/]*$/, '') || (pathStr(path).startsWith('/') ? '/' : '.');
const basename = (path) => pathStr(path).split('/').at(-1);
const arrayEqual = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);

/** (raw bytes or null, parsed document, ids). A damaged file is never overwritten. */
export function read_store(path) {
  let raw;
  try {
    raw = readFileSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return [null, new Map(), []];
    const converted = fromNodeError(error);
    if (converted) throw new AppsError(`cannot read ${path}: ${converted.strerror || converted.message}`);
    throw error;
  }
  let document;
  try {
    document = loads(raw);
  } catch (error) {
    if (!(error instanceof ValueError)) throw error;
    document = null;
  }
  const ids = isDict(document) ? (document.has(KEY) ? document.get(KEY) : []) : null;
  if (!Array.isArray(ids) || !ids.every((item) => typeof item === 'string')) {
    throw new AppsError(`${path} is not a valid approvals file (expected {"${KEY}": [bundle ids]}); `
      + 'leaving it untouched. Move it aside to start from an empty list.');
  }
  return [raw, document, ids];
}

const wellFormed = (text) => (typeof text.isWellFormed === 'function' ? text.isWellFormed()
  : !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text));

/**
 * The first piece of text json.dump(indent=2, ensure_ascii=False) hands to the stream that a strict UTF-8
 * encoder rejects, or null. Python's pure-Python encoder writes a dict key or string value as its own chunk
 * ('"..."') and a string list item as '[' or ',' + newline + indent + '"..."'; the UnicodeEncodeError position
 * is counted inside that chunk.
 */
function unencodableChunk(value, level) {
  const quoted = (text) => dumps(text, { ensure_ascii: false });
  if (typeof value === 'string') return wellFormed(value) ? null : quoted(value);
  if (isDict(value)) {
    for (const [key, item] of value) {
      if (typeof key === 'string' && !wellFormed(key)) return quoted(key);
      const found = unencodableChunk(item, level + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (Array.isArray(value)) {
    const indent = `\n${' '.repeat(2 * (level + 1))}`;
    for (const [index, item] of value.entries()) {
      if (typeof item === 'string') {
        if (!wellFormed(item)) return `${index ? ',' : '['}${indent}${quoted(item)}`;
      } else {
        const found = unencodableChunk(item, level + 1);
        if (found !== null) return found;
      }
    }
  }
  return null;
}

/**
 * Apply `change(ids) -> ids` with an atomic replace that tolerates the runtime writing too.
 *
 * The runtime does not share a lock with LCU, so the file is re-read just before the replace
 * and again afterwards. If either read shows another writer got in, the change is recomputed
 * from the new content. Keys other than the approved list are preserved.
 */
export function modify(path, change, { attempts = WRITE_ATTEMPTS, sleep = hooks.sleep } = {}) {
  path = pathStr(path);
  const parent = dirname(path);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const [raw, document, ids] = read_store(path);
    const updated = change([...ids]);
    if (arrayEqual(updated, ids) && raw !== null) return ids;
    const copy = new Map(document);
    copy.set(KEY, updated);
    mkdirSync(parent, { recursive: true });
    const { fd, path: temporary } = mkstemp({ prefix: `.${basename(path)}.`, dir: parent });
    try {
      let descriptor = fd;
      try {
        const text = `${dumps(copy, { indent: 2, ensure_ascii: false })}\n`;
        // Python's strict UTF-8 text stream refuses a lone surrogate (UnicodeEncodeError) while json.dump
        // writes; the store is then left untouched and only the staged file (removed below) was written.
        const chunk = unencodableChunk(copy, 0);
        if (chunk !== null) throw new UnicodeEncodeError(chunk);
        const bytes = Buffer.from(text, 'utf8');
        for (let offset = 0; offset < bytes.length;) offset += writeSync(descriptor, bytes, offset);
        hooks.fsync(descriptor);
      } finally {
        closeSync(descriptor);
        descriptor = null;
      }
      try {
        chmodSync(temporary, statSync(path).mode & 0o777);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const current = exists(path) ? readFileSync(path) : null;
      if (!(current === null && raw === null) && !(current !== null && raw !== null && current.equals(raw))) continue;
      renameSync(temporary, path);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    sleep(attempt ? 0.05 * (attempt + 1) : 0.05);
    if (arrayEqual(read_store(path)[2], updated)) return updated;
  }
  throw new AppsError(`${path} kept changing while it was being updated; try again.`);
}

// App lookup ------------------------------------------------------------------------------------

function _app_directories(home = null) {
  home = pathStr(home || homeDirectory());
  return ['/Applications', '/Applications/Utilities', '/System/Applications',
    '/System/Applications/Utilities', pathStr(home, 'Applications')];
}

export function app_directories(home = null) {
  return hooks.app_directories(home);
}

const truthy = (value) => !(value === undefined || value === null || value === false || value === '' || value === 0n
  || value === 0 || (Array.isArray(value) && !value.length) || (value instanceof Map && !value.size));

function text(value) {
  if (typeof value === 'string') return value;
  if (value === true) return 'True';
  return String(value);
}

/** (bundle id, display name) of an .app directory, or null when it is not a bundle. */
export function bundle_info(app) {
  let info;
  try {
    info = plistLoads(readFileSync(`${pathStr(app)}/Contents/Info.plist`));
  } catch (error) {
    if (error instanceof InvalidFileException || error instanceof ValueError || error instanceof ExpatError
        || fromNodeError(error)) return null;
    throw error;
  }
  if (!(info instanceof Map)) return null; // plistlib would raise AttributeError (a traceback) for a non-dict root
  const identifier = info.get('CFBundleIdentifier');
  if (typeof identifier !== 'string' || !identifier) return null;
  let name = info.get('CFBundleDisplayName');
  if (!truthy(name)) name = info.get('CFBundleName');
  if (!truthy(name)) name = stem(basename(app));
  return [identifier, text(name)];
}

function _mdfind(query) {
  const done = spawnSync('/usr/bin/mdfind', [query], {
    encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 1 << 30,
  });
  if (done.error) return [];
  return pySplitlines(done.stdout ?? '').filter((line) => line.endsWith('.app')).map((line) => pathStr(line));
}

const _quote = (value) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

/** Prefer the standard application folders, then the shortest path. */
function _best(candidates, directories) {
  const standard = new Set(directories.map((directory) => pathStr(directory)));
  const rank = (app) => [standard.has(dirname(app)) ? 0 : 1, len(app), app];
  return [...candidates].sort((a, b) => {
    const x = rank(a);
    const y = rank(b);
    return (x[0] - y[0]) || (x[1] - y[1]) || compare(x[2], y[2]);
  });
}

const listApps = (directory) => readdirSync(directory).sort(compare).filter((entry) => entry.endsWith('.app'));

/** Where the app with this bundle id is installed, or null. */
export function find_by_id(identifier, directories) {
  const standard = [];
  for (const directory of directories) {
    if (!isDir(directory)) continue;
    for (const entry of listApps(directory)) standard.push(pathStr(directory, entry));
  }
  const idOf = (app) => (bundle_info(app) ?? [''])[0];
  let candidates = standard.filter((app) => idOf(app) === identifier);
  if (!candidates.length) {
    candidates = hooks._mdfind(`kMDItemCFBundleIdentifier == "${_quote(identifier)}"`)
      .filter((app) => idOf(app) === identifier);
  }
  return candidates.length ? _best(candidates, directories)[0] : null;
}

export function display_name(identifier, directories) {
  const app = find_by_id(identifier, directories);
  const info = app ? bundle_info(app) : null;
  return info ? info[1] : null;
}

/** (bundle id, display name, installed) for an app name, a bundle id or an .app path. */
export function resolve(query, { home = null } = {}) {
  const directories = app_directories(home);
  const path = pathExpanduser(query);
  if (query.endsWith('.app') || query.endsWith('.app/') || query.includes('/')) {
    if (!isDir(path)) throw new AppsError(`${query} is not an application bundle.`);
    const info = bundle_info(path);
    if (!info) throw new AppsError(`${query} has no bundle identifier in Contents/Info.plist.`);
    return [info[0], info[1], true];
  }
  const wanted = casefold(query);
  const matches = new Map();
  const remember = (info, app) => {
    if (!matches.has(info[0])) matches.set(info[0], [info[1], app]);
  };
  for (const directory of directories) {
    if (!isDir(directory)) continue;
    for (const entry of listApps(directory)) {
      const app = pathStr(directory, entry);
      const info = bundle_info(app);
      if (info && (wanted === casefold(entry.slice(0, -4)) || wanted === casefold(info[1]))) remember(info, app);
    }
  }
  if (!matches.size) {
    const found = hooks._mdfind(`kMDItemKind == "Application" && kMDItemDisplayName == "${_quote(query)}"c`);
    for (const app of found) {
      const info = bundle_info(app);
      if (info) remember(info, app);
    }
  }
  if (!matches.size && query.includes('.')) {
    const app = find_by_id(query, directories);
    const info = app ? bundle_info(app) : null;
    if (info) return [info[0], info[1], true];
    return [query, query, false];
  }
  if (!matches.size) {
    throw new AppsError(`no installed app named "${query}". Pass its bundle identifier or the path to its .app.`);
  }
  if (matches.size > 1) {
    const options = [...matches.entries()].sort((a, b) => compare(a[0], b[0]))
      .map(([identifier, [, app]]) => `${identifier} (${app})`).join(', ');
    throw new AppsError(`"${query}" matches several apps: ${options}. Pass the bundle identifier or path.`);
  }
  const [[identifier, [name]]] = matches;
  return [identifier, name, true];
}

/** Like resolve, but a name or id that matches an approved entry wins, even if uninstalled. */
export function resolve_approved(query, ids, { home = null } = {}) {
  if (ids.includes(query)) return [query, display_name(query, app_directories(home)) || query];
  const directories = app_directories(home);
  const wanted = casefold(query);
  const named = ids.filter((id) => casefold(display_name(id, directories) || '') === wanted);
  if (named.length === 1) return [named[0], display_name(named[0], directories)];
  try {
    const [identifier, name] = resolve(query, { home });
    return [identifier, name];
  } catch (error) {
    if (!(error instanceof AppsError)) throw error;
    if (named.length) throw new AppsError(`"${query}" matches several approved apps: ${named.join(', ')}.`);
    throw new AppsError(`"${query}" is not among the approved apps. Run \`lcu apps\` to see them.`);
  }
}

// Authentication --------------------------------------------------------------------------------

/** Ask macOS for Touch ID or the login password. Throws AppsError unless the owner approved. */
export function authenticate(root, reason) {
  const helper = pathStr(root, HELPER);
  let executable = false;
  try {
    accessSync(helper, constants.X_OK);
    executable = true;
  } catch { /* not executable */ }
  if (!isFile(helper) || !executable) {
    throw new AppsError(`the owner-authentication helper is missing (${helper}); reinstall this LCU release. `
      + 'Nothing was changed.');
  }
  printError('Waiting for Touch ID or your password...');
  const command = [helper, '--reason', reason];
  // Python's subprocess execs the helper and reports exec failures (e.g. a text file without "#!" is ENOEXEC).
  // Node's spawn would hand such a file to /bin/sh instead, so the exec outcome is checked first.
  const failure = preflight(helper, command, process.env);
  if (failure) {
    throw new AppsError(`could not run the owner-authentication helper: ${execError(failure, helper).message}. `
      + 'Nothing was changed.');
  }
  const done = spawnSync(helper, ['--reason', reason], {
    stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: AUTH_TIMEOUT * 1000, killSignal: 'SIGKILL',
    maxBuffer: 1 << 30,
  });
  if (done.error) {
    let exc;
    if (done.error.code === 'ETIMEDOUT') exc = new TimeoutExpired(command, AUTH_TIMEOUT * 1000).message;
    else exc = fromNodeError(done.error, { filename: helper })?.message ?? pyStr(done.error);
    throw new AppsError(`could not run the owner-authentication helper: ${exc}. Nothing was changed.`);
  }
  const returncode = done.status ?? -(osConstants.signals[done.signal] ?? 0);
  if (returncode === 0) return;
  if (returncode === 1) throw new AppsError('authentication was cancelled or failed. Nothing was changed.');
  const detail = pyStrip(done.stderr ?? '') || `exit status ${returncode}`;
  throw new AppsError(`cannot ask for authentication: ${detail}. Run this from a terminal in your `
    + 'logged-in desktop session. Nothing was changed.');
}

// Commands --------------------------------------------------------------------------------------

export function describe(identifier, directories) {
  const name = display_name(identifier, directories);
  return {
    name: name || identifier, bundleId: identifier, installed: name !== null,
    risk: HIGH_RISK.has(identifier) ? 'high' : 'normal',
    blocked: Object.hasOwn(FORBIDDEN, identifier),
  };
}

export function command_list(args, { home }) {
  const path = store_path(home);
  const [, , ids] = read_store(path);
  const directories = app_directories(home);
  const apps = ids.map((identifier) => describe(identifier, directories))
    .sort((a, b) => compare(casefold(a.name), casefold(b.name)) || compare(a.bundleId, b.bundleId));
  if (args.get('json')) {
    print(dumps({ apps, file: String(path) }, { indent: 2 }));
    return 0;
  }
  if (!apps.length) {
    print('No apps are always allowed for Computer Use.\nAllow one with: lcu apps allow <app>');
    return 0;
  }
  const width = Math.max(...apps.map((app) => len(app.name)));
  for (const app of apps) {
    const notes = [];
    if (app.risk === 'high') notes.push('high risk');
    if (app.blocked) notes.push('blocked: Computer Use refuses this app');
    if (!app.installed) notes.push('not installed');
    const suffix = notes.length ? `  (${notes.join('; ')})` : '';
    print(`${ljust(app.name, width)}  ${app.bundleId}${suffix}`);
  }
  return 0;
}

export function command_allow(args, { root, home, auth }) {
  const path = store_path(home);
  const [identifier, name, installed] = resolve(args.get('app'), { home });
  const label = `${name} (${identifier})`;
  if (Object.hasOwn(FORBIDDEN, identifier)) {
    throw new AppsError(`Computer Use never controls ${FORBIDDEN[identifier]} (${identifier}), `
      + 'so approving it would have no effect. Nothing was changed.');
  }
  if (!installed) {
    throw new AppsError(`${identifier} is not installed here; Computer Use would reject it as an invalid app.`);
  }
  if (read_store(path)[2].includes(identifier)) {
    print(`${label} is already always allowed.`);
    return 0;
  }
  const risky = HIGH_RISK.has(identifier);
  if (risky) printError(`Warning: ${RISK_NOTE}`);
  auth(root, `always allow Computer Use to control ${label}${risky ? ' (high risk)' : ''}`);
  modify(path, (ids) => (ids.includes(identifier) ? ids : [...ids, identifier]));
  print(`Always allowed: ${label}. Running sessions pick this up immediately.`);
  return 0;
}

export function command_revoke(args, { root, home, auth }) {
  const path = store_path(home);
  const ids = read_store(path)[2];
  const [identifier, name] = resolve_approved(args.get('app'), ids, { home });
  const label = name !== identifier ? `${name} (${identifier})` : identifier;
  if (!ids.includes(identifier)) {
    print(`${label} is not in the always-allowed list.`);
    return 0;
  }
  auth(root, `stop always allowing Computer Use to control ${label}`);
  modify(path, (current) => current.filter((item) => item !== identifier));
  print(`Removed: ${label}. Computer Use asks again the next time it needs this app.`);
  return 0;
}

export const USAGE = ('lcu apps [list] [--json]\n'
  + '       lcu apps allow <app>\n'
  + '       lcu apps revoke <app>');

export function parser() {
  const top = new ArgumentParser({
    prog: 'lcu apps', usage: USAGE, formatter_class: RawDescriptionHelpFormatter,
    description: 'Manage the apps Computer Use may always control, without the Codex app.',
    epilog: '<app> is an app name ("Zed"), a bundle identifier (dev.zed.Zed) or the path to an .app.\n'
      + 'allow and revoke ask for Touch ID or your login password; list does not.',
  });
  const sub = top.add_subparsers({ dest: 'action' });
  const listing = sub.add_parser('list', { usage: 'lcu apps list [--json]', help: 'show the always-allowed apps' });
  listing.add_argument('--json', { action: 'store_true', help: 'print JSON instead of a table' });
  for (const [name, summary] of [['allow', 'always allow an app (asks for Touch ID or your password)'],
    ['revoke', 'remove an app (asks for Touch ID or your password)']]) {
    const command = sub.add_parser(name, { usage: `lcu apps ${name} <app>`, help: summary });
    command.add_argument('app', { help: 'app name, bundle identifier or .app path' });
  }
  return top;
}

export function main(root, argv, { platform = null, home = null, auth = authenticate } = {}) {
  platform = platform || process.platform;
  if (platform.startsWith('linux')) {
    printError('lcu apps is macOS-only. The Linux computer-use runtime has no per-app approval: '
      + 'your harness\'s own tool approval is the only gate, so there is no list to manage. '
      + 'See docs/ADAPTERS.md.');
    throw new PySystemExit(1);
  }
  if (platform !== 'darwin') {
    printError('lcu apps is not supported on Windows.');
    throw new PySystemExit(1);
  }
  const argumentsList = [...argv];
  if (!argumentsList.length || (argumentsList[0].startsWith('-') && !['-h', '--help'].includes(argumentsList[0]))) {
    argumentsList.unshift('list');
  }
  const args = parser().parse_args(argumentsList);
  const handler = { list: command_list, allow: command_allow, revoke: command_revoke }[args.get('action') || 'list'];
  if (args.get('action') === null) args.set('json', false);
  let status;
  try {
    status = handler(args, { root, home, auth });
  } catch (error) {
    if (!(error instanceof AppsError)) throw error;
    printError(`lcu apps: ${error.message}`);
    throw new PySystemExit(1);
  }
  if (status) throw new PySystemExit(status);
}
