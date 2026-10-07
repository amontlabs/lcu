// Exclusive advisory file lock, interoperable with Python's fcntl.flock(fd, LOCK_EX) (POSIX) and
// msvcrt.locking(fd, LK_LOCK, 1) (Windows).
//
// POSIX. Node has no flock(2). The lock is taken by `flock(1)` (Linux, util-linux) or `/usr/bin/lockf`
// (macOS; BSD lockf uses flock(2), "BSD-style locking ... as described in flock(2)") run on a file
// descriptor that this process opened and inherited into the helper as fd 3: `flock -x -w <=1 3`
// (never --fcntl) / `lockf -s -t <=1 3`; the fd form never unlocks on exit (lockf: "-k is implied when
// a file descriptor is in use"), which the tests prove against Python in both directions. A flock(2) lock belongs to the open file description, which
// the helper shares with this process, so the lock stays held after the helper exits for as long as
// this process keeps its descriptor open, exactly like a Python process holding the fd. Consequences:
//   * once acquired no holder process exists; the OS releases the lock when this process dies;
//   * every helper run is bounded: it waits at most one second per attempt (`-w` / `-t`), and attempts
//     repeat until the lock is taken or the timeout passes. A helper therefore
//     outlives a killed waiter by at most ~1 s (it then exits; if it took the lock meanwhile, the lock
//     disappears with it, since no other process keeps that description open);
//   * the lock file is opened by this process with the flags and permissions Python uses
//     (lcu/setup.py, lcu/browser.py: O_CREAT | O_RDWR | O_NOFOLLOW, 0o600), so a symlink, a
//     wrong owner or a missing directory fail with the same OSError text;
//   * flock(1)/lockf never create, remove or re-permission the file; they are resolved among fixed
//     system directories and run with a fixed environment (compat/systool.mjs).
// Cancellation: acquire() honours an AbortSignal before opening, before every attempt and during one
// (the helper is killed and reaped, the descriptor closed). acquireSync() blocks this thread like
// fcntl.flock: JavaScript signal handlers cannot run inside it. A Ctrl-C (SIGINT to the foreground
// process group) also reaches the helper; a helper ended by SIGINT/SIGTERM/SIGHUP/SIGQUIT makes both
// functions throw LockInterruptedError instead of retrying, so the critical section is not entered and
// a JS handler runs when the event loop next polls (not if the process exits first). A signal sent to this process alone
// while a JS handler is installed is only seen when acquireSync() returns: callers that must react
// during the wait use acquire().
//
// Windows. msvcrt.locking(fd, LK_LOCK, 1) locks byte 0 (also beyond EOF) on Python's handle, trying 10
// times one second apart, then fails with "[Errno 36] Resource deadlock avoided". Node cannot LockFile,
// so a holder process does it: Windows PowerShell (%SystemRoot%\System32\WindowsPowerShell\v1.0,
// never PATH) opens the same file (FileMode.Open, FileAccess.ReadWrite, FileShare ReadWrite|Delete:
// compatible with Node's own handle and with Python's _wopen handles, which share read/write) and calls
// FileStream.Lock(0, 1) (LockFile: the same byte-range lock msvcrt takes) with the same 10 attempts.
// It reports on a private status file, then holds the lock until its stdin (a pipe from this process)
// closes: on release() or when this process dies. This process keeps its own descriptor open as
// Python does. A holder that exits while the lock is supposed to be held is reported by `lock.lost`.
// Windows support is fixture-tested only (tests/compat/test_lock.py, injected holder).
//
// Changes 2026-10-05 (compat-os review findings 4, 6, 7): bounded helper waits, AbortSignal checked
// before and during acquisition, LockInterruptedError, trusted helper paths and environment, the
// Windows holder (it used to fall through to the Linux flock branch), Lock.lost.
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from './spawn.mjs';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PyOSError, pyStr } from './pyerr.mjs';
import { TOOL_ENV, trustedTool } from './systool.mjs';

const { O_APPEND, O_CREAT, O_NOFOLLOW = 0, O_RDWR, O_WRONLY } = constants;

/** open flags/mode lcu/setup.py and lcu/browser.py use for their lock files. */
export const LCU_LOCK_FILE = Object.freeze({ flags: O_CREAT | O_RDWR | O_NOFOLLOW, mode: 0o600 });
/** open(path, 'a'), which lcu/maintenance.py uses for the install lock (.lcu-install). */
export const APPEND_LOCK_FILE = Object.freeze({ flags: O_WRONLY | O_CREAT | O_APPEND, mode: 0o666 });

const CONFLICT = 75; // exit status of the helper when the lock could not be taken (sysexits EX_TEMPFAIL)
const SLICE = 1; // seconds one Linux helper may wait
const INTERRUPTS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']);

export class LockError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'LockError';
  }
}

export class LockTimeoutError extends LockError {
  constructor(message) {
    super(message);
    this.name = 'LockTimeoutError';
  }
}

/** The wait was interrupted by a terminal signal that reached the helper (Ctrl-C). */
export class LockInterruptedError extends LockError {
  constructor(path, signal) {
    super(`interrupted by ${signal} while waiting for the lock on ${path}`);
    this.name = 'LockInterruptedError';
    this.signal = signal;
  }
}

// Test seams (module state only; nothing in the environment can reach them).
const defaults = () => ({
  platform: process.platform,
  spawn: nodeSpawn,
  spawnSync: nodeSpawnSync,
  powershell: null,
  windowsAttempts: 10,
  windowsPauseMs: 1000,
});
let seams = defaults();
export const _testing = Object.freeze({
  set(values) {
    seams = { ...seams, ...values };
  },
  reset() {
    seams = defaults();
  },
});

// One attempt's helper, waiting at most `wait` seconds. Linux: flock(1) (fractional seconds; -w 0 is
// non-blocking). macOS: lockf -t takes whole seconds (0: fail unless free now).
function helperCommand(wait) {
  if (seams.platform === 'darwin') {
    const command = trustedTool('lockf', ['/usr/bin']);
    if (!command) throw new LockError('cannot lock: /usr/bin/lockf is missing');
    return { command, args: ['-s', '-t', String(Math.ceil(wait)), '3'] };
  }
  const command = trustedTool('flock');
  if (!command) throw new LockError('cannot lock: no trusted flock(1) in /usr/bin or /bin (package util-linux)');
  return { command, args: ['-E', String(CONFLICT), '-w', String(wait), '-x', '3'] };
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const timeoutError = (path, timeout) => new LockTimeoutError(`timed out after ${timeout} seconds waiting for the lock on ${path}`);

// What one attempt may wait (seconds), or null when the deadline has passed (after one attempt).
function sliceFor(deadline, attempt) {
  if (deadline === undefined) return SLICE;
  const remaining = (deadline - Date.now()) / 1000;
  if (remaining <= 0 && attempt > 0) return null;
  return Math.max(0, Math.min(SLICE, Math.round(remaining * 1000) / 1000));
}

function failure(path, status, signal, stderr, spawnError) {
  if (spawnError) {
    return new LockError(`cannot run the file-lock helper: ${pyStr(spawnError)}`, { cause: spawnError });
  }
  if (signal && INTERRUPTS.has(signal)) return new LockInterruptedError(path, signal);
  const detail = String(stderr ?? '').trim();
  return new LockError(`cannot lock ${path}${signal ? ` (helper died with ${signal})` : ` (helper exited ${status})`}${detail ? `: ${detail}` : ''}`);
}

/** A held lock. release() releases it (idempotent); the OS also releases it if the process dies. */
export class Lock {
  constructor(path, fd, holder = null) {
    this.path = path;
    this.fd = fd;
    this.holder = holder; // Windows holder state
  }
  get held() {
    return this.fd !== null && !this.lost;
  }
  /** True when the Windows holder process ended while the lock was supposed to be held. */
  get lost() {
    return this.holder !== null && this.fd !== null && this.holder.ended();
  }
  release() {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    try {
      this.holder?.release();
    } finally {
      closeSync(fd);
    }
  }
  [Symbol.dispose]() {
    this.release();
  }
}

/** Open the lock file the way Python's code does. OSErrors carry Python's text via pyerr.pyStr(). */
export function openLockFile(path, { flags, mode } = LCU_LOCK_FILE) {
  return openSync(path, flags, mode);
}

function aborted(signal) {
  return signal?.reason ?? new LockError('aborted');
}

/**
 * Take LOCK_EX on `path`, blocking this thread until it is free (or `timeout` seconds pass:
 * LockTimeoutError). Mirrors `fd = os.open(path, ...); fcntl.flock(fd, fcntl.LOCK_EX)`.
 * `signal` (AbortSignal) is honoured if it is already aborted (sync code cannot see a later abort).
 */
export function acquireSync(path, { timeout, file = LCU_LOCK_FILE, signal } = {}) {
  if (signal?.aborted) throw aborted(signal);
  const fd = openLockFile(path, file);
  if (seams.platform === 'win32') return windowsAcquireSync(path, fd, timeout);
  const deadline = timeout === undefined ? undefined : Date.now() + timeout * 1000;
  try {
    for (let attempt = 0; ; attempt++) {
      const wait = sliceFor(deadline, attempt);
      if (wait === null) throw timeoutError(path, timeout);
      const { command, args } = helperCommand(wait);
      const result = seams.spawnSync(command, args, { stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8', env: TOOL_ENV });
      if (!result.error && result.status === 0) return new Lock(path, fd);
      if (!result.error && result.status === CONFLICT) continue;
      throw failure(path, result.status, result.signal, result.stderr, result.error);
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function attemptAsync(command, args, fd, signal) {
  return new Promise((resolve) => {
    let stderr = '';
    const child = seams.spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe', fd], env: TOOL_ENV });
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); // aborted between the caller's check and the listener
    child.stderr?.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    let settled = false;
    const done = (error, status, sig) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve({ error, status, signal: sig, stderr });
    };
    child.once('error', (error) => done(error));
    child.once('close', (status, sig) => done(undefined, status, sig)); // reaped
  });
}

/**
 * Asynchronous acquisition: the event loop keeps running while the lock is contended.
 * `signal` (AbortSignal) cancels the wait (also when it is already aborted).
 */
export async function acquire(path, { timeout, signal, file = LCU_LOCK_FILE } = {}) {
  if (signal?.aborted) throw aborted(signal);
  const fd = openLockFile(path, file);
  if (seams.platform === 'win32') return windowsAcquire(path, fd, signal, timeout);
  const deadline = timeout === undefined ? undefined : Date.now() + timeout * 1000;
  try {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw aborted(signal);
      const wait = sliceFor(deadline, attempt);
      if (wait === null) throw timeoutError(path, timeout);
      if (signal?.aborted) throw aborted(signal);
      const { command, args } = helperCommand(wait);
      const result = await attemptAsync(command, args, fd, signal);
      if (signal?.aborted) throw aborted(signal);
      if (!result.error && result.status === 0) return new Lock(path, fd);
      if (!result.error && result.status === CONFLICT) continue;
      throw failure(path, result.status, result.signal, result.stderr, result.error);
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// ---- Windows -----------------------------------------------------------------------------------

/** The Windows PowerShell executable (absolute; %SystemRoot% must be an absolute drive path). */
export function windowsPowerShell(env = process.env) {
  if (seams.powershell) return seams.powershell;
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const safe = /^[A-Za-z]:\\[^"<>|?*\r\n]*$/.test(root) ? root.replace(/\\+$/, '') : 'C:\\Windows';
  return `${safe}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/**
 * The holder script: open `path`, take LockFile(0, 1) with msvcrt's LK_LOCK policy (`attempts`
 * tries, `pauseMs` apart), report LOCKED / DEADLOCK / OPENFAIL <hresult> on stdout (a private status
 * file), hold until stdin reaches EOF, then unlock, close and report RELEASED.
 */
export function windowsHolderScript(path, { attempts = 10, pauseMs = 1000, timeoutMs = null, pollMs = 50, releasePath = null } = {}) {
  const encoded = Buffer.from(path, 'utf8').toString('base64');
  const releaseEncoded = releasePath === null ? null : Buffer.from(releasePath, 'utf8').toString('base64');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
    '$out = [Console]::Out',
    'try {',
    '  $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete',
    '  $fs = New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, $share)',
    '} catch { $out.WriteLine("OPENFAIL " + $_.Exception.HResult); $out.Flush(); exit 3 }',
    '$locked = $false',
    ...(timeoutMs === null ? [
      `for ($i = 0; $i -lt ${attempts}; $i++) {`,
      '  try { $fs.Lock(0, 1); $locked = $true; break } catch [System.IO.IOException] {',
      `    if ($i -lt ${attempts - 1}) { [Threading.Thread]::Sleep(${pauseMs}) }`,
      '  }',
      '}',
      'if (-not $locked) { $out.WriteLine("DEADLOCK"); $out.Flush(); $fs.Close(); exit 4 }',
    ] : [
      // An explicit timeout: msvcrt.LK_NBLCK retried every pollMs until the deadline (callers such as
      // lcu/origins.py `locked`), reported as TIMEOUT (LockTimeoutError), not msvcrt.LK_LOCK's DEADLOCK.
      '$watch = [Diagnostics.Stopwatch]::StartNew()',
      'while ($true) {',
      '  try { $fs.Lock(0, 1); $locked = $true; break } catch [System.IO.IOException] {',
      `    if ($watch.ElapsedMilliseconds -ge ${Math.max(0, Math.round(timeoutMs))}) { break }`,
      `    [Threading.Thread]::Sleep(${pollMs})`,
      '  }',
      '}',
      'if (-not $locked) { $out.WriteLine("TIMEOUT"); $out.Flush(); $fs.Close(); exit 5 }',
    ]),
    '$out.WriteLine("LOCKED"); $out.Flush()',
    // Held until stdin reaches EOF (this process died) or the release file appears: closing a child's stdin pipe needs
    // the event loop, which a synchronous release() blocks, so release() creates the file instead (immediate).
    '$eof = [Console]::In.ReadToEndAsync()',
    ...(releaseEncoded === null ? ['[void]$eof.Wait()'] : [
      `$release = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${releaseEncoded}'))`,
      'while (-not $eof.IsCompleted -and -not [IO.File]::Exists($release)) { [Threading.Thread]::Sleep(20) }',
    ]),
    '$fs.Unlock(0, 1); $fs.Close()',
    '$out.WriteLine("RELEASED"); $out.Flush()',
    'exit 0',
  ].join('\n');
}

/** Python's OSError from msvcrt.locking after its ten attempts. */
export function windowsDeadlockError() {
  return new PyOSError({ errno: 36, strerror: 'Resource deadlock avoided', className: 'OSError', code: 'EDEADLK' }, 'win32');
}

function startHolder(path, timeout) {
  const statusPath = join(tmpdir(), `.lcu-lock-${process.pid}-${randomBytes(8).toString('hex')}`);
  const statusFd = openSync(statusPath, O_CREAT | constants.O_EXCL | O_RDWR, 0o600);
  const releasePath = `${statusPath}.release`;
  const script = windowsHolderScript(path, {
    attempts: seams.windowsAttempts, pauseMs: seams.windowsPauseMs, timeoutMs: timeout === undefined ? null : timeout * 1000,
    releasePath,
  });
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  const env = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'windir', 'SystemDrive', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  let child;
  try {
    child = seams.spawn(windowsPowerShell(), args, { stdio: ['pipe', statusFd, 'ignore'], env, windowsHide: true });
  } catch (error) {
    closeSync(statusFd);
    try { unlinkSync(statusPath); } catch { /* best effort */ }
    throw error;
  }
  closeSync(statusFd);
  let exited = false;
  child.once('exit', () => (exited = true));
  child.once('error', () => (exited = true));
  // Node may exit while the lock is held: the holder then sees EOF on stdin and lets go.
  child.unref();
  child.stdin?.unref?.();
  child.stdin?.on?.('error', () => {});
  const status = () => {
    try {
      return readFileSync(statusPath, 'utf8');
    } catch {
      return '';
    }
  };
  const cleanup = () => {
    try { unlinkSync(statusPath); } catch { /* already gone */ }
    try { unlinkSync(releasePath); } catch { /* never created */ }
  };
  // Tell the holder to let go, at once and without the event loop (see windowsHolderScript).
  const signalRelease = () => {
    try { writeFileSync(releasePath, ''); } catch { /* the stdin EOF still releases it */ }
  };
  // `exit` events need the event loop; synchronous waits probe the holder (our own child) with signal 0.
  const alive = () => {
    if (exited || child.exitCode !== null || child.signalCode !== null || !child.pid) return false;
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return { child, status, cleanup, signalRelease, exited: () => !alive() };
}

function holderResult(path, holder, timeout) {
  const gone = holder.exited(); // probed before reading, so a final report is never missed
  const lines = holder.status().split(/\r?\n/);
  if (lines.includes('DEADLOCK')) return windowsDeadlockError();
  if (lines.includes('TIMEOUT')) return timeoutError(path, timeout);
  const open = lines.map((line) => /^OPENFAIL (-?\d+)$/.exec(line)).find(Boolean);
  if (open) return new LockError(`cannot lock ${path}: the lock holder could not open it (HRESULT ${open[1]})`);
  // LOCKED counts only while the holder still holds: a holder that already exited (or released)
  // took the lock with it.
  if (gone || lines.includes('RELEASED')) return new LockError(`cannot lock ${path}: the lock holder exited unexpectedly`);
  if (lines.includes('LOCKED')) return 'LOCKED';
  return null;
}

function holderState(holder) {
  return {
    ended: () => holder.exited() || holder.status().includes('RELEASED'),
    release() {
      holder.signalRelease();
      holder.child.stdin?.destroy?.();
      // Wait (bounded) for the unlock, so the lock is free when release() returns, as with os.close.
      const until = Date.now() + 10000;
      while (!holder.status().includes('RELEASED') && !holder.exited() && Date.now() < until) sleepSync(10);
      holder.cleanup();
    },
  };
}

function abandon(holder) {
  holder.signalRelease();
  holder.child.stdin?.destroy?.();
  try { holder.child.kill(); } catch { /* gone */ }
  holder.cleanup();
}

function windowsAcquireSync(path, fd, timeout) {
  let holder;
  try {
    holder = startHolder(path, timeout);
    // The holder answers within its attempts (or its timeout); allow generous start-up time on top, never forever.
    const until = Date.now() + (timeout === undefined ? seams.windowsAttempts * seams.windowsPauseMs : timeout * 1000) + 60000;
    for (;;) {
      const result = holderResult(path, holder, timeout);
      if (result === 'LOCKED') return new Lock(path, fd, holderState(holder));
      if (result) throw result;
      if (Date.now() > until) throw new LockError(`cannot lock ${path}: the lock holder did not answer`);
      sleepSync(10);
    }
  } catch (error) {
    if (holder) abandon(holder);
    closeSync(fd);
    throw error;
  }
}

async function windowsAcquire(path, fd, signal, timeout) {
  let holder;
  try {
    holder = startHolder(path, timeout);
    for (;;) {
      if (signal?.aborted) throw aborted(signal);
      const result = holderResult(path, holder, timeout);
      if (result === 'LOCKED') return new Lock(path, fd, holderState(holder));
      if (result) throw result;
      await sleep(10);
    }
  } catch (error) {
    if (holder) abandon(holder);
    closeSync(fd);
    throw error;
  }
}

// ---- with-statement helpers ------------------------------------------------------------------------

/** `with lock:` for async code: acquire, run fn(lock), always release. */
export async function withLock(path, fn, options) {
  const lock = await acquire(path, options);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}

/** `with lock:` for synchronous code. */
export function withLockSync(path, fn, options) {
  const lock = acquireSync(path, options);
  try {
    return fn(lock);
  } finally {
    lock.release();
  }
}
