// Shared fixtures for the runtime-entry-path tests (runtime, tested, status, session, asar, capture, app_layout, entry).
// Not a test file. Ports tests/test_installation.py `_write_asar` / `_application_fixture` and the
// mock.patch.dict(os.environ, ..., clear=True) / io.StringIO / io.BytesIO idioms.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { io } from '../../lcu/compat/argparse.mjs';

/** Port of _write_asar(path, members): members is {name: Buffer|string}. */
export function writeAsar(path, members) {
  const files = {};
  const chunks = [];
  let length = 0;
  for (const [name, raw] of Object.entries(members)) {
    const content = Buffer.from(raw);
    let node = files;
    const parts = name.split('/');
    for (const part of parts.slice(0, -1)) {
      node[part] ??= { files: {} };
      node = node[part].files;
    }
    node[parts.at(-1)] = { offset: String(length), size: content.length };
    chunks.push(content);
    length += content.length;
  }
  const header = Buffer.from(JSON.stringify({ files }));
  const preamble = Buffer.alloc(16);
  preamble.writeUInt32LE(4, 0);
  preamble.writeUInt32LE(8 + header.length, 4);
  preamble.writeUInt32LE(4 + header.length, 8);
  preamble.writeUInt32LE(header.length, 12);
  writeFileSync(path, Buffer.concat([preamble, header, ...chunks]));
}

const put = (path, content, mode = null) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== null) chmodSync(path, mode);
};

/** Port of _application_fixture(root, *, version, runtime_version, arch, relocated). Returns `root`. */
export function applicationFixture(root, { version = '26.924.22138', runtime_version = 'runtime-new',
  arch = 'arm64', relocated = false } = {}) {
  const app = root;
  const resources = join(app, 'resources');
  const runtime = join(resources, 'cua_node');
  const executable = Buffer.from('#!/bin/sh\nexit 0\n');
  const launcher = 'resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs';
  for (const relative of ['ChatGPT', 'resources/cua_node/bin/node', 'resources/cua_node/bin/node_repl', launcher]) {
    put(join(app, relative), relative === launcher ? Buffer.from('export {};\n') : executable,
      relative === launcher ? null : 0o755);
  }
  const tools = join(resources, relocated ? 'codex-cli/bin' : '');
  for (const name of ['codex', 'codex-code-mode-host']) {
    put(join(tools, name), executable, 0o755);
  }
  mkdirSync(resources, { recursive: true });
  writeAsar(join(resources, 'app.asar'), { 'package.json': JSON.stringify({ name: 'chatgpt', version }) });
  put(join(runtime, 'manifest.json'), JSON.stringify({ platform: 'linux', arch, runtime_archive_version: runtime_version }));
  mkdirSync(join(resources, 'plugins/openai-bundled/plugins/browser'), { recursive: true });
  for (const relative of [
    'plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json',
    `plugins/openai-bundled/plugins/chrome/extension-host/linux/${arch}/extension-host`,
    'plugins/openai-bundled/plugins/unified-computer-use/.mcp.json',
    'plugins/openai-bundled/plugins/browser/install.js',
  ]) {
    const isHost = relative.endsWith('extension-host');
    put(join(resources, relative), isHost ? executable : Buffer.from('{}\n'), isHost ? 0o755 : null);
  }
  return app;
}

/** A realpath'd temporary directory with cleanup(): tempfile.TemporaryDirectory().resolve(). */
export function tempDir(prefix = 'lcu-node-test-') {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** patch.dict(os.environ, values, clear=True) around fn (sync or async). */
export function withEnv(values, fn, { clear = true } = {}) {
  const saved = { ...process.env };
  if (clear) for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, values);
  const restore = () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

/** io.StringIO-style capture of everything the port prints through compat/argparse `io`. */
export function captureIo() {
  const saved = { stdout: io.stdout, stderr: io.stderr };
  const state = { out: '', err: '' };
  io.stdout = (text) => { state.out += text; };
  io.stderr = (text) => { state.err += text; };
  state.restore = () => { io.stdout = saved.stdout; io.stderr = saved.stderr; };
  return state;
}

/** io.BytesIO: read(n) / read() / write / getvalue. */
export class BytesIO {
  constructor(initial = Buffer.alloc(0)) {
    this.data = Buffer.from(initial);
    this.position = 0;
  }
  read(count = undefined) {
    const end = count === undefined ? this.data.length : Math.min(this.data.length, this.position + count);
    const chunk = this.data.subarray(this.position, end);
    this.position = end;
    return Buffer.from(chunk);
  }
  write(chunk) {
    this.data = Buffer.concat([this.data, Buffer.from(chunk)]);
  }
  flush() {}
  getvalue() {
    return Buffer.from(this.data);
  }
}

/** assertRaisesRegex(ValueError-like, regex) for a promise or a function. */
export async function rejectsWith(assert, work, name, regex) {
  let failure = null;
  try {
    await (typeof work === 'function' ? work() : work);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `expected ${name} matching ${regex}`);
  const names = [];
  for (let proto = failure; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    names.push(proto.constructor?.name, proto.name);
  }
  assert.ok(names.some((candidate) => candidate && candidate.replace(/^Py/, '') === name),
    `expected ${name}, got ${failure.name}: ${failure.message}`);
  assert.match(failure.message, regex);
  return failure;
}

/**
 * The CPython 3.12.10 oracle (the project's reference interpreter), as an absolute path, or null. Never found through
 * PATH (a bare python3 may be Homebrew 3.14 or a distro 3.12.3 with different texts): LCU_TEST_PYTHON (taken as is, the
 * caller vouches for it) or one of the fixed install locations whose full version is 3.12.10.
 */
export function python312() {
  const { spawnSync } = process.getBuiltinModule('node:child_process');
  if (process.env.LCU_TEST_PYTHON) return process.env.LCU_TEST_PYTHON;
  const candidates = ['/opt/cpython-3.12.10/bin/python3.12', '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3', '/usr/local/bin/python3.12',
    '/opt/homebrew/bin/python3.12', '/usr/bin/python3.12'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[:3] == (3, 12, 10))'], { encoding: 'utf8' });
    if (probe.stdout?.trim() === 'True') return candidate;
  }
  return null;
}

/**
 * A /bin/bash -c script printing "INT=<0|1> TERM=<0|1> pid=<pid>" (1 = ignored) for its own process: Linux reads
 * /proc/$$/status SigIgn; macOS asks bash 3.2, which refuses to trap a signal ignored on entry.
 */
// Bash builtins only: the probe also runs with a PATH that holds no system tools (round-2 review F6 cases).
export const DISPOSITION_SCRIPT = 'if [ -r /proc/$$/status ]; then m=0; while read -r k v; do [ "$k" = SigIgn: ] && m=$v; done < /proc/$$/status; ' +
  'm=${m: -8}; i=$(( (0x$m >> 1) & 1 )); t=$(( (0x$m >> 14) & 1 )); ' +
  'else tr=$(trap : INT TERM; trap); case $tr in *SIGINT*) i=0;; *) i=1;; esac; case $tr in *SIGTERM*) t=0;; *) t=1;; esac; fi; ' +
  'echo "INT=$i TERM=$t pid=$$"';
