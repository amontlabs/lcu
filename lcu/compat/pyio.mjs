// Python 3.12's sys.stdout / sys.stderr buffering, reproduced for every LCU print helper.
//
//   stdout_write(text)   print(text, end='') / sys.stdout.write(text)
//   stdout_flush()       sys.stdout.flush() / print(..., flush=True) / the flush input() performs before a prompt
//   stderr_write(text)   sys.stderr.write(text): written at once (see below)
//
// When fd 1 is NOT a terminal Python's stdout is a TextIOWrapper over a BufferedWriter whose size is the
// descriptor's st_blksize (open(..., buffering=-1): 4096 for a Linux pipe, 16384 for a macOS pipe, 8192 when the
// system reports none): text is collected in the wrapper's pending list (flushed to the buffer once 8192 bytes
// are pending; a chunk of 8192 bytes or more first flushes what is pending), the BufferedWriter keeps up to its
// size and writes through only when a chunk does not fit, and everything left is written at interpreter exit (flush_std_files). The consequences are
// observable: a child process that inherits fd 1 writes BEFORE the parent's earlier lines, a parent killed by a
// signal or replaced by os.execve loses what it had not flushed, and a reader that closed the pipe is noticed
// only at the flush (`Exception ignored ... BrokenPipeError`, exit status 120 when the flush is the exit one).
// When fd 1 is a terminal the wrapper is line buffered: a write containing "\n" or "\r" flushes at once.
//
// Encoding: text is encoded as UTF-8 with Python's stdout error handler: `strict` (UnicodeEncodeError for a lone
// surrogate) except `surrogateescape` in UTF-8 mode and in the C/POSIX/C.UTF-8 locale family, or what
// PYTHONIOENCODING=[encoding][:errors] names. Limit: a locale that is named but not installed is the C locale to
// CPython (so surrogateescape); the rule here goes by the name only.
//
// stderr: Python 3.9+ gives stderr line buffering but input() flushes it and every LCU message ends with a
// newline, so it is written immediately here (never held back).
//
// Never lost: the buffer is flushed synchronously from `process.on('exit')`, which covers falling off the end,
// process.exit() and uncaught errors. entry.mjs flushes explicitly before it ends the process by SIGINT.
// process.execve() and death by an unhandled signal do not run it, exactly like Python (os.execve flushes
// nothing; SIGTERM kills the interpreter before finalization).
import fs from 'node:fs';
import { isatty } from 'node:tty';

import { UnicodeEncodeError } from './pyjson.mjs';

const CHUNK_SIZE = 8192; // TextIOWrapper._CHUNK_SIZE
const DEFAULT_BUFFER_SIZE = 8192; // io.DEFAULT_BUFFER_SIZE

// The encoding error handler of Python's sys.stdout: `strict`, except `surrogateescape` in UTF-8 mode and in the
// C/POSIX/C.UTF-8 locale family (PEP 540/538), and whatever PYTHONIOENCODING=[encoding][:errors] says. Lone
// surrogates are how the compat layer keeps raw non-UTF-8 bytes (U+DC80..U+DCFF stand for bytes 0x80..0xFF).
function stdout_errors(env = process.env) {
  const spec = env.PYTHONIOENCODING;
  if (spec) {
    const errors = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : '';
    if (errors) return errors;
  }
  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find((value) => value) ?? 'C';
  if (env.PYTHONUTF8 === '1' || ['C', 'POSIX', 'C.UTF-8', 'C.utf8', 'UTF-8'].includes(locale)) return 'surrogateescape';
  return 'strict';
}

/** str.encode('utf-8', <stdout's error handler>) */
function encode(text, errors = stdout_errors()) {
  if (text.isWellFormed()) return Buffer.from(text, 'utf8');
  const parts = [];
  let plain = '';
  for (const ch of text) { // by code point: a lone surrogate is its own element
    const code = ch.codePointAt(0);
    if (code < 0xd800 || code > 0xdfff) {
      plain += ch;
      continue;
    }
    if (plain) parts.push(Buffer.from(plain, 'utf8'));
    plain = '';
    if (errors === 'surrogateescape' && code >= 0xdc80 && code <= 0xdcff) parts.push(Buffer.from([code - 0xdc00]));
    else if (errors === 'replace') parts.push(Buffer.from('?'));
    else if (errors === 'ignore') continue;
    else if (errors === 'backslashreplace') parts.push(Buffer.from(`\\u${code.toString(16)}`));
    else throw new UnicodeEncodeError(text);
  }
  if (plain) parts.push(Buffer.from(plain, 'utf8'));
  return Buffer.concat(parts);
}

function sleep_ms(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write every byte to a descriptor; a full non-blocking pipe is waited for. Throws the Node error (EPIPE...). */
function write_fully(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (error) {
      if (error.code === 'EAGAIN') {
        sleep_ms(1);
        continue;
      }
      throw error;
    }
  }
}

class BufferedText {
  constructor(fd) {
    this.fd = fd;
    this.line_buffering = null; // decided at the first write
    this.buffer_size = DEFAULT_BUFFER_SIZE; // io.open(fd, 'wb', -1): st_blksize
    this.pending = []; // TextIOWrapper pending_bytes
    this.pending_count = 0;
    this.buffer = []; // BufferedWriter buffer
    this.buffer_count = 0;
    this.hooked = false;
  }

  write(text) {
    if (!text) return;
    if (!this.hooked) {
      this.hooked = true;
      this.line_buffering = isatty(this.fd);
      try {
        const { blksize } = fs.fstatSync(this.fd);
        if (blksize > 1) this.buffer_size = blksize;
      } catch {
        // an invalid descriptor: the write below reports it
      }
      process.on('exit', exit_flush);
    }
    const bytes = encode(text);
    const needflush = this.line_buffering && (text.includes('\n') || text.includes('\r'));
    // textiowrapper_write (3.12): a chunk of at least 8192 bytes first pushes out what is pending, so it is not
    // concatenated with it; smaller chunks are appended, and the list is flushed once it reaches 8192 bytes.
    if (bytes.length >= CHUNK_SIZE) this.#writeflush();
    this.pending.push(bytes);
    this.pending_count += bytes.length;
    if (this.pending_count >= CHUNK_SIZE || needflush) this.#writeflush();
    if (needflush) this.#flush_buffer();
  }

  flush() {
    this.#writeflush();
    this.#flush_buffer();
  }

  // TextIOWrapper -> BufferedWriter.write(pending bytes)
  #writeflush() {
    if (!this.pending_count) return;
    const data = Buffer.concat(this.pending);
    this.pending = [];
    this.pending_count = 0;
    if (data.length <= this.buffer_size - this.buffer_count) {
      this.buffer.push(data);
      this.buffer_count += data.length;
      return;
    }
    this.#flush_buffer();
    if (data.length > this.buffer_size) write_fully(this.fd, data);
    else {
      this.buffer.push(data);
      this.buffer_count = data.length;
    }
  }

  #flush_buffer() {
    if (!this.buffer_count) return;
    const data = Buffer.concat(this.buffer);
    this.buffer = [];
    this.buffer_count = 0;
    write_fully(this.fd, data);
  }

  discard() {
    this.pending = [];
    this.pending_count = 0;
    this.buffer = [];
    this.buffer_count = 0;
  }
}

const stdout = new BufferedText(1);

export function stdout_write(text) {
  stdout.write(text);
}

/** sys.stdout.flush(): a closed reader raises BrokenPipeError like Python's flush. */
export function stdout_flush() {
  stdout.flush();
}

// Interpreter exit: flush_std_files. A failed flush prints Python's "Exception ignored" report and makes the
// exit status 120, whatever it was.
function exit_flush() {
  try {
    stdout.flush();
  } catch (error) {
    stdout.discard();
    try {
      write_fully(2, Buffer.from("Exception ignored in: <_io.TextIOWrapper name='<stdout>' mode='w' encoding='utf-8'>\n"
        + (error.code === 'EPIPE' ? 'BrokenPipeError: [Errno 32] Broken pipe\n' : `OSError: ${error.message}\n`)));
    } catch {
      // stderr closed too
    }
    process.exitCode = 120;
  }
}

/** Write to fd 2 immediately and completely. A closed stderr is ignored (Python reports nothing for it). */
export function stderr_write(text) {
  if (!text) return;
  try {
    write_fully(2, Buffer.from(text, 'utf8'));
  } catch (error) {
    if (error.code !== 'EPIPE') throw error;
  }
}
