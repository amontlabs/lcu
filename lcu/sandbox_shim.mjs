// Stand between the original node_repl and `codex sandbox` on Linux.
//
// On a machine where bubblewrap works, the original node_repl starts its JavaScript kernel (the code
// the model writes in `js` calls) and its trusted worker (which hosts the Sky desktop service) with
// `$CODEX_CLI_PATH sandbox ... -- COMMAND`. The sandbox's network-off seccomp filter also refuses
// connect(2) to the X11 socket, so Sky cannot work inside it. LCU sets CODEX_CLI_PATH to this shim:
//
// * the kernel is handed to the real `codex sandbox` exactly as node_repl asked;
// * the trusted worker is run directly, outside the sandbox, only when it is positively identified
//   as the selected runtime's worker hosting the selected runtime's Sky service; any other worker is
//   handed to the real sandbox as asked;
// * a `sandbox` invocation in any format this module does not recognise is refused with an error, so
//   nothing the shim cannot classify ever starts, let alone starts unsandboxed;
// * every other `codex` subcommand is passed through unchanged.
//
// The shim never runs a command outside the sandbox unless it was identified as the worker.
import { lstatSync, readlinkSync, statSync, writeSync } from 'node:fs';
import { posix as path } from 'node:path';

import { execve } from './compat/execve.mjs';
import { pathStr, realpath } from './compat/pathlib.mjs';
import { dumps, loads, ValueError } from './compat/pyjson.mjs';
import { loads as toml_loads, TOMLDecodeError } from './compat/toml.mjs';

export const CONFIG_ENV = 'LCU_SANDBOX_SHIM';
// Test-only: `unrecognized-kernel`, `unrecognized-worker` or `unrecognized-format` make the shim see
// that invocation in a format it does not recognise. LCU never sets it; it can only make the shim refuse.
export const FAULT_ENV = 'LCU_TEST_SANDBOX_SHIM_FAULT';

export const SANDBOX_PREFIX = ['sandbox', '-c', 'shell_environment_policy.inherit="all"',
  '-c', 'default_permissions="node_repl"'];
export const PROFILE_KEY = 'permissions.node_repl=';
export const SKY_SERVICE = '@oai/sky/service';
export const BROWSER_SERVICE = '@oai/browser-desktop/service';
export const SERVICE_PACKAGES = new Map([[SKY_SERVICE, '@oai/sky'], [BROWSER_SERVICE, '@oai/browser-desktop']]);
export const NODE_FLAG = '--experimental-vm-modules';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

/** Injection points for tests (Python's patch.object(os, 'getegid')). */
export const internals = {
  getegid: () => process.getegid(),
  geteuid: () => process.geteuid(),
};

class KeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeyError';
  }
}

/** A `sandbox` invocation whose format this shim does not know. */
export class Unrecognized extends ValueError {
  constructor(message) {
    super(message);
    this.name = 'Unrecognized';
  }
}

/** The value LCU puts in CONFIG_ENV for the shim. */
export function configuration(runtime, codex, wrapper) {
  return dumps(new Map([['codex', String(codex)], ['runtime', String(runtime)],
    ['wrapper', wrapper ? String(wrapper) : null]]));
}

/** A copy of `env` whose CODEX_CLI_PATH is the real Codex executable again. */
export function unshimmed_env(env) {
  const restored = { ...env };
  try {
    const config = loads(env[CONFIG_ENV]);
    if (config instanceof Map && config.has('codex') && typeof config.get('codex') === 'string') {
      restored.CODEX_CLI_PATH = config.get('codex');
    }
  } catch {
    // (KeyError, ValueError, TypeError): keep CODEX_CLI_PATH as it is
  }
  return restored;
}

export function load_configuration(env) {
  let config;
  try {
    const raw = env[CONFIG_ENV];
    if (raw === undefined) throw new ValueError('missing');
    config = loads(raw);
  } catch (exc) {
    if (exc instanceof ValueError) throw new Unrecognized('the shim has no LCU configuration');
    throw exc;
  }
  if (!(config instanceof Map) || typeof config.get('codex') !== 'string' ||
      typeof config.get('runtime') !== 'string' ||
      !(!config.has('wrapper') || config.get('wrapper') === null || typeof config.get('wrapper') === 'string')) {
    throw new Unrecognized('the shim configuration is malformed');
  }
  return Object.fromEntries(config);
}

function _real(file) {
  return realpath(file);
}

function _within(file, root) {
  return file === root || file.startsWith(root.replace(/\/+$/, '') + '/');
}

/**
 * node_repl first runs a short `/bin/sh` command in the sandbox to learn whether it works.
 *
 * A refused probe would read as "no sandbox here" and leave the kernel unsandboxed, so any `/bin/sh`
 * command passes through to the real sandbox untouched, whatever its other arguments.
 */
export function is_availability_probe(argv) {
  const at = argv.indexOf('--');
  return at >= 0 && argv[at + 1] === '/bin/sh';
}

/** Return [permission profile, command] for exactly the invocation node_repl makes. */
export function parse_sandbox(argv) {
  const head = SANDBOX_PREFIX.length;
  if (argv.slice(0, head).length !== head || SANDBOX_PREFIX.some((part, index) => argv[index] !== part) ||
      argv.length < head + 4 || argv[head] !== '-c' ||
      !argv[head + 1].startsWith(PROFILE_KEY) || argv[head + 2] !== '--') {
    throw new Unrecognized('unexpected sandbox arguments');
  }
  let profile;
  try {
    const document = toml_loads('profile = ' + argv[head + 1].slice(PROFILE_KEY.length));
    if (!document.has('profile')) throw new KeyError('profile');
    profile = document.get('profile');
  } catch (exc) {
    // (tomllib.TOMLDecodeError, KeyError)
    if (exc instanceof TOMLDecodeError || exc instanceof KeyError) throw new Unrecognized('unreadable permission profile');
    throw exc;
  }
  if (!(profile instanceof Map) || [...profile.keys()].some((key) => key !== 'filesystem' && key !== 'network') ||
      !(profile.get('filesystem') instanceof Map) || !(profile.get('network') instanceof Map) ||
      [...profile.get('filesystem')].some(([key, value]) => typeof key !== 'string' || typeof value !== 'string')) {
    throw new Unrecognized('unexpected permission profile shape');
  }
  return [profile, argv.slice(head + 3)];
}

/** `kernel` or `worker`; raise Unrecognized for any other command. */
export function classify(command, config) {
  const runtime_node = config.runtime + '/bin/node';
  if (command.length < 3 || command[1] !== NODE_FLAG || !path.isAbsolute(command[2]) ||
      _real(command[0]) !== _real(runtime_node)) {
    throw new Unrecognized('unexpected command');
  }
  const script = path.basename(pathStr(command[2]));
  if (script === 'kernel.js' && command.length === 7 && command[3] === '--session-id' &&
      command[5] === '--working-dir') {
    return 'kernel';
  }
  if (script === 'trusted-worker.js' && command.length === 4 && path.isAbsolute(command[3])) {
    return 'worker';
  }
  throw new Unrecognized('unexpected script or arguments');
}

/** Not writable by others, nor by a group other than the account's own (umask 002 is common). */
function _private(info) {
  return !(info.mode & 0o002) && (!(info.mode & 0o020) || info.gid === internals.getegid());
}

function _service_package(runtime, specifier) {
  const package_name = SERVICE_PACKAGES.get(specifier);
  if (package_name === undefined) return false;
  const file = _real(`${runtime}/lib/node_modules/${package_name}/package.json`);
  return is_file(file) && _within(file, _real(runtime));
}

// os.path.isfile: False for any OSError (and an invalid path).
const is_file = (file) => {
  try {
    return (statSync(file).mode & S_IFMT) === S_IFREG;
  } catch {
    return false;
  }
};

// Path.is_file (Python 3.12 pathlib): False only for ENOENT/ENOTDIR/EBADF/ELOOP; EACCES and others propagate.
const path_is_file = (file) => {
  try {
    return (statSync(file).mode & S_IFMT) === S_IFREG;
  } catch (exc) {
    if (['ENOENT', 'ENOTDIR', 'EBADF', 'ELOOP'].includes(exc?.code)) return false;
    throw exc;
  }
};

// print(..., file=sys.stderr) before an exec: written synchronously and completely (a full pipe is waited
// for, not dropped), so nothing is lost when the process image is replaced right after.
function writeStderr(text) {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(2, buffer, offset);
    } catch (error) {
      if (error.code === 'EAGAIN') continue;
      if (error.code === 'EPIPE') return;
      throw error;
    }
  }
}

/**
 * null when `command` is the selected runtime's trusted worker hosting its Sky service.
 *
 * Otherwise the reason it is not; the worker then stays in the sandbox.
 */
export function identify_sky_worker(command, config, env, parent_exe) {
  const runtime = config.runtime;
  const node_repl = _real(runtime + '/bin/node_repl');
  if (parent_exe !== node_repl || !_within(node_repl, _real(runtime))) {
    return "it was not started by the selected runtime's node_repl";
  }
  const node = _real(command[0]);
  if (node !== _real(runtime + '/bin/node') || !_within(node, _real(runtime))) {
    return "its Node is not the selected runtime's";
  }
  const script = pathStr(command[2]);
  const folder = path.dirname(script);
  let folder_info;
  let script_info;
  let sibling;
  try {
    folder_info = lstatSync(folder);
    script_info = lstatSync(script);
    sibling = path_is_file(pathStr(folder, 'kernel.js'));
  } catch {
    return 'its script is not readable';
  }
  if ((folder_info.mode & S_IFMT) !== S_IFDIR || (script_info.mode & S_IFMT) !== S_IFREG ||
      folder_info.uid !== internals.geteuid() || script_info.uid !== internals.geteuid() ||
      !(_private(folder_info) && _private(script_info)) || !sibling ||
      !path.basename(folder).startsWith('.tmp') ||
      path.dirname(folder) !== _real(env.TMPDIR || '/tmp')) {
    return "its script is not in node_repl's own temporary folder";
  }
  const raw = env.NODE_REPL_TRUSTED_SERVICES;
  let services;
  try {
    services = raw !== undefined ? loads(raw) : null;
  } catch (exc) {
    if (!(exc instanceof ValueError)) throw exc;
    services = null;
  }
  if (!(services instanceof Map) || [...services.keys()].some((key) => key !== 'sky' && key !== 'browser') ||
      [...services.values()].some((value) => typeof value !== 'string')) {
    return "the trusted services are not exactly the selected runtime's";
  }
  const sky = services.has('sky') ? services.get('sky') : null;
  const wrapper = config.wrapper ?? null;
  if (sky === null) return 'it hosts no Sky service';
  if (!(sky === SKY_SERVICE ? _service_package(runtime, sky) :
    Boolean(wrapper) && sky === wrapper && path.isAbsolute(wrapper) && _real(wrapper) === wrapper &&
      is_file(wrapper))) {
    return "its Sky service is not the selected runtime's";
  }
  if (services.has('browser') && !_service_package(runtime, services.get('browser'))) {
    return "its browser service is not the selected runtime's";
  }
  return null;
}

/**
 * Return [action, argv, note]: `real` execs the real Codex, `direct` execs the command itself.
 *
 * Raises Unrecognized to refuse.
 */
export function decide(argv, env, parent_exe) {
  const config = load_configuration(env);
  if (argv[0] !== 'sandbox' || is_availability_probe(argv)) {
    return ['real', argv, ''];
  }
  const [, command] = parse_sandbox(argv);
  const kind = classify(command, config);
  const fault = env[FAULT_ENV] ?? '';
  if (fault === 'unrecognized-format' || fault === 'unrecognized-' + kind) {
    parse_sandbox(argv.filter((part) => part !== '--'));
  }
  if (kind === 'worker') {
    const reason = identify_sky_worker(command, config, env, parent_exe);
    if (reason === null) return ['direct', command, ''];
    return ['real', argv, `the trusted worker stays sandboxed: ${reason}`];
  }
  return ['real', argv, ''];
}

function _parent_exe() {
  try {
    return realpath(readlinkSync(`/proc/${process.ppid}/exe`));
  } catch {
    return null;
  }
}

export function main(argv, env = process.env, { execv = (file, args) => execve(file, args, process.env),
  parent_exe = _parent_exe, stderr = writeStderr } = {}) {
  let action;
  let target;
  let note;
  try {
    [action, target, note] = decide(argv, env, parent_exe());
  } catch (exc) {
    if (!(exc instanceof Unrecognized)) throw exc;
    stderr('LCU: the original node_repl started its sandbox in a way this LCU release does not ' +
      `recognise (${exc.message}). Refusing to start it, so the model's JavaScript is never left ` +
      'unsandboxed. Run `lcu update` for a release that knows this runtime; ' +
      'LCU_NODE_REPL_SANDBOX=off runs the JavaScript kernel without a sandbox.\n');
    return 70;
  }
  if (note) stderr(`LCU: ${note}.\n`);
  if (action === 'direct') {
    execv(target[0], target);
  } else {
    const codex = load_configuration(env).codex;
    execv(codex, [codex, ...target]);
  }
  return 0;
}
