// Real POSIX ACLs (Linux with setfacl/getfacl, e.g. tests/compat/docker.sh's image) through the whole app
// selection, reproducing the review probes in .port/reviews/probes-platforms/linux_compare.py: lcu/platforms.py
// refuses an app whose files carry an effective named-user write ACL, and so must the port, whatever the
// caller's PATH / LCU_* variables say, when getfacl fails or prints garbage, and when an ACL is added after
// the batched reads. Skipped where setfacl is unavailable (macOS).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { internals, resolve_installed_linux_app } from '../../lcu/platforms.mjs';
import { ValueError } from '../../lcu/compat/pyjson.mjs';
import { _testing } from '../../lcu/compat/systool.mjs';

const SETFACL = ['/usr/bin/setfacl', '/bin/setfacl'].find((file) => existsSync(file));
const GETFACL = ['/usr/bin/getfacl', '/bin/getfacl'].find((file) => existsSync(file));
const skip = process.platform !== 'linux' || !SETFACL || !GETFACL ? 'needs Linux with setfacl/getfacl (tests/compat/docker.sh image)' : false;
const STRANGER = 65534;

function setfacl(...args) {
  const done = spawnSync(SETFACL, args, { encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
}

function fixture(base) {
  const app = path.join(base, 'chatgpt');
  const executable = '#!/bin/sh\nexit 0\n';
  const files = ['ChatGPT', 'resources/cua_node/bin/node', 'resources/cua_node/bin/node_repl', 'resources/codex',
    'resources/codex-code-mode-host', 'resources/plugins/openai-bundled/plugins/chrome/extension-host/linux/arm64/extension-host'];
  for (const relative of files) {
    const file = path.join(app, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, executable);
    chmodSync(file, 0o755);
  }
  const plain = {
    'resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs': 'export {};\n',
    'resources/plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json': '{}\n',
    'resources/plugins/openai-bundled/plugins/unified-computer-use/.mcp.json': '{}\n',
    'resources/plugins/openai-bundled/plugins/browser/install.js': '{}\n',
    'resources/cua_node/manifest.json': JSON.stringify({ platform: 'linux', arch: 'arm64', runtime_archive_version: 'r' }),
  };
  for (const [relative, text] of Object.entries(plain)) {
    const file = path.join(app, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  for (let index = 0; index < 60; index++) writeFileSync(path.join(app, `resources/cua_node/lib/node_modules/f${index}.js`), 'x');
  const header = Buffer.from(JSON.stringify({ files: { 'package.json': { offset: '0', size: 17 } } }));
  const preamble = Buffer.alloc(16);
  [4, 8 + header.length, 4 + header.length, header.length].forEach((value, index) => preamble.writeUInt32LE(value, index * 4));
  writeFileSync(path.join(app, 'resources/app.asar'), Buffer.concat([preamble, header, Buffer.from('{"version":"1.2"}')]));
  return realpathSync(app);
}

const tool = (dir, name, body) => {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};

describe('Linux app selection with real POSIX ACLs', { skip }, () => {
  let base; let app; let tools;
  const saved = { ...internals };
  const env = { ...process.env };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'lcu-acl-')));
    chmodSync(base, 0o755);
    app = fixture(base);
    tools = path.join(base, 'tools');
    mkdirSync(tools);
  });
  afterEach(() => {
    Object.assign(internals, saved);
    _testing.reset();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  const resolve = () => resolve_installed_linux_app(app, { arch: 'arm64' });
  const refuses = (pattern) => assert.throws(resolve, (error) => {
    assert.ok(error instanceof ValueError, `${error.name}: ${error.message}`);
    assert.match(error.message, pattern);
    return true;
  });
  const named = new RegExp(`ChatGPT is writable by uid ${STRANGER} through a POSIX ACL`);

  it('accepts the clean fixture', () => {
    assert.equal(resolve().app, app);
  });

  it('refuses a named-user write ACL on an explicit-only file (outside every walked tree)', () => {
    setfacl('-m', `u:${STRANGER}:rw`, path.join(app, 'ChatGPT'));
    refuses(named);
  });

  it('ignores caller PATH and the removed LCU reader overrides', () => {
    setfacl('-m', `u:${STRANGER}:rw`, path.join(app, 'ChatGPT'));
    tool(tools, 'getfacl', 'exit 0');
    tool(tools, 'python3', 'exit 0');
    process.env.PATH = `${tools}:${process.env.PATH}`;
    process.env.LCU_GETFACL = '/bin/true';
    process.env.LCU_ACL_PYTHON = '/bin/true';
    refuses(named);
  });

  it('refuses a named-user write ACL inside a walked tree and an ancestor directory', () => {
    setfacl('-m', `u:${STRANGER}:rw`, path.join(app, 'resources/cua_node/lib/node_modules/f7.js'));
    refuses(new RegExp(`f7.js is writable by uid ${STRANGER} through a POSIX ACL`));
    setfacl('-b', path.join(app, 'resources/cua_node/lib/node_modules/f7.js'));
    setfacl('-m', `u:${STRANGER}:rwx`, path.join(app, 'resources'));
    refuses(new RegExp(`resources is writable by uid ${STRANGER} through a POSIX ACL`));
  });

  it('accepts a write entry the mask removes, and a read-only named entry', () => {
    setfacl('-n', '-m', `u:${STRANGER}:rw,m::r-x`, path.join(app, 'ChatGPT'));
    resolve();
    setfacl('-b', path.join(app, 'ChatGPT'));
    setfacl('-m', `u:${STRANGER}:r`, path.join(app, 'ChatGPT'));
    resolve();
  });

  it('still refuses when getfacl fails or prints garbage (the python3 xattr reader answers)', () => {
    setfacl('-m', `u:${STRANGER}:rw`, path.join(app, 'ChatGPT'));
    _testing.override('getfacl', tool(tools, 'failing-getfacl', 'case "$1" in --version) exit 0;; esac\nexit 1'));
    refuses(named);
    _testing.reset();
    _testing.override('getfacl', tool(tools, 'garbage-getfacl', 'case "$1" in --version) exit 0;; esac\necho "# file: x"\necho "nonsense"'));
    refuses(named);
    _testing.reset();
    _testing.override('getfacl', tool(tools, 'killed-getfacl', 'case "$1" in --version) exit 0;; esac\nexit 143'));
    refuses(named);
  });

  it('refuses when no ACL reader works, instead of trusting the entries', () => {
    _testing.override('getfacl', path.join(tools, 'missing-getfacl'));
    _testing.override('python3', path.join(tools, 'missing-python3'));
    refuses(/cannot be inspected \(cannot inspect POSIX ACLs/);
  });

  it('sees an ACL added after the batched reads (entry changed since its batch is read again)', () => {
    const marker = path.join(base, 'mutated');
    const log = path.join(base, 'calls.log');
    _testing.override('getfacl', tool(tools, 'mutating-getfacl', [
      `echo "$*" >> ${log}`,
      `${GETFACL} "$@"; status=$?`,
      `case "$*" in *--recursive*) if [ ! -e ${marker} ]; then ${SETFACL} -m u:${STRANGER}:rw ${path.join(app, 'ChatGPT')}; touch ${marker}; fi;; esac`,
      'exit $status',
    ].join('\n')));
    refuses(named);
    assert.ok(existsSync(marker), 'the ACL was added after a recursive batch read');
  });

  it('uses batched reads (a handful of getfacl runs) for entries unchanged since their batch', () => {
    const log = path.join(base, 'calls.log');
    _testing.override('getfacl', tool(tools, 'logging-getfacl', `echo "$*" >> ${log}\nexec ${GETFACL} "$@"`));
    internals.change_slack_ms = -60000; // treat the fresh fixture as older than the batches
    resolve();
    const runs = readFileSync(log, 'utf8').split('\n').filter((line) => line && line !== '--version');
    assert.ok(runs.length <= 6, `${runs.length} getfacl runs`);
    for (const line of runs) assert.match(line, /^--access --numeric --absolute-names --physical --skip-base /);
    appendFileSync(log, '');
  });
});
