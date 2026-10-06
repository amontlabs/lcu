// Fake original `cua-repl` for the rt_* scenarios. It records what the launcher handed it (argv, execArgv, cwd,
// environment, stdin) in the shared recorder log and then misbehaves as $RT_PROBE (JSON) asks: read or ignore
// stdin, write large output, exit with a status, hold until the driver signals it, report
// open file descriptors, or act as the macOS node_repl against the lifecycle host (`mac` steps).
//
// Process facts that differ from run to run (pids) never go to the log; they go to $RT_OUT/probe.json for the
// driver, which prints only relationships between them.
import { appendFileSync, closeSync, fstatSync, mkdirSync, readFileSync, readSync, writeFileSync, writeSync,
  chmodSync, renameSync, unlinkSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const HIDDEN = /^(LCU_BB_|RT_|PWD$|OLDPWD$|SHLVL$|_$|__CF_USER_TEXT_ENCODING$)/;
const cfg = JSON.parse(process.env.RT_PROBE || '{}');
const out = process.env.RT_OUT || '';
const name = cfg.name || 'cua-repl';

function log(entry) {
  appendFileSync(process.env.LCU_BB_LOG, JSON.stringify(entry) + '\n');
}
const sortedEnv = () => Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !HIDDEN.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mark = (file, text = '') => { if (out) writeFileSync(`${out}/${file}`, text); };

function fdKind(fd) {
  try {
    const info = fstatSync(fd);
    return info.isFIFO() ? 'pipe' : info.isSocket() ? 'socket' : info.isFile() ? 'file' :
      info.isCharacterDevice() ? 'chr' : info.isDirectory() ? 'dir' : 'other';
  } catch { return 'closed'; }
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    try { offset += writeSync(fd, buffer, offset, buffer.length - offset); }
    catch (error) { if (error.code !== 'EAGAIN') throw error; }
  }
}

function pattern(bytes, seed) {
  const block = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) block[i] = i % 61 === 60 ? 10 : 97 + ((i * 7 + seed) % 26);
  return block;
}

function readStdin(mode) {
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  for (;;) {
    let count;
    try { count = readSync(0, buffer, 0, buffer.length, null); }
    catch (error) { if (error.code === 'EAGAIN') continue; if (error.code === 'EOF') break; throw error; }
    if (count === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, count)));
    if (mode === 'line' && chunks.at(-1).includes(10)) break;
  }
  return Buffer.concat(chunks);
}

// ---- macOS node_repl role -------------------------------------------------------------------------------------
const connections = new Map();
const where = (what) => {
  const env = process.env;
  const client = `${env.SKY_CUA_SERVICE_PATH}/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`;
  return { lifetime: env.LCU_MAC_LIFETIME_SOCKET, control: env.LCU_MAC_CONTROL_SOCKET, client }[what] || what;
};

function scrub(text) {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/"deadline_unix_ms":(\d+)/g, (_, ms) => `"deadline_unix_ms":"now+${Math.round((Number(ms) - Date.now()) / 1000)}s"`)
    .replace(/lcu-ml-[A-Za-z0-9_]+/g, 'lcu-ml-<R>');
}

function connect(label, target) {
  return new Promise((resolve) => {
    const state = { socket: null, buffer: Buffer.alloc(0), closed: false, error: null, waiters: [] };
    const socket = net.createConnection(where(target));
    state.socket = socket;
    const wake = () => { for (const w of state.waiters.splice(0)) w(); };
    socket.on('data', (chunk) => { state.buffer = Buffer.concat([state.buffer, chunk]); wake(); });
    socket.on('error', (error) => { state.error = error.code || String(error); state.closed = true; wake(); resolve(state); });
    socket.on('close', () => { state.closed = true; wake(); });
    socket.on('connect', () => resolve(state));
    connections.set(label, state);
  });
}

async function waitFor(state, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await new Promise((resolve) => { state.waiters.push(resolve); setTimeout(resolve, Math.min(left, 25)); });
  }
  return true;
}

function frame(step) {
  if (step.json !== undefined) {
    const value = JSON.parse(JSON.stringify(step.json));
    let text = JSON.stringify(value);
    if (step.padTo) {
      value.pad = '';
      const base = Buffer.byteLength(JSON.stringify(value));
      value.pad = 'x'.repeat(step.padTo - base);
      text = JSON.stringify(value);
    }
    return Buffer.from(text + (step.newline === false ? '' : '\n'));
  }
  if (step.b64 !== undefined) return Buffer.from(step.b64, 'base64');
  if (step.hex !== undefined) return Buffer.from(step.hex, 'hex');
  if (step.fill !== undefined) return Buffer.concat([Buffer.alloc(step.fill, 'a'), Buffer.from(step.newline === false ? '' : '\n')]);
  return Buffer.from((step.text ?? '') + (step.newline === false || step.text === undefined ? '' : '\n'));
}

// The launcher that started this probe. Once it dies the probe is reparented to launchd (pid 1), whose children are
// every app in the login session: matching on that would name all of them as "the host".
const LAUNCHER_PID = process.ppid;

function hostPid() {
  // The lifecycle host is the other child of the process that started this one.
  if (LAUNCHER_PID <= 1 || process.ppid !== LAUNCHER_PID) return [];
  const listing = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat='], { encoding: 'utf8' });
  const found = [];
  for (const line of listing.split('\n')) {
    const [pid, ppid, state] = line.trim().split(/\s+/).map((v, i) => (i < 2 ? Number(v) : v));
    if (ppid === LAUNCHER_PID && pid > 1 && pid !== process.pid && state && !state.startsWith('Z')) found.push(pid);
  }
  return found;
}

let wrapper = null;
const handlers = [];

async function loadWrapper() {
  if (wrapper) return wrapper;
  const services = JSON.parse(process.env.NODE_REPL_TRUSTED_SERVICES);
  globalThis.nodeRepl = {
    env: { ...process.env },
    requestMeta: {},
    addTurnEndedHandler: (handler) => { handlers.push(handler); },
    nativePipe: { createConnection: (address) => new Promise((resolve, reject) => {
      const socket = net.createConnection(address);
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    }) },
  };
  wrapper = await import(pathToFileURL(services.sky).href);
  return wrapper;
}

async function macStep(step, index) {
  const entry = { tool: name + ':mac', step: index, op: step.op };
  if (step.name) entry.name = step.name;
  switch (step.op) {
    case 'sleep': await sleep(step.ms); return;
    case 'connect': {
      const state = await connect(step.name, step.to);
      entry.ok = !state.error; if (state.error) entry.error = state.error;
      break;
    }
    case 'send': {
      const state = connections.get(step.name);
      if (step.result !== undefined) {
        // Answer the last request received on connection step.replyTo with this response.
        let id = null;
        try { id = JSON.parse(connections.get(step.replyTo).last).request_id; } catch {}
        step = { ...step, text: JSON.stringify({ type: 'result', request_id: id, response: step.result }) };
      }
      const parts = step.chunks ? step.chunks.map((c) => frame(c)) : [frame(step)];
      try {
        for (const part of parts) {
          if (step.byByte) { for (const byte of part) { state.socket.write(Buffer.from([byte])); await sleep(step.byByte); } }
          else state.socket.write(part);
          if (step.delayMs) await sleep(step.delayMs);
        }
        if (step.end) state.socket.end();
        entry.bytes = parts.reduce((n, p) => n + p.length, 0);
      } catch (error) { entry.error = error.code || String(error); }
      break;
    }
    case 'recv': {
      const state = connections.get(step.name);
      const lineReady = () => state.buffer.includes(10);
      const ok = await waitFor(state, step.until === 'eof' ? () => state.closed : () => lineReady() || state.closed,
        step.timeoutMs ?? 5000);
      const newline = state.buffer.indexOf(10);
      if (newline >= 0 && step.until !== 'eof') {
        state.last = state.buffer.subarray(0, newline).toString('utf8');
        entry.line = scrub(state.last);
        state.buffer = state.buffer.subarray(newline + 1);
      } else {
        entry.line = null;
        entry.partial = scrub(state.buffer.toString('utf8')); state.buffer = Buffer.alloc(0);
      }
      entry.closed = state.closed; entry.timedOut = !ok;
      if (state.error) entry.error = state.error;
      break;
    }
    case 'close': {
      const state = connections.get(step.name);
      if (step.destroy) state.socket.destroy(); else state.socket.end();
      await waitFor(state, () => state.closed, 2000);
      break;
    }
    case 'wait_closed': {
      const state = connections.get(step.name);
      const ok = await waitFor(state, () => state.closed, step.timeoutMs ?? 5000);
      entry.closed = state.closed; entry.timedOut = !ok; entry.pending = state.buffer.length;
      break;
    }
    case 'stat': {
      const path = where(step.what);
      try {
        const info = statSync(path);
        entry.stat = { type: info.isSocket() ? 'socket' : info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other',
          mode: (info.mode & 0o7777).toString(8), uidIsMe: info.uid === process.getuid() };
      } catch (error) { entry.stat = error.code; }
      if (step.what === 'lifetime') {
        const dir = path.replace(/\/[^/]+$/, '');
        const info = statSync(dir);
        entry.dir = { mode: (info.mode & 0o7777).toString(8), prefix: dir.replace(/\/[^/]+$/, '') + '/' + dir.split('/').at(-1).replace(/[A-Za-z0-9_]+$/, '<R>'),
          socketName: path.split('/').at(-1), randomLength: dir.split('/').at(-1).replace(/^lcu-ml-/, '').length };
      }
      break;
    }
    case 'chmod': chmodSync(where(step.what), parseInt(step.mode, 8)); break;
    case 'unlink': unlinkSync(where(step.what)); break;
    case 'rename': renameSync(where(step.what), where(step.what) + '.moved'); break;
    case 'ready': mark('ready'); return;
    case 'await': {
      // Wait for the driver to create $RT_OUT/<file> (it signals processes itself, then lets the probe go on).
      const deadline = Date.now() + (step.timeoutMs ?? 20000);
      while (!existsSync(`${out}/${step.file}`) && Date.now() < deadline && process.ppid === LAUNCHER_PID) await sleep(25);
      entry.released = existsSync(`${out}/${step.file}`);
      break;
    }
    case 'record_addresses':
      mark('lifetime.txt', process.env.LCU_MAC_LIFETIME_SOCKET || '');
      mark('control.txt', process.env.LCU_MAC_CONTROL_SOCKET || '');
      return;
    case 'host': {
      const pids = hostPid();
      entry.hostCount = pids.length;
      if (step.do === 'record') mark('host.json', JSON.stringify(pids));
      // Never signal from here: the driver does that through its session-checked send().
      break;
    }
    case 'wrapper_rpc': {
      const mod = await loadWrapper();
      globalThis.nodeRepl.requestMeta = step.meta === undefined ? {} : step.meta;
      try { entry.result = await mod.handleRpc(step.request); } catch (error) { entry.error = String(error?.message ?? error); }
      break;
    }
    case 'wrapper_turn_ended': {
      await loadWrapper();
      try { entry.result = await handlers[0].run({ session_id: step.session_id, turn_id: step.turn_id }) ?? null; }
      catch (error) { entry.error = String(error?.message ?? error); }
      entry.handlerTimeoutMs = handlers[0]?.timeoutMs;
      break;
    }
    default: entry.error = 'unknown op';
  }
  log(entry);
}

// ---- main -----------------------------------------------------------------------------------------------------
const safeCwd = () => { try { return process.cwd(); } catch (error) { return `(${error.code})`; } };
const entry = { tool: name, argv: process.argv.slice(2), cwd: safeCwd(), execArgv: process.execArgv,
  script: process.argv[1] };
if (process.env.LCU_BB_ARGV0) entry.argv0 = process.env.LCU_BB_ARGV0;
if (cfg.env !== false) entry.env = sortedEnv();
if (cfg.rawEnv && process.env.RT_ENVDUMP) {
  // What the launcher really put in the environment, byte for byte (the Node wrapper dumped `env` before exec).
  // Only entries with non-ASCII bytes are reported (hex), since `env` above already shows the decoded ones.
  const raw = readFileSync(process.env.RT_ENVDUMP);
  entry.rawEnvNonAscii = raw.toString('latin1').split('\n')
    .filter((line) => line && !HIDDEN.test(line.split('=')[0]) && /[^\x20-\x7e]/.test(line))
    .map((line) => Buffer.from(line, 'latin1').toString('hex')).sort();
}
if (cfg.fds) entry.fds = Object.fromEntries(cfg.fds.map((fd) => [fd, fdKind(fd)]));
if (cfg.stdinKind) entry.stdinKind = fdKind(0);

const signals = cfg.signals || [];
for (const signal of signals) {
  process.on(signal, () => {
    log({ tool: name + ':signal', signal });
    if (cfg.signalExit !== undefined) process.exit(cfg.signalExit);
  });
}
mark('probe.json', JSON.stringify({ pid: process.pid, ppid: process.ppid, argv0: process.argv0 }));
if (cfg.readyEarly) mark('ready');

if (cfg.stdin && cfg.stdin !== 'none') {
  const data = readStdin(cfg.stdin);
  entry.stdin = { bytes: data.length, sha256: sha(data) };
  if (data.length <= 4096) entry.stdin.text = data.toString('utf8');
  if (cfg.stdin === 'echo') writeAll(1, data);
}
log(entry);

if (cfg.stdout) {
  const data = pattern(cfg.stdout, 1);
  for (let i = 0; i < data.length; i += 65536) writeAll(1, data.subarray(i, i + 65536));
  log({ tool: name + ':wrote', stream: 'stdout', bytes: data.length, sha256: sha(data) });
}
if (cfg.stderr) {
  const data = pattern(cfg.stderr, 2);
  for (let i = 0; i < data.length; i += 4096) writeAll(2, data.subarray(i, i + 4096));
  log({ tool: name + ':wrote', stream: 'stderr', bytes: data.length, sha256: sha(data) });
}
if (cfg.print) writeAll(1, Buffer.from(cfg.print));
if (cfg.printErr) writeAll(2, Buffer.from(cfg.printErr));
if (cfg.mac) {
  mark('mac.started');
  let index = 0;
  for (const step of cfg.mac) await macStep(step, index++);
}
if (cfg.ready && !cfg.readyEarly) mark('ready');
if (cfg.holdMs) await sleep(cfg.holdMs);
if (cfg.hold) {
  // Hold until signalled, but never outlive the launcher (orphaned under launchd) nor a bounded time.
  const deadline = Date.now() + (cfg.holdMaxMs ?? 60000);
  while (Date.now() < deadline && process.ppid === LAUNCHER_PID) await sleep(100);
  log({ tool: name + ':hold-ended', orphaned: process.ppid !== LAUNCHER_PID });
  process.exit(99);
}
if (cfg.sleepMs) await sleep(cfg.sleepMs);
for (const state of connections.values()) state.socket.destroy();
// Exit explicitly: a loaded Sky wrapper keeps sockets and timers alive.
process.exit(cfg.exit || 0);
