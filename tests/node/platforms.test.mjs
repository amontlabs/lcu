// Port of tests/test_platforms.py (macOS app validation) and the platform-targeting cases of
// tests/test_installation.py (Linux app validation, trust checks, ACLs), plus cases for the plist
// and dpkg paths that the Python tests cover only indirectly.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'node:test';

import { ValueError } from '../../lcu/compat/pyjson.mjs';
import { InvalidFileException } from '../../lcu/compat/plist.mjs';
import {
  _acl_writers_untrusted, _untrusted_entry, internals, MAC_HELPER, MAC_REQUIRED_FILES,
  resolve_installed_linux_app, resolve_installed_mac_app, _linux_version,
} from '../../lcu/platforms.mjs';
import { skippedOnWindows } from './windows_skip.mjs';

const { describe, it } = skippedOnWindows('validation of the installed macOS and Linux apps (codesign, plutil, dpkg, POSIX modes, ACLs, getuid); Windows validates the Store app in lcu/windows.mjs');

const VERSION = '26.924.22138';
const RUNTIME = '0.0.24/20260924074400-f52ea85e2a98';

const saved = { ...internals };
afterEach(() => Object.assign(internals, saved));

function throwsValueError(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ValueError, `expected ValueError, got ${error?.name}: ${error?.message}`);
    assert.match(error.message, pattern);
    return true;
  });
}

function xmlPlist(values) {
  const body = Object.entries(values).map(([key, value]) => {
    const element = typeof value === 'string' ? `<string>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`
      : typeof value === 'number' ? `<integer>${value}</integer>` : value;
    return `\t<key>${key}</key>\n\t${element}\n`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n' + body + '</dict>\n</plist>\n';
}

function temporary() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'lcu-platforms-')));
  after(() => {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch { /* ignore */ }
  });
  return directory;
}
// node:test hooks: cleanup runs after every test through a per-test list
const cleanups = [];
function after(fn) {
  cleanups.push(fn);
}
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

describe('InstalledMacAppTests', () => {
  let base; let app; let contents; let resources; let cli; let host;

  const writePlist = (file, bundleId, version = null) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const values = { CFBundleIdentifier: bundleId };
    if (version) values.CFBundleShortVersionString = version;
    writeFileSync(file, xmlPlist(values));
  };

  const codesign = (command) => {
    if (command.includes('--verify')) return { returncode: 0, stdout: '', stderr: '' };
    const bundle = command.at(-1);
    const identifier = path.basename(bundle) === 'ChatGPT.app' ? 'com.openai.codex' : 'com.openai.sky.CUAService';
    return { returncode: 0, stdout: '', stderr: `Identifier=${identifier}\nTeamIdentifier=2DC432GLL2\n` };
  };

  beforeEach(() => {
    base = temporary();
    app = path.join(base, 'ChatGPT.app');
    contents = path.join(app, 'Contents');
    resources = path.join(contents, 'Resources');
    writePlist(path.join(contents, 'Info.plist'), 'com.openai.codex', VERSION);
    writePlist(path.join(contents, MAC_HELPER, 'Contents/Info.plist'), 'com.openai.sky.CUAService');
    const runtime = path.join(resources, 'cua_node/manifest.json');
    mkdirSync(path.dirname(runtime), { recursive: true });
    writeFileSync(runtime, JSON.stringify({ platform: 'darwin', arch: 'arm64', runtime_archive_version: RUNTIME }));
    for (const relative of MAC_REQUIRED_FILES) {
      const file = path.join(contents, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, relative);
      chmodSync(file, 0o755);
    }
    cli = path.join(resources, 'codex-cli/bin/codex');
    host = path.join(resources, 'codex-cli/bin/codex-code-mode-host');
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(cli, 'original cli');
    writeFileSync(host, 'original code-mode host');
    chmodSync(cli, 0o755);
    chmodSync(host, 0o755);
    internals.system = () => 'Darwin';
    internals.run = codesign;
  });

  const resolve = (options = {}) => resolve_installed_mac_app(app, { arch: 'arm64', ...options });

  it('accepts current version and runtime with relocated original cli', () => {
    const result = resolve();
    assert.equal(result.app, realpathSync(app));
    assert.equal(result.resources, realpathSync(resources));
    assert.equal(result.runtime, realpathSync(path.join(resources, 'cua_node')));
    assert.deepEqual([result.version, result.runtime_version, result.arch], [VERSION, RUNTIME, 'arm64']);
    assert.deepEqual([result.codex_cli, result.code_mode_host], [realpathSync(cli), realpathSync(host)]);
    assert.equal(result.backend, 'mac');
  });

  it('accepts compatible update without old version runtime or hash pins', () => {
    writePlist(path.join(contents, 'Info.plist'), 'com.openai.codex', '26.999.12345');
    writeFileSync(path.join(resources, 'cua_node/manifest.json'),
      JSON.stringify({ platform: 'darwin', arch: 'arm64', runtime_archive_version: '0.0.99/new-runtime' }));
    writeFileSync(cli, 'updated signed app CLI');
    const result = resolve();
    assert.equal(result.version, '26.999.12345');
    assert.equal(result.runtime_version, '0.0.99/new-runtime');
  });

  it('accepts legacy complete original cli layout', () => {
    unlinkSync(cli);
    unlinkSync(host);
    cli = path.join(resources, 'codex');
    host = path.join(resources, 'codex-code-mode-host');
    writeFileSync(cli, 'legacy cli');
    writeFileSync(host, 'legacy code mode host');
    chmodSync(cli, 0o755);
    chmodSync(host, 0o755);
    const result = resolve();
    assert.deepEqual([result.codex_cli, result.code_mode_host], [realpathSync(cli), realpathSync(host)]);
  });

  it('rejects missing required file and partial cli layout', () => {
    const required = path.join(contents, MAC_REQUIRED_FILES[0]);
    unlinkSync(required);
    throwsValueError(() => resolve(), /required application file is missing/i);
    writeFileSync(required, MAC_REQUIRED_FILES[0]);
    chmodSync(required, 0o755);
    unlinkSync(cli);
    throwsValueError(() => resolve(), /complete original Codex CLI layout/);
  });

  it('rejects wrong platform identity and architecture', () => {
    internals.system = () => 'Linux';
    throwsValueError(() => resolve_installed_mac_app(app, { arch: 'arm64' }), /only be validated on macOS/);
    internals.system = () => 'Darwin';
    throwsValueError(() => resolve({ arch: 'x86' }), /Unsupported macOS architecture/);
    writePlist(path.join(contents, 'Info.plist'), 'wrong.identifier', VERSION);
    throwsValueError(() => resolve(), /Unexpected application bundle identifier/);
  });

  it('rejects invalid signer or signature', () => {
    internals.run = (command, options) => (command.includes('--verify')
      ? { returncode: 1, stdout: '', stderr: 'invalid' } : codesign(command, options));
    throwsValueError(() => resolve_installed_mac_app(app, { arch: 'arm64' }), /signature verification failed/);

    internals.run = (command, options) => {
      const result = codesign(command, options);
      return { ...result, stderr: result.stderr.replace('2DC432GLL2', 'another-team') };
    };
    throwsValueError(() => resolve_installed_mac_app(app, { arch: 'arm64' }), /signer does not match/);
  });

  it('runs codesign with the exact argv and timeouts, app first and then the helper', () => {
    const calls = [];
    internals.run = (command, options) => {
      calls.push([command, options.timeout]);
      return codesign(command, options);
    };
    resolve();
    const helper = path.join(realpathSync(app), 'Contents', MAC_HELPER);
    const real = realpathSync(app);
    assert.deepEqual(calls, [
      [['codesign', '--verify', '--deep', '--strict', real], 120000],
      [['codesign', '-dv', '--verbose=2', real], 30000],
      [['codesign', '--verify', '--deep', '--strict', helper], 120000],
      [['codesign', '-dv', '--verbose=2', helper], 30000],
    ]);
  });

  it('truncates and flattens the signature failure detail like Python', () => {
    internals.run = (command) => (command.includes('--verify')
      ? { returncode: 3, stdout: 'ignored', stderr: ` ${'x\n'.repeat(200)} ` } : { returncode: 0, stderr: '' });
    assert.throws(() => resolve(), (error) => {
      assert.ok(error.message.endsWith(`: ${'x '.repeat(150)}`), error.message);
      return true;
    });
  });

  it('distinguishes missing, wrong-typed and malformed plist values like plistlib', () => {
    // version of the wrong type
    writeFileSync(path.join(contents, 'Info.plist'), xmlPlist({ CFBundleIdentifier: 'com.openai.codex', CFBundleShortVersionString: 7 }));
    throwsValueError(() => resolve(), /Installed application version is missing/);
    // blank version
    writeFileSync(path.join(contents, 'Info.plist'), xmlPlist({ CFBundleIdentifier: 'com.openai.codex', CFBundleShortVersionString: ' \t ' }));
    throwsValueError(() => resolve(), /Installed application version is missing/);
    // version key absent
    writeFileSync(path.join(contents, 'Info.plist'), xmlPlist({ CFBundleIdentifier: 'com.openai.codex' }));
    throwsValueError(() => resolve(), /Installed application version is missing/);
    // identifier of the wrong type or missing is a different identifier
    writeFileSync(path.join(contents, 'Info.plist'), xmlPlist({ CFBundleIdentifier: 5, CFBundleShortVersionString: VERSION }));
    throwsValueError(() => resolve(), /Unexpected application bundle identifier/);
    writeFileSync(path.join(contents, 'Info.plist'), xmlPlist({ CFBundleShortVersionString: VERSION }));
    throwsValueError(() => resolve(), /Unexpected application bundle identifier/);
    // not a plist at all: plistlib.InvalidFileException (a ValueError)
    writeFileSync(path.join(contents, 'Info.plist'), 'hello');
    assert.throws(() => resolve(), (error) => {
      assert.ok(error instanceof InvalidFileException);
      assert.ok(error instanceof ValueError);
      assert.equal(error.message, 'Invalid file');
      return true;
    });
  });

  it('reads binary plists', { skip: !spawnSync('/usr/bin/plutil', ['-help']).error ? false : 'plutil is not available' }, () => {
    const info = path.join(contents, 'Info.plist');
    const converted = spawnSync('/usr/bin/plutil', ['-convert', 'binary1', info]);
    assert.equal(converted.status, 0);
    assert.equal(resolve().version, VERSION);
  });

  it('refuses a symlinked or missing Info.plist and a symlinked app', () => {
    const info = path.join(contents, 'Info.plist');
    const real = path.join(base, 'real.plist');
    writeFileSync(real, xmlPlist({ CFBundleIdentifier: 'com.openai.codex', CFBundleShortVersionString: VERSION }));
    unlinkSync(info);
    symlinkSync(real, info);
    throwsValueError(() => resolve(), /Application bundle metadata is missing/);
    unlinkSync(info);
    throwsValueError(() => resolve(), /Application bundle metadata is missing/);
    const link = path.join(base, 'Link', 'ChatGPT.app');
    mkdirSync(path.dirname(link));
    symlinkSync(app, link);
    throwsValueError(() => resolve_installed_mac_app(link, { arch: 'arm64' }), /Expected a local ChatGPT.app directory/);
    throwsValueError(() => resolve_installed_mac_app(path.join(base, 'Other.app'), { arch: 'arm64' }), /Expected a local ChatGPT.app directory/);
  });

  it('refuses an incompatible manifest and a non-executable runtime binary', () => {
    const manifest = path.join(resources, 'cua_node/manifest.json');
    for (const body of [{ platform: 'linux', arch: 'arm64', runtime_archive_version: RUNTIME },
      { platform: 'darwin', arch: 'x64', runtime_archive_version: RUNTIME },
      { platform: 'darwin', arch: 'arm64', runtime_archive_version: ' ' },
      { platform: 'darwin', arch: 'arm64', runtime_archive_version: 4 }]) {
      writeFileSync(manifest, JSON.stringify(body));
      throwsValueError(() => resolve(), /incompatible platform or architecture/);
    }
    writeFileSync(manifest, JSON.stringify({ platform: 'darwin', arch: 'arm64', runtime_archive_version: RUNTIME }));
    chmodSync(path.join(contents, MAC_REQUIRED_FILES[1]), 0o644);
    throwsValueError(() => resolve(), /executable is not executable: Resources\/cua_node\/bin\/node_repl/);
  });
});

// ---------------------------------------------------------------------------------------------
// Linux application validation (tests/test_installation.py)
// ---------------------------------------------------------------------------------------------

function writeAsar(file, members) {
  const files = {};
  const payload = [];
  let offset = 0;
  for (const [name, content] of Object.entries(members)) {
    let node = files;
    const parts = name.split('/');
    for (const part of parts.slice(0, -1)) {
      node[part] ??= { files: {} };
      node = node[part].files;
    }
    node[parts.at(-1)] = { offset: String(offset), size: content.length };
    payload.push(content);
    offset += content.length;
  }
  const header = Buffer.from(JSON.stringify({ files }));
  const preamble = Buffer.alloc(16);
  [4, 8 + header.length, 4 + header.length, header.length].forEach((value, index) => preamble.writeUInt32LE(value, index * 4));
  writeFileSync(file, Buffer.concat([preamble, header, ...payload]));
}

function applicationFixture(root, { version = '26.924.22138', runtime_version = 'runtime-new', arch = 'arm64', relocated = false } = {}) {
  const app = root;
  const resources = path.join(app, 'resources');
  const runtime = path.join(resources, 'cua_node');
  const executable = '#!/bin/sh\nexit 0\n';
  const cua = 'resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs';
  for (const relative of ['ChatGPT', 'resources/cua_node/bin/node', 'resources/cua_node/bin/node_repl', cua]) {
    const file = path.join(app, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, relative !== cua ? executable : 'export {};\n');
    if (relative !== cua) chmodSync(file, 0o755);
  }
  const tools = relocated ? path.join(resources, 'codex-cli/bin') : resources;
  for (const name of ['codex', 'codex-code-mode-host']) {
    const file = path.join(tools, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, executable);
    chmodSync(file, 0o755);
  }
  mkdirSync(resources, { recursive: true });
  writeAsar(path.join(resources, 'app.asar'), { 'package.json': Buffer.from(JSON.stringify({ name: 'chatgpt', version })) });
  writeFileSync(path.join(runtime, 'manifest.json'), JSON.stringify({ platform: 'linux', arch, runtime_archive_version: runtime_version }));
  mkdirSync(path.join(resources, 'plugins/openai-bundled/plugins/browser'), { recursive: true });
  for (const relative of [
    'plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json',
    `plugins/openai-bundled/plugins/chrome/extension-host/linux/${arch}/extension-host`,
    'plugins/openai-bundled/plugins/unified-computer-use/.mcp.json',
    'plugins/openai-bundled/plugins/browser/install.js',
  ]) {
    const file = path.join(resources, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, relative.endsWith('extension-host') ? executable : '{}\n');
    if (relative.endsWith('extension-host')) chmodSync(file, 0o755);
  }
  return app;
}

describe('Linux installed application (test_installation.py)', () => {
  let root;
  beforeEach(() => {
    root = temporary();
  });
  const resolveLinux = (app, options = {}) => resolve_installed_linux_app(app, { arch: 'arm64', ...options });
  const real = (file) => realpathSync(file);

  it('missing required runtime file rejects the app', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'));
    unlinkSync(path.join(app, 'resources/cua_node/bin/node_repl'));
    throwsValueError(() => resolveLinux(app), /Application payload is incomplete/);
  });

  it('wrong architecture app is rejected', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'), { arch: 'x64' });
    throwsValueError(() => resolveLinux(app), /unsupported platform, architecture/);
  });

  it('accepts the fixture and reports the asar version', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'), { relocated: true });
    const result = resolveLinux(app);
    assert.equal(result.app, real(app));
    assert.equal(result.version, '26.924.22138');
    assert.equal(result.runtime_version, 'runtime-new');
    assert.equal(result.backend, 'linux');
    assert.equal(result.codex_cli, path.join(real(app), 'resources/codex-cli/bin/codex'));
  });

  it('app tree writable by other accounts is rejected', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'));
    resolveLinux(app);
    const directory = path.join(app, 'resources/cua_node/bin');
    chmodSync(directory, 0o777);
    throwsValueError(() => resolveLinux(app), /not in a location only root and this account/);
    chmodSync(directory, 0o755);
    chmodSync(path.join(app, 'resources/cua_node/bin/node'), 0o757);
    throwsValueError(() => resolveLinux(app), /writable by group or other/);
  });

  it('app tree owned by another account is rejected unless trusted', { skip: process.getuid?.() === 0 && 'root-owned files are always trusted' }, () => {
    const app = applicationFixture(path.join(root, 'chatgpt'));
    const other = process.getuid?.();
    internals.getuid = () => other + 1;
    internals.geteuid = () => other + 1;
    throwsValueError(() => resolveLinux(app), new RegExp(`owned by uid ${other}`));
    assert.equal(resolveLinux(app, { trusted_uids: new Set([other]) }).app, real(app));
  });

  it('writable ancestor directory is rejected but sticky is allowed', () => {
    const app = applicationFixture(path.join(root, 'shared/chatgpt'));
    chmodSync(path.join(root, 'shared'), 0o777);
    throwsValueError(() => resolveLinux(app), /shared is writable/);
    chmodSync(path.join(root, 'shared'), 0o1777);
    resolveLinux(app);
  });

  it('runtime path that escapes the app tree is rejected', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'));
    const outside = applicationFixture(path.join(root, 'elsewhere'));
    rmSync(path.join(app, 'resources/cua_node/bin'), { recursive: true });
    symlinkSync(path.join(outside, 'resources/cua_node/bin'), path.join(app, 'resources/cua_node/bin'), 'dir');
    throwsValueError(() => resolveLinux(app), /outside the application/);
  });

  it('read-only mount is checked like any other tree', { skip: process.getuid?.() === 0 && 'root-owned files are always trusted' }, () => {
    // Python patches os.statvfs to report ST_RDONLY; the validation never consults statvfs, so only the
    // ownership/mode outcomes are asserted (a mount flag has no effect on them).
    const app = applicationFixture(path.join(root, 'chatgpt'));
    const owner = process.getuid?.();
    const other = owner + 1;
    internals.getuid = () => other;
    internals.geteuid = () => other;
    throwsValueError(() => resolveLinux(app), new RegExp(`owned by uid ${owner}`));
    assert.equal(resolveLinux(app, { trusted_uids: new Set([owner]) }).app, real(app));
    Object.assign(internals, saved);
    chmodSync(path.join(app, 'resources/cua_node/bin/node'), 0o757);
    throwsValueError(() => resolveLinux(app), /writable by group or other/);
  });

  const chromeScript = (app, name = 'scripts/installManifest.mjs') => {
    const file = path.join(app, 'resources/plugins/openai-bundled/plugins/chrome', name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'export {};\n');
    return file;
  };

  it('executed chrome plugin scripts must be unwritable by others', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'));
    const install = chromeScript(app);
    const diagnostic = chromeScript(app, 'scripts/diagnostics/status.mjs');
    resolveLinux(app);
    for (const target of [install, diagnostic, path.dirname(diagnostic)]) {
      const before = require_mode(target);
      chmodSync(target, before | 0o002);
      throwsValueError(() => resolveLinux(app), /writable by group or other/);
      chmodSync(target, before);
    }
    resolveLinux(app);
  });

  it('other plugin trees are covered too', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'));
    const script = path.join(app, 'resources/plugins/openai-bundled/plugins/browser/scripts/run.mjs');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, 'export {};\n');
    chmodSync(script, 0o666);
    throwsValueError(() => resolveLinux(app), /writable by group or other/);
  });

  it('link to a writable directory elsewhere in the app is followed', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'));
    const shared = path.join(app, 'resources/shared');
    mkdirSync(shared);
    const payload = path.join(shared, 'dependency.js');
    writeFileSync(payload, 'export {};\n');
    const modules = path.join(app, 'resources/cua_node/lib/node_modules');
    symlinkSync(shared, path.join(modules, 'linked'), 'dir');
    resolveLinux(app);
    chmodSync(payload, 0o666);
    throwsValueError(() => resolveLinux(app), /dependency.js is writable by group or other/);
    chmodSync(payload, 0o644);
    chmodSync(shared, 0o777);
    throwsValueError(() => resolveLinux(app), /shared is writable by group or other/);
  });

  it('link to a file elsewhere in the app is validated', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'));
    const target = path.join(app, 'resources/helper.mjs');
    writeFileSync(target, 'export {};\n');
    symlinkSync(target, path.join(app, 'resources/cua_node/lib/node_modules/helper.mjs'));
    resolveLinux(app);
    chmodSync(target, 0o666);
    throwsValueError(() => resolveLinux(app), /helper.mjs is writable by group or other/);
  });

  it('link cycles and repeated links terminate', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'));
    const modules = path.join(app, 'resources/cua_node/lib/node_modules');
    symlinkSync(modules, path.join(modules, 'loop'), 'dir');
    symlinkSync(path.join(modules, 'loop'), path.join(modules, 'again'), 'dir');
    // The loop links point at the (valid) node_modules directory itself: accepted, each walked once.
    resolveLinux(app);
  });

  it('broken or looping links are reported', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'));
    const modules = path.join(app, 'resources/cua_node/lib/node_modules');
    symlinkSync(path.join(modules, 'missing'), path.join(modules, 'broken'));
    throwsValueError(() => resolveLinux(app), /broken is a broken or looping link/);
    unlinkSync(path.join(modules, 'broken'));
    symlinkSync(path.join(modules, 'b'), path.join(modules, 'a'));
    symlinkSync(path.join(modules, 'a'), path.join(modules, 'b'));
    throwsValueError(() => resolveLinux(app), /is a broken or looping link/);
  });

  it('link that escapes the app is refused anywhere in a tree', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'));
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(app, 'resources/plugins/openai-bundled/plugins/chrome/escape'), 'dir');
    throwsValueError(() => resolveLinux(app), /escape links outside the application/);
  });

  it('reports at most three problems and counts the rest', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'));
    const modules = path.join(app, 'resources/cua_node/lib/node_modules');
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      writeFileSync(path.join(modules, name), 'x');
      chmodSync(path.join(modules, name), 0o666);
    }
    assert.throws(() => resolveLinux(app), (error) => {
      assert.match(error.message, /; and 2 more\. Install the app with a package manager/);
      assert.equal(error.message.match(/ is writable by group or other accounts/g).length, 3);
      return true;
    });
  });

  it('group write requires every group member to be trusted', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'));
    chmodSync(path.join(app, 'resources/cua_node/bin/node'), 0o775);
    const stranger = process.getuid?.() + 1000;
    internals.group_members = () => new Set([stranger]);
    throwsValueError(() => resolveLinux(app), /writable by group or other/);
    internals.group_members = () => null;
    throwsValueError(() => resolveLinux(app), /writable by group or other/);
    internals.group_members = () => new Set([0, process.getuid?.()]);
    resolveLinux(app);
  });

  it('group membership is looked up once per group within a validation pass', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'));
    for (const name of ['node', 'node_repl']) chmodSync(path.join(app, 'resources/cua_node/bin', name), 0o775);
    const seen = [];
    internals.group_members = (gid) => {
      seen.push(gid);
      return new Set([0, process.getuid?.()]);
    };
    resolveLinux(app);
    assert.equal(new Set(seen).size, seen.length);
    assert.ok(seen.length >= 1);
  });

  it('group zero is not trusted by its number alone', () => {
    const info = { uid: 0, gid: 0, mode: 0o100664 };
    assert.notEqual(_untrusted_entry('/x', info, new Set([0]), () => new Set([0, 1234])), null);
    assert.equal(_untrusted_entry('/x', info, new Set([0]), () => new Set([0])), null);
  });

  const acl = (...entries) => {
    const blob = Buffer.alloc(4 + entries.length * 8);
    blob.writeUInt32LE(2, 0);
    entries.forEach(([tag, perm, id], index) => {
      blob.writeUInt16LE(tag, 4 + index * 8);
      blob.writeUInt16LE(perm, 6 + index * 8);
      blob.writeUInt32LE(id, 8 + index * 8);
    });
    return blob;
  };

  it('named acl entries with write are untrusted unless masked or trusted', () => {
    const [USER, GROUP, MASK, OBJ] = [0x02, 0x08, 0x10, 0x01];
    const noGroup = () => new Set();
    const base = [OBJ, 6, 0xFFFFFFFF];
    assert.match(_acl_writers_untrusted(acl(base, [USER, 6, 4242], [MASK, 7, 0xFFFFFFFF]), new Set([0]), noGroup), /uid 4242 through a POSIX ACL/);
    assert.equal(_acl_writers_untrusted(acl(base, [USER, 6, 4242], [MASK, 5, 0xFFFFFFFF]), new Set([0]), noGroup), null); // the mask removes write
    assert.equal(_acl_writers_untrusted(acl(base, [USER, 4, 4242], [MASK, 7, 0xFFFFFFFF]), new Set([0]), noGroup), null); // read only
    assert.equal(_acl_writers_untrusted(acl(base, [USER, 6, 4242], [MASK, 7, 0xFFFFFFFF]), new Set([0, 4242]), noGroup), null);
    assert.match(_acl_writers_untrusted(acl(base, [GROUP, 6, 50], [MASK, 7, 0xFFFFFFFF]), new Set([0]), () => new Set([4242])), /group 50/);
    assert.match(_acl_writers_untrusted(Buffer.from('garbage'), new Set([0]), noGroup), /cannot read/);
  });

  it('a writable acl on an app file is rejected', () => {
    const app = applicationFixture(path.join(root, 'chatgpt'));
    const blob = acl([0x01, 6, 0xFFFFFFFF], [0x02, 6, process.getuid?.() + 1000], [0x10, 7, 0xFFFFFFFF]);
    const target = real(path.join(app, 'resources/cua_node/bin/node_repl'));
    const original = internals.posix_acl;
    internals.posix_acl = (file) => (file === target ? blob : original(file));
    throwsValueError(() => resolveLinux(app), /node_repl is writable by uid .* through a POSIX ACL/);
  });
});

function require_mode(file) {
  return spawnSync('/usr/bin/stat', process.platform === 'darwin' ? ['-f', '%Lp', file] : ['-c', '%a', file], { encoding: 'utf8' })
    .stdout.trim().split('').reduce((total, digit) => total * 8 + Number(digit), 0);
}

// ---------------------------------------------------------------------------------------------
// _linux_version: app.asar first, then the package manager's record of the executable path
// ---------------------------------------------------------------------------------------------
describe('_linux_version', () => {
  let root;
  let app;
  beforeEach(() => {
    root = temporary();
    app = applicationFixture(path.join(root, 'chatgpt'));
  });
  const dpkg = (handlers) => {
    const calls = [];
    internals.run = (command, options) => {
      calls.push([command, options.timeout, options.check]);
      return handlers(command);
    };
    return calls;
  };

  it('reads package.json from app.asar', () => {
    assert.equal(_linux_version(app, 'arm64'), '26.924.22138');
  });

  it('falls back to dpkg when the asar version is not a plain version string', () => {
    writeAsar(path.join(app, 'resources/app.asar'), { 'package.json': Buffer.from(JSON.stringify({ version: 'bad version!' })) });
    const calls = dpkg((command) => (command[1] === '-S'
      ? { returncode: 0, stdout: `chatgpt:arm64: ${app}/ChatGPT\nother: /x\n`, stderr: '' }
      : { returncode: 0, stdout: '1.2.3-4 arm64\n', stderr: '' }));
    assert.equal(_linux_version(app, 'arm64'), '1.2.3-4');
    assert.deepEqual(calls, [
      [['dpkg-query', '-S', '--', `${app}/ChatGPT`], 20000, true],
      [['dpkg-query', '-W', '--showformat=%v %a', 'chatgpt:arm64'], 20000, true],
    ]);
  });

  it('falls back to dpkg when app.asar is unreadable', () => {
    unlinkSync(path.join(app, 'resources/app.asar'));
    dpkg((command) => (command[1] === '-S'
      ? { returncode: 0, stdout: `chatgpt: ${app}/ChatGPT\n`, stderr: '' }
      : { returncode: 0, stdout: '2.0 amd64\n', stderr: '' }));
    assert.equal(_linux_version(app, 'x64'), '2.0');
  });

  it('refuses when no unique chatgpt package owns the path, or the architecture is wrong', () => {
    unlinkSync(path.join(app, 'resources/app.asar'));
    dpkg(() => ({ returncode: 0, stdout: `notchatgpt: ${app}/ChatGPT\n`, stderr: '' }));
    throwsValueError(() => _linux_version(app, 'arm64'), /^No unique chatgpt package owns the selected executable path$/);
    dpkg((command) => (command[1] === '-S'
      ? { returncode: 0, stdout: `chatgpt: ${app}/ChatGPT\n`, stderr: '' }
      : { returncode: 0, stdout: '2.0 amd64\n', stderr: '' }));
    throwsValueError(() => _linux_version(app, 'arm64'), /^The selected dpkg-owned ChatGPT path has the wrong architecture$/);
    dpkg((command) => (command[1] === '-S'
      ? { returncode: 0, stdout: `chatgpt: ${app}/ChatGPT\n`, stderr: '' }
      : { returncode: 0, stdout: 'bad/version arm64\n', stderr: '' }));
    throwsValueError(() => _linux_version(app, 'arm64'), /^Cannot determine the selected app version from app.asar or its dpkg-owned path$/);
  });

  it('turns dpkg-query failures into the same ValueError', () => {
    unlinkSync(path.join(app, 'resources/app.asar'));
    internals.run = () => {
      throw Object.assign(new Error('spawn dpkg-query ENOENT'), { code: 'ENOENT' });
    };
    throwsValueError(() => _linux_version(app, 'arm64'), /^Cannot determine the selected app version from app.asar or its dpkg-owned path$/);
  });
});
