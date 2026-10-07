// Prints how long LCU's lock takes to acquire and release on this machine (Windows: a PowerShell holder per lock), and where
// the time goes.  Not a test (no .test.mjs suffix); run by .github/workflows/windows-node.yml before the suite, on an idle runner.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireSync, windowsHolderScript, windowsPowerShell } from '../../lcu/compat/lock.mjs';

const dir = mkdtempSync(join(tmpdir(), 'lcu-lockcost-'));
const file = join(dir, 'x.lock');
writeFileSync(file, '');

if (process.platform === 'win32') {
  // Where the time goes: an empty PowerShell, the same flags with an encoded command, and the holder script on its own
  // (stdin already at EOF and the release file present, so it locks, reports and leaves at once).
  const timed = (label, args, options = {}) => {
    const started = Date.now();
    const done = spawnSync(windowsPowerShell(), args, { encoding: 'utf8', windowsHide: true, ...options });
    console.log(`${label}: ${Date.now() - started} ms (exit ${done.status})${done.stdout.trim() ? ` ${JSON.stringify(done.stdout.trim())}` : ''}`);
  };
  const encode = (script) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')];
  timed('powershell -Command exit', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']);
  timed('powershell -Command exit (second)', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']);
  timed('powershell -EncodedCommand exit', encode('exit 0'));
  const release = join(dir, 'x.release');
  writeFileSync(release, '');
  timed('holder script alone', encode(windowsHolderScript(file, { releasePath: release })), { input: '' });
}

for (let i = 0; i < 5; i += 1) {
  const started = Date.now();
  const lock = acquireSync(file);
  const acquired = Date.now() - started;
  lock.release();
  console.log(`lock ${i}: acquired in ${acquired} ms, released after ${Date.now() - started} ms`);
}
