// Node entry point for the POSIX launch shims (bin/lcu, bin/lcu-session, bin/lcu-codex-sandbox).
//
//   [__LCU_ARGV0=<launcher as invoked>] node --disable-warning=ExperimentalWarning <release>/lcu/entry.mjs CLI [ARG...]
//
// CLI is `lcu`, `session` or `sandbox`. The release root is the symlink-resolved directory above this file
// (Python's `Path(bin/lcu).resolve().parent.parent`: both live in the same release). __LCU_ARGV0 carries the
// launcher path as invoked (Python's sys.argv[0], used for argparse's prog and the terminal hint); without it
// (e.g. the detached `lcu update --refresh`) it is <root>/bin/<launcher>. It is consumed like __LCU_Q.
//
// This module has NO static imports on purpose: before any LCU or compat module is evaluated it restores the
// Node startup variables the shim quarantined (design addendum B in .port/BRIEF.md), so every child LCU starts
// sees the caller's environment byte for byte. Then it imports the selected CLI and maps its outcome to the exit
// status and stderr text the Python launchers (bin/lcu, bin/lcu-session, bin/lcu-codex-sandbox) produced.

// The quarantine list and the reserved __LCU_* channel live in ./startup_vars.mjs (imported first, below).
export { QUARANTINED, restore_environment } from './startup_vars.mjs';

const LAUNCHER = { lcu: 'lcu', session: 'lcu-session', sandbox: 'lcu-codex-sandbox', 'macos-host': 'lcu' };

const PREFIX = { lcu: 'LCU: ', session: 'LCU session: ', sandbox: 'LCU: ', 'macos-host': 'LCU: ' };

function chain(error) {
  const names = [];
  for (let cls = error?.constructor; cls && cls !== Object && cls !== Function.prototype; cls = Object.getPrototypeOf(cls)) {
    if (cls.name) names.push(cls.name);
  }
  if (error?.name) names.push(error.name);
  return names;
}
const is_subprocess_error = (error) => error?.isSubprocessError === true ||
  chain(error).some((name) => /^(SubprocessError|TimeoutExpired|CalledProcessError)$/.test(name));

function write(fd, text, writeSync) {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset);
    } catch (error) {
      if (error.code === 'EAGAIN') continue;
      if (error.code === 'EPIPE') return;
      throw error;
    }
  }
}

/** Python's SystemExit(code) -> exit status (sys.exit(-9) is 247; None is 0; a str is printed, status 1). */
export function exit_status(code, print) {
  if (code === null || code === undefined) return 0;
  if (typeof code === 'boolean') return code ? 1 : 0;
  if (typeof code === 'number' || typeof code === 'bigint') return Number(BigInt.asUintN(8, BigInt(code)));
  print(`${code}\n`);
  return 1;
}

// First valid-UTF-8 failure among NUL-separated byte strings (Linux /proc/self/environ, /proc/self/cmdline).
function invalid_utf8(raw) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let start = 0;
  for (let i = 0; i <= raw.length; i += 1) {
    if (i === raw.length || raw[i] === 0) {
      const item = raw.subarray(start, i);
      try {
        decoder.decode(item);
      } catch {
        const at = item.indexOf(0x3d);
        return Buffer.from(item.subarray(0, at < 0 ? item.length : at)).toString('latin1');
      }
      start = i + 1;
    }
  }
  return null;
}

export async function run(argv = process.argv.slice(2)) {
  // Startup quarantine first: nothing else of LCU may be evaluated before the caller's environment is back.
  const { restore_environment: restore } = await import('./startup_vars.mjs');
  const { argv0: given, ignored, invalid } = restore();
  const [cli, ...args] = argv;
  const { readFileSync, realpathSync, writeSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const stderr = (text) => write(2, text, writeSync);
  const prefix = PREFIX[cli];
  if (prefix === undefined) {
    stderr('LCU: lcu/entry.mjs is started by the bin/ launchers: entry.mjs lcu|session|sandbox|macos-host [ARG...]\n');
    return 2;
  }
  const root = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
  // Python passes argv/environment bytes through unchanged; Node strings cannot carry bytes that are not UTF-8
  // (they would become U+FFFD). Refuse instead of silently changing what children receive (review #11).
  let bad = invalid ? '' : null;
  if (process.platform === 'linux') {
    for (const file of ['/proc/self/environ', '/proc/self/cmdline']) {
      try {
        const name = invalid_utf8(readFileSync(file));
        if (name !== null) bad = file.endsWith('environ') ? name : '';
      } catch {
        // /proc unavailable: nothing more to check
      }
      if (bad !== null) break;
    }
  }
  if (bad !== null) {
    stderr(`${prefix}${bad ? `The environment variable ${bad}` : 'An argument or environment variable'} is not valid ` +
      'UTF-8; LCU cannot pass it on unchanged. Unset or re-encode it and retry.\n');
    return 1;
  }
  // Keep the caller's ignored signals ignored in this process (Node reset them to the default at startup).
  for (const name of ignored) process.on(`SIG${name}`, () => {});
  // sys.argv as the Python launcher saw it: [launcher path, *arguments].
  process.argv = [process.execPath, given ?? join(root, 'bin', LAUNCHER[cli]), ...args];
  // Design addendum C: the POSIX launch path needs process.execve (Node >= 22.15).
  if (typeof process.execve !== 'function' && process.platform !== 'win32') {
    stderr(`${prefix}The ChatGPT app's bundled Node (${process.execPath}) is ${process.version}, but LCU needs ` +
      'Node 22.15 or newer (process.execve). Repair the official app and rerun the LCU installer.\n');
    return 1;
  }
  const { pyStr } = await import('./compat/pyerr.mjs');
  // The single ValueError / OSError classifiers shared with every module (compat/errors.mjs, compat/pyerr.mjs).
  const { isValueError: is_value_error } = await import('./compat/errors.mjs');
  const { isOSError: is_os_error } = await import('./compat/pyerr.mjs');
  try {
    if (cli === 'lcu') {
      const { main } = await import('./runtime.mjs');
      await main(root, args);
      return 0;
    }
    if (cli === 'session') {
      const { main } = await import('./session.mjs');
      await main();
      return 0;
    }
    if (cli === 'macos-host') {
      // The macOS lifecycle host started by runtime.mjs (macos_host.mjs `serve`), quarantined like this process.
      const { serve_main } = await import('./macos_host.mjs');
      await serve_main(args);
      return 0;
    }
    const { main } = await import('./sandbox_shim.mjs');
    return exit_status(await main(args), stderr);
  } catch (error) {
    if (chain(error).includes('PySystemExit') || error?.constructor?.name === 'PySystemExit') {
      return exit_status(error.status, stderr);
    }
    const { format_traceback } = await import('./compat/pytrace.mjs');
    if (error?.name === 'KeyboardInterrupt') {
      stderr(format_traceback(error, root));
      return 'SIGINT';
    }
    const mapped = cli === 'lcu' ? is_value_error(error) || is_os_error(error) || is_subprocess_error(error)
      : cli === 'session' ? is_value_error(error) || is_os_error(error) : false;
    if (mapped) {
      // Errors already rendered the Python way (compat PyOSError, ValueError...) keep their text.
      const text = chain(error).includes('PyOSError') || error?.isOSError === true || typeof error?.code !== 'string'
        ? error.message : pyStr(error);
      stderr(`${prefix}${text}\n`);
      return 1;
    }
    // Python prints a traceback (`Traceback (most recent call last):` ... `<PythonType>: <message>`) for anything
    // else and exits 1.
    stderr(format_traceback(error, root));
    return 1;
  }
}

// Only when run as the program (tests import the helpers above).
const invoked = await (async () => {
  if (!process.argv[1]) return false;
  const { realpathSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invoked) {
  const status = await run();
  if (status === 'SIGINT') {
    // Python finalizes (flushing sys.stdout) before it re-raises SIGINT; the exit hook will not run on a kill.
    try {
      (await import('./compat/pyio.mjs')).stdout_flush();
    } catch {
      // a closed reader: nothing more to flush
    }
    process.removeAllListeners('SIGINT');
    process.kill(process.pid, 'SIGINT');
  } else {
    process.exitCode = status;
  }
}
