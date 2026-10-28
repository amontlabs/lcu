// LCU Claude lifecycle hook helper. Copied intact to account data; imports only Node builtins.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, parse, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMIT = 64 * 1024;
export const ABSENCE_MS = 400;
// Separate from connection detection: parent cleanup can await several 120-second upstream cleanups.
const ACK_MS = 590_000;
export const EVENTS = new Set(['PreToolUse', 'Stop', 'StopFailure', 'SubagentStop']);

export function registryDirectory(env = process.env, platform = process.platform) {
  const home = env.USERPROFILE && platform === 'win32' ? env.USERPROFILE : env.HOME || homedir();
  if (platform === 'win32') return win32.join(home, 'AppData', 'Local', 'LCU', 'claude', 'hooks');
  const account = createHash('sha256').update(resolve(home)).digest('hex').slice(0, 12);
  return `/tmp/lcu-claude-${process.getuid()}-${account}`;
}

export function endpointPath(directory, generation, platform = process.platform) {
  return platform === 'win32' ? `\\\\.\\pipe\\lcu-claude-${generation}` : posix.join(directory, `${generation}.sock`);
}

export function privatePath(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Unsafe Claude lifecycle path');
  if (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
    throw new Error('Claude lifecycle path is not account-private');
  }
  return stat;
}

export function windowsParents(path) {
  for (let part = resolve(path); part !== parse(part).root; part = dirname(part)) {
    if (lstatSync(part).isSymbolicLink()) throw new Error('Redirected Claude lifecycle path');
  }
}

// Linux exposes creation identity without spawning a process. Elsewhere a live relay also checks its current
// parent on every request. On POSIX an orphan cannot serve a later process reusing its old parent's PID.
export function hostStart(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];
  } catch { return null; }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function registrations(directory, hostPid) {
  privatePath(directory, true);
  if (process.platform === 'win32') windowsParents(directory);
  return readdirSync(directory).filter(name => name.startsWith(`${hostPid}-`) && name.endsWith('.json')).flatMap(name => {
    try {
      const path = join(directory, name);
      if (privatePath(path).size > LIMIT) return [];
      const entry = JSON.parse(readFileSync(path, 'utf8'));
      if (entry.v !== 1 || entry.hostPid !== hostPid || !/^[a-f0-9]{32}$/.test(entry.generation) ||
          !/^[a-f0-9]{64}$/.test(entry.token) || name !== `${hostPid}-${entry.generation}.json` ||
          entry.endpoint !== endpointPath(directory, entry.generation) || !alive(entry.relayPid) ||
          entry.hostStart !== hostStart(hostPid)) return [];
      return [entry];
    } catch { return []; }
  });
}

/** Missing, stale, ambiguous and refused routes are silent; acknowledged live failures are errors. */
export async function deliverLifecycle(hook, { directory = registryDirectory(), hostPid = process.ppid } = {}) {
  if (!EVENTS.has(hook?.hook_event_name)) return;
  let entries;
  try { entries = registrations(directory, hostPid); } catch { return; }
  // PID liveness is only a cheap filter: a crashed relay's PID can belong to an unrelated process.
  const ready = (await Promise.all(entries.map(async entry =>
    await exchange(entry, { probe: true }, true) ? entry : null))).filter(Boolean);
  if (ready.length !== 1) return;
  const entry = ready[0];
  // Tool inputs and assistant messages can be large; lifecycle needs only these identities.
  const context = Object.fromEntries(['hook_event_name', 'session_id', 'prompt_id', 'tool_use_id', 'agent_id']
    .filter(key => hook[key] !== undefined).map(key => [key, hook[key]]));
  await exchange(entry, { hook: context });
}

function exchange(entry, payload, probe = false) {
  const request = JSON.stringify({ ...entry, ...payload }) + '\n';
  if (Buffer.byteLength(request) > LIMIT) return;
  return new Promise((resolve, reject) => {
    const socket = createConnection(entry.endpoint);
    let data = '', accepted = false;
    const finish = (error, ready = false) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(ready); };
    let timer = setTimeout(() => finish(), ABSENCE_MS);
    socket.on('error', () => finish());
    socket.on('close', () => { clearTimeout(timer); resolve(); });
    socket.on('connect', () => socket.write(request));
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > LIMIT) return finish();
      while (data.includes('\n')) {
        const end = data.indexOf('\n');
        let response;
        try { response = JSON.parse(data.slice(0, end)); } catch { return finish(); }
        data = data.slice(end + 1);
        if (!response || typeof response !== 'object' || Array.isArray(response)) return finish();
        if (probe) return finish(undefined, response.ready === true);
        if (response.accepted) {
          if (!accepted) {
            clearTimeout(timer);
            timer = setTimeout(() => finish(new Error('Claude lifecycle acknowledgement timed out')), ACK_MS);
          }
          accepted = true;
        }
        else return finish(response.error ? new Error(response.error) : undefined);
      }
    });
  });
}

export async function main() {
  let input = '', bytes = 0;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16 * 1024 * 1024) return 0;
  }
  let hook;
  try { hook = JSON.parse(input); } catch { return 0; }
  await deliverLifecycle(hook);
  return 0;
}

function isMain() {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (isMain()) {
  try { await main(); } catch (error) {
    process.stderr.write(`LCU Claude hook: ${error.message}\n`);
    process.exitCode = 1;
  }
}
