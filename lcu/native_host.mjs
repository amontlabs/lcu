// Relay the original Chrome native host with LCU's local agent-header policy.
//
// LCU always enables the official extension's browser-agent request header. This
// lets the original browser service use Chrome without a Codex account while the
// extension still labels requests from agent-controlled tabs. All other native
// messages pass through unchanged to the installed application's original host.
//
// Port of lcu/native_host.py. Chrome starts the generated launcher in the private host directory, which execs the
// installation's stable `<prefix>/current/bin/lcu browser __native-host <host dir> ARGS` (so the relay passes the
// same pre-Node gate and Node-startup-environment quarantine as every LCU command, and runs on the current release's
// app Node). browser.main hands over to run(directory, argv) below. The original host is looked up in
// `<host dir>/chrome/extension-host/...`, exactly where Python's copied relay found it next to itself.
//
// Native messaging is binary: 4-byte little-endian length frames, never text-decoded or re-encoded except the
// one JSON reply that is rewritten. stdin/stdout are handled as raw byte streams with backpressure; nothing but
// frames is ever written to stdout (diagnostics go to stderr).
import { spawn } from './compat/spawn.mjs';
import { realpathSync, statSync, writeSync } from 'node:fs';
import { constants as osConstants, machine as osMachine } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fromNodeError, PyOSError, pyStr } from './compat/pyerr.mjs';
import { format_traceback } from './compat/pytrace.mjs';
import { dumps, isDict, loads, UnicodeEncodeError, ValueError } from './compat/pyjson.mjs';

export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * Injection points (Python's mock.patch of __file__, platform.system and platform.machine). `directory` is the
 * private host directory (Python: the directory of the copied relay file); run() sets it.
 */
export const hooks = {
  file: fileURLToPath(import.meta.url),
  directory: null,
  system: () => ({ linux: 'Linux', darwin: 'Darwin', win32: 'Windows' })[process.platform]
    ?? process.platform.replace(/^./, (c) => c.toUpperCase()),
  machine: () => osMachine(),
};

/** Blocking-style reads (`read(n)` waits for n bytes or EOF) over any Node Readable, without text decoding. */
export class FrameReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.chunks = [];
    this.length = 0;
    this.done = false;
  }

  async read(count) {
    while (this.length < count && !this.done) {
      const { value, done } = await this.iterator.next();
      if (done) this.done = true;
      else if (value.length) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        this.chunks.push(chunk);
        this.length += chunk.length;
      }
    }
    const joined = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.length);
    const taken = joined.subarray(0, Math.min(count, joined.length));
    const rest = joined.subarray(taken.length);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    return taken;
  }
}

export const frameReader = (source) => (source instanceof FrameReader ? source : new FrameReader(source));

export async function _read_frame(stream) {
  const reader = frameReader(stream);
  const prefix = await reader.read(4);
  if (!prefix.length) return null;
  if (prefix.length !== 4) throw new ValueError('Short native-message length');
  const size = prefix.readUInt32LE(0);
  if (size > MAX_MESSAGE_BYTES) throw new ValueError('Native message exceeds the supported size');
  const payload = await reader.read(size);
  if (payload.length !== size) throw new ValueError('Short native-message body');
  return payload;
}

// A write to a stream whose reader is gone (Python: BrokenPipeError, "[Errno 32] Broken pipe"). Node reports the
// first failure as EPIPE and every later write on the destroyed stream as ERR_STREAM_DESTROYED: both are this
// condition here, because the only streams written are the child's stdin and this process's stdout.
const broken_pipe = (error) => (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED'
  ? new PyOSError('EPIPE') : error);

const writeAll = (stream, buffer) => new Promise((resolveWrite, reject) => {
  stream.write(buffer, (error) => (error ? reject(broken_pipe(error)) : resolveWrite()));
});

export async function _write_frame(stream, payload) {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(payload.length, 0);
  // One write per frame: the prefix and the body leave together, and the callback is the "flush".
  await writeAll(stream, Buffer.concat([prefix, payload]));
}

export function _enable_agent_header(payload) {
  let message;
  try {
    message = loads(payload);
  } catch (error) {
    if (error instanceof ValueError) return payload; // UnicodeDecodeError and JSONDecodeError are ValueErrors
    throw error;
  }
  if (!isDict(message)) return payload;
  const result = message.get('result');
  if (!isDict(result) || result.get('type') !== 'extension' || result.get('agentRequestHeaderEnabled') !== false) {
    return payload;
  }
  result.set('agentRequestHeaderEnabled', true);
  const text = dumps(message, { ensure_ascii: false, separators: [',', ':'] });
  if (!text.isWellFormed()) throw new UnicodeEncodeError(text); // strict UTF-8: the first run of lone surrogates
  return Buffer.from(text, 'utf8');
}

export async function _relay(source, destination, transform = null) {
  const reader = frameReader(source);
  for (let payload; (payload = await _read_frame(reader)) !== null;) {
    await _write_frame(destination, transform ? transform(payload) : payload);
  }
}

/** Path(__file__).resolve() (non-strict). */
function resolveFile(file) {
  try {
    return realpathSync(file);
  } catch {
    try {
      return join(realpathSync(dirname(resolve(file))), basename(file));
    } catch {
      return resolve(file);
    }
  }
}

export function _original_host() {
  const arch = { aarch64: 'arm64', arm64: 'arm64', x86_64: 'x64', amd64: 'x64' }[hooks.machine().toLowerCase()];
  const system = hooks.system();
  if (arch === undefined || !['Linux', 'Darwin', 'Windows'].includes(system) || (system === 'Windows' && arch !== 'x64')) {
    throw new ValueError('The original Chrome native host is available only for supported Linux, macOS, or Windows architectures');
  }
  const host = ({
    Linux: ['linux', 'extension-host'],
    Darwin: ['macos', 'ChatGPT for Chrome'],
    Windows: ['windows', 'extension-host.exe'],
  })[system];
  const base = hooks.directory !== null ? resolveFile(hooks.directory) : dirname(resolveFile(hooks.file));
  const binary = join(base, 'chrome/extension-host', host[0], arch, host[1]);
  let isFile = false;
  try {
    isFile = statSync(binary).isFile();
  } catch { /* missing */ }
  if (!isFile) throw new ValueError(`The original Chrome native host is missing: ${binary}`);
  return binary;
}

const isRelayError = (error) => error instanceof ValueError || typeof error?.code === 'string' || error?.name === 'OSError';

export async function main(argv = process.argv.slice(2), { stdin = process.stdin, stdout = process.stdout } = {}) {
  const child = spawn(_original_host(), argv, { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((resolveSpawn, reject) => {
    child.once('spawn', resolveSpawn);
    child.once('error', reject);
  }).catch((error) => {
    throw fromNodeError(error, { filename: error.path ?? child.spawnfile }) ?? error;
  });
  const exited = new Promise((resolveExit) => {
    child.once('close', (code, signal) => resolveExit(code ?? -(osConstants.signals[signal] ?? 0)));
  });
  const errors = [];
  child.stdin.on('error', () => {});
  stdout.on('error', () => {});

  const terminate = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  };

  const inbound = (async () => {
    let unflushed = false;
    try {
      await _relay(frameReader(stdin), child.stdin, _enable_agent_header);
    } catch (error) {
      if (!isRelayError(error)) {
        if (error instanceof RangeError) return; // Python's RecursionError ends this thread without a recorded error
        throw error;
      }
      errors.push(error);
      // The failed flush left the frame in Python's BufferedWriter, so `child.stdin.close()` in the finally clause
      // flushes it again and raises BrokenPipeError out of the thread (printed by threading's excepthook).
      unflushed = error instanceof PyOSError && error.name === 'BrokenPipeError';
      terminate();
    } finally {
      child.stdin.end();
      if (unflushed) {
        writeStderr(`Exception in thread Thread-1 (inbound):\n${format_traceback(new PyOSError('EPIPE'))}`);
      }
    }
  })();

  try {
    await _relay(frameReader(child.stdout), stdout);
  } catch (error) {
    if (!isRelayError(error)) throw error;
    errors.push(error);
    terminate();
  }
  await Promise.race([inbound.catch(() => {}), new Promise((resolveWait) => setTimeout(resolveWait, 1000).unref())]);
  const status = await exited;
  if (errors.length) {
    writeStderr(`LCU Chrome native-host relay failed: ${pyStr(errors[0])}\n`);
    return 1;
  }
  return status;
}

function writeStderr(text) {
  const data = Buffer.from(text, 'utf8');
  for (let offset = 0; offset < data.length;) {
    try {
      offset += writeSync(2, data, offset);
    } catch (error) {
      if (error.code === 'EAGAIN') continue;
      return;
    }
  }
}

/**
 * The relay process (Python's `if __name__ == '__main__'` block): relay for the host directory `directory` and
 * return the exit status (sys.exit semantics: -N becomes 256-N). Failures print
 * `LCU Chrome native-host relay failed: ...` on stderr and return 1.
 */
export async function run(directory, argv, streams = {}) {
  hooks.directory = directory;
  let status;
  try {
    status = await main(argv, streams);
  } catch (error) {
    if (!isRelayError(error) && error?.name !== 'OSError') throw error;
    writeStderr(`LCU Chrome native-host relay failed: ${pyStr(error)}\n`);
    return 1;
  }
  return ((status % 256) + 256) % 256;
}
