// Configure LCU tools, without requiring a running desktop.
// Port of lcu/setup.py (same function order, names, strings and side-effect order). See .port/notes/setup.md.
//
// Representation (see .port/CONVENTIONS.md):
//   * Python Path values are absolute path strings; bytes are Buffers; tuples are arrays.
//   * argparse results are lcu/compat/argparse.mjs Namespaces (args.get('prefix') is a PyPath whose
//     String() is the normalised path).
//   * JSON read from disk is the lossless pyjson model (dict -> Map, int -> BigInt, float -> PyFloat), so
//     files that round-trip user data (commands.json, installation.json, the host contract) keep key
//     order, integer-like keys and number text. Everything written goes through pyjson.dumps.
//   * Python's `patch('lcu.setup.X')` seams are the properties of `impl` (every intra-module call to a
//     patchable name goes through it). Tests replace them; production never does.
//   * `with setup_lock(home):` is `const lock = await setup_lock(home); try { ... } finally { lock.release(); }`.
//   * main, reconcile, configure, export_bundle, run and setup_lock are async (KeyboardInterrupt emulation,
//     see with_interrupt_guard); every other function is synchronous, like Python.
import fs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { spawn } from './compat/spawn.mjs';
import { fileURLToPath } from 'node:url';
import tty from 'node:tty';

import * as argparse from './compat/argparse.mjs';
import { stderr_write, stdout_flush, stdout_write } from './compat/pyio.mjs';
import { read_line as read_line_async } from './compat/pyinput.mjs';
import { acquire as acquire_lock, LockError, LockInterruptedError } from './compat/lock.mjs';
import { findpwnam, findpwuid, becomeAccount, PyKeyError } from './compat/accounts.mjs';
import * as compat_pathlib from './compat/pathlib.mjs';
import { fromNodeError, isOSError, PyOSError, pyStr, reprStr } from './compat/pyerr.mjs';
import { py_repr, py_str } from './compat/pystr.mjs';
import { isValueError } from './compat/errors.mjs';
import { CalledProcessError, execFormatError, SubprocessError, TimeoutExpired } from './compat/subprocess.mjs';
import { mkstemp } from './compat/tempfile.mjs';
import { which as shutil_which } from './compat/which.mjs';
import { decode as utf8_decode } from './compat/utf8.mjs';
import { casefold } from './compat/unicode.mjs';
import { splitWin, winIsAbsolute, winParent, winPathStr } from './compat/winpath.mjs';
import { run as capture_run } from './capture.mjs';
import {
  compareCodePoints, dumps as json_dumps, isInt, JSONDecodeError, PyFloat, reprFloat, loads as json_loads, UnicodeDecodeError, ValueError,
} from './compat/pyjson.mjs';
import * as shlex from './compat/shlex.mjs';

import { ALIASES, CLIENTS } from './setup_clients.mjs';
import * as approvals_mod from './approval.mjs';
import * as app_layout_mod from './app_layout.mjs';
import * as browser_mod from './browser.mjs';
import * as claude_mod_mod from './claude_mod.mjs';
import * as claude_visibility_mod from './claude_visibility.mjs';
import * as codex_hooks_mod from './codex_hooks.mjs';
import * as harness_setup_mod from './harness_setup.mjs';
import * as platforms_mod from './platforms.mjs';
import * as runtime_mod from './runtime.mjs';
import * as tested_mod from './tested.mjs';

export { ALIASES, CLIENTS };
export { ValueError };

const { pyStrip, pySplitlines } = argparse;
const truthy = (value) => (Array.isArray(value) ? value.length > 0 : Boolean(value));

const DOC = 'Configure LCU tools, without requiring a running desktop.';

export const APP_DOWNLOAD_URL = 'https://chatgpt.com/download/';

// ---------------------------------------------------------------------------------------------
// Python runtime pieces the module relies on (exceptions, subprocess, shutil.which, input, print)
// ---------------------------------------------------------------------------------------------

/** Python's KeyboardInterrupt (a BaseException: `except Exception` does not catch it). */
export class KeyboardInterrupt extends Error {
  constructor(message = '') {
    super(message);
    this.name = 'KeyboardInterrupt';
  }
}

/** Python's EOFError (input() on a closed stdin). */
export class EOFError extends Error {
  constructor(message = '') {
    super(message);
    this.name = 'EOFError';
  }
}

export { CalledProcessError, SubprocessError, TimeoutExpired };

/** OSError with an already-formatted str(exc) (used where Python raises OSError from a syscall helper). */
const osErrorWithText = (message) => new PyOSError({ strerror: message, className: 'OSError' });

const SUBPROCESS_ERROR_NAMES = new Set(['SubprocessError', 'CalledProcessError', 'TimeoutExpired']);

export { isOSError, isValueError }; // the single classifiers (compat/errors.mjs)
export const isSubprocessError = (e) => e instanceof SubprocessError
  || (e instanceof Error && SUBPROCESS_ERROR_NAMES.has(e.name));
/** `except (ValueError, OSError, subprocess.SubprocessError)` */
export const isExpectedError = (e) => isValueError(e) || isOSError(e) || isSubprocessError(e);
/** `except Exception` (BaseException subclasses KeyboardInterrupt and SystemExit propagate). */
const isKeyboardInterrupt = (e) => e instanceof KeyboardInterrupt || e?.name === 'KeyboardInterrupt';
const isException = (e) => !(isKeyboardInterrupt(e) || e instanceof argparse.PySystemExit || e instanceof LockLostError);

/**
 * The setup lock was lost while held (a Windows lock holder process died; compat/lock.mjs `lost`). Setup stops
 * before its next change, like browser.mjs; registration phases do not swallow it. A ValueError, so `main`
 * reports it as `Setup failed: ...` (exit 1). Residual: a loss between the check and the write it guards.
 */
export class LockLostError extends ValueError {
  constructor(path) {
    super(`The lock on ${path} was lost; stopped before changing anything else.`);
    this.name = 'ValueError';
  }
}

let active_lock = null;

/** Fail closed when the held setup lock is no longer held. Called before every mutation step. */
export function check_lock() {
  if (active_lock !== null && (active_lock.held === false || active_lock.lost)) throw new LockLostError(active_lock.path);
}

/** str(exc) for the exception families setup catches. */
export function str_exc(e) {
  if (isOSError(e)) {
    return typeof e.message === 'string' && e.message.startsWith('[Errno ') ? e.message : pyStr(e);
  }
  return e instanceof Error ? e.message : String(e);
}

/** A KeyError as Python reports it through `describe`: KeyError: 'key'. */
export function key_error(key) {
  const error = new Error(reprStr(key));
  error.name = 'KeyError';
  return error;
}

const pyTypeName = (v) => {
  if (v === null || v === undefined) return 'NoneType';
  if (v instanceof Map) return 'dict';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'boolean') return 'bool';
  if (isInt(v)) return 'int';
  return 'float';
};

/** container[key] for a JSON-model value and a str key, with Python's errors. */
function subscript(container, key) {
  if (container instanceof Map) {
    if (!container.has(key)) throw key_error(key);
    return container.get(key);
  }
  const error = new TypeError(Array.isArray(container) ? 'list indices must be integers or slices, not str'
    : typeof container === 'string' ? 'string indices must be integers, not \'str\''
      : `'${pyTypeName(container)}' object is not subscriptable`);
  throw error;
}


const dictGet = (m, key, dflt = null) => (m instanceof Map && m.has(key) ? m.get(key) : dflt);
const toMap = (value) => (value instanceof Map ? value : new Map(Object.entries(value ?? {})));
const entriesOf = (value) => (value instanceof Map ? [...value] : Object.entries(value ?? {}));

export const DEVNULL = Symbol.for('lcu.subprocess.DEVNULL');
export const PIPE = Symbol.for('lcu.subprocess.PIPE');

const SIGNALS = nodeOs.constants.signals;

const stdioOf = (value) => (value === undefined || value === null ? 'inherit' : value === DEVNULL ? 'ignore'
  : value === PIPE ? 'pipe' : value);

function spawnFailure(error, argv, cwd) {
  let filename = argv[0];
  if (error.code === 'ENOENT' && cwd !== undefined && cwd !== null && !is_dir_quiet(String(cwd))) filename = String(cwd);
  return fromNodeError(error, { filename }) ?? error;
}

// ---- KeyboardInterrupt emulation ----
//
// Python raises KeyboardInterrupt at the next bytecode after SIGINT, so `finally` blocks, lock releases and
// apply_changes' rollback run. Node's default SIGINT action kills the process before any of that, and a JS
// listener only runs when the event loop polls. So setup's CLI runs inside with_interrupt_guard(): a listener
// records the signal (the process survives) and checkpoint() turns it into a thrown KeyboardInterrupt at the
// next point where setup yields to the event loop: while waiting for every child process and the setup lock,
// between transaction writes, around prompts and between registration steps. Children in the same process
// group still receive a terminal Ctrl-C themselves. lcu/entry.mjs then prints "KeyboardInterrupt" and ends the
// process by SIGINT, as Python does for an unhandled KeyboardInterrupt.
const interrupt = { depth: 0, pending: false, listeners: new Set() };

function on_sigint() {
  interrupt.pending = true;
  for (const listener of [...interrupt.listeners]) listener();
}

/** Run `fn` (sync or async) with SIGINT converted into KeyboardInterrupt at checkpoints. */
export async function with_interrupt_guard(fn) {
  if (interrupt.depth++ === 0) {
    interrupt.pending = false;
    process.on('SIGINT', on_sigint);
  }
  try {
    return await fn();
  } finally {
    if (--interrupt.depth === 0) process.off('SIGINT', on_sigint);
  }
}

/** Let pending signal events run, then raise KeyboardInterrupt if SIGINT arrived since the last checkpoint. */
export async function checkpoint() {
  await new Promise((resolve) => setImmediate(resolve));
  take_interrupt();
  check_lock();
}

function take_interrupt() {
  if (interrupt.pending) {
    interrupt.pending = false;
    throw new KeyboardInterrupt();
  }
}

/** Python's text-mode decoding: strict UTF-8 (U+FFFD for errors='replace'), then universal newlines. */
function decode_text(buffer, errors = 'strict') {
  const text = errors === 'replace' ? buffer.toString('utf8') : utf8_decode(buffer);
  return text.replace(/\r\n?/g, '\n');
}

/**
 * subprocess.run(argv, ...), awaitable. Options: cwd, env, stdin/stdout/stderr (DEVNULL | PIPE | fd),
 * capture_output, text, encoding ('utf-8' only), errors ('strict' | 'replace'), timeout (seconds; the child is
 * killed with SIGKILL), check. Text mode (text, encoding or errors given) decodes strictly unless
 * errors='replace' and translates universal newlines, as Python's TextIOWrapper does.
 * SIGINT under with_interrupt_guard follows Python's subprocess.run: the child gets 0.25 s to exit, is then
 * killed with SIGKILL and reaped, and KeyboardInterrupt is raised. Returns {args, returncode, stdout, stderr}.
 */
export function run(argv, options = {}) {
  const { cwd, env, stdin, capture_output = false, text = false, encoding = null, errors = null, timeout = null, check = false } = options;
  let { stdout, stderr } = options;
  if (capture_output) {
    stdout = PIPE;
    stderr = PIPE;
  }
  if (encoding !== null && !/^utf-?8$/i.test(encoding)) return Promise.reject(new ValueError(`unsupported encoding: ${encoding}`));
  const textMode = Boolean(text) || encoding !== null || errors !== null;
  return new Promise((resolvePromise, rejectPromise) => {
    if (interrupt.pending) {
      interrupt.pending = false;
      rejectPromise(new KeyboardInterrupt());
      return;
    }
    // Python's exec refuses an executable file without a #! line (ENOEXEC, errno 8); libuv would run it
    // through /bin/sh instead. Same preflight (PATH from env, cwd) as compat/subprocess.run.
    const formatError = execFormatError(argv.map(String), env, { cwd: cwd === undefined || cwd === null ? undefined : String(cwd) });
    if (formatError) {
      rejectPromise(formatError);
      return;
    }
    let child;
    try {
      child = spawn(String(argv[0]), argv.slice(1).map(String), {
        cwd: cwd === undefined || cwd === null ? undefined : String(cwd),
        env,
        stdio: [stdioOf(stdin), stdioOf(stdout), stdioOf(stderr)],
      });
    } catch (error) {
      rejectPromise(spawnFailure(error, argv, cwd));
      return;
    }
    const out = [];
    const err = [];
    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));
    let timedOut = false;
    let interrupted = false;
    let finished = false;
    let exited = null; // [status, signal] once the process itself has ended (pipes may still be open)
    const timers = [];
    const piped = stdout === PIPE || stderr === PIPE;
    const finish = () => {
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      interrupt.listeners.delete(onInterrupt);
    };
    const settle = () => {
      if (finished) return;
      finish();
      if (interrupted || timedOut) {
        // Python kills the child and waits for the PROCESS (not for descendants holding its pipes), then raises.
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (interrupted) {
          interrupt.pending = false;
          rejectPromise(new KeyboardInterrupt());
        } else {
          rejectPromise(new TimeoutExpired(argv, timeout * 1000));
        }
        return;
      }
      const [status, signal] = exited;
      const returncode = status !== null ? status : -(SIGNALS[signal] ?? 0);
      try {
        const decode = (chunks, isPiped) => {
          if (!isPiped) return null;
          const buffer = Buffer.concat(chunks);
          return textMode ? decode_text(buffer, errors ?? 'strict') : buffer;
        };
        const completed = { args: argv, returncode, stdout: decode(out, stdout === PIPE), stderr: decode(err, stderr === PIPE) };
        if (check && returncode) throw new CalledProcessError(returncode, argv, completed.stdout, completed.stderr);
        resolvePromise(completed);
      } catch (error) {
        rejectPromise(error);
      }
    };
    // Cut the run short (timeout or interrupt): kill the child unless it already exited, settle once it has.
    const cut = () => {
      if (finished) return;
      if (exited) settle();
      else child.kill('SIGKILL'); // only this run()'s own child; settle follows on 'exit'
    };
    if (timeout !== null && timeout !== undefined) {
      timers.push(setTimeout(() => {
        timedOut = true;
        cut();
      }, timeout * 1000));
    }
    function onInterrupt() {
      if (interrupted) return;
      interrupted = true;
      timers.push(setTimeout(cut, 250));
    }
    interrupt.listeners.add(onInterrupt);
    child.once('error', (error) => {
      if (finished) return;
      finish();
      rejectPromise(spawnFailure(error, argv, cwd));
    });
    // Normal completion: Python's communicate() drains captured pipes, so settle on 'close' when output is
    // captured, else on 'exit' (a grandchild may keep inherited fds open). A cut-short run settles on 'exit'.
    child.once('exit', (status, signal) => {
      exited = [status, signal];
      if (!piped || interrupted || timedOut) settle();
    });
    child.once('close', (status, signal) => {
      exited ??= [status, signal];
      settle();
    });
  });
}

// os.access(path, os.X_OK) etc.
function access_ok(path, mode) {
  try {
    fs.accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}
const x_ok = (path) => access_ok(path, fs.constants.X_OK);

const IGNORED_ERRNOS = new Set(['ENOENT', 'ENOTDIR', 'EBADF', 'ELOOP']);

function stat_or_null(path, follow = true) {
  try {
    return follow ? fs.statSync(path) : fs.lstatSync(path);
  } catch (error) {
    if (IGNORED_ERRNOS.has(error.code) || error.code === 'ERR_INVALID_ARG_VALUE') return null;
    throw error;
  }
}
/** Path.exists() */
export const path_exists = (path) => stat_or_null(path) !== null;
/** Path.is_file() */
export const is_file = (path) => stat_or_null(path)?.isFile() ?? false;
/** Path.is_dir() */
export const is_dir = (path) => stat_or_null(path)?.isDirectory() ?? false;
function is_dir_quiet(path) {
  try {
    return is_dir(path);
  } catch {
    return false;
  }
}
/** Path.is_symlink() */
export const is_symlink = (path) => stat_or_null(path, false)?.isSymbolicLink() ?? false;

// ---- stdin helpers (input() / sys.stdin.isatty()) ----

/**
 * input(prompt): the prompt goes to stdout (stderr when stdin and stdout are both terminals), stdout is flushed, one
 * line is read from stdin; EOF raises EOFError. A Ctrl-C while the line is awaited raises KeyboardInterrupt exactly
 * where Python's input() does (lcu/compat/pyinput.mjs reads asynchronously so the signal can be seen); the
 * exception then unwinds through `finally` blocks, entry.mjs prints Python's traceback and the process ends by
 * SIGINT. No transaction is open at a prompt.
 */
export async function input(prompt = '') {
  take_interrupt();
  // The guard's own listener only records the signal for checkpoint(); while a line is awaited the read's listener
  // turns it into KeyboardInterrupt at once.
  const guarded = interrupt.depth > 0;
  if (guarded) process.off('SIGINT', on_sigint);
  try {
    return await read_line_async(() => {
      // CPython's input() writes the prompt to stderr when stdin and stdout are both terminals (PyOS_Readline).
      if (tty.isatty(0) && tty.isatty(1)) io.stderr(prompt);
      else io.stdout(prompt);
      // input() flushes sys.stdout (the prompt and everything printed before it) before it reads.
      stdout_flush();
    }, { interrupted: () => new KeyboardInterrupt(), eof: () => new EOFError() });
  } finally {
    if (guarded) process.on('SIGINT', on_sigint);
    interrupt.pending = false;
  }
}

/** The stdout/stderr sinks (`print`). Replaceable for in-process use and tests. */
export const io = {
  stdout(text) { stdout_write(text); },
  stderr(text) { stderr_write(text); },
};

const print = (text = '') => io.stdout(`${text}\n`);
const eprint = (text = '') => io.stderr(`${text}\n`);

/** `parser.exit(status, message)`: message to stderr, then SystemExit(status). */
function parser_exit(p, status, message) {
  p.exit(status, message);
}

// ---------------------------------------------------------------------------------------------
// pathlib helpers (str paths)
// ---------------------------------------------------------------------------------------------

// pathlib's flavour follows the host OS (os.name), not sys.platform: impl.windows_paths (tests may flip it).
const windows_paths = () => impl.windows_paths;

/** Path(a) / b / ... as str(Path): PurePosixPath or PureWindowsPath joining; `..` is kept, never collapsed. */
export function join_path(...parts) {
  return windows_paths() ? winPathStr(...parts.map(String)) : compat_pathlib.pathStr(...parts.map(String));
}
const path_str = (p) => (windows_paths() ? winPathStr(String(p)) : compat_pathlib.pathStr(String(p)));

/** Path.is_absolute() (Windows: a drive or UNC share and a root, either separator). */
export function is_absolute(p) {
  const s = String(p);
  return windows_paths() ? winIsAbsolute(s) : compat_pathlib.pathStr(s).startsWith('/');
}

/** Path(p).absolute(): the current directory is prepended; `..` is kept (validation sees the raw form). */
const absolute_path = (p) => {
  if (!windows_paths()) return compat_pathlib.absolute(String(p));
  const text = winPathStr(String(p));
  return winIsAbsolute(text) ? text : winPathStr(process.cwd(), text);
};

/** Path.resolve(strict) */
const resolve_path = (p, strict = false) => {
  if (!windows_paths()) return compat_pathlib.resolve(String(p), { strict });
  return strict ? fs.realpathSync.native(String(p)) : nodePath.win32.resolve(String(p));
};

function split_root(s) {
  if (windows_paths()) {
    const [drive, root, parts] = splitWin(s);
    return [drive + root, parts];
  }
  const root = s.startsWith('//') && !s.startsWith('///') ? '//' : s.startsWith('/') ? '/' : '';
  return [root, s.slice(root.length).split('/').filter((c) => c && c !== '.')];
}

/** Path.parts */
export function path_parts(p) {
  const [root, components] = split_root(path_str(p));
  return root ? [root, ...components] : components;
}

/** Path.parent */
export function path_parent(p) {
  if (windows_paths()) return winParent(String(p));
  const [root, components] = split_root(path_str(p));
  return components.length > 1 ? root + components.slice(0, -1).join('/') : root || '.';
}

/** list(Path.parents) */
export function path_parents(p) {
  const result = [];
  let current = path_str(p);
  for (;;) {
    const parent = path_parent(current);
    if (parent === current) break;
    result.push(parent);
    current = parent;
    if (parent === '.') break;
  }
  return result;
}

/** Path.as_uri() for the host flavour (PureWindowsPath: file:///C:/..., UNC file://host/share/...). */
export function path_as_uri(p) {
  if (!windows_paths()) return compat_pathlib.asUri(String(p));
  const text = winPathStr(String(p));
  if (!winIsAbsolute(text)) throw new ValueError("relative path can't be expressed as a file URI");
  const [drive] = splitWin(text);
  const posix = text.replaceAll('\\', '/');
  const [prefix, rest] = drive.length === 2 && drive[1] === ':' ? [`file:///${drive}`, posix.slice(2)] : ['file:', posix];
  let out = prefix;
  for (const byte of Buffer.from(rest, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.\-~/]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

const hasControl = (text) => [...text].some((c) => c.codePointAt(0) < 32);

/**
 * Path.read_text(): strict UTF-8 with CPython's UnicodeDecodeError text (a ValueError), universal newlines
 * (\r\n and \r become \n), a leading BOM kept. The locale encoding is taken to be UTF-8 (see port notes).
 */
export function read_text(path) {
  return utf8_decode(fs.readFileSync(path)).replace(/\r\n?/g, '\n');
}


// ---------------------------------------------------------------------------------------------
// The injection seams (Python: attributes of the lcu.setup module that tests patch)
// ---------------------------------------------------------------------------------------------
export const impl = {
  platform: process.platform,
  windows_paths: process.platform === 'win32',
  run,
  capture_run,
  which: shutil_which,
  input,
  isatty: () => tty.isatty(0),
  getuid: () => process.getuid(),
  getpwnam: (name) => {
    const entry = findpwnam(name);
    if (!entry) throw new PyKeyError(`getpwnam(): name not found: ${reprStr(name)}`);
    return entry;
  },
  getpwuid: (uid) => {
    const entry = findpwuid(uid);
    if (!entry) throw new PyKeyError(`getpwuid(): uid not found: ${uid}`);
    return entry;
  },
  getuser: () => {
    for (const name of ['LOGNAME', 'USER', 'LNAME', 'USERNAME']) if (process.env[name]) return process.env[name];
    return nodeOs.userInfo().username;
  },
  // Sibling modules, resolved at call time (lcu.approval, lcu.codex_hooks, ... are imported lazily in Python).
  approvals: {
    apply: (...a) => approvals_mod.apply(...a),
    codex_plan: (...a) => approvals_mod.codex_plan(...a),
    merge_codex_policy: (...a) => approvals_mod.merge_codex_policy(...a),
  },
  configure_omp: (...a) => harness_setup_mod.configure_omp(...a),  // may return a promise (harness_runner)
  configure_hermes: (...a) => harness_setup_mod.configure_hermes(...a),
  require_cli_hook_support: (...a) => codex_hooks_mod.require_cli_hook_support(...a),
  install_hooks: (...a) => codex_hooks_mod.install_hooks(...a),
  export_files: (...a) => codex_hooks_mod.export_files(...a),
  locate_codex_tools: (...a) => app_layout_mod.locate_codex_tools(...a),
  claude_visibility_install: (...a) => claude_visibility_mod.install(...a),
  claude_mod_install: (...a) => claude_mod_mod.install(...a),
  report_tested_pair: (...a) => tested_mod.report(...a),
  browser_install: (...a) => browser_mod.install(...a),
  app_paths: (...a) => runtime_mod.paths(...a),
  mac_socket_path_problem: (...a) => platforms_mod.mac_socket_path_problem(...a),
  release_dir: () => nodePath.dirname(nodePath.dirname(fs.realpathSync(fileURLToPath(import.meta.url)))),
};

const platform = () => impl.platform;

// ---------------------------------------------------------------------------------------------

export function app_prerequisite_message(location = null, { alternate_location = false } = {}) {
  let message = 'LCU requires the official ChatGPT desktop app, which includes Codex, to be installed first. '
    + 'LCU does not download or install the app.';
  if (location !== null && location !== undefined) message += ` No app was found at ${location}.`;
  message += ` Install it from ${APP_DOWNLOAD_URL} and rerun LCU.`;
  if (alternate_location) message += ' If it is installed elsewhere, pass --existing-app PATH.';
  return message;
}

/** @dataclass class Change: path, before (Buffer|null), after (Buffer|null) */
export class Change {
  constructor(path, before, after) {
    this.path = path;
    this.before = before;
    this.after = after;
  }
}

const bytes_equal = (a, b) => (a === null || a === undefined || b === null || b === undefined
  ? (a ?? null) === (b ?? null) : Buffer.compare(a, b) === 0);

/** Do not write through symlinks, including directory components. */
export function regular_path(path) {
  const absolute = absolute_path(String(path));
  if (path_parts(absolute).includes('..') || hasControl(absolute)) {
    throw new ValueError(`Use a path without parent traversal or control characters: ${absolute}`);
  }
  for (const item of [absolute, ...path_parents(absolute)]) {
    if (is_symlink(item)) {
      throw new ValueError(`Refusing a symlink in setup destination: ${item}. Use manual configuration instead.`);
    }
  }
  return absolute;
}

export function read_file(path) {
  regular_path(path);
  if (path_exists(path)) {
    if (!is_file(path)) throw new ValueError(`Expected a regular file: ${path}`);
    return fs.readFileSync(path);
  }
  return null;
}

export function atomic_write(path, data) {
  regular_path(path);
  fs.mkdirSync(path_parent(path), { recursive: true });
  if (data === null || data === undefined) {
    try {
      fs.unlinkSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return;
  }
  const previous_mode = path_exists(path) ? fs.statSync(path).mode & 0o777 : 0o600;
  const { fd, path: temporary } = mkstemp({ prefix: '.lcu-setup-', dir: path_parent(path) });
  try {
    try {
      let offset = 0;
      while (offset < data.length) offset += fs.writeSync(fd, data, offset);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(temporary, previous_mode);
    fs.renameSync(temporary, path);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

/** Preflight everything; roll back our writes if a later write fails. */
export function apply_changes(changes) {
  changes = changes.filter((c) => !bytes_equal(c.before, c.after));
  for (const change of changes) {
    if (!bytes_equal(read_file(change.path), change.before)) {
      throw new ValueError(`File changed during setup; retry: ${change.path}`);
    }
  }
  const applied = [];
  try {
    for (const change of changes) {
      if (!bytes_equal(read_file(change.path), change.before)) {
        throw new ValueError(`File changed during setup; retry: ${change.path}`);
      }
      atomic_write(change.path, change.after);
      applied.push(change);
    }
  } catch (error) {
    for (const change of [...applied].reverse()) {
      // Never undo a concurrent editor's changes.
      if (bytes_equal(read_file(change.path), change.after)) atomic_write(change.path, change.before);
    }
    throw error;
  }
  return changes.length;
}

/**
 * apply_changes for setup's own transactions under with_interrupt_guard: identical preflight, order and
 * rollback, with a checkpoint after every write, so a SIGINT during the transaction raises KeyboardInterrupt
 * inside it and the completed writes are rolled back (a concurrent editor's bytes are still never undone),
 * as Python's `except BaseException` does. Sibling modules keep the synchronous apply_changes: under the
 * guard a signal cannot interrupt it, so it completes and the interrupt is raised at the next checkpoint.
 */
export async function apply_changes_interruptible(changes) {
  changes = changes.filter((c) => !bytes_equal(c.before, c.after));
  for (const change of changes) {
    if (!bytes_equal(read_file(change.path), change.before)) {
      throw new ValueError(`File changed during setup; retry: ${change.path}`);
    }
  }
  const applied = [];
  try {
    for (const change of changes) {
      take_interrupt();
      check_lock();
      if (!bytes_equal(read_file(change.path), change.before)) {
        throw new ValueError(`File changed during setup; retry: ${change.path}`);
      }
      atomic_write(change.path, change.after);
      applied.push(change);
      await checkpoint();
    }
  } catch (error) {
    for (const change of [...applied].reverse()) {
      // Never undo a concurrent editor's changes.
      if (bytes_equal(read_file(change.path), change.after)) atomic_write(change.path, change.before);
    }
    throw error;
  }
  return changes.length;
}

const state_dir =(home) => (platform() === 'win32' ? join_path(home, 'AppData/Local/LCU') : join_path(home, '.local/state/lcu'));

/**
 * The account-wide setup lock (setup.lock), awaitable; resolves to a Lock with release(). The OS drops it
 * when the process dies. compat/lock.mjs opens the file as Python does (O_CREAT|O_RDWR|O_NOFOLLOW, 0600) and
 * takes fcntl.flock(LOCK_EX) on POSIX (blocking, like Python) or msvcrt.locking(fd, LK_LOCK, 1) on Windows
 * (byte 0, ten one-second attempts, then "[Errno 36] Resource deadlock avoided"). A SIGINT while waiting
 * (setup's interrupt guard, or a Ctrl-C that ends the lock helper) raises KeyboardInterrupt like Python.
 */
export async function setup_lock(home) {
  const path = regular_path(join_path(state_dir(home), 'setup.lock'));
  fs.mkdirSync(path_parent(path), { recursive: true });
  take_interrupt();
  const controller = new AbortController();
  const onInterrupt = () => controller.abort(new KeyboardInterrupt());
  interrupt.listeners.add(onInterrupt);
  try {
    return await acquire_lock(path, { signal: controller.signal });
  } catch (error) {
    if (isKeyboardInterrupt(error) || error instanceof LockInterruptedError) {
      interrupt.pending = false;
      throw new KeyboardInterrupt();
    }
    if (error instanceof LockError) throw osErrorWithText(error.message);
    throw error;
  } finally {
    interrupt.listeners.delete(onInterrupt);
  }
}

/** Per-account opt-in memory, beside setup.lock. */
export function setup_state_path(home) {
  return regular_path(join_path(state_dir(home), 'setup.json'));
}

// Harnesses whose native registration needs their own executable; Codex and Claude Code
// register through add-mcp and their config files without the CLI installed.
export const NEEDS_BINARY = Object.freeze(['pi', 'omp', 'hermes']);

/** Return saved opt-ins and pending harnesses; tolerate a missing file, reject a malformed one. */
export function load_setup_state(home) {
  const path = setup_state_path(home);
  const data = read_file(path);
  const empty = { chrome: false, audio: false, approval: 'ask', pending: [], pending_context: null };
  if (data === null) return empty;
  let parsed;
  try {
    parsed = json_loads(data);
  } catch (exc) {
    if (exc instanceof JSONDecodeError || exc instanceof UnicodeDecodeError) {
      throw new ValueError(`Malformed LCU setup state at ${path}; delete it and rerun setup.`);
    }
    throw exc;
  }
  // `approval` and `pending` were added after `chrome` and `audio`; an older file means "ask" and none pending.
  const isDict = parsed instanceof Map;
  const pending = isDict ? dictGet(parsed, 'pending', []) : null;
  const context = isDict ? dictGet(parsed, 'pending_context') : null;
  const malformed = !isDict
    || !['chrome', 'audio'].every((key) => typeof dictGet(parsed, key) === 'boolean')
    || !['ask', 'auto'].includes(dictGet(parsed, 'approval', 'ask'))
    || !Array.isArray(pending) || !pending.every((item) => NEEDS_BINARY.includes(item))
    || (context !== null && !(
      context instanceof Map && ['user', 'project'].includes(dictGet(context, 'scope'))
      && ['discover', 'direct'].includes(dictGet(context, 'session'))
      && (dictGet(context, 'project') === null || typeof dictGet(context, 'project') === 'string')));
  if (malformed) throw new ValueError(`Malformed LCU setup state at ${path}; delete it and rerun setup.`);
  return {
    chrome: parsed.get('chrome'),
    audio: parsed.get('audio'),
    approval: dictGet(parsed, 'approval', 'ask'),
    pending: [...new Set(pending)],
    pending_context: pending.length ? context : null,
  };
}

export function save_setup_state(home, { chrome, audio, approval = 'ask', pending = [], pending_context = null } = {}) {
  pending = [...new Set(pending)];
  const document = new Map([['chrome', chrome], ['audio', audio], ['approval', approval]]);
  // Absent when nothing is pending, so the file stays readable by earlier LCU versions.
  if (pending.length) {
    document.set('pending', pending);
    document.set('pending_context', pending_context);
  }
  atomic_write(setup_state_path(home), Buffer.from(`${json_dumps(document, { indent: 2 })}\n`));
}

/** PATH plus the user-level directories harness installers use, for a harness installed after login. */
export function harness_search_path(home, path = null) {
  path = path === null || path === undefined ? (process.env.PATH ?? '') : path;
  const extra = ['.local/bin', '.bun/bin', '.npm-global/bin', '.cargo/bin'].map((name) => join_path(home, name));
  return [...new Set([...path.split(nodePath.delimiter).filter(Boolean), ...extra])].join(nodePath.delimiter);
}

export function harness_installed(name, home, path = null) {
  return Boolean(impl.which(CLIENTS[name].executable, harness_search_path(home, path)));
}

/** Select a real account home; only honor profile overrides understood upstream. */
export function installer_environment(home, names, environ = null) {
  const env = { ...(environ === null || environ === undefined ? process.env : environ) };
  const rejected = {
    'claude-code': ['CLAUDE_CONFIG_DIR'],
    'gemini-cli': ['GEMINI_CLI_HOME'],
    opencode: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR'],
    'copilot-cli': ['COPILOT_HOME'],
  };
  for (const name of names) {
    for (const variable of Object.hasOwn(rejected, name) ? rejected[name] : []) {
      if (env[variable]) {
        throw new ValueError(`${variable} is not supported by the bundled installers for ${name}; unset it or use --export.`);
      }
    }
  }
  const supported = [];
  if (names.includes('codex')) supported.push('CODEX_HOME');
  if (names.includes('hermes')) supported.push('HERMES_HOME');
  if (names.includes('omp')) supported.push('PI_CODING_AGENT_DIR');
  if (['opencode', 'vscode', 'copilot-cli'].some((name) => names.includes(name))) supported.push('XDG_CONFIG_HOME');
  for (const variable of supported) {
    if (env[variable] && !is_absolute(env[variable])) throw new ValueError(`${variable} must be absolute.`);
  }
  if (names.includes('copilot-cli') && env.XDG_CONFIG_HOME) {
    throw new ValueError('XDG_CONFIG_HOME is not supported for Copilot CLI by the bundled installers; unset it or use --export.');
  }
  Object.assign(env, { HOME: String(home), DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', NO_COLOR: '1', CI: '1' });
  // Node flags can inject code; setup uses only the packaged runtime and CLIs.
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
}

export function installer_paths(tools_root) {
  let node;
  if (platform() === 'win32') node = join_path(impl.app_paths(path_parent(tools_root))[2], 'bin/node.exe');
  else node = join_path(tools_root, 'node/bin/node');
  const paths = [node,
    join_path(tools_root, 'node_modules/skills/bin/cli.mjs'),
    join_path(tools_root, 'node_modules/add-mcp/dist/index.js')];
  for (const path of paths) {
    if (!is_file(path)) {
      throw new ValueError(`Bundled agent installer missing: ${path}. Rerun scripts/install.sh with this --prefix.`);
    }
  }
  if (!x_ok(paths[0])) throw new ValueError(`Bundled Node runtime is not executable: ${paths[0]}`);
  return paths;
}

// add-mcp 2.4.0 accepts malformed JSONC without checking parse errors. Keep this
// read-only guard until upstream fails closed. Paths and formats still come from
// its public adapter metadata; all configuration writes remain upstream-owned.
export const MCP_PREFLIGHT = String.raw`
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
try {
  const [cli, name, scope] = process.argv.slice(1);
  const require = createRequire(pathToFileURL(cli));
  const { agents } = await import(pathToFileURL(join(dirname(cli), 'lib.js')));
  const agent = agents[name];
  const local = scope === 'project';
  const cwd = process.cwd();
  const path = agent.resolveConfigPath ? agent.resolveConfigPath(agent, { local, cwd })
    : local ? join(cwd, agent.localConfigPath) : agent.configPath;
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') process.exit(0); throw error; }
  let data;
  if (agent.format === 'toml') data = require('@iarna/toml').parse(text);
  else if (agent.format === 'json') {
    const jsonc = require('jsonc-parser');
    const errors = [];
    const tree = jsonc.parseTree(text, errors, { allowTrailingComma: true });
    if (errors.length) throw new Error(${'`'}Malformed configuration: ${'$'}{path}${'`'});
    function checkDuplicates(node) {
      if (!node) return;
      if (node.type === 'object') {
        const keys = new Set();
        for (const property of node.children || []) {
          const key = property.children[0].value;
          if (keys.has(key)) throw new Error(${'`'}Duplicate configuration key in ${'$'}{path}: ${'$'}{key}${'`'});
          keys.add(key);
        }
      }
      for (const child of node.children || []) checkDuplicates(child);
    }
    checkDuplicates(tree);
    data = jsonc.getNodeValue(tree);
  } else throw new Error(${'`'}Unsupported configuration format: ${'$'}{agent.format}${'`'});
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(data)) throw new Error(${'`'}Configuration must be an object: ${'$'}{path}${'`'});
  const key = local && agent.localConfigKey ? agent.localConfigKey : agent.configKey;
  let current = data;
  for (const part of key.split('.')) {
    if (!Object.hasOwn(current, part)) break;
    current = current[part];
    if (!object(current)) throw new Error(${'`'}MCP configuration must be an object: ${'$'}{path}${'`'});
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
`;

export async function preflight_mcp(node, mcp, client, scope, cwd, env) {
  const result = await impl.run([String(node), '--input-type=module', '-e', MCP_PREFLIGHT,
    String(mcp), client.mcp_agent, scope], {
    cwd, env, stdin: DEVNULL, capture_output: true, text: true, encoding: 'utf-8', errors: 'replace', timeout: 20,
  });
  if (result.returncode) throw new ValueError(pyStrip(result.stderr) || 'MCP configuration preflight failed');
}

export const MCP_REGISTER = String.raw`
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [cli, agent, scope, commandJson, policyJson] = process.argv.slice(1);
const { agents, upsertServer } = await import(pathToFileURL(join(dirname(cli), 'lib.js')));
if (agent === 'codex') {
  const transform = agents.codex.transformConfig;
  const policy = JSON.parse(policyJson);
  agents.codex.transformConfig = (...args) => ({ ...transform(...args), ...policy });
}
const [command, ...args] = JSON.parse(commandJson);
const result = upsertServer(agent, 'lcu', { command, args }, { local: scope === 'project', cwd: process.cwd() });
if (!result.success) throw new Error(result.error);
console.log(JSON.stringify(result));
`;

/** Use the shipped host contract, not reconstructed tool defaults. */
export function host_policy(release_root) {
  const resources = impl.installed_app_resources(release_root);
  const descriptor = join_path(resources, 'plugins/openai-bundled/plugins/unified-computer-use/.mcp.json');
  const server = subscript(subscript(json_loads(read_text(descriptor)), 'mcpServers'), 'cua_repl');
  if (!(server instanceof Map)) {
    const error = new Error(`'${pyTypeName(server)}' object has no attribute 'items'`);
    error.name = 'AttributeError';
    throw error;
  }
  // Codex replaces these launch fields at runtime. LCU supplies its own command.
  return new Map([...server].filter(([key]) => !['command', 'args', 'enabled'].includes(key)));
}

/** Resolve the selected installation without depending on release payload copies. */
export function installed_app_resources(release_root) {
  release_root = resolve_path(String(release_root));
  if (platform() === 'win32') return impl.app_paths(release_root)[1];
  const descriptor = join_path(release_root, 'installation.json');
  const app = join_path(release_root, 'app');
  if (!is_file(descriptor)) throw new ValueError(`Installed application descriptor missing: ${descriptor}`);
  let installation;
  try {
    installation = json_loads(read_text(descriptor));
  } catch (exc) {
    if (isOSError(exc) || exc instanceof JSONDecodeError) {
      throw new ValueError(`Invalid installed application descriptor: ${descriptor}`);
    }
    throw exc;
  }
  const app_reference = installation instanceof Map ? dictGet(installation, 'app') : null;
  if (typeof app_reference !== 'string' || !app_reference) {
    throw new ValueError(`Installed application descriptor has no app reference: ${descriptor}`);
  }
  let described_app;
  let selected_app;
  try {
    described_app = resolve_path(is_absolute(app_reference) ? app_reference : join_path(release_root, app_reference), true);
    selected_app = resolve_path(app, true);
  } catch (exc) {
    if (isOSError(exc)) throw new ValueError(`Installed application path is incomplete: ${release_root}`);
    throw exc;
  }
  if (described_app !== selected_app) {
    throw new ValueError(`Installed application descriptor does not match selected app: ${descriptor}`);
  }
  const target = dictGet(installation, 'platform', 'linux');
  if (!['linux', 'darwin'].includes(target)) {
    throw new ValueError(`Unsupported installed application platform: ${py_str(target)}`);
  }
  const resources = join_path(selected_app, target === 'darwin' ? 'Contents/Resources' : 'resources');
  if (!is_dir(resources)) throw new ValueError(`Installed application resources missing: ${resources}`);
  return resources;
}

/**
 * Delete the skill that earlier LCU versions generated for registration.
 *
 * Official Codex computer use registers no skill, so LCU no longer does.
 */
export function remove_generated_skill(home) {
  const root = platform() === 'win32' ? join_path(home, 'AppData/Local/LCU/skills') : join_path(home, '.local/share/lcu/skills');
  const generated = join_path(regular_path(root), 'lcu');
  if (is_dir(generated) && !is_symlink(generated)) {
    fs.rmSync(generated, { recursive: true });
    try {
      fs.rmdirSync(root);
    } catch (error) {
      if (!isOSError(error)) throw error;
    }
  }
}

// Descriptions used by the `lcu` skill that LCU 0.6.0 and earlier registered.
export const OLD_SKILL_MARKERS = Object.freeze(['original Codex computer-use runtime', 'LCU MCP computer-use tools']);

/**
 * Remove the `lcu` skill registered by LCU 0.6.0 and earlier, and nothing else.
 *
 * The skill installer keeps a shared `.agents/skills` copy while any other
 * detected agent could use it, so remove it for every agent, but only after
 * confirming the installed skill is LCU's own.
 */
export function remove_old_skill(node, skills, cwd, env, global_args) {
  const installer = (...args) => {
    const result = impl.capture_run([String(node), String(skills), ...args, ...global_args], { cwd, env, timeout: 120 });
    if (result.returncode) {
      const detail = pyStrip(result.stderr || result.stdout);
      throw new ValueError(`skill installer exited ${result.returncode}${detail ? `: ${detail}` : ''}`);
    }
    return result;
  };
  const result = installer('list', '--json');
  let installed;
  try {
    installed = json_loads(result.stdout || '[]');
    if (!Array.isArray(installed)) throw new ValueError('not a list');
  } catch (exc) {
    if (!isValueError(exc)) throw exc;
    const tail = Array.from(pyStrip(result.stderr)).slice(-500).join('');
    throw new ValueError(`skill installer returned invalid JSON (${Buffer.byteLength(result.stdout)} bytes)`
      + (tail ? `: ${tail}` : ''));
  }
  const entry = installed.find((item) => item instanceof Map && dictGet(item, 'name') === 'lcu');
  if (entry === undefined) return 'none';
  const skill = join_path(py_str(dictGet(entry, 'path', '')), 'SKILL.md');
  const text = is_file(skill) ? fs.readFileSync(skill).toString('utf8') : '';
  const frontmatter = text.startsWith('---') && text.split('---').length - 1 >= 2 ? text.split('---')[1] : '';
  const fields = new Map();
  for (const line of pySplitlines(frontmatter)) {
    const at = line.indexOf(':');
    if (at >= 0) fields.set(line.slice(0, at), line.slice(at + 1));
  }
  if (pyStrip(fields.get('name') ?? '') !== 'lcu'
      || !OLD_SKILL_MARKERS.some((marker) => (fields.get('description') ?? '').includes(marker))) {
    return 'kept';
  }
  installer('remove', 'lcu', '--yes');
  return 'removed';
}

/**
 * The runner setup gives harness_setup (OMP/Hermes registration): its compat/subprocess.run call shape mapped to
 * setup's awaitable run, so the installer is SIGINT-aware while harness_setup's package context (previous tree)
 * is still open, and an interrupt restores the previous package like Python's `_package` context manager.
 */
export function harness_runner(argv, { cwd, env, stdin, capture = false, errors = 'strict', timeout } = {}) {
  return impl.run(argv, {
    cwd, env, stdin: stdin === 'devnull' ? DEVNULL : undefined, capture_output: capture, text: true, errors,
    timeout: timeout === undefined ? null : timeout / 1000,
  });
}

/** The registration phase after which a harness's approval mode is applied. */
export function name_final_phase(name) {
  return name === 'pi' ? 'extension' : 'MCP';
}

/**
 * Delegate registration and return phase failures: [[name, phase, message], ...].
 *
 * approval is null (leave harness approval settings alone), "auto" or "ask" (see lcu.approval).
 */
export async function configure(names, home, command, tools_root, release_root,
  { scope = 'user', project = null, setup_command = null, environ = null, approval = null } = {}) {
  const approvals = impl.approvals;
  const env = impl.installer_environment(home, names, environ);
  const [node, skills, mcp] = impl.installer_paths(tools_root);
  const resources = impl.installed_app_resources(release_root);
  const original_plugins = join_path(resources, 'plugins/openai-bundled');
  const cwd = scope === 'project' ? project : home;
  const global_args = scope === 'user' ? ['--global'] : [];
  const failures = [];

  const describe = (exc) => (isExpectedError(exc) ? str_exc(exc) : `${exc?.name ?? 'Error'}: ${exc?.message ?? exc}`);

  const apply_approval = (name, client, plan = null) => {
    if (approval === null || approval === undefined) return;
    try {
      check_lock();
      const outcome = approvals.apply(approval, name, home, { scope, project, env, plan });
      print(`${client.label}: approval ${approval}: ${outcome}.`);
    } catch (exc) {
      if (!isException(exc)) throw exc;
      failures.push([name, 'approval', describe(exc)]);
      eprint(`${client.label}: approval failed: ${describe(exc)}`);
    }
  };

  for (const name of names) {
    await checkpoint();
    const client = CLIENTS[name];
    if (name === 'omp' || name === 'hermes') {
      try {
        check_lock();
        if (name === 'omp') {
          await impl.configure_omp(home, command, release_root, { scope, project, env, run: harness_runner });
        } else {
          await impl.configure_hermes(home, command, node, release_root, { scope, project, env, run: harness_runner });
        }
        print(`${client.label}: plugin registered.`);
      } catch (exc) {
        if (!isException(exc)) throw exc;
        failures.push([name, 'plugin', describe(exc)]);
        eprint(`${client.label}: plugin failed: ${describe(exc)}`);
        continue;
      }
      apply_approval(name, client);
      continue;
    }
    let mcp_command = command;
    let mcp_setup_error = null;
    let codex_plan = null;
    if (name === 'claude-code') {
      const adapter = join_path(release_root, 'adapters/claude.mjs');
      if (!is_file(adapter)) {
        mcp_setup_error = `Claude MCP relay missing: ${adapter}. Reinstall LCU into this release prefix, then rerun setup.`;
      } else {
        mcp_command = [String(node), adapter, ...command];
      }
    }
    if (name === 'codex') {
      const adapter = join_path(release_root, 'adapters/codex.mjs');
      const audio_helper = join_path(release_root, 'adapters/audio-files.mjs');
      if (!is_file(adapter) || !is_file(audio_helper)) {
        mcp_setup_error = `Codex audio relay missing: ${adapter} or ${audio_helper}. Reinstall LCU into this release prefix, then rerun setup.`;
      } else {
        mcp_command = [String(node), adapter, ...command];
      }
      try {
        impl.require_cli_hook_support(env);
        // Registration replaces `[mcp_servers.lcu]`; read the previous approval value first.
        codex_plan = approvals.codex_plan(approval, home, { scope, project, env });
      } catch (exc) {
        if (!isException(exc)) throw exc;
        failures.push([name, 'host', describe(exc)]);
        eprint(`${client.label}: host failed: ${describe(exc)}`);
        continue;
      }
    }
    // Earlier LCU versions registered an `lcu` skill; official Codex computer
    // use has none, so remove it.
    const cleanup_command = null;
    let pi = null;
    let extension;
    let selected_command;
    let commands;
    if (name === 'pi') {
      pi = impl.which('pi', env.PATH ?? null);
      const pi_root = platform() === 'win32' ? join_path(home, 'AppData/Local/LCU/pi') : join_path(home, '.local/share/lcu/pi');
      extension = join_path(pi_root, 'extension.mjs');
      selected_command = join_path(pi_root, 'commands.json');
      commands = [['old skill cleanup', cleanup_command],
        ['extension', [pi, 'install', ...(scope === 'user' ? [] : ['-l']), extension]]];
    } else {
      commands = [['old skill cleanup', cleanup_command],
        ['MCP', [String(node), '--input-type=module', '-e', MCP_REGISTER, String(mcp),
          client.mcp_agent, scope, json_dumps(mcp_command),
          json_dumps(approvals.merge_codex_policy(
            impl.host_policy(release_root), codex_plan ? codex_plan.policy : {}))]]];
    }
    for (const [phase, argv] of commands) {
      await checkpoint();
      if (phase === 'old skill cleanup') {
        // Best-effort legacy cleanup: a failure here must not fail setup.
        let outcome;
        try {
          outcome = impl.remove_old_skill(node, skills, cwd, env, global_args);
        } catch (exc) {
          if (!isException(exc)) throw exc;
          eprint(`${client.label}: skipped old LCU skill cleanup: ${describe(exc)}`);
          continue;
        }
        if (outcome === 'removed') print(`${client.label}: old LCU skill removed.`);
        else if (outcome === 'kept') print(`${client.label}: kept an \`lcu\` skill that LCU did not create.`);
        continue;
      }
      try {
        if (phase === 'MCP') {
          if (mcp_setup_error) throw new ValueError(mcp_setup_error);
          await impl.preflight_mcp(node, mcp, client, scope, cwd, env);
        }
        if (phase === 'extension') {
          if (!pi) {
            throw new ValueError('Pi is not on the target account PATH. Install Pi, then run '
              + `\`${setup_command || 'lcu'} setup --agent pi --yes\` from that account shell.`);
          }
          const adapter = join_path(release_root, 'adapters/pi/index.ts');
          if (!is_file(adapter)) throw new ValueError(`LCU Pi adapter missing: ${adapter}`);
          const wrapper = Buffer.from(`import lcu from ${json_dumps(path_as_uri(adapter))};\n`
            + 'import {readFileSync, realpathSync} from "node:fs";\n'
            + `const config = JSON.parse(readFileSync(${json_dumps(selected_command)}, "utf8"));\n`
            + 'export default pi => lcu(pi, {command: '
            + 'config.projects?.[realpathSync(process.cwd())] ?? config.user});\n');
          const previous = read_file(selected_command);
          const config = previous && previous.length ? json_loads(previous) : new Map([['projects', new Map()]]);
          if (!(config instanceof Map) || !(dictGet(config, 'projects') instanceof Map)) {
            throw new ValueError(`Invalid LCU Pi command configuration: ${selected_command}`);
          }
          if (scope === 'user') config.set('user', command);
          else config.get('projects').set(resolve_path(project, true), command);
          await apply_changes_interruptible([new Change(extension, read_file(extension), wrapper),
            new Change(selected_command, previous, Buffer.from(`${json_dumps(config, { indent: 2 })}\n`))]);
        }
        check_lock();
        const phase_env = phase === 'extension' ? { ...env, PI_OFFLINE: '1' } : env;
        const result = await impl.run(argv, {
          cwd, env: phase_env, stdin: DEVNULL, capture_output: true, text: true, encoding: 'utf-8',
          errors: 'replace', timeout: 120,
        });
        // The registration awaited above may have outlived the lock (a lost Windows holder): no further write.
        check_lock();
        if (result.returncode) {
          // Upstream diagnostics are shown to the invoking user, never stored.
          const detail = pyStrip(result.stderr || result.stdout);
          throw new ValueError(`installer exited ${result.returncode}${detail ? `: ${detail}` : ''}`);
        }
        if (name === 'codex') {
          const registered = json_loads(result.stdout);
          if (!(registered instanceof Map) || typeof dictGet(registered, 'path') !== 'string') {
            const detail = pyStrip(result.stdout || result.stderr);
            throw new ValueError(`Codex registration returned unexpected output${detail ? `: ${detail}` : ''}`);
          }
          const cli = impl.locate_codex_tools(resources, { windows: platform() === 'win32' }).cli;
          impl.install_hooks(cli, registered.get('path'), cwd, env, original_plugins, setup_command);
        } else if (name === 'claude-code' && phase === 'MCP') {
          impl.claude_visibility_install(home, { project: scope === 'project' ? project : null });
          const mod = impl.claude_mod_install(home, release_root, { project: scope === 'project' ? project : null });
          print(`${client.label}: approval mod installed at ${mod}.`);
        }
        print(`${client.label}: ${phase} registered.`);
        if (phase === name_final_phase(name)) apply_approval(name, client, codex_plan);
      } catch (exc) {
        if (!isException(exc)) throw exc;
        failures.push([name, phase, describe(exc)]);
        eprint(`${client.label}: ${phase} failed: ${describe(exc)}`);
      }
    }
  }
  return failures;
}

export async function export_bundle(destination, command, release_root, { chrome = false, audio = false } = {}) {
  destination = regular_path(destination);
  if (path_exists(destination)) throw new ValueError('Export destination already exists; choose a new directory.');
  const policy = toMap(impl.host_policy(release_root));
  // Re-run flags for the destinationSetup metadata.
  const setup_flags = (chrome ? '--chrome ' : '') + (audio ? '--audio ' : '');
  const installation = json_loads(read_text(join_path(release_root, 'installation.json')));
  const target = dictGet(installation, 'platform', 'linux');
  const resource_root = target === 'darwin' ? 'Contents/Resources' : 'resources';
  const manifest = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'lcu', description: 'Computer use through the locally installed Codex runtime.',
  };
  // A cross-machine export cannot retain the producer's prefix or account.
  // Resolve the destination's selected release when its MCP client starts.
  const launch = 'set -eu; case "$(uname -s)" in '
    + 'Darwin) default_prefix="$HOME/.local/share/lcu"; default_session=direct;; '
    + 'Linux) default_prefix=/opt/lcu; default_session=discover;; '
    + '*) echo "Unsupported LCU platform" >&2; exit 2;; esac; '
    + 'prefix=${LCU_PREFIX:-$default_prefix}; '
    + 'case "$prefix" in /*) ;; *) echo "LCU_PREFIX must be absolute" >&2; exit 2;; esac; '
    + 'case "${LCU_SESSION_MODE:-$default_session}" in '
    + 'direct) exec "$prefix/current/bin/lcu" "$@";; '
    + 'discover) exec "$prefix/current/bin/lcu-session" --user "$(id -un)" -- '
    + '"$prefix/current/bin/lcu" "$@";; '
    + '*) echo "LCU_SESSION_MODE must be discover or direct" >&2; exit 2;; esac';
  const runtime_flags = (chrome ? ['--chrome'] : []).concat(audio ? ['--audio'] : []);
  const portable_command = ['/bin/sh', '-c', launch, 'lcu-export', ...runtime_flags];
  const codex_launch = 'set -eu; case "$(uname -s)" in '
    + 'Darwin) default_prefix="$HOME/.local/share/lcu"; default_session=direct;; '
    + 'Linux) default_prefix=/opt/lcu; default_session=discover;; '
    + '*) echo "Unsupported LCU platform" >&2; exit 2;; esac; '
    + 'prefix=${LCU_PREFIX:-$default_prefix}; '
    + 'case "$prefix" in /*) ;; *) echo "LCU_PREFIX must be absolute" >&2; exit 2;; esac; '
    + 'node="$prefix/current/agent-tools/node/bin/node"; '
    + 'adapter="$prefix/current/adapters/codex.mjs"; '
    + 'server="$prefix/current/bin/lcu"; '
    + 'case "${LCU_SESSION_MODE:-$default_session}" in '
    + 'direct) exec "$node" "$adapter" "$server" "$@";; '
    + 'discover) exec "$prefix/current/bin/lcu-session" --user "$(id -un)" -- '
    + '"$node" "$adapter" "$server" "$@";; '
    + '*) echo "LCU_SESSION_MODE must be discover or direct" >&2; exit 2;; esac';
  const portable_codex_command = ['/bin/sh', '-c', codex_launch, 'lcu-export', ...runtime_flags];
  const mcp = { mcpServers: { lcu: { type: 'stdio', command: portable_command[0], args: portable_command.slice(1) } } };
  const document = (value) => Buffer.from(`${json_dumps(value, { indent: 2 })}\n`);
  const changes = [new Change(join_path(destination, 'plugin.json'), null, document(manifest)),
    new Change(join_path(destination, 'mcp.json'), null, document(mcp)),
    new Change(join_path(destination, 'host-contract.json'), null, document(policy))];
  const bootstrap_metadata = {
    requiresInstalledApplication: true,
    computerAudioOptIn: audio
      ? 'Enabled in the registered MCP command with --audio. The original optional recording API may require its own approval. A saved audio file does not mean the selected model receives audio. LCU does not add audio-specific instructions.'
      : 'Disabled unless the caller explicitly sets both original audio environment flags.',
    applicationResourceRoot: resource_root,
    destinationSetup: 'Install the matching thin LCU archive and selected application, then run '
      + `lcu setup --export /new/path ${setup_flags}`
      + '--yes on the destination account and import that newly generated export.',
    runtimePrefix: 'Set LCU_PREFIX for a nondefault destination prefix: /opt/lcu on Linux, $HOME/.local/share/lcu on macOS.',
    sessionMode: 'Linux defaults to XFCE discovery; set LCU_SESSION_MODE=direct inside its desktop session. macOS defaults to direct.',
    instructions: 'The original MCP server instructions, tool descriptions and tool results, as in official Codex; no skill.',
  };
  changes.push(new Change(join_path(destination, 'lcu-bootstrap.json'), null, document(bootstrap_metadata)));
  const codex = new Map([['mcpServers', new Map([['lcu', new Map([...policy,
    ['command', portable_codex_command[0]], ['args', portable_codex_command.slice(1)]])]])]]);
  changes.push(new Change(join_path(destination, 'codex.mcp.json'), null, document(codex)));
  const resources = impl.installed_app_resources(release_root);
  const original_plugins = join_path(resources, 'plugins/openai-bundled');
  for (const [name, data] of entriesOf(impl.export_files(portable_codex_command, original_plugins))) {
    changes.push(new Change(join_path(destination, name), null, data));
  }
  await apply_changes_interruptible(changes);
}

/** The setup argument parser (single source: tests/compat/argparse_parsers.mjs mirrors this declaration). */
export function parser() {
  const p = new argparse.ArgumentParser({
    description: DOC,
    epilog: 'Run on the machine hosting the agent backend. For Codex SSH remote projects, that is the VM. This command never installs or authenticates the agent itself.',
  });
  const { Path } = argparse.types;
  let default_prefix;
  if (platform() === 'win32') {
    default_prefix = join_path(process.env.LOCALAPPDATA ?? join_path(compat_pathlib.pathExpanduser('~'), 'AppData/Local'), 'LCU');
  } else if (platform() === 'darwin') {
    default_prefix = join_path(compat_pathlib.pathExpanduser('~'), '.local/share/lcu');
  } else {
    default_prefix = '/opt/lcu';
  }
  p.add_argument('--prefix', {
    type: Path,
    default: Path(default_prefix),
    help: 'Runtime prefix (Linux: /opt/lcu; macOS: ~/.local/share/lcu; Windows: %%LOCALAPPDATA%%\\LCU)',
  });
  p.add_argument('--user', { help: 'Target account; root must select one explicitly' });
  p.add_argument('--agent', { action: 'append', default: [], help: 'Agent ID; repeat for several, all for every supported client, or auto for detected clients. Use --list-agents.' });
  p.add_argument('--scope', { choices: ['user', 'project'], default: 'user' });
  p.add_argument('--project', { type: Path, help: 'Absolute existing project directory for project scope' });
  p.add_argument('--yes', { action: 'store_true', help: 'Apply explicit choices without a confirmation prompt' });
  p.add_argument('--list-agents', { action: 'store_true', help: 'List supported adapters and exit' });
  p.add_argument('--export', { type: Path, help: 'Export a portable tools plugin for custom clients to a new directory' });
  p.add_argument('--chrome', { action: 'store_true', help: 'Opt into original Chrome control, extension connector, and browser guidance' });
  p.add_argument('--no-chrome', { action: 'store_true', help: 'Disable Chrome control, overriding a saved opt-in' });
  p.add_argument('--audio', { action: 'store_true', help: 'Opt into the original optional computer-audio recording API' });
  p.add_argument('--no-audio', { action: 'store_true', help: 'Disable computer-audio recording, overriding a saved opt-in' });
  p.add_argument('--approval', {
    choices: ['ask', 'auto'],
    help: 'optional, for unattended machines: auto adds only LCU\'s own harness approval entries so its tools run without a per-call prompt (per-app approval stays); '
      + 'ask removes exactly those entries and leaves harness defaults (the default, kept from the previous setup)',
  });
  p.add_argument('--session', {
    choices: ['discover', 'direct'],
    default: ['darwin', 'win32'].includes(platform()) ? 'direct' : 'discover',
    help: 'discover attaches through lcu-session (XFCE); direct uses the current desktop account',
  });
  p.add_argument('--allow-missing', {
    action: 'store_true',
    help: 'Skip pi, omp and hermes when their executable is not installed yet and record them as pending '
      + '(Codex and Claude Code still register); exit 0 when that is the only problem. '
      + '`lcu setup --reconcile` registers them once they appear',
  });
  p.add_argument('--reconcile', {
    action: 'store_true',
    help: 'Register pending harnesses that are now installed, using the saved opt-ins and approval mode; '
      + 'non-interactive, idempotent, and silent when there is nothing to do',
  });
  p.add_argument('--browser-host', { action: 'store_true', help: argparse.SUPPRESS });
  p.add_argument('--check-desktop', {
    action: 'store_true',
    help: 'Require live desktop readiness after setup; never opens System Settings automatically',
  });
  p.add_argument('--validate-only', { action: 'store_true', help: argparse.SUPPRESS });
  return p;
}

const pathArg = (args, key) => {
  const value = args.get(key);
  return value === null || value === undefined ? null : String(value);
};

/** Validate parsed arguments; returns [account, names]. */
export function validate(args) {
  if (args.get('browser_host')) {
    throw new ValueError('--browser-host was removed; use `lcu setup --agent AGENT --chrome` for external Chrome. Embedded in-app browser hosting is not supported.');
  }
  if (args.get('reconcile')) {
    const used = [
      ['--agent', args.get('agent')], ['--export', args.get('export')], ['--approval', args.get('approval')],
      ['--chrome', args.get('chrome')], ['--no-chrome', args.get('no_chrome')], ['--audio', args.get('audio')],
      ['--no-audio', args.get('no_audio')], ['--project', args.get('project')], ['--check-desktop', args.get('check_desktop')],
      ['--allow-missing', args.get('allow_missing')], ['--scope', args.get('scope') !== 'user'],
    ].filter(([, value]) => truthy(value)).map(([flag]) => flag);
    if (used.length) {
      throw new ValueError(`--reconcile uses the saved setup and cannot be combined with ${used.join(', ')}.`);
    }
  }
  if (args.get('allow_missing') && args.get('export')) {
    throw new ValueError('--allow-missing configures a harness; it cannot be combined with --export.');
  }
  if (args.get('chrome') && args.get('no_chrome')) throw new ValueError('Use either --chrome or --no-chrome, not both.');
  if (args.get('audio') && args.get('no_audio')) throw new ValueError('Use either --audio or --no-audio, not both.');
  const prefix = pathArg(args, 'prefix');
  if (!is_absolute(prefix) || path_parts(prefix).length < 3 || path_parts(prefix).includes('..') || hasControl(prefix)) {
    throw new ValueError('Use a dedicated absolute prefix, such as /opt/lcu.');
  }
  let account;
  if (platform() === 'win32') {
    const username = impl.getuser();
    const user = args.get('user');
    if (truthy(user) && casefold(user) !== casefold(username)) {
      throw new ValueError('Windows setup only configures the current signed-in account.');
    }
    account = { pw_name: username, pw_uid: null, pw_dir: process.env.USERPROFILE ?? compat_pathlib.pathExpanduser('~') };
    if (args.get('session') !== 'direct') throw new ValueError('Windows requires --session direct.');
    if (args.get('export')) throw new ValueError('Windows portable export is not implemented; select --agent instead.');
  } else {
    const user = args.get('user');
    if (impl.getuid() === 0 && user === null) throw new ValueError('Root must specify --user ACCOUNT.');
    try {
      account = truthy(user) ? impl.getpwnam(user) : impl.getpwuid(impl.getuid());
    } catch (exc) {
      if (exc instanceof PyKeyError || exc?.name === 'KeyError') {
        throw new ValueError('The selected account does not exist. Create it before setup.');
      }
      throw exc;
    }
    if (![0, account.pw_uid].includes(impl.getuid())) throw new ValueError('Run as the selected account or root.');
  }
  if (!is_absolute(account.pw_dir) || !is_dir(account.pw_dir)) {
    throw new ValueError('Selected account must have an existing absolute home directory.');
  }
  const project = pathArg(args, 'project');
  if (args.get('scope') === 'project') {
    if (project === null || !is_absolute(project) || !is_dir(project)) {
      throw new ValueError('--scope project requires --project with an existing absolute directory.');
    }
  } else if (project !== null) {
    throw new ValueError('--project requires --scope project.');
  }
  const export_path = pathArg(args, 'export');
  const agent = args.get('agent');
  if (export_path !== null && agent.length) throw new ValueError('Choose --export or --agent, not both.');
  if (export_path !== null && args.get('approval')) {
    throw new ValueError('--approval configures a harness; it cannot be combined with --export.');
  }
  if (export_path !== null) {
    if (!is_absolute(export_path)) throw new ValueError('--export requires an absolute path.');
    regular_path(export_path);
    if (path_exists(export_path)) throw new ValueError('Export destination already exists; choose a new directory.');
  }
  let names = [...new Set(agent.map((name) => (Object.hasOwn(ALIASES, name) ? ALIASES[name] : name)))];
  const unknown = names.filter((name) => !Object.hasOwn(CLIENTS, name) && name !== 'auto' && name !== 'all');
  if (unknown.length) {
    throw new ValueError(`Unknown agent: ${[...new Set(unknown)].sort(compareCodePoints).join(', ')}. Run lcu setup --list-agents, or use --export for a custom client.`);
  }
  if (names.some((name) => name === 'auto' || name === 'all') && names.length > 1) {
    throw new ValueError('Use --agent all or --agent auto alone, or select explicit agent IDs.');
  }
  if (names.length === 1 && names[0] === 'all') names = Object.keys(CLIENTS);
  if (!(names.length === 1 && names[0] === 'auto')) validate_agent_scope(names, args.get('scope'));
  return [account, names];
}

// Native harness plugins are profile-scoped; project scope is unsupported.
export const USER_ONLY_AGENTS = new Set(['omp', 'hermes']);

export function agent_scopes(name) {
  return USER_ONLY_AGENTS.has(name) ? 'user' : 'user, project';
}

export function validate_agent_scope(names, scope) {
  if (scope === 'project' && names.some((name) => USER_ONLY_AGENTS.has(name))) {
    throw new ValueError('Oh My Pi and Hermes native plugins are profile-scoped. Use --scope user with the intended profile; project scope is not supported.');
  }
}

export function detect(home) {
  return Object.entries(CLIENTS)
    .filter(([, client]) => impl.which(client.executable) || path_exists(join_path(home, client.detect_path)))
    .map(([name]) => name);
}

export async function choose_agents(home) {
  const detected = detect(home);
  print('Select one or more agents for this account (comma-separated IDs).');
  for (const [name, client] of Object.entries(CLIENTS)) {
    print(`  ${name.padEnd(16)} ${client.label}${detected.includes(name) ? ' [detected]' : ''}`);
  }
  print('Use all for every supported client, including those not installed yet.\nFor other clients, cancel and use --export /absolute/new/plugin-directory.');
  const answer = pyStrip(await impl.input('Agents: '));
  let names = [...new Set(answer.split(',').map((n) => pyStrip(n)).filter(Boolean)
    .map((n) => (Object.hasOwn(ALIASES, n) ? ALIASES[n] : n)))];
  if (names.length === 1 && names[0] === 'all') return Object.keys(CLIENTS);
  if (names.length === 1 && names[0] === 'auto') names = detected;
  if (!names.length || names.some((name) => !Object.hasOwn(CLIENTS, name))) {
    throw new ValueError('Choose supported agent IDs, or use --export for a custom client.');
  }
  return names;
}

const argOf = (args, key) => (typeof args.get === 'function' ? args.get(key) : args[key]);

export function desktop_readiness_mode(args, { interactive }) {
  if (argOf(args, 'check_desktop')) return 'required';
  if (argOf(args, 'export')) return 'skip';
  if (argOf(args, 'yes') || !interactive) return 'deferred';
  return 'guided';
}

/** Choose the post-registration doctor invocation and timeout: [mode, command, timeout]. */
export function desktop_readiness_request(args, { interactive, desktop_command }) {
  const mode = desktop_readiness_mode(args, { interactive });
  if (mode === 'skip') return [mode, null, null];
  const doctor = [...desktop_command, 'doctor'];
  if (mode === 'required') return [mode, [...doctor, '--non-interactive', '--require-ready'], 50];
  // Guided and deferred both run the plain doctor without a bounded timeout;
  // a person may need as long as they like to read settings guidance.
  return [mode, doctor, null];
}

/** Run a doctor check with bounded time only when no human interaction is needed. */
export function run_desktop_doctor(command, { timeout = null, runner = null } = {}) {
  if (runner === null || runner === undefined) runner = impl.run;
  const options = { check: false };
  if (timeout !== null) options.timeout = timeout;
  return runner(command, options);
}

/** Release root, runtime launcher, session launcher and the desktop command for the selected session mode. */
export function runtime_paths(args, account, session = null) {
  session = session || args.get('session');
  const prefix = pathArg(args, 'prefix');
  if (platform() === 'win32') {
    const release_root = impl.release_dir();
    const runtime = join_path(prefix, 'lcu.cmd');
    // The registered command runs the validating, quarantining <prefix>\lcu.cmd through cmd.exe; lcu.cmd
    // resolves the current generation at run time. Runtime and "launcher" are both lcu.cmd.
    return [release_root, runtime, runtime, windows_registration_command(prefix)];
  }
  const release_root = join_path(prefix, 'current');
  const runtime = join_path(release_root, 'bin/lcu');
  const launcher = join_path(release_root, 'bin/lcu-session');
  const desktop_command = session === 'direct' ? [runtime] : [launcher, '--user', account.pw_name, '--', runtime];
  return [release_root, runtime, launcher, desktop_command];
}

// Characters cmd.exe treats specially even inside the quotes Windows argument quoting adds (`%` and `!` expand,
// `"` ends the quoting), or that make `cmd /c` strip the outer quotes of a quoted command (`&<>()@^|`).
const CMD_UNSAFE = /[%"!&<>()@^|\x00-\x1f]/;

/**
 * The Windows registration command (BRIEF addendum G, installer decision in .port/requests/setup.md):
 *   [<SystemRoot>\System32\cmd.exe, "/d", "/c", "<prefix>\lcu.cmd"]   (+ LCU's own fixed flags, e.g. --chrome)
 * <prefix>\lcu.cmd checks node.exe's digest and every path component for reparse points and quarantines the
 * Node startup variables before LCU's Node runs, then selects the current release; registering it (instead of
 * node.exe directly) keeps those checks and survives generation pruning. SystemRoot comes from the setup-time
 * environment (absolute only), else C:\Windows. No user-controlled string is ever part of the argv; a prefix with
 * a character cmd cannot pass safely is refused rather than registered.
 */
export function windows_registration_command(prefix) {
  const env = process.env.SystemRoot || process.env.SYSTEMROOT || '';
  const root = env && winIsAbsolute(env) ? env : 'C:\\Windows';
  const command = [winPathStr(root, 'System32\\cmd.exe'), '/d', '/c', join_path(prefix, 'lcu.cmd')];
  for (const part of [command[0], command[3]]) {
    if (CMD_UNSAFE.test(part)) {
      throw new ValueError(`The Windows command processor cannot run ${part} safely: remove % " ! & < > ( ) @ ^ | `
        + 'from the LCU prefix (reinstall LCU into another --prefix), then rerun setup.');
    }
  }
  return command;
}

/** Guard before registering on Windows: the argv is exactly windows_registration_command() plus LCU's own flags. */
export function assert_windows_registration(command) {
  const [cmd, d, c, script, ...flags] = command;
  const ok = typeof cmd === 'string' && /[\\/]System32[\\/]cmd\.exe$/i.test(cmd) && d === '/d' && c === '/c'
    && /[\\/]lcu\.cmd$/i.test(script) && !CMD_UNSAFE.test(cmd) && !CMD_UNSAFE.test(script)
    && flags.every((flag) => ['--chrome', '--audio'].includes(flag));
  if (!ok) throw new ValueError(`Refusing to register a Windows command LCU did not build: ${py_str(command)}`);
}

/**
 * The installer's <prefix>/launcher.json {"node", "dispatcher", "python"}: the generation node.exe and
 * windows_launcher.mjs lcu.cmd runs (python: the bridge's interpreter for pre-port releases; not used here).
 * Used for launcher pins and to recognise the interim direct registration form.
 */
export function windows_launcher(prefix) {
  const descriptor = join_path(prefix, 'launcher.json');
  let node = join_path(prefix, 'launcher-runtimes/current/node.exe');
  let dispatcher = join_path(prefix, 'launcher-runtimes/current/dispatcher.mjs');
  if (path_exists(descriptor)) {
    try {
      const data = json_loads(read_text(descriptor));
      if (data instanceof Map && typeof data.get('node') === 'string' && typeof data.get('dispatcher') === 'string') {
        node = data.get('node');
        dispatcher = data.get('dispatcher');
      }
    } catch (exc) {
      if (!isValueError(exc) && !isOSError(exc)) throw exc;
    }
  }
  return [node, dispatcher];
}

/**
 * LCU-owned Windows registration forms (for reconcile/removal by name of their launcher, never by content):
 *   'python': [python.exe, '-B', <prefix>\windows_launcher.py, ...]   (pre-port releases)
 *   'node':   [node.exe, <prefix>\windows_launcher.mjs or a dispatcher.mjs, ...]  (interim direct form)
 *   'cmd':    [...\System32\cmd.exe, '/d', '/c', <prefix>\lcu.cmd, ...]  (current)
 * Returns the form name, or null for anything else.
 */
export function windows_command_form(command) {
  if (!Array.isArray(command) || command.length < 2) return null;
  const at = (i) => String(command[i] ?? '');
  if (command.length >= 3 && at(1) === '-B' && /(^|[\\/])windows_launcher\.py$/i.test(at(2))) return 'python';
  if (/(^|[\\/])node(\.exe)?$/i.test(at(0)) && /(^|[\\/])(windows_launcher|dispatcher)\.mjs$/i.test(at(1))) return 'node';
  if (command.length >= 4 && /(^|[\\/])cmd\.exe$/i.test(at(0)) && at(1).toLowerCase() === '/d' && at(2).toLowerCase() === '/c'
      && /(^|[\\/])lcu\.cmd$/i.test(at(3))) return 'cmd';
  return null;
}

/** True for an older LCU-owned Windows registration (the Python or the direct-Node form). */
export function is_legacy_windows_command(command) {
  const form = windows_command_form(command);
  return form === 'python' || form === 'node';
}

export const LAUNCHER_PINS = 'launcher-pins.json';

/**
 * Windows only. Registrations now run <prefix>\lcu.cmd, which resolves the current generation at run time, so
 * pins only matter for the interim direct form ([node.exe, windows_launcher.mjs], see windows_command_form) that
 * embedded an absolute node.exe from one private app generation (<prefix>/apps/<digest>/...); they are still
 * written for safety. `launcher` is windows_launcher(prefix): [node.exe, dispatcher] of the generation current at
 * registration time. Before registering, record it per LCU-owned registration in <prefix>/launcher-pins.json:
 *
 *   {
 *     "registrations": {
 *       "<harness>|<scope>|<project directory or empty>": "<absolute node.exe the registration runs>"
 *     }
 *   }
 *
 * (pyjson indent=2, trailing newline, insertion order). Re-registering a harness in a scope replaces its
 * entry, so rerunning setup after an update re-pins it to the current generation. maintenance.mjs keeps every
 * app generation containing a pinned path (contract: .port/requests/maintenance.md). Written before the
 * registration, so a registration is never left unpinned; a failed registration keeps its pin.
 */
export function record_launcher_pins(prefix, names, scope, project, launcher) {
  if (platform() !== 'win32' || !names.length) return;
  check_lock();
  const path = join_path(prefix, LAUNCHER_PINS);
  const before = read_file(path);
  let document = new Map([['registrations', new Map()]]);
  if (before !== null) {
    let parsed;
    try {
      parsed = json_loads(before);
    } catch (exc) {
      if (!(exc instanceof JSONDecodeError || exc instanceof UnicodeDecodeError)) throw exc;
      parsed = null;
    }
    const registrations = parsed instanceof Map ? dictGet(parsed, 'registrations') : null;
    if (!(registrations instanceof Map) || ![...registrations.values()].every((v) => typeof v === 'string')) {
      throw new ValueError(`Malformed LCU launcher pins at ${path}; check it, then delete it and rerun setup.`);
    }
    document = parsed;
  }
  const registrations = document.get('registrations');
  for (const name of names) registrations.set(`${name}|${scope}|${project ?? ''}`, String(launcher[0]));
  const after = Buffer.from(`${json_dumps(document, { indent: 2 })}\n`);
  if (before === null || !bytes_equal(before, after)) atomic_write(path, after);
}

/** Register pending harnesses that have appeared since setup; quiet and cheap when there are none. */
export async function reconcile(args, account, home) {
  const path = harness_search_path(home);

  const ready_harnesses = (state) => state.pending.filter((name) => harness_installed(name, home, path));

  try {
    // Unlocked first look: the common login-time run reads one small file and exits.
    if (!ready_harnesses(load_setup_state(home)).length) return;
    const lock = await impl.setup_lock(home);
    active_lock = lock;
    try {
      // Another setup or reconcile may have registered them while this one waited.
      const state = load_setup_state(home);
      const ready = ready_harnesses(state);
      if (!ready.length) return;
      const context = state.pending_context || new Map([['scope', 'user'], ['project', null], ['session', args.get('session')]]);
      // context['key']: a saved context without a key is a KeyError, as in Python.
      const context_project = subscript(context, 'project');
      const project = context_project ? path_str(context_project) : null;
      if (subscript(context, 'scope') === 'project' && (!project || !is_dir(project))) {
        throw new ValueError(`Saved project directory is missing: ${py_str(context_project)}. `
          + 'Rerun `lcu setup --agent all --allow-missing --scope project --project PATH`.');
      }
      const [release_root, runtime, launcher, desktop_command] = impl.runtime_paths(args, account, subscript(context, 'session'));
      for (const item of [runtime, launcher]) {
        if (!is_file(item) || !x_ok(item)) throw new ValueError(`Managed runtime missing or inaccessible: ${item}.`);
      }
      const runtime_flags = (state.chrome ? ['--chrome'] : []).concat(state.audio ? ['--audio'] : []);
      const direct_runtime = platform() === 'win32' ? desktop_command : [runtime];
      await impl.run([...direct_runtime, '--version'], { check: true, timeout: 20, stdout: DEVNULL });
      const tools_root = join_path(release_root, 'agent-tools');
      const environment = { ...process.env, PATH: path };
      impl.installer_environment(home, ready, environment);
      impl.installer_paths(tools_root);
      print(`LCU: registering ${ready.map((name) => CLIENTS[name].label).join(', ')} (installed since setup) with the saved settings.`);
      const reconcile_command = [...desktop_command, ...runtime_flags];
      if (platform() === 'win32') {
        assert_windows_registration(reconcile_command);
        record_launcher_pins(pathArg(args, 'prefix'), ready, subscript(context, 'scope'), project, windows_launcher(pathArg(args, 'prefix')));
      }
      check_lock();
      const failures = await impl.configure(ready, home, reconcile_command, tools_root, release_root, {
        scope: subscript(context, 'scope'), project, setup_command: runtime, environ: environment,
        approval: state.approval === 'auto' ? 'auto' : null,
      });
      await checkpoint();
      const failed = new Set(failures.map((item) => item[0]));
      const remaining = state.pending.filter((name) => !ready.includes(name) || failed.has(name));
      check_lock();
      save_setup_state(home, {
        chrome: state.chrome, audio: state.audio, approval: state.approval, pending: remaining, pending_context: context,
      });
      if (failures.length) {
        throw new ValueError(`${failures.length} registration step(s) failed; still pending: ${remaining.join(', ')}. `
          + 'Fix the errors above; the next reconcile retries.');
      }
      print(`Registered: ${ready.join(', ')}. Restart or reconnect those harnesses.`);
    } finally {
      active_lock = null;
      lock.release();
    }
  } catch (exc) {
    if (!isExpectedError(exc)) throw exc;
    parser_exit(parser(), 1, `Reconcile failed: ${str_exc(exc)}\n`);
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * `lcu setup ...`. Async: the whole command runs under with_interrupt_guard (SIGINT -> KeyboardInterrupt with
 * Python's rollback/finally semantics). Output before the first await (argparse, --list-agents) is synchronous.
 */
export async function main(argv = null) {
  return with_interrupt_guard(async () => {
    await main_body(argv);
    await checkpoint();
  });
}

async function main_body(argv) {
  const p = parser();
  const args = p.parse_args(argv);
  if (args.get('list_agents')) {
    for (const [name, client] of Object.entries(CLIENTS)) {
      print(`${name.padEnd(16)} ${client.label} (${agent_scopes(name)})`);
    }
    print('Custom clients: --export /absolute/new/plugin-directory');
    return;
  }
  try {
    const [account, validated_names] = impl.validate(args);
    let names = validated_names;
    const export_path = pathArg(args, 'export');
    if (args.get('validate_only')) {
      if (export_path === null) {
        // Another account must never inherit the caller's profile overrides.
        const environment = platform() !== 'win32' && impl.getuid() === 0 && account.pw_uid !== 0 ? {} : process.env;
        impl.installer_environment(account.pw_dir, names, environment);
      }
      return;
    }
    // Account files are always written as their owner, including image builds.
    if (platform() !== 'win32' && impl.getuid() === 0 && account.pw_uid !== 0) becomeAccount(account);
    const home = account.pw_dir;
    if (args.get('reconcile')) return await reconcile(args, account, home);
    const [release_root, runtime, launcher, desktop_command] = impl.runtime_paths(args, account);
    for (const path of [runtime, launcher]) {
      if (!is_file(path) || !x_ok(path)) {
        throw new ValueError(`Managed runtime missing or inaccessible: ${path}. Run scripts/install.sh first, or select its --prefix.`);
      }
    }
    if (names.length === 1 && names[0] === 'auto') {
      names = detect(home);
      if (!names.length && !args.get('allow_missing')) {
        throw new ValueError('No agents detected. Select --agent explicitly (works before the agent is installed), or use --export.');
      }
    }
    if (!names.length && export_path === null) {
      if (!impl.isatty()) {
        throw new ValueError('Noninteractive setup requires --agent ID (repeatable), --agent all, --agent auto, or --export PATH.');
      }
      names = await choose_agents(home);
    }
    validate_agent_scope(names, args.get('scope'));
    let missing = [];
    let setup_environment = null;
    if (args.get('allow_missing')) {
      // Registration through each harness's own CLI needs that CLI; defer those harnesses.
      setup_environment = { ...process.env, PATH: harness_search_path(home) };
      missing = names.filter((name) => NEEDS_BINARY.includes(name) && !harness_installed(name, home));
      names = names.filter((name) => !missing.includes(name));
    }
    const direct_runtime = platform() === 'win32' ? desktop_command : [runtime];
    await impl.run([...direct_runtime, '--version'], { check: true, timeout: 20, stdout: DEVNULL });
    const tools_root = join_path(release_root, 'agent-tools');
    if (export_path === null) {
      impl.installer_environment(home, names);
      impl.installer_paths(tools_root);
    }
    const setup_command = runtime;
    const lock = await impl.setup_lock(home);
    active_lock = lock;
    try {
      const state = load_setup_state(home);
      // A saved choice, including a declined prompt, suppresses the prompt.
      const saved = is_file(setup_state_path(home));
      // Explicit flags win; otherwise a saved opt-in is kept.
      let audio;
      if (args.get('audio')) {
        audio = true;
      } else if (args.get('no_audio')) {
        audio = false;
      } else if (state.audio) {
        audio = true;
        print('Keeping computer-audio recording enabled from the previous setup (use --no-audio to disable).');
      } else {
        audio = false;
      }
      let chrome;
      if (args.get('chrome')) {
        chrome = true;
      } else if (args.get('no_chrome')) {
        chrome = false;
      } else if (state.chrome) {
        chrome = true;
        print('Keeping Chrome control enabled from the previous setup (use --no-chrome to disable).');
      } else if (!saved && !args.get('yes') && impl.isatty()) {
        chrome = ['y', 'yes'].includes(pyStrip(await impl.input('Enable Chrome browser control and its extension connector? [y/N] ')).toLowerCase());
      } else {
        chrome = false;
      }
      args.set('chrome', chrome);
      args.set('audio', audio);
      // `ask` keeps harness defaults. A saved `auto` is reapplied to each harness and scope
      // selected now; an explicit `--approval ask` is the only thing that removes entries.
      let approval_mode;
      if (args.get('approval')) {
        approval_mode = args.get('approval');
      } else if (state.approval === 'auto') {
        approval_mode = 'auto';
        print('Keeping automatic approval of LCU tools from the previous setup (use --approval ask to restore harness defaults).');
      } else {
        approval_mode = 'ask';
      }
      const approval_action = approval_mode === 'auto' ? 'auto' : (args.get('approval') === 'ask' ? 'ask' : null);
      const runtime_flags = (chrome ? ['--chrome'] : []).concat(audio ? ['--audio'] : []);
      const command = [...desktop_command, ...runtime_flags];
      if (export_path !== null) {
        print(`Export tools to ${export_path}`);
      } else {
        for (const name of missing) {
          print(`${CLIENTS[name].label}: not installed; will register when it appears `
            + `(\`${setup_command} setup --reconcile\` registers it with these settings).`);
        }
        if (names.length) print(`Configure ${names.join(', ')} for ${account.pw_name} (${args.get('scope')} scope).`);
        print('Existing LCU MCP entries will be updated and any old LCU skill removed; unrelated configuration is preserved.');
        if (names.includes('codex')) {
          print('Codex: install and trust the original Stop, Interrupt, and SubagentStop cleanup hooks for LCU.');
        }
      }
      if (args.get('chrome')) {
        print('Chrome control selected: register the original extension connector for this desktop account and include Chrome guidance.');
        if (names.includes('claude-code')) {
          print('Claude Code: original turn cleanup runs on normal Stop and active MCP-call cancellation. Esc during model wait after a tool completes has no cleanup event and may leave temporary tabs open; Chrome remains experimental.');
        }
      } else {
        print('Native desktop control selected; Chrome connector and guidance are excluded.');
      }
      if (approval_mode === 'auto' && export_path === null) {
        const entries = {
          'claude-code': 'Claude Code: allow `mcp__lcu__js` and `mcp__lcu__js_reset`',
          codex: 'Codex: `approval_mode = "approve"` for the `js` and `js_reset` tools of `[mcp_servers.lcu]`',
          omp: 'Oh My Pi: `tools.approval` `js` and `js_reset` set to `allow`',
        };
        const chosen = names.filter((name) => Object.hasOwn(entries, name)).map((name) => entries[name]);
        print('Approval mode auto: add only LCU\'s own entries so its tools run without a per-call harness prompt'
          + (chosen.length ? `: ${chosen.join('; ')}` : '') + '. '
          + (names.includes('pi') || names.includes('hermes') ? 'Pi and Hermes have no such gate. ' : '')
          + 'Native-app and Chrome approvals from the original runtime are unchanged.');
      } else if (approval_action === 'ask' && export_path === null) {
        print('Approval mode ask: remove only the entries `--approval auto` added, restoring harness defaults.');
      }
      if (args.get('audio')) {
        print('Computer audio selected: enable the original optional recording API and its approval flow. A saved audio file is not model audio input.');
      }
      if (platform() === 'win32' && names.includes('claude-code')) {
        print('Claude Code: original turn cleanup runs on normal Stop and active MCP-call cancellation. Esc during model wait after a tool completes has no cleanup event and may leave native helpers active.');
      }
      impl.report_tested_pair(release_root);
      await checkpoint();
      if (!args.get('yes')) {
        if (!impl.isatty()) throw new ValueError('Review the selection above, then rerun with --yes for noninteractive setup.');
        if (!['y', 'yes'].includes(pyStrip(await impl.input('Apply this setup? [y/N] ')).toLowerCase())) {
          print('Cancelled; no agent configuration changed.');
          return;
        }
      }
      if (args.get('chrome')) {
        // The original native host is a per-account browser connection.
        check_lock();
        impl.browser_install(release_root);
        await checkpoint();
      }
      check_lock();
      remove_generated_skill(home);
      await checkpoint();
      let failures = [];
      if (export_path !== null) {
        await impl.export_bundle(export_path, command, release_root, { chrome, audio });
      } else {
        if (platform() === 'win32' && names.length) {
          assert_windows_registration(command);
          record_launcher_pins(pathArg(args, 'prefix'), names, args.get('scope'), pathArg(args, 'project'), windows_launcher(pathArg(args, 'prefix')));
        }
        check_lock();
        failures = names.length ? await impl.configure(names, home, command, tools_root, release_root, {
          scope: args.get('scope'), project: pathArg(args, 'project'),
          setup_command, approval: approval_action, environ: setup_environment,
        }) : [];
      }
      await checkpoint();
      // Remember opt-ins even when registration failed, so a retry or `--reconcile` keeps them.
      // Harnesses registered now leave the pending set; a later reconcile applies the saved
      // chrome, audio and approval mode to the rest. A pending harness whose registration failed
      // stays pending.
      const failed = [...new Set(failures.map((item) => item[0]))];
      const pending = export_path !== null ? [] : [...new Set([...state.pending, ...missing])]
        .filter((name) => !names.includes(name) || failed.includes(name));
      check_lock();
      save_setup_state(home, {
        chrome, audio, approval: approval_mode, pending,
        pending_context: pending.length
          ? (missing.length
            ? new Map([['scope', args.get('scope')], ['session', args.get('session')],
              ['project', pathArg(args, 'project')]])
            : state.pending_context)
          : null,
      });
      if (failures.length) {
        let retry = [...direct_runtime, 'setup', '--prefix', pathArg(args, 'prefix'), '--user', account.pw_name,
          '--scope', args.get('scope'), '--session', args.get('session'), '--yes'];
        if (pathArg(args, 'project') !== null) retry = retry.concat(['--project', pathArg(args, 'project')]);
        retry = retry.concat(chrome ? ['--chrome'] : ['--no-chrome']);
        retry = retry.concat(audio ? ['--audio'] : ['--no-audio']);
        // A defaulted `ask` must not be passed: it would remove approval entries.
        if (args.get('approval') || approval_mode === 'auto') retry = retry.concat(['--approval', approval_mode]);
        if (args.get('allow_missing')) retry = retry.concat(['--allow-missing']);
        for (const name of failed) retry = retry.concat(['--agent', name]);
        const steps = failures.map((item) => `${item[0]}: ${item[1]}`).join(', ');
        throw new ValueError(`${failures.length} registration step(s) failed (${steps}). Choices were saved; `
          + `completed steps remain installed. After resolving the errors, retry: ${shlex.join(retry)}`);
      }
      if (export_path === null && (missing.length || pending.length)) {
        print(`Registered now: ${names.join(', ') || 'none'}.`);
        print(`Pending (not installed): ${pending.join(', ') || 'none'}. Install them, then run \`${setup_command} setup --reconcile\` (safe at every login).`);
      }
    } finally {
      active_lock = null;
      lock.release();
    }
    print('Configuration prepared. Restart/reconnect the selected agent, then ask it to use LCU to inspect the desktop.');
    if (platform() === 'darwin') {
      const problem = impl.mac_socket_path_problem();
      if (problem) print(`Warning: ${problem}`);
    }
    if (args.get('chrome')) {
      try {
        const browser_status = await impl.run([...direct_runtime, 'browser', 'status'], { capture_output: true, text: true, timeout: 20 });
        const shown = pyStrip(browser_status.stdout ?? '');
        if (shown) print(shown);
        if (browser_status.returncode && !shown) {
          print(`Browser status unavailable; run \`${setup_command} browser status\` after setup.`);
        }
      } catch (exc) {
        if (!(isOSError(exc) || isSubprocessError(exc))) throw exc;
        print(`Browser status unavailable; run \`${setup_command} browser status\` after setup.`);
      }
    } else {
      print(`Chrome browser control not enabled; add it later with \`${setup_command} setup --agent AGENT --chrome\`; other saved opt-ins are kept.`);
    }
    if (!args.get('audio')) {
      print(`Computer-audio recording not enabled; add it later with \`${setup_command} setup --agent AGENT --audio\`; other saved opt-ins are kept.`);
    }
    if (export_path !== null) print('Import this plugin with a compatible client, or use its mcp.json with your custom agent.');
    const [mode, doctor, doctor_timeout] = desktop_readiness_request(args, {
      interactive: impl.isatty(), desktop_command,
    });
    if (mode === 'required') {
      print('Checking live desktop readiness. This check will not open System Settings.');
      let result;
      try {
        result = await run_desktop_doctor(doctor, { timeout: doctor_timeout });
      } catch (exc) {
        if (isKeyboardInterrupt(exc)) {
          parser_exit(p, 2, '\nAgent configuration is saved; the required desktop check was cancelled. '
            + 'Rerun lcu doctor to check readiness.\n');
        }
        if (!(isOSError(exc) || isSubprocessError(exc))) throw exc;
        parser_exit(p, 2, 'Agent configuration is saved, but desktop readiness was not verified. '
          + `Check the runtime, then rerun lcu doctor.\nDetails: ${str_exc(exc)}\n`);
      }
      if (result.returncode) {
        parser_exit(p, 2, 'Agent configuration is saved, but desktop readiness was not verified. '
          + 'Review the status above, then rerun lcu doctor.\n');
      }
      print('Desktop readiness check passed. Tool discovery still needs the first agent connection.');
    } else if (mode === 'guided') {
      print('Starting the guided desktop readiness check. Settings opens only if you choose a pane.');
      let result;
      try {
        result = await run_desktop_doctor(doctor, { timeout: doctor_timeout });
      } catch (exc) {
        if (isKeyboardInterrupt(exc)) {
          print('\nAgent configuration is saved. The guided check was cancelled; rerun lcu doctor when ready.');
        } else if (isOSError(exc) || isSubprocessError(exc)) {
          print(`Agent configuration is saved, but the guided check could not finish: ${str_exc(exc)}`);
          print('Reconnect your agent, then run lcu doctor to review desktop readiness.');
        } else throw exc;
        result = null;
      }
      if (result && result.returncode) {
        print('Agent configuration is saved, but desktop readiness remains unverified. '
          + 'Reconnect your agent and run lcu doctor after resolving the status above.');
      }
    } else if (mode === 'deferred') {
      print('Desktop readiness was not checked. Reconnect your agent, then run:');
      print(`  ${shlex.join(doctor)}`);
    }
  } catch (exc) {
    if (!isExpectedError(exc)) throw exc;
    parser_exit(p, 1, `Setup failed: ${str_exc(exc)}\n`);
  }
}

// ---------------------------------------------------------------------------------------------
// Patchable names (Python: module attributes). Intra-module calls above use impl.<name>.
Object.assign(impl, {
  installer_environment, installer_paths, installed_app_resources, host_policy, preflight_mcp,
  remove_old_skill, configure, validate, setup_lock, export_bundle, runtime_paths,
});
