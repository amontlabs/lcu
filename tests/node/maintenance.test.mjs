// Port of tests/test_maintenance.py plus differential checks of `_human` and the dry-run output against the Python
// module (when CPython 3.12 is available). Run with `node --test tests/node/maintenance.test.mjs`.
import { python312 } from './runtime_support.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  lstatSync, mkdirSync, readFileSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { io } from '../../lcu/compat/argparse.mjs';
import * as maintenance from '../../lcu/maintenance.mjs';
import { ORACLE_ROOT } from './oracle_root.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WINDOWS = process.platform === 'win32';
const PYTHON = python312(); // the pinned CPython 3.12.10 oracle (never a PATH python3)
// Linux and macOS installs take an fcntl lock and link `current`; Windows installs do neither.
const posixLayout = { skip: WINDOWS && 'Linux and macOS install layouts lock with fcntl' };

describe('PruneTests', () => {
  let temp; let prefix;

  beforeEach(() => {
    temp = realpathSync.native(mkdtempSync(join(tmpdir(), 'lcu-prune-'))); // native: prune resolves 8.3 names like Path.resolve()
    // A three-part prefix, as the installers create (e.g. /opt/lcu).
    prefix = join(temp, 'opt', 'lcu');
    mkdirSync(prefix, { recursive: true });
    writeFileSync(join(prefix, '.lcu-install'), '');
  });
  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  const gen = (name, { windows = false } = {}) => {
    const path = windows ? join(prefix, 'apps', name, 'app') : join(prefix, 'apps', name, 'payload/usr/lib/chatgpt');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'blob'), Buffer.alloc(4096, 'x'));
    return path;
  };

  const release = (name, genName, mtime, { windows = false, platform = null } = {}) => {
    const dir = join(prefix, 'releases', name);
    mkdirSync(dir, { recursive: true });
    let app;
    if (windows) app = join(prefix, 'apps', genName, 'app');
    else {
      app = relative(dir, join(prefix, 'apps', genName, 'payload/usr/lib/chatgpt'));
      symlinkSync(app, join(dir, 'app'));
    }
    const descriptor = { platform: platform ?? (windows ? 'windows' : 'linux'), app };
    writeFileSync(join(dir, 'installation.json'), JSON.stringify(descriptor));
    utimesSync(dir, mtime, mtime);
    return dir;
  };

  const currentPosix = (name) => symlinkSync(join('releases', name), join(prefix, 'current'));
  const currentWindows = (name) => writeFileSync(join(prefix, 'current.json'), JSON.stringify({ release: name }));
  const GEN = WINDOWS ? 'a'.repeat(64) : '1.0.0-x64-0123456789abcdef';
  const current = (name) => (WINDOWS ? currentWindows : currentPosix)(name);

  const run = (root, argv) => {
    let out = '';
    const real = io.stdout;
    io.stdout = (text) => { out += text; };
    try { maintenance.main(root, argv); } finally { io.stdout = real; }
    return out;
  };
  const names = (dir) => new Set(readdirSync(dir));

  it('dry run lists without deleting', posixLayout, () => {
    gen('1.0.0-x64-0123456789abcdef');
    const cur = release('0.5.0-aaaaaaaaaaaa', '1.0.0-x64-0123456789abcdef', 200);
    release('0.4.0-bbbbbbbbbbbb', '1.0.0-x64-0123456789abcdef', 100);
    currentPosix(cur.split('/').at(-1));
    const output = run(cur, ['--keep', '1']);
    assert.ok(output.includes('Would remove'));
    assert.ok(output.includes('0.4.0-bbbbbbbbbbbb'));
    assert.ok(output.includes('Rerun with --yes to delete. Restart or stop agents using older LCU releases first.'));
    assert.ok(names(join(prefix, 'releases')).has('0.4.0-bbbbbbbbbbbb'));
  });

  it('yes deletes old release and unreferenced generation', posixLayout, () => {
    gen('1.0.0-x64-0123456789abcdef');
    gen('1.1.0-x64-fedcba9876543210');
    const cur = release('0.5.0-aaaaaaaaaaaa', '1.0.0-x64-0123456789abcdef', 200);
    release('0.4.0-bbbbbbbbbbbb', '1.1.0-x64-fedcba9876543210', 100);
    currentPosix('0.5.0-aaaaaaaaaaaa');
    const output = run(cur, ['--keep', '1', '--yes']);
    assert.ok(output.includes('Removed'));
    assert.deepEqual(names(join(prefix, 'releases')), new Set(['0.5.0-aaaaaaaaaaaa']));
    // The current release still references generation 1.0.0; 1.1.0 is gone.
    assert.deepEqual(names(join(prefix, 'apps')), new Set(['1.0.0-x64-0123456789abcdef']));
  });

  it('keep count retains recent releases by mtime', posixLayout, () => {
    gen('1.0.0-x64-0123456789abcdef');
    const cur = release('0.6.0-aaaaaaaaaaaa', '1.0.0-x64-0123456789abcdef', 300);
    release('0.5.0-bbbbbbbbbbbb', '1.0.0-x64-0123456789abcdef', 200);
    release('0.4.0-cccccccccccc', '1.0.0-x64-0123456789abcdef', 100);
    currentPosix('0.6.0-aaaaaaaaaaaa');
    run(cur, ['--keep', '2', '--yes']);
    // Current plus the single most recent other survive; the oldest is dropped.
    assert.deepEqual(names(join(prefix, 'releases')), new Set(['0.6.0-aaaaaaaaaaaa', '0.5.0-bbbbbbbbbbbb']));
  });

  it('shared generation is kept while referenced', posixLayout, () => {
    gen('1.0.0-x64-0123456789abcdef');
    const cur = release('0.6.0-aaaaaaaaaaaa', '1.0.0-x64-0123456789abcdef', 300);
    release('0.5.0-bbbbbbbbbbbb', '1.0.0-x64-0123456789abcdef', 200);
    currentPosix('0.6.0-aaaaaaaaaaaa');
    run(cur, ['--keep', '1', '--yes']);
    // Only the current release remains, but its generation is still referenced.
    assert.deepEqual(names(join(prefix, 'apps')), new Set(['1.0.0-x64-0123456789abcdef']));
  });

  it('nothing to prune', posixLayout, () => {
    gen('1.0.0-x64-0123456789abcdef');
    const cur = release('0.6.0-aaaaaaaaaaaa', '1.0.0-x64-0123456789abcdef', 300);
    currentPosix('0.6.0-aaaaaaaaaaaa');
    assert.ok(run(cur, ['--yes']).includes('Nothing to prune'));
  });

  // ---- Windows registrations pin app generations (<prefix>/launcher-pins.json, .port/requests/maintenance.md) ----
  const pins = (registrations) => writeFileSync(join(prefix, 'launcher-pins.json'),
    `${JSON.stringify({ registrations }, null, 2)}\n`);
  const nodeOf = (digest) => join(prefix, 'apps', digest, 'app', 'resources/cua_node/bin/node.exe');
  const windowsTwoGenerations = () => {
    gen('a'.repeat(64), { windows: true });
    gen('b'.repeat(64), { windows: true });
    release('0.4.0-bbbbbbbbbbbb', 'a'.repeat(64), 100, { windows: true });
    const cur = release('0.5.0-aaaaaaaaaaaa', 'b'.repeat(64), 200, { windows: true });
    currentWindows('0.5.0-aaaaaaaaaaaa');
    return cur;
  };

  it('windows: a generation a registration still runs is kept; re-pinning by setup makes it prunable', () => {
    const cur = windowsTwoGenerations();
    // register (pins A) -> install new generation B -> prune --keep 1 --yes keeps A
    pins({ 'codex|user|': nodeOf('a'.repeat(64)) });
    const before = readFileSync(join(prefix, 'launcher-pins.json'));
    const output = run(cur, ['--keep', '1', '--yes']);
    assert.deepEqual(names(join(prefix, 'releases')), new Set(['0.5.0-aaaaaaaaaaaa']));
    assert.deepEqual(names(join(prefix, 'apps')), new Set(['a'.repeat(64), 'b'.repeat(64)]));
    assert.ok(output.startsWith(`Keeping ${join(prefix, 'apps', 'a'.repeat(64))}: a registered agent launcher still runs its Node (launcher-pins.json). `), output);
    assert.deepEqual(readFileSync(join(prefix, 'launcher-pins.json')), before, 'prune never edits the pins');
    // rerun setup (pins B) -> prune removes A
    pins({ 'codex|user|': nodeOf('b'.repeat(64)) });
    const second = run(cur, ['--keep', '1', '--yes']);
    assert.deepEqual(names(join(prefix, 'apps')), new Set(['b'.repeat(64)]));
    assert.ok(second.includes(`Removed ${join(prefix, 'apps', 'a'.repeat(64))}`), second);
  });

  it('windows: unpinned and missing pins behave exactly as before', () => {
    const cur = windowsTwoGenerations();
    pins({});
    const unpinned = run(cur, ['--keep', '1']);
    rmSync(join(prefix, 'launcher-pins.json'));
    assert.equal(run(cur, ['--keep', '1']), unpinned);
    assert.ok(unpinned.startsWith(`Would remove ${join(prefix, 'releases/0.4.0-bbbbbbbbbbbb')}`), unpinned);
  });

  it('windows: a malformed, unreadable or redirected pins file refuses the whole prune and deletes nothing', () => {
    const cur = windowsTwoGenerations();
    const path = join(prefix, 'launcher-pins.json');
    const cases = [
      () => writeFileSync(path, '{not json'),
      () => writeFileSync(path, '[]'),
      () => writeFileSync(path, '{"registrations": []}'),
      () => writeFileSync(path, '{"registrations": {"codex|user|": 3}}'),
      () => writeFileSync(path, '{"other": {}}'),
      () => symlinkSync(join(temp, 'elsewhere.json'), path),
      () => mkdirSync(path),
    ];
    // rmSync(..., { force: true }) leaves a dangling symlink in place on some Node releases (it follows the link and
    // takes the ENOENT for "nothing to remove"), so clear the entry by its own type.
    const clear = () => {
      let entry = null;
      try { entry = lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (entry?.isDirectory()) rmSync(path, { recursive: true });
      else if (entry) unlinkSync(path);
    };
    const reasons = ['cannot be read as JSON', 'is malformed', 'is malformed', 'is malformed', 'is malformed',
      'is not a regular file', 'is not a regular file'];
    for (const [index, prepare] of cases.entries()) {
      clear();
      assert.throws(() => lstatSync(path), { code: 'ENOENT' }, 'the previous case is fully removed');
      prepare(); // must not fail (EEXIST): each case starts from an empty name
      assert.throws(() => run(cur, ['--keep', '1', '--yes']),
        (e) => e.name === 'ValueError' && e.message.startsWith(`Refusing to prune: ${path} ${reasons[index]}`), String(prepare));
      assert.deepEqual(names(join(prefix, 'releases')), new Set(['0.5.0-aaaaaaaaaaaa', '0.4.0-bbbbbbbbbbbb']));
      assert.deepEqual(names(join(prefix, 'apps')), new Set(['a'.repeat(64), 'b'.repeat(64)]));
    }
  });

  it('pins are compared like PureWindowsPath: case-insensitive, either separator, inside the generation only', () => {
    const generation = 'C:/Users/u/AppData/Local/LCU/apps/' + 'a'.repeat(64);
    assert.equal(maintenance._pinned_by(generation, ['c:\\users\\U\\AppData\\Local\\lcu\\APPS\\' + 'A'.repeat(64) + '\\app\\node.exe']), true);
    assert.equal(maintenance._pinned_by(generation, ['C:\\Users\\u\\AppData\\Local\\LCU\\apps\\' + 'a'.repeat(64) + 'x\\node.exe']), false);
    assert.equal(maintenance._pinned_by(generation, ['C:\\Users\\u\\AppData\\Local\\LCU\\apps\\' + 'a'.repeat(64)]), false);
    assert.equal(maintenance._pinned_by(generation, []), false);
  });

  it('posix installs ignore launcher-pins.json entirely', posixLayout, () => {
    gen('1.0.0-x64-0123456789abcdef');
    const cur = release('0.6.0-aaaaaaaaaaaa', '1.0.0-x64-0123456789abcdef', 300);
    currentPosix('0.6.0-aaaaaaaaaaaa');
    writeFileSync(join(prefix, 'launcher-pins.json'), '{not json');
    assert.ok(run(cur, ['--yes']).includes('Nothing to prune'));
  });

  it('windows layout uses current.json and absolute app', () => {
    gen('a'.repeat(64), { windows: true });
    gen('b'.repeat(64), { windows: true });
    const cur = release('0.5.0-aaaaaaaaaaaa', 'a'.repeat(64), 200, { windows: true });
    release('0.4.0-bbbbbbbbbbbb', 'b'.repeat(64), 100, { windows: true });
    currentWindows('0.5.0-aaaaaaaaaaaa');
    run(cur, ['--keep', '1', '--yes']);
    assert.deepEqual(names(join(prefix, 'releases')), new Set(['0.5.0-aaaaaaaaaaaa']));
    assert.deepEqual(names(join(prefix, 'apps')), new Set(['a'.repeat(64)]));
  });

  it('in-place linux release reclaims copies from earlier versions', posixLayout, () => {
    gen('1.0.0-x64-0123456789abcdef');
    const installed = join(temp, 'usr/lib/chatgpt');
    mkdirSync(installed, { recursive: true });
    const cur = join(prefix, 'releases', '0.8.0-aaaaaaaaaaaa');
    mkdirSync(cur, { recursive: true });
    symlinkSync(installed, join(cur, 'app'), 'dir');
    writeFileSync(join(cur, 'installation.json'), JSON.stringify(
      { app: installed, architecture: 'x64', package_version: '1.0.0', runtime: 'r' }));
    utimesSync(cur, 300, 300);
    release('0.7.0-bbbbbbbbbbbb', '1.0.0-x64-0123456789abcdef', 200);
    currentPosix('0.8.0-aaaaaaaaaaaa');
    run(cur, ['--keep', '1', '--yes']);
    assert.deepEqual(names(join(prefix, 'releases')), new Set(['0.8.0-aaaaaaaaaaaa']));
    assert.deepEqual(readdirSync(join(prefix, 'apps')), []);
    assert.ok(readdirSync(installed) !== null);
  });

  it('in-place release using an old generation path keeps that generation', posixLayout, () => {
    // `--existing-app <prefix>/apps/<old>/payload/usr/lib/chatgpt` after upgrading
    // from 0.7.0 makes the current release absolute-path in place on a copy.
    const old = gen('1.0.0-x64-0123456789abcdef');
    gen('1.1.0-x64-fedcba9876543210');
    const cur = join(prefix, 'releases', '0.8.0-aaaaaaaaaaaa');
    mkdirSync(cur, { recursive: true });
    symlinkSync(old, join(cur, 'app'), 'dir');
    writeFileSync(join(cur, 'installation.json'), JSON.stringify(
      { app: old, architecture: 'x64', package_version: '1.0.0', runtime: 'r' }));
    utimesSync(cur, 300, 300);
    release('0.7.0-bbbbbbbbbbbb', '1.0.0-x64-0123456789abcdef', 200);
    currentPosix('0.8.0-aaaaaaaaaaaa');
    run(cur, ['--keep', '1', '--yes']);
    assert.deepEqual(names(join(prefix, 'releases')), new Set(['0.8.0-aaaaaaaaaaaa']));
    assert.deepEqual(names(join(prefix, 'apps')), new Set(['1.0.0-x64-0123456789abcdef']));
    assert.ok(readdirSync(old).includes('blob'));
  });

  it('macos has no app generations', posixLayout, () => {
    const cur = join(prefix, 'releases', '0.5.0-aaaaaaaaaaaa');
    mkdirSync(cur, { recursive: true });
    writeFileSync(join(cur, 'installation.json'), JSON.stringify({ platform: 'darwin', app: '/Applications/ChatGPT.app' }));
    utimesSync(cur, 200, 200);
    const old = release('0.4.0-bbbbbbbbbbbb', 'unused', 100, { platform: 'darwin' });
    writeFileSync(join(old, 'installation.json'), JSON.stringify({ platform: 'darwin', app: '/Applications/ChatGPT.app' }));
    currentPosix('0.5.0-aaaaaaaaaaaa');
    run(cur, ['--keep', '1', '--yes']);
    assert.deepEqual(names(join(prefix, 'releases')), new Set(['0.5.0-aaaaaaaaaaaa']));
  });

  it('symlink entry in releases is refused', () => {
    gen(GEN, { windows: WINDOWS });
    const cur = release('0.5.0-aaaaaaaaaaaa', GEN, 200, { windows: WINDOWS });
    current('0.5.0-aaaaaaaaaaaa');
    symlinkSync(cur, join(prefix, 'releases', 'sneaky'));
    assert.throws(() => run(cur, ['--yes']), (e) => e.name === 'ValueError' && /unexpected entry/.test(e.message));
  });

  it('unexpected named directory is refused', () => {
    gen(GEN, { windows: WINDOWS });
    const cur = release('0.5.0-aaaaaaaaaaaa', GEN, 200, { windows: WINDOWS });
    current('0.5.0-aaaaaaaaaaaa');
    mkdirSync(join(prefix, 'releases', 'not-a-release'));
    assert.throws(() => run(cur, ['--yes']), (e) => e.name === 'ValueError' && /unexpected entry/.test(e.message));
  });

  it('missing install marker is rejected', () => {
    gen('1.0.0-x64-0123456789abcdef');
    const cur = release('0.5.0-aaaaaaaaaaaa', '1.0.0-x64-0123456789abcdef', 200);
    currentPosix('0.5.0-aaaaaaaaaaaa');
    unlinkSync(join(prefix, '.lcu-install'));
    assert.throws(() => run(cur, ['--yes']), (e) => e.name === 'ValueError' && /Not an LCU installation/.test(e.message));
  });

  // ---- cases that Python's suite did not cover (see .port/notes/maintenance.md) ----
  it('refuses a release that is not under <prefix>/releases', () => {
    const lone = join(temp, 'elsewhere');
    mkdirSync(lone);
    writeFileSync(join(lone, 'installation.json'), '{}');
    assert.throws(() => run(lone, []), (e) => e.name === 'ValueError'
      && e.message === 'lcu prune must run from an installed <prefix>/releases/<name> release.');
  });

  it('argparse behaviour of --keep: abbreviations, =, Python int() syntax, errors', posixLayout, () => {
    gen('1.0.0-x64-0123456789abcdef');
    const cur = release('0.6.0-aaaaaaaaaaaa', '1.0.0-x64-0123456789abcdef', 300);
    release('0.5.0-bbbbbbbbbbbb', '1.0.0-x64-0123456789abcdef', 200);
    release('0.4.0-cccccccccccc', '1.0.0-x64-0123456789abcdef', 100);
    currentPosix('0.6.0-aaaaaaaaaaaa');
    for (const argv of [['--ke', '1_0'], ['--keep=+1'], ['--keep', ' 3 '], ['--keep', '٣'], ['--keep', '-5'], ['--keep', '0']]) {
      assert.doesNotThrow(() => run(cur, argv), argv.join(' '));
    }
    assert.ok(run(cur, ['--keep', '1']).includes('Would remove'));
    assert.ok(run(cur, ['--keep', '3']).includes('Nothing to prune'));
    let err = '';
    const realErr = io.stderr; const realExit = io.exit;
    io.stderr = (text) => { err += text; };
    io.exit = (status) => { throw Object.assign(new Error('exit'), { status }); };
    try {
      assert.throws(() => run(cur, ['--keep', 'x']), (e) => e.status === 2);
    } finally { io.stderr = realErr; io.exit = realExit; }
    assert.equal(err, "usage: lcu prune [-h] [--keep KEEP] [--yes]\nlcu prune: error: argument --keep: invalid int value: 'x'\n");
  });

  it('_human formats like Python (exact round-half-even) and sums trees by lstat size', () => {
    assert.equal(maintenance._human(0), '0 B');
    assert.equal(maintenance._human(1023), '1023 B');
    assert.equal(maintenance._human(1024), '1.0 KiB');
    assert.equal(maintenance._human(1280), '1.2 KiB'); // 1.25 is a tie: Python rounds half to even
    assert.equal(maintenance._human(1792), '1.8 KiB'); // 1.75 -> 1.8
    assert.equal(maintenance._human(3 * 1024 ** 4), '3.0 TiB');
    assert.equal(maintenance._human(5000 * 1024 ** 4), '5000.0 TiB');
    const dir = join(temp, 'tree');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a'), Buffer.alloc(100));
    writeFileSync(join(dir, 'sub', 'b'), Buffer.alloc(50));
    symlinkSync(dir, join(dir, 'loop'));
    // Independent oracle: os.walk + lstat in CPython when available (portable; no GNU/BSD stat syntax),
    // otherwise the per-entry lstat sizes listed explicitly.
    let expected;
    if (PYTHON && !WINDOWS) { // CPython reports the target length as the size of an NTFS symlink, Node (libuv) reports 0
      const oracle = spawnSync(PYTHON, ['-c', 'import os, sys\nroot = sys.argv[1]\ntotal = os.lstat(root).st_size\n'
        + 'for parent, dirs, files in os.walk(root):\n    for name in dirs + files:\n        total += os.lstat(os.path.join(parent, name)).st_size\n'
        + 'print(total)', dir], { encoding: 'utf8' });
      assert.equal(oracle.status, 0, oracle.stderr);
      expected = Number(oracle.stdout.trim());
    } else {
      expected = [dir, join(dir, 'sub'), join(dir, 'a'), join(dir, 'sub', 'b'), join(dir, 'loop')]
        .reduce((sum, path) => sum + lstatSync(path).size, 0);
    }
    assert.ok(Number.isInteger(expected) && expected >= 150 + (WINDOWS ? 0 : Buffer.byteLength(dir)), String(expected));
    assert.equal(maintenance._tree_size(dir), expected);
  });

  it('_human matches Python for a spread of sizes', { skip: !PYTHON }, () => {
    const sizes = [];
    for (let k = 0; k < 6; k++) for (const f of [0, 1, 1.25, 1.5, 1.75, 2.5, 1023.95, 1023.96, 1000.05, 0.05 * 20, 9.95, 1536]) sizes.push(Math.floor(f * 1024 ** k));
    for (let i = 1; i < 3000; i += 7) sizes.push(i * 1024 * 3 + (i % 1024));
    const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(ORACLE_ROOT)})
from lcu.maintenance import _human
print(json.dumps([_human(s) for s in json.loads(sys.stdin.read())]))`;
    const python = spawnSync(PYTHON, ['-c', script], { input: JSON.stringify(sizes), encoding: 'utf8' });
    assert.equal(python.status, 0, python.stderr);
    assert.deepEqual(sizes.map((s) => maintenance._human(s)), JSON.parse(python.stdout));
  });

  it('prune waits for the install lock held by Python (fcntl.flock) and then proceeds', { skip: !PYTHON || WINDOWS }, async () => {
    gen('1.0.0-x64-0123456789abcdef');
    const cur = release('0.6.0-aaaaaaaaaaaa', '1.0.0-x64-0123456789abcdef', 300);
    currentPosix('0.6.0-aaaaaaaaaaaa');
    const holder = spawn(PYTHON, ['-c', `
import fcntl, sys
lock = open(sys.argv[1], 'a')
fcntl.flock(lock, fcntl.LOCK_EX)
print('HELD', flush=True)
sys.stdin.readline()
`, join(prefix, '.lcu-install')], { stdio: ['pipe', 'pipe', 'inherit'] });
    let child = null;
    try {
      // Bounded: a holder that never reports fails the test instead of waiting forever.
      await Promise.race([
        new Promise((resolve) => holder.stdout.once('data', resolve)),
        new Promise((_, reject) => holder.once('close', (code) => reject(new Error(`lock holder exited (status ${code})`)))),
        new Promise((_, reject) => setTimeout(() => reject(new Error('lock holder did not report within 30 s')), 30000).unref()),
      ]);
      child = spawn(process.execPath, ['--input-type=module', '-e',
        `import { main } from ${JSON.stringify(new URL('../../lcu/maintenance.mjs', import.meta.url).href)}; main(${JSON.stringify(cur)}, ['--yes']);`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      const done = new Promise((resolve) => child.once('close', resolve));
      await new Promise((resolve) => setTimeout(resolve, 800));
      assert.equal(out, '', 'prune must block while the lock is held');
      holder.stdin.end('\n');
      const code = await Promise.race([done,
        new Promise((_, reject) => setTimeout(() => reject(new Error('prune did not finish within 60 s')), 60000).unref())]);
      assert.equal(code, 0);
      assert.ok(out.includes('Nothing to prune'));
    } finally {
      // Both are our own children: never leave one behind (a live child keeps this file's process alive).
      holder.stdin.destroy();
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('dry-run output equals the Python module on the same tree (sizes, order, apps)', { skip: !PYTHON || WINDOWS }, () => {
    gen('1.0.0-x64-0123456789abcdef');
    gen('1.1.0-x64-fedcba9876543210');
    const cur = release('0.6.0-aaaaaaaaaaaa', '1.0.0-x64-0123456789abcdef', 300);
    release('0.5.0-bbbbbbbbbbbb', '1.1.0-x64-fedcba9876543210', 200);
    release('0.4.0-cccccccccccc', '1.1.0-x64-fedcba9876543210', 100);
    currentPosix('0.6.0-aaaaaaaaaaaa');
    const script = `
import sys
sys.path.insert(0, ${JSON.stringify(ORACLE_ROOT)})
from lcu import maintenance
maintenance.main(sys.argv[1], sys.argv[2:])`;
    for (const argv of [['--keep', '1'], ['--keep', '2'], []]) {
      const python = spawnSync(PYTHON, ['-c', script, cur, ...argv], { encoding: 'utf8' });
      assert.equal(python.status, 0, python.stderr);
      assert.equal(run(cur, argv), python.stdout, argv.join(' '));
    }
  });
});
