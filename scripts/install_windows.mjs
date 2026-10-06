#!/usr/bin/env node
// Install thin LCU beside the current user's official Windows Store app.
// Port of scripts/install_windows.py, minus the private copy: scripts/install_windows.py (the retained
// bridge) selects the registered Store app, makes and fully validates the intact
// private copy, publishes the generation, and runs THIS script with that copy's node.exe:
//   <generation>/app/app/resources/cua_node/bin/node.exe scripts/install_windows.mjs --app-generation <generation> ARGS
// Here the generation is re-validated against its recorded source inventory before the release is published.
// Fixture-tested only (no live Windows claims).
import './startup_env.mjs';
import {
  closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, utimesSync, writeFileSync, unlinkSync, readlinkSync, symlinkSync, chmodSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { io, PyPath, types } from '../lcu/compat/argparse.mjs';
import { ArgumentParser } from '../lcu/compat/argparse.mjs';
import { applicationInventory, inventorySha256 } from '../lcu/compat/hash.mjs';
import { resolve as posixResolve } from '../lcu/compat/pathlib.mjs';
import { dumps, loads, ValueError } from '../lcu/compat/pyjson.mjs';
import { runProcess } from '../lcu/compat/runas.mjs';
import { ALIASES, CLIENTS } from '../lcu/setup_clients.mjs';
import * as windowsModule from '../lcu/windows.mjs';
import * as windowsHostModule from '../lcu/windows_host.mjs';
import * as runtimeModule from '../lcu/runtime.mjs';
import { architecture, VERSION, verify } from './bundle_runtime.mjs';
import { copytree, run_main, SystemExit } from './install.mjs';

export const SOURCE = path.dirname(path.dirname(realpathSync(fileURLToPath(import.meta.url))));
export const PROG = 'install_windows.py';
export const DOC = "Install thin LCU beside the current user's official Windows Store app.";
/** The release's CLI entry module and invocation name (`<node> lcu/entry.mjs lcu ARGS`, runtime porter contract). */
export const RELEASE_ENTRY = 'lcu/entry.mjs';
export const INVOCATION = 'lcu';

/** Injection points for tests (Python's mock.patch targets in tests/test_build_windows.py). */
export const internals = {
  SOURCE,
  platform: () => process.platform,
  architecture,
  verify,
  checked_prefix: (prefix) => checked_prefix(prefix),
  validated_copy: (app, selected) => _validated_copy(app, selected),
  atomic_bytes: (target, data) => _atomic_bytes(target, data),
  replace: renameSync,
  linesep: () => (process.platform === 'win32' ? '\r\n' : '\n'),
  windows: windowsModule,
  materialize_original_host: (...args) => windowsHostModule.materialize_original_host(...args),
  plan_original_host: (...args) => windowsHostModule.plan_original_host(...args),
  paths: (...args) => runtimeModule.paths(...args),
  run: runProcess,
  execPath: () => process.execPath,
};

const TEXT = (value) => String(value);
const exists = (p) => existsSync(p);

export function _redirected(item) {
  try {
    // libuv reports junctions as symbolic links, so lstat covers Path.is_junction() too.
    return lstatSync(item).isSymbolicLink();
  } catch {
    return false;
  }
}

export function _extended_windows_name(value) {
  if (value.startsWith('\\\\?\\')) return value;
  if (value.startsWith('\\\\')) return `\\\\?\\UNC\\${value.slice(2)}`;
  return `\\\\?\\${value}`;
}

export function _copy_path(item) {
  // Windows long-path registry settings vary. The standard extended-length
  // spelling applies only to internal traversal/copy; descriptors stay normal.
  return process.platform === 'win32' ? _extended_windows_name(path.resolve(item)) : item;
}

const isDir = (item) => {
  try { return statSync(item).isDirectory(); } catch { return false; }
};
const isFile = (item) => {
  try { return statSync(item).isFile(); } catch { return false; }
};

/** Refuse reparse redirects before copying a registered package tree. */
export function _regular_tree(root) {
  if (_redirected(root) || !isDir(root)) {
    throw new ValueError(`Windows application directory is missing or redirected: ${root}`);
  }
  const walk = (directory) => {
    for (const entry of readdirSync(_copy_path(directory), { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (_redirected(item)) {
        throw new ValueError(`Windows application contains a redirected path: ${item}`);
      }
      if (entry.isDirectory()) walk(item);
    }
  };
  walk(root);
}

export function _generation(prefix, inventory_digest) {
  return path.join(prefix, 'apps', inventory_digest);
}

export function _validated_copy(app, selected) {
  _regular_tree(app);
  return internals.windows.validate_windows_app_tree(app, {
    expected_version: selected.version,
    expected_runtime: selected.runtime_version,
    expected_inventory: selected.inventory,
  });
}

export function _atomic_bytes(target, data) {
  if (_redirected(target)) {
    throw new ValueError(`Refusing a redirected Windows launcher file: ${target}`);
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}-${randomUUID().replaceAll('-', '')}.tmp`);
  try {
    writeFileSync(temporary, data);
    internals.replace(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const resolveHost = (item) => {
  if (process.platform === 'win32') {
    try { return realpathSync.native(item); } catch { return path.resolve(item); }
  }
  return posixResolve(item);
};
const isRelativeTo = (item, root) => item === root || item.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

export function checked_prefix(prefix) {
  prefix = TEXT(prefix);
  const parts = prefix.split(/[\\/]+/).filter((part) => part !== '');
  const absolute = path.isAbsolute(prefix);
  const count = path.parse(prefix).root ? parts.length + 1 - (process.platform === 'win32' ? 1 : 0) : parts.length;
  if (!absolute || parts.includes('..') || count < 3) {
    throw new ValueError('Choose a dedicated absolute Windows installation directory.');
  }
  let item = prefix;
  for (;;) {
    if (_redirected(item)) {
      throw new ValueError(`Refusing a linked Windows installation path: ${item}`);
    }
    const parent = path.dirname(item);
    if (parent === item) break;
    item = parent;
  }
  prefix = resolveHost(prefix);
  const source = resolveHost(internals.SOURCE);
  if (prefix === source || isRelativeTo(source, prefix)) {
    throw new ValueError('Install outside the extracted release archive.');
  }
  if (exists(prefix) && readdirSync(prefix).length > 0 && !isFile(path.join(prefix, '.lcu-install'))) {
    throw new ValueError('Installation directory is occupied by another application.');
  }
  if (_redirected(path.join(prefix, '.lcu-install'))) {
    throw new ValueError('Refusing a redirected Windows installation marker.');
  }
  return prefix;
}

/** The recorded SHA-256 of the private copy's node.exe (inventory keys are relative to <generation>/app). */
export function node_sha256(inventory) {
  const entry = inventory.get('app/resources/cua_node/bin/node.exe');
  const digest = entry instanceof Map ? entry.get('sha256') : null;
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new ValueError('Managed Windows application inventory has no node.exe digest.');
  }
  return digest;
}

/** The private copy's node.exe, which is also the interpreter that runs this script. */
export function node_executable(generation) {
  return path.join(generation, 'app', 'app', 'resources', 'cua_node', 'bin', 'node.exe');
}

/**
 * Re-validate the generation the bridge handed over: it must be apps/<inventory digest> of this prefix, its
 * recorded inventory must hash to that digest, and the whole copy must still match it (identity version and
 * runtime come from the copy's own manifests, which the inventory covers).
 */
export function load_generation(prefix, app_generation) {
  const generation = path.resolve(TEXT(app_generation));
  const apps = path.join(prefix, 'apps');
  if (_redirected(apps) || _redirected(generation)) {
    throw new ValueError(`Refusing a redirected Windows app generation: ${generation}`);
  }
  if (path.dirname(generation) !== apps || !/^[0-9a-f]{64}$/.test(path.basename(generation))) {
    throw new ValueError('The Windows application generation does not belong to this installation.');
  }
  const inventory_path = path.join(generation, 'inventory.json');
  if (_redirected(inventory_path) || !isFile(inventory_path)) {
    throw new ValueError('Managed Windows application inventory is missing or redirected.');
  }
  let recorded;
  try {
    recorded = loads(readFileSync(inventory_path, 'utf8'));
  } catch (error) {
    if (error instanceof ValueError || error?.name === 'JSONDecodeError' || error?.name === 'UnicodeDecodeError'
        || typeof error?.code === 'string') {
      throw new ValueError('Managed Windows application inventory is missing or invalid.');
    }
    throw error;
  }
  const digest = inventorySha256(recorded);
  if (digest !== path.basename(generation)) {
    throw new ValueError('Managed Windows application inventory differs from the selected Store app.');
  }
  const app = path.join(generation, 'app');
  const windows = internals.windows;
  const version = windows._appx_identity(app)[2];
  const runtime_version = windows._runtime_manifest(app).get('runtime_archive_version');
  const selected = { app, version, runtime_version, inventory: recorded, inventory_digest: digest };
  internals.validated_copy(app, selected);
  return { generation, selected, digest };
}

/** Path.write_text(text): Python's text mode translates '\n' to os.linesep (CRLF on Windows). */
export function write_text(file, text) {
  writeFileSync(file, internals.linesep() === '\n' ? text : text.replaceAll('\n', internals.linesep()));
}

// The Node startup variables (BRIEF addendum B; same list as scripts/startup_env.mjs and lcu/entry.mjs).
export { QUARANTINED } from './startup_env.mjs';
import { QUARANTINED as STARTUP_VARIABLES } from './startup_env.mjs';

/** The environment for an LCU Node child: the caller's variables, with Node's startup ones moved to __LCU_Q_*. */
export function quarantined_environment(env = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(env)) if (!key.toUpperCase().startsWith('__LCU_')) result[key] = value;
  const moved = [];
  for (const name of STARTUP_VARIABLES) {
    const key = Object.keys(result).find((k) => k.toUpperCase() === name.toUpperCase());
    if (key === undefined) continue;
    result[`__LCU_Q_${name}`] = result[key];
    delete result[key];
    moved.push(name);
  }
  if (moved.length) result.__LCU_Q = moved.join(',');
  return result;
}

// A value baked into a .cmd file: `%` must be doubled; Windows paths cannot contain `"`.
const cmdQuoted = (value) => String(value).replaceAll('%', '%%');

/**
 * <prefix>\lcu.cmd: the stable launcher. Before LCU's own node.exe runs it checks (no Node yet) that every path
 * component from the prefix to node.exe exists and is not a reparse point, and that node.exe still has the SHA-256
 * the source-derived inventory recorded (certutil, a Windows system tool); then it moves the Node startup variables
 * to __LCU_Q_* (restored by the dispatcher for the release's children) and runs the dispatcher.
 */
export function command_file_text({ prefix, generation, node, sha256 }) {
  const components = [prefix];
  for (let item = node; item !== prefix && item !== path.dirname(item); item = path.dirname(item)) components.splice(1, 0, item);
  const lines = [
    '@echo off',
    'setlocal EnableExtensions DisableDelayedExpansion',
    'rem LCU stable launcher, written by the LCU installer: checks the private Node, then runs the dispatcher.',
    `set "LCU_NODE=${cmdQuoted(node)}"`,
    `for %%P in (${components.map((item) => `"${cmdQuoted(item)}"`).join(' ')}) do call :lcu_plain "%%~P" || exit /b 1`,
    'call :lcu_digest || exit /b 1',
    'set "__LCU_Q="',
    `for %%V in (${STARTUP_VARIABLES.join(' ')}) do if defined %%V call :lcu_quarantine %%V`,
    '"%LCU_NODE%" --disable-warning=ExperimentalWarning "%~dp0windows_launcher.mjs" %*',
    'exit /b %ERRORLEVEL%',
    ':lcu_plain',
    'set "LCU_ATTR="',
    'for %%I in ("%~1") do set "LCU_ATTR=%%~aI"',
    'if not defined LCU_ATTR (set "LCU_REASON=%~1 is missing" & goto :lcu_refuse)',
    'if not "%LCU_ATTR:l=%"=="%LCU_ATTR%" (set "LCU_REASON=%~1 is a redirected path" & goto :lcu_refuse)',
    'exit /b 0',
    ':lcu_digest',
    'set "LCU_HASH="',
    String.raw`for /f "skip=1 delims=" %%H in ('""%SystemRoot%\System32\certutil.exe" -hashfile "%LCU_NODE%" SHA256 2>nul"') do if not defined LCU_HASH set "LCU_HASH=%%H"`,
    'if defined LCU_HASH set "LCU_HASH=%LCU_HASH: =%"',
    `if /i not "%LCU_HASH%"=="${sha256}" (set "LCU_REASON=it differs from the recorded private copy" & goto :lcu_refuse)`,
    'exit /b 0',
    ':lcu_quarantine',
    String.raw`for /f "tokens=1* delims==" %%A in ('set %1 2^>nul') do if /i "%%A"=="%1" set "__LCU_Q_%1=%%B"`,
    'set "%1="',
    'if defined __LCU_Q (call set "__LCU_Q=%%__LCU_Q%%,%1") else set "__LCU_Q=%1"',
    'exit /b 0',
    ':lcu_refuse',
    'setlocal EnableDelayedExpansion',
    ">&2 echo(LCU: Cannot run the ChatGPT app's bundled Node (!LCU_NODE!): !LCU_REASON!. Repair the official app and rerun the LCU installer.",
    'exit /b 1',
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export function install(prefix, { app_generation = null, legacy_python = null } = {}) {
  if (internals.platform() !== 'win32') {
    throw new ValueError('The Windows installer must run in Windows 11 x64.');
  }
  const arch = internals.architecture('windows');
  internals.verify(internals.SOURCE, arch, 'windows');
  prefix = internals.checked_prefix(prefix);
  const lock = loads(readFileSync(path.join(internals.SOURCE, 'runtime.lock.json'), 'utf8'))
    .get('platforms').get('windows');
  const architectures = lock.has('architectures') ? lock.get('architectures') : new Map();
  if (!architectures.has('x64')) {
    throw new ValueError('This LCU archive does not include the Windows x64 runtime.');
  }
  if (app_generation === null || app_generation === undefined) {
    throw new ValueError('Run scripts/install_windows.py: it prepares the private copy of the Windows application.');
  }
  const { generation, selected, digest } = load_generation(prefix, app_generation);
  let release = null;
  const previous_launchers = new Map();
  const replaced_launchers = [];
  let temporary = null;
  let committed = false;
  const app = path.join(generation, 'app');
  // Everything from here on is inside the cleanup boundary, including the
  // release directory checks, so a failure never leaves a partial release behind.
  try {
    const releases = path.join(prefix, 'releases');
    if (_redirected(releases)) {
      throw new ValueError(`Refusing a redirected Windows release directory: ${releases}`);
    }
    mkdirSync(releases, { recursive: true });
    release = path.join(releases, `${VERSION}-${randomUUID().replaceAll('-', '').slice(0, 12)}`);
    copytree(internals.SOURCE, release);
    internals.verify(release, arch, 'windows');
    internals.materialize_original_host(app, path.join(release, 'lcu-host'));
    write_text(path.join(release, 'installation.json'), `${dumps({
      platform: 'windows', architecture: 'x64', app, package_version: selected.version,
      runtime: selected.runtime_version, sha256: digest,
    }, { indent: 2 })}\n`);
    internals.paths(release);
    // Order: launcher.json first, so a new dispatcher that meets the still-selected pre-port release (until
    // current.json is replaced, or after a rollback) already finds the installer's Python (`python`); then the
    // dispatcher, the Python trampoline for old registrations, and lcu.cmd. current.json is published last.
    const launchers = [
      // lcu/setup.mjs windows_launcher(prefix): the [node.exe, dispatcher] pair new registrations embed.
      [path.join(prefix, 'launcher.json'), Buffer.from(`${dumps(new Map([
        ['node', node_executable(generation)], ['dispatcher', path.join(prefix, 'windows_launcher.mjs')],
        ...(legacy_python ? [['python', String(legacy_python)]] : []),
      ]), { indent: 2 })}\n`)],
      [path.join(prefix, 'windows_launcher.mjs'), readFileSync(path.join(release, 'scripts/windows_launcher.mjs'))],
      [path.join(prefix, 'windows_launcher.py'), readFileSync(path.join(release, 'scripts/windows_launcher.py'))],
      [path.join(prefix, 'lcu.cmd'), Buffer.from(command_file_text({
        prefix, generation, node: node_executable(generation), sha256: node_sha256(selected.inventory),
      }))],
    ];
    if (launchers.some(([file]) => _redirected(file))) {
      throw new ValueError('Refusing a redirected Windows launcher file.');
    }
    for (const [file] of launchers) previous_launchers.set(file, exists(file) ? readFileSync(file) : null);
    for (const [file, data] of launchers) {
      internals.atomic_bytes(file, data);
      replaced_launchers.push(file);
    }
    temporary = path.join(prefix, `.current-${randomUUID().replaceAll('-', '')}.json`);
    write_text(temporary, `${dumps({ release: path.basename(release) })}\n`);
    internals.replace(temporary, path.join(prefix, 'current.json'));
    committed = true;
  } catch (error) {
    if (committed) throw error;
    try {
      if (temporary !== null) rmSync(temporary, { force: true });
      for (const file of [...replaced_launchers].reverse()) {
        const content = previous_launchers.get(file);
        if (content === null) rmSync(file, { force: true });
        else internals.atomic_bytes(file, content);
      }
    } finally {
      if (release !== null) rmSync(_copy_path(release), { recursive: true, force: true });
    }
    throw error;
  }
  return release;
}

export function build_parser() {
  const parser = new ArgumentParser({ prog: PROG, description: DOC });
  const base = process.env.LOCALAPPDATA ?? `${homedir()}/AppData/Local`;
  parser.add_argument('--prefix', { type: types.Path, default: new PyPath(`${base}/LCU`) });
  parser.add_argument('--runtime-only', { action: 'store_true' });
  parser.add_argument('--agent', { action: 'append', choices: [...Object.keys(CLIENTS), ...Object.keys(ALIASES)] });
  parser.add_argument('--chrome', { action: 'store_true' });
  parser.add_argument('--no-chrome', { action: 'store_true' });
  parser.add_argument('--audio', { action: 'store_true' });
  parser.add_argument('--no-audio', { action: 'store_true' });
  parser.add_argument('--yes', { action: 'store_true' });
  parser.add_argument('--scope', { choices: ['user', 'project'], default: 'user' });
  parser.add_argument('--project', { type: types.Path });
  // Added by the bridge; not part of the public interface (the bridge parser rejects it from users).
  parser.add_argument('--app-generation', { type: types.Path, help: '==SUPPRESS==' });
  parser.add_argument('--legacy-python', { help: '==SUPPRESS==' });
  return parser;
}

const truthy = (value) => value !== null && value !== undefined && value !== false && value !== ''
  && !(Array.isArray(value) && value.length === 0);

/**
 * `--check-host APP`: the bridge's read-only native-pipe host layout check before the private copy
 * (scripts/install_windows.py _preflight_host). It runs with a temporary copy of the selected app's node.exe, which
 * also runs the structural analyzer. Prints {"ok": true} or {"ok": false, "error": "<layout error>"}.
 */
export function check_host(app) {
  try {
    internals.plan_original_host(app, { node: internals.execPath() });
  } catch (error) {
    if (!(error instanceof ValueError)) throw error;
    io.stdout(`${dumps(new Map([['ok', false], ['error', error.message]]))}\n`);
    return;
  }
  io.stdout(`${dumps(new Map([['ok', true]]))}\n`);
}

export function main(argv = null) {
  argv = argv ?? process.argv.slice(2);
  if (argv.length === 2 && argv[0] === '--check-host') {
    check_host(argv[1]);
    return;
  }
  const parser = build_parser();
  const args = parser.parse_args(argv);
  const g = (key) => args.get(key);
  if (g('runtime_only') && (truthy(g('agent')) || g('chrome') || g('audio') || g('no_chrome')
      || g('no_audio') || g('project') !== null || g('scope') !== 'user')) {
    parser.error('--runtime-only cannot include agent setup options');
  }
  if (!g('runtime_only') && !truthy(g('agent'))) {
    parser.error(`Choose --agent NAME or --runtime-only. Agents: ${Object.keys(CLIENTS).join(', ')}`);
  }
  const release = internals.install(g('prefix'), { app_generation: g('app_generation'), legacy_python: g('legacy_python') });
  io.stdout(`LCU installed: ${path.join(String(g('prefix')), 'lcu.cmd')}\n`);
  if (!g('runtime_only')) {
    const command = [internals.execPath(), path.join(release, RELEASE_ENTRY), INVOCATION, 'setup',
      '--prefix', String(g('prefix')), '--session', 'direct', '--scope', g('scope')];
    for (const agent of g('agent')) command.push('--agent', agent);
    if (g('project') !== null) command.push('--project', String(g('project')));
    if (g('chrome')) command.push('--chrome');
    if (g('no_chrome')) command.push('--no-chrome');
    if (g('audio')) command.push('--audio');
    if (g('no_audio')) command.push('--no-audio');
    if (g('yes')) command.push('--yes');
    internals.run(command, { check: true, env: quarantined_environment(process.env) });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run_main(null, { prefix: 'LCU Windows installer', entry: main });
}
