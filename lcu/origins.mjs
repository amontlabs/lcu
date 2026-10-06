// `lcu origins`: show and forget the Chrome site decisions the original runtime saves per session.
//
// When a user answers "Allow Browser use to access <origin>?", the original browser service keeps the
// answer for that harness session in `$CODEX_HOME/browser/sessions/<session-id>.toml` as
// `[origins] allowed = [...] / denied = [...]` and checks it before it asks again. That format is the
// original runtime's private storage, not an interface. This module only reads it and removes
// entries; it never adds one, so granting access stays with the original prompt. It does not touch
// `browser/config.toml` or `browser_use.origins` in `config.toml`.
//
// Port of lcu/origins.py (LCU 0.9.6, #21). Python-only behaviour comes from lcu/compat: toml.mjs (tomllib),
// pyjson.mjs (json.dumps), argparse.mjs, lock.mjs (the side-file lock), tempfile.mjs, flavour.mjs (pathlib), and
// the urllib.parse.urlsplit / ipaddress subset normalize_origin needs (below). `hooks` holds the injection points
// the Python tests reach with mock.patch (write_atomically, os.replace, read, default_codex_home, sleep).
import {
  chmodSync, closeSync, constants, fsyncSync, lstatSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';

import { ArgumentParser, io, PySystemExit, pyStrip, RawDescriptionHelpFormatter } from './compat/argparse.mjs';
import { flavour } from './compat/flavour.mjs';
import { acquireSync, LockTimeoutError } from './compat/lock.mjs';
import { fromNodeError, pyStr, reprStr } from './compat/pyerr.mjs';
import { dumps, equal, isDict, isInt, UnicodeDecodeError, ValueError } from './compat/pyjson.mjs';
import { mkstemp } from './compat/tempfile.mjs';
import { loads as tomlLoads, loadsBytes as tomlLoadsBytes, TOMLDecodeError } from './compat/toml.mjs';
import { compare, ljust, stem } from './compat/unicode.mjs';
import { default_codex_home } from './runtime.mjs';

export const KINDS = ['allowed', 'denied'];
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/; // the original runtime's own rule for a session id
export const WRITE_ATTEMPTS = 5;
export const LOCK_NAME = '.lcu-origins.lock'; // not a session file: no .toml suffix
export const LOCK_WAIT = 10; // seconds
export const CACHE_NOTE = ('A running agent may keep its saved decisions in memory for up to 5 minutes. Restart the '
  + 'agent, or wait, and the next request for the site asks again.');
const DEFAULT_PORTS = { http: 80, https: 443 };
const HOST = /^[a-z0-9._-]+$/;
const NUMERIC_LABEL = /^(?:[0-9]+|0x[0-9a-f]*)$/;
const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const STRING = /"(?:[^"\\\n]|\\[^\n])*"|'[^'\n]*'/g;

const sleepSync = (seconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);

export const hooks = {
  windows_paths: () => process.platform === 'win32',
  default_codex_home: (env, windows) => default_codex_home(env, windows),
  write_atomically: (path, text, mode) => _write_atomically(path, text, mode),
  replace: (source, target) => renameSync(source, target),
  read: (path) => _read(path),
  sleep: sleepSync,
};
const F = flavour({ windows: () => hooks.windows_paths() });

const print = (text = '') => io.stdout(`${text}\n`);
const printError = (text = '') => io.stderr(`${text}\n`);

/** A problem to show the user without a traceback. */
export class OriginsError extends ValueError {
  constructor(message) {
    super(message);
    this.name = 'OriginsError';
  }
}

/** A session file LCU can read but will not rewrite. */
export class UnsupportedShape extends OriginsError {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedShape';
  }
}

const strerrorOf = (error) => {
  const converted = fromNodeError(error);
  return converted ? (converted.strerror || converted.message) : (error?.strerror || pyStr(error));
};
const isOSError = (error) => typeof error?.code === 'string' || error?.name === 'OSError' || Number.isInteger(error?.errno);

// Locations -------------------------------------------------------------------------------------

/** CODEX_HOME exactly as the launched runtime sees it (see runtime.environment). */
export function codex_home(env = null, { windows = null } = {}) {
  env = env ?? process.env;
  windows = windows === null ? process.platform === 'win32' : windows;
  if (!Object.hasOwn(env, 'CODEX_HOME')) return F.str(hooks.default_codex_home(env, windows));
  const value = env.CODEX_HOME;
  if (!value) throw new OriginsError('CODEX_HOME is set but empty; unset it or set an absolute path.');
  if (!F.isAbsolute(value)) throw new OriginsError(`CODEX_HOME must be an absolute path, not ${reprStr(value)}.`);
  return F.str(value);
}

export function sessions_directory(home) {
  return F.join(home, 'browser', 'sessions');
}

export function check_session_id(value) {
  if (!SESSION_ID.test(value)) {
    throw new OriginsError(`${reprStr(value)} is not a session id (1 to 128 letters, digits, "_" or "-").`);
  }
  return value;
}

// pathlib's predicates (3.12): only "does not exist"-like errors mean False; PermissionError and the rest raise.
const IGNORED = new Set(['ENOENT', 'ENOTDIR', 'EBADF', 'ELOOP']);
const predicate = (probe) => (path) => {
  try {
    return probe(F.native(path));
  } catch (error) {
    if (IGNORED.has(error?.code)) return false;
    throw error;
  }
};
const isFile = predicate((path) => statSync(path).isFile());
const isDir = predicate((path) => statSync(path).isDirectory());
const isSymlink = predicate((path) => lstatSync(path).isSymbolicLink());

/** Path.glob('*.toml') names (3.12): a directory that cannot be listed (PermissionError) yields nothing. */
function globToml(directory) {
  let names;
  try {
    names = readdirSync(F.native(directory));
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return [];
    throw error;
  }
  return names.filter((name) => name.endsWith('.toml')).sort(compare);
}

/** [[session id, path]] of the saved session files; one of them when `session` is given. */
export function session_files(directory, session = null) {
  if (session !== null && session !== undefined) {
    const path = F.join(directory, `${check_session_id(session)}.toml`);
    if (!isFile(path)) throw new OriginsError(`no saved site decisions for session ${session} (${path} does not exist).`);
    return [[session, path]];
  }
  if (!isDir(directory)) return [];
  const found = [];
  for (const name of globToml(directory)) {
    const path = F.join(directory, name);
    const id = stem(name);
    if (SESSION_ID.test(id) && isFile(path)) found.push([id, path]);
  }
  return found;
}

// Origins ---------------------------------------------------------------------------------------

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]+$/;

class URLValueError extends Error {}

/** urllib.parse.urlsplit (CPython 3.12) with the .hostname and .port properties. */
function urlsplit(url) {
  url = url.replace(/^[\x00-\x20]+/, '').replace(/[\t\r\n]/g, '');
  let scheme = '';
  let netloc = '';
  let query = '';
  let fragment = '';
  const colon = url.indexOf(':');
  if (colon > 0 && /^[A-Za-z]/.test(url) && SCHEME_CHARS.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase().replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
    url = url.slice(colon + 1);
  }
  if (url.startsWith('//')) {
    let delim = url.length;
    for (const c of '/?#') {
      const at = url.indexOf(c, 2);
      if (at >= 0) delim = Math.min(delim, at);
    }
    netloc = url.slice(2, delim);
    url = url.slice(delim);
    if ((netloc.includes('[') && !netloc.includes(']')) || (netloc.includes(']') && !netloc.includes('['))) {
      throw new URLValueError('Invalid IPv6 URL');
    }
    if (netloc.includes('[') && netloc.includes(']')) {
      const bracketed = netloc.split('[').slice(1).join('[').split(']')[0];
      if (bracketed.startsWith('v')) {
        if (!/^v[a-fA-F0-9]+\..+$/s.test(bracketed)) throw new URLValueError('IPvFuture address is invalid');
      } else {
        let v4 = false;
        try { ipv4(bracketed); v4 = true; } catch { /* not IPv4 */ }
        if (v4) throw new URLValueError('An IPv4 address cannot be in brackets');
        ipv6(bracketed); // throws when not an address
      }
    }
  }
  if (url.includes('#')) [url, fragment] = [url.slice(0, url.indexOf('#')), url.slice(url.indexOf('#') + 1)];
  if (url.includes('?')) [url, query] = [url.slice(0, url.indexOf('?')), url.slice(url.indexOf('?') + 1)];
  checknetloc(netloc);
  // _hostinfo
  const hostinfo = netloc.slice(netloc.lastIndexOf('@') + 1);
  let hostname;
  let port;
  if (hostinfo.includes('[')) {
    const bracketed = hostinfo.slice(hostinfo.indexOf('[') + 1);
    const close = bracketed.indexOf(']');
    hostname = close < 0 ? bracketed : bracketed.slice(0, close);
    const after = close < 0 ? '' : bracketed.slice(close + 1);
    port = after.includes(':') ? after.slice(after.indexOf(':') + 1) : '';
  } else {
    const at = hostinfo.indexOf(':');
    hostname = at < 0 ? hostinfo : hostinfo.slice(0, at);
    port = at < 0 ? '' : hostinfo.slice(at + 1);
  }
  const parts = { scheme, netloc, path: url, query, fragment, hostname: hostname ? hostname.toLowerCase() : null };
  Object.defineProperty(parts, 'port', {
    get() {
      if (!port) return null;
      if (!/^[0-9]+$/.test(port)) throw new URLValueError(`Port could not be cast to integer value as ${reprStr(port)}`);
      const number = Number(port);
      if (!(number >= 0 && number <= 65535)) throw new URLValueError('Port out of range 0-65535');
      return number;
    },
  });
  return parts;
}

function checknetloc(netloc) {
  // eslint-disable-next-line no-control-regex
  if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return;
  const n = netloc.replaceAll('@', '').replaceAll(':', '').replaceAll('#', '').replaceAll('?', '');
  const normalized = n.normalize('NFKC');
  if (n === normalized) return;
  for (const c of '/?#@:') {
    if (normalized.includes(c)) {
      throw new URLValueError(`netloc ${reprStr(netloc)} contains invalid characters under NFKC normalization`);
    }
  }
}

/** ipaddress.IPv4Address(text): [string, int] or throws. */
function ipv4(text) {
  const octets = text.split('.');
  if (!text || octets.length !== 4) throw new URLValueError('Expected 4 octets');
  let value = 0;
  const shown = [];
  for (const octet of octets) {
    if (!octet || !/^[0-9]+$/.test(octet) || octet.length > 3) throw new URLValueError('bad octet');
    if (octet.length > 1 && octet[0] === '0') throw new URLValueError('Leading zeros are not permitted');
    const number = Number(octet);
    if (number > 255) throw new URLValueError('Octet exceeds 255');
    value = value * 256 + number;
    shown.push(String(number));
  }
  return [shown.join('.'), value];
}

/** ipaddress.IPv6Address(text).compressed, or throws. */
function ipv6(text) {
  const [address, scope] = text.includes('%') ? [text.slice(0, text.indexOf('%')), text.slice(text.indexOf('%') + 1)] : [text, null];
  if (scope !== null && (!scope || scope.includes('%'))) throw new URLValueError('Invalid IPv6 address');
  if (!address) throw new URLValueError('Address cannot be empty');
  const parts = address.split(':');
  if (parts.length < 3) throw new URLValueError('At least 3 parts expected');
  if (parts.at(-1).includes('.')) {
    const [, value] = ipv4(parts.pop());
    parts.push(((value >>> 16) & 0xffff).toString(16), (value & 0xffff).toString(16));
  }
  if (parts.length > 9) throw new URLValueError('Too many parts');
  let skip = null;
  for (let i = 1; i < parts.length - 1; i++) {
    if (!parts[i]) {
      if (skip !== null) throw new URLValueError("At most one '::' permitted");
      skip = i;
    }
  }
  let hi;
  let lo;
  let skipped;
  if (skip !== null) {
    hi = skip;
    lo = parts.length - skip - 1;
    if (!parts[0]) {
      hi -= 1;
      if (hi) throw new URLValueError("Leading ':' only permitted as part of '::'");
    }
    if (!parts.at(-1)) {
      lo -= 1;
      if (lo) throw new URLValueError("Trailing ':' only permitted as part of '::'");
    }
    skipped = 8 - (hi + lo);
    if (skipped < 1) throw new URLValueError("Expected at most 7 other parts with '::'");
  } else {
    if (parts.length !== 8) throw new URLValueError('Exactly 8 parts expected without \'::\'');
    if (!parts[0] || !parts.at(-1)) throw new URLValueError("Leading or trailing ':' not permitted");
    hi = parts.length;
    lo = 0;
    skipped = 0;
  }
  const hextet = (part) => {
    if (!/^[0-9a-fA-F]+$/.test(part) || part.length > 4) throw new URLValueError('bad hextet');
    return Number.parseInt(part, 16);
  };
  const values = [];
  for (let i = 0; i < hi; i++) values.push(hextet(parts[i]));
  for (let i = 0; i < skipped; i++) values.push(0);
  for (let i = lo; i > 0; i--) values.push(hextet(parts[parts.length - i]));
  let hextets = values.map((v) => v.toString(16));
  // _compress_hextets
  let bestStart = -1;
  let bestLen = 0;
  let start = -1;
  let length = 0;
  hextets.forEach((h, index) => {
    if (h === '0') {
      length += 1;
      if (start === -1) start = index;
      if (length > bestLen) {
        bestLen = length;
        bestStart = start;
      }
    } else {
      length = 0;
      start = -1;
    }
  });
  if (bestLen > 1) {
    const end = bestStart + bestLen;
    if (end === hextets.length) hextets.push('');
    hextets.splice(bestStart, bestLen, '');
    if (bestStart === 0) hextets = ['', ...hextets];
  }
  const compressed = hextets.join(':');
  return scope ? `${compressed}%${scope}` : compressed;
}

const isAscii = (text) => /^[\x00-\x7f]*$/.test(text); // eslint-disable-line no-control-regex

/** `scheme://host[:port]` in the form a browser reports it: lowercase, default port dropped. */
export function normalize_origin(value) {
  const text = pyStrip(value);
  const hint = `${reprStr(value)} is not an origin; pass scheme://host[:port], for example https://example.com.`;
  let parts;
  let port;
  try {
    parts = urlsplit(text);
    port = parts.port;
  } catch (error) {
    if (!(error instanceof URLValueError)) throw error;
    throw new OriginsError(hint);
  }
  const scheme = parts.scheme.toLowerCase();
  let host = (parts.hostname || '').toLowerCase();
  if (!Object.hasOwn(DEFAULT_PORTS, scheme) || !host || parts.netloc.includes('@') || !['', '/'].includes(parts.path)
      || parts.query || parts.fragment || text.includes('?') || text.includes('#')) {
    throw new OriginsError(hint);
  }
  if (!isAscii(host)) {
    throw new OriginsError(`${reprStr(value)} has a non-ASCII host; pass its punycode (xn--) form, which is what `
      + 'the browser reports.');
  }
  if (host.includes(':')) {
    try {
      host = ipv6(host);
    } catch (error) {
      if (!(error instanceof URLValueError)) throw error;
      throw new OriginsError(hint);
    }
  } else if (!HOST.test(host)) {
    throw new OriginsError(hint);
  } else if (NUMERIC_LABEL.test(host.replace(/\.+$/, '').split('.').at(-1))) {
    // Browsers read a name ending in a number as an IPv4 address and rewrite it; accept only a plain one.
    try {
      [host] = ipv4(host);
    } catch (error) {
      if (!(error instanceof URLValueError)) throw error;
      throw new OriginsError(`${reprStr(value)} looks like an IPv4 address in an unusual form; `
        + 'pass it as four decimal numbers.');
    }
  }
  if (port !== null && !(port > 0 && port < 65536)) throw new OriginsError(hint);
  let result = `${scheme}://${host.includes(':') ? `[${host}]` : host}`;
  if (port !== null && port !== DEFAULT_PORTS[scheme]) result += `:${port}`;
  return result;
}

function _same_origin(stored, origin) {
  if (stored === origin) return true;
  try {
    return normalize_origin(stored) === origin;
  } catch (error) {
    if (error instanceof OriginsError) return false;
    throw error;
  }
}

// Session files ---------------------------------------------------------------------------------

/** [document, {kind: [origins]}] of a session file, or OriginsError when it is not usable. */
export function parse(raw, path) {
  let document;
  try {
    document = tomlLoadsBytes(raw);
  } catch (error) {
    if (!(error instanceof UnicodeDecodeError || error instanceof TOMLDecodeError)) throw error;
    throw new OriginsError(`${path} is not valid TOML (${error.message}); leaving it untouched.`);
  }
  const table = document.has('origins') ? document.get('origins') : new Map();
  if (!isDict(table)) throw new OriginsError(`${path} has an "origins" entry that is not a table; leaving it untouched.`);
  if ((document.size && !document.has('origins')) || (table.size && !KINDS.some((kind) => table.has(kind)))) {
    const keys = [...(table.size ? table : document).keys()].sort(compare);
    throw new OriginsError(`${path} does not have the expected [origins] allowed/denied lists (found `
      + `${keys.join(', ')}); it may be from a different runtime `
      + 'version, so it is neither listed as empty nor changed.');
  }
  const origins = {};
  for (const kind of KINDS) {
    const entries = table.has(kind) ? table.get(kind) : [];
    if (!Array.isArray(entries) || !entries.every((item) => typeof item === 'string')) {
      throw new OriginsError(`${path}: origins.${kind} is not a list of strings; leaving it untouched.`);
    }
    origins[kind] = entries;
  }
  return [document, origins];
}

function _read(path) {
  let raw;
  try {
    raw = readFileSync(F.native(path));
  } catch (error) {
    if (!isOSError(error)) throw error;
    throw new OriginsError(`cannot read ${path}: ${strerrorOf(error)}`);
  }
  return [raw, ...parse(raw, path)];
}

export function read(path) {
  return hooks.read(path);
}

const _quote = (text) => dumps(text, { ensure_ascii: false }).replaceAll('\x7f', '\\u007f');
const _key = (name) => (BARE_KEY.test(name) ? name : _quote(name));

function typeName(value) {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Map) return 'dict';
  if (typeof value === 'object' && value.constructor?.name) {
    const name = value.constructor.name;
    return name === 'PyFloat' ? 'float' : name;
  }
  return typeof value === 'number' ? 'float' : typeof value;
}

function _value(value, where) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (isInt(value)) return String(value);
  if (typeof value === 'string') return _quote(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return `[${value.map(_quote).join(', ')}]`;
  throw new UnsupportedShape(`${where} holds a value LCU does not rewrite (${typeName(value)}); leaving it untouched.`);
}

/** Serialize tables of strings, booleans, integers and string lists; refuse anything else. */
export function render(document, path = 'the file') {
  const lines = [];
  for (const [key, value] of document) if (!isDict(value)) lines.push(`${_key(key)} = ${_value(value, path)}`);
  for (const [key, table] of document) {
    if (!isDict(table)) continue;
    if (lines.length) lines.push('', `[${_key(key)}]`);
    else lines.push(`[${_key(key)}]`);
    for (const [name, value] of table) lines.push(`${_key(name)} = ${_value(value, `${path}: [${key}] ${name}`)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The text to write for `document`, or UnsupportedShape when rewriting could lose something. */
export function rewritable_text(raw, document, path) {
  const text = raw.toString('utf8');
  if (text.includes('"""') || text.includes("'''") || text.replace(STRING, '').includes('#')) {
    throw new UnsupportedShape(`${path} has comments or multi-line strings, which LCU cannot rewrite `
      + 'without losing them; leaving it untouched.');
  }
  const rendered = render(document, path);
  if (!equal(tomlLoads(rendered), document)) {
    throw new UnsupportedShape(`${path} has a structure LCU cannot rewrite faithfully; leaving it untouched.`);
  }
  return rendered;
}

/** Write `text` next to `path` and return the temporary file's path, ready for os.replace. */
function _write_atomically(path, text, mode) {
  const { fd, path: hostTemporary } = mkstemp({ prefix: `.${F.name(path)}.`, suffix: '.tmp', dir: F.native(F.parent(path)) });
  const temporary = F.join(F.parent(path), hostTemporary.split(/[\\/]/).at(-1));
  try {
    try {
      const data = Buffer.from(text, 'utf8');
      for (let offset = 0; offset < data.length;) offset += writeSync(fd, data, offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(F.native(temporary), mode);
    } catch (error) {
      if (!isOSError(error)) throw error;
    }
    return temporary;
  } catch (error) {
    try { unlinkSync(F.native(temporary)); } catch { /* missing_ok */ }
    throw error;
  }
}

export function write_atomically(path, text, mode) {
  return hooks.write_atomically(path, text, mode);
}

/**
 * Serialize LCU's own writers on one sessions folder with an advisory lock on a side file
 * (`with locked(directory):`). The original runtime does not take this lock, so it cannot protect against the
 * runtime itself.
 */
export function locked(directory, fn, { wait = LOCK_WAIT } = {}) {
  let lock;
  try {
    lock = acquireSync(F.native(F.join(directory, LOCK_NAME)), {
      timeout: wait, file: { flags: constants.O_RDWR | constants.O_CREAT, mode: 0o600 },
    });
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      throw new OriginsError('another `lcu origins` command is changing these files; try again in a moment.');
    }
    if (isOSError(error)) throw new OriginsError(`cannot lock ${directory}: ${strerrorOf(error)}`);
    throw error;
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/**
 * Remove `origin` from the given lists of one session file. Returns {kind: count removed}.
 *
 * Concurrent `lcu origins` commands are serialized by `locked`. The original runtime shares no lock
 * with LCU (it serializes only its own writes, in-process), so the file is also read again just
 * before the replace, and the change is recomputed if the runtime wrote before that read, and once
 * more afterwards to report a write that landed after the replace. A runtime write between the
 * last pre-replace read and the replace itself is overwritten without being noticed; no check
 * without a lock the runtime shares can close that window, which is microseconds wide. What is
 * lost then is a saved answer, so the runtime asks about that site again; a lost entry never
 * grants access.
 */
export function forget_in(path, origin, kinds, { attempts = WRITE_ATTEMPTS } = {}) {
  return locked(F.parent(path), () => {
    try {
      return _forget_in(path, origin, kinds, { attempts });
    } catch (error) {
      if (!isOSError(error) || error instanceof OriginsError) throw error;
      throw new OriginsError(`cannot update ${path}: ${strerrorOf(error)}`);
    }
  });
}

function _forget_in(path, origin, kinds, { attempts }) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (isSymlink(path)) throw new OriginsError(`${path} is a symbolic link; leaving it untouched.`);
    const [raw, document, origins] = read(path);
    const removed = {};
    for (const kind of kinds) {
      const kept = origins[kind].filter((entry) => !_same_origin(entry, origin));
      if (kept.length !== origins[kind].length) {
        removed[kind] = origins[kind].length - kept.length;
        document.get('origins').set(kind, kept);
      }
    }
    if (!Object.keys(removed).length) return {};
    const text = rewritable_text(raw, document, path);
    const temporary = write_atomically(path, text, statSync(F.native(path)).mode & 0o777);
    try {
      if (!readFileSync(F.native(path)).equals(raw)) continue;
      try {
        hooks.replace(F.native(temporary), F.native(path));
      } catch (error) {
        if (!isOSError(error)) throw error;
        throw new OriginsError(`cannot replace ${path}: ${strerrorOf(error)}`);
      }
    } finally {
      try { unlinkSync(F.native(temporary)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    hooks.sleep(0.05);
    if (!readFileSync(F.native(path)).equals(Buffer.from(text, 'utf8'))) {
      throw new OriginsError(`the original runtime changed ${path} while it was being updated; run `
        + '`lcu origins list` to see what is saved now and repeat the command if needed.');
    }
    return removed;
  }
  throw new OriginsError(`${path} kept changing while it was being updated; try again.`);
}

// Commands --------------------------------------------------------------------------------------

export function command_list(args, { home }) {
  const directory = sessions_directory(home);
  const sessions = [];
  const problems = [];
  for (const [session, path] of session_files(directory, args.session ?? null)) {
    let origins;
    try {
      [, , origins] = read(path);
    } catch (error) {
      if (!(error instanceof OriginsError)) throw error;
      if (args.session) throw error;
      problems.push({ session, file: String(path), error: error.message });
      continue;
    }
    sessions.push({ session, file: String(path), ...origins });
  }
  const status = problems.length ? 1 : 0;
  if (args.json) {
    print(dumps({ codexHome: String(home), sessions, problems }, { indent: 2 }));
    return status;
  }
  for (const problem of problems) printError(`lcu origins: skipped ${problem.file}: ${problem.error}`);
  const shown = sessions.filter((entry) => entry.allowed.length || entry.denied.length);
  if (!shown.length && !problems.length) print(`No saved Chrome site decisions in ${directory}.`);
  for (const entry of shown) {
    print(`session ${entry.session}`);
    for (const kind of KINDS) for (const origin of entry[kind]) print(`  ${ljust(kind, 7)} ${origin}`);
  }
  return status;
}

export function command_forget(args, { home }) {
  const origin = normalize_origin(args.origin);
  let kinds = KINDS.filter((kind) => args[kind]);
  if (!kinds.length) kinds = ['denied'];
  const directory = sessions_directory(home);
  const files = session_files(directory, args.session ?? null);
  if (!files.length) {
    print(`No saved Chrome site decisions in ${directory}; nothing changed.`);
    return 0;
  }
  let changed = 0;
  const problems = [];
  for (const [session, path] of files) {
    let removed;
    try {
      removed = forget_in(path, origin, kinds);
    } catch (error) {
      if (!(error instanceof OriginsError)) throw error;
      if (args.session) throw error;
      problems.push(error.message);
      continue;
    }
    for (const [kind, count] of Object.entries(removed)) {
      print(count === 1 ? `Removed ${origin} from ${kind} in session ${session}.`
        : `Removed ${count} entries for ${origin} from ${kind} in session ${session}.`);
    }
    changed += Object.keys(removed).length ? 1 : 0;
  }
  for (const problem of problems) printError(`lcu origins: skipped: ${problem}`);
  if (changed) {
    print(CACHE_NOTE);
  } else {
    print(`${origin} is not in the saved ${kinds.join(' or ')} list of `
      + `${args.session ? `session ${args.session}` : `${files.length} saved session(s)`}; `
      + 'nothing changed.');
  }
  return problems.length ? 1 : 0;
}

export const USAGE = ('lcu origins [list] [--session ID] [--json]\n'
  + '       lcu origins forget ORIGIN [--session ID | --all-sessions] [--allowed | --denied]');

export function parser() {
  const top = new ArgumentParser({
    prog: 'lcu origins', usage: USAGE, formatter_class: RawDescriptionHelpFormatter,
    description: 'Show and forget the Chrome site decisions the original runtime saved for each '
      + 'agent session.',
    epilog: 'forget removes a saved answer so the next request for that site asks again. It never '
      + 'allows a site: only the original prompt can.\n'
      + 'By default it removes the origin from the denied list of every saved session; '
      + '--allowed removes it from the allowed list instead (both flags: both lists).\n' + CACHE_NOTE,
  });
  const sub = top.add_subparsers({ dest: 'action' });
  const listing = sub.add_parser('list', {
    usage: 'lcu origins list [--session ID] [--json]', help: 'show the saved allowed and denied origins per session',
  });
  listing.add_argument('--session', { metavar: 'ID', help: 'show only this session' });
  listing.add_argument('--json', { action: 'store_true', help: 'print JSON instead of text' });
  const forget = sub.add_parser('forget', {
    usage: 'lcu origins forget ORIGIN [--session ID | --all-sessions] [--allowed | --denied]',
    help: 'remove a saved decision so the site is asked about again',
  });
  forget.add_argument('origin', { help: 'scheme://host[:port], for example https://example.com' });
  const scope = forget.add_mutually_exclusive_group();
  scope.add_argument('--session', { metavar: 'ID', help: 'only this session (default: every saved session)' });
  scope.add_argument('--all-sessions', { action: 'store_true', help: 'every saved session (the default)' });
  forget.add_argument('--allowed', { action: 'store_true', help: 'remove from the allowed list' });
  forget.add_argument('--denied', { action: 'store_true', help: 'remove from the denied list (the default)' });
  return top;
}

export function main(argv, { env = null, windows = null } = {}) {
  const argumentsList = [...argv];
  if (!argumentsList.length || (argumentsList[0].startsWith('-') && !['-h', '--help'].includes(argumentsList[0]))) {
    argumentsList.unshift('list');
  }
  const args = parser().parse_args(argumentsList);
  let status;
  try {
    const home = codex_home(env, { windows });
    const handler = { list: command_list, forget: command_forget }[args.action];
    status = handler(args, { home });
  } catch (error) {
    if (!(error instanceof OriginsError) && !isOSError(error)) throw error;
    printError(`lcu origins: ${error instanceof OriginsError ? error.message : pyStr(error)}`);
    throw new PySystemExit(1);
  }
  if (status) throw new PySystemExit(status);
}
