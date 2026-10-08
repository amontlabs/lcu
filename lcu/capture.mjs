// Run a child and capture its output through files rather than pipes.
//
// Node writes to pipes asynchronously on macOS, so a CLI that prints and then calls `process.exit()`
// loses everything past the 64 KiB pipe buffer. File writes are synchronous on every platform, so the
// whole output survives the exit.
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `[command, args, options]` that start `command`: on Windows a .cmd or .bat file (an npm shim such as codex.cmd)
 * runs through `cmd.exe /d /s /c`, because Node refuses to start batch files without a shell. Every part is
 * double-quoted; a part cmd.exe could still expand or split (`"`, `%`, a line break) is refused.
 */
export function batchCommand(command, args = [], options = {}, platform = process.platform) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(command)) return [command, args, options];
  const parts = [command, ...args].map((part) => {
    part = String(part);
    if (/["%\r\n\0]/.test(part)) throw new Error(`Cannot pass ${JSON.stringify(part)} safely to the batch file ${command}.`);
    // A trailing backslash would escape the closing quote for the program the batch file starts.
    return `"${part.replace(/(\\+)$/, '$1$1')}"`;
  });
  return ['cmd.exe', ['/d', '/s', '/c', `"${parts.join(' ')}"`], { ...options, windowsVerbatimArguments: true }];
}

/** spawnSync with stdin closed and stdout/stderr read back from temporary files as text. */
export function run(command, args = [], options = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'lcu-capture-'));
  const out = openSync(join(folder, 'out'), 'w+', 0o600);
  const err = openSync(join(folder, 'err'), 'w+', 0o600);
  try {
    const result = spawnSync(...batchCommand(command, args, { ...options, stdio: ['ignore', out, err] }));
    return { status: result.status, signal: result.signal, error: result.error,
      stdout: readFileSync(join(folder, 'out'), 'utf8'), stderr: readFileSync(join(folder, 'err'), 'utf8') };
  } finally {
    closeSync(out);
    closeSync(err);
    rmSync(folder, { recursive: true, force: true });
  }
}
