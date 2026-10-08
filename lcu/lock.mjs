// Exclusive advisory lock on a file, held until `release()` or until this process exits.
//
// Node has no flock(2). On Linux and macOS a short-lived helper takes a flock(2) lock on a descriptor this
// process opened and passed to it as fd 3. The lock belongs to the open file description, which this process
// keeps open, so it stays held after the helper exits and is released when the descriptor closes. It is the
// same lock Python's fcntl.flock took, so an older release's `lcu prune` and this installer exclude each other.
// On Windows the file is opened with an exclusive sharing mode (libuv's UV_FS_O_EXLOCK), which fails while
// another process holds it.
const { closeSync, constants, openSync } = process.getBuiltinModule('node:fs');

const HELPERS = {
  // util-linux flock(1); `-n` fails at once instead of waiting.
  linux: (wait) => ['/usr/bin/flock', [...(wait ? [] : ['-n']), '-x', '3']],
  // macOS ships no flock(1); its Perl calls flock(2) on the inherited descriptor.
  darwin: (wait) => ['/usr/bin/perl', ['-MFcntl=:flock', '-e',
    `open(my $f, ">&=", 3) or exit 2; flock($f, LOCK_EX${wait ? '' : ' | LOCK_NB'}) or exit 1`]],
};
const UV_FS_O_EXLOCK = constants.UV_FS_O_EXLOCK ?? 0x10000000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Lock `path` (created if missing). With `wait` false, throws an Error with `code === 'ELOCKED'` when another
 * process holds it. Returns `{ release() }`.
 */
export function lockFile(path, { wait = true } = {}) {
  const { O_APPEND, O_CREAT, O_NOFOLLOW = 0, O_WRONLY } = constants;
  if (process.platform === 'win32') {
    for (;;) {
      try {
        const fd = openSync(path, O_WRONLY | O_CREAT | O_APPEND | UV_FS_O_EXLOCK);
        return { release: () => closeSync(fd) };
      } catch (error) {
        if (!['EBUSY', 'EACCES', 'EPERM'].includes(error.code)) throw error;
        if (!wait) throw Object.assign(new Error(`${path} is locked by another process`), { code: 'ELOCKED' });
      }
      sleep(250);
    }
  }
  const helper = HELPERS[process.platform];
  if (!helper) throw new Error(`File locks are not supported on ${process.platform}`);
  const fd = openSync(path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0o644);
  try {
    const [command, args] = helper(wait);
    const result = process.getBuiltinModule('node:child_process').spawnSync(command, args,
      { stdio: ['ignore', 'ignore', 'pipe', fd], env: { PATH: '/usr/bin:/bin' } });
    if (result.status === 1 && !wait) {
      throw Object.assign(new Error(`${path} is locked by another process`), { code: 'ELOCKED' });
    }
    if (result.status !== 0) {
      const detail = `${result.stderr ?? ''}`.trim() || result.error?.message || `exit ${result.status ?? result.signal}`;
      throw new Error(`Cannot lock ${path} with ${command}: ${detail}`);
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return { release: () => closeSync(fd) };
}
