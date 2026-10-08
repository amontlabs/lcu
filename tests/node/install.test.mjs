import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { acquire, installLockPath } from '../../lcu/lock.mjs';
import { SYSTEM_PACKAGES, checkedPrefix, deps, main, selectLinuxApp, selectRelease } from '../../scripts/install.mjs';
import { REPO, linuxApp, override, seal, temporary, write } from './fixtures.mjs';

const ARCH = { arm64: 'arm64', x64: 'x64' }[process.arch];
const linux = process.platform === 'linux';
// Root must name the account setup is for.
const USER = ['--user', userInfo().username];

/** A sealed release source for this machine: what an extracted archive holds. */
function source(base, payload = 'new version') {
  const root = join(base, 'bundle');
  write(join(root, 'payload'), payload);
  write(join(root, 'runtime.lock.json'), JSON.stringify({ architectures: { [ARCH]: { sha256: '0'.repeat(64) } } }));
  seal(root, ARCH);
  return root;
}

/** A prefix whose current release is `releases/old`. */
function existing(base) {
  const prefix = join(base, 'lcu');
  write(join(prefix, 'releases/old/data'), 'previous version');
  writeFileSync(join(prefix, '.lcu-install'), '');
  symlinkSync('releases/old', join(prefix, 'current'));
  return prefix;
}

/** Stub modules (setup, tested) and the release check; returns the recorded calls. */
function stubbed(t, { setupStatus = 0, base } = {}) {
  const calls = [];
  override(t, deps, 'module', async (root, name) => ({
    main: async (argv) => { calls.push([name, root, argv]); return setupStatus; },
    report: (root) => calls.push(['report', root]),
  }));
  override(t, deps, 'validateRelease', (release) => calls.push(['validate', release]));
  if (base) override(t, deps, 'source', source(base));
  return calls;
}

test('a foreign, linked, relative or nested prefix is refused and left untouched', (t) => {
  const base = temporary(t);
  write(join(base, 'foreign/keep'), 'valuable');
  assert.throws(() => checkedPrefix(join(base, 'foreign')), /not an existing LCU installation/);
  assert.equal(readFileSync(join(base, 'foreign/keep'), 'utf8'), 'valuable');
  symlinkSync(base, join(base, 'link'));
  assert.throws(() => checkedPrefix(join(base, 'link/lcu')), /symlink/);
  assert.throws(() => checkedPrefix('relative/lcu'), /absolute/);
  assert.throws(() => checkedPrefix(join(base, 'bundle/nested'), join(base, 'bundle')), /outside the extracted release/);
  assert.throws(() => checkedPrefix('/usr/local'), /dedicated/);
  assert.equal(checkedPrefix(join(base, 'fresh/lcu')), join(base, 'fresh/lcu'));
});

test('the system packages no longer include Python or XRes', () => {
  assert.ok(!SYSTEM_PACKAGES.includes('python3') && !SYSTEM_PACKAGES.includes('libxres1'));
  assert.ok(SYSTEM_PACKAGES.includes('libxtst6'));
});

test('usage errors exit 2 and --help exits 0 before anything else', { skip: !linux }, async (t) => {
  const calls = stubbed(t);
  t.mock.method(process.stderr, 'write', () => true);
  t.mock.method(process.stdout, 'write', () => true);
  assert.equal(await main([...USER, '--bogus']), 2);
  assert.equal(await main([...USER, '--scope', 'x']), 2);
  assert.equal(await main([...USER, '--help']), 0);
  assert.deepEqual(calls, []);
});

test('refusals come before setup, apt or any prefix write', { skip: !linux }, async (t) => {
  const base = temporary(t);
  const calls = stubbed(t);
  override(t, deps, 'spawn', () => assert.fail('apt or a command ran'));
  const prefix = join(base, 'lcu');
  await assert.rejects(main([...USER, '--offline', '--runtime-only', '--prefix', prefix]), /--offline requires --skip-system/);
  await assert.rejects(main([...USER, '--prefix', prefix, '--runtime-only', '--existing-app', join(base, 'missing')]),
    /chatgpt\.com\/download\/.*--existing-app PATH/);
  await assert.rejects(main([...USER, '--prefix', prefix, '--runtime-only', '--app-package', join(base, 'x.deb')]),
    /--app-package cannot install.*--existing-app PATH/);
  mkdirSync(join(base, 'app'));
  await assert.rejects(main([...USER, '--prefix', prefix, '--existing-app', join(base, 'app'), '--reconcile']), /lcu setup --reconcile/);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(prefix), false);
});

test('agent options are refused with --runtime-only, and an agent or export is required', { skip: !linux }, async (t) => {
  const base = temporary(t);
  const calls = stubbed(t);
  const app = linuxApp(join(base, 'chatgpt'), { arch: ARCH });
  await assert.rejects(main([...USER, '--prefix', join(base, 'lcu'), '--existing-app', app, '--skip-system', '--runtime-only', '--agent', 'codex']),
    /--runtime-only cannot include agent setup options/);
  assert.deepEqual(calls, []);
  await assert.rejects(main([...USER, '--prefix', join(base, 'lcu'), '--existing-app', app, '--skip-system', '--yes']), /Select --agent NAME/);
});

test('an installed app is selected in place with its own version and runtime', { skip: !linux }, (t) => {
  const app = linuxApp(join(temporary(t), 'chatgpt'), { arch: ARCH, runtimeVersion: 'runtime-new' });
  const [selected, descriptor, node] = selectLinuxApp(ARCH, { existingApp: app });
  assert.equal(selected, app);
  assert.deepEqual(descriptor, { package_version: '26.924.22138', runtime: 'runtime-new', architecture: ARCH });
  assert.equal(node, join(app, 'resources/cua_node/bin/node'));
});

test('a runtime-only install links the app, records its Node and reports the tested pair', { skip: !linux }, async (t) => {
  const base = temporary(t);
  const calls = stubbed(t, { base });
  const app = linuxApp(join(base, 'chatgpt'), { arch: ARCH });
  t.mock.method(process.stdout, 'write', () => true);
  const prefix = join(base, 'lcu');
  assert.equal(await main([...USER, '--prefix', prefix, '--existing-app', app, '--skip-system', '--offline', '--runtime-only']), 0);
  const release = realpathSync(join(prefix, 'current'));
  assert.equal(readlinkSync(join(release, 'app')), app);
  assert.deepEqual(JSON.parse(readFileSync(join(release, 'installation.json'), 'utf8')),
    { package_version: '26.924.22138', runtime: 'runtime-new', architecture: ARCH, app });
  assert.equal(readFileSync(join(release, 'node-path'), 'utf8'), `${join(app, 'resources/cua_node/bin/node')}\n`);
  assert.equal(readFileSync(join(release, 'payload'), 'utf8'), 'new version');
  assert.ok(!existsSync(join(prefix, 'apps')));
  assert.deepEqual(calls.map(([name]) => name), ['validate', 'report']);
  assert.equal(calls[1][1], join(prefix, 'current'));
});

test('agent setup runs from the new release with the forwarded options, and its failure is reported', { skip: !linux }, async (t) => {
  const base = temporary(t);
  const app = linuxApp(join(base, 'chatgpt'), { arch: ARCH });
  const prefix = join(base, 'lcu');
  const argv = [...USER, '--prefix', prefix, '--existing-app', app, '--agent', 'pi', '--audio', '--yes', '--skip-system'];
  let calls = stubbed(t, { base });
  t.mock.method(process.stdout, 'write', () => true);
  assert.equal(await main(argv), 0);
  const [, root, forwarded] = calls.at(-1);
  assert.equal(root, join(prefix, 'current'));
  assert.deepEqual(forwarded, ['--prefix', prefix, '--user', userInfo().username, '--scope', 'user', '--session', 'discover',
    '--agent', 'pi', '--yes', '--audio']);
  calls = stubbed(t, { setupStatus: 5 });
  const errors = [];
  t.mock.method(process.stderr, 'write', (text) => errors.push(text));
  assert.equal(await main(argv), 5);
  assert.match(errors.join(''), /setup failed; see the errors above/);
  assert.ok(errors.join('').includes(join(prefix, 'current/bin/lcu')));
});

test('apt failure stops the install before any release changes', { skip: !linux || process.getuid() !== 0 }, async (t) => {
  const base = temporary(t);
  stubbed(t, { base });
  const app = linuxApp(join(base, 'chatgpt'), { arch: ARCH });
  const prefix = existing(base);
  const commands = [];
  override(t, deps, 'spawn', (command, args) => { commands.push([command, ...args]); return { status: commands.length === 1 ? 0 : 100 }; });
  const path = process.env.PATH;
  process.env.PATH = `${join(base, 'bin')}:${path}`;
  t.after(() => { process.env.PATH = path; });
  write(join(base, 'bin/apt-get'), '', 0o755);
  await assert.rejects(main([...USER, '--prefix', prefix, '--existing-app', app, '--runtime-only']), /apt-get install failed/);
  assert.deepEqual(commands.map((command) => command.slice(0, 3)), [['apt-get', 'update'], ['apt-get', 'install', '-y']]);
  assert.deepEqual(readdirSync(join(prefix, 'releases')), ['old']);
});

test('a failed validation or an unexpected .next keeps the active release', async (t) => {
  const base = temporary(t);
  const prefix = existing(base);
  const bundle = source(base);
  const app = join(base, 'chatgpt');
  mkdirSync(app);
  override(t, deps, 'validateRelease', () => { throw new Error('runtime validation failed'); });
  await assert.rejects(selectRelease(prefix, ARCH, app, {}, '/node', { source: bundle }), /runtime validation failed/);
  assert.deepEqual(readdirSync(join(prefix, 'releases')), ['old']);
  override(t, deps, 'validateRelease', () => {});
  symlinkSync(base, join(prefix, '.next'));
  await assert.rejects(selectRelease(prefix, ARCH, app, {}, '/node', { source: bundle }), /Unexpected \.next path/);
  assert.equal(readFileSync(join(prefix, 'current/data'), 'utf8'), 'previous version');
  assert.deepEqual(readdirSync(join(prefix, 'releases')), ['old']);
});

test('installs into one prefix wait for each other', { skip: !linux }, async (t) => {
  const base = temporary(t);
  const prefix = existing(base);
  const bundle = source(base);
  const release = await acquire(installLockPath(prefix));
  const script = `import { deps, selectRelease } from ${JSON.stringify(pathToFileURL(join(REPO, 'scripts/install.mjs')).href)};
deps.validateRelease = () => {};
await selectRelease(${JSON.stringify(prefix)}, ${JSON.stringify(ARCH)}, ${JSON.stringify(base)}, {}, '/node', { source: ${JSON.stringify(bundle)} });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(child.exitCode, null, 'the second install did not wait for the lock');
  assert.equal(readFileSync(join(prefix, 'current/data'), 'utf8'), 'previous version');
  release();
  assert.equal(await exited, 0);
  assert.equal(readFileSync(join(prefix, 'current/payload'), 'utf8'), 'new version');
});

test('install.sh hands over to the Node installer on the app Node, and the 0.9.7 stub to install.sh', { skip: !linux }, (t) => {
  const base = temporary(t);
  const app = linuxApp(join(base, 'chatgpt'), { arch: ARCH });
  write(join(app, 'resources/cua_node/bin/node'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${base}/argv\n`, 0o755);
  const run = (command) => spawnSync(command[0], command.slice(1), { encoding: 'utf8' });
  let result = run([join(REPO, 'scripts/install.sh'), '--prefix', '/opt/x', '--existing-app', app, '--runtime-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(join(base, 'argv'), 'utf8').trim().split('\n'),
    [join(REPO, 'scripts/install.mjs'), '--prefix', '/opt/x', '--existing-app', app, '--runtime-only']);
  const python = spawnSync('python3', ['-c', 'pass']).status === 0;
  if (python) {
    result = run(['python3', '-B', join(REPO, 'scripts/install.py'), '--prefix', '/opt/y', `--existing-app=${app}`, '--skip-system']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(join(base, 'argv'), 'utf8').trim().split('\n'),
      [join(REPO, 'scripts/install.mjs'), '--prefix', '/opt/y', `--existing-app=${app}`, '--skip-system']);
  }
  result = run([join(REPO, 'scripts/install.sh'), '--existing-app', join(base, 'missing'), '--help']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, readFileSync(join(REPO, 'scripts/install-usage.txt'), 'utf8'));
  result = run([join(REPO, 'scripts/install.sh'), '--existing-app', join(base, 'missing')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /chatgpt\.com\/download/);
});

test('macOS: direct sessions only, and a missing app is reported before the prefix is created', async (t) => {
  const base = temporary(t);
  const calls = stubbed(t);
  const bundle = join(base, 'bundle');
  write(join(bundle, 'runtime.lock.json'), JSON.stringify({ platforms: { darwin: { architectures: { [ARCH]: {} } } } }));
  seal(bundle, ARCH, 'darwin');
  override(t, deps, 'source', bundle);
  override(t, process, 'platform', 'darwin');
  const prefix = join(base, 'lcu');
  await assert.rejects(main([...USER, '--prefix', prefix, '--runtime-only', '--session', 'discover']), /macOS uses --session direct/);
  // (setup's default session follows the real platform, so the test names it)
  await assert.rejects(main([...USER, '--prefix', prefix, '--runtime-only', '--session', 'direct', '--existing-app', join(base, 'ChatGPT.app')]),
    /chatgpt\.com\/download\/.*--existing-app PATH/);
  assert.equal(existsSync(prefix), false);
  assert.deepEqual(calls, []);
});
