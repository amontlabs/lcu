// The PureWindowsPath / ntpath behaviours LCU's Windows code paths use, so a Node port selects the same
// paths Python's pathlib selects on Windows (fixture-tested only; no live Windows claim):
//   str(PureWindowsPath(*parts)), .is_absolute(), .parent, .name, os.path.relpath(path, start) (incl. the
//   cross-drive ValueError), .as_posix(). Drive letters and UNC shares are kept as written.
import { win32 } from 'node:path';

import { ValueError } from './pyjson.mjs';

const SEP = /[\\/]+/;

/** [drive, root, parts] of a Windows path, like ntpath.splitroot + component split. */
export function splitWin(text) {
  const p = text.replaceAll('/', '\\');
  let drive = '';
  let rest = p;
  const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(p);
  if (unc) {
    drive = unc[0];
    rest = p.slice(unc[0].length);
  } else if (/^[A-Za-z]:/.test(p)) {
    drive = p.slice(0, 2);
    rest = p.slice(2);
  }
  // A UNC share always has a root (str(PureWindowsPath('\\\\server\\share')) ends with a separator).
  const root = rest.startsWith('\\') || unc ? '\\' : '';
  const parts = rest.split(SEP).filter((part) => part !== '' && part !== '.');
  return [drive, root, parts];
}

/** str(PureWindowsPath(*parts)) */
export function winPathStr(...pieces) {
  let drive = '';
  let root = '';
  let parts = [];
  for (const piece of pieces) {
    if (piece === '') continue;
    const [d, r, ps] = splitWin(piece);
    if (r) {
      // An absolute piece replaces everything, keeping the previous drive when it has none.
      if (d || !drive) drive = d || drive;
      root = r;
      parts = ps;
    } else if (d && d.toLowerCase() !== drive.toLowerCase()) {
      drive = d;
      root = '';
      parts = ps;
    } else {
      parts = [...parts, ...ps];
    }
  }
  const text = drive + root + parts.join('\\');
  return text || '.';
}

/** PureWindowsPath(p).is_absolute(): a drive (or UNC share) AND a root. */
export function winIsAbsolute(text) {
  const [drive, root] = splitWin(text);
  return Boolean(drive && (root || drive.startsWith('\\\\')));
}

/** PureWindowsPath(p).parent */
export function winParent(text) {
  const [drive, root, parts] = splitWin(winPathStr(text));
  if (!parts.length) return drive + root || '.';
  return drive + root + parts.slice(0, -1).join('\\') || '.';
}

/** PureWindowsPath(p).name */
export function winName(text) {
  const [, , parts] = splitWin(winPathStr(text));
  return parts.length ? parts.at(-1) : '';
}

/** os.path.relpath(path, start) on Windows (both absolute here). */
export function winRelpath(target, start) {
  const [d1] = splitWin(target);
  const [d2] = splitWin(start);
  if (d1.toLowerCase() !== d2.toLowerCase()) {
    throw new ValueError(`path is on mount '${d1}', start on mount '${d2}'`);
  }
  return win32.relative(start, target) || '.';
}

/** PureWindowsPath(p).as_posix() */
export const winAsPosix = (text) => text.replaceAll('\\', '/');
