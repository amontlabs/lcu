// Launch the selected application's original computer-use provider.
// Port of lcu/runtime.py (see .port/notes/runtime.md for the function map and deviations).
//
// Differences in shape from the Python (all documented in the notes):
//  * main() is async: sub-command modules are loaded with dynamic import, and the macOS/Windows supervised
//    launch awaits a child process. Everything else is synchronous, as in Python.
//  * Anything a test replaced with mock.patch is an entry of `internals` (the platforms.mjs convention).
//  * `raise SystemExit(n)` is `throw new PySystemExit(n)` (compat/argparse); lcu/entry.mjs maps it to the exit status.
//  * Loaded JSON uses the compat/pyjson model (dict -> Map, int -> BigInt); descriptors passed in by callers
//    may be either that model or plain objects (`get`/`need` accept both).
import { accessSync, constants as fsConstants, lstatSync, readFileSync, readSync, statSync, writeSync } from 'node:fs';
import { isatty } from 'node:tty';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import nodePath from 'node:path';
import { constants as osConstants } from 'node:os';

import { dumps, isFloat, isInt, JSONDecodeError, loads, UnicodeDecodeError, ValueError } from './compat/pyjson.mjs';
import { io, PySystemExit, pyStrip } from './compat/argparse.mjs';
import { getpwuid } from './compat/accounts.mjs';
import { asUri, normpath, pathExpanduser, pathStr, realpath, resolve } from './compat/pathlib.mjs';
import { join as posixJoin } from './compat/pypath.mjs';
import { fromNodeError, isOSError } from './compat/pyerr.mjs';
import { py_str } from './compat/pystr.mjs';
import { isValueError } from './compat/errors.mjs';
import { decode } from './compat/utf8.mjs';
import { execError, execve, preflight } from './compat/execve.mjs';
import { ignored_signals, quarantine_environment, reignore } from './startup_vars.mjs';
import { locate_codex_tools } from './app_layout.mjs';
import * as tested from './tested.mjs';
import * as sandbox_shim from './sandbox_shim.mjs';

export const USAGE = ['Usage: lcu [--chrome] [--audio] [--mcp-discovery-compat]',
  '       lcu setup OPTIONS',
  '       lcu browser install',
  '       lcu browser status',
  '       lcu apps [list|allow APP|revoke APP] [--json]   (macOS)',
  '       lcu origins [list [--session ID] [--json]]',
  '       lcu origins forget ORIGIN [--session ID | --all-sessions] [--allowed | --denied]',
  '       lcu prune [--keep N] [--yes]',
  '       lcu update [--check [--json]] [--yes]',
  '       lcu doctor',
  '       lcu status [--json]',
  '       lcu --version'].join('\n');

// What `lcu --help` prints after USAGE (bin/lcu keeps a static copy; a test compares the two).
export const HELP_SUFFIX = '\nWith no arguments, starts the original computer-use stdio MCP server. ' +
  '`lcu --chrome` also enables its browser surface; `lcu setup --chrome` registers that command. ' +
  '`lcu --audio` enables the original optional computer-audio API; `lcu setup --audio` registers that command.';

const require = createRequire(import.meta.url);

/** Test injection points (Python's mock.patch targets). Production leaves every entry at its default. */
export const internals = {
  // Sibling modules that do not exist in every archive (platforms.* is absent from Windows archives,
  // windows.* from the others) are required lazily and synchronously, like Python's function-level imports.
  platforms: () => require('./platforms.mjs'),
  windows: () => require('./windows.mjs'),
  // Command and host modules, imported on demand (Python's `from .x import main`).
  load: (name) => import(name),
  resolve_installed_mac_app: null,
  resolve_installed_linux_app: null,
  execve,
  access: (path, mode) => accessSync(path, mode),
  isatty: (fd) => isatty(fd),
  cwd: () => process.cwd(),
  chdir: (path) => process.chdir(path),
  argv0: () => process.argv[1] ?? '',
  home: () => pathExpanduser('~'),
  // subprocess.run(command, env=env, check=False).returncode with inherited stdio; resolves to the
  // return code (negative when the child died on a signal).
  supervise: (command, env) => supervise(command, env),
  stdin_source: () => fd_source(0),
  stdout_sink: () => fd_sink(1),
};

// ---------------------------------------------------------------------------------------------- helpers

class KeyError extends Error {
  constructor(key) {
    super(`'${key}'`);
    this.name = 'KeyError';
  }
}

/** The exception subprocess.run raises when the user interrupts a supervised child (SIGINT). */
export class KeyboardInterrupt extends Error {
  constructor() {
    super('');
    this.name = 'KeyboardInterrupt';
  }
}

const isDictLike = (value) => value instanceof Map || (value !== null && typeof value === 'object' && !Array.isArray(value));
// dict.get(key, default) on a parsed Map or a plain object.
function get(dict, key, fallback = null) {
  if (dict instanceof Map) return dict.has(key) ? dict.get(key) : fallback;
  return isDictLike(dict) && Object.hasOwn(dict, key) ? dict[key] : fallback;
}
const has = (dict, key) => (dict instanceof Map ? dict.has(key) : isDictLike(dict) && Object.hasOwn(dict, key));
// dict[key]
function need(dict, key) {
  if (!has(dict, key)) throw new KeyError(key);
  return get(dict, key);
}
// Python truthiness of a parsed value.
function truthy(value) {
  if (value === null || value === undefined || value === false || value === '' || value === 0n || value === 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  if (isFloat(value)) return value.value !== 0;
  if (isDictLike(value) && Object.getPrototypeOf(value) === Object.prototype) return Object.keys(value).length > 0;
  return true;
}
const isStr = (value) => typeof value === 'string';

function is_symlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
function is_file(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
// Path.read_text(): UTF-8, strict; OS errors read like Python's.
function read_text(path) {
  try {
    return decode(readFileSync(path));
  } catch (exc) {
    throw fromNodeError(exc, { filename: path }) ?? exc;
  }
}
const read_json = (path) => loads(read_text(path));

// Path('...') values are path strings; on a Windows host they follow the win32 flavour.
const join = (...parts) => (process.platform === 'win32' ? nodePath.win32.join(...parts) : pathStr(...parts));
const parent = (path) => (process.platform === 'win32' ? nodePath.win32.dirname(path) : nodePath.posix.dirname(pathStr(path)));
const name_of = (path) => (process.platform === 'win32' ? nodePath.win32.basename(path) : nodePath.posix.basename(pathStr(path)));
const is_absolute = (path) => (process.platform === 'win32' ? nodePath.win32.isAbsolute(path) : pathStr(path).startsWith('/'));

function write_all(fd, text) {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset);
    } catch (error) {
      if (error.code === 'EAGAIN') continue;
      throw error;
    }
  }
}
const print = (text, file = 'stdout') => io[file](`${text}\n`);

// dict.fromkeys(items) order-preserving de-duplication
const unique = (items) => [...new Set(items)];
const setdefault = (env, key, value) => {
  if (!Object.hasOwn(env, key)) env[key] = value;
};
const surfaces_of = (env) => new Set((env.CUA_REPL_ENABLED_SURFACES ?? '').split(',').map((surface) => pyStrip(surface)));

// ---------------------------------------------------------------------------------------------- paths

function mac_resolver() {
  return internals.resolve_installed_mac_app ?? internals.platforms().resolve_installed_mac_app;
}
function linux_resolver() {
  return internals.resolve_installed_linux_app ?? internals.platforms().resolve_installed_linux_app;
}

function path_arg(value) {
  // Path(value): only str (and PathLike) are accepted.
  if (typeof value !== 'string') {
    throw new TypeError(`argument should be a str or an os.PathLike object where __fspath__ returns a str, not '${
      value === null ? 'NoneType' : typeof value === 'bigint' ? 'int' : typeof value === 'boolean' ? 'bool' : typeof value}'`);
  }
  return pathStr(value);
}

/** Resolve one selected, intact application generation. Returns [app, resources, runtime, {version, runtime}]. */
export function paths(root, descriptor = null) {
  const app = join(root, 'app');
  const resources = join(app, 'resources');
  const runtime = join(resources, 'cua_node');
  const lock = read_json(join(root, 'runtime.lock.json'));
  if (descriptor === null) {
    descriptor = read_json(join(root, 'installation.json'));
  }
  const selected = path_arg(get(descriptor, 'app', ''));
  const arch = get(descriptor, 'architecture');
  const target = get(descriptor, 'platform', 'linux');
  if (target === 'darwin') {
    const policy = get(get(lock, 'platforms', new Map()), 'darwin', new Map());
    const entry = get(get(policy, 'architectures', new Map()), arch);
    if (!is_absolute(selected) || !truthy(entry) || resolve(selected) !== resolve(app)) {
      throw new ValueError('Selected application descriptor does not match the supported macOS app link.');
    }
    const resolved = mac_resolver()(selected, { arch });
    return [resolved.app, resolved.resources, resolved.runtime, {
      version: resolved.version, runtime: resolved.runtime_version }];
  }
  if (target === 'windows') {
    const policy = get(get(lock, 'platforms', new Map()), 'windows', new Map());
    const entry = get(get(policy, 'architectures', new Map()), arch);
    const version = get(descriptor, 'package_version');
    const runtime_version = get(descriptor, 'runtime');
    const inventory_digest = get(descriptor, 'sha256');
    if (!is_absolute(selected) || arch !== 'x64' || !truthy(entry) ||
        !isStr(version) || !version ||
        !isStr(runtime_version) || !runtime_version ||
        !isStr(inventory_digest) || inventory_digest.length !== 64 ||
        [...inventory_digest].some((char) => !'0123456789abcdef'.includes(char))) {
      throw new ValueError('Selected Windows application descriptor is incomplete or unsupported.');
    }
    const prefix = parent(parent(root));
    const apps = join(prefix, 'apps');
    const generation = join(apps, inventory_digest);
    const expected = join(generation, 'app');
    const inventory_path = join(generation, 'inventory.json');
    // Node reports a junction as a symbolic link, so is_symlink() covers Path.is_junction().
    if (selected !== expected || [apps, generation, selected, inventory_path].some((path) => is_symlink(path)) ||
        !is_file(inventory_path)) {
      throw new ValueError('Selected Windows application is not the managed private generation.');
    }
    const windows = internals.windows();
    let inventory;
    try {
      inventory = read_json(inventory_path);
    } catch (exc) {
      if (exc instanceof JSONDecodeError || exc instanceof UnicodeDecodeError || is_os_error(exc)) {
        throw new ValueError('Managed Windows application inventory is invalid.');
      }
      throw exc;
    }
    if (windows.inventory_sha256(inventory) !== inventory_digest) {
      throw new ValueError('Managed Windows application inventory does not match its descriptor.');
    }
    const resolved = windows.validate_windows_app_tree(selected, {
      expected_version: version, expected_runtime: runtime_version, expected_inventory: inventory });
    if (resolved.app !== resolve(expected, { strict: true })) {
      throw new ValueError('Selected Windows application does not match the managed generation.');
    }
    return [resolved.app, resolved.resources, resolved.runtime, {
      version: resolved.version, runtime: resolved.runtime_version }];
  }
  if (target !== 'linux') {
    throw new ValueError(`Unsupported installed application platform: ${py_str(target)}`);
  }
  if (!is_absolute(selected) || !has(need(lock, 'architectures'), arch) ||
      resolve(selected) !== resolve(app)) {
    throw new ValueError('Selected application descriptor does not match the supported architecture and app link. ' +
                         'Rerun scripts/install.sh.');
  }
  let resolved;
  try {
    resolved = linux_resolver()(selected, { arch });
  } catch (exc) {
    if (is_value_error(exc)) throw new ValueError(`${exc.message}. Rerun scripts/install.sh.`);
    throw exc;
  }
  // Launch through the release's link, as before; it resolves to the installed app.
  return [app, resources, runtime, { version: resolved.version, runtime: resolved.runtime_version }];
}

const is_value_error = isValueError;
const is_os_error = isOSError;

// ---------------------------------------------------------------------------------------------- environment

/** The directory the original runtime uses when CODEX_HOME is not set. */
export function default_codex_home(env, windows) {
  const path_api = windows ? { join: nodePath.win32.join, normpath: nodePath.win32.normalize } : { join: posixJoin, normpath };
  const home = windows ? (env.USERPROFILE || env.HOME || internals.home()) : (
    'HOME' in env ? env.HOME : internals.home());
  const selected = path_api.normpath(path_api.join(home, '.codex'));
  // Node path.join collapses double leading slashes on Linux.
  return selected.startsWith('//') ? '/' + selected.replace(/^\/+/, '') : selected;
}

/** Build the child environment. Returns a plain object (a copy of process.env with LCU's additions). */
export function environment(root, resolved = null, { chrome = false, audio = false, platform = null } = {}) {
  resolved = resolved ?? paths(root);
  const [, resources, runtime, metadata] = resolved;
  const target = platform !== null ? platform : get(read_json(join(root, 'installation.json')), 'platform', 'linux');
  const windows = target === 'windows';
  const separator = windows ? ';' : nodePath.delimiter;
  const module_dir = join(runtime, windows ? 'bin/node_modules' : 'lib/node_modules');
  const node = join(runtime, windows ? 'bin/node.exe' : 'bin/node');
  const node_repl = join(runtime, windows ? 'bin/node_repl.exe' : 'bin/node_repl');
  const codex = locate_codex_tools(resources, { windows }).cli;
  const env = { ...process.env };
  // Original gM/nne selects and trusts CODEX_HOME verbatim, including an
  // explicitly empty value. This changes only the launched child environment.
  if (!('CODEX_HOME' in env)) {
    env.CODEX_HOME = default_codex_home(env, windows);
  }
  // Select our verified executables, while retaining upstream caller options,
  // metadata, services, policy flags, and additional module/trust roots.
  const prepend = (key, ...paths) => unique([
    ...paths.map(String).filter((path) => path),
    ...(env[key] ?? '').split(separator).filter((path) => path)]).join(separator);

  let existing_path;
  if (windows) {
    const found = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH');
    existing_path = found ? found[1] : '';
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'PATH') delete env[key];
    }
  } else {
    existing_path = 'PATH' in env ? env.PATH : '/usr/bin:/bin';
  }

  // env.update(...): every value is computed before any key is assigned.
  const updates = {
    PATH: join(runtime, 'bin') + separator + existing_path,
    CUA_REPL_NODE_REPL_PATH: node_repl,
    NODE_REPL_NODE_PATH: node,
    NODE_REPL_NODE_MODULE_DIRS: prepend('NODE_REPL_NODE_MODULE_DIRS', module_dir),
    NODE_REPL_TRUSTED_CODE_PATHS: prepend('NODE_REPL_TRUSTED_CODE_PATHS',
      env.CODEX_HOME, module_dir, join(resources, 'plugins')),
  };
  Object.assign(env, updates);
  // The original launcher selects both its API and instructions from this
  // surface list. External Chrome is an explicit opt-in for LCU clients.
  setdefault(env, 'CUA_REPL_ENABLED_SURFACES', chrome ? 'browser,computer' : 'computer');
  // These paired switches are the original optional computer-audio API gate.
  // Inherit caller policy when LCU was not explicitly asked to enable audio.
  if (audio) {
    env.SKY_ENABLE_AUDIO = '1';
    env.NODE_REPL_ENABLE_AUDIO = '1';
  }
  setdefault(env, 'CUA_REPL_BROWSER_ENV', 'codex-app');
  setdefault(env, 'CODEX_CLI_PATH', codex);
  if (name_of(parent(resources)) === 'Contents') {
    // Original Sky's macOS native-pipe transport uses this signed helper
    // through LaunchServices when no existing CUA service is connected.
    setdefault(env, 'SKY_CUA_SERVICE_PATH', join(runtime, 'lib/node_modules/@oai/sky/Codex Computer Use.app'));
  }
  // Fixed host defaults from nne/kie in the pinned application. The unified
  // codex-app surface is selected only with browserUseTinysky in original Lre.
  setdefault(env, 'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS', '1000');
  if (env.CUA_REPL_BROWSER_ENV === 'codex-app') {
    setdefault(env, 'BROWSER_USE_AVAILABLE_BACKENDS', 'chrome');
    setdefault(env, 'BROWSER_USE_TINYSKY_ENABLED', '1');
    const flavor = pyStrip(env.BUILD_FLAVOR ?? '');
    const valid_flavors = ['dev', 'agent', 'nightly', 'internal-alpha', 'public-beta', 'prod'];
    setdefault(env, 'BROWSER_USE_CODEX_APP_BUILD_FLAVOR', valid_flavors.includes(flavor) ? flavor : 'prod');
    setdefault(env, 'BROWSER_USE_CODEX_APP_VERSION', need(metadata, 'version'));
  }
  setdefault(env, 'NODE_REPL_DISABLE_ANALYTICS', '1');
  // Original browser service switch: do not initialize account identity or
  // telemetry. The relay already supplies the local agent-header decision.
  setdefault(env, 'BROWSER_USE_DISABLE_AMBIENT_NETWORK', '1');
  // Upstream browser routing needs an identity even for a generic MCP client.
  // This names this actual MCP connection, not a Codex model or an approval.
  // Host-supplied request metadata and per-call metadata keep precedence.
  if (!('NODE_REPL_REQUEST_META' in env)) {
    const identity = 'lcu-' + randomUUID();
    env.NODE_REPL_REQUEST_META = dumps({ 'x-codex-turn-metadata': {
      session_id: identity, turn_id: identity + '-connection' } });
  }
  if (target === 'linux') {
    _configure_linux_input(root, runtime, env, metadata);
    const mode = pyStrip(env.LCU_NODE_REPL_SANDBOX ?? '').toLowerCase();
    if (mode === 'off') {
      _default_linux_sandbox_state(env);
    } else if (mode !== 'host') {
      _configure_linux_sandbox_shim(root, runtime, env);
    }
  }
  return env;
}

export const LINUX_INPUT_TOOLKITS = ['gtk4', 'qt-scroll'];

export function linux_input_translation_off(env) {
  return ['off', '0', 'false', 'no'].includes(pyStrip(env.LCU_LINUX_INPUT_TRANSLATION ?? '').toLowerCase());
}

/**
 * Interpose a thin wrapper on the Sky RPC for window-targeted input GTK 4 and Qt ignore.
 *
 * The original Linux engine sends window-targeted keys, clicks, scroll and drag with
 * XSendEvent, which GTK 4 (XInput2 only) ignores, and Qt ignores for scroll. The wrapper
 * re-issues those calls through the engine's own desktop-level path for those windows only.
 * `LCU_LINUX_INPUT_TRANSLATION=off` leaves the original service in place. An exact tested
 * app/runtime pair whose record lists `native_input` is not translated for those toolkits.
 */
export function _configure_linux_input(root, runtime, env, metadata) {
  if (linux_input_translation_off(env)) return;
  const wrapper = join(root, 'lcu/linux_sky_service.mjs');
  const service = join(runtime, 'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js');
  const surfaces = surfaces_of(env);
  if (!surfaces.has('computer') || !is_file(wrapper)) return;
  let toolkits = [...LINUX_INPUT_TOOLKITS];
  try {
    const descriptor = read_json(join(root, 'installation.json'));
    const native = tested.native_input(root, {
      platform: 'linux', architecture: get(descriptor, 'architecture'),
      app_version: need(metadata, 'version'), runtime: need(metadata, 'runtime') });
    toolkits = toolkits.filter((toolkit) => !native.includes(toolkit));
  } catch (exc) {
    // (OSError, ValueError, KeyError, TypeError)
    if (!(is_os_error(exc) || is_value_error(exc) || exc?.name === 'KeyError' || exc instanceof TypeError)) throw exc;
  }
  if (toolkits.length === 0) return;
  // The original launcher keeps a caller-supplied service map verbatim. Wrap Sky only when no map is
  // supplied, or when the caller's map names the original Sky service explicitly (or already this wrapper).
  const raw_services = env.NODE_REPL_TRUSTED_SERVICES;
  if (raw_services !== undefined) {
    let supplied;
    try {
      supplied = loads(raw_services);
    } catch (exc) {
      if (is_value_error(exc)) return;
      throw exc;
    }
    if (!(supplied instanceof Map) || !['@oai/sky/service', wrapper].includes(supplied.get('sky'))) {
      return; // an empty, custom-only or custom-Sky map is the caller's and stays exactly as given
    }
  }
  try {
    _override_trusted_service(env, wrapper, nodePath.delimiter, 'Linux', { computer_gated: true });
  } catch (exc) {
    if (is_value_error(exc)) return;
    throw exc;
  }
  env.LCU_LINUX_SKY_SERVICE_PATH = service;
  env.LCU_LINUX_INPUT_TOOLKITS = toolkits.join(',');
}

/**
 * Keep the model's JavaScript kernel sandboxed while Sky, the trusted worker, can reach X11.
 *
 * With no `codex/sandbox-state-meta` the original node_repl runs its kernel and trusted Sky
 * worker under `codex sandbox` with network disabled whenever the machine supports bubblewrap.
 * That seccomp filter refuses connect(2), so Sky cannot reach the X11 socket. node_repl starts
 * both through CODEX_CLI_PATH, so LCU points it at a launcher shim (`sandbox_shim`) that leaves
 * the kernel sandboxed as asked and starts only the identified Sky worker outside it. A host
 * that sends its own `codex/sandbox-state-meta` (a `disabled` profile included) keeps full
 * precedence: node_repl then asks for the sandbox it was told to. Without the shim file the
 * original behavior stays, which fails closed. LCU_NODE_REPL_SANDBOX=host leaves everything
 * untouched and `off` runs the kernel unsandboxed (see `_default_linux_sandbox_state`).
 */
export function _configure_linux_sandbox_shim(root, runtime, env) {
  const shim = join(root, 'bin/lcu-codex-sandbox');
  if (!is_file(shim) || !env.CODEX_CLI_PATH) return;
  const wrapper = join(root, 'lcu/linux_sky_service.mjs');
  let sky;
  try {
    const services = loads(need(env, 'NODE_REPL_TRUSTED_SERVICES'));
    if (!(services instanceof Map)) throw new KeyError('get'); // AttributeError: no .get
    sky = services.has('sky') ? services.get('sky') : null;
  } catch (exc) {
    // (KeyError, ValueError, AttributeError)
    if (!(exc?.name === 'KeyError' || is_value_error(exc))) throw exc;
    // The original launcher defaults to the original Sky service when no map is supplied.
    sky = sandbox_shim.SKY_SERVICE;
  }
  env[sandbox_shim.CONFIG_ENV] = sandbox_shim.configuration(
    runtime, env.CODEX_CLI_PATH, sky === wrapper ? wrapper : null);
  // node_repl starts the kernel with only the variables on this list; the shim needs its
  // configuration there too, because it must find the real Codex to sandbox the kernel with. The
  // test-only fault hook travels the same way and can only make the shim refuse.
  const shared = [sandbox_shim.CONFIG_ENV, ...(sandbox_shim.FAULT_ENV in env ? [sandbox_shim.FAULT_ENV] : [])];
  env.NODE_REPL_UNTRUSTED_ENV_ALLOWLIST = [env.NODE_REPL_UNTRUSTED_ENV_ALLOWLIST, ...shared]
    .filter((item) => item).join(',');
  env.CODEX_CLI_PATH = shim;
}

export const SANDBOX_STATE_META = 'codex/sandbox-state-meta';

/**
 * Give the original node_repl the `disabled` sandbox state official Codex sends under
 * danger-full-access, so it starts neither its JavaScript kernel nor its Sky worker in
 * `codex sandbox` (`LCU_NODE_REPL_SANDBOX=off`; no longer the default). A host that sends its
 * own `codex/sandbox-state-meta` per call, or one in NODE_REPL_REQUEST_META, keeps precedence.
 */
export function _default_linux_sandbox_state(env) {
  let request;
  try {
    request = loads(env.NODE_REPL_REQUEST_META);
  } catch (exc) {
    if (is_value_error(exc)) return undefined;
    throw exc;
  }
  if (!(request instanceof Map) || request.has(SANDBOX_STATE_META)) return undefined;
  let cwd;
  try {
    cwd = internals.cwd();
  } catch (exc) {
    if (!is_os_error(exc)) throw exc;
    cwd = '/';
  }
  request.set(SANDBOX_STATE_META, new Map([
    ['permissionProfile', new Map([['type', 'disabled']])], ['sandboxCwd', asUri(cwd)]]));
  env.NODE_REPL_REQUEST_META = dumps(request);
  return env;
}

/**
 * Start from `/` when the launch directory cannot be entered.
 *
 * Without a sandbox state of its own, `node_repl` starts its kernel in the process's working
 * directory and fails with "Permission denied" when the account cannot enter it.
 */
export function _leave_unusable_working_directory() {
  let usable;
  try {
    internals.access('.', fsConstants.R_OK | fsConstants.X_OK);
    usable = true;
  } catch {
    usable = false;
  }
  if (!usable) internals.chdir('/');
}

// ---------------------------------------------------------------------------------------------- discovery compat

/** A synchronous byte source over a file descriptor: read(1) returns one byte, or an empty Buffer at EOF. */
export function fd_source(fd) {
  return {
    read(count) {
      const buffer = Buffer.alloc(count);
      for (;;) {
        try {
          return buffer.subarray(0, readSync(fd, buffer, 0, count, null));
        } catch (error) {
          if (error.code === 'EAGAIN') {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // O_NONBLOCK descriptor: wait for data
            continue;
          }
          if (error.code === 'EOF') return Buffer.alloc(0);
          throw error;
        }
      }
    },
  };
}

/** A synchronous sink over a file descriptor: every write is complete when it returns. */
export function fd_sink(fd) {
  return {
    write(data) {
      const buffer = Buffer.from(data);
      let offset = 0;
      while (offset < buffer.length) {
        try {
          offset += writeSync(fd, buffer, offset);
        } catch (error) {
          if (error.code === 'EAGAIN') {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
            continue;
          }
          throw error;
        }
      }
    },
    flush() {},
  };
}

/**
 * Return a legacy-version probe error without reading beyond its line.
 *
 * `source.read(1)` and `destination.write(bytes)` are synchronous: the process execve()s right after, so
 * nothing read ahead or queued for later may exist (see .port/codex/decision-risks.md, section 5).
 */
export function reply_to_server_discover(source, destination) {
  const raw = [];
  while (raw.length <= 1024 * 1024) {
    const byte = source.read(1);
    if (!byte || byte.length === 0) break;
    raw.push(byte[0]);
    if (byte[0] === 0x0a) break;
  }
  if (raw.at(-1) !== 0x0a) {
    throw new ValueError('Expected a newline-terminated initial JSON-RPC server/discover request.');
  }
  if (raw.length > 1024 * 1024) {
    throw new ValueError('Initial JSON-RPC server/discover request exceeds 1 MiB.');
  }
  let request;
  try {
    request = loads(Buffer.from(raw));
  } catch (exc) {
    if (exc instanceof UnicodeDecodeError || exc instanceof JSONDecodeError) {
      throw new ValueError('Expected a valid initial JSON-RPC server/discover request.');
    }
    throw exc;
  }
  const request_id = request instanceof Map ? (request.has('id') ? request.get('id') : null) : null;
  const is_number = isInt(request_id) || isFloat(request_id) || typeof request_id === 'number';
  if (!(request instanceof Map) || request.get('jsonrpc') !== '2.0' ||
      request.get('method') !== 'server/discover' ||
      typeof request_id === 'boolean' || !(typeof request_id === 'string' || is_number)) {
    throw new ValueError('Expected an initial JSON-RPC server/discover request in compatibility mode.');
  }
  const response = new Map([['jsonrpc', '2.0'], ['id', request_id],
    ['error', new Map([['code', -32601], ['message', 'Method not found']])]]);
  destination.write(Buffer.from(dumps(response, { separators: [',', ':'] }) + '\n'));
  destination.flush();
}

/** Add the native-cleanup Sky wrapper while keeping any other trusted services. */
export function _override_trusted_service(env, wrapper, separator, platform_name, { computer_gated }) {
  const surfaces = surfaces_of(env);
  const gate = computer_gated ? surfaces.has('computer') : true;
  const raw_services = env.NODE_REPL_TRUSTED_SERVICES;
  let supplied = raw_services !== undefined ? loads(raw_services) : null;
  if (raw_services === undefined) {
    supplied = new Map();
    if (surfaces.has('browser')) supplied.set('browser', '@oai/browser-desktop/service');
    if (gate) supplied.set('sky', '@oai/sky/service');
  }
  if (!(supplied instanceof Map) || [...supplied].some(([key, value]) => !isStr(key) || !isStr(value))) {
    throw new ValueError('NODE_REPL_TRUSTED_SERVICES must be a JSON string map.');
  }
  const sky = supplied.has('sky') ? supplied.get('sky') : null;
  if (gate && ![null, '@oai/sky/service', wrapper].includes(sky)) {
    throw new ValueError(`A custom Sky trusted-service override conflicts with ${platform_name} native cleanup.`);
  }
  const services = new Map(supplied);
  if (gate) services.set('sky', wrapper);
  env.NODE_REPL_TRUSTED_SERVICES = dumps(services);
  env.NODE_REPL_TRUSTED_CODE_PATHS = unique([parent(wrapper),
    ...(env.NODE_REPL_TRUSTED_CODE_PATHS ?? '').split(separator).filter((path) => path)]).join(separator);
}

/** Keep original Sky behavior and add only its turn-ended host hook. */
export function _configure_macos_lifecycle(root, runtime, env) {
  const surfaces = surfaces_of(env);
  if (!surfaces.has('computer')) return null;
  const wrapper = join(root, 'lcu/macos_sky_service.mjs');
  _override_trusted_service(env, wrapper, nodePath.delimiter, 'macOS', { computer_gated: false });
  env.LCU_MAC_SKY_SERVICE_PATH = join(runtime, 'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js');
  env.LCU_MAC_SKY_CLIENT_PATH = join(runtime, 'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/client.js');
  const client = join(env.SKY_CUA_SERVICE_PATH,
    'Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient');
  return client;
}

// ---------------------------------------------------------------------------------------------- supervision

/**
 * subprocess.run(command, env=env, check=False).returncode with inherited stdio.
 *
 * Python's behaviour on SIGINT (KeyboardInterrupt in subprocess.run): wait 0.25 s for the child, then
 * kill it with SIGKILL and re-raise; the caller's `finally` blocks run and the process ends by SIGINT.
 * A second SIGINT during that wait kills the child at once (Python's KeyboardInterrupt escapes the wait).
 * SIGTERM and every other signal keep their default action (no handler), exactly as in Python.
 * Signals the caller left ignored stay ignored: no SIGINT handler then (the KeyboardInterrupt path does not
 * exist in Python either), and the child starts with them ignored again (startup_vars.reignore; libuv resets
 * dispositions in children, Python passes SIG_IGN on).
 */
export function supervise(command, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const ignored = ignored_signals();
    let file = command[0];
    let args = command.slice(1);
    if (ignored.length) {
      const failure = preflight(command[0], command, env);
      if (failure) {
        rejectPromise(execError(failure, command[0]));
        return;
      }
      const [wrapper, argv] = reignore(command[0], command, env);
      file = wrapper;
      args = argv.slice(1);
    }
    const child = spawn(file, args, { env, stdio: 'inherit' });
    let finished = false;
    let interrupted = false;
    const onInterrupt = () => {
      if (interrupted) {
        if (!finished) child.kill('SIGKILL');
        return;
      }
      interrupted = true;
      setTimeout(() => {
        if (!finished) child.kill('SIGKILL');
      }, 250);
    };
    const handles = !ignored.includes('INT');
    if (handles) process.on('SIGINT', onInterrupt);
    const done = (callback) => {
      if (finished) return;
      finished = true;
      if (handles) process.off('SIGINT', onInterrupt);
      callback();
    };
    child.once('error', (error) => done(() => rejectPromise(fromNodeError(error, { filename: command[0] }) ?? error)));
    child.once('close', (code, signal) => done(() => {
      if (interrupted) rejectPromise(new KeyboardInterrupt());
      else resolvePromise(code ?? -(osConstants.signals[signal] ?? 0));
    }));
  });
}

// ---------------------------------------------------------------------------------------------- main

/** The `lcu` command. `argv` is the argument list after the program name; returns when Python's main returns. */
export async function main(root, argv) {
  argv = [...argv];
  // Agent registrations place LCU options before generic executable probes.
  const probe = [...argv];
  const probe_options = new Set();
  while (probe.length > 0 && ['--chrome', '--audio'].includes(probe[0]) && !probe_options.has(probe[0])) {
    probe_options.add(probe.shift());
  }
  if (probe.length === 1 && ['--help', '-h', '--version'].includes(probe[0])) {
    argv = probe;
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    print(USAGE + HELP_SUFFIX);
    return;
  }
  if (argv[0] === '--version') {
    const release_path = join(root, 'bundle.json');
    const version = is_file(release_path) ? need(read_json(release_path), 'version') : 'source-checkout';
    const descriptor_path = join(root, 'installation.json');
    const descriptor = is_file(descriptor_path) ? read_json(descriptor_path) : new Map();
    const target = get(descriptor, 'platform', 'linux');
    if (is_file(descriptor_path)) {
      let metadata;
      try {
        metadata = paths(root, descriptor)[3];
      } catch (exc) {
        if (!is_value_error(exc)) throw exc;
        print(`lcu ${version} (ChatGPT ${py_str(target)} app invalid: ${exc.message})`);
        throw new PySystemExit(1);
      }
      print(`lcu ${version} (ChatGPT ${py_str(target)} ${metadata.version}; CUA ${metadata.runtime})`);
    } else {
      print(`lcu ${version} (ChatGPT ${py_str(target)} app not selected)`);
    }
    return;
  }
  if (argv[0] === 'setup') {
    const { main: setup } = await internals.load('./setup.mjs');
    if (!argv.includes('--prefix')) {
      argv.push('--prefix', parent(parent(root)));
    }
    await setup(argv.slice(1));
    return;
  }
  if (argv[0] === 'browser') {
    const { main: browser } = await internals.load('./browser.mjs');
    await browser(root, argv.slice(1));
    return;
  }
  if (argv[0] === 'status') {
    const { main: status } = await internals.load('./status.mjs');
    await status(root, argv.slice(1));
    return;
  }
  if (argv[0] === 'apps') {
    const { main: apps } = await internals.load('./apps.mjs');
    await apps(root, argv.slice(1));
    return;
  }
  if (argv[0] === 'origins') {
    const { main: origins } = await internals.load('./origins.mjs');
    await origins(argv.slice(1));
    return;
  }
  if (argv[0] === 'prune') {
    const { main: maintenance } = await internals.load('./maintenance.mjs');
    await maintenance(root, argv.slice(1));
    return;
  }
  if (argv[0] === 'update') {
    const { main: update } = await internals.load('./update.mjs');
    const status = await update(root, argv.slice(1));
    if (status) throw new PySystemExit(status);
    return;
  }
  if (argv.length === 1 && argv[0] === '--with-browser-host') {
    throw new ValueError('--with-browser-host was removed with the embedded browser. ' +
                         'Run lcu browser install and enable the official Chrome extension.');
  }
  const count = (flag) => argv.filter((arg) => arg === flag).length;
  const chrome = count('--chrome') === 1;
  const audio = count('--audio') === 1;
  const direct_args = argv.filter((arg) => arg !== '--chrome' && arg !== '--audio');
  const doctor_args = direct_args[0] === 'doctor' ? direct_args.slice(1) : null;
  const discovery_compat = direct_args.length === 1 && direct_args[0] === '--mcp-discovery-compat';
  if (count('--chrome') > 1 || count('--audio') > 1 ||
      (!(direct_args.length === 0 || discovery_compat) && doctor_args === null)) {
    throw new ValueError(USAGE);
  }
  // `lcu doctor --help` documents the check without resolving the installed app.
  if (doctor_args !== null && (doctor_args.includes('--help') || doctor_args.includes('-h'))) {
    const { main: doctor } = await internals.load('./doctor.mjs');
    return doctor(root, doctor_args);
  }
  // A bare stdio server launched from a real terminal only appears to hang.
  if (direct_args.length === 0 && internals.isatty(0) && internals.isatty(1)) {
    // `lcu` is not on PATH; name the command exactly as it was invoked.
    const argv0 = internals.argv0();
    const command = is_absolute(argv0) ? argv0 : join(root, 'bin/lcu');
    print('lcu is a stdio MCP server, launched by an agent harness over pipes, not run directly.\n' +
          USAGE + `\nRun \`${command} setup\` to register it with a harness, ` +
          `or \`${command} doctor\` to check readiness.`, 'stderr');
    throw new PySystemExit(2);
  }
  const descriptor = read_json(join(root, 'installation.json'));
  const platform = get(descriptor, 'platform', 'linux');
  const resolved = paths(root, descriptor);
  const [app, resources, runtime] = resolved;
  const env = environment(root, resolved, { chrome, audio, platform });
  const windows = platform === 'windows';
  if (doctor_args !== null) {
    const { main: doctor } = await internals.load('./doctor.mjs');
    const status = await doctor(root, doctor_args, { resolved, env });
    if (status) throw new PySystemExit(status);
    return undefined;
  }
  let launcher;
  if (windows) {
    const { _component } = internals.windows();
    launcher = _component(parent(parent(resources)),
      'app/resources/cua_node/bin/node_modules/@oai/cua-repl/bin/cua-repl.mjs');
  } else {
    launcher = join(runtime, 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs');
  }
  const command = [env.NODE_REPL_NODE_PATH, launcher];
  if (discovery_compat) {
    reply_to_server_discover(internals.stdin_source(), internals.stdout_sink());
  }
  if (windows) {
    const { start_original_host, stop_original_host } = await internals.load('./windows_host.mjs');
    const { _component } = internals.windows();
    const helper = _component(app,
      'app/resources/cua_node/bin/node_modules/@oai/sky/bin/windows/codex-computer-use.exe');
    const transport = _component(app,
      'app/resources/cua_node/bin/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/windows/internal/helper_transport.js');
    const [host, pipe, lifetime] = await start_original_host({
      node: env.NODE_REPL_NODE_PATH, entry: join(root, 'lcu-host/windows-pipe-host.cjs'),
      helper, transport, env });
    env.SKY_CUA_NATIVE_PIPE = '1';
    env.SKY_CUA_NATIVE_PIPE_DIRECTORY = pipe;
    env.LCU_WRE_LIFETIME_PIPE = lifetime;
    env.LCU_WRE_SKY_SERVICE_PATH = _component(app,
      'app/resources/cua_node/bin/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js');
    const wrapper = join(root, 'lcu-host/windows-sky-service.mjs');
    let status;
    try {
      _override_trusted_service(env, wrapper, ';', 'Windows', { computer_gated: true });
      status = await internals.supervise(command, env);
    } finally {
      await stop_original_host(host);
    }
    throw new PySystemExit(status);
  }
  const macos = platform === 'darwin';
  if (macos) {
    const client = _configure_macos_lifecycle(root, runtime, env);
    if (client !== null) {
      const { start_original_host, stop_original_host } = await internals.load('./macos_host.mjs');
      const { MAC_SOCKET_ENV, mac_socket_path } = internals.platforms();
      const [socket_path] = mac_socket_path(env);
      // Any override, even an empty one, means the client may not use the default socket.
      const overridden = Object.hasOwn(env, MAC_SOCKET_ENV);
      // Always decided here, never inherited: only the default location is known, and the
      // original client builds its socket path from $HOME (Node's os.homedir), so an
      // account whose HOME is elsewhere is talking to a different socket.
      const account_home = getpwuid(process.getuid()).pw_dir;
      // An unset HOME makes Node fall back to the account home; an empty one gives ''.
      const client_home = Object.hasOwn(env, 'HOME') ? env.HOME : account_home;
      if (overridden || !client_home || realpath(client_home) !== realpath(account_home)) {
        delete env.LCU_MAC_SERVICE_LOCK;
      } else {
        env.LCU_MAC_SERVICE_LOCK = `${socket_path}.lock`;
      }
      const [host, temporary, address] = await start_original_host({
        // LCU's own Node starts quarantined through entry.mjs (`macos-host`), like the launcher itself; the
        // caller's startup variables reach the original client as data (review port-runtime #2).
        node: process.execPath, client, entry: join(root, 'lcu/entry.mjs'), env: quarantine_environment(env),
        control_address: env.LCU_MAC_CONTROL_SOCKET ?? null });
      env.LCU_MAC_LIFETIME_SOCKET = address;
      let status;
      try {
        status = await internals.supervise(command, env);
      } finally {
        await stop_original_host(host, temporary);
      }
      throw new PySystemExit(status);
    }
  }
  if (platform === 'linux') {
    _leave_unusable_working_directory();
  }
  const target = join(runtime, 'bin/node');
  // compat/execve re-ignores the signals the caller left ignored (startup_vars.mjs), as os.execve keeps them.
  internals.execve(target, command, env);
  return undefined;
}
