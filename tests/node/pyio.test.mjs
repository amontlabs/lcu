// lcu/compat/pyio.mjs (Python's stdout buffering) and lcu/compat/pytrace.mjs (CPython's uncaught-exception text).
// Each case runs a small program in a fresh Node whose stdout is a pipe (the buffered case Python has) and compares
// with what the same program does under CPython (python312(): the oracle for the exact boundaries).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { python312 } from './runtime_support.mjs';
import { skipOnWindows } from './windows_skip.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const PYIO = join(REPO, 'lcu/compat/pyio.mjs');
const PYTRACE = join(REPO, 'lcu/compat/pytrace.mjs');
// The buffering rules are those of CPython 3.12.10 (the project's reference; 3.12.3 pre-flushes differently), so the
// oracle must be exactly that interpreter: /opt/cpython-3.12.10 in the black-box image, LCU_TEST_PYTHON elsewhere.
function python31210() {
  for (const candidate of [process.env.LCU_TEST_PYTHON, process.env.LCU_PYTHON312, '/opt/cpython-3.12.10/bin/python3.12',
    python312(), 'python3.12', 'python3']) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[:3] == (3, 12, 10))'], { encoding: 'utf8' });
    if (probe.stdout?.trim() === 'True') return candidate;
  }
  return null;
}
const PYTHON = python31210();
const NO_ORACLE = (PYTHON === null && 'needs CPython 3.12.10 (LCU_TEST_PYTHON)') ||
  skipOnWindows('compares with CPython\'s POSIX pipe buffering (st_blksize, no CRLF translation) using /bin/echo, /bin/sh and execve children');

function node(body) {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-pyio-'));
  try {
    const file = join(directory, 'main.mjs');
    writeFileSync(file, `import { stdout_write as out, stdout_flush as flush, stderr_write as err } from ${JSON.stringify(pathToFileURL(PYIO).href)};
import { spawnSync } from 'node:child_process';
${body}`);
    const done = spawnSync(process.execPath, [file], { encoding: 'utf8' });
    return { status: done.status, signal: done.signal, stdout: done.stdout, stderr: done.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

function python(body) {
  const done = spawnSync(PYTHON, ['-c', `import subprocess, sys, os\n${body}`], { encoding: 'utf8' });
  return { status: done.status, signal: done.signal, stdout: done.stdout, stderr: done.stderr };
}

describe('stdout is block buffered on a pipe, like Python', { skip: NO_ORACLE }, () => {
  it('a child that inherits stdout writes before the parent\'s earlier lines', () => {
    const got = node(`out('parent before child\\n'); spawnSync('/bin/echo', ['child'], { stdio: 'inherit' }); out('after\\n');`);
    assert.equal(got.stdout, 'child\nparent before child\nafter\n');
    const want = python(`print('parent before child'); subprocess.run(['/bin/echo', 'child']); print('after')`);
    assert.equal(got.stdout, want.stdout);
  });

  it('flush() publishes the buffer at once (input() prompts, print(flush=True))', () => {
    const got = node(`out('one\\n'); flush(); spawnSync('/bin/echo', ['child'], { stdio: 'inherit' }); out('two\\n');`);
    assert.equal(got.stdout, 'one\nchild\ntwo\n');
  });

  it('is written at exit, by process.exit() and by an uncaught error', () => {
    assert.equal(node(`out('x\\n'); process.exit(3);`).stdout, 'x\n');
    assert.equal(node(`out('x\\n'); process.exit(3);`).status, 3);
    const thrown = node(`out('y\\n'); throw new Error('boom');`);
    assert.equal(thrown.stdout, 'y\n');
    assert.equal(thrown.status, 1);
  });

  it('is lost on execve, like os.execve (nothing is flushed)', () => {
    const got = node(`out('lost\\n'); process.execve('/bin/echo', ['echo', 'replaced'], process.env);`);
    assert.equal(got.stdout, 'replaced\n');
    const want = python(`print('lost'); os.execve('/bin/echo', ['echo', 'replaced'], os.environ)`);
    assert.equal(got.stdout, want.stdout);
  });

  it('flushes at the same sizes as TextIOWrapper over BufferedWriter (8192-byte chunk, st_blksize buffer)', () => {
    // A child's marker after writes of various sizes lands where Python's buffer boundaries put it.
    for (const sizes of [[4095], [4096], [4097], [8191], [8192], [8193], [16383], [16384], [16385], [4000, 4000, 4000],
      [100, 8100], [8192, 1], [1, 8192], [20000, 5], [3000, 3000, 3000, 3000, 3000], [40000], [5000, 5000, 5000, 5000],
      [16000, 500, 500]]) {
      const got = node(`for (const n of ${JSON.stringify(sizes)}) out('a'.repeat(n));
spawnSync('/bin/echo', ['MARK'], { stdio: 'inherit' }); out('tail');`);
      const want = python(`for n in ${JSON.stringify(sizes)}: sys.stdout.write('a' * n)
subprocess.run(['/bin/echo', 'MARK']); sys.stdout.write('tail')`);
      assert.equal(got.stdout.replace(/a+/g, (run) => `a${run.length};`), want.stdout.replace(/a+/g, (run) => `a${run.length};`),
        JSON.stringify(sizes));
    }
  });

  it('matches CPython on random write/flush/child-output sequences (seeded)', () => {
    // mulberry32: the same sequences on every run and every Node.
    const rng = (seed) => () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (random, items) => items[Math.floor(random() * items.length)];
    for (let seed = 0; seed < 150; seed += 1) {
      const random = rng(seed);
      const ops = [];
      for (let i = 3 + Math.floor(random() * 12); i > 0; i -= 1) {
        const kind = random();
        if (kind < 0.55) {
          const text = pick(random, ['a', 'é', '漢', '\u{1F600}']).repeat(pick(random, [1, 5, 100, 4000, 8190, 8191, 8192, 8193, 9000, 20000]));
          ops.push(['w', random() < 0.3 ? `${text}\n` : text]);
        } else if (kind < 0.8) ops.push(['c', pick(random, ['X', 'Y', 'Z'])]);
        else ops.push(['f']);
      }
      const directory = mkdtempSync(join(tmpdir(), 'lcu-pyio-'));
      try {
        const file = join(directory, 'ops.json');
        writeFileSync(file, JSON.stringify(ops));
        const want = spawnSync(PYTHON, ['-c', `import sys, json, subprocess
for o in json.load(open(sys.argv[1])):
    if o[0] == 'w': sys.stdout.write(o[1])
    elif o[0] == 'f': sys.stdout.flush()
    else: subprocess.run(['/bin/sh', '-c', 'printf %s ' + o[1]])`, file]);
        const program = join(directory, 'main.mjs');
        writeFileSync(program, `import { stdout_write, stdout_flush } from ${JSON.stringify(pathToFileURL(PYIO).href)};
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
for (const o of JSON.parse(readFileSync(process.argv[2], 'utf8'))) {
  if (o[0] === 'w') stdout_write(o[1]); else if (o[0] === 'f') stdout_flush();
  else spawnSync('/bin/sh', ['-c', 'printf %s ' + o[1]], { stdio: 'inherit' });
}`);
        const got = spawnSync(process.execPath, [program, file]);
        assert.equal(got.stdout.toString('latin1'), want.stdout.toString('latin1'), `seed ${seed}: ${JSON.stringify(ops.map((o) => (o[0] === 'w' ? ['w', o[1].length] : o)))}`);
      } finally {
        rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    }
  });

  it('lone surrogates follow the stdout error handler of the locale, like CPython', () => {
    const text = 'a\\udcffb\\n';
    for (const env of [{ LC_ALL: 'C.UTF-8' }, { LC_ALL: 'C' }, { LANG: 'POSIX' }, { LC_ALL: 'en_US.UTF-8' }, { LANG: 'fr_FR.UTF-8' },
      { LC_ALL: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8:replace' }, { LC_ALL: 'en_US.UTF-8', PYTHONUTF8: '1' }]) {
      const runEnv = { PATH: process.env.PATH, ...env };
      // A locale that is not installed here (en_US on a bare container) is the C locale to CPython; the rule
      // models installed UTF-8 locales, so only compare the strict cases where CPython really is strict.
      const handler = spawnSync(PYTHON, ['-c', 'import sys; print(sys.stdout.errors)'], { env: runEnv, encoding: 'utf8' }).stdout.trim();
      if (/en_US|fr_FR/.test(JSON.stringify(env)) && handler !== 'strict' && !env.PYTHONUTF8 && !env.PYTHONIOENCODING) continue;
      const directory = mkdtempSync(join(tmpdir(), 'lcu-pyio-'));
      try {
        const program = join(directory, 'main.mjs');
        writeFileSync(program, `import { stdout_write } from ${JSON.stringify(pathToFileURL(PYIO).href)};\nstdout_write('${text}');`);
        const got = spawnSync(process.execPath, [program], { env: runEnv });
        const want = spawnSync(PYTHON, ['-c', `import sys; sys.stdout.write('${text}')`], { env: runEnv });
        assert.equal(want.status === 0, got.status === 0, JSON.stringify(env));
        assert.equal(got.stdout.toString('latin1'), want.stdout.toString('latin1'), JSON.stringify(env));
        if (want.status !== 0) assert.match(got.stderr.toString(), /UnicodeEncodeError: 'utf-8' codec can't encode character '\\udcff' in position 1: surrogates not allowed/);
      } finally {
        rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    }
  });

  it('stderr is written immediately', () => {
    const got = node(`out('o\\n'); err('e\\n'); spawnSync('/bin/echo', ['child'], { stdio: ['ignore', 'inherit', 'inherit'] });`);
    assert.equal(got.stderr, 'e\n');
  });

  it('a closed reader is noticed at the flush: Exception ignored, exit 120', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lcu-pyio-'));
    try {
      const file = join(directory, 'main.mjs');
      writeFileSync(file, `import { stdout_write as out } from ${JSON.stringify(pathToFileURL(PYIO).href)};\nout('data\\n');`);
      // The reader closes its end at once; the writer's status is reported on stderr after its own output.
      const script = '( "$0" "$@"; echo "status=$?" >&2 ) | ( exec 0<&-; sleep 1 )';
      const done = spawnSync('/bin/sh', ['-c', script, process.execPath, file], { encoding: 'utf8' });
      assert.match(done.stderr, /^Exception ignored in: <_io.TextIOWrapper name='<stdout>' mode='w' encoding='utf-8'>\nBrokenPipeError: \[Errno 32\] Broken pipe\nstatus=120\n$/);
      const want = spawnSync('/bin/sh', ['-c', script, PYTHON, '-c', 'print(1)'], { encoding: 'utf8' });
      assert.match(want.stderr, /status=120\n$/);
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});

function trace(body) {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-pytrace-'));
  try {
    const file = join(directory, 'main.mjs');
    writeFileSync(file, `import { format_traceback, python_exception } from ${JSON.stringify(pathToFileURL(PYTRACE).href)};
import { PyOSError } from ${JSON.stringify(pathToFileURL(join(REPO, 'lcu/compat/pyerr.mjs')).href)};
${body}`);
    const done = spawnSync(process.execPath, [file], { encoding: 'utf8' });
    assert.equal(done.status, 0, done.stderr);
    return JSON.parse(done.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

describe('uncaught exceptions read like CPython\'s', () => {
  it('Python type and message per error class', () => {
    const out = trace(`
      const cases = {};
      cases.module = python_exception(Object.assign(new Error("Cannot find module '/r/lcu/macos_host.mjs' imported from /r/lcu/runtime.mjs"), { code: 'ERR_MODULE_NOT_FOUND' }), '/r');
      cases.package = python_exception(Object.assign(new Error("Cannot find package 'zzz' imported from /r/lcu/runtime.mjs"), { code: 'ERR_MODULE_NOT_FOUND' }), '/r');
      cases.type = python_exception(new TypeError('x is not a function'));
      cases.plain = python_exception(new Error('boom'));
      cases.name = python_exception(Object.assign(new Error('x'), { name: 'KeyError' }));
      cases.os = python_exception(new PyOSError('ENOENT', '/nope'));
      cases.empty = python_exception(Object.assign(new Error(''), { name: 'KeyboardInterrupt' }));
      process.stdout.write(JSON.stringify(cases));`);
    assert.deepEqual(out.module, { type: 'ModuleNotFoundError', message: "No module named 'lcu.macos_host'" });
    assert.deepEqual(out.package, { type: 'ModuleNotFoundError', message: "No module named 'zzz'" });
    assert.deepEqual(out.type, { type: 'TypeError', message: 'x is not a function' });
    assert.deepEqual(out.plain, { type: 'Exception', message: 'boom' });
    assert.deepEqual(out.name, { type: 'KeyError', message: 'x' });
    assert.equal(out.os.type, 'FileNotFoundError');
    assert.equal(out.os.message, "[Errno 2] No such file or directory: '/nope'");
    assert.deepEqual(out.empty, { type: 'KeyboardInterrupt', message: '' });
  });

  it('the text matches the black-box `traceback` normaliser shape', () => {
    const out = trace(`
      const e = Object.assign(new Error(''), { name: 'KeyboardInterrupt' });
      process.stdout.write(JSON.stringify({ text: format_traceback(e, '/r'), other: format_traceback(new Error('boom\\nline2')) }));`);
    const shape = /^Traceback \(most recent call last\):\n(?:  File "[^"\n]*", line \d+, in [^\n]*\n)*KeyboardInterrupt\n$/;
    assert.match(out.text, shape);
    assert.match(out.other, /^Traceback \(most recent call last\):\n(?:  File [^\n]*\n)*Exception: boom\nline2\n$/);
  });
});
