// Private lifecycle transport for an already running Claude relay; never starts a host or an MCP client.
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, parse, posix, resolve } from 'node:path';

const LIMIT = 64 * 1024;
const ABSENCE_MS = 400;
// Separate from connection detection: parent cleanup can await several 120-second upstream cleanups.
const ACK_MS = 590_000;
const EVENTS = new Set(['PreToolUse', 'Stop', 'StopFailure', 'SubagentStop']);

export function registryDirectory(env = process.env, platform = process.platform) {
  const home = env.USERPROFILE && platform === 'win32' ? env.USERPROFILE : env.HOME || homedir();
  if (platform === 'win32') return join(home, '.lcu-claude-hooks');
  const account = createHash('sha256').update(resolve(home)).digest('hex').slice(0, 12);
  return `/tmp/lcu-claude-${process.getuid()}-${account}`;
}

export function endpointPath(directory, generation, platform = process.platform) {
  return platform === 'win32' ? `\\\\.\\pipe\\lcu-claude-${generation}` : posix.join(directory, `${generation}.sock`);
}

function privatePath(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Unsafe Claude lifecycle path');
  if (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
    throw new Error('Claude lifecycle path is not account-private');
  }
  return stat;
}

function windowsParents(path) {
  for (let part = resolve(path); part !== parse(part).root; part = dirname(part)) {
    if (lstatSync(part).isSymbolicLink()) throw new Error('Redirected Claude lifecycle path');
  }
}

// Linux exposes creation identity without spawning a process. Elsewhere a live relay also checks its current
// parent on every request. On POSIX an orphan cannot serve a later process reusing its old parent's PID.
function hostStart(pid) {
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

/** Publish only after upstream and downstream are ready. Each relay owns one unpredictable generation. */
export async function listenLifecycle(handle, { directory = registryDirectory(), hostPid = process.ppid } = {}) {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  privatePath(directory, true);
  if (process.platform === 'win32') {
    windowsParents(directory);
    // chmod is not a Windows ACL. New registration files inherit only the current account's full access.
    const { execFileSync } = await import('node:child_process');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; $p=$env:LCU_CLAUDE_HOOK_DIRECTORY; $acl=Get-Acl -LiteralPath $p; ' +
      '$acl.SetAccessRuleProtection($true,$false); foreach($r in @($acl.Access)){$acl.RemoveAccessRuleSpecific($r)}; ' +
      '$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; ' +
      '$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,"FullControl","ContainerInherit,ObjectInherit","None","Allow"); ' +
      '$acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl; $check=Get-Acl -LiteralPath $p; ' +
      'if(!$check.AreAccessRulesProtected){throw "Unprotected lifecycle directory ACL"}; ' +
      'foreach($r in $check.Access){if($r.AccessControlType -eq "Allow" -and ' +
      '$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value)' +
      '{throw "Foreign lifecycle directory access"}}'],
    { env: { ...process.env, LCU_CLAUDE_HOOK_DIRECTORY: directory }, windowsHide: true, stdio: 'pipe', timeout: 10_000 });
  }
  const generation = randomBytes(16).toString('hex');
  const entry = { v: 1, hostPid, hostStart: hostStart(hostPid), relayPid: process.pid, generation,
    token: randomBytes(32).toString('hex'), endpoint: endpointPath(directory, generation) };
  const path = join(directory, `${hostPid}-${generation}.json`);
  const sockets = new Set();
  let closing = false;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(ABSENCE_MS, () => socket.destroy());
    let data = '', received = false;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      if (received) return;
      data += chunk;
      if (Buffer.byteLength(data) > LIMIT) return socket.destroy();
      if (!data.includes('\n')) return;
      received = true;
      let request;
      try { request = JSON.parse(data.trim()); } catch { return socket.end('{"refused":true}\n'); }
      if (!request || typeof request !== 'object' || Array.isArray(request) ||
          closing || process.ppid !== hostPid || request.v !== 1 || request.hostPid !== hostPid ||
          request.hostStart !== entry.hostStart || hostStart(hostPid) !== entry.hostStart ||
          request.generation !== generation || request.token !== entry.token ||
          !(request.probe === true || EVENTS.has(request.hook?.hook_event_name))) {
        return socket.end('{"refused":true}\n');
      }
      if (request.probe === true) return socket.end('{"ready":true}\n');
      socket.setTimeout(0);
      // Acceptance ends the short detection budget. A disconnected helper never cancels accepted cleanup.
      socket.write('{"accepted":true}\n');
      Promise.resolve().then(() => handle(request.hook)).then(result => {
        socket.end(JSON.stringify(result?.isError ? { error: result.content?.[0]?.text || 'Lifecycle failed' } : { ok: true }) + '\n');
      }, error => socket.end(JSON.stringify({ error: error.message }) + '\n'));
    });
  });
  const remove = () => {
    try {
      privatePath(path);
      if (JSON.parse(readFileSync(path, 'utf8')).generation === generation) unlinkSync(path);
    } catch {}
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(entry.endpoint, resolve); });
    const temporary = `${path}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(entry), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path);
    } finally { try { unlinkSync(temporary); } catch {} }
  } catch (error) {
    server.close();
    throw error;
  }
  process.once('exit', remove);
  return { entry, path, close() {
    if (closing) return;
    closing = true;
    remove();
    process.off('exit', remove);
    server.close();
    for (const socket of sockets) socket.destroy();
    try { rmdirSync(directory); } catch {}
  } };
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
    const finish = (error, ready = false) => { socket.destroy(); error ? reject(error) : resolve(ready); };
    socket.setTimeout(ABSENCE_MS, () => finish(accepted ? new Error('Claude lifecycle acknowledgement timed out') : undefined));
    socket.on('error', () => finish());
    socket.on('close', () => resolve());
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
        if (response.accepted) { accepted = true; socket.setTimeout(ACK_MS); }
        else return finish(response.error ? new Error(response.error) : undefined);
      }
    });
  });
}
