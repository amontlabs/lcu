// File and tree hashing used at install time: streaming sha256, the release inventory of scripts/bundle.py
// (inventory / seal / verify) and the Windows application inventory of lcu/windows.py.
//
// Built-ins plus ./pyjson.mjs (byte-exact Python json), ./utf8.mjs (strict decoding), ./pathlib.mjs and ./errors.mjs.
// Differences from CPython: none intended for POSIX. On Windows junctions are detected through Node's lstat
// (libuv reports junctions as symbolic links), where Python uses Path.is_junction().
//
// Changes 2026-10-05 (compat-archive-http review F10/F12/F13/F14): ValueError and RuntimeError are the shared classes
// of compat/pyjson.mjs and compat/pathlib.mjs (same export names, one class identity); verify() compares the manifest
// with Python equality (420 == 420.0 == the same mode) and decodes bundle.json strictly (UnicodeDecodeError, text-mode
// newline translation, as Path.read_text()); inventory() of a missing or non-directory root is empty and unreadable
// subdirectories are skipped, like Path.rglob('*') of 3.12.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dumps, loads, compareCodePoints, equal } from './pyjson.mjs';
import { pyfs, toPyOSError, ValueError } from './errors.mjs';
import * as P from './pypath.mjs';
import { PyRuntimeError, resolve as pathlibResolve } from './pathlib.mjs';
import { decode as utf8Decode } from './utf8.mjs';

export { ValueError };
export const RuntimeError = PyRuntimeError;

/** pathlib.Path.resolve() (non-strict, 3.12): realpath, then a stat() that turns ELOOP into RuntimeError. */
export function pathResolve(p) {
  return pathlibResolve(p);
}

/** hashlib.file_digest(stream, 'sha256').hexdigest() / _sha256(path): streaming, 1 MiB reads. */
export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = pyfs(String(file), () => fs.openSync(file, 'r'));
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

export const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------- scripts/bundle.py
const compareParts = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = compareCodePoints(a[i], b[i]);
    if (d) return d;
  }
  return a.length - b.length;
};

/**
 * Path.rglob('*') of 3.12: nothing unless root is a directory (is_dir() follows symlinks and treats any error as
 * false); then every entry below root, symlinked directories listed but not entered; a directory that cannot be listed
 * contributes nothing (Path.walk() and the wildcard selector both ignore scandir errors).
 */
function* walkEntries(root, rel = []) {
  const dir = rel.length ? path.join(root, ...rel) : root;
  if (!rel.length) {
    try { if (!fs.statSync(dir).isDirectory()) return; } catch { return; }
  }
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const parts = [...rel, name];
    yield parts;
    let st;
    try { st = fs.lstatSync(path.join(root, ...parts)); } catch { continue; }
    if (st.isDirectory()) yield* walkEntries(root, parts);
  }
}

/** bundle.architecture(target) */
export function architecture(target = 'linux') {
  const arch = { aarch64: 'arm64', arm64: 'arm64', x86_64: 'x64', amd64: 'x64' }[os.machine().toLowerCase()];
  const expected = { linux: 'linux', darwin: 'darwin', windows: 'win32' }[target];
  if (expected === undefined || process.platform !== expected || arch === undefined || (target === 'windows' && arch !== 'x64')) {
    throw new ValueError(`LCU requires ${target} ARM64 or x86-64.`);
  }
  return arch;
}

/** bundle.inventory(root, target): Map relative-path -> Map entry, in Python's insertion order. */
export function inventory(rootPath, target = 'linux') {
  const root = pathResolve(path.resolve(rootPath));
  const entries = [...walkEntries(root)].map((parts) => ({ parts, rel: parts.join('/') }));
  entries.sort((a, b) => compareParts(a.parts, b.parts));
  const files = new Map();
  for (const { parts, rel } of entries) {
    if (rel === 'bundle.json') continue;
    const full = path.join(root, ...parts);
    const lst = fs.lstatSync(full);
    if (lst.isSymbolicLink()) {
      const link = fs.readlinkSync(full);
      const resolved = pathResolve(full);
      const inside = resolved === root || resolved.startsWith(root === '/' ? '/' : root + '/');
      if (P.isabs(link) || !inside) throw new ValueError(`Unsafe bundle symlink: ${rel}`);
      files.set(rel, new Map([['type', 'symlink'], ['target', link]]));
    } else if (lst.isFile()) {
      const entry = new Map([['type', 'file'], ['sha256', sha256File(full)]]);
      if (target !== 'windows') entry.set('mode', lst.mode & 0o777);
      files.set(rel, entry);
    } else if (!lst.isDirectory()) {
      throw new ValueError(`Unsupported bundle entry: ${rel}`);
    }
  }
  return files;
}

/** The exact bytes `seal` writes to bundle.json. */
export function manifestText(version, target, arch, files) {
  const manifest = new Map([['format', 1], ['version', version], ['platform', target], ['architecture', arch], ['files', files]]);
  return dumps(manifest, { indent: 2, sort_keys: true }) + '\n';
}

/** bundle.seal(root, arch, target) with an explicit version (bundle.VERSION). */
export function seal(rootPath, version, arch, target = 'linux') {
  const root = path.resolve(rootPath);
  fs.writeFileSync(path.join(root, 'bundle.json'), manifestText(version, target, arch, inventory(root, target)));
}

const pyStr = (v) => (v === null ? 'None' : v === true ? 'True' : v === false ? 'False' : typeof v === 'bigint' ? v.toString() : String(v));

/** bundle.verify(root, arch, target) with an explicit version; returns the loaded manifest (Map). */
export function verify(rootPath, version, arch, target = 'linux') {
  const root = path.resolve(rootPath);
  const file = path.join(root, 'bundle.json');
  let st = null;
  try { st = fs.lstatSync(file); } catch { /* missing */ }
  if (!st || st.isSymbolicLink() || !st.isFile()) {
    throw new ValueError('Install from an extracted LCU release bundle. Source checkouts contain no runtime; build a release with scripts/build_bundle.py first.');
  }
  // Path.read_text(): strict UTF-8 (UnicodeDecodeError), universal newlines; json.loads: JSONDecodeError.
  const manifest = loads(utf8Decode(fs.readFileSync(file)).replace(/\r\n?/g, '\n'));
  if (!(manifest instanceof Map) || !equal(manifest.get('format'), 1) || manifest.get('platform') !== target
      || manifest.get('version') !== version) {
    throw new ValueError('Unsupported LCU bundle manifest');
  }
  if (manifest.get('architecture') !== arch) {
    throw new ValueError(`Bundle architecture ${pyStr(manifest.has('architecture') ? manifest.get('architecture') : null)} does not match this machine (${arch})`);
  }
  const expected = manifest.get('files');
  const actual = inventory(root, target);
  if (!(expected instanceof Map) || !equal(expected, actual)) {
    throw new ValueError('LCU bundle integrity check failed; extract a clean release archive.');
  }
  return manifest;
}

// ---------------------------------------------------------------- lcu/windows.py
const redirected = (st) => st.isSymbolicLink();

/** windows.application_inventory(app): Map relative path -> Map({type, sha256?}). */
export function applicationInventory(appPath) {
  const app = appPath;
  let root;
  try { root = fs.lstatSync(app); } catch (err) { throw toPyOSError(err, String(app)); }
  if (!root.isDirectory() || redirected(root)) throw new ValueError(`Windows application directory is missing or redirected: ${app}`);
  const inventory = new Map([['.', new Map([['type', 'directory']])]]);
  const walk = (dir) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) {
      throw new ValueError(`Windows application tree cannot be read: ${err.path ?? dir}`);
    }
    const directories = [], files = [];
    for (const entry of names) {
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) { try { isDir = fs.statSync(path.join(dir, entry.name)).isDirectory(); } catch { isDir = false; } }
      (isDir ? directories : files).push(entry.name);
    }
    const all = [...directories, ...files].sort(compareCodePoints);
    for (const name of all) {
      const full = path.join(dir, name);
      const relative = path.relative(app, full).split(path.sep).join('/');
      const info = fs.lstatSync(full);
      if (redirected(info)) throw new ValueError(`Windows application contains a redirected path: ${full}`);
      if (info.isDirectory()) inventory.set(relative, new Map([['type', 'directory']]));
      else if (info.isFile()) inventory.set(relative, new Map([['type', 'file'], ['sha256', sha256File(full)]]));
      else throw new ValueError(`Windows application contains an unsupported file: ${full}`);
    }
    for (const name of directories) walk(path.join(dir, name));
  };
  walk(app);
  return inventory;
}

/** windows.inventory_sha256(inventory): sha256 of json.dumps(sort_keys, compact separators) as UTF-8. */
export function inventorySha256(inventory) {
  return sha256Hex(Buffer.from(dumps(inventory, { sort_keys: true, separators: [',', ':'] }), 'utf8'));
}
