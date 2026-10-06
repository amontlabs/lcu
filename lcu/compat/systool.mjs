// Trusted system tools for security-relevant lookups (account database, ACLs, locks).
//
// Python reaches these primitives through syscalls/libc; Node has to run a system tool. A tool chosen
// through PATH or an environment variable, or run with the caller's locale/output-control variables
// (POSIXLY_CORRECT, LC_*, LD_PRELOAD, DYLD_*, NODE_*, PYTHON*), would let restored caller data pick the
// code or the output format of a trust decision. So every helper here is
//   * resolved once among fixed system directories (never PATH, never an environment override), and
//     accepted only when the resolved file is a regular executable owned by root and not writable by
//     group or other (its directory likewise);
//   * run with a fixed minimal environment (TOOL_ENV) instead of process.env.
// Callers must treat a missing tool, a failed run or unparseable output as "unknown", never as a
// trusted answer.
//
// Tests replace a tool through `_testing.override(name, path)` (a module-level registry: nothing in the
// process environment can activate it).
import { spawnSync } from './spawn.mjs';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** Directories searched, in order. */
export const SYSTEM_DIRS = Object.freeze(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);

/** The whole environment a system helper sees. */
export const TOOL_ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', LANG: 'C' });

const overrides = new Map();
const cache = new Map();

/** Test-only seam (not reachable from the environment). */
export const _testing = Object.freeze({
  override(name, path) {
    overrides.set(name, path);
    cache.delete(name);
  },
  reset() {
    overrides.clear();
    cache.clear();
  },
});

function trustedFile(path) {
  try {
    const real = realpathSync(path);
    const info = statSync(real);
    if (!info.isFile() || info.uid !== 0 || info.mode & 0o022) return null;
    const dir = statSync(dirname(real));
    if (dir.uid !== 0 || dir.mode & 0o022) return null;
    accessSync(real, constants.X_OK);
    return path;
  } catch {
    return null;
  }
}

/**
 * Absolute path of system tool `name` (e.g. "getent"), or null when no trusted copy exists.
 * `dirs` narrows the search (e.g. ['/usr/bin'] for macOS-only tools).
 */
export function trustedTool(name, dirs = SYSTEM_DIRS) {
  if (overrides.has(name)) return overrides.get(name);
  const key = `${name}\0${dirs.join(':')}`;
  if (!cache.has(key)) {
    let found = null;
    for (const dir of dirs) {
      found = trustedFile(`${dir}/${name}`);
      if (found) break;
    }
    cache.set(key, found);
  }
  return cache.get(key);
}

/** spawnSync a trusted tool with TOOL_ENV (options.env is ignored on purpose). */
export function runTool(path, args, options = {}) {
  return spawnSync(path, args, { maxBuffer: 1 << 30, ...options, env: TOOL_ENV });
}
