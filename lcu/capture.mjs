// Run a child and capture its output through files rather than pipes.
//
// Node writes to pipes asynchronously on macOS, so a CLI that prints and then calls `process.exit()`
// loses everything past the 64 KiB pipe buffer. File writes are synchronous on every platform, so the
// whole output survives the exit.
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** spawnSync with stdin closed and stdout/stderr read back from temporary files as text. */
export function run(command, args = [], options = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'lcu-capture-'));
  const out = openSync(join(folder, 'out'), 'w+', 0o600);
  const err = openSync(join(folder, 'err'), 'w+', 0o600);
  try {
    const result = spawnSync(command, args, { ...options, stdio: ['ignore', out, err] });
    return { status: result.status, signal: result.signal, error: result.error,
      stdout: readFileSync(join(folder, 'out'), 'utf8'), stderr: readFileSync(join(folder, 'err'), 'utf8') };
  } finally {
    closeSync(out);
    closeSync(err);
    rmSync(folder, { recursive: true, force: true });
  }
}
