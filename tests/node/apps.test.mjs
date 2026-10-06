// Port of tests/test_apps.py (plus the extra cases listed in .port/notes/apps.md): `lcu apps` resolution, edits,
// warnings and fail-closed authentication, all against a temp HOME. Run with `node --test tests/node/apps.test.mjs`.
import { python312 } from './runtime_support.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import * as apps from '../../lcu/apps.mjs';
import { io, PySystemExit } from '../../lcu/compat/argparse.mjs';
import { ORACLE_ROOT } from './oracle_root.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const APPS_URL = new URL('../../lcu/apps.mjs', import.meta.url).href;
const PLUTIL = existsSync('/usr/bin/plutil');
// The oracle must be CPython 3.12 (argparse/help text differs in later versions).
const PYTHON = python312() ?? undefined; // exactly CPython 3.12.10 (never a PATH python3: 3.12.3 and 3.14 word argparse differently)

const escapeXml = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function plistXml(info) {
  const body = Object.entries(info).map(([key, value]) => `<key>${key}</key><string>${escapeXml(value)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" `
    + `"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`;
}

function makeApp(directory, name, identifier, display = null) {
  const contents = join(directory, `${name}.app`, 'Contents');
  mkdirSync(contents, { recursive: true });
  const info = { CFBundleIdentifier: identifier, CFBundleName: name };
  if (display) info.CFBundleDisplayName = display;
  writeFileSync(join(contents, 'Info.plist'), plistXml(info));
  return join(directory, `${name}.app`);
}

const temporaries = [];
after(() => { for (const dir of temporaries) rmSync(dir, { recursive: true, force: true }); });

describe('AppsTests', () => {
  let home; let applications; let store; let calls; let saved;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'lcu-apps-')));
    temporaries.push(home);
    applications = join(home, 'Applications');
    mkdirSync(applications);
    store = apps.store_path(home);
    calls = [];
    saved = { ...apps.hooks };
    apps.hooks.app_directories = () => [applications];
    apps.hooks._mdfind = () => [];
    makeApp(applications, 'Zed', 'dev.zed.Zed');
    makeApp(applications, 'Safari', 'com.apple.Safari');
    makeApp(applications, 'Terminal', 'com.apple.Terminal');
  });

  afterEach(() => {
    Object.assign(apps.hooks, saved);
    rmSync(home, { recursive: true, force: true });
  });

  const auth = (approve = true) => (_root, reason) => {
    calls.push(reason);
    if (!approve) throw new apps.AppsError('authentication was cancelled or failed. Nothing was changed.');
  };

  function runApps(argv, { approve = true, platform = 'darwin' } = {}) {
    let out = ''; let err = '';
    const real = { stdout: io.stdout, stderr: io.stderr };
    io.stdout = (text) => { out += text; };
    io.stderr = (text) => { err += text; };
    let code = 0;
    try {
      apps.main(ROOT, argv, { platform, home, auth: auth(approve) });
    } catch (error) {
      if (!(error instanceof PySystemExit)) throw error;
      code = error.status;
    } finally {
      Object.assign(io, real);
    }
    return [code, out, err];
  }

  const writeStore = (document) => {
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(store, typeof document === 'string' ? document : JSON.stringify(document));
  };
  const ids = () => JSON.parse(readFileSync(store, 'utf8'))[apps.KEY];

  // Resolution
  it('name, bundle id and path resolve to the same app', () => {
    for (const query of ['Zed', 'zed', 'dev.zed.Zed', join(applications, 'Zed.app')]) {
      assert.deepEqual(apps.resolve(query, { home }), ['dev.zed.Zed', 'Zed', true]);
    }
  });

  it('display name matches and ambiguity is refused', () => {
    makeApp(applications, 'Code', 'com.example.code', 'Visual Code');
    assert.equal(apps.resolve('Visual Code', { home })[0], 'com.example.code');
    makeApp(applications, 'Zed Preview', 'dev.zed.Zed-Preview', 'Zed');
    assert.throws(() => apps.resolve('Zed', { home }), (e) => e instanceof apps.AppsError && /matches several apps/.test(e.message));
  });

  it('unknown name is an error and unknown bundle id is reported not installed', () => {
    assert.throws(() => apps.resolve('Nope', { home }), (e) => e instanceof apps.AppsError && /no installed app named "Nope"/.test(e.message));
    assert.deepEqual(apps.resolve('com.gone.App', { home }), ['com.gone.App', 'com.gone.App', false]);
  });

  // List
  it('list shows names, ids and flags and needs no authentication', () => {
    writeStore({ [apps.KEY]: ['dev.zed.Zed', 'com.apple.Safari', 'com.gone.App'] });
    const [code, out] = runApps([]);
    assert.equal(code, 0);
    assert.ok(out.includes('Zed'));
    assert.ok(out.includes('dev.zed.Zed'));
    assert.match(out, /Safari\s+com\.apple\.Safari\s+\(high risk\)/);
    assert.ok(out.includes('com.gone.App  (not installed)'));
    assert.deepEqual(calls, []);
  });

  it('list json and empty list', () => {
    let [, out] = runApps(['list']);
    assert.ok(out.includes('No apps are always allowed'));
    writeStore({ [apps.KEY]: ['com.apple.Terminal', 'dev.zed.Zed'] });
    [, out] = runApps(['--json']);
    const listed = JSON.parse(out);
    assert.deepEqual(listed.apps.map((a) => a.bundleId), ['com.apple.Terminal', 'dev.zed.Zed']);
    assert.equal(listed.apps[0].blocked, true);
    assert.deepEqual(listed.apps[1], { name: 'Zed', bundleId: 'dev.zed.Zed', installed: true, risk: 'normal', blocked: false });
    assert.equal(listed.file, store);
  });

  // Allow
  it('allow authenticates with a clear reason then adds and is idempotent', () => {
    let [code] = runApps(['allow', 'Zed']);
    assert.equal(code, 0);
    assert.deepEqual(calls, ['always allow Computer Use to control Zed (dev.zed.Zed)']);
    assert.deepEqual(ids(), ['dev.zed.Zed']);
    let out;
    [code, out] = runApps(['allow', 'dev.zed.Zed']);
    assert.equal(code, 0);
    assert.ok(out.includes('already always allowed'));
    assert.equal(calls.length, 1);
    assert.deepEqual(ids(), ['dev.zed.Zed']);
  });

  it('failed authentication changes nothing', () => {
    const [code, , err] = runApps(['allow', 'Zed'], { approve: false });
    assert.equal(code, 1);
    assert.ok(err.includes('Nothing was changed'));
    assert.equal(existsSync(store), false);
    writeStore({ [apps.KEY]: ['dev.zed.Zed'] });
    const before = readFileSync(store);
    assert.equal(runApps(['revoke', 'Zed'], { approve: false })[0], 1);
    assert.deepEqual(readFileSync(store), before);
  });

  it('unknown keys and order are preserved', () => {
    writeStore({ schema: 3, [apps.KEY]: ['b.id'], extra: { a: [1] } });
    runApps(['allow', 'Zed']);
    assert.deepEqual(JSON.parse(readFileSync(store, 'utf8')), { schema: 3, [apps.KEY]: ['b.id', 'dev.zed.Zed'], extra: { a: [1] } });
    runApps(['revoke', 'dev.zed.Zed']);
    assert.deepEqual(JSON.parse(readFileSync(store, 'utf8')), { schema: 3, [apps.KEY]: ['b.id'], extra: { a: [1] } });
    assert.deepEqual(readdirSync(dirname(store)), [store.split('/').at(-1)]);
  });

  it('forbidden app is refused without prompting or writing', () => {
    const [code, , err] = runApps(['allow', 'Terminal']);
    assert.equal(code, 1);
    assert.ok(err.includes('never controls Terminal'));
    assert.deepEqual(calls, []);
    assert.equal(existsSync(store), false);
  });

  it('high risk app warns and says so in the prompt', () => {
    const [code, , err] = runApps(['allow', 'Safari']);
    assert.equal(code, 0);
    assert.ok(err.includes('high risk'));
    assert.deepEqual(calls, ['always allow Computer Use to control Safari (com.apple.Safari) (high risk)']);
    assert.deepEqual(ids(), ['com.apple.Safari']);
  });

  it('uninstalled bundle id cannot be allowed', () => {
    const [code, , err] = runApps(['allow', 'com.gone.App']);
    assert.equal(code, 1);
    assert.ok(err.includes('not installed'));
  });

  // Revoke
  it('revoke by name, id and for uninstalled entries', () => {
    writeStore({ [apps.KEY]: ['dev.zed.Zed', 'com.gone.App', 'com.apple.Safari'] });
    assert.equal(runApps(['revoke', 'zed'])[0], 0);
    assert.equal(calls.at(-1), 'stop always allowing Computer Use to control Zed (dev.zed.Zed)');
    assert.equal(runApps(['revoke', 'com.gone.App'])[0], 0);
    assert.deepEqual(ids(), ['com.apple.Safari']);
  });

  it('revoke of absent app is idempotent and does not prompt', () => {
    writeStore({ [apps.KEY]: [] });
    const [code, out] = runApps(['revoke', 'Zed']);
    assert.equal(code, 0);
    assert.ok(out.includes('not in the always-allowed list'));
    assert.deepEqual(calls, []);
    assert.equal(runApps(['revoke', 'com.never.Seen'])[0], 0);
  });

  it('revoke reports unknown name', () => {
    writeStore({ [apps.KEY]: ['dev.zed.Zed'] });
    const [code, , err] = runApps(['revoke', 'Nothing Here']);
    assert.equal(code, 1);
    assert.ok(err.includes('not among the approved apps'));
  });

  // Malformed stores
  it('malformed store is reported and never overwritten', () => {
    for (const content of ['{not json', '[]', JSON.stringify({ [apps.KEY]: 'x' }), JSON.stringify({ [apps.KEY]: [1] })]) {
      writeStore(content);
      for (const argv of [['list'], ['allow', 'Zed'], ['revoke', 'Zed']]) {
        const [code, , err] = runApps(argv);
        assert.equal(code, 1, `${content} ${argv}`);
        assert.ok(err.includes('not a valid approvals file'));
        assert.equal(readFileSync(store, 'utf8'), content);
      }
    }
    assert.deepEqual(calls, []);
  });

  it('object without the key is empty and keeps its other keys on write', () => {
    writeStore({ other: 1 });
    assert.ok(runApps(['list'])[1].includes('No apps are always allowed'));
    runApps(['allow', 'Zed']);
    assert.deepEqual(JSON.parse(readFileSync(store, 'utf8')), { other: 1, [apps.KEY]: ['dev.zed.Zed'] });
  });

  // Concurrent writers
  it('a writer racing the update is not lost', () => {
    writeStore({ [apps.KEY]: ['a.id'] });
    const raced = [];
    const realFsync = apps.hooks.fsync;
    apps.hooks.fsync = (fd) => {
      if (!raced.length) {
        raced.push(true);
        writeFileSync(store, JSON.stringify({ [apps.KEY]: ['a.id', 'runtime.id'] }));
      }
      realFsync(fd);
    };
    apps.modify(store, (list) => [...list, 'dev.zed.Zed'], { sleep: () => {} });
    // The other writer landed while the new file was being prepared, so the first attempt is
    // discarded and recomputed on top of its content.
    assert.deepEqual(ids(), ['a.id', 'runtime.id', 'dev.zed.Zed']);
    assert.equal(raced.length, 1);
  });

  it('a write clobbered right after the replace is redone', () => {
    writeStore({ [apps.KEY]: ['a.id'] });
    const clobbered = [];
    apps.modify(store, (list) => [...list, 'dev.zed.Zed'], {
      sleep: () => {
        if (!clobbered.length) {
          clobbered.push(true);
          writeFileSync(store, JSON.stringify({ [apps.KEY]: ['a.id', 'runtime.id'] }));
        }
      },
    });
    assert.deepEqual(ids(), ['a.id', 'runtime.id', 'dev.zed.Zed']);
  });

  it('gives up when the file never settles', () => {
    writeStore({ [apps.KEY]: [] });
    const counter = [];
    assert.throws(() => apps.modify(store, (list) => [...list, 'x'], {
      attempts: 3,
      sleep: () => {
        counter.push(1);
        writeFileSync(store, JSON.stringify({ [apps.KEY]: [`n${counter.length}`] }));
      },
    }), (e) => e instanceof apps.AppsError && /kept changing/.test(e.message));
  });

  it('parallel updates all land', async () => {
    writeStore({ [apps.KEY]: [] });
    const code = `
      import { workerData, parentPort } from 'node:worker_threads';
      const apps = await import(${JSON.stringify(APPS_URL)});
      const index = workerData.index;
      try {
        apps.modify(workerData.store, (ids) => (ids.includes('id.' + index) ? ids : [...ids, 'id.' + index]));
        parentPort.postMessage('ok');
      } catch (error) { parentPort.postMessage(String(error.message)); }`;
    const results = await Promise.all([0, 1, 2, 3, 4].map((index) => new Promise((resolve, reject) => {
      const worker = new Worker(code, { eval: true, workerData: { store, index } });
      worker.once('message', resolve);
      worker.once('error', reject);
    })));
    assert.deepEqual(results, ['ok', 'ok', 'ok', 'ok', 'ok']);
    assert.deepEqual(ids().sort(), [0, 1, 2, 3, 4].map((i) => `id.${i}`));
  });

  it('new store directory is created and mode is kept', () => {
    apps.modify(store, (list) => [...list, 'dev.zed.Zed']);
    assert.deepEqual(ids(), ['dev.zed.Zed']);
    chmodSync(store, 0o640);
    apps.modify(store, (list) => [...list, 'x.y']);
    assert.equal(statSync(store).mode & 0o777, 0o640);
  });

  // Platforms
  it('linux and windows explain themselves', () => {
    let [code, , err] = runApps(['allow', 'Zed'], { platform: 'linux' });
    assert.equal(code, 1);
    assert.ok(err.includes('no per-app approval'));
    [code, , err] = runApps([], { platform: 'win32' });
    assert.equal(code, 1);
    assert.ok(err.includes('not supported on Windows'));
    assert.equal(existsSync(store), false);
  });

  it('lone surrogates in the store fail like Python (UnicodeEncodeError) and leave every byte untouched (R3)', { skip: !PYTHON }, () => {
    const documents = [
      `{"extra":"\\ud800","${apps.KEY}":["old.id"]}`,
      `{"${apps.KEY}":["a\\udc00b","old.id"]}`,
      `{"k":{"n":["xx\\ud83dyy"]},"${apps.KEY}":[]}`,
      `{"\\udfff":1,"${apps.KEY}":[]}`,
      `{"${apps.KEY}":["old.id"],"z":[{"q":["ok","\\ud800\\ud800"]}]}`,
    ];
    const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(ORACLE_ROOT)})
from lcu import apps
out = []
for path in sys.argv[1:]:
    try:
        apps.modify(path, lambda ids: ids + ['new.id'], sleep=lambda _: None)
        out.append('ok')
    except Exception as exc:
        out.append(type(exc).__name__ + ': ' + str(exc))
print(json.dumps(out))`;
    const files = documents.map((text, index) => {
      const path = join(home, `store-${index}.json`);
      writeFileSync(path, text);
      return path;
    });
    const python = spawnSync(PYTHON, ['-c', script, ...files], { encoding: 'utf8' });
    assert.equal(python.status, 0, python.stderr);
    const expected = JSON.parse(python.stdout);
    for (const [index, text] of documents.entries()) {
      const path = files[index];
      assert.equal(readFileSync(path, 'utf8'), text, 'Python left the store untouched');
      let got = 'ok';
      try {
        apps.modify(path, (list) => [...list, 'new.id'], { sleep: () => {} });
      } catch (error) {
        got = `${error.name}: ${error.message}`;
      }
      assert.equal(got, expected[index], text);
      assert.equal(readFileSync(path, 'utf8'), text);
    }
    assert.deepEqual(readdirSync(home).filter((name) => name.startsWith('.store-')), [], 'staged files removed');
  });

  // ---- cases that Python's suite did not cover (see .port/notes/apps.md) ----
  it('a brand-new store is created 0600 with the exact bytes Python writes (indent 2, ensure_ascii false, newline)', () => {
    apps.modify(store, (list) => [...list, 'dev.zed.Zed', 'com.exämple.ß']);
    assert.equal(statSync(store).mode & 0o777, 0o600);
    assert.equal(readFileSync(store, 'utf8'), `{\n  "${apps.KEY}": [\n    "dev.zed.Zed",\n    "com.exämple.ß"\n  ]\n}\n`);
  });

  it('a BOM and non-ASCII content are read; unknown key order and integer-like keys are kept', () => {
    writeStore('');
    writeFileSync(store, Buffer.concat([Buffer.from('﻿'), Buffer.from(`{"9":1,"b":2,"${apps.KEY}":["é.app"],"1":3}`)]));
    apps.modify(store, (list) => [...list, 'z.z']);
    assert.equal(readFileSync(store, 'utf8'), `{\n  "9": 1,\n  "b": 2,\n  "${apps.KEY}": [\n    "é.app",\n    "z.z"\n  ],\n  "1": 3\n}\n`);
  });

  it('names are matched with full Unicode casefolding (ß == SS) and listed by code point', () => {
    makeApp(applications, 'Straße', 'de.strasse');
    assert.equal(apps.resolve('STRASSE', { home })[0], 'de.strasse');
    assert.equal(apps.resolve('strasse', { home })[0], 'de.strasse');
    makeApp(applications, '\u{1F600}Face', 'emoji.face');
    makeApp(applications, 'ＡWide', 'wide.a');
    writeStore({ [apps.KEY]: ['emoji.face', 'wide.a', 'dev.zed.Zed', 'de.strasse'] });
    const [, out] = runApps([]);
    // casefold order: "strasse" < "zed" < "ａwide" (U+FF41 after folding) < "😀face"; width is by code points
    assert.deepEqual(out.trim().split('\n').map((line) => line.trim().split(/\s+/).at(-1)), ['de.strasse', 'dev.zed.Zed', 'wide.a', 'emoji.face']);
    assert.ok(out.includes(`${'Zed'.padEnd(6)}  dev.zed.Zed`), out);
  });

  it('a bundle without an identifier is not an app; a path is validated', () => {
    const bare = join(applications, 'Bare.app');
    mkdirSync(join(bare, 'Contents'), { recursive: true });
    writeFileSync(join(bare, 'Contents/Info.plist'), plistXml({ CFBundleName: 'Bare' }));
    assert.throws(() => apps.resolve(bare, { home }), (e) => /has no bundle identifier/.test(e.message));
    assert.throws(() => apps.resolve(join(home, 'missing.app'), { home }), (e) => /is not an application bundle/.test(e.message));
    assert.equal(apps.bundle_info(bare), null);
  });

  it('a bundle without a name falls back to the file stem', () => {
    const app = join(applications, 'Plain.app');
    mkdirSync(join(app, 'Contents'), { recursive: true });
    writeFileSync(join(app, 'Contents/Info.plist'), plistXml({ CFBundleIdentifier: 'plain.id' }));
    assert.deepEqual(apps.bundle_info(app), ['plain.id', 'Plain']);
  });

  it('binary plists are read through plutil', { skip: !PLUTIL }, () => {
    const app = makeApp(applications, 'Bin', 'bin.id', 'Binary Display');
    const plist = join(app, 'Contents/Info.plist');
    assert.equal(spawnSync('/usr/bin/plutil', ['-convert', 'binary1', plist]).status, 0);
    assert.equal(readFileSync(plist).subarray(0, 8).toString(), 'bplist00');
    assert.deepEqual(apps.bundle_info(app), ['bin.id', 'Binary Display']);
  });

  it('the mdfind fallback is used for names and bundle ids and verified against the bundle', () => {
    const elsewhere = join(home, 'Elsewhere');
    const found = makeApp(elsewhere, 'Hidden', 'hidden.id');
    const seen = [];
    apps.hooks._mdfind = (query) => { seen.push(query); return query.startsWith('kMDItemKind') && query.includes('hidden.id') ? [] : [found, join(elsewhere, 'Wrong.app')]; };
    assert.deepEqual(apps.resolve('hidden', { home }), ['hidden.id', 'Hidden', true]);
    assert.deepEqual(apps.resolve('hidden.id', { home }), ['hidden.id', 'Hidden', true]);
    assert.deepEqual(seen, ['kMDItemKind == "Application" && kMDItemDisplayName == "hidden"c',
      'kMDItemKind == "Application" && kMDItemDisplayName == "hidden.id"c',
      'kMDItemCFBundleIdentifier == "hidden.id"']);
  });

  it('revoke explains several approved apps with the same display name', () => {
    makeApp(applications, 'Zed Preview', 'dev.zed.Zed-Preview', 'Zed');
    writeStore({ [apps.KEY]: ['dev.zed.Zed', 'dev.zed.Zed-Preview'] });
    const [code, , err] = runApps(['revoke', 'zed']);
    assert.equal(code, 1);
    assert.ok(err.includes('"zed" matches several approved apps: dev.zed.Zed, dev.zed.Zed-Preview.'), err);
  });

  it('the default store lives under the account home (HOME) and "~" is expanded in app paths', () => {
    const saveHome = process.env.HOME;
    process.env.HOME = home;
    try {
      assert.equal(apps.store_path(), store);
      assert.equal(apps.resolve('~/Applications/Zed.app')[0], 'dev.zed.Zed');
    } finally {
      process.env.HOME = saveHome;
    }
  });

  it('argparse help and errors', { skip: !PYTHON }, () => {
    // Differential against the Python module: usage/help/error text, exit codes and the argv normalisation.
    const script = `
import contextlib, io, sys
sys.path.insert(0, ${JSON.stringify(ORACLE_ROOT)})
from lcu import apps
for argv in ${JSON.stringify([['--help'], ['list', '--help'], ['allow', '--help'], ['revoke', '-h'], ['bogus'], ['allow'], ['--bogus'], ['list', '--bogus'], ['allow', 'a', 'b']])}:
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            apps.main('/nonexistent', argv, platform='darwin', home='/nonexistent-home')
        except SystemExit as exit_:
            code = exit_.code
    print(repr([argv, code, out.getvalue(), err.getvalue()]))
`;
    const python = spawnSync(PYTHON, ['-c', script], { encoding: 'utf8', env: { ...process.env, COLUMNS: '80', PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(python.status, 0, python.stderr);
    const expected = python.stdout.trim().split('\n');
    const got = [];
    for (const argv of [['--help'], ['list', '--help'], ['allow', '--help'], ['revoke', '-h'], ['bogus'], ['allow'], ['--bogus'], ['list', '--bogus'], ['allow', 'a', 'b']]) {
      let out = ''; let err = '';
      const real = { stdout: io.stdout, stderr: io.stderr, exit: io.exit };
      io.stdout = (t) => { out += t; };
      io.stderr = (t) => { err += t; };
      let code = 0;
      io.exit = (status) => { throw new PySystemExit(status); };
      process.env.COLUMNS = '80';
      try { apps.main('/nonexistent', argv, { platform: 'darwin', home: '/nonexistent-home' }); } catch (error) {
        if (!(error instanceof PySystemExit)) throw error;
        code = error.status;
      } finally { Object.assign(io, real); }
      got.push([argv, code, out, err]);
    }
    const pyRepr = (value) => {
      if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
      if (typeof value === 'number') return String(value);
      const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
      return quote + value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(quote, `\\${quote}`) + quote;
    };
    assert.deepEqual(got.map(pyRepr), expected);
  });
});

describe('AuthenticationTests', { skip: process.platform === 'win32' }, () => {
  // The real authenticate() driven by a stand-in helper script; no prompt ever appears.
  const helper = (root, body) => {
    const path = join(root, apps.HELPER);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\n${body}`);
    chmodSync(path, 0o755);
  };
  const quiet = (fn) => {
    const real = io.stderr;
    io.stderr = () => {};
    try { return fn(); } finally { io.stderr = real; }
  };

  it('exit codes map to messages and fail closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'lcu-auth-'));
    temporaries.push(root);
    assert.throws(() => apps.authenticate(root, 'why'), (e) => e instanceof apps.AppsError && /helper is missing/.test(e.message));
    helper(root, 'echo "$@" > "$0.args"; exit 0');
    quiet(() => apps.authenticate(root, 'why'));
    assert.equal(readFileSync(join(root, `${apps.HELPER}.args`), 'utf8').trim(), '--reason why');
    helper(root, 'exit 1');
    assert.throws(() => quiet(() => apps.authenticate(root, 'why')), (e) => /cancelled or failed/.test(e.message));
    helper(root, 'echo no graphical login session >&2; exit 2');
    assert.throws(() => quiet(() => apps.authenticate(root, 'why')), (e) => /cannot ask for authentication: no graphical/.test(e.message));
    helper(root, 'kill -9 $$');
    assert.throws(() => quiet(() => apps.authenticate(root, 'why')),
      (e) => e instanceof apps.AppsError && e.message.includes('cannot ask for authentication: exit status -9.'));
  });

  it('a helper that cannot be executed fails closed with the OS error text', () => {
    const root = mkdtempSync(join(tmpdir(), 'lcu-auth-'));
    temporaries.push(root);
    helper(root, 'exit 0');
    writeFileSync(join(root, apps.HELPER), '\u0000\u0001 not a runnable file');
    chmodSync(join(root, apps.HELPER), 0o755);
    assert.throws(() => quiet(() => apps.authenticate(root, 'why')),
      (e) => e instanceof apps.AppsError && /could not run the owner-authentication helper: \[Errno 8\] Exec format error: /.test(e.message)
        && e.message.endsWith('. Nothing was changed.'), 'exec format');
  });

  it('an executable text file without "#!" is not run through a shell (Python: ENOEXEC) (R6)', () => {
    const root = mkdtempSync(join(tmpdir(), 'lcu-auth-'));
    temporaries.push(root);
    helper(root, 'exit 0');
    writeFileSync(join(root, apps.HELPER), 'printf EXECUTED > "$0.executed"; exit 0\n');
    chmodSync(join(root, apps.HELPER), 0o755);
    assert.throws(() => quiet(() => apps.authenticate(root, 'why')),
      (e) => e instanceof apps.AppsError
        && e.message === `could not run the owner-authentication helper: [Errno 8] Exec format error: '${join(root, apps.HELPER)}'. Nothing was changed.`);
    assert.equal(existsSync(join(root, `${apps.HELPER}.executed`)), false);
  });

  it('a malformed binary helper is not executed either', () => {
    const root = mkdtempSync(join(tmpdir(), 'lcu-auth-'));
    temporaries.push(root);
    helper(root, 'exit 0');
    writeFileSync(join(root, apps.HELPER), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x7f, 0x45, 0x4c, 0x46, 1, 2]));
    chmodSync(join(root, apps.HELPER), 0o755);
    assert.throws(() => quiet(() => apps.authenticate(root, 'why')), (e) => e instanceof apps.AppsError
      && /^could not run the owner-authentication helper: \[Errno \d+\] /.test(e.message));
  });

  it('the helper gets /dev/null on stdin and stdout and the stderr pipe', () => {
    const root = mkdtempSync(join(tmpdir(), 'lcu-auth-'));
    temporaries.push(root);
    helper(root, 'test ! -t 0 && test "$(cat)" = "" && echo ok-stdin >&2; ls -l /dev/fd/1 >&2; exit 3');
    assert.throws(() => quiet(() => apps.authenticate(root, 'why')), (e) => /ok-stdin/.test(e.message));
  });
});
