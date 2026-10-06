// Run a child and capture its output through files rather than pipes.
// Port of lcu/capture.py.
//
// Node writes to pipes asynchronously on macOS, so a CLI that prints and then calls
// `process.exit()` loses everything past the 64 KiB pipe buffer. File writes are
// synchronous on every platform, so the whole output survives the exit.
import { accessSync, closeSync, constants as fsConstants, fstatSync, readSync, statSync, unlinkSync } from 'node:fs';
import { spawnSync } from './compat/spawn.mjs';
import { constants } from 'node:os';

import { mkstemp } from './compat/tempfile.mjs';
import { fromNodeError, timeoutExpired } from './compat/pyerr.mjs';
import { TimeoutExpired } from './compat/subprocess.mjs';

// Read a whole file from offset 0 (the child shares the descriptor's offset, so Python's seek(0)).
function readAll(fd) {
  const size = fstatSync(fd).size;
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, buffer, offset, size - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset).toString('utf8');
}

// subprocess.TemporaryFile: an unnamed file (created O_EXCL in the temp dir, then unlinked).
function temporaryFile() {
  const { fd, path } = mkstemp();
  unlinkSync(path);
  return fd;
}

// Why chdir(cwd) would fail (ENOENT, ENOTDIR, ELOOP, EACCES...), or null.
function enter_failure(cwd) {
  try {
    if (!statSync(cwd).isDirectory()) return Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    accessSync(cwd, fsConstants.X_OK);
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * subprocess.run with stdout and stderr read back from temporary files, as text.
 * `timeout` is in SECONDS here, as in Python. Other options: {cwd, env}. Returns
 * {args, returncode, stdout, stderr}; returncode is -N when the child died on signal N.
 */
export function run(argv, { timeout = null, cwd, env } = {}) {
  const out = temporaryFile();
  let err;
  try {
    err = temporaryFile();
    try {
      const options = { stdio: ['ignore', out, err], killSignal: 'SIGKILL' };
      if (cwd !== undefined) options.cwd = cwd;
      if (env !== undefined) options.env = env;
      // spawnSync treats 0 as "no timeout"; Python's deadline is already over: the child starts and is killed
      // unless it has already exited (review port-runtime #10).
      if (timeout !== null) options.timeout = Math.max(1, timeout * 1000);
      const result = spawnSync(argv[0], argv.slice(1), options);
      if (result.error) {
        if (result.error.code === 'ETIMEDOUT') {
          // Python reports the remaining time of its deadline (a float a little below `timeout`); not reproducible.
          const expired = new TimeoutExpired(argv, timeout * 1000);
          expired.message = timeoutExpired(argv, timeout, { float: true });
          throw expired;
        }
        // The child changes directory before exec, so a cwd that cannot be entered is what Python reports.
        const cwd_failure = cwd === undefined ? null : enter_failure(cwd);
        if (cwd_failure) throw fromNodeError(cwd_failure, { filename: cwd }) ?? cwd_failure;
        throw fromNodeError(result.error, { filename: argv[0] }) ?? result.error;
      }
      const returncode = result.status ?? -(constants.signals[result.signal] ?? 0);
      return {
        args: argv,
        returncode,
        stdout: readAll(out),
        stderr: readAll(err),
      };
    } finally {
      closeSync(err);
    }
  } finally {
    closeSync(out);
  }
}
