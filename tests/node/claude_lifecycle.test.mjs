import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverLifecycle, endpointPath, listenLifecycle } from '../../lcu/claude_lifecycle.mjs';

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
