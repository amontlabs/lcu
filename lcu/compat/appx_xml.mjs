// XML reader for AppxManifest.xml that replaces Python's xml.etree.ElementTree (pyexpat) in lcu/windows.py.
//
// windows._appx_identity only needs the first element, in document order, whose local name is `Identity` and its
// un-prefixed attributes. ElementTree (expat, namespace mode) decides which documents are accepted and what the
// attribute values are, and some failures are not ParseError at all. This module reproduces that observable
// behaviour: it checks the whole document like expat (names, characters, references, tags, comments, PIs,
// CDATA, the XML declaration, the DOCTYPE with its internal subset: ENTITY/ATTLIST/ELEMENT/NOTATION
// declarations, parameter-entity references, entity expansion in content and attribute values, attribute
// defaults and tokenized-type normalisation, namespace binding rules, duplicate attributes) and throws
//   * XmlParseError for what ElementTree reports as ParseError,
//   * LookupError / ValueError / UnicodeError / UnicodeDecodeError (compat/pycodecs) where pyexpat's
//     unknown-encoding handler raises those Python exceptions instead.
// Differential tests: tests/compat/test_appx_xml.py (corpus, review cases, seeded mutations).
//
// Known limits (documented in .port/notes/windows.md): expat's exact name tables are generated
// (appx_xml_tables.mjs); codec tables come from CPython on macOS (pycodecs_tables.mjs); external entities and
// the external DTD subset are never read (ElementTree does not read them either).
import { NAME_CHAR_RANGES, NAME_START_RANGES } from './appx_xml_tables.mjs';
import { pyexpat_unknown_encoding } from './pycodecs.mjs';

export { LookupError } from './pycodecs.mjs';

export class XmlParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XmlParseError';
  }
}

const fail = (reason) => { throw new XmlParseError(reason); };
const INVALID = 'not well-formed (invalid token)';

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

const esc = (cp) => `\\u${cp.toString(16).padStart(4, '0')}`;
const cls = (ranges) => ranges.map(([lo, hi]) => (lo === hi ? esc(lo) : `${esc(lo)}-${esc(hi)}`)).join('');
const START = cls(NAME_START_RANGES);
const BODY = cls(NAME_CHAR_RANGES);
const NAME_AT = new RegExp(`[:${START}][:${BODY}]*`, 'y');
const NMTOKEN_AT = new RegExp(`[:${BODY}]+`, 'y');
const NCNAME = new RegExp(`^[${START}][${BODY}]*$`);
const NCLOCAL = new RegExp(`^[${BODY}]+$`);
const INVALID_CHAR = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const PUBID = /^[\x20\x0d\x0a a-zA-Z0-9\-'()+,./:=?;!*#@$_%]*$/;
const SPACE = new Set([' ', '\t', '\n', '\r']);
const isSpace = (ch) => SPACE.has(ch);

// expat's billion-laughs protection (XML_SetBillionLaughsAttackProtection* defaults).
const AMPLIFICATION_THRESHOLD = 8 * 1024 * 1024;
const AMPLIFICATION_FACTOR = 100;

// ------------------------------------------------------------------------------------------------ decoding

/** The XML declaration at the very start of `head` (any length, R9), or null. */
function declaredEncoding(head) {
  if (!head.startsWith('<?xml') || !(isSpace(head[5] ?? '') || head.startsWith('?>', 5))) return null;
  const end = head.indexOf('?>');
  const decl = end < 0 ? head : head.slice(0, end);
  const match = /[ \t\r\n]encoding[ \t\r\n]*=[ \t\r\n]*(?:"([^"]*)"|'([^']*)')/.exec(decl);
  return match ? (match[1] ?? match[2]) : null;
}

const strictDecode = (label, input) => {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(input);
  } catch {
    return fail(INVALID);
  }
};

const NATIVE = new Set(['utf-8', 'utf-16', 'utf-16be', 'utf-16le', 'iso-8859-1', 'us-ascii']);
const ENCNAME = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** expat reports a malformed XML declaration before it looks at the declared encoding. */
function checkDeclaration(text) {
  const end = text.indexOf('?>');
  new Parser(end < 0 ? text : text.slice(0, end + 2)).xmlDecl();
}

/** Decode the document bytes the way expat (+ pyexpat's unknown-encoding handler) chooses the encoding. */
export function decodeDocument(bytes) {
  return decodeWithMeta(bytes).text;
}

/**
 * decodeDocument plus what the amplification accounting needs: bytes per input character (`unit`: 'utf8', 'utf16',
 * 'single') and the byte order mark's length (`bom`, counted as input by expat).
 */
export function decodeWithMeta(bytes) {
  const data = Buffer.from(bytes);
  let wide = null;
  let body = data;
  let bom = 0;
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) { wide = 'utf-16le'; body = data.subarray(2); bom = 2; }
  else if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) { wide = 'utf-16be'; body = data.subarray(2); bom = 2; }
  else if (data.length >= 2 && data[0] === 0x3c && data[1] === 0) wide = 'utf-16le';
  else if (data.length >= 2 && data[0] === 0 && data[1] === 0x3c) wide = 'utf-16be';
  else if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) { body = data.subarray(3); bom = 3; }
  if (wide) {
    const text = strictDecode(wide, body);
    checkDeclaration(text);
    const encoding = declaredEncoding(text);
    if (encoding !== null && ENCNAME.test(encoding)) {
      const name = encoding.toLowerCase();
      if (!NATIVE.has(name)) pyexpat_unknown_encoding(encoding); // may raise the Python exception first
      if (!(name === 'utf-16' || name === wide)) fail('encoding specified in XML declaration is incorrect');
    }
    return { text, unit: 'utf16', bom };
  }
  // (A UTF-8 byte order mark is skipped; a declared 8-bit encoding still applies to the rest, as in expat.)
  const head = body.toString('latin1');
  checkDeclaration(head);
  const encoding = declaredEncoding(head);
  if (encoding === null) return { text: strictDecode('utf-8', body), unit: 'utf8', bom };
  const name = encoding.toLowerCase();
  if (name === 'utf-8') return { text: strictDecode('utf-8', body), unit: 'utf8', bom };
  if (name.startsWith('utf-16') && NATIVE.has(name)) fail('encoding specified in XML declaration is incorrect');
  if (name === 'iso-8859-1') return { text: body.toString('latin1'), unit: 'single', bom };
  if (name === 'us-ascii') {
    if (body.some((byte) => byte > 0x7f)) fail(INVALID);
    return { text: body.toString('latin1'), unit: 'single', bom };
  }
  const map = pyexpat_unknown_encoding(encoding);
  if (map === 'expat-refused') fail('unknown encoding');
  let out = '';
  for (const byte of body) {
    const cp = map[byte];
    if (cp < 0) fail(INVALID);
    out += String.fromCodePoint(cp);
  }
  return { text: out, unit: 'single', bom };
}

// ------------------------------------------------------------------------------------------------ parsing

const PREDEFINED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function codePoint(value) {
  if (!(value === 0x9 || value === 0xa || value === 0xd || (value >= 0x20 && value <= 0xd7ff) ||
        (value >= 0xe000 && value <= 0xfffd) || (value >= 0x10000 && value <= 0x10ffff))) {
    fail('reference to invalid character number');
  }
  return String.fromCodePoint(value);
}

/** Parse "&#...;" / "&#x...;" starting at `pos` (on "&#"); returns [char, nextPos]. Digits are unbounded (R10). */
function charRef(text, pos) {
  let i = pos + 2;
  let hex = false;
  if (text[i] === 'x') { hex = true; i += 1; }
  const digits = hex ? /[0-9a-fA-F]/ : /[0-9]/;
  const start = i;
  while (i < text.length && digits.test(text[i])) i += 1;
  if (i === start || text[i] !== ';') fail(INVALID);
  const literal = text.slice(start, i).replace(/^0+(?=.)/, '');
  const value = literal.length > 8 ? Infinity : parseInt(literal, hex ? 16 : 10);
  return [codePoint(value), i + 1];
}

const collapse = (value) => value.split(' ').filter(Boolean).join(' ');

class Parser {
  constructor(text, { unit = 'utf8', bom = 0 } = {}) {
    this.s = text;
    this.root = text; // the root document text (this.s is swapped while an entity is expanded)
    this.p = 0;
    this.unit = unit; // bytes per character of the input: 'utf8' (variable), 'utf16', 'single'
    this.offsetAt = 0;
    this.offsetBytes = bom;
    this.directBytes = 0;
    this.indirectBytes = 0;
    this.frames = []; // entity texts being expanded in content: {s, p, name, base}
    this.openNames = new Set(); // names of the entities open in content (recursion check)
    this.identity = null;
    this.entities = new Map(); // general entities: name -> {value?, external, notation}
    this.attlists = new Map(); // element raw name -> Map(attribute -> {cdata, value|null})
    this.keepProcessing = true;
    this.hasParamEntityRefs = false;
    this.standalone = false;
    this.scopes = [];
    this.stack = [];
  }

  // ---- low level
  at(literal) { return this.s.startsWith(literal, this.p); }
  eof() { return this.p >= this.s.length; }
  expect(literal, reason = INVALID) {
    if (!this.at(literal)) fail(reason);
    this.p += literal.length;
  }
  skipSpace() { while (this.p < this.s.length && isSpace(this.s[this.p])) this.p += 1; }
  requireSpace(reason = INVALID) {
    if (!isSpace(this.s[this.p] ?? '')) fail(reason);
    this.skipSpace();
  }
  name(reason = INVALID) {
    NAME_AT.lastIndex = this.p;
    const match = NAME_AT.exec(this.s);
    if (!match) fail(reason);
    this.p += match[0].length;
    return match[0];
  }
  qname(reason = 'syntax error') {
    const name = this.name(reason);
    this.split(name, true, reason);
    return name;
  }
  ncname(reason = 'syntax error') {
    const name = this.name(reason);
    if (name.includes(':')) fail(reason);
    return name;
  }
  quoted(reason = INVALID) {
    const quote = this.s[this.p];
    if (quote !== '"' && quote !== "'") fail(reason);
    const end = this.s.indexOf(quote, this.p + 1);
    if (end < 0) fail('unclosed token');
    const value = this.s.slice(this.p + 1, end);
    this.p = end + 1;
    return value;
  }

  // ---- prolog
  xmlDecl() {
    if (!(this.at('<?xml') && (isSpace(this.s[5] ?? '') || this.s.startsWith('?>', 5)))) return;
    this.p = 5;
    const pseudo = (name, required) => {
      const save = this.p;
      if (!isSpace(this.s[this.p] ?? '')) {
        if (required) fail('XML declaration not well-formed');
        return null;
      }
      this.skipSpace();
      if (!this.at(name)) {
        this.p = save;
        if (required) fail('XML declaration not well-formed');
        return null;
      }
      this.p += name.length;
      this.skipSpace();
      this.expect('=', 'XML declaration not well-formed');
      this.skipSpace();
      return this.quoted('XML declaration not well-formed');
    };
    const version = pseudo('version', true);
    if (!/^[A-Za-z0-9_.-]*$/.test(version)) fail('XML declaration not well-formed');
    const encoding = pseudo('encoding', false);
    if (encoding !== null && !ENCNAME.test(encoding)) fail('XML declaration not well-formed');
    const standalone = pseudo('standalone', false);
    if (standalone !== null && standalone !== 'yes' && standalone !== 'no') fail('XML declaration not well-formed');
    this.standalone = standalone === 'yes';
    this.skipSpace();
    this.expect('?>', 'XML declaration not well-formed');
  }

  comment() {
    this.p += 4;
    const dash = this.s.indexOf('--', this.p);
    if (dash < 0) fail('unclosed token');
    if (this.s[dash + 2] !== '>') fail(INVALID);
    this.p = dash + 3;
  }

  processing() {
    this.p += 2;
    const target = this.name();
    if (target.includes(':')) fail(INVALID);
    if (target.toLowerCase() === 'xml') fail('XML or text declaration not at start of entity');
    if (this.at('?>')) { this.p += 2; return; }
    if (!isSpace(this.s[this.p] ?? '')) fail(INVALID);
    const end = this.s.indexOf('?>', this.p);
    if (end < 0) fail('unclosed token');
    this.p = end + 2;
  }

  misc() {
    for (;;) {
      this.skipSpace();
      if (this.at('<!--')) this.comment();
      else if (this.at('<?')) this.processing();
      else return;
    }
  }

  pubid() {
    const value = this.quoted();
    if (!PUBID.test(value)) fail('illegal character(s) in public id');
    return value;
  }

  /** ExternalID after its keyword position; returns true when one was read. publicOnly allows NOTATION's form. */
  externalId({ publicOnly = false } = {}) {
    if (this.at('SYSTEM')) {
      this.p += 6;
      this.requireSpace('syntax error');
      this.quoted('syntax error');
      return true;
    }
    if (this.at('PUBLIC')) {
      this.p += 6;
      this.requireSpace('syntax error');
      this.pubid();
      const save = this.p;
      this.skipSpace();
      if (this.s[this.p] === '"' || this.s[this.p] === "'") {
        if (save === this.p) fail('syntax error');
        this.quoted('syntax error');
      } else {
        this.p = save;
        if (!publicOnly) fail('syntax error');
      }
      return true;
    }
    return false;
  }

  doctype() {
    this.p += 9;
    this.requireSpace('syntax error');
    this.qname(); // a QName in namespace mode
    const save = this.p;
    this.skipSpace();
    let external = false;
    if (this.at('SYSTEM') || this.at('PUBLIC')) {
      if (save === this.p) fail('syntax error');
      external = this.externalId();
      // expat marks the external subset as soon as it sees the system id (it is never read).
      this.hasParamEntityRefs = true;
      this.skipSpace();
    }
    if (this.at('[')) {
      this.p += 1;
      this.internalSubset();
      this.skipSpace();
    }
    this.expect('>', 'syntax error');
    return external;
  }

  internalSubset() {
    for (;;) {
      this.skipSpace();
      if (this.eof()) fail('unclosed token');
      if (this.at(']')) { this.p += 1; return; }
      if (this.at('<!--')) this.comment();
      else if (this.at('<?')) this.processing();
      else if (this.at('<!ENTITY')) this.entityDecl();
      else if (this.at('<!ATTLIST')) this.attlistDecl();
      else if (this.at('<!ELEMENT')) this.elementDecl();
      else if (this.at('<!NOTATION')) this.notationDecl();
      else if (this.at('%')) {
        this.p += 1;
        this.ncname(INVALID);
        this.expect(';');
        this.hasParamEntityRefs = true;
        this.keepProcessing = this.standalone;
      } else fail(this.at('<!') ? INVALID : 'syntax error');
    }
  }

  declEnd() {
    this.skipSpace();
    this.expect('>', 'syntax error');
  }

  entityDecl() {
    this.p += 8;
    this.requireSpace('syntax error');
    let parameter = false;
    if (this.at('%')) {
      this.p += 1;
      this.requireSpace('syntax error');
      parameter = true;
    }
    const name = this.ncname();
    this.requireSpace();
    let entity;
    if (this.s[this.p] === '"' || this.s[this.p] === "'") {
      const raw = this.quoted();
      entity = { value: this.keepProcessing ? this.entityValue(raw) : raw, external: false, notation: null };
    } else {
      if (!this.externalId()) fail('syntax error');
      entity = { value: null, external: true, notation: null };
      const save = this.p;
      this.skipSpace();
      if (this.at('NDATA')) {
        if (save === this.p || parameter) fail('syntax error');
        this.p += 5;
        this.requireSpace('syntax error');
        entity.notation = this.ncname();
      } else {
        this.p = save;
      }
    }
    this.declEnd();
    if (!parameter && this.keepProcessing && !this.entities.has(name)) this.entities.set(name, entity);
  }

  /** EntityValue: character references expanded, general references kept, '%' illegal in the internal subset. */
  entityValue(raw) {
    let out = '';
    for (let i = 0; i < raw.length;) {
      const ch = raw[i];
      if (ch === '%') fail('illegal parameter entity reference');
      if (ch === '&') {
        if (raw[i + 1] === '#') {
          const [char, next] = charRef(raw, i);
          out += char;
          i = next;
        } else {
          NAME_AT.lastIndex = i + 1;
          const match = NAME_AT.exec(raw);
          if (!match || match[0].includes(':') || raw[i + 1 + match[0].length] !== ';') fail(INVALID);
          out += raw.slice(i, i + 2 + match[0].length);
          i += 2 + match[0].length;
        }
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  }

  attlistDecl() {
    this.p += 9;
    this.requireSpace('syntax error');
    const element = this.qname();
    for (;;) {
      const save = this.p;
      this.skipSpace();
      if (this.at('>')) { this.p += 1; return; }
      if (save === this.p) fail('syntax error');
      const attribute = this.qname();
      this.requireSpace('syntax error');
      let cdata = false;
      if (this.at('CDATA')) { this.p += 5; cdata = true; }
      else if (this.at('NOTATION')) {
        this.p += 8;
        this.requireSpace('syntax error');
        this.enumeration(() => this.ncname());
      } else if (this.at('(')) {
        this.enumeration(() => {
          NMTOKEN_AT.lastIndex = this.p;
          const match = NMTOKEN_AT.exec(this.s);
          if (!match) fail('syntax error');
          this.p += match[0].length;
        });
      } else {
        const type = ['IDREFS', 'IDREF', 'ID', 'ENTITY', 'ENTITIES', 'NMTOKENS', 'NMTOKEN'].find((t) => this.at(t) &&
          !new RegExp(`[:${BODY}]`).test(this.s[this.p + t.length] ?? ''));
        if (!type) fail('syntax error');
        this.p += type.length;
      }
      this.requireSpace('syntax error');
      let value = null;
      if (this.at('#REQUIRED')) this.p += 9;
      else if (this.at('#IMPLIED')) this.p += 8;
      else {
        if (this.at('#FIXED')) {
          this.p += 6;
          this.requireSpace('syntax error');
        }
        const raw = this.quoted('syntax error');
        if (this.keepProcessing) value = this.attributeValue(raw, cdata);
      }
      if (!/[\s>]/.test(this.s[this.p] ?? '')) fail('syntax error');
      if (!this.keepProcessing) continue;
      if (!this.attlists.has(element)) this.attlists.set(element, new Map());
      const defs = this.attlists.get(element);
      if (!defs.has(attribute)) defs.set(attribute, { cdata, value });
    }
  }

  enumeration(item) {
    this.expect('(', 'syntax error');
    this.skipSpace();
    item();
    for (;;) {
      this.skipSpace();
      if (this.at(')')) { this.p += 1; return; }
      this.expect('|', 'syntax error');
      this.skipSpace();
      item();
    }
  }

  elementDecl() {
    this.p += 9;
    this.requireSpace('syntax error');
    this.qname();
    this.requireSpace('syntax error');
    if (this.at('EMPTY')) this.p += 5;
    else if (this.at('ANY')) this.p += 3;
    else if (this.at('(')) this.contentModel();
    else fail('syntax error');
    this.declEnd();
  }

  contentModel() {
    // at "("
    const save = this.p;
    this.p += 1;
    this.skipSpace();
    if (this.at('#PCDATA')) {
      this.p += 7;
      this.skipSpace();
      if (this.at(')')) {
        this.p += 1;
        if (this.at('*')) this.p += 1;
        return;
      }
      let names = 0;
      for (;;) {
        this.skipSpace();
        if (this.at(')')) break;
        this.expect('|', 'syntax error');
        this.skipSpace();
        this.qname();
        names += 1;
      }
      this.p += 1;
      if (!this.at('*') && names > 0) fail('syntax error');
      if (this.at('*')) this.p += 1;
      return;
    }
    this.p = save;
    this.children();
  }

  children() {
    // cp ::= (Name | choice | seq) ('?' | '*' | '+')?   (iterative: expat nests groups on the heap, 15000 deep is accepted)
    this.expect('(', 'syntax error');
    const separators = [null]; // the separator chosen by each open group
    for (;;) {
      this.skipSpace();
      if (this.at('(')) {
        this.p += 1;
        separators.push(null);
        continue;
      }
      this.qname();
      if ('?*+'.includes(this.s[this.p] ?? 'x')) this.p += 1;
      for (;;) {
        this.skipSpace();
        if (this.at(')')) {
          this.p += 1;
          if ('?*+'.includes(this.s[this.p] ?? 'x')) this.p += 1;
          separators.pop();
          if (separators.length === 0) return;
          continue; // the closed group is an item of its parent
        }
        const sep = this.s[this.p];
        const current = separators[separators.length - 1];
        if (sep !== '|' && sep !== ',') fail('syntax error');
        if (current !== null && current !== sep) fail('syntax error');
        separators[separators.length - 1] = sep;
        this.p += 1;
        break;
      }
    }
  }

  notationDecl() {
    this.p += 10;
    this.requireSpace('syntax error');
    this.ncname();
    this.requireSpace('syntax error');
    if (!this.externalId({ publicOnly: true })) fail('syntax error');
    this.declEnd();
  }

  // ---- entities and attribute values
  /**
   * Expat's billion-laughs accounting (xmlparse.c accountingDiffTolerated, defaults of Expat 2.7.1: threshold 8 MiB,
   * factor 100). "Direct" bytes are the INPUT bytes of the root document consumed so far (tokens, in the document's own
   * encoding); "indirect" bytes are the UTF-8 bytes of every entity replacement text expanded so far (each token of the
   * text, nested references included, is counted when it is processed). The check runs after each addition:
   * tolerated when (direct + indirect) < threshold or the float32 ratio (direct + indirect) / direct <= 100.
   * A reference met inside an entity is measured against the root position saved when the outermost expansion started.
   */
  account(text, nested) {
    if (!nested) this.directBytes = this.rootOffset();
    this.indirectBytes += Buffer.byteLength(text, 'utf8');
    const total = this.directBytes + this.indirectBytes;
    if (total >= AMPLIFICATION_THRESHOLD) {
      const factor = Math.fround(Math.fround(total) / Math.fround(this.directBytes));
      if (factor > AMPLIFICATION_FACTOR) fail('limit on input amplification factor (from DTD and entities) breached');
    }
  }

  /** Input bytes of the root document before position this.p (incremental: the root position only moves forward). */
  rootOffset() {
    const text = this.root;
    const end = this.p;
    if (this.unit === 'single') this.offsetBytes += end - this.offsetAt;
    else if (this.unit === 'utf16') this.offsetBytes += 2 * (end - this.offsetAt);
    else {
      for (let i = this.offsetAt; i < end; i += 1) {
        const c = text.charCodeAt(i);
        if (c < 0x80) this.offsetBytes += 1;
        else if (c < 0x800) this.offsetBytes += 2;
        else if (c >= 0xd800 && c <= 0xdbff) this.offsetBytes += 4; // a pair counts once, on its high half
        else if (c >= 0xdc00 && c <= 0xdfff) this.offsetBytes += 0;
        else this.offsetBytes += 3;
      }
    }
    this.offsetAt = end;
    return this.offsetBytes;
  }

  /**
   * The value of an attribute literal (document text or an entity's replacement text), normalised. Entity expansion uses
   * an explicit stack (10,000 nested entities are valid input).
   */
  attributeValue(raw, cdata = true) {
    let out = '';
    const names = new Set();
    const stack = []; // saved [raw, i, name] of the texts being expanded
    let i = 0;
    for (;;) {
      if (i >= raw.length) {
        if (stack.length === 0) break;
        const [savedRaw, savedI, name] = stack.pop();
        names.delete(name);
        raw = savedRaw;
        i = savedI;
        continue;
      }
      const ch = raw[i];
      if (ch === '<') fail(INVALID);
      if (ch === '&') {
        if (raw[i + 1] === '#') {
          const [char, next] = charRef(raw, i);
          out += char;
          i = next;
          continue;
        }
        NAME_AT.lastIndex = i + 1;
        const match = NAME_AT.exec(raw);
        if (!match || match[0].includes(':') || raw[i + 1 + match[0].length] !== ';') fail(INVALID);
        i += 2 + match[0].length;
        const name = match[0];
        if (Object.hasOwn(PREDEFINED, name)) { out += PREDEFINED[name]; continue; }
        const entity = this.entities.get(name);
        if (!this.hasParamEntityRefs || this.standalone) {
          if (!entity) fail('undefined entity');
        } else if (!entity) {
          continue;
        }
        if (names.has(name) || this.openNames.has(name)) fail('recursive entity reference');
        if (entity.notation !== null) fail('reference to binary entity');
        if (entity.external) fail('reference to external entity in attribute');
        this.account(entity.value, this.frames.length > 0 || stack.length > 0);
        names.add(name);
        stack.push([raw, i, name]);
        raw = entity.value;
        i = 0;
        continue;
      }
      out += ch === '\t' || ch === '\n' || ch === '\r' ? ' ' : ch;
      i += 1;
    }
    return cdata ? out : collapse(out);
  }

  // ---- elements
  lookup(prefix) {
    if (prefix === 'xml') return XML_NS;
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) if (this.scopes[i].has(prefix)) return this.scopes[i].get(prefix);
    return undefined;
  }

  /**
   * Split a QName. In tags expat requires NCName parts; names inside DTD declarations only need a name-start
   * prefix and NameChars after the colon (lenient), e.g. <!ATTLIST a x:-y ...> is accepted.
   */
  split(name, lenient = false, reason = INVALID) {
    const colon = name.indexOf(':');
    if (colon < 0) return [null, name];
    const prefix = name.slice(0, colon);
    const local = name.slice(colon + 1);
    if (!NCNAME.test(prefix) || !(lenient ? NCLOCAL : NCNAME).test(local)) fail(reason);
    return [prefix, local];
  }

  startTag() {
    this.p += 1;
    const name = this.name();
    this.split(name);
    const specified = [];
    for (;;) {
      const before = this.p;
      this.skipSpace();
      if (this.at('/>')) { this.p += 2; return this.finishStart(name, specified, true); }
      if (this.at('>')) { this.p += 1; return this.finishStart(name, specified, false); }
      if (this.p === before) fail(INVALID);
      const attribute = this.name();
      this.split(attribute);
      this.skipSpace();
      this.expect('=');
      this.skipSpace();
      const quote = this.s[this.p];
      if (quote !== '"' && quote !== "'") fail(INVALID);
      const end = this.s.indexOf(quote, this.p + 1);
      if (end < 0) fail('unclosed token');
      const raw = this.s.slice(this.p + 1, end);
      this.p = end + 1;
      specified.push([attribute, raw]);
    }
  }

  finishStart(name, specified, empty) {
    const defs = this.attlists.get(name) ?? new Map();
    const seen = new Set();
    const attributes = [];
    for (const [attribute, raw] of specified) {
      if (seen.has(attribute)) fail('duplicate attribute');
      seen.add(attribute);
      const def = defs.get(attribute);
      attributes.push([attribute, this.attributeValue(raw, def ? def.cdata : true)]);
    }
    for (const [attribute, def] of defs) {
      if (!seen.has(attribute) && def.value !== null) attributes.push([attribute, def.value]);
    }
    const [prefix, local] = this.split(name, true);
    const bindings = new Map();
    const plain = [];
    for (const [attribute, value] of attributes) {
      if (attribute === 'xmlns' || attribute.startsWith('xmlns:')) {
        const bound = attribute === 'xmlns' ? '' : attribute.slice(6);
        if (attribute !== 'xmlns' && !NCNAME.test(bound)) fail(INVALID);
        if (bound === 'xmlns') fail('reserved prefix (xmlns) must not be declared or undeclared');
        if (bound === 'xml') {
          if (value !== XML_NS) fail('reserved prefix (xml) must not be undeclared or bound to another namespace name');
        } else if (value === XML_NS || value === XMLNS_NS) {
          fail('prefix must not be bound to one of the reserved namespace names');
        }
        if (bound !== '' && value === '') fail('must not undeclare prefix');
        bindings.set(bound, value);
      } else {
        plain.push([attribute, value]);
      }
    }
    this.scopes.push(bindings);
    if (prefix !== null && this.lookup(prefix) === undefined) fail('unbound prefix');
    const expanded = new Set();
    const unprefixed = new Map();
    for (const [attribute, value] of plain) {
      const [aprefix, alocal] = this.split(attribute, true);
      if (aprefix === null) {
        unprefixed.set(attribute, value);
      } else {
        const uri = this.lookup(aprefix);
        if (uri === undefined) fail('unbound prefix');
        const key = `${uri}|${alocal}`;
        if (expanded.has(key)) fail('duplicate attribute');
        expanded.add(key);
      }
    }
    if (this.identity === null && local === 'Identity') this.identity = unprefixed;
    if (empty) this.scopes.pop();
    else this.stack.push(name);
    return empty;
  }

  endTag(base) {
    this.p += 2;
    const closing = this.name();
    this.skipSpace();
    this.expect('>');
    if (this.stack.length <= base) fail('asynchronous entity');
    const expected = this.stack.pop();
    if (closing !== expected) fail('mismatched tag');
    this.scopes.pop();
  }

  /** A reference in content. Returns the entity to expand (a frame is pushed by content()), or null when it is done. */
  contentReference() {
    if (this.s[this.p + 1] === '#') {
      [, this.p] = charRef(this.s, this.p);
      return null;
    }
    NAME_AT.lastIndex = this.p + 1;
    const match = NAME_AT.exec(this.s);
    if (!match || match[0].includes(':') || this.s[this.p + 1 + match[0].length] !== ';') fail(INVALID);
    this.p += 2 + match[0].length;
    const name = match[0];
    if (Object.hasOwn(PREDEFINED, name)) return null;
    const entity = this.entities.get(name);
    // Undefined, external parsed entities and skipped references all end in ElementTree's "undefined entity".
    if (!entity || (entity.external && entity.notation === null)) fail('undefined entity');
    if (this.openNames.has(name)) fail('recursive entity reference');
    if (entity.notation !== null) fail('reference to binary entity');
    this.account(entity.value, this.frames.length > 0);
    return { name, entity };
  }

  /**
   * Parse content until the document element closes. Entity replacement text is parsed on an explicit frame stack
   * (expat nests entities on the heap; 10,000 levels are valid), each frame saving the text and position it interrupts.
   */
  content() {
    let base = 0; // element depth the current text (document or entity) must return to
    for (;;) {
      const inEntity = this.frames.length > 0;
      if (this.eof()) {
        if (!inEntity) fail('no element found');
        if (this.stack.length !== base) fail('asynchronous entity');
        const frame = this.frames.pop();
        this.openNames.delete(frame.name);
        this.s = frame.s;
        this.p = frame.p;
        base = frame.base;
        continue;
      }
      const ch = this.s[this.p];
      if (ch === '<') {
        if (this.at('</')) {
          this.endTag(base);
          if (!inEntity && this.stack.length === base) return;
        } else if (this.at('<!--')) {
          this.comment();
        } else if (this.at('<![CDATA[')) {
          const end = this.s.indexOf(']]>', this.p + 9);
          if (end < 0) fail('unclosed CDATA section');
          this.p = end + 3;
        } else if (this.at('<?')) {
          this.processing();
        } else {
          this.startTag();
        }
      } else if (ch === '&') {
        const reference = this.contentReference();
        if (reference !== null) {
          this.frames.push({ s: this.s, p: this.p, name: reference.name, base });
          this.openNames.add(reference.name);
          this.s = reference.entity.value;
          this.p = 0;
          base = this.stack.length;
        }
      } else if (ch === ']' && this.at(']]>')) {
        fail(INVALID);
      } else {
        this.p += 1;
      }
    }
  }

  document() {
    if (INVALID_CHAR.test(this.s)) fail(INVALID);
    // XML line-end normalisation (expat does it before anything else sees the text).
    this.s = this.s.replace(/\r\n?/g, '\n');
    this.xmlDecl();
    this.misc();
    if (this.at('<!DOCTYPE')) {
      this.doctype();
      this.misc();
    }
    if (this.eof()) fail('no element found');
    if (this.s[this.p] !== '<' || this.at('<!') || this.at('</')) fail(this.at('<!') ? 'syntax error' : INVALID);
    const empty = this.startTag();
    if (!empty) this.content();
    this.misc();
    if (!this.eof()) fail('junk after document element');
    return { identity: this.identity };
  }
}

/**
 * Parse decoded `text`. Returns { identity } with the un-prefixed attributes (Map) of the first element whose local
 * name is `Identity`, or null. Throws XmlParseError where ElementTree raises ParseError.
 */
export function parseDocument(text, meta) {
  return new Parser(text, meta).document();
}

/** ET.parse(path).getroot() reduced to what _appx_identity needs. */
export function parseAppxManifest(bytes) {
  const { text, unit, bom } = decodeWithMeta(bytes);
  return parseDocument(text, { unit, bom });
}
