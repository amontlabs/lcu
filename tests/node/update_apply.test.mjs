// Port of tests/test_update_apply.py. Same archives, same expectations, with these deliberate changes:
//  * POSIX installer command: `/bin/sh <source>/scripts/install.sh --prefix P --runtime-only ...` (BRIEF addendum F)
//    instead of `python -B scripts/install.py|install_macos.py`; Windows keeps `<python> -B scripts/install_windows.py`.
//  * urlopen mocks become a local HTTP server behind the REAL downloader (review F21); subprocess.run becomes
//    `_inject.run`.
//  * new: Windows Python preflight, root/SUDO_USER handling, temp dir lifecycle, output text, review regressions.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { after, afterEach, beforeEach, describe, test } from 'node:test';

import * as update from '../../lcu/update.mjs';
import * as apply from '../../lcu/update_apply.mjs';
import { crc32 } from '../../lcu/compat/zip.mjs';
import { dumps, ValueError } from '../../lcu/compat/pyjson.mjs';
import { _resetTempdir } from '../../lcu/compat/tempfile.mjs';
import { skipOnWindows } from './windows_skip.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const INFO = { version: '0.9.2', tag: 'v0.9.2', release_url: 'https://example.invalid/r', severity: 'normal' };
const SAVED_ENV = { ...process.env };
const SAVED_INJECT = { ...apply._inject };
const SAVED_UPDATE = { ...update._inject };

// ---------------------------------------------------------------- archive builders
function tarHeader(name, { size = 0, type = '0', linkname = '', mode = 0o644 } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(size.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write(linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return header;
}
function tarBytes(extra = [], name = 'lcu-0.9.2-linux-x64') {
  const parts = [];
  for (const [entry, data] of [[`${name}/bundle.json`, Buffer.from('{}')], [`${name}/scripts/install.sh`, Buffer.from('#')], ...extra]) {
    parts.push(tarHeader(entry, { size: data.length }), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}
function linkTar(link, target, name = 'lcu-0.9.2-linux-x64') {
  const parts = [tarHeader(`${name}/bundle.json`, { size: 2 }), Buffer.from('{}'), Buffer.alloc(510)];
  parts.push(tarHeader(`${name}/${link}`, { type: '2', linkname: target }), Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}
function zipBytes(name = 'lcu-0.9.2-windows-x64', extra = []) {
  const entries = [[`${name}/bundle.json`, '{}'], ...extra];
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [entry, text] of entries) {
    const data = Buffer.from(text);
    const filename = Buffer.from(entry);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt32LE(crc32(data), 16);
    dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(filename.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, filename, data);
    central.push(dir, filename);
    offset += 30 + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// ---------------------------------------------------------------- fixture
// The real downloader (compat/http fetchToFile/fetchBytes: streaming, file writes, sha256) runs against a local
// server standing in for github.com/.../releases/download; only the base URL is redirected.
let temp, prefix, out, err, requests, runs, tmpdir, served;
const server = http.createServer((req, res) => {
  requests.push(req.url);
  const name = decodeURIComponent(req.url.split('/').pop());
  if (name.endsWith('.sha256')) {
    res.writeHead(200);
    res.end(`${served.checksum || crypto.createHash('sha256').update(served.archive).digest('hex')}  ${name.slice(0, -7)}\n`);
    return;
  }
  res.writeHead(200, { 'Content-Length': served.archive.length });
  res.end(served.archive);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/download`;
after(() => server.close());

beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-apply-test-')));
  prefix = path.join(temp, 'opt', 'lcu');
  tmpdir = path.join(temp, 'tmp');
  fs.mkdirSync(tmpdir);
  process.env.TMPDIR = tmpdir;
  _resetTempdir(); // review F39: the tempfile cache must follow TMPDIR between cases
  delete process.env.SUDO_USER;
  out = ''; err = ''; requests = []; runs = [];
  update._inject.io = { stdout: (t) => { out += t; }, stderr: (t) => { err += t; } };
  // The default cases are the POSIX behaviour (LF stdio, XDG cache): a Windows host runs them as 'linux'. The
  // Windows behaviour (CRLF text mode, LOCALAPPDATA, python preflight) has its own cases that inject 'win32'.
  update._inject.platform = () => (process.platform === 'win32' ? 'linux' : process.platform);
  apply._inject.DOWNLOAD = base;
  apply._inject.http = { env: { PATH: process.env.PATH } };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in SAVED_ENV)) delete process.env[key];
  Object.assign(process.env, SAVED_ENV);
  Object.assign(apply._inject, SAVED_INJECT);
  Object.assign(update._inject, SAVED_UPDATE);
  _resetTempdir();
  fs.rmSync(temp, { recursive: true, force: true });
});

function install(platform = 'linux', arch = 'x64', app = null, bundle = true) {
  const release = path.join(prefix, 'releases', '0.9.1-abcdef012345');
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(prefix, '.lcu-install'), '');
  const description = new Map([['platform', platform], ['architecture', arch]]);
  if (app) description.set('app', app);
  fs.writeFileSync(path.join(release, 'installation.json'), dumps(description));
  if (bundle) fs.writeFileSync(path.join(release, 'bundle.json'), dumps(new Map([['version', '0.9.1'], ['architecture', arch]])));
  return release;
}

function seams({ status = 0, uid = 1000, python = ['/usr/bin/python3'], access = null, tty = false } = {}) {
  apply._inject.run = (command) => {
    runs.push(command);
    return { returncode: typeof status === 'function' ? status(runs.length) : status };
  };
  apply._inject.getuid = () => uid;
  apply._inject.isatty = () => tty;
  apply._inject.find_python = () => python;
  apply._inject.getuser = () => 'desk';
  if (access) apply._inject.access = access;
}

async function runApply(release, archive, { yes = true, checksum = null, info = INFO, ...options } = {}) {
  served = { archive, checksum };
  seams(options);
  return apply.apply(release, info, { yes });
}

describe('assets', () => {
  test('names', () => {
    assert.equal(apply.asset_name('0.9.2', 'darwin', 'arm64'), 'lcu-0.9.2-darwin-arm64.tar.gz');
    assert.equal(apply.asset_name('0.9.2', 'linux', 'arm64'), 'lcu-0.9.2-linux-arm64.tar.gz');
    assert.equal(apply.asset_name('0.9.2', 'linux', 'x64'), 'lcu-0.9.2-linux-x64.tar.gz');
    assert.equal(apply.asset_name('0.9.2', 'windows', 'x64'), 'lcu-0.9.2-windows-x64.zip');
    assert.throws(() => apply.asset_name('0.9.2', 'freebsd', 'x64'), (e) => e instanceof ValueError && e.message === 'No LCU release archive for freebsd x64.');
    assert.throws(() => apply.asset_name('0.9.2', null, 'x64'), /No LCU release archive for None x64\./);
  });

  test('checksum format', () => {
    const digest = 'a'.repeat(64);
    assert.equal(apply._sha256_expected(`${digest}  f.tar.gz\n`, 'f.tar.gz'), digest);
    assert.throws(() => apply._sha256_expected(`${digest}  other.tar.gz\n`, 'f.tar.gz'), (e) => e instanceof ValueError && e.message === 'Malformed checksum file for f.tar.gz.');
    // beyond the Python cases: binary marker, bare digest, uppercase, junk lines first
    assert.equal(apply._sha256_expected(`junk\n${digest.toUpperCase()} *f.tar.gz\n`, 'f.tar.gz'), digest);
    assert.equal(apply._sha256_expected(`${digest}`, 'x'), digest);
    assert.throws(() => apply._sha256_expected(`${'a'.repeat(63)}  f\n`, 'f'), /Malformed checksum/);
  });
});

describe('apply', () => {
  test('source checkout refused', async () => {
    const release = install('linux', 'x64', null, false);
    assert.equal(await runApply(release, tarBytes()), 1);
    assert.equal(runs.length, 0);
    assert.equal(err, 'lcu update: This LCU is a source checkout; `lcu update` only updates an installed release. Rebuild from source or install a release archive.\n');
  });

  test('outside prefix layout refused', async () => {
    const loose = path.join(temp, 'loose');
    fs.mkdirSync(loose);
    fs.writeFileSync(path.join(loose, 'bundle.json'), '{}');
    assert.equal(await runApply(loose, tarBytes()), 1);
    assert.equal(runs.length, 0);
    assert.equal(err, `lcu update: ${loose} is not inside an LCU installation prefix (<prefix>/releases/<name>); update refused.\n`);
  });

  test('non-tty without yes', async () => {
    const release = install();
    assert.equal(await runApply(release, tarBytes(), { yes: false }), 2);
    assert.equal(runs.length, 0);
    assert.deepEqual(requests, []);
    assert.equal(out, `LCU update: 0.9.1 -> 0.9.2\n  prefix:  ${prefix}\n  archive: lcu-0.9.2-linux-x64.tar.gz\n  release: https://example.invalid/r\n`);
    assert.equal(err, `Not interactive; nothing changed. To apply, run:\n  ${path.join(prefix, 'current/bin/lcu')} update --yes\n`);
  });

  test('F28: an explicit null release_url prints None', async () => {
    const release = install();
    await runApply(release, tarBytes(), { yes: false, info: { ...INFO, release_url: null } });
    assert.ok(out.endsWith('  release: None\n'));
    out = '';
    await runApply(release, tarBytes(), { yes: false, info: { version: '0.9.2', tag: 'v0.9.2' } });
    assert.ok(out.endsWith('  release: \n'));
  });

  test('interactive prompt: yes, no, EOF (F17: Python strip)', async () => {
    const release = install();
    served = { archive: tarBytes() };
    seams({ tty: true });
    for (const [answer, expected] of [[' Y', 0], ['\x1cyes\x1c', 0], ['n', 1], ['\ufeffyes', 1], ['', 1]]) {
      runs.length = 0; out = ''; requests = [];
      apply._inject.input = (prompt) => { out += prompt; return answer; };
      assert.equal(await apply.apply(release, INFO, { yes: false }), expected, JSON.stringify(answer));
      assert.ok(out.includes('Proceed? [y/N] '));
      if (expected) {
        assert.ok(out.endsWith('Cancelled.\n'));
        assert.deepEqual([runs, requests], [[], []]); // nothing downloaded or installed
      } else assert.equal(runs.length, 2);
    }
    apply._inject.input = () => { const e = new Error('EOF when reading a line'); e.name = 'EOFError'; throw e; };
    await assert.rejects(apply.apply(release, INFO, { yes: false }), (e) => e.name === 'EOFError');
  });

  test('F17: input() strips the line ending and decodes strictly', () => {
    const script = `import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'lcu/update_apply.mjs')).href)}).then((m) => { try { process.stderr.write(JSON.stringify(m.input('P? '))); } catch (e) { process.stderr.write(e.name); } })`;
    const run = (input) => spawnSync(process.execPath, ['-e', script], { input, encoding: 'utf8' });
    assert.equal(run(Buffer.from('y\r\n')).stderr, '"y"');
    assert.equal(run(Buffer.from('yes\nmore')).stderr, '"yes"');
    assert.equal(run(Buffer.from('tail')).stderr, '"tail"');
    assert.equal(run(Buffer.from([0xff, 0x0a])).stderr, 'UnicodeDecodeError');
    assert.equal(run(Buffer.alloc(0)).stderr, 'EOFError');
    assert.equal(run(Buffer.from('y\n')).stdout, 'P? ');
  });

  test('checksum mismatch', async () => {
    const release = install();
    assert.equal(await runApply(release, tarBytes(), { checksum: '0'.repeat(64) }), 1);
    assert.equal(runs.length, 0);
    assert.equal(err, `Downloading ${base}/v0.9.2/lcu-0.9.2-linux-x64.tar.gz\n`
      + 'lcu update: Checksum mismatch for lcu-0.9.2-linux-x64.tar.gz; refusing to install it.\n');
    assert.deepEqual(requests, ['/download/v0.9.2/lcu-0.9.2-linux-x64.tar.gz', '/download/v0.9.2/lcu-0.9.2-linux-x64.tar.gz.sha256']);
    assert.deepEqual(fs.readdirSync(tmpdir), []);
  });

  test('download writes the served bytes and verifies them', async () => {
    const release = install();
    const archive = tarBytes([['lcu-0.9.2-linux-x64/payload', crypto.randomBytes(300000)]]);
    let seen = null;
    const status = (n) => {
      if (n === 1) seen = fs.readFileSync(path.join(tmpdir, fs.readdirSync(tmpdir)[0], 'lcu-0.9.2-linux-x64.tar.gz'));
      return 0;
    };
    assert.equal(await runApply(release, archive, { status }), 0);
    assert.ok(seen.equals(archive));
  });

  test('path traversal refused', async () => {
    const release = install();
    for (const archive of [tarBytes([['../evil', Buffer.from('x')]]), tarBytes([['/abs/evil', Buffer.from('x')]]),
      linkTar('link', '/etc/passwd'), linkTar('link', '../../outside')]) {
      assert.equal(await runApply(release, archive), 1);
      assert.equal(runs.length, 0);
      assert.match(err, /lcu update: (Unsafe path in archive: |Archive link escapes the release: )/);
      err = '';
    }
  });

  test('zip traversal refused', async () => {
    const release = install('windows');
    assert.equal(await runApply(release, zipBytes('lcu-0.9.2-windows-x64', [['../evil', 'x']])), 1);
    assert.equal(runs.length, 0);
    assert.match(err, /lcu update: Unsafe entry in archive: \.\.\/evil/);
  });

  test('bad archive is reported, not thrown', async () => {
    const release = install();
    assert.equal(await runApply(release, Buffer.from('not a tarball')), 1);
    assert.match(err, /^Downloading .*\nlcu update: /);
    assert.equal(runs.length, 0);
  });

  test('archive without a release bundle', async () => {
    const release = install();
    assert.equal(await runApply(release, tarBytes([], 'other-dir')), 1);
    assert.match(err, /lcu update: The archive does not contain an LCU release bundle\.\n$/);
  });

  test('linux command', async () => {
    const app = path.join(temp, 'chatgpt');
    fs.mkdirSync(app);
    const release = install('linux', 'x64', app);
    assert.equal(await runApply(release, tarBytes()), 0);
    const command = runs[0];
    assert.deepEqual(command.slice(0, 2), ['/bin/sh', '-p']); // -p: explicit shells ignore the #!/bin/sh -p line
    assert.ok(command[2].replaceAll('\\', '/').endsWith('scripts/install.sh'));
    assert.deepEqual(command.slice(3), ['--prefix', prefix, '--runtime-only', '--existing-app', app, '--skip-system']);
    assert.deepEqual(runs[1], [path.join(prefix, 'current/bin/lcu'), 'update', '--post-install']);
    assert.ok(out.endsWith(`LCU 0.9.2 installed. Restart agents that use LCU so they load the new release.\nTo reclaim space from superseded releases, run: ${path.join(prefix, 'current/bin/lcu')} prune\n`));
    assert.deepEqual(fs.readdirSync(tmpdir), []); // temp dir removed
  });

  test('missing recorded app adds no --existing-app', async () => {
    const release = install('linux', 'x64', path.join(temp, 'gone'));
    await runApply(release, tarBytes());
    assert.deepEqual(runs[0].slice(3), ['--prefix', prefix, '--runtime-only', '--skip-system']);
  });

  test('macos command', async () => {
    const app = path.join(temp, 'ChatGPT.app');
    fs.mkdirSync(app);
    const release = install('darwin', 'arm64', app);
    assert.equal(await runApply(release, tarBytes([], 'lcu-0.9.2-darwin-arm64')), 0);
    const command = runs[0];
    assert.deepEqual(command.slice(0, 2), ['/bin/sh', '-p']); // -p: explicit shells ignore the #!/bin/sh -p line
    assert.ok(command[2].replaceAll('\\', '/').endsWith('scripts/install.sh'));
    assert.deepEqual(command.slice(3), ['--prefix', prefix, '--runtime-only', '--existing-app', app]);
    // Then the new release refreshes what setup copied out of the old one.
    assert.deepEqual(runs[1], [path.join(prefix, 'current/bin/lcu'), 'update', '--post-install']);
  });

  test('windows command', async () => {
    const release = install('windows', 'x64');
    assert.equal(await runApply(release, zipBytes()), 0);
    const command = runs[0];
    assert.deepEqual(command.slice(0, 2), ['/usr/bin/python3', '-B']);
    assert.ok(command[2].endsWith(path.join('scripts', 'install_windows.py')));
    assert.deepEqual(command.slice(3), ['--prefix', prefix, '--runtime-only']);
    assert.deepEqual(runs[1], [path.join(prefix, 'lcu.cmd'), 'update', '--post-install']);
  });

  test('windows preflight: no usable python stops before downloading (after the non-tty gate)', async () => {
    const release = install('windows', 'x64');
    assert.equal(await runApply(release, zipBytes(), { python: null, yes: false }), 2); // Python's non-tty exit first
    assert.equal(await runApply(release, zipBytes(), { python: null }), 1);
    assert.deepEqual(requests, []);
    assert.equal(runs.length, 0);
    assert.match(err, /\nlcu update: updating LCU on Windows needs Python 3\.12 or newer on PATH .*nothing was downloaded or changed\.\n$/);
    assert.deepEqual(fs.readdirSync(tmpdir), []);
  });

  test('F02: Windows-shaped installation resolves with ntpath semantics (fixture filesystem)', () => {
    update._inject.platform = () => 'win32';
    const files = new Map([
      ['C:\\prefix\\releases\\r1\\bundle.json', '{"version": "0.9.1", "architecture": "x64"}'],
      ['C:\\prefix\\releases\\r1\\installation.json', '{"platform": "windows", "architecture": "x64"}'],
      ['C:\\prefix\\.lcu-install', ''],
    ]);
    apply._inject.fs = {
      isFile: (file) => files.has(file), isDir: () => false, realpathWin: (file) => file,
      readText: (file) => { if (!files.has(file)) throw new Error(`unexpected read ${file}`); return files.get(file); },
    };
    const [prefixFound, bundle, installation] = apply._layout('C:/prefix/releases/r1/');
    assert.equal(prefixFound, 'C:\\prefix');
    assert.equal(bundle.get('version'), '0.9.1');
    assert.equal(installation.get('platform'), 'windows');
    assert.deepEqual(apply.installer_command('windows', prefixFound, installation, 'C:\\t\\x', { python: ['C:\\Py\\python.exe'] }),
      ['C:\\Py\\python.exe', '-B', 'C:\\t\\x\\scripts\\install_windows.py', '--prefix', 'C:\\prefix', '--runtime-only']);
  });

  test('F03: Windows post-install runs lcu.cmd through cmd.exe without a shell string', () => {
    update._inject.platform = () => 'win32';
    update._inject.env = { ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
    const calls = [];
    apply._inject.spawnSync = (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; };
    assert.equal(apply.runCommand(['C:\\opt\\p&calc&x\\lcu.cmd', 'update', '--post-install']).returncode, 0);
    assert.equal(calls.length, 1);
    const { command, args, options } = calls[0];
    assert.equal(command, 'C:\\Windows\\system32\\cmd.exe');
    assert.equal(options.shell, undefined);
    assert.equal(options.windowsVerbatimArguments, true);
    assert.equal(options.stdio, 'inherit');
    assert.deepEqual(args, ['/d', '/s', '/c', '"C:\\opt\\p^&calc^&x\\lcu.cmd ^^^"update^^^" ^^^"--post-install^^^""']);
  });

  test('F05: Python discovery probes are killed with SIGKILL on timeout', () => {
    const win = process.platform === 'win32'; // a PATH with a drive letter needs the Windows lookup (';' and PATHEXT)
    update._inject.platform = () => (win ? 'win32' : 'linux');
    const calls = [];
    apply._inject.spawnSync = (command, args, options) => { calls.push(options); return { status: 1 }; };
    const bin = path.join(temp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, win ? 'python.exe' : 'python'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(apply.find_python({ PATH: bin }), null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].killSignal, 'SIGKILL');
    assert.equal(calls[0].timeout, 20000);
  });

  test('installer failure status', async () => {
    const release = install();
    assert.equal(await runApply(release, tarBytes(), { status: 7 }), 7);
    assert.equal(runs.length, 1); // no post-install after a failed install
    assert.ok(err.endsWith('lcu update: the installer failed (exit 7); the previous release stays current.\n'));
    assert.equal(out.includes('installed'), false);
  });

  test('post-install failure is not fatal', async () => {
    const release = install();
    assert.equal(await runApply(release, tarBytes(), { status: (n) => (n === 1 ? 0 : 3) }), 0);
    assert.ok(err.endsWith(`lcu update: could not refresh harness integrations; rerun \`${path.join(prefix, 'current/bin/lcu')} setup\` for your agents.\n`));
    assert.ok(out.includes('LCU 0.9.2 installed.'));
  });

  test('unwritable linux prefix prints sudo', { skip: skipOnWindows('the sudo hint is the Linux root/permission path and quotes POSIX /bin/sh command lines') }, async () => {
    const release = install();
    assert.equal(await runApply(release, tarBytes(), { access: () => false }), 1);
    assert.equal(runs.length, 0);
    const kept = fs.readdirSync(tmpdir);
    assert.equal(kept.length, 1); // kept for the sudo hint
    const source = path.join(tmpdir, kept[0], 'extract', 'lcu-0.9.2-linux-x64');
    assert.ok(err.endsWith(`${prefix} is not writable by this account. The verified release is at ${source}; install it with:\n  sudo /bin/sh -p ${source}/scripts/install.sh --prefix ${prefix} --runtime-only --skip-system --user desk\nThen delete ${path.join(tmpdir, kept[0])}.\n`), err);
  });

  test('root needs SUDO_USER and passes --user', async () => {
    const release = install();
    assert.equal(await runApply(release, tarBytes(), { uid: 0 }), 1);
    assert.ok(err.endsWith('lcu update: running as root without SUDO_USER; run it as the desktop account through sudo or as that account.\n'));
    assert.equal(runs.length, 0);
    assert.deepEqual(fs.readdirSync(tmpdir), []);
    process.env.SUDO_USER = 'alice';
    err = '';
    assert.equal(await runApply(release, tarBytes(), { uid: 0 }), 0);
    assert.deepEqual(runs[0].slice(-2), ['--user', 'alice']);
  });

  test('installer_command', () => {
    const description = new Map([['platform', 'linux']]);
    assert.deepEqual(apply.installer_command('linux', '/p', description, '/s'), ['/bin/sh', '-p', '/s/scripts/install.sh', '--prefix', '/p', '--runtime-only', '--skip-system']);
    assert.deepEqual(apply.installer_command('windows', '/p', description, '/s', { python: ['py', '-3'] }), ['py', '-3', '-B', '/s/scripts/install_windows.py', '--prefix', '/p', '--runtime-only']);
  });

  test('malformed installation.json / bundle.json', async () => {
    const release = install();
    fs.writeFileSync(path.join(release, 'installation.json'), '[]');
    assert.equal(await runApply(release, tarBytes()), 1);
    assert.equal(err, `lcu update: Malformed ${path.join(release, 'installation.json')}\n`);
    err = '';
    fs.writeFileSync(path.join(release, 'installation.json'), '{');
    assert.equal(await runApply(release, tarBytes()), 1);
    assert.match(err, /^lcu update: Cannot read .*installation\.json: Expecting property name enclosed in double quotes: line 1 column 2 \(char 1\)\n$/);
  });
});
