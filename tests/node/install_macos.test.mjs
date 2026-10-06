// Port of tests/test_macos_installation.py for scripts/install_macos.mjs (selection without changing or executing
// an application).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { io } from '../../lcu/compat/argparse.mjs';
import { seal as hashSeal } from '../../lcu/compat/hash.mjs';
import { loads, ValueError } from '../../lcu/compat/pyjson.mjs';
import * as install from '../../scripts/install.mjs';
import * as installMacos from '../../scripts/install_macos.mjs';
import { verify, VERSION } from '../../scripts/bundle_runtime.mjs';

const savedMac = { ...installMacos.internals, setup: { ...installMacos.internals.setup } };
const savedInstall = { ...install.internals };
const savedIo = { ...io };
afterEach(() => {
  Object.assign(installMacos.internals, savedMac, { setup: { ...savedMac.setup } });
  Object.assign(install.internals, savedInstall);
  Object.assign(io, savedIo);
});

const rejectsMatching = (fn, pattern, name = 'ValueError') => assert.rejects(fn, (error) => {
  if (name) assert.equal(error?.name, name, `${error?.name}: ${error?.message}`);
  assert.match(error.message, pattern);
  return true;
});
const throwsMatching = (fn, pattern) => assert.throws(fn, (error) => {
  assert.match(error.message, pattern);
  return true;
});

describe('MacInstallationTests', () => {
  let base; let source; let app; let prefix;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-mac-')));
    source = path.join(base, 'source');
    fs.mkdirSync(source);
    app = path.join(base, 'ChatGPT.app');
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'preserve'), 'original signed application');
    fs.writeFileSync(path.join(source, 'runtime.lock.json'), JSON.stringify({ platforms: { darwin: {
      version: 'fixture', runtime: 'fixture-runtime', architectures: { arm64: { components: {} } } } } }));
    hashSeal(source, VERSION, 'arm64', 'darwin');
    prefix = path.join(base, 'lcu');
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  const patchApp = (resolver) => {
    installMacos.internals.SOURCE = source;
    installMacos.internals.architecture = () => 'arm64';
    installMacos.internals.resolve_installed_mac_app = resolver ?? (() => ({
      app, version: '26.924.22138', runtime_version: '0.0.24/20260924074400-f52ea85e2a98', arch: 'arm64',
    }));
  };

  it('reuses the app in place and records the observed version and runtime', () => {
    const validations = [];
    install.internals.validate_release = (...args) => validations.push(args);
    patchApp();
    const release = installMacos.install(prefix, app);
    assert.equal(fs.realpathSync(path.join(prefix, 'current')), release);
    assert.equal(fs.realpathSync(path.join(release, 'app')), app);
    assert.equal(fs.readFileSync(path.join(app, 'preserve'), 'utf8'), 'original signed application');
    const text = fs.readFileSync(path.join(release, 'installation.json'), 'utf8');
    const descriptor = loads(text);
    assert.deepEqual([...descriptor.keys()], ['platform', 'architecture', 'package_version', 'runtime', 'app']);
    assert.equal(descriptor.get('platform'), 'darwin');
    assert.equal(descriptor.get('app'), app);
    assert.equal(descriptor.get('package_version'), '26.924.22138');
    assert.equal(descriptor.get('runtime'), '0.0.24/20260924074400-f52ea85e2a98');
    assert.deepEqual(validations, [[release, null]]);
  });

  it('invalid application fails before the prefix or selection changes', () => {
    patchApp(() => { throw new ValueError('invalid application'); });
    throwsMatching(() => installMacos.install(prefix, app), /invalid application/);
    assert.equal(fs.existsSync(prefix), false);
  });

  it('missing application has the official download link before prefix writes', () => {
    patchApp(() => { throw new Error('app validation reached'); });
    throwsMatching(() => installMacos.install(prefix, path.join(base, 'missing.app')), /chatgpt\.com\/download\//);
    assert.equal(fs.existsSync(prefix), false);
  });

  it('failed validation preserves the previous selection', () => {
    patchApp();
    install.internals.validate_release = () => {};
    const previous = installMacos.install(prefix, app);
    install.internals.validate_release = () => { throw new ValueError('startup failed'); };
    throwsMatching(() => installMacos.install(prefix, app), /startup failed/);
    assert.equal(fs.realpathSync(path.join(prefix, 'current')), previous);
    assert.deepEqual(fs.readdirSync(path.join(prefix, 'releases')).map((n) => path.join(prefix, 'releases', n)), [previous]);
    assert.equal(fs.readFileSync(path.join(app, 'preserve'), 'utf8'), 'original signed application');
  });

  it('agent setup return code is preserved after install', async () => {
    const account = { pw_name: 'alice' };
    const installs = [];
    const runs = [];
    installMacos.internals.setup.validate = () => [account, ['codex']];
    installMacos.internals.install = (...args) => installs.push(args);
    installMacos.internals.run = (command, options) => { runs.push([command, options]); return { returncode: 7 }; };
    let stdout = '';
    let stderr = '';
    io.stdout = (text) => { stdout += text; };
    io.stderr = (text) => { stderr += text; };
    await assert.rejects(() => installMacos.main(['--prefix', prefix, '--existing-app', app, '--agent', 'codex', '--audio', '--yes']),
      (error) => error instanceof install.SystemExit && error.code === 7);
    assert.equal(installs.length, 1);
    assert.equal(String(installs[0][0]), prefix);
    assert.equal(String(installs[0][1]), app);
    assert.deepEqual(installs[0][2], { account });
    assert.deepEqual(runs[0][0], [path.join(prefix, 'current/bin/lcu'), 'setup', '--prefix', prefix, '--user', 'alice',
      '--scope', 'user', '--session', 'direct', '--agent', 'codex', '--yes', '--audio']);
    assert.equal(runs[0][1].check, false);
    assert.equal(stdout, `LCU installed: ${prefix}/current/bin/lcu\nThe signed application is reused in place. Compatible updates are detected automatically.\n`);
    assert.match(stderr, /^LCU runtime installed at .*, but setup failed; see the errors above\. After resolving the errors, retry: .* setup --prefix /);
  });

  it('bundle rejects the other platform', () => {
    verify(source, 'arm64', 'darwin');
    throwsMatching(() => verify(source, 'arm64', 'linux'), /manifest/);
  });

  // New: the macOS-only refusals that precede any write.
  it('rejects --session discover and --reconcile with the Python messages', async () => {
    installMacos.internals.setup.validate = () => [{ pw_name: 'alice' }, []];
    await rejectsMatching(() => installMacos.main(['--prefix', prefix, '--session', 'discover', '--runtime-only']),
      /^macOS uses --session direct; XFCE session discovery is Linux-only$/);
    await rejectsMatching(() => installMacos.main(['--prefix', prefix, '--reconcile']), /^--reconcile runs after installation/);
    await rejectsMatching(() => installMacos.main(['--prefix', prefix, '--runtime-only', '--chrome']),
      /^--runtime-only cannot include agent setup options$/);
    assert.equal(fs.existsSync(prefix), false);
  });
});
