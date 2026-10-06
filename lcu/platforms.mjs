// Validate an installed official application for the original CUA runtime.
//
// Port of lcu/platforms.py. Platform primitives that Python reaches directly are reached through the
// compat helpers: plistlib -> compat/plist.mjs, pwd/grp -> compat/accounts.mjs, the
// system.posix_acl_access xattr -> compat/acl.mjs (trusted getfacl / python3 reader, batched per tree), subprocess ->
// compat/subprocess.mjs. `internals` holds the injection points the Python tests reach with
// unittest.mock.patch (host_platform.system, subprocess.run, os.getuid/geteuid, _group_members,
// _posix_acl); production code never replaces them.
import {
  accessSync, constants, lstatSync, opendirSync, readFileSync, statSync,
} from 'node:fs';
import { arch as hostArch, platform as hostOs } from 'node:os';
import { posix as path } from 'node:path';

import { getpwuid, groupMembers as accountGroupMembers } from './compat/accounts.mjs';
import { AclReaderUnavailableError, aclWritersUntrusted, posixAcl, posixAclPaths, posixAclTree } from './compat/acl.mjs';
import { pyStrip, pySplitlines } from './compat/argparse.mjs';
import { fromNodeError } from './compat/pyerr.mjs';
import { loads, ValueError } from './compat/pyjson.mjs';
import { decode } from './compat/utf8.mjs';
import { pathExpanduser, pathStr, resolve } from './compat/pathlib.mjs';
import { loads as plist_loads } from './compat/plist.mjs';
import { isOSError, run, SubprocessError } from './compat/subprocess.mjs';
import { locate_codex_tools } from './app_layout.mjs';
import { read_asar_members } from './asar.mjs';
import { attribute_error_get, PyAttributeError } from './compat/pystr.mjs';

export { ValueError };

export const MAC_BUNDLE_ID = 'com.openai.codex';
export const MAC_HELPER_ID = 'com.openai.sky.CUAService';
export const OPENAI_TEAM_ID = '2DC432GLL2';
export const MAC_HELPER = 'Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app';
export const MAC_REQUIRED_FILES = [
  'Resources/cua_node/bin/node',
  'Resources/cua_node/bin/node_repl',
  'Resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs',
  'Resources/plugins/openai-bundled/plugins/unified-computer-use/.mcp.json',
  'Resources/plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json',
];
export const MAC_EXECUTABLES = [
  'Resources/cua_node/bin/node',
  'Resources/cua_node/bin/node_repl',
];

// The signed helper binds its socket here (or at the path in this variable) and
// refuses a path longer than the AF_UNIX sun_path limit. LCU cannot change that
// in the helper; it can only detect it.
export const MAC_SOCKET_ENV = 'SKY_CUA_SERVICE_NATIVE_PIPE_PATH';
export const MAC_SOCKET_SUFFIX = `Library/Group Containers/${OPENAI_TEAM_ID}.${MAC_HELPER_ID}/IPC/computeruse.sock`;
export const MAC_SOCKET_MAX_BYTES = 103;

/**
 * [path, overridden]: the socket path LCU checks for the signed Mac helper, and whether the env override set it.
 *
 * SKY_CUA_SERVICE_NATIVE_PIPE_PATH in the given environment wins when set (the helper's own
 * environment is not visible to LCU); otherwise the path is
 * under the account's real home folder, not $HOME.
 */
export function mac_socket_path(environ = null) {
  const override = (environ === null ? process.env : environ)[MAC_SOCKET_ENV];
  if (override) {
    return [override, true];
  }
  // os.path.join(pwd.getpwuid(os.getuid()).pw_dir, MAC_SOCKET_SUFFIX): no normalisation
  const home = internals.getpwuid(internals.getuid()).pw_dir;
  return [home === '' || home.endsWith('/') ? home + MAC_SOCKET_SUFFIX : `${home}/${MAC_SOCKET_SUFFIX}`, false];
}

/** A message when the helper's socket path is too long to bind, else null. */
export function mac_socket_path_problem(environ = null) {
  const [socket, overridden] = mac_socket_path(environ);
  const size = Buffer.byteLength(socket, 'utf8'); // len(os.fsencode(path))
  if (size <= MAC_SOCKET_MAX_BYTES) {
    return null;
  }
  const source = overridden ? `The path comes from ${MAC_SOCKET_ENV}.`
    : 'The path comes from your home folder, so the ChatGPT app is affected too.';
  return ("Computer Use cannot start for this macOS account: the ChatGPT helper's socket path is " +
          `${size} bytes (macOS limit ${MAC_SOCKET_MAX_BYTES}): ${socket}. ${source} ` +
          'LCU cannot change the signed helper. Use an account whose home folder path is short enough ' +
          '(13 ASCII characters or fewer after /Users/).');
}

const S_IFMT = constants.S_IFMT;
const S_IFLNK = constants.S_IFLNK;
const S_IFDIR = constants.S_IFDIR;
const S_IFREG = constants.S_IFREG;
const S_ISVTX = 0o1000;
const S_IWOTH = 0o002;
const S_IWGRP = 0o020;

const isLnk = (mode) => (mode & S_IFMT) === S_IFLNK;
const isDirMode = (mode) => (mode & S_IFMT) === S_IFDIR;
const isRegMode = (mode) => (mode & S_IFMT) === S_IFREG;

// Path.is_symlink / is_file / is_dir / exists (Python 3.12 pathlib): False for the errors pathlib's
// _ignore_error() accepts (ENOENT, ENOTDIR, EBADF, ELOOP) and for an invalid path; any other OSError
// (EACCES, ...) propagates.
const IGNORED = new Set(['ENOENT', 'ENOTDIR', 'EBADF', 'ELOOP']);
function quietly(probe) {
  try {
    return probe();
  } catch (exc) {
    if (IGNORED.has(exc?.code) || exc?.code === 'ERR_INVALID_ARG_VALUE' || exc?.code === 'ERR_INVALID_ARG_TYPE') return false;
    throw fromNodeError(exc) ?? exc; // PermissionError: [Errno 13] Permission denied: '<path>'

  }
}
const is_symlink = (file) => quietly(() => isLnk(lstatSync(file).mode));
const is_file = (file) => quietly(() => isRegMode(statSync(file).mode));
const is_dir = (file) => quietly(() => isDirMode(statSync(file).mode));
const exists = (file) => quietly(() => Boolean(statSync(file)));
const access_x = (file) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const basename = (file) => path.basename(pathStr(file));
// Path.parents: nearest first, up to the root.
function parents(file) {
  const out = [];
  let current = file;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return out;
    out.push(parent);
    current = parent;
  }
}
const first = (text, limit) => Array.from(text).slice(0, limit).join('');
const join = (...parts) => pathStr(...parts);

// Python's `AttributeError: 'list' object has no attribute 'get'` for a JSON/plist document that is not a dict.
function mapObject(value) {
  if (!(value instanceof Map)) {
    throw attribute_error_get(value);
  }
  return value;
}
// Path.read_text(): UTF-8, strict.
function read_text(file) {
  return decode(readFileSync(file));
}

/** Injection points for tests (Python's mock.patch targets). */
export const internals = {
  system: () => ({ darwin: 'Darwin', linux: 'Linux', win32: 'Windows' }[hostOs()] ?? hostOs()),
  machine: () => ({ arm64: 'arm64', x64: 'x86_64' }[hostArch()] ?? hostArch()),
  run,
  getuid: () => process.getuid(),
  geteuid: () => process.geteuid(),
  getpwuid: (uid) => getpwuid(uid), // pwd.getpwuid
  group_members: null, // set below
  posix_acl: null,
  platform: () => process.platform,
  // slack for coarse filesystem timestamps when deciding whether an entry may have changed since a batch read
  change_slack_ms: 2000,
};

export class InstalledApplication {
  constructor(app, resources, runtime, backend, version, arch, codex_cli, code_mode_host, runtime_version) {
    Object.assign(this, { app, resources, runtime, backend, version, arch, codex_cli, code_mode_host, runtime_version });
    Object.freeze(this);
  }
}

export function _identity(bundle, identifier) {
  const info = join(bundle, 'Contents/Info.plist');
  if (!is_file(info) || is_symlink(info)) {
    throw new ValueError(`Application bundle metadata is missing: ${info}`);
  }
  const details = mapObject(plist_loads(readFileSync(info)));
  if (details.get('CFBundleIdentifier') !== identifier) {
    throw new ValueError(`Unexpected application bundle identifier: ${bundle}`);
  }
  return details;
}

export function _verify_signature(bundle, identifier) {
  // `codesign` verifies sealed resources and nested code in place. The
  // installed app and signed helper are never copied or modified by LCU.
  const verified = internals.run(['codesign', '--verify', '--deep', '--strict', String(bundle)],
    { capture: true, timeout: 120000 });
  if (verified.returncode) {
    const detail = first(pyStrip(verified.stderr || verified.stdout).replaceAll('\n', ' '), 300);
    throw new ValueError(`Installed application signature verification failed: ${bundle}: ${detail}`);
  }
  const identity = internals.run(['codesign', '-dv', '--verbose=2', String(bundle)],
    { capture: true, timeout: 30000 });
  const lines = pySplitlines(identity.stderr);
  if (identity.returncode ||
      !lines.includes(`Identifier=${identifier}`) ||
      !lines.includes(`TeamIdentifier=${OPENAI_TEAM_ID}`)) {
    throw new ValueError(`Installed application signer does not match OpenAI: ${bundle}`);
  }
}

/** Validate a local ChatGPT.app without relocating or modifying signed files. */
export function resolve_installed_mac_app(app_path, { arch = null } = {}) {
  if (internals.system() !== 'Darwin') {
    throw new ValueError('The macOS application can only be validated on macOS');
  }
  let app = pathExpanduser(app_path);
  if (is_symlink(app) || !is_dir(app) || basename(app) !== 'ChatGPT.app') {
    throw new ValueError(`Expected a local ChatGPT.app directory: ${app}`);
  }
  app = resolve(app, { strict: true });
  const architecture = arch || { arm64: 'arm64', aarch64: 'arm64', x86_64: 'x64' }[internals.machine()];
  if (architecture !== 'arm64' && architecture !== 'x64') {
    throw new ValueError(`Unsupported macOS architecture: ${architecture ?? 'None'}`);
  }
  const contents = join(app, 'Contents');
  const resources = join(contents, 'Resources');
  const runtime = join(resources, 'cua_node');
  const details = _identity(app, MAC_BUNDLE_ID);
  const version = details.get('CFBundleShortVersionString');
  if (typeof version !== 'string' || !pyStrip(version)) {
    throw new ValueError(`Installed application version is missing: ${app}`);
  }
  const helper = join(contents, MAC_HELPER);
  _identity(helper, MAC_HELPER_ID);
  const manifest_path = join(runtime, 'manifest.json');
  if (!is_file(manifest_path) || is_symlink(manifest_path)) {
    throw new ValueError('Installed application CUA manifest is missing');
  }
  const manifest = mapObject(loads(read_text(manifest_path)));
  const runtime_version = manifest.get('runtime_archive_version');
  if (manifest.get('platform') !== 'darwin' || manifest.get('arch') !== architecture ||
      typeof runtime_version !== 'string' || !pyStrip(runtime_version)) {
    throw new ValueError('Installed application CUA runtime has an incompatible platform or architecture');
  }
  for (const relative of MAC_REQUIRED_FILES) {
    const file = join(contents, relative);
    if (!is_file(file) || is_symlink(file)) {
      throw new ValueError(`Required application file is missing or invalid: ${relative}`);
    }
    if (MAC_EXECUTABLES.includes(relative) && !access_x(file)) {
      throw new ValueError(`Installed application executable is not executable: ${relative}`);
    }
  }
  const tools = locate_codex_tools(resources);
  for (const executable of [tools.cli, tools.code_mode_host]) {
    if (!access_x(executable)) {
      throw new ValueError(`Installed application executable is not executable: ${path.relative(contents, executable)}`);
    }
  }
  _verify_signature(app, MAC_BUNDLE_ID);
  _verify_signature(helper, MAC_HELPER_ID);
  return new InstalledApplication(app, resources, runtime, 'mac', version, architecture,
    tools.cli, tools.code_mode_host, runtime_version);
}

export const LINUX_APP_PATH = '/usr/lib/chatgpt';
const _VERSION = /^[A-Za-z0-9][A-Za-z0-9.+:~_-]*$/;

/** Read the selected app version, or confirm that dpkg owns its exact path. */
export function _linux_version(app, arch) {
  try {
    const members = read_asar_members(join(app, 'resources/app.asar'), ['package.json']);
    const raw = members instanceof Map ? members.get('package.json') : members['package.json'];
    if (raw === undefined) throw new KeyError('package.json');
    const pkg = mapObject(loads(raw));
    const version = pkg.get('version');
    if (typeof version === 'string' && _VERSION.test(version)) return version;
  } catch (exc) {
    if (exc instanceof PyAttributeError) throw exc;
    // (OSError, ValueError, KeyError, TypeError, JSONDecodeError): fall through to dpkg
  }
  const executable = join(app, 'ChatGPT');
  try {
    const ownership = internals.run(['dpkg-query', '-S', '--', String(executable)],
      { check: true, capture: true, timeout: 20000 });
    const owners = [];
    for (const line of pySplitlines(ownership.stdout)) {
      const at = line.indexOf(': ');
      if (at < 0) continue;
      const owner = line.slice(0, at);
      const file = line.slice(at + 2);
      if (pathStr(file) === executable && owner.split(':')[0] === 'chatgpt') owners.push(owner);
    }
    if (owners.length !== 1) {
      throw new ValueError('No unique chatgpt package owns the selected executable path');
    }
    const fields = internals.run(['dpkg-query', '-W', '--showformat=%v %a', owners[0]],
      { check: true, capture: true, timeout: 20000 }).stdout.split(/[\s\x1c-\x1f\x85]+/u).filter(Boolean);
    const expected_arch = arch === 'arm64' ? 'arm64' : 'amd64';
    if (fields.length !== 2 || fields[1] !== expected_arch) {
      throw new ValueError('The selected dpkg-owned ChatGPT path has the wrong architecture');
    }
    if (_VERSION.test(fields[0])) return fields[0];
  } catch (exc) {
    if (isOSError(exc) || exc instanceof SubprocessError) {
      throw new ValueError('Cannot determine the selected app version from app.asar or its dpkg-owned path');
    }
    throw exc;
  }
  throw new ValueError('Cannot determine the selected app version from app.asar or its dpkg-owned path');
}

class KeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeyError';
  }
}

export function _within(file, root) {
  return file === root || parents(file).includes(root);
}

/** Every account that holds `gid` as its primary or a supplementary group (null: unknown). */
export function _group_members(gid) {
  try {
    return accountGroupMembers(gid);
  } catch {
    return null; // account database unavailable: unknown, which callers treat as untrusted
  }
}

// The access ACL of one entry: the raw system.posix_acl_access xattr in Python (Linux only), here read by
// compat/acl.mjs (trusted getfacl, else the /usr/bin/python3 xattr reader) and rebuilt into the same blob.
// null when absent or not Linux. A missing/failed reader is AclReaderUnavailableError (never "no ACL").
export function _posix_acl(file) {
  if (internals.platform() !== 'linux') return null;
  return posixAcl(file);
}


/**
 * Per-validation-pass ACL reader. Python reads each entry's ACL right after that entry's lstat; reading
 * thousands of entries one process at a time is too slow, so the explicit paths (and their ancestors) are
 * read in one run and every walked tree in one recursive run. A batched answer is used for an entry only
 * when the entry's lstat (taken in the check, as in Python) shows it unchanged since before that batch
 * started (ctime older than the batch start minus a slack): setting an ACL updates ctime, so an entry
 * changed during or after the batch is read again on its own at its own check. Entries outside every
 * batch are read on their own. The answers therefore equal a read at the entry's own check, as in Python.
 */
class AclPass {
  constructor() {
    this.blobs = new Map();
    this.exact = new Map(); // path -> batch start (ms)
    this.recursive = []; // [root, batch start]
    this.trees = [];
  }

  prefetch_exact(paths) {
    const wanted = [...new Set(paths)].filter((file) => !this.exact.has(file));
    if (!wanted.length) return;
    const started = Date.now();
    for (const [file, blob] of posixAclPaths(wanted)) this.blobs.set(file, blob);
    for (const file of wanted) this.exact.set(file, started);
  }

  prefetch_tree(root) {
    const started = Date.now();
    for (const [file, blob] of posixAclTree(root)) this.blobs.set(file, blob);
    this.recursive.push([root, started]);
  }

  batch_start(file) {
    if (this.exact.has(file)) return this.exact.get(file);
    const covering = this.recursive.find(([root]) => _within(file, root));
    return covering ? covering[1] : null;
  }

  lookup(file, info) {
    if (internals.posix_acl !== _posix_acl) return internals.posix_acl(file); // injected (tests)
    if (internals.platform() !== 'linux') return null;
    let started = this.batch_start(file);
    if (started === null) {
      const tree = this.trees.find((root) => _within(file, root) && !this.recursive.some(([done]) => done === root));
      if (tree !== undefined) {
        this.prefetch_tree(tree);
        started = this.batch_start(file);
      }
    }
    if (started !== null && info && info.ctimeMs < started - internals.change_slack_ms) return this.blobs.get(file) ?? null;
    return _posix_acl(file); // not batched, or possibly changed since its batch: read it now
  }
}

/**
 * Why this entry lets another account change what the desktop account executes.
 *
 * A symlink's own mode is meaningless; only its owner counts. Group write is accepted only
 * when every account in that group is trusted (root's group normally has no unprivileged
 * member); named-user and named-group POSIX ACL entries with write are judged the same way.
 * Limits: group membership comes from the local account database, so members supplied by
 * a directory service or granted later are not seen, and ACLs are only read on Linux.
 * `info` is an lstat result (uid, gid, mode).
 */
export function _untrusted_entry(file, info, trusted, group_members = internals.group_members, acl = internals.posix_acl) {
  // `acl(path, info)`: the entry's ACL blob or null (Python calls _posix_acl(path) here).
  const isSubset = (members) => [...members].every((uid) => trusted.has(uid));
  if (!trusted.has(info.uid)) return `owned by uid ${info.uid}`;
  if (isLnk(info.mode)) return null;
  const sticky_directory = isDirMode(info.mode) && (info.mode & S_ISVTX);
  if ((info.mode & S_IWOTH) && !sticky_directory) {
    // A sticky directory (like /tmp) only lets accounts add entries; they cannot
    // replace ones owned by someone else.
    return 'writable by group or other accounts';
  }
  if ((info.mode & S_IWGRP) && !sticky_directory) {
    const members = group_members(info.gid);
    if (members === null || members === undefined || !isSubset(members)) {
      return 'writable by group or other accounts';
    }
  }
  const blob = acl(file, info);
  if (blob !== null && blob !== undefined) return _acl_writers_untrusted(blob, trusted, group_members);
  return null;
}

export function _acl_writers_untrusted(blob, trusted, group_members) {
  return aclWritersUntrusted(blob, trusted, group_members);
}

/**
 * Refuse a tree where accounts other than root and the desktop account could replace code.
 *
 * Covers the executables the runtime launches and every directory above them up to `/`, plus
 * the complete trees the desktop account executes from (the CUA runtime and the Chrome,
 * browser and computer-use plugins). Symlinks may only point inside the app; each target and
 * its ancestors are validated, and a linked directory is walked once (cycles are ignored).
 * Read-only mounts are checked like any other: ownership and mode say who could change
 * the files through another view of the same source.
 */
export function _check_trusted_tree(app, files, trees, trusted) {
  const problems = [];
  const groups = new Map();
  const acls = new AclPass();

  const members = (gid) => {
    if (!groups.has(gid)) groups.set(gid, internals.group_members(gid));
    return groups.get(gid);
  };
  const acl = (file, info) => acls.lookup(file, info);

  const refusal = () => {
    const shown = problems.slice(0, 3).join('; ') + (problems.length > 3 ? `; and ${problems.length - 3} more` : '');
    return new ValueError('The application is not in a location only root and this account can change: ' +
                          `${shown}. Install the app with a package manager or make it root-owned and not ` +
                          'writable by other accounts');
  };

  const pending = [];
  const inspected = new Map();
  const walked = new Set();

  // Batch reads ahead of the checks (see AclPass): the explicit paths with their ancestors, then each tree.
  if (internals.posix_acl === _posix_acl && internals.platform() === 'linux') {
    try {
      const explicit = [];
      for (const file of files) {
        let real;
        try {
          real = resolve(file, { strict: true });
        } catch {
          continue;
        }
        if (!_within(real, app)) continue;
        for (const candidate of [...parents(file), file]) if (_within(candidate, app)) explicit.push(candidate);
        explicit.push(real, ...parents(real));
      }
      for (const tree of trees) {
        let real;
        try {
          real = resolve(tree, { strict: true });
        } catch {
          continue;
        }
        if (!_within(real, app)) continue;
        acls.trees.push(real);
        explicit.push(...parents(real));
      }
      acls.prefetch_exact(explicit.filter((file) => !acls.trees.includes(file)));
      for (const real of acls.trees) acls.prefetch_tree(real);
    } catch (exc) {
      if (!(exc instanceof AclReaderUnavailableError)) throw exc;
      // nothing batched: each entry is read at its check, which reports the missing reader
    }
  }

  /** Validate one entry. With `walk`, also validate what it leads to (a link's target, a directory's contents). */
  function check(file, walk = false) {
    if (!inspected.has(file)) {
      let info;
      try {
        info = lstatSync(file);
      } catch (exc) {
        problems.push(`${file} cannot be inspected (${strerror(exc)})`);
        inspected.set(file, null);
        return;
      }
      inspected.set(file, info);
      let reason;
      try {
        reason = _untrusted_entry(file, info, trusted, members, acl);
      } catch (exc) {
        if (!(exc instanceof AclReaderUnavailableError)) throw exc;
        // No trusted reader works, so no entry's ACL can be judged (Python read the xattr itself): refuse
        // now (fail closed) instead of repeating the same finding for every entry.
        problems.push(`${file} cannot be inspected (${exc.message})`);
        throw refusal();
      }
      if (reason) problems.push(`${file} is ${reason}`);
    }
    const info = inspected.get(file);
    if (info === null) return;
    if (isLnk(info.mode)) {
      let real;
      try {
        real = resolve(file, { strict: true });
      } catch {
        if (!walked.has(file)) problems.push(`${file} is a broken or looping link`);
        walked.add(file);
        return;
      }
      if (!_within(real, app)) {
        if (!walked.has(file)) problems.push(`${file} links outside the application (${real})`);
        walked.add(file);
        return;
      }
      if (!walked.has(file)) {
        walked.add(file);
        pending.push(real); // the target is validated and, if a directory, walked
      }
    } else if (walk && isDirMode(info.mode) && !walked.has(file)) {
      walked.add(file);
      try {
        const names = [];
        const directory = opendirSync(file);
        try {
          for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) names.push(entry.name);
        } finally {
          directory.closeSync();
        }
        pending.push(...names.map((name) => join(file, name)));
      } catch (exc) {
        problems.push(`${file} cannot be read (${strerror(exc)})`);
      }
    }
  }

  function ancestors(file) {
    for (const candidate of [file, ...parents(file)]) check(candidate);
  }

  for (const file of files) {
    const real = resolve(file, { strict: true });
    if (!_within(real, app)) {
      problems.push(`${file} resolves outside the application (${real})`);
      continue;
    }
    for (const candidate of [...parents(file), file]) { // links on the unresolved path count too
      if (_within(candidate, app)) check(candidate);
    }
    ancestors(real);
  }
  for (const tree of trees) {
    const real = resolve(tree, { strict: true });
    if (!_within(real, app)) {
      problems.push(`${tree} resolves outside the application (${real})`);
      continue;
    }
    ancestors(real);
    pending.push(real);
  }
  while (pending.length) {
    const file = pending.pop();
    check(file, true);
    if (!is_symlink(file)) ancestors(file);
  }
  if (problems.length) throw refusal();
}

function strerror(exc) {
  return fromNodeError(exc)?.strerror ?? exc.message;
}

/** Validate an installed ChatGPT Linux app in place, without copying or modifying it. */
export function resolve_installed_linux_app(app_path, { arch, trusted_uids = null } = {}) {
  let app = pathExpanduser(app_path);
  if (!is_dir(app)) {
    throw new ValueError(`Expected an installed ChatGPT application directory: ${app}`);
  }
  app = resolve(app, { strict: true });
  const resources = join(app, 'resources');
  const runtime = join(resources, 'cua_node');
  const manifest_path = join(runtime, 'manifest.json');
  if (is_symlink(manifest_path) || !is_file(manifest_path)) {
    throw new ValueError(`Application runtime manifest is missing: ${manifest_path}`);
  }
  const manifest = mapObject(loads(read_text(manifest_path)));
  const runtime_version = manifest.get('runtime_archive_version');
  if (manifest.get('platform') !== 'linux' || manifest.get('arch') !== arch ||
      typeof runtime_version !== 'string' || !pyStrip(runtime_version)) {
    throw new ValueError('Application runtime manifest has an unsupported platform, architecture, or version');
  }
  const tools = locate_codex_tools(resources);
  const extension_host = join(resources, `plugins/openai-bundled/plugins/chrome/extension-host/linux/${arch}/extension-host`);
  const required = [
    join(app, 'ChatGPT'), join(runtime, 'bin/node'), join(runtime, 'bin/node_repl'),
    join(runtime, 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs'),
    tools.cli, tools.code_mode_host, join(resources, 'app.asar'),
    join(resources, 'plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json'),
    extension_host,
    join(resources, 'plugins/openai-bundled/plugins/unified-computer-use/.mcp.json'),
  ];
  const missing = required.filter((file) => is_symlink(file) || !is_file(file)).map(String);
  const browser_plugin = join(resources, 'plugins/openai-bundled/plugins/browser');
  if (is_symlink(browser_plugin) || !is_dir(browser_plugin)) {
    missing.push(browser_plugin);
  }
  if (missing.length) {
    throw new ValueError(`Application payload is incomplete: ${missing.join(', ')}`);
  }
  for (const file of [join(app, 'ChatGPT'), join(runtime, 'bin/node'), join(runtime, 'bin/node_repl'),
    tools.cli, tools.code_mode_host, extension_host]) {
    if (!access_x(file)) {
      throw new ValueError(`Application executable is not executable: ${file}`);
    }
  }
  const trusted = new Set([0, internals.getuid(), internals.geteuid(), ...(trusted_uids ?? [])]);
  const modules = join(runtime, 'lib/node_modules');
  const plugins = join(resources, 'plugins/openai-bundled/plugins');
  _check_trusted_tree(app, [...required, ...(exists(modules) ? [modules] : [])],
    [runtime, join(plugins, 'chrome'), browser_plugin, join(plugins, 'unified-computer-use')], trusted);
  return new InstalledApplication(app, resources, runtime, 'linux', _linux_version(app, arch), arch,
    tools.cli, tools.code_mode_host, runtime_version);
}

internals.group_members = _group_members;
internals.posix_acl = _posix_acl;
