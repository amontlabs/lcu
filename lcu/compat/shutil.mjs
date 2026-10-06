// shutil.rmtree(path) with CPython 3.12.10's observable behaviour: entries are removed one by one in CPython's order
// (below) and the first failure is raised for the entry that failed (an unreadable directory reports its own path,
// EACCES), instead of Node's rmSync, which reports ENOTEMPTY for the parent. A symbolic link as the top is refused.
//
// Names are traversed as BYTES (Buffers): a name that is not UTF-8 (tar extraction creates them on Linux, as raw
// surrogate-escaped bytes) is removed through its exact bytes instead of a lossy U+FFFD rendering (round-2 R08).
// Documented residual: CPython's rmtree is fd-relative on platforms with openat/unlinkat (a swapped-in symlink cannot
// redirect the deletion); Node has no *at() calls, so this walk is pathname-based like CPython's fallback path
// (_rmtree_unsafe). It is only used on LCU-owned trees (pruned releases, extraction scratch directories).
import { lstatSync, opendirSync, rmdirSync, unlinkSync } from 'node:fs';

import { PyOSError } from './pyerr.mjs';
import { fsPath } from './pathlib.mjs';

const SLASH = Buffer.from('/');

// Native directory order, like os.scandir: opendir/readdir, never readdirSync (libuv sorts those names). Which
// entries are already gone when the first failure stops the walk depends on this order and on the one below.
function scan(directory) {
  let handle;
  try {
    handle = opendirSync(directory, { encoding: 'buffer' });
  } catch (error) {
    if (error && error.path === undefined) error.path = directory.toString(); // opendir errors carry no path
    throw error;
  }
  try {
    const entries = [];
    for (let entry; (entry = handle.readSync()) !== null;) entries.push(entry);
    return entries;
  } finally {
    handle.closeSync();
  }
}

// DirEntry.is_dir(follow_symlinks=False): the entry's own type, lstat'ed when the file system does not say.
function isDirectory(entry, path) {
  if (entry.isDirectory()) return true;
  if (entry.isFile() || entry.isSymbolicLink() || entry.isFIFO() || entry.isSocket() || entry.isCharacterDevice()
    || entry.isBlockDevice()) return false;
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * CPython 3.12.10's _rmtree_safe_fd order: a directory is opened and scanned; its non-directory entries are
 * unlinked at once, in scan order; its subdirectories are pushed on a stack (so they are visited last to first,
 * depth first) and the directory itself is removed after all of them.
 */
function removeTree(top) {
  const stack = [{ rmdir: false, path: top }];
  while (stack.length) {
    const item = stack.pop();
    if (item.rmdir) {
      rmdirSync(item.path);
      continue;
    }
    const entries = scan(item.path);
    stack.push({ rmdir: true, path: item.path });
    for (const entry of entries) {
      const path = Buffer.concat([item.path, SLASH, entry.name]);
      if (isDirectory(entry, path)) stack.push({ rmdir: false, path });
      else unlinkSync(path);
    }
  }
}

/** `path` is a string (surrogate-escaped bytes allowed, as os.fsdecode gives them) or a Buffer of the raw bytes. */
export function rmtree(path) {
  const raw = Buffer.isBuffer(path) ? path : Buffer.from(fsPath(path));
  if (lstatSync(raw).isSymbolicLink()) throw new PyOSError('Cannot call rmtree on a symbolic link');
  removeTree(raw);
}
