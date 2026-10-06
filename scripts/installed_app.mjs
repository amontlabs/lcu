// Select the locally installed ChatGPT Linux application in place.
// Port of scripts/installed_app.py. `_download` (the pinned development/test package fetcher used by tests/run.sh
// through Python) is not ported: the installer never calls it (see .port/notes/installers.md).
import { statSync } from 'node:fs';

import { runProcess } from '../lcu/compat/runas.mjs';
import { ValueError } from '../lcu/compat/pyjson.mjs';
import { pathExpanduser } from '../lcu/compat/pathlib.mjs';
import { LINUX_APP_PATH, resolve_installed_linux_app } from '../lcu/platforms.mjs';
import { app_prerequisite_message } from '../lcu/setup.mjs';

export const DEFAULT_APP_PATH = LINUX_APP_PATH;

/** Injection points for tests (Python's mock.patch targets). */
export const internals = {
  getuid: () => process.getuid(), runProcess, resolve_installed_linux_app, default_app_path: DEFAULT_APP_PATH,
};

const isDir = (path) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

/** subprocess.run(command, **options) as `account` (HOME/USER/LOGNAME, cwd=home, supplementary groups). */
export function _run_as(command, account = null, options = {}) {
  if (account === null || account === undefined) return internals.runProcess(command, options);
  const env = { ...process.env, HOME: account.pw_dir, USER: account.pw_name, LOGNAME: account.pw_name };
  const settings = { ...options, env };
  if (settings.cwd === undefined) settings.cwd = account.pw_dir;
  if (internals.getuid() === 0 && account.pw_uid !== 0) {
    settings.account = account;
  } else if (internals.getuid() !== account.pw_uid) {
    throw new ValueError(`Cannot validate the application as ${account.pw_name} from this account`);
  }
  return internals.runProcess(command, settings);
}

/** Validate the installed app where it is and describe the observed version and runtime. */
export function select(arch, { existing_app = null, account = null, execute = true } = {}) {
  const location = existing_app !== null && existing_app !== undefined
    ? pathExpanduser(String(existing_app)) : internals.default_app_path;
  if (!isDir(location)) {
    throw new ValueError(app_prerequisite_message(location, { alternate_location: true }));
  }
  const selected = internals.resolve_installed_linux_app(location, {
    arch, trusted_uids: account !== null && account !== undefined ? new Set([account.pw_uid]) : null,
  });
  if (execute) {
    _run_as([`${selected.runtime}/bin/node`, '--version'], account, { check: true, capture: true, timeout: 20000 });
    _run_as([`${selected.runtime}/bin/node_repl`, '--help'], account, { check: true, stdout: 'devnull', timeout: 20000 });
    _run_as([String(selected.codex_cli), '--version'], account, { check: true, capture: true, timeout: 20000 });
  }
  return [selected.app, {
    package_version: selected.version, runtime: selected.runtime_version, architecture: arch,
  }];
}
