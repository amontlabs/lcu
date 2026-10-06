// child_process.spawn / spawnSync / execFile with Python subprocess semantics that libuv lacks. Every LCU module
// imports spawn/spawnSync/execFile from here instead of node:child_process (a test greps for stragglers).
//
// 1. Ignored signals. A process started with SIGINT/SIGHUP/... ignored (nohup, a CI runner, `trap '' INT`) hands
//    that disposition to everything it starts, and Python's subprocess/os.exec* pass it on. Node resets every
//    signal to the default at startup and libuv resets them again in each spawned child, so LCU's launch shim
//    reports the inherited ignores (startup_vars.mjs ignored_signals()) and every child gets them back: the child is
//    started through a POSIX shell that sets SIG_IGN and execs the target in place (same pid, so timeouts, kill()
//    and wait status apply to the target). With nothing ignored (the normal case) and on Windows nothing changes.
// 2. Exec format. Python's _posixsubprocess execs with execve(2): a file that is neither a binary nor a #! script
//    fails with ENOEXEC ("[Errno 8] Exec format error"). libuv uses execvp(), whose ENOEXEC fallback RUNS the text
//    with /bin/sh. The target is checked first (compat/execve preflight) and such a spawn fails with ENOEXEC exactly
//    where Node reports any other spawn failure (the 'error' event, spawnSync's result.error, execFile's callback).
// 3. Environment. Node's child_process copies the parent's NODE_V8_COVERAGE into an explicit `env` that does not
//    name it (and writes it into the caller's object). Python passes exactly the env it was given: the env handed
//    to child_process is a copy that names NODE_V8_COVERAGE as undefined (child_process then omits it).
//
// The target is resolved as the child will see it: a relative file, or a relative/empty PATH entry, is relative to
// options.cwd (libuv chdirs before searching). An unusable target keeps the plain spawn so the caller sees the same
// ENOENT/EACCES/... it always saw. A non-string `file` and the `shell` option keep the plain path. Every call form of
// child_process is handled (spawn(file), spawn(file, options), execFile(file, cb), execFile(file, options, cb), ...).
// `argv0` is preserved through the signal wrapper by bash's `exec -a` (dash has none); when bash is missing the
// plain spawn is used (argv0 kept, signals not re-ignored). Residual: bash exports SHLVL=0 when the env had none.
import * as childProcess from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';

import { ignored_signals, reignore } from '../startup_vars.mjs';
import { preflight } from './execve.mjs';

const BASH = '/bin/bash';
const DEFAULT_PATH = '/usr/bin:/bin'; // libuv's fallback when the child env has no PATH (_PATH_DEFPATH)

function executableFile(path) {
  try {
    accessSync(path, fsConstants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const inCwd = (path, cwd) => (path.startsWith('/') ? path : `${(cwd ?? process.cwd()).replace(/\/+$/, '') || ''}/${path}`);

/** The absolute file the child would execute for `file` (null when the search finds none), as libuv searches. */
export function childTarget(file, options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd === undefined || options.cwd === null ? undefined : String(options.cwd);
  if (file.includes('/')) return inCwd(file, cwd);
  const path = env.PATH ?? DEFAULT_PATH;
  for (const entry of path.split(':')) {
    const candidate = inCwd(`${entry === '' ? '.' : entry}/${file}`, cwd);
    if (executableFile(candidate)) return candidate;
  }
  return null;
}

// What to do for this spawn: {file, args} to run, or {failure: 'ENOEXEC'}.
function plan(file, args, options = {}, { signals = ignored_signals(), platform = process.platform } = {}) {
  if (platform === 'win32' || typeof file !== 'string' || options.shell) return { file, args };
  const env = options.env ?? process.env;
  let target;
  let verdict;
  try {
    target = childTarget(file, options);
    if (!target) return { file, args };
    verdict = preflight(target, [file, ...args], env, { platform });
  } catch {
    return { file, args }; // argument validation errors are the plain spawn's to report
  }
  if (verdict === 'ENOEXEC') return { failure: 'ENOEXEC' };
  if (verdict || signals.length === 0) return { file, args };
  if (options.argv0 !== undefined && options.argv0 !== null) {
    if (!existsSync(BASH)) return { file, args };
    // dash cannot set argv[0]: bash `exec -a` does ($0 of the -c script is the wanted argv[0])
    const unsetPwd = Object.hasOwn(env, 'PWD') ? '' : 'unset PWD; ';
    return { file: BASH, args: ['-c', `trap '' ${signals.join(' ')}; ${unsetPwd}exec -a "$0" "$@"`, String(options.argv0), file, ...args] };
  }
  const [wrapper, argv] = reignore(file, [file, ...args], env, signals);
  return { file: wrapper, args: argv.slice(1) };
}

/**
 * The [file, args] to hand to child_process for `file args...` so the child starts with the caller's ignored signals
 * ignored again; [file, args] unchanged when there is nothing to do or the target cannot be checked/executed.
 */
export function wrapForSignals(file, args, options = {}, extra = {}) {
  const decided = plan(file, args, options, extra);
  return decided.failure ? [file, args] : [decided.file, decided.args];
}

/** The options child_process gets: an explicit env is copied and never gains the parent's NODE_V8_COVERAGE. */
export function childOptions(options) {
  const env = options?.env;
  if (!env || typeof env !== 'object') return options;
  const copy = { ...env };
  if (!Object.hasOwn(copy, 'NODE_V8_COVERAGE')) copy.NODE_V8_COVERAGE = undefined;
  return { ...options, env: copy };
}

function formatError(file, args, syscall) {
  const error = new Error(`${syscall} ${file} ENOEXEC`);
  return Object.assign(error, { errno: -(osConstants.errno.ENOEXEC ?? 8), code: 'ENOEXEC', syscall: `${syscall} ${file}`,
    path: file, spawnargs: args });
}

// A ChildProcess whose spawn fails like any other spawn failure, but with ENOEXEC: Node's own failed-spawn object
// (a target that cannot exist), with the error replaced before anyone sees it.
const IMPOSSIBLE = '/nonexistent/lcu-exec-format-refused';
function refusedChild(file, args, options) {
  const { cwd, ...rest } = options ?? {}; // cwd is irrelevant to a refused spawn (and must not change the error)
  const child = childProcess.spawn(IMPOSSIBLE, args, rest);
  const emit = child.emit.bind(child);
  child.emit = (event, ...values) => {
    if (event === 'error' && values[0]?.code === 'ENOENT') values[0] = formatError(file, args, 'spawn');
    return emit(event, ...values);
  };
  child.spawnfile = file;
  child.spawnargs = [file, ...args];
  return child;
}

// spawn(file[, args][, options]): the argument list is optional in every position.
const spawnForm = (args, options) => (Array.isArray(args) ? [args, options ?? {}] : [[], args ?? {}]);

export function spawn(file, args, options) {
  [args, options] = spawnForm(args, options);
  const decided = plan(file, args, options);
  if (decided.failure) return refusedChild(file, args, childOptions(options));
  return childProcess.spawn(decided.file, decided.args, childOptions(options));
}

export function spawnSync(file, args, options) {
  [args, options] = spawnForm(args, options);
  const decided = plan(file, args, options);
  if (decided.failure) {
    return { pid: 0, output: null, stdout: null, stderr: null, status: null, signal: null,
      error: formatError(file, args, 'spawnSync') };
  }
  return childProcess.spawnSync(decided.file, decided.args, childOptions(options));
}

// execFile(file[, args][, options][, callback])
function execFileForm(rest) {
  const list = [...rest];
  const args = Array.isArray(list[0]) ? list.shift() : [];
  const options = list[0] !== null && typeof list[0] === 'object' ? list.shift() : {};
  const callback = typeof list[0] === 'function' ? list.shift() : undefined;
  return { args, options, callback };
}

export function execFile(file, ...rest) {
  const { args, options, callback } = execFileForm(rest);
  const decided = plan(file, args, options);
  const given = childOptions(options);
  if (decided.failure) {
    const child = childProcess.execFile(IMPOSSIBLE, args, { ...given, cwd: undefined }, (error, stdout, stderr) => {
      if (callback) callback(error?.path === IMPOSSIBLE || error?.code === 'ENOENT' ? formatError(file, args, 'spawn') : error, stdout, stderr);
    });
    const emit = child.emit.bind(child);
    child.emit = (event, ...values) => {
      if (event === 'error' && values[0]?.code === 'ENOENT') values[0] = formatError(file, args, 'spawn');
      return emit(event, ...values);
    };
    child.spawnfile = file;
    return child;
  }
  return callback === undefined
    ? childProcess.execFile(decided.file, decided.args, given)
    : childProcess.execFile(decided.file, decided.args, given, callback);
}
