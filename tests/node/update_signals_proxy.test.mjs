// Round-2 review (.port/reviews/round2-config.md) regressions for the updater:
//   R7  SIGINT during the download or the installer handoff removes the temporary tree (Python's KeyboardInterrupt
//       runs apply's `finally`), and the installer child is ended the way subprocess.run does.
//   F41 update requests honour the Windows registry proxy settings (urllib's getproxies_registry /
//       proxy_bypass_registry) through compat/http's system proxy source. Windows FIXTURE only: the registry values
//       are a `reg.exe query` text fixture; nothing reads this machine's settings.
// Signals go only to children this test spawned in their own session, through tests/node/process_guard.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, test } from 'node:test';

import * as update from '../../lcu/update.mjs';
import * as apply from '../../lcu/update_apply.mjs';
import * as compatHttp from '../../lcu/compat/http.mjs';
import { own, send } from './process_guard.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SAVED_UPDATE = { ...update._inject };
const SAVED_APPLY = { ...apply._inject };
let tmp;
const servers = [];

beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-upd-sig-'))); });
afterEach(async () => {
  Object.assign(update._inject, SAVED_UPDATE);
  Object.assign(apply._inject, SAVED_APPLY);
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return server.address().port;
}

function tarHeader(name, size, mode = 0o644) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}
function tarGz(entries) {
  const parts = [];
  for (const [name, text, mode] of entries) {
    const data = Buffer.from(text);
    parts.push(tarHeader(name, data.length, mode), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

function installation() {
  const prefix = path.join(tmp, 'prefix');
  const release = path.join(prefix, 'releases', '0.9.1-abcdef012345');
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(prefix, '.lcu-install'), '');
  fs.writeFileSync(path.join(release, 'bundle.json'), '{"version": "0.9.1", "architecture": "x64"}');
  fs.writeFileSync(path.join(release, 'installation.json'), '{"platform": "linux", "architecture": "x64"}');
  const temp = path.join(tmp, 'tmp');
  fs.mkdirSync(temp);
  return { prefix, release, temp };
}

/** Run apply() in a child of its own session; resolves {child, exit} and the collected stdout/stderr. */
function updater(release, base, temp, env = {}) {
  const script = `import * as a from ${JSON.stringify(path.join(ROOT, 'lcu/update_apply.mjs'))};
a._inject.DOWNLOAD = process.argv[2]; a._inject.http = { env: {} }; a._inject.getuid = () => 1000;
try {
  const status = await a.apply(process.argv[1], { version: '0.9.2', tag: 'v0.9.2', release_url: 'fixture' }, { yes: true });
  process.stderr.write('\\nstatus ' + status);
} catch (error) {
  process.stderr.write('\\n' + error.name);
  // As lcu/entry.mjs does for an unhandled KeyboardInterrupt (Python re-raises SIGINT): end by SIGINT, now.
  if (error.name === 'KeyboardInterrupt') { process.removeAllListeners('SIGINT'); process.kill(process.pid, 'SIGINT'); }
  process.exitCode = 1;
}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, release, base],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, TMPDIR: temp, ...env } });
  own(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const exit = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, exit };
}

const until = async (predicate, ms = 15000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const tree = (dir) => fs.readdirSync(dir, { recursive: true }).sort();

test('R7: SIGINT during the download removes the partial archive and the temporary tree', async () => {
  const { release, temp } = installation();
  let sent = false;
  const port = await listen((req, res) => {
    res.writeHead(200, { 'Content-Length': 1 << 20 });
    res.write(Buffer.alloc(4096, 1), () => { sent = true; }); // then stall with the connection open
  });
  const { child, exit } = updater(release, `http://127.0.0.1:${port}`, temp);
  await until(() => sent && tree(temp).some((entry) => entry.endsWith('.tar.gz')));
  await new Promise((resolve) => setTimeout(resolve, 100)); // the 4 KiB are in flight inside the read
  assert.equal(send(child, 'SIGINT'), true);
  const result = await exit;
  assert.ok(result.stderr.endsWith('\nKeyboardInterrupt'), result.stderr);
  assert.equal(result.signal, 'SIGINT');
  assert.deepEqual(tree(temp), []);
});

test('R7: SIGINT during the installer ends it like subprocess.run and still removes the tree', async () => {
  const { release, temp } = installation();
  const marker = path.join(tmp, 'installer-started');
  const name = 'lcu-0.9.2-linux-x64';
  const archive = tarGz([[`${name}/bundle.json`, '{}', 0o644],
    [`${name}/scripts/install.sh`, 'printf started > "$LCU_TEST_MARKER"\nexec /bin/sleep 30\n', 0o755]]);
  const port = await listen((req, res) => {
    if (req.url.endsWith('.sha256')) res.end(`${crypto.createHash('sha256').update(archive).digest('hex')}  ${name}.tar.gz\n`);
    else res.end(archive);
  });
  const { child, exit } = updater(release, `http://127.0.0.1:${port}`, temp, { LCU_TEST_MARKER: marker });
  await until(() => fs.existsSync(marker));
  const started = Date.now();
  assert.equal(send(child, 'SIGINT'), true);
  const result = await exit;
  assert.ok(result.stderr.endsWith('\nKeyboardInterrupt'), result.stderr);
  assert.ok(Date.now() - started < 10000, 'the installer was not ended after the grace period');
  assert.deepEqual(tree(temp), []);
  assert.doesNotMatch(result.stdout, /installed/);
});

// ---------------------------------------------------------------- F41
const REG = (port, override = null) => [
  '', 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  '    ProxyEnable    REG_DWORD    0x1',
  `    ProxyServer    REG_SZ    127.0.0.1:${port}`,
  ...(override ? [`    ProxyOverride    REG_SZ    ${override}`] : []), '',
].join('\r\n');

test('F41: update requests go through the Windows registry proxy, and its override bypasses it', async () => {
  const seen = [];
  const proxyPort = await listen((req, res) => {
    seen.push(req.url);
    res.end(req.url.endsWith('/notes/v0.9.2/0.9.2.md') ? '<!-- lcu-severity: security -->\n' : 'via configured proxy');
  });
  const originPort = await listen((req, res) => res.end('abc'));
  update._inject.platform = () => 'win32';
  update._inject.systemProxy = () => compatHttp.registrySettings(compatHttp.parseRegQuery(REG(proxyPort)));
  apply._inject.http = { env: {} }; // no proxy environment variables: urllib then reads the registry
  assert.equal(await update.severity_of('v0.9.2', '0.9.2', { notesTemplate: 'http://origin.invalid/notes/%s/%s.md', env: {} }), 'security');
  assert.equal((await apply._fetch(`http://127.0.0.1:${originPort}/x.sha256`)).toString(), 'via configured proxy');
  assert.deepEqual(seen, ['http://origin.invalid/notes/v0.9.2/0.9.2.md', `http://127.0.0.1:${originPort}/x.sha256`]);
  // ProxyOverride: the listed host is fetched directly (proxy_bypass_registry).
  update._inject.systemProxy = () => compatHttp.registrySettings(compatHttp.parseRegQuery(REG(proxyPort, '<local>;127.0.0.1')));
  assert.equal((await apply._fetch(`http://127.0.0.1:${originPort}/y`)).toString(), 'abc');
  assert.equal(seen.length, 2);
  // Environment proxies win over the registry, as in urllib.
  apply._inject.http = { env: { http_proxy: `http://127.0.0.1:${originPort}` } };
  assert.equal((await apply._fetch('http://origin.invalid/z')).toString(), 'abc');
});

test('F41: the default system proxy source is compat/http\'s platform adapter', () => {
  assert.equal(update.system_proxy(), compatHttp.defaultSystemProxy);
});
