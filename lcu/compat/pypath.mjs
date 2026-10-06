// posixpath / ntpath / os.path semantics (Python 3.12) used by the archive extractors.
//
// The default exports are the POSIX flavour (tar extraction is POSIX only). Since 2026-10-05 (compat-archive-http
// review F01) the ZIP extractor, which also runs on Windows, uses `flavourFor(platform)`: a flavour is an object
// {sep, isabs, join, split, dirname, normpath, splitdrive, makedirs, exists, isdir}. The `win32` flavour is a port
// of CPython's ntpath for the operations extraction needs (splitroot, join, split, normpath); node:path.win32 is not
// used because it differs (normalize keeps trailing separators, join(a, '') adds one). It is tested differentially
// against CPython's ntpath module (which runs on any OS) and with virtual filesystems; no live Windows claim.
//
// Delegation: fsPath, isabs, join, split, normpath, abspath and realpath of the POSIX flavour all come from
// compat/pathlib.mjs (the authoritative copy; its realpath looks names up as raw bytes and raises Python's NUL-path
// ValueError).
import fs from 'node:fs';
import { pyfs, toPyOSError, ValueError, PyOSError } from './errors.mjs';
import * as pathlib from './pathlib.mjs';

/** Re-exported from compat/pathlib.mjs (the single implementation). */
export const fsPath = pathlib.fsPath;

export const isabs = pathlib.isAbs;

export function join(a, ...rest) {
  let path = a;
  for (const b of rest) path = pathlib.join(path, b);
  return path;
}

export const split = pathlib.split;

export const dirname = (p) => split(p)[0];

/** os.path.normpath (POSIX). */
export const normpath = (path) => pathlib.normpath(path);

/** os.path.abspath (POSIX, current directory). */
export function abspath(path) {
  return pathlib.abspath(path);
}

export function lexists(p) {
  try { fs.lstatSync(fsPath(p)); return true; } catch { return false; }
}
export function exists(p) {
  try { fs.statSync(fsPath(p)); return true; } catch { return false; }
}
export function isdir(p) {
  try { return fs.statSync(fsPath(p)).isDirectory(); } catch { return false; }
}

/** os.path.realpath(path) (non-strict): delegates to compat/pathlib.mjs (raw-byte lookups, NUL -> ValueError). */
export function realpath(filename) {
  return pathlib.realpath(filename);
}

/** os.path.commonpath([a, b]) for two absolute paths. */
export function commonpath2(a, b) {
  const parts = (p) => p.split('/').filter((c) => c && c !== '.');
  const x = parts(a), y = parts(b);
  const common = [];
  for (let i = 0; i < Math.min(x.length, y.length) && x[i] === y[i]; i++) common.push(x[i]);
  return '/' + common.join('/');
}

/**
 * Write every byte of `buffer` to fd (at `position` when given): a short write is completed like Python's
 * BufferedWriter does, and a failing write is an OSError (no filename: the error comes from write(), not open()).
 */
export function writeAll(fd, buffer, position = null) {
  let offset = 0;
  while (offset < buffer.length) {
    let n;
    try {
      n = fs.writeSync(fd, buffer, offset, buffer.length - offset, position === null ? null : position + offset);
    } catch (err) { throw toPyOSError(err); }
    if (!(n > 0)) throw new PyOSError('EIO');
    offset += n;
  }
}

/** os.makedirs(name) with exist_ok=False, mode 0o777 (umask applies), for any flavour (default POSIX). */
export function makedirs(name, flavour = posix) {
  let [head, tail] = flavour.split(name);
  if (!tail) [head, tail] = flavour.split(head);
  if (head && tail && !flavour.exists(head)) {
    try { makedirs(head, flavour); } catch (err) { if (err.name !== 'FileExistsError') throw err; }
    if (tail === '.') return;
  }
  pyfs(name, () => fs.mkdirSync(fsPath(name), 0o777));
}

// ---------------------------------------------------------------- flavours
export const posix = {
  name: 'posix', sep: '/', isabs, join, split, dirname, normpath, exists, isdir,
  splitdrive: (p) => ['', p],
  makedirs: (name) => makedirs(name, posix),
};

/** ntpath.splitroot (3.12): [drive, root, rest]. */
function ntSplitroot(p) {
  const normp = p.replaceAll('/', '\\');
  if (normp.slice(0, 1) === '\\') {
    if (normp.slice(1, 2) === '\\') {
      // UNC drives, e.g. \\server\share or \\?\UNC\server\share
      const start = normp.slice(0, 8).toUpperCase() === '\\\\?\\UNC\\' ? 8 : 2;
      const index = normp.indexOf('\\', start);
      if (index === -1) return [p, '', ''];
      const index2 = normp.indexOf('\\', index + 1);
      if (index2 === -1) return [p, '', ''];
      return [p.slice(0, index2), p.slice(index2, index2 + 1), p.slice(index2 + 1)];
    }
    return ['', p.slice(0, 1), p.slice(1)]; // relative path with root, e.g. \Windows
  }
  if (normp.slice(1, 2) === ':') {
    if (normp.slice(2, 3) === '\\') return [p.slice(0, 2), p.slice(2, 3), p.slice(3)]; // X:\Windows
    return [p.slice(0, 2), '', p.slice(2)]; // X:Windows
  }
  return ['', '', p];
}

const isNtSep = (ch) => ch === '\\' || ch === '/';

function ntJoin(path, ...paths) {
  let [resultDrive, resultRoot, resultPath] = ntSplitroot(path);
  for (const p of paths) {
    const [pDrive, pRoot, pPath] = ntSplitroot(p);
    if (pRoot) {
      if (pDrive || !resultDrive) resultDrive = pDrive; // second path is absolute
      resultRoot = pRoot;
      resultPath = pPath;
      continue;
    } else if (pDrive && pDrive !== resultDrive) {
      if (pDrive.toLowerCase() !== resultDrive.toLowerCase()) { // different drives: ignore the first path entirely
        resultDrive = pDrive; resultRoot = pRoot; resultPath = pPath;
        continue;
      }
      resultDrive = pDrive; // same drive in different case
    }
    if (resultPath && !isNtSep(resultPath[resultPath.length - 1])) resultPath += '\\'; // second path is relative
    resultPath += pPath;
  }
  // add a separator between a UNC drive and a non-absolute path
  if (resultPath && !resultRoot && resultDrive && !':\\/'.includes(resultDrive[resultDrive.length - 1])) {
    return resultDrive + '\\' + resultPath;
  }
  return resultDrive + resultRoot + resultPath;
}

function ntSplit(p) {
  const [d, r, rest] = ntSplitroot(p);
  let i = rest.length;
  while (i && !isNtSep(rest[i - 1])) i--;
  const head = rest.slice(0, i), tail = rest.slice(i);
  return [d + r + head.replace(/[\\/]+$/, ''), tail];
}

function ntNormpath(path) {
  if (path === '') return '.';
  const [drive, root, rest] = ntSplitroot(path.replaceAll('/', '\\'));
  const comps = [];
  for (const comp of rest.split('\\')) {
    if (comp === '' || comp === '.') continue;
    if (comp !== '..') comps.push(comp);
    else if (comps.length && comps[comps.length - 1] !== '..') comps.pop();
    else if (!root) comps.push(comp);
  }
  return (drive + root + comps.join('\\')) || '.';
}

export const win32 = {
  name: 'win32', sep: '\\',
  // ntpath.isabs of 3.12 (UNC, device, drive plus root, and the legacy "\x" / "/x" case).
  isabs: (p) => {
    const s = p.slice(0, 3).replaceAll('/', '\\');
    return s.startsWith('\\') || s.slice(1).startsWith(':\\');
  },
  join: ntJoin, split: ntSplit, dirname: (p) => ntSplit(p)[0], normpath: ntNormpath,
  splitdrive: (p) => { const [d, r, rest] = ntSplitroot(p); return [d, r + rest]; },
  exists, isdir,
  makedirs: (name) => makedirs(name, win32),
};

/** The path flavour for a process.platform value. */
export const flavourFor = (platform = process.platform) => (platform === 'win32' ? win32 : posix);

export { toPyOSError };
