// POSIX access ACLs (Linux) for lcu/platforms.py's _posix_acl / _acl_writers_untrusted /
// _untrusted_entry. Python reads the system.posix_acl_access xattr, which Node cannot; here:
//
//   1. `getfacl` (package `acl`): numeric (-n), access ACL only (--access), without following symlinks
//      (-P), absolute names (-p), skipping entries without an extended ACL (-s); -R covers a whole tree in
//      one run, and posixAclPaths() covers an explicit list in one run. Each reported ACL is turned back
//      into the kernel's xattr blob (version 2 header, then tag/perm/id records, in getfacl's order:
//      user_obj, named users, group_obj, named groups, mask, other), so the verdict logic below is a
//      line-for-line port of the Python.
//   2. when getfacl is missing, fails (non-zero exit: an unreadable or vanished entry) or prints anything
//      outside its output contract: a tiny `/usr/bin/python3 -I` reader of the very xattr Python reads
//      (python3 is a declared Linux system package). It reproduces _posix_acl's per-entry behaviour
//      exactly (absent or unreadable entry: no ACL).
//   3. neither works: AclReaderUnavailableError, a prerequisite failure the caller must surface. Python
//      would have read the xattr itself; without a reader LCU cannot tell an entry with an ACL from one
//      without, so it neither trusts the entry nor labels a plain file as carrying an ACL. (Exception:
//      entries that do not exist are answered "no ACL" like Python, since that needs no reader.)
//
// Both helpers are resolved among fixed system directories and run with a fixed minimal environment
// (compat/systool.mjs): no PATH lookup, no environment override, no POSIXLY_CORRECT/locale effect on
// getfacl's output. Tests inject fakes through systool._testing.
//
// Semantic changes (2026-10-05, compat-os review findings 1-3 and 15): the LCU_GETFACL and LCU_ACL_PYTHON
// environment overrides are gone; a missing/failed reader now throws AclReaderUnavailableError with its
// own name and message (a prerequisite failure, not an entry verdict). It still extends
// AclUnavailableError so that existing callers, which rethrow AclUnavailableError and treat every other
// reader error as "no ACL", keep failing closed; callers should test `instanceof
// AclReaderUnavailableError` FIRST and surface it instead of labelling entries "carrying a POSIX ACL
// LCU cannot read" (lcu/platforms.mjs must do that for finding 15 to be fixed end to end).
// Added posixAclPaths() (one non-recursive run over an explicit list).
import { lstatSync } from 'node:fs';

import { runTool, trustedTool } from './systool.mjs';

const TAG = { user_obj: 0x01, user: 0x02, group_obj: 0x04, group: 0x08, mask: 0x10, other: 0x20 };
const ACL_USER = 0x02;
const ACL_GROUP = 0x08;
const ACL_MASK = 0x10;
const ACL_WRITE = 0x02;
const UNDEFINED_ID = 0xffffffff;

/** Python's verdict text for an ACL LCU cannot read; base class of AclReaderUnavailableError. */
export class AclUnavailableError extends Error {
  constructor(message = 'carrying a POSIX ACL LCU cannot read') {
    super(message);
    this.name = 'AclUnavailableError';
  }
}

/** No trusted reader could inspect POSIX ACLs (where Python would have read the xattr directly). */
export class AclReaderUnavailableError extends AclUnavailableError {
  constructor(detail) {
    super(`cannot inspect POSIX ACLs (${detail}); install the acl package (getfacl) or /usr/bin/python3`);
    this.name = 'AclReaderUnavailableError';
  }
}

// Reads exactly what _posix_acl reads: the raw system.posix_acl_access xattr of every entry at or under
// the paths given, never following links. Output: path NUL hex-blob NUL, repeated, then "END" NUL so
// a truncated answer is recognisable.
const PY_READER = String.raw`
import os, stat, sys
ACL = 'system.posix_acl_access'
out = sys.stdout.buffer
recursive = sys.argv[1] == 'r'
stack = [os.fsencode(p) for p in reversed(sys.argv[2:])]
while stack:
    path = stack.pop()
    try:
        if ACL in os.listxattr(path, follow_symlinks=False):
            out.write(path + b'\0' + os.getxattr(path, ACL, follow_symlinks=False).hex().encode() + b'\0')
    except OSError:
        pass
    if recursive:
        try:
            if stat.S_ISDIR(os.lstat(path).st_mode):
                stack.extend(os.path.join(path, name) for name in os.listdir(path))
        except OSError:
            pass
out.write(b'END\0')
`;

const getfaclPath = () => trustedTool('getfacl');
const pythonPath = () => trustedTool('python3', ['/usr/bin']);

const probeCache = new Map();
function probe(path, args) {
  if (path === null) return false;
  const key = `${path}\0${args.join('\0')}`;
  if (!probeCache.has(key)) probeCache.set(key, runTool(path, args, { stdio: 'ignore' }).status === 0);
  return probeCache.get(key);
}

const getfaclWorks = () => probe(getfaclPath(), ['--version']);
const pythonReaderWorks = () => probe(pythonPath(), ['-I', '-c', 'import os; os.listxattr; os.getxattr']);

/** Which reader is tried first: "getfacl", "python3" (xattr fallback) or null (none available). */
export function aclTool() {
  return getfaclWorks() ? 'getfacl' : pythonReaderWorks() ? 'python3' : null;
}

/** True when a trusted getfacl is installed (the `acl` package). */
export function available() {
  return getfaclWorks();
}

function parseReader(output) {
  const parts = output.toString('latin1').split('\0');
  // Complete output ends with the END marker and the empty string after its NUL.
  if (parts.length < 2 || parts.at(-1) !== '' || parts.at(-2) !== 'END' || (parts.length - 2) % 2) return null;
  const result = new Map();
  for (let i = 0; i + 2 < parts.length; i += 2) {
    if (!/^(?:[0-9a-f]{2})*$/.test(parts[i + 1])) return null;
    result.set(Buffer.from(parts[i], 'latin1').toString('utf8'), Buffer.from(parts[i + 1], 'hex'));
  }
  return result;
}

// Map, or null when the python reader is missing or did not complete.
function readWithPython(paths, recursive) {
  if (!pythonReaderWorks()) return null;
  const result = runTool(pythonPath(), ['-I', '-c', PY_READER, recursive ? 'r' : 'n', ...paths]);
  if (result.error || result.status !== 0) return null;
  return parseReader(result.stdout);
}

// getfacl writes unusual file-name bytes as \NNN octal (space, backslash, control and non-ASCII
// bytes). Undo that on the raw bytes, then decode as UTF-8.
function unquote(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x5c) {
      out.push(bytes[i]);
    } else if (bytes[i + 1] === 0x5c) {
      out.push(0x5c); // "\\" is one backslash
      i += 1;
    } else if (i + 3 < bytes.length && /^[0-7]{3}$/.test(String.fromCharCode(bytes[i + 1], bytes[i + 2], bytes[i + 3]))) {
      out.push(parseInt(String.fromCharCode(bytes[i + 1], bytes[i + 2], bytes[i + 3]), 8));
      i += 3;
    } else out.push(bytes[i]);
  }
  return Buffer.from(out).toString('utf8');
}

function permBits(text) {
  return (text[0] === 'r' ? 4 : 0) | (text[1] === 'w' ? 2 : 0) | (text[2] === 'x' ? 1 : 0);
}

function blobOf(entries) {
  const blob = Buffer.alloc(4 + entries.length * 8);
  blob.writeUInt32LE(2, 0);
  entries.forEach(([tag, perm, id], index) => {
    blob.writeUInt16LE(tag, 4 + index * 8);
    blob.writeUInt16LE(perm, 6 + index * 8);
    blob.writeUInt32LE(id, 8 + index * 8);
  });
  return blob;
}

const ENTRY = /^(user|group|mask|other):([^:]*):([r-][w-][x-])(?:\t+#effective:[r-][w-][x-])?$/;
const HEADER = /^# (?:owner|group|flags): /;

/**
 * Parse `getfacl -n -p -s` output into Map<path, Buffer> (the access ACL as the kernel's xattr blob).
 * Lenient form (kept for compatibility): unknown lines are skipped. `{ strict: true }` returns null on
 * any line outside getfacl's documented format or an incomplete ACL (the readers use the strict form).
 */
export function parseGetfacl(output, { strict = false } = {}) {
  const result = new Map();
  let path = null;
  let entries = [];
  let bad = false;
  const flush = () => {
    if (path !== null) {
      if (entries.length) {
        if (strict) {
          const tags = entries.map(([tag]) => tag);
          const named = tags.some((tag) => tag === TAG.user || tag === TAG.group);
          const once = (tag) => tags.filter((t) => t === tag).length === 1;
          if (!once(TAG.user_obj) || !once(TAG.group_obj) || !once(TAG.other) || (named && !once(TAG.mask))) bad = true;
        }
        result.set(path, blobOf(entries));
      } else if (strict) bad = true; // -s prints only entries that have an extended ACL
    }
    path = null;
    entries = [];
  };
  const text = Buffer.isBuffer(output) ? output : Buffer.from(output);
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf(0x0a, start);
    if (end < 0) end = text.length;
    const raw = text.subarray(start, end);
    start = end + 1;
    if (raw[0] === 0x23 && raw.subarray(0, 8).toString('latin1') === '# file: ') {
      flush();
      path = unquote(raw.subarray(8));
      continue;
    }
    if (raw.length === 0) continue;
    if (path === null || raw[0] === 0x23) {
      if (strict && (path === null || !HEADER.test(raw.toString('latin1')))) bad = true;
      continue;
    }
    const full = raw.toString('latin1');
    if (strict && !ENTRY.test(full)) {
      bad = true;
      continue;
    }
    const line = full.split('\t')[0].trim(); // drop "\t#effective:..."
    if (line.startsWith('default:')) {
      if (strict) bad = true; // --access never prints default entries
      continue;
    }
    const [kind, qualifier, perms] = line.split(':');
    if (!(kind in TAG) || perms === undefined) continue;
    // "user::rwx" is the owner entry (user_obj), "user:1001:rw-" a named one; likewise for group.
    const named = (kind === 'user' || kind === 'group') && qualifier !== '';
    const tag = kind === 'user' || kind === 'group' ? TAG[named ? kind : `${kind}_obj`] : TAG[kind];
    const id = named ? Number(qualifier) : UNDEFINED_ID;
    if (named && !(/^\d+$/.test(qualifier) && id <= UNDEFINED_ID)) {
      if (strict) bad = true;
      continue;
    }
    if (strict && !named && qualifier !== '') bad = true;
    entries.push([tag, permBits(perms), id]);
  }
  flush();
  return strict && bad ? null : result;
}

// Map, or null when getfacl is missing, failed, or its output broke the contract.
function readWithGetfacl(paths, recursive) {
  if (!getfaclWorks()) return null;
  const args = ['--access', '--numeric', '--absolute-names', '--physical', '--skip-base'];
  if (recursive) args.push('--recursive');
  const result = runTool(getfaclPath(), [...args, '--', ...paths], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error || result.status !== 0) return null;
  return parseGetfacl(result.stdout, { strict: true });
}

const exists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

function read(paths, recursive) {
  if (!paths.length) return new Map();
  let found = readWithGetfacl(paths, recursive) ?? readWithPython(paths, recursive);
  if (found) return found;
  // getfacl exits non-zero when an operand does not exist; without the python reader retry with the
  // existing ones only (an absent entry has no ACL, as in Python).
  const present = paths.filter(exists);
  if (present.length < paths.length) {
    found = present.length ? readWithGetfacl(present, recursive) : new Map();
    if (found) return found;
  }
  const tool = aclTool();
  throw new AclReaderUnavailableError(tool === null ? 'neither getfacl nor /usr/bin/python3 is available'
    : 'getfacl failed and the /usr/bin/python3 xattr reader is unavailable');
}

/**
 * Every entry at or under `root` (without following links) that carries an extended access ACL:
 * Map<path, Buffer blob>. One getfacl run for the whole tree.
 */
export function posixAclTree(root) {
  return read([root], true);
}

/**
 * The access ACL blobs of exactly these entries (not recursive): Map<path, Buffer> holding the ones
 * that carry an extended ACL. One getfacl run for the whole list.
 */
export function posixAclPaths(paths) {
  const unique = [...new Set(paths)];
  const found = read(unique, false);
  // keep only the operands asked for (getfacl answers with the operand text as given)
  return new Map([...found].filter(([path]) => unique.includes(path)));
}

/** _posix_acl(path): the raw access ACL blob when the entry has one, otherwise null. */
export function posixAcl(path) {
  return read([path], false).get(path) ?? null;
}

/**
 * _acl_writers_untrusted(blob, trusted, group_members): why a named-user or named-group ACL entry
 * lets an untrusted account write, or null. `trusted` is a Set of uids; `groupMembers(gid)` returns
 * a Set of uids or null (unknown).
 */
export function aclWritersUntrusted(blob, trusted, groupMembers) {
  if (blob.length < 4 || (blob.length - 4) % 8 || blob.readUInt32LE(0) !== 2) return 'carrying a POSIX ACL LCU cannot read';
  const entries = [];
  for (let i = 4; i < blob.length; i += 8) entries.push([blob.readUInt16LE(i), blob.readUInt16LE(i + 2), blob.readUInt32LE(i + 4)]);
  const masks = entries.filter(([tag]) => tag === ACL_MASK).map(([, perm]) => perm);
  const mask = masks.length ? masks[0] : 0x7;
  for (const [tag, perm, id] of entries) {
    if (!(perm & mask & ACL_WRITE)) continue;
    if (tag === ACL_USER && !trusted.has(id)) return `writable by uid ${id} through a POSIX ACL`;
    if (tag === ACL_GROUP) {
      const members = groupMembers(id);
      if (members === null || members === undefined || ![...members].every((uid) => trusted.has(uid))) {
        return `writable by group ${id} through a POSIX ACL`;
      }
    }
  }
  return null;
}

const S_IFMT = 0o170000;
const isLink = (mode) => (mode & S_IFMT) === 0o120000;
const isDir = (mode) => (mode & S_IFMT) === 0o040000;

/**
 * _untrusted_entry(path, info, trusted, group_members): why this entry lets another account change
 * what the desktop account executes, or null. `info` is an fs.lstatSync result. ACLs come from
 * `acls` (a Map from posixAclTree/posixAclPaths, so a tree walk costs one getfacl run); without it the
 * reader runs for this one path. A groupMembers that throws (account database unavailable) propagates:
 * callers must not treat it as "trusted".
 */
export function untrustedEntry(path, info, trusted, groupMembers, acls) {
  if (!trusted.has(info.uid)) return `owned by uid ${info.uid}`;
  if (isLink(info.mode)) return null;
  const stickyDirectory = isDir(info.mode) && (info.mode & 0o1000) !== 0; // S_ISVTX
  if (info.mode & 0o002 && !stickyDirectory) return 'writable by group or other accounts';
  if (info.mode & 0o020 && !stickyDirectory) {
    const members = groupMembers(info.gid);
    if (members === null || members === undefined || ![...members].every((uid) => trusted.has(uid))) {
      return 'writable by group or other accounts';
    }
  }
  const blob = acls ? (acls.get(path) ?? null) : posixAcl(path);
  if (blob !== null) return aclWritersUntrusted(blob, trusted, groupMembers);
  return null;
}
