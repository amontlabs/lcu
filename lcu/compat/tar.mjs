// .tar.gz reading and extraction with the semantics of Python 3.12
// `tarfile.open(path, 'r:gz')` + `extractall(dest, members, filter='data')` (POSIX), plus the
// pre-checks of lcu/update_apply.py `_extract_tar` (see extractLcuTar).
//
// Built-ins only (plus compat/inflate.mjs). Reproduced from CPython 3.12.10 (review F03/F07/F09/F11):
//  * the archive is a gzip.GzipFile behind a BufferedReader (compat/inflate.mjs): tar headers and member data are
//    inflated only as far as tarfile asks, 8 KiB raw reads, 128 KiB input chunks, forward seeks read and discard,
//    the single backward seek (getmembers -> first extraction) rewinds the file like DecompressReader.seek. Data
//    behind the end-of-archive blocks is never inflated, so a corrupt or huge unused tail neither fails extraction nor
//    costs memory. Truncation raises EOFError, a corrupt deflate stream zlib.error (class name "error") except where
//    TarFile.next() wraps it into ReadError('zlib error: ...'), gzip trailer problems BadGzipFile, exactly where
//    CPython raises them;
//  * member names, link names and PAX values keep a leading U+FEFF (no BOM stripping);
//  * PAX numeric fields use Python's int()/float() grammar (nan, inf, underscores, whitespace); os.utime failures
//    are classified like CPython (OSError -> ExtractError, ignored at errorlevel 1; NaN -> ValueError; out-of-range
//    or infinite -> OverflowError, both propagate);
//  * a NUL in a member path is ValueError ('lstat: embedded null character in path') from the realpath seam.
//
// Documented, deliberate differences from CPython (not parity claims):
//  * GNU sparse: old-format 'S' members are supported; PAX GNU.sparse.* members (0.0/0.1/1.0) are rejected with a
//    ReadError ("GNU sparse members are not supported"); CPython extracts them. LCU's release builder never produces
//    sparse members, so a release using them cannot be installed through this updater.
//  * Names that are not UTF-8 keep their raw bytes (surrogateescape, as CPython; fs calls get the byte Buffer): a
//    filesystem that refuses them (APFS) fails with the same OSError, one that accepts them stores the same bytes.
//  * Ownership is never changed (the data filter clears uid/gid/uname/gname; root-only chown is a no-op with -1/-1).
//  * Only gzip (r:gz) is supported; bzip2/xz tarballs are not read.
//  * Negative mtimes are applied with millisecond precision.
//  * Platform: POSIX (Windows installs use the zip path).
import fs from 'node:fs';
import { PyOSError, pyfs, pyRepr, toPyOSError, ValueError, OverflowError } from './errors.mjs';
import * as P from './pypath.mjs';
import { pyInt, pyFloat } from './pynum.mjs';
import { GzipFile, openSource, EOFError, ZlibError, BadGzipFile } from './inflate.mjs';

export { EOFError, ZlibError, BadGzipFile };

// ---------------------------------------------------------------- errors
export class TarError extends Error { constructor(m) { super(m); this.name = 'TarError'; } }
export class ReadError extends TarError { constructor(m) { super(m); this.name = 'ReadError'; } }
export class ExtractError extends TarError { constructor(m) { super(m); this.name = 'ExtractError'; } }
export class FilterError extends TarError { constructor(m, tarinfo) { super(m); this.name = 'FilterError'; this.tarinfo = tarinfo; } }
export class AbsolutePathError extends FilterError {
  constructor(t) { super(`member ${pyRepr(t.name)} has an absolute path`, t); this.name = 'AbsolutePathError'; }
}
export class OutsideDestinationError extends FilterError {
  constructor(t, path) { super(`${pyRepr(t.name)} would be extracted to ${pyRepr(path)}, which is outside the destination`, t); this.name = 'OutsideDestinationError'; }
}
export class SpecialFileError extends FilterError {
  constructor(t) { super(`${pyRepr(t.name)} is a special file`, t); this.name = 'SpecialFileError'; }
}
export class AbsoluteLinkError extends FilterError {
  constructor(t) { super(`${pyRepr(t.name)} is a link to an absolute path`, t); this.name = 'AbsoluteLinkError'; }
}
export class LinkOutsideDestinationError extends FilterError {
  constructor(t, path) { super(`${pyRepr(t.name)} would link to ${pyRepr(path)}, which is outside the destination`, t); this.name = 'LinkOutsideDestinationError'; }
}
/** Python KeyError (str() form is the repr of the message). */
export class PyKeyError extends Error {
  constructor(m) { super(pyRepr(m)); this.name = 'KeyError'; }
}
/** A header problem; internal. */
class HeaderError extends Error { constructor(m, kind) { super(m); this.kind = kind; } }

const BLOCKSIZE = 512;
const T = {
  REG: '0', AREG: '\0', LNK: '1', SYM: '2', CHR: '3', BLK: '4', DIR: '5', FIFO: '6', CONT: '7',
  LONGNAME: 'L', LONGLINK: 'K', SPARSE: 'S', XHD: 'x', XGL: 'g', SOLARIS_XHD: 'X',
};
const REGULAR_TYPES = new Set([T.REG, T.AREG, T.CONT, T.SPARSE]);
const GNU_TYPES = new Set([T.LONGNAME, T.LONGLINK, T.SPARSE]);
const SUPPORTED_TYPES = new Set([T.REG, T.AREG, T.LNK, T.SYM, T.DIR, T.CHR, T.BLK, T.FIFO, T.CONT,
  T.LONGNAME, T.LONGLINK, T.SPARSE]);
const PAX_NAME_FIELDS = new Set(['path', 'linkpath', 'uname', 'gname']);
const PAX_FIELDS = new Set(['path', 'linkpath', 'size', 'mtime', 'uid', 'gid', 'uname', 'gname']);

// A leading U+FEFF belongs to the name (bytes.decode('utf-8') keeps it): never strip a BOM.
const utf8strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * bytes.decode('utf-8', 'surrogateescape'): valid UTF-8 as itself, every byte of an invalid sequence as the lone
 * surrogate U+DC00+byte (what tarfile does for names, so the raw bytes survive until os.fsencode).
 */
export function decodeSurrogateescape(buf) {
  try { return utf8strict.decode(buf); } catch { /* escape the invalid bytes below */ }
  let out = '';
  for (let i = 0; i < buf.length;) {
    const b = buf[i];
    if (b < 0x80) { out += String.fromCharCode(b); i++; continue; }
    const need = b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    let k = 1;
    let valid = need > 0;
    for (; valid && k < need; k++) {
      if (i + k >= buf.length) { valid = false; break; }
      const c = buf[i + k];
      let lo = 0x80, hi = 0xbf;
      if (k === 1) { // the first continuation byte has a narrower range for some lead bytes
        if (b === 0xe0) lo = 0xa0; else if (b === 0xed) hi = 0x9f; else if (b === 0xf0) lo = 0x90; else if (b === 0xf4) hi = 0x8f;
      }
      if (c < lo || c > hi) { valid = false; break; }
    }
    if (valid) { out += utf8.decode(buf.subarray(i, i + need)); i += need; } else {
      for (let j = 0; j < k; j++) out += String.fromCharCode(0xdc00 + buf[i + j]);
      i += k;
    }
  }
  return out;
}

function nts(buf) {
  const p = buf.indexOf(0);
  return decodeSurrogateescape(p === -1 ? buf : buf.subarray(0, p));
}

function nti(buf) {
  if (buf[0] === 0o200 || buf[0] === 0o377) {
    let n = 0n;
    for (let i = 0; i < buf.length - 1; i++) n = (n << 8n) + BigInt(buf[i + 1]);
    if (buf[0] === 0o377) n = -(256n ** BigInt(buf.length - 1) - n);
    return Number(n);
  }
  const p = buf.indexOf(0);
  const raw = p === -1 ? buf : buf.subarray(0, p);
  for (const byte of raw) if (byte > 127) throw new HeaderError('invalid header', 'invalid');
  const text = Buffer.from(raw).toString('latin1').replace(/^[\t\n\v\f\r \x1c-\x1f]+|[\t\n\v\f\r \x1c-\x1f]+$/g, '') || '0';
  if (!/^[+-]?(0[oO])?[0-7]+(_[0-7]+)*$/.test(text)) throw new HeaderError('invalid header', 'invalid');
  const neg = text.startsWith('-');
  const digits = text.replace(/^[+-]/, '').replace(/^0[oO]/, '').replace(/_/g, '');
  const n = parseInt(digits, 8);
  return neg ? -n : n;
}

function calcChksums(buf) {
  let unsigned = 256, signed = 256;
  for (let i = 0; i < BLOCKSIZE; i++) {
    if (i >= 148 && i < 156) continue;
    unsigned += buf[i];
    signed += buf[i] > 127 ? buf[i] - 256 : buf[i];
  }
  return [unsigned, signed];
}

const block = (count) => Math.ceil(count / BLOCKSIZE) * BLOCKSIZE;

// ---------------------------------------------------------------- Python number grammar
/** int(text) or 0 when Python's int() raises ValueError (tarfile.PAX_NUMBER_FIELDS). */
const pyIntOrZero = (text) => { const n = pyInt(text); return n === null ? 0 : Number(n); };
/** float(text) or 0 when Python's float() raises ValueError. */
const pyFloatOrZero = (text) => { const x = pyFloat(text); return x === null ? 0 : x; };

// ---------------------------------------------------------------- TarInfo
export class TarInfo {
  constructor() {
    this.name = ''; this.mode = 0o644; this.uid = 0; this.gid = 0; this.size = 0; this.mtime = 0;
    this.type = T.REG; this.linkname = ''; this.uname = ''; this.gname = ''; this.devmajor = 0; this.devminor = 0;
    this.offset = 0; this.offsetData = 0; this.sparse = null; this.paxHeaders = {};
  }
  get path() { return this.name; }
  isreg() { return REGULAR_TYPES.has(this.type); }
  isfile() { return this.isreg(); }
  isdir() { return this.type === T.DIR; }
  issym() { return this.type === T.SYM; }
  islnk() { return this.type === T.LNK; }
  ischr() { return this.type === T.CHR; }
  isblk() { return this.type === T.BLK; }
  isfifo() { return this.type === T.FIFO; }
  isdev() { return this.type === T.CHR || this.type === T.BLK || this.type === T.FIFO; }
  replace(attrs) { return Object.assign(Object.create(TarInfo.prototype), this, attrs); }
}

// ---------------------------------------------------------------- archive
export class TarArchive {
  /** `fileobj`: a GzipFile (read(n), seek(position), tell()). */
  constructor(fileobj) {
    this.fileobj = fileobj;
    this.offset = 0; this.members = []; this.loaded = false; this.paxHeaders = {};
    try {
      this.firstmember = this.nextMember();
    } catch (err) {
      this.close();
      throw err;
    }
  }

  close() { this.fileobj.close?.(); }

  read(n) { return this.fileobj.read(n); }

  /** TarFile.next() as called by TarFile.__init__ (the first member of a gzip file: OSError means "not a gzip file"). */
  nextMember() {
    try {
      return this.next();
    } catch (err) {
      if (err?.isOSError) throw new ReadError('not a gzip file');
      throw err;
    }
  }

  fromtarfile() {
    const buf = this.read(BLOCKSIZE);
    const obj = this.frombuf(buf);
    obj.offset = this.fileobj.tell() - BLOCKSIZE;
    return this.procMember(obj);
  }

  frombuf(buf) {
    if (buf.length === 0) throw new HeaderError('empty header', 'empty');
    if (buf.length !== BLOCKSIZE) throw new HeaderError('truncated header', 'truncated');
    if (!buf.some((b) => b !== 0)) throw new HeaderError('end of file header', 'eof');
    const chksum = nti(buf.subarray(148, 156));
    if (!calcChksums(buf).includes(chksum)) throw new HeaderError('bad checksum', 'invalid');
    const obj = new TarInfo();
    obj.name = nts(buf.subarray(0, 100));
    obj.mode = nti(buf.subarray(100, 108));
    obj.uid = nti(buf.subarray(108, 116));
    obj.gid = nti(buf.subarray(116, 124));
    obj.size = nti(buf.subarray(124, 136));
    obj.mtime = nti(buf.subarray(136, 148));
    obj.chksum = chksum;
    obj.type = String.fromCharCode(buf[156]);
    obj.linkname = nts(buf.subarray(157, 257));
    obj.uname = nts(buf.subarray(265, 297));
    obj.gname = nts(buf.subarray(297, 329));
    obj.devmajor = nti(buf.subarray(329, 337));
    obj.devminor = nti(buf.subarray(337, 345));
    const prefix = nts(buf.subarray(345, 500));
    if (obj.type === T.AREG && obj.name.endsWith('/')) obj.type = T.DIR;
    if (obj.type === T.SPARSE) {
      let sp = 386;
      const structs = [];
      for (let i = 0; i < 4; i++) {
        let offset, numbytes;
        try { offset = nti(buf.subarray(sp, sp + 12)); numbytes = nti(buf.subarray(sp + 12, sp + 24)); } catch (e) {
          if (e instanceof HeaderError) break;
          throw e;
        }
        structs.push([offset, numbytes]);
        sp += 24;
      }
      obj.sparseStructs = [structs, Boolean(buf[482]), nti(buf.subarray(483, 495))];
    }
    if (obj.isdir()) obj.name = obj.name.replace(/\/+$/, '');
    if (prefix && !GNU_TYPES.has(obj.type)) obj.name = prefix + '/' + obj.name;
    return obj;
  }

  procMember(obj) {
    if (obj.type === T.LONGNAME || obj.type === T.LONGLINK) return this.procGnuLong(obj);
    if (obj.type === T.SPARSE) return this.procSparse(obj);
    if (obj.type === T.XHD || obj.type === T.XGL || obj.type === T.SOLARIS_XHD) return this.procPax(obj);
    return this.procBuiltin(obj);
  }

  procBuiltin(obj) {
    obj.offsetData = this.fileobj.tell();
    let offset = obj.offsetData;
    if (obj.isreg() || !SUPPORTED_TYPES.has(obj.type)) offset += block(obj.size);
    this.offset = offset;
    this.applyPax(obj, this.paxHeaders);
    if (obj.isdir()) obj.name = obj.name.replace(/\/+$/, '');
    return obj;
  }

  subsequent() {
    try { return this.fromtarfile(); } catch (err) {
      if (err instanceof HeaderError) throw new ReadError(err.message);
      throw err;
    }
  }

  procGnuLong(obj) {
    const buf = this.read(block(obj.size));
    const next = this.subsequent();
    next.offset = obj.offset;
    if (obj.type === T.LONGNAME) next.name = nts(buf);
    else next.linkname = nts(buf);
    if (next.isdir() && next.name.endsWith('/')) next.name = next.name.slice(0, -1);
    return next;
  }

  procSparse(obj) {
    let [structs, isextended, origsize] = obj.sparseStructs;
    delete obj.sparseStructs;
    while (isextended) {
      const buf = this.read(BLOCKSIZE);
      let sp = 0;
      for (let i = 0; i < 21; i++) {
        let offset, numbytes;
        try { offset = nti(buf.subarray(sp, sp + 12)); numbytes = nti(buf.subarray(sp + 12, sp + 24)); } catch (e) {
          if (e instanceof HeaderError) break;
          throw e;
        }
        if (offset && numbytes) structs.push([offset, numbytes]);
        sp += 24;
      }
      isextended = Boolean(buf[504]);
    }
    obj.sparse = structs;
    obj.offsetData = this.fileobj.tell();
    this.offset = obj.offsetData + block(obj.size);
    obj.size = origsize;
    return obj;
  }

  procPax(obj) {
    const buf = this.read(block(obj.size));
    const paxHeaders = obj.type === T.XGL ? this.paxHeaders : { ...this.paxHeaders };
    let pos = 0, hdrEncoding = null;
    const raw = [];
    const invalid = () => new ReadError('invalid header');
    while (buf.length > pos && buf[pos] !== 0) {
      const m = /^([0-9]{1,20}) /.exec(buf.toString('latin1', pos, Math.min(buf.length, pos + 22)));
      if (!m) throw invalid();
      const length = parseInt(m[1], 10);
      if (length < 5 || pos + length > buf.length) throw invalid();
      const end = pos + length - 1;
      const kv = buf.subarray(pos + m[1].length + 1, end);
      const eq = kv.indexOf(0x3d);
      if (eq <= 0 || buf[end] !== 0x0a) throw invalid();
      const key = kv.subarray(0, eq), value = kv.subarray(eq + 1);
      raw.push([key, value]);
      if (key.toString('latin1') === 'hdrcharset' && hdrEncoding === null) {
        hdrEncoding = value.toString('latin1') === 'BINARY' ? 'binary' : 'utf-8';
      }
      pos += length;
    }
    const decode = (b) => { try { return utf8strict.decode(b); } catch { return decodeSurrogateescape(b); } };
    for (const [k, v] of raw) paxHeaders[decode(k)] = decode(v);
    let next;
    try { next = this.fromtarfile(); } catch (err) {
      if (err instanceof HeaderError) throw new ReadError(err.message);
      throw err;
    }
    if (Object.keys(paxHeaders).some((k) => k.startsWith('GNU.sparse.'))) {
      throw new ReadError('GNU sparse members are not supported');
    }
    if (obj.type === T.XHD || obj.type === T.SOLARIS_XHD) {
      this.applyPax(next, paxHeaders);
      next.offset = obj.offset;
      if ('size' in paxHeaders) {
        let offset = next.offsetData;
        if (next.isreg() || !SUPPORTED_TYPES.has(next.type)) offset += block(next.size);
        this.offset = offset;
      }
    }
    return next;
  }

  applyPax(obj, headers) {
    for (const [keyword, value0] of Object.entries(headers)) {
      if (!PAX_FIELDS.has(keyword)) continue;
      let value = value0;
      if (keyword === 'size' || keyword === 'uid' || keyword === 'gid') {
        value = pyIntOrZero(value0);
      } else if (keyword === 'mtime') {
        value = pyFloatOrZero(value0);
      }
      if (keyword === 'path') { obj.name = value.replace(/\/+$/, ''); } else if (keyword === 'linkpath') obj.linkname = value;
      else obj[keyword] = value;
    }
    obj.paxHeaders = { ...headers };
  }

  next() {
    if (this.firstmember !== undefined && this.firstmember !== null) {
      const m = this.firstmember; this.firstmember = null; return m;
    }
    // Advance the file pointer (a decompressing seek; its errors are not wrapped, as in CPython).
    if (this.offset !== this.fileobj.tell()) {
      if (this.offset === 0) return null;
      // A PAX `size` can push the offset past what the (gzip) file object's seek takes: BufferedReader.seek raises
      // ValueError for an int that does not fit an offset (4300 digits is the longest int() accepts).
      if (!(this.offset - 1 < 2 ** 63 && this.offset - 1 >= -(2 ** 63))) {
        throw new ValueError("cannot fit 'int' into an offset-sized integer");
      }
      this.fileobj.seek(this.offset - 1);
      if (this.fileobj.read(1).length === 0) throw new ReadError('unexpected end of data');
    }
    let tarinfo = null;
    try {
      tarinfo = this.fromtarfile();
    } catch (err) {
      if (err instanceof ZlibError) throw new ReadError(`zlib error: ${err.message}`);
      if (!(err instanceof HeaderError)) throw err;
      if (err.kind === 'invalid' && this.offset === 0) throw new ReadError(err.message);
      if (err.kind === 'empty' && this.offset === 0) throw new ReadError('empty file');
      if (err.kind === 'truncated' && this.offset === 0) throw new ReadError(err.message);
      // otherwise: end of archive
    }
    if (tarinfo !== null) this.members.push(tarinfo); else this.loaded = true;
    return tarinfo;
  }

  getmembers() {
    if (!this.loaded) { while (this.next() !== null); this.loaded = true; }
    return this.members;
  }

  /** TarFile._find_link_target for a hard link (search members before `tarinfo`) or symlink. */
  findLinkTarget(tarinfo) {
    const members = this.getmembers();
    let linkname, limit;
    if (tarinfo.issym()) {
      linkname = [P.dirname(tarinfo.name), tarinfo.linkname].filter(Boolean).join('/');
      limit = members.length;
    } else {
      linkname = tarinfo.linkname;
      limit = members.findIndex((m) => m.offset === tarinfo.offset);
      if (limit < 0) limit = members.length;
    }
    const want = P.normpath(linkname);
    for (let i = limit - 1; i >= 0; i--) if (P.normpath(members[i].name) === want) return members[i];
    throw new PyKeyError(`linkname ${pyRepr(linkname)} not found`);
  }
}

/** tarfile.open(path, 'r:gz'): `source` is a path or a Buffer. Call close() on the result when done with it. */
export function openTarGz(source) {
  return new TarArchive(new GzipFile(openSource(Buffer.isBuffer(source) ? source : String(source))));
}

// ---------------------------------------------------------------- data filter
/** tarfile.data_filter: returns the filtered TarInfo or throws a FilterError. */
export function dataFilter(member, destPath) {
  const attrs = {};
  let name = member.name;
  const dest = P.realpath(destPath);
  if (name.startsWith('/')) name = attrs.name = member.name.replace(/^\/+/, '');
  if (P.isabs(name)) throw new AbsolutePathError(member);
  let targetPath = P.realpath(P.join(dest, name));
  if (P.commonpath2(targetPath, dest) !== dest) throw new OutsideDestinationError(member, targetPath);
  let mode = member.mode;
  if (mode !== null && mode !== undefined) {
    mode &= 0o755;
    if (member.isreg() || member.islnk()) {
      if (!(mode & 0o100)) mode &= ~0o111;
      mode |= 0o600;
    } else if (member.isdir() || member.issym()) {
      mode = null;
    } else {
      throw new SpecialFileError(member);
    }
    if (mode !== member.mode) attrs.mode = mode;
  }
  attrs.uid = null; attrs.gid = null; attrs.uname = null; attrs.gname = null;
  if (member.islnk() || member.issym()) {
    if (P.isabs(member.linkname)) throw new AbsoluteLinkError(member);
    targetPath = member.issym()
      ? P.join(dest, P.dirname(name), member.linkname)
      : P.join(dest, member.linkname);
    targetPath = P.realpath(targetPath);
    if (P.commonpath2(targetPath, dest) !== dest) throw new LinkOutsideDestinationError(member, targetPath);
  }
  return member.replace(attrs);
}

// ---------------------------------------------------------------- extraction
/** TarFile.utime: os.utime(path, (mtime, mtime)); an OSError becomes an (ignored) ExtractError, other errors propagate. */
function utime(tarinfo, path) {
  const mtime = tarinfo.mtime;
  if (mtime === null || mtime === undefined) return;
  if (Number.isNaN(mtime)) throw new ValueError('Invalid value NaN (not a number)');
  // time_t is a signed 64-bit integer: anything outside it (or infinite) cannot be converted.
  if (!Number.isFinite(mtime) || mtime >= 2 ** 63 || mtime < -(2 ** 63)) {
    throw new OverflowError('timestamp out of range for platform time_t');
  }
  try {
    // Node treats negative numbers as "now"; a Date carries them (millisecond precision; documented gap).
    const when = mtime < 0 ? new Date(mtime * 1000) : mtime;
    fs.utimesSync(P.fsPath(path), when, when);
  } catch { /* ExtractError, nonfatal at errorlevel 1 */ }
}
function chmod(tarinfo, path) {
  if (tarinfo.mode === null || tarinfo.mode === undefined) return;
  try { fs.chmodSync(P.fsPath(path), tarinfo.mode); } catch { /* ExtractError, nonfatal at errorlevel 1 */ }
}

function makefile(archive, tarinfo, target) {
  archive.fileobj.seek(tarinfo.offsetData); // before the target is created, as in TarFile.makefile
  const fd = pyfs(target, () => fs.openSync(P.fsPath(target), 'w'));
  try {
    if (tarinfo.sparse) {
      let at = 0;
      for (const [offset, size] of tarinfo.sparse) {
        let left = size, where = offset;
        while (left > 0) {
          const chunk = archive.read(Math.min(left, 16 * 1024));
          if (chunk.length === 0) throw new ReadError('unexpected end of data');
          P.writeAll(fd, chunk, where);
          where += chunk.length; left -= chunk.length;
        }
        at = where;
      }
      void at;
      fs.ftruncateSync(fd, tarinfo.size);
      return;
    }
    const bufsize = 16 * 1024;
    let length = tarinfo.size;
    const blocks = Math.floor(length / bufsize), remainder = length % bufsize;
    for (let i = 0; i < blocks; i++) {
      const chunk = archive.read(bufsize);
      if (chunk.length < bufsize) throw new ReadError('unexpected end of data');
      P.writeAll(fd, chunk);
    }
    if (remainder) {
      const chunk = archive.read(remainder);
      if (chunk.length < remainder) throw new ReadError('unexpected end of data');
      P.writeAll(fd, chunk);
    }
  } finally { fs.closeSync(fd); }
}

function makelink(archive, tarinfo, target) {
  try {
    if (tarinfo.issym()) {
      if (P.lexists(target)) pyfs(target, () => fs.unlinkSync(P.fsPath(target)));
      pyfs(tarinfo.linkname, () => fs.symlinkSync(P.fsPath(tarinfo.linkname), P.fsPath(target)), target);
    } else if (tarinfo.linkTarget === undefined) {
      // Python: AttributeError (no _link_target on an unfiltered member), handled like an OSError below.
      throw new PyOSError('EINVAL');
    } else if (P.exists(tarinfo.linkTarget)) {
      pyfs(tarinfo.linkTarget, () => fs.linkSync(P.fsPath(tarinfo.linkTarget), P.fsPath(target)), target);
    } else {
      extractMember(archive, archive.findLinkTarget(tarinfo), target, true);
    }
  } catch (err) {
    if (!(err instanceof PyOSError)) throw err;
    // symlink_exception: fall back to copying the referenced member
    let found;
    try { found = archive.findLinkTarget(tarinfo); } catch (e) {
      if (e instanceof PyKeyError) throw new ExtractError('unable to resolve link inside archive');
      throw e;
    }
    extractMember(archive, found, target, true);
  }
}

function extractMember(archive, tarinfo, targetpath, setAttrs) {
  targetpath = targetpath.replace(/\/+$/, '');
  const upper = P.dirname(targetpath);
  if (upper && !P.exists(upper)) P.makedirs(upper);
  if (tarinfo.isreg()) makefile(archive, tarinfo, targetpath);
  else if (tarinfo.isdir()) {
    try { fs.mkdirSync(P.fsPath(targetpath), tarinfo.mode === null || tarinfo.mode === undefined ? 0o777 : 0o700); } catch (err) {
      if (!(err && err.code === 'EEXIST' && P.isdir(targetpath))) throw toPyOSError(err, targetpath);
    }
  } else if (tarinfo.isfifo() || tarinfo.ischr() || tarinfo.isblk()) {
    throw new ExtractError('special files are not supported');
  } else if (tarinfo.islnk() || tarinfo.issym()) makelink(archive, tarinfo, targetpath);
  else if (!SUPPORTED_TYPES.has(tarinfo.type)) makefile(archive, tarinfo, targetpath);
  else makefile(archive, tarinfo, targetpath);
  if (setAttrs) {
    if (!tarinfo.issym()) { chmod(tarinfo, targetpath); utime(tarinfo, targetpath); }
  }
}

const cmpCodePoints = (a, b) => {
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
};

/**
 * TarFile.extractall(path, members, filter='data') with errorlevel 1: filter errors and OSErrors abort at the
 * first failure (earlier members stay extracted); ExtractError is ignored.
 */
export function extractall(archive, dest, members = archive.getmembers()) {
  const directories = [];
  for (const member of members) {
    let tarinfo = dataFilter(member, dest);
    if (tarinfo.islnk()) {
      tarinfo = tarinfo.replace({});
      tarinfo.linkTarget = P.join(dest, tarinfo.linkname);
    }
    if (tarinfo.isdir()) directories.push(tarinfo);
    try {
      extractMember(archive, tarinfo, P.join(dest, tarinfo.name), !tarinfo.isdir());
    } catch (err) {
      if (err instanceof ExtractError) continue;
      throw err;
    }
  }
  directories.sort((a, b) => cmpCodePoints(b.name, a.name));
  for (const tarinfo of directories) {
    const dirpath = P.join(dest, tarinfo.name);
    utime(tarinfo, dirpath);
    chmod(tarinfo, dirpath);
  }
}

// ---------------------------------------------------------------- LCU wrapper
/** update_apply._unsafe */
export function unsafeName(name) {
  if (!name) return true;
  const comps = (s) => s.split('/').filter((c) => c && c !== '.');
  if (name.startsWith('/') || comps(name).includes('..')) return true;
  const win = name.replace(/\//g, '\\');
  if (win[1] === ':' || win.startsWith('\\\\')) return true; // PureWindowsPath drive
  return win.split('\\').filter((c) => c && c !== '.').includes('..');
}

/** The pre-checks of update_apply._extract_tar; throws Error(ValueError text) with name 'ValueError'. */
export function lcuPrecheck(members) {
  const fail = (msg) => new ValueError(msg);
  for (const member of members) {
    if (unsafeName(member.name)) throw fail(`Unsafe path in archive: ${member.name}`);
    if (member.isdev() || member.isfifo()) throw fail(`Unsupported entry in archive: ${member.name}`);
    if (member.issym() || member.islnk()) {
      const base = member.issym() ? P.dirname(member.name) : '';
      const target = member.linkname;
      const resolved = P.normpath(P.join(base, target));
      const win = target.replace(/\//g, '\\');
      const drive = win[1] === ':' || win.startsWith('\\\\');
      if (P.isabs(target) || drive || resolved === '..' || resolved.startsWith('../')) {
        throw fail(`Archive link escapes the release: ${member.name}`);
      }
    }
  }
}

/**
 * update_apply._extract_tar(archive, destination): open r:gz, getmembers, pre-check, extractall(filter='data').
 * Errors: ReadError/FilterError/ExtractError (TarError), ValueError-named Error, PyOSError, EOFError, PyKeyError.
 */
export function extractLcuTar(archivePath, destination) {
  const archive = openTarGz(archivePath);
  try {
    const members = archive.getmembers();
    lcuPrecheck(members);
    extractall(archive, destination, members);
  } finally { archive.close(); }
}
