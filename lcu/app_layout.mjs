// Locate the original Codex CLI files in a supported official app layout.
// Port of lcu/app_layout.py. Paths are absolute path strings (see .port/CONVENTIONS.md);
// CodexTools is a plain object {cli, code_mode_host}.
import { lstatSync, statSync } from 'node:fs';

import { ValueError } from './compat/pyjson.mjs';
import { pathStr } from './compat/pathlib.mjs';

const isSymlink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};
const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

// `components` are the parts of the file's path relative to `root` (Path.relative_to(root).parts).
function _regular_file(root, path, components) {
  if (isSymlink(path) || !isFile(path)) return false;
  let current = root;
  for (const component of components.slice(0, -1)) {
    current = pathStr(current, component);
    if (isSymlink(current) || !isDir(current)) return false;
  }
  return true;
}

/** Return a complete original CLI/host pair from one known resource layout. */
export function locate_codex_tools(resources, { windows = false } = {}) {
  resources = pathStr(resources);
  const suffix = windows ? '.exe' : '';
  // Path('.') and Path('codex-cli/bin'), as component lists relative to `resources`.
  const relative_bases = [[], ['codex-cli', 'bin']];
  const matches = [];
  for (const relative of relative_bases) {
    const cli = pathStr(resources, ...relative, `codex${suffix}`);
    const host = pathStr(resources, ...relative, `codex-code-mode-host${suffix}`);
    if (_regular_file(resources, cli, [...relative, `codex${suffix}`]) &&
        _regular_file(resources, host, [...relative, `codex-code-mode-host${suffix}`])) {
      matches.push({ cli, code_mode_host: host });
    }
  }
  if (matches.length > 1) {
    throw new ValueError(`Ambiguous original Codex CLI layout in application resources: ${resources}`);
  }
  if (matches.length === 0) {
    throw new ValueError(`Application is missing a complete original Codex CLI layout: ${resources}`);
  }
  return matches[0];
}
