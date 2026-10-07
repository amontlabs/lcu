// Every child LCU starts gets the caller's ignored signals ignored again, like Python (which passes SIG_IGN on through
// fork/exec). Node resets dispositions at startup and libuv resets them in each child; compat/spawn.mjs (spawn,
// spawnSync, execFile), compat/execve.mjs (the ignored option) and compat/accounts.mjs (the privilege-dropping helper)
// put them back. The probes only READ dispositions (/proc/<pid>/status SigIgn on Linux, bash's trap refusal on macOS):
// no test here sends a signal to anything (SAFETY RULE, .port/BRIEF.md).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DISPOSITION_SCRIPT } from './runtime_support.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const HAS_BASH = existsSync('/bin/bash');

/** Run `body` (async module code) in a fresh Node whose launch channel says INT and HUP were ignored. */
function harness(body, { ignored = 'INT,HUP', env = {} } = {}) {
  const script = `
    const sv = await import(${JSON.stringify(join(REPO, 'lcu/startup_vars.mjs'))});
    sv.restore_environment({ __LCU_SIGIGN: ${JSON.stringify(ignored)} });
    const out = {};
    const PROBE = ['/bin/bash', '-p', '-c', ${JSON.stringify(DISPOSITION_SCRIPT)}];
    const ENV = { PATH: '/usr/bin:/bin' };
    ${body}
    process.stdout.write(JSON.stringify(out));`;
  // A file, not -e: a worker thread (app_server's process host) cannot inherit `-e` in its execArgv.
  const directory = mkdtempSync(join(tmpdir(), 'lcu-signals-'));
  try {
    const file = join(directory, 'harness.mjs');
    writeFileSync(file, script);
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', file],
      { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    assert.equal(done.status, 0, done.stderr);
    return JSON.parse(done.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

const ignoredInt = (text) => /INT=1 TERM=0/.test(text);

describe('children inherit the caller\'s ignored signals', { skip: !HAS_BASH && 'needs /bin/bash' }, () => {
  it('compat/spawn spawnSync, spawn and execFile', () => {
    const out = harness(`
      const { spawnSync, spawn, execFile } = await import(${JSON.stringify(join(REPO, 'lcu/compat/spawn.mjs'))});
      out.sync = spawnSync(PROBE[0], PROBE.slice(1), { encoding: 'utf8', env: ENV }).stdout;
      out.async = await new Promise((resolve) => {
        let data = '';
        const child = spawn(PROBE[0], PROBE.slice(1), { env: ENV });
        child.stdout.on('data', (chunk) => { data += chunk; });
        child.on('close', () => resolve(data));
      });
      out.execFile = await new Promise((resolve) => execFile(PROBE[0], PROBE.slice(1), { env: ENV }, (e, stdout) => resolve(stdout)));
      out.plain = spawnSync('/bin/echo', ['x'], { encoding: 'utf8' }).stdout;`);
    for (const key of ['sync', 'async', 'execFile']) assert.match(out[key], /INT=1 TERM=0/, key);
    assert.equal(out.plain, 'x\n');
  });

  it('nothing is wrapped when nothing was ignored (the default disposition is kept)', () => {
    const out = harness(`
      const { spawnSync } = await import(${JSON.stringify(join(REPO, 'lcu/compat/spawn.mjs'))});
      out.sync = spawnSync(PROBE[0], PROBE.slice(1), { encoding: 'utf8', env: ENV }).stdout;`, { ignored: '' });
    assert.match(out.sync, /INT=0 TERM=0/);
  });

  it('the wrapper keeps the pid (kill, timeout and wait status apply to the target)', () => {
    const out = harness(`
      const { spawn } = await import(${JSON.stringify(join(REPO, 'lcu/compat/spawn.mjs'))});
      out.pid = await new Promise((resolve) => {
        let data = '';
        const child = spawn(PROBE[0], PROBE.slice(1), { env: ENV });
        child.stdout.on('data', (chunk) => { data += chunk; });
        child.on('close', () => resolve({ reported: data.match(/pid=(\\d+)/)[1], pid: String(child.pid) }));
      });`);
    assert.equal(out.pid.reported, out.pid.pid);
  });

  it('compat/subprocess run, runas runProcess and capture.run (the callers of the shared seam)', async () => {
    const out = harness(`
      const subprocess = await import(${JSON.stringify(join(REPO, 'lcu/compat/subprocess.mjs'))});
      const runas = await import(${JSON.stringify(join(REPO, 'lcu/compat/runas.mjs'))});
      const capture = await import(${JSON.stringify(join(REPO, 'lcu/capture.mjs'))});
      out.run = subprocess.run(PROBE, { env: ENV, capture: true }).stdout;
      out.runProcess = runas.runProcess(PROBE, { env: ENV, capture: true }).stdout;
      out.devnull = runas.runProcess(['/bin/sh', '-c', 'exit 0'], { env: ENV, stdout: 'devnull' }).returncode;
      out.capture = (await capture.run(PROBE, { env: ENV, stdout: 'pipe', capture_output: true })).stdout.toString?.() ?? '';`);
    assert.match(out.run, /INT=1 TERM=0/);
    assert.match(out.runProcess, /INT=1 TERM=0/);
    assert.equal(out.devnull, 0);
    assert.match(out.capture, /INT=1 TERM=0/);
  });

  it('app_server popen (worker thread) starts its child with them ignored', () => {
    const out = harness(`
      const { popen } = await import(${JSON.stringify(join(REPO, 'lcu/app_server.mjs'))});
      const child = popen(PROBE, { env: ENV, stderrFd: 2 });
      let text = '';
      for (let i = 0; i < 100 && !/pid=/.test(text); i++) {
        if (child.ready(0.1)) { const part = child.read1(); if (part.length === 0) break; text += part.toString(); }
      }
      out.text = text;
      child.close?.();`);
    assert.match(out.text, /INT=1 TERM=0/);
  });

  it('execve and execvpe leave them ignored in the new program (same pid)', () => {
    const script = (call) => `
      const sv = await import(${JSON.stringify(join(REPO, 'lcu/startup_vars.mjs'))});
      sv.restore_environment({ __LCU_SIGIGN: 'INT' });
      const { execve, execvpe } = await import(${JSON.stringify(join(REPO, 'lcu/compat/execve.mjs'))});
      process.stdout.write('node=' + process.pid + '\\n');
      ${call}`;
    const argv = JSON.stringify(['bash', '-p', '-c', DISPOSITION_SCRIPT]);
    for (const call of [`execve('/bin/bash', ${argv}, { PATH: '/usr/bin:/bin' });`,
      `execvpe('bash', ${argv}, { PATH: '/bin:/usr/bin' });`]) {
      const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script(call)],
        { encoding: 'utf8', env: { PATH: process.env.PATH } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /INT=1 TERM=0/);
      assert.equal(result.stdout.match(/pid=(\d+)/)[1], result.stdout.match(/node=(\d+)/)[1]);
    }
  });

  it('an unusable program still fails exactly as before (no shell exit status 127)', () => {
    const out = harness(`
      const subprocess = await import(${JSON.stringify(join(REPO, 'lcu/compat/subprocess.mjs'))});
      const attempt = (cmd, options = {}) => { try { subprocess.run(cmd, { env: ENV, ...options }); return 'ran'; } catch (e) { return e.message; } };
      out.missing = attempt(['/nonexistent/program']);
      out.missingName = attempt(['lcu-no-such-program']);
      out.directory = attempt(['/tmp']);
      out.cwd = attempt(['/bin/echo'], { cwd: '/nonexistent/dir' });`);
    assert.equal(out.missing, "[Errno 2] No such file or directory: '/nonexistent/program'");
    assert.equal(out.missingName, "[Errno 2] No such file or directory: 'lcu-no-such-program'");
    assert.match(out.directory, /^\[Errno 13\] Permission denied: '\/tmp'$/);
    assert.equal(out.cwd, "[Errno 2] No such file or directory: '/nonexistent/dir'");
  });

  it('the privilege-dropping helper (accounts.spawnAsSync) re-ignores them for the target (as root)',
    { skip: process.getuid?.() !== 0 && 'needs root (initgroups/setuid)' }, () => {
      const out = harness(`
        const accounts = await import(${JSON.stringify(join(REPO, 'lcu/compat/accounts.mjs'))});
        const account = accounts.findpwuid(process.getuid());
        const result = accounts.spawnAsSync(account, PROBE[0], PROBE, { env: ENV, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
        out.text = String(result.stdout);`);
      assert.match(out.text, /INT=1 TERM=0/);
    });

  it('Linux: the kernel really records the ignored signals (SigIgn) of a wrapped child', {
    skip: process.platform !== 'linux' && 'needs /proc',
  }, () => {
    const out = harness(`
      const { spawnSync } = await import(${JSON.stringify(join(REPO, 'lcu/compat/spawn.mjs'))});
      out.sigign = spawnSync('/bin/sh', ['-c', 'sed -n "s/^SigIgn:[[:space:]]*//p" /proc/$$/status'], { encoding: 'utf8', env: ENV }).stdout.trim();`);
    const mask = BigInt(`0x${out.sigign}`);
    assert.equal((mask >> 1n) & 1n, 1n, 'SIGINT (2) ignored');
    assert.equal((mask >> 0n) & 1n, 1n, 'SIGHUP (1) ignored');
    assert.equal((mask >> 14n) & 1n, 0n, 'SIGTERM (15) default');
  });
});

describe('every child_process call form keeps the ignored signals and the ENOEXEC refusal (round-2 N3)', { skip: !HAS_BASH && 'needs /bin/bash' }, () => {
  it('spawn/spawnSync/execFile without an args array, argv0 through the wrapper', () => {
    const out = harness(`
      const { spawnSync, spawn, execFile } = await import(${JSON.stringify(join(REPO, 'lcu/compat/spawn.mjs'))});
      const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const dir = mkdtempSync(tmpdir() + '/lcu-forms-');
      const probe = dir + '/probe';
      writeFileSync(probe, '#!/bin/bash\\n' + ${JSON.stringify(DISPOSITION_SCRIPT)} + '\\n');
      chmodSync(probe, 0o755);
      const text = dir + '/text';
      writeFileSync(text, 'echo not a program\\n');
      chmodSync(text, 0o755);
      const collect = (child) => new Promise((resolve) => { let data = ''; child.stdout.on('data', (c) => { data += c; }); child.on('close', () => resolve(data)); });
      out.syncNoArgs = spawnSync(probe, { encoding: 'utf8', env: ENV }).stdout;
      out.syncFileOnly = spawnSync(probe).stdout?.toString() ?? '';
      out.spawnNoArgs = await collect(spawn(probe, { env: ENV, stdio: ['ignore', 'pipe', 'inherit'] }));
      out.execFileCb = await new Promise((r) => execFile(probe, (e, so) => r(so)));
      out.execFileOptsCb = await new Promise((r) => execFile(probe, { encoding: 'utf8', env: ENV }, (e, so) => r(so)));
      out.execFileArgsCb = await new Promise((r) => execFile(probe, [], (e, so) => r(so)));
      out.argv0 = spawnSync('/bin/sh', ['-c', 'echo $0'], { argv0: 'custom', encoding: 'utf8', env: ENV }).stdout;
      out.argv0Signals = spawnSync('/bin/bash', ['-c', ${JSON.stringify(DISPOSITION_SCRIPT)}], { argv0: 'custom', encoding: 'utf8', env: ENV }).stdout;
      out.enoexec = [
        spawnSync(text, { env: ENV }).error?.code,
        spawnSync(text, [], { env: ENV }).error?.code,
        await new Promise((r) => { const c = spawn(text, { env: ENV }); c.on('error', (e) => r(e.code)); }),
        await new Promise((r) => execFile(text, (e) => r(e?.code))),
        await new Promise((r) => execFile(text, { env: ENV }, (e) => r(e?.code))),
      ];`);
    for (const key of ['syncNoArgs', 'syncFileOnly', 'spawnNoArgs', 'execFileCb', 'execFileOptsCb', 'execFileArgsCb', 'argv0Signals']) {
      assert.match(out[key], /INT=1 TERM=0/, key);
    }
    assert.equal(out.argv0.trim(), 'custom');
    assert.deepEqual(out.enoexec, ['ENOEXEC', 'ENOEXEC', 'ENOEXEC', 'ENOEXEC', 'ENOEXEC']);
  });
});

describe('no module starts a child process around the shared seam', () => {
  const ALLOWED = new Map([
    ['lcu/compat/spawn.mjs', 'the seam itself'],
    ['lcu/runtime.mjs', 'supervise() wraps by hand: it must reject an unusable program with execError before spawning'],
    ['scripts/windows_launcher.mjs', 'copied to <prefix>\\windows_launcher.mjs outside the release; Windows only (no signal dispositions)'],
    ['lcu/startup_vars.mjs', 'one-time probe of /usr/bin/env and /usr/bin/perl (empty env, no signals involved); it must not import the seam, which imports it'],
    ['lcu/app_server.mjs', 'the process-host worker thread spawns; the command is wrapped (wrapForSignals) before it is handed over'],
  ]);
  const files = [];
  for (const dir of ['lcu', 'lcu/compat', 'scripts']) {
    for (const name of readdirSync(join(REPO, dir))) if (name.endsWith('.mjs') || name.endsWith('.cjs')) files.push(`${dir}/${name}`);
  }
  it('imports of node:child_process are only the seam and documented exceptions', () => {
    const offenders = files.filter((file) => /['"]node:child_process['"]|['"]child_process['"]/.test(readFileSync(join(REPO, file), 'utf8'))
      && !ALLOWED.has(file));
    assert.deepEqual(offenders, []);
  });
});
