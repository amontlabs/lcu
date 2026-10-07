// Regressions for .port/reviews/port-platforms.md findings 3, 4 and 10 (the ACL findings 1, 2 and 9 are in
// platforms_acl*.test.mjs): each reproduces the review probe with real files and processes.
import assert from 'node:assert/strict';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'node:test';

import { internals, MAC_HELPER, MAC_REQUIRED_FILES, resolve_installed_linux_app, resolve_installed_mac_app } from '../../lcu/platforms.mjs';
import { ValueError } from '../../lcu/compat/pyjson.mjs';
import { ExpatError } from '../../lcu/compat/plist.mjs';
import { run } from '../../lcu/compat/subprocess.mjs';
import { skippedOnWindows } from './windows_skip.mjs';

const { describe, it } = skippedOnWindows('regressions of the macOS/Linux installed-app validation (lcu/platforms.mjs: plist, codesign, modes, dpkg); never runs on Windows');

const VERSION = '26.924.22138';
const saved = { ...internals };
let base;
beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'lcu-platforms-reg-')));
});
afterEach(() => {
  Object.assign(internals, saved);
  const restore = (dir) => {
    try {
      chmodSync(dir, 0o755);
    } catch { /* ignore */ }
  };
  restore(path.join(base, 'app/resources/cua_node'));
  rmSync(base, { recursive: true, force: true });
});

function macApp(infoPlist) {
  const app = path.join(base, 'ChatGPT.app');
  const contents = path.join(app, 'Contents');
  mkdirSync(contents, { recursive: true });
  writeFileSync(path.join(contents, 'Info.plist'), infoPlist);
  const helper = path.join(contents, MAC_HELPER, 'Contents');
  mkdirSync(helper, { recursive: true });
  writeFileSync(path.join(helper, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
    '<key>CFBundleIdentifier</key><string>com.openai.sky.CUAService</string></dict></plist>');
  const manifest = path.join(contents, 'Resources/cua_node/manifest.json');
  mkdirSync(path.dirname(manifest), { recursive: true });
  writeFileSync(manifest, JSON.stringify({ platform: 'darwin', arch: 'arm64', runtime_archive_version: 'r' }));
  for (const relative of [...MAC_REQUIRED_FILES, 'Resources/codex', 'Resources/codex-code-mode-host']) {
    const file = path.join(contents, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'x');
    chmodSync(file, 0o755);
  }
  return app;
}

const identity = (extra = '') => '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
  `<key>CFBundleIdentifier</key><string>com.openai.codex${extra}</string>` +
  `<key>CFBundleShortVersionString</key><string>${VERSION}</string></dict></plist>`;

const fakeCodesign = (command) => {
  if (command.includes('--verify')) return { returncode: 0, stdout: '', stderr: '' };
  const identifier = path.basename(command.at(-1)) === 'ChatGPT.app' ? 'com.openai.codex' : 'com.openai.sky.CUAService';
  return { returncode: 0, stdout: '', stderr: `Identifier=${identifier}\nTeamIdentifier=2DC432GLL2\n` };
};

describe('finding 4: Info.plist identity is read exactly as plistlib reads it', () => {
  beforeEach(() => {
    internals.system = () => 'Darwin';
    internals.run = fakeCodesign;
  });

  it('accepts the well-formed identity', () => {
    assert.equal(resolve_installed_mac_app(macApp(identity()), { arch: 'arm64' }).version, VERSION);
  });

  for (const [label, document] of [
    ['multiple roots', identity().replace('</plist>', '</plist><junk/>')],
    ['unknown entity', identity(' &unknown;')],
    ['invalid control character', identity('\x01')],
  ]) {
    it(`refuses (ExpatError, not a ValueError) a plist with ${label}`, () => {
      const app = macApp(document);
      assert.throws(() => resolve_installed_mac_app(app, { arch: 'arm64' }), (error) => {
        assert.ok(error instanceof ExpatError, `${error.name}: ${error.message}`);
        assert.ok(!(error instanceof ValueError));
        return true;
      });
    });
  }

  it('accepts a valid UTF-16 plist', () => {
    const text = identity().replace('encoding="UTF-8"', 'encoding="UTF-16"');
    const app = macApp(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    assert.equal(resolve_installed_mac_app(app, { arch: 'arm64' }).version, VERSION);
  });
});

describe('finding 3: codesign output is decoded strictly, like text=True', () => {
  beforeEach(() => {
    internals.system = () => 'Darwin';
  });
  // A real child process (the shell) emits the bytes; only the argv is replaced, the options pass through.
  const shell = (script) => (command, options) => run(['/bin/sh', '-c', script(command)], options);

  it('an undecodable byte during verification raises UnicodeDecodeError', () => {
    internals.run = shell((command) => (command.includes('--verify') ? "printf '\\377' >&2; exit 0"
      : `printf 'Identifier=${path.basename(command.at(-1)) === 'ChatGPT.app' ? 'com.openai.codex' : 'com.openai.sky.CUAService'}\\nTeamIdentifier=2DC432GLL2\\n' >&2`));
    assert.throws(() => resolve_installed_mac_app(macApp(identity()), { arch: 'arm64' }), (error) => {
      assert.equal(error.name, 'UnicodeDecodeError');
      assert.ok(error instanceof ValueError);
      assert.match(error.message, /'utf-8' codec can't decode byte 0xff in position 0: invalid start byte/);
      return true;
    });
  });

  it('an undecodable byte during signer inspection raises UnicodeDecodeError', () => {
    internals.run = shell((command) => (command.includes('--verify') ? 'exit 0'
      : "printf 'Identifier=com.openai.codex\\nTeamIdentifier=2DC432GLL2\\n\\377' >&2"));
    assert.throws(() => resolve_installed_mac_app(macApp(identity()), { arch: 'arm64' }), { name: 'UnicodeDecodeError' });
  });

  it('CRLF and CR in a failure detail are newlines, as Python text mode reads them (finding 11)', () => {
    internals.run = shell((command) => (command.includes('--verify') ? "printf 'first\\r\\nsecond\\rthird\\n' >&2; exit 1" : 'exit 0'));
    assert.throws(() => resolve_installed_mac_app(macApp(identity()), { arch: 'arm64' }),
      /signature verification failed: .*ChatGPT\.app: first second third$/);
  });
});

describe('finding 10: stat errors other than "missing" propagate like Python 3.12 pathlib', { skip: process.getuid?.() === 0 && 'root ignores directory permissions' }, () => {
  it('a non-searchable runtime directory is a PermissionError, not "manifest is missing"', () => {
    const app = path.join(base, 'app');
    const runtime = path.join(app, 'resources/cua_node');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(path.join(runtime, 'manifest.json'), '{}');
    chmodSync(runtime, 0o000);
    assert.throws(() => resolve_installed_linux_app(app, { arch: 'arm64' }), (error) => {
      assert.equal(error.name, 'PermissionError');
      assert.equal(error.message, `[Errno 13] Permission denied: '${path.join(runtime, 'manifest.json')}'`);
      return true;
    });
  });

  it('a missing runtime manifest is still the ValueError', () => {
    const app = path.join(base, 'app');
    mkdirSync(path.join(app, 'resources/cua_node'), { recursive: true });
    assert.throws(() => resolve_installed_linux_app(app, { arch: 'arm64' }), /Application runtime manifest is missing/);
    void readFileSync;
  });
});
