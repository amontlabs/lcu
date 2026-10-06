// Install LCU's `lcu-approve` mod for Claude Code.
//
// The mod shows the computer-use runtime's per-app approval as a native pane (or
// question dialog) in the terminal and in the Claude app's Code tab, where the
// host cannot render the runtime's MCP form. It is a plugin folder under the
// `skills` directory, which Claude Code loads without a hot-reload question and
// watches for changes: `~/.claude/skills/lcu-approve` for user scope and
// `<project>/.claude/skills/lcu-approve` for project scope.
//
// Port of lcu/claude_mod.py. Paths are absolute path strings. `source_files` returns a Map from relative
// POSIX path strings (Python: relative Path objects) to Buffers, in Python's insertion order.
import {
  lstatSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync,
} from 'node:fs';
import { posix as path } from 'node:path';

import { pathStr } from './compat/pathlib.mjs';
import { winName, winParent, winPathStr } from './compat/winpath.mjs';
import { compareCodePoints, dumps, loads, ValueError } from './compat/pyjson.mjs';
import { isOSError } from './compat/subprocess.mjs';
import { decode } from './compat/utf8.mjs';
import { Change, apply_changes, read_file } from './setup.mjs';

// `platform` selects pathlib's flavour (PosixPath / WindowsPath), as Python's Path does.
export const internals = { platform: process.platform };
const windows = () => internals.platform === 'win32';
const join = (...parts) => (windows() ? winPathStr(...parts) : pathStr(...parts));
const parent = (p) => (windows() ? winParent(p) : path.dirname(p));
const name = (p) => (windows() ? winName(p) : path.basename(p));

export const NAME = 'lcu-approve';
export const SOURCE = 'adapters/claude-mod/' + NAME;
export const MANIFEST = '.claude-plugin/plugin.json';
// Written beside the mod at install time: where the `lcu` command of this installation is.
export const CONFIG = 'lcu.json';

const ignorable = (error) => ['ENOENT', 'ENOTDIR', 'EBADF', 'ELOOP'].includes(error?.code);
function exists(file) {
  try {
    statSync(file);
    return true;
  } catch (error) {
    if (ignorable(error)) return false;
    throw error;
  }
}
function is_file(file) {
  try {
    return statSync(file).isFile();
  } catch (error) {
    if (ignorable(error)) return false;
    throw error;
  }
}
function is_dir(file) {
  try {
    return statSync(file).isDirectory();
  } catch (error) {
    if (ignorable(error)) return false;
    throw error;
  }
}
function is_symlink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch (error) {
    if (ignorable(error)) return false;
    throw error;
  }
}

// Path.rglob('*'): every entry below root as a path relative to it; a symlinked directory is listed, not entered.
function rglob(root) {
  const found = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      found.push(relative);
      if (entry.isDirectory()) walk(`${directory}/${entry.name}`, relative);
    }
  };
  walk(root, '');
  return found;
}

// Path ordering: lexicographic over the path components.
function comparePaths(a, b) {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return compareCodePoints(x[i], y[i]);
  }
  return x.length - y.length;
}
const sortedPaths = (items, reverse = false) => items.sort((a, b) => (reverse ? comparePaths(b, a) : comparePaths(a, b)));

/** Relative paths and contents of the mod shipped in a release. */
export function source_files(release_root) {
  const root = join(release_root, SOURCE);
  if (!is_file(join(root, MANIFEST))) {
    throw new ValueError(`LCU Claude mod missing: ${root}. Reinstall LCU into this release prefix, then rerun setup.`);
  }
  // The mod's own tests (run by `claude plugin test`) stay in the repository.
  const files = new Map();
  for (const relative of sortedPaths(rglob(root))) {
    if (is_file(join(root, relative)) && relative.split('/')[0] !== 'tests' && path.basename(relative) !== '.DS_Store') {
      files.set(relative, readFileSync(join(root, relative)));
    }
  }
  return files;
}

/** The stable `lcu` path of an installation: through `current` when the release sits in a prefix. */
export function lcu_command(release_root) {
  let root = join(release_root);
  if (name(parent(root)) === 'releases') root = join(parent(parent(root)), 'current');
  return join(root, 'bin', 'lcu');
}

export function destination(home, project = null) {
  const base = project ? join(project, '.claude') : join(home, '.claude');
  return join(base, 'skills', NAME);
}

/** True when the folder holds LCU's mod (never touch a plugin of that name that is not ours). */
export function _owned(folder) {
  try {
    const manifest = loads(decode(readFileSync(join(folder, MANIFEST))));
    return manifest instanceof Map && manifest.get('name') === NAME;
  } catch (error) {
    // OSError, ValueError (JSON/Unicode decode errors included); AttributeError is the non-dict case above.
    if (error instanceof ValueError || isOSError(error)) return false;
    throw error;
  }
}

/** Copy the mod into the selected scope's skills folder; returns the folder. */
export function install(home, release_root, { project = null } = {}) {
  const target = destination(home, project);
  if (exists(target) && !_owned(target)) {
    throw new ValueError(`${target} exists and is not the LCU mod; move it aside, then rerun setup.`);
  }
  const files = source_files(release_root);
  // The approved-apps panel runs `lcu apps`; this is where it finds the command.
  files.set(CONFIG, Buffer.from(dumps({ lcu: lcu_command(release_root) }, { indent: 2 }) + '\n'));
  const changes = [...files].map(([relative, data]) => new Change(join(target, relative), read_file(join(target, relative)), data));
  apply_changes(changes);
  // Drop files an earlier release shipped and this one does not.
  if (is_dir(target)) {
    for (const relative of sortedPaths(rglob(target), true)) {
      const entry = join(target, relative);
      if (is_file(entry) && !files.has(relative)) {
        unlinkSync(entry);
      } else if (is_dir(entry) && readdirSync(entry).length === 0) {
        rmdirSync(entry);
      }
    }
  }
  return target;
}

/** Remove the mod from the selected scope; returns whether anything was removed. */
export function remove(home, { project = null } = {}) {
  const target = destination(home, project);
  if (!exists(target)) return false;
  if (!_owned(target)) throw new ValueError(`${target} is not the LCU mod; left in place.`);
  for (const relative of sortedPaths(rglob(target), true)) {
    const entry = join(target, relative);
    if (is_symlink(entry) || is_file(entry)) unlinkSync(entry);
    else rmdirSync(entry);
  }
  rmdirSync(target);
  return true;
}
