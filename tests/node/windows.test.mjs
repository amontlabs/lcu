import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { environment, main, paths } from '../../lcu/runtime.mjs';
import {
  PACKAGE_NAME, PACKAGE_PUBLISHER, WINDOWS_REQUIRED_FILES, applicationInventory, canonicalJson, inventorySha256, registeredPackage,
  resolveInstalledWindowsApp, validateWindowsAppTree,
} from '../../lcu/windows.mjs';
import { override, temporary, write } from './fixtures.mjs';

const VERSION = '26.917.9434.0';
const RUNTIME = '0.0.16/20260915001755-492f19756c31';
const identity = (version) => `<?xml version="1.0"?><!-- <Identity Name="decoy"/> --><Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">` +
  `<Identity Name="${PACKAGE_NAME}" Publisher="${PACKAGE_PUBLISHER}" Version="${version}" ProcessorArchitecture="x64"/></Package>`;

function storeApp(t) {
  const app = join(temporary(t), `OpenAI.Codex_${VERSION}_x64`);
  write(join(app, 'AppxManifest.xml'), identity(VERSION));
  for (const relative of WINDOWS_REQUIRED_FILES) {
    write(join(app, relative), relative.endsWith('cua_node/manifest.json')
      ? JSON.stringify({ platform: 'windows', arch: 'x64', runtime_archive_version: RUNTIME }) : relative);
  }
  const registered = { Name: PACKAGE_NAME, Publisher: PACKAGE_PUBLISHER, Version: VERSION, Architecture: 'X64', SignatureKind: 'Store', InstallLocation: app };
  return { app, registered };
}

function onWindows(t, registered) {
  override(t, process, 'platform', 'win32');
  override(t, process, 'arch', 'x64');
  return t.mock.method(childProcess, 'spawnSync', (command, args) => {
    assert.equal(command, 'powershell.exe');
    assert.match(args.at(-1), /Get-AppxPackage/);
    return { status: 0, stdout: JSON.stringify(registered), stderr: '' };
  });
}

test('the registered official package is selected in place, with its tree inventory', (t) => {
  const { app, registered } = storeApp(t);
  const query = onWindows(t, registered);
  const selected = resolveInstalledWindowsApp();
  assert.equal(query.mock.callCount(), 1);
  assert.deepEqual([selected.app, selected.resources, selected.runtime, selected.launcher],
    [app, join(app, 'app/resources'), join(app, 'app/resources/cua_node'), join(app, WINDOWS_REQUIRED_FILES[5])]);
  assert.deepEqual([selected.backend, selected.version, selected.arch, selected.runtimeVersion], ['windows', VERSION, 'x64', RUNTIME]);
  assert.equal(selected.inventoryDigest, inventorySha256(selected.inventory));
});

test('the inventory digest matches the one earlier releases recorded (sorted, compact, ASCII-escaped JSON)', () => {
  const inventory = { 'b\u00e9': { type: 'file', sha256: 'x' }, '.': { type: 'directory' } };
  assert.equal(canonicalJson(inventory), '{".":{"type":"directory"},"b\\u00e9":{"sha256":"x","type":"file"}}');
  // The digest Python's json.dumps(sort_keys=True, separators=(',', ':')) gave for the same inventory.
  assert.equal(inventorySha256(inventory), 'dcceeac341d6392bccdefdc08269f4d7cd019483335c24a1984b3cb500f5a6ef');
});

test('a private copy is validated without querying registration, and must equal the source inventory', (t) => {
  const { app } = storeApp(t);
  const query = onWindows(t, {});
  const privateCopy = join(app, '../managed/app');
  cpSync(app, privateCopy, { recursive: true });
  const options = { expectedVersion: VERSION, expectedRuntime: RUNTIME, expectedInventory: applicationInventory(app) };
  assert.equal(validateWindowsAppTree(privateCopy, options).app, privateCopy);
  assert.equal(query.mock.callCount(), 0);
  writeFileSync(join(privateCopy, WINDOWS_REQUIRED_FILES[2]), 'changed');
  assert.throws(() => validateWindowsAppTree(privateCopy, options), new RegExp(`differs from selected source inventory: ${WINDOWS_REQUIRED_FILES[2]}`));
  assert.throws(() => validateWindowsAppTree(app, { ...options, expectedRuntime: 'wrong' }), /runtime changed after selection/);
});

test('a registration that is not the official x64 Store package is refused before use', (t) => {
  const { registered } = storeApp(t);
  const query = onWindows(t, registered);
  for (const [changes, pattern] of [[{ Publisher: 'CN=other' }, /official Windows x64 Store app/],
    [{ Version: '27.100.1.0' }, /version does not match its identity manifest/], [{ Architecture: 'ARM64' }, /official Windows x64 Store app/],
    [{ SignatureKind: 'Developer' }, /official Windows x64 Store app/]]) {
    query.mock.mockImplementation(() => ({ status: 0, stdout: JSON.stringify({ ...registered, ...changes }) }));
    assert.throws(() => resolveInstalledWindowsApp(), pattern);
  }
});

test('a new official version is accepted', (t) => {
  const { app, registered } = storeApp(t);
  writeFileSync(join(app, 'AppxManifest.xml'), identity('27.100.1.0'));
  onWindows(t, { ...registered, Version: '27.100.1.0' });
  assert.equal(resolveInstalledWindowsApp().version, '27.100.1.0');
});

test('the query projects typed PowerShell properties to strings', (t) => {
  const { registered } = storeApp(t);
  const query = onWindows(t, registered);
  assert.deepEqual(registeredPackage(), registered);
  const command = query.mock.calls[0].arguments[1].at(-1);
  for (const part of ['$_.Version.ToString()', '$_.Architecture.ToString()', '$_.SignatureKind.ToString()']) assert.ok(command.includes(part));
  for (const changes of [{ Version: { Major: 26 } }, { Architecture: 9 }, { SignatureKind: 0 }]) {
    query.mock.mockImplementation(() => ({ status: 0, stdout: JSON.stringify({ ...registered, ...changes }) }));
    assert.throws(() => registeredPackage(), /string version, architecture and signature kind/);
  }
});

test('an MSIX-encoded scoped module segment is accepted; a redirected file is refused; only Windows x64 validates', (t) => {
  const { app, registered } = storeApp(t);
  assert.throws(() => resolveInstalledWindowsApp(), /only be validated on Windows x64/);
  onWindows(t, registered);
  const original = join(app, WINDOWS_REQUIRED_FILES[5]);
  const encoded = join(app, WINDOWS_REQUIRED_FILES[5].replace('@oai/', '%40oai/'));
  mkdirSync(join(encoded, '..'), { recursive: true });
  renameSync(original, encoded);
  assert.equal(resolveInstalledWindowsApp().launcher, encoded);
  const runtime = join(app, 'app/resources/cua_node');
  renameSync(runtime, join(app, '../external-cua-node'));
  symlinkSync(join(app, '../external-cua-node'), runtime);
  assert.throws(() => resolveInstalledWindowsApp(), /redirected path|missing or outside the app/);
});

// ---- launching the managed private copy --------------------------------------------------------------

function windowsRelease(t) {
  const base = temporary(t);
  const prefix = join(base, 'prefix');
  const root = join(prefix, 'releases/release');
  const { app: source } = storeApp(t);
  // The original server and host stand in as scripts on this POSIX test host.
  const runtime = 'app/resources/cua_node';
  write(join(source, runtime, 'bin/node.exe'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, 0o755);
  write(join(source, runtime, 'bin/node_modules/@oai/cua-repl/bin/cua-repl.mjs'),
    "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.LCU_TEST_OUT, JSON.stringify({ argv: process.argv, env: process.env }));\n" +
    "if (process.env.LCU_TEST_SIGNAL) process.kill(process.pid, process.env.LCU_TEST_SIGNAL);\n" +
    'process.exitCode = Number(process.env.LCU_TEST_STATUS ?? 0);\n');
  const inventory = applicationInventory(source);
  const digest = inventorySha256(inventory);
  const generation = join(prefix, 'apps', digest);
  mkdirSync(generation, { recursive: true });
  const app = join(generation, 'app');
  renameSync(source, app);
  write(join(generation, 'inventory.json'), JSON.stringify(inventory));
  write(join(root, 'runtime.lock.json'), JSON.stringify({ platforms: { windows: { version: VERSION, runtime: RUNTIME, architectures: { x64: { sha256: '0'.repeat(64) } } } } }));
  write(join(root, 'installation.json'), JSON.stringify({ platform: 'windows', app, architecture: 'x64', package_version: VERSION, runtime: RUNTIME, sha256: digest }));
  write(join(root, 'lcu-host/windows-pipe-host.cjs'), `const fs = require('node:fs');
    // The fault hook: the original server's Node cannot start once the host is up.
    if (process.env.LCU_TEST_BREAK) fs.chmodSync(process.env.NODE_REPL_NODE_PATH, 0o644);
    process.stdout.write(JSON.stringify({ ready: true,
    pipePath: '\\\\\\\\.\\\\pipe\\\\lcu-wre-fixture', lifetimePath: '\\\\\\\\.\\\\pipe\\\\lcu-lifetime-fixture' }) + '\\n');
    fs.writeFileSync(process.env.LCU_TEST_OUT + '.host', JSON.stringify({ helper: process.env.LCU_WRE_HELPER_PATH, transport: process.env.LCU_WRE_TRANSPORT_PATH }));
    process.stdin.resume(); process.stdin.on('end', () => { fs.writeFileSync(process.env.LCU_TEST_OUT + '.stopped', ''); process.exit(0); });\n`);
  override(t, process, 'platform', 'win32');
  override(t, process, 'arch', 'x64');
  return { base, prefix, root, app, runtime: join(app, runtime), resources: join(app, 'app/resources'), digest, out: join(base, 'child.json') };
}

test('the managed app supplies the original Windows paths and environment', (t) => {
  const r = windowsRelease(t);
  const selected = paths(r.root);
  assert.deepEqual([selected.app, selected.resources, selected.runtime], [r.app, r.resources, r.runtime]);
  const env = environment(r.root, selected, { env: { USERPROFILE: 'C:\\fixture', Path: 'C:\\Windows' } });
  assert.equal(env.CODEX_HOME, 'C:\\fixture\\.codex');
  assert.equal(env.NODE_REPL_NODE_PATH, join(r.runtime, 'bin/node.exe'));
  assert.equal(env.CUA_REPL_NODE_REPL_PATH, join(r.runtime, 'bin/node_repl.exe'));
  assert.equal(env.CODEX_CLI_PATH, join(r.resources, 'codex.exe'));
  assert.equal(env.NODE_REPL_NODE_MODULE_DIRS, join(r.runtime, 'bin/node_modules'));
  assert.equal(env.PATH, `${join(r.runtime, 'bin')};C:\\Windows`);
  assert.ok(!('Path' in env));
  assert.equal(env.BROWSER_USE_CODEX_APP_VERSION, VERSION);
});

async function launchWindows(t, r, argv, settings = {}) {
  override(t, process, 'env', { PATH: process.env.PATH, USERPROFILE: 'C:\\fixture', LCU_TEST_OUT: r.out, ...settings });
  const status = await main(r.root, argv);
  return { status, child: JSON.parse(readFileSync(r.out, 'utf8')), host: JSON.parse(readFileSync(`${r.out}.host`, 'utf8')) };
}

test('the original launcher runs with the original pipe host around it', async (t) => {
  const r = windowsRelease(t);
  const { status, child, host } = await launchWindows(t, r, []);
  assert.equal(status, 0);
  assert.equal(child.argv[1], join(r.runtime, 'bin/node_modules/@oai/cua-repl/bin/cua-repl.mjs'));
  assert.equal(child.env.CUA_REPL_ENABLED_SURFACES, 'computer');
  assert.equal(child.env.SKY_CUA_NATIVE_PIPE, '1');
  assert.equal(child.env.SKY_CUA_NATIVE_PIPE_DIRECTORY, '\\\\.\\pipe\\lcu-wre-fixture');
  assert.equal(child.env.LCU_WRE_LIFETIME_PIPE, '\\\\.\\pipe\\lcu-lifetime-fixture');
  assert.equal(JSON.parse(child.env.NODE_REPL_TRUSTED_SERVICES).sky, join(r.root, 'lcu-host/windows-sky-service.mjs'));
  assert.equal(host.helper, join(r.runtime, 'bin/node_modules/@oai/sky/bin/windows/codex-computer-use.exe'));
  assert.equal(child.env.LCU_WRE_SKY_SERVICE_PATH, join(r.runtime, 'bin/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js'));
});

test('other trusted services are kept, the browser one with --chrome; a custom Sky service or a bad map is refused', async (t) => {
  const r = windowsRelease(t);
  assert.equal(JSON.parse((await launchWindows(t, r, [], { NODE_REPL_TRUSTED_SERVICES: '{"browser":"fixture"}' })).child.env.NODE_REPL_TRUSTED_SERVICES).browser, 'fixture');
  const chrome = JSON.parse((await launchWindows(t, r, ['--chrome'])).child.env.NODE_REPL_TRUSTED_SERVICES);
  assert.deepEqual(chrome, { browser: '@oai/browser-desktop/service', sky: join(r.root, 'lcu-host/windows-sky-service.mjs') });
  const custom = JSON.parse((await launchWindows(t, r, ['--chrome'], { NODE_REPL_TRUSTED_SERVICES: '{"fixture":"service"}' })).child.env.NODE_REPL_TRUSTED_SERVICES);
  assert.ok(!('browser' in custom) && custom.fixture === 'service');
  unlinkSync(r.out);
  for (const [services, pattern] of [['{"sky":"custom"}', /conflicts/], ['null', /JSON string map/]]) {
    override(t, process, 'env', { PATH: process.env.PATH, USERPROFILE: 'C:\\fixture', LCU_TEST_OUT: r.out, NODE_REPL_TRUSTED_SERVICES: services });
    await assert.rejects(main(r.root, []), pattern);
  }
  assert.throws(() => readFileSync(r.out), /ENOENT/, 'the original server never started');
});

test('the descriptor must name the managed generation and its intact inventory', (t) => {
  const r = windowsRelease(t);
  const descriptorPath = join(r.root, 'installation.json');
  const descriptor = JSON.parse(readFileSync(descriptorPath));
  writeFileSync(descriptorPath, JSON.stringify({ ...descriptor, app: join(r.root, 'other') }));
  assert.throws(() => paths(r.root), /not the managed private generation/);
  for (const [key, value] of [['package_version', ''], ['runtime', ''], ['sha256', 'not-a-64-hex-digest']]) {
    writeFileSync(descriptorPath, JSON.stringify({ ...descriptor, [key]: value }));
    assert.throws(() => paths(r.root), /incomplete or unsupported/);
  }
  writeFileSync(descriptorPath, JSON.stringify(descriptor));
  const inventoryPath = join(r.app, '../inventory.json');
  unlinkSync(inventoryPath);
  assert.throws(() => paths(r.root), /not the managed private generation/);
  writeFileSync(inventoryPath, JSON.stringify({ '.': { type: 'directory' } }));
  assert.throws(() => paths(r.root), /inventory does not match its descriptor/);
});

test('the original server’s exit status reaches the caller; a signal gives 128 + its number', async (t) => {
  const r = windowsRelease(t);
  assert.equal((await launchWindows(t, r, [], { LCU_TEST_STATUS: '7' })).status, 7);
  assert.equal((await launchWindows(t, r, [], { LCU_TEST_SIGNAL: 'SIGTERM' })).status, 128 + 15);
});

test('the owned host is disposed of when the original server cannot start', async (t) => {
  const r = windowsRelease(t);
  override(t, process, 'env', { PATH: process.env.PATH, USERPROFILE: 'C:\\fixture', LCU_TEST_OUT: r.out, LCU_TEST_BREAK: '1' });
  await assert.rejects(main(r.root, []), { code: 'EACCES' });
  assert.ok(existsSync(`${r.out}.stopped`), 'the host saw its stdin close and exited');
});
