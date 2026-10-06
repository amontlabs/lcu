// Port of tests/test_app_server_windows.py plus the app_server behaviours the Python suite only covers live
// (tests/codex_lifecycle.py): framing, server-originated requests, RPC errors, notifications, the child's argv/cwd/env,
// teardown and spawn errors. Children are this test's own Node scripts; only they are ever signalled.
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

import { lcu, tempdir } from './p4_support.mjs';

const { AppServer, AppServerRequestError, app_server, popen } = await lcu('app_server');

const SERVER = String.raw`
const fs = require('node:fs');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const log = process.env.FAKE_LOG;
if (log) fs.writeFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME, marker: process.env.FAKE_MARKER }) + '\n');
let buffer = '';
const seen = [];
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (log) fs.appendFileSync(log, line + '\n');
    const req = JSON.parse(line);
    seen.push(req);
    const mode = process.env.FAKE_MODE || 'echo';
    if (!('id' in req) || !('method' in req)) continue;
    if (req.method === 'initialize') { out({ id: req.id, result: mode === 'echo' ? { method: 'initialize' } : {} }); continue; }
    if (mode === 'echo') out({ id: req.id, result: { method: req.method } });
    else if (mode === 'sleep-exit' && req.method === 'ping') setTimeout(() => process.exit(0), 200);
    else if (mode === 'error') out({ id: req.id, error: { code: -1, message: 'no such method: ' + req.method } });
    else if (mode === 'request') {
      // A server-originated request and a notification arrive before the reply.
      out({ id: 'srv-1', method: 'item/approve', params: {} });
      out({ method: 'note', params: { n: 1 } });
      setTimeout(() => out({ id: req.id, result: { answered: seen.filter((m) => m.id === 'srv-1') } }), 50);
    }
  }
});
process.stdin.on('end', () => { if (process.env.FAKE_STAY) setInterval(() => {}, 1000); else process.exit(0); });
process.on('SIGTERM', () => { if (log) fs.appendFileSync(log, 'SIGTERM\n'); process.exit(0); });
// Safety net: every fixture child ends on its own (no orphan outlives a failed test).
setTimeout(() => process.exit(0), Number(process.env.LIFE || 60000)).unref();
`;

function server(t, env = {}) {
  const dir = tempdir(t);
  const script = `${dir}/server.cjs`;
  writeFileSync(script, SERVER);
  const child = popen([process.execPath, script], { cwd: dir, env: { ...process.env, ...env }, stderrFd: 'ignore' });
  child.fixtureDir = dir;
  t.after(() => {
    child.stdin_close();
    if (child.poll() === null) child.terminate();
    try { child.wait(5); } catch { child.kill(); child.wait(5); }
    child.close();
  });
  return child;
}

test('real subprocess pipe handles two rpc replies', (t) => {
  const client = new AppServer(server(t));
  assert.deepEqual([...client.initialization], [['method', 'initialize']]);
  assert.deepEqual([...client.call('ping', {})], [['method', 'ping']]);
  const call = client.callable();
  assert.deepEqual([...call('pong', {})], [['method', 'pong']]);
});

test('timeout then eof remain distinct', (t) => {
  const child = server(t, { FAKE_MODE: 'sleep-exit' });
  const client = new AppServer(child);
  assert.throws(() => client.call('ping', {}, 0.02), { name: 'ValueError', message: /timed out: ping/ });
  assert.throws(() => client.call('ping', {}, 0.02), { message: 'Bundled Codex app-server timed out: ping' });
  child.wait(5);
  for (let i = 0; i < 2; i++) {
    assert.throws(() => client.receive(0.1), { name: 'ValueError', message: /exited unexpectedly/ });
  }
  assert.throws(() => client.receive(0.1), { message: 'Bundled Codex app-server exited unexpectedly.' });
});

test('rpc errors are AppServerRequestError with the original message', (t) => {
  const client = new AppServer(server(t, { FAKE_MODE: 'error' }));
  assert.throws(() => client.call('config/batchWrite', {}), (error) => error instanceof AppServerRequestError &&
    error.message === 'no such method: config/batchWrite' && error.name === 'AppServerRequestError');
});

test('server-originated requests are refused and notifications reach subscribers only', (t) => {
  const client = new AppServer(server(t, { FAKE_MODE: 'request' }));
  const subscription = client.subscribe_notifications();
  const result = client.call('go', {});
  const answered = result.get('answered');
  assert.ok(Array.isArray(answered), String(answered));
  assert.equal(answered.length, 1);
  assert.deepEqual([...answered[0]], [['id', 'srv-1'], ['error', answered[0].get('error')]]);
  assert.deepEqual([...answered[0].get('error')], [['code', -32601], ['message', 'Server-originated requests are unsupported.']]);
  const note = subscription.receive(0);
  assert.equal(note.get('method'), 'note');
  assert.equal(subscription.receive(0), null);
  subscription.close();
  assert.equal(subscription.closed, true);
});

test('request handler envelopes are validated', (t) => {
  const child = server(t, { FAKE_MODE: 'request' });
  const client = new AppServer(child, (request) => ({ id: request.get('id'), result: { ok: true } }));
  const answered = client.call('go', {}).get('answered');
  assert.deepEqual([...answered[0].get('result')], [['ok', true]]);
  const bad = new AppServer(server(t, { FAKE_MODE: 'request' }), () => ({ id: 'other', result: {} }));
  assert.throws(() => bad.call('go', {}), { name: 'ValueError', message: 'App-server request handler returned an invalid response envelope.' });
});

test('app_server runs the CLI with the exact argv, cwd and env and shuts it down', (t) => {
  const dir = tempdir(t);
  const cli = `${dir}/codex`;
  writeFileSync(cli, `#!${process.execPath}\n${SERVER}`);
  chmodSync(cli, 0o755);
  const log = `${dir}/log.jsonl`;
  const result = app_server(cli, dir, { ...process.env, FAKE_LOG: log, FAKE_MARKER: 'm1', HOME: dir }, (call) => {
    assert.equal(typeof call, 'function');
    return call('hooks/list', { cwds: [dir] });
  });
  assert.deepEqual([...result], [['method', 'hooks/list']]);
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(JSON.parse(lines[0]), {
    argv: ['--strict-config', 'app-server', '--listen', 'stdio://'], cwd: dir, home: dir, marker: 'm1',
  });
  // The exact wire bytes LCU sends (Python json.dumps default separators, no jsonrpc field, int ids).
  assert.equal(lines[1], '{"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "lcu", "version": "0.3.0"}, "capabilities": {"experimentalApi": true}}}');
  assert.equal(lines[2], '{"method": "initialized"}');
  assert.equal(lines[3], `{"id": 2, "method": "hooks/list", "params": {"cwds": ["${dir}"]}}`);
});

test('app_server terminates a child that ignores EOF, and propagates body errors', (t) => {
  const dir = tempdir(t);
  const cli = `${dir}/codex`;
  writeFileSync(cli, `#!${process.execPath}\n${SERVER}`);
  chmodSync(cli, 0o755);
  const log = `${dir}/log.jsonl`;
  assert.throws(() => app_server(cli, dir, { ...process.env, FAKE_LOG: log, FAKE_STAY: '1' }, () => { throw new Error('body'); }), { message: 'body' });
  assert.ok(readFileSync(log, 'utf8').endsWith('SIGTERM\n'));
});

test('spawn failures read like Python Popen errors', (t) => {
  const dir = tempdir(t);
  assert.throws(() => app_server(`${dir}/missing`, dir, process.env, () => null),
    { message: `[Errno 2] No such file or directory: '${dir}/missing'` });
  assert.throws(() => app_server(process.execPath, `${dir}/nowhere`, process.env, () => null),
    { message: `[Errno 2] No such file or directory: '${dir}/nowhere'` });
  writeFileSync(`${dir}/plain`, 'x');
  assert.throws(() => app_server(`${dir}/plain`, dir, process.env, () => null),
    { message: `[Errno 13] Permission denied: '${dir}/plain'` });
  assert.equal(existsSync(`${dir}/nowhere`), false);
});

// ------------------------------------------------------------------------------------- transport failures (review P1-1, P2-2, P2-3)
const alive = (pid) => {
  try {
    process.kill(pid, 0); // signal 0: existence check only, nothing is delivered
    return true;
  } catch {
    return false;
  }
};

test('a worker fault while in flight is reported and the child stays supervised', (t) => {
  const child = server(t, { FAKE_STAY: '1', FAKE_LOG: '' });
  const client = new AppServer(child);
  // Fault the transport worker through its command seam (the review probe's injection).
  child.worker.postMessage({ cmd: 'write', data: null });
  assert.throws(() => client.receive(2), { name: 'ValueError', message: /^Lost the bundled Codex app-server connection: / });
  assert.throws(() => client.call('ping', {}), { message: /^Lost the bundled Codex app-server connection: / });
  const started = Date.now();
  assert.equal(child.poll(), null); // still running, answered by the live worker
  assert.ok(Date.now() - started < 2000);
  child.stdin_close();
  child.terminate();
  assert.equal(child.wait(5), 0); // the fixture exits 0 on SIGTERM
});

test('worker death is detected, the child is supervised directly and terminated', async (t) => {
  const child = server(t, { FAKE_STAY: '1' });
  const client = new AppServer(child);
  await child.worker.terminate(); // uncatchable death of the transport host
  const started = Date.now();
  assert.throws(() => client.receive(9), { message: 'Lost the bundled Codex app-server connection: the app-server process host stopped responding' });
  assert.ok(Date.now() - started < 8000, `detected after ${Date.now() - started} ms`);
  assert.ok(alive(child.pid));
  assert.equal(child.poll(), null); // the child is still running: not reported as exited
  child.terminate();
  child.wait(5);
  assert.notEqual(child.poll(), null);
});

test('app_server keeps the body error and still shuts the child down after transport loss', (t) => {
  const dir = tempdir(t);
  const cli = `${dir}/codex`;
  writeFileSync(cli, `#!${process.execPath}\n${SERVER}`);
  chmodSync(cli, 0o755);
  const log = `${dir}/log.jsonl`;
  let pid;
  const started = Date.now();
  assert.throws(() => app_server(cli, dir, { ...process.env, FAKE_LOG: log, FAKE_STAY: '1' }, (call) => {
    pid = call.client.process.pid;
    call.client.process.worker.postMessage({ cmd: 'write', data: null });
    throw new Error('body-original');
  }), { message: 'body-original' });
  assert.ok(Date.now() - started < 5000);
  assert.ok(readFileSync(log, 'utf8').endsWith('SIGTERM\n'));
  assert.ok(Number.isInteger(pid));
});

test('app_server cleanup after the host died keeps the body error and terminates the child', (t) => {
  const dir = tempdir(t);
  const cli = `${dir}/codex`;
  writeFileSync(cli, `#!${process.execPath}\n${SERVER}`);
  chmodSync(cli, 0o755);
  const log = `${dir}/log.jsonl`;
  const started = Date.now();
  assert.throws(() => app_server(cli, dir, { ...process.env, FAKE_LOG: log, FAKE_STAY: '1' }, (call) => {
    call.client.process.worker.terminate();
    throw new Error('body-original');
  }), { message: 'body-original' });
  assert.ok(Date.now() - started < 15000, `cleanup took ${Date.now() - started} ms`);
  assert.ok(readFileSync(log, 'utf8').endsWith('SIGTERM\n'));
});

test('failed spawns retain no worker', async (t) => {
  const dir = tempdir(t);
  const workers = new Set();
  const hook = createHook({
    init(id, type) { if (type === 'WORKER') workers.add(id); },
    destroy(id) { workers.delete(id); },
  }).enable();
  try {
    for (let i = 0; i < 3; i++) {
      assert.throws(() => popen([`${dir}/missing-${i}`], { cwd: dir, env: process.env, stderrFd: 'ignore' }),
        { message: `[Errno 2] No such file or directory: '${dir}/missing-${i}'` });
    }
    await sleep(300);
    assert.equal(workers.size, 0);
  } finally {
    hook.disable();
  }
});

test('an executable without a #! line is refused like execve (never run through a shell)', (t) => {
  const dir = tempdir(t);
  const cli = `${dir}/codex`;
  writeFileSync(cli, `touch '${dir}/ran'\n`);
  chmodSync(cli, 0o755);
  assert.throws(() => app_server(cli, dir, process.env, () => null), { message: `[Errno 8] Exec format error: '${cli}'` });
  assert.equal(existsSync(`${dir}/ran`), false);
});

// ------------------------------------------------------------------------------------------- round 2 R8 (Windows fixture)
const transport = await lcu('app_server');

// A Win32_Process answer for `pid` built from this host's real process table (fixture: no Windows host).
function fakePowershell(answer) {
  return (script) => {
    const pid = Number(/ProcessId=(\d+)/.exec(script)[1]);
    return answer(pid);
  };
}
const fromHost = (pid) => {
  const status = transport.internals.processStatus(pid, process.platform);
  if (!status.exists || !status.running) return { status: 0, stdout: 'none\r\n' };
  return { status: 0, stdout: `${status.ppid} 2026-10-06T08:00:00.1234567Z\r\n` };
};

function windowsFixture(t, answer) {
  const saved = { ...transport.internals };
  Object.assign(transport.internals, { platform: 'win32', powershell: fakePowershell(answer) });
  t.after(() => Object.assign(transport.internals, saved));
}

test('Windows: after worker loss a running child is still running, times out, and is terminated', async (t) => {
  windowsFixture(t, fromHost);
  const child = server(t, { FAKE_STAY: '1' });
  assert.equal(child.identity, '2026-10-06T08:00:00.1234567Z');
  await child.worker.terminate(); // actual loss of the transport host
  child.hostDead = 'fixture: worker terminated';
  assert.equal(child.poll(), null);
  assert.throws(() => child.wait(0.05), { name: 'TimeoutExpired' });
  assert.ok(alive(child.pid));
  child.terminate(); // identity-checked: this process's child, same creation time
  assert.notEqual(child.wait(5), null);
  assert.notEqual(child.poll(), null);
});

test('Windows: a child whose creation time differs is never signalled', async (t) => {
  windowsFixture(t, fromHost);
  const child = server(t, { FAKE_STAY: '1', LIFE: '1500' });
  await child.worker.terminate();
  child.hostDead = 'fixture: worker terminated';
  transport.internals.powershell = fakePowershell((pid) => ({ status: 0, stdout: `${process.pid} 2030-01-01T00:00:00Z` }));
  child.terminate();
  assert.ok(alive(child.pid)); // a different process now holds that pid: left alone
  transport.internals.powershell = fakePowershell(fromHost);
  child.wait(5); // the fixture child ends on its own timer
});

test('Windows: unavailable process information is never taken as an exit', async (t) => {
  windowsFixture(t, () => ({ status: 1, stdout: '', stderr: 'powershell unavailable' }));
  const child = server(t, { FAKE_STAY: '1', LIFE: '1500' });
  assert.equal(child.identity, null);
  await child.worker.terminate();
  child.hostDead = 'fixture: worker terminated';
  assert.equal(child.poll(), null);
  child.terminate(); // no identity: nothing is signalled
  assert.throws(() => child.wait(0.2), { name: 'TimeoutExpired' });
  assert.ok(alive(child.pid));
  transport.internals.powershell = fakePowershell(fromHost);
  child.wait(5);
});
