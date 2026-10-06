#!/usr/bin/env node
// Install a versioned LCU runtime and optionally register agents (Linux).
// Port of scripts/install.py. Run it through scripts/install.sh (which finds and gates the selected app's Node);
// scripts/install_macos.mjs imports checked_prefix and select_release from here, as install_macos.py did.
import './startup_env.mjs';
import {
  accessSync, chmodSync, closeSync, constants as fsConstants, copyFileSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isatty } from 'node:tty';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { io, PySystemExit, pyStr as argparseStr, types } from '../lcu/compat/argparse.mjs';
import { acquireSync, APPEND_LOCK_FILE } from '../lcu/compat/lock.mjs';
import { asUri, pathExpanduser, pathStr, resolve as pathResolve } from '../lcu/compat/pathlib.mjs';
import { dumps, loads, ValueError } from '../lcu/compat/pyjson.mjs';
import { pyStr } from '../lcu/compat/pyerr.mjs';
import { isValueError } from '../lcu/compat/errors.mjs';
import { isOSError, SubprocessError } from '../lcu/compat/subprocess.mjs';
import { runProcess } from '../lcu/compat/runas.mjs';
import * as setupModule from '../lcu/setup.mjs';
import { report as reportTestedPair } from '../lcu/tested.mjs';
import { architecture, VERSION, verify } from './bundle_runtime.mjs';
import { DEFAULT_APP_PATH, select as select_app } from './installed_app.mjs';

export const SOURCE = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
export const PROG = 'install.py';
export const DOC = 'Install a versioned LCU runtime and optionally register agents.';
export { VERSION };

// Ubuntu 24.04 names for the pinned official application's Depends, plus LCU's
// X11/audio/session prerequisites. See docs/INSTALLATION.md for source mappings.
// `acl` provides getfacl, which the Node port uses to read POSIX ACLs (BRIEF addendum E).
export const SYSTEM_PACKAGES = [
  'acl', 'at-spi2-core', 'bubblewrap', 'ca-certificates', 'dbus-x11', 'ffmpeg',
  'libasound2t64', 'libatk-bridge2.0-0t64', 'libatk1.0-0t64', 'libatspi2.0-0t64',
  'libc6', 'libcairo2', 'libcups2t64', 'libdbus-1-3', 'libdrm2', 'libexpat1',
  'libgbm1', 'libgcc-s1', 'libgdk-pixbuf-2.0-0', 'libgl1', 'libglib2.0-bin',
  'libglib2.0-0t64', 'libgtk-3-0t64', 'libnotify4', 'libnspr4', 'libnss3',
  'libpango-1.0-0', 'libssl3t64', 'libstdc++6', 'libtss2-esys-3.0.2-0t64',
  'libtss2-mu-4.0.1-0t64', 'libtss2-tcti-device0t64', 'libudev1', 'libusb-1.0-0',
  'libx11-6', 'libx11-xcb1', 'libxcb-dri3-0', 'libxcb1', 'libxcomposite1',
  'libxdamage1', 'libxext6', 'libxfixes3', 'libxi6', 'libxkbcommon0', 'libxrandr2',
  'libxres1', 'libxtst6', 'mesa-vulkan-drivers', 'pulseaudio', 'pulseaudio-utils', 'python3',
  'x11-utils', 'xdg-utils', 'xz-utils',
];

/** sys.exit(code) / raise SystemExit(code) */
export class SystemExit extends Error {
  constructor(code) {
    super(String(code));
    this.name = 'SystemExit';
    this.code = code;
  }
}

/** shutil.which(name) on PATH (os.defpath when PATH is unset). */
function which(name) {
  const search = process.env.PATH ?? '/bin:/usr/bin';
  for (const directory of search.split(':')) {
    const candidate = join(directory === '' ? '.' : directory, name);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      }
    } catch { /* keep looking */ }
  }
  return null;
}

/** Injection points for tests (Python's mock.patch targets in tests/test_installation.py). */
export const internals = {
  SOURCE,
  default_app_path: () => DEFAULT_APP_PATH,
  architecture,
  verify,
  select_app,
  validate_release: (release, account = null) => validate_release(release, account),
  checked_prefix: (path) => checked_prefix(path),
  install: (prefix, options) => install(prefix, options),
  setup: { ...setupModule },
  run: runProcess,
  getuid: () => process.getuid(),
  which,
  isatty: (fd) => isatty(fd),
  report: reportTestedPair,
};

const out = (text) => io.stdout(text);
const err = (text) => io.stderr(text);
const print = (text) => out(`${text}\n`);

const isDir = (path) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};
const isFile = (path) => {
  try { return statSync(path).isFile(); } catch { return false; }
};
const isSymlink = (path) => {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
};
const lexists = (path) => {
  try { lstatSync(path); return true; } catch { return false; }
};
const isRelativeTo = (path, root) => path === root || path.startsWith(root === '/' ? '/' : `${root}/`);

export function checked_prefix(path) {
  path = String(path);
  if (!path.startsWith('/')) {
    throw new ValueError('The installation prefix must be absolute');
  }
  path = String(internals.setup.regular_path(path));
  if (isRelativeTo(pathResolve(path), pathResolve(internals.SOURCE))) {
    throw new ValueError('Choose an installation prefix outside the extracted release bundle.');
  }
  const parts = path === '/' ? 1 : path.split('/').length;
  if (!path.startsWith('/') || parts < 3 || path === '/usr/local' || path === '/opt') {
    throw new ValueError('Choose a dedicated absolute prefix, such as /opt/lcu.');
  }
  if (existsSyncFollow(path) && readdirSync(path).length > 0 && !isFile(join(path, '.lcu-install'))) {
    throw new ValueError('Installation prefix is not an existing LCU installation or an empty directory.');
  }
  for (const name of ['.lcu-install', 'releases']) {
    if (isSymlink(join(path, name))) {
      throw new ValueError(`Refusing a symlink at ${join(path, name)}`);
    }
  }
  return path;
}

// Path.exists(): follows symlinks, False for any OSError.
function existsSyncFollow(path) {
  try { statSync(path); return true; } catch { return false; }
}

const ACCOUNT_USER = (account) => ({
  HOME: account.pw_dir, USER: account.pw_name, LOGNAME: account.pw_name,
});

export function validate_release(release, account = null) {
  const options = {};
  const env = { ...process.env };
  if (account !== null && account !== undefined) {
    Object.assign(env, ACCOUNT_USER(account));
    options.cwd = account.pw_dir;
    if (internals.getuid() === 0 && account.pw_uid !== 0) {
      options.account = account;
    } else if (internals.getuid() !== account.pw_uid) {
      throw new ValueError(`Cannot validate the installation as ${account.pw_name} from this account`);
    }
  }
  internals.run([`${release}/bin/lcu`, '--version'], { check: true, timeout: 20000, env, ...options });
  const runtime = `${internals.setup.installed_app_resources(release)}/cua_node`;
  internals.run([`${runtime}/bin/node_repl`, '--help'], { check: true, timeout: 20000, stdout: 'devnull', env, ...options });
  env.NODE_REPL_DISABLE_ANALYTICS = '1';
  const descriptor = loads(readFileSync(`${release}/installation.json`, 'utf8'));
  const target = descriptor.has('platform') ? descriptor.get('platform') : 'linux';
  internals.run([`${runtime}/bin/node`, '--input-type=module', '-e',
    'const s = await import(process.argv[1]); const r = await s.handleRpc({type:"setup"}); if(r.target!==process.argv[2]) throw Error("Wrong platform");',
    asUri(`${runtime}/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js`),
    target === 'darwin' ? 'mac' : 'linux'], { env, check: true, timeout: 20000, ...options });
}

export function install(prefix, { app_package = null, existing_app = null, offline = false, account = null } = {}) {
  prefix = internals.checked_prefix(prefix);
  if (app_package !== null) {
    throw new ValueError(`--app-package cannot install an app for you. ${internals.setup.app_prerequisite_message(null, { alternate_location: true })}`);
  }
  const arch = internals.architecture();
  internals.verify(internals.SOURCE, arch);
  const [application, descriptor] = internals.select_app(arch, { existing_app, account });
  mkdirSync(prefix, { recursive: true });
  closeSync(openSync(join(prefix, '.lcu-install'), 'a')); // Path.touch(exist_ok=True)
  touch(join(prefix, '.lcu-install'));
  return select_release(prefix, arch, application, descriptor, { account });
}

// Path.touch(exist_ok=True): create if missing, otherwise set atime/mtime to now.
function touch(path) {
  const now = new Date();
  utimesSync(path, now, now);
}

// shutil.copytree(source, release, dirs_exist_ok=True, symlinks=True): copy2 for files (content, mode, times),
// symlinks verbatim, directory times and mode copied after the contents (copystat).
function copystat(source, destination, info) {
  utimesSync(destination, Number(info.atimeNs) / 1e9, Number(info.mtimeNs) / 1e9);
  chmodSync(destination, Number(info.mode) & 0o7777);
}

export function copytree(source, destination) {
  const info = lstatSync(source, { bigint: true });
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    const from = join(source, entry);
    const to = join(destination, entry);
    const item = lstatSync(from, { bigint: true });
    if (item.isSymbolicLink()) {
      symlinkSync(readlinkSync(from), to);
    } else if (item.isDirectory()) {
      copytree(from, to);
    } else {
      copyFileSync(from, to);
      copystat(from, to, item);
    }
  }
  copystat(source, destination, info);
}

/** Publish one validated thin release; installed application files stay put. */
export function select_release(prefix, arch, application, descriptor, { account = null, target = 'linux', source = null } = {}) {
  source = source !== null && source !== undefined ? String(source) : internals.SOURCE;
  const lock = acquireSync(join(prefix, '.lcu-install'), { file: APPEND_LOCK_FILE });
  let release;
  try {
    const releases = join(prefix, 'releases');
    mkdirSync(releases, { recursive: true });
    const name = `${VERSION}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    release = join(releases, name);
    mkdirSync(release, { mode: 0o755 });
    try {
      copytree(source, release);
      internals.verify(release, arch, target);
      // The release links to the installed app; no app files are copied.
      symlinkSync(String(application), join(release, 'app'));
      writeFileSync(join(release, 'installation.json'),
        `${dumps({ ...descriptor, app: String(application) }, { indent: 2 })}\n`);
      internals.validate_release(release, account);
      const current = join(prefix, 'current');
      if (existsSyncFollow(current) && !isSymlink(current)) {
        throw new ValueError('Refusing to replace a non-symlink current path');
      }
      const temporary_link = join(prefix, '.next');
      if (existsSyncFollow(temporary_link) || isSymlink(temporary_link)) {
        throw new ValueError('Unexpected .next path; inspect the installation before retrying');
      }
      symlinkSync(`releases/${name}`, temporary_link);
      renameSync(temporary_link, current);
    } catch (error) {
      rmSync(release, { recursive: true });
      throw error;
    }
  } finally {
    lock.release();
  }
  return release;
}

/** The installer parser: lcu.setup.parser() plus the Linux installer options (scripts/install.py main()). */
export function build_parser() {
  const parser = internals.setup.parser();
  parser.prog = PROG;
  parser.description = `${DOC} Requires Linux, X11 and D-Bus; apt system provisioning requires root.`;
  parser.add_argument('--runtime-only', { action: 'store_true', help: 'Install without registering an agent' });
  parser.add_argument('--skip-system', { action: 'store_true', help: 'Skip apt; system libraries must already exist' });
  parser.add_argument('--app-package', { type: types.Path, help: 'Removed: install the app yourself; this option now fails' });
  parser.add_argument('--existing-app', { type: types.Path, help: 'Use an already installed app outside the default /usr/lib/chatgpt location' });
  parser.add_argument('--offline', { action: 'store_true', help: 'Never use the network; requires --skip-system and preinstalled system libraries' });
  return parser;
}

// Python truthiness of an argparse value.
const truthy = (value) => value !== null && value !== undefined && value !== false && value !== '' &&
  !(Array.isArray(value) && value.length === 0);

/** Forward the agent-setup options to `lcu setup` (shared shape of install.py and install_macos.py). */
export function forwarded_setup_arguments(args, prefix, account, { session }) {
  const forwarded = ['--prefix', String(prefix), '--user', account.pw_name, '--scope', args.get('scope'), '--session', session];
  for (const name of args.get('agent')) forwarded.push('--agent', name);
  for (const flag of ['project', 'export']) {
    if (args.get(flag) !== null) forwarded.push(`--${flag}`, argparseStr(args.get(flag)));
  }
  for (const flag of ['yes', 'check_desktop', 'chrome', 'audio', 'no_chrome', 'no_audio', 'allow_missing']) {
    if (args.get(flag)) forwarded.push(`--${flag.replaceAll('_', '-')}`);
  }
  if (args.get('approval')) forwarded.push('--approval', args.get('approval'));
  return forwarded;
}

export async function main(argv = null) {
  argv = [...(argv ?? process.argv.slice(2))];
  const legacy = argv.length > 0 && !argv[0].startsWith('-');
  if (legacy) {
    argv = ['--prefix', argv[0], ...argv.slice(1)];
  }
  const setup = internals.setup;
  const parser = build_parser();
  const args = parser.parse_args(argv);
  if (args.get('list_agents')) {
    await setup.main(['--list-agents']);
    return;
  }
  if (args.get('app_package') !== null) {
    throw new ValueError(`--app-package cannot install an app for you. ${setup.app_prerequisite_message(null, { alternate_location: true })}`);
  }
  if (args.get('offline') && !args.get('skip_system')) {
    throw new ValueError('--offline requires --skip-system; provision system libraries before an offline install');
  }
  const arch = internals.architecture();
  let runtime_only = args.get('runtime_only');
  if (legacy && !truthy(args.get('agent')) && args.get('export') === null) {
    runtime_only = true;
  }
  const existing_app = args.get('existing_app') !== null
    ? pathExpanduser(String(args.get('existing_app'))) : internals.default_app_path();
  if (!isDir(existing_app)) {
    throw new ValueError(setup.app_prerequisite_message(existing_app, { alternate_location: true }));
  }
  if (args.get('reconcile')) {
    throw new ValueError('--reconcile runs after installation: use `lcu setup --reconcile` from the installed release.');
  }
  const [account, names] = setup.validate(args);
  const prefix = internals.checked_prefix(args.get('prefix'));
  if (runtime_only) {
    if (truthy(args.get('agent')) || args.get('export') !== null || args.get('project') !== null
        || args.get('scope') !== 'user' || args.get('check_desktop') || args.get('session') !== 'discover'
        || args.get('browser_host') || args.get('chrome') || args.get('audio') || args.get('no_chrome')
        || args.get('no_audio') || args.get('approval') || args.get('allow_missing')) {
      throw new ValueError('--runtime-only cannot include agent setup options');
    }
  } else if (!truthy(names) && args.get('export') === null && (args.get('yes') || !internals.isatty(0))) {
    throw new ValueError('Select --agent NAME, --agent all, --agent auto, --export PATH, or --runtime-only');
  }
  if (!runtime_only) {
    setup.installer_environment(account.pw_dir, names,
      internals.getuid() === 0 && account.pw_uid ? {} : process.env);
  }
  // Refuse absent, corrupt, or wrong-architecture payloads before apt or any writes.
  internals.verify(internals.SOURCE, arch);
  internals.select_app(arch, { existing_app: args.get('existing_app'), account, execute: false });
  if (!args.get('skip_system')) {
    if (internals.getuid() !== 0 || !internals.which('apt-get')) {
      throw new ValueError('Automatic system provisioning requires root and apt-get; otherwise provision dependencies and use --skip-system');
    }
    internals.run(['apt-get', 'update'], { check: true });
    internals.run(['apt-get', 'install', '-y', ...SYSTEM_PACKAGES], { check: true });
  }
  internals.install(prefix, { app_package: null, existing_app: args.get('existing_app'), offline: args.get('offline'), account });
  print(`LCU installed: ${prefix}/current/bin/lcu`);
  if (runtime_only) {
    // Agent setup reports this itself, before applying anything.
    internals.report(`${prefix}/current`);
  }
  if (!runtime_only) {
    const forwarded = forwarded_setup_arguments(args, prefix, account, { session: args.get('session') });
    // Run setup from the selected release, and drop privileges before account writes.
    const runtime = `${prefix}/current/bin/lcu`;
    const result = internals.run([runtime, 'setup', ...forwarded], { check: false });
    if (result.returncode) {
      err(`LCU runtime installed at ${runtime}, but setup failed; see the errors above. `
        + `After resolving the errors, retry: ${runtime} setup ${forwarded.join(' ')}\n`);
      throw new SystemExit(result.returncode);
    }
  }
}

/** True for what scripts/install.py's __main__ catches: (ValueError, OSError, subprocess.SubprocessError). */
export function is_installer_error(error) {
  return isValueError(error)
    || error instanceof SubprocessError || isOSError(error) || internals.setup.isExpectedError(error);
}

/** The `if __name__ == '__main__'` block. Resolves to the process exit status. */
export async function run_main(argv = null, { prefix = 'LCU installer', entry = main } = {}) {
  try {
    await entry(argv);
    return 0;
  } catch (error) {
    if (error instanceof SystemExit) return typeof error.code === 'number' ? error.code : 1;
    if (error instanceof PySystemExit) return error.status;
    if (is_installer_error(error)) {
      err(`${prefix}: ${pyStr(error)}\n`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run_main();
}
