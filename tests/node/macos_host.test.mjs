// Port of the macos_host cases of tests/test_macos_runtime.py plus protocol bounds from the Python host.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { own, send as sendSignal, verify } from './process_guard.mjs';
import {
  TURN_ENDED_CLI_TIMEOUT_SECONDS, internals, run_turn_ended, start_original_host, stop_original_host, turn_ended_payload,
} from '../../lcu/macos_host.mjs';

// SAFETY (.port/BRIEF.md): every host this file starts runs in its own session (detached => setsid), its identity
// is recorded at spawn, and the module may only signal it after process_guard.verify() re-checks that identity.
internals.spawn_options = { detached: true };
internals.after_spawn = own;
internals.before_signal = (handle) => assert.ok(verify(handle), 'refusing to signal an unverified process');

const HOST = fileURLToPath(new URL('../../lcu/macos_host.mjs', import.meta.url));
const CONTROL_SERVICE = fileURLToPath(new URL('../macos_control_service.mjs', import.meta.url));
const skip = process.platform === 'win32' ? 'macOS launcher and its Unix-socket lifecycle host' : false;

let root;
before(() => { if (!skip) root = mkdtempSync('/tmp/lcu-mh-'); });
after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

const clientScript = (body) => `#!${process.execPath}\n${body}\n`;
function writeClient(name, body) {
  const file = join(root, name);
  writeFileSync(file, clientScript(body));
  chmodSync(file, 0o755);
  return file;
}

/** One request/response over a unix socket; resolves with the raw response bytes (until close). */
function exchange(address, raw, { end = false, timeout = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, timeout);
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes(10)) { clearTimeout(timer); socket.destroy(); resolve(Buffer.concat(chunks)); }
    });
    socket.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    socket.on('connect', () => { socket.write(raw); if (end) socket.end(); });
  });
}
const request = async (address, value, options) => JSON.parse(await exchange(address, typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value)}\n`, options));

async function host(client, extra = {}) {
  const [child, temporary, address] = await start_original_host({
    node: process.execPath, client, entry: HOST, env: { ...process.env }, ...extra,
  });
  return { child, temporary, address, stop: (options) => stop_original_host(child, temporary, options) };
}

describe('macos_host', { skip }, () => {
  test('turn_ended_payload is compact JSON with ASCII escapes in key order', () => {
    assert.equal(turn_ended_payload('s', 't'), '{"type":"agent-turn-complete","thread-id":"s","turn-id":"t"}');
    assert.equal(turn_ended_payload('é\u{1F600}"', ' '),
      '{"type":"agent-turn-complete","thread-id":"\\u00e9\\ud83d\\ude00\\"","turn-id":"\\u2028"}');
  });

  test('lifecycle host passes ids to fake original client', async () => {
    const capture = join(root, 'client-argv.json');
    const client = writeClient('fake-client', `require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));`);
    const h = await host(client);
    try {
      const mode = statSync(h.address).mode & 0o777;
      assert.equal(mode, 0o600);
      assert.equal(statSync(h.temporary.name).mode & 0o777, 0o700);
      // /private/tmp where it exists (macOS), else the platform temporary directory (Python's mkdtemp default).
      const socketRoot = existsSync('/private/tmp') ? '/private/tmp' : tmpdir();
      assert.match(h.temporary.name, new RegExp(`^${socketRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/lcu-ml-[a-z0-9_]{8}$`));
      const malformed = await request(h.address, '{"session_id":"","turn_id":"turn-exact"}\n');
      assert.equal(malformed.notified, false);
      assert.match(malformed.error, /turn IDs are missing/);
      assert.deepEqual(await request(h.address, '{"session_id":"session-exact","turn_id":"turn-exact"}\n'), { notified: true });
      const argv = JSON.parse(readFileSync(capture, 'utf8'));
      assert.equal(argv[0], 'turn-ended');
      assert.deepEqual(JSON.parse(argv[1]), { type: 'agent-turn-complete', 'thread-id': 'session-exact', 'turn-id': 'turn-exact' });
    } finally {
      await h.stop();
    }
  });

  test('lifecycle host passes non-ASCII ids as ASCII-escaped payload bytes', async () => {
    const capture = join(root, 'client-argv-unicode.json');
    const client = writeClient('fake-client-unicode', `require('node:fs').writeFileSync(${JSON.stringify(capture)}, process.argv[3]);`);
    const h = await host(client);
    try {
      const response = await exchange(h.address, Buffer.from('{"session_id":"sé","turn_id":"t\u{1F600}"}\n', 'utf8'));
      assert.equal(response.toString(), '{"notified":true}\n');
      assert.equal(readFileSync(capture, 'latin1'),
        '{"type":"agent-turn-complete","thread-id":"s\\u00e9","turn-id":"t\\ud83d\\ude00"}');
    } finally {
      await h.stop();
    }
  });

  test('host entry reached through a symlinked release path still serves', async () => {
    const link = join(root, 'current-lcu');
    symlinkSync(dirname(HOST), link, 'dir');
    const client = writeClient('ok-client-link', 'process.exit(0);');
    const [child, temporary, address] = await start_original_host({
      node: process.execPath, client, entry: join(link, 'macos_host.mjs'), env: { ...process.env } });
    try {
      assert.deepEqual(await request(address, '{"session_id":"a","turn_id":"b"}\n'), { notified: true });
    } finally {
      await stop_original_host(child, temporary);
    }
  });

  test('lifecycle host reports original client failure', async () => {
    const client = writeClient('failing-client', 'process.exit(23);');
    const h = await host(client);
    try {
      const result = await request(h.address, '{"session_id":"session","turn_id":"turn"}\n');
      assert.equal(result.notified, false);
      assert.match(result.error, /status 23/);
      assert.equal(result.error, 'Original turn-ended command exited with status 23.');
    } finally {
      await h.stop();
    }
  });

  test('lifecycle host framing bounds, malformed JSON and exact reply bytes', async () => {
    const client = writeClient('ok-client', 'process.exit(0);');
    const h = await host(client);
    try {
      const framing = await exchange(h.address, Buffer.alloc(4097, 0x61));
      assert.equal(framing.toString(), '{"notified":false,"error":"Invalid macOS control request size or framing."}\n');
      // A 4096-byte line is accepted (newline at index 4096); content then fails ID validation.
      const long = await exchange(h.address, Buffer.concat([Buffer.alloc(4096, 0x20), Buffer.from('\n')]));
      assert.equal(JSON.parse(long).error, 'Expecting value: line 1 column 4097 (char 4096)');
      const bad = await exchange(h.address, '{bad\n');
      assert.equal(bad.toString(), '{"notified":false,"error":"Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"}\n');
      const closed = await exchange(h.address, '{"session_id"', { end: true });
      assert.equal(closed.toString(), '{"notified":false,"error":"macOS control connection closed before a complete request."}\n');
      const nonDict = await exchange(h.address, '[1]\n');
      assert.equal(nonDict.toString(), '{"notified":false,"error":"Original macOS turn IDs are missing."}\n');
      assert.equal(h.child.poll(), null);
    } finally {
      await h.stop();
    }
  });

  test('lifecycle host read timeout is 3 seconds and the host keeps serving', async () => {
    const client = writeClient('ok-client-2', 'process.exit(0);');
    const h = await host(client);
    try {
      const started = Date.now();
      const idle = net.createConnection(h.address);
      const idleChunks = [];
      idle.on('error', () => {});
      idle.on('data', (chunk) => idleChunks.push(chunk));
      const queued = request(h.address, '{"session_id":"a","turn_id":"b"}\n');
      await new Promise((resolve) => idle.once('close', resolve));
      const elapsed = Date.now() - started;
      assert.equal(Buffer.concat(idleChunks).toString(), '{"notified":false,"error":"timed out"}\n');
      assert.ok(elapsed >= 2900 && elapsed < 6000, `elapsed ${elapsed}`);
      assert.deepEqual(await queued, { notified: true });
    } finally {
      await h.stop();
    }
  });

  test('lifecycle host kills a client after 10 seconds', async () => {
    const client = writeClient('slow-client', 'setTimeout(() => {}, 30000);');
    const h = await host(client);
    try {
      const result = await request(h.address, '{"session_id":"a","turn_id":"b"}\n', { timeout: 14000 });
      assert.equal(result.notified, false);
      assert.equal(result.error, 'Original turn-ended command timed out after 10 seconds.');
    } finally {
      await h.stop();
    }
  });

  // ---- #24: the original helper takes about 5.2 s, so the host allows 10 s and logs slow or failed runs

  test('lifecycle host waits for the original helper runtime', async () => {
    assert.ok(TURN_ENDED_CLI_TIMEOUT_SECONDS > 6);
    const client = writeClient('slow-5s-client', 'setTimeout(() => {}, 5200);');
    const h = await host(client);
    try {
      const started = Date.now();
      const result = await request(h.address, '{"session_id":"session","turn_id":"turn"}\n', { timeout: TURN_ENDED_CLI_TIMEOUT_SECONDS * 1000 + 3000 });
      assert.deepEqual(result, { notified: true });
      assert.ok(Date.now() - started >= 5200);
    } finally {
      await h.stop();
    }
  });

  /** run_turn_ended with the host's stderr line captured. */
  async function runTurnEnded(client, options = {}) {
    // writeFd writes to fd 2 directly, so run it in a child and capture that child's stderr.
    const script = `
      import { run_turn_ended } from ${JSON.stringify(new URL('../../lcu/macos_host.mjs', import.meta.url).href)};
      const started = Date.now();
      let error = null;
      try { await run_turn_ended(${JSON.stringify(String(client))}, '{}'${options.timeout !== undefined ? `, ${options.timeout}` : ''}); }
      catch (exc) { error = exc.message; }
      process.stdout.write(JSON.stringify({ error, elapsed: Date.now() - started }));
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 0, run.stderr);
    return { ...JSON.parse(run.stdout), log: run.stderr };
  }

  test('turn-ended command past its timeout fails within bounds', async () => {
    const client = join(root, 'hung-client');
    writeFileSync(client, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(client, 0o755);
    const { error, log, elapsed } = await runTurnEnded(client, { timeout: 1 });
    assert.equal(error, 'Original turn-ended command timed out after 1 seconds.');
    assert.ok(elapsed < 5000, `elapsed ${elapsed}`);
    assert.match(log, /exit=timeout/);
    assert.match(log, /elapsed=\d{4} ms/);
  });

  test('turn-ended timeout logs the stderr captured so far', async () => {
    const client = writeClient('pending-client', `process.stderr.write('connect pending'); setTimeout(() => {}, 30000);`);
    const { error, log } = await runTurnEnded(client, { timeout: 1 });
    assert.equal(error, 'Original turn-ended command timed out after 1 seconds.');
    assert.match(log, /exit=timeout/);
    assert.match(log, /connect pending/);
  });

  test('turn-ended command failure logs the exit code and bounded stderr', async () => {
    const client = writeClient('noisy-client', `process.stderr.write('e'.repeat(2000)); process.exit(7);`);
    const { error, log } = await runTurnEnded(client);
    assert.equal(error, 'Original turn-ended command exited with status 7.');
    assert.match(log, /exit=7 /);
    assert.ok(log.includes('e'.repeat(512)));
    assert.ok(!log.includes('e'.repeat(513)));
  });

  test('turn-ended command that cannot start is logged', async () => {
    const { error, log } = await runTurnEnded(join(root, 'missing-client'));
    assert.equal(error, 'Original turn-ended command could not start: No such file or directory.');
    assert.match(log, /exit=launch-failed/);
  });

  test('turn-ended command logs a slow success but not a fast one', async () => {
    // TURN_ENDED_CLI_SLOW_SECONDS is 4.5: use a client that really takes that long.
    const slow = writeClient('slow-ok-client', 'setTimeout(() => {}, 4600);');
    const slowRun = await runTurnEnded(slow);
    assert.equal(slowRun.error, null);
    assert.match(slowRun.log, /exit=0 elapsed=\d+ ms/);
    const fast = writeClient('fast-ok-client', '');
    const fastRun = await runTurnEnded(fast);
    assert.equal(fastRun.error, null);
    assert.equal(fastRun.log, '');
  });

  test('stdin EOF stops the host, removes the socket and the temp dir', async () => {
    const client = writeClient('ok-client-3', 'process.exit(0);');
    const h = await host(client);
    assert.ok(existsSync(h.address));
    await h.stop();
    assert.equal(h.child.returncode, 0);
    assert.equal(existsSync(h.temporary.name), false);
  });

  test('stop terminates a host that ignores stdin EOF (wait, TERM, wait)', async () => {
    const client = writeClient('ok-client-4', 'process.exit(0);');
    const stuck = join(root, 'stuck-entry.mjs');
    writeFileSync(stuck, `console.log(JSON.stringify({ready:true,socket:process.argv[4]})); setInterval(()=>{},1000);\n`);
    const [child, temporary] = await start_original_host({ node: process.execPath, client, entry: stuck, env: { ...process.env } }).catch(async (error) => { throw error; });
    const started = Date.now();
    await assert.rejects(() => stop_original_host(child, temporary), /exited with status -15\./);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 4900 && elapsed < 8000, `elapsed ${elapsed}`);
    assert.equal(existsSync(temporary.name), false);
  });

  test('start rejects incomplete clients and bad readiness', async () => {
    await assert.rejects(() => start_original_host({ node: process.execPath, client: join(root, 'missing'), entry: HOST, env: {} }),
      /The selected original macOS computer-use client is incomplete\./);
    const plain = join(root, 'plain');
    writeFileSync(plain, 'x');
    chmodSync(plain, 0o644);
    await assert.rejects(() => start_original_host({ node: process.execPath, client: plain, entry: HOST, env: {} }),
      /incomplete/);
    const client = writeClient('ok-client-5', 'process.exit(0);');
    const wrong = join(root, 'wrong-entry.mjs');
    writeFileSync(wrong, `console.log(JSON.stringify({ready:true,socket:'/elsewhere'})); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));\n`);
    await assert.rejects(() => start_original_host({ node: process.execPath, client, entry: wrong, env: { ...process.env } }),
      /Original macOS lifecycle host failed to become ready\./);
    const early = join(root, 'early-entry.mjs');
    writeFileSync(early, 'console.log("not ready");\n');
    await assert.rejects(() => start_original_host({ node: process.execPath, client, entry: early, env: { ...process.env } }),
      /Original macOS lifecycle host failed to become ready\./);
  });

  test('ready record accepts exactly {ready: true, socket} (Python dict equality)', async () => {
    const client = writeClient('ok-client-6', 'process.exit(0);');
    const entry = join(root, 'equal-entry.mjs');
    writeFileSync(entry, `console.log('{"socket": "' + process.argv[4] + '", "ready": 1}'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));\n`);
    const [child, temporary] = await start_original_host({ node: process.execPath, client, entry, env: { ...process.env } });
    await stop_original_host(child, temporary);
  });

  test('control socket routes only to an active trusted session and turn', async () => {
    const client = writeClient('unused-original-client', 'process.exit(99);');
    const control = join(root, 'control.sock');
    const h = await host(client, { control_address: control });
    const service = net.createConnection(control);
    let received = '';
    const waiters = [];
    service.on('data', (chunk) => { received += chunk; for (const w of waiters.splice(0)) w(); });
    const nextLine = async () => {
      while (!received.includes('\n')) await new Promise((r) => waiters.push(r));
      const line = received.slice(0, received.indexOf('\n'));
      received = received.slice(received.indexOf('\n') + 1);
      return JSON.parse(line);
    };
    try {
      for (let i = 0; i < 400 && !existsSync(control); i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.ok(existsSync(control));
      assert.equal(statSync(control).mode & 0o777, 0o600);
      await new Promise((r) => service.once('connect', r));
      service.write('{"type":"service"}\n{"type":"context","token":"tool-1","session_id":"session-exact","turn_id":"turn-exact","app":"Fixture App"}\n');

      const wrongTurn = await request(control, { type: 'status', session_id: 'session-exact', turn_id: 'other-turn' });
      assert.equal(wrongTurn.ok, false);
      assert.match(wrongTurn.error, /not active/);

      const wrongApp = request(control, { type: 'stop', session_id: 'session-exact', turn_id: 'turn-exact', app: 'com.other.App' });
      const wrongAppCommand = await nextLine();
      assert.equal(wrongAppCommand.app, 'com.other.App');
      service.write(`${JSON.stringify({ type: 'result', request_id: wrongAppCommand.request_id, response: { ok: false, error: 'selected app is not targeted' } })}\n`);
      const wrongAppResult = await wrongApp;
      assert.equal(wrongAppResult.ok, false);
      assert.match(wrongAppResult.error, /not targeted/);

      const startedAt = Date.now();
      const pending = request(control, { type: 'stop', session_id: 'session-exact', turn_id: 'turn-exact', app: 'com.fixture.App' });
      const command = await nextLine();
      assert.deepEqual(Object.keys(command), ['type', 'request_id', 'session_id', 'turn_id', 'deadline_unix_ms', 'app']);
      assert.equal(command.type, 'stop');
      assert.equal(command.session_id, 'session-exact');
      assert.equal(command.turn_id, 'turn-exact');
      assert.equal(command.app, 'com.fixture.App');
      const remaining = command.deadline_unix_ms - startedAt;
      assert.ok(remaining >= 39000 && remaining <= 41000, `remaining ${remaining}`);
      service.write(`${JSON.stringify({ type: 'result', request_id: command.request_id, response: { ok: true, result: { accepted: true, applicationId: 'com.fixture.App' } } })}\n`);
      assert.deepEqual(await pending, { ok: true, result: { accepted: true, applicationId: 'com.fixture.App' } });

      // Status needs no app; request validation messages are exact.
      assert.deepEqual(await request(control, { type: 'stop', session_id: 's', turn_id: 't' }),
        { ok: false, error: 'An application bundle ID is required to stop computer use.' });
      assert.deepEqual(await request(control, { type: 'other' }), { ok: false, error: 'Unsupported macOS control request.' });
      assert.deepEqual(await request(control, { type: 'status', session_id: ' ', turn_id: 't' }),
        { ok: false, error: 'Real macOS control session and turn IDs are required.' });
      // A second service is refused with the exact message and the first stays connected.
      assert.deepEqual(await request(control, { type: 'service' }),
        { ok: false, error: 'A trusted macOS control service is already connected.' });
      // Concurrent control connections while a lifetime cleanup is in flight.
      const concurrent = await Promise.all([
        request(control, { type: 'status', session_id: 'session-exact', turn_id: 'nope' }),
        request(h.address, '{"session_id":"x","turn_id":"y"}\n'),
      ]);
      assert.equal(concurrent[0].ok, false);
      assert.equal(concurrent[1].notified, false);
      assert.equal(concurrent[1].error, 'Original turn-ended command exited with status 99.');
    } finally {
      service.destroy();
      await h.stop();
    }
  });

  test('service disconnect fails pending requests; context errors end only the service connection', async () => {
    const client = writeClient('unused-original-client-2', 'process.exit(99);');
    const control = join(root, 'control-2.sock');
    const h = await host(client, { control_address: control });
    try {
      for (let i = 0; i < 400 && !existsSync(control); i += 1) await new Promise((r) => setTimeout(r, 10));
      const service = net.createConnection(control);
      await new Promise((r) => service.once('connect', r));
      service.write('{"type":"service"}\n{"type":"context","token":"a","session_id":"s","turn_id":"t"}\n');
      const pending = request(control, { type: 'status', session_id: 's', turn_id: 't' });
      await new Promise((r) => setTimeout(r, 300));
      service.destroy();
      assert.deepEqual(await pending, { ok: false, error: 'Trusted macOS control service disconnected.' });
      // The active contexts were cleared with the service.
      const late = net.createConnection(control);
      await new Promise((r) => late.once('connect', r));
      late.write('{"type":"service"}\n{"type":"context","token":"b","session_id":"s","turn_id":"t"}\n');
      const lateChunks = [];
      late.on('data', (c) => lateChunks.push(c));
      await new Promise((r) => setTimeout(r, 300));
      const again = request(control, { type: 'status', session_id: 's', turn_id: 't' });
      await new Promise((r) => setTimeout(r, 300));
      const command = JSON.parse(Buffer.concat(lateChunks).toString().split('\n')[0]);
      late.write(`${JSON.stringify({ type: 'result', request_id: command.request_id, response: { ok: true } })}\n`);
      assert.deepEqual(await again, { ok: true });
      // An unhashable token in context-ended surfaces as the exact Python TypeError text on that connection.
      late.write('{"type":"context-ended","token":[1]}\n');
      await new Promise((r) => setTimeout(r, 300));
      assert.match(Buffer.concat(lateChunks).toString(), /\{"ok":false,"error":"unhashable type: 'list'"\}\n$/);
      late.destroy();
    } finally {
      await h.stop();
    }
  });

  test('optional control socket failure keeps original lifecycle host alive', async () => {
    const client = writeClient('unused-original-client-3', 'process.exit(0);');
    const occupied = join(root, 'occupied-control.sock');
    writeFileSync(occupied, 'owned by another process');
    const h = await host(client, { control_address: occupied });
    try {
      assert.equal(h.child.poll(), null);
      assert.deepEqual(await request(h.address, '{"session_id":"session","turn_id":"turn"}\n'), { notified: true });
      assert.equal(readFileSync(occupied, 'utf8'), 'owned by another process');
    } finally {
      await h.stop();
    }
  });

  test('control socket failure is reported on stderr with the Python text', async () => {
    const client = writeClient('unused-original-client-4', 'process.exit(0);');
    const occupied = join(root, 'occupied-control-2.sock');
    writeFileSync(occupied, 'x');
    const address = join(root, 'direct-lifetime.sock');
    const run = spawnSync(process.execPath, [HOST, 'serve', address, client, occupied], { input: '', encoding: 'utf8', timeout: 20000 });
    assert.equal(run.status, 0);
    assert.match(run.stderr, /^LCU macOS user control unavailable: \[Errno (48|98)\] Address already in use\n$/);
    assert.equal(run.stdout, `{"ready": true, "socket": ${JSON.stringify(address)}}\n`);
    assert.equal(existsSync(address), false);
  });

  // ---- regressions for .port/reviews/port-hosts.md (probes in .port/reviews/probes-hosts/macos/)

  test('R1: client exited but a descendant holds its pipes: timeout reply at 10 s, host keeps serving and stops', async () => {
    const client = writeClient('descendant-client',
      `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 13000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: false }).unref(); process.exit(0);`);
    const h = await host(client);
    try {
      const started = Date.now();
      const reply = await exchange(h.address, '{"session_id":"session-exact","turn_id":"turn-exact"}\n', { timeout: 14000 });
      const elapsed = Date.now() - started;
      assert.equal(reply.toString(), '{"notified":false,"error":"Original turn-ended command timed out after 10 seconds."}\n');
      assert.ok(elapsed >= 9900 && elapsed < 11500, `elapsed ${elapsed}`);
      // The lifetime queue is free again: the next request is handled at once.
      assert.equal((await exchange(h.address, 'null\n', { timeout: 1000 })).toString(),
        '{"notified":false,"error":"Original macOS turn IDs are missing."}\n');
    } finally {
      const started = Date.now();
      await h.stop();
      assert.equal(h.child.returncode, 0);
      assert.ok(Date.now() - started < 2000, 'EOF shutdown must not wait for the descendant');
    }
  });

  test('R3: an executable without "#!" fails with Exec format error like execve, never through /bin/sh', async () => {
    const marker = join(root, 'shell-ran');
    const client = join(root, 'no-shebang');
    writeFileSync(client, `touch ${marker}\nexit 0\n`);
    chmodSync(client, 0o755);
    const h = await host(client);
    try {
      const reply = await exchange(h.address, '{"session_id":"s","turn_id":"t"}\n');
      assert.equal(reply.toString(), '{"notified":false,"error":"Original turn-ended command could not start: Exec format error."}\n');
      assert.equal(existsSync(marker), false);
    } finally {
      await h.stop();
    }
  });

  test('R4: a partial stdin line blocks request handling until its newline, like sys.stdin.readline()', async () => {
    const client = writeClient('ok-client-r4', 'process.exit(0);');
    const h = await host(client);
    try {
      h.child.stdin.write('x');
      await new Promise((r) => setTimeout(r, 150));
      await assert.rejects(() => exchange(h.address, '{"session_id":"a","turn_id":"b"}\n', { timeout: 600 }), /timeout/);
      const pending = exchange(h.address, '{"session_id":"a","turn_id":"b"}\n', { timeout: 4000 });
      await new Promise((r) => setTimeout(r, 100));
      h.child.stdin.write('\n');
      assert.equal((await pending).toString(), '{"notified":true}\n');
      // Complete lines are consumed without blocking.
      h.child.stdin.write('line\n');
      assert.equal((await exchange(h.address, '{"session_id":"a","turn_id":"b"}\n')).toString(), '{"notified":true}\n');
    } finally {
      await h.stop();
    }
  });

  test('R5: connections waiting behind a blocked request are bounded (8), extras are closed at once', async () => {
    const client = writeClient('ok-client-r5', 'process.exit(0);');
    const h = await host(client);
    const sockets = [];
    try {
      const idle = net.createConnection(h.address);
      idle.on('error', () => {});
      sockets.push(idle);
      await new Promise((r) => idle.once('connect', r));
      await new Promise((r) => setTimeout(r, 50));
      const outcomes = [];
      for (let i = 0; i < 20; i += 1) {
        const socket = net.createConnection(h.address);
        sockets.push(socket);
        outcomes.push(new Promise((resolve) => {
          socket.on('error', () => resolve('closed'));
          socket.on('close', () => resolve('closed'));
          setTimeout(() => resolve('waiting'), 600);
        }));
        await new Promise((r) => setTimeout(r, 10));
      }
      const results = await Promise.all(outcomes);
      assert.equal(results.filter((r) => r === 'waiting').length, 8);
      assert.equal(results.filter((r) => r === 'closed').length, 12);
    } finally {
      for (const socket of sockets) socket.destroy();
      await h.stop();
    }
  });

  test('R6: a socket path that leaves no room for the terminating NUL is refused like Python', () => {
    const client = writeClient('ok-client-r6', 'process.exit(0);');
    const limit = process.platform === 'darwin' ? 104 : 108;
    const dir = mkdtempSync('/tmp/lcu-r6-');
    try {
      const fill = (n) => join(dir, 'x'.repeat(n - dir.length - 1));
      const refused = spawnSync(process.execPath, [HOST, 'serve', fill(limit), client], { input: '', encoding: 'utf8', timeout: 20000 });
      assert.equal(refused.status, 1);
      assert.equal(refused.stdout, '');
      assert.equal(refused.stderr, 'AF_UNIX path too long\n');
      const accepted = spawnSync(process.execPath, [HOST, 'serve', fill(limit - 1), client], { input: '', encoding: 'utf8', timeout: 20000 });
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(accepted.stdout, `{"ready": true, "socket": "${fill(limit - 1)}"}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('R7: a failing diagnostic write closes the request and stops the host with status 120', async () => {
    const client = writeClient('ok-client-r7', 'process.exit(0);');
    const address = join(root, 'r7.sock');
    const { spawn } = await import('node:child_process');
    const child = own(spawn(process.execPath, [HOST, 'serve', address, client], { stdio: ['pipe', 'pipe', 'pipe'], detached: true }));
    try {
      await new Promise((resolve) => child.stdout.once('data', resolve));
      child.stderr.destroy();
      await new Promise((r) => setTimeout(r, 50));
      const reply = await exchange(address, 'null\n', { timeout: 3000 });
      assert.equal(reply.toString(), '');
      const status = await new Promise((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once('exit', resolve)));
      assert.equal(status, 120);
      assert.equal(existsSync(address), false);
    } finally {
      sendSignal(child, 'SIGTERM');
    }
  });

  test('trusted control dispatch preserves original runtime context', () => {
    const result = spawnSync(process.execPath, [CONTROL_SERVICE], { encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /macOS trusted control dispatch checks passed/);
  });
});
