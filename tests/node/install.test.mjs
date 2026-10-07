// Port of the installer cases of tests/test_installation.py (scripts/install.py, scripts/installed_app.py) and
// tests/test_bundle.py (scripts/bundle.py install-time half), for scripts/install.mjs, installed_app.mjs and
// bundle_runtime.mjs. mock.patch targets are the modules' `internals` objects.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import { io } from '../../lcu/compat/argparse.mjs';
import { seal as hashSeal } from '../../lcu/compat/hash.mjs';
import { dumps, loads, ValueError } from '../../lcu/compat/pyjson.mjs';
import { CalledProcessError } from '../../lcu/compat/subprocess.mjs';
import * as install from '../../scripts/install.mjs';
import * as installedApp from '../../scripts/installed_app.mjs';
import { inventory, verify, VERSION } from '../../scripts/bundle_runtime.mjs';
import { ORACLE_ROOT } from './oracle_root.mjs';
import { skippedOnWindows } from './windows_skip.mjs';

const { describe, it } = skippedOnWindows('the Linux installer (scripts/install.mjs behind install.sh: apt, dpkg, chmod modes, root/sudo accounts); Windows installs through install_windows.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const seal = (root, arch, target = 'linux') => hashSeal(root, VERSION, arch, target);

const savedInstall = { ...install.internals, setup: { ...install.internals.setup } };
const savedApp = { ...installedApp.internals };
const savedIo = { ...io };
const setupImpl = (await import('../../lcu/setup.mjs')).impl;
const savedPlatform = setupImpl.platform;
afterEach(() => {
  Object.assign(install.internals, savedInstall, { setup: { ...savedInstall.setup } });
  Object.assign(installedApp.internals, savedApp);
  Object.assign(io, savedIo);
  setupImpl.platform = savedPlatform;
});

function capture() {
  const out = { stdout: '', stderr: '' };
  io.stdout = (text) => { out.stdout += text; };
  io.stderr = (text) => { out.stderr += text; };
  return out;
}

const rejectsMatching = (fn, pattern, name = 'ValueError') => assert.rejects(fn, (error) => {
  if (name) assert.equal(error?.name, name, `${error?.name}: ${error?.message}`);
  assert.match(error.message, pattern);
  return true;
});
const throwsMatching = (fn, pattern, name = 'ValueError') => assert.throws(fn, (error) => {
  assert.equal(error?.name, name, `${error?.name}: ${error?.message}`);
  assert.match(error.message, pattern);
  return true;
});

function writeAsar(file, members) {
  const files = {};
  const payload = [];
  let offset = 0;
  for (const [name, content] of Object.entries(members)) {
    let node = files;
    const parts = name.split('/');
    for (const part of parts.slice(0, -1)) node = (node[part] ??= { files: {} }).files;
    node[parts.at(-1)] = { offset: String(offset), size: content.length };
    payload.push(content);
    offset += content.length;
  }
  const header = Buffer.from(JSON.stringify({ files }));
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + header.length, 4);
  prefix.writeUInt32LE(4 + header.length, 8);
  prefix.writeUInt32LE(header.length, 12);
  fs.writeFileSync(file, Buffer.concat([prefix, header, ...payload]));
}

/** tests/test_installation.py _application_fixture */
function applicationFixture(root, { version = '26.924.22138', runtime_version = 'runtime-new', arch = 'arm64', relocated = false } = {}) {
  const app = root;
  const resources = path.join(app, 'resources');
  const runtime = path.join(resources, 'cua_node');
  const executable = '#!/bin/sh\nexit 0\n';
  const repl = 'resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs';
  for (const relative of ['ChatGPT', 'resources/cua_node/bin/node', 'resources/cua_node/bin/node_repl', repl]) {
    const file = path.join(app, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative === repl ? 'export {};\n' : executable);
    if (relative !== repl) fs.chmodSync(file, 0o755);
  }
  const tools = path.join(resources, relocated ? 'codex-cli/bin' : '');
  for (const name of ['codex', 'codex-code-mode-host']) {
    fs.mkdirSync(tools, { recursive: true });
    fs.writeFileSync(path.join(tools, name), executable);
    fs.chmodSync(path.join(tools, name), 0o755);
  }
  writeAsar(path.join(resources, 'app.asar'), { 'package.json': Buffer.from(JSON.stringify({ name: 'chatgpt', version })) });
  fs.writeFileSync(path.join(runtime, 'manifest.json'), JSON.stringify({ platform: 'linux', arch, runtime_archive_version: runtime_version }));
  fs.mkdirSync(path.join(resources, 'plugins/openai-bundled/plugins/browser'), { recursive: true });
  for (const relative of ['plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json',
    `plugins/openai-bundled/plugins/chrome/extension-host/linux/${arch}/extension-host`,
    'plugins/openai-bundled/plugins/unified-computer-use/.mcp.json',
    'plugins/openai-bundled/plugins/browser/install.js']) {
    const file = path.join(resources, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative.endsWith('extension-host') ? executable : '{}\n');
    if (relative.endsWith('extension-host')) fs.chmodSync(file, 0o755);
  }
  return app;
}

const selected = (application) => [application, { package_version: '26.924.22138', runtime: 'runtime-new', architecture: 'arm64' }];

function bundle(root) {
  const source = path.join(root, 'bundle');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'payload'), 'new version');
  fs.writeFileSync(path.join(source, 'runtime.lock.json'), JSON.stringify({ version: '26.915.31945', architectures: { arm64: { sha256: '0'.repeat(64) } } }));
  seal(source, 'arm64');
  return source;
}

function previousRelease(prefix) {
  const old = path.join(prefix, 'releases/old');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'data'), 'previous version');
  fs.writeFileSync(path.join(prefix, '.lcu-install'), '');
  fs.symlinkSync('releases/old', path.join(prefix, 'current'));
  return old;
}

describe('InstallationTests', () => {
  let root;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-install-')));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

  it('foreign prefix is untouched', () => {
    fs.writeFileSync(path.join(root, 'keep'), 'valuable');
    throwsMatching(() => install.checked_prefix(root), /not an existing LCU installation/);
    assert.equal(fs.readFileSync(path.join(root, 'keep'), 'utf8'), 'valuable');
  });

  it('symlink destination is rejected', () => {
    fs.symlinkSync(root, path.join(root, 'link'));
    throwsMatching(() => install.checked_prefix(path.join(root, 'link/lcu')), /symlink/);
  });

  it('relative prefix is rejected', () => {
    throwsMatching(() => install.checked_prefix('relative/lcu'), /^The installation prefix must be absolute$/);
  });

  it('offline requires skip-system before installation writes', async () => {
    install.internals.setup.validate = () => { throw new Error('setup reached'); };
    install.internals.run = () => { throw new Error('network reached'); };
    await rejectsMatching(() => install.main(['--offline', '--runtime-only']), /--offline requires --skip-system/);
  });

  it('installation inside its source bundle is rejected', () => {
    install.internals.SOURCE = root;
    throwsMatching(() => install.checked_prefix(path.join(root, 'nested-prefix')), /outside/);
  });

  it('missing installed app fails before prefix writes', () => {
    const prefix = path.join(root, 'lcu');
    installedApp.internals.default_app_path = path.join(root, 'missing-chatgpt');
    throwsMatching(() => installedApp.select('arm64', { execute: false }), /chatgpt\.com\/download\//);
    assert.equal(fs.existsSync(prefix), false);
  });

  it('missing installed app fails before apt or prefix writes', async () => {
    const prefix = path.join(root, 'lcu');
    const missing = path.join(root, 'missing-chatgpt');
    installedApp.internals.default_app_path = missing;
    install.internals.default_app_path = () => missing;
    install.internals.setup.validate = () => [null, []];
    install.internals.architecture = () => 'arm64';
    install.internals.verify = () => {};
    install.internals.run = () => { throw new Error('apt/network reached'); };
    await rejectsMatching(() => install.main(['--prefix', prefix, '--runtime-only', '--session', 'discover']), /chatgpt\.com\/download\//);
    assert.equal(fs.existsSync(prefix), false);
  });

  it('--app-package fails with the --existing-app migration before writes', async () => {
    const prefix = path.join(root, 'lcu');
    install.internals.run = () => { throw new Error('apt/network reached'); };
    await rejectsMatching(() => install.main(['--prefix', prefix, '--runtime-only', '--app-package', path.join(root, 'chatgpt.deb')]),
      /--app-package cannot install.*--existing-app PATH/);
    assert.equal(fs.existsSync(prefix), false);
  });

  const agentSetup = (returncode) => {
    const home = path.join(root, 'account');
    fs.mkdirSync(home);
    const existing = path.join(root, 'chatgpt');
    fs.mkdirSync(existing);
    const account = { pw_name: 'fixture', pw_uid: 1001, pw_dir: home };
    setupImpl.platform = 'linux'; // the Linux parser defaults (--session discover)
    const calls = [];
    install.internals.default_app_path = () => existing;
    install.internals.setup.validate = () => [account, ['pi']];
    install.internals.architecture = () => 'arm64';
    install.internals.verify = () => {};
    install.internals.select_app = () => {};
    install.internals.install = () => {};
    install.internals.setup.installer_environment = () => {};
    install.internals.run = (command, options) => { calls.push([command, options]); return { returncode }; };
    return { existing, calls };
  };

  it('linux installer forwards the audio opt-in to agent setup', async () => {
    const { existing, calls } = agentSetup(0);
    capture();
    await install.main(['--prefix', path.join(root, 'lcu'), '--existing-app', existing, '--agent', 'pi', '--audio', '--yes', '--skip-system']);
    const command = calls.at(-1)[0];
    assert.ok(command.includes('--audio'));
    assert.ok(command.includes('--agent'));
    assert.ok(command.includes('pi'));
    assert.deepEqual(command, [path.join(root, 'lcu/current/bin/lcu'), 'setup', '--prefix', path.join(root, 'lcu'),
      '--user', 'fixture', '--scope', 'user', '--session', 'discover', '--agent', 'pi', '--yes', '--audio']);
    assert.equal(calls.at(-1)[1].check, false);
  });

  it('linux installer reports the runtime path when agent registration fails', async () => {
    const { existing } = agentSetup(5);
    const out = capture();
    await assert.rejects(() => install.main(['--prefix', path.join(root, 'lcu'), '--existing-app', existing, '--agent', 'pi', '--yes', '--skip-system']),
      (error) => error instanceof install.SystemExit && error.code === 5);
    assert.match(out.stderr, /setup failed; see the errors above/);
    assert.ok(out.stderr.includes(path.join(root, 'lcu', 'current/bin/lcu')));
    assert.equal(out.stdout, `LCU installed: ${path.join(root, 'lcu')}/current/bin/lcu\n`);
    assert.equal(await install.run_main(['--prefix', path.join(root, 'lcu'), '--existing-app', existing, '--agent', 'pi', '--yes', '--skip-system']), 5);
  });

  it('existing app is selected in place with its actual versions', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'), { relocated: true });
    const [application, descriptor] = installedApp.select('arm64', { existing_app: app, execute: false });
    assert.equal(application, fs.realpathSync(app));
    assert.deepEqual(descriptor, { package_version: '26.924.22138', runtime: 'runtime-new', architecture: 'arm64' });
  });

  it('install links the installed app without copying it', () => {
    const prefix = path.join(root, 'lcu');
    const app = applicationFixture(path.join(root, 'chatgpt'));
    const source = bundle(root);
    install.internals.SOURCE = source;
    install.internals.architecture = () => 'arm64';
    install.internals.validate_release = () => {};
    install.internals.select_app = (arch, options) => installedApp.select(arch, { ...options, execute: false });
    const release = install.install(prefix, { existing_app: app });
    assert.equal(fs.readlinkSync(path.join(release, 'app')), fs.realpathSync(app));
    const text = fs.readFileSync(path.join(release, 'installation.json'), 'utf8');
    assert.equal(text, `${dumps(new Map([['package_version', '26.924.22138'], ['runtime', 'runtime-new'], ['architecture', 'arm64'], ['app', fs.realpathSync(app)]]), { indent: 2 })}\n`);
    assert.equal(fs.existsSync(path.join(prefix, 'apps')), false);
    assert.equal(fs.existsSync(path.join(prefix, 'cache')), false);
    assert.equal(fs.realpathSync(path.join(prefix, 'current')), fs.realpathSync(release));
    assert.equal(fs.readlinkSync(path.join(prefix, 'current')), `releases/${path.basename(release)}`);
    assert.match(path.basename(release), new RegExp(`^${VERSION.replaceAll('.', '\\.')}-[0-9a-f]{12}$`));
    // copytree kept the archive's modes and contents (verify() of the copy passed) and times.
    // (utimes takes float seconds: sub-microsecond precision is not carried over; see the port notes.)
    assert.ok(Math.abs(fs.statSync(path.join(release, 'payload')).mtimeMs - fs.statSync(path.join(source, 'payload')).mtimeMs) < 0.01);
  });

  it('failed upgrade preserves the active release', () => {
    const prefix = path.join(root, 'lcu');
    const old = previousRelease(prefix);
    install.internals.SOURCE = bundle(root);
    install.internals.architecture = () => 'arm64';
    const application = path.join(root, 'chatgpt');
    fs.mkdirSync(application);
    install.internals.select_app = () => selected(application);
    install.internals.validate_release = () => { throw new ValueError('runtime validation failed'); };
    throwsMatching(() => install.install(prefix, { existing_app: application }), /runtime validation failed/);
    assert.equal(fs.readFileSync(path.join(prefix, 'current/data'), 'utf8'), 'previous version');
    assert.deepEqual(fs.readdirSync(path.join(prefix, 'releases')).map((n) => path.join(prefix, 'releases', n)), [old]);
    assert.deepEqual(fs.readdirSync(prefix).filter((n) => n.startsWith('.build-')), []);
  });

  it('simultaneous installs to the same prefix serialize release switches (two processes, flock)', async () => {
    const prefix = path.join(root, 'lcu');
    previousRelease(prefix);
    const source = bundle(root);
    const application = path.join(root, 'chatgpt');
    fs.mkdirSync(application);
    const marks = path.join(root, 'marks');
    fs.mkdirSync(marks);
    const child = `
      import fs from 'node:fs';
      import * as install from ${JSON.stringify(path.join(ROOT, 'scripts/install.mjs'))};
      const [source, application, prefix, marks] = process.argv.slice(1);
      install.internals.SOURCE = source;
      install.internals.architecture = () => 'arm64';
      install.internals.select_app = () => [application, { package_version: '26.924.22138', runtime: 'runtime-new', architecture: 'arm64' }];
      install.internals.validate_release = () => {
        const mine = marks + '/' + process.pid;
        if (fs.readdirSync(marks).length) fs.writeFileSync(marks + '.overlap', '');
        fs.writeFileSync(mine, '');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        fs.unlinkSync(mine);
      };
      install.install(prefix, { existing_app: application });
    `;
    const runs = [0, 1].map(() => new Promise((resolve) => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', child, source, application, prefix, marks], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('close', (code) => resolve({ code, stderr }));
    }));
    const results = await Promise.all(runs);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.existsSync(`${marks}.overlap`), false);
    assert.equal(fs.readFileSync(path.join(prefix, 'current/payload'), 'utf8'), 'new version');
    assert.equal(fs.readdirSync(path.join(prefix, 'releases')).length, 3);
  });

  it('dependency acquisition failure preserves the active release', async () => {
    const prefix = path.join(root, 'lcu');
    const existing = path.join(root, 'chatgpt');
    fs.mkdirSync(existing);
    const old = previousRelease(prefix);
    const calls = [];
    install.internals.default_app_path = () => existing;
    install.internals.setup.validate = () => [null, []];
    install.internals.checked_prefix = () => prefix;
    install.internals.architecture = () => 'arm64';
    install.internals.verify = () => {};
    install.internals.select_app = () => {};
    install.internals.getuid = () => 0;
    install.internals.which = () => '/usr/bin/apt-get';
    install.internals.run = (command) => {
      calls.push(command);
      if (calls.length === 2) throw new CalledProcessError(100, ['apt-get', 'install']);
      return { returncode: 0 };
    };
    install.internals.install = () => { throw new Error('release install reached'); };
    await rejectsMatching(() => install.main(['--prefix', prefix, '--runtime-only', '--session', 'discover']), /returned non-zero exit status 100/, 'CalledProcessError');
    assert.deepEqual(calls[0], ['apt-get', 'update']);
    assert.deepEqual(calls[1].slice(0, 3), ['apt-get', 'install', '-y']);
    assert.ok(calls[1].includes('acl'), 'acl provides getfacl for the Node trust checks');
    assert.equal(fs.readFileSync(path.join(prefix, 'current/data'), 'utf8'), 'previous version');
    assert.deepEqual(fs.readdirSync(path.join(prefix, 'releases')).map((n) => path.join(prefix, 'releases', n)), [old]);
    const out = capture();
    calls.length = 0;
    assert.equal(await install.run_main(['--prefix', prefix, '--runtime-only', '--session', 'discover']), 1);
    assert.equal(out.stderr, "LCU installer: Command '['apt-get', 'install']' returned non-zero exit status 100.\n");
  });

  it('unexpected .next symlink preserves the active release', () => {
    const prefix = path.join(root, 'lcu');
    const old = previousRelease(prefix);
    const conflict = path.join(root, 'conflict');
    fs.mkdirSync(conflict);
    fs.symlinkSync(conflict, path.join(prefix, '.next'));
    install.internals.SOURCE = bundle(root);
    install.internals.architecture = () => 'arm64';
    const application = path.join(root, 'chatgpt');
    fs.mkdirSync(application);
    install.internals.select_app = () => selected(application);
    install.internals.validate_release = () => {};
    throwsMatching(() => install.install(prefix, { existing_app: application }), /Unexpected \.next path/);
    assert.equal(fs.readFileSync(path.join(prefix, 'current/data'), 'utf8'), 'previous version');
    assert.ok(fs.lstatSync(path.join(prefix, '.next')).isSymbolicLink());
    assert.deepEqual(fs.readdirSync(path.join(prefix, 'releases')).map((n) => path.join(prefix, 'releases', n)), [old]);
  });

  // New cases (no Python counterpart: validate_release was always mocked).
  it('validate_release runs the version probe, the REPL probe and the platform probe as Python did', () => {
    const release = path.join(root, 'release');
    fs.mkdirSync(release);
    fs.writeFileSync(path.join(release, 'installation.json'), '{"platform": "darwin"}');
    const calls = [];
    install.internals.setup.installed_app_resources = () => '/app/res';
    install.internals.run = (command, options) => { calls.push([command, { ...options, env: { ...options.env } }]); return { returncode: 0 }; };
    install.validate_release(release);
    assert.deepEqual(calls.map(([command]) => command.slice(0, 2)), [
      [`${release}/bin/lcu`, '--version'], ['/app/res/cua_node/bin/node_repl', '--help'],
      ['/app/res/cua_node/bin/node', '--input-type=module']]);
    assert.equal(calls[2][0][4], 'file:///app/res/cua_node/lib/node_modules/%40oai/sky/dist/project/cua/sky_js/src/service.js'); // Path.as_uri() quotes '@'
    assert.equal(calls[2][0][5], 'mac');
    assert.equal(calls[1][1].stdout, 'devnull');
    assert.equal(calls[0][1].timeout, 20000);
    assert.equal(calls[0][1].env.NODE_REPL_DISABLE_ANALYTICS, undefined);
    assert.equal(calls[2][1].env.NODE_REPL_DISABLE_ANALYTICS, '1');
    install.internals.getuid = () => 4242;
    throwsMatching(() => install.validate_release(release, { pw_name: 'other', pw_uid: 1, pw_gid: 1, pw_dir: root }),
      /^Cannot validate the installation as other from this account$/);
  });

  it('installed_app._run_as refuses another account unless running as root, and drops privileges as root', () => {
    const calls = [];
    installedApp.internals.runProcess = (command, options) => { calls.push(options); return { returncode: 0 }; };
    installedApp.internals.getuid = () => 4242;
    const account = { pw_name: 'alice', pw_uid: 1000, pw_gid: 1000, pw_dir: '/home/alice' };
    throwsMatching(() => installedApp._run_as(['x'], account), /^Cannot validate the application as alice from this account$/);
    installedApp.internals.getuid = () => 0;
    installedApp._run_as(['x'], account, { check: true });
    assert.equal(calls[0].account, account);
    assert.equal(calls[0].cwd, '/home/alice');
    assert.equal(calls[0].env.HOME, '/home/alice');
    assert.equal(calls[0].env.LOGNAME, 'alice');
  });

  it('SYSTEM_PACKAGES keeps the Python list and adds acl', () => {
    const python = fs.readFileSync(path.join(ORACLE_ROOT, 'scripts/install.py'), 'utf8');
    const listed = [...python.slice(python.indexOf('SYSTEM_PACKAGES = ('), python.indexOf(')\n', python.indexOf('SYSTEM_PACKAGES = (')))
      .matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(install.SYSTEM_PACKAGES.filter((name) => name !== 'acl'), listed);
    assert.ok(install.SYSTEM_PACKAGES.includes('acl'));
  });
});

describe('BundleTests (install-time half)', () => {
  let base; let rootDir; let binary;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-bundle-')));
    rootDir = path.join(base, 'bundle');
    fs.mkdirSync(path.join(rootDir, 'runtime/bin'), { recursive: true });
    binary = path.join(rootDir, 'runtime/bin/node');
    fs.writeFileSync(binary, 'fixture binary');
    fs.chmodSync(binary, 0o755);
    fs.symlinkSync('node', path.join(rootDir, 'runtime/bin/alias'));
    seal(rootDir, 'arm64');
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

  it('VERSION matches scripts/bundle.py (the build and the Windows bridge still read that one)', () => {
    assert.match(fs.readFileSync(path.join(ROOT, 'scripts/bundle.py'), 'utf8'), new RegExp(`^VERSION = '${VERSION.replaceAll('.', '\\.')}'$`, 'm'));
  });
  it('file after symlink still records mode', () => {
    const files = inventory(rootDir, 'linux');
    assert.equal(files.get('runtime/bin/alias').get('type'), 'symlink');
    assert.ok(files.get('runtime/bin/node').has('mode'));
  });
  it('relocated bundle verifies', () => {
    const moved = path.join(base, 'moved');
    fs.renameSync(rootDir, moved);
    verify(moved, 'arm64');
  });
  it('modified file is rejected', () => {
    fs.writeFileSync(binary, 'corrupted binary');
    throwsMatching(() => verify(rootDir, 'arm64'), /integrity/);
  });
  it('missing file is rejected', () => {
    fs.unlinkSync(binary);
    assert.throws(() => verify(rootDir, 'arm64'));
  });
  it('injected module is rejected', () => {
    fs.writeFileSync(path.join(rootDir, 'runtime/unexpected.js'), 'unexpected code');
    throwsMatching(() => verify(rootDir, 'arm64'), /integrity/);
  });
  it('wrong architecture is rejected', () => {
    throwsMatching(() => verify(rootDir, 'x64'), /architecture/);
  });
  it('invalid manifest shape is rejected', () => {
    fs.writeFileSync(path.join(rootDir, 'bundle.json'), '[]');
    throwsMatching(() => verify(rootDir, 'arm64'), /manifest/);
  });
  it('missing payload does not download', () => {
    fs.unlinkSync(path.join(rootDir, 'bundle.json'));
    throwsMatching(() => verify(rootDir, 'arm64'), /release bundle/);
  });
  it('escaping symlink is rejected', () => {
    const alias = path.join(rootDir, 'runtime/bin/alias');
    fs.unlinkSync(alias);
    fs.symlinkSync('/bin/sh', alias);
    throwsMatching(() => verify(rootDir, 'arm64'), /symlink/);
  });
  it('executable bit change is rejected', () => {
    fs.chmodSync(binary, 0o644);
    throwsMatching(() => verify(rootDir, 'arm64'), /integrity/);
  });
  it('windows bundles ignore Unix modes but keep byte integrity', () => {
    // (Python: a ZIP round trip; the ZIP step only drops the executable bit, reproduced with chmod.)
    const windows = path.join(base, 'windows');
    fs.mkdirSync(path.join(windows, 'bin'), { recursive: true });
    const launcher = path.join(windows, 'bin/lcu.cmd');
    fs.writeFileSync(launcher, 'fixture launcher\r\n');
    fs.chmodSync(launcher, 0o755);
    seal(windows, 'x64', 'windows');
    fs.chmodSync(launcher, 0o644);
    verify(windows, 'x64', 'windows');
    fs.writeFileSync(launcher, 'tampered\r\n');
    throwsMatching(() => verify(windows, 'x64', 'windows'), /integrity/);
  });
  it('bundle rejects the other platform', () => {
    const darwin = path.join(base, 'darwin');
    fs.mkdirSync(darwin);
    seal(darwin, 'arm64', 'darwin');
    verify(darwin, 'arm64', 'darwin');
    throwsMatching(() => verify(darwin, 'arm64', 'linux'), /manifest/);
  });
  it('a Python-sealed manifest is accepted by the Node verify', () => {
    const result = (await_python(rootDir));
    if (result === null) return;
    verify(rootDir, 'arm64');
    assert.equal(loads(fs.readFileSync(path.join(rootDir, 'bundle.json'), 'utf8')).get('version'), VERSION);
  });
});

function await_python(rootDir) {
  const { spawnSync } = process.getBuiltinModule('node:child_process');
  const result = spawnSync('python3', ['-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts'))}); from bundle import seal; from pathlib import Path; seal(Path(${JSON.stringify(rootDir)}), 'arm64')`], { encoding: 'utf8' });
  if (result.error) return null;
  assert.equal(result.status, 0, result.stderr);
  return true;
}
