// Exclusive locks between LCU processes, compatible with the locks earlier (Python) releases took.
//
// POSIX: a kernel flock on a lock file that stays in place, so a holder that exits or crashes releases it and
// releases before the Node port exclude this one and are excluded by it. Node has no flock(2): macOS takes it
// atomically with open(2) (O_EXLOCK); Linux has util-linux flock(1) lock the descriptor this process opened and
// passed down as fd 3, which locks the shared open file description, so the lock outlives flock(1) and lasts
// until this process closes it. Windows: a lock file created exclusively that names its holder; a file left by
// a process that is gone is taken over.
// Builtins come from process.getBuiltinModule: macos_host.mjs, on the macOS launch path, shares tryExclusiveOpen.
const fs = process.getBuiltinModule('node:fs');
const { basename, dirname, join } = process.getBuiltinModule('node:path');

/** open(2) flag that takes flock(LOCK_EX) atomically with the open (macOS). */
export const O_EXLOCK = 0x20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * macOS: open `path` (created 0600) holding an exclusive flock, or return null while another descriptor holds
 * it. Closing the descriptor releases the lock.
 */
export function tryExclusiveOpen(path, flags = fs.constants.O_RDWR) {
  const { O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  try {
    return fs.openSync(path, flags | O_CREAT | O_NOFOLLOW | O_EXLOCK | O_NONBLOCK, 0o600);
  } catch (error) {
    if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') return null;
    throw error;
  }
}

/** Open the lock file for flock: read-write, else read-only (a root-owned install marker); never through a link. */
function openLockFile(path) {
  const { O_CREAT, O_NOFOLLOW, O_RDONLY, O_RDWR } = fs.constants;
  try {
    return fs.openSync(path, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
    return fs.openSync(path, O_RDONLY | O_NOFOLLOW);
  }
}

/** Linux: try to flock `fd` exclusively through flock(1); true when held. */
function tryFlock(fd, path) {
  const result = process.getBuiltinModule('node:child_process').spawnSync('flock', ['-xn', '3'],
    { stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8', timeout: 10_000 });
  if (result.error?.code === 'ENOENT') {
    throw new Error('LCU needs flock(1) to lock its files; install util-linux (it provides flock) and retry.');
  }
  if (result.status === 0) return true;
  if (result.status === 1 && !result.stderr.trim()) return false;
  throw new Error(`Cannot lock ${path}: ${(result.stderr || result.error?.message || `flock exited ${result.status}`).trim()}`);
}

/** One attempt to take the lock: a release function, or null while another process holds it. */
function attemptPosix(path) {
  if (process.platform === 'darwin') {
    const fd = tryExclusiveOpen(path);
    if (fd === null) return null;
    return () => fs.closeSync(fd);
  }
  const fd = openLockFile(path);
  try {
    if (!tryFlock(fd, path)) {
      fs.closeSync(fd);
      return null;
    }
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  return () => fs.closeSync(fd);
}

/** Windows: true when the lock file names a process that is gone (or was never completely written long ago). */
function staleWindows(path, content) {
  let holder;
  try {
    holder = JSON.parse(content);
  } catch {
    try {
      return Date.now() - fs.statSync(path).mtimeMs > 10_000;
    } catch {
      return false;
    }
  }
  if (!Number.isInteger(holder?.pid)) return true;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function attemptWindows(path) {
  const token = JSON.stringify({ pid: process.pid, at: Date.now() });
  let fd;
  try {
    fd = fs.openSync(path, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let content;
    try {
      content = fs.readFileSync(path, 'utf8');
    } catch (read) {
      if (read.code === 'ENOENT') return attemptWindows(path);
      throw read;
    }
    if (!staleWindows(path, content)) return null;
    // Take a stale lock over by moving it aside and checking that what moved is the stale one: a peer may have
    // replaced it in between, and then its lock is put back.
    const aside = join(dirname(path), `.${basename(path)}.stale-${process.pid}-${Date.now()}`);
    try {
      fs.renameSync(path, aside);
    } catch (moved) {
      if (moved.code === 'ENOENT') return null;
      throw moved;
    }
    if (fs.readFileSync(aside, 'utf8') !== content) {
      try {
        fs.linkSync(aside, path);
      } catch {
        // a third process holds the name now
      }
    }
    fs.rmSync(aside, { force: true });
    return null;
  }
  try {
    fs.writeSync(fd, token);
  } finally {
    fs.closeSync(fd);
  }
  return () => {
    try {
      if (fs.readFileSync(path, 'utf8') === token) fs.unlinkSync(path);
    } catch {
      // already gone
    }
  };
}

const WINDOWS_WAIT = 60_000;

/**
 * Take the lock at `path`, waiting up to `wait` milliseconds (POSIX: until released; Windows: one minute by
 * default). `busy` builds the error thrown when it stays held; `waiting` is told once, after a second, that the
 * wait started. Resolves with a function that releases the lock. POSIX lock files are never removed.
 */
export async function acquire(path, {
  wait = process.platform === 'win32' ? WINDOWS_WAIT : Infinity,
  busy = () => new Error(`${path} stayed locked by another LCU process; retry when it has finished.`),
  waiting = () => process.stderr.write(`LCU: waiting for another LCU process to release ${path}...\n`),
} = {}) {
  const attempt = process.platform === 'win32' ? attemptWindows : attemptPosix;
  const started = Date.now();
  let told = false;
  for (;;) {
    const release = attempt(path);
    if (release) return release;
    const elapsed = Date.now() - started;
    if (elapsed >= wait) throw busy();
    if (!told && elapsed >= 1000) {
      told = true;
      waiting();
    }
    await sleep(Math.min(50, Math.max(wait - elapsed, 0)));
  }
}

/** Run `fn` while holding the lock at `path`. */
export async function withLock(path, fn, options) {
  const release = await acquire(path, options);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * The lock installs, updates and `lcu prune` share for one prefix: the install marker itself on POSIX, as
 * earlier releases locked it, and a lock file beside it on Windows.
 */
export const installLockPath = (prefix) => join(prefix, process.platform === 'win32' ? '.lcu-install.lock' : '.lcu-install');
