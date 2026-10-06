// shutil.which(cmd, path=...) of Python 3.12 with mode F_OK | X_OK, both platform branches:
//   which(cmd, path, env, { platform, check })
//     path      the search path string, or null/undefined for os.environ.get('PATH'); when that is unset too:
//               confstr('CS_PATH') = "/usr/bin:/bin" on POSIX, os.defpath = ".;C:\\bin" on Windows.
//     env       stands for os.environ (PATH default, PATHEXT, NoDefaultCurrentDirectoryInExePath).
//     platform  'win32' selects ntpath splitting/joining, PATHEXT and the current-directory lookup
//               (_winapi.NeedCurrentDirectoryForExePath: the current directory is searched first unless
//               NoDefaultCurrentDirectoryInExePath is set); anything else is POSIX.
//     check     the _access_check(name) predicate (tests inject it for Windows fixtures).
//   Returns the joined path string (as Python builds it, not normalised) or null.
// A command with a directory part is looked up only there (relative to the current directory).
import { accessSync, constants, existsSync, statSync } from 'node:fs';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC';

// os.path.split
function splitPosix(cmd) {
  const i = cmd.lastIndexOf('/');
  let head = cmd.slice(0, i + 1);
  const tail = cmd.slice(i + 1);
  if (head && head !== '/'.repeat(head.length)) head = head.replace(/\/+$/, '');
  return [head, tail];
}

function splitWindows(cmd) {
  let drive = '';
  let rest = cmd;
  const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.exec(cmd);
  if (unc) {
    drive = unc[0];
    rest = cmd.slice(drive.length);
  } else if (/^[A-Za-z]:/.test(cmd)) {
    drive = cmd.slice(0, 2);
    rest = cmd.slice(2);
  }
  let i = rest.length;
  while (i && !'\\/'.includes(rest[i - 1])) i--;
  let head = rest.slice(0, i);
  const tail = rest.slice(i);
  const stripped = head.replace(/[\\/]+$/, '');
  head = stripped || head;
  return [drive + head, tail];
}

// os.path.join(dir, file) for a file name without a drive or root
function joinPosix(dir, file) {
  if (dir === '' || dir.endsWith('/')) return dir + file;
  return `${dir}/${file}`;
}

function joinWindows(dir, file) {
  if (dir === '' || '\\/'.includes(dir.at(-1)) || /^[A-Za-z]:$/.test(dir)) return dir + file;
  return `${dir}\\${file}`;
}

function accessCheck(name) {
  try {
    if (!existsSync(name)) return false;
    accessSync(name, constants.X_OK);
    return !statSync(name).isDirectory();
  } catch {
    return false;
  }
}

export function which(cmd, path = null, env = process.env, { platform = process.platform, check = accessCheck } = {}) {
  const win = platform === 'win32';
  const [dirname, base] = (win ? splitWindows : splitPosix)(cmd);
  let dirs;
  if (dirname) {
    dirs = [dirname];
  } else {
    if (path === null || path === undefined) {
      path = env.PATH;
      if (path === undefined) path = win ? '.;C:\\bin' : '/usr/bin:/bin';
    }
    if (!path) return null;
    dirs = path.split(win ? ';' : ':');
    if (win && !Object.hasOwn(env, 'NoDefaultCurrentDirectoryInExePath')) dirs.unshift('.');
  }
  let files = [base];
  if (win) {
    const pathext = (env.PATHEXT || DEFAULT_PATHEXT).split(';').filter(Boolean).map((ext) => ext.replace(/\.+$/, ''));
    files = pathext.map((ext) => base + ext);
    if (pathext.some((ext) => base.toUpperCase().endsWith(ext.toUpperCase()))) files.unshift(base);
  }
  const seen = new Set();
  for (const dir of dirs) {
    const normdir = win ? dir.replaceAll('/', '\\').toLowerCase() : dir;
    if (seen.has(normdir)) continue;
    seen.add(normdir);
    for (const file of files) {
      const name = (win ? joinWindows : joinPosix)(dir, file);
      if (check(name)) return name;
    }
  }
  return null;
}
