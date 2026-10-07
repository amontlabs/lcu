// Prints how long LCU's lock takes to acquire and release on this machine (Windows: a PowerShell holder per lock), and where
// the time goes.  Not a test (no .test.mjs suffix); run by .github/workflows/windows-node.yml before the suite, on an idle runner.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireSync, windowsHolderEnvironment, windowsHolderScript, windowsPowerShell } from '../../lcu/compat/lock.mjs';

const dir = mkdtempSync(join(tmpdir(), 'lcu-lockcost-'));
const file = join(dir, 'x.lock');
writeFileSync(file, '');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (process.platform === 'win32') {
  const encode = (script) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')];
  const started = Date.now();
  const bare = spawnSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true });
  console.log(`powershell -Command exit: ${Date.now() - started} ms (exit ${bare.status})`);

  // The holder as lock.mjs starts it, its status file polled synchronously: time until the LOCKED line shows up.
  const oldMinimal = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'windir', 'SystemDrive', 'TEMP', 'TMP']) if (process.env[key] !== undefined) oldMinimal[key] = process.env[key];
  const experiment = (label, { stdin = 'pipe', env }) => {
    const slug = label.replace(/\W+/g, '_');
    const status = join(dir, `status-${slug}`);
    const release = `${status}.release`;
    const target = join(dir, `${slug}.lock`);
    writeFileSync(target, '');
    const held = openSync(target, constants.O_CREAT | constants.O_RDWR);
    const fd = openSync(status, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR);
    const begun = Date.now();
    const child = spawn(windowsPowerShell(), encode(windowsHolderScript(target, { releasePath: release })),
      { stdio: [stdin, fd, 'ignore'], windowsHide: true, env });
    closeSync(fd);
    child.unref();
    const spawned = Date.now() - begun;
    let seen = null;
    let text = '';
    while (Date.now() - begun < 90000) {
      text = readFileSync(status, 'utf8');
      if (/LOCKED|OPENFAIL|DEADLOCK|TIMEOUT/.test(text)) { seen = Date.now() - begun; break; }
      sleep(10);
    }
    writeFileSync(release, '');
    closeSync(held);
    console.log(`${label}: spawn returned after ${spawned} ms, first status ${JSON.stringify(text.trim())} after ${seen} ms`);
    try { unlinkSync(status); } catch { /* ignore */ }
  };
  experiment('A  old minimal environment (SystemRoot, TEMP only)', { env: oldMinimal });
  experiment('B  holder environment (profile and machine variables, no PATH/PSModulePath)', { env: windowsHolderEnvironment() });
  experiment('C  the whole environment', { env: process.env });
  experiment('D  holder environment, stdin ignored', { stdin: 'ignore', env: windowsHolderEnvironment() });
}

for (let i = 0; i < 3; i += 1) {
  const started = Date.now();
  const lock = acquireSync(file);
  const acquired = Date.now() - started;
  lock.release();
  console.log(`lock ${i} (as shipped): acquired in ${acquired} ms, released after ${Date.now() - started} ms`);
}
