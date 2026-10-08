// Shared fixtures for the Node unit tests: disposable directories and hand-made app layouts (no OpenAI code).
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** A resolved temporary directory removed after the test. */
export function temporary(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'lcu-test-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

export function write(path, content = '', mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
  return path;
}

/** An Electron ASAR archive holding `members` ({name: Buffer|string}). */
export function writeAsar(path, members) {
  const files = {};
  const payload = [];
  let offset = 0;
  for (const [name, value] of Object.entries(members)) {
    const content = Buffer.from(value);
    const parts = name.split('/');
    let node = files;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= { files: {} }).files;
    node[parts.at(-1)] = { offset: String(offset), size: content.length };
    payload.push(content);
    offset += content.length;
  }
  const header = Buffer.from(JSON.stringify({ files }));
  const preamble = Buffer.alloc(16);
  [4, 8 + header.length, 4 + header.length, header.length].forEach((value, index) => preamble.writeUInt32LE(value, index * 4));
  write(path, Buffer.concat([preamble, header, ...payload]));
}

const EXECUTABLE = '#!/bin/sh\nexit 0\n';

/** A Linux ChatGPT application layout. */
export function linuxApp(root, { version = '26.924.22138', runtimeVersion = 'runtime-new', arch = 'arm64', relocated = false } = {}) {
  write(join(root, 'ChatGPT'), EXECUTABLE, 0o755);
  write(join(root, 'resources/cua_node/bin/node'), EXECUTABLE, 0o755);
  write(join(root, 'resources/cua_node/bin/node_repl'), EXECUTABLE, 0o755);
  write(join(root, 'resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs'), 'export {};\n');
  for (const name of ['codex', 'codex-code-mode-host']) write(join(root, 'resources', relocated ? 'codex-cli/bin' : '', name), EXECUTABLE, 0o755);
  writeAsar(join(root, 'resources/app.asar'), { 'package.json': JSON.stringify({ name: 'chatgpt', version }) });
  write(join(root, 'resources/cua_node/manifest.json'), JSON.stringify({ platform: 'linux', arch, runtime_archive_version: runtimeVersion }));
  const plugins = join(root, 'resources/plugins/openai-bundled/plugins');
  write(join(plugins, 'chrome/.codex-plugin/plugin.json'), '{}\n');
  write(join(plugins, `chrome/extension-host/linux/${arch}/extension-host`), EXECUTABLE, 0o755);
  write(join(plugins, 'unified-computer-use/.mcp.json'), '{}\n');
  write(join(plugins, 'browser/install.js'), '{}\n');
  return realpathSync(root);
}

/** A Linux release `root` whose app link points at a fixture app. */
export function linuxRelease(base, { runtimeVersion = 'fixture-runtime-new' } = {}) {
  const root = join(base, 'releases/release');
  mkdirSync(root, { recursive: true });
  const app = linuxApp(join(base, 'usr/lib/chatgpt'), { runtimeVersion });
  return { root, app };
}

/** Replace a property of `object` for the duration of the test. */
export function override(t, object, name, value) {
  // Only the first override in a test records what to restore, so repeated overrides restore the original.
  const seen = overridden.get(t) ?? new Map();
  overridden.set(t, seen);
  const properties = seen.get(object) ?? new Set();
  seen.set(object, properties);
  if (!properties.has(name)) {
    properties.add(name);
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    t.after(() => (descriptor ? Object.defineProperty(object, name, descriptor) : delete object[name]));
  }
  Object.defineProperty(object, name, { value, configurable: true, writable: true, enumerable: true });
}
const overridden = new WeakMap();

/** Collect what LCU's management commands print (lcu/terminal.mjs) during the test: `{out, err}` strings. */
export async function output(t) {
  const { terminal } = await import('../../lcu/terminal.mjs');
  const seen = { out: '', err: '' };
  override(t, terminal, 'out', (text) => { seen.out += text; });
  override(t, terminal, 'err', (text) => { seen.err += text; });
  return seen;
}

/** A captured child result as lcu/capture.mjs returns it. */
export const result = (status = 0, stdout = '', stderr = '') => ({ status, signal: null, error: undefined, stdout, stderr });
