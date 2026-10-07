// PATH-hijack fixtures for the pre-Node shell code (bin/lcu*, scripts/install.sh, the relay launcher, the plugin hook).
//
// Everything those scripts run before a trusted Node exists (possibly as root) must be a shell builtin or an
// absolute system path: the caller's PATH is never consulted. The stand-ins here log their own invocation, so a
// test can assert that none ever ran.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Every common tool a shell script might reach for through PATH (builtins cannot be shadowed by a PATH entry, so the
// names that are also builtins are harmless in the list), plus the interpreters.
export const STAND_IN_TOOLS = [
  'cat', 'ls', 'uname', 'id', 'readlink', 'dirname', 'basename', 'sed', 'awk', 'grep', 'egrep', 'fgrep', 'tr', 'cut',
  'head', 'tail', 'env', 'stat', 'find', 'mkdir', 'rmdir', 'rm', 'mv', 'cp', 'ln', 'chmod', 'touch', 'sort', 'uniq',
  'wc', 'tee', 'xargs', 'realpath', 'expr', 'sleep', 'date', 'mktemp', 'test', 'true', 'false', 'printf', 'echo', 'pwd',
  'whoami', 'logname', 'hostname', 'getent', 'dscl', 'sudo', 'su', 'which', 'iconv', 'od', 'xxd', 'hexdump', 'file',
  'tput', 'stty', 'kill', 'ps', 'node', 'nodejs', 'python', 'python3', 'perl', 'ruby', 'bash', 'sh', 'dash', 'zsh', 'ksh',
  'busybox', 'curl', 'wget', 'tar', 'shasum', 'sha256sum', 'plutil', 'codesign', 'openssl', 'getfacl', 'flock', 'lockf',
  'git', 'npm', 'npx', 'pwsh', 'powershell', 'cmd', 'certutil', 'lcu', 'lcu-session', 'chatgpt',
];

/**
 * A directory of logging stand-ins for STAND_IN_TOOLS. `hits()` lists the stand-ins that ran ("name arg ..."), in
 * order. A stand-in uses only shell builtins, so it never runs another stand-in.
 */
export function standIns(base) {
  const dir = join(base, 'standins');
  const log = join(base, 'standins.log');
  mkdirSync(dir, { recursive: true });
  writeFileSync(log, '');
  for (const tool of STAND_IN_TOOLS) {
    const file = join(dir, tool);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> '${log}'\nexit 0\n`);
    chmodSync(file, 0o755);
  }
  return { dir, log, hits: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

/**
 * The hostile environments a launcher must survive: the stand-ins first on an otherwise normal PATH, only the stand-ins,
 * a PATH that does not exist, and an empty one. `extra` is merged over a minimal environment (HOME is set unless
 * `extra` says otherwise); `env -i` semantics: nothing else is inherited.
 */
export function hostileEnvironments(dir, extra = {}) {
  const base = { HOME: '/nonexistent-home', ...extra };
  return [
    { ...base, PATH: `${dir}:/usr/bin:/bin` },
    { ...base, PATH: dir },
    { ...base, PATH: '/nonexistent' },
    { ...base, PATH: '' },
  ];
}
