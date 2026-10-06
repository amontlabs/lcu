// Connect installed Chromium browsers using OpenAI's original native host.
//
// Port of lcu/browser.py. Differences that follow from the Node runtime (see .port/notes/browser.md):
//   * Chrome's manifest names a generated launcher in the private host directory (`lcu-native-host`, a /bin/sh
//     script; Windows `lcu-native-host.cmd`). It holds no Node path: at every launch it execs the installation's
//     stable command `<prefix>/current/bin/lcu browser __native-host <host dir> ARGS` (Windows `<prefix>\lcu.cmd`),
//     so the relay goes through the same pre-Node gate and Node-startup quarantine as every LCU command and runs
//     lcu/native_host.mjs of the current release on its app Node;
//   * `migrate_relays(root, home)` (BRIEF addendum G) rewrites relays written by earlier releases to that form;
//   * locks go through compat/lock.mjs; a lost lock (Windows holder death) stops every later mutation.
// `hooks` holds the injection points the Python tests reach with mock.patch; production never replaces them.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { machine as osMachine } from 'node:os';

import { run as captureRun } from './capture.mjs';
import { ArgumentParser, io, PySystemExit, pyStrip, types } from './compat/argparse.mjs';
import { sha256File } from './compat/hash.mjs';
import { acquireSync } from './compat/lock.mjs';
import { flavour, IDENTITY } from './compat/flavour.mjs';
import { expanduser, pathExpanduser } from './compat/pathlib.mjs';
import { winPathStr } from './compat/winpath.mjs';
import { dumps, isDict, loads, ValueError } from './compat/pyjson.mjs';
import { quote } from './compat/shlex.mjs';
import { run as subprocessRun } from './compat/subprocess.mjs';
import { mkdtemp as hostMkdtemp, mkstemp as hostMkstemp } from './compat/tempfile.mjs';
import { compare } from './compat/unicode.mjs';
import { environment, paths } from './runtime.mjs';
import { unshimmed_env } from './sandbox_shim.mjs';
import { attribute_error_get } from './compat/pystr.mjs';

export const DESCRIPTION = "Connect installed Chromium browsers using OpenAI's original native host.";

const _MACOS_NATIVE_HOST_DIRS = [
  'Google/Chrome', 'Chromium', 'Google/ChromeForTesting',
  'Google/Chrome for Testing', 'Microsoft Edge',
  'BraveSoftware/Brave-Browser', 'com.operasoftware.Opera', 'Vivaldi',
];

export const _PLUGIN_DIGEST = '.lcu-browser-plugin';

const SYSTEMS = { linux: 'Linux', darwin: 'Darwin', win32: 'Windows' };

export const hooks = {
  system: () => SYSTEMS[process.platform] ?? process.platform.replace(/^./, (c) => c.toUpperCase()),
  machine: () => osMachine(),
  paths: (root, descriptor = null) => paths(root, descriptor),
  environment: (root, resolved = null) => environment(root, resolved),
  capture_run: (argv, options) => captureRun(argv, options),
  run: (argv, options) => subprocessRun(argv, options),
  copytree: (source, destination) => copytree(source, destination),
  _refresh_plugin: (source, destination) => _refresh_plugin(source, destination),
  _write_stamp: (destination, digest) => _write_stamp(destination, digest),
  stable_lcu: (root, system) => _stable_lcu(root, system),
  acquire: (path) => acquireSync(F.native(path)),
  // pathlib follows the host OS (PureWindowsPath on Windows). Tests select the Windows flavour on a POSIX host and
  // map its drive to a temporary directory (compat/flavour.mjs); production never changes these.
  windows_paths: () => process.platform === 'win32',
  native: () => IDENTITY,
};

const F = flavour({ windows: () => hooks.windows_paths(), native: () => hooks.native() });
const {
  accessSync, chmodSync, closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync, writeSync,
} = F.fs;
const pathStr = (path) => F.str(path);
const resolve = (path) => F.resolve(path);
const mkstemp = ({ prefix, dir }) => {
  const made = hostMkstemp({ prefix, dir: F.native(dir) });
  return { fd: made.fd, path: F.join(dir, made.path.split(/[\\/]/).at(-1)) };
};
const mkdtemp = ({ prefix, dir }) => F.join(dir, hostMkdtemp({ prefix, dir: F.native(dir) }).split(/[\\/]/).at(-1));

const print = (text = '') => io.stdout(`${text}\n`);
const join = (...parts) => F.join(...parts);
const parentOf = (path) => F.parent(path);
const nameOf = (path) => F.name(path);

const lstatOrNull = (path) => {
  try { return lstatSync(path); } catch { return null; }
};
const statOrNull = (path) => {
  try { return statSync(path); } catch { return null; }
};
const isSymlink = (path) => lstatOrNull(path)?.isSymbolicLink() ?? false;
const isFile = (path) => statOrNull(path)?.isFile() ?? false;
const isDir = (path) => statOrNull(path)?.isDirectory() ?? false;
const exists = (path) => statOrNull(path) !== null;
const executable = (path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const unlinkMissingOk = (path) => {
  try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
};
/** shutil.rmtree(path, ignore_errors=True): never follows (and, like Python, never removes) a symlink at `path`. */
const rmtreeQuiet = (path) => {
  const info = lstatOrNull(path);
  if (!info || info.isSymbolicLink()) return;
  try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore_errors */ }
};

// Python text mode: "\n" is written as os.linesep, and read back with universal newlines.
const textOut = (text) => (hooks.windows_paths() ? text.replaceAll('\n', '\r\n') : text);
const readText = (path) => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
const writeText = (path, text) => writeFileSync(path, textOut(text));

function writeAll(fd, buffer) {
  for (let offset = 0; offset < buffer.length;) offset += writeSync(fd, buffer, offset);
}

/** Path.__lt__ order: component by component, each compared by code point. */
function comparePaths(a, b) {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const order = compare(x[i], y[i]);
    if (order) return order;
  }
  return x.length - y.length;
}

/** Path.rglob('*') relative names: every entry below `root`; symlinked directories are listed, not entered. */
function rglob(root) {
  const found = [];
  const walk = (relative) => {
    let entries;
    try {
      entries = readdirSync(relative ? join(root, relative) : root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      found.push(child);
      if (entry.isDirectory()) walk(child);
    }
  };
  walk('');
  return found;
}

/** Content identity of the upstream Chrome plugin directory (paths, modes, bytes, links). */
export function _plugin_digest(plugin) {
  plugin = pathStr(plugin);
  const digest = createHash('sha256');
  for (const relative of rglob(plugin).sort(comparePaths)) {
    const path = join(plugin, relative);
    if (isSymlink(path)) {
      digest.update(Buffer.from(`L ${relative} ${readlinkSync(path)}\0`, 'utf8'));
    } else if (isFile(path)) {
      digest.update(Buffer.from(`F ${relative} ${statSync(path).mode & 0o111} ${sha256File(F.native(path))}\0`, 'utf8'));
    } else if (isDir(path)) {
      digest.update(Buffer.from(`D ${relative}\0`, 'utf8'));
    }
  }
  return digest.digest('hex');
}

const homeOf = (env, system) => pathStr(system === 'Windows'
  ? env.USERPROFILE ?? expanduser('~') : env.HOME ?? expanduser('~'));

const listDirs = (path) => {
  try {
    return readdirSync(path).filter((name) => isDir(`${path}/${name}`));
  } catch {
    return [];
  }
};

export function _manifest_paths(env, system) {
  const home = homeOf(env, system);
  const name = 'com.openai.codexextension.json';
  if (system === 'Darwin') {
    // These are the per-user destinations in the original Chrome plugin's
    // installManifest.mjs for macOS. Do not inspect system-wide registrations.
    const support = join(home, 'Library/Application Support');
    return new Set(_MACOS_NATIVE_HOST_DIRS.map((browser) => join(support, browser, 'NativeMessagingHosts', name)));
  }
  if (system === 'Windows') {
    // The pinned original installer writes here and registers this exact
    // manifest path under the current user's Chrome native-host key.
    return new Set([join(home, 'AppData/Local/OpenAI/extension', name)]);
  }
  const configRoots = new Set([join(home, '.config')]);
  for (const key of ['XDG_CONFIG_HOME', 'CHROME_CONFIG_HOME']) {
    if (env[key]) configRoots.add(pathStr(env[key]));
  }
  const found = new Set();
  const precise = (directory) => {
    const hosts = join(directory, 'NativeMessagingHosts');
    if (isDir(hosts) && exists(join(hosts, name))) found.add(join(hosts, name));
  };
  for (const configRoot of configRoots) {
    for (const first of listDirs(configRoot)) {
      precise(join(configRoot, first));
      for (const second of listDirs(join(configRoot, first))) precise(join(configRoot, first, second));
    }
  }
  return found;
}

let activeLock = null;

/**
 * Serialize everything that changes one private host copy (`with _destination_lock(destination):`).
 * Python's byte lock cannot silently disappear; the Windows holder process can. Every mutation step calls
 * _check_lock() first, so a lost lock stops the work before the next change (a residual window between the
 * check and the write remains, see .port/notes/browser.md).
 */
export function _destination_lock(destination, fn) {
  mkdirSync(parentOf(destination), { recursive: true });
  const path = join(parentOf(destination), `.${nameOf(destination)}.lock`);
  const lock = hooks.acquire(path);
  const outer = activeLock;
  activeLock = lock;
  try {
    _check_lock();
    return fn();
  } finally {
    activeLock = outer;
    lock.release();
  }
}

export function _check_lock() {
  if (activeLock !== null && (!activeLock.held || activeLock.lost)) {
    throw new ValueError(`The lock on ${activeLock.path} was lost; stopped before changing anything else.`);
  }
}

/** shutil.copytree(source, destination, symlinks=True): links copied as links, modes and times kept. */
export function copytree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source).sort(compare)) {
    const from = join(source, entry);
    const to = join(destination, entry);
    const info = lstatSync(from);
    if (info.isSymbolicLink()) {
      symlinkSync(readlinkSync(from), to);
    } else if (info.isDirectory()) {
      copytree(from, to);
    } else {
      copyFileSync(from, to);
      chmodSync(to, info.mode & 0o7777);
      utimesSync(to, info.atime, info.mtime);
    }
  }
  const info = statSync(source);
  chmodSync(destination, info.mode & 0o7777);
  utimesSync(destination, info.atime, info.mtime);
}

/** Replace the digest with a staged regular file; a symlink at the name is replaced, never followed. */
export function _write_stamp(destination, digest) {
  const { fd, path: staged } = mkstemp({ prefix: '.lcu-browser-stamp-', dir: destination });
  try {
    try {
      writeAll(fd, Buffer.from(textOut(`${digest}\n`), 'utf8'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(staged, join(destination, _PLUGIN_DIGEST));
  } finally {
    unlinkMissingOk(staged);
  }
}

/**
 * Publish the private plugin copy for `source` and its digest; recover interrupted updates.
 *
 * Must run under `_destination_lock`. The new copy is staged completely first and moved
 * into place by rename. An interruption between the two renames leaves `chrome` missing
 * and `.chrome-previous` present, which the next run restores before deciding what to do.
 * The digest is written last, so a copy and digest that disagree only cause one more refresh.
 */
export function _refresh_plugin(source, destination) {
  const plugin = join(destination, 'chrome');
  const retired = join(destination, '.chrome-previous');
  if (!exists(plugin) && exists(retired)) renameSync(retired, plugin);
  else if (exists(plugin)) rmtreeQuiet(retired);
  for (const leftover of readdirSync(destination).sort(compare)) {
    if (!leftover.startsWith('.lcu-browser-')) continue;
    if (leftover === '.lcu-browser-host' || leftover === _PLUGIN_DIGEST) continue;
    const path = join(destination, leftover);
    if (isDir(path) && !isSymlink(path)) rmtreeQuiet(path); // scratch from an interrupted refresh
    else unlinkMissingOk(path);
  }
  const digest = _plugin_digest(source);
  const stamp = join(destination, _PLUGIN_DIGEST);
  const current = isDir(plugin) && !isSymlink(plugin) && isFile(join(plugin, 'scripts/installManifest.mjs'))
    && isFile(stamp) && !isSymlink(stamp) && pyStrip(readText(stamp)) === digest;
  if (current) return;
  const scratch = mkdtemp({ prefix: '.lcu-browser-', dir: destination });
  try {
    hooks.copytree(source, join(scratch, 'chrome'));
    _check_lock();
    if (exists(plugin) || isSymlink(plugin)) {
      if (isSymlink(plugin)) unlinkSync(plugin);
      else renameSync(plugin, retired);
    }
    renameSync(join(scratch, 'chrome'), plugin);
    rmtreeQuiet(retired);
    _check_lock();
    hooks._write_stamp(destination, digest);
  } finally {
    rmtreeQuiet(scratch);
  }
}

/**
 * The installation's stable command the relay launcher execs at every Chrome launch: `<prefix>/current/bin/lcu`
 * (Windows `<prefix>\lcu.cmd`, which resolves current.json itself). A source checkout (not under
 * `<prefix>/releases/`) has no stable prefix: its own bin/lcu is used (development only).
 */
export function _stable_lcu(root, system) {
  const release = resolve(root);
  if (nameOf(parentOf(release)) === 'releases') {
    const prefix = parentOf(parentOf(release));
    return system === 'Windows' ? join(prefix, 'lcu.cmd') : join(prefix, 'current/bin/lcu');
  }
  return join(release, system === 'Windows' ? 'bin/lcu.cmd' : 'bin/lcu');
}

/** The generated launcher Chrome executes (bytes). It never writes to stdout, Chrome's framed channel. */
export function _relay_launcher(lcu, destination, system) {
  if (system === 'Windows') {
    // Chromium uses cmd.exe for a non-.exe native host. The wrapper emits no text on stdout.
    return Buffer.from('@echo off\r\n'
      + `if not exist "${lcu}" (\r\n`
      + `  >&2 echo LCU Chrome native-host relay: ${lcu} is missing; reinstall LCU, then run lcu browser install.\r\n`
      + '  exit /b 1\r\n'
      + ')\r\n'
      + `call "${lcu}" browser __native-host "%~dp0." %*\r\n`
      + 'exit /b %ERRORLEVEL%\r\n', 'utf8');
  }
  return Buffer.from('#!/bin/sh\n'
    + '# LCU Chrome native-host relay (generated by `lcu browser install`). Writes nothing on stdout itself:\n'
    + '# the stable LCU launcher applies the pre-Node gate and environment quarantine, then runs the relay.\n'
    + `_lcu=${quote(lcu)}\n`
    + 'if [ ! -f "$_lcu" ] || [ ! -x "$_lcu" ]; then\n'
    + '  printf \'LCU Chrome native-host relay: %s is missing; reinstall LCU, then run `lcu browser install`.\\n\' "$_lcu" >&2\n'
    + '  exit 1\n'
    + 'fi\n'
    + `exec "$_lcu" browser __native-host ${quote(destination)} "$@"\n`, 'utf8');
}

const relayName = (system) => (system === 'Windows' ? 'lcu-native-host.cmd' : 'lcu-native-host');

function stageFile(directory, target, bytes, mode) {
  const { fd, path: staged } = mkstemp({ prefix: '.lcu-native-host-', dir: directory });
  try {
    try {
      writeAll(fd, bytes);
    } finally {
      closeSync(fd);
    }
    chmodSync(staged, mode);
    _check_lock();
    renameSync(staged, target);
  } finally {
    unlinkMissingOk(staged);
  }
}

/** Write the relay launcher into `destination`; returns its path. */
export function _publish_relay(root, destination, system) {
  if (!isFile(join(root, 'lcu/native_host.mjs'))) {
    throw new ValueError('The LCU Chrome native-host relay is missing from this release.');
  }
  const relay = join(destination, relayName(system));
  stageFile(destination, relay, _relay_launcher(hooks.stable_lcu(root, system), destination, system), 0o700);
  if (system === 'Windows') unlinkMissingOk(join(destination, 'lcu-native-host.py')); // Python-era relay copy
  return relay;
}

function dataDirectory(env, system, home) {
  if (system === 'Darwin') return join(home, 'Library/Application Support');
  if (system === 'Windows') return pathStr(env.LOCALAPPDATA ?? join(home, 'AppData/Local'));
  return pathStr(env.XDG_DATA_HOME ?? join(home, '.local/share'));
}

function selectedApp(root, system) {
  return system === 'Windows' ? hooks.paths(root)[0] : resolve(join(root, 'app'));
}

export function install(root, directory = null) {
  root = pathStr(root);
  const system = hooks.system();
  if (!['Linux', 'Darwin', 'Windows'].includes(system)) {
    throw new ValueError('The original Chrome native host is supported on Linux, macOS, and Windows only.');
  }
  // The upstream installer writes its host configuration beside the executable.
  // Keep the sealed release immutable; give this account a private host copy.
  const home = homeOf(process.env, system);
  const data = dataDirectory(process.env, system, home);
  const selected = selectedApp(root, system);
  const identity = createHash('sha256').update(String(selected), 'utf8').digest('hex').slice(0, 16);
  const destination = directory !== null && directory !== undefined
    ? F.absolute(F.windows ? winPathStr(String(directory)) : pathExpanduser(String(directory))) : join(data, 'lcu/browser', identity);
  return _destination_lock(destination, () => _install_locked(root, system, destination, selected));
}

/** PurePath.is_relative_to */
const isRelativeTo = (path, base) => F.isRelativeTo(path, base);

export function _install_locked(root, system, destination, selected_app) {
  const marker = join(destination, '.lcu-browser-host');
  const expected = `${selected_app}\n`;
  if (isSymlink(destination)) throw new ValueError('The browser host directory must not be a symlink.');
  if (exists(destination)) {
    if (!isFile(marker) || isSymlink(marker) || readText(marker) !== expected) {
      throw new ValueError('The browser host directory belongs to another installation; select an empty directory.');
    }
  }
  const selected = hooks.paths(root);
  // The persisted Codex path is the real executable, not the sandbox shim.
  const env = unshimmed_env(hooks.environment(root, selected));
  // Runtime selection returns the original resource tree. Linux stores it
  // under app/resources; macOS stores it under app/Contents/Resources.
  const source = join(selected[1], 'plugins/openai-bundled/plugins/chrome');
  if (!isFile(join(source, 'scripts/installManifest.mjs'))) {
    throw new ValueError('The complete upstream Chrome plugin is missing from this bundle.');
  }
  // The app can be upgraded in place at the same path, so the private copy follows the
  // content of the selected plugin, not only the app path.
  if (!exists(destination)) {
    const scratch = mkdtemp({ prefix: '.lcu-browser-', dir: parentOf(destination) });
    try {
      hooks.copytree(source, join(scratch, 'chrome'));
      writeText(join(scratch, '.lcu-browser-host'), expected);
      writeText(join(scratch, _PLUGIN_DIGEST), `${_plugin_digest(source)}\n`);
      _check_lock();
      renameSync(scratch, destination);
    } finally {
      if (exists(scratch)) rmSync(scratch, { recursive: true });
    }
  } else {
    hooks._refresh_plugin(source, destination);
  }
  const relay = _publish_relay(root, destination, system);
  const script = ('const {install} = await import(process.argv[1]); '
    + 'await install({appServerRuntimePaths:{codexCliPath:process.env.CODEX_CLI_PATH,'
    + 'nodePath:process.env.NODE_REPL_NODE_PATH,nodeReplPath:process.env.CUA_REPL_NODE_REPL_PATH}});');
  const installed = hooks.capture_run([env.NODE_REPL_NODE_PATH, '--input-type=module', '-e', script,
    F.asUri(join(destination, 'chrome/scripts/installManifest.mjs'))], { env, timeout: 120 });
  if (installed.returncode) {
    const tail = (text) => Array.from(pyStrip(text)).slice(-2000).join('');
    const detail = tail(installed.stderr) || tail(installed.stdout);
    throw new ValueError(`The original Chrome installer failed (exit ${installed.returncode}).${detail ? ` ${detail}` : ''}`);
  }
  // The pinned original installer returns no manifest list. Locate only its
  // native-host manifest name at the documented config depths, then require
  // each candidate to point at this selected private copy before changing it.
  const manifestPaths = _manifest_paths(env, system);
  const hostName = { Linux: 'extension-host', Darwin: 'ChatGPT for Chrome', Windows: 'extension-host.exe' }[system];
  let changed = 0;
  for (const manifestPath of [...manifestPaths].sort(comparePaths)) {
    if (isSymlink(manifestPath)) throw new ValueError(`Native-host manifest must be a regular file: ${manifestPath}`);
    if (!isFile(manifestPath)) continue;
    const manifest = loads(readText(manifestPath));
    const original = pathStr(pyGet(manifest, 'path', ''));
    if (nameOf(original) !== hostName
        || !isRelativeTo(resolve(original), resolve(join(destination, 'chrome/extension-host')))) {
      continue;
    }
    manifest.set('path', relay);
    const { fd, path: staged } = mkstemp({ prefix: '.lcu-manifest-', dir: parentOf(manifestPath) });
    try {
      try {
        writeAll(fd, Buffer.from(textOut(`${dumps(manifest, { indent: 2 })}\n`), 'utf8'));
      } finally {
        closeSync(fd);
      }
      chmodSync(staged, 0o644);
      _check_lock();
      renameSync(staged, manifestPath);
    } finally {
      unlinkMissingOk(staged);
    }
    changed += 1;
  }
  if (changed === 0) throw new ValueError('The original Chrome installer produced no manifest for the selected host.');
  if (system === 'Windows') {
    const key = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.openai.codexextension';
    const registered = hooks.run(['reg.exe', 'query', key, '/ve'], { capture: true, timeout: 20000 });
    if (registered.returncode || !String(registered.stdout).includes([...manifestPaths][0])) {
      throw new ValueError('The original Chrome installer did not register the selected manifest for this account.');
    }
  }
  return destination;
}

/** dict.get on parsed JSON; anything but an object is Python's AttributeError (a traceback there). */
function pyGet(document, key, fallback = null) {
  if (isDict(document)) return document.has(key) ? document.get(key) : fallback;
  throw attribute_error_get(document);
}

/** True when `relay` (the manifest's path) is the launcher this installation generates for its directory. */
function relayCurrent(root, relay, system) {
  return readFileSync(relay).equals(_relay_launcher(hooks.stable_lcu(root, system), parentOf(relay), system));
}

/** Report setup from upstream diagnostics; this is not a connection test. */
export function status(root, family = 'chrome') {
  root = pathStr(root);
  const selected = hooks.paths(root);
  const env = hooks.environment(root, selected);
  const plugin = join(selected[1], 'plugins/openai-bundled/plugins/chrome');
  const config = loads(readText(join(plugin, 'scripts/extension-ids.json')));
  const browser = pyGet(config, 'browserDiagnostics').find((item) => pyGet(item, 'browserFamily') === family);
  if (browser === undefined) {
    const error = new Error('');
    error.name = 'StopIteration';
    throw error;
  }

  const check = (script) => {
    const result = hooks.capture_run([env.NODE_REPL_NODE_PATH, join(plugin, 'scripts', script),
      '--browser', family, '--json'], { env, timeout: 20 });
    try {
      const parsed = loads(result.stdout);
      if (isDict(parsed)) return parsed;
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
    }
    if (pyStrip(result.stderr)) return new Map([['problem', pyStrip(result.stderr)]]);
    const size = Buffer.byteLength(result.stdout, 'utf8');
    return new Map([['problem', size ? `The original diagnostic output could not be parsed (${size} bytes).`
      : 'The original diagnostic returned no result.']]);
  };

  const truthy = (value) => !(value === undefined || value === null || value === false || value === '' || value === 0
    || value === 0n || (Array.isArray(value) && !value.length) || (value instanceof Map && !value.size));
  const extension = check('check-extension-installed.js');
  const manifest = check('check-native-host-manifest.js');
  const label = browser.get('shortDisplayName');
  const profile = extension.get('selectedProfileDirectory');
  const suffix = truthy(profile) ? ` in ${profile}` : '';
  const enabled = extension.get('enabled') === true;
  if (enabled) {
    print(`${label} extension: enabled${suffix}.`);
  } else if (truthy(extension.get('installed'))) {
    print(`${label} extension: disabled${suffix}. Enable it at ${browser.get('extensionManagementUrl')}.`);
  } else if (truthy(extension.get('problem'))) {
    print(`${label} extension: could not check. ${extension.get('problem')}`);
    print(`  Open ${label} once and install or enable the official extension: ${browser.get('storeUrl')}`);
  } else {
    print(`${label} extension: not found${suffix}.`);
    print(`  Install the official extension in the profile you want to use: ${browser.get('storeUrl')}`);
  }

  let connectedHost = false;
  if (truthy(manifest.get('correct')) && truthy(manifest.get('manifestPath'))) {
    try {
      const data = loads(readText(manifest.get('manifestPath')));
      if (!isDict(data) || !data.has('path')) throw new ValueError('KeyError: path');
      const relay = pathStr(data.get('path'));
      const directory = parentOf(relay);
      const arch = { arm64: 'arm64', aarch64: 'arm64', x86_64: 'x64', amd64: 'x64' }[hooks.machine().toLowerCase()];
      const pair = { Darwin: ['macos', 'ChatGPT for Chrome'], Linux: ['linux', 'extension-host'],
        Windows: ['windows', 'extension-host.exe'] }[hooks.system()];
      if (arch === undefined || pair === undefined) throw new ValueError('KeyError');
      const [system, name] = pair;
      const host = join(directory, 'chrome/extension-host', system, arch, name);
      const target = { macos: 'Darwin', linux: 'Linux', windows: 'Windows' }[system];
      connectedHost = (
        nameOf(relay) === relayName(target) && isFile(relay) && executable(relay)
        && relayCurrent(root, relay, target)
        && readText(join(directory, '.lcu-browser-host')) === `${system === 'windows' ? selected[0] : resolve(join(root, 'app'))}\n`
        && pyStrip(readText(join(directory, _PLUGIN_DIGEST))) === _plugin_digest(plugin)
        && isFile(host) && executable(host));
    } catch (error) {
      // (KeyError, OSError, ValueError)
      if (!(error instanceof ValueError || typeof error?.code === 'string')) throw error;
    }
  }
  if (connectedHost) print(`${label} connector: configured for this LCU installation.`);
  else print(`${label} connector: missing or outdated. Run \`lcu browser install\`.`);
  print(`Live browser connection: not checked. After setup, ask your agent to use LCU to list ${label} tabs.`);
  return enabled && connectedHost;
}

/** (dev, ino, real path) of a directory that is not a symlink, or null. */
function directoryIdentity(path) {
  const info = lstatOrNull(path);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return null;
  try {
    return { dev: info.dev, ino: info.ino, real: F.realpath(path) };
  } catch {
    return null;
  }
}

const sameDirectory = (a, b) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino && a.real === b.real;

/**
 * Post-install migration (BRIEF addendum G): rewrite the relay launcher of every existing LCU host directory that
 * belongs to this installation, so relays written by earlier releases (copied Python scripts, a `.cmd` running
 * Python) start through the stable LCU command. A directory belongs to this installation when its
 * `.lcu-browser-host` owner marker names this release's selected app or an app generation under this prefix's
 * `apps/` (Windows generations and pre-0.8 Linux copies change path across updates), or when its launcher already
 * runs this prefix's stable command. Only directories that already hold an LCU relay are touched; nothing new is
 * registered with Chrome, manifests keep their unchanged relay path, and the upstream installer is not run.
 * Everything is re-validated under the destination lock (the directory must still be the same real directory).
 * Returns the refreshed directories.
 */
export function migrate_relays(root, home = null) {
  root = pathStr(root);
  const system = hooks.system();
  if (!['Linux', 'Darwin', 'Windows'].includes(system)) return [];
  const env = { ...process.env };
  if (home !== null && home !== undefined) env[system === 'Windows' ? 'USERPROFILE' : 'HOME'] = pathStr(home);
  const accountHome = homeOf(env, system);
  const candidates = [];
  const add = (directory) => { if (!candidates.includes(directory)) candidates.push(directory); };
  const browserRoot = join(dataDirectory(env, system, accountHome), 'lcu/browser');
  for (const entry of listDirs(browserRoot).sort(compare)) add(join(browserRoot, entry));
  for (const manifestPath of [...(_manifest_paths(env, system))].sort(comparePaths)) {
    try {
      if (isSymlink(manifestPath) || !isFile(manifestPath)) continue;
      const relay = pyGet(loads(readText(manifestPath)), 'path', '');
      if (typeof relay === 'string' && nameOf(relay) === relayName(system)) add(parentOf(pathStr(relay)));
    } catch (error) {
      if (!(error instanceof ValueError || error?.name === 'AttributeError' || typeof error?.code === 'string')) throw error;
    }
  }
  const release = resolve(root);
  const prefixApps = nameOf(parentOf(release)) === 'releases' ? join(parentOf(parentOf(release)), 'apps') : null;
  let selected = null;
  const owned = (destination, marker) => {
    const text = readText(marker);
    selected ??= String(selectedApp(root, system));
    if (text === `${selected}\n`) return true;
    const named = text.endsWith('\n') ? text.slice(0, -1) : null;
    if (named && prefixApps !== null && !named.includes('\n')) {
      if (F.isRelativeTo(named, prefixApps) && !F.same(named, prefixApps)) return true;
    }
    try {
      return relayCurrent(root, join(destination, relayName(system)), system);
    } catch {
      return false;
    }
  };
  const refreshed = [];
  for (const destination of candidates) {
    const marker = join(destination, '.lcu-browser-host');
    const relay = join(destination, relayName(system));
    const identity = directoryIdentity(destination);
    if (identity === null || isSymlink(marker) || !isFile(marker) || isSymlink(relay) || !isFile(relay)) continue;
    const done = _destination_lock(destination, () => {
      // Re-validate everything under the lock: the directory itself (not redirected or replaced while we
      // waited), the owner marker and the existing relay.
      if (!sameDirectory(identity, directoryIdentity(destination))) return false;
      if (isSymlink(marker) || !isFile(marker) || isSymlink(relay) || !isFile(relay)) return false;
      if (!owned(destination, marker)) return false;
      const upToDate = (() => {
        try { return relayCurrent(root, relay, system); } catch { return false; }
      })();
      if (upToDate) return false;
      _publish_relay(root, destination, system);
      return true;
    });
    if (done) refreshed.push(destination);
  }
  return refreshed;
}

export function parser() {
  const top = new ArgumentParser({ prog: 'lcu', description: DESCRIPTION });
  const subparsers = top.add_subparsers({ dest: 'action', required: true });
  const setup = subparsers.add_parser('install', { help: 'Install the original native host for the current desktop account' });
  setup.add_argument('--directory', { type: types.Path, help: 'Private writable host directory' });
  const check = subparsers.add_parser('status', { help: 'Check extension and connector setup without changing the browser' });
  check.add_argument('--browser', { choices: ['chrome', 'edge'], default: 'chrome' });
  return top;
}

export async function main(root, argv) {
  if (argv[0] === '__native-host') {
    // Started by a generated relay launcher (see _relay_launcher) through the stable LCU command, so the pre-Node
    // gate and environment quarantine have already run. stdout belongs to Chrome's framed channel.
    const [, directory, ...rest] = argv;
    if (!directory) {
      io.stderr('LCU Chrome native-host relay: missing host directory.\n');
      throw new PySystemExit(2);
    }
    const { run } = await import('./native_host.mjs');
    const status = await run(directory, rest);
    process.stdin.destroy?.(); // nothing else may keep this process alive (Python's daemon reader thread)
    throw new PySystemExit(status);
  }
  const top = parser();
  if (argv.length >= 1 && (argv[0] === 'serve' || argv[0] === 'protocol')) {
    top.error('the in-app browser host and codex:// protocol commands were removed; use the installed app browser. For external Chrome, run `lcu browser install` and enable the official ChatGPT extension.');
  }
  const args = top.parse_args(argv);
  if (args.action === 'status') {
    if (!status(root, args.browser)) throw new PySystemExit(1);
    return;
  }
  const destination = install(root, args.directory === null || args.directory === undefined ? null : String(args.directory));
  print(`LCU browser native host configured: ${destination}`);
  print('Install or enable the official ChatGPT browser extension in the browser you want to use.');
  print('The extension and browser must run under this same desktop account. See docs/INSTALLATION.md.');
  print('Check extension and connector setup with: lcu browser status');
}
