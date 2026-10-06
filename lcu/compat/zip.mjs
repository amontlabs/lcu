// .zip reading and extraction with the semantics of Python 3.12 `zipfile.ZipFile(path).extractall(dest)` and the
// checks of lcu/update_apply.py `_extract_zip` (Windows release archives).
//
// Built-ins only (plus compat/inflate.mjs, compat/pypath.mjs, compat/errors.mjs). Reproduced from CPython 3.12.10:
//  * the archive is read by position from the file (end record, central directory, one member at a time), never
//    loaded as a whole;
//  * members are inflated incrementally exactly like ZipExtFile.read(n) driven by shutil.copyfileobj (64 KiB reads on
//    POSIX, 1 MiB on Windows): zlib max_length windows, `data[:file_size]`, CRC checked on the read that reaches the
//    end, EOFError when the file ends early. Nothing is inflated beyond the declared size plus one read window;
//  * overlap/zip-bomb detection (`_end_offset`): a member whose compressed data crosses the next local header or the
//    central directory raises BadZipFile "Overlapped entries: 'name' (possible zip bomb)" before any output file is
//    created; members sharing one header offset only warn (CPython warns, `warn` hook writes it to stderr);
//  * extraction on Windows uses the ntpath flavour of compat/pypath.mjs (file-only release archives need parent
//    directories created: review F01); `platform` options select it explicitly for fixtures;
//  * corrupt deflate data raises zlib.error (class name "error") after the target file was created, as CPython does.
//
// Differences from CPython, all documented:
//  * Compression methods other than stored (0) and deflate (8) are refused. Methods CPython cannot read either raise
//    its NotImplementedError ("compression type N (name)"). CPython can also read bzip2 (12) and lzma (14); Node has
//    no codec for them and the LCU release builder (scripts/build_bundle.py) only produces deflate ZIPs. Those two
//    raise UnsupportedCompression (a BadZipFile, so update_apply reports it as a normal update failure and cleans up)
//    instead of extracting. This is a deliberate, tested exclusion (tests/compat/test_zip.py KNOWN_GAPS), not
//    parity: a ZIP using those methods cannot be installed through this updater.
//  * Encrypted members raise RuntimeError like CPython without a password; strong-encryption flags too.
//  * File modes, owners and mtimes are not applied (neither does CPython's extractall).
//  * After a "Bad CRC-32" failure the partial file equals CPython's (the data of the failing read call is withheld);
//    after a zlib data error the partial file holds the reads completed before the failing window.
//  * Warnings (`warnings.warn`) are written as "UserWarning: <text>" without CPython's file/line prefix.
import fs from 'node:fs';
import { pyfs, pyRepr, pyBytesRepr, ValueError, PyOSError } from './errors.mjs';
import * as P from './pypath.mjs';
import { unsafeName } from './tar.mjs';
import { decode as utf8Decode } from './utf8.mjs';
import {
  crc32, EOFError, FALLBACK_SLACK, inflateBounded, inflateConfig, limitError, openSource, RawInflater, usesFallback, ZlibError,
} from './inflate.mjs';

export { crc32, EOFError, ZlibError };
export class BadZipFile extends Error { constructor(m) { super(m); this.name = 'BadZipFile'; } }
export class NotImplementedError extends Error { constructor(m) { super(m); this.name = 'NotImplementedError'; } }
/**
 * A compression method CPython reads (bzip2 12, lzma 14) that this module cannot: a BadZipFile subclass, so that
 * update_apply's catch set turns it into its normal "lcu update: ..." error line and clean-up (CPython's own
 * NotImplementedError for methods it cannot read either escapes that set).
 */
export class UnsupportedCompression extends BadZipFile {
  constructor(m) { super(m); this.name = 'UnsupportedCompression'; }
}
export class RuntimeError extends Error { constructor(m) { super(m); this.name = 'RuntimeError'; } }
/** Python ValueError: the single shared class (compat/pyjson.mjs). Kept under its historical export name. */
export const ZipValueError = ValueError;
export class KeyErrorZip extends Error { constructor(m) { super(pyRepr(m)); this.name = 'KeyError'; } }

const CP437 = 'ÇüéâäàåçêëèïîìÄÅ'
  + 'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ'
  + 'áíóúñÑªº¿⌐¬½¼¡«»'
  + '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐'
  + '└┴┬├─┼╞╟╚╔╩╦╠═╬╧'
  + '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀'
  + 'αßΓπΣσµτΦΘΩδ∞φε∩'
  + '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

export function decodeCp437(buf) {
  let out = '';
  for (const b of buf) out += b < 128 ? String.fromCharCode(b) : CP437[b - 128];
  return out;
}

const COMPRESSOR_NAMES = {
  0: 'store', 1: 'shrink', 2: 'reduce', 3: 'reduce', 4: 'reduce', 5: 'reduce', 6: 'implode', 7: 'tokenize',
  8: 'deflate', 9: 'deflate64', 10: 'implode', 12: 'bzip2', 14: 'lzma', 18: 'terse', 19: 'lz77', 97: 'wavpack', 98: 'ppmd',
};

const MIN_READ_SIZE = 4096; // ZipExtFile.MIN_READ_SIZE
const FLUSH_WINDOW = 16384; // zlib Decompress.flush() initial length
const copyBufsize = (platform) => (platform === 'win32' ? 1024 * 1024 : 64 * 1024); // shutil.COPY_BUFSIZE

const sanitizeFilename = (name, sep = process.platform === 'win32' ? '\\' : '/') => {
  const nul = name.indexOf('\0');
  if (nul >= 0) name = name.slice(0, nul);
  if (sep !== '/' && name.includes(sep)) name = name.split(sep).join('/');
  return name;
};

/** ZipFile._sanitize_windows_name */
export function sanitizeWindowsName(arcname, pathsep = '\\') {
  arcname = arcname.replace(/[:<>|"?*]/g, '_');
  return arcname.split(pathsep).map((x) => x.replace(/[ .]+$/, '')).filter(Boolean).join(pathsep);
}

/** The relative path ZipFile._extract_member derives for a member (before join with the destination). */
export function arcnameFor(filename, platform = process.platform) {
  const win = platform === 'win32';
  const sep = win ? '\\' : '/';
  let arcname = win ? filename.replaceAll('/', sep) : filename;
  if (win) arcname = P.win32.splitdrive(arcname)[1]; // ntpath.splitdrive: drive letter or UNC share removed
  arcname = arcname.split(sep).filter((x) => x !== '' && x !== '.' && x !== '..').join(sep);
  if (win) arcname = sanitizeWindowsName(arcname, sep);
  return arcname;
}

/** stat.filemode(mode) */
export function filemode(mode) {
  const types = { 0o140000: 's', 0o120000: 'l', 0o100000: '-', 0o060000: 'b', 0o040000: 'd', 0o020000: 'c', 0o010000: 'p' };
  let out = types[mode & 0o170000] ?? '?';
  const bit = (m, ch) => (mode & m ? ch : '-');
  out += bit(0o400, 'r') + bit(0o200, 'w');
  out += mode & 0o4000 ? (mode & 0o100 ? 's' : 'S') : bit(0o100, 'x');
  out += bit(0o40, 'r') + bit(0o20, 'w');
  out += mode & 0o2000 ? (mode & 0o10 ? 's' : 'S') : bit(0o10, 'x');
  out += bit(0o4, 'r') + bit(0o2, 'w');
  out += mode & 0o1000 ? (mode & 0o1 ? 't' : 'T') : bit(0o1, 'x');
  return out;
}

/** repr(ZipInfo): Python formats the member object (not its name) into the "encrypted" error. */
export function zipInfoRepr(info) {
  const parts = [`<ZipInfo filename=${pyRepr(info.filename)}`];
  if (info.compressType !== 0) parts.push(` compress_type=${COMPRESSOR_NAMES[info.compressType] ?? info.compressType}`);
  const hi = info.externalAttr >>> 16, lo = info.externalAttr & 0xffff;
  if (hi) parts.push(` filemode=${pyRepr(filemode(hi))}`);
  if (lo) parts.push(` external_attr=0x${lo.toString(16)}`);
  const isDir = info.filename.endsWith('/');
  if (!isDir || info.fileSize) parts.push(` file_size=${info.fileSize}`);
  if ((!isDir || info.compressSize) && (info.compressType !== 0 || info.fileSize !== info.compressSize)) {
    parts.push(` compress_size=${info.compressSize}`);
  }
  return parts.join('') + '>';
}

/** warnings.warn(message): written to stderr (CPython prefixes file and line, which have no equivalent here). */
function defaultWarn(message) {
  try { fs.writeSync(2, `UserWarning: ${message}\n`); } catch { /* stderr closed */ }
}

/**
 * ZipExtFile (the object ZipFile.open() returns), reading side only. read(n) follows ZipExtFile.read; the loop
 * body is ZipExtFile._read1/_read2 (4 KiB minimum compressed read, zlib max_length windows, unconsumed tail).
 */
export class ZipExtFile {
  constructor(source, info, start) {
    this.source = source; this.info = info; this.name = info.filename;
    this.position = start; // file offset of the next compressed byte (the _SharedFile position)
    this.compressType = info.compressType;
    this.compressLeft = info.compressSize;
    this.left = info.fileSize;
    // Deflate members use the zlib handle path; without it (inflate.mjs "bounded one-shot fallback") the member is
    // inflated once with a limit of declared size + 1 (+ slack), see readOneShot().
    this.oneShot = this.compressType === 8 && usesFallback() ? null : undefined;
    this.decompressor = this.compressType === 8 && this.oneShot === undefined ? new RawInflater() : null;
    this.tail = Buffer.alloc(0); // decompressor.unconsumed_tail
    this.eof = false;
    this.readbuffer = Buffer.alloc(0); this.offset = 0;
    this.runningCrc = 0; this.expectedCrc = info.crc;
  }

  read(n) {
    if (n === undefined || n === null || n < 0) throw new ValueError('ZipExtFile.read requires a size');
    const end = n + this.offset;
    if (end < this.readbuffer.length) {
      const buf = this.readbuffer.subarray(this.offset, end);
      this.offset = end;
      return buf;
    }
    n = end - this.readbuffer.length;
    const parts = [this.readbuffer.subarray(this.offset)];
    this.readbuffer = Buffer.alloc(0); this.offset = 0;
    while (n > 0 && !this.eof) {
      const data = this.read1Compressed(n);
      if (n < data.length) {
        this.readbuffer = data; this.offset = n;
        parts.push(data.subarray(0, n));
        break;
      }
      parts.push(data);
      n -= data.length;
    }
    return parts.length === 2 && parts[0].length === 0 ? parts[1] : Buffer.concat(parts);
  }

  /** ZipExtFile._read2(n): up to max(n, 4096) compressed bytes, never past the member. */
  read2(n) {
    if (this.compressLeft <= 0) return Buffer.alloc(0);
    n = Math.min(Math.max(n, MIN_READ_SIZE), this.compressLeft);
    const data = this.source.read(this.position, n);
    this.position += data.length;
    this.compressLeft -= data.length;
    if (data.length === 0) throw new EOFError();
    return data;
  }

  /** ZipExtFile._read1(n) */
  read1Compressed(n) {
    if (this.eof || n <= 0) return Buffer.alloc(0);
    if (this.oneShot !== undefined) return this.readOneShot(n);
    let data;
    if (this.compressType === 8) {
      data = this.tail;
      if (n > data.length) data = Buffer.concat([data, this.read2(n - data.length)]);
    } else data = this.read2(n);

    if (this.compressType === 0) {
      this.eof = this.compressLeft <= 0;
    } else {
      n = Math.max(n, MIN_READ_SIZE);
      const out = Buffer.allocUnsafe(n);
      const { consumed, written } = this.decompressor.step(data, 0, data.length, out, 0, n);
      this.tail = this.decompressor.eof ? Buffer.alloc(0) : data.subarray(consumed);
      let produced = out.subarray(0, written);
      this.eof = this.decompressor.eof || (this.compressLeft <= 0 && this.tail.length === 0);
      if (this.eof) produced = Buffer.concat([produced, this.flush()]);
      data = produced;
    }
    if (data.length > this.left) data = data.subarray(0, this.left);
    this.left -= data.length;
    if (this.left <= 0) this.eof = true;
    this.updateCrc(data);
    return data;
  }

  /**
   * Fallback for _read1 on a deflate member: the whole compressed member is read and inflated once, bounded by the
   * declared size + 1 (+ slack: see inflate.mjs); the output is then served like the handle path serves windows.
   */
  readOneShot(n) {
    if (this.oneShot === null) {
      const compressed = this.compressLeft > 0 ? this.read2(this.compressLeft) : Buffer.alloc(0);
      const limit = Math.min(this.info.fileSize + 1 + FALLBACK_SLACK, inflateConfig.maxOutput);
      this.oneShot = { ...inflateBounded(compressed, limit), off: 0 };
    }
    const member = this.oneShot;
    n = Math.max(n, MIN_READ_SIZE);
    // zlib's decompress(max_length) loses the whole window when the failure lies inside it.
    if (member.status === 'error' && member.off + n > member.out.length) throw member.error;
    let data = member.out.subarray(member.off, member.off + n);
    member.off += data.length;
    if (member.off >= member.out.length) {
      // Everything the stream yields has been served. A bound is not an end of stream: when the member's declared bytes
      // cannot be supplied because the output limit stopped the inflation, the member is rejected (round-2 R05).
      if (member.status === 'limit' && this.left > data.length) throw limitError();
      this.eof = true;
    }
    if (data.length > this.left) data = data.subarray(0, this.left);
    this.left -= data.length;
    if (this.left <= 0) this.eof = true;
    this.updateCrc(data);
    return data;
  }

  /** Decompress.flush(): the output zlib still holds once no more input will arrive. */
  flush() {
    const parts = [];
    for (;;) {
      const out = Buffer.allocUnsafe(FLUSH_WINDOW);
      const { written } = this.decompressor.step(Buffer.alloc(0), 0, 0, out, 0, FLUSH_WINDOW);
      parts.push(out.subarray(0, written));
      if (written < FLUSH_WINDOW) break;
    }
    return Buffer.concat(parts);
  }

  updateCrc(data) {
    this.runningCrc = crc32(data, this.runningCrc);
    if (this.eof && this.runningCrc !== this.expectedCrc) throw new BadZipFile(`Bad CRC-32 for file ${pyRepr(this.name)}`);
  }
}

export class ZipArchive {
  /** `data`: a Buffer or a byte source ({size, read(position, length), close()}). Options: {platform, warn}. */
  constructor(data, { platform = process.platform, warn = defaultWarn } = {}) {
    this.source = openSource(data);
    this.platform = platform; this.warn = warn;
    this.filelist = []; this.nameToInfo = new Map();
    try { this.readContents(); } catch (err) { this.close(); throw err; }
  }

  close() { this.source.close?.(); }

  endRecord() {
    const src = this.source, size = src.size;
    const unpack = (d, at) => ({
      sig: d.subarray(at, at + 4), disk: d.readUInt16LE(at + 4), diskStart: d.readUInt16LE(at + 6),
      entries: d.readUInt16LE(at + 8), entriesTotal: d.readUInt16LE(at + 10), size: d.readUInt32LE(at + 12),
      offset: d.readUInt32LE(at + 16), commentSize: d.readUInt16LE(at + 20), zip64: false,
    });
    const EOCD = Buffer.from('PK\x05\x06', 'latin1');
    if (size < 22) return null; // seek(-22, 2) fails
    const tail = src.read(size - 22, 22);
    if (tail.subarray(0, 4).equals(EOCD) && tail[20] === 0 && tail[21] === 0) {
      const rec = unpack(tail, 0); rec.location = size - 22;
      return this.endRecord64(rec);
    }
    const start0 = Math.max(size - 65535 - 22, 0);
    const data = src.read(start0, size - start0);
    const at = data.lastIndexOf(EOCD);
    if (at < 0) return null;
    if (at + 22 > data.length) return null;
    const rec = unpack(data, at); rec.location = start0 + at;
    return this.endRecord64(rec);
  }

  endRecord64(rec) {
    const src = this.source;
    const loc = rec.location - 20;
    if (loc < 0) return rec;
    const locator = src.read(loc, 20);
    if (locator.length !== 20 || !locator.subarray(0, 4).equals(Buffer.from('PK\x06\x07', 'latin1'))) return rec;
    const diskno = locator.readUInt32LE(4), disks = locator.readUInt32LE(16);
    if (diskno !== 0 || disks > 1) throw new BadZipFile('zipfiles that span multiple disks are not supported');
    const at = rec.location - 20 - 56;
    if (at < 0) return rec;
    const record = src.read(at, 56);
    if (record.length !== 56 || !record.subarray(0, 4).equals(Buffer.from('PK\x06\x06', 'latin1'))) return rec;
    rec.zip64 = true;
    rec.size = Number(record.readBigUInt64LE(40));
    rec.offset = Number(record.readBigUInt64LE(48));
    return rec;
  }

  readContents() {
    const rec = this.endRecord();
    if (!rec) throw new BadZipFile('File is not a zip file');
    const sizeCd = rec.size, offsetCd = rec.offset;
    let concat = rec.location - sizeCd - offsetCd;
    if (rec.zip64) concat -= 56 + 20;
    const startDir = offsetCd + concat;
    this.startDir = startDir;
    if (startDir < 0) throw new BadZipFile('Bad offset for central directory');
    const cd = this.source.read(startDir, sizeCd);
    let pos = 0, total = 0;
    while (total < sizeCd) {
      if (cd.length - pos < 46) throw new BadZipFile('Truncated central directory');
      if (cd.readUInt32LE(pos) !== 0x02014b50) throw new BadZipFile('Bad magic number for central directory');
      const flags = cd.readUInt16LE(pos + 8);
      const nameLen = cd.readUInt16LE(pos + 28), extraLen = cd.readUInt16LE(pos + 30), commentLen = cd.readUInt16LE(pos + 32);
      const rawName = cd.subarray(pos + 46, pos + 46 + nameLen);
      const nameCrc = crc32(rawName);
      const orig = flags & 0x800 ? utf8Decode(rawName) : decodeCp437(rawName);
      const info = {
        origFilename: orig, filename: sanitizeFilename(orig, this.platform === 'win32' ? '\\' : '/'),
        extractVersion: cd[pos + 6], // the extraction-system byte at pos + 7 is a separate field
        flagBits: flags, compressType: cd.readUInt16LE(pos + 10),
        crc: cd.readUInt32LE(pos + 16), compressSize: cd.readUInt32LE(pos + 20), fileSize: cd.readUInt32LE(pos + 24),
        externalAttr: cd.readUInt32LE(pos + 38), headerOffset: cd.readUInt32LE(pos + 42),
        extra: cd.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen), endOffset: null,
      };
      if (info.extractVersion > 63) throw new NotImplementedError(`zip file version ${(info.extractVersion / 10).toFixed(1)}`);
      this.decodeExtra(info, nameCrc);
      info.headerOffset += concat;
      this.filelist.push(info);
      this.nameToInfo.set(info.filename, info);
      const step = 46 + nameLen + extraLen + commentLen;
      pos += step; total += step;
    }
    // ZipInfo._end_offset: the start of the next local header (or of the central directory) bounds each member.
    let endOffset = startDir;
    for (const info of [...this.filelist].sort((a, b) => a.headerOffset - b.headerOffset).reverse()) {
      info.endOffset = endOffset;
      endOffset = info.headerOffset;
    }
  }

  decodeExtra(info, nameCrc) {
    let extra = info.extra;
    while (extra.length >= 4) {
      const tp = extra.readUInt16LE(0), ln = extra.readUInt16LE(2);
      if (ln + 4 > extra.length) throw new BadZipFile(`Corrupt extra field ${tp.toString(16).padStart(4, '0')} (size=${ln})`);
      let data = extra.subarray(4, ln + 4);
      if (tp === 1) {
        let field = '';
        const need = (n) => { if (data.length < n) throw new BadZipFile(`Corrupt zip64 extra field. ${field} not found.`); };
        if (info.fileSize === 0xffffffff) {
          field = 'File size'; need(8); info.fileSize = Number(data.readBigUInt64LE(0)); data = data.subarray(8);
        }
        if (info.compressSize === 0xffffffff) {
          field = 'Compress size'; need(8); info.compressSize = Number(data.readBigUInt64LE(0)); data = data.subarray(8);
        }
        if (info.headerOffset === 0xffffffff) {
          field = 'Header offset'; need(8); info.headerOffset = Number(data.readBigUInt64LE(0));
        }
      } else if (tp === 0x7075) {
        if (data.length < 5) throw new BadZipFile('Corrupt unicode path extra field (0x7075)');
        if (data[0] === 1 && data.readUInt32LE(1) === nameCrc) {
          let name;
          try { name = utf8Decode(data.subarray(5)); } catch {
            throw new BadZipFile('Corrupt unicode path extra field (0x7075): invalid utf-8 bytes');
          }
          if (name) info.filename = sanitizeFilename(name, this.platform === 'win32' ? '\\' : '/');
        }
      }
      extra = extra.subarray(ln + 4);
    }
  }

  namelist() { return this.filelist.map((i) => i.filename); }

  getinfo(name) {
    const info = this.nameToInfo.get(name);
    if (!info) throw new KeyErrorZip(`There is no item named ${pyRepr(name)} in the archive`);
    return info;
  }

  /** ZipFile.open(info): header checks in CPython's order, then a ZipExtFile (nothing is inflated yet). */
  openMember(info) {
    const src = this.source;
    const at = info.headerOffset;
    if (at < 0) throw new PyOSError('EINVAL'); // seek to a negative offset
    const header = src.read(at, 30);
    if (header.length !== 30) throw new BadZipFile('Truncated file header');
    if (header.readUInt32LE(0) !== 0x04034b50) throw new BadZipFile('Bad magic number for file header');
    const nameLen = header.readUInt16LE(26), extraLen = header.readUInt16LE(28), localFlags = header.readUInt16LE(6);
    const fname = src.read(at + 30, nameLen);
    const start = at + 30 + nameLen + extraLen;
    if (info.flagBits & 0x20) throw new NotImplementedError('compressed patched data (flag bit 5)');
    if (info.flagBits & 0x40) throw new NotImplementedError('strong encryption (flag bit 6)');
    const fnameStr = localFlags & 0x800 ? utf8Decode(fname) : decodeCp437(fname);
    if (fnameStr !== info.origFilename) {
      throw new BadZipFile(`File name in directory ${pyRepr(info.origFilename)} and header ${pyBytesRepr(fname)} differ.`);
    }
    if (info.endOffset !== null && start + info.compressSize > info.endOffset) {
      const message = `Overlapped entries: ${pyRepr(info.origFilename)} (possible zip bomb)`;
      if (info.endOffset === info.headerOffset) this.warn(message);
      else throw new BadZipFile(message);
    }
    if (info.flagBits & 1) throw new RuntimeError(`File ${zipInfoRepr(info)} is encrypted, password required for extraction`);
    if (info.compressType !== 0 && info.compressType !== 8) {
      const descr = COMPRESSOR_NAMES[info.compressType];
      if (info.compressType === 12 || info.compressType === 14) {
        throw new UnsupportedCompression(`compression type ${info.compressType} (${descr}) is not supported by the LCU updater (CPython reads it)`);
      }
      throw new NotImplementedError(descr ? `compression type ${info.compressType} (${descr})` : `compression type ${info.compressType}`);
    }
    return new ZipExtFile(src, info, start);
  }

  /** ZipFile._extract_member(member, targetpath) */
  extractMember(nameOrInfo, dest) {
    const info = typeof nameOrInfo === 'string' ? this.getinfo(nameOrInfo) : nameOrInfo;
    const flavour = P.flavourFor(this.platform);
    const isDir = info.filename.endsWith('/');
    const arcname = arcnameFor(info.filename, this.platform);
    if (!arcname && !isDir) throw new ZipValueError('Empty filename.');
    const target = flavour.normpath(flavour.join(dest, arcname));
    const upper = flavour.dirname(target);
    if (upper && !flavour.exists(upper)) flavour.makedirs(upper);
    if (isDir) {
      if (!flavour.isdir(target)) pyfs(target, () => fs.mkdirSync(target));
      return target;
    }
    const source = this.openMember(info);
    const fd = pyfs(target, () => fs.openSync(target, 'w'));
    try {
      const length = copyBufsize(this.platform);
      for (;;) { // shutil.copyfileobj(source, target)
        const buf = source.read(length);
        if (buf.length === 0) break;
        P.writeAll(fd, buf);
      }
    } finally { fs.closeSync(fd); }
    return target;
  }

  extractall(dest) {
    for (const name of this.namelist()) this.extractMember(name, dest);
  }
}

/** zipfile.ZipFile(source): `source` is a path, a Buffer or a byte source. Call close() when done with a path. */
export function openZip(source, options) {
  return new ZipArchive(Buffer.isBuffer(source) ? source : typeof source === 'object' && source ? source : String(source), options);
}

/** update_apply._extract_zip(archive, destination). Options: {platform} (path flavour, default process.platform). */
export function extractLcuZip(archivePath, destination, options) {
  const bundle = openZip(archivePath, options);
  try {
    for (const info of bundle.filelist) {
      if (unsafeName(info.filename) || ((info.externalAttr >>> 16) & 0o170000) === 0o120000) {
        throw new ZipValueError(`Unsafe entry in archive: ${info.filename}`);
      }
    }
    bundle.extractall(destination);
  } finally { bundle.close(); }
}
