// pathlib flavour seam for modules whose Python used Path on the host OS (PurePosixPath on Linux/macOS,
// PureWindowsPath on Windows), plus a filesystem facade that maps those paths to the host filesystem.
//
//   const F = flavour({ windows: () => bool, native: { to(path) -> host path, from(host path) -> path } })
//
//   F.str(p) F.join(...) F.parent(p) F.name(p)       str(Path), Path / ..., .parent, .name of the flavour
//   F.key(p) F.same(a, b)                            Path equality (Windows: case-insensitive, either separator)
//   F.isAbsolute(p) F.absolute(p) F.resolve(p)       Path.is_absolute(), .absolute(), .resolve() (non-strict)
//   F.isRelativeTo(p, base) F.asUri(p)               PurePath.is_relative_to(), Path.as_uri()
//   F.fs.<fn>(path, ...)                             node:fs functions with path arguments mapped through native.to
//
// `native` is the identity in production (the flavour is the host's own). Tests on a POSIX host select the Windows
// flavour and map a fake drive (`C:\...`) to a temporary directory, so Windows-shaped paths exercise the same code
// path selection, joins, parents and comparisons Python's PureWindowsPath code would (fixture only: no live Windows
// claim; Windows-only filesystem semantics such as junctions or case-insensitive lookups are not emulated).
import * as nodeFs from 'node:fs';

import { absolute as posixAbsolute, asUri as posixAsUri, pathStr, resolve as posixResolve } from './pathlib.mjs';
import { ValueError } from './pyjson.mjs';
import { splitWin, winIsAbsolute, winName, winParent, winPathStr } from './winpath.mjs';

export const IDENTITY = Object.freeze({ to: (path) => path, from: (path) => path });

function posixParent(path) {
  const text = pathStr(path);
  const cut = text.lastIndexOf('/');
  if (cut < 0) return '.';
  return cut === 0 ? '/' : text.slice(0, cut);
}

function windowsAsUri(path) {
  const text = winPathStr(String(path));
  if (!winIsAbsolute(text)) throw new ValueError("relative path can't be expressed as a file URI");
  const [drive] = splitWin(text);
  const posix = text.replaceAll('\\', '/');
  const [prefix, rest] = drive.length === 2 && drive[1] === ':' ? [`file:///${drive}`, posix.slice(2)] : ['file:', posix];
  let out = prefix;
  for (const byte of Buffer.from(rest, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.\-~/]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

const PATH_ARGS = {
  accessSync: [0], chmodSync: [0], closeSync: [], copyFileSync: [0, 1], fsyncSync: [], lstatSync: [0], mkdirSync: [0],
  openSync: [0], readdirSync: [0], readFileSync: [0], readlinkSync: [0], renameSync: [0, 1], rmSync: [0],
  rmdirSync: [0], statSync: [0], symlinkSync: [1], unlinkSync: [0], utimesSync: [0], writeFileSync: [0],
  writeSync: [], mkdtempSync: [0],
};

export function flavour({ windows = () => process.platform === 'win32', native = () => IDENTITY } = {}) {
  const W = () => windows();
  const to = (path) => native().to(String(path));
  const from = (path) => native().from(String(path));
  const F = {
    get windows() { return W(); },
    native: (path) => to(path),
    str: (path) => (W() ? winPathStr(String(path)) : pathStr(String(path))),
    join: (...parts) => (W() ? winPathStr(...parts.map(String)) : pathStr(...parts.map(String))),
    parent: (path) => (W() ? winParent(String(path)) : posixParent(path)),
    name: (path) => (W() ? winName(String(path)) : pathStr(String(path)).split('/').at(-1)),
    key: (path) => (W() ? winPathStr(String(path)).toLowerCase() : pathStr(String(path))),
    same: (a, b) => F.key(a) === F.key(b),
    isAbsolute: (path) => (W() ? winIsAbsolute(String(path)) : pathStr(String(path)).startsWith('/')),
    absolute: (path) => {
      if (!W()) return posixAbsolute(String(path));
      return winIsAbsolute(String(path)) ? winPathStr(String(path)) : winPathStr(from(process.cwd()), String(path));
    },
    resolve: (path) => {
      if (!W()) {
        const host = to(F.str(path));
        return host === F.str(path) ? posixResolve(path) : from(posixResolve(host));
      }
      try {
        return winPathStr(from(nodeFs.realpathSync.native(to(F.absolute(path)))));
      } catch {
        return F.absolute(path);
      }
    },
    realpath: (path) => from(nodeFs.realpathSync(to(path))),
    isRelativeTo: (path, base) => {
      const p = F.key(path);
      const b = F.key(base);
      const sep = W() ? '\\' : '/';
      return p === b || p.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
    },
    asUri: (path) => (W() ? windowsAsUri(path) : posixAsUri(String(path))),
    fs: {},
  };
  for (const [name, indexes] of Object.entries(PATH_ARGS)) {
    F.fs[name] = (...args) => {
      for (const index of indexes) if (typeof args[index] === 'string') args[index] = to(args[index]);
      const result = nodeFs[name](...args);
      return name === 'mkdtempSync' ? from(result) : result;
    };
  }
  return F;
}
