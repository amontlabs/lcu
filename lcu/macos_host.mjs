// Supervise the original macOS client turn-ended command for one MCP process.
// Port of lcu/macos_host.py (see .port/notes/macos_host.md).
//
// The host runs as a child of the MCP launcher: `node <release>/lcu/entry.mjs macos-host serve <socket>
// <client> [<control socket>]`, which calls `serve_main(argv.slice(3))` (argv = ['serve', ...]).
// start_original_host/stop_original_host/serve are asynchronous (the Python versions blocked on threads and
// select); everything observable (socket paths, modes, framing, payload bytes, timeouts, reply strings) is kept.
import { spawn } from './compat/spawn.mjs';
import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants as fsConstants, lstatSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs';
import net from 'node:net';
import { constants as osConstants } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pyStrip } from './compat/argparse.mjs';
import { PyOSError, fromNodeError, isOSError, pyStr, reprStr, spawnErrorText } from './compat/pyerr.mjs';
import { TimeoutExpired, execFormatError } from './compat/subprocess.mjs';
import { mkdtemp } from './compat/tempfile.mjs';
import { ValueError, dumps, equal, loads } from './compat/pyjson.mjs';

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
    try {
      reader.timeout = 3000;
      let response;
      try {
        const request = await reader.read();
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
      reader.close();
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
