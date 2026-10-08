// An exclusive lock between LCU processes: a lock file created with O_EXCL that names its holder.
//
// Node has no flock(2). A lock file left by a holder that died (same host, process gone) is taken over, so a
// crash never blocks later runs. Only LCU's own processes take these locks.
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stale(path) {
  let holder;
  try {
    holder = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    // Created but not yet written, or damaged: give a live holder a moment to write its name.
    try {
      return Date.now() - statSync(path).mtimeMs > 10_000;
    } catch {
      return true;
    }
  }
  if (holder?.host !== hostname() || !Number.isInteger(holder?.pid)) return false;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

/**
 * Take the lock at `path`, waiting up to `wait` milliseconds (forever by default); `busy` builds the error
 * thrown when it stays held. Resolves with a function that releases it.
 */
export async function acquire(path, { wait = Infinity, busy = () => new Error(`${path} is locked by another LCU process`) } = {}) {
  const token = JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() });
  const deadline = Date.now() + wait;
  for (;;) {
    let fd;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (stale(path)) {
        try {
          unlinkSync(path);
        } catch (removed) {
          if (removed.code !== 'ENOENT') throw removed;
        }
        continue;
      }
      if (Date.now() >= deadline) throw busy();
      await sleep(50);
      continue;
    }
    try {
      writeSync(fd, token);
    } finally {
      closeSync(fd);
    }
    return () => {
      try {
        if (readFileSync(path, 'utf8') === token) unlinkSync(path);
      } catch {
        // already gone
      }
    };
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

/** The lock installs, updates and `lcu prune` take on one prefix. */
export const installLockPath = (prefix) => join(prefix, '.lcu-install.lock');
