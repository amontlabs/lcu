// =============================================================================================
// CALLER RULES (binding for every porter; the same rules head lcu/compat/argparse.mjs and
// .port/notes/compat-caller-rules.md)
//  1. Python int == JS Number when Number.isSafeInteger, otherwise BigInt. This holds for loads(), argparse
//     types.int and integer defaults alike, so `max(args.keep, 1)`, `now - doc.checked_at`, `keep - 1` port to the
//     same JS operators for every normal value. Never test ints with `typeof x === 'bigint'`: use isInt(). Never mix
//     Number and BigInt operands (TypeError): clamp user-controlled ints before arithmetic or wrap with BigInt() on
//     both sides, and turn a result back into an int with normInt(). Compare ints with `==` or equal(), never `===`
//     across the two types. Arithmetic that may leave 2^53 must check Number.isSafeInteger or use BigInt.
//  2. Python float == PyFloat (from loads()) or a JS Number that is not a safe integer. PyFloat coerces in arithmetic
//     (`100 - doc.get('t')` works) but `.value` is the raw number. A float that may be integral (time.time(), x / 2,
//     float(n)) MUST be wrapped with pyfloat(x) before dumps(): a plain Number 3 serialises as the int `3`, not 3.0.
//  3. Read-modify-write of a user file: `const doc = loads(text)` (a Map, order and number types intact), change it
//     with doc.get/set/delete, then `dumps(doc, ...)`. NEVER route such data through toPlain()/fromPlain()/object
//     spread/JSON.parse: they reorder integer-like keys and flatten floats. toPlain() is read-only convenience and
//     throws if it would reorder keys; pass {allowReorder:true} / {floats:'number'} only when that is irrelevant.
//  4. Build dicts you serialise as `new Map([[k, v], ...])` when key order matters or keys may look like integers;
//     a plain object is fine only for fixed identifier-like keys. dict equality and `in` checks use Map semantics
//     (doc.has(k)); compare whole values with equal(), which follows Python (1 == 1.0 == True, NaN identity rule).
//  5. Write JSON only with dumps()/dump() using Python's exact options (never JSON.stringify for disk, env, argv,
//     sockets or stdout). `json.dump(x, fp, **o)` is dump(x, fp, o): fp is an fd number or any `{ write(text) }`
//     object (passing options as the 2nd argument throws). Python's `json.dump(x, f)` never adds a newline.
//  6. Handle errors by class: JSONDecodeError and UnicodeDecodeError are subclasses of this module's ValueError;
//     `except (JSONDecodeError, UnicodeDecodeError)` is `catch (e) { if (!(e instanceof JSONDecodeError ||
//     e instanceof UnicodeDecodeError)) throw e; }`. str(exc) is error.message. loads(bytes) takes Buffer/Uint8Array.
//  7. sort_keys sorts the real key objects like Python (ints numerically, str by code point, mixed types raise
//     TypeError). Integer-valued Map keys must be BigInt/Number, not their string forms, to sort numerically.
// =============================================================================================
//
// Byte-exact emulation of the Python 3.12 `json` module as LCU uses it.
//
// ---------------------------------------------------------------------------------------------
// Option combinations used by the Python code base (grep of lcu/*.py and scripts/*.py):
//
//   json.dumps(x)                                         default separators (', ', ': '), ensure_ascii=True
//        app_server.py:81 (+ '\n'), codex_hooks.py:204/211/225 (string quoting), harness_setup.py:42/70/83/84,
//        macos_host.py:17/264, runtime.py:169/288/355, sandbox_shim.py:47, status.py:58, update.py:369/372/393,
//        scripts/install.py:107, scripts/install_windows.py:150/168/188, windows_host.py:260
//   json.dumps(x, indent=2) + '\n'                        item separator ',', key separator ': '
//        approval.py:235, claude_visibility.py:112, claude_mod.py:59, codex_hooks.py:83, harness_setup.py:86/111,
//        setup.py:180/557/634-653, status.py:63, apps.py:261 (printed with print(): same trailing newline)
//   json.dumps(x, indent=2, sort_keys=True) + '\n'        approval.py:66, scripts/bundle.py:46
//   json.dumps(x, indent=2, ensure_ascii=False)           (via json.dump to a stream, NO trailing newline) apps.py:84
//   json.dump(x, stream, indent=2)                        (no trailing newline) browser.py:253
//   json.dump(x, stream)                                  (default separators, no newline) update.py:79/278
//   json.dumps(x, sort_keys=True)                         approval.py:255/287
//   json.dumps(x, separators=(',', ':')) + '\n'           macos_host.py:140/231/294, runtime.py:331
//   json.dumps(x, sort_keys=True, separators=(',', ':'))  windows.py:93 (then .encode('utf-8'))
//   json.dumps(x, ensure_ascii=False, separators=(',', ':')).encode()   native_host.py:55
//   (no use of `default=`, `cls=`, `allow_nan=`, `check_circular=`, or a custom JSONEncoder/JSONDecoder)
//
//   json.loads(str)   : most call sites (Path.read_text(), subprocess stdout, env vars, stdin)
//   json.loads(bytes) : approval.py:56, setup.py:155, runtime.py:321 (`raw`), app_server.py:115 (a line of
//                       bytes), asar.py:32; all catch (JSONDecodeError, UnicodeDecodeError)
//   json.load(...)    : not used
//   Exceptions caught : json.JSONDecodeError, UnicodeDecodeError, ValueError (JSONDecodeError subclasses
//                       ValueError); str(exc) is printed by doctor.py:124, runtime.py/status.py/tested.py/windows.py
//                       (via `... as exc`), so messages must match exactly.
// ---------------------------------------------------------------------------------------------
//
// Lossless value model produced by loads() and accepted by dumps():
//   null/true/false  -> null/true/false
//   str              -> string (lone surrogates preserved)
//   int              -> Number when Number.isSafeInteger (never -0), BigInt beyond (arbitrary precision)
//   float            -> PyFloat {value} (so 1.0 stays a float; -0.0, NaN, +-Infinity kept)
//   list             -> Array
//   dict             -> Map<string, value> (insertion order incl. integer-like keys; duplicate key keeps its
//                       first position with the last value, exactly like a Python dict)
//
// Plain JS values are accepted by dumps() as well, with these conventions (JS cannot carry the distinction):
//   number           -> int when Number.isSafeInteger(n) and not -0, otherwise float (use PyFloat/BigInt to force)
//   plain object     -> dict in Object.keys() order (JS orders integer-like keys first; use Map to avoid that)
//   Map              -> dict (keys may be string, bigint, integer number, boolean, null, PyFloat: Python's key
//                       coercion rules apply)
//   undefined/function/symbol/other class instances -> `default(o)` if given, else TypeError like Python.
//
// Known limits (not reproducible): Python's RecursionError on very deep nesting (JS RangeError instead);
// the exact operand order in the sort_keys TypeError text for lists of more than two mixed keys; lone surrogate
// *pairs* that are two separate code points in a Python str (JS cannot tell them from one astral char);
// json.dump() writes nothing (instead of the chunks before the error) when encoding fails.

import fs from 'node:fs';

export class ValueError extends Error {
  constructor(message) { super(message); this.name = 'ValueError'; }
}
/** Marker for callers that classify errors without importing this module (every subclass inherits it). */
ValueError.prototype.isValueError = true;

export class TypeErrorPy extends TypeError {
  constructor(message) { super(message); this.name = 'TypeError'; }
}

export class UnicodeDecodeError extends ValueError {
  constructor(encoding, start, end, reason, bytes) {
    const b = bytes[start];
    super(end - start === 1
      ? `'${encoding}' codec can't decode byte 0x${b.toString(16).padStart(2, '0')} in position ${start}: ${reason}`
      : `'${encoding}' codec can't decode bytes in position ${start}-${end - 1}: ${reason}`);
    this.name = 'UnicodeDecodeError';
    this.encoding = encoding; this.start = start; this.end = end; this.reason = reason;
  }
}

/**
 * Python's UnicodeEncodeError (a ValueError). `new UnicodeEncodeError(text)` is the strict UTF-8 encoding failure of
 * `text`: like CPython it reports the FIRST RUN of consecutive lone surrogates ("character '\ud800' in position N"
 * for one, "characters in position a-b" for a run; positions count code points).
 * `new UnicodeEncodeError(null, message)` carries an already-rendered message (other codecs: ascii, latin-1).
 */
export class UnicodeEncodeError extends ValueError {
  constructor(text, message) {
    super(message ?? surrogateEncodeMessage(text));
    this.name = 'UnicodeEncodeError';
  }
}

const isLoneSurrogate = (ch) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff;

/** CPython's text for encoding `text` as strict UTF-8: its first run of lone surrogates. */
export function surrogateEncodeMessage(text) {
  const units = Array.from(String(text)); // code points; a lone surrogate is its own element
  const start = units.findIndex(isLoneSurrogate);
  if (start < 0) return "'utf-8' codec can't encode character '\\u0' in position 0: surrogates not allowed";
  let end = start;
  while (end + 1 < units.length && isLoneSurrogate(units[end + 1])) end++;
  return end === start
    ? `'utf-8' codec can't encode character '\\u${units[start].charCodeAt(0).toString(16)}' in position ${start}: surrogates not allowed`
    : `'utf-8' codec can't encode characters in position ${start}-${end}: surrogates not allowed`;
}

export class JSONDecodeError extends ValueError {
  constructor(msg, doc, pos) {
    const cps = Array.from(doc);
    let lineno = 1;
    let lastNl = -1;
    const limit = Math.min(pos, cps.length);
    for (let i = 0; i < limit; i++) if (cps[i] === '\n') { lineno++; lastNl = i; }
    const colno = pos - lastNl; // Python: pos - rindex('\n', 0, pos), or pos + 1 when there is none
    super(`${msg}: line ${lineno} column ${colno} (char ${pos})`);
    this.name = 'JSONDecodeError';
    this.msg = msg; this.doc = doc; this.pos = pos; this.lineno = lineno; this.colno = colno;
  }
}

export class PyFloat {
  constructor(value) { this.value = value; }
  valueOf() { return this.value; }
  toString() { return reprFloat(this.value); }
}

export const isFloat = value => value instanceof PyFloat;
// json's default decoder maps NaN/Infinity/-Infinity to single shared float objects; identity matters for
// container equality ([nan] == [nan] is True in Python because of the `is` shortcut).
const NAN = Object.freeze(new PyFloat(NaN));
const INF = Object.freeze(new PyFloat(Infinity));
const NINF = Object.freeze(new PyFloat(-Infinity));
/** Python int test for lossless/plain values: BigInt, or a Number holding a safe integer (not -0). */
export const isInt = value => typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0));
/** int normalisation used everywhere: Number when Number.isSafeInteger, otherwise BigInt. */
export const normInt = value => {
  if (typeof value === 'number') return value;
  return value >= -MAX_SAFE && value <= MAX_SAFE ? Number(value) : value;
};
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/** Explicit Python float (keeps `1.0` a float when serialised): pyfloat(time / 1000). */
export const pyfloat = value => new PyFloat(Number(value));
export const isDict = value => value instanceof Map;

// ------------------------------------------------------------------------------------------ repr

/** Python repr(float). */
export function reprFloat(x) {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const sign = x < 0 ? '-' : '';
  const [mant, expText] = Math.abs(x).toExponential().split('e');
  const digits = mant.replace('.', '');
  const exp = Number(expText);
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = Math.abs(exp);
    return `${sign}${m}e${exp < 0 ? '-' : '+'}${e < 10 ? '0' : ''}${e}`;
  }
  if (exp >= 0) {
    if (digits.length <= exp + 1) return `${sign}${digits}${'0'.repeat(exp + 1 - digits.length)}.0`;
    return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
  }
  return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
}

// ------------------------------------------------------------------------------------------ loads

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
const INT_LIMIT = 4300;
const intLimitFromText = digits => new ValueError(
  `Exceeds the limit (${INT_LIMIT} digits) for integer string conversion: value has ${digits} digits; ` +
  'use sys.set_int_max_str_digits() to increase the limit');
const intLimitToText = () => new ValueError(
  `Exceeds the limit (${INT_LIMIT} digits) for integer string conversion; ` +
  'use sys.set_int_max_str_digits() to increase the limit');

const fromCodePoints = (a, start, end) => {
  let out = '';
  for (let i = start; i < end; i += 8192) out += String.fromCodePoint(...a.subarray(i, Math.min(end, i + 8192)));
  return out;
};

const isDigit = c => c >= 0x30 && c <= 0x39;
const hexValue = c => (c >= 0x30 && c <= 0x39 ? c - 0x30
  : c >= 0x61 && c <= 0x66 ? c - 0x57 : c >= 0x41 && c <= 0x46 ? c - 0x37 : -1);

class Stop { constructor(index) { this.index = index; } }

function parse(doc) {
  // Work on code points so that every position matches Python's str indexes. Documents without surrogates
  // (the overwhelmingly common case) are indexed in place; no per-character array is allocated for them.
  const hasSurrogate = /[\ud800-\udfff]/.test(doc);
  const a = hasSurrogate ? new Uint32Array(Array.from(doc, ch => ch.codePointAt(0))) : null;
  const at = hasSurrogate ? i => a[i] : i => doc.charCodeAt(i);
  const length = hasSurrogate ? a.length : doc.length;
  const slice = (start, end) => (hasSurrogate ? fromCodePoints(a, start, end) : doc.slice(start, end));
  const fail = (msg, pos) => { throw new JSONDecodeError(msg, doc, pos); };
  const skipWs = i => { while (i < length && WS.has(at(i))) i++; return i; };
  const matches = (i, word) => {
    for (let k = 0; k < word.length; k++) if (at(i + k) !== word.charCodeAt(k)) return false;
    return true;
  };

  function scanString(end) {
    const begin = end - 1;
    const chunks = [];
    for (;;) {
      let next = end;
      let c = 0;
      for (; next < length; next++) {
        c = at(next);
        if (c === 0x22 || c === 0x5c) break;
        if (c <= 0x1f) fail('Invalid control character at', next);
      }
      if (!(c === 0x22 || c === 0x5c) || next >= length) fail('Unterminated string starting at', begin);
      if (next > end) chunks.push(slice(end, next));
      next++;
      if (c === 0x22) { end = next; break; }
      if (next === length) fail('Unterminated string starting at', begin);
      c = at(next);
      if (c !== 0x75) {
        end = next + 1;
        let out;
        switch (c) {
          case 0x22: out = '"'; break;
          case 0x5c: out = '\\'; break;
          case 0x2f: out = '/'; break;
          case 0x62: out = '\b'; break;
          case 0x66: out = '\f'; break;
          case 0x6e: out = '\n'; break;
          case 0x72: out = '\r'; break;
          case 0x74: out = '\t'; break;
          default: fail('Invalid \\escape', end - 2);
        }
        chunks.push(out);
      } else {
        let cp = 0;
        next++;
        end = next + 4;
        if (end >= length) fail('Invalid \\uXXXX escape', next - 1);
        for (; next < end; next++) {
          const d = hexValue(at(next));
          if (d < 0) fail('Invalid \\uXXXX escape', end - 5);
          cp = (cp << 4) | d;
        }
        if (cp >= 0xd800 && cp <= 0xdbff && end + 6 < length && at(next) === 0x5c && at(next + 1) === 0x75) {
          next += 2;
          let c2 = 0;
          end += 6;
          for (; next < end; next++) {
            const d = hexValue(at(next));
            if (d < 0) fail('Invalid \\uXXXX escape', end - 5);
            c2 = (c2 << 4) | d;
          }
          if (c2 >= 0xdc00 && c2 <= 0xdfff) cp = 0x10000 + ((cp - 0xd800) << 10) + (c2 - 0xdc00);
          else end -= 6;
        }
        chunks.push(String.fromCodePoint(cp));
      }
    }
    return [chunks.length === 1 ? chunks[0] : chunks.join(''), end];
  }

  function scanNumber(start) {
    let i = start;
    if (i >= length) throw new Stop(start);
    if (at(i) === 0x2d) { i++; if (i >= length) throw new Stop(start); }
    if (at(i) >= 0x31 && at(i) <= 0x39) { i++; while (i < length && isDigit(at(i))) i++; }
    else if (at(i) === 0x30) i++;
    else throw new Stop(start);
    const intEnd = i;
    let isFloatToken = false;
    if (i + 1 < length && at(i) === 0x2e && isDigit(at(i + 1))) {
      isFloatToken = true;
      i += 2;
      while (i < length && isDigit(at(i))) i++;
    }
    if (i < length && (at(i) === 0x65 || at(i) === 0x45)) {
      const eStart = i;
      i++;
      if (i < length && (at(i) === 0x2b || at(i) === 0x2d)) i++;
      const digitsStart = i;
      while (i < length && isDigit(at(i))) i++;
      if (i > digitsStart) isFloatToken = true;
      else i = eStart;
    }
    const text = slice(start, i);
    if (isFloatToken) return [new PyFloat(Number(text)), i];
    const digits = intEnd - start - (at(start) === 0x2d ? 1 : 0);
    if (digits > INT_LIMIT) throw intLimitFromText(digits);
    if (digits <= 15) return [Number(text) || 0, i]; // `|| 0` turns -0 into 0 (an int)
    return [normInt(BigInt(text)), i];
  }

  function scanValue(idx) {
    if (idx >= length) throw new Stop(idx);
    switch (at(idx)) {
      case 0x22: return scanString(idx + 1);
      case 0x7b: return scanObject(idx + 1);
      case 0x5b: return scanArray(idx + 1);
      case 0x6e: if (idx + 3 < length && matches(idx, 'null')) return [null, idx + 4]; break;
      case 0x74: if (idx + 3 < length && matches(idx, 'true')) return [true, idx + 4]; break;
      case 0x66: if (idx + 4 < length && matches(idx, 'false')) return [false, idx + 5]; break;
      case 0x4e: if (idx + 2 < length && matches(idx, 'NaN')) return [NAN, idx + 3]; break;
      case 0x49: if (idx + 7 < length && matches(idx, 'Infinity')) return [INF, idx + 8]; break;
      case 0x2d:
        if (idx + 8 < length && matches(idx, '-Infinity')) return [NINF, idx + 9];
        break;
      default: break;
    }
    return scanNumber(idx);
  }

  function scanObject(idx) {
    const result = new Map();
    idx = skipWs(idx);
    if (idx >= length || at(idx) !== 0x7d) {
      for (;;) {
        if (idx >= length || at(idx) !== 0x22) fail('Expecting property name enclosed in double quotes', idx);
        let key;
        [key, idx] = scanString(idx + 1);
        idx = skipWs(idx);
        if (idx >= length || at(idx) !== 0x3a) fail("Expecting ':' delimiter", idx);
        idx = skipWs(idx + 1);
        let value;
        [value, idx] = scanValue(idx);
        result.set(key, value);
        idx = skipWs(idx);
        if (idx < length && at(idx) === 0x7d) break;
        if (idx >= length || at(idx) !== 0x2c) fail("Expecting ',' delimiter", idx);
        idx = skipWs(idx + 1);
      }
    }
    return [result, idx + 1];
  }

  function scanArray(idx) {
    const result = [];
    idx = skipWs(idx);
    if (idx >= length || at(idx) !== 0x5d) {
      for (;;) {
        let value;
        [value, idx] = scanValue(idx);
        result.push(value);
        idx = skipWs(idx);
        if (idx < length && at(idx) === 0x5d) break;
        if (idx >= length || at(idx) !== 0x2c) fail("Expecting ',' delimiter", idx);
        idx = skipWs(idx + 1);
      }
    }
    return [result, idx + 1];
  }

  let value;
  let end;
  const start = skipWs(0);
  try {
    [value, end] = scanValue(start);
  } catch (error) {
    if (error instanceof Stop) fail('Expecting value', error.index);
    throw error;
  }
  end = skipWs(end);
  if (end !== length) fail('Extra data', end);
  return value;
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeUtf8(bytes, base = 0) {
  // Valid UTF-8 (no encoded surrogates) is by far the common case: let the native decoder do it in one pass. On
  // failure fall through to the CPython-faithful decoder below, which supplies exact errors and surrogatepass.
  try { return STRICT_UTF8.decode(bytes); } catch { /* fall through */ }
  const n = bytes.length;
  const pieces = [];
  const cont = b => (b & 0xc0) === 0x80;
  const err = (s, e, reason) => new UnicodeDecodeError('utf-8', s + base, e + base, reason, bytes);
  let i = 0;
  while (i < n) {
    const ch = bytes[i];
    if (ch < 0x80) {
      // ASCII run: decode the whole span at once (latin1 == ASCII here) instead of one piece per byte.
      let j = i + 1;
      while (j < n && bytes[j] < 0x80) j++;
      pieces.push(Buffer.from(bytes.buffer, bytes.byteOffset + i, j - i).latin1Slice(0, j - i));
      i = j; continue;
    }
    if (ch < 0xc2) throw err(i, i + 1, 'invalid start byte');
    if (ch < 0xe0) {
      if (n - i < 2) throw err(i, n, 'unexpected end of data');
      if (!cont(bytes[i + 1])) throw err(i, i + 1, 'invalid continuation byte');
      pieces.push(String.fromCharCode(((ch & 0x1f) << 6) | (bytes[i + 1] & 0x3f)));
      i += 2; continue;
    }
    if (ch < 0xf0) {
      if (n - i < 3) {
        if (n - i < 2) throw err(i, n, 'unexpected end of data');
        const c2 = bytes[i + 1];
        if (!cont(c2) || (c2 < 0xa0 ? ch === 0xe0 : ch === 0xed)) throw err(i, i + 1, 'invalid continuation byte');
        throw err(i, n, 'unexpected end of data');
      }
      const c2 = bytes[i + 1];
      const c3 = bytes[i + 2];
      if (!cont(c2) || (c2 < 0xa0 ? ch === 0xe0 : false)) throw err(i, i + 1, 'invalid continuation byte');
      if (ch === 0xed && c2 >= 0xa0) {
        // surrogatepass: an encoded surrogate decodes, anything else re-raises the original error
        if (!cont(c3)) throw err(i, i + 1, 'invalid continuation byte');
      } else if (!cont(c3)) throw err(i, i + 2, 'invalid continuation byte');
      pieces.push(String.fromCharCode(((ch & 0x0f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f)));
      i += 3; continue;
    }
    if (ch > 0xf4) throw err(i, i + 1, 'invalid start byte');
    if (n - i < 4) {
      if (n - i < 2) throw err(i, n, 'unexpected end of data');
      const c2 = bytes[i + 1];
      if (!cont(c2) || (c2 < 0x90 ? ch === 0xf0 : ch === 0xf4 && c2 >= 0x90)) throw err(i, i + 1, 'invalid continuation byte');
      if (n - i < 3) throw err(i, n, 'unexpected end of data');
      if (!cont(bytes[i + 2])) throw err(i, i + 2, 'invalid continuation byte');
      throw err(i, n, 'unexpected end of data');
    }
    const c2 = bytes[i + 1];
    const c3 = bytes[i + 2];
    const c4 = bytes[i + 3];
    if (!cont(c2) || (c2 < 0x90 ? ch === 0xf0 : ch === 0xf4 && c2 >= 0x90)) throw err(i, i + 1, 'invalid continuation byte');
    if (!cont(c3)) throw err(i, i + 2, 'invalid continuation byte');
    if (!cont(c4)) throw err(i, i + 3, 'invalid continuation byte');
    pieces.push(String.fromCodePoint(((ch & 0x07) << 18) | ((c2 & 0x3f) << 12) | ((c3 & 0x3f) << 6) | (c4 & 0x3f)));
    i += 4;
  }
  return pieces.join('');
}

// UTF-16/UTF-32 decoding. `from` is where the payload starts (after a BOM) but error positions count from the
// start of `bytes` and carry the concrete endian codec name, exactly like CPython's 'utf-16'/'utf-32' decoders
// that switch to the -le/-be codec after reading the BOM.
function decodeUtf16(bytes, from, little, name) {
  const n = bytes.length;
  const count = (n - from) >> 1;
  const units = new Uint16Array(count);
  for (let k = 0, i = from; k < count; k++, i += 2) units[k] = little ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
  if ((n - from) % 2) throw new UnicodeDecodeError(name, n - 1, n, 'truncated data', bytes);
  const pieces = [];
  for (let i = 0; i < count; i += 4096) pieces.push(String.fromCharCode(...units.subarray(i, i + 4096)));
  return pieces.join('');
}

function decodeUtf32(bytes, from, little, name) {
  const n = bytes.length;
  const count = (n - from) >> 2;
  const cps = new Uint32Array(count);
  let i = from;
  for (let k = 0; k < count; k++, i += 4) {
    const cp = little
      ? (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0
      : ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    if (cp > 0x10ffff) throw new UnicodeDecodeError(name, i, i + 4, 'code point not in range(0x110000)', bytes);
    cps[k] = cp;
  }
  if (i < n) throw new UnicodeDecodeError(name, i, n, 'truncated data', bytes);
  const pieces = [];
  for (let k = 0; k < count; k += 4096) pieces.push(String.fromCodePoint(...cps.subarray(k, k + 4096)));
  return pieces.join('');
}

const startsWith = (b, ...v) => v.length <= b.length && v.every((x, i) => b[i] === x);

/** json.detect_encoding + bytes.decode(encoding, 'surrogatepass'). */
function decodeBytes(bytes) {
  const b = bytes;
  if (startsWith(b, 0xff, 0xfe, 0, 0) || startsWith(b, 0, 0, 0xfe, 0xff)) {
    const little = b[0] === 0xff;
    return decodeUtf32(b, 4, little, little ? 'utf-32-le' : 'utf-32-be');
  }
  if (startsWith(b, 0xff, 0xfe) || startsWith(b, 0xfe, 0xff)) {
    const little = b[0] === 0xff;
    return decodeUtf16(b, 2, little, little ? 'utf-16-le' : 'utf-16-be');
  }
  if (startsWith(b, 0xef, 0xbb, 0xbf)) return decodeUtf8(b.subarray(3));
  if (b.length >= 4) {
    if (!b[0]) return b[1] ? decodeUtf16(b, 0, false, 'utf-16-be') : decodeUtf32(b, 0, false, 'utf-32-be');
    if (!b[1]) return b[2] || b[3] ? decodeUtf16(b, 0, true, 'utf-16-le') : decodeUtf32(b, 0, true, 'utf-32-le');
  } else if (b.length === 2) {
    if (!b[0]) return decodeUtf16(b, 0, false, 'utf-16-be');
    if (!b[1]) return decodeUtf16(b, 0, true, 'utf-16-le');
  }
  return decodeUtf8(b);
}

/** json.loads(s): s is a string or bytes-like (Buffer/Uint8Array). Returns the lossless representation. */
export function loads(input) {
  let doc = input;
  if (typeof input !== 'string') {
    if (!ArrayBuffer.isView(input)) throw new TypeErrorPy(`the JSON object must be str, bytes or bytearray, not ${input === null ? 'NoneType' : typeof input}`);
    return parse(decodeBytes(new Uint8Array(input.buffer, input.byteOffset, input.byteLength)));
  }
  // Python only checks for a BOM on str input; decoded bytes keep any second BOM (-> "Expecting value").
  if (doc.startsWith('\ufeff')) throw new JSONDecodeError('Unexpected UTF-8 BOM (decode using utf-8-sig)', doc, 0);
  return parse(doc);
}

// ------------------------------------------------------------------------------------------ dumps

const SHORT = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const hex4 = code => `\\u${code.toString(16).padStart(4, '0')}`;

function quoteAscii(s) {
  return '"' + s.replace(/["\\]|[^\x20-\x7e]/g, ch => SHORT[ch] ?? hex4(ch.charCodeAt(0))) + '"';
}
function quoteUnicode(s) {
  return '"' + s.replace(/["\\\x00-\x1f]/g, ch => SHORT[ch] ?? hex4(ch.charCodeAt(0))) + '"';
}

/** Python str ordering (code point order) for JS strings that may contain lone surrogates. */
export function compareCodePoints(x, y) {
  const n = Math.min(x.length, y.length);
  let i = 0;
  while (i < n && x.charCodeAt(i) === y.charCodeAt(i)) i++;
  if (i === n) return x.length - y.length;
  if (i > 0) {
    const prev = x.charCodeAt(i - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) i--; // keep a surrogate pair together
  }
  return x.codePointAt(i) - y.codePointAt(i);
}

const typeName = value => {
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return 'function';
  if (typeof value === 'symbol') return 'symbol';
  return value?.constructor?.name ?? 'object';
};

function intText(value) {
  const text = value.toString();
  if (text.length - (value < 0n ? 1 : 0) > INT_LIMIT) throw intLimitToText();
  return text;
}

/** Python type name of a dict key (for TypeError texts), or null when it is not a legal JSON key type. */
function keyType(key) {
  if (typeof key === 'string') return 'str';
  if (key === true || key === false) return 'bool';
  if (key === null) return 'NoneType';
  if (typeof key === 'bigint' || (typeof key === 'number' && Number.isSafeInteger(key) && !Object.is(key, -0))) return 'int';
  if (typeof key === 'number' || key instanceof PyFloat) return 'float';
  return typeName(key);
}

const numericKey = key => (key instanceof PyFloat ? key.value : key === true ? 1 : key === false ? 0 : key);

/** `a < b` ordering of two dict keys with Python semantics (used by sort_keys). */
function comparePyKeys(x, y) {
  const tx = keyType(x);
  const ty = keyType(y);
  if (tx === 'str' && ty === 'str') return compareCodePoints(x, y);
  const numeric = t => t === 'int' || t === 'float' || t === 'bool';
  if (numeric(tx) && numeric(ty)) {
    const nx = numericKey(x);
    const ny = numericKey(y);
    return nx < ny ? -1 : nx > ny ? 1 : 0;
  }
  // list.sort() reports the later element first: "'<' not supported between instances of 'str' and 'int'".
  throw new TypeErrorPy(`'<' not supported between instances of '${tx}' and '${ty}'`);
}

function keyText(key) {
  if (typeof key === 'string') return key;
  if (key instanceof PyFloat) return floatText(key.value, true);
  if (key === true) return 'true';
  if (key === false) return 'false';
  if (key === null) return 'null';
  if (typeof key === 'bigint') return intText(key);
  if (typeof key === 'number') return Number.isSafeInteger(key) && !Object.is(key, -0) ? String(key) : floatText(key, true);
  throw new TypeErrorPy(`keys must be str, int, float, bool or None, not ${typeName(key)}`);
}

function floatText(x, allowNan) {
  if (Number.isNaN(x) || x === Infinity || x === -Infinity) {
    if (!allowNan) throw new ValueError(`Out of range float values are not JSON compliant: ${reprFloat(x)}`);
    return Number.isNaN(x) ? 'NaN' : x > 0 ? 'Infinity' : '-Infinity';
  }
  return reprFloat(x);
}

/**
 * json.dumps(value, ...). Options: {indent: int|string|null, separators: [item, key]|null, sort_keys, ensure_ascii
 * (default true), allow_nan (default true), default: fn, check_circular (default true)}.
 */
export function dumps(value, options = {}) {
  const {
    indent = null, sort_keys: sortKeys = false, ensure_ascii: ensureAscii = true, allow_nan: allowNan = true,
    default: defaultFn = null, check_circular: checkCircular = true,
  } = options;
  let [itemSep, keySep] = options.separators ?? (indent === null ? [', ', ': '] : [',', ': ']);
  const indentText = indent === null ? null : typeof indent === 'string' ? indent : ' '.repeat(Math.max(0, indent));
  const quote = ensureAscii ? quoteAscii : quoteUnicode;
  const stack = new Set();
  const parts = [];

  const enter = obj => {
    if (!checkCircular) return;
    if (stack.has(obj)) throw new ValueError('Circular reference detected');
    stack.add(obj);
  };
  const leave = obj => { if (checkCircular) stack.delete(obj); };

  function encode(o, level) {
    if (typeof o === 'string') { parts.push(quote(o)); return; }
    if (o === null) { parts.push('null'); return; }
    if (o === true) { parts.push('true'); return; }
    if (o === false) { parts.push('false'); return; }
    if (typeof o === 'bigint') { parts.push(intText(o)); return; }
    if (typeof o === 'number') {
      parts.push(Number.isSafeInteger(o) && !Object.is(o, -0) ? String(o) : floatText(o, allowNan));
      return;
    }
    if (o instanceof PyFloat) { parts.push(floatText(o.value, allowNan)); return; }
    if (Array.isArray(o)) { encodeList(o, level); return; }
    if (o instanceof Map) { encodeDict([...o], level, o); return; }
    if (isPlainObject(o)) {
      encodeDict(Object.keys(o).map(k => [k, o[k]]), level, o);
      return;
    }
    if (typeof defaultFn === 'function') {
      enter(o);
      encode(defaultFn(o), level);
      leave(o);
      return;
    }
    throw new TypeErrorPy(`Object of type ${typeName(o)} is not JSON serializable`);
  }

  function isPlainObject(o) {
    if (o === null || typeof o !== 'object') return false;
    const proto = Object.getPrototypeOf(o);
    return proto === Object.prototype || proto === null;
  }

  const newline = level => '\n' + indentText.repeat(level);

  function encodeList(list, level) {
    if (list.length === 0) { parts.push('[]'); return; }
    enter(list);
    let sep = itemSep;
    if (indentText !== null) {
      parts.push('[' + newline(level + 1));
      sep = itemSep + newline(level + 1);
    } else parts.push('[');
    list.forEach((item, i) => {
      if (i) parts.push(sep);
      encode(item, level + 1);
    });
    if (indentText !== null) parts.push(newline(level));
    parts.push(']');
    leave(list);
  }

  function encodeDict(entries, level, owner) {
    if (entries.length === 0) { parts.push('{}'); return; }
    enter(owner);
    if (sortKeys) {
      // Python sorts the raw (uncoerced) keys with `<`: str by code point, int/float/bool numerically, anything
      // else incomparable -> TypeError. Keys are coerced to text only afterwards.
      entries = entries.slice().sort((p, q) => comparePyKeys(p[0], q[0]));
    }
    let sep = itemSep;
    if (indentText !== null) {
      parts.push('{' + newline(level + 1));
      sep = itemSep + newline(level + 1);
    } else parts.push('{');
    entries.forEach(([k, v], i) => {
      if (i) parts.push(sep);
      parts.push(quote(keyText(k)), keySep);
      encode(v, level + 1);
    });
    if (indentText !== null) parts.push(newline(level));
    parts.push('}');
    leave(owner);
  }

  encode(value, 0);
  return parts.join('');
}

/**
 * json.dump(value, fp, options): encode, then write the text to `fp` (no trailing newline, returns undefined).
 * `fp` is a file descriptor number (written with fs.writeSync, completely), or any object with a synchronous
 * `write(text)` method (an `{ write }` adapter, a Writable stream, process.stdout, ...). Anything else raises a
 * TypeError (it is never silently interpreted as options). Deviation: Python's generator-based json.dump writes
 * the chunks produced before an encoding error and then raises; this writes nothing when encoding fails.
 */
export function dump(value, fp, options = {}) {
  if (typeof fp !== 'number' && !(fp !== null && typeof fp === 'object' && typeof fp.write === 'function')) {
    throw new TypeErrorPy(`'${fp === null ? 'NoneType' : typeName(fp)}' object has no attribute 'write'`);
  }
  const text = dumps(value, options);
  if (typeof fp === 'number') {
    // A Python text file opened with the default strict utf-8 refuses lone surrogates (ensure_ascii=False).
    if (!text.isWellFormed()) throw new UnicodeEncodeError(text);
    const data = Buffer.from(text, 'utf8');
    for (let offset = 0; offset < data.length;) offset += fs.writeSync(fp, data, offset, data.length - offset);
    return undefined;
  }
  fp.write(text);
  return undefined;
}

// ------------------------------------------------------------------------------------------ conversion

const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

/**
 * Lossless -> plain JS, for READ-ONLY use only (never read-modify-write a file through it; edit the Map from
 * loads() in place and dumps() that instead).
 *   int -> number (BigInt beyond the safe range), float -> number, dict -> plain object, list -> array.
 * Silent damage is refused instead of produced:
 *   - a dict whose keys JS would reorder (integer-like keys such as "10"/"2" move to the front in ascending order)
 *     throws ValueError unless `{ allowReorder: true }`;
 *   - a float with an integral value (1.0, -0.0) stays a PyFloat (so dumps() still prints `1.0`) unless
 *     `{ floats: 'number' }` flattens every float to a plain number.
 */
export function toPlain(value, { allowReorder = false, floats = 'keep-integral' } = {}) {
  const convert = v => {
    if (v instanceof PyFloat) return floats === 'number' || !Number.isInteger(v.value) ? v.value : v;
    if (typeof v === 'bigint') return normInt(v);
    if (Array.isArray(v)) return v.map(convert);
    if (v instanceof Map) {
      const out = {};
      for (const [k, item] of v) {
        if (typeof k !== 'string') throw new ValueError(`toPlain: dict key ${String(k)} is not a string`);
        Object.defineProperty(out, k, { value: convert(item), enumerable: true, writable: true, configurable: true });
      }
      if (!allowReorder) {
        const original = [...v.keys()];
        const reordered = Object.keys(out);
        if (original.length !== reordered.length || original.some((k, i) => k !== reordered[i])) {
          throw new ValueError('toPlain would reorder dict keys (integer-like keys: ' +
            original.filter(k => ARRAY_INDEX.test(k)).join(', ') + '); keep the Map from loads() for read-modify-write, ' +
            'or pass { allowReorder: true } when order is irrelevant');
        }
      }
      return out;
    }
    return v;
  };
  return convert(value);
}

/** Plain JS -> lossless, using the dumps() conventions (safe integer -> int, other numbers -> float). */
export function fromPlain(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && !Object.is(value, -0) ? value : new PyFloat(value);
  if (Array.isArray(value)) return value.map(fromPlain);
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, fromPlain(v)]));
  if (value !== null && typeof value === 'object' && !(value instanceof PyFloat)) {
    return new Map(Object.keys(value).map(k => [k, fromPlain(value[k])]));
  }
  return value;
}

/** copy.deepcopy of a lossless value (Map/Array/PyFloat aware; PyFloat NaN identity is preserved). */
export function deepcopy(value) {
  if (Array.isArray(value)) return value.map(deepcopy);
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, deepcopy(v)]));
  return value; // strings, numbers, bigints, booleans, null and (immutable) PyFloat instances
}

const isNumeric = v => typeof v === 'number' || v instanceof PyFloat || typeof v === 'bigint' || typeof v === 'boolean';

/**
 * Python `x == y` of two lossless/plain values (1 == 1.0 == True; ints and floats compare by value, never rounded).
 * Inside containers CPython first tries identity, so `[nan] == [nan]` is True when it is the same float object:
 * loads() returns one shared object for every NaN token, so a loads() result equals itself and its copies; a
 * top-level `equal(nan, nan)` is False as in Python.
 */
export function equal(x, y) {
  if (isNumeric(x) || isNumeric(y)) {
    if (!isNumeric(x) || !isNumeric(y)) return false;
    const num = v => (v instanceof PyFloat ? v.value : typeof v === 'boolean' ? (v ? 1 : 0) : v);
    // eslint-disable-next-line eqeqeq
    return num(x) == num(y); // Number/BigInt loose equality compares mathematically, without rounding
  }
  if (Array.isArray(x)) return Array.isArray(y) && x.length === y.length && x.every((v, i) => same(v, y[i]));
  if (x instanceof Map) return y instanceof Map && x.size === y.size && [...x].every(([k, v]) => y.has(k) && same(v, y.get(k)));
  return x === y;
}
// PyObject_RichCompare with the identity shortcut used by list/dict element comparison.
const same = (a, b) => a === b || equal(a, b);

export default {
  loads, dumps, dump, toPlain, fromPlain, deepcopy, equal, reprFloat, PyFloat, pyfloat, isInt, isFloat, isDict, normInt,
  JSONDecodeError, ValueError, UnicodeDecodeError, compareCodePoints,
};
