import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync, gzipSync } from 'node:zlib';

import * as apply from '../../lcu/update_apply.mjs';
import { override, temporary, write } from './fixtures.mjs';

const INFO = { version: '0.9.2', tag: 'v0.9.2', release_url: 'https://example.invalid/r', severity: 'normal' };

/** A ustar archive of `[name, data | {link} | {symlink}]` entries, gzip-compressed. */
export function tarGz(entries) {
  const blocks = [];
  for (const [name, value] of entries) {
    const header = Buffer.alloc(512);
    const type = typeof value === 'string' || Buffer.isBuffer(value) ? '0' : value.symlink !== undefined ? '2' : '1';
    const data = type === '0' ? Buffer.from(value) : Buffer.alloc(0);
    header.write(name, 0, 100);
    header.write('0000755\0', 100);
    header.write(data.length.toString(8).padStart(11, '0'), 124);
    header.write(type, 156);
    if (type !== '0') header.write(value.symlink ?? value.link, 157, 100);
    header.write('ustar\0' + '00', 257);
    header.fill(' ', 148, 156);
    header.write(`${[...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

/** A deflated zip of `[name, data]` entries. */
export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const data = Buffer.from(value);
    const packed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(Buffer.byteLength(name), 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(Buffer.byteLength(name), 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, Buffer.from(name), packed);
    central.push(entry, Buffer.from(name));
    offset += 30 + Buffer.byteLength(name) + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const release = (name = 'lcu-0.9.2-linux-x64', extra = []) =>
  tarGz([[`${name}/bundle.json`, '{}'], [`${name}/scripts/install.mjs`, '//'], ...extra]);

/** An installed 0.9.1 release in a prefix; `run` records commands and answers with `status`. */
function installed(t, { platform = 'linux', arch = 'x64', app, bundle = true } = {}) {
  const base = temporary(t);
  const prefix = join(base, 'opt/lcu');
  const root = join(prefix, 'releases/0.9.1-abcdef012345');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(prefix, '.lcu-install'), '');
  write(join(root, 'installation.json'), JSON.stringify({ platform, architecture: arch, ...(app ? { app } : {}) }));
  if (bundle) write(join(root, 'bundle.json'), JSON.stringify({ version: '0.9.1', architecture: arch }));
  const errors = [];
  override(t, apply.deps, 'interactive', () => false);
  override(t, apply.deps, 'uid', () => 1000);
  override(t, apply.deps, 'report', (text) => errors.push(text));
  override(t, apply.deps, 'print', () => {});
  return { base, prefix, root, errors };
}

/** Apply with `archive` served as the release asset; returns `[status, commands]`. */
async function run(t, root, archive, { yes = true, status = 0, checksum } = {}) {
  const commands = [];
  override(t, apply.deps, 'download', async (url) => {
    if (url.endsWith('.sha256')) return Buffer.from(`${checksum ?? createHash('sha256').update(archive).digest('hex')}  ${url.split('/').at(-1).slice(0, -7)}\n`);
    return archive;
  });
  override(t, apply.deps, 'run', (command) => { commands.push(command); return status; });
  return [await apply.apply(root, INFO, { yes }), commands];
}

test('asset names and checksum files', () => {
  assert.equal(apply.assetName('0.9.2', 'darwin', 'arm64'), 'lcu-0.9.2-darwin-arm64.tar.gz');
  assert.equal(apply.assetName('0.9.2', 'windows', 'x64'), 'lcu-0.9.2-windows-x64.zip');
  assert.throws(() => apply.assetName('0.9.2', 'freebsd', 'x64'), /No LCU release archive/);
  const digest = 'a'.repeat(64);
  assert.equal(apply.expectedSha256(`${digest}  f.tar.gz\n`, 'f.tar.gz'), digest);
  assert.equal(apply.expectedSha256(`${digest} *f.tar.gz\n`, 'f.tar.gz'), digest);
  assert.throws(() => apply.expectedSha256(`${digest}  other.tar.gz\n`, 'f.tar.gz'), /Malformed checksum/);
});

test('a source checkout or a release outside a prefix is refused', async (t) => {
  const { root, base } = installed(t, { bundle: false });
  assert.deepEqual(await run(t, root, release()), [1, []]);
  const loose = join(base, 'loose');
  write(join(loose, 'bundle.json'), '{}');
  assert.deepEqual(await run(t, loose, release()), [1, []]);
});

test('without --yes and a terminal nothing is downloaded', async (t) => {
  const { root } = installed(t);
  override(t, apply.deps, 'download', async () => assert.fail('downloaded'));
  override(t, apply.deps, 'run', () => assert.fail('ran'));
  assert.equal(await apply.apply(root, INFO, { yes: false }), 2);
});

test('a checksum mismatch, a path traversal or an escaping link stops before the installer', async (t) => {
  const { root } = installed(t);
  assert.deepEqual(await run(t, root, release(), { checksum: '0'.repeat(64) }), [1, []]);
  for (const extra of [[['lcu-0.9.2-linux-x64/../evil', 'x']], [['/abs/evil', 'x']],
    [['lcu-0.9.2-linux-x64/link', { symlink: '/etc/passwd' }]], [['lcu-0.9.2-linux-x64/link', { symlink: '../../outside' }]],
    [['lcu-0.9.2-linux-x64/hard', { link: '../outside' }]]]) {
    assert.deepEqual(await run(t, root, release('lcu-0.9.2-linux-x64', extra)), [1, []], JSON.stringify(extra));
  }
  const windows = installed(t, { platform: 'windows' });
  assert.deepEqual(await run(t, windows.root, zip([['lcu-0.9.2-windows-x64/bundle.json', '{}'], ['../evil', 'x']])), [1, []]);
});

test('Linux runs the new Node installer for the same app, then the new release refreshes integrations', async (t) => {
  const app = join(temporary(t), 'chatgpt');
  mkdirSync(app);
  const { root, prefix } = installed(t, { app });
  const [status, commands] = await run(t, root, release('lcu-0.9.2-linux-x64', [['lcu-0.9.2-linux-x64/bin/lcu', '#!/bin/sh\n']]));
  assert.equal(status, 0);
  assert.equal(commands[0][0], process.execPath);
  assert.match(commands[0][1], /lcu-0\.9\.2-linux-x64\/scripts\/install\.mjs$/);
  assert.deepEqual(commands[0].slice(2), ['--prefix', prefix, '--runtime-only', '--existing-app', app, '--skip-system']);
  assert.deepEqual(commands[1], [join(prefix, 'current/bin/lcu'), 'update', '--post-install']);
});

test('macOS and Windows commands', async (t) => {
  const app = join(temporary(t), 'ChatGPT.app');
  mkdirSync(app);
  const mac = installed(t, { platform: 'darwin', arch: 'arm64', app });
  let [status, commands] = await run(t, mac.root, release('lcu-0.9.2-darwin-arm64'));
  assert.equal(status, 0);
  assert.deepEqual(commands[0].slice(2), ['--prefix', mac.prefix, '--runtime-only', '--existing-app', app]);
  const windows = installed(t, { platform: 'windows' });
  [status, commands] = await run(t, windows.root, zip([['lcu-0.9.2-windows-x64/bundle.json', '{}']]));
  assert.equal(status, 0);
  assert.match(commands[0][1], /scripts\/install_windows\.mjs$/);
  assert.deepEqual(commands[0].slice(2), ['--prefix', windows.prefix, '--runtime-only']);
  assert.deepEqual(commands[1], [join(windows.prefix, 'lcu.cmd'), 'update', '--post-install']);
});

test('an installer failure is returned and nothing else runs', async (t) => {
  const { root } = installed(t);
  const [status, commands] = await run(t, root, release(), { status: 7 });
  assert.equal(status, 7);
  assert.equal(commands.length, 1);
});

test('an unwritable Linux prefix keeps the verified release and prints the sudo command', async (t) => {
  const { root, errors } = installed(t);
  override(t, apply.deps, 'writable', () => false);
  assert.deepEqual(await run(t, root, release()), [1, []]);
  assert.match(errors.join(''), /not writable by this account[\s\S]*sudo .*install\.mjs .*--user/);
});

test('extraction keeps files, modes and links inside the release', (t) => {
  const base = temporary(t);
  apply.extract(apply.tarEntries(tarGz([['r/bin/lcu', '#!/bin/sh\n'], ['r/bin/alias', { symlink: 'lcu' }], ['r/copy', { link: 'r/bin/lcu' }]])), base);
  assert.equal(readFileSync(join(base, 'r/bin/alias'), 'utf8'), '#!/bin/sh\n');
  assert.equal(readFileSync(join(base, 'r/copy'), 'utf8'), '#!/bin/sh\n');
  assert.equal(statSync(join(base, 'r/bin/lcu')).mode & 0o777, 0o755);
  apply.extract(apply.zipEntries(zip([['w/bin/lcu.cmd', '@echo off\r\n']])), base);
  assert.equal(readFileSync(join(base, 'w/bin/lcu.cmd'), 'utf8'), '@echo off\r\n');
});

test('the test release source serves archives from a local directory', async (t) => {
  const base = temporary(t);
  const saved = process.env.LCU_UPDATE_SOURCE;
  process.env.LCU_UPDATE_SOURCE = base;
  t.after(() => { if (saved === undefined) delete process.env.LCU_UPDATE_SOURCE; else process.env.LCU_UPDATE_SOURCE = saved; });
  write(join(base, 'v0.9.2/lcu-0.9.2-linux-x64.tar.gz'), 'archive');
  assert.equal((await apply.deps.download(`${apply.DOWNLOAD}/v0.9.2/lcu-0.9.2-linux-x64.tar.gz`)).toString(), 'archive');
});
