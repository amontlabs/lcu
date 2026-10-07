// Python-compatible error text for Node errors (Python 3.12 semantics).
//
//   str(OSError subclass), repr(str), subprocess.CalledProcessError / TimeoutExpired str().
//
// errno numbers and strerror text are per platform (darwin libc vs glibc): the tables in
// pyerr_tables.mjs are generated from the real interpreter. Limits: other libcs (musl) and non-UTF-8
// path bytes (Node already decoded them lossily).
//
// Changes 2026-10-05 (compat-os review findings 11, 12, 16):
//   * fromNodeError()/pyStr() return an error that already is a PyOSError as is (it used to be
//     re-rendered from err.path, dropping the Python filename); explicit filename/filename2 options
//     still rebuild it with those names.
//   * spawnErrorText(err, {cwd}) blames the cwd only when entering it fails (checked the way chdir
//     would: exists, is a directory, searchable); otherwise the executable keeps the blame, as in Python.
//   * reprStr() decides printability from Python 3.12's own table (Unicode 15.0.0, NONPRINTABLE in
//     pyerr_tables.mjs), not from the ICU data of whichever Node runs LCU. New export isPrintable().
import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';
import { win32 as ntpath } from 'node:path';

import { darwin, linux, NONPRINTABLE } from './pyerr_tables.mjs';
import { win32, WINERROR, WINERROR_OF_CODE } from './pyerr_win32.mjs';
import { reprFloat } from './pyjson.mjs';

const TABLES = { darwin, linux, win32 };

function table(platform = process.platform) {
  // Everything Unix that is not macOS follows the glibc table (the only Linux libc LCU supports).
  return TABLES[platform] ?? linux;
}

// A value already rendered the way Python's repr() would print it (Path objects, enums, ...).
export class PyRepr {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return this.text;
  }
}

// Flat [start, end, start, end, ...] list from Python 3.12's str.isprintable() (code points >= U+00A0).
let ranges = null;
function loadRanges() {
  ranges = [];
  for (const item of NONPRINTABLE.split(' ')) {
    const [start, end = start] = item.split('-');
    ranges.push(Number.parseInt(start, 16), Number.parseInt(end, 16));
  }
  return ranges;
}

/** Python 3.12's str.isprintable() for one code point. */
export function isPrintable(code) {
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return false;
  if (code < 0xa0) return true;
  const table = ranges ?? loadRanges();
  let low = 0;
  let high = table.length / 2 - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (code < table[2 * mid]) high = mid - 1;
    else if (code > table[2 * mid + 1]) low = mid + 1;
    else return false;
  }
  return true;
}

const hex = (n, width) => n.toString(16).padStart(width, '0');

/** repr() of a Python str. */
export function reprStr(value) {
  const text = String(value);
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  // Iterate by code point; a lone surrogate comes through as a one-unit string.
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === quote || ch === '\\') out += '\\' + ch;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x7f) out += '\\x' + hex(code, 2);
    else if (code < 0x7f) out += ch;
    else if (!isPrintable(code)) {
      if (code <= 0xff) out += '\\x' + hex(code, 2);
      else if (code <= 0xffff) out += '\\u' + hex(code, 4);
      else out += '\\U' + hex(code, 8);
    } else out += ch;
  }
  return out + quote;
}

/** repr() of a Python bytes object (a str is encoded as UTF-8 first, as os.fsencode does). */
export function reprBytes(value) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  const quote = bytes.includes(0x27) && !bytes.includes(0x22) ? '"' : "'";
  let out = 'b' + quote;
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (ch === quote || ch === '\\') out += '\\' + ch;
    else if (byte === 9) out += '\\t';
    else if (byte === 10) out += '\\n';
    else if (byte === 13) out += '\\r';
    else if (byte < 0x20 || byte >= 0x7f) out += '\\x' + hex(byte, 2);
    else out += ch;
  }
  return out + quote;
}

// repr() of a Python float: the one implementation of compat/pyjson.mjs (differentially tested there).
export { reprFloat };

/** repr() of a str, number (int unless {float:true} is given), None, list/tuple of those, or a PyRepr. */
export function reprValue(value, { float = false } = {}) {
  if (value instanceof PyRepr) return value.text;
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return reprStr(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return float ? reprFloat(value) : String(value);
  if (Array.isArray(value)) return '[' + value.map((item) => reprValue(item)).join(', ') + ']';
  throw new TypeError(`cannot represent ${typeof value}`);
}

/** repr() of a pathlib.PurePosixPath/PosixPath. */
export function reprPath(path, cls = 'PosixPath') {
  return `${cls}(${reprStr(path)})`;
}

// Python's OSError subclass chosen by errno.
const SUBCLASS = {
  EAGAIN: 'BlockingIOError',
  EALREADY: 'BlockingIOError',
  EINPROGRESS: 'BlockingIOError',
  ECHILD: 'ChildProcessError',
  EPIPE: 'BrokenPipeError',
  ESHUTDOWN: 'BrokenPipeError',
  ECONNABORTED: 'ConnectionAbortedError',
  ECONNREFUSED: 'ConnectionRefusedError',
  ECONNRESET: 'ConnectionResetError',
  EEXIST: 'FileExistsError',
  ENOENT: 'FileNotFoundError',
  EISDIR: 'IsADirectoryError',
  ENOTDIR: 'NotADirectoryError',
  EINTR: 'InterruptedError',
  EACCES: 'PermissionError',
  EPERM: 'PermissionError',
  ESRCH: 'ProcessLookupError',
  ETIMEDOUT: 'TimeoutError',
};

/** errno number for a name such as "ENOENT" on this platform (undefined when Python has no such name). */
export function errnoNumber(name, platform) {
  return table(platform).errno[name];
}

/** The C library message Python's os.strerror(number) returns. */
export function strerror(number, platform) {
  const t = table(platform);
  return t.strerror[number] ?? t.unknown.replace('%d', String(number));
}

/** The OSError subclass name Python raises for an errno name ("FileNotFoundError", ..., or "OSError"). */
export function errorClassName(name, platform) {
  const number = errnoNumber(name, platform);
  if (number === undefined) return 'OSError';
  // EWOULDBLOCK is the same number as EAGAIN, which is the name the table lookup goes through.
  for (const [key, cls] of Object.entries(SUBCLASS)) {
    if (errnoNumber(key, platform) === number) return cls;
  }
  return 'OSError';
}

/** str() of an OSError built the way the C runtime builds one: errno, strerror, filename(s). */
export function formatOSError({ errno, strerror: message, filename, filename2, winerror } = {}) {
  if (errno === undefined || errno === null) return message ?? '';
  // CPython on Windows: OSError raised from a Win32 call prints `[WinError N] text` (errno is the mapped C errno).
  let text = winerror === undefined || winerror === null ? `[Errno ${errno}] ${message}` : `[WinError ${winerror}] ${message}`;
  if (filename !== undefined && filename !== null) {
    text += `: ${reprValue(filename)}`;
    if (filename2 !== undefined && filename2 !== null) text += ` -> ${reprValue(filename2)}`;
  }
  return text;
}

/**
 * THE OSError class of LCU (every compat module and every caller uses this one; errors.mjs re-exports it).
 *
 *   new PyOSError({errno, strerror, filename, filename2, className, code}, platform)   // pre-rendered fields
 *   new PyOSError('ENOENT', filename, filename2)                                         // by errno NAME
 *
 * `name` is the Python class ("FileNotFoundError", "OSError", ...), `message` is str(exc), toString() the same.
 * `isOSError` is true for every instance (see isOSError() for the classifier that also knows raw Node errors).
 */
export class PyOSError extends Error {
  constructor(fields, platform, filename2) {
    if (typeof fields === 'string') {
      const code = fields;
      const filename = platform;
      platform = process.platform;
      const errno = errnoNumber(code, platform);
      fields = {
        errno,
        strerror: errno === undefined ? code : strerror(errno, platform),
        filename,
        filename2,
        className: errno === undefined ? 'OSError' : errorClassName(code, platform),
        code,
      };
    }
    super(formatOSError(fields));
    this.name = fields.className ?? 'OSError';
    this.errno = fields.errno;
    this.strerror = fields.strerror;
    this.winerror = fields.winerror ?? null;
    this.filename = fields.filename ?? null;
    this.filename2 = fields.filename2 ?? null;
    this.code = fields.code;
    this.platform = platform;
  }
  toString() {
    return this.message;
  }
}
PyOSError.prototype.isOSError = true;

const OS_ERROR_NAMES = new Set(['OSError', 'PyOSError', 'IOError', 'EnvironmentError', 'BlockingIOError',
  'ChildProcessError', 'ConnectionError', 'BrokenPipeError', 'ConnectionAbortedError', 'ConnectionRefusedError',
  'ConnectionResetError', 'FileExistsError', 'FileNotFoundError', 'InterruptedError', 'IsADirectoryError',
  'NotADirectoryError', 'PermissionError', 'ProcessLookupError', 'TimeoutError']);

/**
 * `except OSError`: true for a PyOSError (or anything flagged `isOSError`), for an error whose class or name is a
 * Python OSError class, and for a raw Node system error (code E<UPPER>, e.g. ENOENT; not ERR_* API errors).
 * The one classifier used by every LCU module.
 */
export function isOSError(err) {
  if (err === null || typeof err !== 'object') return false;
  if (err.isOSError === true || err instanceof PyOSError || OS_ERROR_NAMES.has(err.name)) return true;
  for (let cls = err.constructor; cls && cls !== Object && cls !== Function.prototype; cls = Object.getPrototypeOf(cls)) {
    if (OS_ERROR_NAMES.has(cls.name)) return true;
  }
  return typeof err.code === 'string' && /^E[A-Z0-9]+$/.test(err.code);
}

/**
 * Describe a Node system error the way Python would raise it.
 *
 * `filename`/`filename2` default to the error's own path/dest when they are `undefined`; pass them
 * explicitly when Python reports a different name (a bad `cwd` for a spawn is the filename in Python, but Node
 * reports the command), and pass `null` when Python's message carries no filename at all (errors.mjs
 * toPyOSError/pyfs do that for a name the caller did not give). Returns a PyOSError whose `message` is Python's str(exc), or null when the error has no
 * errno (it is not a system error).
 */
export function fromNodeError(err, { filename, filename2, platform = process.platform, parentExists } = {}) {
  if (platform === 'win32' && !(err instanceof PyOSError)) {
    const windows = windowsError(err, { filename, filename2, parentExists });
    if (windows) return windows;
  }
  if (err instanceof PyOSError) {
    if (filename === undefined && filename2 === undefined) return err;
    return new PyOSError(
      {
        errno: err.errno,
        strerror: err.strerror,
        filename: filename !== undefined ? filename : err.filename,
        filename2: filename2 !== undefined ? filename2 : err.filename2,
        className: err.name,
        code: err.code,
        winerror: err.winerror,
      },
      err.platform ?? platform,
    );
  }
  const code = err?.code;
  let number = typeof code === 'string' ? errnoNumber(code, platform) : undefined;
  if (number === undefined && Number.isInteger(err?.errno) && err.errno < 0) number = -err.errno;
  if (number === undefined) return null;
  const name = typeof code === 'string' && errnoNumber(code, platform) !== undefined ? code : undefined;
  return new PyOSError(
    {
      errno: number,
      strerror: strerror(number, platform),
      filename: filename !== undefined ? filename : err.path,
      filename2: filename2 !== undefined ? filename2 : err.dest,
      className: name ? errorClassName(name, platform) : 'OSError',
      code: name,
    },
    platform,
  );
}

// Node syscalls that CPython reaches through the C runtime on Windows (open(), os.open, read, write): their OSError
// text is `[Errno N] strerror`.  Every other call goes through the Win32 API and prints `[WinError N] message`.
const CRT_SYSCALLS = new Set(['open', 'read', 'write', 'close', 'fstat', 'ftruncate', 'fsync', 'fdatasync', 'futime',
  'fchmod', 'fchown', 'dup', 'lseek']);

/**
 * The OSError CPython raises on Windows for a Node system error, or null (not a system error / not a call we map).
 * Win32-API calls become `[WinError N] <FormatMessage text>: 'path'` (errno = CPython's winerror_to_errno, so the
 * exception class follows it); C-runtime calls keep `[Errno N]` with the Microsoft strerror text, and a directory
 * opened for reading is EACCES (`open()` of a directory fails with "Permission denied" on Windows).
 */
function windowsError(err, { filename, filename2, parentExists }) {
  let code = err?.code;
  const syscall = typeof err?.syscall === 'string' ? err.syscall : '';
  if (typeof code !== 'string' || errnoNumber(code, 'win32') === undefined && WINERROR_OF_CODE[code] === undefined) return null;
  const name = filename !== undefined ? filename : err.path;
  const second = filename2 !== undefined ? filename2 : err.dest;
  const call = syscall.split(' ')[0];
  if (call === '' || CRT_SYSCALLS.has(call)) {
    if (code === 'EISDIR' && (call === 'read' || call === 'open')) code = 'EACCES';
    const number = errnoNumber(code, 'win32');
    if (number === undefined) return null;
    return new PyOSError({ errno: number, strerror: strerror(number, 'win32'), filename: name, filename2: second,
      className: errorClassName(code, 'win32'), code }, 'win32');
  }
  let winerror = WINERROR_OF_CODE[code];
  if (winerror === undefined) return null;
  if (code === 'ENOENT') {
    // ERROR_FILE_NOT_FOUND (2) unless the directory part is missing too (ERROR_PATH_NOT_FOUND, 3); a directory
    // listing (FindFirstFile on `dir\*`) reports 3 for a missing directory.
    if (call === 'scandir') winerror = 3;
    else if (call !== 'spawn' && typeof name === 'string' && name !== '') {
      const parent = ntpath.dirname(name);
      const exists = parentExists ?? ((p) => existsSync(p));
      if (parent !== name && parent !== '' && parent !== '.' && !exists(parent)) winerror = 3;
    }
  }
  const [message, mapped] = WINERROR[winerror];
  return new PyOSError({ errno: errnoNumber(mapped, 'win32'), strerror: message, filename: name, filename2: second,
    className: errorClassName(mapped, 'win32'), code: mapped, winerror }, 'win32');
}

/** str(exc) for a Node error: Python's text for system errors, the plain message otherwise. */
export function pyStr(err, options) {
  return fromNodeError(err, options)?.message ?? (err instanceof Error ? err.message : String(err));
}

/** str() of the exception subprocess raises for FileNotFoundError and friends (spawn failures). */
export function spawnErrorText(err, { cwd, platform } = {}) {
  // Python's child enters cwd before exec, so a cwd it cannot enter is reported (with that errno) in
  // preference to the executable. Node's spawn error does not say which step failed: check the cwd the
  // way chdir(2) would. (Checked after the fact: a cwd changed in between is a race, not a contract.)
  if (cwd !== undefined && cwd !== null) {
    const failure = chdirFailure(String(cwd));
    if (failure && (platform ?? process.platform) === 'win32') {
      // CreateProcess with a bad lpCurrentDirectory: ERROR_DIRECTORY, whatever the reason.
      return new PyOSError({ errno: 20, strerror: WINERROR[267][0], winerror: 267, filename: cwd,
        className: 'NotADirectoryError', code: 'ENOTDIR' }, 'win32').message;
    }
    if (failure) return pyStr({ code: failure }, { filename: cwd, platform });
  }
  return pyStr(err, { platform });
}

/** The errno name chdir(path) would fail with, or null when it would succeed. */
export function chdirFailure(path) {
  try {
    if (!statSync(path).isDirectory()) return 'ENOTDIR';
    accessSync(path, fsConstants.X_OK);
    return null;
  } catch (error) {
    return typeof error?.code === 'string' ? error.code : 'EACCES';
  }
}

function cmdText(cmd) {
  return typeof cmd === 'string' ? cmd : reprValue(cmd);
}

/** The "died with" part of CalledProcessError for a negative return code, per platform signal names. */
export function signalRepr(signum, platform) {
  const name = table(platform).signals[signum];
  return name === undefined ? undefined : `<Signals.${name}: ${signum}>`;
}

/** str(subprocess.CalledProcessError(returncode, cmd)). */
export function calledProcessError(returncode, cmd, { platform } = {}) {
  if (returncode && returncode < 0) {
    const sig = signalRepr(-returncode, platform);
    return sig === undefined
      ? `Command '${cmdText(cmd)}' died with unknown signal ${-returncode}.`
      : `Command '${cmdText(cmd)}' died with ${sig}.`;
  }
  return `Command '${cmdText(cmd)}' returned non-zero exit status ${returncode}.`;
}

/** str(subprocess.TimeoutExpired(cmd, timeout)); a float timeout prints like Python ("20.0"). */
export function timeoutExpired(cmd, timeout, { float = false } = {}) {
  const shown = float || !Number.isInteger(timeout) ? reprFloat(timeout) : String(timeout);
  return `Command '${cmdText(cmd)}' timed out after ${shown} seconds`;
}
