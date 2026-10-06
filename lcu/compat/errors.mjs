// Python-compatible error helpers shared by the archive/HTTP/hash compat modules.
//
// Since 2026-10-05 (compat-archive-http review F10/F11) this module no longer carries its own copy of Python's
// repr()/OSError machinery. It is a thin adapter over the authoritative implementations:
//   * repr(str) / repr(bytes)       -> pyerr.reprStr / pyerr.reprBytes
//   * OSError text, subclass, errno -> pyerr.PyOSError / fromNodeError (platform tables generated from CPython)
//   * ValueError                    -> the single class of compat/pyjson.mjs (re-exported here), so that
//                                      `instanceof ValueError` and name checks agree in every compat module
// `PyOSError` below IS pyerr.PyOSError (one class; its constructor also accepts the historical signature
// (errno NAME, filename, filename2)), and `String(err)` is Python's str(exc) (the message alone).
//
// Remaining differences from CPython (documented, see .port/requests/compat.md):
//   * a Node error whose code is not a known errno name (ERR_* API errors, EAI_*) is returned unchanged by
//     toPyOSError(); callers decide how to render it;
//   * NUL bytes in a path: Node rejects them with ERR_INVALID_ARG_VALUE before any syscall. pyfs() turns that into
//     Python's ValueError('embedded null byte') (the text builtins.open() uses; os.* functions word it
//     'func: embedded null character in path', which only the os.path.realpath seam in pypath.mjs reproduces).
import * as pyerr from './pyerr.mjs';
import { ValueError } from './pyjson.mjs';

export { ValueError };

/** Python repr() of a str. */
export const pyRepr = pyerr.reprStr;

/** Python repr() of a bytes object. */
export const pyBytesRepr = (buf) => pyerr.reprBytes(buf);

/**
 * The OSError class: pyerr.PyOSError itself (one class for the whole tree). `new PyOSError('ENOENT', filename, filename2)`
 * builds "[Errno 2] No such file or directory: 'x'"; String(err) is Python's str(exc).
 */
export const PyOSError = pyerr.PyOSError;

/** `except OSError` (the single classifier, see pyerr.isOSError). */
export const isOSError = pyerr.isOSError;

const VALUE_ERROR_NAMES = new Set(['ValueError', 'PyValueError', 'JSONDecodeError', 'UnicodeDecodeError',
  'UnicodeEncodeError', 'UnicodeError', 'TOMLDecodeError', 'InvalidFileException']);

/**
 * `except ValueError`: an instance of the shared ValueError class (or anything flagged `isValueError`, which
 * every subclass of it carries), or an error whose class chain/name is a Python ValueError family name.
 */
export function isValueError(err) {
  if (err === null || typeof err !== 'object') return false;
  if (err instanceof ValueError || err.isValueError === true || VALUE_ERROR_NAMES.has(err.name)) return true;
  for (let cls = err.constructor; cls && cls !== Object && cls !== Function.prototype; cls = Object.getPrototypeOf(cls)) {
    if (VALUE_ERROR_NAMES.has(cls.name)) return true;
  }
  return false;
}

/** Python OverflowError (e.g. os.utime with a timestamp outside time_t). */
export class OverflowError extends Error {
  constructor(message) { super(message); this.name = 'OverflowError'; }
}

/** Convert a Node fs error into a PyOSError for the given Python-visible filename(s). */
export function toPyOSError(err, filename, filename2) {
  if (err instanceof pyerr.PyOSError) return err;
  // The names are the Python-visible ones: a name the caller did not give is NOT replaced by Node's err.path.
  return pyerr.fromNodeError(err, { filename: filename ?? null, filename2: filename2 ?? null }) ?? err;
}

/** Run fn(); rethrow Node fs errors as Python-style OSError (NUL paths as ValueError). */
export function pyfs(filename, fn, filename2) {
  try { return fn(); } catch (err) {
    if (err?.code === 'ERR_INVALID_ARG_VALUE' && /null bytes/.test(String(err.message))) {
      throw new ValueError('embedded null byte');
    }
    throw toPyOSError(err, filename, filename2);
  }
}
