// os.execve / os.execvpe equivalents on top of Node's process.execve.
//
// Two paths, chosen by the running Node:
//
// * Node >= 26.1.0: a failed execve(2) throws a catchable ErrnoException (nodejs/node#62878). That is
//   authoritative: the exec is attempted and its errno becomes Python's OSError text. Only Python's own
//   argument checks run first (TypeError/ValueError).
// * Older Node (22.15 - 26.0; the app's Node 24 today): a failed exec aborts the whole process (SIGABRT,
//   a native stack trace) where Python raises an OSError the caller can report. So the exec is only
//   attempted after a preflight that predicts the kernel's answer, in the kernel's order:
//     - the target and every #! interpreter: missing (ENOENT), non-searchable or non-directory path
//       component (EACCES, ENOTDIR), symlink loop (ELOOP), over-long name (ENAMETOOLONG), directory or
//       other non-regular file (EACCES), no execute permission or a noexec mount (EACCES: access(2)
//       X_OK reports noexec mounts on Linux);
//     - argument space (E2BIG): Linux counts every argv/envp string with its NUL, the file name and
//       argv/envp pointer storage against max(min(stack rlimit / 4, 6 MiB), 128 KiB), plus the
//       131072-byte per-string limit; macOS counts each string with its NUL plus an 8-byte pointer,
//       and the two NULL terminators, against kern.argmax (1 MiB). Both kernels report the target
//       first (measured: a missing file with oversized arguments is ENOENT);
//     - format: no #! and not ELF / Mach-O (ENOEXEC); Linux interpreter nesting deeper than the
//       kernel's bound (more than 5 #! levels: ELOOP); macOS #! pointing at another script (ENOEXEC);
//       Mach-O without a slice this CPU can run (EBADARCH; x86_64 counts on Apple silicon only when
//       Rosetta is installed); Linux ELF for another machine (ENOEXEC) only when binfmt_misc is
//       readable and has no handler that could take it.
//   Not predicted (on those Node versions they still abort, exactly as a bare process.execve would):
//   the file changing between check and exec, ETXTBSY (a writer holding the file open), loader/dynamic
//   linker failures, truncated binaries that pass the header checks, binfmt_misc handlers for non-ELF
//   formats, arguments within a few bytes of the E2BIG boundary (script interpreter strings).
//
// RESIDUAL (round-2 R02, accepted exception to Python's error parity; not fixable inside LCU): ETXTBSY (a task-owned
// executable that some process holds open for writing) is not predictable, so on Node < 26.1 (the app's Node 24 today)
// a failed exec(2) of that kind still aborts the process (SIGABRT with a native stack) where Python raises
// OSError(ETXTBSY). On Node >= 26.1 the failure is a catchable ErrnoException (nodejs/node#62878) and becomes Python's text.
// Reproduced on Node 24.11.1; documented in .port/requests/compat.md. LCU's own exec targets are release files it
// never holds open for writing.
//
// Standard streams: Node's process.execve must clear close-on-exec on fds 0-2 and throws when one is
// closed (Python would exec with it closed). That case is ExecUnsupportedError, a distinct error the
// caller must surface (not an OSError Python would raise).
//
// stdout/stderr data not yet flushed by Node is lost on exec, as it is in any exec; write
// synchronously before calling.
import { accessSync, closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';

import { fromNodeError, PyOSError, PyRepr, reprBytes, reprStr } from './pyerr.mjs';
import { ValueError } from './pyjson.mjs';
import { ignored_signals, reignore } from '../startup_vars.mjs';

export const DEFPATH = '/bin:/usr/bin'; // os.defpath on POSIX

/**
 * Python's ValueError: the shared class from compat/pyjson.mjs (since 2026-10-05; it used to be a
 * module-local class with the same name/message).
 */
export const PyValueError = ValueError;

/** The exec cannot be performed through Node where Python's os.execve would have proceeded. */
export class ExecUnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExecUnsupportedError';
  }
}

/** True when this Node's process.execve throws on failure instead of aborting (>= 26.1.0). */
export function catchableExecFailures(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > 26 || (major === 26 && minor >= 1);
}

/** An OSError for errno `name` as Python's os.execve raises it: "[Errno 2] No such file or directory: '/x'". */
export function execError(name, filename, bytes = false) {
  const shown = new PyRepr(bytes ? reprBytes(filename) : reprStr(filename));
  return fromNodeError({ code: name }, { filename: shown, filename2: null });
}

// The OSError for an errno Node reported (code name, or the negative errno when Node has no name).
function execErrorFrom(err, filename, bytes = false) {
  const shown = new PyRepr(bytes ? reprBytes(filename) : reprStr(filename));
  // Node >= 26.1 reports execve's errno as a positive number and an empty code for errnos it has no
  // name for (e.g. E2BIG): go by the number then.
  const errno = Number.isInteger(err.errno) ? -Math.abs(err.errno) : undefined;
  return fromNodeError({ code: err.code || undefined, errno }, { filename: shown, filename2: null }) ?? err;
}

const MACHO_THIN = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe']);
const MACHO_FAT = new Set(['cafebabe', 'cafebabf']);
const MACHO_MAGICS = new Set([...MACHO_THIN, ...MACHO_FAT, 'bebafeca', 'bfbafeca']);
const CPU_X86_64 = 0x01000007;
const CPU_ARM64 = 0x0100000c;
const EM = { x64: 62, arm64: 183, ia32: 3, arm: 40 };

function validate(file, argv, env) {
  const where = typeof file === 'string' ? file : String(file);
  if (typeof file !== 'string') throw new TypeError(`expected str, bytes or os.PathLike object, not ${typeof file}`);
  if (where.includes('\0')) throw new PyValueError('execve: embedded null character in path');
  if (!Array.isArray(argv)) throw new TypeError('execve: argv must be a tuple or list');
  if (argv.length === 0) throw new PyValueError('execve: argv must not be empty');
  for (const arg of argv) {
    if (typeof arg !== 'string') throw new TypeError(`expected str, bytes or os.PathLike object, not ${typeof arg}`);
    if (arg.includes('\0')) throw new PyValueError('embedded null byte');
  }
  if (argv[0] === '') throw new PyValueError('execve: argv first element cannot be empty');
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') throw new TypeError(`expected str, bytes or os.PathLike object, not ${typeof value}`);
    if (key.includes('\0') || value.includes('\0')) throw new PyValueError('embedded null byte');
    if (key === '' || key.includes('=')) throw new PyValueError('illegal environment variable name');
  }
}

function readHead(path, size = 4096) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null; // execute-only file: the kernel can still read it; nothing to inspect
  }
  try {
    const buffer = Buffer.alloc(size);
    return buffer.subarray(0, readSync(fd, buffer, 0, size, 0));
  } finally {
    closeSync(fd);
  }
}

// What opening the file for exec reports (path walk, permission, file type).
function openFailure(path) {
  try {
    accessSync(path, 1 /* X_OK */);
  } catch (err) {
    return err.code ?? 'EACCES';
  }
  let info;
  try {
    info = statSync(path);
  } catch (err) {
    return err.code ?? 'EACCES';
  }
  return info.isFile() ? null : 'EACCES';
}

// Linux: the kernel's bound on argument space (fs/exec.c bprm_stack_limits).
function linuxArgLimit() {
  let stack = 8 * 1024 * 1024;
  try {
    const line = readFileSync('/proc/self/limits', 'utf8').split('\n').find((l) => l.startsWith('Max stack size'));
    const soft = line?.slice('Max stack size'.length).trim().split(/\s+/)[0];
    stack = soft === 'unlimited' ? Infinity : Number(soft);
  } catch {
    /* default soft limit */
  }
  return Math.max(Math.min((8 * 1024 * 1024) / 4 * 3, stack / 4), 32 * 4096);
}

/** Predicted E2BIG for these arguments (null when they fit). Exported for tests. */
export function argumentSpaceFailure(file, argv, env, platform = process.platform) {
  const strings = [...argv, ...Object.entries(env).map(([k, v]) => `${k}=${v}`)];
  const sizes = strings.map((s) => Buffer.byteLength(s) + 1);
  const pointer = process.arch === 'ia32' || process.arch === 'arm' ? 4 : 8;
  if (platform === 'darwin') {
    // kern.argmax (NCARGS) holds every string with its NUL and its pointer, plus the argv and envp NULL
    // terminators (boundary measured against Python's os.execve on macOS 26, arm64: tests/compat/test_execve.py).
    const total = sizes.reduce((sum, size) => sum + size + pointer, 2 * pointer);
    return total > 1048576 ? 'E2BIG' : null;
  }
  if (sizes.some((n) => n > 131072)) return 'E2BIG'; // MAX_ARG_STRLEN
  let limit = linuxArgLimit();
  const pointers = (Math.max(argv.length, 1) + Object.keys(env).length) * pointer;
  if (limit <= pointers) return 'E2BIG';
  limit -= pointers;
  const total = sizes.reduce((a, b) => a + b, Buffer.byteLength(file) + 1);
  return total > limit ? 'E2BIG' : null;
}

// binfmt_misc handlers other than the control files; null when that cannot be known (not mounted
// here: handlers registered by the host kernel still apply, e.g. Docker Desktop's emulators).
function binfmtHandlers() {
  try {
    const names = readdirSync('/proc/sys/fs/binfmt_misc');
    if (!names.includes('register') || !names.includes('status')) return null;
    if (readFileSync('/proc/sys/fs/binfmt_misc/status', 'utf8').trim() !== 'enabled') return [];
    return names.filter((name) => name !== 'register' && name !== 'status');
  } catch {
    return null;
  }
}

function elfFailure(head) {
  if (head.length < 20) return null; // the loader decides about a truncated header
  const little = head[5] === 1;
  const machine = little ? head.readUInt16LE(18) : head.readUInt16BE(18);
  const is64 = head[4] === 2;
  const native = EM[process.arch];
  if (native === undefined || machine === native) return null;
  // 32-bit companions may run through the kernel's compat layer: not predictable here.
  if ((process.arch === 'x64' && machine === EM.ia32) || (process.arch === 'arm64' && machine === EM.arm)) return null;
  if (!is64 && head[4] !== 1) return null;
  const handlers = binfmtHandlers();
  return handlers !== null && handlers.length === 0 ? 'ENOEXEC' : null;
}

function rosetta() {
  try {
    statSync('/Library/Apple/usr/libexec/oah/libRosettaRuntime');
    return true;
  } catch {
    return false;
  }
}

function machoRuns(cputype) {
  if (process.arch === 'arm64') return cputype === CPU_ARM64 || (cputype === CPU_X86_64 && rosetta());
  if (process.arch === 'x64') return cputype === CPU_X86_64;
  return true; // unknown host: do not predict
}

function machoFailure(head, size) {
  const magic = head.subarray(0, 4).toString('hex');
  if (MACHO_THIN.has(magic)) {
    if (head.length < 8) return null;
    const cputype = magic.startsWith('fe') ? head.readUInt32BE(4) : head.readUInt32LE(4);
    return machoRuns(cputype) ? null : 'EBADARCH';
  }
  if (MACHO_FAT.has(magic)) {
    const count = head.readUInt32BE(4);
    const width = magic === 'cafebabf' ? 32 : 20;
    if (count === 0 || 8 + count * width > head.length) return null; // not decidable from the header
    for (let i = 0; i < count; i++) {
      const at = 8 + i * width;
      const [offset, length] = width === 32
        ? [Number(head.readBigUInt64BE(at + 8)), Number(head.readBigUInt64BE(at + 16))]
        : [head.readUInt32BE(at + 8), head.readUInt32BE(at + 12)];
      if (offset + length > size) return null; // malformed: the kernel's own verdict (EBADMACHO) is not predicted
      if (machoRuns(head.readUInt32BE(at))) return null;
    }
    return 'EBADARCH';
  }
  return null;
}

// Format checks on a file that opened fine. `depth` counts the #! levels already followed.
function formatFailure(path, depth, platform) {
  if (platform === 'linux' && depth > 5) return 'ELOOP';
  const head = readHead(path);
  if (head === null) return null;
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) {
    // "#!interpreter [argument]": the kernel runs the interpreter with the script path appended.
    if (platform === 'darwin' && depth > 0) return 'ENOEXEC'; // macOS does not follow a script through another script
    const window = head.subarray(0, platform === 'linux' ? 256 : 512);
    // The interpreter stays raw bytes (a Buffer path), exactly what the kernel opens: UTF-8 or any
    // other byte sequence names the same file (it used to be decoded as Latin-1 and re-encoded as UTF-8).
    const line = window.subarray(2, window.includes(0x0a) ? window.indexOf(0x0a) : window.length);
    const blank = (byte) => byte === 0x20 || byte === 0x09;
    let start = 0;
    while (start < line.length && blank(line[start])) start += 1;
    let end = start;
    while (end < line.length && !blank(line[end])) end += 1;
    const interpreter = Buffer.from(line.subarray(start, end));
    if (!interpreter.length) return 'ENOEXEC';
    return openFailure(interpreter) ?? formatFailure(interpreter, depth + 1, platform);
  }
  if (platform === 'linux') {
    if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return elfFailure(head);
    return 'ENOEXEC';
  }
  if (head.length >= 4 && MACHO_MAGICS.has(head.subarray(0, 4).toString('hex'))) {
    let size;
    try {
      size = statSync(path).size;
    } catch {
      return null;
    }
    return machoFailure(head, size);
  }
  return 'ENOEXEC';
}

/**
 * Predict what execve(file, argv, env) would do. Returns null when it should succeed, otherwise
 * the errno name ("ENOENT", ...). Throws what Python's argument checking throws (ValueError, TypeError).
 */
export function preflight(file, argv, env = process.env, { platform = process.platform } = {}) {
  validate(file, argv, env);
  return openFailure(file) ?? argumentSpaceFailure(file, argv, env, platform) ?? formatFailure(file, 0, platform);
}

function closedStandardStream() {
  for (let fd = 0; fd < 3; fd++) {
    try {
      fstatSync(fd);
    } catch (err) {
      if (err.code === 'EBADF') return fd;
    }
  }
  return null;
}

function unsupported(file, fd) {
  return new ExecUnsupportedError(
    `cannot execute ${reprStr(file)}: standard stream ${fd} is closed and Node's process.execve needs file descriptors 0-2 open`);
}

// process.execve; a catchable failure is returned (Node >= 26.1), success never returns.
function realExecve(file, argv, env) {
  if (typeof process.execve !== 'function') throw new Error('process.execve is not available in this Node.js version');
  const closed = closedStandardStream();
  if (closed !== null) throw unsupported(file, closed);
  // Node announces process.execve as experimental through emitWarning; the notice must not reach
  // stderr of a command that Python would run silently. Filter just this call, restore afterwards.
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message ?? '';
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type ?? warning?.name;
    if (type === 'ExperimentalWarning' && /execve/.test(text)) return undefined;
    return original.call(this, warning, ...rest);
  };
  try {
    process.execve(file, argv, env);
  } catch (err) {
    if (err?.syscall === 'fcntl') throw unsupported(file, closedStandardStream() ?? 0);
    if (err?.syscall === 'execve') return err;
    throw err;
  } finally {
    process.emitWarning = original;
  }
  return undefined;
}

const useCatchable = (options) => options.catchable ?? catchableExecFailures();

/**
 * os.execve(path, argv, env): replaces the process, or throws the OSError text Python would
 * ("[Errno 2] No such file or directory: '/x'"). Does not return on success.
 * options: platform (preflight tables), catchable (force/skip the Node >= 26.1 path; tests only), ignored (signal
 * names to leave ignored in the new program; default: the ones this process inherited as ignored, see
 * startup_vars.mjs).
 */
export function execve(file, argv, env = process.env, options = {}) {
  const ignored = options.ignored ?? ignored_signals();
  if (ignored.length) {
    // The caller left signals ignored (Node reset them at startup; Python passes SIG_IGN on across exec): exec the
    // target through a shell that sets them ignored again. The target is checked first, so an unusable file is the
    // OSError Python would raise rather than a shell's "not found".
    const failure = preflight(file, argv, env, options);
    if (failure) throw execError(failure, file);
    const [wrapper, wrapped] = reignore(file, argv, env, ignored);
    const late = realExecve(wrapper, wrapped, { ...env });
    if (late) throw execErrorFrom(late, file);
    return;
  }
  if (useCatchable(options)) {
    validate(file, argv, env);
    const failure = realExecve(file, argv, { ...env });
    if (failure) throw execErrorFrom(failure, file);
    return;
  }
  const failure = preflight(file, argv, env, options);
  if (failure) throw execError(failure, file);
  const late = realExecve(file, argv, { ...env });
  if (late) throw execErrorFrom(late, file); // only reachable if this Node turned out to throw
}

/** os.get_exec_path(env) */
export function getExecPath(env = process.env) {
  const path = env.PATH;
  return (path === undefined ? DEFPATH : path).split(':');
}

/**
 * os.execvpe(file, argv, env) (env omitted: os.execvp, i.e. the current environment). With a
 * directory part the file is run as is; otherwise each PATH entry is tried in order. As in Python,
 * the first error that is not ENOENT/ENOTDIR wins over the last ENOENT/ENOTDIR.
 */
export function execvpe(file, argv, env = process.env, options = {}) {
  if (typeof file !== 'string') throw new TypeError(`expected str, bytes or os.PathLike object, not ${typeof file}`);
  // os.path.dirname(file) is non-empty exactly when the name contains a slash.
  if (file.includes('/')) return execve(file, argv, env, options);
  const ignored = options.ignored ?? ignored_signals();
  if (ignored.length) {
    // PATH search with preflight (a wrapper exec must not stand in for the target's own errors), then execve of the
    // first usable candidate. Limit of this path only: the program then sees its resolved path as argv[0].
    let saved = null;
    let last = null;
    for (const directory of getExecPath(env)) {
      const candidate = pathJoin(directory, file);
      const failure = preflight(candidate, argv, env, options);
      if (!failure) return execve(candidate, argv, env, { ...options, ignored });
      last = execError(failure, candidate, true);
      if (failure !== 'ENOENT' && failure !== 'ENOTDIR' && saved === null) saved = last;
    }
    throw saved ?? last ?? execError('ENOENT', file, true);
  }
  const catchable = useCatchable(options);
  if (catchable) validate(file, argv, env);
  let saved = null;
  let last = null;
  for (const directory of getExecPath(env)) {
    const candidate = pathJoin(directory, file);
    let error;
    if (catchable) {
      const failure = realExecve(candidate, argv, { ...env });
      error = execErrorFrom(failure, candidate, true);
    } else {
      const failure = preflight(candidate, argv, env, options);
      if (!failure) {
        const late = realExecve(candidate, argv, { ...env });
        if (!late) return undefined; // unreachable on success
        error = execErrorFrom(late, candidate, true);
      } else error = execError(failure, candidate, true);
    }
    last = error;
    const code = error instanceof PyOSError ? error.code : undefined;
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && saved === null) saved = last;
  }
  throw saved ?? last ?? execError('ENOENT', file, true);
}

// posixpath.join(dir, name): no separator is added after an empty or slash-terminated prefix.
function pathJoin(directory, name) {
  if (directory === '' || directory.endsWith('/')) return directory + name;
  return `${directory}/${name}`;
}
