// Regressions for .port/reviews/port-platforms.md findings 4, 6, 7 and 11 on lcu/doctor.mjs, reproducing
// .port/reviews/probes-platforms/doctor/ with real child processes (harmless /bin/sh and node children only).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import * as doctor from '../../lcu/doctor.mjs';
import { MAC_HELPER } from '../../lcu/platforms.mjs';

const { internals } = doctor;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const saved = { ...internals };
let base;
let output;
beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'lcu-doctor-reg-')));
  output = '';
  internals.write = (text) => { output += text; };
});
afterEach(() => {
  Object.assign(internals, saved);
  rmSync(base, { recursive: true, force: true });
});

// A fake "node" for the probe: a shell script printing the given bytes and exiting with `status`.
function fakeNode(bytes, status) {
  const file = path.join(base, 'fake-node');
  writeFileSync(file, `#!/bin/sh\nprintf '${[...bytes].map((b) => `\\${b.toString(8).padStart(3, '0')}`).join('')}' >&${status ? 2 : 1}\nexit ${status}\n`);
  chmodSync(file, 0o755);
  const runtime = path.join(base, 'runtime');
  mkdirSync(path.join(runtime, 'lib'), { recursive: true });
  return { runtime, env: { NODE_REPL_NODE_PATH: file, PATH: '/usr/bin:/bin' } };
}

describe('finding 11: probe stderr is read with universal newlines and replacement decoding', () => {
  it('CRLF/CR become spaces in the failure detail, like Python', () => {
    const { runtime, env } = fakeNode(Buffer.from('first\r\nsecond\rthird\n'), 1);
    assert.throws(() => doctor._probe(runtime, env, 'linux'), (error) => {
      assert.equal(error.message, 'first second third');
      return true;
    });
  });

  it('undecodable bytes become U+FFFD (errors="replace") instead of failing', () => {
    const { runtime, env } = fakeNode(Buffer.from([0x62, 0xff, 0x61, 0x64]), 1);
    assert.throws(() => doctor._probe(runtime, env, 'linux'), { message: 'b�ad' });
  });
});

describe('finding 7: Python truthiness for numeric probe results', () => {
  it('a 0.0 window check is not "passed", so readiness is false', () => {
    const { runtime, env } = fakeNode(Buffer.from('{"target":"linux","windows":{"ok":0.0,"count":1},"screenshot":{"ok":true,"count":1}}\n'), 0);
    const probe = doctor._probe(runtime, env, 'linux');
    assert.equal(doctor._print_linux_status(probe), false);
    assert.match(output, /^Window listing: could not verify\. /);
  });

  it('a 1.0 check and a NaN check are true like Python floats', () => {
    const { runtime, env } = fakeNode(Buffer.from('{"target":"linux","windows":{"ok":1.0,"count":1},"screenshot":{"ok":NaN,"count":1}}\n'), 0);
    assert.equal(doctor._print_linux_status(doctor._probe(runtime, env, 'linux')), true);
  });
});

describe('finding 6: the sandbox probe directory follows tempfile.gettempdir()', () => {
  it('an unusable TMPDIR falls back to TEMP, as Python does', () => {
    const temp = path.join(base, 'temp');
    mkdirSync(temp);
    const script = `
      const doctor = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'lcu/doctor.mjs')).href)});
      let cwd = null;
      doctor.internals.run = (command, options) => { cwd = options.cwd; return { returncode: 12, stdout: '', stderr: '' }; };
      const result = doctor.linux_sandbox_works({ CODEX_CLI_PATH: '/fixture/codex' });
      process.stdout.write(JSON.stringify({ result, cwd }));`;
    const done = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { PATH: '/usr/bin:/bin', TMPDIR: path.join(base, 'missing'), TEMP: temp, TMP: temp }, encoding: 'utf8',
    });
    assert.equal(done.status, 0, done.stderr);
    const { result, cwd } = JSON.parse(done.stdout);
    assert.deepEqual(result, [true, '']);
    assert.equal(path.dirname(cwd), temp);
    assert.match(path.basename(cwd), /^lcu-sandbox-probe-[a-z0-9_]{8}$/);
  });
});

describe('finding 4: display names read through the plistlib-equivalent parser', () => {
  const write = (bundle, bytes) => {
    mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
    writeFileSync(path.join(bundle, 'Contents/Info.plist'), bytes);
  };
  const doc = (name) => `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleDisplayName</key><string>${name}</string></dict></plist>`;

  it('a UTF-16 plist gives its name', () => {
    const app = path.join(base, 'ChatGPT.app');
    write(app, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(doc('Selected').replace('UTF-8', 'UTF-16'), 'utf16le')]));
    write(path.join(app, 'Contents', MAC_HELPER), doc('Helper'));
    assert.equal(doctor.mac_permission_targets(app).screen_capture[0], 'Selected');
  });

  it('a malformed plist raises ExpatError (uncaught in Python too), not a silent name', () => {
    const app = path.join(base, 'ChatGPT.app');
    write(app, doc('Display &unknown;'));
    write(path.join(app, 'Contents', MAC_HELPER), doc('Helper'));
    assert.throws(() => doctor.mac_permission_targets(app), { name: 'ExpatError' });
  });
});

describe('the inline probe script runs from a scratch directory', () => {
  it('imports nothing relative to the LCU release (only the original service)', () => {
    const specifiers = [...doctor.PROBE.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((match) => match[1]);
    assert.ok(specifiers.includes('@oai/sky/service'));
    assert.deepEqual(specifiers.filter((name) => name.startsWith('.')), []);
  });
});
