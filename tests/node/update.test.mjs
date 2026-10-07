// Port of tests/test_update.py (tests/test_codex_update_notice.py tests codex_hooks, not update). Same fixtures and
// expected values; Python's mocks become the `update._inject` seams and urllib mocks a local HTTP server. Fixture
// JSON is written with pyjson dumps (Python's bytes). Regression tests of the port review (.port/reviews/port-update.md)
// are tagged with their finding id.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, beforeEach, describe, test } from 'node:test';

import * as update from '../../lcu/update.mjs';
import * as claude_mod from '../../lcu/claude_mod.mjs';
import { NOTICE_EVENTS, notice_hook } from '../../lcu/codex_hooks.mjs';
import * as browser from '../../lcu/browser.mjs';
import { io as argparseIo } from '../../lcu/compat/argparse.mjs';
import { PlainOSError } from '../../lcu/compat/http.mjs';
import { dumps, toPlain, ValueError } from '../../lcu/compat/pyjson.mjs';
import { TimeoutExpired } from '../../lcu/compat/subprocess.mjs';
import { _resetTempdir } from '../../lcu/compat/tempfile.mjs';
import { skipOnWindows } from './windows_skip.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const INFO = {
  version: '0.9.2', tag: 'v0.9.2', severity: 'normal',
  release_url: 'https://github.com/amontlabs/lcu/releases/tag/v0.9.2',
};

const SAVED_ENV = { ...process.env };
const SAVED_INJECT = { ...update._inject };

function release(directory, version = '0.9.1') {
  const root = path.join(directory, 'prefix/releases/r1');
  fs.mkdirSync(root, { recursive: true });
  if (version) fs.writeFileSync(path.join(root, 'bundle.json'), dumps({ version }));
  return root;
}

let tmp, home, root, out, err, spawned;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-update-test-')));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  Object.assign(process.env, { HOME: home, XDG_CACHE_HOME: path.join(home, 'xdg'), LOCALAPPDATA: path.join(home, 'local') });
  delete process.env.LCU_NO_UPDATE_CHECK;
  for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) delete process.env[key];
  _resetTempdir();
  root = release(tmp);
  out = ''; err = ''; spawned = [];
  update._inject.io = { stdout: (t) => { out += t; }, stderr: (t) => { err += t; } };
  // The default cases are the POSIX behaviour (LF stdio, XDG cache): a Windows host runs them as 'linux'. The
  // Windows behaviour (CRLF text mode, LOCALAPPDATA, python preflight) has its own cases that inject 'win32'.
  update._inject.platform = () => (process.platform === 'win32' ? 'linux' : process.platform);
  update._inject.spawn = (command, args, options) => {
    spawned.push({ command, args, options });
    return { on() {}, unref() {} };
  };
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in SAVED_ENV)) delete process.env[key];
  Object.assign(process.env, SAVED_ENV);
  Object.assign(update._inject, SAVED_INJECT);
  _resetTempdir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const cacheFile = () => update.cache_path();
const siblingFile = (name) => path.join(path.dirname(cacheFile()), name);

function cache(latest = INFO, error = null, age = 0) {
  fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
  fs.writeFileSync(cacheFile(), dumps(new Map([['checked_at', Date.now() / 1000 - age - 0.25], ['latest', latest], ['error', error]])));
}

async function runMain(...argv) {
  out = ''; err = '';
  const status = await update.main(root, argv);
  return [status, out];
}

// ---------------------------------------------------------------- a tiny GitHub stand-in
const servers = [];
async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
after(() => { for (const server of servers) server.close(); });
const NO_PROXY_ENV = { PATH: process.env.PATH };

describe('update', () => {
  test('version compare', () => {
    assert.deepEqual(update.parse_version('v0.9.2'), [0, 9, 2]);
    assert.equal(update.parse_version('0.9.x'), null);
    assert.equal(update.parse_version(''), null);
    assert.equal(update.newer(root, INFO), true);
    assert.equal(update.newer(root, { version: '0.9.1' }), false);
    assert.equal(update.newer(root, { version: '0.8.9' }), false);
    assert.equal(update.newer(root, { version: '0.10.0' }), true);
    assert.equal(update.newer(root, { version: 'garbage' }), false);
  });

  test('F12: version components keep Python int precision', () => {
    fs.writeFileSync(path.join(root, 'bundle.json'), dumps({ version: '9007199254740992' }));
    assert.equal(update.newer(root, { version: '9007199254740993' }), true);
    const big = '9'.repeat(400);
    assert.deepEqual(update.parse_version(big), [BigInt(big)]);
    fs.writeFileSync(path.join(root, 'bundle.json'), dumps({ version: big }));
    assert.equal(update.newer(root, { version: `1${'0'.repeat(400)}` }), true);
    assert.equal(update.newer(root, { version: '8'.repeat(400) }), false);
  });

  test('F13: version parsing follows str.strip() and int()', () => {
    assert.deepEqual(update.parse_version('١.٢.٣'), [1, 2, 3]);
    assert.deepEqual(update.parse_version('\x1c0.9.2\x1c'), [0, 9, 2]);
    assert.equal(update.parse_version('\ufeff0.9.2'), null);
    assert.deepEqual(update.parse_version(' vv1_0.2 '), [10, 2]);
    assert.equal(update.parse_version(null), null);
  });

  test('cache path is per account', () => {
    const file = update.cache_path();
    assert.ok(file.startsWith(home));
    assert.ok(file.endsWith('update.json'));
  });

  test('F02: Windows cache path and home follow ntpath.expanduser', () => {
    update._inject.platform = () => 'win32';
    update._inject.env = { USERPROFILE: 'C:\\Users\\Fixture' };
    assert.equal(update.cache_path(), 'C:\\Users\\Fixture\\AppData\\Local\\LCU\\cache\\update.json');
    update._inject.env = { USERPROFILE: 'C:\\Users\\Fixture', LOCALAPPDATA: 'D:/Local/' };
    assert.equal(update.cache_path(), 'D:\\Local\\LCU\\cache\\update.json');
    update._inject.env = { HOMEDRIVE: 'E:', HOMEPATH: '\\Users\\Other' };
    assert.equal(update.home_(), 'E:\\Users\\Other');
    update._inject.env = { HOME: '/ignored', LOCALAPPDATA: 'C:\\L' };
    assert.throws(() => update.cache_path(), (e) => e.name === 'RuntimeError' && e.message === 'Could not determine home directory.');
  });

  test('latest_tag from redirect', async () => {
    const base = await serve((req, res) => {
      assert.equal(req.method, 'HEAD');
      assert.equal(req.headers['user-agent'], 'lcu-update');
      if (req.url === '/redirect') { res.writeHead(302, { Location: 'https://github.com/amontlabs/lcu/releases/tag/v0.9.2' }); res.end(); }
      else if (req.url === '/missing') { res.writeHead(404); res.end(); }
      else if (req.url === '/ok-location') { res.writeHead(200, { Location: '/amontlabs/lcu/releases/tag/0.9.3' }); res.end(); }
      else { res.writeHead(200); res.end(); }
    });
    assert.equal(await update.latest_tag({ latestUrl: `${base}/redirect`, env: NO_PROXY_ENV }), 'v0.9.2');
    await assert.rejects(update.latest_tag({ latestUrl: `${base}/missing`, env: NO_PROXY_ENV }), (e) => e.name === 'HTTPError' && e.code === 404);
    assert.equal(await update.latest_tag({ latestUrl: `${base}/ok-location`, env: NO_PROXY_ENV }), '0.9.3');
    await assert.rejects(update.latest_tag({ latestUrl: `${base}/none`, env: NO_PROXY_ENV }),
      (e) => e instanceof ValueError && e.message === 'Unexpected response while looking for the latest LCU release.');
  });

  test('fetch_latest handles both tag formats and severity', async () => {
    for (const tag of ['v0.9.2', '0.9.2']) {
      update._inject.latest_tag = async () => tag;
      update._inject.severity_of = async () => 'security';
      const info = await update.fetch_latest();
      assert.deepEqual([info.version, info.tag, info.severity], ['0.9.2', tag, 'security']);
      assert.ok(info.release_url.endsWith(`/releases/tag/${tag}`));
    }
    update._inject.latest_tag = async () => 'nightly';
    await assert.rejects(update.fetch_latest(), (e) => e instanceof ValueError && e.message === 'Unrecognized release tag: nightly');
  });

  test('fetch_latest end to end against a local server (notes template)', async () => {
    const seen = [];
    const base = await serve((req, res) => {
      seen.push(req.url);
      if (req.url === '/latest') { res.writeHead(302, { Location: 'https://github.com/amontlabs/lcu/releases/tag/v0.9.2' }); res.end(); return; }
      res.writeHead(200);
      res.end('<!-- lcu-severity: breaking -->\n');
    });
    const info = await update.fetch_latest({ latestUrl: `${base}/latest`, notesTemplate: `${base}/notes/%s/%s.md`, env: NO_PROXY_ENV });
    assert.deepEqual(info, { version: '0.9.2', tag: 'v0.9.2', release_url: 'https://github.com/amontlabs/lcu/releases/tag/v0.9.2', severity: 'breaking' });
    assert.deepEqual(seen, ['/latest', '/notes/v0.9.2/0.9.2.md']);
  });

  test('F36: NOTES_URL is the Python two-placeholder template', () => {
    assert.equal(update.NOTES_URL, 'https://raw.githubusercontent.com/amontlabs/lcu/%s/docs/releases/%s.md');
  });

  test('severity marker', async () => {
    const bodies = new Map([
      ['a', '# LCU 0.9.2\n\n<!-- lcu-severity: security -->\n'],
      ['b', 'Add `<!-- lcu-severity: security -->` to the notes.'],
      ['c', '<!-- lcu-severity: breaking -->'],
      ['d', '<!-- lcu-severity: weird -->'],
      ['e', 'nothing'],
    ]);
    const base = await serve((req, res) => { res.writeHead(200); res.end(bodies.get(req.url.slice(1, 2))); });
    const expected = { a: 'security', b: 'normal', c: 'breaking', d: 'normal', e: 'normal' };
    for (const key of bodies.keys()) {
      assert.equal(await update.severity_of('v0.9.2', '0.9.2', { notesTemplate: `${base}/${key}%s%s`, env: NO_PROXY_ENV }), expected[key], key);
    }
    // OSError('down') -> normal: nothing listens on a closed port.
    const dead = http.createServer();
    await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const port = dead.address().port;
    await new Promise((resolve) => dead.close(resolve));
    assert.equal(await update.severity_of('v0.9.2', '0.9.2', { notesTemplate: `http://127.0.0.1:${port}/%s%s`, env: NO_PROXY_ENV }), 'normal');
  });

  test('staleness and error backoff', () => {
    const now = Date.now() / 1000;
    assert.equal(update.stale(null), true);
    assert.equal(update.stale({ checked_at: now - 540, error: null }, now), false);
    assert.equal(update.stale({ checked_at: now - 601, error: null }, now), true);
    assert.equal(update.stale({ checked_at: now - 25 * 3600, error: null }, now), true);
    assert.equal(update.stale({ checked_at: now - 600, error: 'down' }, now), false);
    assert.equal(update.stale({ checked_at: now - 4000, error: 'down' }, now), true);
    assert.equal(update.stale({ checked_at: now + 999, error: null }, now), true);
  });

  test('F14: stale keeps int arithmetic exact and raises OverflowError like Python', () => {
    assert.equal(update.stale(new Map([['checked_at', 9007199254740993n], ['error', null]]), 9007199254741592n), false); // age 599
    assert.throws(() => update.stale(new Map([['checked_at', 10n ** 400n], ['error', null]]), 1.5),
      (e) => e.name === 'OverflowError' && e.message === 'int too large to convert to float');
  });

  test('F11: timestamps come from the wall clock', () => {
    const before = Date.now() / 1000;
    const value = update._inject.now();
    assert.ok(Math.abs(value - before) < 1);
  });

  test('check writes cache and keeps known release on error', async () => {
    update._inject.fetch_latest = async () => INFO;
    assert.deepEqual(await update.check(root), [INFO, null]);
    assert.deepEqual(toPlain(update.read_cache().get('latest')), INFO);
    update._inject.fetch_latest = async () => { throw new PlainOSError('offline'); };
    assert.deepEqual(await update.check(root), [null, 'offline']);
    const cached = update.read_cache();
    assert.deepEqual([toPlain(cached.get('latest')), cached.get('error')], [INFO, 'offline']);
  });

  test('cache file bytes and mode (Python json.dump defaults, mkstemp 0600)', async () => {
    update._inject.fetch_latest = async () => INFO;
    update._inject.now = () => 1759660000.25;
    await update.check(root);
    const text = fs.readFileSync(cacheFile(), 'utf8');
    assert.equal(text, '{"checked_at": 1759660000.25, "latest": {"version": "0.9.2", "tag": "v0.9.2", "severity": "normal", '
      + '"release_url": "https://github.com/amontlabs/lcu/releases/tag/v0.9.2"}, "error": null}');
    assert.equal(fs.statSync(cacheFile()).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(cacheFile())), ['update.json']);
    update._inject.now = () => 1759660000;
    await update.check(root);
    assert.ok(fs.readFileSync(cacheFile(), 'utf8').startsWith('{"checked_at": 1759660000.0, '));
  });

  test('disabled by env and source checkout', () => {
    assert.equal(update.enabled(root), true);
    for (const [value, expected] of [['1', false], ['yes', false], ['0', true], ['', true]]) {
      assert.equal(update.enabled(root, { LCU_NO_UPDATE_CHECK: value }), expected);
    }
    const source = release(`${tmp}/src`, null);
    assert.equal(update.enabled(source), false);
    cache();
    assert.equal(update.notice(source), null);
    assert.equal(spawned.length, 0);
    process.env.LCU_NO_UPDATE_CHECK = '1';
    assert.equal(update.notice(root), null);
    assert.equal(update.status_line(root), null);
    assert.equal(spawned.length, 0);
  });

  test('notice shape and messages', () => {
    cache();
    const found = update.notice(root);
    assert.equal(spawned.length, 0); // fresh cache
    const command = path.join(path.dirname(path.dirname(root)), 'current/bin/lcu');
    assert.deepEqual(Object.keys(found), ['current', 'latest', 'severity', 'release_url', 'command', 'message']);
    assert.deepEqual([found.current, found.latest, found.severity, found.command], ['0.9.1', '0.9.2', 'normal', command]);
    assert.ok(found.message.includes(`\`${command} update\``));
    assert.ok(found.message.includes('without asking'));
    assert.ok(found.message.includes(INFO.release_url));
    assert.ok(found.message.startsWith('LCU 0.9.2 is available'));
    cache({ ...INFO, severity: 'security' });
    assert.ok(update.notice(root).message.startsWith('Security update: '));
    cache({ ...INFO, severity: 'breaking' });
    assert.ok(update.notice(root).message.startsWith('Breaking update: '));
    assert.ok(update.status_line(root).includes('0.9.2'));
    assert.equal(update.status_line(root), `LCU 0.9.2 is available (installed 0.9.1): ${INFO.release_url}. Run \`${command} update\` to upgrade.`);
  });

  test('F15: notice values keep the cache key order and types', async () => {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), `{"checked_at": ${Date.now() / 1000}, "latest": {"version": "0.9.2", "release_url": {"b": 1, "10": 2.0, "2": 3}}, "error": null}`);
    const [, text] = await runMain('--notice', '--json');
    assert.ok(text.includes('"release_url": {"b": 1, "10": 2.0, "2": 3}'), text);
    assert.ok(JSON.parse(text).message.endsWith("Release notes: {'b': 1, '10': 2.0, '2': 3}"));
  });

  test('F29: severity lookup is Python dict membership, not JS properties', () => {
    for (const severity of ['constructor', 'toString', '__proto__']) {
      assert.ok(update.message(root, { version: '0.9.2', release_url: 'u', severity }, '0.9.1').startsWith('LCU 0.9.2'));
    }
    assert.throws(() => update.message(root, new Map([['version', '1'], ['release_url', 'u'], ['severity', new Map()]]), '0'),
      (e) => e instanceof TypeError && e.message === "unhashable type: 'dict'");
  });

  test('no notice when current or missing', () => {
    assert.equal(update.notice_cached(root), null);
    cache({ ...INFO, version: '0.9.1' });
    assert.equal(update.notice_cached(root), null);
    assert.equal(update.status_line(root), null);
  });

  test('stale cache spawns detached refresh through the release launcher (F01)', () => {
    // A bundled Node next to the release must never be executed directly: the launcher shim gates it.
    const node = path.join(root, 'agent-tools/node/bin/node');
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, '#!/bin/sh\n', { mode: 0o777 });
    process.env.NODE_OPTIONS = '--max-old-space-size=1';
    assert.equal(update.notice(root), null);
    assert.equal(spawned.length, 1);
    const { command, args, options } = spawned[0];
    assert.equal(command, '/bin/sh');
    assert.deepEqual(args, ['-p', path.join(root, 'bin/lcu'), 'update', '--refresh']);
    assert.deepEqual(options, { stdio: 'ignore', detached: true });
    // The environment is inherited untouched (Python's Popen); the shim quarantines Node's startup variables.
    assert.equal(options.env, undefined);
    cache(INFO, null, 90000);
    fs.unlinkSync(siblingFile('refresh.stamp'));
    spawned.length = 0;
    assert.equal(update.notice(root).latest, '0.9.2');
    assert.equal(spawned.length, 1);
  });

  test('F01: a real refresh runs the launcher, which refuses an unvalidated Node', { skip: skipOnWindows('spawns the POSIX /bin/sh -p launcher shim (the Windows refresh goes through cmd.exe and has its own fixture case)') }, () => {
    // Real spawn (default seam) of an owned fixture launcher: proves the argv reaches /bin/sh -p with the release
    // launcher and that nothing else is executed. The fixture launcher records its argv and exits.
    update._inject.spawn = SAVED_INJECT.spawn;
    const marker = path.join(tmp, 'ran');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin/lcu'), `printf '%s\\n' "$0" "$@" > ${JSON.stringify(marker)}\n`);
    const child = update.spawn_refresh(root);
    return new Promise((resolve) => child.on('exit', resolve)).then(() => {
      assert.equal(fs.readFileSync(marker, 'utf8'), `${path.join(root, 'bin/lcu')}\nupdate\n--refresh\n`);
    });
  });

  test('F01/F03: Windows refresh runs the stable dispatcher through cmd.exe with escaped argv', () => {
    update._inject.platform = () => 'win32';
    update._inject.env = { ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
    const [command, args, extra] = update.refresh_command('C:\\opt\\p&calc&x\\releases\\r1');
    assert.equal(command, 'C:\\Windows\\system32\\cmd.exe');
    assert.deepEqual(extra, { windowsVerbatimArguments: true });
    assert.deepEqual(args, ['/d', '/s', '/c', '"C:\\opt\\p^&calc^&x\\lcu.cmd ^^^"update^^^" ^^^"--refresh^^^""']);
    for (const hostile of ['C:\\a b\\x', 'C:\\100%PATH%\\x', 'C:\\p|q\\x', 'C:\\p^q(1)\\x', 'C:\\p<q>r\\x', 'C:\\p!x!\\x']) {
      const line = update.cmd_invocation(`${hostile}\\lcu.cmd`, ['update'])[1][3];
      assert.ok(line.endsWith(' ^^^"update^^^""'), line);
      // Every cmd metacharacter of the path is caret-escaped; none survives unescaped.
      const unescaped = line.slice(1, -' ^^^"update^^^""'.length).replace(/\^./g, '');
      assert.doesNotMatch(unescaped, /[&|<>()%!^" ]/, `${hostile}: ${line}`);
    }
  });

  test('F02: Windows stable_command and releases with drive letters', () => {
    update._inject.platform = () => 'win32';
    assert.equal(update.stable_command('C:\\prefix\\releases\\r1'), 'C:\\prefix\\lcu.cmd');
    assert.equal(update.stable_command('C:/prefix/releases/r1/'), 'C:\\prefix\\lcu.cmd');
  });

  test('F23: Windows stdout uses CRLF like Python text-mode stdio', async () => {
    update._inject.platform = () => 'win32';
    update._inject.enabled = () => false;
    assert.deepEqual(await runMain('--notice', '--json'), [0, '{}\r\n']);
  });

  test('notice never raises', async () => {
    update._inject.spawn = () => { throw new Error('no'); };
    assert.equal(update.notice(root), null);
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), '{not json');
    update._inject.spawn = () => ({ on() {}, unref() {} });
    assert.equal(update.notice(root), null);
    cache({ version: null });
    assert.equal(update.notice(root), null);
    update._inject.enabled = () => { throw new Error('boom'); };
    assert.equal(update.notice(root), null);
    assert.equal(update.status_line(root), null);
    const [status, text] = await runMain('--notice', '--json');
    assert.equal(status, 0);
    assert.equal(text, '{}\n');
  });

  test('post_install refreshes whole claude mod', async () => {
    const source = path.join(root, claude_mod.SOURCE);
    const files = {
      '.claude-plugin/plugin.json': '{"name": "lcu-approve", "version": "0.3.0"}',
      'hooks/hooks.json': '{}', 'hooks/register.tsx': 'new', 'types/index.d.ts': 'types', 'tests/register.test.tsx': 'test',
    };
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
      fs.writeFileSync(path.join(source, name), text);
    }
    // What 0.9.0 left behind: an older mod without types/index.d.ts and a file since dropped.
    const target = claude_mod.destination(home);
    fs.mkdirSync(path.join(target, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(target, '.claude-plugin/plugin.json'), '{"name": "lcu-approve", "version": "0.2.0"}');
    fs.mkdirSync(path.join(target, 'hooks'));
    fs.writeFileSync(path.join(target, 'hooks/register.tsx'), 'old');
    fs.writeFileSync(path.join(target, 'hooks/stale.ts'), 'stale');
    const [status, text] = await runMain('--post-install');
    assert.equal(status, 0);
    assert.ok(text.includes('Refreshed the Claude Code lcu-approve mod'));
    assert.equal(fs.readFileSync(path.join(target, 'types/index.d.ts'), 'utf8'), 'types');
    assert.equal(fs.readFileSync(path.join(target, 'hooks/register.tsx'), 'utf8'), 'new');
    assert.ok(fs.readFileSync(path.join(target, '.claude-plugin/plugin.json'), 'utf8').includes('0.3.0'));
    assert.equal(fs.existsSync(path.join(target, 'hooks/stale.ts')), false);
    assert.equal(fs.existsSync(path.join(target, 'tests')), false);
    const config = JSON.parse(fs.readFileSync(path.join(target, claude_mod.CONFIG), 'utf8'));
    assert.equal(config.lcu, path.join(path.dirname(path.dirname(root)), 'current/bin/lcu'));
  });

  test('post_install leaves absent or foreign mod alone', async () => {
    assert.equal(await update.post_install(root, home), 0);
    assert.equal(fs.existsSync(claude_mod.destination(home)), false);
    const target = claude_mod.destination(home);
    fs.mkdirSync(path.join(target, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(target, '.claude-plugin/plugin.json'), '{"name": "someone-else"}');
    out = '';
    await update.post_install(root, home);
    assert.equal(out, '');
    assert.equal(fs.readFileSync(path.join(target, '.claude-plugin/plugin.json'), 'utf8'), '{"name": "someone-else"}');
  });

  // ---- 0.9.6 #22: the Chrome relay is refreshed after an update (test_update.py post_install_output cases), through
  // the real browser.refresh. As in tests/node/browser.test.mjs RefreshTests, only the app resolution, the original
  // installer (a stand-in that writes the manifests) and the OS identity are fixtures (browser.hooks).
  describe('post_install Chrome relay refresh (real browser.refresh)', () => {
    const STABLE = '/opt/lcu/current/bin/lcu';
    const savedHooks = { ...browser.hooks };
    const savedArgIo = { ...argparseIo };
    let relay;
    const support = () => path.join(home, 'Library/Application Support');
    const manifestOf = (dir) => path.join(support(), dir, 'NativeMessagingHosts/com.openai.codexextension.json');
    const taken = '{"name": "com.openai.codexextension", "path": "/Applications/ChatGPT.app/host"}';

    beforeEach(() => {
      relay = { calls: 0, fail: null };
      const resources = path.join(root, 'app/Contents/Resources');
      const source = path.join(resources, 'plugins/openai-bundled/plugins/chrome');
      fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(source, 'scripts/installManifest.mjs'), 'fixture');
      fs.mkdirSync(path.join(source, 'extension-host/macos/arm64'), { recursive: true });
      fs.writeFileSync(path.join(source, 'extension-host/macos/arm64/ChatGPT for Chrome'), 'fixture');
      for (const relative of browser._relay_implementation(ROOT)) {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, relative), path.join(root, relative));
      }
      const env = { HOME: home, NODE_REPL_NODE_PATH: '/fake/node', CODEX_CLI_PATH: '/fake/codex', CUA_REPL_NODE_REPL_PATH: '/fake/repl' };
      const installer = (command, options) => {
        relay.calls += 1;
        const plugin = path.dirname(path.dirname(fileURLToPath(command.at(-1))));
        fs.writeFileSync(path.join(plugin, 'extension-host/macos/arm64/extension-host-config.json'), JSON.stringify({ nodePath: '/fake/node' }));
        for (const dir of ['Google/Chrome', 'Microsoft Edge']) {
          const file = path.join(options.env.HOME, 'Library/Application Support', dir, 'NativeMessagingHosts/com.openai.codexextension.json');
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ name: 'com.openai.codexextension', path: path.join(plugin, 'extension-host/macos/arm64/ChatGPT for Chrome') }));
        }
        return { args: [], returncode: relay.fail ? 1 : 0, stdout: '', stderr: relay.fail ?? '' };
      };
      Object.assign(browser.hooks, {
        system: () => 'Darwin', paths: () => [path.join(root, 'app'), resources, null, {}], environment: () => env,
        capture_run: installer, stable_lcu: () => STABLE, geteuid: () => 501,
      });
      for (const key of ['XDG_CONFIG_HOME', 'CHROME_CONFIG_HOME', 'XDG_DATA_HOME', 'SUDO_USER']) delete process.env[key];
      argparseIo.stdout = () => {}; // browser.install's own output is not under test here
    });
    afterEach(() => {
      Object.assign(browser.hooks, savedHooks);
      Object.assign(argparseIo, savedArgIo);
    });

    async function postInstallOutput() {
      out = ''; err = '';
      const status = await update.post_install(root, home);
      assert.equal(status, 0);
      return [out, err];
    }
    const install = () => { const destination = browser.install(root); relay.calls = 0; return destination; };

    test('post_install refreshes an installed chrome relay and asks to reconnect when it changed', async () => {
      const destination = install();
      fs.writeFileSync(path.join(destination, 'lcu-native-host'), '#!/bin/sh\n# an older wrapper\n');
      const [text, errors] = await postInstallOutput();
      assert.ok(text.includes(`Refreshed the Chrome relay at ${destination}.`), text);
      assert.ok(text.includes('restart Chrome or turn the ChatGPT extension off and on'));
      assert.equal(errors, '');
      assert.equal(relay.calls, 1);
    });

    test('post_install asks to reconnect when only the relay implementation changed (upstream #22 semantics)', async () => {
      const destination = install();
      fs.appendFileSync(path.join(root, 'lcu/native_host.mjs'), '\n// a newer relay\n');
      let [text, errors] = await postInstallOutput();
      assert.equal(errors, '');
      assert.equal(text, `Refreshed the Chrome relay at ${destination}.\n`
        + "If the extension was already connected, restart Chrome or turn the ChatGPT extension off and on so it reconnects through LCU's relay.\n");
      [text, errors] = await postInstallOutput();
      assert.equal(text, `Refreshed the Chrome relay at ${destination}.\n`); // recorded: unchanged the next time
    });

    test('post_install does not ask to reconnect when the relay is unchanged', async () => {
      install();
      const [text, errors] = await postInstallOutput();
      assert.ok(text.includes('Refreshed the Chrome relay at'));
      assert.ok(!text.includes('Chrome or'));
      assert.equal(errors, '');
    });

    test('post_install reports a displaced chrome manifest beside a refresh', async () => {
      install();
      fs.writeFileSync(manifestOf('Google/Chrome'), taken);
      const [text] = await postInstallOutput();
      assert.ok(text.includes('Refreshed the Chrome relay at'));
      assert.ok(text.includes(manifestOf('Google/Chrome')));
      assert.ok(text.includes('left alone'));
      assert.ok(text.includes('browser install'));
    });

    test('post_install is silent about chrome when it was never set up', async () => {
      assert.deepEqual(await postInstallOutput(), ['', '']);
      assert.equal(relay.calls, 0);
    });

    test('post_install reports a manifest that points elsewhere', async () => {
      install();
      fs.writeFileSync(manifestOf('Google/Chrome'), taken);
      fs.unlinkSync(manifestOf('Microsoft Edge'));
      const [text] = await postInstallOutput();
      assert.ok(text.includes('left alone'));
      assert.ok(text.includes('browser install'));
      assert.ok(!text.includes('Refreshed the Chrome relay'));
      assert.equal(fs.readFileSync(manifestOf('Google/Chrome'), 'utf8'), taken);
    });

    test('post_install tells root to run browser install as the desktop account', async () => {
      install();
      browser.hooks.geteuid = () => 0;
      const [text] = await postInstallOutput();
      assert.ok(text.includes('ran as root'));
      assert.ok(text.includes('browser install'));
      assert.equal(relay.calls, 0);
    });

    test('a failed relay refresh warns and does not fail the update', async () => {
      install();
      relay.fail = 'node crashed';
      const [text, errors] = await postInstallOutput();
      assert.equal(text, '');
      assert.ok(errors.includes('could not refresh the Chrome relay'));
      assert.ok(errors.includes('installer failed'), errors);
      assert.ok(errors.includes('browser install'));
      assert.ok(errors.startsWith('lcu update: could not refresh the Chrome relay (') && errors.endsWith(
        `); run \`${path.join(path.dirname(path.dirname(root)), 'current/bin/lcu')} browser install\`.\n`), errors);
    });

    test('post_install without a relay on disk touches no browser files', async () => {
      out = '';
      assert.equal(await update.post_install(root, home), 0);
      assert.equal(relay.calls, 0);
      assert.equal(out, '');
      assert.equal(fs.existsSync(path.join(home, '.local/share/lcu')), false);
      assert.equal(fs.existsSync(path.join(home, 'Library/Application Support/lcu')), false);
      assert.equal(fs.existsSync(path.join(home, 'local/lcu')), false);
    });
  });

  test('codex hint only when registered without notice hook', async () => {
    const codex = path.join(home, '.codex');
    fs.mkdirSync(codex);
    const env = { CODEX_HOME: codex };
    const config = path.join(codex, 'config.toml');
    assert.equal(await update.codex_needs_setup(home, env), false);
    fs.writeFileSync(config, '[mcp_servers.lcu]\ncommand = "/p/current/bin/lcu"\n');
    assert.equal(await update.codex_needs_setup(home, env), true);
    fs.writeFileSync(config, '[mcp_servers.lcu]\ncommand = "/p/current/bin/lcu"\n'
      + '[[hooks.SessionStart]]\nmatcher = "startup|resume"\n'
      + '[[hooks.SessionStart.hooks]]\ntype = "command"\n'
      + 'command = "/p/current/bin/lcu update --notice --hook SessionStart"\n');
    assert.equal(await update.codex_needs_setup(home, env), true);
    fs.appendFileSync(config, '[[hooks.UserPromptSubmit]]\n'
      + '[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\n'
      + 'command = "/p/current/bin/lcu update --notice --hook UserPromptSubmit"\n');
    assert.equal(await update.codex_needs_setup(home, env), false);
  });

  test('F29: malformed Codex config raises Python TypeErrors and AttributeError', async () => {
    const codex = path.join(home, '.codex');
    fs.mkdirSync(codex);
    const env = { CODEX_HOME: codex };
    const config = path.join(codex, 'config.toml');
    fs.writeFileSync(config, 'mcp_servers = 1\n');
    await assert.rejects(update.codex_needs_setup(home, env), (e) => e instanceof TypeError && e.message === "argument of type 'int' is not iterable");
    fs.writeFileSync(config, 'mcp_servers = ["lcu"]\nhooks = { SessionStart = 3 }\n');
    await assert.rejects(update.codex_needs_setup(home, env), (e) => e instanceof TypeError && e.message === "'int' object is not iterable");
    fs.writeFileSync(config, 'mcp_servers = "xlcux"\nhooks = 2\n');
    await assert.rejects(update.codex_needs_setup(home, env), (e) => e.name === 'AttributeError' && e.message === "'int' object has no attribute 'get'");
    fs.writeFileSync(config, 'not toml =');
    assert.equal(await update.codex_needs_setup(home, env), false);
  });

  test('stable_command per platform', () => {
    const prefix = path.dirname(path.dirname(root));
    update._inject.platform = () => 'darwin';
    assert.equal(update.stable_command(root), path.join(prefix, 'current/bin/lcu'));
    update._inject.platform = () => 'win32';
    assert.equal(update.stable_command('C:\\x\\releases\\r1'), 'C:\\x\\lcu.cmd');
  });

  test('notice CLI', async () => {
    cache();
    let [status, text] = await runMain('--notice', '--json');
    assert.equal(status, 0);
    assert.equal(JSON.parse(text).latest, '0.9.2');
    [status, text] = await runMain('--notice');
    assert.ok(text.startsWith('LCU 0.9.2 is available'));
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
    cache({ ...INFO, version: '0.9.1' });
    assert.deepEqual(await runMain('--notice', '--json'), [0, '{}\n']);
    assert.deepEqual(await runMain('--notice'), [0, '']);
    assert.deepEqual(await runMain('--notice', '--hook', 'SessionStart'), [0, '']);
  });

  async function hook(event, stdin = '{"session_id": "s1"}') {
    update._inject.stdin = stdin;
    const [status, text] = await runMain('--notice', '--hook', event);
    assert.equal(status, 0);
    return text ? JSON.parse(text).hookSpecificOutput : null;
  }

  const announcedFile = (data = null) => {
    const file = siblingFile('announced.json');
    if (data !== null) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };

  test('hook announces once per session and version', async () => {
    cache();
    const first = await hook('SessionStart');
    assert.equal(first.hookEventName, 'SessionStart');
    assert.ok(first.additionalContext.startsWith('LCU 0.9.2 is available'));
    assert.equal(await hook('SessionStart'), null);
    assert.equal(await hook('UserPromptSubmit'), null);
    // Another session within the cooldown is told nothing about the same release.
    assert.equal(await hook('UserPromptSubmit', '{"session_id": "s2"}'), null);
    // A newer release is announced at once, to the session that asks, then cooled down too.
    cache({ ...INFO, version: '0.9.3', tag: 'v0.9.3' });
    assert.ok((await hook('UserPromptSubmit')).additionalContext.includes('0.9.3'));
    assert.equal(await hook('SessionStart'), null);
    assert.equal(await hook('SessionStart', '{"session_id": "s2"}'), null);
  });

  test('announce cooldown is account-wide and per release', () => {
    const day = update.ANNOUNCE_COOLDOWN;
    assert.equal(day, 24 * 3600);
    const t = 1_000_000_000;
    assert.equal(update.announce('a', '0.9.2', t), true);
    assert.equal(update.announce('a', '0.9.2', t + 1), false);
    assert.equal(update.announce('b', '0.9.2', t + 3600), false);
    assert.equal(update.announce('c', '0.9.2', t + day - 1), false);
    assert.equal(update.announce(null, '0.9.2', t + day - 1), false);
    // After the cooldown the next session (or prompt of one not told yet) is told, once.
    assert.equal(update.announce('b', '0.9.2', t + day), true);
    assert.equal(update.announce('c', '0.9.2', t + day + 1), false);
    assert.equal(update.announce('b', '0.9.2', t + day + 1), false);
    // A session is never told twice about the same release, even after the cooldown.
    assert.equal(update.announce('a', '0.9.2', t + 3 * day), false);
    // A newer release bypasses the cooldown, then has its own.
    assert.equal(update.announce('c', '0.9.3', t + day + 2), true);
    assert.equal(update.announce('d', '0.9.3', t + day + 3), false);
    assert.equal(update.announce('a', '0.9.3', t + 2 * day + 2), true);
    const data = announcedFile();
    assert.deepEqual(data[update.ANNOUNCE_ACCOUNT], { version: '0.9.3', at: t + 2 * day + 2 });
    assert.deepEqual(data.b, { version: '0.9.2', at: t + day });
    assert.equal('d' in data, false);
  });

  test('announce without a session follows the cooldown', () => {
    const t = 1_000_000_000;
    assert.equal(update.announce(null, '0.9.2', t), true);
    assert.equal(update.announce(null, '0.9.2', t + 60), false);
    assert.equal(update.announce('s', '0.9.2', t + 60), false);
    assert.equal(update.announce(null, '0.9.2', t + update.ANNOUNCE_COOLDOWN), true);
    assert.deepEqual(Object.keys(announcedFile()), [update.ANNOUNCE_ACCOUNT]);
  });

  test('security notices follow the cooldown but status shows them', async () => {
    cache({ ...INFO, severity: 'security' });
    assert.notEqual(await hook('SessionStart'), null);
    assert.equal(await hook('SessionStart', '{"session_id": "s2"}'), null);
    assert.ok(update.status_line(root).includes('0.9.2'));
    assert.equal(JSON.parse((await runMain('--notice', '--json'))[1]).severity, 'security');
  });

  test('cooldown expiry through the hook', async () => {
    cache();
    assert.notEqual(await hook('SessionStart'), null);
    assert.equal(await hook('SessionStart', '{"session_id": "s2"}'), null);
    const later = Date.now() / 1000 + update.ANNOUNCE_COOLDOWN + 1;
    cache(INFO, null, -update.ANNOUNCE_COOLDOWN - 1); // keep the cache fresh at the later time
    update._inject.now = () => later;
    assert.notEqual(await hook('UserPromptSubmit', '{"session_id": "s2"}'), null);
    assert.equal(await hook('UserPromptSubmit', '{"session_id": "s3"}'), null);
    assert.equal(await hook('UserPromptSubmit', '{"session_id": "s2"}'), null);
    assert.equal(await hook('UserPromptSubmit'), null);
  });

  test('legacy per-session file still loads', async () => {
    cache();
    const now = Date.now() / 1000;
    announcedFile({ s1: { version: '0.9.2', at: now - 3600 }, s2: { version: '0.9.1', at: now - 7200 } });
    assert.equal(await hook('UserPromptSubmit'), null);
    // No account-wide record yet: the first other session is told, and starts the cooldown.
    assert.notEqual(await hook('UserPromptSubmit', '{"session_id": "s2"}'), null);
    assert.equal(await hook('UserPromptSubmit', '{"session_id": "s3"}'), null);
    const data = announcedFile();
    assert.deepEqual(Object.keys(data).sort(), ['s1', 's2', update.ANNOUNCE_ACCOUNT].sort());
    assert.equal(data.s1.at, now - 3600);
  });

  test('notice --json --announce for agent integrations', async () => {
    cache();
    let [, text] = await runMain('--notice', '--json', '--announce=s1');
    assert.equal(JSON.parse(text).latest, '0.9.2');
    assert.deepEqual(await runMain('--notice', '--json', '--announce=s1'), [0, '{}\n']);
    assert.deepEqual(await runMain('--notice', '--json', '--announce=s2'), [0, '{}\n']);
    assert.deepEqual(await runMain('--notice', '--json', '--announce'), [0, '{}\n']);
    assert.deepEqual(await runMain('--notice', '--announce', 's3'), [0, '']);
    // Without --announce (a person, status-like use) the cached notice is printed unconditionally.
    assert.equal(JSON.parse((await runMain('--notice', '--json'))[1]).latest, '0.9.2');
    assert.ok((await runMain('--notice'))[1].startsWith('LCU 0.9.2 is available'));
    assert.ok(update.status_line(root).includes('0.9.2'));
  });

  // tests/test_codex_update_notice.py NoticeCooldownTests: the hooks' own command lines, as Codex runs them for
  // several sessions on one account.
  async function runCodexHook(event, session) {
    const command = toPlain(notice_hook('/p/current/bin/lcu', event), { allowReorder: true }).hooks[0].command;
    const argv = command.split(' update ')[1].split(' '); // drop the quoted lcu path and `update`
    update._inject.stdin = JSON.stringify({ session_id: session });
    out = '';
    assert.equal(await update.main(root, argv), 0);
    return out ? JSON.parse(out).hookSpecificOutput.additionalContext : null;
  }

  test('a release is announced once a day across codex sessions', async () => {
    cache();
    assert.ok((await runCodexHook('SessionStart', 'a')).includes('0.9.2'));
    for (const event of NOTICE_EVENTS) {
      assert.equal(await runCodexHook(event, 'a'), null);
      assert.equal(await runCodexHook(event, 'b'), null);
    }
    const later = Date.now() / 1000 + update.ANNOUNCE_COOLDOWN + 1;
    cache(INFO, null, -update.ANNOUNCE_COOLDOWN - 1);
    update._inject.now = () => later;
    assert.equal(await runCodexHook('UserPromptSubmit', 'a'), null);
    assert.ok((await runCodexHook('UserPromptSubmit', 'b')).includes('0.9.2'));
    assert.equal(await runCodexHook('SessionStart', 'c'), null);
  });

  test('a newer release is announced at once to codex sessions', async () => {
    cache();
    assert.ok((await runCodexHook('SessionStart', 'a')).includes('0.9.2'));
    assert.equal(await runCodexHook('SessionStart', 'b'), null);
    cache({ ...INFO, version: '0.9.3', tag: 'v0.9.3' });
    assert.ok((await runCodexHook('SessionStart', 'b')).includes('0.9.3'));
    assert.equal(await runCodexHook('UserPromptSubmit', 'a'), null);
  });

  test('hook output bytes', async () => {
    cache();
    update._inject.stdin = '{"session_id": "s1"}';
    const [, text] = await runMain('--notice', '--hook', 'SessionStart');
    assert.ok(text.startsWith('{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "LCU 0.9.2 is available'));
    assert.ok(text.endsWith('"}}\n'));
    const announced = siblingFile('announced.json');
    assert.match(fs.readFileSync(announced, 'utf8'), /^\{"\*": \{"version": "0\.9\.2", "at": \d+\.\d+\}, "s1": \{"version": "0\.9\.2", "at": \d+\.\d+\}\}$/);
    assert.equal(fs.statSync(announced).mode & 0o777, 0o600);
  });

  test('hook without notice is silent', async () => {
    cache({ ...INFO, version: '0.9.1' });
    assert.equal(await hook('SessionStart'), null);
    assert.equal(fs.existsSync(siblingFile('announced.json')), false);
  });

  test('hook missing or garbage session id', async () => {
    cache();
    for (const stdin of ['', 'garbage{', '[]', '{"session_id": 5}', '{}']) {
      fs.rmSync(siblingFile('announced.json'), { force: true });
      // Without a session id SessionStart is still announced, under the account-wide cooldown only.
      assert.notEqual(await hook('SessionStart', stdin), null);
      assert.equal(await hook('SessionStart', stdin), null);
      assert.equal(await hook('UserPromptSubmit', stdin), null);
      assert.deepEqual(Object.keys(announcedFile()), [update.ANNOUNCE_ACCOUNT]);
    }
  });

  test('F16: hook stdin is bounded by code points, strict UTF-8', () => {
    const script = `import(${JSON.stringify(path.join(ROOT, 'lcu/update.mjs'))}).then((m) => { const id = m.hook_session_id(); process.stdout.write(String(id === null ? null : [...id].length)); })`;
    const run = (input) => spawnSync(process.execPath, ['-e', script], { input, encoding: 'utf8' }).stdout;
    assert.equal(run(Buffer.from(`{"session_id": "${'\u{1F600}'.repeat(530000)}"}`)), '530000');
    assert.equal(run(Buffer.from(`{"session_id": "${'a'.repeat((1 << 20) + 10)}"}`)), 'null'); // cut at 1 MiB characters
    assert.equal(run(Buffer.concat([Buffer.from('{"session_id": "a'), Buffer.from([0xff]), Buffer.from('"}')])), 'null');
  });

  test('hook prunes old announcements', async () => {
    cache();
    const file = siblingFile('announced.json');
    const now = Date.now() / 1000;
    fs.writeFileSync(file, dumps(new Map([
      ['old', new Map([['version', '0.9.2'], ['at', now - 8 * 86400]])],
      ['recent', new Map([['version', '0.9.2'], ['at', now - 86400]])], ['bad', 3],
      [update.ANNOUNCE_ACCOUNT, new Map([['version', '0.9.2'], ['at', now - 2 * 86400]])],
    ])));
    assert.equal(await hook('UserPromptSubmit', '{"session_id": "recent"}'), null);
    assert.notEqual(await hook('UserPromptSubmit', '{"session_id": "old"}'), null);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(data).sort(), ['old', 'recent', update.ANNOUNCE_ACCOUNT].sort());
    assert.ok(data.old.at > now - 5);
    assert.ok(data[update.ANNOUNCE_ACCOUNT].at > now - 5);
    fs.writeFileSync(file, '{broken');
    assert.notEqual(await hook('UserPromptSubmit'), null);
  });

  test('announcement file keeps the order of integer-like session ids', () => {
    cache();
    const file = siblingFile('announced.json');
    const now = Date.now() / 1000;
    fs.writeFileSync(file, `{"b": {"version": "0.9.2", "at": ${now}}, "10": {"version": "0.9.2", "at": ${now}}}`);
    assert.equal(update.announce('2', '0.9.2', now), true);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.indexOf('"b"') < text.indexOf('"10"') && text.indexOf('"10"') < text.indexOf('"2"'));
  });

  test('F30: an explicit int `now` is recorded as an int', () => {
    assert.equal(update.announce('s', '0.9.2', 1000), true);
    assert.equal(fs.readFileSync(siblingFile('announced.json'), 'utf8'), '{"*": {"version": "0.9.2", "at": 1000}, "s": {"version": "0.9.2", "at": 1000}}');
  });

  test('refresh stamp guards stampede', () => {
    update.notice(root);
    update.notice(root);
    assert.equal(spawned.length, 1);
    const stamp = siblingFile('refresh.stamp');
    const old = Date.now() / 1000 - 121;
    fs.utimesSync(stamp, old, old);
    spawned.length = 0;
    update.notice(root);
    assert.equal(spawned.length, 1);
  });

  test('refresh stamp tolerates clock skew', () => {
    const stamp = siblingFile('refresh.stamp');
    assert.equal(update.refresh_claimed(), true);
    const mtime = fs.statSync(stamp).mtimeMs / 1000;
    const now = mtime - 0.05; // the stamp's mtime slightly ahead of time.time()
    assert.equal(update.refresh_claimed(now), false);
    const future = now + update.STAMP_SKEW + 1;
    fs.utimesSync(stamp, future, future);
    assert.equal(update.refresh_claimed(now), true);
    assert.equal(update.refresh_claimed(now + 3), false);
  });

  test('check CLI', async () => {
    update._inject.fetch_latest = async () => INFO;
    let [status, text] = await runMain('--check');
    assert.equal(status, 0);
    assert.ok(text.includes('LCU 0.9.2 is available (installed 0.9.1)'));
    assert.ok(text.includes('update to upgrade.'));
    const data = JSON.parse((await runMain('--check', '--json'))[1]);
    assert.deepEqual([data.current, data.update_available, data.error], ['0.9.1', true, null]);
    assert.deepEqual(data.latest, INFO);
    [, text] = await runMain('--check', '--json');
    assert.ok(text.startsWith('{"current": "0.9.1", "latest": {"version": "0.9.2"'));
    update._inject.fetch_latest = async () => ({ ...INFO, version: '0.9.1' });
    assert.deepEqual(await runMain('--check'), [0, 'LCU 0.9.1 is up to date.\n']);
    update._inject.fetch_latest = async () => { throw new PlainOSError('down'); };
    [status, text] = await runMain('--check', '--json');
    assert.equal(status, 1);
    assert.equal(JSON.parse(text).error, 'down');
    [status, text] = await runMain('--check');
    assert.deepEqual([status, text, err], [1, '', 'lcu update: could not check for updates: down\n']);
  });

  test('F42: check catches by class, not by name', async () => {
    const impostor = new Error('x');
    impostor.name = 'ValueError';
    impostor.isValueError = true;
    assert.equal(update.isValue(impostor), false);
    const fake = new Error('t');
    fake.name = 'TimeoutExpired';
    assert.equal(update.isSubprocessError(fake), false);
    assert.equal(update.isSubprocessError(new TimeoutExpired(['x'], 1000)), true);
    update._inject.fetch_latest = async () => { throw impostor; };
    await assert.rejects(update.check(root), (e) => e === impostor);
  });

  test('refresh CLI is silent', async () => {
    update._inject.fetch_latest = async () => INFO;
    assert.deepEqual(await runMain('--refresh'), [0, '']);
    assert.deepEqual(toPlain(update.read_cache().get('latest')), INFO);
    update._inject.fetch_latest = async () => { throw new PlainOSError('down'); };
    assert.deepEqual(await runMain('--refresh'), [0, '']);
  });

  test('update applies only when newer', async () => {
    const calls = [];
    update._inject.apply = async (...args) => { calls.push(args); return 7; };
    update._inject.fetch_latest = async () => INFO;
    assert.equal((await runMain('--yes'))[0], 7);
    assert.deepEqual(calls, [[root, INFO, { yes: true }]]);
    calls.length = 0;
    update._inject.fetch_latest = async () => ({ ...INFO, version: '0.9.1' });
    assert.deepEqual(await runMain(), [0, 'LCU 0.9.1 is up to date.\n']);
    assert.equal(calls.length, 0);
  });

  test('source checkout is a ValueError', async () => {
    root = release(`${tmp}/other`, null);
    await assert.rejects(runMain('--check'), (e) => e instanceof ValueError && e.message === 'lcu update needs an installed LCU release, not a source checkout.');
  });

  test('mutually exclusive modes are an argparse error', async () => {
    const argparse = await import('../../lcu/compat/argparse.mjs');
    const saved = { ...argparse.io };
    let text = '';
    argparse.io.stderr = (t) => { text += t; };
    argparse.io.exit = (status) => { throw new Error(`exit ${status}`); };
    try {
      await assert.rejects(runMain('--check', '--notice'), /exit 2/);
    } finally { Object.assign(argparse.io, saved); }
    assert.ok(text.endsWith('lcu update: error: argument --notice: not allowed with argument --check\n'));
    assert.ok(text.startsWith('usage: lcu update [-h] [--check | --notice] [--json] [--yes]'));
  });
});
