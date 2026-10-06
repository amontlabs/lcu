// Port of the setup-targeting Python unit tests:
//   tests/test_setup_failures.py (all), tests/test_setup_pending.py (all but StatusTests, which targets status),
//   tests/test_instructions.py (all), tests/test_windows_setup.py (setup cases), tests/test_approval.py (setup
//   cases), tests/test_harness_setup.py (detect/validate), tests/test_doctor.py (SetupReadinessTests),
//   tests/test_installation.py (apply_changes concurrent edit), tests/test_tested_versions.py (setup case, with
//   the tested.report seam), plus extra cases for behaviour the Python suite never asserted and Python
//   differential checks (help/usage/validate texts, embedded JS sources, export bytes).
// Python `patch('lcu.setup.X')` becomes `setup.impl.X`; redirect_stdout/stderr become setup.io + argparse io.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';

import { io as argparseIo, PySystemExit, types } from '../../lcu/compat/argparse.mjs';
import * as setup from '../../lcu/setup.mjs';
import * as platforms from '../../lcu/platforms.mjs';
import * as tested from '../../lcu/tested.mjs';
import { ALIASES, CLIENTS } from '../../lcu/setup_clients.mjs';
import { ORACLE_ROOT } from './oracle_root.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const PYTHON_SOURCE = path.join(ORACLE_ROOT, 'lcu/setup.py');
// The differential oracle is CPython 3.12.10 exactly (argparse diagnostics changed within 3.12.x: 3.12.3 quotes
// choice labels). Any other interpreter skips with that reason instead of producing false differences.
const ORACLE = '3.12.10';
const pythonVersion = spawnSync('python3', ['-c', 'import platform; print(platform.python_version())'], { encoding: 'utf8' }).stdout?.trim();
const havePython = fs.existsSync(PYTHON_SOURCE) && pythonVersion === ORACLE;
const pythonSkip = `differential oracle is CPython ${ORACLE}; python3 is ${pythonVersion || 'missing'}`;
const ALL = ['pi', 'codex', 'claude-code', 'omp', 'hermes'];
const UID = process.getuid();
const IS_ROOT = UID === 0;
const USERNAME = os.userInfo().username;

const SAVED_IMPL = { ...setup.impl, approvals: { ...setup.impl.approvals } };
const SAVED_IO = { ...setup.io };
const SAVED_ARGPARSE_IO = { ...argparseIo };
const SAVED_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(setup.impl)) if (!(key in SAVED_IMPL)) delete setup.impl[key];
  Object.assign(setup.impl, SAVED_IMPL, { approvals: { ...SAVED_IMPL.approvals } });
  Object.assign(setup.io, SAVED_IO);
  Object.assign(argparseIo, SAVED_ARGPARSE_IO);
  for (const key of Object.keys(process.env)) if (!(key in SAVED_ENV)) delete process.env[key];
  Object.assign(process.env, SAVED_ENV);
});

const temps = [];
after(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });
function tempdir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-setup-test-')));
  temps.push(dir);
  return dir;
}
function put(file, content, mode = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== null) fs.chmodSync(file, mode);
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const ok = (stdout = '', stderr = '') => ({ returncode: 0, stdout, stderr });
const keyError = (key) => Object.assign(new Error(`'${key}'`), { name: 'KeyError' });
const plain = (value) => JSON.parse(JSON.stringify(value, (k, v) => (v instanceof Map ? Object.fromEntries(v) : v)));

/** Run fn with stdout/stderr captured and SystemExit turned into a code (Python's redirect_* + SystemExit). */
async function capture(fn) {
  let out = '';
  let err = '';
  setup.io.stdout = (t) => { out += t; };
  setup.io.stderr = (t) => { err += t; };
  argparseIo.stdout = (t) => { out += t; };
  argparseIo.stderr = (t) => { err += t; };
  argparseIo.exit = () => {};
  let code = 0;
  let value;
  try {
    value = await fn();
  } catch (error) {
    if (!(error instanceof PySystemExit)) throw error;
    code = error.status || 0;
  } finally {
    Object.assign(setup.io, SAVED_IO);
    Object.assign(argparseIo, SAVED_ARGPARSE_IO);
  }
  return { code, out, err, value };
}

/** setup_host.make_runtime */
function makeRuntime(prefix) {
  for (const name of ['current/bin/lcu', 'current/bin/lcu-session', 'lcu.cmd', 'windows_launcher.py']) {
    put(path.join(prefix, name), 'fixture', 0o755);
  }
}
const account = (home) => ({ pw_name: 'fixture', pw_uid: UID, pw_gid: process.getgid(), pw_dir: home });
const nullLock = () => ({ release() {} });

// ------------------------------------------------------------------------------------------- test_setup_failures
describe('ConfigureFailureTests', () => {
  async function runConfigure(names, cleanup, run) {
    const root = tempdir();
    const home = path.join(root, 'home');
    const tools = path.join(root, 'tools');
    const release = path.join(root, 'release');
    for (const d of [home, tools, path.join(release, 'adapters')]) fs.mkdirSync(d, { recursive: true });
    for (const f of ['claude.mjs', 'codex.mjs', 'audio-files.mjs']) put(path.join(release, 'adapters', f), 'x');
    let calls = 0;
    Object.assign(setup.impl, {
      installer_paths: () => [path.join(tools, 'node'), path.join(tools, 's.mjs'), path.join(tools, 'm.mjs')],
      installed_app_resources: () => path.join(root, 'resources'),
      host_policy: () => new Map(),
      preflight_mcp: () => {},
      run: (argv, options) => { calls += 1; return run(argv, options); },
      remove_old_skill: cleanup,
      require_cli_hook_support: () => {},
      install_hooks: () => {},
      claude_visibility_install: () => {},
      claude_mod_install: () => path.join(root, 'mod'),
      locate_codex_tools: () => ({ cli: path.join(root, 'codex') }),
    });
    const { value, err } = await capture(() => setup.configure(names, home, ['/opt/lcu/bin/lcu'], tools, release,
      { environ: { HOME: home } }));
    return [value, err, calls];
  }
  const okRun = () => ok(JSON.stringify({ path: '/x/config.toml' }));

  for (const [label, error] of [['value error', new setup.ValueError('boom')], ['unexpected error', new TypeError('weird')]]) {
    test(`cleanup ${label} only warns`, async () => {
      const [failures, err, calls] = await runConfigure(['claude-code'], () => { throw error; }, okRun);
      assert.deepEqual(failures, []);
      assert.match(err, /Claude Code: skipped old LCU skill cleanup/);
      assert.equal(calls, 1);
    });
  }

  test('unexpected phase error is recorded and next harness runs', async () => {
    let count = 0;
    const [failures, err, calls] = await runConfigure(['claude-code', 'codex'], () => 'none', () => {
      count += 1;
      if (count === 1) throw keyError('nope');
      return okRun();
    });
    assert.deepEqual(failures, [['claude-code', 'MCP', "KeyError: 'nope'"]]);
    assert.equal(calls, 2);
    assert.match(err, /MCP failed: KeyError: 'nope'/);
  });

  test('codex non-dict output is a failure, not a crash', async () => {
    for (const stdout of ['[]', '{}', 'null']) {
      const [failures] = await runConfigure(['codex'], () => 'none', () => ok(stdout));
      assert.deepEqual(failures.map((f) => f.slice(0, 2)), [['codex', 'MCP']]);
      assert.match(failures[0][2], /unexpected output/);
    }
  });

  test('KeyboardInterrupt is not swallowed', async () => {
    await assert.rejects(runConfigure(['claude-code'], () => 'none', () => { throw new setup.KeyboardInterrupt(); }),
      setup.KeyboardInterrupt);
  });
});

// ------------------------------------------------------------------------------------------- test_setup_pending
class Fixture {
  constructor() {
    this.root = tempdir();
    this.prefix = path.join(this.root, 'prefix');
    this.home = path.join(this.root, 'home');
    fs.mkdirSync(this.home);
    makeRuntime(this.prefix);
    this.installed = new Set();
    this.registered = [];
    this.failing = new Set();
    this.account = account(this.home);
  }

  configure(names, home, command, toolsRoot, releaseRoot, options = {}) {
    this.registered.push({ names: [...names], command, ...options });
    const failures = [];
    for (const name of names) {
      if (this.failing.has(name)) failures.push([name, 'plugin', 'boom']);
      else setup.io.stdout(`${name} registered\n`);
    }
    return failures;
  }

  which(executable) {
    const executables = new Set([...this.installed].map((n) => CLIENTS[n].executable));
    return executables.has(executable) ? `/fixture/${executable}` : null;
  }

  async runMain(argv = [], { agents = ALL, reconcile = false } = {}) {
    Object.assign(setup.impl, {
      platform: this.platform ?? 'linux', // test_setup_pending.py (0.9.6): getattr(self, 'platform', ...)
      installer_environment: () => {},
      installer_paths: () => {},
      configure: (...a) => this.configure(...a),
      which: (e, p) => this.which(e, p),
      run: () => ok(),
    });
    if (!reconcile) setup.impl.validate = () => [this.account, [...agents]];
    else Object.assign(setup.impl, { getpwuid: () => this.account, getpwnam: () => this.account });
    const full = reconcile
      ? ['--prefix', this.prefix, '--reconcile', ...(IS_ROOT ? ['--user', 'fixture'] : []), ...argv]
      : ['--prefix', this.prefix, '--session', 'direct', '--yes', '--no-chrome', ...argv];
    const result = await capture(() => setup.main(full));
    Object.assign(setup.impl, SAVED_IMPL);
    return [result.code, result.out, result.err];
  }

  state() {
    const state = setup.load_setup_state(this.home);
    return { ...state, pending_context: state.pending_context === null ? null : plain(state.pending_context) };
  }

  writeState(document) {
    put(setup.setup_state_path(this.home), JSON.stringify(document));
  }
}

describe('StateSchemaTests', () => {
  test('old file without new fields loads with nothing pending', async () => {
    const f = new Fixture();
    f.writeState({ chrome: true, audio: false });
    assert.deepEqual(f.state(), { chrome: true, audio: false, approval: 'ask', pending: [], pending_context: null });
  });

  test('round trip, and an unpending state omits the new fields', async () => {
    const f = new Fixture();
    const context = { scope: 'user', project: null, session: 'direct' };
    setup.save_setup_state(f.home, { chrome: false, audio: true, approval: 'auto', pending: ['pi', 'pi', 'omp'], pending_context: context });
    assert.deepEqual(f.state().pending, ['pi', 'omp']);
    assert.deepEqual(f.state().pending_context, context);
    setup.save_setup_state(f.home, { chrome: false, audio: true });
    assert.deepEqual(readJson(setup.setup_state_path(f.home)), { chrome: false, audio: true, approval: 'ask' });
  });

  test('malformed pending is rejected', async () => {
    const f = new Fixture();
    for (const pending of ['pi', ['codex'], [1], ['nope']]) {
      f.writeState({ chrome: false, audio: false, pending });
      assert.throws(() => f.state(), (e) => setup.isValueError(e) && /Malformed/.test(e.message));
    }
    f.writeState({ chrome: false, audio: false, pending: ['pi'], pending_context: { scope: 'x' } });
    assert.throws(() => f.state(), /Malformed/);
  });

  test('saved bytes match Python json.dumps(indent=2)', async () => {
    const f = new Fixture();
    setup.save_setup_state(f.home, { chrome: false, audio: true, approval: 'auto', pending: ['pi'],
      pending_context: new Map([['scope', 'user'], ['session', 'direct'], ['project', null]]) });
    assert.equal(fs.readFileSync(setup.setup_state_path(f.home), 'utf8'),
      '{\n  "chrome": false,\n  "audio": true,\n  "approval": "auto",\n  "pending": [\n    "pi"\n  ],\n'
      + '  "pending_context": {\n    "scope": "user",\n    "session": "direct",\n    "project": null\n  }\n}\n');
    assert.equal(fs.statSync(setup.setup_state_path(f.home)).mode & 0o777, 0o600);
  });
});

describe('FailedRegistrationTests', () => {
  test('failure still saves choices', async () => {
    const f = new Fixture();
    f.installed = new Set(['pi']);
    f.failing = new Set(['pi', 'codex']);
    const [code, , err] = await f.runMain(['--allow-missing', '--approval', 'auto', '--audio']);
    assert.equal(code, 1);
    assert.ok(err.includes('2 registration step(s) failed (pi: plugin, codex: plugin). Choices were saved;'), err);
    const state = f.state();
    assert.deepEqual([state.audio, state.approval], [true, 'auto']);
    // Failed harnesses are retried with the printed command, not by reconcile.
    assert.deepEqual(state.pending, ['omp', 'hermes']);
    assert.deepEqual(state.pending_context, { scope: 'user', project: null, session: 'direct' });
    assert.ok(err.includes('--approval auto'));
    assert.ok(err.includes('--audio'));
  });

  test('a pending harness that fails stays pending', async () => {
    const f = new Fixture();
    await f.runMain(['--allow-missing']);
    f.installed = new Set(['omp']);
    f.failing = new Set(['omp']);
    const [code] = await f.runMain([], { agents: ['omp'] });
    assert.equal(code, 1);
    assert.deepEqual(f.state().pending, ['pi', 'omp', 'hermes']);
  });

  test('retry omits a defaulted approval and repeats an explicit one', async () => {
    const f = new Fixture();
    f.failing = new Set(['codex']);
    let [, , err] = await f.runMain(['--agent', 'codex']);
    assert.ok(err.includes('retry:'));
    assert.ok(!err.includes('--approval'));
    assert.deepEqual(f.state().pending, []);
    [, , err] = await f.runMain(['--approval', 'ask']);
    assert.ok(err.includes('--approval ask'));
  });

  test('retry command text is shlex.join of the exact argv', async () => {
    const f = new Fixture();
    f.failing = new Set(['codex']);
    const [, , err] = await f.runMain(['--agent', 'codex', '--audio'], { agents: ['codex'] });
    const runtime = path.join(f.prefix, 'current/bin/lcu');
    assert.equal(err, `Setup failed: 1 registration step(s) failed (codex: plugin). Choices were saved; completed steps remain installed. After resolving the errors, retry: ${runtime} setup --prefix ${f.prefix} --user fixture --scope user --session direct --yes --no-chrome --audio --agent codex\n`);
  });
});

describe('AllowMissingTests', () => {
  test('missing harnesses are skipped and recorded and exit is zero', async () => {
    const f = new Fixture();
    f.installed = new Set(['pi']);
    const [code, out, err] = await f.runMain(['--allow-missing', '--approval', 'auto']);
    assert.equal(code, 0, err);
    assert.deepEqual(f.registered[0].names, ['pi', 'codex', 'claude-code']);
    assert.equal(f.registered[0].approval, 'auto');
    assert.ok(out.includes('Oh My Pi: not installed; will register when it appears'));
    assert.ok(out.includes('Hermes: not installed; will register when it appears'));
    assert.ok(out.includes('Registered now: pi, codex, claude-code.'));
    assert.ok(out.includes('Pending (not installed): omp, hermes.'));
    const state = f.state();
    assert.deepEqual([state.approval, state.pending], ['auto', ['omp', 'hermes']]);
    assert.deepEqual(state.pending_context, { scope: 'user', project: null, session: 'direct' });
  });

  test('everything missing still registers codex and claude', async () => {
    const f = new Fixture();
    const [code] = await f.runMain(['--allow-missing']);
    assert.equal(code, 0);
    assert.deepEqual(f.registered[0].names, ['codex', 'claude-code']);
    assert.deepEqual(f.state().pending, ['pi', 'omp', 'hermes']);
  });

  test('real failure is nonzero and retry keeps the flag', async () => {
    const f = new Fixture();
    f.installed = new Set(['pi', 'omp']);
    f.failing = new Set(['omp']);
    const [code, , err] = await f.runMain(['--allow-missing']);
    assert.equal(code, 1);
    assert.ok(err.includes('--allow-missing'));
    assert.ok(err.includes('--agent omp'));
  });

  test('without the flag a missing harness is still attempted', async () => {
    const f = new Fixture();
    await f.runMain();
    assert.deepEqual(f.registered[0].names, ALL);
    assert.deepEqual(f.state().pending, []);
  });

  test('explicit registration clears a pending entry and keeps others', async () => {
    const f = new Fixture();
    await f.runMain(['--allow-missing']);
    f.installed = new Set(['omp']);
    await f.runMain(['--allow-missing'], { agents: ['omp'] });
    assert.deepEqual(f.state().pending, ['pi', 'hermes']);
  });

  test('later approval updates the saved mode and keeps pending', async () => {
    const f = new Fixture();
    await f.runMain(['--allow-missing']);
    await f.runMain(['--approval', 'auto'], { agents: ['codex'] });
    const state = f.state();
    assert.deepEqual([state.approval, state.pending], ['auto', ['pi', 'omp', 'hermes']]);
  });

  test('export and allow-missing conflict', async () => {
    const args = setup.parser().parse_args(['--export', '/tmp/x', '--allow-missing']);
    assert.throws(() => setup.validate(args), /cannot be combined with --export/);
  });
});

describe('ReconcileTests', () => {
  const pend = (f, names = ['pi', 'omp', 'hermes'], saved = {}) => f.writeState({
    chrome: saved.chrome ?? false, audio: saved.audio ?? true, approval: saved.approval ?? 'auto', pending: [...names],
    pending_context: { scope: 'user', project: null, session: 'direct' },
  });

  test('no pending is a silent no-op without lock or subprocess', async () => {
    const f = new Fixture();
    setup.impl.setup_lock = () => { throw new Error('locked'); };
    const result = await f.runMain([], { reconcile: true });
    assert.deepEqual([...result, f.registered], [0, '', '', []]);
    assert.equal(fs.existsSync(setup.setup_state_path(f.home)), false);
  });

  test('pending without binary is a silent no-op', async () => {
    const f = new Fixture();
    pend(f);
    const before = fs.readFileSync(setup.setup_state_path(f.home));
    const result = await f.runMain([], { reconcile: true });
    assert.deepEqual([...result, f.registered], [0, '', '', []]);
    assert.deepEqual(fs.readFileSync(setup.setup_state_path(f.home)), before);
  });

  test('installed pending harness is registered with saved settings and removed', async () => {
    const f = new Fixture();
    pend(f, undefined, { approval: 'auto', audio: true });
    f.installed = new Set(['omp', 'codex']);
    const [code, out, err] = await f.runMain([], { reconcile: true });
    assert.equal(code, 0, err);
    assert.equal(f.registered.length, 1);
    const call = f.registered[0];
    assert.deepEqual(call.names, ['omp']);
    assert.deepEqual(call.command, [path.join(f.prefix, 'current/bin/lcu'), '--audio']);
    assert.deepEqual([call.approval, call.scope], ['auto', 'user']);
    assert.ok(out.includes('Registered: omp'));
    assert.equal(out, 'LCU: registering Oh My Pi (installed since setup) with the saved settings.\nomp registered\n'
      + 'Registered: omp. Restart or reconnect those harnesses.\n');
    const state = f.state();
    assert.deepEqual(state.pending, ['pi', 'hermes']);
    assert.deepEqual([state.approval, state.audio], ['auto', true]);
    // Idempotent: the next run has nothing to do.
    f.registered.length = 0;
    assert.deepEqual(await f.runMain([], { reconcile: true }), [0, '', '']);
    assert.deepEqual(f.registered, []);
  });

  test('saved ask leaves approval alone', async () => {
    const f = new Fixture();
    pend(f, undefined, { approval: 'ask' });
    f.installed = new Set(['pi']);
    await f.runMain([], { reconcile: true });
    assert.equal(f.registered[0].approval, null);
  });

  test('saved project scope and session are used', async () => {
    const f = new Fixture();
    const project = path.join(f.root, 'project');
    fs.mkdirSync(project);
    f.writeState({ chrome: false, audio: false, approval: 'ask', pending: ['pi'],
      pending_context: { scope: 'project', project, session: 'discover' } });
    f.installed = new Set(['pi']);
    const [code, , err] = await f.runMain([], { reconcile: true });
    assert.equal(code, 0, err);
    const call = f.registered[0];
    assert.deepEqual([call.scope, call.project], ['project', project]);
    assert.equal(call.command[0], path.join(f.prefix, 'current/bin/lcu-session'));
  });

  test('partial failure keeps only the failed harness pending and exits nonzero', async () => {
    const f = new Fixture();
    pend(f);
    f.installed = new Set(['pi', 'omp']);
    f.failing = new Set(['omp']);
    const [code, , err] = await f.runMain([], { reconcile: true });
    assert.equal(code, 1);
    assert.ok(err.includes('still pending: omp, hermes'));
    assert.equal(err, 'Reconcile failed: 1 registration step(s) failed; still pending: omp, hermes. Fix the errors above; the next reconcile retries.\n');
    assert.deepEqual(f.state().pending, ['omp', 'hermes']);
  });

  test('never touches harnesses that are not pending', async () => {
    const f = new Fixture();
    pend(f, ['hermes']);
    f.installed = new Set(ALL);
    await f.runMain([], { reconcile: true });
    assert.deepEqual(f.registered[0].names, ['hermes']);
  });

  test('binary in a user directory outside PATH is found', async () => {
    const f = new Fixture();
    pend(f, ['pi']);
    put(path.join(f.home, '.bun/bin/pi'), '#!/bin/sh\n', 0o755);
    assert.equal(setup.harness_installed('pi', f.home, '/nonexistent'), true);
    assert.equal(setup.harness_installed('omp', f.home, '/nonexistent'), false);
  });

  test('options that would override the saved setup are rejected', async () => {
    for (const flag of [['--approval', 'auto'], ['--agent', 'pi'], ['--chrome'], ['--allow-missing'], ['--scope', 'project']]) {
      const argv = ['--reconcile', ...flag, ...(IS_ROOT ? ['--user', 'root'] : [])];
      assert.throws(() => setup.validate(setup.parser().parse_args(argv)), /cannot be combined/);
    }
  });

  test('a held lock blocks reconcile and the waiter then finds nothing to do', async () => {
    const f = new Fixture();
    pend(f, ['pi']);
    // Hold the lock from a separate process, as a concurrent setup would (the holder exits when its stdin closes;
    // nothing is ever signalled).
    const setupUrl = new URL('../../lcu/setup.mjs', import.meta.url).href;
    const holder = spawn(process.execPath, ['--input-type=module', '-e',
      `const s = await import(${JSON.stringify(setupUrl)});
       const lock = await s.setup_lock(${JSON.stringify(f.home)});
       process.stdout.write('held\\n');
       process.stdin.resume();
       process.stdin.on('end', () => { lock.release(); });`], { stdio: ['pipe', 'pipe', 'inherit'] });
    // A holder that dies before reporting (no flock/lockf helper, an import error) or never reports must fail the test
    // instead of waiting forever: that wait was the one unbounded wait of the whole suite.
    let holderTimer;
    const holderClosed = new Promise((resolve) => holder.once('close', resolve));
    try {
      await Promise.race([
        new Promise((resolve) => holder.stdout.once('data', resolve)),
        holderClosed.then((code) => { throw new Error(`lock holder exited before holding the lock (status ${code})`); }),
        new Promise((_, reject) => { holderTimer = setTimeout(() => reject(new Error('lock holder did not report within 30 s')), 30000); }),
      ]);
    } catch (error) {
      holder.stdin.destroy();
      holder.kill('SIGKILL'); // our own child only
      throw error;
    } finally {
      clearTimeout(holderTimer);
    }
    // The waiter is a second process running reconcile with the Fixture's fakes (pi installed).
    const waiter = spawn(process.execPath, ['--input-type=module', '-e',
      `const s = await import(${JSON.stringify(setupUrl)});
       const registered = [];
       Object.assign(s.impl, { platform: 'linux', installer_environment: () => {}, installer_paths: () => {},
         run: () => ({ returncode: 0, stdout: '', stderr: '' }), which: (e) => (e === 'pi' ? '/fixture/pi' : null),
         getpwuid: () => (${JSON.stringify(f.account)}), getpwnam: () => (${JSON.stringify(f.account)}),
         configure: (names) => { registered.push(names); return []; } });
       await s.main(['--prefix', ${JSON.stringify(f.prefix)}, '--reconcile', ${IS_ROOT ? "'--user', 'fixture'" : ''}]);
       process.stdout.write('done ' + JSON.stringify(registered) + '\\n');`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let waiterOut = '';
    waiter.stdout.on('data', (chunk) => { waiterOut += chunk; });
    const finished = new Promise((resolve) => waiter.once('close', resolve));
    try {
      const early = await Promise.race([finished.then(() => 'finished'), new Promise((r) => setTimeout(() => r('waiting'), 700))]);
      assert.equal(early, 'waiting', 'reconcile must wait for the setup lock');
      // The lock holder finishes the registration itself and clears the pending entry.
      setup.save_setup_state(f.home, { chrome: false, audio: true, approval: 'auto' });
      holder.stdin.end();
      let guard;
      const code = await Promise.race([finished,
        new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('the waiter did not finish within 60 s')), 60000); })]);
      clearTimeout(guard);
      assert.equal(code, 0);
      assert.equal(waiterOut, 'done []\n');
    } finally {
      // Never leave either child behind (an open pipe or a held lock keeps this file's process alive): both are ours.
      holder.stdin.destroy();
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
      if (waiter.exitCode === null && waiter.signalCode === null) waiter.kill('SIGKILL');
    }
  });
});

// ------------------------------------------------------------------------------------------- test_instructions
class Installed {
  constructor() {
    this.root = tempdir();
    this.release = path.join(this.root, 'release');
    this.app = path.join(this.release, 'app');
    this.resources = path.join(this.app, 'resources');
    this.home = path.join(this.root, 'home');
    fs.mkdirSync(this.home);
    put(path.join(this.release, 'installation.json'), '{"version":"fixture","app":"app"}');
    put(path.join(this.resources, 'plugins/openai-bundled/plugins/unified-computer-use/.mcp.json'),
      '{"mcpServers":{"cua_repl":{"type":"stdio","command":"node","args":[]}}}');
    const modules = path.join(this.resources, 'cua_node/lib/node_modules');
    for (const [relative, text] of Object.entries({
      '@oai/cua/docs/tinysky-alt-core-cua-repl.md': 'original core guide',
      '@oai/sky/docs/sky-full-desktop-api.md': 'original native API',
    })) put(path.join(modules, relative), text);
    put(path.join(this.resources, 'plugins/openai-bundled/plugins/chrome/skills/control-chrome/SKILL.md'), 'original Chrome skill');
  }
}

describe('InstalledInstructionTests', () => {
  test('setup removes the skill generated by earlier versions', async () => {
    const t = new Installed();
    setup.remove_generated_skill(t.home); // Nothing to remove is not an error.
    const old = path.join(t.home, '.local/share/lcu/skills/lcu');
    put(path.join(old, 'SKILL.md'), 'Before the first call, read the copied guides.');
    put(path.join(old, 'references/upstream/cua/docs/tinysky-alt-core-cua-repl.md'), 'copied guide');
    setup.remove_generated_skill(t.home);
    assert.equal(fs.existsSync(path.join(t.home, '.local/share/lcu/skills')), false);
  });

  test('old skill cleanup removes only LCU\'s own skill', async () => {
    const t = new Installed();
    const installed = path.join(t.root, 'installed/lcu');
    fs.mkdirSync(installed, { recursive: true });
    const calls = [];
    let listing;
    setup.impl.capture_run = (argv) => {
      calls.push(argv.slice(2));
      return argv[2] === 'list' ? ok(JSON.stringify(listing)) : ok();
    };
    const cases = [
      [[], null, 'none'],
      [[{ name: 'lcu', path: installed }], 'description: Control macOS desktop windows through the original Codex computer-use runtime.', 'removed'],
      [[{ name: 'lcu', path: installed }], 'description: Read and operate Linux desktop windows using the LCU MCP computer-use tools.', 'removed'],
      [[{ name: 'lcu', path: installed }], "description: Someone else's unrelated skill.", 'kept'],
      [[{ name: 'lcu', path: installed }], 'description: My notes. See the original Codex computer-use runtime docs.\nname: other', 'kept'],
    ];
    for (const [entries, text, expected] of cases) {
      calls.length = 0;
      listing = entries;
      if (text) fs.writeFileSync(path.join(installed, 'SKILL.md'), `---\nname: lcu\n${text}\n---\n`);
      assert.equal(setup.remove_old_skill('node', 'skills', t.root, {}, ['--global']), expected);
      assert.deepEqual(calls[0], ['list', '--json', '--global']);
      // Removal is for every agent, so the shared .agents/skills copy goes too.
      assert.deepEqual(calls.slice(1), expected === 'removed' ? [['remove', 'lcu', '--yes', '--global']] : []);
    }
  });

  test('old skill listing survives a node exit after large output', async () => {
    const t = new Installed();
    const skills = path.join(t.root, 'skills.mjs');
    fs.writeFileSync(skills, "console.log(JSON.stringify(Array.from({length: 2000}, (_, i) => "
      + "({name: 'other-' + i, path: '/x/' + 'p'.repeat(60)}))));\nprocess.exit(0);\n");
    assert.equal(setup.remove_old_skill(process.execPath, skills, t.root, process.env, ['--global']), 'none');
  });

  test('old skill listing errors say what came back', async () => {
    const t = new Installed();
    for (const stdout of ['null', '{"name": "lcu"}']) {
      setup.impl.capture_run = () => ok(stdout);
      assert.throws(() => setup.remove_old_skill('node', 'skills', t.root, {}, []), setup.isValueError);
    }
    setup.impl.capture_run = () => ok('{"truncated', 'boom: stderr detail');
    assert.throws(() => setup.remove_old_skill('node', 'skills', t.root, {}, []), (e) => setup.isValueError(e)
      && e.message === 'skill installer returned invalid JSON (11 bytes): boom: stderr detail');
  });

  const exportWith = async (t, destination, command, options = {}, policy = new Map(), files = () => ({})) => {
    setup.impl.host_policy = () => policy;
    setup.impl.export_files = files;
    await setup.export_bundle(destination, command, t.release, options);
  };

  test('export carries no skill and no upstream payload', async () => {
    const t = new Installed();
    const destination = path.join(t.root, 'export');
    await exportWith(t, destination, ['/usr/bin/lcu']);
    assert.equal(fs.existsSync(path.join(destination, 'skills')), false);
    const contents = Buffer.concat(fs.readdirSync(destination, { recursive: true })
      .map((name) => path.join(destination, name)).filter((p) => fs.statSync(p).isFile()).map((p) => fs.readFileSync(p)));
    assert.ok(!contents.includes('original core guide'));
    assert.ok(!contents.includes('original Chrome skill'));
    assert.ok(!contents.includes(t.root));
    assert.ok(!contents.includes('/usr/bin/lcu'));
    const metadata = readJson(path.join(destination, 'lcu-bootstrap.json'));
    assert.ok(!('instructionSources' in metadata));
    assert.ok(!('preCallRequirement' in metadata));
    const command = readJson(path.join(destination, 'mcp.json')).mcpServers.lcu;
    assert.equal(command.command, '/bin/sh');
    assert.ok(command.args[1].includes('LCU_PREFIX'));
    assert.ok(command.args[1].includes('LCU_SESSION_MODE'));
    for (const name of fs.readdirSync(destination)) assert.equal(fs.statSync(path.join(destination, name)).mode & 0o777, 0o600);
  });

  test('exported command resolves destination prefix and session', async () => {
    const t = new Installed();
    const destination = path.join(t.root, 'export');
    await exportWith(t, destination, ['/producer/private/lcu']);
    const command = readJson(path.join(destination, 'mcp.json')).mcpServers.lcu;
    const prefix = path.join(t.root, 'destination');
    const binDir = path.join(prefix, 'current/bin');
    for (const name of ['lcu', 'lcu-session']) put(path.join(binDir, name), '#!/bin/sh\nprintf "%s\\n" "$@"\n', 0o755);
    const env = { ...process.env, LCU_PREFIX: prefix, LCU_SESSION_MODE: 'direct' };
    let result = spawnSync(command.command, [...command.args, 'doctor'], { env, encoding: 'utf8' });
    assert.equal(result.stdout, 'doctor\n');
    env.LCU_SESSION_MODE = 'discover';
    result = spawnSync(command.command, [...command.args, 'doctor'], { env, encoding: 'utf8' });
    assert.equal(result.stdout, `--user\n${USERNAME}\n--\n${path.join(binDir, 'lcu')}\ndoctor\n`);
  });

  test('codex export routes through bundled node and audio relay', async () => {
    const t = new Installed();
    const destination = path.join(t.root, 'codex-export');
    const captured = {};
    const policy = new Map([['enabled_tools', ['js', 'js_reset', 'turn_ended']], ['omit_tools_from', ['code_mode', 'deferred']],
      ['startup_timeout_sec', 120], ['tools', new Map([['js', new Map([['output_token_limit', 25000]])]])]]);
    await exportWith(t, destination, ['/producer/private/lcu'], {}, policy, (command) => { captured.command = command; return {}; });
    const config = readJson(path.join(destination, 'codex.mcp.json')).mcpServers.lcu;
    assert.equal(config.command, '/bin/sh');
    assert.equal(config.args[0], '-c');
    assert.ok(config.args[1].includes('current/agent-tools/node/bin/node'));
    assert.ok(config.args[1].includes('current/adapters/codex.mjs'));
    assert.ok(config.args[1].includes('current/bin/lcu'));
    assert.deepEqual(config.enabled_tools, ['js', 'js_reset', 'turn_ended']);
    assert.deepEqual(config.omit_tools_from, ['code_mode', 'deferred']);
    assert.deepEqual(captured.command, [config.command, ...config.args]);
    assert.ok(!config.args.join('\n').includes('/producer/private/lcu'));
    // Policy keys first, then the launch fields.
    assert.deepEqual(Object.keys(config), ['enabled_tools', 'omit_tools_from', 'startup_timeout_sec', 'tools', 'command', 'args']);

    const prefix = path.join(t.root, 'destination');
    const binDir = path.join(prefix, 'current/bin');
    const node = path.join(prefix, 'current/agent-tools/node/bin/node');
    const adapter = path.join(prefix, 'current/adapters/codex.mjs');
    const server = path.join(binDir, 'lcu');
    const session = path.join(binDir, 'lcu-session');
    for (const p of [adapter, server]) put(p, '');
    for (const p of [node, session]) put(p, '#!/bin/sh\nprintf "%s\\n" "$@"\n', 0o755);
    const env = { ...process.env, LCU_PREFIX: prefix, LCU_SESSION_MODE: 'direct' };
    let result = spawnSync(config.command, [...config.args, '--check'], { env, encoding: 'utf8' });
    assert.equal(result.stdout, `${adapter}\n${server}\n--check\n`);
    env.LCU_SESSION_MODE = 'discover';
    result = spawnSync(config.command, [...config.args, '--check'], { env, encoding: 'utf8' });
    assert.equal(result.stdout, `--user\n${USERNAME}\n--\n${node}\n${adapter}\n${server}\n--check\n`);
  });

  test('claude setup forwards command and installs host visibility hooks', async () => {
    const t = new Installed();
    const toolRoot = path.join(t.root, 'agent-tools');
    fs.mkdirSync(toolRoot);
    const [node, skillCli, mcpCli] = ['node', 'skills.mjs', 'mcp.mjs'].map((n) => path.join(toolRoot, n));
    const adapter = path.join(t.release, 'adapters/claude.mjs');
    put(adapter, 'fixture relay');
    fs.cpSync(path.join(REPO, 'adapters/claude-mod'), path.join(t.release, 'adapters/claude-mod'), { recursive: true });
    const project = path.join(t.root, 'project');
    fs.mkdirSync(project);
    const userSettings = path.join(t.home, '.claude/settings.json');
    put(userSettings, JSON.stringify({
      model: 'sonnet', permissions: { allow: ['Read'], deny: ['Bash(rm *)'] },
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'keep-me' }] }] },
    }));
    const calls = [];
    let selectedScope = 'user';
    const run = (argv) => {
      calls.push(argv);
      if (argv[1] === skillCli && argv[2] === 'list') {
        assert.equal(argv.includes('--global'), selectedScope === 'user');
        return ok('[]');
      }
      return ok('{}');
    };
    const register = async (scope, command) => {
      calls.length = 0;
      selectedScope = scope;
      Object.assign(setup.impl, { installer_paths: () => [node, skillCli, mcpCli], preflight_mcp: () => {}, run, capture_run: run });
      const { value: failures } = await capture(() => setup.configure(['claude-code'], t.home, command, toolRoot, t.release,
        { scope, project: scope === 'project' ? project : null, environ: { HOME: t.home } }));
      assert.deepEqual(failures, []);
      assert.equal(calls.length, 2);
      const mcpCall = calls.find((argv) => argv[1] === '--input-type=module' && argv[2] === '-e');
      assert.equal(mcpCall[4], mcpCli);
      assert.deepEqual(mcpCall.slice(5, 7), ['claude-code', scope]);
      return JSON.parse(mcpCall.at(-2));
    };
    const base = ['/usr/bin/lcu', '--session', 'direct'];
    assert.deepEqual(await register('user', base), [node, adapter, ...base]);
    const configuredUser = fs.readFileSync(userSettings);
    const userData = JSON.parse(configuredUser);
    assert.equal(userData.model, 'sonnet');
    assert.deepEqual(userData.permissions.allow, ['Read']);
    assert.deepEqual(userData.permissions.deny, ['Bash(rm *)', 'mcp__lcu__turn_ended', 'mcp__lcu__js_add_node_module_dir', 'mcp__lcu__set_turn_context']);
    assert.equal(userData.hooks.UserPromptSubmit[0].hooks[0].command, 'keep-me');
    assert.equal(userData.hooks.PreToolUse[0].matcher, 'mcp__lcu__js|mcp__lcu__js_reset');
    const contextHook = userData.hooks.PreToolUse[0].hooks[0];
    assert.deepEqual([contextHook.type, contextHook.server, contextHook.tool], ['mcp_tool', 'lcu', 'set_turn_context']);
    assert.equal(contextHook.input.session_id, '${session_id}');
    assert.equal(contextHook.input.turn_id, '${prompt_id}');
    assert.equal(contextHook.input.tool_use_id, '${tool_use_id}');
    const cleanupHook = userData.hooks.Stop[0].hooks[0];
    assert.deepEqual([cleanupHook.type, cleanupHook.server, cleanupHook.tool], ['mcp_tool', 'lcu', 'turn_ended']);
    assert.equal(cleanupHook.input.session_id, '${session_id}');
    assert.equal(cleanupHook.input.turn_id, '${prompt_id}');
    await register('user', base);
    assert.deepEqual(fs.readFileSync(userSettings), configuredUser);

    const projectCommand = [...base, '--chrome', '--audio'];
    assert.deepEqual(await register('project', projectCommand), [node, adapter, ...projectCommand]);
    const projectSettings = path.join(project, '.claude/settings.local.json');
    assert.ok(fs.statSync(projectSettings).isFile());
    assert.equal(fs.existsSync(path.join(project, '.claude/settings.json')), false);
    assert.deepEqual(readJson(projectSettings).permissions.deny, ['mcp__lcu__turn_ended', 'mcp__lcu__js_add_node_module_dir', 'mcp__lcu__set_turn_context']);
    const configuredProject = fs.readFileSync(projectSettings);
    await register('project', projectCommand);
    assert.deepEqual(fs.readFileSync(projectSettings), configuredProject);
    assert.deepEqual(fs.readFileSync(userSettings), configuredUser);
    // The approval mod is a plugin folder in the skills directory of each selected scope.
    assert.ok(fs.statSync(path.join(t.home, '.claude/skills/lcu-approve/.claude-plugin/plugin.json')).isFile());
    assert.ok(fs.statSync(path.join(project, '.claude/skills/lcu-approve/hooks/register.tsx')).isFile());
  });

  test('codex setup wraps original lcu command and retains host policy', async () => {
    const t = new Installed();
    const originalCodex = path.join(t.resources, 'codex-cli/bin/codex');
    put(originalCodex, 'original Codex CLI');
    put(path.join(t.resources, 'codex-cli/bin/codex-code-mode-host'), 'original code-mode host');
    const toolRoot = path.join(t.root, 'agent-tools');
    fs.mkdirSync(toolRoot);
    const [node, skillCli, mcpCli] = ['node', 'skills.mjs', 'mcp.mjs'].map((n) => path.join(toolRoot, n));
    const adapter = path.join(t.release, 'adapters/codex.mjs');
    put(adapter, 'fixture relay');
    put(path.join(t.release, 'adapters/audio-files.mjs'), 'fixture helper');
    const original = ['/opt/lcu/current/bin/lcu', '--chrome', '--audio', '--session=direct'];
    const calls = [];
    const policy = new Map([['enabled_tools', ['js', 'js_reset', 'turn_ended']], ['omit_tools_from', ['code_mode', 'deferred']],
      ['startup_timeout_sec', 120], ['tools', new Map([['js', new Map([['output_token_limit', 25000]])]])]]);
    const config = path.join(t.home, '.codex/config.toml');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const run = (argv) => {
      calls.push(argv);
      return argv[1] === skillCli && argv[2] === 'list' ? ok('[]') : ok(JSON.stringify({ path: config }));
    };
    const hooks = [];
    Object.assign(setup.impl, {
      installer_paths: () => [node, skillCli, mcpCli], host_policy: () => policy, preflight_mcp: () => {}, run, capture_run: run,
      require_cli_hook_support: () => {}, install_hooks: (...a) => hooks.push(a),
    });
    const { value: failures } = await capture(() => setup.configure(['codex'], t.home, original, toolRoot, t.release, { environ: { HOME: t.home } }));
    assert.deepEqual(failures, []);
    assert.equal(calls.length, 2);
    const mcpCall = calls.find((argv) => argv[1] === '--input-type=module' && argv[2] === '-e');
    assert.deepEqual(JSON.parse(mcpCall.at(-2)), [node, adapter, ...original]);
    assert.deepEqual(JSON.parse(mcpCall.at(-1)), plain(policy));
    assert.equal(mcpCall.at(-1), '{"enabled_tools": ["js", "js_reset", "turn_ended"], "omit_tools_from": ["code_mode", "deferred"], "startup_timeout_sec": 120, "tools": {"js": {"output_token_limit": 25000}}}');
    assert.equal(hooks[0][0], originalCodex);
    assert.equal(hooks[0][1], config);
  });

  test('pi registration removes old skill and uses offline local package', async () => {
    assert.deepEqual(new Set(Object.keys(CLIENTS)), new Set(['codex', 'claude-code', 'pi', 'omp', 'hermes']));
    const t = new Installed();
    const toolRoot = path.join(t.root, 'agent-tools');
    const [node, skillCli, mcpCli] = ['node', 'skills.mjs', 'mcp.mjs'].map((n) => path.join(toolRoot, n));
    put(path.join(t.release, 'adapters/pi/index.ts'), 'fixture');
    const selected = path.join(t.home, '.local/share/lcu/pi/commands.json');
    put(selected, JSON.stringify({ projects: { '/existing/project': ['/usr/bin/lcu'] }, preserved: true }));
    const calls = [];
    const run = (argv, kwargs) => {
      calls.push([argv, kwargs]);
      if (argv[1] === skillCli && argv[2] === 'list') return ok('[]');
      assert.deepEqual(argv.slice(1, 3), ['install', path.join(t.home, '.local/share/lcu/pi/extension.mjs')]);
      assert.equal(kwargs.env.PI_OFFLINE, '1');
      return ok('Installed');
    };
    Object.assign(setup.impl, { installer_paths: () => [node, skillCli, mcpCli], which: () => '/bin/pi', run, capture_run: run });
    const { value: failures } = await capture(() => setup.configure(['pi'], t.home, ['/usr/bin/lcu', '--audio'], toolRoot, t.release, { environ: { HOME: t.home } }));
    assert.deepEqual(failures, []);
    assert.equal(calls.length, 2);
    assert.equal(calls[1][0][0], '/bin/pi');
    const wrapper = fs.readFileSync(path.join(t.home, '.local/share/lcu/pi/extension.mjs'), 'utf8');
    const uri = `file://${path.join(t.release, 'adapters/pi/index.ts')}`;
    assert.equal(wrapper, `import lcu from "${uri}";\nimport {readFileSync, realpathSync} from "node:fs";\n`
      + `const config = JSON.parse(readFileSync("${selected}", "utf8"));\n`
      + 'export default pi => lcu(pi, {command: config.projects?.[realpathSync(process.cwd())] ?? config.user});\n');
    assert.ok(!wrapper.includes('.pi/lcu-command.json'));
    assert.deepEqual(readJson(selected), { projects: { '/existing/project': ['/usr/bin/lcu'] }, preserved: true, user: ['/usr/bin/lcu', '--audio'] });
    assert.equal(fs.readFileSync(selected, 'utf8'), '{\n  "projects": {\n    "/existing/project": [\n      "/usr/bin/lcu"\n    ]\n  },\n'
      + '  "preserved": true,\n  "user": [\n    "/usr/bin/lcu",\n    "--audio"\n  ]\n}\n');
  });

  test('pi project scope keys the resolved project and passes -l', async () => {
    const t = new Installed();
    const toolRoot = path.join(t.root, 'agent-tools');
    put(path.join(t.release, 'adapters/pi/index.ts'), 'fixture');
    const project = path.join(t.root, 'proj@1');
    fs.mkdirSync(project);
    const calls = [];
    const run = (argv) => { calls.push(argv); return argv[2] === 'list' ? ok('[]') : ok(); };
    Object.assign(setup.impl, { installer_paths: () => ['n', 's', 'm'], which: () => '/bin/pi', run, capture_run: run });
    const { value } = await capture(() => setup.configure(['pi'], t.home, ['/usr/bin/lcu'], toolRoot, t.release,
      { scope: 'project', project, environ: { HOME: t.home } }));
    assert.deepEqual(value, []);
    assert.deepEqual(calls[1], ['/bin/pi', 'install', '-l', path.join(t.home, '.local/share/lcu/pi/extension.mjs')]);
    assert.deepEqual(readJson(path.join(t.home, '.local/share/lcu/pi/commands.json')), { projects: { [project]: ['/usr/bin/lcu'] } });
  });

  test('missing pi reports the setup command', async () => {
    const t = new Installed();
    Object.assign(setup.impl, { installer_paths: () => ['n', 's', 'm'], which: () => null, capture_run: () => ok('[]') });
    const { value, err } = await capture(() => setup.configure(['pi'], t.home, ['/x/lcu'], path.join(t.root, 'tools'), t.release,
      { environ: { HOME: t.home }, setup_command: '/x/lcu' }));
    assert.deepEqual(value, [['pi', 'extension', 'Pi is not on the target account PATH. Install Pi, then run `/x/lcu setup --agent pi --yes` from that account shell.']]);
    assert.equal(err, 'Pi: extension failed: Pi is not on the target account PATH. Install Pi, then run `/x/lcu setup --agent pi --yes` from that account shell.\n');
  });

  test('selected app descriptor and resources are required', async () => {
    const t = new Installed();
    assert.equal(setup.installed_app_resources(t.release), fs.realpathSync(t.resources));
    assert.deepEqual([...setup.host_policy(t.release)], [['type', 'stdio']]);
    fs.unlinkSync(path.join(t.release, 'installation.json'));
    assert.throws(() => setup.installed_app_resources(t.release), /descriptor missing/);
  });

  test('installed_app_resources error messages', async () => {
    const t = new Installed();
    const descriptor = path.join(t.release, 'installation.json');
    const cases = [
      ['{ nope', `Invalid installed application descriptor: ${descriptor}`],
      ['[]', `Installed application descriptor has no app reference: ${descriptor}`],
      ['{"app": ""}', `Installed application descriptor has no app reference: ${descriptor}`],
      ['{"app": "missing"}', `Installed application path is incomplete: ${t.release}`],
      ['{"app": "app", "platform": "win32"}', 'Unsupported installed application platform: win32'],
      ['{"app": "app", "platform": "darwin"}', `Installed application resources missing: ${path.join(t.app, 'Contents/Resources')}`],
    ];
    for (const [text, message] of cases) {
      fs.writeFileSync(descriptor, text);
      assert.throws(() => setup.installed_app_resources(t.release), (e) => setup.isValueError(e) && e.message === message, text);
    }
  });

  test('legacy browser host flag fails with chrome migration', async () => {
    const args = setup.parser().parse_args(['--browser-host']);
    assert.throws(() => setup.validate(args), /setup --agent AGENT --chrome/);
  });

  test('chrome export only adds runtime flag when selected', async () => {
    const t = new Installed();
    await exportWith(t, path.join(t.root, 'native-export'), ['/usr/bin/lcu']);
    await exportWith(t, path.join(t.root, 'chrome-export'), ['/usr/bin/lcu', '--chrome'], { chrome: true });
    await exportWith(t, path.join(t.root, 'audio-export'), ['/usr/bin/lcu', '--audio'], { audio: true });
    const server = (name) => readJson(path.join(t.root, name, 'mcp.json')).mcpServers.lcu;
    assert.ok(!server('native-export').args.includes('--chrome'));
    assert.equal(server('chrome-export').args.at(-1), '--chrome');
    assert.equal(server('audio-export').args.at(-1), '--audio');
    assert.ok(readJson(path.join(t.root, 'chrome-export/lcu-bootstrap.json')).destinationSetup.includes('--chrome'));
    assert.ok(readJson(path.join(t.root, 'audio-export/lcu-bootstrap.json')).destinationSetup.includes('--audio'));
  });

  test('setup state round trips and rejects malformed', async () => {
    const t = new Installed();
    const empty = { chrome: false, audio: false, approval: 'ask', pending: [], pending_context: null };
    assert.deepEqual(setup.load_setup_state(t.home), empty);
    setup.save_setup_state(t.home, { chrome: true, audio: false });
    assert.deepEqual(setup.load_setup_state(t.home), { ...empty, chrome: true });
    assert.deepEqual(readJson(setup.setup_state_path(t.home)), { chrome: true, audio: false, approval: 'ask' });
    setup.save_setup_state(t.home, { chrome: true, audio: false, approval: 'auto' });
    assert.equal(setup.load_setup_state(t.home).approval, 'auto');
    // A state file from before approval modes existed means ask.
    fs.writeFileSync(setup.setup_state_path(t.home), '{"chrome": true, "audio": false}');
    assert.deepEqual(setup.load_setup_state(t.home), { ...empty, chrome: true });
    for (const text of ['{"chrome": true, "audio": false, "approval": "yolo"}', '{ not json', '{"chrome": "yes", "audio": false}', '\xff']) {
      fs.writeFileSync(setup.setup_state_path(t.home), text, text === '\xff' ? 'latin1' : 'utf8');
      assert.throws(() => setup.load_setup_state(t.home), /Malformed LCU setup state/);
    }
  });

  test('conflicting chrome and audio flags are rejected', async () => {
    for (const pair of [['--chrome', '--no-chrome'], ['--audio', '--no-audio']]) {
      assert.throws(() => setup.validate(setup.parser().parse_args([...pair, '--agent', 'codex'])), /not both/);
    }
  });

  test('list agents shows user-only scope for native harness plugins', async () => {
    assert.equal(setup.agent_scopes('omp'), 'user');
    assert.equal(setup.agent_scopes('hermes'), 'user');
    assert.equal(setup.agent_scopes('codex'), 'user, project');
    const { out } = await capture(() => setup.main(['--list-agents']));
    assert.equal(out, 'codex            Codex (user, project)\nclaude-code      Claude Code (user, project)\n'
      + 'pi               Pi (user, project)\nomp              Oh My Pi (user)\nhermes           Hermes (user)\n'
      + 'Custom clients: --export /absolute/new/plugin-directory\n');
  });

  test('setup persists and reuses chrome opt-in', async () => {
    const t = new Installed();
    const prefix = path.join(t.root, 'prefix');
    for (const name of ['current/bin/lcu', 'current/bin/lcu-session']) put(path.join(prefix, name), 'fixture', 0o755);
    const acct = account(t.home);
    const captured = [];
    const drive = async (argv, extra = {}) => {
      Object.assign(setup.impl, {
        platform: 'linux', validate: () => [acct, ['codex']], installer_environment: () => {}, installer_paths: () => {},
        setup_lock: nullLock, configure: (names, home, command) => { captured.push(command); return []; },
        browser_install: () => {}, run: () => ok(), report_tested_pair: () => {}, ...extra,
      });
      return await capture(() => setup.main(['--prefix', prefix, '--agent', 'codex', '--session', 'direct', ...argv]));
    };
    await drive(['--chrome', '--yes']);
    assert.deepEqual(readJson(path.join(t.home, '.local/state/lcu/setup.json')), { chrome: true, audio: false, approval: 'ask' });
    assert.ok(captured.at(-1).includes('--chrome'));
    await drive(['--yes']);
    assert.ok(captured.at(-1).includes('--chrome'));
    await drive(['--no-chrome', '--yes']);
    assert.ok(!captured.at(-1).includes('--chrome'));
    assert.deepEqual(readJson(path.join(t.home, '.local/state/lcu/setup.json')), { chrome: false, audio: false, approval: 'ask' });
    // A saved decline is a choice: an interactive rerun does not prompt again.
    const prompts = [];
    await drive([], { isatty: () => true, input: (question) => { prompts.push(question); return 'y'; } });
    assert.deepEqual(prompts, ['Apply this setup? [y/N] ']);
    assert.ok(!captured.at(-1).includes('--chrome'));
  });

  test('first interactive setup asks about Chrome and a declined apply changes nothing', async () => {
    const t = new Installed();
    const prefix = path.join(t.root, 'prefix');
    for (const name of ['current/bin/lcu', 'current/bin/lcu-session']) put(path.join(prefix, name), 'fixture', 0o755);
    const prompts = [];
    const answers = ['YES ', ' n'];
    Object.assign(setup.impl, {
      platform: 'linux', validate: () => [account(t.home), ['codex']], installer_environment: () => {}, installer_paths: () => {},
      configure: () => { throw new Error('configured'); }, run: () => ok(), report_tested_pair: () => {},
      isatty: () => true, input: (q) => { prompts.push(q); return answers.shift(); },
    });
    const { code, out } = await capture(() => setup.main(['--prefix', prefix, '--session', 'direct']));
    assert.equal(code, 0);
    assert.deepEqual(prompts, ['Enable Chrome browser control and its extension connector? [y/N] ', 'Apply this setup? [y/N] ']);
    assert.ok(out.includes('Chrome control selected: register the original extension connector'));
    assert.ok(out.endsWith('Cancelled; no agent configuration changed.\n'));
    assert.equal(fs.existsSync(path.join(t.home, '.local/state/lcu/setup.json')), false);
  });
});

// ------------------------------------------------------------------------------------------- test_windows_setup
describe('WindowsSetupTests', () => {
  test('node installer output decodes (non-UTF-8-safe stderr bytes)', async () => {
    const base = tempdir();
    const home = path.join(base, 'home');
    fs.mkdirSync(home);
    const node = path.join(base, 'node-fixture');
    put(node, '#!/bin/sh\ncase "$1" in\n  *skills.mjs) echo "[]"; printf \'note \\342\\200\\217\\n\' >&2 ;;\n'
      + `  *) for a in "$@"; do case "$a" in *upsertServer*) echo '{"path":"${base}/mcp.json"}';; esac; done ;;\nesac\n`, 0o755);
    put(path.join(base, 'adapters/claude.mjs'), 'fixture relay');
    fs.cpSync(path.join(REPO, 'adapters/claude-mod'), path.join(base, 'adapters/claude-mod'), { recursive: true });
    Object.assign(setup.impl, {
      installer_paths: () => [node, path.join(base, 'skills.mjs'), path.join(base, 'mcp.mjs')],
      installed_app_resources: () => path.join(base, 'resources'), host_policy: () => new Map(),
    });
    const { value } = await capture(() => setup.configure(['claude-code'], home, ['lcu'], path.join(base, 'tools'), base,
      { environ: { HOME: home, PATH: base } }));
    assert.deepEqual(value, []);
  });

  test('codex hooks use original platform executable', async () => {
    const base = tempdir();
    const resources = path.join(base, 'app/resources');
    const codexBin = path.join(resources, 'codex-cli/bin');
    fs.mkdirSync(codexBin, { recursive: true });
    const release = path.join(base, 'release');
    put(path.join(release, 'adapters/codex.mjs'), 'fixture relay');
    put(path.join(release, 'adapters/audio-files.mjs'), 'fixture helper');
    const config = path.join(base, 'account/config.toml');
    fs.mkdirSync(path.dirname(config));
    for (const [system, expected] of [['win32', 'codex.exe'], ['linux', 'codex'], ['darwin', 'codex']]) {
      put(path.join(codexBin, expected), 'original Codex CLI');
      put(path.join(codexBin, system === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'), 'original code-mode host');
      const registered = (argv) => ok(` ${argv.join(' ')} `.includes(' list ') ? '[]' : JSON.stringify({ path: config }));
      const hooks = [];
      Object.assign(setup.impl, {
        platform: system, installer_environment: () => ({ PATH: 'fixture' }),
        installer_paths: () => [path.join(base, 'node'), path.join(base, 'skills'), path.join(base, 'mcp')],
        installed_app_resources: () => resources, host_policy: () => new Map(), preflight_mcp: () => {},
        run: registered, capture_run: registered, require_cli_hook_support: () => {}, install_hooks: (...a) => hooks.push(a),
      });
      const { value } = await capture(() => setup.configure(['codex'], path.dirname(config), ['lcu'], path.join(base, 'tools'), release));
      assert.deepEqual(value, [], system);
      assert.equal(hooks[0][0], path.join(codexBin, expected), system);
    }
  });

  test('linux discover setup keeps version probe on direct runtime', async () => {
    const prefix = path.join(tempdir(), 'lcu');
    const binary = path.join(prefix, 'current/bin/lcu');
    for (const p of [binary, path.join(prefix, 'current/bin/lcu-session')]) put(p, 'fixture', 0o755);
    const calls = [];
    Object.assign(setup.impl, {
      platform: 'linux', validate: () => [account(path.dirname(prefix)), ['codex']], installer_environment: () => {},
      installer_paths: () => {}, setup_lock: nullLock, configure: () => [], report_tested_pair: () => {},
      run: (argv, options) => { calls.push([argv, options]); return ok(); },
    });
    await capture(() => setup.main(['--prefix', prefix, '--agent', 'codex', '--session', 'discover', '--yes']));
    assert.deepEqual(calls[0][0], [binary, '--version']);
    assert.deepEqual(calls[0][1], { check: true, timeout: 20, stdout: setup.DEVNULL });
  });

  test('registered windows account and direct session only', async () => {
    const home = tempdir();
    setup.impl.platform = 'win32';
    process.env.USERPROFILE = home;
    const args = setup.parser().parse_args(['--prefix', path.join(home, 'LCU'), '--agent', 'codex', '--session', 'direct']);
    const [acct, names] = setup.validate(args);
    assert.deepEqual([acct.pw_dir, names], [home, ['codex']]);
    args.session = 'discover';
    assert.throws(() => setup.validate(args), /direct/);
    args.session = 'direct';
    args.export = types.Path(path.join(home, 'export'));
    assert.throws(() => setup.validate(args), /Windows portable export/);
    args.export = null;
    args.user = 'SOMEONE-ELSE-' + USERNAME;
    assert.throws(() => setup.validate(args), /only configures the current signed-in account/);
  });

  test('windows registration runs <prefix>\\lcu.cmd through cmd.exe; every LCU-owned form is recognised', async () => {
    const prefix = path.join(tempdir(), 'LCU');
    fs.mkdirSync(prefix);
    setup.impl.platform = 'win32';
    process.env.SystemRoot = 'D:\\Win';
    delete process.env.SYSTEMROOT;
    const args = setup.parser().parse_args(['--prefix', prefix, '--session', 'direct']);
    const [, runtime, launcher, command] = setup.runtime_paths(args, { pw_name: 'x' });
    assert.equal(runtime, path.join(prefix, 'lcu.cmd'));
    assert.equal(launcher, runtime);
    assert.deepEqual(command, ['D:\\Win\\System32\\cmd.exe', '/d', '/c', path.join(prefix, 'lcu.cmd')]);
    // SystemRoot must be absolute, else the fixed fallback.
    for (const value of [undefined, '', 'relative\\win', '%SystemRoot%']) {
      if (value === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = value;
      assert.equal(setup.windows_registration_command(prefix)[0], 'C:\\Windows\\System32\\cmd.exe', String(value));
    }
    delete process.env.SystemRoot; // one case-insensitive variable on Windows
    process.env.SYSTEMROOT = 'E:\\W';
    assert.equal(setup.windows_registration_command(prefix)[0], 'E:\\W\\System32\\cmd.exe');
    setup.assert_windows_registration([...command, '--chrome', '--audio']);
    for (const bad of [[...command, '--user'], [...command, 'x & calc'], ['C:\\x\\node.exe', ...command.slice(1)],
      [command[0], '/c', '/d', command[3]], [command[0], '/d', '/c', 'C:\\LCU\\other.cmd']]) {
      assert.throws(() => setup.assert_windows_registration(bad), /Refusing to register a Windows command LCU did not build/);
    }
    assert.equal(setup.windows_command_form(['C:\\Python313\\python.exe', '-B', 'C:\\Users\\u\\AppData\\Local\\LCU\\windows_launcher.py', '--chrome']), 'python');
    assert.equal(setup.windows_command_form(['C:\\LCU\\apps\\d\\app\\resources\\cua_node\\bin\\node.exe', 'C:\\LCU\\windows_launcher.mjs']), 'node');
    assert.equal(setup.windows_command_form(['C:\\L\\launcher-runtimes\\current\\node.exe', 'C:\\L\\launcher-runtimes\\current\\dispatcher.mjs', '--audio']), 'node');
    assert.equal(setup.windows_command_form(command), 'cmd');
    assert.equal(setup.windows_command_form(['C:\\x\\node.exe', 'C:\\x\\server.mjs']), null);
    assert.equal(setup.is_legacy_windows_command(['py.exe', '-B', 'C:\\L\\windows_launcher.py']), true);
    assert.equal(setup.is_legacy_windows_command(['C:\\n\\node.exe', 'C:\\L\\windows_launcher.mjs']), true);
    assert.equal(setup.is_legacy_windows_command(command), false);
  });

  test('windows prefixes: spaces are fine, characters cmd cannot pass safely are refused before registering', async () => {
    setup.impl.platform = 'win32';
    setup.impl.windows_paths = true;
    process.env.SystemRoot = 'C:\\Windows';
    assert.deepEqual(setup.windows_registration_command('C:\\Users\\Ada Lovelace\\AppData\\Local\\LCU'),
      ['C:\\Windows\\System32\\cmd.exe', '/d', '/c', 'C:\\Users\\Ada Lovelace\\AppData\\Local\\LCU\\lcu.cmd']);
    for (const ch of ['%', '"', '!', '&', '<', '>', '(', ')', '@', '^', '|']) {
      const prefix = `C:\\Users\\a${ch}b\\LCU`;
      assert.throws(() => setup.windows_registration_command(prefix), (e) => setup.isValueError(e)
        && e.message === `The Windows command processor cannot run ${prefix}\\lcu.cmd safely: remove % " ! & < > ( ) @ ^ | `
          + 'from the LCU prefix (reinstall LCU into another --prefix), then rerun setup.', ch);
    }
    // Through main: refused with "Setup failed", nothing registered or pinned.
    setup.impl.windows_paths = false;
    const f = new Fixture();
    const prefix = path.join(f.root, 'a&b');
    makeRuntime(prefix);
    let configured = false;
    Object.assign(setup.impl, {
      validate: () => [f.account, ['codex']], installer_environment: () => {}, installer_paths: () => {},
      run: () => ok(), report_tested_pair: () => {}, release_dir: () => prefix, configure: () => { configured = true; return []; },
    });
    const { code, err } = await capture(() => setup.main(['--prefix', prefix, '--session', 'direct', '--yes', '--no-chrome']));
    assert.equal(code, 1);
    assert.match(err, /^Setup failed: The Windows command processor cannot run .*a&b\/lcu\.cmd safely/);
    assert.equal(configured, false);
    assert.equal(fs.existsSync(path.join(prefix, 'launcher-pins.json')), false);
  });
});

// ------------------------------------------------------------------------------------------- test_approval
describe('setup approval behaviour (test_approval.py)', () => {
  const TOOLS = { js: { approval_mode: 'approve' }, js_reset: { approval_mode: 'approve' } };

  const register = async (mode) => {
    const root = tempdir();
    const home = path.join(root, 'home');
    const release = path.join(root, 'release');
    const tools = path.join(root, 'tools');
    fs.mkdirSync(home);
    put(path.join(release, 'adapters/codex.mjs'), 'relay');
    put(path.join(release, 'adapters/audio-files.mjs'), 'helper');
    const config = path.join(home, '.codex/config.toml');
    const host = new Map([['enabled_tools', ['js']], ['startup_timeout_sec', 120]]);
    const calls = [];
    Object.assign(setup.impl, {
      installer_paths: () => [path.join(tools, 'node'), path.join(tools, 's.mjs'), path.join(tools, 'm.mjs')],
      installed_app_resources: () => path.join(root, 'resources'), host_policy: () => host, preflight_mcp: () => {},
      run: (argv) => { calls.push(argv); return ok(JSON.stringify({ path: config })); }, remove_old_skill: () => 'none',
      require_cli_hook_support: () => {}, install_hooks: () => {}, locate_codex_tools: () => ({ cli: path.join(root, 'codex') }),
    });
    const { value } = await capture(() => setup.configure(['codex'], home, ['/opt/lcu/current/bin/lcu'], tools, release,
      { environ: { HOME: home }, approval: mode }));
    assert.deepEqual(value, []);
    return [JSON.parse(calls.find((argv) => argv.includes('--input-type=module')).at(-1)), plain(host)];
  };

  test('registration policy carries the tool approvals only for auto', async () => {
    let [policy, host] = await register('auto');
    assert.deepEqual(policy, { ...host, tools: TOOLS });
    for (const mode of ['ask', null]) {
      [policy, host] = await register(mode);
      assert.deepEqual(policy, host);
    }
  });

  test('export cannot carry an approval mode', async () => {
    const argv = ['--export', '/tmp/new-export', '--approval', 'auto', ...(IS_ROOT ? ['--user', 'root'] : [])];
    assert.throws(() => setup.validate(setup.parser().parse_args(argv)), /cannot be combined with --export/);
  });

  class Persistence {
    constructor() {
      this.root = tempdir();
      this.prefix = path.join(this.root, 'prefix');
      this.home = path.join(this.root, 'home');
      fs.mkdirSync(this.home);
      makeRuntime(this.prefix);
      this.configured = [];
    }

    async drive(argv = [], { agents = ['codex'], failures = [] } = {}) {
      Object.assign(setup.impl, {
        platform: 'linux', validate: () => [account(this.home), [...agents]], installer_environment: () => {},
        installer_paths: () => {}, run: () => ok(), report_tested_pair: () => {},
        configure: (names, home, command, toolsRoot, releaseRoot, options = {}) => {
          this.configured.push('approval' in options ? options.approval : 'missing');
          return [...failures];
        },
      });
      return await capture(() => setup.main(['--prefix', this.prefix, '--session', 'direct', '--yes', '--no-chrome', ...argv]));
    }

    saved() {
      return setup.load_setup_state(this.home).approval;
    }
  }

  test('default leaves harness settings alone and saves ask', async () => {
    const p = new Persistence();
    const { out } = await p.drive();
    assert.deepEqual(p.configured, [null]);
    assert.equal(p.saved(), 'ask');
    assert.ok(!out.includes('Approval mode'));
  });

  test('auto is applied, remembered and reapplied by later setups', async () => {
    const p = new Persistence();
    let { out } = await p.drive(['--approval', 'auto'], { agents: ['codex', 'pi'] });
    assert.deepEqual(p.configured, ['auto']);
    assert.equal(p.saved(), 'auto');
    assert.ok(out.includes('Approval mode auto: add only LCU\'s own entries so its tools run without a per-call harness prompt: '
      + 'Codex: `approval_mode = "approve"` for the `js` and `js_reset` tools of `[mcp_servers.lcu]`. Pi and Hermes have no such gate. '
      + 'Native-app and Chrome approvals from the original runtime are unchanged.\n'));
    ({ out } = await p.drive());
    assert.deepEqual(p.configured, ['auto', 'auto']);
    assert.ok(out.includes('Keeping automatic approval'));
  });

  test('explicit ask removes entries and is remembered', async () => {
    const p = new Persistence();
    await p.drive(['--approval', 'auto']);
    const { out } = await p.drive(['--approval', 'ask']);
    assert.deepEqual(p.configured, ['auto', 'ask']);
    assert.equal(p.saved(), 'ask');
    assert.ok(out.includes('Approval mode ask: remove only the entries'));
    await p.drive();
    assert.equal(p.configured.at(-1), null);
  });

  test('failed registration remembers the mode and retry keeps it', async () => {
    const p = new Persistence();
    const { err } = await p.drive(['--approval', 'auto'], { failures: [['codex', 'approval', 'boom']] });
    assert.equal(p.saved(), 'auto');
    assert.ok(err.includes('--approval auto'));
  });

  test('parser accepts only known modes', async () => {
    assert.equal(setup.parser().parse_args(['--approval', 'auto']).approval, 'auto');
    const { code, err } = await capture(() => setup.parser().parse_args(['--approval', 'yolo']));
    assert.equal(code, 2);
    assert.ok(err.endsWith("error: argument --approval: invalid choice: 'yolo' (choose from ask, auto)\n"));
  });
});

// ------------------------------------------------------------------------------------------- test_harness_setup
describe('HarnessSetupTests (setup side)', () => {
  test('detect uses the client path without setup scope state', async () => {
    const home = tempdir();
    setup.impl.which = (executable) => (executable === 'omp' ? '/mock/bin/omp' : null);
    assert.deepEqual(setup.detect(home), ['omp']);
    fs.mkdirSync(path.join(home, '.codex'));
    assert.deepEqual(setup.detect(home), ['codex', 'omp']);
  });

  test('validate rejects profile-scoped agents for project scope', async () => {
    const root = tempdir();
    const project = path.join(root, 'project with spaces');
    fs.mkdirSync(project);
    for (const name of ['omp', 'hermes']) {
      const argv = ['--prefix', path.join(root, 'prefix'), '--scope', 'project', '--project', project, '--agent', name,
        ...(IS_ROOT ? ['--user', 'root'] : [])];
      assert.throws(() => setup.validate(setup.parser().parse_args(argv)), /project scope is not supported/);
    }
  });

  test('omp/hermes route through the native plugin installers and apply approval after success', async () => {
    const home = tempdir();
    const calls = [];
    const applied = [];
    Object.assign(setup.impl, {
      installer_paths: () => ['/original/node', '/skills', '/mcp'], installed_app_resources: () => '/r',
      configure_omp: (...a) => calls.push(['omp', ...a]),
      configure_hermes: () => { throw new setup.ValueError('Hermes is not on the target account PATH.'); },
      approvals: { ...setup.impl.approvals, apply: (mode, name) => { applied.push([mode, name]); return 'unchanged'; } },
    });
    const { value, out, err } = await capture(() => setup.configure(['omp', 'hermes'], home, ['/c'], '/t', '/rel',
      { environ: { PATH: '/bin' }, approval: 'auto' }));
    assert.deepEqual(value, [['hermes', 'plugin', 'Hermes is not on the target account PATH.']]);
    assert.equal(out, 'Oh My Pi: plugin registered.\nOh My Pi: approval auto: unchanged.\n');
    assert.equal(err, 'Hermes: plugin failed: Hermes is not on the target account PATH.\n');
    assert.deepEqual(applied, [['auto', 'omp']]);
    assert.equal(calls[0][1], home);
    assert.deepEqual(calls[0].at(-1).env.HOME, home);
  });

  test('profile paths must be absolute', async () => {
    for (const [name, variable] of [['hermes', 'HERMES_HOME'], ['omp', 'PI_CODING_AGENT_DIR'], ['codex', 'CODEX_HOME']]) {
      assert.throws(() => setup.installer_environment('/h', [name], { [variable]: 'relative/profile' }), new RegExp(`${variable} must be absolute`));
    }
  });
});

// ------------------------------------------------------------------------------------------- test_doctor
describe('SetupReadinessTests', () => {
  test('yes defers readiness and explicit check requires it', async () => {
    const args = { check_desktop: false, export: null, yes: true };
    assert.equal(setup.desktop_readiness_mode(args, { interactive: true }), 'deferred');
    args.check_desktop = true;
    assert.equal(setup.desktop_readiness_mode(args, { interactive: true }), 'required');
  });

  test('setup doctor invocation is guided unbounded or strict bounded', async () => {
    const desktop = ['/opt/lcu/current/bin/lcu-session', '--user', 'alice', '--', '/opt/lcu/current/bin/lcu'];
    let [mode, command, timeout] = setup.desktop_readiness_request({ check_desktop: false, export: null, yes: false },
      { interactive: true, desktop_command: desktop });
    assert.equal(mode, 'guided');
    assert.deepEqual(command, [...desktop, 'doctor']);
    assert.equal(timeout, null);
    const calls = [];
    const runner = (...a) => { calls.push(a); return { returncode: 2 }; };
    assert.equal(setup.run_desktop_doctor(command, { timeout, runner }).returncode, 2);
    assert.deepEqual(calls, [[command, { check: false }]]);
    [mode, command, timeout] = setup.desktop_readiness_request({ check_desktop: true, export: null, yes: true },
      { interactive: false, desktop_command: desktop });
    assert.equal(mode, 'required');
    assert.deepEqual(command, [...desktop, 'doctor', '--non-interactive', '--require-ready']);
    assert.equal(timeout, 50);
    calls.length = 0;
    setup.run_desktop_doctor(command, { timeout, runner });
    assert.deepEqual(calls, [[command, { check: false, timeout: 50 }]]);
  });

  test('interactive setup guides and export skips local desktop', async () => {
    const args = { check_desktop: false, export: null, yes: false };
    assert.equal(setup.desktop_readiness_mode(args, { interactive: true }), 'guided');
    args.export = '/plugin';
    assert.equal(setup.desktop_readiness_mode(args, { interactive: true }), 'skip');
  });

  test('required readiness failures exit 2 with the saved-configuration messages', async () => {
    const f = new Fixture();
    const drive = async (run) => {
      Object.assign(setup.impl, {
        platform: 'linux', validate: () => [f.account, ['codex']], installer_environment: () => {}, installer_paths: () => {},
        configure: () => [], report_tested_pair: () => {}, run,
      });
      return await capture(() => setup.main(['--prefix', f.prefix, '--session', 'direct', '--yes', '--no-chrome', '--check-desktop']));
    };
    let r = await drive((argv) => (argv.includes('doctor') ? { returncode: 3 } : ok()));
    assert.equal(r.code, 2);
    assert.equal(r.err, 'Agent configuration is saved, but desktop readiness was not verified. Review the status above, then rerun lcu doctor.\n');
    assert.ok(r.out.endsWith('Checking live desktop readiness. This check will not open System Settings.\n'));
    r = await drive((argv, o) => { if (argv.includes('doctor')) { assert.equal(o.timeout, 50); throw new setup.TimeoutExpired(argv, 50000); } return ok(); });
    assert.equal(r.code, 2);
    assert.ok(r.err.startsWith('Agent configuration is saved, but desktop readiness was not verified. Check the runtime, then rerun lcu doctor.\nDetails: Command \'['));
    assert.ok(r.err.endsWith("'doctor', '--non-interactive', '--require-ready']' timed out after 50 seconds\n"));
    r = await drive((argv) => (argv.includes('doctor') ? { returncode: 0 } : ok()));
    assert.equal(r.code, 0);
    assert.ok(r.out.endsWith('Desktop readiness check passed. Tool discovery still needs the first agent connection.\n'));
  });

  test('deferred readiness prints the shell-quoted doctor command', async () => {
    const f = new Fixture();
    const [, out] = await f.runMain([], { agents: ['codex'] });
    assert.ok(out.endsWith(`Desktop readiness was not checked. Reconnect your agent, then run:\n  ${path.join(f.prefix, 'current/bin/lcu')} doctor\n`));
  });
});

// ------------------------------------------------------------------------------------------- test_tested_versions
test('setup reports the tested pair and still registers', async () => {
  const prefix = path.join(tempdir(), 'prefix');
  const current = path.join(prefix, 'current');
  for (const name of ['bin/lcu', 'bin/lcu-session']) put(path.join(current, name), 'fixture', 0o755);
  const home = path.join(prefix, 'home');
  fs.mkdirSync(home);
  // tests/test_tested_versions.py make_release() + record(entry()); runtime.paths patched there is the
  // `metadata` the real tested.report() would otherwise read from the selected app.
  const PAIR_RUNTIME = '0.0.16/20260915001755-492f19756c31';
  put(path.join(current, 'installation.json'), JSON.stringify({ platform: 'linux', architecture: 'arm64', app: 'app' }));
  put(path.join(current, 'bundle.json'), JSON.stringify({ version: '9.9.9' }));
  put(path.join(current, tested.RECORD), JSON.stringify({ format: 1, entries: [{
    platform: 'linux', architecture: 'arm64', app_version: '26.915.31945', runtime: PAIR_RUNTIME, lcu_version: '0.7.0',
    app_sha256: 'b'.repeat(64), evidence: 'docs/releases/0.7.0.md' }] }));
  const reported = [];
  let configured = 0;
  Object.assign(setup.impl, {
    platform: 'linux', validate: () => [account(home), ['codex']], installer_environment: () => {}, installer_paths: () => {},
    configure: () => { configured += 1; return []; }, run: () => ok(),
    report_tested_pair: (root) => {
      reported.push(root);
      tested.report(root, { metadata: { version: '27.1.1', runtime: PAIR_RUNTIME }, file: { write: (t) => setup.io.stdout(t) } });
    },
  });
  const { out } = await capture(() => setup.main(['--prefix', prefix, '--agent', 'codex', '--session', 'direct', '--yes']));
  assert.ok(out.includes('Tested pair: no.'));
  assert.ok(out.includes('Warning: ChatGPT 27.1.1'));
  assert.deepEqual(reported, [current]);
  assert.equal(configured, 1);
});

// ------------------------------------------------------------------------------------------- test_installation + extras
describe('file primitives', () => {
  test('concurrent config edit is preserved', async () => {
    const file = path.join(tempdir(), 'config');
    fs.writeFileSync(file, 'concurrent change');
    assert.throws(() => setup.apply_changes([new setup.Change(file, Buffer.from('old config'), Buffer.from('new config'))]), setup.isValueError);
    assert.equal(fs.readFileSync(file, 'utf8'), 'concurrent change');
  });

  test('regular_path refuses traversal, control characters and symlinked components', async () => {
    const root = tempdir();
    assert.throws(() => setup.regular_path(`${root}/a/../b`), (e) => e.message === `Use a path without parent traversal or control characters: ${root}/a/../b`);
    assert.throws(() => setup.regular_path(`${root}/a\nb`), /control characters/);
    fs.symlinkSync(root, path.join(root, 'link'));
    assert.throws(() => setup.regular_path(path.join(root, 'link/x')),
      (e) => e.message === `Refusing a symlink in setup destination: ${path.join(root, 'link')}. Use manual configuration instead.`);
    assert.equal(setup.regular_path(`${root}//x/./y`), `${root}/x/y`);
  });

  test('read_file rejects non-regular files', async () => {
    const root = tempdir();
    assert.equal(setup.read_file(path.join(root, 'missing')), null);
    assert.throws(() => setup.read_file(root), (e) => e.message === `Expected a regular file: ${root}`);
  });

  test('atomic_write keeps an existing mode, creates 0600 files, deletes on null', async () => {
    const root = tempdir();
    const file = path.join(root, 'a/b/file');
    setup.atomic_write(file, Buffer.from('one'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.chmodSync(file, 0o644);
    setup.atomic_write(file, Buffer.from('two'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    assert.equal(fs.readFileSync(file, 'utf8'), 'two');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['file']);
    setup.atomic_write(file, null);
    assert.equal(fs.existsSync(file), false);
  });

  test('apply_changes rolls back earlier writes when a later write fails', async () => {
    const root = tempdir();
    const first = path.join(root, 'first');
    fs.writeFileSync(first, 'before');
    fs.chmodSync(first, 0o640);
    const second = path.join(root, 'second');
    const original = fs.renameSync;
    // A deterministic failure of the second write (independent of privileges), as in the review probe.
    const failing = (editor) => (from, to) => {
      if (to === second) {
        if (editor) fs.writeFileSync(first, 'editor');
        throw Object.assign(new Error('synthetic later failure'), { name: 'OSError' });
      }
      return original(from, to);
    };
    const changes = () => [new setup.Change(first, Buffer.from('before'), Buffer.from('after')), new setup.Change(second, null, Buffer.from('x'))];
    for (const variant of ['sync', 'interruptible']) {
      fs.writeFileSync(first, 'before');
      fs.renameSync = failing(false);
      try {
        if (variant === 'sync') assert.throws(() => setup.apply_changes(changes()), /synthetic later failure/);
        else await assert.rejects(setup.apply_changes_interruptible(changes()), /synthetic later failure/);
      } finally {
        fs.renameSync = original;
      }
      assert.equal(fs.readFileSync(first, 'utf8'), 'before', variant);
      assert.equal(fs.statSync(first).mode & 0o777, 0o640, variant);
      // A concurrent editor's bytes written after the first write are never rolled back.
      fs.renameSync = failing(true);
      try {
        if (variant === 'sync') assert.throws(() => setup.apply_changes(changes()), /synthetic later failure/);
        else await assert.rejects(setup.apply_changes_interruptible(changes()), /synthetic later failure/);
      } finally {
        fs.renameSync = original;
      }
      assert.equal(fs.readFileSync(first, 'utf8'), 'editor', variant);
      assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('.lcu-setup-')), [], variant);
    }
  });

  test('SIGINT during a transaction rolls back and removes temporary files (KeyboardInterrupt)', async () => {
    // The setup process signals ITSELF at the second write (no other process is ever signalled).
    const root = tempdir();
    const script = `
      import fs from 'node:fs';
      const s = await import(${JSON.stringify(new URL('../../lcu/setup.mjs', import.meta.url).href)});
      const first = ${JSON.stringify(path.join(root, 'first'))}, second = ${JSON.stringify(path.join(root, 'second'))};
      fs.writeFileSync(first, 'before');
      const original = fs.renameSync;
      fs.renameSync = (a, b) => { if (b === second) process.kill(process.pid, 'SIGINT'); return original(a, b); };
      try {
        await s.with_interrupt_guard(() => s.apply_changes_interruptible([
          new s.Change(first, Buffer.from('before'), Buffer.from('after')), new s.Change(second, null, Buffer.from('x'))]));
        process.stdout.write('completed\\n');
      } catch (error) {
        process.stdout.write(error.name + '\\n');
      }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.stdout, 'KeyboardInterrupt\n', result.stderr);
    assert.equal(result.status, 0);
    assert.equal(fs.readFileSync(path.join(root, 'first'), 'utf8'), 'before');
    assert.equal(fs.existsSync(path.join(root, 'second')), false);
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('.lcu-setup-')), []);
  });

  test('installer_environment selects the account home and strips Node startup flags', async () => {
    const env = setup.installer_environment('/home/u', ['codex'], { PATH: '/bin', NODE_OPTIONS: '--require x', NODE_PATH: '/x', CODEX_HOME: '/c' });
    assert.deepEqual(env, { PATH: '/bin', CODEX_HOME: '/c', HOME: '/home/u', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', NO_COLOR: '1', CI: '1' });
    assert.throws(() => setup.installer_environment('/h', ['claude-code'], { CLAUDE_CONFIG_DIR: '/x' }),
      (e) => e.message === 'CLAUDE_CONFIG_DIR is not supported by the bundled installers for claude-code; unset it or use --export.');
    assert.deepEqual(Object.keys(setup.installer_environment('/h', ['claude-code'], { CLAUDE_CONFIG_DIR: '' })).sort(),
      ['CI', 'CLAUDE_CONFIG_DIR', 'DISABLE_TELEMETRY', 'DO_NOT_TRACK', 'HOME', 'NO_COLOR']);
  });

  test('installer_paths reports what is missing', async () => {
    const tools = tempdir();
    assert.throws(() => setup.installer_paths(tools), (e) => e.message === `Bundled agent installer missing: ${tools}/node/bin/node. Rerun scripts/install.sh with this --prefix.`);
    put(path.join(tools, 'node/bin/node'), '', 0o644);
    put(path.join(tools, 'node_modules/skills/bin/cli.mjs'), '');
    put(path.join(tools, 'node_modules/add-mcp/dist/index.js'), '');
    if (!IS_ROOT) assert.throws(() => setup.installer_paths(tools), (e) => e.message === `Bundled Node runtime is not executable: ${tools}/node/bin/node`);
    fs.chmodSync(path.join(tools, 'node/bin/node'), 0o755);
    assert.deepEqual(setup.installer_paths(tools), [`${tools}/node/bin/node`, `${tools}/node_modules/skills/bin/cli.mjs`, `${tools}/node_modules/add-mcp/dist/index.js`]);
  });

  test('preflight_mcp reports the child stderr or a fallback', async () => {
    Object.assign(setup.impl, { run: () => ({ returncode: 1, stdout: '', stderr: '  Malformed configuration: /x\n' }) });
    await assert.rejects(setup.preflight_mcp('n', 'm', CLIENTS.codex, 'user', '/', {}), (e) => e.message === 'Malformed configuration: /x');
    Object.assign(setup.impl, { run: () => ({ returncode: 1, stdout: '', stderr: '' }) });
    await assert.rejects(setup.preflight_mcp('n', 'm', CLIENTS.codex, 'user', '/', {}), (e) => e.message === 'MCP configuration preflight failed');
  });

  test('run follows subprocess.run semantics', async () => {
    const r = await setup.run(['/bin/sh', '-c', 'printf "a\\r\\nb"; printf err >&2; exit 3'], { capture_output: true, text: true });
    assert.deepEqual([r.returncode, r.stdout, r.stderr], [3, 'a\nb', 'err']);
    await assert.rejects(setup.run(['/bin/sh', '-c', 'exit 4'], { check: true }), (e) => e.message === "Command '['/bin/sh', '-c', 'exit 4']' returned non-zero exit status 4.");
    await assert.rejects(setup.run(['/nonexistent/lcu']), (e) => setup.isOSError(e) && setup.str_exc(e) === "[Errno 2] No such file or directory: '/nonexistent/lcu'");
    await assert.rejects(setup.run(['/bin/sleep', '5'], { timeout: 0.2 }), (e) => e instanceof setup.TimeoutExpired);
  });

  test('setup_lock creates the private lock file', async () => {
    const home = tempdir();
    const lock = await setup.setup_lock(home);
    lock.release();
    assert.equal(fs.statSync(path.join(home, '.local/state/lcu/setup.lock')).mode & 0o777, 0o600);
  });

  test('clients table and aliases', async () => {
    assert.deepEqual(Object.keys(CLIENTS), ['codex', 'claude-code', 'pi', 'omp', 'hermes']);
    assert.deepEqual(Object.values(CLIENTS).map((c) => [c.label, c.executable, c.detect_path, c.mcp_agent]), [
      ['Codex', 'codex', '.codex', 'codex'], ['Claude Code', 'claude', '.claude.json', 'claude-code'],
      ['Pi', 'pi', '.pi/agent', 'pi'], ['Oh My Pi', 'omp', '.omp', ''], ['Hermes', 'hermes', '.hermes', '']]);
    assert.deepEqual(ALIASES, { claude: 'claude-code', 'oh-my-pi': 'omp', 'hermes-agent': 'hermes' });
    assert.equal(setup.app_prerequisite_message('/x', { alternate_location: true }),
      'LCU requires the official ChatGPT desktop app, which includes Codex, to be installed first. LCU does not download or install the app. '
      + 'No app was found at /x. Install it from https://chatgpt.com/download/ and rerun LCU. If it is installed elsewhere, pass --existing-app PATH.');
  });
});

// ------------------------------------------------------------------------------------------- review regressions
// .port/reviews/port-setup.md findings. Signals: only a process signalling itself (never another pid).
describe('review regressions (port-setup.md)', () => {
  const setupUrl = new URL('../../lcu/setup.mjs', import.meta.url).href;
  const mainScript = (prefix, home, argv, extra = '') => `
    const s = await import(${JSON.stringify(setupUrl)});
    Object.assign(s.impl, { platform: 'linux', installer_environment: () => {}, installer_paths: () => {},
      configure: () => [], report_tested_pair: () => {},
      validate: () => [{ pw_name: 'fixture', pw_uid: process.getuid(), pw_gid: process.getgid(), pw_dir: ${JSON.stringify(home)} }, ['codex']] });
    ${extra}
    try {
      await s.main(${JSON.stringify(['--prefix', prefix, '--session', 'direct', '--yes', '--no-chrome', ...argv])});
    } catch (error) {
      if (error.name !== 'KeyboardInterrupt') throw error;
      process.stderr.write('KeyboardInterrupt\\n');
      process.exitCode = 130;
    }`;
  const runtimeFixture = (doctor) => {
    const root = tempdir();
    const prefix = path.join(root, 'prefix');
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    for (const name of ['lcu', 'lcu-session']) {
      put(path.join(prefix, 'current/bin', name), `#!/bin/sh\ncase "$1" in doctor) ${doctor};; esac\nexit 0\n`, 0o755);
    }
    return { prefix, home };
  };

  test('#6 SIGINT to setup alone during the required doctor cancels it (exit 2, the cancellation message)', () => {
    const { prefix, home } = runtimeFixture('echo DOCTOR_CHILD; sleep 2; echo DOCTOR_DONE');
    const extra = `const run = s.impl.run; s.impl.run = (argv, o) => {
        if (argv.includes('doctor')) setTimeout(() => process.kill(process.pid, 'SIGINT'), 300);
        return run(argv, o); };`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', mainScript(prefix, home, ['--check-desktop'], extra)], { encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stderr, '\nAgent configuration is saved; the required desktop check was cancelled. Rerun lcu doctor to check readiness.\n');
    assert.ok(r.stdout.includes('DOCTOR_CHILD\n'));
    assert.ok(!r.stdout.includes('Desktop readiness check passed'));
    // The doctor shell was killed (0.25 s after the interrupt), so it never reached its last line.
    assert.ok(!r.stdout.includes('DOCTOR_DONE'));
  });

  test('#1 SIGINT between steps raises KeyboardInterrupt, releases the lock and keeps setup state unwritten', () => {
    const { prefix, home } = runtimeFixture('exit 0');
    const extra = `s.impl.configure = () => { process.kill(process.pid, 'SIGINT'); return []; };`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', mainScript(prefix, home, [], extra)], { encoding: 'utf8' });
    assert.equal(r.stderr, 'KeyboardInterrupt\n');
    assert.equal(r.status, 130);
    // KeyboardInterrupt surfaced after registration, before saving choices, as Python would at that point.
    assert.equal(fs.existsSync(path.join(home, '.local/state/lcu/setup.json')), false);
  });

  test('#9 a closed stdout makes setup finish, then report BrokenPipeError and exit 120', async () => {
    const closedReader = (script) => new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.destroy(); // the reader goes away before setup writes anything
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => resolve({ code, stderr }));
    });
    const broken = "Exception ignored in: <_io.TextIOWrapper name='<stdout>' mode='w' encoding='utf-8'>\nBrokenPipeError: [Errno 32] Broken pipe\n";
    let { prefix, home } = runtimeFixture('exit 3');
    let r = await closedReader(mainScript(prefix, home, ['--list-agents']));
    assert.deepEqual([r.code, r.stderr], [120, broken]);
    ({ prefix, home } = runtimeFixture('exit 3'));
    r = await closedReader(mainScript(prefix, home, ['--check-desktop']));
    assert.equal(r.code, 120);
    assert.equal(r.stderr, 'Agent configuration is saved, but desktop readiness was not verified. Review the status above, then rerun lcu doctor.\n' + broken);
    assert.ok(fs.existsSync(path.join(home, '.local/state/lcu/setup.json')), 'setup ran to completion');
  });

  test('#13 SIGINT at a prompt raises KeyboardInterrupt (unwinding), then the process ends by SIGINT; EOF raises EOFError', async () => {
    // The process asks a helper to signal the process itself (its own pid) while it awaits the line in input().
    const script = `
      const s = await import(${JSON.stringify(setupUrl)});
      const { spawn } = await import('node:child_process');
      spawn('/bin/sh', ['-c', 'sleep 0.3; kill -INT ' + process.pid], { stdio: 'ignore' });
      try { await s.with_interrupt_guard(async () => { try { await s.input('Apply this setup? [y/N] '); } finally { process.stdout.write('|unwound'); } }); process.stdout.write('|returned'); }
      catch (e) { process.stdout.write('|' + e.name); }`;
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
      const guard = setTimeout(() => child.kill('SIGKILL'), 10000); // our own child only, if the prompt ever hangs
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('close', (code, signal) => { clearTimeout(guard); child.stdin.destroy(); resolve({ code, signal, out }); });
    });
    assert.deepEqual(result, { code: 0, signal: null, out: 'Apply this setup? [y/N] |unwound|KeyboardInterrupt' });
    const eof = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const s = await import(${JSON.stringify(setupUrl)}); try { await s.input('Q? '); } catch (e) { process.stdout.write('|' + e.name + ':' + e.message); }`],
    { input: '', encoding: 'utf8' });
    assert.equal(eof.stdout, 'Q? |EOFError:');
  });

  test('#7 text decoding is strict unless errors=replace, with universal newlines in every text mode', async () => {
    const r = await setup.run(['/bin/sh', '-c', 'printf "a\\r\\nb\\rc"'], { capture_output: true, text: true, encoding: 'utf-8', errors: 'replace' });
    assert.equal(r.stdout, 'a\nb\nc');
    await assert.rejects(setup.run(['/bin/sh', '-c', 'printf "\\377"'], { capture_output: true, text: true }),
      (e) => setup.isValueError(e) && e.message === "'utf-8' codec can't decode byte 0xff in position 0: invalid start byte");
    const replaced = await setup.run(['/bin/sh', '-c', 'printf "\\377"'], { capture_output: true, text: true, encoding: 'utf-8', errors: 'replace' });
    assert.equal(replaced.stdout, '\ufffd');
    const raw = await setup.run(['/bin/sh', '-c', 'printf "a\\r\\n"'], { capture_output: true });
    assert.deepEqual(raw.stdout, Buffer.from('a\r\n'));
  });

  test('#11 read_text: universal newlines and CPython UnicodeDecodeError text', () => {
    const root = tempdir();
    const file = path.join(root, 'text');
    fs.writeFileSync(file, 'a\r\nb\rc');
    assert.equal(setup.read_text(file), 'a\nb\nc');
    fs.writeFileSync(file, Buffer.from('fffe7b007d00', 'hex'));
    assert.throws(() => setup.read_text(file), (e) => e.name === 'UnicodeDecodeError'
      && e.message === "'utf-8' codec can't decode byte 0xff in position 0: invalid start byte");
  });

  test('#8 the Windows account comparison uses casefold', () => {
    const home = tempdir();
    Object.assign(setup.impl, { platform: 'win32', getuser: () => 'Straße' });
    process.env.USERPROFILE = home;
    const args = setup.parser().parse_args(['--prefix', path.join(home, 'LCU'), '--user', 'STRASSE', '--session', 'direct']);
    const [acct] = setup.validate(args);
    assert.equal(acct.pw_name, 'Straße');
  });

  test('#3/#5 Windows paths keep traversal for validation, accept both UNC forms, and render Python URIs', () => {
    setup.impl.windows_paths = true;
    assert.deepEqual(setup.path_parts('C:\\LCU\\x\\..\\y'), ['C:\\', 'LCU', 'x', '..', 'y']);
    assert.deepEqual(setup.path_parts('C:/LCU/x/../y'), ['C:\\', 'LCU', 'x', '..', 'y']);
    assert.throws(() => setup.regular_path('C:\\LCU\\x\\..\\y'),
      (e) => e.message === 'Use a path without parent traversal or control characters: C:\\LCU\\x\\..\\y');
    assert.equal(setup.is_absolute('//host/share/a/adapter.ts'), true);
    assert.equal(setup.is_absolute('\\\\host\\share\\a'), true);
    assert.equal(setup.is_absolute('C:relative'), false);
    assert.equal(setup.is_absolute('\\rooted'), false);
    assert.equal(setup.path_as_uri('C:\\LCU\\a b\\adapter.ts'), 'file:///C:/LCU/a%20b/adapter.ts');
    assert.equal(setup.path_as_uri('//host/share/a/adapter.ts'), 'file://host/share/a/adapter.ts');
    assert.equal(setup.join_path('C:\\Users\\u', 'AppData/Local/LCU/pi'), 'C:\\Users\\u\\AppData\\Local\\LCU\\pi');
    assert.deepEqual(setup.path_parents('C:\\a\\b'), ['C:\\a', 'C:\\']);
    // The prefix guard sees the traversal too.
    const args = setup.parser().parse_args(['--prefix', 'C:\\LCU\\x\\..\\y']);
    assert.throws(() => setup.validate(args), /Use a dedicated absolute prefix/);
  });

  test('#12 a saved context without a project key is a KeyError, as in Python', async () => {
    const f = new Fixture();
    setup.save_setup_state(f.home, { chrome: false, audio: false, pending: ['pi'],
      pending_context: new Map([['scope', 'user'], ['session', 'direct']]) });
    f.installed = new Set(['pi']);
    await assert.rejects(f.runMain([], { reconcile: true }), (e) => e.name === 'KeyError' && e.message === "'project'");
    assert.deepEqual(f.registered, []);
    assert.deepEqual(f.state().pending, ['pi']);
  });

  test('#4 Windows registrations pin the interpreter generation they embed; rerunning re-pins', () => {
    const prefix = path.join(tempdir(), 'LCU');
    fs.mkdirSync(prefix);
    setup.impl.platform = 'win32';
    const pins = path.join(prefix, 'launcher-pins.json');
    setup.record_launcher_pins(prefix, ['codex', 'pi'], 'user', null, ['C:\\LCU\\apps\\a\\node.exe', 'C:\\LCU\\windows_launcher.mjs']);
    setup.record_launcher_pins(prefix, ['claude-code'], 'project', 'C:\\proj', ['C:\\LCU\\apps\\a\\node.exe', 'd']);
    setup.record_launcher_pins(prefix, ['codex'], 'user', null, ['C:\\LCU\\apps\\b\\node.exe', 'd']);
    assert.equal(fs.readFileSync(pins, 'utf8'), '{\n  "registrations": {\n'
      + '    "codex|user|": "C:\\\\LCU\\\\apps\\\\b\\\\node.exe",\n'
      + '    "pi|user|": "C:\\\\LCU\\\\apps\\\\a\\\\node.exe",\n'
      + '    "claude-code|project|C:\\\\proj": "C:\\\\LCU\\\\apps\\\\a\\\\node.exe"\n  }\n}\n');
    fs.writeFileSync(pins, '{"registrations": []}');
    assert.throws(() => setup.record_launcher_pins(prefix, ['codex'], 'user', null, ['n']), /Malformed LCU launcher pins/);
    setup.impl.platform = 'linux';
    fs.rmSync(pins);
    setup.record_launcher_pins(prefix, ['codex'], 'user', null, ['n']);
    assert.equal(fs.existsSync(pins), false);
  });

  test('#4 main records the pins before registering on Windows', async () => {
    const f = new Fixture();
    put(path.join(f.prefix, 'launcher.json'), JSON.stringify({ node: path.join(f.prefix, 'apps/g1/node.exe'), dispatcher: path.join(f.prefix, 'lcu.cmd') }));
    let pinnedAtRegistration = null;
    let registered = null;
    process.env.SystemRoot = 'C:\\Windows';
    Object.assign(setup.impl, {
      platform: 'win32', validate: () => [f.account, ['codex']], installer_environment: () => {}, installer_paths: () => {},
      run: () => ok(), report_tested_pair: () => {}, release_dir: () => f.prefix, browser_install: () => {},
      configure: (names, home, command) => {
        registered = command;
        pinnedAtRegistration = readJson(path.join(f.prefix, 'launcher-pins.json'));
        return [];
      },
    });
    await capture(() => setup.main(['--prefix', f.prefix, '--session', 'direct', '--yes', '--chrome']));
    assert.deepEqual(registered, ['C:\\Windows\\System32\\cmd.exe', '/d', '/c', path.join(f.prefix, 'lcu.cmd'), '--chrome']);
    assert.deepEqual(pinnedAtRegistration, { registrations: { 'codex|user|': path.join(f.prefix, 'apps/g1/node.exe') } });
  });
});

// ------------------------------------------------------------------------------------------- 0.9.6 #15, setup side
// tests/test_macos_socket_path.py SetupSocketTests: the end-of-setup warning for a macOS home folder too long for
// the Sky helper's socket, through the real platforms.mac_socket_path_problem with the account home faked as
// Python's patch('pwd.getpwuid') does (platforms.internals.getpwuid, U4's seam).
const SOCKET_SUFFIX = '/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock';
const homeOfLength = (size) => `/Users/${'a'.repeat(size - SOCKET_SUFFIX.length - '/Users/'.length)}`;

describe('SetupSocketTests (test_macos_socket_path.py, setup side)', () => {
  const withHome = async (home, fn) => {
    const savedGetpwuid = platforms.internals.getpwuid;
    const savedEnv = process.env[platforms.MAC_SOCKET_ENV];
    platforms.internals.getpwuid = () => ({ pw_dir: home });
    delete process.env[platforms.MAC_SOCKET_ENV];
    try {
      return await fn();
    } finally {
      platforms.internals.getpwuid = savedGetpwuid;
      if (savedEnv !== undefined) process.env[platforms.MAC_SOCKET_ENV] = savedEnv;
    }
  };
  const runDarwin = (f, home) => withHome(home, () => {
    f.platform = 'darwin';
    return f.runMain(['--agent', 'codex'], { agents: ['codex'] });
  });

  test('too long home warns at the end without failing setup', async () => {
    const f = new Fixture();
    const [code, out, err] = await runDarwin(f, homeOfLength(104));
    assert.equal(code, 0, err);
    const warning = out.indexOf('Warning: Computer Use cannot start for this macOS account');
    assert.ok(warning > out.indexOf('Configuration prepared.') && out.indexOf('Configuration prepared.') >= 0, out);
    assert.deepEqual(f.registered[0].names, ['codex']);
  });

  test('export setup warns too', async () => {
    const f = new Fixture();
    f.platform = 'darwin';
    setup.impl.export_bundle = async () => {};
    try {
      const [code, out, err] = await withHome(homeOfLength(104),
        () => f.runMain(['--export', path.join(f.root, 'plugin')], { agents: [] }));
      assert.equal(code, 0, err);
      assert.ok(out.includes('Warning: Computer Use cannot start for this macOS account'), out);
    } finally {
      setup.impl.export_bundle = SAVED_IMPL.export_bundle;
    }
  });

  test('short home prints no warning', async () => {
    const f = new Fixture();
    const [code, out, err] = await runDarwin(f, homeOfLength(103));
    assert.equal(code, 0, err);
    assert.ok(!out.includes('socket path'));
  });

  test('linux setup never warns', async () => {
    const f = new Fixture();
    const [code, out, err] = await withHome(homeOfLength(300), () => f.runMain(['--agent', 'codex'], { agents: ['codex'] }));
    assert.equal(code, 0, err);
    assert.ok(!out.includes('socket path'));
  });
});

// ------------------------------------------------------------------------------------------- round-2 regressions
// .port/reviews/round2-config.md R1, R2, R3, R6. Signals: a process only ever signals itself.
describe('round-2 review regressions (round2-config.md)', () => {
  const setupUrl = new URL('../../lcu/setup.mjs', import.meta.url).href;

  // R1: SIGINT while the OMP/Hermes installer runs must restore the previous package (Python's _package).
  for (const harness of ['omp', 'hermes']) {
    test(`R1 SIGINT during ${harness} registration rolls the previous package back`, () => {
      const root = tempdir();
      const home = path.join(root, 'home');
      const release = path.join(root, 'release');
      const bin = path.join(root, 'bin');
      fs.mkdirSync(home);
      put(path.join(release, 'adapters/pi/index.ts'), 'export default function () {}');
      for (const name of ['plugin.yaml', '__init__.py', 'bridge.mjs']) put(path.join(release, 'adapters/hermes', name), `fixture ${name}`);
      put(path.join(bin, harness), '#!/bin/sh\nexit 0\n', 0o755);
      const script = `
        import fs from 'node:fs';
        import path from 'node:path';
        const s = await import(${JSON.stringify(setupUrl)});
        const home = ${JSON.stringify(home)}, release = ${JSON.stringify(release)}, bin = ${JSON.stringify(bin)};
        const env = { HOME: home, PATH: bin + ':/usr/bin:/bin' };
        Object.assign(s.impl, { installer_paths: () => ['/original/node', '/skills', '/mcp'], installed_app_resources: () => '/r' });
        const configure = () => s.configure([${JSON.stringify(harness)}], home, ['/fixture/lcu'], '/tools', release, { environ: env });
        const first = await configure();
        if (first.length) throw new Error(JSON.stringify(first));
        const folder = ${harness === 'omp'
    ? "path.join(home, '.local/share/lcu/omp', fs.readdirSync(path.join(home, '.local/share/lcu/omp'))[0])"
    : "path.join(home, '.hermes/plugins/lcu-cua')"};
        fs.writeFileSync(path.join(folder, 'old-sentinel'), 'previous package');
        fs.writeFileSync(path.join(bin, ${JSON.stringify(harness)}), '#!/bin/sh\\nsleep 0.8\\nexit 0\\n');
        // The interrupt arrives while the installer runs (this process signals itself).
        const run = s.impl.run;
        s.impl.run = (argv, o) => { setTimeout(() => process.kill(process.pid, 'SIGINT'), 200); return run(argv, o); };
        let error = null;
        try { await s.with_interrupt_guard(configure); } catch (e) { error = e.name; }
        const temps = fs.readdirSync(path.dirname(folder)).filter((n) => n.startsWith('.lcu-plugin-'));
        process.stdout.write('\\nRESULT ' + JSON.stringify({ error, restored: fs.existsSync(path.join(folder, 'old-sentinel')), temps }));`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(/RESULT (\{[^\n]*?\})/.exec(r.stdout)[1]), { error: 'KeyboardInterrupt', restored: true, temps: [] });
    });
  }

  test('R2 the async runner refuses a shebang-less executable (ENOEXEC) and its body never runs, also in the Pi phase', async () => {
    const root = tempdir();
    const sentinel = path.join(root, 'sentinel');
    const file = path.join(root, 'pi');
    put(file, `touch '${sentinel}'\n`, 0o755);
    await assert.rejects(setup.run([file]), (e) => setup.isOSError(e) && setup.str_exc(e) === `[Errno 8] Exec format error: '${file}'`);
    assert.equal(fs.existsSync(sentinel), false);
    // The real Pi phase calls the runner for the discovered `pi` executable.
    const t = new Installed();
    put(path.join(t.release, 'adapters/pi/index.ts'), 'fixture');
    Object.assign(setup.impl, { installer_paths: () => ['n', 's', 'm'], which: () => file, capture_run: () => ok('[]') });
    const { value } = await capture(() => setup.configure(['pi'], t.home, ['/usr/bin/lcu'], path.join(t.root, 'tools'), t.release,
      { environ: { HOME: t.home, PATH: root } }));
    assert.deepEqual(value, [['pi', 'extension', `[Errno 8] Exec format error: '${file}'`]]);
    assert.equal(fs.existsSync(sentinel), false);
  });

  test('R3 a timeout settles when the child has exited even if a descendant keeps its pipes', async () => {
    const root = tempdir();
    const child = path.join(root, 'inherited-pipe.cjs');
    // The descendant ends by itself after 700 ms; nothing is signalled.
    fs.writeFileSync(child, "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},700)'],{stdio:['ignore',1,2]});process.exit(0);");
    const started = performance.now();
    await assert.rejects(setup.run([process.execPath, child], { capture_output: true, timeout: 0.08 }), (e) => e instanceof setup.TimeoutExpired);
    assert.ok(performance.now() - started < 450, `took ${Math.round(performance.now() - started)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 800)); // let the descendant finish on its own
  });

  const lossFixture = () => {
    const f = new Fixture();
    const lock = { path: path.join(f.home, '.local/state/lcu/setup.lock'), held: true, lost: false, release() { this.held = false; } };
    const lose = () => { lock.held = false; lock.lost = true; };
    return { f, lock, lose };
  };
  const lostMessage = (lock) => `Setup failed: The lock on ${lock.path} was lost; stopped before changing anything else.\n`;

  test('R6 setup stops before registering and saving once its lock is lost', async () => {
    const { f, lock, lose } = lossFixture();
    let configured = false;
    Object.assign(setup.impl, {
      platform: 'linux', validate: () => [f.account, ['omp']], installer_environment: () => ({}), installer_paths: () => [],
      run: () => ok(), setup_lock: async () => lock, report_tested_pair: lose,
      configure: async () => { configured = true; return []; },
    });
    const { code, err } = await capture(() => setup.main(['--prefix', f.prefix, '--agent', 'omp', '--yes', '--session', 'direct', '--no-chrome']));
    assert.deepEqual([code, err, configured], [1, lostMessage(lock), false]);
    assert.equal(fs.existsSync(setup.setup_state_path(f.home)), false);
  });

  test('R6 a loss during a slow registration stops the next step (approval, later harnesses, saved state)', async () => {
    const { f, lock, lose } = lossFixture();
    const registered = [];
    const applied = [];
    Object.assign(setup.impl, {
      platform: 'linux', validate: () => [f.account, ['omp', 'hermes']], installer_environment: () => ({}),
      installer_paths: () => ['/n', '/s', '/m'], installed_app_resources: () => '/r', run: () => ok(),
      setup_lock: async () => lock, report_tested_pair: () => {},
      configure_omp: async () => { registered.push('omp'); await new Promise((r) => setTimeout(r, 50)); lose(); },
      configure_hermes: async () => { registered.push('hermes'); },
      approvals: { ...setup.impl.approvals, apply: (mode, name) => { applied.push(name); return 'unchanged'; } },
    });
    const { code, err } = await capture(() => setup.main(['--prefix', f.prefix, '--yes', '--session', 'direct', '--no-chrome', '--approval', 'auto']));
    assert.equal(code, 1);
    assert.ok(err.endsWith(lostMessage(lock)), err);
    assert.deepEqual([registered, applied], [['omp'], []]);
    assert.equal(fs.existsSync(setup.setup_state_path(f.home)), false);
  });

  for (const agent of ['claude-code', 'codex']) {
    test(`R6 residual (${agent}): a loss during the awaited MCP registration stops hooks, settings and mod writes`, async () => {
      const { f, lock, lose } = lossFixture();
      const writes = [];
      for (const adapter of ['claude.mjs', 'codex.mjs', 'audio-files.mjs']) put(path.join(f.prefix, 'current/adapters', adapter), 'fixture');
      Object.assign(setup.impl, {
        platform: 'linux', validate: () => [f.account, [agent]], installer_environment: () => ({}),
        installer_paths: () => ['/n', '/s', '/m'], installed_app_resources: () => '/r', preflight_mcp: async () => {},
        host_policy: () => ({}), remove_old_skill: () => null, setup_lock: async () => lock, report_tested_pair: () => {},
        approvals: { ...setup.impl.approvals, codex_plan: () => null, apply: () => { writes.push('approval'); return 'unchanged'; } },
        locate_codex_tools: () => ({ cli: '/codex' }),
        run: async (argv) => {
          if (argv.includes('--input-type=module')) lose(); // the holder is lost while the registration command runs
          return { returncode: 0, stdout: '{"path":"/config"}', stderr: '' };
        },
        claude_visibility_install: () => { writes.push('visibility'); },
        claude_mod_install: () => { writes.push('mod'); return '/mod'; },
        install_hooks: () => { writes.push('hooks'); },
      });
      const { code, err } = await capture(() => setup.main(['--prefix', f.prefix, '--agent', agent, '--yes', '--session', 'direct', '--no-chrome', '--approval', 'auto']));
      assert.equal(code, 1, err);
      assert.ok(err.endsWith(lostMessage(lock)), err);
      assert.deepEqual(writes, []);
      assert.equal(fs.existsSync(setup.setup_state_path(f.home)), false);
    });
  }

  test('R6 reconcile stops on a lost lock before registering or saving', async () => {
    const f = new Fixture();
    f.writeState({ chrome: false, audio: false, approval: 'ask', pending: ['pi'],
      pending_context: { scope: 'user', project: null, session: 'direct' } });
    const before = fs.readFileSync(setup.setup_state_path(f.home));
    f.installed = new Set(['pi']);
    const lock = { path: '/x/setup.lock', held: true, lost: false, release() {} };
    setup.impl.setup_lock = async () => lock;
    const realRun = () => { lock.held = false; lock.lost = true; return ok(); };
    Object.assign(setup.impl, { platform: 'linux', installer_environment: () => {}, installer_paths: () => {},
      configure: (...a) => f.configure(...a), which: (e) => f.which(e), run: realRun,
      getpwuid: () => f.account, getpwnam: () => f.account });
    const { code, err } = await capture(() => setup.main(['--prefix', f.prefix, '--reconcile', ...(IS_ROOT ? ['--user', 'fixture'] : [])]));
    assert.deepEqual([code, err], [1, 'Reconcile failed: The lock on /x/setup.lock was lost; stopped before changing anything else.\n']);
    assert.deepEqual(f.registered, []);
    assert.deepEqual(fs.readFileSync(setup.setup_state_path(f.home)), before);
  });
});

// ------------------------------------------------------------------------------------------- Python differentials
describe('Python differential (lcu/setup.py still present)', { skip: !havePython && pythonSkip }, () => {
  const pythonSource = havePython ? fs.readFileSync(PYTHON_SOURCE, 'utf8') : '';
  const pyRun = (code, env = {}) => spawnSync('python3', ['-c', code], { cwd: ORACLE_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });

  test('embedded Node sources are byte-identical', async () => {
    const r = pyRun('import sys; from lcu import setup; sys.stdout.write(setup.MCP_PREFLIGHT + "\\0" + setup.MCP_REGISTER)');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${setup.MCP_PREFLIGHT}\0${setup.MCP_REGISTER}`);
  });

  test('CLI text: help, argparse errors and validate() messages', async () => {
    const home = tempdir();
    const project = path.join(home, 'project');
    fs.mkdirSync(project);
    const setupUrl = new URL('../../lcu/setup.mjs', import.meta.url).href;
    const cases = [
      ['--help'], ['--bogus'], ['--scope', 'x'], ['--approval', 'yolo'], ['--user'], ['--no'], ['--list-ag'],
      ['--browser-host'], ['--reconcile', '--agent', 'codex', '--chrome', '--scope', 'project'],
      ['--allow-missing', '--export', '/tmp/x'], ['--chrome', '--no-chrome'], ['--audio', '--no-audio'],
      ['--prefix', '/opt', '--validate-only'], ['--prefix', 'rel/x/y', '--validate-only'], ['--prefix', '/a/../b', '--validate-only'],
      ['--validate-only', '--user', 'no-such-user-lcu'], ['--validate-only', '--scope', 'project'],
      ['--validate-only', '--project', project], ['--validate-only', '--export', 'rel', ],
      ['--validate-only', '--export', '/tmp/new-x', '--agent', 'codex'], ['--validate-only', '--export', '/tmp/new-x', '--approval', 'auto'],
      ['--validate-only', '--export', home], ['--validate-only', '--agent', 'nope', '--agent', 'zz', '--agent', 'nope'],
      ['--validate-only', '--agent', 'all', '--agent', 'codex'], ['--validate-only', '--agent', 'claude', '--agent', 'oh-my-pi', '--scope', 'project', '--project', project],
      ['--validate-only', '--agent', 'all'], ['--validate-only', '--agent', 'codex'],
      ['--validate-only', '--agent', 'claude'], ['--validate-only', '--agent', 'codex', '--scope', 'project', '--project', project],
    ];
    const env = { HOME: home, COLUMNS: '80', CLAUDE_CONFIG_DIR: '' };
    for (const argv of cases) {
      const full = IS_ROOT ? [...argv, '--user', 'root'] : argv;
      const py = pyRun(`import sys; sys.argv[0] = 'lcu'; from lcu import setup; await setup.main(${JSON.stringify(full)})`, env);
      const js = spawnSync(process.execPath, ['--input-type=module', '-e',
        `process.argv[1] = 'lcu'; const s = await import(${JSON.stringify(setupUrl)}); await s.main(${JSON.stringify(full)});`],
      { env: { ...process.env, ...env }, encoding: 'utf8' });
      assert.deepEqual([js.status, js.stdout, js.stderr], [py.status, py.stdout, py.stderr], full.join(' '));
    }
  });

  test('export bytes match Python', async () => {
    const t = new Installed();
    put(path.join(t.resources, 'plugins/openai-bundled/plugins/unified-computer-use/.mcp.json'),
      '{"mcpServers": {"cua_repl": {"type": "stdio", "command": "node", "args": [], "startup_timeout_sec": 120.0, '
      + '"1": "integer-like", "note": "caf\\u00e9 \u00e9", "enabled": true, "tools": {"js": {"output_token_limit": 25000}}}}}');
    const options = [[false, false], [true, true]];
    for (const [chrome, audio] of options) {
      const py = path.join(t.root, `py-${chrome}`);
      const js = path.join(t.root, `js-${chrome}`);
      const r = pyRun(`from unittest.mock import patch
from lcu import setup
with patch('lcu.codex_hooks.export_files', return_value={}):
    await setup.export_bundle(${JSON.stringify(py)}, ['/usr/bin/lcu'], ${JSON.stringify(t.release)}, chrome=${chrome ? 'True' : 'False'}, audio=${audio ? 'True' : 'False'})`);
      assert.equal(r.status, 0, r.stderr);
      setup.impl.export_files = () => ({});
      await setup.export_bundle(js, ['/usr/bin/lcu'], t.release, { chrome, audio });
      const names = fs.readdirSync(py).sort();
      assert.deepEqual(fs.readdirSync(js).sort(), names);
      for (const name of names) assert.equal(fs.readFileSync(path.join(js, name), 'utf8'), fs.readFileSync(path.join(py, name), 'utf8'), name);
    }
    assert.ok(pythonSource.includes('def export_bundle'));
  });
});
