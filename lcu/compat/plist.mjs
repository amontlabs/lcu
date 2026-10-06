// plistlib.loads(bytes) (CPython 3.12) for the property lists LCU reads (Info.plist files of .app bundles).
//
// Structure follows CPython: format detection on the first 32 bytes (_is_fmt_xml / _is_fmt_binary, else
// InvalidFileException), then for XML an expat-equivalent well-formedness parser driving a line-by-line port of
// plistlib._PlistParser's handlers. Binary plists (`bplist00`, which Node cannot read) are converted by the system
// `/usr/bin/plutil -convert xml1 -o - -` (bytes on stdin, XML on stdout; never a file in place) and parsed the same
// way. `lcu apps` scans hundreds of bundles, so XML never spawns a process.
//
// Values: dict -> Map (insertion order; a repeated key keeps its first position with the last value, like a dict);
// array -> Array; string -> string; integer -> Number (BigInt beyond 2^53, compat-caller-rules); real -> number;
// true/false -> boolean; data -> Buffer; date -> Date (naive UTC, like plistlib's naive datetime).
//
// Errors, as plistlib raises them:
//   InvalidFileException (a ValueError): not XML/binary by its header; XML entity declarations; bad binary plist.
//   ExpatError (NOT a ValueError, as in Python): any XML well-formedness error (junk after the root element,
//     undefined entity, invalid character, mismatched tag, unclosed token, ...). The message starts with expat's
//     error text ("undefined entity: line L, column C"); line/column are computed on the decoded text.
//   ValueError: plistlib's own handler errors ("missing value for key 'k' at line N", "unexpected key at line N",
//     "unexpected element at line N", int()/float() literal errors).
//   LookupError: an encoding name Python does not know ("unknown encoding: x").
//   IndexError / AttributeError (named Errors): the crashes plistlib itself has for `<key>` outside any container
//     and an unparsable <date>.
// Encodings: UTF-8 (with or without BOM), UTF-16 with a BOM, ISO-8859-1/latin-1, US-ASCII, and the single-byte
// codecs WHATWG TextDecoder knows (windows-125x, iso-8859-x, ...), like expat's built-ins plus pyexpat's 8-bit
// codec bridge. Undefined entities are skipped (not an error) exactly when expat skips them: the DOCTYPE has an
// external id (or the internal subset has a parameter-entity reference) and the document is not standalone.
// Known limits: line/column numbers may differ from expat's; `<data>` uses Node's lenient base64 (binascii raises
// for some malformed padding).
import { spawnSync } from './spawn.mjs';
import { readFileSync } from 'node:fs';

import { ValueError, normInt, pyfloat } from './pyjson.mjs';
import { pyInt } from './argparse.mjs';

export class InvalidFileException extends ValueError {
  constructor(message = 'Invalid file') {
    super(message);
    this.name = 'InvalidFileException';
  }
}

/** xml.parsers.expat.ExpatError (not a ValueError). */
export class ExpatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExpatError';
  }
}

class NamedError extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

// ------------------------------------------------------------------------------------------- detection

const XML_PREFIXES = ['<?xml', '<plist'];
const BOMS = [
  [Buffer.from([0xef, 0xbb, 0xbf]), 'utf8'],
  [Buffer.from([0xfe, 0xff]), 'utf16be'],
  [Buffer.from([0xff, 0xfe]), 'utf16le'],
];
const encodeAs = (text, encoding) => {
  if (encoding === 'utf16be') return Buffer.from(text, 'utf16le').swap16();
  return Buffer.from(text, encoding === 'utf16le' ? 'utf16le' : 'utf8');
};

function isFmtXml(header) {
  for (const prefix of XML_PREFIXES) if (header.subarray(0, prefix.length).toString('latin1') === prefix) return true;
  for (const [bom, encoding] of BOMS) {
    for (const prefix of XML_PREFIXES) {
      const wanted = Buffer.concat([bom, encodeAs(prefix, encoding)]);
      if (header.subarray(0, wanted.length).equals(wanted)) return true;
    }
  }
  return false;
}
const isFmtBinary = (header) => header.subarray(0, 8).toString('latin1') === 'bplist00';

// ------------------------------------------------------------------------------------------- decoding

// Python codec names after codecs.lookup()'s lower-casing and encodings.normalize_encoding() (runs of
// non-alphanumeric characters other than '.' become one '_', leading/trailing '_' dropped), for the codecs expat
// handles itself; other names go to TextDecoder (single-byte codecs only, as pyexpat's bridge).
const BUILTIN = {
  utf_8: 'utf8', utf8: 'utf8', u8: 'utf8', utf: 'utf8', utf8_ucs2: 'utf8', utf8_ucs4: 'utf8', cp65001: 'utf8',
  utf_16: 'utf16', utf16: 'utf16', u16: 'utf16',
  latin_1: 'latin1', latin1: 'latin1', iso_8859_1: 'latin1', iso8859_1: 'latin1', '8859': 'latin1', cp819: 'latin1',
  latin: 'latin1', l1: 'latin1', iso_ir_100: 'latin1', csisolatin1: 'latin1',
  ascii: 'ascii', us_ascii: 'ascii', '646': 'ascii', us: 'ascii', 'ansi_x3.4_1968': 'ascii', ansi_x3_4_1968: 'ascii',
  'ansi_x3.4_1986': 'ascii', cp367: 'ascii', csascii: 'ascii', ibm367: 'ascii', iso646_us: 'ascii', 'iso_646.irv_1991': 'ascii',
  iso_ir_6: 'ascii',
};
const CP1252_HIGH = ['\u20AC', '', '\u201A', '\u0192', '\u201E', '\u2026', '\u2020', '\u2021', '\u02C6', '\u2030', '\u0160', '\u2039', '\u0152', '', '\u017D', '', '', '\u2018', '\u2019', '\u201C', '\u201D', '\u2022', '\u2013', '\u2014', '\u02DC', '\u2122', '\u0161', '\u203A', '\u0153', '', '\u017E', '\u0178'];

// windows-1252 decoded without ICU (Node builds without full ICU only know UTF-8/UTF-16/latin1); bytes cp1252
// leaves undefined become U+FFFE, an invalid XML character, so the parser reports them in document order.
function decodeCp1252(bytes) {
  let text = '';
  for (const byte of bytes) {
    if (byte >= 0x80 && byte < 0xa0) text += CP1252_HIGH[byte - 0x80] || '\uFFFE';
    else text += String.fromCharCode(byte);
  }
  return text;
}

const normaliseEncoding = (name) => name.toLowerCase().replace(/[^a-z0-9.]+/g, '_').replace(/^_+|_+$/g, '');

const XML_DECL = /^<\?xml\s+version\s*=\s*(["'])[A-Za-z0-9_.:-]+\1(?:\s+encoding\s*=\s*(["'])([A-Za-z][A-Za-z0-9._-]*)\2)?(?:\s+standalone\s*=\s*(["'])(yes|no)\4)?\s*$/;

// The XML declaration (ASCII-compatible when there is no UTF-16 BOM) is checked before the encoding is applied,
// as expat does: a malformed one is an ExpatError whatever it names.
function declaredEncoding(bytes) {
  if (!/^<\?xml[ \t\r\n?]/.test(bytes.toString('latin1', 0, 6))) return null;
  // The whole declaration is scanned however long it is (round-2 R09; no fixed window): a byte search for its end.
  const end = bytes.indexOf('?>');
  if (end < 0) throw new ExpatError('unclosed token: line 1, column 0');
  const match = XML_DECL.exec(bytes.toString('latin1', 0, end));
  if (!match) throw new ExpatError('XML declaration not well-formed: line 1, column 0');
  return match[3] ?? null;
}

function decode(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return strictUtf8(bytes.subarray(3));
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    const little = bytes[0] === 0xff;
    const body = Buffer.from(bytes.subarray(2));
    if (body.length % 2) throw new ExpatError('unclosed token: line 1, column 0');
    if (!little) body.swap16();
    return decodeWith(new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }), body);
  }
  const declared = declaredEncoding(bytes);
  if (declared === null) return strictUtf8(bytes);
  const name = normaliseEncoding(declared);
  const builtin = Object.hasOwn(BUILTIN, name) ? BUILTIN[name] : undefined;
  if (builtin === 'utf8') return strictUtf8(bytes);
  if (builtin === 'latin1') return bytes.toString('latin1');
  if (builtin === 'ascii') {
    const bad = bytes.findIndex((byte) => byte > 0x7f);
    if (bad < 0) return bytes.toString('latin1');
    return `${bytes.subarray(0, bad).toString('latin1')}\uFFFE${bytes.subarray(bad + 1).toString('latin1')}`;
  }
  if (['cp1252', 'windows_1252', '1252'].includes(name)) return decodeCp1252(bytes);
  if (builtin === 'utf16') throw new ExpatError('encoding specified in XML declaration is incorrect: line 1, column 30');
  let decoder;
  try {
    decoder = new TextDecoder(name.replace(/_/g, '-'), { fatal: true });
  } catch {
    throw new NamedError('LookupError', `unknown encoding: ${declared}`);
  }
  if (/^(utf-16|utf-16be|utf-16le|gbk|gb18030|big5|euc-jp|iso-2022-jp|shift_jis|euc-kr)$/.test(decoder.encoding)) {
    throw new ExpatError('unknown encoding: line 1, column 30'); // pyexpat only bridges 8-bit codecs
  }
  return decodeWith(decoder, bytes);
}

// Decode strictly; at the first undecodable byte insert U+FFFE (not an XML character), so the parser reports
// "not well-formed (invalid token)" there, after the handlers for everything before it ran (expat's order).
function strictUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    let good = 0;
    for (let end = bytes.length; end > 0; end--) {
      try {
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end));
        good = end;
        break;
      } catch { /* shorter */ }
    }
    // the longest decodable prefix may end inside a partial sequence boundary only at a char boundary
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, good)) + '\uFFFE' +
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(good));
  }
}

function decodeWith(decoder, bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    // expat reports undecodable input as an invalid token where it occurs
    throw new ExpatError('not well-formed (invalid token): line 1, column 0');
  }
}

function where(text, position) {
  const before = text.slice(0, position);
  const line = before.split('\n').length;
  const column = position - (before.lastIndexOf('\n') + 1);
  return `line ${line}, column ${column}`;
}

// ------------------------------------------------------------------------------------------- XML

const NAME_START = 'A-Za-z_:\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D' +
  '\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NAME_CHAR = `${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const NAME = new RegExp(`[${NAME_START}][${NAME_CHAR}]*`, 'uy');
const INVALID_CHAR = /[^\t\n\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const PREDEFINED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const SPACE = /[ \t\n]/;

const validChar = (code) => code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);

class XmlParser {
  constructor(text, handlers) {
    this.s = text;
    this.i = 0;
    this.h = handlers;
    this.skipUndefined = false;
    this.standalone = false;
    const bad = INVALID_CHAR.exec(text);
    this.firstInvalid = bad ? bad.index : Infinity;
  }

  fail(kind, at = this.i) {
    throw new ExpatError(`${kind}: ${where(this.s, Math.min(at, this.s.length))}`);
  }

  // every character consumed so far must be a legal XML character
  guard(end = this.i) {
    if (this.firstInvalid < end) this.fail('not well-formed (invalid token)', this.firstInvalid);
  }

  line() {
    return this.s.slice(0, this.i).split('\n').length;
  }

  startsWith(text) {
    return this.s.startsWith(text, this.i);
  }

  skipSpace() {
    while (this.i < this.s.length && SPACE.test(this.s[this.i])) this.i++;
  }

  name() {
    NAME.lastIndex = this.i;
    const match = NAME.exec(this.s);
    if (!match) {
      if (this.i >= this.s.length) this.fail('unclosed token');
      this.fail('not well-formed (invalid token)');
    }
    this.i += match[0].length;
    return match[0];
  }

  until(terminator, kind = 'unclosed token') {
    const at = this.s.indexOf(terminator, this.i);
    if (at < 0) this.fail(kind, this.s.length);
    const text = this.s.slice(this.i, at);
    this.i = at + terminator.length;
    return text;
  }

  parse() {
    if (this.startsWith('<?xml') && (SPACE.test(this.s[5] ?? '') || this.s.startsWith('?>', 5))) this.xmlDecl();
    this.misc();
    if (this.startsWith('<!DOCTYPE')) {
      this.doctype();
      this.misc();
    }
    if (this.i >= this.s.length) {
      this.guard(this.s.length);
      this.fail('no element found');
    }
    if (this.s[this.i] !== '<') this.fail('syntax error');
    this.element();
    this.misc();
    if (this.i < this.s.length) this.fail('junk after document element');
    this.guard(this.s.length);
  }

  xmlDecl() {
    const start = this.i;
    this.until('?>');
    const match = XML_DECL.exec(this.s.slice(start, this.i - 2));
    if (!match) this.fail('XML declaration not well-formed', start);
    this.standalone = match[5] === 'yes';
  }

  misc() {
    for (;;) {
      this.skipSpace();
      if (this.startsWith('<!--')) this.comment();
      else if (this.startsWith('<?')) this.pi();
      else return;
    }
  }

  comment() {
    this.i += 4;
    const start = this.i;
    const body = this.until('-->');
    const dash = body.indexOf('--');
    if (dash >= 0) this.fail('not well-formed (invalid token)', start + dash);
    if (body.endsWith('-')) this.fail('not well-formed (invalid token)', start + body.length - 1);
    this.guard();
  }

  pi() {
    this.i += 2;
    const start = this.i;
    const target = this.name();
    if (target.toLowerCase() === 'xml') this.fail('XML or text declaration not at start of entity', start - 2);
    if (!this.startsWith('?>') && !SPACE.test(this.s[this.i] ?? '')) {
      if (this.i >= this.s.length) this.fail('unclosed token');
      this.fail('not well-formed (invalid token)');
    }
    this.until('?>');
    this.guard();
  }

  quoted() {
    const quote = this.s[this.i];
    if (quote !== '"' && quote !== "'") this.fail(this.i >= this.s.length ? 'unclosed token' : 'syntax error');
    this.i++;
    return this.until(quote);
  }

  doctype() {
    this.i += 9;
    if (!SPACE.test(this.s[this.i] ?? '')) this.fail('syntax error');
    this.skipSpace();
    this.name();
    this.skipSpace();
    let external = false;
    const requireSpace = () => {
      if (!SPACE.test(this.s[this.i] ?? '')) this.fail(this.i >= this.s.length ? 'unclosed token' : 'not well-formed (invalid token)');
      this.skipSpace();
    };
    if (this.startsWith('SYSTEM')) {
      this.i += 6;
      requireSpace();
      this.quoted();
      external = true;
    } else if (this.startsWith('PUBLIC')) {
      this.i += 6;
      requireSpace();
      const start = this.i;
      const publicId = this.quoted();
      if (/[^ \r\na-zA-Z0-9\-'()+,./:=?;!*#@$_%]/.test(publicId)) this.fail('illegal character(s) in public id', start);
      requireSpace();
      this.quoted();
      external = true;
    }
    this.skipSpace();
    let parameterReference = false;
    if (this.s[this.i] === '[') {
      this.i++;
      for (;;) {
        this.skipSpace();
        if (this.i >= this.s.length) this.fail('unclosed token');
        if (this.s[this.i] === ']') {
          this.i++;
          break;
        }
        if (this.startsWith('<!--')) this.comment();
        else if (this.startsWith('<?')) this.pi();
        else if (this.s[this.i] === '%') {
          this.i++;
          this.name();
          if (this.s[this.i] !== ';') this.fail('not well-formed (invalid token)');
          this.i++;
          parameterReference = true;
        } else if (/^<!(ELEMENT|ATTLIST|ENTITY|NOTATION)\s/.test(this.s.slice(this.i, this.i + 12))) {
          const entity = this.startsWith('<!ENTITY');
          if (entity) this.entityDeclaration();
          const declStart = this.i;
          this.i += 2;
          while (this.i < this.s.length && this.s[this.i] !== '>') {
            if (this.s[this.i] === '"' || this.s[this.i] === "'") this.quoted();
            else this.i++;
          }
          if (this.i >= this.s.length) this.fail('unclosed token');
          if (!entity) this.markupDeclaration(this.s.slice(declStart, this.i), declStart);
          this.i++;
          this.guard();
          // plistlib.handle_entity_decl
          if (entity) throw new InvalidFileException('XML entity declarations are not supported in plist files');
        } else this.fail('syntax error');
      }
      this.skipSpace();
    }
    if (this.s[this.i] !== '>') this.fail(this.i >= this.s.length ? 'unclosed token' : 'syntax error');
    this.i++;
    this.guard();
    this.skipUndefined = (external || parameterReference) && !this.standalone;
  }

  // `<!ENTITY` S ('%' S)? Name S (EntityValue | ExternalID) ...: expat rejects a malformed declaration before
  // plistlib's entity-declaration handler would see it.
  entityDeclaration() {
    const save = this.i;
    this.i += 8;
    const space = () => {
      if (!SPACE.test(this.s[this.i] ?? '')) this.fail(this.i >= this.s.length ? 'unclosed token' : 'not well-formed (invalid token)');
      this.skipSpace();
    };
    space();
    if (this.s[this.i] === '%') {
      this.i++;
      space();
    }
    this.name();
    space();
    if (this.s[this.i] === '"' || this.s[this.i] === "'") {
      this.quoted();
    } else if (this.startsWith('SYSTEM')) {
      this.i += 6;
      space();
      this.quoted();
    } else if (this.startsWith('PUBLIC')) {
      this.i += 6;
      space();
      this.quoted();
      space();
      this.quoted();
    } else {
      this.fail(this.i >= this.s.length ? 'unclosed token' : 'syntax error');
    }
    const afterValue = SPACE.test(this.s[this.i] ?? '');
    this.skipSpace();
    if (afterValue && this.startsWith('NDATA')) {
      this.i += 5;
      space();
      this.name();
      this.skipSpace();
    }
    if (this.s[this.i] !== '>') this.fail(this.i >= this.s.length ? 'unclosed token' : 'not well-formed (invalid token)');
    this.i = save;
  }

  // <!ELEMENT Name contentspec> / <!ATTLIST ...> / <!NOTATION ...>: the subset of expat's syntax checks
  // that decides acceptance (a stray markup character inside the declaration).
  markupDeclaration(text, start) {
    const element = /^<!ELEMENT\s+([^\s>]+)\s+([\s\S]*)$/.exec(text);
    if (text.startsWith('<!ELEMENT')) {
      NAME.lastIndex = 0;
      const nameOk = element && new RegExp(`^[${NAME_START}][${NAME_CHAR}]*$`, 'u').test(element[1]);
      const spec = element ? element[2].trim() : '';
      if (!nameOk || !/^(?:EMPTY|ANY|\([^<>[\]]*\)[?*+]?)$/.test(spec)) this.fail('not well-formed (invalid token)', start);
    } else if (/[<[\]]/.test(text.slice(2))) {
      this.fail('not well-formed (invalid token)', start);
    }
  }

  reference(inAttribute = false) {
    const start = this.i;
    this.i++; // &
    if (this.s[this.i] === '#') {
      const match = /^#(?:x([0-9a-fA-F]+)|([0-9]+));/.exec(this.s.slice(this.i, this.i + 16));
      if (!match) this.fail(this.i >= this.s.length - 1 ? 'unclosed token' : 'not well-formed (invalid token)', start);
      this.i += match[0].length;
      const code = match[1] !== undefined ? parseInt(match[1], 16) : parseInt(match[2], 10);
      if (!validChar(code)) this.fail('reference to invalid character number', start);
      return String.fromCodePoint(code);
    }
    const name = this.name();
    if (this.s[this.i] !== ';') this.fail(this.i >= this.s.length ? 'unclosed token' : 'not well-formed (invalid token)');
    this.i++;
    if (name in PREDEFINED) return PREDEFINED[name];
    if (!this.skipUndefined) this.fail('undefined entity', start);
    if (inAttribute) return '';
    return '';
  }

  element() {
    this.i++; // <
    const name = this.name();
    const attributes = new Set();
    for (;;) {
      const hadSpace = SPACE.test(this.s[this.i] ?? '');
      this.skipSpace();
      if (this.i >= this.s.length) this.fail('unclosed token');
      if (this.startsWith('/>') || this.s[this.i] === '>') break;
      if (!hadSpace) this.fail('not well-formed (invalid token)');
      const attrStart = this.i;
      const attr = this.name();
      this.skipSpace();
      if (this.s[this.i] !== '=') this.fail(this.i >= this.s.length ? 'unclosed token' : 'not well-formed (invalid token)');
      this.i++;
      this.skipSpace();
      const quote = this.s[this.i];
      if (quote !== '"' && quote !== "'") this.fail(this.i >= this.s.length ? 'unclosed token' : 'not well-formed (invalid token)');
      this.i++;
      while (this.s[this.i] !== quote) {
        if (this.i >= this.s.length) this.fail('unclosed token');
        if (this.s[this.i] === '<') this.fail('not well-formed (invalid token)');
        if (this.s[this.i] === '&') this.reference(true);
        else this.i++;
      }
      this.i++;
      if (attributes.has(attr)) this.fail('duplicate attribute', attrStart);
      attributes.add(attr);
    }
    const empty = this.startsWith('/>');
    this.i += empty ? 2 : 1;
    this.guard();
    this.h.start(name, this);
    if (empty) {
      this.h.end(name, this);
      return;
    }
    this.content(name);
  }

  content(name) {
    let text = '';
    const flush = () => {
      if (text) {
        this.h.data(text);
        text = '';
      }
    };
    for (;;) {
      if (this.i >= this.s.length) {
        this.guard(this.s.length);
        this.fail('no element found');
      }
      const char = this.s[this.i];
      if (char === '<') {
        if (this.startsWith('</')) {
          this.guard();
          flush();
          const start = this.i;
          this.i += 2;
          const closing = this.name();
          this.skipSpace();
          if (this.s[this.i] !== '>') this.fail(this.i >= this.s.length ? 'unclosed token' : 'not well-formed (invalid token)');
          if (closing !== name) this.fail('mismatched tag', start);
          this.i++;
          this.h.end(name, this);
          return;
        }
        if (this.startsWith('<![CDATA[')) {
          this.i += 9;
          const body = this.until(']]>', 'unclosed CDATA section');
          this.guard();
          text += body;
          continue;
        }
        if (this.startsWith('<!--')) {
          this.guard();
          flush();
          this.comment();
          continue;
        }
        if (this.startsWith('<?')) {
          this.guard();
          flush();
          this.pi();
          continue;
        }
        if (this.startsWith('<!')) this.fail('not well-formed (invalid token)');
        this.guard();
        flush();
        this.element();
        continue;
      }
      if (char === '&') {
        this.guard();
        text += this.reference();
        continue;
      }
      if (this.startsWith(']]>')) this.fail('not well-formed (invalid token)');
      text += char;
      this.i++;
    }
  }
}

// ------------------------------------------------------------------------------------------- plistlib handlers

const PY_WS = /^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/gu;

function pyIntLiteral(raw) {
  if (raw.startsWith('0x') || raw.startsWith('0X')) {
    const body = raw.slice(2).replace(/[\s\x1c-\x1f\x85]+$/u, '');
    if (!/^_?[0-9a-fA-F](?:_?[0-9a-fA-F])*$/.test(body)) {
      throw new ValueError(`invalid literal for int() with base 16: ${pyReprStr(raw)}`);
    }
    return normInt(BigInt(`0x${body.replace(/_/g, '')}`));
  }
  try {
    return pyInt(raw);
  } catch (error) {
    throw new ValueError(error.message);
  }
}

function pyFloatLiteral(raw) {
  const text = raw.replace(PY_WS, '');
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(text);
  if (special) return special[2].toLowerCase() === 'nan' ? NaN : (special[1] === '-' ? -Infinity : Infinity);
  const digits = '[0-9](?:_?[0-9])*';
  if (new RegExp(`^[+-]?(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:[eE][+-]?${digits})?$`).test(text)) {
    return Number(text.replace(/_/g, ''));
  }
  throw new ValueError(`could not convert string to float: ${pyReprStr(raw)}`);
}

function pyReprStr(text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  return quote + text.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`)
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + quote;
}

function dateFromString(text) {
  const match = /^(\d\d\d\d)(?:-(\d\d)(?:-(\d\d)(?:T(\d\d)(?::(\d\d)(?::(\d\d))?)?)?)?)?Z/.exec(text);
  if (!match) throw new NamedError('AttributeError', "'NoneType' object has no attribute 'groupdict'");
  const parts = match.slice(1).filter((part) => part !== undefined).map(Number);
  if (parts.length < 3) {
    throw new NamedError('TypeError', parts.length === 1 ? "function missing required argument 'month' (pos 2)"
      : "function missing required argument 'day' (pos 3)");
  }
  const [year, month, day, hour = 0, minute = 0, second = 0] = parts;
  if (year < 1) throw new ValueError(`year ${year} is out of range`);
  if (month < 1 || month > 12) throw new ValueError('month must be in 1..12');
  if (day < 1 || day > new Date(Date.UTC(leap(year) ? 2000 : 2001, month, 0)).getUTCDate()) {
    throw new ValueError('day is out of range for month');
  }
  if (hour > 23) throw new ValueError('hour must be in 0..23');
  if (minute > 59) throw new ValueError('minute must be in 0..59');
  if (second > 59) throw new ValueError('second must be in 0..59');
  const date = new Date(Date.UTC(2000, month - 1, day, hour, minute, second));
  date.setUTCFullYear(year);
  return date;
}

const leap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

// binascii.a2b_base64(s, strict_mode=False) (CPython 3.12): characters outside the alphabet are skipped,
// padding ends the data once a quad is complete, and an incomplete quad is binascii.Error.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function a2bBase64(text) {
  const data = Buffer.from(text, 'utf8');
  const out = [];
  let quad = 0;
  let left = 0;
  let pads = 0;
  for (const byte of data) {
    if (byte === 0x3d) {
      if (quad >= 2 && quad + ++pads >= 4) return Buffer.from(out);
      continue;
    }
    const value = byte > 0x7f ? -1 : B64.indexOf(String.fromCharCode(byte));
    if (value < 0) continue;
    pads = 0;
    if (quad === 0) {
      left = value;
      quad = 1;
    } else if (quad === 1) {
      out.push(((left << 2) | (value >> 4)) & 0xff);
      left = value & 0x0f;
      quad = 2;
    } else if (quad === 2) {
      out.push(((left << 4) | (value >> 2)) & 0xff);
      left = value & 0x03;
      quad = 3;
    } else {
      out.push(((left << 6) | value) & 0xff);
      quad = 0;
      left = 0;
    }
  }
  if (quad === 1) {
    throw new NamedError('Error', 'Invalid base64-encoded string: number of data characters ' +
      `(${(out.length / 3) * 4 + 1}) cannot be 1 more than a multiple of 4`);
  }
  if (quad !== 0) throw new NamedError('Error', 'Incorrect padding');
  return Buffer.from(out);
}

class PlistHandlers {
  constructor() {
    this.stack = [];
    this.current_key = null;
    this.root = null;
    this.data = [];
  }

  start(element) {
    this.data = [];
    if (element === 'dict') {
      const value = new Map();
      this.add_object(value);
      this.stack.push(value);
    } else if (element === 'array') {
      const value = [];
      this.add_object(value);
      this.stack.push(value);
    }
  }

  handle_data(text) {
    this.data.push(text);
  }

  get_data() {
    const text = this.data.join('');
    this.data = [];
    return text;
  }

  add_object(value) {
    if (this.current_key !== null) {
      if (!(this.stack.at(-1) instanceof Map)) throw new ValueError(`unexpected element at line ${this.parser.line()}`);
      this.stack.at(-1).set(this.current_key, value);
      this.current_key = null;
    } else if (!this.stack.length) {
      this.root = value; // this is the root object
    } else {
      if (!Array.isArray(this.stack.at(-1))) throw new ValueError(`unexpected element at line ${this.parser.line()}`);
      this.stack.at(-1).push(value);
    }
  }

  end(element) {
    switch (element) {
      case 'dict':
        if (this.current_key) {
          throw new ValueError(`missing value for key ${pyReprStr(this.current_key)} at line ${this.parser.line()}`);
        }
        this.stack.pop();
        break;
      case 'key':
        if (this.current_key) throw new ValueError(`unexpected key at line ${this.parser.line()}`);
        if (!this.stack.length) throw new NamedError('IndexError', 'list index out of range');
        if (!(this.stack.at(-1) instanceof Map)) throw new ValueError(`unexpected key at line ${this.parser.line()}`);
        this.current_key = this.get_data();
        break;
      case 'array': this.stack.pop(); break;
      case 'true': this.add_object(true); break;
      case 'false': this.add_object(false); break;
      case 'integer': this.add_object(pyIntLiteral(this.get_data())); break;
      case 'real': this.add_object(pyfloat(pyFloatLiteral(this.get_data()))); break;
      case 'string': this.add_object(this.get_data()); break;
      case 'data': this.add_object(a2bBase64(this.get_data())); break;
      case 'date': this.add_object(dateFromString(this.get_data())); break;
      default: break;
    }
  }
}

function parseXml(text) {
  const handlers = new PlistHandlers();
  const normalised = text.replace(/\r\n?/g, '\n');
  const parser = new XmlParser(normalised, {
    start: (name) => handlers.start(name),
    end: (name) => handlers.end(name),
    data: (chunk) => handlers.handle_data(chunk),
  });
  handlers.parser = parser;
  parser.parse();
  return handlers.root;
}

/** plistlib.loads(data). */
export function loads(data) {
  const bytes = Buffer.from(data);
  const header = bytes.subarray(0, 32);
  if (isFmtXml(header)) return parseXml(decode(bytes));
  if (isFmtBinary(header)) {
    const converted = spawnSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'],
      { input: bytes, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 1 << 28 });
    if (converted.error || converted.status !== 0) throw new InvalidFileException();
    return parseXml(decode(converted.stdout));
  }
  throw new InvalidFileException();
}
