// Port of the Node-side cases of tests/test_build_windows.py and tests/test_windows_setup.py for
// scripts/install_windows.mjs and scripts/windows_launcher.mjs (fixtures only; no live Windows claim).
// The private copy itself is made by the Python bridge (tests/test_windows_bridge.py); here a generation is laid
// out the way the bridge publishes it. lcu.windows is replaced by a fixture double (`internals.windows`).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { io, PySystemExit } from '../../lcu/compat/argparse.mjs';
import { applicationInventory, inventorySha256 } from '../../lcu/compat/hash.mjs';
import { dumps, loads, ValueError } from '../../lcu/compat/pyjson.mjs';
import { ALIASES, CLIENTS } from '../../lcu/setup_clients.mjs';
import * as installWindows from '../../scripts/install_windows.mjs';
import * as launcher from '../../scripts/windows_launcher.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const saved = { ...installWindows.internals };
const savedIo = { ...io };
afterEach(() => {
  Object.assign(installWindows.internals, saved);
  Object.assign(io, savedIo);
});

const throwsMatching = (fn, pattern) => assert.throws(fn, (error) => {
  assert.match(error.message, pattern);
  return true;
});

// Fixture double of lcu/windows.mjs: identity/runtime manifests and exact inventory equality.
const fakeWindows = {
  _appx_identity(app) {
    const text = fs.readFileSync(path.join(app, 'AppxManifest.xml'), 'utf8');
    return ['OpenAI.Codex', 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B', /Version="([^"]+)"/.exec(text)[1], 'x64'];
  },
  _runtime_manifest(app) {
    return loads(fs.readFileSync(path.join(app, 'app/resources/cua_node/manifest.json'), 'utf8'));
  },
  validate_windows_app_tree(app, { expected_version, expected_runtime, expected_inventory }) {
    const actual = applicationInventory(app);
    const keys = [...new Set([...actual.keys(), ...expected_inventory.keys()])].sort();
    const first = keys.find((key) => dumps(actual.get(key) ?? null, { sort_keys: true }) !== dumps(expected_inventory.get(key) ?? null, { sort_keys: true }));
    if (first !== undefined) throw new ValueError(`Windows application differs from selected source inventory: ${first}`);
    return { app, version: expected_version, runtime_version: expected_runtime };
  },
};

function officialApp(base) {
  const official = path.join(base, 'official-app');
  fs.mkdirSync(official);
  fs.writeFileSync(path.join(official, 'AppxManifest.xml'), '<Package><Identity Name="OpenAI.Codex" '
    + 'Publisher="CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B" Version="27.100.1.0" ProcessorArchitecture="x64"/></Package>');
  for (const relative of ['app/ChatGPT.exe', 'app/resources/cua_node/bin/node.exe', 'app/resources/cua_node/manifest.json']) {
    const file = path.join(official, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative.endsWith('manifest.json')
      ? JSON.stringify({ platform: 'windows', arch: 'x64', runtime_archive_version: 'runtime-fixture' }) : relative);
  }
  fs.writeFileSync(path.join(official, 'app/resources/NOTICE.txt'), 'original notice');
  return official;
}

/** What the bridge leaves behind: <prefix>/apps/<digest>/{app, inventory.json} and the marker. */
function publishGeneration(prefix, official) {
  const inventory = applicationInventory(official);
  const digest = inventorySha256(inventory);
  const generation = path.join(prefix, 'apps', digest);
  fs.mkdirSync(generation, { recursive: true });
  fs.cpSync(official, path.join(generation, 'app'), { recursive: true });
  fs.writeFileSync(path.join(generation, 'inventory.json'), `${dumps(inventory, { sort_keys: true, separators: [',', ':'] })}\n`);
  fs.writeFileSync(path.join(prefix, '.lcu-install'), '');
  return { generation, digest, inventory };
}

describe('WindowsInstallerTests', () => {
  let base; let source; let prefix;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-win-')));
    source = path.join(base, 'archive');
    fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(source, 'scripts/windows_launcher.py'), 'fixture');
    fs.writeFileSync(path.join(source, 'scripts/windows_launcher.mjs'), 'fixture dispatcher');
    fs.writeFileSync(path.join(source, 'runtime.lock.json'), JSON.stringify({ platforms: { windows: {
      version: '26.917.9434.0', runtime: 'old-runtime',
      architectures: { x64: { sha256: 'a'.repeat(64), components: { 'app/resources/app.asar': 'b'.repeat(64) } } } } } }));
    prefix = path.join(base, 'installed');
    fs.mkdirSync(prefix);
    Object.assign(installWindows.internals, {
      SOURCE: source, platform: () => 'win32', architecture: () => 'x64', verify: () => {},
      checked_prefix: () => prefix, windows: fakeWindows, materialize_original_host: () => {}, paths: () => {},
    });
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('windows installer forwards the audio option to shared setup', () => {
    const release = path.join(base, 'release');
    const installs = [];
    const runs = [];
    installWindows.internals.install = (...args) => { installs.push(args); return release; };
    installWindows.internals.run = (command, options) => { runs.push([command, options]); return { returncode: 0 }; };
    installWindows.internals.execPath = () => 'C:\\LCU\\apps\\x\\node.exe';
    let stdout = '';
    io.stdout = (text) => { stdout += text; };
    const savedEnv = { ...process.env };
    process.env.NODE_OPTIONS = '--require /evil.cjs';
    try {
      installWindows.main(['--app-generation', path.join(prefix, 'apps/x'), '--legacy-python', 'C:\\Py\\python.exe',
        '--prefix', prefix, '--agent', 'pi', '--audio', '--yes']);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }
    assert.equal(String(installs[0][0]), prefix);
    assert.equal(installs[0][1].legacy_python, 'C:\\Py\\python.exe');
    // Review R4: the setup child's Node starts with the startup variables quarantined (entry.mjs restores them).
    assert.equal(runs[0][1].env.NODE_OPTIONS, undefined);
    assert.ok(runs[0][1].env.__LCU_Q.split(',').includes('NODE_OPTIONS'));
    assert.equal(runs[0][1].env.__LCU_Q_NODE_OPTIONS, '--require /evil.cjs');
    const command = runs[0][0];
    assert.ok(command.includes('--audio') && command.includes('--agent') && command.includes('pi'));
    assert.deepEqual(command, ['C:\\LCU\\apps\\x\\node.exe', path.join(release, 'lcu/entry.mjs'), 'lcu', 'setup',
      '--prefix', prefix, '--session', 'direct', '--scope', 'user', '--agent', 'pi', '--audio', '--yes']);
    assert.equal(runs[0][1].check, true);
    assert.equal(stdout, `LCU installed: ${path.join(prefix, 'lcu.cmd')}\n`);
  });

  it('argument errors exit 2 with the Python messages before any install', () => {
    let stderr = '';
    io.stderr = (text) => { stderr += text; };
    io.exit = (status) => { throw new PySystemExit(status); };
    installWindows.internals.install = () => { throw new Error('install reached'); };
    assert.throws(() => installWindows.main(['--runtime-only', '--agent', 'codex']), (e) => e.status === 2);
    assert.match(stderr, /install_windows\.py: error: --runtime-only cannot include agent setup options\n$/);
    stderr = '';
    assert.throws(() => installWindows.main([]), (e) => e.status === 2);
    assert.match(stderr, /error: Choose --agent NAME or --runtime-only\. Agents: codex, claude-code, pi, omp, hermes\n$/);
  });

  it('installer requires the generation the bridge prepared and validates where it lives', () => {
    throwsMatching(() => installWindows.install(prefix), /Run scripts\/install_windows\.py/);
    const official = officialApp(base);
    const { generation } = publishGeneration(prefix, official);
    const elsewhere = path.join(base, 'elsewhere', path.basename(generation));
    fs.mkdirSync(path.dirname(elsewhere));
    fs.cpSync(generation, elsewhere, { recursive: true });
    throwsMatching(() => installWindows.install(prefix, { app_generation: elsewhere }), /does not belong to this installation/);
    fs.writeFileSync(path.join(generation, 'inventory.json'), '{"x": 1}\n');
    throwsMatching(() => installWindows.install(prefix, { app_generation: generation }), /^Managed Windows application inventory differs from the selected Store app\.$/);
    fs.writeFileSync(path.join(generation, 'inventory.json'), 'not json');
    throwsMatching(() => installWindows.install(prefix, { app_generation: generation }), /^Managed Windows application inventory is missing or invalid\.$/);
    assert.equal(fs.existsSync(path.join(prefix, 'releases')), false);
  });

  it('installer publishes from the private generation and keeps current on every failure', () => {
    const official = officialApp(base);
    const { generation, digest, inventory } = publishGeneration(prefix, official);
    const app = path.join(generation, 'app');
    installWindows.install(prefix, { app_generation: generation });
    const descriptor = loads(fs.readFileSync(path.join(prefix, 'current.json'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(prefix, 'current.json'), 'utf8'), `{"release": "${descriptor.get('release')}"}\n`);
    const release = path.join(prefix, 'releases', descriptor.get('release'));
    const installed = loads(fs.readFileSync(path.join(release, 'installation.json'), 'utf8'));
    assert.deepEqual([...installed.keys()], ['platform', 'architecture', 'app', 'package_version', 'runtime', 'sha256']);
    assert.equal(path.dirname(installed.get('app')), path.join(prefix, 'apps', digest));
    assert.deepEqual([installed.get('package_version'), installed.get('runtime'), installed.get('sha256')], ['27.100.1.0', 'runtime-fixture', digest]);
    assert.equal(dumps(loads(fs.readFileSync(path.join(generation, 'inventory.json'), 'utf8')), { sort_keys: true }), dumps(inventory, { sort_keys: true }));
    assert.equal(fs.readFileSync(path.join(app, 'app/resources/NOTICE.txt'), 'utf8'), 'original notice');
    // Launchers: the Node dispatcher, the Python compat trampoline, lcu.cmd and launcher.json.
    const command = fs.readFileSync(path.join(prefix, 'lcu.cmd'));
    const nodeExe = path.join(app, 'app/resources/cua_node/bin/node.exe');
    assert.equal(command.toString(), installWindows.command_file_text({
      prefix, generation, node: nodeExe, sha256: inventory.get('app/resources/cua_node/bin/node.exe').get('sha256') }));
    assert.equal(command.includes(Buffer.from('\r\r\n')), false);
    assert.equal(command.toString().split('\r\n').every((line, i, all) => i === all.length - 1 || !line.includes('\n')), true);
    assert.equal(fs.readFileSync(path.join(prefix, 'windows_launcher.mjs'), 'utf8'), 'fixture dispatcher');
    assert.equal(fs.readFileSync(path.join(prefix, 'windows_launcher.py'), 'utf8'), 'fixture');
    const pair = loads(fs.readFileSync(path.join(prefix, 'launcher.json'), 'utf8'));
    assert.equal(pair.get('node'), path.join(app, 'app/resources/cua_node/bin/node.exe'));
    assert.equal(pair.get('dispatcher'), path.join(prefix, 'windows_launcher.mjs'));
    // Reinstall reuses the same generation.
    installWindows.install(prefix, { app_generation: generation });
    const second = loads(fs.readFileSync(path.join(prefix, 'current.json'), 'utf8'));
    const secondRelease = path.join(prefix, 'releases', second.get('release'));
    assert.equal(loads(fs.readFileSync(path.join(secondRelease, 'installation.json'), 'utf8')).get('app'), app);
    const currentText = fs.readFileSync(path.join(prefix, 'current.json'), 'utf8');
    const launcherBefore = fs.readFileSync(path.join(prefix, 'windows_launcher.py'));
    const commandBefore = fs.readFileSync(path.join(prefix, 'lcu.cmd'));
    const releasesBefore = fs.readdirSync(path.join(prefix, 'releases')).sort();
    // A locked launcher: nothing is published, the release is removed.
    let atomicCalls = 0;
    installWindows.internals.atomic_bytes = () => { atomicCalls += 1; throw Object.assign(new Error('launcher locked'), { name: 'OSError' }); };
    throwsMatching(() => installWindows.install(prefix, { app_generation: generation }), /launcher locked/);
    assert.equal(atomicCalls, 1);
    installWindows.internals.atomic_bytes = saved.atomic_bytes;
    assert.deepEqual(fs.readdirSync(path.join(prefix, 'releases')).sort(), releasesBefore);
    assert.equal(fs.readFileSync(path.join(prefix, 'current.json'), 'utf8'), currentText);
    // A blocked pointer: the launchers are restored byte for byte.
    fs.writeFileSync(path.join(source, 'scripts/windows_launcher.py'), 'new launcher');
    installWindows.internals.replace = (from, to) => {
      if (to === path.join(prefix, 'current.json')) throw Object.assign(new Error('pointer blocked'), { name: 'OSError' });
      return fs.renameSync(from, to);
    };
    throwsMatching(() => installWindows.install(prefix, { app_generation: generation }), /pointer blocked/);
    installWindows.internals.replace = saved.replace;
    assert.equal(fs.readFileSync(path.join(prefix, 'current.json'), 'utf8'), currentText);
    assert.deepEqual(fs.readFileSync(path.join(prefix, 'windows_launcher.py')), launcherBefore);
    assert.deepEqual(fs.readFileSync(path.join(prefix, 'lcu.cmd')), commandBefore);
    assert.deepEqual(fs.readdirSync(prefix).filter((n) => n.endsWith('.tmp') || n.startsWith('.current-')), []);
    fs.writeFileSync(path.join(source, 'scripts/windows_launcher.py'), 'fixture');
    // An invalid copy: current and the generation stay.
    installWindows.internals.validated_copy = () => { throw new ValueError('copied bytes changed'); };
    throwsMatching(() => installWindows.install(prefix, { app_generation: generation }), /copied bytes changed/);
    installWindows.internals.validated_copy = saved.validated_copy;
    assert.deepEqual(fs.readdirSync(path.join(prefix, 'apps')), [digest]);
    assert.equal(fs.readFileSync(path.join(prefix, 'current.json'), 'utf8'), currentText);
    // A tampered copy is refused by the full re-validation.
    fs.writeFileSync(path.join(app, 'app/resources/cua_node/bin/node.exe'), 'tampered');
    throwsMatching(() => installWindows.install(prefix, { app_generation: generation }), /differs from selected source inventory/);
    assert.equal(fs.readFileSync(path.join(prefix, 'current.json'), 'utf8'), currentText);
  });

  it('rejects a redirected prefix ancestor (junctions are reported as links by lstat)', () => {
    Object.assign(installWindows.internals, saved);
    const link = path.join(base, 'junction');
    const target = path.join(base, 'other');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link);
    throwsMatching(() => installWindows.checked_prefix(path.join(link, 'lcu')), /linked Windows installation path/);
  });

  it('internal copy paths use the Windows extended-length spelling', () => {
    assert.equal(installWindows._extended_windows_name('C:\\LCU\\apps\\app'), '\\\\?\\C:\\LCU\\apps\\app');
    assert.equal(installWindows._extended_windows_name('\\\\server\\share\\app'), '\\\\?\\UNC\\server\\share\\app');
    assert.equal(installWindows._extended_windows_name('\\\\?\\C:\\already'), '\\\\?\\C:\\already');
  });

  it('the bridge offers the same agent choices as lcu/setup_clients.mjs', () => {
    const bridge = fs.readFileSync(path.join(ROOT, 'scripts/install_windows.py'), 'utf8');
    const tuple = (name) => [...new RegExp(`^${name} = \\(([^)]*)\\)`, 'm').exec(bridge)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(tuple('CLIENTS'), Object.keys(CLIENTS));
    assert.deepEqual(tuple('ALIASES'), Object.keys(ALIASES));
  });
});

// LCU 0.9.6 #20, Node side of tests/test_windows_install_host.py: the release publication's cleanup boundary
// (removing an app copy this run created is the bridge's part: tests/test_windows_install_host.py).
describe('WindowsInstallHostTests (Node publication)', () => {
  let base; let source; let prefix; let official; let generation;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-winhost-')));
    source = path.join(base, 'archive');
    fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(source, 'scripts/windows_launcher.py'), 'fixture');
    fs.writeFileSync(path.join(source, 'scripts/windows_launcher.mjs'), 'fixture dispatcher');
    fs.writeFileSync(path.join(source, 'runtime.lock.json'), JSON.stringify({ platforms: { windows: { architectures: { x64: {} } } } }));
    prefix = path.join(base, 'installed');
    fs.mkdirSync(prefix);
    official = officialApp(base);
    ({ generation } = publishGeneration(prefix, official));
    Object.assign(installWindows.internals, {
      SOURCE: source, platform: () => 'win32', architecture: () => 'x64', verify: () => {},
      checked_prefix: () => prefix, windows: fakeWindows, materialize_original_host: () => {}, paths: () => {},
    });
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  const releases = () => (fs.existsSync(path.join(prefix, 'releases')) ? fs.readdirSync(path.join(prefix, 'releases')) : []);

  it('a host extraction failure removes the partial release and publishes nothing', () => {
    installWindows.internals.materialize_original_host = (app) => {
      assert.ok(fs.statSync(app).isDirectory()); // the generation existed when the host was extracted
      throw new ValueError('Required Windows host layout is unavailable: late failure');
    };
    throwsMatching(() => installWindows.install(prefix, { app_generation: generation }), /late failure/);
    assert.deepEqual(releases(), []);
    assert.equal(fs.existsSync(path.join(prefix, 'current.json')), false);
  });

  it('a redirected release directory is refused inside the cleanup boundary', () => {
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(prefix, 'releases'));
    throwsMatching(() => installWindows.install(prefix, { app_generation: generation }), /redirected Windows release directory/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    assert.equal(fs.existsSync(path.join(prefix, 'current.json')), false);
  });

  it('a failed launcher restore still removes the release and reports the restore failure', () => {
    fs.writeFileSync(path.join(prefix, 'launcher.json'), 'previous launcher pair');
    const calls = [];
    installWindows.internals.atomic_bytes = (file) => {
      calls.push(path.basename(file));
      if (calls.length === 2) throw Object.assign(new Error('command locked'), { name: 'OSError' });
      if (calls.length === 3) throw Object.assign(new Error('restore locked'), { name: 'OSError' });
    };
    throwsMatching(() => installWindows.install(prefix, { app_generation: generation }), /restore locked/);
    assert.deepEqual(calls, ['launcher.json', 'windows_launcher.mjs', 'launcher.json']);
    assert.deepEqual(releases(), []);
    assert.equal(fs.existsSync(path.join(prefix, 'current.json')), false);
  });

  it('--check-host prints the read-only layout verdict for the bridge', () => {
    let stdout = '';
    io.stdout = (text) => { stdout += text; };
    const seen = [];
    installWindows.internals.execPath = () => '/staged/node.exe';
    installWindows.internals.plan_original_host = (app, options) => { seen.push([app, options]); };
    installWindows.main(['--check-host', official]);
    assert.equal(stdout, '{"ok": true}\n');
    assert.deepEqual(seen, [[official, { node: '/staged/node.exe' }]]);
    stdout = '';
    installWindows.internals.plan_original_host = () => {
      throw new ValueError('Required Windows host layout is unavailable: no "factory"');
    };
    installWindows.main(['--check-host', official]);
    assert.equal(stdout, '{"ok": false, "error": "Required Windows host layout is unavailable: no \\"factory\\""}\n');
    installWindows.internals.plan_original_host = () => { throw new TypeError('bug'); };
    assert.throws(() => installWindows.main(['--check-host', official]), /bug/);
    assert.equal(fs.existsSync(path.join(prefix, 'releases')), false); // nothing is written
  });

  it('--check-host runs the real structural check on a fixture archive', () => {
    const app = path.join(base, 'app-with-asar');
    const asar = path.join(app, 'app/resources/app.asar');
    fs.mkdirSync(path.dirname(asar), { recursive: true });
    const options = '{codexCliPath,nativePipeDirectory,windowsHelperPath,windowsHelperTransportModulePath}';
    const writeAsar = (main) => {
      const content = Buffer.from(main);
      const header = Buffer.from(JSON.stringify({ files: { '.vite': { files: { build: { files: {
        'main-h.js': { offset: '0', size: content.length } } } } } } }));
      const pre = Buffer.alloc(16);
      pre.writeUInt32LE(4, 0); pre.writeUInt32LE(8 + header.length, 4); pre.writeUInt32LE(4 + header.length, 8);
      pre.writeUInt32LE(header.length, 12);
      fs.writeFileSync(asar, Buffer.concat([pre, header, content]));
    };
    const check = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning',
      path.join(ROOT, 'scripts/install_windows.mjs'), '--check-host', app], { encoding: 'utf8' });
    writeAsar(`function Kne(${options}){return {closeActiveTurn(){},nativePipeDirectory}}\n`);
    let done = check();
    assert.equal(done.status, 0, done.stderr);
    assert.equal(done.stdout, '{"ok": true}\n');
    writeAsar('const x=1;\n');
    done = check();
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /^\{"ok": false, "error": "Required Windows host layout is unavailable: no main bundle has a top-level native-pipe host factory/);
    assert.deepEqual(fs.readdirSync(app).sort(), ['app']);
  });
});

describe('WindowsInstallerReviewTests', () => {
  let base; let source; let prefix;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-win2-')));
    source = path.join(base, 'archive');
    fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(source, 'scripts/windows_launcher.py'), 'fixture');
    fs.writeFileSync(path.join(source, 'scripts/windows_launcher.mjs'), 'fixture dispatcher');
    fs.writeFileSync(path.join(source, 'runtime.lock.json'), JSON.stringify({ platforms: { windows: { architectures: { x64: {} } } } }));
    prefix = path.join(base, 'installed');
    fs.mkdirSync(prefix);
    Object.assign(installWindows.internals, {
      SOURCE: source, platform: () => 'win32', architecture: () => 'x64', verify: () => {},
      checked_prefix: () => prefix, windows: fakeWindows, materialize_original_host: () => {}, paths: () => {},
    });
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('R7: descriptors are written with the platform line separator, as Path.write_text did (CRLF on Windows)', () => {
    installWindows.internals.linesep = () => '\r\n';
    const { generation } = publishGeneration(prefix, officialApp(base));
    const release = installWindows.install(prefix, { app_generation: generation });
    assert.equal(fs.readFileSync(path.join(prefix, 'current.json'), 'latin1'), `{"release": "${path.basename(release)}"}\r\n`);
    const text = fs.readFileSync(path.join(release, 'installation.json'), 'latin1');
    assert.ok(text.endsWith('\r\n}\r\n') && !/[^\r]\n/.test(text), JSON.stringify(text));
    // lcu.cmd carries explicit CRLF and is written as bytes: never translated twice.
    assert.equal(fs.readFileSync(path.join(prefix, 'lcu.cmd')).includes(Buffer.from('\r\r\n')), false);
  });

  it('R3/R4/R10: lcu.cmd checks the private Node before running it and quarantines the startup variables', () => {
    const { generation, inventory } = publishGeneration(prefix, officialApp(base));
    installWindows.install(prefix, { app_generation: generation, legacy_python: '/Python312/python.exe' });
    const text = fs.readFileSync(path.join(prefix, 'lcu.cmd'), 'utf8');
    const node = path.join(generation, 'app/app/resources/cua_node/bin/node.exe');
    const lines = text.split('\r\n');
    const run = lines.findIndex((line) => line.startsWith('"%LCU_NODE%"'));
    // Every check precedes the only Node execution.
    assert.ok(lines.findIndex((line) => line.includes('call :lcu_plain')) < run);
    assert.ok(lines.indexOf('call :lcu_digest || exit /b 1') < run);
    assert.ok(lines.findIndex((line) => line.includes('call :lcu_quarantine')) < run);
    assert.equal(lines[run], '"%LCU_NODE%" --disable-warning=ExperimentalWarning "%~dp0windows_launcher.mjs" %*');
    for (const component of [prefix, path.join(prefix, 'apps'), generation, path.join(generation, 'app'), node]) {
      assert.ok(text.includes(`"${component}"`), component);
    }
    assert.ok(text.includes(`"${inventory.get('app/resources/cua_node/bin/node.exe').get('sha256')}"`));
    assert.ok(text.includes('%SystemRoot%\\System32\\certutil.exe" -hashfile'));
    const loop = /for %%V in \(([^)]*)\)/.exec(text)[1].split(' ');
    assert.deepEqual(loop, launcher.QUARANTINED);
    const pair = loads(fs.readFileSync(path.join(prefix, 'launcher.json'), 'utf8'));
    assert.deepEqual([...pair.keys()], ['node', 'dispatcher', 'python']);
    assert.equal(pair.get('python'), '/Python312/python.exe');
  });

  it('R5: launcher-pins.json (written by setup) and the generations it pins survive a publication', () => {
    const first = publishGeneration(prefix, officialApp(base));
    installWindows.install(prefix, { app_generation: first.generation });
    const pins = `{\n  "registrations": {\n    "codex|user|": "${path.join(first.generation, 'app/app/resources/cua_node/bin/node.exe')}"\n  }\n}\n`;
    fs.writeFileSync(path.join(prefix, 'launcher-pins.json'), pins);
    const official = path.join(base, 'official-app');
    fs.writeFileSync(path.join(official, 'app/resources/NOTICE.txt'), 'new notice');
    const second = publishGeneration(prefix, official);
    assert.notEqual(second.generation, first.generation);
    installWindows.install(prefix, { app_generation: second.generation });
    assert.equal(fs.readFileSync(path.join(prefix, 'launcher-pins.json'), 'utf8'), pins);
    assert.ok(fs.existsSync(path.join(first.generation, 'app/app/resources/cua_node/bin/node.exe')));
    assert.equal(loads(fs.readFileSync(path.join(prefix, 'launcher.json'), 'utf8')).get('node'),
      path.join(second.generation, 'app/app/resources/cua_node/bin/node.exe'));
  });
});

// A managed generation + release as the installer leaves them, with a POSIX stand-in for node.exe.
function managedRelease(prefix, { node = '#!/bin/sh\nexit 0\n', entry = '' } = {}) {
  const official = path.join(path.dirname(prefix), 'official');
  fs.mkdirSync(path.join(official, 'app/resources/cua_node/bin'), { recursive: true });
  fs.writeFileSync(path.join(official, 'app/resources/cua_node/bin/node.exe'), node);
  fs.chmodSync(path.join(official, 'app/resources/cua_node/bin/node.exe'), 0o755);
  fs.writeFileSync(path.join(official, 'app/resources/NOTICE é.txt'), 'notice');
  const { generation, digest } = publishGeneration(prefix, official);
  fs.chmodSync(path.join(generation, 'app/app/resources/cua_node/bin/node.exe'), 0o755);
  const release = path.join(prefix, 'releases', '1.0.0-abc');
  fs.mkdirSync(path.join(release, 'lcu'), { recursive: true });
  fs.writeFileSync(path.join(release, 'lcu/entry.mjs'), entry);
  fs.writeFileSync(path.join(release, 'installation.json'), JSON.stringify({ app: path.join(generation, 'app'), sha256: digest }));
  fs.writeFileSync(path.join(prefix, 'current.json'), JSON.stringify({ release: '1.0.0-abc' }));
  return { release, generation, digest, node: path.join(generation, 'app/app/resources/cua_node/bin/node.exe') };
}

describe('WindowsLauncherTests', () => {
  let base; let prefix;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-winlaunch-')));
    prefix = path.join(base, 'prefix');
    fs.mkdirSync(prefix);
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('rejects pointer escapes and selects the versioned release', () => {
    const release = path.join(prefix, 'releases', '0.3.0-123abc');
    fs.mkdirSync(path.join(release, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(release, 'bin/lcu'), 'fixture');
    fs.writeFileSync(path.join(prefix, 'current.json'), JSON.stringify({ release: path.basename(release) }));
    assert.equal(launcher.selected_release(prefix), release);
    fs.writeFileSync(path.join(prefix, 'current.json'), JSON.stringify({ release: '../elsewhere' }));
    throwsMatching(() => launcher.selected_release(prefix), /Invalid selected/);
  });

  it('compact_sorted is json.dumps(sort_keys=True, separators=(",", ":")) for inventories', () => {
    const inventory = { 'bé': { type: 'file', sha256: 'x' }, '.': { type: 'directory' }, 'a"\\': { type: 'directory' } };
    const asMap = new Map(Object.entries(inventory).map(([k, v]) => [k, new Map(Object.entries(v))]));
    assert.equal(launcher.compact_sorted(inventory), dumps(asMap, { sort_keys: true, separators: [',', ':'] }));
  });

  it('R3: runs the release Node only from the validated managed generation', () => {
    const { release, generation, digest, node } = managedRelease(prefix);
    const [file, args, env] = launcher.release_command(prefix, release, ['status', '--json'], { NODE_OPTIONS: '--require x', KEEP: '1' });
    assert.equal(file, node);
    assert.deepEqual(args, ['--disable-warning=ExperimentalWarning', path.join(release, 'lcu/entry.mjs'), 'lcu', 'status', '--json']);
    assert.deepEqual(env, { KEEP: '1', __LCU_Q_NODE_OPTIONS: '--require x', __LCU_Q: 'NODE_OPTIONS' });
    const write = (descriptor) => fs.writeFileSync(path.join(release, 'installation.json'), JSON.stringify(descriptor));
    // The review probe: an app outside the prefix, with no inventory or digest.
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    write({ app: outside });
    throwsMatching(() => launcher.release_command(prefix, release, []), /descriptor is incomplete or unsupported/);
    write({ app: outside, sha256: digest });
    throwsMatching(() => launcher.release_command(prefix, release, []), /not the managed private generation/);
    write({ app: path.join(generation, 'app'), sha256: 'f'.repeat(64) });
    throwsMatching(() => launcher.release_command(prefix, release, []), /not the managed private generation/);
    write({ app: path.join(generation, 'app'), sha256: digest });
    fs.writeFileSync(node, '#!/bin/sh\necho TAMPERED\n');
    throwsMatching(() => launcher.release_command(prefix, release, []), /differs from selected source inventory: app\/resources\/cua_node\/bin\/node\.exe/);
    fs.writeFileSync(path.join(generation, 'inventory.json'), '{}\n');
    throwsMatching(() => launcher.release_command(prefix, release, []), /inventory does not match its descriptor/);
    fs.rmSync(path.join(generation, 'inventory.json'));
    fs.symlinkSync(path.join(base, 'elsewhere.json'), path.join(generation, 'inventory.json'));
    throwsMatching(() => launcher.release_command(prefix, release, []), /not the managed private generation/);
  });

  it('R10: a pre-port release runs with the recorded installer Python, never a PATH-selected one', () => {
    const release = path.join(prefix, 'releases', '0.9.3-old');
    fs.mkdirSync(path.join(release, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(release, 'bin/lcu'), 'legacy');
    throwsMatching(() => launcher.release_command(prefix, release, ['--version']), /no installer Python is recorded/);
    fs.writeFileSync(path.join(prefix, 'launcher.json'), JSON.stringify({ node: 'n', dispatcher: 'd', python: '/Py/python.exe' }));
    const [file, args, env] = launcher.release_command(prefix, release, ['--version'], { NODE_OPTIONS: 'x' });
    assert.equal(file, '/Py/python.exe');
    assert.deepEqual(args, ['-B', path.join(release, 'bin/lcu'), '--version']);
    assert.deepEqual(env, { NODE_OPTIONS: 'x' });
  });

  it('R4: a caller preload never runs in the dispatched Node; the release still gets the caller value', () => {
    const marker = path.join(base, 'preload.cjs');
    fs.writeFileSync(marker, "process.stdout.write('CALLER_PRELOAD_EXECUTED\\n');\n");
    const entry = "process.stdout.write(`ENTRY ${process.env.__LCU_Q} ${process.env.__LCU_Q_NODE_OPTIONS ? 'kept' : 'lost'}\\n`);\n";
    managedRelease(prefix, { node: `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, entry });
    fs.copyFileSync(path.join(ROOT, 'scripts/windows_launcher.mjs'), path.join(prefix, 'windows_launcher.mjs'));
    // As lcu.cmd starts it: startup variables already quarantined.
    const result = spawnSync(process.execPath, [path.join(prefix, 'windows_launcher.mjs'), 'status'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, __LCU_Q: 'NODE_OPTIONS', __LCU_Q_NODE_OPTIONS: `--require ${marker}` } });
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'ENTRY NODE_OPTIONS kept\n');
    assert.equal(result.status, 0);
  });

  it('dispatches with inherited stdio and returns the exit status', () => {
    managedRelease(prefix, { node: '#!/bin/sh\nexit $#\n' });
    assert.equal(launcher.main(['a', 'b'], { prefix }), 5);
  });
});
