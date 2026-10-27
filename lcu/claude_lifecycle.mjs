// Private lifecycle listener for an already running Claude relay.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  ABSENCE_MS, EVENTS, LIMIT, endpointPath, hostStart, privatePath, registryDirectory, windowsParents,
} from './claude_hook.mjs';
export { deliverLifecycle, endpointPath, registryDirectory } from './claude_hook.mjs';

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
