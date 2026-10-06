// Port of tests/test_origins.py (LCU 0.9.6, #21): `lcu origins` lists and forgets saved Chrome site decisions,
// against a temporary CODEX_HOME. Plus differential checks against the Python oracle (tests/blackbox/BASE).
import assert from 'node:assert/strict';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';

import { io, PySystemExit } from '../../lcu/compat/argparse.mjs';
import { loads as tomlLoads } from '../../lcu/compat/toml.mjs';
import { _testing as lockTesting } from '../../lcu/compat/lock.mjs';
import * as origins from '../../lcu/origins.mjs';
import * as runtime from '../../lcu/runtime.mjs';
import { ORACLE_ROOT } from './oracle_root.mjs';
import { python312 } from './runtime_support.mjs';

const PYTHON = python312() ?? undefined;
const ORIGINS_URL = new URL('../../lcu/origins.mjs', import.meta.url).href;
const SAMPLE = '[origins]\nallowed = ["https://ok.example"]\ndenied = ["https://bad.example", "http://localhost:3000"]\n';

describe('OriginsTests', () => {
  let temporary; let home; let sessions; let env; let saved;

  beforeEach(() => {
    temporary = realpathSync(mkdtempSync(join(tmpdir(), 'lcu-origins-')));
    home = join(temporary, 'codex');
    sessions = join(home, 'browser', 'sessions');
    env = { CODEX_HOME: home };
    saved = { ...origins.hooks };
  });
  afterEach(() => {
    Object.assign(origins.hooks, saved);
    rmSync(temporary, { recursive: true, force: true });
  });

  const session = (name, text = SAMPLE) => {
    mkdirSync(sessions, { recursive: true });
    const path = join(sessions, `${name}.toml`);
    writeFileSync(path, text, 'utf8');
    return path;
  };
  const files = () => readdirSync(sessions).filter((name) => name !== origins.LOCK_NAME).sort();

  function run(argv, environment = null) {
    let out = ''; let err = '';
    const real = { stdout: io.stdout, stderr: io.stderr, exit: io.exit };
    io.stdout = (text) => { out += text; };
    io.stderr = (text) => { err += text; };
    io.exit = (status) => { throw new PySystemExit(status); };
    let code = 0;
    try {
      origins.main(argv, { env: environment ?? env });
    } catch (error) {
      if (!(error instanceof PySystemExit)) throw error;
      code = typeof error.status === 'number' ? error.status : 1;
    } finally {
      Object.assign(io, real);
    }
    return [code, out, err];
  }
  const state = (name) => origins.parse(readFileSync(join(sessions, `${name}.toml`)), name)[1];

  // list ----------------------------------------------------------------------------------

  it('list shows every session', () => {
    session('abc');
    session('agent-2', '[origins]\ndenied = ["https://x.example"]\n');
    const [code, out] = run(['list']);
    assert.equal(code, 0);
    assert.ok(out.includes('session abc'));
    assert.ok(out.includes('allowed https://ok.example'));
    assert.ok(out.includes('denied  http://localhost:3000'));
    assert.ok(out.includes('session agent-2'));
  });

  it('list defaults when no subcommand and supports json', () => {
    session('abc');
    const [code, out] = run(['--json']);
    const document = JSON.parse(out);
    assert.equal(code, 0);
    assert.equal(document.codexHome, home);
    assert.deepEqual(document.sessions, [{
      session: 'abc', file: join(sessions, 'abc.toml'), allowed: ['https://ok.example'],
      denied: ['https://bad.example', 'http://localhost:3000'] }]);
    assert.deepEqual(document.problems, []);
  });

  it('list one session', () => {
    session('abc');
    session('other', '[origins]\ndenied = ["https://x.example"]\n');
    const [code, out] = run(['list', '--session', 'other']);
    assert.equal(code, 0);
    assert.ok(out.includes('https://x.example'));
    assert.ok(!out.includes('ok.example'));
  });

  it('list with nothing saved', () => {
    for (const environment of [env, { CODEX_HOME: join(home, 'missing') }]) {
      const [code, out] = run(['list'], environment);
      assert.deepEqual([code, out.includes('No saved Chrome site decisions')], [0, true]);
    }
    mkdirSync(sessions, { recursive: true });
    session('empty', '[origins]\nallowed = []\ndenied = []\n');
    assert.ok(run(['list'])[1].includes('No saved'));
  });

  it('list skips unreadable session but reports it', () => {
    session('good');
    session('broken', 'not = [valid');
    let [code, out, err] = run(['list']);
    assert.equal(code, 1);
    assert.ok(out.includes('session good'));
    assert.ok(err.includes('broken.toml'));
    [code, out] = run(['list', '--json']);
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(out).problems.map((p) => p.session), ['broken']);
    [code, , err] = run(['list', '--session', 'broken']);
    assert.equal(code, 1);
    assert.ok(err.includes('not valid TOML'));
  });

  it('list does not call an unreadable store empty', () => {
    session('broken', 'not = [valid');
    const [code, out, err] = run(['list']);
    assert.equal(code, 1);
    assert.ok(!out.includes('No saved'));
    assert.ok(err.includes('broken.toml'));
  });

  it('list does not call an unfamiliar layout empty', () => {
    for (const text of ['[history]\nurls = ["https://x.example"]\n', 'version = 1\n', '[origins]\nblocked = ["https://x.example"]\n']) {
      session('odd', text);
      let [code, out, err] = run(['list']);
      assert.equal(code, 1, text);
      assert.ok(!out.includes('No saved'));
      assert.ok(err.includes('expected [origins] allowed/denied'));
      [code, , err] = run(['forget', 'https://x.example', '--session', 'odd']);
      assert.equal(code, 1, text);
      assert.equal(readFileSync(join(sessions, 'odd.toml'), 'utf8'), text);
    }
    for (const text of ['', '[origins]\n', '[origins]\ndenied = []\n', '[origins]\nallowed = ["https://a.example"]\n']) {
      session('odd', text);
      assert.equal(run(['list', '--session', 'odd'])[0], 0, text);
    }
  });

  it('list ignores files that are not session files', () => {
    session('abc');
    writeFileSync(join(sessions, 'notes.txt'), 'x');
    session('has space');
    session('.hidden');
    assert.deepEqual(JSON.parse(run(['list', '--json'])[1]).sessions.map((e) => e.session), ['abc']);
  });

  it('list rejects wrongly shaped origins', () => {
    for (const text of ['origins = 3\n', '[origins]\ndenied = "https://x.example"\n', '[origins]\ndenied = [1]\n']) {
      const path = session('odd', text);
      const [code, , err] = run(['list', '--session', 'odd']);
      assert.equal(code, 1, text);
      assert.ok(err.includes('leaving it untouched'));
      assert.equal(readFileSync(path, 'utf8'), text);
    }
  });

  // forget --------------------------------------------------------------------------------

  it('forget removes only the denied origin by default', () => {
    const path = session('abc');
    const [code, out] = run(['forget', 'http://localhost:3000']);
    assert.equal(code, 0);
    assert.ok(out.includes('Removed http://localhost:3000 from denied in session abc.'));
    assert.ok(out.includes('5 minutes'));
    assert.deepEqual(state('abc'), { allowed: ['https://ok.example'], denied: ['https://bad.example'] });
    assert.equal(readFileSync(path, 'utf8'), '[origins]\nallowed = ["https://ok.example"]\ndenied = ["https://bad.example"]\n');
  });

  it('forget never touches allowed unless asked', () => {
    session('abc');
    const [code, out] = run(['forget', 'https://ok.example']);
    assert.equal(code, 0);
    assert.ok(out.includes('nothing changed'));
    assert.ok(!out.includes('5 minutes'));
    assert.deepEqual(state('abc').allowed, ['https://ok.example']);
    run(['forget', 'https://ok.example', '--allowed']);
    assert.deepEqual(state('abc'), { allowed: [], denied: ['https://bad.example', 'http://localhost:3000'] });
  });

  it('forget both lists', () => {
    session('abc', '[origins]\nallowed = ["https://a.example"]\ndenied = ["https://a.example"]\n');
    run(['forget', 'https://a.example', '--allowed', '--denied']);
    assert.deepEqual(state('abc'), { allowed: [], denied: [] });
  });

  it('forget normalizes origin and stored entries', () => {
    session('abc', '[origins]\ndenied = ["HTTPS://Bad.Example:443", "https://bad.example"]\n');
    const [code, out] = run(['forget', 'https://BAD.example/']);
    assert.equal(code, 0);
    assert.ok(out.includes('Removed 2 entries for https://bad.example from denied'));
    assert.deepEqual(state('abc').denied, []);
  });

  it('forget defaults to every session and all-sessions flag matches', () => {
    for (const name of ['one', 'two']) session(name);
    session('three', '[origins]\ndenied = ["https://other.example"]\n');
    for (const flag of [[], ['--all-sessions']]) {
      for (const name of ['one', 'two']) session(name);
      const [code] = run(['forget', 'https://bad.example', ...flag]);
      assert.equal(code, 0);
      assert.deepEqual(state('one').denied, ['http://localhost:3000']);
      assert.deepEqual(state('two').denied, ['http://localhost:3000']);
      assert.deepEqual(state('three').denied, ['https://other.example']);
    }
  });

  it('forget one session leaves the others', () => {
    session('one');
    session('two');
    const [code] = run(['forget', 'https://bad.example', '--session', 'two']);
    assert.equal(code, 0);
    assert.deepEqual(state('one').denied, ['https://bad.example', 'http://localhost:3000']);
    assert.deepEqual(state('two').denied, ['http://localhost:3000']);
  });

  it('forget preserves other keys and tables', () => {
    const text = 'version = 2\nname = "agent"\n\n[origins]\nallowed = ["https://ok.example"]\n'
      + 'denied = ["https://bad.example"]\nnote = "kept"\nflag = true\n\n[other]\nitems = ["a", "b"]\n';
    const path = session('abc', text);
    run(['forget', 'https://bad.example']);
    const document = tomlLoads(readFileSync(path, 'utf8'));
    assert.deepEqual(document, new Map([['version', 2], ['name', 'agent'], ['origins', new Map([
      ['allowed', ['https://ok.example']], ['denied', []], ['note', 'kept'], ['flag', true]])],
    ['other', new Map([['items', ['a', 'b']]])]]));
  });

  it('forget keeps special characters and file mode', () => {
    const text = '[origins]\ndenied = ["https://bad.example"]\n"odd key" = "caf\\u00e9 \\"quoted\\" \\\\"\n';
    const path = session('abc', text);
    chmodSync(path, 0o640);
    const before = tomlLoads(text);
    run(['forget', 'https://bad.example']);
    before.get('origins').set('denied', []);
    assert.deepEqual(tomlLoads(readFileSync(path, 'utf8')), before);
    assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.deepEqual(files(), ['abc.toml']);
  });

  it('forget leaves unknown structures untouched', () => {
    const cases = {
      comment: '# written by hand\n[origins]\ndenied = ["https://bad.example"]\n',
      'inline comment': '[origins]\ndenied = ["https://bad.example"] # keep\n',
      'nested table': '[origins]\ndenied = ["https://bad.example"]\n[origins.extra]\nx = 1\n',
      float: 'ratio = 1.5\n[origins]\ndenied = ["https://bad.example"]\n',
      date: 'at = 2026-10-06\n[origins]\ndenied = ["https://bad.example"]\n',
      'array of tables': '[[history]]\nurl = "x"\n[origins]\ndenied = ["https://bad.example"]\n',
      'multi-line string': 'note = """a\nb"""\n[origins]\ndenied = ["https://bad.example"]\n',
    };
    for (const [name, text] of Object.entries(cases)) {
      const path = session('abc', text);
      const [code, out, err] = run(['forget', 'https://bad.example', '--session', 'abc']);
      assert.equal(code, 1, name);
      assert.ok(err.includes('leaving it untouched'), `${name}: ${err}`);
      assert.ok(!out.includes('5 minutes'));
      assert.equal(readFileSync(path, 'utf8'), text);
      assert.deepEqual(files(), ['abc.toml']);
    }
  });

  it('hash inside a string is not a comment', () => {
    const path = session('abc', '[origins]\ndenied = ["https://bad.example", "https://a.example/#x"]\n');
    assert.equal(run(['forget', 'https://bad.example'])[0], 0);
    assert.deepEqual(state('abc').denied, ['https://a.example/#x']);
    assert.ok(readFileSync(path, 'utf8').includes('#x'));
  });

  it('bad file does not block the others but fails the run', () => {
    session('good');
    const broken = session('broken', '# note\n[origins]\ndenied = ["https://bad.example"]\n');
    const [code, out, err] = run(['forget', 'https://bad.example']);
    assert.equal(code, 1);
    assert.ok(err.includes('broken.toml'));
    assert.deepEqual(state('good').denied, ['http://localhost:3000']);
    assert.ok(readFileSync(broken, 'utf8').startsWith('# note'));
    assert.ok(out.includes('5 minutes'));
  });

  it('forget refuses symbolic links', () => {
    const real = session('real');
    symlinkSync(real, join(sessions, 'linked.toml'));
    const [code, , err] = run(['forget', 'https://bad.example', '--session', 'linked']);
    assert.equal(code, 1);
    assert.ok(err.includes('symbolic link'));
    assert.equal(readFileSync(real, 'utf8'), SAMPLE);
  });

  it('forget retries when the runtime writes in between', () => {
    const path = session('abc');
    const runtimeWrite = '[origins]\nallowed = ["https://new.example"]\ndenied = ["https://bad.example", "https://late.example"]\n';
    const real = origins.hooks.write_atomically;
    const calls = [];
    origins.hooks.write_atomically = (target, text, mode) => {
      const temporaryPath = real(target, text, mode);
      if (!calls.length) {
        calls.push(1);
        writeFileSync(target, runtimeWrite);
      }
      return temporaryPath;
    };
    assert.equal(run(['forget', 'https://bad.example'])[0], 0);
    assert.deepEqual(state('abc'), { allowed: ['https://new.example'], denied: ['https://late.example'] });
    assert.deepEqual(files(), ['abc.toml']);
    assert.equal(readFileSync(path, 'utf8').split('late.example').length - 1, 1);
  });

  it('forget reports a runtime write that lands after the replace', () => {
    session('abc');
    const real = origins.hooks.replace;
    origins.hooks.replace = (source, target) => {
      real(source, target);
      writeFileSync(target, '[origins]\ndenied = ["https://late.example"]\n');
    };
    const [code, out, err] = run(['forget', 'https://bad.example', '--session', 'abc']);
    assert.equal(code, 1);
    assert.ok(err.includes('original runtime changed'));
    assert.ok(!out.includes('5 minutes'));
  });

  it('concurrent forgets are serialized (two worker threads, separate lock descriptors)', async () => {
    const path = session('abc', '[origins]\nallowed = ["https://a.example", "https://b.example"]\n');
    const shared = new Int32Array(new SharedArrayBuffer(12)); // [paused, release, secondDone]
    const code = `
      import { workerData, parentPort } from 'node:worker_threads';
      const origins = await import(${JSON.stringify(ORIGINS_URL)});
      const flags = new Int32Array(workerData.shared);
      if (workerData.first) {
        const real = origins.hooks.write_atomically;
        origins.hooks.write_atomically = (target, text, mode) => {
          const t = real(target, text, mode);
          Atomics.store(flags, 0, 1); Atomics.notify(flags, 0);
          Atomics.wait(flags, 1, 0, 10000);
          return t;
        };
      }
      try {
        origins.forget_in(workerData.path, workerData.origin, ['allowed']);
        if (!workerData.first) { Atomics.store(flags, 2, 1); Atomics.notify(flags, 2); }
        parentPort.postMessage('ok');
      } catch (error) { parentPort.postMessage(String(error.stack)); }`;
    const start = (first, origin) => new Promise((resolve, reject) => {
      const worker = new Worker(code, { eval: true, workerData: { shared: shared.buffer, first, path, origin } });
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    const one = start(true, 'https://a.example');
    const waitFor = async (index, ms) => {
      const until = Date.now() + ms;
      while (Atomics.load(shared, index) === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      return Atomics.load(shared, index) === 1;
    };
    assert.ok(await waitFor(0, 10000));
    const two = start(false, 'https://b.example');
    assert.equal(await waitFor(2, 300), false, 'the second command ran while the first held the lock');
    Atomics.store(shared, 1, 1);
    Atomics.notify(shared, 1);
    assert.deepEqual(await Promise.all([one, two]), ['ok', 'ok']);
    assert.deepEqual(state('abc').allowed, []);
  });

  it('lock gives up when it stays held', () => {
    session('abc');
    let caught = null;
    origins.locked(sessions, () => {
      try {
        origins.locked(sessions, () => {}, { wait: 0.2 });
      } catch (error) {
        caught = error;
      }
    });
    assert.ok(caught instanceof origins.OriginsError);
    assert.ok(caught.message.includes('another `lcu origins` command'));
    origins.locked(sessions, () => {}, { wait: 0.2 });
  });

  it('lock file is not a session', () => {
    session('abc');
    run(['forget', 'https://bad.example']);
    assert.ok(existsSync(join(sessions, origins.LOCK_NAME)));
    assert.deepEqual(JSON.parse(run(['list', '--json'])[1]).sessions.map((e) => e.session), ['abc']);
  });

  it('file system errors become messages and do not stop other sessions', () => {
    session('one');
    session('two');
    const real = origins.hooks.write_atomically;
    origins.hooks.write_atomically = (target, text, mode) => {
      if (target.endsWith('one.toml')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES', errno: -13 });
      return real(target, text, mode);
    };
    let [code, , err] = run(['forget', 'https://bad.example']);
    assert.equal(code, 1);
    assert.ok(err.includes('cannot update'));
    assert.ok(err.includes('Permission denied'));
    assert.ok(!err.includes('Traceback'));
    assert.deepEqual(state('two').denied, ['http://localhost:3000']);
    assert.deepEqual(state('one').denied, ['https://bad.example', 'http://localhost:3000']);
    [code, , err] = run(['forget', 'https://bad.example', '--session', 'one']);
    assert.equal(code, 1);
    assert.ok(err.includes('Permission denied'));
  });

  it('a session file that vanishes is reported', () => {
    const path = session('abc');
    const real = origins.hooks.read;
    origins.hooks.read = (target) => {
      const result = real(target);
      unlinkSync(target);
      return result;
    };
    const [code, , err] = run(['forget', 'https://bad.example', '--session', 'abc']);
    assert.equal(code, 1);
    assert.ok(err.includes('cannot update'), err);
    assert.equal(existsSync(path), false);
  });

  it('forget gives up when the file never settles', () => {
    const path = session('abc');
    const real = origins.hooks.write_atomically;
    const counter = [];
    origins.hooks.write_atomically = (target, text, mode) => {
      const temporaryPath = real(target, text, mode);
      counter.push(1);
      writeFileSync(target, `[origins]\ndenied = ["https://bad.example", "https://n${counter.length}.example"]\n`);
      return temporaryPath;
    };
    const [code, , err] = run(['forget', 'https://bad.example', '--session', 'abc']);
    assert.equal(code, 1);
    assert.ok(err.includes('kept changing'));
    assert.ok(readFileSync(path, 'utf8').includes('bad.example'));
    assert.deepEqual(files(), ['abc.toml']);
  });

  it('forget with nothing saved', () => {
    const [code, out] = run(['forget', 'https://bad.example']);
    assert.equal(code, 0);
    assert.ok(out.includes('nothing changed'));
    assert.equal(existsSync(home), false);
  });

  // validation ----------------------------------------------------------------------------

  it('bad session ids are rejected', () => {
    for (const name of ['../x', 'a/b', 'a\\b', '', 'x'.repeat(129), 'a b', 'é', 'abc\n']) {
      for (const argv of [['list', '--session', name], ['forget', 'https://a.example', '--session', name]]) {
        const [code, , err] = run(argv);
        assert.equal(code, 1, `${JSON.stringify(name)} ${argv[0]}`);
        assert.ok(err.includes('not a session id'), err);
      }
    }
    assert.equal(origins.check_session_id('x'.repeat(128)), 'x'.repeat(128));
    assert.equal(origins.check_session_id('A_b-9'), 'A_b-9');
  });

  it('missing named session is an error', () => {
    session('abc');
    const [code, , err] = run(['forget', 'https://bad.example', '--session', 'nope']);
    assert.equal(code, 1);
    assert.ok(err.includes('no saved site decisions for session nope'));
  });

  it('invalid origins are rejected before any change', () => {
    const path = session('abc');
    for (const value of ['example.com', 'localhost:3000', 'ftp://a.example', 'https://a.example/path',
      'https://a.example?x=1', 'https://a.example#x', 'https://user@a.example', 'https://',
      'https://a b.example', 'https://a.example:99999', '*', '', 'https://bücher.de',
      'https://faß.de', 'http://0x7f.1', 'http://127.1', 'http://2130706433', 'http://[::g]']) {
      const [code] = run(['forget', value]);
      assert.equal(code, 1, value);
      assert.equal(readFileSync(path, 'utf8'), SAMPLE);
    }
  });

  it('origin normalization', () => {
    const cases = {
      'https://Example.com': 'https://example.com', 'https://example.com:443/': 'https://example.com',
      'http://example.com:80': 'http://example.com', 'http://localhost:3000': 'http://localhost:3000',
      'https://example.com:8443': 'https://example.com:8443', 'http://[::1]:8080': 'http://[::1]:8080',
      'https://xn--bcher-kva.de': 'https://xn--bcher-kva.de', ' https://a.example ': 'https://a.example',
      'http://[2001:DB8:0:0::1]:81': 'http://[2001:db8::1]:81', 'https://127.0.0.1': 'https://127.0.0.1',
    };
    for (const [value, expected] of Object.entries(cases)) assert.equal(origins.normalize_origin(value), expected, value);
  });

  it('forget requires one scope', () => {
    const [code, , err] = run(['forget', 'https://a.example', '--session', 'a', '--all-sessions']);
    assert.equal(code, 2);
    assert.ok(err.includes('not allowed with'));
  });

  // CODEX_HOME ----------------------------------------------------------------------------

  it('codex home resolution', () => {
    assert.equal(origins.codex_home({ CODEX_HOME: home }, { windows: false }), home);
    assert.equal(runtime.default_codex_home({ USERPROFILE: 'C:\\Users\\a', HOME: '/x' }, true), 'C:\\Users\\a\\.codex');
    assert.equal(runtime.default_codex_home({ HOME: 'C:\\h' }, true), 'C:\\h\\.codex');
  });

  it('default codex home on posix', () => {
    assert.equal(origins.codex_home({ HOME: '/home/a' }, { windows: false }), '/home/a/.codex');
    assert.equal(origins.codex_home({ HOME: '//home/a' }, { windows: false }), '/home/a/.codex');
  });

  it('empty or relative CODEX_HOME is rejected', () => {
    for (const value of ['', 'relative/dir']) {
      const [code, , err] = run(['list'], { CODEX_HOME: value });
      assert.equal(code, 1);
      assert.ok(err.includes('CODEX_HOME'));
    }
  });

  it('default home is .codex in the home directory', () => {
    const chosen = [];
    origins.hooks.default_codex_home = (...args) => { chosen.push(args); return home; };
    const [code, out] = run(['list'], {});
    assert.equal(code, 0);
    assert.equal(chosen.length, 1);
    assert.ok(out.includes('No saved'));
  });

  // runtime dispatch ----------------------------------------------------------------------

  it('runtime dispatches origins', async () => {
    session('abc');
    let out = '';
    const real = io.stdout;
    const savedHome = process.env.CODEX_HOME;
    io.stdout = (text) => { out += text; };
    process.env.CODEX_HOME = home;
    try {
      await runtime.main(temporary, ['origins', 'forget', 'https://bad.example']);
      await runtime.main(temporary, ['origins']);
    } finally {
      io.stdout = real;
      if (savedHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedHome;
    }
    assert.ok(out.includes('Removed https://bad.example from denied in session abc.'));
    assert.ok(out.includes('denied  http://localhost:3000'));
    assert.ok(!out.split('Removed')[1].includes('bad.example"'));
  });

  it('runtime usage lists origins', async () => {
    assert.ok(runtime.USAGE.includes('lcu origins forget ORIGIN'));
    let out = '';
    const real = io.stdout;
    io.stdout = (text) => { out += text; };
    try { await runtime.main(temporary, ['--help']); } finally { io.stdout = real; }
    assert.ok(out.includes('lcu origins'));
  });

  // differential against the Python oracle --------------------------------------------------

  it('normalize_origin, session-file rewriting and argparse text equal the Python module', { skip: !PYTHON }, () => {
    const values = ['https://Example.com', 'https://example.com:443/', 'http://[::1]:8080', 'http://[2001:DB8:0:0::1]:81',
      'http://[::ffff:1.2.3.4]', 'http://[fe80::1%25eth0]', 'http://[1:0:0:2:0:0:0:3]', 'http://[0:0:1:0:0:1:0:0]',
      'http://[::1.2.3.4]', 'http://[1.2.3.4]', 'http://[v1.x]', 'http://[::g]', 'http://[1::2::3]', 'http://[]',
      'http://a.example:', 'http://a.example:0', 'http://a.example:+80', 'http://a.example:٣', 'https://ＥＸＡＭＰＬＥ.com',
      'https://a.example\t', 'ht\ttps://a.example', 'https://a.e\nxample', 'HTTP://A.EXAMPLE.', 'http://1.2.3.4.',
      'http://1.2.3.04', 'http://256.1.1.1', 'http://a.0x', 'http://a.12', 'http://a_b.example', 'https://a.example/?',
      'https://a.example/#', 'https://@a.example', 'https://a.example:80', 'http://localhost', 'https://[::1]:443',
      'https://faß.de', '\u0085https://a.example', 'https:a.example', '//a.example', 'https://a%2eexample'];
    const pathText = 'version = 2\n"odd key" = "caf\\u00e9 \\"q\\" \\\\ \\u007f"\nn = -3\nb = false\n[origins]\ndenied = ["https://bad.example"]\nallowed = []\n[x]\n"k.y" = ["a", "\\n"]\n';
    const script = `
import sys, json, io, contextlib
sys.path.insert(0, ${JSON.stringify(ORACLE_ROOT)})
from lcu import origins
out = {}
values = json.loads(sys.argv[1])
res = []
for v in values:
    try:
        res.append(origins.normalize_origin(v))
    except origins.OriginsError as e:
        res.append('ERR ' + str(e))
out['normalize'] = res
raw = sys.argv[2].encode()
document, _ = origins.parse(raw, 'p')
document['origins']['denied'] = []
out['render'] = origins.rewritable_text(raw, document, 'p')
helps = []
for argv in (['--help'], ['list', '--help'], ['forget', '--help'], ['forget'], ['bogus'], ['forget', 'x', '--session', 'a', '--all-sessions']):
    o, e = io.StringIO(), io.StringIO()
    code = 0
    with contextlib.redirect_stdout(o), contextlib.redirect_stderr(e):
        try:
            origins.main(argv, env={'CODEX_HOME': '/nonexistent'})
        except SystemExit as exc:
            code = exc.code
    helps.append([code, o.getvalue(), e.getvalue()])
out['help'] = helps
print(json.dumps(out))`;
    const python = spawnSync(PYTHON, ['-c', script, JSON.stringify(values), pathText], { encoding: 'utf8', env: { ...process.env, COLUMNS: '80' } });
    assert.equal(python.status, 0, python.stderr);
    const expected = JSON.parse(python.stdout);
    const got = values.map((v) => {
      try { return origins.normalize_origin(v); } catch (e) { if (!(e instanceof origins.OriginsError)) throw e; return `ERR ${e.message}`; }
    });
    assert.deepEqual(got, expected.normalize);
    const raw = Buffer.from(pathText);
    const [document] = origins.parse(raw, 'p');
    document.get('origins').set('denied', []);
    assert.equal(origins.rewritable_text(raw, document, 'p'), expected.render);
    const helps = [['--help'], ['list', '--help'], ['forget', '--help'], ['forget'], ['bogus'], ['forget', 'x', '--session', 'a', '--all-sessions']]
      .map((argv) => {
        process.env.COLUMNS = '80';
        return run(argv, { CODEX_HOME: '/nonexistent' });
      });
    assert.deepEqual(helps, expected.help);
  });
});

// ---- review upstream-096 R1: Windows contention follows origins.locked (LK_NBLCK every 50 ms until the deadline) ----
describe('origins lock on Windows (lock.mjs holder seam; fixture only)', () => {
  let dir; let fake;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'lcu-origins-win-')));
    fake = join(dir, 'holder.mjs');
    // Stand-in for the PowerShell holder: records the script it was given, then answers per LCU_FAKE_HOLDER.
    writeFileSync(fake, `
import { writeFileSync, writeSync } from 'node:fs';
writeFileSync(process.env.LCU_FAKE_SCRIPT, process.env.LCU_FAKE_SOURCE);
const say = (line) => writeSync(1, line + '\\n');
const mode = process.env.LCU_FAKE_HOLDER;
if (mode === 'busy') setTimeout(() => { say('TIMEOUT'); process.exit(5); }, 150);
else setTimeout(() => {
  say('LOCKED');
  process.stdin.resume();
  process.stdin.on('end', () => { say('RELEASED'); process.exit(0); });
}, mode === 'later' ? 120 : 0);
`);
  });
  afterEach(() => {
    lockTesting.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  const select = (mode) => lockTesting.set({
    platform: 'win32',
    spawn: (command, args, options) => nodeSpawn(process.execPath, [fake], {
      ...options,
      env: { LCU_FAKE_HOLDER: mode, LCU_FAKE_SCRIPT: join(dir, 'script.ps1'),
        LCU_FAKE_SOURCE: Buffer.from(args.at(-1), 'base64').toString('utf16le') },
    }),
  });

  it('contention ends with the upstream message after the caller\'s wait, polling every 50 ms', () => {
    select('busy');
    assert.throws(() => origins.locked(dir, () => assert.fail('ran without the lock'), { wait: 0.2 }),
      (e) => e instanceof origins.OriginsError
        && e.message === 'another `lcu origins` command is changing these files; try again in a moment.');
    const script = readFileSync(join(dir, 'script.ps1'), 'utf8');
    assert.ok(script.includes('if ($watch.ElapsedMilliseconds -ge 200) { break }'), script);
    assert.ok(script.includes('[Threading.Thread]::Sleep(50)'), script);
    assert.ok(script.includes('"TIMEOUT"') && !script.includes('"DEADLOCK"'), script);
  });

  it('a lock that frees up within the wait is taken', () => {
    select('later');
    let ran = false;
    origins.locked(dir, () => { ran = true; }, { wait: 10 });
    assert.equal(ran, true);
    assert.ok(readFileSync(join(dir, 'script.ps1'), 'utf8').includes('-ge 10000'));
  });

  it('other callers keep msvcrt.LK_LOCK\'s ten one-second attempts', async () => {
    select('now');
    const { acquireSync } = await import('../../lcu/compat/lock.mjs');
    acquireSync(join(dir, 'other.lock')).release();
    const script = readFileSync(join(dir, 'script.ps1'), 'utf8');
    assert.ok(script.includes('for ($i = 0; $i -lt 10; $i++)') && script.includes('Sleep(1000)') && script.includes('"DEADLOCK"'), script);
  });
});

// ---- review upstream-096 R2: inaccessible sessions are errors (pathlib predicates raise PermissionError) ----
describe('inaccessible session folders (unprivileged; compared with the Python oracle)', { skip: process.getuid?.() === 0 && 'root bypasses permissions' }, () => {
  let base;
  beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'lcu-origins-perm-'))); });
  afterEach(() => {
    for (const dir of [join(base, 'codex/browser'), join(base, 'codex/browser/sessions')]) {
      try { chmodSync(dir, 0o755); } catch { /* gone */ }
    }
    rmSync(base, { recursive: true, force: true });
  });

  function python(home, argv) {
    const script = `
import sys, json, io, contextlib
sys.path.insert(0, ${JSON.stringify(ORACLE_ROOT)})
from lcu import origins
o, e = io.StringIO(), io.StringIO()
code = 0
with contextlib.redirect_stdout(o), contextlib.redirect_stderr(e):
    try:
        origins.main(json.loads(sys.argv[2]), env={'CODEX_HOME': sys.argv[1]})
    except SystemExit as exc:
        code = exc.code
print(json.dumps([code, o.getvalue(), e.getvalue()]))`;
    const done = spawnSync(PYTHON, ['-c', script, home, JSON.stringify(argv)], { encoding: 'utf8' });
    assert.equal(done.status, 0, done.stderr);
    return JSON.parse(done.stdout);
  }
  function node(home, argv) {
    let out = ''; let err = '';
    const real = { stdout: io.stdout, stderr: io.stderr };
    io.stdout = (t) => { out += t; };
    io.stderr = (t) => { err += t; };
    let code = 0;
    try { origins.main(argv, { env: { CODEX_HOME: home } }); } catch (error) {
      if (!(error instanceof PySystemExit)) throw error;
      code = error.status;
    } finally { Object.assign(io, real); }
    return [code, out, err];
  }
  const fixture = () => {
    const home = join(base, 'codex');
    mkdirSync(join(home, 'browser/sessions'), { recursive: true });
    writeFileSync(join(home, 'browser/sessions/abc.toml'), SAMPLE);
    return home;
  };

  it('an inaccessible ancestor is a permission error, not "nothing saved" (list, named session, forget)', () => {
    const home = fixture();
    chmodSync(join(home, 'browser'), 0o000);
    const sessionsDir = join(home, 'browser/sessions');
    const [code, out, err] = node(home, ['list']);
    assert.deepEqual([code, out, err], [1, '', `lcu origins: [Errno 13] Permission denied: '${sessionsDir}'\n`]);
    for (const argv of [['list'], ['list', '--session', 'abc'], ['forget', 'https://bad.example'],
      ['forget', 'https://bad.example', '--session', 'abc']]) {
      const got = node(home, argv);
      assert.equal(got[0], 1, argv.join(' '));
      if (PYTHON) assert.deepEqual(got, python(home, argv), argv.join(' '));
    }
  });

  it('a sessions folder that cannot be listed is skipped like Path.glob does', () => {
    const home = fixture();
    chmodSync(join(home, 'browser/sessions'), 0o000);
    for (const argv of [['list'], ['list', '--json'], ['forget', 'https://bad.example']]) {
      const got = node(home, argv);
      if (PYTHON) assert.deepEqual(got, python(home, argv), argv.join(' '));
    }
    assert.equal(node(home, ['list'])[0], 0);
  });
});
