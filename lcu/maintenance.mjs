// `lcu prune`: drop superseded release and app generations to reclaim space.
//
// Each install publishes a new `<prefix>/releases/<name>`. Windows also keeps a
// private app generation under `<prefix>/apps/`; LCU 0.7.0 and earlier did the
// same on Linux, which now uses the installed app in place. Nothing removes old
// generations automatically. Pruning keeps the current release plus the most
// recent others and every app generation a kept release still references, so
// it also reclaims Linux app copies left by earlier versions. It refuses to
// touch anything that does not match the layout the installers create.
//
// Port of lcu/maintenance.py. The `.lcu-install` lock is taken through compat/lock.mjs on a descriptor
// opened exactly like Python's `open(path, 'a')` (flock(1) / lockf(1) on that open file description).

import { ArgumentParser, io, types } from './compat/argparse.mjs';
import { acquireSync, APPEND_LOCK_FILE } from './compat/lock.mjs';
import { flavour, IDENTITY } from './compat/flavour.mjs';
import { rmtree } from './compat/shutil.mjs';
import { compare } from './compat/unicode.mjs';
import { isDict, loads, ValueError } from './compat/pyjson.mjs';
import { attribute_error_get } from './compat/pystr.mjs';

// Release dirs are `<version>-<uuid[:12]>`; Linux app generations are
// `<version>-<arch>-<digest[:16]>`; Windows app generations are a bare sha256.
// (Python's `.` excludes only "\n"; JavaScript's also excludes "\r", U+2028 and U+2029, hence [^\n].)
export const _RELEASE = /^[^\n]+-[0-9a-f]{12}$/;
export const _LINUX_APP = /^[^\n]+-(?:arm64|x64)-[0-9a-f]{16}$/;
export const _WINDOWS_APP = /^[0-9a-f]{64}$/;

const print = (text = '') => io.stdout(`${text}\n`);

/**
 * Python's pathlib follows the host OS (PureWindowsPath on Windows). Tests may select the Windows flavour on a POSIX
 * host and map its drive to a temporary directory (compat/flavour.mjs); production never changes these.
 */
export const hooks = {
  windows_paths: () => process.platform === 'win32',
  native: () => IDENTITY,
};
const F = flavour({ windows: () => hooks.windows_paths(), native: () => hooks.native() });
const { lstatSync, readdirSync, readFileSync, statSync } = F.fs;
const join = (...parts) => F.join(...parts);
const parent = (path) => F.parent(path);
const name = (path) => F.name(path);
const resolve = (path) => F.resolve(path);

const lstatOrNull = (path) => {
  try { return lstatSync(path); } catch { return null; }
};
const isSymlink = (path) => {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
};
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

/** Python's AttributeError for `.get` on a JSON value that is not an object (an uncaught traceback there). */
function pyGet(document, key, fallback = null) {
  if (isDict(document)) return document.has(key) ? document.get(key) : fallback;
  throw attribute_error_get(document);
}

/** Python's `f'{value:.1f}'` for value = size / 1024**k, exact (round half to even on the exact quotient). */
function fixed1(size, k) {
  const numerator = BigInt(size) * 10n;
  const denominator = 1024n ** BigInt(k);
  let quotient = numerator / denominator;
  const twice = (numerator % denominator) * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n;
  return `${quotient / 10n}.${quotient % 10n}`;
}

export function _human(size) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  for (let k = 0; ; k++) {
    const unit = units[k];
    if (size / 1024 ** k < 1024 || unit === 'TiB') {
      return unit === 'B' ? `${BigInt(size)} ${unit}` : `${fixed1(size, k)} ${unit}`;
    }
  }
}

export function _tree_size(path) {
  let total = lstatSync(path).size;
  const pending = [path];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue; // os.walk ignores directories it cannot list
    }
    for (const entry of entries) {
      const child = join(directory, entry.name);
      try {
        total += lstatSync(child).size;
      } catch { /* an entry that cannot be examined adds nothing */ }
      if (entry.isDirectory()) pending.push(child);
    }
  }
  return total;
}

/** Resolve the current release pointer and confirm it lands in releases. */
export function _release_current(prefix, releases, windows) {
  if (windows) {
    const pointer = join(prefix, 'current.json');
    if (isSymlink(pointer) || !isFile(pointer)) throw new ValueError(`Not an LCU installation: missing ${pointer}`);
    const release = pyGet(loads(readFileSync(pointer, 'utf8')), 'release');
    if (typeof release !== 'string' || release.includes('/') || release.includes('\\') || ['', '.', '..'].includes(release)) {
      throw new ValueError('Invalid current.json release pointer.');
    }
    const current = join(releases, release);
    if (isSymlink(current) || !isDir(current)) throw new ValueError('current.json does not point at a release directory.');
    return current;
  }
  const pointer = join(prefix, 'current');
  if (!isSymlink(pointer)) throw new ValueError(`Not an LCU installation: ${pointer} is not a symlink`);
  const current = resolve(pointer);
  if (!F.same(parent(current), resolve(releases)) || !isDir(current)) {
    throw new ValueError('current does not resolve into <prefix>/releases.');
  }
  return current;
}

/** Return matching child directories, refusing unexpected non-dot entries. */
export function _entries(directory, pattern) {
  const found = [];
  for (const child of readdirSync(directory).sort(compare)) {
    if (child.startsWith('.')) continue; // Transient install staging (.app-stage-*, .<hex>).
    const path = join(directory, child);
    if (isSymlink(path) || !isDir(path) || !pattern.test(child)) {
      throw new ValueError(`Refusing to prune: unexpected entry ${path}`);
    }
    found.push(path);
  }
  return found;
}

export function _generation_dir(release, apps, windows) {
  const descriptor = loads(readFileSync(join(release, 'installation.json'), 'utf8'));
  if (pyGet(descriptor, 'platform', 'linux') === 'darwin') return null;
  const app = pyGet(descriptor, 'app');
  if (typeof app !== 'string' || !app) throw new ValueError(`Release ${name(release)} has no app descriptor.`);
  const resolved = resolve(windows ? app : join(release, app));
  apps = resolve(apps);
  for (let candidate = resolved; ; candidate = parent(candidate)) {
    if (F.same(parent(candidate), apps)) return candidate;
    if (F.same(parent(candidate), candidate)) break;
  }
  if (!windows && F.isAbsolute(app) && !(isDict(descriptor) && descriptor.has('sha256'))) {
    // Linux release using an installed app in place, outside <prefix>/apps. An
    // absolute path that resolves under <prefix>/apps (for example an app copy
    // left by 0.7.0 and passed to --existing-app) is a generation to keep.
    return null;
  }
  throw new ValueError(`Release ${name(release)} references an app outside ${apps}.`);
}

/**
 * Windows registrations pin an app generation (the node.exe they run): `<prefix>/launcher-pins.json`
 * `{"registrations": {"<harness>|<scope>|<project>": "<node.exe>"}}`, written by lcu/setup.mjs
 * (.port/requests/maintenance.md). Missing file: no pins. Anything else that is not a regular file holding that
 * shape refuses the whole prune (fail closed). Prune never edits the file. No Python equivalent (new in the port).
 */
export const LAUNCHER_PINS = 'launcher-pins.json';

export function _launcher_pins(prefix) {
  const path = join(prefix, LAUNCHER_PINS);
  if (lstatOrNull(path) === null) return [];
  const refuse = (why) => new ValueError(`Refusing to prune: ${path} ${why}; fix or remove it, then rerun \`lcu setup\` for your agents.`);
  if (isSymlink(path) || !isFile(path)) throw refuse('is not a regular file');
  let document;
  try {
    document = loads(readFileSync(path));
  } catch (error) {
    if (error instanceof ValueError || typeof error?.code === 'string') throw refuse('cannot be read as JSON');
    throw error;
  }
  const registrations = isDict(document) ? document.get('registrations') : undefined;
  if (!isDict(registrations) || ![...registrations.values()].every((value) => typeof value === 'string' && value)) {
    throw refuse('is malformed (expected {"registrations": {"<harness>|<scope>|<project>": "<node.exe>"}})');
  }
  return [...registrations.values()];
}

/** PureWindowsPath-style normal form for case-insensitive containment checks. */
function windowsNormal(path) {
  const parts = String(path).replaceAll('/', '\\').split('\\');
  const head = parts[0];
  const rest = parts.slice(1).filter((part) => part !== '' && part !== '.');
  return [head, ...rest].join('\\').toLowerCase();
}

export function _pinned_by(generation, pins) {
  const base = windowsNormal(generation);
  return pins.some((pin) => windowsNormal(pin).startsWith(`${base}\\`));
}

function mtimeNs(path) {
  return statSync(path, { bigint: true }).mtimeNs;
}

export function main(root, argv) {
  const parser = new ArgumentParser({
    prog: 'lcu prune', description: 'Remove superseded LCU release and app generations.',
  });
  parser.add_argument('--keep', {
    type: types.int, default: 2, help: 'Number of releases to keep, including current (minimum 1).',
  });
  parser.add_argument('--yes', { action: 'store_true', help: 'Delete instead of a dry run.' });
  const args = parser.parse_args(argv);
  let keep = BigInt(args.get('keep'));
  if (keep < 1n) keep = 1n;

  root = resolve(root);
  if (name(parent(root)) !== 'releases') {
    throw new ValueError('lcu prune must run from an installed <prefix>/releases/<name> release.');
  }
  const prefix = parent(parent(root));
  const releases = join(prefix, 'releases');
  const windows = pyGet(loads(readFileSync(join(root, 'installation.json'), 'utf8')), 'platform') === 'windows';
  const marker = join(prefix, '.lcu-install');
  if (isSymlink(marker) || !isFile(marker)) throw new ValueError(`Not an LCU installation: missing ${marker}`);
  if (isSymlink(releases) || !isDir(releases)) {
    throw new ValueError(`Not an LCU installation: ${releases} is missing or a symlink`);
  }

  let lock = null;
  if (!windows) lock = acquireSync(F.native(marker), { file: APPEND_LOCK_FILE });
  // (Windows: install_windows.py uses atomic replaces, not a lock file; nothing to take.)
  try {
    const current = _release_current(prefix, releases, windows);
    const pins = windows ? _launcher_pins(prefix) : [];
    const allReleases = _entries(releases, _RELEASE);
    const others = allReleases.filter((r) => !F.same(r, current) && !F.same(r, root))
      .map((r) => [r, mtimeNs(r)])
      .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
      .map(([r]) => r);
    const extra = keep - 1n > BigInt(others.length) ? others.length : Number(keep - 1n);
    const kept = [current, root, ...others.slice(0, extra)].filter((r, i, all) => all.findIndex((o) => F.same(o, r)) === i);
    const keptKeys = new Set(kept.map(F.key));
    const removeReleases = allReleases.filter((r) => !keptKeys.has(F.key(r)));

    const apps = join(prefix, 'apps');
    let removeApps = [];
    if (exists(apps)) {
      if (isSymlink(apps) || !isDir(apps)) throw new ValueError(`Refusing to prune: ${apps} is not a directory`);
      const pattern = windows ? _WINDOWS_APP : _LINUX_APP;
      const allApps = _entries(apps, pattern);
      const referenced = new Set(kept.map((r) => _generation_dir(r, apps, windows)).filter((g) => g !== null).map(F.key));
      removeApps = allApps.filter((a) => !referenced.has(F.key(a)));
      for (const app of removeApps.filter((a) => _pinned_by(a, pins))) {
        print(`Keeping ${app}: a registered agent launcher still runs its Node (${LAUNCHER_PINS}). `
          + 'Rerun `lcu setup` for your agents to move it to the current app, then prune again.');
      }
      removeApps = removeApps.filter((a) => !_pinned_by(a, pins));
    }

    const removals = [...removeReleases, ...removeApps];
    if (!removals.length) {
      print('Nothing to prune; current and recent generations are already the only ones.');
      return;
    }
    // Guard: only ever delete real directories directly under releases/apps.
    for (const path of removals) {
      if (isSymlink(path) || !isDir(path) || ![releases, apps].some((base) => F.same(base, parent(path)))) {
        throw new ValueError(`Refusing to remove unexpected path: ${path}`);
      }
    }

    let total = 0;
    for (const path of removals) {
      const size = _tree_size(path);
      total += size;
      const action = args.get('yes') ? 'Removed' : 'Would remove';
      if (args.get('yes')) rmtree(F.native(path));
      print(`${action} ${path} (${_human(size)})`);
    }
    print(`Total: ${_human(total)} across ${removals.length} generation(s).`);
    if (!args.get('yes')) {
      print('Rerun with --yes to delete. Restart or stop agents using older LCU releases first.');
    }
  } finally {
    if (lock !== null) lock.release();
  }
}
