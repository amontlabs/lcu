// Shared helper for tests that cannot run on a Windows host. Not a test file.
//
// Every use names the reason: the code path under test is POSIX-only (shell-script fixtures, mode bits, signals,
// /proc, flock, getent, POSIX layouts of the Linux and macOS apps) and never runs on Windows, or it needs a
// privilege the hosted runner does not give.  A skip is never used for a path Windows really executes: those get a
// fixture that works on Windows or a fix in the code.
//
//   it('name', { skip: skipOnWindows('needs /bin/sh') }, fn)       one test
//   describe('suite', { skip: skipOnWindows('reason') }, fn)        a suite
//   const { describe, it, test } = skippedOnWindows('reason')       every test of the file (use as the node:test import)
import nodeTest from 'node:test';

export const IS_WINDOWS = process.platform === 'win32';

/** The value for the `skip` option of node:test: the reason on Windows, false elsewhere. */
export const skipOnWindows = (reason) => {
  if (!reason || typeof reason !== 'string') throw new Error('skipOnWindows needs a specific reason');
  return IS_WINDOWS ? reason : false;
};

/** node:test's it/test/describe with the skip option added on Windows (all other options and callbacks untouched). */
export function skippedOnWindows(reason) {
  skipOnWindows(reason);
  const wrap = (fn) => (...args) => {
    if (!IS_WINDOWS) return fn(...args);
    const index = args.findIndex((arg) => typeof arg === 'function');
    const [name] = args;
    const options = index > 1 && args[1] && typeof args[1] === 'object' ? args[1] : {};
    const callback = args[index];
    return fn(typeof name === 'function' ? name.name : name, { ...options, skip: reason }, callback);
  };
  const describe = wrap(nodeTest.describe);
  const it = wrap(nodeTest.it);
  const test = wrap(nodeTest.test);
  return { describe, it, test, suite: describe };
}
