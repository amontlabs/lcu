// Python 3.12 pathlib / os.path behaviours that node:path does not have (POSIX flavour only).
//
//   pathStr      str(PurePosixPath(p))        (collapses "//" and "/./", keeps ".."; "" -> ".")
//   normpath     os.path.normpath             (also resolves "..")
//   absolute     Path.absolute()              (cwd prefix, no normalisation of "..")
//   asUri        Path.as_uri()                (urllib.parse.quote_from_bytes(os.fsencode(path), safe="/"))
//   realpath     os.path.realpath(strict=False/True)
//   resolve      Path.resolve(strict=False/True)  (adds the RuntimeError on symlink loops)
//   expanduser   os.path.expanduser / Path.expanduser
//   fsencode / fsdecode  os.fsencode / os.fsdecode (UTF-8 + surrogateescape)
//
// Changes 2026-10-05 (compat-os review findings 13/14): PyValueError is now the shared ValueError of
// compat/pyjson.mjs. asUri encodes like os.fsencode: a surrogate-escaped string ('\udcff' = byte 0xFF)
// gives %FF exactly like Python (it used to become %EF%BF%BD), any other lone surrogate raises Python's
// UnicodeEncodeError; asUri also accepts a Buffer (raw path bytes, e.g. from fs APIs with
// encoding 'buffer'), which is os.fsdecode'd first. Node's own string fs APIs decode invalid UTF-8
// lossily (U+FFFD) before LCU sees a path, so byte-exact names need the Buffer form.
// Account lookups (expanduser of "~user") may throw compat/accounts AccountLookupError.
//
// Consolidation (2026-10-05): realpath/resolve look every name up as raw bytes (fsPath: strings with surrogate-escaped
// bytes go to fs as their fsencode Buffer; readlink targets come back as Buffers and are fsdecode'd) and raise CPython's
// ValueError('lstat: embedded null character in path') for a NUL, so compat/pypath delegates here; isAbs, join, split and
// fsPath are exported for it (and for the archive extractors).
import fs from 'node:fs'; // default import: tests observe fs.lstatSync/readlinkSync calls (raw-name lookups)

import { findpwnam, findpwuid } from './accounts.mjs';
import { reprStr } from './pyerr.mjs';
import { UnicodeEncodeError, ValueError } from './pyjson.mjs';

/** Python's RuntimeError. */
export class PyRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeError';
  }
}

/**
 * Python's ValueError: the shared class from compat/pyjson.mjs (since 2026-10-05; it used to be a
 * module-local class with the same name/message, so `instanceof ValueError` now also holds).
 */
export const PyValueError = ValueError;

/**
 * os.fsencode(str) on POSIX: UTF-8 with surrogateescape (U+DC80..U+DCFF become the bytes 0x80..0xFF);
 * any other lone surrogate is Python's UnicodeEncodeError. A Buffer is returned unchanged.
 */
export function fsencode(path) {
  if (Buffer.isBuffer(path)) return path;
  const text = String(path);
  const chunks = [];
  let position = 0;
  let start = 0;
  let offset = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) {
      if (code < 0xdc80 || code > 0xdcff) {
        const error = new UnicodeEncodeError(text);
        error.message = `'utf-8' codec can't encode character '\\u${code.toString(16)}' in position ${position}: surrogates not allowed`;
        throw error;
      }
      chunks.push(Buffer.from(text.slice(start, offset), 'utf8'), Buffer.from([code - 0xdc00]));
      start = offset + 1;
    }
    position += 1;
    offset += ch.length;
  }
  chunks.push(Buffer.from(text.slice(start), 'utf8'));
  return Buffer.concat(chunks);
}

function validSequence(bytes, i) {
  const b0 = bytes[i];
  let length;
  let min;
  if (b0 >= 0xc2 && b0 <= 0xdf) [length, min] = [2, 0x80];
  else if (b0 >= 0xe0 && b0 <= 0xef) [length, min] = [3, 0x800];
  else if (b0 >= 0xf0 && b0 <= 0xf4) [length, min] = [4, 0x10000];
  else return 0;
  if (i + length > bytes.length) return 0;
  let code = b0 & (0xff >> (length + 1));
  for (let k = 1; k < length; k++) {
    if ((bytes[i + k] & 0xc0) !== 0x80) return 0;
    code = (code << 6) | (bytes[i + k] & 0x3f);
  }
  if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return 0;
  return length;
}

/** os.fsdecode(bytes) on POSIX: UTF-8 with surrogateescape (each undecodable byte b -> U+DC00+b). */
export function fsdecode(bytes) {
  if (!Buffer.isBuffer(bytes)) return String(bytes);
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] < 0x80) {
      out += String.fromCharCode(bytes[i]);
      i += 1;
      continue;
    }
    const length = validSequence(bytes, i);
    if (length) {
      out += bytes.subarray(i, i + length).toString('utf8');
      i += length;
    } else {
      out += String.fromCharCode(0xdc00 + bytes[i]);
      i += 1;
    }
  }
  return out;
}

export const isAbs = (path) => path.startsWith('/');

const ESCAPED = /(?<![\ud800-\udbff])[\udc80-\udcff]/;

/**
 * The argument to give fs for a Python path string: strings with surrogate-escaped bytes (what os.fsdecode and
 * tarfile's surrogateescape produce for names that are not UTF-8) become the raw byte Buffer (os.fsencode); other
 * strings are passed as they are.
 */
export const fsPath = (p) => (ESCAPED.test(p) ? fsencode(p) : p);

/** posixpath.splitroot: [root, rest] with root "", "/" or "//" (three or more slashes are one). */
function splitRoot(path) {
  if (!path.startsWith('/')) return ['', path];
  if (path.startsWith('//') && !path.startsWith('///')) return ['//', path.slice(2)];
  return ['/', path.replace(/^\/+/, '')];
}

/** str(PurePosixPath(...parts)): joins like pathlib, drops "" and "." components, keeps "..". */
export function pathStr(...parts) {
  let joined = '';
  for (const part of parts) {
    if (part === '') continue;
    joined = isAbs(part) ? part : joined === '' || joined.endsWith('/') ? joined + part : `${joined}/${part}`;
  }
  const [root, rest] = splitRoot(joined);
  const tail = rest.split('/').filter((c) => c !== '' && c !== '.');
  return root + tail.join('/') || '.';
}

/** os.path.normpath */
export function normpath(path) {
  if (path === '') return '.';
  const [root, rest] = splitRoot(path);
  const parts = [];
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..' || (!root && parts.length === 0) || (parts.length && parts.at(-1) === '..')) parts.push(part);
    else if (parts.length) parts.pop();
  }
  return root + parts.join('/') || '.';
}

export const join = (a, b) => (isAbs(b) ? b : a === '' || a.endsWith('/') ? a + b : `${a}/${b}`);

/** os.path.abspath */
// (os.getcwd() is called only for a relative path; a deleted current directory must not break absolute ones.)
export function abspath(path, cwd = null) {
  return normpath(isAbs(path) ? path : join(cwd ?? process.cwd(), path));
}

/** Path(path).absolute(): the current directory is prepended; nothing else changes. */
export function absolute(path, cwd = null) {
  const own = pathStr(path);
  if (isAbs(own)) return own;
  const base = cwd ?? process.cwd();
  return own === '.' ? base : pathStr(base, own);
}

/** Path.as_uri(): 'file://' + quote_from_bytes(str(path) as UTF-8, safe='/'). Relative paths are a ValueError. */
export function asUri(path) {
  const own = pathStr(Buffer.isBuffer(path) ? fsdecode(path) : path);
  if (!isAbs(own)) throw new PyValueError("relative path can't be expressed as a file URI");
  let out = 'file://';
  for (const byte of fsencode(own)) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.\-~/]/.test(ch) ? ch : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** posixpath.split */
export const split = (path) => {
  const at = path.lastIndexOf('/') + 1;
  let head = path.slice(0, at);
  const tail = path.slice(at);
  if (head && head !== '/'.repeat(head.length)) head = head.replace(/\/+$/, '');
  return [head, tail];
};

function joinRealpath(path, rest, strict, seen) {
  if (isAbs(rest)) {
    rest = rest.slice(1);
    path = '/';
  }
  while (rest) {
    const slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.slice(0, slash);
    rest = slash < 0 ? '' : rest.slice(slash + 1);
    if (!name || name === '.') continue;
    if (name === '..') {
      if (path) {
        const [head, tail] = split(path);
        path = head;
        if (tail === '..') path = join(join(head, '..'), '..');
      } else path = '..';
      continue;
    }
    const newpath = join(path, name);
    // CPython's lstat raises ValueError (never caught by the non-strict OSError handler) for a NUL byte.
    if (newpath.includes('\0')) throw new PyValueError('lstat: embedded null character in path');
    let isLink = false;
    try {
      isLink = fs.lstatSync(fsPath(newpath)).isSymbolicLink();
    } catch (err) {
      if (strict) throw err;
    }
    if (!isLink) {
      path = newpath;
      continue;
    }
    if (seen.has(newpath)) {
      path = seen.get(newpath);
      if (path !== null) continue; // cached resolution
      // A symlink being resolved is met again: a loop.
      if (strict) fs.statSync(fsPath(newpath)); // throws ELOOP
      return [join(newpath, rest), false];
    }
    seen.set(newpath, null);
    const [resolved, ok] = joinRealpath(path, fsdecode(fs.readlinkSync(fsPath(newpath), { encoding: 'buffer' })), strict, seen);
    path = resolved;
    if (!ok) return [join(path, rest), false];
    seen.set(newpath, path);
  }
  return [path, true];
}

/** os.path.realpath(path, strict=False). Symlink loops return the unresolved remainder (no error) unless strict. */
export function realpath(path, { strict = false, cwd = null } = {}) {
  const [resolved] = joinRealpath('', path, strict, new Map());
  return abspath(resolved, cwd);
}

/**
 * Path(path).resolve(strict=False): realpath of str(Path(path)); a symlink loop is a RuntimeError
 * "Symlink loop from '<path>'" (strict: raised from the failing lstat/stat; non-strict: from a final stat).
 */
export function resolve(path, { strict = false, cwd = null } = {}) {
  const checkLoop = (err) => {
    if (err?.code === 'ELOOP') throw new PyRuntimeError(`Symlink loop from ${reprStr(err.path)}`);
  };
  let result;
  try {
    result = realpath(pathStr(path), { strict, cwd });
  } catch (err) {
    checkLoop(err);
    throw err;
  }
  result = pathStr(result);
  if (!strict) {
    try {
      fs.statSync(fsPath(result));
    } catch (err) {
      checkLoop(err);
    }
  }
  return result;
}

/**
 * os.path.expanduser. `env` defaults to process.env. Unknown users and unresolvable homes return the path unchanged.
 */
export function expanduser(path, { env = process.env, uid = process.getuid?.() } = {}) {
  if (!path.startsWith('~')) return path;
  let i = path.indexOf('/', 1);
  if (i < 0) i = path.length;
  let userhome;
  if (i === 1) {
    if (!('HOME' in env)) {
      const account = uid === undefined ? null : findpwuid(uid);
      if (!account) return path;
      userhome = account.pw_dir;
    } else userhome = env.HOME;
  } else {
    const account = findpwnam(path.slice(1, i));
    if (!account) return path;
    userhome = account.pw_dir;
  }
  userhome = userhome.replace(/\/+$/, '');
  return userhome + path.slice(i) || '/';
}

/**
 * Path(path).expanduser(): only a leading "~" / "~user" component of a relative path is expanded;
 * an unknown home is RuntimeError("Could not determine home directory.").
 */
export function pathExpanduser(path, options) {
  const own = pathStr(path);
  const first = own.split('/')[0];
  if (!isAbs(own) && first.startsWith('~')) {
    const home = expanduser(first, options);
    if (home.startsWith('~')) throw new PyRuntimeError('Could not determine home directory.');
    return pathStr(home, ...own.split('/').slice(1));
  }
  return own;
}
