// tempfile.mkstemp / tempfile.mkdtemp equivalents with Python's observable behaviour:
//   * names are `prefix + 8 random characters from [a-z0-9_] + suffix` (Node's fs.mkdtemp appends 6, so it
//     is not used);
//   * mkstemp opens with O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW and mode 0600; mkdtemp creates mode 0700;
//   * the result path is `dir/name` with `dir` taken as given (Python makes it absolute with os.path.abspath).
// Collisions retry up to 10000 times like Python (FileExistsError is then raised).
// Without `dir`, the directory is gettempdir(): Python's search (TMPDIR, TEMP, TMP, /tmp, /var/tmp, /usr/tmp,
// then the current directory), taking the first one where a probe file can be created, written and removed,
// cached for the process like tempfile.tempdir (os.tmpdir() would use TMPDIR even when it is unusable).
import { closeSync, constants, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { win32 } from 'node:path';

import { abspath } from './pypath.mjs';
import { expanduser } from './pathlib.mjs';

// Windows hosts: names are joined with the host separator (os.path.join) and the candidate list is CPython's for nt.
const windowsHost = () => process.platform === 'win32';
const joinPath = (dir, name) => (windowsHost() ? win32.join(dir, name) : `${dir.replace(/\/+$/, '')}/${name}`);

const CHARACTERS = 'abcdefghijklmnopqrstuvwxyz0123456789_';
const TMP_MAX = 10000;
const { O_CREAT, O_EXCL, O_NOFOLLOW = 0, O_RDWR } = constants;

function candidate(prefix, suffix) {
  let name = '';
  for (let i = 0; i < 8; i++) name += CHARACTERS[randomInt(CHARACTERS.length)];
  return prefix + name + suffix;
}

function candidateTempdirList(env) {
  const list = [];
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) if (env[name]) list.push(env[name]);
  if (windowsHost()) {
    list.push(expanduser('~\\AppData\\Local\\Temp', { env }), `${env.SYSTEMROOT ?? '%SYSTEMROOT%'}\\Temp`, 'c:\\temp',
      'c:\\tmp', '\\temp', '\\tmp');
  } else {
    list.push('/tmp', '/var/tmp', '/usr/tmp');
  }
  try {
    list.push(process.cwd());
  } catch {
    list.push('.');
  }
  return list;
}

let cachedTempdir = null;

/** tempfile.gettempdir() (cached for the process, like tempfile.tempdir). */
export function gettempdir(env = process.env) {
  if (cachedTempdir !== null) return cachedTempdir;
  const dirlist = candidateTempdirList(env);
  for (let dir of dirlist) {
    if (dir !== '.') dir = abspath(dir);
    for (let seq = 0; seq < 100; seq++) {
      const filename = windowsHost() ? win32.join(dir, candidate('', ''))
        : `${dir.replace(/\/+$/, '') || '/'}/${candidate('', '')}`.replace(/^\/\//, '/');
      let fd;
      try {
        fd = openSync(filename, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        break; // PermissionError or any other OSError: next candidate
      }
      try {
        try {
          writeSync(fd, Buffer.from('blat'));
        } finally {
          closeSync(fd);
        }
      } catch {
        try {
          unlinkSync(filename);
        } catch { /* ignore */ }
        break;
      }
      try {
        unlinkSync(filename);
      } catch {
        break;
      }
      cachedTempdir = dir;
      return dir;
    }
  }
  const shown = `[${dirlist.map((d) => `'${d.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ')}]`;
  const error = new Error(`[Errno 2] No usable temporary directory found in ${shown}`);
  error.code = 'ENOENT';
  error.name = 'FileNotFoundError';
  throw error;
}

/** Test hook: forget the cached directory (tempfile.tempdir = None). */
export function _resetTempdir() {
  cachedTempdir = null;
}

/** Returns {fd, path}; the caller owns (and must close) the descriptor. */
export function mkstemp({ suffix = '', prefix = 'tmp', dir = null } = {}) {
  const directory = abspath(dir ?? gettempdir());
  for (let attempt = 0; attempt < TMP_MAX; attempt++) {
    const path = joinPath(directory, candidate(prefix, suffix));
    try {
      return { fd: openSync(path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600), path };
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
  }
  const error = new Error('[Errno 17] No usable temporary file name found');
  error.code = 'EEXIST';
  throw error;
}

export function mkdtemp({ suffix = '', prefix = 'tmp', dir = null } = {}) {
  const directory = abspath(dir ?? gettempdir());
  for (let attempt = 0; attempt < TMP_MAX; attempt++) {
    const path = joinPath(directory, candidate(prefix, suffix));
    try {
      mkdirSync(path, 0o700);
      return path;
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
  }
  const error = new Error('[Errno 17] No usable temporary directory name found');
  error.code = 'EEXIST';
  throw error;
}
