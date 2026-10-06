// Bounded, incremental raw-deflate and gzip reading shared by compat/tar.mjs and compat/zip.mjs.
//
// Why this exists (compat-archive-http review F03): Python's zipfile/tarfile/gzip never inflate more than the caller
// asks for (zlib decompress(data, max_length); gzip reads 128 KiB of input at a time, io.BufferedReader asks the raw
// reader for 8 KiB blocks). A one-shot zlib.inflateRawSync() inflates the whole member (or the whole tail behind a tar
// terminator) first, so a 32 KiB archive can force tens of MiB of allocations and a corrupt unused tail aborts an
// extraction Python completes. This module reproduces the bounded cadence on Node built-ins:
//
//  * RawInflater drives the synchronous zlib handle of a zlib.InflateRaw object (`_handle.writeSync` with an exact
//    output window, exactly what zlib.inflateRawSync does internally, but resumable). This is an undocumented Node
//    interface, present in every Node release LCU supports (22, 24, 26); the constructor verifies it. When the handle
//    interface is absent (or `inflateConfig.forceFallback` is set, which the tests do) the readers use the documented
//    one-shot API instead (see "bounded one-shot fallback" below); that path never inflates without a bound.
//  * GzipFile reproduces gzip.GzipFile(mode='rb') as seen by tarfile: _GzipReader.read(size) (header parsing,
//    member trailer CRC/length checks, zero padding, multi-member streams, EOFError on truncation) behind a
//    BufferedReader of 8192 bytes, with DecompressReader.seek (forward seeks read and discard, backward seeks rewind
//    and restart from the beginning of the file).
//
// Differences (documented): when zlib reports a data error, Python loses the output of that single decompress() call;
// so do we (same window sizes, except raw reads are capped at 1 MiB per call, which only matters for read sizes the
// callers never use). The zlib error text is Node's bundled zlib's (same strings as CPython's zlib for the same
// zlib release; they have been identical in every fixture).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pyfs } from './errors.mjs';
import { reprBytes } from './pyerr.mjs';

export class EOFError extends Error { constructor(m = '') { super(m); this.name = 'EOFError'; } }
/** gzip.BadGzipFile (an OSError subclass). */
export class BadGzipFile extends Error { constructor(m) { super(m); this.name = 'BadGzipFile'; this.isOSError = true; } }
/** zlib.error: not an OSError, not a ValueError. */
export class ZlibError extends Error { constructor(m) { super(m); this.name = 'error'; this.isZlibError = true; } }

// ---------------------------------------------------------------- crc32
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
/** zlib.crc32(data, crc) */
export function crc32(buf, crc = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, crc);
  let c = (crc ^ 0xffffffff) >>> 0;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const EMPTY = Buffer.alloc(0);

/** Bytes produced by every RawInflater in this process (tests assert that nothing is inflated beyond what is needed). */
export const inflateStats = { written: 0, peak: 0 };

/**
 * Test seam: `forceFallback = true` makes the readers use the documented zlib.inflateRawSync path; `maxOutput` is the
 * output bound of a gzip (tar) stream on that path (a ZIP member is bounded by its declared size instead).
 */
export const inflateConfig = { forceFallback: false, maxOutput: 256 * 1024 * 1024, maxInput: 256 * 1024 * 1024 };

/** True when the undocumented synchronous zlib handle is usable (checked once, by constructing an engine). */
let handleUsable;
export function handleAvailable() {
  if (handleUsable === undefined) {
    try { new RawInflater(); handleUsable = true; } catch { handleUsable = false; }
  }
  return handleUsable;
}
/** Which implementation the readers use right now. */
export const usesFallback = () => inflateConfig.forceFallback || !handleAvailable();

// ---------------------------------------------------------------- raw inflater
export class RawInflater {
  constructor() {
    const engine = new zlib.InflateRaw({ chunkSize: 1024 });
    const handle = engine._handle, state = engine._writeState;
    if (!handle || typeof handle.writeSync !== 'function' || typeof handle.reset !== 'function'
        || !(state instanceof Uint32Array)) {
      throw new Error("LCU: this Node's zlib lacks the synchronous inflate handle needed for bounded decompression");
    }
    this.engine = engine; this.handle = handle; this.state = state; this.error = null; this.eof = false;
    handle.onerror = (message, errno, code) => { this.error = { message, errno, code }; };
    this.probe = Buffer.alloc(1);
  }

  /**
   * zlib decompressobj(-15).decompress(input[inPos:inEnd], max_length=outLen) into out[outOff:outOff+outLen].
   * Returns {consumed, written}; sets this.eof once the deflate stream has ended (zlib's Z_STREAM_END).
   */
  step(input, inPos, inEnd, out, outOff, outLen) {
    const available = inEnd - inPos;
    this.handle.writeSync(zlib.constants.Z_NO_FLUSH, input, inPos, available, out, outOff, outLen);
    if (this.error) {
      const { message, errno } = this.error;
      this.error = null;
      throw new ZlibError(`Error ${errno} while decompressing data${message ? `: ${message}` : ''}`);
    }
    const written = outLen - this.state[0], consumed = available - this.state[1];
    inflateStats.written += written;
    if (this.state[0] > 0) {
      // Output window not full: the input is used up or the stream ended. Input left over means it ended; if all
      // input was consumed, ask zlib to finish with no input (Z_BUF_ERROR means "not ended yet").
      this.eof = consumed < available ? true : this.finishes();
    }
    return { consumed, written };
  }

  finishes() {
    this.handle.writeSync(zlib.constants.Z_FINISH, EMPTY, 0, 0, this.probe, 0, 1);
    if (this.error) { this.error = null; return false; }
    return true;
  }

  reset() { this.handle.reset(); this.eof = false; this.error = null; }
}

// ---------------------------------------------------------------- bounded one-shot fallback
// Used only when the zlib handle interface above is missing. zlib.inflateRawSync(buf, {maxOutputLength}) is
// documented but all-or-nothing: it throws instead of returning what it has when the output limit is hit, so the
// bound is applied like this (every call allocates at most `limit` bytes of output):
//   1. one call over the whole input with maxOutputLength = limit; success is the normal case;
//   2. otherwise the failure kind decides: ERR_BUFFER_TOO_LARGE ('limit'), Z_BUF_ERROR ('truncated': the input ended
//      inside the deflate stream) or a zlib data error ('error'); the output CPython would have produced before
//      reaching the failure is the output of the LONGEST INPUT PREFIX that inflates cleanly with Z_SYNC_FLUSH
//      (found by binary search: more input never un-produces output, and an error or overflow, once reached, stays
//      reached). The failure is reported only when the reader asks for bytes past that output.
// Deviations (documented): zlib's read windows are not reproduced, so on a data error the output before it is
// delivered whole (CPython loses the single read window that contains the error); memory is `limit`, not one window.
// One deflate input byte expands to at most 1032 output bytes, so a prefix cut at the limit still holds every byte
// the caller needs when the limit is (declared size + 1 + FALLBACK_SLACK).
export const FALLBACK_SLACK = 2048;

function tryInflate(buf, limit, finishFlush) {
  try {
    const result = zlib.inflateRawSync(buf, { maxOutputLength: limit, info: true, finishFlush });
    inflateStats.peak = Math.max(inflateStats.peak, result.buffer.length);
    return { ok: true, out: result.buffer, consumed: result.engine.bytesWritten };
  } catch (err) {
    return { ok: false, err };
  }
}

const zlibError = (err) => new ZlibError(
  `Error ${err.errno} while decompressing data${err.message ? `: ${err.message}` : ''}`);

/**
 * Inflate a raw deflate stream held in `buf`, never producing more than `limit` bytes of output.
 * Returns {out, consumed, status, error}: status 'end' (stream complete; `consumed` input bytes), 'truncated' (input
 * ended inside the stream), 'limit' (the stream continues past `limit` output bytes) or 'error' (zlib data error;
 * `error` is the ZlibError CPython would raise). `out` is the output available before a non-'end' status.
 */
export function inflateBounded(buf, limit) {
  const full = tryInflate(buf, limit, zlib.constants.Z_FINISH);
  if (full.ok) {
    inflateStats.written += full.out.length;
    return { out: full.out, consumed: full.consumed, status: 'end', error: null };
  }
  const code = full.err.code;
  const status = code === 'ERR_BUFFER_TOO_LARGE' ? 'limit' : code === 'Z_BUF_ERROR' ? 'truncated' : 'error';
  const error = status === 'error' ? zlibError(full.err) : null;
  if (status === 'truncated') {
    const partial = tryInflate(buf, limit, zlib.constants.Z_SYNC_FLUSH);
    if (partial.ok) {
      inflateStats.written += partial.out.length;
      return { out: partial.out, consumed: buf.length, status, error };
    }
  }
  // Invariant: the prefix of length lo inflates cleanly, the prefix of length hi does not.
  let lo = 0, hi = buf.length, best = EMPTY;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    const attempt = tryInflate(buf.subarray(0, mid), limit, zlib.constants.Z_SYNC_FLUSH);
    if (attempt.ok) { lo = mid; best = attempt.out; } else hi = mid;
  }
  inflateStats.written += best.length;
  return { out: best, consumed: null, status, error };
}

export const limitError = () => new ZlibError(
  'Error -5 while decompressing data: output exceeds the LCU decompression limit');

// ---------------------------------------------------------------- byte sources
export class BufferSource {
  constructor(buffer) { this.buffer = buffer; this.size = buffer.length; }
  read(position, length) { return this.buffer.subarray(position, position + length); }
  close() {}
}

/** A file read by position (no file-wide buffering). Read errors carry the Python-visible filename. */
export class FileSource {
  constructor(path) {
    this.path = String(path);
    this.fd = pyfs(this.path, () => fs.openSync(path, 'r'));
    this.size = pyfs(this.path, () => fs.fstatSync(this.fd).size);
  }
  read(position, length) {
    length = Math.max(0, Math.min(length, this.size - position));
    if (length === 0) return EMPTY;
    const buffer = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const n = pyfs(this.path, () => fs.readSync(this.fd, buffer, got, length - got, position + got));
      if (n === 0) break;
      got += n;
    }
    return got === length ? buffer : buffer.subarray(0, got);
  }
  close() {
    if (this.fd !== null) { const fd = this.fd; this.fd = null; try { fs.closeSync(fd); } catch { /* closing */ } }
  }
}

export function openSource(source) {
  if (Buffer.isBuffer(source)) return new BufferSource(source);
  if (source && typeof source.read === 'function') return source;
  return new FileSource(source);
}

// ---------------------------------------------------------------- gzip (gzip._GzipReader + BufferedReader)
const READ_BUFFER_SIZE = 128 * 1024; // gzip.READ_BUFFER_SIZE
const BUFFER_SIZE = 8192; // io.DEFAULT_BUFFER_SIZE (BufferedReader and DecompressReader.seek block)
const MAX_RAW_READ = 1 << 20; // allocation cap of one raw read (callers ask far less)

const FHCRC = 2, FEXTRA = 4, FNAME = 8, FCOMMENT = 16;

/** gzip._PaddedFile over a byte source: bytes handed to the inflater stay here until consumed. */
class PaddedSource {
  constructor(source) { this.source = source; this.filePos = 0; this.buf = EMPTY; this.off = 0; }
  get length() { return this.buf.length - this.off; }
  rewind() { this.filePos = 0; this.buf = EMPTY; this.off = 0; }
  /** Make at least `n` bytes (or everything left) available in the buffer; returns the bytes available. */
  ensure(n) {
    if (this.length >= n) return this.length;
    const more = this.source.read(this.filePos, Math.max(n, READ_BUFFER_SIZE) - this.length);
    this.filePos += more.length;
    this.buf = this.length ? Buffer.concat([this.buf.subarray(this.off), more]) : more;
    this.off = 0;
    return this.length;
  }
  /** fp.read(n): n bytes unless the end of the file comes first. */
  take(n) {
    this.ensure(n);
    const out = this.buf.subarray(this.off, this.off + n);
    this.off += out.length;
    return out;
  }
}

class GzipReader {
  constructor(source) {
    this.fp = new PaddedSource(source);
    this.source = source;
    this.fallback = usesFallback();
    this.inflater = this.fallback ? null : new RawInflater();
    this.member = null; // fallback: the member being served ({out, off, start, status, consumed, error})
    this.newMember = true; this.pos = 0; this.crc = 0; this.streamSize = 0;
  }

  readExact(n) {
    const data = this.fp.take(n);
    if (data.length < n) throw new EOFError('Compressed file ended before the end-of-stream marker was reached');
    return data;
  }

  readGzipHeader() {
    const magic = this.fp.take(2);
    if (magic.length === 0) return false;
    if (magic[0] !== 0x1f || magic[1] !== 0x8b || magic.length !== 2) {
      throw new BadGzipFile(`Not a gzipped file (${reprBytes(magic)})`);
    }
    const head = this.readExact(8);
    const method = head[0], flag = head[1];
    if (method !== 8) throw new BadGzipFile('Unknown compression method');
    if (flag & FEXTRA) {
      const extraLen = this.readExact(2).readUInt16LE(0);
      this.readExact(extraLen);
    }
    for (const bit of [FNAME, FCOMMENT]) {
      if (!(flag & bit)) continue;
      for (;;) { const s = this.fp.take(1); if (s.length === 0 || s[0] === 0) break; }
    }
    if (flag & FHCRC) this.readExact(2);
    return true;
  }

  readEof() {
    const trailer = this.readExact(8);
    const crc = trailer.readUInt32LE(0), isize = trailer.readUInt32LE(4);
    if (crc !== this.crc) {
      throw new BadGzipFile(`CRC check failed 0x${crc.toString(16)} != 0x${this.crc.toString(16)}`);
    } else if (isize !== (this.streamSize % 4294967296)) {
      throw new BadGzipFile('Incorrect length of data produced');
    }
    // Gzip files can be padded with zeroes and still be valid archives: skip zero bytes.
    while (this.fp.ensure(1) && this.fp.buf[this.fp.off] === 0) this.fp.off++;
  }

  /**
   * Inflate the member starting at `start` without reading the rest of the file: the compressed window grows 4x per
   * attempt (128 KiB first, like the primary path's input chunks) only while the stream is still incomplete, so the
   * padding or later members behind a normal member are never read; `maxInput` bounds the growth (round-2 R06).
   */
  inflateMember(start) {
    const available = Math.max(0, this.source.size - start);
    let want = READ_BUFFER_SIZE;
    for (;;) {
      const window = this.source.read(start, Math.min(want, available));
      const result = inflateBounded(window, inflateConfig.maxOutput);
      if (result.status !== 'truncated' || window.length >= available) return result;
      if (want >= inflateConfig.maxInput) return { out: result.out, consumed: null, status: 'limit', error: null };
      want *= 4;
    }
  }

  /**
   * Fallback read(size): the member's deflate data is inflated once with a bound (inflateBounded over the rest of
   * the file, only when the reader first needs the member), then served in pieces; header, trailer, padding and
   * multi-member handling are the code of the handle path.
   */
  readOneShot(size) {
    const cap = Math.min(size, MAX_RAW_READ);
    for (;;) {
      if (this.member === null) {
        this.crc = 0; this.streamSize = 0;
        if (!this.readGzipHeader()) return EMPTY;
        const start = this.fp.filePos - this.fp.length; // first byte of the deflate data
        this.member = { ...this.inflateMember(start), off: 0, start };
      }
      const member = this.member;
      // zlib's decompress(max_length) loses the whole window when the failure lies inside it.
      if (member.status === 'error' && member.off + cap > member.out.length) throw member.error;
      if (member.off < member.out.length) {
        const data = member.out.subarray(member.off, member.off + cap);
        member.off += data.length;
        this.crc = crc32(data, this.crc);
        this.streamSize += data.length;
        this.pos += data.length;
        return data;
      }
      if (member.status === 'end') {
        // The member ended: check its trailer and move on to the next member.
        this.fp.filePos = member.start + member.consumed; this.fp.buf = EMPTY; this.fp.off = 0;
        this.readEof();
        this.member = null;
        continue;
      }
      if (member.status === 'error') throw member.error;
      if (member.status === 'limit') throw limitError();
      throw new EOFError('Compressed file ended before the end-of-stream marker was reached');
    }
  }

  /** _GzipReader.read(size): up to `size` bytes; an empty result is the end of the stream. */
  read(size) {
    if (!size) return EMPTY;
    if (this.fallback) return this.readOneShot(size);
    const cap = Math.min(size, MAX_RAW_READ);
    let lastChunkEmpty = false;
    for (;;) {
      if (this.inflater.eof) {
        // The member ended: check its trailer and move on to the next member.
        this.readEof();
        this.newMember = true;
        this.inflater.reset();
      }
      if (this.newMember) {
        this.crc = 0; this.streamSize = 0;
        if (!this.readGzipHeader()) return EMPTY;
        this.newMember = false;
      }
      if (this.fp.length === 0) lastChunkEmpty = this.fp.ensure(1) === 0; // needs_input: read the next 128 KiB
      const out = Buffer.allocUnsafe(cap);
      const { consumed, written } = this.inflater.step(this.fp.buf, this.fp.off, this.fp.buf.length, out, 0, cap);
      this.fp.off += consumed;
      if (written === 0 && consumed === 0 && this.fp.length > 0 && !this.inflater.eof) {
        throw new ZlibError('Error -5 while decompressing data: incomplete or truncated stream'); // cannot happen; no spin
      }
      if (written > 0) {
        const data = out.subarray(0, written);
        this.crc = crc32(data, this.crc);
        this.streamSize += written;
        this.pos += written;
        return data;
      }
      if (lastChunkEmpty && this.fp.length === 0) {
        throw new EOFError('Compressed file ended before the end-of-stream marker was reached');
      }
    }
  }

  /** DecompressReader.seek(offset) with whence=SEEK_SET. */
  seek(offset) {
    if (offset < this.pos) {
      this.fp.rewind(); this.inflater?.reset(); this.member = null; this.newMember = true; this.pos = 0;
    } else offset -= this.pos;
    while (offset > 0) {
      const data = this.read(Math.min(BUFFER_SIZE, offset));
      if (data.length === 0) break;
      offset -= data.length;
    }
    return this.pos;
  }
}

/** gzip.GzipFile(fileobj, 'rb') as tarfile uses it: read(n), seek(absolute), tell(). */
export class GzipFile {
  constructor(source) {
    this.source = source;
    this.raw = new GzipReader(source);
    this.buffer = EMPTY; this.bufPos = 0;
  }

  tell() { return this.raw.pos - (this.buffer.length - this.bufPos); }

  /** io.BufferedReader.read(n) with an 8192-byte buffer over the gzip reader. */
  read(n) {
    const parts = [];
    const have = this.buffer.length - this.bufPos;
    if (n <= have) {
      const out = this.buffer.subarray(this.bufPos, this.bufPos + n);
      this.bufPos += n;
      return out;
    }
    if (have > 0) parts.push(this.buffer.subarray(this.bufPos));
    this.buffer = EMPTY; this.bufPos = 0;
    let remaining = n - have, eof = false;
    while (remaining > 0) { // whole blocks straight from the raw reader
      const r = remaining - (remaining % BUFFER_SIZE);
      if (r === 0) break;
      const data = this.raw.read(r);
      if (data.length === 0) { eof = true; break; }
      parts.push(data); remaining -= data.length;
    }
    while (remaining > 0 && !eof) { // the last partial block through the buffer
      const data = this.raw.read(BUFFER_SIZE);
      if (data.length === 0) break;
      if (data.length > remaining) {
        parts.push(data.subarray(0, remaining));
        this.buffer = data; this.bufPos = remaining;
        remaining = 0;
      } else { parts.push(data); remaining -= data.length; }
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  seek(target) {
    const avail = this.buffer.length - this.bufPos;
    if (avail > 0) {
      const offset = target - this.tell();
      if (offset >= -this.bufPos && offset <= avail) { this.bufPos += offset; return target; }
    }
    const position = this.raw.seek(target);
    this.buffer = EMPTY; this.bufPos = 0;
    return position;
  }

  close() { this.source.close?.(); }
}
