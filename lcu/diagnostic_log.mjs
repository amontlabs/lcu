// Where the adapters' local diagnostic log lives and its retention policy (mirrors adapters/diagnostics.mjs).
// Port of lcu/diagnostic_log.py (LCU 0.9.5). Keyword parameters of the Python (env, platform, home) stay positional,
// as there. Paths are strings with pathlib's spelling (Path('/o') -> '/o'; Windows hosts use the win32 flavour).
import nodePath from 'node:path';

import { pathExpanduser, pathStr } from './compat/pathlib.mjs';

export const RETENTION_DAYS = 7;
export const MAX_TOTAL_MB = 20;
export const MAX_FILE_MB = 2;

const join = (...parts) => (process.platform === 'win32' ? nodePath.win32.join(...parts) : pathStr(...parts));

/** The log directory: LCU_LOG_DIR, else the platform's per-user log or state directory. */
export function directory(env = null, platform = null, home = null) {
  env = env === null ? process.env : env;
  platform = platform === null ? process.platform : platform;
  home = home === null ? pathExpanduser('~') : join(String(home));
  if (env.LCU_LOG_DIR) return join(env.LCU_LOG_DIR);
  if (platform === 'darwin') return join(home, 'Library/Logs/LCU');
  return join(env.XDG_STATE_HOME || join(home, '.local/state'), 'lcu/logs');
}

export function enabled(env = null) {
  return (env === null ? process.env : env).LCU_DIAGNOSTIC_LOG !== '0';
}

/** Machine-readable diagnostic log settings for `lcu status --json` (key order as in Python). */
export function status(env = null, platform = null, home = null) {
  return {
    dir: directory(env, platform, home), enabled: enabled(env), retention_days: RETENTION_DAYS,
    max_total_mb: MAX_TOTAL_MB, max_file_mb: MAX_FILE_MB,
  };
}

/** One line naming the directory and the policy, for `lcu status` and `lcu doctor`. */
export function summary(env = null, platform = null, home = null) {
  const state = status(env, platform, home);
  if (!state.enabled) return 'Diagnostic log: off (LCU_DIAGNOSTIC_LOG=0).';
  return `Diagnostic log: ${state.dir} (metadata only; kept ${RETENTION_DAYS} days, ` +
    `at most ${MAX_TOTAL_MB} MB in total and ${MAX_FILE_MB} MB per file; LCU_DIAGNOSTIC_LOG=0 turns it off).`;
}
