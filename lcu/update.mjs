// Find out whether a newer LCU release exists, cache the answer and tell the agent.
// Port of lcu/update.py (see .port/notes/update.md for the function map and deviations).
//
// `main`, `check`, `fetch_latest`, `latest_tag`, `severity_of`, `post_install` and `codex_needs_setup` are async
// (network and dynamic imports); everything the SessionStart/UserPromptSubmit hook needs (`notice`,
// `cached_notice`, `status_line`, `notice_cached`, `announce`, `hook_session_id`) stays synchronous and cheap.
//
// Values read from JSON stay in pyjson's lossless model (Map / int Number|BigInt / PyFloat) end to end: the cache is
// a Map, notice values are the cache's own values, so whatever is printed or re-serialised keeps Python's key order
// and number types (compat caller rules 1-4).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from './compat/spawn.mjs';
import tty from 'node:tty';

import { ArgumentParser, SUPPRESS } from './compat/argparse.mjs';
import { stderr_write, stdout_write } from './compat/pyio.mjs';
import * as errors from './compat/errors.mjs';
import * as http from './compat/http.mjs';
import { PyFloat, dumps, equal, isInt, loads, normInt, pyfloat, ValueError } from './compat/pyjson.mjs';
import * as pyerr from './compat/pyerr.mjs';
import { pyInt, pyStrip } from './compat/pynum.mjs';
import { pathExpanduser, pathStr } from './compat/pathlib.mjs';
import { SubprocessError } from './compat/subprocess.mjs';
import { mkstemp } from './compat/tempfile.mjs';
import { decode as utf8Decode } from './compat/utf8.mjs';
import { winName, winParent, winPathStr } from './compat/winpath.mjs';
import { attribute_error_get } from './compat/pystr.mjs';

export const REPO = 'amontlabs/lcu';
export const LATEST_URL = `https://github.com/${REPO}/releases/latest`;
export const RELEASE_URL = `https://github.com/${REPO}/releases/tag/`;
export const NOTES_URL = `https://raw.githubusercontent.com/${REPO}/%s/docs/releases/%s.md`;
export const INTERVAL = 600;
export const RETRY = 3600;
export const STAMP_TTL = 120;
export const ANNOUNCE_TTL = 7 * 24 * 3600;
export const TIMEOUT = 5;
export const SEVERITIES = ['security', 'breaking'];

const DOC = 'Find out whether a newer LCU release exists, cache the answer and tell the agent.';

// ------------------------------------------------------------------------------------------------ test seams
// Python's tests patch module attributes (`update.fetch_latest`, `update.subprocess.Popen`, `sys.platform`, ...);
// ES module bindings cannot be patched, so the collaborators the tests replace are looked up here.
export const _inject = {
  platform: () => process.platform, // sys.platform
  fetch_latest: null, // set below
  systemProxy: null, // the system proxy settings source; null: compat/http's platform default (scutil / registry)
  latest_tag: (options) => http.latestTag(options),
  severity_of: (tag, version, options) => http.severityOf(tag, version, options),
  enabled: null, // set below
  spawn: (command, args, options) => nodeSpawn(command, args, options),
  apply: async (root, info, options) => (await import('./update_apply.mjs')).apply(root, info, options),
  now: () => Date.now() / 1000, // time.time(): the wall clock, re-read at every call
  stdin: undefined, // string: what the hook harness piped in; undefined: read fd 0
  io: null, // {stdout(text), stderr(text)}: capture output instead of writing fds 1 and 2
  env: undefined, // object: replaces process.env (os.environ)
};

export const environment = () => _inject.env ?? process.env;
const WIN = () => _inject.platform() === 'win32';

// ------------------------------------------------------------------------------------------------ Python-isms
export class KeyError extends Error {
  constructor(key) { super(errors.pyRepr(key)); this.name = 'KeyError'; }
}

/** `isinstance(exc, OSError)`, by class: compat's OSError classes, urllib's, and raw Node system errors. */
export function isOS(err) {
  return err instanceof pyerr.PyOSError || err instanceof http.URLError || err instanceof http.SSLCertVerificationError
    || err instanceof http.PyTimeoutError || err instanceof http.GaiError || err instanceof http.RemoteDisconnected
    || err instanceof http.PlainOSError
    || (err instanceof Error && typeof err.syscall === 'string' && typeof err.code === 'string');
}
/** `isinstance(exc, ValueError)` (JSONDecodeError, UnicodeDecodeError, TOMLDecodeError are subclasses). */
export const isValue = (err) => err instanceof ValueError;
/** `isinstance(exc, subprocess.SubprocessError)` (compat/http's curl TimeoutExpired included). */
export const isSubprocessError = (err) => err instanceof SubprocessError || err instanceof http.TimeoutExpired;

/** str(exc) with Python's text for system errors. */
export function excStr(err) {
  if (err instanceof pyerr.PyOSError) return err.message;
  if (err instanceof Error && typeof err.syscall === 'string') return pyerr.pyStr(err);
  return err instanceof Error ? err.message : String(err);
}

/** type(x).__name__ for the lossless value model. */
export function typeName(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (isInt(v)) return 'int';
  if (typeof v === 'number' || v instanceof PyFloat) return 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  if (v instanceof Map || isPlainDict(v)) return 'dict';
  return v?.constructor?.name ?? 'object';
}

/** Python truthiness. */
export function truthy(value) {
  if (value === null || value === undefined || value === false || value === '' || value === 0 || value === 0n) return false;
  if (value instanceof PyFloat) return value.value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  if (isPlainDict(value)) return Object.keys(value).length > 0;
  return true;
}
const isPlainDict = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
export const isDict = (v) => v instanceof Map || isPlainDict(v);
/** isinstance(v, (int, float)) (bool is an int). */
const isNumeric = (v) => typeof v === 'boolean' || typeof v === 'number' || typeof v === 'bigint' || v instanceof PyFloat;

/** float(v) of an int/float, with Python's OverflowError for ints beyond the double range. */
function toFloat(v) {
  if (v instanceof PyFloat) return v.value;
  if (typeof v === 'boolean') return Number(v);
  if (typeof v === 'bigint') {
    const f = Number(v);
    if (!Number.isFinite(f)) throw new errors.OverflowError('int too large to convert to float');
    return f;
  }
  return v;
}
const intLike = (v) => typeof v === 'boolean' || isInt(v);
/** a - b with Python's numeric tower: exact for two ints, float arithmetic otherwise. */
export function pySub(a, b) {
  if (intLike(a) && intLike(b)) return normInt(BigInt(a) - BigInt(b));
  return toFloat(a) - toFloat(b);
}

/** dict.get(key, default) on a Map or a plain object. */
export function get(dict, key, fallback = null) {
  if (dict instanceof Map) return dict.has(key) ? dict.get(key) : fallback;
  return isPlainDict(dict) && Object.hasOwn(dict, key) ? dict[key] : fallback;
}
/** dict[key] (KeyError when absent). */
export function need(dict, key) {
  if (dict instanceof Map ? !dict.has(key) : !(isPlainDict(dict) && Object.hasOwn(dict, key))) throw new KeyError(key);
  return dict instanceof Map ? dict.get(key) : dict[key];
}

/** str(value) of a JSON/TOML-derived value. */
export function strOf(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v instanceof PyFloat) return pyerr.reprFloat(v.value);
  if (typeof v === 'number') return Number.isSafeInteger(v) ? String(v) : pyerr.reprFloat(v);
  if (typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) return `[${v.map(reprOf).join(', ')}]`;
  if (v instanceof Map) return `{${[...v].map(([k, x]) => `${reprOf(k)}: ${reprOf(x)}`).join(', ')}}`;
  if (isPlainDict(v)) return `{${Object.keys(v).map((k) => `${reprOf(k)}: ${reprOf(v[k])}`).join(', ')}}`;
  return String(v);
}
function reprOf(v) { return typeof v === 'string' ? errors.pyRepr(v) : strOf(v); }

// Output: synchronous, complete writes (CONVENTIONS). Python's Windows stdio translates "\n" to "\r\n".
function writeAll(fd, text) {
  const data = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < data.length) {
    try {
      offset += fs.writeSync(fd, data, offset, data.length - offset);
    } catch (err) {
      if (err.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); continue; }
      throw err;
    }
  }
}
const textMode = (text) => (WIN() ? text.replaceAll('\n', '\r\n') : text);
export const stdout = (text) => (_inject.io ? _inject.io.stdout(textMode(text)) : stdout_write(textMode(text)));
export const stderr = (text) => (_inject.io ? _inject.io.stderr(textMode(text)) : stderr_write(textMode(text)));
export const print = (text = '', end = '\n') => stdout(text + end);
export const eprint = (text = '', end = '\n') => stderr(text + end);

/** Path.read_text(): strict UTF-8 (BOM kept), universal newlines. */
export function readText(file) {
  const data = errors.pyfs(String(file), () => fs.readFileSync(file));
  return utf8Decode(data).replace(/\r\n?/g, '\n');
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}
function isDir(file) {
  try { return fs.statSync(file).isDirectory(); } catch { return false; }
}

// Path flavour of the running platform: PurePosixPath via compat/pathlib, PureWindowsPath via compat/winpath.
export const P = (p) => (WIN() ? winPathStr(String(p)) : pathStr(String(p)));
export const pjoin = (...parts) => (WIN() ? winPathStr(...parts.map(String)) : pathStr(...parts.map(String)));
export const pparent = (p) => (WIN() ? winParent(String(p)) : path.posix.dirname(pathStr(String(p))));
export const pname = (p) => (WIN() ? winName(String(p)) : path.posix.basename(pathStr(String(p))));

/** Path.home(): ntpath.expanduser rules on Windows (USERPROFILE, else HOMEDRIVE+HOMEPATH), posixpath elsewhere. */
export function home_() {
  if (!WIN()) return pathExpanduser('~', { env: environment() });
  const env = environment();
  let userhome;
  if (Object.hasOwn(env, 'USERPROFILE')) userhome = env.USERPROFILE;
  else if (Object.hasOwn(env, 'HOMEPATH')) userhome = winPathStr(env.HOMEDRIVE ?? '', env.HOMEPATH);
  else throw new pathlibRuntimeError('Could not determine home directory.');
  return winPathStr(userhome);
}
class pathlibRuntimeError extends Error {
  constructor(m) { super(m); this.name = 'RuntimeError'; }
}

// ------------------------------------------------------------------------------------------------ versions
function cmpTuple(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = BigInt(a[i]);
    const y = BigInt(b[i]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Dotted integers as an array of ints (Number, BigInt beyond 2^53), or null when unparsable. */
export function parse_version(text) {
  const s = pyStrip(strOf(text));
  if (!s) return null;
  const out = [];
  for (const part of s.replace(/^v+/, '').split('.')) {
    const n = pyInt(part);
    if (n === null) return null;
    out.push(normInt(n));
  }
  return out;
}

/** The release version (the lossless JSON value), or null for a source checkout or unreadable bundle. */
export function installed_version(root) {
  try {
    const data = loads(readText(pjoin(P(root), 'bundle.json')));
    if (!(data instanceof Map) || !data.has('version')) return null; // TypeError / KeyError in Python
    return data.get('version');
  } catch (err) {
    if (isOS(err) || isValue(err)) return null;
    throw err;
  }
}

/** False for source checkouts and when LCU_NO_UPDATE_CHECK is set. */
export function enabled(root, env = null) {
  env = env ?? environment();
  if (!['', '0'].includes(pyStrip(env.LCU_NO_UPDATE_CHECK ?? ''))) return false;
  return parse_version(installed_version(root)) !== null;
}
_inject.enabled = enabled;

// ------------------------------------------------------------------------------------------------ cache
/** Per-account cache file; the install prefix may be root-owned. */
export function cache_path() {
  const home = home_();
  const env = environment();
  let base;
  if (WIN()) base = pjoin(env.LOCALAPPDATA || pjoin(home, 'AppData/Local'), 'LCU/cache');
  else if (_inject.platform() === 'darwin') base = pjoin(home, 'Library/Caches/lcu');
  else base = pjoin(env.XDG_CACHE_HOME || pjoin(home, '.cache'), 'lcu');
  return pjoin(base, 'update.json');
}
const sibling = (file, name) => pjoin(pparent(file), name);

/** The cache dict (a lossless Map) when it has a numeric checked_at, else null. */
export function read_cache() {
  try {
    const data = loads(readText(cache_path()));
    return data instanceof Map && isNumeric(data.get('checked_at')) ? data : null;
  } catch (err) {
    if (isOS(err) || isValue(err)) return null;
    throw err;
  }
}

/** json.dump of `value` into a fresh 0600 mkstemp file next to `target`, then os.replace. */
function atomicJson(target, prefix, value) {
  errors.pyfs(pparent(target), () => fs.mkdirSync(pparent(target), { recursive: true }));
  const { fd, path: name } = mkstemp({ dir: pparent(target), prefix });
  try {
    writeAll(fd, dumps(value));
  } finally {
    fs.closeSync(fd);
  }
  errors.pyfs(name, () => fs.renameSync(name, target), target);
}

/** Atomic write; failures are ignored (the cache is only a courtesy). */
export function write_cache(latest, error) {
  const file = cache_path();
  try {
    atomicJson(file, '.update-', new Map([['checked_at', pyfloat(_inject.now())], ['latest', latest], ['error', error]]));
  } catch (err) {
    if (!isOS(err)) throw err;
  }
}

export function stale(cache, now = null) {
  now = now ?? _inject.now();
  if (cache === null || cache === undefined) return true;
  const age = pySub(now, need(cache, 'checked_at'));
  return age < 0 || age >= (truthy(get(cache, 'error')) ? RETRY : INTERVAL);
}

// ------------------------------------------------------------------------------------------------ network
/** The latest release tag, from the redirect of /releases/latest (no API, no rate limit). */
/**
 * The system proxy source every update request uses, as urllib's getproxies()/proxy_bypass() consult it when no
 * proxy environment variable is set: macOS scutil, Windows the HKCU Internet Settings registry values
 * (compat/http defaultSystemProxy -> macosSystemProxy / windowsSystemProxy).
 */
export const system_proxy = () => _inject.systemProxy ?? http.defaultSystemProxy;
export const latest_tag = (options = {}) => _inject.latest_tag({ systemProxy: system_proxy(), ...options });
/** `security` or `breaking` from the release notes marker; anything else is `normal`. */
export const severity_of = (tag, version, options = {}) => _inject.severity_of(tag, version, { notesTemplate: NOTES_URL, systemProxy: system_proxy(), ...options });
export const curl = http.curl;
export const cert_failure = http.certFailure;

async function fetch_latest_impl(options = {}) {
  const tag = await latest_tag(options);
  const version = tag.slice(0, 1) === 'v' ? tag.slice(1) : tag;
  if (parse_version(version) === null) throw new ValueError(`Unrecognized release tag: ${tag}`);
  return { version, tag, release_url: RELEASE_URL + tag, severity: await severity_of(tag, version, options) };
}
_inject.fetch_latest = fetch_latest_impl;
/** Release info dict for the newest release; raises OSError/ValueError on failure. */
export const fetch_latest = (options = {}) => _inject.fetch_latest(options);

/** Network check now; updates the cache. Returns [info or null, error or null]. */
export async function check(root) {
  let info;
  try {
    info = await fetch_latest();
  } catch (exc) {
    if (!(isOS(exc) || isValue(exc) || isSubprocessError(exc))) throw exc;
    const error = excStr(exc) || exc.name;
    // Keep the last known release so a flaky network does not hide a pending update.
    const previous = read_cache();
    write_cache(previous ? get(previous, 'latest') : null, error);
    return [null, error];
  }
  write_cache(info, null);
  return [info, null];
}

export function newer(root, info) {
  const current = parse_version(installed_version(root));
  const latest = parse_version(truthy(info) ? get(info, 'version') : null);
  return Boolean(current && latest && cmpTuple(latest, current) > 0);
}

/** The stable `lcu` path of this installation (`current` on POSIX, `<prefix>\lcu.cmd` on Windows). */
export function stable_command(root) {
  root = P(root);
  if (WIN() && pname(pparent(root)) === 'releases') return pjoin(pparent(pparent(root)), 'lcu.cmd');
  return lcu_command(root);
}

// claude_mod.lcu_command, kept local: claude_mod.mjs imports setup.mjs, and the per-prompt update hook must stay cheap.
function lcu_command(release_root) {
  let root = P(release_root);
  if (pname(pparent(root)) === 'releases') root = pjoin(pparent(pparent(root)), 'current');
  return pjoin(root, 'bin', 'lcu');
}

/** True when this caller should spawn a refresh (touches refresh.stamp); never raises. */
export function refresh_claimed(now = null) {
  try {
    const stamp = sibling(cache_path(), 'refresh.stamp');
    // Date.now() truncates to the millisecond while file mtimes have nanoseconds: compare against the end of the
    // current millisecond so a stamp written just now is never "in the future" (Python's time.time() has µs).
    now = now ?? _inject.now() + 0.001;
    try {
      const age = toFloat(now) - fs.statSync(stamp).mtimeMs / 1000;
      if (age >= 0 && age < STAMP_TTL) return false;
    } catch { /* no usable stamp */ }
    fs.mkdirSync(pparent(stamp), { recursive: true });
    try {
      const t = new Date();
      fs.utimesSync(stamp, t, t);
    } catch {
      fs.closeSync(fs.openSync(stamp, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o666));
    }
    return true;
  } catch {
    return true;
  }
}

// ------------------------------------------------------------------------------------------------ cmd.exe
// A .cmd/.bat file cannot be spawned without cmd.exe. Python's CreateProcess runs it through %ComSpec% /c with the
// CRT command line; Node needs the cmd line built explicitly. Every cmd metacharacter (incl. space, `&`, `|`, `%`,
// `^`, parentheses) is caret-escaped outside quotes, and arguments get CRT quoting first and a second caret pass
// because a batch file re-parses %* (the cross-spawn rules, see the Node child_process docs on .bat/.cmd files).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
export function cmd_escape_command(text) {
  return String(text).replace(CMD_META, '^$1');
}
export function cmd_escape_argument(text) {
  let arg = String(text);
  arg = arg.replace(/(\\*)"/g, '$1$1\\"');
  arg = arg.replace(/(\\*)$/, '$1$1');
  arg = `"${arg}"`;
  return arg.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}
/** [command, args, extra spawn options] that run the batch file `file` with `args` through cmd.exe, no shell string. */
export function cmd_invocation(file, args, env = environment()) {
  const comspec = env.ComSpec || env.COMSPEC || (env.SystemRoot ? winPathStr(env.SystemRoot, 'System32', 'cmd.exe') : 'cmd.exe');
  const line = [cmd_escape_command(file), ...args.map(cmd_escape_argument)].join(' ');
  return [comspec, ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true }];
}

/**
 * The detached refresh. Python: [sys.executable, <root>/bin/lcu, 'update', '--refresh'], i.e. the release's own
 * launcher. Here the launcher is the POSIX sh shim, run as `/bin/sh -p <root>/bin/lcu ...` (its shebang), so the
 * pre-Node gate and the startup-variable quarantine apply exactly as for any other invocation (BRIEF addendum A/B);
 * on Windows the stable dispatcher `<prefix>\lcu.cmd` (its own pre-Node checks) through cmd.exe.
 * Returns [command, args, extra spawn options].
 */
export function refresh_command(root) {
  root = P(root);
  if (WIN()) {
    const stable = stable_command(root);
    const dispatcher = pname(stable) === 'lcu.cmd' ? stable : pjoin(root, 'bin', 'lcu.cmd');
    return cmd_invocation(dispatcher, ['update', '--refresh']);
  }
  return ['/bin/sh', ['-p', pjoin(root, 'bin/lcu'), 'update', '--refresh'], {}];
}

/** Start a detached `lcu update --refresh`; never waits. */
export function spawn_refresh(root) {
  const [command, args, extra] = refresh_command(root);
  // detached: setsid on POSIX (start_new_session); DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP on Windows.
  const child = _inject.spawn(command, args, { stdio: 'ignore', detached: true, ...extra });
  child?.on?.('error', () => {});
  child?.unref?.();
  return child;
}

export function message(root, info, current) {
  const severity = get(info, 'severity');
  if (severity instanceof Map || Array.isArray(severity)) throw new TypeError(`unhashable type: '${typeName(severity)}'`);
  const prefix = severity === 'security' ? 'Security update: ' : severity === 'breaking' ? 'Breaking update: ' : '';
  return `${prefix}LCU ${strOf(need(info, 'version'))} is available (installed: ${strOf(current)}). Tell the user and offer to run `
    + `\`${stable_command(root)} update\`; do not upgrade without asking. Agents using LCU must be `
    + `restarted afterwards. Release notes: ${strOf(need(info, 'release_url'))}`;
}

/** The cached update notice dict, or null. Never blocks on the network and never raises. */
export function notice(root) {
  try {
    if (!_inject.enabled(root)) return null;
    if (stale(read_cache())) {
      try {
        if (refresh_claimed()) spawn_refresh(root);
      } catch { /* a refresh is only a courtesy */ }
    }
    return notice_cached(root);
  } catch {
    return null;
  }
}

/**
 * sys.stdin.read(limit): up to `limit` code points (strict UTF-8, the locale default), never reading more bytes than
 * code points still wanted, so nothing past the bound is consumed.
 */
function readStdin(limit) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const buffer = Buffer.allocUnsafe(65536);
  let text = '';
  let count = 0;
  while (count < limit) {
    let n;
    try {
      n = fs.readSync(0, buffer, 0, Math.min(buffer.length, limit - count), null);
    } catch (err) {
      if (err.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); continue; }
      if (err.code === 'EOF') break;
      throw err;
    }
    if (n === 0) break;
    const piece = decoder.decode(buffer.subarray(0, n), { stream: true });
    for (const _ of piece) count += 1; // eslint-disable-line no-unused-vars
    text += piece;
  }
  return text + decoder.decode();
}

/** session_id from the hook input JSON on stdin (the harness closes it), or null. */
export function hook_session_id() {
  try {
    let text;
    if (_inject.stdin !== undefined) text = _inject.stdin;
    else {
      if (tty.isatty(0)) return null;
      text = readStdin(1 << 20);
    }
    const data = loads(text);
    const value = data instanceof Map ? data.get('session_id') : null;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

/** True when this session should be told about `version`; records it. Never raises. */
export function announce(session_id, version, now = null) {
  try {
    if (!session_id) return true;
    if (now === null) now = pyfloat(_inject.now()); // time.time() is a float; an explicit `now` keeps its type
    const file = sibling(cache_path(), 'announced.json');
    let data;
    try {
      data = loads(readText(file));
      data = data instanceof Map ? data : new Map();
    } catch (err) {
      if (!(isOS(err) || isValue(err))) throw err;
      data = new Map();
    }
    const kept = new Map();
    for (const [k, v] of data) {
      if (!(v instanceof Map) || !isNumeric(v.get('at'))) continue;
      const age = pySub(now, v.get('at'));
      if (age >= 0 && age < ANNOUNCE_TTL) kept.set(k, v);
    }
    data = kept;
    const previous = data.get(session_id);
    if (equal(get(previous ?? new Map(), 'version'), version)) return false;
    data.set(session_id, new Map([['version', version], ['at', now]]));
    try {
      atomicJson(file, '.announced-', data);
    } catch (err) {
      if (!isOS(err)) throw err;
    }
    return true;
  } catch {
    return true;
  }
}

/** The notice from the cache only (no refresh), or null; never raises. */
export function cached_notice(root) {
  try {
    return _inject.enabled(root) ? notice_cached(root) : null;
  } catch {
    return null;
  }
}

/** One human line for status/doctor from the cache only, or null. */
export function status_line(root) {
  try {
    const found = cached_notice(root);
    return found === null ? null
      : `LCU ${strOf(found.latest)} is available (installed ${strOf(found.current)}): ${strOf(found.release_url)}. `
        + `Run \`${found.command} update\` to upgrade.`;
  } catch {
    return null;
  }
}

/**
 * Like `notice` without starting a refresh. The result has fixed identifier keys (a plain object, Python's dict
 * order); its values are the cache's lossless values.
 */
export function notice_cached(root) {
  const cache = read_cache();
  const info = cache ? get(cache, 'latest') : null;
  if (!(info instanceof Map) || !newer(root, info)) return null;
  const current = installed_version(root);
  const raw = get(info, 'severity');
  const severity = SEVERITIES.some((s) => equal(s, raw)) ? raw : 'normal';
  const merged = new Map(info);
  merged.set('severity', severity);
  return {
    current, latest: need(info, 'version'), severity, release_url: need(info, 'release_url'),
    command: String(stable_command(root)), message: message(root, merged, current),
  };
}

// ------------------------------------------------------------------------------------------------ codex hint
/** `key in container` */
function pyIn(key, container) {
  if (container instanceof Map) return container.has(key);
  if (Array.isArray(container)) return container.some((item) => equal(item, key));
  if (typeof container === 'string') return container.includes(key);
  throw new TypeError(`argument of type '${typeName(container)}' is not iterable`);
}
/** iter(container) */
function pyIter(container) {
  if (Array.isArray(container)) return container;
  if (container instanceof Map) return [...container.keys()];
  if (typeof container === 'string') return Array.from(container);
  throw new TypeError(`'${typeName(container)}' object is not iterable`);
}

/** True when Codex has LCU registered but not the update-notice hook (added by `lcu setup --agent codex`). */
export async function codex_needs_setup(home = null, env = null) {
  const tomllib = await import('./compat/toml.mjs');
  const { is_notice_group } = await import('./codex_hooks.mjs');
  env = env ?? environment();
  const config = pjoin(env.CODEX_HOME || pjoin(home || home_(), '.codex'), 'config.toml');
  let data;
  try {
    data = tomllib.loads(readText(config));
  } catch (err) {
    if (isOS(err) || isValue(err)) return false;
    throw err;
  }
  const servers = get(data, 'mcp_servers');
  if (!pyIn('lcu', truthy(servers) ? servers : new Map())) return false;
  let hooks = get(data, 'hooks');
  hooks = truthy(hooks) ? hooks : new Map();
  if (!(hooks instanceof Map)) throw attribute_error_get(hooks);
  return !['SessionStart', 'UserPromptSubmit'].every((event) => {
    const groups = get(hooks, event);
    return pyIter(truthy(groups) ? groups : []).some((group) => group instanceof Map && is_notice_group(group));
  });
}

/** Refresh what setup copied out of an earlier release; `lcu update` runs it from the new release. */
export async function post_install(root, home = null) {
  const claude_mod = await import('./claude_mod.mjs');
  const browser = await import('./browser.mjs');
  root = P(root);
  home = P(home || home_());
  const target = claude_mod.destination(home);
  if (isDir(target) && claude_mod._owned(target)) {
    claude_mod.install(home, root);
    print(`Refreshed the Claude Code lcu-approve mod at ${target}.`);
  }
  if (await codex_needs_setup(home)) {
    print(`Codex: run \`${stable_command(root)} setup --agent codex\` to add the LCU update-notice hook.`);
  }
  // Browser relays copied outside the release (Chrome native-messaging launchers) still point at the previous
  // release's runtime; the new browser module rewrites the ones LCU owns (BRIEF addendum G).
  await browser.migrate_relays(root, home);
  // Windows harness registrations written by a Python release (or the interim direct-Node form) move to the
  // validating <prefix>\lcu.cmd (BRIEF addendum G); failures are reported, the install stays done.
  const { failures } = await migrate_windows_registrations(root, home);
  return failures.length ? 1 : 0;
}

// ------------------------------------------------------------------------------------------------ Windows migration
const LEGACY_FLAGS = ['--chrome', '--audio'];

/**
 * Every LCU registration of this installation that LCU can find, as {name, scope, project, argv, where}: `argv` is the
 * registered launcher command with the harness relay (`<node> <release>/adapters/<codex|claude>.mjs`) removed.
 * Read-only. Codex: config.toml `[mcp_servers.lcu]` (user and project scope); Claude Code: `~/.claude.json` /
 * `<project>/.mcp.json` `mcpServers.lcu` (add-mcp's files); Pi: LCU's commands.json; Hermes: lcu-config.json;
 * OMP: the generated `index.ts` of its user package. Project directories come from what LCU recorded (launcher pins,
 * Pi's commands.json, the saved pending context) and Claude's project list.
 */
export async function find_windows_registrations(setup, home, env = process.env) {
  const approval = await import('./approval.mjs');
  const tomllib = await import('./compat/toml.mjs');
  const { join_path, read_text: setupRead, is_dir: setupIsDir, is_file: setupIsFile } = setup;
  const readJson = (file) => (setupIsFile(file) ? loads(setupRead(file)) : null);
  const found = [];
  const add = (name, scope, project, argv, where) => {
    if (Array.isArray(argv) && argv.length && argv.every((item) => typeof item === 'string')) found.push({ name, scope, project, argv, where });
  };
  const unwrap = (argv, adapter) => (argv.length >= 2 && new RegExp(`(^|[\\\\/])adapters[\\\\/]${adapter}\\.mjs$`, 'i').test(argv[1]) ? argv.slice(2) : argv);
  const serverArgv = (server) => {
    if (!(server instanceof Map) || typeof server.get('command') !== 'string') return null;
    const args = server.has('args') ? server.get('args') : [];
    return Array.isArray(args) ? [server.get('command'), ...args] : null;
  };
  const safely = (what, fn) => {
    try { fn(); } catch (exc) {
      if (!(setup.isExpectedError(exc) || isValue(exc) || isOS(exc))) throw exc;
      eprint(`lcu update: skipped unreadable ${what}: ${excStr(exc)}`);
    }
  };
  const projects = new Set();
  const piFile = join_path(home, 'AppData/Local/LCU/pi/commands.json');
  safely(piFile, () => {
    const pi = readJson(piFile);
    if (!(pi instanceof Map)) return;
    add('pi', 'user', null, get(pi, 'user'), piFile);
    const piProjects = get(pi, 'projects');
    if (piProjects instanceof Map) {
      for (const [dir, argv] of piProjects) { add('pi', 'project', dir, argv, piFile); projects.add(dir); }
    }
  });
  const claudeUser = join_path(home, '.claude.json');
  safely(claudeUser, () => {
    const doc = readJson(claudeUser);
    if (!(doc instanceof Map)) return;
    const argv = serverArgv(get(get(doc, 'mcpServers', new Map()), 'lcu'));
    if (argv) add('claude-code', 'user', null, unwrap(argv, 'claude'), claudeUser);
    const listed = get(doc, 'projects');
    if (listed instanceof Map) for (const dir of listed.keys()) projects.add(dir);
  });
  return {
    found, projects, more: (extraProjects) => {
      for (const dir of extraProjects) if (typeof dir === 'string' && dir) projects.add(dir);
      for (const [scope, project] of [['user', null], ...[...projects].map((dir) => ['project', dir])]) {
        if (scope === 'project' && !setupIsDir(project)) continue;
        const codexFile = approval.codex_config_path(home, scope, project, env);
        safely(codexFile, () => {
          if (!setupIsFile(codexFile)) return;
          const doc = tomllib.loads(setupRead(codexFile));
          const argv = serverArgv(get(get(doc, 'mcp_servers', new Map()), 'lcu'));
          if (argv) add('codex', scope, project, unwrap(argv, 'codex'), codexFile);
        });
        if (scope === 'project') {
          const claudeFile = join_path(project, '.mcp.json');
          safely(claudeFile, () => {
            const doc = readJson(claudeFile);
            const argv = doc instanceof Map ? serverArgv(get(get(doc, 'mcpServers', new Map()), 'lcu')) : null;
            if (argv) add('claude-code', 'project', project, unwrap(argv, 'claude'), claudeFile);
          });
        }
      }
      const hermesFile = join_path(env.HERMES_HOME || join_path(home, '.hermes'), 'plugins/lcu-cua/lcu-config.json');
      safely(hermesFile, () => {
        const doc = readJson(hermesFile);
        if (doc instanceof Map) add('hermes', 'user', null, get(doc, 'command'), hermesFile);
      });
      // OMP: only the package `lcu setup --agent omp` would rewrite for this environment (its profile identity).
      const identity = ['user', '', ...['OMP_PROFILE', 'PI_PROFILE', 'PI_CODING_AGENT_DIR'].map((key) => (Object.hasOwn(env, key) ? env[key] : null) ?? '')];
      const ompFile = join_path(home, 'AppData/Local/LCU/omp',
        `user-${createHash('sha256').update(dumps(identity)).digest('hex').slice(0, 16)}`, 'index.ts');
      safely(ompFile, () => {
        if (!setupIsFile(ompFile)) return;
        const match = /lcu\(pi, \{command: (.*), connectOnLoad: true/.exec(setupRead(ompFile));
        if (match) add('omp', 'user', null, loads(match[1]), ompFile);
      });
      return found;
    },
  };
}

/** True when `child` is `parent` itself or inside it (Windows: case-insensitive, either separator). */
function within(child, parent) {
  const norm = (p) => String(p).replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
  return norm(child) === norm(parent) || norm(child).startsWith(`${norm(parent)}\\`);
}

/**
 * Post-install on Windows: re-register each LCU-owned legacy registration of THIS prefix
 * ([python, -B, <prefix>\windows_launcher.py, flags...] or [node.exe, <prefix>\...\dispatcher.mjs, flags...]) through
 * setup's own registration path (setup.impl.configure, the upstream add-mcp / harness installers), with the validating
 * [<SystemRoot>\System32\cmd.exe, /d, /c, <prefix>\lcu.cmd, flags...] command, keeping its scope/project and
 * --chrome/--audio flags; approval is passed as "keep" (configure preserves the harness's current approval policy).
 * Registrations of other prefixes, current-form registrations and non-LCU entries are never touched. The launcher pin
 * of a registration is replaced only after its migration succeeded. Returns {migrated, failures}.
 */
export async function migrate_windows_registrations(root, home) {
  const setup = await import('./setup.mjs');
  if (setup.impl.platform !== 'win32') return { migrated: [], failures: [] };
  const { join_path, path_parent, path_parts } = setup;
  const releases = path_parent(root);
  if (path_parts(releases).at(-1) !== 'releases') return { migrated: [], failures: [] };
  const prefix = path_parent(releases);
  const owned = (argv) => {
    const form = setup.windows_command_form(argv);
    if (form === 'python') return within(argv[2], join_path(prefix, 'windows_launcher.py')) ? argv.slice(3) : null;
    if (form === 'node') return within(argv[1], prefix) || within(argv[0], prefix) ? argv.slice(2) : null;
    return null;
  };
  const scan = async () => {
    const reader = await find_windows_registrations(setup, home);
    const extra = [];
    const pins = setup.read_file(join_path(prefix, setup.LAUNCHER_PINS));
    if (pins !== null) {
      try {
        const registrations = get(loads(pins), 'registrations');
        if (registrations instanceof Map) for (const key of registrations.keys()) extra.push(String(key).split('|').slice(2).join('|'));
      } catch (exc) {
        if (!isValue(exc)) throw exc;
      }
    }
    try {
      const context = setup.load_setup_state(home).pending_context;
      if (context instanceof Map && typeof context.get('project') === 'string') extra.push(context.get('project'));
    } catch (exc) {
      if (!isValue(exc)) throw exc;
    }
    return reader.more(extra);
  };
  const label = (item) => `${CLIENT_LABELS[item.name] ?? item.name} (${item.scope}${item.project ? ` ${item.project}` : ''})`;
  const legacy = (await scan()).filter((item) => owned(item.argv) !== null);
  const migrated = [];
  const failures = [];
  if (!legacy.length) return { migrated, failures };
  const lcuCmd = join_path(prefix, 'lcu.cmd');
  const report = (item, why) => {
    failures.push([item, why]);
    eprint(`lcu update: could not move the ${label(item)} registration off the previous launcher: ${why}. `
      + `It keeps working through the old launcher; rerun \`${lcuCmd} setup --agent ${item.name}`
      + `${item.scope === 'project' ? ` --scope project --project ${item.project}` : ''}\` to finish.`);
  };
  const lock = await setup.impl.setup_lock(home);
  try {
    const seen = new Set();
    for (const item of legacy) {
      const key = `${item.name}|${item.scope}|${item.project ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const flags = owned(item.argv);
      if (!flags.every((flag) => LEGACY_FLAGS.includes(flag))) {
        report(item, `unrecognised launcher arguments ${flags.join(' ')}`);
        continue;
      }
      try {
        const command = [...setup.windows_registration_command(prefix), ...flags];
        setup.assert_windows_registration(command);
        const tools_root = join_path(root, 'agent-tools');
        const environment = { ...process.env, PATH: setup.harness_search_path(home) };
        setup.impl.installer_environment(home, [item.name], environment);
        setup.impl.installer_paths(tools_root);
        const result = await setup.impl.configure([item.name], home, command, tools_root, root, {
          scope: item.scope, project: item.project, setup_command: lcuCmd, environ: environment, approval: null,
        });
        if (result.length) {
          report(item, result.map(([, phase, detail]) => `${phase}: ${detail}`).join('; '));
          continue;
        }
        // Confirm through the same reader before letting the old generation go.
        const after = (await scan()).find((other) => other.name === item.name && other.scope === item.scope
          && (other.project ?? '') === (item.project ?? ''));
        if (!after || setup.windows_command_form(after.argv) !== 'cmd') {
          report(item, 'the harness still lists the previous launcher after re-registration');
          continue;
        }
        setup.record_launcher_pins(prefix, [item.name], item.scope, item.project, setup.windows_launcher(prefix));
        migrated.push(item);
        print(`${label(item)}: registration now runs ${lcuCmd}.`);
      } catch (exc) {
        if (!(setup.isExpectedError(exc) || isValue(exc) || isOS(exc))) throw exc;
        report(item, excStr(exc));
      }
    }
  } finally {
    lock.release();
  }
  return { migrated, failures };
}
const CLIENT_LABELS = { codex: 'Codex', 'claude-code': 'Claude Code', pi: 'Pi', omp: 'Oh My Pi', hermes: 'Hermes' };

export async function main(root, argv = null) {
  const parser = new ArgumentParser({ prog: 'lcu update', description: DOC });
  const mode = parser.add_mutually_exclusive_group();
  mode.add_argument('--check', { action: 'store_true', help: 'Check now without installing' });
  mode.add_argument('--notice', { action: 'store_true', help: 'Print the cached update notice for an agent (never uses the network)' });
  mode.add_argument('--refresh', { action: 'store_true', help: SUPPRESS });
  mode.add_argument('--post-install', { action: 'store_true', help: SUPPRESS });
  parser.add_argument('--json', { action: 'store_true', help: 'Print JSON (with --check or --notice)' });
  parser.add_argument('--hook', { choices: ['SessionStart', 'UserPromptSubmit'], help: SUPPRESS });
  parser.add_argument('--yes', { action: 'store_true', help: 'Do not ask before installing' });
  const args = parser.parse_args(argv);
  root = P(root);
  if (args.notice) {
    try {
      const found = notice(root);
      if (args.hook) {
        // A hook's documented way to add model context: once per session and release, else silent.
        if (found) {
          const session = hook_session_id();
          if ((session || args.hook === 'SessionStart') && announce(session, found.latest)) {
            print(dumps({ hookSpecificOutput: { hookEventName: args.hook, additionalContext: found.message } }));
          }
        }
      } else {
        print(args.json ? dumps(found || {}) : (found ? found.message : ''), args.json || found ? '\n' : '');
      }
    } catch { /* hooks never fail the agent */ }
    return 0;
  }
  if (args.post_install) return post_install(root);
  if (args.refresh) {
    try {
      if (_inject.enabled(root)) await check(root);
    } catch { /* silent */ }
    return 0;
  }
  const current = installed_version(root);
  if (parse_version(current) === null) {
    throw new ValueError('lcu update needs an installed LCU release, not a source checkout.');
  }
  const [info, error] = await check(root);
  const available = newer(root, info);
  if (args.check) {
    if (args.json) print(dumps({ current, latest: info, update_available: available, error }));
    else if (error) eprint(`lcu update: could not check for updates: ${error}`);
    else if (available) {
      print(`LCU ${strOf(need(info, 'version'))} is available (installed ${strOf(current)}): ${strOf(need(info, 'release_url'))}\n`
        + `Run ${stable_command(root)} update to upgrade.`);
    } else print(`LCU ${strOf(current)} is up to date.`);
    return error ? 1 : 0;
  }
  if (error) {
    eprint(`lcu update: could not check for updates: ${error}`);
    return 1;
  }
  if (!available) {
    print(`LCU ${strOf(current)} is up to date.`);
    return 0;
  }
  return _inject.apply(root, info, { yes: args.yes });
}
