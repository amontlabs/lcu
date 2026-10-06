// Account database access equivalent to Python's pwd/grp modules, plus the privilege drop
// lcu/setup.py performs (os.initgroups, os.setgid, os.setuid) and the subprocess `user=`/`group=`/
// `extra_groups=`/`cwd=` drop scripts/install.py uses (spawnAs / spawnAsSync).
//
// Lookups go through the system tools that read the same databases the C library does:
// `getent` on Linux (NSS: files, sssd, ldap, ...) and `dscacheutil -q user|group` on macOS
// (the Directory Services cache getpwnam() itself uses). Everything is synchronous, like Python.
// The tools are resolved among fixed system directories and run with a fixed environment
// (compat/systool.mjs): no PATH lookup, no environment override (LCU_GETENT is gone).
//
// Failure model (2026-10-05, compat-os review findings 2, 3, 8, 9, 10). Python's pwd/grp call libc and
// cannot "fail to run"; Node can. So:
//   * a keyed miss (getent exit 2, or an empty dscacheutil answer) is "not found" (null / KeyError);
//   * a missing tool, any other getent status (1 invalid database/arguments, 3 enumeration unsupported),
//     a killed/timed-out helper, or an enumeration that does not contain uid/gid 0 throws
//     AccountLookupError. It is never turned into an empty answer, so groupMembers() throws instead of
//     returning an empty ("every member trusted") set; lcu/platforms' _group_members maps that to null
//     (unknown -> untrusted).
//   * name lookups match the exact name: getent treats a key strtoul() parses completely ("0",
//     "12345", " 7", "+1") as a uid/gid, so such names are resolved by enumerating the database and
//     taking the first exact pw_name/gr_name match (limit: NSS sources that refuse enumeration answer
//     AccountLookupError, never another account).
//   * dscacheutil exits 0 even when it cannot answer; an empty keyed answer is "not found" (limit,
//     macOS only); an empty enumeration is AccountLookupError.
import { spawn, spawnSync } from './spawn.mjs';
import { ignored_signals } from '../startup_vars.mjs';
import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, openSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reprStr } from './pyerr.mjs';
import { runTool, trustedTool } from './systool.mjs';

/** Python's KeyError, as raised by pwd.getpwnam() and friends. */
export class PyKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeyError';
  }
}

/** The account database could not be queried (where Python would have asked libc directly). */
export class AccountLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccountLookupError';
  }
}

const TIMEOUT = 20000;
const NOT_FOUND = Symbol('not found');

function run(tool, args, { keyed = false } = {}) {
  const path = trustedTool(tool, tool === 'dscacheutil' ? ['/usr/bin'] : undefined);
  if (path === null) throw new AccountLookupError(`cannot query the account database: no trusted ${tool}`);
  const result = runTool(path, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: TIMEOUT });
  if (result.error) {
    throw new AccountLookupError(`cannot query the account database: ${tool}: ${result.error.code ?? result.error.message}`);
  }
  if (result.status === 0) return result.stdout;
  // getent(1): exit 2 = "one or more supplied key could not be found". Anything else is not an answer.
  if (keyed && tool === 'getent' && result.status === 2) return NOT_FOUND;
  const how = result.signal ? `died with ${result.signal}` : `exited ${result.status}`;
  throw new AccountLookupError(`cannot query the account database: ${tool} ${args.join(' ')} ${how}`);
}

// dscacheutil prints uid_t/gid_t values above 2^31 as negative numbers; Python shows them unsigned.
const unsigned = (value) => {
  const n = Number(value);
  return n < -1 ? n + 2 ** 32 : n; // (uid_t)-1 stays -1, as Python shows it
};

const passwdEntry = (fields) => {
  const entry = {
    pw_name: fields.name,
    pw_passwd: fields.passwd,
    pw_uid: unsigned(fields.uid),
    pw_gid: unsigned(fields.gid),
    pw_gecos: fields.gecos,
    pw_dir: fields.dir,
    pw_shell: fields.shell,
  };
  return Object.freeze({ ...entry, name: entry.pw_name, uid: entry.pw_uid, gid: entry.pw_gid, home: entry.pw_dir, shell: entry.pw_shell });
};

const groupEntry = (fields) => {
  const entry = {
    gr_name: fields.name,
    gr_passwd: fields.passwd,
    gr_gid: unsigned(fields.gid),
    gr_mem: fields.members,
  };
  return Object.freeze({ ...entry, name: entry.gr_name, gid: entry.gr_gid, members: entry.gr_mem });
};

// Fail closed (round-2 R01): a helper answer is parsed whole, and ANY malformed row is an AccountLookupError. Skipping a
// row would let a partial parse stand for the complete database (a missing writer in groupMembers is "trusted").
const ID_FIELD = /^\d{1,10}$/;
const validId = (text) => ID_FIELD.test(text) && Number(text) <= 0xffffffff;
const malformed = (kind, line) => new AccountLookupError(
  `cannot query the account database: malformed getent ${kind} row ${JSON.stringify(line.length > 80 ? `${line.slice(0, 80)}...` : line)}`);

function parseGetentPasswd(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const fields = line.split(':');
    // name:passwd:uid:gid:gecos:dir:shell (exactly seven fields; no field of the real database holds a colon)
    if (fields.length !== 7 || !fields[0] || !validId(fields[2]) || !validId(fields[3])) throw malformed('passwd', line);
    const [name, passwd, uid, gid, gecos, dir, shell] = fields;
    entries.push(passwdEntry({ name, passwd, uid, gid, gecos, dir, shell }));
  }
  return entries;
}

function parseGetentGroup(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const fields = line.split(':');
    if (fields.length !== 4 || !fields[0] || !validId(fields[2])) throw malformed('group', line);
    const [name, passwd, gid, members] = fields;
    const list = members ? members.split(',') : [];
    if (list.some((member) => !member)) throw malformed('group', line);
    entries.push(groupEntry({ name, passwd, gid, members: list }));
  }
  return entries;
}

// dscacheutil prints "key: value" lines, one blank line between records.
function parseDscacheutil(text) {
  const records = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line === '') {
      current = null;
      continue;
    }
    const at = line.indexOf(':');
    if (at < 0) throw new AccountLookupError(`cannot query the account database: malformed dscacheutil line ${JSON.stringify(line.slice(0, 80))}`);
    if (!current) {
      current = {};
      records.push(current);
    }
    current[line.slice(0, at)] = line.slice(at + 1).replace(/^ /, '');
  }
  return records;
}

const macCheck = (record, kind, fields) => {
  const signed = /^-?\d{1,10}$/;
  if (!record.name || fields.some((field) => !signed.test(record[field] ?? ''))) {
    throw new AccountLookupError(`cannot query the account database: malformed dscacheutil ${kind} record`);
  }
  return record;
};

const macPasswd = (record) =>
  passwdEntry({
    ...macCheck(record, 'user', ['uid', 'gid']) && {},
    name: record.name,
    passwd: record.password ?? '*',
    uid: record.uid,
    gid: record.gid,
    gecos: record.gecos ?? '',
    dir: record.dir ?? '',
    shell: record.shell ?? '',
  });

const macGroup = (record) =>
  groupEntry({
    ...macCheck(record, 'group', ['gid']) && {},
    name: record.name,
    passwd: record.password ?? '*',
    gid: record.gid,
    // dscacheutil separates members with spaces and leaves a trailing one.
    members: (record.users ?? '').split(' ').filter(Boolean),
  });

const isDarwin = () => process.platform === 'darwin';

function checkName(name, label) {
  if (typeof name !== 'string') throw new TypeError(`${label}() argument must be str, not ${typeof name}`);
  if (name.includes('\0')) throw new Error('embedded null byte');
}

// glibc getent: `strtoul(key, &end, 10)` consuming the whole non-empty key selects getpwuid/getgrgid.
const GETENT_NUMERIC = /^[ \t\n\v\f\r]*[+-]?\d+$/;

function lookup(kind, key) {
  const byName = typeof key === 'string';
  const text = String(key);
  if (isDarwin()) {
    const flag = kind === 'passwd' ? 'user' : 'group';
    const by = byName ? 'name' : kind === 'passwd' ? 'uid' : 'gid';
    // A negative id would read as an option: ask for the same uid_t/gid_t as an unsigned number.
    const value = !byName && key < 0 ? String(key + 2 ** 32) : text;
    const records = parseDscacheutil(run('dscacheutil', ['-q', flag, '-a', by, value]));
    const mapper = kind === 'passwd' ? macPasswd : macGroup;
    // The directory matches names case-insensitively, like getpwnam() does: take what it answers.
    return records.map(mapper)[0] ?? null;
  }
  if (byName && GETENT_NUMERIC.test(text)) {
    const all = kind === 'passwd' ? getpwall() : getgrall();
    return all.find((entry) => (kind === 'passwd' ? entry.pw_name : entry.gr_name) === text) ?? null;
  }
  const parser = kind === 'passwd' ? parseGetentPasswd : parseGetentGroup;
  const output = run('getent', [kind, '--', text], { keyed: true });
  if (output === NOT_FOUND) return null;
  const entries = parser(output);
  if (!entries.length) throw new AccountLookupError(`cannot query the account database: unreadable getent ${kind} answer`);
  return entries[0];
}

/** pwd.getpwnam; returns null when the account does not exist. */
export function findpwnam(name) {
  checkName(name, 'getpwnam');
  return lookup('passwd', name);
}

/** pwd.getpwuid; returns null when no account has this uid. */
export function findpwuid(uid) {
  if (!Number.isInteger(uid)) throw new TypeError('getpwuid(): uid must be an integer');
  return lookup('passwd', uid);
}

/** grp.getgrnam; returns null when missing. */
export function findgrnam(name) {
  checkName(name, 'getgrnam');
  return lookup('group', name);
}

/** grp.getgrgid; returns null when missing. */
export function findgrgid(gid) {
  if (!Number.isInteger(gid)) throw new TypeError('getgrgid(): gid must be an integer');
  return lookup('group', gid);
}

/** pwd.getpwnam: throws KeyError "getpwnam(): name not found: 'x'" when missing. */
export function getpwnam(name) {
  const entry = findpwnam(name);
  if (!entry) throw new PyKeyError(`getpwnam(): name not found: ${reprStr(name)}`);
  return entry;
}

/** pwd.getpwuid: throws KeyError "getpwuid(): uid not found: N" when missing. */
export function getpwuid(uid) {
  const entry = findpwuid(uid);
  if (!entry) throw new PyKeyError(`getpwuid(): uid not found: ${uid}`);
  return entry;
}

/** grp.getgrnam. */
export function getgrnam(name) {
  const entry = findgrnam(name);
  if (!entry) throw new PyKeyError(`getgrnam(): name not found: ${reprStr(name)}`);
  return entry;
}

/** grp.getgrgid. */
export function getgrgid(gid) {
  const entry = findgrgid(gid);
  if (!entry) throw new PyKeyError(`getgrgid(): gid not found: ${gid}`);
  return entry;
}

function checkedEnumeration(entries, kind, id) {
  // Every POSIX account database has uid 0 / gid 0; an answer without it is not the database.
  if (!entries.some((entry) => entry[id] === 0)) {
    throw new AccountLookupError(`cannot query the account database: incomplete ${kind} enumeration`);
  }
  return entries;
}

/** pwd.getpwall */
export function getpwall() {
  const entries = isDarwin()
    ? parseDscacheutil(run('dscacheutil', ['-q', 'user'])).map(macPasswd)
    : parseGetentPasswd(run('getent', ['passwd']));
  return checkedEnumeration(entries, 'passwd', 'pw_uid');
}

/** grp.getgrall */
export function getgrall() {
  const entries = isDarwin()
    ? parseDscacheutil(run('dscacheutil', ['-q', 'group'])).map(macGroup)
    : parseGetentGroup(run('getent', ['group']));
  return checkedEnumeration(entries, 'group', 'gr_gid');
}

/**
 * lcu/platforms.py _group_members: every uid that holds `gid` as primary or listed supplementary
 * group. Throws AccountLookupError when the database cannot be read (Python's answer would be
 * unknown to us; callers map it to "untrusted").
 */
export function groupMembers(gid) {
  const members = new Set();
  const group = findgrgid(gid);
  if (group) {
    for (const name of group.gr_mem) {
      const account = findpwnam(name);
      if (account) members.add(account.pw_uid);
    }
  }
  for (const account of getpwall()) if (account.pw_gid === gid) members.add(account.pw_uid);
  return members;
}

/** The environment lcu/setup.py gives the process after it drops to an account. */
export function accountEnvironment(account) {
  return {
    HOME: account.pw_dir,
    USER: account.pw_name,
    LOGNAME: account.pw_name,
    PATH: `${account.pw_dir}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    LANG: 'C.UTF-8',
  };
}

/**
 * In-process equivalent of setup.py's `os.initgroups; os.setgid; os.setuid` (same order, same
 * failure points: a failed step leaves the earlier ones applied, as in Python).
 */
export function dropPrivileges(account) {
  process.initgroups(account.pw_name, account.pw_gid);
  process.setgid(account.pw_gid);
  process.setuid(account.pw_uid);
}

/**
 * setup.py's whole "become the account" block: drop privileges, replace the environment with
 * accountEnvironment() (os.environ.clear(); update()) and chdir to the home directory.
 */
export function becomeAccount(account) {
  dropPrivileges(account);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, accountEnvironment(account));
  process.chdir(account.pw_dir);
}

// The child side of spawnAs, in _posixsubprocess's order: chdir(cwd) (still privileged), setgroups
// (initgroups == setgroups(getgrouplist())), setgid, setuid, exec. The launch data arrives on fd 4 (an
// already-unlinked private file, so no argv/env size limit applies and nothing is left behind). The
// report channel is re-opened close-on-exec from fd 3, then fds 3 and 4 are closed, so the target
// inherits neither; a failure is written there as JSON with Python's error text.
const CHILD = `
import { execve, execvpe } from ${JSON.stringify(new URL('./execve.mjs', import.meta.url).href)};
import { fromNodeError } from ${JSON.stringify(new URL('./pyerr.mjs', import.meta.url).href)};
import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
const size = fstatSync(4).size;
const buffer = Buffer.alloc(size);
for (let at = 0; at < size;) at += readSync(4, buffer, at, size - at, at);
const { name, uid, gid, file, argv, env, cwd, search, ignored } = JSON.parse(buffer.toString('utf8'));
let out = 3;
try { out = openSync('/dev/fd/3', 'w'); closeSync(3); } catch { /* no /dev/fd: keep fd 3 (then inherited) */ }
closeSync(4);
const report = (stage, err, filename) => {
  const py = err && err.errno !== undefined && !(err.name && err.name.endsWith('Error') && err.name !== 'Error')
    ? fromNodeError(err, filename === undefined ? {} : { filename, filename2: null }) : null;
  const shown = py ?? err;
  try { writeSync(out, JSON.stringify({ stage, code: err.code, errno: err.errno, message: shown.message, text: shown.name && shown.name !== 'Error' ? shown.name + ': ' + shown.message : shown.message })); } catch {}
  process.exit(126);
};
if (cwd !== null && cwd !== undefined) { try { process.chdir(cwd); } catch (err) { report('chdir', err, cwd); } }
try { process.initgroups(name, gid); } catch (err) { report('initgroups', err); }
try { process.setgid(gid); } catch (err) { report('setgid', err); }
try { process.setuid(uid); } catch (err) { report('setuid', err); }
try { (search ? execvpe : execve)(file, argv, env, { ignored }); } catch (err) { report('execve', err); }
`;

// The private launch-data file: created exclusively, mode 0600, unlinked at once; only the fd remains.
function payloadFd(payload) {
  const path = join(tmpdir(), `.lcu-spawn-as-${process.pid}-${randomBytes(8).toString('hex')}`);
  const { O_CREAT, O_EXCL, O_RDWR, O_NOFOLLOW = 0 } = fsConstants;
  const fd = openSync(path, O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW, 0o600);
  try {
    unlinkSync(path);
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    for (let at = 0; at < data.length;) at += writeSync(fd, data, at, data.length - at, at);
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  return fd;
}

function launch(account, file, argv, { env = process.env, cwd, search = false, stdio = 'inherit' }) {
  // `ignored`: the signals the caller left ignored; this helper Node resets them at startup, so the final exec
  // (compat/execve) sets them ignored again for the target, as Python's subprocess passes SIG_IGN on.
  const payload = { name: account.pw_name, uid: account.pw_uid, gid: account.pw_gid, file, argv, env: { ...env }, cwd: cwd ?? null, search,
    ignored: ignored_signals() };
  const stdioList = Array.isArray(stdio) ? [...stdio] : [stdio, stdio, stdio];
  while (stdioList.length < 3) stdioList.push('inherit');
  const fd = payloadFd(payload);
  stdioList[3] = 'pipe';
  stdioList[4] = fd;
  // The helper Node gets a fixed environment: nothing of the caller's reaches it except via the payload.
  return { fd, stdio: stdioList, args: ['--input-type=module', '-e', CHILD], env: { PATH: '/usr/bin:/bin' } };
}

/**
 * Run `file argv...` as `account` with its supplementary groups, like Python's
 * `subprocess.Popen(argv, user=uid, group=gid, extra_groups=getgrouplist(name, gid), cwd=cwd)`.
 * (Node's own spawn `uid`/`gid` options skip initgroups and keep root's supplementary groups.)
 *
 * Options: env (default process.env), cwd (any string, including '', is entered before the drop, as
 * Python does; null/undefined: inherit), search (use PATH lookup like execvpe), stdio, and `node`
 * (interpreter for the helper child, default process.execPath).
 * Returns a ChildProcess; if the chdir, drop or exec fails it exits 126 and emits a `lcu-spawn-error`
 * event with {stage, code, message, text} (text: Python's "<Class>: <str(exc)>").
 */
export function spawnAs(account, file, argv, { env = process.env, cwd, search = false, stdio = 'inherit', node = process.execPath } = {}) {
  const plan = launch(account, file, argv, { env, cwd, search, stdio });
  let child;
  try {
    child = spawn(node, plan.args, { env: plan.env, stdio: plan.stdio });
  } finally {
    closeSync(plan.fd);
  }
  let report = '';
  child.stdio[3]?.on('data', (chunk) => (report += chunk));
  child.once('close', () => {
    if (report) {
      try {
        child.emit('lcu-spawn-error', JSON.parse(report));
      } catch {
        /* unreadable report: the exit status already says it failed */
      }
    }
  });
  return child;
}

/**
 * Synchronous spawnAs: returns spawnSync's result plus `spawnError` ({stage, code, message, text}
 * or null). Extra spawnSync options (timeout, killSignal, encoding, maxBuffer, input) pass through.
 */
export function spawnAsSync(account, file, argv, { env = process.env, cwd, search = false, stdio = 'inherit', node = process.execPath, ...rest } = {}) {
  const plan = launch(account, file, argv, { env, cwd, search, stdio });
  let result;
  try {
    result = spawnSync(node, plan.args, { maxBuffer: 1 << 30, ...rest, env: plan.env, stdio: plan.stdio });
  } finally {
    closeSync(plan.fd);
  }
  let spawnError = null;
  const reported = result.output?.[3]?.toString();
  if (reported) {
    try {
      spawnError = JSON.parse(reported);
    } catch {
      /* the exit status says it failed */
    }
  }
  return Object.assign(result, { spawnError });
}
