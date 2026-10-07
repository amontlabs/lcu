// lcu/compat/spawn.mjs: round-2 launch review F5 (NODE_V8_COVERAGE injection), F6 (cwd-relative PATH search keeps
// ignored signals), F9 (no ENOEXEC shell fallback, incl. the native-host relay). Every case runs in a fresh Node
// started by the test; nothing sends a signal (SAFETY RULE): dispositions are only read.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { machine } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DISPOSITION_SCRIPT, tempDir } from './runtime_support.mjs';
import { skippedOnWindows } from './windows_skip.mjs';

const { describe, it } = skippedOnWindows('compat/spawn re-ignores signals and refuses ENOEXEC for POSIX children (/usr/bin/env, bash, shebang scripts); Windows launches children with CreateProcess');

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const SPAWN = JSON.stringify(join(REPO, 'lcu/compat/spawn.mjs'));
const VARS = JSON.stringify(join(REPO, 'lcu/startup_vars.mjs'));

function harness(dir, body, env = {}) {
  const file = join(dir, `harness-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, `const sp = await import(${SPAWN}); const sv = await import(${VARS});\nconst out = {};\n${body}\n` +
    'process.stdout.write(JSON.stringify(out));');
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', file],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } });
  assert.equal(done.status, 0, done.stderr);
  return JSON.parse(done.stdout);
}

describe('compat/spawn', () => {
  let temporary;
  beforeEach(() => { temporary = tempDir(); });
  afterEach(() => temporary.cleanup());

  it('F5: an explicit env never gains the parent\'s NODE_V8_COVERAGE, and is not mutated', () => {
    const coverage = join(temporary.path, 'coverage');
    mkdirSync(coverage);
    const out = harness(temporary.path, `
      const mutable = { PATH: '/usr/bin:/bin', HOME: '/h' };
      const frozen = Object.freeze({ PATH: '/usr/bin:/bin' });
      const quarantined = sv.quarantine_environment({ PATH: '/usr/bin:/bin', NODE_V8_COVERAGE: '/elsewhere' });
      out.sync = sp.spawnSync('/usr/bin/env', [], { env: mutable, encoding: 'utf8' }).stdout;
      out.frozen = sp.spawnSync('/usr/bin/env', [], { env: frozen, encoding: 'utf8' }).stdout;
      out.quarantined = sp.spawnSync('/usr/bin/env', [], { env: quarantined, encoding: 'utf8' }).stdout;
      out.async = await new Promise((resolve) => { let text = ''; const c = sp.spawn('/usr/bin/env', [], { env: mutable });
        c.stdout.on('data', (d) => { text += d; }); c.on('close', () => resolve(text)); });
      out.execFile = await new Promise((resolve) => sp.execFile('/usr/bin/env', [], { env: mutable }, (e, so) => resolve(so)));
      out.inherited = sp.spawnSync('/usr/bin/env', [], { encoding: 'utf8' }).stdout;
      out.mutable = mutable;
      out.explicit = sp.spawnSync('/usr/bin/env', [], { env: { PATH: '/usr/bin:/bin', NODE_V8_COVERAGE: '/chosen' }, encoding: 'utf8' }).stdout;`,
    { NODE_V8_COVERAGE: coverage });
    for (const key of ['sync', 'frozen', 'async', 'execFile']) assert.ok(!out[key].includes('NODE_V8_COVERAGE'), `${key}: ${out[key]}`);
    assert.ok(out.quarantined.includes('__LCU_Q_NODE_V8_COVERAGE=/elsewhere'));
    assert.ok(!out.quarantined.split('\n').some((line) => line.startsWith('NODE_V8_COVERAGE=')));
    assert.deepEqual(out.mutable, { PATH: '/usr/bin:/bin', HOME: '/h' });
    assert.ok(out.inherited.includes(`NODE_V8_COVERAGE=${coverage}`), 'an inherited environment keeps it, as in Python');
    assert.ok(out.explicit.includes('NODE_V8_COVERAGE=/chosen'), 'an explicitly requested value is passed');
  });

  it('F6: a PATH entry relative to the child\'s cwd still gets the ignored signals back', (t) => {
    if (!existsSync('/bin/bash')) return t.skip('needs /bin/bash');
    const child = join(temporary.path, 'child');
    mkdirSync(join(child, 'sub'), { recursive: true });
    for (const where of ['probe', 'sub/probe']) {
      writeFileSync(join(child, where), `#!/bin/bash -p\n${DISPOSITION_SCRIPT}\n`);
      chmodSync(join(child, where), 0o755);
    }
    const out = harness(temporary.path, `
      sv.restore_environment({ __LCU_SIGIGN: 'TERM' });
      for (const [name, PATH] of [['dot', '.'], ['empty', ':/usr/bin'], ['relative', 'sub'], ['absolute', ${JSON.stringify(child)}]]) {
        out[name] = sp.spawnSync('probe', [], { cwd: ${JSON.stringify(child)}, env: { PATH, HOME: '/h' }, encoding: 'utf8' }).stdout;
      }
      out.relativeFile = sp.spawnSync('./probe', [], { cwd: ${JSON.stringify(child)}, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' }).stdout;`);
    for (const [key, text] of Object.entries(out)) assert.match(text, /TERM=1/, key);
  });

  it('F9: a shebang-less text "executable" is ENOEXEC (never run through a shell) on every entry point', () => {
    const marker = join(temporary.path, 'ran');
    const fake = join(temporary.path, 'text-host');
    writeFileSync(fake, `touch '${marker}'\n`);
    chmodSync(fake, 0o755);
    const out = harness(temporary.path, `
      const fake = ${JSON.stringify(fake)};
      const r = sp.spawnSync(fake, ['a']);
      out.sync = [r.error?.code, r.error?.path, r.status];
      out.async = await new Promise((resolve) => { const c = sp.spawn(fake, ['a'], { stdio: 'ignore' });
        c.once('error', (e) => resolve([e.code, e.path, e.syscall])); });
      out.execFile = await new Promise((resolve) => sp.execFile(fake, ['a'], {}, (e) => resolve([e?.code, e?.path])));
      out.byPath = sp.spawnSync('text-host', [], { env: { PATH: ${JSON.stringify(temporary.path)} } }).error?.code;`);
    assert.deepEqual(out.sync, ['ENOEXEC', fake, null]);
    assert.deepEqual(out.async, ['ENOEXEC', fake, `spawn ${fake}`]);
    assert.deepEqual(out.execFile, ['ENOEXEC', fake]);
    assert.equal(out.byPath, 'ENOEXEC');
    assert.ok(!existsSync(marker), 'the text must not have been executed');
  });

  it('F9: the native-host relay refuses a shebang-less host with Python\'s Exec format error', (t) => {
    const system = { darwin: 'macos', linux: 'linux' }[process.platform];
    if (!system) return t.skip('POSIX only');
    const arch = { arm64: 'arm64', aarch64: 'arm64', x86_64: 'x64', amd64: 'x64' }[machine().toLowerCase()];
    const name = system === 'macos' ? 'ChatGPT for Chrome' : 'extension-host';
    const hostDir = join(temporary.path, 'relay/chrome/extension-host', system, arch);
    mkdirSync(hostDir, { recursive: true });
    const marker = join(temporary.path, 'NO_SHEBANG_HOST_EXECUTED');
    writeFileSync(join(hostDir, name), `touch '${marker}'\nexit 0\n`);
    chmodSync(join(hostDir, name), 0o755);
    const driver = `const m = await import(${JSON.stringify(new URL('../../lcu/native_host.mjs', import.meta.url).href)});` +
      'const [dir, ...rest] = process.argv.slice(1); process.exit(await m.run(dir, rest));';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver, join(temporary.path, 'relay')],
      { input: '', encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\[Errno 8\] Exec format error/);
    assert.ok(!existsSync(marker), 'the text host must not run');
  });
});
