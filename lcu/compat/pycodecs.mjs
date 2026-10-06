// Python codec lookup and the two codec behaviours LCU depends on, from tables generated out of CPython 3.12
// (tests/compat/gen_pycodecs_tables.py -> pycodecs_tables.mjs):
//
//   lookup(name)                 encodings.search_function's name normalisation + aliases -> codec module | null
//   pyexpat_unknown_encoding(n)  pyexpat's unknown-encoding handler: a 256-entry byte map (-1 = invalid byte),
//                                'expat-refused' when expat rejects the map, or the Python exception it raises
//                                (LookupError "unknown encoding: <n>", ValueError "multi-byte encodings are not
//                                supported", ...)
//   decode_strict(bytes, name)   bytes.decode(name) (errors='strict') for utf-8, ascii, latin-1 and the single-byte
//                                'charmap' codecs (Windows ANSI code pages), with CPython's UnicodeDecodeError text.
//                                Multi-byte East Asian code pages fall back to TextDecoder (fatal); their error
//                                text is approximate (documented in .port/notes/windows.md).
import { ALIASES, CODECS } from './pycodecs_tables.mjs';
import { UnicodeDecodeError, ValueError } from './pyjson.mjs';
import { decode as decodeUtf8 } from './utf8.mjs';

/** Python's LookupError. */
export class LookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LookupError';
  }
}

/** Python's UnicodeError (a ValueError). */
export class UnicodeError extends ValueError {
  constructor(message) {
    super(message);
    this.name = 'UnicodeError';
  }
}

/** encodings.normalize_encoding */
export function normalize_encoding(encoding) {
  const chars = [];
  let punct = false;
  for (const c of encoding) {
    if (/^[\p{L}\p{N}]$/u.test(c) || c === '.') {
      if (punct && chars.length) chars.push('_');
      if (c.charCodeAt(0) < 0x80) chars.push(c);
      punct = false;
    } else {
      punct = true;
    }
  }
  return chars.join('');
}

/** codecs.lookup(name) -> the encodings module name, or null (LookupError). */
export function lookup(name) {
  const norm = normalize_encoding(String(name).toLowerCase());
  const aliased = ALIASES[norm] ?? ALIASES[norm.replace(/\./g, '_')];
  for (const module of aliased ? [aliased, norm] : [norm]) {
    if (!module || module.includes('.')) continue;
    if (Object.hasOwn(CODECS, module)) return module;
  }
  return null;
}

function raise(entry, name) {
  const message = entry.message.replaceAll('{name}', name);
  if (entry.class === 'LookupError') return new LookupError(message);
  if (entry.class === 'UnicodeError') return new UnicodeError(message);
  const error = new ValueError(message);
  error.name = entry.class;
  return error;
}

/** pyexpat's PyUnknownEncodingHandler for `name` (as declared). */
export function pyexpat_unknown_encoding(name) {
  const module = lookup(name);
  if (module === null) throw new LookupError(`unknown encoding: ${name}`);
  const entry = CODECS[module];
  if (entry.kind === 'error') throw raise(entry, name);
  if (entry.expat === false) return 'expat-refused';
  return Array.from(entry.map, (ch) => (ch === '�' ? -1 : ch.codePointAt(0)));
}

// 'map' codecs whose strict decoding is not a per-byte table.
const NOT_CHARMAP = new Set(['utf_8_sig', 'utf_7', 'unicode_escape', 'raw_unicode_escape']);

const charmapError = (bytes, index) =>
  new UnicodeDecodeError('charmap', index, index + 1, 'character maps to <undefined>', bytes);

/** bytes.decode(name) with errors='strict'. */
export function decode_strict(data, name) {
  const bytes = data instanceof Uint8Array ? data : Buffer.from(data);
  const module = lookup(name);
  if (module === null) throw new LookupError(`unknown encoding: ${name}`);
  if (module === 'utf_8') return decodeUtf8(bytes);
  if (module === 'ascii') {
    const bad = bytes.findIndex((b) => b > 0x7f);
    if (bad >= 0) throw new UnicodeDecodeError('ascii', bad, bad + 1, 'ordinal not in range(128)', bytes);
    return Buffer.from(bytes).toString('latin1');
  }
  if (module === 'latin_1') return Buffer.from(bytes).toString('latin1');
  const entry = CODECS[module];
  if (entry.kind === 'map' && !NOT_CHARMAP.has(module)) {
    const map = entry.map;
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
      const ch = map[bytes[i]];
      if (ch === '�') throw charmapError(bytes, i);
      out += ch;
    }
    return out;
  }
  const label = { cp932: 'shift_jis', cp936: 'gbk', cp949: 'euc-kr', cp950: 'big5', gb18030: 'gb18030' }[entry.codec ?? module] ?? module;
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (error instanceof RangeError) throw new LookupError(`unknown encoding: ${name}`);
    throw new UnicodeDecodeError(module, 0, 1, 'illegal multibyte sequence', bytes);
  }
}
