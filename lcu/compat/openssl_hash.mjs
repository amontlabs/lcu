// OpenSSL's X509_subject_name_hash (the `<hash>.0` file names of a certificate directory, `openssl x509 -subject_hash`)
// for a PEM certificate, on Node built-ins. It is the SHA-1 of the canonical encoding of the subject name (every
// string attribute converted to UTF-8, lower-cased ASCII, leading/trailing white space dropped, inner white space runs
// collapsed to one space, re-encoded as UTF8String; RDN sets sorted as DER does), first four digest bytes read
// little-endian, printed as eight lower-case hex digits.
import crypto from 'node:crypto';

function tlv(buf, pos) {
  const tag = buf[pos];
  let length = buf[pos + 1], at = pos + 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + buf[at + i];
    at += n;
  }
  if (at + length > buf.length) throw new Error('malformed DER');
  return { tag, start: at, end: at + length, next: at + length, raw: buf.subarray(pos, at + length) };
}

const encodeLength = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const encode = (tag, content) => Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);

// ASN.1 string types that are canonicalised (UTF8, Printable, T61, IA5, Visible, BMP, Universal).
const CANON_TAGS = new Set([0x0c, 0x13, 0x14, 0x16, 0x1a, 0x1e, 0x1c]);

function toUtf8(tag, content) {
  if (tag === 0x0c) return Buffer.from(content);
  if (tag === 0x1e) { // BMPString: UTF-16BE
    const swapped = Buffer.from(content);
    swapped.swap16();
    return Buffer.from(swapped.toString('utf16le'), 'utf8');
  }
  if (tag === 0x1c) { // UniversalString: UTF-32BE
    let text = '';
    for (let i = 0; i + 3 < content.length; i += 4) text += String.fromCodePoint(content.readUInt32BE(i));
    return Buffer.from(text, 'utf8');
  }
  return Buffer.from(content.toString('latin1'), 'utf8'); // single-byte string types are read as ISO 8859-1
}

const isSpace = (b) => b === 0x20 || (b >= 0x09 && b <= 0x0d);

function canonString(bytes) {
  let from = 0, to = bytes.length;
  while (from < to && bytes[from] < 0x80 && isSpace(bytes[from])) from++;
  while (to > from && bytes[to - 1] < 0x80 && isSpace(bytes[to - 1])) to--;
  const out = [];
  for (let i = from; i < to;) {
    const b = bytes[i];
    if (b & 0x80) { out.push(b); i++; } else if (isSpace(b)) {
      out.push(0x20);
      while (i < to && bytes[i] < 0x80 && isSpace(bytes[i])) i++;
    } else { out.push(b >= 0x41 && b <= 0x5a ? b + 32 : b); i++; }
  }
  return Buffer.from(out);
}

/** The canonical re-encoding of a DER Name (concatenated RDN sets), as OpenSSL hashes it. */
function canonicalName(der, nameStart, nameEnd) {
  const sets = [];
  for (let pos = nameStart; pos < nameEnd;) {
    const set = tlv(der, pos);
    const entries = [];
    for (let at = set.start; at < set.end;) {
      const ava = tlv(der, at);
      const oid = tlv(der, ava.start);
      const value = tlv(der, oid.next);
      const content = der.subarray(value.start, value.end);
      const canonValue = CANON_TAGS.has(value.tag) ? encode(0x0c, canonString(toUtf8(value.tag, content))) : value.raw;
      entries.push(encode(0x30, Buffer.concat([oid.raw, canonValue])));
      at = ava.next;
    }
    entries.sort(Buffer.compare); // SET OF is encoded in DER order
    sets.push(encode(0x31, Buffer.concat(entries)));
    pos = set.next;
  }
  return Buffer.concat(sets);
}

/** `openssl x509 -subject_hash` of a PEM certificate: eight lower-case hex digits. Throws for unparsable input. */
export function subjectHash(pem) {
  const der = new crypto.X509Certificate(pem).raw;
  const certificate = tlv(der, 0);
  const tbs = tlv(der, certificate.start);
  let item = tlv(der, tbs.start);
  if (item.tag === 0xa0) item = tlv(der, item.next); // version
  // item is the serial number: skip serial, signature algorithm, issuer, validity
  for (let i = 0; i < 4; i++) item = tlv(der, item.next);
  const digest = crypto.createHash('sha1').update(canonicalName(der, item.start, item.end)).digest();
  return digest.readUInt32LE(0).toString(16).padStart(8, '0');
}
