// `lcu update` apply step: fetch the release archive, verify it, run its installer.
//
// Downloads only LCU's own release archive from GitHub. The official app is never
// fetched or touched; the extracted installer reuses the one the installation
// already points at. Agent registrations point at `<prefix>/current`, so a
// runtime-only reinstall keeps them working; setup is not re-run.
//
// Port of lcu/update_apply.py. Installer handoff (BRIEF addendum F): POSIX runs the NEW archive's
// `scripts/install.sh` through /bin/sh (same flags and order Python passed to install*.py); Windows runs the
// retained bridge `python -B scripts/install_windows.py` and therefore needs a usable Python 3.12+, which is
// looked for after the confirmation and BEFORE anything is downloaded.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from './compat/spawn.mjs';
import tty from 'node:tty';

import { findpwuid } from './compat/accounts.mjs';
import { pySplitlines } from './compat/argparse.mjs';
import * as errors from './compat/errors.mjs';
import * as http from './compat/http.mjs';
import { loads, ValueError } from './compat/pyjson.mjs';
import { stdout_flush } from './compat/pyio.mjs';
import { pyStrip } from './compat/pynum.mjs';
import { resolve as posixResolve } from './compat/pathlib.mjs';
import * as shlex from './compat/shlex.mjs';
import { run as subprocessRun } from './compat/subprocess.mjs';
import { mkdtemp } from './compat/tempfile.mjs';
import { extractLcuTar, TarError } from './compat/tar.mjs';
import { decode as utf8Decode } from './compat/utf8.mjs';
import { which } from './compat/which.mjs';
import { splitWin, winPathStr } from './compat/winpath.mjs';
import { ignored_signals } from './startup_vars.mjs';
import { extractLcuZip, BadZipFile } from './compat/zip.mjs';
import {
  KeyError, _inject as updateInject, cmd_invocation, environment, eprint, excStr, get, isOS, isSubprocessError, isValue,
  need, pjoin, pname, pparent, print, readText, stderr, stdout, strOf, system_proxy, truthy,
} from './update.mjs';

export const DOWNLOAD = 'https://github.com/amontlabs/lcu/releases/download';
export const TIMEOUT = 60;
const SHA = /^[0-9a-fA-F]{64}$/;
const WIN = () => updateInject.platform() === 'win32';

// Test seams (Python's tests patch urlopen / subprocess.run / os.getuid / os.access / sys.stdin). The download
// itself is never replaced: tests point DOWNLOAD at a local server and keep the real fetch/hash/write path.
export const _inject = {
  DOWNLOAD,
  http: {}, // extra options for compat/http (env, ca, ...)
  run: (command) => run_installer(command),
  spawnSync: (command, args, options) => spawnSync(command, args, options),
  getuid: () => process.getuid(),
  access: (target) => { try { fs.accessSync(target, fs.constants.W_OK); return true; } catch { return false; } },
  isatty: () => tty.isatty(0),
  input: (prompt) => input(prompt),
  find_python: () => find_python(),
  getuser: () => getuser(),
  fs: {
    isFile: (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } },
    isDir: (file) => { try { return fs.statSync(file).isDirectory(); } catch { return false; } },
    readText: (file) => readText(file),
    realpathWin: (file) => {
      const absolute = path.win32.resolve(file);
      try { return fs.realpathSync.native(absolute); } catch { return absolute; }
    },
  },
};

class EOFError extends Error {
  constructor() { super('EOF when reading a line'); this.name = 'EOFError'; }
}

/**
 * input(prompt): prompt on stdout, one line from fd 0, strict UTF-8 (UnicodeDecodeError like Python's strict stdin),
 * the line ending ("\n", "\r\n") removed; EOFError when nothing could be read.
 */
export function input(prompt = '') {
  // CPython's input() writes the prompt to stderr when stdin and stdout are both terminals (PyOS_Readline).
  if (tty.isatty(0) && tty.isatty(1)) stderr(prompt);
  else stdout(prompt);
  stdout_flush(); // input() flushes sys.stdout before it reads
  const chunks = [];
  const one = Buffer.alloc(1);
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, one, 0, 1, null);
    } catch (err) {
      if (err.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); continue; }
      if (err.code === 'EOF') n = 0;
      else throw err;
    }
    if (n === 0) {
      if (!chunks.length) throw new EOFError();
      break;
    }
    if (one[0] === 0x0a) break;
    chunks.push(Buffer.from(one));
  }
  return utf8Decode(Buffer.concat(chunks)).replace(/\r$/, '');
}

/** getpass.getuser() */
export function getuser() {
  const env = environment();
  for (const name of ['LOGNAME', 'USER', 'LNAME', 'USERNAME']) if (env[name]) return env[name];
  const account = findpwuid(process.getuid());
  if (!account) throw new Error('getuser(): no username could be determined');
  return account.pw_name;
}

/**
 * subprocess.run(command, check=False) with inherited stdio. A Windows batch file (`lcu.cmd`) goes through cmd.exe
 * with an escaped command line built by update.cmd_invocation (never a shell string from unescaped paths).
 */
export function runCommand(command) {
  if (WIN() && /\.(cmd|bat)$/i.test(command[0])) {
    const [comspec, args, extra] = cmd_invocation(command[0], command.slice(1));
    const result = _inject.spawnSync(comspec, args, { stdio: 'inherit', ...extra });
    if (result.error) throw errors.toPyOSError(result.error, command[0]);
    return { returncode: result.status ?? -1 };
  }
  return subprocessRun(command, { stdin: 'inherit' });
}

/**
 * The installer / post-install step: subprocess.run(command, check=False) with inherited stdio, awaitable. POSIX
 * (and Windows executables) go through runtime.supervise, which has Python's SIGINT behaviour (the child gets
 * 0.25 s, is then killed with SIGKILL and reaped, and KeyboardInterrupt is raised); Windows batch files go through
 * runCommand (cmd.exe with an escaped command line).
 */
export async function run_installer(command) {
  if (WIN() && /\.(cmd|bat)$/i.test(command[0])) return runCommand(command);
  const { supervise } = await import('./runtime.mjs');
  return { returncode: await supervise(command, process.env) };
}

/** Python's KeyboardInterrupt (entry.mjs prints it and ends the process by SIGINT, as Python does). */
export class KeyboardInterrupt extends Error {
  constructor(message = '') { super(message); this.name = 'KeyboardInterrupt'; }
}

/**
 * SIGINT as Python's KeyboardInterrupt for the lifetime of the temporary tree: `race(promise)` rejects at once when
 * SIGINT arrives during a download (Python raises inside the socket read), `check()` raises at the next point after a
 * synchronous step (extraction, a child process) and `dispose()` removes the listener. Nothing is installed when
 * the caller left SIGINT ignored (Python never raises then).
 */
function interrupt_guard() {
  let interrupted = false;
  let wake = null;
  const listener = () => { interrupted = true; wake?.(); };
  const active = !ignored_signals().includes('INT');
  if (active) process.on('SIGINT', listener);
  const fired = new Promise((resolve, reject) => { wake = () => reject(new KeyboardInterrupt()); });
  fired.catch(() => {});
  return {
    interrupted: () => interrupted,
    race: (promise) => {
      promise.catch(() => {}); // an abandoned download may still fail after the tree is gone
      return Promise.race([promise, fired]);
    },
    check: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      if (interrupted) throw new KeyboardInterrupt();
    },
    dispose: () => { if (active) process.off('SIGINT', listener); },
  };
}

/**
 * Windows only: a usable Python 3.12+ for the retained install bridge. Returns an argv prefix or null.
 * Python itself used `sys.executable`; the Node updater has to find one (PATHEXT-aware lookup; a probe that hangs
 * is killed with SIGKILL like Python's subprocess timeout).
 */
export function find_python(env = environment()) {
  const candidates = [['python'], ['py', '-3'], ['python3']];
  for (const [name, ...rest] of candidates) {
    const found = which(name, null, env, { platform: updateInject.platform() });
    if (!found) continue;
    const probe = _inject.spawnSync(found, [...rest, '-c', 'import sys; sys.exit(sys.version_info < (3, 12))'],
      { stdio: 'ignore', timeout: 20000, killSignal: 'SIGKILL', env });
    if (!probe.error && probe.status === 0) return [found, ...rest];
  }
  return null;
}

/** _read_json(path): the JSON object (a lossless Map) in `file`, or ValueError. */
function read_json(file) {
  let data;
  try {
    data = loads(_inject.fs.readText(file));
  } catch (exc) {
    if (!(isOS(exc) || isValue(exc))) throw exc;
    throw new ValueError(`Cannot read ${file}: ${excStr(exc)}`);
  }
  if (!(data instanceof Map)) throw new ValueError(`Malformed ${file}`);
  return data;
}
export { read_json as _read_json };

/** Release archive name for one platform and architecture. */
export function asset_name(version, platform, arch) {
  if (!['darwin', 'linux', 'windows'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new ValueError(`No LCU release archive for ${strOf(platform)} ${strOf(arch)}.`);
  }
  return `lcu-${strOf(version)}-${platform}-${arch}` + (platform === 'windows' ? '.zip' : '.tar.gz');
}

/** Path(root).resolve() of the running platform's flavour. */
const resolvePath = (root) => (WIN() ? winPathStr(_inject.fs.realpathWin(String(root))) : posixResolve(String(root)));

/** Return [prefix, bundle, installation] for a release dir, or refuse. */
export function _layout(root) {
  root = resolvePath(root);
  if (!_inject.fs.isFile(pjoin(root, 'bundle.json'))) {
    throw new ValueError('This LCU is a source checkout; `lcu update` only updates an installed release. '
      + 'Rebuild from source or install a release archive.');
  }
  const prefix = pparent(pparent(root));
  if (pname(pparent(root)) !== 'releases' || !_inject.fs.isFile(pjoin(prefix, '.lcu-install'))) {
    throw new ValueError(`${root} is not inside an LCU installation prefix (<prefix>/releases/<name>); `
      + 'update refused.');
  }
  return [prefix, read_json(pjoin(root, 'bundle.json')), read_json(pjoin(root, 'installation.json'))];
}

/** os.path.isabs (ntpath of Python 3.12: a root after the drive; posixpath: a leading slash). */
const isAbs = (p) => (WIN() ? splitWin(p)[1] !== '' : p.startsWith('/'));

/**
 * Installer command line that reproduces the existing install (runtime only).
 * POSIX: `/bin/sh <source>/scripts/install.sh ...` (the Python updater ran install.py / install_macos.py).
 * Windows: `<python> -B <source>/scripts/install_windows.py ...` (`python` is an argv prefix array or a string).
 */
export function installer_command(platform, prefix, installation, source, { python = null } = {}) {
  const scripts = pjoin(source, 'scripts');
  if (platform === 'windows') {
    const interpreter = python === null ? (_inject.find_python() ?? ['python']) : Array.isArray(python) ? python : [python];
    return [...interpreter, '-B', pjoin(scripts, 'install_windows.py'), '--prefix', String(prefix), '--runtime-only'];
  }
  // '-p': a shell named explicitly ignores install.sh's '#!/bin/sh -p' (inherited SHELLOPTS/ENV must stay inert).
  const command = ['/bin/sh', '-p', pjoin(scripts, 'install.sh'), '--prefix', String(prefix), '--runtime-only'];
  const app = get(installation, 'app');
  if (typeof app === 'string' && isAbs(app) && _inject.fs.isDir(app)) command.push('--existing-app', app);
  if (platform === 'linux') {
    // apt cannot run unattended; system libraries stay as installed.
    command.push('--skip-system');
  }
  return command;
}

const PY_WS = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;
const pySplit = (text) => text.split(PY_WS).filter((part) => part !== '');

export function _sha256_expected(text, name) {
  for (const line of pySplitlines(text)) {
    const parts = pySplit(line);
    if (parts.length && SHA.test(parts[0]) && (parts.length === 1 || parts[parts.length - 1].replace(/^\*+/, '') === name)) {
      return parts[0].toLowerCase();
    }
  }
  throw new ValueError(`Malformed checksum file for ${name}.`);
}

/** update_apply._fetch: the body's first 64 KiB, or (with a destination) the streamed file's sha256. */
export async function _fetch(url, destination = null) {
  const options = { systemProxy: system_proxy(), ..._inject.http };
  if (destination === null) return http.fetchBytes(url, options);
  return http.fetchToFile(url, destination, options);
}

/** Download, verify and extract the archive; return the extracted release directory. */
export async function download(info, name, directory, { guard = null } = {}) {
  const base = `${_inject.DOWNLOAD}/${strOf(need(info, 'tag'))}/${name}`;
  const archive = pjoin(directory, name);
  const step = async (promise) => {
    if (guard === null) return promise;
    const value = await guard.race(promise);
    if (guard.interrupted()) throw new KeyboardInterrupt();
    return value;
  };
  eprint(`Downloading ${base}`);
  const actual = await step(_fetch(base, archive));
  const expected = _sha256_expected((await step(_fetch(`${base}.sha256`))).toString('utf8'), name);
  if (actual !== expected) {
    try { fs.unlinkSync(archive); } catch (err) { if (err.code !== 'ENOENT') throw errors.toPyOSError(err, archive); }
    throw new ValueError(`Checksum mismatch for ${name}; refusing to install it.`);
  }
  const extracted = pjoin(directory, 'extract');
  errors.pyfs(extracted, () => fs.mkdirSync(extracted));
  (name.endsWith('.zip') ? extractLcuZip : extractLcuTar)(archive, extracted);
  if (guard !== null) await guard.check();
  const source = pjoin(extracted, name.replace(/\.zip$/, '').replace(/\.tar\.gz$/, ''));
  if (!_inject.fs.isDir(source) || !_inject.fs.isFile(pjoin(source, 'bundle.json'))) {
    throw new ValueError('The archive does not contain an LCU release bundle.');
  }
  return source;
}

/** except (ValueError, OSError, subprocess.SubprocessError, tarfile.TarError, zipfile.BadZipFile) */
const caughtByApply = (err) => isValue(err) || isOS(err) || isSubprocessError(err) || err instanceof TarError || err instanceof BadZipFile;

/** Update the installation containing `root`; return an exit status. */
export async function apply(root, info, { yes = false } = {}) {
  let prefix, bundle, installation, platform, name;
  try {
    [prefix, bundle, installation] = _layout(root);
    platform = get(installation, 'platform', 'linux');
    const arch = truthy(get(installation, 'architecture')) ? get(installation, 'architecture') : get(bundle, 'architecture');
    name = asset_name(need(info, 'version'), platform, arch);
  } catch (exc) {
    if (!(isValue(exc) || exc instanceof KeyError)) throw exc;
    eprint(`lcu update: ${excStr(exc)}`);
    return 1;
  }
  const lcu = pjoin(prefix, platform === 'windows' ? 'lcu.cmd' : 'current/bin/lcu');
  print(`LCU update: ${strOf(get(bundle, 'version'))} -> ${strOf(need(info, 'version'))}\n`
    + `  prefix:  ${prefix}\n  archive: ${name}\n  release: ${strOf(get(info, 'release_url', ''))}`);
  if (!yes) {
    if (!_inject.isatty()) {
      eprint(`Not interactive; nothing changed. To apply, run:\n  ${shlex.quote(lcu)} update --yes`);
      return 2;
    }
    if (!['y', 'yes'].includes(pyStrip(_inject.input('Proceed? [y/N] ')).toLowerCase())) {
      print('Cancelled.');
      return 1;
    }
  }
  // The Windows bridge is Python: refuse before downloading or touching anything when none is usable.
  let python = null;
  if (platform === 'windows') {
    python = _inject.find_python();
    if (python === null) {
      eprint('lcu update: updating LCU on Windows needs Python 3.12 or newer on PATH (only the install step uses it); '
        + 'nothing was downloaded or changed.');
      return 1;
    }
  }
  const temporary = mkdtemp({ prefix: 'lcu-update-' });
  let keep = false;
  // Python: a KeyboardInterrupt anywhere below still runs the `finally` that removes the temporary tree.
  const guard = interrupt_guard();
  try {
    const source = await download(info, name, temporary, { guard });
    const command = installer_command(platform, prefix, installation, source, { python });
    if (platform === 'linux') {
      const uid = _inject.getuid();
      const user = uid === 0 ? (environment().SUDO_USER || null) : null;
      if (uid === 0 && !user) {
        eprint('lcu update: running as root without SUDO_USER; run it as the desktop account '
          + 'through sudo or as that account.');
        return 1;
      }
      if (uid !== 0 && !(_inject.access(prefix) && _inject.access(pjoin(prefix, '.lcu-install'))
        && _inject.access(pjoin(prefix, 'releases')))) {
        keep = true;
        eprint(`${prefix} is not writable by this account. The verified release is at ${source}; `
          + `install it with:\n  sudo ${shlex.join([...command, '--user', _inject.getuser()])}`
          + `\nThen delete ${temporary}.`);
        return 1;
      }
      if (user) command.push('--user', user);
    }
    const status = (await _inject.run(command)).returncode;
    await guard.check();
    if (status) {
      eprint(`lcu update: the installer failed (exit ${status}); the previous release stays current.`);
      return status;
    }
    // The new release refreshes what setup copied out of the old one (the Claude mod).
    const refreshed = (await _inject.run([lcu, 'update', '--post-install'])).returncode;
    await guard.check();
    if (refreshed) {
      eprint(`lcu update: could not refresh harness integrations; rerun \`${lcu} setup\` for your agents.`);
    }
    print(`LCU ${strOf(need(info, 'version'))} installed. Restart agents that use LCU so they load the new release.\n`
      + `To reclaim space from superseded releases, run: ${shlex.quote(lcu)} prune`);
    return 0;
  } catch (exc) {
    if (!caughtByApply(exc)) throw exc;
    eprint(`lcu update: ${excStr(exc)}`);
    return 1;
  } finally {
    guard.dispose();
    if (!keep) {
      try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* ignore_errors=True */ }
    }
  }
}
