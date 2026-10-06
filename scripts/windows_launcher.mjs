// Stable account-local launcher for the selected thin Windows release (Node dispatcher).
// Port of scripts/windows_launcher.py. The installer copies it to <prefix>\windows_launcher.mjs; <prefix>\lcu.cmd
// (after its pre-Node checks and the startup-variable quarantine) and <prefix>\launcher.json registrations run it.
// It lives OUTSIDE any release, so it uses Node built-ins only.
//
// 1. Restores the startup variables lcu.cmd quarantined (__LCU_Q / __LCU_Q_<NAME>), so the caller's environment
//    is what the release's children see.
// 2. Snapshots current.json once and selects the release (same checks and messages as the Python launcher).
// 3. Before executing the release's node.exe, validates it like lcu/runtime.py did for the private generation:
//    the descriptor's app must be <prefix>\apps\<sha256>\app, no reparse point on the way to node.exe, the recorded
//    inventory.json must hash to <sha256>, and node.exe must have the SHA-256 that inventory records. (The full
//    tree is validated again by the release's runtime before any provider Node runs.)
// 4. Runs `<node.exe> --disable-warning=ExperimentalWarning <release>\lcu\entry.mjs lcu ARGS` with the startup
//    variables quarantined again (lcu/entry.mjs restores them), inherited stdio, and returns its status.
// A release from before the Node port (no lcu\entry.mjs; selectable only between the stable launchers' replacement
// and current.json's, or after a rollback) is started as it always was: with the Python interpreter that ran the
// installer (launcher.json "python"), never a PATH-selected one.
// Plain child_process on purpose: this file is copied to <prefix>\\windows_launcher.mjs, outside the release, so it cannot
// import lcu/compat/spawn.mjs; Windows has no inherited-signal dispositions to restore.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENTRY = 'lcu/entry.mjs';
export const NODE = 'app/resources/cua_node/bin/node.exe';
// Same list as lcu/startup_vars.mjs (this file cannot import it; tests compare them).
export const QUARANTINED = [
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_ICU_DATA', 'NODE_V8_COVERAGE',
  'NODE_COMPILE_CACHE', 'NODE_REDIRECT_WARNINGS', 'NODE_NO_WARNINGS', 'NODE_PENDING_DEPRECATION',
  'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_PRESERVE_SYMLINKS',
  'NODE_PRESERVE_SYMLINKS_MAIN', 'NODE_DISABLE_COLORS', 'NODE_SKIP_PLATFORM_CHECK', 'UV_THREADPOOL_SIZE',
  'NODE_USE_ENV_PROXY', 'NODE_USE_SYSTEM_CA', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_COMPILE_CACHE_PORTABLE',
  'NODE_TEST_CONTEXT', 'NODE_PENDING_PIPE_INSTANCES', 'UV_USE_IO_URING', 'FORCE_COLOR', 'NO_COLOR',
  'NODE_FORCE_READLINE', 'OPENSSL_CONF', 'OPENSSL_ENGINES', 'OPENSSL_MODULES', 'OPENSSL_ia32cap',
  'OPENSSL_armcap', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

export class LauncherError extends Error {}

/** Move quarantined startup variables back and drop every __LCU_* transport key (in place). */
export function restore_environment(env = process.env) {
  const values = new Map();
  for (const name of (env.__LCU_Q ?? '').split(',')) {
    const key = `__LCU_Q_${name}`;
    if (QUARANTINED.includes(name) && Object.hasOwn(env, key)) values.set(name, env[key]);
  }
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('__LCU_')) delete env[key];
  for (const [name, value] of values) env[name] = value;
  return env;
}

/** A copy of `env` with the startup variables moved to __LCU_Q_<NAME> for the next Node. */
export function quarantined_environment(env = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(env)) if (!key.toUpperCase().startsWith('__LCU_')) result[key] = value;
  const moved = [];
  for (const name of QUARANTINED) {
    const key = Object.keys(result).find((k) => k.toUpperCase() === name.toUpperCase());
    if (key === undefined) continue;
    result[`__LCU_Q_${name}`] = result[key];
    delete result[key];
    moved.push(name);
  }
  if (moved.length) result.__LCU_Q = moved.join(',');
  return result;
}

const isFile = (item) => {
  try { return statSync(item).isFile(); } catch { return false; }
};
const redirected = (item) => {
  try { return lstatSync(item).isSymbolicLink(); } catch { return false; } // junctions are links to lstat
};
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

export function selected_release(prefix) {
  prefix = realpathSync.native(prefix);
  const descriptor = JSON.parse(readFileSync(path.join(prefix, 'current.json'), 'utf8'));
  const name = descriptor !== null && typeof descriptor === 'object' && !Array.isArray(descriptor)
    ? descriptor.release : undefined;
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\')
      || name === '.' || name === '..' || [...name].some((character) => character.codePointAt(0) < 32)) {
    throw new LauncherError('Invalid selected Windows release name.');
  }
  const release = path.join(prefix, 'releases', name);
  if (lstatSync(release).isSymbolicLink()
      || path.dirname(realpathSync.native(release)) !== realpathSync.native(path.join(prefix, 'releases'))) {
    throw new LauncherError('Selected Windows release leaves the managed prefix.');
  }
  if (!isFile(path.join(release, ENTRY)) && !isFile(path.join(release, 'bin/lcu'))) {
    throw new LauncherError('Selected Windows release is incomplete.');
  }
  return release;
}

// json.dumps(value, sort_keys=True, separators=(',', ':')) for the inventory's shape (objects of strings).
function pyString(text) {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (code < 0x20 || code > 0x7e) {
      for (let i = 0; i < ch.length; i += 1) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`;
    } else out += ch;
  }
  return `${out}"`;
}
const byCodePoint = (a, b) => {
  const x = [...a].map((c) => c.codePointAt(0));
  const y = [...b].map((c) => c.codePointAt(0));
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};
export function compact_sorted(value) {
  if (typeof value === 'string') return pyString(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LauncherError('Managed Windows application inventory is invalid.');
  }
  return `{${Object.keys(value).sort(byCodePoint).map((key) => `${pyString(key)}:${compact_sorted(value[key])}`).join(',')}}`;
}

function sha256File(file) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1 << 20);
  const fd = openSync(file, 'r');
  try {
    for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** The release's node.exe after the generation checks (lcu/runtime.py's descriptor/containment/digest rules). */
export function validated_node(prefix, release) {
  const descriptor = JSON.parse(readFileSync(path.join(release, 'installation.json'), 'utf8'));
  const app = descriptor?.app;
  const digest = descriptor?.sha256;
  if (typeof app !== 'string' || !path.isAbsolute(app) || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new LauncherError('Selected Windows application descriptor is incomplete or unsupported.');
  }
  const apps = path.join(prefix, 'apps');
  const generation = path.join(apps, digest);
  const expected = path.join(generation, 'app');
  const inventoryPath = path.join(generation, 'inventory.json');
  const node = path.join(expected, NODE);
  const chain = [apps, generation, expected, inventoryPath];
  for (let item = path.dirname(node); item !== expected; item = path.dirname(item)) chain.push(item);
  chain.push(node);
  if (!samePath(path.resolve(app), expected) || chain.some(redirected) || !isFile(inventoryPath)) {
    throw new LauncherError('Selected Windows application is not the managed private generation.');
  }
  let inventory;
  try {
    inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  } catch {
    throw new LauncherError('Managed Windows application inventory is invalid.');
  }
  if (createHash('sha256').update(compact_sorted(inventory), 'utf8').digest('hex') !== digest) {
    throw new LauncherError('Managed Windows application inventory does not match its descriptor.');
  }
  const recorded = inventory[NODE];
  if (!isFile(node) || recorded?.type !== 'file' || sha256File(node) !== recorded.sha256) {
    throw new LauncherError(`Windows application differs from selected source inventory: ${NODE}`);
  }
  return node;
}

function legacy_python(prefix) {
  try {
    const value = JSON.parse(readFileSync(path.join(prefix, 'launcher.json'), 'utf8'))?.python;
    if (typeof value === 'string' && path.isAbsolute(value)) return value;
  } catch { /* reported below */ }
  throw new LauncherError('The selected Windows release predates the Node launcher and no installer Python is recorded; rerun the LCU installer.');
}

/** [file, args, env] that run `args` in `release`. */
export function release_command(prefix, release, args, env = process.env) {
  if (isFile(path.join(release, ENTRY))) {
    const node = validated_node(prefix, release);
    return [node, ['--disable-warning=ExperimentalWarning', path.join(release, ENTRY), 'lcu', ...args], quarantined_environment(env)];
  }
  return [legacy_python(prefix), ['-B', path.join(release, 'bin/lcu'), ...args], { ...env }];
}

export function main(argv = process.argv.slice(2), { prefix = path.dirname(realpathSync(fileURLToPath(import.meta.url))) } = {}) {
  prefix = realpathSync.native(prefix);
  const release = selected_release(prefix);
  const [file, args, env] = release_command(prefix, release, argv);
  const result = spawnSync(file, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  restore_environment();
  try {
    process.exitCode = main();
  } catch (error) {
    writeSync(2, `LCU Windows launcher: ${error.message}\n`);
    process.exitCode = 1;
  }
}
