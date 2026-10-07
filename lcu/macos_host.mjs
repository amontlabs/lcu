// Supervise the original macOS client turn-ended command for one MCP process.
// Port of lcu/macos_host.py (see .port/notes/macos_host.md).
//
// The host runs as a child of the MCP launcher: `node <release>/lcu/entry.mjs macos-host serve <socket>
// <client> [<control socket>]`, which calls `serve_main(argv.slice(3))` (argv = ['serve', ...]).
// start_original_host/stop_original_host/serve are asynchronous (the Python versions blocked on threads and
// select); everything observable (socket paths, modes, framing, payload bytes, timeouts, reply strings) is kept.
import { spawn } from './compat/spawn.mjs';
import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants as fsConstants, ftruncateSync, lstatSync, readSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs';
import net from 'node:net';
import { constants as osConstants } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PySystemExit, pyStrip } from './compat/argparse.mjs';
import { LockTimeoutError, acquire } from './compat/lock.mjs';
import { commonpath2, join as pyJoin, realpath as pyRealpath } from './compat/pypath.mjs';
import { PyOSError, fromNodeError, isOSError, pyStr, reprStr, spawnErrorText } from './compat/pyerr.mjs';
import { SubprocessError, TimeoutExpired, execFormatError, textOf } from './compat/subprocess.mjs';
import { runTool, trustedTool } from './compat/systool.mjs';
import { mkdtemp } from './compat/tempfile.mjs';
import { decode } from './compat/utf8.mjs';
import { ValueError, dumps, equal, loads, pyfloat } from './compat/pyjson.mjs';

const SIGNALS = osConstants.signals;

// The original helper starts the CUAService app and its XPC transport waits up
// to 5 s to connect, so a healthy run takes about 5.2 s. Allow for a slower launch.
// lcu/macos_sky_service.mjs derives its own wait from this value.
export const TURN_ENDED_CLI_TIMEOUT_SECONDS = 10;
// Log successful runs only when they are close to the helper's own 5 s deadline.
export const TURN_ENDED_CLI_SLOW_SECONDS = 4.5;
export const STDERR_LOG_BYTES = 512;

// ------------------------------------------------------------------------------------------ helpers

class RuntimeError extends Error {
  constructor(message) { super(message); this.name = 'RuntimeError'; }
}

/** queue.Empty (str() is empty). */
class EmptyQueue extends Error {
  constructor() { super(''); this.name = 'Empty'; }
}

/** socket.timeout / TimeoutError: an OSError (the shared PyOSError) whose text is "timed out". */
class SocketTimeout extends PyOSError {
  constructor() { super({ strerror: 'timed out', className: 'TimeoutError' }); }
}

/** str(exc) as Python prints it. */
function excStr(exc) {
  if (exc instanceof PyOSError) return exc.message;
  return pyStr(exc);
}

/** str[:limit] by code points. */
const cpSlice = (text, limit) => Array.from(text).slice(0, limit).join('');

const dict = (entries) => new Map(entries);
/** (json.dumps(value, separators=(',', ':')) + '\n').encode() */
const frame = (value) => Buffer.from(dumps(value, { separators: [',', ':'] }) + '\n', 'utf8');
const nonBlank = (value) => typeof value === 'string' && pyStrip(value) !== '';
const monotonic = () => performance.now() / 1000;
const unixMs = () => performance.timeOrigin + performance.now();

/** Raise like Python's dict hashing for unhashable JSON values used as keys. */
function hashable(value) {
  if (Array.isArray(value)) throw new Error("unhashable type: 'list'");
  if (value instanceof Map) throw new Error("unhashable type: 'dict'");
  return value;
}

/** print(text, flush=True) on a raw descriptor, synchronously (ordering and no truncation at exit). */
function writeFd(fd, text) {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset);
    } catch (error) {
      if (error?.code === 'EAGAIN') continue;
      throw error;
    }
  }
}

/** threading.Condition: single-threaded, so only wait/notify_all are needed (sections between awaits are atomic). */
class Condition {
  constructor() { this.waiters = new Set(); }
  notify_all() {
    for (const wake of [...this.waiters]) wake();
  }
  /** wait(timeout) in seconds; a non-positive timeout returns at once. */
  wait(seconds) {
    if (!(seconds > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
      const timer = setTimeout(wake, seconds * 1000);
      this.waiters.add(wake);
    });
  }
}

const FRAMING = 'Invalid macOS control request size or framing.';
const BUFFER_PAUSE = 1 << 17;

/**
 * A connection plus Python's LineReader. Data is collected as it arrives (so peer resets are recorded even before
 * the connection's turn), but framing is judged exactly like the Python recv loop: a line is accepted when its
 * newline is within the first limit+1 bytes.
 */
export class LineReader {
  constructor(connection) {
    this.connection = connection;
    this.buffer = Buffer.alloc(0);
    this.timeout = null; // milliseconds per wait for data (socket.settimeout), null = block
    this.ended = false;
    this.failure = null;
    this.wake = null;
    const wake = () => { const callback = this.wake; if (callback) callback(); };
    connection.on('data', (chunk) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      if (this.buffer.length > BUFFER_PAUSE) connection.pause();
      wake();
    });
    connection.on('end', () => { this.ended = true; wake(); });
    connection.on('close', () => { this.ended = true; wake(); });
    connection.on('error', (error) => { this.failure = error; wake(); });
    // A backlog socket may have failed or closed before its turn (see serve()).
    if (connection.lcuFailure) this.failure = connection.lcuFailure;
    if (connection.lcuClosed || connection.destroyed) this.ended = true;
    connection.resume();
  }

  _consume(count) {
    this.buffer = this.buffer.subarray(count);
    if (this.connection.isPaused() && this.buffer.length <= BUFFER_PAUSE) this.connection.resume();
  }

  _more() {
    if (this.failure) {
      const error = this.failure;
      throw fromNodeError(error) ?? error;
    }
    if (this.ended) throw new ValueError('macOS control connection closed before a complete request.');
    return new Promise((resolve, reject) => {
      let timer = null;
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      if (this.timeout !== null) {
        timer = setTimeout(() => {
          this.wake = null;
          reject(new SocketTimeout());
        }, this.timeout);
      }
    });
  }

  async read(limit = 4096) {
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) {
        if (this.buffer.length > limit) throw new ValueError(FRAMING);
      } else {
        if (newline > limit) throw new ValueError(FRAMING);
        const line = Buffer.from(this.buffer.subarray(0, newline));
        this._consume(newline + 1);
        return loads(line);
      }
      await this._more();
    }
  }

  /** sendall(): resolves with null, or the error when the peer is gone. */
  write(bytes) {
    return new Promise((resolve) => {
      const socket = this.connection;
      if (socket.destroyed || !socket.writable) { resolve(new Error('connection closed')); return; }
      socket.write(bytes, (error) => resolve(error ?? null));
    });
  }

  /** sendall() then close(); a disconnected peer is ignored. */
  async sendAndClose(bytes, timeoutMs = null) {
    const socket = this.connection;
    await new Promise((resolve) => {
      let timer = null;
      const finish = () => { clearTimeout(timer); resolve(); };
      if (timeoutMs !== null) timer = setTimeout(finish, timeoutMs);
      if (socket.destroyed || !socket.writable) { finish(); return; }
      try {
        // sendall() then close(): no shutdown(SHUT_WR) in between (end() would add one), so the peer sees the same
        // reply-then-reset sequence when request bytes are still unread.
        socket.write(bytes, finish);
      } catch {
        finish();
      }
    });
    socket.destroy();
  }

  close() {
    this.connection.destroy();
  }
}

/** Create a unix-socket server with a 0600 socket file, backlog 8; resolves once listening. */
function listenPrivate(server, address) {
  return new Promise((resolve, reject) => {
    const limit = process.platform === 'darwin' ? 104 : 108;
    if (Buffer.byteLength(address) >= limit) {
      reject(Object.assign(new Error('AF_UNIX path too long'), { name: 'OSError' }));
      return;
    }
    const failed = (error) => {
      // libuv reports a missing parent directory of the socket path as EACCES; bind(2) said ENOENT.
      if (error?.code === 'EACCES') {
        try {
          lstatSync(dirname(address));
        } catch (cause) {
          if (cause?.code === 'ENOENT') error = Object.assign(new Error(error.message), { code: 'ENOENT', syscall: 'bind' });
        }
      }
      reject(fromNodeError(error, { filename: null }) ?? error);
    };
    server.once('error', failed);
    // bind() creates the file with the umask applied; Python chmods before listen(), so no wider window exists.
    const previous = process.umask(0o177);
    try {
      server.listen({ path: address, backlog: 8 }, () => {
        server.off('error', failed);
        server.on('error', () => {});
        resolve();
      });
    } catch (error) {
      reject(error);
    } finally {
      process.umask(previous);
    }
  });
}

const unlinkQuiet = (path) => rmSync(path, { force: true });

// ------------------------------------------------------------------------------------------ stale service recovery
// Port of the stale Computer Use service recovery of lcu/macos_host.py (upstream #26). The Python code ran this on
// threads; here the recovery is asynchronous (it must not block the accept loop) and every injectable step may
// return a promise. Adaptations are listed in .port/notes/macos_stale_service.md.

export const SKY_SERVICE_NAME = 'SkyComputerUseService';
// The system tools by absolute path, so a caller's PATH cannot stand in for them.
export const PS = '/bin/ps';
export const LSOF = '/usr/sbin/lsof';
export const CODESIGN = '/usr/bin/codesign';
// `ps` reports the start time in whole seconds and the file time has sub-second
// precision, so a change this close to the start is never read as an update.
export const STALE_MARGIN_SECONDS = 2;
const _MONTHS = new Map(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  .map((name, index) => [name, index + 1]));

/** Test and platform seams (production values are the defaults). */
export const stale_internals = {
  platform: process.platform,
  // The recovery itself, so recover_response can be tested without inspecting anything real.
  recover_stale_service: (...args) => recover_stale_service(...args),
  // Positional pread/pwrite/ftruncate of the peer lock record.
  read: (fd, buffer, length, position) => readSync(fd, buffer, 0, length, position),
  write: (fd, buffer, position) => writeSync(fd, buffer, 0, buffer.length, position),
  truncate: (fd, length) => ftruncateSync(fd, length),
  // The SingleFlight at the end of this section (a test replaces it).
  shared_recovery: null,
};

const basename_of = (path) => path.slice(path.lastIndexOf('/') + 1);
const is_abs = (path) => path.startsWith('/');
const sleep_seconds = (seconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, seconds * 1000));

/** int(text) for the text Python accepts that matters here: optional sign, ASCII digits, single underscores, padding. */
function pyInt(text) {
  const trimmed = pyStrip(text);
  if (!/^[+-]?\d+(?:_\d+)*$/.test(trimmed)) throw new ValueError(`invalid literal for int() with base 10: ${reprStr(text)}`);
  return Number(trimmed.replaceAll('_', ''));
}

/** UTC epoch seconds from the five `ps lstart` fields, or null when malformed. */
export function parse_process_start(fields) {
  try {
    if (fields.length !== 5) throw new ValueError('unpack');
    const [, month_name, day_text, clock, year_text] = fields;
    const parts = clock.split(':').map(pyInt);
    if (parts.length !== 3) throw new ValueError('unpack');
    const [hour, minute, second] = parts;
    if (!_MONTHS.has(month_name)) throw new ValueError('KeyError');
    const month = _MONTHS.get(month_name);
    const day = pyInt(day_text);
    const year = pyInt(year_text);
    if (!(day >= 1 && day <= 31 && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 &&
        second >= 0 && second <= 60 && year >= 1970 && year <= 9999)) {
      return null;
    }
    // `ps` is run with TZ=UTC, so there is no local-time ambiguity at DST changes.
    return Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  } catch (error) {
    if (error instanceof ValueError) return null;
    throw error;
  }
}

const _PROCESS_ROW = new RegExp(
  '^[ \\t]*([0-9]+)[ \\t]+([0-9]+)[ \\t]+([A-Za-z]{3})[ \\t]+([A-Za-z]{3})[ \\t]+([0-9]{1,2})[ \\t]+' +
  '([0-9]{2}:[0-9]{2}:[0-9]{2})[ \\t]+([0-9]{4})[ \\t]+(/[^\\n]*)$');
// Characters that could make a path look like several rows or fields.
const _UNSAFE_PATH = /[\x00-\x1f\x7f\x85\u2028\u2029]/;

/**
 * Return running Sky services from `ps -axo pid=,uid=,lstart=,comm=` output, as [services, unparsed].
 *
 * Rows are split on newlines only (not on Unicode line separators a process name could
 * carry), and lines that name the service but cannot be parsed are counted, not guessed at.
 */
export function parse_process_table(text) {
  const services = [];
  let unparsed = 0;
  for (const line of text.split('\n')) {
    if (!line.includes(SKY_SERVICE_NAME)) continue;
    // pid, uid, then lstart as `Wed Oct  7 00:34:53 2026`, then the executable path
    // (which may contain spaces).
    const match = _PROCESS_ROW.exec(line.replace(/\r+$/, ''));
    const started = match ? parse_process_start([match[3], match[4], match[5], match[6], match[7]]) : null;
    // Checked before trimming: only trailing spaces are padding.
    const raw = match ? match[8] : '';
    const path = raw.replace(/ +$/, '');
    if (started === null || _UNSAFE_PATH.test(raw) || !is_abs(path) || basename_of(path) !== SKY_SERVICE_NAME) {
      unparsed += 1;
      continue;
    }
    services.push({ pid: Number(match[1]), uid: Number(match[2]), path, started });
  }
  return [services, unparsed];
}

const stat_default = (path) => ({ st_ctime: statSync(path).ctimeMs / 1000 });

/** PurePosixPath(path).parents as a list. */
function path_parents(path) {
  const parts = path.split('/').filter((part) => part && part !== '.');
  const anchor = path.startsWith('/') ? '/' : '';
  const parents = [];
  for (let count = parts.length - 1; count >= 1; count--) parents.push(anchor + parts.slice(0, count).join('/'));
  if (parts.length >= 1) parents.push(anchor || '.');
  return parents;
}

const child_path = (parent, name) => (parent === '.' ? name : parent.endsWith('/') ? parent + name : `${parent}/${name}`);

/**
 * The change times (ctime) of the executable, Info.plist and code-signature seal, or null.
 *
 * An app update replaces the whole bundle: observed live, all 167 files had the update
 * time as ctime while their mtimes (build time) and creation times were days to months
 * older, so neither of those can detect it. The bundle counts as replaced at the oldest
 * of the three, so one metadata change (chmod, an extended attribute) on a single file
 * does not read as an update, and a missing or unreadable file gives null, not a guess.
 * Starting the service does not change ctime.
 */
export function bundle_change_times(executable, stat = stat_default) {
  try {
    const parents = path_parents(String(executable));
    if (parents.length < 2) return null; // IndexError
    const contents = parents[1];
    return [String(executable), child_path(contents, 'Info.plist'),
      child_path(child_path(contents, '_CodeSignature'), 'CodeResources')].map((path) => stat(path).st_ctime);
  } catch (error) {
    if (isOSError(error)) return null;
    throw error;
  }
}

/**
 * English month names and UTC times; UTF-8 so `ps` does not escape non-ASCII paths.
 *
 * No COLUMNS, which would make `ps` cut paths and hide services from the listing.
 */
function _ps_environment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'LC_ALL' && key !== 'COLUMNS') environment[key] = value;
  }
  return Object.assign(environment, { LC_TIME: 'C', LC_CTYPE: 'UTF-8', TZ: 'UTC' });
}

/** subprocess.Popen(stdin=DEVNULL, stdout/stderr=PIPE, text) for bounded_run: communicate(timeout), kill(), abandon(). */
function popen_default(args, { env } = {}) {
  let child = null;
  let spawnError = null;
  try {
    child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env });
  } catch (error) {
    spawnError = fromNodeError(error) ?? error;
  }
  const out = [];
  const err = [];
  const process_ = {
    returncode: null,
    // Only ever this module's own child.
    kill() { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); },
    // The child outlived SIGKILL: stop waiting for it (it is reaped whenever the kernel lets it go).
    abandon() { child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref(); },
    // communicate(timeout): the text output once the child has ended and its pipes are closed, or TimeoutExpired.
    communicate(seconds) {
      return new Promise((resolveCommunicate, rejectCommunicate) => {
        const timer = setTimeout(() => rejectCommunicate(new TimeoutExpired(args, seconds * 1000)), seconds * 1000);
        closed.then((failure) => {
          clearTimeout(timer);
          if (failure) rejectCommunicate(failure);
          else resolveCommunicate([textOf(Buffer.concat(out), 'replace'), textOf(Buffer.concat(err), 'replace')]);
        });
      });
    },
  };
  const closed = new Promise((resolveClosed) => {
    if (!child) { resolveClosed(spawnError); return; }
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.once('error', (error) => resolveClosed(fromNodeError(error) ?? error));
    child.once('close', (code, signal) => {
      process_.returncode = code !== null ? code : -(SIGNALS[signal] ?? 0);
      resolveClosed(null);
    });
  });
  return process_;
}

/**
 * Run a system tool and return its status and text output, never waiting much past `timeout` (seconds).
 *
 * subprocess.run waits without a bound for a child it killed; a tool blocked in the kernel
 * (a hung network volume) can outlive SIGKILL. After one second more it is abandoned.
 */
export async function bounded_run(args, { timeout, env = undefined, popen = popen_default } = {}) {
  const process_ = popen(args, { env });
  let stdout;
  let stderr;
  try {
    [stdout, stderr] = await process_.communicate(timeout);
  } catch (error) {
    if (!(error instanceof TimeoutExpired)) throw error;
    process_.kill();
    try {
      await process_.communicate(1);
    } catch (second) {
      if (!(second instanceof TimeoutExpired)) throw second;
      process_.abandon?.();
    }
    throw new TimeoutExpired(args, timeout * 1000);
  }
  return { returncode: process_.returncode, stdout, stderr };
}

/** Running Sky services (or just `pid`) from `ps`, as [services, unparsed]: how many service rows could not be read. */
export async function list_sky_services({ run = bounded_run, pid = null } = {}) {
  const selection = pid === null ? ['-axo'] : ['-p', String(pid), '-o'];
  // -ww: unlimited width; without a terminal `ps` would cut long paths and hide services.
  const result = await run([PS, '-ww', ...selection, 'pid=,uid=,lstart=,comm='], {
    stdin: 'devnull', capture_output: true, timeout: 2, check: false, encoding: 'utf-8', errors: 'replace',
    env: _ps_environment() });
  // `ps -p` exits 1 with no output when that process is gone.
  if (result.returncode !== 0 && !(pid !== null && result.returncode === 1 && pyStrip(result.stdout) === '')) {
    throw new ValueError(`ps exited with status ${result.returncode}.`);
  }
  return parse_process_table(result.stdout);
}

/** List running Sky services and flag those started before their bundle was replaced. Kills nothing. */
export async function diagnose_sky_services({ run = bounded_run, stat = stat_default } = {}) {
  const [found, unparsed] = await list_sky_services({ run });
  const services = [];
  for (const service of found) {
    const times = bundle_change_times(service.path, stat);
    services.push({ ...service, bundle_times: times,
      stale: times !== null && Math.min(...times) > service.started + STALE_MARGIN_SECONDS });
  }
  return { services, unparsed };
}

/** Run `work` once at a time; callers arriving meanwhile share the running call's result. */
export class SingleFlight {
  constructor(work, { wait_seconds = 5, unfinished = 'The Computer Use service recovery did not finish.' } = {}) {
    this.work = work;
    this.wait_seconds = wait_seconds;
    this.unfinished = unfinished;
    this.current = null;
  }

  /** Python's __call__. */
  async run(...args) {
    let flight = this.current;
    const leader = flight === null;
    if (leader) {
      let finish;
      flight = this.current = { done: new Promise((resolveDone) => { finish = resolveDone; }), finish, result: null };
    }
    if (leader) {
      try {
        flight.result = await this.work(...args);
      } finally {
        this.current = null;
        flight.finish();
      }
    } else {
      let timer;
      await Promise.race([flight.done, new Promise((resolveWait) => { timer = setTimeout(resolveWait, this.wait_seconds * 1000); })]);
      clearTimeout(timer);
    }
    return flight.result || { ok: false, error: this.unfinished };
  }
}

// Recovery. A Computer Use service whose bundle was replaced while it ran keeps the socket
// lock and rejects every client. When, and only when, every check below agrees that one
// service is that stale holder, it is asked to quit (SIGTERM) so the original client can
// start a current one. Every step is bounded; any doubt means no action.
export const CODESIGN_TIMEOUT_SECONDS = 4;
export const LSOF_TIMEOUT_SECONDS = 3;
// The signal must follow the start of the recovery within this many seconds of this host's
// monotonic clock (the requester waits 15 s for the answer, including the exit wait below).
export const SIGNAL_BUDGET_SECONDS = 9;
export const PEER_LOCK_WAIT_SECONDS = 4;
export const TERMINATE_WAIT_SECONDS = 3;
export const TERMINATE_POLL_SECONDS = 0.1;
export const RECOVERY_WAIT_SECONDS = 16;
// What `codesign --verify <pid>` prints when the code that is running is not the code now on
// disk (errSecCSStaticCodeChanged). A healthy service prints `dynamically valid`, `valid on
// disk` and exits 0. Any other failure (a vanished pid, a usage error, a broken seal) does
// not prove that the running service is stale, so it is not enough.
export const SIGNATURE_MISMATCH_MARKERS = Object.freeze(['the code on disk does not match what is running']);
// confstr(3) name for the per-user temporary directory (asked of getconf(1): Node has no confstr).
const _CS_DARWIN_USER_TEMP_DIR = 'DARWIN_USER_TEMP_DIR';
export const SERVICE_EXECUTABLE = `Contents/MacOS/${SKY_SERVICE_NAME}`;

const is_subprocess_failure = (error) => isOSError(error) || error instanceof SubprocessError;

/**
 * 'valid', 'invalid' (the running code differs from the code on disk) or 'unknown'.
 *
 * `codesign --verify <pid>` validates the running code against its signature on disk, so
 * a bundle replaced under a running process fails it, and a healthy service passes.
 */
export async function verify_service_signature(pid, { run = bounded_run } = {}) {
  let result;
  try {
    result = await run([CODESIGN, '--verify', '--strict', String(pid)], {
      stdin: 'devnull', capture_output: true, timeout: CODESIGN_TIMEOUT_SECONDS, check: false,
      encoding: 'utf-8', errors: 'replace', env: _ps_environment() });
  } catch (error) {
    if (is_subprocess_failure(error)) return 'unknown';
    throw error;
  }
  if (result.returncode === 0) return 'valid';
  const detail = `${result.stderr || ''} ${result.stdout || ''}`.toLowerCase();
  if (result.returncode === 1 && SIGNATURE_MISMATCH_MARKERS.some((marker) => detail.includes(marker))) return 'invalid';
  return 'unknown';
}

/**
 * The complete set of pids with the service's socket lock file open, or null when unsure.
 *
 * Only a clean answer counts: pids and no diagnostics, or no pids, no diagnostics and
 * lsof's "nothing found" status. A warning, an error status or odd output is unknown.
 */
export async function lock_holders(lock_path, { run = bounded_run } = {}) {
  if (!lock_path || !is_abs(lock_path)) return null;
  let result;
  try {
    result = await run([LSOF, '-t', '--', lock_path], {
      stdin: 'devnull', capture_output: true, timeout: LSOF_TIMEOUT_SECONDS, check: false,
      encoding: 'utf-8', errors: 'replace' });
  } catch (error) {
    if (is_subprocess_failure(error)) return null;
    throw error;
  }
  const lines = (result.stdout || '').split(/\s+/).filter(Boolean);
  const clean = pyStrip(result.stderr || '') === '' && lines.every((line) => /^[0-9]+$/.test(line)) &&
    ((result.returncode === 0 && lines.length > 0) || (result.returncode === 1 && lines.length === 0));
  return clean ? new Set(lines.map(Number)) : null;
}

/**
 * The executable path the kernel reports for a pid, or null.
 *
 * `ps` shows argv[0], which a process can choose; this is the file actually running.
 * ADAPTATION: Python asks proc_pidpath through ctypes; Node cannot, so the first text (executable) mapping that
 * `lsof` reports for the pid is used, which comes from the same kernel vnode information. Anything unexpected is
 * null, which refuses the recovery.
 */
export async function executable_path(pid, { run = bounded_run } = {}) {
  if (stale_internals.platform !== 'darwin' || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return null;
  try {
    const result = await run([LSOF, '-a', '-p', String(pid), '-d', 'txt', '-Fn'], {
      stdin: 'devnull', capture_output: true, timeout: LSOF_TIMEOUT_SECONDS, check: false,
      encoding: 'utf-8', errors: 'replace' });
    if (result.returncode !== 0 || pyStrip(result.stderr || '') !== '') return null;
    const lines = (result.stdout || '').split('\n');
    if (lines[0] !== `p${pid}`) return null;
    const entry = lines.slice(1).find((line) => line.startsWith('n'));
    return entry && is_abs(entry.slice(1)) ? entry.slice(1) : null;
  } catch (error) {
    if (is_subprocess_failure(error)) return null;
    throw error;
  }
}

const monotonic_default = () => monotonic();

/**
 * Exclusion between the LCU hosts of this account (one per MCP connection).
 *
 * An advisory flock on a file in the account's private temporary directory, held for the
 * whole recovery including the wait for the service to exit. Another host recovering at the
 * same time makes this one wait (bounded). The file names the last service instance that
 * was asked to quit, so no host asks the same instance twice.
 *
 * Python's `with PeerLock() as peer:` is `const peer = await lock.enter(); try { ... } finally { lock.exit(); }`.
 * Node has no flock(2): the lock is taken by compat/lock.mjs, whose open file description this class then reads
 * and writes (positional reads and writes, like pread/pwrite).
 */
export class PeerLock {
  constructor(path = null, { wait_seconds = PEER_LOCK_WAIT_SECONDS, sleep = sleep_seconds, monotonic: clock = monotonic_default } = {}) {
    this.path = path || PeerLock.default_path();
    this.wait_seconds = wait_seconds;
    this.sleep = sleep;
    this.monotonic = clock;
    this.lock = null;
    this.descriptor = null;
    this.acquired = false;
    this.previous = null;
  }

  /** The account's private temporary directory by the system's own answer, not $TMPDIR. */
  static default_path() {
    try {
      const getconf = trustedTool('getconf', ['/usr/bin']);
      if (!getconf) return null;
      const result = runTool(getconf, [_CS_DARWIN_USER_TEMP_DIR], { encoding: 'utf8' });
      const directory = result.status === 0 && !result.error ? result.stdout.replace(/\n$/, '') : '';
      if (!directory || !is_abs(directory)) return null;
      return pyJoin(directory, `lcu-stale-service-recovery-${process.getuid()}.lock`);
    } catch {
      return null;
    }
  }

  async enter() {
    if (!this.path) return this;
    const deadline = this.monotonic() + this.wait_seconds;
    for (;;) {
      // One non-blocking attempt (LOCK_EX | LOCK_NB); the file is opened as O_RDWR | O_CREAT | O_NOFOLLOW, 0600.
      let lock;
      try {
        lock = await acquire(this.path, { timeout: 0 });
      } catch (error) {
        if (error instanceof LockTimeoutError) {
          if (this.monotonic() >= deadline) return this;
          await this.sleep(0.05);
          continue;
        }
        return this; // not acquired: the file cannot be opened, or the lock helper is unusable
      }
      this.lock = lock;
      this.descriptor = lock.fd;
      this.acquired = true;
      this.previous = this._read();
      return this;
    }
  }

  _read() {
    try {
      const buffer = Buffer.alloc(1024);
      const count = stale_internals.read(this.descriptor, buffer, 1024, 0);
      const record = loads(decode(buffer.subarray(0, count)));
      return record instanceof Map ? record : null;
    } catch (error) {
      if (isOSError(error) || error instanceof ValueError) return null;
      throw error;
    }
  }

  /** Keep `outcome` for the next holder of the lock; true only when it is on disk whole. */
  record(outcome) {
    try {
      const data = Buffer.from(dumps(outcome), 'utf8');
      stale_internals.truncate(this.descriptor, 0);
      // A short write (a file size limit) would leave a record nobody can read.
      if (stale_internals.write(this.descriptor, data, 0) !== data.length) return false;
      const back = Buffer.alloc(data.length + 1);
      const count = stale_internals.read(this.descriptor, back, data.length + 1, 0);
      return back.subarray(0, count).equals(data);
    } catch (error) {
      if (isOSError(error) || error instanceof ValueError || error instanceof TypeError) return false;
      throw error;
    }
  }

  exit() {
    if (this.lock !== null) {
      const lock = this.lock;
      this.lock = null;
      try {
        lock.release(); // closing releases the flock
      } finally {
        this.descriptor = null;
      }
    }
    return false;
  }
}

/** The default peer lock for recover_stale_service (Python passes the class itself). */
export const peer_lock = () => new PeerLock();

/** The defaults of recover_stale_service's `exclusive` and `waiting`, for tests that check them. */
export const recovery_defaults = Object.freeze({ exclusive: peer_lock, waiting: () => false });

/**
 * Executables of the two bundles LCU may stop a service from: the one it launches and the app's copy.
 *
 * A bundle whose service executable resolves (through a symlink) to somewhere outside the
 * bundle contributes nothing.
 */
export function known_service_executables(environment = null, realpath = pyRealpath) {
  environment = environment === null ? process.env : environment;
  const bundles = [environment.SKY_CUA_SERVICE_PATH];
  const codex_home = environment.CODEX_HOME;
  if (codex_home) bundles.push(pyJoin(codex_home, 'computer-use', 'Codex Computer Use.app'));
  const executables = new Set();
  for (const bundle of bundles) {
    if (!bundle || !is_abs(bundle)) continue;
    const root = realpath(bundle);
    const executable = realpath(pyJoin(bundle, SERVICE_EXECUTABLE));
    if (basename_of(executable) === SKY_SERVICE_NAME && commonpath2(root, executable) === root && executable !== root) {
      executables.add(executable);
    }
  }
  return executables;
}

/** Existence probe with signal 0 (never delivers anything); pid must be a single process. */
export function _process_exists(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) {
    throw new ValueError('refusing to probe a non-process id');
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
  return true;
}

/**
 * True while the requester's connection is open and it has sent nothing more.
 *
 * `connection` is the LineReader of the requester's connection (it collects whatever arrives). The requester
 * closes its end when it stops waiting for the answer, which ends the connection here. Ended, failed, more data or
 * any error means nobody would retry.
 */
export function requester_waiting(connection) {
  try {
    const socket = connection.connection;
    return !(connection.buffer.length > 0 || connection.ended || connection.failure ||
      socket.destroyed || socket.readableEnded || !socket.readable);
  } catch {
    return false;
  }
}

/** `check failed: ` + str(exc)[:200] */
const check_failed = (exc) => `check failed: ${cpSlice(excStr(exc), 200)}`;

const one_holder = (holder_set, pid) => holder_set instanceof Set && holder_set.size === 1 && holder_set.has(pid);
const field = (record, key) => (record instanceof Map ? record.get(key) : record?.[key]);
const kill_default = (pid, signal) => process.kill(pid, signal);

/** tuple equality of two change-time lists (or null). */
function same_times(left, right) {
  if (left === null || right === null || left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Quit the one Computer Use service that is provably stale and holds the connection.
 *
 * In this order, and any failed or inconclusive step means nothing is signaled:
 * 1. only this LCU host of the account is recovering (a flock, held through the exit wait);
 * 2. the process listing is complete and exactly one service started before its bundle was
 *    replaced (the change times of its executable, Info.plist and seal);
 * 3. it is a single process (pid > 1, not this one) of the current user, named exactly
 *    SkyComputerUseService, whose path and kernel-reported executable are the one in a
 *    known bundle;
 * 4. this instance (pid and start time) was never asked to quit before;
 * 5. it is the only process holding the socket lock (among those lsof can see), and
 *    `codesign --verify` rejects its running code as different from the code on disk;
 * 6. the instance is recorded as asked (no record, no signal; the previous record is put
 *    back if no signal follows);
 * 7. last, with nothing slow after the process read: the lock holders, then the bundle's
 *    change times, then the process itself (`ps -p`) and its kernel executable all match
 *    what was checked, the recovery is within its time budget on this host's monotonic
 *    clock, and the requester is still waiting for the answer.
 * Then that one pid gets SIGTERM (never a group, never SIGKILL), it is given at most 3
 * seconds to exit, and one line is logged. A pid can still be recycled in the instants
 * between the last read and the signal; macOS has no process handle that closes that gap.
 */
export async function recover_stale_service({
  lock_path, executables, uid = null, diagnose = diagnose_sky_services, read_process = list_sky_services,
  change_times = bundle_change_times, verify = verify_service_signature, holders = lock_holders,
  kernel_path = executable_path, kill = kill_default, exists = _process_exists, realpath = pyRealpath,
  sleep = sleep_seconds, monotonic: clock = monotonic, exclusive = recovery_defaults.exclusive,
  waiting = recovery_defaults.waiting, log = null,
} = {}) {
  const nothing = (reason) => ({ ok: true, recovered: false, reason });

  uid = uid === null ? process.getuid() : uid;
  const started = clock();
  let pid;
  let path;
  let exited = false;
  let elapsed_ms;
  try {
    const guard = exclusive();
    const peer = await guard.enter();
    try {
      if (!peer.acquired) return nothing('another LCU process is recovering');
      const diagnosis = await diagnose();
      if (diagnosis.unparsed) return nothing('the process listing was incomplete');
      // Only this account's services: another user's cannot hold this account's lock.
      const stale = diagnosis.services.filter((item) => item.stale && item.uid === uid);
      if (stale.length === 0) return nothing('no stale service');
      if (stale.length !== 1) return nothing('more than one stale service');
      const service = stale[0];
      pid = service.pid;
      path = service.path;
      const start = service.started;
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return nothing('not a single service process');
      if (service.uid !== uid) return nothing('the stale service belongs to another user');
      if (basename_of(path) !== SKY_SERVICE_NAME || !executables.has(realpath(path))) {
        return nothing('the stale service is not in a known Computer Use bundle');
      }
      const kernel = await kernel_path(pid);
      const previous = peer.previous || new Map();
      if (!(kernel && basename_of(kernel) === SKY_SERVICE_NAME && realpath(kernel) === realpath(path))) {
        return nothing('the kernel does not report the known executable for the stale service');
      }
      if (equal(field(previous, 'pid') ?? null, pid) && equal(field(previous, 'started') ?? null, pyfloat(start))) {
        // Never twice for one instance: a service that outlived SIGTERM is left alone.
        return nothing('this service was already asked to quit');
      }
      if (!one_holder(await holders(lock_path), pid)) {
        return nothing('the stale service is not the only holder of the socket lock');
      }
      if ((await verify(pid)) !== 'invalid') {
        return nothing('the running service passes signature verification, or it could not be checked');
      }
      if (!peer.record(dict([['pid', pid], ['started', pyfloat(start)]]))) return nothing('the attempt could not be recorded');
      let reason;
      try {
        if (!one_holder(await holders(lock_path), pid)) {
          reason = 'the socket lock changed hands while it was being checked';
        } else if (!same_times(await change_times(path), service.bundle_times)) {
          reason = 'the service bundle changed while it was being checked';
        } else {
          const [rows, unparsed] = await read_process({ pid }); // the process itself, read last
          if (unparsed || rows.length !== 1 || rows[0].pid !== pid || rows[0].uid !== service.uid ||
              rows[0].started !== start || rows[0].path !== path || (await kernel_path(pid)) !== kernel) {
            reason = 'the service changed while it was being checked';
          } else if (clock() - started > SIGNAL_BUDGET_SECONDS) {
            reason = 'the checks took too long to act on';
          } else if (!(await waiting())) {
            reason = 'the request stopped waiting for the recovery';
          } else {
            reason = null;
          }
        }
      } catch (exc) {
        if (exc instanceof PySystemExit) throw exc;
        reason = check_failed(exc);
      }
      if (reason) {
        // Back to the previous record, so an instance asked earlier stays recorded.
        peer.record(peer.previous || new Map());
        return nothing(reason);
      }
      kill(pid, SIGNALS.SIGTERM);
      try {
        const deadline = clock() + TERMINATE_WAIT_SECONDS;
        while (!exited && clock() < deadline) {
          exited = !(await exists(pid));
          if (!exited) await sleep(TERMINATE_POLL_SECONDS);
        }
      } finally {
        elapsed_ms = Math.trunc((clock() - started) * 1000);
        if (log) {
          log(`LCU macOS sent SIGTERM to stale Computer Use service pid ${pid} (${path}); ` +
            (exited ? `it exited after ${elapsed_ms} ms` : `it did not exit within ${TERMINATE_WAIT_SECONDS} seconds`));
        }
      }
    } finally {
      guard.exit();
    }
  } catch (exc) {
    if (exc instanceof PySystemExit) throw exc;
    return nothing(check_failed(exc));
  }
  if (!exited) return nothing(`pid ${pid} did not exit within ${TERMINATE_WAIT_SECONDS} seconds of SIGTERM`);
  return { ok: true, recovered: true, pid, path, elapsed_ms };
}

export async function recover_response(waiting = null) {
  if (stale_internals.platform !== 'darwin') return { ok: true, recovered: false, reason: 'not macOS' };
  return stale_internals.recover_stale_service({
    lock_path: process.env.LCU_MAC_SERVICE_LOCK ?? null, executables: known_service_executables(),
    waiting: waiting || (() => false),
    log: (line) => writeFd(2, `${line}\n`),
  });
}

export const shared_recovery = new SingleFlight(recover_response, { wait_seconds: RECOVERY_WAIT_SECONDS });
stale_internals.shared_recovery = shared_recovery;

/** Run (or join) the recovery for this requester and answer on its connection, then close it. */
export async function answer_recover(reader) {
  try {
    const result = await stale_internals.shared_recovery.run(() => requester_waiting(reader));
    await reader.sendAndClose(frame(result), 3000);
  } catch (error) {
    // except OSError: pass. Anything else would have ended Python's thread with a traceback; the host goes on.
    if (!isOSError(error)) {
      try { writeFd(2, `LCU macOS recovery answer failed: ${cpSlice(excStr(error), 256)}\n`); } catch { /* stderr gone */ }
    }
  } finally {
    reader.close();
  }
}

// ------------------------------------------------------------------------------------------ public API

export function turn_ended_payload(session_id, turn_id) {
  return dumps(dict([
    ['type', 'agent-turn-complete'],
    ['thread-id', session_id],
    ['turn-id', turn_id],
  ]), { separators: [',', ':'] });
}

const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
const isDir = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };

/** tempfile.TemporaryDirectory(prefix=..., dir=...). */
export class TemporaryDirectory {
  constructor(prefix, dir) {
    this.name = mkdtemp({ prefix, dir });
  }

  cleanup() {
    rmSync(this.name, { recursive: true, force: true });
  }
}

/** The subprocess.Popen subset LCU uses: wait(timeout), terminate(), returncode, stdin/stdout. */
export class HostProcess {
  constructor(child, args) {
    this.child = child;
    this.args = args;
    this.pid = child.pid;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.returncode = null;
    this.stdin?.on('error', () => {});
    this.stdout?.on('error', () => {});
    child.on('error', () => {});
    this.exited = new Promise((resolveExit) => {
      child.once('exit', (code, signal) => {
        this.returncode = code !== null ? code : -(SIGNALS[signal] ?? 0);
        resolveExit(this.returncode);
      });
    });
  }

  poll() {
    return this.returncode;
  }

  /** wait(timeout=seconds): returncode, or TimeoutExpired. */
  async wait(seconds) {
    if (this.returncode !== null) return this.returncode;
    let timer;
    const timeout = new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(null), seconds * 1000); });
    const status = await Promise.race([this.exited, timeout]);
    clearTimeout(timer);
    if (status === null) throw new TimeoutExpired(this.args, seconds * 1000);
    return status;
  }

  terminate() {
    // Only ever this module's own child handle; tests verify its identity/session first (internals.before_signal).
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    internals.before_signal(this);
    try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

/**
 * Python's subprocess calls execve() directly, so a file the kernel cannot execute fails with ENOEXEC
 * ("[Errno 8] Exec format error: '<file>'"). libuv uses execvp(), whose ENOEXEC fallback runs the file with
 * /bin/sh instead. The shared compat/subprocess seam predicts that case (compat/execve preflight) and this module
 * raises Python's error instead of spawning.
 */
export function exec_format_check(file, env = process.env) {
  const failure = execFormatError([file], env);
  if (failure) throw failure;
}

/**
 * Test hooks only (no-ops in production): extra spawn options for the host child (tests set {detached: true} so
 * every process they may signal runs in its own session, like Python's Popen otherwise), after_spawn(handle) to
 * record the child's identity, before_signal(handle) to verify it (throwing refuses the signal). Signals are only
 * ever sent through the ChildProcess handles this module spawned itself (never to pids read from elsewhere).
 */
export const internals = {
  spawn_options: {},
  after_spawn: () => {},
  before_signal: () => {},
};

/** Spawn with stdin/stdout piped and stderr inherited; resolves after the process exists. */
export function popen(command, { env, cwd } = {}) {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const options = { ...internals.spawn_options, stdio: ['pipe', 'pipe', 'inherit'], env };
    if (cwd !== undefined) options.cwd = cwd;
    try {
      exec_format_check(command[0], env ?? process.env);
    } catch (error) {
      rejectSpawn(error);
      return;
    }
    const child = spawn(command[0], command.slice(1), options);
    child.once('error', (error) => rejectSpawn(Object.assign(new Error(spawnErrorText(error)), { name: error.code === 'ENOENT' ? 'FileNotFoundError' : 'OSError' })));
    child.once('spawn', () => {
      child.removeAllListeners('error');
      const handle = new HostProcess(child, command);
      internals.after_spawn(handle);
      resolveSpawn(handle);
    });
  });
}

/** Process.stdout.readline() with queue.get(timeout): the first line, a partial final line, or EmptyQueue. */
export function readLine(stream, seconds) {
  return new Promise((resolveLine, rejectLine) => {
    let buffer = Buffer.alloc(0);
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.off('error', onEnd);
      stream.pause();
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline >= 0) {
        cleanup();
        resolveLine(buffer.subarray(0, newline + 1));
      }
    };
    const onEnd = () => { cleanup(); resolveLine(buffer); };
    timer = setTimeout(() => { cleanup(); rejectLine(new EmptyQueue()); }, seconds * 1000);
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('close', onEnd);
    stream.on('error', onEnd);
  });
}

/**
 * Start a private Unix-socket bridge and wait for its readiness record.
 * `node` replaces Python's `python` (the app Node); `python` is accepted as an alias. `entry` is
 * <release>/lcu/entry.mjs (or this module, which has its own main guard).
 */
export async function start_original_host({ node, python, client, entry, env, control_address = null } = {}) {
  const runner = node ?? python;
  const executable = (() => { try { accessSync(client, fsConstants.X_OK); return true; } catch { return false; } })();
  if (!isFile(client) || !executable || !isFile(entry)) {
    throw new ValueError('The selected original macOS computer-use client is incomplete.');
  }
  const socketDir = isDir('/private/tmp') ? '/private/tmp' : null;
  const temporary = new TemporaryDirectory('lcu-ml-', socketDir);
  const address = join(temporary.name, 'lifetime.sock');
  const command = [String(runner), String(entry)];
  if (basename(String(entry)) !== 'macos_host.mjs') command.push('macos-host');
  command.push('serve', address, String(client));
  if (control_address) command.push(control_address);
  let process_;
  try {
    process_ = await popen(command, { env });
  } catch (error) {
    temporary.cleanup();
    throw error;
  }
  try {
    const line = await readLine(process_.stdout, 5);
    const state = loads(line);
    if (!equal(state, dict([['ready', true], ['socket', address]]))) {
      throw new ValueError('Original macOS lifecycle host reported an invalid socket.');
    }
    return [process_, temporary, address];
  } catch (exc) {
    if (!(exc instanceof EmptyQueue || exc instanceof ValueError)) throw exc;
    await stop_original_host(process_, temporary, { require_success: false });
    throw new ValueError('Original macOS lifecycle host failed to become ready.');
  }
}

/** Dispose only the lifetime host owned by this LCU MCP connection. */
export async function stop_original_host(process_, temporary, { require_success = true } = {}) {
  if (process_.stdin && !process_.stdin.destroyed && !process_.stdin.writableEnded) process_.stdin.end();
  let status;
  try {
    try {
      status = await process_.wait(5);
    } catch (error) {
      if (!(error instanceof TimeoutExpired)) throw error;
      process_.terminate();
      status = await process_.wait(2);
    }
  } finally {
    process_.stdout?.destroy();
    temporary.cleanup();
  }
  if (require_success && status !== 0) {
    throw new ValueError(`Original macOS lifecycle host exited with status ${status}.`);
  }
}

// ------------------------------------------------------------------------------------------ control bridge

export class TrustedControlBridge {
  /** Route human control through the original trusted Sky service. */
  constructor() {
    this.changed = new Condition();
    this.service = null; // LineReader of the connected trusted service
    this.active = new Map();
    this.pending = new Map();
  }

  /**
   * Listen on `address`. `ready(null | error)` is called once (Python's Queue); without `ready` a failure rejects.
   * The returned promise settles when the accept loop ends (never in normal operation).
   */
  async serve(address, ready = null) {
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      this.handle(new LineReader(socket)).catch(() => {});
    });
    this.server = server;
    let bound = false;
    try {
      try {
        await listenPrivate(server, address);
        bound = true;
        chmodSync(address, 0o600);
      } catch (error) {
        throw fromNodeError(error) ?? error;
      }
    } catch (exc) {
      if (ready) ready(exc);
      try { server.close(); } catch { /* not listening */ }
      if (bound) unlinkQuiet(address);
      if (ready) return;
      throw exc;
    }
    if (ready) ready(null);
    await new Promise((resolveClosed) => server.once('close', resolveClosed));
    unlinkQuiet(address);
  }

  async handle(reader) {
    try {
      let response;
      try {
        reader.timeout = 3000;
        const request = await reader.read();
        if (request instanceof Map && request.get('type') === 'service') {
          await this._serve_service(reader);
          return;
        }
        response = await this._request(request);
      } catch (exc) {
        response = dict([['ok', false], ['error', cpSlice(excStr(exc), 512)]]);
      }
      await reader.sendAndClose(frame(response), 43000);
    } finally {
      reader.close();
    }
  }

  async _serve_service(reader) {
    reader.timeout = null;
    if (this.service !== null) throw new ValueError('A trusted macOS control service is already connected.');
    this.service = reader;
    this.changed.notify_all();
    try {
      for (;;) {
        const message = await reader.read(65536);
        if (!(message instanceof Map)) throw new ValueError('Invalid trusted macOS control message.');
        const kind = message.get('type');
        if (kind === 'context') {
          const token = message.get('token');
          const session_id = message.get('session_id');
          const turn_id = message.get('turn_id');
          if (!(typeof token === 'string' && token !== '') || !nonBlank(session_id) || !nonBlank(turn_id)) {
            throw new ValueError('Trusted macOS control context is missing IDs.');
          }
          const app = message.get('app');
          if (app !== undefined && app !== null && !nonBlank(app)) {
            throw new ValueError('Trusted macOS control context has an invalid app ID.');
          }
          this.active.set(token, [session_id, turn_id, app === undefined ? null : app]);
          this.changed.notify_all();
        } else if (kind === 'context-ended') {
          const token = hashable(message.get('token'));
          if (typeof token === 'string') this.active.delete(token);
          this.changed.notify_all();
        } else if (kind === 'result') {
          const request_id = hashable(message.get('request_id'));
          const waiter = typeof request_id === 'string' ? this.pending.get(request_id) : undefined;
          if (waiter !== undefined) {
            const response = message.get('response');
            waiter.response = response === undefined ? null : response;
            waiter.ready = true;
            this.changed.notify_all();
          }
        } else {
          throw new ValueError('Unknown trusted macOS control message.');
        }
      }
    } catch (exc) {
      // except (OSError, ValueError, json.JSONDecodeError): pass
      if (!(isOSError(exc) || exc instanceof ValueError)) throw exc;
    } finally {
      if (this.service === reader) {
        this.service = null;
        this.active.clear();
        for (const waiter of this.pending.values()) {
          waiter.response = dict([['ok', false], ['error', 'Trusted macOS control service disconnected.']]);
          waiter.ready = true;
        }
      }
      this.changed.notify_all();
    }
  }

  async _request(request) {
    if (!(request instanceof Map) || !['status', 'stop'].includes(request.get('type'))) {
      throw new ValueError('Unsupported macOS control request.');
    }
    const session_id = request.get('session_id');
    const turn_id = request.get('turn_id');
    if (!nonBlank(session_id) || !nonBlank(turn_id)) {
      throw new ValueError('Real macOS control session and turn IDs are required.');
    }
    const app = request.get('app') ?? null;
    if (request.get('type') === 'stop' && !nonBlank(app)) {
      throw new ValueError('An application bundle ID is required to stop computer use.');
    }
    const deadline = monotonic() + 40;
    while (this.service === null && monotonic() < deadline) await this.changed.wait(deadline - monotonic());
    if (this.service === null) throw new ValueError('Trusted macOS control service is not connected.');
    const contexts = [...this.active.values()].filter((active) => active[0] === session_id && active[1] === turn_id);
    if (contexts.length === 0) {
      throw new ValueError('The requested session and turn are not active in the trusted runtime.');
    }
    const remaining_ms = Math.trunc((deadline - monotonic()) * 1000);
    if (remaining_ms <= 0) throw new ValueError('Original macOS control request timed out.');
    const request_id = randomUUID();
    const waiter = { ready: false, response: null };
    this.pending.set(request_id, waiter);
    const message = dict([
      ['type', request.get('type')], ['request_id', request_id],
      ['session_id', session_id], ['turn_id', turn_id],
      ['deadline_unix_ms', Math.trunc(unixMs() + remaining_ms)],
    ]);
    if (app !== null) message.set('app', app);
    const failure = await this.service.write(frame(message));
    if (failure) {
      this.pending.delete(request_id);
      throw new ValueError('Trusted macOS control service is unavailable.');
    }
    while (!waiter.ready && monotonic() < deadline) await this.changed.wait(deadline - monotonic());
    this.pending.delete(request_id);
    if (!waiter.ready) throw new ValueError('Original macOS control request timed out.');
    const response = waiter.response;
    if (!(response instanceof Map)) throw new ValueError('Trusted macOS control service returned an invalid response.');
    return response;
  }
}

// ------------------------------------------------------------------------------------------ lifetime host

/**
 * subprocess.run([client, 'turn-ended', payload], stdin=DEVNULL, stdout/stderr=PIPE, timeout=timeout, check=False)
 * -> { returncode, stderr }. Like communicate(), completion waits for both pipes to close; on the timeout the client
 * is killed only if it has not exited yet (Popen.kill polls first), reaped, its pipes are closed and TimeoutExpired
 * (carrying the stderr read so far, as exc.stderr) is raised, even when a descendant still holds the pipes open.
 */
/** Popen raises an OSError for a failed spawn; keep its strerror for run_turn_ended. */
function spawnFailure(error) {
  const failure = new Error(spawnErrorText(error));
  failure.isOSError = true;
  failure.strerror = fromNodeError(error)?.strerror;
  return failure;
}

function runClient(client, payload, timeout = TURN_ENDED_CLI_TIMEOUT_SECONDS) {
  const command = [client, 'turn-ended', payload];
  return new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      exec_format_check(command[0]);
      child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      rejectRun(error instanceof PyOSError ? error : spawnFailure(error));
      return;
    }
    let settled = false;
    let exited = false;
    let markExited;
    const exitedPromise = new Promise((resolveExit) => { markExited = resolveExit; });
    const stderrChunks = [];
    child.once('exit', () => {
      exited = true;
      markExited();
    });
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      if (!exited) child.kill('SIGKILL');
      await exitedPromise;
      child.stdout.destroy();
      child.stderr.destroy();
      const expired = new TimeoutExpired(command, timeout * 1000);
      expired.stderr = Buffer.concat(stderrChunks);
      rejectRun(expired);
    }, timeout * 1000);
    child.stdout.resume();
    child.stderr.on('data', (chunk) => { if (!settled) stderrChunks.push(chunk); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectRun(spawnFailure(error));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ returncode: code !== null ? code : -(SIGNALS[signal] ?? 0), stderr: Buffer.concat(stderrChunks) });
    });
  });
}

/** round(x) with Python's round-half-to-even. */
function pyRound(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Run the original turn-ended command; report slow or failed runs on stderr.
 *
 * The helper exits 0 even when it cannot reach the service (it only writes to
 * os_log), so a zero status does not prove delivery.
 */
export async function run_turn_ended(client, payload, timeout = TURN_ENDED_CLI_TIMEOUT_SECONDS) {
  const started = monotonic();
  let status = 'timeout';
  let stderr = Buffer.alloc(0);
  let failure = null;
  try {
    const result = await runClient(client, payload, timeout);
    status = result.returncode;
    stderr = result.stderr ?? Buffer.alloc(0);
    if (status !== 0) failure = new RuntimeError(`Original turn-ended command exited with status ${status}.`);
  } catch (exc) {
    if (exc instanceof TimeoutExpired) {
      stderr = exc.stderr ?? Buffer.alloc(0);
      failure = new RuntimeError(`Original turn-ended command timed out after ${timeout} seconds.`);
    } else if (isOSError(exc)) {
      status = 'launch-failed';
      stderr = Buffer.from(excStr(exc), 'utf8');
      failure = new RuntimeError(`Original turn-ended command could not start: ${exc.strerror || excStr(exc)}.`);
    } else {
      throw exc;
    }
  }
  const elapsed = monotonic() - started;
  if (failure !== null || elapsed >= TURN_ENDED_CLI_SLOW_SECONDS) {
    const text = pyStrip(new TextDecoder('utf-8').decode(stderr.subarray(0, STDERR_LOG_BYTES)));
    writeFd(2, `LCU macOS turn-ended command: exit=${status} elapsed=${pyRound(elapsed * 1000)} ms`
      + `${text ? ` stderr=${reprStr(text)}` : ''}
`);
  }
  if (failure !== null) throw failure;
}

// Connections accepted while one is being handled wait here unread, like the kernel backlog of Python's
// listen(8); further connections are closed at once instead of queueing without bound.
const BACKLOG = 8;
const STDIN_CHUNK = 8192;

/**
 * Python's sys.stdin.readline() over a TextIOWrapper: `kernel` holds bytes not yet read from fd 0, `buffer` what
 * the wrapper already pulled in. A readline blocks (and with it the whole select loop) until a newline or EOF.
 */
class StdinLines {
  constructor(stream, wake) {
    this.kernel = Buffer.alloc(0);
    this.buffer = Buffer.alloc(0);
    this.eof = false;
    this.stream = stream;
    stream.on('data', (chunk) => {
      this.kernel = Buffer.concat([this.kernel, chunk]);
      if (this.kernel.length > 65536) stream.pause();
      wake();
    });
    const end = () => { this.eof = true; wake(); };
    stream.on('end', end);
    stream.on('close', end);
    stream.on('error', end);
  }

  /** select() reports stdin readable. */
  readable() {
    return this.kernel.length > 0 || this.eof;
  }

  /** 'line' | 'eof' | 'blocked' (call again after more input). */
  readline() {
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline >= 0) {
        this.buffer = this.buffer.subarray(newline + 1);
        return 'line';
      }
      if (this.kernel.length) {
        const count = Math.min(STDIN_CHUNK, this.kernel.length);
        this.buffer = Buffer.concat([this.buffer, this.kernel.subarray(0, count)]);
        this.kernel = this.kernel.subarray(count);
        if (this.kernel.length <= 65536) this.stream.resume();
        continue;
      }
      if (this.eof) {
        if (this.buffer.length) {
          this.buffer = Buffer.alloc(0);
          return 'line';
        }
        return 'eof';
      }
      return 'blocked';
    }
  }
}

/** Accept bounded cleanup IDs and optional trusted-service control routing. Resolves when stdin closes. */
export async function serve(address, client, control_address = null, { stdin = process.stdin } = {}) {
  const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true });
  await listenPrivate(server, address);
  try {
    chmodSync(address, 0o600);
  } catch (error) {
    throw fromNodeError(error) ?? error;
  }
  let bridge = control_address ? new TrustedControlBridge() : null;
  if (bridge) {
    let timer;
    const bridgeReady = new Promise((resolveReady) => {
      bridge.serve(control_address, resolveReady).catch(() => {});
    });
    const timedOut = new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(new EmptyQueue()), 5000);
    });
    const failure = await Promise.race([bridgeReady, timedOut]);
    clearTimeout(timer);
    if (failure !== null) {
      writeFd(2, `LCU macOS user control unavailable: ${cpSlice(excStr(failure), 256)}\n`);
      bridge = null;
    }
  }
  writeFd(1, dumps(dict([['ready', true], ['socket', address]])) + '\n');

  let wakeUp = null;
  const wake = () => {
    const callback = wakeUp;
    wakeUp = null;
    if (callback) callback();
  };
  const sleep = () => new Promise((resolveWake) => { wakeUp = resolveWake; });
  const backlog = [];
  server.on('connection', (socket) => {
    socket.on('error', (error) => { socket.lcuFailure = error; });
    socket.on('close', () => { socket.lcuClosed = true; });
    if (backlog.length >= BACKLOG) {
      socket.destroy();
      return;
    }
    backlog.push(socket);
    wake();
  });
  const lines = new StdinLines(stdin, wake);

  const handle = async (reader) => {
    let detached = false;
    try {
      reader.timeout = 3000;
      let response;
      try {
        const request = await reader.read();
        if (request instanceof Map && request.get('type') === 'recover') {
          // Off the accept loop: it waits on codesign, lsof and the service's exit. The recovery answers on (and
          // closes) the requester's connection itself.
          detached = true;
          answer_recover(reader).catch(() => {});
          return;
        }
        const session_id = request instanceof Map ? request.get('session_id') : null;
        const turn_id = request instanceof Map ? request.get('turn_id') : null;
        if (!nonBlank(session_id) || !nonBlank(turn_id)) throw new ValueError('Original macOS turn IDs are missing.');
        const payload = turn_ended_payload(session_id, turn_id);
        await run_turn_ended(client, payload);
        response = { notified: true };
      } catch (exc) {
        response = { notified: false, error: cpSlice(excStr(exc), 512) };
        // A failing diagnostic write escapes like Python's print() in the except block.
        writeFd(2, `LCU macOS turn cleanup failed: ${response.error}\n`);
      }
      // A disconnected hook client must not terminate the host.
      await reader.sendAndClose(frame(response), 3000);
    } finally {
      if (!detached) reader.close();
    }
  };

  try {
    for (;;) {
      while (!lines.readable() && backlog.length === 0) await sleep();
      if (lines.readable()) {
        let result = lines.readline();
        while (result === 'blocked') {
          await sleep();
          result = lines.readline();
        }
        if (result === 'eof') break;
      }
      if (backlog.length === 0) continue;
      await handle(new LineReader(backlog.shift()));
    }
  } finally {
    for (const socket of backlog.splice(0)) socket.destroy();
    server.close();
    unlinkQuiet(address);
  }
}

/**
 * Entry for `macos-host`: argv is Python's sys.argv[1:] = ['serve', address, client, control?].
 * Anything else does nothing (like the Python __main__ guard). Exits the process when the host has stopped.
 */
export async function serve_main(argv) {
  if (!((argv.length === 3 || argv.length === 4) && argv[0] === 'serve')) return;
  try {
    await serve(argv[1], argv[2], argv.length === 4 ? argv[3] : null);
  } catch (error) {
    try {
      writeFd(2, `${excStr(error)}\n`);
    } catch {
      process.exit(120);
    }
    process.exit(1);
  }
  process.exit(0);
}

// Direct execution (`node macos_host.mjs serve ...`) behaves like `python macos_host.py serve ...`.
// Node resolves symlinks for the main module (release paths go through `current`), so compare real paths.
const isMain = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isMain()) {
  await serve_main(process.argv.slice(2));
}
