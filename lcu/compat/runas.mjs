// Synchronous subprocess.run(...), optionally as another account, for the installer (scripts/install.py
// validate_release and scripts/installed_app.py _run_as):
//   subprocess.run(cmd, [user=uid, group=gid, extra_groups=os.getgrouplist(name, gid),] env=, cwd=, check=,
//                  timeout=, stdout=DEVNULL | capture_output=True, text=True)
// Thin layer over the shared helpers, so the Python process semantics live in one place:
//   * no account: compat/subprocess.mjs run() (exec-format check, strict UTF-8 + universal newlines, errors);
//     the stdout=DEVNULL form, which run() does not offer, applies the same exec-format check itself;
//   * account: compat/accounts.mjs spawnAsSync() (its child does chdir -> initgroups -> setgid -> setuid -> execve,
//     reporting failures with Python's text), plus the same exec-format check and text decoding.
//
// runProcess(cmd, {env, cwd, stdout, capture, timeout, check, account})
//   stdout   'inherit' (default) | 'devnull' (subprocess.DEVNULL)
//   capture  capture_output=True with text=True
//   timeout  milliseconds; SIGKILL + TimeoutExpired as Python does
//   check    CalledProcessError on a non-zero status
//   account  drop to it (root running for a different account); null = run as is
import { spawnSync } from './spawn.mjs';
import { constants } from 'node:os';

import { spawnAsSync } from './accounts.mjs';
import { chdirFailure, fromNodeError } from './pyerr.mjs';
import { CalledProcessError, execFormatError, run, textOf, TimeoutExpired } from './subprocess.mjs';

// TextIOWrapper(newline=None, errors='strict') on captured bytes, as subprocess.mjs does.

function finish(cmd, result, { cwd, timeout, check, capture }) {
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') throw new TimeoutExpired(cmd, timeout);
    const failure = cwd === undefined ? null : chdirFailure(String(cwd));
    if (failure) throw fromNodeError({ code: failure }, { filename: cwd });
    throw fromNodeError(result.error, { filename: cmd[0] }) ?? result.error;
  }
  const returncode = result.status ?? -(constants.signals[result.signal] ?? 0);
  const stdout = capture ? textOf(result.stdout ?? Buffer.alloc(0)) : null;
  const stderr = capture ? textOf(result.stderr ?? Buffer.alloc(0)) : null;
  if (check && returncode) throw new CalledProcessError(returncode, cmd, stdout, stderr);
  return { args: cmd, returncode, stdout, stderr };
}

export function runProcess(cmd, { env, cwd, stdout = 'inherit', capture = false, timeout, check = false, account = null } = {}) {
  if (!account && (capture || stdout !== 'devnull')) {
    return run(cmd, { env, cwd, capture, timeout, check });
  }
  const formatError = execFormatError(cmd, env, { cwd });
  if (formatError) throw formatError;
  const stdio = ['inherit', capture ? 'pipe' : stdout === 'devnull' ? 'ignore' : 'inherit', capture ? 'pipe' : 'inherit'];
  const options = { killSignal: 'SIGKILL', maxBuffer: 1 << 30 };
  if (timeout !== undefined) options.timeout = Math.max(1, timeout);
  let result;
  if (account) {
    result = spawnAsSync(account, cmd[0], cmd, { env: env ?? process.env, cwd, stdio, ...options });
    if (result.spawnError && result.status === 126) {
      const report = result.spawnError;
      throw Object.assign(new Error(report.message), {
        name: /^(\w+Error): /.exec(report.text ?? '')?.[1] ?? 'OSError', code: report.code, errno: report.errno,
      });
    }
  } else {
    if (env !== undefined) options.env = env;
    if (cwd !== undefined) options.cwd = cwd;
    result = spawnSync(cmd[0], cmd.slice(1), { ...options, stdio });
  }
  return finish(cmd, result, { cwd, timeout, check, capture });
}
