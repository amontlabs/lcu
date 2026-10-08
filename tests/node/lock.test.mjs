// Locks between LCU processes (lock.mjs): kernel flocks on POSIX, compatible with earlier releases' fcntl.flock.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { acquire, installLockPath, withLock } from '../../lcu/lock.mjs';
import { REPO, override, temporary } from './fixtures.mjs';

const LOCK = pathToFileURL(join(REPO, 'lcu/lock.mjs')).href;
const python = spawnSync('python3', ['-c', 'import fcntl'], { stdio: 'ignore' }).status === 0;

/** A Node process holding the lock at `path` until its stdin closes (or it is killed). */
async function holder(t, path) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquire } from ${JSON.stringify(LOCK)};
    await acquire(${JSON.stringify(path)}); console.log('held'); process.stdin.resume();`], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((done) => child.stdout.once('data', done));
  return child;
}

test('processes take the lock one at a time and the lock file stays in place', async (t) => {
  const base = temporary(t);
  const path = join(base, 'setup.lock');
  const log = join(base, 'log');
  writeFileSync(log, '');
  const worker = `import { appendFileSync } from 'node:fs'; import { withLock } from ${JSON.stringify(LOCK)};
    for (let i = 0; i < 8; i += 1) await withLock(${JSON.stringify(path)}, async () => {
      appendFileSync(${JSON.stringify(log)}, 'in\\n'); await new Promise((r) => setTimeout(r, 5)); appendFileSync(${JSON.stringify(log)}, 'out\\n');
    });`;
  const runs = Array.from({ length: 4 }, () => new Promise((done) => spawn(process.execPath, ['--input-type=module', '-e', worker],
    { stdio: 'inherit' }).once('close', done)));
  assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0]);
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 64);
  for (let index = 0; index < lines.length; index += 2) assert.deepEqual(lines.slice(index, index + 2), ['in', 'out'], `overlap at ${index}`);
  assert.ok(existsSync(path));
});

test('a holder that is killed releases the lock', async (t) => {
  const path = join(temporary(t), 'setup.lock');
  const child = await holder(t, path);
  await assert.rejects(acquire(path, { wait: 200, waiting: () => {} }), /stayed locked/);
  child.kill('SIGKILL');
  await new Promise((done) => child.once('close', done));
  const release = await acquire(path, { wait: 2000 });
  release();
  assert.ok(existsSync(path));
});

test('a bounded wait says once that it is waiting, then gives up with the caller\'s error', async (t) => {
  const path = join(temporary(t), 'origins.lock');
  const child = await holder(t, path);
  let told = 0;
  await assert.rejects(acquire(path, { wait: 1300, waiting: () => { told += 1; }, busy: () => new Error('busy now') }), /busy now/);
  assert.equal(told, 1);
  child.stdin.end();
  await new Promise((done) => child.once('close', done));
  assert.equal(await withLock(path, async () => 'ran'), 'ran');
});

test('the lock excludes, and is excluded by, an earlier release\'s fcntl.flock', { skip: !python && 'python3 is not available' }, async (t) => {
  const path = join(temporary(t), '.lcu-install');
  writeFileSync(path, '');
  const child = spawn('python3', ['-c', 'import fcntl, sys\nf = open(sys.argv[1], "a")\nfcntl.flock(f, fcntl.LOCK_EX)\nprint("held", flush=True)\nsys.stdin.read()', path],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((done) => child.stdout.once('data', done));
  await assert.rejects(acquire(path, { wait: 300, waiting: () => {} }), /stayed locked/);
  child.stdin.end();
  await new Promise((done) => child.once('close', done));
  const release = await acquire(path, { wait: 2000 });
  const probe = spawnSync('python3', ['-c', 'import fcntl, sys\nf = open(sys.argv[1], "a")\ntry:\n    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept OSError:\n    sys.exit(3)', path]);
  assert.equal(probe.status, 3, 'python could take the lock Node holds');
  release();
  assert.equal(spawnSync('python3', ['-c', 'import fcntl, sys\nfcntl.flock(open(sys.argv[1], "a"), fcntl.LOCK_EX | fcntl.LOCK_NB)', path]).status, 0);
});

test('install, update and prune lock the install marker itself on POSIX', () => {
  assert.equal(installLockPath('/opt/lcu'), process.platform === 'win32' ? join('/opt/lcu', '.lcu-install.lock') : '/opt/lcu/.lcu-install');
});

test('Windows: an exclusive lock file; one left by a process that is gone is taken over', async (t) => {
  override(t, process, 'platform', 'win32');
  const path = join(temporary(t), '.lcu-install.lock');
  const release = await acquire(path, { wait: 0 });
  await assert.rejects(acquire(path, { wait: 100, waiting: () => {} }), /stayed locked/);
  release();
  assert.equal(existsSync(path), false);
  const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path, JSON.stringify({ pid: Number(gone), at: 0 }));
  const again = await acquire(path, { wait: 2000 });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid);
  again();
  writeFileSync(path, JSON.stringify({ pid: process.pid, at: 0 }));
  await assert.rejects(acquire(path, { wait: 100, waiting: () => {} }), /stayed locked/, 'a live holder is never taken over');
});
