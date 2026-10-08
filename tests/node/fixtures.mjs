// Shared fixtures for the Node unit tests: disposable directories and hand-made app layouts (no OpenAI code).
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSION, inventory } from '../../scripts/bundle.mjs';

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

const restores = new WeakMap();

/** Replace a property of `object` for the duration of the test; repeated overrides are undone newest first. */
export function override(t, object, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, { value, configurable: true, writable: true });
  if (!restores.has(t)) {
    restores.set(t, []);
    t.after(() => { for (const restore of restores.get(t).reverse()) restore(); });
  }
  restores.get(t).push(() => (descriptor ? Object.defineProperty(object, name, descriptor) : delete object[name]));
}

/** Seal a release `root` the way scripts/bundle.py does. */
export function seal(root, arch, target = 'linux') {
  writeFileSync(join(root, 'bundle.json'), JSON.stringify({ format: 1, version: VERSION, platform: target, architecture: arch,
    files: inventory(root, target) }));
}
