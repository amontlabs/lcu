import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverLifecycle, endpointPath, listenLifecycle, prepareLifecycle, registryDirectory, hardenLifecycleDirectory } from '../../lcu/claude_lifecycle.mjs';

function temporary(t) {
  const path = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'lcu-ipc-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

const hook = { hook_event_name: 'Stop', session_id: 'session', prompt_id: 'prompt' };

async function request(entry, changes) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(entry.endpoint);
    let data = '';
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(changes === null ? null : { ...entry, hook, ...changes }) + '\n'));
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => resolve(data.trim().split('\n').map(line => JSON.parse(line))));
  });
}

test('lifecycle endpoint paths use private Unix sockets or unpredictable Windows pipes', () => {
  assert.equal(endpointPath('/private', 'abc', 'darwin'), '/private/abc.sock');
  assert.equal(endpointPath('C:\\private', 'abc', 'win32'), '\\\\.\\pipe\\lcu-claude-abc');
});

test('Windows registry is beside the installed helper under the selected profile, never the old root or a shared override', () => {
  assert.equal(registryDirectory({ USERPROFILE: 'C:\\Users\\fixture', HOME: 'C:\\other',
    LOCALAPPDATA: 'C:\\shared' }, 'win32'), 'C:\\Users\\fixture\\AppData\\Local\\LCU\\claude\\hooks');
});

test('Windows preparation and publication work when every PowerShell launch is forbidden', async t => {
  const directory = realpathSync(temporary(t));
  const script = `import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const platform = process.platform;
    cp.execFile = cp.execFileSync = () => { throw new Error('PowerShell is forbidden on the relay hot path'); };
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { prepareLifecycle } = await import(${JSON.stringify(new URL('../../lcu/claude_lifecycle.mjs', import.meta.url).href)});
    const publish = await prepareLifecycle({ directory: ${JSON.stringify(join(directory, 'hooks'))} });
    Object.defineProperty(process, 'platform', { value: platform });
    const listener = await publish(() => {});
    listener.close();`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5_000 });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('setup hardening retains private inheritable ACLs and ignores inherited PS7 module paths', t => {
  const directory = temporary(t);
  let ran = false;
  hardenLifecycleDirectory(join(directory, 'hooks'), { runAcl(file, args, options) {
    ran = true;
    assert.equal(file, 'powershell.exe');
    assert.equal(options.timeout, 30_000);
    assert.equal(options.windowsHide, true);
    assert.equal(Object.keys(options.env).some(key => key.toUpperCase() === 'PSMODULEPATH'), false);
    assert.ok(args.at(-1).includes('SetAccessRuleProtection($true,$false)'));
    assert.ok(args.at(-1).includes('FullControl'));
    assert.ok(args.at(-1).includes('Foreign lifecycle directory access'));
    assert.equal(options.env.LCU_CLAUDE_HOOK_DIRECTORY, join(directory, 'hooks'));
  } });
  assert.equal(ran, true);
  assert.deepEqual(readdirSync(join(directory, 'hooks')), []);
});

test('lifecycle publication waits for ACL success', async t => {
  const directory = temporary(t);
  let finish;
  const pending = listenLifecycle(() => {}, { directory, runAcl(file, args, options, callback) {
    assert.equal(file, 'powershell.exe');
    assert.equal(options.timeout, 30_000);
    assert.equal(options.windowsHide, true);
    assert.equal(Object.keys(options.env).some(key => key.toUpperCase() === 'PSMODULEPATH'), false);
    finish = callback;
  } });
  assert.deepEqual(readdirSync(directory), []);
  finish(null);
  const listener = await pending;
  t.after(() => listener.close());
  assert.equal(existsSync(listener.path), true);
});

test('completed preparation stays unpublished until explicitly committed and cancellation prevents publication', async t => {
  for (const cancelled of [false, true]) {
    const directory = temporary(t);
    const controller = new AbortController();
    const publish = await prepareLifecycle({ directory, signal: controller.signal,
      runAcl(file, args, options, callback) { callback(null); } });
    assert.deepEqual(readdirSync(directory), [], 'preparation opens no socket and writes no capability');
    if (cancelled) {
      controller.abort();
      await assert.rejects(publish(() => {}), { name: 'AbortError' });
      assert.deepEqual(readdirSync(directory), []);
    } else {
      const listener = await publish(() => {});
      t.after(() => listener.close());
      assert.equal(existsSync(listener.path), true);
    }
  }
});

test('ACL failure or cancellation never publishes a lifecycle endpoint', async t => {
  for (const cancelled of [false, true]) {
    const directory = temporary(t);
    const controller = new AbortController();
    let finish;
    const pending = listenLifecycle(() => {}, { directory, signal: controller.signal,
      runAcl(file, args, options, callback) { finish = callback; } });
    // Even a runner that reports success after cancellation cannot publish.
    if (cancelled) controller.abort();
    const refused = assert.rejects(pending, cancelled ? { name: 'AbortError' } : /ACL failed/);
    finish(cancelled ? null : new Error('ACL failed'));
    await refused;
    assert.deepEqual(readdirSync(directory), []);
  }
});

test('Windows setup-time ACL hardening ignores modules inherited through Node from PowerShell 7',
  { skip: process.platform !== 'win32' && 'requires Windows PowerShell and native directory ACLs' }, async t => {
    const directory = temporary(t);
    const modules = join(directory, 'modules');
    const security = join(modules, 'Microsoft.PowerShell.Security');
    mkdirSync(security, { recursive: true });
    // If module autoload uses the inherited path, Get-Acl fails just like an incompatible PS7 module.
    writeFileSync(join(security, 'Microsoft.PowerShell.Security.psm1'),
      'function Get-Acl { throw "Inherited incompatible module" }; Export-ModuleMember -Function Get-Acl');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
    const script = `import { hardenLifecycleDirectory } from ${JSON.stringify(new URL('../../lcu/claude_lifecycle.mjs', import.meta.url).href)};
      hardenLifecycleDirectory(${JSON.stringify(join(directory, 'registry'))});`;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...env, PsMoDuLePaTh: modules }, windowsHide: true, timeout: 45_000,
    });
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, '');
  });

test('lifecycle transport refuses token, generation, route and non-lifecycle messages', async t => {
  const directory = temporary(t);
  const calls = [];
  const listener = await listenLifecycle(value => { calls.push(value); }, { directory });
  t.after(() => listener.close());
  for (const changes of [null, { token: 'wrong' }, { generation: 'wrong' }, { hostPid: process.pid },
    { hostStart: 'reused-pid' }, { v: 2 }, { hook: { ...hook, hook_event_name: 'js' } }]) {
    assert.deepEqual(await request(listener.entry, changes), [{ refused: true }]);
  }
  assert.deepEqual(calls, []);
  await deliverLifecycle(hook, { directory });
  assert.deepEqual(calls, [hook]);
});

test('a stale, dead, ambiguous or unsafe registration never delivers lifecycle', async t => {
  const directory = temporary(t);
  const calls = [];
  const first = await listenLifecycle(value => { calls.push(value); }, { directory });
  const second = await listenLifecycle(value => { calls.push(value); }, { directory });
  t.after(() => { first.close(); second.close(); });
  await deliverLifecycle(hook, { directory });
  assert.deepEqual(calls, []);
  const entry = first.entry;
  second.close();
  for (const change of [{ relayPid: 2147483647 }, { hostStart: 'old-process' }, { endpoint: 'untrusted-path' }]) {
    writeFileSync(first.path, JSON.stringify({ ...entry, ...change }));
    await deliverLifecycle(hook, { directory });
    assert.deepEqual(calls, []);
  }
  if (process.platform !== 'win32') {
    writeFileSync(first.path, JSON.stringify(entry));
    chmodSync(first.path, 0o644);
    await deliverLifecycle(hook, { directory });
    assert.deepEqual(calls, []);
    chmodSync(first.path, 0o600);
  }
  first.close();
  // A crash leaves a well-formed registration pointing to a closed socket/pipe; it must return promptly.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(first.path, JSON.stringify(entry), { mode: 0o600 });
  const started = Date.now();
  await deliverLifecycle(hook, { directory });
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(calls, []);
});

test('a removed registration is republished and routes hooks without restarting the relay', async t => {
  const directory = temporary(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls = [];
  const listener = await listenLifecycle(value => { calls.push(value); }, { directory });
  t.after(() => listener.close());
  rmSync(listener.path);
  t.mock.timers.tick(60_000);
  assert.deepEqual(JSON.parse(readFileSync(listener.path, 'utf8')), listener.entry);
  await deliverLifecycle(hook, { directory });
  assert.deepEqual(calls, [hook]);
  listener.close();
  t.mock.timers.tick(60_000);
  assert.equal(existsSync(listener.path), false, 'shutdown must stop registration repair');
});

test('registration repair preserves replacements and refuses an unsafe directory', async t => {
  const directory = temporary(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const listener = await listenLifecycle(() => {}, { directory });
  t.after(() => listener.close());
  const replacement = JSON.stringify({ ...listener.entry, generation: 'replacement' });
  writeFileSync(listener.path, replacement);
  t.mock.timers.tick(60_000);
  assert.equal(readFileSync(listener.path, 'utf8'), replacement);
  if (process.platform !== 'win32') {
    rmSync(listener.path);
    chmodSync(directory, 0o755);
    t.mock.timers.tick(60_000);
    assert.equal(existsSync(listener.path), false);
    chmodSync(directory, 0o700);
  }
});

test('shutdown removes only its own registration and never a replacement generation', async t => {
  const directory = temporary(t);
  const first = await listenLifecycle(() => {}, { directory });
  const second = await listenLifecycle(() => {}, { directory });
  t.after(() => { first.close(); second.close(); });
  writeFileSync(first.path, JSON.stringify({ ...first.entry, generation: 'replacement' }));
  first.close();
  assert.equal(existsSync(first.path), true);
  assert.equal(existsSync(second.path), true);
  assert.equal(JSON.parse(readFileSync(first.path, 'utf8')).generation, 'replacement');
  second.close();
  assert.equal(existsSync(second.path), false);
  assert.deepEqual(readdirSync(directory), [first.path.split(/[\\/]/).at(-1)]);
});

test('an abandoned registration with a reused live PID cannot disable the current relay', async t => {
  const directory = temporary(t);
  const calls = [];
  const listener = await listenLifecycle(value => { calls.push(value); }, { directory });
  t.after(() => listener.close());
  const generation = 'f'.repeat(32);
  const abandoned = { ...listener.entry, relayPid: process.ppid, generation,
    endpoint: endpointPath(directory, generation) };
  const path = join(directory, `${abandoned.hostPid}-${generation}.json`);
  writeFileSync(path, JSON.stringify(abandoned), { mode: 0o600 });
  const bind = { hook_event_name: 'PreToolUse', session_id: 'current', prompt_id: 'p', tool_use_id: 'use' };
  const end = { hook_event_name: 'Stop', session_id: 'current', prompt_id: 'p' };
  await deliverLifecycle(bind, { directory });
  await deliverLifecycle(end, { directory });
  assert.deepEqual(calls, [bind, end]);
  assert.equal(existsSync(path), true, 'a helper must not unlink an endpoint registration');
});


test('refused and unresponsive candidates do not make a healthy listener ambiguous', async t => {
  const directory = temporary(t);
  const calls = [];
  const current = await listenLifecycle(value => { calls.push(value); }, { directory });
  const refused = await listenLifecycle(() => { assert.fail('a probe must not run lifecycle'); }, { directory });
  t.after(() => { current.close(); refused.close(); });
  writeFileSync(refused.path, JSON.stringify({ ...refused.entry, token: '0'.repeat(64) }));
  const generation = 'e'.repeat(32);
  const entry = { ...current.entry, generation, endpoint: endpointPath(directory, generation) };
  const chatter = createServer(socket => {
    // Incomplete replies must not reset the absolute handshake budget forever.
    const timer = setInterval(() => socket.write(' '), 20);
    socket.on('error', () => {});
    socket.on('close', () => clearInterval(timer));
  });
  t.after(() => chatter.close());
  await new Promise(resolve => chatter.listen(entry.endpoint, resolve));
  writeFileSync(join(directory, `${entry.hostPid}-${generation}.json`), JSON.stringify(entry), { mode: 0o600 });
  const started = Date.now();
  await deliverLifecycle(hook, { directory });
  assert.deepEqual(calls, [hook]);
  assert.ok(Date.now() - started < 2_000);
});
