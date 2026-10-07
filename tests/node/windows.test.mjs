// Port of tests/test_windows_package.py (Windows MSIX registration and sealed runtime selection, fixture only)
// plus the windows.py helpers used by tests/test_windows_runtime.py, with differential checks against Python.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PYTHON } from './python312.mjs';

import {
  PACKAGE_NAME, PACKAGE_PUBLISHER, WINDOWS_REQUIRED_FILES, _appx_identity, _component, _registered_package,
  _runtime_manifest, application_inventory, hooks, inventory_sha256, resolve_installed_windows_app,
  validate_windows_app_tree,
} from '../../lcu/windows.mjs';
import { ORACLE_ROOT } from './oracle_root.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VERSION = '26.917.9434.0';
const RUNTIME = '0.0.16/20260915001755-492f19756c31';
const original = { ...hooks };

describe('windows package', () => {
  let base;
  let app;
  let pkg;
  let calls;

  const _write_identity = (version) => writeFileSync(join(app, 'AppxManifest.xml'),
    `<Package><Identity Name="${PACKAGE_NAME}" Publisher="${PACKAGE_PUBLISHER}" ` +
    `Version="${version}" ProcessorArchitecture="x64"/></Package>`);

  const onWindows = () => {
    hooks.system = () => 'Windows';
    hooks.machine = () => 'AMD64';
  };
  const powershell = (stdout, { returncode = 0, stderr = '' } = {}) => {
    hooks.preferred_encoding = () => 'utf-8';
    hooks.run = (cmd, options) => {
      calls.push([cmd, options]);
      return { args: cmd, returncode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
    };
  };
  const _resolve = (value = pkg) => {
    onWindows();
    powershell(JSON.stringify(value));
    const selected = resolve_installed_windows_app();
    assert.equal(calls.length, 1);
    assert.ok(calls[0][0].at(-1).includes('Get-AppxPackage'));
    return selected;
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'lcu-win-'));
    app = join(base, 'OpenAI.Codex_26.917.9434.0_x64');
    mkdirSync(app);
    _write_identity(VERSION);
    for (const relative of WINDOWS_REQUIRED_FILES) {
      const file = join(app, relative);
      mkdirSync(dirname(file), { recursive: true });
      let data = relative;
      if (relative.endsWith('cua_node/manifest.json')) {
        data = JSON.stringify({ platform: 'windows', arch: 'x64', runtime_archive_version: RUNTIME });
      }
      writeFileSync(file, data);
    }
    pkg = { Name: PACKAGE_NAME, Publisher: PACKAGE_PUBLISHER, Version: VERSION, Architecture: 'X64',
      SignatureKind: 'Store', InstallLocation: app };
    calls = [];
  });
  afterEach(() => {
    Object.assign(hooks, original);
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test('selects original registered package without copying', () => {
    const selected = _resolve();
    const real = realpathSync(app);
    assert.equal(selected.app, real);
    assert.equal(selected.resources, join(real, 'app/resources'));
    assert.equal(selected.runtime, join(real, 'app/resources/cua_node'));
    assert.equal(selected.launcher, join(real, WINDOWS_REQUIRED_FILES[5]));
    assert.deepEqual([selected.backend, selected.version, selected.arch], ['windows', VERSION, 'x64']);
    assert.equal(selected.runtime_version, RUNTIME);
    assert.equal(selected.inventory_digest, inventory_sha256(selected.inventory));
    assert.ok(Object.isFrozen(selected));
  });

  test('validates private copy without querying registration', () => {
    const priv = join(base, 'managed', 'app');
    cpSync(app, priv, { recursive: true });
    onWindows();
    hooks.run = () => assert.fail('powershell must not run');
    const selected = validate_windows_app_tree(priv, { expected_version: VERSION,
      expected_runtime: RUNTIME, expected_inventory: application_inventory(app) });
    assert.equal(selected.app, realpathSync(priv));
    writeFileSync(join(priv, WINDOWS_REQUIRED_FILES[2]), 'changed');
    assert.throws(() => validate_windows_app_tree(priv, { expected_version: VERSION,
      expected_runtime: RUNTIME, expected_inventory: application_inventory(app) }),
    { message: `Windows application differs from selected source inventory: ${WINDOWS_REQUIRED_FILES[2]}` });
  });

  test('rejects wrong registration before using package', () => {
    assert.throws(() => _resolve({ ...pkg, Publisher: 'CN=other' }), /official Windows x64 Store app/);
    calls = [];
    assert.throws(() => _resolve({ ...pkg, Version: '27.100.1.0' }), /version does not match its identity manifest/);
    calls = [];
    assert.throws(() => _resolve({ ...pkg, Architecture: 'ARM64' }), /official Windows x64 Store app/);
    calls = [];
    assert.throws(() => _resolve({ ...pkg, SignatureKind: 'Developer' }), /official Windows x64 Store app/);
    calls = [];
    assert.throws(() => _resolve({ ...pkg, InstallLocation: '' }), { message: 'Registered ChatGPT package has no install location.' });
  });

  test('accepts new official version and records source inventory', () => {
    const version = '27.100.1.0';
    _write_identity(version);
    const selected = _resolve({ ...pkg, Version: version });
    assert.equal(selected.version, version);
  });

  test('query projects typed powershell properties to strings', () => {
    powershell(JSON.stringify(pkg));
    const result = _registered_package();
    assert.deepEqual([...result], Object.entries(pkg));
    const [cmd, options] = calls[0];
    assert.deepEqual(cmd.slice(0, 5), ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    assert.deepEqual(options, { capture: true, timeout: 30000, text: false });
    assert.ok(cmd.at(-1).includes('$_.Version.ToString()'));
    assert.ok(cmd.at(-1).includes('$_.Architecture.ToString()'));
    assert.ok(cmd.at(-1).includes('$_.SignatureKind.ToString()'));
    for (const unprojected of [{ ...pkg, Version: { Major: 26, Minor: 917 } }, { ...pkg, Architecture: 9 },
      { ...pkg, SignatureKind: 0 }]) {
      powershell(JSON.stringify(unprojected));
      assert.throws(() => _registered_package(), /string version, architecture and signature kind/);
    }
    powershell(' \r\n');
    assert.throws(() => _registered_package(), { message: 'Install the official ChatGPT MSIX for this Windows account first.' });
    powershell(JSON.stringify([pkg, pkg]));
    assert.throws(() => _registered_package(), { message: 'Expected exactly one registered OpenAI.Codex package for this account.' });
    powershell(JSON.stringify([pkg]));
    assert.equal(_registered_package().get('Name'), PACKAGE_NAME);
  });

  test('R11: powershell output is decoded strictly with the locale encoding, before the exit status', () => {
    const json = Buffer.concat([Buffer.from(JSON.stringify({ ...pkg, InstallLocation: 'C:/caf' }).slice(0, -2)),
      Buffer.from([0xe9]), Buffer.from('"}')]);
    powershell(json);
    const python = PYTHON && spawnSync(PYTHON, ['-c', 'import sys\ntry:\n    sys.stdin.buffer.read().decode("utf-8")\nexcept UnicodeDecodeError as e:\n    print(e)'],
      { input: json, encoding: 'utf8' }).stdout.trim();
    assert.throws(() => _registered_package(), (error) => error.name === 'UnicodeDecodeError' &&
      error.message === (python || error.message) && /can't decode byte 0xe9/.test(error.message));
    powershell(json, { returncode: 1 });
    assert.throws(() => _registered_package(), { name: 'UnicodeDecodeError' });
    powershell(json);
    hooks.preferred_encoding = () => 'cp1252';
    assert.equal(_registered_package().get('InstallLocation'), 'C:/café');
    powershell(Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0x81]), Buffer.from('"}')]));
    hooks.preferred_encoding = () => 'cp1252';
    assert.throws(() => _registered_package(),
      { message: "'charmap' codec can't decode byte 0x81 in position 6: character maps to <undefined>" });
    powershell(JSON.stringify(pkg), { returncode: 2, stderr: 'boom' });
    assert.throws(() => _registered_package(), { name: 'CalledProcessError' });
    powershell(`${JSON.stringify(pkg)}\r\n`);
    assert.equal(_registered_package().get('Name'), PACKAGE_NAME);
  });

  test('R8/R10/R12/R13: caller-level manifest verdicts follow ElementTree', { skip: !PYTHON && 'python3.12 missing' }, () => {
    const manifest = join(app, 'AppxManifest.xml');
    const identity = (version = '1.2.3.4') => `<Package><Identity Name="${PACKAGE_NAME}" Publisher="${PACKAGE_PUBLISHER}" ` +
      `Version="${version}" ProcessorArchitecture="x64"/></Package>`;
    const cases = {
      'public-illegal': Buffer.from(`<!DOCTYPE Package PUBLIC "<" "local.dtd">${identity()}`),
      'utf16-wrong-endian': Buffer.from(`\ufeff<?xml version="1.0" encoding="UTF-16BE"?>${identity()}`, 'utf16le'),
      'long-char-ref': Buffer.from(identity('&#00000000000000049;.2.3.4')),
      'internal-entity': Buffer.from(`<!DOCTYPE Package [<!ENTITY version "1.2.3.4">]>${identity('&version;')}`),
      cp1252: Buffer.from(`<?xml version="1.0" encoding="cp1252"?>${identity()}`),
      'unknown-codec': Buffer.from(`<?xml version="1.0" encoding="never-an-encoding"?>${identity()}`),
      'multibyte-codec': Buffer.from(`<?xml version="1.0" encoding="shift_jis"?>${identity()}`),
      'unicode16-digit': Buffer.from(identity('\u{10D40}.2.3.4')),
      'unicode-digit': Buffer.from(identity('\u0661.2.3.4')),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      writeFileSync(manifest, bytes);
      const done = spawnSync(PYTHON, ['-B', '-c',
        'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from lcu import windows\n' +
        'try:\n    print("OK:" + repr(windows._appx_identity(Path(sys.argv[2]))))\n' +
        'except Exception as e:\n    print(f"{type(e).__name__}:{e}")', ORACLE_ROOT, app], { encoding: 'utf8' });
      let node;
      try {
        const [n, p, v, a] = _appx_identity(app);
        node = `OK:('${n}', '${p}', '${v}', '${a}')`;
      } catch (error) {
        node = `${error.name}:${error.message}`;
      }
      const python = done.stdout.trim().replace(/\\U000([0-9a-f]{5})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
      assert.equal(node, python, name);
    }
  });

  test('selected tree inventory rejects modified file', () => {
    const inventory = application_inventory(app);
    writeFileSync(join(app, WINDOWS_REQUIRED_FILES[2]), 'modified');
    onWindows();
    assert.throws(() => validate_windows_app_tree(app, { expected_version: VERSION,
      expected_runtime: RUNTIME, expected_inventory: inventory }), /differs from selected source inventory/);
  });

  test('accepts msix encoded scoped module segment', () => {
    const orig = join(app, WINDOWS_REQUIRED_FILES[5]);
    const encoded = join(app, WINDOWS_REQUIRED_FILES[5].replace('@oai/', '%40oai/'));
    mkdirSync(dirname(encoded), { recursive: true });
    renameSync(orig, encoded);
    assert.equal(_resolve().launcher, realpathSync(encoded));
    assert.equal(_component(app, WINDOWS_REQUIRED_FILES[5]), encoded);
    assert.equal(_component(app, 'app/missing'), join(app, 'app/missing'));
  });

  test('rejects redirected required file', () => {
    const target = join(base, 'external-cua-node');
    const orig = join(app, 'app/resources/cua_node');
    renameSync(orig, target);
    symlinkSync(target, orig, 'dir');
    assert.throws(() => _resolve(), /redirected path/);
  });

  test('rejects required file through junction', () => {
    const junction = join(realpathSync(app), 'app/resources/cua_node');
    hooks.is_junction = (p) => p === junction;
    assert.throws(() => _resolve(), /redirected path|missing or outside the app/);
  });

  test('rejects wrong runtime and host platform', () => {
    hooks.system = () => 'Darwin';
    assert.throws(() => resolve_installed_windows_app(), { message: 'The Windows application can only be validated on Windows x64.' });
    onWindows();
    assert.throws(() => validate_windows_app_tree(app, { expected_version: VERSION,
      expected_runtime: 'wrong', expected_inventory: application_inventory(app) }),
    { message: 'Windows CUA runtime changed after selection.' });
    hooks.machine = () => 'ARM64';
    assert.throws(() => validate_windows_app_tree(app, { expected_version: VERSION,
      expected_runtime: RUNTIME, expected_inventory: application_inventory(app) }), /only be validated on Windows x64/);
    onWindows();
    assert.throws(() => validate_windows_app_tree(app, { expected_version: '', expected_runtime: RUNTIME,
      expected_inventory: new Map() }), { message: 'A selected Windows version, runtime and source inventory are required.' });
    assert.throws(() => validate_windows_app_tree(app, { expected_version: '1.2.3.4', expected_runtime: RUNTIME,
      expected_inventory: application_inventory(app) }), { message: 'Windows application identity version changed after selection.' });
  });

  test('identity manifest validation messages', () => {
    assert.deepEqual(_appx_identity(app), [PACKAGE_NAME, PACKAGE_PUBLISHER, VERSION, 'x64']);
    const manifest = join(app, 'AppxManifest.xml');
    writeFileSync(manifest, '<Package><Identity Name="x"');
    assert.throws(() => _appx_identity(app), { message: 'Windows package identity manifest is invalid.' });
    writeFileSync(manifest, '<Package/>');
    assert.throws(() => _appx_identity(app), { message: 'Windows package identity is missing.' });
    for (const version of ['1.2.3', '1.2.3.4.5', '1.2.3.x', ' 1.2.3.4']) {
      _write_identity(version);
      assert.throws(() => _appx_identity(app), { message: 'Windows package identity, version, or architecture is invalid.' });
    }
    _write_identity('١.2.3.4'); // Python's \d is Unicode-aware
    assert.equal(_appx_identity(app)[2], '١.2.3.4');
    writeFileSync(manifest, `<p:Package xmlns:p="urn:x"><p:Identity Name="${PACKAGE_NAME}" Publisher="${PACKAGE_PUBLISHER}" Version="1.2.3.4" ProcessorArchitecture="X64"/></p:Package>`);
    assert.deepEqual(_appx_identity(app), [PACKAGE_NAME, PACKAGE_PUBLISHER, '1.2.3.4', 'x64']);
    rmSync(manifest);
    assert.throws(() => _appx_identity(app), { message: 'Windows package identity manifest is missing or redirected.' });
    assert.throws(() => _appx_identity(join(base, 'none')), { message: 'Windows package application directory is missing or redirected.' });
  });

  test('runtime manifest validation messages', () => {
    const file = join(app, 'app/resources/cua_node/manifest.json');
    assert.equal(_runtime_manifest(app).get('runtime_archive_version'), RUNTIME);
    for (const [content, message] of [
      ['﻿{}', 'Windows CUA runtime manifest is invalid.'],
      [Buffer.from([0x7b, 0xff, 0x7d]), 'Windows CUA runtime manifest is invalid.'],
      ['[]', 'Windows CUA runtime manifest is invalid.'],
      ['{"platform":"windows","arch":"x64","runtime_archive_version":" "}', 'Windows CUA runtime manifest has an unsupported platform or architecture.'],
      ['{"platform":"linux","arch":"x64","runtime_archive_version":"v"}', 'Windows CUA runtime manifest has an unsupported platform or architecture.'],
    ]) {
      writeFileSync(file, content);
      assert.throws(() => _runtime_manifest(app), { message });
    }
    rmSync(file);
    assert.throws(() => _runtime_manifest(app), { message: 'Windows CUA runtime manifest is missing or redirected.' });
  });

  test('inventory and digest match lcu/windows.py byte for byte', { skip: !PYTHON && 'python3.12 missing' }, () => {
    mkdirSync(join(app, 'uni/café'), { recursive: true });
    writeFileSync(join(app, 'uni/café/\u{1F600}.txt'), 'x');
    writeFileSync(join(app, 'uni/Z'), 'z');
    mkdirSync(join(app, 'empty'));
    const done = spawnSync(PYTHON, ['-B', '-c',
      'import json, sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from lcu import windows\n' +
      'inv = windows.application_inventory(Path(sys.argv[2]))\n' +
      'print(json.dumps([windows.inventory_sha256(inv), sorted(inv)]))', ORACLE_ROOT, app], { encoding: 'utf8' });
    assert.equal(done.status, 0, done.stderr);
    const [digest, keys] = JSON.parse(done.stdout);
    const inventory = application_inventory(app);
    assert.equal(inventory_sha256(inventory), digest);
    assert.deepEqual([...inventory.keys()].sort(), [...keys].sort());
  });
});
