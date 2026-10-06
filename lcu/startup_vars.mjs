// The launch protocol shared by bin/* (shell), lcu/entry.mjs and every LCU Node process LCU starts itself.
// No imports besides Node built-ins that read no environment: lcu/entry.mjs imports this module FIRST, before any
// LCU code, to restore the caller's environment (design addendum B, .port/notes/entry.md).
//
// Reserved channel: every variable named __LCU_* is LCU launch state. The shim may set them (and uses that
// prefix for all of its own shell variables, so a caller's ordinary exported variable is never overwritten);
// entry.mjs removes all of them before any child is started.
//   __LCU_Q=<names>, __LCU_Q_<NAME>=<value>   Node startup variables moved aside (only names in QUARANTINED)
//   __LCU_ARGV0=<path>                         the launcher as invoked (Python's sys.argv[0])
//   __LCU_SIGIGN=<names>                       signals the caller left ignored (Node resets them; see below)
//   __LCU_ENV_INVALID=1                        the shim found argv/env bytes that are not UTF-8 (macOS check)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Environment variables the Node binary itself reads at startup (Node 24 CLI documentation, "Environment
// variables", plus OpenSSL's own startup inputs that Node's OpenSSL initialisation reads). Each is kept away from
// LCU's own Node and restored, as data, for every child: over-inclusion is harmless, omission is not.
// Keep in sync with the list in bin/* (tests/node/entry.test.mjs compares them).
export const QUARANTINED = [
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_ICU_DATA', 'NODE_V8_COVERAGE', 'NODE_COMPILE_CACHE',
  'NODE_REDIRECT_WARNINGS', 'NODE_NO_WARNINGS', 'NODE_PENDING_DEPRECATION', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_PRESERVE_SYMLINKS', 'NODE_PRESERVE_SYMLINKS_MAIN', 'NODE_DISABLE_COLORS',
  'NODE_SKIP_PLATFORM_CHECK', 'UV_THREADPOOL_SIZE', 'NODE_USE_ENV_PROXY', 'NODE_USE_SYSTEM_CA',
  // Added after review (port-runtime.md #6): startup inputs outside addendum B's original list.
  'NODE_DISABLE_COMPILE_CACHE', 'NODE_COMPILE_CACHE_PORTABLE', 'NODE_TEST_CONTEXT', 'NODE_PENDING_PIPE_INSTANCES',
  'UV_USE_IO_URING', 'FORCE_COLOR', 'NO_COLOR', 'NODE_FORCE_READLINE',
  'OPENSSL_CONF', 'OPENSSL_ENGINES', 'OPENSSL_MODULES', 'OPENSSL_ia32cap', 'OPENSSL_armcap',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

// Signals whose inherited "ignored" disposition the shim reports. Node resets every disposition to the default
// at startup and libuv resets them again in every spawned child, whereas Python keeps an inherited SIG_IGN and
// passes it on (exec and subprocess alike, SIGPIPE/SIGXFSZ aside).
export const SIGNALS = ['HUP', 'INT', 'QUIT', 'USR1', 'USR2', 'ALRM', 'TERM'];

const state = { argv0: null, ignored: [], invalid: false };

/** Consume the launch channel from `env` (default process.env). Returns {argv0, ignored, invalid}. */
export function restore_environment(env = process.env) {
  const listed = new Set((env.__LCU_Q ?? '').split(',').filter((name) => QUARANTINED.includes(name)));
  const values = new Map();
  for (const name of listed) {
    const key = `__LCU_Q_${name}`;
    if (Object.hasOwn(env, key)) values.set(name, env[key]);
  }
  const argv0 = Object.hasOwn(env, '__LCU_ARGV0') ? env.__LCU_ARGV0 : null;
  const ignored = (env.__LCU_SIGIGN ?? '').split(',').filter((name) => SIGNALS.includes(name));
  const invalid = env.__LCU_ENV_INVALID === '1';
  for (const key of Object.keys(env)) {
    if (key.startsWith('__LCU_')) delete env[key];
  }
  for (const [name, value] of values) env[name] = value;
  Object.assign(state, { argv0, ignored, invalid });
  return { argv0, ignored, invalid };
}

/** Signals the caller had ignored when LCU started (consumed by restore_environment). */
export const ignored_signals = () => [...state.ignored];

/**
 * The environment for an LCU-owned Node process (e.g. the macOS lifecycle host): the same caller data, with the
 * startup variables moved into the channel so that process starts clean and restores them (through entry.mjs).
 */
export function quarantine_environment(env) {
  const out = { ...env };
  const names = [];
  for (const name of QUARANTINED) {
    if (Object.hasOwn(out, name)) {
      out[`__LCU_Q_${name}`] = out[name];
      delete out[name];
      names.push(name);
    }
  }
  if (names.length) out.__LCU_Q = names.join(',');
  if (state.ignored.length) out.__LCU_SIGIGN = state.ignored.join(',');
  return out;
}

// Re-ignoring signals must hand the target EXACTLY the environment it was given, whatever the names: a POSIX shell
// cannot (dash drops variables whose names are not shell identifiers such as `A.B`, `FOO-BAR`, `SPACE KEY`, and
// resets IFS/PWD; bash -p resets IFS, PWD, SHELLOPTS, OLDPWD and `_`), so no shell is used. In order of preference:
//   1. GNU/uutils `env --ignore-signal=SIG,... -- file args...` (feature-probed by absolute path; coreutils is
//      present on every Linux LCU supports; macOS ships BSD env, which lacks the option). It never touches the
//      environment. GNU env treats any operand containing `=` as a variable assignment, even after `--`, so a
//      `file` containing `=` goes to mechanism 2.
//   2. /usr/bin/perl (macOS ships it; perl-base is essential on Debian/Ubuntu): sets $SIG{...}='IGNORE' and execs
//      the file in place with the environment untouched. Used only when the environment has no PERL* variable
//      (PERL5OPT/PERL5LIB would change what perl runs). Residual: with an invalid locale perl prints its
//      "Setting locale failed" warning on stderr.
//   3. Neither works: the target is started with default dispositions (no re-ignore), a documented limitation
//      (docs/DEVELOPMENT.md); the environment is still passed through exactly.
// Both wrappers exec the target in place (same pid); argv[0] is the file, as LCU always passes it.
const ENV_CANDIDATES = ['/usr/bin/env', '/bin/env'];
const TRUE_CANDIDATES = ['/usr/bin/true', '/bin/true'];
const PERL = '/usr/bin/perl';
const PERL_SCRIPT = '$SIG{$_}="IGNORE" for split /,/, shift; exec {$ARGV[0]} @ARGV; exit 127';
let probed = null;

/** {env: absolute path of an env that supports --ignore-signal | null, perl: boolean}, probed once. */
export function reignore_tools() {
  if (probed) return probed;
  probed = { env: null, perl: false };
  const run = (file, args) => {
    try {
      return spawnSync(file, args, { env: {}, stdio: 'ignore', timeout: 5000 }).status === 0;
    } catch {
      return false;
    }
  };
  const truth = TRUE_CANDIDATES.find((candidate) => existsSync(candidate));
  if (truth) probed.env = ENV_CANDIDATES.find((c) => existsSync(c) && run(c, ['--ignore-signal=INT', '--', truth])) ?? null;
  probed.perl = existsSync(PERL) && run(PERL, ['-e', 'exit 0']);
  return probed;
}

/** Which mechanism re-ignores signals here: 'env', 'perl' or 'none' (tests, diagnostics). */
export function reignore_mechanism() {
  const found = reignore_tools();
  return found.env ? 'env' : found.perl ? 'perl' : 'none';
}

/**
 * [file, argv] that run `argv` (as execve(file, argv) would) with the caller's ignored signals ignored again.
 * Unchanged when nothing was ignored (the normal case) or no mechanism is available (see above). Otherwise a tool
 * sets SIG_IGN and execs the target in place (same pid) with `env` untouched.
 * `signals` defaults to this process's inherited ignores; a helper process that never saw the launch channel
 * (compat/accounts.mjs' privilege-dropping child) is handed the list explicitly.
 */
export function reignore(file, argv, env, signals = state.ignored, tools = null) {
  if (signals.length === 0) return [file, argv];
  const found = tools ?? reignore_tools();
  const list = signals.join(',');
  if (found.env && !file.includes('=')) {
    return [found.env, [found.env, `--ignore-signal=${list}`, '--', file, ...argv.slice(1)]];
  }
  if (found.perl && !Object.keys(env ?? {}).some((name) => name.startsWith('PERL'))) {
    return [PERL, [PERL, '-e', PERL_SCRIPT, list, file, ...argv.slice(1)]];
  }
  return [file, argv];
}
