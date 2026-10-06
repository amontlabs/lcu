// subprocess.run equivalent (synchronous) with Python's exception model, for the modules that catch
// `(OSError, ValueError, subprocess.SubprocessError)`.
//
//   run(cmd, {env, cwd, stdin, capture, timeout, check, input, text, errors})
//     cmd      argv array (never a shell string)
//     stdin    'devnull' (subprocess.DEVNULL) | 'inherit' (default, like Python) | 'pipe' with `input`
//     capture  capture_output=True
//     text     true (default; Python text=True): captured output is decoded as UTF-8 and universal newlines are
//              applied (CRLF and CR become LF), exactly like TextIOWrapper; false: Buffers, untouched
//     errors   'strict' (default, Python's default: undecodable output raises UnicodeDecodeError, a ValueError,
//              stdout checked before stderr) | 'replace' (U+FFFD, as errors='replace')
//     timeout  milliseconds (Python seconds * 1000); on expiry the child is killed with SIGKILL and
//              TimeoutExpired is thrown, as Python does
//     check    CalledProcessError on a non-zero exit
//   Spawn failures throw an OSError rendered as Python's ("[Errno 2] No such file or directory: 'x'").
//
// Returns {args, returncode, stdout, stderr}; returncode is -N when the child died on signal N.
//
// Exec format: Python's _posixsubprocess execs the program with execve(2), so a file that is neither a binary
// nor a #! script fails with "[Errno 8] Exec format error: '<argv0>'". libuv's spawn retries such a file
// through /bin/sh (glibc execvp's ENOEXEC fallback), which would RUN its text. execFormatError() predicts that
// case with compat/execve's preflight and run()/app_server's popen raise Python's error instead (POSIX only).
import { spawnSync } from './spawn.mjs';
import { existsSync as exists } from 'node:fs';
import { constants } from 'node:os';

import { calledProcessError, chdirFailure, fromNodeError, isOSError, timeoutExpired } from './pyerr.mjs';
import { decode as decodeStrict } from './utf8.mjs';
import { execError, preflight } from './execve.mjs';
import { which } from './which.mjs';

/** subprocess.SubprocessError */
export class SubprocessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SubprocessError';
  }
}

/** subprocess.TimeoutExpired */
export class TimeoutExpired extends SubprocessError {
  constructor(cmd, timeout) {
    super(timeoutExpired(cmd, timeout / 1000));
    this.name = 'TimeoutExpired';
    this.cmd = cmd;
    this.timeout = timeout / 1000;
  }
}

/** subprocess.CalledProcessError */
export class CalledProcessError extends SubprocessError {
  constructor(returncode, cmd, stdout = null, stderr = null) {
    super(calledProcessError(returncode, cmd));
    this.name = 'CalledProcessError';
    this.returncode = returncode;
    this.cmd = cmd;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** `except OSError`: the single classifier of compat/pyerr.mjs (re-exported for the historical import path). */
export { isOSError };

// TextIOWrapper(newline=None) on captured bytes: decode, then translate CRLF/CR to LF.
export function textOf(buffer, errors) {
  const text = errors === 'replace' ? new TextDecoder('utf-8').decode(buffer) : decodeStrict(buffer);
  return text.replace(/\r\n?/g, '\n');
}

/**
 * The OSError Python's subprocess raises when argv[0] would fail execve(2) with ENOEXEC, or null.
 * argv[0] without a slash is looked up on env.PATH (os.environ PATH when env is undefined), as Python does.
 */
export function execFormatError(cmd, env, { platform = process.platform, cwd } = {}) {
  if (platform === 'win32' || typeof cmd[0] !== 'string') return null;
  let file = cmd[0].includes('/') ? cmd[0] : which(cmd[0], (env ?? process.env).PATH ?? null);
  if (!file) return null;
  if (!file.startsWith('/')) file = `${cwd ?? process.cwd()}/${file}`;
  let failure;
  try {
    failure = preflight(file, cmd, env ?? process.env, { platform });
  } catch {
    return null; // argument validation errors are reported by spawn itself
  }
  return failure === 'ENOEXEC' ? execError('ENOEXEC', cmd[0]) : null;
}

export function run(cmd, { env, cwd, stdin = 'inherit', capture = false, timeout, check = false, input, text = true,
  errors = 'strict' } = {}) {
  const options = {
    stdio: [stdin === 'devnull' ? 'ignore' : stdin === 'pipe' ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit',
      capture ? 'pipe' : 'inherit'],
    killSignal: 'SIGKILL',
    maxBuffer: 1 << 30,
  };
  if (env !== undefined) options.env = env;
  if (cwd !== undefined) options.cwd = cwd;
  // spawnSync treats 0 as "no timeout"; Python's deadline is already over: the child starts and is killed unless it
  // has already exited (review port-runtime #10 / round-2 F8).
  if (timeout !== undefined) options.timeout = Math.max(1, timeout);
  if (input !== undefined) options.input = input;
  const formatError = execFormatError(cmd, env, { cwd });
  if (formatError) throw formatError;
  const result = spawnSync(cmd[0], cmd.slice(1), options);
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') throw new TimeoutExpired(cmd, timeout);
    // The child enters cwd before exec, so a cwd it cannot enter is what Python reports (round-2 F7).
    const failure = cwd === undefined ? null : chdirFailure(String(cwd));
    if (failure) throw fromNodeError({ code: failure }, { filename: cwd });
    throw fromNodeError(result.error, { filename: cmd[0] }) ?? result.error;
  }
  const returncode = result.status ?? -(constants.signals[result.signal] ?? 0);
  const empty = Buffer.alloc(0);
  const stdout = capture ? (text ? textOf(result.stdout ?? empty, errors) : result.stdout ?? empty) : null;
  const stderr = capture ? (text ? textOf(result.stderr ?? empty, errors) : result.stderr ?? empty) : null;
  if (check && returncode) throw new CalledProcessError(returncode, cmd, stdout, stderr);
  return { args: cmd, returncode, stdout, stderr };
}
