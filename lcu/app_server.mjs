// Small stdio adapter to the bundled original Codex app-server.
//
// Port of lcu/app_server.py. The whole API is SYNCHRONOUS, like the Python it ports (callers such as
// lcu/codex_hooks.py and lcu/setup.py are straight-line synchronous code and keep their ordering of side effects):
//
//   * Python used a selector (POSIX) or a reader thread (Windows) over the child's stdout pipe. Node has no
//     synchronous pipe reads, so the child process is owned by a worker thread (the "transport": spawn, stdin
//     writes, stdout chunks, exit status) and the calling thread blocks on a SharedArrayBuffer counter with
//     Atomics.wait. Everything above the transport (framing, the 50 ms read slices, request/response routing,
//     notification subscriptions, server-originated requests, timeouts and their error texts) is the Python
//     logic ported line by line and runs on the calling thread.
//   * `with app_server(cli, cwd, env) as call:` becomes `app_server(cli, cwd, env, (call) => {...})`, which
//     returns the callback's value. `call` is a function `call(method, params, timeout = 45)` carrying the
//     AppServer methods as properties (`call.receive`, `call.subscribe_notifications`, `call.send`,
//     `call.client`, `call.initialization`).
//   * The server's replies are returned in pyjson's lossless model (objects are Maps, integers Numbers or BigInt).
//
// Test injection points: `AppServer(process)` takes any transport with the `Popen` surface below; `popen()`
// creates the real one.
import { spawnSync, wrapForSignals } from './compat/spawn.mjs';
import {
  closeSync, existsSync, openSync, readFileSync, unlinkSync,
} from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';

import { dumps, equal, fromPlain, isInt, loads, PyFloat, reprFloat, ValueError } from './compat/pyjson.mjs';
import { fromNodeError } from './compat/pyerr.mjs';
import { TimeoutExpired, execFormatError } from './compat/subprocess.mjs';

const now = () => Number(process.hrtime.bigint()) / 1e9; // time.monotonic()

/** An original RPC error, distinct from losing the host connection. */
export class AppServerRequestError extends ValueError {
  constructor(message) {
    super(typeof message === 'string' ? message : pyFormat(message));
    this.name = 'AppServerRequestError';
  }
}

// str(value) for the JSON values an error message can hold.
function pyFormat(value) {
  if (typeof value === 'string') return value;
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (isInt(value)) return String(value);
  if (typeof value === 'number') return reprFloat(value);
  if (value instanceof PyFloat) return reprFloat(value.value);
  return dumps(value);
}

class KeyError extends Error {
  constructor(key) {
    super(`'${key}'`);
    this.name = 'KeyError';
  }
}

// ---------------------------------------------------------------------------------------------------------
// Transport: a child process owned by a worker thread, with a blocking synchronous surface.
//
// Lifetime protocol (the worker is the only owner of the pipes, so its failure must never go unnoticed):
//   * every worker handler runs under try/catch and an uncaughtException handler; a fault is posted as
//     {type:'fault'} and the worker stays alive, so it keeps supervising the child (poll/terminate/kill/exit);
//   * the worker beats counter[1] every 100 ms; a caller that observes no beat for HOST_DEAD_AFTER seconds while
//     it waits treats the host as gone (uncatchable worker death);
//   * after host loss the child is supervised directly: its pid, parent pid and start time are read from
//     /proc (Linux) or ps(1) (macOS) and it is signalled only while it is still this process's own, unreaped
//     child with the recorded start time (BRIEF SAFETY RULE). A child nobody reaps stays a zombie, so its pid
//     cannot be reused while we look at it.
//   * a transport fault or host loss makes reads and writes raise
//     ValueError('Lost the bundled Codex app-server connection: <reason>') instead of hanging or reporting success.

const HOST_DEAD_AFTER = 5; // seconds without a heartbeat while waiting
const HEARTBEAT_MS = 100;

const WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const { argv, cwd, env, stderrFd, counter, port } = workerData;
const post = (message) => {
  try { port.postMessage(message); } finally { Atomics.add(counter, 0, 1); Atomics.notify(counter, 0); }
};
const fault = (error) => post({ type: 'fault', message: String((error && error.message) || error) });
process.on('uncaughtException', fault);
const beat = setInterval(() => { Atomics.add(counter, 1, 1); }, ${HEARTBEAT_MS});
const failure = (error) => ({ type: 'spawn_error', code: error.code, errno: error.errno, syscall: error.syscall,
  path: error.path, message: error.message });
const stop = () => { clearInterval(beat); parentPort.removeAllListeners('message'); };
let child = null;
try {
  child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', stderrFd] });
} catch (error) {
  post(failure(error));
  stop();
}
if (child) {
  child.once('error', (error) => { if (child.pid === undefined) { post(failure(error)); stop(); } else fault(error); });
  child.once('spawn', () => post({ type: 'spawned', pid: child.pid }));
  child.stdout.on('data', (chunk) => post({ type: 'chunk', data: new Uint8Array(chunk) }));
  child.stdout.on('end', () => post({ type: 'eof' }));
  child.stdout.on('error', () => post({ type: 'eof' }));
  child.stdin.on('error', (error) => post({ type: 'stdin_error', code: error.code, errno: error.errno }));
  child.on('exit', (code, signal) => post({ type: 'exit', code, signal }));
  parentPort.on('message', (command) => {
    try {
      if (command.cmd === 'write') child.stdin.write(Buffer.from(command.data));
      else if (command.cmd === 'close_stdin') child.stdin.end();
      else if (command.cmd === 'terminate') child.kill('SIGTERM');
      else if (command.cmd === 'kill') child.kill('SIGKILL');
      else if (command.cmd === 'poll') {
        post({ type: 'polled', running: child.exitCode === null && child.signalCode === null,
          code: child.exitCode, signal: child.signalCode });
      }
    } catch (error) {
      fault(error);
    }
  });
}
`;

// The child's state as the OS reports it: {exists, running, ppid, start}, or {unknown: true} when it cannot be
// queried (unavailable supervision is never taken as proof that the child exited).
function windowsPowershell(script) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
}

function processStatus(pid, platform = internals.platform) {
  if (platform === 'linux') {
    if (!existsSync('/proc/self/stat')) return { unknown: true };
    let text;
    try {
      text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (error) {
      return error.code === 'ENOENT' ? { exists: false } : { unknown: true };
    }
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { exists: true, running: fields[0] !== 'Z' && fields[0] !== 'X', ppid: Number(fields[1]), start: fields[19] };
  }
  if (platform === 'darwin') {
    const result = spawnSync('/bin/ps', ['-o', 'ppid=,stat=,lstart=', '-p', String(pid)], { encoding: 'utf8' });
    if (result.error) return { unknown: true };
    const line = (result.stdout ?? '').trim();
    if (!line) return result.status === 1 ? { exists: false } : { unknown: true };
    const [ppid, stat, ...start] = line.split(/\s+/);
    return { exists: true, running: !stat.startsWith('Z'), ppid: Number(ppid), start: start.join(' ') };
  }
  if (platform === 'win32') {
    // Win32_Process lists live processes only (no zombies); the creation time is the identity.
    const result = internals.powershell(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; ` +
      'if ($p) { "$($p.ParentProcessId) $($p.CreationDate.ToUniversalTime().ToString(\'o\'))" } else { "none" }');
    const line = (result.stdout ?? '').trim();
    if (result.error || result.status !== 0 || !line) return { unknown: true };
    if (line === 'none') return { exists: false };
    const [ppid, start] = line.split(/\s+/);
    if (!/^\d+$/.test(ppid) || !start) return { unknown: true };
    return { exists: true, running: true, ppid: Number(ppid), start };
  }
  return { unknown: true };
}

// Injection points for platform fixtures (production never replaces them).
export const internals = { platform: process.platform, powershell: windowsPowershell, processStatus };

/** The `subprocess.Popen` surface AppServer needs, over a worker-hosted child process. */
class ChildProcess {
  constructor(argv, { cwd, env, stderrFd }) {
    this.argv = argv;
    this.cwd = cwd;
    this.counter = new Int32Array(new SharedArrayBuffer(8));
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.chunks = [];
    this.eof = false;
    this.failed = null; // a fault the (still running) worker reported
    this.hostDead = null; // the worker stopped beating
    this.spawned = false;
    this.spawnError = null;
    this.pid = null;
    this.identity = null;
    this.exited = false;
    this.broken = false;
    this.stdinClosed = false;
    this.returncode = null;
    this.polled = null;
    this.closed = false;
    this.beat = 0;
    this.beatAt = now();
    this.lastCheck = now();
    try {
      // The worker thread has its own module state, so the caller's ignored signals are applied here (compat/spawn).
      const [file, args] = wrapForSignals(argv[0], argv.slice(1), { cwd, env });
      this.worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { argv: [file, ...args], cwd, env, stderrFd, counter: this.counter, port: port2 },
        transferList: [port2],
      });
      this.worker.unref();
      // Faults are reported through the port; the event itself would only arrive after the blocking wait.
      this.worker.on('error', () => {});
      this._wait(() => this.spawned || this.spawnError || this.failed || this.hostDead, 60);
      if (this.spawnError) throw this.spawnError;
      if (!this.spawned) {
        throw new ValueError(`Cannot start the bundled Codex app-server process host: ${this.failed ?? this.hostDead ?? 'timed out'}`);
      }
    } catch (error) {
      if (this.spawned) this._abandon();
      this.close();
      throw error;
    }
    // Identity for supervision after host loss: this process's child with this start time.
    const status = internals.processStatus(this.pid, internals.platform);
    if (status.exists && status.ppid === process.pid) this.identity = status.start;
  }

  _handle(message) {
    switch (message.type) {
      case 'spawned': this.spawned = true; this.pid = message.pid; break;
      case 'spawn_error': {
        const error = Object.assign(new Error(message.message), {
          code: message.code, errno: message.errno, syscall: message.syscall, path: message.path,
        });
        // Popen reports the working directory when that is what is missing.
        const filename = message.code === 'ENOENT' && this.cwd !== undefined && !existsSync(this.cwd) ? this.cwd : this.argv[0];
        this.spawnError = fromNodeError(error, { filename }) ?? error;
        break;
      }
      case 'chunk': this.chunks.push(Buffer.from(message.data)); break;
      case 'eof': this.eof = true; break;
      case 'stdin_error': this.broken = true; break;
      case 'fault': this.failed = message.message; break;
      case 'exit':
        this.exited = true;
        this.broken = true;
        this.returncode = message.code ?? -(osConstants.signals[message.signal] ?? 0);
        break;
      case 'polled': this.polled = message; break;
      default: break;
    }
  }

  _drain() {
    if (this.closed) return;
    for (let received = receiveMessageOnPort(this.port); received; received = receiveMessageOnPort(this.port)) {
      this._handle(received.message);
    }
  }

  // Heartbeat bookkeeping; only time spent waiting here counts towards declaring the host dead.
  _liveness() {
    const t = now();
    const beat = Atomics.load(this.counter, 1);
    if (beat !== this.beat) {
      this.beat = beat;
      this.beatAt = t;
    } else if (t - this.lastCheck > 0.5) {
      this.beatAt = t; // the caller was busy elsewhere: restart the observation window
    }
    this.lastCheck = t;
    if (!this.hostDead && !this.closed && t - this.beatAt > HOST_DEAD_AFTER) {
      this.hostDead = 'the app-server process host stopped responding';
    }
  }

  // Block until predicate() holds or `timeout` seconds pass; returns whether it holds.
  _wait(predicate, timeout) {
    const deadline = now() + timeout;
    for (;;) {
      const seen = Atomics.load(this.counter, 0);
      this._drain();
      this._liveness();
      if (predicate()) return true;
      const remaining = deadline - now();
      if (remaining <= 0) return false;
      Atomics.wait(this.counter, 0, seen, Math.min(remaining, 0.25) * 1000);
    }
  }

  _lost() {
    return new ValueError(`Lost the bundled Codex app-server connection: ${this.failed ?? this.hostDead}`);
  }

  // selector.select(timeout): is a read of stdout possible without blocking (data, EOF, or a lost transport)?
  ready(timeout) {
    return this._wait(() => this.chunks.length > 0 || this.eof || this.failed || this.hostDead, timeout);
  }

  // stdout.read1(65536): the next chunk of available bytes, or b'' at EOF.
  read1() {
    this._drain();
    if (this.chunks.length) {
      const chunk = this.chunks[0];
      if (chunk.length > 65536) {
        this.chunks[0] = chunk.subarray(65536);
        return chunk.subarray(0, 65536);
      }
      return this.chunks.shift();
    }
    if (this.eof) return Buffer.alloc(0);
    if (this.failed || this.hostDead) throw this._lost();
    return Buffer.alloc(0);
  }

  // stdin.write(data); stdin.flush()
  write(data) {
    this._drain();
    if (this.stdinClosed) throw new ValueError('write to closed file');
    if (this.failed || this.hostDead) throw this._lost();
    if (this.broken) throw fromNodeError({ code: 'EPIPE', errno: -32 });
    this.worker.postMessage({ cmd: 'write', data: new Uint8Array(data) });
  }

  stdin_close() {
    if (this.stdinClosed) return;
    this.stdinClosed = true;
    if (!this.hostDead) this.worker.postMessage({ cmd: 'close_stdin' });
  }

  // The child, supervised without the worker: is it still running (null) or gone (its status)?
  _direct() {
    const status = internals.processStatus(this.pid, internals.platform);
    if (status.unknown) return null; // cannot supervise: never reported as an exit
    const own = status.exists && status.ppid === process.pid && (this.identity === null || status.start === this.identity);
    if (own && status.running) return null;
    this.exited = true;
    if (this.returncode === null) this.returncode = -1; // nobody can reap it to learn the status
    return this.returncode;
  }

  // process.poll(): null while running, otherwise the return code
  poll() {
    this._drain();
    if (this.exited) return this.returncode;
    if (!this.hostDead) {
      this.polled = null;
      this.worker.postMessage({ cmd: 'poll' });
      this._wait(() => this.polled !== null || this.exited || this.hostDead, 10);
      if (this.exited) return this.returncode;
      if (this.polled !== null) return this.polled.running ? null : this.returncode ?? this.polled.code ?? -1;
      this.hostDead = this.hostDead ?? 'the app-server process host did not answer';
    }
    return this._direct();
  }

  _signal(name) {
    this._drain();
    if (this.exited) return;
    if (!this.hostDead) {
      this.worker.postMessage({ cmd: name === 'SIGTERM' ? 'terminate' : 'kill' });
      return;
    }
    // Only this process's own child, still running, with the start time recorded at spawn. Without a recorded
    // identity, or when the OS cannot be queried, nothing is signalled (the child may then outlive cleanup).
    const status = internals.processStatus(this.pid, internals.platform);
    if (this.identity !== null && !status.unknown && status.exists && status.running && status.ppid === process.pid &&
        status.start === this.identity) {
      process.kill(this.pid, name);
    } else if (!status.unknown && !(status.exists && status.running)) {
      this._direct();
    }
  }

  terminate() {
    this._signal('SIGTERM');
  }

  kill() {
    this._signal('SIGKILL');
  }

  // process.wait(timeout): raises subprocess.TimeoutExpired like Python
  wait(timeout) {
    const deadline = now() + timeout;
    if (this._wait(() => this.exited || this.hostDead, timeout) && this.exited) return this.returncode;
    while (this.hostDead && now() < deadline) {
      if (this._direct() !== null) return this.returncode;
      Atomics.wait(this.counter, 0, Atomics.load(this.counter, 0), 50);
    }
    if (this.hostDead && this._direct() !== null) return this.returncode;
    throw new TimeoutExpired(this.argv, timeout * 1000);
  }

  // A child that started although setup then failed: end it through the normal sequence.
  _abandon() {
    try {
      this.stdin_close();
      if (this.poll() === null) this.terminate();
      try {
        this.wait(10);
      } catch {
        this.kill();
        this.wait(10);
      }
    } catch {
      // the original error is what the caller reports
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.worker) this.worker.terminate().catch(() => {});
    this.port.close();
  }
}

/** subprocess.Popen(argv, cwd=cwd, env=env, stdin=PIPE, stdout=PIPE, stderr=errors) */
export function popen(argv, { cwd, env, stderrFd }) {
  // Python's execve-based spawn rejects a file that is neither a binary nor a #! script (ENOEXEC).
  const formatError = execFormatError(argv, env, { cwd });
  if (formatError) throw formatError;
  return new ChildProcess(argv, { cwd, env, stderrFd });
}

// ---------------------------------------------------------------------------------------------------------

// `key in container` for what a decoded JSON message can be.
function member(key, container) {
  if (container instanceof Map) return container.has(key);
  if (Array.isArray(container)) return container.some((item) => item === key);
  if (typeof container === 'string') return container.includes(key);
  const kind = container === null ? 'NoneType' : isInt(container) ? 'int' : typeof container === 'number' ? 'float' : container instanceof PyFloat ? 'float' : typeof container === 'boolean' ? 'bool' : 'object';
  throw new TypeError(`argument of type '${kind}' is not iterable`);
}

// container[key] for a decoded JSON object.
function item(container, key) {
  if (container instanceof Map) {
    if (!container.has(key)) throw new KeyError(key);
    return container.get(key);
  }
  throw new TypeError(Array.isArray(container) ? 'list indices must be integers or slices, not str' : 'object is not subscriptable');
}

// Python set-membership identity of a JSON-decoded request id (1 == 1.0 == True; unhashable values raise).
function idKey(value) {
  if (isInt(value)) return `n${value}`;
  if (typeof value === 'number') return Number.isInteger(value) ? `n${BigInt(value)}` : `f${value}`;
  if (typeof value === 'boolean') return `n${value ? 1 : 0}`;
  if (value instanceof PyFloat) return Number.isInteger(value.value) ? `n${BigInt(value.value)}` : `f${value.value}`;
  if (typeof value === 'string') return `s${value}`;
  if (value === null) return 'null';
  throw new TypeError(`unhashable type: '${value instanceof Map ? 'dict' : 'list'}'`);
}

/** A private notification view; reading it never consumes RPC replies. */
export class NotificationSubscription {
  constructor(server) {
    this.server = server;
    this.messages = [];
    this.closed = false;
  }

  receive(timeout = 0) {
    return this.server._receive_notification(this, timeout);
  }

  close() {
    this.server._unsubscribe(this);
  }
}

export class AppServer {
  constructor(process, request_handler = null) {
    this.process = process;
    // The embedding caller owns policy for server-originated requests.
    // A handler receives the complete request and returns a JSON-RPC
    // response envelope carrying that same id and either result or error.
    this.request_handler = request_handler;
    this.sequence = 0;
    this.buffer = Buffer.alloc(0);
    this._responses = new Map();
    this._pending = new Set();
    this._subscriptions = new Set();
    this.initialization = this.call('initialize', {
      clientInfo: { name: 'lcu', version: '0.3.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized' });
  }

  send(message) {
    this.process.write(Buffer.from(dumps(message) + '\n'));
  }

  _read_one(timeout) {
    const deadline = now() + timeout;
    // The RPC and subscription readers call this in short slices so another
    // waiter can acquire the stream after each bounded wait.
    while (this.buffer.indexOf(0x0a) === -1) {
      const remaining = deadline - now();
      if (remaining <= 0) return null;
      if (!this.process.ready(Math.min(remaining, 0.05))) {
        if (now() >= deadline) return null;
        continue;
      }
      const part = this.process.read1();
      if (part.length === 0) throw new ValueError('Bundled Codex app-server exited unexpectedly.');
      this.buffer = Buffer.concat([this.buffer, part]);
    }
    const newline = this.buffer.indexOf(0x0a);
    const line = this.buffer.subarray(0, newline);
    this.buffer = this.buffer.subarray(newline + 1);
    return loads(line);
  }

  _answer_request(request) {
    const request_id = item(request, 'id');
    let response;
    if (this.request_handler === null) {
      response = { id: request_id, error: { code: -32601, message: 'Server-originated requests are unsupported.' } };
    } else {
      // No stream, state, or write lock is held here. Handlers may make
      // nested RPC calls on this same connection.
      response = this.request_handler(request);
      const dict = response instanceof Map ? response : (response !== null && typeof response === 'object' && !Array.isArray(response) &&
        !(response instanceof PyFloat) ? new Map(Object.entries(response)) : null);
      if (dict === null || !equal(dict.has('id') ? dict.get('id') : null, request_id) || dict.has('method') ||
          dict.has('result') === dict.has('error')) {
        throw new ValueError('App-server request handler returned an invalid response envelope.');
      }
    }
    this.send(response);
  }

  _route(message) {
    if (member('id', message) && member('method', message)) {
      this._answer_request(message);
      return;
    }
    if (member('id', message)) {
      const id = item(message, 'id');
      if (this._pending.has(idKey(id))) this._responses.set(idKey(id), message);
    } else {
      for (const subscription of this._subscriptions) subscription.messages.push(message);
    }
  }

  /** Receive the next wire message, preserving the historical API. */
  receive(timeout) {
    const message = this._read_one(timeout);
    if (message !== null) this._route(message);
    return message;
  }

  subscribe_notifications() {
    const subscription = new NotificationSubscription(this);
    this._subscriptions.add(subscription);
    return subscription;
  }

  _unsubscribe(subscription) {
    this._subscriptions.delete(subscription);
    subscription.closed = true;
    subscription.messages.length = 0;
  }

  _receive_notification(subscription, timeout) {
    const deadline = now() + timeout;
    for (;;) {
      if (subscription.closed) return null;
      if (subscription.messages.length) return subscription.messages.shift();
      const remaining = deadline - now();
      if (remaining <= 0) return null;
      // Release stream-reader ownership regularly so an RPC waiter can
      // route its reply even while this subscriber is waiting quietly.
      const message = this._read_one(Math.min(remaining, 0.05));
      if (message === null) return null;
      this._route(message);
    }
  }

  call(method, params, timeout = 45) {
    this.sequence += 1;
    const request_id = this.sequence;
    const key = `n${request_id}`;
    this._pending.add(key);
    try {
      this.send({ id: request_id, method, params });
      const deadline = now() + timeout;
      for (let remaining = deadline - now(); remaining > 0; remaining = deadline - now()) {
        let message = this._responses.get(key);
        this._responses.delete(key);
        if (message !== undefined) {
          if (member('error', message)) throw new AppServerRequestError(item(item(message, 'error'), 'message'));
          return item(message, 'result');
        }
        message = this._read_one(Math.min(remaining, 0.05));
        if (message === null) continue;
        this._route(message);
      }
      throw new ValueError(`Bundled Codex app-server timed out: ${method}`);
    } finally {
      this._pending.delete(key);
      this._responses.delete(key);
    }
  }

  /** The Python object is callable (`client(method, params, timeout=45)`); this is its function form. */
  callable() {
    const call = (method, params, timeout) => this.call(method, params, timeout);
    return Object.assign(call, {
      client: this,
      initialization: this.initialization,
      send: (message) => this.send(message),
      receive: (timeout) => this.receive(timeout),
      subscribe_notifications: () => this.subscribe_notifications(),
    });
  }
}

/**
 * Retain caller configuration; never execute a model turn or change policy.
 *
 * Python: `with app_server(cli, cwd, env) as call:`. Here the body is a callback `(call) => value`, whose value
 * is returned after the child has been shut down (stdin closed, SIGTERM when still running, SIGKILL after 10 s).
 */
export function app_server(cli, cwd, env, body) {
  // tempfile.TemporaryFile(): an anonymous file collecting the child's stderr (discarded, never shown).
  const errorsPath = `${tmpdir()}/lcu-app-server-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const errors = openSync(errorsPath, 'w+', 0o600);
  unlinkSync(errorsPath);
  try {
    const processHandle = popen([String(cli), '--strict-config', 'app-server', '--listen', 'stdio://'],
      { cwd, env, stderrFd: errors });
    let client = null;
    let failed = false;
    try {
      client = new AppServer(processHandle);
      return body(client.callable());
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Python's cleanup sequence. Deliberate difference: when the body (or initialisation) already failed, a
      // cleanup failure does not replace that original error.
      try {
        processHandle.stdin_close();
        if (processHandle.poll() === null) processHandle.terminate();
        try {
          processHandle.wait(10);
        } catch (error) {
          if (!(error instanceof TimeoutExpired)) throw error;
          processHandle.kill();
          processHandle.wait(10);
        }
      } catch (cleanupError) {
        if (!failed) throw cleanupError;
      } finally {
        processHandle.close();
      }
    }
  } finally {
    closeSync(errors);
  }
}

export { fromPlain };
