// Port of CPython 3.12's tomllib (Lib/tomllib/_parser.py, _re.py; Taneli Hukkinen's tomli, MIT) so TOML is
// accepted, valued and rejected exactly as `tomllib.loads` does, including TOMLDecodeError texts such as
// "Invalid value (at line 1, column 5)". Used by lcu/codex_hooks.py, lcu/approval.py and lcu/sandbox_shim.py.
//
//   loads(text)   -> Map (a Python dict); throws TOMLDecodeError (a ValueError subclass) like tomllib.
//   loadsBytes(buffer)  Python `tomllib.loads(data.decode())`: strict UTF-8 decode (UnicodeDecodeError) first.
//
// Value model = lcu/compat/pyjson.mjs's lossless model: str -> string, bool -> boolean, int -> Number (BigInt beyond 2^53, pyjson's normInt),
// float -> PyFloat, array -> Array, table -> Map (insertion ordered), and the TOML date/time kinds ->
// instances of the classes `datetime`, `date`, `time` below (not JSON serialisable, like Python's).
//
// Positions index UTF-16 units internally; column numbers in messages are converted to code points. Python's
// default 4300-digit limit on decimal integer strings is reproduced (a plain ValueError, as int() raises it).
import { PyFloat, ValueError, normInt } from './pyjson.mjs';
import { reprStr } from './pyerr.mjs';
import { decode } from './utf8.mjs';

export class TOMLDecodeError extends ValueError {
  constructor(message) {
    super(message);
    this.name = 'TOMLDecodeError';
    this.isValueError = true;
  }
}

export class date {
  constructor(year, month, day) { Object.assign(this, { year, month, day }); }
}
export class time {
  constructor(hour, minute, second, microsecond) { Object.assign(this, { hour, minute, second, microsecond }); }
}
export class datetime {
  // offset: minutes east of UTC, or null for a local date-time.
  constructor(year, month, day, hour, minute, second, microsecond, offset) {
    Object.assign(this, { year, month, day, hour, minute, second, microsecond, offset });
  }
}

const ASCII_CTRL = new Set([...Array(32).keys()].map((i) => String.fromCharCode(i)).concat(['\x7f']));
const without = (set, ...chars) => new Set([...set].filter((c) => !chars.includes(c)));
const ILLEGAL_BASIC_STR_CHARS = without(ASCII_CTRL, '\t');
const ILLEGAL_MULTILINE_BASIC_STR_CHARS = without(ASCII_CTRL, '\t', '\n');
const ILLEGAL_LITERAL_STR_CHARS = ILLEGAL_BASIC_STR_CHARS;
const ILLEGAL_MULTILINE_LITERAL_STR_CHARS = ILLEGAL_MULTILINE_BASIC_STR_CHARS;
const ILLEGAL_COMMENT_CHARS = ILLEGAL_BASIC_STR_CHARS;

const TOML_WS = new Set([' ', '\t']);
const TOML_WS_AND_NEWLINE = new Set([' ', '\t', '\n']);
const BARE_KEY_CHARS = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_');
const KEY_INITIAL_CHARS = new Set([...BARE_KEY_CHARS, '"', "'"]);
const HEXDIGIT_CHARS = new Set('0123456789abcdefABCDEF');

const BASIC_STR_ESCAPE_REPLACEMENTS = new Map([
  ['\\b', '\b'], ['\\t', '\t'], ['\\n', '\n'], ['\\f', '\f'], ['\\r', '\r'], ['\\"', '"'], ['\\\\', '\\'],
]);

const TIME_RE = '([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(?:\\.([0-9]{1,6})[0-9]*)?';
const RE_NUMBER = /0(?:x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|b[01](?:_?[01])*|o[0-7](?:_?[0-7])*)|[+-]?(?:0|[1-9](?:_?[0-9])*)((?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?)/y;
const RE_LOCALTIME = new RegExp(TIME_RE, 'y');
const RE_DATETIME = new RegExp(
  `([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])(?:[Tt ]${TIME_RE}(?:([Zz])|([+-])([01][0-9]|2[0-3]):([0-5][0-9]))?)?`,
  'y');

function matchAt(re, src, pos) {
  re.lastIndex = pos;
  return re.exec(src);
}

const leap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function matchToDatetime(m) {
  const [, y, mo, d, h, mi, s, micros, zulu, sign, oh, om] = m;
  const year = Number(y); const month = Number(mo); const day = Number(d);
  // datetime.date(...) raises ValueError for year 0 and for a day beyond the month's length.
  if (year < 1 || day > (month === 2 && leap(year) ? 29 : DAYS[month - 1])) throw new ValueError('invalid date');
  if (h === undefined) return new date(year, month, day);
  const micro = micros ? Number(micros.padEnd(6, '0')) : 0;
  let offset = null;
  if (sign) offset = (sign === '+' ? 1 : -1) * (Number(oh) * 60 + Number(om));
  else if (zulu) offset = 0;
  return new datetime(year, month, day, Number(h), Number(mi), Number(s), micro, offset);
}

function matchToLocaltime(m) {
  const [, h, mi, s, micros] = m;
  return new time(Number(h), Number(mi), Number(s), micros ? Number(micros.padEnd(6, '0')) : 0);
}

const parseFloat_ = (text) => new PyFloat(
  /inf$/.test(text) ? (text[0] === '-' ? -Infinity : Infinity) : /nan$/.test(text) ? NaN : Number(text.replaceAll('_', '')));

// sys.int_info.default_max_str_digits: int(text, 0) refuses longer decimal strings (power-of-two bases are exempt).
const INT_MAX_STR_DIGITS = 4300;

function matchToNumber(m) {
  if (m[1]) return parseFloat_(m[0]);
  if (!/^0[xob]/.test(m[0])) {
    const digits = m[0].replace(/[^0-9]/g, '').length;
    if (digits > INT_MAX_STR_DIGITS) {
      throw new ValueError(`Exceeds the limit (${INT_MAX_STR_DIGITS} digits) for integer string conversion: value has ${digits} digits; use sys.set_int_max_str_digits() to increase the limit`);
    }
  }
  return normInt(BigInt(m[0].replaceAll('_', '')));
}

/** Python repr of a tuple of str, as used in f-strings of the key tuples. */
const keyRepr = (key) => (key.length === 1 ? `(${reprStr(key[0])},)` : `(${key.map(reprStr).join(', ')})`);

export function loads(s) {
  // The spec allows converting "\r\n" to "\n", even in string literals.
  const src = s.replaceAll('\r\n', '\n');
  let pos = 0;
  const out = { data: new NestedDict(), flags: new Flags() };
  let header = [];

  for (;;) {
    pos = skipChars(src, pos, TOML_WS);
    if (pos >= src.length) break;
    let char = src[pos];
    if (char === '\n') { pos += 1; continue; }
    if (KEY_INITIAL_CHARS.has(char)) {
      pos = keyValueRule(src, pos, out, header);
      pos = skipChars(src, pos, TOML_WS);
    } else if (char === '[') {
      const secondChar = pos + 1 < src.length ? src[pos + 1] : null;
      out.flags.finalizePending();
      if (secondChar === '[') [pos, header] = createListRule(src, pos, out);
      else [pos, header] = createDictRule(src, pos, out);
      pos = skipChars(src, pos, TOML_WS);
    } else if (char !== '#') {
      throw suffixedErr(src, pos, 'Invalid statement');
    }
    pos = skipComment(src, pos);
    if (pos >= src.length) break;
    char = src[pos];
    if (char !== '\n') throw suffixedErr(src, pos, 'Expected newline or end of document after a statement');
    pos += 1;
  }
  return out.data.dict;
}

/** `tomllib.loads(data.decode())` for file contents: strict UTF-8 first. */
export function loadsBytes(data) {
  return loads(decode(data));
}

// Flags: FROZEN marks an immutable namespace (inline array/table); EXPLICIT_NEST one explicitly created.
const FROZEN = 0;
const EXPLICIT_NEST = 1;

class Flags {
  constructor() {
    this.flags = new Map();
    this.pending = new Map();
  }

  addPending(key, flag) {
    this.pending.set(JSON.stringify([key, flag]), [key, flag]);
  }

  finalizePending() {
    for (const [key, flag] of this.pending.values()) this.set(key, flag, false);
    this.pending.clear();
  }

  unsetAll(key) {
    let cont = this.flags;
    for (const k of key.slice(0, -1)) {
      if (!cont.has(k)) return;
      cont = cont.get(k).nested;
    }
    cont.delete(key[key.length - 1]);
  }

  set(key, flag, recursive) {
    let cont = this.flags;
    const stem = key[key.length - 1];
    for (const k of key.slice(0, -1)) {
      if (!cont.has(k)) cont.set(k, { flags: new Set(), recursive: new Set(), nested: new Map() });
      cont = cont.get(k).nested;
    }
    if (!cont.has(stem)) cont.set(stem, { flags: new Set(), recursive: new Set(), nested: new Map() });
    cont.get(stem)[recursive ? 'recursive' : 'flags'].add(flag);
  }

  is(key, flag) {
    if (!key.length) return false; // document root has no flags
    let cont = this.flags;
    for (const k of key.slice(0, -1)) {
      if (!cont.has(k)) return false;
      const inner = cont.get(k);
      if (inner.recursive.has(flag)) return true;
      cont = inner.nested;
    }
    const stem = key[key.length - 1];
    if (cont.has(stem)) {
      const entry = cont.get(stem);
      return entry.flags.has(flag) || entry.recursive.has(flag);
    }
    return false;
  }
}

class KeyError extends Error {}

class NestedDict {
  constructor() {
    this.dict = new Map();
  }

  getOrCreateNest(key, accessLists = true) {
    let cont = this.dict;
    for (const k of key) {
      if (!cont.has(k)) cont.set(k, new Map());
      cont = cont.get(k);
      if (accessLists && Array.isArray(cont)) cont = cont[cont.length - 1];
      if (!(cont instanceof Map)) throw new KeyError('There is no nest behind this key');
    }
    return cont;
  }

  appendNestToList(key) {
    const cont = this.getOrCreateNest(key.slice(0, -1));
    const last = key[key.length - 1];
    if (cont.has(last)) {
      const list = cont.get(last);
      if (!Array.isArray(list)) throw new KeyError('An object other than list found behind this key');
      list.push(new Map());
    } else {
      cont.set(last, [new Map()]);
    }
  }
}

function skipChars(src, pos, chars) {
  while (pos < src.length && chars.has(src[pos])) pos += 1;
  return pos;
}

function skipUntil(src, pos, expect, errorOn, errorOnEof) {
  let newPos = src.indexOf(expect, pos);
  if (newPos === -1) {
    newPos = src.length;
    if (errorOnEof) throw suffixedErr(src, newPos, `Expected ${reprStr(expect)}`);
  }
  for (let i = pos; i < newPos; i++) {
    if (errorOn.has(src[i])) throw suffixedErr(src, i, `Found invalid character ${reprStr(src[i])}`);
  }
  return newPos;
}

function skipComment(src, pos) {
  if (pos < src.length && src[pos] === '#') return skipUntil(src, pos + 1, '\n', ILLEGAL_COMMENT_CHARS, false);
  return pos;
}

function skipCommentsAndArrayWs(src, pos) {
  for (;;) {
    const before = pos;
    pos = skipChars(src, pos, TOML_WS_AND_NEWLINE);
    pos = skipComment(src, pos);
    if (pos === before) return pos;
  }
}

function createDictRule(src, pos, out) {
  pos += 1; // Skip "["
  pos = skipChars(src, pos, TOML_WS);
  let key;
  [pos, key] = parseKey(src, pos);
  if (out.flags.is(key, EXPLICIT_NEST) || out.flags.is(key, FROZEN)) {
    throw suffixedErr(src, pos, `Cannot declare ${keyRepr(key)} twice`);
  }
  out.flags.set(key, EXPLICIT_NEST, false);
  try {
    out.data.getOrCreateNest(key);
  } catch (error) {
    if (error instanceof KeyError) throw suffixedErr(src, pos, 'Cannot overwrite a value');
    throw error;
  }
  if (!src.startsWith(']', pos)) throw suffixedErr(src, pos, "Expected ']' at the end of a table declaration");
  return [pos + 1, key];
}

function createListRule(src, pos, out) {
  pos += 2; // Skip "[["
  pos = skipChars(src, pos, TOML_WS);
  let key;
  [pos, key] = parseKey(src, pos);
  if (out.flags.is(key, FROZEN)) throw suffixedErr(src, pos, `Cannot mutate immutable namespace ${keyRepr(key)}`);
  // Free the namespace now that it points to another empty list item...
  out.flags.unsetAll(key);
  // ...but this key precisely is still prohibited from table declaration
  out.flags.set(key, EXPLICIT_NEST, false);
  try {
    out.data.appendNestToList(key);
  } catch (error) {
    if (error instanceof KeyError) throw suffixedErr(src, pos, 'Cannot overwrite a value');
    throw error;
  }
  if (!src.startsWith(']]', pos)) throw suffixedErr(src, pos, "Expected ']]' at the end of an array declaration");
  return [pos + 2, key];
}

function keyValueRule(src, pos, out, header) {
  let key; let value;
  [pos, key, value] = parseKeyValuePair(src, pos);
  const keyParent = key.slice(0, -1);
  const keyStem = key[key.length - 1];
  const absKeyParent = [...header, ...keyParent];

  for (let i = 1; i < key.length; i++) {
    const contKey = [...header, ...key.slice(0, i)];
    // Check that dotted key syntax does not redefine an existing table
    if (out.flags.is(contKey, EXPLICIT_NEST)) throw suffixedErr(src, pos, `Cannot redefine namespace ${keyRepr(contKey)}`);
    // Containers in the relative path can't be opened with the table syntax or dotted key/value syntax
    // in following table sections.
    out.flags.addPending(contKey, EXPLICIT_NEST);
  }
  if (out.flags.is(absKeyParent, FROZEN)) {
    throw suffixedErr(src, pos, `Cannot mutate immutable namespace ${keyRepr(absKeyParent)}`);
  }
  let nest;
  try {
    nest = out.data.getOrCreateNest(absKeyParent);
  } catch (error) {
    if (error instanceof KeyError) throw suffixedErr(src, pos, 'Cannot overwrite a value');
    throw error;
  }
  if (nest.has(keyStem)) throw suffixedErr(src, pos, 'Cannot overwrite a value');
  // Mark inline table and array namespaces recursively immutable
  if (value instanceof Map || Array.isArray(value)) out.flags.set([...header, ...key], FROZEN, true);
  nest.set(keyStem, value);
  return pos;
}

function parseKeyValuePair(src, pos) {
  let key;
  [pos, key] = parseKey(src, pos);
  const char = pos < src.length ? src[pos] : null;
  if (char !== '=') throw suffixedErr(src, pos, "Expected '=' after a key in a key/value pair");
  pos += 1;
  pos = skipChars(src, pos, TOML_WS);
  let value;
  [pos, value] = parseValue(src, pos);
  return [pos, key, value];
}

function parseKey(src, pos) {
  let part;
  [pos, part] = parseKeyPart(src, pos);
  const key = [part];
  pos = skipChars(src, pos, TOML_WS);
  for (;;) {
    const char = pos < src.length ? src[pos] : null;
    if (char !== '.') return [pos, key];
    pos += 1;
    pos = skipChars(src, pos, TOML_WS);
    [pos, part] = parseKeyPart(src, pos);
    key.push(part);
    pos = skipChars(src, pos, TOML_WS);
  }
}

function parseKeyPart(src, pos) {
  const char = pos < src.length ? src[pos] : null;
  if (char !== null && BARE_KEY_CHARS.has(char)) {
    const start = pos;
    pos = skipChars(src, pos, BARE_KEY_CHARS);
    return [pos, src.slice(start, pos)];
  }
  if (char === "'") return parseLiteralStr(src, pos);
  if (char === '"') return parseOneLineBasicStr(src, pos);
  throw suffixedErr(src, pos, 'Invalid initial character for a key part');
}

function parseOneLineBasicStr(src, pos) {
  pos += 1;
  return parseBasicStr(src, pos, false);
}

function parseArray(src, pos) {
  pos += 1;
  const array = [];
  pos = skipCommentsAndArrayWs(src, pos);
  if (src.startsWith(']', pos)) return [pos + 1, array];
  for (;;) {
    let value;
    [pos, value] = parseValue(src, pos);
    array.push(value);
    pos = skipCommentsAndArrayWs(src, pos);
    const c = src.slice(pos, pos + 1);
    if (c === ']') return [pos + 1, array];
    if (c !== ',') throw suffixedErr(src, pos, 'Unclosed array');
    pos += 1;
    pos = skipCommentsAndArrayWs(src, pos);
    if (src.startsWith(']', pos)) return [pos + 1, array];
  }
}

function parseInlineTable(src, pos) {
  pos += 1;
  const nested = new NestedDict();
  const flags = new Flags();
  pos = skipChars(src, pos, TOML_WS);
  if (src.startsWith('}', pos)) return [pos + 1, nested.dict];
  for (;;) {
    let key; let value;
    [pos, key, value] = parseKeyValuePair(src, pos);
    const keyParent = key.slice(0, -1);
    const keyStem = key[key.length - 1];
    if (flags.is(key, FROZEN)) throw suffixedErr(src, pos, `Cannot mutate immutable namespace ${keyRepr(key)}`);
    let nest;
    try {
      nest = nested.getOrCreateNest(keyParent, false);
    } catch (error) {
      if (error instanceof KeyError) throw suffixedErr(src, pos, 'Cannot overwrite a value');
      throw error;
    }
    if (nest.has(keyStem)) throw suffixedErr(src, pos, `Duplicate inline table key ${reprStr(keyStem)}`);
    nest.set(keyStem, value);
    pos = skipChars(src, pos, TOML_WS);
    const c = src.slice(pos, pos + 1);
    if (c === '}') return [pos + 1, nested.dict];
    if (c !== ',') throw suffixedErr(src, pos, 'Unclosed inline table');
    if (value instanceof Map || Array.isArray(value)) flags.set(key, FROZEN, true);
    pos += 1;
    pos = skipChars(src, pos, TOML_WS);
  }
}

function parseBasicStrEscape(src, pos, multiline = false) {
  const escapeId = src.slice(pos, pos + 2);
  pos += 2;
  if (multiline && (escapeId === '\\ ' || escapeId === '\\\t' || escapeId === '\\\n')) {
    // Skip whitespace until next non-whitespace character or end of the doc. Error if non-whitespace
    // is found before newline.
    if (escapeId !== '\\\n') {
      pos = skipChars(src, pos, TOML_WS);
      if (pos >= src.length) return [pos, ''];
      if (src[pos] !== '\n') throw suffixedErr(src, pos, "Unescaped '\\' in a string");
      pos += 1;
    }
    pos = skipChars(src, pos, TOML_WS_AND_NEWLINE);
    return [pos, ''];
  }
  if (escapeId === '\\u') return parseHexChar(src, pos, 4);
  if (escapeId === '\\U') return parseHexChar(src, pos, 8);
  if (BASIC_STR_ESCAPE_REPLACEMENTS.has(escapeId)) return [pos, BASIC_STR_ESCAPE_REPLACEMENTS.get(escapeId)];
  throw suffixedErr(src, pos, "Unescaped '\\' in a string");
}

const parseBasicStrEscapeMultiline = (src, pos) => parseBasicStrEscape(src, pos, true);

function parseHexChar(src, pos, hexLen) {
  const hex = src.slice(pos, pos + hexLen);
  if (hex.length !== hexLen || [...hex].some((c) => !HEXDIGIT_CHARS.has(c))) throw suffixedErr(src, pos, 'Invalid hex value');
  pos += hexLen;
  const int = parseInt(hex, 16);
  if (!((int >= 0 && int <= 55295) || (int >= 57344 && int <= 1114111))) {
    throw suffixedErr(src, pos, 'Escaped character is not a Unicode scalar value');
  }
  return [pos, String.fromCodePoint(int)];
}

function parseLiteralStr(src, pos) {
  pos += 1; // Skip starting apostrophe
  const start = pos;
  pos = skipUntil(src, pos, "'", ILLEGAL_LITERAL_STR_CHARS, true);
  return [pos + 1, src.slice(start, pos)]; // Skip ending apostrophe
}

function parseMultilineStr(src, pos, literal) {
  pos += 3;
  if (src.startsWith('\n', pos)) pos += 1;
  let delim; let result;
  if (literal) {
    delim = "'";
    const endPos = skipUntil(src, pos, "'''", ILLEGAL_MULTILINE_LITERAL_STR_CHARS, true);
    result = src.slice(pos, endPos);
    pos = endPos + 3;
  } else {
    delim = '"';
    [pos, result] = parseBasicStr(src, pos, true);
  }
  // Add at maximum two extra apostrophes/quotes if the end sequence is 4 or 5 chars long instead of just 3.
  if (!src.startsWith(delim, pos)) return [pos, result];
  pos += 1;
  if (!src.startsWith(delim, pos)) return [pos, result + delim];
  pos += 1;
  return [pos, result + delim + delim];
}

function parseBasicStr(src, pos, multiline) {
  const errorOn = multiline ? ILLEGAL_MULTILINE_BASIC_STR_CHARS : ILLEGAL_BASIC_STR_CHARS;
  const parseEscapes = multiline ? parseBasicStrEscapeMultiline : parseBasicStrEscape;
  let result = '';
  let start = pos;
  for (;;) {
    if (pos >= src.length) throw suffixedErr(src, pos, 'Unterminated string');
    const char = src[pos];
    if (char === '"') {
      if (!multiline) return [pos + 1, result + src.slice(start, pos)];
      if (src.startsWith('"""', pos)) return [pos + 3, result + src.slice(start, pos)];
      pos += 1;
      continue;
    }
    if (char === '\\') {
      result += src.slice(start, pos);
      let parsed;
      [pos, parsed] = parseEscapes(src, pos);
      result += parsed;
      start = pos;
      continue;
    }
    if (errorOn.has(char)) throw suffixedErr(src, pos, `Illegal character ${reprStr(char)}`);
    pos += 1;
  }
}

function parseValue(src, pos) {
  const char = pos < src.length ? src[pos] : null;

  // Basic strings
  if (char === '"') {
    if (src.startsWith('"""', pos)) return parseMultilineStr(src, pos, false);
    return parseOneLineBasicStr(src, pos);
  }
  // Literal strings
  if (char === "'") {
    if (src.startsWith("'''", pos)) return parseMultilineStr(src, pos, true);
    return parseLiteralStr(src, pos);
  }
  // Booleans
  if (char === 't' && src.startsWith('true', pos)) return [pos + 4, true];
  if (char === 'f' && src.startsWith('false', pos)) return [pos + 5, false];
  // Arrays
  if (char === '[') return parseArray(src, pos);
  // Inline tables
  if (char === '{') return parseInlineTable(src, pos);

  // Dates and times
  const datetimeMatch = matchAt(RE_DATETIME, src, pos);
  if (datetimeMatch) {
    let value;
    try {
      value = matchToDatetime(datetimeMatch);
    } catch (error) {
      if (error instanceof ValueError) throw suffixedErr(src, pos, 'Invalid date or datetime');
      throw error;
    }
    return [pos + datetimeMatch[0].length, value];
  }
  const localtimeMatch = matchAt(RE_LOCALTIME, src, pos);
  if (localtimeMatch) return [pos + localtimeMatch[0].length, matchToLocaltime(localtimeMatch)];

  // Integers and "normal" floats.
  const numberMatch = matchAt(RE_NUMBER, src, pos);
  if (numberMatch) return [pos + numberMatch[0].length, matchToNumber(numberMatch)];

  // Special floats
  const firstThree = src.slice(pos, pos + 3);
  if (firstThree === 'inf' || firstThree === 'nan') return [pos + 3, parseFloat_(firstThree)];
  const firstFour = src.slice(pos, pos + 4);
  if (['-inf', '+inf', '-nan', '+nan'].includes(firstFour)) return [pos + 4, parseFloat_(firstFour)];

  throw suffixedErr(src, pos, 'Invalid value');
}

function suffixedErr(src, pos, msg) {
  let where;
  if (pos >= src.length) {
    where = 'end of document';
  } else {
    let line = 1;
    let lastNewline = -1;
    for (let i = 0; i < pos; i++) {
      if (src[i] === '\n') { line += 1; lastNewline = i; }
    }
    // Columns count code points, as Python indexes str by code point.
    const column = line === 1 ? Array.from(src.slice(0, pos)).length + 1 : Array.from(src.slice(lastNewline + 1, pos)).length + 1;
    where = `line ${line}, column ${column}`;
  }
  return new TOMLDecodeError(`${msg} (at ${where})`);
}

export default { loads, loadsBytes, TOMLDecodeError };
