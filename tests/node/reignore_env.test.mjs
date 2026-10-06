// The environment a child gets when LCU re-ignores the caller's signals must be byte-identical to the one LCU meant
// to give it (names that are not shell identifiers, exported functions, empty values, newlines, PWD/IFS/SHELLOPTS/
// OLDPWD/_ untouched), and the ignored signals must stay ignored. A POSIX shell wrapper (dash) dropped `A.B`,
// `FOO-BAR`, `SPACE KEY`; startup_vars.reignore uses GNU env or perl instead. Every spawn seam and the exec paths
// are checked, per available mechanism, with and without ignored signals.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DISPOSITION_SCRIPT } from './runtime_support.mjs';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const EXPECTED = {
  PATH: '/usr/bin:/bin', 'A.B': '2', 'FOO-BAR': '3', 'SPACE KEY': '4', NL: 'a\nb\n', EMPTY: '', EQ: 'a=b=c',
  'BASH_FUNC_f%%': '() {  echo hi\n}', 'BASH_FUNC_g()': '() { echo g; }', 'TAB\tN': 't', lower: 'x',
  UNI: 'héllo ☃ 😀', LONG: 'v'.repeat(100000), PWD: '/nonsense', OLDPWD: '/o', IFS: 'q', SHELLOPTS: 'xtrace',
  BASH_ENV: '/nonexistent', ENV: '/nonexistent', SHLVL: '7', _: 'u',
};
// `env -0` (GNU and macOS BSD env both have it; /proc/<pid>/environ is checked in the Linux-only test below).
const ENV0 = existsSync('/usr/bin/env') ? '/usr/bin/env' : '/bin/env';

const SEAMS = ['execve', 'compat-execve', 'spawnSync', 'spawn', 'execFile', 'supervise'];

function runSeam(seam, mechanism, ignored, env, command) {
  const script = `
    const sv = await import(${JSON.stringify(join(REPO, 'lcu/startup_vars.mjs'))});
    const [seam, mechanism, ignored, env, command] = JSON.parse(process.argv.at(-1));
    sv.restore_environment({ __LCU_SIGIGN: ignored.join(',') });
    const tools = sv.reignore_tools();
    if (mechanism === 'perl') tools.env = null;
    if (mechanism === 'none') { tools.env = null; tools.perl = false; }
    const [file, ...args] = command;
    if (seam === 'execve') {
      const [f, a] = sv.reignore(file, command, env);
      process.execve(f, a, env);
    } else if (seam === 'compat-execve') {
      const { execve } = await import(${JSON.stringify(join(REPO, 'lcu/compat/execve.mjs'))});
      execve(file, command, env);
    } else if (seam === 'supervise') {
      const { supervise } = await import(${JSON.stringify(join(REPO, 'lcu/runtime.mjs'))});
      await supervise(command, env);
    } else {
      const sp = await import(${JSON.stringify(join(REPO, 'lcu/compat/spawn.mjs'))});
      if (seam === 'spawnSync') sp.spawnSync(file, args, { env, stdio: 'inherit' });
      else if (seam === 'spawn') await new Promise((r) => sp.spawn(file, args, { env, stdio: 'inherit' }).on('close', r));
      else await new Promise((r) => sp.execFile(file, args, { env }, (e, out) => { process.stdout.write(out); r(); }));
    }`;
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script,
    JSON.stringify([seam, mechanism, ignored, env, command])], { env: { PATH: '/usr/bin:/bin' }, maxBuffer: 1 << 24 });
}

const entries = (buffer) => buffer.toString('latin1').split('\0').filter(Boolean).sort();
const wanted = (env) => Object.entries(env).map(([k, v]) => Buffer.from(`${k}=${v}`).toString('latin1')).sort();

describe('reignore keeps the environment byte-identical', () => {
  const mechanisms = ['env', 'perl', 'none'];
  for (const mechanism of mechanisms) {
    for (const seam of SEAMS) {
      for (const ignored of [[], ['INT'], ['HUP', 'INT', 'TERM']]) {
        it(`${seam} via ${mechanism}, ignored=[${ignored}]`, (t) => {
          const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
            const sv = await import(${JSON.stringify(join(REPO, 'lcu/startup_vars.mjs'))});
            console.log(JSON.stringify(sv.reignore_tools()));`], { encoding: 'utf8' });
          const tools = JSON.parse(probe.stdout);
          if (mechanism === 'env' && !tools.env) return t.skip('no env with --ignore-signal here (macOS BSD env)');
          if (mechanism === 'perl' && !tools.perl) return t.skip('no /usr/bin/perl');
          const result = runSeam(seam, mechanism, ignored, EXPECTED, [ENV0, '-0']);
          assert.equal(result.status, 0, String(result.stderr));
          assert.deepEqual(entries(result.stdout), wanted(EXPECTED));
        });
      }
    }
  }

  it('a PERL* variable disables the perl mechanism (no env change, no re-ignore) instead of running caller code', (t) => {
    const tools = JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', `
      const sv = await import(${JSON.stringify(join(REPO, 'lcu/startup_vars.mjs'))});
      console.log(JSON.stringify(sv.reignore_tools()));`], { encoding: 'utf8' }).stdout);
    if (tools.env || !tools.perl) return t.skip('needs perl without a usable env');
    const env = { ...EXPECTED, PERL5OPT: '-Mstrict' };
    const result = runSeam('spawnSync', 'perl', ['INT'], env, [ENV0, '-0']);
    assert.deepEqual(entries(result.stdout), wanted(env));
  });

  it('a file name containing "=" is not taken for an env assignment', (t) => {
    const tools = JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', `
      const sv = await import(${JSON.stringify(join(REPO, 'lcu/startup_vars.mjs'))});
      console.log(JSON.stringify(sv.reignore_tools()));`], { encoding: 'utf8' }).stdout);
    if (!tools.perl && !tools.env) return t.skip('no mechanism');
    const sv = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const sv = await import(${JSON.stringify(join(REPO, 'lcu/startup_vars.mjs'))});
      const out = sv.reignore('/tmp/a=b/prog', ['/tmp/a=b/prog', 'x'], { A: '1' }, ['INT']);
      console.log(JSON.stringify(out));`], { encoding: 'utf8' });
    const [file, argv] = JSON.parse(sv.stdout);
    assert.notEqual(file, tools.env, 'GNU env would run "a=b" as an assignment');
    if (tools.perl) assert.equal(file, '/usr/bin/perl');
    assert.equal(argv.at(-2), '/tmp/a=b/prog');
  });
});

describe('reignore keeps ignored signals ignored and the pid', () => {
  for (const mechanism of ['env', 'perl']) {
    for (const seam of ['execve', 'compat-execve', 'spawnSync']) {
      it(`${seam} via ${mechanism}`, (t) => {
        if (!existsSync('/bin/bash')) return t.skip('needs /bin/bash to report dispositions');
        const tools = JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', `
          const sv = await import(${JSON.stringify(join(REPO, 'lcu/startup_vars.mjs'))});
          console.log(JSON.stringify(sv.reignore_tools()));`], { encoding: 'utf8' }).stdout);
        if (!tools[mechanism]) return t.skip(`no ${mechanism} mechanism here`);
        const result = runSeam(seam, mechanism, ['INT'], { PATH: '/usr/bin:/bin', 'A.B': '1' },
          ['/bin/bash', '-p', '-c', DISPOSITION_SCRIPT]);
        assert.equal(result.status, 0, String(result.stderr));
        assert.match(String(result.stdout), /INT=1 TERM=0/);
      });
    }
  }
});

describe('reignore on Linux: /proc/<pid>/environ of the started program', () => {
  for (const mechanism of ['env', 'perl']) {
    it(`${mechanism}: same pid, environ byte-identical`, { skip: process.platform !== 'linux' }, (t) => {
      const tools = JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', `
        const sv = await import(${JSON.stringify(join(REPO, 'lcu/startup_vars.mjs'))});
        console.log(JSON.stringify(sv.reignore_tools()));`], { encoding: 'utf8' }).stdout);
      if (!tools[mechanism]) return t.skip(`no ${mechanism} mechanism here`);
      const script = `
        const sv = await import(${JSON.stringify(join(REPO, 'lcu/startup_vars.mjs'))});
        const { readFileSync } = await import('node:fs');
        const [mechanism, env] = JSON.parse(process.argv.at(-1));
        sv.restore_environment({ __LCU_SIGIGN: 'INT,TERM' });
        if (mechanism === 'perl') sv.reignore_tools().env = null;
        const sp = await import(${JSON.stringify(join(REPO, 'lcu/compat/spawn.mjs'))});
        const child = sp.spawn('/bin/sleep', ['30'], { env, stdio: 'ignore' });
        let cmd = '';
        for (let i = 0; i < 200 && !/sleep/.test(cmd); i++) {
          await new Promise((r) => setTimeout(r, 25));
          cmd = readFileSync('/proc/' + child.pid + '/cmdline', 'latin1');
        }
        const environ = readFileSync('/proc/' + child.pid + '/environ').toString('base64');
        const status = readFileSync('/proc/' + child.pid + '/status', 'utf8').match(/SigIgn:\\s*(\\w+)/)[1];
        child.kill('SIGKILL'); // TERM is ignored in the child on purpose
        process.stdout.write(JSON.stringify({ environ, status, cmd }));`;
      const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script,
        JSON.stringify([mechanism, EXPECTED])], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', maxBuffer: 1 << 24 });
      assert.equal(result.status, 0, result.stderr);
      const seen = JSON.parse(result.stdout);
      assert.match(seen.cmd, /^\/bin\/sleep\0/);
      assert.deepEqual(entries(Buffer.from(seen.environ, 'base64')), wanted(EXPECTED));
      assert.equal((BigInt('0x' + seen.status) >> 1n) & 1n, 1n, 'INT ignored');
      assert.equal((BigInt('0x' + seen.status) >> 14n) & 1n, 1n, 'TERM ignored');
    });
  }
});
